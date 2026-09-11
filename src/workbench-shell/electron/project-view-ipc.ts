import {
  WORKBENCH_READ_USER_INPUT_CHANNEL,
  WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
  WORKBENCH_USER_INPUT_CHANGED_CHANNEL,
  type WorkbenchUserInputBridge,
  WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_CREATE_PROJECT_CHANNEL,
  WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
  WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_DISPOSE_CHANNEL,
  WORKBENCH_LOAD_PROFILE_CHANNEL,
  WORKBENCH_INTERRUPT_CHANNEL,
  WORKBENCH_STEER_CHANNEL,
  WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
  WORKBENCH_OBSERVE_CHANNEL,
  WORKBENCH_OPEN_PROJECT_CHANNEL,
  WORKBENCH_PROJECT_VIEW_CHANNEL,
  WORKBENCH_REMOVE_PROJECT_CHANNEL,
  WORKBENCH_REMOVE_SESSION_CHANNEL,
  WORKBENCH_SELECT_PROJECT_CHANNEL,
  WORKBENCH_SUBMIT_CHANNEL,
  WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  publicInvalidProfileDefaultSelection,
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
  publicOpenProjectHistorySelectionRequired,
  publicProjectOpened,
  publicProjectOpenedWithExistingHistory,
  publicProjectOpenCancelled,
  publicProjectOpenUnavailable,
  publicOpenProjectDriveRootRefused,
  publicProfileUnavailable,
  publicPreferenceUnavailable,
  publicProjectSwitchUnavailable,
  publicUnavailableSubmission,
  type WorkbenchDirectInputRequest,
  type WorkbenchCreateProjectResult,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchHostedProjectListener,
  type WorkbenchHostedProjectResult,
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
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchSubmissionResult,
} from "../contract.ts";
import {
  reconstructWorkbenchDirectInputRequest,
  reconstructWorkbenchDirectSessionProfileDefaultRequest,
  reconstructWorkbenchDirectSessionProfileLoadRequest,
  reconstructWorkbenchInterruptRequest,
  reconstructWorkbenchSteerRequest,
  sanitizeWorkbenchCreateProjectResult,
  reconstructWorkbenchProjectHistoryAdoptionRequest,
  reconstructWorkbenchProjectHistoryHideRequest,
  reconstructWorkbenchProjectSelectionRequest,
  reconstructWorkbenchSessionMetadataMutationRequest,
  reconstructWorkbenchSessionRemovalRequest,
  sanitizeWorkbenchProjectHistoryAdoptionResult,
  sanitizeWorkbenchProjectHistoryDiscoveryResult,
  sanitizeWorkbenchProjectHistoryHideResult,
  sanitizeWorkbenchDirectSessionProfileDefaultResult,
  sanitizeWorkbenchDirectSessionProfileResult,
  sanitizeWorkbenchSubmissionResult,
  sanitizeWorkbenchHostedProjectResult,
  createWorkbenchProjectTransferEncoder,
  sanitizeWorkbenchInterruptResult,
  sanitizeWorkbenchSteerResult,
  sanitizeWorkbenchOpenProjectResult,
  sanitizeWorkbenchProjectSelectionResult,
  sanitizeWorkbenchProjectRemovalResult,
  sanitizeWorkbenchSessionMetadataMutationResult,
  sanitizeWorkbenchSessionRemovalResult,
} from "../result-sanitizer.ts";
import type { WorkbenchCreateProjectController } from "../create-project-controller.ts";

