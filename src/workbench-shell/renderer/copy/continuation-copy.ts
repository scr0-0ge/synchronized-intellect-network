import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  heading: (step: number, limit: number): string => `Automatic continuation stopped at ${step}/${limit}`,
  progress: (step: number, limit: number): string => `Auto-continue ${step}/${limit}`,
  reasons: {
    "continuation-unavailable": "This Session is no longer eligible for continuation. No next input was sent.",
    "turn-not-completed": "The last turn was not confirmed completed. No next input was sent; its recorded state is shown in the conversation.",
    "observation-unavailable": "The turn state could not be confirmed. Check the conversation before continuing manually.",
    "submission-unavailable": "The next input could not be confirmed as accepted. Check the conversation before continuing manually.",
    "interrupted-by-user": "You stopped this turn. No next input was sent; its recorded state is shown in the conversation.",
  },
} as const;

const simplifiedChineseCopy = {
  heading: (step: number, limit: number): string => `自动续办已停止，停在 ${step}/${limit}`,
  progress: (step: number, limit: number): string => `自动续办 ${step}/${limit}`,
  reasons: {
    "continuation-unavailable": "此会话已不满足续办条件，未发送下一步。",
    "turn-not-completed": "上一回合未被确认已完成，未发送下一步；已记录的回合状态仍显示在对话中。",
    "observation-unavailable": "无法确认回合状态。请先检查对话，再决定是否手动继续。",
    "submission-unavailable": "无法确认下一条输入已被接受。请先检查对话，再决定是否手动继续。",
    "interrupted-by-user": "是你中断了这一回合，未发送下一步；已记录的回合状态仍显示在对话中。",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(englishCopy, simplifiedChineseCopy);
export const continuationCopy = createLocaleCopy(copyLocaleDictionaries);
