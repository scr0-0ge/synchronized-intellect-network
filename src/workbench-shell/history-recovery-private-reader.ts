import {
  cp,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  historyRecoveryBounds,
  type HistoryRecoveryCounts,
} from "./history-recovery-contract.ts";
import {
  cloneEffectiveSessionProfileProjection,
  cloneRequestedSessionProfileProjection,
} from "../coordinator/profile-projection.ts";

const ledgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const statuses = Object.freeze([
  "accepted",
  "in-flight",
  "completed",
  "failed",
  "recovery-required",
] as const);
const conceptualTables = [
  "commands",
  "projects",
  "sessions",
  "updates",
] as const;
const versionOneColumns = Object.freeze({
  projects: ["project_id", "directory_digest"],
  commands: [
    "command_id",
    "project_id",
    "idempotency_digest",
    "payload_digest",
    "runtime",
    "status",
    "failure_category",
    "accepted_cursor",
  ],
  sessions: ["session_id", "command_id", "profile_json"],
  updates: [
    "cursor",
    "project_id",
    "command_id",
    "kind",
    "status",
    "session_id",
    "data_json",
  ],
});
const versionTwoColumns = Object.freeze({
  projects: ["project_id", "directory_digest"],
  commands: [
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
  ],
  sessions: [
    "session_id",
    "project_id",
    "root_command_id",
    "profile_json",
    "opaque_session_reference",
    "lifecycle_status",
  ],
  updates: versionOneColumns.updates,
});
const maximumStoredJsonBytes = 1024 * 1024;
const maximumStoredJsonDepth = 32;
const maximumStoredJsonNodes = 100_000;
const maximumStoredJsonProperties = 200_000;
const runtimeFailureCategories = new Set([
  "approval-required",
  "authentication-required",
  "catalog-invalid",
  "correlation-invalid",
  "invalid-input",
  "protocol-invalid",
  "protocol-rejected",
  "runtime-shutdown",
  "runtime-not-located",
  "runtime-unavailable",
  "temp-cleanup",
  "temp-cleanup-guard",
  "transport-failed",
  "turn-failed",
  "unexpected-server-request",
  "unsupported-selection",
]);

type RecoveryStatus = (typeof statuses)[number];

export interface HistoryRecoveryPrivateTurn {
  readonly status: RecoveryStatus;
  readonly eventCount: number;
}

export interface HistoryRecoveryPrivateSession {
  readonly status: RecoveryStatus;
  readonly turns: readonly HistoryRecoveryPrivateTurn[];
}

export interface HistoryRecoveryPrivateProject {
  readonly counts: HistoryRecoveryCounts;
  readonly sessions: readonly HistoryRecoveryPrivateSession[];
}

export interface HistoryRecoveryPrivateInventory {
  readonly readerVersion: 1 | 2;
  readonly counts: HistoryRecoveryCounts;
  readonly projects: readonly HistoryRecoveryPrivateProject[];
}

export class HistoryRecoveryPrivateReaderError extends Error {
  readonly category:
    | "invalid-registry"
    | "unsupported-artifact"
    | "unsupported-schema"
    | "verification-failed";

  constructor(
    category:
      | "invalid-registry"
      | "unsupported-artifact"
      | "unsupported-schema"
      | "verification-failed",
  ) {
    super(category);
    this.category = category;
  }
}

interface RegistryRecord {
  readonly ledgerSlot: string;
}

