import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL } from "../../src/workbench-shell/notification-bridge.ts";
import {
  installWorkbenchNotificationIpc as installNotificationIpcBoundary,
  type WorkbenchNotificationIpcMainBoundary,
  type WorkbenchNotificationRendererSender,
  type WorkbenchNotificationWindowBoundary,
  type WorkbenchSystemNotificationBoundary,
  type WorkbenchSystemNotificationInstance,
} from "../../src/workbench-shell/electron/notification-ipc.ts";
import { createWorkbenchLifecycleController } from "../../src/workbench-shell/electron/lifecycle.ts";

type Listener = (...values: unknown[]) => void;

const request = Object.freeze({ title: "Agent Session 01", body: "The Agent turn completed." });
const invalidRequest = Object.freeze({
  shown: false as const,
  reason: "invalid-request" as const,
});

class FakeIpcMain implements WorkbenchNotificationIpcMainBoundary {
  readonly handlers = new Map<string, Listener>();

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(
    channel: string,
    sender: FakeSender,
    ...values: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("missing-test-handler");
    return handler({ sender }, ...values);
  }
}

class FakeSender implements WorkbenchNotificationRendererSender {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
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

class FakeWindow implements WorkbenchNotificationWindowBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly webContents: FakeSender;

  focused = false;
  minimized = false;
  restoreCalls = 0;
  showCalls = 0;
  focusCalls = 0;

  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }

  isFocused(): boolean {
    return this.focused;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  restore(): void {
    this.restoreCalls += 1;
  }

  show(): void {
    this.showCalls += 1;
  }

  focus(): void {
    this.focusCalls += 1;
  }
}

class FakeToast implements WorkbenchSystemNotificationInstance {
  readonly title: string;
  readonly body: string;
  readonly listeners = new Map<string, Set<Listener>>();
  showCalls = 0;
  closeCalls = 0;
  showFailure: unknown;

  constructor(options: { readonly title: string; readonly body: string }) {
    this.title = options.title;
    this.body = options.body;
  }

  on(event: "click" | "close" | "failed", listener: Listener): FakeToast {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(
    event: "click" | "close" | "failed",
    listener: Listener,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  show(): void {
    if (this.showFailure !== undefined) throw this.showFailure;
    this.showCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
  }

  emit(event: "click" | "close" | "failed", ...values: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...values);
    }
  }
}

interface NotificationStub {
  readonly notification: WorkbenchSystemNotificationBoundary;
  readonly created: FakeToast[];
  setSupported(supported: boolean): void;
  failConstruction(failure: unknown): void;
  failSupportCheck(failure: unknown): void;
  failShow(failure: unknown): void;
}

function createNotificationStub(): NotificationStub {
  const created: FakeToast[] = [];
  let supported = true;
  let constructionFailure: unknown;
  let supportCheckFailure: unknown;
  let showFailure: unknown;
  const notification = function (this: unknown, options: {
    readonly title: string;
    readonly body: string;
  }): FakeToast {
    if (constructionFailure !== undefined) throw constructionFailure;
    const toast = new FakeToast(options);
    toast.showFailure = showFailure;
    created.push(toast);
    return toast;
  } as unknown as WorkbenchSystemNotificationBoundary;
  Object.assign(notification, {
    isSupported(): boolean {
      if (supportCheckFailure !== undefined) throw supportCheckFailure;
      return supported;
    },
  });
  return {
    notification,
    created,
    setSupported(value: boolean): void {
      supported = value;
    },
    failConstruction(failure: unknown): void {
      constructionFailure = failure;
    },
    failSupportCheck(failure: unknown): void {
      supportCheckFailure = failure;
    },
    failShow(failure: unknown): void {
      showFailure = failure;
    },
  };
}

function installWorkbenchNotificationIpc(
  options: Omit<
    Parameters<typeof installNotificationIpcBoundary>[0],
    "platform"
  > & {
    readonly platform?: NodeJS.Platform;
  },
): ReturnType<typeof installNotificationIpcBoundary> {
  return installNotificationIpcBoundary({
    ...options,
    platform: options.platform ?? "win32",
  });
}

test("an unfocused owning renderer receives exactly one OS toast per accepted request", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  assert.deepEqual([...ipc.handlers.keys()], [
    WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
  ]);
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: true },
  );
  assert.equal(stub.created.length, 1);
  const toast = stub.created[0];
  assert.deepEqual({ title: toast?.title, body: toast?.body }, request);
  assert.equal(toast?.showCalls, 1);
  assert.equal(toast?.listeners.get("click")?.size, 1);
  assert.equal(toast?.listeners.get("close")?.size, 1);
  assert.equal(toast?.listeners.get("failed")?.size, 1);

  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("a focused window suppresses the toast without poisoning later requests", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  window.focused = true;
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: false, reason: "window-focused" },
  );
  assert.equal(stub.created.length, 0);

  window.focused = false;
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: true },
  );
  binding.dispose();
});

