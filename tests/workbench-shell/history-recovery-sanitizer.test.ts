import assert from "node:assert/strict";
import test from "node:test";

import {
  historyRecoveryProblem,
  type HistoryRecoveryBrowseRequest,
  type HistoryRecoveryPerformRequest,
} from "../../src/workbench-shell/history-recovery-contract.ts";
import {
  reconstructHistoryRecoveryBrowseRequest,
  reconstructHistoryRecoveryCancelRequest,
  reconstructHistoryRecoveryPerformRequest,
  reconstructHistoryRecoverySnapshotRequest,
  sanitizeHistoryRecoveryActionResult,
  sanitizeHistoryRecoveryBrowseResult,
  sanitizeHistoryRecoveryCancelResult,
  sanitizeHistoryRecoverySnapshotResult,
} from "../../src/workbench-shell/history-recovery-sanitizer.ts";

const counts = Object.freeze({ projects: 1, sessions: 1, commands: 2, updates: 4 });
const emptyCounts = Object.freeze({ projects: 0, sessions: 0, commands: 0, updates: 0 });

test("shared counts in a valid snapshot are accepted", (t) => {
  const clone = t.mock.method(globalThis, "structuredClone");
  const valid = validSnapshotResult("shared-counts");
  const sources = [valid.snapshot.sources[0], {
    ...valid.snapshot.sources[0], sourceKey: "source-2", label: "Historical store 2",
  }];
  assert.equal(sources[0]!.counts, sources[1]!.counts);
  const shared = { ...valid, snapshot: { ...valid.snapshot, sources } };
  assert.deepEqual(sanitizeHistoryRecoverySnapshotResult(shared, valid.requestKey), shared);
  assert.equal(clone.mock.callCount(), 1);
});

test("self-cycles and multi-node cycles stop before cloning", { timeout: 5_000 }, (t) => {
  const clone = t.mock.method(globalThis, "structuredClone");
  const valid = validSnapshotResult("cyclic-counts");
  const self: Record<string, unknown> = {};
  self.self = self;
  const left: Record<string, unknown> = {};
  const right = { left };
  left.right = right;
  for (const counts of [self, left]) {
    clone.mock.resetCalls();
    const result = sanitizeHistoryRecoverySnapshotResult({
      ...valid, snapshot: { ...valid.snapshot, sources: [{ ...valid.snapshot.sources[0], counts }] },
    }, valid.requestKey);
    assert.equal(result.status, "unavailable");
    // A later shape check must not disguise a cycle accepted by the graph walk.
    assert.equal(clone.mock.callCount(), 0);
  }
});

test("shared diamond graphs are inspected without expanding every path", { timeout: 5_000 }, (t) => {
  const clone = t.mock.method(globalThis, "structuredClone");
  let diamond: object = {};
  for (let depth = 0; depth < 40; depth += 1) diamond = { left: diamond, right: diamond };
  // The graph gate accepts a DAG without expanding every path through it. The
  // exact request shape still rejects this unsupported field afterward.
  assert.equal(reconstructHistoryRecoverySnapshotRequest({ version: 1, requestKey: "diamond", diamond }).ok, false);
  assert.equal(clone.mock.callCount(), 1);
});

test("graph inspection retains the node and property limits", { timeout: 5_000 }, (t) => {
  const clone = t.mock.method(globalThis, "structuredClone");
  for (const graph of [
    Array.from({ length: 100_000 }, () => ({})),
    Object.fromEntries(Array.from({ length: 200_001 }, (_, index) => [String(index), null])),
  ]) {
    clone.mock.resetCalls();
    assert.equal(reconstructHistoryRecoverySnapshotRequest({ version: 1, requestKey: "bounded", graph }).ok, false);
    assert.equal(clone.mock.callCount(), 0, "reject over-budget graphs before structured cloning");
  }
});

test("all four request families reconstruct exact closed branches", () => {
  assert.equal(
    reconstructHistoryRecoverySnapshotRequest({ version: 1, requestKey: "request-1" }).ok,
    true,
  );
  const browseRequests: readonly HistoryRecoveryBrowseRequest[] = [
    {
      version: 1,
      kind: "generations",
      requestKey: "request-2",
      snapshotKey: "snapshot-1",
      libraryKey: "library-1",
      page: { after: null, size: 10 },
    },
    {
      version: 1,
      kind: "projects",
      requestKey: "request-3",
      snapshotKey: "snapshot-1",
      generationKey: "generation-1",
      page: { after: null, size: 10 },
    },
    {
      version: 1,
      kind: "sessions",
      requestKey: "request-4",
      snapshotKey: "snapshot-1",
      projectKey: "project-1",
      page: { after: null, size: 10 },
    },
    {
      version: 1,
      kind: "turns",
      requestKey: "request-5",
      snapshotKey: "snapshot-1",
      sessionKey: "session-1",
      page: { after: null, size: 10 },
    },
  ];
  for (const request of browseRequests) {
    assert.equal(reconstructHistoryRecoveryBrowseRequest(request).ok, true);
  }
  for (const request of [
    performRequest("preserve"),
    performRequest("acknowledge"),
    performRequest("export-copy"),
  ]) {
    assert.equal(reconstructHistoryRecoveryPerformRequest(request).ok, true);
  }
  assert.equal(
    reconstructHistoryRecoveryCancelRequest({
      version: 1,
      requestKey: "request-cancel",
      operationKey: "operation-1",
    }).ok,
    true,
  );
});

