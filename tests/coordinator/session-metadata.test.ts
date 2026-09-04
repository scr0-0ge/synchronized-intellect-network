import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  type ProjectCommandSummary,
} from "../../src/coordinator/index.ts";
import {
  createSessionMetadataModule,
  normalizeSessionDisplayName,
} from "../../src/session-metadata.ts";

const profile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const catalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: profile.model,
      effortLevels: Object.freeze([profile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const terminalEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({
    kind: "agent-message" as const,
    text: "SYNTHETIC_METADATA_TRANSCRIPT",
  }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

function startCommand(idempotencyKey: string, input = "SYNTHETIC_INPUT") {
  return Object.freeze({
    kind: "direct" as const,
    commandKind: "start" as const,
    idempotencyKey,
    runtime: "codex" as const,
    catalogRevision: "metadata-catalog-v1",
    preferences: Object.freeze({ global: profile }),
    profile,
    input,
  });
}

function continuationCommand(sessionId: string, idempotencyKey: string) {
  return Object.freeze({
    kind: "direct" as const,
    commandKind: "continue" as const,
    idempotencyKey,
    runtime: "codex" as const,
    targetSessionId: sessionId,
    profile,
    input: "SYNTHETIC_CONTINUATION",
  });
}

class RecordingCompletingAdapter implements ResumableAgentRuntimeAdapter {
  startCalls = 0;
  resumeCalls = 0;
  readonly resumedReferences: string[] = [];

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    return this.binding("synthetic-native-session-reference");
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    this.resumedReferences.push(request.opaqueSessionReference);
    return this.binding(request.opaqueSessionReference);
  }

  protected binding(reference: string): ResumableRuntimeBinding {
    return Object.freeze({
      profile,
      opaqueSessionReference: reference,
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        for (const event of terminalEvents) yield structuredClone(event);
      },
    });
  }
}

class HeldAdapter extends RecordingCompletingAdapter {
  private releaseEvents!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseEvents = resolve;
  });

  release(): void {
    this.releaseEvents();
  }

  protected override binding(reference: string): ResumableRuntimeBinding {
    const released = this.released;
    return Object.freeze({
      profile,
      opaqueSessionReference: reference,
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

class OutcomeUnknownAdapter extends RecordingCompletingAdapter {
  protected override binding(reference: string): ResumableRuntimeBinding {
    return Object.freeze({
      profile,
      opaqueSessionReference: reference,
      async send(_input: RuntimeInput): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
      },
    });
  }
}

async function waitForTerminal(
  channel: ProjectChannel,
  receipt: CommandReceipt,
): Promise<ProjectCommandSummary> {
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
  throw new Error("Synthetic Session did not reach a terminal state.");
}

async function waitForInFlight(channel: ProjectChannel): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (channel.readTurnActivity() === "in-flight") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Synthetic Session did not enter in-flight state.");
}

function durableIdentitySnapshot(databasePath: string, sessionId: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      session: database
        .prepare(
          `SELECT session_id, project_id, root_command_id, profile_json,
                  opaque_session_reference, auth_context_json, lifecycle_status
             FROM sessions WHERE session_id = ?`,
        )
        .get(sessionId),
      commands: database
        .prepare(
          `SELECT command_id, project_id, runtime, idempotency_digest,
                  payload_digest, digest_version, private_envelope_json,
                  target_session_id, status, failure_category,
                  accepted_cursor, effect_phase, outcome_uncertain,
                  auth_context_json
             FROM commands WHERE target_session_id = ? ORDER BY accepted_cursor`,
        )
        .all(sessionId),
      updates: database
        .prepare(
          `SELECT cursor, project_id, command_id, kind, status, session_id,
                  data_json
             FROM updates WHERE session_id = ? ORDER BY cursor`,
        )
        .all(sessionId),
    };
  } finally {
    database.close();
  }
}