import { reconstructUserInputRead, reconstructUserInputResponse, sanitizeUserInputResult, sanitizeUserInputResponseResult } from "../user-input-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface RendererSender {
  send(channel: typeof WORKBENCH_PROJECT_VIEW_CHANNEL | typeof WORKBENCH_USER_INPUT_CHANGED_CHANNEL, value: unknown): void;
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface BrowserWindowBoundary {
  readonly webContents: RendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface IpcMainBoundary {
  on(
    channel:
      | typeof WORKBENCH_OBSERVE_CHANNEL
      | typeof WORKBENCH_DISPOSE_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeListener(
    channel:
      | typeof WORKBENCH_OBSERVE_CHANNEL
      | typeof WORKBENCH_DISPOSE_CHANNEL,
    listener: BoundaryListener,
  ): void;
  handle(
    channel:
      | typeof WORKBENCH_READ_USER_INPUT_CHANNEL
      | typeof WORKBENCH_RESPOND_USER_INPUT_CHANNEL
      | typeof WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_CREATE_PROJECT_CHANNEL
      | typeof WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL
      | typeof WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_INTERRUPT_CHANNEL
      | typeof WORKBENCH_STEER_CHANNEL
      | typeof WORKBENCH_LOAD_PROFILE_CHANNEL
      | typeof WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL
      | typeof WORKBENCH_OPEN_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_SESSION_CHANNEL
      | typeof WORKBENCH_SELECT_PROJECT_CHANNEL
      | typeof WORKBENCH_SUBMIT_CHANNEL
      | typeof WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(
    channel:
      | typeof WORKBENCH_READ_USER_INPUT_CHANNEL
      | typeof WORKBENCH_RESPOND_USER_INPUT_CHANNEL
      | typeof WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_CREATE_PROJECT_CHANNEL
      | typeof WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL
      | typeof WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_INTERRUPT_CHANNEL
      | typeof WORKBENCH_STEER_CHANNEL
      | typeof WORKBENCH_LOAD_PROFILE_CHANNEL
      | typeof WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL
      | typeof WORKBENCH_OPEN_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_SESSION_CHANNEL
      | typeof WORKBENCH_SELECT_PROJECT_CHANNEL
      | typeof WORKBENCH_SUBMIT_CHANNEL
      | typeof WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  ): void;
}

export interface ProjectViewSource extends Partial<WorkbenchUserInputBridge> {
  observeProject(listener: WorkbenchHostedProjectListener): () => void;
  registerTrustedProject(
    directory: string,
  ): Promise<WorkbenchProjectSelectionResult>;
  selectProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectSelectionResult>;
  removeSession?(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult>;
  mutateSessionMetadata?(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult>;
  removeProject?(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectRemovalResult>;
  discoverProjectHistories?(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectHistoryDiscoveryResult>;
  adoptProjectHistory?(
    request: WorkbenchProjectHistoryAdoptionRequest,
  ): Promise<WorkbenchProjectHistoryAdoptionResult>;
  hideProjectHistory?(
    request: WorkbenchProjectHistoryHideRequest,
  ): Promise<WorkbenchProjectHistoryHideResult>;
  loadDirectSessionProfile(
    request: WorkbenchDirectSessionProfileLoadRequest,
  ): Promise<unknown>;
  useDirectSessionProfileAsDefault(
    request: WorkbenchDirectSessionProfileDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult>;
  submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult>;
  interruptActiveTurn?(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult>;
  steerActiveTurn?(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult>;
}

export interface ProjectViewIpcBinding {
  dispose(): void;
}

export interface ProjectDirectoryChooser {
  chooseProjectDirectory(window: BrowserWindowBoundary): Promise<unknown>;
}

type ObservationRecord = {
  active: boolean;
  awaitingAcquisitionView: boolean;
  readonly sender: RendererSender;
  sourceDispose: () => void;
  encode: ReturnType<typeof createWorkbenchProjectTransferEncoder>;
};

type RecoveryObservationPhase =
  | "inactive"
  | "awaiting-instructed-open"
  | "instructed-open-pending"
  | "recovery-view-observed"
  | "instructed-open-succeeded";

export function installWorkbenchProjectViewIpc(options: {
  readonly ipcMain: IpcMainBoundary;
  readonly window: BrowserWindowBoundary;
  readonly source: ProjectViewSource | null;
  readonly directoryChooser?: ProjectDirectoryChooser;
  readonly createProjectController?: WorkbenchCreateProjectController;
}): ProjectViewIpcBinding {
  let activeObservation: ObservationRecord | undefined;
  let disposed = false;
  let actionOpen = true;
  let openProjectPending = false;
  let createProjectPending = false;
  let pendingActions = 0;
  let createProjectCloseStarted = false;
  let recoveryObservationPhase: RecoveryObservationPhase = "inactive";
  const acquisitionPending = (): boolean =>
    openProjectPending || createProjectPending;
  const recoveryObservationPending = (): boolean =>
    recoveryObservationPhase !== "inactive";

  const trackAction = async <T>(
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    pendingActions += 1;
    try {
      return await operation();
    } catch {
      return fallback;
    } finally {
      pendingActions -= 1;
    }
  };

  const endObservation = (record: ObservationRecord | undefined): void => {
    if (record === undefined || !record.active) return;
    record.active = false;
    if (activeObservation === record) activeObservation = undefined;
    try {
      record.sourceDispose();
    } catch {
      // The fixed renderer boundary does not expose teardown failures.
    }
  };
  const endActiveObservation = (): void => endObservation(activeObservation);

  const beginObservation = (sender: RendererSender): void => {
    endActiveObservation();
    const record: ObservationRecord = {
      active: true,
      awaitingAcquisitionView: false,
      sender,
      sourceDispose: () => undefined,
      encode: createWorkbenchProjectTransferEncoder(),
    };
    activeObservation = record;
    if (options.source === null) {
      sendResult(record, publicHostedProjectFailure());
      return;
    }
    try {
      const sourceDispose = options.source.observeProject((result) =>
        sendResult(record, result),
      );
      const disposeInput = options.source.observeUserInput?.(() => {
        if (record.active && !record.sender.isDestroyed()) record.sender.send(WORKBENCH_USER_INPUT_CHANGED_CHANNEL, null);
      });
      record.sourceDispose = () => { sourceDispose(); disposeInput?.(); };
      if (!record.active) record.sourceDispose();
    } catch {
      sendResult(record, publicHostedProjectFailure());
    }
  };

  const reobserveAfterMutation = (sender: RendererSender): void => {
    if (
      disposed ||
      sender.isDestroyed() ||
      activeObservation?.sender !== sender
    ) {
      return;
    }
    beginObservation(sender);
  };

  const clearRecoveryObservation = (): void => {
    recoveryObservationPhase = "inactive";
    if (activeObservation !== undefined) {
      activeObservation.awaitingAcquisitionView = false;
    }
  };

  const observeRecoveryView = (): void => {
    if (recoveryObservationPhase === "instructed-open-pending") {
      recoveryObservationPhase = "recovery-view-observed";
    } else if (
      recoveryObservationPhase === "instructed-open-succeeded"
    ) {
      clearRecoveryObservation();
    }
  };

  const sendResult = (
    record: ObservationRecord,
    result: WorkbenchHostedProjectResult,
  ): void => {
    if (
      disposed ||
      !record.active ||
      activeObservation !== record ||
      record.sender.isDestroyed()
    ) {
      endObservation(record);
      return;
    }
    const sanitized = sanitizeWorkbenchHostedProjectResult(result);
    try {
      record.sender.send(WORKBENCH_PROJECT_VIEW_CHANNEL, record.encode(sanitized));
    } catch {
      endObservation(record);
      return;
    }
    if (!sanitized.ok) {
      if (acquisitionPending() || recoveryObservationPending()) {
        record.awaitingAcquisitionView = true;
      }
      if (!record.awaitingAcquisitionView) endObservation(record);
    } else if ("empty" in sanitized) {
      record.awaitingAcquisitionView = false;
    } else {
      record.awaitingAcquisitionView = false;
      observeRecoveryView();
    }
  };

  const observeListener: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (disposed || sender === undefined) return;
    beginObservation(sender);
  };

  const disposeListener: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (disposed || sender === undefined) return;
    if (activeObservation?.sender === sender) endActiveObservation();
  };

  const submitHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null
    ) {
      return publicUnavailableSubmission();
    }
    if (values.length !== 2) return publicInvalidProfileSelection();
    const reconstructed = reconstructWorkbenchDirectInputRequest(values[1]);
    if (!reconstructed.ok) {
      if (reconstructed.category === "invalid-input") {
        return publicInvalidSubmission();
      }
      return reconstructed.category === "continuation-unavailable"
        ? publicContinuationUnavailable()
        : publicInvalidProfileSelection();
    }
    return trackAction(
      async () =>
        sanitizeWorkbenchSubmissionResult(
          await options.source!.submitDirectInput(reconstructed.request),
        ),
      publicUnavailableSubmission(),
    );
  };

  const interruptHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    const interrupt = options.source?.interruptActiveTurn;
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      typeof interrupt !== "function"
    ) {
      return publicInterruptUnavailable();
    }
    if (values.length !== 2) return publicInvalidInterrupt();
    const reconstructed = reconstructWorkbenchInterruptRequest(values[1]);
    if (!reconstructed.ok) return publicInvalidInterrupt();
    return trackAction(
      async () =>
        sanitizeWorkbenchInterruptResult(
          await interrupt.call(options.source, reconstructed.request),
        ),
      publicInterruptUnavailable(),
    );
  };

  const readUserInputHandler: BoundaryListener = async (...values) => {
    const request = values.length === 2 ? reconstructUserInputRead(values[1]) : undefined;
    if (disposed || !actionOpen || acquisitionPending() || !owningSender(values[0], options.window) ||
        !request || !options.source?.readUserInput) return { ok: false };
    try { return sanitizeUserInputResult(await options.source.readUserInput(request)); }
    catch { return { ok: false }; }
  };
  const respondUserInputHandler: BoundaryListener = async (...values) => {
    const request = values.length === 2 ? reconstructUserInputResponse(values[1]) : undefined;
    if (disposed || !actionOpen || acquisitionPending() || !owningSender(values[0], options.window) ||
        !request || !options.source?.respondToUserInput) return { status: "unavailable" };
    // Q&A must not join a queue whose running turn is waiting for this very answer.
    try { return sanitizeUserInputResponseResult(await options.source.respondToUserInput(request)); }
    catch { return { status: "unavailable" }; }
  };

  const steerHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    const steer = options.source?.steerActiveTurn;
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      typeof steer !== "function"
    ) {
      return publicSteerUnavailable();
    }
    if (values.length !== 2) return publicInvalidSteer();
    const reconstructed = reconstructWorkbenchSteerRequest(values[1]);
    if (!reconstructed.ok) return publicInvalidSteer();
    return trackAction(
      async () =>
        sanitizeWorkbenchSteerResult(
          await steer.call(options.source, reconstructed.request),
        ),
      publicSteerUnavailable(),
    );
  };

  const useProfileAsDefaultHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null
    ) {
      return publicPreferenceUnavailable();
    }
    if (values.length !== 2) return publicInvalidProfileDefaultSelection();
    const reconstructed =
      reconstructWorkbenchDirectSessionProfileDefaultRequest(values[1]);
    if (!reconstructed.ok) return publicInvalidProfileDefaultSelection();
    return trackAction(
      async () =>
        sanitizeWorkbenchDirectSessionProfileDefaultResult(
          await options.source!.useDirectSessionProfileAsDefault(
            reconstructed.request,
          ),
        ),
      publicPreferenceUnavailable(),
    );
  };

  const loadProfileHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null
    ) {
      return publicProfileUnavailable();
    }
    if (values.length !== 2) return publicProfileUnavailable();
    const reconstructed =
      reconstructWorkbenchDirectSessionProfileLoadRequest(values[1]);
    if (!reconstructed.ok) return publicProfileUnavailable();
    return trackAction(
      async () =>
        sanitizeWorkbenchDirectSessionProfileResult(
          await options.source!.loadDirectSessionProfile(
            reconstructed.request,
          ),
          reconstructed.request,
        ),
      publicProfileUnavailable(),
    );
  };

  const selectProjectHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null
    ) {
      return publicProjectSwitchUnavailable();
    }
    if (values.length !== 2) return publicInvalidProjectSelection();
    const reconstructed = reconstructWorkbenchProjectSelectionRequest(
      values[1],
    );
    if (!reconstructed.ok) return publicInvalidProjectSelection();
    return trackAction(
      async () =>
        sanitizeWorkbenchProjectSelectionResult(
          await options.source!.selectProject(reconstructed.request),
        ),
      publicProjectSwitchUnavailable(),
    );
  };

  const removeSessionHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      options.source.removeSession === undefined
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (values.length !== 2) {
      return Object.freeze({ status: "not-found" as const });
    }
    const reconstructed = reconstructWorkbenchSessionRemovalRequest(values[1]);
    if (!reconstructed.ok) {
      return Object.freeze({ status: "not-found" as const });
    }
    const result = await trackAction(
      async () =>
        sanitizeWorkbenchSessionRemovalResult(
          await options.source!.removeSession!(reconstructed.request),
        ),
      Object.freeze({ status: "unavailable" as const }),
    );
    if (result.status === "removed") reobserveAfterMutation(sender);
    return result;
  };

  const mutateSessionMetadataHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      options.source.mutateSessionMetadata === undefined
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (values.length !== 2) {
      return Object.freeze({ status: "unavailable" as const });
    }
    const reconstructed =
      reconstructWorkbenchSessionMetadataMutationRequest(values[1]);
    if (!reconstructed.ok) {
      return Object.freeze({ status: "unavailable" as const });
    }
    const result = await trackAction(
      async () =>
        sanitizeWorkbenchSessionMetadataMutationResult(
          await options.source!.mutateSessionMetadata!(reconstructed.request),
        ),
      Object.freeze({ status: "unavailable" as const }),
    );
    if (
      result.status === "renamed" ||
      result.status === "archived" ||
      result.status === "restored"
    ) {
      reobserveAfterMutation(sender);
    }
    return result;
  };

  const removeProjectHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      options.source.removeProject === undefined
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (values.length !== 2) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    const reconstructed = reconstructWorkbenchProjectSelectionRequest(values[1]);
    if (!reconstructed.ok) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    const result = await trackAction(
      async () =>
        sanitizeWorkbenchProjectRemovalResult(
          await options.source!.removeProject!(reconstructed.request),
        ),
      Object.freeze({ status: "unavailable" as const }),
    );
    if (result.status === "removed") reobserveAfterMutation(sender);
    return result;
  };

  const discoverProjectHistoriesHandler: BoundaryListener = async (
    ...values
  ) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      options.source.discoverProjectHistories === undefined
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (values.length !== 2) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    const reconstructed = reconstructWorkbenchProjectSelectionRequest(values[1]);
    if (!reconstructed.ok) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    return trackAction(
      async () =>
        sanitizeWorkbenchProjectHistoryDiscoveryResult(
          await options.source!.discoverProjectHistories!(reconstructed.request),
        ),
      Object.freeze({ status: "unavailable" as const }),
    );
  };

  const adoptProjectHistoryHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      options.source.adoptProjectHistory === undefined
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (values.length !== 2) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    const reconstructed =
      reconstructWorkbenchProjectHistoryAdoptionRequest(values[1]);
    if (!reconstructed.ok) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    const result = await trackAction(
      async () =>
        sanitizeWorkbenchProjectHistoryAdoptionResult(
          await options.source!.adoptProjectHistory!(reconstructed.request),
        ),
      Object.freeze({ status: "unavailable" as const }),
    );
    if (result.status === "adopted") reobserveAfterMutation(sender);
    return result;
  };

  const hideProjectHistoryHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      sender === undefined ||
      options.source === null ||
      options.source.hideProjectHistory === undefined
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (values.length !== 2) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    const reconstructed = reconstructWorkbenchProjectHistoryHideRequest(
      values[1],
    );
    if (!reconstructed.ok) {
      return Object.freeze({ status: "invalid-selection" as const });
    }
    return trackAction(
      async () =>
        sanitizeWorkbenchProjectHistoryHideResult(
          await options.source!.hideProjectHistory!(reconstructed.request),
        ),
      Object.freeze({ status: "unavailable" as const }),
    );
  };

  const openProjectHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      values.length !== 1 ||
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      pendingActions > 0 ||
      sender === undefined ||
      options.source === null ||
      options.directoryChooser === undefined
    ) {
      return publicProjectOpenUnavailable();
    }
    openProjectPending = true;
    let recoveryAttempt = false;
    const abandonRecoveryAttempt = (): void => {
      if (recoveryAttempt && recoveryObservationPending()) {
        recoveryObservationPhase = "awaiting-instructed-open";
      }
    };
    try {
      const chosen = decodeProjectDirectoryChoice(
        await options.directoryChooser.chooseProjectDirectory(options.window),
      );
      if (
        disposed ||
        !actionOpen ||
        sender.isDestroyed() ||
        chosen.kind === "invalid"
      ) {
        return publicProjectOpenUnavailable();
      }
      if (chosen.kind === "cancelled") {
        return publicProjectOpenCancelled();
      }
      if (recoveryObservationPhase === "awaiting-instructed-open") {
        recoveryAttempt = true;
        recoveryObservationPhase = "instructed-open-pending";
      }
      const registered = await options.source.registerTrustedProject(
        chosen.directory,
      );
      if (disposed || !actionOpen || sender.isDestroyed()) {
        abandonRecoveryAttempt();
        return publicProjectOpenUnavailable();
      }
      const sanitizedRegistration =
        sanitizeWorkbenchProjectSelectionResult(registered);
      if (!sanitizedRegistration.ok) {
        abandonRecoveryAttempt();
        // The one refusal that has a cause the reader can act on keeps it
        // across this seam. Every other failure still collapses to the fixed
        // "could not be completed" result, exactly as before.
        return sanitizedRegistration.error.category ===
          "project-directory-is-drive-root"
          ? sanitizeWorkbenchOpenProjectResult(publicOpenProjectDriveRootRefused())
          : publicProjectOpenUnavailable();
      }
      if (sanitizedRegistration.status === "history-selection-required") {
        abandonRecoveryAttempt();
        return sanitizeWorkbenchOpenProjectResult(
          publicOpenProjectHistorySelectionRequired(
            sanitizedRegistration.snapshot,
          ),
        );
      }
      if (recoveryAttempt) {
        if (recoveryObservationPhase === "recovery-view-observed") {
          clearRecoveryObservation();
        } else if (
          recoveryObservationPhase === "instructed-open-pending"
        ) {
          recoveryObservationPhase = "instructed-open-succeeded";
        }
      }
      return sanitizeWorkbenchOpenProjectResult(
        sanitizedRegistration.message ===
            "Project was opened with its existing conversation history."
          ? publicProjectOpenedWithExistingHistory()
          : publicProjectOpened(),
      );
    } catch {
      abandonRecoveryAttempt();
      return publicProjectOpenUnavailable();
    } finally {
      openProjectPending = false;
    }
  };

  const createProjectHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      values.length !== 1 ||
      disposed ||
      !actionOpen ||
      acquisitionPending() ||
      pendingActions > 0 ||
      sender === undefined ||
      options.createProjectController === undefined
    ) {
      return publicCreateProjectResult("unavailable");
    }
    createProjectPending = true;
    try {
      const controllerResult =
        await options.createProjectController.createProject();
      // `diagnostic`, when present, is a non-enumerable in-memory handoff for
      // the later public failure contract. Do not log, persist, or forward it
      // through the current contract until that contract can whitelist it.
      const result = sanitizeWorkbenchCreateProjectResult(controllerResult);
      if (
        disposed ||
        !actionOpen ||
        sender.isDestroyed()
      ) {
        return publicCreateProjectResult("unavailable");
      }
      if (result.outcome === "created-recovery-required") {
        recoveryObservationPhase = "awaiting-instructed-open";
      }
      return result;
    } catch {
      return publicCreateProjectResult("unavailable");
    } finally {
      createProjectPending = false;
    }
  };

  const reloadListener: BoundaryListener = () => endActiveObservation();
  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
    endActiveObservation();
    if (!createProjectCloseStarted) {
      createProjectCloseStarted = true;
      void options.createProjectController?.close().catch(() => undefined);
    }
  };
  options.ipcMain.on(WORKBENCH_OBSERVE_CHANNEL, observeListener);
  options.ipcMain.on(WORKBENCH_DISPOSE_CHANNEL, disposeListener);
  options.ipcMain.handle(WORKBENCH_LOAD_PROFILE_CHANNEL, loadProfileHandler);
  options.ipcMain.handle(WORKBENCH_CREATE_PROJECT_CHANNEL, createProjectHandler);
  options.ipcMain.handle(WORKBENCH_OPEN_PROJECT_CHANNEL, openProjectHandler);
  options.ipcMain.handle(
    WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
    mutateSessionMetadataHandler,
  );
  options.ipcMain.handle(WORKBENCH_REMOVE_PROJECT_CHANNEL, removeProjectHandler);
  options.ipcMain.handle(
    WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
    discoverProjectHistoriesHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
    adoptProjectHistoryHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
    hideProjectHistoryHandler,
  );
  options.ipcMain.handle(WORKBENCH_REMOVE_SESSION_CHANNEL, removeSessionHandler);
  options.ipcMain.handle(WORKBENCH_SELECT_PROJECT_CHANNEL, selectProjectHandler);
  options.ipcMain.handle(WORKBENCH_SUBMIT_CHANNEL, submitHandler);
  options.ipcMain.handle(WORKBENCH_INTERRUPT_CHANNEL, interruptHandler);
  options.ipcMain.handle(WORKBENCH_READ_USER_INPUT_CHANNEL, readUserInputHandler);
  options.ipcMain.handle(WORKBENCH_RESPOND_USER_INPUT_CHANNEL, respondUserInputHandler);
  options.ipcMain.handle(WORKBENCH_STEER_CHANNEL, steerHandler);
  options.ipcMain.handle(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    useProfileAsDefaultHandler,
  );
  options.window.webContents.on("did-start-loading", reloadListener);
  options.window.webContents.on(
    "render-process-gone",
    terminalLifecycleListener,
  );
  options.window.webContents.on("destroyed", terminalLifecycleListener);
  options.window.on("closed", terminalLifecycleListener);

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      options.ipcMain.removeListener(
        WORKBENCH_OBSERVE_CHANNEL,
        observeListener,
      );
      options.ipcMain.removeListener(
        WORKBENCH_DISPOSE_CHANNEL,
        disposeListener,
      );
      options.ipcMain.removeHandler(WORKBENCH_LOAD_PROFILE_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_CREATE_PROJECT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_OPEN_PROJECT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_REMOVE_PROJECT_CHANNEL);
      options.ipcMain.removeHandler(
        WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
      );
      options.ipcMain.removeHandler(WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_REMOVE_SESSION_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_SELECT_PROJECT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_SUBMIT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_INTERRUPT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_READ_USER_INPUT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_RESPOND_USER_INPUT_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_STEER_CHANNEL);
      options.ipcMain.removeHandler(
        WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
      );
      options.window.webContents.removeListener(
        "did-start-loading",
        reloadListener,
      );
      options.window.webContents.removeListener(
        "render-process-gone",
        terminalLifecycleListener,
      );
      options.window.webContents.removeListener(
        "destroyed",
        terminalLifecycleListener,
      );
      options.window.removeListener("closed", terminalLifecycleListener);
      endActiveObservation();
    },
  });
}

