/**
 * Window chrome copy: titlebar controls and the statusbar.
 */
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  projectMenuTitle: "Return to the selected Project",
  minimize: "Minimize",
  restore: "Restore",
  maximize: "Maximize",
  close: "Close",
  credentialsNote: "No subscription credentials handled",
  noRuntimeEndpoint: "No runtime endpoint",
  nextRunKey: "Next run",
  nextRunNone: "no endpoint chosen",
  intensityKey: "Intensity",
  execKey: "Exec",
  accessKey: "Access",
  sendShortcutKey: "Ctrl ↵",
  sendShortcutVerb: "send",
  interruptShortcutKey: "Esc",
  interruptShortcutVerb: "interrupt",
  turnInterruptedStatus: "Turn interrupted",
  sessionFailedStatus: "Session failed",
  recoveryRequiredStatus: "Recovery required",
  draftPreserved: "Draft preserved",
} as const;

const simplifiedChineseCopy = {
  projectMenuTitle: "返回所选项目",
  minimize: "最小化",
  restore: "还原",
  maximize: "最大化",
  close: "关闭",
  credentialsNote: "不处理订阅凭据",
  noRuntimeEndpoint: "无运行时端点",
  nextRunKey: "下次运行",
  nextRunNone: "未选择端点",
  intensityKey: "工作强度",
  execKey: "执行",
  accessKey: "访问",
  sendShortcutKey: "Ctrl ↵",
  sendShortcutVerb: "发送",
  interruptShortcutKey: "Esc",
  interruptShortcutVerb: "中断",
  turnInterruptedStatus: "回合已中断",
  sessionFailedStatus: "智能体会话失败",
  recoveryRequiredStatus: "需要恢复",
  draftPreserved: "草稿已保留",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

export const chromeCopy = createLocaleCopy(copyLocaleDictionaries);
