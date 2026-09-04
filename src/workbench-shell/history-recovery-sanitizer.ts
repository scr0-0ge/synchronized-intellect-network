import {
  historyRecoveryBounds,
  historyRecoveryProblem,
  type HistoryRecoveryActionResult,
  type HistoryRecoveryBrowseItem,
  type HistoryRecoveryBrowseRequest,
  type HistoryRecoveryBrowseResult,
  type HistoryRecoveryCancelRequest,
  type HistoryRecoveryCancelResult,
  type HistoryRecoveryCounts,
  type HistoryRecoveryGenerationReference,
  type HistoryRecoveryPageRequest,
  type HistoryRecoveryPerformRequest,
  type HistoryRecoveryProblem,
  type HistoryRecoveryProblemCode,
  type HistoryRecoverySnapshot,
  type HistoryRecoverySnapshotRequest,
  type HistoryRecoverySnapshotResult,
  type HistoryRecoverySourceSummary,
} from "./history-recovery-contract.ts";

type ExactRecord = Readonly<Record<string, unknown>>;

const keyPattern = /^[A-Za-z0-9:_-]{1,160}$/u;
const actionKinds = Object.freeze([
  "preserve",
  "acknowledge",
  "export-copy",
] as const);
const statuses = Object.freeze([
  "accepted",
  "in-flight",
  "completed",
  "failed",
  "recovery-required",
] as const);
const problemCodes = Object.freeze([
  "bridge-closed",
  "busy",
  "cancelled",
  "capture-drift",
  "cleanup-pending",
  "export-unavailable",
  "invalid-request",
  "library-unavailable",
  "permission-denied",
  "quota-exceeded",
  "source-unavailable",
  "stale-capability",
  "unsupported-artifact",
  "unsupported-schema",
  "verification-failed",
] as const);

export type HistoryRecoveryReconstruction<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

const rejected = Object.freeze({ ok: false as const });
const maximumGraphInspectionNodes = 100_000;
const maximumGraphInspectionProperties = 200_000;

export function reconstructHistoryRecoverySnapshotRequest(
  value: unknown,
): HistoryRecoveryReconstruction<HistoryRecoverySnapshotRequest> {
  if (!isPlainDataGraph(value)) return rejected;
  const record = exactRecord(value, ["requestKey", "version"]);
  if (
    record === undefined ||
    record.version !== 1 ||
    !isOpaqueKey(record.requestKey)
  ) {
    return rejected;
  }
  return accepted(
    Object.freeze({ version: 1 as const, requestKey: record.requestKey }),
  );
}

export function reconstructHistoryRecoveryBrowseRequest(
  value: unknown,
): HistoryRecoveryReconstruction<HistoryRecoveryBrowseRequest> {
  if (!isPlainDataGraph(value)) return rejected;
  const base = exactRecordWithDiscriminator(value, "kind");
  if (base === undefined || base.version !== 1 || !isOpaqueKey(base.requestKey)) {
    return rejected;
  }
  const page = clonePageRequest(base.page);
  if (page === undefined || !isOpaqueKey(base.snapshotKey)) return rejected;
  switch (base.kind) {
    case "generations": {
      const record = exactRecord(value, [
        "kind",
        "libraryKey",
        "page",
        "requestKey",
        "snapshotKey",
        "version",
      ]);
      return record !== undefined && isOpaqueKey(record.libraryKey)
        ? accepted(
            Object.freeze({
              version: 1 as const,
              kind: "generations" as const,
              requestKey: base.requestKey,
              snapshotKey: base.snapshotKey,
              libraryKey: record.libraryKey,
              page,
            }),
          )
        : rejected;
    }
    case "projects": {
      const record = exactRecord(value, [
        "generationKey",
        "kind",
        "page",
        "requestKey",
        "snapshotKey",
        "version",
      ]);
      return record !== undefined && isOpaqueKey(record.generationKey)
        ? accepted(
            Object.freeze({
              version: 1 as const,
              kind: "projects" as const,
              requestKey: base.requestKey,
              snapshotKey: base.snapshotKey,
              generationKey: record.generationKey,
              page,
            }),
          )
        : rejected;
    }
    case "sessions": {
      const record = exactRecord(value, [
        "kind",
        "page",
        "projectKey",
        "requestKey",
        "snapshotKey",
        "version",
      ]);
      return record !== undefined && isOpaqueKey(record.projectKey)
        ? accepted(
            Object.freeze({
              version: 1 as const,
              kind: "sessions" as const,
              requestKey: base.requestKey,
              snapshotKey: base.snapshotKey,
              projectKey: record.projectKey,
              page,
            }),
          )
        : rejected;
    }
    case "turns": {
      const record = exactRecord(value, [
        "kind",
        "page",
        "requestKey",
        "sessionKey",
        "snapshotKey",
        "version",
      ]);
      return record !== undefined && isOpaqueKey(record.sessionKey)
        ? accepted(
            Object.freeze({
              version: 1 as const,
              kind: "turns" as const,
              requestKey: base.requestKey,
              snapshotKey: base.snapshotKey,
              sessionKey: record.sessionKey,
              page,
            }),
          )
        : rejected;
    }
    default:
      return rejected;
  }
}

