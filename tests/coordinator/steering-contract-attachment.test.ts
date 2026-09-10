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
  model: "glm-4.6",
  effortLevel: "default",
  executionMode: "single-agent",
  accessMode: "full-access",
});

/**
 * A Runtime with no same-turn steering contract -- the shape every Claude
 * transport endpoint has, GLM and deepseek among them: neither `steer` nor
 * `steerAvailability` is present at all. `start` is held open so the window
 * between accepting the command and attaching its binding, which is real
 * process-spawn latency in the product, can be observed exactly.
 */
class HeldUnsteerableAdapter implements ResumableAgentRuntimeAdapter {
  private releaseStart!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });
  private releaseTerminal!: () => void;
  private readonly terminal = new Promise<void>((resolve) => {
    this.releaseTerminal = resolve;
  });

  attach(): void {
    this.releaseStart();
  }

  finish(): void {
    this.releaseTerminal();
  }

  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "claude",
      models: [{ id: profile.model, effortLevels: [profile.effortLevel] }],
      executionModes: [profile.executionMode],
      accessModes: [profile.accessMode],
    };
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    await this.started;
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: "private-unsteerable-session",
      async send(input: RuntimeInput): Promise<void> {
        assert.deepEqual(input, { text: "Find one news story from Wuhan." });
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        await adapter.terminal;
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    throw new Error("PRIVATE_RESUME_MUST_NOT_RUN");
  }
}

test(
  "steering support is unknown until the Runtime binding attaches, then reported once and for all",
  async (t) => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "steering-contract-attachment-"),
    );
    const projectDirectory = join(temporaryDirectory, "project");
    const databasePath = join(temporaryDirectory, "ledger.sqlite");
    await mkdir(projectDirectory);
    const adapter = new HeldUnsteerableAdapter();
    const channel = await createWorkbenchCoordinator({
      databasePath,
      adapter,
    }).openProject(projectDirectory);
    t.after(async () => {
      adapter.attach();
      adapter.finish();
      await channel.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    });

    const receipt = await channel.act({
      kind: "direct",
      commandKind: "start",
      idempotencyKey: "steering-contract-attachment",
      // The durable command tag; the Runtime under test is identified by the
      // binding it produces, which carries no steering member at all.
      runtime: "codex",
      profile,
      input: "Find one news story from Wuhan.",
      catalogRevision: "synthetic-catalog",
      preferences: { global: profile },
    });

    // While the binding is being established the Coordinator answers with the
    // command's own not-yet-known states. It cannot yet say `unsupported`,
    // because nothing has asked the Runtime.
    const held = await waitForSteerCapability(channel, "pending");
    assert.deepEqual(held, { status: "pending", commandId: receipt.commandId });

    // Issue #6 case 6: the flip. Availability is not a timer -- it becomes
    // false the moment the attached binding is asked and turns out to carry no
    // steering member at all.
    adapter.attach();
    const attached = await waitForSteerCapability(channel, "unsupported");
    assert.deepEqual(attached, {
      status: "unsupported",
      commandId: receipt.commandId,
    });

    assert.deepEqual(
      await channel.steerActiveTurn!({
        commandId: receipt.commandId,
        input: "Find one from Tianshui instead.",
      }),
      { status: "unsupported" },
    );

    adapter.finish();
    await waitForCompletion(channel);
    const snapshot = await channel.snapshot();
    assert.equal(snapshot.commands.length, 1);
    assert.deepEqual(snapshot.commands[0]?.session?.events, [
      { kind: "session-started" },
      { kind: "turn-started" },
      { kind: "turn-completed", status: "completed" },
    ]);
  },
);

async function waitForSteerCapability(
  channel: ProjectChannel,
  status: ProjectSteerCapability["status"],
): Promise<ProjectSteerCapability> {
  let lastCapability: ProjectSteerCapability | undefined;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const capability = channel.readSteerCapability?.();
    lastCapability = capability;
    if (capability?.status === status) return capability;
    assert.notEqual(
      capability?.status,
      "unsupported",
      `steering support must not be claimed before the binding attaches; saw ${JSON.stringify(lastCapability)}`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(
    `Timed out waiting for steer capability ${status}; last=${JSON.stringify(lastCapability)}.`,
  );
}

async function waitForCompletion(channel: ProjectChannel): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await channel.snapshot();
    if (snapshot.commands[0]?.status === "completed") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the unsteerable turn to complete.");
}
