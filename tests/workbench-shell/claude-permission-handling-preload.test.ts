import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  publicClaudePermissionHandlingUnavailable,
} from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchPreloadBridge,
  type FixedProjectViewIpc,
} from "../../src/workbench-shell/preload-bridge.ts";

type Listener = (event: unknown, value: unknown) => void;

class FakeIpc implements FixedProjectViewIpc {
  readonly calls: Array<Readonly<{ channel: string; values: unknown[] }>> = [];
  readonly responses = new Map<string, unknown>();
  readonly failures = new Set<string>();
  on(_channel: never, _listener: Listener): void {}
  removeListener(_channel: never, _listener: Listener): void {}
  send(_channel: never): void {}
  async invoke(channel: string, ...values: unknown[]): Promise<unknown> {
    this.calls.push({ channel, values });
    if (this.failures.has(channel)) throw new Error("PRIVATE_IPC_FAILURE");
    return this.responses.get(channel);
  }
}

test("preload loads and saves exact Claude permission choices through their dedicated channels", async () => {
  const ipc = new FakeIpc();
  ipc.responses.set(WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL, {
    ok: true,
    status: "loaded",
    permissionHandling: "ask-when-needed",
  });
  ipc.responses.set(WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL, {
    ok: true,
    status: "saved",
    message: "Claude permission handling was durably saved.",
  });
  const bridge = createWorkbenchPreloadBridge(ipc);

  assert.deepEqual(await bridge.loadClaudePermissionHandling(), {
    ok: true,
    status: "loaded",
    permissionHandling: "ask-when-needed",
  });
  assert.deepEqual(
    await bridge.saveClaudePermissionHandling("without-asking"),
    {
      ok: true,
      status: "saved",
      message: "Claude permission handling was durably saved.",
    },
  );
  assert.deepEqual(ipc.calls, [
    {
      channel: WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      values: [],
    },
    {
      channel: WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      values: ["without-asking"],
    },
  ]);
});

test("preload rejects unadmitted permission values before IPC and sanitizes transport drift", async () => {
  const ipc = new FakeIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const saveUnknown = bridge.saveClaudePermissionHandling as unknown as (
    value: unknown,
  ) => Promise<unknown>;
  const unavailable = publicClaudePermissionHandlingUnavailable();

  for (const value of [null, {}, "manual", "bypassPermissions", "future-mode"]) {
    assert.deepEqual(await saveUnknown(value), unavailable);
  }
  assert.deepEqual(ipc.calls, []);

  ipc.responses.set(WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL, {
    ok: true,
    status: "loaded",
    permissionHandling: "manual",
  });
  assert.deepEqual(await bridge.loadClaudePermissionHandling(), unavailable);
  ipc.failures.add(WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL);
  assert.deepEqual(
    await bridge.saveClaudePermissionHandling("ask-when-needed"),
    unavailable,
  );
});
