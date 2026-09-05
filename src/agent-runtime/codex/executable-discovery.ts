import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";

import { configuredRuntimeExecutable } from "../configured-executable.ts";
import { CODEX_RUNTIME_LOOKUP_SURFACE } from "../runtime-lookup-surface.ts";
import {
  admitLaunchTarget,
  productionWindowsAdmissionDependencies,
  resolveNpmGlobalLaunch,
  type WindowsAdmissionDependencies,
  type WindowsRuntimeLaunch,
} from "../windows-executable-admission.ts";

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
  /** The one gate every candidate that becomes argv[0] passes through. */
  readonly admission: WindowsAdmissionDependencies;
  /** The executable path a user supplied, if they supplied one. */
  configuredExecutable(): string | undefined;
  /** Where an `npm install -g` puts its shims on this machine. */
  npmGlobalPrefix(): string | undefined;
  lookupOnPath(): Promise<PathLookupResult>;
  inspect(path: string): Promise<DiscoveryEntryInspection>;
  resolveRealPath(path: string): Promise<string>;
  readDirectory(root: string): Promise<DirectoryReadResult>;
  holdExecutable(launch: WindowsRuntimeLaunch): CodexExecutableHandle;
}

/**
 * Where Codex is, described so that a JavaScript entry point can start.
 *
 * The order is deliberate, and it mirrors the Claude side exactly so that a
 * user's machine cannot be servable by one runtime and not the other:
 *
 *   1. The path the user supplied, because it is the answer to a lookup that
 *      has already failed them once and nothing the product guesses should
 *      outrank it. A stored path that no longer admits falls THROUGH to
 *      ordinary discovery rather than stranding the user on their own stale
 *      answer.
 *   2. PATH, asked with the BARE command name so `where.exe` consults PATHEXT
 *      and can finally see the `.cmd` and extensionless script that an
 *      `npm install -g @openai/codex` actually writes. Asking for an explicit
 *      `codex.exe` consults nothing, and that was the whole defect.
 *   3. `%APPDATA%\npm` directly, because an Electron app launched from Explorer
 *      inherits the PATH from login -- which is how a user whose
 *      `codex --version` works in their terminal was still told nothing was
 *      installed.
 *   4. The official installer root, unchanged.
 *
 * PATH candidates are deduplicated BY RESOLVED LAUNCH PLAN, not by candidate
 * string. One npm install puts `codex`, `codex.cmd` and `codex.ps1` in the same
 * directory and a bare lookup returns two of them; string-deduplication would
 * make this function's own "more than one candidate means ambiguous" rule fire
 * on every single npm install. Two installs in two directories still resolve to
 * two different plans, so that rule keeps the case it was written for.
 */
export async function discoverCodexExecutable(
  dependencies: CodexExecutableDiscoveryDependencies,
): Promise<CodexExecutableDiscoveryResult> {
  if (dependencies.platform !== "win32") {
    return located(
      dependencies.holdExecutable(
        nativeLaunch(CODEX_RUNTIME_LOOKUP_SURFACE.command),
      ),
    );
  }

  const pathApi = win32;
  const surface = CODEX_RUNTIME_LOOKUP_SURFACE;
  const admission = dependencies.admission;

  const configured = dependencies.configuredExecutable();
  if (configured !== undefined) {
    const admitted = await admitLaunchTarget(configured, surface, admission).catch(
      () => undefined,
    );
    if (admitted !== undefined && admitted.kind === "admitted") {
      return located(dependencies.holdExecutable(admitted.launch));
    }
  }

  const pathLookup = await dependencies.lookupOnPath().catch(
    (): PathLookupResult => ({ kind: "candidates", values: [] }),
  );
  if (pathLookup.kind === "overflow") return ambiguous();
  if (pathLookup.values.length > maximumPathCandidates) return ambiguous();

  const pathLaunches = new Map<string, WindowsRuntimeLaunch>();
  for (const candidate of pathLookup.values) {
    const admitted = await admitLaunchTarget(candidate, surface, admission).catch(
      () => undefined,
    );
    if (admitted !== undefined && admitted.kind === "admitted") {
      pathLaunches.set(launchKey(admitted.launch), admitted.launch);
    }
  }
  if (pathLaunches.size > 1) return ambiguous();
  const pathLaunch = pathLaunches.values().next().value as
    | WindowsRuntimeLaunch
    | undefined;
  if (pathLaunch !== undefined) {
    return located(dependencies.holdExecutable(pathLaunch));
  }

  const npmPrefix = dependencies.npmGlobalPrefix();
  if (npmPrefix !== undefined) {
    const admitted = await resolveNpmGlobalLaunch(
      npmPrefix,
      surface,
      admission,
    ).catch(() => undefined);
    if (admitted !== undefined && admitted.kind === "admitted") {
      return located(dependencies.holdExecutable(admitted.launch));
    }
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
      nativeLaunch(officialCandidates.values().next().value as string),
    ),
  );
}

