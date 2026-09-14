// The packaged product's own Node LTS provisioning -- the counterpart of the
// private-node block in start.bat (which stays the source-path launcher and is
// deliberately not touched here).
//
// A machine that only unzipped the release has neither node on PATH nor the
// start.bat the source checkout ships, so the one-click CLI install used to
// stop dead at `node-not-located` and point at a file the zip does not
// contain. Instead, the product now prepares the SAME private runtime
// start.bat would, under the SAME rules:
//
//   - the same version constant (a test pins the two files together, so one
//     cache directory is never asked to hold two different Nodes),
//   - downloaded from nodejs.org over HTTPS,
//   - verified against the official SHASUMS256.txt BEFORE it is extracted --
//     a mismatch is rejected and never executed,
//   - extracted into a stage directory inside the cache, validated by RUNNING
//     the node.exe (version read back from the pipe, 22.5 floor like start.bat
//     because node:sqlite needs it), and only then moved into place,
//   - cached at %LOCALAPPDATA%\synchronized-intellect-network\runtime\node\bin,
//     which is exactly where start.bat looks first, so whichever path filled
//     the cache, the other one reuses it.
//
// Nothing global is touched: no PATH edit, no installer, no registry key.
// The failure detail names the problem, the official URLs and what was kept,
// so the Settings page can tell the truth about an offline or corrupted
// download instead of sending the user after a start.bat that is not there.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Must stay equal to start.bat's NODE_LTS_VERSION; a test pins the pair. */
export const NODE_LTS_VERSION = "24.20.0";
/** node:sqlite first shipped in 22.5; start.bat pins the same floor. */
const NODE_MINIMUM_MAJOR = 22;
const NODE_MINIMUM_MINOR = 5;

const nodePackageName = `node-v${NODE_LTS_VERSION}-win-x64`;
export const NODE_ARCHIVE_NAME = `${nodePackageName}.zip`;
export const NODE_DOWNLOAD_ROOT = `https://nodejs.org/dist/v${NODE_LTS_VERSION}`;
export const NODE_ARCHIVE_URL = `${NODE_DOWNLOAD_ROOT}/${NODE_ARCHIVE_NAME}`;
export const NODE_SHASUMS_URL = `${NODE_DOWNLOAD_ROOT}/SHASUMS256.txt`;

const productRuntimeRoot = join("synchronized-intellect-network", "runtime");
const maximumShasumsBytes = 1_048_576;
const maximumVersionCharacters = 64;
const maximumDetailBytes = 2_048;

/** Which step a provisioning stopped at; the Settings failure names it. */
export type PrivateNodeProvisionFailureReason =
  | "cache-directory-unavailable"
  | "archive-download-failed"
  | "shasums-download-failed"
  | "shasums-entry-missing"
  | "checksum-mismatch"
  | "extract-failed"
  | "extracted-node-invalid"
  | "cache-busy"
  | "publish-failed"
  | "published-node-invalid";

export type PrivateNodeProvisionOutcome =
  | {
      readonly kind: "ready";
      readonly executable: string;
      readonly directory: string;
      readonly source: "cached" | "downloaded";
      readonly version: string;
    }
  | {
      readonly kind: "failed";
      readonly reason: PrivateNodeProvisionFailureReason;
      readonly detail: string;
    };

export interface PrivateNodeProvisioningDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  /** `%LOCALAPPDATA%\synchronized-intellect-network\runtime\node` unless a test says otherwise. */
  readonly cacheRoot?: string;
  /** `https://nodejs.org/dist/v<LTS>` unless a test points at a local endpoint. */
  readonly downloadRoot?: string;
  readonly download?: (url: string, destination: string) => Promise<void>;
  readonly extractZip?: (archive: string, destination: string) => Promise<void>;
  readonly readNodeVersion?: (executable: string) => Promise<string | undefined>;
}

/**
 * Return the private Node start.bat and the packaged product share, preparing
 * it first when the cache does not already hold a working one.
 */
