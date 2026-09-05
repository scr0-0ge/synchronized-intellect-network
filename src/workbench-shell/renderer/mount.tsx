import {
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Component,
} from "solid-js";
import { render } from "solid-js/web";
import { type SessionMetadataOperation } from "../../session-metadata.ts";
import type {
  WorkbenchCommandView,
  WorkbenchClaudePermissionHandling,
  WorkbenchDirectSessionProfileLoadRequest,
  WorkbenchAppearancePreference,
  WorkbenchHostedProjectResult,
  WorkbenchHostedProjectView,
  WorkbenchProjectHistoryDiscoveryResult,
  WorkbenchProjectOption,
  WorkbenchRendererBridge,
  WorkbenchRuntimeEndpointId,
  WorkbenchSubscriptionAuthenticationAction,
  WorkbenchSessionMetadataMutationResult,
} from "../contract.ts";
import type { WorkbenchWindowRendererBridge } from "../window-control-bridge.ts";
import type { HistoryRecoverySnapshotResult } from "../history-recovery-contract.ts";
import {
  defaultWorkbenchAppearancePreference,
  isValidWorkbenchDirectInput,
  publicAppearancePreferenceUnavailable,
  publicClaudePermissionHandlingUnavailable,
  publicRuntimeExecutableUnavailable,
  defaultWorkbenchRuntimeExecutablePaths,
  type WorkbenchConfigurableRuntime,
  type WorkbenchRuntimeExecutablePaths,
  publicCreateProjectResult,
  publicInterruptUnavailable,
  publicSteerUnavailable,
  publicPreferenceUnavailable,
  publicProjectOpenCancelled,
  publicProfileUnavailable,
  publicProjectOpenUnavailable,
  publicProjectSwitchUnavailable,
  publicUnavailableSubmission,
} from "../contract.ts";
import {
  beginWorkbenchAppearancePreferenceChange,
  completeWorkbenchAppearancePreferenceHydration,
  completeWorkbenchAppearancePreferenceSave,
  initialWorkbenchAppearancePersistenceState,
  type WorkbenchAppearanceAction,
  type WorkbenchAppearancePersistencePhase,
} from "./appearance-preference-state.ts";
import {
  beginWorkbenchClaudePermissionHandlingChange,
  completeWorkbenchClaudePermissionHandlingHydration,
  completeWorkbenchClaudePermissionHandlingSave,
  initialWorkbenchClaudePermissionHandlingPersistenceState,
  type WorkbenchClaudePermissionHandlingPersistencePhase,
} from "./claude-permission-handling-state.ts";
import {
  initialWorkbenchComposerHistoryState,
  navigateComposerHistory,
  recordAcceptedComposerInput,
  type WorkbenchComposerHistoryNavigationRequest,
  type WorkbenchComposerHistoryNavigator,
} from "./composer-history.ts";
import { locale, setLocale } from "./locale.ts";
import {
  beginCreateProject,
  beginOpenProject,
  beginDirectInputSubmission,
  beginDirectSessionProfileDefaultSave,
  beginDirectSessionProfileLoad,
  beginDirectSessionProfileRefreshFromProviders,
  beginProjectSelection,
  advanceTrackedTurns,
  cancelNewAgentSessionMode,
  cancelDirectSessionProfileLoad,
  canEnterNewAgentSessionMode,
  canCreateProject,
  canOpenProject,
  canRefreshDirectSessionProfileFromProviders,
  canSelectProject,
  completeDirectInputSubmission,
  completeDirectSessionProfileDefaultSave,
  completeDirectSessionProfileLoad,
  completeCreateProject,
  completeOpenProject,
  completeProjectSelection,
  directInputMode,
  enterNewAgentSessionMode,
  initialRendererState,
  isNewAgentSessionShortcut,
  isInterruptShortcut,
  pendingContinuationDirectSessionProfileLoad,
  prepareDirectSessionProfileForProjectSurface,
  projectHistoryAdoptionFeedback,
  projectHistoryHideFeedback,
  replaceProjectResult,
  replacementSessionRefusal,
  replacementSessionRequest,
  selectDirectAccessMode,
  selectDirectEndpoint,
  selectDirectExecutionMode,
  selectDirectModel,
  selectDirectWorkIntensity,
  selectProjectCommand,
  selectedCommand,
  updateDirectInputDraft,
  type WorkbenchComposerState,
  type WorkbenchDirectProfileState,
  type WorkbenchNewSessionState,
  type WorkbenchProjectHistoryFeedback,
  type WorkbenchProjectOpenState,
  type WorkbenchProjectSwitchState,
  type WorkbenchReplacementSessionRefusal,
  type WorkbenchRendererState,
} from "./view-model.ts";
import {
  beginSettingsSubscriptionAuthenticationInspection,
  beginSettingsSubscriptionAuthenticationAction,
  beginSettingsSubscriptionAuthenticationPreparation,
  clearSettingsSubscriptionAuthenticationConfirmation,
  completeSettingsSubscriptionAuthenticationResponse,
  initialSettingsSubscriptionAuthenticationState,
  subscriptionAuthenticationSelectionKey,
  type SettingsRuntimeExecutablePhase,
  type SettingsSubscriptionAuthenticationState,
  type WorkbenchSurface,
} from "./settings-view-model.ts";
import {
  projectRemovalConfirmation,
  removalFeedback,
  sessionRemovalConfirmation,
  type WorkbenchRemovalConfirmation,
  type WorkbenchRemovalFeedback,
} from "./removal-presentation.ts";
import {
  sessionMetadataFeedback,
  sessionMetadataRequest,
} from "./session-metadata-presentation.ts";
import { historyRecoveryNeedsAttention } from "./history-recovery-settings.tsx";
import { isTranscriptSearchShortcut } from "./transcript-search.ts";

import { WorkbenchRendererBridgeContext } from "./view-types.ts";
import { LoadingState, FailureState } from "./states.tsx";
import { RemovalConfirmationDialog, ProjectHistoriesDialog } from "./dialogs.tsx";
import { nextProjectScopeEpoch, ProjectRail } from "./project-rail.tsx";
import { WorkbenchStage } from "./stage.tsx";
import { SessionInspector } from "./inspector.tsx";
import { SettingsScreen } from "./settings.tsx";
import { Titlebar, WorkbenchStatusbar } from "./chrome.tsx";
import { shellCopy } from "./copy/shell-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import {
  presentationText,
  workbenchLocalizedText,
  type WorkbenchPresentationText,
} from "./presentation-text.ts";

const catalogDefaultProfileLoadRequest = Object.freeze({
  kind: "catalog-default" as const,
});

const subscriptionAuthenticationEndpointIds = Object.freeze([
  "codex-desktop",
  "claude-code-desktop",
] as const);

const initialWorkbenchAppearance = defaultWorkbenchAppearancePreference;

function applyWorkbenchAppearance(
  appearance: WorkbenchAppearancePreference,
): void {
  setLocale(appearance.language ?? "en");
  const root = document.documentElement;
  root.setAttribute("data-skin", "acrylic");
  root.setAttribute("data-glass", "full");
  if (appearance.tone === "light") {
    root.setAttribute("data-tone", "light");
  } else {
    root.removeAttribute("data-tone");
  }
  if (appearance.crt === "off") {
    root.removeAttribute("data-crt");
  } else {
    root.setAttribute("data-crt", appearance.crt);
  }
  root.setAttribute("data-phosphor", appearance.phosphor);
  root.setAttribute("data-phosphor-tier", appearance.phosphorTier);
  root.removeAttribute("data-scheme");
}

export function mountWorkbench(
  root: HTMLElement,
  bridge: WorkbenchRendererBridge,
  windowBridge: WorkbenchWindowRendererBridge,
): () => void {
  applyWorkbenchAppearance(initialWorkbenchAppearance);
  return render(
    () => (
      <WorkbenchRendererBridgeContext.Provider value={bridge}>
        <WorkbenchApp bridge={bridge} windowBridge={windowBridge} />
      </WorkbenchRendererBridgeContext.Provider>
    ),
    root,
  );
}

