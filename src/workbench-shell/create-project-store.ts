import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import {
  createEmptyWorkbenchCreateProjectState,
  validateWorkbenchCreateProjectState,
  type WorkbenchCreateProjectActiveOperation,
  type WorkbenchCreateProjectCompletedOperation,
  type WorkbenchCreateProjectState,
} from "./create-project-transition.ts";

export const WORKBENCH_CREATE_PROJECT_SIDECAR_NAME =
  "create-project-operation-v1.json";
export const WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME =
  "create-project-operation-v1.replacement";
export const WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME =
  "create-project-operation-v1.backup";

const maximumSidecarBytes = 262_144;

export type WorkbenchCreateProjectStateAtomicReplace = (
  replacementPath: string,
  destinationPath: string,
) => Promise<void>;

export interface WorkbenchCreateProjectReplacementFile {
  writeFile(contents: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type WorkbenchCreateProjectReplacementOpener = (
  replacementPath: string,
) => Promise<WorkbenchCreateProjectReplacementFile>;

export interface WorkbenchCreateProjectStateStore {
  readonly state: WorkbenchCreateProjectState;
  write(next: WorkbenchCreateProjectState): Promise<boolean>;
  close(): Promise<void>;
}

export type WorkbenchCreateProjectStateStoreOpenResult =
  | { readonly ok: true; readonly store: WorkbenchCreateProjectStateStore }
  | { readonly ok: false };

export async function openWorkbenchCreateProjectStateStore(options: {
  readonly dataDirectory: string;
  readonly atomicReplace?: WorkbenchCreateProjectStateAtomicReplace;
  readonly openReplacement?: WorkbenchCreateProjectReplacementOpener;
}): Promise<WorkbenchCreateProjectStateStoreOpenResult> {
  const paths = sidecarPaths(options.dataDirectory);
  const atomicReplace = options.atomicReplace ?? rename;
  const openReplacement = options.openReplacement ?? openReplacementFile;
  try {
    await mkdir(paths.dataDirectory, { recursive: true });
    const directoryInformation = await lstat(paths.dataDirectory);
    if (
      !directoryInformation.isDirectory() ||
      directoryInformation.isSymbolicLink()
    ) {
      return Object.freeze({ ok: false });
    }

    const stateInformation = await safeLstat(paths.stateFile);
    const replacementInformation = await safeLstat(paths.replacementFile);
    const backupInformation = await safeLstat(paths.backupFile);
    if (stateInformation === "failed" ||
      replacementInformation === "failed" ||
      backupInformation === "failed") {
      return Object.freeze({ ok: false });
    }

    let state: WorkbenchCreateProjectState;
    if (stateInformation === null) {
      state = createEmptyWorkbenchCreateProjectState();
      if (backupInformation !== null) return Object.freeze({ ok: false });
      if (replacementInformation !== null) {
        if (!isAcceptableStateFile(replacementInformation)) {
          return Object.freeze({ ok: false });
        }
        const replacement = await readExactState(paths.replacementFile);
        if (
          replacement === undefined ||
          serializeWorkbenchCreateProjectState(replacement) !==
            serializeWorkbenchCreateProjectState(state)
        ) {
          return Object.freeze({ ok: false });
        }
        await rm(paths.replacementFile, { force: false });
        if (await pathExists(paths.replacementFile)) {
          return Object.freeze({ ok: false });
        }
      }
      const committed = await writeSidecar(
        paths,
        null,
        state,
        atomicReplace,
        openReplacement,
      );
      if (!committed) return Object.freeze({ ok: false });
    } else {
      if (
        backupInformation !== null ||
        !isAcceptableStateFile(stateInformation)
      ) {
        return Object.freeze({ ok: false });
      }
      const parsed = await readExactState(paths.stateFile);
      if (parsed === undefined) return Object.freeze({ ok: false });
      if (replacementInformation !== null) {
        if (!isAcceptableStateFile(replacementInformation)) {
          return Object.freeze({ ok: false });
        }
        const replacement = await readExactState(paths.replacementFile);
        if (
          replacement === undefined ||
          replacement.revision !== parsed.revision + 1
        ) {
          return Object.freeze({ ok: false });
        }
        await rm(paths.replacementFile, { force: false });
        if (await pathExists(paths.replacementFile)) {
          return Object.freeze({ ok: false });
        }
      }
      state = parsed;
    }
    return Object.freeze({
      ok: true,
      store: createStore(paths, state, atomicReplace, openReplacement),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

export function serializeWorkbenchCreateProjectState(
  state: WorkbenchCreateProjectState,
): string {
  if (!validateWorkbenchCreateProjectState(state)) {
    throw new Error("invalid-create-project-state");
  }
  return `${JSON.stringify({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    lifecycle: state.lifecycle,
    nextOperationNumber: state.nextOperationNumber,
    active: state.active === null ? null : serializeActive(state.active),
    last: state.last === null ? null : serializeCompleted(state.last),
    recoveryTargets: [...state.recoveryTargets],
  })}\n`;
}

function createStore(
  paths: SidecarPaths,
  initial: WorkbenchCreateProjectState,
  atomicReplace: WorkbenchCreateProjectStateAtomicReplace,
  openReplacement: WorkbenchCreateProjectReplacementOpener,
): WorkbenchCreateProjectStateStore {
  let current = initial;
  let closed = false;
  let queue = Promise.resolve();
  return Object.freeze({
    get state(): WorkbenchCreateProjectState {
      return current;
    },
    write(next: WorkbenchCreateProjectState): Promise<boolean> {
      const expected = current;
      const run = async (): Promise<boolean> => {
        if (
          closed ||
          current !== expected ||
          next.revision !== expected.revision + 1 ||
          !validateWorkbenchCreateProjectState(next)
        ) return false;
        const committed = await writeSidecar(
          paths,
          expected,
          next,
          atomicReplace,
          openReplacement,
        );
        if (committed) current = next;
        return committed;
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async close(): Promise<void> {
      closed = true;
      await queue;
    },
  });
}

async function writeSidecar(
  paths: SidecarPaths,
  prior: WorkbenchCreateProjectState | null,
  next: WorkbenchCreateProjectState,
  atomicReplace: WorkbenchCreateProjectStateAtomicReplace,
  openReplacement: WorkbenchCreateProjectReplacementOpener,
): Promise<boolean> {
  const contents = serializeWorkbenchCreateProjectState(next);
  let handle: WorkbenchCreateProjectReplacementFile | undefined;
  try {
    const committedBefore = await readExactState(paths.stateFile);
    if (prior === null) {
      if (await pathExists(paths.stateFile)) return false;
    } else if (
      committedBefore === undefined ||
      serializeWorkbenchCreateProjectState(committedBefore) !==
        serializeWorkbenchCreateProjectState(prior)
    ) {
      return false;
    }
    if (
      (await pathExists(paths.replacementFile)) ||
      (await pathExists(paths.backupFile))
    ) {
      return false;
    }
    handle = await openReplacement(paths.replacementFile);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await atomicReplace(paths.replacementFile, paths.stateFile);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    const committed = await readExactState(paths.stateFile);
    if (
      committed !== undefined &&
      serializeWorkbenchCreateProjectState(committed) === contents
    ) {
      await cleanupPrivateArtifacts(paths);
      return true;
    }
    if (
      prior === null ||
      (committed !== undefined &&
        serializeWorkbenchCreateProjectState(committed) ===
          serializeWorkbenchCreateProjectState(prior))
    ) {
      await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    }
    return false;
  }
}

async function openReplacementFile(
  replacementPath: string,
): Promise<WorkbenchCreateProjectReplacementFile> {
  const handle = await open(replacementPath, "wx", 0o600);
  return {
    async writeFile(contents: string): Promise<void> {
      await handle.writeFile(contents, "utf8");
    },
    async sync(): Promise<void> {
      await handle.sync();
    },
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

async function readExactState(
  stateFile: string,
): Promise<WorkbenchCreateProjectState | undefined> {
  try {
    const information = await lstat(stateFile);
    if (!isAcceptableStateFile(information)) return undefined;
    const bytes = await readFile(stateFile);
    if (bytes.byteLength > maximumSidecarBytes) return undefined;
    const contents = bytes.toString("utf8");
    if (Buffer.byteLength(contents, "utf8") !== bytes.byteLength) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(contents);
    if (!validateWorkbenchCreateProjectState(parsed)) return undefined;
    if (serializeWorkbenchCreateProjectState(parsed) !== contents) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function serializeActive(
  active: WorkbenchCreateProjectActiveOperation,
): Record<string, unknown> {
  return {
    operationNumber: active.operationNumber,
    phase: active.phase,
    targetToken: active.targetToken,
    chooserResult: active.chooserResult,
    createResult: active.createResult,
    registrationResult: active.registrationResult,
    createCommitted: active.createCommitted,
    registrationCommitted: active.registrationCommitted,
    outcome: active.outcome,
  };
}

function serializeCompleted(
  last: WorkbenchCreateProjectCompletedOperation,
): Record<string, unknown> {
  return {
    operationNumber: last.operationNumber,
    phase: last.phase,
    targetToken: last.targetToken,
    chooserResult: last.chooserResult,
    createResult: last.createResult,
    registrationResult: last.registrationResult,
    createCommitted: last.createCommitted,
    registrationCommitted: last.registrationCommitted,
    outcome: last.outcome,
  };
}

type SidecarPaths = {
  readonly dataDirectory: string;
  readonly stateFile: string;
  readonly replacementFile: string;
  readonly backupFile: string;
};

function sidecarPaths(dataDirectory: string): SidecarPaths {
  return {
    dataDirectory,
    stateFile: join(dataDirectory, WORKBENCH_CREATE_PROJECT_SIDECAR_NAME),
    replacementFile: join(
      dataDirectory,
      WORKBENCH_CREATE_PROJECT_SIDECAR_REPLACEMENT_NAME,
    ),
    backupFile: join(
      dataDirectory,
      WORKBENCH_CREATE_PROJECT_SIDECAR_BACKUP_NAME,
    ),
  };
}

async function cleanupPrivateArtifacts(paths: SidecarPaths): Promise<void> {
  await rm(paths.replacementFile, { force: true }).catch(() => undefined);
  await rm(paths.backupFile, { force: true }).catch(() => undefined);
}

async function safeLstat(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null | "failed"> {
  try {
    return await lstat(path);
  } catch (error) {
    return isMissing(error) ? null : "failed";
  }
}

function isAcceptableStateFile(
  information: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return information.isFile() &&
    !information.isSymbolicLink() &&
    information.size <= maximumSidecarBytes;
}

async function pathExists(path: string): Promise<boolean> {
  const result = await safeLstat(path);
  if (result === "failed") {
    throw new Error("Create Project sidecar artifact could not be inspected.");
  }
  return result !== null;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
