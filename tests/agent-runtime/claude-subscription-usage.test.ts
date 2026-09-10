import assert from "node:assert/strict";
import test from "node:test";
import { captureNames, replayUsage, usageCapture } from "./claude-usage-replay.ts";

for (const name of captureNames) {
  test(`subscription usage survives the real ${name} wire without treating rejected overage as throttling`, async t => {
    const observedAt = 1_800_000_000_000;
    t.mock.timers.enable({ apis: ["Date"], now: observedAt });
    const observations: unknown[] = [];
    const { events, sent } = await replayUsage(name, value => { observations.push(value); });
    const info = usageCapture(name).rate.rate_limit_info;
    assert.equal(info.status, "allowed");
    assert.equal(info.overageStatus, "rejected");
    assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
    assert.deepEqual(events.filter(event => event.kind === "progress"), []);
    assert.equal(sent.filter(frame => frame.type === "user").length, 1);
    assert.deepEqual(observations, [{ ...info.unifiedWindows, observedAt }]);
  });
}

test("missing and malformed optional windows stay unknown without failing the turn", async () => {
  for (const windows of [undefined, {}, { five_hour: { utilization: 3, resetsAt: 1788888000 } },
    { five_hour: { utilization: 0.1, resetsAt: -1 }, seven_day: [] }]) {
    const observations: any[] = [];
    const { events } = await replayUsage("claude-web", value => { observations.push(value); }, rate => ({
      ...rate, rate_limit_info: { ...rate.rate_limit_info, unifiedWindows: windows },
    }));
    assert.equal(observations.length, 1);
    assert.equal(observations[0].five_hour, null);
    assert.equal(observations[0].seven_day, null);
    assert.equal(events.at(-1)?.kind, "turn-completed");
  }
});

test("foreign-session telemetry is rejected before reaching account storage", async () => {
  const observations: unknown[] = [];
  const { events } = await replayUsage("claude-web", value => { observations.push(value); }, rate => ({ ...rate, session_id: "foreign" }));
  assert.deepEqual(observations, []);
  assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
});

test("telemetry storage failure never turns a healthy provider result into failure", async () => {
  const { events } = await replayUsage("claude-web", async () => { throw new Error("disk unavailable"); });
  assert.equal(events.at(-1)?.kind, "turn-completed");
});
