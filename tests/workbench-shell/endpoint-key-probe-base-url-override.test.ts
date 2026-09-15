import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, test } from "node:test";

import {
  EndpointSecretEnvelopeStore,
  type SafeStorageLike,
} from "../../src/workbench-shell/endpoint-secret-envelope-store.ts";
import { endpointSecretEnvelopeStorePath } from "../../src/workbench-shell/endpoint-key-source.ts";
import {
  createWorkbenchGlmEndpointKeySource,
  GLM_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/glm-endpoint-key.ts";
import {
  createWorkbenchKimiEndpointKeySource,
  KIMI_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/kimi-endpoint-key.ts";
import {
  createWorkbenchDeepseekEndpointKeySource,
  DEEPSEEK_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/deepseek-endpoint-key.ts";
import {
  createWorkbenchKimiPlatformKeySource,
  KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/kimi-platform-key.ts";
import {
  createWorkbenchClaudeApiEndpointKeySource,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/claude-api-endpoint-key.ts";
import {
  createWorkbenchCodexApiEndpointKeySource,
  CODEX_API_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/codex-api-endpoint-key.ts";
import { GLM_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/claude/endpoint-env-factory.ts";
import { KIMI_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/claude/kimi-catalog.ts";
import { DEEPSEEK_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/claude/deepseek-catalog.ts";
import { KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import { CODEX_API_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import { CLAUDE_API_ENDPOINT_ENV_CONTRACT } from "../../src/agent-runtime/claude/claude-api-endpoint.ts";

/**
 * w309: "Check connection" must resolve its target from the same source the
 * sessions use -- the saved per-endpoint Base URL override (main.ts's
 * `baseUrlOverrides` mirror) first, then the env contract's override variable,
 * then the contract default. Before this lane, GLM / Kimi Code / DeepSeek
 * probes ignored the saved override entirely and hit the official default
 * with the user's key (w302: a dead `http://127.0.0.1:9` override still
 * reported "unauthorized" -- the probe had gone to the official endpoint).
 *
 * The test drives each endpoint's real key-source factory the way main.ts
 * wires it (lazy override getter over an in-memory mirror); every network
 * path is a fake fetch, no real network call.
 */

const workspaceDirectories: string[] = [];

after(() => {
  for (const directory of workspaceDirectories.splice(0)) {
    nodeFs.rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeSafeStorage(salt: string): SafeStorageLike {
  const key = createHash("sha256").update(salt).digest();
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

function createStore(
  subject: string,
  salt: string,
): EndpointSecretEnvelopeStore {
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "uaw-w309-probe-"),
  );
  workspaceDirectories.push(directory);
  return new EndpointSecretEnvelopeStore({
    subject,
    safeStorage: createFakeSafeStorage(salt),
    storePath: endpointSecretEnvelopeStorePath(directory),
  });
}

function recordingFetch(seen: string[]): typeof fetch {
  return ((input: string | URL | Request) => {
    seen.push(String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
}

test("glm-coding-plan: the probe requests the saved base URL override before the env var", async () => {
  let override = "";
  const seen: string[] = [];
  const source = createWorkbenchGlmEndpointKeySource({
    store: createStore(
      GLM_ENDPOINT_KEY_SUBJECT,
      "uaw-w309-glm-override-probe",
    ),
    environment: {
      [GLM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com",
    },
    fetch: recordingFetch(seen),
    // How main.ts wires it: a lazy read of the in-memory mirror, resolved
    // at probe time (the mirror does not exist yet at construction).
    resolveBaseUrlOverride: () => override,
  });
  source.save("test-secret-glm");

  override = "http://127.0.0.1:4180";
  await source.probe();
  assert.equal(seen[0], "http://127.0.0.1:4180/v1/messages");

  // Clearing the override falls back to the env var.
  override = "";
  await source.probe();
  assert.equal(seen[1], "https://env-fallback.example.com/v1/messages");
});

test("kimi-code: the probe requests the saved base URL override before the env var", async () => {
  let override = "";
  const seen: string[] = [];
  const source = createWorkbenchKimiEndpointKeySource({
    store: createStore(KIMI_ENDPOINT_KEY_SUBJECT, "uaw-w309-kimi-override-probe"),
    environment: {
      [KIMI_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com",
    },
    fetch: recordingFetch(seen),
    resolveBaseUrlOverride: () => override,
  });
  source.save("test-secret-kimi");

  override = "http://127.0.0.1:4181";
  await source.probe();
  assert.equal(seen[0], "http://127.0.0.1:4181/v1/messages");

  override = "";
  await source.probe();
  assert.equal(seen[1], "https://env-fallback.example.com/v1/messages");
});

test("deepseek-api: the probe requests the saved base URL override (platform face, /anthropic stripped)", async () => {
  let override = "";
  const seen: string[] = [];
  const source = createWorkbenchDeepseekEndpointKeySource({
    store: createStore(
      DEEPSEEK_ENDPOINT_KEY_SUBJECT,
      "uaw-w309-deepseek-override-probe",
    ),
    environment: {
      [DEEPSEEK_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com/anthropic",
    },
    fetch: recordingFetch(seen),
    resolveBaseUrlOverride: () => override,
  });
  source.save("test-secret-deepseek");

  // The override is the Anthropic-face base URL the user saved; the probe
  // lives on the platform face, so the same deterministic strip applies.
  override = "http://127.0.0.1:4182/anthropic";
  await source.probe();
  assert.equal(seen[0], "http://127.0.0.1:4182/models");

  override = "";
  await source.probe();
  assert.equal(seen[1], "https://env-fallback.example.com/models");
});

test("kimi-platform: the probe resolves the env var then the contract default (no saved override exists for this endpoint)", async () => {
  const seen: string[] = [];
  const source = createWorkbenchKimiPlatformKeySource({
    store: createStore(
      KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
      "uaw-w309-kimi-platform-probe",
    ),
    environment: {
      [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com/v1",
    },
    fetch: recordingFetch(seen),
  });
  source.save("test-secret-kimi-platform");

  await source.probe();
  assert.equal(seen[0], "https://env-fallback.example.com/v1/models");
});

test("claude-api: the probe requests the saved base URL override before the env var", async () => {
  let override = "";
  const seen: string[] = [];
  const source = createWorkbenchClaudeApiEndpointKeySource({
    store: createStore(
      CLAUDE_API_ENDPOINT_KEY_SUBJECT,
      "uaw-w309-claude-api-override-probe",
    ),
    environment: {
      [CLAUDE_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com",
    },
    fetch: recordingFetch(seen),
    resolveBaseUrlOverride: () => override,
  });
  source.save("test-secret-claude-api");

  override = "http://127.0.0.1:4183";
  await source.probe();
  assert.equal(seen[0], "http://127.0.0.1:4183/v1/models");

  override = "";
  await source.probe();
  assert.equal(seen[1], "https://env-fallback.example.com/v1/models");
});

test("codex-api: the probe requests the saved base URL override before the env var", async () => {
  let override = "";
  const seen: string[] = [];
  const source = createWorkbenchCodexApiEndpointKeySource({
    store: createStore(
      CODEX_API_ENDPOINT_KEY_SUBJECT,
      "uaw-w309-codex-api-override-probe",
    ),
    environment: {
      [CODEX_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com/v1",
    },
    fetch: recordingFetch(seen),
    resolveBaseUrlOverride: () => override,
  });
  source.save("test-secret-codex-api");

  override = "http://127.0.0.1:4184/v1";
  await source.probe();
  assert.equal(seen[0], "http://127.0.0.1:4184/v1/models");

  override = "";
  await source.probe();
  assert.equal(seen[1], "https://env-fallback.example.com/v1/models");
});

test("with no override and no env var, the probe falls back to the contract default", async () => {
  const seen: string[] = [];
  const source = createWorkbenchGlmEndpointKeySource({
    store: createStore(GLM_ENDPOINT_KEY_SUBJECT, "uaw-w309-glm-default-probe"),
    environment: {},
    fetch: recordingFetch(seen),
    resolveBaseUrlOverride: () => "",
  });
  source.save("test-secret-glm");
  await source.probe();
  assert.equal(
    seen[0],
    `${GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl}/v1/messages`,
  );
});

test("a saved but invalid override fails the probe as invalid-base-url instead of silently probing the default", async () => {
  const seen: string[] = [];
  const source = createWorkbenchGlmEndpointKeySource({
    store: createStore(
      GLM_ENDPOINT_KEY_SUBJECT,
      "uaw-w309-glm-invalid-override-probe",
    ),
    environment: {
      [GLM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]:
        "https://env-fallback.example.com",
    },
    fetch: recordingFetch(seen),
    resolveBaseUrlOverride: () => "not a url",
  });
  source.save("test-secret-glm");
  const outcome = await source.probe();
  assert.deepEqual(outcome, { outcome: "failure", reason: "invalid-base-url" });
  // Nothing was probed at all -- in particular not the env/default URL.
  assert.deepEqual(seen, []);
});
