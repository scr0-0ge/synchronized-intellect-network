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

/**
 * The step that failed, in the order the packaging run performs them.
 *
 * There are five distinct ways this command can fail and they call for five
 * different next actions: `stage-build-output` almost always means `pnpm build`
 * has not run, while `run-electron-packager` means the build is fine and the
 * packager is not. Reporting one sentence for all of them told the reader
 * nothing they could act on.
 */
export type WorkbenchPackageStage =
  | "create-staging-directory"
  | "stage-build-output"
  | "run-electron-packager"
  | "read-packager-result"
  | "remove-staging-directory";

/**
 * A packaging failure that carries the step, the path that step was working on,
 * and the error it was refused with.
 *
 * `cause` is the original error rather than a substitute, because the substitute
 * is what made every distinct failure look identical. `message` keeps the
 * `workbench-package-failed` prefix so the identifier stays greppable and then
 * says which of the five steps failed, where, and why.
 */
export class WorkbenchPackageError extends Error {
  readonly stage: WorkbenchPackageStage;
  readonly path: string;

  constructor(stage: WorkbenchPackageStage, path: string, cause: unknown) {
    super(
      `workbench-package-failed: ${stage} failed at ${path}: ${describeCause(cause)}`,
      { cause },
    );
    this.name = "WorkbenchPackageError";
    this.stage = stage;
    this.path = path;
  }
}

export async function packageWorkbenchWindowsApplication(
  options: PackageWorkbenchWindowsApplicationOptions,
): Promise<PackagedWorkbenchWindowsApplication> {
  const temporaryDirectory = resolve(options.temporaryDirectory);
  let stagingDirectory: string;
  try {
    stagingDirectory = await mkdtemp(
      join(temporaryDirectory, "workbench-package-stage-"),
    );
  } catch (error) {
    // Nothing has been created yet, so there is nothing to clean up and the
    // reader needs the directory that could not be written in, not the
    // staging path that was never allocated.
    throw new WorkbenchPackageError(
      "create-staging-directory",
      temporaryDirectory,
      error,
    );
  }

  let result: PackagedWorkbenchWindowsApplication | undefined;
  let failure: WorkbenchPackageError | undefined;
  try {
    const staged = await stageWorkbenchWindowsApplication({
      workspaceDirectory: options.workspaceDirectory,
      stagingDirectory,
    });
    let applicationDirectories: string[];
    try {
      applicationDirectories = await options.packageApplication({
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
    } catch (error) {
      throw new WorkbenchPackageError(
        "run-electron-packager",
        stagingDirectory,
        error,
      );
    }
    if (applicationDirectories.length !== 1) {
      throw new WorkbenchPackageError(
        "read-packager-result",
        resolve(options.outputDirectory),
        new Error(
          `the packager reported ${applicationDirectories.length} application directories; exactly one was expected`,
        ),
      );
    }
    result = {
      applicationDirectory: applicationDirectories[0],
      stagedFiles: staged.files,
    };
  } catch (error) {
    failure =
      error instanceof WorkbenchPackageError
        ? error
        : new WorkbenchPackageError(
            "stage-build-output",
            resolve(options.workspaceDirectory),
            error,
          );
  }

  try {
    await rm(stagingDirectory, { recursive: true, force: true });
  } catch (error) {
    // A cleanup failure is still a failure -- the staging tree is left on disk
    // -- but it must not overwrite the reason the run failed in the first
    // place, which is what the reader is here for.
    failure ??= new WorkbenchPackageError(
      "remove-staging-directory",
      stagingDirectory,
      error,
    );
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) {
    throw new WorkbenchPackageError(
      "read-packager-result",
      resolve(options.outputDirectory),
      new Error("the packaging run produced no application directory"),
    );
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
  let rendererAssetNames: string[];
  try {
    rendererAssetNames = await readdir(rendererAssetsDirectory);
  } catch (error) {
    // The single most common way this command fails: `pnpm build` has not run,
    // so `dist/` is not there. Naming the directory is the whole difference
    // between "it failed" and "run the build first".
    throw new WorkbenchPackageError(
      "stage-build-output",
      rendererAssetsDirectory,
      error,
    );
  }
  const rendererAssets = rendererAssetNames
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
      try {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      } catch (error) {
        // One of these four is missing far more often than all of them are, so
        // the failing file is the fact worth carrying out.
        throw new WorkbenchPackageError("stage-build-output", source, error);
      }
    }),
  );
  const manifestPath = join(stagingDirectory, "package.json");
  try {
    await writeFile(
      manifestPath,
      `${JSON.stringify(PRODUCTION_MANIFEST, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    throw new WorkbenchPackageError("stage-build-output", manifestPath, error);
  }

  return { files: [...buildFiles, "package.json"].sort() };
}

/**
 * The reader-facing text of whatever the underlying call refused with.
 *
 * A Node filesystem error's `message` already contains its `code` and its path,
 * which is exactly what the reader needs; anything that is not an `Error` is
 * still reported rather than dropped, because "an unprintable failure" is more
 * useful than silence.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message.length > 0 ? cause.message : cause.name;
  }
  return typeof cause === "string" ? cause : String(cause);
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

/** The multi-line stderr report for one failure, ending in a newline. */
export function failureReport(error: unknown): string {
  if (!(error instanceof WorkbenchPackageError)) {
    return `  Reason: ${describeCause(error)}\n`;
  }
  const lines = [
    `  Step:   ${error.stage}`,
    `  Path:   ${error.path}`,
    `  Reason: ${describeCause(error.cause)}`,
  ];
  const advice = nextStep(error.stage);
  if (advice !== undefined) lines.push(`  Next:   ${advice}`);
  return `${lines.join("\n")}\n`;
}

function nextStep(stage: WorkbenchPackageStage): string | undefined {
  switch (stage) {
    case "stage-build-output":
      return "run `pnpm build` first, then run this command again.";
    case "run-electron-packager":
      return "run `pnpm install --frozen-lockfile` to confirm @electron/packager 20.0.4 is installed, then run this command again.";
    case "remove-staging-directory":
      return "the application may have been packaged; delete the staging directory above by hand.";
    default:
      return undefined;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runLocalWindowsPackageCommand().catch((error: unknown) => {
    // The launcher's own failure text is the model: name what was being done,
    // the path it was being done to, and what to do next. Discarding the error
    // here is what made every distinct failure read as one sentence.
    process.stderr.write(
      `Synchronized Intellect Network local Windows package failed.\n${failureReport(error)}`,
    );
    process.exitCode = 1;
  });
}
