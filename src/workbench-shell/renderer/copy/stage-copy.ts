import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/** Stage copy for fresh-start, empty-Project and unavailable-runtime states. */
const englishCopy = {
  stageCopy: {
    srNewAgentSessionMode: "New Agent Session mode",
    newAgentSessionTitle: "New Agent Session",
    archivedBadge: "Archived",
    showSessionPanel: "Show Session panel",
    awaitingTitle: "Starting Agent Session",
    awaitingBody:
      "Your request was accepted. Waiting for the new Session to appear in this Project.",
    freshStartBody:
      "Start with a fresh conversation. Choose its profile below, then send the first instruction.",
    returnToSelectedSession: "Return to selected Session",
    emptyProjectTitle: "Start the first Agent Session",
    emptyProjectBody:
      "This Project is registered and empty. Whatever you send first starts a new Agent Session on the endpoint you pick below.",
    waysToStart: "Ways to start",
    suggestions: [
      "Explain how this Project is laid out",
      "Find and fix the failing tests",
      "Review my uncommitted changes",
    ],
    noRuntimeTitle: "No Agent Runtime is available",
    endpointStatusListLabel: "Endpoint status",
    openSettings: "Open Settings",
    runtimeBoundary:
      "Sign-in happens in each provider's own app. The Workbench never asks for a password, API key, or token, never reads a credential file, and never stores credentials.",
  },
  endpointStatusDescriptionCopy: (
    endpointLabel: string,
    detail: string,
  ): string => `${endpointLabel}. ${detail}`,
} as const;

const simplifiedChineseCopy = {
  stageCopy: {
    srNewAgentSessionMode: "新建智能体会话模式",
    newAgentSessionTitle: "新建智能体会话",
    archivedBadge: "已归档",
    showSessionPanel: "显示会话面板",
    awaitingTitle: "正在启动智能体会话",
    awaitingBody: "你的请求已被接受。正在等待新会话出现在此项目中。",
    freshStartBody: "开始一段新对话。请在下方选择其配置，然后发送第一条指令。",
    returnToSelectedSession: "返回所选会话",
    emptyProjectTitle: "启动第一个智能体会话",
    emptyProjectBody:
      "此项目已注册且为空。你发送的第一条内容会在下方所选端点上启动新的智能体会话。",
    waysToStart: "可以这样开始",
    suggestions: [
      "说明此项目的结构",
      "查找并修复失败的测试",
      "检查我尚未提交的更改",
    ],
    noRuntimeTitle: "没有可用的智能体运行时",
    endpointStatusListLabel: "端点状态",
    openSettings: "打开设置",
    runtimeBoundary:
      "登录在各提供方自己的应用中完成。Workbench 绝不会索取密码、API 密钥或令牌，也不会读取凭据文件或存储凭据。",
  },
  endpointStatusDescriptionCopy: (
    endpointLabel: string,
    detail: string,
  ): string => `${endpointLabel}。${detail}`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const stageCopy = localizedCopy.stageCopy;

export function endpointStatusDescriptionCopy(
  endpointLabel: string,
  detail: string,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).endpointStatusDescriptionCopy(
    endpointLabel,
    detail,
  );
}
