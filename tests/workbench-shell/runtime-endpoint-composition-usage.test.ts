import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionCodexAdapter,
  createProductionCodexApiRuntimeAdapter,
  createProductionGlmRuntimeAdapter,
  createProductionKimiPlatformRuntimeAdapter,
  createProductionClaudeApiRuntimeAdapter,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import { QuotaReplayTransport, quotaFrames, quotaProfile } from "../agent-runtime/fixtures/claude-quota-replay.ts";
import { ScriptedTransport } from "../agent-runtime/support/scripted-transport.ts";

const codexProfile = {
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
};

function staticCodexStartTransport(profile: typeof codexProfile) {
  return new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0", id: 2,
      result: { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_700_000_000 }, secondary: null } },
    }),
    JSON.stringify({
      jsonrpc: "2.0", id: 3,
      result: {
        thread: { id: "thread-fixed" }, model: profile.model,
        reasoningEffort: profile.effortLevel, approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
  ]);
}

function replaceCodexTransport(adapter: unknown, transport: ScriptedTransport) {
  (adapter as { createTransport: () => Promise<ScriptedTransport> }).createTransport = async () => transport;
}

/**
 * w234 follow-up: composition now threads the provider-agnostic `observeUsage`
 * sink into the GLM/Kimi/DeepSeek adapter constructions (previously only the
 * Claude-only `observeClaudeSubscriptionUsage` was wired). This proves the
 * GLM leg end-to-end through the real production factory
 * (`createProductionGlmRuntimeAdapter`) and the real 429-text parser in
 * claude/session.ts, using the same offline fixture `claude-quota-paused.test.ts`
 * already replays through `ClaudeAdapter`. Kimi/DeepSeek get the identical
 * two extra constructor arguments (see the diff), but there is no captured
 * 429/exhaustion fixture for either, so no observation ever fires for them
 * today -- fabricating one was explicitly out of scope for this delivery.
 */

test("createProductionGlmRuntimeAdapter wires observeUsage to the real GLM 429-text parse", async () => {
  const usageObservations: unknown[] = [];
  const adapter = createProductionGlmRuntimeAdapter({
    environment: {},
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => new QuotaReplayTransport(quotaFrames),
    // The fixture's captured model name ("glm-5.3") predates the current
    // production GLM_STATIC_CATALOG ids; augment rather than replace so this
    // test still validates against the real static-catalog gate.
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    observeUsage: observation => { usageObservations.push(observation); },
  });
  const binding = await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });
  await binding.send({ text: "offline initial input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn-paused");
  assert.equal(usageObservations.length, 1);
  assert.deepEqual(usageObservations[0], {
    endpointKey: "glm",
    windows: [{ label: "quota-window", resetsAt: Date.parse("2026-09-11T10:33:17Z") }],
    observedAt: (usageObservations[0] as { observedAt: number }).observedAt,
    source: "exhaustion-message",
  });
});

test("without observeUsage wired, createProductionGlmRuntimeAdapter still completes the quota-paused turn (default is inert)", async () => {
  const adapter = createProductionGlmRuntimeAdapter({
    environment: {},
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => new QuotaReplayTransport(quotaFrames),
    // The fixture's captured model name ("glm-5.3") predates the current
    // production GLM_STATIC_CATALOG ids; augment rather than replace so this
    // test still validates against the real static-catalog gate.
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
  });
  const binding = await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });
  await binding.send({ text: "offline initial input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn-paused");
});

/**
 * w257: Codex's own weekly rate-limit read (`account/rateLimits/read`,
 * live-verified against real codex.exe 0.153.4) now threads through this
 * same production factory, tagged "codex" -- proving the composition-level
 * wiring, not just the `CodexAdapter` constructor in isolation.
 */
