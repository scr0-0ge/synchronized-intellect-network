import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  CoordinatorError,
  createWorkbenchCoordinator,
  type CommandReceipt,
  type DirectProjectCommand,
  type ProjectChannel,
  type StartDirectProjectCommand,
} from "../../src/coordinator/index.ts";

const profile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});
const legacyIdempotencyKey = "legacy-idempotency-key";
const legacyPrivateInput = "LEGACY_PRIVATE_INPUT";

class NeverCalledAdapter implements ResumableAgentRuntimeAdapter {
  calls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.calls += 1;
    throw new Error("unexpected inspect");
  }

  async start(_request: RuntimeStart): Promise<never> {
    this.calls += 1;
    throw new Error("unexpected start");
  }

  async resume(_request: RuntimeResume): Promise<never> {
    this.calls += 1;
    throw new Error("unexpected resume");
  }
}

class RecordingResumableAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  resumeCalls = 0;
  sendCalls = 0;
  resumeReferenceMatched = false;
  resumeProjectMatched = false;
  resumeProfileMatched = false;
  private readonly projectDirectory: string;
  private readonly databasePath: string;
  private readonly reference = ["native", "session", "capability"].join("-");

  constructor(projectDirectory: string, databasePath: string) {
    this.projectDirectory = projectDirectory;
    this.databasePath = databasePath;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return structuredClone({
      runtime: "codex",
      models: [{ id: profile.model, effortLevels: [profile.effortLevel] }],
      executionModes: [profile.executionMode],
      accessModes: [profile.accessMode],
    });
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    assert.deepEqual(request, {
      projectDirectory: this.projectDirectory,
      profile,
    });
    return this.binding("FIRST_INPUT", "FIRST_VISIBLE_REPLY", true);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    this.resumeReferenceMatched = request.opaqueSessionReference === this.reference;
    this.resumeProjectMatched = request.projectDirectory === this.projectDirectory;
    this.resumeProfileMatched = JSON.stringify(request.profile) === JSON.stringify(profile);
    return this.binding("FOLLOWUP_INPUT", "SECOND_VISIBLE_REPLY", false);
  }

  private binding(
    expectedInput: string,
    visibleReply: string,
    assertCapabilityCommittedBeforeSend: boolean,
  ): ResumableRuntimeBinding {
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: this.reference,
      async send(input: RuntimeInput): Promise<void> {
        adapter.sendCalls += 1;
        assert.deepEqual(input, { text: expectedInput });
        if (assertCapabilityCommittedBeforeSend) {
          const reader = new DatabaseSync(adapter.databasePath, { readOnly: true });
          try {
            const row = reader
              .prepare(
                `SELECT opaque_session_reference IS NOT NULL AS committed,
                        effect_phase
                   FROM sessions
                   JOIN commands ON commands.target_session_id = sessions.session_id
                  LIMIT 1`,
              )
              .get() as { committed: number; effect_phase: string };
            assert.equal(Number(row.committed), 1);
            assert.equal(row.effect_phase, "send-claimed");
          } finally {
            reader.close();
          }
        }
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: visibleReply };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class InterruptThenResumeAdapter implements ResumableAgentRuntimeAdapter {
  readonly nativeReference = "interrupt-resume-native-session";
  startCalls = 0;
  resumeCalls = 0;
  interruptCalls = 0;
  private interruptAvailable = false;
  private releaseInterrupted!: () => void;
  private markTurnReady!: () => void;
  readonly turnReady = new Promise<void>((resolve) => {
    this.markTurnReady = resolve;
  });
  private readonly interrupted = new Promise<void>((resolve) => {
    this.releaseInterrupted = resolve;
  });

  releaseForCleanup(): void {
    this.releaseInterrupted();
  }

  async inspect(): Promise<RuntimeCatalog> {
    return runtimeCatalog();
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: this.nativeReference,
      async send(input: RuntimeInput): Promise<void> {
        assert.deepEqual(input, { text: "INTERRUPT_ME" });
      },
      interruptAvailability() {
        return adapter.interruptAvailable ? "available" : "unavailable";
      },
      async interrupt(): Promise<void> {
        assert.equal(adapter.interruptAvailable, true);
        adapter.interruptAvailable = false;
        adapter.interruptCalls += 1;
        adapter.releaseInterrupted();
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        adapter.interruptAvailable = true;
        adapter.markTurnReady();
        await adapter.interrupted;
        yield { kind: "turn-interrupted", status: "interrupted" };
      },
    };
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    assert.equal(request.opaqueSessionReference, this.nativeReference);
    return {
      profile,
      opaqueSessionReference: this.nativeReference,
      async send(input: RuntimeInput): Promise<void> {
        assert.deepEqual(input, { text: "RESUME_AFTER_INTERRUPT" });
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: "RESUMED_SAME_SESSION" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class ChangedProfileContinuationAdapter implements ResumableAgentRuntimeAdapter {
  readonly resumedProfiles: SessionProfile[] = [];
  compatibilityCalls = 0;
  private readonly reference = "changed-profile-native-session";
  private readonly continuationEffectiveProfile:
    | "requested"
    | "throw"
    | "model-mismatch"
    | "effort-mismatch"
    | "execution-mismatch"
    | "access-mismatch"
    | "extra-key";

  constructor(
    continuationEffectiveProfile:
      | "requested"
      | "throw"
      | "model-mismatch"
      | "effort-mismatch"
      | "execution-mismatch"
      | "access-mismatch"
      | "extra-key" = "requested",
  ) {
    this.continuationEffectiveProfile = continuationEffectiveProfile;
  }

  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "codex",
      models: [
        { id: profile.model, effortLevels: [profile.effortLevel] },
        {
          id: "gpt-5.6-terra",
          effortLevels: ["high"],
        },
      ],
      executionModes: [profile.executionMode],
      accessModes: [profile.accessMode],
    };
  }

  continuationProfileCompatibility(request: {
    readonly projectDirectory: string;
    readonly currentProfile: SessionProfile;
    readonly requestedProfile: SessionProfile;
  }): "compatible" | "incompatible" {
    this.compatibilityCalls += 1;
    if (
      request.projectDirectory.trim().length === 0 ||
      request.currentProfile.executionMode !== request.requestedProfile.executionMode ||
      request.currentProfile.accessMode !== request.requestedProfile.accessMode ||
      request.requestedProfile.model === "other-provider-model"
    ) {
      return "incompatible";
    }
    return "compatible";
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile, "FIRST_VISIBLE_REPLY", "requested");
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumedProfiles.push(structuredClone(request.profile));
    return this.binding(
      request.profile,
      "CHANGED_PROFILE_VISIBLE_REPLY",
      this.continuationEffectiveProfile,
    );
  }

  private binding(
    selectedProfile: SessionProfile,
    reply: string,
    effectiveProfile:
      | "requested"
      | "throw"
      | "model-mismatch"
      | "effort-mismatch"
      | "execution-mismatch"
      | "access-mismatch"
      | "extra-key",
  ): ResumableRuntimeBinding {
    const bindingProfile = Object.freeze({ ...selectedProfile });
    return {
      profile: bindingProfile,
      opaqueSessionReference: this.reference,
      effectiveProfile: () => {
        if (effectiveProfile === "throw") {
          throw new RuntimeAdapterError("unsupported-selection");
        }
        if (effectiveProfile === "model-mismatch") {
          return Object.freeze({
            ...bindingProfile,
            model: "PRIVATE_NATIVE_MODEL_MISMATCH",
          });
        }
        if (effectiveProfile === "effort-mismatch") {
          return Object.freeze({
            ...bindingProfile,
            effortLevel: "PRIVATE_NATIVE_EFFORT_MISMATCH",
          });
        }
        if (effectiveProfile === "execution-mismatch") {
          return Object.freeze({
            ...bindingProfile,
            executionMode: "PRIVATE_NATIVE_EXECUTION_MISMATCH",
          });
        }
        if (effectiveProfile === "access-mismatch") {
          return Object.freeze({
            ...bindingProfile,
            accessMode: "PRIVATE_NATIVE_ACCESS_MISMATCH",
          });
        }
        if (effectiveProfile === "extra-key") {
          return Object.freeze({
            ...bindingProfile,
            nativeEndpointIdentity: "PRIVATE_FORGED_ENDPOINT",
          }) as SessionProfile;
        }
        return bindingProfile;
      },
      async send(): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: reply };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class SerialFollowupAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  resumeCalls = 0;
  activeEffects = 0;
  maximumActiveEffects = 0;
  readonly sent: string[] = [];
  private releaseFirstEvents!: () => void;
  private markFirstEventsStarted!: () => void;
  readonly firstEventsStarted = new Promise<void>((resolve) => {
    this.markFirstEventsStarted = resolve;
  });
  private readonly firstEventsReleased = new Promise<void>((resolve) => {
    this.releaseFirstEvents = resolve;
  });
  private readonly reference = "serial-session-capability";

  release(): void {
    this.releaseFirstEvents();
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return runtimeCatalog();
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    return this.binding(0);
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    this.activeEffects += 1;
    this.maximumActiveEffects = Math.max(
      this.maximumActiveEffects,
      this.activeEffects,
    );
    return this.binding(this.resumeCalls);
  }

  private binding(resumeOrdinal: number): ResumableRuntimeBinding {
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: this.reference,
      async send(input: RuntimeInput): Promise<void> {
        adapter.sent.push(input.text);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        try {
          if (resumeOrdinal === 1) {
            adapter.markFirstEventsStarted();
            await adapter.firstEventsReleased;
          }
          yield { kind: "session-started" };
          yield { kind: "turn-completed", status: "completed" };
        } finally {
          if (resumeOrdinal > 0) adapter.activeEffects -= 1;
        }
      },
    };
  }
}

class HeldResumeAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  resumeCalls = 0;
  sendCalls = 0;
  private releaseResume!: () => void;
  private markResumeReached!: () => void;
  readonly resumeReached = new Promise<void>((resolve) => {
    this.markResumeReached = resolve;
  });
  private readonly resumeReleased = new Promise<void>((resolve) => {
    this.releaseResume = resolve;
  });
  protected readonly reference = "held-resume-capability";

  release(): void {
    this.releaseResume();
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return runtimeCatalog();
  }

  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    return this.binding();
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    this.markResumeReached();
    await this.resumeReleased;
    return this.binding();
  }

  protected binding(): ResumableRuntimeBinding {
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: this.reference,
      async send(): Promise<void> {
        adapter.sendCalls += 1;
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class HeldSendAdapter extends HeldResumeAdapter {
  private releaseSend!: () => void;
  private markSendReached!: () => void;
  readonly sendReached = new Promise<void>((resolve) => {
    this.markSendReached = resolve;
  });
  private readonly sendReleased = new Promise<void>((resolve) => {
    this.releaseSend = resolve;
  });

  override release(): void {
    super.release();
    this.releaseSend();
  }

  override async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    const adapter = this;
    return {
      profile,
      opaqueSessionReference: this.reference,
      async send(): Promise<void> {
        adapter.sendCalls += 1;
        adapter.markSendReached();
        await adapter.sendReleased;
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

function runtimeCatalog(): RuntimeCatalog {
  return structuredClone({
    runtime: "codex",
    models: [{ id: profile.model, effortLevels: [profile.effortLevel] }],
    executionModes: [profile.executionMode],
    accessModes: [profile.accessMode],
  });
}

test("empty v1 state upgrades deterministically while malformed schema and rows roll back", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-migration-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const emptyDirectory = join(temporaryDirectory, "empty-project");
  const emptyDatabasePath = join(temporaryDirectory, "empty.sqlite");
  await mkdir(emptyDirectory);
  const emptyDatabase = new DatabaseSync(emptyDatabasePath);
  createVersionOneSchema(emptyDatabase, 1);
  emptyDatabase.close();
  const emptyChannel = await createWorkbenchCoordinator({
    databasePath: emptyDatabasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(emptyDirectory);
  assert.deepEqual((await emptyChannel.snapshot()).commands, []);
  await emptyChannel.close();
  const emptyReader = new DatabaseSync(emptyDatabasePath, { readOnly: true });
  assert.equal(schemaVersion(emptyReader), 6);
  assert.deepEqual(conceptualTableNames(emptyReader), [
    "commands",
    "projects",
    "sessions",
    "updates",
  ]);
  emptyReader.close();

  const malformedSchemaDirectory = join(temporaryDirectory, "schema-project");
  const malformedSchemaPath = join(temporaryDirectory, "malformed-schema.sqlite");
  await mkdir(malformedSchemaDirectory);
  const malformedSchema = new DatabaseSync(malformedSchemaPath);
  createVersionOneSchema(malformedSchema, 1);
  malformedSchema.exec("ALTER TABLE commands ADD COLUMN unexpected_private_column TEXT");
  malformedSchema.close();
  await assert.rejects(
    createWorkbenchCoordinator({
      databasePath: malformedSchemaPath,
      adapter: new NeverCalledAdapter(),
    }).openProject(malformedSchemaDirectory),
    isStorageFailure,
  );
  const malformedSchemaReader = new DatabaseSync(malformedSchemaPath, {
    readOnly: true,
  });
  assert.equal(schemaVersion(malformedSchemaReader), 1);
  assert.equal(
    (malformedSchemaReader.prepare("PRAGMA table_info(commands)").all() as Array<{ name: string }>).some(
      (column) => column.name === "unexpected_private_column",
    ),
    true,
  );
  assert.equal(
    conceptualTableNames(malformedSchemaReader).some((name) => name.startsWith("migration_")),
    false,
  );
  malformedSchemaReader.close();

  const malformedRowDirectory = join(temporaryDirectory, "row-project");
  const malformedRowPath = join(temporaryDirectory, "malformed-row.sqlite");
  await mkdir(malformedRowDirectory);
  const malformedRow = new DatabaseSync(malformedRowPath);
  createVersionOneSchema(malformedRow, 1);
  const projectId = "legacy-malformed-project";
  malformedRow
    .prepare("INSERT INTO projects (project_id, directory_digest) VALUES (?, ?)")
    .run(projectId, projectDirectoryDigest(malformedRowDirectory));
  malformedRow
    .prepare(
      `INSERT INTO commands (
         command_id, project_id, idempotency_digest, payload_digest, runtime,
         status, failure_category, accepted_cursor
       ) VALUES ('legacy-malformed-command', ?, 'key', 'payload',
                 'unsupported-runtime', 'completed', NULL, 1)`,
    )
    .run(projectId);
  malformedRow.close();
  await assert.rejects(
    createWorkbenchCoordinator({
      databasePath: malformedRowPath,
      adapter: new NeverCalledAdapter(),
    }).openProject(malformedRowDirectory),
    isStorageFailure,
  );
  const malformedRowReader = new DatabaseSync(malformedRowPath, { readOnly: true });
  assert.equal(schemaVersion(malformedRowReader), 1);
  assert.deepEqual(conceptualTableNames(malformedRowReader), [
    "commands",
    "projects",
    "sessions",
    "updates",
  ]);
  assert.equal(
    (malformedRowReader
      .prepare("SELECT runtime FROM commands")
      .get() as { runtime: string }).runtime,
    "unsupported-runtime",
  );
  malformedRowReader.close();
});

test("version-two schema and row corruption fail closed before Adapter work", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-corrupt-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  const initial = await createWorkbenchCoordinator({
    databasePath,
    adapter: new NeverCalledAdapter(),
  }).openProject(projectDirectory);
  await initial.close();
  const database = new DatabaseSync(databasePath);
  const projectId = (database.prepare("SELECT project_id FROM projects").get() as {
    project_id: string;
  }).project_id;
  database
    .prepare(
      `INSERT INTO commands (
         command_id, project_id, idempotency_digest, payload_digest,
         digest_version, command_kind, target_session_id, runtime, status,
         failure_category, accepted_cursor, private_envelope_json,
         effect_phase, outcome_uncertain
       ) VALUES ('malformed-v2-command', ?, 'key', 'payload', 2, 'start', NULL,
                 'codex', 'accepted', NULL, 1, '{}', 'unclaimed', 0)`,
    )
    .run(projectId);
  database.close();
  const adapter = new NeverCalledAdapter();
  await assert.rejects(
    createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory),
    isStorageFailure,
  );
  assert.equal(adapter.calls, 0);

  const looseDirectory = join(temporaryDirectory, "loose-project");
  const loosePath = join(temporaryDirectory, "loose.sqlite");
  await mkdir(looseDirectory);
  const loose = new DatabaseSync(loosePath);
  createLooseVersionTwoSchema(loose);
  loose.close();
  await assert.rejects(
    createWorkbenchCoordinator({
      databasePath: loosePath,
      adapter: new NeverCalledAdapter(),
    }).openProject(looseDirectory),
    isStorageFailure,
  );
});

test("a populated v1 ledger upgrades once and keeps its legacy Agent Session visible but non-resumable", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-schema-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  seedVersionOneLedger(databasePath, projectDirectory);
  const adapter = new NeverCalledAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );

  try {
    const snapshot = await channel.snapshot();
    assert.equal(snapshot.cursor, 4);
    assert.equal(snapshot.commands.length, 1);
    assert.equal(snapshot.commands[0]?.status, "completed");
    assert.equal(
      Object.hasOwn(snapshot.commands[0] ?? {}, "input"),
      false,
      "digest-v1 migration must not fabricate input",
    );
    assert.deepEqual(snapshot.commands[0]?.session?.profile, profile);
    assert.deepEqual(snapshot.commands[0]?.session?.events, [
      { kind: "agent-message", text: "MIGRATED_VISIBLE_MESSAGE" },
    ]);
    assert.equal(snapshot.commands[0]?.session?.resumable, false);
    assert.equal(adapter.calls, 0);
    assert.deepEqual(
      await channel.act(startCommand(legacyIdempotencyKey, legacyPrivateInput)),
      {
        commandId: "legacy-command",
        acceptedCursor: 1,
        status: "accepted",
      },
    );
    await assert.rejects(
      channel.act(startCommand(legacyIdempotencyKey, "LEGACY_INPUT_DRIFT")),
      (error) =>
        error instanceof CoordinatorError &&
        error.category === "idempotency-conflict",
    );
    assert.equal((await channel.snapshot()).cursor, 4);

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        Number((reader.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
        6,
      );
      const commandColumns = reader
        .prepare("PRAGMA table_info(commands)")
        .all()
        .map((row) => String(row.name));
      assert.deepEqual(commandColumns, [
        "command_id",
        "project_id",
        "idempotency_digest",
        "payload_digest",
        "digest_version",
        "command_kind",
        "target_session_id",
        "runtime",
        "status",
        "failure_category",
        "accepted_cursor",
        "private_envelope_json",
        "effect_phase",
        "outcome_uncertain",
        "auth_context_json",
      ]);
      assert.deepEqual(
        reader
          .prepare("SELECT command_id, status, accepted_cursor FROM commands")
          .all()
          .map((row) => ({
            command_id: String(row.command_id),
            status: String(row.status),
            accepted_cursor: Number(row.accepted_cursor),
          })),
        [{ command_id: "legacy-command", status: "completed", accepted_cursor: 1 }],
      );
      assert.deepEqual(
        reader
          .prepare("SELECT cursor, kind, status FROM updates ORDER BY cursor")
          .all()
          .map((row) => ({
            cursor: Number(row.cursor),
            kind: String(row.kind),
            status: String(row.status),
          })),
        [
          { cursor: 1, kind: "accepted", status: "accepted" },
          { cursor: 2, kind: "profile-resolved", status: "in-flight" },
          { cursor: 3, kind: "runtime-event", status: "in-flight" },
          { cursor: 4, kind: "completed", status: "completed" },
        ],
      );
    } finally {
      reader.close();
    }
  } finally {
    await channel.close();
  }

  const reopenedAdapter = new NeverCalledAdapter();
  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: reopenedAdapter,
  }).openProject(projectDirectory);
  try {
    const reopenedSnapshot = await reopened.snapshot();
    assert.equal(reopenedSnapshot.cursor, 4);
    assert.equal(
      Object.hasOwn(reopenedSnapshot.commands[0] ?? {}, "input"),
      false,
      "digest-v1 reopen must keep input absent",
    );
    assert.equal(reopenedAdapter.calls, 0);
  } finally {
    await reopened.close();
  }
});

