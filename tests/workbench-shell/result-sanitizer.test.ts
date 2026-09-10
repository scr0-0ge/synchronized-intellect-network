import assert from "node:assert/strict";
import test from "node:test";

import { hostedProjectView } from "./w26-hosted-project-view.ts";
import { publicEmptyProjectRegistry } from "../../src/workbench-shell/contract.ts";

import {
  reconstructWorkbenchDirectInputRequest,
  reconstructWorkbenchDirectSessionProfileDefaultRequest,
  reconstructWorkbenchDirectSessionProfileLoadRequest,
  reconstructWorkbenchInterruptRequest,
  reconstructWorkbenchSteerRequest,
  reconstructWorkbenchProjectHistoryAdoptionRequest,
  reconstructWorkbenchProjectHistoryHideRequest,
  reconstructWorkbenchProjectSelectionRequest,
  reconstructWorkbenchSessionMetadataMutationRequest,
  reconstructWorkbenchSessionRemovalRequest,
  sanitizeWorkbenchCreateProjectResult,
  sanitizeWorkbenchHostedProjectResult,
  sanitizeWorkbenchInterruptResult,
  sanitizeWorkbenchSteerResult,
  sanitizeWorkbenchOpenProjectResult,
  sanitizeWorkbenchProjectHistoryAdoptionResult,
  sanitizeWorkbenchProjectHistoryDiscoveryResult,
  sanitizeWorkbenchProjectHistoryHideResult,
  sanitizeWorkbenchProjectResult,
  sanitizeWorkbenchProjectSelectionResult,
  sanitizeWorkbenchSessionMetadataMutationResult,
  sanitizeWorkbenchDirectSessionProfileResult,
  sanitizeWorkbenchSubmissionResult,
  sanitizeSubscriptionAuthenticationPublicResponse,
} from "../../src/workbench-shell/result-sanitizer.ts";

const snapshotKey =
  "snapshot:00000000-0000-4000-8000-000000000001";
const endpointKey =
  "endpoint-option:1:00000000-0000-4000-8000-000000000002";
const modelKey =
  "model-option:1:00000000-0000-4000-8000-000000000003";
const workIntensityKey =
  "intensity-option:1:00000000-0000-4000-8000-000000000004";
const executionModeKey =
  "execution-option:1:00000000-0000-4000-8000-000000000005";
const coupledExecutionModeKey =
  "execution-option:1:00000000-0000-4000-8000-000000000014";
const accessModeKey =
  "access-option:1:00000000-0000-4000-8000-000000000006";
const selectionKey =
  "session-selection:00000000-0000-4000-8000-000000000007";
const removalKey =
  "session-removal:00000000-0000-4000-8000-000000000009";
const metadataKey =
  "session-metadata:00000000-0000-4000-8000-000000000010";
const interruptKey =
  "turn-interrupt:00000000-0000-4000-8000-000000000013";
const steerKey =
  "turn-steer:00000000-0000-4000-8000-000000000015";
const projectSelectionKey =
  "project-selection:00000000-0000-4000-8000-000000000008";
const projectHistoryKey =
  "project-history:00000000-0000-4000-8000-000000000011";
const secondProjectHistoryKey =
  "project-history:00000000-0000-4000-8000-000000000012";

function projectHistory(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    historyKey: projectHistoryKey,
    current: true,
    sessionCount: 3,
    commandCount: 9,
    updateCount: 41,
    byteSize: 188_416,
    lastModified: "2026-08-15T09:41:02Z",
    schemaVersion: 5,
    ...overrides,
  };
}

function discoveredHistories(
  ...histories: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return {
    status: "discovered",
    snapshot: { projectLabel: "unified-ai-workbench", histories },
  };
}

test("interrupt reconstruction and results accept only exact public capability shapes", () => {
  const request = { interruptKey };
  assert.deepEqual(reconstructWorkbenchInterruptRequest(request), {
    ok: true,
    request,
  });
  for (const malformed of [
    undefined,
    {},
    { interruptKey: "turn-interrupt:forged" },
    { interruptKey, extra: "PRIVATE_EXTRA" },
    { interruptKey, commandId: "PRIVATE_COMMAND" },
  ]) {
    assert.deepEqual(reconstructWorkbenchInterruptRequest(malformed), {
      ok: false,
    });
  }
  const hidden = { ...request };
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_HIDDEN",
  });
  const accessor = {};
  Object.defineProperty(accessor, "interruptKey", {
    enumerable: true,
    get: () => interruptKey,
  });
  for (const hostile of [
    hidden,
    { ...request, [Symbol("private-authority")]: true },
    Object.assign(
      Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as object,
      request,
    ),
    accessor,
    new Proxy({ ...request }, {}),
  ]) {
    assert.deepEqual(reconstructWorkbenchInterruptRequest(hostile), {
      ok: false,
    });
  }

  const requested = {
    ok: true,
    status: "requested",
    message: "Interrupt requested.",
  };
  assert.deepEqual(sanitizeWorkbenchInterruptResult(requested), requested);
  for (const malformed of [
    { ...requested, extra: "PRIVATE_EXTRA" },
    { ...requested, status: "completed" },
    {
      ok: false,
      error: {
        category: "interrupt-unavailable",
        message: "PRIVATE_DETAIL",
      },
    },
  ]) {
    assert.deepEqual(sanitizeWorkbenchInterruptResult(malformed), {
      ok: false,
      error: {
        category: "interrupt-unavailable",
        message: "Interrupt is unavailable for this turn.",
      },
    });
  }
});

test("same-turn guidance reconstruction and results stay exact and opaque", () => {
  const request = { steerKey, input: "Use the safer migration." };
  assert.deepEqual(reconstructWorkbenchSteerRequest(request), {
    ok: true,
    request,
  });
  for (const malformed of [
    undefined,
    {},
    { steerKey: "turn-steer:forged", input: request.input },
    { ...request, input: "" },
    { ...request, extra: "PRIVATE_EXTRA" },
    { ...request, commandId: "PRIVATE_COMMAND" },
  ]) {
    assert.deepEqual(reconstructWorkbenchSteerRequest(malformed), { ok: false });
  }
  const hidden = { ...request };
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_HIDDEN",
  });
  const accessor = { steerKey } as { steerKey: string; input?: string };
  Object.defineProperty(accessor, "input", {
    enumerable: true,
    get: () => request.input,
  });
  for (const hostile of [
    hidden,
    { ...request, [Symbol("private-authority")]: true },
    Object.assign(
      Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as object,
      request,
    ),
    accessor,
    new Proxy({ ...request }, {}),
  ]) {
    assert.deepEqual(reconstructWorkbenchSteerRequest(hostile), { ok: false });
  }

  const accepted = {
    ok: true,
    status: "accepted",
    message: "Guidance was accepted into the running turn.",
  };
  assert.deepEqual(sanitizeWorkbenchSteerResult(accepted), accepted);
  for (const malformed of [
    { ...accepted, extra: "PRIVATE_NATIVE_TURN" },
    { ...accepted, status: "queued" },
    {
      ok: false,
      error: { category: "steer-unavailable", message: "PRIVATE_DETAIL" },
    },
  ]) {
    assert.deepEqual(sanitizeWorkbenchSteerResult(malformed), {
      ok: false,
      error: {
        category: "steer-unavailable",
        message: "Same-turn guidance is unavailable. Your draft was kept.",
      },
    });
  }
});

test("profile-load reconstruction keeps catalog-default, replacement, and continuation requests exact and distinct", () => {
  const catalogDefault = { kind: "catalog-default" } as const;
  const replacementSession = {
    kind: "replacement-session",
    sourceSelectionKey: "command-12",
    sourceSnapshotCursor: 37,
  } as const;
  const continuationSession = {
    kind: "continuation-session",
    selectionKey,
  } as const;

  assert.deepEqual(
    reconstructWorkbenchDirectSessionProfileLoadRequest(catalogDefault),
    { ok: true, request: catalogDefault },
  );
  assert.deepEqual(
    reconstructWorkbenchDirectSessionProfileLoadRequest(replacementSession),
    { ok: true, request: replacementSession },
  );
  assert.deepEqual(
    reconstructWorkbenchDirectSessionProfileLoadRequest(continuationSession),
    { ok: true, request: continuationSession },
  );
  assert.equal(
    Object.isFrozen(
      reconstructWorkbenchDirectSessionProfileLoadRequest(replacementSession),
    ),
    true,
  );

  for (const malformed of [
    {},
    { ...catalogDefault, sourceSelectionKey: "command-12" },
    { ...replacementSession, extra: "PRIVATE_EXTRA" },
    { ...replacementSession, sourceSelectionKey: "session-selection:forged" },
    { ...replacementSession, sourceSnapshotCursor: -1 },
    { ...replacementSession, sourceSnapshotCursor: 1.5 },
    { ...continuationSession, extra: "PRIVATE_EXTRA" },
    { ...continuationSession, selectionKey: "session-selection:forged" },
    { kind: "continuation-session" },
  ]) {
    assert.deepEqual(
      reconstructWorkbenchDirectSessionProfileLoadRequest(malformed),
      { ok: false },
    );
  }

  const privateSymbol = Symbol("PRIVATE_REQUEST_SENTINEL");
  const symbolBearing = {
    ...replacementSession,
    [privateSymbol]: "PRIVATE_REQUEST_SENTINEL",
  };
  const nonEnumerable = { ...replacementSession } as Record<PropertyKey, unknown>;
  Object.defineProperty(nonEnumerable, "PRIVATE_REQUEST_SENTINEL", {
    value: true,
    enumerable: false,
  });
  const inherited = Object.assign(
    Object.create({ PRIVATE_REQUEST_SENTINEL: true }) as Record<
      PropertyKey,
      unknown
    >,
    replacementSession,
  );
  let accessorReads = 0;
  const accessorBearing = { ...replacementSession } as Record<
    PropertyKey,
    unknown
  >;
  Object.defineProperty(accessorBearing, "sourceSelectionKey", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return replacementSession.sourceSelectionKey;
    },
  });
  let proxyReads = 0;
  const proxy = new Proxy(replacementSession, {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  for (const adversarial of [
    symbolBearing,
    nonEnumerable,
    inherited,
    accessorBearing,
    proxy,
  ]) {
    assert.deepEqual(
      reconstructWorkbenchDirectSessionProfileLoadRequest(adversarial),
      { ok: false },
    );
  }
  assert.equal(accessorReads, 0);
  assert.equal(proxyReads, 0);
});

test("profile-default reconstruction rejects hidden, symbolic, inherited, accessor, Proxy, and revoked authority", () => {
  const request = {
    snapshotKey,
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  };
  assert.deepEqual(
    reconstructWorkbenchDirectSessionProfileDefaultRequest(request),
    { ok: true, request },
  );

  const hidden = { ...request } as Record<PropertyKey, unknown>;
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_HIDDEN",
  });
  const inherited = Object.assign(
    Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as Record<
      PropertyKey,
      unknown
    >,
    request,
  );
  let accessorReads = 0;
  const accessor = { ...request } as Record<PropertyKey, unknown>;
  Object.defineProperty(accessor, "snapshotKey", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return snapshotKey;
    },
  });
  const proxy = new Proxy({ ...request }, {});
  const revoked = Proxy.revocable({ ...request }, {});
  revoked.revoke();

  for (const hostile of [
    hidden,
    { ...request, [Symbol("private-authority")]: true },
    inherited,
    accessor,
    proxy,
    revoked.proxy,
  ]) {
    assert.deepEqual(
      reconstructWorkbenchDirectSessionProfileDefaultRequest(hostile),
      { ok: false },
    );
  }
  assert.equal(accessorReads, 0);
});

test("Session-removal reconstruction rejects hidden, symbolic, inherited, accessor, Proxy, and revoked authority", () => {
  const request = { removalKey };
  assert.deepEqual(reconstructWorkbenchSessionRemovalRequest(request), {
    ok: true,
    request,
  });

  const hidden = { ...request } as Record<PropertyKey, unknown>;
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_HIDDEN",
  });
  const inherited = Object.assign(
    Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as Record<
      PropertyKey,
      unknown
    >,
    request,
  );
  let accessorReads = 0;
  const accessor = {} as Record<PropertyKey, unknown>;
  Object.defineProperty(accessor, "removalKey", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return removalKey;
    },
  });
  const proxy = new Proxy({ ...request }, {});
  const revoked = Proxy.revocable({ ...request }, {});
  revoked.revoke();

  for (const hostile of [
    hidden,
    { ...request, [Symbol("private-authority")]: true },
    inherited,
    accessor,
    proxy,
    revoked.proxy,
  ]) {
    assert.deepEqual(reconstructWorkbenchSessionRemovalRequest(hostile), {
      ok: false,
    });
  }
  assert.equal(accessorReads, 0);
});

