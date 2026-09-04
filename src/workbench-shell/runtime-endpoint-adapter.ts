import { types as nodeUtilTypes } from "node:util";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../agent-runtime/index.ts";
import {
  runtimeProfileProjectionPreservesLockedModes,
} from "../agent-runtime/runtime-profile-projection.ts";
import type { ProjectRuntimeResumeIdentityMapping } from "../coordinator/types.ts";
import type { DirectSessionProfileCatalog } from "./direct-session-profile-snapshot.ts";
import {
  publicRuntimeEndpointDiscovery,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointId,
} from "./contract.ts";

export interface WorkbenchDirectRuntimeEndpointCatalog {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly preferenceKey: string;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly catalog: DirectSessionProfileCatalog;
  readonly desiredDefault?: SessionProfile;
  readonly directStart: "supported" | "inspect-only";
}

export interface WorkbenchDirectRuntimeEndpointSnapshot {
  readonly endpoints: readonly WorkbenchDirectRuntimeEndpointCatalog[];
  readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
}

export interface WorkbenchContinuationRuntimeResumeContext {
  readonly recordedProfile: SessionProfile;
  readonly runtimeResumeIdentities: readonly ProjectRuntimeResumeIdentityMapping[];
}

export interface WorkbenchResolvedRuntimeResumeIdentity {
  readonly schemaVersion: 1;
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly nativeProfile: SessionProfile;
}

export type WorkbenchDirectRuntimeEndpointLoader = (
  projectDirectory: string,
  requestKind: WorkbenchDirectSessionProfileLoadRequest["kind"],
  continuationContext?: WorkbenchContinuationRuntimeResumeContext,
) => Promise<WorkbenchDirectRuntimeEndpointSnapshot>;

export type WorkbenchRuntimeResumeIdentityResolver = (
  projectDirectory: string,
  selectionProfile: SessionProfile,
) => WorkbenchResolvedRuntimeResumeIdentity | undefined;

const endpointLoaderByAdapter = new WeakMap<
  ResumableAgentRuntimeAdapter,
  WorkbenchDirectRuntimeEndpointLoader
>();
const runtimeResumeIdentityResolverByAdapter = new WeakMap<
  ResumableAgentRuntimeAdapter,
  WorkbenchRuntimeResumeIdentityResolver
>();

export function createWorkbenchRuntimeEndpointAdapter(
  delegate: ResumableAgentRuntimeAdapter,
  loadEndpoints: WorkbenchDirectRuntimeEndpointLoader,
  resolveRuntimeResumeIdentity?: WorkbenchRuntimeResumeIdentityResolver,
): ResumableAgentRuntimeAdapter {
  const compatibility = delegate.continuationProfileCompatibility;
  const adapter: ResumableAgentRuntimeAdapter = Object.freeze({
    inspect: (projectDirectory: string) => delegate.inspect(projectDirectory),
    start: (request: RuntimeStart) => delegate.start(request),
    resume: (request: RuntimeResume) => delegate.resume(request),
    ...(typeof compatibility === "function"
      ? {
          continuationProfileCompatibility: (
            request: Parameters<NonNullable<ResumableAgentRuntimeAdapter["continuationProfileCompatibility"]>>[0],
          ) => compatibility.call(delegate, request),
        }
      : {}),
  });
  endpointLoaderByAdapter.set(
    adapter,
    async (projectDirectory, requestKind, continuationContext) => {
      if (
        typeof projectDirectory !== "string" ||
        projectDirectory.length === 0 ||
        projectDirectory.includes("\0") ||
        !isLoadRequestKind(requestKind)
      ) {
        throw new TypeError("invalid-runtime-endpoint-load-request");
      }
      const exactContinuationContext = reconstructContinuationContext(
        requestKind,
        continuationContext,
      );
      return freezeEndpointSnapshot(
        await loadEndpoints(
          projectDirectory,
          requestKind,
          exactContinuationContext,
        ),
      );
    },
  );
  if (resolveRuntimeResumeIdentity !== undefined) {
    runtimeResumeIdentityResolverByAdapter.set(
      adapter,
      (projectDirectory, selectionProfile) => {
        if (
          typeof projectDirectory !== "string" ||
          projectDirectory.length === 0 ||
          projectDirectory.includes("\0") ||
          !isSessionProfile(selectionProfile)
        ) {
          throw new TypeError("invalid-runtime-resume-identity-request");
        }
        const resolved = resolveRuntimeResumeIdentity(
          projectDirectory,
          cloneProfile(selectionProfile),
        );
        if (resolved === undefined) return undefined;
        if (
          !isExactDataRecord(resolved, [
            "endpointId",
            "nativeProfile",
            "schemaVersion",
          ]) ||
          resolved.schemaVersion !== 1 ||
          !isRuntimeEndpointId(resolved.endpointId) ||
          !isSessionProfile(resolved.nativeProfile) ||
          !runtimeProfileProjectionPreservesLockedModes(
            resolved.endpointId,
            selectionProfile,
            resolved.nativeProfile,
          )
        ) {
          throw new TypeError("invalid-runtime-resume-identity");
        }
        return Object.freeze({
          schemaVersion: 1 as const,
          endpointId: resolved.endpointId,
          nativeProfile: cloneProfile(resolved.nativeProfile),
        });
      },
    );
  }
  return adapter;
}

