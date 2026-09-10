import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchCoordinator,
  type CommandReceipt,
  type ProjectChannel,
} from "../../src/coordinator/index.ts";

const profile: SessionProfile = {
  model: "gpt-5.6-sol",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
};

for (const outcome of ["failed", "interrupted", "unknown-confirmed", "unknown-unconfirmed", "completed"] as const) {
test(`queued continuations stop after ${outcome}, but not after completed`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-queued-failure-"));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const sent: string[] = [];
  const started = deferred();
  const release = deferred();
  const adapter: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return {
        runtime: "codex", models: [{ id: profile.model, effortLevels: ["high"] }],
        executionModes: ["single-agent"], accessModes: ["full-access"],
      };
    },
    async start() {
      return {
        profile, opaqueSessionReference: "queued-failure-session",
        async send(input) { sent.push(input.text); },
        async *events(): AsyncIterable<NormalizedRuntimeEvent> {
          yield { kind: "session-started" };
          yield { kind: "turn-started" };
          started.resolve();
          await release.promise;
          if (outcome.startsWith("unknown")) throw new Error("app-observation-lost");
          if (outcome === "failed") yield { kind: "failed", category: "turn-failed" };
          else if (outcome === "interrupted") yield { kind: "turn-interrupted", status: "interrupted" };
          else yield { kind: "turn-completed", status: "completed" };
        },
      };
    },
    async resume() {
      if (outcome === "unknown-unconfirmed") throw new Error("resume-refused");
      return {
        profile, opaqueSessionReference: "queued-failure-session",
        async send(input) { sent.push(input.text); },
        async *events(): AsyncIterable<NormalizedRuntimeEvent> {
          yield { kind: "turn-started" };
          yield { kind: "turn-completed", status: "completed" };
        },
      };
    },
  };
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "ledger.sqlite"), adapter,
  }).openProject(projectDirectory);
  t.after(async () => {
    release.resolve();
    await channel.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await channel.act({
    kind: "direct", commandKind: "start", idempotencyKey: "first", runtime: "codex",
    catalogRevision: "queued-failure-catalog", preferences: { global: profile }, profile,
    input: "first input",
  });
  await started.promise;
  const sessionId = (await channel.snapshot()).commands[0]?.session?.sessionId;
  assert.ok(sessionId);
  const queued = await channel.act({
    kind: "direct", commandKind: "continue", idempotencyKey: "queued", runtime: "codex",
    targetSessionId: sessionId, profile, input: "must not be sent after failure",
  });
  assert.equal((await channel.snapshot()).commands[1]?.status, "accepted");
  const secondQueued = await channel.act({
    kind: "direct", commandKind: "continue", idempotencyKey: "second-queued", runtime: "codex",
    targetSessionId: sessionId, profile, input: "second queued input",
  });
  release.resolve();
  assert.equal((await terminalCommand(channel, first)).status,
    outcome.startsWith("unknown") ? "recovery-required" : outcome === "completed" ? "completed" : "failed");
  const stopped = await terminalCommand(channel, queued);
  const alsoStopped = await terminalCommand(channel, secondQueued);
  assert.deepEqual(sent, outcome === "completed"
    ? ["first input", "must not be sent after failure", "second queued input"] : ["first input"]);
  assert.equal(stopped.status, outcome === "completed" ? "completed" : "failed");
  assert.equal(alsoStopped.status, stopped.status);
  if (outcome !== "completed") {
    assert.equal(stopped.session?.events.length, 0, "unsent queue entries have no invented Runtime event");
  }
  if (outcome === "interrupted" || outcome === "unknown-confirmed") {
    const human = await channel.act({
      kind: "direct", commandKind: "continue", idempotencyKey: "deliberate-human", runtime: "codex",
      targetSessionId: sessionId, profile, input: "human takes responsibility for the next turn",
    });
    assert.equal((await terminalCommand(channel, human)).status, "completed");
    assert.deepEqual(sent, ["first input", "human takes responsibility for the next turn"]);
  }
  if (outcome.startsWith("unknown")) {
    const original = (await channel.snapshot()).commands[0]!;
    assert.equal(original.status, "recovery-required", "fresh resume never turns an unknown outcome into success");
    assert.equal(original.recovery?.resume, outcome === "unknown-confirmed" ? "confirmed" : "unconfirmed");
  }
});
}

async function terminalCommand(channel: ProjectChannel, receipt: CommandReceipt) {
  const snapshot = await channel.snapshot();
  const current = snapshot.commands.find((command) => command.commandId === receipt.commandId);
  if (current && current.status !== "accepted" && current.status !== "in-flight") return current;
  for await (const update of channel.observe({ after: snapshot.cursor })) {
    if (update.commandId !== receipt.commandId ||
        update.status === "accepted" || update.status === "in-flight") continue;
    const terminal = (await channel.snapshot()).commands.find((command) => command.commandId === receipt.commandId);
    assert.ok(terminal);
    return terminal;
  }
  throw new Error("channel closed before terminal state");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
