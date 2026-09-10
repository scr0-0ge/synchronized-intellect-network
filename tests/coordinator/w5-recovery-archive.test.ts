import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createSessionMetadataModule,
  type SessionMetadataMutationRequest,
} from "../../src/session-metadata.ts";

test("recovery-required archive reuses delete acknowledgement without weakening active-turn guards", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_cursor INTEGER NOT NULL,
      private_envelope_json TEXT
    ) STRICT;
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      root_command_id TEXT NOT NULL,
      display_name TEXT,
      display_name_source TEXT,
      display_ordinal INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      lifecycle_status TEXT NOT NULL
    ) STRICT;
  `);
  const insertCommand = database.prepare(
    "INSERT INTO commands VALUES (?, 'project-1', ?, ?, ?, ?)",
  );
  const insertSession = database.prepare(
    "INSERT INTO sessions VALUES (?, 'project-1', ?, NULL, NULL, ?, 0, ?)",
  );
  for (const [ordinal, status] of [
    [1, "recovery-required"],
    [2, "recovery-required"],
    [3, "in-flight"],
  ] as const) {
    const commandId = `command-${ordinal}`;
    const sessionId = `session-${ordinal}`;
    insertCommand.run(
      commandId,
      sessionId,
      status,
      ordinal,
      JSON.stringify({ input: `prompt ${ordinal}` }),
    );
    insertSession.run(
      sessionId,
      commandId,
      ordinal,
      status,
    );
  }

  const metadata = createSessionMetadataModule(database, "project-1");
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-1",
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "unknown" },
  );

  const acknowledged = {
    sessionId: "session-1",
    operation: { kind: "archive" },
    acknowledgedUnknownOutcome: true,
  } as const as SessionMetadataMutationRequest;
  assert.deepEqual(metadata.mutate(acknowledged), { status: "archived" });
  assert.equal(
    (
      database
        .prepare("SELECT archived FROM sessions WHERE session_id = 'session-1'")
        .get() as { archived: number }
    ).archived,
    1,
  );
  metadata.assertStoredRows();
  assert.deepEqual(metadata.mutate(acknowledged), { status: "unchanged" });
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-1",
      operation: { kind: "restore" },
    }),
    { status: "restored" },
  );
  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-1",
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "unknown" },
    "restoring reinstates the acknowledgement barrier for a later archive",
  );
  assert.deepEqual(metadata.mutate(acknowledged), { status: "archived" });
  metadata.assertStoredRows();

  assert.deepEqual(
    metadata.mutate({
      sessionId: "session-3",
      operation: { kind: "archive" },
      acknowledgedUnknownOutcome: true,
    } as const as SessionMetadataMutationRequest),
    { status: "blocked", activity: "in-flight" },
    "the acknowledgement releases only the terminal unknown-outcome barrier",
  );

  for (const malformed of [
    {
      sessionId: "session-2",
      operation: { kind: "archive" },
      acknowledgedUnknownOutcome: false,
    },
    {
      sessionId: "session-2",
      operation: { kind: "archive" },
      acknowledgedUnknownOutcome: true,
      unregistered: true,
    },
  ]) {
    assert.throws(
      () => metadata.mutate(malformed as SessionMetadataMutationRequest),
      /invalid-session-metadata-request/u,
    );
  }
  database.close();
});
