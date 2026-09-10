import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import type { CodexEndpointContext } from "../../src/agent-runtime/codex-adapter.ts";
import type { CodexExecutableDiscoveryResult } from "../../src/agent-runtime/codex/executable-discovery.ts";
import {
  CODEX_API_ENDPOINT_ENV_CONTRACT,
  CodexEndpointEnvironmentError,
  createCodexEndpointProcessEnvironment,
} from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import {
  CODEX_API_CONFIG_TOML_FILE_NAME,
  CODEX_API_CODEX_PROVIDER_ID,
  codexApiIsolatedCodexHomeDir,
  composeCodexApiConfigToml,
  ensureCodexApiCodexHome,
  resolveCodexApiBaseUrl,
} from "../../src/agent-runtime/codex/codex-api-codex-home.ts";
import {
  CODEX_API_DEFAULT_MODEL_ID,
  CODEX_API_STATIC_CATALOG,
  createCodexApiEndpointContext,
} from "../../src/agent-runtime/codex/codex-api-catalog.ts";
import {
  CODEX_API_ENDPOINT_KEY_NAME,
  CODEX_API_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/codex/codex-api-endpoint-key.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { createTestDirectory } from "../helpers/test-lifecycle.ts";

/**
 * Ticket 21 codex-api endpoint: the isolated CODEX_HOME seeding (openai
 * provider on the responses wire), the CODEX_API_KEY → OPENAI_API_KEY naming
 * discipline, and the static-catalog adapter (chatgpt-account gate skipped).
 * All credential material is an explicit fake; no CLI, network, or real key.
 */

const FAKE_KEY = "FAKE-CODEX-API-KEY-1234";
const ISOLATED_HOME = join("C:", "appdata-fake", "codex-api-home");

const HOSTILE_SOURCE: NodeJS.ProcessEnv = Object.freeze({
  // The host's own OpenAI usage: cleansed, never read.
  OPENAI_API_KEY: "HOST-AMBIENT-OPENAI-KEY-9999",
  CODEX_API_KEY: "HOST-NOT-OURS",
  OPENAI_BASE_URL: "https://host-proxy.example.com/v1",
  CODEX_HOME: "C:\\Users\\host\\.codex",
});

function locatedDiscovery(): CodexExecutableDiscoveryResult {
  return {
    kind: "located",
    executable: Object.freeze({}),
  } as unknown as CodexExecutableDiscoveryResult;
}

function codexApiContext(overrides: {
  readonly homeDirectory: string;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly resolveApiKey?: () => string | undefined;
  readonly discoverExecutable?: () => Promise<CodexExecutableDiscoveryResult>;
}): CodexEndpointContext {
  const base = createCodexApiEndpointContext({
    codexHome: overrides.homeDirectory,
    ...(overrides.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: overrides.sourceEnvironment }),
    ...(overrides.resolveApiKey === undefined
      ? {}
      : { resolveApiKey: overrides.resolveApiKey }),
  });
  return Object.freeze({
    ...base,
    ...(overrides.discoverExecutable === undefined
      ? {}
      : { discoverExecutable: overrides.discoverExecutable }),
  });
}

test("identity constants pin the envelope subject and key name", () => {
  assert.equal(
    CODEX_API_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/codex-api",
  );
  assert.equal(CODEX_API_ENDPOINT_KEY_NAME, "codex-api");
  assert.equal(
    CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
    "CODEX_API_KEY",
  );
  assert.equal(
    CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeyInjectedEnvVar,
    "OPENAI_API_KEY",
  );
  assert.equal(
    CODEX_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    "https://api.openai.com/v1",
  );
});

test("the isolated CODEX_HOME follows the %APPDATA% location budget and can never be the user-level ~/.codex", () => {
  const home = codexApiIsolatedCodexHomeDir(join("C:", "appdata-fake"));
  assert.equal(
    home,
    join("C:", "appdata-fake", "synchronized-intellect-network", "codex-api-codex-home"),
  );
  assert.equal(home.includes(".codex"), false);
});