test("the unknown-outcome acknowledgement crosses the seam as one exact literal", () => {
  const acknowledged = { removalKey, acknowledgedUnknownOutcome: true };
  assert.deepEqual(
    reconstructWorkbenchSessionRemovalRequest(acknowledged),
    { ok: true, request: acknowledged },
  );

  // Exactly one spelling is admitted. Every other value for the key, and every
  // unadmitted key beside it, still fails closed.
  for (const widened of [
    { removalKey, acknowledgedUnknownOutcome: false },
    { removalKey, acknowledgedUnknownOutcome: "true" },
    { removalKey, acknowledgedUnknownOutcome: 1 },
    { removalKey, acknowledgedUnknownOutcome: null },
    { removalKey, acknowledgedUnknownOutcome: undefined },
    { removalKey, acknowledgedUnknownOutcome: true, extra: true },
    { acknowledgedUnknownOutcome: true },
  ]) {
    assert.deepEqual(reconstructWorkbenchSessionRemovalRequest(widened), {
      ok: false,
    });
  }
});

test("F115 the partially-completed outcome crosses the seam as one exact two-key literal", () => {
  const authority = Object.freeze({
    isEndpointSelectionKey: (value: string) => value === "endpoint-selection-01",
    isPreparationKey: (value: string) => value === "preparation-0001",
  });

  // Exactly one spelling is admitted, for each action, and nothing else.
  for (const action of ["logout", "login"] as const) {
    const partial = { kind: "authentication-action-partially-completed", action };
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationPublicResponse(partial, authority),
      { accepted: true, value: partial },
    );
  }

  // Adding a third admitted literal narrows nothing away from the two that
  // were already admitted: both still cross, and only in their exact shape.
  for (const kind of [
    "authentication-action-requested",
    "authentication-action-not-requested",
  ] as const) {
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationPublicResponse(
        { kind, action: "logout" },
        authority,
      ),
      { accepted: true, value: { kind, action: "logout" } },
    );
  }

  // A widened key set is not narrowing-compatible, so every extra key — even a
  // plausible one that names the consequence — still fails closed, on the new
  // kind and on both pre-existing ones alike.
  for (const widened of [
    {
      kind: "authentication-action-partially-completed",
      action: "logout",
      resumabilityFenced: false,
    },
    {
      kind: "authentication-action-partially-completed",
      action: "logout",
      reason: "PRIVATE_PERSISTENCE_FAILURE",
    },
    {
      kind: "authentication-action-partially-completed",
      action: "logout",
      endpointId: "PRIVATE_ENDPOINT",
    },
    { kind: "authentication-action-partially-completed" },
    { kind: "authentication-action-partially-completed", action: "bind" },
    { kind: "authentication-action-partially-completed", action: null },
    { kind: "authentication-action-partially-complete", action: "logout" },
    { kind: "authentication-action-partially-completed ", action: "logout" },
    { kind: "authentication-action-requested", action: "logout", extra: true },
    {
      kind: "authentication-action-not-requested",
      action: "logout",
      partiallyCompleted: true,
    },
    { kind: "authentication-action-requested", action: "bind" },
    { kind: "authentication-action-not-requested" },
    ["authentication-action-partially-completed", "logout"],
    "authentication-action-partially-completed",
    null,
  ]) {
    const sanitized = sanitizeSubscriptionAuthenticationPublicResponse(
      widened,
      authority,
    );
    assert.deepEqual(sanitized, { accepted: false });
    assert.equal(JSON.stringify(sanitized).includes("PRIVATE"), false);
  }

  // Hidden, symbolic, inherited, accessor, Proxy, and revoked spellings of the
  // new kind are never read, let alone admitted.
  const exact = {
    kind: "authentication-action-partially-completed",
    action: "logout",
  };
  const hidden = { ...exact } as Record<PropertyKey, unknown>;
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_HIDDEN",
  });
  const inherited = Object.assign(
    Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as Record<
      PropertyKey,
      unknown
    >,
    exact,
  );
  let accessorReads = 0;
  const accessor = {
    kind: "authentication-action-partially-completed",
  } as Record<PropertyKey, unknown>;
  Object.defineProperty(accessor, "action", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "logout";
    },
  });
  const revoked = Proxy.revocable({ ...exact }, {});
  revoked.revoke();
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys(): never {
        throw new Error("PRIVATE_PROXY_FAILURE");
      },
    },
  );

  for (const hostile of [
    hidden,
    { ...exact, [Symbol("private-authority")]: true },
    inherited,
    accessor,
    revoked.proxy,
    throwingProxy,
  ]) {
    assert.deepEqual(
      sanitizeSubscriptionAuthenticationPublicResponse(hostile, authority),
      { accepted: false },
    );
  }
  assert.equal(accessorReads, 0);

  // A transparent Proxy carries the exact shape, so it is admitted — but only
  // ever as a fresh frozen copy, so no live handler survives the seam.
  const live = { ...exact };
  const proxied = sanitizeSubscriptionAuthenticationPublicResponse(
    new Proxy(live, {}),
    authority,
  );
  assert.deepEqual(proxied, { accepted: true, value: exact });
  assert.equal(proxied.accepted && Object.isFrozen(proxied.value), true);
  live.action = "login";
  assert.deepEqual(proxied, { accepted: true, value: exact });
});

test("Project-history adoption rejects hidden, symbolic, inherited, accessor, Proxy, and revoked authority", () => {
  const request = { historyKey: projectHistoryKey };
  assert.deepEqual(reconstructWorkbenchProjectHistoryAdoptionRequest(request), {
    ok: true,
    request,
  });

  const hidden = { ...request } as Record<PropertyKey, unknown>;
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_LEDGER_SLOT",
  });
  const inherited = Object.assign(
    Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as Record<
      PropertyKey,
      unknown
    >,
    request,
  );
  let accessorReads = 0;
  const accessor = {} as Record<PropertyKey, unknown>;
  Object.defineProperty(accessor, "historyKey", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return projectHistoryKey;
    },
  });
  const proxy = new Proxy({ ...request }, {});
  const revoked = Proxy.revocable({ ...request }, {});
  revoked.revoke();

  for (const hostile of [
    hidden,
    { ...request, [Symbol("private-authority")]: true },
    inherited,
    accessor,
    proxy,
    revoked.proxy,
  ]) {
    assert.deepEqual(
      reconstructWorkbenchProjectHistoryAdoptionRequest(hostile),
      { ok: false },
    );
  }
  assert.equal(accessorReads, 0);
});

test("Project-history hiding admits only one exact rotating key", () => {
  const request = { historyKey: projectHistoryKey };
  assert.deepEqual(reconstructWorkbenchProjectHistoryHideRequest(request), {
    ok: true,
    request,
  });
  for (const hostile of [
    {},
    { ...request, extra: true },
    { historyKey: "project-history:not-a-uuid" },
    Object.create({ historyKey: projectHistoryKey }),
    new Proxy(request, {}),
    [projectHistoryKey],
    null,
  ]) {
    assert.deepEqual(reconstructWorkbenchProjectHistoryHideRequest(hostile), {
      ok: false,
    });
  }
});

test("the adoption capability crosses the seam as one exact rotating key", () => {
  // Exactly one spelling is admitted. A durable ledger slot, a path, a widened
  // record and every other key beside it still fail closed.
  for (const widened of [
    { historyKey: projectHistoryKey, ledgerSlot: "project-ledger-v1-x" },
    { historyKey: projectHistoryKey, extra: true },
    { historyKey: "project-ledger-v1-00000000-0000-4000-8000-000000000011" },
    { historyKey: "project-history:not-a-uuid" },
    { historyKey: `${projectHistoryKey} ` },
    { historyKey: 11 },
    { historyKey: null },
    { historyKey: undefined },
    {},
    { selectionKey: projectSelectionKey },
    [projectHistoryKey],
    projectHistoryKey,
    null,
  ]) {
    assert.deepEqual(
      reconstructWorkbenchProjectHistoryAdoptionRequest(widened),
      { ok: false },
    );
  }
});

test("Project-history discovery admits one exact inventory and never a transcript", () => {
  const discovered = discoveredHistories(
    projectHistory(),
    projectHistory({
      historyKey: secondProjectHistoryKey,
      current: false,
      sessionCount: 0,
      commandCount: 0,
      updateCount: 0,
      byteSize: 49_152,
      lastModified: "2026-07-19T11:04:10Z",
    }),
  );
  const sanitized = sanitizeWorkbenchProjectHistoryDiscoveryResult(discovered);
  assert.deepEqual(sanitized, discovered);
  assert.equal(Object.isFrozen(sanitized), true);
  if (sanitized.status !== "discovered") assert.fail("Expected a snapshot.");
  assert.equal(Object.isFrozen(sanitized.snapshot.histories), true);
  assert.equal(Object.isFrozen(sanitized.snapshot.histories[0]), true);
  assert.deepEqual(
    Object.keys(sanitized.snapshot.histories[0]!).sort(),
    [
      "byteSize",
      "commandCount",
      "current",
      "historyKey",
      "lastModified",
      "schemaVersion",
      "sessionCount",
      "updateCount",
    ],
  );

  for (const status of ["invalid-selection", "unavailable"] as const) {
    assert.deepEqual(sanitizeWorkbenchProjectHistoryDiscoveryResult({ status }), {
      status,
    });
  }
});

test("a widened, forged, or transcript-bearing discovery snapshot fails closed", () => {
  let accessorReads = 0;
  const accessorHistory = projectHistory();
  delete accessorHistory.sessionCount;
  Object.defineProperty(accessorHistory, "sessionCount", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 3;
    },
  });
  const hiddenHistory = projectHistory();
  Object.defineProperty(hiddenHistory, "ledgerSlot", {
    enumerable: false,
    value: "PRIVATE_LEDGER_SLOT",
  });
  const inheritedHistory = Object.assign(
    Object.create({ databasePath: "PRIVATE_PATH" }) as Record<string, unknown>,
    projectHistory(),
  );

  for (const hostile of [
    // Unadmitted keys are refused whatever they carry.
    discoveredHistories(projectHistory({ ledgerSlot: "project-ledger-v1-x" })),
    discoveredHistories(projectHistory({ databasePath: "PRIVATE_PATH" })),
    discoveredHistories(projectHistory({ transcript: "PRIVATE_MESSAGE" })),
    discoveredHistories(projectHistory({ sessionNames: ["PRIVATE_NAME"] })),
    // Every admitted key keeps its exact type and spelling.
    discoveredHistories(projectHistory({ historyKey: projectSelectionKey })),
    discoveredHistories(projectHistory({ current: "true" })),
    discoveredHistories(projectHistory({ sessionCount: -1 })),
    discoveredHistories(projectHistory({ sessionCount: 1.5 })),
    discoveredHistories(projectHistory({ commandCount: "9" })),
    discoveredHistories(projectHistory({ byteSize: Number.MAX_VALUE })),
    discoveredHistories(projectHistory({ schemaVersion: null })),
    discoveredHistories(projectHistory({ lastModified: "2026-08-15" })),
    discoveredHistories(
      projectHistory({ lastModified: "2026-08-15T09:41:02.500Z" }),
    ),
    discoveredHistories(projectHistory({ lastModified: 1_755_250_862_000 })),
    // Structural claims the shell cannot trust.
    discoveredHistories(),
    discoveredHistories(
      projectHistory(),
      projectHistory({ historyKey: secondProjectHistoryKey }),
    ),
    discoveredHistories(projectHistory({ current: false })),
    discoveredHistories(projectHistory(), projectHistory()),
    // The label is a Project label, never a path or a control sequence.
    {
      status: "discovered",
      snapshot: {
        projectLabel: "C:\\Users\\owner\\Project",
        histories: [projectHistory()],
      },
    },
    {
      status: "discovered",
      snapshot: {
        projectLabel: "unified\u202eai",
        histories: [projectHistory()],
      },
    },
    // Widened envelopes and hostile property graphs.
    { status: "discovered", snapshot: { histories: [projectHistory()] } },
    {
      status: "discovered",
      snapshot: { projectLabel: "p", histories: [projectHistory()] },
      dataDirectory: "PRIVATE_PATH",
    },
    { status: "discovered" },
    { status: "adopted" },
    discoveredHistories(accessorHistory),
    discoveredHistories(hiddenHistory),
    discoveredHistories(inheritedHistory),
    discoveredHistories(new Proxy(projectHistory(), {})),
    { status: "discovered", snapshot: new Proxy({ projectLabel: "p", histories: [] }, {}) },
  ]) {
    const sanitized = sanitizeWorkbenchProjectHistoryDiscoveryResult(hostile);
    assert.deepEqual(sanitized, { status: "unavailable" });
    assert.equal(JSON.stringify(sanitized).includes("PRIVATE_"), false);
  }
  assert.equal(accessorReads, 0);
});