const WorkbenchApp: Component<{
  readonly bridge: WorkbenchRendererBridge;
  readonly windowBridge: WorkbenchWindowRendererBridge;
}> = (props) => {
  const [state, setState] = createSignal(initialRendererState);
  const [composerHistory, setComposerHistory] = createSignal(
    initialWorkbenchComposerHistoryState,
  );
  const [projectScopeEpoch, setProjectScopeEpoch] = createSignal(0);
  const [surface, setSurface] = createSignal<WorkbenchSurface>("project");
  const [appearancePersistence, setAppearancePersistence] = createSignal(
    initialWorkbenchAppearancePersistenceState,
  );
  const [claudePermissionHandlingPersistence, setClaudePermissionHandlingPersistence] =
    createSignal(initialWorkbenchClaudePermissionHandlingPersistenceState);
  const [runtimeExecutables, setRuntimeExecutables] =
    createSignal<WorkbenchRuntimeExecutablePaths>(
      defaultWorkbenchRuntimeExecutablePaths,
    );
  const [runtimeExecutablePhases, setRuntimeExecutablePhases] = createSignal<
    Readonly<
      Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeExecutablePhase>>
    >
  >(Object.freeze({}));
  const [subscriptionAuthentication, setSubscriptionAuthentication] =
    createSignal<SettingsSubscriptionAuthenticationState>(
      initialSettingsSubscriptionAuthenticationState(),
    );
  const [removalConfirmation, setRemovalConfirmation] =
    createSignal<WorkbenchRemovalConfirmation | null>(null);
  const [removalPending, setRemovalPending] = createSignal(false);
  const [removalNotice, setRemovalNotice] =
    createSignal<WorkbenchRemovalFeedback | null>(null);
  const [sessionMetadataPending, setSessionMetadataPending] =
    createSignal(false);
  const [historyRecoveryResult, setHistoryRecoveryResult] =
    createSignal<HistoryRecoverySnapshotResult | null>(null);
  const [projectHistoriesLabel, setProjectHistoriesLabel] = createSignal<
    string | null
  >(null);
  const [projectHistoriesSelectionKey, setProjectHistoriesSelectionKey] =
    createSignal<string | null>(null);
  const [projectHistoriesResult, setProjectHistoriesResult] =
    createSignal<WorkbenchProjectHistoryDiscoveryResult | null>(null);
  const [projectHistoriesPending, setProjectHistoriesPending] =
    createSignal(false);
  const [projectHistoriesNotice, setProjectHistoriesNotice] =
    createSignal<WorkbenchProjectHistoryFeedback | null>(null);
  let active = true;
  let projectHistoriesGeneration = 0;
  let profileLoadGeneration = 0;
  let historyRecoveryLoadGeneration = 0;
  const subscriptionAuthenticationRefreshGenerations: Record<
    WorkbenchRuntimeEndpointId,
    number
  > = {
    "codex-desktop": 0,
    "claude-code-desktop": 0,
  };
  let submissionPending = false;
  let trackedTurnStatuses = new Map<string, WorkbenchCommandView["status"]>();
  const [interruptPendingKey, setInterruptPendingKey] = createSignal<
    string | null
  >(null);
  const [interruptFeedback, setInterruptFeedback] = createSignal<
    WorkbenchPresentationText | null
  >(null);
  const [steerPendingKey, setSteerPendingKey] = createSignal<string | null>(null);
  const [steerFeedback, setSteerFeedback] = createSignal<
    WorkbenchPresentationText | null
  >(null);

  const refreshHistoryRecovery = (): void => {
    const getSnapshot = props.bridge.getSnapshot;
    if (getSnapshot === undefined) return;
    const generation = ++historyRecoveryLoadGeneration;
    void getSnapshot({
      version: 1,
      requestKey: `history-request-v1-${globalThis.crypto.randomUUID()}`,
    })
      .then((result) => {
        if (!active || generation !== historyRecoveryLoadGeneration) return;
        setHistoryRecoveryResult(result);
      })
      .catch(() => undefined);
  };

  const invalidateDirectSessionProfileLoad = (): void => {
    profileLoadGeneration += 1;
  };

  const applyProjectStateTransition = (
    transition: (current: WorkbenchRendererState) => WorkbenchRendererState,
  ): void => {
    const previous = state();
    const next = transition(previous);
    const currentProjectScopeEpoch = projectScopeEpoch();
    const nextEpoch = nextProjectScopeEpoch(
      currentProjectScopeEpoch,
      previous,
      next,
    );
    if (
      nextEpoch !== currentProjectScopeEpoch ||
      (previous.profile.phase === "loading" &&
        (previous.profile.loadRequest?.kind === "replacement-session" ||
          previous.profile.loadRequest?.kind === "continuation-session") &&
        next.profile.phase !== "loading")
    ) {
      invalidateDirectSessionProfileLoad();
    }
    batch(() => {
      setState(next);
      setProjectScopeEpoch((epoch) =>
        nextProjectScopeEpoch(epoch, previous, next),
      );
    });
  };

  const runDirectSessionProfileLoad = (
    beginLoad: (
      current: WorkbenchRendererState,
      request: WorkbenchDirectSessionProfileLoadRequest,
    ) => WorkbenchRendererState,
    request: WorkbenchDirectSessionProfileLoadRequest,
  ): void => {
    if (
      submissionPending ||
      state().profile.defaultPreference.phase === "pending"
    ) {
      return;
    }
    const current = state();
    const loading = beginLoad(current, request);
    if (loading === current) return;
    const generation = ++profileLoadGeneration;
    const scopeEpoch = projectScopeEpoch();
    const loadSurface = surface();
    const selectedKey = loading.selectedKey;
    setState(loading);
    void props.bridge
      .loadDirectSessionProfile(request)
      .catch(() => publicProfileUnavailable())
      .then((result) => {
        if (
          !active ||
          generation !== profileLoadGeneration ||
          scopeEpoch !== projectScopeEpoch() ||
          loadSurface !== surface()
        ) {
          return;
        }
        const current = state();
        if (
          current.selectedKey !== selectedKey ||
          (request.kind === "replacement-session" &&
            (!current.result?.ok ||
              current.result.view.observation.cursor !==
                request.sourceSnapshotCursor ||
              !current.result.view.commands.some(
                (command) => command.key === request.sourceSelectionKey,
              ))) ||
          (request.kind === "continuation-session" &&
            (!current.result?.ok ||
              current.result.view.commands.find(
                (command) => command.key === current.selectedKey,
              )?.session?.selectionKey !== request.selectionKey))
        ) {
          return;
        }
        setState((current) =>
          completeDirectSessionProfileLoad(current, result, request),
        );
      });
  };

  const loadDirectSessionProfile = (): void => {
    runDirectSessionProfileLoad(
      beginDirectSessionProfileLoad,
      catalogDefaultProfileLoadRequest,
    );
  };

  const refreshDirectSessionProfileFromProviders = (): void => {
    runDirectSessionProfileLoad(
      (current) => beginDirectSessionProfileRefreshFromProviders(current),
      catalogDefaultProfileLoadRequest,
    );
  };

  const refreshSubscriptionAuthentication = (
    endpointId?: WorkbenchRuntimeEndpointId,
    allowPendingAction = false,
  ): void => {
    const inspect = props.bridge.inspectSubscriptionAuthentication;
    if (inspect === undefined) return;
    const targets =
      endpointId === undefined
        ? subscriptionAuthenticationEndpointIds
        : ([endpointId] as const);
    for (const targetEndpointId of targets) {
      const target = subscriptionAuthentication()[targetEndpointId];
      if (
        target.inspectionPending ||
        target.preparationPending !== null ||
        (!allowPendingAction && target.pendingAction !== null)
      ) {
        continue;
      }
      const generation =
        ++subscriptionAuthenticationRefreshGenerations[targetEndpointId];
      setSubscriptionAuthentication((current) =>
        beginSettingsSubscriptionAuthenticationInspection(
          current,
          targetEndpointId,
        ),
      );
      void inspect(
        Object.freeze({
          endpointSelectionKey:
            subscriptionAuthenticationSelectionKey(targetEndpointId),
        }),
      )
        .then((result) => {
          if (
            !active ||
            generation !==
              subscriptionAuthenticationRefreshGenerations[targetEndpointId]
          ) {
            return;
          }
          setSubscriptionAuthentication((current) =>
            completeSettingsSubscriptionAuthenticationResponse(
              current,
              targetEndpointId,
              result,
            ),
          );
        })
        .catch(() => {
          if (
            !active ||
            generation !==
              subscriptionAuthenticationRefreshGenerations[targetEndpointId]
          ) {
            return;
          }
          setSubscriptionAuthentication((current) =>
            completeSettingsSubscriptionAuthenticationResponse(
              current,
              targetEndpointId,
              Object.freeze({
                kind: "authentication-state" as const,
                state: "unknown" as const,
              }),
            ),
          );
        });
    }
  };

  const beginPreparedSubscriptionAuthentication = (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ): void => {
    const begin = props.bridge.beginSubscriptionAuthentication;
    if (begin === undefined) return;
    subscriptionAuthenticationRefreshGenerations[endpointId] += 1;
    setSubscriptionAuthentication((current) =>
      beginSettingsSubscriptionAuthenticationAction(current, endpointId, action),
    );
    void begin(Object.freeze({ preparationKey }))
      .then((result) => {
        if (!active) return;
        setSubscriptionAuthentication((current) =>
          completeSettingsSubscriptionAuthenticationResponse(
            current,
            endpointId,
            result,
          ),
        );
        if (
          result.kind === "authentication-action-requested" &&
          result.action === "login"
        ) {
          refreshDirectSessionProfileFromProviders();
        }
        if (result.kind === "authentication-action-requested") {
          refreshSubscriptionAuthentication(endpointId, true);
        }
        // A partially completed action is deliberately not re-inspected here. A
        // fresh inspection resets the card, and the sentence naming what the
        // reader lost is the only place that consequence is stated. The card
        // stays operable, so the reader re-checks when they have read it.
      })
      .catch(() => {
        if (!active) return;
        setSubscriptionAuthentication((current) =>
          completeSettingsSubscriptionAuthenticationResponse(
            current,
            endpointId,
            Object.freeze({
              kind: "authentication-action-not-requested" as const,
              action,
            }),
          ),
        );
      });
  };

  const requestSubscriptionAuthenticationAction = (
    endpointId: WorkbenchRuntimeEndpointId,
  ): void => {
    const current = subscriptionAuthentication()[endpointId];
    if (
      current.inspectionPending ||
      current.preparationPending !== null ||
      current.pendingAction !== null
    ) {
      return;
    }
    if (current.authentication === "unknown") {
      refreshSubscriptionAuthentication(endpointId);
      return;
    }
    const action = current.authentication === "bound" ? "logout" : "login";
    const prepare = props.bridge.prepareSubscriptionAuthentication;
    if (prepare === undefined) return;
    subscriptionAuthenticationRefreshGenerations[endpointId] += 1;
    setSubscriptionAuthentication((current) =>
      beginSettingsSubscriptionAuthenticationPreparation(
        current,
        endpointId,
        action,
      ),
    );
    void prepare(
      Object.freeze({
        endpointSelectionKey:
          subscriptionAuthenticationSelectionKey(endpointId),
        action,
      }),
    )
      .then((result) => {
        if (!active) return;
        setSubscriptionAuthentication((current) =>
          completeSettingsSubscriptionAuthenticationResponse(
            current,
            endpointId,
            result,
          ),
        );
        if (result.kind === "ready") {
          beginPreparedSubscriptionAuthentication(
            endpointId,
            result.preparationKey,
            action,
          );
        }
      })
      .catch(() => {
        if (!active) return;
        setSubscriptionAuthentication((current) =>
          completeSettingsSubscriptionAuthenticationResponse(
            current,
            endpointId,
            Object.freeze({
              kind: "authentication-action-not-requested" as const,
              action,
            }),
          ),
        );
      });
  };

  const cancelPreparedSubscriptionAuthentication = (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ): void => {
    const cancel = props.bridge.cancelPreparedSubscriptionAuthentication;
    if (cancel === undefined) return;
    void cancel(Object.freeze({ preparationKey }))
      .then(() => {
        if (!active) return;
        setSubscriptionAuthentication((current) =>
          clearSettingsSubscriptionAuthenticationConfirmation(
            current,
            endpointId,
          ),
        );
      })
      .catch(() => undefined);
  };

  const announceFinishedTurns = (
    result: WorkbenchHostedProjectResult,
    resetTracking: boolean,
  ): void => {
    if (!result.ok) return;
    if (resetTracking) {
      trackedTurnStatuses = new Map(
        result.view.commands.map((command) => [command.key, command.status]),
      );
      return;
    }
    const progression = advanceTrackedTurns(
      trackedTurnStatuses,
      result.view.commands,
    );
    trackedTurnStatuses = new Map(progression.trackedStatuses);
    const notifyTurnCompleted = props.bridge.notifyTurnCompleted;
    if (
      notifyTurnCompleted === undefined ||
      progression.notices.length === 0 ||
      (!document.hidden && document.hasFocus())
    ) {
      return;
    }
    for (const notice of progression.notices) {
      void notifyTurnCompleted(
        Object.freeze({ title: notice.title, body: notice.body }),
      ).catch(() => undefined);
    }
  };

  onMount(() => {
    const dispose = props.bridge.observeProject((result) => {
      const current = state();
      const projectScopeMayBeChanging =
        current.projectSwitch.phase === "pending" ||
        current.projectOpen.phase === "pending";
      applyProjectStateTransition((current) =>
        replaceProjectResult(current, result),
      );
      announceFinishedTurns(result, projectScopeMayBeChanging);
    });
    onCleanup(dispose);
  });
  onMount(refreshHistoryRecovery);
  onMount(() => {
    const capturedIntentRevision = appearancePersistence().intentRevision;
    void props.bridge
      .loadAppearancePreference()
      .catch(() => publicAppearancePreferenceUnavailable())
      .then((result) => {
        if (!active) return;
        setAppearancePersistence((current) =>
          completeWorkbenchAppearancePreferenceHydration(
            current,
            capturedIntentRevision,
            result,
          ),
        );
      });
  });
  onMount(() => {
    const capturedIntentRevision =
      claudePermissionHandlingPersistence().intentRevision;
    void props.bridge
      .loadClaudePermissionHandling()
      .catch(() => publicClaudePermissionHandlingUnavailable())
      .then((result) => {
        if (!active) return;
        setClaudePermissionHandlingPersistence((current) =>
          completeWorkbenchClaudePermissionHandlingHydration(
            current,
            capturedIntentRevision,
            result,
          ),
        );
      });
  });
  onMount(() => {
    void props.bridge
      .loadRuntimeExecutables()
      .catch(() => publicRuntimeExecutableUnavailable())
      .then((result) => {
        if (!active || !result.ok) return;
        setRuntimeExecutables(result.executables);
      });
  });
  createEffect(() =>
    applyWorkbenchAppearance(appearancePersistence().appearance),
  );
  onCleanup(() => {
    active = false;
    historyRecoveryLoadGeneration += 1;
    for (const endpointId of subscriptionAuthenticationEndpointIds) {
      subscriptionAuthenticationRefreshGenerations[endpointId] += 1;
    }
  });

  const submitDirectInput = (): void => {
    if (submissionPending) return;
    const attempt = beginDirectInputSubmission(state());
    if (attempt.request === null) return;
    submissionPending = true;
    setState(attempt.state);
    void props.bridge
      .submitDirectInput(attempt.request)
      .catch(() => publicUnavailableSubmission())
      .then((result) => {
        submissionPending = false;
        if (!active) return;
        if (result.ok) recordComposerInput(attempt.request!.input);
        setState((current) => completeDirectInputSubmission(current, result));
      });
  };

  const composerHistoryScopeKey = (): string | null => {
    return state().result?.ok
      ? `project-scope-${projectScopeEpoch()}`
      : null;
  };

  const recordComposerInput = (input: string): void => {
    const scopeKey = composerHistoryScopeKey();
    setComposerHistory((current) =>
      recordAcceptedComposerInput(current, scopeKey, input),
    );
  };

  const navigateAcceptedComposerInput = (
    request: WorkbenchComposerHistoryNavigationRequest,
  ): string | null => {
    const outcome = navigateComposerHistory(
      composerHistory(),
      composerHistoryScopeKey(),
      request,
    );
    if (!outcome.handled) return null;
    const current = state();
    const next = updateDirectInputDraft(current, outcome.draft);
    if (next.composer.draft !== outcome.draft) return null;
    setComposerHistory(outcome.state);
    setState(next);
    return outcome.draft;
  };

  const enterNewSession = (): void => {
    const current = state();
    if (!canEnterNewAgentSessionMode(current)) return;
    invalidateDirectSessionProfileLoad();
    setState(enterNewAgentSessionMode(current));
    setSurface("project");
  };

  const enterReplacementSession = (): void => {
    const current = state();
    const request = replacementSessionRequest(current);
    if (request === null) return;
    invalidateDirectSessionProfileLoad();
    setState(enterNewAgentSessionMode(current));
    setSurface("project");
    runDirectSessionProfileLoad(beginDirectSessionProfileLoad, request);
  };

  const changeSurface = (nextSurface: WorkbenchSurface): void => {
    const destination =
      surface() === "settings" && nextSurface === "settings"
        ? "project"
        : nextSurface;
    if (surface() === destination) return;
    invalidateDirectSessionProfileLoad();
    setState((current) =>
      destination === "project"
        ? prepareDirectSessionProfileForProjectSurface(current)
        : cancelDirectSessionProfileLoad(current),
    );
    setSurface(destination);
    if (destination === "settings") {
      refreshDirectSessionProfileFromProviders();
      refreshSubscriptionAuthentication();
      refreshHistoryRecovery();
    }
  };

  const selectCommand = (key: string): void => {
    const current = state();
    if (current.selectedKey !== key) invalidateDirectSessionProfileLoad();
    setState(
      selectProjectCommand(cancelDirectSessionProfileLoad(current), key),
    );
    setSurface("project");
  };

  const cancelNewSession = (): void => {
    const current = state();
    const cancelled = cancelNewAgentSessionMode(current);
    if (cancelled === current) return;
    invalidateDirectSessionProfileLoad();
    setState(cancelled);
  };

  const handleNewAgentSessionShortcut = (event: KeyboardEvent): void => {
    if (!isNewAgentSessionShortcut(event)) return;
    event.preventDefault();
    const current = state();
    if (
      canEnterNewAgentSessionMode(current) &&
      directInputMode(current) === "unavailable"
    ) {
      enterReplacementSession();
      return;
    }
    enterNewSession();
  };

  onMount(() => {
    window.addEventListener("keydown", handleNewAgentSessionShortcut);
    onCleanup(() => {
      window.removeEventListener("keydown", handleNewAgentSessionShortcut);
    });
  });

  const handleTranscriptSearchShortcut = (event: KeyboardEvent): void => {
    if (!isTranscriptSearchShortcut(event)) return;
    const input = document.querySelector<HTMLInputElement>(
      "input.transcript-search-input",
    );
    if (input === null) return;
    event.preventDefault();
    input.focus();
  };

  onMount(() => {
    window.addEventListener("keydown", handleTranscriptSearchShortcut);
    onCleanup(() => {
      window.removeEventListener("keydown", handleTranscriptSearchShortcut);
    });
  });

  const useDirectSessionProfileAsDefault = (): void => {
    const attempt = beginDirectSessionProfileDefaultSave(state());
    if (attempt.request === null) return;
    setState(attempt.state);
    void props.bridge
      .useDirectSessionProfileAsDefault(attempt.request)
      .catch(() => publicPreferenceUnavailable())
      .then((result) => {
        if (!active) return;
        setState((current) =>
          completeDirectSessionProfileDefaultSave(current, result),
        );
      });
  };

  const selectHostedProject = (targetIndex: number): void => {
    const attempt = beginProjectSelection(state(), targetIndex);
    if (attempt.request === null) return;
    setSurface("project");
    setState(attempt.state);
    void props.bridge
      .selectProject(attempt.request)
      .catch(() => publicProjectSwitchUnavailable())
      .then((result) => {
        if (!active) return;
        applyProjectStateTransition((current) =>
          completeProjectSelection(current, result),
        );
      });
  };

  const openProject = (): void => {
    const current = state();
    const opening = beginOpenProject(current);
    if (opening === current) return;
    setState(opening);
    void props.bridge.openProject()
      .catch(() => publicProjectOpenUnavailable())
      .then((result) => {
        if (!active) return;
        batch(() => {
          applyProjectStateTransition((currentState) =>
            completeOpenProject(currentState, result),
          );
          if (result.ok && result.status === "history-selection-required") {
            projectHistoriesGeneration += 1;
            setRemovalNotice(null);
            setProjectHistoriesNotice(null);
            setProjectHistoriesLabel(result.snapshot.projectLabel);
            setProjectHistoriesSelectionKey(null);
            setProjectHistoriesResult({
              status: "discovered",
              snapshot: result.snapshot,
            });
            setProjectHistoriesPending(false);
          }
        });
      });
  };

  const createProject = (): void => {
    const current = state();
    const creating = beginCreateProject(current);
    if (creating === current) return;
    setState(creating);
    void props.bridge.createProject()
      .catch(() => publicCreateProjectResult("unavailable"))
      .then((result) => {
        if (!active) return;
        applyProjectStateTransition((currentState) =>
          completeCreateProject(currentState, result),
        );
      });
  };

  const requestSessionRemoval = (command: WorkbenchCommandView): void => {
    if (removalPending() || sessionMetadataPending()) return;
    const confirmation = sessionRemovalConfirmation(command);
    if (confirmation === null) return;
    batch(() => {
      setRemovalNotice(null);
      setRemovalConfirmation(confirmation);
    });
  };

  const requestProjectRemoval = (project: WorkbenchProjectOption): void => {
    if (removalPending() || sessionMetadataPending()) return;
    batch(() => {
      setRemovalNotice(null);
      setRemovalConfirmation(projectRemovalConfirmation(project));
    });
  };

  const cancelRemoval = (): void => {
    if (!removalPending()) setRemovalConfirmation(null);
  };

  const requestProjectHistories = (project: WorkbenchProjectOption): void => {
    const discover = props.bridge.discoverProjectHistories;
    if (
      discover === undefined ||
      removalPending() ||
      sessionMetadataPending() ||
      projectHistoriesPending()
    ) {
      return;
    }
    const generation = (projectHistoriesGeneration += 1);
    const scopeEpoch = projectScopeEpoch();
    batch(() => {
      setRemovalNotice(null);
      setProjectHistoriesNotice(null);
      setProjectHistoriesResult(null);
      setProjectHistoriesLabel(project.label);
      setProjectHistoriesSelectionKey(project.selectionKey);
      setProjectHistoriesPending(true);
    });
    void discover({ selectionKey: project.selectionKey })
      .catch(() => Object.freeze({ status: "unavailable" as const }))
      .then((result) => {
        if (!active || generation !== projectHistoriesGeneration) return;
        if (scopeEpoch !== projectScopeEpoch()) {
          batch(() => {
            setProjectHistoriesLabel(null);
            setProjectHistoriesSelectionKey(null);
            setProjectHistoriesResult(null);
            setProjectHistoriesPending(false);
            setProjectHistoriesNotice(null);
          });
          return;
        }
        batch(() => {
          setProjectHistoriesResult(result);
          setProjectHistoriesPending(false);
        });
      });
  };

  const closeProjectHistories = (): void => {
    if (projectHistoriesPending()) return;
    const cancelsPendingRegistration =
      projectHistoriesSelectionKey() === null &&
      state().projectOpen.phase === "pending" &&
      state().projectOpen.operation === "open";
    projectHistoriesGeneration += 1;
    batch(() => {
      if (cancelsPendingRegistration) {
        applyProjectStateTransition((currentState) =>
          completeOpenProject(currentState, publicProjectOpenCancelled()),
        );
      }
      setProjectHistoriesLabel(null);
      setProjectHistoriesSelectionKey(null);
      setProjectHistoriesResult(null);
      setProjectHistoriesNotice(null);
    });
  };

  const adoptProjectHistory = (historyKey: string): void => {
    const adopt = props.bridge.adoptProjectHistory;
    if (adopt === undefined || projectHistoriesPending() || removalPending()) {
      return;
    }
    const completesPendingRegistration =
      projectHistoriesSelectionKey() === null &&
      state().projectOpen.phase === "pending" &&
      state().projectOpen.operation === "open";
    const generation = (projectHistoriesGeneration += 1);
    batch(() => {
      setProjectHistoriesNotice(null);
      setProjectHistoriesPending(true);
    });
    void adopt({ historyKey })
      .catch(() => Object.freeze({ status: "unavailable" as const }))
      .then((result) => {
        if (!active || generation !== projectHistoriesGeneration) return;
        const feedback = projectHistoryAdoptionFeedback(result);
        batch(() => {
          setProjectHistoriesPending(false);
          if (result.status !== "adopted") {
            // Nothing changed, so the panel stays open with its live keys.
            setProjectHistoriesNotice(feedback);
            return;
          }
          if (completesPendingRegistration) {
            applyProjectStateTransition((currentState) =>
              completeOpenProject(currentState, {
                ok: true,
                status: "opened",
                message: "Project was opened.",
              }),
            );
          }
          // The Project re-observes on its own and every key in this snapshot
          // is now dead, so the panel closes and the outcome is stated beside
          // the Project list where the owner is already looking.
          setProjectHistoriesLabel(null);
          setProjectHistoriesSelectionKey(null);
          setProjectHistoriesResult(null);
          setProjectHistoriesNotice(null);
          setRemovalNotice(
            completesPendingRegistration ? null : feedback,
          );
        });
      });
  };

  const hideProjectHistory = (historyKey: string): void => {
    const hide = props.bridge.hideProjectHistory;
    const discover = props.bridge.discoverProjectHistories;
    const selectionKey = projectHistoriesSelectionKey();
    if (
      hide === undefined ||
      discover === undefined ||
      selectionKey === null ||
      projectHistoriesPending() ||
      removalPending()
    ) {
      return;
    }
    const generation = (projectHistoriesGeneration += 1);
    batch(() => {
      setProjectHistoriesNotice(null);
      setProjectHistoriesPending(true);
    });
    void (async () => {
      const result = await hide({ historyKey }).catch(() =>
        Object.freeze({ status: "unavailable" as const }),
      );
      const refreshed =
        result.status === "hidden"
          ? await discover({ selectionKey }).catch(() =>
              Object.freeze({ status: "unavailable" as const }),
            )
          : null;
      return Object.freeze({ result, refreshed });
    })().then(({ result, refreshed }) => {
      if (!active || generation !== projectHistoriesGeneration) return;
      batch(() => {
        setProjectHistoriesPending(false);
        setProjectHistoriesNotice(projectHistoryHideFeedback(result));
        if (refreshed !== null) setProjectHistoriesResult(refreshed);
      });
    });
  };

  const confirmRemoval = (): void => {
    const current = removalConfirmation();
    if (current === null || removalPending()) return;
    setRemovalPending(true);
    if (current.kind === "session") {
      void props.bridge
        .removeSession(current.request)
        .catch(() => Object.freeze({ status: "unavailable" as const }))
        .then((result) => {
          if (!active) return;
          batch(() => {
            setRemovalNotice(removalFeedback(current.kind, result));
            setRemovalConfirmation(null);
            setRemovalPending(false);
          });
        });
      return;
    }
    void props.bridge
      .removeProject(current.request)
      .catch(() => Object.freeze({ status: "unavailable" as const }))
      .then((result) => {
        if (!active) return;
        batch(() => {
          setRemovalNotice(removalFeedback(current.kind, result));
          setRemovalConfirmation(null);
          setRemovalPending(false);
        });
      });
  };

  const mutateSessionMetadata = async (
    command: WorkbenchCommandView,
    operation: SessionMetadataOperation,
  ): Promise<WorkbenchSessionMetadataMutationResult> => {
    const request = sessionMetadataRequest(command, operation);
    if (
      request === null ||
      sessionMetadataPending() ||
      removalPending() ||
      removalConfirmation() !== null
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    batch(() => {
      setSessionMetadataPending(true);
      setRemovalNotice(null);
    });
    const result = await props.bridge
      .mutateSessionMetadata(request)
      .catch(() => Object.freeze({ status: "unavailable" as const }));
    if (active) {
      batch(() => {
        setRemovalNotice(sessionMetadataFeedback(operation, result));
        setSessionMetadataPending(false);
      });
    }
    return result;
  };

  const changeAppearance = (action: WorkbenchAppearanceAction): void => {
    const attempt = beginWorkbenchAppearancePreferenceChange(
      appearancePersistence(),
      action,
    );
    const request = attempt.request;
    if (request === null) return;
    setAppearancePersistence(attempt.state);
    void props.bridge
      .saveAppearancePreference(request.preference)
      .catch(() => publicAppearancePreferenceUnavailable())
      .then((result) => {
        if (!active) return;
        setAppearancePersistence((current) =>
          completeWorkbenchAppearancePreferenceSave(
            current,
            request.revision,
            result,
          ),
        );
      });
  };

  const changeClaudePermissionHandling = (
    permissionHandling: WorkbenchClaudePermissionHandling,
  ): void => {
    const attempt = beginWorkbenchClaudePermissionHandlingChange(
      claudePermissionHandlingPersistence(),
      permissionHandling,
    );
    const request = attempt.request;
    if (request === null) return;
    setClaudePermissionHandlingPersistence(attempt.state);
    void props.bridge
      .saveClaudePermissionHandling(request.permissionHandling)
      .catch(() => publicClaudePermissionHandlingUnavailable())
      .then((result) => {
        if (!active) return;
        setClaudePermissionHandlingPersistence((current) =>
          completeWorkbenchClaudePermissionHandlingSave(
            current,
            request.revision,
            result,
          ),
        );
      });
  };

  const saveRuntimeExecutable = (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ): void => {
    const clearing = executablePath.trim().length === 0;
    setRuntimeExecutablePhases((current) =>
      Object.freeze({ ...current, [runtime]: { status: "saving" as const } }),
    );
    void props.bridge
      .saveRuntimeExecutable(Object.freeze({ runtime, executablePath }))
      .catch(() => publicRuntimeExecutableUnavailable())
      .then((result) => {
        if (!active) return;
        if (result.ok) setRuntimeExecutables(result.executables);
        // A rejection is the product ANSWERING the user, with the reason, at the
        // moment they asked -- not an error state to swallow.
        const phase: SettingsRuntimeExecutablePhase = result.ok
          ? { status: clearing ? "cleared" : "saved" }
          : result.error.category === "runtime-executable-rejected"
            ? { status: "rejected", rejection: result.error.reason }
            : { status: "unavailable" };
        setRuntimeExecutablePhases((current) =>
          Object.freeze({ ...current, [runtime]: phase }),
        );
      });
  };

  const view = createMemo(() => {
    const current = state().result;
    return current?.ok ? current.view : undefined;
  });
  const selected = createMemo(() => {
    const currentView = view();
    return currentView === undefined
      ? undefined
      : selectedCommand(currentView, state().selectedKey);
  });
  const requestInterrupt = (): void => {
    const control = selected()?.interrupt;
    const interrupt = props.bridge.interruptActiveTurn;
    if (
      surface() !== "project" ||
      control?.status !== "available" ||
      interruptPendingKey() !== null
    ) {
      return;
    }
    if (typeof interrupt !== "function") {
      setInterruptFeedback(
        workbenchLocalizedText(
          "interrupt.unavailable",
          () => dynamicCopy.interrupt.unavailable,
        ),
      );
      return;
    }
    const interruptKey = control.interruptKey;
    batch(() => {
      setInterruptPendingKey(interruptKey);
      setInterruptFeedback(null);
    });
    void Promise.resolve()
      .then(() => interrupt.call(props.bridge, Object.freeze({ interruptKey })))
      .catch(() => publicInterruptUnavailable())
      .then((result) => {
        if (!active || interruptPendingKey() !== interruptKey) return;
        if (!result.ok) {
          batch(() => {
            setInterruptPendingKey(null);
            setInterruptFeedback(
              result.error.category === "invalid-interrupt"
                ? workbenchLocalizedText(
                    "interrupt.reload",
                    () => dynamicCopy.interrupt.reload,
                  )
                : workbenchLocalizedText(
                    "interrupt.unavailable",
                    () => dynamicCopy.interrupt.unavailable,
                  ),
            );
          });
        }
      });
  };
  const requestSteer = (): void => {
    const control = selected()?.steer;
    const steer = props.bridge.steerActiveTurn;
    const input = state().composer.draft;
    if (
      surface() !== "project" ||
      control?.status !== "available" ||
      steerPendingKey() !== null ||
      !isValidWorkbenchDirectInput(input)
    ) {
      return;
    }
    if (typeof steer !== "function") {
      setSteerFeedback(
        workbenchLocalizedText(
          "steer.unavailable",
          () => dynamicCopy.steer.unavailable,
        ),
      );
      return;
    }
    const steerKey = control.steerKey;
    batch(() => {
      setSteerPendingKey(steerKey);
      setSteerFeedback(null);
    });
    void Promise.resolve()
      .then(() =>
        steer.call(
          props.bridge,
          Object.freeze({ steerKey, input }),
        ),
      )
      .catch(() => publicSteerUnavailable())
      .then((result) => {
        if (!active || steerPendingKey() !== steerKey) return;
        if (!result.ok) {
          batch(() => {
            setSteerPendingKey(null);
            setSteerFeedback(
              result.error.category === "invalid-steer"
                ? workbenchLocalizedText(
                    "steer.reload",
                    () => dynamicCopy.steer.reload,
                  )
                : workbenchLocalizedText(
                    "steer.unavailable",
                    () => dynamicCopy.steer.unavailable,
                  ),
            );
          });
          return;
        }
        batch(() => {
          setSteerPendingKey(null);
          recordComposerInput(input);
          setSteerFeedback(
            workbenchLocalizedText(
              "steer.accepted",
              () => dynamicCopy.steer.accepted,
            ),
          );
          setState((current) => {
            const currentView = current.result?.ok
              ? current.result.view
              : undefined;
            const currentSelection = currentView === undefined
              ? undefined
              : selectedCommand(currentView, current.selectedKey);
            return currentSelection?.steer?.status === "available" &&
              currentSelection.steer.steerKey === steerKey &&
              current.composer.draft === input
              ? updateDirectInputDraft(current, "")
              : current;
          });
        });
      });
  };
  createEffect(() => {
    const pendingKey = interruptPendingKey();
    const control = selected()?.interrupt;
    if (
      pendingKey !== null &&
      (surface() !== "project" ||
        control?.status !== "available" ||
        control.interruptKey !== pendingKey)
    ) {
      setInterruptPendingKey(null);
    }
    if (control?.status !== "available") setInterruptFeedback(null);
  });
  createEffect(() => {
    const pendingKey = steerPendingKey();
    const control = selected()?.steer;
    if (
      pendingKey !== null &&
      (surface() !== "project" ||
        control?.status !== "available" ||
        control.steerKey !== pendingKey)
    ) {
      setSteerPendingKey(null);
    }
    if (control?.status !== "available") setSteerFeedback(null);
  });
  const handleInterruptShortcut = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      !isInterruptShortcut(event) ||
      surface() !== "project" ||
      selected()?.interrupt?.status !== "available" ||
      typeof props.bridge.interruptActiveTurn !== "function" ||
      document.querySelector(
        '[role="dialog"][aria-modal="true"], .popover[role="dialog"]:not([hidden])',
      ) !== null
    ) {
      return;
    }
    event.preventDefault();
    requestInterrupt();
  };
  onMount(() => {
    window.addEventListener("keydown", handleInterruptShortcut);
    onCleanup(() => {
      window.removeEventListener("keydown", handleInterruptShortcut);
    });
  });
  createEffect(() => {
    const current = state();
    const request = pendingContinuationDirectSessionProfileLoad(current);
    if (surface() !== "project" || request === null) {
      return;
    }
    untrack(() =>
      runDirectSessionProfileLoad(
        beginDirectSessionProfileLoad,
        request,
      ),
    );
  });

  return (
    <>
      <Show when={state().result} fallback={<LoadingState />}>
        {(resolved) => (
          <ResolvedWorkbench
          result={resolved()}
          windowBridge={props.windowBridge}
          surface={surface()}
          onSurface={changeSurface}
          selected={selected()}
          composer={state().composer}
          profile={state().profile}
          subscriptionAuthentication={subscriptionAuthentication()}
          historyRecoveryResult={historyRecoveryResult()}
          historyRecoveryBridge={props.bridge}
          onHistoryRecoverySnapshot={setHistoryRecoveryResult}
          onRefreshHistoryRecovery={refreshHistoryRecovery}
          onBindSubscriptionAuthentication={requestSubscriptionAuthenticationAction}
          onBeginSubscriptionAuthentication={beginPreparedSubscriptionAuthentication}
          onCancelSubscriptionAuthentication={cancelPreparedSubscriptionAuthentication}
          appearance={appearancePersistence().appearance}
          appearancePersistencePhase={appearancePersistence().phase}
          onAppearance={changeAppearance}
          runtimeExecutables={runtimeExecutables()}
          runtimeExecutablePhases={runtimeExecutablePhases()}
          onSaveRuntimeExecutable={saveRuntimeExecutable}
          claudePermissionHandling={
            claudePermissionHandlingPersistence().permissionHandling
          }
          claudePermissionHandlingPersistencePhase={
            claudePermissionHandlingPersistence().phase
          }
          onClaudePermissionHandling={changeClaudePermissionHandling}
          newSession={state().newSession}
          projectSwitch={state().projectSwitch}
          projectOpen={state().projectOpen}
          projectScopeEpoch={projectScopeEpoch()}
          canCreateProject={() => canCreateProject(state())}
          onCreateProject={createProject}
          canOpenProject={() => canOpenProject(state())}
          onOpenProject={openProject}
          canSelectProject={(targetIndex) =>
            canSelectProject(state(), targetIndex)
          }
          onSelectProject={selectHostedProject}
          onSelect={selectCommand}
          onDraft={(draft) =>
            setState((current) => updateDirectInputDraft(current, draft))
          }
          onNavigateComposerHistory={navigateAcceptedComposerInput}
          onLoadProfile={loadDirectSessionProfile}
          onRefreshProfile={() => {
            refreshDirectSessionProfileFromProviders();
            refreshSubscriptionAuthentication();
          }}
          onEnterNewSession={enterNewSession}
          replacementSessionRefusal={replacementSessionRefusal(state())}
          onEnterReplacementSession={enterReplacementSession}
          onCancelNewSession={cancelNewSession}
          onEndpoint={(key) =>
            setState((current) => selectDirectEndpoint(current, key))
          }
          onModel={(key) =>
            setState((current) => selectDirectModel(current, key))
          }
          onWorkIntensity={(key) =>
            setState((current) => selectDirectWorkIntensity(current, key))
          }
          onExecutionMode={(key) =>
            setState((current) => selectDirectExecutionMode(current, key))
          }
          onAccessMode={(key) =>
            setState((current) => selectDirectAccessMode(current, key))
          }
          onUseAsDefault={useDirectSessionProfileAsDefault}
            sessionMetadataPending={sessionMetadataPending()}
            onMutateSessionMetadata={mutateSessionMetadata}
            removalPending={removalPending()}
            removalNotice={removalNotice()}
            onRequestSessionRemoval={requestSessionRemoval}
            onRequestProjectRemoval={requestProjectRemoval}
            projectHistoriesPending={projectHistoriesPending()}
            onRequestProjectHistories={
              props.bridge.discoverProjectHistories === undefined
                ? undefined
                : requestProjectHistories
            }
            interruptPending={interruptPendingKey() !== null}
            interruptFeedback={presentationText(interruptFeedback())}
            onInterrupt={
              props.bridge.interruptActiveTurn === undefined
                ? undefined
                : requestInterrupt
            }
            steerPending={steerPendingKey() !== null}
            steerFeedback={presentationText(steerFeedback())}
            onSteer={
              props.bridge.steerActiveTurn === undefined
                ? undefined
                : requestSteer
            }
            onSubmit={submitDirectInput}
          />
        )}
      </Show>
      <Show when={removalConfirmation()}>
        <RemovalConfirmationDialog
          confirmation={removalConfirmation()!}
          pending={removalPending()}
          onCancel={cancelRemoval}
          onConfirm={confirmRemoval}
        />
      </Show>
      <Show when={projectHistoriesLabel()}>
        {(label) => (
          <ProjectHistoriesDialog
            projectLabel={label()}
            result={projectHistoriesResult()}
            pending={projectHistoriesPending()}
            notice={projectHistoriesNotice()}
            onClose={closeProjectHistories}
            onAdopt={adoptProjectHistory}
            onHide={
              props.bridge.hideProjectHistory === undefined ||
                projectHistoriesSelectionKey() === null
                ? undefined
                : hideProjectHistory
            }
          />
        )}
      </Show>
    </>
  );
};

