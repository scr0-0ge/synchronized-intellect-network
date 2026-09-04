import assert from "node:assert/strict";
import test from "node:test";

import type {
  SubscriptionAuthenticationResult,
  SubscriptionAuthenticationSnapshot,
} from "../../src/agent-runtime/subscription-authentication.ts";
import {
  WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchSubscriptionAuthenticationActionIpc,
  installWorkbenchSubscriptionAuthenticationIpc,
  type SubscriptionAuthenticationBrowserWindowBoundary,
  type SubscriptionAuthenticationIpcMainBoundary,
  type SubscriptionAuthenticationRendererSender,
  type WorkbenchSubscriptionAuthenticationSource,
} from "../../src/workbench-shell/electron/subscription-authentication-ipc.ts";
import {
  WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS,
  createWorkbenchSubscriptionAuthenticationCoordinator,
} from "../../src/workbench-shell/subscription-authentication-coordinator.ts";

type Listener = (...values: unknown[]) => unknown;

const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "subscription-authentication-unavailable" as const,
    message:
      "Subscription authentication is unavailable. Keep the current status and try again." as const,
  }),
});

test("owning renderer receives only closed inspect, bind, and cancel results", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchSubscriptionAuthenticationIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });
  const request = Object.freeze({ endpointId: "claude-code-desktop" as const });

  assert.deepEqual([...ipc.handlers.keys()].sort(), [
    WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  ]);
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      sender,
      request,
    ),
    {
      ok: true,
      endpointId: "claude-code-desktop",
      authentication: "unbound",
    },
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      sender,
      request,
    ),
    {
      ok: true,
      endpointId: "claude-code-desktop",
      effect: "finished",
      authentication: "bound",
    },
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      sender,
      request,
    ),
    {
      ok: true,
      endpointId: "claude-code-desktop",
      effect: "cancelled",
      authentication: "bound",
    },
  );
  assert.deepEqual(source.calls, [
    ["inspect", "claude-code-desktop"],
    ["bind", "claude-code-desktop"],
    ["cancel", "claude-code-desktop"],
  ]);
  await binding.dispose();
  assert.equal(source.closeCalls, 1);
  assert.equal(ipc.handlers.size, 0);
});

test("duplicate owning inspections coalesce without weakening effect exclusion", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchSubscriptionAuthenticationIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source,
  });
  const request = Object.freeze({ endpointId: "codex-desktop" as const });
  const pending = deferred<SubscriptionAuthenticationSnapshot>();
  source.inspectValue = pending.promise;

  const first = ipc.invoke(
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    owner,
    request,
  );
  await tick();
  const second = ipc.invoke(
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    owner,
    request,
  );
  await tick();

  assert.deepEqual(source.calls, [["inspect", "codex-desktop"]]);
  pending.resolve({ endpointId: "codex-desktop", authentication: "bound" });
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, endpointId: "codex-desktop", authentication: "bound" },
    { ok: true, endpointId: "codex-desktop", authentication: "bound" },
  ]);
  await binding.dispose();
});

test("malformed, extra, destroyed, accessor, Proxy, foreign, duplicate, and thrown IPC fail before another effect", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchSubscriptionAuthenticationIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source,
  });
  const request = Object.freeze({ endpointId: "codex-desktop" as const });
  const bindHandler = ipc.handlers.get(
    WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  );
  assert.ok(bindHandler);

  for (const attempt of [
    () => ipc.invoke(WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL, intruder, request),
    () => ipc.invoke(WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL, owner, request, "extra"),
    () => ipc.invoke(WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL, owner, { ...request, args: ["--bare"] }),
    () => bindHandler(Object.defineProperty({}, "sender", { enumerable: true, get: () => owner }), request),
    () => bindHandler(new Proxy({ sender: owner }, {}), request),
  ]) {
    assert.deepEqual(await attempt(), unavailable);
  }
  assert.deepEqual(source.calls, []);

  const pending = deferred<SubscriptionAuthenticationResult>();
  source.bindValue = pending.promise;
  const first = ipc.invoke(
    WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    owner,
    request,
  );
  await tick();
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      request,
    ),
    unavailable,
  );
  assert.deepEqual(source.calls, [["bind", "codex-desktop"]]);
  pending.resolve({
    endpointId: "codex-desktop",
    effect: "finished",
    authentication: "bound",
  });
  await first;

  source.failure = new Error("PRIVATE_NATIVE_PATH_OR_ACCOUNT");
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      request,
    ),
    unavailable,
  );
  owner.destroyed = true;
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      request,
    ),
    unavailable,
  );
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
  await binding.dispose();
});

