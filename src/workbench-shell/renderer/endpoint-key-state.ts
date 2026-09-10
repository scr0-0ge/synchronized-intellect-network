import {
  isValidWorkbenchEndpointKeyValue,
  type WorkbenchEndpointKeyRemoveResult,
  type WorkbenchEndpointKeyRevealResult,
  type WorkbenchEndpointKeySaveResult,
  type WorkbenchEndpointKeySnapshot,
  type WorkbenchEndpointKeyStatusResult,
  type WorkbenchEndpointProbeOutcome,
  type WorkbenchEndpointProbeResult,
} from "../contract.ts";

/**
 * Renderer-side state for the Settings endpoint-key block (GLM, Kimi and
 * DeepSeek share one machine; WO16 Part 1 generalized the GLM-only original
 * without changing its semantics). Pure transition functions over frozen
 * state, mirroring the appearance-preference-state discipline: hydration is
 * revision-free (one call), actions carry an explicit busy slot, and results
 * update the snapshot the main process already returned so no refetch round
 * trip is needed.
 */

export type WorkbenchEndpointKeyPhase = "hydrating" | "ready" | "unavailable";

export type WorkbenchEndpointKeyBusy =
  | "save"
  | "remove"
  | "reveal"
  | "probe";

export type WorkbenchEndpointKeyFeedback =
  | "save-invalid"
  | "save-failed"
  | "remove-failed"
  | "reveal-failed"
  | "probe-failed";

export interface WorkbenchEndpointKeyState {
  readonly phase: WorkbenchEndpointKeyPhase;
  readonly snapshot: WorkbenchEndpointKeySnapshot | null;
  readonly draft: string;
  readonly busy: WorkbenchEndpointKeyBusy | null;
  readonly revealed: boolean;
  readonly revealedValue: string | null;
  readonly probeOutcome: WorkbenchEndpointProbeOutcome | null;
  readonly feedback: WorkbenchEndpointKeyFeedback | null;
}

export const initialWorkbenchEndpointKeyState: WorkbenchEndpointKeyState =
  freezeState({
    phase: "hydrating",
    snapshot: null,
    draft: "",
    busy: null,
    revealed: false,
    revealedValue: null,
    probeOutcome: null,
    feedback: null,
  });

/**
 * Presentation contract between mount (state owner) and the Settings key
 * block (pure renderer). Present only when the bridge supports the
 * endpoint-key channels for this endpoint; absent means the block is not
 * rendered at all.
 */
export interface WorkbenchEndpointKeyPanel {
  readonly phase: WorkbenchEndpointKeyPhase;
  readonly snapshot: WorkbenchEndpointKeySnapshot | null;
  readonly draft: string;
  readonly busy: WorkbenchEndpointKeyBusy | null;
  readonly revealed: boolean;
  readonly revealedValue: string | null;
  readonly probeOutcome: WorkbenchEndpointProbeOutcome | null;
  readonly feedback: WorkbenchEndpointKeyFeedback | null;
  readonly onDraft: (draft: string) => void;
  readonly onSave: () => void;
  readonly onReveal: () => void;
  readonly onHideReveal: () => void;
  readonly onRemove: () => void;
  readonly onProbe: () => void;
}

export function completeWorkbenchEndpointKeyHydration(
  state: WorkbenchEndpointKeyState,
  result: WorkbenchEndpointKeyStatusResult,
): WorkbenchEndpointKeyState {
  if (state.phase !== "hydrating") return state;
  return result.ok
    ? freezeState({
        ...state,
        phase: "ready",
        snapshot: result.snapshot,
      })
    : freezeState({ ...state, phase: "unavailable" });
}

export function changeWorkbenchEndpointKeyDraft(
  state: WorkbenchEndpointKeyState,
  draft: string,
): WorkbenchEndpointKeyState {
  if (state.busy !== null) return state;
  return freezeState({
    ...state,
    draft,
    feedback: state.feedback === "save-invalid" ? null : state.feedback,
  });
}

export interface WorkbenchEndpointKeySaveRequest {
  readonly state: WorkbenchEndpointKeyState;
  readonly keyValue: string | null;
}

export function beginWorkbenchEndpointKeySave(
  state: WorkbenchEndpointKeyState,
): WorkbenchEndpointKeySaveRequest {
  if (state.busy !== null || state.phase !== "ready") {
    return Object.freeze({ state, keyValue: null });
  }
  const keyValue = state.draft.trim();
  if (!isValidWorkbenchEndpointKeyValue(keyValue)) {
    return Object.freeze({
      state: freezeState({ ...state, feedback: "save-invalid" }),
      keyValue: null,
    });
  }
  return Object.freeze({
    state: freezeState({
      ...state,
      busy: "save",
      feedback: null,
    }),
    keyValue,
  });
}