test("foreign, destroyed, malformed, oversized, and extra-argument requests never reach the OS", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const window = new FakeWindow(owner);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, intruder, request),
    invalidRequest,
  );
  const malformedPayloads = [
    undefined,
    null,
    [],
    {},
    { title: "only-title" },
    { title: 7, body: "body" },
    { title: "title", body: null },
    { title: "   ", body: "body" },
    { title: "title", body: "  " },
    { title: "t".repeat(81), body: "body" },
    { title: "title", body: "b".repeat(241) },
    { title: "title", body: "body", extra: true },
  ];
  for (const payload of malformedPayloads) {
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
        owner,
        payload,
      ),
      invalidRequest,
    );
  }
  let accessorReads = 0;
  const accessorPayload = Object.defineProperties({}, {
    title: {
      enumerable: true,
      get(): string {
        accessorReads += 1;
        return "title";
      },
    },
    body: { enumerable: true, value: "body" },
  });
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
      owner,
      accessorPayload,
    ),
    invalidRequest,
  );
  assert.equal(accessorReads, 0, "main never invokes renderer-owned accessors");
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
      owner,
      request,
      "extra",
    ),
    invalidRequest,
  );
  owner.destroyed = true;
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, owner, request),
    invalidRequest,
  );
  assert.equal(stub.created.length, 0);
  binding.dispose();
});

test("activating the toast restores, shows, and focuses the main window", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request);
  const toast = stub.created[0];
  assert.ok(toast);

  toast.emit("click");
  assert.equal(window.restoreCalls, 0);
  assert.equal(window.showCalls, 1);
  assert.equal(window.focusCalls, 1);
  assert.equal(toast.listeners.get("click")?.size, 0);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 0);

  window.minimized = true;
  await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request);
  const minimizedToast = stub.created[1];
  assert.ok(minimizedToast);
  minimizedToast.emit("click");
  assert.equal(window.restoreCalls, 1);
  assert.equal(window.showCalls, 2);
  assert.equal(window.focusCalls, 2);
  assert.equal(minimizedToast.listeners.get("click")?.size, 0);
  assert.equal(minimizedToast.listeners.get("close")?.size, 0);
  assert.equal(minimizedToast.listeners.get("failed")?.size, 0);
  binding.dispose();
  assert.equal(toast.closeCalls, 0, "an already-closed toast is left alone");
  assert.equal(
    minimizedToast.closeCalls,
    0,
    "an already-activated minimized toast is left alone",
  );
});

test("click releases toast authority even when the OS never emits close", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: true },
  );
  const toast = stub.created[0];
  assert.ok(toast);

  toast.emit("click");
  assert.equal(toast.listeners.get("click")?.size, 0);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 0);

  binding.dispose();
  assert.equal(
    toast.closeCalls,
    0,
    "dispose cannot find a clicked toast after click released its authority",
  );
});

test("non-Windows native close releases its own toast authority", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
    platform: "linux",
  });

  await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request);
  const toast = stub.created[0];
  assert.ok(toast);

  toast.emit("close");
  assert.equal(toast.listeners.get("click")?.size, 0);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 0);

  binding.dispose();
  assert.equal(toast.closeCalls, 0, "an already-closed toast is left alone");
});

test("Windows banner close preserves one Action Center click authority", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
    platform: "win32",
  });

  await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request);
  const toast = stub.created[0];
  assert.ok(toast);

  toast.emit("close");
  assert.equal(toast.listeners.get("click")?.size, 1);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 1);

  toast.emit("click");
  assert.equal(window.showCalls, 1);
  assert.equal(window.focusCalls, 1);
  assert.equal(toast.listeners.get("click")?.size, 0);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 0);

  binding.dispose();
  assert.equal(
    toast.closeCalls,
    0,
    "an activated Action Center toast is no longer owned at teardown",
  );
});

test("asynchronous native failure releases toast authority", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: true },
  );
  const toast = stub.created[0];
  assert.ok(toast);

  toast.emit("failed", new Error("PRIVATE_ASYNC_FAILURE"));
  assert.equal(toast.listeners.get("click")?.size, 0);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 0);

  binding.dispose();
  assert.equal(toast.closeCalls, 0);
});

test("silent OS suppression remains best-effort and teardown-safe", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  // Electron exposes no delivery acknowledgement here. No native event after
  // show models the API surface when Windows silently suppresses a toast.
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: true },
  );
  const toast = stub.created[0];
  assert.ok(toast);
  assert.equal(toast.showCalls, 1);

  binding.dispose();
  assert.equal(toast.closeCalls, 1);
  assert.equal(toast.listeners.get("click")?.size, 0);
  assert.equal(toast.listeners.get("close")?.size, 0);
  assert.equal(toast.listeners.get("failed")?.size, 0);
});

