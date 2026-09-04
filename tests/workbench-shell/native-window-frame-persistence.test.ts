import assert from "node:assert/strict";
import test from "node:test";

import {
  createNativeWindowFrameReassertion,
  formatNativeWindowFrameHookDiagnostic,
  installNativeWindowFrameReassertion,
  type NativeWindowFrameMessageBoundary,
  type NativeWindowFrameReassertionBoundary,
} from "../../src/workbench-shell/electron/native-window-frame-persistence.ts";
import { formatNativeWindowFrameReassertionDiagnostic } from "../../src/workbench-shell/electron/native-window-material.ts";
import type { NativeWindowMaterialVerification } from "../../src/workbench-shell/electron/native-window-material.ts";

const windowsDwmColorizationColorChanged = 0x0320;

function suppressed(): NativeWindowMaterialVerification {
  return Object.freeze({
    state: "applied" as const,
    borderSuppressed: true,
    borderHresult: 0,
    captionSuppressed: true,
    captionHresult: 0,
    groundApplied: false,
    systemBackdropType: 3,
  });
}

/** A hand-driven clock: nothing fires until the test says so. */
function createManualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const delays: number[] = [];
  const cancelled: number[] = [];
  return {
    delays,
    cancelled,
    get armedCount() {
      return pending.size;
    },
    scheduleTimer(callback: () => void, delayMilliseconds: number): unknown {
      const handle = next++;
      delays.push(delayMilliseconds);
      pending.set(handle, callback);
      return handle;
    },
    cancelTimer(timer: unknown): void {
      cancelled.push(timer as number);
      pending.delete(timer as number);
    },
    fireAll(): void {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, callback] of due) callback();
    },
  };
}

test("a burst of notifications collapses into exactly one re-assertion", async () => {
  const timers = createManualTimers();
  const reported: string[] = [];
  let calls = 0;
  const scheduler = createNativeWindowFrameReassertion(
    {
      reassert: async () => {
        calls += 1;
        return suppressed();
      },
      report: (line) => reported.push(line),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    } satisfies NativeWindowFrameReassertionBoundary,
    750,
  );

  // The four WM_DWMCOLORIZATIONCOLORCHANGED that one real wallpaper change
  // delivered on 2026-08-29 at 19:40:03, inside 93 ms.
  for (let index = 0; index < 4; index += 1) {
    scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  }
  assert.equal(calls, 0, "nothing runs before the coalescing window closes");
  assert.deepEqual(timers.delays, [750], "the burst arms exactly one timer");

  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  assert.deepEqual(reported, [
    "[native-window-frame] reassert=ran;trigger=WM_DWMCOLORIZATIONCOLORCHANGED;coalesced=4;border=ok(hresult=0x00000000);caption=ok(hresult=0x00000000)",
  ]);
});

test("the coalescing window is not restarted by later notifications in the burst", () => {
  const timers = createManualTimers();
  const scheduler = createNativeWindowFrameReassertion(
    {
      reassert: async () => suppressed(),
      report: () => undefined,
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    },
    750,
  );
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  // One armed timer, never cancelled and never re-armed: a restarting debounce
  // would let an unending drip of notifications postpone the fix forever.
  assert.equal(timers.armedCount, 1);
  assert.deepEqual(timers.cancelled, []);
});

test("a notification arriving mid-flight is carried into one follow-up, not a second concurrent call", async () => {
  const timers = createManualTimers();
  const reported: string[] = [];
  let calls = 0;
  let releaseFirst: (() => void) | null = null;
  const scheduler = createNativeWindowFrameReassertion(
    {
      reassert: async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return suppressed();
      },
      report: (line) => reported.push(line),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    },
    750,
  );

  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  // Three more arrive while the first native call is still outstanding.
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  assert.equal(calls, 1, "no second call is started while one is in flight");
  assert.equal(timers.armedCount, 0, "and no timer is armed while in flight");

  assert.notEqual(releaseFirst, null);
  (releaseFirst as unknown as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.armedCount, 1, "exactly one follow-up is armed");
  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 2, "three mid-flight notifications became one follow-up");
  assert.deepEqual(reported, [
    "[native-window-frame] reassert=ran;trigger=WM_DWMCOLORIZATIONCOLORCHANGED;coalesced=1;border=ok(hresult=0x00000000);caption=ok(hresult=0x00000000)",
    "[native-window-frame] reassert=ran;trigger=WM_DWMCOLORIZATIONCOLORCHANGED;coalesced=3;border=ok(hresult=0x00000000);caption=ok(hresult=0x00000000)",
  ]);
});

test("a re-application that fails is reported, never silent", async () => {
  const timers = createManualTimers();
  const reported: string[] = [];
  const scheduler = createNativeWindowFrameReassertion(
    {
      reassert: async () => {
        throw new Error("native-window-observation-invalid");
      },
      report: (line) => reported.push(line),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    },
    750,
  );
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reported, [
    "[native-window-frame] reassert=FAILED;trigger=WM_DWMCOLORIZATIONCOLORCHANGED;coalesced=1;reason=native-window-observation-invalid",
  ]);
});

