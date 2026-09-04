import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type {
  RuntimeCatalog,
  RuntimeModel,
  SessionProfile,
} from "../agent-runtime/index.ts";
import type { RequestedSessionProfileProjection } from "../coordinator/index.ts";
import type {
  WorkbenchDirectSessionProfileSelection,
  WorkbenchModelOption,
  WorkbenchRuntimeEndpointOption,
  WorkbenchRuntimeEndpointDiscovery,
  WorkbenchRuntimeEndpointId,
  WorkbenchSessionProfileOption,
  WorkbenchWorkIntensityOption,
  WorkbenchCatalogDefaultPublicProfileResult,
  WorkbenchReplacementPrefill,
} from "./contract.ts";
import { publicRuntimeEndpointDiscovery } from "./contract.ts";
import { workbenchModelPresentationLabel } from "./model-presentation.ts";

const opaqueEffortSelectionCatalogRuntime = "runtime-endpoint-directory";
const manualReplacementPrefill = Object.freeze({
  kind: "manual-selection-required" as const,
});

export interface WorkIntensityExecutionModeCoupling {
  readonly model: string;
  readonly workIntensity: string;
  readonly executionMode: SessionProfile["executionMode"];
}

export interface DirectSessionProfileCatalog extends RuntimeCatalog {
  readonly workIntensityExecutionModeCouplings?: readonly WorkIntensityExecutionModeCoupling[];
}

export interface DirectSessionProfileEndpointCatalog {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly catalog: DirectSessionProfileCatalog;
  readonly catalogRevision: string;
  readonly executionModeLabels: readonly string[];
  readonly accessModeLabels: readonly string[];
}

export interface DirectSessionProfileDesiredDefault {
  readonly endpointIndex: number;
  readonly profile: SessionProfile;
}

export interface ResolvedDirectSessionProfileSelection {
  readonly endpointIndex: number;
  readonly catalogRevision: string;
  readonly profile: SessionProfile;
  readonly requestedProfileProjection: RequestedSessionProfileProjection;
}

export interface DirectSessionProfileSnapshot {
  readonly publicResult: Extract<
    WorkbenchCatalogDefaultPublicProfileResult,
    { readonly ok: true }
  >;
  resolveSelection(
    selection: WorkbenchDirectSessionProfileSelection,
  ): ResolvedDirectSessionProfileSelection | undefined;
  resolveReplacementPrefill(
    recordedProfile: SessionProfile,
  ): WorkbenchReplacementPrefill;
  withDesiredDefault(
    selection: WorkbenchDirectSessionProfileSelection,
  ): DirectSessionProfileSnapshot;
}

interface ModelRelation {
  readonly key: string;
  readonly model: string;
  readonly workIntensities: readonly {
    readonly key: string;
    readonly effortLevel: string;
    readonly impliedExecutionMode?: {
      readonly key: string;
      readonly value: SessionProfile["executionMode"];
    };
  }[];
}

interface EndpointRelation {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly key: string;
  readonly catalogRevision: string;
  readonly models: readonly ModelRelation[];
  readonly executionModes: readonly {
    readonly key: string;
    readonly value: SessionProfile["executionMode"];
  }[];
  readonly accessModes: readonly {
    readonly key: string;
    readonly value: SessionProfile["accessMode"];
  }[];
}

type CatalogModelPresentationState =
  | {
      readonly kind: "display-complete" | "display-sparse-valid";
      readonly modelLabel: string;
      readonly provenanceLabel: string | null;
      readonly effortLabels: readonly string[];
    }
  | { readonly kind: "catalog-malformed" };

type ResolvedDesiredDefault = Omit<
  WorkbenchDirectSessionProfileSelection,
  "snapshotKey"
> & { readonly kind: "resolved" };

