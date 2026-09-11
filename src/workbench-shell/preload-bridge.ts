import { WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL, WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL, type WorkbenchSubscriptionUsageResult } from "./contract.ts";
import { sanitizeWorkbenchSubscriptionUsageResult } from "./result-sanitizer.ts";
import {
  WORKBENCH_READ_USER_INPUT_CHANNEL,
  WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
  WORKBENCH_USER_INPUT_CHANGED_CHANNEL,
  type WorkbenchUserInputReadRequest,
  type WorkbenchUserInputResponse,
  type WorkbenchUserInputResult,
  type WorkbenchUserInputResponseResult,
  WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_CREATE_PROJECT_CHANNEL,
  WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
  WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_DISPOSE_CHANNEL,
  WORKBENCH_ENDPOINT_KEY_CHANNELS,
  WORKBENCH_ENDPOINT_KEY_ENDPOINT_IDS,
  WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
  WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL,
  WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL,
  WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL,
  WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL,
  publicRuntimeExecutableUnavailable,
  WORKBENCH_LOAD_PROFILE_CHANNEL,
  WORKBENCH_INTERRUPT_CHANNEL,
  WORKBENCH_STEER_CHANNEL,
  WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
  WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_OBSERVE_CHANNEL,
  WORKBENCH_OPEN_PROJECT_CHANNEL,
  WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
  WORKBENCH_PROJECT_VIEW_CHANNEL,
  WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  WORKBENCH_REMOVE_PROJECT_CHANNEL,
  WORKBENCH_REMOVE_SESSION_CHANNEL,
  WORKBENCH_SELECT_PROJECT_CHANNEL,
  WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
  WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
  WORKBENCH_SUBMIT_CHANNEL,
  WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  publicInvalidProfileDefaultSelection,
  publicAppearancePreferenceUnavailable,
  publicClaudePermissionHandlingUnavailable,
  publicEndpointPreferenceUnavailable,
  publicEndpointKeyUnavailable,
  publicEndpointKeyInvalidValue,
  publicEndpointCatalogFreshnessUnavailable,
  publicCreateProjectResult,
  publicInvalidProfileSelection,
  publicInvalidSubmission,
  publicInterruptUnavailable,
  publicInvalidInterrupt,
  publicInvalidSteer,
  publicSteerUnavailable,
  publicContinuationUnavailable,
  publicHostedProjectFailure,
  publicInvalidProjectSelection,
  publicProjectOpenUnavailable,
  publicProfileUnavailable,
  publicPreferenceUnavailable,
  publicProjectSwitchUnavailable,
  publicUnavailableSubmission,
  type WorkbenchDirectInputRequest,
  type WorkbenchAppearancePreference,
  type WorkbenchAppearancePreferenceLoadResult,
  type WorkbenchAppearancePreferenceSaveResult,
  type WorkbenchClaudePermissionHandling,
  type WorkbenchClaudePermissionHandlingLoadResult,
  type WorkbenchRuntimeExecutableSaveRequest,
  type WorkbenchRuntimeExecutableSaveResult,
  type WorkbenchRuntimeInstallRequest,
  type WorkbenchRuntimeInstallResult,
  type WorkbenchRuntimeExecutablesLoadResult,
  type WorkbenchClaudePermissionHandlingSaveResult,
  type WorkbenchFamilyEndpointPreference,
  type WorkbenchEndpointPreferenceLoadResult,
  type WorkbenchEndpointPreferenceSaveResult,
  type WorkbenchCreateProjectResult,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchEndpointKeyChannel,
  type WorkbenchEndpointKeyEndpointId,
  type WorkbenchEndpointKeyRemoveResult,
  type WorkbenchEndpointKeyRevealResult,
  type WorkbenchEndpointKeySaveResult,
  type WorkbenchEndpointKeyStatusResult,
  type WorkbenchEndpointProbeResult,
  type WorkbenchEndpointCatalogFreshnessResult,
  type WorkbenchPublicDirectSessionProfileResult,
  type WorkbenchPublicDirectSessionProfileResultFor,
  type WorkbenchInterruptRequest,
  type WorkbenchInterruptResult,
  type WorkbenchSteerRequest,
  type WorkbenchSteerResult,
  type WorkbenchOpenProjectResult,
  type WorkbenchProjectHistoryAdoptionRequest,
  type WorkbenchProjectHistoryAdoptionResult,
  type WorkbenchProjectHistoryDiscoveryResult,
  type WorkbenchProjectHistoryHideRequest,
  type WorkbenchProjectHistoryHideResult,
  type WorkbenchProjectSelectionRequest,
  type WorkbenchProjectSelectionResult,
  type WorkbenchProjectRemovalResult,
  type WorkbenchProjectTransfer,
  type WorkbenchRendererBridge,
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchSubmissionResult,
  type WorkbenchSubscriptionAuthenticationAction,
  type WorkbenchSubscriptionAuthenticationPublicResponse,
} from "./contract.ts";
import {
  reconstructWorkbenchAppearancePreference,
  reconstructWorkbenchClaudePermissionHandling,
  reconstructWorkbenchFamilyEndpointPreference,
  reconstructWorkbenchDirectInputRequest,
  reconstructWorkbenchDirectSessionProfileDefaultRequest,
  reconstructWorkbenchDirectSessionProfileLoadRequest,
  reconstructWorkbenchInterruptRequest,
  reconstructWorkbenchSteerRequest,
  reconstructWorkbenchProjectHistoryAdoptionRequest,
  reconstructWorkbenchProjectHistoryHideRequest,
  reconstructWorkbenchProjectSelectionRequest,
  reconstructWorkbenchSessionMetadataMutationRequest,
  reconstructWorkbenchSessionRemovalRequest,
  reconstructWorkbenchEndpointKeySaveRequest,
  sanitizeWorkbenchEndpointKeyRemoveResult,
  sanitizeWorkbenchEndpointKeyRevealResult,
  sanitizeWorkbenchEndpointKeySaveResult,
  sanitizeWorkbenchEndpointKeyStatusResult,
  sanitizeWorkbenchEndpointProbeResult,
  sanitizeWorkbenchEndpointCatalogFreshnessResult,
  sanitizeWorkbenchProjectHistoryAdoptionResult,
  sanitizeWorkbenchProjectHistoryDiscoveryResult,
  sanitizeWorkbenchProjectHistoryHideResult,
  sanitizeWorkbenchDirectSessionProfileDefaultResult,
  sanitizeWorkbenchCreateProjectResult,
  sanitizeWorkbenchAppearancePreferenceLoadResult,
  sanitizeWorkbenchAppearancePreferenceSaveResult,
  sanitizeWorkbenchClaudePermissionHandlingLoadResult,
  sanitizeWorkbenchRuntimeExecutablesLoadResult,
  sanitizeWorkbenchRuntimeExecutableSaveResult,
  reconstructWorkbenchRuntimeExecutableSaveRequest,
  reconstructWorkbenchRuntimeInstallRequest,
  sanitizeWorkbenchRuntimeInstallResult,
  sanitizeWorkbenchClaudePermissionHandlingSaveResult,
  sanitizeWorkbenchEndpointPreferenceLoadResult,
  sanitizeWorkbenchEndpointPreferenceSaveResult,
  sanitizeWorkbenchDirectSessionProfileResult,
  createWorkbenchProjectTransferSanitizer,
  sanitizeWorkbenchInterruptResult,
  sanitizeWorkbenchSteerResult,
  sanitizeWorkbenchOpenProjectResult,
  sanitizeWorkbenchProjectSelectionResult,
  sanitizeWorkbenchProjectRemovalResult,
  sanitizeWorkbenchSessionMetadataMutationResult,
  sanitizeWorkbenchSessionRemovalResult,
  sanitizeWorkbenchSubmissionResult,
  sanitizeSubscriptionAuthenticationPublicRequest,
  sanitizeSubscriptionAuthenticationPublicResponse,
} from "./result-sanitizer.ts";
import { WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS } from "./subscription-authentication-coordinator.ts";
import {
  WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
  createWorkbenchClipboardPreloadBridge,
} from "./clipboard-bridge.ts";
import {
  WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
  createWorkbenchNotificationPreloadBridge,
} from "./notification-bridge.ts";
import {
  WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
  type HistoryRecoveryActionResult,
  type HistoryRecoveryBrowseRequest,
  type HistoryRecoveryBrowseResult,
  type HistoryRecoveryCancelRequest,
  type HistoryRecoveryCancelResult,
  type HistoryRecoveryPerformRequest,
  type HistoryRecoverySnapshotRequest,
  type HistoryRecoverySnapshotResult,
} from "./history-recovery-contract.ts";
import {
  WORKBENCH_CHECK_CLI_UPDATES_CHANNEL,
  WORKBENCH_RELAUNCH_APP_CHANNEL,
  WORKBENCH_RUN_CLI_UPDATE_CHANNEL,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRelaunchUnavailable,
  publicCliUpdateRunUnavailable,
  type WorkbenchCliUpdateBridge,
  type WorkbenchCliUpdateCheckResult,
  type WorkbenchCliUpdateCliId,
  type WorkbenchCliUpdateRelaunchResult,
  type WorkbenchCliUpdateRunResult,
} from "./cli-update-contract.ts";
import {
  reconstructWorkbenchCliUpdateRunRequest,
  sanitizeWorkbenchCliUpdateCheckResult,
  sanitizeWorkbenchCliUpdateRelaunchResult,
  sanitizeWorkbenchCliUpdateRunResult,
} from "./cli-update-sanitizer.ts";
import {
  failedAction,
  reconstructHistoryRecoveryBrowseRequest,
  reconstructHistoryRecoveryCancelRequest,
  reconstructHistoryRecoveryPerformRequest,
  reconstructHistoryRecoverySnapshotRequest,
  sanitizeHistoryRecoveryActionResult,
  sanitizeHistoryRecoveryBrowseResult,
  sanitizeHistoryRecoveryCancelResult,
  sanitizeHistoryRecoverySnapshotResult,
  unavailableBrowse,
  unavailableSnapshot,
} from "./history-recovery-sanitizer.ts";

