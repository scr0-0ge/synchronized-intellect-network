// Installing a vendor CLI into the product's own private directory.
//
// A machine with nothing but Windows on it gets node from `start.bat` in a
// source checkout, or -- packaged, where the zip carries no start.bat -- from
// the product itself: `ensurePrivateNode` downloads the verified Node LTS zip
// into `%LOCALAPPDATA%\synchronized-intellect-network\runtime\node`, the one
// cache both paths share. So by the time an install runs there is always a
// node -- and beside it, npm. That is enough to install the two CLIs the same
// way each vendor's README documents (`npm install -g <package>`), except into
// a directory the product owns:
//
//     %LOCALAPPDATA%\synchronized-intellect-network\runtime\cli\<runtime>\
//         <command>.cmd                  npm's shim (never spawned; its
//                                        directory is what discovery uses)
//         node.exe                       the interpreter the shim prefers
//         node_modules\<package>\...     the vendor's package and binary
//
// Nothing global is touched: no PATH edit, no `%APPDATA%\npm`, no registry
// key. The install is then pointed at through the Settings escape hatch
// (`setConfiguredRuntimeExecutable`) so it enters discovery by the one gate
// every candidate passes (`admitLaunchTarget`), and "installed" is only
// reported once the product's OWN discovery has located that copy -- a zero
// exit code from npm is not the criterion, the discovery result is.
//
// Integrity: npm verifies every tarball it downloads against the sha512
// `integrity` the registry manifest declares; the product does not add a
// second checksum on top of that. The registry is npm's default and follows
// `NPM_CONFIG_REGISTRY` untouched, so a user behind a mirror sets one
// variable and nothing here needs to know. The Node zip underneath it all is
// verified against nodejs.org's own SHASUMS256.txt before it is extracted --
// that check lives in `node-provisioning.ts` and is shared with start.bat's
// cache.

import { spawn } from "node:child_process";
import { copyFile, link, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { discoverClaudeLaunch } from "./claude/process-transport.ts";
import {
  discoverCodexExecutable,
  productionCodexExecutableDiscoveryDependencies,
  type CodexExecutableHandle,
} from "./codex/executable-discovery.ts";
import {
  setConfiguredRuntimeExecutable,
  type ConfigurableRuntime,
} from "./configured-executable.ts";
import {
  ensurePrivateNode,
  NODE_MINIMUM_MAJOR,
  NODE_MINIMUM_MINOR,
  nodeVersionAtLeast,
  type PrivateNodeProvisionOutcome,
} from "./node-provisioning.ts";
import { RUNTIME_LOOKUP_SURFACES } from "./runtime-lookup-surface.ts";
import {
  admitLaunchTarget,
  admitNativeExecutable,
  lookupOnPathBounded,
  productionWindowsAdmissionDependencies,
  type WindowsRuntimeLaunch,
} from "./windows-executable-admission.ts";

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

const productRuntimeRoot = "synchronized-intellect-network\\runtime";
const maximumOutputTailBytes = 4_096;
const maximumManifestBytes = 1_048_576;

/** Which step an install stopped at; the Settings page names it. */
export type CliProvisioningFailureStep =
  | "node-not-located"
  | "npm-not-located"
  | "install-failed"
  | "not-discovered";

export type CliProvisioningOutcome =
  | {
      readonly kind: "installed";
      readonly runtime: ConfigurableRuntime;
      readonly version: string;
      readonly directory: string;
      /** The shim path handed to the Settings escape hatch. */
      readonly configuredPath: string;
      /** What the product's own discovery resolved that path to. */
      readonly launch: WindowsRuntimeLaunch;
      readonly registry: string;
    }
  | {
      readonly kind: "failed";
      readonly runtime: ConfigurableRuntime;
      readonly step: CliProvisioningFailureStep;
      /** Bounded, human-readable; the tail of npm's stderr for install-failed. */
      readonly detail: string;
      readonly directory: string;
      readonly registry: string;
    };

export interface CliInstallRun {
  readonly exitCode: number | null;
  readonly outputTail: string;
}

export interface CliProvisioningDependencies {
  /** `%LOCALAPPDATA%\synchronized-intellect-network\runtime\cli` unless a test says otherwise. */
  readonly installRoot?: string;
  /** Where `start.bat` keeps its private node; `node.exe` on PATH is the fallback. */
  readonly privateNodeDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Download root for the private Node provisioning; production is nodejs.org. */
  readonly nodeDownloadRoot?: string;
  /** Prepares the private Node when none is located; production downloads the verified LTS. */
  readonly provisionNode?: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<PrivateNodeProvisionOutcome>;
  /** Runs `node npm-cli.js install ...`; the production one spawns it. */
  readonly runInstall?: (
    node: string,
    arguments_: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv },
  ) => Promise<CliInstallRun>;
  /** Records the configured path; production is the escape-hatch registry. */
  readonly publish?: (runtime: ConfigurableRuntime, value: string) => void;
  /** The product's own discovery for the runtime. */
  readonly discover?: (
    runtime: ConfigurableRuntime,
  ) => Promise<WindowsRuntimeLaunch | undefined>;
}