test("the canonical config.toml pins the openai provider, responses wire, our env_key, and the default model", () => {
  const canonical = composeCodexApiConfigToml({ homeDirectory: ISOLATED_HOME });
  assert.ok(canonical.includes(`model = "${CODEX_API_DEFAULT_MODEL_ID}"`));
  assert.ok(
    canonical.includes(`model_provider = "${CODEX_API_CODEX_PROVIDER_ID}"`),
  );
  assert.ok(canonical.includes("[model_providers.openai]"));
  assert.ok(canonical.includes('base_url = "https://api.openai.com/v1"'));
  assert.ok(
    canonical.includes(
      `env_key = "${CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeyInjectedEnvVar}"`,
    ),
  );
  assert.ok(canonical.includes('wire_api = "responses"'));
  // Byte-stable for a fixed configuration (corruption detection contract).
  assert.equal(
    canonical,
    composeCodexApiConfigToml({ homeDirectory: join("D:", "other") }),
  );
  // The base URL chain: override > env contract var > default; invalid fails.
  assert.equal(
    resolveCodexApiBaseUrl({
      homeDirectory: ISOLATED_HOME,
      baseUrl: "https://proxy.example.com/v1",
    }),
    "https://proxy.example.com/v1",
  );
  assert.equal(
    resolveCodexApiBaseUrl({
      homeDirectory: ISOLATED_HOME,
      sourceEnvironment: {
        [CODEX_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
          "https://env.example.com/v1",
      },
    }),
    "https://env.example.com/v1",
  );
  let failure: unknown;
  try {
    resolveCodexApiBaseUrl({ homeDirectory: ISOLATED_HOME, baseUrl: "not-a-url" });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "invalid-input");
});

test("seeding creates the home and canonical config, is idempotent, and rebuilds drift", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "codex-api-home-"));
  const home = join(root, "codex-api-codex-home");
  const seeded = ensureCodexApiCodexHome({ homeDirectory: home });
  assert.equal(seeded.restored, true);
  assert.equal(seeded.configPath, join(home, CODEX_API_CONFIG_TOML_FILE_NAME));
  assert.equal(
    readFileSync(seeded.configPath, "utf8"),
    composeCodexApiConfigToml({ homeDirectory: home }),
  );
  assert.equal(
    ensureCodexApiCodexHome({ homeDirectory: home }).restored,
    false,
  );
  // Drift (an older seeding with a different base URL) is repaired.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(seeded.configPath, "model = \"garbage", "utf8");
  const repaired = ensureCodexApiCodexHome({ homeDirectory: home });
  assert.equal(repaired.restored, true);
  assert.equal(
    readFileSync(repaired.configPath, "utf8"),
    composeCodexApiConfigToml({ homeDirectory: home }),
  );
});

test("codex-api mode injects OPENAI_API_KEY from the dedicated CODEX_API_KEY source after cleansing the ambient OpenAI credentials", () => {
  const environment = createCodexEndpointProcessEnvironment(
    { ...HOSTILE_SOURCE, CODEX_API_KEY: FAKE_KEY },
    { mode: "codex-api", codexHome: ISOLATED_HOME },
  );
  assert.equal(environment.OPENAI_API_KEY, FAKE_KEY);
  assert.equal(environment.CODEX_HOME, ISOLATED_HOME);
  // The hostile ambient values were cleansed, not forwarded.
  assert.notEqual(environment.OPENAI_API_KEY, "HOST-AMBIENT-OPENAI-KEY-9999");
  assert.equal(environment.OPENAI_BASE_URL, undefined);
  assert.notEqual(environment.CODEX_HOME, "C:\\Users\\host\\.codex");
});

test("a stored (envelope-resolved) key wins over the CODEX_API_KEY environment fallback", () => {
  const environment = createCodexEndpointProcessEnvironment(
    { CODEX_API_KEY: "ENV-FALLBACK-KEY" },
    { mode: "codex-api", codexHome: ISOLATED_HOME, apiKey: FAKE_KEY },
  );
  assert.equal(environment.OPENAI_API_KEY, FAKE_KEY);
});

