import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchCreateProjectController,
  type WorkbenchCreateProjectControllerOptions,
} from "../../src/workbench-shell/create-project-controller.ts";
import type { WorkbenchProjectSelectionResult } from "../../src/workbench-shell/contract.ts";
import type { WorkbenchCreateProjectStateStore } from "../../src/workbench-shell/create-project-store.ts";
import {
  createEmptyWorkbenchCreateProjectState,
  createWorkbenchCreateProjectTargetToken,
  transitionWorkbenchCreateProject,
  type WorkbenchCreateProjectCreateResult,
  type WorkbenchCreateProjectState,
  type WorkbenchCreateProjectTransitionEvent,
} from "../../src/workbench-shell/create-project-transition.ts";

const targetPath = "C:\\owned-test-root\\New Project";

test("controller durably orders ready, claim, normalized result, and completion around one effect each", async () => {
  const harness = createHarness();
  const controller = await createWorkbenchCreateProjectController(harness.options);

  const result = await controller.createProject();

  assert.deepEqual(result, { outcome: "created" });
  assert.deepEqual(Object.keys(result), ["outcome"]);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(harness.counts(), {
    chooser: 1,
    create: 1,
    register: 1,
    writes: 8,
  });
  assert.deepEqual(harness.store.phases, [
    "chooser-ready",
    "chooser-claimed",
    "create-ready",
    "create-claimed",
    "register-ready",
    "register-claimed",
    "response-ready",
    "completed",
  ]);
  assert.equal(harness.store.state.active, null);
  assert.equal(harness.store.state.last?.outcome, "created");
  assert.equal(harness.store.state.last?.createCommitted, true);
  assert.equal(harness.store.state.last?.registrationCommitted, true);
  assert.equal("targetPath" in (harness.store.state.last ?? {}), false);
});

test("three positive create/register/select replays produce byte-identical sanitized summaries", async () => {
  const summaries: string[] = [];
  for (let replay = 0; replay < 3; replay += 1) {
    const harness = createHarness();
    const controller = await createWorkbenchCreateProjectController(harness.options);
    const result = await controller.createProject();
    summaries.push(JSON.stringify({
      outcome: result.outcome,
      counts: harness.counts(),
      phases: harness.store.phases,
      revision: harness.store.state.revision,
      active: harness.store.state.active === null,
      last: {
        outcome: harness.store.state.last?.outcome,
        createCommitted: harness.store.state.last?.createCommitted,
        registrationCommitted: harness.store.state.last?.registrationCommitted,
      },
      recoveryCount: harness.store.state.recoveryTargets.length,
    }));
  }
  assert.equal(new Set(summaries).size, 1);
  assert.equal(summaries[0]?.includes("owned-test-root"), false);
  assert.equal(summaries[0]?.includes("candidate-"), false);
});

test("controller decodes only exact native cancellation or one absolute candidate", async () => {
  const symbolExtra = Symbol("extra");
  const cases: readonly [unknown, "cancelled" | "unavailable"][] = [
    [{ canceled: true, filePath: "" }, "cancelled"],
    [{ canceled: true, filePath: targetPath }, "unavailable"],
    [{ canceled: false, filePath: "" }, "unavailable"],
    [{ canceled: false, filePath: "relative" }, "unavailable"],
    [{ canceled: false, filePath: "\\\\server\\share\\New Project" }, "unavailable"],
    [{ canceled: false, filePath: "\\\\?\\C:\\owned-test-root\\New Project" }, "unavailable"],
    [{ canceled: false, filePath: `${targetPath}\nprivate` }, "unavailable"],
    [{ canceled: false, filePath: targetPath, extra: true }, "unavailable"],
    [
      Object.assign(
        { canceled: false, filePath: targetPath },
        { [symbolExtra]: true },
      ),
      "unavailable",
    ],
    [Object.defineProperty({ canceled: false }, "filePath", {
      enumerable: true,
      get() { throw new Error("PRIVATE_ACCESSOR"); },
    }), "unavailable"],
  ];
  for (const [nativeResult, expected] of cases) {
    const harness = createHarness({ nativeResult });
    const controller = await createWorkbenchCreateProjectController(harness.options);
    assert.deepEqual(await controller.createProject(), { outcome: expected });
    assert.deepEqual(harness.counts(), {
      chooser: 1,
      create: 0,
      register: 0,
      writes: 4,
    });
    assert.equal(JSON.stringify(harness.store.state).includes(targetPath), false);
  }
});

