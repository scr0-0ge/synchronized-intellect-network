import type { RuntimeCatalog, SessionProfile } from "../agent-runtime/index.ts";

export type SessionProfilePreferences = Readonly<Partial<SessionProfile>>;

export type ModelSessionProfilePreferences = Readonly<
  Omit<SessionProfilePreferences, "model">
>;

export interface SessionProfilePreferenceLayers {
  readonly global?: SessionProfilePreferences;
  readonly runtime?: SessionProfilePreferences;
  readonly models?: Readonly<Record<string, ModelSessionProfilePreferences>>;
}

export interface ResolveSessionProfileInput {
  readonly catalog: RuntimeCatalog;
  readonly catalogRevision: string;
  readonly preferences: SessionProfilePreferenceLayers;
  readonly currentProfile?: SessionProfile;
  readonly overrides?: SessionProfilePreferences;
}

export interface ResolvedSessionProfile {
  readonly runtime: string;
  readonly profile: SessionProfile;
  readonly catalogRevision: string;
}

export type SessionProfileResolutionFailureCategory =
  | "incomplete-profile"
  | "unsupported-selection";

export interface SessionProfileValidAlternatives {
  readonly models: readonly string[];
  readonly effortLevels: readonly string[];
  readonly executionModes: readonly string[];
  readonly accessModes: readonly string[];
}

export class SessionProfileResolutionError extends Error {
  readonly category: SessionProfileResolutionFailureCategory;
  readonly alternatives?: SessionProfileValidAlternatives;

  constructor(
    category: SessionProfileResolutionFailureCategory,
    alternatives?: SessionProfileValidAlternatives,
  ) {
    super("Session Profile resolution failed.");
    this.name = "SessionProfileResolutionError";
    this.category = category;
    this.alternatives = alternatives;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export function resolveSessionProfile(
  input: ResolveSessionProfileInput,
): ResolvedSessionProfile {
  const basePreferences: SessionProfilePreferences = {
    ...input.preferences.global,
    ...input.preferences.runtime,
  };
  const selectedModel =
    input.overrides?.model ?? input.currentProfile?.model ?? basePreferences.model;
  const modelPreferences = getModelPreferences(
    input.preferences.models,
    selectedModel,
  );
  let preferences: SessionProfilePreferences;
  if (input.currentProfile === undefined) {
    preferences = {
      ...basePreferences,
      model: selectedModel,
      ...modelPreferences,
      ...input.overrides,
    };
  } else if (selectedModel !== input.currentProfile.model) {
    preferences = {
      ...input.currentProfile,
      model: selectedModel,
      ...modelPreferences,
      ...input.overrides,
      accessMode: input.overrides?.accessMode ?? input.currentProfile.accessMode,
    };
  } else {
    preferences = {
      ...input.currentProfile,
      ...input.overrides,
      accessMode: input.overrides?.accessMode ?? input.currentProfile.accessMode,
    };
  }
  if (
    preferences.model === undefined ||
    preferences.effortLevel === undefined ||
    preferences.executionMode === undefined ||
    preferences.accessMode === undefined
  ) {
    throw new SessionProfileResolutionError("incomplete-profile");
  }

  const profile: SessionProfile = {
    model: preferences.model,
    effortLevel: preferences.effortLevel,
    executionMode: preferences.executionMode,
    accessMode: preferences.accessMode,
  };
  const model = input.catalog.models.find((candidate) => candidate.id === profile.model);
  if (
    model === undefined ||
    !model.effortLevels.includes(profile.effortLevel) ||
    !input.catalog.executionModes.includes(profile.executionMode) ||
    !input.catalog.accessModes.includes(profile.accessMode)
  ) {
    throw new SessionProfileResolutionError("unsupported-selection", {
      models: input.catalog.models.map((candidate) => candidate.id),
      effortLevels: model === undefined ? [] : [...model.effortLevels],
      executionModes: [...input.catalog.executionModes],
      accessModes: [...input.catalog.accessModes],
    });
  }

  return {
    runtime: input.catalog.runtime,
    profile,
    catalogRevision: input.catalogRevision,
  };
}

function getModelPreferences(
  models: SessionProfilePreferenceLayers["models"],
  selectedModel: string | undefined,
): ModelSessionProfilePreferences | undefined {
  if (
    models === undefined ||
    selectedModel === undefined ||
    !Object.prototype.hasOwnProperty.call(models, selectedModel)
  ) {
    return undefined;
  }
  return models[selectedModel];
}
