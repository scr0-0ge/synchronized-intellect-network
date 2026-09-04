import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/** Transcript copy: search, failures, turn headers and profile phrasing. */
const englishCopy = {
  transcriptCopy: {
    emptyTitle: "No durable activity",
    emptyBody: "Choose an Agent Session from the selected Project.",
    searchPlaceholder: "Filter turns…",
    searchAria: "Filter Agent Session timeline",
    sessionStartedRule: "Session started",
    sessionEndedRule: "Session ended",
    failedTitle: "The Agent Session failed",
    failedBody:
      "The Agent Runtime reported a fixed failure. Work already durably recorded above is kept. This Session cannot be continued because the Workbench has no safe continuation handle for it.",
    interruptedRule: "Turn interrupted",
    interruptedTitle: "The turn was interrupted",
    interruptedBody:
      "The turn stopped at your request. This Agent Session is intact and can continue.",
    outcomeUnknownRule: "Outcome unknown",
    recoveryTitle: "Recovery required",
    recoveryBody:
      "The effect was accepted, then contact was lost. Nothing is asserted about what did or did not happen. Check the Project before starting replacement work.",
    noNormalizedEventsTitle: "No normalized events",
    noNormalizedEventsBody:
      "This Agent Session has a recorded profile but no durable timeline events yet.",
    actorUser: "You",
    stateWorking: "working",
    stateInterrupted: "interrupted",
    runtimeWorking: "The Agent Runtime is working",
    interruptedBeforeMessage:
      "This turn was interrupted before an agent message was recorded.",
    noAgentMessageRecorded: "No agent message text was recorded for this turn.",
    eventLogAria: "Normalized durable events for turn",
    copyButton: "Copy",
    copyingButton: "Copying…",
    copiedButton: "Copied",
    copyFailedButton: "Copy failed",
    copyCodeAria: "Copy code",
    notRecordedWord: "not recorded",
  },
  turnStateCopy: {
    accepted: "accepted",
    "in-flight": "working",
    completed: "completed",
    failed: "failed",
    "recovery-required": "outcome unknown",
  },
  transcriptSearchCountCopy: (visible: number, total: number): string =>
    `${visible} of ${total} turns`,
  turnOrdinalCopy: (index: number): string => `Turn ${index}`,
  eventsDisclosureCopy: (count: number): string =>
    `${count} ${count === 1 ? "event" : "events"}`,
  effectiveNotRecordedCopy: (noun: string): string =>
    `${noun} not recorded`,
  effectiveUnknownCopy: (noun: string): string => `${noun} unknown`,
  effectiveUnknownRequestedCopy: (
    noun: string,
    requestedLabel: string,
  ): string => `${noun} unknown · requested ${requestedLabel}`,
  differsFromRequestedWithFallbackCopy: (
    label: string,
    requestedLabel: string | undefined,
  ): string =>
    `${label} · differs from requested ${requestedLabel ?? "not recorded"}`,
  modelNounCopy: (): string => "Model",
  workIntensityNounCopy: (): string => "Work Intensity",
} as const;

const simplifiedChineseCopy = {
  transcriptCopy: {
    emptyTitle: "暂无持久化活动",
    emptyBody: "请从所选项目中选择一个智能体会话。",
    searchPlaceholder: "筛选回合…",
    searchAria: "筛选智能体会话时间线",
    sessionStartedRule: "会话已开始",
    sessionEndedRule: "会话已结束",
    failedTitle: "智能体会话失败",
    failedBody:
      "智能体运行时报告了固定失败。上方已持久化记录的工作会保留。Workbench 没有此会话的安全继续句柄，因此无法继续该会话。",
    interruptedRule: "回合已中断",
    interruptedTitle: "回合已中断",
    interruptedBody: "回合已按你的请求停止。此智能体会话保持完整，可以继续。",
    outcomeUnknownRule: "结果未知",
    recoveryTitle: "需要恢复",
    recoveryBody:
      "操作已被接受，但随后失去联系。系统不会断言操作是否发生。开始替代工作前，请先检查项目。",
    noNormalizedEventsTitle: "没有标准化事件",
    noNormalizedEventsBody: "此智能体会话已有记录的配置，但还没有持久化时间线事件。",
    actorUser: "你",
    stateWorking: "处理中",
    stateInterrupted: "已中断",
    runtimeWorking: "智能体运行时正在工作",
    interruptedBeforeMessage: "此回合在记录智能体消息前已中断。",
    noAgentMessageRecorded: "此回合没有记录智能体消息文本。",
    eventLogAria: "回合的标准化持久化事件",
    copyButton: "复制",
    copyingButton: "正在复制…",
    copiedButton: "已复制",
    copyFailedButton: "复制失败",
    copyCodeAria: "复制代码",
    notRecordedWord: "未记录",
  },
  turnStateCopy: {
    accepted: "已接受",
    "in-flight": "处理中",
    completed: "已完成",
    failed: "失败",
    "recovery-required": "结果未知",
  },
  transcriptSearchCountCopy: (visible: number, total: number): string =>
    `显示 ${visible} / ${total} 个回合`,
  turnOrdinalCopy: (index: number): string => `回合 ${index}`,
  eventsDisclosureCopy: (count: number): string => `${count} 个事件`,
  effectiveNotRecordedCopy: (noun: string): string => `未记录${noun}`,
  effectiveUnknownCopy: (noun: string): string => `${noun}未知`,
  effectiveUnknownRequestedCopy: (
    noun: string,
    requestedLabel: string,
  ): string => `${noun}未知 · 请求值为 ${requestedLabel}`,
  differsFromRequestedWithFallbackCopy: (
    label: string,
    requestedLabel: string | undefined,
  ): string =>
    `${label} · 与请求值 ${requestedLabel ?? "未记录"} 不同`,
  modelNounCopy: (): string => "模型",
  workIntensityNounCopy: (): string => "工作强度",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const transcriptCopy = localizedCopy.transcriptCopy;

export const turnStateCopy: Readonly<
  Record<
    "accepted" | "in-flight" | "completed" | "failed" | "recovery-required",
    string
  >
> = localizedCopy.turnStateCopy;

export function transcriptSearchCountCopy(
  visible: number,
  total: number,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).transcriptSearchCountCopy(
    visible,
    total,
  );
}

export function turnOrdinalCopy(index: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).turnOrdinalCopy(index);
}

export function eventsDisclosureCopy(count: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).eventsDisclosureCopy(count);
}

export function effectiveNotRecordedCopy(noun: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).effectiveNotRecordedCopy(noun);
}

export function effectiveUnknownCopy(noun: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).effectiveUnknownCopy(noun);
}

export function effectiveUnknownRequestedCopy(
  noun: string,
  requestedLabel: string,
): string {
  return currentLocaleCopy(
    copyLocaleDictionaries,
  ).effectiveUnknownRequestedCopy(noun, requestedLabel);
}

export function differsFromRequestedWithFallbackCopy(
  label: string,
  requestedLabel: string | undefined,
): string {
  return currentLocaleCopy(
    copyLocaleDictionaries,
  ).differsFromRequestedWithFallbackCopy(label, requestedLabel);
}

export function modelNounCopy(): string {
  return currentLocaleCopy(copyLocaleDictionaries).modelNounCopy();
}

export function workIntensityNounCopy(): string {
  return currentLocaleCopy(copyLocaleDictionaries).workIntensityNounCopy();
}