test("symbol-keyed Host fields are treated as an unknown commit and require recovery", async () => {
  const symbolExtra = Symbol("extra");
  const registrationPromise = Promise.resolve(Object.assign(
    {
      ok: true as const,
      status: "selected" as const,
      message: "Project was opened." as const,
    },
    { [symbolExtra]: true },
  ));
  const harness = createHarness({ registrationPromise });
  const controller = await createWorkbenchCreateProjectController(harness.options);

  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.equal(harness.registerCalls, 1);
  assert.equal(harness.store.state.last?.registrationResult, "unknown");
  assert.equal(harness.store.state.recoveryTargets.length, 1);
});

test("a sole existing ledger is still a committed Create registration", async () => {
  const harness = createHarness({
    registrationPromise: Promise.resolve({
      ok: true,
      status: "selected",
      message: "Project was opened with its existing conversation history.",
    }),
  });
  const controller = await createWorkbenchCreateProjectController(harness.options);

  assert.deepEqual(await controller.createProject(), { outcome: "created" });
  assert.equal(harness.registerCalls, 1);
  assert.equal(harness.store.state.last?.registrationResult, "committed");
  assert.equal(harness.store.state.last?.registrationCommitted, true);
});

test("known no-create commits are unavailable while unknown create and every failed registration recover without retry", async () => {
  const noCommitResults: WorkbenchCreateProjectCreateResult[] = [
    "collision-file",
    "collision-directory",
    "collision-alias",
    "collision-reparse",
    "target-appeared",
    "parent-directory-missing",
    "parent-is-file",
    "parent-is-alias",
    "parent-is-reparse",
    "parent-unavailable",
    "create-denied",
    "create-failed-known-no-commit",
  ];
  for (const createResult of noCommitResults) {
    const harness = createHarness({ createResult });
    const controller = await createWorkbenchCreateProjectController(harness.options);
    assert.deepEqual(await controller.createProject(), { outcome: "unavailable" });
    assert.deepEqual(harness.counts(), {
      chooser: 1,
      create: 1,
      register: 0,
      writes: 6,
    });
  }

  const unknownCreate = createHarness({ createResult: "unknown" });
  const unknownCreateController = await createWorkbenchCreateProjectController(
    unknownCreate.options,
  );
  assert.deepEqual(await unknownCreateController.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.equal(unknownCreate.registerCalls, 0);
  assert.equal(unknownCreate.store.state.recoveryTargets.length, 1);

  for (const registrationMode of [
    "known-unavailable",
    "known-rejected",
    "ambiguous",
    "throw",
  ] as const) {
    const harness = createHarness({ registrationMode });
    const controller = await createWorkbenchCreateProjectController(harness.options);
    assert.deepEqual(await controller.createProject(), {
      outcome: "created-recovery-required",
    });
    assert.deepEqual(harness.counts(), {
      chooser: 1,
      create: 1,
      register: 1,
      writes: 8,
    });
    assert.equal(harness.store.state.last?.registrationCommitted, false);
    assert.equal(
      harness.store.state.last?.registrationResult,
      registrationMode === "known-unavailable"
        ? "unavailable-known-no-commit"
        : registrationMode === "known-rejected"
          ? "rejected-known-no-commit"
          : "unknown",
    );
    assert.equal(harness.store.state.recoveryTargets.length, 1);
  }
});

test("controller hands each known Create failure and selected path to IPC only in memory", async () => {
  for (const createResult of [
    "collision-directory",
    "parent-directory-missing",
    "parent-is-file",
    "create-denied",
  ] as const) {
    const harness = createHarness({ createResult });
    const controller = await createWorkbenchCreateProjectController(harness.options);
    const result = await controller.createProject();

    assert.deepEqual(result, { outcome: "unavailable" });
    assert.deepEqual(result.diagnostic, { reason: createResult, targetPath });
    assert.equal(
      Object.getOwnPropertyDescriptor(result, "diagnostic")?.enumerable,
      false,
    );
    assert.equal(JSON.stringify(result).includes(targetPath), false);
    assert.equal(JSON.stringify(harness.store.state).includes(targetPath), false);
  }
});

test("a failed completion write never downgrades a durable recovery-required response", async () => {
  const harness = createHarness({
    createResult: "unknown",
    failWritePhase: "completed",
  });
  const controller = await createWorkbenchCreateProjectController(harness.options);

  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.equal(harness.store.state.active?.phase, "response-ready");
  assert.equal(
    harness.store.state.active?.outcome,
    "created-recovery-required",
  );
  assert.deepEqual(harness.counts(), {
    chooser: 1,
    create: 1,
    register: 0,
    writes: 5,
  });
});

test("a failed registration-claim write after create commit fail-closes as recovery without Host retry", async () => {
  const harness = createHarness({ failWritePhase: "register-claimed" });
  const controller = await createWorkbenchCreateProjectController(harness.options);

  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.equal(harness.store.state.active?.phase, "register-ready");
  assert.equal(harness.store.state.active?.createCommitted, true);
  assert.equal(harness.registerCalls, 0);

  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.equal(harness.registerCalls, 0);
});

test("a failed restart reconciliation of a claimed create reports recovery without effects", async () => {
  const harness = createHarness({
    state: stateAtPhase("create-claimed"),
    failWritePhase: "response-ready",
  });
  const controller = await createWorkbenchCreateProjectController(harness.options);

  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.deepEqual(harness.counts(), {
    chooser: 0,
    create: 0,
    register: 0,
    writes: 0,
  });
});

test("restart authority exhaustion after a claimed create fail-closes as recovery", async () => {
  for (const exhaustedState of [
    {
      ...stateAtPhase("create-claimed"),
      revision: 2_147_483_647,
    },
    {
      ...atRecoveryCapacity(stateAtPhase("create-claimed")),
    },
  ]) {
    const harness = createHarness({ state: exhaustedState });
    const controller = await createWorkbenchCreateProjectController(
      harness.options,
    );

    assert.deepEqual(await controller.createProject(), {
      outcome: "created-recovery-required",
    });
    assert.deepEqual(harness.counts(), {
      chooser: 0,
      create: 0,
      register: 0,
      writes: 0,
    });
  }
});

test("a recovery-correlated target never retries create or Host registration", async () => {
  const harness = createHarness({ registrationMode: "known-unavailable" });
  const controller = await createWorkbenchCreateProjectController(harness.options);

  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  const afterFirst = harness.counts();
  assert.deepEqual(await controller.createProject(), {
    outcome: "created-recovery-required",
  });
  assert.deepEqual(harness.counts(), {
    chooser: 2,
    create: afterFirst.create,
    register: afterFirst.register,
    writes: afterFirst.writes + 4,
  });
  assert.equal(harness.store.state.recoveryTargets.length, 1);
});

test("restart resumes only an unclaimed chooser and never repeats a path-dependent effect", async () => {
  const phases = [
    "chooser-ready",
    "chooser-claimed",
    "create-ready",
    "create-claimed",
    "register-ready",
    "register-claimed",
    "response-ready",
  ] as const;
  for (const phase of phases) {
    const state = stateAtPhase(phase);
    const harness = createHarness({ state });
    const controller = await createWorkbenchCreateProjectController(harness.options);
    const result = await controller.createProject();
    const resumable = phase === "chooser-ready";
    assert.equal(
      result.outcome,
      resumable
        ? "created"
        : phase === "chooser-claimed"
          ? "unavailable"
          : phase === "create-ready"
            ? "unavailable"
          : phase === "response-ready"
            ? "created"
            : "created-recovery-required",
      phase,
    );
    assert.equal(harness.chooserCalls, phase === "chooser-ready" ? 1 : 0, phase);
    assert.equal(
      harness.createCalls,
      phase === "chooser-ready" ? 1 : 0,
      phase,
    );
    assert.equal(
      harness.registerCalls,
      phase === "chooser-ready" ? 1 : 0,
      phase,
    );
  }
});

test("duplicate intent is unavailable and close settles pending chooser before ignoring its late value", async () => {
  const deferred = createDeferred<unknown>();
  const harness = createHarness({ chooserPromise: deferred.promise });
  const controller = await createWorkbenchCreateProjectController(harness.options);
  const first = controller.createProject();
  await waitUntil(() => harness.chooserCalls === 1);

  assert.deepEqual(await controller.createProject(), { outcome: "unavailable" });
  await controller.close();
  assert.deepEqual(await first, { outcome: "unavailable" });

  deferred.resolve({ canceled: false, filePath: targetPath });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.counts(), {
    chooser: 1,
    create: 0,
    register: 0,
    writes: 3,
  });
  assert.equal(harness.store.state.lifecycle, "closed");
  assert.equal(harness.store.state.active, null);
  assert.deepEqual(await controller.createProject(), { outcome: "unavailable" });
});

