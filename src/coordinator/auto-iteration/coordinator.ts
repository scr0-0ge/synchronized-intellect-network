import { randomUUID } from "node:crypto";

import type { DurableRuntimeEndpointId } from "../work-ledger-auth-generation.ts";
import type {
  ArtifactReference,
  AttemptRuntimeMutation,
  AttemptSessionBinding,
  AutoIterationOverview,
  AutoIterationProjectAuthority,
  AutoIterationWorkOrderOverview,
  ContextUsageObservation,
  CoordinatorToolRejectedResponse,
  CoordinatorToolRequest,
  CoordinatorToolResponse,
  ExecutionAttempt,
  HandoffIdempotencyKey,
  HandoffIncludedMutation,
  HandoffReceipt,
  HostBoundToolActor,
  InboxReadResponse,
  InitialSupervisorBinding,
  IntegrationCandidate,
  IntegrationOutcome,
  InboxEntry,
  PendingAutoIterationOutboxEntry,
  PendingIntegration,
  PublishCandidateAcceptedResponse,
  PublishCandidateRequest,
  PublishCandidateResultResponse,
  PublishOutcome,
  QuotaObservation,
  ReadHandoffArtifactRequest,
  ReadHandoffArtifactResponse,
  ReadInboxRequest,
  ReadWorkOrderStatusRequest,
  ReviewDecision,
  ReviewDecisionSubmittedResponse,
  ReviewerToolRequest,
  ReviewerToolResponse,
  ReviewResult,
  ReviewSessionBinding,
  ReviewSubmittedResponse,
  SessionConfigurationState,
  SessionCreationParameters,
  SubmitHandoffRequest,
  SubmitReviewDecisionRequest,
  SubmitReviewRequest,
  SubmitWorkOrderRequest,
  SupervisorRotationCompletion,
  SupervisorRotationRequestedResponse,
  SupervisorTenure,
  SupervisorToolRequest,
  SupervisorToolResponse,
  WorkerToolRequest,
  WorkerToolResponse,
  WorkOrder,
  WorkOrderReviewPolicy,
  WorkOrderStatus,
  WorkOrderStatusResponse,
  WorkOrderSubmittedResponse,
} from "./contract.ts";
import { productionQuotaPoolId } from "./quota-pool.ts";
import { AutoIterationProjectStore } from "./project-store.ts";
import { assertWorkOrderTransition } from "./state-machine.ts";

/** Matches the existing renderer direct-input bound and is measured in code points. */
export const HANDOFF_BODY_MAX_CODE_POINTS = 8_000;

/**
 * Issue #8 M1: at most this many worker attempts are in flight per Project.
 * Work orders beyond the cap keep their start-attempt outbox entry pending
 * (that entry is the queue) and read as `queued` until a slot frees.
 */
export const WORKER_ATTEMPT_CONCURRENCY_LIMIT = 4;

/**
 * Issue #8 M3: at most this many rework cycles per Work Order. `attemptNumber`
 * starts at 1 (the original delivery); a value above the limit is the count
 * of reworks already spent, not the limit itself.
 */
export const REWORK_ATTEMPT_LIMIT = 2;

/**
 * Issue #8 M4: backpressure on the queue itself, not just the worker slots
 * it feeds. `queued` work orders beyond `WORKER_ATTEMPT_CONCURRENCY_LIMIT`
 * already wait for a slot; once that backlog also reaches twice the slot
 * count, a further `submit_work_order` is refused with a reason instead of
 * silently growing the queue forever.
 */
export const QUEUE_REJECTION_LIMIT = WORKER_ATTEMPT_CONCURRENCY_LIMIT * 2;

export type {
  AttemptRuntimeMutation,
  AttemptSessionBinding,
  AutoIterationProjectAuthority,
  HandoffIncludedMutation,
  InitialSupervisorBinding,
} from "./contract.ts";

class AutoIterationRejection extends Error {
  readonly category: CoordinatorToolRejectedResponse["category"];
  readonly currentVersion: number | null;

  constructor(
    category: CoordinatorToolRejectedResponse["category"],
    currentVersion: number | null,
  ) {
    super(category);
    this.category = category;
    this.currentVersion = currentVersion;
  }
}

export class AutoIterationCoordinator implements AutoIterationProjectAuthority {
  private readonly store: AutoIterationProjectStore;
  private readonly createId: () => string;
  private readonly resolveQuotaPoolId: (endpointId: DurableRuntimeEndpointId) => string;

  constructor(
    store: AutoIterationProjectStore,
    createId: () => string = randomUUID,
    resolveQuotaPoolId: (endpointId: DurableRuntimeEndpointId) => string = productionQuotaPoolId,
  ) {
    this.store = store;
    this.createId = createId;
    this.resolveQuotaPoolId = resolveQuotaPoolId;
  }

