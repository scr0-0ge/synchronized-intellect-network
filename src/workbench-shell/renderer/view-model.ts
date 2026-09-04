import type {
  ProjectCommandFailureCategory,
  ProjectCommandStatus,
} from "../../coordinator/index.ts";
import type {
  WorkbenchCommandView,
  WorkbenchCreateProjectResult,
  WorkbenchDirectInputRequest,
  WorkbenchDirectSessionProfileDefaultRequest,
  WorkbenchDirectSessionProfileDefaultResult,
  WorkbenchDirectSessionProfileLoadRequest,
  WorkbenchContinuationSessionProfileLoadRequest,
  WorkbenchAnyPublicDirectSessionProfileResult,
  WorkbenchHostedProjectResult,
  WorkbenchModelOption,
  WorkbenchOpenProjectResult,
  WorkbenchProjectHistoryAdoptionResult,
  WorkbenchProjectHistoryDiscoveryResult,
  WorkbenchProjectHistoryHideResult,
  WorkbenchProjectHistoryOption,
  WorkbenchProjectSelectionRequest,
  WorkbenchReplacementSessionProfileLoadRequest,
  WorkbenchProjectSelectionResult,
  WorkbenchProjectView,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchRuntimeEndpointId,
  WorkbenchRuntimeEndpointOption,
  WorkbenchSessionContextUsage,
  WorkbenchSubmissionResult,
  WorkbenchTimelineEvent,
} from "../contract.ts";
import {
  isValidWorkbenchDirectInput,
  publicRuntimeEndpointDiscovery,
} from "../contract.ts";
import { WORKBENCH_TURN_NOTIFICATION_LIMITS } from "../notification-bridge.ts";
import {
  statusCopy,
  failureCopy,
  eventTitleCopy,
} from "./copy/session-status-copy.ts";
import {
  liveWorkbenchCopy,
} from "./copy/shell-copy.ts";
import {
  directInputCopy,
  continuationInputCopy,
  unavailableInputCopy,
  unavailableProjectInputCopy,
  acceptedSessionUnavailableCopy,
  acceptedSubmissionFeedbackCopy,
  replacementProfileUnavailableCopy,
  runtimeNotLocatedCopy,
  profileFeedbackCopy,
} from "./copy/composer-copy.ts";
import {
  turnNotificationCopy,
  fallbackTurnTitleLabel,
} from "./copy/turn-notification-copy.ts";
import {
  endpointIdentityCopy,
  endpointStatusRowCopy,
  contextWindowTitleCopy,
  contextWindowAriaCopy,
  contextUsedTokensCopy,
  type EndpointRuntimeFamilyLabelText as RuntimeFamilyLabelText,
  type EndpointLabelText,
  type EndpointStatusRowLabelText as StatusRowLabelText,
} from "./copy/runtime-profile-copy.ts";
import {
  projectAcquisitionCopy,
  openingProjectFeedbackCopy,
} from "./copy/rail-copy.ts";
import {
  projectHistoryCopy,
  historyOrdinalCopy,
  noRecordedSessionsLabel,
  historyContentSummaryCopy,
  sizeBytesLabelCopy,
  sizeKbLabelCopy,
  sizeMbLabelCopy,
  historyAdoptionOutcomeCopy,
  adoptionBlockedWhileTurnCopy,
  historyHideOutcomeCopy,
} from "./copy/project-history-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import {
  presentationText,
  workbenchLocalizedText,
  type WorkbenchPresentationText,
} from "./presentation-text.ts";

export {
  statusCopy,
  failureCopy,
  liveWorkbenchCopy,
  directInputCopy,
  continuationInputCopy,
  unavailableInputCopy,
  unavailableProjectInputCopy,
  projectHistoryCopy,
};

export {
  runtimeNotLocatedCopy,
  replacementProfileUnavailableCopy,
  acceptedSessionUnavailableCopy,
};

export interface WorkbenchNewAgentSessionShortcutEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

export function isNewAgentSessionShortcut(
  event: WorkbenchNewAgentSessionShortcutEvent,
): boolean {
  return (
    event.key.toLowerCase() === "n" &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing
  );
}

export function isInterruptShortcut(
  event: WorkbenchNewAgentSessionShortcutEvent,
): boolean {
  return (
    event.key === "Escape" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing
  );
}

const catalogDefaultProfileLoadRequest = Object.freeze({
  kind: "catalog-default" as const,
});

const ownedText = workbenchLocalizedText;

/** Resolve renderer state copy at presentation time; opaque strings pass through. */
export const rendererStateText = presentationText;

export interface WorkbenchContextRingPresentation {
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly remainingTokens: number;
  readonly state: "normal" | "warn" | "critical";
  readonly title: string;
  readonly ariaLabel: string;
}

export function contextRingPresentation(
  context: WorkbenchSessionContextUsage | undefined,
  endpointAvailable: boolean,
): WorkbenchContextRingPresentation | null {
  if (
    !endpointAvailable ||
    context === undefined ||
    context.windowTokens === null ||
    context.windowTokens <= 0
  ) {
    return null;
  }
  const usedPercent = Math.min(
    100,
    Math.max(0, Math.round((context.usedTokens / context.windowTokens) * 100)),
  );
  const remainingPercent = 100 - usedPercent;
  const remainingTokens = Math.max(
    0,
    context.windowTokens - context.usedTokens,
  );
  const state =
    usedPercent >= 90 ? "critical" : usedPercent >= 75 ? "warn" : "normal";
  const remaining = remainingTokens.toLocaleString("en-US");
  const window = context.windowTokens.toLocaleString("en-US");
  return Object.freeze({
    usedPercent,
    remainingPercent,
    remainingTokens,
    state,
    title: contextWindowTitleCopy(remaining, window, usedPercent),
    ariaLabel: contextWindowAriaCopy(usedPercent),
  });
}

export function contextUsedTokensLabel(
  context: WorkbenchSessionContextUsage | undefined,
): string | null {
  return context === undefined
    ? null
    : contextUsedTokensCopy(context.usedTokens.toLocaleString("en-US"));
}

export type WorkbenchComposerPhase =
  | "idle"
  | "pending"
  | "accepted"
  | "error";

export interface WorkbenchComposerState {
  readonly draft: string;
  readonly phase: WorkbenchComposerPhase;
  readonly feedback: WorkbenchPresentationText | null;
}

export type WorkbenchDirectProfilePhase =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "runtime-not-located";

export type WorkbenchDefaultPreferencePhase =
  | "idle"
  | "pending"
  | "saved"
  | "error";

export interface WorkbenchDefaultPreferenceState {
  readonly phase: WorkbenchDefaultPreferencePhase;
  readonly feedback: WorkbenchPresentationText | null;
}

export interface WorkbenchDirectProfileState {
  readonly phase: WorkbenchDirectProfilePhase;
  readonly loadRequest: WorkbenchDirectSessionProfileLoadRequest | null;
  readonly result: WorkbenchAnyPublicDirectSessionProfileResult | null;
  readonly selectedEndpointKey: string | null;
  readonly selectedModelKey: string | null;
  readonly selectedWorkIntensityKey: string | null;
  readonly selectedExecutionModeKey: string | null;
  readonly selectedAccessModeKey: string | null;
  readonly feedback: WorkbenchPresentationText | null;
  readonly defaultPreference: WorkbenchDefaultPreferenceState;
}

export type WorkbenchNewSessionPhase =
  | "inactive"
  | "active"
  | "submitting"
  | "awaiting-visible";

export interface WorkbenchNewSessionState {
  readonly phase: WorkbenchNewSessionPhase;
  readonly baselineKeys: readonly string[];
  readonly visibleKey: string | null;
}

export type WorkbenchProjectSwitchPhase = "idle" | "pending" | "error";

export interface WorkbenchProjectSwitchState {
  readonly phase: WorkbenchProjectSwitchPhase;
  readonly targetIndex: number | null;
  readonly selectionAccepted: boolean;
  readonly viewArrived: boolean;
  readonly feedback: WorkbenchPresentationText | null;
}

export type WorkbenchProjectOpenPhase =
  | "idle"
  | "pending"
  | "opened"
  | "created"
  | "cancelled"
  | "recovery-required"
  | "error";

export interface WorkbenchProjectOpenState {
  readonly phase: WorkbenchProjectOpenPhase;
  readonly operation: "open" | "create" | null;
  readonly baselineSelectedIndex: number | null;
  readonly baselineSelectedSelectionKey: string | null;
  readonly baselineProjectCount: number;
  readonly pendingCurrentSelectionKeys: readonly string[];
  readonly resetRequired: boolean;
  readonly selectionAccepted: boolean;
  readonly viewArrived: boolean;
  readonly feedback: WorkbenchPresentationText | null;
}

export interface WorkbenchRendererState {
  readonly result: WorkbenchHostedProjectResult | null;
  readonly selectedKey: string | null;
  readonly composer: WorkbenchComposerState;
  readonly profile: WorkbenchDirectProfileState;
  readonly newSession: WorkbenchNewSessionState;
  readonly projectSwitch: WorkbenchProjectSwitchState;
  readonly projectOpen: WorkbenchProjectOpenState;
}

const initialDirectProfileState: WorkbenchDirectProfileState = Object.freeze({
  phase: "idle",
  loadRequest: null,
  result: null,
  selectedEndpointKey: null,
  selectedModelKey: null,
  selectedWorkIntensityKey: null,
  selectedExecutionModeKey: null,
  selectedAccessModeKey: null,
  feedback: null,
  defaultPreference: Object.freeze({
    phase: "idle",
    feedback: null,
  }),
});

const inactiveNewSessionState: WorkbenchNewSessionState = Object.freeze({
  phase: "inactive",
  baselineKeys: Object.freeze([]),
  visibleKey: null,
});

const idleProjectSwitchState: WorkbenchProjectSwitchState = Object.freeze({
  phase: "idle",
  targetIndex: null,
  selectionAccepted: false,
  viewArrived: false,
  feedback: null,
});

const idleProjectOpenState: WorkbenchProjectOpenState = Object.freeze({
  phase: "idle",
  operation: null,
  baselineSelectedIndex: null,
  baselineSelectedSelectionKey: null,
  baselineProjectCount: 0,
  pendingCurrentSelectionKeys: Object.freeze([]),
  resetRequired: false,
  selectionAccepted: false,
  viewArrived: false,
  feedback: null,
});

