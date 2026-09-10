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
import { createWorkLedgerAuthGenerationModule } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import {
  createProductionRuntimeEndpointAdapter,
  createProductionGlmRuntimeAdapter,
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

const FAKE_GLM_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  GLM_ANTHROPIC_AUTH_TOKEN: "FAKE-GLM-TOKEN-1234",
});

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

test("GLM joins the roster as a third endpoint without touching either desktop endpoint's registration or catalog", async () => {
  // The GLM adapter is injected here so the roster shape is a property of the
  // composition alone. The production adapter additionally requires a locally
  // discoverable claude executable, which is not a fact about coexistence and
  // is absent on CI; it is exercised on its own in the tests below.
  const withGlm = await discoverRuntimeEndpointComposition({
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
  const withoutGlm = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmEnvironment: {},
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });

  assert.deepEqual(
    withGlm.endpointDiscovery.statuses.map((status) => status.category),
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
  assert.deepEqual(
    withoutGlm.endpointDiscovery.statuses.map((status) => status.category),
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

  // The coexistence hard requirement: codex and claude registrations and
  // endpoint catalogs are byte-identical whether GLM is configured or not.
  assert.deepEqual(
    withGlm.registrations
      .filter((registration) => registration.endpointId !== "glm-coding-plan")
      .map(({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      })),
    withoutGlm.registrations
      .filter((registration) => registration.endpointId !== "kimi-platform")
      .map(({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      })),
  );
  assert.deepEqual(
    withGlm.endpoints.filter(
      (endpoint) => endpoint.endpointId !== "glm-coding-plan",
    ),
    withoutGlm.endpoints.filter(
      (endpoint) => endpoint.endpointId !== "kimi-platform",
    ),
  );

  // The GLM registration itself: remote-backed execution, static catalog with
  // true wire names as the UI model identity.
  const glmRegistration = withGlm.registrations.find(
    (registration) => registration.endpointId === "glm-coding-plan",
  );
  assert.ok(glmRegistration);
  assert.equal(glmRegistration.registrationId, "production-glm-coding-plan");
  assert.equal(glmRegistration.executionLocation, "remote-backed");
  assert.equal(glmRegistration.runtimeFamily, "GLM");
  const glmEndpoint = withGlm.endpoints.find(
    (endpoint) => endpoint.endpointId === "glm-coding-plan",
  );
  assert.ok(glmEndpoint);
  assert.equal(glmEndpoint.endpointLabel, "GLM Coding Plan");
  assert.deepEqual(
    glmEndpoint.catalog.models.map((model) => model.resolvedModel),
    ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
  );
  // Profile labels are the UI-facing model identity: the true GLM wire names.
  const glmProfileLabels = new Set(
    glmRegistration.capabilitySnapshot.profiles.map(
      (profile) => profile.modelLabel,
    ),
  );
  assert.deepEqual(
    [...glmProfileLabels].sort(),
    ["glm-5.3-flash[1m]", "glm-5.3[1m]"],
  );
});

test("a GLM adapter without a token reports authentication-required without spawning the CLI", async () => {
  const adapter = createProductionGlmRuntimeAdapter({ environment: {} });
  let failure: unknown;
  try {
    await adapter.inspect("project");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "authentication-required");
});

test("a GLM adapter with a configured token serves the static catalog (or reports the runtime not located)", async () => {
  const adapter = createProductionGlmRuntimeAdapter({
    environment: FAKE_GLM_ENVIRONMENT,
    configDirectory: join(tmpdir(), "uaw-glm-test-config"),
  });
  let catalog: RuntimeCatalog | undefined;
  try {
    catalog = await adapter.inspect("project");
  } catch (error) {
    assert.ok(error instanceof RuntimeAdapterError);
    assert.equal(error.category, "runtime-not-located");
  }
  if (catalog !== undefined) {
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
    );
  }
});

test("a configured GLM token never reaches any composition surface", async () => {
  const composition = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmEnvironment: FAKE_GLM_ENVIRONMENT,
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
    glmConfigDirectory: join(tmpdir(), "uaw-glm-test-config"),
  });

  // Whether or not the local claude executable is discoverable, the token is
  // only ever a spawn-environment value: it never enters a registration, a
  // catalog, a capability snapshot, or a discovery status.
  assert.equal(JSON.stringify(composition).includes("FAKE-GLM-TOKEN"), false);

  // With a token configured, the endpoint can never read as unauthenticated:
  // the environment is validated before anything is spawned, so the only
  // machine-dependent outcome left is whether the CLI could be located.
  const glmStatus = composition.endpointDiscovery.statuses.find(
    (status) => status.endpointId === "glm-coding-plan",
  );
  assert.ok(glmStatus);
  assert.notEqual(glmStatus.category, "authentication-required");
});

