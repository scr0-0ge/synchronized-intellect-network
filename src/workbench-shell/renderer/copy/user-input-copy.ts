import { createLocaleCopy, defineCopyLocaleDictionaries, type LocalizedShape } from "../locale.ts";

const english = {
  title: "The Runtime has a question",
  hint: "Answer the questions below. Nothing is selected automatically.",
  expires: "Unanswered questions expire within five minutes. You can cancel without answering.",
  other: "Write my own answer",
  send: "Send answer",
  cancel: "Cancel question",
  dismiss: "Dismiss",
  sending: "Sending…",
  unavailable: "Questions are unavailable. You can still stop the turn or change Sessions.",
  uncertain: "The reply was not confirmed. Check the question status before trying again, or stop the turn.",
  invalid: "The answer was not accepted. Check every question and try again.",
  expired: "The answer window has expired. Check the Runtime status, or stop the turn.",
  answered: "Answer sent.",
  cancelled: "Question cancelled without an answer.",
  "timed-out": "Question timed out without an answer.",
  "runtime-resolved": "The Runtime closed this question.",
  "session-ended": "The turn or Session ended. This question can no longer be answered.",
} as const;
const chinese = {
  title: "运行时有一个问题",
  hint: "请回答下方的问题。不会自动替你选择。",
  expires: "未回答的问题将在五分钟内过期。你也可以取消而不作答。",
  other: "自行输入答案",
  send: "发送答案",
  cancel: "取消提问",
  dismiss: "收起",
  sending: "正在发送…",
  unavailable: "暂时无法读取提问。你仍可停止回合或切换会话。",
  uncertain: "尚未确认回复已送达。请先查看提问状态再重试，或停止回合。",
  invalid: "答案未被接受。请检查每个问题后重试。",
  expired: "作答时间已过。请查看运行时状态，或停止回合。",
  answered: "答案已发送。",
  cancelled: "已取消提问，未发送答案。",
  "timed-out": "提问已超时，未发送答案。",
  "runtime-resolved": "运行时已关闭此提问。",
  "session-ended": "回合或会话已结束，无法再回答此问题。",
} as const satisfies LocalizedShape<typeof english>;
export const copyLocaleDictionaries = defineCopyLocaleDictionaries(english, chinese);
export const userInputCopy = createLocaleCopy(copyLocaleDictionaries);
