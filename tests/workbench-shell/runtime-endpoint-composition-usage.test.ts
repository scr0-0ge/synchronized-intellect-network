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
import { QuotaReplayTransport, quotaFrames, quotaProfile, quotaResumedFrames } from "../agent-runtime/fixtures/claude-quota-replay.ts";
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
 * w292: composition also wires a proactive read of Zhipu's monitor endpoint
 * into the GLM adapter, fired once per start/resume alongside (never instead
 * of) the reactive 429-exhaustion-text sink proven above. The two tests
 * above are the "before" baseline: today, exactly one "exhaustion-message"
 * observation ever arrives for GLM and nothing else. The read is
 * fire-and-forget (started only after the binding already exists, so a slow
 * or failing Zhipu call can never delay or fail session start), hence
 * polling `usageObservations` rather than reading it immediately after
 * `start()` resolves.
 */
async function waitForUsageObservation(
  usageObservations: readonly unknown[],
  predicate: (observation: { source: string }) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (usageObservations.some((observation) => predicate(observation as { source: string }))) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("expected usage observation did not arrive");
}

test("createProductionGlmRuntimeAdapter fires a proactive Zhipu monitor read on start, tagged zhipu-monitor", async () => {
  const usageObservations: unknown[] = [];
  const calls: { url: string }[] = [];
  const fakeMonitorFetch = (async (input: string | URL) => {
    calls.push({ url: String(input) });
    return new Response(
      JSON.stringify({
        code: 200,
        msg: "Operation successful",
        success: true,
        data: {
          level: "pro",
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 1, currentValue: 1, remaining: 1, percentage: 50, nextResetTime: 1_800_000_000_000 },
            { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 1, currentValue: 1, remaining: 1, percentage: 36, nextResetTime: 1_800_100_000_000 },
          ],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const adapter = createProductionGlmRuntimeAdapter({
    environment: { GLM_ANTHROPIC_AUTH_TOKEN: "synthetic-glm-key" },
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => new QuotaReplayTransport(quotaFrames),
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    observeUsage: observation => { usageObservations.push(observation); },
    usageWindowsFetch: fakeMonitorFetch,
  });
  await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });

  await waitForUsageObservation(usageObservations, observation => observation.source === "zhipu-monitor");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  const observation = usageObservations.find(
    (candidate): candidate is { endpointKey: string; windows: unknown; source: string } =>
      (candidate as { source: string }).source === "zhipu-monitor",
  )!;
  assert.equal(observation.endpointKey, "glm");
  assert.deepEqual(observation.windows, [
    { label: "five-hour", utilization: 0.5, resetsAt: 1_800_000_000_000 },
    { label: "seven-day", utilization: 0.36, resetsAt: 1_800_100_000_000 },
  ]);
});

test("createProductionGlmRuntimeAdapter reads the monitor again after a successful GLM resume", async () => {
  const usageObservations: { source: string }[] = [];
  const transports = [
    new QuotaReplayTransport(quotaFrames),
    new QuotaReplayTransport(quotaResumedFrames),
  ];
  const adapter = createProductionGlmRuntimeAdapter({
    environment: { GLM_ANTHROPIC_AUTH_TOKEN: "synthetic-glm-key" },
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => transports.shift()!,
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    observeUsage: observation => { usageObservations.push(observation); },
    usageWindowsFetch: (async () => new Response(JSON.stringify({
      code: 200,
      success: true,
      data: { limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 50, nextResetTime: 1_800_000_000_000 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 36, nextResetTime: 1_800_100_000_000 },
      ] },
    }), { status: 200 })) as typeof fetch,
  });
  const started = await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });
  await waitForUsageObservation(usageObservations, observation => observation.source === "zhipu-monitor");
  await started.send({ text: "offline initial input" });
  for await (const _event of started.events()) { /* establish the resume capability */ }

  await adapter.resume({
    projectDirectory: "offline-project",
    profile: quotaProfile,
    opaqueSessionReference: started.opaqueSessionReference,
  });
  await waitForUsageObservation(
    usageObservations,
    () => usageObservations.filter(observation => observation.source === "zhipu-monitor").length === 2,
  );
});

test("createProductionGlmRuntimeAdapter reports no zhipu-monitor observation when no GLM token is configured", async () => {
  const usageObservations: unknown[] = [];
  let fetchCalled = false;
  const adapter = createProductionGlmRuntimeAdapter({
    environment: {}, // no GLM_ANTHROPIC_AUTH_TOKEN and no resolveGlmAuthToken
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => new QuotaReplayTransport(quotaFrames),
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    observeUsage: observation => { usageObservations.push(observation); },
    usageWindowsFetch: (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });
  // Negative assertion: give any fire-and-forget chain a chance to run first.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fetchCalled, false);
  assert.equal(usageObservations.some(observation => (observation as { source: string }).source === "zhipu-monitor"), false);
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
