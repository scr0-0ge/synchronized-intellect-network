import {
  createLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/** Closed Workbench vocabulary that arrives through otherwise dynamic fields. */
const englishCopy = {
  project: {
    liveUnavailable: "Live Project data is unavailable.",
    reloadSelection: "Reload the Project list and choose an available Project.",
    projectUnavailable:
      "This Project is unavailable. Choose another Project or restore its directory.",
    switchUnavailable:
      "The Project could not be opened. Keep the current Project and try again.",
    opened: "Project was opened.",
    openedWithHistory:
      "Project was opened with its existing conversation history.",
    chooseHistory:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    openCancelled: "Open Project was cancelled. Nothing changed.",
    openUnavailable:
      "Open Project could not be completed. Keep the current Project and try again.",
  },
  profile: {
    unavailable:
      "Codex Session Profile options are unavailable. Keep your draft and try again.",
    continuationUnavailable:
      "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    continuationModelUnavailable:
      "This Session's recorded model is no longer offered by its provider, so the next turn can't be prepared. The Session and its transcript are kept; start a New Agent Session to carry the work on.",
    reloadSelection:
      "Reload Codex Session Profile options and choose a model and Work Intensity.",
    defaultUnavailable:
      "Codex Session Profile default could not be durably saved. Keep your selection and try again.",
    defaultSaved: "Codex Session Profile default was durably saved.",
  },
  submission: {
    invalidInput: "Enter a non-empty instruction of at most 8,000 characters.",
    profileUnavailable:
      "Reload Codex Session Profile options and choose a model and Work Intensity.",
    continuationUnavailable:
      "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    unavailable:
      "Direct input could not be durably accepted. Keep your draft and try again.",
    accepted: "Direct input was durably accepted.",
  },
  interrupt: {
    pending: "Interrupt becomes available when the Runtime turn starts.",
    unsupported: "This Runtime does not support interruption.",
    requestedWaiting:
      "Interrupt requested. Waiting for the Runtime to stop.",
    unavailable: "Interrupt is unavailable for this turn.",
    reload: "Reload the running Agent Session and try again.",
    requested: "Interrupt requested.",
  },
  steer: {
    pending: "Same-turn guidance becomes available when the Runtime turn starts.",
    unsupported:
      "This Runtime does not support same-turn guidance. Your draft stays local.",
    submitting: "Sending guidance to this running turn.",
    unavailable: "Same-turn guidance is unavailable. Your draft stays local.",
    reload: "Reload the running Agent Session and try again.",
    accepted: "Guidance was accepted into the running turn.",
  },
  authentication: {
    logoutRequested: "The Workbench asked the provider CLI to log out.",
    logoutNotRequested:
      "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
    logoutPartiallyCompleted:
      "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
    loginRequested: "The Workbench asked the provider CLI to log in.",
    loginNotRequested: "The Workbench could not ask the provider CLI to log in.",
    loginPartiallyCompleted:
      "The Workbench asked the provider CLI to log in but could not record the sign-in change. Sessions started before this login can no longer be resumed, even where the Workbench still offers to resume them.",
    logoutBlocked: "Log out is blocked.",
  },
  historyProblem: {
    "bridge-closed": "Data recovery was closed. Reopen Settings and try again.",
    busy: "Another data recovery operation is still finishing.",
    cancelled: "The data recovery operation was cancelled before commit.",
    "capture-drift": "The source changed while its recovery copy was being verified.",
    "cleanup-pending": "The recovery copy is safe, but private cleanup is still pending.",
    "export-unavailable": "The recovery copy could not be exported safely.",
    "invalid-request": "The data recovery request was rejected.",
    "library-unavailable": "The Historical Recovery Library is unavailable.",
    "permission-denied": "The recovery source could not be read with current permissions.",
    "quota-exceeded": "The recovery source exceeds the bounded recovery allowance.",
    "source-unavailable": "The recovery source is not available for this action.",
    "stale-capability": "Recovery information changed. Review the refreshed overview.",
    "unsupported-artifact":
      "The exact source copy was preserved, but its metadata cannot be browsed safely.",
    "unsupported-schema": "This historical data format cannot be browsed safely.",
    "verification-failed": "The recovery copy could not be verified.",
  },
  historyState: {
    current: "Current",
    available: "Available",
    empty: "Empty",
    preserved: "Preserved",
    acknowledged: "Acknowledged",
    "cleanup-pending": "Cleanup pending",
    unavailable: "Unavailable",
  },
  historyStatus: {
    accepted: "accepted",
    "in-flight": "in-flight",
    completed: "completed",
    failed: "failed",
    "recovery-required": "recovery-required",
  },
  timelineToken: {
    "user-message": "user-message",
    "session-started": "session-started",
    "turn-started": "turn-started",
    "item-started": "item-started",
    "item-completed": "item-completed",
    "agent-message": "agent-message",
    "turn-completed": "turn-completed",
    "turn-interrupted": "turn-interrupted",
    failed: "failed",
    completed: "completed",
    interrupted: "interrupted",
  },
  observedDifferentValue: "Observed different value",
  historyLibrary: "Historical Recovery Library",
  currentStoreCopy: (ordinal: number): string => `Current store ${ordinal}`,
  historicalStoreCopy: (ordinal: number): string => `Historical store ${ordinal}`,
  recoveryCopy: (ordinal: number): string => `Recovery ${ordinal}`,
  projectCopy: (ordinal: number): string => `Project ${ordinal}`,
  sessionCopy: (ordinal: number): string => `Session ${ordinal}`,
  turnCopy: (ordinal: number): string => `Turn ${ordinal}`,
  recoveryExportCopy: (ordinal: number): string => `Recovery export ${ordinal}`,
} as const;

const simplifiedChineseCopy = {
  project: {
    liveUnavailable: "实时项目数据不可用。",
    reloadSelection: "请重新加载项目列表并选择可用项目。",
    projectUnavailable: "此项目不可用。请选择其他项目，或恢复其目录。",
    switchUnavailable: "无法打开该项目。请保留当前项目并重试。",
    opened: "项目已打开。",
    openedWithHistory: "项目已打开，并已加载现有对话历史。",
    chooseHistory: "请选择此项目应显示的现有对话历史。尚未进行任何更改。",
    openCancelled: "已取消打开项目。未做任何更改。",
    openUnavailable: "无法完成项目打开。请保留当前项目并重试。",
  },
  profile: {
    unavailable: "Codex 会话配置选项不可用。请保留草稿并重试。",
    continuationUnavailable: "无法继续此智能体会话。请保留草稿并选择可恢复的会话。",
    continuationModelUnavailable:
      "此会话记录的模型已不再由其提供方提供，因此无法准备下一个回合。此会话及其对话记录都会保留；请新建智能体会话以继续这项工作。",
    reloadSelection: "请重新加载 Codex 会话配置选项，并选择模型和工作强度。",
    defaultUnavailable: "无法持久保存 Codex 会话配置默认值。请保留当前选择并重试。",
    defaultSaved: "已持久保存 Codex 会话配置默认值。",
  },
  submission: {
    invalidInput: "请输入长度不超过 8,000 个字符的非空指令。",
    profileUnavailable: "请重新加载 Codex 会话配置选项，并选择模型和工作强度。",
    continuationUnavailable: "无法继续此智能体会话。请保留草稿并选择可恢复的会话。",
    unavailable: "无法持久接受直接输入。请保留草稿并重试。",
    accepted: "已持久接受直接输入。",
  },
  interrupt: {
    pending: "运行时回合开始后即可中断。",
    unsupported: "此运行时不支持中断。",
    requestedWaiting: "已请求中断。正在等待运行时停止。",
    unavailable: "此回合无法中断。",
    reload: "请重新加载正在运行的智能体会话并重试。",
    requested: "已请求中断。",
  },
  steer: {
    pending: "运行时回合开始后即可进行同回合引导。",
    unsupported: "此运行时不支持同回合引导。你的草稿保留在本地。",
    submitting: "正在向此运行中回合发送引导。",
    unavailable: "同回合引导不可用。你的草稿保留在本地。",
    reload: "请重新加载正在运行的智能体会话并重试。",
    accepted: "引导已被当前运行中回合接受。",
  },
  authentication: {
    logoutRequested: "Workbench 已要求提供方 CLI 退出登录。",
    logoutNotRequested: "Workbench 无法要求提供方 CLI 退出登录。未做任何更改，每个会话的可恢复性保持不变。",
    logoutPartiallyCompleted: "Workbench 已要求提供方 CLI 退出登录，但无法记录这次退出。在这次退出前启动的会话已无法恢复，即使 Workbench 仍显示恢复选项。",
    loginRequested: "Workbench 已要求提供方 CLI 登录。",
    loginNotRequested: "Workbench 无法要求提供方 CLI 登录。",
    loginPartiallyCompleted: "Workbench 已要求提供方 CLI 登录，但无法记录登录状态变化。在这次登录前启动的会话已无法恢复，即使 Workbench 仍显示恢复选项。",
    logoutBlocked: "退出登录已被阻止。",
  },
  historyProblem: {
    "bridge-closed": "数据恢复已关闭。请重新打开设置并重试。",
    busy: "另一项数据恢复操作仍在完成中。",
    cancelled: "数据恢复操作已在提交前取消。",
    "capture-drift": "验证恢复副本时，源数据发生了变化。",
    "cleanup-pending": "恢复副本已安全保存，但私有清理仍在等待。",
    "export-unavailable": "无法安全导出恢复副本。",
    "invalid-request": "数据恢复请求已被拒绝。",
    "library-unavailable": "历史恢复库不可用。",
    "permission-denied": "当前权限无法读取恢复源。",
    "quota-exceeded": "恢复源超出了受限的恢复额度。",
    "source-unavailable": "此操作无法使用该恢复源。",
    "stale-capability": "恢复信息已变化。请检查刷新后的概览。",
    "unsupported-artifact": "已保留精确源副本，但无法安全浏览其元数据。",
    "unsupported-schema": "无法安全浏览此历史数据格式。",
    "verification-failed": "无法验证恢复副本。",
  },
  historyState: {
    current: "当前",
    available: "可用",
    empty: "空",
    preserved: "已保留",
    acknowledged: "已确认",
    "cleanup-pending": "等待清理",
    unavailable: "不可用",
  },
  historyStatus: {
    accepted: "已接受",
    "in-flight": "运行中",
    completed: "已完成",
    failed: "已失败",
    "recovery-required": "需要恢复",
  },
  timelineToken: {
    "user-message": "用户消息",
    "session-started": "会话已开始",
    "turn-started": "回合已开始",
    "item-started": "项目已开始",
    "item-completed": "项目已完成",
    "agent-message": "智能体消息",
    "turn-completed": "回合已完成",
    "turn-interrupted": "回合已中断",
    failed: "已失败",
    completed: "已完成",
    interrupted: "已中断",
  },
  observedDifferentValue: "观察到不同的值",
  historyLibrary: "历史恢复库",
  currentStoreCopy: (ordinal: number): string => `当前存储 ${ordinal}`,
  historicalStoreCopy: (ordinal: number): string => `历史存储 ${ordinal}`,
  recoveryCopy: (ordinal: number): string => `恢复 ${ordinal}`,
  projectCopy: (ordinal: number): string => `项目 ${ordinal}`,
  sessionCopy: (ordinal: number): string => `会话 ${ordinal}`,
  turnCopy: (ordinal: number): string => `回合 ${ordinal}`,
  recoveryExportCopy: (ordinal: number): string => `恢复导出 ${ordinal}`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

export const dynamicCopy = createLocaleCopy(copyLocaleDictionaries);
