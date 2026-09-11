import { For, Show, type Component } from "solid-js";
import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchFamilyEndpointPreferences,
} from "../contract.ts";
import { defaultWorkbenchFamilyEndpointPreferences } from "../contract.ts";
import { continuationCopy } from "./copy/continuation-copy.ts";
import {
  canCancelNewAgentSessionMode,
  canCreateProject,
  canOpenProject,
  directFacadeEndpointStatusRows,
  directInputMode,
  runtimeNotLocatedCopy,
  type WorkbenchComposerState,
  type WorkbenchDirectProfileState,
  type WorkbenchFacadeSubscriptionAuthenticationInput,
  type WorkbenchNewSessionState,
  type WorkbenchProjectOpenState,
  type WorkbenchProjectSwitchState,
  type WorkbenchReplacementSessionRefusal,
} from "./view-model.ts";

import {
  commandRuntimeFamily,
  runtimeClass,
  commandStatusLabel,
} from "./view-types.ts";
import { ProjectActionsMenu } from "./project-rail.tsx";
import { SessionTranscript, turnStateClass } from "./transcript.tsx";
import { RuntimeQuestions } from "./user-input.tsx";
import {
  BlockedComposer,
  UnavailableRuntimeComposer,
  DirectInputComposer,
} from "./composer.tsx";
import type { WorkbenchComposerHistoryNavigator } from "./composer-history.ts";
import { commonCopy } from "./copy/common-copy.ts";
import { composerFeedbackCopy } from "./copy/composer-copy.ts";
import {
  endpointStatusDescriptionCopy,
  stageCopy,
} from "./copy/stage-copy.ts";