test("createProductionCodexAdapter wires observeUsage to the real account/rateLimits/read parse", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { data: [{ id: "gpt-5.6-sol", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }] }] },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_700_000_000 },
          secondary: null,
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: {
        thread: { id: "thread-fixed" },
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread-fixed" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 6, result: { turn: { id: "turn-fixed", status: "inProgress" } } }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread-fixed", turn: { id: "turn-fixed", status: "inProgress" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "item/started",
      params: { threadId: "thread-fixed", turnId: "turn-fixed", item: { id: "item-fixed", type: "agentMessage" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "thread-fixed",
        turnId: "turn-fixed",
        item: { id: "item-fixed", type: "agentMessage", phase: "final_answer", text: "FIXED_MARKER" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-fixed", turn: { id: "turn-fixed", status: "completed" } },
    }),
  ]);
  const usageObservations: unknown[] = [];
  const adapter = createProductionCodexAdapter(undefined, async () => transport, observation => {
    usageObservations.push(observation);
  });
  const binding = await adapter.start({ projectDirectory: "C:\\synthetic-project", profile: codexProfile });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn-completed");
  assert.equal(usageObservations.length, 1);
  assert.deepEqual(usageObservations[0], {
    endpointKey: "codex",
    windows: [{ label: "seven-day", utilization: 0.5, resetsAt: 1_700_000_000_000 }],
    observedAt: (usageObservations[0] as { observedAt: number }).observedAt,
    source: "rate-limit-event",
  });
});

test("createProductionKimiPlatformRuntimeAdapter reports a platform rate-limit snapshot", async () => {
  const usageObservations: unknown[] = [];
  const profile = { ...codexProfile, model: "kimi-k2.7-code", effortLevel: "default" };
  const adapter = createProductionKimiPlatformRuntimeAdapter({
    environment: {}, codexHomeDirectory: "C:\\synthetic-kimi-home",
    observeUsage: observation => { usageObservations.push(observation); },
  });
  replaceCodexTransport(adapter, staticCodexStartTransport(profile));
  await adapter.start({ projectDirectory: "C:\\synthetic-project", profile });
  assert.deepEqual(usageObservations.map(({ endpointKey, windows, source }: any) => ({ endpointKey, windows, source })), [{
    endpointKey: "kimi-platform",
    windows: [{ label: "seven-day", utilization: 0.5, resetsAt: 1_700_000_000_000 }],
    source: "rate-limit-event",
  }]);
});

test("createProductionCodexApiRuntimeAdapter reports an API rate-limit snapshot", async () => {
  const usageObservations: unknown[] = [];
  const adapter = createProductionCodexApiRuntimeAdapter({
    environment: {}, codexHomeDirectory: "C:\\synthetic-codex-api-home",
    observeUsage: observation => { usageObservations.push(observation); },
  });
  replaceCodexTransport(adapter, staticCodexStartTransport(codexProfile));
  await adapter.start({ projectDirectory: "C:\\synthetic-project", profile: codexProfile });
  assert.deepEqual(usageObservations.map(({ endpointKey, windows, source }: any) => ({ endpointKey, windows, source })), [{
    endpointKey: "codex-api",
    windows: [{ label: "seven-day", utilization: 0.5, resetsAt: 1_700_000_000_000 }],
    source: "rate-limit-event",
  }]);
});

test("claude-api result token counts do not fabricate a usage observation", async () => {
  const usageObservations: unknown[] = [];
  createProductionClaudeApiRuntimeAdapter({ environment: {}, observeUsage: observation => { usageObservations.push(observation); } });
  const init = quotaFrames[0]!;
  const frames = [
    init,
    { type: "assistant", session_id: init.session_id, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input_tokens: 123, output_tokens: 45 } } },
    { type: "control_request", request_id: "stop-request", request: { subtype: "hook_callback", callback_id: "stop-hook", input: { hook_event_name: "Stop", session_id: init.session_id, permission_mode: init.permissionMode, effort: { level: "high" } } } },
    { type: "result", session_id: init.session_id, subtype: "success", is_error: false, terminal_reason: "completed", result: "done", usage: { input_tokens: 123, output_tokens: 45 } },
  ].map(frame => JSON.stringify(frame));
  const binding = new ClaudeRuntimeBinding({
    transport: { async send() {}, async receive() { return frames.shift() ?? null; }, async stop() {} },
    profile: quotaProfile, opaqueSessionReference: "offline-claude-api", expectedModel: quotaProfile.model,
    stopHookCallbackId: "stop-hook", permissionMode: "manual", observeSessionIdentity: () => {}, ultracodeConfirmed: false,
    usageEndpointKey: "claude-api", observeUsage: observation => { usageObservations.push(observation); },
  });
  await binding.send({ text: "offline input" });
  for await (const _event of binding.events()) { /* drain */ }
  assert.deepEqual(usageObservations, []);
});
