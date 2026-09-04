import { randomUUID } from "node:crypto";

import type {
  InterruptibleRuntimeBinding,
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
  RuntimeModel,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../index.ts";
import { RuntimeAdapterError } from "../index.ts";
import {
  createOfficialClaudeCatalogTransport,
  createOfficialClaudeSessionTransport,
} from "./process-transport.ts";
import { initializeClaudeCatalog } from "./protocol.ts";
import {
  ClaudeRuntimeBinding,
  initializeClaudeSession,
} from "./session.ts";
import type {
  ClaudeCatalogTransportFactory,
  ClaudePermissionMode,
  ClaudeSessionTransportFactory,
  ClaudeToolPermissionHandler,
} from "./transport.ts";
import type { ProviderRequestBudget } from "../provider-request-budget.ts";
import type { ClaudeAppliedSettings } from "./settings.ts";
import { ClaudeDiagnosticError } from "./diagnostics.ts";

const ultracodeExecutionMode = "ultracode";
const ultracodeWorkIntensity = "ultracode";
const ultracodeNativeEffort = "xhigh";

const modelRequiredKeys = ["value"] as const;
/**
 * Recognised Claude model fields stay value-validated. Other safe own keys are
 * additive vendor drift: their names enter the observation collector, while
 * their values are never read and the returned RuntimeModel is rebuilt.
 */
const modelOptionalKeys = [
  "resolvedModel",
  "displayName",
  "description",
  "supportsEffort",
  "supportedEffortLevels",
  "supportsAdaptiveThinking",
  "supportsFastMode",
  "supportsAutoMode",
  "promoListPrice",
] as const;
const forbiddenCatalogKeyNames = [
  "__proto__",
  "constructor",
  "prototype",
] as const;

interface ClaudeSessionCapability {
  readonly projectDirectory: string;
  readonly profile: SessionProfile;
  readonly permissionMode: ClaudePermissionMode;
  sessionIdentity?: string;
}

/**
 * The durable form of a resume capability (F220). The in-memory `#sessions`
 * Map stays the only thing `resume` reads — the store merely survives the
 * process so a restart can rehydrate the Map — and the native identity keeps
 * exactly the privacy the Map gave it: main-process-private, never part of a
 * binding, a snapshot, or anything the renderer sees.
 */
export interface PersistedClaudeSessionCapability {
  readonly projectDirectory: string;
  readonly profile: SessionProfile;
  readonly permissionMode: ClaudePermissionMode;
  readonly sessionIdentity: string;
}

export interface ClaudeSessionCapabilityStore {
  load(): ReadonlyMap<string, PersistedClaudeSessionCapability>;
  save(
    opaqueSessionReference: string,
    capability: PersistedClaudeSessionCapability,
  ): void;
}

interface ClaudeNativeCatalogModel {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: string[];
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
  readonly promoListPrice?: string;
}

export type ClaudeCatalogRejection = Readonly<{
  readonly row: number;
  readonly modelId: string;
  readonly addedKeys: readonly string[];
  readonly missingKeys: readonly string[];
  readonly invalidKeys: readonly string[];
}>;

/** A bounded, value-free account of tolerated drift and quarantined rows. */
export type ClaudeCatalogObservation = Readonly<{
  readonly toleratedKeys: readonly string[];
  readonly rejections: readonly ClaudeCatalogRejection[];
  readonly rejectionsOmitted: number;
  readonly toleratedSettingSources: readonly string[];
  readonly settingsErrorCount: number;
}>;

export type ClaudeCatalogObserver = (
  observation: ClaudeCatalogObservation,
) => void;

export interface ClaudeCatalogObservationCollector {
  readonly toleratedKeys: Set<string>;
  readonly rejections: ClaudeCatalogRejection[];
  rejectionsOmitted: number;
  readonly toleratedSettingSources: Set<string>;
  settingsErrorCount: number;
}

const claudeCatalogRejectionRecordLimit = 32;

export function createClaudeCatalogObservationCollector(): ClaudeCatalogObservationCollector {
  return {
    toleratedKeys: new Set(),
    rejections: [],
    rejectionsOmitted: 0,
    toleratedSettingSources: new Set(),
    settingsErrorCount: 0,
  };
}

function noteToleratedClaudeCatalogKeys(
  collector: ClaudeCatalogObservationCollector,
  keys: readonly string[],
): void {
  for (const key of keys) collector.toleratedKeys.add(key);
}

function noteRejectedClaudeCatalogModel(
  collector: ClaudeCatalogObservationCollector,
  candidate: unknown,
  diagnostic: Readonly<{
    readonly row: number | null;
    readonly addedKeys: readonly string[];
    readonly missingKeys: readonly string[];
    readonly invalidKeys: readonly string[];
  }>,
): void {
  if (collector.rejections.length >= claudeCatalogRejectionRecordLimit) {
    collector.rejectionsOmitted += 1;
    return;
  }
  const modelId =
    isPlainDataRecord(candidate) && isSafeText(candidate.value, 240)
      ? candidate.value
      : "<unknown>";
  collector.rejections.push(
    Object.freeze({
      row: diagnostic.row!,
      modelId,
      addedKeys: Object.freeze([...diagnostic.addedKeys]),
      missingKeys: Object.freeze([...diagnostic.missingKeys]),
      invalidKeys: Object.freeze([...diagnostic.invalidKeys]),
    }),
  );
}

export function toClaudeCatalogObservation(
  collector: ClaudeCatalogObservationCollector,
): ClaudeCatalogObservation {
  return Object.freeze({
    toleratedKeys: Object.freeze([...collector.toleratedKeys].sort(compareOrdinal)),
    rejections: Object.freeze([...collector.rejections]),
    rejectionsOmitted: collector.rejectionsOmitted,
    toleratedSettingSources: Object.freeze(
      [...collector.toleratedSettingSources].sort(compareOrdinal),
    ),
    settingsErrorCount: collector.settingsErrorCount,
  });
}

export function formatClaudeCatalogDriftDiagnostic(
  observation: ClaudeCatalogObservation,
): string | undefined {
  if (
    observation.toleratedKeys.length === 0 &&
    observation.rejections.length === 0 &&
    observation.rejectionsOmitted === 0 &&
    observation.toleratedSettingSources.length === 0 &&
    observation.settingsErrorCount === 0
  ) {
    return undefined;
  }
  const parts: string[] = [];
  if (observation.toleratedKeys.length > 0) {
    parts.push(`tolerated-keys=${JSON.stringify(observation.toleratedKeys)}`);
  }
  for (const rejection of observation.rejections) {
    parts.push(
      `quarantined-model=${JSON.stringify(rejection.modelId)} ` +
        `row=${rejection.row} ` +
        `added=${JSON.stringify(rejection.addedKeys)} ` +
        `missing=${JSON.stringify(rejection.missingKeys)} ` +
        `invalid=${JSON.stringify(rejection.invalidKeys)}`,
    );
  }
  if (observation.rejectionsOmitted > 0) {
    parts.push(`quarantined-omitted=${observation.rejectionsOmitted}`);
  }
  if (observation.toleratedSettingSources.length > 0) {
    parts.push(
      `tolerated-setting-sources=${JSON.stringify(
        observation.toleratedSettingSources,
      )}`,
    );
  }
  if (observation.settingsErrorCount > 0) {
    parts.push(`settings-errors=${observation.settingsErrorCount}`);
  }
  return `CLAUDE_CATALOG_DRIFT ${parts.join(" ")}`;
}

export function productionClaudeCatalogObserver(
  observation: ClaudeCatalogObservation,
): void {
  const diagnostic = formatClaudeCatalogDriftDiagnostic(observation);
  if (diagnostic !== undefined) console.warn(diagnostic);
}

export interface ClaudePermissionHandlingOptions {
  readonly readPermissionMode?: () => Promise<ClaudePermissionMode>;
  readonly requestToolPermission?: ClaudeToolPermissionHandler;
}

export class ClaudeAdapter implements ResumableAgentRuntimeAdapter {
  readonly #createTransport: ClaudeCatalogTransportFactory;
  readonly #createSessionTransport: ClaudeSessionTransportFactory;
  readonly #providerRequestBudget: ProviderRequestBudget | undefined;
  readonly #readPermissionMode: () => Promise<ClaudePermissionMode>;
  readonly #requestToolPermission: ClaudeToolPermissionHandler | undefined;
  readonly #onCatalogObservation: ClaudeCatalogObserver | undefined;
  readonly #sessions = new Map<string, ClaudeSessionCapability>();
  readonly #sessionCapabilityStore: ClaudeSessionCapabilityStore | undefined;

  constructor(
    createTransport?: ClaudeCatalogTransportFactory,
    createSessionTransport?: ClaudeSessionTransportFactory,
    providerRequestBudget?: ProviderRequestBudget,
    permissionHandling?: ClaudePermissionHandlingOptions,
    onCatalogObservation?: ClaudeCatalogObserver,
    sessionCapabilityStore?: ClaudeSessionCapabilityStore,
  ) {
    this.#sessionCapabilityStore = sessionCapabilityStore;
    if (sessionCapabilityStore !== undefined) {
      try {
        for (const [reference, persisted] of sessionCapabilityStore.load()) {
          this.#sessions.set(reference, {
            projectDirectory: persisted.projectDirectory,
            profile: Object.freeze({ ...persisted.profile }),
            permissionMode: persisted.permissionMode,
            sessionIdentity: persisted.sessionIdentity,
          });
        }
      } catch {
        // A store that cannot be read degrades to the pre-store behaviour
        // (resume works within this run only); it never takes the adapter down.
      }
    }
    this.#createTransport =
      createTransport ??
      ((projectDirectory) =>
        createOfficialClaudeCatalogTransport(
          projectDirectory,
          undefined,
          providerRequestBudget,
        ));
    this.#createSessionTransport =
      createSessionTransport ??
      ((request) =>
        createOfficialClaudeSessionTransport(
          request,
          undefined,
          providerRequestBudget,
        ));
    this.#providerRequestBudget = providerRequestBudget;
    this.#readPermissionMode =
      permissionHandling?.readPermissionMode ??
      (() => Promise.resolve("bypassPermissions"));
    this.#requestToolPermission = permissionHandling?.requestToolPermission;
    // The production construction passes no custom catalog transport. Keep its
    // drift channel live without widening workbench-shell composition, while
    // synthetic/custom transports remain silent unless they opt in explicitly.
    this.#onCatalogObservation =
      onCatalogObservation ??
      (createTransport === undefined
        ? productionClaudeCatalogObserver
        : undefined);
  }

  #emitCatalogObservation(
    collector: ClaudeCatalogObservationCollector,
  ): void {
    const observer = this.#onCatalogObservation;
    if (observer === undefined) return;
    try {
      observer(toClaudeCatalogObservation(collector));
    } catch {
      // Catalog diagnostics never change the catalog outcome.
    }
  }

  async inspect(projectDirectory: string): Promise<RuntimeCatalog> {
    if (!isSafeText(projectDirectory, 32_768)) {
      throw new RuntimeAdapterError("invalid-input");
    }
    let transport;
    try {
      transport = await this.#createTransport(projectDirectory);
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error;
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    let catalog: RuntimeCatalog | undefined;
    let failure: RuntimeAdapterError | undefined;
    const collector = createClaudeCatalogObservationCollector();
    try {
      const initialization = await initializeClaudeCatalog(
        transport,
        this.#providerRequestBudget,
        collector,
      );
      catalog = readClaudeRuntimeCatalog(
        initialization.catalog,
        initialization.appliedSettings,
        collector,
      );
    } catch (error) {
      failure =
        error instanceof RuntimeAdapterError
          ? error
          : new RuntimeAdapterError("runtime-unavailable");
    }
    try {
      await transport.stop();
    } catch (error) {
      failure ??=
        error instanceof RuntimeAdapterError
          ? error
          : new RuntimeAdapterError("runtime-shutdown");
    }
    this.#emitCatalogObservation(collector);
    if (failure !== undefined) throw failure;
    return catalog!;
  }

  async start(request: RuntimeStart): Promise<InterruptibleRuntimeBinding> {
    validateStartRequest(request);
    const permissionMode = await this.#capturePermissionMode();
    let transport;
    try {
      transport = await this.#createSessionTransport({
        projectDirectory: request.projectDirectory,
        profile: request.profile,
        permissionMode,
      });
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error;
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    let keepRunning = false;
    try {
      const initialization = await initializeClaudeSession(
        transport,
        this.#providerRequestBudget,
      );
      const catalog = readClaudeRuntimeCatalog(
        initialization.catalog,
        initialization.appliedSettings,
      );
      const expectedModel = assertSessionSelection(
        initialization.catalog,
        catalog,
        request.profile,
      );
      assertAppliedSessionSettings(
        initialization.appliedSettings,
        request.profile,
      );
      const opaqueSessionReference = `claude-${randomUUID()}`;
      const capability: ClaudeSessionCapability = {
        projectDirectory: request.projectDirectory,
        profile: Object.freeze({ ...request.profile }),
        permissionMode,
      };
      this.#sessions.set(opaqueSessionReference, capability);
      keepRunning = true;
      return new ClaudeRuntimeBinding({
        transport,
        profile: capability.profile,
        opaqueSessionReference,
        expectedModel,
        stopHookCallbackId: initialization.stopHookCallbackId,
        observeSessionIdentity: (identity) => {
          capability.sessionIdentity = identity;
          this.#persistSessionCapability(opaqueSessionReference, capability);
        },
        providerRequestBudget: this.#providerRequestBudget,
        permissionMode,
        requestToolPermission: this.#requestToolPermission,
        ultracodeConfirmed:
          initialization.appliedSettings?.ultracode === true,
      });
    } catch (error) {
      throw error instanceof RuntimeAdapterError
        ? error
        : new RuntimeAdapterError("runtime-unavailable");
    } finally {
      if (!keepRunning) await stopRejectedSessionTransport(transport);
    }
  }

  async resume(request: RuntimeResume): Promise<InterruptibleRuntimeBinding> {
    validateResumeRequest(request);
    const capability = this.#sessions.get(request.opaqueSessionReference);
    if (
      capability === undefined ||
      capability.sessionIdentity === undefined ||
      capability.projectDirectory !== request.projectDirectory ||
      !sameLockedProfileFields(capability.profile, request.profile)
    ) {
      throw new RuntimeAdapterError("unsupported-selection");
    }
    let transport;
    try {
      transport = await this.#createSessionTransport({
        projectDirectory: request.projectDirectory,
        profile: request.profile,
        permissionMode: capability.permissionMode,
        resumeSessionIdentity: capability.sessionIdentity,
      });
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error;
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    let keepRunning = false;
    try {
      const initialization = await initializeClaudeSession(
        transport,
        this.#providerRequestBudget,
      );
      const catalog = readClaudeRuntimeCatalog(
        initialization.catalog,
        initialization.appliedSettings,
      );
      const expectedModel = assertSessionSelection(
        initialization.catalog,
        catalog,
        request.profile,
      );
      assertAppliedSessionSettings(
        initialization.appliedSettings,
        request.profile,
      );
      keepRunning = true;
      return new ClaudeRuntimeBinding({
        transport,
        profile: request.profile,
        opaqueSessionReference: request.opaqueSessionReference,
        expectedModel,
        expectedSessionIdentity: capability.sessionIdentity,
        stopHookCallbackId: initialization.stopHookCallbackId,
        observeSessionIdentity: (identity) => {
          capability.sessionIdentity = identity;
          this.#persistSessionCapability(
            request.opaqueSessionReference,
            capability,
          );
        },
        providerRequestBudget: this.#providerRequestBudget,
        permissionMode: capability.permissionMode,
        requestToolPermission: this.#requestToolPermission,
        ultracodeConfirmed:
          initialization.appliedSettings?.ultracode === true,
      });
    } catch (error) {
      throw error instanceof RuntimeAdapterError
        ? error
        : new RuntimeAdapterError("runtime-unavailable");
    } finally {
      if (!keepRunning) await stopRejectedSessionTransport(transport);
    }
  }

  #persistSessionCapability(
    opaqueSessionReference: string,
    capability: ClaudeSessionCapability,
  ): void {
    const store = this.#sessionCapabilityStore;
    if (store === undefined || capability.sessionIdentity === undefined) return;
    try {
      store.save(opaqueSessionReference, {
        projectDirectory: capability.projectDirectory,
        profile: capability.profile,
        permissionMode: capability.permissionMode,
        sessionIdentity: capability.sessionIdentity,
      });
    } catch {
      // Persistence is durability, not correctness: the live Map still serves
      // this run, and a failed write must not fail the turn that observed it.
    }
  }

  async #capturePermissionMode(): Promise<ClaudePermissionMode> {
    let permissionMode: ClaudePermissionMode;
    try {
      permissionMode = await this.#readPermissionMode();
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error;
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    if (
      permissionMode !== "bypassPermissions" &&
      permissionMode !== "manual"
    ) {
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    return permissionMode;
  }
}

