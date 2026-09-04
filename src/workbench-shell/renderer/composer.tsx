import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Component,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchInterruptControl,
  WorkbenchSteerControl,
  WorkbenchModelOption,
  WorkbenchRuntimeEndpointOption,
  WorkbenchSessionContextUsage,
} from "../contract.ts";
import {
  WORKBENCH_DIRECT_INPUT_MAX_LENGTH,
  isValidWorkbenchDirectInput,
} from "../contract.ts";
import {
  canEnterNewAgentSessionMode,
  canSubmitDirectInput,
  canUseDirectSessionProfileAsDefault,
  contextRingPresentation,
  contextUsedTokensLabel,
  directEndpointStatusRows,
  directProfileEndpoints,
  directProfileModels,
  directWorkIntensityPresentationLabel,
  directInputCopy,
  continuationInputCopy,
  directInputMode,
  failureCopy,
  type WorkbenchComposerState,
  type WorkbenchDirectProfileState,
  type WorkbenchNewSessionState,
  type WorkbenchProjectOpenState,
  type WorkbenchProjectSwitchState,
  type WorkbenchReplacementSessionRefusal,
} from "./view-model.ts";
import {
  PROFILE_POPOVER_HEADING_ID,
  PROFILE_POPOVER_ID,
  createBrowserProfilePopoverElement,
  createBrowserProfilePopoverEnvironment,
  createProfilePopoverLifecycle,
  nextProfileOptionIndex,
  toggleProfilePopover,
  type ProfilePopoverOpenState,
  type ProfilePopoverPlacement,
} from "./profile-popover.ts";
import {
  composerHistoryDirection,
  type WorkbenchComposerHistoryNavigator,
} from "./composer-history.ts";

import {
  blockedComposerCopy,
  exitUnavailableReasonCopy,
  noSessionAttachedCopy,
  unavailableComposerCopy,
  targetBarCopy,
  profileChipCopy,
  pickerCopy,
  composerActionsCopy,
  composerFeedbackCopy,
  composerControlCopy,
  interruptCopy,
  steerCopy,
  endpointControlNameCopy,
  modelControlNameCopy,
  intensityControlNameCopy,
  lockedEndpointAriaCopy,
  selectedSessionSummaryCopy,
  draftPreservedCountCopy,
  profilePopoverTitleCopy,
} from "./copy/composer-copy.ts";
import {
  profileNotRecordedSummaryCopy,
  recordedProfileSummaryCopy,
} from "./copy/runtime-profile-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import {
  presentationText,
  type WorkbenchPresentationText,
} from "./presentation-text.ts";

import {
  fixedExecutionModeLabel,
  fixedAccessModeLabel,
  workbenchFallbackControlLabel,
  workbenchFallbackControlLabelTitle,
  recordedRequestedProfile,
  commandRuntimeFamily,
  runtimeClass,
  commandStatusLabel,
} from "./view-types.ts";
import { EmptyState } from "./states.tsx";

export const CommandWithoutSession: Component<{
  readonly command: WorkbenchCommandView;
}> = (props) => {
  const message = () =>
    props.command.failureCategory === undefined
      ? noSessionAttachedCopy
      : failureCopy[props.command.failureCategory];
  return (
    <>
      <EmptyState
        title={commandStatusLabel(props.command)}
        body={message()}
        tone={props.command.status}
      />
      <Show when={props.command.status === "recovery-required"}>
        <div class="failure-block recovery-block">
          <h3>{blockedComposerCopy.recoveryBlockHeading}</h3>
          <p>
            {blockedComposerCopy.recoveryBlockBody}
          </p>
        </div>
      </Show>
    </>
  );
};

export const BlockedComposer: Component<{
  readonly command: WorkbenchCommandView | undefined;
  readonly newSession: WorkbenchNewSessionState;
  /* Decided by the shell from the state `enterReplacementSession` will itself
     read, and passed in whole. This panel must not re-derive it: the state the
     Stage can see is a proxy — with no selection it reports the view's initial
     command as selected while the shell's `selectedKey` is still null, which is
     one of the states the handler refuses in.

     F211 widened this from a boolean to the refusing term, and it stays ONE
     value: the button's `disabled` and the sentence beneath it are read off the
     same thing, so a panel that shuts the exit while naming a reason that is not
     shutting it is unrepresentable rather than merely untested. */
  readonly replacementSessionRefusal: WorkbenchReplacementSessionRefusal | null;
  readonly onEnterReplacementSession: () => void;
}> = (props) => {
  const recorded = () => recordedRequestedProfile(props.command);
  const fixedTerminal = () =>
    props.command?.status === "completed" || props.command?.status === "failed";
  const selectedProfileSummary = () =>
    recorded() === undefined || props.command === undefined
      ? undefined
      : profileSummary(props.command);
  const title = () => {
    if (props.newSession.phase === "awaiting-visible") {
      return blockedComposerCopy.waitingForNew;
    }
    if (props.command?.session?.archived) return blockedComposerCopy.archivedTitle;
    if (props.command?.status === "recovery-required") return blockedComposerCopy.outcomeUnknown;
    if (props.command?.status === "in-flight") return blockedComposerCopy.stillActive;
    return blockedComposerCopy.cantContinue;
  };
  const body = () => {
    if (props.newSession.phase === "awaiting-visible") {
      return blockedComposerCopy.waitingBody;
    }
    if (props.command?.session?.archived) {
      return blockedComposerCopy.archivedBody;
    }
    if (props.command?.status === "recovery-required") {
      return blockedComposerCopy.recoveryBody;
    }
    if (props.command?.status === "in-flight") {
      return blockedComposerCopy.inFlightBody;
    }
    return blockedComposerCopy.replacementBody;
  };
  /* The exit is shut for a reason the panel has not already given. `waitingBody`
     already explains the awaiting-visible case, so saying it twice there would
     be noise; every other refusal was previously silent. */
  const exitReason = () =>
    props.replacementSessionRefusal !== null &&
    props.newSession.phase !== "awaiting-visible"
      ? props.replacementSessionRefusal
      : null;
  return (
    <div class="composer blocked-composer">
      <div class="blocked-bar">
        <span
          class="blocked-glyph"
          classList={{ "is-failed": props.command?.status === "failed" }}
          aria-hidden="true"
        >
          {fixedTerminal() ? "⚠" : "!"}
        </span>
        <span class="bb-text">
          <b>{title()}</b>
          <span>{body()}</span>
          <Show when={exitReason()}>
            {(reason) => (
              <span class="bb-blocked-reason">
                {exitUnavailableReasonCopy(reason())}
              </span>
            )}
          </Show>
        </span>
        <button
          type="button"
          class="btn primary new-session-button"
          disabled={props.replacementSessionRefusal !== null}
          onClick={props.onEnterReplacementSession}
        >
          {composerActionsCopy.newAgentSession} <kbd>{composerActionsCopy.ctrlN}</kbd>
        </button>
      </div>
      <div class="composer-foot">
        <Show
          when={selectedProfileSummary()}
          fallback={<span>{composerFeedbackCopy.executionRemainsSingleAgent}</span>}
        >
          {(summary) => <span>{selectedSessionSummaryCopy(summary())}</span>}
        </Show>
        <span class="grow" />
        <span>{composerFeedbackCopy.footRequiresSelection}</span>
      </div>
    </div>
  );
};

