import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type Component,
} from "solid-js";
import {
  normalizeSessionDisplayName,
  type SessionMetadataOperation,
} from "../../session-metadata.ts";
import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchProjectOption,
  WorkbenchSessionMetadataMutationResult,
} from "../contract.ts";
import { WORKBENCH_SESSION_DISPLAY_NAME_MAX_CODE_POINTS } from "../contract.ts";
import {
  canCreateProject,
  canOpenProject,
  canSelectProject,
  type WorkbenchProjectOpenState,
  type WorkbenchProjectSwitchState,
  type WorkbenchRendererState,
} from "./view-model.ts";
import {
  settingsRailPresentation,
  type WorkbenchSurface,
} from "./settings-view-model.ts";
import { type WorkbenchRemovalFeedback } from "./removal-presentation.ts";
import { presentationText } from "./presentation-text.ts";
import {
  beginSessionRenameFromRowDoubleClick,
  beginSessionRenameFromRowKeyboard,
  focusSessionRenameInput,
  returnSessionRenameFocus,
  sessionArchiveControlPresentation,
} from "./session-metadata-presentation.ts";

import {
  recordedRequestedProfile,
  commandRuntimeFamily,
  runtimeClass,
  commandStatusLabel,
  commandStatusGlyph,
  commandStatusGlyphClass,
} from "./view-types.ts";
import { commonCopy } from "./copy/common-copy.ts";
import {
  railCopy,
  collapseSessionsAriaCopy,
  expandSessionsAriaCopy,
  unselectedProjectAriaCopy,
  activeSessionsCountCopy,
  historiesAriaCopy,
  removeProjectAriaCopy,
  newSessionHereAriaCopy,
  showMoreCopy,
  archivedGroupCopy,
  sessionRenameErrorCopy,
  deleteSessionAriaCopy,
  newNameForCopy,
  sessionRowAriaCopy,
} from "./copy/rail-copy.ts";

interface ProjectRailDisclosureState {
  readonly scopeEpoch: number;
  readonly selectedProjectExpanded: boolean;
  readonly overflowAvailable: boolean;
  readonly overflowExpanded: boolean;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly archivedExpanded: boolean;
}

type ProjectRailDisclosureAction =
  | Readonly<{ type: "toggle-selected-project" }>
  | Readonly<{ type: "toggle-overflow" }>
  | Readonly<{ type: "toggle-archived" }>;

function initialProjectRailDisclosureState(
  scopeEpoch: number,
  activeCount: number,
  archivedCount: number,
): ProjectRailDisclosureState {
  return Object.freeze({
    scopeEpoch,
    selectedProjectExpanded: true,
    overflowAvailable: activeCount > 5,
    overflowExpanded: false,
    activeCount,
    archivedCount,
    archivedExpanded: activeCount === 0 && archivedCount > 0,
  });
}

function reduceProjectRailDisclosure(
  state: ProjectRailDisclosureState,
  action: ProjectRailDisclosureAction,
): ProjectRailDisclosureState {
  switch (action.type) {
    case "toggle-selected-project":
      return Object.freeze({
        ...state,
        selectedProjectExpanded: !state.selectedProjectExpanded,
      });
    case "toggle-overflow":
      return state.overflowAvailable
        ? Object.freeze({
            ...state,
            overflowExpanded: !state.overflowExpanded,
          })
        : state;
    case "toggle-archived":
      return state.archivedCount > 0
        ? Object.freeze({
            ...state,
            archivedExpanded: !state.archivedExpanded,
          })
        : state;
  }
}

function reconcileProjectRailDisclosure(
  state: ProjectRailDisclosureState,
  scopeEpoch: number,
  activeCount: number,
  archivedCount: number,
): ProjectRailDisclosureState {
  if (state.scopeEpoch !== scopeEpoch) {
    return initialProjectRailDisclosureState(
      scopeEpoch,
      activeCount,
      archivedCount,
    );
  }
  const overflowAvailable = activeCount > 5;
  if (
    state.overflowAvailable === overflowAvailable &&
    state.activeCount === activeCount &&
    state.archivedCount === archivedCount
  ) {
    return state;
  }
  return Object.freeze({
    ...state,
    overflowAvailable,
    overflowExpanded:
      state.overflowAvailable === overflowAvailable
        ? state.overflowExpanded
        : false,
    activeCount,
    archivedCount,
    archivedExpanded:
      archivedCount === 0
        ? false
        : activeCount === 0
          ? true
          : state.archivedExpanded,
  });
}