export async function ensurePrivateNode(
  dependencies: PrivateNodeProvisioningDependencies = {},
): Promise<PrivateNodeProvisionOutcome> {
  const environment = dependencies.environment ?? process.env;
  const cacheRoot = dependencies.cacheRoot ?? defaultPrivateNodeCacheRoot(environment);
  const downloadRoot = dependencies.downloadRoot ?? NODE_DOWNLOAD_ROOT;
  const download = dependencies.download ?? downloadToFile;
  const extractZip = dependencies.extractZip ?? extractZipWithPowerShell;
  const readNodeVersion = dependencies.readNodeVersion ?? readNodeVersionBySpawn;
  const fail = (
    reason: PrivateNodeProvisionFailureReason,
    problem: string,
  ): PrivateNodeProvisionOutcome =>
    Object.freeze({ kind: "failed", reason, detail: failureDetail(problem) });

  const binDirectory = join(cacheRoot, "bin");
  const nodeExecutable = join(binDirectory, "node.exe");

  const cachedVersion = await readNodeVersion(nodeExecutable);
  if (cachedVersion !== undefined && nodeVersionAtLeast(cachedVersion)) {
    return ready(nodeExecutable, binDirectory, "cached", cachedVersion);
  }

  let stage: string | undefined;
  try {
    await mkdir(cacheRoot, { recursive: true });
    stage = await mkdtemp(join(cacheRoot, "stage-"));
    const archive = join(stage, NODE_ARCHIVE_NAME);
    const shasums = join(stage, "SHASUMS256.txt");
    const archiveUrl = `${downloadRoot}/${NODE_ARCHIVE_NAME}`;
    const shasumsUrl = `${downloadRoot}/SHASUMS256.txt`;

    try {
      await download(archiveUrl, archive);
    } catch (error) {
      return fail(
        "archive-download-failed",
        `The Node LTS archive could not be downloaded from ${archiveUrl}: ${errorText(error)} Check the network and try again.`,
      );
    }
    try {
      await download(shasumsUrl, shasums);
    } catch (error) {
      return fail(
        "shasums-download-failed",
        `The official SHASUMS256.txt could not be downloaded from ${shasumsUrl}, so the archive was not trusted: ${errorText(error)}`,
      );
    }

    const expected = await shasumsEntryFor(shasums, NODE_ARCHIVE_NAME);
    if (expected === undefined) {
      return fail(
        "shasums-entry-missing",
        `The official SHASUMS256.txt has no entry for ${NODE_ARCHIVE_NAME}.`,
      );
    }
    const actual = await sha256OfFile(archive);
    if (actual !== expected) {
      return fail(
        "checksum-mismatch",
        "The downloaded Node zip SHA-256 checksum did not match the official SHASUMS256.txt; it was not extracted.",
      );
    }

    try {
      await extractZip(archive, stage);
    } catch (error) {
      return fail(
        "extract-failed",
        `The verified Node zip could not be extracted into the private cache: ${errorText(error)}`,
      );
    }

    const extractedExecutable = join(stage, nodePackageName, "node.exe");
    const extractedVersion = await readNodeVersion(extractedExecutable);
    if (extractedVersion === undefined || !nodeVersionAtLeast(extractedVersion)) {
      return fail(
        "extracted-node-invalid",
        `The verified archive did not contain a working node.exe version ${NODE_MINIMUM_MAJOR}.${NODE_MINIMUM_MINOR} or newer.`,
      );
    }

    await rm(binDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (await exists(binDirectory)) {
      return fail(
        "cache-busy",
        "The old private Node cache could not be replaced; another process may be using it.",
      );
    }
    try {
      await rename(join(stage, nodePackageName), binDirectory);
    } catch {
      // Another provisioning may have published the same verified runtime into
      // the cache between the removal and this move (start.bat's won-race).
      const raced = await readNodeVersion(nodeExecutable);
      if (raced !== undefined && nodeVersionAtLeast(raced)) {
        return ready(nodeExecutable, binDirectory, "cached", raced);
      }
      return fail(
        "publish-failed",
        "The verified Node runtime could not be moved into the private cache.",
      );
    }
    const publishedVersion = await readNodeVersion(nodeExecutable);
    if (publishedVersion === undefined || !nodeVersionAtLeast(publishedVersion)) {
      await rm(binDirectory, { recursive: true, force: true }).catch(() => undefined);
      return fail(
        "published-node-invalid",
        "The private node.exe did not run after it was moved into the cache.",
      );
    }
    return ready(nodeExecutable, binDirectory, "downloaded", publishedVersion);
  } catch (error) {
    return fail(
      "cache-directory-unavailable",
      `The private Node cache could not be prepared: ${errorText(error)}`,
    );
  } finally {
    if (stage !== undefined) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Where start.bat's NODE_CACHE_ROOT and this module keep the shared runtime. */
export function defaultPrivateNodeCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(localAppData(environment), productRuntimeRoot, "node");
}

function ready(
  executable: string,
  directory: string,
  source: "cached" | "downloaded",
  version: string,
): PrivateNodeProvisionOutcome {
  return Object.freeze({ kind: "ready", executable, directory, source, version });
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/** The same extraction start.bat performs, through the same PowerShell API. */
function extractZipWithPowerShell(archive: string, destination: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? String.raw`C:\Windows`;
  const powershell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
          "[IO.Compression.ZipFile]::ExtractToDirectory($env:UAW_NODE_ARCHIVE, $env:UAW_NODE_DESTINATION)",
      ],
      {
        // Paths travel as environment variables, never as command-line text.
        env: { ...process.env, UAW_NODE_ARCHIVE: archive, UAW_NODE_DESTINATION: destination },
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        shell: false,
      },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`powershell exited with ${String(code)}`)),
    );
  });
}

