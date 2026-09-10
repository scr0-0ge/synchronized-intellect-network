import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  ClaudeDiagnosticError,
  type ClaudeRuntimeDiagnostic,
} from "../../src/agent-runtime/claude/diagnostics.ts";
import { CoordinatorError } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import {
  createProductionRuntimeEndpointAdapter,
  discoverRuntimeEndpointComposition,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import type {
  WorkbenchDirectInputRequest,
  WorkbenchProjectResult,
} from "../../src/workbench-shell/contract.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";
import { locateClaudeRuntimeForThisTestFile } from "../helpers/vendor-cli-presence.ts";

// The claude-api endpoint's discovery category depends on whether a Claude CLI
// exists on this machine; the seam turns that into an injected input. See
// tests/helpers/vendor-cli-presence.ts.
locateClaudeRuntimeForThisTestFile();

async function createRegisteredWorkbenchBackend(
  context: TestContext,
  options: Parameters<typeof createWorkbenchBackend>[0],
) {
  const backend = await createWorkbenchBackend(options);
  registerTestClosable(context, backend);
  return backend;
}

const codexCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: "codex-model",
      displayName: "Codex model",
      effortLevels: Object.freeze(["ultra"]),
      effortLevelLabels: Object.freeze(["Ultra"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});
const claudeCatalog = Object.freeze({
  runtime: "claude",
  models: Object.freeze([
    Object.freeze({
      id: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default (recommended)",
      effortLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
      effortLevelLabels: Object.freeze([
        "Low description",
        "Medium description",
        "High description",
        "Extra-high description",
        "Maximum description",
      ]),
    }),
    Object.freeze({
      id: "opus[1m]",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Opus (1M context)",
      effortLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    }),
    Object.freeze({
      id: "claude-fable-5[1m]",
      resolvedModel: "claude-fable-5",
      displayName: "Fable",
      effortLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    }),
    Object.freeze({
      id: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      effortLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
    }),
    Object.freeze({
      id: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      effortLevels: Object.freeze(["default"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});
const claudeUltracodeCatalog: RuntimeCatalog = Object.freeze({
  ...claudeCatalog,
  models: Object.freeze(
    claudeCatalog.models.map((model) =>
      model.effortLevels.includes("xhigh")
        ? Object.freeze({
            ...model,
            workIntensityVariants: Object.freeze([
              Object.freeze({
                value: "ultracode",
                label: "ultracode",
                nativeEffortLevel: "xhigh",
                baseExecutionMode: "single-agent",
                executionMode: "ultracode",
              }),
            ]),
          })
        : model,
    ),
  ),
});

const historicalNativeModel = "codex-historical-native-model";
const historicalNativeEffort = "historical-native-effort";
const currentNativeModel = "codex-current-native-model";
const currentNativeEffort = "current-native-effort";
const historicalOpaqueSessionReference =
  "opaque-session-created-against-historical-catalog";
const historicalNativeProfile: SessionProfile = Object.freeze({
  model: historicalNativeModel,
  effortLevel: historicalNativeEffort,
  executionMode: "single-agent",
  accessMode: "full-access",
});
const historicalCodexCatalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: historicalNativeModel,
      effortLevels: Object.freeze([historicalNativeEffort]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});
const currentCodexCatalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: currentNativeModel,
      effortLevels: Object.freeze([currentNativeEffort]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

test("production composition renders each of the four independent availability combinations", async (t) => {
  const combinations = [
    {
      name: "both available",
      codex: true,
      claude: true,
      expected: ["Codex", "Claude"],
      expectedCategories: ["catalog-ready", "catalog-ready"],
    },
    {
      name: "Claude unavailable",
      codex: true,
      claude: false,
      expected: ["Codex"],
      expectedCategories: ["catalog-ready", "inspection-failed"],
    },
    {
      name: "Codex unavailable",
      codex: false,
      claude: true,
      expected: ["Claude"],
      expectedCategories: ["inspection-failed", "catalog-ready"],
    },
    {
      name: "neither available",
      codex: false,
      claude: false,
      expected: [],
      expectedCategories: ["inspection-failed", "inspection-failed"],
    },
  ] as const;

  for (const combination of combinations) {
    await t.test(combination.name, async (subtest) => {
      const root = await createTestDirectory(
        subtest,
        join(tmpdir(), "endpoint-composition-"),
      );
      const projectDirectory = join(root, "Project");
      await mkdir(projectDirectory);
      const codex = new MutableCatalogAdapter(codexCatalog, combination.codex);
      const claude = new MutableCatalogAdapter(
        claudeCatalog,
        combination.claude,
      );
      const adapter = await createProductionRuntimeEndpointAdapter({
        codexAdapter: codex,
        claudeAdapter: claude,
        glmEnvironment: {},
        kimiEnvironment: {},
        deepseekEnvironment: {},
        kimiPlatformEnvironment: {},
        claudeApiEnvironment: {},
        codexApiEnvironment: {},
      });
      assert.equal(codex.inspectCalls, 0);
      assert.equal(claude.inspectCalls, 0);
      const backend = await createRegisteredWorkbenchBackend(subtest, {
        projectDirectory,
        databasePath: join(root, "project.sqlite"),
        preferencePath: join(root, "preferences.json"),
        adapter,
      });
      const loaded = await backend.loadDirectSessionProfile();

      assert.equal(codex.inspectCalls, 1);
      assert.equal(claude.inspectCalls, 1);
      assert.deepEqual(loaded.endpointDiscovery, {
          statuses: [
            {
              endpointId: "codex-desktop",
              category: combination.expectedCategories[0],
            },
            {
              endpointId: "claude-code-desktop",
              category: combination.expectedCategories[1],
            },
            {
              endpointId: "glm-coding-plan",
              category: "authentication-required",
            },
            {
              endpointId: "kimi-code",
              category: "authentication-required",
            },
            {
              endpointId: "deepseek-api",
              category: "authentication-required",
            },
            {
              endpointId: "kimi-platform",
              category: "authentication-required",
            },
            {
              endpointId: "claude-api",
              category: "authentication-required",
            },
            {
              endpointId: "codex-api",
              category: "authentication-required",
            },
          ],
        });
      if (combination.expected.length === 0) {
        assert.deepEqual(loaded, {
          ok: false,
          error: {
            category: "profile-unavailable",
            message:
              "Codex Session Profile options are unavailable. Keep your draft and try again.",
          },
          endpointDiscovery: {
            statuses: [
              {
                endpointId: "codex-desktop",
                category: "inspection-failed",
              },
              {
                endpointId: "claude-code-desktop",
                category: "inspection-failed",
              },
              {
                endpointId: "glm-coding-plan",
                category: "authentication-required",
              },
              {
                endpointId: "kimi-code",
                category: "authentication-required",
              },
              {
                endpointId: "deepseek-api",
                category: "authentication-required",
              },
              {
                endpointId: "kimi-platform",
                category: "authentication-required",
              },
              {
                endpointId: "claude-api",
                category: "authentication-required",
              },
              {
                endpointId: "codex-api",
                category: "authentication-required",
              },
            ],
          },
        });
      } else {
        assert.equal(loaded.ok, true);
        if (!loaded.ok) throw new Error("profile unexpectedly unavailable");
        assert.deepEqual(
          loaded.profile.endpoints.map((endpoint) =>
            endpoint.runtimeFamilyLabel,
          ),
          combination.expected,
        );
        assert.deepEqual(
          loaded.profile.endpoints.map((endpoint) => endpoint.endpointId),
          [
            ...(combination.codex ? ["codex-desktop"] : []),
            ...(combination.claude ? ["claude-code-desktop"] : []),
          ],
        );
        assert.deepEqual(Reflect.ownKeys(loaded).sort(), [
          "endpointDiscovery",
          "ok",
          "profile",
        ]);
        assert.deepEqual(
          Object.keys(loaded.profile).sort(),
          ["desiredDefault", "endpoints", "snapshotKey"].sort(),
        );
        for (const endpoint of loaded.profile.endpoints) {
          assert.deepEqual(
            Reflect.ownKeys(endpoint).sort(),
            [
              "accessModes",
              "endpointLabel",
              "executionModes",
              "endpointId",
              "key",
              "models",
              "runtimeFamilyLabel",
            ].sort(),
          );
        }
        const claudeEndpoint = loaded.profile.endpoints.find(
          (endpoint) => endpoint.runtimeFamilyLabel === "Claude",
        );
        if (claudeEndpoint !== undefined) {
          assert.deepEqual(
            claudeEndpoint.models.map((model) => ({
              label: model.label,
              provenanceLabel: model.provenanceLabel,
              workIntensities: model.workIntensities.map((option) => option.label),
            })),
            [
              {
                label: "Opus 5",
                provenanceLabel: null,
                workIntensities: ["low", "medium", "high", "xhigh", "max"],
              },
              {
                label: "Fable 5",
                provenanceLabel: null,
                workIntensities: ["low", "medium", "high", "xhigh", "max"],
              },
              {
                label: "Sonnet 5",
                provenanceLabel: null,
                workIntensities: ["low", "medium", "high", "xhigh", "max"],
              },
              {
                label: "Haiku 4.5",
                provenanceLabel: null,
                workIntensities: ["default"],
              },
            ],
          );
          assert.equal(
            JSON.stringify(claudeEndpoint.models).includes(
              "Default (recommended)",
            ),
            false,
          );
        }
        const serialized = JSON.stringify(loaded);
        assert.equal(serialized.includes("PRIVATE_CLAUDE_MODEL"), false);
        assert.equal(serialized.includes("nativeRuntimeProfile"), false);
        assert.equal(serialized.includes("directStart"), false);
      }
      await backend.close();
    });
  }
});

test("production discovery maps not-located, authentication, and opaque inspection failures per endpoint", async (t) => {
  const rows = [
    {
      name: "both desktop runtimes are not located",
      codexFailure: "runtime-not-located",
      claudeFailure: "runtime-not-located",
      expected: ["runtime-not-located", "runtime-not-located"],
    },
    {
      name: "Codex authentication is distinguished while Claude is not located",
      codexFailure: "authentication-required",
      claudeFailure: "runtime-not-located",
      expected: ["authentication-required", "runtime-not-located"],
    },
    {
      name: "arbitrary Codex failure and Claude subscription authentication required",
      codexFailure: "arbitrary",
      claudeFailure: "authentication-required",
      expected: ["inspection-failed", "authentication-required"],
    },
  ] as const;

  for (const row of rows) {
    await t.test(row.name, async () => {
      const discovery = await discoverRuntimeEndpointComposition({
        projectDirectory: "project",
        codexAdapter: new MutableCatalogAdapter(
          codexCatalog,
          false,
          row.codexFailure,
        ),
        claudeAdapter: new MutableCatalogAdapter(
          claudeCatalog,
          false,
          row.claudeFailure,
        ),
        glmEnvironment: {},
        kimiEnvironment: {},
        deepseekEnvironment: {},
        kimiPlatformEnvironment: {},
        claudeApiEnvironment: {},
        codexApiEnvironment: {},
      });

      assert.deepEqual(discovery.endpoints, []);
      assert.deepEqual(discovery.registrations, []);
      assert.deepEqual(
        discovery.endpointDiscovery.statuses.map((status) => status.category),
        [...row.expected, "authentication-required", "authentication-required", "authentication-required", "authentication-required", "authentication-required", "authentication-required"],
      );
      assert.deepEqual(
        discovery.endpointDiscovery.statuses.map((status) => status.endpointId),
        ["codex-desktop", "claude-code-desktop", "glm-coding-plan", "kimi-code", "deepseek-api", "kimi-platform", "claude-api", "codex-api"],
      );
      assert.equal(JSON.stringify(discovery).includes("PRIVATE_"), false);
    });
  }
});

test("Claude credential and catalog-shape failures remain publicly fixed but are privately distinguishable in production composition", async () => {
  const rows: readonly {
    readonly error: ClaudeDiagnosticError;
    readonly expectedPublicCategory: "authentication-required" | "inspection-failed";
    readonly expectedPrivateKind: ClaudeRuntimeDiagnostic["kind"];
  }[] = [
    {
      error: new ClaudeDiagnosticError("authentication-required", {
        kind: "authentication-status",
        category: "authentication-required",
        state: "sign-in-required",
        detail: "PRIVATE_EXPIRED_CREDENTIAL_DETAIL",
      }),
      expectedPublicCategory: "authentication-required",
      expectedPrivateKind: "authentication-status",
    },
    {
      error: new ClaudeDiagnosticError("catalog-invalid", {
        kind: "catalog-shape-rejected",
        category: "catalog-invalid",
        gate: "models",
        row: 2,
        addedKeys: ["futureUnadmittedField"],
        missingKeys: [],
        invalidKeys: [],
        detail: "PRIVATE_NATIVE_CATALOG_ROW",
      }),
      expectedPublicCategory: "inspection-failed",
      expectedPrivateKind: "catalog-shape-rejected",
    },
  ];

  for (const row of rows) {
    const diagnostics: ClaudeRuntimeDiagnostic[] = [];
    const discovery = await discoverRuntimeEndpointComposition({
      projectDirectory: "project",
      codexAdapter: new MutableCatalogAdapter(codexCatalog, true),
      claudeAdapter: new DiagnosticFailureAdapter(row.error),
      claudeDiagnosticObserver: (diagnostic) => diagnostics.push(diagnostic),
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    });

    assert.deepEqual(
      discovery.endpointDiscovery.statuses.map((status) => status.category),
      [
        "catalog-ready",
        row.expectedPublicCategory,
        "authentication-required",
        "authentication-required",
        "authentication-required",
        "authentication-required",
        "authentication-required",
        "authentication-required",
      ],
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.kind, row.expectedPrivateKind);
    assert.equal(JSON.stringify(discovery).includes("PRIVATE_"), false);
    assert.equal(JSON.stringify(discovery).includes("futureUnadmittedField"), false);
  }
});

test("two not-located outcomes produce the exact aggregate Runtime-not-located result", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-composition-not-located-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: new MutableCatalogAdapter(
        codexCatalog,
        false,
        "runtime-not-located",
      ),
      claudeAdapter: new MutableCatalogAdapter(
        claudeCatalog,
        false,
        "runtime-not-located",
      ),
      // The GLM endpoint rides the same claude CLI: when that runtime is not
      // located, all six endpoints report it and the aggregate holds.
      glmAdapter: new MutableCatalogAdapter(
        claudeCatalog,
        false,
        "runtime-not-located",
      ),
      kimiAdapter: new MutableCatalogAdapter(
        claudeCatalog,
        false,
        "runtime-not-located",
      ),
      deepseekAdapter: new MutableCatalogAdapter(
        claudeCatalog,
        false,
        "runtime-not-located",
      ),
      kimiPlatformAdapter: new MutableCatalogAdapter(
        codexCatalog,
        false,
        "runtime-not-located",
      ),
      claudeApiAdapter: new MutableCatalogAdapter(
        claudeCatalog,
        false,
        "runtime-not-located",
      ),
      codexApiAdapter: new MutableCatalogAdapter(
        codexCatalog,
        false,
        "runtime-not-located",
      ),
    }),
  });

  assert.deepEqual(await backend.loadDirectSessionProfile(), {
    ok: false,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "runtime-not-located" },
        {
          endpointId: "claude-code-desktop",
          category: "runtime-not-located",
        },
        { endpointId: "glm-coding-plan", category: "runtime-not-located" },
        { endpointId: "kimi-code", category: "runtime-not-located" },
        { endpointId: "deepseek-api", category: "runtime-not-located" },
        { endpointId: "kimi-platform", category: "runtime-not-located" },
        { endpointId: "claude-api", category: "runtime-not-located" },
        { endpointId: "codex-api", category: "runtime-not-located" },
      ],
    },
    error: {
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
    },
  });
  await backend.close();
});