export async function readHistoricalRecoveryInventory(
  capturedRoot: string,
  options: {
    readonly deadline?: number;
    readonly now?: () => number;
  } = {},
): Promise<HistoryRecoveryPrivateInventory> {
  const checkDeadline = (): void => {
    if (
      options.deadline !== undefined &&
      (options.now ?? Date.now)() > options.deadline
    ) {
      throw new Error("capture-deadline");
    }
  };
  checkDeadline();
  const disposable = await mkdtemp(join(tmpdir(), "uaw-history-reader-"));
  const disposableRoot = join(disposable, "copy");
  try {
    checkDeadline();
    await cp(capturedRoot, disposableRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    checkDeadline();
    const registry = await readRegistry(disposableRoot, checkDeadline);
    await assertArtifactSet(disposableRoot, registry, checkDeadline);
    const projects: HistoryRecoveryPrivateProject[] = [];
    let readerVersion: 1 | 2 | undefined;
    for (const record of registry) {
      checkDeadline();
      const ledgerPath = join(
        disposableRoot,
        "project-ledgers",
        `${record.ledgerSlot}.sqlite`,
      );
      await prepareDisposableTransactionArtifacts(ledgerPath, checkDeadline);
      checkDeadline();
      const project = readLedger(ledgerPath, checkDeadline);
      if (readerVersion !== undefined && readerVersion !== project.version) {
        throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
      }
      readerVersion = project.version;
      projects.push(project.project);
    }
    checkDeadline();
    const counts = sumCounts(projects.map((project) => project.counts));
    return deepFreeze({
      readerVersion: readerVersion ?? 2,
      counts,
      projects,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "capture-deadline") {
      throw error;
    }
    if (error instanceof HistoryRecoveryPrivateReaderError) throw error;
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  } finally {
    await rm(disposable, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readRegistry(
  root: string,
  checkDeadline: () => void,
): Promise<readonly RegistryRecord[]> {
  checkDeadline();
  let text: string;
  try {
    const path = join(root, "project-registry-v1.json");
    const information = await lstat(path);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size > 256 * 1_024
    ) {
      throw new Error("invalid-registry");
    }
    text = await readFile(path, "utf8");
    checkDeadline();
  } catch {
    throw new HistoryRecoveryPrivateReaderError("invalid-registry");
  }
  if (Buffer.byteLength(text, "utf8") > 256 * 1_024) {
    throw new HistoryRecoveryPrivateReaderError("invalid-registry");
  }
  try {
    assertNoDuplicateJsonObjectKeys(text);
  } catch {
    throw new HistoryRecoveryPrivateReaderError("invalid-registry");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HistoryRecoveryPrivateReaderError("invalid-registry");
  }
  const registry = exactRecord(value, [
    "nextProjectOrdinal",
    "records",
    "revision",
    "schemaVersion",
    "selectedRecordKey",
  ]);
  if (
    registry === undefined ||
    registry.schemaVersion !== 1 ||
    !isInteger(registry.revision, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !isInteger(registry.nextProjectOrdinal, 1, Number.MAX_SAFE_INTEGER - 1) ||
    (registry.selectedRecordKey !== null &&
      typeof registry.selectedRecordKey !== "string") ||
    !Array.isArray(registry.records) ||
    registry.records.length > 1_000
  ) {
    throw new HistoryRecoveryPrivateReaderError("invalid-registry");
  }
  const records: RegistryRecord[] = [];
  const slots = new Set<string>();
  const recordKeys = new Set<string>();
  for (const value of registry.records) {
    checkDeadline();
    const record = exactRecord(value, [
      "canonicalDirectory",
      "ledgerSlot",
      "recordKey",
    ]);
    if (
      record === undefined ||
      typeof record.canonicalDirectory !== "string" ||
      record.canonicalDirectory.trim().length === 0 ||
      typeof record.recordKey !== "string" ||
      typeof record.ledgerSlot !== "string" ||
      !ledgerSlotPattern.test(record.ledgerSlot) ||
      slots.has(record.ledgerSlot) ||
      recordKeys.has(record.recordKey)
    ) {
      throw new HistoryRecoveryPrivateReaderError("invalid-registry");
    }
    slots.add(record.ledgerSlot);
    recordKeys.add(record.recordKey);
    records.push(Object.freeze({ ledgerSlot: record.ledgerSlot }));
  }
  if (
    registry.nextProjectOrdinal < records.length + 1 ||
    (records.length === 0 && registry.selectedRecordKey !== null) ||
    (records.length > 0 &&
      (typeof registry.selectedRecordKey !== "string" ||
        !recordKeys.has(registry.selectedRecordKey)))
  ) {
    throw new HistoryRecoveryPrivateReaderError("invalid-registry");
  }
  return Object.freeze(records);
}

async function assertArtifactSet(
  root: string,
  records: readonly RegistryRecord[],
  checkDeadline: () => void,
): Promise<void> {
  checkDeadline();
  const allowedRoot = new Set([
    "project-registry-v1.json",
    "project-ledgers",
    "create-project-operation-v1.json",
    "work-ledger-auth-generations-v1.json",
    "work-ledger-auth-generations-v1.initialized",
  ]);
  const rootEntries = await readdir(root, { withFileTypes: true });
  checkDeadline();
  if (
    rootEntries.some(
      (entry) =>
        entry.isSymbolicLink() ||
        entry.name.endsWith(".replacement") ||
        entry.name.endsWith(".backup") ||
        !allowedRoot.has(entry.name) ||
        (entry.name === "project-ledgers"
          ? !entry.isDirectory()
          : !entry.isFile()),
    )
  ) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
  }
  const hasLedgerDirectory = rootEntries.some(
    (entry) => entry.name === "project-ledgers",
  );
  if (!hasLedgerDirectory && records.length > 0) {
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  }
  if (!hasLedgerDirectory) return;
  const ledgerDirectory = join(root, "project-ledgers");
  const ledgerDirectoryEntries = await readdir(ledgerDirectory, {
    withFileTypes: true,
  });
  checkDeadline();
  if (
    ledgerDirectoryEntries.some(
      (entry) => entry.isSymbolicLink() || !entry.isFile(),
    )
  ) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
  }
  const ledgerEntries = ledgerDirectoryEntries.map((entry) => entry.name).sort();
  const expectedBases = new Set(records.map((record) => `${record.ledgerSlot}.sqlite`));
  for (const name of ledgerEntries) {
    checkDeadline();
    const base = name
      .replace(/-wal$/u, "")
      .replace(/-shm$/u, "")
      .replace(/-journal$/u, "");
    if (!expectedBases.has(base)) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
    }
    if (
      name !== base &&
      name !== `${base}-wal` &&
      name !== `${base}-shm` &&
      name !== `${base}-journal`
    ) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
    }
  }
  for (const base of expectedBases) {
    checkDeadline();
    if (!ledgerEntries.includes(base)) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
  }
}

async function prepareDisposableTransactionArtifacts(
  ledgerPath: string,
  checkDeadline: () => void,
): Promise<void> {
  checkDeadline();
  const wal = await fileExists(`${ledgerPath}-wal`);
  const shm = await fileExists(`${ledgerPath}-shm`);
  const journalPath = `${ledgerPath}-journal`;
  const journal = await fileExists(journalPath);
  if (shm && !wal) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
  }
  if (wal && journal) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
  }
  if (wal) await assertWalHeader(`${ledgerPath}-wal`);
  if (shm) await unlink(`${ledgerPath}-shm`);
  if (!journal) return;
  checkDeadline();
  const handle = await open(journalPath, "r");
  const rollbackMagic = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
  try {
    const information = await handle.stat();
    const header = Buffer.allocUnsafe(8);
    const read = await handle.read(header, 0, header.length, 0);
    if (
      information.size < 512 ||
      read.bytesRead !== header.length ||
      !header.equals(rollbackMagic)
    ) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
    }
  } finally {
    await handle.close();
  }
  // A valid hot-journal header may be recovered only here, on this disposable copy.
}

