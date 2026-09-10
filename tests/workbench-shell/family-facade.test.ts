import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import type {
  WorkbenchModelOption,
  WorkbenchPublicDirectSessionProfileResult,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchRuntimeEndpointId,
  WorkbenchRuntimeEndpointOption,
} from "../../src/workbench-shell/contract.ts";
import {
  defaultWorkbenchFamilyEndpointPreferences,
  publicRuntimeEndpointDiscovery,
} from "../../src/workbench-shell/contract.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  directEndpointStatusRows,
  directFacadeEndpointStatusRows,
  directFacadeProfileEndpoints,
  initialRendererState,
  resolveFamilyFacadeBackend,
} from "../../src/workbench-shell/renderer/view-model.ts";
import {
  claudeFacadeUnconfiguredDetail,
  codexFacadeUnconfiguredDetail,
  endpointApiKeyAuthenticationDetail,
  kimiFacadeUnconfiguredDetail,
} from "../../src/workbench-shell/renderer/copy/runtime-profile-copy.ts";
import { setLocale } from "../../src/workbench-shell/renderer/locale.ts";

/**
 * Ticket 25 — the family facades (generalizing ticket 20's Kimi facade).
 * The roster keeps all eight endpoints; the presentation layer (picker,
 * statusbar, stage, settings) shows ONE entry per family (Codex, Claude,
 * GLM, Kimi, DeepSeek) resolved by configuration only: kimi looks at key
 * presence from discovery, claude/codex are subscription-first (the
 * subscription-auth service's "bound" report or the desktop backend's own
 * catalog-ready discovery), otherwise the API key, never a probe. These
 * fixtures pin the resolution states, the merged-row shapes, the model
 * list following the resolved backend, and the dead-copy regression
 * ("sign-in remains in the official provider flow" may only appear where
 * a real login action exists).
 */

type Category = WorkbenchRuntimeEndpointDiscoveryCategory;

const READY: Category = "catalog-ready";
const AUTH: Category = "authentication-required";
const NOT_INSPECTED: Category = "not-inspected";

const FAMILY_LABELS: Readonly<
  Record<WorkbenchRuntimeEndpointId, string>
> = Object.freeze({
  "codex-desktop": "Codex",
  "claude-code-desktop": "Claude",
  "glm-coding-plan": "GLM",
  "kimi-code": "Kimi",
  "deepseek-api": "DeepSeek",
  "kimi-platform": "Kimi",
  "claude-api": "Claude",
  "codex-api": "Codex",
});

const SEGMENT_LABELS: Readonly<Record<WorkbenchRuntimeEndpointId, string>> =
  Object.freeze({
    "codex-desktop": "Subscription",
    "claude-code-desktop": "Subscription",
    "glm-coding-plan": "GLM Coding Plan",
    "kimi-code": "Code",
    "deepseek-api": "DeepSeek API",
    "kimi-platform": "Platform",
    "claude-api": "API",
    "codex-api": "API",
  });

function model(
  endpointId: WorkbenchRuntimeEndpointId,
  id: string,
): WorkbenchModelOption {
  return Object.freeze({
    key: `model:${endpointId}:${id}`,
    label: id,
    provenanceLabel: null,
    workIntensityLabel: null,
    workIntensities: Object.freeze([
      Object.freeze({ key: "default", label: "Default" }),
    ]),
  });
}

function endpointOption(
  endpointId: WorkbenchRuntimeEndpointId,
  models: readonly WorkbenchModelOption[],
): WorkbenchRuntimeEndpointOption {
  return Object.freeze({
    endpointId,
    key: `endpoint:${endpointId}`,
    runtimeFamilyLabel: FAMILY_LABELS[endpointId],
    endpointLabel: SEGMENT_LABELS[endpointId],
    models: Object.freeze(models),
    executionModes: Object.freeze([]),
    accessModes: Object.freeze([]),
  });
}