export const UnavailableRuntimeComposer: Component<{
  readonly composer: WorkbenchComposerState;
}> = (props) => (
  <div class="composer unavailable-runtime-composer">
    <div class="target-bar is-blocked">
      <span class="tb-kicker">{unavailableComposerCopy.pausedKicker}</span>
      <span class="tb-text">
        {props.composer.draft.length > 0
          ? unavailableComposerCopy.pausedBody
          : unavailableComposerCopy.pausedBodyNoDraft}
      </span>
    </div>
    <div class="controlbar">
      <span class="chip locked is-empty">
        <span class="rt-dot" aria-hidden="true" />
        <span class="chip-val">{unavailableComposerCopy.noEndpointChip}</span>
      </span>
      <span class="chip-sep" aria-hidden="true" />
      <FixedModeChip label={composerControlCopy.exec} value={fixedExecutionModeLabel} />
      <FixedModeChip label={composerControlCopy.access} value={fixedAccessModeLabel} />
    </div>
    <div class="input-shell is-disabled">
      <textarea
        id="direct-input"
        rows={4}
        maxlength={WORKBENCH_DIRECT_INPUT_MAX_LENGTH}
        disabled
        value={props.composer.draft}
        aria-label={composerActionsCopy.preservedDraftAria}
      />
      <div class="input-side">
        <span />
        <button type="button" class="send" disabled>
          {composerActionsCopy.send} <kbd>{composerActionsCopy.ctrlEnter}</kbd>
        </button>
      </div>
    </div>
    <div class="composer-foot">
      <span>{draftPreservedCountCopy(props.composer.draft.length)}</span>
      <span class="grow" />
      <span class="count">
        {props.composer.draft.length.toLocaleString("en-US")} /{" "}
        {WORKBENCH_DIRECT_INPUT_MAX_LENGTH.toLocaleString("en-US")}
      </span>
    </div>
  </div>
);

type ProfilePopoverKind =
  | "endpoint"
  | "model"
  | "intensity";

type OpenProfilePopover = ProfilePopoverOpenState<
  ProfilePopoverKind,
  HTMLButtonElement
>;