test("close during an ambiguous claimed create returns recovery and late creation never registers", async () => {
  const deferred = createDeferred<WorkbenchCreateProjectCreateResult>();
  const harness = createHarness({ createPromise: deferred.promise });
  const controller = await createWorkbenchCreateProjectController(harness.options);
  const pending = controller.createProject();
  await waitUntil(() => harness.createCalls === 1);
  assert.equal(JSON.stringify(harness.store.state).includes(targetPath), false);

  await controller.close();
  assert.deepEqual(await pending, { outcome: "created-recovery-required" });
  deferred.resolve("created");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registerCalls, 0);
  assert.equal(harness.store.state.lifecycle, "closed");
  assert.equal(harness.store.state.last?.outcome, "created-recovery-required");
});

test("close racing the normalized create-result write settles from close authority", async () => {
  const writeStarted = createDeferred<void>();
  const releaseWrite = createDeferred<void>();
  const stateStore = new QueuedBlockingStore(
    createEmptyWorkbenchCreateProjectState(),
    "register-ready",
    writeStarted,
    releaseWrite.promise,
  );
  const harness = createHarness();
  const controller = await createWorkbenchCreateProjectController({
    ...harness.options,
    stateStore,
  });
  const pending = controller.createProject();
  await writeStarted.promise;

  const closing = controller.close();
  releaseWrite.resolve();
  await closing;

  assert.deepEqual(await pending, {
    outcome: "created-recovery-required",
  });
  assert.equal(harness.registerCalls, 0);
  assert.equal(stateStore.state.lifecycle, "closed");
  assert.equal(stateStore.state.active, null);
  assert.equal(stateStore.state.last?.outcome, "created-recovery-required");

  const restartedHarness = createHarness({ state: stateStore.state });
  const restarted = await createWorkbenchCreateProjectController(
    restartedHarness.options,
  );
  assert.deepEqual(restartedHarness.counts(), {
    chooser: 0,
    create: 0,
    register: 0,
    writes: 1,
  });
  assert.equal(restartedHarness.store.state.active, null);
  await restarted.close();
});

