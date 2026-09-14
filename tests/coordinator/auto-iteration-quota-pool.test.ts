import assert from "node:assert/strict";
import test from "node:test";
import {
  createQuotaPoolRegistry,
  type QuotaObservation,
} from "../../src/coordinator/auto-iteration/quota-pool.ts";
import type { Clock } from "../../src/coordinator/auto-iteration/clock.ts";

class FakeClock implements Clock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now(): number { return this.value; }
  set(value: number): void { this.value = value; }
}

test("endpoint and session mappings resolve to the shared account pool", () => {
  const clock = new FakeClock(100);
  const pools = createQuotaPoolRegistry(clock, [
    {
      quotaPoolId: "claude-subscription",
      accountScopeKey: "claude:subscription:owner-selected-account",
      endpointIds: ["claude-code-desktop"],
      version: 1,
    },
    {
      quotaPoolId: "claude-api",
      accountScopeKey: "claude:api:configured-key",
      endpointIds: ["claude-api"],
      version: 1,
    },
  ]);

  pools.bindSession("worker-1", "claude-code-desktop");
  pools.bindSession("worker-2", "claude-code-desktop");
  pools.bindSession("api-1", "claude-api");

  assert.equal(pools.poolForEndpoint("claude-code-desktop")?.quotaPoolId, "claude-subscription");
  assert.equal(pools.poolForSession("worker-1")?.quotaPoolId, "claude-subscription");
  assert.equal(pools.poolForSession("worker-2")?.quotaPoolId, "claude-subscription");
  assert.equal(pools.poolForSession("api-1")?.quotaPoolId, "claude-api");
});

test("resetsAt permits a reprobe but never changes waiting-for-quota to available", () => {
  const clock = new FakeClock(1_000);
  const pools = createQuotaPoolRegistry(clock, [{
    quotaPoolId: "codex-subscription",
    accountScopeKey: "codex:subscription:owner-selected-account",
    endpointIds: ["codex-desktop"],
    version: 1,
  }]);
  const observation: QuotaObservation = {
    quotaPoolId: "codex-subscription",
    source: "codex-account:account/rateLimits/read",
    observedAt: 900,
    status: "observed",
    windows: [{
      name: "primary",
      usedFraction: 1,
      resetsAt: 2_000,
      windowDurationMinutes: 300,
    }],
  };
  pools.record(observation);
  pools.markWaitingForQuota("codex-subscription", 2_000);

  assert.equal(pools.canReprobe("codex-subscription"), false);
  clock.set(2_000);
  assert.equal(pools.canReprobe("codex-subscription"), true);
  const pool = pools.get("codex-subscription");
  assert.equal(pool?.status, "waiting-for-quota");
  assert.equal(pool?.status === "waiting-for-quota" ? pool.resetsAt : undefined, 2_000);
  assert.equal(pool?.version, 2);
  assert.deepEqual(pools.latestObservation("codex-subscription"), observation);
});

test("unknown reset time is not a scheduled recovery", () => {
  const clock = new FakeClock(5_000);
  const pools = createQuotaPoolRegistry(clock, [{
    quotaPoolId: "codex-subscription",
    accountScopeKey: "codex:subscription:owner-selected-account",
    endpointIds: ["codex-desktop"],
    version: 1,
  }]);
  pools.markWaitingForQuota("codex-subscription", null);

  assert.equal(pools.canReprobe("codex-subscription"), false);
});
