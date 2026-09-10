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
import {
  createWorkbenchGlmEndpointKeySource,
  endpointSecretEnvelopeStorePath,
  GLM_ENDPOINT_KEY_NAME,
  GLM_ENDPOINT_KEY_SUBJECT,
  GLM_ENDPOINT_SECRET_STORE_FILE_NAME,
  maskEndpointSecretHint,
} from "../../src/workbench-shell/glm-endpoint-key.ts";

/**
 * Source-level behaviour for the GLM endpoint key (work order 07). All
 * credential material is an explicit fake of the form `test-secret-<n>`; the
 * platform backend is a deterministic in-process fake; no test touches the
 * network or Electron.
 */

let fakeStorageSeed = 0;

function createFakeSafeStorage(
  options: { available?: boolean } = {},
): SafeStorageLike {
  const key = createHash("sha256")
    .update(`uaw-fake-backend-key-${(fakeStorageSeed += 1)}`)
    .digest();
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString(plainText: string): Uint8Array {
      const bytes = Buffer.from(plainText, "utf8");
      const tag = createHash("sha256")
        .update(bytes)
        .update(key)
        .digest()
        .subarray(0, 16);
      const stream = Buffer.allocUnsafe(bytes.length);
      for (let index = 0; index < bytes.length; index += 1) {
        stream[index] = bytes[index] ^ key[index % key.length];
      }
      return Buffer.concat([tag, stream]);
    },
    decryptString(encrypted: Uint8Array): string {
      const data = Buffer.from(encrypted);
      const tag = data.subarray(0, 16);
      const stream = data.subarray(16);
      const plain = Buffer.allocUnsafe(stream.length);
      for (let index = 0; index < stream.length; index += 1) {
        plain[index] = stream[index] ^ key[index % key.length];
      }
      const expected = createHash("sha256")
        .update(plain)
        .update(key)
        .digest()
        .subarray(0, 16);
      if (!tag.equals(expected)) {
        throw new Error("fake decryption failed: integrity tag mismatch");
      }
      return plain.toString("utf8");
    },
  };
}

type FetchLike = typeof fetch;

const workspaceDirectories: string[] = [];

after(() => {
  for (const directory of workspaceDirectories.splice(0)) {
    nodeFs.rmSync(directory, { recursive: true, force: true });
  }
});

function createStoreInTemp(options: { available?: boolean } = {}) {
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "uaw-glm-key-"),
  );
  workspaceDirectories.push(directory);
  return new EndpointSecretEnvelopeStore({
    subject: GLM_ENDPOINT_KEY_SUBJECT,
    safeStorage: createFakeSafeStorage(options),
    storePath: nodePath.join(
      directory,
      GLM_ENDPOINT_SECRET_STORE_FILE_NAME,
    ),
  });
}

function createSource(options: {
  store?: EndpointSecretEnvelopeStore;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
} = {}) {
  return createWorkbenchGlmEndpointKeySource({
    store: options.store ?? createStoreInTemp(),
    environment: options.environment ?? {},
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

test("production constants match the deputy-supervisor ruling", () => {
  assert.equal(GLM_ENDPOINT_KEY_SUBJECT, "workbench://runtime-endpoint/glm-coding-plan");
  assert.equal(GLM_ENDPOINT_KEY_NAME, "glm-coding-plan");
  assert.equal(
    GLM_ENDPOINT_SECRET_STORE_FILE_NAME,
    "endpoint-secret-envelope-store.json",
  );
  assert.equal(
    endpointSecretEnvelopeStorePath("%APPDATA%\\synchronized-intellect-network"),
    "%APPDATA%\\synchronized-intellect-network\\endpoint-secret-envelope-store.json",
  );
});

test("a fresh installation reports unconfigured with no hint and no env fallback", () => {
  const source = createSource();
  assert.deepEqual(source.status(), {
    configured: false,
    maskedHint: null,
    isPersistent: true,
    environmentFallback: false,
  });
});

test("save/reveal round trip keeps the exact value and reports the masked hint", () => {
  const source = createSource();
  const snapshot = source.save("test-secret-1234");
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.maskedHint, "••••1234");
  assert.equal(snapshot.isPersistent, true);
  assert.equal(source.reveal(), "test-secret-1234");
});

test("status never carries the full key value, only the disclosed tail mask", () => {
  const source = createSource();
  source.save("test-secret-5678");
  const serialized = JSON.stringify(source.status());
  assert.ok(!serialized.includes("test-secret-5678"));
  assert.ok(serialized.includes("••••5678"));
});

test("remove clears the stored key and reports not-configured afterwards", () => {
  const source = createSource();
  assert.equal(source.remove(), false);
  source.save("test-secret-1");
  assert.equal(source.remove(), true);
  assert.equal(source.reveal(), undefined);
  assert.equal(source.status().configured, false);
});

test("key source resolution prefers the store and falls back to the environment", () => {
  const environment = { GLM_ANTHROPIC_AUTH_TOKEN: "test-secret-env" };
  const source = createSource({ environment });
  assert.equal(source.resolve(), "test-secret-env");
  source.save("test-secret-store");
  assert.equal(source.resolve(), "test-secret-store");
  source.remove();
  assert.equal(source.resolve(), "test-secret-env");
});

test("degraded (in-memory) mode reports isPersistent: false without writing plaintext", () => {
  const warnings: string[] = [];
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "uaw-glm-key-volatile-"),
  );
  workspaceDirectories.push(directory);
  const storePath = nodePath.join(directory, GLM_ENDPOINT_SECRET_STORE_FILE_NAME);
  const store = new EndpointSecretEnvelopeStore({
    subject: GLM_ENDPOINT_KEY_SUBJECT,
    safeStorage: createFakeSafeStorage({ available: false }),
    storePath,
    warn: (message) => warnings.push(message),
  });
  const source = createWorkbenchGlmEndpointKeySource({ store, environment: {} });
  const snapshot = source.save("test-secret-2");
  assert.equal(snapshot.isPersistent, false);
  assert.equal(snapshot.configured, true);
  assert.equal(source.reveal(), "test-secret-2");
  assert.equal(nodeFs.existsSync(storePath), false);
  assert.equal(warnings.length, 1);
});

