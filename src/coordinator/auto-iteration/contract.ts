import type { SessionProfile } from "../../agent-runtime/index.ts";
import type { DurableRuntimeEndpointId } from "../work-ledger-auth-generation.ts";
import type {
  RuntimeWorkOrderLifecycle,
  RuntimeWorkOrderSlotState,
} from "../runtime-work-order-ledger.ts";

/** A stable address. The bound Session may change without changing this id. */
export interface RoleSlot {
  readonly roleSlotId: string;
  readonly projectId: string;
  readonly responsibility: "supervisor" | "reviewer" | "integrator";
  readonly currentTenureId: string | null;
  readonly version: number;
}

export interface RoleGenerationReference {
  readonly roleSlotId: string;
  readonly generation: number;
}

export type SupervisorTenureStatus =
  | "active"
  | "draining"
  | "successor-preparing"
  | "cutover"
  | "retired";

/** One generation binding the stable supervisor role to a host-bound Session. */
export interface SupervisorTenure extends RoleGenerationReference {
  readonly tenureId: string;
  readonly sessionId: string;
  readonly status: SupervisorTenureStatus;
  readonly version: number;
}

/** Business progress only. Runtime/process lifecycle belongs to ExecutionAttempt. */
export type WorkOrderStatus =
  | "executing"
  | "delivered"
  | "awaiting-review"
  | "review-approved"
  | "awaiting-integration"
  | "integrated"
  | "rework"
  | "blocked"
  | "waiting-for-quota";

/** Coordination scope, not an adversarial filesystem boundary. */
export interface WorkOrderTerritory {
  readonly writePaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
}

export type WorkOrderCompletionCondition =
  | { readonly gitIntegration: "required" }
  | { readonly gitIntegration: "not-required" };

export interface WorkOrder {
  readonly workOrderId: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly baselineCommitSha: string;
  readonly territory: WorkOrderTerritory;
  readonly responsibleRoleSlotId: string;
  readonly issuedBy: RoleGenerationReference;
  readonly completionCondition: WorkOrderCompletionCondition;
  readonly status: WorkOrderStatus;
  readonly currentAttemptId: string;
  readonly version: number;
}

/** Endpoint, model, and thinking effort are selected for this Session only. */
export interface SessionCreationParameters {
  readonly endpointId: DurableRuntimeEndpointId;
  /** `model` and `effortLevel` are the existing per-Session selections. */
  readonly profile: SessionProfile;
}

/**
 * The requested selection is retained even when the Runtime cannot confirm its
 * effective selection. Model self-description is not a confirmation source.
 */
export type SessionConfigurationState =
  | {
      readonly state: "requested";
      readonly requested: SessionCreationParameters;
    }
  | {
      readonly state: "runtime-confirmed";
      readonly requested: SessionCreationParameters;
      readonly runtimeConfirmed: SessionCreationParameters;
    }
  | {
      readonly state: "unknown";
      readonly requested: SessionCreationParameters;
    };

export interface ExecutionAttempt {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly attemptNumber: number;
  readonly sessionId: string | null;
  readonly sessionConfiguration: SessionConfigurationState;
  /** Reuses ADR-0020's Runtime lifecycle; it never advances WorkOrderStatus by itself. */
  readonly runtimeLifecycle: RuntimeWorkOrderLifecycle;
  /** May remain owned after Handoff until the process/resource is known released. */
  readonly slotState: RuntimeWorkOrderSlotState;
  readonly workspaceId: string | null;
  readonly version: number;
}

/** The three fields together are the Handoff idempotency key. */
export interface HandoffIdempotencyKey {
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly handoffId: string;
}

export type ArtifactReference =
  | {
      readonly artifactId: string;
      readonly kind: "git-commit";
      readonly commitSha: string;
    }
  | {
      readonly artifactId: string;
      readonly kind: "workspace-file";
      readonly workspaceId: string;
      readonly relativePath: string;
    }
  | {
      readonly artifactId: string;
      readonly kind: "execution-job";
      readonly jobId: string;
    };

export interface Handoff {
  readonly idempotencyKey: HandoffIdempotencyKey;
  /** The Coordinator applies its fixed text bound before persistence. */
  readonly body: string;
  readonly artifacts: readonly ArtifactReference[];
  readonly submittedBySessionId: string;
  readonly version: number;
}

/** Model-authored Handoff data; artifact ids resolve to tool-captured facts. */
export interface HandoffSubmission {
  readonly idempotencyKey: HandoffIdempotencyKey;
  readonly body: string;
  readonly artifactIds: readonly string[];
}

