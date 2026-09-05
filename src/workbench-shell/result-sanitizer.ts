import type {
  ProjectCommandFailureCategory,
  ProjectCommandStatus,
} from "../coordinator/index.ts";
import {
  cloneEffectiveSessionProfileProjection,
  cloneRequestedSessionProfileProjection,
} from "../coordinator/profile-projection.ts";
import { normalizeSessionDisplayName } from "../session-metadata.ts";
import { redactFilesystemPaths } from "./path-redaction.ts";
import {
  isValidWorkbenchDirectInput,
  publicAppearancePreferenceLoaded,
  publicAppearancePreferenceSaved,
  publicAppearancePreferenceUnavailable,
  publicClaudePermissionHandlingLoaded,
  publicRuntimeExecutablesLoaded,
  publicRuntimeExecutableSaved,
  publicRuntimeExecutableRejected,
  publicRuntimeExecutableUnavailable,
  WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH,
  publicClaudePermissionHandlingSaved,
  publicClaudePermissionHandlingUnavailable,
  publicCreateProjectResult,
  publicContinuationProfileUnavailable,
  publicContinuationModelUnavailable,
  publicContinuationUnavailable,
  publicInvalidProfileSelection,
  publicInvalidProfileDefaultSelection,
  publicInvalidSubmission,
  publicInterruptRequested,
  publicInterruptUnavailable,
  publicInvalidInterrupt,
  publicInvalidSteer,
  publicProfileUnavailable,
  publicRuntimeEndpointDiscovery,
  publicRuntimeNotLocated,
  publicProfileDefaultSaved,
  publicPreferenceUnavailable,
  publicHostedProjectFailure,
  publicInvalidProjectSelection,
  publicProjectFailure,
  publicProjectOpened,
  publicProjectOpenedWithExistingHistory,
  publicProjectOpenCancelled,
  publicOpenProjectHistorySelectionRequired,
  publicProjectOpenUnavailable,
  publicProjectHistorySelectionRequired,
  publicProjectSelected,
  publicProjectSelectedWithExistingHistory,
  publicProjectSwitchUnavailable,
  publicProjectUnavailable,
  publicSubmissionAccepted,
  publicSteerAccepted,
  publicSteerUnavailable,
  publicSubscriptionAuthenticationEffect,
  publicSubscriptionAuthenticationSnapshot,
  publicSubscriptionAuthenticationUnavailable,
  publicUnavailableSubmission,
  publicRuntimeStartUnsupported,
  type WorkbenchCommandView,
  type WorkbenchAppearancePreference,
  type WorkbenchAppearancePreferenceLoadResult,
  type WorkbenchAppearancePreferenceSaveResult,
  type WorkbenchClaudePermissionHandling,
  type WorkbenchClaudePermissionHandlingLoadResult,
  type WorkbenchRuntimeExecutablePaths,
  type WorkbenchRuntimeExecutableRejection,
  type WorkbenchRuntimeExecutableSaveRequest,
  type WorkbenchRuntimeExecutableSaveResult,
  type WorkbenchRuntimeExecutablesLoadResult,
  type WorkbenchClaudePermissionHandlingSaveResult,
  type WorkbenchCreateProjectResult,
  type WorkbenchDirectInputRequest,
  type WorkbenchStartDirectInputRequest,
  type WorkbenchContinueDirectInputRequest,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchCatalogDefaultPublicProfileResult,
  type WorkbenchContinuationPrefill,
  type WorkbenchDirectSessionProfile,
  type WorkbenchLoadedDirectSessionProfile,
  type WorkbenchAnyPublicDirectSessionProfileResult,
  type WorkbenchPublicDirectSessionProfileResultFor,
  type WorkbenchReplacementPrefill,
  type WorkbenchRuntimeEndpointOption,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointDiscoveryCategory,
  type WorkbenchRuntimeEndpointId,
  type WorkbenchHostedProjectResult,
  type WorkbenchHostedProjectView,
  type WorkbenchInterruptControl,
  type WorkbenchInterruptRequest,
  type WorkbenchInterruptResult,
  type WorkbenchSteerControl,
  type WorkbenchSteerRequest,
  type WorkbenchSteerResult,
  type WorkbenchOpenProjectResult,
  type WorkbenchProjectAvailability,
  type WorkbenchProjectResult,
  type WorkbenchProjectHistoryAdoptionRequest,
  type WorkbenchProjectHistoryAdoptionResult,
  type WorkbenchProjectHistoryDiscoveryResult,
  type WorkbenchProjectHistoryHideRequest,
  type WorkbenchProjectHistoryHideResult,
  type WorkbenchProjectHistoryOption,
  type WorkbenchProjectHistorySnapshot,
  type WorkbenchProjectSelectionRequest,
  type WorkbenchProjectSelectionResult,
  type WorkbenchProjectRemovalResult,
  type WorkbenchProjectView,
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchSessionContextUsage,
  type WorkbenchSessionProfileProjection,
  type WorkbenchSubmissionResult,
  type WorkbenchSubscriptionAuthenticationEffectResult,
  type WorkbenchSubscriptionAuthenticationBoundaryResult,
  type WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority,
  type WorkbenchSubscriptionAuthenticationPublicRequest,
  type WorkbenchSubscriptionAuthenticationPublicResponse,
  type WorkbenchSubscriptionAuthenticationRequest,
  type WorkbenchSubscriptionAuthenticationSnapshotResult,
  type WorkbenchTimelineEvent,
  type WorkbenchWorkIntensityOption,
} from "./contract.ts";

export type WorkbenchAppearancePreferenceReconstruction =
  | {
      readonly ok: true;
      readonly preference: WorkbenchAppearancePreference;
    }
  | { readonly ok: false };

