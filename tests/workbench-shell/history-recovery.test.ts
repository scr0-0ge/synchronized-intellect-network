import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  historyRecoveryBounds,
  type HistoryRecoveryActionResult,
  type HistoryRecoveryBrowseResult,
  type HistoryRecoveryPerformRequest,
  type HistoryRecoverySnapshot,
  type HistoryRecoverySnapshotResult,
} from "../../src/workbench-shell/history-recovery-contract.ts";
import {
  createHistoricalRecoveryLibrary,
  type HistoricalRecoveryLibrary,
  type HistoryRecoveryExportChoice,
  type HistoryRecoverySourceCandidate,
} from "../../src/workbench-shell/history-recovery.ts";
import {
  sanitizeHistoryRecoveryActionResult,
  sanitizeHistoryRecoveryBrowseResult,
  sanitizeHistoryRecoverySnapshotResult,
} from "../../src/workbench-shell/history-recovery-sanitizer.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";
import {
  createOversizedSparseFile,
  createSyntheticStore,
  directoryManifest,
} from "./fixtures/synthetic-history-recovery-fixtures.ts";

const fixedSecret = Buffer.alloc(32, 0x5a);

for (const inventory of ["readable", "unsupported-artifact"] as const) {
  test(`real ${inventory} recovery results survive the preload sanitizer after IPC cloning`, async (t) => {
    const parent = await temporaryDirectory(t);
    const sources = await Promise.all(["one", "two"].map(async (name) => {
      const source = await createSyntheticStore(join(parent, name), 2);
      if (inventory === "unsupported-artifact") {
        await writeFile(join(source.root, "unknown-artifact.bin"), "synthetic");
      }
      return source;
    }));
    const before = await Promise.all(sources.map((source) => directoryManifest(source.root)));
    const library = recoveryLibrary(t, {
      dataDirectory: join(parent, "recovery"),
      candidates: sources.map((source) => candidate("historical", source.root, "synthetic-history")),
    });
    const owner = {};
    const initial = await snapshot(library, owner, "snapshot-ipc");
    // Electron IPC preserves shared references. JSON round-tripping here would
    // hide the real producer/preload mismatch that rejected committed copies.
    assert.deepEqual(sanitizeHistoryRecoverySnapshotResult(structuredClone(initial), initial.requestKey), initial);
    let current = initial.snapshot;
    for (const ordinal of [1, 2]) {
      const request = preserveRequest(current, `preserve-ipc-${ordinal}`);
      const result = await library.execute(owner, request) as HistoryRecoveryActionResult;
      assertPreserveSuccess(result);
      assert.equal(result.status, "preserved");
      assert.deepEqual(sanitizeHistoryRecoveryActionResult(structuredClone(result), request), result);
      const replay = await library.execute(owner, request) as HistoryRecoveryActionResult;
      assert.equal(replay.status, "already-preserved");
      assert.deepEqual(sanitizeHistoryRecoveryActionResult(structuredClone(replay), request), replay);
      current = result.snapshot;
    }
    const request = {
      version: 1, kind: "generations", requestKey: "generations-ipc",
      snapshotKey: current.snapshotKey, libraryKey: current.library.libraryKey,
      page: { after: null, size: 10 },
    } as const;
    const generations = await browse(library, owner, request);
    assert.equal(generations.status, "ready");
    assert.deepEqual(sanitizeHistoryRecoveryBrowseResult(structuredClone(generations), request), generations);
    assert.deepEqual(await Promise.all(sources.map((source) => directoryManifest(source.root))), before);
  });
}