const ResolvedWorkbench: Component<{
  readonly result: WorkbenchHostedProjectResult;
  readonly windowBridge: WorkbenchWindowRendererBridge;
  readonly surface: WorkbenchSurface;
  readonly onSurface: (surface: WorkbenchSurface) => void;
  readonly selected: WorkbenchCommandView | undefined;
  readonly composer: WorkbenchComposerState;
  readonly profile: WorkbenchDirectProfileState;
  readonly subscriptionAuthentication: SettingsSubscriptionAuthenticationState;
  readonly historyRecoveryResult: HistoryRecoverySnapshotResult | null;
  readonly historyRecoveryBridge: WorkbenchRendererBridge;
  readonly onHistoryRecoverySnapshot: (
    result: HistoryRecoverySnapshotResult,
  ) => void;
  readonly onRefreshHistoryRecovery: () => void;
  readonly onBindSubscriptionAuthentication: (
    endpointId: WorkbenchRuntimeEndpointId,
  ) => void;
  readonly onBeginSubscriptionAuthentication: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ) => void;
  readonly onCancelSubscriptionAuthentication: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ) => void;
  readonly appearance: WorkbenchAppearancePreference;
  readonly appearancePersistencePhase: WorkbenchAppearancePersistencePhase;
  readonly onAppearance: (action: WorkbenchAppearanceAction) => void;
  readonly runtimeExecutables: WorkbenchRuntimeExecutablePaths;
  readonly runtimeExecutablePhases: Readonly<
    Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeExecutablePhase>>
  >;
  readonly onSaveRuntimeExecutable: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly claudePermissionHandling: WorkbenchClaudePermissionHandling;
  readonly claudePermissionHandlingPersistencePhase: WorkbenchClaudePermissionHandlingPersistencePhase;
  readonly onClaudePermissionHandling: (
    permissionHandling: WorkbenchClaudePermissionHandling,
  ) => void;
  readonly newSession: WorkbenchNewSessionState;
  readonly projectSwitch: WorkbenchProjectSwitchState;
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly projectScopeEpoch: number;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
  readonly canSelectProject: (targetIndex: number) => boolean;
  readonly onSelectProject: (targetIndex: number) => void;
  readonly onSelect: (key: string) => void;
  readonly onDraft: (draft: string) => void;
  readonly onNavigateComposerHistory: WorkbenchComposerHistoryNavigator;
  readonly onLoadProfile: () => void;
  readonly onRefreshProfile: () => void;
  readonly onEnterNewSession: () => void;
  readonly replacementSessionRefusal: WorkbenchReplacementSessionRefusal | null;
  readonly onEnterReplacementSession: () => void;
  readonly onCancelNewSession: () => void;
  readonly onEndpoint: (key: string) => void;
  readonly onModel: (key: string) => void;
  readonly onWorkIntensity: (key: string) => void;
  readonly onExecutionMode: (key: string) => void;
  readonly onAccessMode: (key: string) => void;
  readonly onUseAsDefault: () => void;
  readonly sessionMetadataPending: boolean;
  readonly onMutateSessionMetadata: (
    command: WorkbenchCommandView,
    operation: SessionMetadataOperation,
  ) => Promise<WorkbenchSessionMetadataMutationResult>;
  readonly removalPending: boolean;
  readonly removalNotice: WorkbenchRemovalFeedback | null;
  readonly onRequestSessionRemoval: (command: WorkbenchCommandView) => void;
  readonly onRequestProjectRemoval: (project: WorkbenchProjectOption) => void;
  readonly projectHistoriesPending: boolean;
  readonly onRequestProjectHistories:
    | ((project: WorkbenchProjectOption) => void)
    | undefined;
  readonly interruptPending: boolean;
  readonly interruptFeedback: string | null;
  readonly onInterrupt: (() => void) | undefined;
  readonly steerPending: boolean;
  readonly steerFeedback: string | null;
  readonly onSteer: (() => void) | undefined;
  readonly onSubmit: () => void;
}> = (props) => {
  const liveView = () => (props.result.ok ? props.result.view : undefined);
  return (
    <Show
      when={liveView()}
      fallback={
        <FailureState
          message={failureMessage(props.result)}
          removalNotice={props.removalNotice}
          projectOpen={props.projectOpen}
          canCreateProject={props.canCreateProject}
          onCreateProject={props.onCreateProject}
          canOpenProject={props.canOpenProject}
          onOpenProject={props.onOpenProject}
        />
      }
    >
      {(view) => (
        <WorkbenchScreen
          view={view()}
          windowBridge={props.windowBridge}
          surface={props.surface}
          onSurface={props.onSurface}
          selected={props.selected}
          composer={props.composer}
          profile={props.profile}
          subscriptionAuthentication={props.subscriptionAuthentication}
          historyRecoveryResult={props.historyRecoveryResult}
          historyRecoveryBridge={props.historyRecoveryBridge}
          onHistoryRecoverySnapshot={props.onHistoryRecoverySnapshot}
          onRefreshHistoryRecovery={props.onRefreshHistoryRecovery}
          onBindSubscriptionAuthentication={
            props.onBindSubscriptionAuthentication
          }
          onBeginSubscriptionAuthentication={
            props.onBeginSubscriptionAuthentication
          }
          onCancelSubscriptionAuthentication={
            props.onCancelSubscriptionAuthentication
          }
          appearance={props.appearance}
          appearancePersistencePhase={props.appearancePersistencePhase}
          onAppearance={props.onAppearance}
          runtimeExecutables={props.runtimeExecutables}
          runtimeExecutablePhases={props.runtimeExecutablePhases}
          onSaveRuntimeExecutable={props.onSaveRuntimeExecutable}
          claudePermissionHandling={props.claudePermissionHandling}
          claudePermissionHandlingPersistencePhase={
            props.claudePermissionHandlingPersistencePhase
          }
          onClaudePermissionHandling={props.onClaudePermissionHandling}
          newSession={props.newSession}
          projectSwitch={props.projectSwitch}
          projectOpen={props.projectOpen}
          projectScopeEpoch={props.projectScopeEpoch}
          canCreateProject={props.canCreateProject}
          onCreateProject={props.onCreateProject}
          canOpenProject={props.canOpenProject}
          onOpenProject={props.onOpenProject}
          canSelectProject={props.canSelectProject}
          onSelectProject={props.onSelectProject}
          onSelect={props.onSelect}
          onDraft={props.onDraft}
          onNavigateComposerHistory={props.onNavigateComposerHistory}
          onLoadProfile={props.onLoadProfile}
          onRefreshProfile={props.onRefreshProfile}
          onEnterNewSession={props.onEnterNewSession}
          replacementSessionRefusal={props.replacementSessionRefusal}
          onEnterReplacementSession={props.onEnterReplacementSession}
          onCancelNewSession={props.onCancelNewSession}
          onEndpoint={props.onEndpoint}
          onModel={props.onModel}
          onWorkIntensity={props.onWorkIntensity}
          onExecutionMode={props.onExecutionMode}
          onAccessMode={props.onAccessMode}
          onUseAsDefault={props.onUseAsDefault}
          sessionMetadataPending={props.sessionMetadataPending}
          onMutateSessionMetadata={props.onMutateSessionMetadata}
          removalPending={props.removalPending}
          removalNotice={props.removalNotice}
          onRequestSessionRemoval={props.onRequestSessionRemoval}
          onRequestProjectRemoval={props.onRequestProjectRemoval}
          projectHistoriesPending={props.projectHistoriesPending}
          onRequestProjectHistories={props.onRequestProjectHistories}
          interruptPending={props.interruptPending}
          interruptFeedback={props.interruptFeedback}
          onInterrupt={props.onInterrupt}
          steerPending={props.steerPending}
          steerFeedback={props.steerFeedback}
          onSteer={props.onSteer}
          onSubmit={props.onSubmit}
        />
      )}
    </Show>
  );
};

