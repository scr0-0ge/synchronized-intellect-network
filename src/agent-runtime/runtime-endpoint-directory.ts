import { createHash, randomBytes } from "node:crypto";

import type {
  AgentRuntimeAdapter,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeBinding,
  RuntimeCatalog,
  RuntimeContinuationProfileCompatibility,
  RuntimeContinuationProfileCompatibilityRequest,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "./index.ts";
import { RuntimeAdapterError } from "./index.ts";
import {
  runtimeProfileProjectionPreservesLockedModes,
} from "./runtime-profile-projection.ts";

declare const directorySnapshotKeyBrand: unique symbol;
declare const endpointSnapshotKeyBrand: unique symbol;
declare const profileSnapshotKeyBrand: unique symbol;

export type RuntimeDirectorySnapshotKey = string & {
  readonly [directorySnapshotKeyBrand]: "RuntimeDirectorySnapshotKey";
};

export type RuntimeEndpointSnapshotKey = string & {
  readonly [endpointSnapshotKeyBrand]: "RuntimeEndpointSnapshotKey";
};

export type RuntimeProfileSnapshotKey = string & {
  readonly [profileSnapshotKeyBrand]: "RuntimeProfileSnapshotKey";
};

export type RuntimeEndpointExecutionLocation = "local" | "remote-backed";
export type RuntimeEndpointAccessMode = "full-access" | "restricted";

export const RUNTIME_NEUTRAL_WORK_ORDER_LIMITS = deepFreeze({
  idempotencyKey: { minimumLength: 8, maximumLength: 128 },
  objective: { minimumLength: 1, maximumLength: 1_000 },
  input: { minimumLength: 1, maximumLength: 16_000 },
  budgetUnits: { minimum: 0, maximum: 1_000_000_000 },
  concurrencySlots: { minimum: 1, maximum: 1_000_000 },
} as const);

export interface RuntimeEndpointProfileRegistration {
  readonly profileId: string;
  readonly modelLabel: string;
  readonly workIntensityLabel: string;
  /**
   * Directory-scoped selection values. A composition root may use opaque
   * values here and provide the Runtime-native values separately below.
   */
  readonly runtimeProfile: SessionProfile;
  /** Kept only in the Directory's private resolution state. */
  readonly nativeRuntimeProfile?: SessionProfile;
}

export interface RuntimeEndpointCapabilitySnapshotRegistration {
  readonly snapshotId: string;
  readonly freshness: "fresh" | "stale";
  readonly availability: "online" | "offline";
  readonly contracts: {
    readonly supervisorWorkOrders: boolean;
    readonly workerSessions: boolean;
    readonly normalizedEvents: boolean;
  };
  readonly profiles: readonly RuntimeEndpointProfileRegistration[];
}

export interface RuntimeEndpointPolicyRegistration {
  readonly maximumBudgetUnits: number;
  readonly availableConcurrency: number;
  readonly allowedAccessModes: readonly RuntimeEndpointAccessMode[];
  readonly allowedWorkerEndpointIds: readonly string[];
}

/** Trusted composition-root input. None of its private fields crosses the Module. */
export interface RuntimeEndpointRegistration {
  readonly registrationId: string;
  readonly endpointId: string;
  readonly runtimeFamily: string;
  readonly executionLocation: RuntimeEndpointExecutionLocation;
  readonly adapter: AgentRuntimeAdapter;
  readonly capabilitySnapshot: RuntimeEndpointCapabilitySnapshotRegistration;
  readonly policy: RuntimeEndpointPolicyRegistration;
}

export interface SanitizedRuntimeProfileSnapshot {
  readonly profileSnapshotKey: RuntimeProfileSnapshotKey;
  readonly modelLabel: string;
  readonly workIntensityLabel: string;
  readonly executionMode: string;
  readonly accessMode: RuntimeEndpointAccessMode;
}

export interface SanitizedRuntimeEndpointSnapshot {
  readonly endpointSnapshotKey: RuntimeEndpointSnapshotKey;
  readonly runtimeFamily: string;
  readonly executionLocation: RuntimeEndpointExecutionLocation;
  readonly freshness: "fresh" | "stale";
  readonly availability: "online" | "offline";
  readonly roles: {
    readonly supervisor: boolean;
    readonly worker: boolean;
  };
  readonly profiles: readonly SanitizedRuntimeProfileSnapshot[];
}

export interface RuntimeEndpointDirectorySnapshot {
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly endpoints: readonly SanitizedRuntimeEndpointSnapshot[];
}

/** Model-authored bounded intent. The actual Supervisor Session is not a field. */
export interface RuntimeNeutralWorkOrder {
  readonly idempotencyKey: string;
  readonly objective: string;
  readonly input: string;
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly endpointSnapshotKey: RuntimeEndpointSnapshotKey;
  readonly profileSnapshotKey: RuntimeProfileSnapshotKey;
  readonly requestedAccessMode: RuntimeEndpointAccessMode;
  readonly budget: {
    readonly units: number;
  };
  readonly concurrency: {
    readonly slots: number;
  };
}

/** Supplied only after the coordinator has durably accepted the Work Order. */
export interface AcceptedRuntimeWorkOrder {
  readonly state: "accepted";
  readonly workOrder: RuntimeNeutralWorkOrder;
}

/** Actual local Workbench binding supplied separately from model-authored intent. */
export interface BoundSupervisorSession {
  readonly sessionKey: string;
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly endpointSnapshotKey: RuntimeEndpointSnapshotKey;
  readonly profileSnapshotKey: RuntimeProfileSnapshotKey;
}

export interface AuthorizedRuntimeEndpoint {
  readonly endpointSnapshotKey: RuntimeEndpointSnapshotKey;
  readonly profileSnapshotKey: RuntimeProfileSnapshotKey;
  readonly runtimeFamily: string;
  readonly executionLocation: RuntimeEndpointExecutionLocation;
}

export interface AuthorizedSupervisorEndpoint extends AuthorizedRuntimeEndpoint {
  readonly sessionKey: string;
  readonly accessMode: RuntimeEndpointAccessMode;
  readonly hostCapabilityCeiling: "codex-full-access" | "restricted";
}

export interface AuthorizedWorkerEndpoint extends AuthorizedRuntimeEndpoint {
  readonly profile: Omit<SanitizedRuntimeProfileSnapshot, "profileSnapshotKey">;
}

export interface AuthorizedRuntimeWorkOrder {
  readonly status: "authorized";
  readonly durableAcceptance: "confirmed";
  readonly workOrderDigest: string;
  readonly idempotencyKey: string;
  readonly objective: string;
  readonly input: string;
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly supervisor: AuthorizedSupervisorEndpoint;
  readonly worker: AuthorizedWorkerEndpoint;
  readonly authorization: {
    readonly accessMode: RuntimeEndpointAccessMode;
    readonly hostCapabilityCeiling: "codex-full-access" | "restricted";
    readonly budgetUnits: number;
    readonly concurrencySlots: number;
    readonly endpointConcurrencyLimit: number;
  };
  /** Eligibility only; the Module performs no start or resume effect in this slice. */
  readonly startEligibility: "eligible";
  readonly externalEffect: "not-started";
}

export type RuntimeEndpointDirectoryFailureCategory =
  | "acceptance-required"
  | "authorization-denied"
  | "capability-unavailable"
  | "idempotency-conflict"
  | "registration-invalid"
  | "selection-invalid"
  | "supervisor-binding-invalid"
  | "work-order-invalid";

export class RuntimeEndpointDirectoryError extends Error {
  readonly category: RuntimeEndpointDirectoryFailureCategory;

  constructor(category: RuntimeEndpointDirectoryFailureCategory) {
    super("Runtime Endpoint Directory operation failed.");
    this.name = "RuntimeEndpointDirectoryError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface RuntimeEndpointDirectory {
  /** Returns the same immutable exact-snapshot view for this Module instance. */
  snapshot(): RuntimeEndpointDirectorySnapshot;
  /**
   * Resolves and authorizes an already durably accepted Work Order. It never
   * starts, resumes, inspects, or otherwise invokes a registered Adapter.
   */
  authorizeAcceptedWorkOrder(
    accepted: AcceptedRuntimeWorkOrder,
    boundSupervisor: BoundSupervisorSession,
  ): AuthorizedRuntimeWorkOrder;
  /**
   * Returns one stable Adapter that resolves a Directory-scoped profile and
   * privately dispatches it to the registered endpoint Adapter.
   */
  runtimeAdapter(): ResumableAgentRuntimeAdapter;
}

interface StoredProfile {
  readonly key: RuntimeProfileSnapshotKey;
  readonly sanitized: SanitizedRuntimeProfileSnapshot;
  readonly selectionProfile: SessionProfile;
  readonly runtimeProfile: SessionProfile;
}

interface StoredEndpoint {
  readonly endpointId: string;
  readonly key: RuntimeEndpointSnapshotKey;
  readonly runtimeFamily: string;
  readonly executionLocation: RuntimeEndpointExecutionLocation;
  readonly adapter: AgentRuntimeAdapter;
  readonly capabilitySnapshot: RuntimeEndpointCapabilitySnapshotRegistration;
  readonly policy: RuntimeEndpointPolicyRegistration;
  readonly profilesByKey: ReadonlyMap<RuntimeProfileSnapshotKey, StoredProfile>;
}

interface PrivateAuthorizedResolution {
  readonly adapter: AgentRuntimeAdapter;
  readonly runtimeProfile: SessionProfile;
}

interface CachedAuthorization {
  readonly digest: string;
  readonly supervisorBindingDigest: string;
  readonly result?: AuthorizedRuntimeWorkOrder;
  readonly privateResolution?: PrivateAuthorizedResolution;
  readonly error?: RuntimeEndpointDirectoryError;
}

class RuntimeEndpointDirectoryModule implements RuntimeEndpointDirectory {
  #directorySnapshotKey: RuntimeDirectorySnapshotKey;
  #directorySnapshot: RuntimeEndpointDirectorySnapshot;
  #endpointsByKey = new Map<
    RuntimeEndpointSnapshotKey,
    StoredEndpoint
  >();
  #authorizationsByIdempotencyKey = new Map<
    string,
    CachedAuthorization
  >();
  #runtimeAdapter: ResumableAgentRuntimeAdapter | undefined;

  constructor(registrations: readonly RuntimeEndpointRegistration[]) {
    assertRuntimeEndpointRegistrations(registrations as unknown);
    this.#directorySnapshotKey = opaqueKey(
      "rtdk",
    ) as RuntimeDirectorySnapshotKey;
    const registrationIds = new Set<string>();
    const endpointIds = new Set<string>();
    const capabilitySnapshotIds = new Set<string>();
    const adapters = new Set<AgentRuntimeAdapter>();
    const privateDispatchSelections = new Set<string>();
    const sanitizedEndpoints: SanitizedRuntimeEndpointSnapshot[] = [];

    for (const registration of registrations) {
      if (
        registrationIds.has(registration.registrationId) ||
        endpointIds.has(registration.endpointId) ||
        capabilitySnapshotIds.has(registration.capabilitySnapshot.snapshotId) ||
        adapters.has(registration.adapter)
      ) {
        fail("registration-invalid");
      }
      registrationIds.add(registration.registrationId);
      endpointIds.add(registration.endpointId);
      capabilitySnapshotIds.add(registration.capabilitySnapshot.snapshotId);
      adapters.add(registration.adapter);

      const endpointKey = opaqueKey("rtek") as RuntimeEndpointSnapshotKey;
      const profilesByKey = new Map<RuntimeProfileSnapshotKey, StoredProfile>();
      const sanitizedProfiles: SanitizedRuntimeProfileSnapshot[] = [];
      for (const profile of registration.capabilitySnapshot.profiles) {
        if (profile.nativeRuntimeProfile !== undefined) {
          const dispatchSelection = JSON.stringify(profile.runtimeProfile);
          if (privateDispatchSelections.has(dispatchSelection)) {
            fail("registration-invalid");
          }
          privateDispatchSelections.add(dispatchSelection);
        }
        const profileKey = opaqueKey("rtpk") as RuntimeProfileSnapshotKey;
        const accessMode = profile.runtimeProfile
          .accessMode as RuntimeEndpointAccessMode;
        const sanitized = deepFreeze<SanitizedRuntimeProfileSnapshot>({
          profileSnapshotKey: profileKey,
          modelLabel: profile.modelLabel,
          workIntensityLabel: profile.workIntensityLabel,
          executionMode: profile.runtimeProfile.executionMode,
          accessMode,
        });
        const storedProfile: StoredProfile = {
          key: profileKey,
          sanitized,
          selectionProfile: Object.freeze({ ...profile.runtimeProfile }),
          runtimeProfile: Object.freeze({
            ...(profile.nativeRuntimeProfile ?? profile.runtimeProfile),
          }),
        };
        profilesByKey.set(profileKey, storedProfile);
        sanitizedProfiles.push(sanitized);
      }

      const capabilitySnapshot = cloneCapabilitySnapshot(
        registration.capabilitySnapshot,
      );
      const policy = clonePolicy(registration.policy);
      const sanitized = deepFreeze<SanitizedRuntimeEndpointSnapshot>({
        endpointSnapshotKey: endpointKey,
        runtimeFamily: registration.runtimeFamily,
        executionLocation: registration.executionLocation,
        freshness: capabilitySnapshot.freshness,
        availability: capabilitySnapshot.availability,
        roles: {
          supervisor: capabilitySnapshot.contracts.supervisorWorkOrders,
          worker:
            capabilitySnapshot.contracts.workerSessions &&
            capabilitySnapshot.contracts.normalizedEvents,
        },
        profiles: sanitizedProfiles,
      });
      const storedEndpoint: StoredEndpoint = {
        endpointId: registration.endpointId,
        key: endpointKey,
        runtimeFamily: registration.runtimeFamily,
        executionLocation: registration.executionLocation,
        adapter: registration.adapter,
        capabilitySnapshot,
        policy,
        profilesByKey,
      };
      this.#endpointsByKey.set(endpointKey, storedEndpoint);
      sanitizedEndpoints.push(sanitized);
    }

    this.#directorySnapshot = deepFreeze({
      directorySnapshotKey: this.#directorySnapshotKey,
      endpoints: sanitizedEndpoints,
    });
  }

  snapshot(): RuntimeEndpointDirectorySnapshot {
    return this.#directorySnapshot;
  }

  runtimeAdapter(): ResumableAgentRuntimeAdapter {
    this.#runtimeAdapter ??= createDirectoryRuntimeAdapter(
      Object.freeze([...this.#endpointsByKey.values()]),
    );
    return this.#runtimeAdapter;
  }

  authorizeAcceptedWorkOrder(
    accepted: AcceptedRuntimeWorkOrder,
    boundSupervisor: BoundSupervisorSession,
  ): AuthorizedRuntimeWorkOrder {
    assertAcceptedWorkOrder(accepted as unknown);
    assertBoundSupervisorSession(boundSupervisor as unknown);
    const workOrder = accepted.workOrder;
    const digest = digestWorkOrder(workOrder);
    const supervisorBindingDigest = digestBoundSupervisor(boundSupervisor);
    const cached = this.#authorizationsByIdempotencyKey.get(
      workOrder.idempotencyKey,
    );
    if (cached !== undefined) {
      if (
        cached.digest !== digest ||
        cached.supervisorBindingDigest !== supervisorBindingDigest
      ) {
        fail("idempotency-conflict");
      }
      if (cached.error !== undefined) throw cached.error;
      if (cached.result === undefined) fail("authorization-denied");
      return cached.result;
    }

    try {
      if (
        workOrder.directorySnapshotKey !== this.#directorySnapshotKey ||
        boundSupervisor.directorySnapshotKey !== this.#directorySnapshotKey
      ) {
        fail("selection-invalid");
      }
      const supervisorEndpoint = this.#endpointsByKey.get(
        boundSupervisor.endpointSnapshotKey,
      );
      const workerEndpoint = this.#endpointsByKey.get(
        workOrder.endpointSnapshotKey,
      );
      if (supervisorEndpoint === undefined || workerEndpoint === undefined) {
        fail("selection-invalid");
      }
      const supervisorProfile = supervisorEndpoint.profilesByKey.get(
        boundSupervisor.profileSnapshotKey,
      );
      const workerProfile = workerEndpoint.profilesByKey.get(
        workOrder.profileSnapshotKey,
      );
      if (supervisorProfile === undefined || workerProfile === undefined) {
        fail("selection-invalid");
      }
      assertEndpointAvailable(supervisorEndpoint, "supervisor");
      assertEndpointAvailable(workerEndpoint, "worker");
      if (
        !supervisorEndpoint.policy.allowedWorkerEndpointIds.includes(
          workerEndpoint.endpointId,
        ) ||
        !workerEndpoint.policy.allowedAccessModes.includes(
          workOrder.requestedAccessMode,
        ) ||
        workerProfile.sanitized.accessMode !== workOrder.requestedAccessMode ||
        workOrder.budget.units > workerEndpoint.policy.maximumBudgetUnits ||
        workOrder.concurrency.slots > workerEndpoint.policy.availableConcurrency
      ) {
        fail("authorization-denied");
      }

      const result = deepFreeze<AuthorizedRuntimeWorkOrder>({
        status: "authorized",
        durableAcceptance: "confirmed",
        workOrderDigest: digest,
        idempotencyKey: workOrder.idempotencyKey,
        objective: workOrder.objective,
        input: workOrder.input,
        directorySnapshotKey: this.#directorySnapshotKey,
        supervisor: {
          sessionKey: boundSupervisor.sessionKey,
          endpointSnapshotKey: supervisorEndpoint.key,
          profileSnapshotKey: supervisorProfile.key,
          runtimeFamily: supervisorEndpoint.runtimeFamily,
          executionLocation: supervisorEndpoint.executionLocation,
          accessMode: supervisorProfile.sanitized.accessMode,
          hostCapabilityCeiling: hostCapabilityCeiling(
            supervisorProfile.sanitized.accessMode,
          ),
        },
        worker: {
          endpointSnapshotKey: workerEndpoint.key,
          profileSnapshotKey: workerProfile.key,
          runtimeFamily: workerEndpoint.runtimeFamily,
          executionLocation: workerEndpoint.executionLocation,
          profile: {
            modelLabel: workerProfile.sanitized.modelLabel,
            workIntensityLabel: workerProfile.sanitized.workIntensityLabel,
            executionMode: workerProfile.sanitized.executionMode,
            accessMode: workerProfile.sanitized.accessMode,
          },
        },
        authorization: {
          accessMode: workOrder.requestedAccessMode,
          hostCapabilityCeiling: hostCapabilityCeiling(
            workOrder.requestedAccessMode,
          ),
          budgetUnits: workOrder.budget.units,
          concurrencySlots: workOrder.concurrency.slots,
          endpointConcurrencyLimit: workerEndpoint.policy.availableConcurrency,
        },
        startEligibility: "eligible",
        externalEffect: "not-started",
      });
      this.#authorizationsByIdempotencyKey.set(workOrder.idempotencyKey, {
        digest,
        supervisorBindingDigest,
        result,
        privateResolution: {
          adapter: workerEndpoint.adapter,
          runtimeProfile: workerProfile.runtimeProfile,
        },
      });
      return result;
    } catch (error) {
      if (error instanceof RuntimeEndpointDirectoryError) {
        this.#authorizationsByIdempotencyKey.set(workOrder.idempotencyKey, {
          digest,
          supervisorBindingDigest,
          error,
        });
      }
      throw error;
    }
  }
}