test("capture, preserve, browse, and two deliberate exports remain branch-preserving and source-read-only", async (t) => {
  const parent = await temporaryDirectory(t);
  const current = await createSyntheticStore(join(parent, "current"), 2);
  const historical = await createSyntheticStore(join(parent, "historical"), 2);
  const beforeCurrent = await directoryManifest(current.root);
  const beforeHistorical = await directoryManifest(historical.root);
  const firstTarget = join(parent, "export-one.uawr-history");
  const secondTarget = join(parent, "export-two.uawr-history");
  const chooserTargets = [firstTarget, secondTarget];
  let chooserCalls = 0;
  let discoveryCalls = 0;
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery"),
    candidates: [
      candidate("current", current.root, "synthetic-current"),
      candidate("historical", historical.root, "synthetic-history"),
    ],
    onDiscovery: () => {
      discoveryCalls += 1;
    },
    choose: async () => ({ targetPath: chooserTargets[chooserCalls++]! }),
  });

  const preparation = await library.prepareLaunch();
  assert.deepEqual(preparation, {
    status: "ready",
    sourceCount: 2,
    captureAttempts: 2,
  });
  assert.equal(discoveryCalls, 1);
  assert.deepEqual(await directoryManifest(current.root), beforeCurrent);
  assert.deepEqual(await directoryManifest(historical.root), beforeHistorical);

  const owner = Object.freeze({});
  const initial = await snapshot(library, owner, "snapshot-request-1");
  assert.equal(initial.status, "ready");
  const currentSummary = initial.snapshot.sources.find(
    (source) => source.role === "current",
  );
  const historicalSummary = initial.snapshot.sources.find(
    (source) => source.role === "historical",
  );
  assert.deepEqual(
    currentSummary && {
      label: currentSummary.label,
      state: currentSummary.state,
      action: currentSummary.action,
    },
    { label: "Current store 1", state: "current", action: "none" },
  );
  assert.deepEqual(historicalSummary?.counts, {
    projects: 1,
    sessions: 1,
    commands: 2,
    updates: 4,
  });
  assert.equal(historicalSummary?.action, "preserve");

  const preserveRequest = {
    version: 1,
    action: "preserve",
    requestKey: "preserve-request-1",
    operationKey: "preserve-operation-1",
    snapshotKey: initial.snapshot.snapshotKey,
    sourceKey: historicalSummary!.sourceKey,
  } as const;
  const preserved = await library.execute(owner, preserveRequest) as HistoryRecoveryActionResult;
  assert.equal(preserved.status, "preserved");
  assertPreserveSuccess(preserved);
  assert.equal(preserved.cleanup, "complete");

  const replay = await library.execute(owner, preserveRequest) as HistoryRecoveryActionResult;
  assert.equal(replay.status, "already-preserved");
  assert.deepEqual(await directoryManifest(historical.root), beforeHistorical);
  assert.deepEqual(await directoryManifest(current.root), beforeCurrent);

  const projects = await browse(library, owner, {
    version: 1,
    kind: "projects",
    requestKey: "browse-projects-1",
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
    page: { after: null, size: 10 },
  });
  assert.equal(projects.status, "ready");
  const project = projects.status === "ready" ? projects.page.items[0] : undefined;
  assert.equal(project?.kind, "project");
  const sessions = await browse(library, owner, {
    version: 1,
    kind: "sessions",
    requestKey: "browse-sessions-1",
    snapshotKey: preserved.snapshot.snapshotKey,
    projectKey: project!.kind === "project" ? project.projectKey : "invalid",
    page: { after: null, size: 10 },
  });
  assert.equal(sessions.status, "ready");
  const session = sessions.status === "ready" ? sessions.page.items[0] : undefined;
  assert.equal(session?.kind, "session");
  const turns = await browse(library, owner, {
    version: 1,
    kind: "turns",
    requestKey: "browse-turns-1",
    snapshotKey: preserved.snapshot.snapshotKey,
    sessionKey: session!.kind === "session" ? session.sessionKey : "invalid",
    page: { after: null, size: 10 },
  });
  assert.equal(turns.status, "ready");
  assert.deepEqual(
    turns.status === "ready"
      ? turns.page.items.map((item) => ({
          label: item.label,
          eventCount: item.kind === "turn" ? item.eventCount : -1,
        }))
      : [],
    [
      { label: "Turn 1", eventCount: 2 },
      { label: "Turn 2", eventCount: 2 },
    ],
  );

  const exportRequest = {
    version: 1,
    action: "export-copy",
    requestKey: "export-request-1",
    operationKey: "export-operation-1",
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
  } as const;
  const exported = await library.execute(owner, exportRequest) as HistoryRecoveryActionResult;
  assert.equal(exported.status, "exported");
  assert.equal(
    (await readFile(firstTarget)).subarray(0, 15).toString("utf8"),
    "UAWR-HISTORY-1\n",
  );
  assert.equal(
    (await library.execute(owner, exportRequest) as HistoryRecoveryActionResult).status,
    "already-exported",
  );
  const secondExport = await library.execute(owner, {
    ...exportRequest,
    requestKey: "export-request-2",
    operationKey: "export-operation-2",
  }) as HistoryRecoveryActionResult;
  assert.equal(secondExport.status, "exported");
  assert.equal(chooserCalls, 2);

  const firstTurnPage = await browse(library, owner, {
    version: 1,
    kind: "turns",
    requestKey: "browse-turns-page-1",
    snapshotKey: preserved.snapshot.snapshotKey,
    sessionKey: session!.kind === "session" ? session.sessionKey : "invalid",
    page: { after: null, size: 1 },
  });
  assert.equal(firstTurnPage.status, "ready");
  assert.notEqual(
    firstTurnPage.status === "ready" ? firstTurnPage.page.nextAfter : null,
    null,
  );
  await snapshot(library, owner, "snapshot-rotates-pagination");
  const stalePage = await browse(library, owner, {
    version: 1,
    kind: "turns",
    requestKey: "browse-turns-stale-page",
    snapshotKey: preserved.snapshot.snapshotKey,
    sessionKey: session!.kind === "session" ? session.sessionKey : "invalid",
    page: {
      after: firstTurnPage.status === "ready"
        ? firstTurnPage.page.nextAfter
        : null,
      size: 1,
    },
  });
  assert.equal(stalePage.status, "stale");

  const publicBytes = JSON.stringify([
    initial,
    preserved,
    projects,
    sessions,
    turns,
    exported,
    secondExport,
  ]);
  for (const forbidden of [
    "synthetic-history-recovery-test",
    "project-ledger-v1-",
    "command-root",
    "opaque-synthetic-reference",
    "payload-root",
  ]) {
    assert.equal(publicBytes.includes(forbidden), false);
  }
  assert.deepEqual(await directoryManifest(historical.root), beforeHistorical);
  assert.deepEqual(await directoryManifest(current.root), beforeCurrent);
});

test("verified empty history is acknowledged without creating a generation", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "empty-history"), 0);
  const before = await directoryManifest(historical.root);
  const dataDirectory = join(parent, "recovery");
  const library = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-empty")],
  });
  const owner = Object.freeze({});
  const initial = await snapshot(library, owner, "snapshot-empty-1");
  const source = initial.snapshot.sources[0]!;
  assert.deepEqual(
    { state: source.state, action: source.action, counts: source.counts },
    { state: "empty", action: "acknowledge", counts: {
      projects: 0,
      sessions: 0,
      commands: 0,
      updates: 0,
    } },
  );
  const request = {
    version: 1,
    action: "acknowledge",
    requestKey: "ack-request-1",
    operationKey: "ack-operation-1",
    snapshotKey: initial.snapshot.snapshotKey,
    sourceKey: source.sourceKey,
  } as const;
  assert.equal((await library.execute(owner, request) as HistoryRecoveryActionResult).status, "acknowledged");
  assert.equal((await library.execute(owner, request) as HistoryRecoveryActionResult).status, "already-acknowledged");
  await library.close();
  assert.deepEqual(await directoryManifest(historical.root), before);

  const restarted = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-empty")],
  });
  const afterRestart = await snapshot(restarted, Object.freeze({}), "snapshot-empty-2");
  assert.equal(afterRestart.snapshot.library.generationCount, 0);
  assert.equal(afterRestart.snapshot.sources[0]?.state, "acknowledged");
  assert.equal(afterRestart.snapshot.sources[0]?.action, "none");
  assert.deepEqual(await directoryManifest(historical.root), before);
});