test("v1 migration preserves accepted, in-flight, and failed statuses with their original cursors", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-statuses-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  createVersionOneSchema(database, 0);
  database
    .prepare("INSERT INTO projects (project_id, directory_digest) VALUES (?, ?)")
    .run("legacy-status-project", projectDirectoryDigest(projectDirectory));
  const insertCommand = database.prepare(
    `INSERT INTO commands (
       command_id, project_id, idempotency_digest, payload_digest, runtime,
       status, failure_category, accepted_cursor
     ) VALUES (?, 'legacy-status-project', ?, ?, 'codex', ?, ?, ?)`,
  );
  const insertSession = database.prepare(
    "INSERT INTO sessions (session_id, command_id, profile_json) VALUES (?, ?, ?)",
  );
  const insertUpdate = database.prepare(
    `INSERT INTO updates (
       cursor, project_id, command_id, kind, status, session_id, data_json
     ) VALUES (?, 'legacy-status-project', ?, 'accepted', 'accepted', ?, NULL)`,
  );
  for (const [index, status] of ["accepted", "in-flight", "failed"].entries()) {
    const ordinal = index + 1;
    const commandId = `legacy-${status}-command`;
    const sessionId = `legacy-${status}-session`;
    insertCommand.run(
      commandId,
      `legacy-key-${ordinal}`,
      `legacy-payload-${ordinal}`,
      status,
      status === "failed" ? "runtime-failed" : null,
      ordinal,
    );
    insertSession.run(sessionId, commandId, JSON.stringify(profile));
    insertUpdate.run(ordinal, commandId, sessionId);
  }
  database.close();

  const adapter = new NeverCalledAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  try {
    const snapshot = await channel.snapshot();
    assert.equal(snapshot.cursor, 3);
    assert.deepEqual(
      snapshot.commands.map((command) => command.status),
      ["accepted", "in-flight", "failed"],
    );
    assert.equal(
      snapshot.commands.every((command) => command.session?.resumable === false),
      true,
    );
    assert.equal(
      snapshot.commands.every((command) => !Object.hasOwn(command, "input")),
      true,
      "digest-v1 summaries omit the input property",
    );
    assert.equal(adapter.calls, 0);
    await assert.rejects(
      channel.act(startCommand("blocked-by-legacy", "NEW_INPUT")),
      isContinuationUnavailable,
    );
  } finally {
    await channel.close();
  }
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(schemaVersion(reader), 6);
  assert.deepEqual(
    reader
      .prepare("SELECT accepted_cursor FROM commands ORDER BY accepted_cursor")
      .all()
      .map((row) => Number(row.accepted_cursor)),
    [1, 2, 3],
  );
  reader.close();
});

