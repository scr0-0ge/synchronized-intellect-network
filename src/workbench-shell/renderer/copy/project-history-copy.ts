import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

/** Project-histories panel copy and every adoption / hide outcome. */
const englishCopy = {
  projectHistoryCopy: {
    title: "Other conversation histories",
    intent:
      "This Project folder has more than one recorded conversation history. Choose the one this Project should show; every other history stays available here.",
    safety:
      "Choosing or adopting a history changes only the Project Registry. Hiding is offered only for an empty history and records a visibility choice. Every conversation store remains untouched on disk.",
    currentBadge: "Shown now",
    adoptLabel: "Show this history",
    adoptingLabel: "Switching…",
    hideLabel: "Hide this empty history",
    hidingLabel: "Hiding…",
    emptyNotice: "This Project has only the history it is showing now.",
    noHistoriesNotice:
      "No recorded conversation histories were found for this Project.",
    invalidSelectionNotice:
      "This Project is no longer available. Close this panel and reopen it from the Project rail.",
    unavailableNotice:
      "This Project's conversation histories could not be read right now.",
    loadingNotice: "Reading this Project's histories…",
  },
  historyOrdinalCopy: (index: number): string => `History ${index}`,
  noRecordedSessionsLabel: "No recorded Agent Sessions",
  pluralCopy: (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? "" : "s"}`,
  historyContentSummaryCopy: (
    sessionCount: number,
    commandCount: number,
    updateCount: number,
  ): string => {
    const plural = (count: number, noun: string): string =>
      `${count} ${noun}${count === 1 ? "" : "s"}`;
    return `${plural(sessionCount, "Agent Session")} · ${plural(
      commandCount,
      "turn",
    )} · ${plural(updateCount, "update")}`;
  },
  sizeBytesLabelCopy: (byteSize: number): string => `${byteSize} bytes`,
  sizeKbLabelCopy: (roundedKb: number): string => `${roundedKb} KB`,
  sizeMbLabelCopy: (oneDecimalMb: string): string => `${oneDecimalMb} MB`,
  historyAdoptionOutcomeCopy: {
    adopted:
      "This Project now shows the chosen history. The previous one is untouched on disk and can be adopted back.",
    blockedUnknown:
      "The history was not switched because turn activity could not be verified. Nothing changed. Try again when activity is known.",
    turnStartingWord: "starting",
    turnRunningWord: "running",
    invalidSelection:
      "That history is no longer offered for this Project. Nothing changed. Reopen the list and choose again.",
    switchFailed:
      "The history could not be switched. Nothing changed, and every history is still on disk.",
  },
  adoptionBlockedWhileTurnCopy: (progressWord: string): string =>
    `The history was not switched because a turn is ${progressWord}. Let it finish, then try again. Nothing changed.`,
  historyHideOutcomeCopy: {
    hidden: "Empty history hidden. Its conversation store remains on disk.",
    ineligible:
      "Only a non-current history with no recorded Agent Sessions can be hidden. Nothing changed.",
    invalidSelection:
      "That history is no longer offered for this Project. Nothing changed. Reopen the list and choose again.",
    hideFailed:
      "The empty history could not be hidden. Nothing changed, and every conversation store remains on disk.",
  },
} as const;

const simplifiedChineseCopy = {
  projectHistoryCopy: {
    title: "其他对话历史",
    intent:
      "此项目文件夹包含多份已记录的对话历史。请选择此项目要显示的一份；其他历史仍可在此访问。",
    safety:
      "选择或采用历史只会更改项目注册表。仅空历史可隐藏，且隐藏只记录可见性选择。磁盘上的所有对话存储都不会被改动。",
    currentBadge: "当前显示",
    adoptLabel: "显示此历史",
    adoptingLabel: "正在切换…",
    hideLabel: "隐藏此空历史",
    hidingLabel: "正在隐藏…",
    emptyNotice: "此项目只有当前显示的历史。",
    noHistoriesNotice: "未找到此项目的已记录对话历史。",
    invalidSelectionNotice: "此项目已不可用。请关闭此面板，然后从项目栏重新打开。",
    unavailableNotice: "暂时无法读取此项目的对话历史。",
    loadingNotice: "正在读取此项目的历史…",
  },
  historyOrdinalCopy: (index: number): string => `历史 ${index}`,
  noRecordedSessionsLabel: "没有已记录的智能体会话",
  pluralCopy: (count: number, noun: string): string => `${count} 个${noun}`,
  historyContentSummaryCopy: (
    sessionCount: number,
    commandCount: number,
    updateCount: number,
  ): string =>
    `${sessionCount} 个智能体会话 · ${commandCount} 个回合 · ${updateCount} 次更新`,
  sizeBytesLabelCopy: (byteSize: number): string => `${byteSize} 字节`,
  sizeKbLabelCopy: (roundedKb: number): string => `${roundedKb} KB`,
  sizeMbLabelCopy: (oneDecimalMb: string): string => `${oneDecimalMb} MB`,
  historyAdoptionOutcomeCopy: {
    adopted: "此项目现已显示所选历史。上一份历史在磁盘上保持不变，可随时切换回来。",
    blockedUnknown:
      "因无法验证回合活动，未切换历史。未做任何更改。请在活动状态明确后重试。",
    turnStartingWord: "启动中",
    turnRunningWord: "运行中",
    invalidSelection: "此项目已不再提供该历史。未做任何更改。请重新打开列表并选择。",
    switchFailed: "无法切换历史。未做任何更改，所有历史仍保留在磁盘上。",
  },
  adoptionBlockedWhileTurnCopy: (progressWord: string): string =>
    `因回合正处于${progressWord}状态，未切换历史。请等待其完成后重试。未做任何更改。`,
  historyHideOutcomeCopy: {
    hidden: "空历史已隐藏，其对话存储仍保留在磁盘上。",
    ineligible: "只能隐藏非当前且没有已记录智能体会话的历史。未做任何更改。",
    invalidSelection: "此项目已不再提供该历史。未做任何更改。请重新打开列表并选择。",
    hideFailed: "无法隐藏空历史。未做任何更改，所有对话存储仍保留在磁盘上。",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const projectHistoryCopy = localizedCopy.projectHistoryCopy;

export function historyOrdinalCopy(index: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).historyOrdinalCopy(index);
}

export let noRecordedSessionsLabel: string = englishCopy.noRecordedSessionsLabel;

subscribeLocale((nextLocale) => {
  noRecordedSessionsLabel =
    copyLocaleDictionaries[nextLocale].noRecordedSessionsLabel;
});

export function pluralCopy(count: number, noun: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).pluralCopy(count, noun);
}

export function historyContentSummaryCopy(
  sessionCount: number,
  commandCount: number,
  updateCount: number,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).historyContentSummaryCopy(
    sessionCount,
    commandCount,
    updateCount,
  );
}

export function sizeBytesLabelCopy(byteSize: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).sizeBytesLabelCopy(byteSize);
}

export function sizeKbLabelCopy(roundedKb: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).sizeKbLabelCopy(roundedKb);
}

export function sizeMbLabelCopy(oneDecimalMb: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).sizeMbLabelCopy(oneDecimalMb);
}

export const historyAdoptionOutcomeCopy =
  localizedCopy.historyAdoptionOutcomeCopy;

export function adoptionBlockedWhileTurnCopy(progressWord: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).adoptionBlockedWhileTurnCopy(
    progressWord,
  );
}

export const historyHideOutcomeCopy = localizedCopy.historyHideOutcomeCopy;
