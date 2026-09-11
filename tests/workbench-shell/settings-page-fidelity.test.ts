import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchRuntimeEndpointDiscoveryCategory } from "../../src/workbench-shell/contract.ts";
import {
  appearancePersistencePresentation,
  orderSettingsProviderRows,
  settingsProviderBadgePresentation,
  settingsRailPresentation,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  appearancePersistenceLabels,
  copyLocaleDictionaries as settingsCopyLocaleDictionaries,
  deepseekEndpointKeyCopy,
  glmEndpointKeyCopy,
  kimiEndpointKeyCopy,
  settingsCopy,
  settingsTopLevelSectionLabels,
} from "../../src/workbench-shell/renderer/copy/settings-copy.ts";
import { setLocale } from "../../src/workbench-shell/renderer/locale.ts";
import {
  newSessionRailAccessibleLabel,
  newSessionRailLabel,
} from "../../src/workbench-shell/renderer/copy/rail-copy.ts";

const categories: readonly WorkbenchRuntimeEndpointDiscoveryCategory[] = [
  "catalog-ready",
  "authentication-required",
  "inspection-failed",
  "runtime-not-located",
  "not-inspected",
];

test("Settings English copy exposes Appearance, Providers, Tools and Claude permissions in page order without invented provider capability", () => {
  // w233: Appearance moved to the top of the page; there is no "Other
  // providers" group and no "Status meanings" legend any more.
  assert.deepEqual(settingsTopLevelSectionLabels, [
    "Appearance",
    "Providers",
    "Tools",
    "Claude permissions",
  ]);
  assert.deepEqual(
    settingsCopyLocaleDictionaries.en.settingsTopLevelSectionLabels,
    ["Appearance", "Providers", "Tools", "Claude permissions"],
  );
  assert.equal(
    Object.isFrozen(
      settingsCopyLocaleDictionaries.en.settingsTopLevelSectionLabels,
    ),
    true,
  );
  for (const dictionary of [
    settingsCopyLocaleDictionaries.en,
    settingsCopyLocaleDictionaries["zh-CN"],
  ]) {
    const keys = Object.keys(dictionary.settingsCopy);
    assert.equal(keys.includes("statusMeaningsHeading"), false);
    assert.equal(keys.includes("otherProvidersHeading"), false);
    assert.equal(keys.includes("catalogAvailableHeading"), false);
    const visibleFreshnessCopy = dictionary.endpointCatalogFreshnessCopy;
    assert.doesNotMatch(
      [
        visibleFreshnessCopy.enrolledListLabel,
        visibleFreshnessCopy.silentFailureSentence,
        visibleFreshnessCopy.unavailableSentence,
      ].join(" "),
      /catalog|sanitized|inspected|projection/iu,
      "the collapsed card face must use product language rather than internal pipeline terms",
    );
  }

  const serialized = JSON.stringify({
    sections: settingsTopLevelSectionLabels,
    lede: settingsCopy.lede,
    badges: [
      settingsCopy.badgeReady,
      settingsCopy.badgeSignInNeeded,
      settingsCopy.badgeCliMissing,
      settingsCopy.badgeCheckFailed,
      settingsCopy.badgeNotChecked,
    ],
  });
  assert.doesNotMatch(
    serialized,
    /API key|--bare|OpenCode|Add provider|Connect provider/iu,
  );
});

