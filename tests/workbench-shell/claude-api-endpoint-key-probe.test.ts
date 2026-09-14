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
  createWorkbenchClaudeApiEndpointKeySource,
  CLAUDE_API_ENDPOINT_ENV_CONTRACT,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
} from "../../src/workbench-shell/claude-api-endpoint-key.ts";

/**
 * w245: the Claude · API card's "Test connection" probe must honor the saved
 * Base URL override (main.ts's `baseUrlOverrides["claude-api"]` mirror, same
 * w232-generalized per-endpoint record codex-api uses), the same precedence
 * `prepareEndpoint()` uses -- otherwise a user pointed at their own gateway
 * would still get probed against the official Anthropic default. This
 * reproduces main.ts's exact `probeBaseUrl` resolver in isolation (no
 * Electron), mirroring codex-api-endpoint-key-probe.test.ts; every network
 * path is a fake fetch, no real network call.
 */

const workspaceDirectories: string[] = [];

after(() => {
  for (const directory of workspaceDirectories.splice(0)) {
    nodeFs.rmSync(directory, { recursive: true, force: true });
  }
});

function createFakeSafeStorage(): SafeStorageLike {
  const key = createHash("sha256").update("uaw-fake-claude-api-probe").digest();
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

function createStore(): EndpointSecretEnvelopeStore {
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "uaw-claude-api-probe-"),
  );
  workspaceDirectories.push(directory);
  return new EndpointSecretEnvelopeStore({
    subject: CLAUDE_API_ENDPOINT_KEY_SUBJECT,
    safeStorage: createFakeSafeStorage(),
    storePath: endpointSecretEnvelopeStorePath(directory),
  });
}

test("Test connection probes the saved base URL override, and falls back to the env var then the contract default", async () => {
  let override = "";
  const seen: string[] = [];
  const fetchStub = ((input: string | URL | Request) => {
    seen.push(String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  const source = createWorkbenchClaudeApiEndpointKeySource({
    store: createStore(),
    environment: { CLAUDE_API_BASE_URL: "https://env-configured.example.com" },
    fetch: fetchStub,
    // The exact resolver main.ts wires (mirrored here in isolation).
    probeBaseUrl: (environment) =>
      override.trim().length > 0
        ? override
        : environment[CLAUDE_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]?.trim() ||
          CLAUDE_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  });
  source.save("test-secret-claude-api");

  // No override saved yet: the env var wins over the contract default.
  await source.probe();
  assert.equal(seen[0], "https://env-configured.example.com/v1/models");

  // A base URL save lands (simulating the claude-api-base-url IPC handler
  // updating main.ts's cache): the override now wins over the env var.
  override = "http://127.0.0.1:4180";
  await source.probe();
  assert.equal(seen[1], "http://127.0.0.1:4180/v1/models");

  // Clearing the override (the escape hatch) falls back to the env var again.
  override = "";
  await source.probe();
  assert.equal(seen[2], "https://env-configured.example.com/v1/models");
});

test("with no override and no env var, the probe falls back to the contract default", async () => {
  const seen: string[] = [];
  const source = createWorkbenchClaudeApiEndpointKeySource({
    store: createStore(),
    environment: {},
    fetch: ((input: string | URL | Request) => {
      seen.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    probeBaseUrl: (environment) =>
      environment[CLAUDE_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]?.trim() ||
      CLAUDE_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
  });
  source.save("test-secret-claude-api");
  await source.probe();
  assert.equal(seen[0], `${CLAUDE_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl}/v1/models`);
});