export function createRuntimeEndpointDirectory(
  registrations: readonly RuntimeEndpointRegistration[],
): RuntimeEndpointDirectory {
  return new RuntimeEndpointDirectoryModule(registrations);
}

function createDirectoryRuntimeAdapter(
  endpoints: readonly StoredEndpoint[],
): ResumableAgentRuntimeAdapter {
  const catalog = createDirectoryRuntimeCatalog(endpoints);
  return Object.freeze({
    async inspect(projectDirectory: string): Promise<RuntimeCatalog> {
      if (projectDirectory.trim().length === 0) {
        throw new RuntimeAdapterError("invalid-input");
      }
      return catalog;
    },
    async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
      const resolution = resolveDirectoryRuntimeProfile(
        endpoints,
        request.projectDirectory,
        request.profile,
      );
      let binding: RuntimeBinding;
      try {
        binding = await resolution.endpoint.adapter.start({
          projectDirectory: request.projectDirectory,
          profile: resolution.profile.runtimeProfile,
        });
      } catch (error) {
        if (error instanceof RuntimeAdapterError) throw error;
        throw new RuntimeAdapterError("runtime-unavailable");
      }
      return wrapDirectoryRuntimeBinding(
        binding,
        resolution.profile.runtimeProfile,
        resolution.profile.selectionProfile,
      );
    },
    async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
      const resolution = resolveDirectoryRuntimeProfile(
        endpoints,
        request.projectDirectory,
        request.profile,
      );
      const adapter = resolution.endpoint.adapter as {
        readonly resume?: unknown;
      };
      if (typeof adapter.resume !== "function") {
        throw new RuntimeAdapterError("unsupported-selection");
      }
      let binding: RuntimeBinding;
      try {
        binding = await adapter.resume.call(resolution.endpoint.adapter, {
          projectDirectory: request.projectDirectory,
          profile: resolution.profile.runtimeProfile,
          opaqueSessionReference: request.opaqueSessionReference,
        });
      } catch (error) {
        if (error instanceof RuntimeAdapterError) throw error;
        throw new RuntimeAdapterError("runtime-unavailable");
      }
      const wrapped = wrapDirectoryRuntimeBinding(
        binding,
        resolution.profile.runtimeProfile,
        resolution.profile.selectionProfile,
      );
      if (wrapped.opaqueSessionReference !== request.opaqueSessionReference) {
        throw new RuntimeAdapterError("correlation-invalid");
      }
      return wrapped;
    },
    continuationProfileCompatibility(
      request: RuntimeContinuationProfileCompatibilityRequest,
    ): RuntimeContinuationProfileCompatibility {
      if (
        !isExactRecord(request, [
          "currentProfile",
          "projectDirectory",
          "requestedProfile",
        ]) ||
        !isBoundedText(request.projectDirectory, 1, 32_768) ||
        !isSessionProfile(request.currentProfile) ||
        !isSessionProfile(request.requestedProfile)
      ) {
        throw new RuntimeAdapterError("invalid-input");
      }
      const current = resolveDirectoryRuntimeProfileSelection(
        endpoints,
        request.currentProfile,
      );
      let requested: ReturnType<typeof resolveDirectoryRuntimeProfileSelection>;
      try {
        requested = resolveDirectoryRuntimeProfileSelection(
          endpoints,
          request.requestedProfile,
        );
      } catch (error) {
        if (
          error instanceof RuntimeAdapterError &&
          error.category === "unsupported-selection"
        ) {
          return "incompatible";
        }
        throw error;
      }
      return current.endpoint === requested.endpoint &&
        current.profile.selectionProfile.executionMode ===
          requested.profile.selectionProfile.executionMode &&
        current.profile.selectionProfile.accessMode ===
          requested.profile.selectionProfile.accessMode
        ? "compatible"
        : "incompatible";
    },
  });
}