async function stopRejectedSessionTransport(transport: {
  stop(): Promise<void>;
}): Promise<void> {
  try {
    await transport.stop();
  } catch {
    throw new RuntimeAdapterError("runtime-shutdown");
  }
}

function validateStartRequest(request: RuntimeStart): void {
  if (
    !isPlainDataRecord(request) ||
    Reflect.ownKeys(request).length !== 2 ||
    !isSafeText(request.projectDirectory, 32_768) ||
    !isPlainDataRecord(request.profile) ||
    !isRecordWithKnownKeys(
      request.profile,
      ["accessMode", "effortLevel", "executionMode", "model"],
      [],
    ) ||
    !isSafeText(request.profile.model, 240) ||
    !isSafeText(request.profile.effortLevel, 120) ||
    (request.profile.executionMode !== "single-agent" &&
      request.profile.executionMode !== ultracodeExecutionMode) ||
    (request.profile.executionMode === ultracodeExecutionMode &&
      request.profile.effortLevel !== ultracodeNativeEffort) ||
    request.profile.effortLevel === ultracodeWorkIntensity ||
    request.profile.accessMode !== "full-access"
  ) {
    throw new RuntimeAdapterError("invalid-input");
  }
}

function validateResumeRequest(request: RuntimeResume): void {
  if (
    !isPlainDataRecord(request) ||
    Reflect.ownKeys(request).length !== 3 ||
    !isSafeText(request.opaqueSessionReference, 240)
  ) {
    throw new RuntimeAdapterError("invalid-input");
  }
  validateStartRequest({
    projectDirectory: request.projectDirectory,
    profile: request.profile,
  });
}

