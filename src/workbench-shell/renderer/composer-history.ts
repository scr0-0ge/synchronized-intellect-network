export const WORKBENCH_COMPOSER_HISTORY_LIMIT = 100;

export type WorkbenchComposerHistoryDirection = "older" | "newer";

export interface WorkbenchComposerHistoryKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
}

export interface WorkbenchComposerHistoryNavigationRequest {
  readonly direction: WorkbenchComposerHistoryDirection;
  readonly draft: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

export type WorkbenchComposerHistoryNavigator = (
  request: WorkbenchComposerHistoryNavigationRequest,
) => string | null;

interface WorkbenchComposerHistoryScope {
  readonly scopeKey: string;
  readonly entries: readonly string[];
}

interface WorkbenchComposerHistoryNavigation {
  readonly scopeKey: string;
  readonly index: number;
}

interface WorkbenchComposerHistoryWorkingCopy {
  readonly index: number;
  readonly draft: string;
}

/**
 * The per-session working copies a shell keeps for an in-progress recall, as bash,
 * zsh and fish all do: text typed into a recalled entry belongs to that entry until
 * the line is accepted, and text typed before any recall belongs to the composer.
 * It outlives `navigation` because ArrowDown past the newest entry ends navigation
 * without ending the edit; `recordAcceptedComposerInput` is what discards it.
 */
interface WorkbenchComposerHistoryWorkingSet {
  readonly scopeKey: string;
  readonly draftBeforeRecall: string;
  readonly copies: readonly WorkbenchComposerHistoryWorkingCopy[];
}

export interface WorkbenchComposerHistoryState {
  readonly scopes: readonly WorkbenchComposerHistoryScope[];
  readonly navigation: WorkbenchComposerHistoryNavigation | null;
  readonly workingSet: WorkbenchComposerHistoryWorkingSet | null;
}

export interface WorkbenchComposerHistoryNavigationResult {
  readonly state: WorkbenchComposerHistoryState;
  readonly handled: boolean;
  readonly draft: string;
}

export const initialWorkbenchComposerHistoryState: WorkbenchComposerHistoryState =
  Object.freeze({
    scopes: Object.freeze([]),
    navigation: null,
    workingSet: null,
  });

export function composerHistoryDirection(
  event: WorkbenchComposerHistoryKeyEvent,
): WorkbenchComposerHistoryDirection | null {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    event.isComposing
  ) {
    return null;
  }
  if (event.key === "ArrowUp") return "older";
  if (event.key === "ArrowDown") return "newer";
  return null;
}

export function recordAcceptedComposerInput(
  state: WorkbenchComposerHistoryState,
  scopeKey: string | null,
  input: string,
): WorkbenchComposerHistoryState {
  if (scopeKey === null || scopeKey.length === 0 || input.length === 0) return state;
  const existingIndex = state.scopes.findIndex(
    (scope) => scope.scopeKey === scopeKey,
  );
  const existing = existingIndex < 0 ? undefined : state.scopes[existingIndex];
  const entries = Object.freeze(
    [...(existing?.entries ?? []), input].slice(-WORKBENCH_COMPOSER_HISTORY_LIMIT),
  );
  const scope = Object.freeze({ scopeKey, entries });
  const scopes = existingIndex < 0
    ? Object.freeze([...state.scopes, scope])
    : Object.freeze(
        state.scopes.map((candidate, index) =>
          index === existingIndex ? scope : candidate,
        ),
      );
  return Object.freeze({ scopes, navigation: null, workingSet: null });
}

