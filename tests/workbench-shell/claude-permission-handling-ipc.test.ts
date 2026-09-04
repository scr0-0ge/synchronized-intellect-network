import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  publicClaudePermissionHandlingUnavailable,
  type WorkbenchClaudePermissionHandling,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchClaudePermissionHandlingIpc,
  type ClaudePermissionHandlingBrowserWindowBoundary,
  type ClaudePermissionHandlingIpcMainBoundary,
  type ClaudePermissionHandlingRendererSender,
  type WorkbenchClaudePermissionHandlingSource,
} from "../../src/workbench-shell/electron/claude-permission-handling-ipc.ts";

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain implements ClaudePermissionHandlingIpcMainBoundary {
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

class FakeSender implements ClaudePermissionHandlingRendererSender {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();
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
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeWindow implements ClaudePermissionHandlingBrowserWindowBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly webContents: FakeSender;
  constructor(webContents: FakeSender) {
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
}

class FakeSource implements WorkbenchClaudePermissionHandlingSource {
  readCalls = 0;
  saveCalls = 0;
  saved: WorkbenchClaudePermissionHandling[] = [];
  readValue: unknown = "ask-when-needed";
  fail = false;
  async readClaudePermissionHandling(): Promise<WorkbenchClaudePermissionHandling> {
    this.readCalls += 1;
    if (this.fail) throw new Error("PRIVATE_READ_FAILURE");
    return this.readValue as WorkbenchClaudePermissionHandling;
  }
  async saveClaudePermissionHandling(
    value: WorkbenchClaudePermissionHandling,
  ): Promise<WorkbenchClaudePermissionHandling> {
    this.saveCalls += 1;
    this.saved.push(value);
    if (this.fail) throw new Error("PRIVATE_SAVE_FAILURE");
    return value;
  }
}

test("the owning renderer loads and saves only exact Claude permission choices", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchClaudePermissionHandlingIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      sender,
    ),
    { ok: true, status: "loaded", permissionHandling: "ask-when-needed" },
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      sender,
      "without-asking",
    ),
    {
      ok: true,
      status: "saved",
      message: "Claude permission handling was durably saved.",
    },
  );
  assert.deepEqual(source.saved, ["without-asking"]);
  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("Claude permission IPC rejects foreign, malformed, drifted, and terminal requests before persistence", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchClaudePermissionHandlingIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source,
  });
  const unavailable = publicClaudePermissionHandlingUnavailable();

  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      intruder,
    ),
    unavailable,
  );
  for (const value of [null, "manual", "bypassPermissions", "future-mode", {}]) {
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
        owner,
        value,
      ),
      unavailable,
    );
  }
  source.readValue = "manual";
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      owner,
    ),
    unavailable,
  );
  owner.emit("destroyed");
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      owner,
      "without-asking",
    ),
    unavailable,
  );
  assert.equal(source.saveCalls, 0);
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
  binding.dispose();
});
