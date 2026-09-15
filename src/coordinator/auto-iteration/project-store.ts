import type { DatabaseSync } from "node:sqlite";

import type {
  ArtifactReference,
  ContextUsageObservation,
  ExecutionAttempt,
  Handoff,
  HandoffIdempotencyKey,
  HandoffReceipt,
  IntegrationCandidate,
  InboxEntry,
  PendingAutoIterationOutboxEntry,
  QuotaObservation,
  ReviewDecision,
  RoleSlot,
  SupervisorTenure,
  WorkOrder,
} from "./contract.ts";

export interface StoredCoordinatorRequest {
  readonly operation: string;
  readonly actorJson: string;
  readonly requestJson: string;
  readonly responseJson: string;
}

export type { PendingAutoIterationOutboxEntry } from "./contract.ts";

export interface StoredHandoff {
  readonly handoff: Handoff;
  readonly artifactIds: readonly string[];
  readonly isCurrentAttempt: boolean;
}

export interface AutoIterationProjectStoreOptions {
  readonly database: DatabaseSync;
  readonly projectId: string;
  readonly transact: <T>(action: () => T) => T;
  readonly notifyCommitted: () => void;
}

type RoleSlotRow = {
  role_slot_id: string;
  project_id: string;
  responsibility: RoleSlot["responsibility"];
  current_tenure_id: string | null;
  version: number;
};

type TenureRow = {
  tenure_id: string;
  role_slot_id: string;
  generation: number;
  session_id: string;
  status: SupervisorTenure["status"];
  version: number;
};

type WorkOrderRow = {
  work_order_id: string;
  objective: string;
  acceptance_criteria_json: string;
  baseline_commit_sha: string;
  territory_json: string;
  responsible_role_slot_id: string;
  issued_by_role_slot_id: string;
  issued_by_generation: number;
  completion_condition_json: string;
  status: WorkOrder["status"];
  current_attempt_id: string;
  version: number;
};

type AttemptRow = {
  attempt_id: string;
  work_order_id: string;
  attempt_number: number;
  session_id: string | null;
  session_configuration_json: string;
  runtime_lifecycle: ExecutionAttempt["runtimeLifecycle"];
  slot_state: ExecutionAttempt["slotState"];
  workspace_id: string | null;
  version: number;
};

type HandoffRow = {
  work_order_id: string;
  attempt_id: string;
  handoff_id: string;
  body: string;
  artifact_ids_json: string;
  artifacts_json: string;
  submitted_by_session_id: string;
  is_current_attempt: number;
  version: number;
};

type InboxRow = {
  inbox_entry_id: string;
  role_slot_id: string;
  state: InboxEntry["state"];
  kind: InboxEntry["kind"];
  payload_json: string;
  version: number;
};

type ReceiptRow = {
  work_order_id: string;
  attempt_id: string;
  handoff_id: string;
  level: HandoffReceipt["level"];
  detail_id: string | null;
  handoff_version: number;
};

type ReviewRow = {
  review_decision_id: string;
  work_order_id: string;
  attempt_id: string;
  handoff_id: string;
  handoff_version: number;
  decided_by_role_slot_id: string;
  decided_by_generation: number;
  decision: ReviewDecision["decision"];
  reason: string;
  target_role_slot_id: string | null;
  version: number;
};

type OutboxRow = {
  outbox_entry_id: string;
  kind: PendingAutoIterationOutboxEntry["kind"];
  payload_json: string;
  state: "pending" | "completed";
  version: number;
};

export class AutoIterationProjectStore {
  readonly projectId: string;
  private readonly database: DatabaseSync;
  private readonly transactOwned: <T>(action: () => T) => T;
  private readonly notifyCommitted: () => void;

  constructor(options: AutoIterationProjectStoreOptions) {
    this.database = options.database;
    this.projectId = options.projectId;
    this.transactOwned = options.transact;
    this.notifyCommitted = options.notifyCommitted;
  }

  transaction<T>(action: () => T): T {
    const result = this.transactOwned(action);
    this.notifyCommitted();
    return result;
  }

  readTransaction<T>(action: () => T): T {
    return this.transactOwned(action);
  }

  roleSlot(roleSlotId: string): RoleSlot | undefined {
    const row = this.database
      .prepare(
        `SELECT role_slot_id, project_id, responsibility, current_tenure_id, version
           FROM auto_iteration_role_slots
          WHERE project_id = ? AND role_slot_id = ?`,
      )
      .get(this.projectId, roleSlotId) as RoleSlotRow | undefined;
    return row === undefined ? undefined : hydrateRoleSlot(row);
  }

