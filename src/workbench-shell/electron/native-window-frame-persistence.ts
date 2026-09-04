import {
  configureWindowsAcrylicWindow,
  formatNativeWindowFrameReassertionDiagnostic,
  type NativeWindowMaterialBoundary,
  type NativeWindowMaterialVerification,
} from "./native-window-material.ts";

/* F204, second half.
 *
 * `DWMWA_CAPTION_COLOR = DWMWA_COLOR_NONE` is not a mode the window keeps. It is
 * a value Windows overwrites whenever it recomputes the accent, and on this
 * machine it recomputes the accent every ten minutes: the desktop is a slideshow
 * (`BackgroundType = 2`, `Interval = 600000`) and `AutoColorization = 1`, so a
 * new wallpaper means a new accent means a repainted caption. Applying the
 * suppression once at window creation therefore buys ten minutes of correct
 * window and then loses it for the rest of the session.
 *
 * Observed on this machine at 2026-08-29T19:40:03 local, on a build whose launch
 * log read `probe=ran;border=ok;caption=ok`: the wallpaper file was rewritten at
 * 19:40:01.95, `WM_DWMCOLORIZATIONCOLORCHANGED` arrived four times between
 * 19:40:03.294 and 19:40:03.387, and by 19:40:07 the window's top band had gone
 * from pixel-identical to its body (`#C5C5C6`) to `#FDB6B7`. Nothing put it back.
 *
 * Which message to hook was decided by watching one real change go by with five
 * candidates instrumented, not by picking the plausible one (rule 6):
 *
 *   WM_DWMCOLORIZATIONCOLORCHANGED   fired, 4x, first and earliest  -> hooked
 *   WM_SETTINGCHANGE                 fired, 3x, 116 ms later        -> not hooked
 *   WM_THEMECHANGED                  silent
 *   WM_DWMCOMPOSITIONCHANGED         silent
 *   screen "display-metrics-changed"  silent
 *
 * `WM_SETTINGCHANGE` is deliberately left out even though it fired. It is the
 * broadcast that every system setting, policy and environment change sends, so
 * hooking it would put the suppression -- and the PowerShell process it costs --
 * on a hair trigger that has nothing to do with the accent, and here it said
 * nothing the colorization message had not already said first.
 */
const windowsDwmColorizationColorChanged = 0x0320;

/** The name is what reaches `run-app.log`; keep it the Win32 spelling. */
const windowsDwmColorizationColorChangedName =
  "WM_DWMCOLORIZATIONCOLORCHANGED" as const;

/* A colour change is not one notification, it is a burst -- four in 93 ms in the
 * measurement above. Each suppression costs a PowerShell process, so the burst
 * must collapse into one call. This window is wide enough to swallow the burst
 * that was actually observed with room to spare, and short enough that the
 * coloured caption is on screen for well under a second. */
const reassertionCoalescingWindowMilliseconds = 750;

export interface NativeWindowFrameMessageBoundary
  extends NativeWindowMaterialBoundary {
  hookWindowMessage(
    message: number,
    callback: (wParam: Buffer, lParam: Buffer) => void,
  ): void;
  unhookWindowMessage(message: number): void;
  isWindowMessageHooked(message: number): boolean;
}

export interface NativeWindowFrameReassertionBoundary {
  /** Runs the suppression. One call, one native round trip. */
  reassert(): Promise<NativeWindowMaterialVerification>;
  report(line: string): void;
  scheduleTimer(callback: () => void, delayMilliseconds: number): unknown;
  cancelTimer(timer: unknown): void;
}

export interface NativeWindowFrameReassertionScheduler {
  /** One arriving notification. Cheap, synchronous, never throws. */
  notify(trigger: string): void;
  /** Drops a pending burst. An in-flight re-assertion still reports. */
  cancelPending(): void;
}

/**
 * The coalescing policy, with no Electron and no Windows in it.
 *
 * What it guarantees, and these are the words the evidence report quotes:
 *
 * 1. **At most one re-assertion is ever in flight.** `reassert` is never called
 *    again until the previous call has settled.
 * 2. **A burst collapses.** Every notification arriving inside one coalescing
 *    window produces exactly one `reassert` call, and that call reports how many
 *    notifications it stood for.
 * 3. **Nothing is dropped.** A notification arriving while a call is in flight
 *    does not vanish and does not start a second concurrent call; it is carried
 *    into exactly one follow-up call scheduled after the current one settles.
 * 4. **The rate is bounded from above** by one `reassert` per coalescing window
 *    plus the duration of the call itself -- even if notifications never stop.
 *
 * The timer is armed by the *first* notification of a burst and is deliberately
 * not restarted by later ones. A restarting debounce has no upper bound on
 * latency: a slow drip of notifications would postpone the fix forever.
 */
