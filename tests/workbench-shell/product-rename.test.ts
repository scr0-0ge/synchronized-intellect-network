import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveConversationStoreRoot } from "../../src/workbench-shell/conversation-store-root.ts";
import { createProductionHistoryRecoverySourceDiscovery } from "../../src/workbench-shell/electron/history-recovery-source-discovery.ts";
import { createHistoricalRecoveryLibrary } from "../../src/workbench-shell/history-recovery.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { createSyntheticStore } from "./fixtures/synthetic-history-recovery-fixtures.ts";

const successfulOwnerOnlyStorage = Object.freeze({
  async establish() {},
  async verify() { return true; },
});

test("development and public-tree manifests use the new product identity", async () => {
  const publicOverride = "scripts/public-tree/overrides/package.json";
  const files = ["package.json"];
  // The private tree carries both manifests; after materialisation the override
  // is the root manifest and its private source directory is intentionally gone.
  if (existsSync(new URL(`../../${publicOverride}`, import.meta.url))) {
    files.push(publicOverride);
  }
  for (const file of files) {
    const manifest = JSON.parse(await readFile(new URL(`../../${file}`, import.meta.url), "utf8"));
    assert.equal(manifest.name, "synchronized-intellect-network", file);
  }
});

test("renamed Windows identity discovers and preserves the old package store byte-for-byte", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "w57-"));
  // Only this synthetic app-data tree is ever given to production discovery.
  const historical = await createSyntheticStore(join(root, "unified-agent-workbench", "workbench-project-host"), 2);
  const before = await fileBytes(historical.root);
  t.diagnostic(JSON.stringify({ sourceBefore: before.map(({ path, bytes }) => ({ path, length: bytes.length })) }));
  const currentRoot = resolveConversationStoreRoot({
    platform: "win32",
    roamingAppDataDirectory: root,
    electronUserDataDirectory: join(root, "synchronized-intellect-network"),
  });
  const discovery = createProductionHistoryRecoverySourceDiscovery({
    appDataDirectory: root,
    currentUserDataDirectory: dirname(currentRoot),
  });
  t.diagnostic(JSON.stringify({ currentRoot, candidates: await discovery.discover() }));
  const dataDirectory = join(dirname(currentRoot), "history-recovery-v1");
  const recovery = createHistoricalRecoveryLibrary({
    dataDirectory,
    sourceDiscovery: discovery,
    exportChooser: { async choose() { throw new Error("no-native-chooser"); } },
    ownerOnlyStorage: successfulOwnerOnlyStorage,
  });
  registerTestClosable(t, recovery);
  const preparation = await recovery.prepareLaunch();
  t.diagnostic(JSON.stringify({ preparation }));
  assert.equal(preparation.status, "ready");
  const owner = {};
  const result = await recovery.execute(owner, { version: 1, requestKey: "rename-snapshot" });
  assert.ok("kind" in result && result.kind === "snapshot" && result.status === "ready");
  const sources = result.snapshot.sources;
  t.diagnostic(JSON.stringify({ sources: sources.map(({ role, state, action, counts }) => ({ role, state, action, counts })) }));
  assert.deepEqual(await fileBytes(historical.root), before);
  assert.equal(currentRoot, join(root, "synchronized-intellect-network", "workbench-project-host"));
  const source = sources.find(({ role, action }) => role === "historical" && action === "preserve");
  assert.ok(source, "the literal old identity must remain discoverable and preservable");
  assert.deepEqual(source.counts, { projects: 1, sessions: 1, commands: 2, updates: 4 });
  const preserved = await recovery.execute(owner, {
    version: 1,
    action: "preserve",
    requestKey: "rename-preserve",
    operationKey: "rename-preserve-operation",
    snapshotKey: result.snapshot.snapshotKey,
    sourceKey: source.sourceKey,
  });
  assert.ok("action" in preserved && preserved.action === "preserve" && preserved.status === "preserved");
  t.diagnostic(JSON.stringify({ preserved: preserved.status, cleanup: preserved.cleanup }));

  // Read the committed copy itself; do not treat a success status or matching
  // digests as proof of unchanged source bytes or a complete forward copy.
  const libraryRoot = join(dataDirectory, "historical-recovery-library-v1");
  const generations = await readdir(join(libraryRoot, "generations"));
  assert.equal(generations.length, 1);
  const manifest = JSON.parse(await readFile(join(libraryRoot, "generations", generations[0]!, "manifest-v1.json"), "utf8")) as {
    files: Array<{ relativePath: string; digest: string }>;
  };
  const copy = await Promise.all(manifest.files.map(async (file) => ({
    path: file.relativePath,
    bytes: await readFile(join(libraryRoot, "blobs", "sha256", `${file.digest}.blob`)),
  })));
  copy.sort((a, b) => a.path.localeCompare(b.path, "en-US"));
  assert.deepEqual(copy, before);
  assert.deepEqual(await fileBytes(historical.root), before);
  t.diagnostic(JSON.stringify({ sourceBytesUnchanged: true, committedCopyBytesEqual: true, files: before.length, bytes: before.reduce((sum, file) => sum + file.bytes.length, 0) }));
});

async function fileBytes(root: string, prefix = ""): Promise<Array<{ path: string; bytes: Buffer }>> {
  const result: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await fileBytes(root, path));
    else result.push({ path, bytes: await readFile(join(root, path)) });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, "en-US"));
}