export function reconstructWorkbenchAppearancePreference(
  value: unknown,
): WorkbenchAppearancePreferenceReconstruction {
  try {
    if (
      !isStrictDataRecord(value, [
        "crt",
        "language",
        "phosphor",
        "phosphorTier",
        "tone",
      ]) ||
      (value.tone !== "dark" && value.tone !== "light") ||
      (value.crt !== "off" &&
        value.crt !== "blocks" &&
        value.crt !== "screen" &&
        value.crt !== "full") ||
      (value.phosphor !== "neutral" &&
        value.phosphor !== "green" &&
        value.phosphor !== "amber") ||
      (value.phosphorTier !== "a" &&
        value.phosphorTier !== "b" &&
        value.phosphorTier !== "c") ||
      (value.language !== "en" && value.language !== "zh-CN")
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      preference: Object.freeze({
        tone: value.tone,
        crt: value.crt,
        phosphor: value.phosphor,
        phosphorTier: value.phosphorTier,
        language: value.language,
      }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function sanitizeWorkbenchAppearancePreferenceLoadResult(
  value: unknown,
): WorkbenchAppearancePreferenceLoadResult {
  try {
    if (
      isStrictDataRecord(value, ["appearance", "ok", "status"]) &&
      value.ok === true &&
      value.status === "loaded"
    ) {
      const reconstructed = reconstructWorkbenchAppearancePreference(
        value.appearance,
      );
      if (reconstructed.ok) {
        return publicAppearancePreferenceLoaded(reconstructed.preference);
      }
    }
    if (isAppearancePreferenceFailureResult(value)) {
      return publicAppearancePreferenceUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicAppearancePreferenceUnavailable();
}

export function sanitizeWorkbenchAppearancePreferenceSaveResult(
  value: unknown,
): WorkbenchAppearancePreferenceSaveResult {
  try {
    if (
      isStrictDataRecord(value, ["message", "ok", "status"]) &&
      value.ok === true &&
      value.status === "saved" &&
      value.message === "Appearance preference was durably saved."
    ) {
      return publicAppearancePreferenceSaved();
    }
    if (isAppearancePreferenceFailureResult(value)) {
      return publicAppearancePreferenceUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicAppearancePreferenceUnavailable();
}

function isAppearancePreferenceFailureResult(value: unknown): boolean {
  return (
    isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    value.error.category === "appearance-preference-unavailable" &&
    value.error.message ===
      "Appearance preferences could not be loaded or saved. Keep the current appearance and try again."
  );
}

export type WorkbenchClaudePermissionHandlingReconstruction =
  | {
      readonly ok: true;
      readonly permissionHandling: WorkbenchClaudePermissionHandling;
    }
  | { readonly ok: false };

export function reconstructWorkbenchClaudePermissionHandling(
  value: unknown,
): WorkbenchClaudePermissionHandlingReconstruction {
  return value === "without-asking" || value === "ask-when-needed"
    ? Object.freeze({ ok: true, permissionHandling: value })
    : Object.freeze({ ok: false });
}

export function sanitizeWorkbenchClaudePermissionHandlingLoadResult(
  value: unknown,
): WorkbenchClaudePermissionHandlingLoadResult {
  try {
    if (
      isStrictDataRecord(value, ["ok", "permissionHandling", "status"]) &&
      value.ok === true &&
      value.status === "loaded"
    ) {
      const reconstructed = reconstructWorkbenchClaudePermissionHandling(
        value.permissionHandling,
      );
      if (reconstructed.ok) {
        return publicClaudePermissionHandlingLoaded(
          reconstructed.permissionHandling,
        );
      }
    }
    if (isClaudePermissionHandlingFailureResult(value)) {
      return publicClaudePermissionHandlingUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicClaudePermissionHandlingUnavailable();
}

export function sanitizeWorkbenchClaudePermissionHandlingSaveResult(
  value: unknown,
): WorkbenchClaudePermissionHandlingSaveResult {
  try {
    if (
      isStrictDataRecord(value, ["message", "ok", "status"]) &&
      value.ok === true &&
      value.status === "saved" &&
      value.message === "Claude permission handling was durably saved."
    ) {
      return publicClaudePermissionHandlingSaved();
    }
    if (isClaudePermissionHandlingFailureResult(value)) {
      return publicClaudePermissionHandlingUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicClaudePermissionHandlingUnavailable();
}

function isClaudePermissionHandlingFailureResult(value: unknown): boolean {
  return (
    isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    value.error.category === "claude-permission-handling-unavailable" &&
    value.error.message ===
      "Claude permission handling could not be loaded or saved. Keep the current choice and try again."
  );
}

const runtimeExecutablePathControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

const runtimeExecutableRejections: ReadonlySet<string> = new Set([
  "not-absolute",
  "not-found",
  "not-a-file",
  "unsupported-shape",
  "no-install-beside-it",
  "no-node-interpreter",
  "unusable",
]);

export type WorkbenchRuntimeExecutableSaveRequestReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchRuntimeExecutableSaveRequest;
    }
  | { readonly ok: false };

/**
 * The renderer-to-main direction for the escape hatch. This is the one place a
 * path a user typed enters the product, so the shape is checked here and the
 * VALUE is checked at the point of use by `admitLaunchTarget`. Nothing here
 * tries to repair a path: a control character or an over-long string is refused,
 * not trimmed into something that looks plausible.
 */
export function reconstructWorkbenchRuntimeExecutableSaveRequest(
  value: unknown,
): WorkbenchRuntimeExecutableSaveRequestReconstruction {
  try {
    if (
      isStrictDataRecord(value, ["executablePath", "runtime"]) &&
      (value.runtime === "codex" || value.runtime === "claude") &&
      typeof value.executablePath === "string" &&
      value.executablePath.length <=
        WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH &&
      !runtimeExecutablePathControlCharacters.test(value.executablePath)
    ) {
      return Object.freeze({
        ok: true,
        request: Object.freeze({
          runtime: value.runtime,
          executablePath: value.executablePath,
        }),
      });
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return Object.freeze({ ok: false });
}

function reconstructRuntimeExecutablePaths(
  value: unknown,
): WorkbenchRuntimeExecutablePaths | undefined {
  if (
    !isStrictDataRecord(value, ["claude", "codex"]) ||
    typeof value.codex !== "string" ||
    typeof value.claude !== "string" ||
    value.codex.length > WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH ||
    value.claude.length > WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH ||
    runtimeExecutablePathControlCharacters.test(value.codex) ||
    runtimeExecutablePathControlCharacters.test(value.claude)
  ) {
    return undefined;
  }
  return Object.freeze({ codex: value.codex, claude: value.claude });
}

export function sanitizeWorkbenchRuntimeExecutablesLoadResult(
  value: unknown,
): WorkbenchRuntimeExecutablesLoadResult {
  try {
    if (
      isStrictDataRecord(value, ["executables", "ok", "status"]) &&
      value.ok === true &&
      value.status === "loaded"
    ) {
      const executables = reconstructRuntimeExecutablePaths(value.executables);
      if (executables !== undefined) {
        return publicRuntimeExecutablesLoaded(executables);
      }
    }
    if (isRuntimeExecutableUnavailableResult(value)) {
      return publicRuntimeExecutableUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicRuntimeExecutableUnavailable();
}

export function sanitizeWorkbenchRuntimeExecutableSaveResult(
  value: unknown,
): WorkbenchRuntimeExecutableSaveResult {
  try {
    if (
      isStrictDataRecord(value, ["executables", "ok", "status"]) &&
      value.ok === true &&
      value.status === "saved"
    ) {
      const executables = reconstructRuntimeExecutablePaths(value.executables);
      if (executables !== undefined) {
        return publicRuntimeExecutableSaved(executables);
      }
    }
    if (
      isStrictDataRecord(value, ["error", "ok"]) &&
      value.ok === false &&
      isStrictDataRecord(value.error, ["category", "message", "reason"]) &&
      value.error.category === "runtime-executable-rejected" &&
      value.error.message === "That path cannot be used to start this runtime." &&
      typeof value.error.reason === "string" &&
      runtimeExecutableRejections.has(value.error.reason)
    ) {
      return publicRuntimeExecutableRejected(
        value.error.reason as WorkbenchRuntimeExecutableRejection,
      );
    }
    if (isRuntimeExecutableUnavailableResult(value)) {
      return publicRuntimeExecutableUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicRuntimeExecutableUnavailable();
}

function isRuntimeExecutableUnavailableResult(value: unknown): boolean {
  return (
    isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    value.error.category === "runtime-executable-unavailable" &&
    value.error.message ===
      "The executable path could not be loaded or saved. Keep the current value and try again."
  );
}

export type WorkbenchSubscriptionAuthenticationRequestReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchSubscriptionAuthenticationRequest;
    }
  | { readonly ok: false };

export function reconstructSubscriptionAuthenticationRequest(
  value: unknown,
): WorkbenchSubscriptionAuthenticationRequestReconstruction {
  try {
    if (
      !isStrictDataRecord(value, ["endpointId"]) ||
      !isSubscriptionAuthenticationEndpointId(value.endpointId)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({ endpointId: value.endpointId }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function sanitizeSubscriptionAuthenticationPublicRequest(
  value: unknown,
  authority: WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority,
): WorkbenchSubscriptionAuthenticationBoundaryResult<WorkbenchSubscriptionAuthenticationPublicRequest> {
  try {
    if (
      isStrictDataRecord(value, ["endpointSelectionKey"]) &&
      typeof value.endpointSelectionKey === "string" &&
      authority.isEndpointSelectionKey(value.endpointSelectionKey)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({ endpointSelectionKey: value.endpointSelectionKey }),
      );
    }
    if (
      isStrictDataRecord(value, ["action", "endpointSelectionKey"]) &&
      typeof value.endpointSelectionKey === "string" &&
      authority.isEndpointSelectionKey(value.endpointSelectionKey) &&
      isSubscriptionAuthenticationAction(value.action)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({
          endpointSelectionKey: value.endpointSelectionKey,
          action: value.action,
        }),
      );
    }
    if (
      isStrictDataRecord(value, ["preparationKey"]) &&
      typeof value.preparationKey === "string" &&
      authority.isPreparationKey(value.preparationKey)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({ preparationKey: value.preparationKey }),
      );
    }
  } catch {
    // Accessors, Proxies, and failing key authorities remain outside the seam.
  }
  return Object.freeze({ accepted: false as const });
}

export function sanitizeSubscriptionAuthenticationPublicResponse(
  value: unknown,
  authority: WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority,
): WorkbenchSubscriptionAuthenticationBoundaryResult<WorkbenchSubscriptionAuthenticationPublicResponse> {
  try {
    if (
      isStrictDataRecord(value, ["kind", "state"]) &&
      value.kind === "authentication-state" &&
      isSubscriptionAuthenticationState(value.state)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({ kind: value.kind, state: value.state }),
      );
    }
    if (
      isStrictDataRecord(value, ["blockers", "kind"]) &&
      value.kind === "blocked" &&
      isStrictDataRecord(value.blockers, [
        "accepted",
        "inFlight",
        "recoveryRequired",
        "starting",
        "unknown",
      ]) &&
      isSafeCount(value.blockers.accepted) &&
      isSafeCount(value.blockers.starting) &&
      isSafeCount(value.blockers.inFlight) &&
      isSafeCount(value.blockers.recoveryRequired) &&
      isSafeCount(value.blockers.unknown)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({
          kind: value.kind,
          blockers: Object.freeze({
            accepted: value.blockers.accepted,
            starting: value.blockers.starting,
            inFlight: value.blockers.inFlight,
            recoveryRequired: value.blockers.recoveryRequired,
            unknown: value.blockers.unknown,
          }),
        }),
      );
    }
    if (
      isStrictDataRecord(value, [
        "consequences",
        "kind",
        "preparationKey",
      ]) &&
      value.kind === "confirmation-required" &&
      typeof value.preparationKey === "string" &&
      authority.isPreparationKey(value.preparationKey) &&
      isStrictDataRecord(value.consequences, [
        "projectCount",
        "resumableSessionCount",
      ]) &&
      isSafeCount(value.consequences.resumableSessionCount) &&
      isSafeCount(value.consequences.projectCount)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({
          kind: value.kind,
          preparationKey: value.preparationKey,
          consequences: Object.freeze({
            resumableSessionCount: value.consequences.resumableSessionCount,
            projectCount: value.consequences.projectCount,
          }),
        }),
      );
    }
    if (
      isStrictDataRecord(value, ["kind", "preparationKey"]) &&
      value.kind === "ready" &&
      typeof value.preparationKey === "string" &&
      authority.isPreparationKey(value.preparationKey)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({
          kind: value.kind,
          preparationKey: value.preparationKey,
        }),
      );
    }
    // Three outcome literals share one exact two-key shape. Admitting a third
    // literal narrows nothing away from the first two; widening the key set
    // would, so the admitted keys stay exactly `action` and `kind`.
    if (
      isStrictDataRecord(value, ["action", "kind"]) &&
      (value.kind === "authentication-action-requested" ||
        value.kind === "authentication-action-not-requested" ||
        value.kind === "authentication-action-partially-completed") &&
      isSubscriptionAuthenticationAction(value.action)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({ kind: value.kind, action: value.action }),
      );
    }
  } catch {
    // Accessors, Proxies, and failing key authorities remain outside the seam.
  }
  return Object.freeze({ accepted: false as const });
}

function acceptedSubscriptionAuthenticationBoundaryValue<Value>(
  value: Value,
): WorkbenchSubscriptionAuthenticationBoundaryResult<Value> {
  return Object.freeze({ accepted: true as const, value });
}

function isSubscriptionAuthenticationState(
  value: unknown,
): value is "bound" | "sign-in-required" | "unknown" {
  return (
    value === "bound" || value === "sign-in-required" || value === "unknown"
  );
}

function isSubscriptionAuthenticationAction(
  value: unknown,
): value is "login" | "logout" {
  return value === "login" || value === "logout";
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function sanitizeSubscriptionAuthenticationSnapshotResult(
  value: unknown,
): WorkbenchSubscriptionAuthenticationSnapshotResult {
  try {
    if (
      isStrictDataRecord(value, ["authentication", "endpointId", "ok"]) &&
      value.ok === true &&
      isSubscriptionAuthenticationEndpointId(value.endpointId) &&
      isSubscriptionAuthenticationStatus(value.authentication)
    ) {
      return publicSubscriptionAuthenticationSnapshot(
        value.endpointId,
        value.authentication,
      );
    }
    if (isSubscriptionAuthenticationFailureResult(value)) {
      return publicSubscriptionAuthenticationUnavailable();
    }
  } catch {
    // Proxy and accessor values remain outside the renderer contract.
  }
  return publicSubscriptionAuthenticationUnavailable();
}

export function sanitizeSubscriptionAuthenticationEffectResult(
  value: unknown,
): WorkbenchSubscriptionAuthenticationEffectResult {
  try {
    if (
      isStrictDataRecord(value, [
        "authentication",
        "effect",
        "endpointId",
        "ok",
      ]) &&
      value.ok === true &&
      isSubscriptionAuthenticationEndpointId(value.endpointId) &&
      isSubscriptionAuthenticationEffect(value.effect) &&
      isSubscriptionAuthenticationStatus(value.authentication)
    ) {
      return publicSubscriptionAuthenticationEffect(
        value.endpointId,
        value.effect,
        value.authentication,
      );
    }
    if (isSubscriptionAuthenticationFailureResult(value)) {
      return publicSubscriptionAuthenticationUnavailable();
    }
  } catch {
    // Proxy and accessor values remain outside the renderer contract.
  }
  return publicSubscriptionAuthenticationUnavailable();
}

function isSubscriptionAuthenticationFailureResult(value: unknown): boolean {
  return (
    isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    value.error.category === "subscription-authentication-unavailable" &&
    value.error.message ===
      "Subscription authentication is unavailable. Keep the current status and try again."
  );
}

function isSubscriptionAuthenticationEndpointId(
  value: unknown,
): value is WorkbenchRuntimeEndpointId {
  return value === "codex-desktop" || value === "claude-code-desktop";
}

function isSubscriptionAuthenticationStatus(
  value: unknown,
): value is "bound" | "unbound" | "authentication-required" | "unknown" {
  return (
    value === "bound" ||
    value === "unbound" ||
    value === "authentication-required" ||
    value === "unknown"
  );
}

function isSubscriptionAuthenticationEffect(
  value: unknown,
): value is
  | "pending"
  | "finished"
  | "cancelled"
  | "timed-out"
  | "launch-failed"
  | "shutdown-failed" {
  return (
    value === "pending" ||
    value === "finished" ||
    value === "cancelled" ||
    value === "timed-out" ||
    value === "launch-failed" ||
    value === "shutdown-failed"
  );
}

export function sanitizeWorkbenchCreateProjectResult(
  value: unknown,
): WorkbenchCreateProjectResult {
  try {
    if (!isRecord(value)) return publicCreateProjectResult("unavailable");
    const outcome = value.outcome;
    if (
      outcome === "created" ||
      outcome === "cancelled" ||
      outcome === "unavailable" ||
      outcome === "created-recovery-required"
    ) {
      return publicCreateProjectResult(outcome);
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicCreateProjectResult("unavailable");
}

const snapshotKeyPattern =
  /^snapshot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const endpointKeyPattern =
  /^endpoint-option:[1-9][0-9]{0,3}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const modelKeyPattern =
  /^model-option:[1-9][0-9]{0,3}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const intensityKeyPattern =
  /^intensity-option:[1-9][0-9]{0,3}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const executionModeKeyPattern =
  /^execution-option:[1-9][0-9]{0,3}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const accessModeKeyPattern =
  /^access-option:[1-9][0-9]{0,3}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sessionSelectionKeyPattern =
  /^session-selection:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sessionRemovalKeyPattern =
  /^session-removal:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sessionMetadataKeyPattern =
  /^session-metadata:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const interruptKeyPattern =
  /^turn-interrupt:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const steerKeyPattern =
  /^turn-steer:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const projectSelectionKeyPattern =
  /^project-selection:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const projectHistoryKeyPattern =
  /^project-history:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const commandSelectionKeyPattern = /^command-[1-9][0-9]*$/u;
/** UTC, second precision. A history inventory never carries a finer instant. */
const utcSecondPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const maximumProjectHistories = 100;

export type WorkbenchProjectSelectionReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchProjectSelectionRequest;
    }
  | { readonly ok: false };

export type WorkbenchInterruptReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchInterruptRequest;
    }
  | { readonly ok: false };

export function reconstructWorkbenchInterruptRequest(
  value: unknown,
): WorkbenchInterruptReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, ["interruptKey"]) ||
      typeof value.interruptKey !== "string" ||
      !interruptKeyPattern.test(value.interruptKey)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({ interruptKey: value.interruptKey }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function sanitizeWorkbenchInterruptResult(
  value: unknown,
): WorkbenchInterruptResult {
  try {
    if (
      isStrictDataRecord(value, ["message", "ok", "status"]) &&
      value.ok === true &&
      value.status === "requested" &&
      value.message === "Interrupt requested."
    ) {
      return publicInterruptRequested();
    }
    if (
      isStrictDataRecord(value, ["error", "ok"]) &&
      value.ok === false &&
      isStrictDataRecord(value.error, ["category", "message"])
    ) {
      if (
        value.error.category === "invalid-interrupt" &&
        value.error.message === "Reload the running Agent Session and try again."
      ) {
        return publicInvalidInterrupt();
      }
      if (
        value.error.category === "interrupt-unavailable" &&
        value.error.message === "Interrupt is unavailable for this turn."
      ) {
        return publicInterruptUnavailable();
      }
    }
  } catch {
    // Every malformed or private native result collapses to fixed public copy.
  }
  return publicInterruptUnavailable();
}

export type WorkbenchSteerReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchSteerRequest;
    }
  | { readonly ok: false };

export function reconstructWorkbenchSteerRequest(
  value: unknown,
): WorkbenchSteerReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, ["input", "steerKey"]) ||
      typeof value.steerKey !== "string" ||
      !steerKeyPattern.test(value.steerKey) ||
      typeof value.input !== "string" ||
      !isValidWorkbenchDirectInput(value.input)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        steerKey: value.steerKey,
        input: value.input,
      }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function sanitizeWorkbenchSteerResult(
  value: unknown,
): WorkbenchSteerResult {
  try {
    if (
      isStrictDataRecord(value, ["message", "ok", "status"]) &&
      value.ok === true &&
      value.status === "accepted" &&
      value.message === "Guidance was accepted into the running turn."
    ) {
      return publicSteerAccepted();
    }
    if (
      isStrictDataRecord(value, ["error", "ok"]) &&
      value.ok === false &&
      isStrictDataRecord(value.error, ["category", "message"])
    ) {
      if (
        value.error.category === "invalid-steer" &&
        value.error.message === "Reload the running Agent Session and try again."
      ) {
        return publicInvalidSteer();
      }
      if (
        value.error.category === "steer-unavailable" &&
        value.error.message === "Same-turn guidance is unavailable. Your draft was kept."
      ) {
        return publicSteerUnavailable();
      }
    }
  } catch {
    // Every malformed or private native result collapses to fixed public copy.
  }
  return publicSteerUnavailable();
}

export function reconstructWorkbenchProjectSelectionRequest(
  value: unknown,
): WorkbenchProjectSelectionReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, ["selectionKey"]) ||
      typeof value.selectionKey !== "string" ||
      !projectSelectionKeyPattern.test(value.selectionKey)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({ selectionKey: value.selectionKey }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export type WorkbenchSessionRemovalReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchSessionRemovalRequest;
    }
  | { readonly ok: false };

export function reconstructWorkbenchSessionRemovalRequest(
  value: unknown,
): WorkbenchSessionRemovalReconstruction {
  try {
    if (!hasStableCloneableDataGraph(value)) {
      return Object.freeze({ ok: false });
    }
    // Two exact shapes, never a subset test.
    if (isStrictDataRecord(value, ["removalKey"])) {
      if (
        typeof value.removalKey !== "string" ||
        !sessionRemovalKeyPattern.test(value.removalKey)
      ) {
        return Object.freeze({ ok: false });
      }
      return Object.freeze({
        ok: true,
        request: Object.freeze({ removalKey: value.removalKey }),
      });
    }
    // The acknowledgement key carries the single literal `true`; `false` and
    // every other value fail closed, so the capability has one spelling only.
    if (isStrictDataRecord(value, ["acknowledgedUnknownOutcome", "removalKey"])) {
      if (
        value.acknowledgedUnknownOutcome !== true ||
        typeof value.removalKey !== "string" ||
        !sessionRemovalKeyPattern.test(value.removalKey)
      ) {
        return Object.freeze({ ok: false });
      }
      return Object.freeze({
        ok: true,
        request: Object.freeze({
          removalKey: value.removalKey,
          acknowledgedUnknownOutcome: true as const,
        }),
      });
    }
    return Object.freeze({ ok: false });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function sanitizeWorkbenchSessionRemovalResult(
  value: unknown,
): WorkbenchSessionRemovalResult {
  try {
    if (
      isStrictDataRecord(value, ["status"]) &&
      (value.status === "removed" || value.status === "not-found")
    ) {
      return Object.freeze({ status: value.status });
    }
    if (
      isStrictDataRecord(value, ["activity", "status"]) &&
      value.status === "blocked" &&
      (value.activity === "accepted" ||
        value.activity === "in-flight" ||
        value.activity === "unknown")
    ) {
      return Object.freeze({ status: "blocked", activity: value.activity });
    }
  } catch {
    // Malformed native values remain one fixed public unavailable result.
  }
  return Object.freeze({ status: "unavailable" });
}

export type WorkbenchSessionMetadataMutationReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchSessionMetadataMutationRequest;
    }
  | { readonly ok: false };

export function reconstructWorkbenchSessionMetadataMutationRequest(
  value: unknown,
): WorkbenchSessionMetadataMutationReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, ["metadataKey", "operation"]) ||
      typeof value.metadataKey !== "string" ||
      !sessionMetadataKeyPattern.test(value.metadataKey) ||
      !isRecord(value.operation)
    ) {
      return Object.freeze({ ok: false });
    }
    if (value.operation.kind === "rename") {
      if (
        !isStrictDataRecord(value.operation, ["displayName", "kind"]) ||
        typeof value.operation.displayName !== "string"
      ) {
        return Object.freeze({ ok: false });
      }
      const displayName = normalizeSessionDisplayName(
        value.operation.displayName,
      );
      if (displayName === undefined) return Object.freeze({ ok: false });
      return Object.freeze({
        ok: true,
        request: Object.freeze({
          metadataKey: value.metadataKey,
          operation: Object.freeze({ kind: "rename" as const, displayName }),
        }),
      });
    }
    if (
      (value.operation.kind !== "archive" &&
        value.operation.kind !== "restore") ||
      !isStrictDataRecord(value.operation, ["kind"])
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        metadataKey: value.metadataKey,
        operation: Object.freeze({ kind: value.operation.kind }),
      }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function sanitizeWorkbenchSessionMetadataMutationResult(
  value: unknown,
): WorkbenchSessionMetadataMutationResult {
  try {
    if (!hasStableCloneableDataGraph(value)) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (
      isStrictDataRecord(value, ["status"]) &&
      (value.status === "renamed" ||
        value.status === "archived" ||
        value.status === "restored" ||
        value.status === "unchanged" ||
        value.status === "not-found" ||
        value.status === "invalid-name" ||
        value.status === "unavailable")
    ) {
      return Object.freeze({ status: value.status });
    }
    if (
      isStrictDataRecord(value, ["activity", "status"]) &&
      value.status === "blocked" &&
      (value.activity === "accepted" ||
        value.activity === "in-flight" ||
        value.activity === "unknown")
    ) {
      return Object.freeze({ status: "blocked", activity: value.activity });
    }
  } catch {
    // Malformed values remain one fixed public unavailable result.
  }
  return Object.freeze({ status: "unavailable" });
}

export function sanitizeWorkbenchProjectRemovalResult(
  value: unknown,
): WorkbenchProjectRemovalResult {
  try {
    if (
      isStrictDataRecord(value, ["status"]) &&
      (value.status === "removed" ||
        value.status === "invalid-selection" ||
        value.status === "unavailable")
    ) {
      return Object.freeze({ status: value.status });
    }
    if (
      isStrictDataRecord(value, ["activity", "status"]) &&
      value.status === "blocked" &&
      (value.activity === "accepted" ||
        value.activity === "in-flight" ||
        value.activity === "unknown")
    ) {
      return Object.freeze({ status: "blocked", activity: value.activity });
    }
  } catch {
    // Malformed native values remain one fixed public unavailable result.
  }
  return Object.freeze({ status: "unavailable" });
}

export type WorkbenchProjectHistoryAdoptionReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchProjectHistoryAdoptionRequest;
    }
  | { readonly ok: false };

/**
 * Admits the one exact adoption request shape: a snapshot-scoped history key
 * and nothing else. The key is a capability minted by the last discovery, so a
 * widened record, an accessor, a Proxy or any extra key fails closed here
 * rather than reaching the registry writer.
 */
export function reconstructWorkbenchProjectHistoryAdoptionRequest(
  value: unknown,
): WorkbenchProjectHistoryAdoptionReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, ["historyKey"]) ||
      typeof value.historyKey !== "string" ||
      !projectHistoryKeyPattern.test(value.historyKey)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({ historyKey: value.historyKey }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export type WorkbenchProjectHistoryHideReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchProjectHistoryHideRequest;
    }
  | { readonly ok: false };

/**
 * Hiding uses the same one-key capability shape as adoption, but remains a
 * separate boundary so neither operation can silently acquire the other's
 * result vocabulary or implementation.
 */
export function reconstructWorkbenchProjectHistoryHideRequest(
  value: unknown,
): WorkbenchProjectHistoryHideReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, ["historyKey"]) ||
      typeof value.historyKey !== "string" ||
      !projectHistoryKeyPattern.test(value.historyKey)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({ historyKey: value.historyKey }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

/**
 * Rebuilds the discovery snapshot key by key. Every admitted field is a count,
 * a size, a UTC second or a snapshot-scoped key: no path, no file name, no
 * Session name and no transcript text can cross this seam, because no key that
 * could carry one is admitted at all.
 */
export function sanitizeWorkbenchProjectHistoryDiscoveryResult(
  value: unknown,
): WorkbenchProjectHistoryDiscoveryResult {
  try {
    if (!hasStableCloneableDataGraph(value)) {
      return Object.freeze({ status: "unavailable" });
    }
    if (
      isStrictDataRecord(value, ["status"]) &&
      (value.status === "invalid-selection" || value.status === "unavailable")
    ) {
      return Object.freeze({ status: value.status });
    }
    if (
      !isStrictDataRecord(value, ["snapshot", "status"]) ||
      value.status !== "discovered"
    ) {
      return Object.freeze({ status: "unavailable" });
    }
    const snapshot = sanitizeWorkbenchProjectHistorySnapshot(
      value.snapshot,
      1,
      1,
    );
    if (snapshot === undefined) {
      return Object.freeze({ status: "unavailable" });
    }
    return deepFreeze({
      status: "discovered" as const,
      snapshot,
    });
  } catch {
    // Malformed native values remain one fixed public unavailable result.
  }
  return Object.freeze({ status: "unavailable" });
}

function sanitizeWorkbenchProjectHistorySnapshot(
  value: unknown,
  expectedCurrentCount: 0 | 1,
  minimumHistories: 1 | 2,
): WorkbenchProjectHistorySnapshot | undefined {
  if (
    !hasStableCloneableDataGraph(value) ||
    !isStrictDataRecord(value, ["histories", "projectLabel"]) ||
    typeof value.projectLabel !== "string" ||
    !isSafeProjectLabel(value.projectLabel) ||
    !isDenseDataArray(value.histories) ||
    value.histories.length < minimumHistories ||
    value.histories.length > maximumProjectHistories
  ) {
    return undefined;
  }
  const historyKeys = new Set<string>();
  let currentCount = 0;
  const histories = value.histories.map((candidate) => {
    if (
      !isStrictDataRecord(candidate, [
        "byteSize",
        "commandCount",
        "current",
        "historyKey",
        "lastModified",
        "schemaVersion",
        "sessionCount",
        "updateCount",
      ]) ||
      typeof candidate.historyKey !== "string" ||
      !projectHistoryKeyPattern.test(candidate.historyKey) ||
      historyKeys.has(candidate.historyKey) ||
      typeof candidate.current !== "boolean" ||
      !isSafeCount(candidate.sessionCount) ||
      !isSafeCount(candidate.commandCount) ||
      !isSafeCount(candidate.updateCount) ||
      !isSafeCount(candidate.byteSize) ||
      !isSafeCount(candidate.schemaVersion) ||
      typeof candidate.lastModified !== "string" ||
      !utcSecondPattern.test(candidate.lastModified)
    ) {
      throw new Error("invalid-project-history-option");
    }
    historyKeys.add(candidate.historyKey);
    if (candidate.current) currentCount += 1;
    return Object.freeze({
      historyKey: candidate.historyKey,
      current: candidate.current,
      sessionCount: candidate.sessionCount,
      commandCount: candidate.commandCount,
      updateCount: candidate.updateCount,
      byteSize: candidate.byteSize,
      lastModified: candidate.lastModified,
      schemaVersion: candidate.schemaVersion,
    }) as WorkbenchProjectHistoryOption;
  });
  // Registered discovery requires exactly one current row; pending registration
  // requires zero. Neither caller ever accepts a different count.
  if (currentCount !== expectedCurrentCount) return undefined;
  return deepFreeze({ projectLabel: value.projectLabel, histories });
}

export function sanitizeWorkbenchProjectHistoryAdoptionResult(
  value: unknown,
): WorkbenchProjectHistoryAdoptionResult {
  try {
    if (!hasStableCloneableDataGraph(value)) {
      return Object.freeze({ status: "unavailable" });
    }
    if (
      isStrictDataRecord(value, ["status"]) &&
      (value.status === "adopted" ||
        value.status === "invalid-selection" ||
        value.status === "unavailable")
    ) {
      return Object.freeze({ status: value.status });
    }
    if (
      isStrictDataRecord(value, ["activity", "status"]) &&
      value.status === "blocked" &&
      (value.activity === "accepted" ||
        value.activity === "in-flight" ||
        value.activity === "unknown")
    ) {
      return Object.freeze({ status: "blocked", activity: value.activity });
    }
  } catch {
    // Malformed native values remain one fixed public unavailable result.
  }
  return Object.freeze({ status: "unavailable" });
}

export function sanitizeWorkbenchProjectHistoryHideResult(
  value: unknown,
): WorkbenchProjectHistoryHideResult {
  try {
    if (
      hasStableCloneableDataGraph(value) &&
      isStrictDataRecord(value, ["status"]) &&
      (value.status === "hidden" ||
        value.status === "ineligible" ||
        value.status === "invalid-selection" ||
        value.status === "unavailable")
    ) {
      return Object.freeze({ status: value.status });
    }
  } catch {
    // Malformed native values remain one fixed public unavailable result.
  }
  return Object.freeze({ status: "unavailable" });
}

export type WorkbenchDirectInputReconstruction =
  | {
      readonly ok: true;
      readonly request:
        | WorkbenchStartDirectInputRequest
        | WorkbenchContinueDirectInputRequest;
    }
  | {
      readonly ok: false;
      readonly category:
        | "invalid-input"
        | "invalid-profile-selection"
        | "continuation-unavailable";
    };

export type WorkbenchDirectSessionProfileDefaultReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchDirectSessionProfileDefaultRequest;
    }
  | { readonly ok: false };

export type WorkbenchDirectSessionProfileLoadReconstruction =
  | {
      readonly ok: true;
      readonly request: WorkbenchDirectSessionProfileLoadRequest;
    }
  | { readonly ok: false };

export function reconstructWorkbenchDirectSessionProfileLoadRequest(
  value: unknown,
): WorkbenchDirectSessionProfileLoadReconstruction {
  try {
    if (!hasStableCloneableDataGraph(value)) {
      return Object.freeze({ ok: false });
    }
    if (
      isStrictDataRecord(value, ["kind"]) &&
      value.kind === "catalog-default"
    ) {
      return Object.freeze({
        ok: true,
        request: Object.freeze({ kind: "catalog-default" }),
      });
    }
    if (
      isStrictDataRecord(value, ["kind", "selectionKey"]) &&
      value.kind === "continuation-session" &&
      typeof value.selectionKey === "string" &&
      sessionSelectionKeyPattern.test(value.selectionKey)
    ) {
      return Object.freeze({
        ok: true,
        request: Object.freeze({
          kind: "continuation-session",
          selectionKey: value.selectionKey,
        }),
      });
    }
    if (
      !isStrictDataRecord(value, [
        "kind",
        "sourceSelectionKey",
        "sourceSnapshotCursor",
      ]) ||
      value.kind !== "replacement-session" ||
      typeof value.sourceSelectionKey !== "string" ||
      !commandSelectionKeyPattern.test(value.sourceSelectionKey) ||
      !Number.isSafeInteger(value.sourceSnapshotCursor) ||
      (value.sourceSnapshotCursor as number) < 0
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        kind: "replacement-session",
        sourceSelectionKey: value.sourceSelectionKey,
        sourceSnapshotCursor: value.sourceSnapshotCursor as number,
      }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function reconstructWorkbenchDirectSessionProfileDefaultRequest(
  value: unknown,
): WorkbenchDirectSessionProfileDefaultReconstruction {
  try {
    if (
      !hasStableCloneableDataGraph(value) ||
      !isStrictDataRecord(value, [
        "accessModeKey",
        "endpointKey",
        "executionModeKey",
        "modelKey",
        "snapshotKey",
        "workIntensityKey",
      ]) ||
      typeof value.snapshotKey !== "string" ||
      !snapshotKeyPattern.test(value.snapshotKey) ||
      typeof value.endpointKey !== "string" ||
      !endpointKeyPattern.test(value.endpointKey) ||
      typeof value.modelKey !== "string" ||
      !modelKeyPattern.test(value.modelKey) ||
      typeof value.workIntensityKey !== "string" ||
      !intensityKeyPattern.test(value.workIntensityKey) ||
      typeof value.executionModeKey !== "string" ||
      !executionModeKeyPattern.test(value.executionModeKey) ||
      typeof value.accessModeKey !== "string" ||
      !accessModeKeyPattern.test(value.accessModeKey)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        snapshotKey: value.snapshotKey,
        endpointKey: value.endpointKey,
        modelKey: value.modelKey,
        workIntensityKey: value.workIntensityKey,
        executionModeKey: value.executionModeKey,
        accessModeKey: value.accessModeKey,
      }),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function reconstructWorkbenchDirectInputRequest(
  value: unknown,
): WorkbenchDirectInputReconstruction {
  try {
    return reconstructDirectInputRequest(value);
  } catch {
    return Object.freeze({
      ok: false,
      category: "invalid-profile-selection",
    });
  }
}

function reconstructDirectInputRequest(
  value: unknown,
): WorkbenchDirectInputReconstruction {
  if (!hasStableCloneableDataGraph(value) || !isRecord(value)) {
    return Object.freeze({
      ok: false,
      category: "invalid-profile-selection",
    });
  }
  if (value.kind === "continue") {
    if (
      !isStrictDataRecord(value, [
        "accessModeKey",
        "endpointKey",
        "executionModeKey",
        "input",
        "kind",
        "modelKey",
        "selectionKey",
        "snapshotKey",
        "workIntensityKey",
      ]) ||
      typeof value.selectionKey !== "string" ||
      !sessionSelectionKeyPattern.test(value.selectionKey)
    ) {
      return Object.freeze({
        ok: false,
        category: "continuation-unavailable",
      });
    }
    if (!isValidWorkbenchDirectInput(value.input)) {
      return Object.freeze({ ok: false, category: "invalid-input" });
    }
    if (
      typeof value.snapshotKey !== "string" ||
      !snapshotKeyPattern.test(value.snapshotKey) ||
      typeof value.endpointKey !== "string" ||
      !endpointKeyPattern.test(value.endpointKey) ||
      typeof value.modelKey !== "string" ||
      !modelKeyPattern.test(value.modelKey) ||
      typeof value.workIntensityKey !== "string" ||
      !intensityKeyPattern.test(value.workIntensityKey) ||
      typeof value.executionModeKey !== "string" ||
      !executionModeKeyPattern.test(value.executionModeKey) ||
      typeof value.accessModeKey !== "string" ||
      !accessModeKeyPattern.test(value.accessModeKey)
    ) {
      return Object.freeze({
        ok: false,
        category: "invalid-profile-selection",
      });
    }
    return Object.freeze({
      ok: true,
      request: Object.freeze({
        kind: "continue" as const,
        input: value.input,
        selectionKey: value.selectionKey,
        snapshotKey: value.snapshotKey,
        endpointKey: value.endpointKey,
        modelKey: value.modelKey,
        workIntensityKey: value.workIntensityKey,
        executionModeKey: value.executionModeKey,
        accessModeKey: value.accessModeKey,
      }),
    });
  }
  if (
    value.kind !== "start" ||
    !isStrictDataRecord(value, [
      "accessModeKey",
      "endpointKey",
      "executionModeKey",
      "input",
      "kind",
      "modelKey",
      "snapshotKey",
      "workIntensityKey",
    ])
  ) {
    return Object.freeze({
      ok: false,
      category: "invalid-profile-selection",
    });
  }
  if (!isValidWorkbenchDirectInput(value.input)) {
    return Object.freeze({ ok: false, category: "invalid-input" });
  }
  if (
    typeof value.snapshotKey !== "string" ||
    !snapshotKeyPattern.test(value.snapshotKey) ||
    typeof value.endpointKey !== "string" ||
    !endpointKeyPattern.test(value.endpointKey) ||
    typeof value.modelKey !== "string" ||
    !modelKeyPattern.test(value.modelKey) ||
    typeof value.workIntensityKey !== "string" ||
    !intensityKeyPattern.test(value.workIntensityKey) ||
    typeof value.executionModeKey !== "string" ||
    !executionModeKeyPattern.test(value.executionModeKey) ||
    typeof value.accessModeKey !== "string" ||
    !accessModeKeyPattern.test(value.accessModeKey)
  ) {
    return Object.freeze({
      ok: false,
      category: "invalid-profile-selection",
    });
  }
  return Object.freeze({
    ok: true,
    request: Object.freeze({
      kind: "start" as const,
      input: value.input,
      snapshotKey: value.snapshotKey,
      endpointKey: value.endpointKey,
      modelKey: value.modelKey,
      workIntensityKey: value.workIntensityKey,
      executionModeKey: value.executionModeKey,
      accessModeKey: value.accessModeKey,
    }),
  });
}

const statuses: readonly ProjectCommandStatus[] = [
  "accepted",
  "in-flight",
  "completed",
  "failed",
  "recovery-required",
];
const commandFailureCategories: readonly ProjectCommandFailureCategory[] = [
  "interrupted",
  "profile-resolution-failed",
  "runtime-failed",
];
export function sanitizeWorkbenchProjectResult(
  value: unknown,
): WorkbenchProjectResult {
  if (
    !isRecord(value) ||
    typeof value.ok !== "boolean" ||
    (value.ok
      ? !isStrictDataRecord(value, ["ok", "view"])
      : !isStrictDataRecord(value, ["error", "ok"]))
  ) {
    return publicProjectFailure();
  }
  if (!value.ok) return publicProjectFailure();
  try {
    return deepFreeze({ ok: true, view: sanitizeView(value.view) });
  } catch {
    return publicProjectFailure();
  }
}

export function sanitizeWorkbenchHostedProjectResult(
  value: unknown,
): WorkbenchHostedProjectResult {
  if (
    !isStrictDataRecord(value, ["ok", "view"]) ||
    value.ok !== true
  ) {
    return publicHostedProjectFailure();
  }
  try {
    return deepFreeze({ ok: true, view: sanitizeHostedView(value.view) });
  } catch {
    return publicHostedProjectFailure();
  }
}

export function sanitizeWorkbenchProjectSelectionResult(
  value: unknown,
): WorkbenchProjectSelectionResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return publicProjectSwitchUnavailable();
  }
  if (
    value.ok === true &&
    value.status === "selected" &&
    value.message === "Project was opened."
  ) {
    return publicProjectSelected();
  }
  if (
    value.ok === true &&
    value.status === "selected" &&
    value.message ===
      "Project was opened with its existing conversation history."
  ) {
    return publicProjectSelectedWithExistingHistory();
  }
  if (
    value.ok === true &&
    value.status === "history-selection-required" &&
    value.message ===
      "Choose which existing conversation history this Project should show. Nothing changed yet."
  ) {
    try {
      const snapshot = sanitizeWorkbenchProjectHistorySnapshot(
        value.snapshot,
        0,
        2,
      );
      if (snapshot !== undefined) {
        return publicProjectHistorySelectionRequired(snapshot);
      }
    } catch {
      // Dynamic history snapshots fail closed to the fixed unavailable result.
    }
  }
  if (!value.ok && isRecord(value.error)) {
    if (
      value.error.category === "invalid-project-selection" &&
      value.error.message ===
        "Reload the Project list and choose an available Project."
    ) {
      return publicInvalidProjectSelection();
    }
    if (
      value.error.category === "project-unavailable" &&
      value.error.message ===
        "This Project is unavailable. Choose another Project or restore its directory."
    ) {
      return publicProjectUnavailable();
    }
    if (
      value.error.category === "project-switch-unavailable" &&
      value.error.message ===
        "The Project could not be opened. Keep the current Project and try again."
    ) {
      return publicProjectSwitchUnavailable();
    }
  }
  return publicProjectSwitchUnavailable();
}

export function sanitizeWorkbenchOpenProjectResult(
  value: unknown,
): WorkbenchOpenProjectResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return publicProjectOpenUnavailable();
  }
  if (
    value.ok === true &&
    value.status === "opened" &&
    value.message === "Project was opened."
  ) {
    return publicProjectOpened();
  }
  if (
    value.ok === true &&
    value.status === "opened" &&
    value.message ===
      "Project was opened with its existing conversation history."
  ) {
    return publicProjectOpenedWithExistingHistory();
  }
  if (
    value.ok === true &&
    value.status === "history-selection-required" &&
    value.message ===
      "Choose which existing conversation history this Project should show. Nothing changed yet."
  ) {
    try {
      const snapshot = sanitizeWorkbenchProjectHistorySnapshot(
        value.snapshot,
        0,
        2,
      );
      if (snapshot !== undefined) {
        return publicOpenProjectHistorySelectionRequired(snapshot);
      }
    } catch {
      // Dynamic history snapshots fail closed to the fixed unavailable result.
    }
  }
  if (
    value.ok === true &&
    value.status === "cancelled" &&
    value.message === "Open Project was cancelled. Nothing changed."
  ) {
    return publicProjectOpenCancelled();
  }
  if (
    value.ok === false &&
    isRecord(value.error) &&
    value.error.category === "project-open-unavailable" &&
    value.error.message ===
      "Open Project could not be completed. Keep the current Project and try again."
  ) {
    return publicProjectOpenUnavailable();
  }
  return publicProjectOpenUnavailable();
}

export function sanitizeWorkbenchSubmissionResult(
  value: unknown,
): WorkbenchSubmissionResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return publicUnavailableSubmission();
  }
  if (
    value.ok === true &&
    value.status === "accepted" &&
    value.message === "Direct input was durably accepted."
  ) {
    return publicSubmissionAccepted();
  }
  if (!value.ok && isRecord(value.error)) {
    if (
      value.error.category === "invalid-input" &&
      value.error.message ===
        "Enter a non-empty instruction of at most 8,000 characters."
    ) {
      return publicInvalidSubmission();
    }
    if (
      value.error.category === "invalid-profile-selection" &&
      value.error.message ===
        "Reload Codex Session Profile options and choose a model and Work Intensity."
    ) {
      return publicInvalidProfileSelection();
    }
    if (
      value.error.category === "submission-unavailable" &&
      value.error.message ===
        "Starting an Agent Session on this Runtime is not yet supported. Keep your draft and choose another endpoint."
    ) {
      return publicRuntimeStartUnsupported();
    }
    if (
      value.error.category === "submission-unavailable" &&
      value.error.message ===
        "Direct input could not be durably accepted. Keep your draft and try again."
    ) {
      return publicUnavailableSubmission();
    }
    if (
      value.error.category === "continuation-unavailable" &&
      value.error.message ===
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session."
    ) {
      return publicContinuationUnavailable();
    }
  }
  return publicUnavailableSubmission();
}

export function sanitizeWorkbenchDirectSessionProfileDefaultResult(
  value: unknown,
): WorkbenchDirectSessionProfileDefaultResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return publicPreferenceUnavailable();
  }
  if (
    value.ok === true &&
    value.status === "saved" &&
    value.message === "Codex Session Profile default was durably saved."
  ) {
    return publicProfileDefaultSaved();
  }
  if (!value.ok && isRecord(value.error)) {
    if (
      value.error.category === "invalid-profile-selection" &&
      value.error.message ===
        "Reload Codex Session Profile options and choose a model and Work Intensity."
    ) {
      return publicInvalidProfileDefaultSelection();
    }
    if (
      value.error.category === "preference-unavailable" &&
      value.error.message ===
        "Codex Session Profile default could not be durably saved. Keep your selection and try again."
    ) {
      return publicPreferenceUnavailable();
    }
  }
  return publicPreferenceUnavailable();
}