function didAuthoritativeProjectScopeChange(
  previous: WorkbenchRendererState,
  next: WorkbenchRendererState,
): boolean {
  const registeredProjectSwitchCompleted =
    previous.projectSwitch.phase === "pending" &&
    next.projectSwitch.phase === "idle" &&
    (previous.projectSwitch.selectionAccepted ||
      previous.projectSwitch.viewArrived);
  if (registeredProjectSwitchCompleted) return true;

  const projectAcquisitionCompleted =
    previous.projectOpen.phase === "pending" &&
    (next.projectOpen.phase === "opened" ||
      next.projectOpen.phase === "created") &&
    next.projectOpen.selectionAccepted &&
    next.projectOpen.viewArrived;
  if (!projectAcquisitionCompleted) return false;
  if (next.projectOpen.resetRequired) return true;
  if (!next.result?.ok) return false;

  const selectedProject = next.result.view.projectSelection.projects.find(
    (project) => project.selected,
  );
  return selectedProject !== undefined &&
    !next.projectOpen.pendingCurrentSelectionKeys.includes(
      selectedProject.selectionKey,
    );
}

export function nextProjectScopeEpoch(
  epoch: number,
  previous: WorkbenchRendererState,
  next: WorkbenchRendererState,
): number {
  return didAuthoritativeProjectScopeChange(previous, next)
    ? epoch + 1
    : epoch;
}

export const ProjectActionsMenu: Component<{
  readonly variant: "wide" | "compact";
  readonly projectOpen: WorkbenchProjectOpenState;
  readonly canCreateProject: () => boolean;
  readonly onCreateProject: () => void;
  readonly canOpenProject: () => boolean;
  readonly onOpenProject: () => void;
}> = (props) => {
  const [actionsOpen, setActionsOpen] = createSignal(false);
  const dialogId = `project-actions-${props.variant}-${createUniqueId()}`;
  let trigger: HTMLButtonElement | undefined;
  let dialog: HTMLDivElement | undefined;

  const restoreTriggerFocus = (): void => {
    queueMicrotask(() => trigger?.focus({ preventScroll: true }));
  };
  const close = (restoreFocus: boolean): void => {
    setActionsOpen(false);
    if (restoreFocus) restoreTriggerFocus();
  };
  const open = (): void => {
    setActionsOpen(true);
    queueMicrotask(() => {
      dialog
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus({ preventScroll: true });
    });
  };
  const toggle = (): void => {
    if (actionsOpen()) close(true);
    else open();
  };

  /* Every other popover in the product dismisses on an outside press; this one
     did not, so a press anywhere else left it open and the next press was spent
     closing it. Two presses for one action, which is the class the owner named.

     Deliberately no `preventDefault()` here, unlike the profile popovers: the
     press that dismisses this menu should also land where it was aimed, and
     focus is not restored to the trigger because the user is already leaving. */
  createEffect(() => {
    if (!actionsOpen()) return;
    const dismiss = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (dialog?.contains(target) || trigger?.contains(target))) {
        return;
      }
      close(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss, true));
  });

  return (
    <div class={`project-actions-menu project-actions-${props.variant}`}>
      <button
        ref={trigger}
        type="button"
        class="icon-btn project-actions-button"
        aria-label={railCopy.actionsTriggerLabel}
        title={railCopy.actionsTriggerLabel}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-expanded={actionsOpen()}
        onClick={toggle}
      >
        ＋
      </button>
      <Show when={actionsOpen()}>
        <div
          ref={dialog}
          id={dialogId}
          class="popover project-actions-popover"
          role="dialog"
          aria-label={railCopy.actionsDialogTitle}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }}
        >
          <div class="popover-head">
            <span class="popover-title">{railCopy.actionsDialogTitle}</span>
          </div>
          <div class="project-action-list">
            <button
              type="button"
              class="btn create-project-button"
              disabled={!props.canCreateProject()}
              aria-busy={
                props.projectOpen.phase === "pending" &&
                props.projectOpen.operation === "create"
              }
              onClick={() => {
                close(false);
                props.onCreateProject();
              }}
            >
              {props.projectOpen.phase === "pending" &&
              props.projectOpen.operation === "create"
                ? commonCopy.creatingProject
                : commonCopy.createProject}
            </button>
            <button
              type="button"
              class="btn open-project-button"
              disabled={!props.canOpenProject()}
              aria-busy={
                props.projectOpen.phase === "pending" &&
                props.projectOpen.operation === "open"
              }
              onClick={() => {
                close(false);
                props.onOpenProject();
              }}
            >
              {props.projectOpen.phase === "pending" &&
              props.projectOpen.operation === "open"
                ? commonCopy.openingProject
                : commonCopy.openProject}
            </button>
          </div>
          <p class="popover-foot">
            {railCopy.popoverFoot}
          </p>
        </div>
      </Show>
    </div>
  );
};

