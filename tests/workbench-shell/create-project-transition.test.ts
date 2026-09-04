import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyWorkbenchCreateProjectState,
  createWorkbenchCreateProjectTargetToken,
  transitionWorkbenchCreateProject,
  validateWorkbenchCreateProjectState,
  type WorkbenchCreateProjectState,
  type WorkbenchCreateProjectTransitionEvent,
} from "../../src/workbench-shell/create-project-transition.ts";

const targetPath = "C:\\owned-test-root\\New Project";
const targetToken = createWorkbenchCreateProjectTargetToken(targetPath);

test("accepted authority persists ready/claimed/result phases before each ordered effect", () => {
  let state = createEmptyWorkbenchCreateProjectState();
  const trace: Array<{
    readonly phase: string | null;
    readonly effect: string | null;
    readonly outcome: string | null;
  }> = [];

  const apply = (event: WorkbenchCreateProjectTransitionEvent) => {
    const result = transitionWorkbenchCreateProject(state, event);
    assert.equal(result.applied, true, result.code);
    state = result.state;
    trace.push({
      phase: state.active?.phase ?? null,
      effect: result.effects[0]?.kind ?? null,
      outcome: result.publicResults[0]?.outcome ?? null,
    });
    assert.equal(validateWorkbenchCreateProjectState(state), true);
    return result;
  };

  apply({ kind: "renderer-create-intent" });
  apply({
    kind: "claim-effect",
    operationNumber: 1,
    effectKind: "choose-save-target",
  });
  apply({
    kind: "chooser-result",
    operationNumber: 1,
    result: "selected",
    targetPath,
    targetToken,
  });
  apply({
    kind: "claim-effect",
    operationNumber: 1,
    effectKind: "create-if-absent",
  });
  apply({ kind: "create-result", operationNumber: 1, result: "created" });
  apply({
    kind: "claim-effect",
    operationNumber: 1,
    effectKind: "register-trusted-project",
  });
  apply({
    kind: "registration-result",
    operationNumber: 1,
    result: "committed",
  });
  assert.equal(state.active?.targetPath, null);
  const delivered = apply({ kind: "deliver-result", operationNumber: 1 });

  assert.deepEqual(trace, [
    { phase: "chooser-ready", effect: null, outcome: null },
    { phase: "chooser-claimed", effect: "choose-save-target", outcome: null },
    { phase: "create-ready", effect: null, outcome: null },
    { phase: "create-claimed", effect: "create-if-absent", outcome: null },
    { phase: "register-ready", effect: null, outcome: null },
    { phase: "register-claimed", effect: "register-trusted-project", outcome: null },
    { phase: "response-ready", effect: null, outcome: null },
    { phase: null, effect: null, outcome: "created" },
  ]);
  assert.deepEqual(delivered.publicResults, [{ outcome: "created" }]);
  assert.equal(state.active, null);
  assert.equal("targetPath" in (state.last ?? {}), false);
  assert.deepEqual(
    {
      createCommitted: state.last?.createCommitted,
      registrationCommitted: state.last?.registrationCommitted,
      outcome: state.last?.outcome,
    },
    {
      createCommitted: true,
      registrationCommitted: true,
      outcome: "created",
    },
  );
});

test("the exact false-commit forged-created canary is inert and byte preserving", () => {
  const forged = {
    schemaVersion: 1,
    revision: 20,
    lifecycle: "open",
    nextOperationNumber: 2,
    active: null,
    last: {
      operationNumber: 1,
      phase: "completed",
      targetToken,
      chooserResult: "selected",
      createResult: "created",
      registrationResult: "committed",
      createCommitted: false,
      registrationCommitted: false,
      outcome: "created",
    },
    recoveryTargets: [],
  } as unknown as WorkbenchCreateProjectState;
  const before = JSON.stringify(forged);

  assert.equal(validateWorkbenchCreateProjectState(forged), false);
  const result = transitionWorkbenchCreateProject(forged, {
    kind: "deliver-result",
    operationNumber: 1,
  });

  assert.equal(result.applied, false);
  assert.equal(result.code, "state-invalid");
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.publicResults, []);
  assert.equal(JSON.stringify(result.state), before);
  assert.equal(JSON.stringify(forged), before);
});

test("a non-generator target token cannot replay an otherwise committed created record", () => {
  const forged = {
    schemaVersion: 1,
    revision: 20,
    lifecycle: "open",
    nextOperationNumber: 2,
    active: null,
    last: {
      operationNumber: 1,
      phase: "completed",
      targetToken: "candidate-primary",
      chooserResult: "selected",
      createResult: "created",
      registrationResult: "committed",
      createCommitted: true,
      registrationCommitted: true,
      outcome: "created",
    },
    recoveryTargets: [],
  };
  const before = JSON.stringify(forged);
  const result = transitionWorkbenchCreateProject(forged, {
    kind: "deliver-result",
    operationNumber: 1,
  });

  assert.equal(result.applied, false);
  assert.equal(result.code, "state-invalid");
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.publicResults, []);
  assert.equal(JSON.stringify(result.state), before);
});