test("with GLM registered, a Codex session still starts through the full workbench path", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "glm-coexistence-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const codex = new RecordingCatalogAdapter(codexCatalog);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: codex,
      claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
      // Injected for the same reason as the roster test: what is under test is
      // that Codex still runs the whole workbench path with a third endpoint
      // present, not that this machine can launch GLM.
      glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
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

  const codexEndpoint = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "codex-desktop",
  );
  assert.ok(codexEndpoint);
  const accepted = await backend.submitDirectInput({
    kind: "start",
    input: "codex starts with glm present",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: codexEndpoint.key,
    modelKey: codexEndpoint.models[0]!.key,
    workIntensityKey: codexEndpoint.models[0]!.workIntensities[0]!.key,
    executionModeKey: codexEndpoint.executionModes[0]!.key,
    accessModeKey: codexEndpoint.accessModes[0]!.key,
  });
  assert.deepEqual(accepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await waitFor(() => codex.startCalls === 1);
  assert.deepEqual(codex.starts[0]?.profile, {
    model: "codex-model",
    effortLevel: "ultra",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  await backend.close();
});

test("a GLM session starts, becomes resumable, and continues through the full workbench path with the production auth-generation module wired (WO08-A)", async (t) => {
  // Regression test for the GLM silent send failure: the coordinator's
  // runtime-context admission used to reject glm-coding-plan before the
  // adapter was ever called, which the backend reported as
  // submission-unavailable. This drives the deputy's exact repro shape —
  // temp project, production composition, submitDirectInput — with the
  // production auth-generation module wired, and continues past acceptance
  // into resumability, continuation, and ledger reopen. Before the fix the
  // first submitDirectInput returns submission-unavailable and this is red.
  const root = await createTestDirectory(t, join(tmpdir(), "glm-send-path-"));
  const projectDirectory = join(root, "Project");
  const dataDirectory = join(root, "auth-data");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const glm = new RecordingCatalogAdapter(GLM_STATIC_CATALOG);
  const adapter = await createProductionRuntimeEndpointAdapter({
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: glm,
    kimiEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
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
  const glmOption = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "glm-coding-plan",
  );
  assert.ok(glmOption);
  const glmModel = glmOption.models[0]!;
  assert.deepEqual(
    glmModel.workIntensities.map((tier) => tier.label),
    ["default", "low", "high", "max"],
  );

  const accepted = await backend.submitDirectInput({
    kind: "start",
    input: "glm starts through the workbench path",
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

  let sessionKey: string | undefined;
  backend.observeProject((result) => {
    if (result.ok) {
      const key = result.view.commands.find(
        (command) => command.session !== undefined,
      )?.session?.selectionKey;
      if (typeof key === "string") sessionKey ??= key;
    }
  });
  await waitFor(() => sessionKey !== undefined);
  const continuationProfile = await backend.loadDirectSessionProfile({
    kind: "continuation-session",
    selectionKey: sessionKey!,
  });
  assert.equal(continuationProfile.ok, true);
  if (!continuationProfile.ok) throw new Error("continuation unavailable");
  const prefill = continuationProfile.profile.continuationPrefill;
  assert.equal(prefill.kind, "resolved");
  if (prefill.kind !== "resolved") throw new Error("prefill unresolved");
  const continued = await backend.submitDirectInput({
    kind: "continue",
    input: "glm continues through the workbench path",
    selectionKey: sessionKey!,
    snapshotKey: continuationProfile.profile.snapshotKey,
    endpointKey: prefill.endpointKey,
    modelKey: prefill.modelKey,
    workIntensityKey: prefill.workIntensityKey,
    executionModeKey: prefill.executionModeKey,
    accessModeKey: prefill.accessModeKey,
  });
  assert.deepEqual(continued, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await backend.close();

  // A ledger that carries GLM commands must reopen and revalidate cleanly.
  const reopened = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter,
    authGeneration: createWorkLedgerAuthGenerationModule({ dataDirectory }),
  });
  let reopenedCount = 0;
  reopened.observeProject((result) => {
    if (result.ok) reopenedCount = result.view.commands.length;
  });
  await waitFor(() => reopenedCount > 0);
  assert.equal(reopenedCount, 1);
  await reopened.close();
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
  readonly opaqueSessionReference = "opaque-glm-coexistence-session";

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