test("close rebases over queued committed-registration and cancellation results without replay", async () => {
  for (const mode of ["created", "cancelled"] as const) {
    const writeStarted = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    const stateStore = new QueuedBlockingStore(
      createEmptyWorkbenchCreateProjectState(),
      "response-ready",
      writeStarted,
      releaseWrite.promise,
    );
    const harness = createHarness({
      ...(mode === "cancelled"
        ? { nativeResult: { canceled: true, filePath: "" } }
        : {}),
    });
    const controller = await createWorkbenchCreateProjectController({
      ...harness.options,
      stateStore,
    });
    const pending = controller.createProject();
    await writeStarted.promise;
    assert.equal(
      stateStore.state.active?.phase,
      mode === "created" ? "register-claimed" : "chooser-claimed",
    );

    const closing = controller.close();
    releaseWrite.resolve();
    await closing;
    assert.deepEqual(await pending, {
      outcome:
        mode === "created" ? "created-recovery-required" : "unavailable",
    });
    assert.equal(stateStore.state.lifecycle, "closed");
    assert.equal(stateStore.state.active, null);
    assert.equal(
      stateStore.state.last?.outcome,
      mode === "created" ? "created" : "cancelled",
    );

    const restartedHarness = createHarness({ state: stateStore.state });
    const restarted = await createWorkbenchCreateProjectController(
      restartedHarness.options,
    );
    assert.deepEqual(restartedHarness.counts(), {
      chooser: 0,
      create: 0,
      register: 0,
      writes: 1,
    });
    assert.equal(restartedHarness.store.state.active, null);
    await restarted.close();
  }
});