test("a selected Agent Session continues through the committed capability with one accumulated timeline", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-runtime-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new RecordingResumableAdapter(projectDirectory, databasePath);
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );

  try {
    const startReceipt = await channel.act(
      startCommand("start-key", "FIRST_INPUT") as DirectProjectCommand,
    );
    await waitForTerminal(channel, startReceipt);
    const started = await channel.snapshot();
    const session = started.commands[0]?.session;
    assert.ok(session !== undefined);
    const diagnosticReader = new DatabaseSync(databasePath, { readOnly: true });
    const durablePhase = diagnosticReader
      .prepare("SELECT effect_phase FROM commands LIMIT 1")
      .get() as { effect_phase: string };
    const durableUpdateKinds = diagnosticReader
      .prepare("SELECT kind FROM updates ORDER BY cursor")
      .all()
      .map((row) => String(row.kind));
    diagnosticReader.close();
    assert.deepEqual(
      {
        status: started.commands[0]?.status,
        effectPhase: durablePhase.effect_phase,
        updateKinds: durableUpdateKinds,
        inspectCalls: adapter.inspectCalls,
        startCalls: adapter.startCalls,
        sendCalls: adapter.sendCalls,
      },
      {
        status: "completed",
        effectPhase: "committed",
        updateKinds: [
          "accepted",
          "in-flight",
          "profile-resolved",
          "interrupt-capability",
          "runtime-event",
          "runtime-event",
          "runtime-event",
          "runtime-event",
          "completed",
        ],
        inspectCalls: 1,
        startCalls: 1,
        sendCalls: 1,
      },
    );
    assert.equal(session.resumable, true);

    const continueReceipt = await channel.act(
      {
        kind: "direct",
        commandKind: "continue",
        idempotencyKey: "continue-key",
        runtime: "codex",
        targetSessionId: session.sessionId,
        profile,
        input: "FOLLOWUP_INPUT",
      } as DirectProjectCommand,
    );
    await waitForTerminal(channel, continueReceipt);

    const completed = await channel.snapshot();
    assert.equal(completed.commands.length, 2);
    assert.equal(completed.commands[0]?.session?.sessionId, session.sessionId);
    assert.equal(completed.commands[1]?.session?.sessionId, session.sessionId);
    assert.deepEqual(
      completed.commands.map((command) => command.input),
      ["FIRST_INPUT", "FOLLOWUP_INPUT"],
    );
    assert.deepEqual(
      completed.commands.flatMap((command) => command.session?.events ?? []),
      [
        { kind: "session-started" },
        { kind: "turn-started" },
        { kind: "agent-message", text: "FIRST_VISIBLE_REPLY" },
        { kind: "turn-completed", status: "completed" },
        { kind: "session-started" },
        { kind: "turn-started" },
        { kind: "agent-message", text: "SECOND_VISIBLE_REPLY" },
        { kind: "turn-completed", status: "completed" },
      ],
    );
    assert.deepEqual(
      {
        inspectCalls: adapter.inspectCalls,
        startCalls: adapter.startCalls,
        resumeCalls: adapter.resumeCalls,
        sendCalls: adapter.sendCalls,
        resumeReferenceMatched: adapter.resumeReferenceMatched,
        resumeProjectMatched: adapter.resumeProjectMatched,
        resumeProfileMatched: adapter.resumeProfileMatched,
      },
      {
        inspectCalls: 1,
        startCalls: 1,
        resumeCalls: 1,
        sendCalls: 2,
        resumeReferenceMatched: true,
        resumeProjectMatched: true,
        resumeProfileMatched: true,
      },
    );
    const publicShape = JSON.stringify(completed);
    assert.equal(publicShape.includes("capability"), false);
    assert.equal(publicShape.includes(projectDirectory), false);
    assert.equal(publicShape.includes(databasePath), false);
  } finally {
    await channel.close();
  }
});

