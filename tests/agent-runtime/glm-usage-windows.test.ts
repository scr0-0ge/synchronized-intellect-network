import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import {
  createGlmUsageWindowsSource,
  deriveGlmMonitorBaseUrl,
  fetchGlmUsageWindows,
  GLM_USAGE_WINDOWS_PATH,
  parseGlmUsageWindowsResponse,
} from "../../src/agent-runtime/claude/glm-usage-windows.ts";
import { reconstructWorkbenchUsageObservation } from "../../src/workbench-shell/result-sanitizer.ts";

/**
 * w292: every path here drives an injected fake fetch, the same discipline
 * `glm-endpoint-probe.test.ts` documents -- no test in this file performs a
 * real network call.
 */

function fakeFetch(
  handler: (input: string | URL, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: { url: string; init: RequestInit | undefined }[]; fetch: typeof fetch } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = ((input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(input, init));
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

// Real shape (owner key, 2026-09-14); values synthesized before this commit
// per the w292 hard constraint.
function syntheticMonitorBody(overrides: Partial<{ fiveHourPercentage: number; sevenDayPercentage: number }> = {}) {
  return {
    code: 200,
    msg: "Operation successful",
    success: true,
    data: {
      level: "pro",
      limits: [
        {
          type: "CREDIT_LIMIT", unit: 3, number: 5,
          usage: 12_000, currentValue: 9_705, remaining: 2_294,
          percentage: overrides.fiveHourPercentage ?? 50, nextResetTime: 1_800_000_000_000,
        },
        {
          type: "CREDIT_LIMIT", unit: 6, number: 1,
          usage: 60_000, currentValue: 21_708, remaining: 38_291,
          percentage: overrides.sevenDayPercentage ?? 36, nextResetTime: 1_800_100_000_000,
        },
      ],
    },
  };
}

test("deriveGlmMonitorBaseUrl keeps the scheme and host of the configured Anthropic base URL", () => {
  assert.equal(
    deriveGlmMonitorBaseUrl("https://open.bigmodel.cn/api/anthropic"),
    "https://open.bigmodel.cn",
  );
  assert.equal(
    deriveGlmMonitorBaseUrl("https://api.z.ai/api/anthropic"),
    "https://api.z.ai",
  );
  assert.equal(
    deriveGlmMonitorBaseUrl("http://127.0.0.1:4173/api/anthropic"),
    "http://127.0.0.1:4173",
  );
});

for (const invalid of ["not-a-url", "ftp://open.bigmodel.cn/api/anthropic", "http://example.com/api/anthropic", ""]) {
  test(`deriveGlmMonitorBaseUrl degrades to undefined for an invalid base URL (${JSON.stringify(invalid)})`, () => {
    assert.equal(deriveGlmMonitorBaseUrl(invalid), undefined);
  });
}

test("parseGlmUsageWindowsResponse maps both CREDIT_LIMIT windows", () => {
  const observation = parseGlmUsageWindowsResponse(syntheticMonitorBody(), "glm", 1_700_000_000_000);
  assert.deepEqual(observation, {
    endpointKey: "glm",
    windows: [
      { label: "five-hour", utilization: 0.5, resetsAt: 1_800_000_000_000 },
      { label: "seven-day", utilization: 0.36, resetsAt: 1_800_100_000_000 },
    ],
    observedAt: 1_700_000_000_000,
    source: "zhipu-monitor",
  });
});

test("parseGlmUsageWindowsResponse hides the reading when either required window is absent", () => {
  const body = syntheticMonitorBody();
  body.data.limits = [body.data.limits[0]!];
  const observation = parseGlmUsageWindowsResponse(body, "glm", 1);
  assert.equal(observation, undefined);
});

test("parseGlmUsageWindowsResponse tolerates (skips) an unrecognized unit/number pair and an unrecognized type", () => {
  const body = syntheticMonitorBody();
  (body.data.limits as unknown[]).push(
    { type: "CREDIT_LIMIT", unit: 9, number: 9, percentage: 10, nextResetTime: 1 },
    { type: "SOME_OTHER_LIMIT", unit: 3, number: 5, percentage: 10, nextResetTime: 1 },
  );
  const observation = parseGlmUsageWindowsResponse(body, "glm", 1);
  assert.equal(observation?.windows.length, 2);
});

test("parseGlmUsageWindowsResponse hides the reading when a required window is duplicated", () => {
  const body = syntheticMonitorBody();
  (body.data.limits as unknown[]).push({ ...body.data.limits[0], percentage: 99 });
  assert.equal(parseGlmUsageWindowsResponse(body, "glm", 1), undefined);
});

for (const malformed of [
  null,
  "not-an-object",
  {},
  { code: 200, success: true }, // missing data
  { code: 200, success: false, data: { limits: [] } }, // success:false -- the real auth-failure shape
  { code: 1000, msg: "Authentication Failed", success: false }, // live-observed auth-failure body (no data)
  { code: 200, success: true, data: { limits: "not-an-array" } },
  { code: 200, success: true, data: { limits: [] } }, // no usable window
]) {
  test(`parseGlmUsageWindowsResponse degrades to undefined for a malformed top-level shape (${JSON.stringify(malformed)})`, () => {
    assert.equal(parseGlmUsageWindowsResponse(malformed, "glm", 1), undefined);
  });
}

for (const malformedWindow of [
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: "50", nextResetTime: 1 },
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 101, nextResetTime: 1 },
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: -1, nextResetTime: 1 },
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 50, nextResetTime: 0 },
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 50, nextResetTime: "1700000000000" },
  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 50 }, // missing nextResetTime
]) {
  test(`parseGlmUsageWindowsResponse hides the reading when a required window is malformed (${JSON.stringify(malformedWindow)})`, () => {
    const body = syntheticMonitorBody();
    body.data.limits = [
      malformedWindow as unknown as (typeof body.data.limits)[number],
      body.data.limits[1]!,
    ];
    assert.equal(parseGlmUsageWindowsResponse(body, "glm", 1), undefined);
  });
}

