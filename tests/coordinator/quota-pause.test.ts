import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createWorkbenchCoordinator, type ProjectChannel } from "../../src/coordinator/index.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import { createFileClaudeSessionCapabilityStore } from "../../src/agent-runtime/claude/session-capability-store.ts";
import type { ClaudeSessionTransportRequest } from "../../src/agent-runtime/claude/transport.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { quotaAdapter, quotaEndpoint, quotaFrames, quotaProfile, quotaResumedFrames, QuotaReplayTransport } from "../agent-runtime/fixtures/claude-quota-replay.ts";

test("captured GLM initial refusal becomes an idle durable quota pause, not ordinary failure", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw114-"));
  const project = join(root, "p");
  await mkdir(project);
  const transport = new QuotaReplayTransport();
  const adapter = quotaAdapter(transport);
  // A historical catalog supplied locally, never a real catalog/provider probe.
  adapter.inspect = async () => quotaEndpoint.staticCatalog!;
  const channel = await createWorkbenchCoordinator({ databasePath: join(root, "ledger.sqlite"), adapter }).openProject(project);
  registerTestClosable(t, channel);
  await channel.act({
    kind: "direct", commandKind: "start", idempotencyKey: "first-quota-refusal", runtime: "codex",
    catalogRevision: "offline-captured", preferences: { global: quotaProfile }, profile: quotaProfile, input: "initial input",
  });
  let command = (await channel.snapshot()).commands[0];
  const until = Date.now() + 3000;
  while (command.status === "accepted" || command.status === "in-flight") {
    assert.ok(Date.now() < until, "terminal observation did not arrive");
    await new Promise(resolve => setTimeout(resolve, 5));
    command = (await channel.snapshot()).commands[0];
  }
  t.diagnostic(JSON.stringify({ status: command.status, activity: channel.readTurnActivity(), stopCalls: transport.stopped }));
  assert.equal(command.status, "quota-paused");
  assert.equal(channel.readTurnActivity(), "idle");
  assert.equal(transport.stopped, 1);
});

const day = 24 * 60 * 60 * 1000;
const firstObserved = 1_800_000_000_000;

async function fixture(t: TestContext, frames = [quotaFrames, quotaResumedFrames], configure?: (transport: QuotaReplayTransport) => void) {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw114-pause-"));
  const project = join(root, "p"), databasePath = join(root, "ledger.sqlite");
  await mkdir(project);
  const transports: QuotaReplayTransport[] = [];
  const requests: ClaudeSessionTransportRequest[] = [];
  const open = async () => {
    const adapter = new ClaudeAdapter(undefined, async request => {
      requests.push(request);
      const transport = new QuotaReplayTransport(frames[transports.length] ?? quotaResumedFrames);
      configure?.(transport);
      transports.push(transport);
      return transport;
    }, undefined, { readPermissionMode: async () => "manual" }, undefined,
    createFileClaudeSessionCapabilityStore(join(root, "capabilities.json")), quotaEndpoint);
    adapter.inspect = async () => quotaEndpoint.staticCatalog!;
    const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(project);
    registerTestClosable(t, channel);
    return channel;
  };
  const start = (channel: ProjectChannel) => channel.act({ kind: "direct", commandKind: "start", idempotencyKey: "quota",
    runtime: "codex", catalogRevision: "offline", preferences: { global: quotaProfile }, profile: quotaProfile, input: "ORIGINAL_INPUT" });
  const resume = (channel: ProjectChannel, sessionId: string, key = "explicit-resume") => channel.act({
    kind: "direct", commandKind: "continue", idempotencyKey: key, runtime: "codex", targetSessionId: sessionId,
    profile: quotaProfile, input: "NEW_EXPLICIT_INPUT",
  });
  const deadlines = () => {
    const db = new DatabaseSync(databasePath);
    try { return db.prepare("SELECT data_json FROM updates WHERE kind = 'quota-paused' ORDER BY cursor").all().map(row => JSON.parse(row.data_json as string).expiresAt); }
    finally { db.close(); }
  };
  return { root, databasePath, open, start, resume, deadlines, transports, requests };
}