test("a blocked project reports both fixed endpoints as not inspected without invoking either adapter", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-composition-blocked-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const codex = new MutableCatalogAdapter(codexCatalog, true);
  const claude = new MutableCatalogAdapter(claudeCatalog, true);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: codex,
      claudeAdapter: claude,
      blockedProjectDirectory: projectDirectory,
      glmAdapter: new MutableCatalogAdapter(claudeCatalog, true),
    }),
  });

  assert.deepEqual(await backend.loadDirectSessionProfile(), {
    ok: false,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "not-inspected" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
        { endpointId: "glm-coding-plan", category: "not-inspected" },
        { endpointId: "kimi-code", category: "not-inspected" },
        { endpointId: "deepseek-api", category: "not-inspected" },
        { endpointId: "kimi-platform", category: "not-inspected" },
        { endpointId: "claude-api", category: "not-inspected" },
        { endpointId: "codex-api", category: "not-inspected" },
      ],
    },
    error: {
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
    },
  });
  assert.equal(codex.inspectCalls, 0);
  assert.equal(claude.inspectCalls, 0);
  await backend.close();
});

test("production registrations keep native Effort Levels when catalogs provide descriptive wording", async () => {
  const discovery = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new MutableCatalogAdapter(codexCatalog, true),
    claudeAdapter: new MutableCatalogAdapter(claudeCatalog, true),
    glmEnvironment: {},
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });
  const registrationLabels = discovery.registrations.flatMap((registration) =>
    registration.capabilitySnapshot.profiles.map(
      (profile) => profile.workIntensityLabel,
    ),
  );

  assert.equal(registrationLabels.includes("Ultra"), false);
  assert.equal(registrationLabels.includes("Low description"), false);
  assert.equal(registrationLabels.includes("ultra"), true);
  assert.equal(registrationLabels.includes("low"), true);
  assert.equal(registrationLabels.includes("max"), true);
});