test("fetchGlmUsageWindows sends one GET with the documented headers and no body", async () => {
  const { calls, fetch } = fakeFetch(() => new Response(JSON.stringify(syntheticMonitorBody()), { status: 200 }));
  const observation = await fetchGlmUsageWindows({
    endpointKey: "glm",
    authToken: "test-secret-1",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    fetch,
  });
  assert.equal(observation?.windows.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://open.bigmodel.cn${GLM_USAGE_WINDOWS_PATH}`);
  const init = calls[0]!.init!;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.body, undefined);
  const headers = new Headers(init.headers as HeadersInit);
  assert.equal(headers.get("authorization"), "test-secret-1");
  assert.equal(headers.get("accept-language"), "en-US,en");
  assert.equal(headers.get("content-type"), "application/json");
});

test("fetchGlmUsageWindows maps the synthetic monitor service response through the real fetch path", async t => {
  let request: { method: string | undefined; url: string | undefined; authorization: string | undefined } | undefined;
  const server = createServer((incoming, outgoing) => {
    request = {
      method: incoming.method,
      url: incoming.url,
      authorization: incoming.headers.authorization,
    };
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(syntheticMonitorBody()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");

  const observation = await fetchGlmUsageWindows({
    endpointKey: "glm",
    authToken: "synthetic-glm-key",
    anthropicBaseUrl: `http://127.0.0.1:${address.port}/api/anthropic`,
  });

  assert.deepEqual(request, {
    method: "GET",
    url: GLM_USAGE_WINDOWS_PATH,
    authorization: "synthetic-glm-key",
  });
  assert.deepEqual(observation?.windows, [
    { label: "five-hour", utilization: 0.5, resetsAt: 1_800_000_000_000 },
    { label: "seven-day", utilization: 0.36, resetsAt: 1_800_100_000_000 },
  ]);
});

test("fetchGlmUsageWindows returns undefined and never calls fetch when the base URL is invalid", async () => {
  const { calls, fetch } = fakeFetch(() => new Response("{}", { status: 200 }));
  const observation = await fetchGlmUsageWindows({
    endpointKey: "glm",
    authToken: "test-secret-1",
    anthropicBaseUrl: "not-a-url",
    fetch,
  });
  assert.equal(observation, undefined);
  assert.equal(calls.length, 0);
});

for (const status of [401, 429, 500]) {
  test(`fetchGlmUsageWindows returns undefined on a non-200 response (status ${status})`, async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify(syntheticMonitorBody()), { status }));
    const observation = await fetchGlmUsageWindows({
      endpointKey: "glm", authToken: "k", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic", fetch,
    });
    assert.equal(observation, undefined);
  });
}