async function terminal(channel: ProjectChannel) {
  const until = performance.now() + 3000;
  while (true) {
    const command = (await channel.snapshot()).commands.at(-1)!;
    if (command.status !== "accepted" && command.status !== "in-flight") return command;
    assert.ok(performance.now() < until, "command did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("quota pause survives a new coordinator and adapter, then only explicit new input resumes the same native Session", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: firstObserved });
  const f = await fixture(t);
  let channel = await f.open();
  await f.start(channel);
  const paused = await terminal(channel);
  assert.equal(paused.status, "quota-paused");
  assert.equal(paused.session?.resumable, true);
  assert.deepEqual(f.deadlines(), [firstObserved + day]);
  const snapshot = await channel.snapshot();
  const updates = [];
  for await (const update of channel.observe({ after: 0 })) {
    updates.push(update);
    if (update.cursor === snapshot.cursor) break;
  }
  assert.equal(updates.at(-1)?.kind, "quota-paused");
  await channel.close();
  t.mock.timers.setTime(firstObserved + day / 2);
  channel = await f.open();
  assert.equal((await terminal(channel)).status, "quota-paused");
  assert.equal(f.transports.length, 1, "reopen must not replay or resume");
  assert.deepEqual(f.deadlines(), [firstObserved + day], "restart does not grant another 24 hours");
  const receipt = await f.resume(channel, paused.session!.sessionId);
  const completed = await terminal(channel);
  assert.equal(completed.status, "completed");
  assert.equal(completed.session?.sessionId, paused.session?.sessionId);
  assert.equal(f.requests[1].resumeSessionIdentity, quotaFrames[0].session_id);
  assert.deepEqual(f.transports[1].sent.filter(frame => frame.type === "user").map(frame => frame.message.content[0].text), ["NEW_EXPLICIT_INPUT"]);
  assert.equal((await f.resume(channel, paused.session!.sessionId)).commandId, receipt.commandId);
  assert.equal(f.transports.length, 2, "idempotent acceptance does not create a retry");
});

for (const reopen of [false, true]) test(`quota expiry is a truthful failure with no provider call; restart=${reopen}`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: firstObserved });
  const f = await fixture(t);
  let channel = await f.open();
  await f.start(channel);
  const paused = await terminal(channel);
  assert.equal(paused.status, "quota-paused");
  if (reopen) await channel.close();
  t.mock.timers.setTime(firstObserved + day);
  if (reopen) channel = await f.open();
  const expired = await terminal(channel);
  assert.equal(expired.status, "failed");
  assert.equal(expired.failureCategory, "quota-expired");
  assert.equal(expired.session?.resumable, false);
  assert.equal(channel.readTurnActivity(), "idle");
  await assert.rejects(f.resume(channel, paused.session!.sessionId), { category: "continuation-unavailable" });
  assert.equal(f.transports.length, 1);
  assert.deepEqual(f.deadlines(), [firstObserved + day]);
});

test("an explicit resume rejected again does not extend the first quota deadline", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: firstObserved });
  const f = await fixture(t, [quotaFrames, quotaFrames]);
  const channel = await f.open();
  await f.start(channel);
  const paused = await terminal(channel);
  assert.equal(paused.status, "quota-paused");
  t.mock.timers.setTime(firstObserved + day / 2);
  await f.resume(channel, paused.session!.sessionId);
  assert.equal((await terminal(channel)).status, "quota-paused");
  assert.deepEqual(f.deadlines(), [firstObserved + day, firstObserved + day]);
  assert.equal(f.transports.length, 2);
});

test("input queued before a quota refusal is not an explicit resume and never starts another transport", async t => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const gate = deferred(), receiving = deferred();
  const f = await fixture(t, [quotaFrames], transport => {
    const receive = transport.receive.bind(transport);
    transport.receive = async () => {
      if (transport.received === 2) { receiving.resolve(); await gate.promise; }
      return receive();
    };
  });
  const channel = await f.open();
  try {
    await f.start(channel);
    await receiving.promise;
    const sessionId = (await channel.snapshot()).commands[0].session!.sessionId;
    await f.resume(channel, sessionId, "queued-before-refusal");
    await f.resume(channel, sessionId, "second-queued-before-refusal");
    gate.resolve();
    await terminal(channel);
    const snapshot = await channel.snapshot();
    assert.deepEqual(snapshot.commands.map(command => command.status), ["failed", "failed", "failed"]);
    assert.equal(f.transports.length, 1);
    assert.deepEqual(f.deadlines(), []);
    await channel.close(); // Drain the scheduled fail-stop gates before checking for duplicate rejection.
    const db = new DatabaseSync(f.databasePath);
    try {
      for (const command of snapshot.commands) {
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM updates WHERE command_id = ? AND kind = 'failed'").get(command.commandId)?.count, 1);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM updates WHERE kind = 'in-flight'").get()?.count, 1);
    } finally { db.close(); }
    const reopened = await f.open();
    assert.deepEqual((await reopened.snapshot()).commands.map(command => command.status), ["failed", "failed", "failed"]);
    assert.equal(f.transports.length, 1, "reopening must not retry rejected queued input");
  } finally { gate.resolve(); }
});

