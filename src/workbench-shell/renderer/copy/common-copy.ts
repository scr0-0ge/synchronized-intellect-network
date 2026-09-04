/**
 * Shared user-visible copy atoms reused by more than one screen domain.
 * Every string here is byte-exact with what the JSX previously inlined.
 */
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  returnToSelectedProject: "Return to the selected Project",
  createProject: "Create Project…",
  creatingProject: "Creating Project…",
  openProject: "Open Project…",
  openingProject: "Opening Project…",
  cancel: "Cancel",
  close: "Close",
} as const;

const simplifiedChineseCopy = {
  returnToSelectedProject: "返回所选项目",
  createProject: "创建项目…",
  creatingProject: "正在创建项目…",
  openProject: "打开项目…",
  openingProject: "正在打开项目…",
  cancel: "取消",
  close: "关闭",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

export const commonCopy = createLocaleCopy(copyLocaleDictionaries);
