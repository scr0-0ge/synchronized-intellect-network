import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  closeWorkbenchBackendAfterInitialization,
  createWorkbenchLifecycleController,
  createWorkbenchWindowRestorer,
} from "../../src/workbench-shell/electron/lifecycle.ts";

async function flushLifecyclePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("owner close path silently hides to a ready tray without reading turn activity", async () => {
  let activityReads = 0;
  let preventedCalls = 0;
  let hideCalls = 0;
  let disposeCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity() {
      activityReads += 1;
      return "in-flight";
    },
    isTrayReady: () => true,
    hideWindow() {
      hideCalls += 1;
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {},
  });

  lifecycle.handleWindowClose({
    preventDefault() {
      preventedCalls += 1;
    },
  });
  await flushLifecyclePromises();

  assert.equal(preventedCalls, 1);
  assert.equal(activityReads, 0);
  assert.equal(hideCalls, 1);
  assert.equal(disposeCalls, 0);
});

test("owner tray Quit path silently drains active work and exits once", async () => {
  let activityReads = 0;
  let preventedCalls = 0;
  let disposeCalls = 0;
  let closeCalls = 0;
  let exitCalls = 0;
  let releaseBackend!: () => void;
  const backendClosed = new Promise<void>((resolve) => {
    releaseBackend = resolve;
  });
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity() {
      activityReads += 1;
      return "in-flight";
    },
    isTrayReady: () => true,
    hideWindow() {},
    disposeProjectView() {
      disposeCalls += 1;
    },
    closeBackend() {
      closeCalls += 1;
      return backendClosed;
    },
    exit() {
      exitCalls += 1;
    },
  });
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  lifecycle.handleBeforeQuit(event);
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();
  assert.equal(activityReads, 0);
  assert.equal(preventedCalls, 2);
  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(exitCalls, 0);

  releaseBackend();
  await flushLifecyclePromises();
  assert.equal(exitCalls, 1);
});

/**
 * `F117` half 2. When no window can host the quit confirmation, the guard used
 * to report `keep-running` — a decision no human made. Nothing downstream could
 * tell it apart from a real click, and because `handleBeforeQuit` prevents the
 * default unconditionally, every subsequent quit reproduced the same forged
 * refusal: the app became impossible to exit.
 */
test("an unanswerable quit is not a refusal and does not exit", async () => {
  let quitDialogCalls = 0;
  let disposeCalls = 0;
  let exitCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "accepted",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      quitDialogCalls += 1;
      return "unanswerable";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {
      exitCalls += 1;
    },
  });
  let preventedCalls = 0;
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  // `startQuitAttempt` returns early while a prompt is pending and the dialog is
  // asynchronous, so each attempt has to be flushed to be a separate attempt.
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();

  // Unanswerable authorizes nothing: no shutdown, no exit.
  assert.equal(disposeCalls, 0);
  assert.equal(exitCalls, 0);
  assert.equal(preventedCalls, 2);
  // And it does not latch the guard shut: a second request is still attempted,
  // which is exactly what the forged `keep-running` used to prevent.
  assert.equal(quitDialogCalls, 2);
});

test("a quit deferred as unanswerable is asked again once a window exists", async () => {
  const answers: Array<"unanswerable" | "quit"> = ["unanswerable", "quit"];
  const observed: string[] = [];
  let disposeCalls = 0;
  let exitCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "in-flight",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog(activity) {
      observed.push(activity);
      return answers.shift() ?? "keep-running";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {
      exitCalls += 1;
    },
  });
  const event = { preventDefault() {} };

  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();
  assert.equal(disposeCalls, 0);
  assert.equal(exitCalls, 0);

  // A window able to host the question now exists; the held request resumes.
  lifecycle.handleWindowAvailable();
  await flushLifecyclePromises();

  assert.deepEqual(observed, ["in-flight", "in-flight"]);
  assert.equal(disposeCalls, 1);
  assert.equal(exitCalls, 1);
});

test("window availability resumes nothing when no quit was deferred", async () => {
  let quitDialogCalls = 0;
  let disposeCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "accepted",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      quitDialogCalls += 1;
      return "keep-running";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {},
  });
  const event = { preventDefault() {} };

  // A genuine "Keep running" is answered and finished; it must not be replayed.
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();
  lifecycle.handleWindowAvailable();
  await flushLifecyclePromises();
  assert.equal(quitDialogCalls, 1);
  assert.equal(disposeCalls, 0);

  // And with no request outstanding at all, availability is inert.
  lifecycle.handleWindowAvailable();
  await flushLifecyclePromises();
  assert.equal(quitDialogCalls, 1);
});

test("a deferred quit is dropped once shutdown has already started", async () => {
  let quitDialogCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "accepted",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      quitDialogCalls += 1;
      return "unanswerable";
    },
    disposeProjectView() {},
    async closeBackend() {},
    exit() {},
  });
  const event = { preventDefault() {} };

  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();
  assert.equal(quitDialogCalls, 1);

  // The OS is ending the session; the held question is abandoned, not asked.
  lifecycle.handleSessionEnd();
  lifecycle.handleWindowAvailable();
  await flushLifecyclePromises();
  assert.equal(quitDialogCalls, 1);
});

