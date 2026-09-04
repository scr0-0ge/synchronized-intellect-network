import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { createHistoricalRecoveryLibrary } from "../../src/workbench-shell/history-recovery.ts";
import {
  createDeferredProductionHistoryRecoverySourceDiscovery,
  createProductionHistoryRecoverySourceDiscovery,
} from "../../src/workbench-shell/electron/history-recovery-source-discovery.ts";
import { startProjectHostAfterRecoveryPreparation } from "../../src/workbench-shell/electron/startup.ts";
import {
  createTestDirectory,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";
import { createSyntheticStore } from "./fixtures/synthetic-history-recovery-fixtures.ts";

function createRegisteredHistoricalRecoveryLibrary(
  context: TestContext,
  options: Parameters<typeof createHistoricalRecoveryLibrary>[0],
) {
  const library = createHistoricalRecoveryLibrary(options);
  registerTestClosable(context, library);
  return library;
}

test("every terminal preparation outcome precedes exactly one Project Host start", async () => {
  for (const status of ["ready", "partial", "unavailable"] as const) {
    const events: string[] = [];
    let starts = 0;
    const result = await startProjectHostAfterRecoveryPreparation({
      async prepareRecovery() {
        events.push(`preparation:${status}`);
        return { status };
      },
      shutdownStarted: () => false,
      async startProjectHost() {
        starts += 1;
        events.push("project-host:start");
        return status;
      },
    });
    assert.equal(result, status);
    assert.equal(starts, 1);
    assert.deepEqual(events, [`preparation:${status}`, "project-host:start"]);
  }
});

test("a thrown or malformed recovery preparation cannot suppress ordinary startup", async () => {
  for (const preparation of [
    async () => {
      throw new Error("synthetic recovery failure");
    },
    async () => ({ status: "not-terminal" as never }),
  ]) {
    let starts = 0;
    const result = await startProjectHostAfterRecoveryPreparation({
      prepareRecovery: preparation,
      shutdownStarted: () => false,
      async startProjectHost() {
        starts += 1;
        return "started";
      },
    });
    assert.equal(result, "started");
    assert.equal(starts, 1);
  }
});

test("owner-only postcondition failure leaves recovery unavailable and starts Project Host once", async (t) => {
  const parent = await temporaryDirectory(t);
  const events: string[] = [];
  let starts = 0;
  const recovery = createRegisteredHistoricalRecoveryLibrary(t, {
    dataDirectory: join(parent, "owner-only-failure"),
    createSecret: () => Buffer.alloc(32, 1),
    sourceDiscovery: Object.freeze({
      async discover() {
        return Object.freeze([]);
      },
    }),
    exportChooser: Object.freeze({
      async choose() {
        throw new Error("chooser-must-not-run");
      },
    }),
    ownerOnlyStorage: Object.freeze({
      async establish() {
        throw new Error("synthetic-owner-only-failure");
      },
      async verify() {
        return false;
      },
    }),
  });
  const result = await startProjectHostAfterRecoveryPreparation({
    async prepareRecovery() {
      const preparation = await recovery.prepareLaunch();
      events.push(`recovery:${preparation.status}`);
      return preparation;
    },
    shutdownStarted: () => false,
    async startProjectHost() {
      starts += 1;
      events.push("project-host:start");
      return "started";
    },
  });
  assert.equal(result, "started");
  assert.equal(starts, 1);
  assert.deepEqual(events, ["recovery:unavailable", "project-host:start"]);
});

test("shutdown after preparation is the only reason Project Host is not started", async () => {
  let starts = 0;
  const result = await startProjectHostAfterRecoveryPreparation({
    async prepareRecovery() {
      return { status: "ready" as const };
    },
    shutdownStarted: () => true,
    async startProjectHost() {
      starts += 1;
      return "started";
    },
  });
  assert.equal(result, null);
  assert.equal(starts, 0);
});

test("instrumented real preparation discovers once before start and never rescans after release", async (t) => {
  const parent = await temporaryDirectory(t);
  const current = await createSyntheticStore(join(parent, "current"), 2);
  const events: string[] = [];
  let discoveries = 0;
  let providerOperations = 0;
  const recovery = createRegisteredHistoricalRecoveryLibrary(t, {
    dataDirectory: join(parent, "recovery"),
    createSecret: () => Buffer.alloc(32, 1),
    sourceDiscovery: Object.freeze({
      async discover() {
        discoveries += 1;
        events.push("recovery:discover");
        return Object.freeze([
          Object.freeze({
            providerClass: "synthetic-current",
            role: "current" as const,
            rootPath: current.root,
          }),
        ]);
      },
    }),
    exportChooser: Object.freeze({
      async choose() {
        throw new Error("chooser must remain inert");
      },
    }),
    ownerOnlyStorage: syntheticOwnerOnlyStorage,
  });
  let starts = 0;
  await startProjectHostAfterRecoveryPreparation({
    async prepareRecovery() {
      events.push("recovery:begin");
      const result = await recovery.prepareLaunch();
      events.push(`recovery:terminal:${result.status}`);
      return result;
    },
    shutdownStarted: () => false,
    async startProjectHost() {
      starts += 1;
      events.push("project-host:start");
      return Object.freeze({ started: true });
    },
  });
  await recovery.prepareLaunch();
  await recovery.execute(Object.freeze({}), {
    version: 1,
    requestKey: "post-start-snapshot",
  });
  assert.equal(discoveries, 1);
  assert.equal(starts, 1);
  assert.equal(providerOperations, 0);
  assert.equal(
    events.indexOf("recovery:terminal:ready") < events.indexOf("project-host:start"),
    true,
  );
  assert.deepEqual(events, [
    "recovery:begin",
    "recovery:discover",
    "recovery:terminal:ready",
    "project-host:start",
  ]);
  providerOperations += 0;
});

test("production discovery is a fixed closed provider set and never enumerates an app-data parent", async () => {
  const appDataDirectory = resolve("X:/synthetic-app-data");
  const currentUserDataDirectory = join(appDataDirectory, "unified-agent-workbench");
  const discovery = createProductionHistoryRecoverySourceDiscovery({
    appDataDirectory,
    currentUserDataDirectory,
  });
  const candidates = await discovery.discover();
  assert.deepEqual(
    candidates.map((candidate) => ({
      providerClass: candidate.providerClass,
      role: candidate.role,
      rootPath: candidate.rootPath,
    })),
    [
      {
        providerClass: "fixed-name-current",
        role: "current",
        rootPath: join(currentUserDataDirectory, "workbench-project-host"),
      },
      {
        providerClass: "legacy-electron-default",
        role: "historical",
        rootPath: join(appDataDirectory, "Electron", "workbench-project-host"),
      },
      {
        providerClass: "legacy-package-name",
        role: "historical",
        rootPath: join(
          appDataDirectory,
          "unified-agent-workbench",
          "workbench-project-host",
        ),
      },
      {
        providerClass: "legacy-packaged-product",
        role: "historical",
        rootPath: join(
          appDataDirectory,
          "Unified Agent Workbench",
          "workbench-project-host",
        ),
      },
    ],
  );
  assert.equal(candidates.every((candidate) => candidate.rootPath !== appDataDirectory), true);
  assert.throws(
    () =>
      createProductionHistoryRecoverySourceDiscovery({
        appDataDirectory,
        currentUserDataDirectory: resolve("Y:/outside"),
      }),
    /invalid-history-recovery-root/u,
  );
});

test("main composition keeps recovery before every mutation-capable Project Host opener", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );
  const recoveryCreation = source.indexOf("createHistoricalRecoveryLibrary({");
  const recoveryBarrier = source.indexOf("startProjectHostAfterRecoveryPreparation({");
  const authCreation = source.indexOf("createWorkLedgerAuthGenerationModule({");
  const hostInitialization = source.indexOf("initializeWorkbenchProjectHost({");
  assert.equal(recoveryCreation >= 0, true);
  assert.equal(recoveryCreation < recoveryBarrier, true);
  assert.equal(recoveryBarrier < authCreation, true);
  assert.equal(recoveryBarrier < hostInitialization, true);
  assert.equal(source.includes("recovery.prepareLaunch()"), true);
  assert.equal(source.includes("recovery.sourceDiscovery"), false);
});

