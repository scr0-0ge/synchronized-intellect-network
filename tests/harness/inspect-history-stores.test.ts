import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

interface FileSnapshot {
  readonly bytes: Buffer;
  readonly mtimeNanoseconds: bigint;
}

const inspectorPath = fileURLToPath(
  new URL("../../scripts/inspect-history-stores.ts", import.meta.url),
);

test("history-store inspection leaves a DB + WAL store byte-for-byte unchanged", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "uaw-w84-inspect-"));
  try {
    const appData = join(temporaryRoot, "appdata");
    const hostRoot = join(
      appData,
      "synchronized-intellect-network",
      "workbench-project-host",
    );
    const ledgerDirectory = join(hostRoot, "project-ledgers");
    const slot =
      "project-ledger-v1-00000000-0000-4000-8000-000000000084";
    const ledgerPath = join(ledgerDirectory, `${slot}.sqlite`);
    const inactiveSlot =
      "project-ledger-v1-00000000-0000-4000-8000-000000000085";
    const inactiveLedgerPath = join(ledgerDirectory, `${inactiveSlot}.sqlite`);
    mkdirSync(ledgerDirectory, { recursive: true });
    seedWalOnlyLedger(join(temporaryRoot, "staging.sqlite"), ledgerPath);
    seedInactiveLedger(inactiveLedgerPath);
    writeFileSync(
      join(hostRoot, "project-registry-v1.json"),
      JSON.stringify({
        records: [
          { ledgerSlot: slot, canonicalDirectory: "C:\\synthetic\\w84-project" },
          {
            ledgerSlot: inactiveSlot,
            canonicalDirectory: "C:\\synthetic\\w84-inactive-project",
          },
        ],
      }),
    );

    assert.equal(statSync(`${ledgerPath}-wal`).isFile(), true);
    assert.equal(fileExists(`${ledgerPath}-shm`), false);
    const before = snapshotFiles(appData);

    const inspection = spawnSync(
      process.execPath,
      ["--no-warnings", inspectorPath],
      {
        encoding: "utf8",
        env: { ...process.env, APPDATA: appData },
        timeout: 10_000,
        windowsHide: true,
      },
    );

    assert.equal(inspection.status, 0, inspection.stderr);
    assert.match(
      inspection.stdout,
      /sessions=unconfirmed commands=unconfirmed updates=unconfirmed schema=unconfirmed/u,
    );
    assert.match(
      inspection.stdout,
      /counts unconfirmed within zero-write boundary: transaction sidecar present/u,
    );
    assert.match(
      inspection.stdout,
      new RegExp(
        `${inactiveSlot}\\r?\\n` +
          "        sessions=2 commands=1 updates=3 schema=v9",
        "u",
      ),
    );
    assert.equal(fileExists(`${ledgerPath}-shm`), false);

    const after = snapshotFiles(appData);
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [path, expected] of before) {
      const actual = after.get(path);
      assert.ok(actual);
      assert.deepEqual(actual.bytes, expected.bytes, `${path} bytes changed`);
      assert.equal(
        actual.mtimeNanoseconds,
        expected.mtimeNanoseconds,
        `${path} mtime changed`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function seedInactiveLedger(ledgerPath: string): void {
  const database = new DatabaseSync(ledgerPath);
  try {
    database.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY);
      CREATE TABLE commands(id TEXT PRIMARY KEY);
      CREATE TABLE updates(id TEXT PRIMARY KEY);
      PRAGMA user_version = 9;
      INSERT INTO sessions VALUES ('session-one'), ('session-two');
      INSERT INTO commands VALUES ('command-one');
      INSERT INTO updates VALUES ('update-one'), ('update-two'), ('update-three');
    `);
  } finally {
    database.close();
  }
}

function seedWalOnlyLedger(stagingPath: string, ledgerPath: string): void {
  const database = new DatabaseSync(stagingPath);
  try {
    database.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY);
      CREATE TABLE commands(id TEXT PRIMARY KEY);
      CREATE TABLE updates(id TEXT PRIMARY KEY);
      PRAGMA user_version = 7;
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      INSERT INTO sessions VALUES ('session-green');
      INSERT INTO commands VALUES ('command-green');
      INSERT INTO updates VALUES ('update-green');
    `);
    copyFileSync(stagingPath, ledgerPath);
    copyFileSync(`${stagingPath}-wal`, `${ledgerPath}-wal`);
  } finally {
    database.close();
  }
}

function snapshotFiles(root: string): Map<string, FileSnapshot> {
  const snapshots = new Map<string, FileSnapshot>();
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name, "en-US"),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      assert.equal(entry.isFile(), true);
      snapshots.set(relative(root, path).replaceAll("\\", "/"), {
        bytes: readFileSync(path),
        mtimeNanoseconds: statSync(path, { bigint: true }).mtimeNs,
      });
    }
  };
  visit(root);
  return snapshots;
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