test("idle window close immediately hides to a ready tray without starting shutdown", () => {
  let preventedCalls = 0;
  let hideCalls = 0;
  let disposeCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "idle",
    isTrayReady: () => true,
    hideWindow() {
      hideCalls += 1;
    },
    async showCloseDialog() {
      throw new Error("close dialog must not open for idle activity");
    },
    async showCloseUnavailableDialog() {
      throw new Error("ready tray must not report unavailable");
    },
    async showQuitDialog() {
      throw new Error("quit dialog must not open for a window close");
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {},
  });

  lifecycle.handleWindowClose({
    preventDefault() {
      preventedCalls += 1;
    },
  });

  assert.equal(preventedCalls, 1);
  assert.equal(hideCalls, 1);
  assert.equal(disposeCalls, 0);
});

test("accepted and in-flight window closes use one generation-safe safe-choice dialog", async () => {
  let activity: "accepted" | "in-flight" = "accepted";
  let resolveDialog!: (choice: "keep-open" | "hide-to-tray") => void;
  let dialogPromise = new Promise<"keep-open" | "hide-to-tray">((resolve) => {
    resolveDialog = resolve;
  });
  const observedActivities: string[] = [];
  let hideCalls = 0;
  let unavailableCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => activity,
    isTrayReady: () => true,
    hideWindow() {
      hideCalls += 1;
    },
    showCloseDialog(observedActivity) {
      observedActivities.push(observedActivity);
      return dialogPromise;
    },
    async showCloseUnavailableDialog() {
      unavailableCalls += 1;
      return "keep-open";
    },
    async showQuitDialog() {
      return "keep-running";
    },
    disposeProjectView() {},
    async closeBackend() {},
    exit() {},
  });
  let preventedCalls = 0;
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  lifecycle.handleWindowClose(event);
  lifecycle.handleWindowClose(event);
  assert.equal(preventedCalls, 2);
  assert.deepEqual(observedActivities, ["accepted"]);
  resolveDialog("keep-open");
  await flushLifecyclePromises();
  assert.equal(hideCalls, 0);

  activity = "in-flight";
  dialogPromise = new Promise((resolve) => {
    resolveDialog = resolve;
  });
  lifecycle.handleWindowClose(event);
  resolveDialog("hide-to-tray");
  await flushLifecyclePromises();

  assert.deepEqual(observedActivities, ["accepted", "in-flight"]);
  assert.equal(hideCalls, 1);
  assert.equal(unavailableCalls, 0);
});

test("unknown activity and an unavailable tray always produce a visible explanation", async () => {
  let activity: "idle" | "accepted" | "unknown" = "unknown";
  let trayReady = true;
  const closeDialogs: string[] = [];
  const unavailableDialogs: string[] = [];
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => activity,
    isTrayReady: () => trayReady,
    hideWindow() {},
    async showCloseDialog(observedActivity) {
      closeDialogs.push(observedActivity);
      return "keep-open";
    },
    async showCloseUnavailableDialog(observedActivity) {
      unavailableDialogs.push(observedActivity);
      return "keep-open";
    },
    async showQuitDialog() {
      return "keep-running";
    },
    disposeProjectView() {},
    async closeBackend() {},
    exit() {},
  });
  const event = { preventDefault() {} };

  lifecycle.handleWindowClose(event);
  await flushLifecyclePromises();
  activity = "idle";
  trayReady = false;
  lifecycle.handleWindowClose(event);
  await flushLifecyclePromises();
  activity = "accepted";
  lifecycle.handleWindowClose(event);
  await flushLifecyclePromises();

  assert.deepEqual(closeDialogs, ["unknown"]);
  assert.deepEqual(unavailableDialogs, ["idle", "accepted"]);
});

test("tray-unavailable close exposes one guarded Quit request and re-reads idle before draining", async () => {
  let resolveUnavailable!: (
    choice: "keep-open" | "request-quit",
  ) => void;
  let activityReads = 0;
  let preventedCalls = 0;
  let unavailableCalls = 0;
  let quitDialogCalls = 0;
  let disposeCalls = 0;
  let closeCalls = 0;
  let exitCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity() {
      activityReads += 1;
      return "idle";
    },
    isTrayReady: () => false,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    showCloseUnavailableDialog() {
      unavailableCalls += 1;
      return new Promise((resolve) => {
        resolveUnavailable = resolve;
      });
    },
    async showQuitDialog() {
      quitDialogCalls += 1;
      return "keep-running";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {
      closeCalls += 1;
    },
    exit() {
      exitCalls += 1;
    },
  });
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  lifecycle.handleWindowClose(event);
  lifecycle.handleWindowClose(event);
  assert.equal(activityReads, 1);
  assert.equal(unavailableCalls, 1);
  resolveUnavailable("request-quit");
  await flushLifecyclePromises();

  assert.equal(preventedCalls, 2);
  assert.equal(activityReads, 2);
  assert.equal(quitDialogCalls, 0);
  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(exitCalls, 1);
});