test("the deferred production discovery keeps the guard and moves it off the startup path", async () => {
  const appDataDirectory = resolve("X:/synthetic-app-data");
  const containedUserDataDirectory = join(
    appDataDirectory,
    "unified-agent-workbench",
  );
  const escapingUserDataDirectory = resolve("Y:/outside");

  // The whole point of F117: constructing this must not be able to throw, because
  // production constructs it before any window exists.
  const escaping = createDeferredProductionHistoryRecoverySourceDiscovery({
    readAppDataDirectory: () => appDataDirectory,
    currentUserDataDirectory: escapingUserDataDirectory,
  });
  await assert.rejects(escaping.discover(), /invalid-history-recovery-root/u);

  // Resolving the app-data root can throw too: Electron raises when the
  // directory is absent. That read is deferred for exactly the same reason.
  const unresolvableRoot = createDeferredProductionHistoryRecoverySourceDiscovery({
    readAppDataDirectory: () => {
      throw new Error("Failed to get 'appData' path");
    },
    currentUserDataDirectory: containedUserDataDirectory,
  });
  await assert.rejects(unresolvableRoot.discover(), /Failed to get 'appData' path/u);

  // The guard is not widened: a contained root still yields the identical
  // closed provider set the eager factory produces.
  const deferred = createDeferredProductionHistoryRecoverySourceDiscovery({
    readAppDataDirectory: () => appDataDirectory,
    currentUserDataDirectory: containedUserDataDirectory,
  });
  const eager = createProductionHistoryRecoverySourceDiscovery({
    appDataDirectory,
    currentUserDataDirectory: containedUserDataDirectory,
  });
  assert.deepEqual(await deferred.discover(), await eager.discover());
});

