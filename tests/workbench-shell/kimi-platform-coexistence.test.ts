import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

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
import { KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import {
  KIMI_PLATFORM_ENDPOINT_KEY_NAME,
  KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/codex/kimi-platform-key.ts";
import { EndpointSecretEnvelopeStore, type SafeStorageLike } from "../../src/workbench-shell/endpoint-secret-envelope-store.ts";
import { endpointSecretEnvelopeStorePath } from "../../src/workbench-shell/endpoint-key-source.ts";
import {
  createWorkbenchKimiPlatformKeySource,
  probeKimiPlatformEndpoint,
} from "../../src/workbench-shell/kimi-platform-key.ts";
import { createWorkLedgerAuthGenerationModule } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import {
  createProductionKimiPlatformRuntimeAdapter,
  createProductionRuntimeEndpointAdapter,
  discoverRuntimeEndpointComposition,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

/**
 * Ticket 17 acceptance: kimi-platform (CN platform OpenAI face, codex CLI
 * transport, isolated CODEX_HOME) joins the roster as the sixth endpoint
 * without touching the earlier five — the coexistence tradition tickets 05
 * and WO16 established. All credential material is an explicit fake; every
 * network path is a fake fetch; no test touches the network, Electron, a
 * real provider, or a real codex CLI.
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

const FAKE_KIMI_PLATFORM_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: "FAKE-KIMI-PLATFORM-KEY-1234",
});

test("kimi-platform joins the roster as the sixth endpoint without touching the earlier five", async () => {
  // The four claude-transport adapters plus the codex desktop adapter are
  // injected so roster shape is a property of the composition alone; the
  // machine-dependent CLI lookups are not facts about coexistence.
  const withKimiPlatform = await discoverRuntimeEndpointComposition({
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
  const withoutKimiPlatform = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
    deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });

  assert.deepEqual(
    withKimiPlatform.endpointDiscovery.statuses.map((status) => [
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
    withoutKimiPlatform.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "authentication-required",
      "authentication-required",
      "authentication-required",
    ],
  );

  // The coexistence hard requirement (ticket 05 tradition): the earlier
  // endpoints' registrations and endpoint catalogs are byte-identical
  // whether kimi-platform is configured or not.
  const earlierIds = new Set([
    "codex-desktop",
    "claude-code-desktop",
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
  ]);
  assert.deepEqual(
    withKimiPlatform.registrations
      .filter((registration) => earlierIds.has(registration.endpointId))
      .map(({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      })),
    withoutKimiPlatform.registrations.map(
      ({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      }),
    ),
  );
  assert.deepEqual(
    withKimiPlatform.endpoints.filter((endpoint) =>
      earlierIds.has(endpoint.endpointId),
    ),
    withoutKimiPlatform.endpoints,
  );

  // The new registration itself: remote-backed execution, static catalog
  // with the platform-face wire names, single default effort tier.
  const registration = withKimiPlatform.registrations.find(
    (candidate) => candidate.endpointId === "kimi-platform",
  );
  assert.ok(registration);
  assert.equal(registration.registrationId, "production-kimi-platform");
  assert.equal(registration.executionLocation, "remote-backed");
  assert.equal(registration.runtimeFamily, "Kimi");
  const endpoint = withKimiPlatform.endpoints.find(
    (candidate) => candidate.endpointId === "kimi-platform",
  );
  assert.ok(endpoint);
  // Ticket 20 facade naming: the family carries the brand ("Kimi"), the
  // endpoint label is the short segment name.
  assert.equal(endpoint.endpointLabel, "Platform");
  assert.equal(endpoint.directStart, "supported");
  assert.deepEqual(
    endpoint.catalog.models.map((model) => model.resolvedModel),
    ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3", "kimi-k2.6"],
  );
  for (const model of endpoint.catalog.models) {
    assert.deepEqual(model.effortLevelLabels, ["default"]);
  }
  assert.equal(endpoint.desiredDefault?.model, endpoint.catalog.models[0]?.id);
  assert.equal(
    endpoint.desiredDefault?.effortLevel,
    endpoint.catalog.models[0]?.effortLevels[0],
  );
});

test("a kimi-platform adapter without a key reports authentication-required without spawning the CLI", async () => {
  const adapter = createProductionKimiPlatformRuntimeAdapter({ environment: {} });
  let failure: unknown;
  try {
    await adapter.inspect("project");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "authentication-required");
});

test("a configured kimi-platform key never reaches any composition surface", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-coexist-"));
  const composition = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
    deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
    kimiPlatformEnvironment: FAKE_KIMI_PLATFORM_ENVIRONMENT,
    kimiPlatformCodexHomeDirectory: join(root, "codex-home"),
  });

  assert.equal(
    JSON.stringify(composition).includes("FAKE-KIMI-PLATFORM-KEY"),
    false,
  );
  const status = composition.endpointDiscovery.statuses.find(
    (candidate) => candidate.endpointId === "kimi-platform",
  );
  assert.ok(status);
  assert.notEqual(status.category, "authentication-required");
});

test("with kimi-platform registered, a deepseek session still starts through the full workbench path", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-path-"));
  const projectDirectory = join(root, "Project");
  const dataDirectory = join(root, "auth-data");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const deepseek = new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: new RecordingCatalogAdapter(codexCatalog),
      claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
      glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
      kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
      deepseekAdapter: deepseek,
      kimiPlatformAdapter: new RecordingCatalogAdapter(KIMI_PLATFORM_STATIC_CATALOG),
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
  const kimiPlatformOption = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "kimi-platform",
  );
  assert.ok(kimiPlatformOption);
  assert.deepEqual(
    kimiPlatformOption.models.map((model) => model.label),
    ["kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3", "kimi-k2.6"],
  );

  const deepseekOption = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "deepseek-api",
  );
  assert.ok(deepseekOption);
  const accepted = await backend.submitDirectInput({
    kind: "start",
    input: "deepseek starts with kimi-platform present",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: deepseekOption.key,
    modelKey: deepseekOption.models[0]!.key,
    workIntensityKey: deepseekOption.models[0]!.workIntensities[0]!.key,
    executionModeKey: deepseekOption.executionModes[0]!.key,
    accessModeKey: deepseekOption.accessModes[0]!.key,
  });
  assert.deepEqual(accepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await waitFor(() => deepseek.startCalls === 1);
  assert.deepEqual(deepseek.starts[0]?.profile, {
    model: "deepseek-v4-pro[1m]",
    effortLevel: "low",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  await backend.close();
});

test("the kimi-platform key source: identity of record, store-first resolution, env fallback, fake-fetch probe", async (t) => {
  assert.equal(
    KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/kimi-platform",
  );
  assert.equal(KIMI_PLATFORM_ENDPOINT_KEY_NAME, "kimi-platform");

  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-key-"));
  // One shared store file, two subjects: the kimi-platform envelope must
  // coexist with the subscription-face kimi-code envelope (ADR 0022).
  const storePath = endpointSecretEnvelopeStorePath(root);
  const safeStorage = createFakeSafeStorage();
  const kimiPlatformStore = new EndpointSecretEnvelopeStore({
    subject: KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
    safeStorage,
    storePath,
  });
  const kimiCodeStore = new EndpointSecretEnvelopeStore({
    subject: "workbench://runtime-endpoint/kimi-code",
    safeStorage,
    storePath,
  });
  const source = createWorkbenchKimiPlatformKeySource({
    store: kimiPlatformStore,
    environment: {},
  });

  // Unconfigured: no value anywhere.
  assert.equal(source.resolve(), undefined);
  assert.deepEqual(source.status(), {
    configured: false,
    maskedHint: null,
    isPersistent: true,
    environmentFallback: false,
  });

  // Environment fallback applies without a stored key.
  const envBacked = createWorkbenchKimiPlatformKeySource({
    store: kimiPlatformStore,
    environment: {
      [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: "test-secret-env-1",
    },
  });
  assert.equal(envBacked.resolve(), "test-secret-env-1");

  // Stored key wins over the environment fallback; save/remove round-trip.
  const saved = source.save("test-secret-store-1");
  assert.equal(saved.configured, true);
  assert.equal(saved.maskedHint, "••••re-1");
  assert.equal(source.resolve(), "test-secret-store-1");
  assert.equal(envBacked.resolve(), "test-secret-store-1");
  const kimiCodeCrossStore = kimiCodeStore.resolve("kimi-code");
  assert.equal(kimiCodeCrossStore, undefined);
  assert.equal(source.remove(), true);
  assert.equal(source.resolve(), undefined);
  assert.equal(envBacked.resolve(), "test-secret-env-1");

  // The probe is the zero-inference GET <platform>/v1/models with a Bearer
  // header — driven entirely by a fake fetch, zero real network.
  const probed = await createWorkbenchKimiPlatformKeySource({
    store: kimiPlatformStore,
    environment: {
      [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: "test-secret-probe-1",
    },
    fetch: fakeFetchFor("https://api.moonshot.cn/v1/models", 200, "test-secret-probe-1"),
  }).probe();
  assert.deepEqual(probed, { outcome: "success" });

  const unauthorized = await probeKimiPlatformEndpoint({
    baseUrl: "https://api.moonshot.cn/v1",
    authToken: "test-secret-probe-2",
    fetch: fakeFetchFor("https://api.moonshot.cn/v1/models", 401, "test-secret-probe-2"),
  });
  assert.deepEqual(unauthorized, { outcome: "failure", reason: "unauthorized" });
});

function fakeFetchFor(
  expectedUrl: string,
  status: number,
  expectedToken: string,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), expectedUrl);
    assert.equal(init?.method, "GET");
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      `Bearer ${expectedToken}`,
    );
    assert.equal(init?.redirect, "error");
    return new Response(null, { status });
  }) as typeof fetch;
}

let fakeStorageSeed = 0;

function createFakeSafeStorage(): SafeStorageLike {
  const key = createHash("sha256")
    .update(`uaw-kimi-platform-fake-key-${(fakeStorageSeed += 1)}`)
    .digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString(plainText: string): Uint8Array {
      const bytes = Buffer.from(plainText, "utf8");
      const tag = Buffer.alloc(16, 7);
      const stream = Buffer.allocUnsafe(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) {
        stream[index] = bytes[index] ^ key[index % key.length];
      }
      return Buffer.concat([tag, stream]);
    },
    decryptString(encrypted: Uint8Array): string {
      const stream = Buffer.from(encrypted).subarray(16);
      const plain = Buffer.allocUnsafe(stream.length);
      for (let index = 0; index < stream.length; index += 1) {
        plain[index] = stream[index] ^ key[index % key.length];
      }
      return plain.toString("utf8");
    },
  };
}

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
  readonly opaqueSessionReference = "opaque-kimi-platform-session";

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
