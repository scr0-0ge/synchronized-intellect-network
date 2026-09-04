import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentRuntimeAdapter,
  type RuntimeBinding,
  type RuntimeCatalog,
  type RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createRuntimeEndpointDirectory,
  RUNTIME_NEUTRAL_WORK_ORDER_LIMITS,
  type AcceptedRuntimeWorkOrder,
  type BoundSupervisorSession,
  RuntimeEndpointDirectoryError,
  type RuntimeEndpointRegistration,
  type RuntimeNeutralWorkOrder,
} from "../../src/agent-runtime/runtime-endpoint-directory.ts";

class InMemoryEndpointAdapter implements AgentRuntimeAdapter {
  readonly effects = { inspect: 0, start: 0 };
  private readonly runtimeFamily: string;

  constructor(runtimeFamily: string) {
    this.runtimeFamily = runtimeFamily;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.effects.inspect += 1;
    return {
      runtime: this.runtimeFamily,
      models: [],
      executionModes: [],
      accessModes: [],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.effects.start += 1;
    throw new Error("The Runtime Endpoint Directory must not start an Adapter.");
  }
}

test("an accepted Work Order resolves through sanitized exact-snapshot keys without an Adapter effect", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const directory = createRuntimeEndpointDirectory([
    registration({
      registrationId: "private-local-registration",
      endpointId: "private-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "private-native-local-model",
      allowedWorkerEndpointIds: ["private-remote-endpoint"],
    }),
    registration({
      registrationId: "private-remote-registration",
      endpointId: "private-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "private-native-remote-model",
      allowedWorkerEndpointIds: ["private-local-endpoint"],
    }),
  ]);

  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const supervisorProfile = requiredProfile(supervisorEndpoint);
  const workerProfile = requiredProfile(workerEndpoint);
  const workOrder: RuntimeNeutralWorkOrder = Object.freeze({
    idempotencyKey: "work-order-positive-001",
    objective: "Return one bounded implementation Handoff.",
    input: "Exercise the Runtime-neutral authorization seam.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: workerProfile.profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: Object.freeze({ units: 10 }),
    concurrency: Object.freeze({ slots: 1 }),
  });
  const accepted: AcceptedRuntimeWorkOrder = Object.freeze({
    state: "accepted",
    workOrder,
  });
  const boundSupervisor: BoundSupervisorSession = Object.freeze({
    sessionKey: "supervisor-session-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: supervisorProfile.profileSnapshotKey,
  });

  const result = directory.authorizeAcceptedWorkOrder(
    accepted,
    boundSupervisor,
  );

  assert.equal(result.status, "authorized");
  assert.equal(result.directorySnapshotKey, snapshot.directorySnapshotKey);
  assert.equal(result.objective, workOrder.objective);
  assert.equal(result.input, workOrder.input);
  assert.equal(result.supervisor.sessionKey, boundSupervisor.sessionKey);
  assert.equal(result.supervisor.runtimeFamily, "codex");
  assert.equal(result.supervisor.executionLocation, "local");
  assert.equal(
    result.worker.endpointSnapshotKey,
    workerEndpoint.endpointSnapshotKey,
  );
  assert.equal(result.worker.profileSnapshotKey, workerProfile.profileSnapshotKey);
  assert.equal(result.worker.runtimeFamily, "open-runtime");
  assert.equal(result.worker.executionLocation, "remote-backed");
  assert.equal(result.worker.profile.modelLabel, "Shared Model");
  assert.equal(result.worker.profile.workIntensityLabel, "Maximum");
  assert.equal(result.worker.profile.executionMode, "single-agent");
  assert.equal(result.worker.profile.accessMode, "full-access");
  assert.deepEqual(result.authorization, {
    accessMode: "full-access",
    hostCapabilityCeiling: "codex-full-access",
    budgetUnits: 10,
    concurrencySlots: 1,
    endpointConcurrencyLimit: 2,
  });
  assert.equal(result.startEligibility, "eligible");
  assert.equal(result.externalEffect, "not-started");
  assert.deepEqual(Reflect.ownKeys(directory), []);
  assert.match(result.workOrderDigest, /^sha256:[a-f0-9]{64}$/u);
  assertFrozenTree(snapshot);
  assertFrozenTree(result);
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });

  const publicJson = JSON.stringify({ snapshot, result });
  for (const privateValue of [
    "private-local-registration",
    "private-remote-registration",
    "private-local-endpoint",
    "private-remote-endpoint",
    "private-native-local-model",
    "private-native-remote-model",
  ]) {
    assert.equal(publicJson.includes(privateValue), false, privateValue);
  }
  for (const privateField of ["adapter", "registrationId", "endpointId"]) {
    assert.equal(new RegExp(`\\b${privateField}\\b`, "u").test(publicJson), false);
  }
});