  async bindInitialSupervisor(binding: InitialSupervisorBinding) {
    assertNonEmpty(binding.roleSlotId);
    assertNonEmpty(binding.sessionId);
    if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
      throw new Error("invalid-supervisor-generation");
    }
    return this.store.transaction(() => {
      const existingRole = this.store.roleSlot(binding.roleSlotId);
      if (existingRole !== undefined) {
        const existingTenure =
          existingRole.currentTenureId === null
            ? undefined
            : this.store.tenure(existingRole.currentTenureId);
        if (
          existingTenure === undefined ||
          existingTenure.sessionId !== binding.sessionId ||
          existingTenure.generation !== binding.generation ||
          existingTenure.status !== "active"
        ) {
          throw new Error("initial-supervisor-conflict");
        }
        return {
          roleSlotId: existingRole.roleSlotId,
          tenureId: existingTenure.tenureId,
          generation: existingTenure.generation,
        };
      }
      const tenureId = `tenure-${this.createId()}`;
      this.store.insertRoleSlot({
        roleSlotId: binding.roleSlotId,
        projectId: this.store.projectId,
        responsibility: "supervisor",
        currentTenureId: tenureId,
        version: 1,
      });
      this.store.insertTenure(
        {
          tenureId,
          roleSlotId: binding.roleSlotId,
          generation: binding.generation,
          sessionId: binding.sessionId,
          status: "active",
          version: 1,
        },
        // Issue #8 M2: the tenure record is the durable home for the
        // Session's own creation parameters (no schema bump: this reuses the
        // existing session_configuration_json column). A later rotation's
        // cutover already mirrors this value forward generation to
        // generation (completeSupervisorRotation's successorConfiguration
        // fallback), so recording it here is enough for every later hop to
        // survive a Project reopen.
        binding.sessionCreationParameters === undefined
          ? undefined
          : ({
              state: "requested",
              requested: binding.sessionCreationParameters,
            } satisfies SessionConfigurationState),
      );
      this.store.appendEvent("supervisor-bound", tenureId, undefined, binding.sessionId);
      return { roleSlotId: binding.roleSlotId, tenureId, generation: binding.generation };
    });
  }

  async bindAttemptSession(binding: AttemptSessionBinding): Promise<ExecutionAttempt> {
    assertNonEmpty(binding.attemptId);
    assertNonEmpty(binding.sessionId);
    return this.store.transaction(() => {
      const attempt = this.store.attempt(binding.attemptId);
      if (attempt === undefined) throw new Error("attempt-not-found");
      if (attempt.sessionId !== null && attempt.sessionId !== binding.sessionId) {
        throw new Error("attempt-session-conflict");
      }
      if (attempt.sessionId === binding.sessionId && binding.configuration === undefined) {
        return attempt;
      }
      const updated: ExecutionAttempt = {
        ...attempt,
        sessionId: binding.sessionId,
        sessionConfiguration: binding.configuration ?? attempt.sessionConfiguration,
        version: attempt.version + 1,
      };
      this.store.updateAttempt(updated, attempt.version);
      this.store.completeOutbox("start-attempt", attempt.attemptId);
      this.store.appendEvent("attempt-session-bound", attempt.attemptId, undefined, binding.sessionId);
      return updated;
    });
  }

  async updateAttemptRuntime(mutation: AttemptRuntimeMutation): Promise<ExecutionAttempt> {
    assertNonEmpty(mutation.attemptId);
    return this.store.transaction(() => {
      const attempt = this.store.attempt(mutation.attemptId);
      if (attempt === undefined) throw new Error("attempt-not-found");
      if (
        attempt.slotState === "released" && mutation.slotState !== "released" ||
        attempt.slotState === "owned" && mutation.slotState === "unreserved"
      ) {
        throw new Error("attempt-slot-regression");
      }
      const updated: ExecutionAttempt = {
        ...attempt,
        runtimeLifecycle: mutation.runtimeLifecycle,
        slotState: mutation.slotState,
        ...(mutation.workspaceId === undefined ? {} : { workspaceId: mutation.workspaceId }),
        version: attempt.version + 1,
      };
      this.store.updateAttempt(updated, attempt.version);
      this.store.appendEvent(
        "attempt-runtime-updated",
        attempt.attemptId,
        {
          runtimeLifecycle: updated.runtimeLifecycle,
          slotState: updated.slotState,
        },
        updated.sessionId ?? undefined,
      );
      return updated;
    });
  }

  async recordArtifact(reference: ArtifactReference): Promise<void> {
    validateArtifact(reference);
    this.store.transaction(() => {
      const existing = this.store.artifact(reference.artifactId);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(reference)) {
          throw new Error("artifact-idempotency-conflict");
        }
        return;
      }
      this.store.insertArtifact(reference);
      this.store.appendEvent("artifact-recorded", reference.artifactId);
    });
  }

  async completeReviewDisposition(disposition: {
    readonly reviewDecisionId: string;
    readonly candidate?: IntegrationCandidate;
  }): Promise<void> {
    assertNonEmpty(disposition.reviewDecisionId);
    this.store.transaction(() => {
      const review = this.store.review(disposition.reviewDecisionId);
      if (review === undefined) throw new Error("review-decision-not-found");
      const handoff = this.store.handoff(review.handoff);
      const workOrder = this.store.workOrder(review.handoff.workOrderId);
      if (handoff === undefined || workOrder === undefined) {
        throw new Error("review-disposition-target-not-found");
      }
      const candidateRequired =
        review.decision === "approve" &&
        workOrder.currentAttemptId === review.handoff.attemptId &&
        workOrder.completionCondition.gitIntegration === "required";
      if (candidateRequired !== (disposition.candidate !== undefined)) {
        throw new Error("review-disposition-candidate-mismatch");
      }
      if (disposition.candidate !== undefined) {
        const expectedCommits = handoff.handoff.artifacts
          .filter((artifact) => artifact.kind === "git-commit")
          .map((artifact) => artifact.commitSha);
        if (
          workOrder.status !== "awaiting-integration" ||
          disposition.candidate.baselineCommitSha !== workOrder.baselineCommitSha ||
          canonicalJson(disposition.candidate.orderedCommitShas) !==
            canonicalJson(expectedCommits) ||
          canonicalJson(disposition.candidate.handoffs) !==
            canonicalJson([review.handoff]) ||
          canonicalJson(disposition.candidate.reviewDecisionIds) !==
            canonicalJson([review.reviewDecisionId])
        ) {
          throw new Error("integration-candidate-does-not-match-review");
        }
      }
      const completed = this.store.completeReviewDisposition(
        review.reviewDecisionId,
        disposition.candidate,
      );
      if (!completed) return;
      this.store.appendEvent(
        disposition.candidate === undefined
          ? "review-disposition-completed"
          : "integration-candidate-recorded",
        disposition.candidate?.integrationCandidateId ?? review.reviewDecisionId,
        { reviewDecisionId: review.reviewDecisionId },
      );
    });
  }

  async markHandoffIncluded(
    mutation: HandoffIncludedMutation,
  ): Promise<Extract<HandoffReceipt, { readonly level: "included-in-parent-input" }>> {
    validateHandoffKey(mutation.handoff);
    assertNonEmpty(mutation.parentCommandId);
    return this.store.transaction(() => {
      const handoff = this.store.handoff(mutation.handoff);
      if (handoff === undefined) throw new Error("handoff-not-found");
      const existing = this.store.receipt(mutation.handoff, "included-in-parent-input");
      if (existing !== undefined) {
        if (
          existing.level !== "included-in-parent-input" ||
          existing.parentCommandId !== mutation.parentCommandId
        ) {
          throw new Error("parent-input-receipt-conflict");
        }
        return existing;
      }
      const receipt = {
        level: "included-in-parent-input",
        handoff: mutation.handoff,
        handoffVersion: handoff.handoff.version,
        parentCommandId: mutation.parentCommandId,
      } as const;
      this.store.insertReceipt(receipt);
      const inbox = this.store.handoffInbox(mutation.handoff);
      if (inbox !== undefined && inbox.state === "pending") {
        this.store.updateInboxState(inbox, "included-in-parent-input");
      }
      this.store.completeOutbox("inbox-wakeup", handoffDedupeKey(mutation.handoff));
      this.store.appendEvent("handoff-included-in-parent-input", mutation.handoff.handoffId, {
        parentCommandId: mutation.parentCommandId,
      });
      return receipt;
    });
  }

  async readPendingOutbox(): Promise<readonly PendingAutoIterationOutboxEntry[]> {
    return this.store.readTransaction(() => this.store.pendingOutbox());
  }

  async readIntegrationBacklog(): Promise<readonly PendingIntegration[]> {
    return this.store.readTransaction(() => this.store.integrationBacklog());
  }

  async completeIntegration(disposition: {
    readonly integrationCandidateId: string;
    readonly outcome: IntegrationOutcome;
  }): Promise<void> {
    assertNonEmpty(disposition.integrationCandidateId);
    return this.store.transaction(() => {
      const recorded = this.store.completeIntegration(
        disposition.integrationCandidateId,
        disposition.outcome,
      );
      if (!recorded.applied) return;
      const workOrder = this.store.workOrder(recorded.workOrderId);
      if (workOrder === undefined) {
        throw new Error("integration-work-order-not-found");
      }
      const nextStatus = disposition.outcome.status === "integrated"
        ? "integrated"
        : "blocked";
      const status = assertWorkOrderTransition(workOrder.status, nextStatus);
      this.store.updateWorkOrder(
        { ...workOrder, status, version: workOrder.version + 1 },
        workOrder.version,
      );
      if (disposition.outcome.status === "blocked: target-moved") {
        // The supervisor decides whether to re-freeze a candidate or accept
        // the moved target; this inbox entry is the durable wake-up trace.
        const inboxEntry: InboxEntry = {
          inboxEntryId: `inbox-${this.createId()}`,
          roleSlotId: workOrder.responsibleRoleSlotId,
          state: "pending",
          kind: "blocked",
          workOrderId: workOrder.workOrderId,
          summary:
            `integration candidate ${disposition.integrationCandidateId} blocked: ` +
            `target branch moved (expected ${disposition.outcome.expectedBaselineCommitSha}, ` +
            `observed ${disposition.outcome.observedLocalBranchCommitSha ?? "unknown"})`,
          version: 1,
        };
        this.store.insertInbox(inboxEntry);
      }
      this.store.appendEvent(
        disposition.outcome.status === "integrated"
          ? "integration-completed"
          : "integration-blocked",
        disposition.integrationCandidateId,
        {
          reviewDecisionId: recorded.reviewDecisionId,
          status: disposition.outcome.status,
        },
      );
    });
  }

  async completePublish(disposition: {
    readonly integrationCandidateId: string;
    readonly outcome: PublishOutcome;
  }): Promise<void> {
    assertNonEmpty(disposition.integrationCandidateId);
    return this.store.transaction(() => {
      this.store.completePublish(disposition.integrationCandidateId, disposition.outcome);
      this.store.appendEvent(
        disposition.outcome.status === "published"
          ? "candidate-published"
          : "publish-blocked",
        disposition.integrationCandidateId,
        { status: disposition.outcome.status },
      );
    });
  }

  readWorkOrder(workOrderId: string): WorkOrder | undefined {
    return this.store.readTransaction(() => this.store.workOrder(workOrderId));
  }

  readReviewResult(handoff: HandoffIdempotencyKey): ReviewResult | undefined {
    return this.store.readTransaction(() => this.store.reviewResult(handoff));
  }

  async bindReviewSession(binding: ReviewSessionBinding): Promise<void> {
    assertNonEmpty(binding.sessionId);
    validateHandoffKey(binding.handoff);
    return this.store.transaction(() => {
      this.store.bindReviewSession(binding.handoff, binding.sessionId);
    });
  }

  readReviewSessionId(handoff: HandoffIdempotencyKey): string | undefined {
    return this.store.readTransaction(() => this.store.reviewSessionId(handoff));
  }

  readCurrentHandoff(workOrderId: string): HandoffIdempotencyKey | undefined {
    return this.store.readTransaction(() => {
      const workOrder = this.store.workOrder(workOrderId);
      if (workOrder === undefined) return undefined;
      return this.store
        .handoffs(workOrderId)
        .find((handoff) => handoff.idempotencyKey.attemptId === workOrder.currentAttemptId)
        ?.idempotencyKey;
    });
  }

  /**
   * Issue #8 M4: the per-order projection, factored out so both the host
   * overview (renderer) and `read_work_order_status` (model tool) compute
   * `queued`/`waitingFor` from the exact same logic. Does not open its own
   * transaction — every caller already holds one (`node:sqlite`'s
   * `DatabaseSync` does not support nested `BEGIN`).
   */
  private buildWorkOrderOverviews(): readonly AutoIterationWorkOrderOverview[] {
    const supervisorRole = this.store
      .roleSlots()
      .find((role) => role.responsibility === "supervisor");
    const supervisorSessionId =
      supervisorRole === undefined || supervisorRole.currentTenureId === null
        ? undefined
        : this.store.tenure(supervisorRole.currentTenureId)?.sessionId;
    const workOrders = this.store.workOrders();
    let occupyingBefore = 0;
    return workOrders.map((workOrder) => {
      const attempts = this.store.attempts(workOrder.workOrderId);
      const current =
        attempts.find((attempt) => attempt.attemptId === workOrder.currentAttemptId) ??
        attempts.at(-1);
      const delivered = this.store.handoffs(workOrder.workOrderId).length > 0;
      const reviewDecided = this.store.reviews(workOrder.workOrderId).length > 0;
      // Issue #8 M1 queue projection: an executing order whose worker has
      // not started while `limit` earlier orders still occupy worker slots
      // reads as `queued`; its start-attempt outbox entry stays pending.
      const occupies =
        workOrder.status === "executing" &&
        current !== undefined &&
        !terminalRuntimeLifecycle(current.runtimeLifecycle);
      const unbound = current === undefined || current.sessionId === null;
      const queued =
        workOrder.status === "executing" &&
        unbound &&
        occupyingBefore >= WORKER_ATTEMPT_CONCURRENCY_LIMIT;
      if (occupies) occupyingBefore += 1;
      const status: AutoIterationWorkOrderOverview["status"] = queued
        ? "queued"
        : workOrder.status;
      return {
        workOrderId: workOrder.workOrderId,
        status,
        currentAttemptId: workOrder.currentAttemptId,
        attemptCount: attempts.length,
        workerSessionBound: current?.sessionId !== null && current !== undefined,
        workerSessionId: current?.sessionId ?? null,
        workerRuntimeLifecycle:
          current?.runtimeLifecycle ?? "accepted",
        delivered,
        reviewDecided,
        integrated: workOrder.status === "integrated",
        waitingFor: queued
          ? "queued-limit"
          : this.workOrderWaitingFor(workOrder, current, supervisorSessionId),
      } satisfies AutoIterationWorkOrderOverview;
    });
  }

  /** Count of orders the queue projection currently reads as `queued` (issue #8 M4 backpressure). */
  private queuedWorkOrderCount(): number {
    return this.buildWorkOrderOverviews().filter((order) => order.status === "queued").length;
  }

  readAutoIterationOverview(): AutoIterationOverview {
    return this.store.readTransaction(() => {
      const supervisorRole = this.store
        .roleSlots()
        .find((role) => role.responsibility === "supervisor");
      const supervisorTenure =
        supervisorRole === undefined || supervisorRole.currentTenureId === null
          ? undefined
          : this.store.tenure(supervisorRole.currentTenureId);
      const workOrderViews = this.buildWorkOrderOverviews();
      return {
        supervisor:
          supervisorRole === undefined || supervisorTenure === undefined
            ? null
            : {
                roleSlotId: supervisorRole.roleSlotId,
                tenureId: supervisorTenure.tenureId,
                generation: supervisorTenure.generation,
                status: supervisorTenure.status,
                sessionId: supervisorTenure.sessionId,
              },
        workOrders: workOrderViews,
        pendingInboxEntries: this.store.pendingInboxEntryCount(),
        quotaWaiting: workOrderViews.some(
          (order) => order.status === "waiting-for-quota",
        ),
        lastObservedAt: this.store.latestObservationTime(),
      };
    });
  }

  readSupervisorSessionCreationParameters(
    sessionId: string,
  ): SessionCreationParameters | undefined {
    return this.store.readTransaction(() => {
      const role = this.store
        .roleSlots()
        .find((candidate) => candidate.responsibility === "supervisor");
      if (role === undefined || role.currentTenureId === null) return undefined;
      const tenure = this.store.tenure(role.currentTenureId);
      if (tenure === undefined || tenure.sessionId !== sessionId) return undefined;
      return extractSessionCreationParameters(
        this.store.successorConfiguration(tenure.tenureId),
      );
    });
  }

  async observeQuota(observation: QuotaObservation): Promise<void> {
    if (
      typeof observation.quotaPoolId !== "string" ||
      observation.quotaPoolId.trim().length === 0 ||
      !Number.isSafeInteger(observation.observedAt) ||
      observation.observedAt < 0
    ) {
      throw new Error("invalid-quota-observation");
    }
    this.store.transaction(() => {
      this.store.recordQuotaObservation(observation);
      this.applyQuotaBlocking(observation);
    });
  }

  /**
   * Issue #8 §3: a quota observation that positively establishes exhaustion
   * parks executing Work Orders at `waiting-for-quota`; a fresh read that
   * positively establishes availability is what releases them. An unknown
   * read can never establish either state.
   */
  private applyQuotaBlocking(observation: QuotaObservation): void {
    if (observation.status !== "observed") return;
    const exhausted = exhaustedQuotaWindows(observation.windows);
    for (const workOrder of this.store.workOrders()) {
      const attempt = this.store.attempt(workOrder.currentAttemptId);
      if (this.attemptQuotaPoolId(attempt) !== observation.quotaPoolId) continue;
      if (exhausted) {
        if (workOrder.status !== "executing") continue;
        this.store.updateWorkOrder(
          {
            ...workOrder,
            status: assertWorkOrderTransition(
              workOrder.status,
              "waiting-for-quota",
            ),
            version: workOrder.version + 1,
          },
          workOrder.version,
        );
        this.store.appendEvent("work-order-waiting-for-quota", workOrder.workOrderId, {
          quotaPoolId: observation.quotaPoolId,
          observedAt: observation.observedAt,
        });
      } else {
        if (workOrder.status !== "waiting-for-quota") continue;
        this.store.updateWorkOrder(
          {
            ...workOrder,
            status: assertWorkOrderTransition(workOrder.status, "executing"),
            version: workOrder.version + 1,
          },
          workOrder.version,
        );
        this.store.appendEvent("work-order-quota-available", workOrder.workOrderId, {
          quotaPoolId: observation.quotaPoolId,
          observedAt: observation.observedAt,
        });
      }
    }
  }

  async observeContextUsage(observation: ContextUsageObservation): Promise<void> {
    if (
      typeof observation.sessionId !== "string" ||
      observation.sessionId.trim().length === 0 ||
      !Number.isSafeInteger(observation.observedAt) ||
      observation.observedAt < 0
    ) {
      throw new Error("invalid-context-observation");
    }
    this.store.transaction(() => {
      this.store.recordContextObservation(observation);
    });
  }

  /** The quota pool this attempt's requested endpoint would draw from. */
  private attemptQuotaPoolId(attempt: ExecutionAttempt | undefined): string | undefined {
    if (attempt === undefined) return undefined;
    return this.resolveQuotaPoolId(attempt.sessionConfiguration.requested.endpointId);
  }

  /**
   * Issue #8 M4: the enumerable reason a work order (not already `queued`)
   * is not making progress. Each branch reads only fields the store already
   * persists — no new write path for this method itself, only reads (the
   * one new signal, `supervisor-recovering`, is backed by the channel's own
   * existing `sessions.lifecycle_status`, not a field this coordinator owns).
   */
  private workOrderWaitingFor(
    workOrder: WorkOrder,
    currentAttempt: ExecutionAttempt | undefined,
    supervisorSessionId: string | undefined,
  ): AutoIterationWorkOrderOverview["waitingFor"] {
    const status = workOrder.status;
    if (status === "awaiting-review") {
      const policy = workOrder.review ?? { kind: "none" as const };
      const currentHandoff = this.store
        .handoffs(workOrder.workOrderId)
        .find((handoff) => handoff.idempotencyKey.attemptId === workOrder.currentAttemptId);
      const reviewSatisfied =
        policy.kind !== "independent" ||
        (currentHandoff !== undefined &&
          this.store.reviewResult(currentHandoff.idempotencyKey) !== undefined);
      // Issue #8 §3 M3: an independent review the policy requires but that
      // has not landed yet blocks `submit_review_decision` outright, so it
      // is the more fundamentally correct reason regardless of supervisor
      // health.
      if (!reviewSatisfied) return "review-pending";
      // w344 left this distinction undone ("not worth a new mechanism" for
      // a display-only state); issue #8 M4 asks for it, and it is now free:
      // `sessions.lifecycle_status` already flips to `recovery-required` and
      // back on its own (the existing recovery-probe machinery), so this
      // reads a fact the channel already maintains rather than adding one.
      const supervisorLifecycle =
        supervisorSessionId === undefined
          ? undefined
          : this.store.sessionLifecycleStatus(supervisorSessionId);
      return supervisorLifecycle === "recovery-required"
        ? "supervisor-recovering"
        : "supervisor-busy";
    }
    if (status === "awaiting-integration") return "integration-running";
    if (status === "waiting-for-quota") {
      const poolId = this.attemptQuotaPoolId(currentAttempt);
      return poolId === undefined ? "quota" : `quota:${poolId}`;
    }
    if (status === "blocked") {
      for (const candidate of this.store.candidates(workOrder.workOrderId)) {
        const outcome = candidate.outcome;
        if (outcome !== undefined && outcome.status !== "integrated") {
          return `integration-blocked:${outcome.status.slice("blocked: ".length)}`;
        }
      }
      return null;
    }
    if (status === "integrated") {
      if (workOrder.completionCondition.gitIntegration !== "required") return null;
      const candidate = this.store.candidates(workOrder.workOrderId).at(-1);
      return candidate?.publishOutcome?.status === "published" ? null : "ready-to-publish";
    }
    if (status === "executing" || status === "delivered") {
      if (currentAttempt === undefined || currentAttempt.sessionId === null) {
        return "worker-start";
      }
      return terminalRuntimeLifecycle(currentAttempt.runtimeLifecycle)
        ? null
        : "worker-execution";
    }
    return null;
  }

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
  async request(
    actor: HostBoundToolActor,
    request: CoordinatorToolRequest,
  ): Promise<CoordinatorToolResponse> {
    const requestKey =
      typeof request.requestIdempotencyKey === "string"
        ? request.requestIdempotencyKey
        : "";
    const operation = request.kind;
    try {
      validateRequestMetadata(request);
      if (request.kind === "read-work-order-status") {
        return this.store.readTransaction(() =>
          this.readWorkOrderStatus(actor, request),
        );
      }
      if (request.kind === "read-inbox") {
        return this.store.readTransaction(() => this.readInbox(actor, request));
      }
      if (request.kind === "read-handoff-artifact") {
        return this.store.readTransaction(() =>
          this.readHandoffArtifact(actor, request),
        );
      }
      return this.store.transaction(() => this.mutate(actor, request));
    } catch (error) {
      const rejection =
        error instanceof AutoIterationRejection
          ? error
          : new AutoIterationRejection("storage-unavailable", null);
      return {
        kind: "rejected",
        requestIdempotencyKey: requestKey,
        currentVersion: rejection.currentVersion,
        operation,
        category: rejection.category,
      };
    }
  }

  private mutate(
    actor: HostBoundToolActor,
    request: Exclude<
      CoordinatorToolRequest,
      ReadWorkOrderStatusRequest | ReadInboxRequest | ReadHandoffArtifactRequest
    >,
  ): CoordinatorToolResponse {
    const actorJson = canonicalJson(actor);
    const requestJson = canonicalJson(request);
    const existing = this.store.request(request.requestIdempotencyKey);
    if (existing !== undefined) {
      if (
        existing.operation !== request.kind ||
        existing.actorJson !== actorJson ||
        existing.requestJson !== requestJson
      ) {
        throw new AutoIterationRejection("idempotency-conflict", null);
      }
      return JSON.parse(existing.responseJson) as CoordinatorToolResponse;
    }

    let response: CoordinatorToolResponse;
    switch (request.kind) {
      case "submit-work-order":
        response = this.submitWorkOrder(assertSupervisor(actor, request), request);
        break;
      case "submit-handoff":
        response = this.submitHandoff(assertWorker(actor), request);
        break;
      case "submit-review-decision":
        response = this.submitReviewDecision(assertSupervisor(actor, request), request);
        break;
      case "request-supervisor-rotation":
        response = this.rotateSupervisor(assertSupervisor(actor, request), request);
        break;
      case "publish-candidate":
        response = this.submitPublishCandidate(assertSupervisor(actor, request), request);
        break;
      case "submit-review":
        response = this.submitReview(assertReviewer(actor), request);
        break;
    }
    this.store.insertRequest(
      request.requestIdempotencyKey,
      request.kind,
      actorJson,
      requestJson,
      JSON.stringify(response),
    );
    return response;
  }

  private submitWorkOrder(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SubmitWorkOrderRequest,
  ): WorkOrderSubmittedResponse {
    const { role } = this.assertCurrentSupervisor(actor);
    assertExpectedVersion(request.expectedVersion, role.version);
    validateWorkOrderSubmission(request);
    if (this.store.roleSlot(request.workOrder.responsibleRoleSlotId) === undefined) {
      throw new AutoIterationRejection("not-found", null);
    }
    // Issue #8 M4 backpressure: refuse rather than let the queue grow
    // forever once it is already twice the size of the worker concurrency
    // cap it feeds. The supervisor gets a reason instead of silence.
    if (this.queuedWorkOrderCount() >= QUEUE_REJECTION_LIMIT) {
      throw new AutoIterationRejection("queue-limit-reached", role.version);
    }
    const workOrderId = `work-order-${this.createId()}`;
    const attemptId = `attempt-${this.createId()}`;
    // A submission whose OWN target pool's newest read says the window is
    // exhausted lands straight in the quota wait; it dispatches on release
    // like any other paused order. A different pool's exhaustion never
    // blocks this submission (issue #8 M2: pool-scoped, not global).
    const targetPoolId = this.resolveQuotaPoolId(
      request.workOrder.workerSession.endpointId,
    );
    const status = exhaustedQuotaWindows(
      this.store
        .latestQuotaObservations()
        .filter((entry) => entry.quotaPoolId === targetPoolId)
        .flatMap((entry) => entry.windows),
    )
      ? "waiting-for-quota"
      : "executing";
    const workOrder: WorkOrder = {
      workOrderId,
      objective: request.workOrder.objective,
      acceptanceCriteria: [...request.workOrder.acceptanceCriteria],
      baselineCommitSha: request.workOrder.baselineCommitSha,
      territory: {
        writePaths: [...request.workOrder.territory.writePaths],
        readOnlyPaths: [...request.workOrder.territory.readOnlyPaths],
      },
      responsibleRoleSlotId: request.workOrder.responsibleRoleSlotId,
      issuedBy: actor.tenure,
      completionCondition: request.workOrder.completionCondition,
      status,
      currentAttemptId: attemptId,
      version: 1,
      review: resolveReviewPolicy(request.workOrder.review, request.workOrder.workerSession),
    };
    const attempt: ExecutionAttempt = {
      attemptId,
      workOrderId,
      attemptNumber: 1,
      sessionId: null,
      sessionConfiguration: {
        state: "requested",
        requested: request.workOrder.workerSession,
      },
      runtimeLifecycle: "accepted",
      slotState: "unreserved",
      workspaceId: null,
      version: 1,
    };
    this.store.insertWorkOrder(workOrder);
    this.store.insertAttempt(attempt);
    this.store.insertOutbox(
      `outbox-${this.createId()}`,
      "start-attempt",
      attemptId,
      {
        attemptId,
        attemptNumber: attempt.attemptNumber,
        workOrderId,
        baselineCommitSha: workOrder.baselineCommitSha,
        workerSession: request.workOrder.workerSession,
      },
    );
    this.store.appendEvent("work-order-submitted", workOrderId, { attemptId });
    return {
      kind: "work-order-submitted",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: workOrder.version,
      workOrder,
      attempt,
    };
  }

  private submitHandoff(
    actor: Extract<HostBoundToolActor, { readonly kind: "worker" }>,
    request: SubmitHandoffRequest,
  ): CoordinatorToolResponse {
    validateHandoffSubmission(request);
    const key = request.handoff.idempotencyKey;
    if (
      actor.workOrderId !== key.workOrderId ||
      actor.attemptId !== key.attemptId
    ) {
      throw new AutoIterationRejection("forbidden", null);
    }
    const workOrder = this.store.workOrder(key.workOrderId);
    const attempt = this.store.attempt(key.attemptId);
    if (workOrder === undefined || attempt === undefined || attempt.workOrderId !== workOrder.workOrderId) {
      throw new AutoIterationRejection("not-found", null);
    }
    if (attempt.sessionId === null || attempt.sessionId !== actor.sessionId) {
      throw new AutoIterationRejection("forbidden", workOrder.version);
    }
    const existing = this.store.handoff(key);
    if (existing !== undefined) {
      if (
        existing.handoff.body !== request.handoff.body ||
        canonicalJson(existing.artifactIds) !== canonicalJson(request.handoff.artifactIds) ||
        existing.handoff.submittedBySessionId !== actor.sessionId
      ) {
        throw new AutoIterationRejection("idempotency-conflict", workOrder.version);
      }
      const receipt = this.store.receipt(key, "persisted");
      if (receipt === undefined || receipt.level !== "persisted") {
        throw new Error("missing-persisted-receipt");
      }
      return {
        kind: "handoff-submitted",
        requestIdempotencyKey: request.requestIdempotencyKey,
        currentVersion: workOrder.version,
        receipt,
      };
    }
    assertExpectedVersion(request.expectedVersion, workOrder.version);
    const artifacts = request.handoff.artifactIds.map((artifactId) => {
      const artifact = this.store.artifact(artifactId);
      if (artifact === undefined) {
        throw new AutoIterationRejection("invalid-request", workOrder.version);
      }
      return artifact;
    });
    const isCurrentAttempt = workOrder.currentAttemptId === attempt.attemptId;
    const handoff = {
      idempotencyKey: key,
      body: request.handoff.body,
      artifacts,
      submittedBySessionId: actor.sessionId,
      version: 1,
    } as const;
    this.store.insertHandoff(handoff, request.handoff.artifactIds, isCurrentAttempt);
    const receipt = {
      level: "persisted",
      handoff: key,
      handoffVersion: handoff.version,
    } as const;
    this.store.insertReceipt(receipt);
    this.store.insertInbox({
      inboxEntryId: `inbox-${this.createId()}`,
      roleSlotId: workOrder.responsibleRoleSlotId,
      state: "pending",
      kind: "handoff",
      handoff: key,
      version: 1,
    });
    this.store.insertOutbox(
      `outbox-${this.createId()}`,
      "inbox-wakeup",
      handoffDedupeKey(key),
      { roleSlotId: workOrder.responsibleRoleSlotId, handoff: key },
    );
    let currentVersion = workOrder.version;
    if (isCurrentAttempt) {
      let status = workOrder.status;
      status = advance(status, "delivered");
      status = advance(status, "awaiting-review");
      const updated = { ...workOrder, status, version: workOrder.version + 1 };
      this.store.updateWorkOrder(updated, workOrder.version);
      currentVersion = updated.version;
    }
    this.store.appendEvent(
      isCurrentAttempt ? "handoff-awaiting-review" : "late-handoff-archived",
      key.handoffId,
      { workOrderId: key.workOrderId, attemptId: key.attemptId },
      actor.sessionId,
    );
    return {
      kind: "handoff-submitted",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion,
      receipt,
    };
  }

  /** Issue #8 M3: a Review Attempt's own verdict, write-once per Handoff. */
  private submitReview(
    actor: Extract<HostBoundToolActor, { readonly kind: "reviewer" }>,
    request: SubmitReviewRequest,
  ): ReviewSubmittedResponse | CoordinatorToolRejectedResponse {
    validateReviewSubmissionPayload(request);
    const key = request.review.handoff;
    if (
      actor.handoff.workOrderId !== key.workOrderId ||
      actor.handoff.attemptId !== key.attemptId ||
      actor.handoff.handoffId !== key.handoffId
    ) {
      throw new AutoIterationRejection("forbidden", null);
    }
    const workOrder = this.store.workOrder(key.workOrderId);
    if (workOrder === undefined || this.store.handoff(key) === undefined) {
      throw new AutoIterationRejection("not-found", null);
    }
    const result: ReviewResult = {
      handoff: key,
      verdict: request.review.verdict,
      problems: request.review.problems.map((problem) => ({ ...problem })),
      reviewerSessionId: actor.sessionId,
    };
    const existing = this.store.reviewResult(key);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(result)) {
        throw new AutoIterationRejection("idempotency-conflict", workOrder.version);
      }
      return {
        kind: "review-submitted",
        requestIdempotencyKey: request.requestIdempotencyKey,
        currentVersion: workOrder.version,
        result: existing,
      };
    }
    this.store.insertReviewResult(result);
    this.store.appendEvent("review-result-recorded", key.handoffId, {
      workOrderId: key.workOrderId,
      verdict: result.verdict,
    }, actor.sessionId);
    return {
      kind: "review-submitted",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: workOrder.version,
      result,
    };
  }

  private readHandoffArtifact(
    actor: HostBoundToolActor,
    request: ReadHandoffArtifactRequest,
  ): ReadHandoffArtifactResponse | CoordinatorToolRejectedResponse {
    if (
      actor.kind !== "reviewer" ||
      actor.handoff.workOrderId !== request.handoff.workOrderId ||
      actor.handoff.attemptId !== request.handoff.attemptId ||
      actor.handoff.handoffId !== request.handoff.handoffId
    ) {
      throw new AutoIterationRejection("forbidden", null);
    }
    const workOrder = this.store.workOrder(request.handoff.workOrderId);
    const handoff = this.store.handoff(request.handoff);
    if (workOrder === undefined || handoff === undefined) {
      throw new AutoIterationRejection("not-found", null);
    }
    // No expectedVersion match against the Work Order here (unlike
    // read-work-order-status): this reads one Handoff's immutable facts, not
    // the order's own mutable state, and the reviewer has no other tool to
    // discover the order's current version before its first call.
    const commit = handoff.handoff.artifacts.find(
      (artifact) => artifact.kind === "git-commit",
    );
    if (commit === undefined || commit.kind !== "git-commit") {
      throw new AutoIterationRejection("invalid-request", workOrder.version);
    }
    return {
      kind: "handoff-artifact",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: workOrder.version,
      workOrderObjective: workOrder.objective,
      acceptanceCriteria: workOrder.acceptanceCriteria,
      baselineCommitSha: workOrder.baselineCommitSha,
      commitSha: commit.commitSha,
      // The host (backend.ts) fills this in from git after this authorized
      // read; the coordinator has no repository access of its own.
      diff: "",
    };
  }

  private submitPublishCandidate(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: PublishCandidateRequest,
  ): PublishCandidateAcceptedResponse | PublishCandidateResultResponse {
    const { role } = this.assertCurrentSupervisor(actor);
    assertExpectedVersion(request.expectedVersion, role.version);
    assertNonEmpty(request.integrationCandidateId);
    const candidate = this.store.integrationCandidateById(request.integrationCandidateId);
    if (candidate === undefined) throw new AutoIterationRejection("not-found", role.version);
    if (candidate.publishOutcome?.status === "published") {
      return {
        kind: "publish-candidate-result",
        requestIdempotencyKey: request.requestIdempotencyKey,
        currentVersion: role.version,
        outcome: candidate.publishOutcome,
      };
    }
    if (candidate.outcome?.status !== "integrated") {
      throw new AutoIterationRejection("not-integrated", role.version);
    }
    // The host performs the actual fetch/compare/push and reports back
    // through completePublish; this response never reaches the model as-is
    // (drainingRequest replaces it with the real publish-candidate-result).
    return {
      kind: "publish-candidate-accepted",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: role.version,
      candidate,
    };
  }

  private submitReviewDecision(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SubmitReviewDecisionRequest,
  ): ReviewDecisionSubmittedResponse {
    this.assertCurrentSupervisor(actor);
    validateReviewSubmission(request);
    const handoff = this.store.handoff(request.decision.handoff);
    if (handoff === undefined) throw new AutoIterationRejection("not-found", null);
    const workOrder = this.store.workOrder(request.decision.handoff.workOrderId);
    if (workOrder === undefined) throw new AutoIterationRejection("not-found", null);
    assertExpectedVersion(request.expectedVersion, workOrder.version);
    if (request.decision.handoffVersion !== handoff.handoff.version) {
      throw new AutoIterationRejection("stale-version", workOrder.version);
    }
    if (this.store.receipt(request.decision.handoff, "disposed") !== undefined) {
      throw new AutoIterationRejection("idempotency-conflict", workOrder.version);
    }
    if (
      request.decision.decision === "transfer" &&
      this.store.roleSlot(request.decision.targetRoleSlotId) === undefined
    ) {
      throw new AutoIterationRejection("not-found", workOrder.version);
    }
    const isCurrentAttempt = workOrder.currentAttemptId === request.decision.handoff.attemptId;
    // Issue #8 M3 §3: a disposition of the live Handoff (anything but
    // `transfer`, which only reassigns responsibility) requires a recorded
    // independent review first, unless the order's own policy opts out. A
    // legacy order with no resolved policy reads as `none` (§ WorkOrder.review).
    if (
      isCurrentAttempt &&
      request.decision.decision !== "transfer" &&
      (workOrder.review ?? { kind: "none" as const }).kind === "independent" &&
      this.store.reviewResult(request.decision.handoff) === undefined
    ) {
      throw new AutoIterationRejection("review-required", workOrder.version);
    }
    if (request.decision.decision === "rework") {
      const previousAttempt = this.store.attempt(request.decision.handoff.attemptId);
      if (
        previousAttempt !== undefined &&
        previousAttempt.attemptNumber > REWORK_ATTEMPT_LIMIT
      ) {
        throw new AutoIterationRejection("rework-limit-reached", workOrder.version);
      }
    }

    const decisionBase = {
      reviewDecisionId: `review-${this.createId()}`,
      handoff: request.decision.handoff,
      handoffVersion: request.decision.handoffVersion,
      decidedBy: actor.tenure,
      reason: request.decision.reason,
      version: 1,
    } as const;
    const decision: ReviewDecision =
      request.decision.decision === "transfer"
        ? {
            ...decisionBase,
            decision: "transfer",
            targetRoleSlotId: request.decision.targetRoleSlotId,
          }
        : { ...decisionBase, decision: request.decision.decision };
    this.store.insertReview(decision);

    let updatedWorkOrder = workOrder;
    if (isCurrentAttempt && decision.decision !== "transfer") {
      if (decision.decision === "approve") {
        let status = advance(workOrder.status, "review-approved");
        status = advance(
          status,
          workOrder.completionCondition.gitIntegration === "required"
            ? "awaiting-integration"
            : "integrated",
        );
        updatedWorkOrder = { ...workOrder, status, version: workOrder.version + 1 };
      } else if (decision.decision === "blocked") {
        updatedWorkOrder = {
          ...workOrder,
          status: advance(workOrder.status, "blocked"),
          version: workOrder.version + 1,
        };
      } else {
        const rework = advance(workOrder.status, "rework");
        const nextStatus = advance(rework, "executing");
        const previousAttempt = this.store.attempt(workOrder.currentAttemptId);
        if (previousAttempt === undefined) throw new Error("current-attempt-missing");
        const nextAttempt: ExecutionAttempt = {
          ...previousAttempt,
          attemptId: `attempt-${this.createId()}`,
          attemptNumber: previousAttempt.attemptNumber + 1,
          sessionId: null,
          runtimeLifecycle: "accepted",
          slotState: "unreserved",
          workspaceId: null,
          version: 1,
        };
        this.store.insertAttempt(nextAttempt);
        // Issue #8 M3 §3: the rework kickoff carries the independent
        // review's problems verbatim (not the supervisor's own `reason`)
        // when one was recorded for the reworked Handoff.
        const reworkReview = this.store.reviewResult(request.decision.handoff);
        const reworkFeedback =
          reworkReview !== undefined && reworkReview.problems.length > 0
            ? reworkReview.problems
                .map((problem) => `[${problem.code}] ${problem.message}`)
                .join("\n")
            : undefined;
        this.store.insertOutbox(
          `outbox-${this.createId()}`,
          "start-attempt",
          nextAttempt.attemptId,
          {
            attemptId: nextAttempt.attemptId,
            attemptNumber: nextAttempt.attemptNumber,
            workOrderId: workOrder.workOrderId,
            baselineCommitSha: workOrder.baselineCommitSha,
            sessionConfiguration: nextAttempt.sessionConfiguration,
            ...(reworkFeedback === undefined ? {} : { reworkFeedback }),
          },
        );
        updatedWorkOrder = {
          ...workOrder,
          status: nextStatus,
          currentAttemptId: nextAttempt.attemptId,
          version: workOrder.version + 1,
        };
      }
      this.store.updateWorkOrder(updatedWorkOrder, workOrder.version);
    }

    const inbox = this.store.handoffInbox(request.decision.handoff);
    if (inbox !== undefined && inbox.state !== "disposed") {
      this.store.updateInboxState(inbox, "disposed");
    }
    const receipt = {
      level: "disposed",
      handoff: request.decision.handoff,
      handoffVersion: handoff.handoff.version,
      reviewDecisionId: decision.reviewDecisionId,
    } as const;
    this.store.insertReceipt(receipt);
    this.store.completeOutbox("inbox-wakeup", handoffDedupeKey(request.decision.handoff));
    this.store.insertOutbox(
      `outbox-${this.createId()}`,
      "review-disposed",
      decision.reviewDecisionId,
      {
        decision: decision.reviewDecisionId,
        handoff: request.decision.handoff,
        workspaceId: this.store.attempt(request.decision.handoff.attemptId)?.workspaceId ?? null,
        ...(isCurrentAttempt &&
        decision.decision === "approve" &&
        workOrder.completionCondition.gitIntegration === "required"
          ? {
              integration: {
                integrationCandidateId: `candidate-${this.createId()}`,
                expectedTargetBaselineCommitSha: workOrder.baselineCommitSha,
                orderedCommitShas: handoff.handoff.artifacts
                  .filter((artifact) => artifact.kind === "git-commit")
                  .map((artifact) => artifact.commitSha),
                inputVersion: updatedWorkOrder.version,
              },
            }
          : {}),
      },
    );
    this.store.appendEvent("handoff-disposed", decision.reviewDecisionId, {
      decision: decision.decision,
      handoff: request.decision.handoff,
    });
    return {
      kind: "review-decision-submitted",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: updatedWorkOrder.version,
      decision,
      receipt,
    };
  }

  private rotateSupervisor(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: Extract<SupervisorToolRequest, { readonly kind: "request-supervisor-rotation" }>,
  ): SupervisorRotationRequestedResponse {
    const { role, tenure } = this.assertCurrentSupervisor(actor);
    if (request.roleSlotId !== role.roleSlotId) {
      throw new AutoIterationRejection("forbidden", role.version);
    }
    assertExpectedVersion(request.expectedVersion, role.version);
    validateSessionParameters(request.successorSession);
    // The model tool only records the request and parks the tenure. The real
    // successor Session must exist and acknowledge READY before the host calls
    // completeSupervisorRotation; the ledger never mints a placeholder session.
    const preparing = this.store.retireTenure(tenure, "successor-preparing");
    this.store.insertOutbox(
      `outbox-${this.createId()}`,
      "rotation",
      preparing.tenureId,
      {
        roleSlotId: role.roleSlotId,
        tenureId: preparing.tenureId,
        successorSession: request.successorSession,
      },
    );
    this.store.appendEvent("supervisor-rotation-requested", preparing.tenureId, {
      roleSlotId: role.roleSlotId,
      generation: tenure.generation,
    });
    return {
      kind: "supervisor-rotation-requested",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: role.version,
      tenure: preparing,
    };
  }

  async completeSupervisorRotation(
    completion: SupervisorRotationCompletion,
  ): Promise<SupervisorTenure> {
    assertNonEmpty(completion.roleSlotId);
    assertNonEmpty(completion.successorSessionId);
    return this.store.transaction(() => {
      const role = this.store.roleSlot(completion.roleSlotId);
      if (role === undefined || role.currentTenureId === null) {
        throw new Error("supervisor-role-not-found");
      }
      const tenure = this.store.tenure(role.currentTenureId);
      if (
        tenure === undefined ||
        tenure.status !== "successor-preparing" ||
        tenure.sessionId === completion.successorSessionId
      ) {
        throw new Error("supervisor-rotation-not-pending");
      }
      const retired = this.store.retireTenure(tenure);
      const nextTenure: SupervisorTenure = {
        tenureId: `tenure-${this.createId()}`,
        roleSlotId: role.roleSlotId,
        generation: tenure.generation + 1,
        sessionId: completion.successorSessionId,
        status: "active",
        version: 1,
      };
      this.store.insertTenure(
        nextTenure,
        completion.configuration === undefined
          ? this.store.successorConfiguration(tenure.tenureId)
          : completion.configuration,
      );
      const updatedRole = {
        ...role,
        currentTenureId: nextTenure.tenureId,
        version: role.version + 1,
      };
      this.store.updateRoleCurrentTenure(updatedRole);
      this.store.insertInbox({
        inboxEntryId: `inbox-${this.createId()}`,
        roleSlotId: role.roleSlotId,
        state: "pending",
        kind: "rotation",
        tenureId: nextTenure.tenureId,
        version: 1,
      });
      this.store.completeOutbox("rotation", tenure.tenureId);
      this.store.appendEvent("supervisor-cutover", nextTenure.tenureId, {
        previousTenureId: retired.tenureId,
        generation: nextTenure.generation,
        successorSessionId: nextTenure.sessionId,
      });
      return nextTenure;
    });
  }

  private readWorkOrderStatus(
    actor: HostBoundToolActor,
    request: ReadWorkOrderStatusRequest,
  ): WorkOrderStatusResponse {
    const workOrder = this.store.workOrder(request.workOrderId);
    if (workOrder === undefined) throw new AutoIterationRejection("not-found", null);
    if (actor.kind === "supervisor") {
      this.assertCurrentSupervisor(actor);
    } else if (actor.kind === "worker") {
      if (actor.workOrderId !== workOrder.workOrderId) {
        throw new AutoIterationRejection("forbidden", workOrder.version);
      }
    } else {
      // Issue #8 M3: a Review Attempt never gets this tool (§3.6 — it would
      // carry every Handoff's `body`, i.e. the worker's own reasoning).
      throw new AutoIterationRejection("forbidden", workOrder.version);
    }
    assertExpectedVersion(request.expectedVersion, workOrder.version);
    // Issue #8 M4 (w342 unsettled): the same host projection the renderer
    // overview uses, so a model tool caller sees `queued`/the enumerable
    // `waitingFor` reason instead of only ever the durable `executing` row.
    const projected = this.buildWorkOrderOverviews().find(
      (entry) => entry.workOrderId === workOrder.workOrderId,
    );
    return {
      kind: "work-order-status",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: workOrder.version,
      workOrder,
      attempts: this.store.attempts(workOrder.workOrderId),
      handoffs: this.store.handoffs(workOrder.workOrderId),
      reviews: this.store.reviews(workOrder.workOrderId),
      candidates: this.store.candidates(workOrder.workOrderId),
      receipts: this.store.receipts(workOrder.workOrderId),
      independentReviews: this.store.reviewResultsForWorkOrder(workOrder.workOrderId),
      projectedStatus: projected?.status ?? workOrder.status,
      waitingFor: projected?.waitingFor ?? null,
    };
  }

  private readInbox(actor: HostBoundToolActor, request: ReadInboxRequest): InboxReadResponse {
    const role = this.store.roleSlot(request.roleSlotId);
    if (role === undefined) throw new AutoIterationRejection("not-found", null);
    let workOrderId: string | undefined;
    if (actor.kind === "supervisor") {
      this.assertCurrentSupervisor(actor);
    } else if (actor.kind === "worker") {
      const workOrder = this.store.workOrder(actor.workOrderId);
      if (
        workOrder === undefined ||
        actor.attemptId !== workOrder.currentAttemptId ||
        request.roleSlotId !== workOrder.responsibleRoleSlotId
      ) {
        throw new AutoIterationRejection("forbidden", role.version);
      }
      workOrderId = actor.workOrderId;
    } else {
      throw new AutoIterationRejection("forbidden", role.version);
    }
    assertExpectedVersion(request.expectedVersion, role.version);
    return {
      kind: "inbox-read",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: role.version,
      entries: this.store.inbox(role.roleSlotId, workOrderId),
    };
  }

  private assertCurrentSupervisor(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
  ) {
    const role = this.store.roleSlot(actor.tenure.roleSlotId);
    if (role === undefined || role.currentTenureId === null) {
      throw new AutoIterationRejection("stale-generation", role?.version ?? null);
    }
    const tenure = this.store.tenure(role.currentTenureId);
    if (
      tenure === undefined ||
      tenure.status !== "active" ||
      tenure.generation !== actor.tenure.generation ||
      tenure.sessionId !== actor.sessionId
    ) {
      throw new AutoIterationRejection("stale-generation", role.version);
    }
    return { role, tenure };
  }
}

