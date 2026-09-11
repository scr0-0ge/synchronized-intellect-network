import assert from "node:assert/strict";
import test from "node:test";
import { createProductionGlmRuntimeAdapter } from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import { QuotaReplayTransport, quotaFrames, quotaProfile } from "../agent-runtime/fixtures/claude-quota-replay.ts";

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