test("unknown raw artifacts remain preservable and exportable while browsing fails closed", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "unknown-history"), 2);
  await writeFile(join(historical.root, "unknown-private-artifact.bin"), "synthetic");
  const target = join(parent, "unknown-export.uawr-history");
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery"),
    candidates: [candidate("historical", historical.root, "synthetic-unknown")],
    choose: async () => ({ targetPath: target }),
  });
  assert.equal((await library.prepareLaunch()).status, "partial");
  const owner = Object.freeze({});
  const initial = await snapshot(library, owner, "snapshot-unknown");
  assert.equal(initial.snapshot.sources[0]?.action, "preserve");
  const preserved = await library.execute(owner, {
    version: 1,
    action: "preserve",
    requestKey: "preserve-unknown",
    operationKey: "preserve-unknown-op",
    snapshotKey: initial.snapshot.snapshotKey,
    sourceKey: initial.snapshot.sources[0]!.sourceKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(preserved.status, "preserved");
  assertPreserveSuccess(preserved);
  const projects = await browse(library, owner, {
    version: 1,
    kind: "projects",
    requestKey: "projects-unknown",
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
    page: { after: null, size: 10 },
  });
  assert.equal(projects.status, "unavailable");
  assert.equal(
    projects.status === "unavailable" && projects.problem.code,
    "unsupported-artifact",
  );
  const exported = await library.execute(owner, {
    version: 1,
    action: "export-copy",
    requestKey: "export-unknown",
    operationKey: "export-unknown-op",
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(exported.status, "exported");
  assert.equal((await readFile(target)).includes(Buffer.from("synthetic")), true);
});

test("capture drift retries exactly three times and a stable retry is retained", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "drift-once"), 2);
  let mutations = 0;
  const stableRetry = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-once"),
    candidates: [candidate("historical", historical.root, "synthetic-drift")],
    failureInjector: async (point) => {
      if (point === "capture:file:after-copy" && mutations === 0) {
        mutations += 1;
        await appendFile(historical.ledgerPath!, " ");
      }
    },
  });
  const stablePreparation = await stableRetry.prepareLaunch();
  assert.equal(stablePreparation.captureAttempts, 2);
  assert.equal(stablePreparation.status, "ready");
  await stableRetry.close();

  const alwaysDrifting = await createSyntheticStore(join(parent, "drift-always"), 2);
  let driftWrites = 0;
  const failed = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-always"),
    candidates: [candidate("historical", alwaysDrifting.root, "synthetic-drift")],
    failureInjector: async (point) => {
      if (point === "capture:file:after-copy") {
        driftWrites += 1;
        await appendFile(alwaysDrifting.ledgerPath!, " ");
      }
    },
  });
  const failedPreparation = await failed.prepareLaunch();
  assert.equal(failedPreparation.captureAttempts, 3);
  assert.equal(driftWrites, 3);
  const failedSnapshot = await snapshot(failed, Object.freeze({}), "snapshot-drift");
  assert.equal(failedSnapshot.snapshot.sources[0]?.state, "unavailable");
});

test("capture rejects replacement of the discovered root identity", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "root-identity"), 2);
  const displaced = join(parent, "root-identity-displaced");
  const before = await directoryManifest(historical.root);
  let replaced = false;
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-root-identity"),
    candidates: [candidate("historical", historical.root, "synthetic-root-drift")],
    failureInjector: async (point) => {
      if (point === "capture:after-enumeration" && !replaced) {
        replaced = true;
        await rename(historical.root, displaced);
        await createSyntheticStore(historical.root, 2);
      }
    },
  });
  const preparation = await library.prepareLaunch();
  assert.deepEqual(preparation, {
    status: "partial",
    sourceCount: 1,
    captureAttempts: 3,
  });
  const result = await snapshot(library, Object.freeze({}), "snapshot-root-drift");
  assert.equal(result.snapshot.sources[0]?.state, "unavailable");
  await rm(historical.root, { recursive: true, force: true });
  await rename(displaced, historical.root);
  assert.deepEqual(await directoryManifest(historical.root), before);
});

test("capture rejects late directory entries across all three bounded attempts", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "late-entry"), 2);
  const before = await directoryManifest(historical.root);
  const latePaths: string[] = [];
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-late-entry"),
    candidates: [candidate("historical", historical.root, "synthetic-late-entry")],
    failureInjector: async (point) => {
      if (point === "capture:after-enumeration") {
        const path = join(historical.root, `late-${latePaths.length + 1}.synthetic`);
        latePaths.push(path);
        await writeFile(path, "late synthetic byte");
      }
    },
  });
  const preparation = await library.prepareLaunch();
  assert.deepEqual(preparation, {
    status: "partial",
    sourceCount: 1,
    captureAttempts: 3,
  });
  const result = await snapshot(library, Object.freeze({}), "snapshot-late-entry");
  assert.equal(result.snapshot.sources[0]?.state, "unavailable");
  for (const path of latePaths) await rm(path, { force: true });
  assert.deepEqual(await directoryManifest(historical.root), before);
});

test("capture rejects a removed or renamed enumerated file", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "renamed-entry"), 2);
  const firstName = join(historical.root, "rename-a.synthetic");
  const secondName = join(historical.root, "rename-b.synthetic");
  await writeFile(firstName, "rename synthetic byte");
  const before = await directoryManifest(historical.root);
  let atFirstName = true;
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-renamed-entry"),
    candidates: [candidate("historical", historical.root, "synthetic-rename")],
    failureInjector: async (point) => {
      if (point === "capture:after-enumeration") {
        await rename(atFirstName ? firstName : secondName, atFirstName ? secondName : firstName);
        atFirstName = !atFirstName;
      }
    },
  });
  const preparation = await library.prepareLaunch();
  assert.deepEqual(preparation, {
    status: "partial",
    sourceCount: 1,
    captureAttempts: 3,
  });
  const result = await snapshot(library, Object.freeze({}), "snapshot-renamed-entry");
  assert.equal(result.snapshot.sources[0]?.state, "unavailable");
  if (!atFirstName) await rename(secondName, firstName);
  assert.deepEqual(await directoryManifest(historical.root), before);
});

test("actual opened-handle size enforces the source quota after a small lstat", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "handle-growth"), 2);
  const growing = join(historical.root, "growing.synthetic");
  await writeFile(growing, "small");
  let grew = false;
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-handle-growth"),
    candidates: [candidate("historical", historical.root, "synthetic-growth")],
    failureInjector: async (point) => {
      if (point === "capture:after-enumeration" && !grew) {
        grew = true;
        const handle = await open(growing, "r+");
        try {
          await handle.truncate(historyRecoveryBounds.maximumFileBytes + 1);
        } finally {
          await handle.close();
        }
      }
    },
  });
  const preparation = await library.prepareLaunch();
  assert.deepEqual(preparation, {
    status: "partial",
    sourceCount: 1,
    captureAttempts: 3,
  });
  const result = await snapshot(library, Object.freeze({}), "snapshot-handle-growth");
  assert.equal(result.snapshot.sources[0]?.state, "unavailable");
  await writeFile(growing, "small");
});