function sameLockedProfileFields(
  left: SessionProfile,
  right: SessionProfile,
): boolean {
  return (
    (left.executionMode === right.executionMode ||
      ((left.executionMode === "single-agent" ||
        left.executionMode === ultracodeExecutionMode) &&
        (right.executionMode === "single-agent" ||
          right.executionMode === ultracodeExecutionMode))) &&
    left.accessMode === right.accessMode
  );
}

function assertSessionSelection(
  rawCatalog: unknown,
  catalog: RuntimeCatalog,
  profile: SessionProfile,
): string {
  const model = catalog.models.find((candidate) => candidate.id === profile.model);
  const privateVariant = model?.workIntensityVariants?.some(
    (variant) =>
      variant.nativeEffortLevel === profile.effortLevel &&
      variant.baseExecutionMode === "single-agent" &&
      variant.executionMode === profile.executionMode,
  );
  if (
    model === undefined ||
    !model.effortLevels.includes(profile.effortLevel) ||
    (!catalog.executionModes.includes(profile.executionMode) &&
      privateVariant !== true) ||
    !catalog.accessModes.includes(profile.accessMode) ||
    !isPlainDataRecord(rawCatalog) ||
    !Array.isArray(rawCatalog.models)
  ) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
  if (
    profile.executionMode === ultracodeExecutionMode &&
    (privateVariant !== true ||
      !model.workIntensityVariants?.some(
        (variant) => variant.value === ultracodeWorkIntensity,
      ))
  ) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
  const native = rawCatalog.models.find(
    (candidate) =>
      isPlainDataRecord(candidate) && candidate.value === profile.model,
  );
  if (!isPlainDataRecord(native)) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
  const expected = native.resolvedModel ?? native.value;
  if (!isSafeText(expected, 240)) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  return expected;
}