  insertRoleSlot(role: RoleSlot): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_role_slots (
           role_slot_id, project_id, responsibility, current_tenure_id, version
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        role.roleSlotId,
        this.projectId,
        role.responsibility,
        role.currentTenureId,
        role.version,
      );
  }

  updateRoleCurrentTenure(role: RoleSlot): void {
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_role_slots
            SET current_tenure_id = ?, version = ?
          WHERE project_id = ? AND role_slot_id = ? AND version = ?`,
      )
      .run(
        role.currentTenureId,
        role.version,
        this.projectId,
        role.roleSlotId,
        role.version - 1,
      );
    if (Number(changed.changes) !== 1) throw new Error("role-version-conflict");
  }

  tenure(tenureId: string): SupervisorTenure | undefined {
    const row = this.database
      .prepare(
        `SELECT tenure_id, role_slot_id, generation, session_id, status, version
           FROM auto_iteration_tenures WHERE tenure_id = ?`,
      )
      .get(tenureId) as TenureRow | undefined;
    return row === undefined ? undefined : hydrateTenure(row);
  }

  tenureByGeneration(roleSlotId: string, generation: number): SupervisorTenure | undefined {
    const row = this.database
      .prepare(
        `SELECT tenure_id, role_slot_id, generation, session_id, status, version
           FROM auto_iteration_tenures
          WHERE role_slot_id = ? AND generation = ?`,
      )
      .get(roleSlotId, generation) as TenureRow | undefined;
    return row === undefined ? undefined : hydrateTenure(row);
  }

  insertTenure(tenure: SupervisorTenure, sessionConfiguration?: unknown): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_tenures (
           tenure_id, role_slot_id, generation, session_id, status,
           session_configuration_json, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenure.tenureId,
        tenure.roleSlotId,
        tenure.generation,
        tenure.sessionId,
        tenure.status,
        sessionConfiguration === undefined ? null : JSON.stringify(sessionConfiguration),
        tenure.version,
      );
  }

  retireTenure(
    tenure: SupervisorTenure,
    status: Extract<SupervisorTenure["status"], "retired" | "successor-preparing"> = "retired",
    sessionConfiguration?: unknown,
  ): SupervisorTenure {
    const retired: SupervisorTenure = {
      ...tenure,
      status,
      version: tenure.version + 1,
    };
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_tenures
            SET status = ?, version = ?,
                session_configuration_json = COALESCE(?, session_configuration_json)
          WHERE tenure_id = ? AND version = ?`,
      )
      .run(
        status,
        retired.version,
        sessionConfiguration === undefined ? null : JSON.stringify(sessionConfiguration),
        tenure.tenureId,
        tenure.version,
      );
    if (Number(changed.changes) !== 1) throw new Error("tenure-version-conflict");
    return retired;
  }

  /** The successor Session parameters recorded when rotation was requested. */
  successorConfiguration(tenureId: string): unknown {
    const row = this.database
      .prepare(
        "SELECT session_configuration_json FROM auto_iteration_tenures WHERE tenure_id = ?",
      )
      .get(tenureId) as { session_configuration_json: string | null } | undefined;
    return row?.session_configuration_json === null || row === undefined
      ? undefined
      : (JSON.parse(row.session_configuration_json) as unknown);
  }

  request(idempotencyKey: string): StoredCoordinatorRequest | undefined {
    return this.database
      .prepare(
        `SELECT operation, actor_json AS actorJson, request_json AS requestJson,
                response_json AS responseJson
           FROM auto_iteration_requests
          WHERE project_id = ? AND request_idempotency_key = ?`,
      )
      .get(this.projectId, idempotencyKey) as StoredCoordinatorRequest | undefined;
  }

  insertRequest(
    idempotencyKey: string,
    operation: string,
    actorJson: string,
    requestJson: string,
    responseJson: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_requests (
           project_id, request_idempotency_key, operation, actor_json,
           request_json, response_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.projectId,
        idempotencyKey,
        operation,
        actorJson,
        requestJson,
        responseJson,
      );
  }

  workOrder(workOrderId: string): WorkOrder | undefined {
    const row = this.database
      .prepare(
        `SELECT work_order_id, objective, acceptance_criteria_json,
                baseline_commit_sha, territory_json, responsible_role_slot_id,
                issued_by_role_slot_id, issued_by_generation,
                completion_condition_json, status, current_attempt_id, version
           FROM auto_iteration_work_orders
          WHERE project_id = ? AND work_order_id = ?`,
      )
      .get(this.projectId, workOrderId) as WorkOrderRow | undefined;
    return row === undefined ? undefined : hydrateWorkOrder(row);
  }

  insertWorkOrder(workOrder: WorkOrder): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_work_orders (
           work_order_id, project_id, objective, acceptance_criteria_json,
           baseline_commit_sha, territory_json, responsible_role_slot_id,
           issued_by_role_slot_id, issued_by_generation,
           completion_condition_json, status, current_attempt_id, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workOrder.workOrderId,
        this.projectId,
        workOrder.objective,
        JSON.stringify(workOrder.acceptanceCriteria),
        workOrder.baselineCommitSha,
        JSON.stringify(workOrder.territory),
        workOrder.responsibleRoleSlotId,
        workOrder.issuedBy.roleSlotId,
        workOrder.issuedBy.generation,
        JSON.stringify(workOrder.completionCondition),
        workOrder.status,
        workOrder.currentAttemptId,
        workOrder.version,
      );
  }

  updateWorkOrder(workOrder: WorkOrder, priorVersion: number): void {
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_work_orders
            SET status = ?, current_attempt_id = ?, version = ?
          WHERE project_id = ? AND work_order_id = ? AND version = ?`,
      )
      .run(
        workOrder.status,
        workOrder.currentAttemptId,
        workOrder.version,
        this.projectId,
        workOrder.workOrderId,
        priorVersion,
      );
    if (Number(changed.changes) !== 1) throw new Error("work-order-version-conflict");
  }

  attempts(workOrderId: string): readonly ExecutionAttempt[] {
    const rows = this.database
      .prepare(
        `SELECT attempt_id, work_order_id, attempt_number, session_id,
                session_configuration_json, runtime_lifecycle, slot_state,
                workspace_id, version
           FROM auto_iteration_attempts
          WHERE work_order_id = ? ORDER BY attempt_number`,
      )
      .all(workOrderId) as unknown as AttemptRow[];
    return rows.map(hydrateAttempt);
  }

  attempt(attemptId: string): ExecutionAttempt | undefined {
    const row = this.database
      .prepare(
        `SELECT attempt_id, work_order_id, attempt_number, session_id,
                session_configuration_json, runtime_lifecycle, slot_state,
                workspace_id, version
           FROM auto_iteration_attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as AttemptRow | undefined;
    return row === undefined ? undefined : hydrateAttempt(row);
  }

  insertAttempt(attempt: ExecutionAttempt): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_attempts (
           attempt_id, work_order_id, attempt_number, session_id,
           session_configuration_json, runtime_lifecycle, slot_state,
           workspace_id, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.attemptId,
        attempt.workOrderId,
        attempt.attemptNumber,
        attempt.sessionId,
        JSON.stringify(attempt.sessionConfiguration),
        attempt.runtimeLifecycle,
        attempt.slotState,
        attempt.workspaceId,
        attempt.version,
      );
  }

  updateAttempt(attempt: ExecutionAttempt, priorVersion: number): void {
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_attempts
            SET session_id = ?, session_configuration_json = ?,
                runtime_lifecycle = ?, slot_state = ?, workspace_id = ?, version = ?
          WHERE attempt_id = ? AND version = ?`,
      )
      .run(
        attempt.sessionId,
        JSON.stringify(attempt.sessionConfiguration),
        attempt.runtimeLifecycle,
        attempt.slotState,
        attempt.workspaceId,
        attempt.version,
        attempt.attemptId,
        priorVersion,
      );
    if (Number(changed.changes) !== 1) throw new Error("attempt-version-conflict");
  }

  artifact(artifactId: string): ArtifactReference | undefined {
    const row = this.database
      .prepare(
        `SELECT reference_json FROM auto_iteration_artifacts
          WHERE project_id = ? AND artifact_id = ?`,
      )
      .get(this.projectId, artifactId) as { reference_json: string } | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.reference_json) as ArtifactReference);
  }

  insertArtifact(reference: ArtifactReference): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_artifacts (artifact_id, project_id, reference_json)
         VALUES (?, ?, ?)`,
      )
      .run(reference.artifactId, this.projectId, JSON.stringify(reference));
  }

  handoff(key: HandoffIdempotencyKey): StoredHandoff | undefined {
    const row = this.database
      .prepare(
        `SELECT work_order_id, attempt_id, handoff_id, body, artifact_ids_json,
                artifacts_json, submitted_by_session_id, is_current_attempt, version
           FROM auto_iteration_handoffs
          WHERE work_order_id = ? AND attempt_id = ? AND handoff_id = ?`,
      )
      .get(key.workOrderId, key.attemptId, key.handoffId) as HandoffRow | undefined;
    return row === undefined ? undefined : hydrateStoredHandoff(row);
  }

  handoffs(workOrderId: string): readonly Handoff[] {
    const rows = this.database
      .prepare(
        `SELECT work_order_id, attempt_id, handoff_id, body, artifact_ids_json,
                artifacts_json, submitted_by_session_id, is_current_attempt, version
           FROM auto_iteration_handoffs
          WHERE work_order_id = ? ORDER BY rowid`,
      )
      .all(workOrderId) as unknown as HandoffRow[];
    return rows.map((row) => hydrateStoredHandoff(row).handoff);
  }

  insertHandoff(
    handoff: Handoff,
    artifactIds: readonly string[],
    isCurrentAttempt: boolean,
  ): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_handoffs (
           work_order_id, attempt_id, handoff_id, body, artifact_ids_json,
           artifacts_json, submitted_by_session_id, is_current_attempt, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.idempotencyKey.workOrderId,
        handoff.idempotencyKey.attemptId,
        handoff.idempotencyKey.handoffId,
        handoff.body,
        JSON.stringify(artifactIds),
        JSON.stringify(handoff.artifacts),
        handoff.submittedBySessionId,
        isCurrentAttempt ? 1 : 0,
        handoff.version,
      );
  }

  inbox(roleSlotId: string, workOrderId?: string): readonly InboxEntry[] {
    const rows = this.database
      .prepare(
        `SELECT inbox_entry_id, role_slot_id, state, kind, payload_json, version
           FROM auto_iteration_inbox
          WHERE role_slot_id = ? ORDER BY rowid`,
      )
      .all(roleSlotId) as unknown as InboxRow[];
    const entries = rows.map(hydrateInboxEntry);
    if (workOrderId === undefined) return entries;
    return entries.filter((entry) => inboxWorkOrderId(entry) === workOrderId);
  }

  insertInbox(entry: InboxEntry): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_inbox (
           inbox_entry_id, role_slot_id, state, kind, payload_json, version
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.inboxEntryId,
        entry.roleSlotId,
        entry.state,
        entry.kind,
        JSON.stringify(inboxPayload(entry)),
        entry.version,
      );
  }

  handoffInbox(key: HandoffIdempotencyKey): InboxEntry | undefined {
    const row = this.database
      .prepare(
        `SELECT inbox_entry_id, role_slot_id, state, kind, payload_json, version
           FROM auto_iteration_inbox
          WHERE kind = 'handoff'
            AND json_extract(payload_json, '$.workOrderId') = ?
            AND json_extract(payload_json, '$.attemptId') = ?
            AND json_extract(payload_json, '$.handoffId') = ?
          LIMIT 1`,
      )
      .get(key.workOrderId, key.attemptId, key.handoffId) as InboxRow | undefined;
    return row === undefined ? undefined : hydrateInboxEntry(row);
  }

  updateInboxState(entry: InboxEntry, state: InboxEntry["state"]): InboxEntry {
    const updated = { ...entry, state, version: entry.version + 1 } as InboxEntry;
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_inbox SET state = ?, version = ?
          WHERE inbox_entry_id = ? AND version = ?`,
      )
      .run(state, updated.version, entry.inboxEntryId, entry.version);
    if (Number(changed.changes) !== 1) throw new Error("inbox-version-conflict");
    return updated;
  }

  receipts(workOrderId: string): readonly HandoffReceipt[] {
    const rows = this.database
      .prepare(
        `SELECT work_order_id, attempt_id, handoff_id, level, detail_id,
                handoff_version
           FROM auto_iteration_receipts
          WHERE work_order_id = ?
          ORDER BY CASE level
            WHEN 'persisted' THEN 1
            WHEN 'included-in-parent-input' THEN 2
            ELSE 3 END, rowid`,
      )
      .all(workOrderId) as unknown as ReceiptRow[];
    return rows.map(hydrateReceipt);
  }

  receipt(key: HandoffIdempotencyKey, level: HandoffReceipt["level"]): HandoffReceipt | undefined {
    const row = this.database
      .prepare(
        `SELECT work_order_id, attempt_id, handoff_id, level, detail_id,
                handoff_version
           FROM auto_iteration_receipts
          WHERE work_order_id = ? AND attempt_id = ? AND handoff_id = ? AND level = ?`,
      )
      .get(key.workOrderId, key.attemptId, key.handoffId, level) as ReceiptRow | undefined;
    return row === undefined ? undefined : hydrateReceipt(row);
  }

  insertReceipt(receipt: HandoffReceipt): void {
    const detailId =
      receipt.level === "persisted"
        ? null
        : receipt.level === "included-in-parent-input"
          ? receipt.parentCommandId
          : receipt.reviewDecisionId;
    this.database
      .prepare(
        `INSERT INTO auto_iteration_receipts (
           work_order_id, attempt_id, handoff_id, level, detail_id, handoff_version
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.handoff.workOrderId,
        receipt.handoff.attemptId,
        receipt.handoff.handoffId,
        receipt.level,
        detailId,
        receipt.handoffVersion,
      );
  }

  reviews(workOrderId: string): readonly ReviewDecision[] {
    const rows = this.database
      .prepare(
        `SELECT review_decision_id, work_order_id, attempt_id, handoff_id,
                handoff_version, decided_by_role_slot_id, decided_by_generation,
                decision, reason, target_role_slot_id, version
           FROM auto_iteration_review_decisions
          WHERE work_order_id = ? ORDER BY rowid`,
      )
      .all(workOrderId) as unknown as ReviewRow[];
    return rows.map(hydrateReview);
  }

  review(reviewDecisionId: string): ReviewDecision | undefined {
    const row = this.database
      .prepare(
        `SELECT review_decision_id, work_order_id, attempt_id, handoff_id,
                handoff_version, decided_by_role_slot_id, decided_by_generation,
                decision, reason, target_role_slot_id, version
           FROM auto_iteration_review_decisions
          WHERE review_decision_id = ?`,
      )
      .get(reviewDecisionId) as ReviewRow | undefined;
    return row === undefined ? undefined : hydrateReview(row);
  }

  insertReview(decision: ReviewDecision): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_review_decisions (
           review_decision_id, work_order_id, attempt_id, handoff_id,
           handoff_version, decided_by_role_slot_id, decided_by_generation,
           decision, reason, target_role_slot_id, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.reviewDecisionId,
        decision.handoff.workOrderId,
        decision.handoff.attemptId,
        decision.handoff.handoffId,
        decision.handoffVersion,
        decision.decidedBy.roleSlotId,
        decision.decidedBy.generation,
        decision.decision,
        decision.reason,
        decision.decision === "transfer" ? decision.targetRoleSlotId : null,
        decision.version,
      );
  }

  insertOutbox(
    outboxEntryId: string,
    kind: PendingAutoIterationOutboxEntry["kind"],
    dedupeKey: string,
    payload: unknown,
  ): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_outbox (
           outbox_entry_id, project_id, kind, dedupe_key, payload_json, state, version
         ) VALUES (?, ?, ?, ?, ?, 'pending', 1)`,
      )
      .run(outboxEntryId, this.projectId, kind, dedupeKey, JSON.stringify(payload));
  }

  completeOutbox(kind: PendingAutoIterationOutboxEntry["kind"], dedupeKey: string): void {
    this.database
      .prepare(
        `UPDATE auto_iteration_outbox SET state = 'completed', version = version + 1
          WHERE project_id = ? AND kind = ? AND dedupe_key = ? AND state = 'pending'`,
      )
      .run(this.projectId, kind, dedupeKey);
  }

  completeReviewDisposition(
    reviewDecisionId: string,
    candidate?: IntegrationCandidate,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT outbox_entry_id, kind, payload_json, state, version
           FROM auto_iteration_outbox
          WHERE project_id = ? AND kind = 'review-disposed' AND dedupe_key = ?`,
      )
      .get(this.projectId, reviewDecisionId) as OutboxRow | undefined;
    if (row === undefined) throw new Error("review-disposed-outbox-not-found");
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const existingCandidate = payload.candidate as IntegrationCandidate | undefined;
    if (row.state === "completed") {
      if (JSON.stringify(existingCandidate) !== JSON.stringify(candidate)) {
        throw new Error("review-disposed-outbox-conflict");
      }
      return false;
    }
    const nextPayload =
      candidate === undefined
        ? payload
        : { ...payload, candidate: structuredClone(candidate) };
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_outbox
            SET payload_json = ?, state = 'completed', version = version + 1
          WHERE outbox_entry_id = ? AND state = 'pending' AND version = ?`,
      )
      .run(JSON.stringify(nextPayload), row.outbox_entry_id, row.version);
    if (Number(changed.changes) !== 1) {
      throw new Error("review-disposed-outbox-version-conflict");
    }
    return true;
  }

  candidates(workOrderId: string): readonly IntegrationCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT outbox_entry_id, kind, payload_json, state, version
           FROM auto_iteration_outbox
          WHERE project_id = ? AND kind = 'review-disposed' AND state = 'completed'
          ORDER BY rowid`,
      )
      .all(this.projectId) as unknown as OutboxRow[];
    const candidates: IntegrationCandidate[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as {
        readonly candidate?: IntegrationCandidate;
        readonly integrationOutcome?: IntegrationCandidate["outcome"];
      };
      if (
        payload.candidate !== undefined &&
        payload.candidate.handoffs.some(
          (handoff) => handoff.workOrderId === workOrderId,
        )
      ) {
        candidates.push(
          payload.integrationOutcome === undefined
            ? structuredClone(payload.candidate)
            : {
                ...structuredClone(payload.candidate),
                outcome: structuredClone(payload.integrationOutcome),
              },
        );
      }
    }
    return candidates;
  }

  /**
   * Writes the terminal integration outcome next to its frozen candidate in
   * the completed review-disposed payload. Idempotent for the same outcome;
   * refuses to overwrite a different recorded outcome. No schema change: the
   * v7 outbox payload carries it.
   */
  completeIntegration(
    integrationCandidateId: string,
    outcome: IntegrationCandidate["outcome"],
  ): { applied: boolean; workOrderId: string; reviewDecisionId: string } {
    const row = this.database
      .prepare(
        `SELECT outbox_entry_id, dedupe_key, payload_json, state, version
           FROM auto_iteration_outbox
          WHERE project_id = ? AND kind = 'review-disposed'
            AND json_extract(payload_json, '$.candidate.integrationCandidateId') = ?`,
      )
      .get(this.projectId, integrationCandidateId) as
      | (OutboxRow & { dedupe_key: string })
      | undefined;
    if (row === undefined || row.state !== "completed") {
      throw new Error("integration-candidate-outbox-not-found");
    }
    const payload = JSON.parse(row.payload_json) as {
      readonly candidate?: IntegrationCandidate;
      readonly integrationOutcome?: IntegrationCandidate["outcome"];
    };
    if (payload.candidate === undefined || payload.candidate.handoffs.length === 0) {
      throw new Error("integration-candidate-outbox-not-found");
    }
    if (payload.integrationOutcome !== undefined) {
      if (
        JSON.stringify(payload.integrationOutcome) !== JSON.stringify(outcome)
      ) {
        throw new Error("integration-outcome-conflict");
      }
      return {
        applied: false,
        workOrderId: payload.candidate.handoffs[0]!.workOrderId,
        reviewDecisionId: row.dedupe_key,
      };
    }
    const changed = this.database
      .prepare(
        `UPDATE auto_iteration_outbox
            SET payload_json = ?, version = version + 1
          WHERE outbox_entry_id = ? AND version = ?`,
      )
      .run(
        JSON.stringify({ ...payload, integrationOutcome: structuredClone(outcome) }),
        row.outbox_entry_id,
        row.version,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error("integration-outcome-version-conflict");
    }
    return {
      applied: true,
      workOrderId: payload.candidate.handoffs[0]!.workOrderId,
      reviewDecisionId: row.dedupe_key,
    };
  }

  /** Frozen candidates that still owe an integration outcome, in rowid order. */
  integrationBacklog(): readonly {
    readonly candidate: IntegrationCandidate;
    readonly reviewDecisionId: string;
  }[] {
    const rows = this.database
      .prepare(
        `SELECT outbox_entry_id, dedupe_key, payload_json, state, version
           FROM auto_iteration_outbox
          WHERE project_id = ? AND kind = 'review-disposed' AND state = 'completed'
            AND json_extract(payload_json, '$.integrationOutcome') IS NULL
          ORDER BY rowid`,
      )
      .all(this.projectId) as unknown as (OutboxRow & { dedupe_key: string })[];
    const backlog: {
      readonly candidate: IntegrationCandidate;
      readonly reviewDecisionId: string;
    }[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as {
        readonly candidate?: IntegrationCandidate;
      };
      if (payload.candidate === undefined || payload.candidate.handoffs.length === 0) {
        continue;
      }
      const workOrder = this.workOrder(payload.candidate.handoffs[0]!.workOrderId);
      if (workOrder === undefined || workOrder.status !== "awaiting-integration") {
        continue;
      }
      backlog.push({
        candidate: structuredClone(payload.candidate),
        reviewDecisionId: row.dedupe_key,
      });
    }
    return backlog;
  }

  pendingOutbox(): readonly PendingAutoIterationOutboxEntry[] {
    const rows = this.database
      .prepare(
        `SELECT outbox_entry_id, kind, payload_json, state, version
           FROM auto_iteration_outbox
          WHERE project_id = ? AND state = 'pending' ORDER BY rowid`,
      )
      .all(this.projectId) as unknown as OutboxRow[];
    return rows.map((row) => ({
      outboxEntryId: row.outbox_entry_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
      version: Number(row.version),
    }));
  }

  workOrders(): readonly WorkOrder[] {
    const rows = this.database
      .prepare(
        `SELECT work_order_id, objective, acceptance_criteria_json,
                baseline_commit_sha, territory_json, responsible_role_slot_id,
                issued_by_role_slot_id, issued_by_generation,
                completion_condition_json, status, current_attempt_id, version
           FROM auto_iteration_work_orders
          WHERE project_id = ? ORDER BY rowid`,
      )
      .all(this.projectId) as unknown as WorkOrderRow[];
    return rows.map(hydrateWorkOrder);
  }

  roleSlots(): readonly RoleSlot[] {
    const rows = this.database
      .prepare(
        `SELECT role_slot_id, project_id, responsibility, current_tenure_id, version
           FROM auto_iteration_role_slots
          WHERE project_id = ? ORDER BY rowid`,
      )
      .all(this.projectId) as unknown as RoleSlotRow[];
    return rows.map(hydrateRoleSlot);
  }

  pendingInboxEntryCount(): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS entries FROM auto_iteration_inbox
          WHERE role_slot_id IN (
            SELECT role_slot_id FROM auto_iteration_role_slots WHERE project_id = ?
          ) AND state = 'pending'`,
      )
      .get(this.projectId) as { entries: number };
    return Number(row.entries);
  }

  /** Latest per pool; sensor history beyond the newest read is not business state. */
  recordQuotaObservation(observation: QuotaObservation): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_quota_observations (
           quota_pool_id, source, observed_at, status, windows_json
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(quota_pool_id) DO UPDATE SET
           source = excluded.source,
           observed_at = excluded.observed_at,
           status = excluded.status,
           windows_json = excluded.windows_json`,
      )
      .run(
        observation.quotaPoolId,
        observation.source,
        observation.observedAt,
        observation.status,
        JSON.stringify(observation.windows),
      );
  }

  /** The newest read per quota pool; submissions consult it before claiming a worker. */
  latestQuotaObservations(): readonly QuotaObservation[] {
    const rows = this.database
      .prepare(
        `SELECT quota_pool_id, source, observed_at, status, windows_json
           FROM auto_iteration_quota_observations`,
      )
      .all() as unknown as {
        quota_pool_id: string;
        source: QuotaObservation["source"];
        observed_at: number;
        status: QuotaObservation["status"];
        windows_json: string;
      }[];
    return rows.map((row) => ({
      quotaPoolId: row.quota_pool_id,
      source: row.source,
      observedAt: Number(row.observed_at),
      status: row.status,
      windows: JSON.parse(row.windows_json) as QuotaObservation["windows"],
    }));
  }

  /** Latest per observed Session identity. */
  recordContextObservation(observation: ContextUsageObservation): void {
    this.database
      .prepare(
        `INSERT INTO auto_iteration_context_observations (
           session_id, observed_at, model, quality, total_tokens, max_tokens
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           observed_at = excluded.observed_at,
           model = excluded.model,
           quality = excluded.quality,
           total_tokens = excluded.total_tokens,
           max_tokens = excluded.max_tokens`,
      )
      .run(
        observation.sessionId,
        observation.observedAt,
        observation.model,
        observation.quality,
        observation.totalTokens,
        observation.maxTokens,
      );
  }

  latestObservationTime(): number | null {
    const row = this.database
      .prepare(
        `SELECT MAX(t) AS latest FROM (
           SELECT MAX(observed_at) AS t FROM auto_iteration_quota_observations
           UNION ALL
           SELECT MAX(observed_at) AS t FROM auto_iteration_context_observations
         )`,
      )
      .get() as { latest: number | null };
    return row.latest === null ? null : Number(row.latest);
  }

  appendEvent(eventKind: string, entityId: string, data?: unknown, sessionId?: string): void {
    this.database
      .prepare(
        `INSERT INTO updates (
           project_id, command_id, kind, status, session_id, data_json
         ) VALUES (?, NULL, 'auto-iteration', 'auto-iteration', ?, ?)`,
      )
      .run(
        this.projectId,
        sessionId ?? null,
        JSON.stringify({ eventKind, entityId, ...(data === undefined ? {} : { data }) }),
      );
  }
}