test("a re-application that runs but does not suppress is reported as FAILED on the attribute", () => {
  assert.equal(
    formatNativeWindowFrameReassertionDiagnostic({
      triggers: Object.freeze(["WM_DWMCOLORIZATIONCOLORCHANGED"]),
      coalescedNotifications: 2,
      verification: Object.freeze({
        state: "undetermined",
        borderSuppressed: true,
        borderHresult: 0,
        captionSuppressed: false,
        captionHresult: -2_147_024_809,
        groundApplied: false,
        systemBackdropType: null,
      }),
      failure: null,
    }),
    "[native-window-frame] reassert=ran;trigger=WM_DWMCOLORIZATIONCOLORCHANGED;coalesced=2;border=ok(hresult=0x00000000);caption=FAILED(hresult=0x80070057)",
  );
  assert.equal(
    formatNativeWindowFrameReassertionDiagnostic({
      triggers: Object.freeze(["WM_DWMCOLORIZATIONCOLORCHANGED"]),
      coalescedNotifications: 1,
      verification: Object.freeze({
        state: "undetermined",
        borderSuppressed: false,
        borderHresult: null,
        captionSuppressed: false,
        captionHresult: null,
        groundApplied: false,
        systemBackdropType: null,
      }),
      failure: null,
    }),
    "[native-window-frame] reassert=ran;trigger=WM_DWMCOLORIZATIONCOLORCHANGED;coalesced=1;border=not-attempted;caption=not-attempted",
  );
  assert.equal(
    formatNativeWindowFrameReassertionDiagnostic({
      triggers: Object.freeze([]),
      coalescedNotifications: 0,
      verification: null,
      failure: "window-handle-unavailable",
    }),
    "[native-window-frame] reassert=FAILED;trigger=none;coalesced=0;reason=window-handle-unavailable",
  );
});

test("cancelling a pending burst stops it without reporting a re-assertion", async () => {
  const timers = createManualTimers();
  const reported: string[] = [];
  let calls = 0;
  const scheduler = createNativeWindowFrameReassertion(
    {
      reassert: async () => {
        calls += 1;
        return suppressed();
      },
      report: (line) => reported.push(line),
      scheduleTimer: timers.scheduleTimer,
      cancelTimer: timers.cancelTimer,
    },
    750,
  );
  scheduler.notify("WM_DWMCOLORIZATIONCOLORCHANGED");
  scheduler.cancelPending();
  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.deepEqual(reported, []);
  assert.equal(timers.cancelled.length, 1);
});

function createMessageWindow(
  options: Readonly<{ hookThrows?: boolean; hookedAnswer?: boolean }> = {},
) {
  const hooks = new Map<number, (wParam: Buffer, lParam: Buffer) => void>();
  const unhooked: number[] = [];
  return {
    hooks,
    unhooked,
    window: {
      getNativeWindowHandle: () => Buffer.alloc(8),
      setBackgroundColor: () => undefined,
      setBackgroundMaterial: () => undefined,
      hookWindowMessage(
        message: number,
        callback: (wParam: Buffer, lParam: Buffer) => void,
      ): void {
        if (options.hookThrows === true) throw new Error("hook-refused");
        hooks.set(message, callback);
      },
      unhookWindowMessage(message: number): void {
        unhooked.push(message);
        hooks.delete(message);
      },
      isWindowMessageHooked: (message: number): boolean =>
        options.hookedAnswer ?? hooks.has(message),
    } satisfies NativeWindowFrameMessageBoundary,
  };
}

test("the installer hooks the one message that was observed to fire and reports that it did", async () => {
  const timers = createManualTimers();
  const reported: string[] = [];
  const harness = createMessageWindow();
  let calls = 0;
  const installation = installNativeWindowFrameReassertion({
    window: harness.window,
    report: (line) => reported.push(line),
    scheduleTimer: timers.scheduleTimer,
    cancelTimer: timers.cancelTimer,
    reassert: async () => {
      calls += 1;
      return suppressed();
    },
    coalescingWindowMilliseconds: 750,
  });

  assert.equal(installation.hooked, true);
  assert.equal(installation.message, windowsDwmColorizationColorChanged);
  assert.deepEqual([...harness.hooks.keys()], [
    windowsDwmColorizationColorChanged,
  ]);
  assert.equal(
    formatNativeWindowFrameHookDiagnostic(installation),
    "[native-window-frame] hook=WM_DWMCOLORIZATIONCOLORCHANGED;installed=true",
  );

  harness.hooks.get(windowsDwmColorizationColorChanged)!(
    Buffer.alloc(8),
    Buffer.alloc(8),
  );
  timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  installation.dispose();
  assert.deepEqual(harness.unhooked, [windowsDwmColorizationColorChanged]);
});

test("a hook that cannot be installed says so instead of claiming persistence", () => {
  const timers = createManualTimers();
  const harness = createMessageWindow({ hookThrows: true });
  const installation = installNativeWindowFrameReassertion({
    window: harness.window,
    report: () => undefined,
    scheduleTimer: timers.scheduleTimer,
    cancelTimer: timers.cancelTimer,
    reassert: async () => suppressed(),
  });
  assert.equal(installation.hooked, false);
  assert.equal(
    formatNativeWindowFrameHookDiagnostic(installation),
    "[native-window-frame] hook=WM_DWMCOLORIZATIONCOLORCHANGED;installed=false",
  );
  // Nothing to unhook, and dispose must not throw on top of the failure.
  installation.dispose();
  assert.deepEqual(harness.unhooked, []);
  assert.equal(
    formatNativeWindowFrameHookDiagnostic(null),
    "[native-window-frame] hook=not-attempted;installed=false",
  );
});

test("the installation reports hooked=false when the platform accepts the call but does not hold the hook", () => {
  const timers = createManualTimers();
  const harness = createMessageWindow({ hookedAnswer: false });
  const installation = installNativeWindowFrameReassertion({
    window: harness.window,
    report: () => undefined,
    scheduleTimer: timers.scheduleTimer,
    cancelTimer: timers.cancelTimer,
    reassert: async () => suppressed(),
  });
  // `hookWindowMessage` returns void, so the only honest answer comes from
  // asking the platform back. Succeed-but-disagree is a failure, not a pass.
  assert.equal(installation.hooked, false);
});