export function readClaudeRuntimeCatalog(
  value: unknown,
  appliedSettings?: ClaudeAppliedSettings,
  collector: ClaudeCatalogObservationCollector = createClaudeCatalogObservationCollector(),
): RuntimeCatalog {
  if (
    !isPlainDataRecord(value) ||
    !isDenseArray(value.models) ||
    value.models.length === 0
  ) {
    throw catalogShapeError("catalog", null, [], [], ["models"], value);
  }
  const envelopeAddedKeys = (Reflect.ownKeys(value) as string[])
    .filter((key) => key !== "models")
    .sort(compareOrdinal);
  if (!envelopeAddedKeys.every(isSafeClaudeCatalogKeyName)) {
    throw catalogShapeError("catalog", null, [], [], ["keyNames"], value);
  }
  noteToleratedClaudeCatalogKeys(collector, envelopeAddedKeys);
  const seen = new Set<string>();
  const models: RuntimeModel[] = [];
  for (let row = 0; row < value.models.length; row += 1) {
    const candidate = value.models[row];
    let model: RuntimeModel;
    try {
      model = readClaudeRuntimeCatalogModel(
        candidate,
        row,
        appliedSettings,
        collector,
      );
    } catch (error) {
      if (
        error instanceof ClaudeDiagnosticError &&
        error.diagnostic.kind === "catalog-shape-rejected" &&
        error.diagnostic.gate === "models" &&
        error.diagnostic.row === row
      ) {
        // Row-local shape/value failures quarantine only this model. Envelope
        // faults and cross-row duplicate ids never enter this catch.
        noteRejectedClaudeCatalogModel(collector, candidate, error.diagnostic);
        continue;
      }
      throw error;
    }
    if (seen.has(model.id)) {
      throw catalogShapeError("models", row, [], [], ["value"], candidate);
    }
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) {
    const first = collector.rejections[0];
    if (first !== undefined) {
      throw catalogShapeError(
        "models",
        first.row,
        first.addedKeys,
        first.missingKeys,
        first.invalidKeys,
        value.models[first.row],
      );
    }
    throw catalogShapeError("catalog", null, [], [], ["models"], value);
  }
  return Object.freeze({
    runtime: "claude",
    models: Object.freeze(models),
    executionModes: Object.freeze(["single-agent"]),
    accessModes: Object.freeze(["full-access"]),
  });
}