test("a deadline crossed between copy chunks fails closed without a capture receipt", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "copy-deadline"), 2);
  await writeFile(
    join(historical.root, "two-chunks.synthetic"),
    Buffer.alloc(2 * 1024 * 1024, 0x61),
  );
  const before = await directoryManifest(historical.root);
  let clock = 0;
  const dataDirectory = join(parent, "recovery-copy-deadline");
  const library = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-deadline")],
    now: () => clock,
    failureInjector(point) {
      if (point === "capture:file:chunk") {
        clock = historyRecoveryBounds.preparationDeadlineMilliseconds + 1;
      }
    },
  });
  const preparation = await library.prepareLaunch();
  assert.equal(preparation.status, "partial");
  const result = await snapshot(library, Object.freeze({}), "snapshot-copy-deadline");
  assert.equal(result.snapshot.sources[0]?.state, "unavailable");
  assert.deepEqual(await readdir(join(dataDirectory, "recovery-intake-v1")), []);
  assert.deepEqual(await directoryManifest(historical.root), before);
});

test("permission and quota failures are bounded to three local capture attempts", async (t) => {
  const parent = await temporaryDirectory(t);
  const denied = await createSyntheticStore(join(parent, "denied"), 2);
  const permissionLibrary = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-denied"),
    candidates: [candidate("historical", denied.root, "synthetic-denied")],
    failureInjector(point) {
      if (/^capture:[123]:before$/u.test(point)) {
        throw Object.assign(new Error("synthetic permission"), { code: "EACCES" });
      }
    },
  });
  assert.deepEqual(await permissionLibrary.prepareLaunch(), {
    status: "partial",
    sourceCount: 1,
    captureAttempts: 3,
  });
  await permissionLibrary.close();

  const quota = await createSyntheticStore(join(parent, "quota"), 0);
  await createOversizedSparseFile(join(quota.root, "oversized.synthetic"));
  const quotaLibrary = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-quota"),
    candidates: [candidate("historical", quota.root, "synthetic-quota")],
  });
  assert.deepEqual(await quotaLibrary.prepareLaunch(), {
    status: "partial",
    sourceCount: 1,
    captureAttempts: 3,
  });
  const quotaSnapshot = await snapshot(quotaLibrary, Object.freeze({}), "snapshot-quota");
  assert.equal(quotaSnapshot.snapshot.sources[0]?.state, "unavailable");
});

test("owner-only storage is reasserted and verified for existing roots and created files", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "owner-only-history"), 2);
  const dataDirectory = join(parent, "existing-recovery-root");
  await mkdir(dataDirectory, { recursive: true });
  const calls: Array<{ readonly action: string; readonly kind: string }> = [];
  const library = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-owner-only")],
    ownerOnlyStorage: Object.freeze({
      async establish(_path: string, kind: "directory" | "file") {
        calls.push({ action: "establish", kind });
      },
      async verify(_path: string, kind: "directory" | "file") {
        calls.push({ action: "verify", kind });
        return true;
      },
    }),
  });
  assert.equal((await library.prepareLaunch()).status, "ready");
  assert.equal(
    calls.some((call) => call.action === "establish" && call.kind === "directory"),
    true,
  );
  assert.equal(
    calls.some((call) => call.action === "verify" && call.kind === "directory"),
    true,
  );
  assert.equal(
    calls.some((call) => call.action === "establish" && call.kind === "file"),
    true,
  );
  assert.equal(
    calls.some((call) => call.action === "verify" && call.kind === "file"),
    true,
  );
  assert.equal(
    calls.filter((call) => call.action === "establish").length,
    calls.filter((call) => call.action === "verify").length,
  );
});

for (const failure of ["establish", "verify"] as const) {
  test(`owner-only ${failure} failure makes recovery unavailable`, async (t) => {
    const parent = await temporaryDirectory(t);
    const library = recoveryLibrary(t, {
      dataDirectory: join(parent, `owner-only-${failure}`),
      candidates: [],
      ownerOnlyStorage: Object.freeze({
        async establish() {
          if (failure === "establish") throw new Error("synthetic-permission");
        },
        async verify() {
          return failure !== "verify";
        },
      }),
    });
    assert.deepEqual(await library.prepareLaunch(), {
      status: "unavailable",
      sourceCount: 0,
      captureAttempts: 0,
    });
  });
}

test("receipt is the preserve commit point and cleanup failure cannot undo it", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "history"), 2);
  const recovery = join(parent, "recovery");
  let failBeforeReceipt = true;
  const crashPoint = recoveryLibrary(t, {
    dataDirectory: recovery,
    candidates: [candidate("historical", historical.root, "synthetic-crash")],
    failureInjector(point) {
      if (point === "preserve:before-receipt" && failBeforeReceipt) {
        failBeforeReceipt = false;
        throw new Error("synthetic crash point");
      }
    },
  });
  const owner = Object.freeze({});
  const initial = await snapshot(crashPoint, owner, "snapshot-crash");
  const failed = await crashPoint.execute(owner, preserveRequest(initial.snapshot, "crash-op")) as HistoryRecoveryActionResult;
  assert.equal(failed.status, "failed");
  assert.equal(
    (await readdir(join(recovery, "historical-recovery-library-v1", "generations"))).length,
    0,
  );
  assert.equal((await readdir(join(recovery, "recovery-quarantine-v1"))).length > 0, true);
  await crashPoint.close();

  const cleanupPending = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery-cleanup"),
    candidates: [candidate("historical", historical.root, "synthetic-cleanup")],
    failureInjector(point) {
      if (point === "cleanup:before-remove" || point === "cleanup:before-quarantine") {
        throw new Error("synthetic cleanup failure");
      }
    },
  });
  const cleanupOwner = Object.freeze({});
  const cleanupSnapshot = await snapshot(cleanupPending, cleanupOwner, "snapshot-cleanup");
  const preserved = await cleanupPending.execute(
    cleanupOwner,
    preserveRequest(cleanupSnapshot.snapshot, "cleanup-op"),
  ) as HistoryRecoveryActionResult;
  assert.equal(preserved.status, "preserved");
  assertPreserveSuccess(preserved);
  assert.equal(preserved.cleanup, "pending");
  assert.equal(preserved.snapshot.library.generationCount, 1);
});

