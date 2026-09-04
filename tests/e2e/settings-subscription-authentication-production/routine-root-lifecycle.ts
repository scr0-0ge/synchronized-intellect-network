import assert from "node:assert/strict";
import {
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  fileIdentity,
  isMissing,
  isMissingFailure,
  sameFileIdentity,
  type FileIdentity,
} from "./publication.ts";

export type RoutineRootState = Readonly<{
  presence: "PRESENT" | "MISSING" | "UNKNOWN";
  exactIdentityProved: boolean;
}>;

export function createRoutineRootLifecycle(routineRootPrefix: string) {
  async function removeOwnedRoutineRoot(
    base: string,
    root: string,
    expectedIdentity: FileIdentity,
  ): Promise<void> {
    const actualIdentity = await captureOwnedRoutineRootIdentity(base, root);
    assert.equal(sameFileIdentity(expectedIdentity, actualIdentity), true);
    await rm(root, { recursive: true, force: false, maxRetries: 3 });
    assert.equal(await isMissing(root), true);
  }

  async function captureOwnedRoutineRootIdentity(
    base: string,
    root: string,
  ): Promise<FileIdentity> {
    const rootStatus = await lstat(root, { bigint: true });
    assert.equal(rootStatus.isDirectory(), true);
    assert.equal(rootStatus.isSymbolicLink(), false);
    const resolvedRoot = await realpath(root);
    const resolvedBase = await realpath(base);
    assert.equal(samePath(dirname(resolvedRoot), resolvedBase), true);
    assert.equal(basename(resolvedRoot).startsWith(routineRootPrefix), true);
    return fileIdentity(rootStatus.dev, rootStatus.ino);
  }

  async function inspectRoutineRootState(
    base: string,
    root: string,
    expectedIdentity: FileIdentity | undefined,
  ): Promise<RoutineRootState> {
    if (base.length === 0 || root.length === 0 || expectedIdentity === undefined) {
      return Object.freeze({ presence: "UNKNOWN", exactIdentityProved: false });
    }
    try {
      const rootStatus = await lstat(root, { bigint: true });
      if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
        return Object.freeze({ presence: "UNKNOWN", exactIdentityProved: false });
      }
      const actualIdentity = fileIdentity(rootStatus.dev, rootStatus.ino);
      const resolvedRoot = await realpath(root);
      const resolvedBase = await realpath(base);
      const exactIdentityProved =
        sameFileIdentity(expectedIdentity, actualIdentity) &&
        samePath(dirname(resolvedRoot), resolvedBase) &&
        basename(resolvedRoot).startsWith(routineRootPrefix);
      return exactIdentityProved
        ? Object.freeze({ presence: "PRESENT", exactIdentityProved: true })
        : Object.freeze({ presence: "UNKNOWN", exactIdentityProved: false });
    } catch (caught) {
      return isMissingFailure(caught)
        ? Object.freeze({ presence: "MISSING", exactIdentityProved: false })
        : Object.freeze({ presence: "UNKNOWN", exactIdentityProved: false });
    }
  }

  return Object.freeze({
    removeOwnedRoutineRoot,
    captureOwnedRoutineRootIdentity,
    inspectRoutineRootState,
  });
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US")
    : a === b;
}
