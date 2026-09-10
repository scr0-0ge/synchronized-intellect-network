import {
  defaultWorkbenchFamilyEndpointPreferences,
  type WorkbenchFamilyEndpointPreference,
  type WorkbenchFamilyEndpointPreferences,
  type WorkbenchEndpointPreferenceLoadResult,
  type WorkbenchEndpointPreferenceSaveResult,
} from "../contract.ts";

export type WorkbenchEndpointPreferencePersistencePhase =
  | "hydrating"
  | "saving"
  | "saved"
  | "load-error"
  | "save-error";

/**
 * The family facade's per-family backend preferences (ticket 25, the
 * generalization of ticket 20's Kimi-only machine). One machine holds the
 * whole record; a save replaces one family's slot and keeps the other two.
 */
export interface WorkbenchEndpointPreferencePersistenceState {
  readonly preferences: WorkbenchFamilyEndpointPreferences;
  readonly confirmedPreferences: WorkbenchFamilyEndpointPreferences;
  readonly intentRevision: number;
  readonly saveRevision: number;
  readonly phase: WorkbenchEndpointPreferencePersistencePhase;
}

export interface WorkbenchEndpointPreferenceSaveRequest {
  readonly revision: number;
  readonly preference: WorkbenchFamilyEndpointPreference;
}

export interface WorkbenchEndpointPreferenceChange {
  readonly state: WorkbenchEndpointPreferencePersistenceState;
  readonly request: WorkbenchEndpointPreferenceSaveRequest | null;
}

export const initialWorkbenchEndpointPreferencePersistenceState: WorkbenchEndpointPreferencePersistenceState =
  freezeState({
    preferences: defaultWorkbenchFamilyEndpointPreferences,
    confirmedPreferences: defaultWorkbenchFamilyEndpointPreferences,
    intentRevision: 0,
    saveRevision: 0,
    phase: "hydrating",
  });

export function beginWorkbenchEndpointPreferenceChange(
  state: WorkbenchEndpointPreferencePersistenceState,
  preference: WorkbenchFamilyEndpointPreference,
): WorkbenchEndpointPreferenceChange {
  if (state.phase === "saving") {
    return Object.freeze({ state, request: null });
  }
  if (
    state.preferences[workbenchFamilyOf(preference)] === preference &&
    state.phase !== "hydrating" &&
    state.phase !== "load-error"
  ) {
    return Object.freeze({ state, request: null });
  }
  const revision = state.saveRevision + 1;
  const next = freezeState({
    preferences: withFamilyPreference(state.preferences, preference),
    confirmedPreferences: state.confirmedPreferences,
    intentRevision: state.intentRevision + 1,
    saveRevision: revision,
    phase: "saving",
  });
  return Object.freeze({
    state: next,
    request: Object.freeze({ revision, preference }),
  });
}

export function completeWorkbenchEndpointPreferenceHydration(
  state: WorkbenchEndpointPreferencePersistenceState,
  capturedIntentRevision: number,
  result: WorkbenchEndpointPreferenceLoadResult,
): WorkbenchEndpointPreferencePersistenceState {
  if (state.intentRevision !== capturedIntentRevision) return state;
  return result.ok
    ? freezeState({
        ...state,
        preferences: result.preferences,
        confirmedPreferences: result.preferences,
        phase: "saved",
      })
    : freezeState({ ...state, phase: "load-error" });
}

export function completeWorkbenchEndpointPreferenceSave(
  state: WorkbenchEndpointPreferencePersistenceState,
  saveRevision: number,
  result: WorkbenchEndpointPreferenceSaveResult,
): WorkbenchEndpointPreferencePersistenceState {
  if (state.saveRevision !== saveRevision) return state;
  return result.ok
    ? freezeState({
        ...state,
        confirmedPreferences: state.preferences,
        phase: "saved",
      })
    : freezeState({
        ...state,
        preferences: state.confirmedPreferences,
        phase: "save-error",
      });
}

function workbenchFamilyOf(
  preference: WorkbenchFamilyEndpointPreference,
): keyof WorkbenchFamilyEndpointPreferences {
  if (preference === "claude-code-desktop" || preference === "claude-api") {
    return "claude";
  }
  if (preference === "codex-desktop" || preference === "codex-api") {
    return "codex";
  }
  return "kimi";
}

function withFamilyPreference(
  preferences: WorkbenchFamilyEndpointPreferences,
  preference: WorkbenchFamilyEndpointPreference,
): WorkbenchFamilyEndpointPreferences {
  return Object.freeze({
    ...preferences,
    [workbenchFamilyOf(preference)]: preference,
  });
}

function freezeState(value: {
  readonly preferences: WorkbenchFamilyEndpointPreferences;
  readonly confirmedPreferences: WorkbenchFamilyEndpointPreferences;
  readonly intentRevision: number;
  readonly saveRevision: number;
  readonly phase: WorkbenchEndpointPreferencePersistencePhase;
}): WorkbenchEndpointPreferencePersistenceState {
  return Object.freeze({
    preferences: value.preferences,
    confirmedPreferences: value.confirmedPreferences,
    intentRevision: value.intentRevision,
    saveRevision: value.saveRevision,
    phase: value.phase,
  });
}
