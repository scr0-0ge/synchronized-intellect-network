/**
 * OS turn-notification copy for terminal turn outcomes, plus the fallback
 * title used when a Session carries no visible label.
 */
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  turnNotificationCopy: {
    completed: "The Agent turn completed.",
    failed: "The Agent turn failed.",
    "recovery-required": "The turn outcome is unknown. Recovery required.",
  },
  fallbackTurnTitleLabel: "Agent Session",
} as const;

const simplifiedChineseCopy = {
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

export const turnNotificationCopy: Readonly<
  Record<"completed" | "failed" | "recovery-required", string>
> = localizedCopy.turnNotificationCopy;

export let fallbackTurnTitleLabel: string = englishCopy.fallbackTurnTitleLabel;

subscribeLocale((nextLocale) => {
  fallbackTurnTitleLabel =
    copyLocaleDictionaries[nextLocale].fallbackTurnTitleLabel;
});
