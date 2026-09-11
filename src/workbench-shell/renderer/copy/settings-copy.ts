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
    credentialHeading: "Subscription credentials never pass through the Workbench",
    credentialSentence:
      "Subscription sign-in happens in each provider's own app. This page never asks for a subscription password or token, never reads a subscription credential file, and never stores subscription credentials. The exceptions — the API keys of the API-key endpoints — are each disclosed in that provider's API key section below.",
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
  /**
   * One "Base URL (optional)" block per base-URL endpoint (ticket 21/w223
   * shipped Codex · API alone; w232 generalizes across GLM, DeepSeek, Kimi
   * Code and Codex · API instead of copying the copy four times): shared
   * generic sentences plus each provider's own placeholder and hint.
   */
  baseUrlCopy: {
    shared: {
      label: "Base URL (optional)",
      saveAction: "Save base URL",
      savedLabel: "Base URL",
      notSetLabel: "Using the official default",
      invalidSentence: "That must be an http(s):// address.",
      saveFailedSentence:
        "The base URL could not be saved. Keep the current value and try again.",
    },
    providers: {
      "glm-coding-plan": {
        placeholder: "https://your-glm-compatible-gateway/anthropic",
        hint: "For a GLM Anthropic-compatible gateway. Leave blank to use the official default.",
      },
      "deepseek-api": {
        placeholder: "https://your-deepseek-compatible-gateway/anthropic",
        hint: "For a DeepSeek Anthropic-compatible gateway. Leave blank to use the official default.",
      },
      "kimi-code": {
        placeholder: "https://your-kimi-compatible-gateway/coding/",
        hint: "For a Kimi Code Anthropic-compatible gateway. Leave blank to use the official default.",
      },
      "codex-api": {
        placeholder: "https://your-openai-compatible-gateway/v1",
        hint: "For an OpenAI-compatible gateway. Leave blank to use the official default.",
      },
    },
  },
  /**
   * One API-key management block per static-key endpoint (WO16 Part 1
   * generalized the GLM-only copy). The shared machine sentences live once;
   * each provider record carries its own heading, lede, placeholder, env
   * fallback sentence, and any provider-specific key-handling warning.
   */
  endpointKeyCopy: {
    shared: {
      storageSentence:
        "A saved key is encrypted with this OS user account (DPAPI on Windows) and stored in a local Workbench file.",
      protectionSentence:
        "That protects the key against offline disk inspection (reading the ciphertext offline after the disk is removed or copied). It does not protect the key against processes already running as your user account.",
      keyValueLabel: "API key",
      saveAction: "Save key",
      revealAction: "Reveal key",
      hideRevealAction: "Hide key",
      removeAction: "Remove key",
      probeAction: "Test connection",
      statusLoadingLabel: "Checking stored key…",
      notConfiguredLabel: "No key saved",
      configuredLabel: "Key saved",
      persistentLabel: "Stored durably for this OS user account.",
      sessionOnlyLabel:
        "Valid for this session only — the stored key will be gone after a restart.",
      probeSuccessLabel: "Connection succeeded: the endpoint accepted the key.",
      probeUnauthorizedLabel:
        "Connection failed: the endpoint rejected the key (unauthorized).",
      probeEndpointErrorLabel: "Connection failed: the endpoint refused the request.",
      probeServerErrorLabel:
        "Connection failed: the endpoint reported a server error, so the key was not validated.",
      probeNetworkLabel: "Connection failed: the endpoint could not be reached.",
      probeTimeoutLabel: "Connection failed: the endpoint did not answer in time.",
      probeTokenMissingLabel: "No key is available to test. Save a key first.",
      probeInvalidBaseUrlLabel:
        "Connection not attempted: the endpoint address is invalid.",
      saveInvalidSentence:
        "Enter a non-empty API key of at most 4,096 characters with no line breaks or control characters.",
      unavailableSentence:
        "Key management is unavailable in this window. Keep the current key and try again.",
    },
    providers: {
      "glm-coding-plan": {
        heading: "GLM Coding Plan API key",
        lede: "The GLM Coding Plan endpoint authenticates with an API key instead of a provider login.",
        keyValuePlaceholder: "Paste your GLM API key",
        environmentFallbackLabel:
          "Sessions currently fall back to the GLM_ANTHROPIC_AUTH_TOKEN environment variable.",
      },
      "kimi-code": {
        heading: "Kimi Code API key",
        lede: "The Kimi Code endpoint authenticates with an API key instead of a provider login.",
        keyValuePlaceholder: "Paste your Kimi API key",
        environmentFallbackLabel:
          "Sessions currently fall back to the KIMI_CODE_ANTHROPIC_AUTH_TOKEN environment variable.",
        keyHandlingWarning:
          "The Kimi console shows each key exactly once when it is created and allows at most 5 keys: a lost key can only be recreated, never recovered.",
      },
      "deepseek-api": {
        heading: "DeepSeek API key",
        lede: "The DeepSeek API endpoint authenticates with an API key instead of a provider login.",
        keyValuePlaceholder: "Paste your DeepSeek API key",
        environmentFallbackLabel:
          "Sessions currently fall back to the DEEPSEEK_ANTHROPIC_AUTH_TOKEN environment variable.",
      },
      "kimi-platform": {
        heading: "Kimi Platform API key",
        lede: "The Kimi Platform endpoint authenticates with an API key instead of a provider login.",
        keyValuePlaceholder: "Paste your Kimi Platform API key",
        environmentFallbackLabel:
          "Sessions currently fall back to the KIMI_PLATFORM_API_KEY environment variable.",
      },
      "claude-api": {
        heading: "Claude API key",
        lede: "The Claude API endpoint authenticates with an API key instead of a provider login.",
        keyValuePlaceholder: "Paste your Claude API key",
        environmentFallbackLabel:
          "Sessions currently fall back to the CLAUDE_API_KEY environment variable.",
      },
      "codex-api": {
        heading: "Codex API key",
        lede: "The Codex API endpoint authenticates with an API key instead of a provider login.",
        keyValuePlaceholder: "Paste your Codex API key",
        environmentFallbackLabel:
          "Sessions currently fall back to the CODEX_API_KEY environment variable.",
      },
    },
  },
  /** Ticket 25: the merged family card's segment-switch group label. */
  familyFacadeCopy: {
    segmentsLabel: (runtimeFamilyLabel: string): string =>
      `${runtimeFamilyLabel} backend`,
  },
  bindingStatusAriaCopy: (
    runtimeFamilyLabel: string,
    stateLabel: string,
  ): string =>
    `${runtimeFamilyLabel} subscription authentication: ${stateLabel}`,
  endpointCatalogFreshnessCopy: {
    newModelsHeading: (count: number): string =>
      count === 1
        ? "1 new model available"
        : `${count} new models available`,
    newModelsItem: (entry: {
      readonly id: string;
      readonly displayName?: string;
      readonly createdAt?: string;
    }): string =>
      `${entry.displayName ?? entry.id} · new (untiered)` +
      (entry.createdAt === undefined ? "" : ` · listed ${entry.createdAt}`),
    enrolledListLabel: "Recently added by the automatic catalog check (untiered until curated):",
    refreshAction: "Check for new models",
    refreshingAction: "Checking…",
    silentFailureSentence:
      "The automatic catalog check could not reach this provider just now. The known catalog stays in effect.",
    unavailableSentence:
      "Catalog freshness is unavailable in this window. The known catalog stays in effect.",
  },
  /**
   * CLI update block (ticket 18). claude's button appears only when the
   * read-only check found a newer version; codex has no read-only check,
   * so its button is the explicit "check and update" action. Failure states
   * stay distinct so the renderer can state only what actually happened.
   *
   * Issue 184 adds the two sentences a failure used to swallow. A failed
   * check now says so and offers "Check for updates again" instead of removing the
   * control and leaving the row blank, and the optional "Restart now" action
   * stays beside "Not now". If the app cannot restart itself, its status says
   * it can keep running and new sessions will use the new version.
   */
  cliUpdateCopy: {
    updateAvailableSentence: (
      currentVersion: string,
      availableVersion: string,
    ): string => `A new version is available: ${currentVersion} → ${availableVersion}.`,
    checkAndUpdateAction: "Check and update",
    updateAction: "Update",
    runningAction: "Updating…",
    succeededSentence:
      "The update finished. The next new session will start with the new version; existing sessions will not switch versions.",
    restartNowAction: "Restart now",
    restartingAction: "Restarting…",
    restartLaterAction: "Not now",
    relaunchFailedSentence:
      "The app could not restart itself. You can keep using it; new sessions will use the new version.",
    checkFailedSentence:
      "Could not check whether a newer version is available. Check again for current version information.",
    checkAgainAction: "Check for updates again",
    checkingAction: "Checking…",
    failedTimeoutSentence:
      "The update did not finish in time. Nothing was changed.",
    failedLaunchSentence:
      "The update command could not be started. Nothing was changed.",
    failedUpdateSentence:
      "The update did not complete. Nothing was changed.",
    failedNoChangeSentence:
      "The updater finished without an error, but the installed version did not change. Nothing was updated. Try again, or update this CLI from the channel that installed it.",
    failedResultUnknownSentence:
      "The update command finished, but the version for the next new session could not be verified. Check again before starting a new session.",
    failedUnsupportedInstallSentence:
      "This CLI install is managed by its own channel (for example the desktop app it came with) and updates itself there. Nothing was changed.",
    failureInUseAdvice:
      "A session or another process may still be using this CLI. Close them and try again.",
    unavailableSentence:
      "CLI updates are unavailable in this window. Nothing was changed.",
    /*
     * w120. Before this, the codex row was a bare button and nothing else:
     * no version, no channel, no statement of what pressing it would do —
     * and pressing it runs a non-interactive installer in the background.
     * A person could not tell beforehand what they were about to install.
     *
     * What these two sentences may say is bounded by what the renderer is
     * told. The codex report is `{ status: "no-check" }`; it carries no
     * version and no channel, so neither is claimed here. Saying "you are on
     * 0.153.4" from a value nobody sent would be the invention this project
     * treats as its worst defect.
     */
    codexActionSentence:
      "Workbench asks the channel that installed this CLI to update it. That can download and install a new version in the background.",
    codexVersionUnknownSentence:
      "The installed version is not read until the update runs. Afterwards Workbench re-reads it and only reports success if it actually changed.",
    confirmUpdateQuestion:
      "Update this CLI now?",
    confirmUpdateAction: "Yes, update",
    cancelUpdateAction: "Cancel",
  },
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
    recheckAction: "Re-check sign-in",
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
    // Shown only when the provider CLI actually printed a URL. There is no
    // "waiting for sign-in" text and no placeholder link: the Workbench cannot
    // see whether the browser opened, so it says what it received and nothing
    // else.
    signInUrlHeading: "Sign-in link from the provider CLI",
    signInUrlSentence:
      "The provider CLI printed this sign-in link. If a browser opened, finish there and ignore this. If none opened, open this link yourself.",
    signInUrlCopyAction: "Copy link",
    signInUrlCopyingAction: "Copying...",
    signInUrlCopiedAction: "Copied",
    signInUrlCopyFailedAction: "Copy failed",
    signInUrlCopyAria: "Copy the provider sign-in link",
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
    credentialHeading: "订阅凭据绝不经过 Workbench",
    credentialSentence:
      "订阅登录在各提供方自己的应用中完成。此页面绝不会索取订阅密码或令牌，不会读取订阅凭据文件，也不会存储订阅凭据。例外——各 API 密钥端点的 API 密钥——在下文对应提供方的 API 密钥区块中如实说明。",
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
  baseUrlCopy: {
    shared: {
      label: "Base URL(可选)",
      saveAction: "保存 Base URL",
      savedLabel: "Base URL",
      notSetLabel: "使用官方默认地址",
      invalidSentence: "必须是 http(s):// 开头的地址。",
      saveFailedSentence: "Base URL 未能保存,请保留当前值并重试。",
    },
    providers: {
      "glm-coding-plan": {
        placeholder: "https://你的-glm-兼容网关/anthropic",
        hint: "用于接入 GLM Anthropic 兼容网关。留空则使用官方默认地址。",
      },
      "deepseek-api": {
        placeholder: "https://你的-deepseek-兼容网关/anthropic",
        hint: "用于接入 DeepSeek Anthropic 兼容网关。留空则使用官方默认地址。",
      },
      "kimi-code": {
        placeholder: "https://你的-kimi-兼容网关/coding/",
        hint: "用于接入 Kimi Code Anthropic 兼容网关。留空则使用官方默认地址。",
      },
      "codex-api": {
        placeholder: "https://你的-openai-兼容网关/v1",
        hint: "用于接入 OpenAI 兼容网关。留空则使用官方默认地址。",
      },
    },
  },
  endpointKeyCopy: {
    shared: {
      storageSentence:
        "保存的密钥由本操作系统账户加密（Windows 上为 DPAPI），并存储在 Workbench 的本地文件中。",
      protectionSentence:
        "该保护防的是离线盘检（拆盘或拷盘后离线读取密文）；它不能防已在你的用户账户下运行的进程。",
      keyValueLabel: "API 密钥",
      saveAction: "保存密钥",
      revealAction: "显示密钥",
      hideRevealAction: "隐藏密钥",
      removeAction: "删除密钥",
      probeAction: "测试连接",
      statusLoadingLabel: "正在检查已存密钥…",
      notConfiguredLabel: "未保存密钥",
      configuredLabel: "已保存密钥",
      persistentLabel: "已为本操作系统账户持久保存。",
      sessionOnlyLabel: "仅本次会话有效——重启后已存密钥即失效。",
      probeSuccessLabel: "连接成功：端点接受了该密钥。",
      probeUnauthorizedLabel: "连接失败：端点拒绝了该密钥（未授权）。",
      probeEndpointErrorLabel: "连接失败：端点拒绝了请求。",
      probeServerErrorLabel: "连接失败：端点报告服务器错误，密钥未经验证。",
      probeNetworkLabel: "连接失败：无法连接到端点。",
      probeTimeoutLabel: "连接失败：端点未在时限内响应。",
      probeTokenMissingLabel: "没有可测试的密钥，请先保存密钥。",
      probeInvalidBaseUrlLabel: "未尝试连接：端点地址无效。",
      saveInvalidSentence:
        "请输入非空的 API 密钥，长度不超过 4,096 个字符，且不含换行或控制字符。",
      unavailableSentence: "此窗口中密钥管理不可用。请保留当前密钥并重试。",
    },
    providers: {
      "glm-coding-plan": {
        heading: "GLM Coding Plan API 密钥",
        lede: "GLM Coding Plan 端点使用 API 密钥认证，而非提供方登录。",
        keyValuePlaceholder: "粘贴你的 GLM API 密钥",
        environmentFallbackLabel:
          "当前会话回退使用环境变量 GLM_ANTHROPIC_AUTH_TOKEN。",
      },
      "kimi-code": {
        heading: "Kimi Code API 密钥",
        lede: "Kimi Code 端点使用 API 密钥认证，而非提供方登录。",
        keyValuePlaceholder: "粘贴你的 Kimi API 密钥",
        environmentFallbackLabel:
          "当前会话回退使用环境变量 KIMI_CODE_ANTHROPIC_AUTH_TOKEN。",
        keyHandlingWarning:
          "Kimi 控制台仅在创建时显示一次密钥，且最多允许 5 把：丢失的密钥只能重新创建，无法找回。",
      },
      "deepseek-api": {
        heading: "DeepSeek API 密钥",
        lede: "DeepSeek API 端点使用 API 密钥认证，而非提供方登录。",
        keyValuePlaceholder: "粘贴你的 DeepSeek API 密钥",
        environmentFallbackLabel:
          "当前会话回退使用环境变量 DEEPSEEK_ANTHROPIC_AUTH_TOKEN。",
      },
      "kimi-platform": {
        heading: "Kimi 平台 API 密钥",
        lede: "Kimi 平台端点使用 API 密钥认证，而非提供方登录。",
        keyValuePlaceholder: "粘贴你的 Kimi 平台 API 密钥",
        environmentFallbackLabel:
          "当前会话回退使用环境变量 KIMI_PLATFORM_API_KEY。",
      },
      "claude-api": {
        heading: "Claude API 密钥",
        lede: "Claude API 端点使用 API 密钥认证，而非提供方登录。",
        keyValuePlaceholder: "粘贴你的 Claude API 密钥",
        environmentFallbackLabel:
          "当前会话回退使用环境变量 CLAUDE_API_KEY。",
      },
      "codex-api": {
        heading: "Codex API 密钥",
        lede: "Codex API 端点使用 API 密钥认证，而非提供方登录。",
        keyValuePlaceholder: "粘贴你的 Codex API 密钥",
        environmentFallbackLabel:
          "当前会话回退使用环境变量 CODEX_API_KEY。",
      },
    },
  },
  familyFacadeCopy: {
    segmentsLabel: (runtimeFamilyLabel: string): string =>
      `${runtimeFamilyLabel} 后端`,
  },
  bindingStatusAriaCopy: (
    runtimeFamilyLabel: string,
    stateLabel: string,
  ): string => `${runtimeFamilyLabel} 订阅身份验证：${stateLabel}`,
  endpointCatalogFreshnessCopy: {
    newModelsHeading: (count: number): string =>
      count === 1 ? "1 个新模型可用" : `${count} 个新模型可用`,
    newModelsItem: (entry: {
      readonly id: string;
      readonly displayName?: string;
      readonly createdAt?: string;
    }): string =>
      `${entry.displayName ?? entry.id} · 新（未定档）` +
      (entry.createdAt === undefined ? "" : ` · 列出于 ${entry.createdAt}`),
    enrolledListLabel: "由自动目录检查加入（定档前为未定档）：",
    refreshAction: "检查新模型",
    refreshingAction: "正在检查…",
    silentFailureSentence:
      "自动目录检查暂时无法连接此提供方。现有目录继续生效。",
    unavailableSentence: "此窗口中目录新鲜度不可用。现有目录继续生效。",
  },
  cliUpdateCopy: {
    updateAvailableSentence: (
      currentVersion: string,
      availableVersion: string,
    ): string => `有新版本可用：${currentVersion} → ${availableVersion}。`,
    checkAndUpdateAction: "检查并更新",
    updateAction: "更新",
    runningAction: "正在更新…",
    succeededSentence: "更新完成。下一个新会话将启动新版本；现有会话不会切换版本。",
    restartNowAction: "立即重启",
    restartingAction: "正在重启…",
    restartLaterAction: "暂不",
    relaunchFailedSentence:
      "应用无法自行重启。你可以继续使用它；新会话将使用新版本。",
    checkFailedSentence: "无法检查是否有更新版本。请重新检查以获取当前版本信息。",
    checkAgainAction: "重新检查更新",
    checkingAction: "正在检查…",
    failedTimeoutSentence: "更新超时未完成。没有任何更改。",
    failedLaunchSentence: "无法启动更新命令。没有任何更改。",
    failedUpdateSentence: "更新未完成。没有任何更改。",
    failedNoChangeSentence:
      "更新程序没有报错，但已安装的版本并未变化，什么都没更新。请重试，或从安装它的渠道更新该 CLI。",
    failedResultUnknownSentence:
      "更新命令已结束，但无法核实下一个新会话的版本。请在新建会话前重新检查。",
    failedUnsupportedInstallSentence:
      "此 CLI 由其自身的安装渠道（例如随附的桌面应用）管理，并由该渠道自行更新。此处没有任何更改。",
    failureInUseAdvice:
      "可能有会话或其他进程正在使用此 CLI，关闭后重试。",
    unavailableSentence: "此窗口中 CLI 更新不可用。没有任何更改。",
    codexActionSentence:
      "Workbench 会请安装此 CLI 的渠道进行更新。这可能会在后台下载并安装新版本。",
    codexVersionUnknownSentence:
      "已安装的版本要等更新运行时才会读取。更新后 Workbench 会重新读一次，只有版本确实变化才报成功。",
    confirmUpdateQuestion: "现在更新此 CLI 吗？",
    confirmUpdateAction: "确认更新",
    cancelUpdateAction: "取消",
  },
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
    recheckAction: "重新检查登录",
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
    signInUrlHeading: "提供方 CLI 给出的登录链接",
    signInUrlSentence:
      "提供方 CLI 打印了这个登录链接。如果浏览器已经打开，请在那里完成登录，忽略此处；如果没有打开，请自行打开此链接。",
    signInUrlCopyAction: "复制链接",
    signInUrlCopyingAction: "正在复制...",
    signInUrlCopiedAction: "已复制",
    signInUrlCopyFailedAction: "复制失败",
    signInUrlCopyAria: "复制提供方登录链接",
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

