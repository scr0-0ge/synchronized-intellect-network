import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchCoordinator,
  type AutoIterationProjectAuthority,
} from "../../src/coordinator/index.ts";
import {
  QUEUE_REJECTION_LIMIT,
  WORKER_ATTEMPT_CONCURRENCY_LIMIT,
} from "../../src/coordinator/auto-iteration/coordinator.ts";
import type {
  HandoffIdempotencyKey,
  HostBoundToolActor,
  IntegrationCandidate,
  SubmitWorkOrderRequest,
} from "../../src/coordinator/auto-iteration/contract.ts";

/**
 * Issue #8 M4 §1/§2: `waitingFor` splits its old coarse buckets into
 * enumerable reasons, and `read_work_order_status` (the model tool) projects
 * `queued`/`waitingFor` the same way the host-only overview does, instead of
 * only ever showing the durable `executing` row (w342/w349 unsettled).
 */

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

async function openProject(t: TestContext): Promise<AutoIterationProjectAuthority> {
  const root = await mkdtemp(join(tmpdir(), "uaw-waiting-for-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "project.sqlite");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(projectDirectory);
  assert.ok(channel.autoIteration);
  t.after(async () => {
    await channel.close();
    await rm(root, { recursive: true, force: true });
  });
  await channel.autoIteration.bindInitialSupervisor({
    roleSlotId: supervisor.tenure.roleSlotId,
    sessionId: supervisor.sessionId,
    generation: supervisor.tenure.generation,
  });
  return channel.autoIteration;
}

let submitCounter = 0;

async function submitOrderWithHandoff(
  authority: AutoIterationProjectAuthority,
  options?: {
    readonly review?: "none" | SubmitWorkOrderRequest["workOrder"]["review"];
    readonly gitIntegration?: "required" | "not-required";
    readonly endpointId?: SubmitWorkOrderRequest["workOrder"]["workerSession"]["endpointId"];
  },
): Promise<{
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly handoffKey: HandoffIdempotencyKey;
  readonly workerSessionId: string;
  readonly commitSha: string;
}> {
  submitCounter += 1;
  const n = submitCounter;
  const request: SubmitWorkOrderRequest = {
    kind: "submit-work-order",
    requestIdempotencyKey: `waiting-for-submit-${n}`,
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Implement one bounded product change.",
      acceptanceCriteria: ["The requested behavior is covered."],
      baselineCommitSha: "abc123",
      territory: { writePaths: ["src/feature.ts"], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: options?.gitIntegration ?? "not-required" },
      workerSession: { endpointId: options?.endpointId ?? "codex-desktop", profile },
      ...(options?.review === undefined ? {} : { review: options.review }),
    },
  };
  const submitted = await authority.request(supervisor, request);
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") throw new Error("submit failed");
  const workOrderId = submitted.workOrder.workOrderId;
  const attemptId = submitted.attempt.attemptId;
  const workerSessionId = `worker-session-${n}`;
  await authority.bindAttemptSession({ attemptId, sessionId: workerSessionId });
  await authority.updateAttemptRuntime({
    attemptId,
    runtimeLifecycle: "running",
    slotState: "owned",
  });
  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: `handoff-${n}`,
  };
  const commitArtifactId = `artifact-${attemptId}-commit`;
  const commitSha = `${"c".repeat(39)}${n}`;
  await authority.recordArtifact({
    artifactId: commitArtifactId,
    kind: "git-commit",
    commitSha,
  });
  const delivered = await authority.request(
    { kind: "worker", sessionId: workerSessionId, workOrderId, attemptId },
    {
      kind: "submit-handoff",
      requestIdempotencyKey: `waiting-for-handoff-${n}`,
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      handoff: {
        idempotencyKey: handoffKey,
        body: "The worker's own reasoning, never seen by a reviewer.",
        artifactIds: [commitArtifactId],
      },
    },
  );
  assert.equal(delivered.kind, "handoff-submitted");
  return { workOrderId, attemptId, handoffKey, workerSessionId, commitSha };
}

function waitingForOf(
  authority: AutoIterationProjectAuthority,
  workOrderId: string,
): string | null {
  const order = authority
    .readAutoIterationOverview()
    .workOrders.find((candidate) => candidate.workOrderId === workOrderId);
  assert.ok(order, `work order ${workOrderId} missing from the overview`);
  return order!.waitingFor;
}

