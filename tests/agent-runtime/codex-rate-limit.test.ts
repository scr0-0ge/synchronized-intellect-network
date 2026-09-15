import assert from "node:assert/strict";
import test from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { CODEX_API_STATIC_CATALOG } from "../../src/agent-runtime/codex/codex-api-models.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";

const codexApiProfile = {
  model: "gpt-5.6-codex",
  effortLevel: "medium",
  executionMode: "single-agent",
  accessMode: "full-access",
} as const;

// w322: real codex 0.153.4 app-server wire, `codex-api` (openai-custom
// provider) endpoint, captured against a fake local upstream answering every
// `/v1/responses` request with HTTP 429 + Retry-After
// (tests/agent-runtime/fixtures/probe-codex-429-capture.ts, mode "api"; see
// fixtures/codex-0.153.4-429-api.jsonl). Before this change the turn's
// `turn.status !== "completed"` fallback classified any non-"completed"
// status as the generic `turn-failed` (see git blame on the line this
// replaces) -- the same "no more specific reason" bucket Claude's generic 429
// fell into before w306. The capture shows codex names the failure precisely
// on the wire: `turn.error.codexErrorInfo.responseTooManyFailedAttempts.
// httpStatusCode === 429`. It never retried across a second HTTP request (one
// upstream call total) and the `error` notification carries `willRetry:
// false`, so no "retrying" progress event appears either -- unlike Claude,
// which retries roughly ten times before giving up (w306). No Retry-After or
// reset instant appears anywhere on this wire, matching the Claude capture;
// the shared `rate-limited` copy already says so ("did not report a retry
// time", transcript-copy.ts, added in w306 and reused verbatim here).
test("codex 0.153.4 capture: a 429 the CLI gives up on is classified rate-limited, not the generic turn-failed", async () => {
  const transport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/codex-0.153.4-429-api.jsonl", import.meta.url),
  );
  const adapter = new CodexAdapter(async () => transport, undefined, undefined, {
    environmentSource: () => ({ mode: "codex-api", apiKey: "synthetic", codexHome: "C:\\synthetic-home" }),
    staticCatalog: CODEX_API_STATIC_CATALOG,
  });
  const binding = await adapter.start({ projectDirectory: "C:\\synthetic-project", profile: codexApiProfile });
  await binding.send({ text: "captured input" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) events.push(event);
  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "failed", category: "rate-limited" },
  ]);
  assert.deepEqual(events.filter(event => event.kind === "progress"), []);
  assert.equal(
    transport.recordedOutboundJsonl().filter(line => JSON.parse(line).method === "turn/start").length,
    1,
    "no second turn/start was sent to work around the failure",
  );
  assert.equal(transport.recordedStopCalls(), 1);
});

// The counterpart capture (fixtures/codex-0.153.4-429-subscription-unauth.jsonl,
// same probe, mode "unauth-subscription"): the default/historical transport (no
// endpoint context -- how production actually constructs the ChatGPT-subscription
// adapter) against an isolated but deliberately UNAUTHENTICATED CODEX_HOME (no
// auth.json; no login was performed), with `CODEX_APP_SERVER_CHATGPT_BASE_URL`
// pointed at the same fake 429 server. The fake server recorded zero requests:
// `account/read` answers `{"account":null,"requiresOpenaiAuth":true}` locally
// (no network) and `assertAuthenticated` throws `authentication-required`
// before a thread or turn is ever started. Under the "no real login" constraint
// this repository's lanes work under, a real upstream 429 on the subscription
// path is therefore not reachable to capture or classify -- this pins that
// finding as a regression guard, not a rate-limited transition.
test("codex 0.153.4 capture: an unauthenticated subscription-mode adapter never reaches the network, so a 429 there is unobservable", async () => {
  const transport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/codex-0.153.4-429-subscription-unauth.jsonl", import.meta.url),
  );
  await assert.rejects(
    new CodexAdapter(async () => transport).inspect("C:\\synthetic-project"),
    (error: unknown) => error instanceof RuntimeAdapterError && error.category === "authentication-required",
  );
  assert.equal(
    transport.recordedOutboundJsonl().some(line => ["thread/start", "turn/start"].includes(JSON.parse(line).method)),
    false,
    "no thread or turn was started for an unauthenticated account",
  );
  assert.equal(transport.recordedStopCalls(), 1);
});
