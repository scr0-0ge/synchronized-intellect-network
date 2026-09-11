import type { WorkbenchProjectPathFailure, WorkbenchProjectPathFailureReason } from "./contract.ts";
import type { WorkbenchSubscriptionUsageObservation, WorkbenchSubscriptionUsageResult } from "./contract.ts";
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
  isWorkbenchRuntimeFailureCategory,
  isValidWorkbenchDirectInput,
  isValidWorkbenchEndpointKeyValue,
  WORKBENCH_ENDPOINT_KEY_MAX_LENGTH,
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
  publicEndpointPreferencesLoaded,
  publicEndpointPreferenceSaved,
  publicEndpointPreferenceUnavailable,
  publicEndpointKeyInvalidValue,
  publicEndpointKeyNotConfigured,
  publicEndpointKeyRemoved,
  publicEndpointKeyRevealed,
  publicEndpointKeySaved,
  publicEndpointKeyStatusLoaded,
  publicEndpointKeyUnavailable,
  publicEndpointProbed,
  publicEndpointCatalogFreshnessLoaded,
  publicEndpointCatalogFreshnessRefreshed,
  publicEndpointCatalogFreshnessUnavailable,
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
  publicEmptyProjectRegistry,
  publicHostedProjectFailure,
  publicInvalidProjectSelection,
  publicProjectFailure,
  publicProjectOpened,
  publicProjectOpenedWithExistingHistory,
  publicProjectOpenCancelled,
  publicOpenProjectHistorySelectionRequired,
  publicProjectOpenUnavailable,
  publicProjectDriveRootRefused,
  publicOpenProjectDriveRootRefused,
  WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL,
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
  type WorkbenchFamilyEndpointPreference,
  type WorkbenchFamilyEndpointPreferences,
  type WorkbenchEndpointPreferenceLoadResult,
  type WorkbenchEndpointPreferenceSaveResult,
  type WorkbenchCreateProjectResult,
  type WorkbenchDirectInputRequest,
  type WorkbenchEndpointKeyRemoveResult,
  type WorkbenchEndpointKeyRevealResult,
  type WorkbenchEndpointKeySaveResult,
  type WorkbenchEndpointKeySnapshot,
  type WorkbenchEndpointKeyStatusResult,
  type WorkbenchEndpointProbeFailureReason,
  type WorkbenchEndpointProbeResult,
  type WorkbenchEndpointCatalogFreshnessModelEntry,
  type WorkbenchEndpointCatalogFreshnessResult,
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
  type WorkbenchProjectTransfer,
  type WorkbenchTurnView,
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
  type WorkbenchToolActivity,
  type WorkbenchWorkIntensityOption,
} from "./contract.ts";
import {
  isRegisteredRuntimeEndpointId,
  runtimeEndpointOrdinal,
  WORKBENCH_RUNTIME_ENDPOINT_IDS,
} from "./runtime-endpoint-identity.ts";
import type { SubscriptionAuthenticationEndpointId } from "../agent-runtime/subscription-authentication.ts";

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

export type WorkbenchFamilyEndpointPreferenceReconstruction =
  | {
      readonly ok: true;
      readonly preference: WorkbenchFamilyEndpointPreference;
    }
  | { readonly ok: false };

export function reconstructWorkbenchFamilyEndpointPreference(
  value: unknown,
): WorkbenchFamilyEndpointPreferenceReconstruction {
  return value === "kimi-code" ||
    value === "kimi-platform" ||
    value === "claude-code-desktop" ||
    value === "claude-api" ||
    value === "codex-desktop" ||
    value === "codex-api"
    ? Object.freeze({
        ok: true,
        preference: value,
      })
    : Object.freeze({ ok: false });
}

export type WorkbenchFamilyEndpointPreferencesReconstruction =
  | {
      readonly ok: true;
      readonly preferences: WorkbenchFamilyEndpointPreferences;
    }
  | { readonly ok: false };

export function reconstructWorkbenchFamilyEndpointPreferences(
  value: unknown,
): WorkbenchFamilyEndpointPreferencesReconstruction {
  if (
    !isStrictDataRecord(value, ["claude", "codex", "kimi"])
  ) {
    return Object.freeze({ ok: false });
  }
  if (
    value.claude !== "claude-code-desktop" &&
    value.claude !== "claude-api"
  ) {
    return Object.freeze({ ok: false });
  }
  if (value.codex !== "codex-desktop" && value.codex !== "codex-api") {
    return Object.freeze({ ok: false });
  }
  if (value.kimi !== "kimi-code" && value.kimi !== "kimi-platform") {
    return Object.freeze({ ok: false });
  }
  return Object.freeze({
    ok: true,
    preferences: Object.freeze({
      claude: value.claude,
      codex: value.codex,
      kimi: value.kimi,
    }),
  });
}

