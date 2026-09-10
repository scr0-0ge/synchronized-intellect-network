import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/**
 * Removal confirmation and feedback copy for Sessions and Projects.
 */
const englishCopy = {
  removalCopy: {
    deleteSessionTitle: "Delete Agent Session?",
    deleteSessionConfirm: "Delete Session",
    removeProjectTitle: "Remove Project from Workbench?",
    removeProjectConfirm: "Remove Project",
    sessionSubject: "Agent Session",
    projectSubject: "Project",
    turnStartingWord: "starting",
    turnRunningWord: "running",
    deletedPastWord: "deleted",
    removedPastWord: "removed",
    sessionDeletedFeedback: "Agent Session deleted.",
    projectRemovedFeedback:
      "Project removed from the Workbench. Its folder and files remain on disk.",
    sessionActivityUnknownFeedback:
      "Agent Session was not deleted because turn activity could not be verified. Try again — if its last turn outcome was never established, you will be asked to confirm removal.",
    subjectActivityUnknownSuffix:
      " was not removed because turn activity could not be verified. Switch to another Project, then remove this Project from the Workbench; its recorded conversation history remains available when you reopen it.",
    blockedTurnSuffix: " because a turn is ",
    blockedTurnMiddle: "Let it finish, then try again.",
    sessionNotFoundFeedback:
      "That Agent Session is no longer available. The Project view was refreshed.",
    sessionDeleteFailedFeedback:
      "Agent Session could not be deleted. Nothing changed.",
    projectInvalidSelectionFeedback:
      "That Project is no longer available in this Project list. Nothing changed.",
    projectRemoveFailedFeedback:
      "Project could not be removed from the Workbench. Its folder and files remain on disk.",
  },
  deleteSessionDescriptionCopy: (
    label: string,
    unknownOutcome: boolean,
  ): string =>
    unknownOutcome
      ? `Delete ${label} and its recorded conversation? The outcome of its last turn was never established, and that cannot change. Deleting removes this record; it does not stop or undo work the runtime may already have done. This cannot be undone.`
      : `Delete ${label} and its recorded conversation? This cannot be undone.`,
  removeProjectDescriptionCopy: (label: string): string =>
    `Remove ${label} from this Workbench? Its folder and files will stay on disk.`,
  subjectActivityUnknownCopy: (subject: string): string =>
    `${subject} was not removed because turn activity could not be verified. Switch to another Project, then remove this Project from the Workbench; its recorded conversation history remains available when you reopen it.`,
  blockedWhileTurnActiveCopy: (
    subject: string,
    pastVerb: string,
    progressWord: string,
  ): string =>
    `${subject} was not ${pastVerb} because a turn is ${progressWord}. Let it finish, then try again.`,
} as const;

const simplifiedChineseCopy = {
  removalCopy: {
    deleteSessionTitle: "删除智能体会话？",
    deleteSessionConfirm: "删除会话",
    removeProjectTitle: "从 Workbench 中移除项目？",
    removeProjectConfirm: "移除项目",
    sessionSubject: "智能体会话",
    projectSubject: "项目",
    turnStartingWord: "启动中",
    turnRunningWord: "运行中",
    deletedPastWord: "删除",
    removedPastWord: "移除",
    sessionDeletedFeedback: "智能体会话已删除。",
    projectRemovedFeedback: "项目已从 Workbench 中移除，其文件夹和文件仍保留在磁盘上。",
    sessionActivityUnknownFeedback:
      "因无法验证回合活动，智能体会话未删除。请重试；如果上一个回合的结果从未确定，系统会要求你确认移除。",
    subjectActivityUnknownSuffix:
      "未被移除，因为无法验证回合活动。请先切换到另一个项目，再从 Workbench 中移除当前项目；重新打开时仍可使用已记录的对话历史。",
    blockedTurnSuffix: "，因为回合正在",
    blockedTurnMiddle: "请等待其完成后重试。",
    sessionNotFoundFeedback: "该智能体会话已不可用。项目视图已刷新。",
    sessionDeleteFailedFeedback: "无法删除智能体会话。未做任何更改。",
    projectInvalidSelectionFeedback: "该项目已不在项目列表中。未做任何更改。",
    projectRemoveFailedFeedback:
      "无法从 Workbench 中移除项目。其文件夹和文件仍保留在磁盘上。",
  },
  deleteSessionDescriptionCopy: (
    label: string,
    unknownOutcome: boolean,
  ): string =>
    unknownOutcome
      ? `删除 ${label} 及其记录的对话？上一个回合的结果从未确定，且已无法改变。删除只会移除此记录；不会停止或撤销运行时可能已经完成的工作。此操作无法撤销。`
      : `删除 ${label} 及其记录的对话？此操作无法撤销。`,
  removeProjectDescriptionCopy: (label: string): string =>
    `从此 Workbench 中移除 ${label}？其文件夹和文件仍会保留在磁盘上。`,
  subjectActivityUnknownCopy: (subject: string): string =>
    `${subject}未被移除，因为无法验证回合活动。请先切换到另一个项目，再从 Workbench 中移除当前项目；重新打开时仍可使用已记录的对话历史。`,
  blockedWhileTurnActiveCopy: (
    subject: string,
    pastVerb: string,
    progressWord: string,
  ): string =>
    `${subject}未${pastVerb}，因为回合正处于${progressWord}状态。请等待其完成后重试。`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const removalCopy = localizedCopy.removalCopy;

export function deleteSessionDescriptionCopy(
  label: string,
  unknownOutcome: boolean,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).deleteSessionDescriptionCopy(
    label,
    unknownOutcome,
  );
}

export function removeProjectDescriptionCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).removeProjectDescriptionCopy(
    label,
  );
}

export function subjectActivityUnknownCopy(subject: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).subjectActivityUnknownCopy(
    subject,
  );
}

export function blockedWhileTurnActiveCopy(
  subject: string,
  pastVerb: string,
  progressWord: string,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).blockedWhileTurnActiveCopy(
    subject,
    pastVerb,
    progressWord,
  );
}
