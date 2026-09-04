/**
 * Dialog copy: removal confirmation and Project-histories dialog chrome.
 * Panel content copy itself lives in project-history-copy.
 */
import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

const englishCopy = {
  confirmRemovalKicker: "Confirm removal",
  cancel: "Cancel",
  deleting: "Deleting…",
  removing: "Removing…",
  close: "Close",
} as const;

const simplifiedChineseCopy = {
  confirmRemovalKicker: "确认移除",
  cancel: "取消",
  deleting: "正在删除…",
  removing: "正在移除…",
  close: "关闭",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

export const dialogsCopy = createLocaleCopy(copyLocaleDictionaries);