test("malformed exact-shape, ordering, phase, and recovery relations are inert", () => {
  const valid = createEmptyWorkbenchCreateProjectState();
  const symbolExtra = Symbol("extra");
  const malformed: unknown[] = [
    { ...valid, extra: true },
    Object.assign({ ...valid }, { [symbolExtra]: true }),
    { ...valid, schemaVersion: 1.0 + Number.EPSILON },
    { ...valid, revision: -1 },
    { ...valid, nextOperationNumber: 2 },
    { ...valid, recoveryTargets: [targetToken] },
    { ...valid, lifecycle: "closed", active: { private: true } },
    { ...valid, recoveryTargets: [targetToken, targetToken] },
    Object.defineProperty({ ...valid }, "revision", {
      enumerable: true,
      get() { throw new Error("PRIVATE_ACCESSOR"); },
    }),
  ];

  for (const candidate of malformed) {
    let before: string | undefined;
    try { before = JSON.stringify(candidate); } catch {}
    assert.equal(validateWorkbenchCreateProjectState(candidate), false);
    const result = transitionWorkbenchCreateProject(candidate, {
      kind: "renderer-create-intent",
    });
    assert.equal(result.applied, false);
    assert.equal(result.code, "state-invalid");
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.publicResults, []);
    if (before !== undefined) assert.equal(JSON.stringify(result.state), before);
  }
});

test("symbol-keyed event fields are rejected without changing valid authority", () => {
  const state = createEmptyWorkbenchCreateProjectState();
  const before = JSON.stringify(state);
  const result = transitionWorkbenchCreateProject(
    state,
    Object.assign(
      { kind: "renderer-create-intent" },
      { [Symbol("extra")]: true },
    ),
  );

  assert.equal(result.applied, false);
  assert.equal(result.code, "public-input-invalid");
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.publicResults, [{ outcome: "unavailable" }]);
  assert.equal(JSON.stringify(result.state), before);
});

test("a new controller lifecycle reopens a cleanly closed authority without effects or history loss", () => {
  let state = createEmptyWorkbenchCreateProjectState();
  const closed = transitionWorkbenchCreateProject(state, { kind: "close" });
  assert.equal(closed.applied, true);
  state = closed.state;
  assert.equal(state.lifecycle, "closed");

  const reopened = transitionWorkbenchCreateProject(state, {
    kind: "open-controller-lifecycle",
  });

  assert.equal(reopened.applied, true);
  assert.equal(reopened.code, "lifecycle-opened");
  assert.equal(reopened.state.lifecycle, "open");
  assert.equal(reopened.state.revision, state.revision + 1);
  assert.equal(reopened.state.active, null);
  assert.deepEqual(reopened.state.last, state.last);
  assert.deepEqual(reopened.state.recoveryTargets, state.recoveryTargets);
  assert.deepEqual(reopened.effects, []);
  assert.deepEqual(reopened.publicResults, []);
  assert.equal(validateWorkbenchCreateProjectState(reopened.state), true);

  const malformed = transitionWorkbenchCreateProject(state, {
    kind: "open-controller-lifecycle",
    extra: true,
  });
  assert.equal(malformed.applied, false);
  assert.equal(malformed.code, "event-invalid");
  assert.equal(malformed.state, state);
});

test("selected active state validates the exact target path/token relation", () => {
  let state = createEmptyWorkbenchCreateProjectState();
  state = transitionWorkbenchCreateProject(state, {
    kind: "renderer-create-intent",
  }).state;
  state = transitionWorkbenchCreateProject(state, {
    kind: "claim-effect",
    operationNumber: 1,
    effectKind: "choose-save-target",
  }).state;
  state = transitionWorkbenchCreateProject(state, {
    kind: "chooser-result",
    operationNumber: 1,
    result: "selected",
    targetPath,
    targetToken,
  }).state;
  assert.equal(state.active?.phase, "create-ready");
  assert.equal(validateWorkbenchCreateProjectState(state), true);

  const forged = structuredClone(state) as unknown as {
    active: { targetToken: string };
  };
  forged.active.targetToken =
    "candidate-ffffffffffffffffffffffffffffffff";
  assert.equal(validateWorkbenchCreateProjectState(forged), false);

  const alternatePath = "C:\\owned-test-root\\.\\New Project";
  const alternate = structuredClone(state) as unknown as {
    active: { targetPath: string; targetToken: string };
  };
  alternate.active.targetPath = alternatePath;
  alternate.active.targetToken =
    createWorkbenchCreateProjectTargetToken(alternatePath);
  assert.equal(validateWorkbenchCreateProjectState(alternate), false);
  assert.equal(
    createWorkbenchCreateProjectTargetToken(alternatePath),
    targetToken,
  );

  for (const nonlocalPath of [
    "\\\\server\\share\\New Project",
    "\\\\?\\C:\\owned-test-root\\New Project",
  ]) {
    const nonlocal = structuredClone(state) as unknown as {
      active: { targetPath: string; targetToken: string };
    };
    nonlocal.active.targetPath = nonlocalPath;
    nonlocal.active.targetToken =
      createWorkbenchCreateProjectTargetToken(nonlocalPath);
    assert.equal(validateWorkbenchCreateProjectState(nonlocal), false);
  }
});

