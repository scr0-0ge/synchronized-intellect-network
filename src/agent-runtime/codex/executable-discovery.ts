import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";

const maximumOfficialRoots = 4;
const maximumRootEntries = 64;
const maximumPathCandidates = 64;
const maximumPathLookupBytes = 16_384;
const contentHashLeafPattern = /^[0-9a-f]{16,64}$/u;

declare const codexExecutableHandleBrand: unique symbol;

export interface CodexExecutableHandle {
  readonly [codexExecutableHandleBrand]: true;
}

export type CodexExecutableDiscoveryResult =
  | {
      readonly kind: "located";
      readonly executable: CodexExecutableHandle;
    }
  | { readonly kind: "not-located" }
  | { readonly kind: "ambiguous" };

export type DiscoveryEntryInspection =
  | { readonly kind: "missing" | "unavailable" }
  | {
      readonly kind: "file" | "directory" | "other";
      readonly symbolicLink: boolean;
      readonly reparsePoint: boolean;
    };

type PathLookupResult =
  | { readonly kind: "candidates"; readonly values: readonly string[] }
  | { readonly kind: "overflow" };

type DirectoryReadResult =
  | { readonly kind: "entries"; readonly names: readonly string[] }
  | { readonly kind: "missing" | "unavailable" | "overflow" };

export interface CodexExecutableDiscoveryDependencies {
  readonly platform: NodeJS.Platform;
  readonly officialRoots: readonly string[];
  lookupOnPath(): Promise<PathLookupResult>;
  inspect(path: string): Promise<DiscoveryEntryInspection>;
  resolveRealPath(path: string): Promise<string>;
  readDirectory(root: string): Promise<DirectoryReadResult>;
  holdExecutable(path: string): CodexExecutableHandle;
}

export async function discoverCodexExecutable(
  dependencies: CodexExecutableDiscoveryDependencies,
): Promise<CodexExecutableDiscoveryResult> {
  if (dependencies.platform !== "win32") {
    return located(dependencies.holdExecutable("codex"));
  }

  const pathApi = win32;
  const pathLookup = await dependencies.lookupOnPath().catch(
    (): PathLookupResult => ({ kind: "candidates", values: [] }),
  );
  if (pathLookup.kind === "overflow") return ambiguous();
  if (pathLookup.values.length > maximumPathCandidates) return ambiguous();

  const pathCandidates = new Map<string, string>();
  for (const candidate of pathLookup.values) {
    if (!pathApi.isAbsolute(candidate)) continue;
    const resolved = await validateCandidate(
      candidate,
      pathApi.dirname(candidate),
      dependencies,
    );
    if (resolved !== undefined) {
      pathCandidates.set(comparable(resolved), resolved);
    }
  }
  if (pathCandidates.size > 1) return ambiguous();
  const pathCandidate = pathCandidates.values().next().value as string | undefined;
  if (pathCandidate !== undefined) {
    return located(dependencies.holdExecutable(pathCandidate));
  }

  if (dependencies.officialRoots.length > maximumOfficialRoots) return ambiguous();
  const officialCandidates = new Map<string, string>();
  for (const root of dependencies.officialRoots) {
    if (!pathApi.isAbsolute(root)) continue;
    const rootInspection = await dependencies.inspect(root);
    if (!isDirectory(rootInspection)) continue;
    const resolvedRoot = await dependencies.resolveRealPath(root).catch(() => undefined);
    if (resolvedRoot === undefined || !pathApi.isAbsolute(resolvedRoot)) continue;

    const directory = await dependencies.readDirectory(root).catch(
      (): DirectoryReadResult => ({ kind: "unavailable" }),
    );
    if (directory.kind === "overflow") return ambiguous();
    if (directory.kind !== "entries") continue;
    if (directory.names.length > maximumRootEntries) return ambiguous();

    const leafNames = directory.names
      .filter((name) => contentHashLeafPattern.test(name))
      .sort(compareOrdinal);
    const candidates = [
      pathApi.join(root, "codex.exe"),
      ...leafNames.map((name) => pathApi.join(root, name, "codex.exe")),
    ];
    for (const candidate of candidates) {
      const resolved = await validateCandidateAgainstResolvedRoot(
        candidate,
        resolvedRoot,
        dependencies,
      );
      if (resolved !== undefined) {
        officialCandidates.set(comparable(resolved), resolved);
      }
    }
  }

  if (officialCandidates.size === 0) return notLocated();
  if (officialCandidates.size > 1) return ambiguous();
  return located(
    dependencies.holdExecutable(
      officialCandidates.values().next().value as string,
    ),
  );
}