test("platforms without notification support degrade silently instead of rejecting", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });

  stub.setSupported(false);
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: false, reason: "notifications-unavailable" },
  );

  stub.setSupported(true);
  stub.failSupportCheck(new Error("PRIVATE_SUPPORT_CHECK_FAILURE"));
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: false, reason: "notifications-unavailable" },
  );

  stub.failSupportCheck(undefined);
  stub.failConstruction(new Error("PRIVATE_CONSTRUCTION_FAILURE"));
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: false, reason: "notifications-unavailable" },
  );

  stub.failConstruction(undefined);
  stub.failShow(new Error("PRIVATE_SHOW_FAILURE"));
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
    { shown: false, reason: "notifications-unavailable" },
  );

  assert.equal(stub.created.length, 1);
  assert.equal(stub.created[0]?.closeCalls, 1);
  assert.equal(stub.created[0]?.listeners.get("click")?.size, 0);
  assert.equal(stub.created[0]?.listeners.get("close")?.size, 0);
  assert.equal(stub.created[0]?.listeners.get("failed")?.size, 0);
  assert.equal(
    JSON.stringify(invalidRequest).includes("PRIVATE_"),
    false,
  );
  binding.dispose();
});

test("renderer or window termination closes toast authority and dispose is idempotent", async () => {
  for (const terminalEvent of [
    "render-process-gone",
    "destroyed",
    "closed",
  ] as const) {
    const ipc = new FakeIpcMain();
    const sender = new FakeSender();
    const window = new FakeWindow(sender);
    const stub = createNotificationStub();
    const binding = installWorkbenchNotificationIpc({
      ipcMain: ipc,
      window,
      notification: stub.notification,
    });

    assert.deepEqual(
      await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
      { shown: true },
    );
    if (terminalEvent === "closed") window.emit(terminalEvent);
    else sender.emit(terminalEvent);
    assert.equal(
      stub.created[0]?.closeCalls,
      1,
      `${terminalEvent} immediately closes its owned toast`,
    );
    assert.equal(
      [...(stub.created[0]?.listeners.values() ?? [])].every(
        (listeners) => listeners.size === 0,
      ),
      true,
    );
    assert.deepEqual(
      await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request),
      { shown: false, reason: "bridge-closed" },
    );

    binding.dispose();
    binding.dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.equal(
      [...sender.listeners.values()].every((listeners) => listeners.size === 0),
      true,
    );
    assert.equal(
      [...window.listeners.values()].every((listeners) => listeners.size === 0),
      true,
    );
    assert.equal(stub.created[0]?.closeCalls, 1, "dispose stays idempotent");
  }
});

test("application quit closes toast authority before backend drain and exit", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const window = new FakeWindow(sender);
  const stub = createNotificationStub();
  const binding = installWorkbenchNotificationIpc({
    ipcMain: ipc,
    window,
    notification: stub.notification,
  });
  await ipc.invoke(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, sender, request);
  const toast = stub.created[0];
  assert.ok(toast);

  let releaseBackend!: () => void;
  const backendClosed = new Promise<void>((resolve) => {
    releaseBackend = resolve;
  });
  let exitCalls = 0;
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "idle",
    isTrayReady: () => true,
    hideWindow() {},
    disposeProjectView: binding.dispose,
    closeBackend: () => backendClosed,
    exit() {
      exitCalls += 1;
    },
  });

  lifecycle.handleBeforeQuit({ preventDefault() {} });
  assert.equal(toast.closeCalls, 1);
  assert.equal(ipc.handlers.size, 0);
  assert.equal(exitCalls, 0, "backend drain still gates process exit");

  releaseBackend();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(exitCalls, 1);
});

test("main.ts wires exactly one notification binding and tears it down on every shutdown path", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.equal(
    source.split("installWorkbenchNotificationIpc({").length - 1,
    1,
  );
  assert.match(
    source,
    /notificationIpc = installWorkbenchNotificationIpc\(\{\s*ipcMain,\s*window: createdWindow,\s*notification: Notification,\s*platform: process\.platform,\s*\}\);/u,
  );
  assert.match(
    source,
    /function disposeNotificationIpcBinding\(\): void \{\s*notificationIpc\?\.dispose\(\);\s*notificationIpc = null;\s*\}/u,
  );
  assert.equal(
    source.split("disposeNotificationIpcBinding();").length - 1,
    4,
    "lifecycle shutdown, window close, and both startup-failure exits dispose the binding",
  );
  assert.match(
    source,
    /if \(failureWindow === null\) \{[\s\S]*?disposeNotificationIpcBinding\(\);\s*app\.exit\(1\);\s*return;/u,
  );
  assert.match(
    source,
    /const exitAfterFailure = \(\): void => \{\s*disposeNotificationIpcBinding\(\);\s*app\.exit\(1\);\s*\};/u,
  );
  assert.doesNotMatch(
    source,
    /Notification\.\w+\(/u,
    "main.ts only hands the Notification constructor to the boundary",
  );
});
