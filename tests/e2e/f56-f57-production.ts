import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { ElectronApplication } from "playwright";

import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import {
  oldHistoryMarker,
  ProductionHistoryFixtureAdapter,
} from "./f56-f57-production/fixture.ts";
import { inspectFreshStart } from "./f56-f57-production/fresh-start.ts";
import { inspectNativeCancel } from "./f56-f57-production/native-cancel.ts";
import { inspectProjectActions } from "./f56-f57-production/project-actions.ts";
import { setViewport } from "./f56-f57-production/viewport-layout.ts";
import { productionEnvironment as sharedProductionEnvironment } from "./harness/production-environment.ts";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const { rendererUrl: expectedRendererUrl } = productionElectron;
const temporaryRootPattern = /^workbench-f56-f57-[A-Za-z0-9_-]+$/u;

type ApplicationCleanupOutcome = Readonly<{
  gracefulCloseSucceeded: boolean;
  forcedExactChildTerminationRequested: boolean;
  exactChildDeathProved: true;
}>;

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    join(resolve(tmpdir()), "workbench-f56-f57-"),
  );
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let ownedMainPid: number | undefined;
  let applicationCleanup: ApplicationCleanupOutcome | undefined;
  let isolatedRootRemoved = false;
  let summary: Record<string, unknown> | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;

  try {
    const projectDirectory = join(temporaryRoot, "production-project");
    const userDataDirectory = join(temporaryRoot, "production-user-data");
    await mkdir(projectDirectory);
    await mkdir(userDataDirectory);
    const registryPath = await seedProductionHistory(
      projectDirectory,
      userDataDirectory,
    );

    application = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userDataDirectory),
      cwd: projectDirectory,
      env: productionEnvironment(process.env),
      timeout: 15_000,
    });
    ownedMainProcess = application.process();
    ownedMainPid = ownedMainProcess.pid;
    const page = await firstDomContentLoadedWindow(application, 15_000);
    assert.equal(page.url(), expectedRendererUrl);
    await page.locator(".app").waitFor({ state: "visible", timeout: 10_000 });
    await setViewport(application, 1_280, 820);
    await page.waitForFunction(() => window.innerWidth > 620);

    const f56 = await inspectFreshStart(page);
    await page
      .locator(".rail .rail-action")
      .click();
    await page.locator(".fresh-start-state").waitFor({ state: "visible" });

    const wide = await inspectProjectActions(page, "wide");
    const wideCancel = await inspectNativeCancel(
      application,
      page,
      registryPath,
    );

    await setViewport(application, 560, 760);
    await page.waitForFunction(
      () => {
        const rail = document.querySelector(".rail");
        const stage = document.querySelector(".stage");
        if (!(rail instanceof HTMLElement) || !(stage instanceof HTMLElement)) {
          return false;
        }
        const railRect = rail.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        return (
          window.matchMedia("(max-width: 620px)").matches &&
          getComputedStyle(rail).display === "grid" &&
          Math.abs(railRect.width - 180) < 1 &&
          Math.abs(stageRect.left - railRect.right) < 1 &&
          stageRect.width > 0 &&
          stageRect.right <= window.innerWidth + 1
        );
      },
    );
    const compact = await inspectProjectActions(page, "compact");
    const compactCancel = await inspectNativeCancel(
      application,
      page,
      registryPath,
    );

    await page
      .getByRole("button", {
        name: "Return to selected Session",
        exact: true,
      })
      .click();
    await page.getByText(oldHistoryMarker, { exact: false }).waitFor({
      state: "visible",
    });
    const finalRestore = {
      markerCount: await page.getByText(oldHistoryMarker, { exact: false }).count(),
      selectedCount: await page
        .locator('.session-row[aria-current="true"]')
        .count(),
      transcriptCount: await page.locator(".transcript").count(),
    };
    assert.deepEqual(finalRestore, {
      markerCount: 1,
      selectedCount: 1,
      transcriptCount: 1,
    });

    summary = {
      schema: "f56-f57-production-e2e-v2",
      composition: {
        main: "production-dist",
        preload: "production-contextBridge",
        renderer: "production-dist",
        deterministicSeedAdapter: true,
        liveProviderTurns: 0,
      },
      f56,
      f57: { wide, compact, wideCancel, compactCancel },
      finalRestore,
    };
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      applicationCleanup = await closeOwnedApplication(
        application,
        ownedMainProcess,
        ownedMainPid,
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (
      primaryFailure === undefined &&
      cleanupFailures.length === 0 &&
      applicationCleanup?.exactChildDeathProved === true
    ) {
      try {
        await removeOwnedTemporaryRoot(temporaryRoot);
        isolatedRootRemoved = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    throwCleanupFailures(
      primaryFailure,
      cleanupFailures,
      "F56/F57 production E2E",
    );
  }

  assert.notEqual(summary, undefined);
  if (applicationCleanup === undefined) {
    assert.fail("application-cleanup-outcome-missing");
  }
  const completedSummary = {
    ...summary,
    cleanup: {
      ...applicationCleanup,
      isolatedRootRemoved,
    },
  };
  assert.equal(completedSummary.cleanup.exactChildDeathProved, true);
  assert.equal(completedSummary.cleanup.isolatedRootRemoved, true);
  assert.equal(
    completedSummary.cleanup.gracefulCloseSucceeded &&
      completedSummary.cleanup.forcedExactChildTerminationRequested,
    false,
  );
  const serialized = JSON.stringify(completedSummary);
  const bytes = Buffer.byteLength(serialized, "utf8");
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  console.log(`F56_F57_PRODUCTION_SUMMARY ${serialized}`);
  console.log(`F56_F57_PRODUCTION_SUMMARY_BYTES ${bytes}`);
  console.log(`F56_F57_PRODUCTION_SUMMARY_SHA256 ${sha256}`);
}

async function seedProductionHistory(
  projectDirectory: string,
  userDataDirectory: string,
): Promise<string> {
  const canonicalProject = await realpath(projectDirectory);
  const dataDirectory = join(userDataDirectory, "workbench-project-host");
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  const recordKey = "project-record-v1-00000000-0000-4000-8000-000000000256";
  const ledgerSlot = "project-ledger-v1-00000000-0000-4000-8000-000000000257";
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: recordKey,
      records: [{ recordKey, canonicalDirectory: canonicalProject, ledgerSlot }],
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const channel = await createWorkbenchCoordinator({
    databasePath: join(ledgerDirectory, `${ledgerSlot}.sqlite`),
    adapter: new ProductionHistoryFixtureAdapter(),
  }).openProject(canonicalProject);
  try {
    const profile = {
      model: "fixture-model",
      effortLevel: "fixture-effort",
      executionMode: "single-agent",
      accessMode: "full-access",
    } as const;
    const receipt = await channel.act({
      kind: "direct",
      commandKind: "start",
      idempotencyKey: "f56-production-history",
      runtime: "codex",
      catalogRevision: "f56-production-history-v1",
      preferences: { global: profile },
      profile,
      requestedProfileProjection: {
        kind: "recorded",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        modelLabel: "Fixture model",
        workIntensityControlLabel: {
          label: "Work Intensity",
          provenance: "runtime-catalog",
        },
        workIntensityLabel: "Fixture effort",
        executionModeLabel: "Single agent",
        accessModeLabel: "Full access",
      },
      input: oldHistoryMarker,
    });
    await waitForTerminal(channel, receipt.commandId);
  } finally {
    await channel.close();
  }
  return registryPath;
}

async function waitForTerminal(
  channel: Awaited<
    ReturnType<ReturnType<typeof createWorkbenchCoordinator>["openProject"]>
  >,
  commandId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const command = (await channel.snapshot()).commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status === "completed") return;
    if (
      command?.status === "failed" ||
      command?.status === "recovery-required"
    ) {
      throw new Error("production-history-seed-failed");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("production-history-seed-timeout");
}

async function closeOwnedApplication(
  application: ElectronApplication | undefined,
  ownedMainProcess: ChildProcess | undefined,
  ownedMainPid: number | undefined,
): Promise<ApplicationCleanupOutcome | undefined> {
  if (application === undefined) {
    if (ownedMainProcess !== undefined || ownedMainPid !== undefined) {
      throw new Error("owned-application-process-without-application");
    }
    return undefined;
  }
  const currentMainProcess = application.process();
  if (
    ownedMainProcess === undefined ||
    ownedMainPid === undefined ||
    ownedMainPid <= 0 ||
    currentMainProcess !== ownedMainProcess ||
    currentMainProcess.pid !== ownedMainPid
  ) {
    throw new Error("owned-application-process-mismatch");
  }
  let gracefulCloseSucceeded = false;
  let forcedExactChildTerminationRequested = false;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("application-close-timeout")), 10_000),
      ),
    ]);
    gracefulCloseSucceeded = true;
  } catch {
    // F72's quit guard can keep an active application open. The exact-child
    // fallback below is allowed only after the product-owned close times out.
  }
  let exited = await waitForExactOwnedChildExit(
    ownedMainProcess,
    ownedMainPid,
    1_000,
  );
  if (
    !exited &&
    isExactOwnedChildAlive(ownedMainProcess, ownedMainPid)
  ) {
    forcedExactChildTerminationRequested = true;
    ownedMainProcess.kill();
  }
  exited =
    exited ||
    (await waitForExactOwnedChildExit(
      ownedMainProcess,
      ownedMainPid,
      5_000,
    ));
  if (!exited) {
    throw new Error("exact-owned-application-process-survived-cleanup");
  }
  return Object.freeze({
    gracefulCloseSucceeded:
      gracefulCloseSucceeded && !forcedExactChildTerminationRequested,
    forcedExactChildTerminationRequested,
    exactChildDeathProved: true,
  });
}