function createDirectoryRuntimeCatalog(
  endpoints: readonly StoredEndpoint[],
): RuntimeCatalog {
  const models = new Map<
    string,
    {
      readonly displayName: string;
      readonly efforts: Map<string, string>;
    }
  >();
  const executionModes = new Set<string>();
  const accessModes = new Set<string>();

  for (const endpoint of endpoints) {
    if (
      endpoint.capabilitySnapshot.freshness !== "fresh" ||
      endpoint.capabilitySnapshot.availability !== "online"
    ) {
      continue;
    }
    for (const profile of endpoint.profilesByKey.values()) {
      const selection = profile.selectionProfile;
      let model = models.get(selection.model);
      if (model === undefined) {
        model = {
          displayName: profile.sanitized.modelLabel,
          efforts: new Map<string, string>(),
        };
        models.set(selection.model, model);
      } else if (model.displayName !== profile.sanitized.modelLabel) {
        throw new RuntimeAdapterError("catalog-invalid");
      }
      const existingEffortLabel = model.efforts.get(selection.effortLevel);
      if (
        existingEffortLabel !== undefined &&
        existingEffortLabel !== profile.sanitized.workIntensityLabel
      ) {
        throw new RuntimeAdapterError("catalog-invalid");
      }
      model.efforts.set(
        selection.effortLevel,
        profile.sanitized.workIntensityLabel,
      );
      executionModes.add(selection.executionMode);
      accessModes.add(selection.accessMode);
    }
  }

  return deepFreeze<RuntimeCatalog>({
    runtime: "runtime-endpoint-directory",
    models: [...models.entries()].map(([id, model]) => ({
      id,
      displayName: model.displayName,
      effortLevels: [...model.efforts.keys()],
      effortLevelLabels: [...model.efforts.values()],
    })),
    executionModes: [...executionModes],
    accessModes: [...accessModes],
  });
}