async function assertWalHeader(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const information = await handle.stat();
    const header = Buffer.allocUnsafe(32);
    const read = await handle.read(header, 0, header.length, 0);
    const magic = header.readUInt32BE(0);
    const encodedPageSize = header.readUInt32BE(8);
    const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    if (
      information.size <= 32 ||
      read.bytesRead !== header.length ||
      (magic !== 0x377f0682 && magic !== 0x377f0683) ||
      pageSize < 512 ||
      pageSize > 65_536 ||
      (pageSize & (pageSize - 1)) !== 0 ||
      (information.size - 32) % (pageSize + 24) !== 0
    ) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-artifact");
    }
  } finally {
    await handle.close();
  }
}

function readLedger(ledgerPath: string, checkDeadline: () => void): {
  readonly version: 1 | 2;
  readonly project: HistoryRecoveryPrivateProject;
} {
  checkDeadline();
  const database = new DatabaseSync(ledgerPath);
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    const integrity = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{
      integrity_check: string;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
    const versionRow = database.prepare("PRAGMA user_version").get() as {
      user_version?: unknown;
    };
    const version = Number(versionRow.user_version);
    if (version !== 1 && version !== 2) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
    }
    assertSchema(database, version);
    const projectCount = readCount(database, "SELECT COUNT(*) AS count FROM projects");
    if (projectCount !== 1) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
    assertLedgerRows(database, version);
    checkDeadline();
    const commandCount = readCount(database, "SELECT COUNT(*) AS count FROM commands");
    const updateCount = readCount(database, "SELECT COUNT(*) AS count FROM updates");
    const sessionRows = version === 1
      ? (database
          .prepare(
            `SELECT session.session_id, command.command_id, command.status
               FROM sessions AS session
               JOIN commands AS command ON command.command_id = session.command_id
              ORDER BY command.accepted_cursor, command.command_id`,
          )
          .all() as unknown as Array<{
          session_id: string;
          command_id: string;
          status: unknown;
        }>)
      : (database
          .prepare(
            `SELECT session.session_id, session.lifecycle_status AS status
               FROM sessions AS session
               JOIN commands AS root ON root.command_id = session.root_command_id
              ORDER BY root.accepted_cursor, root.command_id`,
          )
          .all() as unknown as Array<{
          session_id: string;
          status: unknown;
        }>);
    const sessions: HistoryRecoveryPrivateSession[] = [];
    for (const session of sessionRows) {
      checkDeadline();
      const status = recoveryStatus(session.status);
      const commands = version === 1
        ? [
            Object.freeze({
              command_id: (session as unknown as { command_id: string }).command_id,
              status,
            }),
          ]
        : (database
            .prepare(
              `SELECT command_id, status
                 FROM commands
                WHERE target_session_id = ?
                ORDER BY accepted_cursor, command_id`,
            )
            .all(session.session_id) as unknown as Array<{
            command_id: string;
            status: unknown;
          }>);
      const turns = commands.map((command) =>
        {
          checkDeadline();
          return Object.freeze({
            status: recoveryStatus(command.status),
            eventCount: readBoundedCount(
              database,
              "SELECT COUNT(*) AS count FROM updates WHERE command_id = ?",
              command.command_id,
            ),
          });
        },
      );
      if (turns.length === 0) {
        throw new HistoryRecoveryPrivateReaderError("verification-failed");
      }
      sessions.push(Object.freeze({ status, turns: Object.freeze(turns) }));
    }
    if (sessions.length !== sessionRows.length) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
    if (
      sessions.reduce((sum, session) => sum + session.turns.length, 0) !==
      commandCount
    ) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
    return deepFreeze({
      version,
      project: {
        counts: {
          projects: 1,
          sessions: sessions.length,
          commands: commandCount,
          updates: updateCount,
        },
        sessions,
      },
    });
  } finally {
    database.close();
  }
}

