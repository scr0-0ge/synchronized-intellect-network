import assert from "node:assert/strict";
import test from "node:test";

import { WORKBENCH_START_AUTO_ITERATION_SUPERVISOR_CHANNEL } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchPreloadBridge, type FixedProjectViewIpc } from "../../src/workbench-shell/preload-bridge.ts";
import { reconstructWorkbenchStartAutoIterationSupervisorRequest } from "../../src/workbench-shell/result-sanitizer.ts";

const uuid = "22222222-2222-4222-8222-222222222222";
const request = Object.freeze({
  projectId: `project-selection:${uuid}`,
  snapshotKey: `snapshot:${uuid}`,
  endpointKey: `endpoint-option:1:${uuid}`,
  modelKey: `model-option:1:${uuid}`,
  workIntensityKey: `intensity-option:1:${uuid}`,
  executionModeKey: `execution-option:1:${uuid}`,
  accessModeKey: `access-option:1:${uuid}`,
});

test("auto-iteration-supervisor requests reuse the exact current profile selection keys", () => {
  assert.deepEqual(reconstructWorkbenchStartAutoIterationSupervisorRequest(request), { ok: true, request });
  assert.equal(reconstructWorkbenchStartAutoIterationSupervisorRequest({ ...request, extraField: "private" }).ok, false);
  assert.equal(reconstructWorkbenchStartAutoIterationSupervisorRequest({ ...request, projectId: "old-project" }).ok, false);
  assert.equal(reconstructWorkbenchStartAutoIterationSupervisorRequest(undefined).ok, false);
});

test("the sanitizer round-trips a started result and every documented rejection category", async () => {
  const { sanitizeWorkbenchStartAutoIterationSupervisorResult } = await import(
    "../../src/workbench-shell/result-sanitizer.ts"
  );
  assert.deepEqual(sanitizeWorkbenchStartAutoIterationSupervisorResult({ ok: true, status: "started" }), {
    ok: true,
    status: "started",
  });
  for (
    const category of [
      "already-active",
      "invalid-project",
      "invalid-profile-selection",
      "start-failed",
      "auto-iteration-unavailable",
    ] as const
  ) {
    const result = sanitizeWorkbenchStartAutoIterationSupervisorResult({
      ok: false,
      error: { category, message: "a reason the owner can read" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.category, category);
      assert.equal(result.error.message, "a reason the owner can read");
    }
  }
  // An unrecognized category and a malformed value both collapse to the same
  // actionable public failure; they must never leak an unlisted category.
  const unknownCategory = sanitizeWorkbenchStartAutoIterationSupervisorResult({
    ok: false,
    error: { category: "not-a-real-category", message: "x" },
  });
  assert.equal(unknownCategory.ok, false);
  if (!unknownCategory.ok) assert.equal(unknownCategory.error.category, "auto-iteration-unavailable");
  const malformed = sanitizeWorkbenchStartAutoIterationSupervisorResult(undefined);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.category, "auto-iteration-unavailable");
});

test("the preload exposes startAutoIterationSupervisor and sanitizes its result", async () => {
  const calls: Array<{ channel: string; values: readonly unknown[] }> = [];
  const ipc: FixedProjectViewIpc = {
    on() {}, removeListener() {}, send() {},
    async invoke(channel, ...values) {
      calls.push({ channel, values });
      if (channel === WORKBENCH_START_AUTO_ITERATION_SUPERVISOR_CHANNEL) return { ok: true, status: "started" };
      return undefined;
    },
  };
  const bridge = createWorkbenchPreloadBridge(ipc);
  assert.deepEqual(await bridge.startAutoIterationSupervisor(request), { ok: true, status: "started" });
  assert.deepEqual(calls.map((call) => call.channel), [WORKBENCH_START_AUTO_ITERATION_SUPERVISOR_CHANNEL]);
  assert.deepEqual(calls[0]?.values, [request]);
});

test("the preload never forwards a malformed request to the wire", async () => {
  const calls: string[] = [];
  const ipc: FixedProjectViewIpc = {
    on() {}, removeListener() {}, send() {},
    async invoke(channel) {
      calls.push(channel);
      return { ok: true, status: "started" };
    },
  };
  const bridge = createWorkbenchPreloadBridge(ipc);
  const result = await bridge.startAutoIterationSupervisor({ ...request, projectId: "not-a-selection-key" } as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.category, "auto-iteration-unavailable");
  assert.deepEqual(calls, []);
});
