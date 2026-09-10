import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import { createHistoricalRecoveryLibrary } from "../../src/workbench-shell/history-recovery.ts";
import { createProductionHistoryRecoverySourceDiscovery } from "../../src/workbench-shell/electron/history-recovery-source-discovery.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { createSyntheticStore, syntheticLedgerSlot } from "./fixtures/synthetic-history-recovery-fixtures.ts";

const successfulOwnerOnlyStorage = Object.freeze({
  async establish() {},
  async verify() { return true; },
});

test("recovery protects each ancestor before starting descendant protection", async (t) => {
  const parent = await createTestDirectory(t, join(realpathSync(tmpdir()), "w66-order-"));
  const dataDirectory = join(parent, "recovery");
  const protectedDirectories = new Set<string>();
  const overlaps: string[] = [];
  const library = createHistoricalRecoveryLibrary({
    dataDirectory,
    sourceDiscovery: { async discover() { return []; } },
    exportChooser: { async choose() { throw new Error("must-not-run"); } },
    ownerOnlyStorage: {
      async establish(path, kind) {
        if (path !== dataDirectory && !protectedDirectories.has(dirname(path))) overlaps.push(path);
        await new Promise<void>((done) => setImmediate(done));
        if (kind === "directory") protectedDirectories.add(path);
      },
      async verify() { return true; },
    },
  });
  registerTestClosable(t, library);
  assert.equal((await library.prepareLaunch()).status, "ready");
  assert.deepEqual(overlaps, [], "ancestor and descendant ACL writes must not race");
});

test("preparation logs the native protection cause without exposing it in a public result", async (t) => {
  const parent = await createTestDirectory(t, join(realpathSync(tmpdir()), "w66-cause-"));
  const nativeError = await readFile(join(parent, "missing-private-file")).catch((error: unknown) => error);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  t.mock.method(console, "warn", () => {});
  const library = createHistoricalRecoveryLibrary({
    dataDirectory: join(parent, "recovery"),
    sourceDiscovery: { async discover() { throw new Error("must-not-discover"); } },
    exportChooser: { async choose() { throw new Error("must-not-run"); } },
    ownerOnlyStorage: {
      async establish() { throw nativeError; },
      async verify() { return false; },
    },
  });
  registerTestClosable(t, library);
  const result = await library.execute({}, { version: 1, requestKey: "native-error" });
  assert.equal(result.status, "unavailable");
  assert.equal(errors[0]?.[0], "Historical recovery preparation failed.");
  assert.ok(errors[0]?.[1] instanceof Error);
  assert.equal(errors[0][1].cause, nativeError);
  assert.doesNotMatch(JSON.stringify(result), /missing-private-file|ENOENT|owner-only-postcondition/u);
});

test("capture batches empty destinations and verifies every ACL before writing any source bytes", async (t) => {
  const parent = await createTestDirectory(t, join(realpathSync(tmpdir()), "w66-batch-"));
  const source = await createSyntheticStore(join(parent, "history"), 2);
  const before = await sourceBytes(source.root);
  const observations: boolean[] = [];
  t.mock.method(console, "warn", () => {});
  const library = createHistoricalRecoveryLibrary({
    dataDirectory: join(parent, "recovery"),
    sourceDiscovery: { async discover() { return [{ rootPath: source.root, role: "historical", providerClass: "synthetic-history" }]; } },
    exportChooser: { async choose() { throw new Error("must-not-run"); } },
    ownerOnlyStorage: {
      async establish() {},
      async verify(path, kind) {
        const rawMarker = `${sep}raw${sep}`;
        if (kind !== "file" || !path.includes(rawMarker)) return true;
        const raw = path.slice(0, path.indexOf(rawMarker) + rawMarker.length);
        const files = await Promise.all([
          readFile(join(raw, "project-ledgers", `${syntheticLedgerSlot}.sqlite`)).catch(() => null),
          readFile(join(raw, "project-registry-v1.json")).catch(() => null),
        ]);
        observations.push(files.every((bytes) => bytes?.length === 0));
        // A later member fails: no earlier member may have received source data.
        return !path.endsWith("project-registry-v1.json");
      },
    },
  });
  registerTestClosable(t, library);
  assert.deepEqual(await library.prepareLaunch(), { status: "partial", sourceCount: 1, captureAttempts: 3 });
  assert.equal(observations.length, 6);
  assert.ok(observations.every(Boolean), "all destinations must exist, remain empty, and be verified before copying");
  assert.deepEqual(await sourceBytes(source.root), before);
});

test("redirected recovery captures history within the unchanged deadline beside ordinary current-store metadata", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await createTestDirectory(t, join(realpathSync(tmpdir()), "w66-"));
  const physicalAppData = join(root, "owner", "AppData", "Roaming");
  const currentUserDataDirectory = join(physicalAppData, "synchronized-intellect-network");
  const current = await createSyntheticStore(join(currentUserDataDirectory, "workbench-project-host"), 2);
  const historical = await createSyntheticStore(join(physicalAppData, "unified-agent-workbench", "workbench-project-host"), 2);
  // These five files accompany registry/ledger files in the actual w57 current
  // store. Capture must copy them too; the strict reader still rejects them.
  for (const name of [
    "create-project-operation-v1.json",
    "work-ledger-account-observations-v1.initialized",
    "work-ledger-account-observations-v1.json",
    "work-ledger-auth-generations-v1.initialized",
    "work-ledger-auth-generations-v1.json",
  ]) await writeFile(join(current.root, name), "synthetic metadata");
  const before = await Promise.all([sourceBytes(current.root), sourceBytes(historical.root)]);
  for (const phase of ["first", "second"]) {
    const library = createHistoricalRecoveryLibrary({
      dataDirectory: join(root, "redirected", phase, "history-recovery-v1"),
      sourceDiscovery: createProductionHistoryRecoverySourceDiscovery({
        appDataDirectory: physicalAppData,
        currentUserDataDirectory,
      }),
      exportChooser: { async choose() { throw new Error("chooser-must-not-run"); } },
      ownerOnlyStorage: successfulOwnerOnlyStorage,
    });
    registerTestClosable(t, library);
    const start = Date.now();
    const preparation = await library.prepareLaunch();
    const result = await library.execute({}, { version: 1, requestKey: `redirected-${phase}` });
    t.diagnostic(JSON.stringify({ phase, elapsed: Date.now() - start, preparation, result }));
    assert.equal(preparation.captureAttempts, 2);
    assert.equal(result.status, "partial", "unsupported current artifacts remain rejected");
    assert.ok("snapshot" in result);
    const source = result.snapshot.sources.find((item) => item.role === "historical");
    assert.ok(source);
    assert.equal(source.state, "available");
    assert.equal(source.action, "preserve");
    assert.deepEqual(source.counts, { projects: 1, sessions: 1, commands: 2, updates: 4 });
    assert.deepEqual(await Promise.all([sourceBytes(current.root), sourceBytes(historical.root)]), before);
    await library.close();
  }
});

async function sourceBytes(root: string): Promise<unknown[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => [
    entry.name,
    entry.isDirectory() ? await sourceBytes(join(root, entry.name)) : await readFile(join(root, entry.name)),
  ]));
}
