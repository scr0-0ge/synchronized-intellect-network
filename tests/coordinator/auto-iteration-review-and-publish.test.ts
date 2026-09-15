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
import type {
  HandoffIdempotencyKey,
  HostBoundToolActor,
  IntegrationCandidate,
  SubmitHandoffRequest,
  SubmitWorkOrderRequest,
} from "../../src/coordinator/auto-iteration/contract.ts";
import { REWORK_ATTEMPT_LIMIT } from "../../src/coordinator/auto-iteration/coordinator.ts";

/**
 * Issue #8 M3 second cut, coordinator half (issue #8 §3): the independent
 * Review Attempt's two tools (`read_handoff_artifact` / `submit_review`),
 * the `submit_review_decision` gate that refuses disposition without a
 * recorded review (unless the order opts out with `review: "none"`), the
 * rework path's verbatim-problems feedback and its 2-rework cap, and
 * `publish_candidate`'s coordinator-side eligibility half (the host does the
 * actual push; see the backend suite for that half and the real bare-repo
 * push/target-moved cases).
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

interface Fixture {
  readonly authority: AutoIterationProjectAuthority;
  readonly workOrderId: string;
}

async function openProject(t: TestContext): Promise<AutoIterationProjectAuthority> {
  const root = await mkdtemp(join(tmpdir(), "uaw-review-publish-"));
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
    requestIdempotencyKey: `review-submit-${n}`,
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Implement one bounded product change.",
      acceptanceCriteria: ["The requested behavior is covered."],
      baselineCommitSha: "abc123",
      territory: { writePaths: ["src/feature.ts"], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: options?.gitIntegration ?? "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
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
  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: `handoff-${n}`,
  };
  // Mirrors the host's real capture-artifact step (backend.ts
  // captureHandoffArtifacts): a Handoff always carries a host-recorded
  // git-commit artifact, which read_handoff_artifact reads from.
  const commitArtifactId = `artifact-${attemptId}-commit`;
  const commitSha = `${"c".repeat(39)}${n}`;
  await authority.recordArtifact({
    artifactId: commitArtifactId,
    kind: "git-commit",
    commitSha,
  });
  const handoffRequest: SubmitHandoffRequest = {
    kind: "submit-handoff",
    requestIdempotencyKey: `review-handoff-${n}`,
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    handoff: {
      idempotencyKey: handoffKey,
      body: "The worker's own reasoning, never seen by a reviewer.",
      artifactIds: [commitArtifactId],
    },
  };
  const delivered = await authority.request(
    { kind: "worker", sessionId: workerSessionId, workOrderId, attemptId },
    handoffRequest,
  );
  assert.equal(delivered.kind, "handoff-submitted");
  return { workOrderId, attemptId, handoffKey, workerSessionId, commitSha };
}

test("the default review policy differs the reviewer's endpoint from the worker's; an explicit policy and 'none' are honored", async (t) => {
  const authority = await openProject(t);

  const defaulted = await submitOrderWithHandoff(authority);
  const defaultedOrder = authority.readWorkOrder(defaulted.workOrderId);
  assert.equal(defaultedOrder?.review?.kind, "independent");
  if (defaultedOrder?.review?.kind !== "independent") return;
  assert.equal(defaultedOrder.review.reviewerSession.endpointId, "claude-code-desktop");
  assert.equal(defaultedOrder.review.sameEndpointAsWorker, false);

  const explicit = await submitOrderWithHandoff(authority, {
    review: { endpointId: "codex-desktop", profile },
  });
  const explicitOrder = authority.readWorkOrder(explicit.workOrderId);
  assert.equal(explicitOrder?.review?.kind, "independent");
  if (explicitOrder?.review?.kind !== "independent") return;
  assert.equal(explicitOrder.review.reviewerSession.endpointId, "codex-desktop");
  assert.equal(explicitOrder.review.sameEndpointAsWorker, true);

  const none = await submitOrderWithHandoff(authority, { review: "none" });
  assert.deepEqual(authority.readWorkOrder(none.workOrderId)?.review, { kind: "none" });
});

test("read_handoff_artifact is authorized only for the bound reviewer's own Handoff, and never carries the worker's body", async (t) => {
  const authority = await openProject(t);
  const { handoffKey } = await submitOrderWithHandoff(authority);
  const reviewer = {
    kind: "reviewer",
    sessionId: "reviewer-session-1",
    handoff: handoffKey,
  } as const satisfies HostBoundToolActor;

  const response = await authority.request(reviewer, {
    kind: "read-handoff-artifact",
    requestIdempotencyKey: "artifact-read-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    handoff: handoffKey,
  });
  assert.equal(response.kind, "handoff-artifact");
  if (response.kind !== "handoff-artifact") return;
  assert.equal(response.workOrderObjective, "Implement one bounded product change.");
  assert.deepEqual(response.acceptanceCriteria, ["The requested behavior is covered."]);
  assert.equal(response.baselineCommitSha, "abc123");
  assert.equal(
    response.diff,
    "",
    "the coordinator has no git access; the host fills the diff in afterward",
  );
  assert.equal(
    "body" in response,
    false,
    "the worker's own reasoning never appears in a reviewer response",
  );

  // A reviewer bound to a DIFFERENT Handoff is forbidden.
  const otherHandoff: HandoffIdempotencyKey = {
    ...handoffKey,
    handoffId: `${handoffKey.handoffId}-other`,
  };
  const forbidden = await authority.request(
    { kind: "reviewer", sessionId: "reviewer-session-2", handoff: otherHandoff },
    {
      kind: "read-handoff-artifact",
      requestIdempotencyKey: "artifact-read-2",
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      handoff: handoffKey,
    },
  );
  assert.equal(forbidden.kind, "rejected");
  if (forbidden.kind !== "rejected") return;
  assert.equal(forbidden.category, "forbidden");

  // Neither a worker nor the supervisor may call this reviewer-only tool.
  const workerAttempt = await authority.request(
    { kind: "worker", sessionId: "worker-session-1", workOrderId: handoffKey.workOrderId, attemptId: handoffKey.attemptId },
    {
      kind: "read-handoff-artifact",
      requestIdempotencyKey: "artifact-read-3",
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      handoff: handoffKey,
    } as never,
  );
  assert.equal(workerAttempt.kind, "rejected");
});

test("submit_review persists once, replays idempotently, and refuses a conflicting resubmission", async (t) => {
  const authority = await openProject(t);
  const { handoffKey } = await submitOrderWithHandoff(authority);
  const reviewer = {
    kind: "reviewer",
    sessionId: "reviewer-session-1",
    handoff: handoffKey,
  } as const satisfies HostBoundToolActor;

  const submission = {
    kind: "submit-review" as const,
    requestIdempotencyKey: "submit-review-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    review: {
      handoff: handoffKey,
      verdict: "disagree" as const,
      problems: [{ code: "cannot-verify", message: "No test covers the new branch." }],
    },
  };
  const first = await authority.request(reviewer, submission);
  assert.equal(first.kind, "review-submitted");
  if (first.kind !== "review-submitted") return;
  assert.equal(first.result.verdict, "disagree");
  assert.equal(first.result.reviewerSessionId, "reviewer-session-1");

  // A retried identical call from the same idempotency key replays the cached response.
  const replay = await authority.request(reviewer, submission);
  assert.deepEqual(replay, first);

  // A DIFFERENT idempotency key with a conflicting verdict for the SAME Handoff is refused.
  const conflicting = await authority.request(reviewer, {
    ...submission,
    requestIdempotencyKey: "submit-review-2",
    review: { ...submission.review, verdict: "agree" as const },
  });
  assert.equal(conflicting.kind, "rejected");
  if (conflicting.kind !== "rejected") return;
  assert.equal(conflicting.category, "idempotency-conflict");
});

test("submit_review_decision is refused without a recorded review, succeeds once one exists, and 'none' opts out", async (t) => {
  const authority = await openProject(t);
  const { handoffKey } = await submitOrderWithHandoff(authority);

  const tooEarly = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "decide-too-early",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: handoffKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "looks fine",
    },
  });
  assert.equal(tooEarly.kind, "rejected");
  if (tooEarly.kind !== "rejected") return;
  assert.equal(tooEarly.category, "review-required");

  await authority.request(
    { kind: "reviewer", sessionId: "reviewer-session-1", handoff: handoffKey },
    {
      kind: "submit-review",
      requestIdempotencyKey: "decide-review-1",
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      review: { handoff: handoffKey, verdict: "agree", problems: [] },
    },
  );

  const decided = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "decide-now",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: handoffKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "looks fine",
    },
  });
  assert.equal(decided.kind, "review-decision-submitted");

  // An order that opts out is never gated.
  const opted = await submitOrderWithHandoff(authority, { review: "none" });
  const optedDecision = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "decide-opted-out",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: opted.handoffKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "no independent review required for this order",
    },
  });
  assert.equal(optedDecision.kind, "review-decision-submitted");
});

test("a disagree verdict's problems ride verbatim into the rework attempt's kickoff payload, and rework is capped at issue #8's 2", async (t) => {
  const authority = await openProject(t);
  const first = await submitOrderWithHandoff(authority);
  const { workOrderId } = first;
  let handoffKey = first.handoffKey;
  // submitOrderWithHandoff's handoff is the order's first delivered/awaiting-review
  // transition (version 1 -> 2); every later step's own response reports the
  // version its mutation produced, so no separate read is needed to track it.
  let workOrderVersion = 2;

  for (let reworkNumber = 1; reworkNumber <= REWORK_ATTEMPT_LIMIT; reworkNumber += 1) {
    const problems = [
      { code: "cannot-verify", message: `Rework ${reworkNumber}: the acceptance criterion is not covered.` },
    ];
    await authority.request(
      { kind: "reviewer", sessionId: `reviewer-rework-${reworkNumber}`, handoff: handoffKey },
      {
        kind: "submit-review",
        requestIdempotencyKey: `rework-review-${reworkNumber}`,
        expectedVersion: 1,
        observedTenure: supervisor.tenure,
        review: { handoff: handoffKey, verdict: "disagree", problems },
      },
    );
    const decided = await authority.request(supervisor, {
      kind: "submit-review-decision",
      requestIdempotencyKey: `rework-decision-${reworkNumber}`,
      expectedVersion: workOrderVersion,
      observedTenure: supervisor.tenure,
      decision: {
        handoff: handoffKey,
        handoffVersion: 1,
        decision: "rework",
        reason: "address the reviewer's problems",
      },
    });
    assert.equal(decided.kind, "review-decision-submitted");
    if (decided.kind !== "review-decision-submitted") return;
    workOrderVersion = decided.currentVersion;

    const pending = (await authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "start-attempt",
    );
    const reworkEntry = pending.find((entry) => {
      const payload = entry.payload as { readonly workOrderId?: string };
      return payload.workOrderId === workOrderId;
    });
    assert.ok(reworkEntry, `rework ${reworkNumber} must queue a new start-attempt`);
    const payload = reworkEntry!.payload as {
      readonly attemptId: string;
      readonly reworkFeedback?: string;
    };
    assert.equal(
      payload.reworkFeedback,
      `[cannot-verify] Rework ${reworkNumber}: the acceptance criterion is not covered.`,
      "the rework kickoff carries the reviewer's problems verbatim, not the supervisor's reason",
    );

    // Advance to the new attempt's handoff so the next loop (or the cap
    // check below) targets the live attempt.
    const nextAttemptId = payload.attemptId;
    await authority.bindAttemptSession({
      attemptId: nextAttemptId,
      sessionId: `worker-rework-${reworkNumber}`,
    });
    const nextHandoffKey: HandoffIdempotencyKey = {
      workOrderId,
      attemptId: nextAttemptId,
      handoffId: `handoff-rework-${reworkNumber}`,
    };
    const nextHandoff = await authority.request(
      { kind: "worker", sessionId: `worker-rework-${reworkNumber}`, workOrderId, attemptId: nextAttemptId },
      {
        kind: "submit-handoff",
        requestIdempotencyKey: `rework-handoff-${reworkNumber}`,
        expectedVersion: workOrderVersion,
        observedTenure: supervisor.tenure,
        handoff: {
          idempotencyKey: nextHandoffKey,
          body: "Reworked delivery.",
          artifactIds: [],
        },
      },
    );
    assert.equal(nextHandoff.kind, "handoff-submitted");
    if (nextHandoff.kind !== "handoff-submitted") return;
    workOrderVersion = nextHandoff.currentVersion;
    handoffKey = nextHandoffKey;
  }

  // The cap is now spent (2 reworks already happened): a third is refused.
  await authority.request(
    { kind: "reviewer", sessionId: "reviewer-rework-3", handoff: handoffKey },
    {
      kind: "submit-review",
      requestIdempotencyKey: "rework-review-3",
      expectedVersion: 1,
      observedTenure: supervisor.tenure,
      review: {
        handoff: handoffKey,
        verdict: "disagree",
        problems: [{ code: "cannot-verify", message: "Still not covered." }],
      },
    },
  );
  const capped = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "rework-decision-3",
    expectedVersion: workOrderVersion,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: handoffKey,
      handoffVersion: 1,
      decision: "rework",
      reason: "would be a third rework",
    },
  });
  assert.equal(capped.kind, "rejected");
  if (capped.kind !== "rejected") return;
  assert.equal(capped.category, "rework-limit-reached");
});

test("publish_candidate requires an already-integrated candidate and is idempotent once published", async (t) => {
  const authority = await openProject(t);
  const { handoffKey, commitSha } = await submitOrderWithHandoff(authority, {
    review: "none",
    gitIntegration: "required",
  });

  const approved = await authority.request(supervisor, {
    kind: "submit-review-decision",
    requestIdempotencyKey: "publish-approve-1",
    expectedVersion: 2,
    observedTenure: supervisor.tenure,
    decision: {
      handoff: handoffKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "accepted",
    },
  });
  assert.equal(approved.kind, "review-decision-submitted");
  if (approved.kind !== "review-decision-submitted") return;

  const notYetIntegrated = await authority.request(supervisor, {
    kind: "publish-candidate",
    requestIdempotencyKey: "publish-too-early",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    integrationCandidateId: "candidate-never-frozen",
  });
  assert.equal(notYetIntegrated.kind, "rejected");
  if (notYetIntegrated.kind !== "rejected") return;
  assert.equal(notYetIntegrated.category, "not-found");

  const candidate: IntegrationCandidate = {
    integrationCandidateId: "candidate-publish-1",
    baselineCommitSha: "abc123",
    orderedCommitShas: [commitSha],
    mergeTreeSha: "ee".repeat(20),
    gateDefinitionVersion: "issue-8-m3-v1",
    handoffs: [handoffKey],
    reviewDecisionIds: [approved.decision.reviewDecisionId],
    environment: "fixture",
    mergeCommitSha: "0f".repeat(20),
    workspaceId: "candidate-publish-1",
    constructionJobId: "candidate-publish-1-build",
    version: 1,
  };
  await authority.completeReviewDisposition({
    reviewDecisionId: approved.decision.reviewDecisionId,
    candidate,
  });

  const stillIntegrating = await authority.request(supervisor, {
    kind: "publish-candidate",
    requestIdempotencyKey: "publish-not-integrated",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    integrationCandidateId: candidate.integrationCandidateId,
  });
  assert.equal(stillIntegrating.kind, "rejected");
  if (stillIntegrating.kind !== "rejected") return;
  assert.equal(stillIntegrating.category, "not-integrated");

  await authority.completeIntegration({
    integrationCandidateId: candidate.integrationCandidateId,
    outcome: {
      status: "integrated",
      mergeCommitSha: candidate.mergeCommitSha,
      gates: [],
    },
  });

  const accepted = await authority.request(supervisor, {
    kind: "publish-candidate",
    requestIdempotencyKey: "publish-accept-1",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    integrationCandidateId: candidate.integrationCandidateId,
  });
  assert.equal(accepted.kind, "publish-candidate-accepted");
  if (accepted.kind !== "publish-candidate-accepted") return;
  assert.equal(accepted.candidate.integrationCandidateId, candidate.integrationCandidateId);

  // The host performs the real push (backend suite); here we exercise the
  // record + idempotent-replay half directly, as the host would after a push.
  await authority.completePublish({
    integrationCandidateId: candidate.integrationCandidateId,
    outcome: {
      status: "published",
      remoteCommitSha: candidate.mergeCommitSha,
      publishedAt: 1_700_000_000_000,
    },
  });

  const alreadyPublished = await authority.request(supervisor, {
    kind: "publish-candidate",
    requestIdempotencyKey: "publish-again",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    integrationCandidateId: candidate.integrationCandidateId,
  });
  assert.equal(alreadyPublished.kind, "publish-candidate-result");
  if (alreadyPublished.kind !== "publish-candidate-result") return;
  assert.equal(alreadyPublished.outcome.status, "published");

  await assert.rejects(
    authority.completePublish({
      integrationCandidateId: candidate.integrationCandidateId,
      outcome: {
        status: "blocked: target-moved",
        expectedBaselineCommitSha: "abc123",
        observedRemoteCommitSha: "different",
      },
    }),
    /publish-outcome-conflict/u,
    "a terminal published outcome cannot be silently overwritten",
  );
});