interface ReviewDecisionBase {
  readonly reviewDecisionId: string;
  readonly handoff: HandoffIdempotencyKey;
  readonly handoffVersion: number;
  readonly decidedBy: RoleGenerationReference;
  readonly reason: string;
  readonly version: number;
}

export type ReviewDecision =
  | (ReviewDecisionBase & {
      readonly decision: "approve" | "rework" | "blocked";
    })
  | (ReviewDecisionBase & {
      readonly decision: "transfer";
      readonly targetRoleSlotId: string;
    });

interface ReviewDecisionSubmissionBase {
  readonly handoff: HandoffIdempotencyKey;
  readonly handoffVersion: number;
  readonly reason: string;
}

export type ReviewDecisionSubmission =
  | (ReviewDecisionSubmissionBase & {
      readonly decision: "approve" | "rework" | "blocked";
    })
  | (ReviewDecisionSubmissionBase & {
      readonly decision: "transfer";
      readonly targetRoleSlotId: string;
    });

export interface IntegrationCandidate {
  readonly integrationCandidateId: string;
  readonly baselineCommitSha: string;
  readonly orderedCommitShas: readonly string[];
  readonly mergeTreeSha: string;
  readonly gateDefinitionVersion: string;
  readonly handoffs: readonly HandoffIdempotencyKey[];
  readonly reviewDecisionIds: readonly string[];
  /** Human-readable facts needed to reproduce the candidate's gate environment. */
  readonly environment: string;
  /** Tool-read commit that can be checked out to run gates for mergeTreeSha. */
  readonly mergeCommitSha: string;
  /** Retained until gates finish so they execute the exact candidate tree. */
  readonly workspaceId: string;
  readonly constructionJobId: string;
  readonly version: number;
  /**
   * Terminal integration outcome once the host's integration job finished;
   * absent while the candidate is still awaiting integration. Optional so
   * every existing producer of a frozen candidate stays unchanged.
   */
  readonly outcome?: IntegrationOutcome;
}

/** One fixed gate executed on an integration candidate; tail is its bounded log excerpt. */
export interface IntegrationGateRecord {
  readonly gate: string;
  readonly jobId: string;
  readonly exitCode: number | null;
  readonly passed: boolean;
  /** Last 200 lines of the gate job's captured output; full logs stay in the job record. */
  readonly tail: string;
}

/**
 * Terminal result of the product-run integration of one frozen candidate
 * (issue #8 M3): all gates green merges to the LOCAL target branch; every
 * red path records which fixed check failed without retrying.
 */
export type IntegrationOutcome =
  | {
      readonly status: "integrated";
      /** Merge commit now at the tip of the local target branch. */
      readonly mergeCommitSha: string;
      readonly gates: readonly IntegrationGateRecord[];
    }
  | {
      readonly status: "blocked: merge-conflict";
      readonly conflictFiles: readonly string[];
    }
  | {
      readonly status: "blocked: gate-failed";
      readonly gates: readonly IntegrationGateRecord[];
    }
  | {
      readonly status: "blocked: target-moved";
      readonly expectedBaselineCommitSha: string;
      readonly observedTargetRefCommitSha: string | null;
      readonly observedLocalBranchCommitSha: string | null;
    };

/** A frozen candidate whose integration the host still owes an outcome for. */
export interface PendingIntegration {
  readonly candidate: IntegrationCandidate;
  readonly reviewDecisionId: string;
}

/** Outcome of constructing one candidate inside a managed detached worktree. */
export type IntegrationCandidateBuildResult =
  | {
      readonly status: "ready";
      readonly candidate: IntegrationCandidate;
    }
  | {
      readonly status: "conflict";
      readonly integrationCandidateId: string;
      readonly baselineCommitSha: string;
      readonly orderedCommitShas: readonly string[];
      readonly gateDefinitionVersion: string;
      readonly environment: string;
      readonly conflictFiles: readonly string[];
      readonly mergeTreeSha: null;
      readonly constructionJobId: string;
    }
  | {
      readonly status: "invalidated";
      readonly integrationCandidateId: string;
      readonly reason: "target-baseline-changed";
      readonly expectedTargetBaselineCommitSha: string;
      readonly observedTargetBaselineCommitSha: string;
    };

/** Re-check of a ready candidate against the current target and gate inputs. */
export type IntegrationCandidateValidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalidated";
      readonly reason:
        | "target-baseline-changed"
        | "ordered-commits-changed"
        | "gate-definition-changed"
        | "environment-changed";
      readonly observedTargetBaselineCommitSha: string;
    };

