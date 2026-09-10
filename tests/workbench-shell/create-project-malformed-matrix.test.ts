import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchCreateProjectTargetToken,
  transitionWorkbenchCreateProject,
} from "../../src/workbench-shell/create-project-transition.ts";

const activeTargetPath = "C:\\owned-test-root\\New Project";
const activeTargetToken = createWorkbenchCreateProjectTargetToken(
  activeTargetPath,
);

type Boundary = "deliver-result" | "restart" | "close";
type Category =
  | "last-shape-type"
  | "operation-order"
  | "terminal-relation"
  | "active-phase"
  | "closed-state"
  | "recovery-relation"
  | "boundary-state";
type Mutable = Record<string, any>;
type Spec = {
  readonly name: string;
  readonly category: Category;
  readonly boundary: Boundary;
  readonly state: Mutable;
  readonly canary: boolean;
};

test("the accepted 81-case malformed authority matrix is inert across replay, restart, and close", () => {
  const specs = malformedSpecs();
  assert.equal(specs.length, 81);
  assert.deepEqual(countBy(specs, "category"), {
    "last-shape-type": 17,
    "operation-order": 12,
    "terminal-relation": 20,
    "active-phase": 14,
    "closed-state": 4,
    "recovery-relation": 8,
    "boundary-state": 6,
  });
  assert.deepEqual(countBy(specs, "boundary"), {
    "deliver-result": 28,
    restart: 26,
    close: 27,
  });
  assert.equal(specs.filter((spec) => spec.canary).length, 1);

  for (const spec of specs) {
    const before = JSON.stringify(spec.state);
    const event = spec.boundary === "deliver-result"
      ? { kind: "deliver-result", operationNumber: 1 }
      : { kind: spec.boundary };
    const result = transitionWorkbenchCreateProject(spec.state, event);

    assert.equal(result.code, "state-invalid", spec.name);
    assert.equal(result.applied, false, spec.name);
    assert.deepEqual(result.effects, [], spec.name);
    assert.deepEqual(result.publicResults, [], spec.name);
    assert.equal(result.state, spec.state, spec.name);
    assert.equal(JSON.stringify(spec.state), before, spec.name);
    assert.equal(JSON.stringify(result.state), before, spec.name);
    if (spec.canary) {
      assert.equal(spec.boundary, "deliver-result");
      assert.equal(spec.state.active, null);
      assert.equal(spec.state.last.operationNumber, 1);
      assert.equal(spec.state.last.outcome, "created");
      assert.equal(spec.state.last.createCommitted, false);
      assert.equal(spec.state.last.registrationCommitted, false);
    }
  }
});