const KIMI_CODE_MODELS = Object.freeze([
  model("kimi-code", "kimi-for-coding"),
  model("kimi-code", "kimi-for-coding-highspeed"),
]);
const KIMI_PLATFORM_MODELS = Object.freeze([
  model("kimi-platform", "kimi-k2.7-code"),
  model("kimi-platform", "kimi-k3"),
]);
const CLAUDE_SUBSCRIPTION_MODELS = Object.freeze([
  model("claude-code-desktop", "sonnet-6"),
]);
const CLAUDE_API_MODELS = Object.freeze([
  model("claude-api", "claude-opus-6"),
  model("claude-api", "claude-sonnet-6"),
]);
const CODEX_SUBSCRIPTION_MODELS = Object.freeze([
  model("codex-desktop", "gpt-5.6-sol"),
]);
const CODEX_API_MODELS = Object.freeze([
  model("codex-api", "gpt-5.7"),
]);

function facadeProfile(
  categories: Readonly<
    Partial<Record<WorkbenchRuntimeEndpointId, Category>>
  >,
  endpoints: readonly WorkbenchRuntimeEndpointOption[],
): WorkbenchPublicDirectSessionProfileResult {
  return {
    ok: true,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      (
        [
          "codex-desktop",
          "claude-code-desktop",
          "glm-coding-plan",
          "kimi-code",
          "deepseek-api",
          "kimi-platform",
          "claude-api",
          "codex-api",
        ] as const
      ).map((endpointId) => ({
        endpointId,
        category: categories[endpointId] ?? AUTH,
      })),
    ),
    profile: {
      snapshotKey: "snapshot:family-facade",
      endpoints,
      desiredDefault: { kind: "unavailable" },
    },
  };
}

function stateWith(result: WorkbenchPublicDirectSessionProfileResult) {
  return completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    result,
  );
}

function endpointGuidanceDetails(): readonly string[] {
  const state = stateWith(facadeProfile({}, []));
  const endpointRows = directEndpointStatusRows(state.profile);
  const facadeRows = directFacadeEndpointStatusRows(state.profile);
  const endpointDetail = (endpointId: WorkbenchRuntimeEndpointId): string => {
    const row = endpointRows.find((candidate) => candidate.endpointId === endpointId);
    assert.ok(row, `${endpointId} row renders`);
    return row.detail;
  };
  const facadeDetail = (runtimeFamilyLabel: string): string => {
    const row = facadeRows.find(
      (candidate) => candidate.runtimeFamilyLabel === runtimeFamilyLabel,
    );
    assert.ok(row, `${runtimeFamilyLabel} facade row renders`);
    return row.detail;
  };
  return [
    endpointDetail("glm-coding-plan"),
    facadeDetail("Kimi"),
    facadeDetail("Claude"),
    facadeDetail("Codex"),
  ];
}

test("persisted zh-CN endpoint guidance is Chinese on its first status-row read", () => {
  try {
    setLocale("zh-CN");
    assert.deepEqual(endpointGuidanceDetails(), [
      "在此端点的设置卡片上添加 API 密钥。",
      "尚未保存 Kimi 密钥。请在设置的 Kimi 卡片上添加 Kimi Code 或 Kimi 平台的 API 密钥。",
      "Claude 尚未登录订阅，也未保存 API 密钥。请在设置的 Claude 卡片上完成订阅登录，或添加 Claude API 密钥。",
      "Codex 尚未登录订阅，也未保存 API 密钥。请在设置的 Codex 卡片上完成订阅登录，或添加 Codex API 密钥。",
    ]);
  } finally {
    setLocale("en");
  }
});