test("a configured-but-broken entry throws instead of reading as unconfigured", () => {
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "uaw-glm-key-broken-"),
  );
  workspaceDirectories.push(directory);
  const store = new EndpointSecretEnvelopeStore({
    subject: GLM_ENDPOINT_KEY_SUBJECT,
    safeStorage: createFakeSafeStorage(),
    storePath: nodePath.join(directory, GLM_ENDPOINT_SECRET_STORE_FILE_NAME),
  });
  store.upsert(GLM_ENDPOINT_KEY_NAME, "test-secret-3");
  // Corrupt the backend: the same store file now fails to decrypt.
  const brokenStore = new EndpointSecretEnvelopeStore({
    subject: GLM_ENDPOINT_KEY_SUBJECT,
    safeStorage: createFakeSafeStorage(),
    storePath: nodePath.join(directory, GLM_ENDPOINT_SECRET_STORE_FILE_NAME),
  });
  const source = createWorkbenchGlmEndpointKeySource({
    store: brokenStore,
    environment: {},
  });
  assert.throws(() => source.reveal());
  assert.throws(() => source.resolve());
  assert.throws(() => source.status());
});

test("save rejects invalid values loudly and writes nothing", () => {
  const source = createSource();
  for (const invalid of [
    "",
    "   ",
    "line1\nline2",
    "a\0b",
    "  padded  ",
    "x".repeat(4097),
    undefined as unknown as string,
    42 as unknown as string,
  ]) {
    assert.throws(() => source.save(invalid), /invalid endpoint key value/u);
  }
  assert.equal(source.status().configured, false);
});

test("probe reports token-missing when neither store nor environment has a key", async () => {
  const { calls, fetch } = networkCountingFetch(() => new Response("{}", { status: 200 }));
  const source = createSource({ fetch });
  assert.deepEqual(await source.probe(), {
    outcome: "failure",
    reason: "token-missing",
  });
  assert.equal(calls, 0);
});

test("probe uses the resolved key and the contract base URL", async () => {
  const seen: { url: string; key: string | null }[] = [];
  const fetch = ((input: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      key: new Headers(init?.headers).get("x-api-key"),
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as FetchLike;
  const environment = {
    GLM_ANTHROPIC_AUTH_TOKEN: "test-secret-env",
    GLM_ANTHROPIC_BASE_URL: "https://endpoint.example.com/api",
  };
  const source = createSource({ environment, fetch });
  assert.deepEqual(await source.probe(), { outcome: "success" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://endpoint.example.com/api/v1/messages");
  assert.equal(seen[0]!.key, "test-secret-env");
  source.save("test-secret-store");
  seen.length = 0;
  await source.probe();
  assert.equal(seen[0]!.key, "test-secret-store");
});

test("maskEndpointSecretHint exposes at most the last four characters", () => {
  assert.equal(maskEndpointSecretHint("test-secret-abcd"), "••••abcd");
  assert.equal(maskEndpointSecretHint("abc"), "••••abc");
  assert.equal(maskEndpointSecretHint("a"), "••••a");
  assert.throws(() => maskEndpointSecretHint(""));
});

function networkCountingFetch(
  handler: () => Response,
): { calls: number; fetch: FetchLike } {
  let calls = 0;
  const fetch = (() => {
    calls += 1;
    return Promise.resolve(handler());
  }) as FetchLike;
  return { calls, fetch };
}
