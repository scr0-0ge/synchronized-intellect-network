import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_ENDPOINT_CLEANSE_ENVIRONMENT_KEYS,
  CodexEndpointEnvironmentError,
  KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT,
  createCodexEndpointProcessEnvironment,
  resolveCodexEndpointProcessEnvironment,
} from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";

const FAKE_KEY = "FAKE-KIMI-PLATFORM-KEY-1234";
const ISOLATED_HOME = "C:\\appdata\\synchronized-intellect-network\\kimi-platform-codex-home";

const HOSTILE_SOURCE: NodeJS.ProcessEnv = Object.freeze({
  PATH: "C:\\windows\\system32",
  OPENAI_API_KEY: "AMBIENT-OPENAI-KEY",
  CODEX_API_KEY: "AMBIENT-CODEX-KEY",
  AZURE_OPENAI_API_KEY: "AMBIENT-AZURE-KEY",
  OPENAI_BASE_URL: "https://ambient.openai.example.com/v1",
  CODEX_HOME: "C:\\users\\someone\\.codex",
  [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY,
});

test("the kimi-platform environment cleanses every ambient codex credential and any ambient CODEX_HOME, then injects", () => {
  const environment = createCodexEndpointProcessEnvironment(HOSTILE_SOURCE, {
    mode: "kimi-platform",
    codexHome: ISOLATED_HOME,
  });
  for (const key of CODEX_ENDPOINT_CLEANSE_ENVIRONMENT_KEYS) {
    if (key === "CODEX_HOME") continue;
    assert.equal(environment[key], undefined, key);
  }
  assert.equal(environment.CODEX_HOME, ISOLATED_HOME);
  assert.equal(environment[KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar], FAKE_KEY);
  // Non-credential ambient state survives the cleanse.
  assert.equal(environment.PATH, "C:\\windows\\system32");
});

test("a stored key wins over the environment fallback; the environment fallback works alone; neither source is a silent mask", () => {
  // Store value present: wins, even when the env var is absent.
  const storedOnly = createCodexEndpointProcessEnvironment(
    { PATH: "p" },
    { mode: "kimi-platform", apiKey: "STORED-KEY-1", codexHome: ISOLATED_HOME },
  );
  assert.equal(storedOnly[KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar], "STORED-KEY-1");
  // Both present: store wins.
  const both = createCodexEndpointProcessEnvironment(HOSTILE_SOURCE, {
    mode: "kimi-platform",
    apiKey: "STORED-KEY-2",
    codexHome: ISOLATED_HOME,
  });
  assert.equal(both[KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar], "STORED-KEY-2");
  // Env fallback alone.
  const envOnly = createCodexEndpointProcessEnvironment(HOSTILE_SOURCE, {
    mode: "kimi-platform",
    codexHome: ISOLATED_HOME,
  });
  assert.equal(envOnly[KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar], FAKE_KEY);
});

test("a missing key fails token-missing; an empty or NUL-bearing stored key fails token-malformed instead of falling back", () => {
  for (const source of [{}, { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: "   " }]) {
    let failure: unknown;
    try {
      createCodexEndpointProcessEnvironment(source, {
        mode: "kimi-platform",
        codexHome: ISOLATED_HOME,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CodexEndpointEnvironmentError);
    assert.equal(failure.reason, "token-missing");
  }
  for (const broken of ["", "  ", "nu\0ll"]) {
    let failure: unknown;
    try {
      createCodexEndpointProcessEnvironment(
        { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
        { mode: "kimi-platform", apiKey: broken, codexHome: ISOLATED_HOME },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CodexEndpointEnvironmentError);
    assert.equal(failure.reason, "token-malformed");
  }
});

test("a missing, empty, or NUL-bearing CODEX_HOME fails codex-home-invalid; bad descriptors fail loudly", () => {
  for (const broken of [undefined, "", "  ", "a\0b"]) {
    let failure: unknown;
    try {
      createCodexEndpointProcessEnvironment(
        { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
        { mode: "kimi-platform", ...(broken === undefined ? {} : { codexHome: broken }) },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CodexEndpointEnvironmentError);
    assert.equal(failure.reason, "codex-home-invalid");
  }
  for (const [label, source, descriptor] of [
    ["null source", null, { mode: "kimi-platform" }],
    [
      "unknown mode",
      {},
      { mode: "some-other-endpoint", codexHome: ISOLATED_HOME },
    ],
  ] as const) {
    let failure: unknown;
    try {
      createCodexEndpointProcessEnvironment(
        source as NodeJS.ProcessEnv,
        descriptor as never,
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof CodexEndpointEnvironmentError, label);
    assert.notEqual(failure.reason, "token-missing");
  }
});

test("the resolve wrapper maps token failures to authentication-required and everything else to invalid-input", () => {
  const resolver = () =>
    ({ mode: "kimi-platform", codexHome: ISOLATED_HOME }) as const;
  let failure: unknown;
  try {
    resolveCodexEndpointProcessEnvironment({}, resolver);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "authentication-required");

  const badHome = () => ({ mode: "kimi-platform" }) as const;
  try {
    resolveCodexEndpointProcessEnvironment(
      { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
      badHome,
    );
    assert.fail("expected a failure");
  } catch (error) {
    assert.ok(error instanceof RuntimeAdapterError);
    assert.equal(error.category, "invalid-input");
  }

  const healthy = resolveCodexEndpointProcessEnvironment(
    { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
    resolver,
  );
  assert.equal(Object.isFrozen(healthy), true);
  assert.equal(healthy.CODEX_HOME, ISOLATED_HOME);
});