test("a fifth work order past the concurrency cap reads queued-limit, not the old collapsed worker-start", async (t) => {
  const authority = await openProject(t);
  const workOrderIds: string[] = [];
  for (let i = 0; i < WORKER_ATTEMPT_CONCURRENCY_LIMIT; i += 1) {
    const request: SubmitWorkOrderRequest = {
      kind: "submit-work-order",
      requestIdempotencyKey: `occupy-${i}`,
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      workOrder: {
        objective: "Occupy one worker slot.",
        acceptanceCriteria: ["n/a"],
        baselineCommitSha: "abc123",
        territory: { writePaths: [], readOnlyPaths: [] },
        responsibleRoleSlotId: supervisor.tenure.roleSlotId,
        completionCondition: { gitIntegration: "not-required" },
        workerSession: { endpointId: "codex-desktop", profile },
        review: "none",
      },
    };
    const submitted = await authority.request(supervisor, request);
    assert.equal(submitted.kind, "work-order-submitted");
    if (submitted.kind !== "work-order-submitted") throw new Error("submit failed");
    workOrderIds.push(submitted.workOrder.workOrderId);
    // Bind a session so this order actually occupies a slot (unbound orders
    // do not count toward `occupyingBefore`).
    await authority.bindAttemptSession({
      attemptId: submitted.attempt.attemptId,
      sessionId: `occupy-session-${i}`,
    });
  }
  const fifth: SubmitWorkOrderRequest = {
    kind: "submit-work-order",
    requestIdempotencyKey: "occupy-fifth",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "The fifth order queues behind the cap.",
      acceptanceCriteria: ["n/a"],
      baselineCommitSha: "abc123",
      territory: { writePaths: [], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
      review: "none",
    },
  };
  const submittedFifth = await authority.request(supervisor, fifth);
  assert.equal(submittedFifth.kind, "work-order-submitted");
  if (submittedFifth.kind !== "work-order-submitted") throw new Error("submit failed");

  const overview = authority.readAutoIterationOverview();
  const fifthOrder = overview.workOrders.find(
    (order) => order.workOrderId === submittedFifth.workOrder.workOrderId,
  );
  assert.equal(fifthOrder?.status, "queued");
  assert.equal(
    fifthOrder?.waitingFor,
    "queued-limit",
    "a queued order's reason must name the concurrency cap, not the generic worker-start bucket",
  );
});

test("submit_work_order refuses once the queued backlog already reaches twice the concurrency cap", async (t) => {
  const authority = await openProject(t);
  // Fill the WORKER_ATTEMPT_CONCURRENCY_LIMIT worker slots first...
  for (let i = 0; i < WORKER_ATTEMPT_CONCURRENCY_LIMIT; i += 1) {
    const submitted = await authority.request(supervisor, {
      kind: "submit-work-order",
      requestIdempotencyKey: `qlimit-occupy-${i}`,
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      workOrder: {
        objective: "Occupy one worker slot.",
        acceptanceCriteria: ["n/a"],
        baselineCommitSha: "abc123",
        territory: { writePaths: [], readOnlyPaths: [] },
        responsibleRoleSlotId: supervisor.tenure.roleSlotId,
        completionCondition: { gitIntegration: "not-required" },
        workerSession: { endpointId: "codex-desktop", profile },
        review: "none",
      },
    });
    assert.equal(submitted.kind, "work-order-submitted");
    if (submitted.kind !== "work-order-submitted") throw new Error("submit failed");
    await authority.bindAttemptSession({
      attemptId: submitted.attempt.attemptId,
      sessionId: `qlimit-occupy-session-${i}`,
    });
  }
  // ...then queue exactly QUEUE_REJECTION_LIMIT more behind them.
  for (let i = 0; i < QUEUE_REJECTION_LIMIT; i += 1) {
    const submitted = await authority.request(supervisor, {
      kind: "submit-work-order",
      requestIdempotencyKey: `qlimit-queue-${i}`,
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      workOrder: {
        objective: "Queue behind the occupied slots.",
        acceptanceCriteria: ["n/a"],
        baselineCommitSha: "abc123",
        territory: { writePaths: [], readOnlyPaths: [] },
        responsibleRoleSlotId: supervisor.tenure.roleSlotId,
        completionCondition: { gitIntegration: "not-required" },
        workerSession: { endpointId: "codex-desktop", profile },
        review: "none",
      },
    });
    assert.equal(
      submitted.kind,
      "work-order-submitted",
      `queue slot ${i} of ${QUEUE_REJECTION_LIMIT} must still be accepted`,
    );
  }
  const overflow = await authority.request(supervisor, {
    kind: "submit-work-order",
    requestIdempotencyKey: "qlimit-overflow",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "This one must be refused: the queue is already at its cap.",
      acceptanceCriteria: ["n/a"],
      baselineCommitSha: "abc123",
      territory: { writePaths: [], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
      review: "none",
    },
  });
  assert.equal(overflow.kind, "rejected");
  if (overflow.kind !== "rejected") return;
  assert.equal(overflow.category, "queue-limit-reached");
});