export const initialRendererState: WorkbenchRendererState = Object.freeze({
  result: null,
  selectedKey: null,
  composer: Object.freeze({
    draft: "",
    phase: "idle",
    feedback: null,
  }),
  profile: initialDirectProfileState,
  newSession: inactiveNewSessionState,
  projectSwitch: idleProjectSwitchState,
  projectOpen: idleProjectOpenState,
});

function projectSelectionResultText(
  result: WorkbenchProjectSelectionResult,
): WorkbenchPresentationText {
  if (result.ok) {
    if (result.status === "history-selection-required") {
      return ownedText(
        "project.choose-history",
        () => dynamicCopy.project.chooseHistory,
      );
    }
    return result.message === "Project was opened."
      ? ownedText("project.opened", () => dynamicCopy.project.opened)
      : ownedText(
          "project.opened-with-history",
          () => dynamicCopy.project.openedWithHistory,
        );
  }
  switch (result.error.category) {
    case "invalid-project-selection":
      return ownedText(
        "project.reload-selection",
        () => dynamicCopy.project.reloadSelection,
      );
    case "project-unavailable":
      return ownedText(
        "project.unavailable",
        () => dynamicCopy.project.projectUnavailable,
      );
    case "project-switch-unavailable":
      return ownedText(
        "project.switch-unavailable",
        () => dynamicCopy.project.switchUnavailable,
      );
  }
}

function openProjectResultText(
  result: WorkbenchOpenProjectResult,
): WorkbenchPresentationText {
  if (!result.ok) {
    return ownedText(
      "project.open-unavailable",
      () => dynamicCopy.project.openUnavailable,
    );
  }
  if (result.status === "history-selection-required") {
    return ownedText(
      "project.choose-history",
      () => dynamicCopy.project.chooseHistory,
    );
  }
  if (result.status === "cancelled") {
    return ownedText(
      "project.open-cancelled",
      () => dynamicCopy.project.openCancelled,
    );
  }
  return result.message === "Project was opened."
    ? ownedText("project.opened", () => dynamicCopy.project.opened)
    : ownedText(
        "project.opened-with-history",
        () => dynamicCopy.project.openedWithHistory,
      );
}

function profileLoadResultText(
  result: WorkbenchAnyPublicDirectSessionProfileResult,
): WorkbenchPresentationText {
  if (result.ok) {
    throw new Error("profile-load-success-has-no-failure-text");
  }
  switch (result.error.category) {
    case "runtime-not-located":
      return ownedText(
        "profile.runtime-not-located",
        () => runtimeNotLocatedCopy,
      );
    case "continuation-unavailable":
      return ownedText(
        "profile.continuation-unavailable",
        () => dynamicCopy.profile.continuationUnavailable,
      );
    case "continuation-model-unavailable":
      return ownedText(
        "profile.continuation-model-unavailable",
        () => dynamicCopy.profile.continuationModelUnavailable,
      );
    case "profile-unavailable":
      return ownedText(
        "profile.unavailable",
        () => dynamicCopy.profile.unavailable,
      );
  }
}

function defaultPreferenceResultText(
  result: WorkbenchDirectSessionProfileDefaultResult,
): WorkbenchPresentationText {
  if (result.ok) {
    return ownedText(
      "profile.default-saved",
      () => dynamicCopy.profile.defaultSaved,
    );
  }
  return result.error.category === "invalid-profile-selection"
    ? ownedText(
        "profile.reload-selection",
        () => dynamicCopy.profile.reloadSelection,
      )
    : ownedText(
        "profile.default-unavailable",
        () => dynamicCopy.profile.defaultUnavailable,
      );
}

function submissionResultText(
  result: WorkbenchSubmissionResult,
): WorkbenchPresentationText {
  if (result.ok) {
    return ownedText(
      "submission.accepted",
      () => dynamicCopy.submission.accepted,
    );
  }
  switch (result.error.category) {
    case "invalid-input":
      return ownedText(
        "submission.invalid-input",
        () => dynamicCopy.submission.invalidInput,
      );
    case "invalid-profile-selection":
      return ownedText(
        "submission.profile-unavailable",
        () => dynamicCopy.submission.profileUnavailable,
      );
    case "continuation-unavailable":
      return ownedText(
        "submission.continuation-unavailable",
        () => dynamicCopy.submission.continuationUnavailable,
      );
    case "submission-unavailable":
      return ownedText(
        "submission.unavailable",
        () => dynamicCopy.submission.unavailable,
      );
  }
}

export function replaceProjectResult(
  state: WorkbenchRendererState,
  result: WorkbenchHostedProjectResult,
): WorkbenchRendererState {
  if (!result.ok) {
    const preserveAcquisitionScope =
      state.projectOpen.phase === "pending" ||
      state.projectOpen.phase === "recovery-required";
    return Object.freeze({
      result:
        preserveAcquisitionScope ? state.result : result,
      selectedKey:
        preserveAcquisitionScope ? state.selectedKey : null,
      composer: state.composer,
      profile: state.profile,
      newSession: state.newSession,
      projectSwitch:
        state.projectSwitch.phase === "pending"
          ? Object.freeze({
              phase: "error" as const,
              targetIndex: state.projectSwitch.targetIndex,
              selectionAccepted: false,
              viewArrived: false,
              feedback: ownedText(
                "project.live-unavailable",
                () => dynamicCopy.project.liveUnavailable,
              ),
            })
          : state.projectSwitch,
      projectOpen:
        state.projectOpen.phase === "pending"
          ? Object.freeze({
              ...state.projectOpen,
              feedback: ownedText(
                "project.live-unavailable",
                () => dynamicCopy.project.liveUnavailable,
              ),
            })
          : state.projectOpen,
    });
  }
  const targetProject =
    state.projectSwitch.phase === "pending" &&
    state.projectSwitch.targetIndex !== null
      ? result.view.projectSelection.projects[state.projectSwitch.targetIndex]
      : undefined;
  const switchedProjectArrived = targetProject?.selected === true;
  let selectedKey = refreshedSelection(state, result.view);
  let profile = state.profile;
  let newSession = state.newSession;
  let composer = state.composer;
  let projectSwitch = state.projectSwitch;
  let projectOpen = state.projectOpen;
  if (switchedProjectArrived) {
    selectedKey = initialSelection(result.view);
    profile = initialDirectProfileState;
    newSession = inactiveNewSessionState;
    composer = Object.freeze({
      draft: "",
      phase: "idle" as const,
      feedback: null,
    });
    projectSwitch = state.projectSwitch.selectionAccepted
      ? idleProjectSwitchState
      : Object.freeze({
          ...state.projectSwitch,
          viewArrived: true,
        });
  } else if (state.projectOpen.phase === "pending") {
    const selectedIndex = result.view.projectSelection.projects.findIndex(
      (project) => project.selected,
    );
    const selectedProject =
      selectedIndex < 0
        ? undefined
        : result.view.projectSelection.projects[selectedIndex];
    const targetChanged =
      selectedIndex !== state.projectOpen.baselineSelectedIndex ||
      result.view.projectSelection.projects.length !==
        state.projectOpen.baselineProjectCount;
    const currentSelectionKey = selectedProject?.selectionKey ?? null;
    const latestPendingCurrentSelectionKey =
      state.projectOpen.pendingCurrentSelectionKeys.at(-1) ?? null;
    const idempotentCurrentProjectArrived =
      state.projectOpen.operation === "open" &&
      !targetChanged &&
      currentSelectionKey !== null &&
      currentSelectionKey === latestPendingCurrentSelectionKey;
    if (targetChanged || idempotentCurrentProjectArrived) {
      if (
        (targetChanged || state.projectOpen.resetRequired) &&
        state.projectOpen.selectionAccepted
      ) {
        selectedKey = initialSelection(result.view);
        profile = initialDirectProfileState;
        newSession = inactiveNewSessionState;
        composer = Object.freeze({
          draft: "",
          phase: "idle" as const,
          feedback: null,
        });
      } else {
        selectedKey = state.selectedKey;
      }
      projectOpen = Object.freeze({
        ...state.projectOpen,
        phase: state.projectOpen.selectionAccepted
          ? state.projectOpen.operation === "create"
            ? ("created" as const)
            : ("opened" as const)
          : ("pending" as const),
        viewArrived: true,
        feedback: ownedText(
          state.projectOpen.selectionAccepted
            ? state.projectOpen.operation === "create"
              ? "project.created"
              : "project.opened"
            : state.projectOpen.operation === "create"
              ? "project.create-view-arrived"
              : "project.open-view-arrived",
          () => state.projectOpen.selectionAccepted
          ? state.projectOpen.operation === "create"
            ? projectAcquisitionCopy.created
            : projectAcquisitionCopy.opened
          : state.projectOpen.operation === "create"
            ? projectAcquisitionCopy.viewArrivedFinishingCreate
            : projectAcquisitionCopy.viewArrivedFinishingOpen,
        ),
      });
    } else if (
      currentSelectionKey !== null &&
      !state.projectOpen.pendingCurrentSelectionKeys.includes(
        currentSelectionKey,
      )
    ) {
      projectOpen = Object.freeze({
        ...state.projectOpen,
        pendingCurrentSelectionKeys: Object.freeze([
          ...state.projectOpen.pendingCurrentSelectionKeys,
          currentSelectionKey,
        ]),
      });
    }
  } else if (state.projectOpen.phase === "recovery-required") {
    selectedKey = state.selectedKey;
  } else if (
    newSession.phase === "submitting" ||
    newSession.phase === "awaiting-visible"
  ) {
    const baseline = new Set(newSession.baselineKeys);
    const newlyVisible = result.view.commands.filter(
      (command) => !baseline.has(command.key),
    );
    const visibleCandidates = newlyVisible.filter(
      (command) =>
        command.session !== undefined,
    );
    const terminalWithoutSession =
      newlyVisible.length === 1 &&
      newlyVisible[0]?.session === undefined &&
      isTerminalCommandStatus(newlyVisible[0].status)
        ? newlyVisible[0]
        : undefined;
    const visible = visibleCandidates.length === 1
      ? visibleCandidates[0]
      : terminalWithoutSession;
    if (visible !== undefined) {
      selectedKey = visible.key;
      if (newSession.phase === "submitting") {
        newSession = Object.freeze({
          ...newSession,
          visibleKey: visible.key,
        });
      } else {
        newSession = inactiveNewSessionState;
        profile = initialDirectProfileState;
        if (visible.session === undefined) {
          composer = acceptedSessionUnavailableComposer(state.composer);
        }
      }
    }
  }
  const replacementLoadRequest = profile.loadRequest;
  if (
    profile.phase === "loading" &&
    replacementLoadRequest?.kind === "replacement-session" &&
    (result.view.observation.cursor !==
      replacementLoadRequest.sourceSnapshotCursor ||
      !result.view.commands.some(
        (command) => command.key === replacementLoadRequest.sourceSelectionKey,
      ))
  ) {
    profile = initialDirectProfileState;
  }
  const continuationLoadRequest = profile.loadRequest;
  const selectedContinuation = result.view.commands.find(
    (command) => command.key === selectedKey,
  );
  if (
    continuationLoadRequest?.kind === "continuation-session" &&
    (selectedContinuation === undefined ||
      (selectedContinuation.status !== "completed" &&
        selectedContinuation.failureCategory !== "interrupted") ||
      selectedContinuation.session?.resumable !== true ||
      selectedContinuation.session.selectionKey !==
        continuationLoadRequest.selectionKey)
  ) {
    profile = initialDirectProfileState;
  }
  return Object.freeze({
    result,
    selectedKey,
    composer,
    profile,
    newSession,
    projectSwitch,
    projectOpen,
  });
}