interface QuotaPoolBase {
  readonly quotaPoolId: string;
  /** Opaque local key for Sessions that consume one provider-account window. */
  readonly accountScopeKey: string;
  readonly endpointIds: readonly DurableRuntimeEndpointId[];
  readonly version: number;
}

export type QuotaPool =
  | (QuotaPoolBase & { readonly status: "available" | "unknown" })
  | (QuotaPoolBase & {
      readonly status: "waiting-for-quota";
      /** This instant authorizes a new probe, not an automatic claim of capacity. */
      readonly resetsAt: number | null;
    });

/** One account window read; null fields mean explicitly unknown, not absent. */
export interface QuotaWindowObservation {
  readonly name: string;
  readonly usedFraction: number | null;
  readonly resetsAt: number | null;
  readonly windowDurationMinutes: number | null;
}

export type QuotaObservationSource =
  | "codex-account:account/rateLimits/read"
  | "claude-account:runtime";

/** A zero-inference account read; it never claims capacity by itself. */
export interface QuotaObservation {
  readonly quotaPoolId: string;
  readonly source: QuotaObservationSource;
  readonly observedAt: number;
  readonly status: "observed" | "unknown";
  readonly windows: readonly QuotaWindowObservation[];
}

/** Endpoint-to-pool ownership; Sessions on one subscription share one pool. */
export interface QuotaPoolDefinition {
  readonly quotaPoolId: string;
  /** Opaque local key for Sessions that consume one provider-account window. */
  readonly accountScopeKey: string;
  readonly endpointIds: readonly DurableRuntimeEndpointId[];
  readonly version: number;
}

export type ContextUsageQuality = "authoritative" | "estimated" | "unknown";

/** Same-source context read used by rotation; the Runtime percentage is ignored. */
export interface ContextUsageObservation {
  readonly source: "claude-control:get_context_usage";
  readonly observedAt: number;
  /** The Session identity the transport observed; host resolves the product Session. */
  readonly sessionId: string;
  readonly model: string;
  readonly quality: ContextUsageQuality;
  readonly totalTokens: number | null;
  readonly maxTokens: number | null;
  readonly fraction: number | null;
}

export type CliCapabilityState = "available" | "unavailable" | "unknown";

export interface CliCapabilityVersions {
  readonly claude: string;
  readonly codex: string;
}

/** Four independently tri-state facts, persisted once per exact version pair. */
export interface CliCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly observedAt: number;
  readonly cliVersions: CliCapabilityVersions;
  readonly capabilities: {
    readonly claudeContextUsage: CliCapabilityState;
    readonly codexRateLimits: CliCapabilityState;
    readonly claudeEffortEcho: CliCapabilityState;
    readonly codexEffortEcho: CliCapabilityState;
  };
}

export type HandoffReceipt =
  | {
      readonly level: "persisted";
      readonly handoff: HandoffIdempotencyKey;
      readonly handoffVersion: number;
    }
  | {
      readonly level: "included-in-parent-input";
      readonly handoff: HandoffIdempotencyKey;
      readonly handoffVersion: number;
      readonly parentCommandId: string;
    }
  | {
      readonly level: "disposed";
      readonly handoff: HandoffIdempotencyKey;
      readonly handoffVersion: number;
      readonly reviewDecisionId: string;
    };

interface InboxEntryBase {
  readonly inboxEntryId: string;
  readonly roleSlotId: string;
  readonly state: "pending" | "included-in-parent-input" | "disposed";
  readonly version: number;
}

export type InboxEntry =
  | (InboxEntryBase & {
      readonly kind: "handoff";
      readonly handoff: HandoffIdempotencyKey;
    })
  | (InboxEntryBase & {
      readonly kind: "blocked" | "failure" | "mention";
      readonly workOrderId: string | null;
      readonly summary: string;
    })
  | (InboxEntryBase & {
      readonly kind: "rotation";
      readonly tenureId: string;
    });

/** Present on every model-tool request; the host binding remains separate. */
export interface CoordinatorToolRequestMetadata {
  readonly requestIdempotencyKey: string;
  readonly expectedVersion: number;
  readonly observedTenure: RoleGenerationReference;
}

export interface WorkOrderSubmission {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly baselineCommitSha: string;
  readonly territory: WorkOrderTerritory;
  readonly responsibleRoleSlotId: string;
  readonly completionCondition: WorkOrderCompletionCondition;
  readonly workerSession: SessionCreationParameters;
}

export interface SubmitWorkOrderRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "submit-work-order";
  readonly workOrder: WorkOrderSubmission;
}

export interface ReadWorkOrderStatusRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "read-work-order-status";
  readonly workOrderId: string;
}