export function reconstructHistoryRecoveryPerformRequest(
  value: unknown,
): HistoryRecoveryReconstruction<HistoryRecoveryPerformRequest> {
  if (!isPlainDataGraph(value)) return rejected;
  const base = exactRecordWithDiscriminator(value, "action");
  if (
    base === undefined ||
    base.version !== 1 ||
    !actionKinds.includes(base.action as (typeof actionKinds)[number]) ||
    !isOpaqueKey(base.requestKey) ||
    !isOpaqueKey(base.operationKey) ||
    !isOpaqueKey(base.snapshotKey)
  ) {
    return rejected;
  }
  if (base.action === "export-copy") {
    const record = exactRecord(value, [
      "action",
      "generationKey",
      "operationKey",
      "requestKey",
      "snapshotKey",
      "version",
    ]);
    return record !== undefined && isOpaqueKey(record.generationKey)
      ? accepted(
          Object.freeze({
            version: 1 as const,
            action: "export-copy" as const,
            requestKey: base.requestKey,
            operationKey: base.operationKey,
            snapshotKey: base.snapshotKey,
            generationKey: record.generationKey,
          }),
        )
      : rejected;
  }
  if (base.action !== "preserve" && base.action !== "acknowledge") {
    return rejected;
  }
  const record = exactRecord(value, [
    "action",
    "operationKey",
    "requestKey",
    "snapshotKey",
    "sourceKey",
    "version",
  ]);
  return record !== undefined && isOpaqueKey(record.sourceKey)
    ? accepted(
        Object.freeze({
          version: 1 as const,
          action: base.action,
          requestKey: base.requestKey,
          operationKey: base.operationKey,
          snapshotKey: base.snapshotKey,
          sourceKey: record.sourceKey,
        }),
      )
    : rejected;
}

export function reconstructHistoryRecoveryCancelRequest(
  value: unknown,
): HistoryRecoveryReconstruction<HistoryRecoveryCancelRequest> {
  if (!isPlainDataGraph(value)) return rejected;
  const record = exactRecord(value, ["operationKey", "requestKey", "version"]);
  if (
    record === undefined ||
    record.version !== 1 ||
    !isOpaqueKey(record.requestKey) ||
    !isOpaqueKey(record.operationKey)
  ) {
    return rejected;
  }
  return accepted(
    Object.freeze({
      version: 1 as const,
      requestKey: record.requestKey,
      operationKey: record.operationKey,
    }),
  );
}