test("incremental snapshots retain paused Session eligibility and expire without a full snapshot", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: firstObserved });
  const f = await fixture(t);
  const channel = await f.open();
  await f.start(channel);
  assert.equal((await terminal(channel)).status, "quota-paused");
  const paused = await channel.snapshotChanges!(0);
  assert.equal(paused.commands[0].session?.resumable, true);
  assert.equal(paused.sessions[0].resumable, true, "incremental shared state must not overwrite the pause eligibility");
  t.mock.timers.setTime(firstObserved + day);
  const expired = await channel.snapshotChanges!(paused.cursor);
  assert.ok(expired.cursor > paused.cursor);
  assert.equal(expired.commands[0].status, "failed");
  assert.equal(expired.commands[0].failureCategory, "quota-expired");
  assert.equal(expired.sessions[0].resumable, false);
  assert.equal(f.transports.length, 1);
});

test("a paused Session cannot change its profile while resuming", async t => {
  const f = await fixture(t);
  const channel = await f.open();
  await f.start(channel);
  const paused = await terminal(channel);
  const profile = { ...quotaProfile, effortLevel: "low" };
  assert.deepEqual(await channel.validateContinuationProfile({ sessionId: paused.session!.sessionId, profile }), { status: "incompatible" });
  await assert.rejects(channel.act({ kind: "direct", commandKind: "continue", idempotencyKey: "changed-profile",
    runtime: "codex", targetSessionId: paused.session!.sessionId, profile, input: "explicit" }), { category: "continuation-unavailable" });
  assert.equal(f.transports.length, 1);
});

test("expiry of a successfully resumed historical pause does not stop later queued work", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: firstObserved });
  let release!: () => void, receiving!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { receiving = resolve; });
  let opened = 0;
  const f = await fixture(t, [quotaFrames, quotaResumedFrames, quotaResumedFrames, quotaResumedFrames], transport => {
    if (++opened !== 3) return;
    const receive = transport.receive.bind(transport);
    transport.receive = async () => {
      if (transport.received === 2) { receiving(); await gate; }
      return receive();
    };
  });
  const channel = await f.open();
  try {
    await f.start(channel);
    const paused = await terminal(channel);
    await f.resume(channel, paused.session!.sessionId);
    assert.equal((await terminal(channel)).status, "completed");
    await f.resume(channel, paused.session!.sessionId, "later-running");
    await entered;
    await f.resume(channel, paused.session!.sessionId, "later-queued");
    t.mock.timers.setTime(firstObserved + day);
    await channel.snapshot(); // Materialize the old pause's deadline while the new turn runs.
    release();
    const completed = await terminal(channel);
    assert.equal(completed.status, "completed", "an old quota deadline must not reject input queued after successful resume");
    assert.equal(f.transports.length, 4);
  } finally { release(); }
});

test("quota resume accepted before expiry but still queued at expiry never opens a transport", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: firstObserved });
  let release!: () => void, receiving!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { receiving = resolve; });
  let opened = 0;
  const f = await fixture(t, [quotaFrames, quotaResumedFrames], transport => {
    if (++opened !== 2) return;
    const receive = transport.receive.bind(transport);
    transport.receive = async () => {
      if (transport.received === 2) { receiving(); await gate; }
      return receive();
    };
  });
  const channel = await f.open();
  try {
    await f.start(channel);
    const paused = await terminal(channel);
    await channel.act({ kind: "direct", commandKind: "start", idempotencyKey: "other-session",
      runtime: "codex", catalogRevision: "offline", preferences: { global: quotaProfile }, profile: quotaProfile, input: "UNRELATED_INPUT" });
    await entered;
    const resume = await f.resume(channel, paused.session!.sessionId);
    t.mock.timers.setTime(firstObserved + day);
    release();
    // No snapshot read or expiry timer wakes execution: the dispatch boundary
    // must enforce the absolute deadline even when the timer is delayed.
    for await (const update of channel.observe({ after: resume.acceptedCursor })) {
      if (update.commandId === resume.commandId && update.status !== "accepted" && update.status !== "in-flight") break;
    }
    assert.equal(f.transports.length, 2, "an expired, unsent quota resume is not exempt from fail-stop");
    assert.equal((await terminal(channel)).status, "failed");
    assert.equal((await channel.snapshot()).commands[0].failureCategory, "quota-expired");
  } finally { release(); }
});