test("production composition keeps ultracode on the intensity slider and resolves it privately to xhigh", async (t) => {
  const discovery = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new MutableCatalogAdapter(codexCatalog, false),
    claudeAdapter: new MutableCatalogAdapter(claudeUltracodeCatalog, true),
    glmEnvironment: {},
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });
  const endpoint = discovery.endpoints[0]!;
  const registration = discovery.registrations[0]!;
  assert.deepEqual(endpoint.catalog.executionModes, ["single-agent"]);
  assert.deepEqual(endpoint.catalog.models[0]?.effortLevelLabels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ]);
  const ultracodeRegistration = registration.capabilitySnapshot.profiles.find(
    (profile) => profile.workIntensityLabel === "ultracode",
  );
  assert.ok(ultracodeRegistration);
  assert.equal(ultracodeRegistration.runtimeProfile.executionMode, "single-agent");
  assert.equal(ultracodeRegistration.nativeRuntimeProfile?.effortLevel, "xhigh");
  assert.equal(
    ultracodeRegistration.nativeRuntimeProfile?.executionMode,
    "ultracode",
  );
  assert.deepEqual(endpoint.catalog.workIntensityExecutionModeCouplings, [
    {
      model: endpoint.catalog.models[0]!.id,
      workIntensity: endpoint.catalog.models[0]!.effortLevels.at(-1),
      executionMode: "single-agent",
    },
    {
      model: endpoint.catalog.models[1]!.id,
      workIntensity: endpoint.catalog.models[1]!.effortLevels.at(-1),
      executionMode: "single-agent",
    },
    {
      model: endpoint.catalog.models[2]!.id,
      workIntensity: endpoint.catalog.models[2]!.effortLevels.at(-1),
      executionMode: "single-agent",
    },
    {
      model: endpoint.catalog.models[3]!.id,
      workIntensity: endpoint.catalog.models[3]!.effortLevels.at(-1),
      executionMode: "single-agent",
    },
  ]);
  assert.equal(
    registration.capabilitySnapshot.profiles.some(
      (profile) =>
        profile.nativeRuntimeProfile?.effortLevel === "max" &&
        profile.nativeRuntimeProfile.executionMode === "ultracode",
    ),
    false,
  );

  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-ultracode-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const claude = new MutableCatalogAdapter(claudeUltracodeCatalog, true);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: new MutableCatalogAdapter(codexCatalog, false),
      claudeAdapter: claude,
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    }),
  });
  const loaded = await backend.loadDirectSessionProfile();
  if (!loaded.ok) throw new Error("profile unexpectedly unavailable");
  const publicEndpoint = loaded.profile.endpoints[0]!;
  const publicModel = publicEndpoint.models[0]!;
  const ultracode = publicModel.workIntensities.find(
    (intensity) => intensity.label === "ultracode",
  );
  assert.ok(ultracode);
  assert.equal(ultracode.impliedExecutionModeKey, publicEndpoint.executionModes[0]!.key);
  const accepted = await backend.submitDirectInput({
    kind: "start",
    input: "ultracode production mapping",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: publicEndpoint.key,
    modelKey: publicModel.key,
    workIntensityKey: ultracode.key,
    executionModeKey: publicEndpoint.executionModes[0]!.key,
    accessModeKey: publicEndpoint.accessModes[0]!.key,
  });
  assert.equal(accepted.ok, true);
  await waitFor(() => claude.startCalls === 1);
  assert.deepEqual(claude.starts[0]?.profile, {
    model: "default",
    effortLevel: "xhigh",
    executionMode: "ultracode",
    accessMode: "full-access",
  });
  await backend.close();
});

