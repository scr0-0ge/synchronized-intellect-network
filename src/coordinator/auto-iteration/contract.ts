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

/**
 * Issue #8 M3: resolved at submission time from the Work Order's `review`
 * field (or its default). `independent` always carries a concrete reviewer
 * Session; `sameEndpointAsWorker` is true only when no differing default
 * endpoint exists, so the projection can flag it per §3.
 */
export type WorkOrderReviewPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "independent";
      readonly reviewerSession: SessionCreationParameters;
      readonly sameEndpointAsWorker: boolean;
    };

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
  /**
   * Absent only for rows persisted before issue #8 M3; such legacy orders
   * read as `{ kind: "none" }` (no retroactive review requirement) rather
   * than a permanently un-disposable gate. Every order submitted through
   * `submitWorkOrder` after this change always carries a resolved value.
   */
  readonly review?: WorkOrderReviewPolicy;
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

/**
 * Issue #8 M3: one concrete, checkable objection from an independent Review
 * Attempt. `code` is a short reviewer-chosen tag; a problem the reviewer
 * cannot concretely substantiate is reported with `code: "cannot-verify"`
 * rather than omitted.
 */
export interface ReviewProblem {
  readonly code: string;
  readonly message: string;
}

export type ReviewVerdict = "agree" | "disagree";

export interface ReviewSubmission {
  readonly handoff: HandoffIdempotencyKey;
  readonly verdict: ReviewVerdict;
  readonly problems: readonly ReviewProblem[];
}

/** The independent review's durable outcome, keyed to one Handoff; write-once. */
export interface ReviewResult {
  readonly handoff: HandoffIdempotencyKey;
  readonly verdict: ReviewVerdict;
  readonly problems: readonly ReviewProblem[];
  readonly reviewerSessionId: string;
}

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
  /**
   * Issue #8 M3 publish policy: absent while `integrated` (locally merged,
   * not pushed — the candidate is "ready-to-publish"); set once a
   * `publish_candidate` attempt runs. `blocked: target-moved` is retriable;
   * `published` is terminal.
   */
  readonly publishOutcome?: PublishOutcome;
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

/**
 * Issue #8 M3 publish policy: pushing the target branch to its remote is a
 * distinct, later, supervisor-triggered step from local integration. Reuses
 * the exact target-moved detection shape as w340's integration recheck,
 * against the remote instead of the local branch.
 */
export type PublishOutcome =
  | {
      readonly status: "published";
      readonly remoteCommitSha: string;
      readonly publishedAt: number;
    }
  | {
      readonly status: "blocked: target-moved";
      readonly expectedBaselineCommitSha: string;
      readonly observedRemoteCommitSha: string | null;
    };

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
  /**
   * Issue #8 M3. Omit for the default independent review (a different
   * endpoint/model than `workerSession` when an obvious complement exists);
   * pass explicit `SessionCreationParameters` to pick the reviewer Session;
   * pass `"none"` to skip independent review entirely (only case in which
   * `submit_review_decision` is not gated on a recorded review result).
   */
  readonly review?: "none" | SessionCreationParameters;
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

/** Issue #8 M3: supervisor-only; the host performs the actual remote push. */
export interface PublishCandidateRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "publish-candidate";
  readonly integrationCandidateId: string;
}

export type SupervisorToolRequest =
  | SubmitWorkOrderRequest
  | ReadWorkOrderStatusRequest
  | ReadInboxRequest
  | SubmitReviewDecisionRequest
  | RequestSupervisorRotationRequest
  | PublishCandidateRequest;

export type WorkerToolRequest =
  | ReadWorkOrderStatusRequest
  | SubmitHandoffRequest
  | ReadInboxRequest;

/**
 * Issue #8 M3: a Review Attempt's tool surface. Deliberately narrower than
 * the worker's three (`read-work-order-status`/`read-inbox` would carry
 * every Handoff `body`, i.e. the worker's own reasoning, into the reviewer's
 * context — exactly what §3.6's "no worker reasoning" principle forbids).
 * See the coordinator/session-authority evidence note for this deviation
 * from the work order's literal "worker's three plus these two" phrasing.
 */
