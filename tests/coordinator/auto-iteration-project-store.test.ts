import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchCoordinator,
  HANDOFF_BODY_MAX_CODE_POINTS,
  type AutoIterationProjectAuthority,
  type ProjectChannel,
} from "../../src/coordinator/index.ts";
import type {
  HostBoundToolActor,
  SubmitHandoffRequest,
  SubmitReviewDecisionRequest,
  SubmitWorkOrderRequest,
} from "../../src/coordinator/auto-iteration/contract.ts";

const supervisor = {
  kind: "supervisor",
  sessionId: "supervisor-session-1",
  tenure: { roleSlotId: "project-supervisor", generation: 1 },
} as const satisfies HostBoundToolActor;

const profile = {
  model: "gpt-5.6-sol",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
} as const;

test("Handoff commits report, pending inbox/outbox, business status, and persisted receipt atomically", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-1");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  assert.equal(submitted.attempt.sessionId, null);

  await fixture.authority.bindAttemptSession({
    attemptId: submitted.attempt.attemptId,
    sessionId: "worker-session-1",
  });
  await fixture.authority.updateAttemptRuntime({
    attemptId: submitted.attempt.attemptId,
    runtimeLifecycle: "running",
    slotState: "owned",
  });
  const worker = workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId);
  const request = handoffRequest(submitted, "handoff-request-1", "handoff-1");
  const response = await fixture.authority.request(worker, request);
  assert.equal(response.kind, "handoff-submitted");
  if (response.kind !== "handoff-submitted") return;
  assert.equal(response.receipt.level, "persisted");

  const status = await fixture.authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "read-after-handoff",
    expectedVersion: response.currentVersion,
    observedTenure: supervisor.tenure,
    workOrderId: submitted.workOrder.workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind !== "work-order-status") return;
  assert.equal(status.workOrder.status, "awaiting-review");
  assert.equal(status.attempts[0]?.runtimeLifecycle, "running");
  assert.equal(status.attempts[0]?.slotState, "owned", "Handoff does not release the Runtime slot");
  assert.equal(status.handoffs[0]?.body, request.handoff.body);
  assert.deepEqual(status.receipts, [response.receipt]);

  const inbox = await fixture.authority.request(supervisor, {
    kind: "read-inbox",
    requestIdempotencyKey: "read-inbox-after-handoff",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    roleSlotId: supervisor.tenure.roleSlotId,
  });
  assert.equal(inbox.kind, "inbox-read");
  if (inbox.kind === "inbox-read") {
    assert.equal(inbox.entries.length, 1);
    assert.equal(inbox.entries[0]?.state, "pending");
  }

  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  assert.equal(count(database, "auto_iteration_handoffs"), 1);
  assert.equal(count(database, "auto_iteration_inbox"), 1);
  assert.equal(count(database, "auto_iteration_outbox"), 2, "start attempt plus Handoff wakeup");
  assert.equal(
    Number(
      (database
        .prepare("SELECT COUNT(*) AS count FROM updates WHERE kind = 'auto-iteration'")
        .get() as { count: number }).count,
    ),
    5,
    "supervisor bind, submit, session bind, Runtime state, and Handoff share the Project update stream",
  );
  database.close();
});

test("a failure before Handoff commit rolls back and retry creates one report", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-crash");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({
    attemptId: submitted.attempt.attemptId,
    sessionId: "worker-session-crash",
  });
  const worker = workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId, "worker-session-crash");
  const request = handoffRequest(submitted, "handoff-request-crash", "handoff-crash");

  const writer = new DatabaseSync(fixture.databasePath);
  writer.exec(`
    CREATE TRIGGER fail_handoff_before_insert
    BEFORE INSERT ON auto_iteration_handoffs
    BEGIN SELECT RAISE(ABORT, 'injected handoff crash'); END;
  `);
  const failed = await fixture.authority.request(worker, request);
  assert.equal(failed.kind, "rejected");
  if (failed.kind === "rejected") assert.equal(failed.category, "storage-unavailable");
  assert.equal(count(writer, "auto_iteration_handoffs"), 0);
  assert.equal(count(writer, "auto_iteration_inbox"), 0);
  writer.exec("DROP TRIGGER fail_handoff_before_insert");
  writer.close();

  const retried = await fixture.authority.request(worker, request);
  assert.equal(retried.kind, "handoff-submitted");
  const reader = new DatabaseSync(fixture.databasePath, { readOnly: true });
  assert.equal(count(reader, "auto_iteration_handoffs"), 1);
  assert.equal(count(reader, "auto_iteration_inbox"), 1);
  reader.close();
});

