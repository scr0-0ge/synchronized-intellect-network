import assert from "node:assert/strict";
import test from "node:test";

import type {
  AutoIterationCoordinatorPort,
  CoordinatorToolRequest,
  HostBoundToolActor,
  ReviewerToolRequest,
  ReviewerToolResponse,
  SupervisorToolRequest,
  SupervisorToolResponse,
  WorkerToolRequest,
  WorkerToolResponse,
} from "../../src/coordinator/auto-iteration/contract.ts";
import { createSessionAuthority } from "../../src/coordinator/auto-iteration/session-authority.ts";
import { createAutoIterationToolBridge } from "../../src/coordinator/auto-iteration/tool-bridge.ts";

class FakeCoordinatorPort implements AutoIterationCoordinatorPort {
  readonly calls: Array<{
    actor: HostBoundToolActor;
    request: CoordinatorToolRequest;
  }> = [];

  response: SupervisorToolResponse | WorkerToolResponse | ReviewerToolResponse = {
    kind: "inbox-read",
    requestIdempotencyKey: "request-1",
    currentVersion: 8,
    entries: [],
  };

  async request(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SupervisorToolRequest,
  ): Promise<SupervisorToolResponse>;
  async request(
    actor: Extract<HostBoundToolActor, { readonly kind: "worker" }>,
    request: WorkerToolRequest,
  ): Promise<WorkerToolResponse>;
  async request(
    actor: Extract<HostBoundToolActor, { readonly kind: "reviewer" }>,
    request: ReviewerToolRequest,
  ): Promise<ReviewerToolResponse>;
  async request(
    actor: HostBoundToolActor,
    request: CoordinatorToolRequest,
  ): Promise<SupervisorToolResponse | WorkerToolResponse | ReviewerToolResponse> {
    this.calls.push(structuredClone({ actor, request }));
    return structuredClone(this.response);
  }
}

function bindWorker() {
  const authority = createSessionAuthority();
  authority.bindSession({
    actor: {
      kind: "worker",
      sessionId: "host-worker-session",
      workOrderId: "work-order-1",
      attemptId: "attempt-1",
    },
  });
  return authority;
}

const requestMetadata = {
  requestIdempotencyKey: "request-1",
  expectedVersion: 7,
  observedTenure: { roleSlotId: "project-supervisor", generation: 3 },
};

test("worker actor cannot call a supervisor operation", async () => {
  const port = new FakeCoordinatorPort();
  const bridge = createAutoIterationToolBridge({
    authority: bindWorker(),
    port,
  });

  const response = await bridge.call(
    "host-worker-session",
    "submit-review-decision",
    {
      ...requestMetadata,
      decision: {
        decision: "approve",
        handoff: {
          workOrderId: "work-order-1",
          attemptId: "attempt-1",
          handoffId: "handoff-1",
        },
        handoffVersion: 1,
        reason: "verified",
      },
    },
  );

  assert.deepEqual(response, {
    kind: "rejected",
    requestIdempotencyKey: "request-1",
    currentVersion: null,
    operation: "submit-review-decision",
    category: "forbidden",
  });
  assert.equal(port.calls.length, 0);
});

test("model-supplied identity fields are ignored and idempotency metadata reaches the port", async () => {
  const port = new FakeCoordinatorPort();
  const bridge = createAutoIterationToolBridge({
    authority: bindWorker(),
    port,
  });

  const response = await bridge.call(
    "host-worker-session",
    "read-work-order-status",
    {
      ...requestMetadata,
      workOrderId: "work-order-1",
      sessionId: "forged-supervisor-session",
      role: "supervisor",
      actor: {
        kind: "supervisor",
        sessionId: "forged-supervisor-session",
        tenure: { roleSlotId: "other-role", generation: 99 },
      },
    },
  );

  assert.equal(response.kind, "inbox-read");
  assert.deepEqual(port.calls, [
    {
      actor: {
        kind: "worker",
        sessionId: "host-worker-session",
        workOrderId: "work-order-1",
        attemptId: "attempt-1",
      },
      request: {
        kind: "read-work-order-status",
        requestIdempotencyKey: "request-1",
        expectedVersion: 7,
        observedTenure: {
          roleSlotId: "project-supervisor",
          generation: 3,
        },
        workOrderId: "work-order-1",
      },
    },
  ]);
});

test("bridge drops private provider data from responses before returning them to the model", async () => {
  const port = new FakeCoordinatorPort();
  port.response = {
    kind: "inbox-read",
    requestIdempotencyKey: "request-1",
    currentVersion: 8,
    entries: [],
    subscriptionToken: "must-not-cross",
    opaqueSessionReference: "provider-native-resume-reference",
    workspaceRoot: "C:\\Users\\owner\\project",
  } as WorkerToolResponse;
  const bridge = createAutoIterationToolBridge({
    authority: bindWorker(),
    port,
  });

  const response = await bridge.call("host-worker-session", "read-inbox", {
    ...requestMetadata,
    roleSlotId: "project-supervisor",
  });

  assert.deepEqual(response, {
    kind: "inbox-read",
    requestIdempotencyKey: "request-1",
    currentVersion: 8,
    entries: [],
  });
  assert.doesNotMatch(JSON.stringify(response), /must-not-cross|Users|resume/u);
});

test("bridge rejects absolute paths and removes unrecognised secret fields from valid requests", async () => {
  const authority = createSessionAuthority();
  authority.bindSession({
    actor: {
      kind: "supervisor",
      sessionId: "host-supervisor-session",
      tenure: { roleSlotId: "project-supervisor", generation: 3 },
    },
  });
  const port = new FakeCoordinatorPort();
  port.response = {
    kind: "work-order-submitted",
    requestIdempotencyKey: "request-1",
    currentVersion: 1,
    workOrder: {} as never,
    attempt: {} as never,
  };
  const bridge = createAutoIterationToolBridge({ authority, port });
  const baseWorkOrder = {
    objective: "implement the bounded task",
    acceptanceCriteria: ["tests pass"],
    baselineCommitSha: "0123456789abcdef",
    territory: { writePaths: ["src/owned.ts"], readOnlyPaths: [] },
    responsibleRoleSlotId: "project-supervisor",
    completionCondition: { gitIntegration: "required" },
    workerSession: {
      endpointId: "codex-desktop",
      profile: {
        model: "gpt-5.6-sol",
        effortLevel: "high",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    },
  };

  const accepted = await bridge.call(
    "host-supervisor-session",
    "submit-work-order",
    {
      ...requestMetadata,
      workOrder: {
        ...baseWorkOrder,
        subscriptionToken: "must-not-reach-port",
        opaqueSessionReference: "must-not-reach-port",
      },
    },
  );
  assert.equal(accepted.kind, "work-order-submitted");
  assert.equal(port.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(port.calls[0]), /must-not-reach-port/u);

  const rejected = await bridge.call(
    "host-supervisor-session",
    "submit-work-order",
    {
      ...requestMetadata,
      workOrder: {
        ...baseWorkOrder,
        territory: {
          writePaths: ["C:\\Users\\owner\\project\\src\\owned.ts"],
          readOnlyPaths: [],
        },
      },
    },
  );
  assert.deepEqual(rejected, {
    kind: "rejected",
    requestIdempotencyKey: "request-1",
    currentVersion: null,
    operation: "submit-work-order",
    category: "invalid-request",
  });
  assert.equal(port.calls.length, 1);
});
