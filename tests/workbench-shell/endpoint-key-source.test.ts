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
  createWorkbenchEndpointKeySource,
  endpointSecretEnvelopeStorePath,
} from "../../src/workbench-shell/endpoint-key-source.ts";
import { probeEndpoint } from "../../src/workbench-shell/endpoint-probe.ts";
import {
  KIMI_ENDPOINT_KEY_NAME,
  KIMI_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/claude/kimi-endpoint-key.ts";
import {
  DEEPSEEK_ENDPOINT_KEY_NAME,
  DEEPSEEK_ENDPOINT_KEY_SUBJECT,
} from "../../src/agent-runtime/claude/deepseek-endpoint-key.ts";
import {
  createWorkbenchKimiEndpointKeySource,
  probeKimiEndpoint,
} from "../../src/workbench-shell/kimi-endpoint-key.ts";
import {
  createWorkbenchDeepseekEndpointKeySource,
  probeDeepseekEndpoint,
} from "../../src/workbench-shell/deepseek-endpoint-key.ts";

/**
 * Source-level behaviour for the parameterized endpoint-key surface (WO16
 * Part 1/2): one shared factory serving GLM, Kimi and DeepSeek. All
 * credential material is an explicit fake of the form `test-secret-<n>`;
 * every network path is a fake fetch; no test touches the network,
 * Electron, or a real provider.

 * The multi-subject store contract is exercised for real: three store
 * instances (one subject each) share ONE store file, exactly like the
 * production main-process wiring.
 */

let fakeStorageSeed = 0;

function createFakeSafeStorage(): SafeStorageLike {
  const key = createHash("sha256")
    .update(`uaw-fake-backend-key-${(fakeStorageSeed += 1)}`)
    .digest();
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

const workspaceDirectories: string[] = [];

after(() => {
  for (const directory of workspaceDirectories.splice(0)) {
    nodeFs.rmSync(directory, { recursive: true, force: true });
  }
});

type Subject =
  | "glm"
  | "kimi"
  | "deepseek";

const SUBJECTS: Readonly<
  Record<Subject, { subject: string; keyName: string; tokenEnvVar: string }>
> = Object.freeze({
  glm: {
    subject: "workbench://runtime-endpoint/glm-coding-plan",
    keyName: "glm-coding-plan",
    tokenEnvVar: "GLM_ANTHROPIC_AUTH_TOKEN",
  },
  kimi: {
    subject: KIMI_ENDPOINT_KEY_SUBJECT,
    keyName: KIMI_ENDPOINT_KEY_NAME,
    tokenEnvVar: "KIMI_CODE_ANTHROPIC_AUTH_TOKEN",
  },
  deepseek: {
    subject: DEEPSEEK_ENDPOINT_KEY_SUBJECT,
    keyName: DEEPSEEK_ENDPOINT_KEY_NAME,
    tokenEnvVar: "DEEPSEEK_ANTHROPIC_AUTH_TOKEN",
  },
});

function createSharedStoreFile(): string {
  const directory = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), "uaw-endpoint-key-"),
  );
  workspaceDirectories.push(directory);
  return endpointSecretEnvelopeStorePath(directory);
}

function createStore(storePath: string, subject: string) {
  return new EndpointSecretEnvelopeStore({
    subject,
    safeStorage: createFakeSafeStorage(),
    storePath,
  });
}

test("identity constants match the ticket-11/12 designs of record", () => {
  assert.equal(KIMI_ENDPOINT_KEY_SUBJECT, "workbench://runtime-endpoint/kimi-code");
  assert.equal(KIMI_ENDPOINT_KEY_NAME, "kimi-code");
  assert.equal(
    DEEPSEEK_ENDPOINT_KEY_SUBJECT,
    "workbench://runtime-endpoint/deepseek-api",
  );
  assert.equal(DEEPSEEK_ENDPOINT_KEY_NAME, "deepseek-api");
  // No "plan" wording anywhere in the DeepSeek identity (ticket 12 ruling).
  assert.ok(!/plan/iu.test(DEEPSEEK_ENDPOINT_KEY_NAME));
});