export function canOpenProject(state: WorkbenchRendererState): boolean {
  return (
    state.result !== null &&
    state.projectSwitch.phase !== "pending" &&
    state.projectOpen.phase !== "pending" &&
    state.composer.draft.length === 0 &&
    state.composer.phase !== "pending" &&
    state.profile.phase !== "loading" &&
    state.profile.defaultPreference.phase !== "pending" &&
    state.newSession.phase !== "submitting" &&
    state.newSession.phase !== "awaiting-visible"
  );
}

export function beginOpenProject(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  return beginProjectAcquisition(state, "open");
}

export function canCreateProject(state: WorkbenchRendererState): boolean {
  return canOpenProject(state) &&
    state.projectOpen.phase !== "recovery-required";
}

export function beginCreateProject(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  return beginProjectAcquisition(state, "create");
}

function beginProjectAcquisition(
  state: WorkbenchRendererState,
  operation: "open" | "create",
): WorkbenchRendererState {
  const allowed = operation === "open"
    ? canOpenProject(state)
    : canCreateProject(state);
  if (!allowed || state.result === null) return state;
  const currentView = state.result.ok ? state.result.view : undefined;
  const baselineSelectedIndex =
    currentView?.projectSelection.projects.findIndex(
      (project) => project.selected,
    ) ?? -1;
  const baselineSelectedProject =
    baselineSelectedIndex < 0
      ? undefined
      : currentView?.projectSelection.projects[baselineSelectedIndex];
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: state.profile,
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: Object.freeze({
      phase: "pending" as const,
      operation,
      baselineSelectedIndex:
        baselineSelectedIndex < 0 ? null : baselineSelectedIndex,
      baselineSelectedSelectionKey:
        baselineSelectedProject?.selectionKey ?? null,
      baselineProjectCount:
        currentView?.projectSelection.projects.length ?? 0,
      pendingCurrentSelectionKeys: Object.freeze(
        baselineSelectedProject === undefined
          ? []
          : [baselineSelectedProject.selectionKey],
      ),
      resetRequired:
        operation === "open" &&
        state.projectOpen.phase === "recovery-required",
      selectionAccepted: false,
      viewArrived: false,
      feedback: ownedText(
        operation === "create"
          ? "project.choose-create-location"
          : "project.choose-open-directory",
        () => operation === "create"
          ? projectAcquisitionCopy.chooseCreateLocation
          : projectAcquisitionCopy.chooseOpenDirectory,
      ),
    }),
  });
}

export function completeOpenProject(
  state: WorkbenchRendererState,
  result: WorkbenchOpenProjectResult,
): WorkbenchRendererState {
  if (
    state.projectOpen.phase !== "pending" ||
    state.projectOpen.operation !== "open"
  ) return state;
  let projectOpen: WorkbenchProjectOpenState;
  if (result.ok && result.status === "history-selection-required") {
    projectOpen = Object.freeze({
      ...state.projectOpen,
      viewArrived: false,
      selectionAccepted: false,
      feedback: openProjectResultText(result),
    });
  } else if (!result.ok || result.status === "cancelled") {
    projectOpen = state.projectOpen.resetRequired
      ? Object.freeze({
          ...state.projectOpen,
          phase: "recovery-required",
          selectionAccepted: false,
          feedback: ownedText(
            "project.recovery-still-required",
            () => projectAcquisitionCopy.recoveryStillRequired,
          ),
        })
      : !result.ok
        ? Object.freeze({
            ...state.projectOpen,
            phase: "error",
            selectionAccepted: false,
            feedback: openProjectResultText(result),
          })
        : Object.freeze({
            ...state.projectOpen,
            phase: "cancelled",
            selectionAccepted: false,
            feedback: openProjectResultText(result),
          });
  } else {
    projectOpen = state.projectOpen.viewArrived
      ? Object.freeze({
          ...state.projectOpen,
          phase: "opened",
          selectionAccepted: true,
          feedback: openProjectResultText(result),
        })
      : Object.freeze({
          ...state.projectOpen,
          selectionAccepted: true,
          feedback: ownedText(
            "project.opened-waiting-live-view",
            () => projectAcquisitionCopy.openedWaitingLiveView,
          ),
        });
  }
  return replaceCompletedProjectAcquisition(
    state,
    projectOpen,
    result.ok && result.status === "opened" &&
      state.projectOpen.viewArrived &&
      projectAcquisitionChangedTarget(state),
  );
}

export function completeCreateProject(
  state: WorkbenchRendererState,
  result: WorkbenchCreateProjectResult,
): WorkbenchRendererState {
  if (
    state.projectOpen.phase !== "pending" ||
    state.projectOpen.operation !== "create"
  ) return state;
  let projectOpen: WorkbenchProjectOpenState;
  switch (result.outcome) {
    case "cancelled":
      projectOpen = Object.freeze({
        ...state.projectOpen,
        phase: "cancelled",
        selectionAccepted: false,
        feedback: ownedText(
          "project.create-cancelled",
          () => projectAcquisitionCopy.createCancelled,
        ),
      });
      break;
    case "unavailable":
      projectOpen = Object.freeze({
        ...state.projectOpen,
        phase: "error",
        selectionAccepted: false,
        feedback: ownedText(
          "project.create-unavailable",
          () => projectAcquisitionCopy.createUnavailable,
        ),
      });
      break;
    case "created-recovery-required":
      projectOpen = Object.freeze({
        ...state.projectOpen,
        phase: "recovery-required",
        selectionAccepted: false,
        feedback: ownedText(
          "project.created-recovery-required",
          () => projectAcquisitionCopy.createdRecoveryRequired,
        ),
      });
      break;
    case "created":
      projectOpen = state.projectOpen.viewArrived
        ? Object.freeze({
            ...state.projectOpen,
            phase: "created",
            selectionAccepted: true,
            feedback: ownedText(
              "project.created",
              () => projectAcquisitionCopy.created,
            ),
          })
        : Object.freeze({
            ...state.projectOpen,
            selectionAccepted: true,
            feedback: ownedText(
              "project.created-waiting-live-view",
              () => projectAcquisitionCopy.createdWaitingLiveView,
            ),
          });
      break;
  }
  return replaceCompletedProjectAcquisition(
    state,
    projectOpen,
    result.outcome === "created" &&
      state.projectOpen.viewArrived &&
      projectAcquisitionChangedTarget(state),
  );
}

function replaceCompletedProjectAcquisition(
  state: WorkbenchRendererState,
  projectOpen: WorkbenchProjectOpenState,
  resetProjectScope: boolean,
): WorkbenchRendererState {
  return Object.freeze({
    result: state.result,
    selectedKey:
      resetProjectScope && state.result?.ok
        ? initialSelection(state.result.view)
        : state.selectedKey,
    composer: resetProjectScope
      ? Object.freeze({
          draft: "",
          phase: "idle" as const,
          feedback: null,
        })
      : state.composer,
    profile: resetProjectScope ? initialDirectProfileState : state.profile,
    newSession: resetProjectScope ? inactiveNewSessionState : state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen,
  });
}

function projectAcquisitionChangedTarget(
  state: WorkbenchRendererState,
): boolean {
  if (!state.result?.ok) return false;
  const selectedIndex = state.result.view.projectSelection.projects.findIndex(
    (project) => project.selected,
  );
  return state.projectOpen.resetRequired ||
    selectedIndex !== state.projectOpen.baselineSelectedIndex ||
    state.result.view.projectSelection.projects.length !==
      state.projectOpen.baselineProjectCount;
}

function projectOpenBlocksOrdinaryActions(
  state: WorkbenchRendererState,
): boolean {
  return state.projectOpen.phase === "pending" ||
    state.projectOpen.phase === "recovery-required";
}

export function canSelectProject(
  state: WorkbenchRendererState,
  targetIndex: number,
): boolean {
  if (
    !state.result?.ok ||
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state) ||
    state.composer.draft.length > 0 ||
    state.composer.phase === "pending" ||
    state.profile.phase === "loading" ||
    state.profile.defaultPreference.phase === "pending" ||
    state.newSession.phase === "submitting" ||
    state.newSession.phase === "awaiting-visible"
  ) {
    return false;
  }
  const project = state.result.view.projectSelection.projects[targetIndex];
  return (
    project !== undefined &&
    !project.selected &&
    project.availability === "available"
  );
}

export interface ProjectSelectionAttempt {
  readonly state: WorkbenchRendererState;
  readonly request: WorkbenchProjectSelectionRequest | null;
}