export const WorkbenchStage: Component<{
  readonly active: boolean;
  readonly projectScopeEpoch?: number;
  readonly view: WorkbenchHostedProjectView;
  readonly selected: WorkbenchCommandView | undefined;
  readonly composer: WorkbenchComposerState;
  readonly profile: WorkbenchDirectProfileState;
  readonly newSession: WorkbenchNewSessionState;
  readonly projectSwitch: WorkbenchProjectSwitchState;
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly runtimeUnavailable: boolean;
  readonly inspectorCollapsed: boolean;
  readonly onShowInspector: () => void;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
  readonly onDraft: (draft: string) => void;
  readonly onNavigateComposerHistory: WorkbenchComposerHistoryNavigator;
  readonly onLoadProfile: () => void;
  readonly onOpenProviders: () => void;
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
  readonly interruptPending: boolean;
  readonly interruptFeedback: string | null;
  readonly onInterrupt: (() => void) | undefined;
  readonly steerPending: boolean;
  readonly steerFeedback: string | null;
  readonly onSteer: (() => void) | undefined;
  readonly onSubmit: () => void;
  readonly endpointPreferences?: WorkbenchFamilyEndpointPreferences;
  readonly subscriptionAuthentication?: WorkbenchFacadeSubscriptionAuthenticationInput;
}> = (props) => {
  const rendererState = () => ({
    result: { ok: true as const, view: props.view },
    selectedKey: props.selected?.key ?? null,
    composer: props.composer,
    profile: props.profile,
    newSession: props.newSession,
    projectSwitch: props.projectSwitch,
    projectOpen: props.projectOpen,
  });
  const mode = () => directInputMode(rendererState());
  const freshStartPresentation = () => props.newSession.phase !== "inactive";
  const emptyProject = () => props.view.commands.length === 0;
  const promptSuggestions = () =>
    mode() === "continue"
      ? latestTurnPromptSuggestions(props.selected)
      : Object.freeze([]);
  const suggestionsBlocked = () => props.composer.draft.trim().length > 0;

  return (
    <main
      class="stage"
      aria-hidden={props.active ? undefined : "true"}
    >
      <StageHeader
        view={props.view}
        command={props.selected}
        freshStart={freshStartPresentation()}
        runtimeUnavailable={props.runtimeUnavailable}
        inspectorCollapsed={props.inspectorCollapsed}
        onShowInspector={props.onShowInspector}
        canCreateProject={props.canCreateProject}
        onCreateProject={props.onCreateProject}
        canOpenProject={props.canOpenProject}
        onOpenProject={props.onOpenProject}
        projectOpen={props.projectOpen}
      />
      <Show
        when={!props.runtimeUnavailable}
        fallback={
          <>
            <RuntimeNotLocatedState
              profile={props.profile}
              endpointPreferences={props.endpointPreferences}
              subscriptionAuthentication={props.subscriptionAuthentication}
              onOpenProviders={props.onOpenProviders}
            />
            <UnavailableRuntimeComposer composer={props.composer} />
          </>
        }
      >
        <Show
          when={!emptyProject()}
          fallback={
            <EmptyProjectState
              view={props.view}
              composer={props.composer}
              profile={props.profile}
              newSession={props.newSession}
              projectSwitch={props.projectSwitch}
              projectOpen={props.projectOpen}
              selected={props.selected}
              onDraft={props.onDraft}
              onNavigateComposerHistory={props.onNavigateComposerHistory}
              onLoadProfile={props.onLoadProfile}
              onEnterNewSession={props.onEnterNewSession}
              onCancelNewSession={props.onCancelNewSession}
              onEndpoint={props.onEndpoint}
              onModel={props.onModel}
              onWorkIntensity={props.onWorkIntensity}
              onExecutionMode={props.onExecutionMode}
              onAccessMode={props.onAccessMode}
              onUseAsDefault={props.onUseAsDefault}
              onSubmit={props.onSubmit}
              endpointPreferences={props.endpointPreferences}
              subscriptionAuthentication={props.subscriptionAuthentication}
            />
          }
        >
          <Show
            when={freshStartPresentation()}
            fallback={
              <>
                <SessionTranscript command={props.selected} />
                <RuntimeQuestions
                  scopeKey={`${props.projectScopeEpoch ?? 0}/${props.selected?.key ?? ""}`}
                  sessionKey={props.selected?.session?.metadataKey}
                />
                <Show when={promptSuggestions().length > 0}>
                  <section
                    class="prompt-suggestions"
                    aria-label={stageCopy.suggestedFollowUps}
                  >
                    <span class="prompt-suggestions-title">
                      {stageCopy.suggestedFollowUps}
                    </span>
                    <div class="prompt-suggestion-list">
                      <For each={promptSuggestions()}>
                        {(suggestion) => (
                          <button
                            type="button"
                            class="prompt-suggestion"
                            disabled={suggestionsBlocked()}
                            aria-describedby={
                              suggestionsBlocked()
                                ? "prompt-suggestions-blocked-reason"
                                : undefined
                            }
                            title={suggestionsBlocked() ? composerFeedbackCopy.suggestionRequiresEmptyDraft : suggestion}
                            onClick={() => {
                              if (suggestionsBlocked()) return;
                              props.onDraft(suggestion);
                            }}
                          >
                            {suggestion}
                          </button>
                        )}
                      </For>
                    </div>
                    <Show when={suggestionsBlocked()}>
                      <p
                        id="prompt-suggestions-blocked-reason"
                        class="prompt-suggestions-note"
                      >
                        {composerFeedbackCopy.suggestionRequiresEmptyDraft}
                      </p>
                    </Show>
                  </section>
                </Show>
                <Show
                  when={
                    mode() !== "unavailable" ||
                    props.selected?.status === "accepted" ||
                    props.selected?.status === "in-flight"
                  }
                  fallback={
                    <BlockedComposer
                      command={props.selected}
                      newSession={props.newSession}
                      replacementSessionRefusal={props.replacementSessionRefusal}
                      onEnterReplacementSession={props.onEnterReplacementSession}
                    />
                  }
                >
                  <DirectInputComposer
                    view={props.view}
                    selected={props.selected}
                    composer={props.composer}
                    profile={props.profile}
                    newSession={props.newSession}
                    projectSwitch={props.projectSwitch}
                    projectOpen={props.projectOpen}
                    centered={false}
                    onDraft={props.onDraft}
                    onNavigateComposerHistory={props.onNavigateComposerHistory}
                    onLoadProfile={props.onLoadProfile}
                    onEnterNewSession={props.onEnterNewSession}
                    onCancelNewSession={props.onCancelNewSession}
                    onEndpoint={props.onEndpoint}
                    onModel={props.onModel}
                    onWorkIntensity={props.onWorkIntensity}
                    onExecutionMode={props.onExecutionMode}
                    onAccessMode={props.onAccessMode}
                    onUseAsDefault={props.onUseAsDefault}
                    interruptPending={props.interruptPending}
                    interruptFeedback={props.interruptFeedback}
                    onInterrupt={props.onInterrupt}
                    steerPending={props.steerPending}
                    steerFeedback={props.steerFeedback}
                    onSteer={props.onSteer}
                    onSubmit={props.onSubmit}
                    endpointPreferences={props.endpointPreferences}
                    subscriptionAuthentication={props.subscriptionAuthentication}
                  />
                </Show>
              </>
            }
          >
            <FreshStartStageState
              awaitingVisible={mode() === "unavailable"}
              canReturn={canCancelNewAgentSessionMode(rendererState())}
              onReturn={props.onCancelNewSession}
            />
            <Show
              when={mode() === "start"}
              fallback={
                <BlockedComposer
                  command={undefined}
                  newSession={props.newSession}
                  replacementSessionRefusal={props.replacementSessionRefusal}
                  onEnterReplacementSession={props.onEnterReplacementSession}
                />
              }
            >
              <DirectInputComposer
                view={props.view}
                selected={undefined}
                composer={props.composer}
                profile={props.profile}
                newSession={props.newSession}
                projectSwitch={props.projectSwitch}
                projectOpen={props.projectOpen}
                centered={false}
                onDraft={props.onDraft}
                onNavigateComposerHistory={props.onNavigateComposerHistory}
                onLoadProfile={props.onLoadProfile}
                onEnterNewSession={props.onEnterNewSession}
                onCancelNewSession={props.onCancelNewSession}
                onEndpoint={props.onEndpoint}
                onModel={props.onModel}
                onWorkIntensity={props.onWorkIntensity}
                onExecutionMode={props.onExecutionMode}
                onAccessMode={props.onAccessMode}
                onUseAsDefault={props.onUseAsDefault}
                onSubmit={props.onSubmit}
                endpointPreferences={props.endpointPreferences}
                subscriptionAuthentication={props.subscriptionAuthentication}
              />
            </Show>
            <span class="sr-only">{stageCopy.srNewAgentSessionMode}</span>
          </Show>
        </Show>
      </Show>
    </main>
  );
};