export function sanitizeHistoryRecoverySnapshotResult(
  value: unknown,
  requestKey: string,
): HistoryRecoverySnapshotResult {
  if (!isPlainDataGraph(value)) {
    return unavailableSnapshot(requestKey, "verification-failed");
  }
  const base = exactRecordWithDiscriminator(value, "status");
  if (
    base === undefined ||
    base.version !== 1 ||
    base.kind !== "snapshot" ||
    base.requestKey !== requestKey
  ) {
    return unavailableSnapshot(requestKey, "verification-failed");
  }
  if (base.status === "unavailable") {
    const record = exactRecord(value, [
      "kind",
      "problem",
      "requestKey",
      "status",
      "version",
    ]);
    const problem = cloneProblem(record?.problem);
    return record === undefined || problem === undefined
      ? unavailableSnapshot(requestKey, "verification-failed")
      : Object.freeze({
          version: 1 as const,
          kind: "snapshot" as const,
          requestKey,
          status: "unavailable" as const,
          problem,
        });
  }
  if (base.status !== "ready" && base.status !== "partial") {
    return unavailableSnapshot(requestKey, "verification-failed");
  }
  const record = exactRecord(value, [
    "kind",
    "requestKey",
    "snapshot",
    "status",
    "version",
  ]);
  const snapshot = cloneSnapshot(record?.snapshot);
  return record === undefined || snapshot === undefined
    ? unavailableSnapshot(requestKey, "verification-failed")
    : boundedPublicResult(
        Object.freeze({
          version: 1 as const,
          kind: "snapshot" as const,
          requestKey,
          status: base.status,
          snapshot,
        }),
        () => unavailableSnapshot(requestKey, "verification-failed"),
      );
}

export function sanitizeHistoryRecoveryBrowseResult(
  value: unknown,
  request: HistoryRecoveryBrowseRequest,
): HistoryRecoveryBrowseResult {
  if (!isPlainDataGraph(value)) {
    return unavailableBrowse(request.requestKey, "verification-failed");
  }
  const base = exactRecordWithDiscriminator(value, "status");
  if (
    base === undefined ||
    base.version !== 1 ||
    base.kind !== "browse" ||
    base.requestKey !== request.requestKey
  ) {
    return unavailableBrowse(request.requestKey, "verification-failed");
  }
  if (base.status !== "ready") {
    if (
      base.status !== "stale" &&
      base.status !== "unavailable" &&
      base.status !== "cancelled"
    ) {
      return unavailableBrowse(request.requestKey, "verification-failed");
    }
    const record = exactRecord(value, [
      "kind",
      "problem",
      "requestKey",
      "status",
      "version",
    ]);
    const problem = cloneProblem(record?.problem);
    return record === undefined || problem === undefined
      ? unavailableBrowse(request.requestKey, "verification-failed")
      : Object.freeze({
          version: 1 as const,
          kind: "browse" as const,
          requestKey: request.requestKey,
          status: base.status,
          problem,
        });
  }
  const record = exactRecord(value, [
    "branch",
    "kind",
    "page",
    "parentKey",
    "requestKey",
    "snapshotKey",
    "status",
    "version",
  ]);
  const expectedParent = parentKey(request);
  const page = clonePageResult(record?.page, request);
  if (
    record === undefined ||
    record.branch !== request.kind ||
    record.snapshotKey !== request.snapshotKey ||
    record.parentKey !== expectedParent ||
    page === undefined
  ) {
    return unavailableBrowse(request.requestKey, "verification-failed");
  }
  return boundedPublicResult(
    Object.freeze({
      version: 1 as const,
      kind: "browse" as const,
      requestKey: request.requestKey,
      status: "ready" as const,
      snapshotKey: request.snapshotKey,
      branch: request.kind,
      parentKey: expectedParent,
      page,
    }),
    () => unavailableBrowse(request.requestKey, "verification-failed"),
  );
}