export const DirectInputComposer: Component<{
  readonly view: WorkbenchHostedProjectView;
  readonly selected: WorkbenchCommandView | undefined;
  readonly composer: WorkbenchComposerState;
  readonly profile: WorkbenchDirectProfileState;
  readonly newSession: WorkbenchNewSessionState;
  readonly projectSwitch: WorkbenchProjectSwitchState;
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly centered: boolean;
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
  readonly interruptPending?: boolean;
  readonly interruptFeedback?: WorkbenchPresentationText | null;
  readonly onInterrupt?: () => void;
  readonly steerPending?: boolean;
  readonly steerFeedback?: WorkbenchPresentationText | null;
  readonly onSteer?: () => void;
  readonly onSubmit: () => void;
}> = (props) => {
  const [openPopover, setOpenPopover] =
    createSignal<OpenProfilePopover | null>(null);
  const pending = () => props.composer.phase === "pending";
  const defaultSavePending = () =>
    props.profile.defaultPreference.phase === "pending";
  const projectSwitching = () => props.projectSwitch.phase === "pending";
  const projectOpening = () =>
    props.projectOpen.phase === "pending" ||
    props.projectOpen.phase === "recovery-required";
  const directState = () => ({
    result: { ok: true as const, view: props.view },
    selectedKey: props.selected?.key ?? null,
    composer: props.composer,
    profile: props.profile,
    newSession: props.newSession,
    projectSwitch: props.projectSwitch,
    projectOpen: props.projectOpen,
  });
  const mode = () => directInputMode(directState());
  const activeTurn = () =>
    props.selected?.status === "accepted" ||
    props.selected?.status === "in-flight";
  const continuing = () => mode() === "continue";
  const recorded = () => recordedRequestedProfile(props.selected);
  const interruptControl = () => props.selected?.interrupt;
  const steerControl = () => props.selected?.steer;
  const interruptPending = () => props.interruptPending === true;
  const steerPending = () => props.steerPending === true;
  const interruptTitle = () => {
    const feedback = presentationText(props.interruptFeedback);
    if (feedback !== null) return feedback;
    if (interruptPending()) {
      return interruptCopy.requestedWaiting;
    }
    const control = interruptControl();
    if (control?.status === "available") {
      return props.onInterrupt === undefined
        ? interruptCopy.unavailableTurn
        : interruptCopy.stopRunningTurn;
    }
    if (control !== undefined) return interruptControlReason(control);
    return props.selected?.status === "accepted"
      ? interruptCopy.becomesAvailableWhenRunning
      : interruptCopy.unavailableTurn;
  };
  const steerTitle = () => {
    const feedback = presentationText(props.steerFeedback);
    if (feedback !== null) return feedback;
    if (steerPending()) return steerCopy.sending;
    const control = steerControl();
    if (control?.status === "available") {
      return props.onSteer === undefined
        ? steerCopy.unavailable
        : steerCopy.availableTitle;
    }
    return control === undefined
      ? steerCopy.unavailable
      : steerControlReason(control);
  };
  const canSteer = () =>
    steerControl()?.status === "available" &&
    !steerPending() &&
    props.onSteer !== undefined &&
    isValidWorkbenchDirectInput(props.composer.draft);
  const endpoints = () => directProfileEndpoints(directState());
  const selectedEndpoint = () =>
    endpoints().find(
      (endpoint) => endpoint.key === props.profile.selectedEndpointKey,
    );
  const models = () => directProfileModels(directState());
  const selectedModel = () =>
    models().find((model) => model.key === props.profile.selectedModelKey);
  const selectedWorkIntensity = () =>
    selectedModel()?.workIntensities.find(
      (option) => option.key === props.profile.selectedWorkIntensityKey,
    );
  const selectedExecutionMode = () =>
    selectedEndpoint()?.executionModes.find(
      (option) => option.key === props.profile.selectedExecutionModeKey,
    );
  const selectedAccessMode = () =>
    selectedEndpoint()?.accessModes.find(
      (option) => option.key === props.profile.selectedAccessModeKey,
    );
  const canSubmit = () => canSubmitDirectInput(directState());
  const canSaveDefault = () =>
    canUseDirectSessionProfileAsDefault(directState());
  const explicitStart = () =>
    props.newSession.phase === "active" ||
    props.newSession.phase === "submitting";
  const composerCopy = () =>
    mode() === "continue" ? continuationInputCopy : directInputCopy;
  const targetContext = () =>
    mode() === "continue" || activeTurn()
      ? props.selected?.session?.context
      : undefined;
  const closePopover = (restoreFocus: boolean): void => {
    const trigger = openPopover()?.trigger;
    setOpenPopover(null);
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  };

  /* The composer disables itself while direct input is awaiting durable
     acceptance, a Project is switching or a Project is opening. Disabling the focused element blurs it
     to <body>, so before this the caret was gone after every single submit and
     the only way back was a mouse click — the shape the owner described as a
     control that has to be pressed twice.

     The flag cannot be read off `activeElement` in the effect: by the time it
     runs, the disable has already blurred the element. The blur itself carries
     it. A blur that finds the element ALREADY disabled is the disable taking
     focus away, and is the only thing that arms the restore; a blur while still
     enabled is the user leaving deliberately and disarms it. So this gives back
     exactly the caret it took and never steals one.

     Deliberately blur-only, with no focus handler. The owner picker rule is
     that "textarea focus is inert" — focusing the composer must trigger nothing,
     discovery least of all — and `renderer-view-model.test.ts` enforces it by
     forbidding any focus handler in this file. That assertion is correct, it
     caught an earlier version of this repair that added one, and it stays
     untouched. A blur that only records why focus left triggers nothing. */
  let directInput: HTMLTextAreaElement | undefined;
  let composerLostFocusToDisable = false;
  const noteComposerBlur = (event: FocusEvent): void => {
    composerLostFocusToDisable = (
      event.currentTarget as HTMLTextAreaElement
    ).disabled;
  };
  createEffect(() => {
    const disabled =
      pending() || projectSwitching() || projectOpening();
    const element = directInput;
    if (disabled || element === undefined || !composerLostFocusToDisable) return;
    composerLostFocusToDisable = false;
    element.focus({ preventScroll: true });
  });
  const open = (
    kind: ProfilePopoverKind,
    trigger: HTMLButtonElement,
  ): void => {
    const next = toggleProfilePopover(openPopover(), kind, trigger);
    setOpenPopover(next);
    if (
      next !== null &&
      kind === "endpoint" && props.profile.phase === "idle"
    ) {
      props.onLoadProfile();
    }
  };

  return (
    <div class="composer" classList={{ centered: props.centered }}>
      <Show when={!props.centered && props.view.commands.length > 0}>
        <div class="target-bar" classList={{ "is-new": explicitStart() }}>
          <span class="tb-kicker">
            {activeTurn()
              ? props.selected?.status === "accepted"
                ? targetBarCopy.starting
                : targetBarCopy.running
              : mode() === "continue"
                ? targetBarCopy.continues
                : targetBarCopy.starts}
          </span>
          <span class="tb-text">
            <b>
              {activeTurn() || mode() === "continue"
                ? props.selected?.label
                : targetBarCopy.newAgentSession}
            </b>
            {composerControlCopy.emDashSpaced}
            {activeTurn()
              ? targetBarCopy.runningNote
              : mode() === "continue"
              ? targetBarCopy.continueNote
              : targetBarCopy.startNote}
          </span>
          <Show when={!explicitStart() && !activeTurn()}>
            <button
              type="button"
              class="btn ghost sm new-session-button"
              disabled={!canEnterNewAgentSessionMode(directState())}
              onClick={props.onEnterNewSession}
            >
              {targetBarCopy.newAgentSession}
            </button>
          </Show>
        </div>
      </Show>

      <Show when={activeTurn() || mode() === "start" || mode() === "continue"}>
        <div class="controlbar">
          <Show
            when={activeTurn()}
            fallback={
              <ProfileControlChips
                profile={props.profile}
                endpoints={endpoints()}
                selectedEndpoint={selectedEndpoint()}
                selectedModel={selectedModel()}
                selectedIntensityLabel={selectedWorkIntensity()?.label}
                pending={
                  pending() ||
                  defaultSavePending() ||
                  projectSwitching() ||
                  projectOpening()
                }
                endpointLocked={continuing()}
                lockedEndpointRuntimeFamilyLabel={
                  recorded()?.runtimeFamilyLabel ??
                  commandRuntimeFamily(props.selected)
                }
                lockedEndpointLabel={recorded()?.endpointLabel ?? null}
                openPopover={openPopover()?.kind ?? null}
                onOpen={open}
              />
            }
          >
            <span
              id="direct-runtime-endpoint"
              class="chip locked chip-endpoint"
              title={profileChipCopy.lockedRunningTitle}
            >
              <span class="lock" aria-hidden="true">🔒</span>
              <span
                class={
                  "rt-dot " +
                  runtimeClass(
                    recorded()?.runtimeFamilyLabel ??
                      commandRuntimeFamily(props.selected),
                  )
                }
                aria-hidden="true"
              />
              <span class="chip-val">
                {recorded()?.runtimeFamilyLabel ??
                  commandRuntimeFamily(props.selected)}
                <Show when={recorded()?.endpointLabel}>
                  {(label) => <>{composerControlCopy.dotSeparator}{label()}</>}
                </Show>
              </span>
            </span>
            <span class="chip locked">
              <span class="chip-key">{composerControlCopy.model}</span>
              <span class="chip-val">{recorded()?.modelLabel ?? composerControlCopy.emDash}</span>
            </span>
            <span class="chip locked chip-intensity">
              <span class="chip-key">
                {recorded()?.workIntensityControlLabel.label ??
                  composerControlCopy.workIntensity}
              </span>
              <span class="chip-val">
                {recorded()?.workIntensityLabel ?? composerControlCopy.emDash}
              </span>
            </span>
          </Show>
          <span class="chip-sep" aria-hidden="true" />
          <FixedModeChip
            label={composerControlCopy.exec}
            value={
              selectedExecutionMode()?.label ??
              recorded()?.executionModeLabel ??
              fixedExecutionModeLabel
            }
          />
          <FixedModeChip
            label={composerControlCopy.access}
            value={
              selectedAccessMode()?.label ??
              recorded()?.accessModeLabel ??
              fixedAccessModeLabel
            }
          />
          <span class="chip-spacer" />
          <Show
            when={
              !activeTurn() &&
              !continuing() &&
              props.profile.phase === "ready"
            }
          >
            <button
              type="button"
              class="btn ghost sm default-preference-button"
              disabled={!canSaveDefault()}
              aria-busy={defaultSavePending()}
              onClick={props.onUseAsDefault}
            >
              {defaultSavePending() ? profileChipCopy.savingDefault : profileChipCopy.useAsDefault}
            </button>
          </Show>
          <Show when={!activeTurn() && openPopover()}>
            {(popover) => (
              <Portal mount={popover().trigger.ownerDocument.body}>
                <div
                  class="composer profile-popover-portal-host"
                  style={{ display: "contents" }}
                >
                  <div
                    class="controlbar profile-popover-portal-anchor"
                    style={{ display: "contents" }}
                  >
                    <ProfilePopover
                      kind={popover().kind}
                      anchor={popover().trigger}
                      profile={props.profile}
                      endpoints={endpoints()}
                      selectedEndpoint={selectedEndpoint()}
                      models={models()}
                      selectedModel={selectedModel()}
                      selectedEndpointKey={props.profile.selectedEndpointKey}
                      selectedModelKey={props.profile.selectedModelKey}
                      selectedWorkIntensityKey={
                        props.profile.selectedWorkIntensityKey
                      }
                      onEndpoint={(key) => {
                        props.onEndpoint(key);
                        closePopover(true);
                      }}
                      onModel={(key) => {
                        props.onModel(key);
                        closePopover(true);
                      }}
                      onWorkIntensity={props.onWorkIntensity}
                      onClose={() => closePopover(true)}
                      onLifecycleDismiss={() => setOpenPopover(null)}
                    />
                  </div>
                </div>
              </Portal>
            )}
          </Show>
        </div>
        <p
          class="control-note"
          classList={{
            "is-error":
              props.profile.phase === "unavailable" ||
              props.profile.defaultPreference.phase === "error",
            "is-ok":
              props.profile.defaultPreference.phase === "saved",
          }}
          role={
            props.profile.phase === "unavailable" ||
            props.profile.defaultPreference.phase === "error"
              ? "alert"
              : "status"
          }
          aria-live="polite"
        >
          {activeTurn()
            ? `${steerTitle()} · ${interruptTitle()}`
            : presentationText(props.profile.defaultPreference.feedback) ??
              presentationText(props.profile.feedback) ??
              (props.profile.phase === "idle"
              ? continuing()
                ? composerFeedbackCopy.loadingContinuationCatalog
                : composerFeedbackCopy.endpointsReadOnOpen
              : continuing()
                ? composerFeedbackCopy.nextTurnModesFixed
                : composerFeedbackCopy.selectionsStayLocal)}
        </p>
      </Show>

      <div
        class="input-shell"
        classList={{
          "is-disabled": pending() || projectSwitching() || projectOpening(),
        }}
      >
        <textarea
          ref={directInput}
          id="direct-input"
          rows={4}
          maxlength={WORKBENCH_DIRECT_INPUT_MAX_LENGTH}
          value={props.composer.draft}
          placeholder={
            activeTurn()
              ? steerControl()?.status === "available"
                ? steerCopy.availablePlaceholder
                : steerCopy.localDraftPlaceholder
              : composerCopy().placeholder
          }
          disabled={pending() || projectSwitching() || projectOpening()}
          aria-describedby="direct-input-feedback"
          aria-invalid={props.composer.phase === "error"}
          onBlur={noteComposerBlur}
          onInput={(event) => props.onDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            const historyDirection = composerHistoryDirection(event);
            if (historyDirection !== null) {
              const recalledDraft = props.onNavigateComposerHistory({
                direction: historyDirection,
                draft: event.currentTarget.value,
                selectionStart: event.currentTarget.selectionStart,
                selectionEnd: event.currentTarget.selectionEnd,
              });
              if (recalledDraft !== null) {
                event.preventDefault();
                queueMicrotask(() => {
                  if (directInput?.value !== recalledDraft) return;
                  directInput.setSelectionRange(
                    recalledDraft.length,
                    recalledDraft.length,
                  );
                });
                return;
              }
            }
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              if (activeTurn()) props.onSteer?.();
              else props.onSubmit();
            }
          }}
        />
        <div class="input-side">
          <ContextUsage
            context={targetContext()}
            endpointAvailable={props.profile.phase !== "runtime-not-located"}
          />
          <Show
            when={activeTurn()}
            fallback={
              <button
                type="button"
                class="send submit-button"
                disabled={!canSubmit()}
                aria-busy={pending()}
                onClick={props.onSubmit}
              >
                {pending()
                  ? composerActionsCopy.accepting
                  : mode() === "continue"
                    ? composerActionsCopy.send
                    : composerActionsCopy.start}{" "}
                <kbd>{composerActionsCopy.ctrlEnter}</kbd>
              </button>
            }
          >
            <div class="running-actions">
              <Show when={steerControl()?.status !== "unsupported"}>
                <button
                  type="button"
                  class="send guide-button"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  aria-busy={steerPending()}
                  disabled={!canSteer()}
                  title={steerTitle()}
                  onClick={() => props.onSteer?.()}
                >
                  {steerPending()
                    ? composerActionsCopy.accepting
                    : composerActionsCopy.guide}{" "}
                  <kbd>{composerActionsCopy.ctrlEnter}</kbd>
                </button>
              </Show>
              <button
                type="button"
                class="send stop-button"
                aria-keyshortcuts="Escape"
                aria-busy={interruptPending()}
                disabled={
                  interruptControl()?.status !== "available" ||
                  interruptPending() ||
                  props.onInterrupt === undefined
                }
                title={interruptTitle()}
                onClick={() => props.onInterrupt?.()}
              >
                {composerActionsCopy.stop} <kbd>{composerActionsCopy.escKey}</kbd>
              </button>
            </div>
          </Show>
        </div>
      </div>

      <div class="composer-foot">
        <span id="direct-input-feedback">
          {activeTurn()
            ? presentationText(props.steerFeedback) ??
              (steerControl()?.status === "available"
                ? steerCopy.availableFoot
                : steerCopy.localDraftFoot)
            : presentationText(props.composer.feedback) ??
              (mode() === "continue"
              ? composerFeedbackCopy.continuationFoot
              : composerFeedbackCopy.startFoot)}
        </span>
        <span class="grow" />
        <span class="count">
          {props.composer.draft.length.toLocaleString("en-US")} /{" "}
          {WORKBENCH_DIRECT_INPUT_MAX_LENGTH.toLocaleString("en-US")}
        </span>
      </div>
    </div>
  );
};

