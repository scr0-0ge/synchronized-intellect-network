import { createLocaleCopy, defineCopyLocaleDictionaries, type LocalizedShape } from "../locale.ts";

const englishCopy = {
  heading: "Last observed subscription usage",
  channel: "Claude · Subscription",
  hint: "An account snapshot received during a turn, not current usage. Workbench does not poll. Later use in other apps or a change of account is not included.",
  fiveHour: "5-hour window",
  sevenDay: "7-day window",
  unknown: "Unknown",
  used: (value: string) => `${value} used`,
  resets: (value: string) => `Resets at ${value}`,
  observed: (value: string) => `Observed at ${value}`,
  unreadable: "The saved observation could not be read or updated. Usage is unknown.",
  unsupported: "Codex · Subscription / API, Claude · API, GLM, Kimi Code / Platform, DeepSeek: not provided by this channel.",
} as const;
const simplifiedChineseCopy = {
  heading: "上次观测的订阅用量",
  channel: "Claude · 订阅",
  hint: "这是回合中收到的账号快照，不是当前用量。Workbench 不会轮询；之后在其他应用的使用或账号切换不计入此快照。",
  fiveHour: "5 小时窗口",
  sevenDay: "7 天窗口",
  unknown: "未知",
  used: (value: string) => `已用 ${value}`,
  resets: (value: string) => `重置时间：${value}`,
  observed: (value: string) => `观测时间：${value}`,
  unreadable: "无法读取或更新已保存的观测值，用量未知。",
  unsupported: "Codex · 订阅 / API、Claude · API、GLM、Kimi Code / Platform、DeepSeek：该渠道不提供。",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(englishCopy, simplifiedChineseCopy);
export const settingsUsageCopy = createLocaleCopy(copyLocaleDictionaries);
