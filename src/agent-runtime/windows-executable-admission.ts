import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { win32 } from "node:path";

import { windowsRuntimeLookupNames } from "./runtime-lookup-surface.ts";

export { windowsRuntimeLookupNames };

// Admission of a Windows runtime executable, shared by both provider runtimes.
//
// WHAT THIS EXISTS FOR. `npm install -g @openai/codex` and `npm install -g
// @anthropic-ai/claude-code` are what each vendor's own README documents, and on
// Windows neither produces a `.exe`. npm writes `<prefix>\codex.cmd`, `codex.ps1`
// and an extensionless sh script; the code the user actually runs lives at
// `<prefix>\node_modules\@openai\codex\<the package's own bin entry>`. Asking
// `where.exe` for the literal `codex.exe` cannot see any of that -- given an
// explicit extension `where.exe` does not consult `PATHEXT` -- and Node cannot
// spawn a `.cmd` at all without a shell. So the product told a user whose
// `codex --version` works in their terminal that no runtime existed.
//
// WHY THERE IS NO `shell: true` HERE. Spawning through a shell would make
// cmd.exe re-parse the whole command line, so every argument the product already
// passes -- a project directory, a model id, a resume identity, and now a path a
// user typed into Settings -- would become shell syntax at every spawn site in
// the product. That is a new injection surface bought to solve a lookup problem.
// Instead a shim is resolved to the entry point it would have run, STRUCTURALLY
// (through the npm package layout, never by parsing the batch file), and the
// answer is described as:
//
//     { executable, prefixArguments }
//
// `executable` is ALWAYS a native `.exe` that came back from
// `admitNativeExecutable` -- either the vendor's own binary, or the `node.exe`
// that runs the vendor's `.js` entry point. `prefixArguments` is `[]` or the one
// entry script. Every spawn site stays
//
//     spawn(plan.executable, [...plan.prefixArguments, ...args], { shell: false })
//
// so argv remains an array handed to CreateProcess and the injection surface
// does not widen by one character.
//
// WHY A USER-SUPPLIED PATH IS SAFE TO ACCEPT. It is untrusted input that reaches
// a spawn, so it never becomes argv[0] on its own authority. If it names a
// `.exe` it must pass `admitNativeExecutable` like any other candidate. If it
// names a shim, the only thing taken from it is its DIRECTORY; the executable
// and the script both come from the package manifest found under that directory
// and must resolve inside it. A path that is relative, blank, over-long, carries
// a control character, is a symlink, or resolves to something that is no longer
// a `.exe` is rejected with a reason rather than repaired.

const maximumCandidateLength = 4_096;
const maximumManifestBytes = 1_048_576;
const maximumBinEntryLength = 1_024;
const maximumPathLookupBytes = 16_384;
const maximumPathLookupCandidates = 64;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * A launchable runtime, described so that argv stays an array.
 *
 * `executable` is a native `.exe`; `prefixArguments` are the arguments that must
 * precede the runtime's own arguments (the entry script, when the vendor ships a
 * JavaScript entry point rather than a binary).
 */