function assertSchema(database: DatabaseSync, version: 1 | 2): void {
  const tables = (
    database
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
  if (!sameStrings(tables, conceptualTables)) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
  }
  const expected = version === 1 ? versionOneColumns : versionTwoColumns;
  for (const table of conceptualTables) {
    const tableShape = database
      .prepare(
        "SELECT ncol, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?",
      )
      .get(table) as { ncol?: unknown; strict?: unknown } | undefined;
    const columns = (
      database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    if (
      tableShape === undefined ||
      Number(tableShape.strict) !== 1 ||
      Number(tableShape.ncol) !== expected[table].length ||
      !sameStrings(columns, expected[table])
    ) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
    }
  }
  assertForeignKeyShape(database, version);
  assertUniqueShape(database, version);
  assertConstraintShape(database, version);
}

function assertForeignKeyShape(database: DatabaseSync, version: 1 | 2): void {
  const expected = {
    projects: [],
    commands: ["project_id->projects.project_id"],
    sessions:
      version === 1
        ? ["command_id->commands.command_id"]
        : [
            "project_id->projects.project_id",
            "root_command_id->commands.command_id",
          ],
    updates: [
      "command_id->commands.command_id",
      "project_id->projects.project_id",
    ],
  } as const;
  for (const table of conceptualTables) {
    const actual = (
      database.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as Array<{
        from: string;
        table: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>
    )
      .map((row) => {
        if (row.on_update !== "NO ACTION" || row.on_delete !== "NO ACTION") {
          throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
        }
        return `${row.from}->${row.table}.${row.to}`;
      })
      .sort();
    if (!sameStrings(actual, [...expected[table]].sort())) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
    }
  }
}

function assertUniqueShape(database: DatabaseSync, version: 1 | 2): void {
  const expected = {
    projects: ["directory_digest", "project_id"],
    commands: ["command_id", "project_id,idempotency_digest"],
    sessions:
      version === 1
        ? ["command_id", "session_id"]
        : ["root_command_id", "session_id"],
    updates: [],
  } as const;
  for (const table of conceptualTables) {
    const indexes = database
      .prepare(`PRAGMA index_list(${table})`)
      .all() as unknown as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const actual = indexes
      .filter((index) => Number(index.unique) === 1 && Number(index.partial) === 0)
      .map((index) =>
        (
          database.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as Array<{
            seqno: number;
            name: string;
          }>
        )
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((column) => column.name)
          .join(","),
      )
      .sort();
    if (!sameStrings(actual, [...expected[table]].sort())) {
      throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
    }
  }
}