function failureMessage(result: WorkbenchHostedProjectResult): string {
  return result.ok
    ? shellCopy.liveDataUnavailable
    : dynamicCopy.project.liveUnavailable;
}

interface WorkbenchScreenProps {
  readonly view: WorkbenchHostedProjectView;
  readonly windowBridge: WorkbenchWindowRendererBridge;
  readonly surface: WorkbenchSurface;
  readonly onSurface: (surface: WorkbenchSurface) => void;
  readonly selected: WorkbenchCommandView | undefined;
  readonly composer: WorkbenchComposerState;
  readonly profile: WorkbenchDirectProfileState;
  readonly subscriptionAuthentication?: SettingsSubscriptionAuthenticationState;
  readonly historyRecoveryResult?: HistoryRecoverySnapshotResult | null;
  readonly historyRecoveryBridge?: WorkbenchRendererBridge;
  readonly onHistoryRecoverySnapshot?: (
    result: HistoryRecoverySnapshotResult,
  ) => void;
  readonly onRefreshHistoryRecovery?: () => void;
  readonly onBindSubscriptionAuthentication?: (
    endpointId: WorkbenchRuntimeEndpointId,
  ) => void;
  readonly onBeginSubscriptionAuthentication?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ) => void;
  readonly onCancelSubscriptionAuthentication?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ) => void;
  readonly appearance: WorkbenchAppearancePreference;
  readonly appearancePersistencePhase: WorkbenchAppearancePersistencePhase;
  readonly onAppearance: (action: WorkbenchAppearanceAction) => void;
  readonly runtimeExecutables: WorkbenchRuntimeExecutablePaths;
  readonly runtimeExecutablePhases: Readonly<
    Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeExecutablePhase>>
  >;
  readonly onSaveRuntimeExecutable: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly claudePermissionHandling: WorkbenchClaudePermissionHandling;
  readonly claudePermissionHandlingPersistencePhase: WorkbenchClaudePermissionHandlingPersistencePhase;
  readonly onClaudePermissionHandling: (
    permissionHandling: WorkbenchClaudePermissionHandling,
  ) => void;
  readonly newSession: WorkbenchNewSessionState;
  readonly projectSwitch: WorkbenchProjectSwitchState;
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly projectScopeEpoch?: number;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
  readonly canSelectProject: (targetIndex: number) => boolean;
  readonly onSelectProject: (targetIndex: number) => void;
  readonly onSelect: (key: string) => void;
  readonly onDraft: (draft: string) => void;
  readonly onNavigateComposerHistory: WorkbenchComposerHistoryNavigator;
  readonly onLoadProfile: () => void;
  readonly onRefreshProfile: () => void;
  readonly onEnterNewSession: () => void;
  readonly replacementSessionRefusal: WorkbenchReplacementSessionRefusal | null;
  readonly onEnterReplacementSession: () => void;
  readonly onCancelNewSession: () => void;
  readonly onEndpoint: (key: string) => void;
  readonly onModel: (key: string) => void;
  readonly onWorkIntensity: (key: string) => void;
  readonly onExecutionMode: (key: string) => void;
  readonly onAccessMode: (key: string) => void;
  readonly onUseAsDefault: () => void;
  readonly sessionMetadataPending?: boolean;
  readonly onMutateSessionMetadata?: (
    command: WorkbenchCommandView,
    operation: SessionMetadataOperation,
  ) => Promise<WorkbenchSessionMetadataMutationResult>;
  readonly removalPending?: boolean;
  readonly removalNotice?: WorkbenchRemovalFeedback | null;
  readonly onRequestSessionRemoval?: (command: WorkbenchCommandView) => void;
  readonly onRequestProjectRemoval?: (project: WorkbenchProjectOption) => void;
  readonly projectHistoriesPending?: boolean;
  readonly onRequestProjectHistories?: (
    project: WorkbenchProjectOption,
  ) => void;
  readonly interruptPending?: boolean;
  readonly interruptFeedback?: string | null;
  readonly onInterrupt?: () => void;
  readonly steerPending?: boolean;
  readonly steerFeedback?: string | null;
  readonly onSteer?: () => void;
  readonly onSubmit: () => void;
}

