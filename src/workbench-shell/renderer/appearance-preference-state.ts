import {
  defaultWorkbenchAppearancePreference,
  type WorkbenchAppearanceCrt,
  type WorkbenchAppearancePhosphor,
  type WorkbenchAppearancePhosphorTier,
  type WorkbenchAppearancePreference,
  type WorkbenchAppearancePreferenceLoadResult,
  type WorkbenchAppearancePreferenceSaveResult,
  type WorkbenchAppearanceTone,
  type WorkbenchLanguage,
} from "../contract.ts";

export type WorkbenchAppearanceAction =
  | Readonly<{ type: "set-tone"; tone: WorkbenchAppearanceTone }>
  | Readonly<{ type: "set-crt"; crt: WorkbenchAppearanceCrt }>
  | Readonly<{
      type: "set-phosphor";
      phosphor: WorkbenchAppearancePhosphor;
    }>
  | Readonly<{
      type: "set-phosphor-tier";
      phosphorTier: WorkbenchAppearancePhosphorTier;
    }>
  | Readonly<{ type: "set-language"; language: WorkbenchLanguage }>;

export type WorkbenchAppearancePersistencePhase =
  | "hydrating"
  | "saving"
  | "saved"
  | "error";

export interface WorkbenchAppearancePersistenceState {
  readonly appearance: WorkbenchAppearancePreference;
  readonly intentRevision: number;
  readonly saveRevision: number;
  readonly phase: WorkbenchAppearancePersistencePhase;
}

export interface WorkbenchAppearancePreferenceSaveRequest {
  readonly revision: number;
  readonly preference: WorkbenchAppearancePreference;
}

export interface WorkbenchAppearancePreferenceChange {
  readonly state: WorkbenchAppearancePersistenceState;
  readonly request: WorkbenchAppearancePreferenceSaveRequest | null;
}

export const initialWorkbenchAppearancePersistenceState: WorkbenchAppearancePersistenceState =
  freezeState({
    appearance: defaultWorkbenchAppearancePreference,
    intentRevision: 0,
    saveRevision: 0,
    phase: "hydrating",
  });

export function beginWorkbenchAppearancePreferenceChange(
  state: WorkbenchAppearancePersistenceState,
  action: WorkbenchAppearanceAction,
): WorkbenchAppearancePreferenceChange {
  const appearance = reduceWorkbenchAppearance(state.appearance, action);
  if (appearance === state.appearance && state.phase !== "hydrating") {
    return Object.freeze({ state, request: null });
  }
  const revision = state.saveRevision + 1;
  const next = freezeState({
    appearance,
    intentRevision: state.intentRevision + 1,
    saveRevision: revision,
    phase: "saving",
  });
  return Object.freeze({
    state: next,
    request: Object.freeze({ revision, preference: next.appearance }),
  });
}

export function completeWorkbenchAppearancePreferenceHydration(
  state: WorkbenchAppearancePersistenceState,
  capturedIntentRevision: number,
  result: WorkbenchAppearancePreferenceLoadResult,
): WorkbenchAppearancePersistenceState {
  if (state.intentRevision !== capturedIntentRevision) return state;
  return result.ok
    ? freezeState({
        ...state,
        appearance: result.appearance,
        phase: "saved",
      })
    : freezeState({ ...state, phase: "error" });
}

export function completeWorkbenchAppearancePreferenceSave(
  state: WorkbenchAppearancePersistenceState,
  saveRevision: number,
  result: WorkbenchAppearancePreferenceSaveResult,
): WorkbenchAppearancePersistenceState {
  if (state.saveRevision !== saveRevision) return state;
  return freezeState({
    ...state,
    phase: result.ok ? "saved" : "error",
  });
}

export function reduceWorkbenchAppearance(
  appearance: WorkbenchAppearancePreference,
  action: WorkbenchAppearanceAction,
): WorkbenchAppearancePreference {
  switch (action.type) {
    case "set-tone":
      return appearance.tone === action.tone
        ? appearance
        : Object.freeze({ ...appearance, tone: action.tone });
    case "set-crt":
      return appearance.crt === action.crt
        ? appearance
        : Object.freeze({ ...appearance, crt: action.crt });
    case "set-phosphor":
      return appearance.phosphor === action.phosphor
        ? appearance
        : Object.freeze({ ...appearance, phosphor: action.phosphor });
    case "set-phosphor-tier":
      return appearance.phosphorTier === action.phosphorTier
        ? appearance
        : Object.freeze({ ...appearance, phosphorTier: action.phosphorTier });
    case "set-language":
      return appearance.language === action.language
        ? appearance
        : Object.freeze({ ...appearance, language: action.language });
  }
}

function freezeState(value: {
  readonly appearance: WorkbenchAppearancePreference;
  readonly intentRevision: number;
  readonly saveRevision: number;
  readonly phase: WorkbenchAppearancePersistencePhase;
}): WorkbenchAppearancePersistenceState {
  return Object.freeze({
    appearance: Object.freeze({
      tone: value.appearance.tone,
      crt: value.appearance.crt,
      phosphor: value.appearance.phosphor,
      phosphorTier: value.appearance.phosphorTier,
      language: value.appearance.language ?? "en",
    }),
    intentRevision: value.intentRevision,
    saveRevision: value.saveRevision,
    phase: value.phase,
  });
}