test("one Agent Session records interrupt and subsequent continuation as independent lifecycle observations", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "interrupt-resume-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new InterruptThenResumeAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );

  try {
    const startReceipt = await channel.act(
      startCommand("interrupt-start", "INTERRUPT_ME") as DirectProjectCommand,
    );
    await adapter.turnReady;
    assert.deepEqual(channel.readInterruptCapability!(), {
      status: "available",
      commandId: startReceipt.commandId,
    });
    assert.deepEqual(
      await channel.interruptActiveTurn!({ commandId: startReceipt.commandId }),
      { status: "requested" },
    );
    await waitForTerminal(channel, startReceipt);

    const afterInterrupt = await channel.snapshot();
    const interruptedCommand = afterInterrupt.commands.find(
      (command) => command.commandId === startReceipt.commandId,
    );
    const interruptObservation = Object.freeze({
      outcome: interruptedCommand?.failureCategory,
      terminal: interruptedCommand?.session?.events.at(-1),
      resumable: interruptedCommand?.session?.resumable,
    });
    assert.deepEqual(interruptObservation, {
      outcome: "interrupted",
      terminal: { kind: "turn-interrupted", status: "interrupted" },
      resumable: true,
    });

    const sessionId = interruptedCommand?.session?.sessionId;
    assert.notEqual(sessionId, undefined);
    const continueReceipt = await channel.act(
      continueCommand(
        "resume-after-interrupt",
        sessionId!,
        "RESUME_AFTER_INTERRUPT",
      ) as DirectProjectCommand,
    );
    await waitForTerminal(channel, continueReceipt);

    const afterResume = await channel.snapshot();
    const resumedCommand = afterResume.commands.find(
      (command) => command.commandId === continueReceipt.commandId,
    );
    const resumeObservation = Object.freeze({
      outcome: resumedCommand?.status,
      marker: resumedCommand?.session?.events.find(
        (event) => event.kind === "agent-message",
      ),
      sameSession: resumedCommand?.session?.sessionId === sessionId,
    });
    assert.deepEqual(resumeObservation, {
      outcome: "completed",
      marker: { kind: "agent-message", text: "RESUMED_SAME_SESSION" },
      sameSession: true,
    });
    assert.deepEqual(
      {
        startCalls: adapter.startCalls,
        interruptCalls: adapter.interruptCalls,
        resumeCalls: adapter.resumeCalls,
      },
      { startCalls: 1, interruptCalls: 1, resumeCalls: 1 },
    );
  } finally {
    adapter.releaseForCleanup();
    await channel.close();
  }
});

