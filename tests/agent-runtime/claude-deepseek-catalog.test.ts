import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPSEEK_DEFAULT_MODEL_ID,
  DEEPSEEK_ENDPOINT_ENV_CONTRACT,
  DEEPSEEK_MODEL_EFFORT_LEVELS,
  DEEPSEEK_MODEL_IDS,
  DEEPSEEK_STATIC_CATALOG,
  createDeepseekEndpointContext,
  createDeepseekEndpointEnvironmentSource,
  deepseekIsolatedClaudeConfigDir,
  isDeepseekStaticCatalogModelId,
} from "../../src/agent-runtime/claude/deepseek-catalog.ts";
import { createEndpointProcessEnvironment } from "../../src/agent-runtime/claude/endpoint-env-factory.ts";
import {
  DEEPSEEK_ENDPOINT_KEY_NAME,
  DEEPSEEK_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/claude/deepseek-endpoint-key.ts";

const FAKE_TOKEN_ENV: NodeJS.ProcessEnv = Object.freeze({
  DEEPSEEK_ANTHROPIC_AUTH_TOKEN: "FAKE-DEEPSEEK-TOKEN-1234",
});

test("the static catalog carries exactly the two confirmed DeepSeek wire names with low/high/max tiers and no default tier", () => {
  assert.deepEqual(
    DEEPSEEK_STATIC_CATALOG.models.map((model) => model.id),
    ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
  );
  assert.deepEqual(DEEPSEEK_MODEL_IDS, [
    "deepseek-v4-pro[1m]",
    "deepseek-v4-flash",
  ]);
  assert.equal(DEEPSEEK_DEFAULT_MODEL_ID, "deepseek-v4-pro[1m]");
  assert.equal(isDeepseekStaticCatalogModelId("deepseek-v4-pro[1m]"), true);
  assert.equal(isDeepseekStaticCatalogModelId("deepseek-v4-flash"), true);
  assert.equal(isDeepseekStaticCatalogModelId("deepseek-chat"), false);
  assert.equal(isDeepseekStaticCatalogModelId("claude-haiku-5"), false);
  assert.equal(isDeepseekStaticCatalogModelId("deepseek-v4-flash-vision-exp"), false);
  for (const model of DEEPSEEK_STATIC_CATALOG.models) {
    assert.deepEqual(model.effortLevels, ["low", "high", "max"]);
    assert.equal(model.effortLevels.includes("default"), false);
  }
  assert.deepEqual(DEEPSEEK_MODEL_EFFORT_LEVELS, ["low", "high", "max"]);
  assert.deepEqual(DEEPSEEK_STATIC_CATALOG.executionModes, ["single-agent"]);
  assert.deepEqual(DEEPSEEK_STATIC_CATALOG.accessModes, ["full-access"]);
  assert.equal(Object.isFrozen(DEEPSEEK_STATIC_CATALOG), true);
});

test("the environment source names the selected DeepSeek model on every alias override, for every valid effort tier", () => {
  const source = createDeepseekEndpointEnvironmentSource({
    configDir: "C:\\temp\\deepseek-isolated",
  });
  for (const effortLevel of DEEPSEEK_MODEL_EFFORT_LEVELS) {
    const flashSession = source({
      profile: {
        model: "deepseek-v4-flash",
        effortLevel,
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    assert.equal(flashSession.defaultAliasModels?.opus, "deepseek-v4-flash");
    assert.equal(flashSession.defaultAliasModels?.sonnet, "deepseek-v4-flash");
    assert.equal(flashSession.defaultAliasModels?.haiku, "deepseek-v4-flash");
  }

  const defaultSession = source({});
  assert.equal(defaultSession.defaultAliasModels?.opus, DEEPSEEK_DEFAULT_MODEL_ID);
  assert.equal(defaultSession.configDir, "C:\\temp\\deepseek-isolated");
  assert.equal(defaultSession.mode, "glm");
});

test("a non-DeepSeek model id is clamped to the default and never injected as an alias (silent-mapping defense)", () => {
  const source = createDeepseekEndpointEnvironmentSource({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  const hostile = source({
    profile: {
      model: "claude-haiku-5",
      effortLevel: "low",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  assert.equal(hostile.defaultAliasModels?.opus, DEEPSEEK_DEFAULT_MODEL_ID);
  const environment = createEndpointProcessEnvironment(
    FAKE_TOKEN_ENV,
    hostile,
  );
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, DEEPSEEK_DEFAULT_MODEL_ID);
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL?.includes("claude"), false);
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, DEEPSEEK_DEFAULT_MODEL_ID);
  assert.equal(environment.ANTHROPIC_DEFAULT_SONNET_MODEL, DEEPSEEK_DEFAULT_MODEL_ID);
});

test("the resolved base URL is always the DeepSeek contract value, never a GLM-contract default", () => {
  const context = createDeepseekEndpointContext({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  const environment = createEndpointProcessEnvironment(
    context.sourceEnvironment ?? {},
    typeof context.environmentSource === "function"
      ? context.environmentSource({})
      : context.environmentSource,
  );
  assert.equal(environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.notEqual(
    environment.ANTHROPIC_BASE_URL,
    "https://open.bigmodel.cn/api/anthropic",
  );
});

test("a DEEPSEEK_ANTHROPIC_BASE_URL override wins over the contract default", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    DEEPSEEK_ANTHROPIC_BASE_URL: "https://mirror.example.com/anthropic",
  });
  const source = createDeepseekEndpointEnvironmentSource({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment,
  });
  const environment = createEndpointProcessEnvironment(
    sourceEnvironment,
    source({}),
  );
  assert.equal(
    environment.ANTHROPIC_BASE_URL,
    "https://mirror.example.com/anthropic",
  );
});

// w232: the Settings "Base URL (optional)" field's saved override must win
// over both the env var and the contract default, mirroring resolveAuthToken.
test("a live resolveBaseUrl override wins over DEEPSEEK_ANTHROPIC_BASE_URL and the contract default", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    DEEPSEEK_ANTHROPIC_BASE_URL: "https://mirror.example.com/anthropic",
  });
  const source = createDeepseekEndpointEnvironmentSource({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment,
    resolveBaseUrl: () => "http://127.0.0.1:4181",
  });
  const environment = createEndpointProcessEnvironment(
    sourceEnvironment,
    source({}),
  );
  assert.equal(environment.ANTHROPIC_BASE_URL, "http://127.0.0.1:4181");
});

test("resolveBaseUrl returning undefined falls through to the env var, exactly as before w232", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    DEEPSEEK_ANTHROPIC_BASE_URL: "https://mirror.example.com/anthropic",
  });
  const source = createDeepseekEndpointEnvironmentSource({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment,
    resolveBaseUrl: () => undefined,
  });
  const environment = createEndpointProcessEnvironment(
    sourceEnvironment,
    source({}),
  );
  assert.equal(
    environment.ANTHROPIC_BASE_URL,
    "https://mirror.example.com/anthropic",
  );
});

