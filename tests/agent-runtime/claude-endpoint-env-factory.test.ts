import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS,
  CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS,
  createClaudeOAuthEnvironment,
  createClaudeProcessEnvironment,
} from "../../src/agent-runtime/claude/process-transport.ts";
import {
  CLAUDE_DEPLOYMENT_SELECTOR_KEYS as FACTORY_DEPLOYMENT_SELECTOR_KEYS,
  CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS as FACTORY_PROFILE_OVERRIDE_KEYS,
  ClaudeEndpointEnvironmentError,
  CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS as FACTORY_CREDENTIAL_KEYS,
  GLM_ENDPOINT_ENV_CONTRACT,
  createClaudeOAuthEnvironment as factoryCreateClaudeOAuthEnvironment,
  createEndpointProcessEnvironment,
} from "../../src/agent-runtime/claude/endpoint-env-factory.ts";

function fullHygieneSource(): NodeJS.ProcessEnv {
  return {
    PATH: "C:\\Windows\\System32",
    SYSTEMROOT: "C:\\Windows",
    ANTHROPIC_API_KEY: "stale-api-key",
    ANTHROPIC_AUTH_TOKEN: "stale-auth-token",
    ANTHROPIC_BEARER_TOKEN: "stale-bearer",
    CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth",
    CLAUDECODE: "stale-claudecode",
    ANTHROPIC_MODEL: "stale-model",
    CLAUDE_CODE_EFFORT_LEVEL: "stale-effort",
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "stale-flag",
    CLAUDE_CODE_USE_BEDROCK: "stale-bedrock",
    CLAUDE_CODE_USE_VERTEX: "stale-vertex",
    CLAUDE_CODE_USE_FOUNDRY: "stale-foundry",
  };
}

const battery: readonly NodeJS.ProcessEnv[] = [
  {},
  { PATH: "C:\\Windows", SYSTEMROOT: "C:\\Windows" },
  fullHygieneSource(),
  {
    ...fullHygieneSource(),
    CLAUDE_CONFIG_DIR: "C:\\Users\\test-user\\.claude",
    ANTHROPIC_BASE_URL: "https://stale.example",
  },
  { CLAUDE_CODE_USE_BEDROCK: "1" },
];

test("the endpoint factory re-exports the single-sourced cleansing lists", () => {
  assert.deepEqual(FACTORY_CREDENTIAL_KEYS, CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS);
  assert.deepEqual(
    FACTORY_PROFILE_OVERRIDE_KEYS,
    CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS,
  );
  assert.deepEqual(
    FACTORY_DEPLOYMENT_SELECTOR_KEYS,
    CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  );
});

test("subscription mode is deeply equal to the historical factory across the battery", () => {
  for (const source of battery) {
    assert.deepEqual(
      createEndpointProcessEnvironment(source, { mode: "subscription" }),
      createClaudeProcessEnvironment(source, "subscription"),
    );
    assert.deepEqual(
      factoryCreateClaudeOAuthEnvironment(source),
      createClaudeOAuthEnvironment(source),
    );
  }
});

test("subscription mode never throws and never mutates the source", () => {
  const source = fullHygieneSource();
  const environment = createEndpointProcessEnvironment(
    { CLAUDE_CODE_USE_BEDROCK: "x\0y" },
    { mode: "subscription" },
  );
  assert.ok(environment !== undefined);
  createEndpointProcessEnvironment(source, { mode: "subscription" });
  assert.equal(source.PATH, "C:\\Windows\\System32");
});

test("glm mode injects base URL, token, isolated config dir, and true-name aliases after cleansing", () => {
  const source: NodeJS.ProcessEnv = {
    ...fullHygieneSource(),
    GLM_ANTHROPIC_AUTH_TOKEN: "FAKE-GLM-TOKEN-1234",
  };
  const environment = createEndpointProcessEnvironment(source, {
    mode: "glm",
    defaultAliasModels: {
      opus: "glm-5.3[1m]",
      sonnet: "glm-5.3[1m]",
      haiku: "glm-5.3[1m]",
    },
    configDir: "C:\\temp\\glm-isolated",
  });
  assert.equal(
    environment.ANTHROPIC_BASE_URL,
    GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  );
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "FAKE-GLM-TOKEN-1234");
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, "glm-5.3[1m]");
  assert.equal(environment.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.3[1m]");
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-5.3[1m]");
  assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\temp\\glm-isolated");
  assert.equal(environment.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  assert.equal(environment.CLAUDE_AGENT_SDK_VERSION, "0.3.220");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BEARER_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDECODE",
    "CLAUDE_CODE_EFFORT_LEVEL",
    "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(environment, key),
      false,
      key,
    );
  }
});

