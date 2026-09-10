import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  packageWorkbenchWindowsApplication,
  stageWorkbenchWindowsApplication,
  type WorkbenchPackagerOptions,
} from "../../scripts/package-workbench-windows.ts";

test("Windows packaging stages only the minimal production manifest and accepted Vite outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-package-test-"));
  const stagingDirectory = join(root, "staging");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeAcceptedBuild(root);

  const staged = await stageWorkbenchWindowsApplication({
    workspaceDirectory: root,
    stagingDirectory,
  });

  assert.deepEqual(staged.files, [
    "main/main.js",
    "package.json",
    "preload/preload.cjs",
    "renderer/assets/index-fixed.css",
    "renderer/assets/index-fixed.js",
    "renderer/index.html",
  ]);
  assert.deepEqual(await listFiles(stagingDirectory), staged.files);
  assert.deepEqual(
    JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8")),
    {
      name: "synchronized-intellect-network",
      productName: "Synchronized Intellect Network",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "main/main.js",
    },
  );
});

test("Windows packaging uses one ASAR-backed unpacked Windows x64 application and removes staging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-package-options-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeAcceptedBuild(root);
  const calls: WorkbenchPackagerOptions[] = [];

  const result = await packageWorkbenchWindowsApplication({
    workspaceDirectory: root,
    outputDirectory: join(root, "local-package"),
    temporaryDirectory: root,
    packageApplication: async (options) => {
      calls.push(options);
      return [join(root, "local-package", "Synchronized Intellect Network-win32-x64")];
    },
  });

  assert.equal(calls.length, 1);
  const { dir, ...portableOptions } = calls[0];
  assert.deepEqual(portableOptions, {
    out: join(root, "local-package"),
    platform: "win32",
    arch: "x64",
    asar: true,
    name: "Synchronized Intellect Network",
    executableName: "Synchronized Intellect Network",
    electronVersion: "37.2.6",
    overwrite: true,
    prune: true,
    quiet: true,
  });
  assert.equal(typeof dir, "string");
  assert.equal(basename(dir).startsWith("workbench-package-stage-"), true);
  await assert.rejects(access(dir));
  assert.deepEqual(result, {
    applicationDirectory: join(
      root,
      "local-package",
      "Synchronized Intellect Network-win32-x64",
    ),
    stagedFiles: [
      "main/main.js",
      "package.json",
      "preload/preload.cjs",
      "renderer/assets/index-fixed.css",
      "renderer/assets/index-fixed.js",
      "renderer/index.html",
    ],
  });
});

test("Windows packaging removes staging and returns a fixed failure when packaging fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workbench-package-failure-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeAcceptedBuild(root);
  let stagingDirectory = "";

  await assert.rejects(
    packageWorkbenchWindowsApplication({
      workspaceDirectory: root,
      outputDirectory: join(root, "local-package"),
      temporaryDirectory: root,
      packageApplication: async ({ dir }) => {
        stagingDirectory = dir as string;
        throw new Error("private packager detail");
      },
    }),
    { message: "workbench-package-failed" },
  );
  await assert.rejects(access(stagingDirectory));
});

test("the local Windows package command and Electron-maintained packager are exact-pinned", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts["workbench:package:windows"],
    "pnpm build && node scripts/package-workbench-windows.ts",
  );
  assert.equal(packageJson.devDependencies["@electron/packager"], "20.0.4");
});

async function writeAcceptedBuild(workspaceDirectory: string): Promise<void> {
  await mkdir(join(workspaceDirectory, "dist", "main"), { recursive: true });
  await mkdir(join(workspaceDirectory, "dist", "preload"), { recursive: true });
  await mkdir(join(workspaceDirectory, "dist", "renderer", "assets"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(join(workspaceDirectory, "dist", "main", "main.js"), "main"),
    writeFile(
      join(workspaceDirectory, "dist", "preload", "preload.cjs"),
      "preload",
    ),
    writeFile(
      join(workspaceDirectory, "dist", "renderer", "index.html"),
      "renderer",
    ),
    writeFile(
      join(
        workspaceDirectory,
        "dist",
        "renderer",
        "assets",
        "index-fixed.js",
      ),
      "renderer-script",
    ),
    writeFile(
      join(
        workspaceDirectory,
        "dist",
        "renderer",
        "assets",
        "index-fixed.css",
      ),
      "renderer-style",
    ),
  ]);
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else files.push(child);
  }
  return files.sort();
}