test("three subjects coexist in one store file: saves, reveals and removals never cross", () => {
  const storePath = createSharedStoreFile();
  const kimi = createWorkbenchKimiEndpointKeySource({
    store: createStore(storePath, SUBJECTS.kimi.subject),
    environment: {},
  });
  const deepseek = createWorkbenchDeepseekEndpointKeySource({
    store: createStore(storePath, SUBJECTS.deepseek.subject),
    environment: {},
  });

  kimi.save("test-secret-kimi");
  deepseek.save("test-secret-deepseek");

  // Each source reveals its own key through its own subject-bound store.
  assert.equal(kimi.reveal(), "test-secret-kimi");
  assert.equal(deepseek.reveal(), "test-secret-deepseek");
  // One store file on disk — not one per endpoint.
  assert.equal(
    nodeFs.readdirSync(nodePath.dirname(storePath)).length,
    1,
  );
  // Removing one endpoint's key leaves the other's intact.
  assert.equal(kimi.remove(), true);
  assert.equal(kimi.reveal(), undefined);
  assert.equal(deepseek.reveal(), "test-secret-deepseek");
});

test("kimi resolution prefers the store and falls back to KIMI_CODE_ANTHROPIC_AUTH_TOKEN", () => {
  const source = createWorkbenchKimiEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.kimi.subject),
    environment: { KIMI_CODE_ANTHROPIC_AUTH_TOKEN: "test-secret-kimi-env" },
  });
  assert.equal(source.resolve(), "test-secret-kimi-env");
  source.save("test-secret-kimi-store");
  assert.equal(source.resolve(), "test-secret-kimi-store");
  source.remove();
  assert.equal(source.resolve(), "test-secret-kimi-env");
  assert.equal(source.status().environmentFallback, true);
});

test("deepseek resolution prefers the store and falls back to DEEPSEEK_ANTHROPIC_AUTH_TOKEN", () => {
  const source = createWorkbenchDeepseekEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.deepseek.subject),
    environment: { DEEPSEEK_ANTHROPIC_AUTH_TOKEN: "test-secret-deepseek-env" },
  });
  assert.equal(source.resolve(), "test-secret-deepseek-env");
  source.save("test-secret-deepseek-store");
  assert.equal(source.resolve(), "test-secret-deepseek-store");
});

test("a foreign subject cannot read another endpoint's key name (owner mismatch stays loud)", () => {
  const storePath = createSharedStoreFile();
  const kimi = createWorkbenchKimiEndpointKeySource({
    store: createStore(storePath, SUBJECTS.kimi.subject),
    environment: {},
  });
  kimi.save("test-secret-kimi");
  // A deepseek-subject store instance reading the kimi key name must throw
  // (SecretEnvelopeOwnerMismatchError), never return the value.
  const deepseekView = createStore(storePath, SUBJECTS.deepseek.subject);
  assert.throws(() => deepseekView.reveal(SUBJECTS.kimi.keyName));
});

type SeenRequest = {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
};

function recordingFetch(handler: () => Response): {
  seen: SeenRequest[];
  fetch: typeof fetch;
} {
  const seen: SeenRequest[] = [];
  const fake: typeof fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return Promise.resolve(handler());
  }) as typeof fetch;
  return { seen, fetch: fake };
}

test("kimi probe is Bearer-only on the anthropic messages face with the universal model", async () => {
  const { seen, fetch } = recordingFetch(
    () => new Response("{}", { status: 200 }),
  );
  const source = createWorkbenchKimiEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.kimi.subject),
    environment: {},
    fetch,
  });
  source.save("test-secret-kimi");
  assert.deepEqual(await source.probe(), { outcome: "success" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://api.kimi.com/coding/v1/messages");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer test-secret-kimi");
  assert.equal(seen[0]!.headers.get("x-api-key"), null);
  assert.deepEqual(JSON.parse(seen[0]!.body!), {
    model: "kimi-for-coding",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  });
});

test("deepseek probe is the zero-inference platform models list, never a messages post", async () => {
  const { seen, fetch } = recordingFetch(
    () => new Response("{}", { status: 200 }),
  );
  const source = createWorkbenchDeepseekEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.deepseek.subject),
    environment: {},
    fetch,
  });
  source.save("test-secret-deepseek");
  assert.deepEqual(await source.probe(), { outcome: "success" });
  assert.equal(seen.length, 1);
  // The anthropic-face base URL (".../anthropic") is stripped to the
  // platform face for the models list.
  assert.equal(seen[0]!.url, "https://api.deepseek.com/models");
  assert.equal(seen[0]!.method, "GET");
  assert.equal(
    seen[0]!.headers.get("authorization"),
    "Bearer test-secret-deepseek",
  );
  assert.equal(seen[0]!.body, undefined);
});