export function sanitizeHistoryRecoveryActionResult(
  value: unknown,
  request: HistoryRecoveryPerformRequest,
): HistoryRecoveryActionResult {
  if (!isPlainDataGraph(value)) {
    return failedAction(request, "verification-failed");
  }
  const base = exactRecordWithDiscriminator(value, "status");
  if (
    base === undefined ||
    base.version !== 1 ||
    base.action !== request.action ||
    base.requestKey !== request.requestKey ||
    base.operationKey !== request.operationKey
  ) {
    return failedAction(request, "verification-failed");
  }
  if (base.status === "failed" || base.status === "cancelled") {
    const record = exactRecord(value, [
      "action",
      "operationKey",
      "problem",
      "requestKey",
      "status",
      "version",
    ]);
    const problem = cloneProblem(record?.problem);
    return record === undefined || problem === undefined
      ? failedAction(request, "verification-failed")
      : Object.freeze({
          version: 1 as const,
          action: request.action,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status: base.status,
          problem,
        });
  }
  if (request.action === "preserve") {
    if (base.status !== "preserved" && base.status !== "already-preserved") {
      return failedAction(request, "verification-failed");
    }
    const record = exactRecord(value, [
      "action",
      "cleanup",
      "generation",
      "operationKey",
      "requestKey",
      "snapshot",
      "status",
      "version",
    ]);
    const snapshot = cloneSnapshot(record?.snapshot);
    const generation = cloneGenerationReference(record?.generation);
    return record === undefined ||
        snapshot === undefined ||
        generation === undefined ||
        (record.cleanup !== "complete" && record.cleanup !== "pending")
      ? failedAction(request, "verification-failed")
      : boundedPublicResult(
          Object.freeze({
            version: 1 as const,
            action: "preserve" as const,
            requestKey: request.requestKey,
            operationKey: request.operationKey,
            status: base.status,
            snapshot,
            generation,
            cleanup: record.cleanup,
          }),
          () => failedAction(request, "verification-failed"),
        );
  }
  if (request.action === "acknowledge") {
    if (
      base.status !== "acknowledged" &&
      base.status !== "already-acknowledged"
    ) {
      return failedAction(request, "verification-failed");
    }
    const record = exactRecord(value, [
      "action",
      "cleanup",
      "operationKey",
      "requestKey",
      "snapshot",
      "status",
      "version",
    ]);
    const snapshot = cloneSnapshot(record?.snapshot);
    return record === undefined ||
        snapshot === undefined ||
        (record.cleanup !== "complete" && record.cleanup !== "pending")
      ? failedAction(request, "verification-failed")
      : boundedPublicResult(
          Object.freeze({
            version: 1 as const,
            action: "acknowledge" as const,
            requestKey: request.requestKey,
            operationKey: request.operationKey,
            status: base.status,
            snapshot,
            cleanup: record.cleanup,
          }),
          () => failedAction(request, "verification-failed"),
        );
  }
  if (base.status === "chooser-cancelled" || base.status === "outcome-unknown") {
    const record = exactRecord(value, [
      "action",
      "operationKey",
      "requestKey",
      "status",
      "version",
    ]);
    return record === undefined
      ? failedAction(request, "verification-failed")
      : Object.freeze({
          version: 1 as const,
          action: "export-copy" as const,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status: base.status,
        });
  }
  if (base.status !== "exported" && base.status !== "already-exported") {
    return failedAction(request, "verification-failed");
  }
  const record = exactRecord(value, [
    "action",
    "export",
    "operationKey",
    "requestKey",
    "status",
    "version",
  ]);
  const exported = exactRecord(record?.export, ["label", "warning"]);
  if (
    record === undefined ||
    exported === undefined ||
    !isCanonicalOrdinalLabel(exported.label, "Recovery export") ||
    exported.warning !==
      "The exported copy may contain conversation history and private local metadata."
  ) {
    return failedAction(request, "verification-failed");
  }
  return Object.freeze({
    version: 1 as const,
    action: "export-copy" as const,
    requestKey: request.requestKey,
    operationKey: request.operationKey,
    status: base.status,
    export: Object.freeze({
      label: exported.label,
      warning:
        "The exported copy may contain conversation history and private local metadata." as const,
    }),
  });
}

export function sanitizeHistoryRecoveryCancelResult(
  value: unknown,
  request: HistoryRecoveryCancelRequest,
): HistoryRecoveryCancelResult {
  if (!isPlainDataGraph(value)) return closedCancelResult(request);
  const record = exactRecord(value, [
    "kind",
    "operationKey",
    "requestKey",
    "status",
    "version",
  ]);
  const status = record?.status;
  return record !== undefined &&
      record.version === 1 &&
      record.kind === "cancel" &&
      record.requestKey === request.requestKey &&
      record.operationKey === request.operationKey &&
      (status === "cancel-requested" ||
        status === "already-terminal" ||
        status === "unknown-request" ||
        status === "bridge-closed")
    ? Object.freeze({
        version: 1 as const,
        kind: "cancel" as const,
        requestKey: request.requestKey,
        operationKey: request.operationKey,
        status,
      })
    : closedCancelResult(request);
}

