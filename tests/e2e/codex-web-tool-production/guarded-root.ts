import { createHash } from "node:crypto";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { DriverFailure, isRecord } from "./contract.ts";

const routineRootPattern = /^uaw-codex-web-tool-[A-Za-z0-9_-]+$/u;
const stagedRuntimePattern = /^codex-adapter-[0-9a-f]{32}$/u;

export async function listStagedRuntimeLeaves(
  parentDirectory: string,
): Promise<ReadonlySet<string>> {
  const entries = await readdir(parentDirectory, { withFileTypes: true });
  return new Set(
    entries
      .filter(
        (entry) => entry.isDirectory() && stagedRuntimePattern.test(entry.name),
      )
      .map((entry) => entry.name),
  );
}

export async function assertGuardedRoutineRoot(
  root: string,
  expectedParent: string,
): Promise<string> {
  const information = await lstat(root);
  const resolvedRoot = await realpath(root);
  const resolvedParent = await realpath(expectedParent);
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    comparable(dirname(resolvedRoot)) !== comparable(resolvedParent) ||
    !routineRootPattern.test(basename(resolvedRoot))
  ) {
    throw new DriverFailure("temporary-root");
  }
  return resolvedRoot;
}

export async function removeGuardedRoutineRoot(
  root: string,
  expectedParent: string,
): Promise<void> {
  const resolvedRoot = await assertGuardedRoutineRoot(root, expectedParent);
  await assertNoLinks(resolvedRoot);
  await rm(resolvedRoot, { recursive: true, force: false, maxRetries: 2 });
}

async function assertNoLinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new DriverFailure("root-cleanup");
    if (entry.isDirectory()) await assertNoLinks(join(directory, entry.name));
  }
}

export async function createManifest(
  root: string,
): Promise<ReadonlyMap<string, string>> {
  const manifest = new Map<string, string>();
  await walkManifest(root, root, manifest);
  return manifest;
}

async function walkManifest(
  root: string,
  directory: string,
  manifest: Map<string, string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const manifestPath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      await walkManifest(root, absolutePath, manifest);
    } else if (entry.isSymbolicLink()) {
      manifest.set(manifestPath, "symbolic-link");
    } else if (entry.isFile()) {
      manifest.set(
        manifestPath,
        createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
      );
    }
  }
}

export function sameManifest(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, hash] of left) if (right.get(path) !== hash) return false;
  return true;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (nativeErrorCode(error) === "ENOENT") return false;
    throw new DriverFailure("unexpected");
  }
}

export function nativeErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}
