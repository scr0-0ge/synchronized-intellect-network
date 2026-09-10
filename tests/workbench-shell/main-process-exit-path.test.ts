/*
 * Issue 172 — the two defects on the way out of the application.
 *
 * D1, the quit-path exception. Every window-scoped IPC binding tears itself
 * down by writing `options.window.webContents.removeListener(...)`. Reading the
 * `webContents` GETTER on a destroyed BrowserWindow throws
 * `TypeError: Object has been destroyed` — measured on this repository's own
 * Electron 37.2.6, not assumed — and `main.ts`'s `once("closed")` handler runs
 * inside `app.exit()`, by which time the window IS destroyed. The bindings are
 * normally null by then only because the drain happened to null them first, so
 * what stands between the owner and Electron's exception dialog is an ordering
 * coincidence.
 *
 * These guards pin the condition rather than racing it (the F225 pattern from
 * worker 475): the window double's `webContents` getter throws exactly what a
 * destroyed BrowserWindow throws, and the destroy and the dispose sit in the
 * same synchronous task. There is no timing in them at all.
 *
 * D2, the unquittable close path. Production composes the lifecycle controller
 * with none of the three dialogs, so `handleWindowClose` takes the branch that
 * calls `event.preventDefault()` and then, with no tray, returns having done
 * nothing. No window, no tray, and `Menu.setApplicationMenu(null)`: that is
 * `F117` — which `main.ts:783` names — surviving on the close path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  installWorkbenchAppearancePreferenceIpc,
  type AppearancePreferenceIpcMainBoundary,
  type WorkbenchAppearancePreferenceSource,
} from "../../src/workbench-shell/electron/appearance-preference-ipc.ts";
import {
  installWorkbenchClaudePermissionHandlingIpc,
  type ClaudePermissionHandlingIpcMainBoundary,
  type WorkbenchClaudePermissionHandlingSource,
} from "../../src/workbench-shell/electron/claude-permission-handling-ipc.ts";
import {
  installWorkbenchClipboardIpc,
  type WorkbenchClipboardIpcMainBoundary,
  type WorkbenchSystemClipboardBoundary,
} from "../../src/workbench-shell/electron/clipboard-ipc.ts";
import {
  installWorkbenchNotificationIpc,
  type WorkbenchNotificationIpcMainBoundary,
  type WorkbenchSystemNotificationBoundary,
  type WorkbenchSystemNotificationInstance,
} from "../../src/workbench-shell/electron/notification-ipc.ts";
import {
  installWorkbenchRuntimeExecutableIpc,
  type RuntimeExecutableIpcMainBoundary,
  type WorkbenchRuntimeExecutableSource,
} from "../../src/workbench-shell/electron/runtime-executable-ipc.ts";
import {
  installWorkbenchSubscriptionAuthenticationActionIpc,
  installWorkbenchSubscriptionAuthenticationIpc,
  type SubscriptionAuthenticationIpcMainBoundary,
  type WorkbenchSubscriptionAuthenticationSource,
} from "../../src/workbench-shell/electron/subscription-authentication-ipc.ts";
import type { WorkbenchSubscriptionAuthenticationCoordinator } from "../../src/workbench-shell/subscription-authentication-coordinator.ts";
import { createWorkbenchLifecycleController } from "../../src/workbench-shell/electron/lifecycle.ts";

type Listener = (...values: unknown[]) => unknown;

/** What a real destroyed BrowserWindow throws. Measured, then written down. */
const DESTROYED_MESSAGE = "Object has been destroyed";