export function completeWorkbenchEndpointKeySave(
  state: WorkbenchEndpointKeyState,
  result: WorkbenchEndpointKeySaveResult,
): WorkbenchEndpointKeyState {
  if (state.busy !== "save") return state;
  if (!result.ok) {
    return freezeState({
      ...state,
      busy: null,
      feedback: "save-failed",
    });
  }
  return freezeState({
    ...state,
    busy: null,
    draft: "",
    snapshot: applySavedMask(state.snapshot, result.maskedHint, result.isPersistent),
    revealed: false,
    revealedValue: null,
    probeOutcome: null,
  });
}

export function beginWorkbenchEndpointKeyRemove(
  state: WorkbenchEndpointKeyState,
): WorkbenchEndpointKeyState {
  if (
    state.busy !== null ||
    state.phase !== "ready" ||
    state.snapshot?.configured !== true
  ) {
    return state;
  }
  return freezeState({ ...state, busy: "remove", feedback: null });
}

export function completeWorkbenchEndpointKeyRemove(
  state: WorkbenchEndpointKeyState,
  result: WorkbenchEndpointKeyRemoveResult,
): WorkbenchEndpointKeyState {
  if (state.busy !== "remove") return state;
  if (!result.ok) {
    return freezeState({ ...state, busy: null, feedback: "remove-failed" });
  }
  return freezeState({
    ...state,
    busy: null,
    snapshot: result.snapshot,
    revealed: false,
    revealedValue: null,
    probeOutcome: null,
  });
}

export function beginWorkbenchEndpointKeyReveal(
  state: WorkbenchEndpointKeyState,
): WorkbenchEndpointKeyState {
  if (
    state.busy !== null ||
    state.phase !== "ready" ||
    state.snapshot?.configured !== true
  ) {
    return state;
  }
  return freezeState({ ...state, busy: "reveal", feedback: null });
}

export function completeWorkbenchEndpointKeyReveal(
  state: WorkbenchEndpointKeyState,
  result: WorkbenchEndpointKeyRevealResult,
): WorkbenchEndpointKeyState {
  if (state.busy !== "reveal") return state;
  if (!result.ok) {
    return freezeState({ ...state, busy: null, feedback: "reveal-failed" });
  }
  return freezeState({
    ...state,
    busy: null,
    snapshot: result.snapshot,
    revealed: result.status === "revealed",
    revealedValue: result.status === "revealed" ? result.value : null,
  });
}

export function hideWorkbenchEndpointKeyReveal(
  state: WorkbenchEndpointKeyState,
): WorkbenchEndpointKeyState {
  if (!state.revealed) return state;
  return freezeState({ ...state, revealed: false });
}

export function beginWorkbenchEndpointKeyProbe(
  state: WorkbenchEndpointKeyState,
): WorkbenchEndpointKeyState {
  if (state.busy !== null || state.phase !== "ready") {
    return state;
  }
  return freezeState({ ...state, busy: "probe", feedback: null });
}

export function completeWorkbenchEndpointKeyProbe(
  state: WorkbenchEndpointKeyState,
  result: WorkbenchEndpointProbeResult,
): WorkbenchEndpointKeyState {
  if (state.busy !== "probe") return state;
  if (!result.ok) {
    return freezeState({ ...state, busy: null, feedback: "probe-failed" });
  }
  return freezeState({
    ...state,
    busy: null,
    probeOutcome: result.probe,
  });
}

function applySavedMask(
  current: WorkbenchEndpointKeySnapshot | null,
  maskedHint: string,
  isPersistent: boolean,
): WorkbenchEndpointKeySnapshot {
  return Object.freeze({
    configured: true,
    maskedHint,
    isPersistent,
    environmentFallback: current?.environmentFallback ?? false,
  });
}

function freezeState(
  value: WorkbenchEndpointKeyState,
): WorkbenchEndpointKeyState {
  return Object.freeze({
    phase: value.phase,
    snapshot:
      value.snapshot === null
        ? null
        : Object.freeze({
            configured: value.snapshot.configured,
            maskedHint: value.snapshot.maskedHint,
            isPersistent: value.snapshot.isPersistent,
            environmentFallback: value.snapshot.environmentFallback,
          }),
    draft: value.draft,
    busy: value.busy,
    revealed: value.revealed,
    revealedValue: value.revealedValue,
    probeOutcome:
      value.probeOutcome === null
        ? null
        : Object.freeze(
            value.probeOutcome.outcome === "success"
              ? { outcome: "success" }
              : {
                  outcome: "failure",
                  reason: value.probeOutcome.reason,
                },
          ),
    feedback: value.feedback,
  });
}
