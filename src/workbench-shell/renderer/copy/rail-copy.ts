import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

interface SessionRowAriaCopyInput {
  readonly label: string;
  readonly family: string;
  readonly model: string;
  readonly status: string;
  readonly archived: boolean;
}

/** Project rail copy and Project acquisition feedback. */
const englishCopy = {
  railCopy: {
    actionsTriggerLabel: "Create or open a Project",
    actionsDialogTitle: "Project actions",
    popoverFoot:
      "Choosing a directory trusts that Project for the existing Full access mode. Full paths stay private.",
    navAria: "Projects and Agent Sessions",
    projectsTitle: "Projects",
    collapsedAvailable: "Opening this Project loads its Sessions.",
    collapsedUnavailable: "This registered Project is unavailable.",
    collapseThisTitle: "Collapse this Project's Sessions",
    expandThisTitle: "Expand this Project's Sessions",
    switchProjectTitle: "Switch to this Project",
    cachedProjectReadOnlyNote:
      "Cached view — read-only. Switch to this Project to select or rename a Session.",
    sessionsNotLoadedNote:
      "Sessions are not loaded in this run. Switch to this Project to load them.",
    cachedSessionReadOnlyTitle:
      "Cached view — read-only. Switch to this Project to select or rename this Session.",
    clearDraftBeforeSwitch: "Clear the local draft before switching Projects.",
    pendingActionBeforeSwitch:
      "Finish the pending action before switching Projects.",
    openDotTitle: "Open Project",
    closedState: "closed",
    expandedState: "expanded",
    unavailableState: "unavailable",
    activeCountSuffix: " active Agent Sessions",
    countNotLoaded: "Session count not loaded",
    historiesBlockedTitle:
      "Finish the pending action before reviewing this Project's histories.",
    historiesTitle: "Other conversation histories for this Project",
    removeFromWorkbench: "Remove Project from Workbench",
    clearDraftBeforeRemoval:
      "Clear the local draft before removing this Project.",
    pendingActionBeforeRemoval:
      "Finish the pending action before removing this Project.",
    runtimeUnavailableTitle: "No runtime endpoint is available",
    newSessionHere: "New Agent Session here",
    openProjectFirst: "Open this Project first",
    noActiveWithArchived:
      "No active Agent Sessions. Restore one from Archived below, or start a new Session.",
    noActiveWithoutArchived: "No Agent Sessions in this Project yet.",
    archivedRemainAvailable: "Archived transcripts remain available.",
    firstMessageStartsOne: "The first message starts one.",
    noneCanStart: "No Agent Sessions.",
    noneCanStartReason: "None can start until a runtime is available.",
    showFewer: "Show fewer",
    footNewSessionLabel: "New Session",
    footNewSessionAria: "New Agent Session (Ctrl+N)",
    ctrlN: "Ctrl N",
    settingsLabel: "Settings",
    renameHintTitle: "Double-click or press F2 to rename Agent Session",
    archivedSuffix: ", archived",
    rowSeparator: ", ",
    modelNotRecorded: "Model not recorded",
    saveRename: "Save",
    deleteSessionTitle: "Delete Agent Session",
  },
  newSessionRailLabel: "New Session",
  newSessionRailAccessibleLabel: "New Agent Session (Ctrl+N)",
  collapseSessionsAriaCopy: (label: string): string =>
    `Collapse ${label} Agent Sessions`,
  expandSessionsAriaCopy: (label: string): string =>
    `Expand ${label} Agent Sessions`,
  unselectedProjectAriaCopy: (
    label: string,
    ordinal: string,
    state: string,
  ): string => `${label}, Project ${ordinal}, ${state}`,
  activeSessionsCountCopy: (count: string): string =>
    `${count} active Agent Sessions`,
  historiesAriaCopy: (label: string): string =>
    `Other conversation histories for ${label}`,
  removeProjectAriaCopy: (label: string): string =>
    `Remove ${label} from Workbench`,
  newSessionHereAriaCopy: (label: string): string =>
    `New Agent Session in ${label}`,
  switchProjectAriaCopy: (label: string): string => `Switch to ${label}`,
  showMoreCopy: (count: number): string => `Show ${count} more`,
  archivedGroupCopy: (count: number): string => `Archived (${count})`,
  sessionRenameErrorCopy: (maxCodePoints: number): string =>
    `Enter a non-empty name of at most ${maxCodePoints} characters without control characters.`,
  deleteSessionAriaCopy: (label: string): string => `Delete ${label}`,
  newNameForCopy: (label: string): string => `New name for ${label}`,
  sessionRowAriaCopy: (parts: SessionRowAriaCopyInput): string =>
    parts.label +
    ", " +
    parts.family +
    ", " +
    parts.model +
    ", " +
    parts.status +
    (parts.archived ? ", archived" : ""),
  projectAcquisitionCopy: {
    chooseCreateLocation: "Choose a location for one new empty Project…",
    chooseOpenDirectory: "Choose one existing Project directory…",
    created: "Project was created.",
    opened: "Project was opened.",
    viewArrivedFinishingCreate:
      "Project view arrived. Finishing Create Project…",
    viewArrivedFinishingOpen: "Project view arrived. Finishing Open Project…",
    recoveryStillRequired:
      "Recovery is still required. Use Open Project… to recover the created Project.",
    openedWaitingLiveView: "Project was opened. Waiting for its live view…",
    createCancelled: "Create Project was cancelled. Nothing changed.",
    createUnavailable:
      "Create Project could not be completed. Keep the current Project and try again.",
    createdRecoveryRequired:
      "The Project directory may have been created but could not be safely completed. Use Open Project… to recover it.",
    createdWaitingLiveView: "Project was created. Waiting for its live view…",
  },
  openingProjectFeedbackCopy: (label: string): string => `Opening ${label}…`,
  railActionCopy: {
    createProject: "Create Project…",
    creatingProject: "Creating Project…",
    openProject: "Open Project…",
    openingProject: "Opening Project…",
  },
} as const;