test("new Sessions derive local names from the first prompt and manual rename wins for the full lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-names-"));
  const firstProject = join(root, "First Project");
  const otherProject = join(root, "Other Project");
  const databasePath = join(root, "workbench.sqlite");
  const otherDatabasePath = join(root, "other-workbench.sqlite");
  await Promise.all([mkdir(firstProject), mkdir(otherProject)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const adapter = new RecordingCompletingAdapter();
  const first = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(firstProject);
  const firstPrompt = "修复登录重试\nPRIVATE_PROMPT_SENTINEL_ONE";
  const secondPrompt = `${"Investigate cache invalidation after Project switch ".repeat(3)}\nPRIVATE_PROMPT_SENTINEL_TWO`;
  const firstReceipt = await first.act(
    startCommand("new-name-one", firstPrompt),
  );
  await waitForTerminal(first, firstReceipt);
  const secondReceipt = await first.act(
    startCommand("new-name-two", secondPrompt),
  );
  await waitForTerminal(first, secondReceipt);

  const initial = await first.snapshot();
  const firstSession = initial.commands.find(
    (command) => command.commandId === firstReceipt.commandId,
  )?.session;
  const secondSession = initial.commands.find(
    (command) => command.commandId === secondReceipt.commandId,
  )?.session;
  assert.ok(firstSession);
  assert.ok(secondSession);
  assert.equal(firstSession.displayName, "修复登录重试");
  assert.match(secondSession.displayName, /^Investigate cache invalidation/u);
  assert.equal(Array.from(secondSession.displayName).length, 60);
  assert.equal(secondSession.displayName.endsWith("…"), true);
  assert.notEqual(secondSession.displayName, firstSession.displayName);
  for (const displayName of [firstSession.displayName, secondSession.displayName]) {
    assert.equal(displayName.includes("PRIVATE_PROMPT"), false);
    assert.equal(displayName.includes("native-session-reference"), false);
  }

  const identityBeforeRename = durableIdentitySnapshot(
    databasePath,
    firstSession.sessionId,
  );
  assert.deepEqual(
    await first.mutateSessionMetadata({
      sessionId: firstSession.sessionId,
      operation: { kind: "rename", displayName: "  Cafe\u0301 工程  " },
    }),
    { status: "renamed" },
  );
  assert.equal(
    (await first.snapshot()).commands[0]?.session?.displayName,
    "Café 工程",
  );
  assert.deepEqual(
    await first.mutateSessionMetadata({
      sessionId: firstSession.sessionId,
      operation: { kind: "rename", displayName: "Café 工程" },
    }),
    { status: "unchanged" },
  );
  assert.deepEqual(
    durableIdentitySnapshot(databasePath, firstSession.sessionId),
    identityBeforeRename,
  );
  const continuation = await first.act(
    continuationCommand(firstSession.sessionId, "manual-name-continuation"),
  );
  await waitForTerminal(first, continuation);
  assert.equal(
    (await first.snapshot()).commands.find(
      (command) => command.commandId === continuation.commandId,
    )?.session?.displayName,
    "Café 工程",
  );
  await first.close();

  const other = await createWorkbenchCoordinator({
    databasePath: otherDatabasePath,
    adapter,
  })
    .openProject(otherProject);
  const otherReceipt = await other.act(startCommand("other-project-session"));
  await waitForTerminal(other, otherReceipt);
  await other.close();

  const reopened = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(firstProject);
  const reopenedCommands = (await reopened.snapshot()).commands;
  assert.equal(reopenedCommands[0]?.session?.displayName, "Café 工程");
  assert.deepEqual(
    await reopened.removeSession({ sessionId: secondSession.sessionId }),
    { status: "removed" },
  );
  assert.equal(
    (await reopened.snapshot()).commands[0]?.session?.displayName,
    "Café 工程",
  );
  await reopened.close();

  const durable = new DatabaseSync(databasePath, { readOnly: true });
  const stored = durable
    .prepare(
      `SELECT display_name, display_name_source, display_ordinal, archived
         FROM sessions WHERE session_id = ?`,
    )
    .get(firstSession.sessionId);
  durable.close();
  assert.deepEqual({ ...stored }, {
    display_name: "Café 工程",
    display_name_source: "manual",
    display_ordinal: 1,
    archived: 0,
  });
});