const WorkbenchScreen: Component<WorkbenchScreenProps> = (props) => {
  const [inspectorCollapsed, setInspectorCollapsed] = createSignal(false);
  const freshStartPresentation = () => props.newSession.phase !== "inactive";
  const rendererState = () => ({
    result: { ok: true as const, view: props.view },
    selectedKey: props.selected?.key ?? null,
    composer: props.composer,
    profile: props.profile,
    newSession: props.newSession,
    projectSwitch: props.projectSwitch,
    projectOpen: props.projectOpen,
  });
  const runtimeUnavailable = () =>
    props.profile.phase === "runtime-not-located" &&
    directInputMode(rendererState()) === "start";
  const draftBlocked = () => props.composer.draft.length > 0;
  const actionBlocked = () =>
    props.composer.phase === "pending" ||
    props.profile.phase === "loading" ||
    props.profile.defaultPreference.phase === "pending" ||
    props.newSession.phase === "submitting" ||
    props.newSession.phase === "awaiting-visible" ||
    props.projectOpen.phase === "pending" ||
    props.projectOpen.phase === "recovery-required";

  return (
    <div class="app">
      <Show when={locale()} keyed>
        {(_currentLocale) => (
          <Titlebar
            view={props.view}
            windowBridge={props.windowBridge}
            surface={props.surface}
            onSurface={props.onSurface}
          />
        )}
      </Show>
      <div
        class="body-grid"
        classList={{
          "no-inspector": runtimeUnavailable() || freshStartPresentation(),
          "inspector-collapsed":
            !runtimeUnavailable() &&
            !freshStartPresentation() &&
            inspectorCollapsed(),
        }}
      >
        <Show when={locale()} keyed>
          {(_currentLocale) => (
            <>
              <ProjectRail
          view={props.view}
          selectedKey={
            freshStartPresentation() ? null : (props.selected?.key ?? null)
          }
          surface={props.surface}
          onSurface={props.onSurface}
          runtimeUnavailable={runtimeUnavailable()}
          historyRecoveryAttention={historyRecoveryNeedsAttention(
            props.historyRecoveryResult ?? null,
          )}
          projectSwitch={props.projectSwitch}
          projectOpen={props.projectOpen}
          projectScopeEpoch={props.projectScopeEpoch ?? 0}
          canCreateProject={props.canCreateProject}
          onCreateProject={props.onCreateProject}
          canOpenProject={props.canOpenProject}
          onOpenProject={props.onOpenProject}
          canSelectProject={props.canSelectProject}
          onSelectProject={props.onSelectProject}
          onSelect={props.onSelect}
          onEnterNewSession={props.onEnterNewSession}
          draftBlocked={draftBlocked()}
          actionBlocked={actionBlocked()}
          sessionMetadataPending={props.sessionMetadataPending ?? false}
          onMutateSessionMetadata={
            props.onMutateSessionMetadata ??
            (() => Promise.resolve(Object.freeze({ status: "unavailable" })))
          }
          removalPending={props.removalPending ?? false}
          removalNotice={props.removalNotice ?? null}
          onRequestSessionRemoval={
            props.onRequestSessionRemoval ?? (() => undefined)
          }
          onRequestProjectRemoval={
            props.onRequestProjectRemoval ?? (() => undefined)
          }
          projectHistoriesPending={props.projectHistoriesPending ?? false}
          onRequestProjectHistories={props.onRequestProjectHistories}
              />
              <WorkbenchStage
          active={props.surface === "project"}
          view={props.view}
          selected={props.selected}
          composer={props.composer}
          profile={props.profile}
          newSession={props.newSession}
          projectSwitch={props.projectSwitch}
          projectOpen={props.projectOpen}
          runtimeUnavailable={runtimeUnavailable()}
          inspectorCollapsed={inspectorCollapsed()}
          onShowInspector={() => setInspectorCollapsed(false)}
          canCreateProject={props.canCreateProject}
          onCreateProject={props.onCreateProject}
          canOpenProject={props.canOpenProject}
          onOpenProject={props.onOpenProject}
          onDraft={props.onDraft}
          onNavigateComposerHistory={props.onNavigateComposerHistory}
          onLoadProfile={props.onLoadProfile}
          onOpenProviders={() => props.onSurface("settings")}
          onEnterNewSession={props.onEnterNewSession}
          replacementSessionRefusal={props.replacementSessionRefusal}
          onEnterReplacementSession={props.onEnterReplacementSession}
          onCancelNewSession={props.onCancelNewSession}
          onEndpoint={props.onEndpoint}
          onModel={props.onModel}
          onWorkIntensity={props.onWorkIntensity}
          onExecutionMode={props.onExecutionMode}
          onAccessMode={props.onAccessMode}
          onUseAsDefault={props.onUseAsDefault}
          interruptPending={props.interruptPending ?? false}
          interruptFeedback={props.interruptFeedback ?? null}
          onInterrupt={props.onInterrupt}
          steerPending={props.steerPending ?? false}
          steerFeedback={props.steerFeedback ?? null}
          onSteer={props.onSteer}
          onSubmit={props.onSubmit}
              />
              <Show when={!runtimeUnavailable() && !freshStartPresentation()}>
                <SessionInspector
                  active={props.surface === "project"}
                  command={props.selected}
                  view={props.view}
                  onCollapse={() => setInspectorCollapsed(true)}
                />
              </Show>
            </>
          )}
        </Show>
        <Show when={props.surface === "settings"}>
          <SettingsScreen
            onClose={() => props.onSurface("project")}
            profile={props.profile}
            subscriptionAuthentication={props.subscriptionAuthentication}
            onBindSubscriptionAuthentication={
              props.onBindSubscriptionAuthentication
            }
            onBeginSubscriptionAuthentication={
              props.onBeginSubscriptionAuthentication
            }
            onCancelSubscriptionAuthentication={
              props.onCancelSubscriptionAuthentication
            }
            historyRecoveryResult={props.historyRecoveryResult ?? null}
            historyRecoveryBridge={props.historyRecoveryBridge}
            onHistoryRecoverySnapshot={props.onHistoryRecoverySnapshot}
            onRefreshHistoryRecovery={props.onRefreshHistoryRecovery}
            appearance={props.appearance}
            appearancePersistencePhase={props.appearancePersistencePhase}
            onAppearance={props.onAppearance}
            runtimeExecutables={props.runtimeExecutables}
            runtimeExecutablePhases={props.runtimeExecutablePhases}
            onSaveRuntimeExecutable={props.onSaveRuntimeExecutable}
            claudePermissionHandling={props.claudePermissionHandling}
            claudePermissionHandlingPersistencePhase={
              props.claudePermissionHandlingPersistencePhase
            }
            onClaudePermissionHandling={props.onClaudePermissionHandling}
            canRead={canRefreshDirectSessionProfileFromProviders(
              rendererState(),
            )}
            onRead={props.onRefreshProfile}
          />
        </Show>
      </div>
      <Show when={locale()} keyed>
        {(_currentLocale) => (
          <WorkbenchStatusbar
            view={props.view}
            selected={freshStartPresentation() ? undefined : props.selected}
            profile={props.profile}
            surface={props.surface}
            runtimeUnavailable={runtimeUnavailable()}
            startingNewSession={freshStartPresentation()}
          />
        )}
      </Show>
    </div>
  );
};