test("a close-write failure still settles claimed create as recovery-required", async () => {
  const deferred = createDeferred<WorkbenchCreateProjectCreateResult>();
  const harness = createHarness({
    createPromise: deferred.promise,
    failWritePhase: "completed",
  });
  const controller = await createWorkbenchCreateProjectController(harness.options);
  const pending = controller.createProject();
  await waitUntil(() => harness.createCalls === 1);

  await controller.close();
  assert.deepEqual(await pending, { outcome: "created-recovery-required" });
  assert.equal(harness.store.state.active?.phase, "create-claimed");
  deferred.resolve("created");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registerCalls, 0);
});

test("close at recovery capacity still settles a live claimed create as recovery", async () => {
  const deferred = createDeferred<WorkbenchCreateProjectCreateResult>();
  const harness = createHarness({
    state: {
      ...atRecoveryCapacity(stateAtPhase("chooser-ready")),
    },
    createPromise: deferred.promise,
  });
  const controller = await createWorkbenchCreateProjectController(
    harness.options,
  );
  const pending = controller.createProject();
  await waitUntil(() => harness.createCalls === 1);

  await controller.close();
  assert.deepEqual(await pending, {
    outcome: "created-recovery-required",
  });
  deferred.resolve("created");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registerCalls, 0);
});

