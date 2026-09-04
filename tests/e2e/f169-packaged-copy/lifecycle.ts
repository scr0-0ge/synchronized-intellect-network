import type { ChildProcess } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

import type { ElectronApplication } from "playwright";

const temporaryRootPattern = /^workbench-f169-[A-Za-z0-9_-]+$/u;

export type ApplicationCleanupOutcome = Readonly<{
  gracefulCloseSucceeded: boolean;
  forcedExactChildTerminationRequested: boolean;
  exactChildDeathProved: true;
}>;

export async function restoreClipboard(
  application: ElectronApplication,
  originalClipboardText: string,
): Promise<void> {
  const restored = await application.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
    return clipboard.readText() === value;
  }, originalClipboardText);
  if (!restored) throw new Error("original-clipboard-text-restore-failed");
}

export async function closeOwnedApplication(
  application: ElectronApplication | undefined,
  ownedMainProcess: ChildProcess | undefined,
  ownedMainPid: number | undefined,
): Promise<ApplicationCleanupOutcome | undefined> {
  if (application === undefined) return undefined;
  const currentMainProcess = application.process();
  if (
    ownedMainProcess === undefined ||
    ownedMainPid === undefined ||
    ownedMainPid <= 0 ||
    currentMainProcess !== ownedMainProcess ||
    currentMainProcess.pid !== ownedMainPid
  ) {
    throw new Error("owned-application-process-mismatch");
  }
  let gracefulCloseSucceeded = false;
  let forcedExactChildTerminationRequested = false;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("application-close-timeout")), 10_000),
      ),
    ]);
    gracefulCloseSucceeded = true;
  } catch {
    // Only the exact child launched above is eligible for the fallback below.
  }
  let exited = await waitForExactOwnedChildExit(ownedMainProcess, ownedMainPid, 1_000);
  if (!exited && isExactOwnedChildAlive(ownedMainProcess, ownedMainPid)) {
    forcedExactChildTerminationRequested = true;
    ownedMainProcess.kill();
  }
  exited =
    exited ||
    (await waitForExactOwnedChildExit(ownedMainProcess, ownedMainPid, 5_000));
  if (!exited) throw new Error("exact-owned-application-process-survived-cleanup");
  return Object.freeze({
    gracefulCloseSucceeded:
      gracefulCloseSucceeded && !forcedExactChildTerminationRequested,
    forcedExactChildTerminationRequested,
    exactChildDeathProved: true,
  });
}

async function waitForExactOwnedChildExit(
  child: ChildProcess,
  ownedPid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (ownedPid <= 0 || child.pid !== ownedPid) return false;
  const exitObserved =
    child.exitCode !== null ||
    child.signalCode !== null ||
    (await Promise.race([
      new Promise<true>((resolveExit) => child.once("exit", () => resolveExit(true))),
      new Promise<false>((resolveWait) =>
        setTimeout(() => resolveWait(false), timeoutMilliseconds),
      ),
    ]));
  return exitObserved && !(await processAlive(ownedPid));
}

function isExactOwnedChildAlive(child: ChildProcess, ownedPid: number): boolean {
  return (
    ownedPid > 0 &&
    child.pid === ownedPid &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function removeOwnedTemporaryRoot(root: string): Promise<void> {
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("temporary-root-type-check-failed");
  }
  const resolvedRoot = await realpath(root);
  const resolvedTemporaryDirectory = await realpath(tmpdir());
  if (
    dirname(resolvedRoot) !== resolvedTemporaryDirectory ||
    !temporaryRootPattern.test(basename(resolvedRoot))
  ) {
    throw new Error("temporary-root-ownership-check-failed");
  }
  await rm(resolvedRoot, { recursive: true, force: false });
}

export function throwCleanupFailures(
  primaryFailure: { readonly error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
): void {
  if (cleanupFailures.length === 0) return;
  throw new AggregateError(
    primaryFailure === undefined
      ? cleanupFailures
      : [primaryFailure.error, ...cleanupFailures],
    "F169 packaged-copy cleanup failed",
  );
}
