import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  CoordinatorError,
  createWorkbenchCoordinator,
  type CommandReceipt,
  type ProjectChannel,
} from "../../src/coordinator/index.ts";

const profile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const catalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({ id: profile.model, effortLevels: Object.freeze([profile.effortLevel]) }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const completedEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({ kind: "agent-message" as const, text: "REMOVAL_TEST_REPLY" }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

function startCommand(idempotencyKey: string) {
  return Object.freeze({
    kind: "direct" as const,
    commandKind: "start" as const,
    idempotencyKey,
    runtime: "codex" as const,
    catalogRevision: "removal-catalog-v1",
    preferences: Object.freeze({ global: profile }),
    profile,
    input: "Create a removable Session.",
  });
}

class CompletingAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    return this.binding();
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return this.binding();
  }

  protected binding(): ResumableRuntimeBinding {
    return Object.freeze({
      profile,
      opaqueSessionReference: "removal-test-session-reference",
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        for (const event of completedEvents) yield structuredClone(event);
      },
    });
  }
}

class HeldAdapter extends CompletingAdapter {
  private releaseEvents!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseEvents = resolve;
  });

  release(): void {
    this.releaseEvents();
  }

  protected override binding(): ResumableRuntimeBinding {
    const released = this.released;
    return Object.freeze({
      profile,
      opaqueSessionReference: "held-removal-test-session-reference",
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        await released;
        yield { kind: "turn-completed", status: "completed" };
      },
    });
  }
}

class OutcomeUnknownAdapter extends CompletingAdapter {
  protected override binding(): ResumableRuntimeBinding {
    return Object.freeze({
      profile,
      opaqueSessionReference: "outcome-unknown-removal-test-reference",
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
      },
    });
  }
}

async function waitForTerminal(channel: ProjectChannel, receipt: CommandReceipt) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const command = (await channel.snapshot()).commands.find(
      (candidate) => candidate.commandId === receipt.commandId,
    );
    if (
      command !== undefined &&
      !["accepted", "in-flight"].includes(command.status)
    ) {
      return command;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Session did not reach a terminal state.");
}

async function waitForInFlight(channel: ProjectChannel): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (channel.readTurnActivity() === "in-flight") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Session did not enter in-flight state.");
}

test("a removed Session and all of its commands stay absent after reopening", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-removal-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "project.sqlite");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDirectory));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const receipt = await first.act(startCommand("removable-session"));
  const terminal = await waitForTerminal(first, receipt);
  const sessionId = terminal.session?.sessionId;
  assert.ok(sessionId);

  assert.deepEqual(await first.removeSession({ sessionId }), {
    status: "removed",
  });
  assert.deepEqual((await first.snapshot()).commands, []);
  assert.deepEqual(await first.removeSession({ sessionId }), {
    status: "not-found",
  });
  await first.close();

  const durable = new DatabaseSync(databasePath, { readOnly: true });
  for (const table of ["commands", "sessions", "updates"] as const) {
    const row = durable.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    };
    assert.equal(Number(row.count), 0, `${table} content rows`);
  }
  durable.close();

  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  assert.deepEqual((await reopened.snapshot()).commands, []);
  await assert.rejects(
    reopened.act({
      kind: "direct",
      commandKind: "continue",
      idempotencyKey: "cannot-continue-removed-session",
      runtime: "codex",
      targetSessionId: sessionId,
      profile,
      input: "This must not resurrect deleted content.",
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.category === "continuation-unavailable",
  );
  await reopened.close();
});

test("Session display numbering restarts at one after every Session is removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-renumber-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "project.sqlite");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDirectory));
  t.after(() => rm(root, { recursive: true, force: true }));

  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);

  const seeded = await channel.act(startCommand("seed-numbering"));
  const seededTerminal = await waitForTerminal(channel, seeded);
  assert.equal(
    seededTerminal.session?.displayName,
    "Create a removable Session.",
    "fresh store automatic name",
  );
  const seededDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const seededOrdinal = seededDatabase
    .prepare("SELECT display_ordinal FROM sessions WHERE session_id = ?")
    .get(seededTerminal.session!.sessionId) as
    | { readonly display_ordinal: number }
    | undefined;
  seededDatabase.close();
  assert.equal(Number(seededOrdinal?.display_ordinal), 1, "fresh store display ordinal");
  assert.deepEqual(
    await channel.removeSession({ sessionId: seededTerminal.session!.sessionId }),
    { status: "removed" },
  );
  await channel.close();

  const emptied = new DatabaseSync(databasePath, { readOnly: true });
  for (const table of ["commands", "sessions", "updates"] as const) {
    const row = emptied.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      readonly count: number;
    };
    assert.equal(Number(row.count), 0, `${table} is empty before replacement`);
  }
  const durableSequence = emptied
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'updates'")
    .get() as { readonly seq: number } | undefined;
  assert.ok(Number(durableSequence?.seq) > 0, "the update sequence survives row deletion");
  emptied.close();

  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const replacement = await reopened.act(startCommand("replacement-numbering"));
  const replacementTerminal = await waitForTerminal(reopened, replacement);
  assert.equal(
    replacementTerminal.session?.displayName,
    "Create a removable Session.",
    "post-deletion automatic name",
  );
  const replacementDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const replacementOrdinal = replacementDatabase
    .prepare("SELECT display_ordinal FROM sessions WHERE session_id = ?")
    .get(replacementTerminal.session!.sessionId) as
    | { readonly display_ordinal: number }
    | undefined;
  replacementDatabase.close();
  assert.equal(
    Number(replacementOrdinal?.display_ordinal),
    1,
    "post-deletion display ordinal",
  );
  await reopened.close();
});