export interface ReadHandoffArtifactRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "read-handoff-artifact";
  readonly handoff: HandoffIdempotencyKey;
}

/** Host-augmented after the coordinator authorizes the read (no git access there). */
export interface ReadHandoffArtifactResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "handoff-artifact";
  readonly workOrderObjective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly baselineCommitSha: string;
  readonly commitSha: string;
  /** Unified diff baseline..commitSha; filled in by the host after this read. */
  readonly diff: string;
}

export interface SubmitReviewRequest extends CoordinatorToolRequestMetadata {
  readonly kind: "submit-review";
  readonly review: ReviewSubmission;
}

export interface ReviewSubmittedResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "review-submitted";
  readonly result: ReviewResult;
}

export type ReviewerToolRequest = ReadHandoffArtifactRequest | SubmitReviewRequest;
export type ReviewerToolResponse =
  | ReadHandoffArtifactResponse
  | ReviewSubmittedResponse
  | CoordinatorToolRejectedResponse;

export type CoordinatorToolRequest =
  | SupervisorToolRequest
  | WorkerToolRequest
  | ReviewerToolRequest;

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
    }
  | {
      readonly kind: "reviewer";
      readonly sessionId: string;
      readonly handoff: HandoffIdempotencyKey;
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
  /** Issue #8 M3: independent Review Attempt results recorded for this order's Handoffs. */
  readonly independentReviews: readonly ReviewResult[];
  /**
   * Issue #8 M4 (w349 unsettled): the same host projection `read_work_order_status`
   * used to omit, mirroring `AutoIterationWorkOrderOverview` for this one
   * order — a model tool caller previously only ever saw the durable
   * `workOrder.status` (e.g. `executing` even while queued behind the
   * worker concurrency cap).
   */
  readonly projectedStatus: WorkOrderStatus | "queued";
  readonly waitingFor: AutoIterationWorkOrderOverview["waitingFor"];
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

/**
 * Issue #8 M3: an internal handoff between the coordinator (which validated
 * eligibility) and the host (which alone can push). Never returned to the
 * model — `drainingRequest` always replaces it with a `publish-candidate-result`
 * after performing (or skipping, if already terminal) the actual push.
 */
export interface PublishCandidateAcceptedResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "publish-candidate-accepted";
  readonly candidate: IntegrationCandidate;
}

export interface PublishCandidateResultResponse
  extends CoordinatorToolResponseMetadata {
  readonly kind: "publish-candidate-result";
  readonly outcome: PublishOutcome;
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
    | "job-still-running"
    | "not-found"
    | "stale-generation"
    | "stale-version"
    | "storage-unavailable"
    /** Issue #8 M3: `submit_review_decision` with no recorded review result. */
    | "review-required"
    /** Issue #8 M3: `publish_candidate` targets a candidate not yet `integrated`. */
    | "not-integrated"
    /** Issue #8 M3: a `rework` decision would exceed the per-order rework cap. */
    | "rework-limit-reached"
    /** Issue #8 M4: `submit_work_order` while the queued backlog is already at its cap. */
    | "queue-limit-reached";
}

export type CoordinatorToolResponse =
  | WorkOrderSubmittedResponse
  | WorkOrderStatusResponse
  | HandoffSubmittedResponse
  | InboxReadResponse
  | ReviewDecisionSubmittedResponse
  | SupervisorRotationRequestedResponse
  | PublishCandidateAcceptedResponse
  | PublishCandidateResultResponse
  | ReadHandoffArtifactResponse
  | ReviewSubmittedResponse
  | CoordinatorToolRejectedResponse;