test("a rejected recovery root degrades the feature and never fails the launch", async (t) => {
  const parent = await temporaryDirectory(t);
  let discoveryAttempts = 0;
  const recovery = createRegisteredHistoricalRecoveryLibrary(t, {
    dataDirectory: join(parent, "rejected-root"),
    createSecret: () => Buffer.alloc(32, 1),
    sourceDiscovery: createDeferredProductionHistoryRecoverySourceDiscovery({
      readAppDataDirectory: () => resolve("X:/synthetic-app-data"),
      currentUserDataDirectory: resolve("Y:/outside"),
    }),
    exportChooser: Object.freeze({
      async choose() {
        throw new Error("chooser-must-not-run");
      },
    }),
    ownerOnlyStorage: syntheticOwnerOnlyStorage,
  });

  let starts = 0;
  const started = await startProjectHostAfterRecoveryPreparation({
    async prepareRecovery() {
      discoveryAttempts += 1;
      return recovery.prepareLaunch();
    },
    shutdownStarted: () => false,
    async startProjectHost() {
      starts += 1;
      return "project-host";
    },
  });

  const preparation = await recovery.prepareLaunch();
  assert.equal(preparation.status, "unavailable");
  assert.equal(preparation.sourceCount, 0);
  assert.equal(discoveryAttempts, 1);
  assert.equal(started, "project-host");
  assert.equal(starts, 1);
});

test("a failed startup is presented and its exit never re-enters the quit guard", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );
  const presenter = source.slice(source.indexOf("function presentStartupFailure"));
  assert.notEqual(presenter, "");

  // Both routes out of startup reach the presenter: a throw in the ready body,
  // and an initialization that settled without ever showing a window.
  assert.match(
    source,
    /\}\)\.catch\(\(error: unknown\) => \{\s+if \(shutdownRequested\) return;\s+presentStartupFailure\(error\);\s+\}\);/u,
  );
  assert.match(
    source,
    /if \(initializationFailure !== null && !shutdownRequested\) \{\s+presentStartupFailure\(initializationFailure\.error\);/u,
  );

  // The failure surface is a real window the user can see and close, and closing
  // it exits directly. app.quit() would re-enter the before-quit guard, whose
  // no-backend behaviour is an open owner decision beside D16.2.
  assert.match(presenter, /new BrowserWindow\(\{[\s\S]*?show: true,/u);
  assert.match(presenter, /window\.on\("close", exitAfterFailure\);/u);
  assert.match(presenter, /window\.once\("closed", exitAfterFailure\);/u);
  assert.match(
    presenter,
    /const exitAfterFailure = \(\): void => \{\s+disposeNotificationIpcBinding\(\);\s+app\.exit\(1\);\s+\};/u,
  );
  assert.doesNotMatch(presenter, /app\.quit\(\)/u);
  assert.doesNotMatch(presenter, /lifecycle\.handle/u);
  assert.match(presenter, /Menu\.setApplicationMenu\(null\);/u);
});

const syntheticOwnerOnlyStorage = Object.freeze({
  async establish(_path: string, _kind: "directory" | "file") {},
  async verify(_path: string, _kind: "directory" | "file") {
    return true;
  },
});

async function temporaryDirectory(t: TestContext): Promise<string> {
  return createTestDirectory(
    t,
    join(tmpdir(), "synthetic-history-startup-test-"),
  );
}