test("a Work Order carrying any non-contract seam field fails closed before Adapter effects", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const directory = createRuntimeEndpointDirectory([
    registration({
      registrationId: "forbidden-local-registration",
      endpointId: "forbidden-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "forbidden-native-local-model",
      allowedWorkerEndpointIds: ["forbidden-remote-endpoint"],
    }),
    registration({
      registrationId: "forbidden-remote-registration",
      endpointId: "forbidden-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "forbidden-native-remote-model",
      allowedWorkerEndpointIds: ["forbidden-local-endpoint"],
    }),
  ]);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const baseWorkOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-forbidden-001",
    objective: "Reject fields outside the bounded Work Order contract.",
    input: "The private canary must never cross the seam.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-forbidden-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };

  for (const forbiddenField of [
    "transport",
    "credential",
    "authentication",
    "opaqueSessionReference",
    "nativeSession",
    "projectPath",
    "databaseKey",
    "rawProvider",
    "providerPayload",
    "privateReasoning",
    "endpointAddress",
    "listener",
    "tunnel",
    "peerNetwork",
    "supervisorSessionKey",
    "boundSupervisor",
  ]) {
    const unsafeWorkOrder = {
      ...baseWorkOrder,
      [forbiddenField]: `private-canary-${forbiddenField}`,
    } as unknown as RuntimeNeutralWorkOrder;
    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(
          { state: "accepted", workOrder: unsafeWorkOrder },
          boundSupervisor,
        ),
      (error: unknown) =>
        error instanceof RuntimeEndpointDirectoryError &&
        error.category === "work-order-invalid" &&
        error.message === "Runtime Endpoint Directory operation failed." &&
        error.stack ===
          "RuntimeEndpointDirectoryError: Runtime Endpoint Directory operation failed.",
      forbiddenField,
    );
  }

  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("duplicate registration identities fail closed before Adapter effects", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const local = registration({
    registrationId: "duplicate-local-registration",
    endpointId: "duplicate-local-endpoint",
    runtimeFamily: "codex",
    executionLocation: "local",
    adapter: localAdapter,
    nativeModel: "duplicate-native-local-model",
    allowedWorkerEndpointIds: ["duplicate-remote-endpoint"],
  });
  const remote = registration({
    registrationId: "duplicate-remote-registration",
    endpointId: "duplicate-remote-endpoint",
    runtimeFamily: "open-runtime",
    executionLocation: "remote-backed",
    adapter: remoteAdapter,
    nativeModel: "duplicate-native-remote-model",
    allowedWorkerEndpointIds: ["duplicate-local-endpoint"],
  });
  const localProfile = local.capabilitySnapshot.profiles[0];
  assert.ok(localProfile);

  const duplicateCases: readonly (readonly RuntimeEndpointRegistration[])[] = [
    [local, { ...remote, registrationId: local.registrationId }],
    [local, { ...remote, endpointId: local.endpointId }],
    [local, { ...remote, adapter: local.adapter }],
    [
      local,
      {
        ...remote,
        capabilitySnapshot: {
          ...remote.capabilitySnapshot,
          snapshotId: local.capabilitySnapshot.snapshotId,
        },
      },
    ],
    [
      {
        ...local,
        capabilitySnapshot: {
          ...local.capabilitySnapshot,
          profiles: [localProfile, { ...localProfile }],
        },
      },
      remote,
    ],
  ];

  for (const duplicateRegistrations of duplicateCases) {
    assert.throws(
      () => createRuntimeEndpointDirectory(duplicateRegistrations),
      fixedDirectoryError("registration-invalid"),
    );
  }
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("malformed registrations fail with one fixed category before Adapter effects", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const local = registration({
    registrationId: "malformed-local-registration",
    endpointId: "malformed-local-endpoint",
    runtimeFamily: "codex",
    executionLocation: "local",
    adapter: localAdapter,
    nativeModel: "malformed-native-local-model",
    allowedWorkerEndpointIds: ["malformed-remote-endpoint"],
  });
  const remote = registration({
    registrationId: "malformed-remote-registration",
    endpointId: "malformed-remote-endpoint",
    runtimeFamily: "open-runtime",
    executionLocation: "remote-backed",
    adapter: remoteAdapter,
    nativeModel: "malformed-native-remote-model",
    allowedWorkerEndpointIds: ["malformed-local-endpoint"],
  });
  const localProfile = local.capabilitySnapshot.profiles[0];
  assert.ok(localProfile);

  const malformedLocals: readonly RuntimeEndpointRegistration[] = [
    { ...local, rawProvider: "private-provider-payload" } as unknown as RuntimeEndpointRegistration,
    { ...local, adapter: null } as unknown as RuntimeEndpointRegistration,
    {
      ...local,
      capabilitySnapshot: {
        ...local.capabilitySnapshot,
        contracts: {
          ...local.capabilitySnapshot.contracts,
          supervisorWorkOrders: "yes",
        } as unknown as RuntimeEndpointRegistration["capabilitySnapshot"]["contracts"],
      },
    },
    {
      ...local,
      capabilitySnapshot: {
        ...local.capabilitySnapshot,
        profiles: [
          {
            ...localProfile,
            runtimeProfile: {
              ...localProfile.runtimeProfile,
              accessMode: "administrator",
            },
          },
        ],
      },
    },
    {
      ...local,
      policy: { ...local.policy, maximumBudgetUnits: -1 },
    },
    {
      ...local,
      policy: {
        ...local.policy,
        allowedWorkerEndpointIds: ["unknown-private-endpoint"],
      },
    },
  ];

  for (const malformedLocal of malformedLocals) {
    assert.throws(
      () => createRuntimeEndpointDirectory([malformedLocal, remote]),
      fixedDirectoryError("registration-invalid"),
    );
  }
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("malformed, wrong-kind, unknown, and stale selection keys share one fixed failure", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const registrations = [
    registration({
      registrationId: "selection-local-registration",
      endpointId: "selection-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "selection-native-local-model",
      allowedWorkerEndpointIds: ["selection-remote-endpoint"],
    }),
    registration({
      registrationId: "selection-remote-registration",
      endpointId: "selection-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "selection-native-remote-model",
      allowedWorkerEndpointIds: ["selection-local-endpoint"],
    }),
  ] as const;
  const staleSnapshot = createRuntimeEndpointDirectory(registrations).snapshot();
  const directory = createRuntimeEndpointDirectory(registrations);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const staleWorker = requiredEndpoint(
    staleSnapshot,
    "open-runtime",
    "remote-backed",
  );
  const baseWorkOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-selection-001",
    objective: "Resolve only an exact current directory snapshot.",
    input: "Reject every ambiguous selection without an Adapter effect.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-selection-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };
  const invalidSelections: readonly RuntimeNeutralWorkOrder[] = [
    { ...baseWorkOrder, directorySnapshotKey: "malformed" as never },
    { ...baseWorkOrder, endpointSnapshotKey: "malformed" as never },
    { ...baseWorkOrder, profileSnapshotKey: "malformed" as never },
    {
      ...baseWorkOrder,
      endpointSnapshotKey: baseWorkOrder.profileSnapshotKey as never,
    },
    {
      ...baseWorkOrder,
      endpointSnapshotKey: mutateOpaqueKey(
        workerEndpoint.endpointSnapshotKey,
      ) as never,
    },
    {
      ...baseWorkOrder,
      directorySnapshotKey: staleSnapshot.directorySnapshotKey,
    },
    {
      ...baseWorkOrder,
      endpointSnapshotKey: staleWorker.endpointSnapshotKey,
    },
    {
      ...baseWorkOrder,
      profileSnapshotKey: requiredProfile(staleWorker).profileSnapshotKey,
    },
  ];

  for (const [index, workOrder] of invalidSelections.entries()) {
    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(
          {
            state: "accepted",
            workOrder: {
              ...workOrder,
              idempotencyKey: `work-order-selection-${index + 1}`,
            },
          },
          boundSupervisor,
        ),
      fixedDirectoryError("selection-invalid"),
    );
  }
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("idempotency converges only for the same Work Order digest and bound Supervisor Session", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const directory = createRuntimeEndpointDirectory([
    registration({
      registrationId: "idempotency-local-registration",
      endpointId: "idempotency-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "idempotency-native-local-model",
      allowedWorkerEndpointIds: ["idempotency-remote-endpoint"],
    }),
    registration({
      registrationId: "idempotency-remote-registration",
      endpointId: "idempotency-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "idempotency-native-remote-model",
      allowedWorkerEndpointIds: ["idempotency-local-endpoint"],
    }),
  ]);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const workOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-idempotency-001",
    objective: "Converge one accepted Work Order.",
    input: "Bind the retry to the actual Supervisor Session.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-idempotency-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };

  const first = directory.authorizeAcceptedWorkOrder(
    { state: "accepted", workOrder },
    boundSupervisor,
  );
  const retry = directory.authorizeAcceptedWorkOrder(
    {
      state: "accepted",
      workOrder: {
        ...workOrder,
        budget: { ...workOrder.budget },
        concurrency: { ...workOrder.concurrency },
      },
    },
    { ...boundSupervisor },
  );
  assert.strictEqual(retry, first);

  assert.throws(
    () =>
      directory.authorizeAcceptedWorkOrder(
        {
          state: "accepted",
          workOrder: { ...workOrder, objective: "Different accepted intent." },
        },
        boundSupervisor,
      ),
    fixedDirectoryError("idempotency-conflict"),
  );
  assert.throws(
    () =>
      directory.authorizeAcceptedWorkOrder(
        { state: "accepted", workOrder: { ...workOrder } },
        {
          ...boundSupervisor,
          sessionKey: "supervisor-session-idempotency-002",
        },
      ),
    fixedDirectoryError("idempotency-conflict"),
  );
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("exact endpoints preserve the same-label, different-family, location, role, and Access matrix", () => {
  const localAdapter = new InMemoryEndpointAdapter("family-a");
  const remoteAdapter = new InMemoryEndpointAdapter("family-a");
  const differentFamilyAdapter = new InMemoryEndpointAdapter("family-b");
  const endpointIds = [
    "matrix-local-endpoint",
    "matrix-remote-endpoint",
    "matrix-different-family-endpoint",
  ] as const;
  const directory = createRuntimeEndpointDirectory([
    matrixRegistration({
      registrationId: "matrix-local-registration",
      endpointId: endpointIds[0],
      runtimeFamily: "family-a",
      executionLocation: "local",
      adapter: localAdapter,
      modelLabel: "Twin Model",
      nativeModel: "private-local-twin-model",
      allowedWorkerEndpointIds: endpointIds,
    }),
    matrixRegistration({
      registrationId: "matrix-remote-registration",
      endpointId: endpointIds[1],
      runtimeFamily: "family-a",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      modelLabel: "Twin Model",
      nativeModel: "private-remote-twin-model",
      allowedWorkerEndpointIds: endpointIds,
    }),
    matrixRegistration({
      registrationId: "matrix-different-family-registration",
      endpointId: endpointIds[2],
      runtimeFamily: "family-b",
      executionLocation: "local",
      adapter: differentFamilyAdapter,
      modelLabel: "Different Model",
      nativeModel: "private-different-family-model",
      allowedWorkerEndpointIds: endpointIds,
    }),
  ]);
  const snapshot = directory.snapshot();
  const local = requiredEndpoint(snapshot, "family-a", "local");
  const remote = requiredEndpoint(snapshot, "family-a", "remote-backed");
  const differentFamily = requiredEndpoint(snapshot, "family-b", "local");

  const authorize = (input: {
    readonly id: string;
    readonly supervisor: EndpointSnapshot;
    readonly worker: EndpointSnapshot;
    readonly accessMode: "full-access" | "restricted";
  }) => {
    const supervisorProfile = requiredAccessProfile(
      input.supervisor,
      input.accessMode,
    );
    const workerProfile = requiredAccessProfile(input.worker, input.accessMode);
    return directory.authorizeAcceptedWorkOrder(
      {
        state: "accepted",
        workOrder: {
          idempotencyKey: `work-order-matrix-${input.id}`,
          objective: "Prove exact endpoint identity independently from model label.",
          input: "Preserve the explicitly selected Access Mode.",
          directorySnapshotKey: snapshot.directorySnapshotKey,
          endpointSnapshotKey: input.worker.endpointSnapshotKey,
          profileSnapshotKey: workerProfile.profileSnapshotKey,
          requestedAccessMode: input.accessMode,
          budget: { units: 20 },
          concurrency: { slots: 1 },
        },
      },
      {
        sessionKey: `supervisor-session-matrix-${input.id}`,
        directorySnapshotKey: snapshot.directorySnapshotKey,
        endpointSnapshotKey: input.supervisor.endpointSnapshotKey,
        profileSnapshotKey: supervisorProfile.profileSnapshotKey,
      },
    );
  };

  const localToRemoteFull = authorize({
    id: "local-remote-full",
    supervisor: local,
    worker: remote,
    accessMode: "full-access",
  });
  const remoteToLocalFull = authorize({
    id: "remote-local-full",
    supervisor: remote,
    worker: local,
    accessMode: "full-access",
  });
  const differentFamilyFull = authorize({
    id: "local-different-family-full",
    supervisor: local,
    worker: differentFamily,
    accessMode: "full-access",
  });
  const remoteToLocalRestricted = authorize({
    id: "remote-local-restricted",
    supervisor: remote,
    worker: local,
    accessMode: "restricted",
  });

  assert.equal(localToRemoteFull.worker.profile.modelLabel, "Twin Model");
  assert.equal(remoteToLocalFull.worker.profile.modelLabel, "Twin Model");
  assert.notEqual(
    localToRemoteFull.worker.endpointSnapshotKey,
    remoteToLocalFull.worker.endpointSnapshotKey,
  );
  assert.equal(differentFamilyFull.worker.runtimeFamily, "family-b");
  assert.equal(
    differentFamilyFull.worker.profile.modelLabel,
    "Different Model",
  );
  for (const result of [
    localToRemoteFull,
    remoteToLocalFull,
    differentFamilyFull,
  ]) {
    assert.equal(result.supervisor.accessMode, "full-access");
    assert.equal(
      result.supervisor.hostCapabilityCeiling,
      "codex-full-access",
    );
    assert.equal(result.authorization.accessMode, "full-access");
    assert.equal(
      result.authorization.hostCapabilityCeiling,
      "codex-full-access",
    );
  }
  assert.equal(remoteToLocalRestricted.supervisor.accessMode, "restricted");
  assert.equal(
    remoteToLocalRestricted.supervisor.hostCapabilityCeiling,
    "restricted",
  );
  assert.equal(
    remoteToLocalRestricted.authorization.hostCapabilityCeiling,
    "restricted",
  );
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(differentFamilyAdapter.effects, { inspect: 0, start: 0 });
});

test("a denied accepted idempotency key retains its digest and converges without Adapter effects", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const local = registration({
    registrationId: "denied-idempotency-local-registration",
    endpointId: "denied-idempotency-local-endpoint",
    runtimeFamily: "codex",
    executionLocation: "local",
    adapter: localAdapter,
    nativeModel: "denied-idempotency-native-local-model",
    allowedWorkerEndpointIds: ["denied-idempotency-remote-endpoint"],
  });
  const remoteBase = registration({
    registrationId: "denied-idempotency-remote-registration",
    endpointId: "denied-idempotency-remote-endpoint",
    runtimeFamily: "open-runtime",
    executionLocation: "remote-backed",
    adapter: remoteAdapter,
    nativeModel: "denied-idempotency-native-remote-model",
    allowedWorkerEndpointIds: ["denied-idempotency-local-endpoint"],
  });
  const remote = {
    ...remoteBase,
    policy: { ...remoteBase.policy, maximumBudgetUnits: 5 },
  };
  const directory = createRuntimeEndpointDirectory([local, remote]);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const workOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-denied-idempotency-001",
    objective: "Retain one denied accepted Work Order digest.",
    input: "A changed retry must not replace the denied intent.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-denied-idempotency-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };
  let firstError: unknown;
  let retryError: unknown;

  assert.throws(
    () =>
      directory.authorizeAcceptedWorkOrder(
        { state: "accepted", workOrder },
        boundSupervisor,
      ),
    (error: unknown) => {
      firstError = error;
      return fixedDirectoryError("authorization-denied")(error);
    },
  );
  assert.throws(
    () =>
      directory.authorizeAcceptedWorkOrder(
        { state: "accepted", workOrder: { ...workOrder } },
        { ...boundSupervisor },
      ),
    (error: unknown) => {
      retryError = error;
      return fixedDirectoryError("authorization-denied")(error);
    },
  );
  assert.strictEqual(retryError, firstError);
  assert.throws(
    () =>
      directory.authorizeAcceptedWorkOrder(
        {
          state: "accepted",
          workOrder: {
            ...workOrder,
            budget: { units: 5 },
          },
        },
        boundSupervisor,
      ),
    fixedDirectoryError("idempotency-conflict"),
  );
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("malformed, unknown, and stale bound Supervisor selection keys share one fixed failure", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const registrations = [
    registration({
      registrationId: "binding-local-registration",
      endpointId: "binding-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "binding-native-local-model",
      allowedWorkerEndpointIds: ["binding-remote-endpoint"],
    }),
    registration({
      registrationId: "binding-remote-registration",
      endpointId: "binding-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "binding-native-remote-model",
      allowedWorkerEndpointIds: ["binding-local-endpoint"],
    }),
  ] as const;
  const staleSnapshot = createRuntimeEndpointDirectory(registrations).snapshot();
  const directory = createRuntimeEndpointDirectory(registrations);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const staleSupervisor = requiredEndpoint(staleSnapshot, "codex", "local");
  const workOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-binding-base",
    objective: "Use the coordinator-bound Supervisor Session.",
    input: "Reject ambiguous source selections without an Adapter effect.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-binding-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };
  const invalidBindings: readonly BoundSupervisorSession[] = [
    { ...boundSupervisor, directorySnapshotKey: "malformed" as never },
    { ...boundSupervisor, endpointSnapshotKey: "malformed" as never },
    { ...boundSupervisor, profileSnapshotKey: "malformed" as never },
    {
      ...boundSupervisor,
      endpointSnapshotKey: mutateOpaqueKey(
        boundSupervisor.endpointSnapshotKey,
      ) as never,
    },
    {
      ...boundSupervisor,
      directorySnapshotKey: staleSnapshot.directorySnapshotKey,
    },
    {
      ...boundSupervisor,
      endpointSnapshotKey: staleSupervisor.endpointSnapshotKey,
    },
    {
      ...boundSupervisor,
      profileSnapshotKey: requiredProfile(staleSupervisor).profileSnapshotKey,
    },
  ];

  for (const [index, invalidBinding] of invalidBindings.entries()) {
    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(
          {
            state: "accepted",
            workOrder: {
              ...workOrder,
              idempotencyKey: `work-order-binding-${index + 1}`,
            },
          },
          invalidBinding,
        ),
      fixedDirectoryError("selection-invalid"),
    );
  }
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("capability and local-policy denial matrix fails closed before every Adapter effect", () => {
  type DenialCase = {
    readonly name: string;
    readonly category: "capability-unavailable" | "authorization-denied";
    readonly source?: (
      registration: RuntimeEndpointRegistration,
    ) => RuntimeEndpointRegistration;
    readonly target?: (
      registration: RuntimeEndpointRegistration,
    ) => RuntimeEndpointRegistration;
    readonly workOrder?: (
      workOrder: RuntimeNeutralWorkOrder,
    ) => RuntimeNeutralWorkOrder;
  };
  const capability = (
    update: Partial<
      Omit<
        RuntimeEndpointRegistration["capabilitySnapshot"],
        "contracts"
      >
    > & {
      readonly contracts?: Partial<
        RuntimeEndpointRegistration["capabilitySnapshot"]["contracts"]
      >;
    },
  ) =>
    (registration: RuntimeEndpointRegistration): RuntimeEndpointRegistration => ({
      ...registration,
      capabilitySnapshot: {
        ...registration.capabilitySnapshot,
        ...update,
        contracts: {
          ...registration.capabilitySnapshot.contracts,
          ...update.contracts,
        },
      },
    });
  const denialCases: readonly DenialCase[] = [
    {
      name: "stale-supervisor",
      category: "capability-unavailable",
      source: capability({ freshness: "stale" }),
    },
    {
      name: "offline-supervisor",
      category: "capability-unavailable",
      source: capability({ availability: "offline" }),
    },
    {
      name: "unsupported-supervisor-contract",
      category: "capability-unavailable",
      source: capability({ contracts: { supervisorWorkOrders: false } }),
    },
    {
      name: "stale-worker",
      category: "capability-unavailable",
      target: capability({ freshness: "stale" }),
    },
    {
      name: "offline-worker",
      category: "capability-unavailable",
      target: capability({ availability: "offline" }),
    },
    {
      name: "unsupported-worker-lifecycle",
      category: "capability-unavailable",
      target: capability({ contracts: { workerSessions: false } }),
    },
    {
      name: "unsupported-worker-events",
      category: "capability-unavailable",
      target: capability({ contracts: { normalizedEvents: false } }),
    },
    {
      name: "budget",
      category: "authorization-denied",
      target: (registration) => ({
        ...registration,
        policy: { ...registration.policy, maximumBudgetUnits: 9 },
      }),
    },
    {
      name: "concurrency",
      category: "authorization-denied",
      target: (registration) => ({
        ...registration,
        policy: { ...registration.policy, availableConcurrency: 0 },
      }),
    },
    {
      name: "destination",
      category: "authorization-denied",
      source: (registration) => ({
        ...registration,
        policy: { ...registration.policy, allowedWorkerEndpointIds: [] },
      }),
    },
    {
      name: "access",
      category: "authorization-denied",
      workOrder: (workOrder) => ({
        ...workOrder,
        requestedAccessMode: "restricted",
      }),
    },
  ];

  for (const denialCase of denialCases) {
    const localAdapter = new InMemoryEndpointAdapter("codex");
    const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
    const sourceBase = registration({
      registrationId: `denial-${denialCase.name}-local-registration`,
      endpointId: `denial-${denialCase.name}-local-endpoint`,
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: `denial-${denialCase.name}-native-local-model`,
      allowedWorkerEndpointIds: [
        `denial-${denialCase.name}-remote-endpoint`,
      ],
    });
    const targetBase = registration({
      registrationId: `denial-${denialCase.name}-remote-registration`,
      endpointId: `denial-${denialCase.name}-remote-endpoint`,
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: `denial-${denialCase.name}-native-remote-model`,
      allowedWorkerEndpointIds: [
        `denial-${denialCase.name}-local-endpoint`,
      ],
    });
    const directory = createRuntimeEndpointDirectory([
      denialCase.source?.(sourceBase) ?? sourceBase,
      denialCase.target?.(targetBase) ?? targetBase,
    ]);
    const snapshot = directory.snapshot();
    const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
    const workerEndpoint = requiredEndpoint(
      snapshot,
      "open-runtime",
      "remote-backed",
    );
    const baseWorkOrder: RuntimeNeutralWorkOrder = {
      idempotencyKey: `work-order-denial-${denialCase.name}`,
      objective: "Fail closed through one fixed denial category.",
      input: "Do not invoke an endpoint Adapter.",
      directorySnapshotKey: snapshot.directorySnapshotKey,
      endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
      profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
      requestedAccessMode: "full-access",
      budget: { units: 10 },
      concurrency: { slots: 1 },
    };
    const workOrder = denialCase.workOrder?.(baseWorkOrder) ?? baseWorkOrder;

    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(
          { state: "accepted", workOrder },
          {
            sessionKey: `supervisor-session-denial-${denialCase.name}`,
            directorySnapshotKey: snapshot.directorySnapshotKey,
            endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
            profileSnapshotKey:
              requiredProfile(supervisorEndpoint).profileSnapshotKey,
          },
        ),
      fixedDirectoryError(denialCase.category),
      denialCase.name,
    );
    assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
    assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
  }
});

test("the published Work Order bounds reject underflow, overflow, malformed numbers, and nested fields", () => {
  assertFrozenTree(RUNTIME_NEUTRAL_WORK_ORDER_LIMITS);
  assert.deepEqual(RUNTIME_NEUTRAL_WORK_ORDER_LIMITS, {
    idempotencyKey: { minimumLength: 8, maximumLength: 128 },
    objective: { minimumLength: 1, maximumLength: 1_000 },
    input: { minimumLength: 1, maximumLength: 16_000 },
    budgetUnits: { minimum: 0, maximum: 1_000_000_000 },
    concurrencySlots: { minimum: 1, maximum: 1_000_000 },
  });
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const directory = createRuntimeEndpointDirectory([
    registration({
      registrationId: "bounds-local-registration",
      endpointId: "bounds-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "bounds-native-local-model",
      allowedWorkerEndpointIds: ["bounds-remote-endpoint"],
    }),
    registration({
      registrationId: "bounds-remote-registration",
      endpointId: "bounds-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "bounds-native-remote-model",
      allowedWorkerEndpointIds: ["bounds-local-endpoint"],
    }),
  ]);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const baseWorkOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-bounds-base",
    objective: "Enforce the published bounded objective.",
    input: "Enforce the published bounded input.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const invalidWorkOrders: readonly RuntimeNeutralWorkOrder[] = [
    { ...baseWorkOrder, idempotencyKey: "short" },
    { ...baseWorkOrder, objective: "" },
    {
      ...baseWorkOrder,
      objective: "x".repeat(
        RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.objective.maximumLength + 1,
      ),
    },
    { ...baseWorkOrder, input: "" },
    {
      ...baseWorkOrder,
      input: "x".repeat(
        RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.input.maximumLength + 1,
      ),
    },
    { ...baseWorkOrder, budget: { units: -1 } },
    {
      ...baseWorkOrder,
      budget: {
        units: RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.budgetUnits.maximum + 1,
      },
    },
    { ...baseWorkOrder, budget: { units: Number.NaN } },
    { ...baseWorkOrder, concurrency: { slots: 0 } },
    {
      ...baseWorkOrder,
      concurrency: {
        slots:
          RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.concurrencySlots.maximum + 1,
      },
    },
    {
      ...baseWorkOrder,
      budget: { units: 10, currency: "private" } as never,
    },
    {
      ...baseWorkOrder,
      concurrency: { slots: 1, endpoint: "private" } as never,
    },
  ];

  for (const workOrder of invalidWorkOrders) {
    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(
          { state: "accepted", workOrder },
          {
            sessionKey: "supervisor-session-bounds-001",
            directorySnapshotKey: snapshot.directorySnapshotKey,
            endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
            profileSnapshotKey:
              requiredProfile(supervisorEndpoint).profileSnapshotKey,
          },
        ),
      fixedDirectoryError("work-order-invalid"),
    );
  }
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("durable acceptance and zero external-effect ordering are explicit and cannot be spoofed", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const directory = createRuntimeEndpointDirectory([
    registration({
      registrationId: "ordering-local-registration",
      endpointId: "ordering-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "ordering-native-local-model",
      allowedWorkerEndpointIds: ["ordering-remote-endpoint"],
    }),
    registration({
      registrationId: "ordering-remote-registration",
      endpointId: "ordering-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "ordering-native-remote-model",
      allowedWorkerEndpointIds: ["ordering-local-endpoint"],
    }),
  ]);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const workOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-ordering-accepted",
    objective: "Authorize only after durable local acceptance.",
    input: "Grant eligibility without starting or resuming a Runtime.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-ordering-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };

  for (const notAccepted of [
    workOrder as unknown as AcceptedRuntimeWorkOrder,
    { state: "pending", workOrder } as unknown as AcceptedRuntimeWorkOrder,
    {
      state: "accepted",
      workOrder,
      persistenceReceipt: "private-database-key",
    } as unknown as AcceptedRuntimeWorkOrder,
  ]) {
    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(notAccepted, boundSupervisor),
      fixedDirectoryError("acceptance-required"),
    );
  }
  assert.throws(
    () =>
      directory.authorizeAcceptedWorkOrder(
        { state: "accepted", workOrder },
        {
          ...boundSupervisor,
          nativeSession: "private-native-session",
        } as unknown as BoundSupervisorSession,
      ),
    fixedDirectoryError("supervisor-binding-invalid"),
  );

  const result = directory.authorizeAcceptedWorkOrder(
    { state: "accepted", workOrder },
    boundSupervisor,
  );
  assert.equal(result.durableAcceptance, "confirmed");
  assert.equal(result.startEligibility, "eligible");
  assert.equal(result.externalEffect, "not-started");
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("sanitized capability display fields reject path, URI, credential, and control shapes", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const local = registration({
    registrationId: "sanitization-local-registration",
    endpointId: "sanitization-local-endpoint",
    runtimeFamily: "codex",
    executionLocation: "local",
    adapter: localAdapter,
    nativeModel: "sanitization-native-local-model",
    allowedWorkerEndpointIds: ["sanitization-remote-endpoint"],
  });
  const remote = registration({
    registrationId: "sanitization-remote-registration",
    endpointId: "sanitization-remote-endpoint",
    runtimeFamily: "open-runtime",
    executionLocation: "remote-backed",
    adapter: remoteAdapter,
    nativeModel: "sanitization-native-remote-model",
    allowedWorkerEndpointIds: ["sanitization-local-endpoint"],
  });
  const localProfile = local.capabilitySnapshot.profiles[0];
  assert.ok(localProfile);
  const unsafeRegistrations: readonly RuntimeEndpointRegistration[] = [
    { ...local, runtimeFamily: "C:\\private\\runtime" },
    {
      ...local,
      capabilitySnapshot: {
        ...local.capabilitySnapshot,
        profiles: [
          { ...localProfile, modelLabel: "https://private.invalid/model" },
        ],
      },
    },
    {
      ...local,
      capabilitySnapshot: {
        ...local.capabilitySnapshot,
        profiles: [
          { ...localProfile, workIntensityLabel: "Bearer private-token" },
        ],
      },
    },
    {
      ...local,
      capabilitySnapshot: {
        ...local.capabilitySnapshot,
        profiles: [
          {
            ...localProfile,
            runtimeProfile: {
              ...localProfile.runtimeProfile,
              executionMode: "\\\\private\\share",
            },
          },
        ],
      },
    },
    {
      ...local,
      capabilitySnapshot: {
        ...local.capabilitySnapshot,
        profiles: [{ ...localProfile, modelLabel: "unsafe\nlabel" }],
      },
    },
  ];

  for (const unsafeRegistration of unsafeRegistrations) {
    assert.throws(
      () => createRuntimeEndpointDirectory([unsafeRegistration, remote]),
      fixedDirectoryError("registration-invalid"),
    );
  }
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("adversarial Work Order object shapes fail closed without evaluating accessors", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const directory = createRuntimeEndpointDirectory([
    registration({
      registrationId: "object-shape-local-registration",
      endpointId: "object-shape-local-endpoint",
      runtimeFamily: "codex",
      executionLocation: "local",
      adapter: localAdapter,
      nativeModel: "object-shape-native-local-model",
      allowedWorkerEndpointIds: ["object-shape-remote-endpoint"],
    }),
    registration({
      registrationId: "object-shape-remote-registration",
      endpointId: "object-shape-remote-endpoint",
      runtimeFamily: "open-runtime",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      nativeModel: "object-shape-native-remote-model",
      allowedWorkerEndpointIds: ["object-shape-local-endpoint"],
    }),
  ]);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );
  const baseWorkOrder: RuntimeNeutralWorkOrder = {
    idempotencyKey: "work-order-object-shape-base",
    objective: "Reject adversarial object shapes.",
    input: "Do not evaluate a caller-owned accessor.",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
    requestedAccessMode: "full-access",
    budget: { units: 10 },
    concurrency: { slots: 1 },
  };
  const boundSupervisor: BoundSupervisorSession = {
    sessionKey: "supervisor-session-object-shape-001",
    directorySnapshotKey: snapshot.directorySnapshotKey,
    endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
    profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
  };
  let getterReads = 0;
  const accessorWorkOrder = { ...baseWorkOrder };
  Object.defineProperty(accessorWorkOrder, "input", {
    enumerable: true,
    get() {
      getterReads += 1;
      return baseWorkOrder.input;
    },
  });
  const symbolWorkOrder = { ...baseWorkOrder } as Record<PropertyKey, unknown>;
  symbolWorkOrder[Symbol("private")] = "private-symbol-canary";
  const nullPrototypeWorkOrder = Object.assign(
    Object.create(null) as object,
    baseWorkOrder,
  );
  const revoked = Proxy.revocable({ ...baseWorkOrder }, {});
  revoked.revoke();

  for (const workOrder of [
    accessorWorkOrder,
    symbolWorkOrder,
    nullPrototypeWorkOrder,
    revoked.proxy,
  ]) {
    assert.throws(
      () =>
        directory.authorizeAcceptedWorkOrder(
          {
            state: "accepted",
            workOrder: workOrder as unknown as RuntimeNeutralWorkOrder,
          },
          boundSupervisor,
        ),
      fixedDirectoryError("work-order-invalid"),
    );
  }
  assert.equal(getterReads, 0);
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

test("caller mutation cannot change owned registration, capability, policy, profile, or exact snapshot state", () => {
  const localAdapter = new InMemoryEndpointAdapter("codex");
  const remoteAdapter = new InMemoryEndpointAdapter("open-runtime");
  const local = registration({
    registrationId: "immutability-local-registration",
    endpointId: "immutability-local-endpoint",
    runtimeFamily: "codex",
    executionLocation: "local",
    adapter: localAdapter,
    nativeModel: "immutability-native-local-model",
    allowedWorkerEndpointIds: ["immutability-remote-endpoint"],
  }) as unknown as Mutable<RuntimeEndpointRegistration>;
  const remote = registration({
    registrationId: "immutability-remote-registration",
    endpointId: "immutability-remote-endpoint",
    runtimeFamily: "open-runtime",
    executionLocation: "remote-backed",
    adapter: remoteAdapter,
    nativeModel: "immutability-native-remote-model",
    allowedWorkerEndpointIds: ["immutability-local-endpoint"],
  }) as unknown as Mutable<RuntimeEndpointRegistration>;
  const registrations = [local, remote];
  const directory = createRuntimeEndpointDirectory(registrations);
  const snapshot = directory.snapshot();
  const supervisorEndpoint = requiredEndpoint(snapshot, "codex", "local");
  const workerEndpoint = requiredEndpoint(
    snapshot,
    "open-runtime",
    "remote-backed",
  );

  local.runtimeFamily = "mutated-local-runtime";
  local.capabilitySnapshot.freshness = "stale";
  local.capabilitySnapshot.contracts.supervisorWorkOrders = false;
  local.policy.allowedWorkerEndpointIds.length = 0;
  remote.runtimeFamily = "mutated-remote-runtime";
  remote.capabilitySnapshot.availability = "offline";
  remote.capabilitySnapshot.contracts.workerSessions = false;
  remote.capabilitySnapshot.contracts.normalizedEvents = false;
  const remoteProfile = remote.capabilitySnapshot.profiles[0];
  assert.ok(remoteProfile);
  remoteProfile.modelLabel = "Mutated Private Model";
  remoteProfile.runtimeProfile.accessMode = "restricted";
  remote.policy.maximumBudgetUnits = 0;
  remote.policy.availableConcurrency = 0;
  remote.policy.allowedAccessModes.length = 0;
  registrations.length = 0;

  const result = directory.authorizeAcceptedWorkOrder(
    {
      state: "accepted",
      workOrder: {
        idempotencyKey: "work-order-owned-immutability",
        objective: "Use the Module-owned immutable registration snapshot.",
        input: "Ignore every later caller mutation.",
        directorySnapshotKey: snapshot.directorySnapshotKey,
        endpointSnapshotKey: workerEndpoint.endpointSnapshotKey,
        profileSnapshotKey: requiredProfile(workerEndpoint).profileSnapshotKey,
        requestedAccessMode: "full-access",
        budget: { units: 10 },
        concurrency: { slots: 1 },
      },
    },
    {
      sessionKey: "supervisor-session-owned-immutability",
      directorySnapshotKey: snapshot.directorySnapshotKey,
      endpointSnapshotKey: supervisorEndpoint.endpointSnapshotKey,
      profileSnapshotKey: requiredProfile(supervisorEndpoint).profileSnapshotKey,
    },
  );

  assert.strictEqual(directory.snapshot(), snapshot);
  assert.equal(result.supervisor.runtimeFamily, "codex");
  assert.equal(result.worker.runtimeFamily, "open-runtime");
  assert.equal(result.worker.profile.modelLabel, "Shared Model");
  assert.equal(result.worker.profile.accessMode, "full-access");
  assert.deepEqual(localAdapter.effects, { inspect: 0, start: 0 });
  assert.deepEqual(remoteAdapter.effects, { inspect: 0, start: 0 });
});

function registration(input: {
  readonly registrationId: string;
  readonly endpointId: string;
  readonly runtimeFamily: string;
  readonly executionLocation: "local" | "remote-backed";
  readonly adapter: AgentRuntimeAdapter;
  readonly nativeModel: string;
  readonly allowedWorkerEndpointIds: readonly string[];
}): RuntimeEndpointRegistration {
  return {
    registrationId: input.registrationId,
    endpointId: input.endpointId,
    runtimeFamily: input.runtimeFamily,
    executionLocation: input.executionLocation,
    adapter: input.adapter,
    capabilitySnapshot: {
      snapshotId: `${input.endpointId}-capabilities-1`,
      freshness: "fresh",
      availability: "online",
      contracts: {
        supervisorWorkOrders: true,
        workerSessions: true,
        normalizedEvents: true,
      },
      profiles: [
        {
          profileId: `${input.endpointId}-full-profile`,
          modelLabel: "Shared Model",
          workIntensityLabel: "Maximum",
          runtimeProfile: {
            model: input.nativeModel,
            effortLevel: "maximum",
            executionMode: "single-agent",
            accessMode: "full-access",
          },
        },
      ],
    },
    policy: {
      maximumBudgetUnits: 100,
      availableConcurrency: 2,
      allowedAccessModes: ["full-access"],
      allowedWorkerEndpointIds: input.allowedWorkerEndpointIds,
    },
  };
}

function matrixRegistration(input: {
  readonly registrationId: string;
  readonly endpointId: string;
  readonly runtimeFamily: string;
  readonly executionLocation: "local" | "remote-backed";
  readonly adapter: AgentRuntimeAdapter;
  readonly modelLabel: string;
  readonly nativeModel: string;
  readonly allowedWorkerEndpointIds: readonly string[];
}): RuntimeEndpointRegistration {
  const base = registration({
    registrationId: input.registrationId,
    endpointId: input.endpointId,
    runtimeFamily: input.runtimeFamily,
    executionLocation: input.executionLocation,
    adapter: input.adapter,
    nativeModel: input.nativeModel,
    allowedWorkerEndpointIds: input.allowedWorkerEndpointIds,
  });
  const fullProfile = base.capabilitySnapshot.profiles[0];
  assert.ok(fullProfile);
  return {
    ...base,
    capabilitySnapshot: {
      ...base.capabilitySnapshot,
      profiles: [
        { ...fullProfile, modelLabel: input.modelLabel },
        {
          ...fullProfile,
          profileId: `${input.endpointId}-restricted-profile`,
          modelLabel: input.modelLabel,
          workIntensityLabel: "Constrained",
          runtimeProfile: {
            ...fullProfile.runtimeProfile,
            accessMode: "restricted",
          },
        },
      ],
    },
    policy: {
      ...base.policy,
      allowedAccessModes: ["full-access", "restricted"],
    },
  };
}

type DirectorySnapshot = ReturnType<
  ReturnType<typeof createRuntimeEndpointDirectory>["snapshot"]
>;
type EndpointSnapshot = DirectorySnapshot["endpoints"][number];

function requiredEndpoint(
  snapshot: DirectorySnapshot,
  runtimeFamily: string,
  executionLocation: "local" | "remote-backed",
): EndpointSnapshot {
  const endpoint = snapshot.endpoints.find(
    (candidate) =>
      candidate.runtimeFamily === runtimeFamily &&
      candidate.executionLocation === executionLocation,
  );
  assert.ok(endpoint);
  return endpoint;
}

function requiredProfile(endpoint: EndpointSnapshot) {
  const profile = endpoint.profiles[0];
  assert.ok(profile);
  return profile;
}

function requiredAccessProfile(
  endpoint: EndpointSnapshot,
  accessMode: "full-access" | "restricted",
) {
  const profile = endpoint.profiles.find(
    (candidate) => candidate.accessMode === accessMode,
  );
  assert.ok(profile);
  return profile;
}

function assertFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozenTree(child);
}

function fixedDirectoryError(
  category: RuntimeEndpointDirectoryError["category"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RuntimeEndpointDirectoryError &&
    error.category === category &&
    error.message === "Runtime Endpoint Directory operation failed." &&
    error.stack ===
      "RuntimeEndpointDirectoryError: Runtime Endpoint Directory operation failed.";
}

function mutateOpaqueKey(key: string): string {
  const last = key.at(-1);
  assert.ok(last);
  return `${key.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

type Mutable<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;