/**
 * The production dependency set, rebuilt on every discovery.
 *
 * Nothing here is captured once at module load. `%APPDATA%`, `PATH` and the
 * home directory are read at the moment a lookup runs, because a user who fixes
 * their installation while the Workbench is open should not have to restart it
 * -- and because a lookup that reads a snapshot of the environment cannot be
 * put under test against a fixture at all.
 */
export function productionCodexExecutableDiscoveryDependencies(
  holdExecutable: (launch: WindowsRuntimeLaunch) => CodexExecutableHandle,
): CodexExecutableDiscoveryDependencies {
  const platform = process.platform;
  return Object.freeze({
    platform,
    officialRoots:
      platform === "win32"
        ? Object.freeze([
            win32.join(homedir(), "AppData", "Local", "OpenAI", "Codex", "bin"),
          ])
        : Object.freeze([]),
    admission: productionWindowsAdmissionDependencies,
    configuredExecutable: () => configuredRuntimeExecutable("codex"),
    npmGlobalPrefix: codexNpmGlobalPrefix,
    lookupOnPath: lookupOnPathBounded,
    inspect: inspectEntry,
    resolveRealPath: (path: string) => realpath(path),
    readDirectory: readDirectoryBounded,
    holdExecutable,
  });
}

export function createProductionCodexExecutableDiscovery(
  holdExecutable: (launch: WindowsRuntimeLaunch) => CodexExecutableHandle,
): () => Promise<CodexExecutableDiscoveryResult> {
  return () =>
    discoverCodexExecutable(
      productionCodexExecutableDiscoveryDependencies(holdExecutable),
    );
}

/**
 * `%APPDATA%\npm` is where npm puts a global install's shims on Windows. An
 * absent or relative APPDATA means the roaming profile is derived from the home
 * directory rather than trusted.
 */
function codexNpmGlobalPrefix(): string | undefined {
  const roaming = process.env.APPDATA;
  const base =
    typeof roaming === "string" && roaming.length > 0 && win32.isAbsolute(roaming)
      ? roaming
      : win32.join(homedir(), "AppData", "Roaming");
  return win32.join(base, "npm");
}

function nativeLaunch(executable: string): WindowsRuntimeLaunch {
  return Object.freeze({
    executable,
    prefixArguments: Object.freeze([]),
  });
}

/**
 * Identity of a launch, not of the string that produced it. `codex` and
 * `codex.cmd` beside each other resolve to the same node plus the same entry
 * script, so they collapse to one entry here and the ambiguity rule does not
 * fire on a perfectly ordinary install.
 */
function launchKey(launch: WindowsRuntimeLaunch): string {
  return [launch.executable, ...launch.prefixArguments]
    .join(" ")
    .toLocaleLowerCase("en-US");
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

/**
 * The BARE command name. Given an explicit extension `where.exe` does not
 * consult `PATHEXT`, so `where.exe codex.exe` could never see the `codex.cmd`
 * and extensionless script that `npm install -g @openai/codex` writes --
 * verified on a Windows 11 box, where `where.exe npm.exe` exits 1 while
 * `where.exe npm` returns both `npm` and `npm.cmd`.
 */
async function lookupOnPathBounded(): Promise<PathLookupResult> {
  return new Promise<PathLookupResult>((resolve) => {
    execFile(
      "where.exe",
      [CODEX_RUNTIME_LOOKUP_SURFACE.command],
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
          .map((candidate) => candidate.trim())
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