test("Claude product names use an exact map while a new resolved identity falls back without a mapping change", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-composition-new-model-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const futureClaudeCatalog: RuntimeCatalog = Object.freeze({
    ...claudeCatalog,
    models: Object.freeze([
      ...claudeCatalog.models,
      Object.freeze({
        id: "future-selector",
        resolvedModel: "claude-orbit-6",
        displayName: "Orbit",
        effortLevels: Object.freeze(["low", "medium", "high"]),
      }),
    ]),
  });
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: new MutableCatalogAdapter(codexCatalog, false),
      claudeAdapter: new MutableCatalogAdapter(futureClaudeCatalog, true),
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    }),
  });

  const loaded = await backend.loadDirectSessionProfile();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("profile unexpectedly unavailable");
  assert.deepEqual(
    loaded.profile.endpoints[0]!.models.map((model) => ({
      label: model.label,
      provenanceLabel: model.provenanceLabel,
    })),
    [
      { label: "Opus 5", provenanceLabel: null },
      { label: "Fable 5", provenanceLabel: null },
      { label: "Sonnet 5", provenanceLabel: null },
      { label: "Haiku 4.5", provenanceLabel: null },
      { label: "claude-orbit-6", provenanceLabel: "Orbit" },
    ],
  );
  assert.equal(loaded.profile.endpoints[0]!.models.length, 5);
  await backend.close();
});

