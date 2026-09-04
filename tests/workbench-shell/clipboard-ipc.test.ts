import assert from "node:assert/strict";
import test from "node:test";

import { WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL } from "../../src/workbench-shell/clipboard-bridge.ts";
import {
  installWorkbenchClipboardIpc,
  type WorkbenchClipboardBrowserWindowBoundary,
  type WorkbenchClipboardIpcMainBoundary,
  type WorkbenchClipboardRendererSender,
  type WorkbenchSystemClipboardBoundary,
} from "../../src/workbench-shell/electron/clipboard-ipc.ts";

type Listener = (...values: unknown[]) => unknown;

const exactCode =
  '  const greeting = "hello";\n\tconsole.log(greeting);\n\nreturn greeting;  ';
const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "clipboard-write-unavailable" as const,
    message: "The system clipboard refused the copy request." as const,
  }),
});

class FakeIpcMain implements WorkbenchClipboardIpcMainBoundary {
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

class FakeSender implements WorkbenchClipboardRendererSender {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: "render-process-gone" | "destroyed", listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(
    event: "render-process-gone" | "destroyed",
    listener: Listener,
  ): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "render-process-gone" | "destroyed"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeWindow implements WorkbenchClipboardBrowserWindowBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly webContents: FakeSender;

  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }

  on(event: "closed", listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: "closed", listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "closed"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeClipboard implements WorkbenchSystemClipboardBoundary {
  readonly writes: string[] = [];
  value = "";
  writeFailure: unknown;
  readFailure: unknown;
  readOverride: string | undefined;

  writeText(text: string): void {
    this.writes.push(text);
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.value = text;
  }

  readText(): string {
    if (this.readFailure !== undefined) throw this.readFailure;
    return this.readOverride ?? this.value;
  }
}

test("the owning renderer writes and verifies the exact code string through the system clipboard", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const clipboard = new FakeClipboard();
  const binding = installWorkbenchClipboardIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    clipboard,
  });

  assert.deepEqual([...ipc.handlers.keys()], [
    WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
  ]);
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, sender, exactCode),
    { ok: true, status: "copied" },
  );
  assert.deepEqual(clipboard.writes, [exactCode]);
  assert.equal(clipboard.value, exactCode);

  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("clipboard IPC rejects foreign, destroyed, non-string, and extra-argument requests before writing", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const clipboard = new FakeClipboard();
  const binding = installWorkbenchClipboardIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    clipboard,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, intruder, exactCode),
    unavailable,
  );
  for (const values of [[null], [[]], [{}], [exactCode, "extra"]]) {
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
        owner,
        ...values,
      ),
      unavailable,
    );
  }
  owner.destroyed = true;
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, owner, exactCode),
    unavailable,
  );
  assert.deepEqual(clipboard.writes, []);
  binding.dispose();
});

test("clipboard IPC reports failure when the OS throws or readback is not byte-exact", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const clipboard = new FakeClipboard();
  const binding = installWorkbenchClipboardIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    clipboard,
  });

  clipboard.writeFailure = new Error("PRIVATE_CLIPBOARD_WRITE_FAILURE");
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, sender, exactCode),
    unavailable,
  );
  clipboard.writeFailure = undefined;
  clipboard.readOverride = exactCode.replaceAll("\n", "\r\n");
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, sender, exactCode),
    unavailable,
  );
  clipboard.readOverride = undefined;
  clipboard.readFailure = new Error("PRIVATE_CLIPBOARD_READ_FAILURE");
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, sender, exactCode),
    unavailable,
  );
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
  binding.dispose();
});

test("renderer or window termination closes clipboard authority and dispose is idempotent", async () => {
  for (const terminalEvent of [
    "render-process-gone",
    "destroyed",
    "closed",
  ] as const) {
    const ipc = new FakeIpcMain();
    const sender = new FakeSender();
    const window = new FakeWindow(sender);
    const clipboard = new FakeClipboard();
    const binding = installWorkbenchClipboardIpc({
      ipcMain: ipc,
      window,
      clipboard,
    });

    if (terminalEvent === "closed") window.emit(terminalEvent);
    else sender.emit(terminalEvent);
    assert.deepEqual(
      await ipc.invoke(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, sender, exactCode),
      unavailable,
    );
    assert.deepEqual(clipboard.writes, []);

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
  }
});
