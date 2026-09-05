import type { RuntimeLookupLocation } from "../../../agent-runtime/runtime-lookup-surface.ts";
import type { WorkbenchRuntimeExecutableRejection } from "../../contract.ts";
import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/**
 * The words for "here is what was looked for, and where" -- and for the field
 * that lets a user answer when the lookup was wrong.
 *
 * `start.bat` is the standard being met. When it cannot find pnpm it prints
 * every name and every directory it tried plus where to get the tool; the
 * in-app path printed "No lookup path is exposed." and offered nothing to do
 * about it. The place names below are FIXED TOKENS, never expanded paths: they
 * tell a user exactly where to look without carrying their account name across
 * the IPC boundary, which is the boundary `path-redaction.ts` exists to keep.
 */
const englishCopy = {
  runtimeLookupCopy: {
    lookedForLabel: "Looked for",
    getItLabel: "Get it",
    joinNames: (names: readonly string[]): string => names.join(", "),
    placeSentence: (names: string, place: string): string =>
      `${names} ${place}`,
    locationLabels: {
      path: "on your PATH",
      "npm-global-prefix": "in %APPDATA%\\npm",
      "codex-official-bin": "in %LOCALAPPDATA%\\OpenAI\\Codex\\bin",
      "claude-local-bin": "in %USERPROFILE%\\.local\\bin",
      "claude-managed-root": "in %APPDATA%\\Claude\\claude-code",
    },
  },
  runtimeExecutableCopy: {
    fieldLabel: "Executable path",
    fieldHint:
      "Somewhere else on this machine? Type the full path to the runtime here. The shim an npm install writes works, and so does the program itself.",
    placeholderCodex: "C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd",
    placeholderClaude: "C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd",
    saveAction: "Use this path",
    savingAction: "Checking",
    clearAction: "Clear",
    savedSentence: "Saved. Re-check to start the runtime.",
    clearedSentence: "Cleared. The Workbench will look in the usual places again.",
    unavailableSentence:
      "The executable path could not be saved. Try again.",
    rejectionSentences: {
      "not-absolute":
        "That is not a full path. It has to start with a drive letter, like C:\\.",
      "not-found": "Nothing exists at that path.",
      "not-a-file": "That is a folder, not a program.",
      "unsupported-shape":
        "That file cannot be started. Point at the program itself, or at the shim an npm install wrote.",
      "no-install-beside-it":
        "That shim has no package next to it. Point at the shim inside the folder npm installed into.",
      "no-node-interpreter":
        "That install runs on node, and no node could be found to run it.",
      unusable: "That path cannot be used.",
    },
  },
} as const;

const simplifiedChineseCopy = {
  runtimeLookupCopy: {
    lookedForLabel: "已查找",
    getItLabel: "获取方式",
    joinNames: (names: readonly string[]): string => names.join("、"),
    placeSentence: (names: string, place: string): string =>
      `${place}查找 ${names}`,
    locationLabels: {
      path: "在 PATH 上",
      "npm-global-prefix": "在 %APPDATA%\\npm 中",
      "codex-official-bin": "在 %LOCALAPPDATA%\\OpenAI\\Codex\\bin 中",
      "claude-local-bin": "在 %USERPROFILE%\\.local\\bin 中",
      "claude-managed-root": "在 %APPDATA%\\Claude\\claude-code 中",
    },
  },
  runtimeExecutableCopy: {
    fieldLabel: "可执行文件路径",
    fieldHint:
      "安装在其他位置？在此填写运行时的完整路径。npm 安装生成的 shim 可以，程序本身也可以。",
    placeholderCodex: "C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd",
    placeholderClaude: "C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd",
    saveAction: "使用此路径",
    savingAction: "检查中",
    clearAction: "清除",
    savedSentence: "已保存。重新检查即可启动运行时。",
    clearedSentence: "已清除。Workbench 将重新在常规位置查找。",
    unavailableSentence: "无法保存可执行文件路径。请重试。",
    rejectionSentences: {
      "not-absolute": "这不是完整路径。需要以盘符开头，例如 C:\\。",
      "not-found": "该路径下没有任何文件。",
      "not-a-file": "这是文件夹，不是程序。",
      "unsupported-shape":
        "无法启动该文件。请指向程序本身，或 npm 安装生成的 shim。",
      "no-install-beside-it":
        "该 shim 旁边没有对应的包。请指向 npm 安装目录中的 shim。",
      "no-node-interpreter": "该安装需要 node 运行，但未找到可用的 node。",
      unusable: "无法使用该路径。",
    },
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const runtimeLookupCopy = localizedCopy.runtimeLookupCopy;
export const runtimeExecutableCopy = localizedCopy.runtimeExecutableCopy;

/** Wording for one place a lookup asked, e.g. "codex.exe, codex.cmd on your PATH". */
export function runtimeLookupPlaceCopy(
  names: readonly string[],
  location: RuntimeLookupLocation,
): string {
  const copy = currentLocaleCopy(copyLocaleDictionaries).runtimeLookupCopy;
  return copy.placeSentence(
    copy.joinNames(names),
    copy.locationLabels[location],
  );
}

export function runtimeExecutableRejectionCopy(
  rejection: WorkbenchRuntimeExecutableRejection,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).runtimeExecutableCopy
    .rejectionSentences[rejection];
}
