import type { WorkbenchRuntimeEndpointDiscoveryCategory } from "../../contract.ts";
import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  type LocalizedShape,
} from "../locale.ts";

export interface RecordedProfileSummaryCopyInput {
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly modelLabel: string;
  readonly workIntensityLabel: string;
}

/** Runtime/profile vocabulary and sanitized endpoint status rows. */
const englishCopy = {
  runtimeProfileCopy: {
    agentRuntimeFallback: "Agent Runtime",
    fixedExecutionModeLabel: "Single agent",
    fixedAccessModeLabel: "Full access",
    workbenchFallbackControlLabel: "Workbench fallback label",
    workbenchFallbackControlLabelTitle:
      "Workbench label. This runtime's catalog supplied no control label of its own.",
    workIntensityNoun: "Work Intensity",
    defaultIntensityLabel: "Default",
  },
  endpointIdentityCopy: {
    codex: {
      runtimeFamilyLabel: "Codex",
      endpointLabel: "Codex desktop",
    },
    claude: {
      runtimeFamilyLabel: "Claude",
      endpointLabel: "Claude Code desktop",
    },
  },
  endpointStatusRowCopy: {
    "catalog-ready": {
      statusLabel: "Catalog ready",
      detail: "A sanitized catalog is available.",
    },
    "runtime-not-located": {
      statusLabel: "Runtime not located",
      detail: "Not found under any name that was checked.",
    },
    "authentication-required": {
      statusLabel: "Authentication required",
      detail: "Sign-in remains in the official provider flow.",
    },
    "inspection-failed": {
      statusLabel: "Inspection failed",
      detail: "No private error detail is exposed.",
    },
    "not-inspected": {
      statusLabel: "Not inspected",
      detail: "No catalog read has completed.",
    },
  },
  contextWindowTitleCopy: (
    remaining: string,
    windowTokens: string,
    usedPercent: number,
  ): string =>
    `Context window · ${remaining} of ${windowTokens} tokens remaining (${usedPercent}% used)`,
  contextWindowAriaCopy: (usedPercent: number): string =>
    `Context window ${usedPercent} percent used`,
  contextUsedTokensCopy: (usedTokens: string): string =>
    `${usedTokens} tokens used`,
  recordedProfileSummaryCopy: (
    profile: RecordedProfileSummaryCopyInput,
  ): string =>
    [
      profile.runtimeFamilyLabel,
      profile.endpointLabel,
      profile.modelLabel,
      profile.workIntensityLabel,
    ].join(" · "),
  profileNotRecordedSummaryCopy: (runtime: string): string =>
    `${runtime} · profile not recorded`,
  prefixedProfileValueCopy: (value: string): string => `· ${value}`,
} as const;

const simplifiedChineseCopy = {
  runtimeProfileCopy: {
    agentRuntimeFallback: "智能体运行时",
    fixedExecutionModeLabel: "单智能体",
    fixedAccessModeLabel: "完全访问",
    workbenchFallbackControlLabel: "Workbench 备用标签",
    workbenchFallbackControlLabelTitle:
      "Workbench 标签。此运行时的目录未提供自己的控件标签。",
    workIntensityNoun: "工作强度",
    defaultIntensityLabel: "默认",
  },
  endpointIdentityCopy: {
    codex: {
      runtimeFamilyLabel: "Codex",
      endpointLabel: "Codex 桌面版",
    },
    claude: {
      runtimeFamilyLabel: "Claude",
      endpointLabel: "Claude Code 桌面版",
    },
  },
  endpointStatusRowCopy: {
    "catalog-ready": {
      statusLabel: "目录就绪",
      detail: "经过净化的目录可用。",
    },
    "runtime-not-located": {
      statusLabel: "未找到运行时",
      detail: "使用检查过的任何名称都未找到。",
    },
    "authentication-required": {
      statusLabel: "需要身份验证",
      detail: "登录仍通过提供方的官方流程完成。",
    },
    "inspection-failed": {
      statusLabel: "检查失败",
      detail: "不会公开私有错误详情。",
    },
    "not-inspected": {
      statusLabel: "尚未检查",
      detail: "尚未完成目录读取。",
    },
  },
  contextWindowTitleCopy: (
    remaining: string,
    windowTokens: string,
    usedPercent: number,
  ): string =>
    `上下文窗口 · 共 ${windowTokens} 个 token，剩余 ${remaining} 个（已用 ${usedPercent}%）`,
  contextWindowAriaCopy: (usedPercent: number): string =>
    `上下文窗口已使用 ${usedPercent}%`,
  contextUsedTokensCopy: (usedTokens: string): string =>
    `已使用 ${usedTokens} 个 token`,
  recordedProfileSummaryCopy: (
    profile: RecordedProfileSummaryCopyInput,
  ): string =>
    [
      profile.runtimeFamilyLabel,
      profile.endpointLabel,
      profile.modelLabel,
      profile.workIntensityLabel,
    ].join(" · "),
  profileNotRecordedSummaryCopy: (runtime: string): string =>
    `${runtime} · 未记录配置`,
  prefixedProfileValueCopy: (value: string): string => `· ${value}`,
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const runtimeProfileCopy = localizedCopy.runtimeProfileCopy;

/** Fixed public identity for each known runtime endpoint. */
export const endpointIdentityCopy = localizedCopy.endpointIdentityCopy;

/** Sanitized per-category status label + detail shown in provider lists. */
export const endpointStatusRowCopy: Readonly<
  Record<
    WorkbenchRuntimeEndpointDiscoveryCategory,
    Readonly<{ statusLabel: string; detail: string }>
  >
> = localizedCopy.endpointStatusRowCopy;

export type EndpointRuntimeFamilyLabelText =
  | (typeof endpointIdentityCopy)["codex"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["claude"]["runtimeFamilyLabel"];

export type EndpointLabelText =
  | (typeof endpointIdentityCopy)["codex"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["claude"]["endpointLabel"];

export type EndpointStatusRowLabelText = (typeof endpointStatusRowCopy)[WorkbenchRuntimeEndpointDiscoveryCategory]["statusLabel"];

export function contextWindowTitleCopy(
  remaining: string,
  windowTokens: string,
  usedPercent: number,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).contextWindowTitleCopy(
    remaining,
    windowTokens,
    usedPercent,
  );
}

export function contextWindowAriaCopy(usedPercent: number): string {
  return currentLocaleCopy(copyLocaleDictionaries).contextWindowAriaCopy(
    usedPercent,
  );
}

export function contextUsedTokensCopy(usedTokens: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).contextUsedTokensCopy(
    usedTokens,
  );
}

export function recordedProfileSummaryCopy(
  profile: RecordedProfileSummaryCopyInput,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).recordedProfileSummaryCopy(
    profile,
  );
}

export function profileNotRecordedSummaryCopy(runtime: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).profileNotRecordedSummaryCopy(
    runtime,
  );
}

export function prefixedProfileValueCopy(value: string): string {
  return currentLocaleCopy(copyLocaleDictionaries).prefixedProfileValueCopy(
    value,
  );
}