export function createAutoIterationCoordinator(
  store: AutoIterationProjectStore,
): AutoIterationProjectAuthority {
  return new AutoIterationCoordinator(store);
}

function assertSupervisor(
  actor: HostBoundToolActor,
  request: { readonly observedTenure: {
    readonly roleSlotId: string;
    readonly generation: number;
  } },
): Extract<HostBoundToolActor, { readonly kind: "supervisor" }> {
  if (
    actor.kind !== "supervisor" ||
    actor.tenure.roleSlotId !== request.observedTenure.roleSlotId ||
    actor.tenure.generation !== request.observedTenure.generation
  ) {
    throw new AutoIterationRejection("forbidden", null);
  }
  return actor;
}

function assertWorker(
  actor: HostBoundToolActor,
): Extract<HostBoundToolActor, { readonly kind: "worker" }> {
  if (actor.kind !== "worker") throw new AutoIterationRejection("forbidden", null);
  return actor;
}

function assertReviewer(
  actor: HostBoundToolActor,
): Extract<HostBoundToolActor, { readonly kind: "reviewer" }> {
  if (actor.kind !== "reviewer") throw new AutoIterationRejection("forbidden", null);
  return actor;
}

/**
 * Issue #8 §3: default to a differing endpoint/model when an obvious
 * complement exists (the two desktop CLIs this product wraps); otherwise
 * keep the worker's own endpoint and let `sameEndpointAsWorker` say so.
 */