export function cliInstallDirectory(
  runtime: ConfigurableRuntime,
  installRoot: string = defaultInstallRoot(process.env),
): string {
  return join(installRoot, runtime);
}

export function npmRegistryFor(environment: NodeJS.ProcessEnv): string {
  const configured = environment.NPM_CONFIG_REGISTRY ?? environment.npm_config_registry;
  return typeof configured === "string" && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_NPM_REGISTRY;
}

/**
 * Install `<package>@latest` for `runtime` into the private directory, point
 * the escape hatch at it, and confirm through the product's own discovery.
 */
export async function provisionRuntimeCli(
  runtime: ConfigurableRuntime,
  dependencies: CliProvisioningDependencies = {},
): Promise<CliProvisioningOutcome> {
  const environment = dependencies.environment ?? process.env;
  const registry = npmRegistryFor(environment);
  const directory = cliInstallDirectory(
    runtime,
    dependencies.installRoot ?? defaultInstallRoot(environment),
  );
  const surface = RUNTIME_LOOKUP_SURFACES[runtime];
  const failed = (
    step: CliProvisioningFailureStep,
    detail: string,
  ): CliProvisioningOutcome =>
    Object.freeze({ kind: "failed", runtime, step, detail, directory, registry });

  const privateNodeDirectory =
    dependencies.privateNodeDirectory ?? defaultPrivateNodeDirectory(environment);
  let scan = await locateNode(privateNodeDirectory, environment);
  let node = scan.node;
  if (node === undefined) {
    // Nothing ADMITTED: either no candidate exists, or every one of them read
    // back a version below the floor (recorded in `scan.stale`). Either way,
    // prepare the private Node runtime start.bat would have provided, in the
    // cache both paths share, then locate it through the same admission gate
    // as before. A failure carries its own reason, prefixed with which PATH
    // candidate was too old when that is why nothing was already usable.
    const provisionNode =
      dependencies.provisionNode ??
      ((nodeEnvironment: NodeJS.ProcessEnv) =>
        ensurePrivateNode({
          environment: nodeEnvironment,
          cacheRoot: dirname(privateNodeDirectory),
          ...(dependencies.nodeDownloadRoot === undefined
            ? {}
            : { downloadRoot: dependencies.nodeDownloadRoot }),
        }));
    const provisioned = await provisionNode(environment);
    if (provisioned.kind === "failed") {
      return failed("node-not-located", withStaleNodeContext(scan.stale, provisioned.detail));
    }
    scan = await locateNode(privateNodeDirectory, environment);
    node = scan.node;
    if (node === undefined) {
      return failed(
        "node-not-located",
        "A private Node was prepared but could not be admitted afterwards.",
      );
    }
  }
  const npmCli = join(node.directory, "node_modules", "npm", "bin", "npm-cli.js");
  if ((await readTextFile(npmCli)) === undefined) {
    return failed("npm-not-located", `No npm-cli.js beside ${node.executable}.`);
  }

  const run = dependencies.runInstall ?? runNpmInstall;
  let installation: CliInstallRun;
  try {
    installation = await run(
      node.executable,
      [
        npmCli,
        "install",
        "-g",
        "--prefix",
        directory,
        `${surface.packageName}@latest`,
        "--no-fund",
        "--no-audit",
        "--no-update-notifier",
        "--loglevel=error",
      ],
      {
        // npm runs the package's postinstall through cmd.exe as a bare
        // `node`, so the interpreter that is running npm must be on the
        // child's PATH -- the same thing start.bat does for the product.
        env: {
          ...environment,
          PATH: [node.directory, environment.PATH ?? ""].join(";"),
        },
      },
    );
  } catch (error) {
    return failed("install-failed", errorText(error));
  }
  if (installation.exitCode !== 0) {
    return failed(
      "install-failed",
      `npm exited with ${installation.exitCode ?? "a signal"}.\n${installation.outputTail}`.trim(),
    );
  }

  const version = await installedVersion(directory, surface.packageName);
  if (version === undefined) {
    return failed(
      "install-failed",
      `npm exited 0 but ${surface.packageName} has no readable package.json under ${directory}.`,
    );
  }

  // npm's own shim prefers a node.exe beside itself; so does the admission
  // that resolves the shim. Placing the interpreter that ran the install
  // there means a JavaScript entry point (Codex) runs under the node it was
  // installed for whatever PATH the product was started with.
  try {
    await placeNodeBeside(node.executable, join(directory, "node.exe"));
  } catch (error) {
    return failed("install-failed", `Could not place node.exe beside the install: ${errorText(error)}`);
  }

  const configuredPath = join(directory, `${surface.command}.cmd`);
  const expected = await admitLaunchTarget(
    configuredPath,
    surface,
    productionWindowsAdmissionDependencies,
  );
  if (expected.kind === "rejected") {
    return failed("not-discovered", `The installed shim was not admitted: ${expected.reason}.`);
  }
  (dependencies.publish ?? setConfiguredRuntimeExecutable)(runtime, configuredPath);

  const discovered = await (dependencies.discover ?? discoverProduction)(runtime).catch(
    () => undefined,
  );
  if (discovered === undefined || !sameLaunch(discovered, expected.launch)) {
    return failed(
      "not-discovered",
      discovered === undefined
        ? "The product's discovery did not locate the runtime after the install."
        : "The product's discovery resolved to a different executable than the private install.",
    );
  }
  return Object.freeze({
    kind: "installed",
    runtime,
    version,
    directory,
    configuredPath,
    launch: discovered,
    registry,
  });
}

