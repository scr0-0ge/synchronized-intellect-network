import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_WINDOW_ACTION_CHANNEL,
  WORKBENCH_WINDOW_DISPOSE_CHANNEL,
  WORKBENCH_WINDOW_OBSERVE_CHANNEL,
  WORKBENCH_WINDOW_STATE_CHANNEL,
  createWorkbenchWindowControlPreloadBridge,
  installWorkbenchWindowControlIpc,
  type FixedWindowControlRendererIpc,
  type WorkbenchWindowBoundary,
  type WorkbenchWindowControlIpcMain,
} from "../../src/workbench-shell/window-control-bridge.ts";

class FakeRendererIpc implements FixedWindowControlRendererIpc {
  readonly sent: Array<Readonly<{ channel: string; values: readonly unknown[] }>> = [];
  readonly listeners = new Set<(event: unknown, value: unknown) => void>();

  on(
    channel: typeof WORKBENCH_WINDOW_STATE_CHANNEL,
    listener: (event: unknown, value: unknown) => void,
  ): void {
    assert.equal(channel, WORKBENCH_WINDOW_STATE_CHANNEL);
    this.listeners.add(listener);
  }

  removeListener(
    channel: typeof WORKBENCH_WINDOW_STATE_CHANNEL,
    listener: (event: unknown, value: unknown) => void,
  ): void {
    assert.equal(channel, WORKBENCH_WINDOW_STATE_CHANNEL);
    this.listeners.delete(listener);
  }

  send(channel: string, ...values: readonly unknown[]): void {
    this.sent.push({ channel, values });
  }

  emit(value: unknown): void {
    for (const listener of [...this.listeners]) listener({}, value);
  }
}

test("the frozen preload bridge emits only fixed window actions and accepts only exact state", () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchWindowControlPreloadBridge(ipc);
  const observed: unknown[] = [];
  const dispose = bridge.observeState((state) => observed.push(state));

  (bridge.minimize as (...values: unknown[]) => void)("ignored");
  (bridge.toggleMaximize as (...values: unknown[]) => void)({ ignored: true });
  (bridge.close as (...values: unknown[]) => void)("ignored");
  ipc.emit({ maximized: true, extra: "PRIVATE_NATIVE_VALUE" });
  ipc.emit({ maximized: "true" });
  ipc.emit({ maximized: true });

  assert.deepEqual(Object.keys(bridge), [
    "observeState",
    "minimize",
    "toggleMaximize",
    "close",
  ]);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(observed, [{ maximized: true }]);
  assert.equal(Object.isFrozen(observed[0]), true);
  assert.deepEqual(ipc.sent, [
    { channel: WORKBENCH_WINDOW_OBSERVE_CHANNEL, values: [] },
    { channel: WORKBENCH_WINDOW_ACTION_CHANNEL, values: ["minimize"] },
    { channel: WORKBENCH_WINDOW_ACTION_CHANNEL, values: ["toggle-maximize"] },
    { channel: WORKBENCH_WINDOW_ACTION_CHANNEL, values: ["close"] },
  ]);

  dispose();
  dispose();
  assert.deepEqual(ipc.sent.at(-1), {
    channel: WORKBENCH_WINDOW_DISPOSE_CHANNEL,
    values: [],
  });
  assert.equal(ipc.listeners.size, 0);
});

type MainListener = (event: unknown, ...values: readonly unknown[]) => void;

class FakeMainIpc implements WorkbenchWindowControlIpcMain {
  readonly listeners = new Map<string, Set<MainListener>>();

  on(channel: string, listener: MainListener): void {
    const listeners = this.listeners.get(channel) ?? new Set<MainListener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: MainListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, event: unknown, ...values: readonly unknown[]): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener(event, ...values);
    }
  }
}

class FakeWindow implements WorkbenchWindowBoundary {
  readonly sent: Array<Readonly<{ channel: string; value: unknown }>> = [];
  readonly events = new Map<string, Set<() => void>>();
  readonly webContents = Object.freeze({
    send: (channel: string, value: unknown): void => {
      this.sent.push({ channel, value });
    },
  });
  maximized = false;
  minimizeCalls = 0;
  maximizeCalls = 0;
  unmaximizeCalls = 0;
  closeCalls = 0;

  on(event: "maximize" | "unmaximize" | "closed", listener: () => void): void {
    const listeners = this.events.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.events.set(event, listeners);
  }

  removeListener(
    event: "maximize" | "unmaximize" | "closed",
    listener: () => void,
  ): void {
    this.events.get(event)?.delete(listener);
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  minimize(): void {
    this.minimizeCalls += 1;
  }

  maximize(): void {
    this.maximizeCalls += 1;
    this.maximized = true;
    this.emit("maximize");
  }

  unmaximize(): void {
    this.unmaximizeCalls += 1;
    this.maximized = false;
    this.emit("unmaximize");
  }

  close(): void {
    this.closeCalls += 1;
  }

  emit(event: "maximize" | "unmaximize" | "closed"): void {
    for (const listener of [...(this.events.get(event) ?? [])]) listener();
  }
}

test("main window controls reject foreign or malformed messages and publish main-owned maximize state", () => {
  const ipc = new FakeMainIpc();
  const window = new FakeWindow();
  const owner = window.webContents;
  const foreign = Object.freeze({});
  const binding = installWorkbenchWindowControlIpc({ ipcMain: ipc, window });

  ipc.emit(WORKBENCH_WINDOW_ACTION_CHANNEL, { sender: foreign }, "close");
  ipc.emit(WORKBENCH_WINDOW_ACTION_CHANNEL, { sender: owner }, "close", "extra");
  ipc.emit(WORKBENCH_WINDOW_ACTION_CHANNEL, { sender: owner }, "unknown");
  assert.equal(window.closeCalls, 0);

  ipc.emit(WORKBENCH_WINDOW_OBSERVE_CHANNEL, { sender: owner });
  assert.deepEqual(window.sent, [
    { channel: WORKBENCH_WINDOW_STATE_CHANNEL, value: { maximized: false } },
  ]);
  assert.equal(Object.isFrozen(window.sent[0]?.value), true);

  ipc.emit(WORKBENCH_WINDOW_ACTION_CHANNEL, { sender: owner }, "minimize");
  ipc.emit(
    WORKBENCH_WINDOW_ACTION_CHANNEL,
    { sender: owner },
    "toggle-maximize",
  );
  ipc.emit(
    WORKBENCH_WINDOW_ACTION_CHANNEL,
    { sender: owner },
    "toggle-maximize",
  );
  ipc.emit(WORKBENCH_WINDOW_ACTION_CHANNEL, { sender: owner }, "close");
  assert.equal(window.minimizeCalls, 1);
  assert.equal(window.maximizeCalls, 1);
  assert.equal(window.unmaximizeCalls, 1);
  assert.equal(window.closeCalls, 1);
  assert.deepEqual(
    window.sent.map(({ value }) => value),
    [{ maximized: false }, { maximized: true }, { maximized: false }],
  );

  ipc.emit(WORKBENCH_WINDOW_DISPOSE_CHANNEL, { sender: owner });
  window.emit("maximize");
  assert.equal(window.sent.length, 3);
  binding.dispose();
  assert.equal(
    [...ipc.listeners.values()].every((listeners) => listeners.size === 0),
    true,
  );
});
