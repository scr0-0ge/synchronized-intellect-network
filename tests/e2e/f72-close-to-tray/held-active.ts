import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ElectronApplication } from "playwright";

import {
  assertDescendantSweepClean,
  captureDescendantTree,
  sweepDescendantSurvivors,
  type DescendantSweepSummary,
  type DescendantTreeCapture,
} from "./descendant-sweep.ts";
import {
  waitForMainWindow,
  type WindowSnapshot,
} from "./window-lifecycle.ts";
import {
  captureChildOutput,
  captureWindow,
  comparablePath,
  electronExecutable,
  expectedRendererUrl,
  firstDomContentLoadedWindow,
  hasExactObjectKeys,
  isolatedApplicationDataDirectories,
  launchProductionElectron,
  nativeErrorCode,
  pathExists,
  processAlive,
  productionElectron,
  productionElectronArguments,
  providerFreeProductionEnvironment,
  removeOwnedTemporaryRoot,
  requiredSafeInteger,
  requiredString,
  stopOwnedApplication,
  stopOwnedChild,
  throwCleanupFailures,
  waitForChildExit,
  waitForExactOwnedChildExit,
  waitForProcessExit,
  waitUntilDead,
  type HeldRuntimeControl,
  type SecondaryExit,
} from "./support.ts";

interface HeldRuntimeManifest {
  readonly schema: "f72-held-codex-runtime-v1";
  readonly pid: number;
  readonly ownerNonce: string;
  readonly executablePath: string;
  readonly projectDirectory: string;
}

interface HeldRuntimeExitAcknowledgement {
  readonly schema: "f72-held-codex-runtime-exit-v1";
  readonly pid: number;
  readonly ownerNonce: string;
  readonly executablePath: string;
  readonly projectDirectory: string;
  readonly reason: "released" | "stdin-closed" | "watchdog";
  readonly exitCode: number;
}

interface DurableCommandObservation {
  readonly commands: readonly Readonly<{
    commandId: string;
    status: string;
    acceptedCursor: number;
  }>[];
  readonly updates: readonly Readonly<{
    cursor: number;
    commandId: string;
    kind: string;
    status: string;
  }>[];
}

interface HeldDialogObservation {
  readonly phaseBefore: string;
  readonly phaseAfter: string;
  readonly parentWindowId: number | null;
  readonly type: unknown;
  readonly title: unknown;
  readonly buttons: readonly string[];
  readonly defaultId: unknown;
  readonly cancelId: unknown;
  readonly noLink: unknown;
  readonly hideAuthorized: boolean;
  readonly destructiveAutoApproval: boolean;
  readonly response: number;
}