export function navigateComposerHistory(
  state: WorkbenchComposerHistoryState,
  scopeKey: string | null,
  request: WorkbenchComposerHistoryNavigationRequest,
): WorkbenchComposerHistoryNavigationResult {
  const unhandled = (): WorkbenchComposerHistoryNavigationResult =>
    Object.freeze({ state, handled: false, draft: request.draft });
  if (scopeKey === null || !hasCollapsedValidSelection(request)) return unhandled();

  const scope = state.scopes.find((candidate) => candidate.scopeKey === scopeKey);
  if (scope === undefined || scope.entries.length === 0) return unhandled();
  const position = request.selectionStart!;
  const navigation = state.navigation?.scopeKey === scopeKey
    ? state.navigation
    : null;
  const workingSet = state.workingSet?.scopeKey === scopeKey
    ? state.workingSet
    : null;

  if (request.direction === "older") {
    if (!caretIsOnFirstLogicalLine(request.draft, position)) return unhandled();
    const nextWorkingSet = stashWorkingCopy(
      workingSet,
      scopeKey,
      navigation,
      request.draft,
    );
    const index = navigation === null
      ? scope.entries.length - 1
      : Math.max(0, navigation.index - 1);
    return Object.freeze({
      state: Object.freeze({
        scopes: state.scopes,
        navigation: Object.freeze({ scopeKey, index }),
        workingSet: nextWorkingSet,
      }),
      handled: true,
      draft: workingCopyAt(nextWorkingSet, index) ?? scope.entries[index]!,
    });
  }

  if (
    navigation === null ||
    !caretIsOnLastLogicalLine(request.draft, position)
  ) {
    return unhandled();
  }
  const nextWorkingSet = stashWorkingCopy(
    workingSet,
    scopeKey,
    navigation,
    request.draft,
  );
  if (navigation.index < scope.entries.length - 1) {
    const index = navigation.index + 1;
    return Object.freeze({
      state: Object.freeze({
        scopes: state.scopes,
        navigation: Object.freeze({ scopeKey, index }),
        workingSet: nextWorkingSet,
      }),
      handled: true,
      draft: workingCopyAt(nextWorkingSet, index) ?? scope.entries[index]!,
    });
  }
  return Object.freeze({
    state: Object.freeze({
      scopes: state.scopes,
      navigation: null,
      workingSet: nextWorkingSet,
    }),
    handled: true,
    draft: nextWorkingSet.draftBeforeRecall,
  });
}

const NO_WORKING_COPIES: readonly WorkbenchComposerHistoryWorkingCopy[] =
  Object.freeze([]);

/**
 * Records the draft on screen against wherever the caret currently stands, which is
 * the recalled entry the user may have just edited, or — when no recall is in flight
 * — the composer line they started from.
 */
function stashWorkingCopy(
  workingSet: WorkbenchComposerHistoryWorkingSet | null,
  scopeKey: string,
  navigation: WorkbenchComposerHistoryNavigation | null,
  draft: string,
): WorkbenchComposerHistoryWorkingSet {
  const copies = workingSet?.copies ?? NO_WORKING_COPIES;
  if (navigation === null) {
    return Object.freeze({ scopeKey, draftBeforeRecall: draft, copies });
  }
  const replacement = Object.freeze({ index: navigation.index, draft });
  const existing = copies.findIndex(
    (candidate) => candidate.index === navigation.index,
  );
  return Object.freeze({
    scopeKey,
    draftBeforeRecall: workingSet?.draftBeforeRecall ?? draft,
    copies: Object.freeze(
      existing < 0
        ? [...copies, replacement]
        : copies.map((candidate, position) =>
            position === existing ? replacement : candidate,
          ),
    ),
  });
}

function workingCopyAt(
  workingSet: WorkbenchComposerHistoryWorkingSet,
  index: number,
): string | null {
  const copy = workingSet.copies.find((candidate) => candidate.index === index);
  return copy === undefined ? null : copy.draft;
}

function hasCollapsedValidSelection(
  request: WorkbenchComposerHistoryNavigationRequest,
): boolean {
  return (
    Number.isSafeInteger(request.selectionStart) &&
    Number.isSafeInteger(request.selectionEnd) &&
    request.selectionStart === request.selectionEnd &&
    request.selectionStart! >= 0 &&
    request.selectionStart! <= request.draft.length
  );
}

function caretIsOnFirstLogicalLine(draft: string, position: number): boolean {
  return !draft.slice(0, position).includes("\n");
}

function caretIsOnLastLogicalLine(draft: string, position: number): boolean {
  return !draft.slice(position).includes("\n");
}