export const ProjectRail: Component<{
  readonly view: WorkbenchHostedProjectView;
  readonly selectedKey: string | null;
  readonly surface: WorkbenchSurface;
  readonly onSurface: (surface: WorkbenchSurface) => void;
  readonly runtimeUnavailable: boolean;
  readonly historyRecoveryAttention: boolean;
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
  readonly onEnterNewSession: () => void;
  readonly draftBlocked: boolean;
  readonly actionBlocked: boolean;
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
  readonly onRequestProjectHistories?: (
    project: WorkbenchProjectOption,
  ) => void;
}> = (props) => {
  const activeCommands = () =>
    props.view.commands.filter(
      (command) => command.session?.archived !== true,
    );
  const archivedCommands = () =>
    props.view.commands.filter(
      (command) => command.session?.archived === true,
    );
  const [disclosure, setDisclosure] = createSignal(
    initialProjectRailDisclosureState(
      props.projectScopeEpoch,
      activeCommands().length,
      archivedCommands().length,
    ),
  );
  const currentDisclosure = createMemo(() =>
    reconcileProjectRailDisclosure(
      disclosure(),
      props.projectScopeEpoch,
      activeCommands().length,
      archivedCommands().length,
    ),
  );
  createEffect(() => {
    const current = disclosure();
    const reconciled = currentDisclosure();
    if (reconciled !== current) setDisclosure(reconciled);
  });
  const updateDisclosure = (action: ProjectRailDisclosureAction): void => {
    setDisclosure((current) =>
      reduceProjectRailDisclosure(
        reconcileProjectRailDisclosure(
          current,
          props.projectScopeEpoch,
          activeCommands().length,
          archivedCommands().length,
        ),
        action,
      ),
    );
  };
  const visibleCommands = () =>
    currentDisclosure().overflowExpanded
      ? activeCommands()
      : activeCommands().slice(0, 5);
  const selectedProjectAvailable = () =>
    props.view.projectSelection.projects.find((project) => project.selected)
      ?.availability === "available";
  const newSessionAvailable = () =>
    props.view.commands.length > 0 &&
    props.selectedKey !== null &&
    selectedProjectAvailable() &&
    !props.runtimeUnavailable &&
    !props.actionBlocked &&
    props.projectSwitch.phase !== "pending";
  const footPresentation = () =>
    settingsRailPresentation(props.surface, props.runtimeUnavailable);

  return (
    <nav class="rail" aria-label={railCopy.navAria}>
      <div class="rail-head">
        <span class="rail-title">
          {railCopy.projectsTitle}{" "}
          <span class="count-pill">
            {props.view.projectSelection.projects.length}
          </span>
        </span>
        <ProjectActionsMenu
          variant="wide"
          projectOpen={props.projectOpen}
          canCreateProject={props.canCreateProject}
          onCreateProject={props.onCreateProject}
          canOpenProject={props.canOpenProject}
          onOpenProject={props.onOpenProject}
        />
      </div>

      <div class="session-scroll">
        <For each={props.view.projectSelection.projects}>
          {(project, index) => {
            const pending = () =>
              props.projectSwitch.phase === "pending" &&
              props.projectSwitch.targetIndex === index();
            const expanded = () =>
              project.selected
                ? currentDisclosure().selectedProjectExpanded
                : pending();
            const sessionsId = () => `project-sessions-${index() + 1}`;
            const collapsedCopy = () =>
              project.availability === "available"
                ? railCopy.collapsedAvailable
                : railCopy.collapsedUnavailable;
            return (
              <section
                class="proj"
                classList={{ "is-open": project.selected }}
                data-open={expanded() ? "true" : "false"}
              >
                {/* `.proj-head` in styles.css declares four explicit column
                    tracks for the four controls it was drawn with. The
                    histories trigger is a fifth child, and a fifth auto-placed
                    item in a four-track row-flow grid wraps onto an implicit
                    second row, dropping the New Agent Session control below the
                    Project name. Column flow spends the overflow on an implicit
                    column instead, which is identical placement for the
                    four-child case and stays correct if the shared sheet later
                    grows the fifth track. Owned here because styles.css is not
                    this change's to edit. */}
                <div class="proj-head" style={{ "grid-auto-flow": "column" }}>
                  <button
                    type="button"
                    class="proj-toggle registered-project-button"
                    disabled={
                      !project.selected && !props.canSelectProject(index())
                    }
                    aria-expanded={expanded()}
                    aria-controls={sessionsId()}
                    aria-current={project.selected ? "page" : undefined}
                    aria-busy={pending()}
                    aria-label={
                      project.selected
                        ? (expanded() ? collapseSessionsAriaCopy(project.label) : expandSessionsAriaCopy(project.label))
                        : unselectedProjectAriaCopy(
                            project.label,
                            String(index() + 1),
                            project.availability === "available"
                              ? railCopy.closedState
                              : railCopy.unavailableState,
                          )
                    }
                    title={
                      project.selected
                        ? expanded()
                          ? railCopy.collapseThisTitle
                          : railCopy.expandThisTitle
                        : project.availability !== "available"
                          ? railCopy.collapsedUnavailable
                          : props.draftBlocked
                            ? railCopy.clearDraftBeforeSwitch
                            : props.actionBlocked
                              ? railCopy.pendingActionBeforeSwitch
                              : railCopy.openThisProject
                    }
                    onClick={() => {
                      if (project.selected) {
                        updateDisclosure({ type: "toggle-selected-project" });
                      } else {
                        props.onSelectProject(index());
                      }
                    }}
                  >
                    <span class="proj-caret" aria-hidden="true">
                      ▾
                    </span>
                    <Show when={project.selected}>
                      <span
                        class="proj-open-dot"
                        aria-hidden="true"
                        title={railCopy.openDotTitle}
                      />
                    </Show>
                    <span class="proj-name">{project.label}</span>
                  </button>
                  <span
                    class="proj-count"
                    aria-label={
                      project.selected
                        ? activeSessionsCountCopy(String(activeCommands().length))
                        : railCopy.countNotLoaded
                    }
                  >
                    {project.selected ? activeCommands().length : "—"}
                  </span>
                  <Show when={props.onRequestProjectHistories}>
                    {(request) => (
                      <button
                        type="button"
                        class="icon-btn project-histories-trigger"
                        aria-label={historiesAriaCopy(project.label)}
                        title={
                          props.actionBlocked
                            ? railCopy.historiesBlockedTitle
                            : railCopy.historiesTitle
                        }
                        disabled={
                          props.projectHistoriesPending ||
                          props.removalPending ||
                          props.sessionMetadataPending ||
                          props.actionBlocked ||
                          props.projectSwitch.phase === "pending" ||
                          props.projectOpen.phase === "pending" ||
                          props.projectOpen.phase === "recovery-required"
                        }
                        onClick={() => request()(project)}
                      >
                        ⟲
                      </button>
                    )}
                  </Show>
                  <button
                    type="button"
                    class="icon-btn removal-trigger project-removal-trigger"
                    aria-label={removeProjectAriaCopy(project.label)}
                    title={
                      props.draftBlocked
                        ? railCopy.clearDraftBeforeRemoval
                        : props.actionBlocked
                          ? railCopy.pendingActionBeforeRemoval
                          : railCopy.removeFromWorkbench
                    }
                    disabled={
                      props.removalPending ||
                      props.sessionMetadataPending ||
                      props.draftBlocked ||
                      props.actionBlocked ||
                      props.projectSwitch.phase === "pending" ||
                      props.projectOpen.phase === "pending" ||
                      props.projectOpen.phase === "recovery-required"
                    }
                    onClick={() => props.onRequestProjectRemoval(project)}
                  >
                    ×
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label={newSessionHereAriaCopy(project.label)}
                    title={
                      project.selected
                        ? props.runtimeUnavailable
                          ? railCopy.runtimeUnavailableTitle
                          : railCopy.newSessionHere
                        : railCopy.openProjectFirst
                    }
                    disabled={!project.selected || !newSessionAvailable()}
                    onClick={props.onEnterNewSession}
                  >
                    ＋
                  </button>
                </div>

                <Show
                  when={project.selected}
                  fallback={
                    <div
                      id={sessionsId()}
                      class="proj-sessions collapsed-note"
                    >
                      <div class="proj-empty">{collapsedCopy()}</div>
                    </div>
                  }
                >
                  <div id={sessionsId()} class="proj-sessions">
                    <Show
                      when={activeCommands().length > 0}
                      fallback={
                        <div class="rail-empty compact">
                          <span class="glyph" aria-hidden="true">
                            ◇
                          </span>
                          <p>
                            <Show
                              when={props.runtimeUnavailable}
                              fallback={
                                <>
                                  {archivedCommands().length > 0
                                    ? railCopy.noActiveWithArchived
                                    : railCopy.noActiveWithoutArchived}
                                  <br />
                                  {archivedCommands().length > 0
                                    ? railCopy.archivedRemainAvailable
                                    : railCopy.firstMessageStartsOne}
                                </>
                              }
                            >
                              {railCopy.noneCanStart}
                              <br />
                              {railCopy.noneCanStartReason}
                            </Show>
                          </p>
                        </div>
                      }
                    >
                      <For each={visibleCommands()}>
                        {(command) => (
                          <SessionRailRow
                            command={command}
                            selected={command.key === props.selectedKey}
                            disabled={
                              props.projectSwitch.phase === "pending" ||
                              props.projectOpen.phase === "pending" ||
                              props.projectOpen.phase === "recovery-required"
                            }
                            mutationPending={props.sessionMetadataPending}
                            removalPending={props.removalPending}
                            onSelect={() => props.onSelect(command.key)}
                            onMutate={props.onMutateSessionMetadata}
                            onRequestRemoval={props.onRequestSessionRemoval}
                          />
                        )}
                      </For>
                      <Show
                        when={currentDisclosure().overflowAvailable}
                      >
                        <button
                          type="button"
                          class="more-row"
                          aria-expanded={currentDisclosure().overflowExpanded}
                          aria-controls={sessionsId()}
                          onClick={() =>
                            updateDisclosure({ type: "toggle-overflow" })
                          }
                        >
                          {currentDisclosure().overflowExpanded
                            ? railCopy.showFewer
                            : showMoreCopy(activeCommands().length - 5)}
                        </button>
                      </Show>
                    </Show>
                    <Show when={archivedCommands().length > 0}>
                      <div class="archived-session-group">
                        <button
                          type="button"
                          class="archived-disclosure"
                          aria-expanded={currentDisclosure().archivedExpanded}
                          aria-controls={`archived-sessions-${index() + 1}`}
                          onClick={() =>
                            updateDisclosure({ type: "toggle-archived" })
                          }
                        >
                          {archivedGroupCopy(archivedCommands().length)}
                        </button>
                        <Show when={currentDisclosure().archivedExpanded}>
                          <div
                            id={`archived-sessions-${index() + 1}`}
                            class="archived-session-list"
                          >
                            <For each={archivedCommands()}>
                              {(command) => (
                                <SessionRailRow
                                  command={command}
                                  selected={command.key === props.selectedKey}
                                  disabled={
                                    props.projectSwitch.phase === "pending" ||
                                    props.projectOpen.phase === "pending" ||
                                    props.projectOpen.phase ===
                                      "recovery-required"
                                  }
                                  mutationPending={
                                    props.sessionMetadataPending
                                  }
                                  removalPending={props.removalPending}
                                  onSelect={() => props.onSelect(command.key)}
                                  onMutate={props.onMutateSessionMetadata}
                                  onRequestRemoval={
                                    props.onRequestSessionRemoval
                                  }
                                />
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </Show>
              </section>
            );
          }}
        </For>
      </div>

      <Show when={props.projectSwitch.feedback ?? props.projectOpen.feedback}>
        {(feedback) => (
          <p
            class="rail-feedback"
            role={
              props.projectSwitch.phase === "error" ||
              props.projectOpen.phase === "error" ||
              props.projectOpen.phase === "recovery-required"
                ? "alert"
                : "status"
            }
            aria-live="polite"
          >
            {presentationText(feedback())}
          </p>
        )}
      </Show>

      <Show when={props.removalNotice}>
        {(notice) => (
          <p
            class="rail-feedback rail-removal-notice"
            role={notice().tone}
            aria-live="polite"
            tabIndex={-1}
            data-removal-focus-fallback
          >
            {presentationText(notice().message)}
          </p>
        )}
      </Show>

      <div class="rail-foot">
        <button
          type="button"
          class="rail-action new-session-button"
          disabled={!newSessionAvailable()}
          aria-label={footPresentation().newSessionAccessibleLabel}
          onClick={props.onEnterNewSession}
        >
          {footPresentation().newSessionLabel} <kbd>{railCopy.ctrlN}</kbd>
        </button>
        <button
          type="button"
          class={`icon-btn settings-rail-button${
            footPresentation().settingsAttention ||
            props.historyRecoveryAttention
              ? " attention"
              : ""
          }`}
          aria-label={railCopy.settingsLabel}
          title={railCopy.settingsLabel}
          aria-current={footPresentation().settingsCurrent ? "page" : undefined}
          onClick={() => props.onSurface("settings")}
        >
          ⚙
        </button>
      </div>
    </nav>
  );
};

const sessionRenameFocusTargets = new Map<string, HTMLButtonElement>();

const SessionRailRow: Component<{
  readonly command: WorkbenchCommandView;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly mutationPending: boolean;
  readonly removalPending: boolean;
  readonly onSelect: () => void;
  readonly onMutate: (
    command: WorkbenchCommandView,
    operation: SessionMetadataOperation,
  ) => Promise<WorkbenchSessionMetadataMutationResult>;
  readonly onRequestRemoval: (command: WorkbenchCommandView) => void;
}> = (props) => {
  const commandKey = props.command.key;
  const [renaming, setRenaming] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal(props.command.label);
  const [renameError, setRenameError] = createSignal(false);
  let renameTrigger: HTMLButtonElement | undefined;
  let renameInput: HTMLInputElement | undefined;
  const actionsDisabled = () =>
    props.disabled || props.mutationPending || props.removalPending;
  const archivePresentation = () =>
    sessionArchiveControlPresentation(props.command, actionsDisabled());
  const currentRenameTrigger = (): HTMLButtonElement | undefined => {
    if (renameTrigger?.isConnected === true) return renameTrigger;
    const current = sessionRenameFocusTargets.get(commandKey);
    return current?.isConnected === true ? current : undefined;
  };
  onCleanup(() => {
    if (sessionRenameFocusTargets.get(commandKey) === renameTrigger) {
      sessionRenameFocusTargets.delete(commandKey);
    }
  });
  const beginRename = (): void => {
    if (
      props.command.session === undefined ||
      actionsDisabled() ||
      renaming()
    ) {
      return;
    }
    batch(() => {
      setRenameDraft(props.command.label);
      setRenameError(false);
      setRenaming(true);
    });
  };
  const finishRename = (
    reason: "save" | "cancel" | "escape",
  ): void => {
    batch(() => {
      setRenaming(false);
      setRenameError(false);
    });
    returnSessionRenameFocus(renameTrigger, currentRenameTrigger, reason);
  };
  createEffect(() => {
    if (renaming()) focusSessionRenameInput(renameInput);
  });
  const submitRename = (event: SubmitEvent): void => {
    event.preventDefault();
    if (actionsDisabled()) return;
    const displayName = normalizeSessionDisplayName(renameDraft());
    if (displayName === undefined) {
      setRenameError(true);
      return;
    }
    setRenameError(false);
    void props
      .onMutate(props.command, { kind: "rename", displayName })
      .then((result) => {
        if (result.status === "renamed" || result.status === "unchanged") {
          finishRename("save");
        }
      });
  };
  return (
    <div class="session-row-shell">
      <SessionRow
        command={props.command}
        selected={props.selected}
        disabled={props.disabled}
        renameAvailable={props.command.session !== undefined}
        onSelect={props.onSelect}
        onRowRef={(row) => {
          renameTrigger = row;
          sessionRenameFocusTargets.set(commandKey, row);
        }}
        onDoubleClick={(event) =>
          beginSessionRenameFromRowDoubleClick(event, beginRename)
        }
        onKeyDown={(event) =>
          beginSessionRenameFromRowKeyboard(event, beginRename)
        }
      />
      <Show when={props.command.session !== undefined}>
        <div class="session-row-actions">
          <button
            type="button"
            class="session-action session-icon-action session-archive-trigger"
            aria-label={archivePresentation().accessibleName}
            title={archivePresentation().title}
            disabled={archivePresentation().disabled}
            onClick={() =>
              void props.onMutate(
                props.command,
                archivePresentation().operation,
              )
            }
          >
            <Show
              when={archivePresentation().operation.kind === "archive"}
              fallback={
                <svg
                  class="session-action-glyph"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path d="M3.5 5.5h13v11h-13zM2.5 3.5h15v3h-15z" />
                  <path d="M10 13V8m-2 2 2-2 2 2" />
                </svg>
              }
            >
              <svg
                class="session-action-glyph"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path d="M3.5 5.5h13v11h-13zM2.5 3.5h15v3h-15z" />
                <path d="M10 8v5m-2-2 2 2 2-2" />
              </svg>
            </Show>
          </button>
          <button
            type="button"
            class="session-action session-icon-action removal-trigger session-removal-trigger"
            aria-label={deleteSessionAriaCopy(props.command.label)}
            title={railCopy.deleteSessionTitle}
            disabled={actionsDisabled()}
            onClick={() => props.onRequestRemoval(props.command)}
          >
            <svg
              class="session-action-glyph"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <path d="M4.5 5.5h11l-.7 11H5.2zM7 5.5V3h6v2.5M3 5.5h14M8 8v6m4-6v6" />
            </svg>
          </button>
        </div>
      </Show>
      <Show when={renaming()}>
        <form class="session-rename-form" onSubmit={submitRename}>
          <label>
            <span class="sr-only">{newNameForCopy(props.command.label)}</span>
            <input
              ref={renameInput}
              value={renameDraft()}
              aria-label={newNameForCopy(props.command.label)}
              onInput={(event) => setRenameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  finishRename("escape");
                }
              }}
            />
          </label>
          <button
            type="submit"
            class="session-action"
            disabled={actionsDisabled()}
          >
            {railCopy.saveRename}
          </button>
          <button
            type="button"
            class="session-action"
            disabled={props.mutationPending}
            onClick={() => finishRename("cancel")}
          >
            {commonCopy.cancel}
          </button>
          <Show when={renameError()}>
            <span class="session-rename-error" role="alert">
              {sessionRenameErrorCopy(
                WORKBENCH_SESSION_DISPLAY_NAME_MAX_CODE_POINTS,
              )}
            </span>
          </Show>
        </form>
      </Show>
    </div>
  );
};

