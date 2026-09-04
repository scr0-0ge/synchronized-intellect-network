import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const syntheticLedgerSlot =
  "project-ledger-v1-00000000-0000-4000-8000-000000000001";

export const syntheticStoredProfile = Object.freeze({
  model: "synthetic-model",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
});

export const syntheticStartEnvelope = Object.freeze({
  kind: "direct",
  commandKind: "start",
  idempotencyKey: "synthetic-start-key",
  runtime: "codex",
  profile: syntheticStoredProfile,
  input: "synthetic start input",
  catalogRevision: "synthetic-catalog-v1",
  preferences: Object.freeze({}),
});

export const syntheticContinueEnvelope = Object.freeze({
  kind: "direct",
  commandKind: "continue",
  idempotencyKey: "synthetic-continue-key",
  runtime: "codex",
  profile: syntheticStoredProfile,
  input: "synthetic continue input",
  targetSessionId: "session-1",
});

export interface SyntheticStore {
  readonly root: string;
  readonly ledgerPath: string | null;
}

export async function createSyntheticStore(
  root: string,
  version: 0 | 1 | 2 = 2,
): Promise<SyntheticStore> {
  const ledgerDirectory = join(root, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  if (version === 0) {
    await writeSyntheticRegistry(root, []);
    return Object.freeze({ root, ledgerPath: null });
  }
  const ledgerPath = join(ledgerDirectory, `${syntheticLedgerSlot}.sqlite`);
  const database = new DatabaseSync(ledgerPath);
  try {
    if (version === 1) {
      createVersionOneSchema(database);
      seedVersionOne(database);
    } else {
      createVersionTwoSchema(database);
      seedVersionTwo(database);
    }
  } finally {
    database.close();
  }
  await writeSyntheticRegistry(root, [syntheticLedgerSlot]);
  return Object.freeze({ root, ledgerPath });
}

export function createVersionOneSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 1;
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

export function createVersionTwoSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 2;
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      directory_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      idempotency_digest TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      digest_version INTEGER NOT NULL CHECK (digest_version IN (1, 2)),
      command_kind TEXT NOT NULL CHECK (command_kind IN ('start', 'continue')),
      target_session_id TEXT,
      runtime TEXT NOT NULL CHECK (runtime = 'codex'),
      status TEXT NOT NULL CHECK (
        status IN ('accepted', 'in-flight', 'completed', 'failed', 'recovery-required')
      ),
      failure_category TEXT,
      accepted_cursor INTEGER NOT NULL CHECK (accepted_cursor >= 0),
      private_envelope_json TEXT,
      effect_phase TEXT NOT NULL CHECK (
        effect_phase IN (
          'legacy', 'unclaimed', 'binding-claimed', 'binding-ready',
          'send-claimed', 'awaiting-terminal', 'committed'
        )
      ),
      outcome_uncertain INTEGER NOT NULL CHECK (outcome_uncertain IN (0, 1)),
      UNIQUE(project_id, idempotency_digest)
    ) STRICT;
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      root_command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
      profile_json TEXT NOT NULL,
      opaque_session_reference TEXT,
      lifecycle_status TEXT NOT NULL CHECK (
        lifecycle_status IN (
          'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
        )
      )
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

export function seedVersionOne(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects VALUES ('project-1', 'directory-digest-1');
    INSERT INTO commands VALUES (
      'command-1', 'project-1', 'idempotency-1', 'payload-1',
      'codex', 'completed', NULL, 1
    );
  `);
  database
    .prepare("INSERT INTO sessions VALUES ('session-1', 'command-1', ?)")
    .run(JSON.stringify(syntheticStoredProfile));
  database.exec(`
    INSERT INTO updates (
      project_id, command_id, kind, status, session_id, data_json
    ) VALUES
      ('project-1', 'command-1', 'accepted', 'accepted', 'session-1', NULL),
      ('project-1', 'command-1', 'completed', 'completed', 'session-1', NULL);
  `);
}

export function seedVersionTwo(database: DatabaseSync): void {
  database.exec("INSERT INTO projects VALUES ('project-1', 'directory-digest-1')");
  const command = database.prepare(`
    INSERT INTO commands VALUES (
      ?, 'project-1', ?, ?, 2, ?, 'session-1', 'codex', 'completed', NULL, ?,
      ?, 'committed', 0
    )
  `);
  command.run(
    "command-root",
    "idempotency-root",
    "payload-root",
    "start",
    1,
    JSON.stringify(syntheticStartEnvelope),
  );
  command.run(
    "command-continue",
    "idempotency-continue",
    "payload-continue",
    "continue",
    3,
    JSON.stringify(syntheticContinueEnvelope),
  );
  database
    .prepare(`
      INSERT INTO sessions VALUES (
        'session-1', 'project-1', 'command-root', ?,
        'opaque-synthetic-reference', 'completed'
      )
    `)
    .run(JSON.stringify(syntheticStoredProfile));
  database.exec(`
    INSERT INTO updates (
      project_id, command_id, kind, status, session_id, data_json
    ) VALUES
      ('project-1', 'command-root', 'accepted', 'accepted', 'session-1', NULL),
      ('project-1', 'command-root', 'completed', 'completed', 'session-1', NULL),
      ('project-1', 'command-continue', 'accepted', 'accepted', 'session-1', NULL),
      ('project-1', 'command-continue', 'completed', 'completed', 'session-1', NULL);
  `);
}

export async function writeSyntheticRegistry(
  root: string,
  slots: readonly string[],
): Promise<void> {
  const records = slots.map((ledgerSlot, index) => ({
    recordKey: `synthetic-record-${index + 1}`,
    canonicalDirectory: `X:/synthetic/project-${index + 1}`,
    ledgerSlot,
  }));
  await writeFile(
    join(root, "project-registry-v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: records.length + 1,
      selectedRecordKey: records[0]?.recordKey ?? null,
      records,
    }),
  );
}

export async function createOversizedSparseFile(path: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.truncate(4 * 1_024 * 1_024 * 1_024 + 1);
  } finally {
    await handle.close();
  }
}

export async function directoryManifest(
  root: string,
): Promise<readonly Readonly<Record<string, string | number>>[]> {
  const entries: Array<Readonly<Record<string, string | number>>> = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const child of children) {
      const path = join(directory, child.name);
      const information = await lstat(path, { bigint: true });
      const relativePath = relative(root, path).split(sep).join("/");
      if (information.isDirectory()) {
        entries.push(
          Object.freeze({
            relativePath: `${relativePath}/`,
            mode: Number(information.mode & 0o777n),
            mtimeNanoseconds: information.mtimeNs.toString(),
          }),
        );
        await visit(path);
      } else if (information.isFile()) {
        const bytes = await readFile(path);
        entries.push(
          Object.freeze({
            relativePath,
            length: bytes.length,
            digest: createHash("sha256").update(bytes).digest("hex"),
            mode: Number(information.mode & 0o777n),
            mtimeNanoseconds: information.mtimeNs.toString(),
          }),
        );
      } else {
        entries.push(Object.freeze({ relativePath, kind: "other" }));
      }
    }
  };
  await visit(root);
  return Object.freeze(entries);
}