test("credential promise is one line under Providers with the full subscription-path sentence behind Details, and the GLM key block states the full DPAPI truth (ADR 0022)", () => {
  const englishSettings = settingsCopyLocaleDictionaries.en.settingsCopy;
  assert.equal(
    englishSettings.credentialHeading,
    "Subscription sign-in stays in each provider's own app; API keys are stored encrypted on this device.",
  );
  assert.equal(
    englishSettings.credentialSentence,
    "Subscription sign-in happens in each provider's own app. This page never asks for a subscription password or token, never reads a subscription credential file, and never stores subscription credentials. The exceptions — the API keys of the API-key endpoints — are each disclosed in that provider's API key section below.",
  );
  assert.equal(
    settingsCopyLocaleDictionaries["zh-CN"].settingsCopy.credentialHeading,
    "订阅登录在各提供方自己的应用中完成；API 密钥加密保存在本机。",
  );
  assert.equal(englishSettings.detailsSummary, "Details");
  assert.equal(
    settingsCopyLocaleDictionaries["zh-CN"].settingsCopy.detailsSummary,
    "详情",
  );
  assert.equal(
    glmEndpointKeyCopy.heading,
    "GLM Coding Plan API key",
  );
  // ADR 0022 §4: the disclosure must state what is stored, how it is
  // protected, what that protection stops, and what it does not stop.
  assert.match(
    glmEndpointKeyCopy.storageSentence,
    /encrypted with this OS user account \(DPAPI on Windows\)/u,
  );
  assert.match(
    glmEndpointKeyCopy.protectionSentence,
    /protects the key against offline disk inspection/u,
  );
  assert.match(
    glmEndpointKeyCopy.protectionSentence,
    /does not protect the key against processes already running as your user account/u,
  );
  // Degraded mode (isPersistent: false) names its consequence explicitly.
  assert.match(
    glmEndpointKeyCopy.sessionOnlyLabel,
    /Valid for this session only/u,
  );
  assert.match(glmEndpointKeyCopy.sessionOnlyLabel, /gone after a restart/u);

  // WO16 Part 1: every provider's key copy carries the same two-truth
  // disclosure, its own env fallback sentence, and — only where the provider
  // has such rules — its key-handling warning. Kimi: shown once × 5 keys.
  // DeepSeek: no "plan" wording anywhere in its key copy (ticket 12).
  assert.equal(kimiEndpointKeyCopy.heading, "Kimi Code API key");
  const kimiWarning = kimiEndpointKeyCopy.keyHandlingWarning;
  assert.equal(typeof kimiWarning, "string");
  assert.match(kimiWarning!, /exactly once/u);
  assert.match(kimiWarning!, /at most 5 keys/u);
  assert.match(
    kimiEndpointKeyCopy.environmentFallbackLabel,
    /KIMI_CODE_ANTHROPIC_AUTH_TOKEN/u,
  );
  assert.match(
    kimiEndpointKeyCopy.protectionSentence,
    /does not protect the key against processes already running as your user account/u,
  );
  assert.equal(deepseekEndpointKeyCopy.heading, "DeepSeek API key");
  assert.doesNotMatch(
    JSON.stringify(deepseekEndpointKeyCopy),
    /plan/iu,
  );
  assert.match(
    deepseekEndpointKeyCopy.environmentFallbackLabel,
    /DEEPSEEK_ANTHROPIC_AUTH_TOKEN/u,
  );
  assert.equal(
    deepseekEndpointKeyCopy.keyHandlingWarning,
    undefined,
  );
  // The zh-CN dictionary carries the same per-provider structure.
  const zhGlm = settingsCopyLocaleDictionaries["zh-CN"].endpointKeyCopy
    .providers["glm-coding-plan"];
  assert.equal(zhGlm.heading, "GLM Coding Plan API 密钥");
  const zhKimi = settingsCopyLocaleDictionaries["zh-CN"].endpointKeyCopy
    .providers["kimi-code"];
  assert.equal(typeof zhKimi.keyHandlingWarning, "string");
  assert.match(zhKimi.keyHandlingWarning!, /仅.*显示一次/u);
  assert.match(zhKimi.keyHandlingWarning!, /最多允许 5 把/u);

  const serialized = JSON.stringify({
    heading: glmEndpointKeyCopy.heading,
    storage: glmEndpointKeyCopy.storageSentence,
    protection: glmEndpointKeyCopy.protectionSentence,
  });
  assert.doesNotMatch(serialized, /never handles credentials/iu);
});

test("every discovery category maps to one plain-words badge, and authentication-required reads as a key on API-key faces and a login on subscription faces", () => {
  // The badge is the only state word a person reads on a card; the internal
  // category names stay in the collapsed details.
  const expected = [
    ["catalog-ready", "codex-desktop", "ready", "Ready", "ok"],
    ["catalog-ready", "glm-coding-plan", "ready", "Ready", "ok"],
    ["authentication-required", "codex-desktop", "sign-in-needed", "Sign-in needed", "warn"],
    ["authentication-required", "claude-code-desktop", "sign-in-needed", "Sign-in needed", "warn"],
    ["authentication-required", "glm-coding-plan", "api-key-needed", "API key needed", "warn"],
    ["authentication-required", "deepseek-api", "api-key-needed", "API key needed", "warn"],
    ["authentication-required", "kimi-platform", "api-key-needed", "API key needed", "warn"],
    ["authentication-required", "codex-api", "api-key-needed", "API key needed", "warn"],
    ["inspection-failed", "codex-desktop", "check-failed", "Check failed", "warn"],
    ["runtime-not-located", "claude-code-desktop", "cli-missing", "CLI missing", "warn"],
    ["runtime-not-located", "glm-coding-plan", "cli-missing", "CLI missing", "warn"],
    ["not-inspected", "codex-desktop", "not-checked", "Not checked", "off"],
    ["not-inspected", "kimi-code", "not-checked", "Not checked", "off"],
  ] as const;
  assert.deepEqual(
    expected.map(([category, endpointId]) => {
      const badge = settingsProviderBadgePresentation(category, endpointId);
      assert.equal(Object.isFrozen(badge), true);
      return [category, endpointId, badge.kind, badge.label, badge.tone];
    }),
    expected,
  );
  for (const category of categories) {
    const label = settingsProviderBadgePresentation(category, "codex-desktop").label;
    assert.doesNotMatch(
      label,
      /catalog|inspect|runtime|located/iu,
      `${category}: the badge must not use an internal status word`,
    );
  }
  try {
    setLocale("zh-CN");
    assert.deepEqual(
      [
        settingsProviderBadgePresentation("catalog-ready", "codex-desktop").label,
        settingsProviderBadgePresentation("authentication-required", "codex-desktop").label,
        settingsProviderBadgePresentation("authentication-required", "glm-coding-plan").label,
        settingsProviderBadgePresentation("runtime-not-located", "codex-desktop").label,
        settingsProviderBadgePresentation("inspection-failed", "codex-desktop").label,
        settingsProviderBadgePresentation("not-inspected", "codex-desktop").label,
      ],
      ["可用", "需要登录", "需要 API 密钥", "没装 CLI", "检查失败", "尚未检查"],
    );
  } finally {
    setLocale("en");
  }
});

