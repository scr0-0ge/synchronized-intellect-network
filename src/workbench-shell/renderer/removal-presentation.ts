import type {
  WorkbenchCommandView,
  WorkbenchProjectOption,
  WorkbenchProjectRemovalResult,
  WorkbenchProjectSelectionRequest,
  WorkbenchSessionRemovalRequest,
  WorkbenchSessionRemovalResult,
} from "../contract.ts";
import {
  removalCopy,
  deleteSessionDescriptionCopy,
  removeProjectDescriptionCopy,
  subjectActivityUnknownCopy,
  blockedWhileTurnActiveCopy,
} from "./copy/removal-copy.ts";
import {
  workbenchLocalizedText,
  type WorkbenchPresentationText,
} from "./presentation-text.ts";

export type WorkbenchRemovalConfirmation =
  | {
      readonly kind: "session";
      readonly title: WorkbenchPresentationText;
      readonly description: WorkbenchPresentationText;
      readonly confirmLabel: WorkbenchPresentationText;
      readonly request: WorkbenchSessionRemovalRequest;
    }
  | {
      readonly kind: "project";
      readonly title: WorkbenchPresentationText;
      readonly description: WorkbenchPresentationText;
      readonly confirmLabel: WorkbenchPresentationText;
      readonly request: WorkbenchProjectSelectionRequest;
    };

export interface WorkbenchRemovalFeedback {
  readonly tone: "status" | "alert";
  readonly message: WorkbenchPresentationText;
}

export function sessionRemovalConfirmation(
  command: WorkbenchCommandView,
): WorkbenchRemovalConfirmation | null {
  if (command.session === undefined) return null;
  // A Session whose last turn outcome was never established can never leave
  // that state, so waiting cannot help and the durable layer would otherwise
  // block removal forever. The exit is this confirmation: it states what
  // deletion does and does not do, and carries the owner's acknowledgement.
  if (command.status === "recovery-required") {
    return Object.freeze({
      kind: "session" as const,
      title: workbenchLocalizedText(
        "removal.delete-session-title",
        () => removalCopy.deleteSessionTitle,
      ),
      description: workbenchLocalizedText(
        "removal.delete-session-recovery-description",
        () => deleteSessionDescriptionCopy(command.label, true),
      ),
      confirmLabel: workbenchLocalizedText(
        "removal.delete-session-confirm",
        () => removalCopy.deleteSessionConfirm,
      ),
      request: Object.freeze({
        removalKey: command.session.removalKey,
        acknowledgedUnknownOutcome: true as const,
      }),
    });
  }
  return Object.freeze({
    kind: "session" as const,
    title: workbenchLocalizedText(
      "removal.delete-session-title",
      () => removalCopy.deleteSessionTitle,
    ),
    description: workbenchLocalizedText(
      "removal.delete-session-description",
      () => deleteSessionDescriptionCopy(command.label, false),
    ),
    confirmLabel: workbenchLocalizedText(
      "removal.delete-session-confirm",
      () => removalCopy.deleteSessionConfirm,
    ),
    request: Object.freeze({ removalKey: command.session.removalKey }),
  });
}

export function projectRemovalConfirmation(
  project: WorkbenchProjectOption,
): WorkbenchRemovalConfirmation {
  return Object.freeze({
    kind: "project" as const,
    title: workbenchLocalizedText(
      "removal.remove-project-title",
      () => removalCopy.removeProjectTitle,
    ),
    description: workbenchLocalizedText(
      "removal.remove-project-description",
      () => removeProjectDescriptionCopy(project.label),
    ),
    confirmLabel: workbenchLocalizedText(
      "removal.remove-project-confirm",
      () => removalCopy.removeProjectConfirm,
    ),
    request: Object.freeze({ selectionKey: project.selectionKey }),
  });
}

export function removalFeedback(
  kind: "session",
  result: WorkbenchSessionRemovalResult,
): WorkbenchRemovalFeedback;
export function removalFeedback(
  kind: "project",
  result: WorkbenchProjectRemovalResult,
): WorkbenchRemovalFeedback;
export function removalFeedback(
  kind: "session" | "project",
  result: WorkbenchSessionRemovalResult | WorkbenchProjectRemovalResult,
): WorkbenchRemovalFeedback {
  if (result.status === "removed") {
    return kind === "session"
      ? feedback(
          "status",
          "removal.session-deleted",
          () => removalCopy.sessionDeletedFeedback,
        )
      : feedback(
          "status",
          "removal.project-removed",
          () => removalCopy.projectRemovedFeedback,
        );
  }
  if (result.status === "blocked") {
    if (result.activity === "unknown") {
      // For a Session this result now means the snapshot was stale or the
      // backend was unavailable, not that the outcome is permanently unknown:
      // that case is carried by an acknowledged request instead. So the advice
      // is to try again, and it no longer promises that waiting settles it.
      return kind === "session"
        ? feedback(
            "alert",
            "removal.session-activity-unknown",
            () => removalCopy.sessionActivityUnknownFeedback,
          )
        : feedback(
            "alert",
            "removal.project-activity-unknown",
            () => subjectActivityUnknownCopy(
              removalCopy.projectSubject,
            ),
          );
    }
    return feedback(
      "alert",
      `removal.${kind}-blocked-${result.activity}`,
      () => blockedWhileTurnActiveCopy(
        kind === "session" ? removalCopy.sessionSubject : removalCopy.projectSubject,
        kind === "session" ? removalCopy.deletedPastWord : removalCopy.removedPastWord,
        result.activity === "accepted"
          ? removalCopy.turnStartingWord
          : removalCopy.turnRunningWord,
      ),
    );
  }
  if (kind === "session") {
    return result.status === "not-found"
      ? feedback(
          "alert",
          "removal.session-not-found",
          () => removalCopy.sessionNotFoundFeedback,
        )
      : feedback(
          "alert",
          "removal.session-delete-failed",
          () => removalCopy.sessionDeleteFailedFeedback,
        );
  }
  return result.status === "invalid-selection"
    ? feedback(
        "alert",
        "removal.project-invalid-selection",
        () => removalCopy.projectInvalidSelectionFeedback,
      )
    : feedback(
        "alert",
        "removal.project-remove-failed",
        () => removalCopy.projectRemoveFailedFeedback,
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