test("Project-history adoption outcomes stay inside their fixed public vocabulary", () => {
  for (const status of ["adopted", "invalid-selection", "unavailable"] as const) {
    assert.deepEqual(sanitizeWorkbenchProjectHistoryAdoptionResult({ status }), {
      status,
    });
  }
  for (const activity of ["accepted", "in-flight", "unknown"] as const) {
    assert.deepEqual(
      sanitizeWorkbenchProjectHistoryAdoptionResult({ status: "blocked", activity }),
      { status: "blocked", activity },
    );
  }
  let accessorReads = 0;
  const accessor = { status: "adopted" } as Record<string, unknown>;
  Object.defineProperty(accessor, "adoptedLedgerSlot", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "PRIVATE_LEDGER_SLOT";
    },
  });
  const hidden = { status: "adopted" };
  Object.defineProperty(hidden, "databasePath", {
    enumerable: false,
    value: "PRIVATE_PATH",
  });
  for (const hostile of [
    { status: "adopted", ledgerSlot: "project-ledger-v1-x" },
    { status: "adopted", extra: true },
    { status: "removed" },
    { status: "discovered" },
    { status: "blocked" },
    { status: "blocked", activity: "idle" },
    { status: "blocked", activity: "accepted", extra: true },
    accessor,
    hidden,
    Object.assign(
      Object.create({ inherited: "PRIVATE_INHERITED" }) as Record<string, unknown>,
      { status: "adopted" },
    ),
    new Proxy({ status: "adopted" }, {}),
    ["adopted"],
    "adopted",
    null,
  ]) {
    const sanitized = sanitizeWorkbenchProjectHistoryAdoptionResult(hostile);
    assert.deepEqual(sanitized, { status: "unavailable" });
    assert.equal(JSON.stringify(sanitized).includes("PRIVATE_"), false);
  }
  assert.equal(accessorReads, 0);
});

test("Project-history hide outcomes stay inside their fixed public vocabulary", () => {
  for (const status of [
    "hidden",
    "ineligible",
    "invalid-selection",
    "unavailable",
  ] as const) {
    assert.deepEqual(sanitizeWorkbenchProjectHistoryHideResult({ status }), {
      status,
    });
  }
  for (const hostile of [
    { status: "hidden", extra: true },
    { status: "blocked" },
    { status: "deleted" },
    new Proxy({ status: "hidden" }, {}),
    ["hidden"],
    null,
  ]) {
    assert.deepEqual(sanitizeWorkbenchProjectHistoryHideResult(hostile), {
      status: "unavailable",
    });
  }
});

test("Session-metadata reconstruction and outcomes remain exact, canonical, and private", () => {
  const rename = {
    metadataKey,
    operation: { kind: "rename", displayName: "  Cafe\u0301 工程  " },
  } as const;
  assert.deepEqual(reconstructWorkbenchSessionMetadataMutationRequest(rename), {
    ok: true,
    request: {
      metadataKey,
      operation: { kind: "rename", displayName: "Café 工程" },
    },
  });
  for (const kind of ["archive", "restore"] as const) {
    const request = { metadataKey, operation: { kind } };
    assert.deepEqual(reconstructWorkbenchSessionMetadataMutationRequest(request), {
      ok: true,
      request,
    });
  }

  const accessor = { metadataKey } as Record<string, unknown>;
  Object.defineProperty(accessor, "operation", {
    enumerable: true,
    get: () => ({ kind: "archive" }),
  });
  const hidden = { metadataKey, operation: { kind: "archive" } };
  Object.defineProperty(hidden, "sessionId", {
    enumerable: false,
    value: "PRIVATE_SESSION_ID",
  });
  for (const malformed of [
    undefined,
    { metadataKey: "session-metadata:forged", operation: { kind: "archive" } },
    { ...rename, sessionId: "PRIVATE_SESSION_ID" },
    { ...rename, operation: { ...rename.operation, extra: true } },
    { ...rename, operation: { kind: "rename", displayName: " " } },
    { ...rename, operation: { kind: "rename", displayName: "x".repeat(81) } },
    { ...rename, operation: { kind: "rename", displayName: "\ud800" } },
    hidden,
    accessor,
    new Proxy({ metadataKey, operation: { kind: "archive" as const } }, {}),
  ]) {
    assert.deepEqual(reconstructWorkbenchSessionMetadataMutationRequest(malformed), {
      ok: false,
    });
  }

  for (const value of [
    { status: "renamed" },
    { status: "archived" },
    { status: "restored" },
    { status: "unchanged" },
    { status: "not-found" },
    { status: "invalid-name" },
    { status: "blocked", activity: "accepted" },
    { status: "blocked", activity: "in-flight" },
    { status: "blocked", activity: "unknown" },
  ] as const) {
    assert.deepEqual(sanitizeWorkbenchSessionMetadataMutationResult(value), value);
    assert.equal(Object.isFrozen(sanitizeWorkbenchSessionMetadataMutationResult(value)), true);
  }
  for (const malformed of [
    { status: "renamed", nativeSessionId: "PRIVATE_NATIVE" },
    { status: "blocked" },
    { status: "blocked", activity: "idle" },
    { status: "archived", activity: "unknown" },
    new Proxy({ status: "renamed" }, {}),
  ]) {
    assert.deepEqual(sanitizeWorkbenchSessionMetadataMutationResult(malformed), {
      status: "unavailable",
    });
  }
});

const projectedProfile = {
  requested: {
    kind: "recorded",
    runtimeFamilyLabel: "Quartz",
    endpointLabel: "Quartz desktop",
    modelLabel: "Quartz Prime",
    workIntensityControlLabel: {
      label: "Deliberation",
      provenance: "runtime-catalog",
    },
    workIntensityLabel: "Deep review",
    executionModeLabel: "Coordinated workflow",
    accessModeLabel: "Full access",
  },
  effective: {
    kind: "observed",
    provenance: "post-turn-observation",
    model: { label: "Quartz Prime", comparison: "matches-requested" },
    workIntensity: {
      label: "Observed different value",
      comparison: "differs-from-requested",
    },
    accessMode: { label: "Full access", comparison: "matches-requested" },
  },
} as const;

test("Project sanitization admits only exact interruption controls and stopped events", () => {
  const resultFor = (command: Record<string, unknown>) => ({
    ok: true,
    view: {
      project: { label: "Interrupt Project" },
      observation: { cursor: 13, live: true },
      commands: [command],
      initialSelectionKey: "command-1",
    },
  });
  const running = {
    key: "command-1",
    label: "Agent Session 01",
    runtime: "Codex",
    status: "in-flight",
    interrupt: { status: "available", interruptKey },
    steer: { status: "available", steerKey },
  };
  assert.deepEqual(sanitizeWorkbenchProjectResult(resultFor(running)), resultFor(running));

  for (const interrupt of [
    { status: "available", interruptKey: "turn-interrupt:forged" },
    { status: "available", interruptKey, commandId: "PRIVATE_COMMAND" },
    { status: "unsupported", reason: "PRIVATE_NATIVE_REASON" },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(resultFor({ ...running, interrupt })),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
    );
  }
  for (const steer of [
    { status: "available", steerKey: "turn-steer:forged" },
    { status: "available", steerKey, commandId: "PRIVATE_COMMAND" },
    { status: "unsupported", reason: "PRIVATE_NATIVE_REASON" },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(resultFor({ ...running, steer })),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
    );
  }
  assert.equal(
    sanitizeWorkbenchProjectResult(
      resultFor({ ...running, status: "completed" }),
    ).ok,
    false,
  );

  const interrupted = {
    key: "command-1",
    label: "Agent Session 01",
    runtime: "Quartz",
    status: "failed",
    failureCategory: "interrupted",
    session: {
      archived: false,
      metadataKey,
      profile: projectedProfile,
      timeline: [{ kind: "turn-interrupted", status: "interrupted" }],
      removalKey,
      selectionKey,
      resumable: true,
    },
  };
  assert.deepEqual(
    sanitizeWorkbenchProjectResult(resultFor(interrupted)),
    resultFor(interrupted),
  );
  assert.equal(
    sanitizeWorkbenchProjectResult(
      resultFor({
        ...interrupted,
        session: {
          ...interrupted.session,
          timeline: [
            {
              kind: "turn-interrupted",
              status: "interrupted",
              privateTurnId: "PRIVATE_TURN",
            },
          ],
        },
      }),
    ).ok,
    false,
  );
});

test("direct-input reconstruction accepts only exact explicit start and continuation shapes", () => {
  const start = {
    kind: "start",
    input: "Start one distinct Agent Session.",
    snapshotKey,
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  };
  const continuation = {
    kind: "continue",
    input: "Continue the selected Agent Session.",
    selectionKey,
    snapshotKey,
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  };

  assert.deepEqual(reconstructWorkbenchDirectInputRequest(start), {
    ok: true,
    request: start,
  });
  assert.deepEqual(reconstructWorkbenchDirectInputRequest(continuation), {
    ok: true,
    request: continuation,
  });
  assert.equal(
    Object.isFrozen(reconstructWorkbenchDirectInputRequest(start)),
    true,
  );

  const { kind: _kind, ...implicitStart } = start;
  for (const malformed of [
    implicitStart,
    { ...start, selectionKey },
    { ...start, extra: "PRIVATE_EXTRA" },
    { ...start, snapshotKey: "snapshot:forged" },
  ]) {
    assert.deepEqual(reconstructWorkbenchDirectInputRequest(malformed), {
      ok: false,
      category: "invalid-profile-selection",
    });
  }
  for (const mixed of [
    { ...continuation, extra: "PRIVATE_EXTRA" },
    { ...continuation, selectionKey: "session-selection:forged" },
    (({ accessModeKey: _accessModeKey, ...partial }) => partial)(continuation),
  ]) {
    assert.deepEqual(reconstructWorkbenchDirectInputRequest(mixed), {
      ok: false,
      category: "continuation-unavailable",
    });
  }
  for (const invalidProfile of [
    { ...continuation, modelKey: "model-option:forged" },
    { ...continuation, snapshotKey: "snapshot:forged" },
  ]) {
    assert.deepEqual(reconstructWorkbenchDirectInputRequest(invalidProfile), {
      ok: false,
      category: "invalid-profile-selection",
    });
  }
});

test("direct-input reconstruction rejects hidden, symbolic, inherited, accessor, and Proxy request authority", () => {
  const start = {
    kind: "start",
    input: "Start one exact Session.",
    snapshotKey,
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  } as const;
  const continuation = {
    kind: "continue",
    input: "Continue one exact Session.",
    selectionKey,
    snapshotKey,
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  } as const;

  for (const [request, category] of [
    [start, "invalid-profile-selection"],
    [continuation, "continuation-unavailable"],
  ] as const) {
    const hidden = { ...request };
    Object.defineProperty(hidden, "hiddenAuthority", {
      enumerable: false,
      value: "PRIVATE_HIDDEN",
    });
    const symbolic = { ...request, [Symbol("private-authority")]: true };
    const inherited = Object.assign(
      Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as object,
      request,
    );
    const accessor = { ...request };
    Object.defineProperty(accessor, "input", {
      enumerable: true,
      get: () => request.input,
    });
    const proxied = new Proxy({ ...request }, {});

    for (const [adversarial, expectedCategory] of [
      [hidden, category],
      [symbolic, category],
      [inherited, category],
      [accessor, "invalid-profile-selection"],
      [proxied, "invalid-profile-selection"],
    ] as const) {
      assert.deepEqual(reconstructWorkbenchDirectInputRequest(adversarial), {
        ok: false,
        category: expectedCategory,
      });
    }
  }
});

