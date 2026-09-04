import {
  defaultWorkbenchClaudePermissionHandling,
  type WorkbenchClaudePermissionHandling,
  type WorkbenchClaudePermissionHandlingLoadResult,
  type WorkbenchClaudePermissionHandlingSaveResult,
} from "../contract.ts";

export type WorkbenchClaudePermissionHandlingPersistencePhase =
  | "hydrating"
  | "saving"
  | "saved"
  | "load-error"
  | "save-error";

export interface WorkbenchClaudePermissionHandlingPersistenceState {
  readonly permissionHandling: WorkbenchClaudePermissionHandling;
  readonly confirmedPermissionHandling: WorkbenchClaudePermissionHandling;
  readonly intentRevision: number;
  readonly saveRevision: number;
  readonly phase: WorkbenchClaudePermissionHandlingPersistencePhase;
}

export interface WorkbenchClaudePermissionHandlingSaveRequest {
  readonly revision: number;
  readonly permissionHandling: WorkbenchClaudePermissionHandling;
}

export interface WorkbenchClaudePermissionHandlingChange {
  readonly state: WorkbenchClaudePermissionHandlingPersistenceState;
  readonly request: WorkbenchClaudePermissionHandlingSaveRequest | null;
}

export const initialWorkbenchClaudePermissionHandlingPersistenceState: WorkbenchClaudePermissionHandlingPersistenceState =
  freezeState({
    permissionHandling: defaultWorkbenchClaudePermissionHandling,
    confirmedPermissionHandling: defaultWorkbenchClaudePermissionHandling,
    intentRevision: 0,
    saveRevision: 0,
    phase: "hydrating",
  });

export function beginWorkbenchClaudePermissionHandlingChange(
  state: WorkbenchClaudePermissionHandlingPersistenceState,
  permissionHandling: WorkbenchClaudePermissionHandling,
): WorkbenchClaudePermissionHandlingChange {
  if (state.phase === "saving") {
    return Object.freeze({ state, request: null });
  }
  if (
    permissionHandling === state.permissionHandling &&
    state.phase !== "hydrating" &&
    state.phase !== "load-error"
  ) {
    return Object.freeze({ state, request: null });
  }
  const revision = state.saveRevision + 1;
  const next = freezeState({
    permissionHandling,
    confirmedPermissionHandling: state.confirmedPermissionHandling,
    intentRevision: state.intentRevision + 1,
    saveRevision: revision,
    phase: "saving",
  });
  return Object.freeze({
    state: next,
    request: Object.freeze({ revision, permissionHandling }),
  });
}

export function completeWorkbenchClaudePermissionHandlingHydration(
  state: WorkbenchClaudePermissionHandlingPersistenceState,
  capturedIntentRevision: number,
  result: WorkbenchClaudePermissionHandlingLoadResult,
): WorkbenchClaudePermissionHandlingPersistenceState {
  if (state.intentRevision !== capturedIntentRevision) return state;
  return result.ok
    ? freezeState({
        ...state,
        permissionHandling: result.permissionHandling,
        confirmedPermissionHandling: result.permissionHandling,
        phase: "saved",
      })
    : freezeState({ ...state, phase: "load-error" });
}

export function completeWorkbenchClaudePermissionHandlingSave(
  state: WorkbenchClaudePermissionHandlingPersistenceState,
  saveRevision: number,
  result: WorkbenchClaudePermissionHandlingSaveResult,
): WorkbenchClaudePermissionHandlingPersistenceState {
  if (state.saveRevision !== saveRevision) return state;
  return result.ok
    ? freezeState({
        ...state,
        confirmedPermissionHandling: state.permissionHandling,
        phase: "saved",
      })
    : freezeState({
        ...state,
        permissionHandling: state.confirmedPermissionHandling,
        phase: "save-error",
      });
}

function freezeState(value: {
  readonly permissionHandling: WorkbenchClaudePermissionHandling;
  readonly confirmedPermissionHandling: WorkbenchClaudePermissionHandling;
  readonly intentRevision: number;
  readonly saveRevision: number;
  readonly phase: WorkbenchClaudePermissionHandlingPersistencePhase;
}): WorkbenchClaudePermissionHandlingPersistenceState {
  return Object.freeze({
    permissionHandling: value.permissionHandling,
    confirmedPermissionHandling: value.confirmedPermissionHandling,
    intentRevision: value.intentRevision,
    saveRevision: value.saveRevision,
    phase: value.phase,
  });
}