import { reconstructUserInputRead, reconstructUserInputResponse, sanitizeUserInputResult, sanitizeUserInputResponseResult } from "./user-input-sanitizer.ts";

type ProjectViewIpcListener = (event: unknown, value: unknown) => void;

export interface FixedProjectViewIpc {
  on(
    channel: typeof WORKBENCH_PROJECT_VIEW_CHANNEL | typeof WORKBENCH_USER_INPUT_CHANGED_CHANNEL | typeof WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL,
    listener: ProjectViewIpcListener,
  ): void;
  removeListener(
    channel: typeof WORKBENCH_PROJECT_VIEW_CHANNEL | typeof WORKBENCH_USER_INPUT_CHANGED_CHANNEL | typeof WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL,
    listener: ProjectViewIpcListener,
  ): void;
  send(
    channel:
      | typeof WORKBENCH_OBSERVE_CHANNEL
      | typeof WORKBENCH_DISPOSE_CHANNEL,
  ): void;
  invoke(
    channel:
      | typeof WORKBENCH_READ_USER_INPUT_CHANNEL
      | typeof WORKBENCH_RESPOND_USER_INPUT_CHANNEL
      | typeof WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_CREATE_PROJECT_CHANNEL
      | typeof WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL
      | typeof WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_CHECK_CLI_UPDATES_CHANNEL
      | typeof WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL
      | typeof WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL
      | typeof WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL
      | typeof WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL
      | typeof WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL
      | WorkbenchEndpointKeyChannel
      | typeof WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL
      | typeof WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL
      | typeof WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL
      | typeof WORKBENCH_INTERRUPT_CHANNEL
      | typeof WORKBENCH_STEER_CHANNEL
      | typeof WORKBENCH_LOAD_PROFILE_CHANNEL
      | typeof WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL
      | typeof WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL
      | typeof WORKBENCH_OPEN_PROJECT_CHANNEL
      | typeof WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL
      | typeof WORKBENCH_REMOVE_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_SESSION_CHANNEL
      | typeof WORKBENCH_RUN_CLI_UPDATE_CHANNEL
      | typeof WORKBENCH_RELAUNCH_APP_CHANNEL
      | typeof WORKBENCH_SELECT_PROJECT_CHANNEL
      | typeof WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL
      | typeof WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL
      | typeof WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL
      | typeof WORKBENCH_SUBMIT_CHANNEL
      | typeof WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL
      | typeof WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    ...values: unknown[]
  ): Promise<unknown>;
}

