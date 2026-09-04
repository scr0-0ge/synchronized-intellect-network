import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchCoordinator,
  type ProjectChannel,
  type ProjectSteerCapability,
} from "../../src/coordinator/index.ts";

const profile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

class SteerableTurnAdapter implements ResumableAgentRuntimeAdapter {
  readonly steers: RuntimeInput[] = [];
  private turnStarted = false;
  private terminal = false;
  private resolveSteered!: () => void;
  private readonly steered = new Promise<void>((resolve) => {
    this.resolveSteered = resolve;
  });

  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "codex",
      models: [{ id: profile.model, effortLevels: [profile.effortLevel] }],
      executionModes: [profile.executionMode],
      accessModes: [profile.accessMode],
    };
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: "private-steer-session",
      async send(input: RuntimeInput): Promise<void> {
        assert.deepEqual(input, { text: "Inspect the migration." });
      },
      steerAvailability() {
        return adapter.turnStarted && !adapter.terminal
          ? ("available" as const)
          : ("unavailable" as const);
      },
      async steer(input: RuntimeInput): Promise<void> {
        adapter.steers.push(Object.freeze({ ...input }));
        adapter.resolveSteered();
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        adapter.turnStarted = true;
        yield { kind: "turn-started" };
        await adapter.steered;
        yield {
          kind: "agent-message",
          text: "GUIDANCE_APPLIED_IN_SAME_COORDINATOR_TURN",
        };
        adapter.terminal = true;
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    throw new Error("PRIVATE_RESUME_MUST_NOT_RUN");
  }
}

test("ProjectChannel steers only the exact active command and creates no second command", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "running-turn-steer-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  const adapter = new SteerableTurnAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  t.after(async () => {
    await channel.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const receipt = await channel.act({
    kind: "direct",
    commandKind: "start",
    idempotencyKey: "running-turn-steer",
    runtime: "codex",
    profile,
    input: "Inspect the migration.",
    catalogRevision: "synthetic-catalog",
    preferences: { global: profile },
  });
  const available = await waitForSteerCapability(channel, "available");
  assert.deepEqual(available, {
    status: "available",
    commandId: receipt.commandId,
  });

  assert.deepEqual(
    await channel.steerActiveTurn!({
      commandId: receipt.commandId,
      input: "Use the safer migration.",
    }),
    { status: "accepted" },
  );
  assert.deepEqual(adapter.steers, [{ text: "Use the safer migration." }]);
  assert.deepEqual(
    await channel.steerActiveTurn!({
      commandId: receipt.commandId,
      input: "Forged wider request",
      extra: "PRIVATE_AUTHORITY",
    } as never),
    { status: "unavailable" },
  );
  assert.equal(adapter.steers.length, 1);

  await waitForTerminal(channel);
  const snapshot = await channel.snapshot();
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0]?.input, "Inspect the migration.");
  assert.deepEqual(snapshot.commands[0]?.session?.events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "user-message", text: "Use the safer migration." },
    {
      kind: "agent-message",
      text: "GUIDANCE_APPLIED_IN_SAME_COORDINATOR_TURN",
    },
    { kind: "turn-completed", status: "completed" },
  ]);
});

async function waitForSteerCapability(
  channel: ProjectChannel,
  status: ProjectSteerCapability["status"],
): Promise<ProjectSteerCapability> {
  let lastCapability: ProjectSteerCapability | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const capability = channel.readSteerCapability?.();
    lastCapability = capability;
    if (capability?.status === status) return capability;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(
    `Timed out waiting for steer capability ${status}; last=${JSON.stringify(lastCapability)} snapshot=${JSON.stringify(await channel.snapshot())}.`,
  );
}

async function waitForTerminal(channel: ProjectChannel): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await channel.snapshot();
    if (snapshot.commands[0]?.status === "completed") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the steered turn to complete.");
}