function malformedSpecs(): Spec[] {
  const specs: Spec[] = [];
  const add = (
    name: string,
    category: Category,
    boundary: Boundary,
    template: string,
    mutate: (state: Mutable) => void,
    canary = false,
  ) => {
    const state = stateTemplate(template);
    mutate(state);
    specs.push({ name, category, boundary, state, canary });
  };

  add("last-missing-phase", "last-shape-type", "deliver-result", "last-created", (s) => { delete s.last.phase; });
  add("last-missing-chooser-result", "last-shape-type", "restart", "last-created", (s) => { delete s.last.chooserResult; });
  add("last-missing-registration-commit", "last-shape-type", "close", "last-created", (s) => { delete s.last.registrationCommitted; });
  add("last-extra-field", "last-shape-type", "deliver-result", "last-created", (s) => { s.last.extraField = "forbidden"; });
  add("last-accessor-outcome", "last-shape-type", "restart", "last-created", (s) => {
    Object.defineProperty(s.last, "outcome", { enumerable: true, get: () => "created" });
  });
  add("last-operation-string", "last-shape-type", "close", "last-created", (s) => { s.last.operationNumber = "1"; });
  add("last-operation-long", "last-shape-type", "deliver-result", "last-created", (s) => { s.last.operationNumber = Number.MAX_SAFE_INTEGER + 1; });
  add("last-operation-zero", "last-shape-type", "restart", "last-created", (s) => { s.last.operationNumber = 0; });
  add("last-phase-number", "last-shape-type", "close", "last-created", (s) => { s.last.phase = 4; });
  add("last-target-number", "last-shape-type", "deliver-result", "last-created", (s) => { s.last.targetToken = 7; });
  add("last-chooser-boolean", "last-shape-type", "restart", "last-created", (s) => { s.last.chooserResult = true; });
  add("last-create-array", "last-shape-type", "close", "last-created", (s) => { s.last.createResult = ["created"]; });
  add("last-registration-number", "last-shape-type", "deliver-result", "last-created", (s) => { s.last.registrationResult = 1; });
  add("last-outcome-boolean", "last-shape-type", "restart", "last-created", (s) => { s.last.outcome = true; });
  add("last-create-commit-string", "last-shape-type", "close", "last-created", (s) => { s.last.createCommitted = "true"; });
  add("last-registration-commit-number", "last-shape-type", "deliver-result", "last-created", (s) => { s.last.registrationCommitted = 1; });
  add("last-partial-record", "last-shape-type", "close", "last-created", (s) => { s.last = { outcome: "created" }; });

  add("next-operation-string", "operation-order", "deliver-result", "last-created", (s) => { s.nextOperationNumber = "2"; });
  add("next-operation-long", "operation-order", "restart", "last-created", (s) => { s.nextOperationNumber = Number.MAX_SAFE_INTEGER + 1; });
  add("next-operation-zero", "operation-order", "close", "empty", (s) => { s.nextOperationNumber = 0; });
  add("empty-history-next-two", "operation-order", "deliver-result", "empty", (s) => { s.nextOperationNumber = 2; });
  add("last-history-gap", "operation-order", "restart", "last-created", (s) => { s.nextOperationNumber = 3; });
  add("last-equals-next-operation", "operation-order", "close", "last-created", (s) => { s.last.operationNumber = 2; });
  add("active-next-gap", "operation-order", "deliver-result", "active-chooser-ready", (s) => { s.nextOperationNumber = 3; });
  add("active-without-history-starts-at-two", "operation-order", "restart", "active-chooser-ready", (s) => { s.active.operationNumber = 2; s.nextOperationNumber = 3; });
  add("active-and-last-same-operation", "operation-order", "close", "active-with-last", (s) => { s.last.operationNumber = 2; });
  add("active-and-last-operation-gap", "operation-order", "deliver-result", "active-with-last", (s) => { s.active.operationNumber = 3; s.nextOperationNumber = 4; });
  add("active-older-than-last", "operation-order", "restart", "active-with-last", (s) => { s.last.operationNumber = 2; s.active.operationNumber = 1; s.nextOperationNumber = 2; });
  add("active-history-next-gap", "operation-order", "close", "active-with-last", (s) => { s.nextOperationNumber = 4; });

  add("forged-created-without-commits-canary", "terminal-relation", "deliver-result", "last-created", (s) => { s.last.createCommitted = false; s.last.registrationCommitted = false; }, true);
  add("created-without-registration-commit", "terminal-relation", "restart", "last-created", (s) => { s.last.registrationCommitted = false; });
  add("created-registration-without-create", "terminal-relation", "close", "last-created", (s) => { s.last.createCommitted = false; });
  add("created-with-unknown-create-result", "terminal-relation", "deliver-result", "last-created", (s) => { s.last.createResult = "unknown"; });
  add("created-without-registration-result", "terminal-relation", "restart", "last-created", (s) => { s.last.registrationResult = null; });
  add("created-with-failed-chooser", "terminal-relation", "close", "last-created", (s) => { s.last.chooserResult = "failed"; });
  add("created-without-target", "terminal-relation", "deliver-result", "last-created", (s) => { s.last.targetToken = null; });
  add("cancelled-with-target", "terminal-relation", "restart", "last-cancelled", (s) => { s.last.targetToken = activeTargetToken; });
  add("cancelled-without-cancel-result", "terminal-relation", "close", "last-cancelled", (s) => { s.last.chooserResult = null; });
  add("cancelled-with-create-result", "terminal-relation", "deliver-result", "last-cancelled", (s) => { s.last.createResult = "collision-file"; });
  add("unavailable-with-create-commit", "terminal-relation", "restart", "last-unavailable-choice", (s) => { s.last.createCommitted = true; });
  add("unavailable-with-registration-commit", "terminal-relation", "close", "last-unavailable-create", (s) => { s.last.createCommitted = true; s.last.registrationCommitted = true; });
  add("unavailable-with-registration-result", "terminal-relation", "deliver-result", "last-unavailable-create", (s) => { s.last.registrationResult = "unknown"; });
  add("unavailable-with-unknown-create-result", "terminal-relation", "restart", "last-unavailable-create", (s) => { s.last.createResult = "unknown"; });
  add("unavailable-with-cancel-result", "terminal-relation", "close", "last-unavailable-choice", (s) => { s.last.chooserResult = "cancelled"; });
  add("recovery-unknown-with-create-commit", "terminal-relation", "deliver-result", "last-recovery-unknown", (s) => { s.last.createCommitted = true; });
  add("recovery-created-without-create-commit", "terminal-relation", "restart", "last-recovery-created", (s) => { s.last.createCommitted = false; });
  add("recovery-with-known-no-commit-create", "terminal-relation", "close", "last-recovery-created", (s) => { s.last.createResult = "collision-directory"; s.last.registrationResult = null; s.last.createCommitted = false; });
  add("recovery-with-registration-commit", "terminal-relation", "deliver-result", "last-recovery-created", (s) => { s.last.registrationResult = "committed"; s.last.registrationCommitted = true; });
  add("terminal-invalid-outcome", "terminal-relation", "restart", "last-created", (s) => { s.last.outcome = "forged"; });

  add("chooser-ready-with-target", "active-phase", "close", "active-chooser-ready", (s) => { s.active.targetToken = activeTargetToken; });
  add("chooser-ready-with-outcome", "active-phase", "deliver-result", "active-chooser-ready", (s) => { s.active.outcome = "unavailable"; });
  add("chooser-claimed-with-result", "active-phase", "restart", "active-chooser-claimed", (s) => { s.active.chooserResult = "failed"; });
  add("chooser-claimed-with-create-commit", "active-phase", "close", "active-chooser-claimed", (s) => { s.active.createCommitted = true; });
  add("create-ready-with-result", "active-phase", "deliver-result", "active-create-ready", (s) => { s.active.createResult = "created"; });
  add("create-ready-recovery-target", "active-phase", "restart", "active-create-ready", (s) => { s.recoveryTargets = [activeTargetToken]; });
  add("create-claimed-with-create-commit", "active-phase", "close", "active-create-claimed", (s) => { s.active.createCommitted = true; });
  add("create-claimed-with-outcome", "active-phase", "deliver-result", "active-create-claimed", (s) => { s.active.outcome = "created-recovery-required"; });
  add("register-ready-without-create-commit", "active-phase", "restart", "active-register-ready", (s) => { s.active.createCommitted = false; });
  add("register-ready-with-registration-result", "active-phase", "close", "active-register-ready", (s) => { s.active.registrationResult = "unknown"; });
  add("register-claimed-with-registration-commit", "active-phase", "deliver-result", "active-register-claimed", (s) => { s.active.registrationCommitted = true; });
  add("register-claimed-with-outcome", "active-phase", "restart", "active-register-claimed", (s) => { s.active.outcome = "created"; });
  add("response-ready-without-outcome", "active-phase", "close", "active-response-created", (s) => { s.active.outcome = null; });
  add("response-created-without-commits", "active-phase", "deliver-result", "active-response-created", (s) => { s.active.createCommitted = false; s.active.registrationCommitted = false; });

  add("closed-with-chooser-operation", "closed-state", "restart", "closed-empty", (s) => { s.active = activeRecord("chooser-ready"); s.nextOperationNumber = 2; });
  add("closed-with-response-operation", "closed-state", "close", "closed-last-created", (s) => { s.active = activeRecord("response-created", 2); s.nextOperationNumber = 3; });
  add("closed-history-next-gap", "closed-state", "deliver-result", "closed-last-created", (s) => { s.nextOperationNumber = 3; });
  add("closed-last-not-completed", "closed-state", "restart", "closed-last-created", (s) => { s.last.phase = "response-ready"; });

  add("recovery-targets-scalar", "recovery-relation", "close", "empty", (s) => { s.recoveryTargets = activeTargetToken; });
  add("recovery-target-wrong-type", "recovery-relation", "deliver-result", "empty", (s) => { s.recoveryTargets = [7]; });
  add("recovery-target-duplicate", "recovery-relation", "restart", "empty", (s) => { s.recoveryTargets = [activeTargetToken, activeTargetToken]; });
  add("recovery-outcome-without-membership", "recovery-relation", "close", "last-recovery-unknown", (s) => { s.recoveryTargets = []; });
  add("created-outcome-marked-recovery", "recovery-relation", "deliver-result", "last-created", (s) => { s.recoveryTargets = [activeTargetToken]; });
  add("active-recovery-outcome-without-membership", "recovery-relation", "restart", "active-response-recovery", (s) => { s.recoveryTargets = []; });
  add("unavailable-target-marked-recovery", "recovery-relation", "close", "last-unavailable-create", (s) => { s.recoveryTargets = [activeTargetToken]; });
  add("register-target-marked-recovery", "recovery-relation", "deliver-result", "active-register-ready", (s) => { s.recoveryTargets = [activeTargetToken]; });

  add("top-schema-string-at-replay", "boundary-state", "deliver-result", "last-created", (s) => { s.schemaVersion = "1"; });
  add("top-revision-long-at-restart", "boundary-state", "restart", "active-chooser-ready", (s) => { s.revision = Number.MAX_SAFE_INTEGER + 1; });
  add("top-lifecycle-number-at-close", "boundary-state", "close", "empty", (s) => { s.lifecycle = 1; });
  add("top-extra-field-at-replay", "boundary-state", "deliver-result", "last-created", (s) => { s.extraField = "forbidden"; });
  add("top-accessor-at-restart", "boundary-state", "restart", "last-created", (s) => {
    Object.defineProperty(s, "lifecycle", { enumerable: true, get: () => "open" });
  });
  add("top-active-scalar-at-close", "boundary-state", "close", "empty", (s) => { s.active = "forged"; s.nextOperationNumber = 2; });
  return specs;
}