export function createNativeWindowFrameReassertion(
  boundary: NativeWindowFrameReassertionBoundary,
  coalescingWindowMilliseconds: number = reassertionCoalescingWindowMilliseconds,
): NativeWindowFrameReassertionScheduler {
  let armedTimer: unknown = null;
  let running = false;
  let followUpRequested = false;
  let pendingTriggers: string[] = [];
  let pendingNotifications = 0;

  const arm = (): void => {
    if (armedTimer !== null || running) return;
    armedTimer = boundary.scheduleTimer(run, coalescingWindowMilliseconds);
  };

  function run(): void {
    armedTimer = null;
    running = true;
    const triggers = Object.freeze([...new Set(pendingTriggers)]);
    const coalescedNotifications = pendingNotifications;
    pendingTriggers = [];
    pendingNotifications = 0;
    void boundary
      .reassert()
      .then(
        (verification) =>
          formatNativeWindowFrameReassertionDiagnostic({
            triggers,
            coalescedNotifications,
            verification,
            failure: null,
          }),
        (error: unknown) =>
          formatNativeWindowFrameReassertionDiagnostic({
            triggers,
            coalescedNotifications,
            verification: null,
            failure: describeReassertionFailure(error),
          }),
      )
      .then((line) => {
        // Reported before the follow-up is armed, so the log order is the call
        // order even when the follow-up is immediate.
        boundary.report(line);
        running = false;
        if (!followUpRequested) return;
        followUpRequested = false;
        arm();
      });
  }

  return Object.freeze({
    notify(trigger: string): void {
      pendingNotifications += 1;
      pendingTriggers.push(trigger);
      if (running) {
        followUpRequested = true;
        return;
      }
      arm();
    },
    cancelPending(): void {
      const timer = armedTimer;
      armedTimer = null;
      followUpRequested = false;
      pendingTriggers = [];
      pendingNotifications = 0;
      if (timer !== null) boundary.cancelTimer(timer);
    },
  });
}

function describeReassertionFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "unknown-reassertion-failure";
}

export interface NativeWindowFrameReassertionInstallation {
  /** True only if the hook is actually in place; a lie here would be F196. */
  readonly hooked: boolean;
  readonly message: number;
  readonly messageName: string;
  dispose(): void;
}

/**
 * Wires the observed message to the coalescing policy on a real window.
 *
 * Installed only where the launch-time DWM path itself ran: no acrylic
 * capability means no caption attribute was ever set, and re-asserting one that
 * was never applied would be a claim this code cannot support.
 */
export function installNativeWindowFrameReassertion(
  options: Readonly<{
    window: NativeWindowFrameMessageBoundary;
    report: (line: string) => void;
    scheduleTimer?: (callback: () => void, delayMilliseconds: number) => unknown;
    cancelTimer?: (timer: unknown) => void;
    reassert?: () => Promise<NativeWindowMaterialVerification>;
    coalescingWindowMilliseconds?: number;
  }>,
): NativeWindowFrameReassertionInstallation {
  const window = options.window;
  const scheduler = createNativeWindowFrameReassertion(
    {
      reassert:
        options.reassert ?? (() => configureWindowsAcrylicWindow(window)),
      report: options.report,
      scheduleTimer:
        options.scheduleTimer ??
        ((callback, delayMilliseconds) =>
          setTimeout(callback, delayMilliseconds)),
      cancelTimer:
        options.cancelTimer ??
        ((timer) => {
          clearTimeout(timer as ReturnType<typeof setTimeout>);
        }),
    },
    options.coalescingWindowMilliseconds ??
      reassertionCoalescingWindowMilliseconds,
  );

  let hooked = false;
  try {
    window.hookWindowMessage(windowsDwmColorizationColorChanged, () => {
      scheduler.notify(windowsDwmColorizationColorChangedName);
    });
    hooked = window.isWindowMessageHooked(windowsDwmColorizationColorChanged);
  } catch {
    hooked = false;
  }

  return Object.freeze({
    hooked,
    message: windowsDwmColorizationColorChanged,
    messageName: windowsDwmColorizationColorChangedName,
    dispose(): void {
      scheduler.cancelPending();
      if (!hooked) return;
      try {
        window.unhookWindowMessage(windowsDwmColorizationColorChanged);
      } catch {
        // The window is already gone; there is nothing left to unhook.
      }
    },
  });
}

/**
 * The one line that says whether persistence exists at all on this launch.
 *
 * Printed beside the launch-time `probe=` line so a reader of `run-app.log`
 * never has to infer it: `installed=false` means the suppression is a one-shot
 * again and the caption will come back at the next accent recomputation.
 */
export function formatNativeWindowFrameHookDiagnostic(
  installation: NativeWindowFrameReassertionInstallation | null,
): string {
  if (installation === null) {
    return "[native-window-frame] hook=not-attempted;installed=false";
  }
  return `[native-window-frame] hook=${installation.messageName};installed=${installation.hooked}`;
}
