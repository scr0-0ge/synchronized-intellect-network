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
  type ProjectChannel,
} from "../../src/coordinator/index.ts";
import type {
  HostBoundToolActor,
  IntegrationCandidate,
  SubmitHandoffRequest,
  SubmitWorkOrderRequest,
} from "../../src/coordinator/auto-iteration/contract.ts";

/**
 * The Project-transaction half of M3 integration outcomes: completeIntegration
 * records the outcome beside the frozen candidate, advances the Work Order
 * lifecycle (awaiting-integration -> integrated | blocked), files the
 * supervisor inbox entry for target-moved, stays idempotent, and the
 * supervisor's read_work_order_status tool sees candidate status plus the
 * gate-record summary. The integration backlog is the reopen-resume driver:
 * candidates with an outcome never reappear in it.
 */

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

const greenOutcome = {
  status: "integrated",
  mergeCommitSha: "0f".repeat(20),
  gates: [
    { gate: "build", jobId: "integration-candidate-1-gate-build", exitCode: 0, passed: true, tail: "build gate passed" },
    { gate: "typecheck", jobId: "integration-candidate-1-gate-typecheck", exitCode: 0, passed: true, tail: "typecheck gate passed" },
  ],
} as const;

const targetMovedOutcome = {
  status: "blocked: target-moved",
  expectedBaselineCommitSha: "abc123",
  observedTargetRefCommitSha: null,
  observedLocalBranchCommitSha: "1a".repeat(20),
} as const;

interface Fixture {
  readonly authority: AutoIterationProjectAuthority;
  readonly workOrderId: string;
  readonly reviewDecisionId: string;
}

async function createFrozenCandidateFixture(
  t: TestContext,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "uaw-integration-lifecycle-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "project.sqlite");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(projectDirectory);
  assert.ok(channel.autoIteration);
  const authority = channel.autoIteration;
  t.after(async () => {
    await channel.close();
    await rm(root, { recursive: true, force: true });
  });
  await authority.bindInitialSupervisor({
    roleSlotId: supervisor.tenure.roleSlotId,
    sessionId: supervisor.sessionId,
    generation: supervisor.tenure.generation,
  });

  const request: SubmitWorkOrderRequest = {
    kind: "submit-work-order",
    requestIdempotencyKey: "lifecycle-submit-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Implement one bounded product change.",
      acceptanceCriteria: ["The requested behavior is covered."],
      baselineCommitSha: "abc123",
      territory: { writePaths: ["src/feature.ts"], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "required" },
      workerSession: { endpointId: "codex-desktop", profile },
    },
  };
  const submitted = await authority.request(supervisor, request);
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") throw new Error("submit failed");
  await authority.bindAttemptSession({
    attemptId: submitted.attempt.attemptId,
    sessionId: "worker-session-1",
  });
  const handoff: SubmitHandoffRequest = {
    kind: "submit-handoff",
    requestIdempotencyKey: "lifecycle-handoff-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    handoff: {
      idempotencyKey: {
        workOrderId: submitted.workOrder.workOrderId,
        attemptId: submitted.attempt.attemptId,
        handoffId: "handoff-lifecycle-1",
      },
      body: "Implementation and verification are ready for review.",
      artifactIds: [],
    },
  };
  const delivered = await authority.request(
    { kind: "worker", sessionId: "worker-session-1", workOrderId: submitted.workOrder.workOrderId, attemptId: submitted.attempt.attemptId },
    handoff,
  );
  assert.equal(delivered.kind, "handoff-submitted");
  const approved = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "lifecycle-review-1",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: handoff.handoff.idempotencyKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "Accepted.",
    },
  });
  assert.equal(approved.kind, "review-decision-submitted");
  if (approved.kind !== "review-decision-submitted") throw new Error("approve failed");

  const candidate: IntegrationCandidate = {
    integrationCandidateId: "candidate-lifecycle-1",
    baselineCommitSha: "abc123",
    orderedCommitShas: [],
    mergeTreeSha: "ee".repeat(20),
    gateDefinitionVersion: "issue-8-m3-v1",
    handoffs: [handoff.handoff.idempotencyKey],
    reviewDecisionIds: [approved.decision.reviewDecisionId],
    environment: "fixture",
    mergeCommitSha: "0f".repeat(20),
    workspaceId: "candidate-lifecycle-1",
    constructionJobId: "candidate-lifecycle-1-build",
    version: 1,
  };
  await authority.completeReviewDisposition({
    reviewDecisionId: approved.decision.reviewDecisionId,
    candidate,
  });
  return {
    authority,
    workOrderId: submitted.workOrder.workOrderId,
    reviewDecisionId: approved.decision.reviewDecisionId,
  };
}

