import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { GLM_STATIC_CATALOG } from "../../src/agent-runtime/claude/glm-catalog.ts";
import { KIMI_STATIC_CATALOG } from "../../src/agent-runtime/claude/kimi-catalog.ts";
import { DEEPSEEK_STATIC_CATALOG } from "../../src/agent-runtime/claude/deepseek-catalog.ts";
import { KIMI_PLATFORM_STATIC_CATALOG } from "../../src/agent-runtime/codex/kimi-platform-catalog.ts";
import { createWorkLedgerAuthGenerationModule } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import {
  createProductionRuntimeEndpointAdapter,
  createProductionKimiRuntimeAdapter,
  createProductionDeepseekRuntimeAdapter,
  discoverRuntimeEndpointComposition,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";
import { locateClaudeRuntimeForThisTestFile } from "../helpers/vendor-cli-presence.ts";

// The claude-api endpoint's discovery category depends on whether a Claude CLI
// exists on this machine; the seam turns that into an injected input. See
// tests/helpers/vendor-cli-presence.ts.
locateClaudeRuntimeForThisTestFile();

/**
 * WO16 Part 2 acceptance: Kimi Code and DeepSeek API join the roster as
 * fourth and fifth endpoints without touching the glm/codex/claude chain —
 * the coexistence tradition ticket 05 established for GLM, restated for the
 * new endpoints (byte-identical earlier-endpoint registrations and catalogs
 * whether kimi/deepseek are configured or not, and a full workbench-path
 * turn that still works with them present).
 */

const codexCatalog: RuntimeCatalog = Object.freeze({
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

const claudeCatalog: RuntimeCatalog = Object.freeze({
  runtime: "claude",
  models: Object.freeze([
    Object.freeze({
      id: "default",
      resolvedModel: "claude-opus-5[1m]",
      displayName: "Default (recommended)",
      effortLevels: Object.freeze(["low", "high"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const FAKE_KIMI_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  KIMI_CODE_ANTHROPIC_AUTH_TOKEN: "FAKE-KIMI-TOKEN-1234",
});

const FAKE_DEEPSEEK_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  DEEPSEEK_ANTHROPIC_AUTH_TOKEN: "FAKE-DEEPSEEK-TOKEN-1234",
});

test("kimi and deepseek join the roster without touching glm/codex/claude registrations or catalogs", async () => {
  // The three claude-transport adapters are injected so roster shape is a
  // property of the composition alone; the machine-dependent CLI lookup is
  // not a fact about coexistence.
  const withNew = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
    deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
    kimiPlatformAdapter: new RecordingCatalogAdapter(KIMI_PLATFORM_STATIC_CATALOG),
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });
  const withoutNew = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });

  assert.deepEqual(
    withNew.endpointDiscovery.statuses.map((status) => [
      status.endpointId,
      status.category,
    ]),
    [
      ["codex-desktop", "catalog-ready"],
      ["claude-code-desktop", "catalog-ready"],
      ["glm-coding-plan", "catalog-ready"],
      ["kimi-code", "catalog-ready"],
      ["deepseek-api", "catalog-ready"],
      ["kimi-platform", "catalog-ready"],
      ["claude-api", "authentication-required"],
      ["codex-api", "authentication-required"],
    ],
  );
  assert.deepEqual(
    withoutNew.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
    ],
  );

  // The coexistence hard requirement: the three earlier endpoints'
  // registrations and endpoint catalogs are byte-identical whether kimi and
  // deepseek are configured or not.
  const earlierIds = new Set(["codex-desktop", "claude-code-desktop", "glm-coding-plan"]);
  assert.deepEqual(
    withNew.registrations
      .filter((registration) => earlierIds.has(registration.endpointId))
      .map(({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      })),
    withoutNew.registrations
      .filter((registration) => earlierIds.has(registration.endpointId))
      .map(({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      })),
  );
  assert.deepEqual(
    withNew.endpoints.filter((endpoint) => earlierIds.has(endpoint.endpointId)),
    withoutNew.endpoints.filter((endpoint) => earlierIds.has(endpoint.endpointId)),
  );

  // The new registrations themselves: remote-backed execution, static
  // catalogs with true wire names as the UI model identity.
  const kimiRegistration = withNew.registrations.find(
    (registration) => registration.endpointId === "kimi-code",
  );
  assert.ok(kimiRegistration);
  assert.equal(kimiRegistration.registrationId, "production-kimi-code");
  assert.equal(kimiRegistration.executionLocation, "remote-backed");
  assert.equal(kimiRegistration.runtimeFamily, "Kimi");
  const kimiEndpoint = withNew.endpoints.find(
    (endpoint) => endpoint.endpointId === "kimi-code",
  );
  assert.ok(kimiEndpoint);
  // Ticket 20 facade naming: the family carries the brand ("Kimi"), the
  // endpoint label is the short segment name.
  assert.equal(kimiEndpoint.endpointLabel, "Code");
  assert.equal(kimiEndpoint.directStart, "supported");
  assert.deepEqual(
    kimiEndpoint.catalog.models.map((model) => model.resolvedModel),
    ["kimi-for-coding", "kimi-for-coding-highspeed", "k3-256k", "k3"],
  );
  // Kimi effort truth: k2.7-code single default tier, k3 low/high/max.
  const kimiForCoding = kimiEndpoint.catalog.models[0]!;
  assert.deepEqual(kimiForCoding.effortLevelLabels, ["default"]);
  const k3 = kimiEndpoint.catalog.models[3]!;
  assert.deepEqual(k3.effortLevelLabels, ["low", "high", "max"]);
  // The desired default points at the universally available member model
  // (selection keys are the catalog's hashed model ids on both sides).
  assert.equal(
    kimiEndpoint.desiredDefault?.model,
    kimiEndpoint.catalog.models[0]?.id,
  );
  assert.equal(
    kimiEndpoint.desiredDefault?.effortLevel,
    kimiEndpoint.catalog.models[0]?.effortLevels[0],
  );

  const deepseekRegistration = withNew.registrations.find(
    (registration) => registration.endpointId === "deepseek-api",
  );
  assert.ok(deepseekRegistration);
  assert.equal(deepseekRegistration.registrationId, "production-deepseek-api");
  assert.equal(deepseekRegistration.executionLocation, "remote-backed");
  assert.equal(deepseekRegistration.runtimeFamily, "DeepSeek");
  const deepseekEndpoint = withNew.endpoints.find(
    (endpoint) => endpoint.endpointId === "deepseek-api",
  );
  assert.ok(deepseekEndpoint);
  assert.equal(deepseekEndpoint.endpointLabel, "DeepSeek API");
  assert.deepEqual(
    deepseekEndpoint.catalog.models.map((model) => model.resolvedModel),
    ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
  );
  // DeepSeek effort truth: explicit tiers only — a `default` tier can never
  // appear (unpinned effort would be unobservable, ticket 12 ruling).
  for (const model of deepseekEndpoint.catalog.models) {
    assert.deepEqual(model.effortLevelLabels, ["low", "high", "max"]);
  }
});

test("a kimi or deepseek adapter without a token reports authentication-required without spawning the CLI", async () => {
  for (const adapter of [
    createProductionKimiRuntimeAdapter({ environment: {} }),
    createProductionDeepseekRuntimeAdapter({ environment: {} }),
  ]) {
    let failure: unknown;
    try {
      await adapter.inspect("project");
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof RuntimeAdapterError);
    assert.equal(failure.category, "authentication-required");
  }
});

test("configured kimi/deepseek tokens never reach any composition surface", async () => {
  const composition = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiEnvironment: FAKE_KIMI_ENVIRONMENT,
    kimiConfigDirectory: join(tmpdir(), "uaw-kimi-test-config"),
    deepseekEnvironment: FAKE_DEEPSEEK_ENVIRONMENT,
    deepseekConfigDirectory: join(tmpdir(), "uaw-deepseek-test-config"),
  });

  // Whether or not the local claude executable is discoverable, the tokens
  // are only ever spawn-environment values.
  assert.equal(JSON.stringify(composition).includes("FAKE-KIMI-TOKEN"), false);
  assert.equal(
    JSON.stringify(composition).includes("FAKE-DEEPSEEK-TOKEN"),
    false,
  );

  // With tokens configured, neither endpoint can read as unauthenticated.
  const kimiStatus = composition.endpointDiscovery.statuses.find(
    (status) => status.endpointId === "kimi-code",
  );
  assert.ok(kimiStatus);
  assert.notEqual(kimiStatus.category, "authentication-required");
  const deepseekStatus = composition.endpointDiscovery.statuses.find(
    (status) => status.endpointId === "deepseek-api",
  );
  assert.ok(deepseekStatus);
  assert.notEqual(deepseekStatus.category, "authentication-required");
});