test("archive and restore preserve one terminal Session while hard delete remains final", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-archive-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await mkdir(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const adapter = new RecordingCompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  const receipt = await channel.act(startCommand("archive-terminal"));
  const terminal = await waitForTerminal(channel, receipt);
  const before = terminal.session;
  assert.ok(before);
  assert.equal(before.resumable, true);
  const identityBefore = durableIdentitySnapshot(databasePath, before.sessionId);

  assert.deepEqual(
    await channel.mutateSessionMetadata({
      sessionId: before.sessionId,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  assert.deepEqual(
    await channel.mutateSessionMetadata({
      sessionId: before.sessionId,
      operation: { kind: "archive" },
    }),
    { status: "unchanged" },
  );
  const archived = (await channel.snapshot()).commands[0]?.session;
  assert.ok(archived);
  assert.equal(archived.archived, true);
  assert.equal(archived.resumable, false);
  assert.equal(archived.sessionId, before.sessionId);
  assert.equal(archived.displayName, before.displayName);
  assert.deepEqual(archived.profile, before.profile);
  assert.deepEqual(archived.events, before.events);
  assert.deepEqual(
    durableIdentitySnapshot(databasePath, before.sessionId),
    identityBefore,
  );
  await channel.close();

  const reopened = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  assert.equal((await reopened.snapshot()).commands[0]?.session?.archived, true);
  assert.deepEqual(
    await reopened.validateContinuationProfile({
      sessionId: before.sessionId,
      profile,
    }),
    { status: "incompatible" },
  );
  await assert.rejects(
    reopened.act(continuationCommand(before.sessionId, "archived-cannot-continue")),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.category === "continuation-unavailable",
  );
  assert.equal(adapter.resumeCalls, 0);

  assert.deepEqual(
    await reopened.mutateSessionMetadata({
      sessionId: before.sessionId,
      operation: { kind: "restore" },
    }),
    { status: "restored" },
  );
  assert.deepEqual(
    await reopened.mutateSessionMetadata({
      sessionId: before.sessionId,
      operation: { kind: "restore" },
    }),
    { status: "unchanged" },
  );
  const restored = (await reopened.snapshot()).commands[0]?.session;
  assert.ok(restored);
  assert.equal(restored.archived, false);
  assert.equal(restored.resumable, true);
  assert.equal(restored.sessionId, before.sessionId);
  assert.equal(restored.displayName, before.displayName);
  assert.deepEqual(restored.profile, before.profile);
  assert.deepEqual(restored.events, before.events);
  assert.deepEqual(
    durableIdentitySnapshot(databasePath, before.sessionId),
    identityBefore,
  );

  assert.deepEqual(
    await reopened.mutateSessionMetadata({
      sessionId: before.sessionId,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  assert.deepEqual(await reopened.removeSession({ sessionId: before.sessionId }), {
    status: "removed",
  });
  assert.deepEqual((await reopened.snapshot()).commands, []);
  assert.deepEqual(
    await reopened.mutateSessionMetadata({
      sessionId: before.sessionId,
      operation: { kind: "restore" },
    }),
    { status: "not-found" },
  );
  await reopened.close();

  const finalOpen = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  assert.deepEqual((await finalOpen.snapshot()).commands, []);
  await finalOpen.close();
});

test("T16 selected-store metadata and D16 activity leaves an adjacent synthetic F92 sentinel byte-identical", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-t16-sentinel-"));
  const projectDirectory = join(root, "Selected Project");
  const selectedDatabasePath = join(root, "selected-work-ledger.sqlite");
  const sentinelDatabasePath = join(root, "adjacent-f92-sentinel.sqlite");
  const sentinelMarker = "SYNTHETIC_F92_SENTINEL_NEVER_IMPORT_OR_RECONCILE";
  await mkdir(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const sentinel = new DatabaseSync(sentinelDatabasePath);
  sentinel.exec(`
    CREATE TABLE synthetic_f92_sentinel (
      sentinel_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    INSERT INTO synthetic_f92_sentinel (sentinel_id, payload)
      VALUES ('sentinel-only', '${sentinelMarker}');
  `);
  sentinel.close();
  const sentinelBefore = await readFile(sentinelDatabasePath);
  const sentinelIdentity = `${sentinelBefore.length} bytes / SHA256 ${createHash("sha256").update(sentinelBefore).digest("hex")}`;
  let sentinelComparisons = 0;
  const assertSentinelUnchanged = async (phase: string): Promise<void> => {
    assert.deepEqual(
      await readFile(sentinelDatabasePath),
      sentinelBefore,
      `adjacent sentinel bytes after ${phase}`,
    );
    sentinelComparisons += 1;
  };

  const channel = await createWorkbenchCoordinator({
    databasePath: selectedDatabasePath,
    adapter: new RecordingCompletingAdapter(),
  }).openProject(projectDirectory);
  const receipt = await channel.act(startCommand("t16-selected-store-default"));
  const terminal = await waitForTerminal(channel, receipt);
  assert.ok(terminal.session);
  const sessionId = terminal.session.sessionId;
  assert.equal(terminal.session.displayName, "SYNTHETIC_INPUT");
  await assertSentinelUnchanged("default naming");

  const longNonAsciiName = `会議-${"界".repeat(75)}-🧭`;
  assert.equal(Array.from(longNonAsciiName).length, 80);
  assert.deepEqual(
    await channel.mutateSessionMetadata({
      sessionId,
      operation: { kind: "rename", displayName: longNonAsciiName },
    }),
    { status: "renamed" },
  );
  assert.equal(
    (await channel.snapshot()).commands[0]?.session?.displayName,
    longNonAsciiName,
  );
  await assertSentinelUnchanged("manual rename");

  const selectedStore = new DatabaseSync(selectedDatabasePath, {
    readOnly: true,
  });
  try {
    assert.equal(
      selectedStore
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'synthetic_f92_sentinel'",
        )
        .get(),
      undefined,
      "the adjacent sentinel schema was never selected or imported",
    );
  } finally {
    selectedStore.close();
  }
  assert.equal(
    (await readFile(selectedDatabasePath)).includes(Buffer.from(sentinelMarker)),
    false,
    "the selected store contains no reconciled sentinel payload",
  );

  assert.deepEqual(
    await channel.mutateSessionMetadata({
      sessionId,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  await assertSentinelUnchanged("archive");
  assert.deepEqual(
    await channel.mutateSessionMetadata({
      sessionId,
      operation: { kind: "restore" },
    }),
    { status: "restored" },
  );
  await assertSentinelUnchanged("restore");
  assert.deepEqual(
    await channel.mutateSessionMetadata({
      sessionId,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  await assertSentinelUnchanged("re-archive before D16 delete");
  assert.deepEqual(await channel.removeSession({ sessionId }), {
    status: "removed",
  });
  assert.deepEqual((await channel.snapshot()).commands, []);
  await assertSentinelUnchanged("D16 hard delete");
  await channel.close();
  await assertSentinelUnchanged("selected-store close");
  assert.equal(sentinelComparisons, 7);
  t.diagnostic(
    `T16 sentinel ${sentinelIdentity}; raw bytes matched after all 7 phases, and its schema/payload were absent from the selected store.`,
  );
});

test("archive fails closed for in-flight and recovery-required work without interruption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-archive-guard-"));
  const activeProject = join(root, "Active Project");
  const unknownProject = join(root, "Unknown Project");
  await Promise.all([mkdir(activeProject), mkdir(unknownProject)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const heldAdapter = new HeldAdapter();
  const active = await createWorkbenchCoordinator({
    databasePath: join(root, "active.sqlite"),
    adapter: heldAdapter,
  }).openProject(activeProject);
  const activeReceipt = await active.act(startCommand("active-archive-guard"));
  await waitForInFlight(active);
  const activeSession = (await active.snapshot()).commands[0]?.session;
  assert.ok(activeSession);
  assert.deepEqual(
    await active.mutateSessionMetadata({
      sessionId: activeSession.sessionId,
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "in-flight" },
  );
  assert.deepEqual(
    await active.mutateSessionMetadata({
      sessionId: activeSession.sessionId,
      operation: { kind: "rename", displayName: "Active but named" },
    }),
    { status: "renamed" },
  );
  assert.equal((await active.snapshot()).commands[0]?.session?.archived, false);
  heldAdapter.release();
  await waitForTerminal(active, activeReceipt);
  assert.deepEqual(
    await active.mutateSessionMetadata({
      sessionId: activeSession.sessionId,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  await active.close();

  const unknown = await createWorkbenchCoordinator({
    databasePath: join(root, "unknown.sqlite"),
    adapter: new OutcomeUnknownAdapter(),
  }).openProject(unknownProject);
  const unknownReceipt = await unknown.act(startCommand("unknown-archive-guard"));
  const recovery = await waitForTerminal(unknown, unknownReceipt);
  assert.equal(recovery.status, "recovery-required");
  assert.ok(recovery.session);
  assert.deepEqual(
    await unknown.mutateSessionMetadata({
      sessionId: recovery.session.sessionId,
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "unknown" },
  );
  assert.equal((await unknown.snapshot()).commands[0]?.session?.archived, false);
  await unknown.close();
});

test("version-three rows migrate without fabricated names and keep one deterministic legacy fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-legacy-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await mkdir(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const adapter = new RecordingCompletingAdapter();
  const initial = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  const receipt = await initial.act(startCommand("legacy-fixture"));
  const terminal = await waitForTerminal(initial, receipt);
  assert.ok(terminal.session);
  const sessionId = terminal.session.sessionId;
  await initial.close();

  const downgrade = new DatabaseSync(databasePath);
  downgrade.exec(`
    DROP INDEX sessions_project_display_ordinal_unique;
    ALTER TABLE sessions DROP COLUMN display_ordinal;
    ALTER TABLE sessions DROP COLUMN account_observation_json;
    ALTER TABLE sessions DROP COLUMN archived;
    ALTER TABLE sessions DROP COLUMN display_name_source;
    ALTER TABLE sessions DROP COLUMN display_name;
    PRAGMA user_version = 3;
  `);
  downgrade.close();

  const migrated = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  const fallback = `Legacy Agent Session ${String(receipt.acceptedCursor).padStart(2, "0")}`;
  assert.equal((await migrated.snapshot()).commands[0]?.session?.displayName, fallback);
  await migrated.close();

  const durable = new DatabaseSync(databasePath, { readOnly: true });
  const migratedRow = durable
    .prepare(
      `SELECT display_name, display_name_source, archived,
              account_observation_json, display_ordinal
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId);
  const schemaVersion = durable.prepare("PRAGMA user_version").get();
  durable.close();
  assert.deepEqual({ ...migratedRow }, {
    display_name: null,
    display_name_source: null,
    archived: 0,
    account_observation_json: null,
    display_ordinal: 1,
  });
  assert.deepEqual({ ...schemaVersion }, { user_version: 6 });

  const hydratedAgain = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  assert.equal(
    (await hydratedAgain.snapshot()).commands[0]?.session?.displayName,
    fallback,
  );
  assert.deepEqual(
    await hydratedAgain.mutateSessionMetadata({
      sessionId,
      operation: { kind: "rename", displayName: "Named legacy Session" },
    }),
    { status: "renamed" },
  );
  await hydratedAgain.close();

  const renamed = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  assert.equal(
    (await renamed.snapshot()).commands[0]?.session?.displayName,
    "Named legacy Session",
  );
  await renamed.close();
});

test("version-five migration preserves every existing Session identity and display name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-v5-migration-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await mkdir(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const adapter = new RecordingCompletingAdapter();
  const seeded = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  const firstReceipt = await seeded.act(startCommand("v5-default", "First prompt"));
  const secondReceipt = await seeded.act(startCommand("v5-manual", "Second prompt"));
  const firstTerminal = await waitForTerminal(seeded, firstReceipt);
  const secondTerminal = await waitForTerminal(seeded, secondReceipt);
  assert.ok(firstTerminal.session);
  assert.ok(secondTerminal.session);
  assert.deepEqual(
    await seeded.mutateSessionMetadata({
      sessionId: secondTerminal.session.sessionId,
      operation: { kind: "rename", displayName: "Owner-kept migration name" },
    }),
    { status: "renamed" },
  );
  await seeded.close();

  const downgrade = new DatabaseSync(databasePath);
  downgrade
    .prepare(
      `UPDATE sessions
          SET display_name = ?, display_name_source = 'default'
        WHERE session_id = ?`,
    )
    .run(
      `Agent Session ${String(firstReceipt.acceptedCursor).padStart(2, "0")}`,
      firstTerminal.session.sessionId,
    );
  downgrade.exec(`
    DROP INDEX sessions_project_display_ordinal_unique;
    ALTER TABLE sessions DROP COLUMN display_ordinal;
    PRAGMA user_version = 5;
  `);
  const before = downgrade
    .prepare(
      `SELECT session_id, project_id, root_command_id, display_name,
              display_name_source
         FROM sessions
        ORDER BY root_command_id`,
    )
    .all();
  downgrade.close();

  const migrated = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  assert.deepEqual(
    (await migrated.snapshot()).commands
      .filter((command) => command.commandId === firstReceipt.commandId)
      .map((command) => command.session?.displayName),
    [`Agent Session ${String(firstReceipt.acceptedCursor).padStart(2, "0")}`],
  );
  assert.equal(
    (await migrated.snapshot()).commands.find(
      (command) => command.commandId === secondReceipt.commandId,
    )?.session?.displayName,
    "Owner-kept migration name",
  );
  await migrated.close();

  const durable = new DatabaseSync(databasePath, { readOnly: true });
  const after = durable
    .prepare(
      `SELECT session_id, project_id, root_command_id, display_name,
              display_name_source
         FROM sessions
        ORDER BY root_command_id`,
    )
    .all();
  const ordinals = durable
    .prepare(
      `SELECT display_ordinal
         FROM sessions
        ORDER BY display_ordinal`,
    )
    .all()
    .map((row) => Number(row.display_ordinal));
  const version = durable.prepare("PRAGMA user_version").get();
  durable.close();
  assert.deepEqual(after, before, "migration preserved identities and names");
  assert.deepEqual(ordinals, [1, 2], "migration backfilled stable Project ordinals");
  assert.deepEqual({ ...version }, { user_version: 6 });
});

test("a version-six invalid display ordinal row fails open closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-v6-adversarial-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await mkdir(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const adapter = new RecordingCompletingAdapter();
  const seeded = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  const receipt = await seeded.act(startCommand("invalid-v6-ordinal"));
  await waitForTerminal(seeded, receipt);
  await seeded.close();

  const corrupt = new DatabaseSync(databasePath);
  corrupt.exec("PRAGMA ignore_check_constraints = ON");
  corrupt.prepare("UPDATE sessions SET display_ordinal = 0").run();
  corrupt.close();

  await assert.rejects(
    createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory),
    (error: unknown) =>
      error instanceof CoordinatorError && error.category === "storage-failed",
  );
});

test("the Session-metadata Interface owns normalization, duplicate policy, exact requests, and every archive state", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      accepted_cursor INTEGER NOT NULL,
      private_envelope_json TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_command_id TEXT NOT NULL,
      display_name TEXT,
      display_name_source TEXT,
      display_ordinal INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      lifecycle_status TEXT NOT NULL
    );
  `);
  const insertCommand = database.prepare(
    `INSERT INTO commands (
       command_id, project_id, target_session_id, accepted_cursor,
       private_envelope_json, status
     ) VALUES (?, 'project-1', ?, ?, ?, ?)`,
  );
  const insertSession = database.prepare(
    `INSERT INTO sessions (
       session_id, project_id, root_command_id, display_name,
       display_name_source, display_ordinal, archived, lifecycle_status
     ) VALUES (?, 'project-1', ?, NULL, NULL, ?, 0, ?)`,
  );
  for (const [index, status] of [
    "accepted",
    "in-flight",
    "recovery-required",
    "completed",
  ].entries()) {
    const ordinal = index + 1;
    insertCommand.run(
      `command-${ordinal}`,
      `session-${ordinal}`,
      ordinal,
      JSON.stringify({ input: `Session prompt ${ordinal}` }),
      status,
    );
    insertSession.run(`session-${ordinal}`, `command-${ordinal}`, ordinal, status);
  }
  const metadata = createSessionMetadataModule(database, "project-1");
  metadata.assertStoredRows();
  assert.deepEqual(
    metadata.project({
      display_name: null,
      display_name_source: null,
      display_ordinal: 4,
      archived: 0,
      lifecycle_status: "completed",
      root_accepted_cursor: 4,
      root_private_envelope_json: JSON.stringify({ input: "Session prompt 4" }),
    }),
    { displayName: "Legacy Agent Session 04", archived: false },
  );

  assert.deepEqual(metadata.acceptedInitial("  多语言标题  \nprivate body", 5), {
    displayName: "多语言标题",
    displayNameSource: "default",
    archived: 0,
  });
  assert.deepEqual(metadata.acceptedInitial(" \n\t ", 5), {
    displayName: "Agent Session 05",
    displayNameSource: "default",
    archived: 0,
  });
  assert.throws(() => metadata.acceptedInitial("name", 0), /invalid-display-ordinal/u);

  database
    .prepare(
      `UPDATE sessions
          SET display_name = 'Wrong automatic title',
              display_name_source = 'default'
        WHERE session_id = 'session-4'`,
    )
    .run();
  assert.throws(() => metadata.assertStoredRows(), /invalid-session-metadata-row/u);
  database
    .prepare(
      `UPDATE sessions
          SET display_name = 'Session prompt 4',
              display_name_source = 'automatic-extra'
        WHERE session_id = 'session-4'`,
    )
    .run();
  assert.throws(() => metadata.assertStoredRows(), /invalid-session-metadata-row/u);
  database
    .prepare(
      `UPDATE sessions
          SET display_name = NULL, display_name_source = NULL
        WHERE session_id = 'session-4'`,
    )
    .run();
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT display_name, display_name_source
             FROM sessions WHERE session_id = 'session-4'`,
        )
        .get(),
    },
    { display_name: null, display_name_source: null },
  );

  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-1",
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "accepted" },
  );
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-2",
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "in-flight" },
  );
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-3",
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "unknown" },
  );
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-4",
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-4",
      operation: { kind: "restore" },
    }),
    { status: "restored" },
  );

  for (const displayName of [
    "",
    "   ",
    "control\u0000name",
    "x".repeat(81),
    "\ud800",
  ]) {
    assert.deepEqual(
      metadata.mutate({
        sessionId: "session-4",
        operation: { kind: "rename", displayName },
      }),
      { status: "invalid-name" },
    );
  }
  assert.equal(normalizeSessionDisplayName("  Cafe\u0301 工程  "), "Café 工程");
  assert.equal(normalizeSessionDisplayName("🙂".repeat(80)), "🙂".repeat(80));
  assert.equal(normalizeSessionDisplayName("🙂".repeat(81)), undefined);

  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-4",
      operation: { kind: "rename", displayName: "Duplicate allowed" },
    }),
    { status: "renamed" },
  );
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-1",
      operation: { kind: "rename", displayName: "Duplicate allowed" },
    }),
    { status: "renamed" },
  );

  for (const malformed of [
    { sessionId: "session-4", operation: { kind: "archive" }, extra: true },
    { sessionId: "session-4", operation: { kind: "archive", extra: true } },
    new Proxy(
      { sessionId: "session-4", operation: { kind: "archive" as const } },
      {},
    ),
  ]) {
    assert.throws(
      () =>
        metadata.mutate(
          malformed as {
            readonly sessionId: string;
            readonly operation: { readonly kind: "archive" };
          },
        ),
      /invalid-session-metadata-request/u,
    );
  }
  database.close();
});

test("failed metadata persistence never returns success or changes the visible name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-session-metadata-failure-"));
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await mkdir(projectDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));

  const adapter = new RecordingCompletingAdapter();
  const initial = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  const receipt = await initial.act(startCommand("rename-write-failure"));
  const terminal = await waitForTerminal(initial, receipt);
  assert.ok(terminal.session);
  const sessionId = terminal.session.sessionId;
  const originalName = terminal.session.displayName;
  await initial.close();

  const durable = new DatabaseSync(databasePath);
  durable.exec(`
    CREATE TRIGGER reject_session_display_name_update
    BEFORE UPDATE OF display_name ON sessions
    BEGIN
      SELECT RAISE(ABORT, 'synthetic metadata write failure');
    END;
  `);
  durable.close();

  const reopened = await createWorkbenchCoordinator({ databasePath, adapter })
    .openProject(projectDirectory);
  await assert.rejects(
    reopened.mutateSessionMetadata({
      sessionId,
      operation: { kind: "rename", displayName: "Must not appear" },
    }),
    (error: unknown) =>
      error instanceof CoordinatorError && error.category === "storage-failed",
  );
  assert.equal(
    (await reopened.snapshot()).commands[0]?.session?.displayName,
    originalName,
  );
  await reopened.close();
});