test("renderer and window terminal lifecycle close the source once and block later effects", async () => {
  for (const event of ["render-process-gone", "destroyed", "closed"] as const) {
    const ipc = new FakeIpcMain();
    const sender = new FakeSender();
    const window = new FakeWindow(sender);
    const source = new FakeSource();
    const binding = installWorkbenchSubscriptionAuthenticationIpc({
      ipcMain: ipc,
      window,
      source,
    });

    if (event === "closed") window.emit(event);
    else sender.emit(event);
    await tick();
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        sender,
        { endpointId: "codex-desktop" },
      ),
      unavailable,
    );
    assert.deepEqual(source.calls, []);
    assert.equal(source.closeCalls, 1);
    await binding.dispose();
    await binding.dispose();
    assert.equal(source.closeCalls, 1);
  }
});

test("D20 action IPC authorizes only its renderer and composes inspect, prepare, begin, and cancel through opaque keys", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const endpointSelectionKey =
    WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex;
  const preparationKey = "opaque-preparation-ipc-01";
  const calls: string[] = [];
  const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
    endpoints: [
      {
        endpointSelectionKey,
        endpointId: "codex-desktop",
        label: "Codex",
      },
      {
        endpointSelectionKey:
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
        endpointId: "claude-code-desktop",
        label: "Claude",
      },
    ],
    authentication: {
      async inspect(endpointId) {
        if (endpointId === "codex-desktop") calls.push("inspect:codex");
        return {
          endpointId,
          authentication: endpointId === "codex-desktop" ? "bound" : "unknown",
        };
      },
      async startAction(endpointId, action) {
        calls.push(`launch:${action}`);
        return {
          endpointId,
          action,
          request: "started",
          completion: new Promise(() => undefined),
        };
      },
      async close() {},
    },
    mutations: {
      prepare(request) {
        calls.push(`prepare:${request.action}`);
        return { kind: "ready", preparationKey };
      },
      begin(request) {
        calls.push(`begin:${request.preparationKey}`);
        return {
          kind: "begun",
          endpointSelectionKey,
          action: "logout",
        };
      },
      cancel(request) {
        calls.push(`cancel:${request.preparationKey}`);
        return true;
      },
    },
  });
  const binding = installWorkbenchSubscriptionAuthenticationActionIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source: coordinator,
  });
  const inspect = { endpointSelectionKey };
  const prepare = { endpointSelectionKey, action: "logout" as const };

  assert.deepEqual([...ipc.handlers.keys()].sort(), [
    WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  ]);
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      inspect,
    ),
    { kind: "authentication-state", state: "bound" },
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      prepare,
    ),
    { kind: "ready", preparationKey },
  );
  await assert.rejects(
    ipc.invoke(
      WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      prepare,
    ),
    /boundary-rejected/u,
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      { preparationKey },
    ),
    { kind: "authentication-action-requested", action: "logout" },
  );
  assert.deepEqual(calls, [
    "inspect:codex",
    "prepare:logout",
    "launch:logout",
    `begin:${preparationKey}`,
  ]);

  await assert.rejects(
    ipc.invoke(
      WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      intruder,
      inspect,
    ),
    /boundary-rejected/u,
  );
  await assert.rejects(
    ipc.invoke(
      WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      owner,
      { ...prepare, endpointId: "codex-desktop" },
    ),
    /boundary-rejected/u,
  );
  assert.equal(calls.length, 4);
  await binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("begin-time all-Project blocker drift stays exact for both provider cards and consumes the preparation without launch", async () => {
  const blockers = Object.freeze({
    accepted: 1,
    starting: 2,
    inFlight: 3,
    recoveryRequired: 4,
    unknown: 5,
  });
  for (const providerCase of [
    Object.freeze({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
      state: "bound" as const,
      action: "logout" as const,
      label: "Codex" as const,
      blockedStatement: "Log out is blocked.",
    }),
    Object.freeze({
      endpointSelectionKey:
        WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
      state: "sign-in-required" as const,
      action: "login" as const,
      label: "Claude" as const,
      blockedStatement: "Login is blocked.",
    }),
  ]) {
    const ipc = new FakeIpcMain();
    const owner = new FakeSender();
    const preparationKey = `opaque-begin-drift-${providerCase.action}`;
    let launches = 0;
    const coordinator = createWorkbenchSubscriptionAuthenticationCoordinator({
      endpoints: [
        {
          endpointSelectionKey:
            WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
          endpointId: "codex-desktop",
          label: "Codex",
        },
        {
          endpointSelectionKey:
            WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
          endpointId: "claude-code-desktop",
          label: "Claude",
        },
      ],
      authentication: {
        async inspect(endpointId) {
          const matches =
            (providerCase.label === "Codex" && endpointId === "codex-desktop") ||
            (providerCase.label === "Claude" &&
              endpointId === "claude-code-desktop");
          return {
            endpointId,
            authentication:
              !matches
                ? "unknown"
                : providerCase.state === "sign-in-required"
                  ? "unbound"
                  : "bound",
          };
        },
        async startAction(endpointId, action) {
          launches += 1;
          return {
            endpointId,
            action,
            request: "started",
            completion: Promise.resolve({
              endpointId,
              action,
              effect: "finished",
              request: "started",
              authentication: "unknown",
            }),
          };
        },
        async close() {},
      },
      mutations: {
        prepare() {
          return { kind: "ready", preparationKey };
        },
        authorize() {
          return { kind: "blocked", blockers };
        },
        begin() {
          return { kind: "blocked", blockers };
        },
        cancel() {
          return false;
        },
      },
    });
    const binding = installWorkbenchSubscriptionAuthenticationActionIpc({
      ipcMain: ipc,
      window: new FakeWindow(owner),
      source: coordinator,
    });

    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        owner,
        { endpointSelectionKey: providerCase.endpointSelectionKey },
      ),
      { kind: "authentication-state", state: providerCase.state },
    );
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        owner,
        {
          endpointSelectionKey: providerCase.endpointSelectionKey,
          action: providerCase.action,
        },
      ),
      { kind: "ready", preparationKey },
    );
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        owner,
        { preparationKey },
      ),
      { kind: "blocked", blockers },
    );
    const card = coordinator
      .renderSettings()
      .cards.find((candidate) => candidate.label === providerCase.label);
    assert.ok(card);
    assert.equal(card.blockedStatement, providerCase.blockedStatement);
    assert.deepEqual(card.blockers, [
      { label: "Accepted", count: 1 },
      { label: "Starting", count: 2 },
      { label: "Running", count: 3 },
      { label: "Recovery required", count: 4 },
      { label: "Unknown", count: 5 },
    ]);
    assert.equal(card.actions[0]?.disabled, true);
    assert.equal(card.feedback, null);
    assert.equal(launches, 0);
    await assert.rejects(
      ipc.invoke(
        WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        owner,
        { preparationKey },
      ),
      /boundary-rejected/u,
    );
    assert.equal(launches, 0);
    await binding.dispose();
  }
});

