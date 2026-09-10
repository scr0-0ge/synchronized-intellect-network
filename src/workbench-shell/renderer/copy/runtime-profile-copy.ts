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
      // Ticket 25 facade: the family carries the brand ("Codex ·
      // Subscription"); the label is the short segment name.
      endpointLabel: "Subscription",
    },
    claude: {
      runtimeFamilyLabel: "Claude",
      endpointLabel: "Subscription",
    },
    glm: {
      runtimeFamilyLabel: "GLM",
      endpointLabel: "GLM Coding Plan",
    },
    kimi: {
      runtimeFamilyLabel: "Kimi",
      endpointLabel: "Code",
    },
    deepseek: {
      runtimeFamilyLabel: "DeepSeek",
      endpointLabel: "DeepSeek API",
    },
    kimiPlatform: {
      runtimeFamilyLabel: "Kimi",
      endpointLabel: "Platform",
    },
    claudeApi: {
      runtimeFamilyLabel: "Claude",
      endpointLabel: "API",
    },
    codexApi: {
      runtimeFamilyLabel: "Codex",
      endpointLabel: "API",
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
  /**
   * Ticket 20: the official-provider-flow sentence above is true only where a
   * real login action exists (the subscription faces). Every API-key face
   * carries this sentence instead, so the copy and the available action can
   * never disagree.
   */
  apiKeyAuthenticationDetail:
    "Add this endpoint's API key on its settings card.",
  /** Ticket 20/25 facades: the single family entry when neither backend is usable. */
  kimiFacadeUnconfiguredDetail:
    "No Kimi key is saved. Add the Kimi Code or Kimi Platform API key on the Kimi card in Settings.",
  claudeFacadeUnconfiguredDetail:
    "Claude has no signed-in subscription and no saved API key. Sign in, or add a Claude API key, on the Claude card in Settings.",
  codexFacadeUnconfiguredDetail:
    "Codex has no signed-in subscription and no saved API key. Sign in, or add a Codex API key, on the Codex card in Settings.",
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
      endpointLabel: "订阅",
    },
    claude: {
      runtimeFamilyLabel: "Claude",
      endpointLabel: "订阅",
    },
    glm: {
      runtimeFamilyLabel: "GLM",
      endpointLabel: "GLM Coding Plan",
    },
    kimi: {
      runtimeFamilyLabel: "Kimi",
      endpointLabel: "Code",
    },
    deepseek: {
      runtimeFamilyLabel: "DeepSeek",
      endpointLabel: "DeepSeek API",
    },
    kimiPlatform: {
      runtimeFamilyLabel: "Kimi",
      endpointLabel: "平台",
    },
    claudeApi: {
      runtimeFamilyLabel: "Claude",
      endpointLabel: "API",
    },
    codexApi: {
      runtimeFamilyLabel: "Codex",
      endpointLabel: "API",
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
  apiKeyAuthenticationDetail: "在此端点的设置卡片上添加 API 密钥。",
  kimiFacadeUnconfiguredDetail:
    "尚未保存 Kimi 密钥。请在设置的 Kimi 卡片上添加 Kimi Code 或 Kimi 平台的 API 密钥。",
  claudeFacadeUnconfiguredDetail:
    "Claude 尚未登录订阅，也未保存 API 密钥。请在设置的 Claude 卡片上完成订阅登录，或添加 Claude API 密钥。",
  codexFacadeUnconfiguredDetail:
    "Codex 尚未登录订阅，也未保存 API 密钥。请在设置的 Codex 卡片上完成订阅登录，或添加 Codex API 密钥。",
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

/**
 * The authentication-required detail for API-key faces (no login action
 * exists there, so the official-provider-flow sentence must not appear).
 */
export function endpointApiKeyAuthenticationDetail(): string {
  return localizedCopy.apiKeyAuthenticationDetail;
}

/** The merged Kimi entry's detail when neither Kimi key is present. */
export function kimiFacadeUnconfiguredDetail(): string {
  return localizedCopy.kimiFacadeUnconfiguredDetail;
}

/** The merged Claude entry's detail when neither backend is usable. */
export function claudeFacadeUnconfiguredDetail(): string {
  return localizedCopy.claudeFacadeUnconfiguredDetail;
}

/** The merged Codex entry's detail when neither backend is usable. */
export function codexFacadeUnconfiguredDetail(): string {
  return localizedCopy.codexFacadeUnconfiguredDetail;
}

/** One family facade's unconfigured detail (total over the families). */
export function endpointFamilyUnconfiguredDetail(
  family: "claude" | "codex" | "kimi",
): string {
  switch (family) {
    case "claude":
      return claudeFacadeUnconfiguredDetail();
    case "codex":
      return codexFacadeUnconfiguredDetail();
    default:
      return kimiFacadeUnconfiguredDetail();
  }
}

export type EndpointRuntimeFamilyLabelText =
  | (typeof endpointIdentityCopy)["codex"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["claude"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["glm"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["kimi"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["deepseek"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["kimiPlatform"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["claudeApi"]["runtimeFamilyLabel"]
  | (typeof endpointIdentityCopy)["codexApi"]["runtimeFamilyLabel"];

export type EndpointLabelText =
  | (typeof endpointIdentityCopy)["codex"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["claude"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["glm"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["kimi"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["deepseek"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["kimiPlatform"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["claudeApi"]["endpointLabel"]
  | (typeof endpointIdentityCopy)["codexApi"]["endpointLabel"];

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