type ActivePreloadObservation = {
  active: boolean;
  readonly handler: ProjectViewIpcListener;
  readonly dispose: () => void;
};

const unavailableProjectTransfer = (): WorkbenchProjectTransfer =>
  Object.freeze({
    kind: "snapshot",
    revision: 1,
    result: publicHostedProjectFailure(),
  });

export type WorkbenchProjectTransferListener = (
  transfer: WorkbenchProjectTransfer,
) => void;

export type WorkbenchRendererTransferBridge = Omit<
  WorkbenchRendererBridge,
  "observeProject"
> & {
  observeProject(listener: WorkbenchProjectTransferListener): () => void;
};

export type WorkbenchPreloadBridge = WorkbenchRendererTransferBridge &
  Required<
    Pick<
      WorkbenchRendererBridge,
      | "adoptProjectHistory"
      | "discoverProjectHistories"
      | "hideProjectHistory"
      | "inspectSubscriptionAuthentication"
      | "prepareSubscriptionAuthentication"
      | "beginSubscriptionAuthentication"
      | "cancelPreparedSubscriptionAuthentication"
      | "loadEndpointKeyStatus"
      | "saveEndpointKey"
      | "removeEndpointKey"
      | "revealEndpointKey"
      | "probeEndpointKey"
      | "loadEndpointCatalogFreshness"
      | "refreshEndpointCatalogFreshness"
      | "getSnapshot"
      | "browse"
      | "perform"
      | "cancel"
      | "notifyTurnCompleted"
      | "writeClipboardText"
    >
  > &
  // CLI update surface (ticket 18): declared on its own contract module —
  // this lane's territory does not open the central renderer-bridge
  // interface — so the preload bridge carries it as an intersection and
  // Settings narrows the renderer bridge back to it.
  WorkbenchCliUpdateBridge;