test("one Session accepts a same-provider changed profile and preserves each command profile through reopen", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-profile-change-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const changedProfile: SessionProfile = Object.freeze({
    model: "gpt-5.6-terra",
    effortLevel: "high",
    executionMode: profile.executionMode,
    accessMode: profile.accessMode,
  });
  const rootProjection = Object.freeze({
    kind: "recorded" as const,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex native",
    modelLabel: "GPT 5.6 Sol",
    workIntensityControlLabel: Object.freeze({
      label: "Reasoning",
      provenance: "runtime-catalog" as const,
    }),
    workIntensityLabel: "Ultra",
    executionModeLabel: "Single agent",
    accessModeLabel: "Full access",
  });
  const changedProjection = Object.freeze({
    ...rootProjection,
    modelLabel: "GPT 5.6 Terra",
    workIntensityLabel: "High",
  });
  const adapter = new ChangedProfileContinuationAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const startReceipt = await channel.act({
    ...startCommand("changed-profile-start"),
    requestedProfileProjection: rootProjection,
  });
  await waitForTerminal(channel, startReceipt);
  const sessionId = (await channel.snapshot()).commands[0]?.session?.sessionId;
  assert.ok(sessionId !== undefined);

  assert.deepEqual(
    await channel.validateContinuationProfile({
      sessionId,
      profile: changedProfile,
    }),
    { status: "compatible" },
  );
  assert.deepEqual(
    await channel.validateContinuationProfile({
      sessionId,
      profile: { ...changedProfile, model: "other-provider-model" },
    }),
    { status: "incompatible" },
  );
  for (const [name, request] of [
    ["request extra", { sessionId, profile: changedProfile, endpointId: "forged" }],
    [
      "profile extra",
      {
        sessionId,
        profile: { ...changedProfile, nativeEndpointKey: "forged" },
      },
    ],
    [
      "profile partial",
      {
        sessionId,
        profile: {
          model: changedProfile.model,
          effortLevel: changedProfile.effortLevel,
        },
      },
    ],
  ] as const) {
    await assert.rejects(
      channel.validateContinuationProfile(request as never),
      (error) =>
        error instanceof CoordinatorError && error.category === "invalid-command",
      name,
    );
  }

  const beforeRejected = await channel.snapshot();
  for (const [name, rejectedProfile, category] of [
    [
      "other-provider",
      { ...changedProfile, model: "other-provider-model" },
      "continuation-unavailable",
    ],
    [
      "execution-mode",
      { ...changedProfile, executionMode: "multi-agent" },
      "invalid-command",
    ],
    [
      "access-mode",
      { ...changedProfile, accessMode: "restricted" },
      "invalid-command",
    ],
  ] as const) {
    await assert.rejects(
      channel.act(
        continueCommand(
          `rejected-${name}`,
          sessionId,
          "REJECTED_PROFILE_INPUT",
          rejectedProfile,
        ),
      ),
      (error) =>
        error instanceof CoordinatorError && error.category === category,
      name,
    );
  }
  await assert.rejects(
    channel.act({
      ...continueCommand(
        "rejected-extra-profile-key",
        sessionId,
        "REJECTED_PROFILE_INPUT",
        changedProfile,
      ),
      profile: { ...changedProfile, nativeEndpointKey: "forged-private-key" },
    } as never),
    (error) =>
      error instanceof CoordinatorError && error.category === "invalid-command",
  );
  for (const [name, profileProjection] of [
    ["explicit undefined", undefined],
    ["partial", { version: 1 }],
    [
      "extra",
      {
        version: 1,
        requested: changedProjection,
        nativeEndpointKey: "forged-private-key",
      },
    ],
    [
      "nested-extra",
      {
        version: 1,
        requested: { ...changedProjection, nativeModelId: "forged-private-id" },
      },
    ],
  ] as const) {
    await assert.rejects(
      channel.act({
        ...continueCommand(
          `rejected-profile-projection-${name}`,
          sessionId,
          "REJECTED_PROFILE_INPUT",
          changedProfile,
        ),
        profileProjection,
      } as never),
      (error) =>
        error instanceof CoordinatorError && error.category === "invalid-command",
      name,
    );
  }
  assert.deepEqual(await channel.snapshot(), beforeRejected);

  const continuation = continueCommand(
    "changed-profile-follow-up",
    sessionId,
    "CHANGED_PROFILE_INPUT",
    changedProfile,
  );
  const changedProfileCommand = {
    ...continuation,
    profileProjection: {
      version: 1 as const,
      requested: changedProjection,
    },
  };
  const continueReceipt = await channel.act(changedProfileCommand);
  await waitForTerminal(channel, continueReceipt);
  assert.deepEqual(
    await channel.act({
      ...changedProfileCommand,
      profileProjection: {
        version: 1,
        requested: {
          ...changedProjection,
          modelLabel: "Alternate safe presentation",
        },
      },
    }),
    continueReceipt,
    "presentation-only retry preserves the first accepted continuation envelope",
  );
  const completed = await channel.snapshot();
  assert.deepEqual(
    completed.commands.map((command) => ({
      status: command.status,
      profile: command.session?.profile,
      requested: command.session?.requestedProfileProjection,
      effective: command.session?.effectiveProfileProjection,
    })),
    [
      {
        status: "completed",
        profile,
        requested: rootProjection,
        effective: {
          kind: "observed",
          provenance: "post-turn-observation",
          model: { label: "GPT 5.6 Sol", comparison: "matches-requested" },
          workIntensity: { label: "Ultra", comparison: "matches-requested" },
          accessMode: { label: "Full access", comparison: "matches-requested" },
        },
      },
      {
        status: "completed",
        profile: changedProfile,
        requested: changedProjection,
        effective: {
          kind: "observed",
          provenance: "post-turn-observation",
          model: { label: "GPT 5.6 Terra", comparison: "matches-requested" },
          workIntensity: { label: "High", comparison: "matches-requested" },
          accessMode: { label: "Full access", comparison: "matches-requested" },
        },
      },
    ],
  );
  assert.deepEqual(adapter.resumedProfiles, [changedProfile]);
  assert.equal(adapter.compatibilityCalls, 4);
  await channel.close();

  const reopenedAdapter = new NeverCalledAdapter();
  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: reopenedAdapter,
  }).openProject(projectDirectory);
  assert.deepEqual(await reopened.snapshot(), completed);
  assert.equal(reopenedAdapter.calls, 0);
  await reopened.close();
});

test("a changed-profile continuation terminal-fails when the native effective profile mismatches or is unverifiable", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "continuation-effective-profile-failure-"),
  );
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const changedProfile: SessionProfile = Object.freeze({
    model: "gpt-5.6-terra",
    effortLevel: "high",
    executionMode: profile.executionMode,
    accessMode: profile.accessMode,
  });
  const changedProjection = Object.freeze({
    kind: "recorded" as const,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex native",
    modelLabel: "GPT 5.6 Terra",
    workIntensityControlLabel: Object.freeze({
      label: "Reasoning",
      provenance: "runtime-catalog" as const,
    }),
    workIntensityLabel: "High",
    executionModeLabel: "Single agent",
    accessModeLabel: "Full access",
  });
  for (const mode of [
    "model-mismatch",
    "effort-mismatch",
    "execution-mismatch",
    "access-mismatch",
    "throw",
    "extra-key",
  ] as const) {
    const caseDirectory = join(temporaryDirectory, mode);
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const adapter = new ChangedProfileContinuationAdapter(mode);
    const channel = await createWorkbenchCoordinator({
      databasePath,
      adapter,
    }).openProject(projectDirectory);
    const startReceipt = await channel.act(
      startCommand(`effective-profile-${mode}-start`),
    );
    await waitForTerminal(channel, startReceipt);
    const sessionId = (await channel.snapshot()).commands[0]?.session?.sessionId;
    assert.ok(sessionId !== undefined, `${mode}: start Session identity`);

    const continueReceipt = await channel.act({
      ...continueCommand(
        `effective-profile-${mode}-continue`,
        sessionId,
        "CHANGED_PROFILE_INPUT",
        changedProfile,
      ),
      profileProjection: {
        version: 1,
        requested: changedProjection,
      },
    });
    await waitForTerminal(channel, continueReceipt);
    const snapshot = await channel.snapshot();
    assert.deepEqual(
      snapshot.commands.map((command) => ({
        status: command.status,
        failureCategory: command.failureCategory,
      })),
      [
        { status: "completed", failureCategory: undefined },
        { status: "failed", failureCategory: "runtime-failed" },
      ],
      `${mode}: native report cannot complete the continuation`,
    );
    assert.equal(
      JSON.stringify(snapshot).includes("PRIVATE_"),
      false,
      `${mode}: native mismatch details stay private`,
    );
    await assert.rejects(
      channel.act(
        continueCommand(
          `effective-profile-${mode}-retry`,
          sessionId,
          "REJECTED_AFTER_FAILURE",
          changedProfile,
        ),
      ),
      isContinuationUnavailable,
      `${mode}: failed Session is no longer resumable`,
    );
    await channel.close();

    const reopened = await createWorkbenchCoordinator({
      databasePath,
      adapter: new NeverCalledAdapter(),
    }).openProject(projectDirectory);
    assert.deepEqual(
      await reopened.snapshot(),
      snapshot,
      `${mode}: failed protocol outcome survives reopen`,
    );
    await reopened.close();
  }
});

