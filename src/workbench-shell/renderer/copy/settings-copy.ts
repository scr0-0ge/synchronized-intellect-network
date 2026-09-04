import {
  createLocaleCopy,
  currentLocaleCopy,
  defineCopyLocaleDictionaries,
  subscribeLocale,
  type LocalizedShape,
} from "../locale.ts";

/** Settings screen copy: providers, Claude permissions, appearance, language and sign-in. */
const englishCopy = {
  settingsCopy: {
    title: "Settings",
    closeAria: "Close Settings",
    lede: "Inspect the sanitized status reported by existing Agent Runtime endpoints and adjust this Workbench installation’s settings.",
    providersHeading: "Providers",
    readingCatalogs: "Reading catalogs…",
    readCatalogs: "Read catalogs",
    recheckAll: "Re-check all",
    credentialHeading: "The Workbench never handles credentials",
    credentialSentence:
      "This page never asks for a password, API key or token, never reads a credential file, and never stores credentials. None of those controls may be added.",
    catalogAvailableHeading: "Catalog available",
    catalogUnavailableHeading: "Catalog unavailable",
    notCheckedHeading: "Not checked",
    otherProvidersHeading: "Other providers",
    otherProvidersSentence: "No other providers are configured in this build.",
    statusMeaningsHeading: "Status meanings",
    claudePermissionsHeading: "Claude permissions",
    permissionHandlingLabel: "Permission handling",
    permissionHandlingHint:
      "Choose whether new Claude Sessions can use tools without asking or pause for approval when Claude requires it.",
    withoutAskingPermissionOption: "Use tools without asking",
    askWhenNeededPermissionOption: "Ask when needed",
    permissionPersistenceErrorSentence:
      "The change could not be saved. The previously saved choice is still active for new Claude Sessions.",
    permissionLoadErrorSentence:
      "Permission handling could not be loaded. New Claude Sessions may be unavailable until storage can be read.",
    appearanceHeading: "Appearance",
    languageLabel: "Language",
    languageHint: "Choose the language used by Workbench.",
    englishOption: "English",
    simplifiedChineseOption: "简体中文",
    toneLabel: "Tone",
    toneHint: "Use a dark or light Workbench tone.",
    darkOption: "Dark",
    lightOption: "Light",
    crtLabel: "CRT",
    crtHint: "Choose where the CRT treatment appears.",
    offOption: "Off",
    blocksOption: "Blocks",
    screenOption: "Screen",
    fullOption: "Full",
    phosphorLabel: "Phosphor",
    phosphorHint: "Tint machine output independently of CRT.",
    neutralOption: "Neutral",
    greenOption: "Green",
    amberOption: "Amber",
    lightGlowLabel: "Light glow",
    lightGlowHint:
      "Choose how bright and glowy Green and Amber look in Light tone.",
    tierARestrained: "A · Restrained",
    tierBLuminous: "B · Luminous",
    tierCHottest: "C · Hottest",
    persistenceErrorSentence:
      "The current appearance remains active in this window, but this change is not durable. Try another appearance change to retry.",
    statusFactLabel: "Status",
    catalogFactLabel: "Catalog",
    catalogReadyValue: "Available",
    notInspectedValue: "Not inspected",
    catalogUnavailableValue: "Unavailable",
    modelsFactLabel: "Models",
    subscriptionSignIn: "Subscription sign-in",
    confirmationSentence:
      "Recorded conversations stay in the Workbench. Resumable Sessions for this provider will no longer be resumable when this authentication action begins.",
    confirmLogout: "Ask the provider CLI to log out",
    continueWithLogin: "Continue with Login",
  },
  bindingStatusAriaCopy: (
    runtimeFamilyLabel: string,
    stateLabel: string,
  ): string =>
    `${runtimeFamilyLabel} subscription authentication: ${stateLabel}`,
  bindActionAriaCopy: (
    actionLabel: string,
    runtimeFamilyLabel: string,
  ): string =>
    `${actionLabel} ${runtimeFamilyLabel} subscription authentication`,
  authConsequencesCopy: (
    resumableSessionCount: number,
    projectCount: number,
  ): string =>
    `Resumable Sessions: ${resumableSessionCount}; Projects: ${projectCount}`,
  settingsOtherProvidersCopy:
    "No other providers are configured in this build.",
  providerGroupHeadingCopy: {
    catalogAvailable: "Catalog available",
    catalogUnavailable: "Catalog unavailable",
    notChecked: "Not checked",
  },
  settingsTopLevelSectionLabels: [
    "Providers",
    "Claude permissions",
    "Appearance",
  ],
  settingsProviderStatusMeaningsData: [
    {
      category: "catalog-ready",
      label: "Connected",
      detail: "Catalog available.",
    },
    {
      category: "authentication-required",
      label: "Sign-in required",
      detail: "The runtime requires its official sign-in flow.",
    },
    {
      category: "inspection-failed",
      label: "Inspection failed",
      detail: "The catalog could not be read.",
    },
    {
      category: "runtime-not-located",
      label: "Not found",
      detail: "The runtime was not located on this device.",
    },
    {
      category: "not-inspected",
      label: "Not checked",
      detail: "The endpoint has not been inspected yet.",
    },
  ],
  appearancePersistenceLabels: {
    hydrating: "Loading · This user on this device",
    saving: "Saving · This user on this device",
    saved: "Saved · This user on this device",
    error: "Not saved · Current window only",
  },
  subscriptionAuthCopy: {
    boundLabel: "Bound",
    signInRequiredLabel: "Sign-in required",
    unknownLabel: "Unknown",
    boundDetail: "The provider CLI reports a bound subscription sign-in.",
    signInRequiredDetail:
      "The provider CLI reports that subscription sign-in is required.",
    unknownDetail:
      "Subscription sign-in could not be verified. Re-check before taking an authentication action.",
    logoutAction: "Log out",
    loginAction: "Login",
    recheckAction: "Re-check",
    loginBlocked: "Login is blocked.",
    blockerAccepted: "Accepted",
    blockerStarting: "Starting",
    blockerRunning: "Running",
    blockerRecoveryRequired: "Recovery required",
    blockerUnknown: "Unknown",
    inspectingFeedback:
      "Asking the provider CLI to re-check subscription sign-in...",
    preparingLogoutFeedback: "Checking whether Log out can begin...",
    preparingLoginFeedback: "Checking whether Login can begin...",
    actingLogoutFeedback: "Asking the provider CLI to log out...",
    actingLoginFeedback: "Asking the provider CLI to log in...",
  },
} as const;