test("an order requiring independent review reads review-pending, then supervisor-busy once the review lands", async (t) => {
  const authority = await openProject(t);
  const { workOrderId, handoffKey } = await submitOrderWithHandoff(authority);

  assert.equal(
    waitingForOf(authority, workOrderId),
    "review-pending",
    "an independent review the policy requires but that has not landed yet is the reason, not a generic supervisor bucket",
  );

  const reviewer = {
    kind: "reviewer",
    sessionId: "reviewer-session-1",
    handoff: handoffKey,
  } as const satisfies HostBoundToolActor;
  const reviewed = await authority.request(reviewer, {
    kind: "submit-review",
    requestIdempotencyKey: "waiting-for-review-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    review: { handoff: handoffKey, verdict: "agree", problems: [] },
  });
  assert.equal(reviewed.kind, "review-submitted");

  assert.equal(
    waitingForOf(authority, workOrderId),
    "supervisor-busy",
    "once the independent review is in, the order is genuinely waiting on the supervisor's own turn",
  );
});

test("a quota-exhausted order's waitingFor carries the pool id, and a blocked/integrated order names the outcome", async (t) => {
  const authority = await openProject(t);

  await authority.observeQuota({
    quotaPoolId: "codex-account:codex",
    source: "codex-account:account/rateLimits/read",
    observedAt: 1,
    status: "observed",
    windows: [
      { name: "5h", usedFraction: 1, resetsAt: null, windowDurationMinutes: 300 },
    ],
  });
  // A fresh submission on the now-exhausted pool lands directly in
  // waiting-for-quota (existing issue #8 M2 behavior); this test only checks
  // the new string shape of the *reason*, not the blocking mechanism itself.
  const request: SubmitWorkOrderRequest = {
    kind: "submit-work-order",
    requestIdempotencyKey: "quota-pool-submit",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Submitted after the codex pool reads exhausted.",
      acceptanceCriteria: ["n/a"],
      baselineCommitSha: "abc123",
      territory: { writePaths: [], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
      review: "none",
    },
  };
  const submitted = await authority.request(supervisor, request);
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") throw new Error("submit failed");
  assert.equal(submitted.workOrder.status, "waiting-for-quota");
  assert.equal(
    waitingForOf(authority, submitted.workOrder.workOrderId),
    "quota:codex-account:codex",
    "the pool id rides inline in the waitingFor string instead of a separate field",
  );

  // A different endpoint/pool than the one just exhausted above, so this
  // order's own submission is not itself quota-blocked.
  const {
    workOrderId: gateFailedId,
    handoffKey: gateFailedHandoff,
    commitSha: gateFailedCommitSha,
  } = await submitOrderWithHandoff(authority, {
    review: "none",
    gitIntegration: "required",
    endpointId: "claude-code-desktop",
  });
  const approvedGateFailed = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "gate-failed-approve",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: gateFailedHandoff,
      handoffVersion: 1,
      decision: "approve",
      reason: "accepted",
    },
  });
  assert.equal(approvedGateFailed.kind, "review-decision-submitted");
  if (approvedGateFailed.kind !== "review-decision-submitted") throw new Error("approve failed");
  const gateFailedCandidate: IntegrationCandidate = {
    integrationCandidateId: "candidate-gate-failed",
    baselineCommitSha: "abc123",
    orderedCommitShas: [gateFailedCommitSha],
    mergeTreeSha: "ee".repeat(20),
    gateDefinitionVersion: "issue-8-m3-v1",
    handoffs: [gateFailedHandoff],
    reviewDecisionIds: [approvedGateFailed.decision.reviewDecisionId],
    environment: "fixture",
    mergeCommitSha: "0f".repeat(20),
    workspaceId: "candidate-gate-failed",
    constructionJobId: "candidate-gate-failed-build",
    version: 1,
  };
  await authority.completeReviewDisposition({
    reviewDecisionId: approvedGateFailed.decision.reviewDecisionId,
    candidate: gateFailedCandidate,
  });
  assert.equal(
    waitingForOf(authority, gateFailedId),
    "integration-running",
    "a candidate still awaiting its terminal outcome reads as actively running, not a bare 'integration' label",
  );
  await authority.completeIntegration({
    integrationCandidateId: gateFailedCandidate.integrationCandidateId,
    outcome: { status: "blocked: gate-failed", gates: [] },
  });
  assert.equal(
    waitingForOf(authority, gateFailedId),
    "integration-blocked:gate-failed",
    "the outcome's specific reason rides inline in the waitingFor string",
  );

  const {
    workOrderId: publishId,
    handoffKey: publishHandoff,
    commitSha: publishCommitSha,
  } = await submitOrderWithHandoff(authority, {
    review: "none",
    gitIntegration: "required",
    endpointId: "claude-code-desktop",
  });
  const approvedPublish = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "publish-approve",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: publishHandoff,
      handoffVersion: 1,
      decision: "approve",
      reason: "accepted",
    },
  });
  assert.equal(approvedPublish.kind, "review-decision-submitted");
  if (approvedPublish.kind !== "review-decision-submitted") throw new Error("approve failed");
  const publishCandidate: IntegrationCandidate = {
    integrationCandidateId: "candidate-ready-to-publish",
    baselineCommitSha: "abc123",
    orderedCommitShas: [publishCommitSha],
    mergeTreeSha: "aa".repeat(20),
    gateDefinitionVersion: "issue-8-m3-v1",
    handoffs: [publishHandoff],
    reviewDecisionIds: [approvedPublish.decision.reviewDecisionId],
    environment: "fixture",
    mergeCommitSha: "1a".repeat(20),
    workspaceId: "candidate-ready-to-publish",
    constructionJobId: "candidate-ready-to-publish-build",
    version: 1,
  };
  await authority.completeReviewDisposition({
    reviewDecisionId: approvedPublish.decision.reviewDecisionId,
    candidate: publishCandidate,
  });
  await authority.completeIntegration({
    integrationCandidateId: publishCandidate.integrationCandidateId,
    outcome: {
      status: "integrated",
      mergeCommitSha: publishCandidate.mergeCommitSha,
      gates: [],
    },
  });
  assert.equal(
    waitingForOf(authority, publishId),
    "ready-to-publish",
    "an integrated-but-unpushed order waits on publish_candidate, not nothing",
  );
  await authority.completePublish({
    integrationCandidateId: publishCandidate.integrationCandidateId,
    outcome: {
      status: "published",
      remoteCommitSha: publishCandidate.mergeCommitSha,
      publishedAt: 1_700_000_000_000,
    },
  });
  assert.equal(
    waitingForOf(authority, publishId),
    null,
    "once actually published there is nothing left to wait for",
  );
});

