/**
 * App-shell copy: system loading/failure screens and shell-level notices.
 */
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  shellCopy: {
    appTitle: "Synchronized Intellect Network",
    loadingKicker: "Synchronized Intellect Network",
    loadingTitle: "Opening live Project",
    loadingBody: "Preparing the selected Project and its durable Agent Sessions.",
    failureKicker: "Workbench shell",
    failureTitle: "Project view unavailable",
    liveDataUnavailable: "Live Project data is unavailable.",
    projectOpenedMessage: "Project was opened.",
  },
  liveWorkbenchCopy: {
    pill: "Live · direct Agent Runtime",
    projectContext: "One live Project",
    footerFollow: "Same-channel durable follow",
    footerMode: "Direct submission",
  },
} as const;

const simplifiedChineseCopy = {
  shellCopy: {
    appTitle: "同步智能网络",
    loadingKicker: "同步智能网络",
    loadingTitle: "正在打开实时项目",
    loadingBody: "正在准备所选项目及其持久化智能体会话。",
    failureKicker: "Workbench 界面",
    failureTitle: "项目视图不可用",
    liveDataUnavailable: "实时项目数据不可用。",
    projectOpenedMessage: "项目已打开。",
  },
  liveWorkbenchCopy: {
    pill: "实时 · 直连智能体运行时",
    projectContext: "一个实时项目",
    footerFollow: "同通道持久化跟进",
    footerMode: "直接提交",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const shellCopy = localizedCopy.shellCopy;

/** Legacy whole-app banner copy, kept byte-exact for its existing readers. */
export const liveWorkbenchCopy = localizedCopy.liveWorkbenchCopy;
