import type { ProjectTurnActivity } from "../../coordinator/types.ts";

export interface WorkbenchPreventableEvent {
  preventDefault(): void;
}

export interface ClosableWorkbenchBackend {
  close(): Promise<void>;
}

export type WorkbenchCloseChoice = "keep-open" | "hide-to-tray";
export type WorkbenchCloseUnavailableChoice =
  | "keep-open"
  | "request-quit";
/**
 * `unanswerable` is not a third user decision — it is the absence of one.
 *
 * The quit guard exists to make a destructive exit require an explicit human
 * answer. When no surface can host the question, reporting `keep-running`
 * fabricates that answer: nothing downstream can tell it apart from a real
 * click, and because the `before-quit` handler prevents the default
 * unconditionally, every later quit repeats the same forged refusal and the app
 * can never be exited. `unanswerable` authorizes nothing, is distinguishable,
 * and defers the question until a surface exists to ask it on.
 */
export type WorkbenchQuitChoice = "keep-running" | "quit" | "unanswerable";
export type WorkbenchGuardedTurnActivity = Exclude<
  ProjectTurnActivity,
  "idle"
>;

export interface WorkbenchLifecycleController {
  handleWindowClose(event: WorkbenchPreventableEvent): void;
  handleBeforeQuit(event: WorkbenchPreventableEvent): void;
  handleQuerySessionEnd(event?: WorkbenchPreventableEvent): void;
  handleSessionEnd(event?: WorkbenchPreventableEvent): void;
  /**
   * A window able to host a dialog now exists. Only a quit deferred because it
   * was unanswerable is resumed here; nothing else observes this.
   */
  handleWindowAvailable(): void;
}

export interface RestorableWorkbenchWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface WorkbenchWindowRestorer {
  requestRestore(): void;
  windowAvailable(): void;
}

