import assert from "node:assert/strict";
import test from "node:test";

import {
  createEndpointProcessEnvironment,
  ClaudeEndpointEnvironmentError,
  GLM_ENDPOINT_ENV_CONTRACT,
} from "../../src/agent-runtime/claude/endpoint-env-factory.ts";
import { createGlmEndpointContext } from "../../src/agent-runtime/claude/glm-catalog.ts";

/**
 * Key-source precedence for the GLM endpoint (work order 07 ruling 2): the
 * endpoint secret envelope store wins, the `GLM_ANTHROPIC_AUTH_TOKEN`
 * environment variable stays the fallback, and "neither" keeps the P2
 * token-missing semantics. A broken stored value fails loudly instead of
 * falling back or masquerading as unconfigured.
 */

const configDir = "/tmp/uaw-glm-config";

function sourceFor(
  configuration: Parameters<typeof createGlmEndpointContext>[0],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const context = createGlmEndpointContext(configuration);
  assert.equal("environmentSource" in context, true);
  assert.equal(context.authenticationMode, "api-key-static");
  const endpoint =
    typeof context.environmentSource === "function"
      ? context.environmentSource({ profile: undefined })
      : context.environmentSource;
  return createEndpointProcessEnvironment(environment, endpoint);
}

test("a stored key rides the environment record and wins over the env variable", () => {
  const environment = sourceFor(
    {
      configDir,
      resolveAuthToken: () => "test-secret-store",
    },
    { GLM_ANTHROPIC_AUTH_TOKEN: "test-secret-env" },
  );
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "test-secret-store");
  assert.equal(
    environment.ANTHROPIC_BASE_URL,
    GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  );
  assert.equal(environment.CLAUDE_CONFIG_DIR, configDir);
});

test("with no stored key the environment variable is read exactly as before", () => {
  const environment = sourceFor(
    { configDir, resolveAuthToken: () => undefined },
    { GLM_ANTHROPIC_AUTH_TOKEN: "test-secret-env" },
  );
  assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "test-secret-env");
});

test("with neither source the session environment build fails token-missing", () => {
  assert.throws(
    () =>
      sourceFor({ configDir, resolveAuthToken: () => undefined }, {}),
    (error: unknown) =>
      error instanceof ClaudeEndpointEnvironmentError &&
      error.reason === "token-missing",
  );
});

test("a malformed stored value fails loudly instead of falling back", () => {
  for (const broken of ["", "  ", "a\0b"]) {
    assert.throws(
      () =>
        sourceFor(
          { configDir, resolveAuthToken: () => broken },
          { GLM_ANTHROPIC_AUTH_TOKEN: "test-secret-env" },
        ),
      (error: unknown) =>
        error instanceof ClaudeEndpointEnvironmentError &&
        error.reason === "token-malformed",
    );
  }
});

test("the resolver is invoked per spawn, so a later save applies without rebuilding", () => {
  let stored: string | undefined = undefined;
  assert.throws(
    () => sourceFor({ configDir, resolveAuthToken: () => stored }, {}),
    (error: unknown) =>
      error instanceof ClaudeEndpointEnvironmentError &&
      error.reason === "token-missing",
  );
  stored = "test-secret-later";
  const second = sourceFor({ configDir, resolveAuthToken: () => stored }, {});
  assert.equal(second.ANTHROPIC_AUTH_TOKEN, "test-secret-later");
});
