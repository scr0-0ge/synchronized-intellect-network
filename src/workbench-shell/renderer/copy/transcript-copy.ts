import {
  isWorkbenchRuntimeFailureCategory,
  type WorkbenchCommandView,
  type WorkbenchTurnView,
  type WorkbenchRuntimeFailureCategory,
} from "../../contract.ts";
import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

/** Transcript copy: search, failures, turn headers and profile phrasing. */
const englishCopy = {
  transcriptCopy: {
    emptyTitle: "No durable activity",
    emptyBody: "Choose an Agent Session from the selected Project.",
    searchPlaceholder: "Filter turns…",
    searchAria: "Filter Agent Session timeline",
    noSearchResultsTitle: "No matching turns",
    noSearchResultsBody:
      "Try another search or clear the filter to show every turn.",
    sessionStartedRule: "Session started",
    sessionEndedRule: "Session ended",
    turnNotStarted: "Turn not started",
    failedTitle: "The Agent Session failed",
    failedBody:
      "Unknown failure: no specific runtime failure reason was recorded. Check the endpoint settings and the Project before starting replacement work.",
    interruptedRule: "Turn interrupted",
    interruptedTitle: "The turn was interrupted",
    interruptedBody:
      "The turn stopped at your request. This Agent Session is intact and can continue.",
    outcomeUnknownRule: "Outcome unknown",
    recoveryTitle: "Recovery required",
    recoveryBody:
      "The effect was accepted, then contact was lost. Nothing is asserted about what did or did not happen. Check the Project before starting replacement work.",
    recoveryConfirmed: "This turn's outcome is unknown. CLI resume was confirmed after this turn, independently of its outcome. The previous input was not resent and its success is not established. Check the Project before repeating work.",
    recoveryUnconfirmed: "This turn's outcome is unknown. Resume was not confirmed: ",
    recoveryReason: {
      "runtime-not-located": "the CLI executable could not be found. Check its path in Settings.",
      "binding-drift": "Workbench could not match the resumed Session or profile. Check the CLI Session before continuing.",
      "session-reference-unavailable": "Workbench has no saved CLI Session reference to resume. Check the CLI before starting replacement work.",
      "authentication-changed": "the saved Session's authentication context has changed. Check the selected endpoint and account.",
      "channel-closed": "Workbench closed before it could check resume. This is not a confirmed CLI failure.",
      "resume-timeout": "the CLI resume check did not finish within 8 seconds. This is not proof the CLI Session is lost.",
      "resume-unconfirmed": "no usable resume confirmation was recorded. The cause is unknown; check the CLI Session.",
    },
    noNormalizedEventsTitle: "No normalized events",
    noNormalizedEventsBody:
      "This Agent Session has a recorded profile but no durable timeline events yet.",
    actorUser: "You",
    stateWorking: "working",
    stateInterrupted: "interrupted",
    runtimeWorking: "The Agent Runtime is working",
    reasoning: "Reasoning",
    progressActivity: {
      thinking: "extended thinking in progress",
      tool: "a tool call is running",
      retrying: "retrying the provider request",
      "rate-limited": "provider rate limit reached, waiting",
      status: "runtime status update",
    },
    unknownToolName: "Unknown tool",
    toolParameterTruncated: "(truncated)",
    unknownToolType: (sourceType: string): string =>
      `(unrecognized type: ${sourceType})`,
    fileChangeSummary: (totalFiles: number, details: string): string =>
      `Changed ${totalFiles} ${totalFiles === 1 ? "file" : "files"}: ${details}`,
    fileChangeSeparator: "; ",
    fileChangeLineCounts: (additions: number, deletions: number): string =>
      `+${additions}/-${deletions}`,
    fileChangesOmitted: (count: number): string =>
      `${count} more ${count === 1 ? "file" : "files"} (collapsed)`,
    interruptedBeforeMessage:
      "This turn was interrupted before an agent message was recorded.",
    noAgentMessageRecorded: "No agent message text was recorded for this turn.",
    eventLogAria: "Normalized durable events for turn",
    copyButton: "Copy",
    copyingButton: "Copying…",
    copiedButton: "Copied",
    copyFailedButton: "Copy failed",
    copyCodeAria: "Copy code",
    notRecordedWord: "not recorded",
    longPromptExpand: "Show the full prompt",
    longPromptCollapse: "Collapse the prompt",
    longPromptAria: "Long user prompt, collapsed by default",
  },
  runtimeFailureReasonCopy: {
    "approval-required": "Permission approval is required. Check the runtime permission prompt or permission settings, then explicitly approve before trying again.",
    "authentication-required": "Authentication is required. Open Settings and sign in to the selected subscription endpoint, or check its API key.",
    "catalog-invalid": "The runtime returned an invalid model or capability catalog. Refresh the endpoint catalog in Settings; if it still fails, check the CLI version.",
    "correlation-invalid": "The runtime reply could not be matched to this session or turn. Check the Project for changes before starting a new session.",
    "invalid-input": "The runtime rejected an invalid input or operation. Check the request and selected session settings before trying again.",
    "protocol-invalid": "The runtime returned an unrecognized protocol message. Check the CLI version and the Project before starting a new session.",
    "protocol-rejected": "The runtime refused the request. Check the request, endpoint settings and permissions before trying again.",
    "runtime-shutdown": "The runtime stopped unexpectedly or its shutdown could not be confirmed. Check whether its process is still running before starting more work.",
    "runtime-not-located": "The CLI executable could not be found. Check its path in Settings.",
    "runtime-unavailable": "The runtime is unavailable. Check its CLI executable path and endpoint connection in Settings.",
    "temp-cleanup": "Runtime temporary files could not be cleaned up. Check temporary-directory access and files held open by other processes before trying again.",
    "temp-cleanup-guard": "Temporary-directory cleanup was refused because the path was not an approved cleanup target. Check the runtime temporary-directory configuration; do not delete an unverified directory.",
    "transport-failed": "Communication with the runtime failed. Check the runtime process and connection, then check the Project before trying again.",
    "turn-failed": "The runtime reported that this turn failed, without a more specific reason. Check the endpoint connection and the Project before trying again.",
    "unexpected-server-request": "The runtime requested an interaction this Workbench cannot handle. Check the CLI version or handle the interaction in the native CLI.",
    "unsupported-selection": "The selected model, work intensity or mode is not supported. Refresh the endpoint catalog in Settings and choose a supported configuration.",
  } satisfies Record<WorkbenchRuntimeFailureCategory, string>,
  turnStateCopy: {
    accepted: "accepted",
    "in-flight": "working",
    completed: "completed",
    "quota-paused": "quota exhausted — paused",
    failed: "failed",
    "recovery-required": "outcome unknown",
  },
  transcriptSearchCountCopy: (visible: number, total: number): string =>
    `${visible} of ${total} turns`,
  turnOrdinalCopy: (index: number): string => `Turn ${index}`,
  guidanceTurnOrdinalCopy: (index: number): string => `Guidance · Turn ${index}`,
  eventsDisclosureCopy: (count: number): string =>
    `${count} ${count === 1 ? "event" : "events"}`,
  effectiveNotRecordedCopy: (noun: string): string =>
    `${noun} not recorded`,
  /**
   * Issue #6 case 2: the effective projection's `unknown` arm means "no
   * post-turn observation exists", not "the product lost the selection". The
   * requested value is printed on the same line, so calling it unknown reads
   * as a broken endpoint. A turn that ended without ever reporting says so;
   * one that is still running is simply not there yet.
   */
  effectiveUnobservedCopy: (noun: string): string => `${noun} not observed`,
  effectiveUnobservedRequestedCopy: (
    noun: string,
    requestedLabel: string,
  ): string => `${noun} not observed · requested ${requestedLabel}`,
  effectivePendingObservationCopy: (noun: string): string =>
    `${noun} pending observation`,
  effectivePendingObservationRequestedCopy: (
    noun: string,
    requestedLabel: string,
  ): string => `${noun} pending observation · requested ${requestedLabel}`,
  differsFromRequestedWithFallbackCopy: (
    label: string,
    requestedLabel: string | undefined,
  ): string =>
    `${label} · differs from requested ${requestedLabel ?? "not recorded"}`,
  modelNounCopy: (): string => "Model",
  workIntensityNounCopy: (): string => "Work Intensity",
} as const;