export interface WindowsRuntimeLaunch {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

/** The npm identity of a vendor CLI, used to resolve a shim structurally. */
export interface NpmGlobalCommandSpec {
  /** The command name the vendor documents, without an extension. */
  readonly command: string;
  /** The published package name, e.g. `@openai/codex`. */
  readonly packageName: string;
}

export type NativeExecutableRejection =
  | "blank"
  | "control-character"
  | "too-long"
  | "not-absolute"
  | "not-a-native-executable-name"
  | "missing"
  | "not-a-regular-file"
  | "symbolic-link"
  | "unresolvable"
  | "resolved-away-from-a-native-executable";

export type LaunchRejection =
  | NativeExecutableRejection
  | "unsupported-shape"
  | "package-manifest-unreadable"
  | "package-manifest-declares-no-entry"
  | "entry-escapes-its-package"
  | "entry-missing"
  | "unsupported-entry"
  | "node-interpreter-not-located";

export type NativeExecutableAdmission =
  | { readonly kind: "admitted"; readonly path: string }
  | { readonly kind: "rejected"; readonly reason: NativeExecutableRejection };

export type WindowsRuntimeLaunchAdmission =
  | { readonly kind: "admitted"; readonly launch: WindowsRuntimeLaunch }
  | { readonly kind: "rejected"; readonly reason: LaunchRejection };

export type AdmissionEntryInspection =
  | { readonly kind: "missing" | "unavailable" }
  | {
      readonly kind: "file" | "directory" | "other";
      readonly symbolicLink: boolean;
    };

export interface WindowsAdmissionDependencies {
  inspect(path: string): Promise<AdmissionEntryInspection>;
  resolveRealPath(path: string): Promise<string>;
  readTextFile(path: string, maximumBytes: number): Promise<string | undefined>;
  lookupOnPath(name: string): Promise<readonly string[]>;
}

export type LaunchTargetShape = "native" | "shim" | "unsupported";

/**
 * Classify a candidate by NAME only. A `native` candidate may become argv[0]
 * once it has passed `admitNativeExecutable`; a `shim` candidate never does --
 * only its directory is used.
 */
export function classifyLaunchTargetName(candidate: string): LaunchTargetShape {
  const leaf = win32.basename(candidate).toLocaleLowerCase("en-US");
  if (leaf.length === 0) return "unsupported";
  if (leaf.endsWith(".exe")) return "native";
  if (leaf.endsWith(".cmd") || leaf.endsWith(".bat") || leaf.endsWith(".ps1")) {
    return "shim";
  }
  return win32.extname(leaf).length === 0 ? "shim" : "unsupported";
}

/**
 * The single gate on anything that becomes argv[0].
 *
 * This is the `.exe`-only check the Claude transport has always applied, moved
 * here so both runtimes and the user-supplied path share one implementation, and
 * extended -- deliberately, per F26 -- to REPORT WHY it refused rather than only
 * that it did. The failure text and the Settings field both need the reason. Not
 * one admission condition is relaxed: a candidate must still be absolute, still
 * be named `.exe`, still be a regular file that is not a symbolic link, and must
 * still be named `.exe` AFTER `realpath`, so a junction cannot smuggle a `.cmd`
 * in behind an `.exe` name. The blank/control-character/length checks are new
 * REFUSALS, not new admissions: they exist because this function now also sees
 * strings a user typed.
 */
export async function admitNativeExecutable(
  candidate: string,
  dependencies: WindowsAdmissionDependencies,
): Promise<NativeExecutableAdmission> {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return rejected("blank");
  }
  if (controlCharacterPattern.test(candidate)) return rejected("control-character");
  if (candidate.length > maximumCandidateLength) return rejected("too-long");
  if (!win32.isAbsolute(candidate)) return rejected("not-absolute");
  if (!candidate.toLocaleLowerCase("en-US").endsWith(".exe")) {
    return rejected("not-a-native-executable-name");
  }

  const lexical = win32.resolve(candidate);
  const inspection = await dependencies
    .inspect(lexical)
    .catch((): AdmissionEntryInspection => ({ kind: "unavailable" }));
  if (inspection.kind === "missing") return rejected("missing");
  if (inspection.kind !== "file") return rejected("not-a-regular-file");
  if (inspection.symbolicLink) return rejected("symbolic-link");

  const resolved = await dependencies
    .resolveRealPath(lexical)
    .catch(() => undefined);
  if (resolved === undefined || !win32.isAbsolute(resolved)) {
    return rejected("unresolvable");
  }
  if (!resolved.toLocaleLowerCase("en-US").endsWith(".exe")) {
    return rejected("resolved-away-from-a-native-executable");
  }
  return Object.freeze({ kind: "admitted" as const, path: resolved });
}

/**
 * Resolve an npm global install in `binDirectory` to something spawnable.
 *
 * The shim itself is never parsed. npm's layout is the contract: the package
 * sits at `<binDirectory>\node_modules\<packageName>`, and its own
 * `package.json` says which file the command runs. That file must resolve inside
 * the package it was declared by, so a manifest cannot point discovery out of
 * the tree.
 */