function defaultDifferentEndpoint(
  workerEndpointId: DurableRuntimeEndpointId,
): DurableRuntimeEndpointId {
  if (workerEndpointId === "codex-desktop") return "claude-code-desktop";
  if (workerEndpointId === "claude-code-desktop") return "codex-desktop";
  return workerEndpointId;
}

function resolveReviewPolicy(
  review: "none" | SessionCreationParameters | undefined,
  workerSession: SessionCreationParameters,
): WorkOrderReviewPolicy {
  if (review === "none") return { kind: "none" };
  if (review !== undefined) {
    return {
      kind: "independent",
      reviewerSession: review,
      sameEndpointAsWorker: review.endpointId === workerSession.endpointId,
    };
  }
  const endpointId = defaultDifferentEndpoint(workerSession.endpointId);
  return {
    kind: "independent",
    reviewerSession: { endpointId, profile: workerSession.profile },
    sameEndpointAsWorker: endpointId === workerSession.endpointId,
  };
}

function validateRequestMetadata(request: CoordinatorToolRequest): void {
  assertNonEmpty(request.requestIdempotencyKey);
  if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) {
    throw new AutoIterationRejection("invalid-request", null);
  }
  assertNonEmpty(request.observedTenure.roleSlotId);
  if (!Number.isSafeInteger(request.observedTenure.generation) || request.observedTenure.generation < 1) {
    throw new AutoIterationRejection("invalid-request", null);
  }
}

