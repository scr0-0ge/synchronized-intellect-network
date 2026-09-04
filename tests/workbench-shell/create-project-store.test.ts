import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME,
  WORKBENCH_CREATE_PROJECT_SIDECAR_NAME,
  WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME,
  openWorkbenchCreateProjectStateStore,
  serializeWorkbenchCreateProjectState,
} from "../../src/workbench-shell/create-project-store.ts";
import { transitionWorkbenchCreateProject } from "../../src/workbench-shell/create-project-transition.ts";

test("sidecar first open and exact restart preserve canonical versioned state", async (t) => {
  const root = await ownedTemporaryRoot(t);
  const dataDirectory = join(root, "host-data");
  const opened = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(opened.ok, true);
  if (!opened.ok) assert.fail("Expected the private sidecar to open.");

  const initialBytes = await readFile(
    join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME),
    "utf8",
  );
  assert.equal(initialBytes, serializeWorkbenchCreateProjectState(opened.store.state));
  assert.deepEqual(opened.store.state, {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "open",
    nextOperationNumber: 1,
    active: null,
    last: null,
    recoveryTargets: [],
  });

  const accepted = transitionWorkbenchCreateProject(opened.store.state, {
    kind: "renderer-create-intent",
  });
  assert.equal(accepted.applied, true);
  assert.equal(await opened.store.write(accepted.state), true);
  await opened.store.close();

  const restarted = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(restarted.ok, true);
  if (!restarted.ok) assert.fail("Expected an exact restart.");
  assert.deepEqual(restarted.store.state, accepted.state);
  assert.equal(
    await readFile(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME), "utf8"),
    serializeWorkbenchCreateProjectState(accepted.state),
  );
  await restarted.store.close();
});

test("sidecar rejects malformed, duplicate, noncanonical numeric, extra, and oversized bytes", async (t) => {
  const cases: readonly [string, string][] = [
    ["malformed", "{\n"],
    [
      "duplicate",
      '{"schemaVersion":1,"schemaVersion":1,"revision":0,"lifecycle":"open","nextOperationNumber":1,"active":null,"last":null,"recoveryTargets":[]}\n',
    ],
    [
      "numeric",
      '{"schemaVersion":1.0,"revision":0,"lifecycle":"open","nextOperationNumber":1,"active":null,"last":null,"recoveryTargets":[]}\n',
    ],
    [
      "extra",
      '{"schemaVersion":1,"revision":0,"lifecycle":"open","nextOperationNumber":1,"active":null,"last":null,"recoveryTargets":[],"extra":true}\n',
    ],
    ["oversized", " ".repeat(262_145)],
  ];

  for (const [name, bytes] of cases) {
    const root = await ownedTemporaryRoot(t, `workbench-create-store-${name}-`);
    const dataDirectory = join(root, "host-data");
    await writeFile(join(root, "placeholder"), "owned", "utf8");
    await mkdir(dataDirectory);
    const statePath = join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME);
    await writeFile(statePath, bytes, "utf8");
    const before = await readFile(statePath);

    assert.deepEqual(await openWorkbenchCreateProjectStateStore({ dataDirectory }), {
      ok: false,
    }, name);
    assert.deepEqual(await readFile(statePath), before, name);
  }
});

test("sidecar fails closed on state symlinks and replacement or backup ambiguity", async (t) => {
  const root = await ownedTemporaryRoot(t);
  const external = join(root, "outside-state");
  await mkdir(external);
  for (const artifact of [
    WORKBENCH_CREATE_PROJECT_SIDECAR_NAME,
    WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME,
    WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME,
  ]) {
    const dataDirectory = join(root, artifact.replace(/[^a-z]/giu, "-"));
    await mkdir(dataDirectory);
    if (artifact === WORKBENCH_CREATE_PROJECT_SIDECAR_NAME) {
      await symlink(external, join(dataDirectory, artifact), "junction");
    } else {
      const opened = await openWorkbenchCreateProjectStateStore({ dataDirectory });
      assert.equal(opened.ok, true);
      if (!opened.ok) assert.fail("Expected initial sidecar.");
      await opened.store.close();
      await writeFile(join(dataDirectory, artifact), "ambiguous", "utf8");
    }
    assert.deepEqual(await openWorkbenchCreateProjectStateStore({ dataDirectory }), {
      ok: false,
    });
  }
});

