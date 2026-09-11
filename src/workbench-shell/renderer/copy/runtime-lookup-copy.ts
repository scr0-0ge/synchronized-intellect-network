import type { RuntimeLookupLocation } from "../../../agent-runtime/runtime-lookup-surface.ts";
import type {
  WorkbenchRuntimeExecutableRejection,
  WorkbenchRuntimeInstallStep,
} from "../../contract.ts";
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
    savedSentence: "Saved. Press Check all to start the runtime.",
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
  runtimeInstallCopy: {
    installActionCodex: "Install Codex CLI for me (private copy)",
    installActionClaude: "Install Claude Code CLI for me (private copy)",
    installingSentence: (elapsedSeconds: number): string =>
      `Downloading and installing. ${elapsedSeconds}s elapsed.`,
    installedSentence: (version: string): string =>
      `Installed ${version} as a private copy. The path above now points at it.`,
    installedPathSentence:
      "A private copy is installed; the path above points at it.",
    unavailableSentence: "The installer could not be reached. Try again.",
    stepSentences: {
      "node-not-located":
        "No node.exe was found. Start the Workbench through start.bat, which provides one.",
      "npm-not-located": "The node.exe that was found has no npm beside it.",
      "install-failed":
        "npm could not download or install the package. On a mainland-China network, set NPM_CONFIG_REGISTRY to a mirror such as https://registry.npmmirror.com before starting the Workbench, then try again.",
      "not-discovered":
        "The package was installed, but the Workbench could not locate it afterwards.",
    },
    manualSentence: "Or install it yourself from the address under “Get it”.",
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
    savedSentence: "已保存。点“全部检查”即可启动运行时。",
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
  runtimeInstallCopy: {
    installActionCodex: "为我安装 Codex CLI（私有副本）",
    installActionClaude: "为我安装 Claude Code CLI（私有副本）",
    installingSentence: (elapsedSeconds: number): string =>
      `正在下载安装，已用时 ${elapsedSeconds} 秒。`,
    installedSentence: (version: string): string =>
      `已安装 ${version}（私有副本），上方路径已指向它。`,
    installedPathSentence: "已装有私有副本，上方路径指向它。",
    unavailableSentence: "无法联系安装器。请重试。",
    stepSentences: {
      "node-not-located":
        "未找到 node.exe。请通过 start.bat 启动 Workbench，它会提供一份。",
      "npm-not-located": "找到的 node.exe 旁边没有 npm。",
      "install-failed":
        "npm 无法下载或安装该包。中国大陆网络可在启动 Workbench 前把 NPM_CONFIG_REGISTRY 设为镜像，例如 https://registry.npmmirror.com，然后重试。",
      "not-discovered": "包已安装，但 Workbench 随后没能找到它。",
    },
    manualSentence: "或者按上方“获取方式”的地址自行安装。",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const runtimeLookupCopy = localizedCopy.runtimeLookupCopy;
export const runtimeExecutableCopy = localizedCopy.runtimeExecutableCopy;
export const runtimeInstallCopy = localizedCopy.runtimeInstallCopy;

export function runtimeInstallStepCopy(step: WorkbenchRuntimeInstallStep): string {
  return currentLocaleCopy(copyLocaleDictionaries).runtimeInstallCopy
    .stepSentences[step];
}

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