export function createDirectSessionProfileSnapshot(options: {
  readonly endpoints: readonly DirectSessionProfileEndpointCatalog[];
  readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
  readonly desiredDefault?: DirectSessionProfileDesiredDefault;
}): DirectSessionProfileSnapshot {
  if (!isStableNonProxyDataGraph(options)) {
    throw new Error("invalid-endpoints");
  }
  const endpointDiscovery = reconstructCoherentEndpointDiscovery(
    options.endpoints,
    options.endpointDiscovery,
  );
  if (
    options.endpoints.length === 0 ||
    endpointDiscovery === undefined
  ) {
    throw new Error("invalid-endpoints");
  }
  const snapshotKey = `snapshot:${randomUUID()}`;
  let modelOrdinal = 0;
  let intensityOrdinal = 0;
  let executionOrdinal = 0;
  let accessOrdinal = 0;
  const relations: EndpointRelation[] = [];
  const publicEndpoints: WorkbenchRuntimeEndpointOption[] = [];

  for (const [endpointIndex, endpoint] of options.endpoints.entries()) {
    if (
      endpoint.catalog.models.length === 0 ||
      endpoint.executionModeLabels.length !==
        endpoint.catalog.executionModes.length ||
      endpoint.accessModeLabels.length !== endpoint.catalog.accessModes.length
    ) {
      throw new Error("invalid-endpoint-catalog");
    }
    const endpointKey = `endpoint-option:${endpointIndex + 1}:${randomUUID()}`;
    const couplingByIntensity = validateCatalogCouplings(endpoint.catalog);
    const executionRelations: EndpointRelation["executionModes"][number][] = [];
    const executionModes: WorkbenchSessionProfileOption[] = [];
    for (const [index, value] of endpoint.catalog.executionModes.entries()) {
      executionOrdinal += 1;
      const key = `execution-option:${executionOrdinal}:${randomUUID()}`;
      executionRelations.push(Object.freeze({ key, value }));
      executionModes.push(
        Object.freeze({ key, label: endpoint.executionModeLabels[index]! }),
      );
    }
    const modelRelations: ModelRelation[] = [];
    const publicModels: WorkbenchModelOption[] = [];
    const usesOpaqueEffortSelections =
      endpoint.catalog.runtime === opaqueEffortSelectionCatalogRuntime;
    const presentedModels = endpoint.catalog.models.map((model) => {
      const presentation = classifyCatalogModelPresentation(
        endpoint.runtimeFamilyLabel,
        model,
        usesOpaqueEffortSelections,
      );
      if (presentation.kind === "catalog-malformed") {
        throw new Error("malformed-model-catalog");
      }
      return Object.freeze({ model, presentation });
    });
    const resolvedModelCounts = new Map<string, number>();
    for (const { model } of presentedModels) {
      if (model.resolvedModel === undefined) continue;
      resolvedModelCounts.set(
        model.resolvedModel,
        (resolvedModelCounts.get(model.resolvedModel) ?? 0) + 1,
      );
    }
    const seenResolvedModels = new Set<string>();
    for (const { model, presentation } of presentedModels) {
      if (model.resolvedModel !== undefined) {
        if (seenResolvedModels.has(model.resolvedModel)) continue;
        seenResolvedModels.add(model.resolvedModel);
      }
      modelOrdinal += 1;
      const modelKey = `model-option:${modelOrdinal}:${randomUUID()}`;
      const intensityRelations: {
        readonly key: string;
        readonly effortLevel: string;
        readonly impliedExecutionMode?: {
          readonly key: string;
          readonly value: SessionProfile["executionMode"];
        };
      }[] = [];
      const workIntensities: WorkbenchWorkIntensityOption[] = [];
      for (const [effortIndex, effortLevel] of model.effortLevels.entries()) {
        intensityOrdinal += 1;
        const key = `intensity-option:${intensityOrdinal}:${randomUUID()}`;
        const impliedExecutionModeValue = couplingByIntensity.get(
          couplingKey(model.id, effortLevel),
        );
        const impliedExecutionMode =
          impliedExecutionModeValue === undefined
            ? undefined
            : executionRelations.find(
                (candidate) => candidate.value === impliedExecutionModeValue,
              );
        if (
          impliedExecutionModeValue !== undefined &&
          impliedExecutionMode === undefined
        ) {
          throw new Error("invalid-intensity-execution-coupling");
        }
        intensityRelations.push(
          Object.freeze({
            key,
            effortLevel,
            ...(impliedExecutionMode === undefined
              ? {}
              : { impliedExecutionMode }),
          }),
        );
        workIntensities.push(
          Object.freeze({
            key,
            label: presentation.effortLabels[effortIndex]!,
            ...(impliedExecutionMode === undefined
              ? {}
              : { impliedExecutionModeKey: impliedExecutionMode.key }),
          }),
        );
      }
      if (workIntensities.length === 0) throw new Error("invalid-model-catalog");
      modelRelations.push(
        Object.freeze({
          key: modelKey,
          model: model.id,
          workIntensities: Object.freeze(intensityRelations),
        }),
      );
      publicModels.push(
        Object.freeze({
          key: modelKey,
          label: presentation.modelLabel,
          provenanceLabel:
            model.resolvedModel !== undefined &&
            (resolvedModelCounts.get(model.resolvedModel) ?? 0) > 1
              ? null
              : presentation.provenanceLabel,
          workIntensityLabel: model.workIntensityLabel ?? null,
          workIntensities: Object.freeze(workIntensities),
        }),
      );
    }
    const accessRelations: EndpointRelation["accessModes"][number][] = [];
    const accessModes: WorkbenchSessionProfileOption[] = [];
    for (const [index, value] of endpoint.catalog.accessModes.entries()) {
      accessOrdinal += 1;
      const key = `access-option:${accessOrdinal}:${randomUUID()}`;
      accessRelations.push(Object.freeze({ key, value }));
      accessModes.push(
        Object.freeze({ key, label: endpoint.accessModeLabels[index]! }),
      );
    }
    if (executionModes.length === 0 || accessModes.length === 0) {
      throw new Error("invalid-endpoint-modes");
    }
    relations.push(
      Object.freeze({
        endpointId: endpoint.endpointId,
        key: endpointKey,
        catalogRevision: endpoint.catalogRevision,
        models: Object.freeze(modelRelations),
        executionModes: Object.freeze(executionRelations),
        accessModes: Object.freeze(accessRelations),
      }),
    );
    publicEndpoints.push(
      Object.freeze({
        endpointId: endpoint.endpointId,
        key: endpointKey,
        runtimeFamilyLabel: endpoint.runtimeFamilyLabel,
        endpointLabel: endpoint.endpointLabel,
        models: Object.freeze(publicModels),
        executionModes: Object.freeze(executionModes),
        accessModes: Object.freeze(accessModes),
      }),
    );
  }

  const initialDefault = resolveDesiredDefault(
    options.desiredDefault,
    relations,
  );
  return createSnapshotValue(
    snapshotKey,
    Object.freeze(relations),
    Object.freeze(publicEndpoints),
    endpointDiscovery,
    initialDefault,
  );
}

