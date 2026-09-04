import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type ElectronApplication,
  type Page,
} from "playwright";

import {
  assertDescendantSweepClean,
  captureDescendantTree,
  sweepDescendantSurvivors,
} from "./descendant-sweep.ts";
import {
  waitForMainWindow,
  type WindowSnapshot,
} from "./window-lifecycle.ts";
import {
  appearanceFileName,
  captureChildOutput,
  captureWindow,
  electronExecutable,
  expectedRendererUrl,
  firstDomContentLoadedWindow,
  isolatedApplicationDataDirectories,
  launchProductionElectron,
  pathExists,
  productionElectron,
  productionElectronArguments,
  providerFreeProductionEnvironment,
  removeOwnedTemporaryRoot,
  repositoryRoot,
  stopOwnedApplication,
  stopOwnedChild,
  throwCleanupFailures,
  waitForChildExit,
  waitForExactOwnedChildExit,
  waitForProcessExit,
} from "./support.ts";

interface MaterialSnapshot {
  readonly dataMaterial: string | null;
  readonly readyState: string;
  readonly appCount: number;
  readonly rendererIdentity: string;
}

type IdleCloseDialogClassification =
  | "activity-guard"
  | "tray-unavailable"
  | "none";

type IdleCloseOutcome =
  | "hidden-success"
  | "safe-keep-open-dialog"
  | "fixed-failure";

type IdleCloseStep =
  | "close-hidden"
  | "close-kept-open-dialog"
  | "close-outcome-unresolved";

interface IdleCloseWindowObservation {
  readonly count: number | null;
  readonly id: number | null;
  readonly webContentsId: number | null;
  readonly destroyed: boolean | null;
  readonly visible: boolean | null;
}

interface IdleCloseDialogObservation {
  readonly callCount: number;
  readonly classification: IdleCloseDialogClassification;
  readonly buttons: readonly string[] | null;
  readonly defaultId: number | null;
  readonly cancelId: number | null;
  readonly response: 0 | null;
}

interface IdleCloseObservation {
  readonly step: IdleCloseStep;
  readonly outcome: IdleCloseOutcome;
  readonly dialog: IdleCloseDialogObservation;
  readonly preWindow: IdleCloseWindowObservation;
  readonly postWindow: IdleCloseWindowObservation;
  readonly sameWindow: boolean;
  readonly sameWebContents: boolean;
}