test("production inspection remains fail-closed on every unadmitted model key, including promoListPrice leakage", async (t) => {
  for (const row of [
    { name: "unrelated native extra", patch: { nativeExtra: true } },
    {
      name: "unadmitted work-intensity variant key",
      patch: {
        workIntensityVariants: [
          {
            value: "ultracode",
            label: "ultracode",
            nativeEffortLevel: "xhigh",
            baseExecutionMode: "single-agent",
            executionMode: "ultracode",
            unadmitted: true,
          },
        ],
      },
    },
    { name: "promoListPrice leakage", patch: { promoListPrice: "$20" } },
    { name: "non-string resolved identity", patch: { resolvedModel: 42 } },
    {
      name: "URL-shaped resolved identity",
      patch: { resolvedModel: "https://invalid.example/model" },
    },
    {
      name: "path-shaped resolved identity",
      patch: { resolvedModel: "C:\\invalid\\model" },
    },
    {
      name: "bidi-bearing resolved identity",
      patch: { resolvedModel: "safe\u202ereversed" },
    },
  ] as const) {
    await t.test(row.name, async () => {
      const malformed: RuntimeCatalog = {
        ...claudeCatalog,
        models: [
          {
            ...claudeCatalog.models[0]!,
            ...row.patch,
          },
        ],
      } as RuntimeCatalog;
      const discovery = await discoverRuntimeEndpointComposition({
        projectDirectory: "project",
        codexAdapter: new MutableCatalogAdapter(codexCatalog, false),
        claudeAdapter: new MutableCatalogAdapter(malformed, true),
        glmEnvironment: {},
        kimiEnvironment: {},
        deepseekEnvironment: {},
        kimiPlatformEnvironment: {},
        claudeApiEnvironment: {},
        codexApiEnvironment: {},
      });
      assert.deepEqual(discovery.endpoints, []);
      assert.deepEqual(discovery.registrations, []);
      assert.deepEqual(
        discovery.endpointDiscovery.statuses.map((status) => status.category),
        [
          "inspection-failed",
          "inspection-failed",
          "authentication-required",
          "authentication-required",
          "authentication-required",
          "authentication-required",
          "authentication-required",
          "authentication-required",
        ],
      );
    });
  }
});