function classifyCatalogModelPresentation(
  runtimeFamilyLabel: string,
  model: RuntimeModel,
  usesOpaqueEffortSelections: boolean,
): CatalogModelPresentationState {
  if (
    !Array.isArray(model.effortLevels) ||
    model.effortLevels.length === 0 ||
    model.effortLevels.some((effortLevel) => typeof effortLevel !== "string") ||
    (model.resolvedModel !== undefined &&
      typeof model.resolvedModel !== "string") ||
    (model.displayName !== undefined && typeof model.displayName !== "string") ||
    (model.workIntensityLabel !== undefined &&
      typeof model.workIntensityLabel !== "string") ||
    (model.effortLevelLabels !== undefined &&
      (!Array.isArray(model.effortLevelLabels) ||
        model.effortLevelLabels.length !== model.effortLevels.length ||
        model.effortLevelLabels.some(
          (label) => label !== null && typeof label !== "string",
        ))) ||
    (usesOpaqueEffortSelections &&
      (model.effortLevelLabels === undefined ||
        model.effortLevelLabels.some((label) => label === null)))
  ) {
    return Object.freeze({ kind: "catalog-malformed" as const });
  }

  const sparse =
    model.resolvedModel === undefined ||
    model.displayName === undefined ||
    model.workIntensityLabel === undefined ||
    model.effortLevelLabels === undefined ||
    model.effortLevelLabels.some((label) => label === null);
  const resolvedIdentity = model.resolvedModel ?? model.id;
  const modelLabel = workbenchModelPresentationLabel(
    runtimeFamilyLabel,
    resolvedIdentity,
  );
  const ownerProductNameApplied = modelLabel !== resolvedIdentity;
  return Object.freeze({
    kind: sparse ? ("display-sparse-valid" as const) : ("display-complete" as const),
    modelLabel,
    provenanceLabel:
      ownerProductNameApplied ? null : (model.displayName ?? null),
    effortLabels: Object.freeze(
      usesOpaqueEffortSelections
        ? model.effortLevelLabels!.map((label) => label!)
        : [...model.effortLevels],
    ),
  });
}