function latestTurnPromptSuggestions(
  command: WorkbenchCommandView | undefined,
): readonly string[] {
  const session = command?.session;
  if (session === undefined) return Object.freeze([]);
  const timeline = session.turns === undefined
    ? session.timeline
    : session.turns.at(-1)?.timeline ?? Object.freeze([]);
  const terminal = timeline.at(-1);
  return terminal?.kind === "turn-completed"
    ? terminal.suggestions ?? Object.freeze([])
    : Object.freeze([]);
}

const StageHeader: Component<{
  readonly view: WorkbenchHostedProjectView;
  readonly command: WorkbenchCommandView | undefined;
  readonly freshStart: boolean;
  readonly runtimeUnavailable: boolean;
  readonly inspectorCollapsed: boolean;
  readonly onShowInspector: () => void;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
  readonly projectOpen: WorkbenchProjectOpenState;
}> = (props) => (
  <div class="stage-head" classList={{
    "has-continuation-stop": !props.freshStart && props.command?.continuationStop !== undefined,
    "has-continuation-progress": !props.freshStart && props.command?.continuationProgress !== undefined,
  }}>
    <div class="stage-title">
      <Show when={!props.freshStart && props.command}>
        {(command) => (
          <span
            class={"rt-dot " + runtimeClass(commandRuntimeFamily(command()))}
            aria-hidden="true"
          />
        )}
      </Show>
      {props.freshStart
        ? stageCopy.newAgentSessionTitle
        : (props.command?.label ?? props.view.project.label)}
      <Show when={!props.freshStart && props.command}>
        {(command) => (
          <span class={"turn-state " + commandTurnStateClass(command())}>
            {command().session?.archived
              ? stageCopy.archivedBadge
              : commandStatusLabel(command())}
          </span>
        )}
      </Show>
    </div>
    <div class="stage-tools">
      <ProjectActionsMenu
        variant="compact"
        projectOpen={props.projectOpen}
        canCreateProject={props.canCreateProject}
        onCreateProject={props.onCreateProject}
        canOpenProject={props.canOpenProject}
        onOpenProject={props.onOpenProject}
      />
      <Show when={props.view.commands.length === 0 && !props.runtimeUnavailable}>
        <button
          type="button"
          class="btn ghost sm create-project-button"
          disabled={!props.canCreateProject()}
          onClick={props.onCreateProject}
        >
          {commonCopy.createProject}
        </button>
        <button
          type="button"
          class="btn ghost sm open-project-button"
          disabled={!props.canOpenProject()}
          onClick={props.onOpenProject}
        >
          {commonCopy.openProject}
        </button>
      </Show>
      <Show
        when={
          props.inspectorCollapsed &&
          !props.runtimeUnavailable &&
          !props.freshStart
        }
      >
        <button
          type="button"
          class="icon-btn inspector-reopen"
          aria-label={stageCopy.showSessionPanel}
          title={stageCopy.showSessionPanel}
          onClick={props.onShowInspector}
        >
          ‹
        </button>
      </Show>
    </div>
    <Show when={!props.freshStart && props.command?.continuationStop}>
      {(stop) => (
        <div class="continuation-stop-notice" role="status">
          <strong>{continuationCopy.heading(stop().step, stop().limit)}</strong>
          <span>{continuationCopy.reasons[stop().reason]}</span>
        </div>
      )}
    </Show>
    <Show when={!props.freshStart && props.command?.continuationProgress}>
      {(progress) => (
        <div class="continuation-progress-notice" role="status">
          <strong>{continuationCopy.progress(progress().step, progress().limit)}</strong>
        </div>
      )}
    </Show>
  </div>
);

