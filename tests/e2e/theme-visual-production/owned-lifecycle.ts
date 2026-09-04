import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { ElectronApplication } from "playwright";

import { samePath } from "./launch-isolation.ts";
import { failureFact, type FailureFact } from "./publication.ts";

export type OwnedChildExitState = Readonly<{
  hasExited: () => boolean;
  exited: Promise<void>;
}>;

export type OwnedApplication = Readonly<{
  application: ElectronApplication;
  child: ChildProcess;
  exitState: OwnedChildExitState;
  pid: number;
}>;

export type CleanupFact = Readonly<{
  pidCaptured: true;
  gracefulCloseAttempted: boolean;
  gracefulCloseSucceeded: boolean;
  terminationFallbackUsed: boolean;
  forcedExactChildTerminationRequested: boolean;
  exited: boolean;
}>;

export type CleanupOutcome = Readonly<{
  fact: CleanupFact;
  failures: readonly FailureFact[];
}>;

export async function closeOwnedApplication(
  owned: OwnedApplication,
  liveApplications: Set<OwnedApplication>,
): Promise<void> {
  assert.equal(owned.child.pid, owned.pid);
  await withTimeout(owned.application.close(), 10_000);
  await waitForOwnedChildExit(owned, 5_000);
  liveApplications.delete(owned);
}

export async function terminateExactOwnedApplicationChild(
  owned: OwnedApplication,
  liveApplications: Set<OwnedApplication>,
): Promise<Readonly<{
  forcedExactChildTerminationRequested: boolean;
  exited: boolean;
  failure: FailureFact | null;
}>> {
  let forcedExactChildTerminationRequested = false;
  let failure: FailureFact | null = null;
  try {
    assert.equal(owned.child.pid, owned.pid);
    if (!owned.exitState.hasExited()) {
      forcedExactChildTerminationRequested = true;
      owned.child.kill();
    }
    await waitForOwnedChildExit(owned, 5_000);
  } catch {
    failure = failureFact(
      "final-exact-owned-child-termination",
      "exact-owned-child-termination-failed",
    );
  }
  const exited = owned.exitState.hasExited();
  if (exited) liveApplications.delete(owned);
  return Object.freeze({ forcedExactChildTerminationRequested, exited, failure });
}

export async function cleanupOwnedApplicationLifecycle(
  owned: OwnedApplication,
  liveApplications: Set<OwnedApplication>,
): Promise<CleanupOutcome> {
  const failures: FailureFact[] = [];
  try {
    await closeOwnedApplication(owned, liveApplications);
    return Object.freeze({
      fact: Object.freeze({
        pidCaptured: true,
        gracefulCloseAttempted: true,
        gracefulCloseSucceeded: true,
        terminationFallbackUsed: false,
        forcedExactChildTerminationRequested: false,
        exited: true,
      }),
      failures,
    });
  } catch {
    failures.push(
      failureFact("final-application-close", "owned-application-close-failed"),
    );
  }

  const termination = await terminateExactOwnedApplicationChild(
    owned,
    liveApplications,
  );
  if (termination.failure !== null) failures.push(termination.failure);
  return Object.freeze({
    fact: Object.freeze({
      pidCaptured: true,
      gracefulCloseAttempted: true,
      gracefulCloseSucceeded: false,
      terminationFallbackUsed: true,
      forcedExactChildTerminationRequested:
        termination.forcedExactChildTerminationRequested,
      exited: termination.exited,
    }),
    failures,
  });
}

export async function assertAllOwnedChildrenExited(
  applications: ReadonlySet<OwnedApplication>,
): Promise<void> {
  for (const owned of applications) {
    assert.equal(owned.child.pid, owned.pid);
    assert.equal(owned.exitState.hasExited(), true);
  }
}

export async function removeOwnedRoutineRoot(
  base: string,
  root: string,
  routineRootPrefix: string,
): Promise<void> {
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("invalid-owned-root");
  }
  const resolvedRoot = await realpath(root);
  const resolvedBase = await realpath(base);
  if (
    !samePath(dirname(resolvedRoot), resolvedBase) ||
    !basename(resolvedRoot).startsWith(routineRootPrefix)
  ) {
    throw new Error("owned-root-identity-failed");
  }
  await rm(resolvedRoot, { recursive: true, force: false, maxRetries: 3 });
}

async function waitForOwnedChildExit(
  owned: OwnedApplication,
  timeout: number,
): Promise<void> {
  assert.equal(owned.child.pid, owned.pid);
  await withTimeout(owned.exitState.exited, timeout);
  assert.equal(owned.exitState.hasExited(), true);
}

function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error("operation-timeout")), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectValue(error);
      },
    );
  });
}
