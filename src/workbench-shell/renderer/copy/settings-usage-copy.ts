import { createLocaleCopy, defineCopyLocaleDictionaries, type LocalizedShape } from "../locale.ts";

const englishCopy = {
  heading: "Usage & resets",
  hint: "An account snapshot received during a turn, not current usage. Workbench does not poll. Later use in other apps or a change of account is not included.",
  observed: (value: string) => `Observed at ${value}`,
  unknown: "Unknown",
  unreadable: "The saved observation could not be read or updated. Usage is unknown.",
  used: (value: string) => `${value} used`,
  resets: (value: string) => `Resets at ${value}`,
  labelled: (label: string, value: string) => `${label}: ${value}`,
  notYetObserved: "Not yet observed",
  notReported: "This provider's CLI does not report usage",
  providerName: {
    codex: "Codex",
    claude: "Claude · Subscription",
    glm: "GLM",
    deepseek: "DeepSeek",
    kimi: "Kimi",
  },
  windowLabel: {
    "five-hour": "5-hour window",
    "seven-day": "7-day window",
    "quota-window": "Quota window",
  },
} as const;
const simplifiedChineseCopy = {
  heading: "用量与重置",
  hint: "这是回合中收到的账号快照，不是当前用量。Workbench 不会轮询；之后在其他应用的使用或账号切换不计入此快照。",
  observed: (value: string) => `观测时间：${value}`,
  unknown: "未知",
  unreadable: "无法读取或更新已保存的观测值，用量未知。",
  used: (value: string) => `已用 ${value}`,
  resets: (value: string) => `重置时间：${value}`,
  labelled: (label: string, value: string) => `${label}：${value}`,
  notYetObserved: "尚未观测",
  notReported: "此提供方的 CLI 不报告用量",
  providerName: {
    codex: "Codex",
    claude: "Claude · 订阅",
    glm: "GLM",
    deepseek: "DeepSeek",
    kimi: "Kimi",
  },
  windowLabel: {
    "five-hour": "5 小时窗口",
    "seven-day": "7 天窗口",
    "quota-window": "配额窗口",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(englishCopy, simplifiedChineseCopy);
export const settingsUsageCopy = createLocaleCopy(copyLocaleDictionaries);