test("startup quarantines orphan intake and every generation without its receipt commit point", async (t) => {
  const parent = await temporaryDirectory(t);
  const dataDirectory = join(parent, "recovery");
  const intakeRoot = join(dataDirectory, "recovery-intake-v1");
  const generationRoot = join(
    dataDirectory,
    "historical-recovery-library-v1",
    "generations",
  );
  await mkdir(join(intakeRoot, "capture-v1-orphan", "raw"), { recursive: true });
  await writeFile(
    join(intakeRoot, "capture-v1-orphan", "raw", "synthetic.db"),
    "uncommitted intake",
  );
  const incompleteGeneration = join(
    generationRoot,
    "generation-v1-00000000-0000-4000-8000-000000000099",
  );
  await mkdir(incompleteGeneration, { recursive: true });
  await writeFile(
    join(incompleteGeneration, "manifest-v1.json"),
    "{\"schemaVersion\":1}\n",
  );

  const library = recoveryLibrary(t, { dataDirectory, candidates: [] });
  const result = await snapshot(
    library,
    Object.freeze({}),
    "snapshot-after-crash-cleanup",
  );
  assert.equal(result.snapshot.library.generationCount, 0);
  assert.deepEqual(await readdir(intakeRoot), []);
  assert.deepEqual(await readdir(generationRoot), []);
  assert.equal(
    (await readdir(join(dataDirectory, "recovery-quarantine-v1"))).length,
    2,
  );
});

test("corrupt committed blobs quarantine their generation and collisions fail closed", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "history"), 2);
  const dataDirectory = join(parent, "recovery");
  const first = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-collision")],
  });
  const owner = Object.freeze({});
  const initial = await snapshot(first, owner, "snapshot-collision-1");
  const preserved = await first.execute(owner, preserveRequest(initial.snapshot, "collision-op-1")) as HistoryRecoveryActionResult;
  assert.equal(preserved.status, "preserved");
  await first.close();
  const blobDirectory = join(
    dataDirectory,
    "historical-recovery-library-v1",
    "blobs",
    "sha256",
  );
  const blobName = (await readdir(blobDirectory))[0]!;
  await writeFile(join(blobDirectory, blobName), "synthetic collision");

  const restarted = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-collision")],
  });
  const restartOwner = Object.freeze({});
  const afterRestart = await snapshot(restarted, restartOwner, "snapshot-collision-2");
  assert.equal(afterRestart.snapshot.library.generationCount, 0);
  const collision = await restarted.execute(
    restartOwner,
    preserveRequest(afterRestart.snapshot, "collision-op-2"),
  ) as HistoryRecoveryActionResult;
  assert.equal(collision.status, "failed");
  assert.equal(
    collision.status === "failed" && collision.problem.code,
    "verification-failed",
  );
});

test("target-authorized recovery reconciles exactly once and a mismatched target becomes outcome-unknown", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "history"), 2);
  const dataDirectory = join(parent, "recovery");
  const target = join(parent, "reconciled.uawr-history");
  let chooserCalls = 0;
  const interrupted = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-export")],
    choose: async () => {
      chooserCalls += 1;
      return { targetPath: target };
    },
    failureInjector(point) {
      if (point === "export:before-commit") throw new Error("synthetic response loss");
    },
  });
  const owner = Object.freeze({});
  const initial = await snapshot(interrupted, owner, "snapshot-export-1");
  const preserved = await interrupted.execute(owner, preserveRequest(initial.snapshot, "preserve-export")) as HistoryRecoveryActionResult;
  assertPreserveSuccess(preserved);
  const operationKey = "export-reconcile-operation";
  const firstExport = await interrupted.execute(owner, {
    version: 1,
    action: "export-copy",
    requestKey: "export-reconcile-request-1",
    operationKey,
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(firstExport.status, "failed");
  await interrupted.close();

  const recovered = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-export")],
    choose: async () => {
      chooserCalls += 1;
      return null;
    },
  });
  const recoveredOwner = Object.freeze({});
  const recoveredSnapshot = await snapshot(recovered, recoveredOwner, "snapshot-export-2");
  const generation = await firstGeneration(recovered, recoveredOwner, recoveredSnapshot.snapshot);
  const result = await recovered.execute(recoveredOwner, {
    version: 1,
    action: "export-copy",
    requestKey: "export-reconcile-request-2",
    operationKey,
    snapshotKey: recoveredSnapshot.snapshot.snapshotKey,
    generationKey: generation.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(result.status, "already-exported");
  assert.equal(chooserCalls, 1);
  assert.equal((await readFile(target)).subarray(0, 15).toString(), "UAWR-HISTORY-1\n");
  await recovered.close();

  const wrongData = join(parent, "wrong-recovery");
  const wrongTarget = join(parent, "wrong.uawr-history");
  const wrongInterrupted = recoveryLibrary(t, {
    dataDirectory: wrongData,
    candidates: [candidate("historical", historical.root, "synthetic-wrong")],
    choose: async () => ({ targetPath: wrongTarget }),
    failureInjector(point) {
      if (point === "export:before-commit") throw new Error("synthetic stop");
    },
  });
  const wrongOwner = Object.freeze({});
  const wrongSnapshot = await snapshot(wrongInterrupted, wrongOwner, "snapshot-wrong-1");
  const wrongPreserve = await wrongInterrupted.execute(wrongOwner, preserveRequest(wrongSnapshot.snapshot, "wrong-preserve")) as HistoryRecoveryActionResult;
  assertPreserveSuccess(wrongPreserve);
  await wrongInterrupted.execute(wrongOwner, {
    version: 1,
    action: "export-copy",
    requestKey: "wrong-export-request-1",
    operationKey: "wrong-export-operation",
    snapshotKey: wrongPreserve.snapshot.snapshotKey,
    generationKey: wrongPreserve.generation.generationKey,
  });
  await wrongInterrupted.close();
  await writeFile(wrongTarget, "not the expected export");
  const wrongRecovered = recoveryLibrary(t, {
    dataDirectory: wrongData,
    candidates: [candidate("historical", historical.root, "synthetic-wrong")],
  });
  const wrongRecoveredOwner = Object.freeze({});
  const wrongRecoveredSnapshot = await snapshot(wrongRecovered, wrongRecoveredOwner, "snapshot-wrong-2");
  const wrongGeneration = await firstGeneration(
    wrongRecovered,
    wrongRecoveredOwner,
    wrongRecoveredSnapshot.snapshot,
  );
  const unknown = await wrongRecovered.execute(wrongRecoveredOwner, {
    version: 1,
    action: "export-copy",
    requestKey: "wrong-export-request-2",
    operationKey: "wrong-export-operation",
    snapshotKey: wrongRecoveredSnapshot.snapshot.snapshotKey,
    generationKey: wrongGeneration.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(unknown.status, "outcome-unknown");
  assert.equal((await readFile(wrongTarget, "utf8")), "not the expected export");
});

test("chooser-claimed recovery never reopens the chooser, and cancellation is cooperative", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "history"), 2);
  const dataDirectory = join(parent, "recovery");
  let chooserCalls = 0;
  const claimed = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-chooser")],
    choose: async () => {
      chooserCalls += 1;
      return null;
    },
    failureInjector(point) {
      if (point === "export:after-chooser-claimed") {
        throw new Error("synthetic chooser crash");
      }
    },
  });
  const owner = Object.freeze({});
  const initial = await snapshot(claimed, owner, "snapshot-claimed-1");
  const preserved = await claimed.execute(owner, preserveRequest(initial.snapshot, "claimed-preserve")) as HistoryRecoveryActionResult;
  assertPreserveSuccess(preserved);
  const operationKey = "chooser-claimed-operation";
  const outcome = await claimed.execute(owner, {
    version: 1,
    action: "export-copy",
    requestKey: "chooser-claimed-request-1",
    operationKey,
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(outcome.status, "outcome-unknown");
  assert.equal(chooserCalls, 0);
  await claimed.close();

  const operationRoot = join(
    dataDirectory,
    "historical-recovery-library-v1",
    "export-operations",
  );
  const operationFile = join(operationRoot, (await readdir(operationRoot))[0]!);
  const durableOperation = JSON.parse(
    await readFile(operationFile, "utf8"),
  ) as { state: string; targetPath: string | null; exportDigest: string | null };
  durableOperation.state = "chooser-claimed";
  durableOperation.targetPath = null;
  durableOperation.exportDigest = null;
  await writeFile(operationFile, `${JSON.stringify(durableOperation)}\n`);

  const restarted = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-chooser")],
    choose: async () => {
      chooserCalls += 1;
      return null;
    },
  });
  const restartOwner = Object.freeze({});
  const restartSnapshot = await snapshot(restarted, restartOwner, "snapshot-claimed-2");
  const generation = await firstGeneration(restarted, restartOwner, restartSnapshot.snapshot);
  const replay = await restarted.execute(restartOwner, {
    version: 1,
    action: "export-copy",
    requestKey: "chooser-claimed-request-2",
    operationKey,
    snapshotKey: restartSnapshot.snapshot.snapshotKey,
    generationKey: generation.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(replay.status, "outcome-unknown");
  assert.equal(chooserCalls, 0);
  await restarted.close();

  let releaseChooser!: (choice: HistoryRecoveryExportChoice | null) => void;
  let chooserOpened!: () => void;
  const chooserOpen = new Promise<void>((resolve) => {
    chooserOpened = resolve;
  });
  const cancellable = recoveryLibrary(t, {
    dataDirectory: join(parent, "cancel-recovery"),
    candidates: [candidate("historical", historical.root, "synthetic-cancel")],
    choose: () => {
      chooserOpened();
      return new Promise((resolve) => {
        releaseChooser = resolve;
      });
    },
  });
  const cancelOwner = Object.freeze({});
  const cancelSnapshot = await snapshot(cancellable, cancelOwner, "snapshot-cancel");
  const cancelPreserved = await cancellable.execute(cancelOwner, preserveRequest(cancelSnapshot.snapshot, "cancel-preserve")) as HistoryRecoveryActionResult;
  assertPreserveSuccess(cancelPreserved);
  const cancelRequest = {
    version: 1,
    action: "export-copy",
    requestKey: "cancel-export-request",
    operationKey: "cancel-export-operation",
    snapshotKey: cancelPreserved.snapshot.snapshotKey,
    generationKey: cancelPreserved.generation.generationKey,
  } as const;
  const pending = cancellable.execute(cancelOwner, cancelRequest) as Promise<HistoryRecoveryActionResult>;
  await chooserOpen;
  assert.equal(
    (await cancellable.cancel(cancelOwner, {
      version: 1,
      requestKey: "cancel-request",
      operationKey: cancelRequest.operationKey,
    })).status,
    "cancel-requested",
  );
  releaseChooser(null);
  assert.equal((await pending).status, "cancelled");
  assert.equal(
    (await cancellable.cancel(cancelOwner, {
      version: 1,
      requestKey: "cancel-request-terminal",
      operationKey: cancelRequest.operationKey,
    })).status,
    "already-terminal",
  );
});