export function sanitizeWorkbenchEndpointPreferenceLoadResult(
  value: unknown,
): WorkbenchEndpointPreferenceLoadResult {
  try {
    if (
      isStrictDataRecord(value, ["ok", "preferences", "status"]) &&
      value.ok === true &&
      value.status === "loaded"
    ) {
      const reconstructed = reconstructWorkbenchFamilyEndpointPreferences(
        value.preferences,
      );
      if (reconstructed.ok) {
        return publicEndpointPreferencesLoaded(reconstructed.preferences);
      }
    }
    if (isEndpointPreferenceFailureResult(value)) {
      return publicEndpointPreferenceUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointPreferenceUnavailable();
}

export function sanitizeWorkbenchEndpointPreferenceSaveResult(
  value: unknown,
): WorkbenchEndpointPreferenceSaveResult {
  try {
    if (
      isStrictDataRecord(value, ["message", "ok", "status"]) &&
      value.ok === true &&
      value.status === "saved" &&
      value.message === "The endpoint preference was durably saved."
    ) {
      return publicEndpointPreferenceSaved();
    }
    if (isEndpointPreferenceFailureResult(value)) {
      return publicEndpointPreferenceUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointPreferenceUnavailable();
}

function isEndpointPreferenceFailureResult(value: unknown): boolean {
  return (
    isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    value.error.category === "endpoint-preference-unavailable" &&
    value.error.message ===
      "The endpoint preference could not be loaded or saved. Keep the current choice and try again."
  );
}

export type WorkbenchEndpointKeySaveRequestReconstruction =
  | { readonly ok: true; readonly keyValue: string }
  | { readonly ok: false };

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeySaveRequestReconstruction =
  WorkbenchEndpointKeySaveRequestReconstruction;

/**
 * The save request is the one renderer-to-main channel that carries secret
 * material (the user's explicit save action). Everything else crosses the
 * boundary name-only.
 */
export function reconstructWorkbenchEndpointKeySaveRequest(
  value: unknown,
): WorkbenchEndpointKeySaveRequestReconstruction {
  try {
    if (
      !isStrictDataRecord(value, ["keyValue"]) ||
      !isValidWorkbenchEndpointKeyValue(value.keyValue)
    ) {
      return Object.freeze({ ok: false });
    }
    return Object.freeze({ ok: true, keyValue: value.keyValue });
  } catch {
    return Object.freeze({ ok: false });
  }
}

/** Compatibility alias from the GLM-only era of this surface. */
export const reconstructWorkbenchGlmEndpointKeySaveRequest =
  reconstructWorkbenchEndpointKeySaveRequest;

export function sanitizeWorkbenchEndpointKeyStatusResult(
  value: unknown,
): WorkbenchEndpointKeyStatusResult {
  try {
    if (
      isStrictDataRecord(value, ["ok", "snapshot", "status"]) &&
      value.ok === true &&
      value.status === "loaded"
    ) {
      const snapshot = reconstructEndpointKeySnapshot(value.snapshot);
      if (snapshot !== undefined) {
        return publicEndpointKeyStatusLoaded(snapshot);
      }
    }
    if (isEndpointKeyFailureResult(value)) {
      return publicEndpointKeyUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointKeyUnavailable();
}

/** Compatibility alias from the GLM-only era of this surface. */
export const sanitizeWorkbenchGlmEndpointKeyStatusResult =
  sanitizeWorkbenchEndpointKeyStatusResult;

export function sanitizeWorkbenchEndpointKeySaveResult(
  value: unknown,
): WorkbenchEndpointKeySaveResult {
  try {
    if (
      isStrictDataRecord(value, ["isPersistent", "maskedHint", "ok", "status"]) &&
      value.ok === true &&
      value.status === "saved" &&
      isMaskedEndpointSecretHint(value.maskedHint) &&
      typeof value.isPersistent === "boolean"
    ) {
      return publicEndpointKeySaved(value.maskedHint, value.isPersistent);
    }
    if (isEndpointKeyFailureResult(value)) {
      return value.error.category === "endpoint-key-invalid-value"
        ? publicEndpointKeyInvalidValue()
        : publicEndpointKeyUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointKeyUnavailable();
}

/** Compatibility alias from the GLM-only era of this surface. */
export const sanitizeWorkbenchGlmEndpointKeySaveResult =
  sanitizeWorkbenchEndpointKeySaveResult;

export function sanitizeWorkbenchEndpointKeyRemoveResult(
  value: unknown,
): WorkbenchEndpointKeyRemoveResult {
  try {
    if (isStrictDataRecord(value, ["ok", "snapshot", "status"]) && value.ok === true) {
      if (value.status === "removed" || value.status === "not-configured") {
        const snapshot = reconstructEndpointKeySnapshot(value.snapshot);
        // Both removal outcomes report the post-removal state: nothing stored.
        if (snapshot !== undefined && snapshot.configured === false) {
          return value.status === "removed"
            ? publicEndpointKeyRemoved(snapshot)
            : publicEndpointKeyNotConfigured(snapshot);
        }
      }
    }
    if (isEndpointKeyFailureResult(value)) {
      return publicEndpointKeyUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointKeyUnavailable();
}

/** Compatibility alias from the GLM-only era of this surface. */
export const sanitizeWorkbenchGlmEndpointKeyRemoveResult =
  sanitizeWorkbenchEndpointKeyRemoveResult;

export function sanitizeWorkbenchEndpointKeyRevealResult(
  value: unknown,
): WorkbenchEndpointKeyRevealResult {
  try {
    if (
      isStrictDataRecordWithAllowedKeys(value, [
        "ok",
        "status",
        "snapshot",
        "value",
      ]) &&
      value.ok === true
    ) {
      if (
        value.status === "not-configured" &&
        Object.hasOwn(value, "snapshot")
      ) {
        const snapshot = reconstructEndpointKeySnapshot(value.snapshot);
        if (snapshot !== undefined && snapshot.configured === false) {
          return publicEndpointKeyNotConfigured(snapshot);
        }
      }
      if (
        value.status === "revealed" &&
        Object.hasOwn(value, "value") &&
        Object.hasOwn(value, "snapshot") &&
        typeof value.value === "string" &&
        value.value.length > 0 &&
        value.value.length <= WORKBENCH_ENDPOINT_KEY_MAX_LENGTH
      ) {
        const snapshot = reconstructEndpointKeySnapshot(value.snapshot);
        // A reveal without a configured snapshot is internally inconsistent.
        if (snapshot !== undefined && snapshot.configured === true) {
          return publicEndpointKeyRevealed(value.value, snapshot);
        }
      }
    }
    if (isEndpointKeyFailureResult(value)) {
      return publicEndpointKeyUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointKeyUnavailable();
}

/** Compatibility alias from the GLM-only era of this surface. */
export const sanitizeWorkbenchGlmEndpointKeyRevealResult =
  sanitizeWorkbenchEndpointKeyRevealResult;

export function sanitizeWorkbenchEndpointProbeResult(
  value: unknown,
): WorkbenchEndpointProbeResult {
  try {
    if (
      isStrictDataRecord(value, ["ok", "probe", "status"]) &&
      value.ok === true &&
      value.status === "probed"
    ) {
      const probe = value.probe;
      if (
        isStrictDataRecord(probe, ["outcome"]) &&
        probe.outcome === "success"
      ) {
        return publicEndpointProbed({ outcome: "success" });
      }
      if (
        isStrictDataRecord(probe, ["outcome", "reason"]) &&
        probe.outcome === "failure" &&
        isEndpointProbeFailureReason(probe.reason)
      ) {
        return publicEndpointProbed({
          outcome: "failure",
          reason: probe.reason,
        });
      }
    }
    if (isEndpointKeyFailureResult(value)) {
      return publicEndpointKeyUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointKeyUnavailable();
}

/** Compatibility alias from the GLM-only era of this surface. */
export const sanitizeWorkbenchGlmEndpointProbeResult =
  sanitizeWorkbenchEndpointProbeResult;

export function sanitizeWorkbenchEndpointCatalogFreshnessResult(
  value: unknown,
): WorkbenchEndpointCatalogFreshnessResult {
  try {
    if (
      isStrictDataRecord(value, ["ok", "reports", "status"]) &&
      value.ok === true &&
      (value.status === "loaded" || value.status === "refreshed") &&
      isDenseDataArray(value.reports)
    ) {
      const reports = value.reports.map((report) => {
        if (
          !isStrictDataRecord(report, [
            "endpointId",
            "enrolledModels",
            "newModels",
            "status",
          ]) ||
          (report.endpointId !== "glm-coding-plan" &&
            report.endpointId !== "kimi-code" &&
            report.endpointId !== "deepseek-api") ||
          (report.status !== "fresh" && report.status !== "silent-failure") ||
          !isDenseDataArray(report.newModels) ||
          !isDenseDataArray(report.enrolledModels)
        ) {
          throw new Error("invalid-catalog-freshness-report");
        }
        return Object.freeze({
          endpointId: report.endpointId,
          status: report.status,
          newModels: Object.freeze(
            report.newModels.map(reconstructFreshnessEntry),
          ),
          enrolledModels: Object.freeze(
            report.enrolledModels.map(reconstructFreshnessEntry),
          ),
        });
      });
      return value.status === "loaded"
        ? publicEndpointCatalogFreshnessLoaded(reports)
        : publicEndpointCatalogFreshnessRefreshed(reports);
    }
    if (
      isStrictDataRecord(value, ["error", "ok"]) &&
      value.ok === false &&
      isStrictDataRecord(value.error, ["category", "message"]) &&
      value.error.category === "endpoint-catalog-freshness-unavailable"
    ) {
      return publicEndpointCatalogFreshnessUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicEndpointCatalogFreshnessUnavailable();
}

function reconstructFreshnessEntry(
  value: unknown,
): WorkbenchEndpointCatalogFreshnessModelEntry {
  if (
    !isStrictDataRecordWithAllowedKeys(value, [
      "createdAt",
      "displayName",
      "id",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 200 ||
    !/^[^\u0000-\u001f\u007f-\u009f\s]*$/u.test(value.id) ||
    (value.displayName !== undefined &&
      (typeof value.displayName !== "string" ||
        value.displayName.length > 200 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(value.displayName))) ||
    (value.createdAt !== undefined &&
      (typeof value.createdAt !== "string" || value.createdAt.length > 64))
  ) {
    throw new Error("invalid-catalog-freshness-entry");
  }
  return Object.freeze({
    id: value.id,
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
  });
}

function reconstructEndpointKeySnapshot(
  value: unknown,
): WorkbenchEndpointKeySnapshot | undefined {
  if (
    !isStrictDataRecord(value, [
      "configured",
      "environmentFallback",
      "isPersistent",
      "maskedHint",
    ]) ||
    typeof value.configured !== "boolean" ||
    typeof value.isPersistent !== "boolean" ||
    typeof value.environmentFallback !== "boolean"
  ) {
    return undefined;
  }
  if (value.configured) {
    if (!isMaskedEndpointSecretHint(value.maskedHint)) return undefined;
  } else if (value.maskedHint !== null) {
    return undefined;
  }
  return Object.freeze({
    configured: value.configured,
    maskedHint: value.maskedHint,
    isPersistent: value.isPersistent,
    environmentFallback: value.environmentFallback,
  });
}

/** The masked-hint format the main process emits: `••••` plus ≤4 tail chars. */
function isMaskedEndpointSecretHint(value: unknown): value is string {
  return (
    typeof value === "string" && /^••••[\x21-\x7e]{0,4}$/u.test(value)
  );
}

function isEndpointProbeFailureReason(
  value: unknown,
): value is WorkbenchEndpointProbeFailureReason {
  return (
    value === "token-missing" ||
    value === "invalid-base-url" ||
    value === "unauthorized" ||
    value === "endpoint-error" ||
    value === "server-error" ||
    value === "network" ||
    value === "timeout"
  );
}

function isEndpointKeyFailureResult(
  value: unknown,
): value is {
  readonly ok: false;
  readonly error: {
    readonly category: "endpoint-key-unavailable" | "endpoint-key-invalid-value";
    readonly message: string;
  };
} {
  return (
    isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    (value.error.category === "endpoint-key-unavailable" ||
      value.error.category === "endpoint-key-invalid-value") &&
    (value.error.category !== "endpoint-key-unavailable" ||
      value.error.message ===
        "Endpoint key management is unavailable. Keep the current key and try again.")
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
    if (
      isStrictDataRecord(value, ["kind", "url"]) &&
      value.kind === "authentication-sign-in-url" &&
      isSubscriptionSignInUrl(value.url)
    ) {
      return acceptedSubscriptionAuthenticationBoundaryValue(
        Object.freeze({ kind: value.kind, url: value.url }),
      );
    }
  } catch {
    // Accessors, Proxies, and failing key authorities remain outside the seam.
  }
  return Object.freeze({ accepted: false as const });
}

const maximumSubscriptionSignInUrlLength = 2_048;
/** Whitespace, C0/C1 controls, and the bidirectional overrides. */
const subscriptionSignInUrlRejectedCharacters =
  /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Admit only what can be shown as a sign-in link and nothing else.
 *
 * `https:` alone: the CLI's own `http://localhost:PORT` callback server is not
 * a sign-in destination, and a renderer that will put this into an anchor must
 * never be handed a `javascript:` or `data:` scheme. Whitespace and control
 * characters are refused rather than trimmed -- a URL that needed repairing is
 * not the URL the CLI printed, and displaying a repaired one would be this
 * product's headline defect (saying a thing that did not happen).
 */
function isSubscriptionSignInUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumSubscriptionSignInUrlLength ||
    subscriptionSignInUrlRejectedCharacters.test(value)
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.href.length <= maximumSubscriptionSignInUrlLength;
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

/**
 * The exact participant set of subscription authentication. Exhaustive over
 * the participants union, so a future OAuth endpoint joins as a data change
 * here; static-key endpoints (GLM) are structurally absent.
 */
const subscriptionAuthenticationEndpointIds: Readonly<
  Record<SubscriptionAuthenticationEndpointId, true>
> = Object.freeze({
  "codex-desktop": true,
  "claude-code-desktop": true,
});

function isSubscriptionAuthenticationEndpointId(
  value: unknown,
): value is SubscriptionAuthenticationEndpointId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      subscriptionAuthenticationEndpointIds,
      value,
    )
  );
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
    if ("failure" in value) {
      const failure = reconstructWorkbenchProjectPathFailure(value.failure);
      return outcome === "unavailable" && hasExactKeys(value, ["failure", "outcome"]) && failure !== undefined
        ? publicCreateProjectResult("unavailable", failure)
        : publicCreateProjectResult("unavailable");
    }
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
    if (!hasStableCloneableDataGraph(value)) {
      return Object.freeze({ ok: false });
    }
    const acknowledged = isStrictDataRecord(value, [
      "acknowledgedUnknownOutcome",
      "metadataKey",
      "operation",
    ]);
    if (
      (!acknowledged &&
        !isStrictDataRecord(value, ["metadataKey", "operation"])) ||
      typeof value.metadataKey !== "string" ||
      !sessionMetadataKeyPattern.test(value.metadataKey) ||
      !isRecord(value.operation)
    ) {
      return Object.freeze({ ok: false });
    }
    if (
      acknowledged &&
      (value.operation.kind !== "archive" ||
        value.acknowledgedUnknownOutcome !== true)
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
        ...(acknowledged
          ? { acknowledgedUnknownOutcome: true as const }
          : {}),
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
  "quota-paused",
  "failed",
  "recovery-required",
];
const commandFailureCategories: readonly ProjectCommandFailureCategory[] = [
  "interrupted",
  "profile-resolution-failed",
  "runtime-failed",
  "quota-expired",
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
    isStrictDataRecord(value, ["empty", "ok"]) &&
    value.ok === true &&
    value.empty === true
  ) {
    return publicEmptyProjectRegistry();
  }
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

function sanitizeWorkbenchHostedProjectResultStrict(
  value: unknown,
): WorkbenchHostedProjectResult | undefined {
  const result = sanitizeWorkbenchHostedProjectResult(value);
  if (result.ok) {
    if ("empty" in result) {
      return isStrictDataRecord(value, ["empty", "ok"]) &&
        value.ok === true &&
        value.empty === true
        ? result
        : undefined;
    }
    return isStrictDataRecord(value, ["ok", "view"]) && value.ok === true
      ? result
      : undefined;
  }
  return isStrictDataRecord(value, ["error", "ok"]) &&
    value.ok === false &&
    isStrictDataRecord(value.error, ["category", "message"]) &&
    value.error.category === "project-view-unavailable" &&
    value.error.message === "Live Project data is unavailable."
    ? result
    : undefined;
}

// A revision identifies an actual transfer, not a digest of the history. A new
// observation gets a fresh revision so stale deltas cannot address its turns.
let nextProjectTransferRevision = 0;
export function createWorkbenchProjectTransferEncoder() {
  let previous: WorkbenchHostedProjectResult | undefined;
  let previousRevision = 0;
  return (input: WorkbenchHostedProjectResult): WorkbenchProjectTransfer => {
    const result = sanitizeWorkbenchHostedProjectResult(input);
    const revision = ++nextProjectTransferRevision;
    let transfer: WorkbenchProjectTransfer = { kind: "snapshot", revision, result };
    if (result.ok && "view" in result && previous?.ok && "view" in previous &&
        result.view.commands.every(command => !command.session || command.session.turns !== undefined)) {
      const turns = new Map<WorkbenchTurnView, number>();
      previous.view.commands.flatMap(command => command.session?.turns ?? [])
        .forEach((turn, index) => turns.set(turn, index));
      transfer = { kind: "delta", revision, baseRevision: previousRevision, view: {
        ...result.view,
        commands: result.view.commands.map(command => {
          if (!command.session) { const { session: _session, ...header } = command; return header; }
          const { timeline: _timeline, turns: currentTurns, ...session } = command.session;
          return { ...command, session: { ...session, turns: currentTurns!.map(turn => {
            const reuse = turns.get(turn);
            return reuse === undefined ? turn : { reuse };
          }) } };
        }),
      } };
    }
    if (transfer.kind === "delta" && !transfer.view.commands.some(command =>
      command.session?.turns.some(turn => "reuse" in turn))) {
      // Full recovery (or a different Project) has no shared immutable history.
      transfer = { kind: "snapshot", revision, result };
    }
    previous = result;
    previousRevision = revision;
    return transfer;
  };
}

type WorkbenchProjectDelta = Extract<
  WorkbenchProjectTransfer,
  { readonly kind: "delta" }
>;
type WorkbenchProjectDeltaTurn =
  NonNullable<
    WorkbenchProjectDelta["view"]["commands"][number]["session"]
  >["turns"][number];

/**
 * Preload-side validation for the compact main-process packet. It retains only
 * the prior turn profiles needed to validate later references; historical
 * event text is reconstructed only after the contextBridge crossing.
 */
export function createWorkbenchProjectTransferSanitizer() {
  let previousRevision = 0;
  let previousTurnProfiles:
    | readonly WorkbenchSessionProfileProjection[]
    | undefined;
  return (value: unknown): WorkbenchProjectTransfer | undefined => {
    try {
      if (
        !isRecord(value) ||
        !Number.isSafeInteger(value.revision) ||
        (value.revision as number) <= 0
      ) {
        throw new Error("invalid-transfer");
      }
      if (
        value.kind === "snapshot" &&
        isStrictDataRecord(value, ["kind", "revision", "result"])
      ) {
        const result = sanitizeWorkbenchHostedProjectResultStrict(value.result);
        if (result === undefined) throw new Error("invalid-snapshot");
        previousRevision = value.revision as number;
        previousTurnProfiles =
          result.ok && "view" in result
            ? Object.freeze(
                result.view.commands.flatMap(command =>
                  (command.session?.turns ?? []).map(turn => turn.profile),
                ),
              )
            : undefined;
        return deepFreeze({
          kind: "snapshot" as const,
          revision: previousRevision,
          result,
        });
      }
      if (
        !isStrictDataRecord(value, [
          "kind",
          "revision",
          "baseRevision",
          "view",
        ]) ||
        value.kind !== "delta" ||
        value.baseRevision !== previousRevision ||
        (value.revision as number) <= previousRevision ||
        previousTurnProfiles === undefined ||
        !isStrictDataRecord(value.view, [
          "project",
          "observation",
          "commands",
          "initialSelectionKey",
          "projectSelection",
        ]) ||
        !isDenseDataArray(value.view.commands)
      ) {
        throw new Error("invalid-delta-base");
      }
      const oldTurnProfiles = previousTurnProfiles;

      const compactTurnsByCommand: Array<
        readonly WorkbenchProjectDeltaTurn[] | undefined
      > = [];
      const turnProfilesByCommand: Array<
        readonly WorkbenchSessionProfileProjection[] | undefined
      > = [];
      const validationCommands = value.view.commands.map(
        (command: unknown, commandIndex: number) => {
          if (!isRecord(command) || !Object.hasOwn(command, "session")) {
            compactTurnsByCommand[commandIndex] = undefined;
            turnProfilesByCommand[commandIndex] = undefined;
            return command;
          }
          const session = command.session;
          const sessionKeys = [
            "profile",
            "turns",
            "removalKey",
            "metadataKey",
            "archived",
            "selectionKey",
            "resumable",
          ];
          if (isRecord(session) && Object.hasOwn(session, "context")) {
            sessionKeys.push("context");
          }
          if (
            !isStrictDataRecord(session, sessionKeys) ||
            !isDenseDataArray(session.turns)
          ) {
            throw new Error("invalid-delta-session");
          }
          const compactTurns: WorkbenchProjectDeltaTurn[] = [];
          const turnProfiles: WorkbenchSessionProfileProjection[] = [];
          for (const turn of session.turns) {
            if (isRecord(turn) && Object.hasOwn(turn, "reuse")) {
              if (
                !isStrictDataRecord(turn, ["reuse"]) ||
                !Number.isSafeInteger(turn.reuse) ||
                (turn.reuse as number) < 0 ||
                (turn.reuse as number) >= oldTurnProfiles.length
              ) {
                throw new Error("invalid-turn-reference");
              }
              compactTurns.push(
                Object.freeze({ reuse: turn.reuse as number }),
              );
              turnProfiles.push(oldTurnProfiles[turn.reuse as number]!);
            } else {
              const sanitized = sanitizeTurn(turn);
              compactTurns.push(sanitized);
              turnProfiles.push(sanitized.profile);
            }
          }
          compactTurnsByCommand[commandIndex] = Object.freeze(compactTurns);
          turnProfilesByCommand[commandIndex] = Object.freeze(turnProfiles);
          const lastProfile = turnProfiles.at(-1);
          const validationTurns =
            lastProfile === undefined
              ? []
              : [deepFreeze({ profile: lastProfile, timeline: [] })];
          return {
            ...command,
            session: {
              ...session,
              turns: validationTurns,
              timeline: [],
            },
          };
        },
      );
      const view = sanitizeHostedView({
        ...value.view,
        commands: validationCommands,
      });
      const commands: WorkbenchProjectDelta["view"]["commands"] =
        view.commands.map((command, commandIndex) => {
          const compactTurns = compactTurnsByCommand[commandIndex];
          const turnProfiles = turnProfilesByCommand[commandIndex];
          if (compactTurns === undefined) {
            if (command.session !== undefined || turnProfiles !== undefined) {
              throw new Error("invalid-delta-command");
            }
            const { session: _session, ...header } = command;
            return deepFreeze(header);
          }
          if (command.session === undefined) {
            throw new Error("invalid-delta-command");
          }
          if (
            turnProfiles === undefined ||
            turnProfiles.some(
              profile =>
                profile.requested.kind === "recorded" &&
                profile.requested.runtimeFamilyLabel !== command.runtime,
            )
          ) {
            throw new Error("invalid-turn-runtime-label");
          }
          const { session: _existingSession, ...header } = command;
          const { timeline: _timeline, turns: _turns, ...session } =
            command.session;
          return deepFreeze({
            ...header,
            session: { ...session, turns: compactTurns },
          });
        });
      const transfer = deepFreeze({
        kind: "delta" as const,
        revision: value.revision as number,
        baseRevision: value.baseRevision as number,
        view: { ...view, commands },
      }) satisfies WorkbenchProjectTransfer;
      previousRevision = transfer.revision;
      previousTurnProfiles = Object.freeze(
        turnProfilesByCommand.flatMap(profiles => profiles ?? []),
      );
      return transfer;
    } catch {
      previousRevision = 0;
      previousTurnProfiles = undefined;
      return undefined;
    }
  };
}

/** Undefined means a broken transfer, requiring a new full observation. */
export function createWorkbenchProjectTransferDecoder() {
  let previous: WorkbenchHostedProjectResult | undefined;
  let revision = 0;
  return (value: unknown): WorkbenchHostedProjectResult | undefined => {
    try {
      if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) throw new Error("invalid-transfer");
      let result: WorkbenchHostedProjectResult;
      if (value.kind === "snapshot" && isStrictDataRecord(value, ["kind", "revision", "result"])) {
        const snapshot = sanitizeWorkbenchHostedProjectResultStrict(value.result);
        if (snapshot === undefined) throw new Error("invalid-snapshot");
        result = snapshot;
      } else {
        if (!isStrictDataRecord(value, ["kind", "revision", "baseRevision", "view"]) || value.kind !== "delta" ||
            value.baseRevision !== revision || (value.revision as number) <= revision || !previous?.ok || !("view" in previous) ||
            !isStrictDataRecord(value.view, ["project", "observation", "commands", "initialSelectionKey", "projectSelection"]) ||
            !Array.isArray(value.view.commands)) throw new Error("invalid-delta-base");
        const oldTurns = previous.view.commands.flatMap(command => command.session?.turns ?? []);
        const commands = value.view.commands.map((command: unknown) => {
          if (!isRecord(command) || !isStrictDataRecord(command, Object.keys(command))) throw new Error("invalid-command");
          if (!Object.hasOwn(command, "session")) return command;
          const session = command.session;
          const sessionKeys = ["profile", "turns", "removalKey", "metadataKey", "archived", "selectionKey", "resumable"];
          if (isRecord(session) && Object.hasOwn(session, "context")) sessionKeys.push("context");
          if (!isStrictDataRecord(session, sessionKeys) || !Array.isArray(session.turns)) throw new Error("invalid-delta-session");
          const turns = session.turns.map((turn: unknown) => {
            if (isRecord(turn) && Object.hasOwn(turn, "reuse")) {
              if (!isStrictDataRecord(turn, ["reuse"]) || !Number.isSafeInteger(turn.reuse) || (turn.reuse as number) < 0 ||
                  (turn.reuse as number) >= oldTurns.length) throw new Error("invalid-turn-reference");
              return oldTurns[turn.reuse as number]!;
            }
            return sanitizeTurn(turn);
          });
          return { ...command, session: { ...session, turns, timeline: turns.flatMap(turn => turn.timeline) } };
        });
        result = sanitizeWorkbenchHostedProjectResult({ ok: true, view: { ...value.view, commands } });
        if (!result.ok || !("view" in result)) throw new Error("invalid-delta-view");
      }
      previous = result;
      revision = value.revision as number;
      return result;
    } catch {
      previous = undefined;
      revision = 0;
      return undefined;
    }
  };
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
    if (
      value.error.category === "project-directory-is-drive-root" &&
      value.error.message === WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL &&
      hasExactKeys(value, ["error", "ok"]) &&
      hasExactKeys(value.error, ["category", "message"])
    ) {
      return publicProjectDriveRootRefused();
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
  if ("failure" in value) return publicProjectOpenUnavailable();
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
    if ("failure" in value.error) {
      const failure = reconstructWorkbenchProjectPathFailure(value.error.failure);
      return hasExactKeys(value, ["error", "ok"]) &&
        hasExactKeys(value.error, ["category", "failure", "message"]) && failure !== undefined
        ? publicProjectOpenUnavailable(failure) : publicProjectOpenUnavailable();
    }
    return publicProjectOpenUnavailable();
  }
  if (
    value.ok === false &&
    isRecord(value.error) &&
    hasExactKeys(value, ["error", "ok"]) &&
    hasExactKeys(value.error, ["category", "message"]) &&
    value.error.category === "project-directory-is-drive-root" &&
    value.error.message === WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL
  ) {
    return publicOpenProjectDriveRootRefused();
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
    value.message === "Session Profile default was durably saved."
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
  endpointIds?: readonly WorkbenchRuntimeEndpointId[],
): WorkbenchPublicDirectSessionProfileResultFor<Request>;
export function sanitizeWorkbenchDirectSessionProfileResult(
  value: unknown,
  expectedRequest: WorkbenchDirectSessionProfileLoadRequest = Object.freeze({
    kind: "catalog-default",
  }),
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
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
      endpointIds,
    );
  } catch {
    return publicProfileUnavailable();
  }
}

function sanitizeWorkbenchDirectSessionProfileResultUnchecked(
  value: unknown,
  expectedRequest: WorkbenchDirectSessionProfileLoadRequest,
  endpointIds: readonly WorkbenchRuntimeEndpointId[],
): WorkbenchAnyPublicDirectSessionProfileResult {
  if (
    isStrictDataRecord(value, ["endpointDiscovery", "ok", "profile"]) &&
    value.ok === true
  ) {
    const endpointDiscovery = sanitizeEndpointDiscovery(
      value.endpointDiscovery,
      endpointIds,
    );
    const readyEndpointIds = endpointDiscovery.statuses
      .filter((status) => status.category === "catalog-ready")
      .map((status) => status.endpointId);
    if (readyEndpointIds.length === 0) {
      throw new Error("incoherent-direct-profile-success");
    }
    const profile = sanitizeDirectProfile(value.profile, expectedRequest, endpointIds);
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
  const endpointDiscovery = sanitizeEndpointDiscovery(
    value.endpointDiscovery,
    endpointIds,
  );
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
  endpointIds: readonly WorkbenchRuntimeEndpointId[],
): WorkbenchRuntimeEndpointDiscovery {
  if (
    !isStrictDataRecord(value, ["statuses"]) ||
    !isDenseDataArray(value.statuses) ||
    value.statuses.length !== endpointIds.length
  ) {
    throw new Error("invalid-endpoint-discovery");
  }
  const statuses = value.statuses;
  const categories: WorkbenchRuntimeEndpointDiscoveryCategory[] = [];
  for (const [index, endpointId] of endpointIds.entries()) {
    const status = statuses[index];
    if (
      !isStrictDataRecord(status, ["category", "endpointId"]) ||
      status.endpointId !== endpointId ||
      !isDiscoveryCategory(status.category)
    ) {
      throw new Error("invalid-endpoint-discovery-status");
    }
    categories.push(status.category);
  }
  return publicRuntimeEndpointDiscovery(
    endpointIds.map((endpointId, index) => ({
      endpointId,
      category: categories[index]!,
    })),
  );
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

function sanitizeDirectProfile(
  value: unknown,
  expectedRequest: WorkbenchDirectSessionProfileLoadRequest,
  endpointIds: readonly WorkbenchRuntimeEndpointId[],
): WorkbenchLoadedDirectSessionProfile {
  if (
    !hasExactDirectProfileKeys(value, expectedRequest.kind) ||
    typeof value.snapshotKey !== "string" ||
    !snapshotKeyPattern.test(value.snapshotKey) ||
    !isDenseDataArray(value.endpoints) ||
    value.endpoints.length === 0 ||
    value.endpoints.length > endpointIds.length ||
    (expectedRequest.kind === "continuation-session" &&
      value.endpoints.length !== 1)
  ) {
    throw new Error("invalid-direct-profile");
  }
  const endpointKeys = new Set<string>();
  const seenEndpointIds = new Set<WorkbenchRuntimeEndpointId>();
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
      !isRegisteredRuntimeEndpointId(endpoint.endpointId, endpointIds) ||
      seenEndpointIds.has(endpoint.endpointId) ||
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
    const endpointOrdinal = runtimeEndpointOrdinal(
      endpoint.endpointId,
      endpointIds,
    );
    if (endpointOrdinal <= previousEndpointOrdinal) {
      throw new Error("invalid-endpoint-order");
    }
    previousEndpointOrdinal = endpointOrdinal;
    seenEndpointIds.add(endpoint.endpointId);
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

export function sanitizeWorkbenchContinuationStop(value: unknown): import("./contract.ts").WorkbenchContinuationStop {
  if (!isStrictDataRecord(value, ["step", "limit", "reason"]) ||
      !Number.isSafeInteger(value.step) || !Number.isSafeInteger(value.limit) ||
      (value.step as number) < 1 || (value.step as number) > (value.limit as number) ||
      (value.limit as number) > 10 ||
      (value.reason !== "turn-not-completed" && value.reason !== "continuation-unavailable" &&
       value.reason !== "observation-unavailable" && value.reason !== "submission-unavailable")) {
    throw new Error("invalid-continuation-stop");
  }
  return Object.freeze({ step: value.step as number, limit: value.limit as number, reason: value.reason });
}

function sanitizeCommand(value: unknown): WorkbenchCommandView {
  const hasContinuationStop = isRecord(value) && Object.hasOwn(value, "continuationStop");
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
      ...(hasContinuationStop ? ["continuationStop"] : []),
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
  const continuationStop = hasContinuationStop ? sanitizeWorkbenchContinuationStop(value.continuationStop) : undefined;
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
    ...(continuationStop === undefined ? {} : { continuationStop }),
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

const immutableData = new WeakSet<object>();
function isImmutableData(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (immutableData.has(value)) return true;
  if (!Object.isFrozen(value) || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))) return false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) return false;
    if (descriptor.value !== null && typeof descriptor.value === "object" && !isImmutableData(descriptor.value)) return false;
  }
  immutableData.add(value);
  return true;
}
const sanitizedTurns = new WeakMap<object, WorkbenchTurnView>();
const sanitizedEvents = new WeakMap<object, WorkbenchTimelineEvent>();
function sanitizeTurn(value: unknown): WorkbenchTurnView {
  if (value !== null && typeof value === "object") {
    const cached = sanitizedTurns.get(value);
    if (cached !== undefined) return cached;
  }
  const result = sanitizeTurnUncached(value);
  if (isImmutableData(value)) sanitizedTurns.set(value, result);
  sanitizedTurns.set(result, result);
  return result;
}

function sanitizeTurnUncached(value: unknown) {
  const hasRecovery =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, "recovery");
  if (
    !isStrictDataRecord(value, [
      "profile",
      "timeline",
      ...(hasRecovery ? ["recovery"] : []),
    ]) ||
    !Array.isArray(value.timeline)
  ) {
    throw new Error("invalid-turn");
  }
  let recovery: WorkbenchTurnView["recovery"];
  if (hasRecovery) {
    const raw = value.recovery;
    if (isStrictDataRecord(raw, ["resume"]) && raw.resume === "confirmed") {
      recovery = { resume: "confirmed" };
    } else if (isStrictDataRecord(raw, ["resume", "reason"]) && raw.resume === "unconfirmed" &&
      (isWorkbenchRuntimeFailureCategory(raw.reason) || raw.reason === "runtime-not-located" ||
        raw.reason === "binding-drift" || raw.reason === "session-reference-unavailable" ||
        raw.reason === "authentication-changed" || raw.reason === "channel-closed" ||
        raw.reason === "resume-timeout" || raw.reason === "resume-unconfirmed")) {
      recovery = { resume: "unconfirmed", reason: raw.reason };
    } else {
      throw new Error("invalid-turn-recovery");
    }
  }
  return deepFreeze({
    ...(recovery === undefined ? {} : { recovery }),
    profile: sanitizeProfileProjection(value.profile),
    timeline: value.timeline.map(sanitizeEvent),
  });
}

function samePublicValue(left: unknown, right: unknown): boolean {
  if (left === right || (Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]))) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeEvent(value: unknown): WorkbenchTimelineEvent {
  if (value !== null && typeof value === "object") {
    const cached = sanitizedEvents.get(value);
    if (cached !== undefined) return cached;
  }
  const result = sanitizeEventUncached(value);
  if (isImmutableData(value)) sanitizedEvents.set(value, result);
  sanitizedEvents.set(result, result);
  return result;
}

function sanitizeEventUncached(value: unknown): WorkbenchTimelineEvent {
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
    case "reasoning":
      if (!hasExactKeys(value, ["kind", "text"])) throw new Error("invalid-event");
      return Object.freeze({
        kind: "reasoning",
        text: sanitizeDisplayString(requireString(value.text)),
      });
    case "progress": {
      const hasTool = Object.hasOwn(value, "tool");
      if (
        !hasExactKeys(
          value,
          hasTool ? ["activity", "kind", "tool"] : ["activity", "kind"],
        ) ||
        (value.activity !== "thinking" &&
          value.activity !== "tool" &&
          value.activity !== "retrying" &&
          value.activity !== "rate-limited" &&
          value.activity !== "status")
      ) {
        throw new Error("invalid-event");
      }
      return Object.freeze({
        kind: "progress",
        activity: value.activity,
        ...(hasTool ? { tool: sanitizeToolActivity(value.tool) } : {}),
      });
    }
    case "turn-completed": {
      const hasSuggestions = Object.prototype.hasOwnProperty.call(
        value,
        "suggestions",
      );
      if (
        !isStrictDataRecordWithAllowedKeys(value, [
          "kind",
          "status",
          ...(hasSuggestions ? ["suggestions"] : []),
        ]) ||
        value.status !== "completed" ||
        (hasSuggestions &&
          (!isDenseDataArray(value.suggestions) ||
            value.suggestions.length === 0 ||
            !value.suggestions.every(isValidWorkbenchDirectInput)))
      ) {
        throw new Error("invalid-event");
      }
      return Object.freeze({
        kind: "turn-completed",
        status: "completed",
        ...(hasSuggestions
          ? { suggestions: Object.freeze([...(value.suggestions as string[])]) }
          : {}),
      });
    }
    case "turn-interrupted":
      if (
        !hasExactKeys(value, ["kind", "status"]) ||
        value.status !== "interrupted"
      ) {
        throw new Error("invalid-event");
      }
      return Object.freeze({ kind: "turn-interrupted", status: "interrupted" });
    case "turn-paused":
      if (!hasExactKeys(value, ["kind", "reason"]) || value.reason !== "quota-exhausted") throw new Error("invalid-event");
      return Object.freeze({ kind: "turn-paused", reason: "quota-exhausted" });
    case "failed":
      if (hasExactKeys(value, ["kind"])) return Object.freeze({ kind: "failed" });
      if (
        !hasExactKeys(value, ["category", "kind"]) ||
        !isWorkbenchRuntimeFailureCategory(value.category)
      ) {
        throw new Error("invalid-event");
      }
      return Object.freeze({ kind: "failed", category: value.category });
    default:
      throw new Error("invalid-event");
  }
}

const maximumToolActivitySourceTypeCharacters = 240;

function sanitizeToolActivity(value: unknown): WorkbenchToolActivity {
  if (!isRecord(value)) throw new Error("invalid-tool-activity");
  const hasFileChanges = Object.hasOwn(value, "fileChanges");
  const hasParameter = Object.hasOwn(value, "parameter");
  const hasSourceType = Object.hasOwn(value, "sourceType");
  if (
    !hasExactKeys(value, [
      ...(hasFileChanges ? ["fileChanges"] : []),
      "name",
      ...(hasParameter ? ["parameter"] : []),
      ...(hasSourceType ? ["sourceType"] : []),
      "type",
    ]) ||
    (value.type !== "tool_use" &&
      value.type !== "commandExecution" &&
      value.type !== "fileChange" &&
      value.type !== "webSearch" &&
      value.type !== "unknown") ||
    typeof value.name !== "string" ||
    (value.type === "unknown"
      ? !isSafeToolActivitySourceType(value.sourceType)
      : hasSourceType) ||
    (hasFileChanges && value.type !== "fileChange")
  ) {
    throw new Error("invalid-tool-activity");
  }
  return Object.freeze({
    type: value.type,
    name: value.name,
    ...(hasFileChanges
      ? { fileChanges: sanitizeFileChangeSummary(value.fileChanges) }
      : {}),
    ...(hasParameter
      ? { parameter: sanitizeToolActivityParameter(value.parameter) }
      : {}),
    ...(hasSourceType ? { sourceType: value.sourceType as string } : {}),
  });
}

function sanitizeFileChangeSummary(
  value: unknown,
): NonNullable<WorkbenchToolActivity["fileChanges"]> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["files", "totalFiles", "truncated"]) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 3 ||
    !Number.isSafeInteger(value.totalFiles) ||
    (value.totalFiles as number) < value.files.length ||
    value.truncated !== ((value.totalFiles as number) > value.files.length)
  ) {
    throw new Error("invalid-file-change-summary");
  }
  return Object.freeze({
    files: Object.freeze(value.files.map(sanitizeChangedFileSummary)),
    totalFiles: value.totalFiles as number,
    truncated: value.truncated,
  });
}

function sanitizeChangedFileSummary(
  value: unknown,
): NonNullable<WorkbenchToolActivity["fileChanges"]>["files"][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      Object.hasOwn(value, "lines")
        ? ["lines", "path", "truncated"]
        : ["path", "truncated"],
    ) ||
    typeof value.path !== "string" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("invalid-changed-file-summary");
  }
  return Object.freeze({
    path: value.path,
    truncated: value.truncated,
    ...(Object.hasOwn(value, "lines")
      ? { lines: sanitizeFileChangeLineSummary(value.lines) }
      : {}),
  });
}

function sanitizeFileChangeLineSummary(
  value: unknown,
): { readonly additions: number; readonly deletions: number } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["additions", "deletions"]) ||
    !Number.isSafeInteger(value.additions) ||
    (value.additions as number) < 0 ||
    !Number.isSafeInteger(value.deletions) ||
    (value.deletions as number) < 0
  ) {
    throw new Error("invalid-file-change-line-summary");
  }
  return Object.freeze({
    additions: value.additions as number,
    deletions: value.deletions as number,
  });
}

function isSafeToolActivitySourceType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumToolActivitySourceTypeCharacters &&
    !value.includes("\0")
  );
}

function sanitizeToolActivityParameter(
  value: unknown,
): NonNullable<WorkbenchToolActivity["parameter"]> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "truncated", "value"]) ||
    (value.kind !== "command" && value.kind !== "path") ||
    typeof value.value !== "string" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("invalid-tool-activity-parameter");
  }
  return Object.freeze({
    kind: value.kind,
    value: value.value,
    truncated: value.truncated,
  });
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