function closedCancelResult(
  request: HistoryRecoveryCancelRequest,
): HistoryRecoveryCancelResult {
  return Object.freeze({
    version: 1 as const,
    kind: "cancel" as const,
    requestKey: request.requestKey,
    operationKey: request.operationKey,
    status: "bridge-closed" as const,
  });
}

export function unavailableSnapshot(
  requestKey: string,
  code: HistoryRecoveryProblemCode,
): HistoryRecoverySnapshotResult {
  return Object.freeze({
    version: 1 as const,
    kind: "snapshot" as const,
    requestKey,
    status: "unavailable" as const,
    problem: historyRecoveryProblem(code),
  });
}

export function unavailableBrowse(
  requestKey: string,
  code: HistoryRecoveryProblemCode,
  status: "stale" | "unavailable" | "cancelled" = "unavailable",
): HistoryRecoveryBrowseResult {
  return Object.freeze({
    version: 1 as const,
    kind: "browse" as const,
    requestKey,
    status,
    problem: historyRecoveryProblem(code),
  });
}

export function failedAction(
  request: HistoryRecoveryPerformRequest,
  code: HistoryRecoveryProblemCode,
  status: "failed" | "cancelled" = "failed",
): HistoryRecoveryActionResult {
  return Object.freeze({
    version: 1 as const,
    action: request.action,
    requestKey: request.requestKey,
    operationKey: request.operationKey,
    status,
    problem: historyRecoveryProblem(code),
  });
}

export function isOpaqueHistoryRecoveryKey(value: unknown): value is string {
  return isOpaqueKey(value);
}

function cloneSnapshot(value: unknown): HistoryRecoverySnapshot | undefined {
  const record = exactRecord(value, [
    "attention",
    "library",
    "snapshotKey",
    "sources",
  ]);
  if (
    record === undefined ||
    typeof record.attention !== "boolean" ||
    !isOpaqueKey(record.snapshotKey)
  ) {
    return undefined;
  }
  const library = exactRecord(record.library, [
    "generationCount",
    "label",
    "libraryKey",
  ]);
  const sources = exactArray(record.sources, historyRecoveryBounds.maximumPhysicalSources);
  if (
    library === undefined ||
    library.label !== "Historical Recovery Library" ||
    !isOpaqueKey(library.libraryKey) ||
    !isCount(library.generationCount) ||
    sources === undefined
  ) {
    return undefined;
  }
  const clonedSources: HistoryRecoverySourceSummary[] = [];
  for (const source of sources) {
    const cloned = cloneSource(source);
    if (cloned === undefined) return undefined;
    clonedSources.push(cloned);
  }
  const currentOrdinals = clonedSources
    .filter((source) => source.role === "current")
    .map((source) => source.label);
  const historicalOrdinals = clonedSources
    .filter((source) => source.role === "historical")
    .map((source) => source.label);
  if (
    currentOrdinals.some((label, index) => label !== `Current store ${index + 1}`) ||
    historicalOrdinals.some(
      (label, index) => label !== `Historical store ${index + 1}`,
    ) ||
    record.attention !==
      (library.generationCount > 0 ||
        clonedSources.some(
          (source) =>
            source.state === "unavailable" ||
            source.state === "cleanup-pending" ||
            (source.role === "historical" && source.action !== "none"),
        ))
  ) {
    return undefined;
  }
  return Object.freeze({
    snapshotKey: record.snapshotKey,
    attention: record.attention,
    library: Object.freeze({
      libraryKey: library.libraryKey,
      label: "Historical Recovery Library" as const,
      generationCount: library.generationCount,
    }),
    sources: Object.freeze(clonedSources),
  });
}