function validateWorkOrderSubmission(request: SubmitWorkOrderRequest): void {
  assertBoundedText(request.workOrder.objective, 1_000);
  assertNonEmpty(request.workOrder.baselineCommitSha);
  assertNonEmpty(request.workOrder.responsibleRoleSlotId);
  if (
    !Array.isArray(request.workOrder.acceptanceCriteria) ||
    request.workOrder.acceptanceCriteria.length === 0 ||
    request.workOrder.acceptanceCriteria.some((criterion) => {
      try {
        assertBoundedText(criterion, 1_000);
        return false;
      } catch {
        return true;
      }
    }) ||
    !Array.isArray(request.workOrder.territory.writePaths) ||
    !Array.isArray(request.workOrder.territory.readOnlyPaths)
  ) {
    throw new AutoIterationRejection("invalid-request", null);
  }
  for (const path of [
    ...request.workOrder.territory.writePaths,
    ...request.workOrder.territory.readOnlyPaths,
  ]) {
    assertBoundedText(path, 4_096);
  }
  validateSessionParameters(request.workOrder.workerSession);
  if (
    request.workOrder.review !== undefined &&
    request.workOrder.review !== "none"
  ) {
    validateSessionParameters(request.workOrder.review);
  }
}

function validateSessionParameters(
  session: SubmitWorkOrderRequest["workOrder"]["workerSession"],
): void {
  assertNonEmpty(session.endpointId);
  assertNonEmpty(session.profile.model);
  assertNonEmpty(session.profile.effortLevel);
  assertNonEmpty(session.profile.executionMode);
  assertNonEmpty(session.profile.accessMode);
}