/** Runs the binary and reads `process.versions.node` straight out of the pipe. */
function readNodeVersionBySpawn(executable: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // A file that is not a real executable makes spawn() throw SYNCHRONOUSLY
    // on Windows (`spawn UNKNOWN`), before any event can carry it.
    let child;
    try {
      child = spawn(executable, ["-p", "process.versions.node"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(0, maximumVersionCharacters);
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      const version = stdout.split(/\r?\n/u)[0]?.trim() ?? "";
      resolve(code === 0 && /^\d+\.\d+\.\d+/u.test(version) ? version : undefined);
    });
  });
}

/** The entry SHASUMS256.txt declares for this archive, lowercased; start.bat's rule. */
async function shasumsEntryFor(
  shasums: string,
  archiveName: string,
): Promise<string | undefined> {
  let text: string;
  try {
    const contents = await readFile(shasums);
    if (contents.byteLength > maximumShasumsBytes) return undefined;
    text = contents.toString("utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$/u.exec(line);
    if (match !== null && match[2] === archiveName) {
      return match[1]!.toLowerCase();
    }
  }
  return undefined;
}

async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function nodeVersionAtLeast(version: string): boolean {
  const match = /^(\d+)\.(\d+)\./u.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > NODE_MINIMUM_MAJOR ||
    (major === NODE_MINIMUM_MAJOR && minor >= NODE_MINIMUM_MINOR)
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function failureDetail(problem: string): string {
  return [
    `Problem: ${problem}`,
    `Get it: ${NODE_ARCHIVE_URL}`,
    `Verify at: ${NODE_SHASUMS_URL}`,
    "Kept files: only inside the private runtime cache; nothing was installed globally.",
  ]
    .join("\n")
    .slice(0, maximumDetailBytes);
}

function localAppData(environment: NodeJS.ProcessEnv): string {
  const value = environment.LOCALAPPDATA;
  return typeof value === "string" && value.length > 0 && isAbsolute(value)
    ? value
    : join(homedir(), "AppData", "Local");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
