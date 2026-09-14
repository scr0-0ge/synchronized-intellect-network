import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionAuthority,
  SUPERVISOR_TOOL_OPERATIONS,
  WORKER_TOOL_OPERATIONS,
} from "../../src/coordinator/auto-iteration/session-authority.ts";

test("session authority binds the host Session to only its role's tool subset", () => {
  const authority = createSessionAuthority();

  authority.bindSession({
    actor: {
      kind: "supervisor",
      sessionId: "supervisor-session",
      tenure: { roleSlotId: "project-supervisor", generation: 4 },
    },
    allowedOperations: ["read-inbox", "submit-review-decision"],
  });
  authority.bindSession({
    actor: {
      kind: "worker",
      sessionId: "worker-session",
      workOrderId: "work-order-1",
      attemptId: "attempt-1",
    },
  });

  assert.deepEqual(authority.operationsForSession("supervisor-session"), [
    "read-inbox",
    "submit-review-decision",
  ]);
  assert.deepEqual(
    authority.operationsForSession("worker-session"),
    WORKER_TOOL_OPERATIONS,
  );
  assert.deepEqual(
    authority.authorize("supervisor-session", "read-inbox"),
    {
      kind: "supervisor",
      sessionId: "supervisor-session",
      tenure: { roleSlotId: "project-supervisor", generation: 4 },
    },
  );
  assert.equal(
    authority.authorize("worker-session", "submit-review-decision"),
    null,
  );
  assert.equal(authority.authorize("unknown-session", "read-inbox"), null);

  authority.unbindSession("worker-session");
  assert.deepEqual(authority.operationsForSession("worker-session"), []);
});

test("session authority refuses a host binding that grants a role another role's operation", () => {
  const authority = createSessionAuthority();

  assert.throws(
    () =>
      authority.bindSession({
        actor: {
          kind: "worker",
          sessionId: "worker-session",
          workOrderId: "work-order-1",
          attemptId: "attempt-1",
        },
        allowedOperations: ["request-supervisor-rotation"],
      }),
    /worker cannot be bound to request-supervisor-rotation/u,
  );
  assert.equal(
    SUPERVISOR_TOOL_OPERATIONS.includes("request-supervisor-rotation"),
    true,
  );
});