export interface SubmitHandoffRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "submit-handoff";
  readonly handoff: HandoffSubmission;
}

export interface ReadInboxRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "read-inbox";
  readonly roleSlotId: string;
}

export interface SubmitReviewDecisionRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "submit-review-decision";
  readonly decision: ReviewDecisionSubmission;
}

export interface RequestSupervisorRotationRequest
  extends CoordinatorToolRequestMetadata {
  readonly kind: "request-supervisor-rotation";
  readonly roleSlotId: string;
  readonly successorSession: SessionCreationParameters;
}

export type SupervisorToolRequest =
  | SubmitWorkOrderRequest
  | ReadWorkOrderStatusRequest
  | ReadInboxRequest
  | SubmitReviewDecisionRequest
  | RequestSupervisorRotationRequest;

export type WorkerToolRequest =
  | ReadWorkOrderStatusRequest
  | SubmitHandoffRequest
  | ReadInboxRequest;

export type CoordinatorToolRequest = SupervisorToolRequest | WorkerToolRequest;

export type HostBoundToolActor =
  | {
      readonly kind: "supervisor";
      readonly sessionId: string;
      readonly tenure: RoleGenerationReference;
    }
  | {
      readonly kind: "worker";
      readonly sessionId: string;
      readonly workOrderId: string;
      readonly attemptId: string;
    };

interface CoordinatorToolResponseMetadata {
  readonly requestIdempotencyKey: string;
  readonly currentVersion: number;
}

export interface WorkOrderSubmittedResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "work-order-submitted";
  readonly workOrder: WorkOrder;
  readonly attempt: ExecutionAttempt;
}

export interface WorkOrderStatusResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "work-order-status";
  readonly workOrder: WorkOrder;
  readonly attempts: readonly ExecutionAttempt[];
  readonly handoffs: readonly Handoff[];
  readonly reviews: readonly ReviewDecision[];
  readonly candidates: readonly IntegrationCandidate[];
  readonly receipts: readonly HandoffReceipt[];
}

export interface HandoffSubmittedResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "handoff-submitted";
  readonly receipt: Extract<HandoffReceipt, { readonly level: "persisted" }>;
}

export interface InboxReadResponse extends CoordinatorToolResponseMetadata {
  readonly kind: "inbox-read";
  readonly entries: readonly InboxEntry[];
}

export interface ReviewDecisionSubmittedResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "review-decision-submitted";
  readonly decision: ReviewDecision;
  readonly receipt: Extract<HandoffReceipt, { readonly level: "disposed" }>;
}

export interface SupervisorRotationRequestedResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "supervisor-rotation-requested";
  readonly tenure: SupervisorTenure;
}

export interface CoordinatorToolRejectedResponse {
  readonly kind: "rejected";
  readonly requestIdempotencyKey: string;
  /** Null only when storage could not provide an authoritative version. */
  readonly currentVersion: number | null;
  readonly operation: CoordinatorToolRequest["kind"];
  readonly category:
    | "forbidden"
    | "idempotency-conflict"
    | "invalid-request"
    | "not-found"
    | "stale-generation"
    | "stale-version"
    | "storage-unavailable";
}

export type CoordinatorToolResponse =
  | WorkOrderSubmittedResponse
  | WorkOrderStatusResponse
  | HandoffSubmittedResponse
  | InboxReadResponse
  | ReviewDecisionSubmittedResponse
  | SupervisorRotationRequestedResponse
  | CoordinatorToolRejectedResponse;

export type SupervisorToolResponse =
  | WorkOrderSubmittedResponse
  | WorkOrderStatusResponse
  | InboxReadResponse
  | ReviewDecisionSubmittedResponse
  | SupervisorRotationRequestedResponse
  | CoordinatorToolRejectedResponse;

export type WorkerToolResponse =
  | WorkOrderStatusResponse
  | HandoffSubmittedResponse
  | InboxReadResponse
  | CoordinatorToolRejectedResponse;

/** The MCP bridge supplies HostBoundToolActor; model payloads never may. */
export interface AutoIterationCoordinatorPort {
  request(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SupervisorToolRequest,
  ): Promise<SupervisorToolResponse>;
  request(
    actor: Extract<HostBoundToolActor, { readonly kind: "worker" }>,
    request: WorkerToolRequest,
  ): Promise<WorkerToolResponse>;
}

/*
 * Host lifecycle operations. The six frozen model tools carry business state;
 * these are the host-side halves that only the Workbench process may drive.
 * They are never exposed through the MCP tool wire.
 */

export interface InitialSupervisorBinding {
  readonly roleSlotId: string;
  readonly sessionId: string;
  readonly generation: number;
}

