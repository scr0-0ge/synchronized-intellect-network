import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { CODEX_API_STATIC_CATALOG } from "../../src/agent-runtime/codex/codex-api-catalog.ts";
import { CODEX_API_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import {
  CODEX_API_ENDPOINT_KEY_NAME,
  CODEX_API_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/codex/codex-api-endpoint-key.ts";
import {
  CLAUDE_API_ENDPOINT_ENV_CONTRACT,
  CLAUDE_API_ENDPOINT_KEY_NAME,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/claude/claude-api-endpoint.ts";
import { EndpointSecretEnvelopeStore, type SafeStorageLike } from "../../src/workbench-shell/endpoint-secret-envelope-store.ts";
import { endpointSecretEnvelopeStorePath } from "../../src/workbench-shell/endpoint-key-source.ts";
import {
  createWorkbenchClaudeApiEndpointKeySource,
  probeClaudeApiEndpoint,
} from "../../src/workbench-shell/claude-api-endpoint-key.ts";
import {
  createWorkbenchCodexApiEndpointKeySource,
  probeCodexApiEndpoint,
} from "../../src/workbench-shell/codex-api-endpoint-key.ts";
import { createWorkLedgerAuthGenerationModule } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import {
  createProductionClaudeApiRuntimeAdapter,
  createProductionCodexApiRuntimeAdapter,
  createProductionRuntimeEndpointAdapter,
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
 * Ticket 21 acceptance (charter completion): claude-api and codex-api join
 * the roster as the seventh and eighth endpoints without touching the
 * earlier six — the coexistence tradition of tickets 05 / WO16 / 17. All
 * credential material is an explicit fake; every network path is a fake
 * fetch; no test touches the network, Electron, a real provider, or a real
 * CLI. (The claude-api endpoint has no static catalog by design — it probes
 * the real CLI catalog — so its roster presence is exercised through an
 * injected adapter; its env/auth semantics have their own tests.)
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

const claudeApiCatalog: RuntimeCatalog = Object.freeze({
  runtime: "claude",
  models: Object.freeze([
    Object.freeze({
      id: "claude-sonnet-6",
      effortLevels: Object.freeze(["low", "high"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const FAKE_CLAUDE_API_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  [CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]:
    "FAKE-CLAUDE-API-KEY-1234",
});

const FAKE_CODEX_API_ENVIRONMENT: NodeJS.ProcessEnv = Object.freeze({
  [CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: "FAKE-CODEX-API-KEY-1234",
});

test("claude-api and codex-api join the roster as the seventh and eighth endpoints without touching the earlier six", async () => {
  const withNew = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
    deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
    kimiPlatformAdapter: new RecordingCatalogAdapter(KIMI_PLATFORM_STATIC_CATALOG),
    claudeApiAdapter: new RecordingCatalogAdapter(claudeApiCatalog),
    codexApiAdapter: new RecordingCatalogAdapter(CODEX_API_STATIC_CATALOG),
  });
  const withoutNew = await discoverRuntimeEndpointComposition({
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
      ["claude-api", "catalog-ready"],
      ["codex-api", "catalog-ready"],
    ],
  );
  assert.deepEqual(
    withoutNew.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "catalog-ready",
      "authentication-required",
      "authentication-required",
    ],
  );

  // The coexistence hard requirement (ticket 05 tradition): the earlier six
  // endpoints' registrations and endpoint catalogs are byte-identical
  // whether claude-api/codex-api are configured or not.
  const earlierIds = new Set([
    "codex-desktop",
    "claude-code-desktop",
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
    "kimi-platform",
  ]);
  assert.deepEqual(
    withNew.registrations
      .filter((registration) => earlierIds.has(registration.endpointId))
      .map(({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      })),
    withoutNew.registrations.map(
      ({ registrationId, endpointId, executionLocation }) => ({
        registrationId,
        endpointId,
        executionLocation,
      }),
    ),
  );
  assert.deepEqual(
    withNew.endpoints.filter((endpoint) => earlierIds.has(endpoint.endpointId)),
    withoutNew.endpoints,
  );

  // The new registrations themselves.
  const claudeApiRegistration = withNew.registrations.find(
    (candidate) => candidate.endpointId === "claude-api",
  );
  assert.ok(claudeApiRegistration);
  assert.equal(claudeApiRegistration.registrationId, "production-claude-api");
  assert.equal(claudeApiRegistration.executionLocation, "remote-backed");
  assert.equal(claudeApiRegistration.runtimeFamily, "Claude");
  const claudeApiEndpoint = withNew.endpoints.find(
    (candidate) => candidate.endpointId === "claude-api",
  );
  assert.ok(claudeApiEndpoint);
  // Ticket 25 facade: the family carries the brand ("Claude · API"); the
  // composition label is the short segment name.
  assert.equal(claudeApiEndpoint.endpointLabel, "API");
  assert.equal(claudeApiEndpoint.directStart, "supported");
  assert.deepEqual(
    claudeApiEndpoint.catalog.models.map((model) => model.resolvedModel),
    ["claude-sonnet-6"],
  );

  const codexApiRegistration = withNew.registrations.find(
    (candidate) => candidate.endpointId === "codex-api",
  );
  assert.ok(codexApiRegistration);
  assert.equal(codexApiRegistration.registrationId, "production-codex-api");
  assert.equal(codexApiRegistration.executionLocation, "remote-backed");
  assert.equal(codexApiRegistration.runtimeFamily, "Codex");
  const codexApiEndpoint = withNew.endpoints.find(
    (candidate) => candidate.endpointId === "codex-api",
  );
  assert.ok(codexApiEndpoint);
  assert.equal(codexApiEndpoint.endpointLabel, "API");
  assert.equal(codexApiEndpoint.directStart, "supported");
  assert.deepEqual(
    codexApiEndpoint.catalog.models.map((model) => model.resolvedModel),
    ["gpt-5.6-sol", "gpt-5.6-codex", "gpt-5.5-codex"],
  );
  // Real provider effort tiers only — no unpinned default tier.
  for (const model of codexApiEndpoint.catalog.models) {
    assert.equal(model.effortLevels.includes("default"), false);
  }
  assert.equal(codexApiEndpoint.desiredDefault?.model, codexApiEndpoint.catalog.models[0]?.id);
});

test("neither endpoint reports authentication-required through the production constructors when its key is absent", async () => {
  for (const [label, inspect] of [
    [
      "claude-api",
      () => createProductionClaudeApiRuntimeAdapter({ environment: {} }).inspect("project"),
    ],
    [
      "codex-api",
      () => createProductionCodexApiRuntimeAdapter({ environment: {} }).inspect("project"),
    ],
  ] as const) {
    let failure: unknown;
    try {
      await inspect();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof RuntimeAdapterError, label);
    assert.equal(failure.category, "authentication-required", label);
  }
});

test("configured keys never reach any composition surface", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "charter-coexist-"));
  const composition = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter: new RecordingCatalogAdapter(codexCatalog),
    claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
    glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
    kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
    deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
    kimiPlatformAdapter: new RecordingCatalogAdapter(KIMI_PLATFORM_STATIC_CATALOG),
    // claude-api has no static catalog (by design — the real CLI catalog IS
    // its catalog), so a hermetic test injects its adapter; its production
    // env/auth semantics are pinned in the agent-runtime tests.
    claudeApiAdapter: new RecordingCatalogAdapter(claudeApiCatalog),
    codexApiEnvironment: FAKE_CODEX_API_ENVIRONMENT,
    codexApiCodexHomeDirectory: join(root, "codex-api-home"),
  });

  assert.equal(
    JSON.stringify(composition).includes("FAKE-CLAUDE-API-KEY"),
    false,
  );
  assert.equal(
    JSON.stringify(composition).includes("FAKE-CODEX-API-KEY"),
    false,
  );
  const codexApiStatus = composition.endpointDiscovery.statuses.find(
    (candidate) => candidate.endpointId === "codex-api",
  );
  assert.ok(codexApiStatus);
  assert.notEqual(codexApiStatus.category, "authentication-required");
});

test("with both endpoints registered, a codex-desktop session still starts through the full workbench path", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "charter-path-"));
  const projectDirectory = join(root, "Project");
  const dataDirectory = join(root, "auth-data");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  const codex = new RecordingCatalogAdapter(codexCatalog);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "preferences.json"),
    adapter: await createProductionRuntimeEndpointAdapter({
      codexAdapter: codex,
      claudeAdapter: new RecordingCatalogAdapter(claudeCatalog),
      glmAdapter: new RecordingCatalogAdapter(GLM_STATIC_CATALOG),
      kimiAdapter: new RecordingCatalogAdapter(KIMI_STATIC_CATALOG),
      deepseekAdapter: new RecordingCatalogAdapter(DEEPSEEK_STATIC_CATALOG),
      kimiPlatformAdapter: new RecordingCatalogAdapter(KIMI_PLATFORM_STATIC_CATALOG),
      claudeApiAdapter: new RecordingCatalogAdapter(claudeApiCatalog),
      codexApiAdapter: new RecordingCatalogAdapter(CODEX_API_STATIC_CATALOG),
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
  const codexApiOption = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "codex-api",
  );
  assert.ok(codexApiOption);
  assert.deepEqual(
    codexApiOption.models.map((model) => model.label),
    ["GPT-5.6-Sol", "gpt-5.6-codex", "gpt-5.5-codex"],
  );

  const codexEndpoint = loaded.profile.endpoints.find(
    (endpoint) => endpoint.endpointId === "codex-desktop",
  );
  assert.ok(codexEndpoint);
  const accepted = await backend.submitDirectInput({
    kind: "start",
    input: "codex starts with claude-api and codex-api present",
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
  await backend.close();
});

test("the two key sources: identity of record, store-first resolution, env fallback, fake-fetch probes with provider-pinned shapes", async (t) => {
  assert.equal(
    CLAUDE_API_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/claude-api",
  );
  assert.equal(CLAUDE_API_ENDPOINT_KEY_NAME, "claude-api");
  assert.equal(
    CODEX_API_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/codex-api",
  );
  assert.equal(CODEX_API_ENDPOINT_KEY_NAME, "codex-api");

  const root = await createTestDirectory(t, join(tmpdir(), "charter-keys-"));
  const storePath = endpointSecretEnvelopeStorePath(root);
  const safeStorage = createFakeSafeStorage();
  const claudeApiStore = new EndpointSecretEnvelopeStore({
    subject: CLAUDE_API_ENDPOINT_KEY_SUBJECT,
    safeStorage,
    storePath,
  });
  const codexApiStore = new EndpointSecretEnvelopeStore({
    subject: CODEX_API_ENDPOINT_KEY_SUBJECT,
    safeStorage,
    storePath,
  });
  const claudeApi = createWorkbenchClaudeApiEndpointKeySource({
    store: claudeApiStore,
    environment: {},
  });
  const codexApi = createWorkbenchCodexApiEndpointKeySource({
    store: codexApiStore,
    environment: {},
  });

  // Unconfigured: no value anywhere.
  assert.equal(claudeApi.resolve(), undefined);
  assert.equal(codexApi.resolve(), undefined);
  assert.deepEqual(claudeApi.status(), {
    configured: false,
    maskedHint: null,
    isPersistent: true,
    environmentFallback: false,
  });

  // Environment fallback applies without a stored key (dedicated names).
  const claudeApiEnv = createWorkbenchClaudeApiEndpointKeySource({
    store: claudeApiStore,
    environment: {
      [CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: "test-secret-env-1",
    },
  });
  const codexApiEnv = createWorkbenchCodexApiEndpointKeySource({
    store: codexApiStore,
    environment: {
      [CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: "test-secret-env-2",
    },
  });
  assert.equal(claudeApiEnv.resolve(), "test-secret-env-1");
  assert.equal(codexApiEnv.resolve(), "test-secret-env-2");

  // Stored key wins over the environment fallback; remove round-trips; the
  // two subjects coexist in the one store file and never cross-read.
  const saved = claudeApi.save("test-secret-store-1");
  assert.equal(saved.configured, true);
  assert.equal(claudeApi.resolve(), "test-secret-store-1");
  assert.equal(claudeApiEnv.resolve(), "test-secret-store-1");
  assert.equal(codexApi.resolve(), undefined);
  assert.equal(claudeApi.remove(), true);
  assert.equal(claudeApi.resolve(), undefined);
  assert.equal(claudeApiEnv.resolve(), "test-secret-env-1");

  // The claude-api probe: zero-inference GET <base>/v1/models with the
  // x-api-key + anthropic-version pair (fake fetch, zero network).
  const claudeProbed = await createWorkbenchClaudeApiEndpointKeySource({
    store: claudeApiStore,
    environment: {
      [CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: "test-secret-probe-1",
    },
    fetch: fakeFetchFor({
      expectedUrl: "https://api.anthropic.com/v1/models",
      expectedHeaders: {
        accept: "application/json",
        "x-api-key": "test-secret-probe-1",
        "anthropic-version": "2023-06-01",
      },
      status: 200,
    }),
  }).probe();
  assert.deepEqual(claudeProbed, { outcome: "success" });

  const codexProbed = await createWorkbenchCodexApiEndpointKeySource({
    store: codexApiStore,
    environment: {
      [CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: "test-secret-probe-2",
    },
    fetch: fakeFetchFor({
      expectedUrl: "https://api.openai.com/v1/models",
      expectedHeaders: {
        accept: "application/json",
        authorization: "Bearer test-secret-probe-2",
      },
      status: 200,
    }),
  }).probe();
  assert.deepEqual(codexProbed, { outcome: "success" });

  const unauthorized = await probeClaudeApiEndpoint({
    baseUrl: "https://api.anthropic.com",
    authToken: "test-secret-probe-3",
    fetch: fakeFetchFor({
      expectedUrl: "https://api.anthropic.com/v1/models",
      expectedHeaders: {
        accept: "application/json",
        "x-api-key": "test-secret-probe-3",
        "anthropic-version": "2023-06-01",
      },
      status: 401,
    }),
  });
  assert.deepEqual(unauthorized, { outcome: "failure", reason: "unauthorized" });

  const codexUnauthorized = await probeCodexApiEndpoint({
    baseUrl: "https://api.openai.com/v1",
    authToken: "test-secret-probe-4",
    fetch: fakeFetchFor({
      expectedUrl: "https://api.openai.com/v1/models",
      expectedHeaders: {
        accept: "application/json",
        authorization: "Bearer test-secret-probe-4",
      },
      status: 401,
    }),
  });
  assert.deepEqual(codexUnauthorized, {
    outcome: "failure",
    reason: "unauthorized",
  });
});

function fakeFetchFor(options: {
  readonly expectedUrl: string;
  readonly expectedHeaders: Readonly<Record<string, string>>;
  readonly status: number;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), options.expectedUrl);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const headers = init?.headers as Record<string, string>;
    for (const [name, value] of Object.entries(options.expectedHeaders)) {
      assert.equal(headers[name], value, `header ${name}`);
    }
    return new Response(null, { status: options.status });
  }) as typeof fetch;
}

let fakeStorageSeed = 0;

function createFakeSafeStorage(): SafeStorageLike {
  const key = createHash("sha256")
    .update(`uaw-charter-fake-key-${(fakeStorageSeed += 1)}`)
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
  readonly opaqueSessionReference = "opaque-charter-session";

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
