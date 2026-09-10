/*
 * One teardown list, run so that no step can cancel another (issue 172).
 *
 * The bindings the main window owns used to be torn down in two places — the
 * lifecycle drain (`disposeProjectView`) and the window's own "closed" handler —
 * by two statement sequences that had drifted apart. Both had the same shape:
 * one `dispose()` throwing abandoned every later step. The drain's caller then
 * swallowed the throw, so a half-finished teardown was invisible, and the live
 * bindings it left behind were disposed a second time from the "closed"
 * handler, where the window is destroyed and nothing catches. That is how a
 * teardown failure reached the owner as Electron's main-process exception
 * dialog.
 *
 * The per-step isolation below is deliberately NOT a catch wrapped around the
 * symptom. It is not what stops that exception — the installers no longer read
 * `window.webContents` on a destroyed window at all, so the throw has no
 * source. What this adds is that one binding's failure is not the other nine's
 * business, and that every failure is REPORTED with the step that produced it.
 * A teardown race stays visible; the previous arrangement is what made one
 * silent.
 */

export interface WorkbenchTeardownStep {
  /** Reaches the diagnostic, so a failure says which binding produced it. */
  readonly name: string;
  run(): void;
}

export interface WorkbenchTeardownFailure {
  readonly name: string;
  readonly error: unknown;
}

/**
 * Runs every step. A step that throws is recorded and reported; the steps after
 * it still run. Returns the failures in the order they happened, so a caller
 * that wants to react to them can, and one that does not still cannot lose them
 * — they have already been reported.
 */
export function runWorkbenchTeardownSteps(
  steps: readonly WorkbenchTeardownStep[],
  report: (failure: WorkbenchTeardownFailure) => void,
): readonly WorkbenchTeardownFailure[] {
  const failures: WorkbenchTeardownFailure[] = [];
  for (const step of steps) {
    try {
      step.run();
    } catch (error) {
      const failure = Object.freeze({ name: step.name, error });
      failures.push(failure);
      try {
        report(failure);
      } catch {
        // A reporter that fails must not take the rest of the teardown with it;
        // that is the exact failure mode this module exists to remove.
      }
    }
  }
  return Object.freeze(failures);
}

/**
 * The durable close, ordered so that best-effort work cannot cancel it.
 *
 * `closeBackend` used to `await` two listener-teardown promises before it
 * reached the conversation-store close, and both awaits sat OUTSIDE its
 * `try`/`finally`. Both promises come from `async dispose()` calls that can
 * reject, so a rejection there skipped the entire flush — backend, create-project
 * controller, appearance store and history recovery — and the drain then exited
 * the process anyway, because it swallows the reason. This product's promise is
 * that conversations survive a restart, so the flush is the mandatory half and
 * must not be sequenced behind the optional half.
 *
 * `allSettled` is what makes that structural: a rejected listener shutdown
 * cannot short-circuit the await, and it is reported rather than dropped.
 */
export async function closeDurableStateAfterListenerShutdown(options: {
  readonly listenerShutdowns: readonly Promise<void>[];
  readonly closeDurableState: () => Promise<void>;
  readonly report: (failure: WorkbenchTeardownFailure) => void;
}): Promise<void> {
  const settled = await Promise.allSettled(options.listenerShutdowns);
  settled.forEach((result, index) => {
    if (result.status !== "rejected") return;
    try {
      options.report(
        Object.freeze({
          name: `listener-shutdown[${index}]`,
          error: result.reason,
        }),
      );
    } catch {
      // Reporting is diagnostic; the durable close below is the obligation.
    }
  });
  await options.closeDurableState();
}
