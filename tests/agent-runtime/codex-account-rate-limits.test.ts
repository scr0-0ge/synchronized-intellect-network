import assert from "node:assert/strict";
import test from "node:test";
import {
  observeCodexAccountRateLimits,
} from "../../src/agent-runtime/codex/account-rate-limits.ts";
import type { Clock } from "../../src/coordinator/auto-iteration/clock.ts";

const clock: Clock = { now: () => 1_700_000_000_000 };

test("account/rateLimits/read becomes quota-window observations", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const observation = await observeCodexAccountRateLimits({
    quotaPoolId: "codex-subscription",
    clock,
    request: async (method, params) => {
      requests.push({ method, params });
      return {
        rateLimits: {
          primary: {
            usedPercent: 35,
            resetsAt: 1_700_003_600,
            windowDurationMins: 10_080,
          },
          secondary: null,
          newBucket: { ignored: true },
        },
        newTopLevelField: true,
      };
    },
  });

  assert.deepEqual(requests, [
    { method: "account/rateLimits/read", params: null },
  ]);
  assert.deepEqual(observation, {
    quotaPoolId: "codex-subscription",
    source: "codex-account:account/rateLimits/read",
    observedAt: 1_700_000_000_000,
    status: "observed",
    windows: [
      {
        name: "primary",
        usedFraction: 0.35,
        resetsAt: 1_700_003_600_000,
        windowDurationMinutes: 10_080,
      },
      {
        name: "secondary",
        usedFraction: null,
        resetsAt: null,
        windowDurationMinutes: null,
      },
    ],
  });
});

test("an unavailable rate-limit read records unknown rather than inventing a window", async () => {
  const observation = await observeCodexAccountRateLimits({
    quotaPoolId: "codex-subscription",
    clock,
    request: async () => {
      throw new Error("method not found");
    },
  });

  assert.deepEqual(observation, {
    quotaPoolId: "codex-subscription",
    source: "codex-account:account/rateLimits/read",
    observedAt: 1_700_000_000_000,
    status: "unknown",
    windows: [],
  });
});

test("a malformed consumed rate-limit field makes the observation unknown", async () => {
  const observation = await observeCodexAccountRateLimits({
    quotaPoolId: "codex-subscription",
    clock,
    request: async () => ({
      rateLimits: {
        primary: {
          usedPercent: "35",
          resetsAt: 1_700_003_600,
          windowDurationMins: 10_080,
        },
        secondary: null,
      },
    }),
  });

  assert.equal(observation.status, "unknown");
  assert.deepEqual(observation.windows, []);
});
