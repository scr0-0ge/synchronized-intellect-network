import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { replayUsage } from "../agent-runtime/claude-usage-replay.ts";
import { createWorkbenchAppearancePreferenceStore } from "../../src/workbench-shell/appearance-preference-store.ts";
import {
  reconstructWorkbenchSubscriptionUsage,
  reconstructWorkbenchUsageObservation,
  reconstructWorkbenchUsageObservations,
  sanitizeWorkbenchSubscriptionUsageResult,
} from "../../src/workbench-shell/result-sanitizer.ts";
import { defaultWorkbenchAppearancePreference, defaultWorkbenchRuntimeExecutablePaths,
  WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL as load, WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL as changed } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchPreloadBridge } from "../../src/workbench-shell/preload-bridge.ts";
import { installWorkbenchSubscriptionUsageIpc } from "../../src/workbench-shell/electron/subscription-usage-ipc.ts";

const observation = { five_hour: { utilization: 0, resetsAt: 1788888000 }, seven_day: null, observedAt: 1788880000000 };
const glmUsageObservation = Object.freeze({
  endpointKey: "glm", windows: [{ label: "quota-window" as const, resetsAt: 1788888000000 }],
  observedAt: 1788880000000, source: "exhaustion-message" as const,
});

test("real wire persists globally across Projects/reopen and other settings writes, without changing observation time or schema", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw123-usage-"));
  const filePath = join(root, "preferences.json");
  const store = createWorkbenchAppearancePreferenceStore({ filePath });
  registerTestClosable(t, store);
  assert.equal(await store.readClaudeSubscriptionUsage(), null);
  await replayUsage("claude-web", async value => { await store.saveClaudeSubscriptionUsage(value); });
  const first = await store.readClaudeSubscriptionUsage();
  assert.ok(first);
  assert.equal(first.five_hour?.utilization, 0.5);
  // A second Project uses the same endpoint store, not its own Project ledger.
  const second = { ...first, observedAt: first.observedAt + 1000, five_hour: { ...first.five_hour!, utilization: 0.8 } };
  await Promise.all([
    store.saveClaudeSubscriptionUsage(second),
    store.save(defaultWorkbenchAppearancePreference),
    store.saveEndpointPreference("claude-api"),
    store.saveClaudePermissionHandling("ask-when-needed"),
    store.saveRuntimeExecutables(defaultWorkbenchRuntimeExecutablePaths),
  ]);
  assert.deepEqual(await store.saveClaudeSubscriptionUsage(first), second, "late older observation cannot roll back the snapshot");
  await store.close();
  const reopened = createWorkbenchAppearancePreferenceStore({ filePath });
  registerTestClosable(t, reopened);
  assert.deepEqual(await reopened.readClaudeSubscriptionUsage(), second);
  const document = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(document.schemaVersion, 10);
  assert.deepEqual(document.claudeSubscriptionUsage, second);
  assert.equal(document.endpointPreference.claude, "claude-api");
});

test("the GLM/Kimi/DeepSeek usage slot is keyed by endpointKey, survives restart, and rejects a stale write", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw234-usage-"));
  const filePath = join(root, "preferences.json");
  const store = createWorkbenchAppearancePreferenceStore({ filePath });
  registerTestClosable(t, store);
  assert.deepEqual(await store.readUsageObservations(), {});
  await store.saveUsageObservation(glmUsageObservation);
  const kimiObservation = Object.freeze({ ...glmUsageObservation, endpointKey: "kimi" });
  await store.saveUsageObservation(kimiObservation);
  assert.deepEqual(await store.readUsageObservations(), {
    glm: glmUsageObservation, kimi: kimiObservation,
  });
  // Claude's own field is untouched by the generic slot.
  assert.equal(await store.readClaudeSubscriptionUsage(), null);
  const staleGlm = Object.freeze({ ...glmUsageObservation, observedAt: glmUsageObservation.observedAt - 1000 });
  assert.deepEqual(await store.saveUsageObservation(staleGlm), glmUsageObservation, "an older observedAt for the same endpointKey cannot roll back the snapshot");
  await store.close();
  const reopened = createWorkbenchAppearancePreferenceStore({ filePath });
  registerTestClosable(t, reopened);
  assert.deepEqual(await reopened.readUsageObservations(), { glm: glmUsageObservation, kimi: kimiObservation });
  const document = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(document.schemaVersion, 10);
  assert.deepEqual(document.usageObservations, { glm: glmUsageObservation, kimi: kimiObservation });
});

test("an empty usage-observation map is omitted from the written document, not written as {}", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw234-usage-empty-"));
  const filePath = join(root, "preferences.json");
  const store = createWorkbenchAppearancePreferenceStore({ filePath });
  registerTestClosable(t, store);
  await store.save(defaultWorkbenchAppearancePreference);
  await store.close();
  const document = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal("usageObservations" in document, false);
});