/** Exact public/stored shape. Vendor tolerance belongs in the runtime parser. */
export function reconstructWorkbenchSubscriptionUsage(value: unknown): WorkbenchSubscriptionUsageObservation | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["five_hour", "observedAt", "seven_day"]) ||
        !Number.isSafeInteger(value.observedAt) || (value.observedAt as number) <= 0 ||
        (value.observedAt as number) > 8_640_000_000_000_000) return undefined;
    const window = (input: unknown) => {
      if (input === null) return null;
      if (!isRecord(input) || !hasExactKeys(input, ["resetsAt", "utilization"]) ||
          typeof input.utilization !== "number" || !Number.isFinite(input.utilization) ||
          input.utilization < 0 || input.utilization > 1 ||
          !Number.isSafeInteger(input.resetsAt) || (input.resetsAt as number) <= 0 ||
          (input.resetsAt as number) > 8_640_000_000_000) return undefined;
      return Object.freeze({ utilization: input.utilization, resetsAt: input.resetsAt as number });
    };
    const five_hour = window(value.five_hour);
    const seven_day = window(value.seven_day);
    if (five_hour === undefined || seven_day === undefined) return undefined;
    return Object.freeze({ five_hour, seven_day, observedAt: value.observedAt as number });
  } catch { return undefined; }
}

