import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/**
 * Inspector copy: session panel headings, project facts and the
 * requested/effective profile phrasing.
 */
const englishCopy = {
  inspectorCopy: {
    railTitle: "Session",
    hideInspector: "Hide inspector",
    emptyCopy:
      "No Session selected. Once one exists, its latest recorded turn profile appears here. When it is resumable, Model and Work Intensity can be chosen for the next turn; provider, Exec and Access stay fixed.",
    projectSection: "Project",
    nameLabel: "Name",
    registeredLabel: "Registered",
    accessLabel: "Access",
    fullAccessTrusted: "Full access · trusted",
    trustNote:
      "Choosing a directory trusts it for Full access. Only its basename is rendered.",
    profileSection: "Profile",
    recordedQualifier: "Recorded",
    endpointLabel: "Endpoint",
    modelLabel: "Model",
    notRecorded: "Not recorded",
    modesSection: "Modes",
    independentQualifier: "Independent",
    executionLabel: "Execution",
    effectiveSection: "Effective",
    postTurnQualifier: "Post-turn",
    stateSection: "State",
    statusLabel: "Status",
    turnsLabel: "Turns",
    eventsLabel: "Events",
    resumableLabel: "Resumable",
    yesValue: "Yes",
    noValue: "No",
    contextLabel: "Context",
    independenceNote:
      "Execution Mode and Access Mode are chosen separately from each other and from the model and intensity. Neither is downgraded silently.",
    unobservedValue: "Not observed",
    pendingObservationValue: "Pending observation",
  },
  ordinalPositionCopy: (current: string, total: string): string =>
    `${current} of ${total}`,
  endpointProfileCopy: (
    runtimeFamilyLabel: string,
    endpointLabel: string | undefined,
  ): string =>
    runtimeFamilyLabel +
    (endpointLabel === undefined ? "" : " · " + endpointLabel),
  matchesRequestedCopy: (label: string): string =>
    `${label} · matches requested`,
  differsFromRequestedCopy: (label: string): string =>
    `${label} · differs from requested`,
} as const;

const simplifiedChineseCopy = {
  inspectorCopy: {
    railTitle: "会话",
    hideInspector: "隐藏检查器",
    emptyCopy:
      "未选择智能体会话。选择后，这里会显示其最新记录的回合配置。若该会话可继续，你可以为下一个回合选择模型和工作强度；提供方、执行模式和访问模式保持不变。",
    projectSection: "项目",
    nameLabel: "名称",
    registeredLabel: "已注册",
    accessLabel: "访问",
    fullAccessTrusted: "完全访问 · 已信任",
    trustNote: "选择目录即表示信任该目录可进行完全访问。界面只显示其基本名称。",
    profileSection: "配置",
    recordedQualifier: "已记录",
    endpointLabel: "端点",
    modelLabel: "模型",
    notRecorded: "未记录",
    modesSection: "模式",
    independentQualifier: "独立",
    executionLabel: "执行",
    effectiveSection: "实际配置",
    postTurnQualifier: "回合后",
    stateSection: "状态",
    statusLabel: "状态",
    turnsLabel: "回合",
    eventsLabel: "事件",
    resumableLabel: "可继续",
    yesValue: "是",
    noValue: "否",
    contextLabel: "上下文",
    independenceNote:
      "执行模式和访问模式彼此独立选择，也独立于模型和工作强度。两者都不会被静默降级。",
    unobservedValue: "未观测到生效值",
    pendingObservationValue: "生效值待观测",
  },
  ordinalPositionCopy: (current: string, total: string): string =>
    `第 ${current} 个，共 ${total} 个`,
  endpointProfileCopy: (
    runtimeFamilyLabel: string,
    endpointLabel: string | undefined,
  ): string =>
    runtimeFamilyLabel +
    (endpointLabel === undefined ? "" : " · " + endpointLabel),
  matchesRequestedCopy: (label: string): string =>
    `${label} · 与请求一致`,
  differsFromRequestedCopy: (label: string): string =>
    `${label} · 与请求不同`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const inspectorCopy = localizedCopy.inspectorCopy;

export function ordinalPositionCopy(current: string, total: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).ordinalPositionCopy(
    current,
    total,
  );
}

export function endpointProfileCopy(
  runtimeFamilyLabel: string,
  endpointLabel: string | undefined,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).endpointProfileCopy(
    runtimeFamilyLabel,
    endpointLabel,
  );
}

export function matchesRequestedCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).matchesRequestedCopy(label);
}

export function differsFromRequestedCopy(label: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).differsFromRequestedCopy(
    label,
  );
}