export async function resolveNpmGlobalLaunch(
  binDirectory: string,
  spec: NpmGlobalCommandSpec,
  dependencies: WindowsAdmissionDependencies,
): Promise<WindowsRuntimeLaunchAdmission> {
  if (!win32.isAbsolute(binDirectory)) return rejected("not-absolute");

  const packageDirectory = win32.join(
    binDirectory,
    "node_modules",
    ...spec.packageName.split("/"),
  );
  const manifestText = await dependencies
    .readTextFile(win32.join(packageDirectory, "package.json"), maximumManifestBytes)
    .catch(() => undefined);
  if (manifestText === undefined) return rejected("package-manifest-unreadable");

  const entryRelative = binEntryFromManifest(manifestText, spec.command);
  if (entryRelative === undefined) {
    return rejected("package-manifest-declares-no-entry");
  }

  const resolvedPackage = await dependencies
    .resolveRealPath(packageDirectory)
    .catch(() => undefined);
  if (resolvedPackage === undefined || !win32.isAbsolute(resolvedPackage)) {
    return rejected("package-manifest-unreadable");
  }

  const entryPath = win32.resolve(resolvedPackage, entryRelative);
  if (!isContainedIn(entryPath, resolvedPackage)) {
    return rejected("entry-escapes-its-package");
  }

  const entryInspection = await dependencies
    .inspect(entryPath)
    .catch((): AdmissionEntryInspection => ({ kind: "unavailable" }));
  if (entryInspection.kind !== "file") return rejected("entry-missing");

  const resolvedEntry = await dependencies
    .resolveRealPath(entryPath)
    .catch(() => undefined);
  if (resolvedEntry === undefined || !isContainedIn(resolvedEntry, resolvedPackage)) {
    return rejected("entry-escapes-its-package");
  }

  const leaf = resolvedEntry.toLocaleLowerCase("en-US");
  if (leaf.endsWith(".exe")) {
    const admitted = await admitNativeExecutable(resolvedEntry, dependencies);
    return admitted.kind === "admitted"
      ? launch(admitted.path, [])
      : rejected(admitted.reason);
  }
  if (leaf.endsWith(".js") || leaf.endsWith(".cjs") || leaf.endsWith(".mjs")) {
    const interpreter = await resolveNodeInterpreter(binDirectory, dependencies);
    return interpreter === undefined
      ? rejected("node-interpreter-not-located")
      : launch(interpreter, [resolvedEntry]);
  }
  return rejected("unsupported-entry");
}

/**
 * Find the node that would have run this shim.
 *
 * npm's own generated `.cmd` prefers `node.exe` beside the shim and otherwise
 * falls back to the first `node` on PATH; doing the same thing means the entry
 * point runs under the interpreter it was installed for. `process.execPath` is
 * deliberately NOT a fallback: under Electron that binary is the product itself
 * and only behaves as node with an environment flag, which would put a
 * product-owned variable into the vendor CLI's environment to paper over a
 * lookup failure that the failure text can simply name instead.
 */
async function resolveNodeInterpreter(
  binDirectory: string,
  dependencies: WindowsAdmissionDependencies,
): Promise<string | undefined> {
  const beside = await admitNativeExecutable(
    win32.join(binDirectory, "node.exe"),
    dependencies,
  );
  if (beside.kind === "admitted") return beside.path;

  const onPath = await dependencies.lookupOnPath("node.exe").catch(() => []);
  for (const candidate of onPath) {
    const admitted = await admitNativeExecutable(candidate, dependencies);
    if (admitted.kind === "admitted") return admitted.path;
  }
  return undefined;
}

/**
 * Admit a candidate that came from a PATH lookup or from the executable path a
 * user supplied, and turn it into something spawnable.
 */
