/**
 * OS turn-notification copy, activation feedback, and the fallback title used
 * when a Session carries no visible label.
 */
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  notificationActivationCopy: {
    differentProject:
      "That Agent Session is in another Project, not the current Project.",
    unavailableInCurrentProject:
      "That Agent Session is no longer available in the current Project.",
    archived:
      "That Agent Session is archived and cannot be opened from this notification.",
  },
  turnNotificationCopy: {
    completed: "The Agent turn completed.",
    failed: "The Agent turn failed.",
    "recovery-required": "The turn outcome is unknown. Recovery required.",
  },
  fallbackTurnTitleLabel: "Agent Session",
} as const;

const simplifiedChineseCopy = {
  notificationActivationCopy: {
    differentProject: "该智能体会话位于另一个项目中，不在当前项目里。",
    unavailableInCurrentProject: "该智能体会话已无法在当前项目中使用。",
    archived: "该智能体会话已归档，无法通过此通知打开。",
  },
  turnNotificationCopy: {
    completed: "智能体回合已完成。",
    failed: "智能体回合失败。",
    "recovery-required": "回合结果未知，需要恢复。",
  },
  fallbackTurnTitleLabel: "智能体会话",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const notificationActivationCopy =
  localizedCopy.notificationActivationCopy;

export const turnNotificationCopy: Readonly<
  Record<"completed" | "failed" | "recovery-required", string>
> = localizedCopy.turnNotificationCopy;

export let fallbackTurnTitleLabel: string = englishCopy.fallbackTurnTitleLabel;

subscribeLocale((nextLocale) => {
  fallbackTurnTitleLabel =
    copyLocaleDictionaries[nextLocale].fallbackTurnTitleLabel;
});
