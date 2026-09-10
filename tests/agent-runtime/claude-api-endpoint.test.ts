import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeEndpointEnvironmentError,
  createEndpointProcessEnvironment,
  type ClaudeEndpointEnvironmentResolver,
} from "../../src/agent-runtime/claude/endpoint-env-factory.ts";
import {
  CLAUDE_API_ENDPOINT_ENV_CONTRACT,
  CLAUDE_API_ENDPOINT_KEY_NAME,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
  CLAUDE_API_ENDPOINT_SECRET_STORE_FILE_NAME,
  createClaudeApiEndpointContext,
  createClaudeApiEndpointEnvironmentSource,
} from "../../src/agent-runtime/claude/claude-api-endpoint.ts";
import {
  classifyApiKeyStaticAuthenticationStatusShape,
  classifyClaudeAuthenticationForMode,
} from "../../src/agent-runtime/claude/endpoint-authentication.ts";
import { parseClaudeAuthenticationStatus } from "../../src/agent-runtime/claude/authentication-status.ts";

/**
 * Ticket 21 claude-api endpoint: the dedicated CLAUDE_API_KEY source naming
 * discipline, cleanse-then-inject ANTHROPIC_API_KEY, the api_key healthy
 * auth-status shape, and the endpoint context. All credential material is an
 * explicit fake; nothing here touches a real CLI, network, or key.
 */

const FAKE_KEY = "FAKE-CLAUDE-API-KEY-1234";
const HOST_AMBIENT_KEY = "HOST-AMBIENT-ANTHROPIC-KEY-9999";

const HOSTILE_SOURCE: NodeJS.ProcessEnv = Object.freeze({
  // The host's own Anthropic usage: must never become this endpoint's key.
  ANTHROPIC_API_KEY: HOST_AMBIENT_KEY,
  ANTHROPIC_AUTH_TOKEN: "HOST-AMBIENT-AUTH-TOKEN",
  ANTHROPIC_BEARER_TOKEN: "HOST-AMBIENT-BEARER",
  CLAUDE_CODE_OAUTH_TOKEN: "HOST-AMBIENT-OAUTH",
});

test("identity constants pin the envelope subject, key name, and shared store file", () => {
  assert.equal(
    CLAUDE_API_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/claude-api",
  );
  assert.equal(CLAUDE_API_ENDPOINT_KEY_NAME, "claude-api");
  assert.equal(
    CLAUDE_API_ENDPOINT_SECRET_STORE_FILE_NAME,
    "endpoint-secret-envelope-store.json",
  );
  assert.equal(
    CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
    "CLAUDE_API_KEY",
  );
  assert.equal(
    CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeyInjectedEnvVar,
    "ANTHROPIC_API_KEY",
  );
});

test("api-key mode injects ANTHROPIC_API_KEY from the dedicated CLAUDE_API_KEY source, never the ambient injected name", () => {
  const environment = createEndpointProcessEnvironment(
    { ...HOSTILE_SOURCE, CLAUDE_API_KEY: FAKE_KEY },
    {
      mode: "api-key",
      apiKeyEnvVar: CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
    },
  );
  assert.equal(environment.ANTHROPIC_API_KEY, FAKE_KEY);
  // Every ambient Anthropic credential was cleansed before injection; only
  // the resolved key remains.
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(environment.ANTHROPIC_BEARER_TOKEN, undefined);
  assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  // The dedicated source name itself never leaks into the child env.
  assert.equal(environment.CLAUDE_API_KEY, undefined);
});

test("api-key mode reads the bare ANTHROPIC_API_KEY source only when no dedicated variable is named", () => {
  const environment = createEndpointProcessEnvironment(
    { ANTHROPIC_API_KEY: "BARE-KEY" },
    { mode: "api-key" },
  );
  assert.equal(environment.ANTHROPIC_API_KEY, "BARE-KEY");
});