async function runHeldActiveScenario(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(resolve(tmpdir()), "workbench-f72-"));
  const projectDirectory = join(temporaryRoot, "project");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const isolatedHome = join(temporaryRoot, "home");
  const isolatedTempDirectory = join(isolatedHome, "temp");
  const runtimeDirectory = join(temporaryRoot, "held-runtime");
  const controlDirectory = join(temporaryRoot, "held-control");
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let ownedMainPid: number | undefined;
  let secondary: ChildProcess | undefined;
  let ownedSecondaryPid: number | undefined;
  let heldRuntimeControl: HeldRuntimeControl | undefined;
  let heldRuntimeManifest: HeldRuntimeManifest | undefined;
  let heldRuntimeReleased = false;
  let heldRuntimeExitAcknowledged = false;
  let heldRuntimeExited = false;
  let primaryExited = false;
  let secondaryExited = true;
  let isolatedRootRemoved = false;
  let summary: Record<string, unknown> | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;

  try {
    await Promise.all([
      mkdir(projectDirectory),
      mkdir(userDataDirectory),
      mkdir(isolatedHome),
      mkdir(isolatedTempDirectory, { recursive: true }),
      // The isolated environment points APPDATA and LOCALAPPDATA here, so the
      // directories have to exist. Without them app.getPath("appData") raises
      // "Failed to get 'appData' path" and this scenario cannot complete.
      ...isolatedApplicationDataDirectories(isolatedHome).map((path) =>
        mkdir(path, { recursive: true }),
      ),
      mkdir(runtimeDirectory),
      mkdir(controlDirectory),
    ]);
    heldRuntimeControl = await prepareHeldCodexRuntime({
      temporaryRoot,
      projectDirectory,
      runtimeDirectory,
      controlDirectory,
    });
    const environment = providerFreeProductionEnvironment(
      process.env,
      isolatedHome,
      isolatedTempDirectory,
      heldRuntimeControl,
    );
    const applicationArguments = productionElectronArguments(
      productionElectron,
      userDataDirectory,
      [`--project-directory=${projectDirectory}`],
    );

    application = await launchProductionElectron(productionElectron, {
      args: applicationArguments,
      cwd: projectDirectory,
      env: environment,
      timeout: 20_000,
    });
    const primaryProcess = application.process();
    const primaryPid = primaryProcess.pid;
    if (primaryPid === undefined) throw new Error("f72-primary-pid-unavailable");
    ownedMainProcess = primaryProcess;
    ownedMainPid = primaryPid;
    const page = await firstDomContentLoadedWindow(application, 20_000);
    await page.locator(".app").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(page.url().startsWith(expectedRendererUrl), true);
    await waitForMainWindow(application, (window) => window.visible);

    const initialWindow = await captureWindow(application);
    assert.deepEqual(
      {
        count: initialWindow.count,
        destroyed: initialWindow.destroyed,
        visible: initialWindow.visible,
      },
      { count: 1, destroyed: false, visible: true },
    );
    const databasePath = await waitForSingleOwnedLedgerPath(userDataDirectory);
    await assertOwnedControlFileTarget(
      heldRuntimeControl.dialogObservationPath,
      heldRuntimeControl,
      "held-dialog-observations.json",
    );
    await installHeldActiveDialogObservation(
      application,
      initialWindow.id,
      heldRuntimeControl.dialogObservationPath,
    );

    const selection = await page.evaluate(async () => {
      const loaded = await window.workbench.loadDirectSessionProfile({
        kind: "catalog-default",
      });
      if (!loaded.ok) throw new Error("f72-held-profile-unavailable");
      const endpoint = loaded.profile.endpoints.find(
        (candidate) => candidate.endpointId === "codex-desktop",
      );
      const model = endpoint?.models[0];
      const workIntensity = model?.workIntensities[0];
      const executionMode = endpoint?.executionModes[0];
      const accessMode = endpoint?.accessModes[0];
      if (
        endpoint === undefined ||
        model === undefined ||
        workIntensity === undefined ||
        executionMode === undefined ||
        accessMode === undefined
      ) {
        throw new Error("f72-held-selection-unavailable");
      }
      return {
        snapshotKey: loaded.profile.snapshotKey,
        endpointKey: endpoint.key,
        modelKey: model.key,
        workIntensityKey: workIntensity.key,
        executionModeKey: executionMode.key,
        accessModeKey: accessMode.key,
      };
    });
    const acceptedResult = await page.evaluate(
      async (request) =>
        window.workbench.submitDirectInput({
          kind: "start",
          input: "Complete after the driver-owned held Runtime is released.",
          ...request,
        }),
      selection,
    );
    assert.deepEqual(acceptedResult, {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    });

    heldRuntimeManifest = await readHeldRuntimeManifest(heldRuntimeControl);
    heldRuntimeExited = false;
    assert.notEqual(heldRuntimeManifest.pid, primaryPid);
    const inFlightObservation = await waitForDurableCommandStatus(
      databasePath,
      "in-flight",
    );
    assert.equal(inFlightObservation.commands.length, 1);
    const commandId = inFlightObservation.commands[0]!.commandId;
    assertDurableLifecycle(inFlightObservation, commandId, [
      "accepted",
      "in-flight",
    ]);

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("f72-window-missing");
      window.close();
    });
    const hiddenWindow = await waitForMainWindow(
      application,
      (window) => !window.visible,
    );
    const activeDialog = await application.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __f72HeldDialogState?: {
          phase: string;
          hideAuthorizationUsed: boolean;
          observations: HeldDialogObservation[];
        };
      };
      const state = target.__f72HeldDialogState;
      if (state === undefined) throw new Error("f72-held-dialog-state-missing");
      return {
        phase: state.phase,
        hideAuthorizationUsed: state.hideAuthorizationUsed,
        dialogCalls: state.observations.length,
        destructiveAutoApprovals: state.observations.filter(
          (observation) => observation.destructiveAutoApproval,
        ).length,
        last: state.observations.at(-1) ?? null,
      };
    });
    const expectedActiveDialogObservation = {
      phaseBefore: "awaiting-active-close",
      phaseAfter: "hide-authorized",
      parentWindowId: initialWindow.id,
      type: "warning",
      title: "Synchronized Intellect Network",
      buttons: ["Keep open", "Hide to tray"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      hideAuthorized: true,
      destructiveAutoApproval: false,
      response: 1,
    };
    assert.deepEqual(activeDialog, {
      phase: "hide-authorized",
      hideAuthorizationUsed: true,
      dialogCalls: 1,
      destructiveAutoApprovals: 0,
      last: expectedActiveDialogObservation,
    });
    assert.deepEqual(
      {
        count: hiddenWindow.count,
        id: hiddenWindow.id,
        webContentsId: hiddenWindow.webContentsId,
        destroyed: hiddenWindow.destroyed,
        visible: hiddenWindow.visible,
      },
      {
        count: 1,
        id: initialWindow.id,
        webContentsId: initialWindow.webContentsId,
        destroyed: false,
        visible: false,
      },
    );

    const restored = await restoreHeldWindowViaSecondInstance(
      application,
      applicationArguments,
      environment,
      projectDirectory,
    );
    secondary = restored.secondary;
    ownedSecondaryPid = restored.secondaryPid;
    secondaryExited = true;
    assert.deepEqual(
      { code: restored.processExit.code, signal: restored.processExit.signal },
      { code: 0, signal: null },
    );
    assert.deepEqual(
      {
        count: restored.window.count,
        id: restored.window.id,
        webContentsId: restored.window.webContentsId,
        destroyed: restored.window.destroyed,
        visible: restored.window.visible,
      },
      {
        count: 1,
        id: initialWindow.id,
        webContentsId: initialWindow.webContentsId,
        destroyed: false,
        visible: true,
      },
    );
    assert.equal(restored.restoreObservation.secondInstanceEvents, 1);
    assert.equal(restored.restoreObservation.showCalls >= 1, true);
    assert.equal(restored.restoreObservation.focusCalls >= 1, true);
    assert.equal(page.isClosed(), false);

    await releaseHeldRuntime(heldRuntimeControl, heldRuntimeManifest);
    heldRuntimeReleased = true;
    const terminalObservation = await waitForDurableCommandStatus(
      databasePath,
      "completed",
    );
    assertDurableLifecycle(terminalObservation, commandId, [
      "accepted",
      "in-flight",
      "completed",
    ]);
    const heldRuntimeExitAcknowledgement =
      await waitForHeldRuntimeExitAcknowledgement(
        heldRuntimeControl,
        heldRuntimeManifest,
        "released",
      );
    heldRuntimeExitAcknowledged = true;
    assert.equal(heldRuntimeExitAcknowledgement.exitCode, 0);
    heldRuntimeExited = await waitUntilDead(heldRuntimeManifest.pid, 10_000);
    assert.equal(heldRuntimeExited, true);

    const preQuitDialogProof = await armHeldActiveTrueQuit(application);
    assert.deepEqual(preQuitDialogProof, {
      phase: "true-quit-armed",
      hideAuthorizationUsed: true,
      dialogCalls: 1,
      destructiveAutoApprovals: 0,
    });
    const descendantCapture = await captureDescendantTree(primaryPid);
    assert.equal(descendantCapture.descendants.length >= 1, true);
    const primaryExit = waitForProcessExit(primaryProcess, 20_000);
    await application.evaluate(({ app }) => app.quit());
    const primaryExitResult = await primaryExit;
    assert.deepEqual(primaryExitResult, { code: 0, signal: null });
    primaryExited = await waitForExactOwnedChildExit(
      primaryProcess,
      primaryPid,
      1_000,
    );
    assert.equal(primaryExited, true);
    const descendantSweep = await sweepDescendantSurvivors(descendantCapture);
    assertDescendantSweepClean(descendantSweep, "held-active");
    const finalDialogProof = await readHeldDialogObservationLog(
      heldRuntimeControl,
    );
    assert.deepEqual(finalDialogProof, {
      schema: "f72-held-dialog-observation-v1",
      expectedWindowId: initialWindow.id,
      phase: "true-quit-armed",
      hideAuthorizationUsed: true,
      dialogCalls: 1,
      destructiveAutoApprovals: 0,
      observations: [expectedActiveDialogObservation],
    });

    summary = {
      schema: "f72-close-to-tray-held-active-e2e-v1",
      composition: {
        main: "production-dist",
        preload: "production-contextBridge",
        renderer: "production-dist",
        runtimeComposition: "production-runtime-endpoint-directory",
        runtime: "driver-owned-held-codex-executable-double",
        liveProviderTurns: 0,
      },
      identityCorrelation: {
        primaryChildCaptured: primaryProcess.pid === primaryPid,
        secondaryChildCaptured:
          restored.secondary.pid === ownedSecondaryPid,
        runtimeReadyExitSameInvocation:
          heldRuntimeExitAcknowledgement.pid === heldRuntimeManifest.pid,
        sameWindow: restored.window.id === initialWindow.id,
        sameWebContents:
          restored.window.webContentsId === initialWindow.webContentsId,
      },
      durableLifecycle: {
        statuses: ["accepted", "in-flight", "completed"],
        sameCommand: true,
      },
      activeClose: {
        dialog: activeDialog.last,
        dialogProof: finalDialogProof,
        hiddenWithoutDestroy: true,
      },
      restore: {
        route: "second-instance",
        sameWindow: true,
        sameWebContents: true,
        observation: restored.restoreObservation,
      },
      heldRuntime: {
        releasedAfterRestore: true,
        exitCorrelation: {
          sameNonce:
            heldRuntimeExitAcknowledgement.ownerNonce ===
            heldRuntimeManifest.ownerNonce,
          sameExecutable:
            comparablePath(heldRuntimeExitAcknowledgement.executablePath) ===
            comparablePath(heldRuntimeManifest.executablePath),
          sameProject:
            comparablePath(
              heldRuntimeExitAcknowledgement.projectDirectory,
            ) === comparablePath(heldRuntimeManifest.projectDirectory),
          samePid:
            heldRuntimeExitAcknowledgement.pid === heldRuntimeManifest.pid,
          released: heldRuntimeExitAcknowledgement.reason === "released",
          exitCodeZero: heldRuntimeExitAcknowledgement.exitCode === 0,
        },
        exitedAfterCompletion: heldRuntimeExited,
      },
      descendantSweep,
      trueQuit: {
        requestedThroughAppQuit: true,
        preQuitDialogProof,
        finalDialogProof,
        processExit: primaryExitResult,
      },
    };
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (
      heldRuntimeControl !== undefined &&
      heldRuntimeManifest !== undefined &&
      !heldRuntimeReleased
    ) {
      try {
        if (!(await pathExists(heldRuntimeControl.releasePath))) {
          await releaseHeldRuntime(heldRuntimeControl, heldRuntimeManifest);
        }
        const release = await readFile(heldRuntimeControl.releasePath, "utf8");
        if (release !== `${heldRuntimeControl.ownerNonce}\n`) {
          throw new Error("f72-held-runtime-release-proof-invalid");
        }
        heldRuntimeReleased = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (secondary !== undefined && !secondaryExited) {
      try {
        await stopOwnedChild(secondary, ownedSecondaryPid);
        secondaryExited = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (application !== undefined && !primaryExited) {
      try {
        await stopOwnedApplication(
          application,
          ownedMainProcess,
          ownedMainPid,
        );
        primaryExited = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (heldRuntimeControl !== undefined && heldRuntimeManifest !== undefined) {
      try {
        if (!heldRuntimeExitAcknowledged) {
          await waitForHeldRuntimeExitAcknowledgement(
            heldRuntimeControl,
            heldRuntimeManifest,
            undefined,
            5_000,
          );
          heldRuntimeExitAcknowledged = true;
        }
        heldRuntimeExited = await waitUntilDead(heldRuntimeManifest.pid, 5_000);
        if (!heldRuntimeExited) {
          throw new Error("f72-held-runtime-death-proof-incomplete");
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (primaryFailure === undefined && cleanupFailures.length === 0) {
      if (
        !heldRuntimeExitAcknowledged ||
        !heldRuntimeExited ||
        !primaryExited ||
        !secondaryExited
      ) {
        cleanupFailures.push(
          new Error("f72-held-cleanup-death-proof-incomplete"),
        );
      } else {
        try {
          await removeOwnedTemporaryRoot(temporaryRoot);
          isolatedRootRemoved = !(await pathExists(temporaryRoot));
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    throwCleanupFailures(
      primaryFailure,
      cleanupFailures,
      "F72 held-active scenario",
    );
  }

  assert.notEqual(summary, undefined);
  assert.deepEqual(
    {
      heldRuntimeExitAcknowledged,
      heldRuntimeExited,
      primaryExited,
      secondaryExited,
      isolatedRootRemoved,
    },
    {
      heldRuntimeExitAcknowledged: true,
      heldRuntimeExited: true,
      primaryExited: true,
      secondaryExited: true,
      isolatedRootRemoved: true,
    },
  );
  const completedSummary = {
    ...summary,
    cleanup: {
      heldRuntimeExitAcknowledged,
      heldRuntimeExited,
      primaryExited,
      secondaryExited,
      isolatedRootRemoved,
    },
  };
  const serialized = JSON.stringify(completedSummary);
  console.log(`F72_HELD_ACTIVE_SUMMARY ${serialized}`);
  console.log(
    `F72_HELD_ACTIVE_SUMMARY_BYTES ${Buffer.byteLength(serialized, "utf8")}`,
  );
  console.log(
    `F72_HELD_ACTIVE_SUMMARY_SHA256 ${createHash("sha256").update(serialized, "utf8").digest("hex")}`,
  );
}

async function prepareHeldCodexRuntime(options: {
  readonly temporaryRoot: string;
  readonly projectDirectory: string;
  readonly runtimeDirectory: string;
  readonly controlDirectory: string;
}): Promise<HeldRuntimeControl> {
  const heldExecutablePath = join(options.runtimeDirectory, "codex.exe");
  const appServerPath = join(options.projectDirectory, "app-server");
  const readyPath = join(options.controlDirectory, "held-runtime-ready.json");
  const releasePath = join(options.controlDirectory, "held-runtime-release.txt");
  const exitPath = join(options.controlDirectory, "held-runtime-exit.json");
  const dialogObservationPath = join(
    options.controlDirectory,
    "held-dialog-observations.json",
  );
  const ownerNonce = randomUUID();
  await copyFile(process.execPath, heldExecutablePath);
  await writeFile(appServerPath, heldCodexRuntimeSource(), {
    encoding: "utf8",
    flag: "wx",
  });
  await Promise.all([
    assertOwnedRegularFile(heldExecutablePath, options.temporaryRoot),
    assertOwnedRegularFile(appServerPath, options.temporaryRoot),
  ]);
  return Object.freeze({
    temporaryRoot: options.temporaryRoot,
    projectDirectory: options.projectDirectory,
    runtimeDirectory: options.runtimeDirectory,
    controlDirectory: options.controlDirectory,
    heldExecutablePath,
    appServerPath,
    readyPath,
    releasePath,
    exitPath,
    dialogObservationPath,
    ownerNonce,
  });
}

function heldCodexRuntimeSource(): string {
  return String.raw`"use strict";
const fileSystem = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const controlDirectory = process.env.UAW_F72_HELD_CONTROL_DIRECTORY;
const ownerNonce = process.env.UAW_F72_HELD_OWNER_NONCE;
if (
  typeof controlDirectory !== "string" ||
  !path.isAbsolute(controlDirectory) ||
  typeof ownerNonce !== "string" ||
  !/^[0-9a-f-]{36}$/u.test(ownerNonce)
) {
  process.exit(91);
}

const readyPath = path.join(controlDirectory, "held-runtime-ready.json");
const releasePath = path.join(controlDirectory, "held-runtime-release.txt");
const exitPath = path.join(controlDirectory, "held-runtime-exit.json");
const SELF_WATCHDOG_MILLISECONDS = 120000;
const threadId = "f72-held-thread";
const turnId = "f72-held-turn";
const itemId = "f72-held-item";
let turnStarted = false;
let heldTurnOwned = false;
let releaseAccepted = false;
let exiting = false;
let releaseTimer;
let watchdogTimer;

function emit(message, afterWrite) {
  process.stdout.write(JSON.stringify(message) + "\n", afterWrite);
}

function respond(message, result) {
  if (!Number.isSafeInteger(message.id)) process.exit(92);
  emit({ jsonrpc: "2.0", id: message.id, result });
}

function publishControlFile(targetPath, contents) {
  const pendingPath = targetPath + ".pending";
  fileSystem.writeFileSync(pendingPath, contents, {
    encoding: "utf8",
    flag: "wx",
  });
  fileSystem.renameSync(pendingPath, targetPath);
}

function finishOwnedRuntime(reason, exitCode) {
  if (exiting) return;
  exiting = true;
  if (releaseTimer !== undefined) clearInterval(releaseTimer);
  if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
  if (!heldTurnOwned) process.exit(exitCode);
  try {
    publishControlFile(
      exitPath,
      JSON.stringify({
        schema: "f72-held-codex-runtime-exit-v1",
        exitCode,
        executablePath: fileSystem.realpathSync(process.execPath),
        ownerNonce,
        pid: process.pid,
        projectDirectory: fileSystem.realpathSync(process.cwd()),
        reason,
      }),
    );
  } catch {
    process.exit(99);
  }
  process.exit(exitCode);
}

watchdogTimer = setTimeout(
  () => finishOwnedRuntime("watchdog", 100),
  SELF_WATCHDOG_MILLISECONDS,
);

function waitForRelease() {
  releaseTimer = setInterval(() => {
    let release;
    try {
      release = fileSystem.readFileSync(releasePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      process.exit(93);
    }
    if (release !== ownerNonce + "\n") process.exit(94);
    clearInterval(releaseTimer);
    releaseAccepted = true;
    emit({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: "agentMessage",
          phase: "final_answer",
          text: "F72 held Runtime completed.",
        },
      },
    });
    emit(
      {
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      },
      () => finishOwnedRuntime("released", 0),
    );
  }, 20);
}

const reader = readline.createInterface({ input: process.stdin });
reader.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(95);
  }
  if (
    typeof message !== "object" ||
    message === null ||
    typeof message.method !== "string"
  ) {
    process.exit(96);
  }
  const method = message.method;
  if (method === "initialize") {
    respond(message, { server: "f72-held-runtime" });
    return;
  }
  if (method === "initialized") return;
  if (method === "account/read") {
    respond(message, {
      account: { type: "chatgpt" },
      requiresOpenaiAuth: true,
    });
    return;
  }
  if (method === "model/list") {
    respond(message, {
      data: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "ultra", description: "Ultra" },
          ],
        },
      ],
      nextCursor: null,
    });
    return;
  }
  if (method === "thread/start") {
    respond(message, {
      thread: { id: threadId },
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    emit({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: threadId } },
    });
    return;
  }
  if (method === "turn/start") {
    if (turnStarted) process.exit(97);
    turnStarted = true;
    respond(message, { turn: { id: turnId, status: "inProgress" } });
    emit({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    emit({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { id: itemId, type: "agentMessage" },
      },
    });
    publishControlFile(
      readyPath,
      JSON.stringify({
        schema: "f72-held-codex-runtime-v1",
        pid: process.pid,
        ownerNonce,
        executablePath: fileSystem.realpathSync(process.execPath),
        projectDirectory: fileSystem.realpathSync(process.cwd()),
      }),
    );
    heldTurnOwned = true;
    waitForRelease();
    return;
  }
  process.exit(98);
});
reader.on("close", () => {
  finishOwnedRuntime(releaseAccepted ? "released" : "stdin-closed", 0);
});
process.stdout.on("error", () => {
  finishOwnedRuntime(releaseAccepted ? "released" : "stdin-closed", 0);
});
`;
}

async function readHeldRuntimeManifest(
  control: HeldRuntimeControl,
  timeoutMilliseconds = 15_000,
): Promise<HeldRuntimeManifest> {
  await assertOwnedControlFileTarget(
    control.readyPath,
    control,
    "held-runtime-ready.json",
  );
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let contents: string;
    try {
      contents = await readFile(control.readyPath, "utf8");
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        continue;
      }
      throw error;
    }
    await assertOwnedRegularFile(control.readyPath, control.temporaryRoot);
    const value = JSON.parse(contents) as unknown;
    if (
      !hasExactObjectKeys(value, [
        "executablePath",
        "ownerNonce",
        "pid",
        "projectDirectory",
        "schema",
      ]) ||
      value.schema !== "f72-held-codex-runtime-v1" ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      value.ownerNonce !== control.ownerNonce ||
      typeof value.executablePath !== "string" ||
      comparablePath(value.executablePath) !==
        comparablePath(control.heldExecutablePath) ||
      typeof value.projectDirectory !== "string" ||
      comparablePath(value.projectDirectory) !==
        comparablePath(control.projectDirectory) ||
      !(await processAlive(value.pid as number))
    ) {
      throw new Error("f72-held-runtime-ownership-invalid");
    }
    return Object.freeze({
      schema: value.schema,
      pid: value.pid as number,
      ownerNonce: value.ownerNonce,
      executablePath: value.executablePath,
      projectDirectory: value.projectDirectory,
    });
  }
  throw new Error("f72-held-runtime-ready-timeout");
}

async function releaseHeldRuntime(
  control: HeldRuntimeControl,
  manifest: HeldRuntimeManifest,
): Promise<void> {
  assertHeldRuntimeOwnership(control, manifest);
  await assertOwnedControlFileTarget(
    control.releasePath,
    control,
    "held-runtime-release.txt",
  );
  const releasePendingPath = join(
    control.controlDirectory,
    "held-runtime-release.pending",
  );
  await writeFile(releasePendingPath, `${control.ownerNonce}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(releasePendingPath, control.releasePath);
}

async function waitForHeldRuntimeExitAcknowledgement(
  control: HeldRuntimeControl,
  manifest: HeldRuntimeManifest,
  expectedReason?: HeldRuntimeExitAcknowledgement["reason"],
  timeoutMilliseconds = 10_000,
): Promise<HeldRuntimeExitAcknowledgement> {
  assertHeldRuntimeOwnership(control, manifest);
  await assertOwnedControlFileTarget(
    control.exitPath,
    control,
    "held-runtime-exit.json",
  );
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let contents: string;
    try {
      contents = await readFile(control.exitPath, "utf8");
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        continue;
      }
      throw error;
    }
    await assertOwnedRegularFile(control.exitPath, control.temporaryRoot);
    const value = JSON.parse(contents) as unknown;
    if (
      !hasExactObjectKeys(value, [
        "exitCode",
        "executablePath",
        "ownerNonce",
        "pid",
        "projectDirectory",
        "reason",
        "schema",
      ]) ||
      value.schema !== "f72-held-codex-runtime-exit-v1" ||
      !Number.isSafeInteger(value.exitCode) ||
      value.ownerNonce !== control.ownerNonce ||
      value.pid !== manifest.pid ||
      typeof value.executablePath !== "string" ||
      comparablePath(value.executablePath) !==
        comparablePath(control.heldExecutablePath) ||
      typeof value.projectDirectory !== "string" ||
      comparablePath(value.projectDirectory) !==
        comparablePath(control.projectDirectory) ||
      (value.reason !== "released" &&
        value.reason !== "stdin-closed" &&
        value.reason !== "watchdog") ||
      (expectedReason !== undefined && value.reason !== expectedReason)
    ) {
      throw new Error("f72-held-runtime-exit-acknowledgement-invalid");
    }
    return Object.freeze({
      schema: value.schema,
      pid: value.pid,
      ownerNonce: value.ownerNonce,
      executablePath: value.executablePath,
      projectDirectory: value.projectDirectory,
      reason: value.reason,
      exitCode: value.exitCode as number,
    });
  }
  throw new Error("f72-held-runtime-exit-acknowledgement-timeout");
}

function assertHeldRuntimeOwnership(
  control: HeldRuntimeControl,
  manifest: HeldRuntimeManifest,
): void {
  if (
    manifest.schema !== "f72-held-codex-runtime-v1" ||
    manifest.ownerNonce !== control.ownerNonce ||
    comparablePath(manifest.executablePath) !==
      comparablePath(control.heldExecutablePath) ||
    comparablePath(manifest.projectDirectory) !==
      comparablePath(control.projectDirectory)
  ) {
    throw new Error("f72-held-runtime-ownership-invalid");
  }
}

async function assertOwnedControlFileTarget(
  targetPath: string,
  control: HeldRuntimeControl,
  expectedBasename: string,
): Promise<void> {
  const [controlInformation, resolvedControl, resolvedRoot] = await Promise.all([
    lstat(control.controlDirectory),
    realpath(control.controlDirectory),
    realpath(control.temporaryRoot),
  ]);
  const controlRelation = relative(resolvedRoot, resolvedControl);
  const resolvedTarget = resolve(targetPath);
  if (
    !controlInformation.isDirectory() ||
    controlInformation.isSymbolicLink() ||
    controlRelation.length === 0 ||
    isAbsolute(controlRelation) ||
    controlRelation === ".." ||
    controlRelation.startsWith("../") ||
    controlRelation.startsWith("..\\") ||
    comparablePath(dirname(resolvedTarget)) !== comparablePath(resolvedControl) ||
    basename(resolvedTarget) !== expectedBasename
  ) {
    throw new Error("f72-held-runtime-control-target-invalid");
  }
}

async function assertOwnedRegularFile(path: string, root: string): Promise<void> {
  const [information, resolvedPath, resolvedRoot] = await Promise.all([
    lstat(path),
    realpath(path),
    realpath(root),
  ]);
  const relation = relative(resolvedRoot, resolvedPath);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    relation.length === 0 ||
    isAbsolute(relation) ||
    relation === ".." ||
    relation.startsWith("../") ||
    relation.startsWith("..\\")
  ) {
    throw new Error("f72-held-runtime-file-ownership-invalid");
  }
}

async function waitForSingleOwnedLedgerPath(
  userDataDirectory: string,
  timeoutMilliseconds = 15_000,
): Promise<string> {
  const ledgerDirectory = join(
    userDataDirectory,
    "workbench-project-host",
    "project-ledgers",
  );
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let entries: Dirent[];
    try {
      entries = await readdir(ledgerDirectory, { withFileTypes: true });
    } catch (error) {
      if (nativeErrorCode(error) === "ENOENT") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        continue;
      }
      throw error;
    }
    const candidates = entries.filter(
      (entry) =>
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        /^project-ledger-v1-[0-9a-f-]{36}\.sqlite$/u.test(entry.name),
    );
    if (candidates.length > 1) throw new Error("f72-ledger-ambiguous");
    const candidate = candidates[0];
    if (candidate !== undefined) {
      const path = join(ledgerDirectory, candidate.name);
      await assertOwnedRegularFile(path, userDataDirectory);
      return path;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("f72-ledger-unavailable");
}

function readDurableCommandObservation(
  databasePath: string,
): DurableCommandObservation {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const commands = database
      .prepare(
        `SELECT command_id, status, accepted_cursor
           FROM commands
          ORDER BY accepted_cursor`,
      )
      .all() as unknown as Array<{
      command_id: unknown;
      status: unknown;
      accepted_cursor: unknown;
    }>;
    const updates = database
      .prepare(
        `SELECT cursor, command_id, kind, status
           FROM updates
          ORDER BY cursor`,
      )
      .all() as unknown as Array<{
      cursor: unknown;
      command_id: unknown;
      kind: unknown;
      status: unknown;
    }>;
    return Object.freeze({
      commands: Object.freeze(
        commands.map((row) =>
          Object.freeze({
            commandId: requiredString(row.command_id, "f72-command-id-invalid"),
            status: requiredString(row.status, "f72-command-status-invalid"),
            acceptedCursor: requiredSafeInteger(
              row.accepted_cursor,
              "f72-accepted-cursor-invalid",
            ),
          }),
        ),
      ),
      updates: Object.freeze(
        updates.map((row) =>
          Object.freeze({
            cursor: requiredSafeInteger(row.cursor, "f72-update-cursor-invalid"),
            commandId: requiredString(row.command_id, "f72-update-command-invalid"),
            kind: requiredString(row.kind, "f72-update-kind-invalid"),
            status: requiredString(row.status, "f72-update-status-invalid"),
          }),
        ),
      ),
    });
  } finally {
    database.close();
  }
}

async function waitForDurableCommandStatus(
  databasePath: string,
  status: "in-flight" | "completed",
  timeoutMilliseconds = 15_000,
): Promise<DurableCommandObservation> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const observation = readDurableCommandObservation(databasePath);
    if (
      observation.commands.length === 1 &&
      observation.commands[0]?.status === status
    ) {
      return observation;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`f72-durable-${status}-timeout`);
}

function assertDurableLifecycle(
  observation: DurableCommandObservation,
  commandId: string,
  expectedStatuses: readonly string[],
): void {
  assert.equal(observation.commands.length, 1);
  const command = observation.commands[0]!;
  assert.equal(command.commandId, commandId);
  const lifecycleKinds = new Set([
    "accepted",
    "in-flight",
    "completed",
    "failed",
    "recovery-required",
  ]);
  const lifecycle = observation.updates.filter((update) =>
    lifecycleKinds.has(update.kind),
  );
  assert.deepEqual(
    lifecycle.map((update) => update.kind),
    expectedStatuses,
  );
  assert.deepEqual(
    lifecycle.map((update) => update.status),
    expectedStatuses,
  );
  assert.equal(
    lifecycle.every((update) => update.commandId === commandId),
    true,
  );
  assert.equal(lifecycle[0]?.cursor, command.acceptedCursor);
}

async function installHeldActiveDialogObservation(
  application: ElectronApplication,
  expectedWindowId: number,
  observationPath: string,
): Promise<void> {
  await application.evaluate(
    ({ app, BrowserWindow, dialog }, options_) => {
      const runtimeProcess = process as typeof process & {
        getBuiltinModule(name: string): unknown;
      };
      const fileSystem = runtimeProcess.getBuiltinModule(
        "node:fs",
      ) as typeof import("node:fs");
      const target = globalThis as typeof globalThis & {
        __f72HeldDialogState?: {
          phase:
            | "awaiting-active-close"
            | "hide-authorized"
            | "true-quit-armed"
            | "unexpected-dialog";
          hideAuthorizationUsed: boolean;
          observations: HeldDialogObservation[];
        };
        __f72WriteHeldDialogState?: () => void;
        __f72SecondInstanceEvents?: number;
        __f72ShowCalls?: number;
        __f72FocusCalls?: number;
      };
      const { expectedWindowId, observationPath } = options_;
      const state: {
        phase:
          | "awaiting-active-close"
          | "hide-authorized"
          | "true-quit-armed"
          | "unexpected-dialog";
        hideAuthorizationUsed: boolean;
        observations: HeldDialogObservation[];
      } = {
        phase: "awaiting-active-close",
        hideAuthorizationUsed: false,
        observations: [],
      };
      const writeHeldDialogState = (flag: "wx" | "w") => {
        fileSystem.writeFileSync(
          observationPath,
          `${JSON.stringify({
            schema: "f72-held-dialog-observation-v1",
            expectedWindowId,
            phase: state.phase,
            hideAuthorizationUsed: state.hideAuthorizationUsed,
            dialogCalls: state.observations.length,
            destructiveAutoApprovals: state.observations.filter(
              (observation) => observation.destructiveAutoApproval,
            ).length,
            observations: state.observations,
          })}\n`,
          { encoding: "utf8", flag },
        );
      };
      target.__f72HeldDialogState = state;
      target.__f72WriteHeldDialogState = () => writeHeldDialogState("w");
      target.__f72SecondInstanceEvents = 0;
      target.__f72ShowCalls = 0;
      target.__f72FocusCalls = 0;
      writeHeldDialogState("wx");
      dialog.showMessageBox = (async (...arguments_: unknown[]) => {
        const parent = arguments_.length === 2 ? arguments_[0] : undefined;
        const options = (arguments_.length === 2
          ? arguments_[1]
          : arguments_[0]) as
          | {
              readonly type?: unknown;
              readonly title?: unknown;
              readonly buttons?: unknown;
              readonly defaultId?: unknown;
              readonly cancelId?: unknown;
              readonly noLink?: unknown;
            }
          | undefined;
        const buttons =
          Array.isArray(options?.buttons) &&
          options.buttons.every((button) => typeof button === "string")
            ? [...options.buttons]
            : [];
        const parentWindowId =
          typeof parent === "object" &&
          parent !== null &&
          "id" in parent &&
          typeof parent.id === "number"
            ? parent.id
            : null;
        const phaseBefore = state.phase;
        const hideAuthorized =
          state.phase === "awaiting-active-close" &&
          !state.hideAuthorizationUsed &&
          state.observations.length === 0 &&
          parentWindowId === expectedWindowId &&
          buttons.length === 2 &&
          buttons[0] === "Keep open" &&
          buttons[1] === "Hide to tray" &&
          options?.type === "warning" &&
          options.title === "Synchronized Intellect Network" &&
          options.defaultId === 0 &&
          options.cancelId === 0 &&
          options.noLink === true;
        const response = hideAuthorized ? 1 : 0;
        state.phase = hideAuthorized ? "hide-authorized" : "unexpected-dialog";
        state.hideAuthorizationUsed ||= hideAuthorized;
        state.observations.push({
          phaseBefore,
          phaseAfter: state.phase,
          parentWindowId,
          type: options?.type,
          title: options?.title,
          buttons,
          defaultId: options?.defaultId,
          cancelId: options?.cancelId,
          noLink: options?.noLink,
          hideAuthorized,
          destructiveAutoApproval:
            response === 1 && buttons.includes("Quit anyway"),
          response,
        });
        writeHeldDialogState("w");
        return { response, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      app.on("second-instance", () => {
        target.__f72SecondInstanceEvents =
          (target.__f72SecondInstanceEvents ?? 0) + 1;
      });
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined || window.id !== expectedWindowId) {
        throw new Error("f72-window-identity-mismatch");
      }
      const originalShow = window.show.bind(window);
      const originalFocus = window.focus.bind(window);
      window.show = (() => {
        target.__f72ShowCalls = (target.__f72ShowCalls ?? 0) + 1;
        originalShow();
      }) as typeof window.show;
      window.focus = (() => {
        target.__f72FocusCalls = (target.__f72FocusCalls ?? 0) + 1;
        originalFocus();
      }) as typeof window.focus;
    },
    { expectedWindowId, observationPath },
  );
}

async function armHeldActiveTrueQuit(
  application: ElectronApplication,
): Promise<{
  readonly phase: "true-quit-armed";
  readonly hideAuthorizationUsed: true;
  readonly dialogCalls: 1;
  readonly destructiveAutoApprovals: 0;
}> {
  return application.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __f72HeldDialogState?: {
        phase: string;
        hideAuthorizationUsed: boolean;
        observations: HeldDialogObservation[];
      };
      __f72WriteHeldDialogState?: () => void;
    };
    const state = target.__f72HeldDialogState;
    if (
      state === undefined ||
      target.__f72WriteHeldDialogState === undefined ||
      state.phase !== "hide-authorized" ||
      !state.hideAuthorizationUsed ||
      state.observations.length !== 1 ||
      state.observations[0]?.hideAuthorized !== true ||
      state.observations[0]?.destructiveAutoApproval !== false
    ) {
      throw new Error("f72-held-dialog-pre-quit-invalid");
    }
    state.phase = "true-quit-armed";
    target.__f72WriteHeldDialogState();
    return {
      phase: "true-quit-armed" as const,
      hideAuthorizationUsed: true as const,
      dialogCalls: 1 as const,
      destructiveAutoApprovals: 0 as const,
    };
  });
}

async function readHeldDialogObservationLog(
  control: HeldRuntimeControl,
): Promise<unknown> {
  await assertOwnedControlFileTarget(
    control.dialogObservationPath,
    control,
    "held-dialog-observations.json",
  );
  await assertOwnedRegularFile(
    control.dialogObservationPath,
    control.temporaryRoot,
  );
  return JSON.parse(await readFile(control.dialogObservationPath, "utf8")) as unknown;
}

async function restoreHeldWindowViaSecondInstance(
  application: ElectronApplication,
  applicationArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
  projectDirectory: string,
): Promise<{
  readonly secondary: ChildProcess;
  readonly secondaryPid: number;
  readonly processExit: SecondaryExit;
  readonly window: WindowSnapshot;
  readonly restoreObservation: {
    readonly secondInstanceEvents: number;
    readonly showCalls: number;
    readonly focusCalls: number;
  };
}> {
  const output = captureChildOutput();
  const secondary = spawn(electronExecutable, [...applicationArguments], {
    cwd: projectDirectory,
    env: { ...environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const secondaryPid = secondary.pid;
  if (secondaryPid === undefined) {
    throw new Error("f72-secondary-pid-unavailable");
  }
  output.attach(secondary);
  try {
    const [processExit, window] = await Promise.all([
      waitForChildExit(secondary, output, 15_000),
      waitForMainWindow(application, (candidate) => candidate.visible, 15_000),
    ]);
    assert.equal(
      await waitForExactOwnedChildExit(secondary, secondaryPid, 1_000),
      true,
    );
    const restoreObservation = await application.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __f72SecondInstanceEvents?: number;
        __f72ShowCalls?: number;
        __f72FocusCalls?: number;
      };
      return {
        secondInstanceEvents: target.__f72SecondInstanceEvents ?? 0,
        showCalls: target.__f72ShowCalls ?? 0,
        focusCalls: target.__f72FocusCalls ?? 0,
      };
    });
    return Object.freeze({
      secondary,
      secondaryPid,
      processExit,
      window,
      restoreObservation,
    });
  } catch (error) {
    try {
      await stopOwnedChild(secondary, secondaryPid);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "F72 secondary restoration cleanup failed",
      );
    }
    throw error;
  }
}


export { runHeldActiveScenario };