const FreshStartStageState: Component<{
  readonly awaitingVisible: boolean;
  readonly canReturn: boolean;
  readonly onReturn: () => void;
}> = (props) => (
  <section class="stage-state fresh-start-state" aria-labelledby="fresh-start-title">
    <div class="state-card">
      <span class="state-glyph small" aria-hidden="true">
        ＋
      </span>
      <h1 id="fresh-start-title">
        {props.awaitingVisible
          ? stageCopy.awaitingTitle
          : stageCopy.newAgentSessionTitle}
      </h1>
      <p>
        {props.awaitingVisible
          ? stageCopy.awaitingBody
          : stageCopy.freshStartBody}
      </p>
      <div class="state-actions">
        <button
          type="button"
          class="btn primary"
          disabled={!props.canReturn}
          onClick={props.onReturn}
        >
          {stageCopy.returnToSelectedSession}
        </button>
      </div>
    </div>
  </section>
);

const EmptyProjectState: Component<{
  readonly view: WorkbenchHostedProjectView;
  readonly selected: WorkbenchCommandView | undefined;
  readonly composer: WorkbenchComposerState;
  readonly profile: WorkbenchDirectProfileState;
  readonly newSession: WorkbenchNewSessionState;
  readonly projectSwitch: WorkbenchProjectSwitchState;
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly onDraft: (draft: string) => void;
  readonly onNavigateComposerHistory: WorkbenchComposerHistoryNavigator;
  readonly onLoadProfile: () => void;
  readonly onEnterNewSession: () => void;
  readonly onCancelNewSession: () => void;
  readonly onEndpoint: (key: string) => void;
  readonly onModel: (key: string) => void;
  readonly onWorkIntensity: (key: string) => void;
  readonly onExecutionMode: (key: string) => void;
  readonly onAccessMode: (key: string) => void;
  readonly onUseAsDefault: () => void;
  readonly onSubmit: () => void;
  readonly endpointPreferences?: WorkbenchFamilyEndpointPreferences;
  readonly subscriptionAuthentication?: WorkbenchFacadeSubscriptionAuthenticationInput;
}> = (props) => (
  <div class="stage-state">
    <div class="state-card empty-project-card">
      <span class="state-glyph" aria-hidden="true">
        ◇
      </span>
      <h1>{stageCopy.emptyProjectTitle}</h1>
      <p>
        {stageCopy.emptyProjectBody}
      </p>
      <DirectInputComposer
        view={props.view}
        selected={props.selected}
        composer={props.composer}
        profile={props.profile}
        newSession={props.newSession}
        projectSwitch={props.projectSwitch}
        projectOpen={props.projectOpen}
        centered
        onDraft={props.onDraft}
        onNavigateComposerHistory={props.onNavigateComposerHistory}
        onLoadProfile={props.onLoadProfile}
        onEnterNewSession={props.onEnterNewSession}
        onCancelNewSession={props.onCancelNewSession}
        onEndpoint={props.onEndpoint}
        onModel={props.onModel}
        onWorkIntensity={props.onWorkIntensity}
        onExecutionMode={props.onExecutionMode}
        onAccessMode={props.onAccessMode}
        onUseAsDefault={props.onUseAsDefault}
        onSubmit={props.onSubmit}
        endpointPreferences={props.endpointPreferences}
        subscriptionAuthentication={props.subscriptionAuthentication}
      />
      <div class="suggestions" aria-label={stageCopy.waysToStart}>
        <For each={stageCopy.suggestions}>
          {(suggestion) => (
            <button
              type="button"
              class="suggestion"
              onClick={() => props.onDraft(suggestion)}
            >
              <span class="sg-glyph" aria-hidden="true">
                ›
              </span>
              <span class="sg-text">{suggestion}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  </div>
);

const RuntimeNotLocatedState: Component<{
  readonly profile: WorkbenchDirectProfileState;
  readonly endpointPreferences?: WorkbenchFamilyEndpointPreferences;
  readonly subscriptionAuthentication?: WorkbenchFacadeSubscriptionAuthenticationInput;
  readonly onOpenProviders: () => void;
}> = (props) => {
  const rows = () =>
    directFacadeEndpointStatusRows(
      props.profile,
      props.endpointPreferences ?? defaultWorkbenchFamilyEndpointPreferences,
      props.subscriptionAuthentication,
    );
  return (
    <div class="stage-state runtime-not-located-state">
      <div class="state-card">
        <span class="state-glyph is-warn" aria-hidden="true">
          ⚠
        </span>
        <h1>{stageCopy.noRuntimeTitle}</h1>
        <p>{runtimeNotLocatedCopy}</p>
        <ul class="checklist endpoint-status-list" aria-label={stageCopy.endpointStatusListLabel}>
          <For each={rows()}>
            {(row) => (
              <li>
                <span class="ck unknown" aria-hidden="true">
                  ●
                </span>
                <span>
                  <b>{row.runtimeFamilyLabel} · {row.statusLabel}</b>{" "}
                  {endpointStatusDescriptionCopy(row.endpointLabel, row.detail)}
                </span>
              </li>
            )}
          </For>
        </ul>
        <div class="state-actions">
          <button
            type="button"
            class="btn primary"
            onClick={props.onOpenProviders}
          >
            {stageCopy.openSettings}
          </button>
        </div>
        <p class="runtime-boundary-copy">
          {stageCopy.runtimeBoundary}
        </p>
      </div>
    </div>
  );
};

function commandTurnStateClass(command: WorkbenchCommandView): string {
  return command.failureCategory === "interrupted"
    ? "is-interrupted"
    : turnStateClass(command.status);
}
