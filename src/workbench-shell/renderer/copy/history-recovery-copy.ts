import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

export interface RecoveryCountsCopyInput {
  readonly projects: number;
  readonly sessions: number;
  readonly commands: number;
  readonly updates: number;
}

/** Local-history data-recovery card copy. */
const englishCopy = {
  historyRecoveryCopy: {
    kicker: "Local history",
    heading: "Data recovery",
    back: "Back",
    attention:
      "Historical local data needs review. Normal Project work remains available.",
    unavailableFallback: "Data recovery information is unavailable.",
    homeIntro:
      "Review preserved historical stores separately from the active Project. Recovery never merges, imports, resumes, or changes a Project folder.",
    reviewButton: "Review data recovery",
    metadataUnavailable: "Metadata unavailable",
    preserveAction: "Preserve",
    acknowledgeAction: "Acknowledge",
    libraryHeading: "Historical Recovery Library",
    exportExactCopy: "Export exact copy…",
    loadMore: "Load more",
    projectsBreadcrumb: "Projects",
    sessionsBreadcrumb: "Sessions",
    emptyBranch: "No metadata rows in this branch.",
  },
  preservingOperationCopy: (label: string): string => `Preserving ${label}`,
  acknowledgingOperationCopy: (label: string): string =>
    `Acknowledging ${label}`,
  exportingOperationCopy: (label: string): string => `Exporting ${label}`,
  preservedCountCopy: (count: number): string => `${count} preserved`,
  recoveryCountsCopy: (counts: RecoveryCountsCopyInput): string =>
    `${counts.projects} Projects · ${counts.sessions} Sessions · ${counts.commands} commands · ${counts.updates} updates`,
  sessionRowDetailCopy: (status: string, turns: number): string =>
    `${status} · ${turns} turns`,
  turnRowDetailCopy: (status: string, events: number): string =>
    `${status} · ${events} events`,
  historyActionResultCopy: {
    acknowledged: "The verified empty historical store was acknowledged.",
    alreadyAcknowledged:
      "This verified empty historical store was already acknowledged.",
    alreadyExported: "This export operation was already committed.",
    chooserCancelled: "Export was cancelled in the file chooser.",
    outcomeUnknown:
      "The prior export outcome is unknown. Start a new export only if another copy is intentional.",
  },
  preservedResultCopy: (generationLabel: string): string =>
    `${generationLabel} was preserved in the Historical Recovery Library.`,
  alreadyPreservedResultCopy: (generationLabel: string): string =>
    `${generationLabel} was already preserved.`,
  exportedResultCopy: (exportLabel: string): string =>
    `${exportLabel} was exported as an exact copy.`,
} as const;

const simplifiedChineseCopy = {
  historyRecoveryCopy: {
    kicker: "本地历史记录",
    heading: "数据恢复",
    back: "返回",
    attention: "检测到需要检查的本地历史数据。项目的正常工作仍可继续。",
    unavailableFallback: "数据恢复信息不可用。",
    homeIntro:
      "请将保留的历史存储与活动项目分开检查。恢复操作不会合并、导入或继续会话，也不会更改项目文件夹。",
    reviewButton: "检查数据恢复",
    metadataUnavailable: "元数据不可用",
    preserveAction: "保留",
    acknowledgeAction: "确认",
    libraryHeading: "历史恢复库",
    exportExactCopy: "导出精确副本…",
    loadMore: "加载更多",
    projectsBreadcrumb: "项目",
    sessionsBreadcrumb: "智能体会话",
    emptyBranch: "此分支没有元数据行。",
  },
  preservingOperationCopy: (label: string): string => `正在保留 ${label}`,
  acknowledgingOperationCopy: (label: string): string =>
    `正在确认 ${label}`,
  exportingOperationCopy: (label: string): string => `正在导出 ${label}`,
  preservedCountCopy: (count: number): string => `已保留 ${count} 项`,
  recoveryCountsCopy: (counts: RecoveryCountsCopyInput): string =>
    `${counts.projects} 个项目 · ${counts.sessions} 个智能体会话 · ${counts.commands} 条命令 · ${counts.updates} 次更新`,
  sessionRowDetailCopy: (status: string, turns: number): string =>
    `${status} · ${turns} 个回合`,
  turnRowDetailCopy: (status: string, events: number): string =>
    `${status} · ${events} 个事件`,
  historyActionResultCopy: {
    acknowledged: "已确认经过验证的空历史存储。",
    alreadyAcknowledged: "此经过验证的空历史存储已确认。",
    alreadyExported: "此导出操作已提交。",
    chooserCancelled: "已在文件选择器中取消导出。",
    outcomeUnknown:
      "上一次导出的结果未知。仅当你确实需要另一份副本时，才开始新的导出。",
  },
  preservedResultCopy: (generationLabel: string): string =>
    `${generationLabel} 已保留到历史恢复库。`,
  alreadyPreservedResultCopy: (generationLabel: string): string =>
    `${generationLabel} 已经保留。`,
  exportedResultCopy: (exportLabel: string): string =>
    `${exportLabel} 已导出为精确副本。`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const historyRecoveryCopy = localizedCopy.historyRecoveryCopy;

export function preservingOperationCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).preservingOperationCopy(label);
}

export function acknowledgingOperationCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).acknowledgingOperationCopy(
    label,
  );
}

export function exportingOperationCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).exportingOperationCopy(label);
}

export function preservedCountCopy(count: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).preservedCountCopy(count);
}

export function recoveryCountsCopy(counts: RecoveryCountsCopyInput): string {
  return currentLocaleCopy(copyLocaleDictionaries).recoveryCountsCopy(counts);
}

export function sessionRowDetailCopy(status: string, turns: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).sessionRowDetailCopy(
    status,
    turns,
  );
}

export function turnRowDetailCopy(status: string, events: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).turnRowDetailCopy(
    status,
    events,
  );
}

export const historyActionResultCopy = localizedCopy.historyActionResultCopy;

export function preservedResultCopy(generationLabel: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).preservedResultCopy(
    generationLabel,
  );
}

export function alreadyPreservedResultCopy(generationLabel: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).alreadyPreservedResultCopy(
    generationLabel,
  );
}

export function exportedResultCopy(exportLabel: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).exportedResultCopy(
    exportLabel,
  );
}