export function sanitizeWorkbenchDirectSessionProfileResult(
  value: unknown,
): WorkbenchCatalogDefaultPublicProfileResult;
export function sanitizeWorkbenchDirectSessionProfileResult<
  Request extends WorkbenchDirectSessionProfileLoadRequest,
>(
  value: unknown,
  expectedRequest: Request,
): WorkbenchPublicDirectSessionProfileResultFor<Request>;
export function sanitizeWorkbenchDirectSessionProfileResult(
  value: unknown,
  expectedRequest: WorkbenchDirectSessionProfileLoadRequest = Object.freeze({
    kind: "catalog-default",
  }),
): WorkbenchAnyPublicDirectSessionProfileResult {
  try {
    const reconstructedRequest =
      reconstructWorkbenchDirectSessionProfileLoadRequest(expectedRequest);
    if (!reconstructedRequest.ok || !hasStableCloneableDataGraph(value)) {
      return publicProfileUnavailable();
    }
    return sanitizeWorkbenchDirectSessionProfileResultUnchecked(
      value,
      reconstructedRequest.request,
    );
  } catch {
    return publicProfileUnavailable();
  }
}

function sanitizeWorkbenchDirectSessionProfileResultUnchecked(
  value: unknown,
  expectedRequest: WorkbenchDirectSessionProfileLoadRequest,
): WorkbenchAnyPublicDirectSessionProfileResult {
  if (
    isStrictDataRecord(value, ["endpointDiscovery", "ok", "profile"]) &&
    value.ok === true
  ) {
    const endpointDiscovery = sanitizeEndpointDiscovery(
      value.endpointDiscovery,
    );
    const readyEndpointIds = endpointDiscovery.statuses
      .filter((status) => status.category === "catalog-ready")
      .map((status) => status.endpointId);
    if (readyEndpointIds.length === 0) {
      throw new Error("incoherent-direct-profile-success");
    }
    const profile = sanitizeDirectProfile(value.profile, expectedRequest);
    if (
      (expectedRequest.kind === "continuation-session"
        ? profile.endpoints.length !== 1 ||
          !readyEndpointIds.includes(profile.endpoints[0]!.endpointId)
        : profile.endpoints.length !== readyEndpointIds.length) ||
      profile.endpoints.some(
        (endpoint, index) =>
          expectedRequest.kind !== "continuation-session" &&
          endpoint.endpointId !== readyEndpointIds[index],
      )
    ) {
      throw new Error("incoherent-direct-profile-discovery");
    }
    return deepFreeze({
      ok: true,
      endpointDiscovery,
      profile,
    }) as WorkbenchAnyPublicDirectSessionProfileResult;
  }
  if (
    !isStrictDataRecord(value, ["endpointDiscovery", "error", "ok"]) ||
    value.ok !== false ||
    !isStrictDataRecord(value.error, ["category", "message"])
  ) {
    throw new Error("invalid-direct-profile-result");
  }
  const endpointDiscovery = sanitizeEndpointDiscovery(value.endpointDiscovery);
  if (
    expectedRequest.kind === "continuation-session" &&
    value.error.category === "continuation-unavailable" &&
    value.error.message ===
      "This Agent Session cannot be continued. Keep your draft and choose a resumable Session."
  ) {
    return publicContinuationProfileUnavailable(endpointDiscovery);
  }
  /* F214. Admitted deliberately under rule 1 (F26/F34): the exact category+message
     pair for the orphaned-model continuation. Returns early — like
     continuation-unavailable — because a catalog-ready endpoint is COHERENT for
     this failure (the provider was located; only the recorded model is gone). Any
     other message on this category, or this category on a non-continuation
     request, falls through and fails closed below. */
  if (
    expectedRequest.kind === "continuation-session" &&
    value.error.category === "continuation-model-unavailable" &&
    value.error.message ===
      "This Session's recorded model is no longer offered by its provider, so the next turn can't be prepared. The Session and its transcript are kept; start a New Agent Session to carry the work on."
  ) {
    return publicContinuationModelUnavailable(endpointDiscovery);
  }
  if (
    endpointDiscovery.statuses.some(
      (status) => status.category === "catalog-ready",
    )
  ) {
    throw new Error("incoherent-direct-profile-failure");
  }
  const bothNotLocated = endpointDiscovery.statuses.every(
    (status) => status.category === "runtime-not-located",
  );
  if (
    value.error.category === "runtime-not-located" &&
    value.error.message ===
      "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status." &&
    bothNotLocated
  ) {
    return publicRuntimeNotLocated(endpointDiscovery);
  }
  if (
    value.error.category === "profile-unavailable" &&
    value.error.message ===
      "Codex Session Profile options are unavailable. Keep your draft and try again." &&
    !bothNotLocated
  ) {
    return publicProfileUnavailable(endpointDiscovery);
  }
  throw new Error("incoherent-direct-profile-error");
}

