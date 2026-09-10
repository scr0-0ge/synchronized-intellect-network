import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRODUCTION_MANIFEST = {
  name: "synchronized-intellect-network",
  productName: "Synchronized Intellect Network",
  version: "0.0.0",
  private: true,
  type: "module",
  main: "main/main.js",
} as const;

export interface StageWorkbenchWindowsApplicationOptions {
  workspaceDirectory: string;
  stagingDirectory: string;
}

export interface StagedWorkbenchWindowsApplication {
  files: string[];
}

export interface WorkbenchPackagerOptions {
  dir: string;
  out: string;
  platform: "win32";
  arch: "x64";
  asar: true;
  name: "Synchronized Intellect Network";
  executableName: "Synchronized Intellect Network";
  electronVersion: "37.2.6";
  overwrite: true;
  prune: true;
  quiet: true;
}

export interface PackageWorkbenchWindowsApplicationOptions {
  workspaceDirectory: string;
  outputDirectory: string;
  temporaryDirectory: string;
  packageApplication: (
    options: WorkbenchPackagerOptions,
  ) => Promise<string[]>;
}

export interface PackagedWorkbenchWindowsApplication {
  applicationDirectory: string;
  stagedFiles: string[];
}

export async function packageWorkbenchWindowsApplication(
  options: PackageWorkbenchWindowsApplicationOptions,
): Promise<PackagedWorkbenchWindowsApplication> {
  const stagingDirectory = await mkdtemp(
    join(resolve(options.temporaryDirectory), "workbench-package-stage-"),
  );
  let result: PackagedWorkbenchWindowsApplication | undefined;
  let failed = false;
  try {
    const staged = await stageWorkbenchWindowsApplication({
      workspaceDirectory: options.workspaceDirectory,
      stagingDirectory,
    });
    const applicationDirectories = await options.packageApplication({
      dir: stagingDirectory,
      out: resolve(options.outputDirectory),
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
    if (applicationDirectories.length !== 1) {
      throw new Error("unexpected-package-count");
    }
    result = {
      applicationDirectory: applicationDirectories[0],
      stagedFiles: staged.files,
    };
  } catch {
    failed = true;
  }

  try {
    await rm(stagingDirectory, { recursive: true, force: true });
  } catch {
    failed = true;
  }
  if (failed || result === undefined) {
    throw new Error("workbench-package-failed");
  }
  return result;
}

export async function stageWorkbenchWindowsApplication(
  options: StageWorkbenchWindowsApplicationOptions,
): Promise<StagedWorkbenchWindowsApplication> {
  const workspaceDirectory = resolve(options.workspaceDirectory);
  const stagingDirectory = resolve(options.stagingDirectory);
  const buildDirectory = join(workspaceDirectory, "dist");
  const rendererAssetsDirectory = join(buildDirectory, "renderer", "assets");
  const rendererAssets = (await readdir(rendererAssetsDirectory))
    .filter((name) => /\.(?:css|js)$/.test(name))
    .sort()
    .map((name) => `renderer/assets/${name}`);
  const buildFiles = [
    "main/main.js",
    "preload/preload.cjs",
    ...rendererAssets,
    "renderer/index.html",
  ].sort();

  await mkdir(stagingDirectory, { recursive: true });
  await Promise.all(
    buildFiles.map(async (file) => {
      const source = containedPath(buildDirectory, file);
      const destination = containedPath(stagingDirectory, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }),
  );
  await writeFile(
    join(stagingDirectory, "package.json"),
    `${JSON.stringify(PRODUCTION_MANIFEST, null, 2)}\n`,
    "utf8",
  );

  return { files: [...buildFiles, "package.json"].sort() };
}

function containedPath(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(root, child);
  const childRelative = relative(resolvedRoot, resolvedChild);
  if (
    childRelative.length === 0 ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`)
  ) {
    throw new Error("workbench-package-path-invalid");
  }
  return resolvedChild;
}

async function runLocalWindowsPackageCommand(): Promise<void> {
  const workspaceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageName: string = "@electron/packager";
  const packagerModule = (await import(packageName)) as {
    packager: PackageWorkbenchWindowsApplicationOptions["packageApplication"];
  };
  const packaged = await packageWorkbenchWindowsApplication({
    workspaceDirectory,
    outputDirectory: join(workspaceDirectory, "dist", "local-windows-package"),
    temporaryDirectory: tmpdir(),
    packageApplication: packagerModule.packager,
  });
  process.stdout.write(
    `Synchronized Intellect Network local Windows x64 package ready (${packaged.stagedFiles.length} staged files).\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runLocalWindowsPackageCommand().catch(() => {
    process.stderr.write("Synchronized Intellect Network local Windows package failed.\n");
    process.exitCode = 1;
  });
}
