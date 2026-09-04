import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { join } from "node:path";

export async function inspectFreshDist(
  repositoryRoot: string,
): Promise<Record<string, unknown>> {
  const sources = [
    ...(await listFiles(join(repositoryRoot, "src", "workbench-shell"))),
    join(repositoryRoot, "vite.main.config.ts"),
    join(repositoryRoot, "vite.preload.config.ts"),
    join(repositoryRoot, "vite.renderer.config.ts"),
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "pnpm-lock.yaml"),
  ];
  const rendererAssets = await listFiles(join(repositoryRoot, "dist", "renderer"));
  const artifacts = [
    join(repositoryRoot, "dist", "main", "main.js"),
    join(repositoryRoot, "dist", "preload", "preload.cjs"),
    ...rendererAssets,
  ];
  assert.ok(rendererAssets.some((path) => path.endsWith("index.html")));
  assert.ok(rendererAssets.some((path) => path.endsWith(".js")));
  assert.ok(rendererAssets.some((path) => path.endsWith(".css")));
  const sourceStats = await Promise.all(sources.map((path) => stat(path)));
  const artifactStats = await Promise.all(artifacts.map((path) => stat(path)));
  const newestSource = Math.max(...sourceStats.map((entry) => entry.mtimeMs));
  const oldestArtifact = Math.min(...artifactStats.map((entry) => entry.mtimeMs));
  assert.ok(oldestArtifact >= newestSource, "dist is older than source");
  const artifactFacts = await Promise.all(
    artifacts.map(async (path) => {
      const bytes = await readFile(path);
      return {
        role: distRole(repositoryRoot, path),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      };
    }),
  );
  const sourceDigest = await treeDigest(repositoryRoot, sources);
  const distDigest = sha256(
    artifactFacts
      .map((entry) => `${entry.role}|${entry.bytes}|${entry.sha256}`)
      .sort()
      .join("\n"),
  );
  return {
    fresh: true,
    sourceFileCount: sources.length,
    sourceTreeSha256: sourceDigest,
    artifactCount: artifactFacts.length,
    distTreeSha256: distDigest,
    artifacts: artifactFacts.sort((left, right) =>
      left.role.localeCompare(right.role),
    ),
    unrelatedRootArtifactsExcluded: true,
  };
}

export async function byteFact(path: string): Promise<Readonly<{
  bytes: number;
  sha256: string;
}>> {
  const bytes = await readFile(path);
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

export async function optionalByteFact(path: string): Promise<Readonly<
  | { state: "absent" }
  | { state: "present"; bytes: number; sha256: string }
>> {
  if (await isMissing(path)) return Object.freeze({ state: "absent" });
  return Object.freeze({ state: "present", ...(await byteFact(path)) });
}

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function treeDigest(
  repositoryRoot: string,
  paths: readonly string[],
): Promise<string> {
  const rows = await Promise.all(
    [...paths].sort().map(async (path) => {
      const relative = path.slice(repositoryRoot.length + 1).replaceAll("\\", "/");
      return `${relative}|${sha256(await readFile(path))}`;
    }),
  );
  return sha256(rows.join("\n"));
}

function distRole(repositoryRoot: string, path: string): string {
  return path.slice(join(repositoryRoot, "dist").length + 1).replaceAll("\\", "/");
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function isMissing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    );
  }
}