function cloneSource(value: unknown): HistoryRecoverySourceSummary | undefined {
  const record = exactRecord(value, [
    "action",
    "counts",
    "label",
    "role",
    "sourceKey",
    "state",
  ]);
  if (
    record === undefined ||
    !isOpaqueKey(record.sourceKey) ||
    !isCanonicalOrdinalLabel(
      record.label,
      record.role === "current" ? "Current store" : "Historical store",
    ) ||
    (record.role !== "current" && record.role !== "historical")
  ) {
    return undefined;
  }
  if (record.state === "unavailable") {
    return record.action === "none" && record.counts === null
      ? Object.freeze({
          sourceKey: record.sourceKey,
          label: record.label,
          role: record.role,
          state: "unavailable" as const,
          action: "none" as const,
          counts: null,
        })
      : undefined;
  }
  if (
    record.state !== "current" &&
    record.state !== "available" &&
    record.state !== "empty" &&
    record.state !== "preserved" &&
    record.state !== "acknowledged" &&
    record.state !== "cleanup-pending"
  ) {
    return undefined;
  }
  const counts = cloneCounts(record.counts);
  const action = record.action;
  if (
    counts === undefined ||
    (action !== "none" && action !== "preserve" && action !== "acknowledge") ||
    (record.role === "current" && action !== "none") ||
    (record.role === "current" &&
      record.state !== "current" &&
      record.state !== "cleanup-pending") ||
    (record.role === "historical" && record.state === "current") ||
    (action === "preserve" && record.state !== "available") ||
    (action === "acknowledge" &&
      (record.state !== "empty" ||
        counts.projects !== 0 ||
        counts.sessions !== 0 ||
        counts.commands !== 0 ||
        counts.updates !== 0)) ||
    (record.role === "historical" &&
      action === "none" &&
      record.state !== "preserved" &&
      record.state !== "acknowledged" &&
      record.state !== "cleanup-pending")
  ) {
    return undefined;
  }
  return Object.freeze({
    sourceKey: record.sourceKey,
    label: record.label,
    role: record.role,
    state: record.state,
    action,
    counts,
  });
}

function clonePageResult(
  value: unknown,
  request: HistoryRecoveryBrowseRequest,
):
  | {
      readonly after: number | null;
      readonly nextAfter: number | null;
      readonly totalCount: number;
      readonly items: readonly HistoryRecoveryBrowseItem[];
    }
  | undefined {
  const record = exactRecord(value, ["after", "items", "nextAfter", "totalCount"]);
  const items = exactArray(record?.items, historyRecoveryBounds.maximumPageSize);
  if (
    record === undefined ||
    !isAfter(record.after) ||
    !isAfter(record.nextAfter) ||
    !isCount(record.totalCount) ||
    items === undefined
  ) {
    return undefined;
  }
  const cloned: HistoryRecoveryBrowseItem[] = [];
  for (const item of items) {
    const next = cloneBrowseItem(item, request.kind);
    if (next === undefined) return undefined;
    cloned.push(next);
  }
  const startingOrdinal = request.page.after ?? 0;
  const remaining = Math.max(0, record.totalCount - startingOrdinal);
  const expectedLength = Math.min(request.page.size, remaining);
  if (
    record.after !== request.page.after ||
    cloned.length !== expectedLength ||
    cloned.some(
      (item, index) => item.ordinal !== startingOrdinal + index + 1,
    ) ||
    record.nextAfter !==
      (startingOrdinal + cloned.length < record.totalCount
        ? cloned.at(-1)?.ordinal ?? null
        : null)
  ) {
    return undefined;
  }
  return Object.freeze({
    after: record.after,
    nextAfter: record.nextAfter,
    totalCount: record.totalCount,
    items: Object.freeze(cloned),
  });
}

