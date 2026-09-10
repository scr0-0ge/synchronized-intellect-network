import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

/** Composer-domain copy, including every interpolated sentence. */
const englishCopy = {
  composerControlCopy: {
    model: "Model",
    workIntensity: "Work Intensity",
    exec: "Exec",
    access: "Access",
    emDash: "—",
    dotSeparator: " · ",
    emDashSpaced: " — ",
  },
  targetBarCopy: {
    starting: "Starting",
    running: "Running",
    continues: "Continues",
    starts: "Starts",
    newAgentSession: "New Agent Session",
    runningNote:
      "the composer stays available here; Stop interrupts only this turn.",
    continueNote:
      "choose Model and Work Intensity for the next turn; provider, Exec and Access stay fixed.",
    startNote: "choose an endpoint, model and Work Intensity below.",
  },
  profileChipCopy: {
    chooseEndpoint: "Choose endpoint",
    notSelected: "Not selected",
    lockedRunningTitle:
      "Provider and endpoint are fixed for the running turn",
    lockedSessionTitle:
      "Provider and endpoint are fixed for this Agent Session",
    savingDefault: "Saving default…",
    useAsDefault: "Use as default",
    defaultIntensityLabel: "Default",
  },
  endpointControlNameCopy: (label: string | undefined): string =>
    label === undefined ? "Endpoint: Choose endpoint" : `Endpoint: ${label}`,
  modelControlNameCopy: (label: string | undefined): string =>
    label === undefined ? "Model: Not selected" : `Model: ${label}`,
  intensityControlNameCopy: (
    control: string,
    presentation: string,
  ): string => `${control}: ${presentation}`,
  lockedEndpointAriaCopy: (
    runtimeFamilyLabel: string,
    endpointLabel: string | null,
  ): string =>
    `Provider and endpoint: ${runtimeFamilyLabel}${
      endpointLabel === null ? "" : ` · ${endpointLabel}`
    }. Fixed.`,
  pickerCopy: {
    endpointHeading: "Endpoint",
    modelHeading: "Model",
    catalogsNotRead: "Endpoint catalogs have not been read yet.",
    readingCatalogs: "Reading endpoint catalogs…",
    boundaryNote: "Each runtime is inspected in its own boundary.",
    modelOptionsLabel: "Model options",
    modelCatalogNote:
      "Model names shown here are the public catalog labels currently available at the renderer boundary.",
    endpointOptionsLabel: "Endpoint options",
    selectableNote:
      "Only endpoints with a Catalog ready status can be selected.",
    workIntensityOptionsLabel: "Work Intensity options",
    defaultRow: "Default",
    noIntensitySelected: "No Work Intensity selected",
    optionsRetainWording:
      "Options retain the runtime’s own ordered wording.",
    fallbackHeadingBold: "Work Intensity",
    fallbackHeadingRest:
      " is the Workbench’s own heading; the runtime supplied no control label.",
    noLevelsNote:
      "This model reports no intensity levels, so there is nothing to choose. That is the catalog as given, not a failure.",
  },
  profilePopoverTitleCopy: (
    kind: "endpoint" | "model" | "intensity",
  ): string => {
    switch (kind) {
      case "endpoint":
        return "Choose Agent Runtime endpoint";
      case "model":
        return "Choose model";
      case "intensity":
        return "Choose Work Intensity";
    }
  },
  composerActionsCopy: {
    accepting: "Accepting…",
    send: "Send",
    start: "Start",
    guide: "Guide",
    stop: "Stop",
    ctrlEnter: "Ctrl ↵",
    escKey: "Esc",
    ctrlN: "Ctrl N",
    newAgentSession: "New Agent Session",
    preservedDraftAria: "Preserved local draft",
  },
  draftPreservedCountCopy: (count: number): string =>
    `Draft preserved · ${count} characters`,
  unavailableComposerCopy: {
    pausedKicker: "Paused",
    pausedBody:
      "Your draft is kept. It will send once an endpoint is available.",
    /* The sentence above is the specified wording for the paused composer, and it is
       TRUE in the state that specification depicts: beside a textarea already holding a
       draft. On empty entry it would promise to keep and send something that does not
       exist. That state is not depicted anywhere, so the variant below was ADDED rather
       than the specified sentence changed — the two states get two sentences. */
    pausedBodyNoDraft:
      "No Agent Runtime is available. Composing resumes once one is ready.",
    noEndpointChip: "No endpoint available",
  },
  interruptCopy: {
    requestedWaiting:
      "Interrupt requested. Waiting for the Runtime to stop.",
    unavailableTurn: "Interrupt is unavailable for this turn.",
    stopRunningTurn: "Stop this running turn",
    becomesAvailableWhenRunning:
      "Interrupt becomes available when the Runtime turn starts.",
    interruptThisTurn: "Interrupt this running turn",
    runningPlaceholder: "The current turn is running.",
    stopFootFeedback:
      "Stop interrupts only the current turn. This Agent Session remains intact.",
  },
  steerCopy: {
    sending: "Sending guidance to this running turn.",
    availableTitle: "Guide this running turn",
    pending: "Same-turn guidance becomes available when the Runtime turn starts.",
    unsupported:
      "This Runtime does not support same-turn guidance. Your draft stays local.",
    unavailable:
      "Same-turn guidance is unavailable. Your draft stays local.",
    reload: "Reload the running Agent Session and try again.",
    availablePlaceholder: "Add guidance to the running turn…",
    localDraftPlaceholder:
      "Keep a local draft; this Runtime cannot accept same-turn guidance.",
    availableFoot:
      "Guide adds this draft to the current turn. Stop interrupts only this turn.",
    localDraftFoot:
      "This draft stays local. Stop interrupts only the current turn.",
  },
  composerFeedbackCopy: {
    suggestionRequiresEmptyDraft:
      "Clear the current draft before choosing a suggested follow-up.",
    loadingContinuationCatalog:
      "Loading the current catalog for this Session’s fixed provider…",
    endpointsReadOnOpen:
      "Endpoints are read when you open the picker. Nothing runs before that.",
    nextTurnModesFixed:
      "Model and Work Intensity apply to the next turn. Provider, Exec and Access stay fixed.",
    selectionsStayLocal: "Selections stay local until the Session starts.",
    continuationFoot:
      "The next reply uses the selected Model and Work Intensity. Provider, Exec and Access stay fixed for this Session.",
    startFoot:
      "Your draft stays local until the Session is durably accepted.",
    executionRemainsSingleAgent: "Execution remains Single agent.",
    footRequiresSelection: "New Sessions require a current selection.",
    footStartsFreshProfile: "New Agent Sessions use a fresh profile selection.",
  },
  automaticContinuationCopy: {
    label: "Automatic continuation",
    hint:
      "Repeat one instruction automatically. Use the two lines below; 2 is the total number of turns, including the first (choose 1–10).",
    syntaxCommand: "/auto-continue 2",
    syntaxInstruction: "Do the next verified step.",
    firstLineError:
      "Automatic continuation wasn't sent: the first line needs one space after /auto-continue, then a step count. Use these two lines:",
    invalidStepCountError:
      "Automatic continuation wasn't sent: the step count must be a whole number from 1 to 10, with no leading zero. Use these two lines:",
    maximumStepsError: (steps: string): string =>
      `Automatic continuation wasn't sent: ${steps} exceeds the maximum of 10 steps, including the first turn. Use these two lines:`,
    nextLineError:
      "Automatic continuation wasn't sent: put the instruction on the line after the step count. Use these two lines:",
    instructionError:
      "Automatic continuation wasn't sent: make the instruction after the newline non-empty. Use these two lines:",
  },
  selectedSessionSummaryCopy: (summary: string): string =>
    `Selected Session: ${summary}`,
  blockedComposerCopy: {
    waitingForNew: "Waiting for the new Agent Session",
    archivedTitle: "Archived Agent Session",
    outcomeUnknown: "Outcome unknown",
    stillActive: "This Agent Session is still active",
    cantContinue: "This Session can't be continued",
    waitingBody:
      "The input was accepted; waiting for the Session to appear in the selected Project.",
    archivedBody:
      "Its transcript and identity are preserved. Restore it from Archived in the Project rail before continuing it.",
    recoveryBody:
      "Accepted work lost contact with its runtime. Check the Project before starting replacement work.",
    inFlightBody:
      "Wait for the current work to settle, or start a separate Agent Session.",
    replacementBody:
      "Start a new Agent Session to carry on. Its endpoint, model and Work Intensity remain an explicit catalog-backed choice.",
    /* F211. One sentence per refusing term, keyed by
       `WorkbenchReplacementSessionRefusal`. The sentence this replaced named a
       cause the predicate does not test — "the Workbench is still settling
       another action" — and the owner read it as saying a running Session blocks
       a new one. It does not, and no sentence here may suggest it: not one term
       of that predicate observes a turn in flight. */
    exitUnavailableReason: {
      "project-view-failed":
        "New Agent Session needs a loaded Project view, and this one failed to load. Reload the Project, then try again.",
      "project-switch-pending":
        "The Workbench is switching to another Project. New Agent Session comes back as soon as that switch lands.",
      "project-open-pending":
        "A Project is being opened. New Agent Session comes back as soon as that finishes.",
      "project-open-recovery-required":
        "Opening a Project needs attention before anything else can start. Deal with that first, then try again.",
      "project-has-no-commands":
        "This Project holds no commands, and a new Agent Session starts from one.",
      "new-session-already-starting":
        "A new Agent Session is already being started here. Finish it or return from it, then this becomes available again.",
      "message-awaiting-acceptance":
        "A message you just sent is still being accepted. That takes a moment; New Agent Session comes back straight after.",
      "catalog-loading":
        "The endpoint and model catalog is still loading. A new Agent Session needs it to make an explicit choice from.",
      "default-preference-saving":
        "Your default profile is being saved. New Agent Session comes back as soon as that write finishes.",
      "no-selection":
        "New Agent Session starts from the selected Session. Select one in the Project rail first.",
      "selection-not-in-project":
        "The selected Session is no longer in this Project. Select one from the Project rail, then try again.",
    },
    recoveryBlockHeading: "Outcome unknown",
    recoveryBlockBody:
      "The command was durably accepted, then contact was lost. Check the Project before retrying.",
  },
  noSessionAttachedCopy:
    "No Agent Session was durably attached to this command.",
  directInputCopy: {
    label: "Direct input",
    hint: "Starts a new Agent Session · Ctrl/⌘ + Enter",
    placeholder: "Describe the task. Ctrl+Enter to start the Session.",
    submit: "Start Agent Session",
    pending: "Waiting for durable acceptance…",
  },
  continuationInputCopy: {
    label: "Follow-up input",
    hint: "Model and Work Intensity apply to the next turn; provider, Exec and Access stay fixed · Ctrl/⌘ + Enter",
    placeholder: "Reply to this Agent Session…",
    submit: "Continue Agent Session",
    pending: "Waiting for durable acceptance…",
  },
  unavailableInputCopy: {
    label: "Direct input unavailable",
    hint: "This selection cannot be continued safely. Choose New Agent Session to start fresh.",
    placeholder:
      "Keep a local draft, then choose New Agent Session to start fresh…",
    submit: "Continuation unavailable",
    pending: "Waiting for durable acceptance…",
  },
  unavailableProjectInputCopy: {
    label: "Project input unavailable",
    hint: "Choose an available registered Project or restore this Project's directory.",
    placeholder:
      "Project input remains unavailable until the Project is restored…",
    submit: "Project unavailable",
    pending: "Waiting for durable acceptance…",
  },
  acceptedSessionUnavailableCopy:
    "New Agent Session input was durably accepted, but no resumable Session became available. Review the selected live status.",
  acceptedSubmissionFeedbackCopy:
    "New Agent Session input was durably accepted. Runtime completion is shown in its live status.",
  replacementProfileUnavailableCopy:
    "Exact prefill from this Session’s recorded profile is unavailable in the current catalog. Choose a Session Profile manually.",
  runtimeNotLocatedCopy:
    "The Workbench looked for the runtimes it knows about and found neither of them installed and signed in on this machine. Sessions can't start until at least one is ready.",
  profileFeedbackCopy: {
    loadingOptions: "Loading Agent Runtime Session Profile options…",
    recordedSelected: "Recorded Session Profile selected.",
    continuationSelected: "Latest turn profile selected for the next turn.",
    desiredSelected: "Desired Session Profile selected.",
    chooseModelAndIntensity: "Choose a model and Work Intensity.",
    chooseEndpoint: "Choose an Agent Runtime Endpoint.",
    chooseModel: "Choose a model.",
    chooseSupportedIntensity: "Choose a supported Work Intensity.",
    selectionReady: "Session Profile selection is ready.",
    savingDefault: "Saving Session Profile default…",
  },
} as const;