function sanitizeEndpointDiscovery(
  value: unknown,
): WorkbenchRuntimeEndpointDiscovery {
  if (
    !isStrictDataRecord(value, ["statuses"]) ||
    !isDenseDataArray(value.statuses) ||
    value.statuses.length !== 2
  ) {
    throw new Error("invalid-endpoint-discovery");
  }
  const codex = value.statuses[0];
  const claude = value.statuses[1];
  if (
    !isStrictDataRecord(codex, ["category", "endpointId"]) ||
    codex.endpointId !== "codex-desktop" ||
    !isDiscoveryCategory(codex.category) ||
    !isStrictDataRecord(claude, ["category", "endpointId"]) ||
    claude.endpointId !== "claude-code-desktop" ||
    !isClaudeDiscoveryCategory(claude.category)
  ) {
    throw new Error("invalid-endpoint-discovery-status");
  }
  return publicRuntimeEndpointDiscovery(codex.category, claude.category);
}

function isDiscoveryCategory(
  value: unknown,
): value is WorkbenchRuntimeEndpointDiscoveryCategory {
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
): value is WorkbenchRuntimeEndpointDiscoveryCategory {
  return isDiscoveryCategory(value);
}

function isRuntimeEndpointId(
  value: unknown,
): value is WorkbenchRuntimeEndpointId {
  return value === "codex-desktop" || value === "claude-code-desktop";
}