function hydrateRoleSlot(row: RoleSlotRow): RoleSlot {
  return {
    roleSlotId: row.role_slot_id,
    projectId: row.project_id,
    responsibility: row.responsibility,
    currentTenureId: row.current_tenure_id,
    version: Number(row.version),
  };
}

function hydrateTenure(row: TenureRow): SupervisorTenure {
  return {
    tenureId: row.tenure_id,
    roleSlotId: row.role_slot_id,
    generation: Number(row.generation),
    sessionId: row.session_id,
    status: row.status,
    version: Number(row.version),
  };
}

function hydrateWorkOrder(row: WorkOrderRow): WorkOrder {
  return {
    workOrderId: row.work_order_id,
    objective: row.objective,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as readonly string[],
    baselineCommitSha: row.baseline_commit_sha,
    territory: JSON.parse(row.territory_json) as WorkOrder["territory"],
    responsibleRoleSlotId: row.responsible_role_slot_id,
    issuedBy: {
      roleSlotId: row.issued_by_role_slot_id,
      generation: Number(row.issued_by_generation),
    },
    completionCondition: JSON.parse(
      row.completion_condition_json,
    ) as WorkOrder["completionCondition"],
    status: row.status,
    currentAttemptId: row.current_attempt_id,
    version: Number(row.version),
  };
}