test("endpoint guidance follows an en to zh-CN switch in one module lifetime", () => {
  setLocale("en");
  assert.deepEqual(endpointGuidanceDetails(), [
    "Add this endpoint's API key on its settings card.",
    "No Kimi key is saved. Add the Kimi Code or Kimi Platform API key on the Kimi card in Settings.",
    "Claude has no signed-in subscription and no saved API key. Sign in, or add a Claude API key, on the Claude card in Settings.",
    "Codex has no signed-in subscription and no saved API key. Sign in, or add a Codex API key, on the Codex card in Settings.",
  ]);

  try {
    setLocale("zh-CN");
    assert.deepEqual(endpointGuidanceDetails(), [
      "在此端点的设置卡片上添加 API 密钥。",
      "尚未保存 Kimi 密钥。请在设置的 Kimi 卡片上添加 Kimi Code 或 Kimi 平台的 API 密钥。",
      "Claude 尚未登录订阅，也未保存 API 密钥。请在设置的 Claude 卡片上完成订阅登录，或添加 Claude API 密钥。",
      "Codex 尚未登录订阅，也未保存 API 密钥。请在设置的 Codex 卡片上完成订阅登录，或添加 Codex API 密钥。",
    ]);
  } finally {
    setLocale("en");
  }
});

test("kimi facade resolves by key presence: only code, only platform, both+preference, preferred-without-key falls through", () => {
  const onlyCode = stateWith(
    facadeProfile({ "kimi-code": READY }, [
      endpointOption("kimi-code", KIMI_CODE_MODELS),
    ]),
  );
  assert.equal(
    resolveFamilyFacadeBackend(onlyCode.profile, "kimi"),
    "kimi-code",
  );
  const kimiRow = directFacadeEndpointStatusRows(onlyCode.profile).find(
    (row) => row.runtimeFamilyLabel === "Kimi",
  );
  assert.ok(kimiRow);
  assert.equal(kimiRow.endpointId, "kimi-code");
  assert.equal(kimiRow.endpointLabel, "Code");
  assert.deepEqual(
    kimiRow.endpoint?.models.map((entry) => entry.label),
    ["kimi-for-coding", "kimi-for-coding-highspeed"],
  );

  const onlyPlatform = stateWith(
    facadeProfile({ "kimi-platform": READY }, [
      endpointOption("kimi-platform", KIMI_PLATFORM_MODELS),
    ]),
  );
  assert.equal(
    resolveFamilyFacadeBackend(onlyPlatform.profile, "kimi"),
    "kimi-platform",
  );
  const platformRow = directFacadeEndpointStatusRows(
    onlyPlatform.profile,
  ).find((row) => row.runtimeFamilyLabel === "Kimi");
  assert.ok(platformRow);
  assert.equal(platformRow.endpointLabel, "Platform");
  assert.deepEqual(
    platformRow.endpoint?.models.map((entry) => entry.label),
    ["kimi-k2.7-code", "kimi-k3"],
    "switching the resolved backend switches the model family",
  );

  const both = stateWith(
    facadeProfile(
      { "kimi-code": READY, "kimi-platform": READY },
      [
        endpointOption("kimi-code", KIMI_CODE_MODELS),
        endpointOption("kimi-platform", KIMI_PLATFORM_MODELS),
      ],
    ),
  );
  // Default / automatic order: kimi-code first (ticket 20 ruling).
  assert.equal(
    resolveFamilyFacadeBackend(both.profile, "kimi"),
    "kimi-code",
  );
  // The manual preference overrides the automatic ordering.
  const preferPlatform = {
    ...defaultWorkbenchFamilyEndpointPreferences,
    kimi: "kimi-platform" as const,
  };
  assert.equal(
    resolveFamilyFacadeBackend(both.profile, "kimi", preferPlatform),
    "kimi-platform",
  );
  // The preference orders, it never forces an unusable backend.
  const platformPreferredCodeOnly = stateWith(
    facadeProfile({ "kimi-code": READY }, [
      endpointOption("kimi-code", KIMI_CODE_MODELS),
    ]),
  );
  assert.equal(
    resolveFamilyFacadeBackend(
      platformPreferredCodeOnly.profile,
      "kimi",
      preferPlatform,
    ),
    "kimi-code",
    "a preferred backend without a key falls through to the other backend",
  );
});