const simplifiedChineseCopy = {
  composerControlCopy: {
    model: "模型",
    workIntensity: "工作强度",
    exec: "执行",
    access: "访问",
    emDash: "—",
    dotSeparator: " · ",
    emDashSpaced: " — ",
  },
  targetBarCopy: {
    starting: "正在启动",
    running: "运行中",
    continues: "继续",
    starts: "启动",
    newAgentSession: "新建智能体会话",
    runningNote: "输入区仍可使用；“停止”只会中断当前回合。",
    continueNote:
      "为下一个回合选择模型和工作强度；提供方、执行模式和访问模式保持不变。",
    startNote: "在下方选择端点、模型和工作强度。",
  },
  profileChipCopy: {
    chooseEndpoint: "选择端点",
    notSelected: "未选择",
    lockedRunningTitle: "提供方和端点在运行中的回合内固定不变",
    lockedSessionTitle: "提供方和端点在此智能体会话内固定不变",
    savingDefault: "正在保存默认值…",
    useAsDefault: "设为默认",
    defaultIntensityLabel: "默认",
  },
  endpointControlNameCopy: (label: string | undefined): string =>
    label === undefined ? "端点：选择端点" : `端点：${label}`,
  modelControlNameCopy: (label: string | undefined): string =>
    label === undefined ? "模型：未选择" : `模型：${label}`,
  intensityControlNameCopy: (
    control: string,
    presentation: string,
  ): string => `${control}：${presentation}`,
  lockedEndpointAriaCopy: (
    runtimeFamilyLabel: string,
    endpointLabel: string | null,
  ): string =>
    `提供方和端点：${runtimeFamilyLabel}${
      endpointLabel === null ? "" : ` · ${endpointLabel}`
    }。已固定。`,
  pickerCopy: {
    endpointHeading: "端点",
    modelHeading: "模型",
    catalogsNotRead: "尚未读取端点目录。",
    readingCatalogs: "正在读取端点目录…",
    boundaryNote: "每个运行时都在各自的边界内检查。",
    modelOptionsLabel: "模型选项",
    modelCatalogNote:
      "此处显示的模型名称，是渲染器边界当前可用的公开目录标签。",
    endpointOptionsLabel: "端点选项",
    selectableNote: "只能选择状态为“目录就绪”的端点。",
    workIntensityOptionsLabel: "工作强度选项",
    defaultRow: "默认",
    noIntensitySelected: "未选择工作强度",
    optionsRetainWording: "选项保留运行时自己的顺序和措辞。",
    fallbackHeadingBold: "工作强度",
    fallbackHeadingRest: " 是 Workbench 自有标题；运行时未提供控件标签。",
    noLevelsNote:
      "此模型未报告任何强度级别，因此没有可选项。这是目录提供的原始状态，并非故障。",
  },
  profilePopoverTitleCopy: (
    kind: "endpoint" | "model" | "intensity",
  ): string => {
    switch (kind) {
      case "endpoint":
        return "选择智能体运行时端点";
      case "model":
        return "选择模型";
      case "intensity":
        return "选择工作强度";
    }
  },
  composerActionsCopy: {
    accepting: "正在接受…",
    send: "发送",
    start: "启动",
    guide: "引导",
    stop: "停止",
    ctrlEnter: "Ctrl ↵",
    escKey: "Esc",
    ctrlN: "Ctrl N",
    newAgentSession: "新建智能体会话",
    preservedDraftAria: "已保留的本地草稿",
  },
  draftPreservedCountCopy: (count: number): string =>
    `草稿已保留 · ${count} 个字符`,
  unavailableComposerCopy: {
    pausedKicker: "已暂停",
    pausedBody: "你的草稿已保留。端点可用后即可发送。",
    pausedBodyNoDraft: "当前没有可用的智能体运行时。有可用的运行时后即可继续输入。",
    noEndpointChip: "没有可用端点",
  },
  interruptCopy: {
    requestedWaiting: "已请求中断。正在等待运行时停止。",
    unavailableTurn: "此回合无法中断。",
    stopRunningTurn: "停止此运行中回合",
    becomesAvailableWhenRunning: "运行时回合开始后即可中断。",
    interruptThisTurn: "中断此运行中回合",
    runningPlaceholder: "当前回合正在运行。",
    stopFootFeedback: "“停止”只会中断当前回合。此智能体会话保持完整。",
  },
  steerCopy: {
    sending: "正在向此运行中回合发送引导。",
    availableTitle: "引导此运行中回合",
    pending: "运行时回合开始后即可进行同回合引导。",
    unsupported: "此运行时不支持同回合引导。你的草稿保留在本地。",
    unavailable: "同回合引导不可用。你的草稿保留在本地。",
    reload: "请重新加载正在运行的智能体会话并重试。",
    availablePlaceholder: "为运行中回合添加引导…",
    localDraftPlaceholder: "保留本地草稿；此运行时无法接受同回合引导。",
    availableFoot: "“引导”会把此草稿加入当前回合；“停止”只会中断当前回合。",
    localDraftFoot: "此草稿保留在本地；“停止”只会中断当前回合。",
  },
  composerFeedbackCopy: {
    suggestionRequiresEmptyDraft: "请先清空当前草稿，再选择追问建议。",
    loadingContinuationCatalog: "正在加载此会话固定提供方的当前目录…",
    endpointsReadOnOpen: "打开选择器时才会读取端点，在此之前不会运行任何内容。",
    nextTurnModesFixed:
      "模型和工作强度用于下一个回合。提供方、执行模式和访问模式保持不变。",
    selectionsStayLocal: "会话启动前，所选内容只保留在本地。",
    continuationFoot:
      "下一次回复使用所选模型和工作强度。此会话的提供方、执行模式和访问模式保持不变。",
    startFoot: "会话被持久化接受前，你的草稿只保留在本地。",
    executionRemainsSingleAgent: "执行模式保持为单智能体。",
    footRequiresSelection: "新建会话需要当前选择。",
    footStartsFreshProfile: "新建智能体会话会使用重新选择的配置。",
  },
  automaticContinuationCopy: {
    label: "自动续办",
    hint: "重复执行一条指令。按下面两行输入；2 是总回合数（含首回合，可选 1–10）。",
    syntaxCommand: "/auto-continue 2",
    syntaxInstruction: "完成下一个已验证的步骤。",
    firstLineError:
      "自动续办未发送：第一行中 /auto-continue 后需要一个空格，随后填写步数。请使用这两行：",
    invalidStepCountError:
      "自动续办未发送：步数必须是 1 到 10 的整数，且不能以 0 开头。请使用这两行：",
    maximumStepsError: (steps: string): string =>
      `自动续办未发送：${steps} 超过最多 10 步（含首回合）。请使用这两行：`,
    nextLineError: "自动续办未发送：请在步数后的下一行填写指令。请使用这两行：",
    instructionError: "自动续办未发送：换行后的指令不能为空。请使用这两行：",
  },
  selectedSessionSummaryCopy: (summary: string): string =>
    `所选会话：${summary}`,
  blockedComposerCopy: {
    waitingForNew: "正在等待新的智能体会话",
    archivedTitle: "已归档的智能体会话",
    outcomeUnknown: "结果未知",
    stillActive: "此智能体会话仍处于活动状态",
    cantContinue: "无法继续此会话",
    waitingBody: "输入已被接受；正在等待会话出现在所选项目中。",
    archivedBody:
      "其对话记录和身份已保留。继续前，请从项目侧栏的“已归档”中恢复它。",
    recoveryBody: "已接受的工作与运行时失去联系。开始替代工作前，请先检查项目。",
    inFlightBody: "请等待当前工作结束，或另行启动一个智能体会话。",
    replacementBody:
      "新建智能体会话以继续。其端点、模型和工作强度仍须从目录中明确选择。",
    exitUnavailableReason: {
      "project-view-failed":
        "新建智能体会话需要项目视图，而此视图加载失败了。请重新加载项目后再试。",
      "project-switch-pending":
        "正在切换到另一个项目。切换完成后即可新建智能体会话。",
      "project-open-pending": "正在打开项目。打开完成后即可新建智能体会话。",
      "project-open-recovery-required":
        "打开项目的过程需要先处理，之后才能开始其他事情。处理完再试。",
      "project-has-no-commands":
        "此项目中还没有任何命令，而新建智能体会话需要从某个命令开始。",
      "new-session-already-starting":
        "这里已经在新建一个智能体会话了。先完成它或退出，之后此操作会重新可用。",
      "message-awaiting-acceptance":
        "你刚发出的消息还在等待被接受。稍等片刻，随后即可新建智能体会话。",
      "catalog-loading":
        "端点和模型目录还在加载。新建智能体会话需要从中做出明确选择。",
      "default-preference-saving":
        "正在保存你的默认配置。保存完成后即可新建智能体会话。",
      "no-selection":
        "新建智能体会话要从所选会话开始。请先在项目侧栏中选择一个。",
      "selection-not-in-project":
        "所选会话已不在此项目中。请从项目侧栏重新选择一个，然后再试。",
    },
    recoveryBlockHeading: "结果未知",
    recoveryBlockBody: "命令已被持久化接受，但随后失去联系。重试前请先检查项目。",
  },
  noSessionAttachedCopy: "此命令未持久化关联任何智能体会话。",
  directInputCopy: {
    label: "直接输入",
    hint: "启动新的智能体会话 · Ctrl/⌘ + Enter",
    placeholder: "描述任务。按 Ctrl+Enter 启动会话。",
    submit: "启动智能体会话",
    pending: "正在等待持久化接受…",
  },
  continuationInputCopy: {
    label: "跟进输入",
    hint:
      "模型和工作强度用于下一个回合；提供方、执行模式和访问模式保持不变 · Ctrl/⌘ + Enter",
    placeholder: "回复此智能体会话…",
    submit: "继续智能体会话",
    pending: "正在等待持久化接受…",
  },
  unavailableInputCopy: {
    label: "直接输入不可用",
    hint: "无法安全继续当前选择。请选择“新建智能体会话”重新开始。",
    placeholder: "保留本地草稿，然后选择“新建智能体会话”重新开始…",
    submit: "无法继续",
    pending: "正在等待持久化接受…",
  },
  unavailableProjectInputCopy: {
    label: "项目输入不可用",
    hint: "请选择可用的已注册项目，或恢复此项目的目录。",
    placeholder: "项目恢复前，项目输入保持不可用…",
    submit: "项目不可用",
    pending: "正在等待持久化接受…",
  },
  acceptedSessionUnavailableCopy:
    "新建智能体会话的输入已被持久化接受，但没有可继续的会话可用。请检查所选实时状态。",
  acceptedSubmissionFeedbackCopy:
    "新建智能体会话的输入已被持久化接受。运行时完成情况会显示在其实时状态中。",
  replacementProfileUnavailableCopy:
    "当前目录无法按此会话记录的配置精确预填。请手动选择会话配置。",
  runtimeNotLocatedCopy:
    "Workbench 已查找其支持的运行时，但在此设备上未找到任何已安装且已登录的运行时。至少一个运行时就绪后才能启动会话。",
  profileFeedbackCopy: {
    loadingOptions: "正在加载智能体运行时会话配置选项…",
    recordedSelected: "已选择记录的会话配置。",
    continuationSelected: "已为下一个回合选择最新回合配置。",
    desiredSelected: "已选择所需会话配置。",
    chooseModelAndIntensity: "请选择模型和工作强度。",
    chooseEndpoint: "请选择智能体运行时端点。",
    chooseModel: "请选择模型。",
    chooseSupportedIntensity: "请选择支持的工作强度。",
    selectionReady: "会话配置选择已就绪。",
    savingDefault: "正在保存会话配置默认值…",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const composerControlCopy = localizedCopy.composerControlCopy;
export const targetBarCopy = localizedCopy.targetBarCopy;
export const profileChipCopy = localizedCopy.profileChipCopy;

export function endpointControlNameCopy(label: string | undefined): string {
  return currentLocaleCopy(copyLocaleDictionaries).endpointControlNameCopy(label);
}

export function modelControlNameCopy(label: string | undefined): string {
  return currentLocaleCopy(copyLocaleDictionaries).modelControlNameCopy(label);
}

export function intensityControlNameCopy(
  control: string,
  presentation: string,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).intensityControlNameCopy(
    control,
    presentation,
  );
}

export function lockedEndpointAriaCopy(
  runtimeFamilyLabel: string,
  endpointLabel: string | null,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).lockedEndpointAriaCopy(
    runtimeFamilyLabel,
    endpointLabel,
  );
}