test("continuation validation and digest v2 keep replay exact while rejecting target, kind, profile, and input drift", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-digest-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const adapter = new RecordingResumableAdapter(projectDirectory, databasePath);
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  try {
    const startReceipt = await channel.act(startCommand("digest-start"));
    await waitForTerminal(channel, startReceipt);
    const sessionId = (await channel.snapshot()).commands[0]?.session?.sessionId;
    assert.ok(sessionId !== undefined);
    const continuation = continueCommand(
      "digest-follow-up",
      sessionId,
      "FOLLOWUP_INPUT",
    );
    const receipt = await channel.act(continuation);
    await waitForTerminal(channel, receipt);
    const counts = Object.freeze({
      inspect: adapter.inspectCalls,
      start: adapter.startCalls,
      resume: adapter.resumeCalls,
      send: adapter.sendCalls,
    });
    assert.deepEqual(await channel.act(continuation), receipt);

    const conflicts: DirectProjectCommand[] = [
      { ...continuation, input: "DRIFTED_INPUT" },
      {
        ...continuation,
        profile: { ...profile, model: "different-valid-model" },
      },
      { ...continuation, targetSessionId: "different-session-target" },
      startCommand(continuation.idempotencyKey),
    ];
    for (const conflict of conflicts) {
      await assert.rejects(
        channel.act(conflict),
        (error) =>
          error instanceof CoordinatorError &&
          error.category === "idempotency-conflict",
      );
    }
    const afterConflicts = await channel.snapshot();
    assert.deepEqual(
      afterConflicts.commands.map((command) => command.input),
      ["FIRST_INPUT", "FOLLOWUP_INPUT"],
      "conflicts add no command summary",
    );

    await assert.rejects(
      channel.act(
        continueCommand("missing-target", "missing-session-target", "FOLLOWUP_INPUT"),
      ),
      isContinuationUnavailable,
    );
    await assert.rejects(
      channel.act(
        continueCommand("profile-drift", sessionId, "FOLLOWUP_INPUT", {
          ...profile,
          effortLevel: "different-valid-effort",
        }),
      ),
      isContinuationUnavailable,
    );

    const writer = new DatabaseSync(databasePath);
    const storedReference = (
      writer
        .prepare(
          "SELECT opaque_session_reference FROM sessions WHERE session_id = ?",
        )
        .get(sessionId) as { opaque_session_reference: string }
    ).opaque_session_reference;
    for (const lifecycle of [
      "accepted",
      "in-flight",
      "failed",
      "recovery-required",
    ] as const) {
      writer
        .prepare("UPDATE sessions SET lifecycle_status = ? WHERE session_id = ?")
        .run(lifecycle, sessionId);
      await assert.rejects(
        channel.act(
          continueCommand(
            `lifecycle-${lifecycle}`,
            sessionId,
            "FOLLOWUP_INPUT",
          ),
        ),
        isContinuationUnavailable,
      );
    }
    writer
      .prepare(
        "UPDATE sessions SET lifecycle_status = 'completed', opaque_session_reference = NULL WHERE session_id = ?",
      )
      .run(sessionId);
    assert.deepEqual(await channel.act(continuation), receipt);
    await assert.rejects(
      channel.act(
        continueCommand("missing-reference", sessionId, "FOLLOWUP_INPUT"),
      ),
      isContinuationUnavailable,
    );
    writer
      .prepare(
        "UPDATE sessions SET opaque_session_reference = ? WHERE session_id = ?",
      )
      .run(storedReference, sessionId);

    const foreignProjectId = "foreign-project";
    const foreignCommandId = "foreign-legacy-command";
    const foreignSessionId = "foreign-session";
    writer
      .prepare("INSERT INTO projects (project_id, directory_digest) VALUES (?, ?)")
      .run(foreignProjectId, "foreign-directory-digest");
    writer
      .prepare(
        `INSERT INTO commands (
           command_id, project_id, idempotency_digest, payload_digest,
           digest_version, command_kind, target_session_id, runtime, status,
           failure_category, accepted_cursor, private_envelope_json,
           effect_phase, outcome_uncertain
         ) VALUES (?, ?, 'foreign-key', 'foreign-payload', 1, 'start', ?,
                   'codex', 'completed', NULL, 0, NULL, 'legacy', 0)`,
      )
      .run(foreignCommandId, foreignProjectId, foreignSessionId);
    writer
      .prepare(
        `INSERT INTO sessions (
           session_id, project_id, root_command_id, profile_json,
           opaque_session_reference, lifecycle_status, display_ordinal
         ) VALUES (?, ?, ?, ?, ?, 'completed', 1)`,
      )
      .run(
        foreignSessionId,
        foreignProjectId,
        foreignCommandId,
        JSON.stringify(profile),
        storedReference,
      );
    await assert.rejects(
      channel.act(
        continueCommand("foreign-target", foreignSessionId, "FOLLOWUP_INPUT"),
      ),
      (error) =>
        error instanceof CoordinatorError && error.category === "project-mismatch",
    );
    writer.close();

    assert.deepEqual(
      {
        inspect: adapter.inspectCalls,
        start: adapter.startCalls,
        resume: adapter.resumeCalls,
        send: adapter.sendCalls,
      },
      counts,
    );
  } finally {
    await channel.close();
  }
});

test("two accepted follow-ups keep cursor order and maximum external concurrency at one", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-serial-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const adapter = new SerialFollowupAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  try {
    const root = await channel.act(startCommand("serial-root", "ROOT_INPUT"));
    await waitForTerminal(channel, root);
    const sessionId = (await channel.snapshot()).commands[0]?.session?.sessionId;
    assert.ok(sessionId !== undefined);

    const first = await channel.act(
      continueCommand("serial-first", sessionId, "FIRST_FOLLOWUP"),
    );
    await adapter.firstEventsStarted;
    const second = await channel.act(
      continueCommand("serial-second", sessionId, "SECOND_FOLLOWUP"),
    );
    assert.ok(first.acceptedCursor < second.acceptedCursor);
    assert.equal(adapter.resumeCalls, 1);
    assert.equal(adapter.maximumActiveEffects, 1);
    adapter.release();
    await Promise.all([
      waitForTerminal(channel, first),
      waitForTerminal(channel, second),
    ]);

    const snapshot = await channel.snapshot();
    assert.equal(adapter.inspectCalls, 1);
    assert.equal(adapter.startCalls, 1);
    assert.equal(adapter.resumeCalls, 2);
    assert.equal(adapter.maximumActiveEffects, 1);
    assert.deepEqual(adapter.sent, [
      "ROOT_INPUT",
      "FIRST_FOLLOWUP",
      "SECOND_FOLLOWUP",
    ]);
    assert.equal(snapshot.commands.length, 3);
    assert.deepEqual(
      snapshot.commands.map((command) => command.input),
      ["ROOT_INPUT", "FIRST_FOLLOWUP", "SECOND_FOLLOWUP"],
      "accepted-cursor order retains each exact command input",
    );
    assert.equal(
      new Set(snapshot.commands.map((command) => command.session?.sessionId)).size,
      1,
    );
    assert.equal(
      snapshot.commands.every(
        (command) => JSON.stringify(command.session?.profile) === JSON.stringify(profile),
      ),
      true,
    );
  } finally {
    adapter.release();
    await channel.close();
  }
});

