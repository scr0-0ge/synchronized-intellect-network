import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkOrderTransition,
  WorkOrderTransitionError,
} from "../../src/coordinator/auto-iteration/state-machine.ts";

test("the business lifecycle reaches integration without using Runtime completion", () => {
  const path = [
    "executing",
    "delivered",
    "awaiting-review",
    "review-approved",
    "awaiting-integration",
    "integrated",
  ] as const;

  for (let index = 0; index < path.length - 1; index += 1) {
    assert.equal(assertWorkOrderTransition(path[index]!, path[index + 1]!), path[index + 1]);
  }
});

test("rework, blocking, and quota waits have explicit recovery paths", () => {
  assert.equal(assertWorkOrderTransition("awaiting-review", "rework"), "rework");
  assert.equal(assertWorkOrderTransition("rework", "executing"), "executing");
  assert.equal(assertWorkOrderTransition("executing", "blocked"), "blocked");
  assert.equal(assertWorkOrderTransition("blocked", "executing"), "executing");
  assert.equal(
    assertWorkOrderTransition("executing", "waiting-for-quota"),
    "waiting-for-quota",
  );
  assert.equal(
    assertWorkOrderTransition("waiting-for-quota", "executing"),
    "executing",
  );
});

test("illegal transitions are rejected with the current and requested states", () => {
  assert.throws(
    () => assertWorkOrderTransition("executing", "integrated"),
    (error) =>
      error instanceof WorkOrderTransitionError &&
      error.from === "executing" &&
      error.to === "integrated" &&
      error.message.includes("delivered"),
  );
  assert.throws(
    () => assertWorkOrderTransition("integrated", "executing"),
    WorkOrderTransitionError,
  );
});