function createSnapshotValue(
  snapshotKey: string,
  relations: readonly EndpointRelation[],
  endpoints: readonly WorkbenchRuntimeEndpointOption[],
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
  desiredDefault:
    | ResolvedDesiredDefault
    | { readonly kind: "unavailable" },
): DirectSessionProfileSnapshot {
  const publicResult = deepFreeze({
    ok: true as const,
    endpointDiscovery,
    profile: {
      snapshotKey,
      endpoints,
      desiredDefault,
    },
  });

  const resolveSelection = (
    selection: WorkbenchDirectSessionProfileSelection,
  ): ResolvedDirectSessionProfileSelection | undefined => {
    if (nodeUtilTypes.isProxy(selection)) return undefined;
    if (selection.snapshotKey !== snapshotKey) return undefined;
    const endpointIndex = relations.findIndex(
      (candidate) => candidate.key === selection.endpointKey,
    );
    const endpoint = relations[endpointIndex];
    if (endpoint === undefined) return undefined;
    const model = endpoint.models.find(
      (candidate) => candidate.key === selection.modelKey,
    );
    const intensity = model?.workIntensities.find(
      (candidate) => candidate.key === selection.workIntensityKey,
    );
    const selectedExecutionMode = endpoint.executionModes.find(
      (candidate) => candidate.key === selection.executionModeKey,
    );
    const executionMode =
      intensity?.impliedExecutionMode ?? selectedExecutionMode;
    const accessMode = endpoint.accessModes.find(
      (candidate) => candidate.key === selection.accessModeKey,
    );
    const publicEndpoint = endpoints[endpointIndex];
    const publicModel = publicEndpoint?.models.find(
      (candidate) => candidate.key === selection.modelKey,
    );
    const publicIntensity = publicModel?.workIntensities.find(
      (candidate) => candidate.key === selection.workIntensityKey,
    );
    const publicExecutionMode = publicEndpoint?.executionModes.find(
      (candidate) => candidate.key === executionMode?.key,
    );
    const publicAccessMode = publicEndpoint?.accessModes.find(
      (candidate) => candidate.key === selection.accessModeKey,
    );
    if (
      model === undefined ||
      intensity === undefined ||
      executionMode === undefined ||
      (intensity.impliedExecutionMode !== undefined &&
        selectedExecutionMode?.key !== intensity.impliedExecutionMode.key) ||
      accessMode === undefined ||
      publicEndpoint === undefined ||
      publicModel === undefined ||
      publicIntensity === undefined ||
      publicExecutionMode === undefined ||
      publicAccessMode === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      endpointIndex,
      catalogRevision: endpoint.catalogRevision,
      profile: Object.freeze({
        model: model.model,
        effortLevel: intensity.effortLevel,
        executionMode: executionMode.value,
        accessMode: accessMode.value,
      }),
      requestedProfileProjection: deepFreeze({
        kind: "recorded" as const,
        runtimeFamilyLabel: publicEndpoint.runtimeFamilyLabel,
        endpointLabel: publicEndpoint.endpointLabel,
        modelLabel: publicModel.label,
        workIntensityControlLabel:
          publicModel.workIntensityLabel === null
            ? { label: null, provenance: "not-recorded" as const }
            : {
                label: publicModel.workIntensityLabel,
                provenance: "runtime-catalog" as const,
              },
        workIntensityLabel: publicIntensity.label,
        executionModeLabel: publicExecutionMode.label,
        accessModeLabel: publicAccessMode.label,
      }),
    });
  };

  const resolveReplacementPrefill = (
    recordedProfile: SessionProfile,
  ): WorkbenchReplacementPrefill => {
    if (
      !isStableNonProxyDataGraph(recordedProfile) ||
      !isExactDataRecord(recordedProfile, [
        "accessMode",
        "effortLevel",
        "executionMode",
        "model",
      ]) ||
      typeof recordedProfile.model !== "string" ||
      typeof recordedProfile.effortLevel !== "string" ||
      typeof recordedProfile.executionMode !== "string" ||
      typeof recordedProfile.accessMode !== "string"
    ) {
      return manualReplacementPrefill;
    }
    const matches: Extract<
      WorkbenchReplacementPrefill,
      { readonly kind: "resolved" }
    >[] = [];
    for (const endpoint of relations) {
      for (const model of endpoint.models) {
        if (model.model !== recordedProfile.model) continue;
        for (const intensity of model.workIntensities) {
          if (intensity.effortLevel !== recordedProfile.effortLevel) continue;
          const executionModes = endpoint.executionModes.filter((candidate) =>
            intensity.impliedExecutionMode === undefined
              ? candidate.value === recordedProfile.executionMode
              : candidate.key === intensity.impliedExecutionMode.key &&
                candidate.value === recordedProfile.executionMode &&
                intensity.impliedExecutionMode.value ===
                  recordedProfile.executionMode,
          );
          const accessModes = endpoint.accessModes.filter(
            (candidate) => candidate.value === recordedProfile.accessMode,
          );
          for (const executionMode of executionModes) {
            for (const accessMode of accessModes) {
              matches.push(
                Object.freeze({
                  kind: "resolved" as const,
                  endpointKey: endpoint.key,
                  modelKey: model.key,
                  workIntensityKey: intensity.key,
                  executionModeKey: executionMode.key,
                  accessModeKey: accessMode.key,
                }),
              );
            }
          }
        }
      }
    }
    return matches.length === 1 ? matches[0]! : manualReplacementPrefill;
  };

  return Object.freeze({
    publicResult,
    resolveSelection,
    resolveReplacementPrefill,
    withDesiredDefault(
      selection: WorkbenchDirectSessionProfileSelection,
    ): DirectSessionProfileSnapshot {
      return resolveSelection(selection) === undefined
        ? this
        : createSnapshotValue(
            snapshotKey,
            relations,
            endpoints,
            endpointDiscovery,
            Object.freeze({
              kind: "resolved" as const,
              endpointKey: selection.endpointKey,
              modelKey: selection.modelKey,
              workIntensityKey: selection.workIntensityKey,
              executionModeKey: selection.executionModeKey,
              accessModeKey: selection.accessModeKey,
            }),
          );
    },
  });
}