export const endpointKeySharedCopy = localizedCopy.endpointKeyCopy.shared;

export const endpointKeyProviderCopy =
  localizedCopy.endpointKeyCopy.providers;

export type WorkbenchEndpointKeyCopyEndpointId = keyof typeof endpointKeyProviderCopy;

/**
 * The composed per-endpoint copy dictionary for one provider's key block:
 * shared machine sentences plus the provider's own identity strings. The
 * provider record may carry a key-handling warning absent on other providers
 * (Kimi's shown-once × 5-keys limit).
 */
export function workbenchEndpointKeyCopy(
  endpointId: WorkbenchEndpointKeyCopyEndpointId,
) {
  const provider = endpointKeyProviderCopy[endpointId];
  return Object.freeze({
    ...endpointKeySharedCopy,
    heading: provider.heading,
    lede: provider.lede,
    keyValuePlaceholder: provider.keyValuePlaceholder,
    environmentFallbackLabel: provider.environmentFallbackLabel,
    ...("keyHandlingWarning" in provider && provider.keyHandlingWarning !== undefined
      ? { keyHandlingWarning: provider.keyHandlingWarning }
      : {}),
  });
}

/** Flattened GLM view kept for the fidelity pins (same composed content). */
export const glmEndpointKeyCopy = workbenchEndpointKeyCopy("glm-coding-plan");