function defaultInstallRoot(environment: NodeJS.ProcessEnv): string {
  return join(localAppData(environment), productRuntimeRoot, "cli");
}

function defaultPrivateNodeDirectory(environment: NodeJS.ProcessEnv): string {
  return join(localAppData(environment), productRuntimeRoot, "node", "bin");
}

function localAppData(environment: NodeJS.ProcessEnv): string {
  const value = environment.LOCALAPPDATA;
  return typeof value === "string" && value.length > 0 && isAbsolute(value)
    ? value
    : join(homedir(), "AppData", "Local");
}

interface StaleNodeCandidate {
  readonly path: string;
  readonly version: string;
}

interface NodeLookup {
  readonly node: { readonly executable: string; readonly directory: string } | undefined;
  /** Admitted candidates rejected for reading back a version below the floor. */
  readonly stale: readonly StaleNodeCandidate[];
}

/**
 * A structurally admitted candidate is not necessarily USABLE: `npm install`
 * under a node older than {@link NODE_MINIMUM_MAJOR}.{@link NODE_MINIMUM_MINOR}
 * fails downstream for reasons that name npm, not the node that ran it. So
 * every candidate is read back the same way w282 reads back the private
 * Node -- run it and parse `process.versions.node` -- and one below the floor
 * is skipped exactly like one that could not be found at all.
 */
