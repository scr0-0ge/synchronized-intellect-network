import assert from "node:assert/strict";
import { cp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import {
  HistoryRecoveryPrivateReaderError,
  readHistoricalRecoveryInventory,
} from "../../src/workbench-shell/history-recovery-private-reader.ts";
import {
  createTestDirectory,
  registerTestCleanup,
} from "../helpers/test-lifecycle.ts";
import {
  createSyntheticStore,
  syntheticContinueEnvelope,
  syntheticLedgerSlot,
  syntheticStartEnvelope,
  syntheticStoredProfile,
} from "./fixtures/synthetic-history-recovery-fixtures.ts";

const rollbackMagic = Buffer.from([
  0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7,
]);

test("private reader accepts exact v2 and legacy v1 stores on disposable copies", async (t) => {
  const parent = await temporaryDirectory(t);
  const v2 = await createSyntheticStore(join(parent, "v2"), 2);
  const v1 = await createSyntheticStore(join(parent, "v1"), 1);

  const v2Inventory = await readHistoricalRecoveryInventory(v2.root);
  assert.deepEqual(v2Inventory.counts, {
    projects: 1,
    sessions: 1,
    commands: 2,
    updates: 4,
  });
  assert.equal(v2Inventory.readerVersion, 2);
  assert.deepEqual(
    v2Inventory.projects[0]?.sessions[0]?.turns.map((turn) => turn.eventCount),
    [2, 2],
  );

  const v1Inventory = await readHistoricalRecoveryInventory(v1.root);
  assert.deepEqual(v1Inventory.counts, {
    projects: 1,
    sessions: 1,
    commands: 1,
    updates: 2,
  });
  assert.equal(v1Inventory.readerVersion, 1);
});

test("WAL with copied SHM and WAL without SHM are reconstructed only on disposable copies", async (t) => {
  const parent = await temporaryDirectory(t);
  const source = await createSyntheticStore(join(parent, "source"), 2);
  assert.notEqual(source.ledgerPath, null);
  const database = new DatabaseSync(source.ledgerPath!);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      INSERT INTO updates (
        project_id, command_id, kind, status, session_id, data_json
      ) VALUES (
        'project-1', 'command-root', 'runtime-event', 'in-flight',
        'session-1', '{"event":{"kind":"agent-message","text":"synthetic"}}'
      );
    `);
    const withShm = await readHistoricalRecoveryInventory(source.root);
    assert.equal(withShm.counts.updates, 5);

    const withoutShmRoot = join(parent, "without-shm");
    await cp(source.root, withoutShmRoot, { recursive: true });
    await unlink(`${join(
      withoutShmRoot,
      "project-ledgers",
      `${syntheticLedgerSlot}.sqlite`,
    )}-shm`);
    const withoutShm = await readHistoricalRecoveryInventory(withoutShmRoot);
    assert.equal(withoutShm.counts.updates, 5);
  } finally {
    database.close();
  }
});

test("orphan SHM and mixed WAL plus rollback journal fail closed", async (t) => {
  const parent = await temporaryDirectory(t);
  const orphan = await createSyntheticStore(join(parent, "orphan"), 2);
  await writeFile(`${orphan.ledgerPath!}-shm`, Buffer.alloc(32));
  await expectCategory(
    readHistoricalRecoveryInventory(orphan.root),
    "unsupported-artifact",
  );

  const mixed = await createSyntheticStore(join(parent, "mixed"), 2);
  const database = new DatabaseSync(mixed.ledgerPath!);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      INSERT INTO updates (
        project_id, command_id, kind, status, session_id, data_json
      ) VALUES ('project-1', 'command-root', 'accepted', 'accepted', 'session-1', NULL);
    `);
    await writeFile(`${mixed.ledgerPath!}-journal`, hotJournalBytes());
    await expectCategory(
      readHistoricalRecoveryInventory(mixed.root),
      "unsupported-artifact",
    );
  } finally {
    database.close();
  }
});