const ProfileControlChips: Component<{
  readonly profile: WorkbenchDirectProfileState;
  readonly endpoints: readonly WorkbenchRuntimeEndpointOption[];
  readonly selectedEndpoint: WorkbenchRuntimeEndpointOption | undefined;
  readonly selectedModel: WorkbenchModelOption | undefined;
  readonly selectedIntensityLabel: string | undefined;
  readonly pending: boolean;
  readonly endpointLocked: boolean;
  readonly lockedEndpointRuntimeFamilyLabel: string;
  readonly lockedEndpointLabel: string | null;
  readonly openPopover: ProfilePopoverKind | null;
  readonly onOpen: (
    kind: ProfilePopoverKind,
    trigger: HTMLButtonElement,
  ) => void;
}> = (props) => {
  const vendor = () =>
    props.selectedEndpoint === undefined
      ? ""
      : runtimeClass(props.selectedEndpoint.runtimeFamilyLabel);
  const endpointVendor = () =>
    props.endpointLocked
      ? runtimeClass(props.lockedEndpointRuntimeFamilyLabel)
      : vendor();
  const endpointControlName = () =>
    endpointControlNameCopy(props.selectedEndpoint?.runtimeFamilyLabel);
  const modelControlName = () =>
    modelControlNameCopy(props.selectedModel?.label);
  const intensityControlLabel = () =>
    props.selectedModel?.workIntensityLabel ?? composerControlCopy.workIntensity;
  const intensityPresentationLabel = () =>
    directWorkIntensityPresentationLabel(
      props.selectedModel,
      props.selectedIntensityLabel,
    ) ?? profileChipCopy.notSelected;
  const intensityControlName = () =>
    intensityControlNameCopy(intensityControlLabel(), intensityPresentationLabel());
  return (
    <>
      <Show
        when={!props.endpointLocked}
        fallback={
          <span
            id="direct-runtime-endpoint"
            class="chip locked chip-endpoint"
            title={profileChipCopy.lockedSessionTitle}
            aria-label={lockedEndpointAriaCopy(
              props.lockedEndpointRuntimeFamilyLabel,
              props.lockedEndpointLabel,
            )}
          >
            <span class="lock" aria-hidden="true">🔒</span>
            <span class={"rt-dot " + endpointVendor()} aria-hidden="true" />
            <span class={"chip-val " + endpointVendor()}>
              {props.lockedEndpointRuntimeFamilyLabel}
              <Show when={props.lockedEndpointLabel}>
                {(label) => <>{composerControlCopy.dotSeparator}{label()}</>}
              </Show>
            </span>
          </span>
        }
      >
        <button
          type="button"
          id="direct-runtime-endpoint"
          data-profile-popover-trigger="true"
          class="chip chip-endpoint"
          classList={{ "is-empty": props.selectedEndpoint === undefined }}
          disabled={props.pending && props.profile.phase !== "loading"}
          title={endpointControlName()}
          aria-label={endpointControlName()}
          aria-haspopup="dialog"
          aria-expanded={props.openPopover === "endpoint"}
          aria-controls={
            props.openPopover === "endpoint" ? PROFILE_POPOVER_ID : undefined
          }
          onClick={(event) => props.onOpen("endpoint", event.currentTarget)}
        >
          <span class={"rt-dot " + vendor()} aria-hidden="true" />
          <span class={"chip-val " + vendor()}>
            {props.selectedEndpoint?.runtimeFamilyLabel ?? profileChipCopy.chooseEndpoint}
          </span>
        </button>
      </Show>
      <button
        type="button"
        id="direct-model"
        data-profile-popover-trigger="true"
        class="chip"
        classList={{ "is-empty": props.selectedModel === undefined }}
        disabled={
          props.pending ||
          props.profile.phase !== "ready" ||
          props.selectedEndpoint === undefined
        }
        title={modelControlName()}
        aria-label={modelControlName()}
        aria-haspopup="dialog"
        aria-expanded={props.openPopover === "model"}
        aria-controls={
          props.openPopover === "model" ? PROFILE_POPOVER_ID : undefined
        }
        onClick={(event) => props.onOpen("model", event.currentTarget)}
      >
        <span class="chip-key">{composerControlCopy.model}</span>
        <span class={"chip-val " + vendor()}>
          {props.selectedModel?.label ?? composerControlCopy.emDash}
        </span>
      </button>
      <button
        type="button"
        id="direct-work-intensity"
        data-profile-popover-trigger="true"
        class="chip chip-intensity"
        classList={{ "is-empty": props.selectedIntensityLabel === undefined }}
        disabled={
          props.pending ||
          props.profile.phase !== "ready" ||
          props.selectedModel === undefined
        }
        title={intensityControlName()}
        aria-label={intensityControlName()}
        aria-haspopup="dialog"
        aria-expanded={props.openPopover === "intensity"}
        aria-controls={
          props.openPopover === "intensity" ? PROFILE_POPOVER_ID : undefined
        }
        onClick={(event) => props.onOpen("intensity", event.currentTarget)}
      >
        <span class="chip-key">
          <span
            classList={{
              "runtime-catalog-text":
                typeof props.selectedModel?.workIntensityLabel === "string",
            }}
          >
            {props.selectedModel?.workIntensityLabel ?? composerControlCopy.workIntensity}
          </span>{" "}
          <Show when={props.selectedModel?.workIntensityLabel === null}>
            <i
              class="prov"
              aria-label={workbenchFallbackControlLabel}
              title={workbenchFallbackControlLabelTitle}
            >
              ⓦ
            </i>
          </Show>
        </span>
        <span class="chip-val">
          {directWorkIntensityPresentationLabel(
            props.selectedModel,
            props.selectedIntensityLabel,
          ) ?? composerControlCopy.emDash}
        </span>
      </button>
    </>
  );
};

