import type { SessionMetadataOperation } from "../../session-metadata.ts";
import type {
  WorkbenchCommandView,
  WorkbenchSessionMetadataMutationRequest,
  WorkbenchSessionMetadataMutationResult,
} from "../contract.ts";
import type { WorkbenchRemovalFeedback } from "./removal-presentation.ts";
import { removalCopy } from "./copy/removal-copy.ts";
import {
  sessionMetadataCopy,
  archiveAccessibleNameCopy,
  restoreAccessibleNameCopy,
  blockedByTurnActivityCopy,
} from "./copy/session-metadata-copy.ts";
import { workbenchLocalizedText } from "./presentation-text.ts";

export interface SessionArchiveControlPresentation {
  readonly accessibleName: string;
  readonly disabled: boolean;
  readonly label: typeof sessionMetadataCopy.archiveLabel | typeof sessionMetadataCopy.restoreLabel;
  readonly operation: Readonly<{ readonly kind: "archive" | "restore" }>;
  readonly title: string;
}

export interface SessionRenameFocusTarget {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
}

export type SessionRenameFocusReturnReason = "save" | "cancel" | "escape";

export interface SessionRenameRowEvent {
  readonly currentTarget: EventTarget | null;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

export interface SessionRenameRowKeyboardEvent extends SessionRenameRowEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function sessionMetadataRequest(
  command: WorkbenchCommandView,
  operation: SessionMetadataOperation,
): WorkbenchSessionMetadataMutationRequest | null {
  if (command.session === undefined) return null;
  return Object.freeze({
    metadataKey: command.session.metadataKey,
    operation:
      operation.kind === "rename"
        ? Object.freeze({
            kind: "rename" as const,
            displayName: operation.displayName,
          })
        : Object.freeze({ kind: operation.kind }),
  });
}

/**
 * The renderer-side mirror of the durable terminal-only archive matrix. The
 * coordinator remains authoritative, while this presentation fails closed so
 * the visible control never invites an operation the durable layer must reject.
 */
export function sessionArchiveControlPresentation(
  command: WorkbenchCommandView,
  actionsDisabled: boolean,
): SessionArchiveControlPresentation {
  const archived: unknown = command.session?.archived;
  const status: unknown = command.status;
  if (archived === true) {
    if (status !== "completed" && status !== "failed") {
      return archiveControl(
        restoreAccessibleNameCopy(command.label),
        true,
        sessionMetadataCopy.restoreLabel,
        "restore",
        sessionMetadataCopy.restoreUnavailableTitle,
      );
    }
    return archiveControl(
      restoreAccessibleNameCopy(command.label),
      actionsDisabled,
      sessionMetadataCopy.restoreLabel,
      "restore",
      sessionMetadataCopy.restoreTitle,
    );
  }
  if (archived !== false) {
    return unavailableArchiveControl(
      command.label,
      sessionMetadataCopy.archiveUnavailableTitle,
    );
  }

  if (status === "completed" || status === "failed") {
    return archiveControl(
      archiveAccessibleNameCopy(command.label),
      actionsDisabled,
      sessionMetadataCopy.archiveLabel,
      "archive",
      sessionMetadataCopy.archiveTitle,
    );
  }
  if (status === "accepted") {
    return unavailableArchiveControl(
      command.label,
      sessionMetadataCopy.startingArchiveTitle,
    );
  }
  if (status === "in-flight") {
    return unavailableArchiveControl(
      command.label,
      sessionMetadataCopy.runningArchiveTitle,
    );
  }
  if (status === "recovery-required") {
    // Terminal, not transient: this Session's last turn outcome was never
    // established and never will be, so the tooltip must not imply that
    // waiting makes archive available. Delete is the exit and it says so.
    return unavailableArchiveControl(
      command.label,
      sessionMetadataCopy.recoveryArchiveTitle,
    );
  }
  return unavailableArchiveControl(
    command.label,
    sessionMetadataCopy.archiveUnavailableTitle,
  );
}

export function focusSessionRenameInput(
  input: SessionRenameFocusTarget | undefined,
): boolean {
  return focusConnectedTarget(input);
}

export function beginSessionRenameFromRowDoubleClick(
  event: SessionRenameRowEvent,
  beginRename: () => void,
): boolean {
  if (!isSessionRowInteractionTarget(event.target, event.currentTarget)) {
    return false;
  }
  event.preventDefault();
  beginRename();
  return true;
}

export function beginSessionRenameFromRowKeyboard(
  event: SessionRenameRowKeyboardEvent,
  beginRename: () => void,
): boolean {
  if (
    event.key !== "F2" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !isSessionRowInteractionTarget(event.target, event.currentTarget)
  ) {
    return false;
  }
  event.preventDefault();
  beginRename();
  return true;
}

export function returnSessionRenameFocus(
  invokingTrigger: SessionRenameFocusTarget | undefined,
  currentTrigger: () => SessionRenameFocusTarget | undefined,
  _reason: SessionRenameFocusReturnReason,
): boolean {
  return focusConnectedTarget(
    invokingTrigger?.isConnected === true
      ? invokingTrigger
      : currentTrigger(),
  );
}

export function sessionMetadataFeedback(
  operation: SessionMetadataOperation,
  result: WorkbenchSessionMetadataMutationResult,
): WorkbenchRemovalFeedback {
  if (result.status === "renamed") {
    return feedback(
      "status",
      "session-metadata.renamed",
      () => sessionMetadataCopy.renamedFeedback,
    );
  }
  if (result.status === "archived") {
    return feedback(
      "status",
      "session-metadata.archived",
      () => sessionMetadataCopy.archivedFeedback,
    );
  }
  if (result.status === "restored") {
    return feedback(
      "status",
      "session-metadata.restored",
      () => sessionMetadataCopy.restoredFeedback,
    );
  }
  if (result.status === "unchanged") {
    return feedback(
      "status",
      `session-metadata.already-${operation.kind}`,
      () => operation.kind === "rename"
        ? sessionMetadataCopy.alreadyRenamedFeedback
        : operation.kind === "archive"
          ? sessionMetadataCopy.alreadyArchivedFeedback
          : sessionMetadataCopy.alreadyActiveFeedback,
    );
  }
  if (result.status === "blocked") {
    if (result.activity === "unknown") {
      return feedback(
        "alert",
        "session-metadata.block-unknown",
        () => sessionMetadataCopy.blockUnknownFeedback,
      );
    }
    return feedback(
      "alert",
      `session-metadata.blocked-${result.activity}`,
      () => blockedByTurnActivityCopy(
        result.activity === "accepted"
          ? removalCopy.turnStartingWord
          : removalCopy.turnRunningWord,
      ),
    );
  }
  if (result.status === "invalid-name") {
    return feedback(
      "alert",
      "session-metadata.invalid-name",
      () => sessionMetadataCopy.invalidNameFeedback,
    );
  }
  if (result.status === "not-found") {
    return feedback(
      "alert",
      "session-metadata.not-found",
      () => sessionMetadataCopy.notFoundFeedback,
    );
  }
  return feedback(
    "alert",
    `session-metadata.${operation.kind}-failed`,
    () => operation.kind === "rename"
      ? sessionMetadataCopy.renameFailedFeedback
      : operation.kind === "archive"
        ? sessionMetadataCopy.archiveFailedFeedback
        : sessionMetadataCopy.restoreFailedFeedback,
  );
}

function feedback(
  tone: WorkbenchRemovalFeedback["tone"],
  key: string,
  resolve: () => string,
): WorkbenchRemovalFeedback {
  return Object.freeze({
    tone,
    message: workbenchLocalizedText(key, resolve),
  });
}

function unavailableArchiveControl(
  label: string,
  title: string,
): SessionArchiveControlPresentation {
  return archiveControl(
    archiveAccessibleNameCopy(label),
    true,
    sessionMetadataCopy.archiveLabel,
    "archive",
    title,
  );
}

function archiveControl(
  accessibleName: string,
  disabled: boolean,
  label: SessionArchiveControlPresentation["label"],
  operation: SessionArchiveControlPresentation["operation"]["kind"],
  title: string,
): SessionArchiveControlPresentation {
  return Object.freeze({
    accessibleName,
    disabled,
    label,
    operation: Object.freeze({ kind: operation }),
    title,
  });
}

function focusConnectedTarget(
  target: SessionRenameFocusTarget | undefined,
): boolean {
  if (target?.isConnected !== true) return false;
  target.focus({ preventScroll: true });
  return true;
}

const sessionRowInteractiveSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[role=\"button\"]",
  "[role=\"menuitem\"]",
].join(",");

function isSessionRowInteractionTarget(
  target: EventTarget | null,
  row: EventTarget | null,
): boolean {
  if (target === null || row === null) return false;
  if (target === row) return true;
  if (!hasClosest(target)) return false;
  return target.closest(sessionRowInteractiveSelector) === row;
}

function hasClosest(
  target: EventTarget,
): target is EventTarget & {
  closest(selectors: string): EventTarget | null;
} {
  return (
    "closest" in target &&
    typeof (target as { readonly closest?: unknown }).closest === "function"
  );
}
