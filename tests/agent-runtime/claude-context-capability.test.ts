import assert from "node:assert/strict";
import test from "node:test";
import {
  observeClaudeContextUsage,
  selectClaudeActiveModelWindow,
  type ClaudeContextUsageObservation,
} from "../../src/agent-runtime/claude/context-capability.ts";
import type { Clock } from "../../src/coordinator/auto-iteration/clock.ts";

const clock: Clock = { now: () => 1_700_000_000_000 };

test("get_context_usage produces an authoritative same-source fraction", async () => {
  const requests: unknown[] = [];
  const observation = await observeClaudeContextUsage({
    sessionId: "session-1",
    model: "claude-opus-5[1m]",
    clock,
    request: async request => {
      requests.push(request);
      return {
        totalTokens: 700_000,
        maxTokens: 1_000_000,
        autoCompactThreshold: 967_000,
        model: "claude-opus-5[1m]",
        futureField: true,
      };
    },
  });

  assert.deepEqual(requests, [{ subtype: "get_context_usage" }]);
  assert.deepEqual(observation, {
    source: "claude-control:get_context_usage",
    observedAt: 1_700_000_000_000,
    sessionId: "session-1",
    model: "claude-opus-5[1m]",
    quality: "authoritative",
    totalTokens: 700_000,
    maxTokens: 1_000_000,
    fraction: 0.7,
  });
});

test("get_context_usage does not publish a percentage when its values are unavailable", async () => {
  const observation = await observeClaudeContextUsage({
    sessionId: "session-2",
    model: "sonnet",
    clock,
    request: async () => ({ model: "sonnet", maxTokens: 200_000 }),
  });

  assert.equal(observation.quality, "unknown");
  assert.equal(observation.totalTokens, null);
  assert.equal(observation.maxTokens, null);
  assert.equal(observation.fraction, null);
});

test("an unavailable control request becomes an unknown observation", async () => {
  const observation = await observeClaudeContextUsage({
    sessionId: "session-3",
    model: "sonnet",
    clock,
    request: async () => {
      throw new Error("unsupported");
    },
  });

  assert.equal(observation.quality, "unknown");
  assert.equal(observation.fraction, null);
});

test("modelUsage selects only the active model instead of the first or largest window", () => {
  const observation: ClaudeContextUsageObservation = {
    source: "claude-control:get_context_usage",
    observedAt: 1_700_000_000_000,
    sessionId: "session-4",
    model: "claude-sonnet-5",
    quality: "authoritative",
    totalTokens: 50_000,
    maxTokens: 200_000,
    fraction: 0.25,
  };
  const selected = selectClaudeActiveModelWindow(
    {
      "claude-haiku-4-5": { contextWindow: 1_000_000 },
      "claude-sonnet-5": { contextWindow: 200_000 },
      "claude-opus-5": { contextWindow: 500_000 },
    },
    observation.model,
  );

  assert.equal(selected, 200_000);
  assert.equal(
    selectClaudeActiveModelWindow(
      { "claude-haiku-4-5": { contextWindow: 1_000_000 } },
      observation.model,
    ),
    undefined,
  );
});
