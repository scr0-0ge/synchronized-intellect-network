import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  initializeWorkbenchProjectHost,
  type WorkbenchStartupFileStatus,
  type WorkbenchStartupFileSystem,
} from "../../src/workbench-shell/electron/startup.ts";

test("development startup preserves the current-directory fallback without touching the packaged bootstrap", async () => {
  const userDataDirectory = join(tmpdir(), "workbench-startup-user-data");
  const currentWorkingDirectory = join(tmpdir(), "workbench-development-project");
  let createCalls = 0;

  const result = await initializeWorkbenchProjectHost({
    isPackaged: false,
    userDataDirectory,
    currentWorkingDirectory,
    fileSystem: {
      async lstat() {
        assert.fail("Development startup must not inspect the packaged bootstrap.");
      },
      async mkdir() {
        assert.fail("Development startup must not create the packaged bootstrap.");
      },
      async realpath() {
        assert.fail("Development startup must not resolve the packaged bootstrap.");
      },
    },
    async createProjectHost(options) {
      createCalls += 1;
      return options;
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(result.fallbackProjectDirectory, currentWorkingDirectory);
  assert.equal(result.startupProjectDirectory, undefined);
  assert.equal(result.dataDirectory, join(userDataDirectory, "workbench-project-host"));
  assert.equal(
    result.preferencePath,
    join(userDataDirectory, "direct-session-profile-preferences.json"),
  );
});

test("an explicit packaged startup Project bypasses bootstrap inference and keeps the native override exact", async () => {
  const userDataDirectory = join(tmpdir(), "workbench-explicit-user-data");
  const explicitProjectDirectory = join(tmpdir(), "workbench-explicit-project");
  let fileSystemCalls = 0;

  const result = await initializeWorkbenchProjectHost({
    isPackaged: true,
    userDataDirectory,
    currentWorkingDirectory: join(tmpdir(), "neutral-working-directory"),
    startupProjectDirectory: explicitProjectDirectory,
    fileSystem: {
      async lstat() {
        fileSystemCalls += 1;
        assert.fail("An explicit startup Project must bypass the bootstrap.");
      },
      async mkdir() {
        fileSystemCalls += 1;
        assert.fail("An explicit startup Project must bypass the bootstrap.");
      },
      async realpath() {
        fileSystemCalls += 1;
        assert.fail("An explicit startup Project must bypass the bootstrap.");
      },
    },
    async createProjectHost(options) {
      return options;
    },
  });

  assert.equal(fileSystemCalls, 0);
  assert.equal(result.startupProjectDirectory, explicitProjectDirectory);
  assert.equal(result.fallbackProjectDirectory, explicitProjectDirectory);
});

test("packaged startup creates one exact empty Workbench Home child and keeps private stores outside it", async (t) => {
  const userDataDirectory = await mkdtemp(
    join(tmpdir(), "workbench-packaged-user-data-"),
  );
  t.after(() => rm(userDataDirectory, { recursive: true, force: true }));

  const result = await initializeWorkbenchProjectHost({
    isPackaged: true,
    userDataDirectory,
    currentWorkingDirectory: join(tmpdir(), "must-not-be-trusted"),
    async createProjectHost(options) {
      return options;
    },
  });

  const expectedBootstrap = join(userDataDirectory, "Workbench Home");
  const bootstrapStatus = await lstat(expectedBootstrap);
  assert.equal(result.fallbackProjectDirectory, expectedBootstrap);
  assert.equal(bootstrapStatus.isDirectory(), true);
  assert.equal(bootstrapStatus.isSymbolicLink(), false);
  assert.deepEqual(await readdir(expectedBootstrap), []);
  assert.equal(dirname(await realpath(expectedBootstrap)), await realpath(userDataDirectory));
  assert.equal(result.dataDirectory.startsWith(`${expectedBootstrap}\\`), false);
  assert.equal(result.preferencePath.startsWith(`${expectedBootstrap}\\`), false);
});

test("packaged startup reuses an existing safe Workbench Home without recreating it", async (t) => {
  const userDataDirectory = await mkdtemp(
    join(tmpdir(), "workbench-packaged-reuse-"),
  );
  const bootstrapDirectory = join(userDataDirectory, "Workbench Home");
  await mkdir(bootstrapDirectory);
  t.after(() => rm(userDataDirectory, { recursive: true, force: true }));
  let mkdirCalls = 0;

  const result = await initializeWorkbenchProjectHost({
    isPackaged: true,
    userDataDirectory,
    currentWorkingDirectory: join(tmpdir(), "must-not-be-trusted"),
    fileSystem: {
      lstat,
      async mkdir() {
        mkdirCalls += 1;
      },
      realpath,
    },
    async createProjectHost(options) {
      return options;
    },
  });

  assert.equal(result.fallbackProjectDirectory, bootstrapDirectory);
  assert.equal(mkdirCalls, 0);
});

test("packaged bootstrap rejects files, reparse points, escapes, creation failures, and post-create mismatches before backend or Runtime construction", async () => {
  const dataRoot = "C:\\Workbench-Test-Data";
  const bootstrap = join(dataRoot, "Workbench Home");
  const directory = status({ directory: true });
  const file = status({ directory: false });
  const reparse = status({ directory: true, symbolicLink: true });
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly fileSystem: WorkbenchStartupFileSystem;
  }> = [
    {
      name: "pre-existing file",
      fileSystem: fakeFileSystem({ dataRoot, bootstrap, childStatus: file }),
    },
    {
      name: "pre-existing symlink or reparse point",
      fileSystem: fakeFileSystem({ dataRoot, bootstrap, childStatus: reparse }),
    },
    {
      name: "resolved parent escape",
      fileSystem: fakeFileSystem({
        dataRoot,
        bootstrap,
        childStatus: directory,
        resolvedBootstrap: "C:\\Escaped-Data\\Workbench Home",
      }),
    },
    {
      name: "creation failure",
      fileSystem: fakeFileSystem({
        dataRoot,
        bootstrap,
        childStatus: "missing",
        mkdirError: new Error("PRIVATE_CREATION_FAILURE"),
      }),
    },
    {
      name: "post-create validation mismatch",
      fileSystem: fakeFileSystem({
        dataRoot,
        bootstrap,
        childStatus: "missing",
        postCreateStatus: file,
      }),
    },
  ];

  for (const scenario of cases) {
    let backendCalls = 0;
    let runtimeConstructions = 0;
    await assert.rejects(
      initializeWorkbenchProjectHost({
        isPackaged: true,
        userDataDirectory: dataRoot,
        currentWorkingDirectory: "C:\\Neutral-Working-Directory",
        fileSystem: scenario.fileSystem,
        async createProjectHost() {
          backendCalls += 1;
          runtimeConstructions += 1;
          return undefined;
        },
      }),
      { message: "packaged-bootstrap-unavailable" },
      scenario.name,
    );
    assert.equal(backendCalls, 0, scenario.name);
    assert.equal(runtimeConstructions, 0, scenario.name);
  }
});

function status(options: {
  readonly directory: boolean;
  readonly symbolicLink?: boolean;
}): WorkbenchStartupFileStatus {
  return Object.freeze({
    isDirectory: () => options.directory,
    isSymbolicLink: () => options.symbolicLink === true,
  });
}

function fakeFileSystem(options: {
  readonly dataRoot: string;
  readonly bootstrap: string;
  readonly childStatus: WorkbenchStartupFileStatus | "missing";
  readonly postCreateStatus?: WorkbenchStartupFileStatus;
  readonly resolvedBootstrap?: string;
  readonly mkdirError?: Error;
}): WorkbenchStartupFileSystem {
  let created = false;
  return {
    async lstat(path) {
      if (path === options.dataRoot) return status({ directory: true });
      if (path !== options.bootstrap) throw new Error("unexpected-test-path");
      if (options.childStatus !== "missing") return options.childStatus;
      if (!created) {
        const error = new Error("missing") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return options.postCreateStatus ?? status({ directory: true });
    },
    async mkdir(path) {
      assert.equal(path, options.bootstrap);
      if (options.mkdirError !== undefined) throw options.mkdirError;
      created = true;
    },
    async realpath(path) {
      if (path === options.dataRoot) return options.dataRoot;
      if (path === options.bootstrap) {
        return options.resolvedBootstrap ?? options.bootstrap;
      }
      throw new Error("unexpected-test-path");
    },
  };
}
