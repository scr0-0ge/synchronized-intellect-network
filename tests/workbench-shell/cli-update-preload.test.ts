import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_CHECK_CLI_UPDATES_CHANNEL,
  WORKBENCH_RUN_CLI_UPDATE_CHANNEL,
  publicCliUpdateCheckCompleted,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRunFailed,
  publicCliUpdateRunUnavailable,
  publicCliUpdateRunUpdated,
} from "../../src/workbench-shell/cli-update-contract.ts";
import {
  createWorkbenchPreloadBridge,
  type FixedProjectViewIpc,
} from "../../src/workbench-shell/preload-bridge.ts";

/**
 * Ticket 18 preload slice: the bridge exposes the CLI update methods over
 * the exact channels, sanitizes every result, fails closed on transport
 * errors, and rejects a foreign cliId before invoking anything.
 */

class FakeProjectViewIpc implements FixedProjectViewIpc {
  readonly invocations: Array<{ channel: string; values: readonly unknown[] }> =
    [];
  invokeResult: unknown = undefined;
  invokeThrows = false;

  on(): void {}
  removeListener(): void {}
  send(): void {}
  invoke(
    channel: string,
    ...values: unknown[]
  ): Promise<unknown> {
    this.invocations.push(Object.freeze({ channel, values: Object.freeze(values) }));
    if (this.invokeThrows) return Promise.reject(new Error("bridge-closed"));
    return Promise.resolve(this.invokeResult);
  }
}

const claudeUpdateAvailable = Object.freeze({
  cliId: "claude-code" as const,
  status: "update-available" as const,
  currentVersion: "2.1.220",
  availableVersion: "2.1.258",
});
const codexNoCheck = Object.freeze({
  cliId: "codex" as const,
  status: "no-check" as const,
});

test("checkCliUpdates invokes the check channel once and sanitizes the report", async () => {
  const ipc = new FakeProjectViewIpc();
  ipc.invokeResult = publicCliUpdateCheckCompleted([
    claudeUpdateAvailable,
    codexNoCheck,
  ]);
  const bridge = createWorkbenchPreloadBridge(ipc);
  const result = await bridge.checkCliUpdates();
  assert.deepEqual(
    result,
    publicCliUpdateCheckCompleted([claudeUpdateAvailable, codexNoCheck]),
  );
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_CHECK_CLI_UPDATES_CHANNEL, values: [] },
  ]);
  // A hostile main-side answer fails closed to the fixed unavailable result.
  ipc.invokeResult = { ok: true, status: "checked", reports: "nope" };
  assert.deepEqual(
    await bridge.checkCliUpdates(),
    publicCliUpdateCheckUnavailable(),
  );
  // So does a closed transport.
  ipc.invokeThrows = true;
  assert.deepEqual(
    await bridge.checkCliUpdates(),
    publicCliUpdateCheckUnavailable(),
  );
});

test("runCliUpdate sends the bare validated cliId and sanitizes every outcome", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);

  ipc.invokeResult = publicCliUpdateRunUpdated("codex");
  assert.deepEqual(
    await bridge.runCliUpdate("codex"),
    publicCliUpdateRunUpdated("codex"),
  );
  assert.deepEqual(ipc.invocations.at(-1), {
    channel: WORKBENCH_RUN_CLI_UPDATE_CHANNEL,
    values: ["codex"],
  });

  // A success for a different cliId is rejected by the sanitizer.
  ipc.invokeResult = publicCliUpdateRunUpdated("claude-code");
  assert.deepEqual(
    await bridge.runCliUpdate("codex"),
    publicCliUpdateRunUnavailable(),
  );

  for (const reason of [
    "timeout",
    "launch-failed",
    "update-failed",
    "unsupported-install",
  ] as const) {
    ipc.invokeResult = publicCliUpdateRunFailed(reason);
    assert.deepEqual(
      await bridge.runCliUpdate("claude-code"),
      publicCliUpdateRunFailed(reason),
    );
  }

  // A hostile payload and a closed transport both fail closed.
  ipc.invokeResult = { ok: false, error: { category: "weird" } };
  assert.deepEqual(
    await bridge.runCliUpdate("claude-code"),
    publicCliUpdateRunUnavailable(),
  );
  ipc.invokeThrows = true;
  assert.deepEqual(
    await bridge.runCliUpdate("codex"),
    publicCliUpdateRunUnavailable(),
  );
});

test("runCliUpdate validates the cliId before touching the channel", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  assert.deepEqual(
    await bridge.runCliUpdate("glm-coding-plan" as "codex"),
    publicCliUpdateRunUnavailable(),
  );
  assert.deepEqual(ipc.invocations, []);
});
