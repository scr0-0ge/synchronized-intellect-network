import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import { usageCapture } from "./claude-usage-replay.ts";
import { quotaFrames } from "./fixtures/claude-quota-replay.ts";

/**
 * w234: proves the provider-agnostic `observeUsage` sink (added alongside the
 * unchanged Claude-only `observeSubscriptionUsage`) fires with the generic
 * `RuntimeUsageObservation` shape from both real emission sites in
 * claude/session.ts -- the first-party rate_limit_event frame and the GLM
 * 429-text exhaustion path -- using the same captured wire fixtures the
 * existing Claude-only tests already replay.
 */

function noopTransport(frames: string[]) {
  return {
    async send() {},
    async receive() { return frames.shift() ?? null; },
    async stop() {},
  };
}

test("rate_limit_event feeds the generic usage observer, ms-converted from provider epoch seconds", async () => {
  const { init, rate } = usageCapture("claude-web");
  const frames = [
    init,
    rate,
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
  ].map(frame => JSON.stringify(frame));
  const usageObservations: unknown[] = [];
  const binding = new ClaudeRuntimeBinding({
    transport: noopTransport(frames),
    profile: { model: init.model, effortLevel: "xhigh", executionMode: "ultracode" as const, accessMode: "full-access" as const },
    opaqueSessionReference: "offline-usage-template", expectedModel: init.model,
    stopHookCallbackId: "stop-hook", permissionMode: "manual" as const,
    observeSessionIdentity: () => {}, ultracodeConfirmed: true,
    usageEndpointKey: "claude", observeUsage: observation => { usageObservations.push(observation); },
  });
  await binding.send({ text: "offline replay input" });
  for await (const _event of binding.events()) { /* drain to completion */ }
  assert.equal(usageObservations.length, 1);
  assert.deepEqual(usageObservations[0], {
    endpointKey: "claude",
    windows: [
      { label: "five-hour", utilization: 0.5, resetsAt: 1_800_000_000_000 },
      { label: "seven-day", utilization: 0.25, resetsAt: 1_800_432_000_000 },
    ],
    observedAt: (usageObservations[0] as { observedAt: number }).observedAt,
    source: "rate-limit-event",
  });
});

test("GLM 429 exhaustion text feeds the generic usage observer as a single reset-only window", async () => {
  const frames = quotaFrames.map(frame => JSON.stringify(frame));
  const usageObservations: unknown[] = [];
  const binding = new ClaudeRuntimeBinding({
    transport: noopTransport(frames),
    profile: { model: "glm-5.3", effortLevel: "high", executionMode: "single-agent" as const, accessMode: "full-access" as const },
    opaqueSessionReference: "offline-usage-template-glm", expectedModel: "glm-5.3",
    stopHookCallbackId: "OFFLINE_STOP_HOOK", permissionMode: "manual" as const,
    observeSessionIdentity: () => {}, ultracodeConfirmed: true,
    endpointUrl: "https://open.bigmodel.cn/api/anthropic",
    usageEndpointKey: "glm", observeUsage: observation => { usageObservations.push(observation); },
  });
  await binding.send({ text: "offline replay input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  // The captured fixture text names "2026-09-11 10:33:17" with no timezone; w211 reads it as UTC.
  const resetsAt = Date.parse("2026-09-11T10:33:17Z");
  assert.deepEqual(events.at(-1), { kind: "turn-paused", reason: "quota-exhausted", resetsAt });
  assert.equal(usageObservations.length, 1);
  assert.deepEqual(usageObservations[0], {
    endpointKey: "glm",
    windows: [{ label: "quota-window", resetsAt }],
    observedAt: (usageObservations[0] as { observedAt: number }).observedAt,
    source: "exhaustion-message",
  });
});

test("without observeUsage wired, no generic observation is produced (default is inert)", async () => {
  const frames = quotaFrames.map(frame => JSON.stringify(frame));
  const binding = new ClaudeRuntimeBinding({
    transport: noopTransport(frames),
    profile: { model: "glm-5.3", effortLevel: "high", executionMode: "single-agent" as const, accessMode: "full-access" as const },
    opaqueSessionReference: "offline-usage-template-inert", expectedModel: "glm-5.3",
    stopHookCallbackId: "OFFLINE_STOP_HOOK", permissionMode: "manual" as const,
    observeSessionIdentity: () => {}, ultracodeConfirmed: true,
    endpointUrl: "https://open.bigmodel.cn/api/anthropic",
  });
  await binding.send({ text: "offline replay input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn-paused");
});
