import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const packagedBootstrapDirectoryName = "Workbench Home";

export interface WorkbenchStartupFileStatus {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface WorkbenchStartupFileSystem {
  lstat(path: string): Promise<WorkbenchStartupFileStatus>;
  mkdir(path: string): Promise<unknown>;
  realpath(path: string): Promise<string>;
}

export interface WorkbenchProjectHostStartupOptions {
  readonly dataDirectory: string;
  readonly fallbackProjectDirectory: string;
  readonly startupProjectDirectory?: string;
  readonly preferencePath: string;
}

export type WorkbenchRecoveryPreparationTerminalStatus =
  | "ready"
  | "partial"
  | "unavailable";

export async function startProjectHostAfterRecoveryPreparation<T>(options: {
  readonly prepareRecovery: () => Promise<{
    readonly status: WorkbenchRecoveryPreparationTerminalStatus;
  }>;
  readonly shutdownStarted: () => boolean;
  readonly startProjectHost: () => Promise<T>;
}): Promise<T | null> {
  try {
    const preparation = await options.prepareRecovery();
    if (
      preparation.status !== "ready" &&
      preparation.status !== "partial" &&
      preparation.status !== "unavailable"
    ) {
      throw new Error("invalid-recovery-preparation");
    }
  } catch {
    // Recovery preparation has one fixed global-unavailable terminal outcome.
  }
  if (options.shutdownStarted()) return null;
  return options.startProjectHost();
}

const nodeFileSystem: WorkbenchStartupFileSystem = Object.freeze({
  lstat: nodeLstat,
  mkdir: nodeMkdir,
  realpath: nodeRealpath,
});

export async function initializeWorkbenchProjectHost<T>(options: {
  readonly isPackaged: boolean;
  readonly userDataDirectory: string;
  readonly conversationStoreDirectory?: string;
  readonly currentWorkingDirectory: string;
  readonly startupProjectDirectory?: string;
  readonly fileSystem?: WorkbenchStartupFileSystem;
  readonly createProjectHost: (
    options: WorkbenchProjectHostStartupOptions,
  ) => Promise<T>;
}): Promise<T> {
  const dataDirectory =
    options.conversationStoreDirectory ??
    join(options.userDataDirectory, "workbench-project-host");
  const preferencePath = join(
    options.userDataDirectory,
    "direct-session-profile-preferences.json",
  );
  if (
    options.isPackaged &&
    options.startupProjectDirectory === undefined
  ) {
    const fallbackProjectDirectory = await ensurePackagedBootstrapProject(
      options.userDataDirectory,
      options.fileSystem ?? nodeFileSystem,
    );
    return options.createProjectHost({
      dataDirectory,
      fallbackProjectDirectory,
      preferencePath,
    });
  }
  const fallbackProjectDirectory =
    options.startupProjectDirectory ?? options.currentWorkingDirectory;
  return options.createProjectHost({
    dataDirectory,
    fallbackProjectDirectory,
    ...(options.startupProjectDirectory === undefined
      ? {}
      : { startupProjectDirectory: options.startupProjectDirectory }),
    preferencePath,
  });
}

async function ensurePackagedBootstrapProject(
  userDataDirectory: string,
  fileSystem: WorkbenchStartupFileSystem,
): Promise<string> {
  try {
    if (!isAbsolute(userDataDirectory)) throw new Error("invalid-data-root");
    const lexicalDataRoot = resolve(userDataDirectory);
    const dataRootStatus = await fileSystem.lstat(lexicalDataRoot);
    if (
      !dataRootStatus.isDirectory() ||
      dataRootStatus.isSymbolicLink()
    ) {
      throw new Error("invalid-data-root");
    }
    const resolvedDataRoot = await fileSystem.realpath(lexicalDataRoot);
    const bootstrapDirectory = join(
      lexicalDataRoot,
      packagedBootstrapDirectoryName,
    );
    let bootstrapStatus: WorkbenchStartupFileStatus;
    try {
      bootstrapStatus = await fileSystem.lstat(bootstrapDirectory);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      await fileSystem.mkdir(bootstrapDirectory);
      bootstrapStatus = await fileSystem.lstat(bootstrapDirectory);
    }
    if (
      !bootstrapStatus.isDirectory() ||
      bootstrapStatus.isSymbolicLink()
    ) {
      throw new Error("invalid-bootstrap");
    }
    const resolvedBootstrap = await fileSystem.realpath(bootstrapDirectory);
    if (
      !samePath(dirname(resolvedBootstrap), resolvedDataRoot) ||
      !samePath(
        resolvedBootstrap,
        join(resolvedDataRoot, packagedBootstrapDirectoryName),
      )
    ) {
      throw new Error("bootstrap-escaped");
    }
    return bootstrapDirectory;
  } catch {
    throw new Error("packaged-bootstrap-unavailable");
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