function throwCleanupFailures(
  primaryFailure: { readonly error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
  context: string,
): void {
  if (cleanupFailures.length === 0) return;
  throw new AggregateError(
    primaryFailure === undefined
      ? cleanupFailures
      : [primaryFailure.error, ...cleanupFailures],
    `${context} cleanup failed`,
  );
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
}

async function waitForExactOwnedChildExit(
  child: ChildProcess,
  ownedPid: number,
  timeoutMs: number,
): Promise<boolean> {
  if (ownedPid <= 0 || child.pid !== ownedPid) return false;
  const exitObserved =
    child.exitCode !== null ||
    child.signalCode !== null ||
    (await Promise.race([
      waitForChildExit(child).then(() => true),
      new Promise<false>((resolveWait) =>
        setTimeout(() => resolveWait(false), timeoutMs),
      ),
    ]));
  return exitObserved && !(await processAlive(ownedPid));
}

function isExactOwnedChildAlive(
  child: ChildProcess,
  ownedPid: number,
): boolean {
  return (
    ownedPid > 0 &&
    child.pid === ownedPid &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeOwnedTemporaryRoot(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("temporary-root-type-check-failed");
  }
  const resolvedRoot = await realpath(root);
  const resolvedTemporaryDirectory = await realpath(tmpdir());
  if (
    dirname(resolvedRoot) !== resolvedTemporaryDirectory ||
    !temporaryRootPattern.test(basename(resolvedRoot))
  ) {
    throw new Error("temporary-root-ownership-check-failed");
  }
  await rm(resolvedRoot, { recursive: true, force: false });
}

function productionEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  return sharedProductionEnvironment(source);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