test("revision and recovery-capacity boundaries are closed under transition", () => {
  const maximum = 2_147_483_647;
  const maximumState = {
    ...createEmptyWorkbenchCreateProjectState(),
    revision: maximum,
  };
  assert.equal(validateWorkbenchCreateProjectState(maximumState), true);
  const exhausted = transitionWorkbenchCreateProject(maximumState, {
    kind: "renderer-create-intent",
  });
  assert.equal(exhausted.applied, false);
  assert.equal(exhausted.code, "revision-exhausted");
  assert.deepEqual(exhausted.publicResults, [{ outcome: "unavailable" }]);
  assert.equal(exhausted.state, maximumState);

  const penultimate = {
    ...createEmptyWorkbenchCreateProjectState(),
    revision: maximum - 1,
  };
  const closed = transitionWorkbenchCreateProject(penultimate, {
    kind: "close",
  });
  assert.equal(closed.applied, true);
  assert.equal(closed.state.revision, maximum);
  assert.equal(validateWorkbenchCreateProjectState(closed.state), true);

  let claimed = createEmptyWorkbenchCreateProjectState();
  for (const event of [
    { kind: "renderer-create-intent" },
    {
      kind: "claim-effect",
      operationNumber: 1,
      effectKind: "choose-save-target",
    },
    {
      kind: "chooser-result",
      operationNumber: 1,
      result: "selected",
      targetPath,
      targetToken,
    },
    {
      kind: "claim-effect",
      operationNumber: 1,
      effectKind: "create-if-absent",
    },
  ] as WorkbenchCreateProjectTransitionEvent[]) {
    claimed = transitionWorkbenchCreateProject(claimed, event).state;
  }
  const capacityState = atRecoveryCapacity(claimed);
  assert.equal(validateWorkbenchCreateProjectState(capacityState), true);
  const atCapacity = transitionWorkbenchCreateProject(capacityState, {
    kind: "create-result",
    operationNumber: 1_025,
    result: "unknown",
  });
  assert.equal(atCapacity.applied, false);
  assert.equal(atCapacity.code, "recovery-capacity-exhausted");
  assert.equal(atCapacity.state, capacityState);
  assert.equal(validateWorkbenchCreateProjectState(atCapacity.state), true);
});

function atRecoveryCapacity(
  state: WorkbenchCreateProjectState,
): WorkbenchCreateProjectState {
  assert.notEqual(state.active, null);
  return {
    ...state,
    nextOperationNumber: 1_026,
    active: {
      ...state.active!,
      operationNumber: 1_025,
    },
    last: {
      operationNumber: 1_024,
      phase: "completed",
      targetToken: null,
      chooserResult: "cancelled",
      createResult: null,
      registrationResult: null,
      createCommitted: false,
      registrationCommitted: false,
      outcome: "cancelled",
    },
    recoveryTargets: Array.from(
      { length: 1_024 },
      (_, index) => `candidate-${index.toString(16).padStart(32, "0")}`,
    ),
  };
}

test("unreachable selected unavailable response state is rejected", () => {
  let state = createEmptyWorkbenchCreateProjectState();
  for (const event of [
    { kind: "renderer-create-intent" },
    {
      kind: "claim-effect",
      operationNumber: 1,
      effectKind: "choose-save-target",
    },
    {
      kind: "chooser-result",
      operationNumber: 1,
      result: "selected",
      targetPath,
      targetToken,
    },
  ] as WorkbenchCreateProjectTransitionEvent[]) {
    state = transitionWorkbenchCreateProject(state, event).state;
  }
  const forged = structuredClone(state) as WorkbenchCreateProjectState & {
    active: NonNullable<WorkbenchCreateProjectState["active"]>;
  };
  Object.assign(forged.active, {
    phase: "response-ready",
    targetPath: null,
    outcome: "unavailable",
  });
  assert.equal(validateWorkbenchCreateProjectState(forged), false);
});