test("a committed Handoff is recovered from the persistent outbox after reopen", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-reopen");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({
    attemptId: submitted.attempt.attemptId,
    sessionId: "worker-reopen",
  });
  const delivered = await fixture.authority.request(
    workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId, "worker-reopen"),
    handoffRequest(submitted, "handoff-request-reopen", "handoff-reopen"),
  );
  assert.equal(delivered.kind, "handoff-submitted");
  if (delivered.kind !== "handoff-submitted") return;
  await fixture.channel.close();

  const reopenedChannel = await createWorkbenchCoordinator({
    databasePath: fixture.databasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(fixture.projectDirectory);
  fixture.trackChannel(reopenedChannel);
  assert.ok(reopenedChannel.autoIteration);
  const pending = await reopenedChannel.autoIteration.readPendingOutbox();
  assert.equal(
    pending.some(
      (entry) =>
        entry.kind === "inbox-wakeup" &&
        JSON.stringify(entry.payload).includes("handoff-reopen"),
    ),
    true,
    "wake recovery does not depend on an in-memory notification",
  );
  const status = await reopenedChannel.autoIteration.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "read-after-reopen",
    expectedVersion: delivered.currentVersion,
    observedTenure: supervisor.tenure,
    workOrderId: submitted.workOrder.workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind === "work-order-status") {
    assert.equal(status.workOrder.status, "awaiting-review");
    assert.equal(status.handoffs.length, 1);
  }
});

test("same Handoff key is idempotent by content and conflicts on changed content", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-idempotency");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({
    attemptId: submitted.attempt.attemptId,
    sessionId: "worker-session-idempotency",
  });
  const worker = workerFor(
    submitted.workOrder.workOrderId,
    submitted.attempt.attemptId,
    "worker-session-idempotency",
  );
  const firstRequest = handoffRequest(submitted, "handoff-request-first", "handoff-idempotent");
  const first = await fixture.authority.request(worker, firstRequest);
  const same = await fixture.authority.request(worker, {
    ...firstRequest,
    requestIdempotencyKey: "handoff-request-same-content",
  });
  assert.equal(same.kind, "handoff-submitted");
  if (same.kind === "handoff-submitted" && first.kind === "handoff-submitted") {
    assert.deepEqual(same.receipt, first.receipt);
    assert.equal(same.currentVersion, first.currentVersion);
  }
  const conflict = await fixture.authority.request(worker, {
    ...firstRequest,
    requestIdempotencyKey: "handoff-request-different-content",
    handoff: { ...firstRequest.handoff, body: "Different persisted report." },
  });
  assert.equal(conflict.kind, "rejected");
  if (conflict.kind === "rejected") assert.equal(conflict.category, "idempotency-conflict");
});

test("a late Handoff is archived without replacing the current rework attempt", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-late");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({ attemptId: submitted.attempt.attemptId, sessionId: "worker-late" });
  const worker = workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId, "worker-late");
  const first = await fixture.authority.request(
    worker,
    handoffRequest(submitted, "handoff-request-before-rework", "handoff-before-rework"),
  );
  assert.equal(first.kind, "handoff-submitted");
  if (first.kind !== "handoff-submitted") return;
  const rework = await fixture.authority.request(
    supervisor,
    reviewRequest(submitted, first.receipt.handoffVersion, first.currentVersion, "review-rework", "rework"),
  );
  assert.equal(rework.kind, "review-decision-submitted");
  if (rework.kind !== "review-decision-submitted") return;

  const late = await fixture.authority.request(worker, {
    ...handoffRequest(submitted, "handoff-request-late", "handoff-late"),
    expectedVersion: rework.currentVersion,
  });
  assert.equal(late.kind, "handoff-submitted");
  if (late.kind !== "handoff-submitted") return;
  const status = await fixture.authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "read-late-status",
    expectedVersion: late.currentVersion,
    observedTenure: supervisor.tenure,
    workOrderId: submitted.workOrder.workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind === "work-order-status") {
    assert.equal(status.workOrder.status, "executing");
    assert.notEqual(status.workOrder.currentAttemptId, submitted.attempt.attemptId);
    assert.equal(status.handoffs.length, 2);
  }
});

