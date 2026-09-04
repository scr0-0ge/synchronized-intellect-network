import assert from "node:assert/strict";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  createRuntimeEndpointDirectory,
  RuntimeEndpointDirectoryError,
  type RuntimeEndpointRegistration,
} from "../../src/agent-runtime/runtime-endpoint-directory.ts";

const selectionProfile = Object.freeze({
  model: "directory-model:opaque",
  effortLevel: "directory-intensity:opaque",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const nativeProfile = Object.freeze({
  model: "private-native-model",
  effortLevel: "private-native-effort",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const changedSelectionProfile = Object.freeze({
  model: "directory-model:changed",
  effortLevel: "directory-intensity:changed",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const changedNativeProfile = Object.freeze({
  model: "private-native-model-changed",
  effortLevel: "private-native-effort-changed",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const otherEndpointSelectionProfile = Object.freeze({
  model: "other-directory-model:opaque",
  effortLevel: "other-directory-intensity:opaque",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const otherEndpointNativeProfile = Object.freeze({
  model: "other-private-native-model",
  effortLevel: "other-private-native-effort",
  executionMode: "single-agent",
  accessMode: "full-access",
});

test("the Directory dispatch Adapter privately maps selections to one native endpoint and wraps the binding", async () => {
  const endpoint = new RecordingEndpointAdapter();
  const directory = createRuntimeEndpointDirectory([
    registration(endpoint),
  ]);
  const adapter = directory.runtimeAdapter();

  assert.deepEqual(await adapter.inspect("project"), {
    runtime: "runtime-endpoint-directory",
    models: [
      {
        id: selectionProfile.model,
        displayName: "Visible model",
        effortLevels: [selectionProfile.effortLevel],
        effortLevelLabels: ["Visible effort"],
      },
    ],
    executionModes: ["single-agent"],
    accessModes: ["full-access"],
  });
  assert.equal(endpoint.inspectCalls, 0);

  const binding = await adapter.start({
    projectDirectory: "project",
    profile: selectionProfile,
  });
  assert.deepEqual(endpoint.startedProfiles, [nativeProfile]);
  assert.deepEqual(binding.profile, selectionProfile);
  assert.equal(binding.opaqueSessionReference, "private-session-reference");
  await binding.send({ text: "bounded input" });
  assert.deepEqual(endpoint.inputs, ["bounded input"]);
  assert.equal(typeof binding.steer, "function");
  assert.equal(binding.steerAvailability?.(), "available");
  assert.equal(typeof binding.interrupt, "function");
  assert.equal(binding.interruptAvailability?.(), "available");
  assert.equal(typeof binding.effectiveProfile, "function");
  assert.deepEqual(binding.effectiveProfile?.(), selectionProfile);
  await binding.steer?.({ text: "bounded direction" });
  await binding.interrupt?.();
  assert.deepEqual(endpoint.steers, ["bounded direction"]);
  assert.equal(endpoint.interrupts, 1);
  assert.deepEqual(await collect(binding.events()), [
    { kind: "session-started" },
  ]);

  const resumed = await adapter.resume({
    projectDirectory: "project",
    profile: selectionProfile,
    opaqueSessionReference: "private-session-reference",
  });
  assert.deepEqual(endpoint.resumedProfiles, [nativeProfile]);
  assert.deepEqual(resumed.profile, selectionProfile);
  assert.equal(resumed.steerAvailability?.(), "available");

  const publicSnapshot = JSON.stringify(directory.snapshot());
  assert.equal(publicSnapshot.includes(nativeProfile.model), false);
  assert.equal(publicSnapshot.includes(nativeProfile.effortLevel), false);
});

test("Directory dispatch rejects ambiguous registration and unknown selections", async () => {
  const first = new RecordingEndpointAdapter();
  const second = new RecordingEndpointAdapter();
  assert.throws(
    () =>
      createRuntimeEndpointDirectory([
        registration(first, "first-endpoint", "first-registration"),
        registration(second, "second-endpoint", "second-registration"),
      ]),
    (error: unknown) =>
      error instanceof RuntimeEndpointDirectoryError &&
      error.category === "registration-invalid",
  );
  assert.equal(first.startedProfiles.length, 0);
  assert.equal(second.startedProfiles.length, 0);

  await assert.rejects(
    () =>
      createRuntimeEndpointDirectory([registration(first)])
        .runtimeAdapter()
        .start({
          projectDirectory: "project",
          profile: { ...selectionProfile, model: "unknown-selection" },
        }),
    fixedRuntimeError("unsupported-selection"),
  );
});

test("Directory continuation compatibility proves same endpoint without exposing endpoint or native identity", () => {
  const firstEndpoint = new RecordingEndpointAdapter();
  const secondEndpoint = new RecordingEndpointAdapter();
  const first = registration(firstEndpoint);
  const second = registration(
    secondEndpoint,
    "other-private-endpoint",
    "other-private-registration",
  );
  const directory = createRuntimeEndpointDirectory([
    {
      ...first,
      capabilitySnapshot: {
        ...first.capabilitySnapshot,
        profiles: [
          ...first.capabilitySnapshot.profiles,
          {
            profileId: "private-registration-changed-profile",
            modelLabel: "Visible changed model",
            workIntensityLabel: "Visible changed effort",
            runtimeProfile: changedSelectionProfile,
            nativeRuntimeProfile: changedNativeProfile,
          },
        ],
      },
    },
    {
      ...second,
      capabilitySnapshot: {
        ...second.capabilitySnapshot,
        profiles: [
          {
            profileId: "other-private-registration-profile",
            modelLabel: "Other visible model",
            workIntensityLabel: "Other visible effort",
            runtimeProfile: otherEndpointSelectionProfile,
            nativeRuntimeProfile: otherEndpointNativeProfile,
          },
        ],
      },
    },
  ]);
  const adapter = directory.runtimeAdapter() as ResumableAgentRuntimeAdapter & {
    continuationProfileCompatibility?(request: unknown):
      | "compatible"
      | "incompatible";
  };
  assert.equal(typeof adapter.continuationProfileCompatibility, "function");
  assert.equal(
    adapter.continuationProfileCompatibility?.({
      projectDirectory: "project",
      currentProfile: selectionProfile,
      requestedProfile: changedSelectionProfile,
    }),
    "compatible",
  );
  assert.equal(
    adapter.continuationProfileCompatibility?.({
      projectDirectory: "project",
      currentProfile: selectionProfile,
      requestedProfile: otherEndpointSelectionProfile,
    }),
    "incompatible",
  );
  assert.equal(
    adapter.continuationProfileCompatibility?.({
      projectDirectory: "project",
      currentProfile: selectionProfile,
      requestedProfile: {
        ...changedSelectionProfile,
        accessMode: "restricted",
      },
    }),
    "incompatible",
  );
  assert.throws(
    () =>
      adapter.continuationProfileCompatibility?.({
        projectDirectory: "project",
        currentProfile: selectionProfile,
        requestedProfile: changedSelectionProfile,
        nativeEndpointIdentity: "must-not-be-admitted",
      }),
    fixedRuntimeError("invalid-input"),
  );
  const serialized = JSON.stringify(
    adapter.continuationProfileCompatibility?.({
      projectDirectory: "project",
      currentProfile: selectionProfile,
      requestedProfile: changedSelectionProfile,
    }),
  );
  assert.equal(serialized.includes("private-endpoint"), false);
  assert.equal(serialized.includes(changedNativeProfile.model), false);
});

test("native Directory profiles cannot silently widen execution or access", () => {
  const endpoint = new RecordingEndpointAdapter();
  const unsafe = registration(endpoint);
  const profile = unsafe.capabilitySnapshot.profiles[0]!;
  const changed: RuntimeEndpointRegistration = {
    ...unsafe,
    capabilitySnapshot: {
      ...unsafe.capabilitySnapshot,
      profiles: [
        {
          ...profile,
          nativeRuntimeProfile: {
            ...nativeProfile,
            accessMode: "restricted",
          },
        },
      ],
    },
  };
  assert.throws(
    () => createRuntimeEndpointDirectory([changed]),
    (error: unknown) =>
      error instanceof RuntimeEndpointDirectoryError &&
      error.category === "registration-invalid",
  );
});

test("Directory dispatch rejects every non-exact initial native binding profile", async () => {
  for (const hostile of hostileNativeProfiles()) {
    for (const operation of ["start", "resume"] as const) {
      const endpoint = endpointReportingProfiles(hostile.value, nativeProfile);
      const adapter = createRuntimeEndpointDirectory([registration(endpoint)])
        .runtimeAdapter();
      await assert.rejects(
        operation === "start"
          ? adapter.start({
              projectDirectory: "project",
              profile: selectionProfile,
            })
          : adapter.resume!({
              projectDirectory: "project",
              profile: selectionProfile,
              opaqueSessionReference: "private-session-reference",
            }),
        fixedRuntimeError("protocol-invalid"),
        `${operation}: ${hostile.name}`,
      );
    }
  }
});

test("Directory dispatch rejects every non-exact effective native profile", async () => {
  for (const hostile of hostileNativeProfiles()) {
    for (const operation of ["start", "resume"] as const) {
      const endpoint = endpointReportingProfiles(nativeProfile, hostile.value);
      const adapter = createRuntimeEndpointDirectory([registration(endpoint)])
        .runtimeAdapter();
      const binding =
        operation === "start"
          ? await adapter.start({
              projectDirectory: "project",
              profile: selectionProfile,
            })
          : await adapter.resume!({
              projectDirectory: "project",
              profile: selectionProfile,
              opaqueSessionReference: "private-session-reference",
            });
      assert.throws(
        () => binding.effectiveProfile?.(),
        fixedRuntimeError("unsupported-selection"),
        `${operation}: ${hostile.name}`,
      );
    }
  }
});

class RecordingEndpointAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  readonly startedProfiles: SessionProfile[] = [];
  readonly resumedProfiles: SessionProfile[] = [];
  readonly inputs: string[] = [];
  readonly steers: string[] = [];
  interrupts = 0;

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    throw new Error("Directory dispatch must use its exact capability snapshot");
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startedProfiles.push(request.profile);
    return new RecordingBinding(request.profile, this.inputs, this.steers, () => {
      this.interrupts += 1;
    });
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumedProfiles.push(request.profile);
    return new RecordingBinding(
      request.profile,
      this.inputs,
      this.steers,
      () => {
        this.interrupts += 1;
      },
      request.opaqueSessionReference,
    );
  }
}

class RecordingBinding implements ResumableRuntimeBinding {
  readonly profile: SessionProfile;
  readonly opaqueSessionReference: string;
  readonly #inputs: string[];
  readonly #steers: string[];
  readonly #onInterrupt: () => void;

  constructor(
    profile: SessionProfile,
    inputs: string[],
    steers: string[],
    onInterrupt: () => void,
    opaqueSessionReference = "private-session-reference",
  ) {
    this.profile = Object.freeze({ ...profile });
    this.#inputs = inputs;
    this.#steers = steers;
    this.#onInterrupt = onInterrupt;
    this.opaqueSessionReference = opaqueSessionReference;
  }

  async send(input: RuntimeInput): Promise<void> {
    this.#inputs.push(input.text);
  }

  async steer(input: RuntimeInput): Promise<void> {
    this.#steers.push(input.text);
  }

  steerAvailability(): "available" {
    return "available";
  }

  async interrupt(): Promise<void> {
    this.#onInterrupt();
  }

  interruptAvailability(): "available" {
    return "available";
  }

  effectiveProfile(): SessionProfile {
    return this.profile;
  }

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    yield Object.freeze({ kind: "session-started" as const });
  }
}

function endpointReportingProfiles(
  initialProfile: unknown,
  effectiveProfile: unknown,
): ResumableAgentRuntimeAdapter {
  const binding = (): ResumableRuntimeBinding => ({
    profile: initialProfile as SessionProfile,
    opaqueSessionReference: "private-session-reference",
    effectiveProfile: () => effectiveProfile as SessionProfile,
    async send(): Promise<void> {},
    async *events(): AsyncIterable<NormalizedRuntimeEvent> {
      yield { kind: "turn-completed", status: "completed" };
    },
  });
  return {
    async inspect(): Promise<RuntimeCatalog> {
      throw new Error("Directory dispatch must not inspect the endpoint");
    },
    async start(): Promise<ResumableRuntimeBinding> {
      return binding();
    },
    async resume(): Promise<ResumableRuntimeBinding> {
      return binding();
    },
  };
}

function hostileNativeProfiles(): readonly {
  readonly name: string;
  readonly value: unknown;
}[] {
  const hiddenExtra = { ...nativeProfile };
  Object.defineProperty(hiddenExtra, "nativeExtra", {
    value: "PRIVATE_HIDDEN_NATIVE_VALUE",
  });
  const accessor = {
    effortLevel: nativeProfile.effortLevel,
    executionMode: nativeProfile.executionMode,
    accessMode: nativeProfile.accessMode,
  } as Record<string, unknown>;
  Object.defineProperty(accessor, "model", {
    enumerable: true,
    get: () => nativeProfile.model,
  });
  return [
    {
      name: "enumerable extra",
      value: { ...nativeProfile, nativeExtra: "PRIVATE_NATIVE_VALUE" },
    },
    { name: "non-enumerable extra", value: hiddenExtra },
    {
      name: "symbol extra",
      value: { ...nativeProfile, [Symbol("native-extra")]: true },
    },
    {
      name: "inherited extra",
      value: Object.assign(
        Object.create({ nativeExtra: "PRIVATE_INHERITED_NATIVE_VALUE" }) as Record<
          string,
          unknown
        >,
        nativeProfile,
      ),
    },
    { name: "accessor field", value: accessor },
    { name: "Proxy", value: new Proxy({ ...nativeProfile }, {}) },
    {
      name: "malformed partial profile",
      value: {
        model: nativeProfile.model,
        effortLevel: nativeProfile.effortLevel,
      },
    },
  ];
}

function registration(
  adapter: ResumableAgentRuntimeAdapter,
  endpointId = "private-endpoint",
  registrationId = "private-registration",
): RuntimeEndpointRegistration {
  return Object.freeze({
    registrationId,
    endpointId,
    runtimeFamily: "Visible Runtime",
    executionLocation: "local" as const,
    adapter,
    capabilitySnapshot: Object.freeze({
      snapshotId: `${registrationId}-snapshot`,
      freshness: "fresh" as const,
      availability: "online" as const,
      contracts: Object.freeze({
        supervisorWorkOrders: true,
        workerSessions: true,
        normalizedEvents: true,
      }),
      profiles: Object.freeze([
        Object.freeze({
          profileId: `${registrationId}-profile`,
          modelLabel: "Visible model",
          workIntensityLabel: "Visible effort",
          runtimeProfile: selectionProfile,
          nativeRuntimeProfile: nativeProfile,
        }),
      ]),
    }),
    policy: Object.freeze({
      maximumBudgetUnits: 1_000,
      availableConcurrency: 1,
      allowedAccessModes: Object.freeze(["full-access" as const]),
      allowedWorkerEndpointIds: Object.freeze([endpointId]),
    }),
  });
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function fixedRuntimeError(category: RuntimeAdapterError["category"]) {
  return (error: unknown) =>
    error instanceof RuntimeAdapterError && error.category === category;
}