test("glm mode never falls back to an ambient Anthropic token", () => {
  assert.throws(
    () =>
      createEndpointProcessEnvironment(
        { ANTHROPIC_AUTH_TOKEN: "AMBIENT-ANTHROPIC-TOKEN" },
        { mode: "glm" },
      ),
    (error: unknown) =>
      error instanceof ClaudeEndpointEnvironmentError &&
      error.reason === "token-missing",
  );
});

test("glm mode token defects are token-missing or token-malformed", () => {
  for (const [source, reason] of [
    [{}, "token-missing"],
    [{ GLM_ANTHROPIC_AUTH_TOKEN: " " }, "token-missing"],
    [{ GLM_ANTHROPIC_AUTH_TOKEN: "a\0b" }, "token-malformed"],
  ] as const) {
    assert.throws(
      () => createEndpointProcessEnvironment(source, { mode: "glm" }),
      (error: unknown) =>
        error instanceof ClaudeEndpointEnvironmentError &&
        error.reason === reason,
    );
  }
});

test("glm base URL precedence: descriptor over env over contract default; localhost http allowed", () => {
  const withEnv = {
    GLM_ANTHROPIC_BASE_URL: "https://env.example",
    GLM_ANTHROPIC_AUTH_TOKEN: "FAKE",
  };
  assert.equal(
    createEndpointProcessEnvironment(withEnv, {
      mode: "glm",
      baseUrl: "https://descriptor.example",
    }).ANTHROPIC_BASE_URL,
    "https://descriptor.example",
  );
  assert.equal(
    createEndpointProcessEnvironment(withEnv, { mode: "glm" })
      .ANTHROPIC_BASE_URL,
    "https://env.example",
  );
  assert.equal(
    createEndpointProcessEnvironment(
      { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
      { mode: "glm" },
    ).ANTHROPIC_BASE_URL,
    GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  );
  for (const baseUrl of ["not-a-url", "ftp://x.example", "http://evil.example"]) {
    assert.throws(
      () =>
        createEndpointProcessEnvironment(
          { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
          { mode: "glm", baseUrl },
        ),
      (error: unknown) =>
        error instanceof ClaudeEndpointEnvironmentError &&
        error.reason === "base-url-invalid",
    );
  }
  assert.equal(
    createEndpointProcessEnvironment(
      { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
      { mode: "glm", baseUrl: "http://localhost:3210" },
    ).ANTHROPIC_BASE_URL,
    "http://localhost:3210",
  );
});

test("glm model injection: explicit descriptor only, never ambient ANTHROPIC_MODEL", () => {
  assert.equal(
    createEndpointProcessEnvironment(
      { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE", ANTHROPIC_MODEL: "stale-model" },
      { mode: "glm" },
    ).ANTHROPIC_MODEL,
    undefined,
  );
  assert.equal(
    createEndpointProcessEnvironment(
      { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
      { mode: "glm", model: "glm-5.3-flash[1m]" },
    ).ANTHROPIC_MODEL,
    "glm-5.3-flash[1m]",
  );
  assert.throws(
    () =>
      createEndpointProcessEnvironment(
        { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
        { mode: "glm", defaultAliasModels: { opus: "a\0b" } },
      ),
    (error: unknown) =>
      error instanceof ClaudeEndpointEnvironmentError &&
      error.reason === "model-invalid",
  );
});

test("api-key mode injects ANTHROPIC_API_KEY from its own source variable", () => {
  const environment = createEndpointProcessEnvironment(
    { ...fullHygieneSource(), MY_ENDPOINT_KEY: "k-1234" },
    { mode: "api-key", apiKeyEnvVar: "MY_ENDPOINT_KEY" },
  );
  assert.equal(environment.ANTHROPIC_API_KEY, "k-1234");
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(environment.CLAUDE_CODE_ENTRYPOINT, "sdk-ts");
  assert.throws(
    () => createEndpointProcessEnvironment({}, { mode: "api-key" }),
    (error: unknown) =>
      error instanceof ClaudeEndpointEnvironmentError &&
      error.reason === "api-key-missing",
  );
});

test("configDir injection overrides any ambient CLAUDE_CONFIG_DIR", () => {
  const environment = createEndpointProcessEnvironment(
    { CLAUDE_CONFIG_DIR: "C:\\Users\\test-user\\.claude", GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
    { mode: "glm", configDir: "C:\\temp\\glm-isolated" },
  );
  assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\temp\\glm-isolated");
  assert.throws(
    () =>
      createEndpointProcessEnvironment(
        { GLM_ANTHROPIC_AUTH_TOKEN: "FAKE" },
        { mode: "glm", configDir: " " },
      ),
    (error: unknown) =>
      error instanceof ClaudeEndpointEnvironmentError &&
      error.reason === "config-dir-invalid",
  );
});