function hydrateAttempt(row: AttemptRow): ExecutionAttempt {
  return {
    attemptId: row.attempt_id,
    workOrderId: row.work_order_id,
    attemptNumber: Number(row.attempt_number),
    sessionId: row.session_id,
    sessionConfiguration: JSON.parse(
      row.session_configuration_json,
    ) as ExecutionAttempt["sessionConfiguration"],
    runtimeLifecycle: row.runtime_lifecycle,
    slotState: row.slot_state,
    workspaceId: row.workspace_id,
    version: Number(row.version),
  };
}

function hydrateStoredHandoff(row: HandoffRow): StoredHandoff {
  return {
    handoff: {
      idempotencyKey: {
        workOrderId: row.work_order_id,
        attemptId: row.attempt_id,
        handoffId: row.handoff_id,
      },
      body: row.body,
      artifacts: JSON.parse(row.artifacts_json) as readonly ArtifactReference[],
      submittedBySessionId: row.submitted_by_session_id,
      version: Number(row.version),
    },
    artifactIds: JSON.parse(row.artifact_ids_json) as readonly string[],
    isCurrentAttempt: Number(row.is_current_attempt) === 1,
  };
}

function inboxPayload(entry: InboxEntry): unknown {
  if (entry.kind === "handoff") return entry.handoff;
  if (entry.kind === "rotation") return { tenureId: entry.tenureId };
  return { workOrderId: entry.workOrderId, summary: entry.summary };
}