function readClaudeRuntimeCatalogModel(
  candidate: unknown,
  row: number,
  appliedSettings: ClaudeAppliedSettings | undefined,
  collector: ClaudeCatalogObservationCollector,
): RuntimeModel {
  if (!isPlainDataRecord(candidate)) {
    throw catalogShapeError("models", row, [], ["value"], ["row"], candidate);
  }
  const keys = Reflect.ownKeys(candidate) as string[];
  const admitted = new Set<string>([...modelRequiredKeys, ...modelOptionalKeys]);
  const addedKeys = keys.filter((key) => !admitted.has(key)).sort(compareOrdinal);
  const safeAddedKeyNames = addedKeys.every(isSafeClaudeCatalogKeyName);
  const missingKeys = modelRequiredKeys.filter((key) => !keys.includes(key));
  const invalidKeys: string[] = [];
  if (!safeAddedKeyNames) invalidKeys.push("keyNames");
  if (keys.includes("value") && !isSafeText(candidate.value, 240)) {
    invalidKeys.push("value");
  }
  if (
    candidate.resolvedModel !== undefined &&
    !isSafeDisplayText(candidate.resolvedModel, 160)
  ) {
    invalidKeys.push("resolvedModel");
  }
  if (
    candidate.displayName !== undefined &&
    !isSafeDisplayText(candidate.displayName, 200)
  ) {
    invalidKeys.push("displayName");
  }
  if (
    candidate.description !== undefined &&
    !isSafeDisplayText(candidate.description, 500)
  ) {
    invalidKeys.push("description");
  }
  if (
    candidate.promoListPrice !== undefined &&
    !isSafeDisplayText(candidate.promoListPrice, 120)
  ) {
    invalidKeys.push("promoListPrice");
  }
  for (const key of [
    "supportsEffort",
    "supportsAdaptiveThinking",
    "supportsFastMode",
    "supportsAutoMode",
  ] as const) {
    if (!optionalBoolean(candidate[key])) invalidKeys.push(key);
  }
  if (missingKeys.length > 0 || invalidKeys.length > 0) {
    throw catalogShapeError(
      "models",
      row,
      safeAddedKeyNames ? addedKeys : [],
      missingKeys,
      invalidKeys,
      candidate,
    );
  }
  const model = candidate as unknown as ClaudeNativeCatalogModel;
  const nativeEfforts = model.supportedEffortLevels;
  if (
    nativeEfforts !== undefined &&
    !isSupportedEffortArray(nativeEfforts)
  ) {
    throw catalogShapeError(
      "models",
      row,
      [],
      [],
      ["supportedEffortLevels"],
      candidate,
    );
  }
  if (nativeEfforts?.includes(ultracodeWorkIntensity)) {
    throw catalogShapeError(
      "models",
      row,
      [],
      [],
      ["supportedEffortLevels"],
      candidate,
    );
  }
  if (
    (model.supportsEffort === true && nativeEfforts === undefined) ||
    (model.supportsEffort === false && nativeEfforts !== undefined)
  ) {
    throw catalogShapeError(
      "models",
      row,
      [],
      [],
      ["supportsEffort", "supportedEffortLevels"],
      candidate,
    );
  }
  noteToleratedClaudeCatalogKeys(collector, addedKeys);
  if (nativeEfforts === undefined) {
    return Object.freeze({
      id: model.value,
      ...(model.resolvedModel === undefined
        ? {}
        : { resolvedModel: model.resolvedModel }),
      ...(model.displayName === undefined
        ? {}
        : { displayName: model.displayName }),
      effortLevels: Object.freeze(["default"]),
      effortLevelLabels: Object.freeze(["Default"]),
    });
  }
  const workIntensityVariants =
    nativeEfforts.includes(ultracodeNativeEffort) &&
    appliedSettings?.effort === ultracodeNativeEffort &&
    appliedSettings.ultracode === true
      ? Object.freeze([
          Object.freeze({
            value: ultracodeWorkIntensity,
            label: ultracodeWorkIntensity,
            nativeEffortLevel: ultracodeNativeEffort,
            baseExecutionMode: "single-agent",
            executionMode: ultracodeExecutionMode,
          }),
        ])
      : undefined;
  return Object.freeze({
    id: model.value,
    ...(model.resolvedModel === undefined
      ? {}
      : { resolvedModel: model.resolvedModel }),
    ...(model.displayName === undefined
      ? {}
      : { displayName: model.displayName }),
    effortLevels: Object.freeze([...nativeEfforts]),
    ...(workIntensityVariants === undefined
      ? {}
      : { workIntensityVariants }),
  });
}