test("restart distinguishes unclaimed and binding-ready work from claimed unknown outcomes", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-crash-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const baseDatabasePath = join(temporaryDirectory, "base.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const initialAdapter = new RecordingResumableAdapter(
    projectDirectory,
    baseDatabasePath,
  );
  const initial = await createWorkbenchCoordinator({
    databasePath: baseDatabasePath,
    adapter: initialAdapter,
  }).openProject(projectDirectory);
  const root = await initial.act(startCommand("crash-root", "FIRST_INPUT"));
  await waitForTerminal(initial, root);
  const sessionId = (await initial.snapshot()).commands[0]?.session?.sessionId;
  assert.ok(sessionId !== undefined);
  const continuation = continueCommand(
    "crash-follow-up",
    sessionId,
    "FOLLOWUP_INPUT",
  );
  const pendingReceipt = initial.act(continuation);
  const initialClose = initial.close();
  const continuationReceipt = await pendingReceipt;
  await initialClose;
  const baseReader = new DatabaseSync(baseDatabasePath, { readOnly: true });
  assert.deepEqual(
    baseReader
      .prepare(
        "SELECT status, effect_phase, outcome_uncertain FROM commands WHERE command_id = ?",
      )
      .get(continuationReceipt.commandId),
    Object.assign(Object.create(null), {
      status: "accepted",
      effect_phase: "unclaimed",
      outcome_uncertain: 0,
    }),
  );
  baseReader.close();

  for (const phaseCase of [
    { phase: "unclaimed", uncertain: 0, safe: true },
    { phase: "binding-ready", uncertain: 0, safe: true },
    { phase: "binding-claimed", uncertain: 1, safe: false },
    { phase: "send-claimed", uncertain: 1, safe: false },
    { phase: "awaiting-terminal", uncertain: 1, safe: false },
  ] as const) {
    const databasePath = join(temporaryDirectory, `${phaseCase.phase}.sqlite`);
    await copyFile(baseDatabasePath, databasePath);
    if (phaseCase.phase !== "unclaimed") {
      const writer = new DatabaseSync(databasePath);
      writer
        .prepare(
          "UPDATE commands SET status = 'in-flight', effect_phase = ?, outcome_uncertain = ? WHERE command_id = ?",
        )
        .run(phaseCase.phase, phaseCase.uncertain, continuationReceipt.commandId);
      writer
        .prepare(
          "UPDATE sessions SET lifecycle_status = 'in-flight' WHERE session_id = ?",
        )
        .run(sessionId);
      writer.close();
    }
    if (phaseCase.safe) {
      const adapter = new RecordingResumableAdapter(projectDirectory, databasePath);
      const recovered = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
        projectDirectory,
      );
      try {
        await waitForTerminal(recovered, continuationReceipt);
        const command = (await recovered.snapshot()).commands.find(
          (candidate) => candidate.commandId === continuationReceipt.commandId,
        );
        assert.equal(command?.status, "completed", phaseCase.phase);
        assert.equal(command?.input, "FOLLOWUP_INPUT", phaseCase.phase);
        assert.equal(adapter.inspectCalls, 0, phaseCase.phase);
        assert.equal(adapter.startCalls, 0, phaseCase.phase);
        assert.equal(adapter.resumeCalls, 1, phaseCase.phase);
        assert.equal(adapter.sendCalls, 1, phaseCase.phase);
      } finally {
        await recovered.close();
      }
      continue;
    }

    const adapter = new NeverCalledAdapter();
    const recovered = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
      projectDirectory,
    );
    try {
      const snapshot = await recovered.snapshot();
      const command = snapshot.commands.find(
        (candidate) => candidate.commandId === continuationReceipt.commandId,
      );
      assert.equal(command?.status, "recovery-required", phaseCase.phase);
      assert.equal(command?.input, "FOLLOWUP_INPUT", phaseCase.phase);
      assert.equal(
        snapshot.commands.filter(
          (candidate) => candidate.commandId === continuationReceipt.commandId,
        ).length,
        1,
        phaseCase.phase,
      );
      assert.equal(adapter.calls, 0, phaseCase.phase);
      assert.deepEqual(await recovered.act(continuation), continuationReceipt);
      const replayedSnapshot = await recovered.snapshot();
      assert.equal(
        replayedSnapshot.commands.filter(
          (candidate) => candidate.commandId === continuationReceipt.commandId,
        ).length,
        1,
        phaseCase.phase,
      );
      assert.equal(
        replayedSnapshot.commands.find(
          (candidate) => candidate.commandId === continuationReceipt.commandId,
        )?.input,
        "FOLLOWUP_INPUT",
        phaseCase.phase,
      );
      await assert.rejects(
        recovered.act(
          continueCommand(
            `blocked-${phaseCase.phase}`,
            sessionId,
            "FOLLOWUP_INPUT",
          ),
        ),
        isContinuationUnavailable,
      );
    } finally {
      await recovered.close();
    }
  }
});

test("graceful close preserves resume-before-send and barriers a completed send with queued work", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuation-close-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const safeProject = join(temporaryDirectory, "safe-project");
  const safeDatabase = join(temporaryDirectory, "safe.sqlite");
  await mkdir(safeProject);
  const heldResume = new HeldResumeAdapter();
  const safeChannel = await createWorkbenchCoordinator({
    databasePath: safeDatabase,
    adapter: heldResume,
  }).openProject(safeProject);
  const safeRoot = await safeChannel.act(startCommand("safe-root", "ROOT_INPUT"));
  await waitForTerminal(safeChannel, safeRoot);
  const safeSessionId = (await safeChannel.snapshot()).commands[0]?.session?.sessionId;
  assert.ok(safeSessionId !== undefined);
  const safeCommand = continueCommand(
    "safe-follow-up",
    safeSessionId,
    "FOLLOWUP_INPUT",
  );
  const safeReceipt = await safeChannel.act(safeCommand);
  await heldResume.resumeReached;
  const safeClose = safeChannel.close();
  heldResume.release();
  await safeClose;
  assert.equal(heldResume.resumeCalls, 1);
  assert.equal(heldResume.sendCalls, 1);
  const safeReader = new DatabaseSync(safeDatabase, { readOnly: true });
  assert.deepEqual(
    safeReader
      .prepare(
        "SELECT status, effect_phase, outcome_uncertain FROM commands WHERE command_id = ?",
      )
      .get(safeReceipt.commandId),
    Object.assign(Object.create(null), {
      status: "in-flight",
      effect_phase: "binding-ready",
      outcome_uncertain: 0,
    }),
  );
  safeReader.close();

  const safeReopenAdapter = new HeldResumeAdapter();
  safeReopenAdapter.release();
  const safeReopened = await createWorkbenchCoordinator({
    databasePath: safeDatabase,
    adapter: safeReopenAdapter,
  }).openProject(safeProject);
  try {
    await waitForTerminal(safeReopened, safeReceipt);
    const safeSnapshot = await safeReopened.snapshot();
    assert.equal(
      safeSnapshot.commands.find((command) => command.commandId === safeReceipt.commandId)
        ?.status,
      "completed",
    );
    assert.equal(
      safeSnapshot.commands.find((command) => command.commandId === safeReceipt.commandId)
        ?.input,
      "FOLLOWUP_INPUT",
    );
    assert.equal(safeReopenAdapter.resumeCalls, 1);
    assert.equal(safeReopenAdapter.sendCalls, 1);
  } finally {
    await safeReopened.close();
  }

  const blockedProject = join(temporaryDirectory, "blocked-project");
  const blockedDatabase = join(temporaryDirectory, "blocked.sqlite");
  await mkdir(blockedProject);
  const heldSend = new HeldSendAdapter();
  const blockedChannel = await createWorkbenchCoordinator({
    databasePath: blockedDatabase,
    adapter: heldSend,
  }).openProject(blockedProject);
  const blockedRoot = await blockedChannel.act(
    startCommand("blocked-root", "ROOT_INPUT"),
  );
  await waitForTerminal(blockedChannel, blockedRoot);
  const blockedSessionId = (await blockedChannel.snapshot()).commands[0]?.session
    ?.sessionId;
  assert.ok(blockedSessionId !== undefined);
  const firstCommand = continueCommand(
    "blocked-first",
    blockedSessionId,
    "FIRST_FOLLOWUP",
  );
  const firstReceipt = await blockedChannel.act(firstCommand);
  await heldSend.sendReached;
  const secondCommand = continueCommand(
    "blocked-second",
    blockedSessionId,
    "SECOND_FOLLOWUP",
  );
  const secondReceipt = await blockedChannel.act(secondCommand);
  const blockedClose = blockedChannel.close();
  heldSend.release();
  await blockedClose;

  const noCalls = new NeverCalledAdapter();
  const blockedReopened = await createWorkbenchCoordinator({
    databasePath: blockedDatabase,
    adapter: noCalls,
  }).openProject(blockedProject);
  try {
    const snapshot = await blockedReopened.snapshot();
    assert.equal(
      snapshot.commands.find((command) => command.commandId === firstReceipt.commandId)
        ?.status,
      "recovery-required",
    );
    assert.equal(
      snapshot.commands.find((command) => command.commandId === firstReceipt.commandId)
        ?.input,
      "FIRST_FOLLOWUP",
    );
    assert.equal(
      snapshot.commands.find((command) => command.commandId === secondReceipt.commandId)
        ?.status,
      "accepted",
    );
    assert.equal(
      snapshot.commands.find((command) => command.commandId === secondReceipt.commandId)
        ?.input,
      "SECOND_FOLLOWUP",
    );
    assert.equal(noCalls.calls, 0);
    assert.deepEqual(await blockedReopened.act(secondCommand), secondReceipt);
    await assert.rejects(
      blockedReopened.act(
        continueCommand("blocked-third", blockedSessionId, "THIRD_FOLLOWUP"),
      ),
      isContinuationUnavailable,
    );
  } finally {
    await blockedReopened.close();
  }
});