class FakeIpcMain implements SubscriptionAuthenticationIpcMainBoundary {
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

class FakeSender implements SubscriptionAuthenticationRendererSender {
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
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeWindow implements SubscriptionAuthenticationBrowserWindowBoundary {
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

class FakeSource implements WorkbenchSubscriptionAuthenticationSource {
  readonly calls: unknown[][] = [];
  closeCalls = 0;
  failure: unknown;
  inspectValue: Promise<SubscriptionAuthenticationSnapshot> | undefined;
  bindValue: Promise<SubscriptionAuthenticationResult> | undefined;
  async inspect(endpointId: "codex-desktop" | "claude-code-desktop"): Promise<SubscriptionAuthenticationSnapshot> {
    this.calls.push(["inspect", endpointId]);
    if (this.failure !== undefined) throw this.failure;
    return this.inspectValue ?? { endpointId, authentication: "unbound" };
  }
  async bind(endpointId: "codex-desktop" | "claude-code-desktop"): Promise<SubscriptionAuthenticationResult> {
    this.calls.push(["bind", endpointId]);
    if (this.failure !== undefined) throw this.failure;
    return this.bindValue ?? { endpointId, effect: "finished", authentication: "bound" };
  }
  async cancel(endpointId: "codex-desktop" | "claude-code-desktop"): Promise<SubscriptionAuthenticationResult> {
    this.calls.push(["cancel", endpointId]);
    if (this.failure !== undefined) throw this.failure;
    return { endpointId, effect: "cancelled", authentication: "bound" };
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  return Object.freeze({ promise, resolve });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