export function beginProjectSelection(
  state: WorkbenchRendererState,
  targetIndex: number,
): ProjectSelectionAttempt {
  if (!canSelectProject(state, targetIndex) || !state.result?.ok) {
    return Object.freeze({ state, request: null });
  }
  const project = state.result.view.projectSelection.projects[targetIndex];
  if (project === undefined) {
    return Object.freeze({ state, request: null });
  }
  return Object.freeze({
    state: Object.freeze({
      result: state.result,
      selectedKey: state.selectedKey,
      composer: state.composer,
      profile: state.profile,
      newSession: state.newSession,
      projectSwitch: Object.freeze({
        phase: "pending" as const,
        targetIndex,
        selectionAccepted: false,
        viewArrived: false,
        feedback: ownedText(
          "project.opening",
          () => openingProjectFeedbackCopy(project.label),
        ),
      }),
      projectOpen: state.projectOpen,
    }),
    request: Object.freeze({ selectionKey: project.selectionKey }),
  });
}

export function completeProjectSelection(
  state: WorkbenchRendererState,
  result: WorkbenchProjectSelectionResult,
): WorkbenchRendererState {
  if (state.projectSwitch.phase !== "pending") return state;
  if (!result.ok) {
    return Object.freeze({
      result: state.result,
      selectedKey: state.selectedKey,
      composer: state.composer,
      profile: state.profile,
      newSession: state.newSession,
      projectSwitch: Object.freeze({
        phase: "error" as const,
        targetIndex: state.projectSwitch.targetIndex,
        selectionAccepted: false,
        viewArrived: false,
        feedback: projectSelectionResultText(result),
      }),
      projectOpen: state.projectOpen,
    });
  }
  if (state.projectSwitch.viewArrived) {
    return Object.freeze({
      result: state.result,
      selectedKey: state.selectedKey,
      composer: state.composer,
      profile: state.profile,
      newSession: state.newSession,
      projectSwitch: idleProjectSwitchState,
      projectOpen: state.projectOpen,
    });
  }
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: state.profile,
    newSession: state.newSession,
    projectSwitch: Object.freeze({
      ...state.projectSwitch,
      selectionAccepted: true,
      feedback: ownedText(
        "project.opened-waiting-live-view",
        () => projectAcquisitionCopy.openedWaitingLiveView,
      ),
    }),
    projectOpen: state.projectOpen,
  });
}