test("restart discards one exact synced pre-commit replacement and preserves the committed primary", async (t) => {
  const root = await ownedTemporaryRoot(t, "workbench-create-precommit-");
  const dataDirectory = join(root, "host-data");
  const seeded = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(seeded.ok, true);
  if (!seeded.ok) assert.fail("Expected a seeded sidecar.");
  const priorState = seeded.store.state;
  const priorBytes = await readFile(
    join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME),
  );
  const accepted = transitionWorkbenchCreateProject(priorState, {
    kind: "renderer-create-intent",
  });
  assert.equal(accepted.applied, true);
  await seeded.store.close();

  const replacementPath = join(
    dataDirectory,
    WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME,
  );
  const replacement = await open(replacementPath, "wx", 0o600);
  await replacement.writeFile(
    serializeWorkbenchCreateProjectState(accepted.state),
    "utf8",
  );
  await replacement.sync();
  await replacement.close();

  const restarted = await openWorkbenchCreateProjectStateStore({
    dataDirectory,
  });
  assert.equal(restarted.ok, true);
  if (!restarted.ok) assert.fail("Expected pre-commit reconciliation.");
  assert.deepEqual(restarted.store.state, priorState);
  assert.deepEqual(
    await readFile(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME)),
    priorBytes,
  );
  await assert.rejects(lstat(replacementPath), { code: "ENOENT" });
  await restarted.store.close();
});

test("first-open restart discards only the exact synced empty replacement", async (t) => {
  const root = await ownedTemporaryRoot(t, "workbench-create-first-precommit-");
  const dataDirectory = join(root, "host-data");
  await mkdir(dataDirectory);
  const replacementPath = join(
    dataDirectory,
    WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME,
  );
  const emptyBytes =
    '{"schemaVersion":1,"revision":0,"lifecycle":"open","nextOperationNumber":1,"active":null,"last":null,"recoveryTargets":[]}\n';
  const replacement = await open(replacementPath, "wx", 0o600);
  await replacement.writeFile(emptyBytes, "utf8");
  await replacement.sync();
  await replacement.close();

  const opened = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(opened.ok, true);
  if (!opened.ok) assert.fail("Expected exact first-open reconciliation.");
  assert.equal(
    await readFile(
      join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME),
      "utf8",
    ),
    emptyBytes,
  );
  await assert.rejects(lstat(replacementPath), { code: "ENOENT" });
  await assert.rejects(
    lstat(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME)),
    { code: "ENOENT" },
  );
  await opened.store.close();

  const restarted = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(restarted.ok, true);
  if (!restarted.ok) assert.fail("Expected clean restart after reconciliation.");
  assert.equal(restarted.store.state.revision, 0);
  await restarted.store.close();
});

test("first open requires all three private sidecar artifacts to be absent", async (t) => {
  for (const artifact of [
    WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME,
    WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME,
  ]) {
    const root = await ownedTemporaryRoot(t, "workbench-create-first-open-");
    const dataDirectory = join(root, "host-data");
    await mkdir(dataDirectory);
    const artifactPath = join(dataDirectory, artifact);
    await writeFile(artifactPath, "ambiguous", "utf8");
    const before = await readFile(artifactPath);
    assert.deepEqual(await openWorkbenchCreateProjectStateStore({ dataDirectory }), {
      ok: false,
    });
    assert.deepEqual(await readFile(artifactPath), before);
  }
});

test("atomic replacement reconciles post-commit throws and preserves prior bytes before commit", async (t) => {
  for (const mode of ["before", "after"] as const) {
    const root = await ownedTemporaryRoot(t, `workbench-create-replace-${mode}-`);
    const dataDirectory = join(root, "host-data");
    if (mode === "before") {
      const seeded = await openWorkbenchCreateProjectStateStore({ dataDirectory });
      assert.equal(seeded.ok, true);
      if (!seeded.ok) assert.fail("Expected a seeded sidecar.");
      await seeded.store.close();
    }
    const opened = await openWorkbenchCreateProjectStateStore({
      dataDirectory,
      async atomicReplace(replacementPath, destinationPath) {
        if (mode === "before") throw new Error("PRIVATE_PRE_COMMIT_FAILURE");
        await rename(replacementPath, destinationPath);
        throw new Error("PRIVATE_POST_COMMIT_FAILURE");
      },
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) assert.fail("Expected the exact committed sidecar.");
    const prior = await readFile(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME));
    const accepted = transitionWorkbenchCreateProject(opened.store.state, {
      kind: "renderer-create-intent",
    });
    assert.equal(await opened.store.write(accepted.state), mode === "after");
    if (mode === "after") {
      assert.notDeepEqual(
        await readFile(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME)),
        prior,
      );
    } else {
      assert.deepEqual(
        await readFile(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME)),
        prior,
      );
      await assert.rejects(
        lstat(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME)),
        { code: "ENOENT" },
      );
    }
    await opened.store.close();
    if (mode === "after") {
      const restarted = await openWorkbenchCreateProjectStateStore({ dataDirectory });
      assert.equal(restarted.ok, true);
      if (!restarted.ok) assert.fail("Expected the reconciled commit on restart.");
      assert.deepEqual(restarted.store.state, accepted.state);
      await restarted.store.close();
    }
  }
});

