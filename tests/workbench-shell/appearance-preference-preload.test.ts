import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
  WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
} from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchPreloadBridge,
  type FixedProjectViewIpc,
} from "../../src/workbench-shell/preload-bridge.ts";

type Listener = (event: unknown, value: unknown) => void;

const appearance = Object.freeze({
  tone: "light" as const,
  crt: "blocks" as const,
  phosphor: "green" as const,
  phosphorTier: "c" as const,
  language: "zh-CN" as const,
});
const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "appearance-preference-unavailable" as const,
    message:
      "Appearance preferences could not be loaded or saved. Keep the current appearance and try again." as const,
  }),
});

class FakeIpc implements FixedProjectViewIpc {
  readonly calls: Array<Readonly<{ channel: string; values: unknown[] }>> = [];
  readonly responses = new Map<string, unknown>();
  readonly failures = new Map<string, unknown>();

  on(_channel: never, _listener: Listener): void {}
  removeListener(_channel: never, _listener: Listener): void {}
  send(_channel: never): void {}

  async invoke(channel: string, ...values: unknown[]): Promise<unknown> {
    this.calls.push({ channel, values });
    if (this.failures.has(channel)) throw this.failures.get(channel);
    return this.responses.get(channel);
  }
}

test("preload loads one sanitized appearance without exposing a native document", async () => {
  const ipc = new FakeIpc();
  ipc.responses.set(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, {
    ok: true,
    status: "loaded",
    appearance,
  });
  const bridge = createWorkbenchPreloadBridge(ipc);

  const result = await bridge.loadAppearancePreference();

  assert.deepEqual(result, { ok: true, status: "loaded", appearance });
  assert.notEqual(result.ok && result.appearance, appearance);
  assert.deepEqual(ipc.calls, [
    { channel: WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, values: [] },
  ]);
  assert.equal("schemaVersion" in result, false);
  assert.equal(Object.isFrozen(bridge), true);
});

test("preload reconstructs an exact appearance before one save invoke and sanitizes the receipt", async () => {
  const ipc = new FakeIpc();
  ipc.responses.set(WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL, {
    ok: true,
    status: "saved",
    message: "Appearance preference was durably saved.",
  });
  const bridge = createWorkbenchPreloadBridge(ipc);

  const result = await bridge.saveAppearancePreference(appearance);

  assert.deepEqual(result, {
    ok: true,
    status: "saved",
    message: "Appearance preference was durably saved.",
  });
  assert.deepEqual(ipc.calls, [
    {
      channel: WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
      values: [appearance],
    },
  ]);
  assert.notEqual(ipc.calls[0]?.values[0], appearance);
  assert.equal(Object.isFrozen(ipc.calls[0]?.values[0]), true);
});

test("preload rejects malformed appearance before transport and fails closed on invoke or result drift", async () => {
  const ipc = new FakeIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const saveUnknown = bridge.saveAppearancePreference as unknown as (
    value: unknown,
  ) => Promise<unknown>;

  for (const value of [
    null,
    [],
    { ...appearance, extra: true },
    { tone: "light", crt: "blocks" },
    { tone: "light", crt: "blocks", phosphor: "green" },
    { ...appearance, phosphorTier: "d" },
    { ...appearance, language: "fr" },
  ]) {
    assert.deepEqual(await saveUnknown(value), unavailable);
  }
  assert.deepEqual(ipc.calls, []);

  ipc.responses.set(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, {
    ok: true,
    status: "loaded",
    appearance,
    rawDocument: { schemaVersion: 1 },
  });
  assert.deepEqual(await bridge.loadAppearancePreference(), unavailable);

  ipc.responses.set(WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL, {
    ok: true,
    status: "saved",
    message: "saved",
  });
  assert.deepEqual(
    await bridge.saveAppearancePreference(appearance),
    unavailable,
  );

  ipc.failures.set(
    WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
    new Error("PRIVATE_LOAD_FAILURE"),
  );
  ipc.failures.set(
    WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
    new Error("PRIVATE_SAVE_FAILURE"),
  );
  assert.deepEqual(await bridge.loadAppearancePreference(), unavailable);
  assert.deepEqual(
    await bridge.saveAppearancePreference(appearance),
    unavailable,
  );
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
});