export function createWorkbenchPreloadBridge(
  ipc: FixedProjectViewIpc,
): WorkbenchPreloadBridge {
  let activeObservation: ActivePreloadObservation | undefined;
  let recoverySnapshotKey: string | undefined;
  let recoveryLibraryKey: string | undefined;
  const recoverySources = new Map<
    string,
    { readonly snapshotKey: string; readonly action: "none" | "preserve" | "acknowledge" }
  >();
  const recoveryGenerations = new Map<string, string>();
  const recoveryProjects = new Map<string, string>();
  const recoverySessions = new Map<string, string>();
  const activePreparationKeys = new Set<string>();
  const endpointSelectionKeys = new Set<string>(
    Object.values(WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS),
  );
  const authenticationKeyAuthority = Object.freeze({
    isEndpointSelectionKey: (value: string) => endpointSelectionKeys.has(value),
    isPreparationKey: (value: string) => activePreparationKeys.has(value),
  });
  const provisionalAuthenticationKeyAuthority = Object.freeze({
    isEndpointSelectionKey: (value: string) => endpointSelectionKeys.has(value),
    isPreparationKey: (_value: string) => true,
  });

  return Object.freeze({
    ...createWorkbenchClipboardPreloadBridge(ipc),
    ...createWorkbenchNotificationPreloadBridge(ipc),
    observeSubscriptionUsage(listener: (result: WorkbenchSubscriptionUsageResult) => void): () => void {
      let active = true;
      let pushed = false;
      const deliver = (value: unknown) => {
        if (active) listener(sanitizeWorkbenchSubscriptionUsageResult(value));
      };
      const handler: ProjectViewIpcListener = (_event, value) => { pushed = true; deliver(value); };
      ipc.on(WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL, handler);
      // Subscribe before the single disk read. A later push wins over an
      // in-flight initial read, including a stale read failure.
      void ipc.invoke(WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL).then(
        value => { if (!pushed) deliver(value); },
        () => { if (!pushed) deliver({ ok: false }); },
      );
      return () => {
        active = false;
        ipc.removeListener(WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL, handler);
      };
    },
    observeProject(listener: WorkbenchProjectTransferListener): () => void {
      activeObservation?.dispose();
      let record!: ActivePreloadObservation;
      const dispose = () => {
        if (!record.active) return;
        record.active = false;
        if (activeObservation === record) activeObservation = undefined;
        try {
          ipc.removeListener(WORKBENCH_PROJECT_VIEW_CHANNEL, record.handler);
        } catch {
          // The renderer Interface remains fixed if transport teardown fails.
        }
        try {
          ipc.send(WORKBENCH_DISPOSE_CHANNEL);
        } catch {
          // Disposal is idempotent and never rejects into renderer code.
        }
      };
      const sanitize = createWorkbenchProjectTransferSanitizer();
      let recovering = false;
      const handler: ProjectViewIpcListener = (_event, value) => {
        if (!record.active || activeObservation !== record) return;
        const transfer = sanitize(value);
        if (transfer === undefined) {
          console.warn("Live Project transfer mismatch; requesting a full snapshot.");
          try {
            listener(unavailableProjectTransfer());
            if (!recovering) {
              recovering = true;
              ipc.send(WORKBENCH_OBSERVE_CHANNEL);
            }
          } catch { dispose(); }
          return;
        }
        recovering = false;
        try {
          listener(transfer);
        } catch {
          dispose();
          return;
        }
      };
      record = { active: true, handler, dispose };
      try {
        ipc.on(WORKBENCH_PROJECT_VIEW_CHANNEL, handler);
        activeObservation = record;
        ipc.send(WORKBENCH_OBSERVE_CHANNEL);
      } catch {
        dispose();
        try {
          listener(unavailableProjectTransfer());
        } catch {
          // A renderer listener cannot create an unhandled transport failure.
        }
      }
      return dispose;
    },
    async getSnapshot(
      request: HistoryRecoverySnapshotRequest,
    ): Promise<HistoryRecoverySnapshotResult> {
      if (arguments.length !== 1) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      const reconstructed = reconstructHistoryRecoverySnapshotRequest(request);
      if (!reconstructed.ok) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      let result: HistoryRecoverySnapshotResult;
      try {
        result = sanitizeHistoryRecoverySnapshotResult(
          await ipc.invoke(
            WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
            reconstructed.value,
          ),
          reconstructed.value.requestKey,
        );
      } catch {
        result = unavailableSnapshot(
          reconstructed.value.requestKey,
          "bridge-closed",
        );
      }
      if (result.status === "ready" || result.status === "partial") {
        replaceRecoveryAuthority(result.snapshot);
      }
      return result;
    },
    async browse(
      request: HistoryRecoveryBrowseRequest,
    ): Promise<HistoryRecoveryBrowseResult> {
      if (arguments.length !== 1) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      const reconstructed = reconstructHistoryRecoveryBrowseRequest(request);
      if (!reconstructed.ok || !ownsRecoveryBrowse(reconstructed.value)) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      let result: HistoryRecoveryBrowseResult;
      try {
        result = sanitizeHistoryRecoveryBrowseResult(
          await ipc.invoke(
            WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
            reconstructed.value,
          ),
          reconstructed.value,
        );
      } catch {
        result = unavailableBrowse(
          reconstructed.value.requestKey,
          "bridge-closed",
        );
      }
      if (result.status === "ready") retainRecoveryBrowseAuthority(result);
      return result;
    },
    async perform(
      request: HistoryRecoveryPerformRequest,
    ): Promise<HistoryRecoveryActionResult> {
      if (arguments.length !== 1) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      const reconstructed = reconstructHistoryRecoveryPerformRequest(request);
      if (!reconstructed.ok || !ownsRecoveryAction(reconstructed.value)) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      let result: HistoryRecoveryActionResult;
      try {
        result = sanitizeHistoryRecoveryActionResult(
          await ipc.invoke(
            WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
            reconstructed.value,
          ),
          reconstructed.value,
        );
      } catch {
        result = failedAction(reconstructed.value, "bridge-closed");
      }
      if (
        (result.action === "preserve" &&
          (result.status === "preserved" ||
            result.status === "already-preserved")) ||
        (result.action === "acknowledge" &&
          (result.status === "acknowledged" ||
            result.status === "already-acknowledged"))
      ) {
        replaceRecoveryAuthority(result.snapshot);
        if (result.action === "preserve") {
          recoveryGenerations.set(
            result.generation.generationKey,
            result.snapshot.snapshotKey,
          );
        }
      }
      return result;
    },
    async cancel(
      request: HistoryRecoveryCancelRequest,
    ): Promise<HistoryRecoveryCancelResult> {
      if (arguments.length !== 1) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      const reconstructed = reconstructHistoryRecoveryCancelRequest(request);
      if (!reconstructed.ok) {
        throw new TypeError("history-recovery-boundary-rejected");
      }
      try {
        return sanitizeHistoryRecoveryCancelResult(
          await ipc.invoke(
            WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
            reconstructed.value,
          ),
          reconstructed.value,
        );
      } catch {
        return Object.freeze({
          version: 1 as const,
          kind: "cancel" as const,
          requestKey: reconstructed.value.requestKey,
          operationKey: reconstructed.value.operationKey,
          status: "bridge-closed" as const,
        });
      }
    },
    async inspectSubscriptionAuthentication(
      request: Readonly<{ endpointSelectionKey: string }>,
    ): Promise<WorkbenchSubscriptionAuthenticationPublicResponse> {
      const reconstructed = sanitizeSubscriptionAuthenticationPublicRequest(
        request,
        authenticationKeyAuthority,
      );
      if (!reconstructed.accepted || !("endpointSelectionKey" in reconstructed.value) || "action" in reconstructed.value) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      return invokeAuthentication(
        WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        reconstructed.value,
      );
    },
    async prepareSubscriptionAuthentication(request: Readonly<{
      endpointSelectionKey: string;
      action: WorkbenchSubscriptionAuthenticationAction;
    }>): Promise<WorkbenchSubscriptionAuthenticationPublicResponse> {
      const reconstructed = sanitizeSubscriptionAuthenticationPublicRequest(
        request,
        authenticationKeyAuthority,
      );
      if (!reconstructed.accepted || !("endpointSelectionKey" in reconstructed.value) || !("action" in reconstructed.value)) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      const raw = await ipc.invoke(
        WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        reconstructed.value,
      );
      const provisional = sanitizeSubscriptionAuthenticationPublicResponse(
        raw,
        provisionalAuthenticationKeyAuthority,
      );
      if (!provisional.accepted) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      if (
        provisional.value.kind === "ready" ||
        provisional.value.kind === "confirmation-required"
      ) {
        activePreparationKeys.add(provisional.value.preparationKey);
      }
      return strictAuthenticationResponse(provisional.value);
    },
    async beginSubscriptionAuthentication(
      request: Readonly<{ preparationKey: string }>,
    ): Promise<WorkbenchSubscriptionAuthenticationPublicResponse> {
      const reconstructed = sanitizeSubscriptionAuthenticationPublicRequest(
        request,
        authenticationKeyAuthority,
      );
      if (!reconstructed.accepted || !("preparationKey" in reconstructed.value)) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      activePreparationKeys.delete(reconstructed.value.preparationKey);
      return invokeAuthentication(
        WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        reconstructed.value,
      );
    },
    async cancelPreparedSubscriptionAuthentication(
      request: Readonly<{ preparationKey: string }>,
    ): Promise<void> {
      const reconstructed = sanitizeSubscriptionAuthenticationPublicRequest(
        request,
        authenticationKeyAuthority,
      );
      if (!reconstructed.accepted || !("preparationKey" in reconstructed.value)) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
      activePreparationKeys.delete(reconstructed.value.preparationKey);
      const result = await ipc.invoke(
        WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
        reconstructed.value,
      );
      if (result !== undefined) {
        throw new TypeError("subscription-authentication-boundary-rejected");
      }
    },
    async loadAppearancePreference(): Promise<WorkbenchAppearancePreferenceLoadResult> {
      try {
        return sanitizeWorkbenchAppearancePreferenceLoadResult(
          await ipc.invoke(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL),
        );
      } catch {
        return publicAppearancePreferenceUnavailable();
      }
    },
    async saveAppearancePreference(
      preference: WorkbenchAppearancePreference,
    ): Promise<WorkbenchAppearancePreferenceSaveResult> {
      const reconstructed =
        reconstructWorkbenchAppearancePreference(preference);
      if (!reconstructed.ok) return publicAppearancePreferenceUnavailable();
      try {
        return sanitizeWorkbenchAppearancePreferenceSaveResult(
          await ipc.invoke(
            WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
            reconstructed.preference,
          ),
        );
      } catch {
        return publicAppearancePreferenceUnavailable();
      }
    },
    async loadClaudePermissionHandling(): Promise<WorkbenchClaudePermissionHandlingLoadResult> {
      try {
        return sanitizeWorkbenchClaudePermissionHandlingLoadResult(
          await ipc.invoke(WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL),
        );
      } catch {
        return publicClaudePermissionHandlingUnavailable();
      }
    },
    async saveClaudePermissionHandling(
      permissionHandling: WorkbenchClaudePermissionHandling,
    ): Promise<WorkbenchClaudePermissionHandlingSaveResult> {
      const reconstructed =
        reconstructWorkbenchClaudePermissionHandling(permissionHandling);
      if (!reconstructed.ok) {
        return publicClaudePermissionHandlingUnavailable();
      }
      try {
        return sanitizeWorkbenchClaudePermissionHandlingSaveResult(
          await ipc.invoke(
            WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
            reconstructed.permissionHandling,
          ),
        );
      } catch {
        return publicClaudePermissionHandlingUnavailable();
      }
    },
    async loadEndpointPreferences(): Promise<WorkbenchEndpointPreferenceLoadResult> {
      try {
        return sanitizeWorkbenchEndpointPreferenceLoadResult(
          await ipc.invoke(WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL),
        );
      } catch {
        return publicEndpointPreferenceUnavailable();
      }
    },
    async saveEndpointPreference(
      preference: WorkbenchFamilyEndpointPreference,
    ): Promise<WorkbenchEndpointPreferenceSaveResult> {
      const reconstructed =
        reconstructWorkbenchFamilyEndpointPreference(preference);
      if (!reconstructed.ok) {
        return publicEndpointPreferenceUnavailable();
      }
      try {
        return sanitizeWorkbenchEndpointPreferenceSaveResult(
          await ipc.invoke(
            WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
            reconstructed.preference,
          ),
        );
      } catch {
        return publicEndpointPreferenceUnavailable();
      }
    },
    async loadEndpointKeyStatus(
      endpointId: WorkbenchEndpointKeyEndpointId,
    ): Promise<WorkbenchEndpointKeyStatusResult> {
      if (!isEndpointKeyEndpointId(endpointId)) {
        return publicEndpointKeyUnavailable();
      }
      try {
        return sanitizeWorkbenchEndpointKeyStatusResult(
          await ipc.invoke(WORKBENCH_ENDPOINT_KEY_CHANNELS[endpointId].loadStatus),
        );
      } catch {
        return publicEndpointKeyUnavailable();
      }
    },
    async saveEndpointKey(
      endpointId: WorkbenchEndpointKeyEndpointId,
      request: Readonly<{ keyValue: string }>,
    ): Promise<WorkbenchEndpointKeySaveResult> {
      if (!isEndpointKeyEndpointId(endpointId)) {
        return publicEndpointKeyUnavailable();
      }
      const reconstructed =
        reconstructWorkbenchEndpointKeySaveRequest(request);
      if (!reconstructed.ok) return publicEndpointKeyInvalidValue();
      try {
        return sanitizeWorkbenchEndpointKeySaveResult(
          await ipc.invoke(
            WORKBENCH_ENDPOINT_KEY_CHANNELS[endpointId].save,
            Object.freeze({ keyValue: reconstructed.keyValue }),
          ),
        );
      } catch {
        return publicEndpointKeyUnavailable();
      }
    },
    async removeEndpointKey(
      endpointId: WorkbenchEndpointKeyEndpointId,
    ): Promise<WorkbenchEndpointKeyRemoveResult> {
      if (!isEndpointKeyEndpointId(endpointId)) {
        return publicEndpointKeyUnavailable();
      }
      try {
        return sanitizeWorkbenchEndpointKeyRemoveResult(
          await ipc.invoke(WORKBENCH_ENDPOINT_KEY_CHANNELS[endpointId].remove),
        );
      } catch {
        return publicEndpointKeyUnavailable();
      }
    },
    async revealEndpointKey(
      endpointId: WorkbenchEndpointKeyEndpointId,
    ): Promise<WorkbenchEndpointKeyRevealResult> {
      if (!isEndpointKeyEndpointId(endpointId)) {
        return publicEndpointKeyUnavailable();
      }
      try {
        return sanitizeWorkbenchEndpointKeyRevealResult(
          await ipc.invoke(WORKBENCH_ENDPOINT_KEY_CHANNELS[endpointId].reveal),
        );
      } catch {
        return publicEndpointKeyUnavailable();
      }
    },
    async probeEndpointKey(
      endpointId: WorkbenchEndpointKeyEndpointId,
    ): Promise<WorkbenchEndpointProbeResult> {
      if (!isEndpointKeyEndpointId(endpointId)) {
        return publicEndpointKeyUnavailable();
      }
      try {
        return sanitizeWorkbenchEndpointProbeResult(
          await ipc.invoke(WORKBENCH_ENDPOINT_KEY_CHANNELS[endpointId].probe),
        );
      } catch {
        return publicEndpointKeyUnavailable();
      }
    },
    async loadEndpointCatalogFreshness(): Promise<WorkbenchEndpointCatalogFreshnessResult> {
      try {
        return sanitizeWorkbenchEndpointCatalogFreshnessResult(
          await ipc.invoke(WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL),
        );
      } catch {
        return publicEndpointCatalogFreshnessUnavailable();
      }
    },
    async refreshEndpointCatalogFreshness(): Promise<WorkbenchEndpointCatalogFreshnessResult> {
      try {
        return sanitizeWorkbenchEndpointCatalogFreshnessResult(
          await ipc.invoke(
            WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
          ),
        );
      } catch {
        return publicEndpointCatalogFreshnessUnavailable();
      }
    },
    async checkCliUpdates(): Promise<WorkbenchCliUpdateCheckResult> {
      try {
        return sanitizeWorkbenchCliUpdateCheckResult(
          await ipc.invoke(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL),
        );
      } catch {
        return publicCliUpdateCheckUnavailable();
      }
    },
    async runCliUpdate(
      cliId: WorkbenchCliUpdateCliId,
    ): Promise<WorkbenchCliUpdateRunResult> {
      const reconstructed = reconstructWorkbenchCliUpdateRunRequest(cliId);
      if (!reconstructed.ok) return publicCliUpdateRunUnavailable();
      try {
        return sanitizeWorkbenchCliUpdateRunResult(
          await ipc.invoke(WORKBENCH_RUN_CLI_UPDATE_CHANNEL, reconstructed.value),
          reconstructed.value,
        );
      } catch {
        return publicCliUpdateRunUnavailable();
      }
    },
    async relaunchApp(): Promise<WorkbenchCliUpdateRelaunchResult> {
      try {
        const result = await ipc.invoke(WORKBENCH_RELAUNCH_APP_CHANNEL);
        return sanitizeWorkbenchCliUpdateRelaunchResult(result);
      } catch {
        return publicCliUpdateRelaunchUnavailable();
      }
    },
    async loadRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablesLoadResult> {
      try {
        return sanitizeWorkbenchRuntimeExecutablesLoadResult(
          await ipc.invoke(WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL),
        );
      } catch {
        return publicRuntimeExecutableUnavailable();
      }
    },
    async saveRuntimeExecutable(
      request: WorkbenchRuntimeExecutableSaveRequest,
    ): Promise<WorkbenchRuntimeExecutableSaveResult> {
      const reconstructed =
        reconstructWorkbenchRuntimeExecutableSaveRequest(request);
      if (!reconstructed.ok) return publicRuntimeExecutableUnavailable();
      try {
        return sanitizeWorkbenchRuntimeExecutableSaveResult(
          await ipc.invoke(
            WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return publicRuntimeExecutableUnavailable();
      }
    },
    async installRuntimeExecutable(
      request: WorkbenchRuntimeInstallRequest,
    ): Promise<WorkbenchRuntimeInstallResult> {
      const reconstructed = reconstructWorkbenchRuntimeInstallRequest(request);
      if (!reconstructed.ok) return publicRuntimeExecutableUnavailable();
      try {
        return sanitizeWorkbenchRuntimeInstallResult(
          await ipc.invoke(
            WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return publicRuntimeExecutableUnavailable();
      }
    },
    async createProject(): Promise<WorkbenchCreateProjectResult> {
      try {
        return sanitizeWorkbenchCreateProjectResult(
          await ipc.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL),
        );
      } catch {
        return publicCreateProjectResult("unavailable");
      }
    },
    async openProject(): Promise<WorkbenchOpenProjectResult> {
      try {
        return sanitizeWorkbenchOpenProjectResult(
          await ipc.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL),
        );
      } catch {
        return publicProjectOpenUnavailable();
      }
    },
    async selectProject(
      request: WorkbenchProjectSelectionRequest,
    ): Promise<WorkbenchProjectSelectionResult> {
      const reconstructed = reconstructWorkbenchProjectSelectionRequest(request);
      if (!reconstructed.ok) return publicInvalidProjectSelection();
      try {
        return sanitizeWorkbenchProjectSelectionResult(
          await ipc.invoke(
            WORKBENCH_SELECT_PROJECT_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return publicProjectSwitchUnavailable();
      }
    },
    async removeSession(
      request: WorkbenchSessionRemovalRequest,
    ): Promise<WorkbenchSessionRemovalResult> {
      const reconstructed = reconstructWorkbenchSessionRemovalRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "not-found" });
      }
      try {
        return sanitizeWorkbenchSessionRemovalResult(
          await ipc.invoke(
            WORKBENCH_REMOVE_SESSION_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
    async mutateSessionMetadata(
      request: WorkbenchSessionMetadataMutationRequest,
    ): Promise<WorkbenchSessionMetadataMutationResult> {
      const reconstructed =
        reconstructWorkbenchSessionMetadataMutationRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "unavailable" });
      }
      try {
        return sanitizeWorkbenchSessionMetadataMutationResult(
          await ipc.invoke(
            WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
    async removeProject(
      request: WorkbenchProjectSelectionRequest,
    ): Promise<WorkbenchProjectRemovalResult> {
      const reconstructed = reconstructWorkbenchProjectSelectionRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "invalid-selection" });
      }
      try {
        return sanitizeWorkbenchProjectRemovalResult(
          await ipc.invoke(
            WORKBENCH_REMOVE_PROJECT_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
    async discoverProjectHistories(
      request: WorkbenchProjectSelectionRequest,
    ): Promise<WorkbenchProjectHistoryDiscoveryResult> {
      const reconstructed = reconstructWorkbenchProjectSelectionRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "invalid-selection" });
      }
      try {
        return sanitizeWorkbenchProjectHistoryDiscoveryResult(
          await ipc.invoke(
            WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
    async adoptProjectHistory(
      request: WorkbenchProjectHistoryAdoptionRequest,
    ): Promise<WorkbenchProjectHistoryAdoptionResult> {
      const reconstructed =
        reconstructWorkbenchProjectHistoryAdoptionRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "invalid-selection" });
      }
      try {
        return sanitizeWorkbenchProjectHistoryAdoptionResult(
          await ipc.invoke(
            WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
    async hideProjectHistory(
      request: WorkbenchProjectHistoryHideRequest,
    ): Promise<WorkbenchProjectHistoryHideResult> {
      const reconstructed = reconstructWorkbenchProjectHistoryHideRequest(request);
      if (!reconstructed.ok) {
        return Object.freeze({ status: "invalid-selection" });
      }
      try {
        return sanitizeWorkbenchProjectHistoryHideResult(
          await ipc.invoke(
            WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return Object.freeze({ status: "unavailable" });
      }
    },
    async loadDirectSessionProfile<
      Request extends WorkbenchDirectSessionProfileLoadRequest,
    >(
      request: Request,
    ): Promise<WorkbenchPublicDirectSessionProfileResultFor<Request>> {
      const reconstructed =
        reconstructWorkbenchDirectSessionProfileLoadRequest(request);
      if (!reconstructed.ok) {
        return publicProfileUnavailable() as WorkbenchPublicDirectSessionProfileResultFor<Request>;
      }
      try {
        return sanitizeWorkbenchDirectSessionProfileResult(
          await ipc.invoke(
            WORKBENCH_LOAD_PROFILE_CHANNEL,
            reconstructed.request,
          ),
          reconstructed.request,
        ) as WorkbenchPublicDirectSessionProfileResultFor<Request>;
      } catch {
        return publicProfileUnavailable() as WorkbenchPublicDirectSessionProfileResultFor<Request>;
      }
    },
    async useDirectSessionProfileAsDefault(
      request: WorkbenchDirectSessionProfileDefaultRequest,
    ): Promise<WorkbenchDirectSessionProfileDefaultResult> {
      const reconstructed =
        reconstructWorkbenchDirectSessionProfileDefaultRequest(request);
      if (!reconstructed.ok) return publicInvalidProfileDefaultSelection();
      try {
        return sanitizeWorkbenchDirectSessionProfileDefaultResult(
          await ipc.invoke(
            WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return publicPreferenceUnavailable();
      }
    },
    async submitDirectInput(
      request: WorkbenchDirectInputRequest,
    ): Promise<WorkbenchSubmissionResult> {
      const reconstructed = reconstructWorkbenchDirectInputRequest(request);
      if (!reconstructed.ok) {
        if (reconstructed.category === "invalid-input") {
          return publicInvalidSubmission();
        }
        return reconstructed.category === "continuation-unavailable"
          ? publicContinuationUnavailable()
          : publicInvalidProfileSelection();
      }
      try {
        return sanitizeWorkbenchSubmissionResult(
          await ipc.invoke(WORKBENCH_SUBMIT_CHANNEL, reconstructed.request),
        );
      } catch {
        return publicUnavailableSubmission();
      }
    },
    observeUserInput(listener: () => void): () => void {
      const handler: ProjectViewIpcListener = (_event, value) => { if (value === null) listener(); };
      ipc.on(WORKBENCH_USER_INPUT_CHANGED_CHANNEL, handler);
      return () => ipc.removeListener(WORKBENCH_USER_INPUT_CHANGED_CHANNEL, handler);
    },
    async readUserInput(request: WorkbenchUserInputReadRequest): Promise<WorkbenchUserInputResult> {
      const parsed = reconstructUserInputRead(request);
      if (!parsed) return { ok: false };
      try { return sanitizeUserInputResult(await ipc.invoke(WORKBENCH_READ_USER_INPUT_CHANNEL, parsed)); }
      catch { return { ok: false }; }
    },
    async respondToUserInput(request: WorkbenchUserInputResponse): Promise<WorkbenchUserInputResponseResult> {
      const parsed = reconstructUserInputResponse(request);
      if (!parsed) return { status: "invalid-answer" };
      try { return sanitizeUserInputResponseResult(await ipc.invoke(WORKBENCH_RESPOND_USER_INPUT_CHANNEL, parsed)); }
      catch { return { status: "unavailable" }; }
    },
    async interruptActiveTurn(
      request: WorkbenchInterruptRequest,
    ): Promise<WorkbenchInterruptResult> {
      const reconstructed = reconstructWorkbenchInterruptRequest(request);
      if (!reconstructed.ok) return publicInvalidInterrupt();
      try {
        return sanitizeWorkbenchInterruptResult(
          await ipc.invoke(
            WORKBENCH_INTERRUPT_CHANNEL,
            reconstructed.request,
          ),
        );
      } catch {
        return publicInterruptUnavailable();
      }
    },
    async steerActiveTurn(
      request: WorkbenchSteerRequest,
    ): Promise<WorkbenchSteerResult> {
      const reconstructed = reconstructWorkbenchSteerRequest(request);
      if (!reconstructed.ok) return publicInvalidSteer();
      try {
        return sanitizeWorkbenchSteerResult(
          await ipc.invoke(WORKBENCH_STEER_CHANNEL, reconstructed.request),
        );
      } catch {
        return publicSteerUnavailable();
      }
    },
  });

  function replaceRecoveryAuthority(
    snapshot: Extract<HistoryRecoverySnapshotResult, { status: "ready" | "partial" }>["snapshot"],
  ): void {
    recoverySnapshotKey = snapshot.snapshotKey;
    recoveryLibraryKey = snapshot.library.libraryKey;
    recoverySources.clear();
    recoveryGenerations.clear();
    recoveryProjects.clear();
    recoverySessions.clear();
    for (const source of snapshot.sources) {
      recoverySources.set(source.sourceKey, {
        snapshotKey: snapshot.snapshotKey,
        action: source.action,
      });
    }
  }

  function ownsRecoveryBrowse(request: HistoryRecoveryBrowseRequest): boolean {
    if (request.snapshotKey !== recoverySnapshotKey) return false;
    switch (request.kind) {
      case "generations":
        return request.libraryKey === recoveryLibraryKey;
      case "projects":
        return recoveryGenerations.get(request.generationKey) === request.snapshotKey;
      case "sessions":
        return recoveryProjects.get(request.projectKey) === request.snapshotKey;
      case "turns":
        return recoverySessions.get(request.sessionKey) === request.snapshotKey;
    }
  }

  function ownsRecoveryAction(request: HistoryRecoveryPerformRequest): boolean {
    if (request.snapshotKey !== recoverySnapshotKey) return false;
    if (request.action === "export-copy") {
      return recoveryGenerations.get(request.generationKey) === request.snapshotKey;
    }
    const source = recoverySources.get(request.sourceKey);
    return source?.snapshotKey === request.snapshotKey &&
      source.action === request.action;
  }

  function retainRecoveryBrowseAuthority(result: Extract<HistoryRecoveryBrowseResult, { status: "ready" }>): void {
    if (result.snapshotKey !== recoverySnapshotKey) return;
    for (const item of result.page.items) {
      if (item.kind === "generation") {
        recoveryGenerations.set(item.generationKey, result.snapshotKey);
      } else if (item.kind === "project") {
        recoveryProjects.set(item.projectKey, result.snapshotKey);
      } else if (item.kind === "session") {
        recoverySessions.set(item.sessionKey, result.snapshotKey);
      }
    }
  }

  /** Fail-closed membership check: renderer-originated ids are untrusted. */
  function isEndpointKeyEndpointId(
    value: WorkbenchEndpointKeyEndpointId,
  ): boolean {
    return (
      WORKBENCH_ENDPOINT_KEY_ENDPOINT_IDS as readonly string[]
    ).includes(value);
  }

  async function invokeAuthentication(    channel:
      | typeof WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL
      | typeof WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL,
    request: unknown,
  ): Promise<WorkbenchSubscriptionAuthenticationPublicResponse> {
    const raw = await ipc.invoke(channel, request);
    return strictAuthenticationResponse(raw);
  }

  function strictAuthenticationResponse(
    value: unknown,
  ): WorkbenchSubscriptionAuthenticationPublicResponse {
    const sanitized = sanitizeSubscriptionAuthenticationPublicResponse(
      value,
      authenticationKeyAuthority,
    );
    if (!sanitized.accepted) {
      throw new TypeError("subscription-authentication-boundary-rejected");
    }
    return sanitized.value;
  }
}
