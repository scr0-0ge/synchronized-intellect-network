import assert from "node:assert/strict";
import test from "node:test";

import {
  GLM_DEFAULT_MODEL_ID,
  GLM_ENDPOINT_ENV_CONTRACT,
  GLM_MODEL_IDS,
  GLM_STATIC_CATALOG,
  createGlmEndpointContext,
  createGlmEndpointEnvironmentSource,
  glmIsolatedClaudeConfigDir,
  isGlmStaticCatalogModelId,
} from "../../src/agent-runtime/claude/glm-catalog.ts";
import { createEndpointProcessEnvironment } from "../../src/agent-runtime/claude/endpoint-env-factory.ts";

const FAKE_TOKEN_ENV: NodeJS.ProcessEnv = Object.freeze({
  GLM_ANTHROPIC_AUTH_TOKEN: "FAKE-GLM-TOKEN-1234",
});

test("the static catalog carries exactly the two confirmed GLM wire names", () => {
  assert.deepEqual(
    GLM_STATIC_CATALOG.models.map((model) => model.id),
    ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
  );
  assert.deepEqual(GLM_MODEL_IDS, ["glm-5.3[1m]", "glm-5.3-flash[1m]"]);
  assert.equal(GLM_DEFAULT_MODEL_ID, "glm-5.3[1m]");
  assert.equal(isGlmStaticCatalogModelId("glm-5.3[1m]"), true);
  assert.equal(isGlmStaticCatalogModelId("claude-opus-5[1m]"), false);
  for (const model of GLM_STATIC_CATALOG.models) {
    assert.deepEqual(model.effortLevels, ["default", "low", "high", "max"]);
  }
  assert.deepEqual(GLM_STATIC_CATALOG.executionModes, ["single-agent"]);
  assert.deepEqual(GLM_STATIC_CATALOG.accessModes, ["full-access"]);
  assert.equal(Object.isFrozen(GLM_STATIC_CATALOG), true);
});

test("the environment source names the selected GLM model on every alias override", () => {
  const source = createGlmEndpointEnvironmentSource({
    configDir: "C:\\temp\\glm-isolated",
  });
  const flashSession = source({
    profile: {
      model: "glm-5.3-flash[1m]",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  assert.equal(flashSession.defaultAliasModels?.opus, "glm-5.3-flash[1m]");
  assert.equal(flashSession.defaultAliasModels?.sonnet, "glm-5.3-flash[1m]");
  assert.equal(flashSession.defaultAliasModels?.haiku, "glm-5.3-flash[1m]");

  const defaultSession = source({});
  assert.equal(defaultSession.defaultAliasModels?.opus, GLM_DEFAULT_MODEL_ID);
  assert.equal(defaultSession.configDir, "C:\\temp\\glm-isolated");
  assert.equal(defaultSession.mode, "glm");
});

test("a non-GLM model id is clamped to the default and never injected as an alias", () => {
  const source = createGlmEndpointEnvironmentSource({
    configDir: "C:\\temp\\glm-isolated",
  });
  const hostile = source({
    profile: {
      model: "claude-opus-5[1m]",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  assert.equal(hostile.defaultAliasModels?.opus, GLM_DEFAULT_MODEL_ID);
  const environment = createEndpointProcessEnvironment(
    FAKE_TOKEN_ENV,
    hostile,
  );
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, GLM_DEFAULT_MODEL_ID);
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL?.includes("claude"), false);
});

test("the endpoint context composes static catalog, api-key-static auth, and the env source", () => {
  const context = createGlmEndpointContext({
    configDir: "C:\\temp\\glm-isolated",
    sourceEnvironment: FAKE_TOKEN_ENV,
  });
  assert.equal(context.authenticationMode, "api-key-static");
  assert.equal(context.staticCatalog, GLM_STATIC_CATALOG);
  const environment = createEndpointProcessEnvironment(
    context.sourceEnvironment ?? {},
    typeof context.environmentSource === "function"
      ? context.environmentSource({})
      : context.environmentSource,
  );
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "FAKE-GLM-TOKEN-1234");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\temp\\glm-isolated");
});

// w232: the Settings "Base URL (optional)" field's saved override must win
// over both GLM_ANTHROPIC_BASE_URL and the contract default, mirroring
// resolveAuthToken's precedence.
test("a live resolveBaseUrl override wins over GLM_ANTHROPIC_BASE_URL and the contract default", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    GLM_ANTHROPIC_BASE_URL: "https://mirror.example.com/anthropic",
  });
  const source = createGlmEndpointEnvironmentSource({
    configDir: "C:\\temp\\glm-isolated",
    sourceEnvironment,
    resolveBaseUrl: () => "http://127.0.0.1:4180",
  });
  const environment = createEndpointProcessEnvironment(
    sourceEnvironment,
    source({}),
  );
  assert.equal(environment.ANTHROPIC_BASE_URL, "http://127.0.0.1:4180");
});

test("resolveBaseUrl returning undefined falls through to GLM_ANTHROPIC_BASE_URL, exactly as before w232", () => {
  const sourceEnvironment = Object.freeze({
    ...FAKE_TOKEN_ENV,
    GLM_ANTHROPIC_BASE_URL: "https://mirror.example.com/anthropic",
  });
  const source = createGlmEndpointEnvironmentSource({
    configDir: "C:\\temp\\glm-isolated",
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

test("the isolated config dir lives under the platform temp root, never the real claude home", () => {
  const directory = glmIsolatedClaudeConfigDir("C:\\TEMP-ROOT");
  assert.equal(directory, "C:\\TEMP-ROOT\\synchronized-intellect-network\\glm-claude-config");
  assert.equal(directory.includes(".claude"), false);
  assert.equal(GLM_ENDPOINT_ENV_CONTRACT.authTokenEnvVar, "GLM_ANTHROPIC_AUTH_TOKEN");
});
