import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/**
 * Session metadata presentation copy: archive/restore controls and the
 * rename/archive/restore feedback sentences.
 */
const englishCopy = {
  sessionMetadataCopy: {
    archiveLabel: "Archive",
    restoreLabel: "Restore",
    restoreUnavailableTitle:
      "Turn activity could not be verified; restore is unavailable.",
    restoreTitle: "Restore Agent Session",
    archiveUnavailableTitle:
      "Turn activity could not be verified; archive is unavailable.",
    archiveTitle: "Archive Agent Session",
    startingArchiveTitle: "A turn is starting; archive is unavailable.",
    runningArchiveTitle: "A turn is running; archive is unavailable.",
    recoveryArchiveTitle:
      "Confirm that this Session's final turn outcome is unknown to archive it. Archiving keeps it in Recovery required.",
    renamedFeedback: "Agent Session renamed.",
    archivedFeedback: "Agent Session archived.",
    restoredFeedback: "Agent Session restored.",
    alreadyRenamedFeedback: "That Agent Session already uses this name.",
    alreadyArchivedFeedback: "That Agent Session is already archived.",
    alreadyActiveFeedback: "That Agent Session is already active.",
    blockUnknownFeedback:
      "Agent Session was not archived because turn activity could not be verified. Confirm that its final turn outcome is unknown to archive it; archiving keeps it in Recovery required.",
    invalidNameFeedback:
      "Agent Session was not renamed. Enter a non-empty name of at most 80 characters without control characters.",
    notFoundFeedback:
      "That Agent Session is no longer available. The Project view was refreshed.",
    renameFailedFeedback: "Agent Session could not be renamed. Nothing changed.",
    archiveFailedFeedback: "Agent Session could not be archived. Nothing changed.",
    restoreFailedFeedback:
      "Agent Session could not be restored. Nothing changed.",
  },
  archiveAccessibleNameCopy: (label: string): string => `Archive ${label}`,
  restoreAccessibleNameCopy: (label: string): string => `Restore ${label}`,
  blockedByTurnActivityCopy: (progressWord: string): string =>
    `Agent Session was not archived because a turn is ${progressWord}. Let it finish, then try again.`,
} as const;

const simplifiedChineseCopy = {
  sessionMetadataCopy: {
    archiveLabel: "归档",
    restoreLabel: "恢复",
    restoreUnavailableTitle: "无法验证回合活动；恢复不可用。",
    restoreTitle: "恢复智能体会话",
    archiveUnavailableTitle: "无法验证回合活动；归档不可用。",
    archiveTitle: "归档智能体会话",
    startingArchiveTitle: "回合正在启动；归档不可用。",
    runningArchiveTitle: "回合正在运行；归档不可用。",
    recoveryArchiveTitle:
      "确认此会话的最终结果未知后可将其归档；归档不会清除“需要恢复”状态。",
    renamedFeedback: "智能体会话已重命名。",
    archivedFeedback: "智能体会话已归档。",
    restoredFeedback: "智能体会话已恢复。",
    alreadyRenamedFeedback: "该智能体会话已使用此名称。",
    alreadyArchivedFeedback: "该智能体会话已归档。",
    alreadyActiveFeedback: "该智能体会话已处于活动状态。",
    blockUnknownFeedback:
      "智能体会话未归档，因为无法验证回合活动。确认其最终结果未知后可归档；归档不会清除“需要恢复”状态。",
    invalidNameFeedback:
      "智能体会话未重命名。请输入不含控制字符、长度不超过 80 个字符的非空名称。",
    notFoundFeedback: "该智能体会话已不可用。项目视图已刷新。",
    renameFailedFeedback: "无法重命名智能体会话。未做任何更改。",
    archiveFailedFeedback: "无法归档智能体会话。未做任何更改。",
    restoreFailedFeedback: "无法恢复智能体会话。未做任何更改。",
  },
  archiveAccessibleNameCopy: (label: string): string => `归档 ${label}`,
  restoreAccessibleNameCopy: (label: string): string => `恢复 ${label}`,
  blockedByTurnActivityCopy: (progressWord: string): string =>
    `因回合正处于${progressWord}状态，智能体会话未归档。请等待其完成后重试。`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const sessionMetadataCopy = localizedCopy.sessionMetadataCopy;

export function archiveAccessibleNameCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).archiveAccessibleNameCopy(label);
}

export function restoreAccessibleNameCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).restoreAccessibleNameCopy(label);
}

export function blockedByTurnActivityCopy(progressWord: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).blockedByTurnActivityCopy(
    progressWord,
  );
}