test("unknown and real zero are distinct, and malformed or raw vendor data never crosses the snapshot boundary", () => {
  assert.deepEqual(reconstructWorkbenchSubscriptionUsage(observation), observation);
  assert.equal(reconstructWorkbenchSubscriptionUsage(observation)?.seven_day, null);
  for (const value of [
    { ...observation, observedAt: undefined }, { ...observation, observedAt: NaN },
    { ...observation, observedAt: Infinity }, { ...observation, session_id: "private" },
    { ...observation, five_hour: { utilization: 5, resetsAt: 1788888000 } },
    { ...observation, five_hour: { utilization: 0.3, resetsAt: -1 } },
    { ...observation, five_hour: { ...observation.five_hour, status: "allowed" } },
  ]) assert.equal(reconstructWorkbenchSubscriptionUsage(value), undefined);
  assert.deepEqual(
    sanitizeWorkbenchSubscriptionUsageResult({ ok: true, observation: null, usage: {} }),
    { ok: true, observation: null, usage: {} },
  );
  assert.deepEqual(
    sanitizeWorkbenchSubscriptionUsageResult({ ok: true, observation, usage: {}, raw: "private" }),
    { ok: false },
  );
  assert.deepEqual(
    sanitizeWorkbenchSubscriptionUsageResult({ ok: true, observation: null, usage: { glm: glmUsageObservation } }),
    { ok: true, observation: null, usage: { glm: glmUsageObservation } },
  );
});

test("the generic usage-observation shape is reconstructed exactly, and mismatches/malformed windows never cross the boundary", () => {
  assert.deepEqual(reconstructWorkbenchUsageObservation(glmUsageObservation), glmUsageObservation);
  for (const value of [
    { ...glmUsageObservation, endpointKey: "" },
    { ...glmUsageObservation, source: "polling" },
    { ...glmUsageObservation, observedAt: -1 },
    { ...glmUsageObservation, windows: [{ label: "not-a-real-label", resetsAt: 1 }] },
    { ...glmUsageObservation, windows: [{ label: "quota-window", utilization: 1.5 }] },
    { ...glmUsageObservation, windows: [{ label: "quota-window", resetsAt: 1, extra: "field" }] },
    { ...glmUsageObservation, session_id: "private" },
  ]) assert.equal(reconstructWorkbenchUsageObservation(value), undefined);
  assert.deepEqual(reconstructWorkbenchUsageObservations({ glm: glmUsageObservation }), { glm: glmUsageObservation });
  assert.equal(reconstructWorkbenchUsageObservations({ glm: { ...glmUsageObservation, endpointKey: "kimi" } }), undefined, "a value's own endpointKey must match its map key");
  assert.equal(reconstructWorkbenchUsageObservations({ glm: { ...glmUsageObservation, extra: "field" } }), undefined);
});

test("preload reads storage once, accepts passive pushes, rejects stale initial reads and disposes its listener", async () => {
  let finish!: (value: unknown) => void;
  const reads: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const bridge = createWorkbenchPreloadBridge({
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel) { listeners.delete(channel); }, send() {},
    invoke(channel) { reads.push(channel); return new Promise(resolve => { finish = resolve; }); },
  });
  const results: unknown[] = [];
  const dispose = bridge.observeSubscriptionUsage!(result => { results.push(result); });
  assert.deepEqual(reads, [load]);
  listeners.get(changed)!({}, { ok: true, observation, usage: {} });
  finish({ ok: true, observation: null, usage: {} });
  await Promise.resolve();
  assert.deepEqual(results, [{ ok: true, observation, usage: {} }]);
  const late = listeners.get(changed)!;
  dispose();
  late({}, { ok: false });
  assert.equal(results.length, 1);
  assert.equal(listeners.has(changed), false);
  assert.equal(reads.length, 1);
});

test("usage IPC only reads for its owning live renderer and stops publishing on close", async () => {
  let handler!: (...values: unknown[]) => any;
  const lifecycle = new Map<string, (...values: unknown[]) => unknown>();
  const sent: unknown[] = [];
  let reads = 0;
  const sender = { isDestroyed: () => false, send: (_: string, value: unknown) => { sent.push(value); },
    on: (event: string, callback: (...values: unknown[]) => unknown) => { lifecycle.set(event, callback); },
    removeListener: (event: string) => { lifecycle.delete(event); } };
  const binding = installWorkbenchSubscriptionUsageIpc({
    ipcMain: { handle(_, listener) { handler = listener; }, removeHandler() {} },
    window: { webContents: sender, on: sender.on, removeListener: sender.removeListener },
    source: {
      async readClaudeSubscriptionUsage() { reads++; return observation; },
      async readUsageObservations() { return { glm: glmUsageObservation }; },
    },
  });
  assert.deepEqual(await handler({ sender: {} }), { ok: false });
  assert.deepEqual(await handler({ sender }, "extra"), { ok: false });
  assert.equal(reads, 0);
  assert.deepEqual(await handler({ sender }), { ok: true, observation, usage: { glm: glmUsageObservation } });
  binding.publish({ ok: true, observation, usage: { glm: glmUsageObservation } });
  assert.equal(sent.length, 1);
  lifecycle.get("closed")!();
  binding.publish({ ok: true, observation, usage: { glm: glmUsageObservation } });
  assert.deepEqual(await handler({ sender }), { ok: false });
  assert.equal(sent.length, 1);
  binding.dispose();
  assert.equal(lifecycle.size, 0);
});