test("api-key mode fails loudly on missing or malformed keys, stored or environmental", () => {
  for (const [label, source, endpoint] of [
    ["missing env", {}, { mode: "api-key" as const }],
    [
      "blank env",
      { ANTHROPIC_API_KEY: "   " },
      { mode: "api-key" as const },
    ],
    [
      "NUL env",
      { ANTHROPIC_API_KEY: "a\0b" },
      { mode: "api-key" as const },
    ],
    [
      "empty stored",
      {},
      { mode: "api-key" as const, apiKey: "" },
    ],
    [
      "NUL stored",
      {},
      { mode: "api-key" as const, apiKey: "a\0b" },
    ],
  ] as const) {
    let failure: unknown;
    try {
      createEndpointProcessEnvironment(
        source as NodeJS.ProcessEnv,
        endpoint,
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof ClaudeEndpointEnvironmentError, label);
    assert.equal(
      failure.reason === "api-key-missing" || failure.reason === "api-key-malformed",
      true,
      label,
    );
  }
});

test("a stored (envelope-resolved) key wins over the source environment and survives the cleanse", () => {
  const environment = createEndpointProcessEnvironment(
    { ...HOSTILE_SOURCE, CLAUDE_API_KEY: "ENV-FALLBACK-KEY" },
    {
      mode: "api-key",
      apiKeyEnvVar: CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
      apiKey: FAKE_KEY,
    },
  );
  assert.equal(environment.ANTHROPIC_API_KEY, FAKE_KEY);
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("the environment source resolves the store key per call and pins the dedicated source name", () => {
  let stored: string | undefined;
  const source = createClaudeApiEndpointEnvironmentSource({
    resolveApiKey: () => stored,
  });
  assert.deepEqual(source(Object.freeze({})), {
    mode: "api-key",
    apiKeyEnvVar: "CLAUDE_API_KEY",
  });
  stored = FAKE_KEY;
  assert.deepEqual(source(Object.freeze({})), {
    mode: "api-key",
    apiKeyEnvVar: "CLAUDE_API_KEY",
    apiKey: FAKE_KEY,
  });
  const built = createEndpointProcessEnvironment(HOSTILE_SOURCE, source({}));
  assert.equal(built.ANTHROPIC_API_KEY, FAKE_KEY);
});

test("the endpoint context pins api-key-static with the api_key healthy auth shape and no static catalog", () => {
  const context = createClaudeApiEndpointContext({});
  assert.equal(context.authenticationMode, "api-key-static");
  assert.equal(context.apiKeyStaticHealthyAuthMethod, "api_key");
  assert.equal(context.staticCatalog, undefined);
  assert.equal(typeof context.environmentSource, "function");
  assert.deepEqual(
    (context.environmentSource as ClaudeEndpointEnvironmentResolver)(
      Object.freeze({}),
    ),
    {
      mode: "api-key",
      apiKeyEnvVar: "CLAUDE_API_KEY",
    },
  );
  // An explicit source environment is carried for hermetic embedding.
  const hermetic = createClaudeApiEndpointContext({
    sourceEnvironment: {},
  });
  assert.deepEqual(hermetic.sourceEnvironment, {});
});

test("the api_key auth-status shape is bound for the claude-api endpoint and stays unknown for the bearer endpoints", () => {
  const apiKeyShape = parseClaudeAuthenticationStatus(
    '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}',
  );
  const oauthShape = parseClaudeAuthenticationStatus(
    '{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}',
  );
  assert.ok(apiKeyShape && oauthShape);
  // claude-api (P1 spike: the CLI reports an injected ANTHROPIC_API_KEY as
  // api_key): its own mechanism is the healthy shape.
  assert.equal(
    classifyApiKeyStaticAuthenticationStatusShape(apiKeyShape, "api_key"),
    "bound",
  );
  assert.equal(
    classifyApiKeyStaticAuthenticationStatusShape(oauthShape, "api_key"),
    "unknown",
  );
  // GLM/Kimi/DeepSeek (env bearer token): the default healthy shape stays
  // oauth_token and the api_key shape stays a leaked-credential unknown.
  assert.equal(
    classifyApiKeyStaticAuthenticationStatusShape(oauthShape),
    "bound",
  );
  assert.equal(
    classifyApiKeyStaticAuthenticationStatusShape(apiKeyShape),
    "unknown",
  );
  assert.equal(
    classifyClaudeAuthenticationForMode(
      '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}',
      "api-key-static",
      "api_key",
    ),
    "bound",
  );
  assert.equal(
    classifyClaudeAuthenticationForMode(
      '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
      "api-key-static",
      "api_key",
    ),
    "sign-in-required",
  );
  // A claude.ai OAuth residue never reads as bound for a static-key endpoint.
  assert.equal(
    classifyClaudeAuthenticationForMode(
      '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}',
      "api-key-static",
      "api_key",
    ),
    "unknown",
  );
});