function validateHandoffSubmission(request: SubmitHandoffRequest): void {
  validateHandoffKey(request.handoff.idempotencyKey);
  assertBoundedText(request.handoff.body, HANDOFF_BODY_MAX_CODE_POINTS);
  if (
    !Array.isArray(request.handoff.artifactIds) ||
    new Set(request.handoff.artifactIds).size !== request.handoff.artifactIds.length
  ) {
    throw new AutoIterationRejection("invalid-request", null);
  }
  for (const artifactId of request.handoff.artifactIds) assertNonEmpty(artifactId);
}

function validateReviewSubmission(request: SubmitReviewDecisionRequest): void {
  validateHandoffKey(request.decision.handoff);
  assertBoundedText(request.decision.reason, 4_000);
  if (!Number.isSafeInteger(request.decision.handoffVersion) || request.decision.handoffVersion < 1) {
    throw new AutoIterationRejection("invalid-request", null);
  }
  if (request.decision.decision === "transfer") {
    assertNonEmpty(request.decision.targetRoleSlotId);
  }
}

function validateReviewSubmissionPayload(request: SubmitReviewRequest): void {
  validateHandoffKey(request.review.handoff);
  if (request.review.verdict !== "agree" && request.review.verdict !== "disagree") {
    throw new AutoIterationRejection("invalid-request", null);
  }
  if (!Array.isArray(request.review.problems)) {
    throw new AutoIterationRejection("invalid-request", null);
  }
  for (const problem of request.review.problems) {
    assertBoundedText(problem.code, 200);
    assertBoundedText(problem.message, 4_000);
  }
}