function sanitizeDirectProfile(
  value: unknown,
  expectedRequest: WorkbenchDirectSessionProfileLoadRequest,
): WorkbenchLoadedDirectSessionProfile {
  if (
    !hasExactDirectProfileKeys(value, expectedRequest.kind) ||
    typeof value.snapshotKey !== "string" ||
    !snapshotKeyPattern.test(value.snapshotKey) ||
    !isDenseDataArray(value.endpoints) ||
    value.endpoints.length === 0 ||
    value.endpoints.length > 2 ||
    (expectedRequest.kind === "continuation-session" &&
      value.endpoints.length !== 1)
  ) {
    throw new Error("invalid-direct-profile");
  }
  const endpointKeys = new Set<string>();
  const endpointIds = new Set<WorkbenchRuntimeEndpointId>();
  const intensityKeys = new Set<string>();
  const modelKeys = new Set<string>();
  const executionModeKeys = new Set<string>();
  const accessModeKeys = new Set<string>();
  let previousEndpointOrdinal = -1;
  const endpoints = value.endpoints.map((endpoint) => {
    if (
      !isStrictDataRecord(endpoint, [
        "accessModes",
        "endpointId",
        "endpointLabel",
        "executionModes",
        "key",
        "models",
        "runtimeFamilyLabel",
      ]) ||
      !isRuntimeEndpointId(endpoint.endpointId) ||
      endpointIds.has(endpoint.endpointId) ||
      typeof endpoint.key !== "string" ||
      !endpointKeyPattern.test(endpoint.key) ||
      endpointKeys.has(endpoint.key) ||
      !isSafePublicDisplayText(endpoint.runtimeFamilyLabel, 160) ||
      !isSafePublicDisplayText(endpoint.endpointLabel, 160) ||
      !isDenseDataArray(endpoint.models) ||
      endpoint.models.length === 0 ||
      endpoint.models.length > 1_000
    ) {
      throw new Error("invalid-endpoint-option");
    }
    const endpointOrdinal = endpoint.endpointId === "codex-desktop" ? 0 : 1;
    if (endpointOrdinal <= previousEndpointOrdinal) {
      throw new Error("invalid-endpoint-order");
    }
    previousEndpointOrdinal = endpointOrdinal;
    endpointIds.add(endpoint.endpointId);
    endpointKeys.add(endpoint.key);
    const executionModes = sanitizeProfileOptions(
      endpoint.executionModes,
      executionModeKeyPattern,
      executionModeKeys,
      160,
      "invalid-execution-option",
    );
    const endpointExecutionModeKeys = new Set(
      executionModes.map((option) => option.key),
    );
    const models = endpoint.models.map((candidate) => {
      if (
        !isStrictDataRecord(candidate, [
          "key",
          "label",
          "provenanceLabel",
          "workIntensities",
          "workIntensityLabel",
        ]) ||
        typeof candidate.key !== "string" ||
        !modelKeyPattern.test(candidate.key) ||
        !isSafePublicDisplayText(candidate.label, 160) ||
        (candidate.provenanceLabel !== null &&
          !isSafePublicDisplayText(candidate.provenanceLabel, 200)) ||
        (candidate.workIntensityLabel !== null &&
          !isSafePublicDisplayText(candidate.workIntensityLabel, 160)) ||
        !isDenseDataArray(candidate.workIntensities) ||
        candidate.workIntensities.length === 0 ||
        candidate.workIntensities.length > 1_000 ||
        modelKeys.has(candidate.key)
      ) {
        throw new Error("invalid-model-option");
      }
      modelKeys.add(candidate.key);
      const workIntensities = sanitizeWorkIntensityOptions(
        candidate.workIntensities,
        intensityKeys,
        endpointExecutionModeKeys,
      );
      return Object.freeze({
        key: candidate.key,
        label: candidate.label,
        provenanceLabel: candidate.provenanceLabel,
        workIntensityLabel: candidate.workIntensityLabel,
        workIntensities,
      });
    });
    const accessModes = sanitizeProfileOptions(
      endpoint.accessModes,
      accessModeKeyPattern,
      accessModeKeys,
      160,
      "invalid-access-option",
    );
    return Object.freeze({
      endpointId: endpoint.endpointId,
      key: endpoint.key,
      runtimeFamilyLabel: endpoint.runtimeFamilyLabel,
      endpointLabel: endpoint.endpointLabel,
      models: Object.freeze(models),
      executionModes,
      accessModes,
    });
  });
  if (expectedRequest.kind === "replacement-session") {
    const replacementPrefill = sanitizeReplacementPrefill(
      value.replacementPrefill,
      endpoints,
    );
    return deepFreeze({
      snapshotKey: value.snapshotKey,
      endpoints,
      replacementPrefill,
    });
  }
  if (expectedRequest.kind === "continuation-session") {
    const continuationPrefill = sanitizeContinuationPrefill(
      value.continuationPrefill,
      endpoints,
    );
    const continuationEndpoint = endpoints[0];
    if (continuationEndpoint === undefined) {
      throw new Error("invalid-continuation-endpoint");
    }
    return deepFreeze({
      snapshotKey: value.snapshotKey,
      endpoints: [continuationEndpoint] as const,
      continuationPrefill,
    });
  }
  const desiredDefaultValue = value.desiredDefault;
  if (
    !isStrictDataRecordWithAllowedKeys(desiredDefaultValue, [
      "accessModeKey",
      "endpointKey",
      "executionModeKey",
      "kind",
      "modelKey",
      "workIntensityKey",
    ]) ||
    typeof desiredDefaultValue.kind !== "string"
  ) {
    throw new Error("invalid-desired-default");
  }
  let desiredDefault: WorkbenchDirectSessionProfile["desiredDefault"];
  if (
    desiredDefaultValue.kind === "unavailable" &&
    isStrictDataRecord(desiredDefaultValue, ["kind"])
  ) {
    desiredDefault = Object.freeze({ kind: "unavailable" });
  } else if (
    desiredDefaultValue.kind === "resolved" &&
    isStrictDataRecord(desiredDefaultValue, [
      "accessModeKey",
      "endpointKey",
      "executionModeKey",
      "kind",
      "modelKey",
      "workIntensityKey",
    ]) &&
    typeof desiredDefaultValue.endpointKey === "string" &&
    typeof desiredDefaultValue.modelKey === "string" &&
    typeof desiredDefaultValue.workIntensityKey === "string" &&
    typeof desiredDefaultValue.executionModeKey === "string" &&
    typeof desiredDefaultValue.accessModeKey === "string"
  ) {
    if (!isCoherentProfileSelection(desiredDefaultValue, endpoints)) {
      throw new Error("invalid-desired-default");
    }
    desiredDefault = Object.freeze({
      kind: "resolved",
      endpointKey: desiredDefaultValue.endpointKey,
      modelKey: desiredDefaultValue.modelKey,
      workIntensityKey: desiredDefaultValue.workIntensityKey,
      executionModeKey: desiredDefaultValue.executionModeKey,
      accessModeKey: desiredDefaultValue.accessModeKey,
    });
  } else {
    throw new Error("invalid-desired-default");
  }
  return deepFreeze({
    snapshotKey: value.snapshotKey,
    endpoints,
    desiredDefault,
  });
}