const simplifiedChineseCopy = {
  settingsCopy: {
    title: "设置",
    closeAria: "关闭设置",
    lede: "查看现有智能体运行时端点报告的净化状态，并调整此 Workbench 安装的设置。",
    providersHeading: "提供方",
    readingCatalogs: "正在读取目录…",
    readCatalogs: "读取目录",
    recheckAll: "全部重新检查",
    credentialHeading: "Workbench 永不处理凭据",
    credentialSentence:
      "此页面绝不会索取密码、API 密钥或令牌，也不会读取凭据文件或存储凭据。不得添加任何此类控件。",
    catalogAvailableHeading: "目录可用",
    catalogUnavailableHeading: "目录不可用",
    notCheckedHeading: "尚未检查",
    otherProvidersHeading: "其他提供方",
    otherProvidersSentence: "此版本未配置其他提供方。",
    statusMeaningsHeading: "状态说明",
    claudePermissionsHeading: "Claude 权限",
    permissionHandlingLabel: "权限确认方式",
    permissionHandlingHint:
      "选择新 Claude 会话可直接使用工具，还是在 Claude 要求时暂停并请求确认。",
    withoutAskingPermissionOption: "直接使用工具",
    askWhenNeededPermissionOption: "需要时询问",
    permissionPersistenceErrorSentence:
      "更改无法保存。之前保存的选项仍会用于新建的 Claude 会话。",
    permissionLoadErrorSentence:
      "无法加载权限确认方式。在能够读取存储前，新建 Claude 会话可能不可用。",
    appearanceHeading: "外观",
    languageLabel: "语言",
    languageHint: "选择 Workbench 使用的界面语言。",
    englishOption: "English",
    simplifiedChineseOption: "简体中文",
    toneLabel: "色调",
    toneHint: "选择 Workbench 的深色或浅色色调。",
    darkOption: "深色",
    lightOption: "浅色",
    crtLabel: "CRT",
    crtHint: "选择 CRT 效果的应用范围。",
    offOption: "关闭",
    blocksOption: "区块",
    screenOption: "屏幕",
    fullOption: "全部",
    phosphorLabel: "荧光色",
    phosphorHint: "为机器输出单独添加色调，不受 CRT 设置影响。",
    neutralOption: "中性",
    greenOption: "绿色",
    amberOption: "琥珀色",
    lightGlowLabel: "浅色光晕",
    lightGlowHint: "选择浅色色调下绿色和琥珀色的亮度与光晕强度。",
    tierARestrained: "A · 克制",
    tierBLuminous: "B · 明亮",
    tierCHottest: "C · 最炽烈",
    persistenceErrorSentence:
      "当前外观仍在此窗口中生效，但此更改尚未持久保存。请尝试其他外观更改以重试。",
    statusFactLabel: "状态",
    catalogFactLabel: "目录",
    catalogReadyValue: "可用",
    notInspectedValue: "尚未检查",
    catalogUnavailableValue: "不可用",
    modelsFactLabel: "模型",
    subscriptionSignIn: "订阅登录",
    confirmationSentence:
      "已记录的对话会保留在 Workbench 中。开始此身份验证操作后，此提供方的可继续会话将无法继续。",
    confirmLogout: "要求提供方 CLI 退出登录",
    continueWithLogin: "继续登录",
  },
  bindingStatusAriaCopy: (
    runtimeFamilyLabel: string,
    stateLabel: string,
  ): string => `${runtimeFamilyLabel} 订阅身份验证：${stateLabel}`,
  bindActionAriaCopy: (
    actionLabel: string,
    runtimeFamilyLabel: string,
  ): string => `${actionLabel} ${runtimeFamilyLabel} 订阅身份验证`,
  authConsequencesCopy: (
    resumableSessionCount: number,
    projectCount: number,
  ): string =>
    `可继续会话：${resumableSessionCount}；项目：${projectCount}`,
  settingsOtherProvidersCopy: "此版本未配置其他提供方。",
  providerGroupHeadingCopy: {
    catalogAvailable: "目录可用",
    catalogUnavailable: "目录不可用",
    notChecked: "尚未检查",
  },
  settingsTopLevelSectionLabels: ["提供方", "Claude 权限", "外观"],
  settingsProviderStatusMeaningsData: [
    {
      category: "catalog-ready",
      label: "已连接",
      detail: "目录可用。",
    },
    {
      category: "authentication-required",
      label: "需要登录",
      detail: "运行时要求使用其官方登录流程。",
    },
    {
      category: "inspection-failed",
      label: "检查失败",
      detail: "无法读取目录。",
    },
    {
      category: "runtime-not-located",
      label: "未找到",
      detail: "在此设备上未找到运行时。",
    },
    {
      category: "not-inspected",
      label: "尚未检查",
      detail: "尚未检查此端点。",
    },
  ],
  appearancePersistenceLabels: {
    hydrating: "正在加载 · 此设备上的当前用户",
    saving: "正在保存 · 此设备上的当前用户",
    saved: "已保存 · 此设备上的当前用户",
    error: "未保存 · 仅当前窗口",
  },
  subscriptionAuthCopy: {
    boundLabel: "已绑定",
    signInRequiredLabel: "需要登录",
    unknownLabel: "未知",
    boundDetail: "提供方 CLI 报告已绑定订阅登录。",
    signInRequiredDetail: "提供方 CLI 报告需要订阅登录。",
    unknownDetail: "无法验证订阅登录。执行身份验证操作前请重新检查。",
    logoutAction: "退出登录",
    loginAction: "登录",
    recheckAction: "重新检查",
    loginBlocked: "登录已被阻止。",
    blockerAccepted: "已接受",
    blockerStarting: "正在启动",
    blockerRunning: "运行中",
    blockerRecoveryRequired: "需要恢复",
    blockerUnknown: "未知",
    inspectingFeedback: "正在要求提供方 CLI 重新检查订阅登录...",
    preparingLogoutFeedback: "正在检查是否可以退出登录...",
    preparingLoginFeedback: "正在检查是否可以登录...",
    actingLogoutFeedback: "正在要求提供方 CLI 退出登录...",
    actingLoginFeedback: "正在要求提供方 CLI 登录...",
  },
} as const satisfies LocalizedShape<typeof englishCopy>;

