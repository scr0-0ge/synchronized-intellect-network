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
  quotaPauseCopy: {
    notice: "Quota exhausted; this attempt did not execute. After confirming quota is available, enter a new instruction and choose Resume. No automatic retry; this wait expires within 24 hours.",
    resume: "Resume",
    profileLocked: "Resume keeps the same endpoint and profile. Enter a new instruction when quota is available.",
    resetNotice: (resetTime: string, observedTime: string): string =>
      `Provider says it resets at ${resetTime} (local) — as observed at ${observedTime}.`,
  },
  statusCopy: {
    accepted: "Accepted",
    "in-flight": "Running",
    completed: "Completed",
    "quota-paused": "Quota exhausted — paused",
    failed: "Failed",
    "recovery-required": "Recovery required",
  },
  failureCopy: {
    interrupted: "Interrupted by the user. This Agent Session can continue.",
    "profile-resolution-failed": "Session Profile could not be resolved.",
    "runtime-failed": "The Agent Runtime reported a fixed failure category.",
    "quota-expired": "Quota wait expired. No automatic retry was made. Start a new Session when ready.",
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
    progress: "Runtime activity",
    reasoning: "Reasoning",
    "turn-completed": "Turn completed",
    "turn-interrupted": "Turn interrupted",
    "turn-paused": "Quota exhausted; this attempt did not execute",
    failed: "Runtime event failed",
  },
  interruptedStatusLabel: "Interrupted",
} as const;

const simplifiedChineseCopy = {
  quotaPauseCopy: {
    notice: "额度耗尽，此次请求未执行。确认额度恢复后，请输入新的继续指令并点击「恢复」。不会自动重试；本次等待最多保留 24 小时。",
    resume: "恢复",
    profileLocked: "恢复沿用原端点和配置。额度恢复后，请输入新的继续指令。",
    resetNotice: (resetTime: string, observedTime: string): string =>
      `Provider 说 ${resetTime}（本地）重置 —— 观测于 ${observedTime}。`,
  },
  statusCopy: {
    accepted: "已接受",
    "in-flight": "运行中",
    completed: "已完成",
    "quota-paused": "额度耗尽 · 已暂停",
    failed: "失败",
    "recovery-required": "需要恢复",
  },
  failureCopy: {
    interrupted: "已由用户中断。此智能体会话可以继续。",
    "profile-resolution-failed": "无法解析会话配置。",
    "runtime-failed": "智能体运行时报告了固定失败类别。",
    "quota-expired": "额度等待已到期，未自动重试。准备好后请新建会话重新发起。",
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
    progress: "运行时活动",
    reasoning: "思考内容",
    "turn-completed": "回合已完成",
    "turn-interrupted": "回合已中断",
    "turn-paused": "额度耗尽，此次请求未执行",
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
export const quotaPauseCopy = localizedCopy.quotaPauseCopy;

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