function sanitizeReplacementPrefill(
  value: unknown,
  endpoints: readonly WorkbenchRuntimeEndpointOption[],
): WorkbenchReplacementPrefill {
  if (
    !isStrictDataRecordWithAllowedKeys(value, [
      "accessModeKey",
      "endpointKey",
      "executionModeKey",
      "kind",
      "modelKey",
      "workIntensityKey",
    ]) ||
    typeof value.kind !== "string"
  ) {
    throw new Error("invalid-replacement-prefill");
  }
  if (
    value.kind === "manual-selection-required" &&
    isStrictDataRecord(value, ["kind"])
  ) {
    return Object.freeze({ kind: "manual-selection-required" });
  }
  if (
    value.kind !== "resolved" ||
    !isStrictDataRecord(value, [
      "accessModeKey",
      "endpointKey",
      "executionModeKey",
      "kind",
      "modelKey",
      "workIntensityKey",
    ]) ||
    typeof value.endpointKey !== "string" ||
    typeof value.modelKey !== "string" ||
    typeof value.workIntensityKey !== "string" ||
    typeof value.executionModeKey !== "string" ||
    typeof value.accessModeKey !== "string" ||
    !isCoherentProfileSelection(value, endpoints)
  ) {
    throw new Error("invalid-replacement-prefill");
  }
  return Object.freeze({
    kind: "resolved",
    endpointKey: value.endpointKey,
    modelKey: value.modelKey,
    workIntensityKey: value.workIntensityKey,
    executionModeKey: value.executionModeKey,
    accessModeKey: value.accessModeKey,
  });
}

