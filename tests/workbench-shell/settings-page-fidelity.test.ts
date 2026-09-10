import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchRuntimeEndpointDiscoveryCategory } from "../../src/workbench-shell/contract.ts";
import {
  appearancePersistencePresentation,
  groupSettingsProviderRows,
  settingsProviderAvailabilityPresentation,
  settingsRailPresentation,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  appearancePersistenceLabels,
  copyLocaleDictionaries as settingsCopyLocaleDictionaries,
  deepseekEndpointKeyCopy,
  glmEndpointKeyCopy,
  kimiEndpointKeyCopy,
  settingsOtherProvidersCopy,
  settingsProviderStatusMeaningsData as settingsProviderStatusMeanings,
  settingsTopLevelSectionLabels,
} from "../../src/workbench-shell/renderer/copy/settings-copy.ts";
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

test("Settings English copy exposes Providers, Claude permissions, and Appearance without invented provider capability", () => {
  assert.deepEqual(settingsTopLevelSectionLabels, [
    "Providers",
    "Claude permissions",
    "Appearance",
  ]);
  assert.deepEqual(
    settingsCopyLocaleDictionaries.en.settingsTopLevelSectionLabels,
    ["Providers", "Claude permissions", "Appearance"],
  );
  assert.equal(
    Object.isFrozen(
      settingsCopyLocaleDictionaries.en.settingsTopLevelSectionLabels,
    ),
    true,
  );
  assert.equal(
    settingsOtherProvidersCopy,
    "No other providers are configured in this build.",
  );

  const serialized = JSON.stringify({
    sections: settingsTopLevelSectionLabels,
    otherProviders: settingsOtherProvidersCopy,
    meanings: settingsProviderStatusMeanings,
  });
  assert.doesNotMatch(
    serialized,
    /API key|--bare|OpenCode|Add provider|Connect provider/iu,
  );
});

test("credential promise is narrowed to the subscription path and the GLM key block states the full DPAPI truth (ADR 0022)", () => {
  const englishSettings = settingsCopyLocaleDictionaries.en.settingsCopy;
  assert.equal(
    englishSettings.credentialHeading,
    "Subscription credentials never pass through the Workbench",
  );
  assert.equal(
    englishSettings.credentialSentence,
    "Subscription sign-in happens in each provider's own app. This page never asks for a subscription password or token, never reads a subscription credential file, and never stores subscription credentials. The exceptions — the API keys of the API-key endpoints — are each disclosed in that provider's API key section below.",
  );
  assert.equal(
    settingsCopyLocaleDictionaries["zh-CN"].settingsCopy.credentialHeading,
    "订阅凭据绝不经过 Workbench",
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

test("all exact endpoint categories keep not-inspected distinct from unavailable", () => {
  const expected = [
    [
      "catalog-ready",
      "catalog-available",
      "Catalog available",
      "ok",
      "Connected",
    ],
    [
      "authentication-required",
      "catalog-unavailable",
      "Catalog unavailable",
      "warn",
      "Sign-in required",
    ],
    [
      "inspection-failed",
      "catalog-unavailable",
      "Catalog unavailable",
      "warn",
      "Inspection failed",
    ],
    [
      "runtime-not-located",
      "catalog-unavailable",
      "Catalog unavailable",
      "off",
      "Not found",
    ],
    [
      "not-inspected",
      "not-inspected",
      "Not checked",
      "off",
      "Not checked",
    ],
  ] as const;

  assert.deepEqual(
    categories.map((category) => {
      const availability = settingsProviderAvailabilityPresentation(category);
      const meaning = settingsProviderStatusMeanings.find(
        (candidate) => candidate.category === category,
      );
      assert.ok(meaning);
      assert.equal(Object.isFrozen(availability), true);
      assert.equal(Object.isFrozen(meaning), true);
      return [
        category,
        availability.group,
        availability.label,
        availability.tone,
        meaning.label,
      ];
    }),
    expected,
  );
});

test("provider grouping is exact, ordered, frozen, and does not clone or expose another shape", () => {
  const rows = categories.map((category, index) =>
    Object.freeze({ category, endpointId: `endpoint-${index + 1}` }),
  );
  const groups = groupSettingsProviderRows(rows);

  assert.deepEqual(
    groups.catalogAvailable.map((row) => row.endpointId),
    ["endpoint-1"],
  );
  assert.deepEqual(
    groups.catalogUnavailable.map((row) => row.endpointId),
    ["endpoint-2", "endpoint-3", "endpoint-4"],
  );
  assert.deepEqual(
    groups.notInspected.map((row) => row.endpointId),
    ["endpoint-5"],
  );
  assert.equal(groups.catalogAvailable[0], rows[0]);
  assert.equal(Object.isFrozen(groups), true);
  assert.equal(Object.isFrozen(groups.catalogAvailable), true);
  assert.equal(Object.isFrozen(groups.catalogUnavailable), true);
  assert.equal(Object.isFrozen(groups.notInspected), true);
  assert.deepEqual(Object.keys(groups), [
    "catalogAvailable",
    "catalogUnavailable",
    "notInspected",
  ]);
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