test("receipt levels remain distinct and a lost review response replays the original decision", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-receipts", "not-required");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({ attemptId: submitted.attempt.attemptId, sessionId: "worker-receipts" });
  const handoff = await fixture.authority.request(
    workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId, "worker-receipts"),
    handoffRequest(submitted, "handoff-request-receipts", "handoff-receipts"),
  );
  assert.equal(handoff.kind, "handoff-submitted");
  if (handoff.kind !== "handoff-submitted") return;
  const included = await fixture.authority.markHandoffIncluded({
    handoff: handoff.receipt.handoff,
    parentCommandId: "parent-command-1",
  });
  assert.equal(included.level, "included-in-parent-input");

  const request = reviewRequest(
    submitted,
    handoff.receipt.handoffVersion,
    handoff.currentVersion,
    "review-request-lost-receipt",
    "approve",
  );
  const decided = await fixture.authority.request(supervisor, request);
  const retried = await fixture.authority.request(supervisor, request);
  assert.deepEqual(retried, decided);
  assert.equal(decided.kind, "review-decision-submitted");
  if (decided.kind !== "review-decision-submitted") return;
  assert.equal(decided.receipt.level, "disposed");
  const status = await fixture.authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "read-all-receipts",
    expectedVersion: decided.currentVersion,
    observedTenure: supervisor.tenure,
    workOrderId: submitted.workOrder.workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind === "work-order-status") {
    assert.deepEqual(status.receipts.map((receipt) => receipt.level), [
      "persisted",
      "included-in-parent-input",
      "disposed",
    ]);
    assert.equal(status.workOrder.status, "integrated");
  }
});

test("cutover revokes the old generation while reports still reach the stable role inbox", async (t) => {
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-rotation");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({ attemptId: submitted.attempt.attemptId, sessionId: "worker-rotation" });
  const worker = workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId, "worker-rotation");
  const rotation = await fixture.authority.request(supervisor, {
    kind: "request-supervisor-rotation",
    requestIdempotencyKey: "rotation-request-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    roleSlotId: supervisor.tenure.roleSlotId,
    successorSession: { endpointId: "codex-desktop", profile },
  });
  assert.equal(rotation.kind, "supervisor-rotation-requested");
  if (rotation.kind !== "supervisor-rotation-requested") return;
  // The model tool only parks the tenure; the host completes the cutover once
  // a real successor Session exists and acknowledged READY.
  assert.equal(rotation.tenure.status, "successor-preparing");
  assert.equal(rotation.tenure.generation, 1);
  const completed = await fixture.authority.completeSupervisorRotation({
    roleSlotId: supervisor.tenure.roleSlotId,
    successorSessionId: "supervisor-successor-session",
  });
  assert.equal(completed.generation, 2);
  assert.equal(completed.status, "active");
  assert.equal(completed.sessionId, "supervisor-successor-session");

  const report = await fixture.authority.request(worker, {
    ...handoffRequest(submitted, "handoff-after-cutover", "handoff-after-cutover"),
    expectedVersion: submitted.workOrder.version,
  });
  assert.equal(report.kind, "handoff-submitted", "worker delivery survives supervisor rotation");
  if (report.kind !== "handoff-submitted") return;
  const oldDecision = await fixture.authority.request(
    supervisor,
    reviewRequest(submitted, report.receipt.handoffVersion, report.currentVersion, "old-review", "approve"),
  );
  assert.equal(oldDecision.kind, "rejected");
  if (oldDecision.kind === "rejected") assert.equal(oldDecision.category, "stale-generation");

  const successor = {
    kind: "supervisor",
    sessionId: completed.sessionId,
    tenure: { roleSlotId: completed.roleSlotId, generation: completed.generation },
  } as const;
  const inbox = await fixture.authority.request(successor, {
    kind: "read-inbox",
    requestIdempotencyKey: "successor-inbox",
    expectedVersion: 2,
    observedTenure: successor.tenure,
    roleSlotId: successor.tenure.roleSlotId,
  });
  assert.equal(inbox.kind, "inbox-read");
  if (inbox.kind === "inbox-read") {
    assert.equal(inbox.entries.some((entry) => entry.kind === "handoff"), true);
  }
});

