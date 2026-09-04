import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
  createWorkbenchNotificationPreloadBridge,
  type WorkbenchNotificationRendererIpc,
} from "../../src/workbench-shell/notification-bridge.ts";

const request = Object.freeze({ title: "Agent Session 01", body: "The Agent turn completed." });
const unavailable = Object.freeze({
  shown: false as const,
  reason: "notifications-unavailable" as const,
});

class FakeRendererIpc implements WorkbenchNotificationRendererIpc {
  readonly calls: Array<Readonly<{ channel: string; values: unknown[] }>> = [];
  response: unknown = { shown: true };
  failure: unknown;

  async invoke(channel: string, ...values: unknown[]): Promise<unknown> {
    this.calls.push({ channel, values });
    if (this.failure !== undefined) throw this.failure;
    return this.response;
  }
}

test("preload forwards one bounded, frozen request through the fixed notification channel", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);

  const result = await bridge.notifyTurnCompleted(request);

  assert.deepEqual(result, { shown: true });
  assert.deepEqual(ipc.calls, [
    { channel: WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, values: [request] },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), ["notifyTurnCompleted"]);
});

test("notification limits count Unicode code points without splitting emoji", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);
  const unicodeRequest = Object.freeze({
    title: "🧪".repeat(80),
    body: "完成",
  });

  assert.deepEqual(await bridge.notifyTurnCompleted(unicodeRequest), {
    shown: true,
  });
  assert.deepEqual(ipc.calls[0]?.values, [unicodeRequest]);

  assert.deepEqual(
    await bridge.notifyTurnCompleted({
      title: "🧪".repeat(81),
      body: "完成",
    }),
    { shown: false, reason: "invalid-request" },
  );
  assert.equal(ipc.calls.length, 1);
});

test("preload fails closed before transport for malformed or extra arguments", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);
  const notifyUnknown = bridge.notifyTurnCompleted as unknown as (
    ...values: unknown[]
  ) => Promise<unknown>;

  for (const values of [
    [],
    [null],
    [[]],
    [{}],
    [{ title: "title" }],
    [{ title: "t".repeat(81), body: "body" }],
    [{ title: "title", body: "b".repeat(241) }],
    [request, "extra"],
  ]) {
    assert.deepEqual(await notifyUnknown(...values), {
      shown: false,
      reason: "invalid-request",
    });
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
  assert.deepEqual(await notifyUnknown(accessorPayload), {
    shown: false,
    reason: "invalid-request",
  });
  assert.equal(accessorReads, 0, "preload never invokes renderer-owned accessors");
  assert.deepEqual(ipc.calls, []);
});

test("preload maps result-shape drift and transport failures to one fixed silent failure", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);

  for (const response of [
    null,
    "shown",
    { shown: true, extra: true },
    Object.defineProperty(
      { shown: true },
      Symbol("unadmitted-result-key"),
      { enumerable: true, value: true },
    ),
    { shown: false },
    { shown: false, reason: "weird-reason" },
    { shown: true, reason: "window-focused" },
  ]) {
    ipc.response = response;
    assert.deepEqual(await bridge.notifyTurnCompleted(request), unavailable);
  }

  const accessorResponse = Object.defineProperty(
    {},
    "shown",
    {
      enumerable: true,
      get(): boolean {
        throw new Error("PRIVATE_ACCESSOR_FAILURE");
      },
    },
  );
  ipc.response = accessorResponse;
  assert.deepEqual(await bridge.notifyTurnCompleted(request), unavailable);

  ipc.failure = new Error("PRIVATE_TRANSPORT_FAILURE");
  assert.deepEqual(await bridge.notifyTurnCompleted(request), unavailable);
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
});

test("preload preserves every legitimate main-process skip reason verbatim", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);

  for (const reason of [
    "window-focused",
    "notifications-unavailable",
    "invalid-request",
    "bridge-closed",
  ] as const) {
    ipc.response = Object.freeze({ shown: false, reason });
    assert.deepEqual(await bridge.notifyTurnCompleted(request), {
      shown: false,
      reason,
    });
  }
});
