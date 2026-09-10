import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPSEEK_MODELS_LIST_URL,
  ENDPOINT_MODELS_LIST_FACES,
  ENDPOINT_MODELS_LIST_TIMEOUT_CEILING_MILLISECONDS,
  ENDPOINT_MODELS_LIST_TIMEOUT_MILLISECONDS,
  GLM_ANTHROPIC_MODELS_LIST_URL,
  GLM_OPENAI_MODELS_LIST_URL,
  KIMI_PLATFORM_CN_MODELS_LIST_URL,
  KIMI_PLATFORM_MODELS_LIST_URL,
  fetchEndpointModelsList,
  findNewEndpointModelIds,
  type EndpointModelsListFaceId,
} from "../../src/workbench-shell/endpoint-models-list.ts";

/**
 * The models-list module is fully network-free: every path drives an injected
 * fake fetch. No test here performs a real network call, and no key material
 * beyond throwaway fake tokens exists in this file. Real-key pulls belong to
 * the supervisor's live acceptance.
 */

type FetchLike = typeof fetch;

const AUTH_TOKEN = "test-secret-1";

function fakeFetch(
  handler: (
    input: string | URL,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
): { calls: { url: string; init: RequestInit | undefined }[]; fetch: typeof fetch } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = ((input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(input, init));
  }) as FetchLike;
  return { calls, fetch };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GLM_ANTHROPIC_BODY = JSON.stringify({
  data: [
    {
      id: "glm-5.3",
      display_name: "GLM 5.3",
      created_at: "2026-08-01T00:00:00Z",
      type: "model",
    },
    {
      id: "glm-5.3-flash",
      display_name: "GLM 5.3 Flash",
      created_at: "2026-08-02T00:00:00Z",
      type: "model",
    },
  ],
});

const OPENAI_COMPATIBLE_BODY = JSON.stringify({
  object: "list",
  data: [
    { id: "provider-model-a", object: "model", created: 1_700_000_000, owned_by: "provider" },
    { id: "provider-model-b", object: "model", created: 1_700_000_001, owned_by: "provider" },
  ],
});

test("each face sends one authenticated GET to its documented URL", async () => {
  const faces: readonly {
    face: EndpointModelsListFaceId;
    expectedUrl: string;
    body: string;
    expectedModels: readonly unknown[];
  }[] = [
    {
      face: "glm-anthropic",
      expectedUrl: GLM_ANTHROPIC_MODELS_LIST_URL,
      body: GLM_ANTHROPIC_BODY,
      expectedModels: [
        {
          id: "glm-5.3",
          displayName: "GLM 5.3",
          createdAt: "2026-08-01T00:00:00Z",
        },
        {
          id: "glm-5.3-flash",
          displayName: "GLM 5.3 Flash",
          createdAt: "2026-08-02T00:00:00Z",
        },
      ],
    },
    {
      face: "glm-openai",
      expectedUrl: GLM_OPENAI_MODELS_LIST_URL,
      body: OPENAI_COMPATIBLE_BODY,
      expectedModels: [{ id: "provider-model-a" }, { id: "provider-model-b" }],
    },
    {
      face: "kimi-platform",
      expectedUrl: KIMI_PLATFORM_MODELS_LIST_URL,
      body: OPENAI_COMPATIBLE_BODY,
      expectedModels: [{ id: "provider-model-a" }, { id: "provider-model-b" }],
    },
    {
      face: "deepseek",
      expectedUrl: DEEPSEEK_MODELS_LIST_URL,
      body: OPENAI_COMPATIBLE_BODY,
      expectedModels: [{ id: "provider-model-a" }, { id: "provider-model-b" }],
    },
  ];
  for (const { face, expectedUrl, body, expectedModels } of faces) {
    const { calls, fetch } = fakeFetch(() => jsonResponse(body));
    const outcome = await fetchEndpointModelsList({
      face,
      authToken: AUTH_TOKEN,
      fetch,
    });
    assert.deepEqual(outcome, { outcome: "success", models: expectedModels }, face);
    assert.equal(calls.length, 1, face);
    assert.equal(calls[0]!.url, expectedUrl, face);
    const init = calls[0]!.init!;
    assert.equal(init.method, "GET", face);
    assert.equal(init.redirect, "error", face);
    assert.ok(init.signal instanceof AbortSignal, face);
    const headers = new Headers(init.headers as HeadersInit);
    assert.equal(headers.get("accept"), "application/json", face);
    assert.equal(headers.get("authorization"), `Bearer ${AUTH_TOKEN}`, face);
  }
});