function isLoadRequestKind(
  value: unknown,
): value is WorkbenchDirectSessionProfileLoadRequest["kind"] {
  return (
    value === "catalog-default" ||
    value === "replacement-session" ||
    value === "continuation-session"
  );
}

export function readWorkbenchDirectRuntimeEndpoints(
  adapter: ResumableAgentRuntimeAdapter,
): WorkbenchDirectRuntimeEndpointLoader | undefined {
  return endpointLoaderByAdapter.get(adapter);
}

export function readWorkbenchRuntimeResumeIdentityResolver(
  adapter: ResumableAgentRuntimeAdapter,
): WorkbenchRuntimeResumeIdentityResolver | undefined {
  return runtimeResumeIdentityResolverByAdapter.get(adapter);
}

function reconstructContinuationContext(
  requestKind: WorkbenchDirectSessionProfileLoadRequest["kind"],
  value: WorkbenchContinuationRuntimeResumeContext | undefined,
): WorkbenchContinuationRuntimeResumeContext | undefined {
  if (value === undefined) return undefined;
  if (
    requestKind !== "continuation-session" ||
    !isExactDataRecord(value, [
      "recordedProfile",
      "runtimeResumeIdentities",
    ]) ||
    !isSessionProfile(value.recordedProfile) ||
    !isDenseArray(value.runtimeResumeIdentities)
  ) {
    throw new TypeError("invalid-runtime-resume-context");
  }
  const mappings = value.runtimeResumeIdentities.map((mapping) => {
    if (
      !isExactDataRecord(mapping, [
        "endpointId",
        "nativeProfile",
        "selectionProfile",
      ]) ||
      !isRuntimeEndpointId(mapping.endpointId) ||
      !isSessionProfile(mapping.selectionProfile) ||
      !isSessionProfile(mapping.nativeProfile) ||
      !runtimeProfileProjectionPreservesLockedModes(
        mapping.endpointId,
        mapping.selectionProfile,
        mapping.nativeProfile,
      )
    ) {
      throw new TypeError("invalid-runtime-resume-context");
    }
    return Object.freeze({
      endpointId: mapping.endpointId,
      selectionProfile: cloneProfile(mapping.selectionProfile),
      nativeProfile: cloneProfile(mapping.nativeProfile),
    });
  });
  return Object.freeze({
    recordedProfile: cloneProfile(value.recordedProfile),
    runtimeResumeIdentities: Object.freeze(mappings),
  });
}