function resolveDirectoryRuntimeProfile(
  endpoints: readonly StoredEndpoint[],
  projectDirectory: string,
  selection: SessionProfile,
): { readonly endpoint: StoredEndpoint; readonly profile: StoredProfile } {
  if (projectDirectory.trim().length === 0) {
    throw new RuntimeAdapterError("invalid-input");
  }
  return resolveDirectoryRuntimeProfileSelection(endpoints, selection);
}

function resolveDirectoryRuntimeProfileSelection(
  endpoints: readonly StoredEndpoint[],
  selection: SessionProfile,
): { readonly endpoint: StoredEndpoint; readonly profile: StoredProfile } {
  if (!isSessionProfile(selection)) {
    throw new RuntimeAdapterError("invalid-input");
  }
  const matches: {
    readonly endpoint: StoredEndpoint;
    readonly profile: StoredProfile;
  }[] = [];
  for (const endpoint of endpoints) {
    if (
      endpoint.capabilitySnapshot.freshness !== "fresh" ||
      endpoint.capabilitySnapshot.availability !== "online"
    ) {
      continue;
    }
    for (const profile of endpoint.profilesByKey.values()) {
      if (sameSessionProfile(profile.selectionProfile, selection)) {
        matches.push({ endpoint, profile });
      }
    }
  }
  if (matches.length !== 1) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
  return matches[0]!;
}

