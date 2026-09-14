import assert from "node:assert/strict";
import test from "node:test";
import {
  probeCliCapabilities,
  type CapabilityProbeStore,
} from "../../src/coordinator/auto-iteration/capability-probe.ts";
import type { Clock } from "../../src/coordinator/auto-iteration/clock.ts";

const clock: Clock = { now: () => 1_700_000_000_000 };

test("the current-version capability table records four independent tri-state probes", async () => {
  const saved: unknown[] = [];
  const store: CapabilityProbeStore = {
    load: async () => undefined,
    save: async snapshot => { saved.push(snapshot); },
  };
  const calls: string[] = [];
  const snapshot = await probeCliCapabilities({
    clock,
    store,
    versions: { claude: "2.1.267", codex: "0.153.4" },
    probes: {
      claudeContextUsage: async () => { calls.push("claude-context"); return "available"; },
      codexRateLimits: async () => { calls.push("codex-rate"); return "available"; },
      claudeEffortEcho: async () => { calls.push("claude-effort"); return "available"; },
      codexEffortEcho: async () => { calls.push("codex-effort"); return "unknown"; },
    },
  });

  assert.deepEqual(calls, [
    "claude-context",
    "codex-rate",
    "claude-effort",
    "codex-effort",
  ]);
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    observedAt: 1_700_000_000_000,
    cliVersions: { claude: "2.1.267", codex: "0.153.4" },
    capabilities: {
      claudeContextUsage: "available",
      codexRateLimits: "available",
      claudeEffortEcho: "available",
      codexEffortEcho: "unknown",
    },
  });
  assert.deepEqual(saved, [snapshot]);
});

test("the same CLI versions reuse the persisted capability table", async () => {
  const existing = {
    schemaVersion: 1 as const,
    observedAt: 900,
    cliVersions: { claude: "2.1.267", codex: "0.153.4" },
    capabilities: {
      claudeContextUsage: "available" as const,
      codexRateLimits: "unavailable" as const,
      claudeEffortEcho: "available" as const,
      codexEffortEcho: "available" as const,
    },
  };
  let probed = false;
  const result = await probeCliCapabilities({
    clock,
    store: {
      load: async () => existing,
      save: async () => assert.fail("cached snapshot must not be rewritten"),
    },
    versions: existing.cliVersions,
    probes: {
      claudeContextUsage: async () => { probed = true; return "unknown"; },
      codexRateLimits: async () => { probed = true; return "unknown"; },
      claudeEffortEcho: async () => { probed = true; return "unknown"; },
      codexEffortEcho: async () => { probed = true; return "unknown"; },
    },
  });

  assert.equal(probed, false);
  assert.equal(result, existing);
});

test("a CLI version change reprobes instead of trusting an old table", async () => {
  let calls = 0;
  await probeCliCapabilities({
    clock,
    store: {
      load: async () => ({
        schemaVersion: 1,
        observedAt: 900,
        cliVersions: { claude: "2.1.266", codex: "0.153.4" },
        capabilities: {
          claudeContextUsage: "available",
          codexRateLimits: "available",
          claudeEffortEcho: "available",
          codexEffortEcho: "available",
        },
      }),
      save: async () => {},
    },
    versions: { claude: "2.1.267", codex: "0.153.4" },
    probes: {
      claudeContextUsage: async () => { calls += 1; return "available"; },
      codexRateLimits: async () => { calls += 1; return "available"; },
      claudeEffortEcho: async () => { calls += 1; return "available"; },
      codexEffortEcho: async () => { calls += 1; return "available"; },
    },
  });

  assert.equal(calls, 4);
});

test("an unavailable capability is distinct from a failed probe's unknown state", async () => {
  const result = await probeCliCapabilities({
    clock,
    store: {
      load: async () => undefined,
      save: async () => {},
    },
    versions: { claude: "2.1.267", codex: "0.153.4" },
    probes: {
      claudeContextUsage: async () => { throw new Error("transient failure"); },
      codexRateLimits: async () => "unavailable",
      claudeEffortEcho: async () => "available",
      codexEffortEcho: async () => "available",
    },
  });

  assert.equal(result.capabilities.claudeContextUsage, "unknown");
  assert.equal(result.capabilities.codexRateLimits, "unavailable");
});