function freezeEndpointSnapshot(
  value: WorkbenchDirectRuntimeEndpointSnapshot,
): WorkbenchDirectRuntimeEndpointSnapshot {
  if (
    !isExactDataRecord(value, ["endpointDiscovery", "endpoints"]) ||
    !isDenseArray(value.endpoints) ||
    value.endpoints.length > 2 ||
    !isExactDataRecord(value.endpointDiscovery, ["statuses"]) ||
    !isDenseArray(value.endpointDiscovery.statuses) ||
    value.endpointDiscovery.statuses.length !== 2
  ) {
    throw new TypeError("invalid-runtime-endpoint-snapshot");
  }
  const codexStatus = value.endpointDiscovery.statuses[0];
  const claudeStatus = value.endpointDiscovery.statuses[1];
  if (
    !isExactDataRecord(codexStatus, ["category", "endpointId"]) ||
    codexStatus.endpointId !== "codex-desktop" ||
    !isDiscoveryCategory(codexStatus.category) ||
    !isExactDataRecord(claudeStatus, ["category", "endpointId"]) ||
    claudeStatus.endpointId !== "claude-code-desktop" ||
    !isDiscoveryCategory(claudeStatus.category)
  ) {
    throw new TypeError("invalid-runtime-endpoint-discovery");
  }
  const endpointIds = new Set<WorkbenchRuntimeEndpointId>();
  let previousOrdinal = -1;
  const endpoints = value.endpoints.map((endpoint) => {
    if (nodeUtilTypes.isProxy(endpoint)) {
      throw new TypeError("invalid-runtime-endpoint-catalog");
    }
    const hasDesiredDefault = Object.prototype.hasOwnProperty.call(
      endpoint,
      "desiredDefault",
    );
    if (
      !isExactDataRecord(
        endpoint,
        hasDesiredDefault
          ? [
              "catalog",
              "desiredDefault",
              "directStart",
              "endpointId",
              "endpointLabel",
              "preferenceKey",
              "runtimeFamilyLabel",
            ]
          : [
              "catalog",
              "directStart",
              "endpointId",
              "endpointLabel",
              "preferenceKey",
              "runtimeFamilyLabel",
            ],
      ) ||
      !isRuntimeEndpointId(endpoint.endpointId) ||
      endpointIds.has(endpoint.endpointId) ||
      typeof endpoint.preferenceKey !== "string" ||
      typeof endpoint.runtimeFamilyLabel !== "string" ||
      typeof endpoint.endpointLabel !== "string" ||
      typeof endpoint.catalog !== "object" ||
      endpoint.catalog === null ||
      !isStableNonProxyDataGraph(endpoint.catalog) ||
      (endpoint.directStart !== "supported" &&
        endpoint.directStart !== "inspect-only")
    ) {
      throw new TypeError("invalid-runtime-endpoint-catalog");
    }
    const ordinal = endpoint.endpointId === "codex-desktop" ? 0 : 1;
    if (ordinal <= previousOrdinal) {
      throw new TypeError("invalid-runtime-endpoint-order");
    }
    previousOrdinal = ordinal;
    endpointIds.add(endpoint.endpointId);
    let desiredDefault: SessionProfile | undefined;
    if (hasDesiredDefault) {
      if (
        !isExactDataRecord(endpoint.desiredDefault, [
          "accessMode",
          "effortLevel",
          "executionMode",
          "model",
        ]) ||
        typeof endpoint.desiredDefault.model !== "string" ||
        typeof endpoint.desiredDefault.effortLevel !== "string" ||
        typeof endpoint.desiredDefault.executionMode !== "string" ||
        typeof endpoint.desiredDefault.accessMode !== "string"
      ) {
        throw new TypeError("invalid-runtime-endpoint-default");
      }
      desiredDefault = Object.freeze({
        model: endpoint.desiredDefault.model,
        effortLevel: endpoint.desiredDefault.effortLevel,
        executionMode: endpoint.desiredDefault.executionMode,
        accessMode: endpoint.desiredDefault.accessMode,
      });
    }
    return Object.freeze({
      endpointId: endpoint.endpointId,
      preferenceKey: endpoint.preferenceKey,
      runtimeFamilyLabel: endpoint.runtimeFamilyLabel,
      endpointLabel: endpoint.endpointLabel,
      catalog: endpoint.catalog,
      ...(desiredDefault === undefined ? {} : { desiredDefault }),
      directStart: endpoint.directStart,
    });
  });
  const readyIds = value.endpointDiscovery.statuses
    .filter((status) => status.category === "catalog-ready")
    .map((status) => status.endpointId);
  if (
    readyIds.length !== endpoints.length ||
    readyIds.some((endpointId, index) => endpointId !== endpoints[index]?.endpointId)
  ) {
    throw new TypeError("incoherent-runtime-endpoint-snapshot");
  }
  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      codexStatus.category,
      claudeStatus.category,
    ),
  });
}

function isRuntimeEndpointId(value: unknown): value is WorkbenchRuntimeEndpointId {
  return value === "codex-desktop" || value === "claude-code-desktop";
}

function isSessionProfile(value: unknown): value is SessionProfile {
  return (
    isExactDataRecord(value, [
      "accessMode",
      "effortLevel",
      "executionMode",
      "model",
    ]) &&
    isSafeText(value.model, 240) &&
    isSafeText(value.effortLevel, 120) &&
    isSafeText(value.executionMode, 120) &&
    isSafeText(value.accessMode, 120)
  );
}

function cloneProfile(value: SessionProfile): SessionProfile {
  return Object.freeze({
    model: value.model,
    effortLevel: value.effortLevel,
    executionMode: value.executionMode,
    accessMode: value.accessMode,
  });
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isDiscoveryCategory(value: unknown): value is
  WorkbenchRuntimeEndpointDiscovery["statuses"][number]["category"] {
  return (
    value === "catalog-ready" ||
    value === "runtime-not-located" ||
    value === "authentication-required" ||
    value === "inspection-failed" ||
    value === "not-inspected"
  );
}

function isExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  try {
    if (
      nodeUtilTypes.isProxy(value) ||
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return false;
    }
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ];
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      keys.every((key) => typeof key === "string" && expectedKeys.includes(key)) &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function isStableNonProxyDataGraph(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): boolean => {
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) {
      return true;
    }
    if (nodeUtilTypes.isProxy(candidate)) return false;
    if (seen.has(candidate)) return true;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !visit(descriptor.value)
      ) {
        return false;
      }
    }
    return true;
  };
  try {
    return visit(value);
  } catch {
    return false;
  }
}
