import { isAbsolute, posix, win32 } from "node:path";

import type { SessionProfile } from "../../agent-runtime/index.ts";
import type { DurableRuntimeEndpointId } from "../work-ledger-auth-generation.ts";
import type {
  AutoIterationCoordinatorPort,
  CoordinatorToolRejectedResponse,
  CoordinatorToolRequest,
  CoordinatorToolRequestMetadata,
  CoordinatorToolResponse,
  HandoffIdempotencyKey,
  HostBoundToolActor,
  ReviewDecisionSubmission,
  RoleGenerationReference,
  SessionCreationParameters,
  SupervisorToolRequest,
  WorkerToolRequest,
  WorkOrderCompletionCondition,
  WorkOrderSubmission,
  WorkOrderTerritory,
} from "./contract.ts";
import type {
  AutoIterationToolOperation,
  SessionAuthority,
} from "./session-authority.ts";

export interface AutoIterationToolBridge {
  call(
    hostSessionId: string,
    operation: AutoIterationToolOperation,
    input: unknown,
  ): Promise<CoordinatorToolResponse>;
}

export interface AutoIterationToolBridgeDependencies {
  readonly authority: SessionAuthority;
  readonly port: AutoIterationCoordinatorPort;
}

const endpointIds = new Set<DurableRuntimeEndpointId>([
  "codex-desktop",
  "claude-code-desktop",
  "glm-coding-plan",
  "kimi-code",
  "deepseek-api",
  "kimi-platform",
  "claude-api",
  "codex-api",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return null;
  return Object.freeze([...value]);
}

function readRelativePaths(value: unknown): readonly string[] | null {
  const paths = readStringArray(value);
  if (
    paths === null ||
    paths.some(
      (candidate) =>
        isAbsolute(candidate) ||
        win32.isAbsolute(candidate) ||
        posix.isAbsolute(candidate),
    )
  ) {
    return null;
  }
  return paths;
}

function readRoleGeneration(
  value: unknown,
): RoleGenerationReference | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.roleSlotId) ||
    !isVersion(value.generation)
  ) {
    return null;
  }
  return Object.freeze({
    roleSlotId: value.roleSlotId,
    generation: value.generation,
  });
}

function readMetadata(
  value: Record<string, unknown>,
): CoordinatorToolRequestMetadata | null {
  const observedTenure = readRoleGeneration(value.observedTenure);
  if (
    !isNonEmptyString(value.requestIdempotencyKey) ||
    !isVersion(value.expectedVersion) ||
    observedTenure === null
  ) {
    return null;
  }
  return Object.freeze({
    requestIdempotencyKey: value.requestIdempotencyKey,
    expectedVersion: value.expectedVersion,
    observedTenure,
  });
}

function readProfile(value: unknown): SessionProfile | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.model) ||
    !isNonEmptyString(value.effortLevel) ||
    !isNonEmptyString(value.executionMode) ||
    !isNonEmptyString(value.accessMode)
  ) {
    return null;
  }
  return Object.freeze({
    model: value.model,
    effortLevel: value.effortLevel,
    executionMode: value.executionMode,
    accessMode: value.accessMode,
  });
}

function readSessionCreation(
  value: unknown,
): SessionCreationParameters | null {
  if (
    !isRecord(value) ||
    typeof value.endpointId !== "string" ||
    !endpointIds.has(value.endpointId as DurableRuntimeEndpointId)
  ) {
    return null;
  }
  const profile = readProfile(value.profile);
  if (profile === null) return null;
  return Object.freeze({
    endpointId: value.endpointId as DurableRuntimeEndpointId,
    profile,
  });
}

function readTerritory(value: unknown): WorkOrderTerritory | null {
  if (!isRecord(value)) return null;
  const writePaths = readRelativePaths(value.writePaths);
  const readOnlyPaths = readRelativePaths(value.readOnlyPaths);
  if (writePaths === null || readOnlyPaths === null) return null;
  return Object.freeze({ writePaths, readOnlyPaths });
}

function readCompletionCondition(
  value: unknown,
): WorkOrderCompletionCondition | null {
  if (
    !isRecord(value) ||
    (value.gitIntegration !== "required" &&
      value.gitIntegration !== "not-required")
  ) {
    return null;
  }
  return Object.freeze({ gitIntegration: value.gitIntegration });
}

function readWorkOrderSubmission(value: unknown): WorkOrderSubmission | null {
  if (!isRecord(value)) return null;
  const acceptanceCriteria = readStringArray(value.acceptanceCriteria);
  const territory = readTerritory(value.territory);
  const completionCondition = readCompletionCondition(value.completionCondition);
  const workerSession = readSessionCreation(value.workerSession);
  if (
    !isNonEmptyString(value.objective) ||
    acceptanceCriteria === null ||
    !isNonEmptyString(value.baselineCommitSha) ||
    territory === null ||
    !isNonEmptyString(value.responsibleRoleSlotId) ||
    completionCondition === null ||
    workerSession === null
  ) {
    return null;
  }
  return Object.freeze({
    objective: value.objective,
    acceptanceCriteria,
    baselineCommitSha: value.baselineCommitSha,
    territory,
    responsibleRoleSlotId: value.responsibleRoleSlotId,
    completionCondition,
    workerSession,
  });
}

function readHandoffKey(value: unknown): HandoffIdempotencyKey | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.workOrderId) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonEmptyString(value.handoffId)
  ) {
    return null;
  }
  return Object.freeze({
    workOrderId: value.workOrderId,
    attemptId: value.attemptId,
    handoffId: value.handoffId,
  });
}