export function createWorkbenchLifecycleController(options: {
  readonly readTurnActivity: () => ProjectTurnActivity;
  readonly isTrayReady: () => boolean;
  readonly hideWindow: () => void;
  readonly showCloseDialog?: (
    activity: WorkbenchGuardedTurnActivity,
  ) => Promise<WorkbenchCloseChoice>;
  readonly showCloseUnavailableDialog?: (
    activity: ProjectTurnActivity,
  ) => Promise<WorkbenchCloseUnavailableChoice>;
  readonly showQuitDialog?: (
    activity: WorkbenchGuardedTurnActivity,
  ) => Promise<WorkbenchQuitChoice>;
  readonly disposeProjectView: () => void;
  readonly closeBackend: () => Promise<void>;
  readonly exit: () => void;
}): WorkbenchLifecycleController {
  const guardedCloseDialogs =
    options.showCloseDialog !== undefined &&
    options.showCloseUnavailableDialog !== undefined
      ? Object.freeze({
          showCloseDialog: options.showCloseDialog,
          showCloseUnavailableDialog: options.showCloseUnavailableDialog,
        })
      : null;
  const showQuitDialog = options.showQuitDialog;
  let interactionGeneration = 0;
  let closePromptPending = false;
  let quitPromptPending = false;
  let quitQueuedAfterClosePrompt = false;
  let quitDeferredForPrompt = false;
  let shutdownStarted = false;
  let systemSessionEnding = false;

  const readTurnActivity = (): ProjectTurnActivity => {
    try {
      return options.readTurnActivity();
    } catch {
      return "unknown";
    }
  };

  const isTrayReady = (): boolean => {
    try {
      return options.isTrayReady();
    } catch {
      return false;
    }
  };

  const startDrain = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    interactionGeneration += 1;
    closePromptPending = false;
    quitPromptPending = false;
    quitQueuedAfterClosePrompt = false;
    quitDeferredForPrompt = false;
    try {
      options.disposeProjectView();
    } catch {
      // Backend closure still owns the durable teardown gate.
    }
    void Promise.resolve()
      .then(() => options.closeBackend())
      .catch(() => undefined)
      .then(() => {
        options.exit();
      });
  };

  const startQuitAttempt = (): void => {
    if (shutdownStarted || systemSessionEnding || quitPromptPending) return;
    if (showQuitDialog === undefined) {
      startDrain();
      return;
    }
    interactionGeneration += 1;
    const activity = readTurnActivity();
    if (activity === "idle") {
      startDrain();
      return;
    }
    quitPromptPending = true;
    const generation = interactionGeneration;
    void (async () => {
      let choice: WorkbenchQuitChoice = "keep-running";
      try {
        choice = await showQuitDialog(activity);
      } catch {
        // A failed confirmation is conservatively equivalent to Keep running.
      }
      if (
        generation !== interactionGeneration ||
        shutdownStarted ||
        systemSessionEnding
      ) {
        return;
      }
      quitPromptPending = false;
      if (choice === "unanswerable") {
        // Nothing could carry the question, so nothing answered it. Hold the
        // request rather than inventing a refusal for it, and ask again the
        // moment a window exists. Exiting here is not an option: the activity
        // that made this guarded is still unresolved.
        quitDeferredForPrompt = true;
        return;
      }
      if (choice !== "quit") return;
      // Re-read at the destructive decision boundary. The explicit confirmation
      // authorizes exit even if the exact guarded state changed in the meantime.
      readTurnActivity();
      startDrain();
    })();
  };

  const startClosePrompt = (
    activity: ProjectTurnActivity,
    trayReady: boolean,
  ): void => {
    if (guardedCloseDialogs === null) return;
    closePromptPending = true;
    interactionGeneration += 1;
    const generation = interactionGeneration;
    void (async () => {
      const showUnavailable = async (): Promise<boolean> => {
        let choice: WorkbenchCloseUnavailableChoice = "keep-open";
        try {
          choice = await guardedCloseDialogs.showCloseUnavailableDialog(activity);
        } catch {
          // A failed explanation is conservatively equivalent to Keep open.
        }
        return choice === "request-quit";
      };
      let requestQuit = false;
      if (!trayReady) {
        requestQuit = await showUnavailable();
      } else {
        let choice: WorkbenchCloseChoice = "keep-open";
        try {
          choice = await guardedCloseDialogs.showCloseDialog(
            activity as WorkbenchGuardedTurnActivity,
          );
        } catch {
          requestQuit = await showUnavailable();
        }
        if (
          choice === "hide-to-tray" &&
          !quitQueuedAfterClosePrompt &&
          generation === interactionGeneration &&
          !shutdownStarted &&
          !systemSessionEnding
        ) {
          if (isTrayReady()) {
            try {
              options.hideWindow();
            } catch {
              requestQuit = await showUnavailable();
            }
          } else {
            requestQuit = await showUnavailable();
          }
        }
      }
      if (generation !== interactionGeneration) return;
      closePromptPending = false;
      if (requestQuit || quitQueuedAfterClosePrompt) {
        quitQueuedAfterClosePrompt = false;
        startQuitAttempt();
      }
    })();
  };

  return Object.freeze({
    handleWindowClose(event: WorkbenchPreventableEvent): void {
      if (shutdownStarted || systemSessionEnding) return;
      event.preventDefault();
      if (closePromptPending || quitPromptPending) return;
      if (guardedCloseDialogs === null) {
        // Nothing in this composition can ask the user anything, so a close
        // that cannot hide has exactly two honest outcomes: hide, or leave.
        //
        // Returning instead — which is what this branch did with no tray —
        // keeps the prevented close and does nothing else: a window that will
        // not close, no tray to reopen it from, and no menu, because
        // `Menu.setApplicationMenu(null)` removed it. That is `F117`, which
        // `main.ts` names at its startup-failure boundary, surviving on the
        // close path because the fix went in on the startup path only.
        if (!isTrayReady()) {
          startQuitAttempt();
          return;
        }
        try {
          options.hideWindow();
        } catch {
          // The close is already prevented and the hide did not happen, so the
          // click has produced nothing at all. Treat it as the exit request it
          // was rather than leaving the user holding an unclosable window.
          startQuitAttempt();
        }
        return;
      }
      const activity = readTurnActivity();
      const trayReady = isTrayReady();
      if (activity === "idle" && trayReady) {
        try {
          options.hideWindow();
        } catch {
          startClosePrompt(activity, false);
        }
        return;
      }
      startClosePrompt(activity, trayReady);
    },
    handleBeforeQuit(event: WorkbenchPreventableEvent): void {
      if (systemSessionEnding) return;
      /*
       * Unlike `handleWindowClose`, preventing first is correct here: every
       * path below either starts a drain or is already running one, and every
       * drain ends in `exit()`. There is no prevent-and-do-nothing outcome.
       *
       * One hazard does survive, and worker 482 measured it rather than fixing
       * it. `closeBackend` has no deadline, so a drain that wedges leaves every
       * later quit prevented and dropped for good — the app cannot then be
       * closed by ordinary means, which is the `F117` shape this file's own
       * "half 2" comment already names in `handleBeforeQuit`. Letting a repeat
       * quit through is NOT the fix: Electron would then complete its own quit
       * and abandon the in-flight `closeBackend()`, and since the tray Quit
       * shows no progress while draining, an impatient second click is more
       * likely than a wedged drain. That trades a rare stranding for common
       * data loss. The real fix is either a deadline on the flush or the
       * `showQuitDialog` surface this controller already accepts and production
       * never passes; both are owner decisions, so neither was taken.
       */
      event.preventDefault();
      if (shutdownStarted || quitPromptPending) return;
      if (closePromptPending) {
        quitQueuedAfterClosePrompt = true;
        return;
      }
      startQuitAttempt();
    },
    handleQuerySessionEnd(_event?: WorkbenchPreventableEvent): void {
      systemSessionEnding = true;
      startDrain();
    },
    handleSessionEnd(_event?: WorkbenchPreventableEvent): void {
      systemSessionEnding = true;
      startDrain();
    },
    handleWindowAvailable(): void {
      if (!quitDeferredForPrompt) return;
      if (shutdownStarted || systemSessionEnding) {
        quitDeferredForPrompt = false;
        return;
      }
      quitDeferredForPrompt = false;
      startQuitAttempt();
    },
  });
}

export function createWorkbenchWindowRestorer(
  takeWindow: () => RestorableWorkbenchWindow | null,
): WorkbenchWindowRestorer {
  let restorePending = false;

  const restore = (): boolean => {
    try {
      const window = takeWindow();
      if (window === null || window.isDestroyed()) return false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    requestRestore(): void {
      restorePending = !restore();
    },
    windowAvailable(): void {
      if (!restorePending) return;
      restorePending = !restore();
    },
  });
}

export async function closeWorkbenchBackendAfterInitialization(
  initialization: Promise<void>,
  takeBackend: () => ClosableWorkbenchBackend | null,
): Promise<void> {
  try {
    await initialization;
  } finally {
    await takeBackend()?.close();
  }
}