type DecodedProjectDirectoryChoice =
  | { readonly kind: "cancelled" }
  | { readonly kind: "selected"; readonly directory: string }
  | { readonly kind: "invalid" };

function decodeProjectDirectoryChoice(
  value: unknown,
): DecodedProjectDirectoryChoice {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== "canceled|filePaths"
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    const candidate = value as {
      readonly canceled?: unknown;
      readonly filePaths?: unknown;
    };
    if (typeof candidate.canceled !== "boolean" || !Array.isArray(candidate.filePaths)) {
      return Object.freeze({ kind: "invalid" });
    }
    if (candidate.canceled) {
      return candidate.filePaths.length === 0
        ? Object.freeze({ kind: "cancelled" })
        : Object.freeze({ kind: "invalid" });
    }
    const directory = candidate.filePaths[0];
    if (
      candidate.filePaths.length !== 1 ||
      typeof directory !== "string" ||
      directory.trim().length === 0 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(directory)
    ) {
      return Object.freeze({ kind: "invalid" });
    }
    return Object.freeze({ kind: "selected", directory });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

function owningSender(
  value: unknown,
  window: BrowserWindowBoundary,
): RendererSender | undefined {
  if (typeof value !== "object" || value === null || !("sender" in value)) {
    return undefined;
  }
  const sender = (value as { readonly sender?: unknown }).sender;
  return sender === window.webContents && !window.webContents.isDestroyed()
    ? window.webContents
    : undefined;
}