test("profile-result sanitization admits only an exact single-endpoint continuation capability on its request branch", () => {
  const continuationRequest = {
    kind: "continuation-session",
    selectionKey,
  } as const;
  const continuation = continuationProfileResult();

  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(
      continuation,
      continuationRequest,
    ),
    continuation,
  );
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(continuation, {
      kind: "catalog-default",
    }),
    unavailableProfileResult(),
  );
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(
      {
        ...continuation,
        profile: {
          ...continuation.profile,
          continuationPrefill: {
            ...continuation.profile.continuationPrefill,
            modelKey: "model-option:forged",
          },
        },
      },
      continuationRequest,
    ),
    unavailableProfileResult(),
  );
  for (const malformed of [
    {
      ...continuation,
      profile: { ...continuation.profile, extra: "PRIVATE_EXTRA" },
    },
    {
      ...continuation,
      profile: {
        ...continuation.profile,
        continuationPrefill: {
          ...continuation.profile.continuationPrefill,
          extra: "PRIVATE_EXTRA",
        },
      },
    },
    {
      ...continuation,
      profile: {
        ...continuation.profile,
        endpoints: [
          ...continuation.profile.endpoints,
          continuation.profile.endpoints[0],
        ],
      },
    },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchDirectSessionProfileResult(
        malformed,
        continuationRequest,
      ),
      unavailableProfileResult(),
    );
  }
});

test("F214: profile-result sanitization admits the orphaned-model continuation exactly and fails closed on drift", () => {
  /* Rule 1 (F26/F34): the new `continuation-model-unavailable` shape is admitted
     deliberately — exact category AND exact message, on the continuation branch,
     with a catalog-ready endpoint (coherent, because the provider WAS located and
     only the recorded model is gone). Every unadmitted variant still fails closed
     to the fixed unavailable result. */
  const message =
    "This Session's recorded model is no longer offered by its provider, so the next turn can't be prepared. The Session and its transcript are kept; start a New Agent Session to carry the work on.";
  const continuationRequest = {
    kind: "continuation-session",
    selectionKey,
  } as const;
  const orphaned = {
    ok: false as const,
    endpointDiscovery: endpointDiscovery("catalog-ready", "not-inspected"),
    error: { category: "continuation-model-unavailable" as const, message },
  };

  const admitted = sanitizeWorkbenchDirectSessionProfileResult(
    orphaned,
    continuationRequest,
  );
  assert.equal(admitted.ok, false);
  if (admitted.ok === false) {
    assert.equal(admitted.error.category, "continuation-model-unavailable");
    assert.equal(admitted.error.message, message);
    assert.doesNotMatch(admitted.error.message, /choose a resumable Session/u);
    assert.deepEqual(
      admitted.endpointDiscovery,
      endpointDiscovery("catalog-ready", "not-inspected"),
    );
  }

  // Wrong message on the new category → fails closed.
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(
      {
        ...orphaned,
        error: {
          category: "continuation-model-unavailable",
          message:
            "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
        },
      },
      continuationRequest,
    ),
    unavailableProfileResult(),
  );
  // The new category on a non-continuation request → fails closed.
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(orphaned, {
      kind: "catalog-default",
    }),
    unavailableProfileResult(),
  );
  // An unknown neighbouring category → still fails closed.
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(
      { ...orphaned, error: { category: "continuation-model-forged", message } },
      continuationRequest,
    ),
    unavailableProfileResult(),
  );
});

test("submission-result sanitization preserves durable acceptance but never implies Runtime completion", () => {
  const accepted = sanitizeWorkbenchSubmissionResult({
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
    commandId: "PRIVATE_DURABLE_IDENTIFIER",
    nativePayload: "PRIVATE_NATIVE_PAYLOAD",
  });
  const completed = sanitizeWorkbenchSubmissionResult({
    ok: true,
    status: "completed",
    message: "PRIVATE_RUNTIME_OUTPUT",
  });

  assert.deepEqual(accepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.deepEqual(completed, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  });
  assert.equal(JSON.stringify({ accepted, completed }).includes("PRIVATE_"), false);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(completed), true);
});

test("submission-result sanitization recognizes only the fixed inspect-only Runtime outcome", () => {
  const fixed = sanitizeWorkbenchSubmissionResult({
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Starting an Agent Session on this Runtime is not yet supported. Keep your draft and choose another endpoint.",
      nativeRuntimeProfile: "PRIVATE_NATIVE_PROFILE",
    },
    adapter: "PRIVATE_ADAPTER",
  });
  const forged = sanitizeWorkbenchSubmissionResult({
    ok: false,
    error: {
      category: "submission-unavailable",
      message: "Claude is unsupported for PRIVATE_NATIVE_REASON.",
    },
  });

  assert.deepEqual(fixed, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Starting an Agent Session on this Runtime is not yet supported. Keep your draft and choose another endpoint.",
    },
  });
  assert.deepEqual(Reflect.ownKeys(fixed).sort(), ["error", "ok"]);
  assert.deepEqual(
    fixed.ok ? [] : Reflect.ownKeys(fixed.error).sort(),
    ["category", "message"],
  );
  assert.deepEqual(forged, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  });
  assert.equal(JSON.stringify({ fixed, forged }).includes("PRIVATE_"), false);
});

test("profile-result sanitization preserves only an exact coherent Runtime-not-located state", () => {
  const fixed = sanitizeWorkbenchDirectSessionProfileResult({
    ok: false,
    endpointDiscovery: endpointDiscovery(
      "runtime-not-located",
      "runtime-not-located",
    ),
    error: {
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
    },
  });
  const forged = sanitizeWorkbenchDirectSessionProfileResult({
    ok: false,
    endpointDiscovery: endpointDiscovery(
      "runtime-not-located",
      "runtime-not-located",
    ),
    error: {
      category: "runtime-not-located",
      message: "PRIVATE_FORGED_COPY",
    },
  });

  assert.deepEqual(fixed, {
    ok: false,
    endpointDiscovery: endpointDiscovery(
      "runtime-not-located",
      "runtime-not-located",
    ),
    error: {
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
    },
  });
  assert.deepEqual(forged, unavailableProfileResult());
  assert.equal(JSON.stringify({ fixed, forged }).includes("PRIVATE"), false);
  assert.equal(Object.isFrozen(fixed), true);
});

test("profile-result sanitization reconstructs one exact display-only catalog shape", () => {
  const input = displayOnlyProfileResult();

  const result = sanitizeWorkbenchDirectSessionProfileResult(input);

  assert.deepEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.ok ? Object.isFrozen(result.profile.endpoints) : false, true);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["model-native-v2", "x-high", "nativeValue", "sessionId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("profile-result sanitization admits replacement prefill only on the matching request branch", () => {
  const replacementRequest = {
    kind: "replacement-session",
    sourceSelectionKey: "command-1",
    sourceSnapshotCursor: 7,
  } as const;
  const resolved = replacementProfileResult({
    kind: "resolved",
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  });
  const manual = replacementProfileResult({
    kind: "manual-selection-required",
  });

  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(resolved, replacementRequest),
    resolved,
  );
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(manual, replacementRequest),
    manual,
  );
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(resolved, {
      kind: "catalog-default",
    }),
    unavailableProfileResult(),
  );
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(
      displayOnlyProfileResult(),
      replacementRequest,
    ),
    unavailableProfileResult(),
  );

  const resolvedPrefill = resolved.profile.replacementPrefill;
  const privateSymbol = Symbol("PRIVATE_REPLACEMENT_RESULT");
  const symbolBearing = {
    ...resolvedPrefill,
    [privateSymbol]: "PRIVATE_REPLACEMENT_RESULT",
  };
  const nonEnumerable = { ...resolvedPrefill } as Record<PropertyKey, unknown>;
  Object.defineProperty(nonEnumerable, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  let accessorReads = 0;
  const accessorBearing = { ...resolvedPrefill } as Record<
    PropertyKey,
    unknown
  >;
  Object.defineProperty(accessorBearing, "modelKey", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return modelKey;
    },
  });
  let proxyReads = 0;
  const proxy = new Proxy(resolvedPrefill, {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const endpoint = resolved.profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const incoherentImplication = {
    ...resolved,
    profile: {
      ...resolved.profile,
      endpoints: [
        {
          ...endpoint,
          models: [
            {
              ...model,
              workIntensities: [
                {
                  ...model.workIntensities[0]!,
                  impliedExecutionModeKey: coupledExecutionModeKey,
                },
              ],
            },
          ],
          executionModes: [
            ...endpoint.executionModes,
            {
              key: coupledExecutionModeKey,
              label: "Coordinated workflow",
            },
          ],
        },
      ],
    },
  };
  const adversarial = [
    {
      ...resolvedPrefill,
      mismatchReason: "PRIVATE_MISMATCH_REASON",
    },
    {
      ...resolvedPrefill,
      sourceSelectionKey: "command-1",
    },
    {
      ...resolvedPrefill,
      modelKey: "model-option:1:00000000-0000-4000-8000-000000000099",
    },
    symbolBearing,
    nonEnumerable,
    accessorBearing,
    proxy,
  ];
  for (const replacementPrefill of adversarial) {
    const sanitized = sanitizeWorkbenchDirectSessionProfileResult(
      {
        ...resolved,
        profile: { ...resolved.profile, replacementPrefill },
      },
      replacementRequest,
    );
    assert.deepEqual(sanitized, unavailableProfileResult());
    assert.equal(JSON.stringify(sanitized).includes("PRIVATE"), false);
  }
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult(
      incoherentImplication,
      replacementRequest,
    ),
    unavailableProfileResult(),
  );
  assert.equal(accessorReads, 0);
  assert.equal(proxyReads, 0);
});

