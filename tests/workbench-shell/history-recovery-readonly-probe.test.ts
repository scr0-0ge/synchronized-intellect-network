import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTestDirectory } from "../helpers/test-lifecycle.ts";
import {
  createSyntheticStore,
  syntheticLedgerSlot,
} from "./fixtures/synthetic-history-recovery-fixtures.ts";

const execFileAsync = promisify(execFile);
const probePath = join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "probe-history-recovery-readiness.ts",
);

test(
  "read-only desktop probe finds two synthetic historical stores without exposing or changing them",
  { skip: process.platform !== "win32" },
  async (t) => {
    const appData = await createTestDirectory(
      t,
      join(tmpdir(), "w79-history-probe-stores-"),
    );
    await createSyntheticStore(
      join(appData, "Electron", "workbench-project-host"),
      2,
    );
    await createSyntheticStore(
      join(appData, "unified-agent-workbench", "workbench-project-host"),
      1,
    );
    const before = await treeSnapshot(appData);

    const result = await execFileAsync(process.execPath, [probePath], {
      env: { ...process.env, APPDATA: appData },
      encoding: "utf8",
      windowsHide: true,
    });

    assert.equal(result.stderr, "");
    assert.match(result.stdout, /结论: 能发现 2 个历史库/u);
    assert.match(
      result.stdout,
      /Electron[\s\S]*Project: 1 \| Session: 1 \| Command: 2[\s\S]*发现结果: 可发现 \| 保全预检: 通过/u,
    );
    assert.match(
      result.stdout,
      /unified-agent-workbench[\s\S]*Project: 1 \| Session: 1 \| Command: 1[\s\S]*发现结果: 可发现 \| 保全预检: 通过/u,
    );
    assert.match(
      result.stdout,
      /Unified Agent Workbench[\s\S]*workbench-project-host 存在: 否[\s\S]*发现结果: 未发现/u,
    );
    assert.doesNotMatch(result.stdout, /synthetic start input/u);
    assert.doesNotMatch(result.stdout, /X:\/synthetic\/project/u);
    assert.doesNotMatch(result.stdout, new RegExp(syntheticLedgerSlot, "u"));
    assert.doesNotMatch(result.stdout, /\.sqlite/u);
    assert.deepEqual(await treeSnapshot(appData), before);
  },
);

test(
  "read-only desktop probe presents an empty machine as a successful zero result",
  { skip: process.platform !== "win32" },
  async (t) => {
    const appData = await createTestDirectory(
      t,
      join(tmpdir(), "w79-history-probe-empty-"),
    );
    const before = await readdir(appData);

    const result = await execFileAsync(process.execPath, [probePath], {
      env: { ...process.env, APPDATA: appData },
      encoding: "utf8",
      windowsHide: true,
    });

    assert.equal(result.stderr, "");
    assert.match(result.stdout, /结论: 一个历史库都发现不到/u);
    assert.equal((result.stdout.match(/发现结果: 未发现/gu) ?? []).length, 4);
    assert.deepEqual(await readdir(appData), before);
  },
);

test(
  "read-only desktop probe does not create a SQLite shared-memory file for a WAL store",
  { skip: process.platform !== "win32" },
  async (t) => {
    const appData = await createTestDirectory(
      t,
      join(tmpdir(), "w79-history-probe-wal-"),
    );
    const target = await createSyntheticStore(
      join(appData, "Electron", "workbench-project-host"),
      2,
    );
    const staging = await createSyntheticStore(join(appData, "staging"), 2);
    const targetLedger = target.ledgerPath;
    const stagingLedger = staging.ledgerPath;
    if (targetLedger === null || stagingLedger === null) {
      assert.fail("version 2 synthetic stores must include ledgers");
    }
    const writer = new DatabaseSync(stagingLedger);
    try {
      writer.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; " +
          "UPDATE sessions SET lifecycle_status = 'in-flight' WHERE session_id = 'session-1';",
      );
      await copyFile(stagingLedger, targetLedger);
      await copyFile(`${stagingLedger}-wal`, `${targetLedger}-wal`);
    } finally {
      writer.close();
    }
    const before = await treeSnapshot(appData);

    const result = await execFileAsync(process.execPath, [probePath], {
      env: { ...process.env, APPDATA: appData },
      encoding: "utf8",
      windowsHide: true,
    });

    assert.equal(result.stderr, "");
    assert.match(
      result.stdout,
      /Electron[\s\S]*Project: 1 \| Session: 纯只读边界内无法确认 \| Command: 纯只读边界内无法确认/u,
    );
    assert.deepEqual(await treeSnapshot(appData), before);
    assert.equal(
      (await readdir(join(appData, "Electron", "workbench-project-host", "project-ledgers")))
        .some((name) => name.endsWith("-shm")),
      false,
    );
  },
);

interface SnapshotEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "other";
  readonly size: bigint;
  readonly mtimeNanoseconds: bigint;
  readonly bytes?: Buffer;
}

async function treeSnapshot(root: string): Promise<readonly SnapshotEntry[]> {
  const snapshot: SnapshotEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const information = await lstat(path, { bigint: true });
      if (information.isDirectory()) {
        snapshot.push({
          path: `${relative(root, path)}/`,
          kind: "directory",
          size: information.size,
          mtimeNanoseconds: information.mtimeNs,
        });
        await visit(path);
      } else if (information.isFile()) {
        const handle = await open(path, "r");
        let bytes: Buffer;
        try {
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        snapshot.push({
          path: relative(root, path),
          kind: "file",
          size: information.size,
          mtimeNanoseconds: information.mtimeNs,
          bytes,
        });
      } else {
        snapshot.push({
          path: relative(root, path),
          kind: "other",
          size: information.size,
          mtimeNanoseconds: information.mtimeNs,
        });
      }
    }
  };
  await visit(root);
  return snapshot;
}