test("missing, extra, symbol, hidden, accessor, proxy, and non-plain requests fail closed", () => {
  const valid = { version: 1, requestKey: "request-1" };
  const symbol = { ...valid, [Symbol("hidden")]: true };
  const hidden = { ...valid };
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  const accessor = { requestKey: "request-1" } as Record<string, unknown>;
  let accessorRuns = 0;
  Object.defineProperty(accessor, "version", {
    enumerable: true,
    get() {
      accessorRuns += 1;
      throw new Error("must-not-run");
    },
  });
  const proxy = new Proxy(valid, {
    ownKeys() {
      throw new Error("must-not-run");
    },
  });
  const transparentProxy = new Proxy(valid, {});
  for (const value of [
    {},
    { ...valid, extra: true },
    symbol,
    hidden,
    accessor,
    proxy,
    transparentProxy,
    Object.assign(Object.create(null), valid),
    new (class Request { version = 1; requestKey = "request-1"; })(),
  ]) {
    assert.equal(reconstructHistoryRecoverySnapshotRequest(value).ok, false);
  }
  assert.equal(accessorRuns, 0);
});

test("nested request bounds and branch fields are exact", () => {
  const base = {
    version: 1,
    kind: "generations",
    requestKey: "request-1",
    snapshotKey: "snapshot-1",
    libraryKey: "library-1",
  } as const;
  for (const page of [
    { after: null, size: 0 },
    { after: null, size: 51 },
    { after: 0, size: 1 },
    { after: 1.5, size: 1 },
    { after: null, size: 1, extra: true },
  ]) {
    assert.equal(reconstructHistoryRecoveryBrowseRequest({ ...base, page }).ok, false);
  }
  assert.equal(
    reconstructHistoryRecoveryBrowseRequest({
      ...base,
      page: { after: null, size: 1 },
      projectKey: "foreign",
    }).ok,
    false,
  );
  assert.equal(
    reconstructHistoryRecoveryPerformRequest({
      ...performRequest("export-copy"),
      sourceKey: "foreign",
    }).ok,
    false,
  );
});

test("snapshot results enforce safe ordinal labels, state/action coherence, and attention", () => {
  const requestKey = "request-1";
  const valid = validSnapshotResult(requestKey);
  assert.deepEqual(sanitizeHistoryRecoverySnapshotResult(valid, requestKey), valid);

  const malformed = [
    { ...valid, extra: true },
    {
      ...valid,
      snapshot: { ...valid.snapshot, attention: false },
    },
    {
      ...valid,
      snapshot: {
        ...valid.snapshot,
        sources: [
          {
            ...valid.snapshot.sources[0],
            label: "X:/private/source",
          },
        ],
      },
    },
    {
      ...valid,
      snapshot: {
        ...valid.snapshot,
        sources: [
          {
            ...valid.snapshot.sources[0],
            state: "current",
            action: "none",
          },
        ],
      },
    },
    {
      ...valid,
      snapshot: {
        ...valid.snapshot,
        sources: [
          {
            ...valid.snapshot.sources[0],
            action: "acknowledge",
            state: "empty",
            counts,
          },
        ],
      },
    },
  ];
  for (const value of malformed) {
    const result = sanitizeHistoryRecoverySnapshotResult(value, requestKey);
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" && result.problem.code, "verification-failed");
  }
});

test("sparse, accessor, symbol, and oversized nested result arrays fail closed", () => {
  const requestKey = "request-1";
  const valid = validSnapshotResult(requestKey);
  const sparse = new Array(1);
  const accessor = [...valid.snapshot.sources];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      throw new Error("must-not-run");
    },
  });
  const symbol = [...valid.snapshot.sources];
  Object.defineProperty(symbol, Symbol("hidden"), { value: true, enumerable: true });
  const oversized = Array.from({ length: 65 }, () => valid.snapshot.sources[0]);
  for (const sources of [sparse, accessor, symbol, oversized]) {
    const result = sanitizeHistoryRecoverySnapshotResult(
      { ...valid, snapshot: { ...valid.snapshot, sources } },
      requestKey,
    );
    assert.equal(result.status, "unavailable");
  }
});