test("a Claude selection is durably accepted and uses the Claude Runtime without disturbing Codex", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-composition-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const codex = new MutableCatalogAdapter(codexCatalog, true);
  const claude = new MutableCatalogAdapter(claudeCatalog, true);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: codex,
      claudeAdapter: claude,
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    }),
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  const loaded = await backend.loadDirectSessionProfile();
  if (!loaded.ok) throw new Error("profile unexpectedly unavailable");
  const claudeEndpoint = loaded.profile.endpoints.find(
    (endpoint) => endpoint.runtimeFamilyLabel === "Claude",
  )!;
  const request = requestFor(
    loaded.profile.snapshotKey,
    claudeEndpoint,
    "Claude starts through the composed endpoint",
  );
  const accepted = await backend.submitDirectInput(request);

  assert.deepEqual(accepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.equal(Object.isFrozen(accepted), true);
  await waitFor(() => claude.startCalls === 1);
  assert.equal(codex.startCalls, 0);
  await waitFor(() => {
    const latest = observed.at(-1);
    return (
      latest?.ok === true &&
      latest.view.commands.length === 1 &&
      latest.view.commands[0]?.status === "completed"
    );
  });
  const latest = observed.at(-1);
  assert.equal(latest?.ok, true);
  if (!latest?.ok) throw new Error("project view unexpectedly unavailable");
  assert.deepEqual(latest.view.commands[0]?.session?.timeline, [
    {
      kind: "user-message",
      text: "Claude starts through the composed endpoint",
    },
    { kind: "session-started" },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.deepEqual(latest.view.commands[0]?.session?.profile, {
    requested: {
      kind: "recorded",
      runtimeFamilyLabel: "Claude",
      // Ticket 25 facade naming: short segment name, family carries brand.
      endpointLabel: "Subscription",
      modelLabel: "Opus 5",
      workIntensityControlLabel: {
        label: null,
        provenance: "not-recorded",
      },
      workIntensityLabel: "low",
      executionModeLabel: "Single agent",
      accessModeLabel: "Full access",
    },
    effective: {
      kind: "observed",
      provenance: "post-turn-observation",
      model: {
        label: "Opus 5",
        comparison: "matches-requested",
      },
      workIntensity: {
        label: "low",
        comparison: "matches-requested",
      },
      accessMode: {
        label: "Full access",
        comparison: "matches-requested",
      },
    },
  });

  const refreshed = await backend.loadDirectSessionProfile();
  if (!refreshed.ok) throw new Error("profile unexpectedly unavailable");
  const codexEndpoint = refreshed.profile.endpoints.find(
    (endpoint) => endpoint.runtimeFamilyLabel === "Codex",
  )!;
  assert.equal(
    (
      await backend.submitDirectInput(
        requestFor(
          refreshed.profile.snapshotKey,
          codexEndpoint,
          "Codex remains available",
        ),
      )
    ).ok,
    true,
  );
  dispose();
  await backend.close();
});

test("a fresh production composition continues one Session through its stored catalog A identity after catalog B omits it", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-continuation-drift-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "project.sqlite");
  const preferencePath = join(root, "preferences.json");
  await mkdir(projectDirectory);

  const historicalCodex = await persistHistoricalProductionSession({
    projectDirectory,
    databasePath,
    preferencePath,
  });
  const currentCodex = new MutableCatalogAdapter(
    currentCodexCatalog,
    true,
  );
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    preferencePath,
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: currentCodex,
      claudeAdapter: new MutableCatalogAdapter(claudeCatalog, false),
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    }),
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  try {
    await waitFor(() => {
      const latest = observed.at(-1);
      return (
        latest?.ok === true &&
        latest.view.commands.length === 1 &&
        latest.view.commands[0]?.status === "completed"
      );
    });
    const reopened = observed.at(-1);
    if (!reopened?.ok) throw new Error("persisted Project unexpectedly unavailable");
    const selectionKey = reopened.view.commands[0]?.session?.selectionKey;
    if (typeof selectionKey !== "string") {
      assert.fail("persisted Session did not expose a continuation capability");
    }

    const loaded = await backend.loadDirectSessionProfile({
      kind: "continuation-session",
      selectionKey,
    });
    assert.equal(
      loaded.ok,
      true,
      "catalog B must not strand a Session durably created against catalog A",
    );
    if (!loaded.ok) assert.fail("stored continuation identity was unavailable");
    const endpoint = loaded.profile.endpoints[0];
    const prefill = loaded.profile.continuationPrefill;
    const selectedModel = endpoint.models.find(
      (model) => model.key === prefill.modelKey,
    );
    const selectedIntensity = selectedModel?.workIntensities.find(
      (intensity) => intensity.key === prefill.workIntensityKey,
    );
    assert.deepEqual(
      {
        endpointId: endpoint.endpointId,
        endpointPrefilled: endpoint.key === prefill.endpointKey,
        modelLabel: selectedModel?.label,
        intensityLabel: selectedIntensity?.label,
        currentCatalogStillVisible: endpoint.models.some(
          (model) => model.label === currentNativeModel,
        ),
      },
      {
        endpointId: "codex-desktop",
        endpointPrefilled: true,
        modelLabel: historicalNativeModel,
        intensityLabel: historicalNativeEffort,
        currentCatalogStillVisible: true,
      },
    );
    if (selectedModel === undefined || selectedIntensity === undefined) {
      assert.fail("stored model and Work Intensity were not surfaced");
    }

    assert.deepEqual(
      await backend.submitDirectInput({
        kind: "continue",
        input: "continue through the stored production identity",
        selectionKey,
        snapshotKey: loaded.profile.snapshotKey,
        endpointKey: prefill.endpointKey,
        modelKey: selectedModel.key,
        workIntensityKey: selectedIntensity.key,
        executionModeKey: prefill.executionModeKey,
        accessModeKey: prefill.accessModeKey,
      }),
      {
        ok: true,
        status: "accepted",
        message: "Direct input was durably accepted.",
      },
    );
    await waitFor(() => currentCodex.resumes.length === 1);
    assert.deepEqual(currentCodex.resumes, [
      {
        projectDirectory,
        profile: historicalNativeProfile,
        opaqueSessionReference: historicalOpaqueSessionReference,
      },
    ]);
    assert.equal(currentCodex.startCalls, 0);
    assert.equal(historicalCodex.resumes.length, 0);
  } finally {
    dispose();
    await backend.close();
  }
});