const simplifiedChineseCopy = {
  transcriptCopy: {
    emptyTitle: "暂无持久化活动",
    emptyBody: "请从所选项目中选择一个智能体会话。",
    searchPlaceholder: "筛选回合…",
    searchAria: "筛选智能体会话时间线",
    noSearchResultsTitle: "没有匹配的回合",
    noSearchResultsBody: "请尝试其他搜索词，或清除筛选以显示全部回合。",
    sessionStartedRule: "会话已开始",
    sessionEndedRule: "会话已结束",
    turnNotStarted: "回合未启动",
    failedTitle: "智能体会话失败",
    failedBody:
      "未知失败：未记录具体的运行时失败原因。开始替代工作前，请检查端点设置及项目状态。",
    interruptedRule: "回合已中断",
    interruptedTitle: "回合已中断",
    interruptedBody: "回合已按你的请求停止。此智能体会话保持完整，可以继续。",
    outcomeUnknownRule: "结果未知",
    recoveryTitle: "需要恢复",
    recoveryConfirmed: "这一回合结果未知。该回合后的检查已实测确认 CLI 可恢复，这与回合结果是两回事。没有重发上一条输入，也没有确认它成功。重复工作前请先检查项目。",
    recoveryUnconfirmed: "这一回合结果未知。未能确认恢复：",
    recoveryReason: {
      "runtime-not-located": "未找到 CLI 可执行文件。请在设置中检查路径。",
      "binding-drift": "Workbench 无法匹配恢复的会话或配置。请先检查 CLI 会话。",
      "session-reference-unavailable": "Workbench 没有可用于恢复的 CLI 会话引用。开始替代工作前请先检查 CLI。",
      "authentication-changed": "已保存会话的认证上下文发生变化。请检查所选端点和账号。",
      "channel-closed": "Workbench 在检查恢复能力前已关闭。这并不代表 CLI 已确认失败。",
      "resume-timeout": "CLI 恢复检查在 8 秒内没有完成。这不能证明 CLI 会话已丢失。",
      "resume-unconfirmed": "未记录有效的恢复确认，原因未知。请检查 CLI 会话。",
    },
    recoveryBody:
      "操作已被接受，但随后失去联系。系统不会断言操作是否发生。开始替代工作前，请先检查项目。",
    noNormalizedEventsTitle: "没有标准化事件",
    noNormalizedEventsBody: "此智能体会话已有记录的配置，但还没有持久化时间线事件。",
    actorUser: "你",
    stateWorking: "处理中",
    stateInterrupted: "已中断",
    runtimeWorking: "智能体运行时正在工作",
    reasoning: "思考内容",
    progressActivity: {
      thinking: "正在深度思考",
      tool: "正在调用工具",
      retrying: "正在重试提供方请求",
      "rate-limited": "已到达提供方速率限制，等待中",
      status: "运行时状态更新",
    },
    unknownToolName: "未知工具",
    toolParameterTruncated: "（已截断）",
    unknownToolType: (sourceType: string): string =>
      `（未识别类型：${sourceType}）`,
    fileChangeSummary: (totalFiles: number, details: string): string =>
      `改了 ${totalFiles} 个文件：${details}`,
    fileChangeSeparator: "；",
    fileChangeLineCounts: (additions: number, deletions: number): string =>
      `+${additions}/-${deletions}`,
    fileChangesOmitted: (count: number): string =>
      `另 ${count} 个文件（已折叠）`,
    interruptedBeforeMessage: "此回合在记录智能体消息前已中断。",
    noAgentMessageRecorded: "此回合没有记录智能体消息文本。",
    eventLogAria: "回合的标准化持久化事件",
    copyButton: "复制",
    copyingButton: "正在复制…",
    copiedButton: "已复制",
    copyFailedButton: "复制失败",
    copyCodeAria: "复制代码",
    notRecordedWord: "未记录",
    longPromptExpand: "查看完整 prompt",
    longPromptCollapse: "收起 prompt",
    longPromptAria: "较长的用户 prompt，默认折叠",
  },
  runtimeFailureReasonCopy: {
    "approval-required": "运行时需要权限审批。请检查运行时的权限提示或权限设置，明确批准后再重试。",
    "authentication-required": "认证失败或尚未登录。请到设置中登录所选订阅端点，或检查该端点的 API 密钥。",
    "catalog-invalid": "运行时返回的模型或能力目录无效。请在设置中重新读取端点目录；若仍失败，请检查 CLI 版本。",
    "correlation-invalid": "无法将运行时回复对应到当前会话或回合。开始新会话前，请检查项目中已经发生的改动。",
    "invalid-input": "输入或操作不符合运行时要求。请检查请求内容及所选会话设置后再重试。",
    "protocol-invalid": "运行时返回了无法识别的协议消息。请检查 CLI 版本及项目状态，再开始新会话。",
    "protocol-rejected": "运行时拒绝了请求。请检查请求内容、端点设置及权限后再重试。",
    "runtime-shutdown": "运行时意外停止，或无法确认它已退出。开始新工作前，请检查其进程是否仍在运行。",
    "runtime-not-located": "未找到 CLI 可执行文件。请在设置中检查路径。",
    "runtime-unavailable": "运行时不可用。请在设置中检查 CLI 可执行文件路径及端点连接。",
    "temp-cleanup": "无法清理运行时临时文件。请检查临时目录的访问权限及文件是否被其他进程占用，再重试。",
    "temp-cleanup-guard": "临时目录路径不符合清理范围，清理已被拒绝。请检查运行时临时目录配置，不要删除未经确认的目录。",
    "transport-failed": "与运行时的通信失败。请检查运行时进程和连接，并查看项目状态后再重试。",
    "turn-failed": "运行时报告本回合失败，但未提供更具体的原因。请检查端点连接及项目状态后再重试。",
    "unexpected-server-request": "运行时请求了 Workbench 无法处理的交互。请检查 CLI 版本，或在原生 CLI 中处理该交互。",
    "unsupported-selection": "所选模型、工作强度或模式不受支持。请在设置中重新读取端点目录，选择受支持的配置。",
  } satisfies Record<WorkbenchRuntimeFailureCategory, string>,
  turnStateCopy: {
    accepted: "已接受",
    "in-flight": "处理中",
    completed: "已完成",
    "quota-paused": "额度耗尽 · 已暂停",
    failed: "失败",
    "recovery-required": "结果未知",
  },
  transcriptSearchCountCopy: (visible: number, total: number): string =>
    `显示 ${visible} / ${total} 个回合`,
  turnOrdinalCopy: (index: number): string => `回合 ${index}`,
  guidanceTurnOrdinalCopy: (index: number): string => `引导 · 回合 ${index}`,
  eventsDisclosureCopy: (count: number): string => `${count} 个事件`,
  effectiveNotRecordedCopy: (noun: string): string => `未记录${noun}`,
  effectiveUnobservedCopy: (noun: string): string => `未观测到生效${noun}`,
  effectiveUnobservedRequestedCopy: (
    noun: string,
    requestedLabel: string,
  ): string => `未观测到生效${noun} · 请求值为 ${requestedLabel}`,
  effectivePendingObservationCopy: (noun: string): string =>
    `${noun}生效值待观测`,
  effectivePendingObservationRequestedCopy: (
    noun: string,
    requestedLabel: string,
  ): string => `${noun}生效值待观测 · 请求值为 ${requestedLabel}`,
  differsFromRequestedWithFallbackCopy: (
    label: string,
    requestedLabel: string | undefined,
  ): string =>
    `${label} · 与请求值 ${requestedLabel ?? "未记录"} 不同`,
  modelNounCopy: (): string => "模型",
  workIntensityNounCopy: (): string => "工作强度",
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const transcriptCopy = localizedCopy.transcriptCopy;

export function turnRecoveryBodyCopy(recovery: NonNullable<WorkbenchTurnView["recovery"]>): string {
  const copy = currentLocaleCopy(copyLocaleDictionaries);
  if (recovery.resume === "confirmed") return copy.transcriptCopy.recoveryConfirmed;
  return copy.transcriptCopy.recoveryUnconfirmed + (
    isWorkbenchRuntimeFailureCategory(recovery.reason)
      ? copy.runtimeFailureReasonCopy[recovery.reason]
      : copy.transcriptCopy.recoveryReason[recovery.reason]
  );
}

/** Use only the current turn, never a reason from an earlier failed turn. */
export function transcriptFailureBodyCopy(
  session: NonNullable<WorkbenchCommandView["session"]>,
): string {
  const timeline = session.turns === undefined
    ? session.timeline
    : session.turns.at(-1)?.timeline ?? [];
  const copy = currentLocaleCopy(copyLocaleDictionaries);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if (event.kind === "failed") {
      return isWorkbenchRuntimeFailureCategory(event.category)
        ? copy.runtimeFailureReasonCopy[event.category]
        : copy.transcriptCopy.failedBody;
    }
    // Older payloads lack per-command slices. A new input/start/terminal
    // boundary still prevents an earlier turn's failure from being reused.
    if (event.kind === "user-message" || event.kind === "turn-started" ||
      event.kind === "turn-completed" || event.kind === "turn-interrupted") break;
  }
  return copy.transcriptCopy.failedBody;
}