function startCommand(idempotencyKey: string, input = "FIRST_INPUT") {
  return {
    kind: "direct" as const,
    commandKind: "start" as const,
    idempotencyKey,
    runtime: "codex" as const,
    catalogRevision: "catalog-snapshot-v2",
    preferences: { global: profile },
    profile,
    input,
  };
}

function continueCommand(
  idempotencyKey: string,
  targetSessionId: string,
  input: string,
  selectedProfile: SessionProfile = profile,
) {
  return {
    kind: "direct" as const,
    commandKind: "continue" as const,
    idempotencyKey,
    runtime: "codex" as const,
    targetSessionId,
    profile: selectedProfile,
    input,
  };
}

function isContinuationUnavailable(error: unknown): boolean {
  return (
    error instanceof CoordinatorError &&
    error.category === "continuation-unavailable"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function legacyPayloadDigest(command: StartDirectProjectCommand): string {
  const profileFields = (value: Readonly<Partial<SessionProfile>> | undefined) => ({
    model: value?.model ?? null,
    effortLevel: value?.effortLevel ?? null,
    executionMode: value?.executionMode ?? null,
    accessMode: value?.accessMode ?? null,
  });
  const models = Object.keys(command.preferences.models ?? {})
    .sort()
    .map((model) => [
      model,
      profileFields(command.preferences.models?.[model]),
    ]);
  return sha256(
    JSON.stringify({
      kind: command.kind,
      runtime: command.runtime,
      catalogRevision: command.catalogRevision,
      preferences: {
        global: profileFields(command.preferences.global),
        runtime: profileFields(command.preferences.runtime),
        models,
      },
      overrides: profileFields(command.overrides),
      input: command.input,
    }),
  );
}

async function waitForTerminal(
  channel: ProjectChannel,
  receipt: CommandReceipt,
): Promise<void> {
  let snapshot = await channel.snapshot();
  const current = () =>
    snapshot.commands.find((command) => command.commandId === receipt.commandId);
  if (["completed", "failed", "recovery-required"].includes(current()?.status ?? "")) {
    return;
  }
  const iterator = channel.observe({ after: snapshot.cursor })[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      if (
        next.value?.commandId === receipt.commandId &&
        ["completed", "failed", "recovery-required"].includes(next.value.status)
      ) {
        return;
      }
    }
  } finally {
    await iterator.return?.();
  }
}

function createVersionOneSchema(database: DatabaseSync, version: 0 | 1): void {
  database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = ${version};
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        directory_digest TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        idempotency_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        runtime TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_category TEXT,
        accepted_cursor INTEGER NOT NULL,
        UNIQUE(project_id, idempotency_digest)
      ) STRICT;
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
        profile_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE updates (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        command_id TEXT NOT NULL REFERENCES commands(command_id),
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        data_json TEXT
      ) STRICT;
  `);
}

function createLooseVersionTwoSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      directory_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      idempotency_digest TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      digest_version INTEGER NOT NULL,
      command_kind TEXT NOT NULL,
      target_session_id TEXT,
      runtime TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_category TEXT,
      accepted_cursor INTEGER NOT NULL,
      private_envelope_json TEXT,
      effect_phase TEXT NOT NULL,
      outcome_uncertain INTEGER NOT NULL,
      UNIQUE(project_id, idempotency_digest)
    ) STRICT;
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_command_id TEXT NOT NULL UNIQUE,
      profile_json TEXT NOT NULL,
      opaque_session_reference TEXT,
      lifecycle_status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE updates (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      data_json TEXT
    ) STRICT;
  `);
}

function schemaVersion(database: DatabaseSync): number {
  return Number(
    (database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
}

function conceptualTableNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function projectDirectoryDigest(projectDirectory: string): string {
  const resolved = resolve(projectDirectory);
  return createHash("sha256")
    .update(process.platform === "win32" ? resolved.toLowerCase() : resolved, "utf8")
    .digest("hex");
}

function isStorageFailure(error: unknown): boolean {
  return error instanceof CoordinatorError && error.category === "storage-failed";
}

function seedVersionOneLedger(databasePath: string, projectDirectory: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    createVersionOneSchema(database, 1);
    const directoryDigest = projectDirectoryDigest(projectDirectory);
    database
      .prepare("INSERT INTO projects (project_id, directory_digest) VALUES (?, ?)")
      .run("legacy-project", directoryDigest);
    database
      .prepare(
        `INSERT INTO commands (
           command_id, project_id, idempotency_digest, payload_digest,
           runtime, status, failure_category, accepted_cursor
         ) VALUES (?, ?, ?, ?, 'codex', 'completed', NULL, 1)`,
      )
      .run(
        "legacy-command",
        "legacy-project",
        sha256(legacyIdempotencyKey),
        legacyPayloadDigest(startCommand(legacyIdempotencyKey, legacyPrivateInput)),
      );
    database
      .prepare("INSERT INTO sessions (session_id, command_id, profile_json) VALUES (?, ?, ?)")
      .run("legacy-session", "legacy-command", JSON.stringify(profile));
    const insertUpdate = database.prepare(
      `INSERT INTO updates (
         cursor, project_id, command_id, kind, status, session_id, data_json
       ) VALUES (?, 'legacy-project', 'legacy-command', ?, ?, ?, ?)`,
    );
    insertUpdate.run(1, "accepted", "accepted", null, null);
    insertUpdate.run(
      2,
      "profile-resolved",
      "in-flight",
      "legacy-session",
      JSON.stringify({ profile }),
    );
    insertUpdate.run(
      3,
      "runtime-event",
      "in-flight",
      "legacy-session",
      JSON.stringify({ event: { kind: "agent-message", text: "MIGRATED_VISIBLE_MESSAGE" } }),
    );
    insertUpdate.run(4, "completed", "completed", null, null);
  } finally {
    database.close();
  }
}