export type SupervisorToolResponse =
  | WorkOrderSubmittedResponse
  | WorkOrderStatusResponse
  | InboxReadResponse
  | ReviewDecisionSubmittedResponse
  | SupervisorRotationRequestedResponse
  | PublishCandidateAcceptedResponse
  | PublishCandidateResultResponse
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
  request(
    actor: Extract<HostBoundToolActor, { readonly kind: "reviewer" }>,
    request: ReviewerToolRequest,
  ): Promise<ReviewerToolResponse>;
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
  /**
   * Issue #8 M2: the parameters this Session was actually created with
   * (endpoint/model/effort/mode; never a credential). Persisted into the
   * tenure record so a later ≥70%-context rotation can mirror them into a
   * successor even after a Project reopen loses any in-memory copy.
   */
  readonly sessionCreationParameters?: SessionCreationParameters;
}

/**
 * Issue #8 M4 (w353 unsettled): durable counterpart of the in-memory
 * `reviewSessionIdFor`, the same method w344 used for the supervisor's own
 * creation parameters — a host-only recovery hint, not a business fact.
 */
export interface ReviewSessionBinding {
  readonly handoff: HandoffIdempotencyKey;
  readonly sessionId: string;
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
  /**
   * Durable business state, except `queued`: a work order whose worker has
   * not started while the per-Project worker concurrency cap holds reads as
   * `queued`. The durable row stays `executing` (the v7 column CHECK carries
   * no `queued`); the queue itself is the pending start-attempt outbox entry.
   */
  readonly status: WorkOrderStatus | "queued";
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
    /**
     * Issue #8 M4: finer-grained reasons the coarser literals above used to
     * conflate. `supervisor-busy` is the mid-turn default (deferred to the
     * next turn boundary, including "never attempted yet"); `supervisor-recovering`
     * is set only once a wakeup attempt is observed landing in
     * `recovery-required` (read back from the Session's own durable
     * lifecycle status, not a new persisted flag). `quota:<pool>` and
     * `integration-blocked:<reason>` carry the pool id / outcome reason
     * inline in the string rather than adding a field.
     */
    | "supervisor-busy"
    | "supervisor-recovering"
    | "queued-limit"
    | `quota:${string}`
    | "review-pending"
    | "integration-running"
    | `integration-blocked:${string}`
    | "ready-to-publish"
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
  /** Host-only lookup used to mirror the active supervisor after a Project reopen. */
  readSupervisorSessionCreationParameters(
    sessionId: string,
  ): SessionCreationParameters | undefined;
  /** Sensor facts land in the Project transaction, not a side file. */
  observeQuota(observation: QuotaObservation): Promise<void>;
  observeContextUsage(observation: ContextUsageObservation): Promise<void>;
  /** Host-only full read; drives review-Session starting and the wakeup summary. */
  readWorkOrder(workOrderId: string): WorkOrder | undefined;
  /** The recorded independent review for one Handoff, if any (gate + wakeup summary). */
  readReviewResult(handoff: HandoffIdempotencyKey): ReviewResult | undefined;
  /** Issue #8 M4: persists a Review Attempt's Session id; a best-effort recovery hint, not a business fact. */
  bindReviewSession(binding: ReviewSessionBinding): Promise<void>;
  /** Host-only lookup mirroring `readSupervisorSessionCreationParameters`, used to re-bind a Review Attempt's tools after a Project reopen. */
  readReviewSessionId(handoff: HandoffIdempotencyKey): string | undefined;
  /** Host-only: the current attempt's Handoff key for a work order, if one has been submitted. */
  readCurrentHandoff(workOrderId: string): HandoffIdempotencyKey | undefined;
  /**
   * Records the terminal or retriable publish outcome for one already-
   * `integrated` candidate. Idempotent for the same terminal `published`
   * outcome; a prior `blocked: target-moved` may be overwritten by a retry.
   */
  completePublish(disposition: {
    readonly integrationCandidateId: string;
    readonly outcome: PublishOutcome;
  }): Promise<void>;
}

/**
 * What the backend hands to the MCP tool bridge and the wakeup path. The
 * coordinator contract and the host lifecycle together are the Project's
 * single auto-iteration authority.
 */
export type AutoIterationProjectAuthority =
  & AutoIterationCoordinatorPort
  & AutoIterationHostLifecycle;