const simplifiedChineseCopy = {
  railCopy: {
    actionsTriggerLabel: "创建或打开项目",
    actionsDialogTitle: "项目操作",
    popoverFoot:
      "选择目录即表示信任该项目可使用现有的完全访问模式。完整路径始终保密。",
    navAria: "项目和智能体会话",
    projectsTitle: "项目",
    collapsedAvailable: "打开此项目会加载其智能体会话。",
    collapsedUnavailable: "此已注册项目不可用。",
    collapseThisTitle: "折叠此项目的智能体会话",
    expandThisTitle: "展开此项目的智能体会话",
    switchProjectTitle: "切换到此项目",
    cachedProjectReadOnlyNote:
      "缓存视图——只读。切换到此项目后可选择或重命名会话。",
    sessionsNotLoadedNote:
      "本次运行尚未加载会话。切换到此项目即可加载。",
    cachedSessionReadOnlyTitle:
      "缓存视图——只读。切换到此项目后可选择或重命名此会话。",
    clearDraftBeforeSwitch: "切换项目前请先清除本地草稿。",
    pendingActionBeforeSwitch: "切换项目前请先完成待处理操作。",
    openDotTitle: "打开项目",
    closedState: "已关闭",
    expandedState: "已展开",
    unavailableState: "不可用",
    activeCountSuffix: " 个活动智能体会话",
    countNotLoaded: "尚未加载会话数量",
    historiesBlockedTitle: "检查此项目的历史前，请先完成待处理操作。",
    historiesTitle: "此项目的其他对话历史",
    removeFromWorkbench: "从 Workbench 中移除项目",
    clearDraftBeforeRemoval: "移除此项目前请先清除本地草稿。",
    pendingActionBeforeRemoval: "移除此项目前请先完成待处理操作。",
    runtimeUnavailableTitle: "没有可用的运行时端点",
    newSessionHere: "在此新建智能体会话",
    openProjectFirst: "请先打开此项目",
    noActiveWithArchived:
      "没有活动的智能体会话。请从下方“已归档”中恢复一个，或新建会话。",
    noActiveWithoutArchived: "此项目还没有智能体会话。",
    archivedRemainAvailable: "已归档的对话记录仍可访问。",
    firstMessageStartsOne: "发送第一条消息即可启动会话。",
    noneCanStart: "没有智能体会话。",
    noneCanStartReason: "运行时可用后才能启动会话。",
    showFewer: "收起",
    footNewSessionLabel: "新建会话",
    footNewSessionAria: "新建智能体会话 (Ctrl+N)",
    ctrlN: "Ctrl N",
    settingsLabel: "设置",
    renameHintTitle: "双击或按 F2 重命名智能体会话",
    archivedSuffix: "，已归档",
    rowSeparator: "，",
    modelNotRecorded: "未记录模型",
    saveRename: "保存",
    deleteSessionTitle: "删除智能体会话",
  },
  newSessionRailLabel: "新建会话",
  newSessionRailAccessibleLabel: "新建智能体会话 (Ctrl+N)",
  collapseSessionsAriaCopy: (label: string): string =>
    `折叠 ${label} 的智能体会话`,
  expandSessionsAriaCopy: (label: string): string =>
    `展开 ${label} 的智能体会话`,
  unselectedProjectAriaCopy: (
    label: string,
    ordinal: string,
    state: string,
  ): string => `${label}，项目 ${ordinal}，${state}`,
  activeSessionsCountCopy: (count: string): string =>
    `${count} 个活动智能体会话`,
  historiesAriaCopy: (label: string): string => `${label} 的其他对话历史`,
  removeProjectAriaCopy: (label: string): string =>
    `从 Workbench 中移除 ${label}`,
  newSessionHereAriaCopy: (label: string): string =>
    `在 ${label} 中新建智能体会话`,
  switchProjectAriaCopy: (label: string): string => `切换到 ${label}`,
  showMoreCopy: (count: number): string => `再显示 ${count} 个`,
  archivedGroupCopy: (count: number): string => `已归档 (${count})`,
  sessionRenameErrorCopy: (maxCodePoints: number): string =>
    `请输入不含控制字符、长度不超过 ${maxCodePoints} 个字符的非空名称。`,
  deleteSessionAriaCopy: (label: string): string => `删除 ${label}`,
  newNameForCopy: (label: string): string => `${label} 的新名称`,
  sessionRowAriaCopy: (parts: SessionRowAriaCopyInput): string =>
    parts.label +
    "，" +
    parts.family +
    "，" +
    parts.model +
    "，" +
    parts.status +
    (parts.archived ? "，已归档" : ""),
  projectAcquisitionCopy: {
    chooseCreateLocation: "为一个新的空项目选择位置…",
    chooseOpenDirectory: "选择一个现有项目目录…",
    created: "项目已创建。",
    opened: "项目已打开。",
    viewArrivedFinishingCreate: "项目视图已就绪。正在完成“创建项目”…",
    viewArrivedFinishingOpen: "项目视图已就绪。正在完成“打开项目”…",
    recoveryStillRequired: "仍需恢复。请使用“打开项目…”恢复已创建的项目。",
    openedWaitingLiveView: "项目已打开。正在等待实时视图…",
    createCancelled: "已取消创建项目。未做任何更改。",
    createUnavailable: "无法完成项目创建。请保留当前项目并重试。",
    createdRecoveryRequired:
      "项目目录可能已创建，但操作未能安全完成。请使用“打开项目…”进行恢复。",
    createdWaitingLiveView: "项目已创建。正在等待实时视图…",
  },
  openingProjectFeedbackCopy: (label: string): string => `正在打开 ${label}…`,
  railActionCopy: {
    createProject: "创建项目…",
    creatingProject: "正在创建项目…",
    openProject: "打开项目…",
    openingProject: "正在打开项目…",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const railCopy = localizedCopy.railCopy;

export let newSessionRailLabel: string = englishCopy.newSessionRailLabel;
export let newSessionRailAccessibleLabel: string =
  englishCopy.newSessionRailAccessibleLabel;

subscribeLocale((nextLocale) => {
  newSessionRailLabel = copyLocaleDictionaries[nextLocale].newSessionRailLabel;
  newSessionRailAccessibleLabel =
    copyLocaleDictionaries[nextLocale].newSessionRailAccessibleLabel;
});

export function collapseSessionsAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).collapseSessionsAriaCopy(label);
}