test("profile-result sanitization rejects a shape-correct endpoint Proxy before mutable display text is read", () => {
  const base = displayOnlyProfileResult();
  const endpoint = base.profile.endpoints[0]!;
  let runtimeFamilyLabelReads = 0;
  const mutableEndpoint = new Proxy(endpoint, {
    get(target, property, receiver) {
      if (property === "runtimeFamilyLabel") {
        runtimeFamilyLabelReads += 1;
        return runtimeFamilyLabelReads === 1
          ? Reflect.get(target, property, receiver)
          : "C:\\PRIVATE\\runtime.exe";
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const result = sanitizeWorkbenchDirectSessionProfileResult({
    ...base,
    profile: {
      ...base.profile,
      endpoints: [mutableEndpoint],
    },
  });

  assert.deepEqual(result, unavailableProfileResult());
  assert.equal(runtimeFamilyLabelReads, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("profile-result sanitization rejects shape-correct mutating Proxies at every strict sidecar and profile layer", () => {
  const base = displayOnlyProfileResult();
  const profile = base.profile;
  const endpoint = profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const intensity = model.workIntensities[0]!;
  const executionMode = endpoint.executionModes[0]!;
  const accessMode = endpoint.accessModes[0]!;
  const failure = unavailableProfileResult();
  const cases = [
    mutatingProxyCase(
      "top-level result",
      { ...base },
      "profile",
      { ...profile, snapshotKey: "C:\\PRIVATE\\snapshot" },
      (proxy) => proxy,
    ),
    mutatingProxyCase(
      "discovery record",
      { ...base.endpointDiscovery },
      "statuses",
      [{ executable: "C:\\PRIVATE\\runtime.exe" }],
      (proxy) => ({ ...base, endpointDiscovery: proxy }),
    ),
    mutatingProxyCase(
      "statuses array",
      [...base.endpointDiscovery.statuses],
      "0",
      { endpointId: "codex-desktop", category: "C:\\PRIVATE\\status" },
      (proxy) => ({ ...base, endpointDiscovery: { statuses: proxy } }),
    ),
    mutatingProxyCase(
      "status record",
      { ...base.endpointDiscovery.statuses[0]! },
      "category",
      "C:\\PRIVATE\\status",
      (proxy) => ({
        ...base,
        endpointDiscovery: {
          statuses: [proxy, base.endpointDiscovery.statuses[1]!],
        },
      }),
    ),
    mutatingProxyCase(
      "profile record",
      { ...profile },
      "snapshotKey",
      "C:\\PRIVATE\\snapshot",
      (proxy) => ({ ...base, profile: proxy }),
    ),
    mutatingProxyCase(
      "endpoints array",
      [...profile.endpoints],
      "0",
      { ...endpoint, runtimeFamilyLabel: "C:\\PRIVATE\\runtime.exe" },
      (proxy) => ({ ...base, profile: { ...profile, endpoints: proxy } }),
    ),
    mutatingProxyCase(
      "endpoint record",
      { ...endpoint },
      "runtimeFamilyLabel",
      "C:\\PRIVATE\\runtime.exe",
      (proxy) => ({
        ...base,
        profile: { ...profile, endpoints: [proxy] },
      }),
    ),
    mutatingProxyCase(
      "models array",
      [...endpoint.models],
      "0",
      { ...model, label: "C:\\PRIVATE\\model" },
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, models: proxy }],
        },
      }),
    ),
    mutatingProxyCase(
      "model record",
      { ...model },
      "label",
      "C:\\PRIVATE\\model",
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, models: [proxy] }],
        },
      }),
    ),
    mutatingProxyCase(
      "Work Intensity array",
      [...model.workIntensities],
      "0",
      { ...intensity, label: "C:\\PRIVATE\\intensity" },
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [
            { ...endpoint, models: [{ ...model, workIntensities: proxy }] },
          ],
        },
      }),
    ),
    mutatingProxyCase(
      "Work Intensity record",
      { ...intensity },
      "label",
      "C:\\PRIVATE\\intensity",
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [{ ...model, workIntensities: [proxy] }],
            },
          ],
        },
      }),
    ),
    mutatingProxyCase(
      "Execution Mode array",
      [...endpoint.executionModes],
      "0",
      { ...executionMode, label: "C:\\PRIVATE\\execution" },
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, executionModes: proxy }],
        },
      }),
    ),
    mutatingProxyCase(
      "Execution Mode record",
      { ...executionMode },
      "label",
      "C:\\PRIVATE\\execution",
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, executionModes: [proxy] }],
        },
      }),
    ),
    mutatingProxyCase(
      "Access Mode array",
      [...endpoint.accessModes],
      "0",
      { ...accessMode, label: "C:\\PRIVATE\\access" },
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, accessModes: proxy }],
        },
      }),
    ),
    mutatingProxyCase(
      "Access Mode record",
      { ...accessMode },
      "label",
      "C:\\PRIVATE\\access",
      (proxy) => ({
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, accessModes: [proxy] }],
        },
      }),
    ),
    mutatingProxyCase(
      "desired-default record",
      { ...profile.desiredDefault },
      "endpointKey",
      "C:\\PRIVATE\\default",
      (proxy) => ({ ...base, profile: { ...profile, desiredDefault: proxy } }),
    ),
    mutatingProxyCase(
      "failure error record",
      { ...failure.error },
      "message",
      "C:\\PRIVATE\\error",
      (proxy) => ({ ...failure, error: proxy }),
    ),
  ];

  for (const row of cases) {
    const result = sanitizeWorkbenchDirectSessionProfileResult(row.value);
    assert.deepEqual(result, unavailableProfileResult(), row.name);
    assert.equal(row.reads(), 0, row.name);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false, row.name);
  }
});

test("profile-result sanitization admits only the four declared hidden backend aliases", () => {
  const base = displayOnlyProfileResult();
  const backendProfile = { ...base.profile };
  Object.defineProperties(backendProfile, {
    runtime: { value: "PRIVATE_BACKEND_RUNTIME", enumerable: false },
    models: { value: ["PRIVATE_BACKEND_MODEL"], enumerable: false },
    executionMode: {
      value: { value: "single-agent", label: "Single agent", fixed: true },
      enumerable: false,
    },
    accessMode: {
      value: {
        value: "full-access",
        label: "Full access",
        fixed: true,
        independent: true,
      },
      enumerable: false,
    },
  });

  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult({
      ...base,
      profile: backendProfile,
    }),
    base,
  );

  Object.defineProperty(backendProfile, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const rejected = sanitizeWorkbenchDirectSessionProfileResult({
    ...base,
    profile: backendProfile,
  });
  assert.deepEqual(rejected, unavailableProfileResult());
  assert.equal(JSON.stringify(rejected).includes("PRIVATE"), false);
});

test("profile-result sanitization preserves one exact opaque Work Intensity implication", () => {
  const base = displayOnlyProfileResult();
  const endpoint = base.profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const coupled = {
    ...base,
    profile: {
      ...base.profile,
      endpoints: [
        {
          ...endpoint,
          models: [
            {
              ...model,
              workIntensities: [
                {
                  ...model.workIntensities[0]!,
                  impliedExecutionModeKey: coupledExecutionModeKey,
                },
              ],
            },
          ],
          executionModes: [
            ...endpoint.executionModes,
            {
              key: coupledExecutionModeKey,
              label: "Coordinated workflow",
            },
          ],
        },
      ],
      desiredDefault: {
        ...base.profile.desiredDefault,
        executionModeKey: coupledExecutionModeKey,
      },
    },
  };

  const result = sanitizeWorkbenchDirectSessionProfileResult(coupled);

  assert.deepEqual(result, coupled);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(
    sanitizeWorkbenchDirectSessionProfileResult({
      ...coupled,
      profile: {
        ...coupled.profile,
        desiredDefault: {
          ...coupled.profile.desiredDefault,
          executionModeKey,
        },
      },
    }),
    unavailableProfileResult(),
  );
});

test("profile-result sanitization fails closed for every adversarial endpoint-catalog layer", () => {
  const base = displayOnlyProfileResult();
  const profile = base.profile;
  const endpoint = profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const intensity = model.workIntensities[0]!;
  const cases: readonly { readonly name: string; readonly value: unknown }[] = [
    {
      name: "result accessor trap",
      value: new Proxy(
        {},
        {
          get() {
            throw new Error("PRIVATE_RESULT_ACCESSOR_TRAP");
          },
        },
      ),
    },
    { name: "extra result field", value: { ...base, extra: "PRIVATE_TOP_LEVEL" } },
    {
      name: "extra profile field",
      value: { ...base, profile: { ...profile, extra: "PRIVATE_PROFILE" } },
    },
    {
      name: "extra endpoint field",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, nativeAddress: "native://private-endpoint" }],
        },
      },
    },
    {
      name: "extra model field",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [{ ...model, nativeModel: "model-native-v2" }],
            },
          ],
        },
      },
    },
    {
      name: "promoListPrice model leakage",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [{ ...model, promoListPrice: "$20" }],
            },
          ],
        },
      },
    },
    {
      name: "unsafe model provenance",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [{ ...model, provenanceLabel: "native://private-model" }],
            },
          ],
        },
      },
    },
    {
      name: "extra option field",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [
                {
                  ...model,
                  workIntensities: [{ ...intensity, nativeValue: "x-high" }],
                },
              ],
            },
          ],
        },
      },
    },
    {
      name: "unknown implied execution option",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [
                {
                  ...model,
                  workIntensities: [
                    {
                      ...intensity,
                      impliedExecutionModeKey: coupledExecutionModeKey,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    {
      name: "missing required endpoint field",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              key: endpoint.key,
              runtimeFamilyLabel: endpoint.runtimeFamilyLabel,
              models: endpoint.models,
              executionModes: endpoint.executionModes,
              accessModes: endpoint.accessModes,
            },
          ],
        },
      },
    },
    {
      name: "malformed endpoint nesting",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, models: { private: true } }],
        },
      },
    },
    {
      name: "native-looking endpoint display value",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            { ...endpoint, endpointLabel: "native://private-endpoint" },
          ],
        },
      },
    },
    {
      name: "absolute path endpoint display value",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, endpointLabel: "/private/endpoint" }],
        },
      },
    },
    {
      name: "empty endpoint model list",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [{ ...endpoint, models: [] }],
        },
      },
    },
    {
      name: "malformed option display value",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [
                {
                  ...model,
                  workIntensities: [
                    { ...intensity, label: { display: "Deep focus" } },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    {
      name: "native-looking option display value",
      value: {
        ...base,
        profile: {
          ...profile,
          endpoints: [
            {
              ...endpoint,
              models: [
                {
                  ...model,
                  workIntensities: [
                    { ...intensity, label: "native://x-high" },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  ];

  for (const adversarial of cases) {
    const result = sanitizeWorkbenchDirectSessionProfileResult(adversarial.value);
    assert.deepEqual(result, unavailableProfileResult(), adversarial.name);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("PRIVATE_"), false, adversarial.name);
    assert.equal(serialized.includes("model-native-v2"), false, adversarial.name);
    assert.equal(serialized.includes("native://"), false, adversarial.name);
  }
});

test("profile-result sanitization rejects every discovery shape and coherence contradiction as a whole", () => {
  const base = displayOnlyProfileResult();
  const hiddenRoot = { ...base };
  Object.defineProperty(hiddenRoot, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolRoot = { ...base };
  Object.defineProperty(symbolRoot, Symbol("PRIVATE_TOKEN"), {
    value: "PRIVATE_TOKEN",
    enumerable: false,
  });
  const accessorDiscovery = endpointDiscovery(
    "catalog-ready",
    "not-inspected",
  );
  Object.defineProperty(accessorDiscovery.statuses[0], "category", {
    get() {
      throw new Error("PRIVATE_STATUS_ACCESSOR");
    },
    enumerable: true,
  });
  const statusesWithExtra = [
    ...endpointDiscovery("catalog-ready", "not-inspected").statuses,
  ];
  Object.defineProperty(statusesWithExtra, "nativeCommand", {
    value: "PRIVATE_COMMAND",
    enumerable: false,
  });
  const hiddenDiscovery = endpointDiscovery("catalog-ready", "not-inspected");
  Object.defineProperty(hiddenDiscovery, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolDiscovery = endpointDiscovery("catalog-ready", "not-inspected");
  Object.defineProperty(symbolDiscovery, Symbol("PRIVATE_DISCOVERY"), {
    value: "PRIVATE_DISCOVERY",
    enumerable: false,
  });
  const accessorDiscoveryRoot = {} as { statuses: unknown };
  Object.defineProperty(accessorDiscoveryRoot, "statuses", {
    get() {
      throw new Error("PRIVATE_DISCOVERY_ACCESSOR");
    },
    enumerable: true,
  });
  const prototypeDiscovery = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    endpointDiscovery("catalog-ready", "not-inspected"),
  );
  const sparseStatuses = new Array(2);
  sparseStatuses[0] = base.endpointDiscovery.statuses[0];
  const thirdStatuses = [
    ...base.endpointDiscovery.statuses,
    { endpointId: "codex-desktop", category: "not-inspected" },
  ];
  const accessorStatuses = [...base.endpointDiscovery.statuses];
  Object.defineProperty(accessorStatuses, "0", {
    get() {
      throw new Error("PRIVATE_STATUS_ARRAY_ACCESSOR");
    },
    enumerable: true,
  });
  const hiddenStatus = { ...base.endpointDiscovery.statuses[0]! };
  Object.defineProperty(hiddenStatus, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolStatus = { ...base.endpointDiscovery.statuses[0]! };
  Object.defineProperty(symbolStatus, Symbol("PRIVATE_STATUS"), {
    value: "PRIVATE_STATUS",
    enumerable: false,
  });
  const prototypeStatus = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    base.endpointDiscovery.statuses[0],
  );
  const exactFailure = {
    ok: false as const,
    endpointDiscovery: endpointDiscovery("not-inspected", "not-inspected"),
    error: {
      category: "profile-unavailable" as const,
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again." as const,
    },
  };
  const cases: readonly { readonly name: string; readonly value: unknown }[] = [
    { name: "hidden top-level key", value: hiddenRoot },
    { name: "symbol top-level key", value: symbolRoot },
    {
      name: "discovery root extra",
      value: {
        ...base,
        endpointDiscovery: {
          ...base.endpointDiscovery,
          executable: "PRIVATE_EXECUTABLE",
        },
      },
    },
    {
      name: "discovery root hidden key",
      value: { ...base, endpointDiscovery: hiddenDiscovery },
    },
    {
      name: "discovery root symbol key",
      value: { ...base, endpointDiscovery: symbolDiscovery },
    },
    {
      name: "discovery root accessor",
      value: { ...base, endpointDiscovery: accessorDiscoveryRoot },
    },
    {
      name: "discovery root custom prototype",
      value: { ...base, endpointDiscovery: prototypeDiscovery },
    },
    {
      name: "status row extra",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [
            {
              ...base.endpointDiscovery.statuses[0],
              nativeError: "PRIVATE_ERROR",
            },
            base.endpointDiscovery.statuses[1],
          ],
        },
      },
    },
    {
      name: "status array hidden key",
      value: { ...base, endpointDiscovery: { statuses: statusesWithExtra } },
    },
    {
      name: "sparse status tuple",
      value: { ...base, endpointDiscovery: { statuses: sparseStatuses } },
    },
    {
      name: "third status row",
      value: { ...base, endpointDiscovery: { statuses: thirdStatuses } },
    },
    {
      name: "status tuple accessor",
      value: { ...base, endpointDiscovery: { statuses: accessorStatuses } },
    },
    {
      name: "status row hidden key",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [hiddenStatus, base.endpointDiscovery.statuses[1]],
        },
      },
    },
    {
      name: "status row symbol key",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [symbolStatus, base.endpointDiscovery.statuses[1]],
        },
      },
    },
    {
      name: "status row custom prototype",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [prototypeStatus, base.endpointDiscovery.statuses[1]],
        },
      },
    },
    {
      name: "status accessor",
      value: { ...base, endpointDiscovery: accessorDiscovery },
    },
    {
      name: "duplicate endpoint identity",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [
            base.endpointDiscovery.statuses[0],
            {
              endpointId: "codex-desktop",
              category: "not-inspected",
            },
          ],
        },
      },
    },
    {
      name: "swapped endpoint order",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [
            {
              endpointId: "claude-code-desktop",
              category: "not-inspected",
            },
            {
              endpointId: "codex-desktop",
              category: "catalog-ready",
            },
          ],
        },
      },
    },
    {
      name: "unknown category",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [
            { endpointId: "codex-desktop", category: "PRIVATE_UNKNOWN" },
            base.endpointDiscovery.statuses[1],
          ],
        },
      },
    },
    {
      name: "unknown Claude category",
      value: {
        ...base,
        endpointDiscovery: {
          statuses: [
            base.endpointDiscovery.statuses[0],
            {
              endpointId: "claude-code-desktop",
              category: "PRIVATE_UNKNOWN",
            },
          ],
        },
      },
    },
    {
      name: "ready catalog identity mismatch",
      value: {
        ...base,
        endpointDiscovery: endpointDiscovery("not-inspected", "catalog-ready"),
      },
    },
    {
      name: "success without a ready catalog",
      value: {
        ...base,
        endpointDiscovery: endpointDiscovery(
          "inspection-failed",
          "not-inspected",
        ),
      },
    },
    {
      name: "failure with a ready catalog",
      value: {
        ...exactFailure,
        endpointDiscovery: endpointDiscovery("catalog-ready", "not-inspected"),
      },
    },
    {
      name: "aggregate failure contradiction",
      value: {
        ...exactFailure,
        endpointDiscovery: endpointDiscovery(
          "runtime-not-located",
          "runtime-not-located",
        ),
      },
    },
    {
      name: "failure top-level extra",
      value: { ...exactFailure, account: "PRIVATE_ACCOUNT" },
    },
    {
      name: "failure error extra",
      value: {
        ...exactFailure,
        error: { ...exactFailure.error, nativeId: "PRIVATE_NATIVE_ID" },
      },
    },
  ];

  for (const adversarial of cases) {
    const result = sanitizeWorkbenchDirectSessionProfileResult(adversarial.value);
    assert.deepEqual(result, unavailableProfileResult(), adversarial.name);
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false, adversarial.name);
  }
});