test("export cancellation is durably terminal before chooser completion and across restart", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "history"), 2);
  const dataDirectory = join(parent, "recovery");
  const target = join(parent, "cancelled-before-chooser.uawr-history");
  let chooserCalls = 0;
  let releaseChooser!: (choice: HistoryRecoveryExportChoice | null) => void;
  let chooserOpened!: () => void;
  const chooserOpen = new Promise<void>((resolve) => {
    chooserOpened = resolve;
  });
  const interrupted = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-cancel")],
    choose: () => {
      chooserCalls += 1;
      chooserOpened();
      return new Promise((resolve) => {
        releaseChooser = resolve;
      });
    },
  });
  const owner = Object.freeze({});
  const initial = await snapshot(interrupted, owner, "snapshot-cancel-durable-1");
  const preserved = await interrupted.execute(
    owner,
    preserveRequest(initial.snapshot, "preserve-cancel-durable"),
  ) as HistoryRecoveryActionResult;
  assertPreserveSuccess(preserved);
  const operationKey = "export-cancel-before-chooser";
  const pending = interrupted.execute(owner, {
    version: 1,
    action: "export-copy",
    requestKey: "export-cancel-before-chooser-request",
    operationKey,
    snapshotKey: preserved.snapshot.snapshotKey,
    generationKey: preserved.generation.generationKey,
  }) as Promise<HistoryRecoveryActionResult>;
  await chooserOpen;
  assert.equal(
    (await interrupted.cancel(owner, {
      version: 1,
      requestKey: "cancel-before-chooser-request",
      operationKey,
    })).status,
    "cancel-requested",
  );
  releaseChooser({ targetPath: target });
  assert.equal((await pending).status, "cancelled");
  assert.equal(await fileIsAbsent(target), true);
  assert.deepEqual(await durableExportEvidence(dataDirectory), {
    journalState: "chooser-claimed",
    cancellationBarrier: true,
  });
  await interrupted.close();

  const restarted = recoveryLibrary(t, {
    dataDirectory,
    candidates: [candidate("historical", historical.root, "synthetic-cancel")],
    choose: async () => {
      chooserCalls += 1;
      return { targetPath: target };
    },
  });
  const restartOwner = Object.freeze({});
  const restartSnapshot = await snapshot(
    restarted,
    restartOwner,
    "snapshot-cancel-durable-2",
  );
  const generation = await firstGeneration(
    restarted,
    restartOwner,
    restartSnapshot.snapshot,
  );
  const replay = await restarted.execute(restartOwner, {
    version: 1,
    action: "export-copy",
    requestKey: "export-cancel-before-chooser-replay",
    operationKey,
    snapshotKey: restartSnapshot.snapshot.snapshotKey,
    generationKey: generation.generationKey,
  }) as HistoryRecoveryActionResult;
  assert.equal(replay.status, "cancelled");
  assert.equal(chooserCalls, 1);
  assert.equal(await fileIsAbsent(target), true);
  assert.deepEqual(await durableExportEvidence(dataDirectory), {
    journalState: "chooser-claimed",
    cancellationBarrier: true,
  });
});

