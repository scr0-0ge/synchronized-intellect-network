import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  publicSubscriptionAuthenticationEffect,
  publicSubscriptionAuthenticationSnapshot,
  publicSubscriptionAuthenticationUnavailable,
} from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchPreloadBridge,
  type FixedProjectViewIpc,
} from "../../src/workbench-shell/preload-bridge.ts";
import {
  reconstructSubscriptionAuthenticationRequest,
  sanitizeSubscriptionAuthenticationPublicRequest,
  sanitizeSubscriptionAuthenticationPublicResponse,
  sanitizeSubscriptionAuthenticationEffectResult,
  sanitizeSubscriptionAuthenticationSnapshotResult,
} from "../../src/workbench-shell/result-sanitizer.ts";
import { WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS } from "../../src/workbench-shell/subscription-authentication-coordinator.ts";

const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "subscription-authentication-unavailable" as const,
    message:
      "Subscription authentication is unavailable. Keep the current status and try again." as const,
  }),
});

test("subscription authentication contract is closed to endpoint, sanitized status, and fixed effect only", () => {
  assert.equal(
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    "workbench:inspect-subscription-authentication",
  );
  assert.equal(
    WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    "workbench:bind-subscription-authentication",
  );
  assert.equal(
    WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    "workbench:cancel-subscription-authentication",
  );
  assert.deepEqual(
    publicSubscriptionAuthenticationSnapshot("claude-code-desktop", "bound"),
    {
      ok: true,
      endpointId: "claude-code-desktop",
      authentication: "bound",
    },
  );
  assert.deepEqual(
    publicSubscriptionAuthenticationEffect(
      "codex-desktop",
      "timed-out",
      "authentication-required",
    ),
    {
      ok: true,
      endpointId: "codex-desktop",
      effect: "timed-out",
      authentication: "authentication-required",
    },
  );
  assert.deepEqual(publicSubscriptionAuthenticationUnavailable(), unavailable);
});

test("subscription authentication request reconstruction rejects all native launch controls", () => {
  const request = Object.freeze({ endpointId: "codex-desktop" as const });
  const reconstructed = reconstructSubscriptionAuthenticationRequest(request);
  assert.deepEqual(reconstructed, { ok: true, request });
  assert.notEqual(reconstructed.ok && reconstructed.request, request);
  assert.equal(
    reconstructed.ok && Object.isFrozen(reconstructed.request),
    true,
  );

  for (const value of [
    null,
    [],
    {},
    { endpointId: "unknown" },
    { ...request, executable: "private" },
    { ...request, args: ["--bare"] },
    { ...request, cwd: "private" },
    { ...request, env: { OPENAI_API_KEY: "private" } },
    { ...request, url: "https://private.invalid" },
    Object.assign(Object.create(null), request),
    Object.defineProperty({}, "endpointId", {
      enumerable: true,
      get: () => "codex-desktop",
    }),
  ]) {
    assert.deepEqual(reconstructSubscriptionAuthenticationRequest(value), {
      ok: false,
    });
  }
});

test("subscription authentication sanitizers clone exact results and reject private or malformed drift", () => {
  const snapshot = {
    ok: true as const,
    endpointId: "claude-code-desktop" as const,
    authentication: "unbound" as const,
  };
  const effect = {
    ok: true as const,
    endpointId: "codex-desktop" as const,
    effect: "finished" as const,
    authentication: "bound" as const,
  };
  const sanitizedSnapshot = sanitizeSubscriptionAuthenticationSnapshotResult(snapshot);
  const sanitizedEffect = sanitizeSubscriptionAuthenticationEffectResult(effect);
  assert.deepEqual(sanitizedSnapshot, snapshot);
  assert.deepEqual(sanitizedEffect, effect);
  assert.notEqual(sanitizedSnapshot, snapshot);
  assert.notEqual(sanitizedEffect, effect);

  const throwingProxy = new Proxy(
    {},
    {
      ownKeys(): never {
        throw new Error("PRIVATE_PROXY_FAILURE");
      },
    },
  );
  for (const value of [
    null,
    [],
    { ...snapshot, stdout: "private" },
    { ...snapshot, authentication: "logged-in" },
    { ...effect, stderr: "private" },
    { ...effect, url: "https://private.invalid" },
    { ...effect, exitCode: 0 },
    { ...effect, signal: "SIGTERM" },
    { ...effect, effect: "native-error" },
    { ok: false, error: { ...unavailable.error, message: "private" } },
    throwingProxy,
  ]) {
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationSnapshotResult(value),
      unavailable,
    );
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationEffectResult(value),
      unavailable,
    );
  }
});