test("provider cards keep the owner's fixed order whatever their status is", () => {
  // Roster order is codex, claude, glm, kimi, deepseek; the page order is
  // Codex, Claude, GLM, DeepSeek, Kimi, and a status never moves a card.
  const rows = (
    [
      ["kimi-code", "catalog-ready"],
      ["deepseek-api", "not-inspected"],
      ["claude-code-desktop", "runtime-not-located"],
      ["glm-coding-plan", "authentication-required"],
      ["codex-desktop", "inspection-failed"],
    ] as const
  ).map(([endpointId, category]) => Object.freeze({ endpointId, category }));
  const ordered = orderSettingsProviderRows(rows);
  assert.deepEqual(
    ordered.map((row) => row.endpointId),
    ["codex-desktop", "claude-code-desktop", "glm-coding-plan", "deepseek-api", "kimi-code"],
  );
  assert.equal(ordered[0], rows[4]);
  assert.equal(Object.isFrozen(ordered), true);
  assert.deepEqual(
    rows.map((row) => row.endpointId),
    ["kimi-code", "deepseek-api", "claude-code-desktop", "glm-coding-plan", "codex-desktop"],
    "ordering must not mutate its input",
  );
  // A facade card resolved to its API side sits where its family sits.
  assert.deepEqual(
    orderSettingsProviderRows([
      Object.freeze({ endpointId: "kimi-platform" as const }),
      Object.freeze({ endpointId: "codex-api" as const }),
    ]).map((row) => row.endpointId),
    ["codex-api", "kimi-platform"],
  );
});

test("rail presentation defines the single shortened Settings-foot entry and attention state", () => {
  assert.equal(newSessionRailLabel, "New Session");
  assert.equal(
    newSessionRailAccessibleLabel,
    "New Agent Session (Ctrl+N)",
  );
  assert.deepEqual(settingsRailPresentation("project", false), {
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: false,
    settingsAttention: false,
  });
  assert.deepEqual(settingsRailPresentation("settings", false), {
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: true,
    settingsAttention: false,
  });
  assert.deepEqual(settingsRailPresentation("project", true), {
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: false,
    settingsAttention: true,
  });
});

test("appearance persistence labels distinguish hydration, saving, durable userData, and window-only failure", () => {
  assert.deepEqual(appearancePersistenceLabels, {
    hydrating: "Loading · This user on this device",
    saving: "Saving · This user on this device",
    saved: "Saved · This user on this device",
    error: "Not saved · Current window only",
  });
  assert.deepEqual(appearancePersistencePresentation("hydrating"), {
    label: appearancePersistenceLabels.hydrating,
    durable: false,
    error: false,
  });
  assert.deepEqual(appearancePersistencePresentation("saving"), {
    label: appearancePersistenceLabels.saving,
    durable: false,
    error: false,
  });
  assert.deepEqual(appearancePersistencePresentation("saved"), {
    label: appearancePersistenceLabels.saved,
    durable: true,
    error: false,
  });
  assert.deepEqual(appearancePersistencePresentation("error"), {
    label: appearancePersistenceLabels.error,
    durable: false,
    error: true,
  });

  const labels = ["hydrating", "saving", "saved", "error"].map((phase) =>
    appearancePersistencePresentation(
      phase as "hydrating" | "saving" | "saved" | "error",
    ).label,
  );
  assert.equal(/across Windows users|cloud|account/iu.test(labels.join(" ")), false);
});