test("Handoff body uses the existing direct-input bound and counts Unicode code points", async (t) => {
  assert.equal(HANDOFF_BODY_MAX_CODE_POINTS, 8_000);
  const fixture = await createFixture(t);
  const submitted = await submitOrder(fixture.authority, "submit-order-bound");
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await fixture.authority.bindAttemptSession({ attemptId: submitted.attempt.attemptId, sessionId: "worker-bound" });
  const worker = workerFor(submitted.workOrder.workOrderId, submitted.attempt.attemptId, "worker-bound");
  const overBound = await fixture.authority.request(worker, {
    ...handoffRequest(submitted, "handoff-bound", "handoff-bound"),
    handoff: {
      ...handoffRequest(submitted, "ignored", "handoff-bound").handoff,
      body: "🙂".repeat(HANDOFF_BODY_MAX_CODE_POINTS + 1),
    },
  });
  assert.equal(overBound.kind, "rejected");
  if (overBound.kind === "rejected") assert.equal(overBound.category, "invalid-request");
});

async function createFixture(t: TestContext): Promise<{
  readonly authority: AutoIterationProjectAuthority;
  readonly channel: ProjectChannel;
  readonly databasePath: string;
  readonly projectDirectory: string;
  readonly trackChannel: (channel: ProjectChannel) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "uaw-auto-iteration-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "project.sqlite");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(projectDirectory);
  assert.ok(channel.autoIteration);
  const authority = channel.autoIteration;
  await authority.bindInitialSupervisor({
    roleSlotId: supervisor.tenure.roleSlotId,
    sessionId: supervisor.sessionId,
    generation: supervisor.tenure.generation,
  });
  const channels = [channel];
  t.after(async () => {
    for (const openChannel of channels) await openChannel.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    authority,
    channel,
    databasePath,
    projectDirectory,
    trackChannel(openChannel) {
      channels.push(openChannel);
    },
  };
}

async function submitOrder(
  authority: AutoIterationProjectAuthority,
  requestIdempotencyKey: string,
  gitIntegration: "required" | "not-required" = "required",
) {
  const request: SubmitWorkOrderRequest = {
    kind: "submit-work-order",
    requestIdempotencyKey,
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Implement one bounded product change.",
      acceptanceCriteria: ["The requested behavior is covered."],
      baselineCommitSha: "abc123",
      territory: { writePaths: ["src/feature.ts"], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration },
      workerSession: { endpointId: "codex-desktop", profile },
      // This file's fixtures exercise the project store, not issue #8 M3
      // review gating; opt out so submit-review-decision isn't refused.
      review: "none",
    },
  };
  return authority.request(supervisor, request);
}

function workerFor(workOrderId: string, attemptId: string, sessionId = "worker-session-1") {
  return { kind: "worker", sessionId, workOrderId, attemptId } as const;
}

function handoffRequest(
  submitted: Extract<Awaited<ReturnType<typeof submitOrder>>, { kind: "work-order-submitted" }>,
  requestIdempotencyKey: string,
  handoffId: string,
): SubmitHandoffRequest {
  return {
    kind: "submit-handoff",
    requestIdempotencyKey,
    expectedVersion: submitted.workOrder.version,
    observedTenure: supervisor.tenure,
    handoff: {
      idempotencyKey: {
        workOrderId: submitted.workOrder.workOrderId,
        attemptId: submitted.attempt.attemptId,
        handoffId,
      },
      body: "Implementation and verification are ready for review.",
      artifactIds: [],
    },
  };
}

function reviewRequest(
  submitted: Extract<Awaited<ReturnType<typeof submitOrder>>, { kind: "work-order-submitted" }>,
  handoffVersion: number,
  expectedVersion: number,
  requestIdempotencyKey: string,
  decision: "approve" | "rework" | "blocked",
): SubmitReviewDecisionRequest {
  return {
    kind: "submit-review-decision",
    requestIdempotencyKey,
    expectedVersion,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: {
        workOrderId: submitted.workOrder.workOrderId,
        attemptId: submitted.attempt.attemptId,
        handoffId:
          decision === "rework" ? "handoff-before-rework" : "handoff-receipts",
      },
      handoffVersion,
      decision,
      reason: decision === "approve" ? "Accepted." : "Please revise.",
    },
  };
}

function count(database: DatabaseSync, table: string): number {
  return Number(
    (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  );
}

class NeverCalledAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    throw new Error("Auto-iteration ledger requests do not call a Runtime.");
  }
  async start(_request: RuntimeStart): Promise<never> {
    throw new Error("Auto-iteration ledger requests do not call a Runtime.");
  }
  async resume(_request: RuntimeResume): Promise<never> {
    throw new Error("Auto-iteration ledger requests do not call a Runtime.");
  }
}