function catalogShapeError(
  gate: string,
  row: number | null,
  addedKeys: readonly string[],
  missingKeys: readonly string[],
  invalidKeys: readonly string[],
  value: unknown,
): ClaudeDiagnosticError {
  return new ClaudeDiagnosticError("catalog-invalid", {
    kind: "catalog-shape-rejected",
    category: "catalog-invalid",
    gate,
    row,
    addedKeys: Object.freeze([...addedKeys]),
    missingKeys: Object.freeze([...missingKeys]),
    invalidKeys: Object.freeze([...invalidKeys]),
    detail: privateJson(value),
  });
}

function privateJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable-catalog-value";
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeClaudeCatalogKeyName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    [...value].length <= 120 &&
    value.trim() === value &&
    !hasUnpairedSurrogate(value) &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !forbiddenCatalogKeyNames.includes(
      value as (typeof forbiddenCatalogKeyNames)[number],
    )
  );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertAppliedSessionSettings(
  appliedSettings: ClaudeAppliedSettings | undefined,
  profile: SessionProfile,
): void {
  if (profile.executionMode === ultracodeExecutionMode) {
    if (
      appliedSettings?.effort !== ultracodeNativeEffort ||
      appliedSettings.ultracode !== true
    ) {
      throw new RuntimeAdapterError("unsupported-selection");
    }
    return;
  }
  if (
    appliedSettings === undefined ||
    (profile.effortLevel !== "default" &&
      appliedSettings.effort !== profile.effortLevel) ||
    appliedSettings.ultracode !== false
  ) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
}

function isRecordWithKnownKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainDataRecord(value)) return false;
  const keys = Reflect.ownKeys(value) as string[];
  return (
    keys.every((key) => required.includes(key) || optional.includes(key)) &&
    required.every((key) => keys.includes(key))
  );
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
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

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return false;
      }
    }
    return keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)),
    );
  } catch {
    return false;
  }
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isSupportedEffortArray(value: unknown): value is string[] {
  return (
    isDenseArray(value) &&
    value.length > 0 &&
    value.every(
      (effort): effort is string =>
        isSafeDisplayText(effort, 120),
    ) &&
    new Set(value).size === value.length
  );
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

function isSafeDisplayText(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    isSafeText(value, maximumLength) &&
    [...value].length <= maximumLength &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !value.includes("\\") &&
    !/^(?:[A-Za-z]:[\\/]|\/)/u.test(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) &&
    !/^Bearer\s+\S+/iu.test(value) &&
    !/-----BEGIN [A-Z ]+-----/u.test(value) &&
    !/(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu.test(value)
  );
}