for (const cancellationPoint of [
  "export:before-commit",
  "export:commit-entry",
] as const) {
  test(`export cancellation at ${cancellationPoint} persists a barrier and never overwrites`, async (t) => {
    const parent = await temporaryDirectory(t);
    const historical = await createSyntheticStore(join(parent, "history"), 2);
    const dataDirectory = join(parent, "recovery");
    const target = join(parent, "existing-target.uawr-history");
    await writeFile(target, "synthetic-existing-target");
    let chooserCalls = 0;
    let releasePoint!: () => void;
    let pointEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      pointEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePoint = resolve;
    });
    const interrupted = recoveryLibrary(t, {
      dataDirectory,
      candidates: [candidate("historical", historical.root, "synthetic-cancel")],
      choose: async () => {
        chooserCalls += 1;
        return { targetPath: target };
      },
      failureInjector: async (point) => {
        if (point === cancellationPoint) {
          pointEntered();
          await release;
        }
      },
    });
    const owner = Object.freeze({});
    const initial = await snapshot(
      interrupted,
      owner,
      `snapshot-${cancellationPoint}`,
    );
    const preserved = await interrupted.execute(
      owner,
      preserveRequest(initial.snapshot, `preserve-${cancellationPoint}`),
    ) as HistoryRecoveryActionResult;
    assertPreserveSuccess(preserved);
    const operationKey = `cancel-${cancellationPoint}`;
    const pending = interrupted.execute(owner, {
      version: 1,
      action: "export-copy",
      requestKey: `export-${cancellationPoint}`,
      operationKey,
      snapshotKey: preserved.snapshot.snapshotKey,
      generationKey: preserved.generation.generationKey,
    }) as Promise<HistoryRecoveryActionResult>;
    const observed = await Promise.race([
      entered.then(() => "entered" as const),
      pending.then(() => "completed" as const),
    ]);
    assert.equal(observed, "entered");
    assert.equal(
      (await interrupted.cancel(owner, {
        version: 1,
        requestKey: `cancel-request-${cancellationPoint}`,
        operationKey,
      })).status,
      "cancel-requested",
    );
    releasePoint();
    assert.equal((await pending).status, "cancelled");
    assert.equal(await readFile(target, "utf8"), "synthetic-existing-target");
    assert.deepEqual(await durableExportEvidence(dataDirectory), {
      journalState: "target-authorized",
      cancellationBarrier: true,
    });
    await interrupted.close();

    const restarted = recoveryLibrary(t, {
      dataDirectory,
      candidates: [candidate("historical", historical.root, "synthetic-cancel")],
      choose: async () => {
        chooserCalls += 1;
        return { targetPath: target };
      },
    });
    const restartOwner = Object.freeze({});
    const restartSnapshot = await snapshot(
      restarted,
      restartOwner,
      `restart-${cancellationPoint}`,
    );
    const generation = await firstGeneration(
      restarted,
      restartOwner,
      restartSnapshot.snapshot,
    );
    const replay = await restarted.execute(restartOwner, {
      version: 1,
      action: "export-copy",
      requestKey: `replay-${cancellationPoint}`,
      operationKey,
      snapshotKey: restartSnapshot.snapshot.snapshotKey,
      generationKey: generation.generationKey,
    }) as HistoryRecoveryActionResult;
    assert.equal(replay.status, "cancelled");
    assert.equal(chooserCalls, 1);
    assert.equal(await readFile(target, "utf8"), "synthetic-existing-target");
  });
}

test("non-canonical or oversized export journals fail the launch closed without reopening a chooser", async (t) => {
  const parent = await temporaryDirectory(t);
  const historical = await createSyntheticStore(join(parent, "history"), 2);
  for (const corruption of ["non-canonical", "oversized"] as const) {
    const dataDirectory = join(parent, `recovery-${corruption}`);
    let chooserCalls = 0;
    const interrupted = recoveryLibrary(t, {
      dataDirectory,
      candidates: [candidate("historical", historical.root, `synthetic-${corruption}`)],
      choose: async () => {
        chooserCalls += 1;
        return null;
      },
      failureInjector(point) {
        if (point === "export:after-chooser-claimed") {
          throw new Error("synthetic chooser crash");
        }
      },
    });
    const owner = Object.freeze({});
    const initial = await snapshot(
      interrupted,
      owner,
      `snapshot-${corruption}-1`,
    );
    const preserved = await interrupted.execute(
      owner,
      preserveRequest(initial.snapshot, `preserve-${corruption}`),
    ) as HistoryRecoveryActionResult;
    assertPreserveSuccess(preserved);
    await interrupted.execute(owner, {
      version: 1,
      action: "export-copy",
      requestKey: `export-${corruption}-request`,
      operationKey: `export-${corruption}-operation`,
      snapshotKey: preserved.snapshot.snapshotKey,
      generationKey: preserved.generation.generationKey,
    });
    await interrupted.close();

    const operationRoot = join(
      dataDirectory,
      "historical-recovery-library-v1",
      "export-operations",
    );
    const operationPath = join(operationRoot, (await readdir(operationRoot))[0]!);
    if (corruption === "non-canonical") {
      await appendFile(operationPath, " ");
    } else {
      await writeFile(operationPath, "x".repeat(64 * 1024 + 1));
    }

    const restarted = recoveryLibrary(t, {
      dataDirectory,
      candidates: [candidate("historical", historical.root, `synthetic-${corruption}`)],
      choose: async () => {
        chooserCalls += 1;
        return null;
      },
    });
    const preparation = await restarted.prepareLaunch();
    assert.equal(preparation.status, "unavailable");
    const unavailable = await restarted.execute(Object.freeze({}), {
      version: 1,
      requestKey: `snapshot-${corruption}-2`,
    }) as HistoryRecoverySnapshotResult;
    assert.equal(unavailable.status, "unavailable");
    assert.equal(chooserCalls, 0);
    await restarted.close();
  }
});