const ProfilePopover: Component<{
  readonly kind: ProfilePopoverKind;
  readonly anchor?: HTMLButtonElement;
  readonly profile: WorkbenchDirectProfileState;
  readonly endpoints: readonly WorkbenchRuntimeEndpointOption[];
  readonly selectedEndpoint: WorkbenchRuntimeEndpointOption | undefined;
  readonly models: readonly WorkbenchModelOption[];
  readonly selectedModel: WorkbenchModelOption | undefined;
  readonly selectedEndpointKey: string | null;
  readonly selectedModelKey: string | null;
  readonly selectedWorkIntensityKey: string | null;
  readonly onEndpoint: (key: string) => void;
  readonly onModel: (key: string) => void;
  readonly onWorkIntensity: (key: string) => void;
  readonly onClose: () => void;
  readonly onLifecycleDismiss?: () => void;
}> = (props) => {
  let popoverElement: HTMLDivElement | undefined;
  let popoverLifecycle: ReturnType<typeof createProfilePopoverLifecycle> | undefined;
  const [placement, setPlacement] =
    createSignal<ProfilePopoverPlacement | null>(null);
  const selectedRovingIndex = (): number => {
    const keys =
      props.kind === "endpoint"
        ? props.endpoints.map((endpoint) => endpoint.key)
        : props.kind === "model"
          ? props.models.map((model) => model.key)
          : [];
    const selectedKey =
      props.kind === "endpoint"
        ? props.selectedEndpointKey
        : props.kind === "model"
          ? props.selectedModelKey
          : null;
    const index = keys.indexOf(selectedKey ?? "");
    return index < 0 ? 0 : index;
  };
  const [activeOptionIndex, setActiveOptionIndex] = createSignal(
    selectedRovingIndex(),
  );
  let rovingSignature = "";
  const rovingOptionElements: HTMLButtonElement[] = [];
  const contentRevision = (): string => {
    const selectedKey =
      props.kind === "endpoint"
        ? props.selectedEndpointKey
        : props.kind === "model"
          ? props.selectedModelKey
          : null;
    const content =
      props.kind === "endpoint"
        ? directEndpointStatusRows(props.profile).map((row) => [
            row.endpointId,
            row.category,
            row.runtimeFamilyLabel,
            row.endpointLabel,
            row.statusLabel,
            row.endpoint?.key ?? null,
          ])
        : props.kind === "model"
          ? props.models.map((model) => [model.key, model.label])
          : [
              props.selectedModel?.key ?? null,
              props.selectedModel?.workIntensityLabel ?? null,
              ...(props.selectedModel?.workIntensities.map((option) => [
                option.key,
                option.label,
              ]) ?? []),
            ];
    return JSON.stringify([
      props.kind,
      props.profile.phase,
      selectedKey,
      content,
    ]);
  };

  createEffect(() => {
    const signature = `${props.kind}:${
      props.kind === "endpoint"
        ? props.selectedEndpointKey
        : props.kind === "model"
          ? props.selectedModelKey
          : "fixed"
    }`;
    if (signature === rovingSignature) return;
    rovingSignature = signature;
    setActiveOptionIndex(selectedRovingIndex());
  });
  createEffect(() => {
    const anchor = props.anchor;
    const element = popoverElement;
    const onDismiss = props.onLifecycleDismiss;
    if (anchor === undefined || element === undefined || onDismiss === undefined) {
      return;
    }
    setPlacement(null);
    const ownerDocument = anchor.ownerDocument;
    const lifecycle = createProfilePopoverLifecycle({
      anchor: createBrowserProfilePopoverElement(anchor, "anchor"),
      popover: createBrowserProfilePopoverElement(element, "popover"),
      environment: createBrowserProfilePopoverEnvironment(ownerDocument),
      onBeforeMeasure: () => element.style.removeProperty("width"),
      focusContent: () => {
        const initial = element.querySelector<HTMLElement>(
          '[data-profile-option][tabindex="0"]:not([disabled]), .islider-range:not([disabled])',
        );
        (initial ?? element).focus({ preventScroll: true });
      },
      isProfilePopoverTrigger: (target) => {
        const candidate = target as { closest?: (selector: string) => unknown };
        return (
          typeof candidate?.closest === "function" &&
          candidate.closest('[data-profile-popover-trigger="true"]') !== null
        );
      },
      onPlacement: (nextPlacement) => {
        setPlacement(nextPlacement);
        element.style.width = `${nextPlacement.width}px`;
      },
      onDismiss: () => onDismiss(),
    });
    popoverLifecycle = lifecycle;
    lifecycle.updateContentRevision(untrack(contentRevision));
    onCleanup(() => {
      if (popoverLifecycle === lifecycle) popoverLifecycle = undefined;
      lifecycle.dispose();
    });
  });
  createEffect(() => {
    const revision = contentRevision();
    popoverLifecycle?.updateContentRevision(revision);
  });

  const moveOptionFocus = (
    event: KeyboardEvent,
    currentIndex: number,
    optionCount: number,
  ): void => {
    const nextIndex = nextProfileOptionIndex(
      currentIndex,
      optionCount,
      event.key,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveOptionIndex(nextIndex);
    rovingOptionElements[nextIndex]?.focus({ preventScroll: true });
  };
  const style = (): JSX.CSSProperties => ({
    left: placement() === null ? undefined : `${placement()?.left}px`,
    top: placement() === null ? undefined : `${placement()?.top}px`,
    "max-height":
      placement() === null ? undefined : `${placement()?.maxHeight}px`,
    visibility:
      props.anchor !== undefined && placement() === null ? "hidden" : "visible",
  });

  return (
    <div
      ref={(element) => {
        popoverElement = element;
      }}
      id={PROFILE_POPOVER_ID}
      class={"popover picker single-col profile-popover popover-" + props.kind}
      role="dialog"
      aria-modal="false"
      aria-labelledby={PROFILE_POPOVER_HEADING_ID}
      tabIndex={-1}
      style={style()}
    >
      <Show
            when={
              props.profile.phase === "ready" || props.kind === "endpoint"
            }
            fallback={
              <div class="picker-col">
                <div
                  id={PROFILE_POPOVER_HEADING_ID}
                  class="picker-col-head"
                >
                  {pickerCopy.endpointHeading}
                </div>
                <Show
                  when={props.profile.phase === "loading"}
                  fallback={
                    <div class="picker-empty">
                      <span>
                        {props.profile.phase === "idle"
                          ? pickerCopy.catalogsNotRead
                          : presentationText(props.profile.feedback)}
                      </span>
                    </div>
                  }
                >
                  <div
                    class="picker-empty profile-loading"
                    role="status"
                    aria-live="polite"
                    aria-busy="true"
                  >
                    <span class="working">
                      <span class="spin" aria-hidden="true" /> {pickerCopy.readingCatalogs}
                    </span>
                    <span>{pickerCopy.boundaryNote}</span>
                  </div>
                </Show>
              </div>
            }
          >
            <Show
              when={props.kind === "endpoint"}
              fallback={
                <Show
                  when={props.kind === "model"}
                  fallback={
                    <IntensityPopover
                      headingId={PROFILE_POPOVER_HEADING_ID}
                      model={props.selectedModel}
                      selectedKey={props.selectedWorkIntensityKey}
                      onSelect={props.onWorkIntensity}
                    />
                  }
                >
                  <div class="picker-col">
                    <div
                      id={PROFILE_POPOVER_HEADING_ID}
                      class="picker-col-head"
                    >
                      {pickerCopy.modelHeading} <span class="n">{props.models.length}</span>
                    </div>
                    <div
                      class="picker-list"
                      role="listbox"
                      aria-label={pickerCopy.modelOptionsLabel}
                    >
                      <For each={props.models}>
                        {(model, index) => (
                          <button
                            ref={(element) => {
                              rovingOptionElements[index()] = element;
                            }}
                            type="button"
                            class="opt"
                            role="option"
                            aria-selected={model.key === props.selectedModelKey}
                            tabIndex={
                              index() === activeOptionIndex() ? 0 : -1
                            }
                            data-profile-option="true"
                            onFocusIn={() => setActiveOptionIndex(index())}
                            onKeyDown={(event) =>
                              moveOptionFocus(
                                event,
                                index(),
                                props.models.length,
                              )
                            }
                            onClick={() => props.onModel(model.key)}
                          >
                            <span class="tick" aria-hidden="true" />
                            <span class="opt-main">
                              <span
                                class={
                                  "opt-label " +
                                  runtimeClass(
                                    props.selectedEndpoint
                                      ?.runtimeFamilyLabel ?? "",
                                  )
                                }
                              >
                                {model.label}
                              </span>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                    <p class="picker-note">
                      {pickerCopy.modelCatalogNote}
                    </p>
                  </div>
                </Show>
              }
            >
              <Show
                when={props.profile.phase !== "loading"}
                fallback={
                  <div class="picker-col">
                    <div
                      id={PROFILE_POPOVER_HEADING_ID}
                      class="picker-col-head"
                    >
                      {pickerCopy.endpointHeading}
                    </div>
                    <div
                      class="picker-empty profile-loading"
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <span class="working">
                        <span class="spin" aria-hidden="true" /> {pickerCopy.readingCatalogs}
                      </span>
                      <span>{pickerCopy.boundaryNote}</span>
                    </div>
                  </div>
                }
              >
                <div class="picker-col">
                  <div
                    id={PROFILE_POPOVER_HEADING_ID}
                    class="picker-col-head"
                  >
                    {pickerCopy.endpointHeading} <span class="n">{props.endpoints.length}</span>
                  </div>
                  <div
                    class="picker-list"
                    role="listbox"
                    aria-label={pickerCopy.endpointOptionsLabel}
                  >
                    <For each={directEndpointStatusRows(props.profile)}>
                    {(row) => {
                      const selectableIndex = () =>
                        props.endpoints.findIndex(
                          (endpoint) => endpoint.endpointId === row.endpointId,
                        );
                      return (
                        <Show
                          when={row.endpoint}
                          fallback={
                            <div
                              class="opt opt-endpoint endpoint-status-option is-disabled"
                              role="option"
                              aria-disabled="true"
                              aria-selected="false"
                            >
                              <span class="tick" aria-hidden="true" />
                              <span class="opt-main">
                                <span
                                  class={
                                    "opt-label " +
                                    runtimeClass(row.runtimeFamilyLabel)
                                  }
                                >
                                  <span
                                    class={
                                      "rt-dot " +
                                      runtimeClass(row.runtimeFamilyLabel)
                                    }
                                    aria-hidden="true"
                                  />{" "}
                                  {row.runtimeFamilyLabel}
                                </span>
                                <span class="opt-sub">
                                  {row.endpointLabel}
                                </span>
                                <span class="endpoint-status-label">
                                  · {row.statusLabel}
                                </span>
                              </span>
                            </div>
                          }
                        >
                          {(endpoint) => (
                            <button
                              ref={(element) => {
                                rovingOptionElements[selectableIndex()] = element;
                              }}
                              type="button"
                              class="opt opt-endpoint endpoint-status-option"
                              role="option"
                              aria-selected={
                                endpoint().key === props.selectedEndpointKey
                              }
                              tabIndex={
                                selectableIndex() === activeOptionIndex() ? 0 : -1
                              }
                              data-profile-option="true"
                              onFocusIn={() =>
                                setActiveOptionIndex(selectableIndex())
                              }
                              onKeyDown={(event) =>
                                moveOptionFocus(
                                  event,
                                  selectableIndex(),
                                  props.endpoints.length,
                                )
                              }
                              onClick={() => props.onEndpoint(endpoint().key)}
                            >
                              <span class="tick" aria-hidden="true" />
                              <span class="opt-main">
                                <span
                                  class={
                                    "opt-label " +
                                    runtimeClass(row.runtimeFamilyLabel)
                                  }
                                >
                                  <span
                                    class={
                                      "rt-dot " +
                                      runtimeClass(row.runtimeFamilyLabel)
                                    }
                                    aria-hidden="true"
                                  />{" "}
                                  {row.runtimeFamilyLabel}
                                </span>
                                <span class="opt-sub">
                                  {row.endpointLabel}
                                </span>
                                <span class="endpoint-status-label">
                                  · {row.statusLabel}
                                </span>
                              </span>
                            </button>
                          )}
                        </Show>
                      );
                    }}
                    </For>
                  </div>
                  <p class="picker-note">
                    {pickerCopy.selectableNote}
                  </p>
                </div>
              </Show>
            </Show>
      </Show>
    </div>
  );
};

const IntensityPopover: Component<{
  readonly headingId: string;
  readonly model: WorkbenchModelOption | undefined;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
}> = (props) => {
  const options = () => props.model?.workIntensities ?? [];
  const selectedIndex = () => {
    const index = options().findIndex((option) => option.key === props.selectedKey);
    return index < 0 ? 0 : index;
  };
  const selected = () => options()[selectedIndex()];
  const selectedPresentationLabel = () =>
    directWorkIntensityPresentationLabel(props.model, selected()?.label);
  const selectIntensityInput = (input: HTMLInputElement): void => {
    const option = options()[input.valueAsNumber];
    if (option !== undefined && option.key !== props.selectedKey) {
      props.onSelect(option.key);
    }
  };
  const stopFraction = (index: number): number =>
    options().length <= 1 ? 0 : index / (options().length - 1);
  const stopPosition = (index: number): string =>
    `calc(5px + (100% - 10px) * ${stopFraction(index)})`;
  const fillWidth = (): string =>
    `calc((100% - 10px) * ${stopFraction(selectedIndex())})`;
  return (
    <div class="picker-col">
      <div id={props.headingId} class="picker-col-head">
        <span
          classList={{
            "runtime-catalog-text":
              typeof props.model?.workIntensityLabel === "string",
          }}
        >
          {props.model?.workIntensityLabel ?? composerControlCopy.workIntensity}
        </span>{" "}
        <Show when={props.model?.workIntensityLabel === null}>
          <i
            class="prov"
            aria-label={workbenchFallbackControlLabel}
            title={workbenchFallbackControlLabelTitle}
          >
            ⓦ
          </i>
        </Show>
        <span class="n">{options().length}</span>
      </div>
      <Show
        when={options().length > 1}
        fallback={
          <div
            class="picker-list"
            role="listbox"
            aria-label={pickerCopy.workIntensityOptionsLabel}
          >
            <div
              class="fixed-row"
              role="option"
              aria-selected="true"
              tabIndex={0}
              data-profile-option="true"
              onKeyDown={(event) => {
                if (nextProfileOptionIndex(0, 1, event.key) !== null) {
                  event.preventDefault();
                  event.currentTarget.focus({ preventScroll: true });
                }
              }}
            >
              <span class="lock" aria-hidden="true">
                🔒
              </span>
              <span>{selectedPresentationLabel() ?? pickerCopy.defaultRow}</span>
            </div>
          </div>
        }
      >
        <div class="islider">
          <div class="islider-top">
            <span class="islider-current">{selectedPresentationLabel()}</span>
            <span class="pos">
              {selectedIndex() + 1}/{options().length}
            </span>
          </div>
          <div class="islider-control">
            <div class="islider-track" aria-hidden="true">
              <span class="islider-rail" />
              <span class="islider-fill" style={{ width: fillWidth() }} />
              <For each={options()}>
                {(_option, index) => (
                  <span
                    class="islider-stop"
                    classList={{ passed: index() <= selectedIndex() }}
                    style={{ left: stopPosition(index()) }}
                  />
                )}
              </For>
              <span
                class="islider-thumb"
                style={{ left: stopPosition(selectedIndex()) }}
              />
            </div>
            <input
              class="islider-range"
              data-profile-option="true"
              type="range"
              min="0"
              max={Math.max(0, options().length - 1)}
              step="1"
              value={selectedIndex()}
              aria-label={composerControlCopy.workIntensity}
              aria-valuetext={
                selectedPresentationLabel() ?? pickerCopy.noIntensitySelected
              }
              onInput={(event) => selectIntensityInput(event.currentTarget)}
              onClick={(event) => selectIntensityInput(event.currentTarget)}
            />
          </div>
          <div class="islider-ticks" aria-hidden="true">
            <For each={options()}>
              {(option, index) => (
                <span
                  classList={{ on: index() === selectedIndex() }}
                  style={{ left: stopPosition(index()) }}
                >
                  {option.label}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show
        when={options().length === 1}
        fallback={
          <p class="picker-note">
            <Show
              when={props.model?.workIntensityLabel === null}
              fallback={<>{pickerCopy.optionsRetainWording}</>}
            >
              <b>{pickerCopy.fallbackHeadingBold}</b>{pickerCopy.fallbackHeadingRest}
            </Show>
          </p>
        }
      >
        <p class="picker-note">
          {pickerCopy.noLevelsNote}
        </p>
      </Show>
    </div>
  );
};

const FixedModeChip: Component<{
  readonly label: string;
  readonly value: string;
}> = (props) => (
  <span class="chip locked">
    <span class="lock" aria-hidden="true">
      🔒
    </span>
    <span class="chip-key">{props.label}</span>
    <span class="chip-val">{props.value}</span>
  </span>
);

const ContextUsage: Component<{
  readonly context: WorkbenchSessionContextUsage | undefined;
  readonly endpointAvailable: boolean;
}> = (props) => {
  const ring = () =>
    contextRingPresentation(props.context, props.endpointAvailable);
  const usedLabel = () => contextUsedTokensLabel(props.context);
  return (
    <Show
      when={ring()}
      fallback={
        <Show
          when={
            props.endpointAvailable &&
            props.context?.windowTokens === null &&
            usedLabel()
          }
        >
          {(label) => <span class="ctx-used">{label()}</span>}
        </Show>
      }
    >
      {(presentation) => (
        <span
          class="ctx-ring"
          style={{ "--ctx-used": String(presentation().usedPercent) }}
          data-state={presentation().state}
          title={presentation().title}
          aria-label={presentation().ariaLabel}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle class="ctx-track" />
            <circle class="ctx-arc" />
          </svg>
          <span class="ctx-pct">{presentation().remainingPercent}%</span>
        </span>
      )}
    </Show>
  );
};

function profileSummary(command: WorkbenchCommandView): string {
  const requested = recordedRequestedProfile(command);
  return requested === undefined
    ? profileNotRecordedSummaryCopy(command.runtime)
    : recordedProfileSummaryCopy(requested);
}

function interruptControlReason(control: WorkbenchInterruptControl): string {
  switch (control.status) {
    case "available":
      return interruptCopy.interruptThisTurn;
    case "pending":
      return dynamicCopy.interrupt.pending;
    case "unsupported":
      return dynamicCopy.interrupt.unsupported;
    case "requested":
      return dynamicCopy.interrupt.requestedWaiting;
    case "unavailable":
      return dynamicCopy.interrupt.unavailable;
  }
}

function steerControlReason(control: WorkbenchSteerControl): string {
  switch (control.status) {
    case "available":
      return steerCopy.availableTitle;
    case "pending":
      return dynamicCopy.steer.pending;
    case "unsupported":
      return dynamicCopy.steer.unsupported;
    case "submitting":
      return dynamicCopy.steer.submitting;
    case "unavailable":
      return dynamicCopy.steer.unavailable;
  }
}

function profilePopoverLabel(kind: ProfilePopoverKind): string {
  return profilePopoverTitleCopy(kind);
}