test("claude facade is subscription-first: bound subscription wins over a present API key", () => {
  const bothUsable = stateWith(
    facadeProfile(
      { "claude-code-desktop": READY, "claude-api": READY },
      [
        endpointOption("claude-code-desktop", CLAUDE_SUBSCRIPTION_MODELS),
        endpointOption("claude-api", CLAUDE_API_MODELS),
      ],
    ),
  );
  // Automatic order: the desktop subscription backend comes first even
  // when the API key is also in place (ticket 25 ruling 2).
  assert.equal(
    resolveFamilyFacadeBackend(bothUsable.profile, "claude"),
    "claude-code-desktop",
  );
  // The subscription-auth service's "bound" report alone proves the
  // desktop backend even when its discovery says authentication-required.
  assert.equal(
    resolveFamilyFacadeBackend(bothUsable.profile, "claude", undefined, {
      "claude-code-desktop": { authentication: "bound" },
    }),
    "claude-code-desktop",
  );
  const subscriptionOnlyAuth = stateWith(
    facadeProfile({ "claude-api": READY }, [
      endpointOption("claude-api", CLAUDE_API_MODELS),
    ]),
  );
  assert.equal(
    resolveFamilyFacadeBackend(subscriptionOnlyAuth.profile, "claude", undefined, {
      "claude-code-desktop": { authentication: "bound" },
    }),
    "claude-code-desktop",
    "subscription-auth bound beats a present API key",
  );
  assert.equal(
    resolveFamilyFacadeBackend(subscriptionOnlyAuth.profile, "claude"),
    "claude-api",
    "without the subscription, the API key resolves the family",
  );
  // A "sign-in-required" report is not usable and never resolves.
  assert.equal(
    resolveFamilyFacadeBackend(subscriptionOnlyAuth.profile, "claude", undefined, {
      "claude-code-desktop": { authentication: "sign-in-required" },
    }),
    "claude-api",
  );
  // The manual API preference orders but never forces an unusable backend.
  const preferApi = {
    ...defaultWorkbenchFamilyEndpointPreferences,
    claude: "claude-api" as const,
  };
  assert.equal(
    resolveFamilyFacadeBackend(bothUsable.profile, "claude", preferApi),
    "claude-api",
  );
  const apiPreferredSubscriptionOnly = stateWith(
    facadeProfile({ "claude-code-desktop": READY }, [
      endpointOption("claude-code-desktop", CLAUDE_SUBSCRIPTION_MODELS),
    ]),
  );
  assert.equal(
    resolveFamilyFacadeBackend(
      apiPreferredSubscriptionOnly.profile,
      "claude",
      preferApi,
    ),
    "claude-code-desktop",
    "a preferred API backend without a key falls through to subscription",
  );
});

test("claude facade model list follows the resolved backend and the picker hides the hidden backend", () => {
  const apiResolved = stateWith(
    facadeProfile({ "claude-api": READY }, [
      endpointOption("claude-api", CLAUDE_API_MODELS),
    ]),
  );
  const claudeRow = directFacadeEndpointStatusRows(
    apiResolved.profile,
  ).find((row) => row.runtimeFamilyLabel === "Claude");
  assert.ok(claudeRow);
  assert.equal(claudeRow.endpointId, "claude-api");
  assert.equal(claudeRow.endpointLabel, "API");
  assert.deepEqual(
    claudeRow.endpoint?.models.map((entry) => entry.label),
    ["claude-opus-6", "claude-sonnet-6"],
  );
  assert.deepEqual(
    directFacadeProfileEndpoints(apiResolved).map(
      (endpoint) => endpoint.endpointId,
    ),
    ["claude-api"],
  );

  const subscriptionResolved = stateWith(
    facadeProfile({ "claude-code-desktop": READY }, [
      endpointOption("claude-code-desktop", CLAUDE_SUBSCRIPTION_MODELS),
    ]),
  );
  const subscriptionRow = directFacadeEndpointStatusRows(
    subscriptionResolved.profile,
  ).find((row) => row.runtimeFamilyLabel === "Claude");
  assert.ok(subscriptionRow);
  assert.equal(subscriptionRow.endpointId, "claude-code-desktop");
  assert.equal(subscriptionRow.endpointLabel, "Subscription");
});