test("a genuine hot rollback journal recovers on the disposable copy", async (t) => {
  const parent = await temporaryDirectory(t);
  const source = await createSyntheticStore(join(parent, "hot"), 2);
  const database = new DatabaseSync(source.ledgerPath!);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA cache_size = 1;
      BEGIN IMMEDIATE;
    `);
    database
      .prepare("UPDATE sessions SET profile_json = ? WHERE session_id = 'session-1'")
      .run(JSON.stringify({ payload: "x".repeat(2 * 1_024 * 1_024) }));
    const header = await readFile(`${source.ledgerPath!}-journal`);
    assert.equal(header.subarray(0, 8).equals(rollbackMagic), true);
    const inventory = await readHistoricalRecoveryInventory(source.root);
    assert.equal(inventory.counts.commands, 2);
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
});

test("cold and ambiguous rollback journals are preserved but block browsing", async (t) => {
  const parent = await temporaryDirectory(t);
  const cold = await createSyntheticStore(join(parent, "cold"), 2);
  await writeFile(`${cold.ledgerPath!}-journal`, Buffer.alloc(512));
  await expectCategory(
    readHistoricalRecoveryInventory(cold.root),
    "unsupported-artifact",
  );

  const ambiguous = await createSyntheticStore(join(parent, "ambiguous"), 2);
  await writeFile(`${ambiguous.ledgerPath!}-journal`, rollbackMagic);
  await expectCategory(
    readHistoricalRecoveryInventory(ambiguous.root),
    "unsupported-artifact",
  );
});

for (const artifact of [
  "unknown-artifact.bin",
  "project-registry-v1.json.replacement",
  "project-registry-v1.json.backup",
] as const) {
  test(`the ${artifact} artifact is preserved but blocks browsing`, async (t) => {
    const parent = await temporaryDirectory(t);
    const source = await createSyntheticStore(join(parent, "source"), 2);
    await writeFile(join(source.root, artifact), "synthetic");
    await expectCategory(
      readHistoricalRecoveryInventory(source.root),
      "unsupported-artifact",
    );
  });
}

test("unknown schema versions and invalid legacy rows fail closed", async (t) => {
  const parent = await temporaryDirectory(t);
  const unknown = await createSyntheticStore(join(parent, "unknown"), 2);
  const unknownDatabase = new DatabaseSync(unknown.ledgerPath!);
  const closeUnknownDatabase = registerTestCleanup(t, () =>
    unknownDatabase.close()
  );
  unknownDatabase.exec("PRAGMA user_version = 3");
  await closeUnknownDatabase();
  await expectCategory(
    readHistoricalRecoveryInventory(unknown.root),
    "unsupported-schema",
  );

  const invalid = await createSyntheticStore(join(parent, "invalid"), 1);
  const invalidDatabase = new DatabaseSync(invalid.ledgerPath!);
  const closeInvalidDatabase = registerTestCleanup(t, () =>
    invalidDatabase.close()
  );
  invalidDatabase.exec("UPDATE commands SET runtime = 'not-codex'");
  await closeInvalidDatabase();
  await expectCategory(
    readHistoricalRecoveryInventory(invalid.root),
    "verification-failed",
  );
});

test("registry duplicate keys and extra schema fields are rejected", async (t) => {
  const parent = await temporaryDirectory(t);
  const source = await createSyntheticStore(join(parent, "source"), 0);
  await writeFile(
    join(source.root, "project-registry-v1.json"),
    '{"schemaVersion":1,"schemaVersion":1,"revision":1,"nextProjectOrdinal":1,"selectedRecordKey":null,"records":[]}',
  );
  await expectCategory(
    readHistoricalRecoveryInventory(source.root),
    "invalid-registry",
  );
});

for (const column of [
  "updates.data_json",
  "sessions.profile_json",
  "commands.private_envelope_json",
] as const) {
  test(`${column} rejects an arbitrary JSON object`, async (t) => {
    const parent = await temporaryDirectory(t);
    const source = await createSyntheticStore(join(parent, "source"), 2);
    const database = new DatabaseSync(source.ledgerPath!);
    try {
      if (column === "updates.data_json") {
        database
          .prepare("UPDATE updates SET data_json = ? WHERE cursor = 2")
          .run('{"unexpected":true}');
      } else if (column === "sessions.profile_json") {
        database.prepare("UPDATE sessions SET profile_json = ?").run(
          '{"unexpected":true}',
        );
      } else {
        database
          .prepare(
            "UPDATE commands SET private_envelope_json = ? WHERE command_id = 'command-root'",
          )
          .run('{"unexpected":true}');
      }
    } finally {
      database.close();
    }
    await expectCategory(
      readHistoricalRecoveryInventory(source.root),
      "verification-failed",
    );
  });
}

test("v2 private envelopes reject extra and mismatched branch fields", async (t) => {
  for (const [name, commandId, envelope] of [
    [
      "start-with-continuation-field",
      "command-root",
      { ...syntheticStartEnvelope, targetSessionId: "session-1" },
    ],
    [
      "continue-with-start-field",
      "command-continue",
      { ...syntheticContinueEnvelope, catalogRevision: "foreign" },
    ],
  ] as const) {
    const parent = await temporaryDirectory(t);
    const source = await createSyntheticStore(join(parent, name), 2);
    const database = new DatabaseSync(source.ledgerPath!);
    const closeDatabase = registerTestCleanup(t, () => database.close());
    database
      .prepare("UPDATE commands SET private_envelope_json = ? WHERE command_id = ?")
      .run(JSON.stringify(envelope), commandId);
    await closeDatabase();
    await expectCategory(
      readHistoricalRecoveryInventory(source.root),
      "verification-failed",
    );
  }
});

for (const duplicate of [
  {
    name: "session-profile",
    update(database: DatabaseSync) {
      database.prepare("UPDATE sessions SET profile_json = ?").run(
        '{"model":"synthetic-model","model":"synthetic-model","effortLevel":"high","executionMode":"single-agent","accessMode":"full-access"}',
      );
    },
  },
  {
    name: "private-envelope",
    update(database: DatabaseSync) {
      const valid = JSON.stringify(syntheticStartEnvelope);
      database
        .prepare(
          "UPDATE commands SET private_envelope_json = ? WHERE command_id = 'command-root'",
        )
        .run(valid.replace('"kind":"direct"', '"kind":"direct","kind":"direct"'));
    },
  },
  {
    name: "update-payload",
    update(database: DatabaseSync) {
      database.prepare("UPDATE updates SET data_json = ? WHERE cursor = 2").run(
        '{"effectiveProfileProjection":{"kind":"unknown","kind":"unknown"}}',
      );
    },
  },
] as const) {
  test(`${duplicate.name} rejects duplicate JSON object keys`, async (t) => {
    const parent = await temporaryDirectory(t);
    const source = await createSyntheticStore(join(parent, "source"), 2);
    const database = new DatabaseSync(source.ledgerPath!);
    const closeDatabase = registerTestCleanup(t, () => database.close());
    duplicate.update(database);
    await closeDatabase();
    await expectCategory(
      readHistoricalRecoveryInventory(source.root),
      "verification-failed",
    );
  });
}

test("stored JSON rejects oversized text and mismatched update payload branches", async (t) => {
  const parent = await temporaryDirectory(t);
  const oversized = await createSyntheticStore(join(parent, "oversized"), 2);
  const oversizedDatabase = new DatabaseSync(oversized.ledgerPath!);
  const closeOversizedDatabase = registerTestCleanup(t, () =>
    oversizedDatabase.close()
  );
  oversizedDatabase.prepare("UPDATE sessions SET profile_json = ?").run(
    JSON.stringify({
      ...syntheticStoredProfile,
      model: "x".repeat(1024 * 1024 + 1),
    }),
  );
  await closeOversizedDatabase();
  await expectCategory(
    readHistoricalRecoveryInventory(oversized.root),
    "verification-failed",
  );

  const mismatched = await createSyntheticStore(join(parent, "mismatched"), 2);
  const mismatchedDatabase = new DatabaseSync(mismatched.ledgerPath!);
  const closeMismatchedDatabase = registerTestCleanup(t, () =>
    mismatchedDatabase.close()
  );
  mismatchedDatabase
    .prepare(
      "UPDATE updates SET kind = 'runtime-event', data_json = ? WHERE cursor = 2",
    )
    .run(JSON.stringify({ profile: syntheticStoredProfile }));
  await closeMismatchedDatabase();
  await expectCategory(
    readHistoricalRecoveryInventory(mismatched.root),
    "verification-failed",
  );
});

test("all actual v1 and v2 update payload branches remain accepted", async (t) => {
  const parent = await temporaryDirectory(t);
  const source = await createSyntheticStore(join(parent, "valid-branches"), 2);
  const database = new DatabaseSync(source.ledgerPath!);
  const closeDatabase = registerTestCleanup(t, () => database.close());
  const insert = database.prepare(`
    INSERT INTO updates (
      project_id, command_id, kind, status, session_id, data_json
    ) VALUES ('project-1', 'command-root', ?, ?, ?, ?)
  `);
  insert.run("in-flight", "in-flight", "session-1", null);
  insert.run(
    "profile-resolved",
    "in-flight",
    "session-1",
    JSON.stringify({ profile: syntheticStoredProfile }),
  );
  insert.run(
    "runtime-event",
    "in-flight",
    "session-1",
    JSON.stringify({ event: { kind: "agent-message", text: "synthetic" } }),
  );
  insert.run(
    "completed",
    "completed",
    "session-1",
    JSON.stringify({ effectiveProfileProjection: { kind: "unknown" } }),
  );
  insert.run(
    "failed",
    "failed",
    "session-1",
    JSON.stringify({
      failureCategory: "runtime-failed",
      effectiveProfileProjection: { kind: "unknown" },
    }),
  );
  insert.run("recovery-required", "recovery-required", "session-1", null);
  await closeDatabase();
  const inventory = await readHistoricalRecoveryInventory(source.root);
  assert.equal(inventory.readerVersion, 2);
  assert.equal(inventory.counts.updates, 10);
});

function hotJournalBytes(): Buffer {
  const bytes = Buffer.alloc(512);
  rollbackMagic.copy(bytes);
  return bytes;
}

async function expectCategory(
  promise: Promise<unknown>,
  category: HistoryRecoveryPrivateReaderError["category"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof HistoryRecoveryPrivateReaderError, true);
    assert.equal((error as HistoryRecoveryPrivateReaderError).category, category);
    return true;
  });
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  return createTestDirectory(
    t,
    join(tmpdir(), "uaw-history-private-reader-test-"),
  );
}