export function selectProjectCommand(
  state: WorkbenchRendererState,
  key: string,
): WorkbenchRendererState {
  if (
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state) ||
    !state.result?.ok ||
    !state.result.view.commands.some((command) => command.key === key)
  ) {
    return state;
  }
  const returnsFromNewSession = state.newSession.phase !== "inactive";
  return Object.freeze({
    result: state.result,
    selectedKey: key,
    composer:
      state.newSession.phase === "active"
        ? resetComposer(state.composer)
        : state.composer,
    profile:
      returnsFromNewSession ||
      (key !== state.selectedKey &&
        (state.profile.loadRequest?.kind === "replacement-session" ||
          state.profile.loadRequest?.kind === "continuation-session"))
        ? initialDirectProfileState
        : state.profile,
    newSession: returnsFromNewSession
      ? inactiveNewSessionState
      : state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

/**
 * Fixed copy for the Project-histories panel lives in copy/project-history-copy
 * and is re-exported above; every sentence there is load-bearing. The owner is
 * being asked to change which recorded conversation a Project shows, and the
 * only reason that is safe to offer is that choosing writes only Project
 * Registry state: no history is copied, merged or deleted, and every unchosen
 * history stays where it is.
 */

/** One history row, already reduced to the strings the panel renders. */
export interface WorkbenchProjectHistoryRow {
  readonly historyKey: string;
  readonly current: boolean;
  /** Ordinal within the snapshot, newest first; the panel never shows a slot. */
  readonly ordinalLabel: string;
  readonly contentLabel: string;
  readonly sizeLabel: string;
  readonly lastModifiedLabel: string;
  readonly adoptable: boolean;
  readonly hideable: boolean;
}

/**
 * Projects a discovery snapshot into rows. Counts and dates only — the public
 * snapshot carries no Session name, no prompt, no reply and no path, so there
 * is nothing here that could leak one.
 */
export function projectHistoryRows(
  result: WorkbenchProjectHistoryDiscoveryResult,
): readonly WorkbenchProjectHistoryRow[] {
  if (result.status !== "discovered") return Object.freeze([]);
  return Object.freeze(
    result.snapshot.histories.map((history, index) =>
      Object.freeze({
        historyKey: history.historyKey,
        current: history.current,
        ordinalLabel: historyOrdinalCopy(index + 1),
        contentLabel: projectHistoryContentLabel(history),
        sizeLabel: projectHistorySizeLabel(history.byteSize),
        lastModifiedLabel: history.lastModified.replace("T", " "),
        adoptable: !history.current,
        hideable: !history.current && history.sessionCount === 0,
      }),
    ),
  );
}

function projectHistoryContentLabel(
  history: WorkbenchProjectHistoryOption,
): string {
  if (history.sessionCount === 0 && history.commandCount === 0) {
    return noRecordedSessionsLabel;
  }
  return historyContentSummaryCopy(
    history.sessionCount,
    history.commandCount,
    history.updateCount,
  );
}

function projectHistorySizeLabel(byteSize: number): string {
  if (byteSize < 1_024) return sizeBytesLabelCopy(byteSize);
  if (byteSize < 1_024 * 1_024) {
    return sizeKbLabelCopy(Math.round(byteSize / 1_024));
  }
  return sizeMbLabelCopy((byteSize / (1_024 * 1_024)).toFixed(1));
}

export interface WorkbenchProjectHistoryFeedback {
  readonly tone: "status" | "alert";
  readonly message: WorkbenchPresentationText;
}

/** Fixed copy for every adoption outcome, stating what did and did not change. */
export function projectHistoryAdoptionFeedback(
  result: WorkbenchProjectHistoryAdoptionResult,
): WorkbenchProjectHistoryFeedback {
  if (result.status === "adopted") {
    return Object.freeze({
      tone: "status" as const,
      message: ownedText(
        "project-history.adopted",
        () => historyAdoptionOutcomeCopy.adopted,
      ),
    });
  }
  if (result.status === "blocked") {
    return Object.freeze({
      tone: "alert" as const,
      message: ownedText(
        `project-history.blocked.${result.activity}`,
        () => result.activity === "unknown"
          ? historyAdoptionOutcomeCopy.blockedUnknown
          : adoptionBlockedWhileTurnCopy(
              result.activity === "accepted"
                ? historyAdoptionOutcomeCopy.turnStartingWord
                : historyAdoptionOutcomeCopy.turnRunningWord,
            ),
      ),
    });
  }
  return Object.freeze({
    tone: "alert" as const,
    message: ownedText(
      result.status === "invalid-selection"
        ? "project-history.invalid-selection"
        : "project-history.switch-failed",
      () => result.status === "invalid-selection"
        ? historyAdoptionOutcomeCopy.invalidSelection
        : historyAdoptionOutcomeCopy.switchFailed,
    ),
  });
}

/** Fixed copy for every empty-history visibility outcome. */
export function projectHistoryHideFeedback(
  result: WorkbenchProjectHistoryHideResult,
): WorkbenchProjectHistoryFeedback {
  if (result.status === "hidden") {
    return Object.freeze({
      tone: "status" as const,
      message: ownedText(
        "project-history.hidden",
        () => historyHideOutcomeCopy.hidden,
      ),
    });
  }
  if (result.status === "ineligible") {
    return Object.freeze({
      tone: "alert" as const,
      message: ownedText(
        "project-history.ineligible",
        () => historyHideOutcomeCopy.ineligible,
      ),
    });
  }
  return Object.freeze({
    tone: "alert" as const,
    message: ownedText(
      result.status === "invalid-selection"
        ? "project-history.invalid-selection"
        : "project-history.hide-failed",
      () => result.status === "invalid-selection"
        ? historyHideOutcomeCopy.invalidSelection
        : historyHideOutcomeCopy.hideFailed,
    ),
  });
}

/* F211. The blocked panel used to say only THAT its exit was shut, in a sentence
   naming "another action still settling" — a cause not one of the terms below
   tests. The owner read it and refuted it: he asked why a Session already running
   should stop him opening another, and it does not. Nothing here observes a
   running turn.

   So the terms are named one by one and the decision yields WHICH refused rather
   than merely that one did. `canEnterNewAgentSessionMode` is that same decision
   seen as a predicate — never a second copy of it, or F207 returns wearing a
   sentence instead of a button. The order is the order the old conjunction
   evaluated in, so the term reported is the term that shut the door first. */
export type WorkbenchNewAgentSessionRefusal =
  | "project-view-failed"
  | "project-switch-pending"
  | "project-open-pending"
  | "project-open-recovery-required"
  | "project-has-no-commands"
  | "new-session-already-starting"
  | "message-awaiting-acceptance"
  | "catalog-loading"
  | "default-preference-saving";

export function newAgentSessionModeRefusal(
  state: WorkbenchRendererState,
): WorkbenchNewAgentSessionRefusal | null {
  if (state.result?.ok !== true) return "project-view-failed";
  if (state.projectSwitch.phase === "pending") return "project-switch-pending";
  /* Routed through the shared helper rather than restating its two phases, so
     the set of project-open phases that block cannot drift from the set this
     names. Only the naming is done here. */
  if (projectOpenBlocksOrdinaryActions(state)) {
    return state.projectOpen.phase === "recovery-required"
      ? "project-open-recovery-required"
      : "project-open-pending";
  }
  if (state.result.view.commands.length === 0) return "project-has-no-commands";
  if (state.newSession.phase !== "inactive") return "new-session-already-starting";
  if (state.composer.phase === "pending") return "message-awaiting-acceptance";
  if (state.profile.phase === "loading") return "catalog-loading";
  if (state.profile.defaultPreference.phase === "pending") {
    return "default-preference-saving";
  }
  return null;
}

export function canEnterNewAgentSessionMode(
  state: WorkbenchRendererState,
): boolean {
  return newAgentSessionModeRefusal(state) === null;
}

export function enterNewAgentSessionMode(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  if (!canEnterNewAgentSessionMode(state)) return state;
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: resetComposer(state.composer),
    profile: initialDirectProfileState,
    newSession: Object.freeze({
      phase: "active" as const,
      baselineKeys: Object.freeze([]),
      visibleKey: null,
    }),
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

/* The exit's refusal: the eight terms above plus the handler's own two. The
   panel says which of these shut it, so every member is a sentence a user has to
   be able to read and act on, not an internal code. */
export type WorkbenchReplacementSessionRefusal =
  | WorkbenchNewAgentSessionRefusal
  | "no-selection"
  | "selection-not-in-project";

export function replacementSessionRefusal(
  state: WorkbenchRendererState,
): WorkbenchReplacementSessionRefusal | null {
  const modeRefusal = newAgentSessionModeRefusal(state);
  if (modeRefusal !== null) return modeRefusal;
  if (!state.result?.ok) return "project-view-failed";
  if (state.selectedKey === null) return "no-selection";
  if (
    !state.result.view.commands.some(
      (command) => command.key === state.selectedKey,
    )
  ) {
    return "selection-not-in-project";
  }
  return null;
}

/* F207. The blocked composer's only exit used to decide its availability twice.
   The control tested one member of one phase union; `enterReplacementSession`
   tested this whole condition — `canEnterNewAgentSessionMode` plus two selection
   terms of its own. Across the rendered phase product that disagreed in 11,440
   of the 12,160 states in which the control was offered, and in every one of
   them the click could not change the stage by a character.

   The two must not be able to drift apart again, so there is now one function
   and both read it. It yields the request rather than a boolean because the
   caller needs the selection it just validated; `canEnterReplacementSession` is
   the same decision seen as a predicate, never a second copy of it. */
export function replacementSessionRequest(
  state: WorkbenchRendererState,
): WorkbenchReplacementSessionProfileLoadRequest | null {
  if (replacementSessionRefusal(state) !== null) return null;
  /* Narrowing, not a decision: `replacementSessionRefusal` has already refused
     every state in which either of these could be absent, and
     `blocked-composer-reason-fidelity.test.ts` sweeps that they never disagree.
     A term written here that is NOT up there is the F207 defect again. */
  if (!state.result?.ok || state.selectedKey === null) return null;
  return Object.freeze({
    kind: "replacement-session" as const,
    sourceSelectionKey: state.selectedKey,
    sourceSnapshotCursor: state.result.view.observation.cursor,
  });
}

export function canEnterReplacementSession(
  state: WorkbenchRendererState,
): boolean {
  return replacementSessionRequest(state) !== null;
}

export function canCancelNewAgentSessionMode(
  state: WorkbenchRendererState,
): boolean {
  return (
    state.newSession.phase !== "inactive" &&
    state.projectSwitch.phase !== "pending" &&
    state.projectOpen.phase !== "pending"
  );
}

export function cancelNewAgentSessionMode(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  if (!canCancelNewAgentSessionMode(state)) return state;
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer:
      state.newSession.phase === "active"
        ? resetComposer(state.composer)
        : state.composer,
    profile: initialDirectProfileState,
    newSession: inactiveNewSessionState,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

export function updateDirectInputDraft(
  state: WorkbenchRendererState,
  draft: string,
): WorkbenchRendererState {
  if (
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state) ||
    state.composer.phase === "pending"
  ) return state;
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: Object.freeze({
      draft,
      phase: "idle" as const,
      feedback: null,
    }),
    profile: state.profile,
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

export function beginDirectSessionProfileLoad(
  state: WorkbenchRendererState,
  request: WorkbenchDirectSessionProfileLoadRequest =
    catalogDefaultProfileLoadRequest,
): WorkbenchRendererState {
  if (
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state) ||
    state.composer.phase === "pending" ||
    state.profile.phase === "loading" ||
    state.profile.phase === "runtime-not-located" ||
    state.profile.defaultPreference.phase === "pending" ||
    !directSessionProfileLoadMatchesMode(state, request) ||
    state.newSession.phase === "submitting" ||
    state.newSession.phase === "awaiting-visible"
  ) {
    return state;
  }
  return directSessionProfileLoadingState(state, request);
}

export function continuationDirectSessionProfileLoadRequest(
  state: WorkbenchRendererState,
): WorkbenchContinuationSessionProfileLoadRequest | null {
  if (directInputMode(state) !== "continue") return null;
  const selectionKey = selectedFromState(state)?.session?.selectionKey;
  return typeof selectionKey === "string"
    ? Object.freeze({
        kind: "continuation-session" as const,
        selectionKey,
      })
    : null;
}

/**
 * The continuation capability the renderer still owes the selected Session.
 *
 * A continuation is submittable only once `profile.loadRequest` is the
 * `continuation-session` request for the selected Session, so this decides when
 * that load has to be issued. It deliberately does not ask whether the profile
 * is untouched: after a first turn completes the profile is `ready` and still
 * holds the `catalog-default` request that started the Session, and that state
 * — not a fresh mount — is where a second message is actually written. Gating
 * the load on an idle profile is what left Send permanently disabled there
 * (F219); the request identity is what decides, so switching Sessions reloads
 * and an already-loaded continuation does not.
 *
 * Returning `null` whenever `beginDirectSessionProfileLoad` would be a no-op
 * keeps the caller's effect from re-issuing a load it cannot start.
 */
export function pendingContinuationDirectSessionProfileLoad(
  state: WorkbenchRendererState,
): WorkbenchContinuationSessionProfileLoadRequest | null {
  const request = continuationDirectSessionProfileLoadRequest(state);
  if (request === null) return null;
  const current = state.profile.loadRequest;
  if (
    current !== null &&
    current !== undefined &&
    sameDirectSessionProfileLoadRequest(current, request)
  ) {
    return null;
  }
  return beginDirectSessionProfileLoad(state, request) === state
    ? null
    : request;
}

function directSessionProfileLoadMatchesMode(
  state: WorkbenchRendererState,
  request: WorkbenchDirectSessionProfileLoadRequest,
): boolean {
  if (request.kind !== "continuation-session") {
    return directInputMode(state) === "start";
  }
  const expected = continuationDirectSessionProfileLoadRequest(state);
  return expected?.kind === "continuation-session" &&
    expected.selectionKey === request.selectionKey;
}

export function canRefreshDirectSessionProfileFromProviders(
  state: WorkbenchRendererState,
): boolean {
  return (
    state.projectSwitch.phase !== "pending" &&
    !projectOpenBlocksOrdinaryActions(state) &&
    state.composer.phase !== "pending" &&
    state.profile.phase !== "loading" &&
    state.profile.defaultPreference.phase !== "pending" &&
    state.newSession.phase !== "submitting" &&
    state.newSession.phase !== "awaiting-visible"
  );
}

export function beginDirectSessionProfileRefreshFromProviders(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  return canRefreshDirectSessionProfileFromProviders(state)
    ? directSessionProfileLoadingState(state, catalogDefaultProfileLoadRequest)
    : state;
}

export function cancelDirectSessionProfileLoad(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  if (state.profile.phase !== "loading") return state;
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: initialDirectProfileState,
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

export function prepareDirectSessionProfileForProjectSurface(
  state: WorkbenchRendererState,
): WorkbenchRendererState {
  const cancelled = cancelDirectSessionProfileLoad(state);
  const expected = continuationDirectSessionProfileLoadRequest(cancelled);
  if (
    expected === null ||
    cancelled.profile.phase === "idle" ||
    (cancelled.profile.loadRequest?.kind === "continuation-session" &&
      cancelled.profile.loadRequest.selectionKey === expected.selectionKey)
  ) {
    return cancelled;
  }
  return Object.freeze({
    result: cancelled.result,
    selectedKey: cancelled.selectedKey,
    composer: cancelled.composer,
    profile: initialDirectProfileState,
    newSession: cancelled.newSession,
    projectSwitch: cancelled.projectSwitch,
    projectOpen: cancelled.projectOpen,
  });
}

function directSessionProfileLoadingState(
  state: WorkbenchRendererState,
  request: WorkbenchDirectSessionProfileLoadRequest,
): WorkbenchRendererState {
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: Object.freeze({
      phase: "loading" as const,
      loadRequest: request,
      result: null,
      selectedEndpointKey: null,
      selectedModelKey: null,
      selectedWorkIntensityKey: null,
      selectedExecutionModeKey: null,
      selectedAccessModeKey: null,
      feedback: ownedText(
        "profile.loading-options",
        () => profileFeedbackCopy.loadingOptions,
      ),
      defaultPreference: Object.freeze({
        phase: "idle" as const,
        feedback: null,
      }),
    }),
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

export function completeDirectSessionProfileLoad(
  state: WorkbenchRendererState,
  result: WorkbenchAnyPublicDirectSessionProfileResult,
  request: WorkbenchDirectSessionProfileLoadRequest =
    state.profile.loadRequest ?? catalogDefaultProfileLoadRequest,
): WorkbenchRendererState {
  if (
    state.profile.phase !== "loading" ||
    state.profile.loadRequest === null ||
    !sameDirectSessionProfileLoadRequest(state.profile.loadRequest, request)
  ) {
    return state;
  }
  if (!result.ok) {
    return Object.freeze({
      result: state.result,
      selectedKey: state.selectedKey,
      composer: state.composer,
      profile: Object.freeze({
        phase:
          result.error.category === "runtime-not-located"
            ? ("runtime-not-located" as const)
            : ("unavailable" as const),
        loadRequest: request,
        result,
        selectedEndpointKey: null,
        selectedModelKey: null,
        selectedWorkIntensityKey: null,
        selectedExecutionModeKey: null,
        selectedAccessModeKey: null,
        feedback: profileLoadResultText(result),
        defaultPreference: Object.freeze({
          phase: "idle" as const,
          feedback: null,
        }),
      }),
      newSession: state.newSession,
      projectSwitch: state.projectSwitch,
      projectOpen: state.projectOpen,
    });
  }
  const desired =
    request.kind === "replacement-session"
      ? "replacementPrefill" in result.profile
        ? result.profile.replacementPrefill
        : undefined
      : request.kind === "continuation-session"
        ? "continuationPrefill" in result.profile
          ? result.profile.continuationPrefill
          : undefined
        : "desiredDefault" in result.profile
          ? result.profile.desiredDefault
          : undefined;
  if (desired === undefined) return state;
  const selectedEndpointKey =
    desired.kind === "resolved" ? desired.endpointKey : null;
  const selectedModelKey =
    desired.kind === "resolved" ? desired.modelKey : null;
  const selectedWorkIntensityKey =
    desired.kind === "resolved" ? desired.workIntensityKey : null;
  const selectedExecutionModeKey =
    desired.kind === "resolved" ? desired.executionModeKey : null;
  const selectedAccessModeKey =
    desired.kind === "resolved" ? desired.accessModeKey : null;
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: Object.freeze({
      phase: "ready" as const,
      loadRequest: request,
      result,
      selectedEndpointKey,
      selectedModelKey,
      selectedWorkIntensityKey,
      selectedExecutionModeKey,
      selectedAccessModeKey,
      feedback: ownedText(
        desired.kind === "resolved"
          ? request.kind === "replacement-session"
            ? "profile.recorded-selected"
            : request.kind === "continuation-session"
              ? "profile.continuation-selected"
              : "profile.desired-selected"
          : request.kind === "replacement-session"
            ? "profile.replacement-unavailable"
            : "profile.choose-model-intensity",
        () => desired.kind === "resolved"
          ? request.kind === "replacement-session"
            ? profileFeedbackCopy.recordedSelected
            : request.kind === "continuation-session"
              ? profileFeedbackCopy.continuationSelected
              : profileFeedbackCopy.desiredSelected
          : request.kind === "replacement-session"
            ? replacementProfileUnavailableCopy
            : profileFeedbackCopy.chooseModelAndIntensity,
      ),
      defaultPreference: Object.freeze({
        phase: "idle" as const,
        feedback: null,
      }),
    }),
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

export function selectDirectEndpoint(
  state: WorkbenchRendererState,
  endpointKey: string,
): WorkbenchRendererState {
  if (
    directProfileSelectionIsLocked(state) ||
    state.profile.loadRequest?.kind === "continuation-session"
  ) return state;
  const endpoint = directProfileEndpoints(state).find(
    (candidate) => candidate.key === endpointKey,
  );
  if (endpoint === undefined) return state;
  const model =
    endpoint.models.find(
      (candidate) => candidate.key === state.profile.selectedModelKey,
    ) ?? endpoint.models[0];
  const selectedWorkIntensityKey = model?.workIntensities.some(
    (option) => option.key === state.profile.selectedWorkIntensityKey,
  )
    ? state.profile.selectedWorkIntensityKey
    : (model?.workIntensities[0]?.key ?? null);
  const selectedExecutionModeKey = executionModeForDirectSelection(
    endpoint,
    model,
    selectedWorkIntensityKey,
    state.profile.selectedExecutionModeKey,
    selectedDirectWorkIntensity(state)?.impliedExecutionModeKey !== undefined,
  );
  const selectedAccessModeKey = endpoint.accessModes.some(
    (option) => option.key === state.profile.selectedAccessModeKey,
  )
    ? state.profile.selectedAccessModeKey
    : (endpoint.accessModes[0]?.key ?? null);
  return replaceDirectProfileSelection(state, {
    selectedEndpointKey: endpoint.key,
    selectedModelKey: model?.key ?? null,
    selectedWorkIntensityKey,
    selectedExecutionModeKey,
    selectedAccessModeKey,
  });
}

export function selectDirectModel(
  state: WorkbenchRendererState,
  modelKey: string,
): WorkbenchRendererState {
  if (directProfileSelectionIsLocked(state)) return state;
  const model = directProfileModels(state).find(
    (candidate) => candidate.key === modelKey,
  );
  if (model === undefined) return state;
  const selectedWorkIntensityKey =
    model.key === state.profile.selectedModelKey
      ? state.profile.selectedWorkIntensityKey
      : (model.workIntensities[0]?.key ?? null);
  const endpoint = selectedDirectEndpoint(state);
  if (endpoint === undefined) return state;
  const continuation = state.profile.loadRequest?.kind ===
    "continuation-session";
  return replaceDirectProfileSelection(state, {
    selectedEndpointKey: state.profile.selectedEndpointKey,
    selectedModelKey: model.key,
    selectedWorkIntensityKey,
    selectedExecutionModeKey: continuation
      ? state.profile.selectedExecutionModeKey
      : executionModeForDirectSelection(
          endpoint,
          model,
          selectedWorkIntensityKey,
          state.profile.selectedExecutionModeKey,
          selectedDirectWorkIntensity(state)?.impliedExecutionModeKey !== undefined,
        ),
    selectedAccessModeKey: state.profile.selectedAccessModeKey,
  });
}

export function selectDirectWorkIntensity(
  state: WorkbenchRendererState,
  workIntensityKey: string,
): WorkbenchRendererState {
  if (directProfileSelectionIsLocked(state)) return state;
  const model = selectedDirectModel(state);
  const endpoint = selectedDirectEndpoint(state);
  if (
    endpoint === undefined ||
    model === undefined ||
    !model.workIntensities.some((option) => option.key === workIntensityKey)
  ) {
    return state;
  }
  return replaceDirectProfileSelection(state, {
    selectedEndpointKey: state.profile.selectedEndpointKey,
    selectedModelKey: model.key,
    selectedWorkIntensityKey: workIntensityKey,
    selectedExecutionModeKey:
      state.profile.loadRequest?.kind === "continuation-session"
        ? state.profile.selectedExecutionModeKey
        : executionModeForDirectSelection(
            endpoint,
            model,
            workIntensityKey,
            state.profile.selectedExecutionModeKey,
            selectedDirectWorkIntensity(state)?.impliedExecutionModeKey !== undefined,
          ),
    selectedAccessModeKey: state.profile.selectedAccessModeKey,
  });
}

export function selectDirectExecutionMode(
  state: WorkbenchRendererState,
  executionModeKey: string,
): WorkbenchRendererState {
  if (
    directProfileSelectionIsLocked(state) ||
    state.profile.loadRequest?.kind === "continuation-session"
  ) return state;
  const endpoint = selectedDirectEndpoint(state);
  if (
    endpoint === undefined ||
    !endpoint.executionModes.some((option) => option.key === executionModeKey)
  ) {
    return state;
  }
  if (selectedDirectWorkIntensity(state)?.impliedExecutionModeKey !== undefined) {
    return state;
  }
  return replaceDirectProfileSelection(state, {
    selectedEndpointKey: endpoint.key,
    selectedModelKey: state.profile.selectedModelKey,
    selectedWorkIntensityKey: state.profile.selectedWorkIntensityKey,
    selectedExecutionModeKey: executionModeKey,
    selectedAccessModeKey: state.profile.selectedAccessModeKey,
  });
}

export function selectDirectAccessMode(
  state: WorkbenchRendererState,
  accessModeKey: string,
): WorkbenchRendererState {
  if (
    directProfileSelectionIsLocked(state) ||
    state.profile.loadRequest?.kind === "continuation-session"
  ) return state;
  const endpoint = selectedDirectEndpoint(state);
  if (
    endpoint === undefined ||
    !endpoint.accessModes.some((option) => option.key === accessModeKey)
  ) {
    return state;
  }
  return replaceDirectProfileSelection(state, {
    selectedEndpointKey: endpoint.key,
    selectedModelKey: state.profile.selectedModelKey,
    selectedWorkIntensityKey: state.profile.selectedWorkIntensityKey,
    selectedExecutionModeKey: state.profile.selectedExecutionModeKey,
    selectedAccessModeKey: accessModeKey,
  });
}

export function directProfileEndpoints(
  state: WorkbenchRendererState,
): readonly WorkbenchRuntimeEndpointOption[] {
  return state.profile.phase === "ready" && state.profile.result?.ok
    ? state.profile.result.profile.endpoints
    : [];
}

export interface WorkbenchRuntimeEndpointStatusRow {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly runtimeFamilyLabel: RuntimeFamilyLabelText;
  readonly endpointLabel: EndpointLabelText;
  readonly category: WorkbenchRuntimeEndpointDiscoveryCategory;
  readonly statusLabel: StatusRowLabelText;
  readonly detail: string;
  readonly endpoint: WorkbenchRuntimeEndpointOption | null;
}

export function directEndpointStatusRows(
  profile: WorkbenchDirectProfileState,
): readonly WorkbenchRuntimeEndpointStatusRow[] {
  const discovery =
    profile.result?.endpointDiscovery ??
    publicRuntimeEndpointDiscovery("not-inspected", "not-inspected");
  const endpoints = profile.result?.ok ? profile.result.profile.endpoints : [];
  return Object.freeze(
    discovery.statuses.map((status) => {
      const identity =
        status.endpointId === "codex-desktop"
          ? endpointIdentityCopy.codex
          : endpointIdentityCopy.claude;
      const catalogEndpoint = endpoints.find(
        (candidate) => candidate.endpointId === status.endpointId,
      );
      const category: WorkbenchRuntimeEndpointDiscoveryCategory =
        status.category === "catalog-ready" && catalogEndpoint === undefined
          ? "inspection-failed"
          : status.category;
      const endpoint =
        category === "catalog-ready" ? catalogEndpoint ?? null : null;
      return Object.freeze({
        endpointId: status.endpointId,
        ...identity,
        category,
        ...endpointStatusCopy(category),
        endpoint,
      });
    }),
  );
}

function endpointStatusCopy(
  category: WorkbenchRuntimeEndpointDiscoveryCategory,
): Pick<WorkbenchRuntimeEndpointStatusRow, "detail" | "statusLabel"> {
  return endpointStatusRowCopy[category];
}

export function selectedDirectEndpoint(
  state: WorkbenchRendererState,
): WorkbenchRuntimeEndpointOption | undefined {
  return directProfileEndpoints(state).find(
    (endpoint) => endpoint.key === state.profile.selectedEndpointKey,
  );
}

export function directProfileModels(
  state: WorkbenchRendererState,
): readonly WorkbenchModelOption[] {
  return selectedDirectEndpoint(state)?.models ?? [];
}

export function selectedDirectModel(
  state: WorkbenchRendererState,
): WorkbenchModelOption | undefined {
  return directProfileModels(state).find(
    (model) => model.key === state.profile.selectedModelKey,
  );
}

export function directWorkIntensityPresentationLabel(
  _model: WorkbenchModelOption | undefined,
  label: string | undefined,
): string | undefined {
  return label;
}

function selectedDirectWorkIntensity(state: WorkbenchRendererState) {
  return selectedDirectModel(state)?.workIntensities.find(
    (option) => option.key === state.profile.selectedWorkIntensityKey,
  );
}

function executionModeForDirectSelection(
  endpoint: WorkbenchRuntimeEndpointOption,
  model: WorkbenchModelOption | undefined,
  workIntensityKey: string | null,
  currentExecutionModeKey: string | null,
  resetPreviouslyImpliedMode: boolean,
): string | null {
  const impliedExecutionModeKey = model?.workIntensities.find(
    (option) => option.key === workIntensityKey,
  )?.impliedExecutionModeKey;
  if (impliedExecutionModeKey !== undefined) {
    return endpoint.executionModes.some(
      (option) => option.key === impliedExecutionModeKey,
    )
      ? impliedExecutionModeKey
      : null;
  }
  if (
    !resetPreviouslyImpliedMode &&
    endpoint.executionModes.some(
      (option) => option.key === currentExecutionModeKey,
    )
  ) {
    return currentExecutionModeKey;
  }
  return endpoint.executionModes[0]?.key ?? null;
}

export function canSubmitDirectInput(state: WorkbenchRendererState): boolean {
  if (
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state) ||
    state.composer.phase === "pending" ||
    state.profile.defaultPreference.phase === "pending" ||
    state.newSession.phase === "submitting" ||
    state.newSession.phase === "awaiting-visible" ||
    !isValidWorkbenchDirectInput(state.composer.draft)
  ) {
    return false;
  }
  if (directInputMode(state) === "continue") {
    return state.profile.phase === "ready" &&
      state.profile.loadRequest?.kind === "continuation-session" &&
      directProfileSelectionIsComplete(state);
  }
  if (directInputMode(state) !== "start") return false;
  return (
    state.profile.phase === "ready" &&
    directProfileSelectionIsComplete(state)
  );
}

export function canUseDirectSessionProfileAsDefault(
  state: WorkbenchRendererState,
): boolean {
  return (
    state.projectSwitch.phase !== "pending" &&
    !projectOpenBlocksOrdinaryActions(state) &&
    directInputMode(state) === "start" &&
    state.profile.defaultPreference.phase !== "pending" &&
    state.profile.phase === "ready" &&
    state.profile.result?.ok === true &&
    directProfileSelectionIsComplete(state)
  );
}

export interface DirectSessionProfileDefaultSaveAttempt {
  readonly state: WorkbenchRendererState;
  readonly request: WorkbenchDirectSessionProfileDefaultRequest | null;
}

export function beginDirectSessionProfileDefaultSave(
  state: WorkbenchRendererState,
): DirectSessionProfileDefaultSaveAttempt {
  if (!canUseDirectSessionProfileAsDefault(state)) {
    return Object.freeze({ state, request: null });
  }
  const profile = state.profile.result;
  if (
    !profile?.ok ||
    state.profile.selectedEndpointKey === null ||
    state.profile.selectedModelKey === null ||
    state.profile.selectedWorkIntensityKey === null ||
    state.profile.selectedExecutionModeKey === null ||
    state.profile.selectedAccessModeKey === null
  ) {
    return Object.freeze({ state, request: null });
  }
  const nextState = Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: Object.freeze({
      ...state.profile,
      defaultPreference: Object.freeze({
        phase: "pending" as const,
        feedback: ownedText(
          "profile.saving-default",
          () => profileFeedbackCopy.savingDefault,
        ),
      }),
    }),
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
  return Object.freeze({
    state: nextState,
    request: Object.freeze({
      snapshotKey: profile.profile.snapshotKey,
      endpointKey: state.profile.selectedEndpointKey,
      modelKey: state.profile.selectedModelKey,
      workIntensityKey: state.profile.selectedWorkIntensityKey,
      executionModeKey: state.profile.selectedExecutionModeKey,
      accessModeKey: state.profile.selectedAccessModeKey,
    }),
  });
}

export function completeDirectSessionProfileDefaultSave(
  state: WorkbenchRendererState,
  result: WorkbenchDirectSessionProfileDefaultResult,
): WorkbenchRendererState {
  if (state.profile.defaultPreference.phase !== "pending") return state;
  let profileResult = state.profile.result;
  if (
    result.ok &&
    profileResult?.ok &&
    "desiredDefault" in profileResult.profile &&
    state.profile.selectedEndpointKey !== null &&
    state.profile.selectedModelKey !== null &&
    state.profile.selectedWorkIntensityKey !== null &&
    state.profile.selectedExecutionModeKey !== null &&
    state.profile.selectedAccessModeKey !== null
  ) {
    profileResult = Object.freeze({
      ok: true,
      endpointDiscovery: profileResult.endpointDiscovery,
      profile: Object.freeze({
        ...profileResult.profile,
        desiredDefault: Object.freeze({
          kind: "resolved" as const,
          endpointKey: state.profile.selectedEndpointKey,
          modelKey: state.profile.selectedModelKey,
          workIntensityKey: state.profile.selectedWorkIntensityKey,
          executionModeKey: state.profile.selectedExecutionModeKey,
          accessModeKey: state.profile.selectedAccessModeKey,
        }),
      }),
    });
  }
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: Object.freeze({
      ...state.profile,
      result: profileResult,
      defaultPreference: Object.freeze(
        result.ok
          ? {
              phase: "saved" as const,
              feedback: defaultPreferenceResultText(result),
            }
          : {
              phase: "error" as const,
              feedback: defaultPreferenceResultText(result),
        },
      ),
    }),
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

export interface DirectInputSubmissionAttempt {
  readonly state: WorkbenchRendererState;
  readonly request: WorkbenchDirectInputRequest | null;
}

export function beginDirectInputSubmission(
  state: WorkbenchRendererState,
): DirectInputSubmissionAttempt {
  if (!canSubmitDirectInput(state)) {
    return Object.freeze({ state, request: null });
  }
  const explicitNewSession =
    directInputMode(state) === "start" &&
    state.newSession.phase === "active";
  const newSession: WorkbenchNewSessionState = explicitNewSession
    ? Object.freeze({
        phase: "submitting" as const,
        baselineKeys: Object.freeze(
          state.result?.ok
            ? state.result.view.commands.map((command) => command.key)
            : [],
        ),
        visibleKey: null,
      })
    : state.newSession;
  const nextState = Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: Object.freeze({
      draft: state.composer.draft,
      phase: "pending" as const,
      feedback: ownedText(
        directInputMode(state) === "continue"
          ? "composer.continuation-pending"
          : "composer.direct-pending",
        () => directInputMode(state) === "continue"
          ? continuationInputCopy.pending
          : directInputCopy.pending,
      ),
    }),
    profile: state.profile,
    newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
  const selected = selectedFromState(state);
  if (
    directInputMode(state) === "continue" &&
    selected?.session?.selectionKey !== null &&
    selected?.session?.selectionKey !== undefined
  ) {
    return Object.freeze({
      state: nextState,
      request: Object.freeze({
        kind: "continue" as const,
        input: state.composer.draft,
        selectionKey: selected.session.selectionKey,
        snapshotKey: state.profile.result!.ok
          ? state.profile.result!.profile.snapshotKey
          : "",
        endpointKey: state.profile.selectedEndpointKey!,
        modelKey: state.profile.selectedModelKey!,
        workIntensityKey: state.profile.selectedWorkIntensityKey!,
        executionModeKey: state.profile.selectedExecutionModeKey!,
        accessModeKey: state.profile.selectedAccessModeKey!,
      }),
    });
  }
  const profile = state.profile.result;
  if (
    !profile?.ok ||
    state.profile.selectedEndpointKey === null ||
    state.profile.selectedModelKey === null ||
    state.profile.selectedWorkIntensityKey === null ||
    state.profile.selectedExecutionModeKey === null ||
    state.profile.selectedAccessModeKey === null
  ) {
    return Object.freeze({ state, request: null });
  }
  return Object.freeze({
    state: nextState,
    request: Object.freeze({
      kind: "start" as const,
      input: state.composer.draft,
      snapshotKey: profile.profile.snapshotKey,
      endpointKey: state.profile.selectedEndpointKey,
      modelKey: state.profile.selectedModelKey,
      workIntensityKey: state.profile.selectedWorkIntensityKey,
      executionModeKey: state.profile.selectedExecutionModeKey,
      accessModeKey: state.profile.selectedAccessModeKey,
    }),
  });
}

export function completeDirectInputSubmission(
  state: WorkbenchRendererState,
  result: WorkbenchSubmissionResult,
): WorkbenchRendererState {
  if (state.composer.phase !== "pending") return state;
  const explicitNewSession = state.newSession.phase === "submitting";
  const acceptedNewSession = explicitNewSession && result.ok;
  const visibleNewCommand =
    state.newSession.phase === "submitting" &&
    state.newSession.visibleKey !== null &&
    state.result?.ok
      ? state.result.view.commands.find(
          (command) => command.key === state.newSession.visibleKey,
        )
      : undefined;
  const acceptedWithoutSession =
    acceptedNewSession &&
    visibleNewCommand?.session === undefined &&
    visibleNewCommand !== undefined &&
    isTerminalCommandStatus(visibleNewCommand.status);
  const newSession: WorkbenchNewSessionState = !explicitNewSession
    ? state.newSession
    : result.ok
      ? state.newSession.visibleKey === null
        ? Object.freeze({
            ...state.newSession,
            phase: "awaiting-visible" as const,
          })
        : inactiveNewSessionState
      : Object.freeze({
          phase: "active" as const,
          baselineKeys: Object.freeze([]),
          visibleKey: null,
        });
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: Object.freeze(
      result.ok
        ? acceptedWithoutSession
          ? {
              draft: "",
              phase: "error" as const,
              feedback: ownedText(
                "composer.accepted-session-unavailable",
                () => acceptedSessionUnavailableCopy,
              ),
            }
          : {
              draft: "",
              phase: "accepted" as const,
              feedback: acceptedNewSession
                ? ownedText(
                    "composer.accepted-new-session",
                    () => acceptedSubmissionFeedbackCopy,
                  )
                : submissionResultText(result),
            }
        : {
            draft: state.composer.draft,
            phase: "error" as const,
            feedback: submissionResultText(result),
          },
      ),
    profile: acceptedNewSession ? initialDirectProfileState : state.profile,
    newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

interface DirectProfileSelectionState {
  readonly selectedEndpointKey: string | null;
  readonly selectedModelKey: string | null;
  readonly selectedWorkIntensityKey: string | null;
  readonly selectedExecutionModeKey: string | null;
  readonly selectedAccessModeKey: string | null;
}

function directProfileSelectionIsLocked(
  state: WorkbenchRendererState,
): boolean {
  return (
    state.composer.phase === "pending" ||
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state) ||
    state.profile.defaultPreference.phase === "pending"
  );
}

function directProfileSelectionIsComplete(
  state: WorkbenchRendererState,
): boolean {
  const endpoint = selectedDirectEndpoint(state);
  const model = selectedDirectModel(state);
  const workIntensity = selectedDirectWorkIntensity(state);
  const continuationPrefill =
    state.profile.loadRequest?.kind === "continuation-session" &&
      state.profile.result?.ok &&
      "continuationPrefill" in state.profile.result.profile
      ? state.profile.result.profile.continuationPrefill
      : undefined;
  return (
    endpoint !== undefined &&
    model !== undefined &&
    workIntensity !== undefined &&
    endpoint.executionModes.some(
      (option) => option.key === state.profile.selectedExecutionModeKey,
    ) &&
    (workIntensity.impliedExecutionModeKey === undefined ||
      workIntensity.impliedExecutionModeKey ===
        state.profile.selectedExecutionModeKey) &&
    endpoint.accessModes.some(
      (option) => option.key === state.profile.selectedAccessModeKey,
    ) &&
    (continuationPrefill === undefined ||
      (continuationPrefill.endpointKey ===
        state.profile.selectedEndpointKey &&
        continuationPrefill.executionModeKey ===
          state.profile.selectedExecutionModeKey &&
        continuationPrefill.accessModeKey ===
          state.profile.selectedAccessModeKey))
  );
}

function replaceDirectProfileSelection(
  state: WorkbenchRendererState,
  selection: DirectProfileSelectionState,
): WorkbenchRendererState {
  return Object.freeze({
    result: state.result,
    selectedKey: state.selectedKey,
    composer: state.composer,
    profile: Object.freeze({
      phase: state.profile.phase,
      loadRequest: state.profile.loadRequest,
      result: state.profile.result,
      ...selection,
      feedback: ownedText(
        selection.selectedEndpointKey === null
          ? "profile.choose-endpoint"
          : selection.selectedModelKey === null
            ? "profile.choose-model"
            : selection.selectedWorkIntensityKey === null
              ? "profile.choose-supported-intensity"
              : "profile.selection-ready",
        () => selection.selectedEndpointKey === null
          ? profileFeedbackCopy.chooseEndpoint
          : selection.selectedModelKey === null
            ? profileFeedbackCopy.chooseModel
            : selection.selectedWorkIntensityKey === null
              ? profileFeedbackCopy.chooseSupportedIntensity
              : profileFeedbackCopy.selectionReady,
      ),
      defaultPreference: Object.freeze({
        phase: "idle" as const,
        feedback: null,
      }),
    }),
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
  });
}

function sameDirectSessionProfileLoadRequest(
  left: WorkbenchDirectSessionProfileLoadRequest,
  right: WorkbenchDirectSessionProfileLoadRequest,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "catalog-default" ||
      (left.kind === "replacement-session" &&
        right.kind === "replacement-session" &&
        left.sourceSelectionKey === right.sourceSelectionKey &&
        left.sourceSnapshotCursor === right.sourceSnapshotCursor) ||
      (left.kind === "continuation-session" &&
        right.kind === "continuation-session" &&
        left.selectionKey === right.selectionKey))
  );
}

export function selectedCommand(
  view: WorkbenchProjectView,
  selectedKey: string | null,
): WorkbenchCommandView | undefined {
  const key = view.commands.some((command) => command.key === selectedKey)
    ? selectedKey
    : initialSelection(view);
  return view.commands.find((command) => command.key === key);
}

export function eventTitle(event: WorkbenchTimelineEvent): string {
  return eventTitleCopy[event.kind];
}

export type WorkbenchDirectInputMode = "start" | "continue" | "unavailable";

export function directInputMode(
  state: WorkbenchRendererState,
): WorkbenchDirectInputMode {
  if (
    state.projectSwitch.phase === "pending" ||
    projectOpenBlocksOrdinaryActions(state)
  ) return "unavailable";
  if (!state.result?.ok) return state.result === null ? "start" : "unavailable";
  if (
    state.result.view.projectSelection.projects.find(
      (project) => project.selected,
    )?.availability !== "available"
  ) {
    return "unavailable";
  }
  if (state.result.view.commands.length === 0) return "start";
  if (
    state.newSession.phase === "active" ||
    state.newSession.phase === "submitting"
  ) {
    return "start";
  }
  if (state.newSession.phase === "awaiting-visible") return "unavailable";
  const selected = selectedFromState(state);
  return selected?.session?.archived === false &&
    selected.session.resumable === true &&
    selected.session.selectionKey !== null &&
    (selected.status === "completed" ||
      selected.failureCategory === "interrupted")
    ? "continue"
    : "unavailable";
}

function resetComposer(
  composer: WorkbenchComposerState,
): WorkbenchComposerState {
  return Object.freeze({
    draft: composer.draft,
    phase: "idle",
    feedback: null,
  });
}

function acceptedSessionUnavailableComposer(
  composer: WorkbenchComposerState,
): WorkbenchComposerState {
  return Object.freeze({
    draft: composer.draft,
    phase: "error",
    feedback: ownedText(
      "composer.accepted-session-unavailable",
      () => acceptedSessionUnavailableCopy,
    ),
  });
}

function isTerminalCommandStatus(status: ProjectCommandStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "recovery-required"
  );
}

function selectedFromState(
  state: WorkbenchRendererState,
): WorkbenchCommandView | undefined {
  return state.result?.ok
    ? selectedCommand(state.result.view, state.selectedKey)
    : undefined;
}

export function displayValue(value: string): string {
  return value;
}

function initialSelection(view: WorkbenchProjectView): string | null {
  const active = view.commands.find(
    (command) => command.session?.archived === false,
  );
  const requested = view.commands.find(
    (command) => command.key === view.initialSelectionKey,
  );
  if (
    requested !== undefined &&
    (requested.session?.archived !== true || active === undefined)
  ) {
    return requested.key;
  }
  return active?.key ?? view.commands[0]?.key ?? null;
}

function refreshedSelection(
  state: WorkbenchRendererState,
  view: WorkbenchProjectView,
): string | null {
  const next = view.commands.find((command) => command.key === state.selectedKey);
  if (next === undefined) return initialSelection(view);
  const prior = state.result?.ok
    ? state.result.view.commands.find(
        (command) => command.key === state.selectedKey,
      )
    : undefined;
  if (
    prior?.session?.archived === false &&
    next.session?.archived === true
  ) {
    return (
      view.commands.find((command) => command.session?.archived === false)?.key ??
      next.key
    );
  }
  return next.key;
}

export type WorkbenchTurnTerminalOutcome =
  | "completed"
  | "failed"
  | "recovery-required";

export interface WorkbenchFinishedTurnNotice {
  readonly commandKey: string;
  readonly title: string;
  readonly body: string;
}

export interface WorkbenchTrackedTurnProgression {
  readonly notices: readonly WorkbenchFinishedTurnNotice[];
  readonly trackedStatuses: ReadonlyMap<string, ProjectCommandStatus>;
}

export function workbenchTurnOutcomeCopy(
  outcome: WorkbenchTurnTerminalOutcome,
): string {
  return turnNotificationCopy[outcome];
}

function terminalTurnOutcome(
  status: ProjectCommandStatus,
): WorkbenchTurnTerminalOutcome | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "recovery-required":
      return "recovery-required";
    default:
      return undefined;
  }
}

const ACTIVE_TURN_STATUSES: ReadonlySet<ProjectCommandStatus> = new Set([
  "accepted",
  "in-flight",
]);

function clampTurnNotificationText(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= maxLength
    ? value
    : `${codePoints.slice(0, maxLength - 1).join("")}…`;
}

/**
 * Pure diff between the previously observed command statuses and a fresh live
 * view. A notice is produced exactly once per command that leaves an active
 * status for a terminal one. The returned map always carries only the fresh
 * statuses so the caller can replace its tracking state even when it suppresses
 * delivery.
 */
export function advanceTrackedTurns(
  previous: ReadonlyMap<string, ProjectCommandStatus>,
  commands: readonly WorkbenchCommandView[],
): WorkbenchTrackedTurnProgression {
  const trackedStatuses = new Map<string, ProjectCommandStatus>();
  const notices: WorkbenchFinishedTurnNotice[] = [];
  for (const command of commands) {
    const before = previous.get(command.key);
    trackedStatuses.set(command.key, command.status);
    if (before === undefined || !ACTIVE_TURN_STATUSES.has(before)) continue;
    const outcome = terminalTurnOutcome(command.status);
    if (outcome === undefined) continue;
    if (command.failureCategory === "interrupted") continue;
    const trimmedLabel = command.label.trim();
    notices.push(
      Object.freeze({
        commandKey: command.key,
        title: clampTurnNotificationText(
          trimmedLabel.length > 0 ? trimmedLabel : fallbackTurnTitleLabel,
          WORKBENCH_TURN_NOTIFICATION_LIMITS.maxTitleLength,
        ),
        body: clampTurnNotificationText(
          workbenchTurnOutcomeCopy(outcome),
          WORKBENCH_TURN_NOTIFICATION_LIMITS.maxBodyLength,
        ),
      }),
    );
  }
  return Object.freeze({
    notices: Object.freeze(notices),
    trackedStatuses,
  });
}
