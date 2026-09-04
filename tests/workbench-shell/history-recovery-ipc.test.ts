import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
  type HistoryRecoveryCancelResult,
  type HistoryRecoverySnapshotResult,
} from "../../src/workbench-shell/history-recovery-contract.ts";
import {
  installHistoryRecoveryIpc,
  type HistoryRecoveryIpcMainBoundary,
} from "../../src/workbench-shell/electron/history-recovery-ipc.ts";
import type {
  HistoricalRecoveryLibrary,
  HistoryRecoveryExecutionResult,
} from "../../src/workbench-shell/history-recovery.ts";
import type {
  BrowserWindowBoundary,
  RendererSender,
} from "../../src/workbench-shell/electron/project-view-ipc.ts";

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain implements HistoryRecoveryIpcMainBoundary {
  readonly handlers = new Map<string, Listener>();

  handle(channel: Parameters<HistoryRecoveryIpcMainBoundary["handle"]>[0], listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: Parameters<HistoryRecoveryIpcMainBoundary["removeHandler"]>[0]): void {
    this.handlers.delete(channel);
  }

  async invoke(
    channel: string,
    sender: RendererSender,
    ...values: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("missing-handler");
    return handler({ sender }, ...values);
  }
}

class FakeSender implements RendererSender {
  readonly listeners = new Map<string, Set<Listener>>();
  destroyed = false;

  send(): void {}

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

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

class FakeWindow implements BrowserWindowBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly webContents: RendererSender;

  constructor(webContents: RendererSender) {
    this.webContents = webContents;
  }

  on(event: "closed", listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: "closed", listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "closed"): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

class FakeRecoverySource implements HistoricalRecoveryLibrary {
  readonly executeOwners: object[] = [];
  readonly closeOwners: Array<object | undefined> = [];
  executeResult: HistoryRecoveryExecutionResult = snapshotResult("request-default");
  deferred:
    | {
        readonly promise: Promise<HistoryRecoveryExecutionResult>;
        readonly resolve: (value: HistoryRecoveryExecutionResult) => void;
      }
    | undefined;

  prepareLaunch() {
    return Promise.resolve({ status: "ready" as const, sourceCount: 0, captureAttempts: 0 });
  }

  execute(owner: object): Promise<HistoryRecoveryExecutionResult> {
    this.executeOwners.push(owner);
    return this.deferred?.promise ?? Promise.resolve(this.executeResult);
  }

  cancel(
    _owner: object,
    request: unknown,
  ): Promise<HistoryRecoveryCancelResult> {
    const value = request as { requestKey: string; operationKey: string };
    return Promise.resolve({
      version: 1,
      kind: "cancel",
      requestKey: value.requestKey,
      operationKey: value.operationKey,
      status: "unknown-request",
    });
  }

  close(owner?: object): Promise<void> {
    this.closeOwners.push(owner);
    return Promise.resolve();
  }

  defer(): void {
    let resolve!: (value: HistoryRecoveryExecutionResult) => void;
    const promise = new Promise<HistoryRecoveryExecutionResult>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.deferred = { promise, resolve };
  }
}

test("IPC installs exactly four one-argument handlers and derives ownership from the sender", async () => {
  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeRecoverySource();
  const binding = installHistoryRecoveryIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source,
  });
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
    WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
    WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
  ].sort());

  source.executeResult = snapshotResult("request-1");
  const result = await ipcMain.invoke(
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    sender,
    { version: 1, requestKey: "request-1" },
  ) as HistoryRecoverySnapshotResult;
  assert.equal(result.status, "ready");
  assert.equal(source.executeOwners.length, 1);

  const extraArgument = await ipcMain.invoke(
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    sender,
    { version: 1, requestKey: "request-extra" },
    "extra",
  ) as HistoryRecoverySnapshotResult;
  assert.equal(extraArgument.status, "unavailable");
  assert.equal(source.executeOwners.length, 1);

  const foreign = await ipcMain.invoke(
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    new FakeSender(),
    { version: 1, requestKey: "request-foreign" },
  ) as HistoryRecoverySnapshotResult;
  assert.equal(foreign.status, "unavailable");
  assert.equal(source.executeOwners.length, 1);

  await binding.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  assert.equal(source.closeOwners.length, 1);
});

test("reload rotates document ownership and converts every late result to bridge-closed", async () => {
  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeRecoverySource();
  const binding = installHistoryRecoveryIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source,
  });
  source.defer();
  const pending = ipcMain.invoke(
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    sender,
    { version: 1, requestKey: "request-before-reload" },
  ) as Promise<HistoryRecoverySnapshotResult>;
  assert.equal(source.executeOwners.length, 1);
  const firstOwner = source.executeOwners[0]!;

  sender.emit("did-start-loading");
  await Promise.resolve();
  assert.equal(source.closeOwners.includes(firstOwner), true);
  source.deferred!.resolve(snapshotResult("request-before-reload"));
  const late = await pending;
  assert.equal(late.status, "unavailable");
  assert.equal(
    late.status === "unavailable" && late.problem.code,
    "bridge-closed",
  );

  source.deferred = undefined;
  source.executeResult = snapshotResult("request-after-reload");
  const replacement = await ipcMain.invoke(
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    sender,
    { version: 1, requestKey: "request-after-reload" },
  ) as HistoryRecoverySnapshotResult;
  assert.equal(replacement.status, "ready");
  assert.notEqual(source.executeOwners[1], firstOwner);
  await binding.dispose();
});

test("sender destruction disposes handlers and closes the current owner once", async () => {
  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeRecoverySource();
  installHistoryRecoveryIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source,
  });
  sender.destroyed = true;
  sender.emit("render-process-gone");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ipcMain.handlers.size, 0);
  assert.equal(source.closeOwners.length, 1);
});

function snapshotResult(requestKey: string): HistoryRecoverySnapshotResult {
  return Object.freeze({
    version: 1,
    kind: "snapshot",
    requestKey,
    status: "ready",
    snapshot: Object.freeze({
      snapshotKey: "snapshot-1",
      attention: false,
      library: Object.freeze({
        libraryKey: "library-1",
        label: "Historical Recovery Library",
        generationCount: 0,
      }),
      sources: Object.freeze([]),
    }),
  });
}
