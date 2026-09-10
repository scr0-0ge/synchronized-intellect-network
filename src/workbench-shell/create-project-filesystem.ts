import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type { WorkbenchCreateProjectCreateResult } from "./create-project-transition.ts";

export type WorkbenchCreateProjectPathKind =
  | "absent"
  | "file"
  | "directory"
  | "alias"
  | "reparse"
  | "unavailable";

export interface WorkbenchCreateProjectFilesystem {
  createIfAbsent(targetPath: string): Promise<WorkbenchCreateProjectCreateResult>;
}

export interface WorkbenchCreateProjectFilesystemBoundary {
  inspect(path: string): Promise<WorkbenchCreateProjectPathKind>;
  mkdir(path: string): Promise<void>;
}

export function createNodeWorkbenchCreateProjectFilesystem(): WorkbenchCreateProjectFilesystem {
  return createWorkbenchCreateProjectFilesystem({
    inspect: inspectNodePath,
    async mkdir(targetPath: string): Promise<void> {
      await mkdir(targetPath, { recursive: false });
    },
  });
}

export function createWorkbenchCreateProjectFilesystem(
  boundary: WorkbenchCreateProjectFilesystemBoundary,
): WorkbenchCreateProjectFilesystem {
  return Object.freeze({
    async createIfAbsent(
      targetPath: string,
    ): Promise<WorkbenchCreateProjectCreateResult> {
      if (!isSafeAbsoluteTarget(targetPath)) {
        return "create-failed-known-no-commit";
      }
      const parentPath = dirname(targetPath);
      let parentKind: WorkbenchCreateProjectPathKind;
      let targetKind: WorkbenchCreateProjectPathKind;
      try {
        parentKind = await boundary.inspect(parentPath);
        if (parentKind !== "directory") return parentFailure(parentKind);
        targetKind = await boundary.inspect(targetPath);
      } catch {
        return "create-failed-known-no-commit";
      }
      switch (targetKind) {
        case "file":
          return "collision-file";
        case "directory":
          return "collision-directory";
        case "alias":
          return "collision-alias";
        case "reparse":
          return "collision-reparse";
        case "unavailable":
          return "create-failed-known-no-commit";
        case "absent":
          break;
      }
      try {
        await boundary.mkdir(targetPath);
        return "created";
      } catch (error) {
        return classifyCreateFailure(error);
      }
    },
  });
}

function parentFailure(
  kind: Exclude<WorkbenchCreateProjectPathKind, "directory">,
): WorkbenchCreateProjectCreateResult {
  switch (kind) {
    case "absent":
      return "parent-directory-missing";
    case "file":
      return "parent-is-file";
    case "alias":
      return "parent-is-alias";
    case "reparse":
      return "parent-is-reparse";
    case "unavailable":
      return "parent-unavailable";
  }
}

async function inspectNodePath(
  path: string,
): Promise<WorkbenchCreateProjectPathKind> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink()) {
      return process.platform === "win32" ? "reparse" : "alias";
    }
    if (information.isDirectory()) return "directory";
    if (information.isFile()) return "file";
    return "alias";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "absent" : "unavailable";
  }
}

function classifyCreateFailure(
  error: unknown,
): WorkbenchCreateProjectCreateResult {
  const code = errorCode(error);
  if (code === "EEXIST") return "target-appeared";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "parent-unavailable";
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return "create-denied";
  }
  if (
    code === "EINVAL" ||
    code === "ENAMETOOLONG" ||
    code === "ELOOP" ||
    code === "ENOSPC" ||
    code === "EDQUOT"
  ) {
    return "create-failed-known-no-commit";
  }
  return "unknown";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isSafeAbsoluteTarget(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    isAbsolute(value) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