function readReviewDecision(value: unknown): ReviewDecisionSubmission | null {
  if (!isRecord(value)) return null;
  const handoff = readHandoffKey(value.handoff);
  if (
    handoff === null ||
    !isVersion(value.handoffVersion) ||
    !isNonEmptyString(value.reason)
  ) {
    return null;
  }
  if (value.decision === "transfer") {
    if (!isNonEmptyString(value.targetRoleSlotId)) return null;
    return Object.freeze({
      decision: "transfer",
      handoff,
      handoffVersion: value.handoffVersion,
      reason: value.reason,
      targetRoleSlotId: value.targetRoleSlotId,
    });
  }
  if (
    value.decision !== "approve" &&
    value.decision !== "rework" &&
    value.decision !== "blocked"
  ) {
    return null;
  }
  return Object.freeze({
    decision: value.decision,
    handoff,
    handoffVersion: value.handoffVersion,
    reason: value.reason,
  });
}

function parseRequest(
  operation: AutoIterationToolOperation,
  input: unknown,
): CoordinatorToolRequest | null {
  if (!isRecord(input)) return null;
  const metadata = readMetadata(input);
  if (metadata === null) return null;

  switch (operation) {
    case "submit-work-order": {
      const workOrder = readWorkOrderSubmission(input.workOrder);
      return workOrder === null
        ? null
        : Object.freeze({ kind: operation, ...metadata, workOrder });
    }
    case "read-work-order-status":
      return isNonEmptyString(input.workOrderId)
        ? Object.freeze({
            kind: operation,
            ...metadata,
            workOrderId: input.workOrderId,
          })
        : null;
    case "submit-handoff": {
      if (!isRecord(input.handoff)) return null;
      const idempotencyKey = readHandoffKey(input.handoff.idempotencyKey);
      const artifactIds = readStringArray(input.handoff.artifactIds);
      return idempotencyKey !== null &&
        isNonEmptyString(input.handoff.body) &&
        artifactIds !== null
        ? Object.freeze({
            kind: operation,
            ...metadata,
            handoff: Object.freeze({
              idempotencyKey,
              body: input.handoff.body,
              artifactIds,
            }),
          })
        : null;
    }
    case "read-inbox":
      return isNonEmptyString(input.roleSlotId)
        ? Object.freeze({
            kind: operation,
            ...metadata,
            roleSlotId: input.roleSlotId,
          })
        : null;
    case "submit-review-decision": {
      const decision = readReviewDecision(input.decision);
      return decision === null
        ? null
        : Object.freeze({ kind: operation, ...metadata, decision });
    }
    case "request-supervisor-rotation": {
      const successorSession = readSessionCreation(input.successorSession);
      return isNonEmptyString(input.roleSlotId) && successorSession !== null
        ? Object.freeze({
            kind: operation,
            ...metadata,
            roleSlotId: input.roleSlotId,
            successorSession,
          })
        : null;
    }
  }
}

function requestKey(input: unknown): string {
  return isRecord(input) && typeof input.requestIdempotencyKey === "string"
    ? input.requestIdempotencyKey
    : "";
}

function rejected(
  operation: AutoIterationToolOperation,
  input: unknown,
  category: "forbidden" | "invalid-request",
): CoordinatorToolRejectedResponse {
  return Object.freeze({
    kind: "rejected",
    requestIdempotencyKey: requestKey(input),
    currentVersion: null,
    operation,
    category,
  });
}

const privateField =
  /(?:token|api.?key|credential|secret|opaque.*(?:session|resume)|provider.*(?:session|resume)|native.*(?:session|resume))/iu;
const hostPathField = /(?:path|paths|directory|root)$/iu;

function absolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

function sanitizeValue(value: unknown, fieldName = ""): unknown {
  if (privateField.test(fieldName)) return undefined;
  if (typeof value === "string") {
    return hostPathField.test(fieldName) && absolutePath(value)
      ? undefined
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, fieldName))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return value;
  if (
    typeof value.relativePath === "string" &&
    absolutePath(value.relativePath)
  ) {
    return undefined;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = sanitizeValue(entry, key);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function sanitizeResponse(response: CoordinatorToolResponse): CoordinatorToolResponse {
  return sanitizeValue(response) as CoordinatorToolResponse;
}

async function callPort(
  port: AutoIterationCoordinatorPort,
  actor: HostBoundToolActor,
  request: CoordinatorToolRequest,
): Promise<CoordinatorToolResponse> {
  if (actor.kind === "supervisor") {
    return port.request(actor, request as SupervisorToolRequest);
  }
  return port.request(actor, request as WorkerToolRequest);
}

export function createAutoIterationToolBridge(
  dependencies: AutoIterationToolBridgeDependencies,
): AutoIterationToolBridge {
  const bridge: AutoIterationToolBridge = {
    async call(
      hostSessionId: string,
      operation: AutoIterationToolOperation,
      input: unknown,
    ) {
      const actor = dependencies.authority.authorize(hostSessionId, operation);
      if (actor === null) return rejected(operation, input, "forbidden");
      const request = parseRequest(operation, input);
      if (request === null) return rejected(operation, input, "invalid-request");
      return sanitizeResponse(
        await callPort(dependencies.port, actor, request),
      );
    },
  };
  return Object.freeze(bridge);
}
