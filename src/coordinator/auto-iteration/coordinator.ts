import { randomUUID } from "node:crypto";

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
  PendingAutoIterationOutboxEntry,
  QuotaObservation,
  ReadInboxRequest,
  ReadWorkOrderStatusRequest,
  ReviewDecision,
  ReviewDecisionSubmittedResponse,
  SubmitHandoffRequest,
  SubmitReviewDecisionRequest,
  SubmitWorkOrderRequest,
  SupervisorRotationCompletion,
  SupervisorRotationRequestedResponse,
  SupervisorTenure,
  SupervisorToolRequest,
  SupervisorToolResponse,
  WorkerToolRequest,
  WorkerToolResponse,
  WorkOrder,
  WorkOrderStatus,
  WorkOrderStatusResponse,
  WorkOrderSubmittedResponse,
} from "./contract.ts";
import { AutoIterationProjectStore } from "./project-store.ts";
import { assertWorkOrderTransition } from "./state-machine.ts";

/** Matches the existing renderer direct-input bound and is measured in code points. */
export const HANDOFF_BODY_MAX_CODE_POINTS = 8_000;

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

  constructor(
    store: AutoIterationProjectStore,
    createId: () => string = randomUUID,
  ) {
    this.store = store;
    this.createId = createId;
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
      this.store.insertTenure({
        tenureId,
        roleSlotId: binding.roleSlotId,
        generation: binding.generation,
        sessionId: binding.sessionId,
        status: "active",
        version: 1,
      });
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

  readAutoIterationOverview(): AutoIterationOverview {
    return this.store.readTransaction(() => {
      const supervisorRole = this.store
        .roleSlots()
        .find((role) => role.responsibility === "supervisor");
      const supervisorTenure =
        supervisorRole === undefined || supervisorRole.currentTenureId === null
          ? undefined
          : this.store.tenure(supervisorRole.currentTenureId);
      const workOrders = this.store.workOrders().map((workOrder) => {
        const attempts = this.store.attempts(workOrder.workOrderId);
        const current =
          attempts.find((attempt) => attempt.attemptId === workOrder.currentAttemptId) ??
          attempts.at(-1);
        const delivered = this.store.handoffs(workOrder.workOrderId).length > 0;
        const reviewDecided = this.store.reviews(workOrder.workOrderId).length > 0;
        return {
          workOrderId: workOrder.workOrderId,
          status: workOrder.status,
          currentAttemptId: workOrder.currentAttemptId,
          attemptCount: attempts.length,
          workerSessionBound: current?.sessionId !== null && current !== undefined,
          workerSessionId: current?.sessionId ?? null,
          workerRuntimeLifecycle:
            current?.runtimeLifecycle ?? "accepted",
          delivered,
          reviewDecided,
          integrated: workOrder.status === "integrated",
          waitingFor: workOrderWaitingFor(workOrder.status, current),
        } satisfies AutoIterationWorkOrderOverview;
      });
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
        workOrders,
        pendingInboxEntries: this.store.pendingInboxEntryCount(),
        quotaWaiting: workOrders.some(
          (order) => order.status === "waiting-for-quota",
        ),
        lastObservedAt: this.store.latestObservationTime(),
      };
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
    });
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

  request(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SupervisorToolRequest,
  ): Promise<SupervisorToolResponse>;
  request(
    actor: Extract<HostBoundToolActor, { readonly kind: "worker" }>,
    request: WorkerToolRequest,
  ): Promise<WorkerToolResponse>;
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
    request: Exclude<CoordinatorToolRequest, ReadWorkOrderStatusRequest | ReadInboxRequest>,
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
    const workOrderId = `work-order-${this.createId()}`;
    const attemptId = `attempt-${this.createId()}`;
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
      status: "executing",
      currentAttemptId: attemptId,
      version: 1,
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
      { attemptId, workerSession: request.workOrder.workerSession },
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

    const isCurrentAttempt = workOrder.currentAttemptId === request.decision.handoff.attemptId;
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
        this.store.insertOutbox(
          `outbox-${this.createId()}`,
          "start-attempt",
          nextAttempt.attemptId,
          { attemptId: nextAttempt.attemptId, sessionConfiguration: nextAttempt.sessionConfiguration },
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
      { decision: decision.reviewDecisionId, handoff: request.decision.handoff },
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
    } else if (actor.workOrderId !== workOrder.workOrderId) {
      throw new AutoIterationRejection("forbidden", workOrder.version);
    }
    assertExpectedVersion(request.expectedVersion, workOrder.version);
    return {
      kind: "work-order-status",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: workOrder.version,
      workOrder,
      attempts: this.store.attempts(workOrder.workOrderId),
      handoffs: this.store.handoffs(workOrder.workOrderId),
      reviews: this.store.reviews(workOrder.workOrderId),
      candidates: [],
      receipts: this.store.receipts(workOrder.workOrderId),
    };
  }

  private readInbox(actor: HostBoundToolActor, request: ReadInboxRequest): InboxReadResponse {
    const role = this.store.roleSlot(request.roleSlotId);
    if (role === undefined) throw new AutoIterationRejection("not-found", null);
    let workOrderId: string | undefined;
    if (actor.kind === "supervisor") {
      this.assertCurrentSupervisor(actor);
    } else {
      const workOrder = this.store.workOrder(actor.workOrderId);
      if (
        workOrder === undefined ||
        actor.attemptId !== workOrder.currentAttemptId ||
        request.roleSlotId !== workOrder.responsibleRoleSlotId
      ) {
        throw new AutoIterationRejection("forbidden", role.version);
      }
      workOrderId = actor.workOrderId;
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

function workOrderWaitingFor(
  status: WorkOrderStatus,
  currentAttempt: ExecutionAttempt | undefined,
): AutoIterationWorkOrderOverview["waitingFor"] {
  if (status === "awaiting-review") return "supervisor-review";
  if (status === "awaiting-integration") return "integration";
  if (status === "waiting-for-quota") return "quota";
  if (status === "executing" || status === "delivered") {
    if (currentAttempt === undefined) return "worker-start";
    if (currentAttempt.sessionId === null) return "worker-start";
    const terminal =
      currentAttempt.runtimeLifecycle === "completed" ||
      currentAttempt.runtimeLifecycle === "failed" ||
      currentAttempt.runtimeLifecycle === "cancelled" ||
      currentAttempt.runtimeLifecycle === "interrupted" ||
      currentAttempt.runtimeLifecycle === "recovery-required";
    return terminal ? null : "worker-execution";
  }
  return null;
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