export const pickerCopy = localizedCopy.pickerCopy;

export function profilePopoverTitleCopy(
  kind: "endpoint" | "model" | "intensity",
): string {
  return currentLocaleCopy(copyLocaleDictionaries).profilePopoverTitleCopy(kind);
}

export const composerActionsCopy = localizedCopy.composerActionsCopy;

export function draftPreservedCountCopy(count: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).draftPreservedCountCopy(count);
}

export const unavailableComposerCopy = localizedCopy.unavailableComposerCopy;
export const interruptCopy = localizedCopy.interruptCopy;
export const steerCopy = localizedCopy.steerCopy;
export const composerFeedbackCopy = localizedCopy.composerFeedbackCopy;
export const automaticContinuationCopy = localizedCopy.automaticContinuationCopy;

export function selectedSessionSummaryCopy(summary: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).selectedSessionSummaryCopy(
    summary,
  );
}

export const blockedComposerCopy = localizedCopy.blockedComposerCopy;

/** The refusing term's own sentence. */
export type BlockedComposerExitReason =
  keyof typeof englishCopy.blockedComposerCopy.exitUnavailableReason;

/* Typed by the dictionary's own keys rather than by the view model's union, so
   this module keeps its one-way dependency on `locale.ts` alone. The two are
   welded at the call site in `composer.tsx`, which passes a
   `WorkbenchReplacementSessionRefusal` here: a term the copy has no sentence for
   fails to compile, and a sentence for a term that no longer exists is caught by
   `blocked-composer-reason-fidelity.test.ts`. */
