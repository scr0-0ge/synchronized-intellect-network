import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CoordinatorError, createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { appFailureProject, continuation, terminal, profile } from "../helpers/no-app-lockout.ts";

for (const stage of ["send", "events", "storage"] as const) {
  test(`app ${stage} failure leaves the same CLI Session usable without replaying the unknown turn`, async t => {
    const root = await createTestDirectory(t, join(tmpdir(), "uaw148-"));
    const { channel, open, command, databasePath, transports } = await appFailureProject(t, root, stage);
    const sessionId = command.session!.sessionId;
    // Exercise the reported symptom first: the old implementation rejects here.
    const receipt = await channel.act(continuation(sessionId));
    await terminal(channel, receipt.commandId);
    assert.equal(command.session!.resumable, true);
    assert.equal(channel.readTurnActivity(), "unknown", "historical uncertainty still protects removal and close");
    const snapshot = await channel.snapshot();
    assert.deepEqual(snapshot.commands.map(row => row.status), ["recovery-required", "completed"]);
    assert.equal(snapshot.commands[1]?.session?.sessionId, sessionId);
    assert.ok(snapshot.commands[1]?.session?.events.some(event => event.kind === "agent-message" && event.text === "RESUMED_MARKER"));
    const probeMethods = transports[2]!.recordedOutboundJsonl().map(line => JSON.parse(line).method);
    assert.ok(probeMethods.includes("thread/resume"), "continuability comes from a real adapter handshake");
    assert.ok(!probeMethods.includes("turn/start"), "the probe does not resend the unknown input");
    assert.equal(transports[2]!.recordedStopCalls(), 1, "the probe releases its transport");
    await channel.close();
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual({ ...reader.prepare("SELECT status, outcome_uncertain FROM commands WHERE command_id = ?").get(command.commandId) }, { status: "recovery-required", outcome_uncertain: 1 });
    } finally { reader.close(); }
    const reopened = await open();
    registerTestClosable(t, reopened);
    assert.deepEqual((await reopened.snapshot()).commands.map(row => row.status), ["recovery-required", "completed"]);
  });
}

test("CLI resume refusal still locks the Session and retains unknown outcome", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw148-refusal-"));
  const { channel, command } = await appFailureProject(t, root, "send", true);
  assert.equal(command.session!.resumable, false);
  await assert.rejects(channel.act(continuation(command.session!.sessionId)), error => error instanceof CoordinatorError && error.category === "continuation-unavailable");
  assert.deepEqual(command.recovery, { resume: "unconfirmed", reason: "protocol-rejected" });
});

test("reopening measures a formerly blocked Session again without replaying its unknown input", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw148-reopen-"));
  const { channel, open, command, allowResume, transports } = await appFailureProject(t, root, "send", true);
  await channel.close();
  allowResume();
  const reopened = await open();
  registerTestClosable(t, reopened);
  const deadline = Date.now() + 2000;
  while (!(await reopened.snapshot()).commands[0]?.session?.resumable && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const restored = (await reopened.snapshot()).commands[0]!;
  assert.equal(restored.status, "recovery-required");
  assert.equal(restored.session?.resumable, true, "reopening must not preserve an app lockout after CLI resume succeeds");
  const methods = transports.at(-1)!.recordedOutboundJsonl().map(line => JSON.parse(line).method);
  assert.ok(methods.includes("thread/resume"));
  assert.ok(!methods.includes("turn/start"));
  const receipt = await reopened.act(continuation(command.session!.sessionId));
  await terminal(reopened, receipt.commandId);
  assert.deepEqual((await reopened.snapshot()).commands.map(row => row.status), ["recovery-required", "completed"]);
});

test("an app exception while binding a continuation is not itself a CLI resume refusal", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw148-resume-"));
  const { channel, command, failNextResume } = await appFailureProject(t, root, "send");
  failNextResume();
  const sessionId = command.session!.sessionId;
  const unknown = await channel.act(continuation(sessionId));
  await terminal(channel, unknown.commandId);
  const next = await channel.act({ ...continuation(sessionId), idempotencyKey: "after-binding-exception" });
  await terminal(channel, next.commandId);
  assert.deepEqual((await channel.snapshot()).commands.map(row => row.status), ["recovery-required", "recovery-required", "completed"]);
});

test("an unsent Claude resume probe is actually stopped rather than leaking its transport", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw148-claude-"));
  let probeStops = 0;
  let probeSends = 0;
  const channel = await createWorkbenchCoordinator({ databasePath: join(root, "ledger.sqlite"), adapter: {
    async inspect() { return { runtime: "claude", models: [{ id: profile.model, effortLevels: [profile.effortLevel] }], executionModes: [profile.executionMode], accessModes: [profile.accessMode] }; },
    async start() { return { profile, opaqueSessionReference: "claude-session", async send() { throw new Error("APP_SEND_FAILURE"); }, async *events() {} }; },
    async resume() {
      return new ClaudeRuntimeBinding({ profile, opaqueSessionReference: "claude-session", expectedModel: profile.model, stopHookCallbackId: "offline", observeSessionIdentity() {}, permissionMode: "manual", ultracodeConfirmed: false,
        transport: { async send() { probeSends += 1; }, async receive() { throw new Error("The probe must not run a turn"); }, async stop() { probeStops += 1; } } });
    },
  } }).openProject(root);
  registerTestClosable(t, channel);
  const receipt = await channel.act({ kind: "direct", commandKind: "start", runtime: "codex", idempotencyKey: "claude-cleanup", catalogRevision: "offline", preferences: { global: profile }, profile, input: "offline cleanup" });
  await terminal(channel, receipt.commandId);
  assert.equal((await channel.snapshot()).commands[0]?.session?.resumable, true);
  assert.equal(probeSends, 0);
  assert.equal(probeStops, 1, "return() on an unstarted async generator does not release the actual Claude binding");
});