async function flushLifecyclePromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeSender {
  readonly listeners = new Map<string, Set<Listener>>();
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(_channel: string, _value: unknown): void {}

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/**
 * A BrowserWindow double whose `webContents` getter behaves like the real one:
 * it answers while the window lives and throws `Object has been destroyed`
 * afterwards. `removeListener` on the window itself keeps working after
 * destruction, because the real one does (probe 3).
 */
class DestroyableWindow {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly sender = new FakeSender();
  private destroyed = false;

  get webContents(): FakeSender {
    if (this.destroyed) throw new TypeError(DESTROYED_MESSAGE);
    return this.sender;
  }

  destroy(): void {
    this.destroyed = true;
    this.sender.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  isFocused(): boolean {
    return false;
  }

  isMinimized(): boolean {
    return false;
  }

  restore(): void {}

  show(): void {}

  focus(): void {}
}

const FakeNotification: WorkbenchSystemNotificationBoundary = class {
  static isSupported(): boolean {
    return true;
  }

  on(): WorkbenchSystemNotificationInstance {
    return this;
  }

  removeListener(): WorkbenchSystemNotificationInstance {
    return this;
  }

  show(): void {}

  close(): void {}
};

class FakeIpcMain {
  readonly handlers = new Map<string, Listener>();
  readonly listeners = new Map<string, Set<Listener>>();

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  on(channel: string, listener: Listener): void {
    const listeners = this.listeners.get(channel) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener);
  }
}

/*
 * Every binding `main.ts` disposes from the window's "closed" handler, with the
 * installer call reduced to what dispose() actually depends on. The name is the
 * one that reaches the failure message, so a red run says which binding broke.
 */
const windowScopedBindings: ReadonlyArray<
  Readonly<{
    name: string;
    install: (window: DestroyableWindow) => { dispose(): void | Promise<void> };
  }>
> = Object.freeze([
  Object.freeze({
    name: "appearancePreferenceIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchAppearancePreferenceIpc({
        ipcMain: new FakeIpcMain() as AppearancePreferenceIpcMainBoundary,
        window,
        source: {
          async read() {
            return { appearance: "system" };
          },
          async save() {},
        } as unknown as WorkbenchAppearancePreferenceSource,
      }),
  }),
  Object.freeze({
    name: "claudePermissionHandlingIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchClaudePermissionHandlingIpc({
        ipcMain: new FakeIpcMain() as ClaudePermissionHandlingIpcMainBoundary,
        window,
        source: {
          async readClaudePermissionHandling() {
            return "ask-when-needed";
          },
          async saveClaudePermissionHandling() {},
        } as unknown as WorkbenchClaudePermissionHandlingSource,
      }),
  }),
  Object.freeze({
    name: "runtimeExecutableIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchRuntimeExecutableIpc({
        ipcMain: new FakeIpcMain() as RuntimeExecutableIpcMainBoundary,
        window,
        source: {
          async readRuntimeExecutables() {
            return {};
          },
          async saveRuntimeExecutables() {},
        } as unknown as WorkbenchRuntimeExecutableSource,
      }),
  }),
  Object.freeze({
    name: "clipboardIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchClipboardIpc({
        ipcMain: new FakeIpcMain() as WorkbenchClipboardIpcMainBoundary,
        window,
        clipboard: {
          writeText() {},
          readText() {
            return "";
          },
        } satisfies WorkbenchSystemClipboardBoundary,
      }),
  }),
  Object.freeze({
    name: "notificationIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchNotificationIpc({
        ipcMain: new FakeIpcMain() as WorkbenchNotificationIpcMainBoundary,
        window,
        notification: FakeNotification,
        platform: "win32",
      }),
  }),
  Object.freeze({
    name: "subscriptionAuthenticationIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchSubscriptionAuthenticationIpc({
        ipcMain: new FakeIpcMain() as SubscriptionAuthenticationIpcMainBoundary,
        window,
        source: {
          async inspect() {
            return {};
          },
          async bind() {
            return {};
          },
          async cancel() {
            return false;
          },
          async close() {},
        } as unknown as WorkbenchSubscriptionAuthenticationSource,
      }),
  }),
  Object.freeze({
    name: "subscriptionAuthenticationActionIpc",
    install: (window: DestroyableWindow) =>
      installWorkbenchSubscriptionAuthenticationActionIpc({
        ipcMain: new FakeIpcMain() as SubscriptionAuthenticationIpcMainBoundary,
        window,
        source: {
          async request() {
            return { ok: false };
          },
          async cancelPreparation() {
            return false;
          },
          async attemptNativeResume() {
            return {};
          },
          async close() {},
          sanitizePublicRequest() {
            return { ok: false };
          },
          sanitizePublicResponse() {
            return { ok: false };
          },
          setCatalogObservation() {},
          renderSettings() {
            return {};
          },
          keyAuthority: {},
        } as unknown as WorkbenchSubscriptionAuthenticationCoordinator,
      }),
  }),
]);

for (const binding of windowScopedBindings) {
  test(`${binding.name} disposes without reaching through a destroyed window`, async () => {
    const window = new DestroyableWindow();
    const installed = binding.install(window);

    // The pinned condition. Destroying and disposing sit in one synchronous
    // task, so this fails every run rather than one run in thirty.
    window.destroy();

    await assert.doesNotReject(
      async () => {
        await installed.dispose();
      },
      `${binding.name}.dispose() must not dereference window.webContents once the window is destroyed`,
    );
  });
}

test("a destroyed window's webContents getter is what throws, not removeListener", () => {
  // The premise the guards above rest on, asserted rather than assumed: it is
  // the getter that fails, so a reference captured while the window lived
  // stays usable. Measured against Electron 37.2.6 before it was written down.
  const window = new DestroyableWindow();
  const captured = window.webContents;
  const listener = (): void => {};
  captured.on("destroyed", listener);

  window.destroy();

  assert.throws(() => window.webContents, { message: DESTROYED_MESSAGE });
  assert.doesNotThrow(() => captured.removeListener("destroyed", listener));
  assert.equal(captured.listenerCount("destroyed"), 0);
});