test("tray-unavailable Quit request and queued true Quit converge on one guarded active confirmation", async () => {
  let resolveUnavailable!: (
    choice: "keep-open" | "request-quit",
  ) => void;
  let activityReads = 0;
  let quitDialogCalls = 0;
  let disposeCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity() {
      activityReads += 1;
      return activityReads === 1 ? "accepted" : "in-flight";
    },
    isTrayReady: () => false,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    showCloseUnavailableDialog() {
      return new Promise((resolve) => {
        resolveUnavailable = resolve;
      });
    },
    async showQuitDialog(activity) {
      quitDialogCalls += 1;
      assert.equal(activity, "in-flight");
      return "keep-running";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {},
  });

  lifecycle.handleWindowClose({ preventDefault() {} });
  lifecycle.handleBeforeQuit({ preventDefault() {} });
  lifecycle.handleBeforeQuit({ preventDefault() {} });
  resolveUnavailable("request-quit");
  await flushLifecyclePromises();

  assert.equal(activityReads, 2);
  assert.equal(quitDialogCalls, 1);
  assert.equal(disposeCalls, 0);
});

test("ordinary true Quit defaults active and unknown activity to Keep running", async () => {
  let activity: "accepted" | "unknown" = "accepted";
  const quitDialogs: string[] = [];
  const choices: Array<"keep-running" | "quit"> = ["keep-running", "keep-running"];
  let disposeCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => activity,
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog(observedActivity) {
      quitDialogs.push(observedActivity);
      return choices.shift() ?? "keep-running";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {},
    exit() {},
  });
  let preventedCalls = 0;
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  lifecycle.handleBeforeQuit(event);
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();
  activity = "unknown";
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();

  assert.equal(preventedCalls, 3);
  assert.deepEqual(quitDialogs, ["accepted", "unknown"]);
  assert.equal(disposeCalls, 0);
});

test("true Quit queued behind a close dialog keeps its parent visible and rechecks activity", async () => {
  let resolveCloseDialog!: (choice: "keep-open" | "hide-to-tray") => void;
  let activityReads = 0;
  let hideCalls = 0;
  let quitDialogCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity() {
      activityReads += 1;
      return "in-flight";
    },
    isTrayReady: () => true,
    hideWindow() {
      hideCalls += 1;
    },
    showCloseDialog() {
      return new Promise((resolve) => {
        resolveCloseDialog = resolve;
      });
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      quitDialogCalls += 1;
      return "keep-running";
    },
    disposeProjectView() {},
    async closeBackend() {},
    exit() {},
  });

  lifecycle.handleWindowClose({ preventDefault() {} });
  lifecycle.handleBeforeQuit({ preventDefault() {} });
  resolveCloseDialog("hide-to-tray");
  await flushLifecyclePromises();

  assert.equal(hideCalls, 0);
  assert.equal(activityReads, 2);
  assert.equal(quitDialogCalls, 1);
});

test("confirmed true Quit rechecks activity then runs the existing drain exactly once", async () => {
  let releaseClose!: () => void;
  const closePending = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let activityReads = 0;
  let disposeCalls = 0;
  let closeCalls = 0;
  let exitCalls = 0;
  let preventedCalls = 0;
  let resolveExit!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity() {
      activityReads += 1;
      return activityReads === 1 ? "accepted" : "in-flight";
    },
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      return "quit";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    closeBackend() {
      closeCalls += 1;
      return closePending;
    },
    exit() {
      exitCalls += 1;
      resolveExit();
    },
  });
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  lifecycle.handleBeforeQuit(event);
  lifecycle.handleBeforeQuit(event);
  await flushLifecyclePromises();

  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(preventedCalls, 2);
  assert.equal(exitCalls, 0);
  assert.equal(activityReads, 2);

  releaseClose();
  await exitObserved;
  assert.equal(exitCalls, 1);

  lifecycle.handleBeforeQuit(event);
  assert.equal(preventedCalls, 3);
  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
});

test("idle true Quit drains without a dialog and still exits after a close failure", async () => {
  let exitCalls = 0;
  let resolveExit!: () => void;
  const exitObserved = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "idle",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      throw new Error("idle quit must not open a dialog");
    },
    disposeProjectView() {},
    async closeBackend() {
      throw new Error("PRIVATE_BACKEND_FAILURE");
    },
    exit() {
      exitCalls += 1;
      resolveExit();
    },
  });

  lifecycle.handleBeforeQuit({ preventDefault() {} });
  await exitObserved;

  assert.equal(exitCalls, 1);
});