function validateHandoffKey(key: HandoffIdempotencyKey): void {
  assertNonEmpty(key.workOrderId);
  assertNonEmpty(key.attemptId);
  assertNonEmpty(key.handoffId);
}

function validateArtifact(reference: ArtifactReference): void {
  assertNonEmpty(reference.artifactId);
  if (reference.kind === "git-commit") assertNonEmpty(reference.commitSha);
  if (reference.kind === "execution-job") assertNonEmpty(reference.jobId);
  if (reference.kind === "workspace-file") {
    assertNonEmpty(reference.workspaceId);
    assertNonEmpty(reference.relativePath);
  }
}

function assertExpectedVersion(expected: number, current: number): void {
  if (expected !== current) throw new AutoIterationRejection("stale-version", current);
}

function assertBoundedText(value: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > maximum
  ) {
    throw new AutoIterationRejection("invalid-request", null);
  }
}

function assertNonEmpty(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AutoIterationRejection("invalid-request", null);
  }
}

function advance(from: WorkOrderStatus, to: WorkOrderStatus): WorkOrderStatus {
  try {
    return assertWorkOrderTransition(from, to);
  } catch {
    throw new AutoIterationRejection("invalid-request", null);
  }
}

function handoffDedupeKey(key: HandoffIdempotencyKey): string {
  return `${key.workOrderId}\u0000${key.attemptId}\u0000${key.handoffId}`;
}

