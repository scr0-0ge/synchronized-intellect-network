import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createNodeWorkbenchCreateProjectFilesystem,
  createWorkbenchCreateProjectFilesystem,
  type WorkbenchCreateProjectPathKind,
} from "../../src/workbench-shell/create-project-filesystem.ts";

test("production filesystem makes exactly one absent child non-recursively and leaves it present", async (t) => {
  const root = await ownedTemporaryRoot(t);
  const target = join(root, "New Project");
  const filesystem = createNodeWorkbenchCreateProjectFilesystem();

  assert.equal(await filesystem.createIfAbsent(target), "created");
  const information = await lstat(target);
  assert.equal(information.isDirectory(), true);
  assert.equal(information.isSymbolicLink(), false);
  assert.equal(await filesystem.createIfAbsent(target), "collision-directory");
  assert.equal((await lstat(target)).isDirectory(), true);
});

test("production filesystem never recursively creates a missing parent", async (t) => {
  const root = await ownedTemporaryRoot(t);
  const missingParent = join(root, "missing", "parent");
  const target = join(missingParent, "New Project");
  const filesystem = createNodeWorkbenchCreateProjectFilesystem();

  assert.equal(
    await filesystem.createIfAbsent(target),
    "parent-directory-missing",
  );
  await assert.rejects(lstat(missingParent), { code: "ENOENT" });
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("filesystem keeps each unavailable parent cause distinct without creating", async () => {
  const target = "C:\\owned-test-root\\New Project";
  const parent = dirname(target);
  for (const [parentKind, expected] of [
    ["absent", "parent-directory-missing"],
    ["file", "parent-is-file"],
    ["alias", "parent-is-alias"],
    ["reparse", "parent-is-reparse"],
    ["unavailable", "parent-unavailable"],
  ] as const) {
    let targetProbes = 0;
    let mkdirCalls = 0;
    const filesystem = createWorkbenchCreateProjectFilesystem({
      async inspect(path) {
        if (path === parent) return parentKind;
        targetProbes += 1;
        return "absent";
      },
      async mkdir() { mkdirCalls += 1; },
    });
    assert.equal(await filesystem.createIfAbsent(target), expected, parentKind);
    assert.deepEqual({ targetProbes, mkdirCalls }, { targetProbes: 0, mkdirCalls: 0 });
  }
});

test("filesystem classifies every preflight collision and atomic-create result with one mkdir maximum", async () => {
  const target = "C:\\owned-test-root\\New Project";
  const parent = dirname(target);
  for (const [targetKind, expected] of [
    ["file", "collision-file"],
    ["directory", "collision-directory"],
    ["alias", "collision-alias"],
    ["reparse", "collision-reparse"],
  ] as const) {
    let mkdirCalls = 0;
    const filesystem = createWorkbenchCreateProjectFilesystem({
      async inspect(path) {
        return path === parent ? "directory" : targetKind;
      },
      async mkdir() { mkdirCalls += 1; },
    });
    assert.equal(await filesystem.createIfAbsent(target), expected);
    assert.equal(mkdirCalls, 0);
  }

  const errors: readonly [string, string][] = [
    ["EEXIST", "target-appeared"],
    ["ENOENT", "parent-unavailable"],
    ["ENOTDIR", "parent-unavailable"],
    ["EACCES", "create-denied"],
    ["EPERM", "create-denied"],
    ["EROFS", "create-denied"],
    ["EINVAL", "create-failed-known-no-commit"],
    ["PRIVATE_UNKNOWN", "unknown"],
  ];
  for (const [code, expected] of errors) {
    let mkdirCalls = 0;
    const filesystem = createWorkbenchCreateProjectFilesystem({
      async inspect(path): Promise<WorkbenchCreateProjectPathKind> {
        return path === parent ? "directory" : "absent";
      },
      async mkdir() {
        mkdirCalls += 1;
        throw Object.assign(new Error("PRIVATE_CREATE_FAILURE"), { code });
      },
    });
    assert.equal(await filesystem.createIfAbsent(target), expected, code);
    assert.equal(mkdirCalls, 1, code);
  }
});

test("filesystem rejects malformed targets without probing or creating", async () => {
  let inspectCalls = 0;
  let mkdirCalls = 0;
  const filesystem = createWorkbenchCreateProjectFilesystem({
    async inspect() { inspectCalls += 1; return "absent"; },
    async mkdir() { mkdirCalls += 1; },
  });
  for (const target of ["", "relative", "C:\\bad\u0000target", "/bad\npath"]) {
    assert.equal(await filesystem.createIfAbsent(target), "create-failed-known-no-commit");
  }
  assert.deepEqual({ inspectCalls, mkdirCalls }, { inspectCalls: 0, mkdirCalls: 0 });
});

async function ownedTemporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workbench-create-filesystem-"));
  const resolvedRoot = resolve(root);
  assert.equal(resolvedRoot.startsWith(`${resolve(tmpdir())}\\`), true);
  t.after(async () => {
    const information = await lstat(root);
    assert.equal(information.isDirectory(), true);
    assert.equal(information.isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