test("codex facade follows the same subscription-first rule", () => {
  const apiOnly = stateWith(
    facadeProfile({ "codex-api": READY }, [
      endpointOption("codex-api", CODEX_API_MODELS),
    ]),
  );
  assert.equal(
    resolveFamilyFacadeBackend(apiOnly.profile, "codex"),
    "codex-api",
  );
  assert.equal(
    resolveFamilyFacadeBackend(apiOnly.profile, "codex", undefined, {
      "codex-desktop": { authentication: "bound" },
    }),
    "codex-desktop",
  );
  const subscriptionDiscovery = stateWith(
    facadeProfile(
      { "codex-desktop": READY, "codex-api": READY },
      [
        endpointOption("codex-desktop", CODEX_SUBSCRIPTION_MODELS),
        endpointOption("codex-api", CODEX_API_MODELS),
      ],
    ),
  );
  assert.equal(
    resolveFamilyFacadeBackend(subscriptionDiscovery.profile, "codex"),
    "codex-desktop",
    "a catalog-ready desktop discovery proves the subscription with no report",
  );
});

test("with neither backend usable the family shows one unconfigured row that guides to its settings card", () => {
  const unconfigured = stateWith(facadeProfile({}, []));
  const rows = directFacadeEndpointStatusRows(unconfigured.profile);

  const claudeRow = rows.find(
    (row) => row.runtimeFamilyLabel === "Claude",
  );
  assert.ok(claudeRow);
  assert.equal(claudeRow.endpoint, null, "unconfigured is not selectable");
  assert.equal(claudeRow.detail, claudeFacadeUnconfiguredDetail());
  assert.match(claudeFacadeUnconfiguredDetail(), /Claude card in Settings/u);
  assert.doesNotMatch(claudeRow.detail, /official provider flow/u);

  const codexRow = rows.find((row) => row.runtimeFamilyLabel === "Codex");
  assert.ok(codexRow);
  assert.equal(codexRow.detail, codexFacadeUnconfiguredDetail());
  assert.match(codexFacadeUnconfiguredDetail(), /Codex card in Settings/u);

  const kimiRow = rows.find((row) => row.runtimeFamilyLabel === "Kimi");
  assert.ok(kimiRow);
  assert.equal(kimiRow.detail, kimiFacadeUnconfiguredDetail());

  // No family backend is selectable while unconfigured.
  const pickerEndpoints = directFacadeProfileEndpoints(unconfigured);
  assert.deepEqual(pickerEndpoints, []);
});

test("the facade roster collapses eight endpoints into five family entries in roster order", () => {
  const allReady = stateWith(
    facadeProfile(
      {
        "codex-desktop": READY,
        "claude-code-desktop": READY,
        "glm-coding-plan": READY,
        "kimi-code": READY,
        "deepseek-api": READY,
      },
      [
        endpointOption("codex-desktop", CODEX_SUBSCRIPTION_MODELS),
        endpointOption("claude-code-desktop", CLAUDE_SUBSCRIPTION_MODELS),
        endpointOption("glm-coding-plan", [model("glm-coding-plan", "glm-5.3[1m]")]),
        endpointOption("kimi-code", KIMI_CODE_MODELS),
        endpointOption("deepseek-api", [model("deepseek-api", "deepseek-v4-pro[1m]")]),
      ],
    ),
  );
  const rows = directFacadeEndpointStatusRows(allReady.profile);
  assert.deepEqual(
    rows.map((row) => [row.runtimeFamilyLabel, row.endpointId]),
    [
      ["Codex", "codex-desktop"],
      ["Claude", "claude-code-desktop"],
      ["GLM", "glm-coding-plan"],
      ["Kimi", "kimi-code"],
      ["DeepSeek", "deepseek-api"],
    ],
    "five family entries in roster order (first-registered position)",
  );
  // The raw roster still carries all eight rows — the facade is a
  // presentation merge, never a data-layer one.
  assert.equal(directEndpointStatusRows(allReady.profile).length, 8);
});