test("close during claimed registration returns recovery and ignores one late Host commit", async () => {
  const deferred = createDeferred<WorkbenchProjectSelectionResult>();
  const harness = createHarness({ registrationPromise: deferred.promise });
  const controller = await createWorkbenchCreateProjectController(harness.options);
  const pending = controller.createProject();
  await waitUntil(() => harness.registerCalls === 1);

  await controller.close();
  assert.deepEqual(await pending, { outcome: "created-recovery-required" });
  deferred.resolve({
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.registerCalls, 1);
  assert.equal(harness.store.state.lifecycle, "closed");
  assert.equal(harness.store.state.last?.outcome, "created-recovery-required");
  assert.equal(harness.store.state.last?.registrationCommitted, false);
});

test("a new controller instance reopens a cleanly closed sidecar and can create", async () => {
  const firstHarness = createHarness();
  const first = await createWorkbenchCreateProjectController(firstHarness.options);
  await first.close();
  assert.equal(firstHarness.store.state.lifecycle, "closed");

  const restartedHarness = createHarness({ state: firstHarness.store.state });
  const restarted = await createWorkbenchCreateProjectController(
    restartedHarness.options,
  );
  assert.equal(restartedHarness.store.state.lifecycle, "open");
  assert.deepEqual(await restarted.createProject(), { outcome: "created" });
  assert.deepEqual(restartedHarness.counts(), {
    chooser: 1,
    create: 1,
    register: 1,
    writes: 9,
  });
});

class FakeStore implements WorkbenchCreateProjectStateStore {
  state: WorkbenchCreateProjectState;
  readonly phases: string[] = [];
  closed = false;
  private readonly failWritePhase: string | undefined;

  constructor(
    state: WorkbenchCreateProjectState,
    failWritePhase?: string,
  ) {
    this.state = state;
    this.failWritePhase = failWritePhase;
  }

  async write(next: WorkbenchCreateProjectState): Promise<boolean> {
    if (this.closed) return false;
    const phase = next.active?.phase ?? next.last?.phase ?? "empty";
    if (phase === this.failWritePhase) return false;
    this.state = next;
    this.phases.push(phase);
    return true;
  }

  async close(): Promise<void> { this.closed = true; }
}

class QueuedBlockingStore implements WorkbenchCreateProjectStateStore {
  state: WorkbenchCreateProjectState;
  private queue = Promise.resolve();
  private closed = false;
  private readonly blockedPhase: string;
  private readonly writeStarted: ReturnType<typeof createDeferred<void>>;
  private readonly releaseWrite: Promise<void>;

  constructor(
    state: WorkbenchCreateProjectState,
    blockedPhase: string,
    writeStarted: ReturnType<typeof createDeferred<void>>,
    releaseWrite: Promise<void>,
  ) {
    this.state = state;
    this.blockedPhase = blockedPhase;
    this.writeStarted = writeStarted;
    this.releaseWrite = releaseWrite;
  }

  write(next: WorkbenchCreateProjectState): Promise<boolean> {
    const expected = this.state;
    const run = async () => {
      const phase = next.active?.phase ?? next.last?.phase ?? "empty";
      if (phase === this.blockedPhase) {
        this.writeStarted.resolve();
        await this.releaseWrite;
      }
      if (this.closed || this.state !== expected) return false;
      this.state = next;
      return true;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
  }
}

function createHarness(options: {
  readonly state?: WorkbenchCreateProjectState;
  readonly nativeResult?: unknown;
  readonly chooserPromise?: Promise<unknown>;
  readonly createResult?: WorkbenchCreateProjectCreateResult;
  readonly createPromise?: Promise<WorkbenchCreateProjectCreateResult>;
  readonly registrationMode?:
    | "success"
    | "known-unavailable"
    | "known-rejected"
    | "ambiguous"
    | "throw";
  readonly registrationPromise?: Promise<WorkbenchProjectSelectionResult>;
  readonly failWritePhase?: string;
} = {}) {
  const store = new FakeStore(
    options.state ?? createEmptyWorkbenchCreateProjectState(),
    options.failWritePhase,
  );
  const harness = {
    chooserCalls: 0,
    createCalls: 0,
    registerCalls: 0,
    store,
    options: undefined as unknown as WorkbenchCreateProjectControllerOptions,
    counts() {
      return {
        chooser: this.chooserCalls,
        create: this.createCalls,
        register: this.registerCalls,
        writes: store.phases.length,
      };
    },
  };
  harness.options = {
    stateStore: store,
    chooser: {
      async chooseProjectTarget() {
        harness.chooserCalls += 1;
        return options.chooserPromise ?? options.nativeResult ?? {
          canceled: false,
          filePath: targetPath,
        };
      },
    },
    filesystem: {
      async createIfAbsent() {
        harness.createCalls += 1;
        return options.createPromise ?? options.createResult ?? "created";
      },
    },
    host: {
      async registerTrustedProject() {
        harness.registerCalls += 1;
        if (options.registrationPromise !== undefined) {
          return options.registrationPromise;
        }
        if (options.registrationMode === "throw") {
          throw new Error("PRIVATE_AMBIGUOUS_HOST_FAILURE");
        }
        if (options.registrationMode === "known-unavailable") {
          return {
            ok: false as const,
            error: {
              category: "project-unavailable" as const,
              message:
                "This Project is unavailable. Choose another Project or restore its directory." as const,
            },
          };
        }
        if (options.registrationMode === "known-rejected") {
          return {
            ok: false as const,
            error: {
              category: "invalid-project-selection" as const,
              message:
                "Reload the Project list and choose an available Project." as const,
            },
          };
        }
        if (options.registrationMode === "ambiguous") {
          return {
            ok: false as const,
            error: {
              category: "project-switch-unavailable" as const,
              message:
                "The Project could not be opened. Keep the current Project and try again." as const,
            },
          };
        }
        return {
          ok: true as const,
          status: "selected" as const,
          message: "Project was opened." as const,
        };
      },
    },
  };
  return harness;
}

function stateAtPhase(
  wanted: "chooser-ready" | "chooser-claimed" | "create-ready" | "create-claimed" | "register-ready" | "register-claimed" | "response-ready",
): WorkbenchCreateProjectState {
  let state = createEmptyWorkbenchCreateProjectState();
  const events: WorkbenchCreateProjectTransitionEvent[] = [
    { kind: "renderer-create-intent" },
    { kind: "claim-effect", operationNumber: 1, effectKind: "choose-save-target" },
    {
      kind: "chooser-result",
      operationNumber: 1,
      result: "selected",
      targetToken: createWorkbenchCreateProjectTargetToken(targetPath),
    },
    { kind: "claim-effect", operationNumber: 1, effectKind: "create-if-absent" },
    { kind: "create-result", operationNumber: 1, result: "created" },
    { kind: "claim-effect", operationNumber: 1, effectKind: "register-trusted-project" },
    { kind: "registration-result", operationNumber: 1, result: "committed" },
  ];
  for (const event of events) {
    const result = transitionWorkbenchCreateProject(state, event);
    assert.equal(result.applied, true);
    state = result.state;
    if (state.active?.phase === wanted) return state;
  }
  assert.fail(`Unable to produce ${wanted}.`);
}

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

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for deterministic effect.");
}