test("openai-face entries carry the id only, never provider display fields", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse(
      JSON.stringify({
        object: "list",
        data: [{ id: "deepseek-v4-pro", display_name: "should be ignored", created_at: "nope" }],
      }),
    ),
  );
  const outcome = await fetchEndpointModelsList({
    face: "deepseek",
    authToken: AUTH_TOKEN,
    fetch,
  });
  assert.deepEqual(outcome, {
    outcome: "success",
    models: [{ id: "deepseek-v4-pro" }],
  });
});

test("a custom base URL replaces the documented host and tolerates a trailing slash", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse('{"data":[]}'));
  const outcome = await fetchEndpointModelsList({
    face: "glm-anthropic",
    authToken: AUTH_TOKEN,
    baseUrl: "http://localhost:9000/api/anthropic/",
    fetch,
  });
  assert.deepEqual(outcome, { outcome: "success", models: [] });
  assert.equal(calls[0]!.url, "http://localhost:9000/api/anthropic/v1/models");
});

test("HTTP status classes map to coarse failure reasons", async () => {
  for (const [status, expected] of [
    [401, { outcome: "failure", reason: "unauthorized" }],
    [403, { outcome: "failure", reason: "unauthorized" }],
    [400, { outcome: "failure", reason: "endpoint-error" }],
    [404, { outcome: "failure", reason: "endpoint-error" }],
    [429, { outcome: "failure", reason: "endpoint-error" }],
    [500, { outcome: "failure", reason: "server-error" }],
    [503, { outcome: "failure", reason: "server-error" }],
  ] as const) {
    const { fetch } = fakeFetch(() => jsonResponse("garbage body", status));
    const outcome = await fetchEndpointModelsList({
      face: "glm-anthropic",
      authToken: AUTH_TOKEN,
      fetch,
    });
    assert.deepEqual(outcome, expected, `status ${status}`);
  }
});

test("fetch rejections become network failures; aborts become timeouts", async () => {
  const networkFetch = (() =>
    Promise.reject(new Error("ECONNREFUSED (private detail)"))) as typeof fetch;
  assert.deepEqual(
    await fetchEndpointModelsList({
      face: "glm-anthropic",
      authToken: AUTH_TOKEN,
      fetch: networkFetch,
    }),
    { outcome: "failure", reason: "network" },
  );

  const abortFetch = (() => {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }) as FetchLike;
  assert.deepEqual(
    await fetchEndpointModelsList({
      face: "kimi-platform",
      authToken: AUTH_TOKEN,
      fetch: abortFetch,
    }),
    { outcome: "failure", reason: "timeout" },
  );
});

test("timeout aborts the request via the injected deadline", async () => {
  const { calls, fetch } = fakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  );
  const outcome = await fetchEndpointModelsList({
    face: "deepseek",
    authToken: AUTH_TOKEN,
    fetch,
    timeoutMilliseconds: 20,
  });
  assert.deepEqual(outcome, { outcome: "failure", reason: "timeout" });
  assert.equal(calls.length, 1);
});