export function createProductionCodexExecutableDiscovery(
  holdExecutable: (path: string) => CodexExecutableHandle,
): () => Promise<CodexExecutableDiscoveryResult> {
  const platform = process.platform;
  const officialRoots =
    platform === "win32"
      ? Object.freeze([
          win32.join(homedir(), "AppData", "Local", "OpenAI", "Codex", "bin"),
        ])
      : Object.freeze([]);
  const dependencies: CodexExecutableDiscoveryDependencies = Object.freeze({
    platform,
    officialRoots,
    lookupOnPath: lookupOnPathBounded,
    inspect: inspectEntry,
    resolveRealPath: (path: string) => realpath(path),
    readDirectory: readDirectoryBounded,
    holdExecutable,
  });
  return () => discoverCodexExecutable(dependencies);
}

async function validateCandidate(
  candidate: string,
  permittedRoot: string,
  dependencies: CodexExecutableDiscoveryDependencies,
): Promise<string | undefined> {
  const rootInspection = await dependencies.inspect(permittedRoot);
  if (!isDirectory(rootInspection)) return undefined;
  const resolvedRoot = await dependencies
    .resolveRealPath(permittedRoot)
    .catch(() => undefined);
  if (resolvedRoot === undefined || !win32.isAbsolute(resolvedRoot)) return undefined;
  return validateCandidateAgainstResolvedRoot(candidate, resolvedRoot, dependencies);
}

async function validateCandidateAgainstResolvedRoot(
  candidate: string,
  resolvedRoot: string,
  dependencies: CodexExecutableDiscoveryDependencies,
): Promise<string | undefined> {
  const inspection = await dependencies.inspect(candidate);
  if (!isRegularUnlinkedFile(inspection)) return undefined;
  const resolvedCandidate = await dependencies
    .resolveRealPath(candidate)
    .catch(() => undefined);
  if (resolvedCandidate === undefined || !win32.isAbsolute(resolvedCandidate)) {
    return undefined;
  }
  const relation = win32.relative(resolvedRoot, resolvedCandidate);
  if (
    relation.length === 0 ||
    win32.isAbsolute(relation) ||
    relation === ".." ||
    relation.startsWith(`..${win32.sep}`)
  ) {
    return undefined;
  }
  return resolvedCandidate;
}

function isDirectory(
  value: DiscoveryEntryInspection,
): value is Extract<DiscoveryEntryInspection, { readonly kind: "directory" }> {
  return (
    value.kind === "directory" &&
    !value.symbolicLink &&
    !value.reparsePoint
  );
}

function isRegularUnlinkedFile(
  value: DiscoveryEntryInspection,
): value is Extract<DiscoveryEntryInspection, { readonly kind: "file" }> {
  return value.kind === "file" && !value.symbolicLink && !value.reparsePoint;
}

function located(executable: CodexExecutableHandle): CodexExecutableDiscoveryResult {
  return Object.freeze({ kind: "located", executable });
}

function notLocated(): CodexExecutableDiscoveryResult {
  return Object.freeze({ kind: "not-located" });
}

function ambiguous(): CodexExecutableDiscoveryResult {
  return Object.freeze({ kind: "ambiguous" });
}

function comparable(path: string): string {
  return path.toLocaleLowerCase("en-US");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function lookupOnPathBounded(): Promise<PathLookupResult> {
  return new Promise<PathLookupResult>((resolve) => {
    execFile(
      "where.exe",
      ["codex.exe"],
      {
        encoding: "utf8",
        maxBuffer: maximumPathLookupBytes,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve({ kind: "candidates", values: [] });
          return;
        }
        const values = stdout
          .split(/\r?\n/u)
          .filter((candidate) => candidate.length > 0);
        resolve(
          values.length > maximumPathCandidates
            ? { kind: "overflow" }
            : { kind: "candidates", values: Object.freeze(values) },
        );
      },
    );
  });
}

async function inspectEntry(path: string): Promise<DiscoveryEntryInspection> {
  try {
    const information = await lstat(path);
    const symbolicLink = information.isSymbolicLink();
    return Object.freeze({
      kind: information.isFile()
        ? "file"
        : information.isDirectory()
          ? "directory"
          : "other",
      symbolicLink,
      reparsePoint: symbolicLink,
    });
  } catch (error) {
    const code = errorCode(error);
    return Object.freeze({
      kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable",
    });
  }
}

async function readDirectoryBounded(root: string): Promise<DirectoryReadResult> {
  try {
    const directory = await opendir(root);
    const names: string[] = [];
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > maximumRootEntries) return { kind: "overflow" };
    }
    return { kind: "entries", names: Object.freeze(names) };
  } catch (error) {
    const code = errorCode(error);
    return {
      kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable",
    };
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
