import {
  defaultWorkbenchBaseUrl,
  type WorkbenchBaseUrlLoadResult,
  type WorkbenchBaseUrlSaveResult,
} from "../contract.ts";

/**
 * Renderer-side state for a base-URL endpoint's "Base URL (optional)" field
 * (w223 shipped this for Codex · API; w232 generalizes it across all four
 * base-URL endpoints instead of copying it): the same draft/busy/save shape
 * as the endpoint-key block (endpoint-key-state.ts), minus reveal/remove/
 * probe -- the value is plain text, not a secret, and clearing the draft to
 * empty is how a user undoes an override (there is no separate remove
 * action).
 */

export type WorkbenchEndpointBaseUrlPhase =
  | "hydrating"
  | "ready"
  | "unavailable";

export type WorkbenchEndpointBaseUrlFeedback = "save-invalid" | "save-failed";

export interface WorkbenchEndpointBaseUrlState {
  readonly phase: WorkbenchEndpointBaseUrlPhase;
  /** The last value confirmed durably saved; "" means not set. */
  readonly savedBaseUrl: string;
  readonly draft: string;
  readonly busy: boolean;
  readonly feedback: WorkbenchEndpointBaseUrlFeedback | null;
}

/** Presentation contract between mount (state owner) and the Settings card. */
export interface WorkbenchEndpointBaseUrlPanel {
  readonly phase: WorkbenchEndpointBaseUrlPhase;
  readonly savedBaseUrl: string;
  readonly draft: string;
  readonly busy: boolean;
  readonly feedback: WorkbenchEndpointBaseUrlFeedback | null;
  readonly onDraft: (draft: string) => void;
  readonly onSave: () => void;
}

export const initialWorkbenchEndpointBaseUrlState: WorkbenchEndpointBaseUrlState =
  freezeState({
    phase: "hydrating",
    savedBaseUrl: defaultWorkbenchBaseUrl,
    draft: "",
    busy: false,
    feedback: null,
  });

export function completeWorkbenchEndpointBaseUrlHydration(
  state: WorkbenchEndpointBaseUrlState,
  result: WorkbenchBaseUrlLoadResult,
): WorkbenchEndpointBaseUrlState {
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

export function changeWorkbenchEndpointBaseUrlDraft(
  state: WorkbenchEndpointBaseUrlState,
  draft: string,
): WorkbenchEndpointBaseUrlState {
  if (state.busy) return state;
  return freezeState({
    ...state,
    draft,
    feedback: state.feedback === "save-invalid" ? null : state.feedback,
  });
}

export interface WorkbenchEndpointBaseUrlSaveRequest {
  readonly state: WorkbenchEndpointBaseUrlState;
  readonly baseUrl: string | null;
}

export function beginWorkbenchEndpointBaseUrlSave(
  state: WorkbenchEndpointBaseUrlState,
): WorkbenchEndpointBaseUrlSaveRequest {
  if (state.busy || state.phase !== "ready") {
    return Object.freeze({ state, baseUrl: null });
  }
  const baseUrl = state.draft.trim();
  return Object.freeze({
    state: freezeState({ ...state, busy: true, feedback: null }),
    baseUrl,
  });
}

export function completeWorkbenchEndpointBaseUrlSave(
  state: WorkbenchEndpointBaseUrlState,
  result: WorkbenchBaseUrlSaveResult,
): WorkbenchEndpointBaseUrlState {
  if (!state.busy) return state;
  if (!result.ok) {
    return freezeState({
      ...state,
      busy: false,
      feedback:
        result.error.category === "base-url-rejected"
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
  value: WorkbenchEndpointBaseUrlState,
): WorkbenchEndpointBaseUrlState {
  return Object.freeze({
    phase: value.phase,
    savedBaseUrl: value.savedBaseUrl,
    draft: value.draft,
    busy: value.busy,
    feedback: value.feedback,
  });
}