test("codex-api mode fails loudly on a missing key or a malformed stored key", () => {
  for (const [label, source, endpoint] of [
    ["missing env", {}, { mode: "codex-api" as const, codexHome: ISOLATED_HOME }],
    [
      "empty stored",
      { CODEX_API_KEY: "x" },
      { mode: "codex-api" as const, codexHome: ISOLATED_HOME, apiKey: "" },
    ],
    [
      "nul stored",
      {},
      { mode: "codex-api" as const, codexHome: ISOLATED_HOME, apiKey: "a\0b" },
    ],
    ["missing home", {}, { mode: "codex-api" as const }],
  ] as const) {
    let failure: unknown;
    try {
      createCodexEndpointProcessEnvironment(
        source as NodeJS.ProcessEnv,
        endpoint,
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CodexEndpointEnvironmentError, label);
  }
});

test("the static catalog carries the real gpt-5.x wire names with their real effort tiers", () => {
  assert.deepEqual(
    CODEX_API_STATIC_CATALOG.models.map((model) => ({
      id: model.id,
      effortLevels: [...model.effortLevels],
    })),
    [
      { id: "gpt-5.6-sol", effortLevels: ["high", "ultra"] },
      { id: "gpt-5.6-codex", effortLevels: ["medium", "high"] },
      { id: "gpt-5.5-codex", effortLevels: ["medium", "high"] },
    ],
  );
  // No unpinned "default" tier: every effort value is a real provider tier,
  // so the codex binding forwards each one verbatim.
  assert.equal(
    CODEX_API_STATIC_CATALOG.models.some((model) =>
      model.effortLevels.includes("default"),
    ),
    false,
  );
});

test("a codex-api adapter without a key reports authentication-required without spawning or seeding anything", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "codex-api-adapter-"));
  const home = join(root, "codex-home");
  let transportCreations = 0;
  const adapter = new CodexAdapter(
    () => {
      transportCreations += 1;
      throw new Error("transport must not be created");
    },
    undefined,
    undefined,
    codexApiContext({ homeDirectory: home, sourceEnvironment: {} }),
  );
  let failure: unknown;
  try {
    await adapter.inspect("C:\\synthetic-project");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "authentication-required");
  assert.equal(transportCreations, 0);
  let seeded = true;
  try {
    readFileSync(join(home, CODEX_API_CONFIG_TOML_FILE_NAME), "utf8");
  } catch {
    seeded = false;
  }
  assert.equal(seeded, false);
});

test("a codex-api adapter with a key serves the static catalog after seeding, spawning nothing", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "codex-api-adapter-"));
  const home = join(root, "codex-home");
  let transportCreations = 0;
  const adapter = new CodexAdapter(
    () => {
      transportCreations += 1;
      throw new Error("transport must not be created");
    },
    undefined,
    undefined,
    codexApiContext({
      homeDirectory: home,
      sourceEnvironment: {
        [CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: FAKE_KEY,
      },
      discoverExecutable: async () => locatedDiscovery(),
    }),
  );
  const catalog = await adapter.inspect("C:\\synthetic-project");
  assert.equal(transportCreations, 0);
  assert.equal(catalog, CODEX_API_STATIC_CATALOG);
  const configToml = readFileSync(
    join(home, CODEX_API_CONFIG_TOML_FILE_NAME),
    "utf8",
  );
  assert.ok(configToml.includes(`model = "${CODEX_API_DEFAULT_MODEL_ID}"`));
  assert.ok(configToml.includes("https://api.openai.com/v1"));
  assert.ok(configToml.includes('wire_api = "responses"'));
});

test("a codex-api adapter whose codex executable is not locatable reports runtime-not-located after seeding", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "codex-api-adapter-"));
  const home = join(root, "codex-home");
  const adapter = new CodexAdapter(
    undefined,
    undefined,
    undefined,
    codexApiContext({
      homeDirectory: home,
      sourceEnvironment: {
        [CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar]: FAKE_KEY,
      },
      discoverExecutable: async () => ({ kind: "not-located" }),
    }),
  );
  let failure: unknown;
  try {
    await adapter.inspect("C:\\synthetic-project");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "runtime-not-located");
  // Seeding still ran: preparation precedes discovery on the static path.
  assert.ok(
    readFileSync(join(home, CODEX_API_CONFIG_TOML_FILE_NAME), "utf8").includes(
      "[model_providers.openai]",
    ),
  );
});

test("the environment source resolves the store key per call and injects through the shared factory", () => {
  let stored: string | undefined;
  const source = createCodexApiEndpointContext({
    codexHome: ISOLATED_HOME,
    resolveApiKey: () => stored,
  });
  assert.deepEqual(source.environmentSource(Object.freeze({})), {
    mode: "codex-api",
    codexHome: ISOLATED_HOME,
  });
  stored = FAKE_KEY;
  assert.deepEqual(source.environmentSource(Object.freeze({})), {
    mode: "codex-api",
    codexHome: ISOLATED_HOME,
    apiKey: FAKE_KEY,
  });
});

test("the kimi-platform mode keeps its own contract: same source and injected variable name", () => {
  const environment = createCodexEndpointProcessEnvironment(
    { KIMI_PLATFORM_API_KEY: FAKE_KEY },
    { mode: "kimi-platform", codexHome: ISOLATED_HOME },
  );
  assert.equal(environment.KIMI_PLATFORM_API_KEY, FAKE_KEY);
  assert.equal(environment.OPENAI_API_KEY, undefined);
});