export const kimiEndpointKeyCopy = workbenchEndpointKeyCopy("kimi-code");

export const deepseekEndpointKeyCopy = workbenchEndpointKeyCopy("deepseek-api");

/** Flattened Kimi Platform view for the merged Kimi card's platform side. */
export const kimiPlatformEndpointKeyCopy =
  workbenchEndpointKeyCopy("kimi-platform");

export const baseUrlSharedCopy = localizedCopy.baseUrlCopy.shared;

export const baseUrlProviderCopy = localizedCopy.baseUrlCopy.providers;

export type WorkbenchBaseUrlCopyEndpointId = keyof typeof baseUrlProviderCopy;

/**
 * The composed per-endpoint copy dictionary for one provider's base-URL
 * block (ticket 21/w223 shipped Codex · API alone; w232 generalizes it):
 * shared generic sentences plus the provider's own placeholder and hint.
 */
export function workbenchBaseUrlCopy(endpointId: WorkbenchBaseUrlCopyEndpointId) {
  const provider = baseUrlProviderCopy[endpointId];
  return Object.freeze({
    ...baseUrlSharedCopy,
    placeholder: provider.placeholder,
    hint: provider.hint,
  });
}

/** Copy for the merged family settings cards' backend segment switch. */
export const familyFacadeCopy = localizedCopy.familyFacadeCopy;

export const endpointCatalogFreshnessCopy =
  localizedCopy.endpointCatalogFreshnessCopy;

export const cliUpdateCopy = localizedCopy.cliUpdateCopy;

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