test("read_work_order_status projects queued/waitingFor the same way the host overview does, not only the durable status", async (t) => {
  const authority = await openProject(t);
  const occupyingSessions: string[] = [];
  for (let i = 0; i < WORKER_ATTEMPT_CONCURRENCY_LIMIT; i += 1) {
    const submitted = await authority.request(supervisor, {
      kind: "submit-work-order",
      requestIdempotencyKey: `status-occupy-${i}`,
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      workOrder: {
        objective: "Occupy one worker slot.",
        acceptanceCriteria: ["n/a"],
        baselineCommitSha: "abc123",
        territory: { writePaths: [], readOnlyPaths: [] },
        responsibleRoleSlotId: supervisor.tenure.roleSlotId,
        completionCondition: { gitIntegration: "not-required" },
        workerSession: { endpointId: "codex-desktop", profile },
        review: "none",
      },
    });
    assert.equal(submitted.kind, "work-order-submitted");
    if (submitted.kind !== "work-order-submitted") throw new Error("submit failed");
    occupyingSessions.push(`status-occupy-session-${i}`);
    await authority.bindAttemptSession({
      attemptId: submitted.attempt.attemptId,
      sessionId: occupyingSessions[i]!,
    });
  }
  const queued = await authority.request(supervisor, {
    kind: "submit-work-order",
    requestIdempotencyKey: "status-queued",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Queues behind the occupied slots.",
      acceptanceCriteria: ["n/a"],
      baselineCommitSha: "abc123",
      territory: { writePaths: [], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
      review: "none",
    },
  });
  assert.equal(queued.kind, "work-order-submitted");
  if (queued.kind !== "work-order-submitted") throw new Error("submit failed");

  // The durable row alone says `executing` -- read_work_order_status must
  // not stop there.
  assert.equal(queued.workOrder.status, "executing");

  const status = await authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "status-read-queued",
    expectedVersion: queued.workOrder.version,
    observedTenure: supervisor.tenure,
    workOrderId: queued.workOrder.workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind !== "work-order-status") return;
  assert.equal(
    status.workOrder.status,
    "executing",
    "the raw durable field is untouched",
  );
  assert.equal(
    status.projectedStatus,
    "queued",
    "the host projection the model tool now carries must show queued",
  );
  assert.equal(status.waitingFor, "queued-limit");
});