test("D20 public authentication boundary admits only opaque controls and exact sanitized variants", () => {
  const endpointKeys = new Set(["endpoint-selection-01"]);
  const preparationKeys = new Set(["preparation-0001"]);
  const authority = Object.freeze({
    isEndpointSelectionKey: (value: string) => endpointKeys.has(value),
    isPreparationKey: (value: string) => preparationKeys.has(value),
  });

  for (const [value, expected] of [
    [
      { endpointSelectionKey: "endpoint-selection-01" },
      { endpointSelectionKey: "endpoint-selection-01" },
    ],
    [
      { endpointSelectionKey: "endpoint-selection-01", action: "logout" },
      { endpointSelectionKey: "endpoint-selection-01", action: "logout" },
    ],
    [
      { preparationKey: "preparation-0001" },
      { preparationKey: "preparation-0001" },
    ],
  ] as const) {
    const result = sanitizeSubscriptionAuthenticationPublicRequest(
      value,
      authority,
    );
    assert.deepEqual(result, { accepted: true, value: expected });
    assert.equal(result.accepted && Object.isFrozen(result.value), true);
    assert.notEqual(result.accepted && result.value, value);
  }

  const responses = [
    { kind: "authentication-state", state: "bound" },
    {
      kind: "blocked",
      blockers: {
        accepted: 1,
        starting: 2,
        inFlight: 3,
        recoveryRequired: 4,
        unknown: 5,
      },
    },
    {
      kind: "confirmation-required",
      preparationKey: "preparation-0001",
      consequences: { resumableSessionCount: 2, projectCount: 1 },
    },
    { kind: "ready", preparationKey: "preparation-0001" },
    { kind: "authentication-action-requested", action: "logout" },
    { kind: "authentication-action-not-requested", action: "login" },
  ] as const;
  for (const response of responses) {
    const result = sanitizeSubscriptionAuthenticationPublicResponse(
      response,
      authority,
    );
    assert.deepEqual(result, { accepted: true, value: response });
    assert.notEqual(result.accepted && result.value, response);
  }

  const throwingProxy = new Proxy(
    {},
    {
      ownKeys(): never {
        throw new Error("PRIVATE_PROXY_FAILURE");
      },
    },
  );
  for (const value of [
    { endpointSelectionKey: "forged-selection" },
    { preparationKey: "forged-preparation" },
    { endpointSelectionKey: "endpoint-selection-01", endpointId: "private" },
    { endpointSelectionKey: "endpoint-selection-01", action: "bind" },
    Object.defineProperty({}, "endpointSelectionKey", {
      enumerable: true,
      get: () => "endpoint-selection-01",
    }),
    throwingProxy,
  ]) {
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationPublicRequest(value, authority),
      { accepted: false },
    );
  }
  for (const value of [
    { kind: "authentication-state", state: "bound", endpointId: "private" },
    { kind: "authentication-state", state: "logged-out" },
    {
      kind: "blocked",
      blockers: {
        accepted: 0,
        starting: 0,
        inFlight: 0,
        recoveryRequired: 0,
        unknown: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    { kind: "ready", preparationKey: "forged-preparation" },
    throwingProxy,
  ]) {
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationPublicResponse(value, authority),
      { accepted: false },
    );
  }

  preparationKeys.delete("preparation-0001");
  assert.deepEqual(
    sanitizeSubscriptionAuthenticationPublicResponse(
      { kind: "ready", preparationKey: "preparation-0001" },
      authority,
    ),
    { accepted: false },
  );
});

test("preload sends only opaque D20 controls and fail-closes request or response drift", async () => {
  const ipc = new FakeIpc();
  ipc.responses.set(WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL, {
    kind: "authentication-state",
    state: "bound",
  });
  ipc.responses.set(WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL, {
    kind: "ready",
    preparationKey: "preparation-0001",
  });
  ipc.responses.set(WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL, {
    kind: "authentication-action-requested",
    action: "logout",
  });
  ipc.responses.set(
    WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    undefined,
  );
  const bridge = createWorkbenchPreloadBridge(ipc);
  const inspectRequest = Object.freeze({
    endpointSelectionKey:
      WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
  });
  const prepareRequest = Object.freeze({
    ...inspectRequest,
    action: "logout" as const,
  });

  assert.deepEqual(
    await bridge.inspectSubscriptionAuthentication(inspectRequest),
    {
      kind: "authentication-state",
      state: "bound",
    },
  );
  assert.deepEqual(
    await bridge.prepareSubscriptionAuthentication(prepareRequest),
    {
      kind: "ready",
      preparationKey: "preparation-0001",
    },
  );
  assert.deepEqual(
    await bridge.beginSubscriptionAuthentication({
      preparationKey: "preparation-0001",
    }),
    {
      kind: "authentication-action-requested",
      action: "logout",
    },
  );

  ipc.responses.set(WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL, {
    kind: "confirmation-required",
    preparationKey: "preparation-0002",
    consequences: { resumableSessionCount: 2, projectCount: 1 },
  });
  await bridge.prepareSubscriptionAuthentication(prepareRequest);
  await bridge.cancelPreparedSubscriptionAuthentication({
    preparationKey: "preparation-0002",
  });
  assert.deepEqual(ipc.calls, [
    {
      channel: WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      values: [inspectRequest],
    },
    {
      channel: WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      values: [prepareRequest],
    },
    {
      channel: WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      values: [{ preparationKey: "preparation-0001" }],
    },
    {
      channel: WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      values: [prepareRequest],
    },
    {
      channel: WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
      values: [{ preparationKey: "preparation-0002" }],
    },
  ]);
  assert.equal(
    ipc.calls.every(
      (call) =>
        call.values[0] !== inspectRequest && call.values[0] !== prepareRequest,
    ),
    true,
  );

  const prepareUnknown = bridge.prepareSubscriptionAuthentication as unknown as (
    value: unknown,
  ) => Promise<unknown>;
  await assert.rejects(
    prepareUnknown({ ...prepareRequest, args: ["login", "--bare"] }),
    /boundary-rejected/u,
  );
  assert.equal(ipc.calls.length, 5);

  ipc.responses.set(WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL, {
    kind: "authentication-state",
    state: "bound",
    stdout: "private account",
  });
  await assert.rejects(
    bridge.inspectSubscriptionAuthentication(inspectRequest),
    /boundary-rejected/u,
  );
  ipc.failures.set(
    WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    new Error("PRIVATE_NATIVE_FAILURE"),
  );
  await assert.rejects(
    bridge.inspectSubscriptionAuthentication(inspectRequest),
    /PRIVATE_NATIVE_FAILURE/u,
  );
});

type Listener = (event: unknown, value: unknown) => void;

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