async function locateNode(
  privateNodeDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<NodeLookup> {
  const candidates = [
    join(privateNodeDirectory, "node.exe"),
    ...(await lookupOnPathBounded("node.exe").catch(() => [])),
  ];
  const stale: StaleNodeCandidate[] = [];
  for (const candidate of candidates) {
    const admitted = await admitNativeExecutable(
      candidate,
      productionWindowsAdmissionDependencies,
    );
    if (admitted.kind !== "admitted") continue;
    const version = await readCandidateNodeVersion(admitted.path, environment);
    if (version === undefined || !nodeVersionAtLeast(version)) {
      if (version !== undefined) stale.push({ path: admitted.path, version });
      continue;
    }
    return {
      node: { executable: admitted.path, directory: join(admitted.path, "..") },
      stale,
    };
  }
  return { node: undefined, stale };
}

const maximumVersionCharacters = 64;

/** Runs the candidate and reads `process.versions.node` straight out of the pipe. */
function readCandidateNodeVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    // A file that passed structural admission is not necessarily a real PE:
    // spawn() throws SYNCHRONOUSLY for that on Windows (`spawn UNKNOWN`),
    // before any event can carry it (w282).
    let child;
    try {
      child = spawn(executable, ["-p", "process.versions.node"], {
        env: environment,
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

/** "Node 18.0.0 on PATH is too old (needs 22.5 or newer). <the rest>" */
function withStaleNodeContext(stale: readonly StaleNodeCandidate[], detail: string): string {
  const first = stale[0];
  if (first === undefined) return detail;
  return `Node ${first.version} on PATH is too old (needs ${String(NODE_MINIMUM_MAJOR)}.${String(NODE_MINIMUM_MINOR)} or newer). ${detail}`;
}

function runNpmInstall(
  node: string,
  arguments_: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
): Promise<CliInstallRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [...arguments_], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let tail = "";
    const collect = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-maximumOutputTailBytes);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, outputTail: tail }));
  });
}

async function installedVersion(
  directory: string,
  packageName: string,
): Promise<string | undefined> {
  const text = await readTextFile(
    join(directory, "node_modules", ...packageName.split("/"), "package.json"),
  );
  if (text === undefined) return undefined;
  try {
    const manifest = JSON.parse(text) as { readonly version?: unknown };
    return typeof manifest.version === "string" && manifest.version.length > 0
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

async function placeNodeBeside(source: string, destination: string): Promise<void> {
  await rm(destination, { force: true });
  try {
    await link(source, destination);
  } catch {
    await copyFile(source, destination);
  }
}

async function discoverProduction(
  runtime: ConfigurableRuntime,
): Promise<WindowsRuntimeLaunch | undefined> {
  if (runtime === "claude") return discoverClaudeLaunch();
  let held: WindowsRuntimeLaunch | undefined;
  const result = await discoverCodexExecutable(
    productionCodexExecutableDiscoveryDependencies((launch) => {
      held = launch;
      return launch as unknown as CodexExecutableHandle;
    }),
  );
  return result.kind === "located" ? held : undefined;
}

function sameLaunch(left: WindowsRuntimeLaunch, right: WindowsRuntimeLaunch): boolean {
  const key = (launch: WindowsRuntimeLaunch): string =>
    [launch.executable, ...launch.prefixArguments].join("\0").toLocaleLowerCase("en-US");
  return key(left) === key(right);
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    const contents = await readFile(path);
    return contents.byteLength > maximumManifestBytes ? undefined : contents.toString("utf8");
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