export const copyLocaleDictionaries = defineCopyLocaleDictionaries(
  englishCopy,
  simplifiedChineseCopy,
);

const localizedCopy = createLocaleCopy(copyLocaleDictionaries);

export const settingsCopy = localizedCopy.settingsCopy;

export function bindingStatusAriaCopy(
  runtimeFamilyLabel: string,
  stateLabel: string,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).bindingStatusAriaCopy(
    runtimeFamilyLabel,
    stateLabel,
  );
}

export function bindActionAriaCopy(
  actionLabel: string,
  runtimeFamilyLabel: string,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).bindActionAriaCopy(
    actionLabel,
    runtimeFamilyLabel,
  );
}

export function authConsequencesCopy(
  resumableSessionCount: number,
  projectCount: number,
): string {
  return currentLocaleCopy(copyLocaleDictionaries).authConsequencesCopy(
    resumableSessionCount,
    projectCount,
  );
}

export let settingsOtherProvidersCopy: string =
  englishCopy.settingsOtherProvidersCopy;

subscribeLocale((nextLocale) => {
  settingsOtherProvidersCopy =
    copyLocaleDictionaries[nextLocale].settingsOtherProvidersCopy;
});

export const providerGroupHeadingCopy = localizedCopy.providerGroupHeadingCopy;
export type ProviderGroupHeading =
  (typeof providerGroupHeadingCopy)[keyof typeof providerGroupHeadingCopy];

export const settingsTopLevelSectionLabels =
  localizedCopy.settingsTopLevelSectionLabels;

export const settingsProviderStatusMeaningsData =
  localizedCopy.settingsProviderStatusMeaningsData;

export type SettingsProviderStatusMeaningLabel =
  (typeof settingsProviderStatusMeaningsData)[number]["label"];

export const appearancePersistenceLabels =
  localizedCopy.appearancePersistenceLabels;

export type AppearancePersistenceLabel =
  (typeof appearancePersistenceLabels)[keyof typeof appearancePersistenceLabels];

export const subscriptionAuthCopy = localizedCopy.subscriptionAuthCopy;

export type SubscriptionAuthenticationLabel =
  (typeof subscriptionAuthCopy)[
    | "boundLabel"
    | "signInRequiredLabel"
    | "unknownLabel"
  ];

export type SubscriptionAuthenticationActionLabel =
  (typeof subscriptionAuthCopy)[
    | "logoutAction"
    | "loginAction"
    | "recheckAction"
  ];