test("OS session end never prevents the OS and invalidates late close-dialog results", async () => {
  let resolveCloseDialog!: (choice: "keep-open" | "hide-to-tray") => void;
  let preventedCalls = 0;
  let hideCalls = 0;
  let disposeCalls = 0;
  let closeCalls = 0;
  let exitCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "in-flight",
    isTrayReady: () => true,
    hideWindow() {
      hideCalls += 1;
    },
    showCloseDialog() {
      return new Promise((resolve) => {
        resolveCloseDialog = resolve;
      });
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      return "keep-running";
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {
      closeCalls += 1;
    },
    exit() {
      exitCalls += 1;
    },
  });
  const event = {
    preventDefault() {
      preventedCalls += 1;
    },
  };

  lifecycle.handleWindowClose(event);
  lifecycle.handleQuerySessionEnd(event);
  lifecycle.handleSessionEnd(event);
  resolveCloseDialog("hide-to-tray");
  await flushLifecyclePromises();

  assert.equal(preventedCalls, 1);
  assert.equal(hideCalls, 0);
  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(exitCalls, 1);
});

test("OS session end invalidates a late destructive quit confirmation", async () => {
  let resolveQuitDialog!: (choice: "keep-running" | "quit") => void;
  let disposeCalls = 0;
  let closeCalls = 0;
  let exitCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "accepted",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    showQuitDialog() {
      return new Promise((resolve) => {
        resolveQuitDialog = resolve;
      });
    },
    disposeProjectView() {
      disposeCalls += 1;
    },
    async closeBackend() {
      closeCalls += 1;
    },
    exit() {
      exitCalls += 1;
    },
  });

  lifecycle.handleBeforeQuit({ preventDefault() {} });
  lifecycle.handleQuerySessionEnd();
  resolveQuitDialog("quit");
  await flushLifecyclePromises();

  assert.equal(disposeCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(exitCalls, 1);
});

test("authorized shutdown permits window closure while the drain is pending", async () => {
  let releaseClose!: () => void;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "idle",
    isTrayReady: () => true,
    hideWindow() {},
    async showCloseDialog() {
      return "keep-open";
    },
    async showCloseUnavailableDialog() {
      return "keep-open";
    },
    async showQuitDialog() {
      return "keep-running";
    },
    disposeProjectView() {},
    closeBackend() {
      return new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    },
    exit() {},
  });
  let windowClosePrevented = 0;

  lifecycle.handleBeforeQuit({ preventDefault() {} });
  lifecycle.handleWindowClose({
    preventDefault() {
      windowClosePrevented += 1;
    },
  });

  assert.equal(windowClosePrevented, 0);
  await flushLifecyclePromises();
  releaseClose();
  await flushLifecyclePromises();
});

test("window restorer coalesces an early second-instance request and restores one live window", () => {
  const actions: string[] = [];
  let window:
    | {
        isDestroyed(): boolean;
        isMinimized(): boolean;
        restore(): void;
        show(): void;
        focus(): void;
      }
    | null = null;
  const restorer = createWorkbenchWindowRestorer(() => window);

  restorer.requestRestore();
  restorer.requestRestore();
  window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => actions.push("restore"),
    show: () => actions.push("show"),
    focus: () => actions.push("focus"),
  };
  restorer.windowAvailable();
  restorer.windowAvailable();

  assert.deepEqual(actions, ["restore", "show", "focus"]);
});

test("backend close waits for an in-progress backend initialization", async () => {
  let releaseInitialization!: () => void;
  const initialization = new Promise<void>((resolve) => {
    releaseInitialization = resolve;
  });
  let closeCalls = 0;
  let backendReady = false;
  const close = closeWorkbenchBackendAfterInitialization(
    initialization,
    () =>
      backendReady
        ? {
            async close() {
              closeCalls += 1;
            },
          }
        : null,
  );
  await Promise.resolve();
  assert.equal(closeCalls, 0);

  backendReady = true;
  releaseInitialization();
  await close;

  assert.equal(closeCalls, 1);
});

test("backend close still claims and closes an initialized backend when startup rejects", async () => {
  let closeCalls = 0;
  const close = closeWorkbenchBackendAfterInitialization(
    Promise.reject(new Error("PRIVATE_STARTUP_FAILURE")),
    () => ({
      async close() {
        closeCalls += 1;
      },
    }),
  );

  await assert.rejects(close, /PRIVATE_STARTUP_FAILURE/u);
  assert.equal(closeCalls, 1);
});

test("ready callback cannot initialize a backend after shutdown starts", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /app\.whenReady\(\)\.then\(async \(\) => \{\s+if \(shutdownRequested\) return;/u,
  );
});