/** Defensive parse of a stored `SessionConfigurationState`'s `requested` field. */
function extractSessionCreationParameters(
  stored: unknown,
): SessionCreationParameters | undefined {
  if (stored === null || typeof stored !== "object") return undefined;
  const requested = (stored as { readonly requested?: unknown }).requested;
  if (requested === null || typeof requested !== "object") return undefined;
  const { endpointId, profile } = requested as {
    readonly endpointId?: unknown;
    readonly profile?: unknown;
  };
  if (typeof endpointId !== "string" || endpointId.length === 0) return undefined;
  if (profile === null || typeof profile !== "object") return undefined;
  return { endpointId, profile } as SessionCreationParameters;
}

/** A read window at or past its limit; null means explicitly unknown, not full. */
function exhaustedQuotaWindows(
  windows: readonly QuotaObservation["windows"][number][],
): boolean {
  return windows.some((window) => (window.usedFraction ?? 0) >= 1);
}

/** Attempt lifecycles after which the worker slot is free again (issue #8 M1 refill). */
function terminalRuntimeLifecycle(
  lifecycle: ExecutionAttempt["runtimeLifecycle"],
): boolean {
  return (
    lifecycle === "completed" ||
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "interrupted" ||
    lifecycle === "recovery-required"
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => [key, canonicalValue(member)]),
  );
}