function assertConstraintShape(database: DatabaseSync, version: 1 | 2): void {
  const sqlFor = (table: string): string => {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string") {
      throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
    }
    return row.sql.toLowerCase().replace(/\s+/gu, "");
  };
  const updates = sqlFor("updates");
  if (!updates.includes("autoincrement")) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
  }
  if (version === 1) return;
  const commands = sqlFor("commands");
  const sessions = sqlFor("sessions");
  const requiredCommandFragments = [
    "check(digest_versionin(1,2))",
    "check(command_kindin('start','continue'))",
    "check(runtime='codex')",
    "check(statusin('accepted','in-flight','completed','failed','recovery-required'))",
    "check(accepted_cursor>=0)",
    "check(effect_phasein('legacy','unclaimed','binding-claimed','binding-ready','send-claimed','awaiting-terminal','committed'))",
    "check(outcome_uncertainin(0,1))",
  ];
  if (
    requiredCommandFragments.some((fragment) => !commands.includes(fragment)) ||
    !sessions.includes(
      "check(lifecycle_statusin('accepted','in-flight','completed','failed','recovery-required'))",
    )
  ) {
    throw new HistoryRecoveryPrivateReaderError("unsupported-schema");
  }
}

function assertLedgerRows(database: DatabaseSync, version: 1 | 2): void {
  const invalidCommonCommand = database
    .prepare(
      `SELECT 1
         FROM commands
        WHERE runtime <> 'codex'
           OR status NOT IN (
             'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
           )
           OR accepted_cursor < 0
           OR trim(command_id) = ''
           OR trim(project_id) = ''
           OR trim(idempotency_digest) = ''
           OR trim(payload_digest) = ''
        LIMIT 1`,
    )
    .get();
  if (invalidCommonCommand !== undefined) {
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  }
  if (version === 1) {
    const invalidVersionOne = database
      .prepare(
        `SELECT 1
           FROM sessions AS session
          WHERE trim(session.session_id) = ''
             OR trim(session.profile_json) = ''
             OR NOT EXISTS (
               SELECT 1 FROM commands AS command
                WHERE command.command_id = session.command_id
             )
          LIMIT 1`,
      )
      .get();
    const orphanCommand = database
      .prepare(
        `SELECT 1 FROM commands AS command
          WHERE NOT EXISTS (
            SELECT 1 FROM sessions AS session
             WHERE session.command_id = command.command_id
          )
          LIMIT 1`,
      )
      .get();
    if (invalidVersionOne !== undefined || orphanCommand !== undefined) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
  } else {
    const invalidCommand = database
      .prepare(
        `SELECT 1
           FROM commands
          WHERE digest_version NOT IN (1, 2)
             OR command_kind NOT IN ('start', 'continue')
             OR outcome_uncertain NOT IN (0, 1)
             OR effect_phase NOT IN (
               'legacy', 'unclaimed', 'binding-claimed', 'binding-ready',
               'send-claimed', 'awaiting-terminal', 'committed'
             )
             OR (digest_version = 1 AND effect_phase <> 'legacy')
             OR (digest_version = 2 AND (
               private_envelope_json IS NULL OR trim(private_envelope_json) = ''
               OR target_session_id IS NULL OR effect_phase = 'legacy'
             ))
          LIMIT 1`,
      )
      .get();
    const invalidSession = database
      .prepare(
        `SELECT 1
           FROM sessions
          WHERE lifecycle_status NOT IN (
            'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
          )
             OR trim(session_id) = ''
             OR trim(project_id) = ''
             OR trim(root_command_id) = ''
             OR trim(profile_json) = ''
             OR (opaque_session_reference IS NOT NULL
                 AND trim(opaque_session_reference) = '')
          LIMIT 1`,
      )
      .get();
    const invalidLink = database
      .prepare(
        `SELECT 1
           FROM commands AS command
           LEFT JOIN sessions AS session
             ON session.session_id = command.target_session_id
            AND session.project_id = command.project_id
          WHERE session.session_id IS NULL
             OR (command.digest_version = 2 AND command.command_kind = 'start'
                 AND session.root_command_id <> command.command_id)
             OR (command.digest_version = 2 AND command.command_kind = 'continue'
                 AND session.root_command_id = command.command_id)
          LIMIT 1`,
      )
      .get();
    if (
      invalidCommand !== undefined ||
      invalidSession !== undefined ||
      invalidLink !== undefined
    ) {
      throw new HistoryRecoveryPrivateReaderError("verification-failed");
    }
  }
  const updates = database
    .prepare(
      `SELECT cursor, kind, status, session_id, data_json
         FROM updates
        ORDER BY cursor`,
    )
    .all() as unknown as Array<{
    cursor: unknown;
    kind: unknown;
    status: unknown;
    session_id: unknown;
    data_json: unknown;
  }>;
  const updateKinds = new Set([
    "accepted",
    "in-flight",
    "completed",
    "recovery-required",
    "profile-resolved",
    "runtime-event",
    "failed",
  ]);
  try {
    for (const update of updates) {
      if (
        !isInteger(update.cursor, 1, historyRecoveryBounds.maximumCount) ||
        typeof update.kind !== "string" ||
        !updateKinds.has(update.kind) ||
        !statuses.includes(update.status as RecoveryStatus) ||
        (update.session_id !== null &&
          (typeof update.session_id !== "string" || update.session_id.length === 0)) ||
        (update.data_json !== null && typeof update.data_json !== "string") ||
        ((update.kind === "profile-resolved" || update.kind === "runtime-event") &&
          typeof update.session_id !== "string")
      ) {
        throw new Error("invalid-update");
      }
      assertStoredUpdatePayload(update);
    }
    const jsonRows = database
      .prepare("SELECT profile_json FROM sessions")
      .all() as unknown as Array<{ profile_json: string }>;
    for (const row of jsonRows) {
      if (!isStoredProfile(parseExactStoredJson(row.profile_json))) {
        throw new Error("invalid-profile-row");
      }
    }
    const privateEnvelopes = version === 1
      ? []
      : (database
          .prepare(
            `SELECT command_kind, target_session_id, private_envelope_json
               FROM commands
              WHERE private_envelope_json IS NOT NULL`,
          )
          .all() as unknown as Array<{
          command_kind: "start" | "continue";
          target_session_id: string;
          private_envelope_json: string;
        }>);
    for (const row of privateEnvelopes) {
      assertStoredPrivateEnvelope(
        parseExactStoredJson(row.private_envelope_json),
        row.command_kind,
        row.target_session_id,
      );
    }
  } catch {
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  }
}

function parseExactStoredJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > maximumStoredJsonBytes) {
    throw new Error("oversized-stored-json");
  }
  assertNoDuplicateJsonObjectKeys(text);
  const value = JSON.parse(text) as unknown;
  assertBoundedJsonGraph(value);
  return value;
}

function assertBoundedJsonGraph(value: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  let properties = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (
      nodes > maximumStoredJsonNodes ||
      current.depth > maximumStoredJsonDepth
    ) {
      throw new Error("oversized-stored-json-graph");
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    properties += children.length;
    if (properties > maximumStoredJsonProperties) {
      throw new Error("oversized-stored-json-graph");
    }
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function assertStoredPrivateEnvelope(
  value: unknown,
  commandKind: "start" | "continue",
  targetSessionId: string,
): void {
  const common = [
    "commandKind",
    "idempotencyKey",
    "input",
    "kind",
    "profile",
    "runtime",
  ] as const;
  const record = commandKind === "start"
    ? closedRecord(
        value,
        [...common, "catalogRevision", "preferences"],
        ["overrides", "requestedProfileProjection"],
      )
    : closedRecord(
        value,
        [...common, "targetSessionId"],
        ["profileProjection"],
      );
  if (
    record === undefined ||
    record.kind !== "direct" ||
    record.commandKind !== commandKind ||
    record.runtime !== "codex" ||
    !isBoundedStoredText(record.idempotencyKey, 16 * 1_024) ||
    !isBoundedStoredText(record.input, maximumStoredJsonBytes) ||
    !isStoredProfile(record.profile)
  ) {
    throw new Error("invalid-private-envelope");
  }
  if (commandKind === "start") {
    if (
      !isBoundedStoredText(record.catalogRevision, 4 * 1_024) ||
      !isStoredPreferenceLayers(record.preferences) ||
      (record.overrides !== undefined &&
        !isStoredProfilePreferences(record.overrides, true)) ||
      (record.requestedProfileProjection !== undefined &&
        !isRequestedProfileProjection(record.requestedProfileProjection))
    ) {
      throw new Error("invalid-private-envelope");
    }
    return;
  }
  if (
    record.targetSessionId !== targetSessionId ||
    !isBoundedStoredText(record.targetSessionId, 4 * 1_024)
  ) {
    throw new Error("invalid-private-envelope");
  }
  if (record.profileProjection !== undefined) {
    const projection = exactRecord(record.profileProjection, [
      "requested",
      "version",
    ]);
    if (
      projection === undefined ||
      projection.version !== 1 ||
      !isRequestedProfileProjection(projection.requested)
    ) {
      throw new Error("invalid-private-envelope");
    }
  }
}

function isStoredPreferenceLayers(value: unknown): boolean {
  const record = closedRecord(value, [], ["global", "models", "runtime"]);
  if (record === undefined) return false;
  if (
    record.global !== undefined &&
    !isStoredProfilePreferences(record.global, true)
  ) {
    return false;
  }
  if (
    record.runtime !== undefined &&
    !isStoredProfilePreferences(record.runtime, true)
  ) {
    return false;
  }
  if (record.models === undefined) return true;
  if (!isPlainRecord(record.models)) return false;
  const models = Object.entries(record.models);
  return models.length <= 1_000 &&
    models.every(
      ([model, preferences]) =>
        isBoundedStoredText(model, 1_024) &&
        isStoredProfilePreferences(preferences, false),
    );
}

function isStoredProfilePreferences(
  value: unknown,
  allowModel: boolean,
): boolean {
  const keys = allowModel
    ? ["accessMode", "effortLevel", "executionMode", "model"]
    : ["accessMode", "effortLevel", "executionMode"];
  const record = closedRecord(value, [], keys);
  return record !== undefined &&
    Object.values(record).every((entry) =>
      isBoundedStoredText(entry, 1_024)
    );
}

function isRequestedProfileProjection(value: unknown): boolean {
  try {
    cloneRequestedSessionProfileProjection(value);
    return true;
  } catch {
    return false;
  }
}

function isEffectiveProfileProjection(value: unknown): boolean {
  try {
    cloneEffectiveSessionProfileProjection(value);
    return true;
  } catch {
    return false;
  }
}

function isStoredProfile(value: unknown): boolean {
  const profile = exactRecord(value, [
    "accessMode",
    "effortLevel",
    "executionMode",
    "model",
  ]);
  return profile !== undefined &&
    isBoundedStoredText(profile.model, 1_024) &&
    isBoundedStoredText(profile.effortLevel, 1_024) &&
    profile.executionMode === "single-agent" &&
    profile.accessMode === "full-access";
}

function assertStoredUpdatePayload(update: {
  readonly kind: unknown;
  readonly status: unknown;
  readonly session_id: unknown;
  readonly data_json: unknown;
}): void {
  if (
    update.kind === "accepted" ||
    update.kind === "in-flight" ||
    update.kind === "recovery-required"
  ) {
    if (
      update.data_json !== null ||
      update.status !== update.kind
    ) {
      throw new Error("invalid-update-payload");
    }
    return;
  }
  if (update.kind === "completed") {
    if (update.status !== "completed") {
      throw new Error("invalid-update-payload");
    }
    if (update.data_json === null) return;
    const data = exactRecord(parseExactStoredJson(String(update.data_json)), [
      "effectiveProfileProjection",
    ]);
    if (
      data === undefined ||
      !isEffectiveProfileProjection(data.effectiveProfileProjection)
    ) {
      throw new Error("invalid-update-payload");
    }
    return;
  }
  if (typeof update.data_json !== "string") {
    throw new Error("invalid-update-payload");
  }
  const data = parseExactStoredJson(update.data_json);
  if (update.kind === "profile-resolved") {
    const record = exactRecord(data, ["profile"]);
    if (
      update.status !== "in-flight" ||
      typeof update.session_id !== "string" ||
      record === undefined ||
      !isStoredProfile(record.profile)
    ) {
      throw new Error("invalid-update-payload");
    }
    return;
  }
  if (update.kind === "runtime-event") {
    const record = exactRecord(data, ["event"]);
    if (
      update.status !== "in-flight" ||
      typeof update.session_id !== "string" ||
      record === undefined ||
      !isStoredRuntimeEvent(record.event)
    ) {
      throw new Error("invalid-update-payload");
    }
    return;
  }
  if (update.kind === "failed") {
    if (update.status !== "failed") {
      throw new Error("invalid-update-payload");
    }
    const record = closedRecord(
      data,
      ["failureCategory"],
      ["effectiveProfileProjection"],
    );
    if (
      record === undefined ||
      (record.failureCategory !== "profile-resolution-failed" &&
        record.failureCategory !== "runtime-failed") ||
      (record.effectiveProfileProjection !== undefined &&
        !isEffectiveProfileProjection(record.effectiveProfileProjection))
    ) {
      throw new Error("invalid-update-payload");
    }
    return;
  }
  throw new Error("invalid-update-payload");
}

function isStoredRuntimeEvent(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "session-started" || value.kind === "turn-started") {
    return exactRecord(value, ["kind"]) !== undefined;
  }
  if (value.kind === "item-started" || value.kind === "item-completed") {
    const event = exactRecord(value, ["itemType", "kind"]);
    return event !== undefined && event.itemType === "agent-message";
  }
  if (value.kind === "agent-message") {
    const event = exactRecord(value, ["kind", "text"]);
    return event !== undefined &&
      typeof event.text === "string" &&
      event.text.length <= maximumStoredJsonBytes &&
      !event.text.includes("\0");
  }
  if (value.kind === "failed") {
    const event = exactRecord(value, ["category", "kind"]);
    return event !== undefined &&
      typeof event.category === "string" &&
      runtimeFailureCategories.has(event.category);
  }
  if (value.kind !== "turn-completed") return false;
  const event = closedRecord(value, ["kind", "status"], ["context"]);
  return event !== undefined &&
    event.status === "completed" &&
    (event.context === undefined || isStoredRuntimeContext(event.context));
}

function isStoredRuntimeContext(value: unknown): boolean {
  const context = exactRecord(value, ["basis", "usedTokens", "windowTokens"]);
  if (
    context === undefined ||
    !isInteger(context.usedTokens, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }
  return context.basis === "turn-usage"
    ? context.windowTokens === null
    : context.basis === "active-context" &&
        isInteger(context.windowTokens, context.usedTokens, Number.MAX_SAFE_INTEGER);
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    return undefined;
  }
  const clone: Record<string, unknown> = {};
  for (const key of keys as string[]) clone[key] = value[key];
  return Object.freeze(clone);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isBoundedStoredText(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !value.includes("\0");
}

function readCount(database: DatabaseSync, sql: string): number {
  return readBoundedCount(database, sql);
}

function readBoundedCount(
  database: DatabaseSync,
  sql: string,
  ...parameters: (string | number)[]
): number {
  const row = database.prepare(sql).get(...parameters) as { count?: unknown };
  const count = Number(row.count);
  if (!isInteger(count, 0, historyRecoveryBounds.maximumCount)) {
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  }
  return count;
}

function recoveryStatus(value: unknown): RecoveryStatus {
  if (!statuses.includes(value as RecoveryStatus)) {
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  }
  return value as RecoveryStatus;
}

function sumCounts(counts: readonly HistoryRecoveryCounts[]): HistoryRecoveryCounts {
  const total = counts.reduce(
    (sum, value) => ({
      projects: sum.projects + value.projects,
      sessions: sum.sessions + value.sessions,
      commands: sum.commands + value.commands,
      updates: sum.updates + value.updates,
    }),
    { projects: 0, sessions: 0, commands: 0, updates: 0 },
  );
  if (Object.values(total).some((value) => value > historyRecoveryBounds.maximumCount)) {
    throw new HistoryRecoveryPrivateReaderError("verification-failed");
  }
  return Object.freeze(total);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const information = await lstat(path);
    return information.isFile() && !information.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return undefined;
  }
  const clone: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return undefined;
    }
    clone[key] = descriptor.value;
  }
  return Object.freeze(clone);
}

