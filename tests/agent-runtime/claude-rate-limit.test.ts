import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import type { ClaudeCatalogTransport } from "../../src/agent-runtime/claude/transport.ts";
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";

// Projections of previously captured wire, not a live CLI or provider transport.
const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/claude-quota-wire.json", import.meta.url), "utf8",
));
const init = fixture.glmQuotaFrames[0];
const allowed = fixture.allowedRateEvent;

for (const row of [
  { name: "captured allowed with rejected overage", info: allowed.rate_limit_info },
  { name: "documented allowed_warning", info: { status: "allowed_warning" } },
  { name: "unknown status", info: { status: "future-status" } },
  { name: "missing status", info: { resetsAt: 1788888000 } },
  { name: "malformed status", info: { status: 1 } },
  { name: "missing info", info: undefined },
  { name: "null info", info: null },
  { name: "array info", info: [{ status: "rejected" }] },
]) {
  test(`Claude quota telemetry does not claim rate-limited: ${row.name}`, async () => {
    const { events, transport } = await replay([
      init, { ...allowed, rate_limit_info: row.info }, ...successfulTail(),
    ]);
    assert.deepEqual(events.filter(event => event.kind === "progress"), []);
    assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
    assert.equal(transport.stopped, 1);
  });
}

test("Claude rejected telemetry coalesces without creating a wait or resending input", async () => {
  // rejected is documented; this sequence is a negative/control variant of
  // the captured allowed event, not a claim about a captured rejected turn.
  const rejected = { ...allowed, rate_limit_info: { status: "rejected" } };
  const { events, transport } = await replay([
    init, rejected, rejected, ...successfulTail(),
  ]);
  assert.deepEqual(events.filter(event => event.kind === "progress"), [
    { kind: "progress", activity: "rate-limited" },
  ]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
  assert.equal(transport.sent.filter(frame => frame.type === "user").length, 1);
});

for (const status of ["allowed", "allowed_warning"]) {
  test(`Claude ${status} clears a prior rate-limited progress without implying completion`, async () => {
    const rejected = { ...allowed, rate_limit_info: { status: "rejected" } };
    const { events } = await replay([
      init, rejected, { ...allowed, rate_limit_info: { status } },
      rejected, ...successfulTail(),
    ]);
    assert.deepEqual(events.filter(event => event.kind === "progress"), [
      { kind: "progress", activity: "rate-limited" },
      { kind: "progress", activity: "status" },
      { kind: "progress", activity: "rate-limited" },
    ]);
    assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
  });
}

test("Claude rate telemetry still requires the active Session identity even when allowed", async () => {
  const { events, transport } = await replay([
    init, { ...allowed, session_id: "wrong-session" }, ...successfulTail(),
  ]);
  assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
  assert.equal(transport.stopped, 1);
});

test("Claude captured GLM 1310 terminal ends once, without waiting or fabricating recovery", async () => {
  const { events, binding, transport } = await replay(fixture.glmQuotaFrames);
  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "failed", category: "turn-failed" },
  ]);
  assert.equal(binding.effectiveProfile(), undefined); // No Stop hook in this wire.
  assert.equal(binding.interruptAvailability(), "unavailable");
  assert.equal(binding.steerAvailability(), "unavailable");
  assert.equal(transport.stopped, 1);
  assert.equal(transport.sent.length, 1); // Initial fake input only; no retry or hook.
  assert.equal(transport.received, 3); // Never read past the terminal into a dead CLI.
});

test("Claude ordinary API failure after rate telemetry stays terminal, not a quota wait", async () => {
  const terminal = { ...fixture.glmQuotaFrames[2], api_error_status: 500, result: "API Error: internal error" };
  const { events, transport } = await replay([
    init, { ...allowed, rate_limit_info: { status: "rejected" } }, terminal,
  ]);
  assert.deepEqual(events.at(-1), { kind: "failed", category: "turn-failed" });
  assert.equal(transport.stopped, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.received, 3);
});

function successfulTail(): Record<string, unknown>[] {
  // Synthetic successful suffix supplies the existing completion evidence;
  // it is not spliced into the captured GLM error replay.
  return [
    { type: "assistant", session_id: init.session_id, parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "control_request", request_id: "stop-request", request: {
      subtype: "hook_callback", callback_id: "stop-hook", input: {
        hook_event_name: "Stop", session_id: init.session_id,
        permission_mode: init.permissionMode, effort: { level: "xhigh" },
      },
    } },
    { type: "result", session_id: init.session_id, subtype: "success",
      is_error: false, terminal_reason: "completed", result: "done" },
  ];
}

async function replay(frames: readonly Record<string, unknown>[]) {
  const transport = new ReplayTransport(frames);
  const binding = new ClaudeRuntimeBinding({
    transport,
    profile: { model: init.model, effortLevel: "xhigh", executionMode: "ultracode", accessMode: "full-access" },
    opaqueSessionReference: "offline-capability",
    expectedModel: init.model,
    stopHookCallbackId: "stop-hook",
    observeSessionIdentity: identity => assert.equal(identity, init.session_id),
    permissionMode: "manual", // Captured CLI "default" is the supported manual mode.
    ultracodeConfirmed: true,
  });
  await binding.send({ text: "offline replay input" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) events.push(event);
  return { events, binding, transport };
}

class ReplayTransport implements ClaudeCatalogTransport {
  readonly sent: Record<string, unknown>[] = [];
  readonly lines: string[];
  received = 0;
  stopped = 0;

  constructor(frames: readonly Record<string, unknown>[]) {
    this.lines = frames.map(frame => JSON.stringify(frame));
  }
  async send(line: string): Promise<void> { this.sent.push(JSON.parse(line)); }
  async receive(): Promise<string | null> {
    this.received += 1;
    return this.lines.shift() ?? null;
  }
  async stop(): Promise<void> { this.stopped += 1; }
}