function cloneBrowseItem(
  value: unknown,
  branch: HistoryRecoveryBrowseRequest["kind"],
): HistoryRecoveryBrowseItem | undefined {
  if (branch === "generations") {
    const record = exactRecord(value, [
      "counts",
      "generationKey",
      "kind",
      "label",
      "ordinal",
      "sourceLabel",
    ]);
    const counts = cloneCounts(record?.counts);
    return record !== undefined &&
        record.kind === "generation" &&
        isOrdinal(record.ordinal) &&
        record.label === `Recovery ${record.ordinal}` &&
        isCanonicalOrdinalLabel(record.sourceLabel, "Historical store") &&
        isOpaqueKey(record.generationKey) &&
        counts !== undefined
      ? Object.freeze({
          kind: "generation" as const,
          ordinal: record.ordinal,
          label: record.label,
          generationKey: record.generationKey,
          sourceLabel: record.sourceLabel,
          counts,
        })
      : undefined;
  }
  if (branch === "projects") {
    const record = exactRecord(value, [
      "counts",
      "kind",
      "label",
      "ordinal",
      "projectKey",
    ]);
    const counts = cloneCounts(record?.counts);
    return record !== undefined &&
        record.kind === "project" &&
        isOrdinal(record.ordinal) &&
        record.label === `Project ${record.ordinal}` &&
        isOpaqueKey(record.projectKey) &&
        counts !== undefined
      ? Object.freeze({
          kind: "project" as const,
          ordinal: record.ordinal,
          label: record.label,
          projectKey: record.projectKey,
          counts,
        })
      : undefined;
  }
  if (branch === "sessions") {
    const record = exactRecord(value, [
      "commandCount",
      "kind",
      "label",
      "ordinal",
      "sessionKey",
      "status",
      "turnCount",
    ]);
    return record !== undefined &&
        record.kind === "session" &&
        isOrdinal(record.ordinal) &&
        record.label === `Session ${record.ordinal}` &&
        isOpaqueKey(record.sessionKey) &&
        statuses.includes(record.status as (typeof statuses)[number]) &&
        isCount(record.commandCount) &&
        isCount(record.turnCount) &&
        record.commandCount === record.turnCount
      ? Object.freeze({
          kind: "session" as const,
          ordinal: record.ordinal,
          label: record.label,
          sessionKey: record.sessionKey,
          status: record.status as (typeof statuses)[number],
          commandCount: record.commandCount,
          turnCount: record.turnCount,
        })
      : undefined;
  }
  const record = exactRecord(value, [
    "eventCount",
    "kind",
    "label",
    "ordinal",
    "status",
  ]);
  return record !== undefined &&
      record.kind === "turn" &&
      isOrdinal(record.ordinal) &&
      record.label === `Turn ${record.ordinal}` &&
      statuses.includes(record.status as (typeof statuses)[number]) &&
      isCount(record.eventCount)
    ? Object.freeze({
        kind: "turn" as const,
        ordinal: record.ordinal,
        label: record.label,
        status: record.status as (typeof statuses)[number],
        eventCount: record.eventCount,
      })
    : undefined;
}

function cloneGenerationReference(
  value: unknown,
): HistoryRecoveryGenerationReference | undefined {
  const record = exactRecord(value, ["counts", "generationKey", "label", "ordinal"]);
  const counts = cloneCounts(record?.counts);
  return record !== undefined &&
      isOrdinal(record.ordinal) &&
      record.label === `Recovery ${record.ordinal}` &&
      isOpaqueKey(record.generationKey) &&
      counts !== undefined
    ? Object.freeze({
        ordinal: record.ordinal,
        label: record.label,
        generationKey: record.generationKey,
        counts,
      })
    : undefined;
}

function cloneCounts(value: unknown): HistoryRecoveryCounts | undefined {
  const record = exactRecord(value, ["commands", "projects", "sessions", "updates"]);
  return record !== undefined &&
      isCount(record.projects) &&
      isCount(record.sessions) &&
      isCount(record.commands) &&
      isCount(record.updates)
    ? Object.freeze({
        projects: record.projects,
        sessions: record.sessions,
        commands: record.commands,
        updates: record.updates,
      })
    : undefined;
}

function cloneProblem(value: unknown): HistoryRecoveryProblem | undefined {
  const record = exactRecord(value, ["code", "message"]);
  if (
    record === undefined ||
    !problemCodes.includes(record.code as HistoryRecoveryProblemCode)
  ) {
    return undefined;
  }
  const expected = historyRecoveryProblem(record.code as HistoryRecoveryProblemCode);
  return record.message === expected.message ? expected : undefined;
}

