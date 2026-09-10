import assert from "node:assert/strict";
import test from "node:test";

import {
  GLM_ENDPOINT_PROBE_TIMEOUT_MILLISECONDS,
  probeGlmEndpoint,
} from "../../src/workbench-shell/glm-endpoint-probe.ts";

/**
 * The probe is fully network-free: every path drives an injected fake fetch.
 * No test here (or anywhere in this lane) performs a real network call.
 */

type FetchLike = typeof fetch;

const BASE_URL = "https://open.bigmodel.cn/api/anthropic";
const AUTH_TOKEN = "test-secret-1";

function fakeFetch(
  handler: (input: string | URL, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: { url: string; init: RequestInit | undefined }[]; fetch: typeof fetch } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = ((input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(input, init));
  }) as FetchLike;
  return { calls, fetch };
}

function jsonResponse(status: number): Response {
  return new Response("{}", { status });
}

test("probe sends one minimal messages request with the key header", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse(200));
  const outcome = await probeGlmEndpoint({
    baseUrl: BASE_URL,
    authToken: AUTH_TOKEN,
    fetch,
  });
  assert.deepEqual(outcome, { outcome: "success" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE_URL}/v1/messages`);
  const init = calls[0]!.init!;
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers as HeadersInit);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-api-key"), AUTH_TOKEN);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  const body = JSON.parse(String(init.body)) as {
    model: string;
    max_tokens: number;
    messages: { role: string; content: string }[];
  };
  assert.equal(body.max_tokens, 1);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]!.role, "user");
      assert.ok(body.model.length > 0);
      // Regression (live-verified 2026-09-04): the raw endpoint rejects the
      // CLI's context-variant suffix, so the probe must send the base name.
      assert.equal(body.model, "glm-5.3");
});

test("HTTP status classes map to coarse failure reasons", async () => {
  for (const [status, expected] of [
    [200, { outcome: "success" }],
    [201, { outcome: "success" }],
    [401, { outcome: "failure", reason: "unauthorized" }],
    [403, { outcome: "failure", reason: "unauthorized" }],
    [400, { outcome: "failure", reason: "endpoint-error" }],
    [404, { outcome: "failure", reason: "endpoint-error" }],
    [429, { outcome: "failure", reason: "endpoint-error" }],
    [500, { outcome: "failure", reason: "server-error" }],
    [503, { outcome: "failure", reason: "server-error" }],
  ] as const) {
    const { fetch } = fakeFetch(() => jsonResponse(status));
    const outcome = await probeGlmEndpoint({
      baseUrl: BASE_URL,
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
    await probeGlmEndpoint({
      baseUrl: BASE_URL,
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
    await probeGlmEndpoint({
      baseUrl: BASE_URL,
      authToken: AUTH_TOKEN,
      fetch: abortFetch,
    }),
    { outcome: "failure", reason: "timeout" },
  );
});

test("timeout aborts the request via the injected deadline", async () => {
  const { calls, fetch } = fakeFetch(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  );
  const outcome = await probeGlmEndpoint({
    baseUrl: BASE_URL,
    authToken: AUTH_TOKEN,
    fetch,
    timeoutMilliseconds: 20,
  });
  assert.deepEqual(outcome, { outcome: "failure", reason: "timeout" });
  assert.equal(calls.length, 1);
});

test("invalid base URLs are refused without calling fetch", async () => {
  for (const baseUrl of [
    "ftp://example.invalid/api",
    "not a url",
    "http://insecure.example.com/api",
  ]) {
    const { calls, fetch } = fakeFetch(() => jsonResponse(200));
    const outcome = await probeGlmEndpoint({
      baseUrl,
      authToken: AUTH_TOKEN,
      fetch,
    });
    assert.deepEqual(outcome, {
      outcome: "failure",
      reason: "invalid-base-url",
    });
    assert.equal(calls.length, 0);
  }
});

test("localhost http is a legal probe target", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse(200));
  const outcome = await probeGlmEndpoint({
    baseUrl: "http://localhost:9000/api/anthropic",
    authToken: AUTH_TOKEN,
    fetch,
  });
  assert.deepEqual(outcome, { outcome: "success" });
  assert.equal(calls[0]!.url, "http://localhost:9000/api/anthropic/v1/messages");
});

test("redirects are refused instead of followed", async () => {
  const { calls, fetch } = fakeFetch(() => jsonResponse(200));
  await probeGlmEndpoint({ baseUrl: BASE_URL, authToken: AUTH_TOKEN, fetch });
  assert.equal(calls[0]!.init?.redirect, "error");
});

test("default timeout is defined and positive", () => {
  assert.ok(GLM_ENDPOINT_PROBE_TIMEOUT_MILLISECONDS > 0);
});