function hydrateInboxEntry(row: InboxRow): InboxEntry {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const base = {
    inboxEntryId: row.inbox_entry_id,
    roleSlotId: row.role_slot_id,
    state: row.state,
    version: Number(row.version),
  };
  if (row.kind === "handoff") {
    return { ...base, kind: "handoff", handoff: payload as unknown as HandoffIdempotencyKey };
  }
  if (row.kind === "rotation") {
    return { ...base, kind: "rotation", tenureId: String(payload.tenureId) };
  }
  return {
    ...base,
    kind: row.kind,
    workOrderId:
      typeof payload.workOrderId === "string" ? payload.workOrderId : null,
    summary: String(payload.summary ?? ""),
  };
}

function inboxWorkOrderId(entry: InboxEntry): string | null {
  if (entry.kind === "handoff") return entry.handoff.workOrderId;
  if (entry.kind === "rotation") return null;
  return entry.workOrderId;
}

function hydrateReceipt(row: ReceiptRow): HandoffReceipt {
  const base = {
    handoff: {
      workOrderId: row.work_order_id,
      attemptId: row.attempt_id,
      handoffId: row.handoff_id,
    },
    handoffVersion: Number(row.handoff_version),
  };
  if (row.level === "persisted") return { ...base, level: "persisted" };
  if (row.level === "included-in-parent-input") {
    return { ...base, level: "included-in-parent-input", parentCommandId: row.detail_id ?? "" };
  }
  return { ...base, level: "disposed", reviewDecisionId: row.detail_id ?? "" };
}

function hydrateReview(row: ReviewRow): ReviewDecision {
  const base = {
    reviewDecisionId: row.review_decision_id,
    handoff: {
      workOrderId: row.work_order_id,
      attemptId: row.attempt_id,
      handoffId: row.handoff_id,
    },
    handoffVersion: Number(row.handoff_version),
    decidedBy: {
      roleSlotId: row.decided_by_role_slot_id,
      generation: Number(row.decided_by_generation),
    },
    reason: row.reason,
    version: Number(row.version),
  };
  return row.decision === "transfer"
    ? { ...base, decision: "transfer", targetRoleSlotId: row.target_role_slot_id ?? "" }
    : { ...base, decision: row.decision };
}