function reconstructCoherentEndpointDiscovery(
  endpoints: readonly DirectSessionProfileEndpointCatalog[],
  endpointDiscovery: unknown,
): WorkbenchRuntimeEndpointDiscovery | undefined {
  try {
    if (
      !isExactDataRecord(endpointDiscovery, ["statuses"]) ||
      !isDenseArray(endpointDiscovery.statuses) ||
      endpointDiscovery.statuses.length !== 2
    ) {
      return undefined;
    }
    const statuses = endpointDiscovery.statuses;
    const codexStatus = statuses[0];
    const claudeStatus = statuses[1];
    if (
      !isExactDataRecord(codexStatus, ["category", "endpointId"]) ||
      codexStatus.endpointId !== "codex-desktop" ||
      !isDiscoveryCategory(codexStatus.category) ||
      !isExactDataRecord(claudeStatus, ["category", "endpointId"]) ||
      claudeStatus.endpointId !== "claude-code-desktop" ||
      !isClaudeDiscoveryCategory(claudeStatus.category)
    ) {
      return undefined;
    }
    const endpointIds = endpoints.map((endpoint) => endpoint.endpointId);
    if (
      new Set(endpointIds).size !== endpointIds.length ||
      endpointIds.some(
        (endpointId, index) =>
          endpointId !== "codex-desktop" &&
          endpointId !== "claude-code-desktop" ||
          (index > 0 &&
            endpointIds[index - 1] === "claude-code-desktop" &&
            endpointId === "codex-desktop"),
      )
    ) {
      return undefined;
    }
    const readyIds = [codexStatus, claudeStatus]
      .filter((status) => status.category === "catalog-ready")
      .map((status) => status.endpointId);
    if (
      readyIds.length === endpointIds.length &&
      readyIds.every((endpointId, index) => endpointId === endpointIds[index])
    ) {
      return publicRuntimeEndpointDiscovery(
        codexStatus.category,
        claudeStatus.category,
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
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

function isClaudeDiscoveryCategory(
  value: unknown,
): value is WorkbenchRuntimeEndpointDiscovery["statuses"][1]["category"] {
  return isDiscoveryCategory(value);
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
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable
      );
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
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length !== 2
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === 3 &&
      ["0", "1", "length"].every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      }) &&
      keys.every(
        (key) =>
          typeof key === "string" && ["0", "1", "length"].includes(key),
      )
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

function resolveDesiredDefault(
  desired: DirectSessionProfileDesiredDefault | undefined,
  relations: readonly EndpointRelation[],
):
  | ResolvedDesiredDefault
  | { readonly kind: "unavailable" } {
  if (desired === undefined) return Object.freeze({ kind: "unavailable" });
  const endpoint = relations[desired.endpointIndex];
  const model = endpoint?.models.find(
    (candidate) => candidate.model === desired.profile.model,
  );
  const intensity = model?.workIntensities.find(
    (candidate) => candidate.effortLevel === desired.profile.effortLevel,
  );
  const executionMode =
    intensity?.impliedExecutionMode ??
    endpoint?.executionModes.find(
      (candidate) => candidate.value === desired.profile.executionMode,
    );
  const accessMode = endpoint?.accessModes.find(
    (candidate) => candidate.value === desired.profile.accessMode,
  );
  if (
    endpoint === undefined ||
    model === undefined ||
    intensity === undefined ||
    executionMode === undefined ||
    accessMode === undefined
  ) {
    return Object.freeze({ kind: "unavailable" });
  }
  return Object.freeze({
    kind: "resolved",
    endpointKey: endpoint.key,
    modelKey: model.key,
    workIntensityKey: intensity.key,
    executionModeKey: executionMode.key,
    accessModeKey: accessMode.key,
  });
}

function validateCatalogCouplings(
  catalog: DirectSessionProfileCatalog,
): ReadonlyMap<string, SessionProfile["executionMode"]> {
  const declarations = catalog.workIntensityExecutionModeCouplings;
  if (declarations === undefined) return new Map();
  if (!Array.isArray(declarations)) {
    throw new Error("invalid-intensity-execution-coupling");
  }
  const couplings = new Map<string, SessionProfile["executionMode"]>();
  for (const declaration of declarations) {
    if (
      !isRecord(declaration) ||
      !hasExactKeys(declaration, [
        "executionMode",
        "model",
        "workIntensity",
      ]) ||
      typeof declaration.model !== "string" ||
      typeof declaration.workIntensity !== "string" ||
      typeof declaration.executionMode !== "string"
    ) {
      throw new Error("invalid-intensity-execution-coupling");
    }
    const model = catalog.models.find(
      (candidate) => candidate.id === declaration.model,
    );
    const key = couplingKey(declaration.model, declaration.workIntensity);
    if (
      model === undefined ||
      !model.effortLevels.includes(declaration.workIntensity) ||
      !catalog.executionModes.includes(declaration.executionMode) ||
      couplings.has(key)
    ) {
      throw new Error("invalid-intensity-execution-coupling");
    }
    couplings.set(key, declaration.executionMode);
  }
  return couplings;
}

function couplingKey(model: string, workIntensity: string): string {
  return `${model}\u0000${workIntensity}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value).sort((left, right) =>
    String(left).localeCompare(String(right), "en"),
  );
  const sortedExpected = [...expected].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  return (
    keys.length === sortedExpected.length &&
    keys.every(
      (key, index) =>
        typeof key === "string" && key === sortedExpected[index],
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