test("fetchGlmUsageWindows returns undefined on the live-observed HTTP-200 auth-failure shape", async () => {
  const { fetch } = fakeFetch(() => new Response(
    JSON.stringify({ code: 1000, msg: "Authentication Failed", success: false }), { status: 200 },
  ));
  const observation = await fetchGlmUsageWindows({
    endpointKey: "glm", authToken: "k", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic", fetch,
  });
  assert.equal(observation, undefined);
});

test("fetchGlmUsageWindows returns undefined when fetch rejects or the body is not JSON", async () => {
  const rejecting = (async () => { throw new Error("ECONNREFUSED (private detail)"); }) as typeof fetch;
  assert.equal(
    await fetchGlmUsageWindows({ endpointKey: "glm", authToken: "k", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic", fetch: rejecting }),
    undefined,
  );
  const { fetch: notJson } = fakeFetch(() => new Response("not json", { status: 200 }));
  assert.equal(
    await fetchGlmUsageWindows({ endpointKey: "glm", authToken: "k", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic", fetch: notJson }),
    undefined,
  );
});

test("fetchGlmUsageWindows aborts and returns undefined once the timeout elapses", async () => {
  const abortAware = ((_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as typeof fetch;
  const observation = await fetchGlmUsageWindows({
    endpointKey: "glm", authToken: "k", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    fetch: abortAware, timeoutMilliseconds: 5,
  });
  assert.equal(observation, undefined);
});

test("createGlmUsageWindowsSource resolves the live token/base URL before the environment, and the environment before the contract default", () => {
  const liveSource = createGlmUsageWindowsSource({
    endpointKey: "glm",
    observeUsage: () => {},
    environment: { GLM_ANTHROPIC_AUTH_TOKEN: "env-token", GLM_ANTHROPIC_BASE_URL: "https://env-base.example/api/anthropic" },
    resolveAuthToken: () => "live-token",
    resolveBaseUrl: () => "https://live-base.example/api/anthropic",
  });
  assert.equal(liveSource.resolveAuthToken(), "live-token");
  assert.equal(liveSource.resolveBaseUrl(), "https://live-base.example/api/anthropic");

  const envFallbackSource = createGlmUsageWindowsSource({
    endpointKey: "glm",
    observeUsage: () => {},
    environment: { GLM_ANTHROPIC_AUTH_TOKEN: "env-token", GLM_ANTHROPIC_BASE_URL: "https://env-base.example/api/anthropic" },
  });
  assert.equal(envFallbackSource.resolveAuthToken(), "env-token");
  assert.equal(envFallbackSource.resolveBaseUrl(), "https://env-base.example/api/anthropic");

  const emptyLiveResolverSource = createGlmUsageWindowsSource({
    endpointKey: "glm",
    observeUsage: () => {},
    environment: { GLM_ANTHROPIC_AUTH_TOKEN: "env-token", GLM_ANTHROPIC_BASE_URL: "https://env-base.example/api/anthropic" },
    resolveAuthToken: () => "",
    resolveBaseUrl: () => "",
  });
  assert.equal(emptyLiveResolverSource.resolveAuthToken(), "env-token");
  assert.equal(emptyLiveResolverSource.resolveBaseUrl(), "https://env-base.example/api/anthropic");

  const defaultSource = createGlmUsageWindowsSource({
    endpointKey: "glm",
    observeUsage: () => {},
    environment: {},
  });
  assert.equal(defaultSource.resolveAuthToken(), undefined);
  assert.equal(defaultSource.resolveBaseUrl(), "https://open.bigmodel.cn/api/anthropic");
});

/**
 * The persisted/IPC shape (`result-sanitizer.ts`) has its own closed
 * `source` allowlist, independent of the `RuntimeUsageObservation` type --
 * extending the type without extending this allowlist would have the
 * observation silently vanish at the storage/IPC boundary while every
 * runtime-side test above stayed green. This is the direct regression test
 * for that seam.
 */
test("reconstructWorkbenchUsageObservation accepts the zhipu-monitor source and still rejects an unknown one", () => {
  const observation = parseGlmUsageWindowsResponse(syntheticMonitorBody(), "glm", 1_700_000_000_000)!;
  assert.deepEqual(reconstructWorkbenchUsageObservation(observation), observation);
  assert.equal(
    reconstructWorkbenchUsageObservation({ ...observation, source: "made-up-source" }),
    undefined,
  );
});