async function runIdleScenario(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(resolve(tmpdir()), "workbench-f72-"));
  const projectDirectory = join(temporaryRoot, "project");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const isolatedHome = join(temporaryRoot, "home");
  const isolatedTempDirectory = join(isolatedHome, "temp");
  const exitProbePath = join(temporaryRoot, "exit-probe.json");
  const appearancePath = join(userDataDirectory, appearanceFileName);
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let ownedMainPid: number | undefined;
  let secondary: ChildProcess | undefined;
  let ownedSecondaryPid: number | undefined;
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
      ...isolatedApplicationDataDirectories(isolatedHome).map((path) =>
        mkdir(path, { recursive: true }),
      ),
    ]);
    const environment = providerFreeProductionEnvironment(
      process.env,
      isolatedHome,
      isolatedTempDirectory,
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
    const rendererIdentity = await page.evaluate(() => {
      const target = window as typeof window & {
        __f72RendererIdentity?: string;
      };
      target.__f72RendererIdentity = "f72-renderer-identity";
      return target.__f72RendererIdentity;
    });
    const materialBefore = await captureMaterial(page);
    assertMaterialShape(materialBefore);
    assert.equal(materialBefore.rendererIdentity, rendererIdentity);

    const appearanceSave = await page.evaluate(() =>
      window.workbench.saveAppearancePreference({
        tone: "light",
        crt: "blocks",
        phosphor: "amber",
        phosphorTier: "c",
        language: "en",
      }),
    );
    assert.deepEqual(appearanceSave, {
      ok: true,
      status: "saved",
      message: "Appearance preference was durably saved.",
    });

    await installDialogAndRestoreObservation(application);
    const closeObservation = await observeIdleCloseOutcome(
      application,
      initialWindow,
    );
    if (closeObservation.outcome !== "hidden-success") {
      const idleCloseDiagnostic = {
        schema: "f72-idle-close-diagnostic-v1",
        step: closeObservation.step,
        category: "f72-idle-close-outcome-not-hidden",
        observation: closeObservation,
      } as const;
      console.error(
        `F72_IDLE_CLOSE_DIAGNOSTIC ${JSON.stringify(idleCloseDiagnostic)}`,
      );
      throw new Error("f72-idle-close-outcome-not-hidden");
    }
    const hiddenWindow = closeObservation.postWindow;
    assert.deepEqual(
      {
        count: hiddenWindow.count,
        id: hiddenWindow.id,
        webContentsId: hiddenWindow.webContentsId,
        destroyed: hiddenWindow.destroyed,
        visible: hiddenWindow.visible,
        dialogCalls: closeObservation.dialog.callCount,
      },
      {
        count: 1,
        id: initialWindow.id,
        webContentsId: initialWindow.webContentsId,
        destroyed: false,
        visible: false,
        dialogCalls: 0,
      },
    );

    const secondaryOutput = captureChildOutput();
    secondary = spawn(electronExecutable, [...applicationArguments], {
      cwd: projectDirectory,
      env: { ...environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    secondaryExited = false;
    ownedSecondaryPid = secondary.pid;
    if (ownedSecondaryPid === undefined) {
      throw new Error("f72-secondary-pid-unavailable");
    }
    secondaryOutput.attach(secondary);
    const [secondaryResult, restoredWindow] = await Promise.all([
      waitForChildExit(secondary, secondaryOutput, 15_000),
      waitForMainWindow(application, (window) => window.visible, 15_000),
    ]);
    secondaryExited = await waitForExactOwnedChildExit(
      secondary,
      ownedSecondaryPid,
      1_000,
    );
    assert.equal(secondaryExited, true);
    assert.deepEqual(
      { code: secondaryResult.code, signal: secondaryResult.signal },
      { code: 0, signal: null },
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
    assert.deepEqual(
      {
        count: restoredWindow.count,
        id: restoredWindow.id,
        webContentsId: restoredWindow.webContentsId,
        destroyed: restoredWindow.destroyed,
        visible: restoredWindow.visible,
      },
      {
        count: 1,
        id: initialWindow.id,
        webContentsId: initialWindow.webContentsId,
        destroyed: false,
        visible: true,
      },
    );
    assert.equal(restoreObservation.secondInstanceEvents, 1);
    assert.equal(restoreObservation.showCalls >= 1, true);
    assert.equal(restoreObservation.focusCalls >= 1, true);

    const materialAfter = await captureMaterial(page);
    assertMaterialShape(materialAfter);
    assert.deepEqual(
      {
        dataMaterial: materialAfter.dataMaterial,
        rendererIdentity: materialAfter.rendererIdentity,
      },
      {
        dataMaterial: materialBefore.dataMaterial,
        rendererIdentity: materialBefore.rendererIdentity,
      },
    );
    assert.equal(page.isClosed(), false);

    const sourceGate = await inspectSingleInstanceSourceGate();
    assert.deepEqual(sourceGate, {
      lockBeforePrimaryStart: true,
      secondaryQuitsWithoutPrimaryStart: true,
    });

    await installExitProbe(application, exitProbePath);
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
    assertDescendantSweepClean(descendantSweep, "idle");

    const exitProbe = JSON.parse(await readFile(exitProbePath, "utf8")) as {
      readonly appearanceParseable?: boolean;
      readonly appearance?: unknown;
      readonly exitCode?: number;
    };
    assert.deepEqual(exitProbe, {
      appearanceParseable: true,
      appearance: {
        schemaVersion: 3,
        appearance: {
          tone: "light",
          crt: "blocks",
          phosphor: "amber",
          phosphorTier: "c",
          language: "en",
        },
      },
      exitCode: 0,
    });
    const reopenedAppearance = JSON.parse(
      await readFile(appearancePath, "utf8"),
    );
    assert.deepEqual(reopenedAppearance, exitProbe.appearance);

    summary = {
      schema: "f72-close-to-tray-production-e2e-v1",
      composition: {
        main: "production-dist",
        preload: "production-contextBridge",
        renderer: "production-dist",
        liveProviderTurns: 0,
        providerExecutableSearchRoots: "isolated-home-and-system-only-path",
      },
      identity: {
        primaryPid,
        secondaryPid: ownedSecondaryPid,
        temporaryRoot,
        windowId: initialWindow.id,
        webContentsId: initialWindow.webContentsId,
      },
      closeToTray: {
        productTrayReady: true,
        nativeImageAndTrayConstructed: true,
        closeDialogCalls: closeObservation.dialog.callCount,
        hiddenWithoutDestroy: true,
      },
      secondInstance: {
        processExit: secondaryResult,
        sourceGate,
        restoreObservation,
        sameWindow: true,
        sameWebContents: true,
      },
      renderer: {
        stillLoaded: true,
        materialBefore,
        materialAfter,
      },
      descendantSweep,
      trueQuit: {
        requestedThroughAppQuit: true,
        lifecycleReachedExitAfterDrain: true,
        processExit: primaryExitResult,
        appearanceReopenedAndParsed: true,
        exitProbe,
      },
    };
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
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
    if (primaryFailure === undefined && cleanupFailures.length === 0) {
      if (!primaryExited || !secondaryExited) {
        cleanupFailures.push(
          new Error("f72-idle-cleanup-death-proof-incomplete"),
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
    throwCleanupFailures(primaryFailure, cleanupFailures, "F72 idle scenario");
  }

  assert.notEqual(summary, undefined);
  assert.deepEqual(
    { primaryExited, secondaryExited, isolatedRootRemoved },
    { primaryExited: true, secondaryExited: true, isolatedRootRemoved: true },
  );
  const completedSummary = {
    ...summary,
    cleanup: { primaryExited, secondaryExited, isolatedRootRemoved },
  };
  const serialized = JSON.stringify(completedSummary);
  console.log(`F72_PRODUCTION_SUMMARY ${serialized}`);
  console.log(
    `F72_PRODUCTION_SUMMARY_BYTES ${Buffer.byteLength(serialized, "utf8")}`,
  );
  console.log(
    `F72_PRODUCTION_SUMMARY_SHA256 ${createHash("sha256").update(serialized, "utf8").digest("hex")}`,
  );
}

async function observeIdleCloseOutcome(
  application: ElectronApplication,
  initialWindow: WindowSnapshot,
  timeoutMilliseconds = 10_000,
): Promise<IdleCloseObservation> {
  const initialObservation: IdleCloseObservation = {
    step: "close-outcome-unresolved",
    outcome: "fixed-failure",
    dialog: {
      callCount: 0,
      classification: "none",
      buttons: null,
      defaultId: null,
      cancelId: null,
      response: null,
    },
    preWindow: {
      count: initialWindow.count,
      id: initialWindow.id,
      webContentsId: initialWindow.webContentsId,
      destroyed: initialWindow.destroyed,
      visible: initialWindow.visible,
    },
    postWindow: {
      count: null,
      id: null,
      webContentsId: null,
      destroyed: null,
      visible: null,
    },
    sameWindow: false,
    sameWebContents: false,
  };
  let lastObservation = initialObservation;

  try {
    await application.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const window = windows[0];
      if (window !== undefined) window.close();
    });
  } catch {
    return lastObservation;
  }

  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const current = await application.evaluate(({ BrowserWindow }) => {
        const target = globalThis as typeof globalThis & {
          __f72IdleCloseDialogState?: IdleCloseDialogObservation;
        };
        const windows = BrowserWindow.getAllWindows();
        const window = windows[0];
        const state = target.__f72IdleCloseDialogState;
        const classification: IdleCloseDialogClassification =
          state?.classification === "activity-guard" ||
          state?.classification === "tray-unavailable"
            ? state.classification
            : "none";
        const knownButtons =
          classification !== "none" &&
          state?.buttons !== null &&
          state?.buttons !== undefined &&
          state.buttons.length === 2 &&
          state.buttons[0] === "Keep open" &&
          ((classification === "activity-guard" &&
            state.buttons[1] === "Hide to tray") ||
            (classification === "tray-unavailable" &&
              state.buttons[1] === "Quit\u2026"))
            ? [...state.buttons]
            : null;
        const callCount =
          Number.isSafeInteger(state?.callCount) &&
          (state?.callCount ?? -1) >= 0
            ? (state?.callCount ?? 0)
            : 0;
        const dialog: IdleCloseDialogObservation = {
          callCount,
          classification: knownButtons === null ? "none" : classification,
          buttons: knownButtons,
          defaultId:
            knownButtons !== null && state?.defaultId === 0 ? 0 : null,
          cancelId:
            knownButtons !== null && state?.cancelId === 0 ? 0 : null,
          response: callCount > 0 && state?.response === 0 ? 0 : null,
        };
        const postWindow: IdleCloseWindowObservation =
          window === undefined
            ? {
                count: windows.length,
                id: null,
                webContentsId: null,
                destroyed: null,
                visible: null,
              }
            : {
                count: windows.length,
                id: window.id,
                webContentsId: window.webContents.id,
                destroyed: window.isDestroyed(),
                visible: window.isVisible(),
              };
        return { dialog, postWindow };
      });
      const sameWindow = current.postWindow.id === initialObservation.preWindow.id;
      const sameWebContents =
        current.postWindow.webContentsId ===
        initialObservation.preWindow.webContentsId;
      const observed: IdleCloseObservation = {
        step: "close-outcome-unresolved",
        outcome: "fixed-failure",
        dialog: current.dialog,
        preWindow: initialObservation.preWindow,
        postWindow: current.postWindow,
        sameWindow,
        sameWebContents,
      };
      lastObservation = observed;

      if (
        sameWindow &&
        sameWebContents &&
        observed.preWindow.count === 1 &&
        observed.preWindow.destroyed === false &&
        observed.preWindow.visible === true &&
        observed.postWindow.count === 1 &&
        observed.postWindow.destroyed === false &&
        observed.postWindow.visible === false &&
        observed.dialog.callCount === 0 &&
        observed.dialog.classification === "none" &&
        observed.dialog.buttons === null &&
        observed.dialog.defaultId === null &&
        observed.dialog.cancelId === null &&
        observed.dialog.response === null
      ) {
        return {
          ...observed,
          step: "close-hidden",
          outcome: "hidden-success",
        };
      }

      if (
        sameWindow &&
        sameWebContents &&
        observed.preWindow.count === 1 &&
        observed.preWindow.destroyed === false &&
        observed.preWindow.visible === true &&
        observed.postWindow.count === 1 &&
        observed.postWindow.destroyed === false &&
        observed.postWindow.visible === true &&
        observed.dialog.callCount === 1 &&
        observed.dialog.classification !== "none" &&
        observed.dialog.buttons !== null &&
        observed.dialog.defaultId === 0 &&
        observed.dialog.cancelId === 0 &&
        observed.dialog.response === 0
      ) {
        return {
          ...observed,
          step: "close-kept-open-dialog",
          outcome: "safe-keep-open-dialog",
        };
      }

      if (
        observed.postWindow.count !== 1 ||
        observed.postWindow.destroyed === true ||
        !sameWindow ||
        !sameWebContents ||
        observed.dialog.callCount > 1 ||
        (observed.dialog.callCount === 1 &&
          observed.dialog.classification === "none")
      ) {
        return observed;
      }
    } catch {
      return lastObservation;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return lastObservation;
}

async function captureMaterial(page: Page): Promise<MaterialSnapshot> {
  return page.evaluate(() => {
    const target = window as typeof window & {
      __f72RendererIdentity?: string;
    };
    return {
      dataMaterial: document.documentElement.getAttribute("data-material"),
      readyState: document.readyState,
      appCount: document.querySelectorAll(".app").length,
      rendererIdentity: target.__f72RendererIdentity ?? "",
    };
  });
}

function assertMaterialShape(material: MaterialSnapshot): void {
  assert.equal(
    material.dataMaterial === null || material.dataMaterial === "on",
    true,
  );
  assert.equal(material.readyState === "interactive" || material.readyState === "complete", true);
  assert.equal(material.appCount, 1);
}

async function installDialogAndRestoreObservation(
  application: ElectronApplication,
): Promise<void> {
  await application.evaluate(({ app, BrowserWindow, dialog }) => {
    const target = globalThis as typeof globalThis & {
      __f72IdleCloseDialogState?: IdleCloseDialogObservation;
      __f72SecondInstanceEvents?: number;
      __f72ShowCalls?: number;
      __f72FocusCalls?: number;
    };
    target.__f72IdleCloseDialogState = {
      callCount: 0,
      classification: "none",
      buttons: null,
      defaultId: null,
      cancelId: null,
      response: null,
    };
    target.__f72SecondInstanceEvents = 0;
    target.__f72ShowCalls = 0;
    target.__f72FocusCalls = 0;
    dialog.showMessageBox = (async (...arguments_: unknown[]) => {
      const options = (arguments_.length === 2
        ? arguments_[1]
        : arguments_[0]) as
        | {
            readonly buttons?: unknown;
            readonly defaultId?: unknown;
            readonly cancelId?: unknown;
          }
        | undefined;
      const buttons =
        Array.isArray(options?.buttons) &&
        options.buttons.every((button) => typeof button === "string")
          ? [...options.buttons]
          : [];
      const defaultId =
        typeof options?.defaultId === "number" &&
        Number.isSafeInteger(options.defaultId)
          ? options.defaultId
          : null;
      const cancelId =
        typeof options?.cancelId === "number" &&
        Number.isSafeInteger(options.cancelId)
          ? options.cancelId
          : null;
      const activityGuard =
        buttons.length === 2 &&
        buttons[0] === "Keep open" &&
        buttons[1] === "Hide to tray" &&
        defaultId === 0 &&
        cancelId === 0;
      const trayUnavailable =
        buttons.length === 2 &&
        buttons[0] === "Keep open" &&
        buttons[1] === "Quit\u2026" &&
        defaultId === 0 &&
        cancelId === 0;
      const classification: IdleCloseDialogClassification = activityGuard
        ? "activity-guard"
        : trayUnavailable
          ? "tray-unavailable"
          : "none";
      const state = target.__f72IdleCloseDialogState;
      if (state === undefined) {
        throw new Error("f72-idle-dialog-state-missing");
      }
      const response = 0 as const;
      target.__f72IdleCloseDialogState = {
        callCount: state.callCount + 1,
        classification,
        buttons: classification === "none" ? null : buttons,
        defaultId: classification === "none" ? null : defaultId,
        cancelId: classification === "none" ? null : cancelId,
        response,
      };
      return { response, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    app.on("second-instance", () => {
      target.__f72SecondInstanceEvents =
        (target.__f72SecondInstanceEvents ?? 0) + 1;
    });
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("f72-window-missing");
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
  });
}

async function inspectSingleInstanceSourceGate(): Promise<{
  readonly lockBeforePrimaryStart: boolean;
  readonly secondaryQuitsWithoutPrimaryStart: boolean;
}> {
  const source = await readFile(
    join(repositoryRoot, "src", "workbench-shell", "electron", "main.ts"),
    "utf8",
  );
  const lock = source.indexOf(
    "const ownsSingleInstanceLock = app.requestSingleInstanceLock();",
  );
  const primaryCall = source.indexOf("startPrimaryWorkbench();");
  return {
    lockBeforePrimaryStart: lock >= 0 && lock < primaryCall,
    secondaryQuitsWithoutPrimaryStart:
      /if \(!ownsSingleInstanceLock\) \{\s+app\.quit\(\);\s+\} else \{\s+startPrimaryWorkbench\(\);\s+\}/u.test(
        source,
      ),
  };
}

async function installExitProbe(
  application: ElectronApplication,
  exitProbePath: string,
): Promise<void> {
  await application.evaluate(
    ({ app }, options) => {
      const runtimeProcess = process as typeof process & {
        getBuiltinModule(name: string): unknown;
      };
      const fileSystem = runtimeProcess.getBuiltinModule(
        "node:fs",
      ) as typeof import("node:fs");
      const path = runtimeProcess.getBuiltinModule(
        "node:path",
      ) as typeof import("node:path");
      const originalExit = app.exit.bind(app);
      app.exit = ((exitCode = 0) => {
        let observation: Record<string, unknown>;
        try {
          const appearanceContents = fileSystem.readFileSync(
            path.join(app.getPath("userData"), options.appearanceFileName),
            "utf8",
          );
          observation = {
            appearanceParseable: true,
            appearance: JSON.parse(appearanceContents),
            exitCode,
          };
        } catch (error) {
          observation = {
            appearanceParseable: false,
            error: error instanceof Error ? error.message : String(error),
            exitCode,
          };
        }
        fileSystem.writeFileSync(options.probePath, JSON.stringify(observation), {
          encoding: "utf8",
          flag: "wx",
        });
        originalExit(exitCode);
      }) as typeof app.exit;
    },
    { probePath: exitProbePath, appearanceFileName },
  );
}


export { runIdleScenario };