test("deleting a digest-bound durable native identity makes the corrupted store fail closed", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-continuation-legacy-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "project.sqlite");
  const preferencePath = join(root, "preferences.json");
  await mkdir(projectDirectory);

  await persistHistoricalProductionSession({
    projectDirectory,
    databasePath,
    preferencePath,
  });
  tamperByRemovingStartRuntimeResumeIdentity(databasePath);

  const currentCodex = new MutableCatalogAdapter(
    currentCodexCatalog,
    true,
  );
  await assert.rejects(
    createRegisteredWorkbenchBackend(t, {
      projectDirectory,
      databasePath,
      preferencePath,
      adapter: await createProductionRuntimeEndpointAdapter({
        codexAdapter: currentCodex,
        claudeAdapter: new MutableCatalogAdapter(claudeCatalog, false),
        glmEnvironment: {},
        kimiEnvironment: {},
        deepseekEnvironment: {},
        kimiPlatformEnvironment: {},
        claudeApiEnvironment: {},
        codexApiEnvironment: {},
      }),
    }),
    (error) =>
      error instanceof CoordinatorError && error.category === "storage-failed",
  );
  assert.equal(currentCodex.resumes.length, 0);
});

async function waitFor(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  assert.fail("condition was not observed");
}

async function persistHistoricalProductionSession(options: {
  readonly projectDirectory: string;
  readonly databasePath: string;
  readonly preferencePath: string;
}): Promise<MutableCatalogAdapter> {
  const historicalCodex = new MutableCatalogAdapter(
    historicalCodexCatalog,
    true,
    "runtime-unavailable",
    historicalOpaqueSessionReference,
  );
  const backend = await createWorkbenchBackend({
    projectDirectory: options.projectDirectory,
    databasePath: options.databasePath,
    preferencePath: options.preferencePath,
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: historicalCodex,
      claudeAdapter: new MutableCatalogAdapter(claudeCatalog, false),
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    }),
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  try {
    const loaded = await backend.loadDirectSessionProfile();
    if (!loaded.ok) throw new Error("historical catalog unexpectedly unavailable");
    const endpoint = loaded.profile.endpoints.find(
      (candidate) => candidate.endpointId === "codex-desktop",
    );
    if (endpoint === undefined) throw new Error("historical endpoint unavailable");
    assert.equal(
      (
        await backend.submitDirectInput(
          requestFor(
            loaded.profile.snapshotKey,
            endpoint,
            "persist one catalog A Agent Session",
          ),
        )
      ).ok,
      true,
    );
    await waitFor(() => {
      const latest = observed.at(-1);
      return (
        latest?.ok === true &&
        latest.view.commands.length === 1 &&
        latest.view.commands[0]?.status === "completed"
      );
    });
    assert.deepEqual(historicalCodex.starts, [
      {
        projectDirectory: options.projectDirectory,
        profile: historicalNativeProfile,
      },
    ]);
  } finally {
    dispose();
    await backend.close();
  }
  return historicalCodex;
}