function clonePageRequest(value: unknown): HistoryRecoveryPageRequest | undefined {
  const record = exactRecord(value, ["after", "size"]);
  return record !== undefined &&
      isAfter(record.after) &&
      typeof record.size === "number" &&
      Number.isSafeInteger(record.size) &&
      record.size >= historyRecoveryBounds.minimumPageSize &&
      record.size <= historyRecoveryBounds.maximumPageSize
    ? Object.freeze({ after: record.after, size: record.size })
    : undefined;
}

function parentKey(request: HistoryRecoveryBrowseRequest): string {
  switch (request.kind) {
    case "generations":
      return request.libraryKey;
    case "projects":
      return request.generationKey;
    case "sessions":
      return request.projectKey;
    case "turns":
      return request.sessionKey;
  }
}

function exactRecordWithDiscriminator(
  value: unknown,
  discriminator: "kind" | "action" | "status",
): ExactRecord | undefined {
  const record = dataRecord(value);
  if (record === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, discriminator);
  return descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable &&
      typeof descriptor.value === "string"
    ? readDataRecord(record)
    : undefined;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): ExactRecord | undefined {
  const record = dataRecord(value);
  if (record === undefined) return undefined;
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return undefined;
  }
  const clone: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return undefined;
    }
    clone[key] = descriptor.value;
  }
  return Object.freeze(clone);
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readDataRecord(record: Record<string, unknown>): ExactRecord | undefined {
  try {
    const clone: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return undefined;
      }
      clone[key] = descriptor.value;
    }
    return Object.freeze(clone);
  } catch {
    return undefined;
  }
}

function exactArray(value: unknown, maximumLength: number): readonly unknown[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximumLength
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)),
      )
    ) {
      return undefined;
    }
    const clone: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return undefined;
      }
      clone.push(descriptor.value);
    }
    return Object.freeze(clone);
  } catch {
    return undefined;
  }
}

function isPlainDataGraph(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let propertyCount = 0;
  try {
    while (pending.length > 0) {
      const current = pending.pop();
      if (
        current === null ||
        current === undefined ||
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "boolean"
      ) {
        continue;
      }
      if (typeof current !== "object" || seen.has(current)) return false;
      if (seen.size >= maximumGraphInspectionNodes) return false;
      seen.add(current);
      const array = Array.isArray(current);
      if (
        Object.getPrototypeOf(current) !==
          (array ? Array.prototype : Object.prototype)
      ) {
        return false;
      }
      const keys = Reflect.ownKeys(current);
      propertyCount += keys.length;
      if (propertyCount > maximumGraphInspectionProperties) return false;
      for (const key of keys) {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor)) return false;
        if (array && key === "length") {
          if (descriptor.enumerable) return false;
          continue;
        }
        if (!descriptor.enumerable) return false;
        pending.push(descriptor.value);
      }
    }
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function accepted<T>(value: T): HistoryRecoveryReconstruction<T> {
  return Object.freeze({ ok: true as const, value });
}

function isOpaqueKey(value: unknown): value is string {
  return typeof value === "string" && keyPattern.test(value);
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= 80 &&
    !/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function isCanonicalOrdinalLabel(
  value: unknown,
  prefix: string,
): value is string {
  if (!isSafeLabel(value)) return false;
  const marker = `${prefix} `;
  if (!value.startsWith(marker)) return false;
  const token = value.slice(marker.length);
  return /^[1-9][0-9]*$/u.test(token) && isOrdinal(Number(token));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= historyRecoveryBounds.maximumCount;
}

function isOrdinal(value: unknown): value is number {
  return isCount(value) && value >= 1;
}

function isAfter(value: unknown): value is number | null {
  return value === null || isOrdinal(value);
}

function boundedPublicResult<T>(value: T, fallback: () => T): T {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <=
        historyRecoveryBounds.maximumPublicResponseBytes
      ? value
      : fallback();
  } catch {
    return fallback();
  }
}
