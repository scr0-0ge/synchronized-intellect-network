import assert from "node:assert/strict";
import test from "node:test";
import { quotaAdapter, quotaEndpoint, quotaFrames, quotaProfile, QuotaReplayTransport } from "./fixtures/claude-quota-replay.ts";

async function replay(frames = quotaFrames, endpoint = quotaEndpoint, stopError = false) {
  const transport = new QuotaReplayTransport(frames);
  transport.stopError = stopError;
  const binding = await quotaAdapter(transport, endpoint).start({ projectDirectory: "offline-project", profile: quotaProfile });
  await binding.send({ text: "offline initial input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return { binding, events, transport };
}

test("captured GLM initial 429/1310 rejection pauses only after transport stops", async (t) => {
  const { binding, events, transport } = await replay();
  t.diagnostic(JSON.stringify({ terminal: events.at(-1), stopCalls: transport.stopped, sentInputs: transport.sent.filter(f => f.type === "user").length }));
  // The captured fixture text names "2026-09-11 10:33:17" with no timezone; w211 reads it as UTC.
  assert.deepEqual(events.at(-1), { kind: "turn-paused", reason: "quota-exhausted", resetsAt: Date.parse("2026-09-11T10:33:17Z") });
  assert.equal(binding.effectiveProfile(), undefined, "quota refusal is not a Stop-hook execution receipt");
  assert.equal(transport.stopped, 1);
  assert.equal(transport.sent.filter(frame => frame.type === "user").length, 1);
  assert.equal(transport.received, 5, "two handshake frames and three captured frames; no read after terminal");
});

const mutations: Record<string, (frames: Record<string, any>[]) => void> = {
  "wrong result Session": f => { f[2].session_id = "other-session"; },
  "wrong assistant Session": f => { f[1].session_id = "other-session"; },
  "not API error": f => { f[1].is_api_error_message = false; },
  "not rate_limit": f => { f[1].error = "api_error"; },
  "not synthetic": f => { f[1].message.model = "glm-5.3"; },
  "not HTTP 429": f => { f[2].api_error_status = 500; },
  "wrong terminal reason": f => { f[2].terminal_reason = "completed"; },
  "not error terminal": f => { f[2].is_error = false; },
  "not business 1310": f => { for (const row of [f[1].message.content[0], f[2]]) { const key = "text" in row ? "text" : "result"; row[key] = row[key].replace("[1310]", "[1302]"); } },
  "mismatched result text": f => { f[2].result += " altered"; },
  "missing num_turns": f => { delete f[2].num_turns; },
  "multiple turns": f => { f[2].num_turns = 2; },
  "queued input": f => { f[2].queued_turn_count = 1; },
  "nonzero input usage": f => { f[2].usage.input_tokens = 1; },
  "nonzero output usage": f => { f[2].usage.output_tokens = 1; },
  "nonzero assistant usage": f => { f[1].message.usage.input_tokens = 1; },
  "missing cache usage": f => { delete f[2].usage.cache_read_input_tokens; },
  "prior assistant output": f => { f.splice(1, 0, { ...f[1], error: undefined, is_api_error_message: undefined, message: { role: "assistant", content: [{ type: "text", text: "already executed" }] } }); },
  "prior reasoning": f => { f.splice(1, 0, { ...f[1], message: { role: "assistant", content: [{ type: "thinking", thinking: "already thinking" }] } }); },
  "prior tool request": f => { f.splice(1, 0, { ...f[1], message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] } }); },
  "unobserved assistant rejection": f => { f.splice(1, 1); },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`quota refusal remains failed: ${name}`, async () => {
    const frames = structuredClone(quotaFrames);
    mutate(frames);
    const { events, transport } = await replay(frames);
    assert.equal(events.at(-1)?.kind, "failed");
    assert.equal(transport.stopped, 1);
    assert.equal(transport.sent.filter(frame => frame.type === "user").length, 1);
  });
}

test("identical quota text on another endpoint is not GLM quota evidence", async () => {
  const { events } = await replay(quotaFrames, { ...quotaEndpoint, environmentSource: { mode: "api-key" } });
  assert.equal(events.at(-1)?.kind, "failed");
});

test("a custom GLM-compatible base URL is not the observed GLM endpoint", async () => {
  const { events } = await replay(quotaFrames, { ...quotaEndpoint,
    environmentSource: { mode: "glm", baseUrl: "https://other.example/api/anthropic" } });
  assert.equal(events.at(-1)?.kind, "failed");
});

test("shutdown failure cannot be hidden behind a quota pause", async () => {
  const { events } = await replay(quotaFrames, quotaEndpoint, true);
  assert.deepEqual(events.at(-1), { kind: "failed", category: "runtime-shutdown" });
});