test("profile-result sanitization preserves Claude authentication-required beside an independent ready Codex catalog", () => {
  const base = displayOnlyProfileResult();
  const result = sanitizeWorkbenchDirectSessionProfileResult({
    ...base,
    endpointDiscovery: {
      statuses: [
        base.endpointDiscovery.statuses[0],
        {
          endpointId: "claude-code-desktop",
          category: "authentication-required",
        },
        base.endpointDiscovery.statuses[2],
        base.endpointDiscovery.statuses[3],
        base.endpointDiscovery.statuses[4],
        base.endpointDiscovery.statuses[5],
        base.endpointDiscovery.statuses[6],
        base.endpointDiscovery.statuses[7],
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.endpointDiscovery.statuses, [
    { endpointId: "codex-desktop", category: "catalog-ready" },
    {
      endpointId: "claude-code-desktop",
      category: "authentication-required",
    },
    { endpointId: "glm-coding-plan", category: "not-inspected" },
    { endpointId: "kimi-code", category: "not-inspected" },
    { endpointId: "deepseek-api", category: "not-inspected" },
    { endpointId: "kimi-platform", category: "not-inspected" },
    { endpointId: "claude-api", category: "not-inspected" },
    { endpointId: "codex-api", category: "not-inspected" },
  ]);
  assert.equal(Object.isFrozen(result.endpointDiscovery.statuses), true);
});

test("profile-result sanitization rejects cross-endpoint default and intensity relations", () => {
  const base = displayOnlyProfileResult();
  const endpoint = base.profile.endpoints[0]!;
  const secondEndpoint = {
    ...endpoint,
    endpointId: "claude-code-desktop" as const,
    key: "endpoint-option:2:00000000-0000-4000-8000-000000000009",
    runtimeFamilyLabel: "Nimbus Runtime",
    endpointLabel: "Nimbus Relay",
    models: [
      {
        ...endpoint.models[0]!,
        key: "model-option:2:00000000-0000-4000-8000-000000000010",
        workIntensities: [
          {
            key: "intensity-option:2:00000000-0000-4000-8000-000000000011",
            label: "Structured review",
          },
        ],
      },
    ],
    executionModes: [
      {
        key: "execution-option:2:00000000-0000-4000-8000-000000000012",
        label: "Single agent",
      },
    ],
    accessModes: [
      {
        key: "access-option:2:00000000-0000-4000-8000-000000000013",
        label: "Full access",
      },
    ],
  };
  const malformedDefault = {
    ...base,
    endpointDiscovery: endpointDiscovery("catalog-ready", "catalog-ready"),
    profile: {
      ...base.profile,
      endpoints: [endpoint, secondEndpoint],
      desiredDefault: {
        ...base.profile.desiredDefault,
        endpointKey: endpoint.key,
        modelKey: secondEndpoint.models[0]!.key,
      },
    },
  };
  const malformedIntensity = {
    ...base,
    endpointDiscovery: endpointDiscovery("catalog-ready", "catalog-ready"),
    profile: {
      ...base.profile,
      endpoints: [
        {
          ...endpoint,
          models: [
            {
              ...endpoint.models[0]!,
              workIntensities: [
                {
                  ...endpoint.models[0]!.workIntensities[0]!,
                  impliedExecutionModeKey:
                    secondEndpoint.executionModes[0]!.key,
                },
              ],
            },
          ],
        },
        secondEndpoint,
      ],
    },
  };

  for (const malformed of [malformedDefault, malformedIntensity]) {
    assert.deepEqual(
      sanitizeWorkbenchDirectSessionProfileResult(malformed),
      unavailableProfileResult(),
    );
  }
});

test("Project-selection reconstruction accepts only one opaque exact-snapshot key", () => {
  const request = { selectionKey: projectSelectionKey };
  assert.deepEqual(reconstructWorkbenchProjectSelectionRequest(request), {
    ok: true,
    request,
  });
  for (const malformed of [
    undefined,
    {},
    { selectionKey: "project-selection:forged" },
    { selectionKey: projectSelectionKey, extra: true },
    { selectionKey: projectSelectionKey, path: "C:\\private\\Project" },
    { selectionKey: projectSelectionKey, durableKey: "PRIVATE_RECORD" },
    { selectionKey: projectSelectionKey, ledger: "PRIVATE_LEDGER" },
  ]) {
    assert.deepEqual(reconstructWorkbenchProjectSelectionRequest(malformed), {
      ok: false,
    });
  }

  const hidden = { ...request };
  Object.defineProperty(hidden, "hiddenAuthority", {
    enumerable: false,
    value: "PRIVATE_HIDDEN",
  });
  const accessor = {};
  Object.defineProperty(accessor, "selectionKey", {
    enumerable: true,
    get: () => projectSelectionKey,
  });
  for (const hostile of [
    hidden,
    { ...request, [Symbol("private-authority")]: true },
    Object.assign(
      Object.create({ inheritedAuthority: "PRIVATE_INHERITED" }) as object,
      request,
    ),
    accessor,
    new Proxy({ ...request }, {}),
  ]) {
    assert.deepEqual(reconstructWorkbenchProjectSelectionRequest(hostile), {
      ok: false,
    });
  }
});

test("hosted Project sanitization preserves duplicate labels only for exact public shapes", () => {
  const incoming = {
    ok: true,
    view: {
      project: { label: "Shared Name" },
      observation: { cursor: 3, live: true },
      commands: [],
      initialSelectionKey: null,
      projectSelection: {
        projects: [
          {
            label: "Shared Name",
            availability: "available",
            selected: true,
            selectionKey: projectSelectionKey,
          },
          {
            label: "Shared Name",
            availability: "missing",
            selected: false,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000006",
          },
        ],
      },
    },
  };
  const sanitized = sanitizeWorkbenchHostedProjectResult(incoming);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok || "empty" in sanitized) {
    assert.fail("Expected a sanitized hosted Project.");
  }
  assert.deepEqual(
    hostedProjectView(sanitized).projectSelection.projects.map((project) => ({
      label: project.label,
      availability: project.availability,
      selected: project.selected,
      fields: Object.keys(project).sort(),
    })),
    [
      {
        label: "Shared Name",
        availability: "available",
        selected: true,
        fields: ["availability", "label", "selected", "selectionKey"],
      },
      {
        label: "Shared Name",
        availability: "missing",
        selected: false,
        fields: ["availability", "label", "selected", "selectionKey"],
      },
    ],
  );
  assert.equal(Object.isFrozen(hostedProjectView(sanitized).projectSelection.projects), true);

  for (const widened of [
    { ...incoming, privateRegistry: "PRIVATE_REGISTRY" },
    {
      ...incoming,
      view: { ...incoming.view, projectId: "PRIVATE_PROJECT" },
    },
    {
      ...incoming,
      view: {
        ...incoming.view,
        projectSelection: {
          projects: incoming.view.projectSelection.projects.map((project, index) =>
            index === 0 ? { ...project, recordKey: "PRIVATE_RECORD" } : project,
          ),
        },
      },
    },
  ]) {
    const rejected = sanitizeWorkbenchHostedProjectResult(widened);
    assert.equal(rejected.ok, false);
    assert.equal(JSON.stringify(rejected).includes("PRIVATE_"), false);
  }
});

test("hosted Project sanitization accepts only the exact empty registry result", () => {
  const publicEmpty = publicEmptyProjectRegistry();
  assert.deepEqual(publicEmpty, { ok: true, empty: true });
  assert.deepEqual(Object.keys(publicEmpty).sort(), ["empty", "ok"]);
  assert.equal(Object.isFrozen(publicEmpty), true);

  const empty = sanitizeWorkbenchHostedProjectResult(publicEmpty);
  assert.deepEqual(empty, { ok: true, empty: true });
  assert.equal(Object.isFrozen(empty), true);

  assert.deepEqual(
    sanitizeWorkbenchHostedProjectResult({
      ok: true,
      empty: true,
      extra: true,
    }),
    {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    },
  );
});

test("hosted Project sanitization uses the Host's 80-code-point label boundary", () => {
  const label = "\u{1f642}".repeat(41);
  const sanitized = sanitizeWorkbenchHostedProjectResult({
    ok: true,
    view: {
      project: { label },
      observation: { cursor: 4, live: true },
      commands: [],
      initialSelectionKey: null,
      projectSelection: {
        projects: [
          {
            label,
            availability: "available",
            selected: true,
            selectionKey: projectSelectionKey,
          },
        ],
      },
    },
  });

  assert.equal([...label].length, 41);
  assert.equal(label.length, 82);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok || "empty" in sanitized) {
    assert.fail("Expected a Unicode Project label.");
  }
  assert.equal(sanitized.view.project.label, label);
  assert.equal(sanitized.view.projectSelection.projects[0]?.label, label);
});

test("hosted Project sanitization fails closed for ambiguous, path-bearing, and malformed snapshots", () => {
  const base = {
    ok: true,
    view: {
      project: { label: "Visible Project" },
      observation: { cursor: 0, live: true },
      commands: [],
      initialSelectionKey: null,
      projectSelection: {
        projects: [
          {
            label: "Visible Project",
            availability: "available",
            selected: true,
            selectionKey: projectSelectionKey,
          },
        ],
      },
    },
  };
  const malformed = [
    { ...base, view: { ...base.view, projectSelection: undefined } },
    {
      ...base,
      view: {
        ...base.view,
        projectSelection: { projects: [] },
      },
    },
    {
      ...base,
      view: {
        ...base.view,
        projectSelection: {
          projects: [
            ...base.view.projectSelection.projects,
            {
              ...base.view.projectSelection.projects[0],
              selected: false,
            },
          ],
        },
      },
    },
    {
      ...base,
      view: {
        ...base.view,
        projectSelection: {
          projects: [
            {
              ...base.view.projectSelection.projects[0],
              label: "C:\\private\\Project",
            },
          ],
        },
      },
    },
    {
      ...base,
      view: {
        ...base.view,
        projectSelection: {
          projects: [
            {
              ...base.view.projectSelection.projects[0],
              selectionKey: "project-selection:forged",
            },
          ],
        },
      },
    },
    {
      ...base,
      view: {
        ...base.view,
        project: { label: "Different Project" },
      },
    },
  ];
  for (const value of malformed) {
    assert.deepEqual(sanitizeWorkbenchHostedProjectResult(value), {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    });
  }
});

test("Project-selection results are reconstructed into fixed public copy", () => {
  assert.deepEqual(
    sanitizeWorkbenchProjectSelectionResult({
      ok: true,
      status: "selected",
      message: "Project was opened.",
      recordKey: "PRIVATE_RECORD",
    }),
    {
      ok: true,
      status: "selected",
      message: "Project was opened.",
    },
  );
  assert.deepEqual(
    sanitizeWorkbenchProjectSelectionResult({
      ok: false,
      error: {
        category: "project-unavailable",
        message:
          "This Project is unavailable. Choose another Project or restore its directory.",
        path: "C:\\private\\Project",
      },
    }),
    {
      ok: false,
      error: {
        category: "project-unavailable",
        message:
          "This Project is unavailable. Choose another Project or restore its directory.",
      },
    },
  );
  assert.deepEqual(
    sanitizeWorkbenchProjectSelectionResult({
      ok: false,
      error: { category: "project-unavailable", message: "PRIVATE_MESSAGE" },
    }),
    {
      ok: false,
      error: {
        category: "project-switch-unavailable",
        message:
          "The Project could not be opened. Keep the current Project and try again.",
      },
    },
  );
});

test("Open Project results reconstruct only fixed opened, cancelled, or unavailable copy", () => {
  const opened = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "opened",
    message: "Project was opened.",
    filePaths: ["C:\\private\\Opened Project"],
    nativeValue: "PRIVATE_NATIVE_VALUE",
  });
  const cancelled = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
    filePaths: ["C:\\private\\Cancelled Project"],
  });
  const unavailable = sanitizeWorkbenchOpenProjectResult({
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
      path: "C:\\private\\Failed Project",
    },
  });
  const malformed = sanitizeWorkbenchOpenProjectResult({
    ok: true,
    status: "opened",
    message: "PRIVATE_MESSAGE",
    directory: "C:\\private\\Malformed Project",
  });

  assert.deepEqual(opened, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.deepEqual(cancelled, {
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
  });
  assert.deepEqual(unavailable, {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    },
  });
  assert.deepEqual(malformed, unavailable);
  const serialized = JSON.stringify({ opened, cancelled, unavailable, malformed });
  for (const forbidden of [
    "C:\\private",
    "filePaths",
    "nativeValue",
    "directory",
    "PRIVATE_",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("Create Project results reconstruct exactly one frozen outcome field", () => {
  const values = [
    "created",
    "cancelled",
    "unavailable",
    "created-recovery-required",
  ] as const;

  for (const outcome of values) {
    const result = sanitizeWorkbenchCreateProjectResult({
      outcome,
      target: "C:\\private\\Created Project",
      targetToken: "PRIVATE_CORRELATION",
      nativeValue: "PRIVATE_NATIVE_VALUE",
    });
    assert.deepEqual(result, { outcome });
    assert.deepEqual(Object.keys(result), ["outcome"]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
    assert.equal(JSON.stringify(result).includes("Created Project"), false);
  }

  for (const malformed of [
    undefined,
    null,
    {},
    { outcome: "created-with-template" },
    { get outcome() { throw new Error("PRIVATE_ACCESSOR"); } },
  ]) {
    assert.deepEqual(sanitizeWorkbenchCreateProjectResult(malformed), {
      outcome: "unavailable",
    });
  }
});

test("Project sanitization retains only an exact opaque Session removal capability", () => {
  const resultFor = (session: Record<string, unknown>) => ({
    ok: true,
    view: {
      project: { label: "Removal Project" },
      observation: { cursor: 8, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session,
        },
      ],
      initialSelectionKey: "command-1",
    },
  });
  const session = {
    archived: false,
    metadataKey,
    profile: projectedProfile,
    timeline: [],
    removalKey,
    selectionKey,
    resumable: true,
  };

  const valid = sanitizeWorkbenchProjectResult(resultFor(session));
  assert.equal(valid.ok, true);
  if (!valid.ok) assert.fail("Expected a sanitized removal capability.");
  assert.deepEqual(valid.view.commands[0]?.session, session);
  assert.equal(JSON.stringify(valid).includes("sessionId"), false);

  for (const [name, candidate] of [
    ["missing", { ...session, removalKey: undefined }],
    ["forged prefix", { ...session, removalKey: selectionKey }],
    ["malformed UUID", { ...session, removalKey: "session-removal:forged" }],
    ["widened with durable identity", { ...session, sessionId: "PRIVATE_ID" }],
  ] as const) {
    const malformed = { ...candidate };
    if (name === "missing") delete malformed.removalKey;
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(resultFor(malformed)),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      name,
    );
  }
});

test("Project profile projection sanitization accepts one exact display shape and rejects each adversarial row independently", () => {
  const valid = {
    ok: true,
    view: {
      project: { label: "Projection Project" },
      observation: { cursor: 4, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session: {
            archived: false,
            metadataKey,
            profile: projectedProfile,
            timeline: [],
            removalKey,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  };
  assert.deepEqual(sanitizeWorkbenchProjectResult(valid), valid, "valid projection");

  const cases: readonly {
    readonly name: string;
    readonly value: unknown;
    readonly runtime?: string;
  }[] = [
    {
      name: "requested extra field",
      value: {
        ...projectedProfile,
        requested: { ...projectedProfile.requested, nativeModel: "PRIVATE_NATIVE" },
      },
    },
    {
      name: "requested full path",
      value: {
        ...projectedProfile,
        requested: {
          ...projectedProfile.requested,
          endpointLabel: "C:\\private\\endpoint",
        },
      },
    },
    {
      name: "requested opaque key",
      value: {
        ...projectedProfile,
        requested: {
          ...projectedProfile.requested,
          modelLabel: "Dm_jNv_EMAy_Y0OVELFexo_UKhItXc68dWq5HaRT2EVTas",
        },
      },
    },
    {
      name: "effective native mismatch label",
      value: {
        ...projectedProfile,
        effective: {
          ...projectedProfile.effective,
          workIntensity: {
            label: "PRIVATE_NATIVE_EFFORT",
            comparison: "differs-from-requested",
          },
        },
      },
    },
    {
      name: "historical fabricated effective",
      value: {
        requested: { kind: "not-recorded" },
        effective: { kind: "unknown" },
      },
    },
    {
      name: "runtime projection mismatch",
      value: projectedProfile,
      runtime: "Different Runtime",
    },
    {
      name: "auth-bearing label",
      value: {
        ...projectedProfile,
        requested: {
          ...projectedProfile.requested,
          modelLabel: "Bearer PRIVATE_CREDENTIAL",
        },
      },
    },
  ];
  for (const fixture of cases) {
    const candidate = structuredClone(valid);
    candidate.view.commands[0]!.session.profile = fixture.value as never;
    if (fixture.runtime !== undefined) {
      candidate.view.commands[0]!.runtime = fixture.runtime;
    }
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(candidate),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      fixture.name,
    );
  }
});

test("Project turn attribution sanitization preserves exact aligned profiles and fails closed on drift", () => {
  const historicalProfile = {
    requested: { kind: "not-recorded" },
    effective: { kind: "not-recorded" },
  } as const;
  const firstTimeline = [
    { kind: "user-message", text: "legacy turn" },
    { kind: "agent-message", text: "legacy reply" },
  ];
  const secondTimeline = [
    { kind: "user-message", text: "current turn" },
    { kind: "turn-started" },
    { kind: "agent-message", text: "current reply" },
    { kind: "turn-completed", status: "completed" },
  ];
  const valid = {
    ok: true,
    view: {
      project: { label: "Turn Project" },
      observation: { cursor: 9, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session: {
            archived: false,
            metadataKey,
            profile: projectedProfile,
            timeline: [...firstTimeline, ...secondTimeline],
            turns: [
              { profile: historicalProfile, timeline: firstTimeline },
              { profile: projectedProfile, timeline: secondTimeline },
            ],
            removalKey,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  };
  const sanitized = sanitizeWorkbenchProjectResult(valid);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("Expected exact turn attribution.");
  const turns = sanitized.view.commands[0]?.session?.turns;
  assert.deepEqual(turns, valid.view.commands[0]?.session.turns);
  assert.equal(Object.isFrozen(turns), true);
  assert.equal(turns?.every((turn) => Object.isFrozen(turn)), true);

  const legacyTransport = structuredClone(valid);
  delete (legacyTransport.view.commands[0]!.session as { turns?: unknown }).turns;
  assert.equal(
    sanitizeWorkbenchProjectResult(legacyTransport).ok,
    true,
    "an older transport shape remains readable without inventing attribution",
  );

  const adversarial: readonly { readonly name: string; readonly mutate: (value: typeof valid) => void }[] = [
    {
      name: "turn extra field",
      mutate: (value) => {
        (value.view.commands[0]!.session.turns[0] as Record<string, unknown>).nativeModel =
          "PRIVATE_NATIVE";
      },
    },
    {
      name: "turn profile extra field",
      mutate: (value) => {
        (value.view.commands[0]!.session.turns[0]!.profile as Record<string, unknown>).nativeEffort =
          "PRIVATE_NATIVE";
      },
    },
    {
      name: "flattened timeline drift",
      mutate: (value) => {
        value.view.commands[0]!.session.timeline[0] = {
          kind: "user-message",
          text: "different",
        };
      },
    },
    {
      name: "turn order drift",
      mutate: (value) => {
        value.view.commands[0]!.session.turns.reverse();
      },
    },
    {
      name: "latest profile drift",
      mutate: (value) => {
        value.view.commands[0]!.session.profile = historicalProfile as never;
      },
    },
    {
      name: "older Runtime mismatch",
      mutate: (value) => {
        value.view.commands[0]!.session.turns[0]!.profile = {
          ...projectedProfile,
          requested: {
            ...projectedProfile.requested,
            runtimeFamilyLabel: "Different Runtime",
          },
        } as never;
      },
    },
    {
      name: "historical fabricated effective",
      mutate: (value) => {
        value.view.commands[0]!.session.turns[0]!.profile = {
          requested: { kind: "not-recorded" },
          effective: { kind: "unknown" },
        } as never;
      },
    },
  ];
  for (const row of adversarial) {
    const candidate = structuredClone(valid);
    row.mutate(candidate);
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(candidate),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      row.name,
    );
  }
});

test("Project context sanitization carries one exact frozen pair and rejects each adversarial row", () => {
  const valid = {
    ok: true,
    view: {
      project: { label: "Context Project" },
      observation: { cursor: 5, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session: {
            archived: false,
            metadataKey,
            context: { usedTokens: 144, windowTokens: 258_400 },
            profile: projectedProfile,
            timeline: [{ kind: "turn-completed", status: "completed" }],
            removalKey,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  };
  const sanitized = sanitizeWorkbenchProjectResult(valid);
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("Expected a sanitized context view.");
  assert.deepEqual(sanitized.view.commands[0]?.session?.context, {
    usedTokens: 144,
    windowTokens: 258_400,
  });
  assert.equal(Object.isFrozen(sanitized.view.commands[0]?.session?.context), true);

  const unknownWindow = structuredClone(valid);
  unknownWindow.view.commands[0]!.session.context.windowTokens = null as never;
  const unknownWindowResult = sanitizeWorkbenchProjectResult(unknownWindow);
  assert.equal(unknownWindowResult.ok, true, "null means the Runtime reported no window");

  const absent = structuredClone(valid);
  delete (absent.view.commands[0]!.session as { context?: unknown }).context;
  const absentResult = sanitizeWorkbenchProjectResult(absent);
  assert.equal(absentResult.ok, true, "unreported context remains compatible");
  if (absentResult.ok) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        absentResult.view.commands[0]?.session ?? {},
        "context",
      ),
      false,
    );
  }

  const adversarial = [
    { name: "negative count", value: { usedTokens: -1, windowTokens: 258_400 } },
    {
      name: "non-integer count",
      value: { usedTokens: 1.5, windowTokens: 258_400 },
    },
    {
      name: "window smaller than used",
      value: { usedTokens: 144, windowTokens: 143 },
    },
    {
      name: "window present but not a number",
      value: { usedTokens: 144, windowTokens: "258400" },
    },
    {
      name: "unrecognized extra key",
      value: { usedTokens: 144, windowTokens: 258_400, nativeExtra: true },
    },
  ];
  for (const row of adversarial) {
    const candidate = structuredClone(valid);
    candidate.view.commands[0]!.session.context = row.value as never;
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(candidate),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      row.name,
    );
  }
});

test("Project prompt suggestions cross the renderer boundary exactly or reject the whole view", () => {
  const suggestion = "Inspect C:\\project\\src and explain the next step";
  const resultWith = (event: unknown) => ({
    ok: true,
    view: {
      project: { label: "Suggestion Project" },
      observation: { cursor: 6, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session: {
            archived: false,
            metadataKey,
            profile: projectedProfile,
            timeline: [event],
            removalKey,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  });
  const sanitized = sanitizeWorkbenchProjectResult(
    resultWith({
      kind: "turn-completed",
      status: "completed",
      suggestions: [suggestion, "Run the focused tests"],
    }),
  );
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("Expected exact prompt suggestions.");
  const terminal = sanitized.view.commands[0]?.session?.timeline[0];
  assert.deepEqual(terminal, {
    kind: "turn-completed",
    status: "completed",
    suggestions: [suggestion, "Run the focused tests"],
  });
  assert.equal(
    terminal?.kind === "turn-completed" && Object.isFrozen(terminal.suggestions),
    true,
  );

  for (const suggestions of [
    [],
    [42],
    [" \t\n "],
    ["bad\u000bcontrol"],
    ["valid", "x".repeat(8_001)],
  ]) {
    assert.equal(
      sanitizeWorkbenchProjectResult(
        resultWith({ kind: "turn-completed", status: "completed", suggestions }),
      ).ok,
      false,
      JSON.stringify(suggestions),
    );
  }
});

test("Project user-message sanitization preserves one exact frozen event and fails closed on every adversarial row", () => {
  const prefix = "C:\\literal-user\\token.txt\nTOKEN_sk_literal";
  const suffix = "\t\r\n🙂";
  const exactBoundary = `${prefix}${"x".repeat(8_000 - prefix.length - suffix.length)}${suffix}`;
  assert.equal(exactBoundary.length, 8_000);

  const projectResult = (event: unknown) => ({
    ok: true,
    view: {
      project: { label: "Message Project" },
      observation: { cursor: 6, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session: {
            archived: false,
            metadataKey,
            profile: projectedProfile,
            timeline: [event],
            removalKey,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  });
  const sanitized = sanitizeWorkbenchProjectResult(
    projectResult({ kind: "user-message", text: exactBoundary }),
  );
  assert.equal(sanitized.ok, true);
  if (!sanitized.ok) assert.fail("Expected a sanitized user message.");
  const event = sanitized.view.commands[0]?.session?.timeline[0];
  assert.deepEqual(event, { kind: "user-message", text: exactBoundary });
  assert.deepEqual(Object.keys(event ?? {}).sort(), ["kind", "text"]);
  assert.equal(Object.isFrozen(event), true);

  const adversarial = [
    { name: "missing kind", value: { text: "valid" } },
    { name: "wrong kind", value: { kind: 42, text: "valid" } },
    { name: "missing text", value: { kind: "user-message" } },
    { name: "wrong text", value: { kind: "user-message", text: 42 } },
    {
      name: "unrecognized extra key",
      value: { kind: "user-message", text: "valid", nativeExtra: true },
    },
    {
      name: "8,001 code units",
      value: { kind: "user-message", text: "x".repeat(8_001) },
    },
    {
      name: "whitespace only",
      value: { kind: "user-message", text: " \t\r\n " },
    },
    {
      name: "forbidden C0 control",
      value: { kind: "user-message", text: "before\u000bafter" },
    },
    {
      name: "DEL",
      value: { kind: "user-message", text: "before\u007fafter" },
    },
    {
      name: "C1 control",
      value: { kind: "user-message", text: "before\u0085after" },
    },
    {
      name: "unpaired high surrogate",
      value: { kind: "user-message", text: "before\ud800after" },
    },
    {
      name: "unpaired low surrogate",
      value: { kind: "user-message", text: "before\udc00after" },
    },
  ];
  for (const row of adversarial) {
    assert.deepEqual(
      sanitizeWorkbenchProjectResult(projectResult(row.value)),
      {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
      row.name,
    );
  }
});

function displayOnlyProfileResult() {
  return {
    ok: true as const,
    endpointDiscovery: endpointDiscovery("catalog-ready", "not-inspected"),
    profile: {
      snapshotKey,
      endpoints: [
        {
          endpointId: "codex-desktop" as const,
          key: endpointKey,
          runtimeFamilyLabel: "Quartz Runtime",
          endpointLabel: "Quartz Studio",
          models: [
            {
              key: modelKey,
              label: "Runtime Model Deluxe",
              provenanceLabel: "Runtime Model Deluxe display wording",
              workIntensityLabel: "Reasoning Budget",
              workIntensities: [
                { key: workIntensityKey, label: "Deep focus" },
              ],
            },
          ],
          executionModes: [
            { key: executionModeKey, label: "Single agent" },
          ],
          accessModes: [
            { key: accessModeKey, label: "Full access" },
          ],
        },
      ],
      desiredDefault: {
        kind: "resolved" as const,
        endpointKey,
        modelKey,
        workIntensityKey,
        executionModeKey,
        accessModeKey,
      },
    },
  };
}

function replacementProfileResult(
  replacementPrefill:
    | {
        readonly kind: "resolved";
        readonly endpointKey: string;
        readonly modelKey: string;
        readonly workIntensityKey: string;
        readonly executionModeKey: string;
        readonly accessModeKey: string;
      }
    | { readonly kind: "manual-selection-required" },
) {
  const base = displayOnlyProfileResult();
  const { desiredDefault: _desiredDefault, ...catalog } = base.profile;
  return {
    ...base,
    profile: {
      ...catalog,
      replacementPrefill,
    },
  };
}

function continuationProfileResult() {
  const base = displayOnlyProfileResult();
  const { desiredDefault: _desiredDefault, ...catalog } = base.profile;
  return {
    ...base,
    profile: {
      ...catalog,
      continuationPrefill: {
        kind: "resolved" as const,
        endpointKey,
        modelKey,
        workIntensityKey,
        executionModeKey,
        accessModeKey,
      },
    },
  };
}

function unavailableProfileResult() {
  return {
    ok: false as const,
    endpointDiscovery: endpointDiscovery("not-inspected", "not-inspected"),
    error: {
      category: "profile-unavailable" as const,
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again." as const,
    },
  };
}

function endpointDiscovery(
  codexCategory:
    | "catalog-ready"
    | "runtime-not-located"
    | "authentication-required"
    | "inspection-failed"
    | "not-inspected",
  claudeCategory:
    | "catalog-ready"
    | "runtime-not-located"
    | "inspection-failed"
    | "not-inspected",
) {
  return {
    statuses: [
      { endpointId: "codex-desktop" as const, category: codexCategory },
      { endpointId: "claude-code-desktop" as const, category: claudeCategory },
      // The static-key endpoints carry no catalog in these two-endpoint
      // fixtures (never catalog-ready) and share the aggregate
      // runtime-not-located verdict when both desktop runtimes are absent.
      {
        endpointId: "glm-coding-plan" as const,
        category:
          codexCategory === "runtime-not-located" &&
          claudeCategory === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("not-inspected" as const),
      },
      {
        endpointId: "kimi-code" as const,
        category:
          codexCategory === "runtime-not-located" &&
          claudeCategory === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("not-inspected" as const),
      },
      {
        endpointId: "deepseek-api" as const,
        category:
          codexCategory === "runtime-not-located" &&
          claudeCategory === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("not-inspected" as const),
      },
      {
        endpointId: "kimi-platform" as const,
        category:
          codexCategory === "runtime-not-located" &&
          claudeCategory === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("not-inspected" as const),
      },
      {
        endpointId: "claude-api" as const,
        category:
          codexCategory === "runtime-not-located" &&
          claudeCategory === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("not-inspected" as const),
      },
      {
        endpointId: "codex-api" as const,
        category:
          codexCategory === "runtime-not-located" &&
          claudeCategory === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("not-inspected" as const),
      },
    ] as const,
  };
}

function mutatingProxyCase<T extends object>(
  name: string,
  target: T,
  property: PropertyKey,
  privateValue: unknown,
  build: (proxy: T) => unknown,
): {
  readonly name: string;
  readonly value: unknown;
  readonly reads: () => number;
} {
  let reads = 0;
  const proxy = new Proxy(target, {
    get(current, currentProperty, receiver) {
      if (currentProperty === property) {
        reads += 1;
        if (reads > 1) return privateValue;
      }
      return Reflect.get(current, currentProperty, receiver);
    },
  });
  return Object.freeze({ name, value: build(proxy), reads: () => reads });
}

test("timeline sanitization keeps code comments readable while still redacting real paths", () => {
  const agentText = [
    "```js",
    "// 主进程 main.js",
    "const { app } = require('electron') /* entry */",
    "app.whenReady() // 输出: ready",
    "```",
    "Docs at https://example.com/docs/start.",
    "Never expose /home/user/.ssh/id_rsa, C:\\Users\\someone\\secret.txt,",
    "\\\\fileserver\\share\\payroll.xlsx, //fileserver/share/payroll.xlsx,",
    "or file:///C:/Users/someone/token.key.",
  ].join("\n");
  const expectedText = [
    "```js",
    "// 主进程 main.js",
    "const { app } = require('electron') /* entry */",
    "app.whenReady() // 输出: ready",
    "```",
    "Docs at https://example.com/docs/start.",
    "Never expose [path] [path]",
    "[path] [path]",
    "or [path]",
  ].join("\n");
  const result = sanitizeWorkbenchProjectResult({
    ok: true,
    view: {
      project: { label: "Turn Project" },
      observation: { cursor: 9, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Quartz",
          status: "completed",
          session: {
            archived: false,
            metadataKey,
            profile: projectedProfile,
            timeline: [
              { kind: "user-message", text: "show the preload wiring" },
              { kind: "agent-message", text: agentText },
            ],
            removalKey,
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
    },
  });
  assert.equal(result.ok, true, "the valid view must sanitize, not fail closed");
  if (!result.ok) assert.fail("unreachable");
  assert.deepEqual(result.view.commands[0]?.session?.timeline[1], {
    kind: "agent-message",
    text: expectedText,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("id_rsa"), false, "POSIX path must redact");
  assert.equal(serialized.includes("secret.txt"), false, "drive path must redact");
  assert.equal(serialized.includes("payroll.xlsx"), false, "UNC paths must redact");
  assert.equal(serialized.includes("token.key"), false, "file URL must redact");
});