test("with kimi and deepseek registered, a GLM session still starts through the full workbench path", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "multi-provider-"));
  const projectDirectory = join(root, "Project");
  const dataDirectory = join(root, "auth-data");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const glm = new RecordingCatalogAdapter(GLM_STATIC_CATALOG);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: new RecordingCatalogAdapter(codexCatalog),
      claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
      glmAdapter: glm,
      kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
      deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
    }),
    authGeneration: createWorkLedgerAuthGenerationModule({ dataDirectory }),
  });

  const loaded = await backend.loadDirectSessionProfile();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("profile unexpectedly unavailable");
  assert.deepEqual(
    loaded.endpointDiscovery.statuses.map((status) => status.endpointId),
    [
      "codex-desktop",
      "claude-code-desktop",
      "glm-coding-plan",
      "kimi-code",
      "deepseek-api",
      "kimi-platform",
      "claude-api",
      "codex-api",
    ],
  );
  const glmOption = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "glm-coding-plan",
  );
  assert.ok(glmOption);
  assert.deepEqual(
    glmOption.models.map((model) => model.label),
    ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
  );

  const glmModel = glmOption.models[0]!;
  const accepted = await backend.submitDirectInput({
    kind: "start",
    input: "glm starts with kimi and deepseek present",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: glmOption.key,
    modelKey: glmModel.key,
    workIntensityKey: glmModel.workIntensities[0]!.key,
    executionModeKey: glmOption.executionModes[0]!.key,
    accessModeKey: glmOption.accessModes[0]!.key,
  });
  assert.deepEqual(accepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await waitFor(() => glm.startCalls === 1);
  assert.deepEqual(glm.starts[0]?.profile, {
    model: "glm-5.3[1m]",
    effortLevel: "default",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  await backend.close();
});

test("a kimi session starts and a deepseek session starts through the full workbench path (alias injection is the wire truth)", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "multi-provider-start-"));
  const projectDirectory = join(root, "Project");
  const dataDirectory = join(root, "auth-data");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const kimi = new RecordingCatalogAdapter(KIMI_STATIC_CATALOG);
  const deepseek = new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG);
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiAdapter: kimi,
    deepseekAdapter: deepseek,
  });
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter,
    authGeneration: createWorkLedgerAuthGenerationModule({ dataDirectory }),
  });

  const loaded = await backend.loadDirectSessionProfile();
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("profile unexpectedly unavailable");

  const kimiOption = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "kimi-code",
  );
  assert.ok(kimiOption);
  const kimiModel = kimiOption.models[0]!;
  // Ticket 11 verification item: the default model is the universally
  // available subscription-face name, and its effort tier is the single
  // unpinned `default`.
  assert.equal(kimiModel.label, "kimi-for-coding");
  assert.deepEqual(
    kimiModel.workIntensities.map((tier) => tier.label),
    ["default"],
  );
  const kimiAccepted = await backend.submitDirectInput({
    kind: "start",
    input: "kimi starts through the workbench path",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: kimiOption.key,
    modelKey: kimiModel.key,
    workIntensityKey: kimiModel.workIntensities[0]!.key,
    executionModeKey: kimiOption.executionModes[0]!.key,
    accessModeKey: kimiOption.accessModes[0]!.key,
  });
  assert.deepEqual(kimiAccepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await waitFor(() => kimi.startCalls === 1);
  // The native profile the adapter receives carries the true wire name —
  // the three-slot alias injection guarantees no claude name reaches the
  // wire (kimi-catalog module header).
  assert.deepEqual(kimi.starts[0]?.profile, {
    model: "kimi-for-coding",
    effortLevel: "default",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  // The first start changed the project (a session exists), so the profile
  // snapshot must be reloaded before the second start.
  const loaded2 = await backend.loadDirectSessionProfile();
  assert.equal(loaded2.ok, true);
  if (!loaded2.ok) throw new Error("profile unexpectedly unavailable");

  const deepseekOption = loaded2.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "deepseek-api",
  );
  assert.ok(deepseekOption);
  const deepseekModel = deepseekOption.models[0]!;
  assert.equal(deepseekModel.label, "deepseek-v4-pro[1m]");
  assert.deepEqual(
    deepseekModel.workIntensities.map((tier) => tier.label),
    ["low", "high", "max"],
  );
  const deepseekAccepted = await backend.submitDirectInput({
    kind: "start",
    input: "deepseek starts through the workbench path",
    snapshotKey: loaded2.profile.snapshotKey,
    endpointKey: deepseekOption.key,
    modelKey: deepseekModel.key,
    workIntensityKey: deepseekModel.workIntensities[1]!.key,
    executionModeKey: deepseekOption.executionModes[0]!.key,
    accessModeKey: deepseekOption.accessModes[0]!.key,
  });
  assert.deepEqual(deepseekAccepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await waitFor(() => deepseek.startCalls === 1);
  // Ticket 12 verification item: the CLI-echoed native profile carries the
  // true wire name (explicit `high` effort; never a claude alias — the
  // endpoint would silently map one to flash instead of rejecting it).
  assert.deepEqual(deepseek.starts[0]?.profile, {
    model: "deepseek-v4-pro[1m]",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  await backend.close();
});

async function createRegisteredWorkbenchBackend(
  context: TestContext,
  options: Parameters<typeof createWorkbenchBackend>[0],
) {
  const backend = await createWorkbenchBackend(options);
  registerTestClosable(context, backend);
  return backend;
}

async function waitFor(
  predicate: () => boolean,
  attempts = 200,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  assert.fail("condition was not observed");
}

class RecordingCatalogAdapter implements ResumableAgentRuntimeAdapter {
  startCalls = 0;
  readonly starts: RuntimeStart[] = [];
  readonly #catalog: RuntimeCatalog;

  constructor(catalog: RuntimeCatalog) {
    this.#catalog = catalog;
  }

  async inspect(): Promise<RuntimeCatalog> {
    return this.#catalog;
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.starts.push(request);
    this.startCalls += 1;
    return new CompletedBinding(request.profile);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return new CompletedBinding(request.profile);
  }
}

class CompletedBinding implements ResumableRuntimeBinding {
  readonly profile: SessionProfile;
  readonly opaqueSessionReference = "opaque-multi-provider-session";

  constructor(profile: SessionProfile) {
    this.profile = Object.freeze({ ...profile });
  }

  async send(_input: RuntimeInput): Promise<void> {}

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    yield Object.freeze({ kind: "session-started" as const });
    yield Object.freeze({
      kind: "turn-completed" as const,
      status: "completed" as const,
    });
  }
}