test("deepseek probe honors an env base override with the same /anthropic strip", async () => {
  const { seen, fetch } = recordingFetch(
    () => new Response("{}", { status: 200 }),
  );
  const source = createWorkbenchDeepseekEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.deepseek.subject),
    environment: {
      DEEPSEEK_ANTHROPIC_AUTH_TOKEN: "test-secret-deepseek-env",
      DEEPSEEK_ANTHROPIC_BASE_URL: "https://proxy.example.com/anthropic",
    },
    fetch,
  });
  assert.deepEqual(await source.probe(), { outcome: "success" });
  assert.equal(seen[0]!.url, "https://proxy.example.com/models");
});

test("probeEndpoint maps HTTP statuses to the coarse reason enum without leaking bodies", async () => {
  const cases: Readonly<
    Record<number, "unauthorized" | "server-error" | "endpoint-error">
  > = Object.freeze({
    401: "unauthorized",
    403: "unauthorized",
    500: "server-error",
    404: "endpoint-error",
  });
  for (const [status, reason] of Object.entries(cases)) {
    const outcome = await probeEndpoint({
      baseUrl: "https://endpoint.example.com",
      authToken: "test-secret-x",
      shape: { kind: "openai-models-list" },
      fetch: (() =>
        Promise.resolve(
          new Response("exploded internals", {
            status: Number(status),
          }),
        )) as typeof fetch,
    });
    assert.deepEqual(outcome, { outcome: "failure", reason });
  }
});

test("probeEndpoint rejects an invalid base URL before any fetch", async () => {
  let calls = 0;
  const outcome = await probeEndpoint({
    baseUrl: "http://not-localhost.example.com",
    authToken: "test-secret-x",
    shape: { kind: "openai-models-list" },
    fetch: (() => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  });
  assert.deepEqual(outcome, { outcome: "failure", reason: "invalid-base-url" });
  assert.equal(calls, 0);
});

test("kimi and deepseek probes without any key report token-missing without fetching", async () => {
  let calls = 0;
  const counting = (() => {
    calls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  const kimi = createWorkbenchKimiEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.kimi.subject),
    environment: {},
    fetch: counting,
  });
  const deepseek = createWorkbenchDeepseekEndpointKeySource({
    store: createStore(createSharedStoreFile(), SUBJECTS.deepseek.subject),
    environment: {},
    fetch: counting,
  });
  assert.deepEqual(await kimi.probe(), {
    outcome: "failure",
    reason: "token-missing",
  });
  assert.deepEqual(await deepseek.probe(), {
    outcome: "failure",
    reason: "token-missing",
  });
  assert.equal(calls, 0);
});

test("probe wrappers stay injectable: probeKimiEndpoint and probeDeepseekEndpoint work through a fake fetch", async () => {
  const kimiSeen: string[] = [];
  await probeKimiEndpoint({
    baseUrl: "https://api.kimi.com/coding/",
    authToken: "test-secret-kimi",
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      kimiSeen.push(String(input), new Headers(init?.headers).get("authorization") ?? "");
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  });
  assert.equal(kimiSeen[0], "https://api.kimi.com/coding/v1/messages");
  assert.equal(kimiSeen[1], "Bearer test-secret-kimi");

  const deepseekSeen: string[] = [];
  await probeDeepseekEndpoint({
    baseUrl: "https://api.deepseek.com",
    authToken: "test-secret-deepseek",
    fetch: ((input: string | URL | Request) => {
      deepseekSeen.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  });
  assert.deepEqual(deepseekSeen, ["https://api.deepseek.com/models"]);
});

test("the generic factory rejects an invalid key value loudly for every provider", () => {
  for (const provider of [
    createWorkbenchKimiEndpointKeySource({
      store: createStore(createSharedStoreFile(), SUBJECTS.kimi.subject),
      environment: {},
    }),
    createWorkbenchDeepseekEndpointKeySource({
      store: createStore(createSharedStoreFile(), SUBJECTS.deepseek.subject),
      environment: {},
    }),
    createWorkbenchEndpointKeySource({
      store: createStore(createSharedStoreFile(), SUBJECTS.glm.subject),
      keyName: SUBJECTS.glm.keyName,
      envContract: {
        authTokenEnvVar: SUBJECTS.glm.tokenEnvVar,
        baseUrlEnvVar: "GLM_ANTHROPIC_BASE_URL",
        defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
      },
      probeRequest: () => Promise.resolve({ outcome: "success" }),
      environment: {},
    }),
  ]) {
    assert.throws(() => provider.save("line1\nline2"), /invalid endpoint key value/u);
  }
});