export function exitUnavailableReasonCopy(
  reason: BlockedComposerExitReason,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).blockedComposerCopy
    .exitUnavailableReason[reason];
}

export let noSessionAttachedCopy: string = englishCopy.noSessionAttachedCopy;
export const directInputCopy = localizedCopy.directInputCopy;
export const continuationInputCopy = localizedCopy.continuationInputCopy;
export const unavailableInputCopy = localizedCopy.unavailableInputCopy;
export const unavailableProjectInputCopy =
  localizedCopy.unavailableProjectInputCopy;
export let acceptedSessionUnavailableCopy: string =
  englishCopy.acceptedSessionUnavailableCopy;
export let acceptedSubmissionFeedbackCopy: string =
  englishCopy.acceptedSubmissionFeedbackCopy;
export let replacementProfileUnavailableCopy: string =
  englishCopy.replacementProfileUnavailableCopy;
export let runtimeNotLocatedCopy: string = englishCopy.runtimeNotLocatedCopy;

subscribeLocale((nextLocale) => {
  const copy = copyLocaleDictionaries[nextLocale];
  noSessionAttachedCopy = copy.noSessionAttachedCopy;
  acceptedSessionUnavailableCopy = copy.acceptedSessionUnavailableCopy;
  acceptedSubmissionFeedbackCopy = copy.acceptedSubmissionFeedbackCopy;
  replacementProfileUnavailableCopy = copy.replacementProfileUnavailableCopy;
  runtimeNotLocatedCopy = copy.runtimeNotLocatedCopy;
});

export const profileFeedbackCopy = localizedCopy.profileFeedbackCopy;