test("physical duplicates collapse with current classification winning", async (t) => {
  const parent = await temporaryDirectory(t);
  const source = await createSyntheticStore(join(parent, "one-physical-root"), 2);
  const library = recoveryLibrary(t, {
    dataDirectory: join(parent, "recovery"),
    candidates: [
      candidate("historical", source.root, "synthetic-alias"),
      candidate("current", source.root, "synthetic-current"),
    ],
  });
  const preparation = await library.prepareLaunch();
  assert.equal(preparation.sourceCount, 1);
  assert.equal(preparation.captureAttempts, 1);
  const result = await snapshot(library, Object.freeze({}), "snapshot-dedup");
  assert.equal(result.snapshot.sources.length, 1);
  assert.equal(result.snapshot.sources[0]?.role, "current");
  assert.equal(result.snapshot.sources[0]?.action, "none");
});

function recoveryLibrary(context: TestContext, options: {
  readonly dataDirectory: string;
  readonly candidates: readonly HistoryRecoverySourceCandidate[];
  readonly choose?: () => Promise<HistoryRecoveryExportChoice | null>;
  readonly failureInjector?: (point: string) => void | Promise<void>;
  readonly onDiscovery?: () => void;
  readonly now?: () => number;
  readonly ownerOnlyStorage?: {
    establish(path: string, kind: "directory" | "file"): Promise<void>;
    verify(path: string, kind: "directory" | "file"): Promise<boolean>;
  };
}): HistoricalRecoveryLibrary {
  const library = createHistoricalRecoveryLibrary({
    dataDirectory: options.dataDirectory,
    createSecret: () => Buffer.from(fixedSecret),
    sourceDiscovery: Object.freeze({
      async discover() {
        options.onDiscovery?.();
        return options.candidates;
      },
    }),
    exportChooser: Object.freeze({
      choose: options.choose ?? (async () => null),
    }),
    ...(options.failureInjector === undefined
      ? {}
      : { failureInjector: options.failureInjector }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ownerOnlyStorage === undefined
      ? { ownerOnlyStorage: syntheticOwnerOnlyStorage }
      : { ownerOnlyStorage: options.ownerOnlyStorage }),
  });
  registerTestClosable(context, library);
  return library;
}

const syntheticOwnerOnlyStorage = Object.freeze({
  async establish(_path: string, _kind: "directory" | "file") {},
  async verify(_path: string, _kind: "directory" | "file") {
    return true;
  },
});

function candidate(
  role: "current" | "historical",
  rootPath: string,
  providerClass: string,
): HistoryRecoverySourceCandidate {
  return Object.freeze({ role, rootPath, providerClass });
}

async function snapshot(
  library: HistoricalRecoveryLibrary,
  owner: object,
  requestKey: string,
): Promise<Extract<HistoryRecoverySnapshotResult, { status: "ready" | "partial" }>> {
  const result = await library.execute(owner, {
    version: 1,
    requestKey,
  }) as HistoryRecoverySnapshotResult;
  assert.equal(result.kind, "snapshot");
  assert.notEqual(result.status, "unavailable");
  return result as Extract<HistoryRecoverySnapshotResult, { status: "ready" | "partial" }>;
}

async function browse(
  library: HistoricalRecoveryLibrary,
  owner: object,
  request: Parameters<HistoricalRecoveryLibrary["execute"]>[1],
): Promise<HistoryRecoveryBrowseResult> {
  return await library.execute(owner, request) as HistoryRecoveryBrowseResult;
}

function preserveRequest(
  snapshotValue: HistoryRecoverySnapshot,
  operationKey: string,
): HistoryRecoveryPerformRequest {
  const source = snapshotValue.sources.find(
    (candidate) => candidate.role === "historical" && candidate.action === "preserve",
  );
  assert.notEqual(source, undefined);
  return Object.freeze({
    version: 1 as const,
    action: "preserve" as const,
    requestKey: `${operationKey}-request`,
    operationKey,
    snapshotKey: snapshotValue.snapshotKey,
    sourceKey: source!.sourceKey,
  });
}

function assertPreserveSuccess(
  result: HistoryRecoveryActionResult,
): asserts result is Extract<HistoryRecoveryActionResult, { action: "preserve" }> {
  assert.equal(result.action, "preserve");
  assert.equal(
    result.status === "preserved" || result.status === "already-preserved",
    true,
  );
  assert.equal("snapshot" in result && "generation" in result, true);
}

async function firstGeneration(
  library: HistoricalRecoveryLibrary,
  owner: object,
  snapshotValue: HistoryRecoverySnapshot,
): Promise<{ readonly generationKey: string }> {
  const result = await browse(library, owner, {
    version: 1,
    kind: "generations",
    requestKey: "first-generation-request",
    snapshotKey: snapshotValue.snapshotKey,
    libraryKey: snapshotValue.library.libraryKey,
    page: { after: null, size: 1 },
  });
  assert.equal(result.status, "ready");
  const item = result.status === "ready" ? result.page.items[0] : undefined;
  assert.equal(item?.kind, "generation");
  return { generationKey: item!.kind === "generation" ? item.generationKey : "invalid" };
}

async function durableExportEvidence(dataDirectory: string): Promise<{
  readonly journalState: string;
  readonly cancellationBarrier: boolean;
}> {
  const operationRoot = join(
    dataDirectory,
    "historical-recovery-library-v1",
    "export-operations",
  );
  const entries = await readdir(operationRoot);
  assert.equal(entries.length, 2);
  const journalName = entries.find((entry) => !entry.endsWith(".cancel-v1.json"));
  const cancellationName = entries.find((entry) =>
    entry.endsWith(".cancel-v1.json")
  );
  assert.notEqual(journalName, undefined);
  assert.notEqual(cancellationName, undefined);
  const journal = JSON.parse(
    await readFile(join(operationRoot, journalName!), "utf8"),
  ) as { state?: unknown };
  const cancellation = JSON.parse(
    await readFile(join(operationRoot, cancellationName!), "utf8"),
  ) as { cancelled?: unknown };
  assert.equal(typeof journal.state, "string");
  return Object.freeze({
    journalState: journal.state as string,
    cancellationBarrier: cancellation.cancelled === true,
  });
}

async function fileIsAbsent(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
  }
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  return createTestDirectory(
    t,
    join(tmpdir(), "synthetic-history-recovery-test-"),
  );
}