/*
 * The production composition, spelled out once. `main.ts` passes none of
 * showCloseDialog, showCloseUnavailableDialog or showQuitDialog, so every guard
 * below runs the branch the shipped application actually runs.
 */
function productionLifecycle(options: {
  readonly trayReady: () => boolean;
  readonly hideWindow?: () => void;
}): Readonly<{
  handleWindowClose: (event: { preventDefault(): void }) => void;
  handleBeforeQuit: (event: { preventDefault(): void }) => void;
  counts: {
    prevented: number;
    hidden: number;
    disposed: number;
    exited: number;
  };
}> {
  const counts = { prevented: 0, hidden: 0, disposed: 0, exited: 0 };
  const controller = createWorkbenchLifecycleController({
    readTurnActivity: () => "idle",
    isTrayReady: options.trayReady,
    hideWindow() {
      counts.hidden += 1;
      options.hideWindow?.();
    },
    disposeProjectView() {
      counts.disposed += 1;
    },
    async closeBackend() {},
    exit() {
      counts.exited += 1;
    },
  });
  return Object.freeze({
    handleWindowClose: (event: { preventDefault(): void }) => {
      controller.handleWindowClose(event);
    },
    handleBeforeQuit: (event: { preventDefault(): void }) => {
      controller.handleBeforeQuit(event);
    },
    counts,
  });
}

test("closing with no tray leaves the user a way out instead of a refused close", async () => {
  const lifecycle = productionLifecycle({ trayReady: () => false });

  lifecycle.handleWindowClose({
    preventDefault() {
      lifecycle.counts.prevented += 1;
    },
  });
  await flushLifecyclePromises();

  // The destination, not the route: after the user asks to close, either the
  // close proceeds or the application exits. What must never happen is the
  // pre-fix outcome — prevented, not hidden, not drained: a window that will
  // not close, with no tray and no menu behind it.
  const wentAway =
    lifecycle.counts.prevented === 0 || lifecycle.counts.exited > 0;
  assert.ok(
    wentAway,
    `close with no tray stranded the user: ${JSON.stringify(lifecycle.counts)}`,
  );
});

test("a failed hide to a ready tray still leaves the user a way out", async () => {
  const lifecycle = productionLifecycle({
    trayReady: () => true,
    hideWindow() {
      throw new Error("hide-failed");
    },
  });

  lifecycle.handleWindowClose({
    preventDefault() {
      lifecycle.counts.prevented += 1;
    },
  });
  await flushLifecyclePromises();

  // Pre-fix this swallowed the failure and returned: the close was prevented,
  // the hide did not happen, and nothing else did either.
  const wentAway =
    lifecycle.counts.prevented === 0 || lifecycle.counts.exited > 0;
  assert.ok(
    wentAway,
    `failed hide stranded the user: ${JSON.stringify(lifecycle.counts)}`,
  );
});

test("closing with a ready tray still hides rather than exiting", async () => {
  const lifecycle = productionLifecycle({ trayReady: () => true });

  lifecycle.handleWindowClose({
    preventDefault() {
      lifecycle.counts.prevented += 1;
    },
  });
  await flushLifecyclePromises();

  // The close-to-tray behaviour the product promises is unchanged by the fix.
  assert.equal(lifecycle.counts.prevented, 1);
  assert.equal(lifecycle.counts.hidden, 1);
  assert.equal(lifecycle.counts.exited, 0);
});

/*
 * The wedged-drain hazard is characterised here rather than fixed, so this
 * records what the shipped behaviour IS. `closeBackend` has no deadline, and a
 * drain that never settles leaves every later quit prevented and dropped.
 *
 * Letting the repeat quit through was tried and reverted: Electron would then
 * complete its own quit and abandon the in-flight `closeBackend()`, and a tray
 * Quit shows no progress while draining, so an impatient second click — more
 * likely than a wedged drain — would cost the flush. The fix needs either a
 * deadline or the `showQuitDialog` surface production never wires, and both are
 * owner decisions. If this test ever starts failing, that decision has been
 * taken and this is the record of what it replaced.
 */
test("a wedged drain currently keeps every later quit prevented — measured, not endorsed", async () => {
  let exited = 0;
  let prevented = 0;
  const controller = createWorkbenchLifecycleController({
    readTurnActivity: () => "idle",
    isTrayReady: () => true,
    hideWindow() {},
    disposeProjectView() {},
    closeBackend: () => new Promise<void>(() => undefined),
    exit() {
      exited += 1;
    },
  });
  const event = {
    preventDefault() {
      prevented += 1;
    },
  };

  controller.handleBeforeQuit(event);
  controller.handleBeforeQuit(event);
  await flushLifecyclePromises();

  assert.equal(prevented, 2, "both quits are prevented");
  assert.equal(exited, 0, "and the drain has not reached exit()");
});