test("an integrated outcome lands in one transaction, stays idempotent, and leaves the backlog", async (t) => {
  const { authority, workOrderId, reviewDecisionId } = await createFrozenCandidateFixture(t);

  const backlog = await authority.readIntegrationBacklog();
  assert.equal(backlog.length, 1);
  assert.equal(backlog[0]!.reviewDecisionId, reviewDecisionId);
  assert.equal(
    backlog[0]!.candidate.integrationCandidateId,
    "candidate-lifecycle-1",
  );

  await authority.completeIntegration({
    integrationCandidateId: "candidate-lifecycle-1",
    outcome: greenOutcome,
  });

  // The supervisor tool sees candidate status plus the gate-record summary.
  const status = await authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "lifecycle-read-integrated",
    expectedVersion: 4,
    observedTenure: supervisor.tenure,
    workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind !== "work-order-status") return;
  assert.equal(status.workOrder.status, "integrated");
  assert.equal(status.candidates.length, 1);
  const candidate = status.candidates[0]!;
  assert.equal(candidate.outcome?.status, "integrated");
  assert.equal(candidate.outcome?.mergeCommitSha, greenOutcome.mergeCommitSha);
  assert.equal(candidate.outcome?.gates.length, 2);
  assert.equal(candidate.outcome?.gates[0]!.gate, "build");
  assert.equal(candidate.outcome?.gates[0]!.passed, true);

  assert.equal(
    (await authority.readIntegrationBacklog()).length,
    0,
    "a recorded outcome never re-enters the backlog",
  );

  // The same outcome replays as a no-op; a different one is refused.
  await authority.completeIntegration({
    integrationCandidateId: "candidate-lifecycle-1",
    outcome: greenOutcome,
  });
  await assert.rejects(
    authority.completeIntegration({
      integrationCandidateId: "candidate-lifecycle-1",
      outcome: {
        status: "blocked: gate-failed",
        gates: [{ gate: "build", jobId: "j", exitCode: 1, passed: false, tail: "x" }],
      },
    }),
    /integration-outcome-conflict/u,
  );
});

test("a target-moved outcome blocks the work order and files a supervisor inbox entry", async (t) => {
  const { authority, workOrderId } = await createFrozenCandidateFixture(t);

  await authority.completeIntegration({
    integrationCandidateId: "candidate-lifecycle-1",
    outcome: targetMovedOutcome,
  });

  const status = await authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "lifecycle-read-blocked",
    expectedVersion: 4,
    observedTenure: supervisor.tenure,
    workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  if (status.kind !== "work-order-status") return;
  assert.equal(status.workOrder.status, "blocked");
  assert.equal(status.candidates[0]!.outcome?.status, "blocked: target-moved");

  const inbox = await authority.request(supervisor, {
    kind: "read-inbox",
    requestIdempotencyKey: "lifecycle-read-inbox",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    roleSlotId: supervisor.tenure.roleSlotId,
  });
  assert.equal(inbox.kind, "inbox-read");
  if (inbox.kind !== "inbox-read") return;
  const blockedEntry = inbox.entries.find((entry) => entry.kind === "blocked");
  assert.ok(blockedEntry, "the supervisor inbox carries the blocked integration");
  assert.equal(blockedEntry.state, "pending");
  if (blockedEntry.kind !== "blocked") return;
  assert.equal(blockedEntry.workOrderId, workOrderId);
  assert.match(blockedEntry.summary, /candidate-lifecycle-1/u);
  assert.match(blockedEntry.summary, /target/u);
});

test("an unknown candidate id is refused without touching any work order", async (t) => {
  const { authority } = await createFrozenCandidateFixture(t);
  await assert.rejects(
    authority.completeIntegration({
      integrationCandidateId: "candidate-never-frozen",
      outcome: greenOutcome,
    }),
    /integration-candidate-outbox-not-found/u,
  );
  assert.equal((await authority.readIntegrationBacklog()).length, 1);
});

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
