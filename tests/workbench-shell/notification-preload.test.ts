import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL,
  WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
  createWorkbenchNotificationPreloadBridge,
  notificationActivationCommandKey,
  type WorkbenchNotificationRendererIpc,
} from "../../src/workbench-shell/notification-bridge.ts";

const rendererInstanceKey =
  "renderer-instance:00000000-0000-4000-8000-000000000040";
const request = Object.freeze({
  title: "Agent Session 01",
  body: "The Agent turn completed.",
  commandKey: "command-7",
  projectScopeEpoch: 3,
  rendererInstanceKey,
});

type Listener = (event: unknown, value: unknown) => void;

class FakeRendererIpc implements WorkbenchNotificationRendererIpc {
  readonly calls: Array<Readonly<{ channel: string; values: unknown[] }>> = [];
  readonly listeners = new Map<string, Set<Listener>>();
  response: unknown;
  failure: unknown;

  async invoke(channel: string, ...values: unknown[]): Promise<unknown> {
    this.calls.push({ channel, values });
    if (this.failure !== undefined) throw this.failure;
    return this.response;
  }

  on(channel: string, listener: Listener): void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  emit(channel: string, value: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener({}, value);
    }
  }
}

test("preload forwards one bounded, frozen request without claiming delivery", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);

  const result = await bridge.notifyTurnCompleted(request);

  assert.equal(result, undefined);
  assert.deepEqual(ipc.calls, [
    { channel: WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL, values: [request] },
  ]);
  assert.equal(Object.isFrozen(ipc.calls[0]?.values[0]), true);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), [
    "notifyTurnCompleted",
    "observeNotificationActivation",
  ]);
});

test("notification limits count Unicode code points without splitting emoji", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);
  const unicodeRequest = Object.freeze({
    title: "🧪".repeat(80),
    body: "完成",
    commandKey: "command-8",
    projectScopeEpoch: 3,
    rendererInstanceKey,
  });

  assert.equal(await bridge.notifyTurnCompleted(unicodeRequest), undefined);
  assert.deepEqual(ipc.calls[0]?.values, [unicodeRequest]);

  assert.deepEqual(
    await bridge.notifyTurnCompleted({
      title: "🧪".repeat(81),
      body: "完成",
      commandKey: "command-8",
      projectScopeEpoch: 3,
      rendererInstanceKey,
    }),
    undefined,
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
    [{ title: "legacy-title", body: "legacy-body" }],
    [{ title: "t".repeat(81), body: "body" }],
    [{ title: "title", body: "b".repeat(241) }],
    [{ ...request, commandKey: "command-0" }],
    [{ ...request, projectScopeEpoch: -1 }],
    [{ ...request, projectScopeEpoch: 1.5 }],
    [{ ...request, rendererInstanceKey: "renderer-instance:forged" }],
    [{ title: request.title, body: request.body, commandKey: "command-7" }],
    [request, "extra"],
  ]) {
    assert.equal(await notifyUnknown(...values), undefined);
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
  assert.equal(await notifyUnknown(accessorPayload), undefined);
  assert.equal(accessorReads, 0, "preload never invokes renderer-owned accessors");
  assert.deepEqual(ipc.calls, []);
});

test("preload exposes neither delivery status nor transport failures", async () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);

  ipc.response = Object.freeze({ shown: true });
  assert.equal(await bridge.notifyTurnCompleted(request), undefined);

  ipc.failure = new Error("PRIVATE_TRANSPORT_FAILURE");
  assert.equal(await bridge.notifyTurnCompleted(request), undefined);
});

test("preload forwards only exact, sanitized notification activations and disposes idempotently", () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);
  const observed: unknown[] = [];
  const dispose = bridge.observeNotificationActivation((activation) => {
    observed.push(activation);
  });

  ipc.emit(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL, {
    commandKey: "command-7",
    projectScopeEpoch: 3,
    rendererInstanceKey,
  });
  for (const malformed of [
    undefined,
    null,
    {},
    { commandKey: "command-0", projectScopeEpoch: 3, rendererInstanceKey },
    { commandKey: "command-8", projectScopeEpoch: -1, rendererInstanceKey },
    {
      commandKey: "command-8",
      projectScopeEpoch: 3,
      rendererInstanceKey: "renderer-instance:forged",
    },
    {
      commandKey: "command-8",
      projectScopeEpoch: 3,
      rendererInstanceKey,
      extra: true,
    },
  ]) {
    ipc.emit(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL, malformed);
  }

  assert.deepEqual(observed, [
    { commandKey: "command-7", projectScopeEpoch: 3, rendererInstanceKey },
  ]);
  assert.equal(Object.isFrozen(observed[0]), true);
  dispose();
  dispose();
  assert.equal(
    ipc.listeners.get(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL)?.size,
    0,
  );
  ipc.emit(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL, {
    commandKey: "command-9",
    projectScopeEpoch: 3,
    rendererInstanceKey,
  });
  assert.equal(observed.length, 1);
});

test("a throwing activation listener is retired before later clicks", () => {
  const ipc = new FakeRendererIpc();
  const bridge = createWorkbenchNotificationPreloadBridge(ipc);
  let calls = 0;
  bridge.observeNotificationActivation(() => {
    calls += 1;
    throw new Error("PRIVATE_RENDERER_LISTENER_FAILURE");
  });

  ipc.emit(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL, {
    commandKey: "command-1",
    projectScopeEpoch: 3,
    rendererInstanceKey,
  });
  ipc.emit(WORKBENCH_NOTIFICATION_ACTIVATED_CHANNEL, {
    commandKey: "command-2",
    projectScopeEpoch: 3,
    rendererInstanceKey,
  });
  assert.equal(calls, 1);
});

test("notification activation resolves only a live Session in its original renderer Project scope", () => {
  const scope = Object.freeze({
    projectScopeEpoch: 3,
    rendererInstanceKey,
    commands: Object.freeze([
      Object.freeze({
        key: "command-7",
        session: Object.freeze({ archived: false }),
      }),
      Object.freeze({ key: "command-8" }),
      Object.freeze({
        key: "command-9",
        session: Object.freeze({ archived: true }),
      }),
    ]),
  });
  const activation = Object.freeze({
    commandKey: "command-7",
    projectScopeEpoch: 3,
    rendererInstanceKey,
  });

  assert.equal(notificationActivationCommandKey(activation, scope), "command-7");
  assert.equal(
    notificationActivationCommandKey(
      { ...activation, commandKey: "command-10" },
      scope,
    ),
    undefined,
    "a removed target keeps the current selection",
  );
  assert.equal(
    notificationActivationCommandKey(
      { ...activation, commandKey: "command-8" },
      scope,
    ),
    undefined,
    "a command without a Session keeps the current selection",
  );
  assert.equal(
    notificationActivationCommandKey(
      { ...activation, commandKey: "command-9" },
      scope,
    ),
    undefined,
    "an archived Session keeps the current selection",
  );
  assert.equal(
    notificationActivationCommandKey(
      { ...activation, projectScopeEpoch: 2 },
      scope,
    ),
    undefined,
    "a notification from another Project scope cannot collide by command key",
  );
  assert.equal(
    notificationActivationCommandKey(
      {
        ...activation,
        rendererInstanceKey:
          "renderer-instance:00000000-0000-4000-8000-000000000041",
      },
      scope,
    ),
    undefined,
    "a stale activation from a prior renderer launch cannot collide after epoch reset",
  );
});
