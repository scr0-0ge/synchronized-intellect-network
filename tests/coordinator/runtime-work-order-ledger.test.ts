import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";

const profile = {
  model: "gpt-5.6-sol",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
} as const;

const supervisor = {
  kind: "supervisor",
  sessionId: "supervisor-runtime-ledger",
  tenure: { roleSlotId: "project-supervisor", generation: 1 },
} as const;

test("Runtime slot ownership remains on the attempt until the host explicitly releases it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-attempt-slot-"));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "project.sqlite"),
    adapter: new NeverCalledAdapter(),
  }).openProject(projectDirectory);
  t.after(async () => {
    await channel.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.ok(channel.autoIteration);
  const authority = channel.autoIteration;
  await authority.bindInitialSupervisor({
    roleSlotId: supervisor.tenure.roleSlotId,
    sessionId: supervisor.sessionId,
    generation: supervisor.tenure.generation,
  });
  const submitted = await authority.request(supervisor, {
    kind: "submit-work-order",
    requestIdempotencyKey: "attempt-slot-order",
    expectedVersion: 1,
    observedTenure: supervisor.tenure,
    workOrder: {
      objective: "Keep Runtime resource state separate from business delivery.",
      acceptanceCriteria: ["A Handoff cannot release the slot."],
      baselineCommitSha: "abc123",
      territory: { writePaths: ["src/coordinator"], readOnlyPaths: [] },
      responsibleRoleSlotId: supervisor.tenure.roleSlotId,
      completionCondition: { gitIntegration: "required" },
      workerSession: { endpointId: "codex-desktop", profile },
    },
  });
  assert.equal(submitted.kind, "work-order-submitted");
  if (submitted.kind !== "work-order-submitted") return;
  await authority.bindAttemptSession({
    attemptId: submitted.attempt.attemptId,
    sessionId: "worker-runtime-ledger",
  });
  await authority.updateAttemptRuntime({
    attemptId: submitted.attempt.attemptId,
    runtimeLifecycle: "running",
    slotState: "owned",
    workspaceId: "workspace-1",
  });
  const worker = {
    kind: "worker",
    sessionId: "worker-runtime-ledger",
    workOrderId: submitted.workOrder.workOrderId,
    attemptId: submitted.attempt.attemptId,
  } as const;
  const handoff = await authority.request(worker, {
    kind: "submit-handoff",
    requestIdempotencyKey: "attempt-slot-handoff-request",
    expectedVersion: submitted.workOrder.version,
    observedTenure: supervisor.tenure,
    handoff: {
      idempotencyKey: {
        workOrderId: submitted.workOrder.workOrderId,
        attemptId: submitted.attempt.attemptId,
        handoffId: "attempt-slot-handoff",
      },
      body: "The business report is ready while the execution process is still owned.",
      artifactIds: [],
    },
  });
  assert.equal(handoff.kind, "handoff-submitted");
  if (handoff.kind !== "handoff-submitted") return;
  const beforeRelease = await authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "attempt-slot-read-owned",
    expectedVersion: handoff.currentVersion,
    observedTenure: supervisor.tenure,
    workOrderId: submitted.workOrder.workOrderId,
  });
  assert.equal(beforeRelease.kind, "work-order-status");
  if (beforeRelease.kind !== "work-order-status") return;
  assert.equal(beforeRelease.workOrder.status, "awaiting-review");
  assert.equal(beforeRelease.attempts[0]?.runtimeLifecycle, "running");
  assert.equal(beforeRelease.attempts[0]?.slotState, "owned");

  await authority.updateAttemptRuntime({
    attemptId: submitted.attempt.attemptId,
    runtimeLifecycle: "completed",
    slotState: "released",
    workspaceId: null,
  });
  const afterRelease = await authority.request(supervisor, {
    kind: "read-work-order-status",
    requestIdempotencyKey: "attempt-slot-read-released",
    expectedVersion: handoff.currentVersion,
    observedTenure: supervisor.tenure,
    workOrderId: submitted.workOrder.workOrderId,
  });
  assert.equal(afterRelease.kind, "work-order-status");
  if (afterRelease.kind === "work-order-status") {
    assert.equal(afterRelease.workOrder.status, "awaiting-review");
    assert.equal(afterRelease.attempts[0]?.runtimeLifecycle, "completed");
    assert.equal(afterRelease.attempts[0]?.slotState, "released");
  }
});

class NeverCalledAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    throw new Error("Ledger-only operations do not inspect a Runtime.");
  }
  async start(_request: RuntimeStart): Promise<never> {
    throw new Error("Ledger-only operations do not start a Runtime.");
  }
  async resume(_request: RuntimeResume): Promise<never> {
    throw new Error("Ledger-only operations do not resume a Runtime.");
  }
}