test("browse results enforce parentage, dense pagination, page size, and canonical items", () => {
  const request: HistoryRecoveryBrowseRequest = {
    version: 1,
    kind: "generations",
    requestKey: "request-browse",
    snapshotKey: "snapshot-1",
    libraryKey: "library-1",
    page: { after: null, size: 1 },
  };
  const valid = {
    version: 1,
    kind: "browse",
    requestKey: request.requestKey,
    status: "ready",
    snapshotKey: request.snapshotKey,
    branch: "generations",
    parentKey: request.libraryKey,
    page: {
      after: null,
      nextAfter: 1,
      totalCount: 2,
      items: [
        {
          kind: "generation",
          ordinal: 1,
          label: "Recovery 1",
          generationKey: "generation-1",
          sourceLabel: "Historical store 1",
          counts,
        },
      ],
    },
  } as const;
  assert.deepEqual(sanitizeHistoryRecoveryBrowseResult(valid, request), valid);
  for (const value of [
    { ...valid, parentKey: "library-foreign" },
    { ...valid, branch: "projects" },
    { ...valid, page: { ...valid.page, after: 1 } },
    { ...valid, page: { ...valid.page, nextAfter: null } },
    {
      ...valid,
      page: {
        ...valid.page,
        items: [{ ...valid.page.items[0], ordinal: 2, label: "Recovery 2" }],
      },
    },
    {
      ...valid,
      page: {
        ...valid.page,
        items: [valid.page.items[0], valid.page.items[0]],
      },
    },
  ]) {
    const result = sanitizeHistoryRecoveryBrowseResult(value, request);
    assert.equal(result.status, "unavailable");
  }
});

test("action and cancel results reject mismatched identity and leaked export fields", () => {
  const request = performRequest("export-copy") as Extract<
    HistoryRecoveryPerformRequest,
    { action: "export-copy" }
  >;
  const valid = {
    version: 1,
    action: "export-copy",
    requestKey: request.requestKey,
    operationKey: request.operationKey,
    status: "exported",
    export: {
      label: "Recovery export 1",
      warning:
        "The exported copy may contain conversation history and private local metadata.",
    },
  } as const;
  assert.deepEqual(sanitizeHistoryRecoveryActionResult(valid, request), valid);
  for (const value of [
    { ...valid, operationKey: "foreign-operation" },
    { ...valid, export: { ...valid.export, targetPath: "X:/private/export" } },
    { ...valid, export: { ...valid.export, label: "export.sqlite" } },
    { ...valid, export: { ...valid.export, warning: "different" } },
  ]) {
    assert.equal(sanitizeHistoryRecoveryActionResult(value, request).status, "failed");
  }

  const cancelRequest = {
    version: 1 as const,
    requestKey: "request-cancel",
    operationKey: "operation-cancel",
  };
  assert.equal(
    sanitizeHistoryRecoveryCancelResult(
      {
        version: 1,
        kind: "cancel",
        requestKey: cancelRequest.requestKey,
        operationKey: cancelRequest.operationKey,
        status: "cancel-requested",
      },
      cancelRequest,
    ).status,
    "cancel-requested",
  );
  assert.equal(
    sanitizeHistoryRecoveryCancelResult(
      {
        version: 1,
        kind: "cancel",
        requestKey: cancelRequest.requestKey,
        operationKey: cancelRequest.operationKey,
        status: "cancel-requested",
        extra: true,
      },
      cancelRequest,
    ).status,
    "bridge-closed",
  );
});

test("fixed problem messages cannot be substituted with implementation text", () => {
  const requestKey = "request-problem";
  const valid = {
    version: 1,
    kind: "snapshot",
    requestKey,
    status: "unavailable",
    problem: historyRecoveryProblem("unsupported-artifact"),
  } as const;
  assert.deepEqual(sanitizeHistoryRecoverySnapshotResult(valid, requestKey), valid);
  const result = sanitizeHistoryRecoverySnapshotResult(
    {
      ...valid,
      problem: {
        code: "unsupported-artifact",
        message: "X:/private/source contains a backup",
      },
    },
    requestKey,
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.problem.code, "verification-failed");
  assert.equal(JSON.stringify(result).includes("X:/private"), false);
});

function performRequest(
  action: HistoryRecoveryPerformRequest["action"],
): HistoryRecoveryPerformRequest {
  const base = {
    version: 1 as const,
    action,
    requestKey: `request-${action}`,
    operationKey: `operation-${action}`,
    snapshotKey: "snapshot-1",
  };
  return action === "export-copy"
    ? Object.freeze({ ...base, action, generationKey: "generation-1" })
    : Object.freeze({ ...base, action, sourceKey: "source-1" });
}

function validSnapshotResult(requestKey: string) {
  return Object.freeze({
    version: 1 as const,
    kind: "snapshot" as const,
    requestKey,
    status: "ready" as const,
    snapshot: Object.freeze({
      snapshotKey: "snapshot-1",
      attention: true,
      library: Object.freeze({
        libraryKey: "library-1",
        label: "Historical Recovery Library" as const,
        generationCount: 0,
      }),
      sources: Object.freeze([
        Object.freeze({
          sourceKey: "source-1",
          label: "Historical store 1",
          role: "historical" as const,
          state: "available" as const,
          action: "preserve" as const,
          counts,
        }),
      ]),
    }),
  });
}
