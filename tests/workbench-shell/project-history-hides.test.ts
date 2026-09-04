import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openProjectHistoryHideStore } from "../../src/workbench-shell/project-history-hides.ts";

const firstSlot =
  "project-ledger-v1-00000000-0000-4000-8000-000000000011";
const secondSlot =
  "project-ledger-v1-00000000-0000-4000-8000-000000000012";
const directoryDigest = "a".repeat(64);

test("empty-history visibility choices append atomically and survive restart", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-history-hides-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));

  const store = await openProjectHistoryHideStore(dataDirectory);
  assert.equal(store.available, true);
  assert.equal(store.isHidden(directoryDigest, firstSlot), false);
  assert.equal(await store.hide(directoryDigest, firstSlot), true);
  assert.equal(await store.hide(directoryDigest, secondSlot), true);
  assert.equal(store.isHidden(directoryDigest, firstSlot), true);
  assert.equal(store.isHidden(directoryDigest, secondSlot), true);

  const statePath = join(dataDirectory, "project-history-hides-v1.json");
  const bytes = await readFile(statePath, "utf8");
  assert.deepEqual(JSON.parse(bytes), {
    schemaVersion: 1,
    revision: 2,
    records: [
      { directoryDigest, ledgerSlot: firstSlot },
      { directoryDigest, ledgerSlot: secondSlot },
    ],
  });
  assert.equal(bytes.includes(".sqlite"), false);
  assert.equal(bytes.includes("\\") || bytes.includes("/"), false);

  const reopened = await openProjectHistoryHideStore(dataDirectory);
  assert.equal(reopened.available, true);
  assert.equal(reopened.isHidden(directoryDigest, firstSlot), true);
  assert.equal(reopened.isHidden(directoryDigest, secondSlot), true);
});

test("a malformed visibility record shows every history and is never overwritten", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-history-hides-bad-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const statePath = join(dataDirectory, "project-history-hides-v1.json");
  const malformed = `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    records: [
      {
        directoryDigest,
        ledgerSlot: firstSlot,
        deleted: true,
      },
    ],
  })}\n`;
  await writeFile(statePath, malformed, "utf8");

  const store = await openProjectHistoryHideStore(dataDirectory);
  assert.equal(store.available, false);
  assert.equal(store.isHidden(directoryDigest, firstSlot), false);
  assert.equal(await store.hide(directoryDigest, secondSlot), false);
  assert.equal(await readFile(statePath, "utf8"), malformed);
});