export async function admitLaunchTarget(
  candidate: string,
  spec: NpmGlobalCommandSpec,
  dependencies: WindowsAdmissionDependencies,
): Promise<WindowsRuntimeLaunchAdmission> {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return rejected("blank");
  }
  if (controlCharacterPattern.test(candidate)) return rejected("control-character");
  if (candidate.length > maximumCandidateLength) return rejected("too-long");
  if (!win32.isAbsolute(candidate)) return rejected("not-absolute");

  const shape = classifyLaunchTargetName(candidate);
  if (shape === "unsupported") return rejected("unsupported-shape");
  if (shape === "native") {
    const admitted = await admitNativeExecutable(candidate, dependencies);
    return admitted.kind === "admitted"
      ? launch(admitted.path, [])
      : rejected(admitted.reason);
  }

  // A shim contributes its DIRECTORY and nothing else. It is still required to
  // exist as a regular file, so a directory a user typed cannot stand in for an
  // install that is not there.
  const lexical = win32.resolve(candidate);
  const inspection = await dependencies
    .inspect(lexical)
    .catch((): AdmissionEntryInspection => ({ kind: "unavailable" }));
  if (inspection.kind === "missing") return rejected("missing");
  if (inspection.kind !== "file") return rejected("not-a-regular-file");

  return resolveNpmGlobalLaunch(win32.dirname(lexical), spec, dependencies);
}

/** `bin` may be a bare string (single-command package) or a map. */
function binEntryFromManifest(
  manifestText: string,
  command: string,
): string | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const bin = (manifest as { readonly bin?: unknown }).bin;
  const entry =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as Record<string, unknown>)[command]
        : undefined;
  if (typeof entry !== "string") return undefined;
  if (entry.length === 0 || entry.length > maximumBinEntryLength) return undefined;
  if (controlCharacterPattern.test(entry)) return undefined;
  // A manifest that names an absolute path is not describing its own contents.
  if (win32.isAbsolute(entry) || entry.startsWith("/") || entry.startsWith("\\")) {
    return undefined;
  }
  return entry;
}

function isContainedIn(candidate: string, root: string): boolean {
  const normalizedRoot = root.toLocaleLowerCase("en-US").replace(/[\\/]+$/u, "");
  if (normalizedRoot.length === 0) return false;
  return candidate
    .toLocaleLowerCase("en-US")
    .startsWith(`${normalizedRoot}\\`);
}

function launch(
  executable: string,
  prefixArguments: readonly string[],
): WindowsRuntimeLaunchAdmission {
  return Object.freeze({
    kind: "admitted" as const,
    launch: Object.freeze({
      executable,
      prefixArguments: Object.freeze([...prefixArguments]),
    }),
  });
}

function rejected<Reason extends LaunchRejection>(
  reason: Reason,
): { readonly kind: "rejected"; readonly reason: Reason } {
  return Object.freeze({ kind: "rejected" as const, reason });
}

export const productionWindowsAdmissionDependencies: WindowsAdmissionDependencies =
  Object.freeze({
    async inspect(path: string): Promise<AdmissionEntryInspection> {
      try {
        const information = await lstat(path);
        return Object.freeze({
          kind: information.isFile()
            ? ("file" as const)
            : information.isDirectory()
              ? ("directory" as const)
              : ("other" as const),
          symbolicLink: information.isSymbolicLink(),
        });
      } catch (error) {
        const code = errorCode(error);
        return Object.freeze({
          kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable",
        });
      }
    },
    resolveRealPath: (path: string) => realpath(path),
    async readTextFile(path: string, maximumBytes: number) {
      try {
        const contents = await readFile(path);
        return contents.byteLength > maximumBytes
          ? undefined
          : contents.toString("utf8");
      } catch {
        return undefined;
      }
    },
    lookupOnPath: lookupOnPathBounded,
  });

/**
 * A BARE name, so `where.exe` consults `PATHEXT` and reports the shims an npm
 * global install actually writes. Asking for an explicit extension is what made
 * every one of them invisible.
 */
export function lookupOnPathBounded(name: string): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolve) => {
    execFile(
      "where.exe",
      [name],
      { encoding: "utf8", maxBuffer: maximumPathLookupBytes, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(Object.freeze([]));
          return;
        }
        const values = stdout
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        resolve(
          values.length > maximumPathLookupCandidates
            ? Object.freeze([])
            : Object.freeze(values),
        );
      },
    );
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
