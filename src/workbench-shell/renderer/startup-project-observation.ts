import type {
  WorkbenchHostedProjectListener,
  WorkbenchRendererBridge,
} from "../contract.ts";

type StartupObservationScheduler = Readonly<{
  set(delayMilliseconds: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}>;

const browserScheduler: StartupObservationScheduler = Object.freeze({
  set: (delayMilliseconds, callback) =>
    globalThis.setTimeout(callback, delayMilliseconds),
  clear: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/**
 * Keep asking for the first Project view while Electron finishes installing
 * its startup IPC handlers. Once any real result arrives, the ordinary live
 * observation remains installed and no more startup retries are scheduled.
 */
export function observeProjectThroughStartup(
  bridge: Pick<WorkbenchRendererBridge, "observeProject">,
  listener: WorkbenchHostedProjectListener,
  options: Readonly<{
    retryDelayMilliseconds?: number;
    scheduler?: StartupObservationScheduler;
  }> = {},
): () => void {
  const scheduler = options.scheduler ?? browserScheduler;
  const retryDelayMilliseconds = options.retryDelayMilliseconds ?? 100;
  let active = true;
  let received = false;
  let retryHandle: unknown;
  let disposeObservation: (() => void) | undefined;

  const clearRetry = (): void => {
    if (retryHandle === undefined) return;
    scheduler.clear(retryHandle);
    retryHandle = undefined;
  };
  const scheduleRetry = (): void => {
    if (!active || received || retryHandle !== undefined) return;
    retryHandle = scheduler.set(retryDelayMilliseconds, () => {
      retryHandle = undefined;
      disposeObservation?.();
      disposeObservation = undefined;
      attemptObservation();
    });
  };
  const attemptObservation = (): void => {
    if (!active || received) return;
    try {
      const nextDispose = bridge.observeProject((result) => {
        if (!active) return;
        if (!received) {
          received = true;
          clearRetry();
        }
        listener(result);
      });
      if (!active) {
        nextDispose();
        return;
      }
      disposeObservation = nextDispose;
    } catch {
      // An IPC handler may not exist yet during early renderer startup.
    }
    scheduleRetry();
  };

  attemptObservation();
  return () => {
    if (!active) return;
    active = false;
    clearRetry();
    disposeObservation?.();
    disposeObservation = undefined;
  };
}