test("removing a Session with work in flight returns blocked and never interrupts it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-removal-active-"));
  const projectDirectory = join(root, "Project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDirectory));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new HeldAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "project.sqlite"),
    adapter,
  }).openProject(projectDirectory);

  const receipt = await channel.act(startCommand("held-session"));
  await waitForInFlight(channel);
  const active = (await channel.snapshot()).commands.find(
    (command) => command.commandId === receipt.commandId,
  );
  const sessionId = active?.session?.sessionId;
  assert.ok(sessionId);
  assert.deepEqual(await channel.removeSession({ sessionId }), {
    status: "blocked",
    activity: "in-flight",
  });
  assert.equal((await channel.snapshot()).commands.length, 1);

  adapter.release();
  await waitForTerminal(channel, receipt);
  assert.deepEqual(await channel.removeSession({ sessionId }), {
    status: "removed",
  });
  await channel.close();
});

test("Session removal rejects malformed or widened requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-removal-invalid-"));
  const projectDirectory = join(root, "Project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDirectory));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "project.sqlite"),
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);

  for (const request of [
    {},
    { sessionId: "" },
    { sessionId: "session-id", extra: true },
    new Proxy({ sessionId: "session-id" }, {}),
  ]) {
    await assert.rejects(
      channel.removeSession(request as { readonly sessionId: string }),
      (error: unknown) =>
        error instanceof CoordinatorError && error.category === "invalid-command",
    );
  }
  await channel.close();
});

test("a recovery-required Session is blocked as outcome-unknown evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-removal-unknown-"));
  const projectDirectory = join(root, "Project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDirectory));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "project.sqlite"),
    adapter: new OutcomeUnknownAdapter(),
  }).openProject(projectDirectory);

  const receipt = await channel.act(startCommand("outcome-unknown-session"));
  const terminal = await waitForTerminal(channel, receipt);
  assert.equal(terminal.status, "recovery-required");
  assert.equal(channel.readTurnActivity(), "unknown");
  const sessionId = terminal.session?.sessionId;
  assert.ok(sessionId);
  assert.deepEqual(await channel.removeSession({ sessionId }), {
    status: "blocked",
    activity: "unknown",
  });

  // The barrier is terminal, so the exit is an explicit acknowledgement rather
  // than waiting. Only the literal `true` expresses it.
  for (const widened of [false, "true", 1, null, undefined]) {
    await assert.rejects(
      channel.removeSession({
        sessionId,
        acknowledgedUnknownOutcome: widened,
      } as unknown as { readonly sessionId: string }),
      (error: unknown) =>
        error instanceof CoordinatorError &&
        error.category === "invalid-command",
    );
  }
  assert.deepEqual((await channel.snapshot()).commands.length, 1);

  assert.deepEqual(
    await channel.removeSession({
      sessionId,
      acknowledgedUnknownOutcome: true,
    }),
    { status: "removed" },
  );
  assert.deepEqual((await channel.snapshot()).commands.length, 0);
  await channel.close();
});

test("an acknowledged unknown outcome never releases a running turn", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "workbench-session-removal-ack-live-"),
  );
  const projectDirectory = join(root, "Project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(projectDirectory));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new HeldAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "project.sqlite"),
    adapter,
  }).openProject(projectDirectory);

  const receipt = await channel.act(startCommand("held-session"));
  await waitForInFlight(channel);
  const active = (await channel.snapshot()).commands.find(
    (command) => command.commandId === receipt.commandId,
  );
  const sessionId = active?.session?.sessionId;
  assert.ok(sessionId);

  // D16.2 is unchanged: the acknowledgement releases only the terminal
  // outcome-unknown barrier and can never interrupt live work.
  assert.deepEqual(
    await channel.removeSession({
      sessionId,
      acknowledgedUnknownOutcome: true,
    }),
    { status: "blocked", activity: "in-flight" },
  );
  assert.equal((await channel.snapshot()).commands.length, 1);

  adapter.release();
  await waitForTerminal(channel, receipt);
  await channel.close();
});