const SessionRow: Component<{
  readonly command: WorkbenchCommandView;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly renameAvailable: boolean;
  readonly onSelect: () => void;
  readonly onRowRef: (row: HTMLButtonElement) => void;
  readonly onDoubleClick: (
    event: MouseEvent & { currentTarget: HTMLButtonElement },
  ) => void;
  readonly onKeyDown: (
    event: KeyboardEvent & { currentTarget: HTMLButtonElement },
  ) => void;
}> = (props) => {
  const family = () => commandRuntimeFamily(props.command);
  const vendor = () => runtimeClass(family());
  const model = () => commandModelLabel(props.command);
  return (
    <button
      ref={props.onRowRef}
      type="button"
      class="session-row"
      classList={{ "is-archived": props.command.session?.archived === true }}
      aria-keyshortcuts={props.renameAvailable ? "F2" : undefined}
      title={
        props.renameAvailable
          ? railCopy.renameHintTitle
          : undefined
      }
      aria-current={props.selected ? "true" : undefined}
      aria-label={
        sessionRowAriaCopy({
          label: props.command.label,
          family: family(),
          model: model(),
          status: commandStatusLabel(props.command),
          archived: props.command.session?.archived === true,
        })
      }
      disabled={props.disabled}
      onClick={props.onSelect}
      onDblClick={props.renameAvailable ? props.onDoubleClick : undefined}
      onKeyDown={props.renameAvailable ? props.onKeyDown : undefined}
    >
      <span class="sr-top">
        <span class={"rt-dot " + vendor()} aria-hidden="true" />
        <span class="sr-title">{props.command.label}</span>
        <span
          class={"st " + commandStatusGlyphClass(props.command)}
          aria-label={commandStatusLabel(props.command)}
        >
          {commandStatusGlyph(props.command)}
        </span>
      </span>
      <span class="sr-meta">
        <span class={"rt-name " + vendor()}>{family()}</span>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <span class={"sr-model " + vendor()}>{model()}</span>
      </span>
    </button>
  );
};

function commandModelLabel(command: WorkbenchCommandView): string {
  return recordedRequestedProfile(command)?.modelLabel ?? railCopy.modelNotRecorded;
}