test("malformed payloads fail closed on every shape violation", async () => {
  const oversizedId = "a".repeat(201);
  const hostileBodies: readonly string[] = [
    "not json",
    "null",
    "42",
    '"a string"',
    "[]",
    "{}",
    '{"data":"not-an-array"}',
    '{"data":[null]}',
    '{"data":["a string entry"]}',
    '{"data":[{"no_id":true}]}',
    '{"data":[{"id":1}]}',
    '{"data":[{"id":null}]}',
    '{"data":[{"id":""}]}',
    `{"data":[{"id":"${oversizedId}"}]}`,
    '{"data":[{"id":" padded-id "}]}',
    '{"data":[{"id":"id with spaces"}]}',
    '{"data":[{"id":"tab\\tid"}]}',
    `{"data":${JSON.stringify(
      Array.from({ length: 257 }, (_, index) => ({ id: `model-${index}` })),
    )}}`,
  ];
  for (const body of hostileBodies) {
    const { fetch } = fakeFetch(() => jsonResponse(body));
    const outcome = await fetchEndpointModelsList({
      face: "glm-anthropic",
      authToken: AUTH_TOKEN,
      fetch,
    });
    assert.deepEqual(
      outcome,
      { outcome: "failure", reason: "malformed-response" },
      body.slice(0, 60),
    );
  }
  // The shared openai-compatible parser must not drift from these rules.
  for (const body of ["not json", '{"data":{}}', '{"data":[{"id":""}]}']) {
    const { fetch } = fakeFetch(() => jsonResponse(body));
    assert.deepEqual(
      await fetchEndpointModelsList({
        face: "deepseek",
        authToken: AUTH_TOKEN,
        fetch,
      }),
      { outcome: "failure", reason: "malformed-response" },
      body,
    );
  }
});

test("a sparse but valid empty list is a success, not a malformation", async () => {
  const { fetch } = fakeFetch(() => jsonResponse('{"data":[]}'));
  assert.deepEqual(
    await fetchEndpointModelsList({
      face: "glm-openai",
      authToken: AUTH_TOKEN,
      fetch,
    }),
    { outcome: "success", models: [] },
  );
});

test("invalid display metadata is dropped, never propagated or fatal", async () => {
  const { fetch } = fakeFetch(() =>
    jsonResponse(
      JSON.stringify({
        data: [
          { id: "model-keep", display_name: "Fable 5.1", created_at: "2026-08-01T00:00:00Z" },
          { id: "model-control-char", display_name: "bad\u0007name", created_at: "ok" },
          { id: "model-oversize", display_name: "x".repeat(201), created_at: "ok" },
          { id: "model-numeric", display_name: 42, created_at: 42 },
          { id: "model-trimmed", display_name: " padded ", created_at: " also padded " },
          { id: "model-long-created", display_name: "ok", created_at: "c".repeat(65) },
        ],
      }),
    ),
  );
  const outcome = await fetchEndpointModelsList({
    face: "glm-anthropic",
    authToken: AUTH_TOKEN,
    fetch,
  });
  assert.deepEqual(outcome, {
    outcome: "success",
    models: [
      { id: "model-keep", displayName: "Fable 5.1", createdAt: "2026-08-01T00:00:00Z" },
      { id: "model-control-char", createdAt: "ok" },
      { id: "model-oversize", createdAt: "ok" },
      { id: "model-numeric" },
      { id: "model-trimmed" },
      { id: "model-long-created", displayName: "ok" },
    ],
  });
});

test("missing or malformed tokens fail closed without a request", async () => {
  for (const authToken of ["", "   ", "to\u0000ken"]) {
    const { calls, fetch } = fakeFetch(() => jsonResponse(GLM_ANTHROPIC_BODY));
    assert.deepEqual(
      await fetchEndpointModelsList({ face: "glm-anthropic", authToken, fetch }),
      { outcome: "failure", reason: "token-missing" },
      JSON.stringify(authToken),
    );
    assert.equal(calls.length, 0);
  }
});

test("invalid base URLs are refused without calling fetch", async () => {
  for (const baseUrl of [
    "ftp://example.invalid/api",
    "not a url",
    "http://insecure.example.com/api",
  ]) {
    const { calls, fetch } = fakeFetch(() => jsonResponse(GLM_ANTHROPIC_BODY));
    assert.deepEqual(
      await fetchEndpointModelsList({
        face: "glm-anthropic",
        authToken: AUTH_TOKEN,
        baseUrl,
        fetch,
      }),
      { outcome: "failure", reason: "invalid-base-url" },
      baseUrl,
    );
    assert.equal(calls.length, 0);
  }
});

test("unknown face ids are a loud programmer error", async () => {
  const { fetch } = fakeFetch(() => jsonResponse(GLM_ANTHROPIC_BODY));
  await assert.rejects(
    fetchEndpointModelsList({
      face: "not-a-face" as EndpointModelsListFaceId,
      authToken: AUTH_TOKEN,
      fetch,
    }),
    TypeError,
  );
});