function stateTemplate(name: string): Mutable {
  const state: Mutable = {
    schemaVersion: 1,
    revision: 20,
    lifecycle: "open",
    nextOperationNumber: 1,
    active: null,
    last: null,
    recoveryTargets: [],
  };
  const lastVariant = name.startsWith("last-") ? name.slice(5) : null;
  if (lastVariant !== null) {
    state.last = completedRecord(lastVariant);
    state.nextOperationNumber = 2;
    if (lastVariant.startsWith("recovery-")) {
      state.recoveryTargets = [activeTargetToken];
    }
  } else if (name.startsWith("active-") && name !== "active-with-last") {
    state.active = activeRecord(name.slice(7));
    state.nextOperationNumber = 2;
    if (name === "active-response-recovery") {
      state.recoveryTargets = [activeTargetToken];
    }
  } else if (name === "active-with-last") {
    state.last = completedRecord("cancelled", 1);
    state.active = activeRecord("chooser-ready", 2);
    state.nextOperationNumber = 3;
  } else if (name === "closed-empty") {
    state.lifecycle = "closed";
  } else if (name === "closed-last-created") {
    state.lifecycle = "closed";
    state.last = completedRecord("created");
    state.nextOperationNumber = 2;
  }
  return state;
}

function completedRecord(variant: string, operationNumber = 1): Mutable {
  const record: Mutable = {
    operationNumber,
    phase: "completed",
    targetToken: null,
    chooserResult: null,
    createResult: null,
    registrationResult: null,
    createCommitted: false,
    registrationCommitted: false,
    outcome: "unavailable",
  };
  if (variant === "created") Object.assign(record, {
    targetToken: activeTargetToken, chooserResult: "selected",
    createResult: "created", registrationResult: "committed",
    createCommitted: true, registrationCommitted: true, outcome: "created",
  });
  if (variant === "cancelled") Object.assign(record, { chooserResult: "cancelled", outcome: "cancelled" });
  if (variant === "unavailable-choice") record.chooserResult = "malformed";
  if (variant === "unavailable-create") Object.assign(record, { targetToken: activeTargetToken, chooserResult: "selected", createResult: "collision-directory" });
  if (variant === "recovery-unknown") Object.assign(record, { targetToken: activeTargetToken, chooserResult: "selected", createResult: "unknown", outcome: "created-recovery-required" });
  if (variant === "recovery-created") Object.assign(record, { targetToken: activeTargetToken, chooserResult: "selected", createResult: "created", registrationResult: "rejected-known-no-commit", createCommitted: true, outcome: "created-recovery-required" });
  return record;
}

function activeRecord(variant: string, operationNumber = 1): Mutable {
  const response = variant.startsWith("response-");
  const selected = ["create-ready", "create-claimed", "register-ready", "register-claimed", "response-created", "response-recovery"].includes(variant);
  const record: Mutable = {
    operationNumber,
    phase: response ? "response-ready" : variant,
    targetToken: selected ? activeTargetToken : null,
    chooserResult: selected ? "selected" : null,
    createResult: null,
    registrationResult: null,
    createCommitted: false,
    registrationCommitted: false,
    outcome: null,
  };
  if (["register-ready", "register-claimed", "response-created"].includes(variant)) {
    record.createResult = "created";
    record.createCommitted = true;
  }
  if (variant === "response-created") Object.assign(record, { registrationResult: "committed", registrationCommitted: true, outcome: "created" });
  if (variant === "response-recovery") Object.assign(record, { createResult: "unknown", outcome: "created-recovery-required" });
  return record;
}

function countBy(specs: readonly Spec[], field: "category" | "boundary"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const spec of specs) counts[spec[field]] = (counts[spec[field]] ?? 0) + 1;
  return counts;
}