function assertNoDuplicateJsonObjectKeys(contents: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/u.test(contents[index] ?? "")) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (contents[index] !== '"') throw new Error("invalid-json");
    index += 1;
    while (index < contents.length) {
      if (contents[index] === "\\") {
        index += 2;
      } else if (contents[index] === '"') {
        index += 1;
        return JSON.parse(contents.slice(start, index)) as string;
      } else {
        index += 1;
      }
    }
    throw new Error("invalid-json");
  };
  const parseValue = (depth = 0): void => {
    if (depth > maximumStoredJsonDepth) throw new Error("json-too-deep");
    skipWhitespace();
    if (contents[index] === "{") return parseObject(depth + 1);
    if (contents[index] === "[") return parseArray(depth + 1);
    if (contents[index] === '"') {
      parseString();
      return;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
      contents.slice(index),
    );
    if (match === null) throw new Error("invalid-json");
    index += match[0].length;
  };
  const parseObject = (depth: number): void => {
    index += 1;
    const keys = new Set<string>();
    skipWhitespace();
    if (contents[index] === "}") {
      index += 1;
      return;
    }
    while (index < contents.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw new Error("duplicate-key");
      keys.add(key);
      skipWhitespace();
      if (contents[index] !== ":") throw new Error("invalid-json");
      index += 1;
      parseValue(depth);
      skipWhitespace();
      if (contents[index] === "}") {
        index += 1;
        return;
      }
      if (contents[index] !== ",") throw new Error("invalid-json");
      index += 1;
    }
    throw new Error("invalid-json");
  };
  const parseArray = (depth: number): void => {
    index += 1;
    skipWhitespace();
    if (contents[index] === "]") {
      index += 1;
      return;
    }
    while (index < contents.length) {
      parseValue(depth);
      skipWhitespace();
      if (contents[index] === "]") {
        index += 1;
        return;
      }
      if (contents[index] !== ",") throw new Error("invalid-json");
      index += 1;
    }
    throw new Error("invalid-json");
  };
  parseValue();
  skipWhitespace();
  if (index !== contents.length) throw new Error("invalid-json");
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