export function expandSessionsAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).expandSessionsAriaCopy(label);
}

export function unselectedProjectAriaCopy(
  label: string,
  ordinal: string,
  state: string,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).unselectedProjectAriaCopy(
    label,
    ordinal,
    state,
  );
}

export function activeSessionsCountCopy(count: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).activeSessionsCountCopy(count);
}

export function historiesAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).historiesAriaCopy(label);
}

export function removeProjectAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).removeProjectAriaCopy(label);
}

export function newSessionHereAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).newSessionHereAriaCopy(label);
}

export function switchProjectAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).switchProjectAriaCopy(label);
}

export function showMoreCopy(count: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).showMoreCopy(count);
}

export function archivedGroupCopy(count: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).archivedGroupCopy(count);
}

export function sessionRenameErrorCopy(maxCodePoints: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).sessionRenameErrorCopy(
    maxCodePoints,
  );
}

export function deleteSessionAriaCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).deleteSessionAriaCopy(label);
}

export function newNameForCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).newNameForCopy(label);
}

export function sessionRowAriaCopy(parts: SessionRowAriaCopyInput): string {
  return currentLocaleCopy(copyLocaleDictionaries).sessionRowAriaCopy(parts);
}

export const projectAcquisitionCopy = localizedCopy.projectAcquisitionCopy;

export function openingProjectFeedbackCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).openingProjectFeedbackCopy(
    label,
  );
}

export const railActionCopy = localizedCopy.railActionCopy;