function sanitizeContinuationPrefill(
  value: unknown,
  endpoints: readonly WorkbenchRuntimeEndpointOption[],
): WorkbenchContinuationPrefill {
  if (
    !isStrictDataRecord(value, [
      "accessModeKey",
      "endpointKey",
      "executionModeKey",
      "kind",
      "modelKey",
      "workIntensityKey",
    ]) ||
    value.kind !== "resolved" ||
    typeof value.endpointKey !== "string" ||
    typeof value.modelKey !== "string" ||
    typeof value.workIntensityKey !== "string" ||
    typeof value.executionModeKey !== "string" ||
    typeof value.accessModeKey !== "string" ||
    !isCoherentProfileSelection(value, endpoints)
  ) {
    throw new Error("invalid-continuation-prefill");
  }
  return Object.freeze({
    kind: "resolved",
    endpointKey: value.endpointKey,
    modelKey: value.modelKey,
    workIntensityKey: value.workIntensityKey,
    executionModeKey: value.executionModeKey,
    accessModeKey: value.accessModeKey,
  });
}

function isCoherentProfileSelection(
  value: Readonly<Record<string, unknown>>,
  endpoints: readonly WorkbenchRuntimeEndpointOption[],
): boolean {
  const endpoint = endpoints.find(
    (candidate) => candidate.key === value.endpointKey,
  );
  const model = endpoint?.models.find(
    (candidate) => candidate.key === value.modelKey,
  );
  const workIntensity = model?.workIntensities.find(
    (option) => option.key === value.workIntensityKey,
  );
  return (
    endpoint !== undefined &&
    model !== undefined &&
    workIntensity !== undefined &&
    endpoint.executionModes.some(
      (option) => option.key === value.executionModeKey,
    ) &&
    (workIntensity.impliedExecutionModeKey === undefined ||
      workIntensity.impliedExecutionModeKey === value.executionModeKey) &&
    endpoint.accessModes.some((option) => option.key === value.accessModeKey)
  );
}

function sanitizeWorkIntensityOptions(
  value: unknown,
  keys: Set<string>,
  endpointExecutionModeKeys: ReadonlySet<string>,
): readonly WorkbenchWorkIntensityOption[] {
  if (!isDenseDataArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error("invalid-intensity-option");
  }
  return Object.freeze(
    value.map((option) => {
      if (!isStrictDataRecordWithAllowedKeys(option, [
        "impliedExecutionModeKey",
        "key",
        "label",
      ])) {
        throw new Error("invalid-intensity-option");
      }
      const hasImplication = isStrictDataRecord(option, [
        "impliedExecutionModeKey",
        "key",
        "label",
      ]);
      if (
        (!hasImplication && !isStrictDataRecord(option, ["key", "label"])) ||
        typeof option.key !== "string" ||
        !intensityKeyPattern.test(option.key) ||
        keys.has(option.key) ||
        !isSafePublicDisplayText(option.label, 240) ||
        (hasImplication &&
          (typeof option.impliedExecutionModeKey !== "string" ||
            !executionModeKeyPattern.test(option.impliedExecutionModeKey) ||
            !endpointExecutionModeKeys.has(option.impliedExecutionModeKey)))
      ) {
        throw new Error("invalid-intensity-option");
      }
      keys.add(option.key);
      return Object.freeze({
        key: option.key,
        label: option.label,
        ...(hasImplication
          ? { impliedExecutionModeKey: option.impliedExecutionModeKey as string }
          : {}),
      });
    }),
  );
}

function sanitizeProfileOptions(
  value: unknown,
  keyPattern: RegExp,
  keys: Set<string>,
  maximumLabelLength: number,
  error: string,
): readonly { readonly key: string; readonly label: string }[] {
  if (!isDenseDataArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error(error);
  }
  return Object.freeze(
    value.map((option) => {
      if (
        !isStrictDataRecord(option, ["key", "label"]) ||
        typeof option.key !== "string" ||
        !keyPattern.test(option.key) ||
        keys.has(option.key) ||
        !isSafePublicDisplayText(option.label, maximumLabelLength)
      ) {
        throw new Error(error);
      }
      keys.add(option.key);
      return Object.freeze({ key: option.key, label: option.label });
    }),
  );
}

function sanitizeView(
  value: unknown,
  hosted = false,
): WorkbenchProjectView {
  const expectedViewKeys = [
    "commands",
    "initialSelectionKey",
    "observation",
    "project",
    ...(hosted ? ["projectSelection"] : []),
  ];
  if (
    !isStrictDataRecord(value, expectedViewKeys) ||
    !isStrictDataRecord(value.project, ["label"]) ||
    !isStrictDataRecord(value.observation, ["cursor", "live"]) ||
    !Array.isArray(value.commands)
  ) {
    throw new Error("invalid-view");
  }
  const projectLabel = requireString(value.project.label);
  if (!isSafeProjectLabel(projectLabel)) {
    throw new Error("invalid-project-label");
  }
  const cursor = requireCursor(value.observation.cursor);
  if (value.observation.live !== true) throw new Error("invalid-observation");
  const commands = value.commands.map(sanitizeCommand);
  const commandKeys = new Set(commands.map((command) => command.key));
  if (commandKeys.size !== commands.length) throw new Error("duplicate-command");
  const removalKeys = commands.flatMap((command) =>
    command.session === undefined ? [] : [command.session.removalKey],
  );
  if (new Set(removalKeys).size !== removalKeys.length) {
    throw new Error("duplicate-session-removal");
  }
  const metadataKeys = commands.flatMap((command) =>
    command.session === undefined ? [] : [command.session.metadataKey],
  );
  if (new Set(metadataKeys).size !== metadataKeys.length) {
    throw new Error("duplicate-session-metadata");
  }
  const initialSelectionKey =
    value.initialSelectionKey === null
      ? null
      : requireString(value.initialSelectionKey);
  if (
    initialSelectionKey !== null &&
    !commandKeys.has(initialSelectionKey)
  ) {
    throw new Error("invalid-selection");
  }
  return deepFreeze({
    project: { label: projectLabel },
    observation: { cursor, live: true },
    commands,
    initialSelectionKey,
  });
}

function sanitizeHostedView(value: unknown): WorkbenchHostedProjectView {
  if (!isRecord(value)) throw new Error("invalid-hosted-view");
  const view = sanitizeView(value, true);
  if (!isStrictDataRecord(value.projectSelection, ["projects"])) {
    throw new Error("invalid-project-selection-snapshot");
  }
  const candidates = value.projectSelection.projects;
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    candidates.length > 1_000
  ) {
    throw new Error("invalid-project-selection-snapshot");
  }
  const selectionKeys = new Set<string>();
  let selectedCount = 0;
  const projects = candidates.map((candidate) => {
    if (
      !isStrictDataRecord(candidate, [
        "availability",
        "label",
        "selected",
        "selectionKey",
      ]) ||
      typeof candidate.label !== "string" ||
      !isSafeProjectLabel(candidate.label) ||
      !isProjectAvailability(candidate.availability) ||
      typeof candidate.selected !== "boolean" ||
      typeof candidate.selectionKey !== "string" ||
      !projectSelectionKeyPattern.test(candidate.selectionKey) ||
      selectionKeys.has(candidate.selectionKey)
    ) {
      throw new Error("invalid-project-option");
    }
    selectionKeys.add(candidate.selectionKey);
    if (candidate.selected) selectedCount += 1;
    return Object.freeze({
      label: candidate.label,
      availability: candidate.availability,
      selected: candidate.selected,
      selectionKey: candidate.selectionKey,
    });
  });
  if (selectedCount !== 1) throw new Error("invalid-selected-project");
  if (!projects.some(
    (project) => project.selected && project.label === view.project.label,
  )) {
    throw new Error("inconsistent-selected-project");
  }
  return deepFreeze({
    ...view,
    projectSelection: { projects },
  });
}

function sanitizeCommand(value: unknown): WorkbenchCommandView {
  const hasFailure =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "failureCategory");
  const hasSession =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "session");
  const hasInterrupt =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "interrupt");
  const hasSteer =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "steer");
  if (
    !isStrictDataRecord(value, [
      ...(hasFailure ? ["failureCategory"] : []),
      ...(hasInterrupt ? ["interrupt"] : []),
      "key",
      "label",
      "runtime",
      ...(hasSession ? ["session"] : []),
      "status",
      ...(hasSteer ? ["steer"] : []),
    ]) ||
    !isStatus(value.status)
  ) {
    throw new Error("invalid-command");
  }
  if (
    (hasFailure && value.failureCategory === undefined) ||
    (hasInterrupt && value.interrupt === undefined) ||
    (hasSession && value.session === undefined) ||
    (hasSteer && value.steer === undefined)
  ) {
    throw new Error("invalid-command");
  }
  const runtime = requireString(value.runtime);
  if (!isSafePublicDisplayText(runtime, 160)) {
    throw new Error("invalid-runtime-label");
  }
  const key = requireString(value.key);
  const ordinalMatch = /^command-([1-9][0-9]*)$/u.exec(key);
  if (ordinalMatch === null) throw new Error("invalid-command-key");
  const label = requireString(value.label);
  if (normalizeSessionDisplayName(label) !== label) {
    throw new Error("invalid-command-label");
  }
  const failureCategory =
    value.failureCategory === undefined
      ? undefined
      : requireCommandFailure(value.failureCategory);
  const interrupt = hasInterrupt
    ? sanitizeInterruptControl(value.interrupt)
    : undefined;
  const steer = hasSteer ? sanitizeSteerControl(value.steer) : undefined;
  if (interrupt !== undefined && value.status !== "in-flight") {
    throw new Error("invalid-interrupt-control");
  }
  if (steer !== undefined && value.status !== "in-flight") {
    throw new Error("invalid-steer-control");
  }
  let session: WorkbenchCommandView["session"];
  if (value.session !== undefined) {
    const hasContext =
      isRecord(value.session) &&
      Object.prototype.hasOwnProperty.call(value.session, "context");
    const hasTurns =
      isRecord(value.session) &&
      Object.prototype.hasOwnProperty.call(value.session, "turns");
    const sessionKeys = [
      ...(hasContext ? ["context"] : []),
      "archived",
      "metadataKey",
      "profile",
      "removalKey",
      "resumable",
      "selectionKey",
      "timeline",
      ...(hasTurns ? ["turns"] : []),
    ];
    if (
      !isStrictDataRecord(value.session, sessionKeys) ||
      !Array.isArray(value.session.timeline) ||
      (hasTurns && !Array.isArray(value.session.turns)) ||
      typeof value.session.archived !== "boolean" ||
      typeof value.session.metadataKey !== "string" ||
      !sessionMetadataKeyPattern.test(value.session.metadataKey) ||
      typeof value.session.removalKey !== "string" ||
      !sessionRemovalKeyPattern.test(value.session.removalKey) ||
      typeof value.session.resumable !== "boolean" ||
      (value.session.selectionKey !== null &&
        (typeof value.session.selectionKey !== "string" ||
          !sessionSelectionKeyPattern.test(value.session.selectionKey))) ||
      (value.session.resumable !== (value.session.selectionKey !== null)) ||
      (value.session.archived &&
        (value.session.resumable || value.session.selectionKey !== null))
    ) {
      throw new Error("invalid-session");
    }
    const context = Object.prototype.hasOwnProperty.call(value.session, "context")
      ? sanitizeContext(value.session.context)
      : undefined;
    const profile = sanitizeProfileProjection(value.session.profile);
    const timeline = value.session.timeline.map(sanitizeEvent);
    const rawTurns = hasTurns && Array.isArray(value.session.turns)
      ? value.session.turns
      : undefined;
    const turns = rawTurns !== undefined
      ? rawTurns.map(sanitizeTurn)
      : undefined;
    if (
      turns !== undefined &&
      (turns.length === 0 ||
        !samePublicValue(
          turns.flatMap((turn) => turn.timeline),
          timeline,
        ) ||
        !samePublicValue(turns.at(-1)?.profile, profile))
    ) {
      throw new Error("invalid-session-turns");
    }
    session = deepFreeze({
      ...(context === undefined ? {} : { context }),
      profile,
      timeline,
      ...(turns === undefined ? {} : { turns }),
      archived: value.session.archived,
      metadataKey: value.session.metadataKey,
      removalKey: value.session.removalKey,
      resumable: value.session.resumable,
      selectionKey: value.session.selectionKey,
    });
  }
  const expectedRuntime =
    session?.profile.requested.kind === "recorded"
      ? session.profile.requested.runtimeFamilyLabel
      : "Codex";
  if (runtime !== expectedRuntime) throw new Error("invalid-runtime-label");
  if (
    session?.turns?.some(
      (turn) =>
        turn.profile.requested.kind === "recorded" &&
        turn.profile.requested.runtimeFamilyLabel !== runtime,
    )
  ) {
    throw new Error("invalid-turn-runtime-label");
  }
  return deepFreeze({
    key,
    label,
    runtime,
    status: value.status,
    ...(failureCategory === undefined ? {} : { failureCategory }),
    ...(interrupt === undefined ? {} : { interrupt }),
    ...(session === undefined ? {} : { session }),
    ...(steer === undefined ? {} : { steer }),
  });
}