function tamperByRemovingStartRuntimeResumeIdentity(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT command_id, private_envelope_json
           FROM commands
          WHERE command_kind = 'start'`,
      )
      .get() as
      | {
          readonly command_id: string;
          readonly private_envelope_json: string;
        }
      | undefined;
    if (row === undefined) assert.fail("missing persisted start command");
    const envelope = JSON.parse(row.private_envelope_json) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(envelope, "runtimeResumeIdentity"), true);
    delete envelope.runtimeResumeIdentity;
    const updated = database
      .prepare(
        "UPDATE commands SET private_envelope_json = ? WHERE command_id = ?",
      )
      .run(JSON.stringify(envelope), row.command_id);
    assert.equal(Number(updated.changes), 1);
  } finally {
    database.close();
  }
}

/*
 * The source below intentionally keeps the next test adjacent to the Claude
 * start case: both exercise production composition, while the adapter tests
 * own provider-wire behavior.
 */
test("profile reload rechecks availability and sparse display fallback is isolated per endpoint", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "endpoint-composition-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const codex = new MutableCatalogAdapter(codexCatalog, true);
  const claude = new MutableCatalogAdapter(
    {
      ...claudeCatalog,
      models: [
        {
          id: "sparse-native-claude-model",
          effortLevels: ["xhigh"],
        },
      ],
    },
    true,
  );
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: codex,
      claudeAdapter: claude,
      glmEnvironment: {},
      kimiEnvironment: {},
      deepseekEnvironment: {},
      kimiPlatformEnvironment: {},
      claudeApiEnvironment: {},
      codexApiEnvironment: {},
    }),
  });
  const first = await backend.loadDirectSessionProfile();
  assert.equal(first.ok, true);
  assert.deepEqual(
    first.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "catalog-ready",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
    ],
  );
  assert.equal(
    first.ok
      ? first.profile.endpoints[1]?.models[0]?.label
      : undefined,
    "sparse-native-claude-model",
  );
  claude.available = false;
  const second = await backend.loadDirectSessionProfile();
  assert.deepEqual(
    second.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "inspection-failed",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
    ],
  );
  assert.deepEqual(
    second.ok
      ? second.profile.endpoints.map((endpoint) => endpoint.runtimeFamilyLabel)
      : [],
    ["Codex"],
  );
  assert.equal(codex.inspectCalls, 2);
  assert.equal(claude.inspectCalls, 2);
  await backend.close();

  const isolated = await discoverRuntimeEndpointComposition({
    projectDirectory,
    codexAdapter: new MutableCatalogAdapter(codexCatalog, true),
    claudeAdapter: new MutableCatalogAdapter(
      {
        ...claudeCatalog,
        models: [
          {
            id: "https://PRIVATE.invalid/model",
            effortLevels: ["high"],
          },
        ],
      },
      true,
    ),
    glmEnvironment: {},
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });
  assert.deepEqual(
    isolated.endpoints.map((endpoint) => endpoint.runtimeFamilyLabel),
    ["Codex"],
  );
  assert.deepEqual(
    isolated.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "inspection-failed",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
    ],
  );
});

type InspectionFailure =
  | "runtime-unavailable"
  | "runtime-not-located"
  | "authentication-required"
  | "arbitrary";

class MutableCatalogAdapter implements ResumableAgentRuntimeAdapter {
  available: boolean;
  inspectCalls = 0;
  startCalls = 0;
  readonly starts: RuntimeStart[] = [];
  readonly resumes: RuntimeResume[] = [];
  readonly catalog: RuntimeCatalog;
  readonly inspectionFailure: InspectionFailure;
  readonly opaqueSessionReference: string;

  constructor(
    catalog: RuntimeCatalog,
    available: boolean,
    inspectionFailure: InspectionFailure = "runtime-unavailable",
    opaqueSessionReference = "opaque-test-session",
  ) {
    this.catalog = catalog;
    this.available = available;
    this.inspectionFailure = inspectionFailure;
    this.opaqueSessionReference = opaqueSessionReference;
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (!this.available) {
      if (this.inspectionFailure === "arbitrary") {
        throw new Error("PRIVATE_ARBITRARY_INSPECTION_FAILURE");
      }
      throw new RuntimeAdapterError(this.inspectionFailure);
    }
    return this.catalog;
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    this.starts.push(structuredClone(request));
    return new CompletedBinding(request.profile, this.opaqueSessionReference);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return new CompletedBinding(
      request.profile,
      request.opaqueSessionReference,
    );
  }
}

class DiagnosticFailureAdapter implements ResumableAgentRuntimeAdapter {
  readonly #error: ClaudeDiagnosticError;

  constructor(error: ClaudeDiagnosticError) {
    this.#error = error;
  }

  async inspect(): Promise<RuntimeCatalog> {
    throw this.#error;
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    throw this.#error;
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    throw this.#error;
  }
}

class CompletedBinding implements ResumableRuntimeBinding {
  readonly profile: SessionProfile;
  readonly opaqueSessionReference: string;

  constructor(profile: SessionProfile, reference = "opaque-test-session") {
    this.profile = Object.freeze({ ...profile });
    this.opaqueSessionReference = reference;
  }

  async send(_input: RuntimeInput): Promise<void> {}

  effectiveProfile(): SessionProfile {
    return this.profile;
  }

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    yield Object.freeze({ kind: "session-started" as const });
    yield Object.freeze({
      kind: "turn-completed" as const,
      status: "completed" as const,
    });
  }
}

function requestFor(
  snapshotKey: string,
  endpoint: {
    readonly key: string;
    readonly models: readonly {
      readonly key: string;
      readonly workIntensities: readonly { readonly key: string }[];
    }[];
    readonly executionModes: readonly { readonly key: string }[];
    readonly accessModes: readonly { readonly key: string }[];
  },
  input: string,
): WorkbenchDirectInputRequest {
  return Object.freeze({
    kind: "start" as const,
    input,
    snapshotKey,
    endpointKey: endpoint.key,
    modelKey: endpoint.models[0]!.key,
    workIntensityKey: endpoint.models[0]!.workIntensities[0]!.key,
    executionModeKey: endpoint.executionModes[0]!.key,
    accessModeKey: endpoint.accessModes[0]!.key,
  });
}