export function sanitizeWorkbenchSubscriptionUsageResult(value: unknown): WorkbenchSubscriptionUsageResult {
  try {
    if (isRecord(value) && value.ok === true && hasExactKeys(value, ["observation", "ok"])) {
      const observation = value.observation === null ? null : reconstructWorkbenchSubscriptionUsage(value.observation);
      if (observation !== undefined) return Object.freeze({ ok: true, observation });
    }
  } catch { /* Unavailable, not a fabricated zero-usage observation. */ }
  return Object.freeze({ ok: false });
}

const projectPathFailureReasons: readonly WorkbenchProjectPathFailureReason[] = [
  "selected-file", "directory-missing", "destination-exists", "parent-directory-missing",
  "parent-is-file", "parent-is-alias", "parent-is-reparse", "parent-unavailable", "create-denied", "unknown",
];

export function reconstructWorkbenchProjectPathFailure(value: unknown): WorkbenchProjectPathFailure | undefined {
  try {
    if (!isRecord(value) || !hasExactKeys(value, ["reason", "targetPath"]) ||
        !projectPathFailureReasons.includes(value.reason as WorkbenchProjectPathFailureReason) ||
        typeof value.targetPath !== "string" || value.targetPath.length === 0 || value.targetPath.length > 32_768 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(value.targetPath)) return undefined;
    // Electron's Windows chooser supplies drive-absolute or UNC paths. Keep
    // the chosen spelling; do not resolve relative input or treat URLs as paths.
    const path = value.targetPath.replaceAll("\\", "/");
    if (!/^[a-zA-Z]:\//u.test(path) && !/^\/\/[^/]+\/[^/]+(?:\/|$)/u.test(path)) return undefined;
    return Object.freeze({ reason: value.reason as WorkbenchProjectPathFailureReason, targetPath: value.targetPath });
  } catch { return undefined; }
}