test("invalid timeout values reject; oversized timeouts are clamped to the ceiling", async () => {
  for (const timeoutMilliseconds of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "1000"]) {
    const { fetch } = fakeFetch(() => jsonResponse(GLM_ANTHROPIC_BODY));
    await assert.rejects(
      fetchEndpointModelsList({
        face: "glm-anthropic",
        authToken: AUTH_TOKEN,
        fetch,
        timeoutMilliseconds: timeoutMilliseconds as number,
      }),
      TypeError,
      String(timeoutMilliseconds),
    );
  }
  const { fetch } = fakeFetch(() => jsonResponse('{"data":[]}'));
  assert.deepEqual(
    await fetchEndpointModelsList({
      face: "glm-anthropic",
      authToken: AUTH_TOKEN,
      fetch,
      timeoutMilliseconds: 3_600_000,
    }),
    { outcome: "success", models: [] },
  );
  assert.equal(ENDPOINT_MODELS_LIST_TIMEOUT_MILLISECONDS, 10_000);
  assert.equal(ENDPOINT_MODELS_LIST_TIMEOUT_CEILING_MILLISECONDS, 10_000);
  assert.ok(ENDPOINT_MODELS_LIST_TIMEOUT_MILLISECONDS > 0);
});

test("success outcomes are frozen", async () => {
  const { fetch } = fakeFetch(() => jsonResponse(GLM_ANTHROPIC_BODY));
  const outcome = await fetchEndpointModelsList({
    face: "glm-anthropic",
    authToken: AUTH_TOKEN,
    fetch,
  });
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.outcome === "success" ? outcome.models : []));
  const first = outcome.outcome === "success" ? outcome.models[0] : undefined;
  assert.ok(first !== undefined && Object.isFrozen(first));
});

test("URL constants pin the documented endpoints", () => {
  assert.equal(
    GLM_ANTHROPIC_MODELS_LIST_URL,
    "https://open.bigmodel.cn/api/anthropic/v1/models",
  );
  assert.equal(
    GLM_OPENAI_MODELS_LIST_URL,
    "https://open.bigmodel.cn/api/coding/paas/v4/models",
  );
  assert.equal(KIMI_PLATFORM_MODELS_LIST_URL, "https://api.moonshot.ai/v1/models");
  // Ticket 11 Comments live check: the CN platform face serves /v1/models
  // too (200 with the four kimi platform models) — that is the domain the
  // kimi-platform endpoint's seeded transport actually talks to.
  assert.equal(
    KIMI_PLATFORM_CN_MODELS_LIST_URL,
    "https://api.moonshot.cn/v1/models",
  );
  assert.equal(DEEPSEEK_MODELS_LIST_URL, "https://api.deepseek.com/models");
  assert.deepEqual(Object.keys(ENDPOINT_MODELS_LIST_FACES).sort(), [
    "deepseek",
    "glm-anthropic",
    "glm-openai",
    "kimi-platform",
    "kimi-platform-cn",
  ]);
});

test("findNewEndpointModelIds reports unknown listed ids, base-normalized", () => {
  assert.deepEqual(
    findNewEndpointModelIds(
      ["glm-5.3[1m]", "glm-5.3-flash[1m]"],
      ["glm-5.3", "glm-5.3-flash", "glm-5.4"],
    ),
    ["glm-5.4"],
  );
  assert.deepEqual(
    findNewEndpointModelIds(["glm-5.3[1m]"], ["glm-5.3"]),
    [],
  );
  // A provider that returns the CLI-side suffix still yields the bare id.
  assert.deepEqual(
    findNewEndpointModelIds(["glm-5.3[1m]"], ["glm-5.4[1m]", "glm-5.3"]),
    ["glm-5.4"],
  );
  // Duplicates collapse; list order is preserved; whole-id suffixes never
  // emit an empty base.
  assert.deepEqual(
    findNewEndpointModelIds([], ["b", "a", "b", "[1m]"]),
    ["b", "a"],
  );
});
