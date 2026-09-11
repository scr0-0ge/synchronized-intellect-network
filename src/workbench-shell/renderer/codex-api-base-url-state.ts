import {
  defaultWorkbenchCodexApiBaseUrl,
  type WorkbenchCodexApiBaseUrlLoadResult,
  type WorkbenchCodexApiBaseUrlSaveResult,
} from "../contract.ts";

/**
 * Renderer-side state for the Codex · API card's "Base URL (optional)" field
 * (w223): the same draft/busy/save shape as the endpoint-key block
 * (endpoint-key-state.ts), minus reveal/remove/probe -- the value is plain
 * text, not a secret, and clearing the draft to empty is how a user undoes
 * an override (there is no separate remove action).
 */

export type WorkbenchCodexApiBaseUrlPhase =
  | "hydrating"
  | "ready"
  | "unavailable";

export type WorkbenchCodexApiBaseUrlFeedback = "save-invalid" | "save-failed";

export interface WorkbenchCodexApiBaseUrlState {
  readonly phase: WorkbenchCodexApiBaseUrlPhase;
  /** The last value confirmed durably saved; "" means not set. */
  readonly savedBaseUrl: string;
  readonly draft: string;
  readonly busy: boolean;
  readonly feedback: WorkbenchCodexApiBaseUrlFeedback | null;
}

/** Presentation contract between mount (state owner) and the Settings card. */
export interface WorkbenchCodexApiBaseUrlPanel {
  readonly phase: WorkbenchCodexApiBaseUrlPhase;
  readonly savedBaseUrl: string;
  readonly draft: string;
  readonly busy: boolean;
  readonly feedback: WorkbenchCodexApiBaseUrlFeedback | null;
  readonly onDraft: (draft: string) => void;
  readonly onSave: () => void;
}

export const initialWorkbenchCodexApiBaseUrlState: WorkbenchCodexApiBaseUrlState =
  freezeState({
    phase: "hydrating",
    savedBaseUrl: defaultWorkbenchCodexApiBaseUrl,
    draft: "",
    busy: false,
    feedback: null,
  });

export function completeWorkbenchCodexApiBaseUrlHydration(
  state: WorkbenchCodexApiBaseUrlState,
  result: WorkbenchCodexApiBaseUrlLoadResult,
): WorkbenchCodexApiBaseUrlState {
  if (state.phase !== "hydrating") return state;
  return result.ok
    ? freezeState({
        ...state,
        phase: "ready",
        savedBaseUrl: result.baseUrl,
        draft: result.baseUrl,
      })
    : freezeState({ ...state, phase: "unavailable" });
}

export function changeWorkbenchCodexApiBaseUrlDraft(
  state: WorkbenchCodexApiBaseUrlState,
  draft: string,
): WorkbenchCodexApiBaseUrlState {
  if (state.busy) return state;
  return freezeState({
    ...state,
    draft,
    feedback: state.feedback === "save-invalid" ? null : state.feedback,
  });
}

export interface WorkbenchCodexApiBaseUrlSaveRequest {
  readonly state: WorkbenchCodexApiBaseUrlState;
  readonly baseUrl: string | null;
}

export function beginWorkbenchCodexApiBaseUrlSave(
  state: WorkbenchCodexApiBaseUrlState,
): WorkbenchCodexApiBaseUrlSaveRequest {
  if (state.busy || state.phase !== "ready") {
    return Object.freeze({ state, baseUrl: null });
  }
  const baseUrl = state.draft.trim();
  return Object.freeze({
    state: freezeState({ ...state, busy: true, feedback: null }),
    baseUrl,
  });
}

export function completeWorkbenchCodexApiBaseUrlSave(
  state: WorkbenchCodexApiBaseUrlState,
  result: WorkbenchCodexApiBaseUrlSaveResult,
): WorkbenchCodexApiBaseUrlState {
  if (!state.busy) return state;
  if (!result.ok) {
    return freezeState({
      ...state,
      busy: false,
      feedback:
        result.error.category === "codex-api-base-url-rejected"
          ? "save-invalid"
          : "save-failed",
    });
  }
  return freezeState({
    ...state,
    busy: false,
    savedBaseUrl: result.baseUrl,
    draft: result.baseUrl,
    feedback: null,
  });
}

function freezeState(
  value: WorkbenchCodexApiBaseUrlState,
): WorkbenchCodexApiBaseUrlState {
  return Object.freeze({
    phase: value.phase,
    savedBaseUrl: value.savedBaseUrl,
    draft: value.draft,
    busy: value.busy,
    feedback: value.feedback,
  });
}
