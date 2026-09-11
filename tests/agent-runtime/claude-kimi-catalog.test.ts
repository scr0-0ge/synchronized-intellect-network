import assert from "node:assert/strict";
import test from "node:test";

import {
  KIMI_DEFAULT_MODEL_ID,
  KIMI_ENDPOINT_ENV_CONTRACT,
  KIMI_K27_CODE_EFFORT_LEVELS,
  KIMI_K3_EFFORT_LEVELS,
  KIMI_MODEL_IDS,
  KIMI_STATIC_CATALOG,
  createKimiEndpointContext,
  createKimiEndpointEnvironmentSource,
  isKimiStaticCatalogModelId,
  kimiIsolatedClaudeConfigDir,
} from "../../src/agent-runtime/claude/kimi-catalog.ts";
import { createEndpointProcessEnvironment } from "../../src/agent-runtime/claude/endpoint-env-factory.ts";
import {
  KIMI_ENDPOINT_KEY_NAME,
  KIMI_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/claude/kimi-endpoint-key.ts";

const FAKE_TOKEN_ENV: NodeJS.ProcessEnv = Object.freeze({
  KIMI_CODE_ANTHROPIC_AUTH_TOKEN: "FAKE-KIMI-TOKEN-1234",
});

test("the static catalog carries exactly the four confirmed Kimi wire names with per-family effort tiers", () => {
  assert.deepEqual(
    KIMI_STATIC_CATALOG.models.map((model) => model.id),
    [
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3-256k",
      "k3",
    ],
  );
  assert.deepEqual(KIMI_MODEL_IDS, [
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
    "k3-256k",
    "k3",
  ]);
  assert.equal(KIMI_DEFAULT_MODEL_ID, "kimi-for-coding");
  assert.equal(isKimiStaticCatalogModelId("kimi-for-coding"), true);
  assert.equal(isKimiStaticCatalogModelId("k3-256k"), true);
  assert.equal(isKimiStaticCatalogModelId("kimi-k2.7-code"), false);
  assert.equal(isKimiStaticCatalogModelId("claude-opus-5[1m]"), false);
  for (const model of KIMI_STATIC_CATALOG.models) {
    if (model.id === "k3" || model.id === "k3-256k") {
      assert.deepEqual(model.effortLevels, ["low", "high", "max"]);
    } else {
      assert.deepEqual(model.effortLevels, ["default"]);
    }
  }
  assert.deepEqual(KIMI_K3_EFFORT_LEVELS, ["low", "high", "max"]);
  assert.deepEqual(KIMI_K27_CODE_EFFORT_LEVELS, ["default"]);
  assert.deepEqual(KIMI_STATIC_CATALOG.executionModes, ["single-agent"]);
  assert.deepEqual(KIMI_STATIC_CATALOG.accessModes, ["full-access"]);
  assert.equal(Object.isFrozen(KIMI_STATIC_CATALOG), true);
});

test("the environment source names the selected Kimi model on every alias override, for every valid effort tier", () => {
  const source = createKimiEndpointEnvironmentSource({
    configDir: "C:\\temp\\kimi-isolated",
  });
  for (const effortLevel of KIMI_K3_EFFORT_LEVELS) {
    const k3Session = source({
      profile: {
        model: "k3-256k",
        effortLevel,
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    assert.equal(k3Session.defaultAliasModels?.opus, "k3-256k");
    assert.equal(k3Session.defaultAliasModels?.sonnet, "k3-256k");
    assert.equal(k3Session.defaultAliasModels?.haiku, "k3-256k");
  }
  for (const effortLevel of KIMI_K27_CODE_EFFORT_LEVELS) {
    const k27Session = source({
      profile: {
        model: "kimi-for-coding-highspeed",
        effortLevel,
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    assert.equal(k27Session.defaultAliasModels?.opus, "kimi-for-coding-highspeed");
    assert.equal(k27Session.defaultAliasModels?.sonnet, "kimi-for-coding-highspeed");
    assert.equal(k27Session.defaultAliasModels?.haiku, "kimi-for-coding-highspeed");
  }

  const defaultSession = source({});
  assert.equal(defaultSession.defaultAliasModels?.opus, KIMI_DEFAULT_MODEL_ID);
  assert.equal(defaultSession.configDir, "C:\\temp\\kimi-isolated");
  assert.equal(defaultSession.mode, "glm");
});

test("a non-Kimi model id is clamped to the default and never injected as an alias", () => {
  const source = createKimiEndpointEnvironmentSource({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  const hostile = source({
    profile: {
      model: "claude-opus-5[1m]",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  assert.equal(hostile.defaultAliasModels?.opus, KIMI_DEFAULT_MODEL_ID);
  const environment = createEndpointProcessEnvironment(
    FAKE_TOKEN_ENV,
    hostile,
  );
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, KIMI_DEFAULT_MODEL_ID);
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL?.includes("claude"), false);
  assert.equal(environment.ANTHROPIC_DEFAULT_SONNET_MODEL, KIMI_DEFAULT_MODEL_ID);
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, KIMI_DEFAULT_MODEL_ID);
});

test("the resolved base URL is always the Kimi contract value, never a GLM-contract default", () => {
  const context = createKimiEndpointContext({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  const environment = createEndpointProcessEnvironment(
    context.sourceEnvironment ?? {},
    typeof context.environmentSource === "function"
      ? context.environmentSource({})
      : context.environmentSource,
  );
  assert.equal(environment.ANTHROPIC_BASE_URL, "https://api.kimi.com/coding/");
  assert.notEqual(
    environment.ANTHROPIC_BASE_URL,
    "https://open.bigmodel.cn/api/anthropic",
  );
});

test("a KIMI_CODE_ANTHROPIC_BASE_URL override wins over the contract default", () => {
  const source = createKimiEndpointEnvironmentSource({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment: Object.freeze({
      ...FAKE_TOKEN_ENV,
      KIMI_CODE_ANTHROPIC_BASE_URL: "https://api.kimi.com/coding-mirror/",
    }),
  });
  const session = source({});
  const environment = createEndpointProcessEnvironment(
    Object.freeze({
      ...FAKE_TOKEN_ENV,
      KIMI_CODE_ANTHROPIC_BASE_URL: "https://api.kimi.com/coding-mirror/",
    }),
    session,
  );
  assert.equal(
    environment.ANTHROPIC_BASE_URL,
    "https://api.kimi.com/coding-mirror/",
  );
});

// w232: the Settings "Base URL (optional)" field's saved override must win
// over both the env var and the contract default, mirroring resolveAuthToken.
test("a live resolveBaseUrl override wins over KIMI_CODE_ANTHROPIC_BASE_URL and the contract default", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    KIMI_CODE_ANTHROPIC_BASE_URL: "https://api.kimi.com/coding-mirror/",
  });
  const source = createKimiEndpointEnvironmentSource({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment,
    resolveBaseUrl: () => "http://127.0.0.1:4182",
  });
  const environment = createEndpointProcessEnvironment(
    sourceEnvironment,
    source({}),
  );
  assert.equal(environment.ANTHROPIC_BASE_URL, "http://127.0.0.1:4182");
});

test("resolveBaseUrl returning undefined falls through to the env var, exactly as before w232", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    KIMI_CODE_ANTHROPIC_BASE_URL: "https://api.kimi.com/coding-mirror/",
  });
  const source = createKimiEndpointEnvironmentSource({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment,
    resolveBaseUrl: () => undefined,
  });
  const environment = createEndpointProcessEnvironment(
    sourceEnvironment,
    source({}),
  );
  assert.equal(
    environment.ANTHROPIC_BASE_URL,
    "https://api.kimi.com/coding-mirror/",
  );
});

test("the endpoint context composes static catalog, api-key-static auth, and the env source", () => {
  const context = createKimiEndpointContext({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  assert.equal(context.authenticationMode, "api-key-static");
  assert.equal(context.staticCatalog, KIMI_STATIC_CATALOG);
  const environment = createEndpointProcessEnvironment(
    context.sourceEnvironment ?? {},
    typeof context.environmentSource === "function"
      ? context.environmentSource({})
      : context.environmentSource,
  );
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "FAKE-KIMI-TOKEN-1234");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\temp\\kimi-isolated");
});

test("a stored envelope token is injected even with no token in the source environment", () => {
  const source = createKimiEndpointEnvironmentSource({
    configDir: "C:\\temp\\kimi-isolated",
    sourceEnvironment: Object.freeze({}),
    resolveAuthToken: () => "FAKE-ENVELOPE-KIMI-TOKEN-9876",
  });
  const environment = createEndpointProcessEnvironment({}, source({}));
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "FAKE-ENVELOPE-KIMI-TOKEN-9876");
  assert.equal(environment.ANTHROPIC_BASE_URL, "https://api.kimi.com/coding/");
});

test("the isolated config dir lives under the platform base root, never the real claude home", () => {
  const directory = kimiIsolatedClaudeConfigDir("C:\\TEMP-ROOT");
  assert.equal(directory, "C:\\TEMP-ROOT\\synchronized-intellect-network\\kimi-claude-config");
  assert.equal(directory.includes(".claude"), false);
  assert.equal(
    kimiIsolatedClaudeConfigDir("C:\\TEMP-ROOT"),
    kimiIsolatedClaudeConfigDir("C:\\TEMP-ROOT"),
  );
});

test("the env contract and the envelope identity match the ticket 11 design of record", () => {
  assert.equal(
    KIMI_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
    "KIMI_CODE_ANTHROPIC_AUTH_TOKEN",
  );
  assert.equal(
    KIMI_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
    "KIMI_CODE_ANTHROPIC_BASE_URL",
  );
  assert.equal(
    KIMI_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    "https://api.kimi.com/coding/",
  );
  assert.equal(
    KIMI_ENDPOINT_ENV_CONTRACT.modelEnvVar,
    "KIMI_CODE_ANTHROPIC_MODEL",
  );
  assert.equal(KIMI_ENDPOINT_KEY_SUBJECT, "workbench://runtime-endpoint/kimi-code");
  assert.equal(KIMI_ENDPOINT_KEY_NAME, "kimi-code");
  assert.match(KIMI_ENDPOINT_KEY_NAME, /^[a-z0-9][a-z0-9._-]{0,64}$/);
});