test("resolution never treats not-inspected as usable, and never probes", () => {
  const unknown = stateWith(
    facadeProfile(
      {
        "codex-desktop": NOT_INSPECTED,
        "claude-code-desktop": NOT_INSPECTED,
        "claude-api": NOT_INSPECTED,
        "kimi-code": NOT_INSPECTED,
        "kimi-platform": NOT_INSPECTED,
      },
      [],
    ),
  );
  assert.equal(
    resolveFamilyFacadeBackend(unknown.profile, "kimi"),
    null,
  );
  assert.equal(
    resolveFamilyFacadeBackend(unknown.profile, "claude"),
    null,
  );
  assert.equal(
    resolveFamilyFacadeBackend(unknown.profile, "codex"),
    null,
  );
});

test("dead-copy regression: the official-provider-flow sentence lives only on subscription faces", () => {
  const discovery = publicRuntimeEndpointDiscovery(
    (
      [
        "codex-desktop",
        "claude-code-desktop",
        "glm-coding-plan",
        "kimi-code",
        "deepseek-api",
        "kimi-platform",
        "claude-api",
        "codex-api",
      ] as const
    ).map((endpointId) => ({ endpointId, category: AUTH })),
  );
  const state = stateWith({
    ok: false,
    endpointDiscovery: discovery,
    error: {
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
    },
  });
  const rows = directEndpointStatusRows(state.profile);
  const detailOf = (endpointId: string): string => {
    const row = rows.find((candidate) => candidate.endpointId === endpointId);
    assert.ok(row, `${endpointId} row renders`);
    return row.detail;
  };

  // Subscription faces carry the login-action sentence.
  for (const endpointId of ["codex-desktop", "claude-code-desktop"]) {
    assert.equal(
      detailOf(endpointId),
      "Sign-in remains in the official provider flow.",
    );
  }
  // API-key faces carry the key guidance instead — the sentence and the real
  // action can no longer disagree (ticket 20 bug ruling).
  for (const endpointId of [
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
    "kimi-platform",
    "claude-api",
    "codex-api",
  ]) {
    assert.equal(detailOf(endpointId), endpointApiKeyAuthenticationDetail());
    assert.doesNotMatch(detailOf(endpointId), /official provider flow/u);
  }
});

test("the picker copy assembled from facade rows never carries the subscription sentence for key faces", async () => {
  // Source-level regression pin (same tradition as the mounted-probe
  // fixtures): the composer's endpoint picker renders the facade rows, and
  // the copy modules contain no official-flow wording on API-key entries.
  const [composerSource, runtimeProfileCopySource] = await Promise.all([
    readFile(
      new URL(
        "../../src/workbench-shell/renderer/composer.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/renderer/copy/runtime-profile-copy.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(
    composerSource,
    /directFacadeEndpointStatusRows\(/u,
    "the picker list is built from the facade rows",
  );
  assert.match(
    composerSource,
    /directFacadeProfileEndpoints\(/u,
    "the picker's selectable list is the facade list",
  );
  // The api-key sentence and every family's unconfigured guidance exist
  // exactly once per locale (dictionary entries are indented; the column-0
  // export does not count).
  assert.equal(
    runtimeProfileCopySource.match(/\n\s+apiKeyAuthenticationDetail:/gu)?.length,
    2,
  );
  for (const key of [
    "kimiFacadeUnconfiguredDetail",
    "claudeFacadeUnconfiguredDetail",
    "codexFacadeUnconfiguredDetail",
  ]) {
    assert.equal(
      runtimeProfileCopySource.match(new RegExp(`\\n\\s+${key}:`, "gu"))?.length,
      2,
      `${key} is bilingual (EN + ZH dictionary entries)`,
    );
  }
  // The bilingual segment names: ZH carries 订阅 for both subscription
  // sides; "API" is shared by both API sides in both locales (4 = 2 sides
  // × 2 dictionaries); EN "Subscription" mirrors 订阅.
  assert.equal(
    runtimeProfileCopySource.match(/endpointLabel: "订阅"/gu)?.length,
    2,
  );
  assert.equal(
    runtimeProfileCopySource.match(/endpointLabel: "API"/gu)?.length,
    4,
  );
  assert.equal(
    runtimeProfileCopySource.match(/endpointLabel: "平台"/gu)?.length,
    1,
  );
});