test("production owns one tray-backed instance and exposes no close or Quit confirmation", async () => {
  const [source, lifecycleSource] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/electron/lifecycle.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const lockIndex = source.indexOf(
    "const ownsSingleInstanceLock = app.requestSingleInstanceLock();",
  );
  const readyIndex = source.indexOf("app.whenReady().then");

  assert.notEqual(lockIndex, -1);
  assert.notEqual(readyIndex, -1);
  assert.ok(lockIndex < readyIndex);
  assert.match(
    source,
    /if \(!ownsSingleInstanceLock\) \{\s+app\.quit\(\);\s+\} else \{\s+startPrimaryWorkbench\(\);\s+\}/u,
  );
  assert.match(
    source,
    /app\.on\("second-instance", \(\) => windowRestorer\.requestRestore\(\)\);/u,
  );
  assert.match(
    source,
    /const lifecycle = createWorkbenchLifecycleController\(\{[\s\S]*?readTurnActivity\(\) \{\s+return backend\?\.readTurnActivity\(\) \?\? "unknown";\s+\}/u,
  );
  assert.match(source, /createdWindow\.on\("close", lifecycle\.handleWindowClose\);/u);
  assert.match(source, /app\.on\("before-quit", lifecycle\.handleBeforeQuit\);/u);
  assert.match(
    source,
    /createdWindow\.on\("query-session-end", lifecycle\.handleQuerySessionEnd\);\s+createdWindow\.on\("session-end", lifecycle\.handleSessionEnd\);/u,
  );
  assert.match(source, /tray = new Tray\(createWorkbenchTrayIcon\(nativeImage\)\);/u);
  assert.match(source, /tray\.on\("click", openWorkbench\);/u);
  assert.match(
    source,
    /label: "Open Synchronized Intellect Network",[\s\S]*?type: "separator"[\s\S]*?label: "Quit",\s+click\(\) \{\s+app\.quit\(\);\s+\}/u,
  );
  assert.doesNotMatch(
    source,
    /label: "Quit",[\s\S]{0,120}?app\.exit/u,
  );
  assert.doesNotMatch(
    source,
    /app\.on\("window-all-closed",[\s\S]{0,120}?app\.quit/u,
  );
  const productionLifecycleSource = source.slice(
    source.indexOf("const lifecycle = createWorkbenchLifecycleController"),
    source.indexOf("if (!ownsSingleInstanceLock)"),
  );
  assert.doesNotMatch(
    productionLifecycleSource,
    /showCloseDialog|showCloseUnavailableDialog|showQuitDialog|showMessageBox/u,
  );
  assert.doesNotMatch(source, /closeDialogOptions|Quit anyway|Hide to tray/u);
  assert.match(
    lifecycleSource,
    /export type WorkbenchCloseUnavailableChoice =\s+\| "keep-open"\s+\| "request-quit";/u,
  );
  // `F117` half 2: the quit guard must never report a decision nobody made.
  assert.match(
    lifecycleSource,
    /export type WorkbenchQuitChoice = "keep-running" \| "quit" \| "unanswerable";/u,
  );
  assert.match(
    lifecycleSource,
    /if \(choice === "unanswerable"\) \{[\s\S]*?quitDeferredForPrompt = true;/u,
  );
  /*
   * `F117` on the close path. This used to assert `if (!isTrayReady()) return;`
   * — the defect itself, written down as a requirement. Production wires none
   * of the three dialogs (asserted above), so with no tray that branch left a
   * prevented close, no tray to reopen from and no menu: a window that will not
   * close. Issue 172. The branch must now take the user somewhere, and the old
   * shape is forbidden rather than merely unasserted.
   */
  assert.match(
    lifecycleSource,
    /if \(guardedCloseDialogs === null\) \{[\s\S]*?if \(!isTrayReady\(\)\) \{\s+startQuitAttempt\(\);\s+return;\s+\}[\s\S]*?options\.hideWindow\(\);/u,
  );
  assert.doesNotMatch(
    lifecycleSource,
    /if \(guardedCloseDialogs === null\) \{[\s\S]*?if \(!isTrayReady\(\)\) return;/u,
  );
  assert.match(
    lifecycleSource,
    /if \(showQuitDialog === undefined\) \{\s+startDrain\(\);\s+return;\s+\}/u,
  );
});

test("production BrowserWindow remains frameless independently of its material ground", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /frame:\s*false,/u);
});

test("production fixes the Workbench application identity before acquiring instance or data state", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );
  const setNameIndex = source.indexOf(
    'app.setName("synchronized-intellect-network");',
  );
  const lockIndex = source.indexOf("app.requestSingleInstanceLock()");
  const userDataIndex = source.indexOf('app.getPath("userData")');

  assert.ok(setNameIndex >= 0, "the canonical identity must be explicit");
  assert.ok(
    setNameIndex < lockIndex && lockIndex < userDataIndex,
    "identity must precede the instance lock and first userData lookup",
  );
  assert.doesNotMatch(
    source,
    /app\.setPath\(\s*["']userData["']/u,
    "explicit --user-data-dir launch isolation must remain authoritative",
  );
});

test("production preserves the designed fallback while a probe never inversely disables acrylic", async () => {
  const [mainSource, rendererSource, nativeMaterialSource] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../src/workbench-shell/renderer/index.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/electron/native-window-material.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const constructionSource = mainSource.slice(
    mainSource.indexOf("const acrylicWindowOptions"),
    mainSource.indexOf("mainWindow = createdWindow;"),
  );
  const successSource = constructionSource.slice(
    constructionSource.indexOf("try {"),
    constructionSource.indexOf("} catch"),
  );
  const fallbackSource = constructionSource.slice(
    constructionSource.indexOf("} catch"),
  );

  assert.match(
    constructionSource,
    /let nativeMaterialState:[^=]+=[^;]+"unavailable"/u,
  );
  assert.match(
    successSource,
    /createdWindow = new BrowserWindow\([\s\S]*await configureWindowsAcrylicWindow\(createdWindow\)[\s\S]*\.state;/u,
  );
  assert.match(
    fallbackSource,
    /createdWindow = new BrowserWindow\([\s\S]*backgroundColor: designedWindowGround[\s\S]*\);/u,
  );
  assert.match(fallbackSource, /nativeMaterialState\s*=\s*"unavailable"/u);
  assert.equal(
    constructionSource.match(/nativeMaterialState\s*=/gu)?.length,
    2,
  );
  assert.match(
    mainSource,
    /import \{[\s\S]*designedWindowGround[\s\S]*\} from "\.\/native-window-material\.ts";/u,
  );
  assert.match(
    nativeMaterialSource,
    /export const designedWindowGround = "#0b0e13" as const;/u,
  );
  assert.match(
    mainSource,
    /supportsAcrylicBackgroundMaterial\(\)[\s\S]*backgroundColor: "#00000000"[\s\S]*backgroundMaterial: "acrylic"[\s\S]*backgroundColor: designedWindowGround/u,
  );
  assert.doesNotMatch(
    successSource,
    /nativeMaterialState\s*=\s*"applied"/u,
  );
  assert.match(nativeMaterialSource, /private const uint SystemBackdropType = 38;/u);
  assert.match(nativeMaterialSource, /private const uint BorderColor = 34;/u);
  // DWMWA_CAPTION_COLOR. Border suppression alone returns S_OK and changes no
  // pixel on a frameless window; the accent band Windows paints when
  // ColorPrevalence is on is the CAPTION. F204 returned because only the border
  // was ever addressed, so both constants are pinned here.
  assert.match(nativeMaterialSource, /private const uint CaptionColor = 35;/u);
  assert.match(nativeMaterialSource, /private const uint ColorNone = 0xFFFFFFFEu;/u);
  assert.match(
    nativeMaterialSource,
    /public static int SuppressCaption\(IntPtr window\)\s*\{\s*uint value = ColorNone;\s*return DwmSetWindowAttribute\(\s*window,\s*CaptionColor,/u,
  );
  assert.match(
    nativeMaterialSource,
    /\$captionResult = \[UnifiedWorkbenchDwm\]::SuppressCaption\(\$window\)/u,
  );
  // The suppression results must not be droppable again: main keeps the whole
  // verification and prints it, so a failure is visible in run-app.log.
  assert.match(
    constructionSource,
    /let nativeMaterialVerification: NativeWindowMaterialVerification \| null =\s+null;/u,
  );
  assert.match(
    successSource,
    /nativeMaterialVerification =\s+await configureWindowsAcrylicWindow\(createdWindow\);/u,
  );
  assert.match(
    mainSource,
    /console\.info\(\s+formatNativeWindowFrameDiagnostic\(nativeMaterialVerification\),\s+\);/u,
  );
  assert.match(
    nativeMaterialSource,
    /if \(observation\.queryHresult !== 0\) \{\s+return nativeMaterialUndetermined\(observation\);\s+\}/u,
  );
  assert.match(
    nativeMaterialSource,
    /if \(observation\.systemBackdropType !== desktopAcrylicBackdropType\) \{\s+return nativeMaterialUndetermined\(observation\);\s+\}/u,
  );
  assert.doesNotMatch(
    nativeMaterialSource,
    /window\.setBackground(?:Color|Material)\(/u,
  );
  assert.match(
    nativeMaterialSource,
    /export type NativeWindowMaterialState =\s+\| "applied"\s+\| "unavailable"\s+\| "undetermined";/u,
  );

  const rendererLoadSource = mainSource.slice(
    mainSource.indexOf("const rendererUrl"),
    mainSource.indexOf("})();"),
  );
  assert.match(
    rendererLoadSource,
    /rendererUrl\.searchParams\.set\("material-state", nativeMaterialState\);/u,
  );
  assert.match(
    rendererLoadSource,
    /const presentWindowsAcrylic\s*=\s*shouldPresentWindowsAcrylic\(nativeMaterialState\);[\s\S]*if \(presentWindowsAcrylic\) \{\s+rendererUrl\.searchParams\.set\("material", "on"\);\s+\}/u,
  );
  assert.match(
    rendererLoadSource,
    /console\.info\(formatNativeWindowMaterialDiagnostic\(nativeMaterialState\)\);/u,
  );
  assert.match(
    rendererLoadSource,
    /if \(url !== rendererHref\) event\.preventDefault\(\);/u,
  );
  assert.match(
    rendererLoadSource,
    /const rendererLoad = createdWindow\s+\.loadURL\(rendererHref\)/u,
  );
  assert.match(rendererLoadSource, /await rendererLoad;/u);
  assert.ok(
    mainSource.indexOf("const rendererLoad = createdWindow") <
      mainSource.indexOf("projectViewIpc = installWorkbenchProjectViewIpc"),
    "the real renderer must begin loading before Project IPC is installed",
  );
  assert.equal(rendererLoadSource.match(/rendererHref/gu)?.length, 3);
  assert.doesNotMatch(rendererLoadSource, /loadFile/u);

  assert.match(
    rendererSource,
    /^import "\.\/styles\.css";\s+import "\.\/themes\/theme-acrylic\.css";\s+import "\.\/themes\/theme-crt\.css";\s+import "\.\/themes\/theme-schemes\.css";/u,
  );
  /* `undetermined` is signalled as its own value, not folded into "on" (`F51`).
     Presenting acrylic is main.ts's decision; whether Windows APPLIED it is what
     the probe reports, and only "applied" may suppress the skin's fallback
     backdrop. Pinned verbatim so the two states cannot quietly collapse back
     into one. */
  assert.match(
    rendererSource,
    /const startupParameters = new URLSearchParams\(window\.location\.search\);\s+if \(startupParameters\.get\("material"\) === "on"\) \{\s+document\.documentElement\.dataset\.material =\s+startupParameters\.get\("material-state"\) === "undetermined"\s+\? "unverified"\s+: "on";\s+\}\s+if \(window\.location\.search\.length > 0\) \{\s+window\.history\.replaceState\(\s+null,\s+"",\s+`\$\{window\.location\.pathname\}\$\{window\.location\.hash\}`,\s+\);\s+\}/u,
  );
  assert.doesNotMatch(rendererSource, /dataset\.materialState|data-material-state/u);
});

test("production Electron wiring resolves packaged startup before composing the Runtime Endpoint Directory", async () => {
  const [source, compositionSource] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/runtime-endpoint-composition.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(
    source,
    /import \{ createProductionRuntimeEndpointAdapter \} from "\.\.\/runtime-endpoint-composition\.ts";/u,
  );
  assert.doesNotMatch(source, /CodexAdapter|ClaudeAdapter/u);
  assert.match(
    compositionSource,
    /import \{\r?\n  ClaudeAdapter,\r?\n  mergeStaticCatalogAugmentation,\r?\n  type ClaudePermissionHandlingOptions,\r?\n  type ClaudeSessionCapabilityStore,\r?\n\} from "\.\.\/agent-runtime\/claude\/adapter\.ts";/u,
  );
  assert.match(
    compositionSource,
    /import \{ CodexAdapter \} from "\.\.\/agent-runtime\/codex-adapter\.ts";/u,
  );
  assert.match(compositionSource, /createRuntimeEndpointDirectory\(/u);
  assert.match(
    source,
    /import \{ initializeWorkbenchProjectHost \} from "\.\/startup\.ts";/u,
  );
  assert.match(source, /createdWindow\.on\("close", lifecycle\.handleWindowClose\);/u);
  assert.match(source, /app\.on\("before-quit", lifecycle\.handleBeforeQuit\);/u);
  assert.match(
    source,
    /import \{ createPackagedBootstrapRuntimeAdapter \} from "\.\/bootstrap-runtime-adapter\.ts";/u,
  );
  assert.match(
    source,
    /async createProjectHost\(startup\) \{\s+const runtimeAdapter = await createProductionRuntimeEndpointAdapter\(\{[\s\S]*?decorateDirectoryAdapter: \(delegate\) =>\s+createPackagedBootstrapRuntimeAdapter\(\{\s+bootstrapProjectDirectory:\s+startup\.fallbackProjectDirectory,\s+delegate,\s+\}\),[\s\S]*?return createWorkbenchProjectHost\(\{\s+\.\.\.startup,\s+adapter: runtimeAdapter,\s+authGeneration,\s+\}\);/u,
  );
  assert.match(
    source,
    /const startupProjectDirectory = readSwitch\("project-directory"\);/u,
  );
  assert.equal(/fallbackProjectDirectory:\s*process\.cwd\(\)/u.test(source), false);
  assert.equal(/readSwitch\("database-path"\)/u.test(source), false);
  assert.equal(/project-view\.sqlite|databasePath/u.test(source), false);
  assert.equal(
    /\.(?:inspect|start|resume)\(/u.test(source),
    false,
  );
  assert.equal(/showOpenDialog|showSaveDialog/u.test(source), false);
  const lifecycleDialogSource = source.slice(
    source.indexOf("const lifecycle = createWorkbenchLifecycleController"),
    source.indexOf("if (!ownsSingleInstanceLock)"),
  );
  const claudePermissionDialogSource = source.slice(
    source.indexOf("const requestClaudeToolPermission"),
    source.indexOf("const windowRestorer"),
  );
  assert.equal(
    (source.match(/dialog\.showMessageBox\(/gu) ?? []).length,
    1,
    "the sole production message box is the Claude tool-permission prompt",
  );
  assert.equal(
    (claudePermissionDialogSource.match(/dialog\.showMessageBox\(/gu) ?? []).length,
    1,
  );
  assert.match(
    claudePermissionDialogSource,
    /buttons: \["Allow once", "Deny"\],\s+defaultId: 1,\s+cancelId: 1,/u,
  );
  assert.equal(
    (lifecycleDialogSource.match(/dialog\.showMessageBox\(/gu) ?? []).length,
    0,
    "the production lifecycle presents no confirmation message boxes",
  );
  assert.doesNotMatch(
    lifecycleDialogSource,
    /showCloseDialog|showCloseUnavailableDialog|showQuitDialog/u,
  );
});

test("production wires the sole owning-window directory-dialog Adapter without invoking it during construction", async () => {
  const [mainSource, chooserSource] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/electron/project-directory-chooser.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(
    mainSource,
    /import \{ createElectronProjectDirectoryChooser \} from "\.\/project-directory-chooser\.ts";/u,
  );
  assert.match(
    mainSource,
    /directoryChooser: createElectronProjectDirectoryChooser\(\),/u,
  );
  assert.equal(/showOpenDialog|showSaveDialog/u.test(mainSource), false);
  assert.match(
    chooserSource,
    /dialog\.showOpenDialog\(window as BrowserWindow, \{[\s\S]*?title: "Open Project",[\s\S]*?buttonLabel: "Open Project",[\s\S]*?properties: \["openDirectory"\],[\s\S]*?\}\)/u,
  );
  assert.equal(/multiSelections|createDirectory|defaultPath/u.test(chooserSource), false);
  assert.equal((chooserSource.match(/dialog\.showOpenDialog/gu) ?? []).length, 1);
});

test("production main owns the durable Create Project controller and owning-window save Adapter", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /import \{\s+createWorkbenchCreateProjectController,[\s\S]*?\} from "\.\.\/create-project-controller\.ts";/u,
  );
  assert.match(
    source,
    /import \{ openWorkbenchCreateProjectStateStore \} from "\.\.\/create-project-store\.ts";/u,
  );
  assert.match(
    source,
    /import \{ createNodeWorkbenchCreateProjectFilesystem \} from "\.\.\/create-project-filesystem\.ts";/u,
  );
  assert.match(
    source,
    /createElectronProjectSaveTargetChooser\(createdWindow\)/u,
  );
  assert.match(
    source,
    /backendInitialization = \(async \(\) => \{[\s\S]*?openWorkbenchCreateProjectStateStore[\s\S]*?createWorkbenchCreateProjectController[\s\S]*?\}\)\(\);\s+await backendInitialization\.catch\(\(\) => undefined\);/u,
  );
  assert.match(
    source,
    /createProjectController: createProjectController/u,
  );
  assert.equal(/showOpenDialog|showSaveDialog/u.test(source), false);
});

test("F72 runtime driver retains only a fail-closed Electron environment", async () => {
  const source = await readFile(
    new URL("../e2e/f72-close-to-tray/support.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const retainedElectronEnvironmentKeys: ReadonlySet<string> = new Set\(\[/u,
  );
  assert.match(
    source,
    /retainedElectronEnvironmentKeys\.has\(normalizedKey\)/u,
  );
  for (const credentialName of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DATABASE_PASSWORD",
    "CLIENT_SECRET",
    "OPENAI_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_ACCESS_TOKEN",
  ]) {
    assert.match(source, new RegExp(`"${credentialName}"`, "u"));
  }
  assert.match(
    source,
    /rejectedCredentialEnvironmentKeyExamples\.every\(isSensitiveEnvironmentKey\)/u,
  );
  assert.match(
    source,
    /\(\?:API_\?KEY\|AUTH_\?TOKEN\|BEARER_\?TOKEN\|ACCESS_\?TOKEN\|TOKEN\|PASSWORD\|PASSWD\|SECRET\|PRIVATE_\?KEY\|ACCESS_\?KEY\|CREDENTIALS\?\|KEY\)/u,
  );
  assert.doesNotMatch(source, /environment\.(?:HOME|CODEX_HOME)\s*=/u);
  assert.match(source, /environment\.USERPROFILE = isolatedHome;/u);
  assert.match(source, /environment\.TEMP = isolatedTempDirectory;/u);
  assert.match(source, /environment\.TMP = isolatedTempDirectory;/u);
});