export const turnStateCopy: Readonly<
  Record<
    "accepted" | "in-flight" | "completed" | "quota-paused" | "failed" | "recovery-required",
    string
  >
> = localizedCopy.turnStateCopy;

export function transcriptSearchCountCopy(
  visible: number,
  total: number,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).transcriptSearchCountCopy(
    visible,
    total,
  );
}

export function turnOrdinalCopy(index: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).turnOrdinalCopy(index);
}

export function guidanceTurnOrdinalCopy(index: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).guidanceTurnOrdinalCopy(index);
}

export function eventsDisclosureCopy(count: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).eventsDisclosureCopy(count);
}

export function effectiveNotRecordedCopy(noun: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).effectiveNotRecordedCopy(noun);
}

export function effectiveUnobservedCopy(noun: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).effectiveUnobservedCopy(noun);
}

export function effectiveUnobservedRequestedCopy(
  noun: string,
  requestedLabel: string,
): string {
  return currentLocaleCopy(
    copyLocaleDictionaries,
  ).effectiveUnobservedRequestedCopy(noun, requestedLabel);
}

export function effectivePendingObservationCopy(noun: string): string {
  return currentLocaleCopy(
    copyLocaleDictionaries,
  ).effectivePendingObservationCopy(noun);
}

export function effectivePendingObservationRequestedCopy(
  noun: string,
  requestedLabel: string,
): string {
  return currentLocaleCopy(
    copyLocaleDictionaries,
  ).effectivePendingObservationRequestedCopy(noun, requestedLabel);
}

export function differsFromRequestedWithFallbackCopy(
  label: string,
  requestedLabel: string | undefined,
): string {
  return currentLocaleCopy(
    copyLocaleDictionaries,
  ).differsFromRequestedWithFallbackCopy(label, requestedLabel);
}

export function modelNounCopy(): string {
  return currentLocaleCopy(copyLocaleDictionaries).modelNounCopy();
}

export function workIntensityNounCopy(): string {
  return currentLocaleCopy(copyLocaleDictionaries).workIntensityNounCopy();
}