function wrapDirectoryRuntimeBinding(
  binding: RuntimeBinding,
  expectedNativeProfile: SessionProfile,
  selectionProfile: SessionProfile,
): ResumableRuntimeBinding {
  const initialProfile = cloneExactSessionProfile(binding.profile);
  if (
    initialProfile === undefined ||
    !sameSessionProfile(initialProfile, expectedNativeProfile) ||
    !("opaqueSessionReference" in binding) ||
    typeof binding.opaqueSessionReference !== "string" ||
    binding.opaqueSessionReference.trim().length === 0
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const opaqueSessionReference = binding.opaqueSessionReference;
  const steer = binding.steer;
  const steerAvailability = binding.steerAvailability;
  const interrupt = binding.interrupt;
  const interruptAvailability = binding.interruptAvailability;
  const effectiveProfile = binding.effectiveProfile;
  return Object.freeze({
    profile: Object.freeze({ ...selectionProfile }),
    opaqueSessionReference,
    send: (input: RuntimeInput) => binding.send(input),
    ...(typeof steer === "function"
      ? { steer: (input: RuntimeInput) => steer.call(binding, input) }
      : {}),
    ...(typeof steerAvailability === "function"
      ? {
          steerAvailability: () => steerAvailability.call(binding),
        }
      : {}),
    ...(typeof interrupt === "function"
      ? { interrupt: () => interrupt.call(binding) }
      : {}),
    ...(typeof interruptAvailability === "function"
      ? {
          interruptAvailability: () =>
            interruptAvailability.call(binding),
        }
      : {}),
    ...(typeof effectiveProfile === "function"
      ? {
          effectiveProfile: () => {
            const observed = effectiveProfile.call(binding);
            if (observed === undefined) return undefined;
            const observedProfile = cloneExactSessionProfile(observed);
            if (
              observedProfile === undefined ||
              !sameSessionProfile(observedProfile, expectedNativeProfile)
            ) {
              throw new RuntimeAdapterError("unsupported-selection");
            }
            return Object.freeze({ ...selectionProfile });
          },
        }
      : {}),
    events: () => binding.events(),
  });
}

function cloneExactSessionProfile(value: unknown): SessionProfile | undefined {
  if (!isSessionProfile(value)) return undefined;
  try {
    const cloned = structuredClone(value);
    if (!isSessionProfile(cloned)) return undefined;
    return Object.freeze({
      model: cloned.model,
      effortLevel: cloned.effortLevel,
      executionMode: cloned.executionMode,
      accessMode: cloned.accessMode,
    });
  } catch {
    return undefined;
  }
}

function sameSessionProfile(left: SessionProfile, right: SessionProfile): boolean {
  return (
    left.model === right.model &&
    left.effortLevel === right.effortLevel &&
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function assertEndpointAvailable(
  endpoint: StoredEndpoint,
  role: "supervisor" | "worker",
): void {
  if (
    endpoint.capabilitySnapshot.freshness !== "fresh" ||
    endpoint.capabilitySnapshot.availability !== "online" ||
    (role === "supervisor" &&
      !endpoint.capabilitySnapshot.contracts.supervisorWorkOrders) ||
    (role === "worker" &&
      (!endpoint.capabilitySnapshot.contracts.workerSessions ||
        !endpoint.capabilitySnapshot.contracts.normalizedEvents))
  ) {
    fail("capability-unavailable");
  }
}

function cloneCapabilitySnapshot(
  snapshot: RuntimeEndpointCapabilitySnapshotRegistration,
): RuntimeEndpointCapabilitySnapshotRegistration {
  return deepFreeze({
    snapshotId: snapshot.snapshotId,
    freshness: snapshot.freshness,
    availability: snapshot.availability,
    contracts: { ...snapshot.contracts },
    profiles: snapshot.profiles.map((profile) => ({
      profileId: profile.profileId,
      modelLabel: profile.modelLabel,
      workIntensityLabel: profile.workIntensityLabel,
      runtimeProfile: { ...profile.runtimeProfile },
      ...(profile.nativeRuntimeProfile === undefined
        ? {}
        : { nativeRuntimeProfile: { ...profile.nativeRuntimeProfile } }),
    })),
  });
}

function clonePolicy(
  policy: RuntimeEndpointPolicyRegistration,
): RuntimeEndpointPolicyRegistration {
  return deepFreeze({
    maximumBudgetUnits: policy.maximumBudgetUnits,
    availableConcurrency: policy.availableConcurrency,
    allowedAccessModes: [...policy.allowedAccessModes],
    allowedWorkerEndpointIds: [...policy.allowedWorkerEndpointIds],
  });
}

function digestWorkOrder(workOrder: RuntimeNeutralWorkOrder): string {
  const canonical = JSON.stringify({
    idempotencyKey: workOrder.idempotencyKey,
    objective: workOrder.objective,
    input: workOrder.input,
    directorySnapshotKey: workOrder.directorySnapshotKey,
    endpointSnapshotKey: workOrder.endpointSnapshotKey,
    profileSnapshotKey: workOrder.profileSnapshotKey,
    requestedAccessMode: workOrder.requestedAccessMode,
    budget: { units: workOrder.budget.units },
    concurrency: { slots: workOrder.concurrency.slots },
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function digestBoundSupervisor(
  boundSupervisor: BoundSupervisorSession,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionKey: boundSupervisor.sessionKey,
        directorySnapshotKey: boundSupervisor.directorySnapshotKey,
        endpointSnapshotKey: boundSupervisor.endpointSnapshotKey,
        profileSnapshotKey: boundSupervisor.profileSnapshotKey,
      }),
      "utf8",
    )
    .digest("hex");
}

function hostCapabilityCeiling(
  accessMode: RuntimeEndpointAccessMode,
): "codex-full-access" | "restricted" {
  return accessMode === "full-access" ? "codex-full-access" : "restricted";
}

function assertAcceptedWorkOrder(
  value: unknown,
): asserts value is AcceptedRuntimeWorkOrder {
  if (
    !isExactRecord(value, ["state", "workOrder"]) ||
    value.state !== "accepted"
  ) {
    fail("acceptance-required");
  }
  assertRuntimeNeutralWorkOrder(value.workOrder);
}

function assertRuntimeEndpointRegistrations(
  value: unknown,
): asserts value is readonly RuntimeEndpointRegistration[] {
  if (!isDenseArray(value) || value.length === 0) {
    fail("registration-invalid");
  }
  const endpointIds = new Set<string>();
  const registrations: RuntimeEndpointRegistration[] = [];
  for (const candidate of value) {
    if (
      !isExactRecord(candidate, [
        "registrationId",
        "endpointId",
        "runtimeFamily",
        "executionLocation",
        "adapter",
        "capabilitySnapshot",
        "policy",
      ]) ||
      !isBoundedIdentifier(candidate.registrationId, 1, 160) ||
      !isBoundedIdentifier(candidate.endpointId, 1, 160) ||
      !isSanitizedDisplayText(candidate.runtimeFamily, 1, 120) ||
      (candidate.executionLocation !== "local" &&
        candidate.executionLocation !== "remote-backed") ||
      !hasAdapterInterface(candidate.adapter) ||
      !isCapabilitySnapshotRegistration(candidate.capabilitySnapshot) ||
      !isPolicyRegistration(candidate.policy)
    ) {
      fail("registration-invalid");
    }
    for (const profile of candidate.capabilitySnapshot.profiles) {
      if (
        !candidate.policy.allowedAccessModes.includes(
          profile.runtimeProfile.accessMode as RuntimeEndpointAccessMode,
        ) ||
        (profile.nativeRuntimeProfile !== undefined &&
          !runtimeProfileProjectionPreservesLockedModes(
            candidate.endpointId,
            profile.runtimeProfile,
            profile.nativeRuntimeProfile,
          ))
      ) {
        fail("registration-invalid");
      }
    }
    endpointIds.add(candidate.endpointId);
    registrations.push(candidate as unknown as RuntimeEndpointRegistration);
  }
  for (const registration of registrations) {
    if (
      registration.policy.allowedWorkerEndpointIds.some(
        (endpointId) => !endpointIds.has(endpointId),
      )
    ) {
      fail("registration-invalid");
    }
  }
}

function isCapabilitySnapshotRegistration(
  value: unknown,
): value is RuntimeEndpointCapabilitySnapshotRegistration {
  if (
    !isExactRecord(value, [
      "snapshotId",
      "freshness",
      "availability",
      "contracts",
      "profiles",
    ]) ||
    !isBoundedIdentifier(value.snapshotId, 1, 160) ||
    (value.freshness !== "fresh" && value.freshness !== "stale") ||
    (value.availability !== "online" && value.availability !== "offline") ||
    !isExactRecord(value.contracts, [
      "supervisorWorkOrders",
      "workerSessions",
      "normalizedEvents",
    ]) ||
    typeof value.contracts.supervisorWorkOrders !== "boolean" ||
    typeof value.contracts.workerSessions !== "boolean" ||
    typeof value.contracts.normalizedEvents !== "boolean" ||
    !isDenseArray(value.profiles) ||
    value.profiles.length === 0
  ) {
    return false;
  }
  const profileIds = new Set<string>();
  for (const profile of value.profiles) {
    if (
      !isRecordWithOptionalKeys(
        profile,
        [
          "profileId",
          "modelLabel",
          "workIntensityLabel",
          "runtimeProfile",
        ],
        ["nativeRuntimeProfile"],
      ) ||
      !isBoundedIdentifier(profile.profileId, 1, 160) ||
      profileIds.has(profile.profileId) ||
      !isSanitizedDisplayText(profile.modelLabel, 1, 200) ||
      !isSanitizedDisplayText(profile.workIntensityLabel, 1, 120) ||
      !isSessionProfile(profile.runtimeProfile) ||
      (profile.nativeRuntimeProfile !== undefined &&
        !isSessionProfile(profile.nativeRuntimeProfile))
    ) {
      return false;
    }
    profileIds.add(profile.profileId);
  }
  return true;
}

function isSessionProfile(value: unknown): value is SessionProfile {
  return (
    isExactRecord(value, [
      "model",
      "effortLevel",
      "executionMode",
      "accessMode",
    ]) &&
    isBoundedText(value.model, 1, 240) &&
    isBoundedText(value.effortLevel, 1, 120) &&
    isSanitizedDisplayText(value.executionMode, 1, 120) &&
    (value.accessMode === "full-access" || value.accessMode === "restricted")
  );
}

function isPolicyRegistration(
  value: unknown,
): value is RuntimeEndpointPolicyRegistration {
  if (
    !isExactRecord(value, [
      "maximumBudgetUnits",
      "availableConcurrency",
      "allowedAccessModes",
      "allowedWorkerEndpointIds",
    ]) ||
    !isBoundedInteger(value.maximumBudgetUnits, 0, 1_000_000_000) ||
    !isBoundedInteger(value.availableConcurrency, 0, 1_000_000) ||
    !isDenseArray(value.allowedAccessModes) ||
    value.allowedAccessModes.length === 0 ||
    value.allowedAccessModes.some(
      (accessMode) =>
        accessMode !== "full-access" && accessMode !== "restricted",
    ) ||
    new Set(value.allowedAccessModes).size !== value.allowedAccessModes.length ||
    !isDenseArray(value.allowedWorkerEndpointIds) ||
    value.allowedWorkerEndpointIds.some(
      (endpointId) => !isBoundedIdentifier(endpointId, 1, 160),
    ) ||
    new Set(value.allowedWorkerEndpointIds).size !==
      value.allowedWorkerEndpointIds.length
  ) {
    return false;
  }
  return true;
}

function hasAdapterInterface(value: unknown): value is AgentRuntimeAdapter {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    hasDataMethod(value, "inspect") &&
    hasDataMethod(value, "start")
  );
}

function hasDataMethod(value: object, name: string): boolean {
  try {
    let candidate: object | null = value;
    while (candidate !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, name);
      if (descriptor !== undefined) {
        return (
          Object.prototype.hasOwnProperty.call(descriptor, "value") &&
          typeof descriptor.value === "function"
        );
      }
      candidate = Object.getPrototypeOf(candidate) as object | null;
    }
    return false;
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  try {
    if (!Array.isArray(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1) return false;
    return keys.every((key) => {
      if (key === "length") return true;
      if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
        return false;
      }
      const index = Number(key);
      return Number.isSafeInteger(index) && index >= 0 && index < value.length;
    });
  } catch {
    return false;
  }
}

function assertRuntimeNeutralWorkOrder(
  value: unknown,
): asserts value is RuntimeNeutralWorkOrder {
  if (
    !isExactRecord(value, [
      "idempotencyKey",
      "objective",
      "input",
      "directorySnapshotKey",
      "endpointSnapshotKey",
      "profileSnapshotKey",
      "requestedAccessMode",
      "budget",
      "concurrency",
    ]) ||
    !isBoundedIdentifier(
      value.idempotencyKey,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.idempotencyKey.minimumLength,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.idempotencyKey.maximumLength,
    ) ||
    !isBoundedText(
      value.objective,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.objective.minimumLength,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.objective.maximumLength,
    ) ||
    !isBoundedText(
      value.input,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.input.minimumLength,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.input.maximumLength,
    ) ||
    (value.requestedAccessMode !== "full-access" &&
      value.requestedAccessMode !== "restricted") ||
    !isExactRecord(value.budget, ["units"]) ||
    !isBoundedInteger(
      value.budget.units,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.budgetUnits.minimum,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.budgetUnits.maximum,
    ) ||
    !isExactRecord(value.concurrency, ["slots"]) ||
    !isBoundedInteger(
      value.concurrency.slots,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.concurrencySlots.minimum,
      RUNTIME_NEUTRAL_WORK_ORDER_LIMITS.concurrencySlots.maximum,
    )
  ) {
    fail("work-order-invalid");
  }
  if (
    !isOpaqueKey(value.directorySnapshotKey, "rtdk") ||
    !isOpaqueKey(value.endpointSnapshotKey, "rtek") ||
    !isOpaqueKey(value.profileSnapshotKey, "rtpk")
  ) {
    fail("selection-invalid");
  }
}

function assertBoundSupervisorSession(
  value: unknown,
): asserts value is BoundSupervisorSession {
  if (
    !isExactRecord(value, [
      "sessionKey",
      "directorySnapshotKey",
      "endpointSnapshotKey",
      "profileSnapshotKey",
    ]) ||
    !isBoundedIdentifier(value.sessionKey, 8, 128)
  ) {
    fail("supervisor-binding-invalid");
  }
  if (
    !isOpaqueKey(value.directorySnapshotKey, "rtdk") ||
    !isOpaqueKey(value.endpointSnapshotKey, "rtek") ||
    !isOpaqueKey(value.profileSnapshotKey, "rtpk")
  ) {
    fail("selection-invalid");
  }
}

function isRecordWithOptionalKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  let keys: string[];
  try {
    const reflected = Reflect.ownKeys(value);
    if (reflected.some((key) => typeof key !== "string")) return false;
    keys = reflected as string[];
  } catch {
    return false;
  }
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some(
      (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key),
    )
  ) {
    return false;
  }
  return isExactRecord(value, keys);
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key),
      )
    ) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
      );
    });
  } catch {
    return false;
  }
}

function isBoundedIdentifier(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isBoundedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

function isSanitizedDisplayText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return (
    isBoundedText(value, minimumLength, maximumLength) &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) &&
    !/^Bearer\s+\S+/iu.test(value) &&
    !/-----BEGIN [A-Z ]+-----/u.test(value) &&
    !/(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu.test(value)
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isOpaqueKey(
  value: unknown,
  prefix: "rtdk" | "rtek" | "rtpk",
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{32}$`, "u").test(value)
  );
}

function opaqueKey(prefix: "rtdk" | "rtek" | "rtpk"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function fail(category: RuntimeEndpointDirectoryFailureCategory): never {
  throw new RuntimeEndpointDirectoryError(category);
}