function sanitizeInterruptControl(value: unknown): WorkbenchInterruptControl {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("invalid-interrupt-control");
  }
  if (
    value.status === "available" &&
    hasExactKeys(value, ["interruptKey", "status"]) &&
    typeof value.interruptKey === "string" &&
    interruptKeyPattern.test(value.interruptKey)
  ) {
    return Object.freeze({
      status: "available",
      interruptKey: value.interruptKey,
    });
  }
  const reasons = {
    pending: "Interrupt becomes available when the Runtime turn starts.",
    unsupported: "This Runtime does not support interruption.",
    requested: "Interrupt requested. Waiting for the Runtime to stop.",
    unavailable: "Interrupt is unavailable for this turn.",
  } as const;
  if (
    (value.status === "pending" ||
      value.status === "unsupported" ||
      value.status === "requested" ||
      value.status === "unavailable") &&
    hasExactKeys(value, ["reason", "status"]) &&
    value.reason === reasons[value.status]
  ) {
    switch (value.status) {
      case "pending":
        return Object.freeze({ status: "pending", reason: reasons.pending });
      case "unsupported":
        return Object.freeze({
          status: "unsupported",
          reason: reasons.unsupported,
        });
      case "requested":
        return Object.freeze({ status: "requested", reason: reasons.requested });
      case "unavailable":
        return Object.freeze({
          status: "unavailable",
          reason: reasons.unavailable,
        });
    }
  }
  throw new Error("invalid-interrupt-control");
}

function sanitizeSteerControl(value: unknown): WorkbenchSteerControl {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("invalid-steer-control");
  }
  if (
    value.status === "available" &&
    hasExactKeys(value, ["status", "steerKey"]) &&
    typeof value.steerKey === "string" &&
    steerKeyPattern.test(value.steerKey)
  ) {
    return Object.freeze({ status: "available", steerKey: value.steerKey });
  }
  const reasons = {
    pending: "Same-turn guidance becomes available when the Runtime turn starts.",
    unsupported:
      "This Runtime does not support same-turn guidance. Your draft stays local.",
    submitting: "Sending guidance to this running turn.",
    unavailable: "Same-turn guidance is unavailable. Your draft stays local.",
  } as const;
  if (
    (value.status === "pending" ||
      value.status === "unsupported" ||
      value.status === "submitting" ||
      value.status === "unavailable") &&
    hasExactKeys(value, ["reason", "status"]) &&
    value.reason === reasons[value.status]
  ) {
    switch (value.status) {
      case "pending":
        return Object.freeze({ status: "pending", reason: reasons.pending });
      case "unsupported":
        return Object.freeze({
          status: "unsupported",
          reason: reasons.unsupported,
        });
      case "submitting":
        return Object.freeze({ status: "submitting", reason: reasons.submitting });
      case "unavailable":
        return Object.freeze({
          status: "unavailable",
          reason: reasons.unavailable,
        });
    }
  }
  throw new Error("invalid-steer-control");
}

function sanitizeContext(value: unknown): WorkbenchSessionContextUsage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["usedTokens", "windowTokens"]) ||
    typeof value.usedTokens !== "number" ||
    !Number.isSafeInteger(value.usedTokens) ||
    value.usedTokens < 0 ||
    (value.windowTokens !== null &&
      (typeof value.windowTokens !== "number" ||
        !Number.isSafeInteger(value.windowTokens) ||
        value.windowTokens < value.usedTokens))
  ) {
    throw new Error("invalid-context");
  }
  return Object.freeze({
    usedTokens: value.usedTokens,
    windowTokens: value.windowTokens as number | null,
  });
}

function sanitizeProfileProjection(
  value: unknown,
): WorkbenchSessionProfileProjection {
  if (!isRecord(value) || !hasExactKeys(value, ["effective", "requested"])) {
    throw new Error("invalid-profile-projection");
  }
  const requested =
    isRecord(value.requested) &&
    hasExactKeys(value.requested, ["kind"]) &&
    value.requested.kind === "not-recorded"
      ? Object.freeze({ kind: "not-recorded" as const })
      : cloneRequestedSessionProfileProjection(value.requested);
  if (requested.kind === "not-recorded") {
    if (
      !isRecord(value.effective) ||
      !hasExactKeys(value.effective, ["kind"]) ||
      value.effective.kind !== "not-recorded"
    ) {
      throw new Error("invalid-historical-profile-projection");
    }
    return deepFreeze({
      requested,
      effective: { kind: "not-recorded" as const },
    });
  }
  return deepFreeze({
    requested,
    effective: cloneEffectiveSessionProfileProjection(value.effective),
  });
}

function sanitizeTurn(value: unknown) {
  if (
    !isStrictDataRecord(value, ["profile", "timeline"]) ||
    !Array.isArray(value.timeline)
  ) {
    throw new Error("invalid-turn");
  }
  return deepFreeze({
    profile: sanitizeProfileProjection(value.profile),
    timeline: value.timeline.map(sanitizeEvent),
  });
}

function samePublicValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeEvent(value: unknown): WorkbenchTimelineEvent {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("invalid-event");
  }
  switch (value.kind) {
    case "user-message":
      if (
        !hasExactKeys(value, ["kind", "text"]) ||
        !isValidWorkbenchDirectInput(value.text)
      ) {
        throw new Error("invalid-event");
      }
      return Object.freeze({ kind: "user-message", text: value.text });
    case "session-started":
    case "turn-started":
      return Object.freeze({ kind: value.kind });
    case "item-started":
    case "item-completed":
      if (value.itemType !== "agent-message") throw new Error("invalid-event");
      return Object.freeze({ kind: value.kind, itemType: "agent-message" });
    case "agent-message":
      return Object.freeze({
        kind: "agent-message",
        text: sanitizeDisplayString(requireString(value.text)),
      });
    case "turn-completed":
      if (value.status !== "completed") throw new Error("invalid-event");
      return Object.freeze({ kind: "turn-completed", status: "completed" });
    case "turn-interrupted":
      if (
        !hasExactKeys(value, ["kind", "status"]) ||
        value.status !== "interrupted"
      ) {
        throw new Error("invalid-event");
      }
      return Object.freeze({ kind: "turn-interrupted", status: "interrupted" });
    case "failed":
      return Object.freeze({ kind: "failed" });
    default:
      throw new Error("invalid-event");
  }
}

function sanitizeDisplayString(value: string): string {
  return redactFilesystemPaths(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ""),
  );
}

function isSafePublicLabel(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9 .+_-]*$/u.test(value)
  );
}

function isSafePublicDisplayText(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    [...value].length <= maximumLength &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function isSafeProjectLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 160 &&
    [...value].length <= 80 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function isProjectAvailability(
  value: unknown,
): value is WorkbenchProjectAvailability {
  return value === "available" || value === "missing" || value === "unreadable";
}

function requireCommandFailure(value: unknown): ProjectCommandFailureCategory {
  if (
    !commandFailureCategories.includes(value as ProjectCommandFailureCategory)
  ) {
    throw new Error("invalid-failure");
  }
  return value as ProjectCommandFailureCategory;
}

function requireCursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("invalid-cursor");
  }
  return value as number;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid-string");
  return value;
}

function isStatus(value: unknown): value is ProjectCommandStatus {
  return statuses.includes(value as ProjectCommandStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStableCloneableDataGraph(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const objects: object[] = [];
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "function" || typeof candidate === "symbol") {
      return false;
    }
    if (candidate === null || typeof candidate !== "object") return true;
    if (seen.has(candidate)) return true;
    seen.add(candidate);
    objects.push(candidate);
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
    if (!visit(value)) return false;
    // Structured clone rejects every collected Proxy without invoking `get`;
    // exact checks below still see non-enumerable compatibility aliases.
    structuredClone(objects);
    return true;
  } catch {
    return false;
  }
}

function hasExactDirectProfileKeys(
  value: unknown,
  requestKind: WorkbenchDirectSessionProfileLoadRequest["kind"],
): value is Record<string, unknown> {
  const publicKeys = [
    requestKind === "catalog-default"
      ? "desiredDefault"
      : requestKind === "replacement-session"
        ? "replacementPrefill"
        : "continuationPrefill",
    "endpoints",
    "snapshotKey",
  ] as const;
  const compatibilityKeys = [
    "accessMode",
    "executionMode",
    "models",
    "runtime",
  ] as const;
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    const hasCompatibilityProjection =
      keys.length === publicKeys.length + compatibilityKeys.length;
    if (
      keys.some((key) => typeof key !== "string") ||
      (keys.length !== publicKeys.length && !hasCompatibilityProjection)
    ) {
      return false;
    }
    if (
      !publicKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable
        );
      })
    ) {
      return false;
    }
    if (!hasCompatibilityProjection) {
      return keys.every(
        (key) => typeof key === "string" && publicKeys.includes(key as never),
      );
    }
    return compatibilityKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        !descriptor.enumerable
      );
    });
  } catch {
    return false;
  }
}

function isStrictDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isStrictDataRecordWithAllowedKeys(value, expectedKeys)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      expectedKeys.every((key) => keys.includes(key))
    );
  } catch {
    return false;
  }
}

function isStrictDataRecordWithAllowedKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => {
      if (typeof key !== "string" || !allowedKeys.includes(key)) return false;
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

function isDenseDataArray(value: unknown): value is unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > 1_000
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable
    ) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
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