test("the endpoint context composes static catalog, api-key-static auth, and the env source", () => {
  const context = createDeepseekEndpointContext({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  assert.equal(context.authenticationMode, "api-key-static");
  assert.equal(context.staticCatalog, DEEPSEEK_STATIC_CATALOG);
  const environment = createEndpointProcessEnvironment(
    context.sourceEnvironment ?? {},
    typeof context.environmentSource === "function"
      ? context.environmentSource({})
      : context.environmentSource,
  );
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "FAKE-DEEPSEEK-TOKEN-1234");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\temp\\deepseek-isolated");
});

test("a stored envelope token is injected even with no token in the source environment", () => {
  const source = createDeepseekEndpointEnvironmentSource({
    configDir: "C:\\temp\\deepseek-isolated",
    sourceEnvironment: Object.freeze({}),
    resolveAuthToken: () => "FAKE-ENVELOPE-DEEPSEEK-TOKEN-9876",
  });
  const environment = createEndpointProcessEnvironment({}, source({}));
  assert.equal(
    environment.ANTHROPIC_AUTH_TOKEN,
    "FAKE-ENVELOPE-DEEPSEEK-TOKEN-9876",
  );
  assert.equal(environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
});

test("the isolated config dir lives under the platform base root, never the real claude home", () => {
  const directory = deepseekIsolatedClaudeConfigDir("C:\\TEMP-ROOT");
  assert.equal(
    directory,
    "C:\\TEMP-ROOT\\synchronized-intellect-network\\deepseek-claude-config",
  );
  assert.equal(directory.includes(".claude"), false);
  assert.equal(
    deepseekIsolatedClaudeConfigDir("C:\\TEMP-ROOT"),
    deepseekIsolatedClaudeConfigDir("C:\\TEMP-ROOT"),
  );
});

test("the env contract and the envelope identity match the ticket 12 design of record", () => {
  assert.equal(
    DEEPSEEK_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
    "DEEPSEEK_ANTHROPIC_AUTH_TOKEN",
  );
  assert.equal(
    DEEPSEEK_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
    "DEEPSEEK_ANTHROPIC_BASE_URL",
  );
  assert.equal(
    DEEPSEEK_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    "https://api.deepseek.com/anthropic",
  );
  assert.equal(
    DEEPSEEK_ENDPOINT_ENV_CONTRACT.modelEnvVar,
    "DEEPSEEK_ANTHROPIC_MODEL",
  );
  assert.equal(
    DEEPSEEK_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/deepseek-api",
  );
  assert.equal(DEEPSEEK_ENDPOINT_KEY_NAME, "deepseek-api");
  assert.match(DEEPSEEK_ENDPOINT_KEY_NAME, /^[a-z0-9][a-z0-9._-]{0,64}$/);
});