export interface AttemptSessionBinding {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly configuration?: SessionConfigurationState;
}

export interface AttemptRuntimeMutation {
  readonly attemptId: string;
  readonly runtimeLifecycle: ExecutionAttempt["runtimeLifecycle"];
  readonly slotState: ExecutionAttempt["slotState"];
  readonly workspaceId?: string | null;
}

export interface HandoffIncludedMutation {
  readonly handoff: HandoffIdempotencyKey;
  readonly parentCommandId: string;
}

export interface PendingAutoIterationOutboxEntry {
  readonly outboxEntryId: string;
  readonly kind: "start-attempt" | "inbox-wakeup" | "review-disposed" | "rotation";
  readonly payload: unknown;
  readonly version: number;
}

/**
 * The successor Session must exist and have acknowledged READY before the
 * host calls the cutover; the ledger never accepts a placeholder session id
 * as a running successor.
 */
export interface SupervisorRotationCompletion {
  readonly roleSlotId: string;
  readonly successorSessionId: string;
  readonly configuration?: SessionConfigurationState;
}

/** Host-side read for the sanitized renderer projection; ids stay host-side. */
export interface AutoIterationWorkOrderOverview {
  readonly workOrderId: string;
  readonly status: WorkOrderStatus;
  readonly currentAttemptId: string;
  readonly attemptCount: number;
  readonly workerSessionBound: boolean;
  readonly workerSessionId: string | null;
  readonly workerRuntimeLifecycle: ExecutionAttempt["runtimeLifecycle"];
  readonly delivered: boolean;
  readonly reviewDecided: boolean;
  readonly integrated: boolean;
  readonly waitingFor:
    | "worker-start"
    | "worker-execution"
    | "supervisor-review"
    | "integration"
    | "quota"
    | null;
}

export interface AutoIterationOverview {
  readonly supervisor: {
    readonly roleSlotId: string;
    readonly tenureId: string;
    readonly generation: number;
    readonly status: SupervisorTenureStatus;
    readonly sessionId: string;
  } | null;
  readonly workOrders: readonly AutoIterationWorkOrderOverview[];
  readonly pendingInboxEntries: number;
  readonly quotaWaiting: boolean;
  readonly lastObservedAt: number | null;
}

/** Host lifecycle seam missing from the six frozen model tools. */
export interface AutoIterationHostLifecycle {
  bindInitialSupervisor(binding: InitialSupervisorBinding): Promise<{
    readonly roleSlotId: string;
    readonly tenureId: string;
    readonly generation: number;
  }>;
  bindAttemptSession(binding: AttemptSessionBinding): Promise<ExecutionAttempt>;
  updateAttemptRuntime(mutation: AttemptRuntimeMutation): Promise<ExecutionAttempt>;
  recordArtifact(reference: ArtifactReference): Promise<void>;
  /** Completes the durable review action, persisting its frozen candidate when required. */
  completeReviewDisposition(disposition: {
    readonly reviewDecisionId: string;
    readonly candidate?: IntegrationCandidate;
  }): Promise<void>;
  markHandoffIncluded(mutation: HandoffIncludedMutation): Promise<Extract<
    HandoffReceipt,
    { readonly level: "included-in-parent-input" }
  >>;
  readPendingOutbox(): Promise<readonly PendingAutoIterationOutboxEntry[]>;
  /**
   * Records the terminal integration outcome for one frozen candidate in the
   * same Project transaction that advanced its Work Order lifecycle; the
   * supervisor inbox is notified for `blocked: target-moved`.
   */
  completeIntegration(disposition: {
    readonly integrationCandidateId: string;
    readonly outcome: IntegrationOutcome;
  }): Promise<void>;
  /** Frozen candidates that still owe an integration outcome (reopen resume driver). */
  readIntegrationBacklog(): Promise<readonly PendingIntegration[]>;
  completeSupervisorRotation(
    completion: SupervisorRotationCompletion,
  ): Promise<SupervisorTenure>;
  /** Synchronous like the channel's other snapshot reads; serves the live view. */
  readAutoIterationOverview(): AutoIterationOverview;
  /** Sensor facts land in the Project transaction, not a side file. */
  observeQuota(observation: QuotaObservation): Promise<void>;
  observeContextUsage(observation: ContextUsageObservation): Promise<void>;
}

/**
 * What the backend hands to the MCP tool bridge and the wakeup path. The
 * coordinator contract and the host lifecycle together are the Project's
 * single auto-iteration authority.
 */
export type AutoIterationProjectAuthority =
  & AutoIterationCoordinatorPort
  & AutoIterationHostLifecycle;
