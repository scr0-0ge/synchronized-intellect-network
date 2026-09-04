import type {
  ProjectCommandFailureCategory,
  ProjectCommandStatus,
} from "../../../coordinator/index.ts";
import type { WorkbenchTimelineEvent } from "../../contract.ts";
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

/**
 * Session status vocabulary shared by the rail, stage, inspector and statusbar.
 */
const englishCopy = {
  statusCopy: {
    accepted: "Accepted",
    "in-flight": "Running",
    completed: "Completed",
    failed: "Failed",
    "recovery-required": "Recovery required",
  },
  failureCopy: {
    interrupted: "Interrupted by the user. This Agent Session can continue.",
    "profile-resolution-failed": "Session Profile could not be resolved.",
    "runtime-failed": "The Agent Runtime reported a fixed failure category.",
  },
  chromeTerminalCopy: {
    turnInterrupted: "Turn interrupted",
    sessionFailed: "Session failed",
    recoveryRequired: "Recovery required",
  },
  eventTitleCopy: {
    "user-message": "User message",
    "session-started": "Agent Session opened",
    "turn-started": "Turn started",
    "item-started": "Agent message started",
    "agent-message": "Agent message",
    "item-completed": "Agent message completed",
    "turn-completed": "Turn completed",
    "turn-interrupted": "Turn interrupted",
    failed: "Runtime event failed",
  },
  interruptedStatusLabel: "Interrupted",
} as const;

const simplifiedChineseCopy = {
  statusCopy: {
    accepted: "已接受",
    "in-flight": "运行中",
    completed: "已完成",
    failed: "失败",
    "recovery-required": "需要恢复",
  },
  failureCopy: {
    interrupted: "已由用户中断。此智能体会话可以继续。",
    "profile-resolution-failed": "无法解析会话配置。",
    "runtime-failed": "智能体运行时报告了固定失败类别。",
  },
  chromeTerminalCopy: {
    turnInterrupted: "回合已中断",
    sessionFailed: "智能体会话失败",
    recoveryRequired: "需要恢复",
  },
  eventTitleCopy: {
    "user-message": "用户消息",
    "session-started": "智能体会话已打开",
    "turn-started": "回合已开始",
    "item-started": "智能体消息已开始",
    "agent-message": "智能体消息",
    "item-completed": "智能体消息已完成",
    "turn-completed": "回合已完成",
    "turn-interrupted": "回合已中断",
    failed: "运行时事件失败",
  },
  interruptedStatusLabel: "已中断",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const statusCopy: Readonly<Record<ProjectCommandStatus, string>> =
  localizedCopy.statusCopy;

/** Failure-category sentences shown when a command has no Session. */
export const failureCopy: Readonly<
  Record<ProjectCommandFailureCategory, string>
> = localizedCopy.failureCopy;

/** Statusbar words for a selected command in its terminal-ish states. */
export const chromeTerminalCopy = localizedCopy.chromeTerminalCopy;

/** Accessible titles for timeline events. */
export const eventTitleCopy: Readonly<
  Record<WorkbenchTimelineEvent["kind"], string>
> = localizedCopy.eventTitleCopy;

/** Label used by commandStatusLabel when a turn was user-interrupted. */
export let interruptedStatusLabel: string = englishCopy.interruptedStatusLabel;

subscribeLocale((nextLocale) => {
  interruptedStatusLabel =
    copyLocaleDictionaries[nextLocale].interruptedStatusLabel;
});