test("replacement write and sync failures preserve prior bytes and never reach atomic replace", async (t) => {
  for (const failurePoint of ["write", "sync"] as const) {
    const root = await ownedTemporaryRoot(t, `workbench-create-${failurePoint}-`);
    const dataDirectory = join(root, "host-data");
    const seeded = await openWorkbenchCreateProjectStateStore({ dataDirectory });
    assert.equal(seeded.ok, true);
    if (!seeded.ok) assert.fail("Expected a seeded sidecar.");
    await seeded.store.close();
    const unrelatedPath = join(dataDirectory, "unrelated-private-sentinel");
    await writeFile(unrelatedPath, "unchanged", "utf8");

    const calls: string[] = [];
    let replaceCalls = 0;
    const opened = await openWorkbenchCreateProjectStateStore({
      dataDirectory,
      async openReplacement(replacementPath) {
        calls.push("open");
        const handle = await open(replacementPath, "wx", 0o600);
        return {
          async writeFile(contents) {
            calls.push("write");
            if (failurePoint === "write") throw new Error("PRIVATE_WRITE_FAILURE");
            await handle.writeFile(contents, "utf8");
          },
          async sync() {
            calls.push("sync");
            if (failurePoint === "sync") throw new Error("PRIVATE_SYNC_FAILURE");
            await handle.sync();
          },
          async close() {
            calls.push("close");
            await handle.close();
          },
        };
      },
      async atomicReplace() { replaceCalls += 1; },
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) assert.fail("Expected an exact committed sidecar.");
    const statePath = join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME);
    const prior = await readFile(statePath);
    const accepted = transitionWorkbenchCreateProject(opened.store.state, {
      kind: "renderer-create-intent",
    });

    assert.equal(await opened.store.write(accepted.state), false);
    assert.deepEqual(await readFile(statePath), prior);
    assert.equal(replaceCalls, 0);
    assert.deepEqual(
      calls,
      failurePoint === "write"
        ? ["open", "write", "close"]
        : ["open", "write", "sync", "close"],
    );
    await assert.rejects(
      lstat(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME)),
      { code: "ENOENT" },
    );
    await assert.rejects(
      lstat(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME)),
      { code: "ENOENT" },
    );
    assert.equal(await readFile(unrelatedPath, "utf8"), "unchanged");
    await opened.store.close();
  }
});

test("queued writes compare against their invocation-time prior state", async (t) => {
  const root = await ownedTemporaryRoot(t, "workbench-create-queued-cas-");
  const dataDirectory = join(root, "host-data");
  const seeded = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(seeded.ok, true);
  if (!seeded.ok) assert.fail("Expected a seeded sidecar.");
  await seeded.store.close();

  const replaceStarted = createDeferred<void>();
  const releaseReplace = createDeferred<void>();
  const opened = await openWorkbenchCreateProjectStateStore({
    dataDirectory,
    async atomicReplace(replacementPath, destinationPath) {
      replaceStarted.resolve();
      await releaseReplace.promise;
      await rename(replacementPath, destinationPath);
    },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) assert.fail("Expected the exact seeded sidecar.");

  const accepted = transitionWorkbenchCreateProject(opened.store.state, {
    kind: "renderer-create-intent",
  });
  const staleClose = transitionWorkbenchCreateProject(opened.store.state, {
    kind: "close",
  });
  assert.equal(accepted.applied, true);
  assert.equal(staleClose.applied, true);

  const firstWrite = opened.store.write(accepted.state);
  await replaceStarted.promise;
  const staleWrite = opened.store.write(staleClose.state);
  releaseReplace.resolve();

  assert.deepEqual(await Promise.all([firstWrite, staleWrite]), [true, false]);
  assert.deepEqual(opened.store.state, accepted.state);
  assert.equal(
    await readFile(join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME), "utf8"),
    serializeWorkbenchCreateProjectState(accepted.state),
  );
  await opened.store.close();
});

async function ownedTemporaryRoot(
  t: TestContext,
  prefix = "workbench-create-store-",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resolvedRoot = resolve(root);
  const resolvedTemporary = `${resolve(tmpdir())}\\`;
  assert.equal(resolvedRoot.startsWith(resolvedTemporary), true);
  t.after(async () => {
    const information = await lstat(root);
    assert.equal(information.isDirectory(), true);
    assert.equal(information.isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
