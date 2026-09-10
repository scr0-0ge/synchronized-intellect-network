import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
} from "node:child_process";
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadLineInterface } from "node:readline";

import { RuntimeAdapterError } from "../index.ts";
import {
  ownSubscriptionAuthenticationProcess,
  waitForSubscriptionAuthenticationProcessSpawn,
  type SubscriptionAuthenticationChild,
} from "../subscription-authentication.ts";
import {
  createProductionCodexExecutableDiscovery,
  type CodexExecutableDiscoveryResult,
  type CodexExecutableHandle,
} from "./executable-discovery.ts";
import type { WindowsRuntimeLaunch } from "../windows-executable-admission.ts";
import type { OfficialRuntimeTransport } from "./transport.ts";

const cleanupLeafPattern = /^codex-adapter-[0-9a-f]{32}$/u;
const diagnosticLogMaximumBytes = 524_288;
const diagnosticLogPath = join(
  tmpdir(),
  `synchronized-intellect-network-codex-transport-${process.pid}.jsonl`,
);
let diagnosticLogInitialized = false;
const maximumStagedRuntimeBytes = 1_073_741_824;
const stagedRuntimeFileNames = Object.freeze([
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "rg.exe",
] as const);
const stagedRuntimeFileNameSet: ReadonlySet<string> = new Set(stagedRuntimeFileNames);
const requiredStagedRuntimeFileNames = Object.freeze([
  "codex.exe",
  "codex-code-mode-host.exe",
] as const);
const neverAbortedSignal = new AbortController().signal;
const maximumRuntimeStderrBytes = 65_536;
const runtimeStderr = new WeakMap<ChildProcessWithoutNullStreams, Buffer[]>();
const protectedSubscriptionAuthenticationEnvironmentKeys = Object.freeze([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const);
// The handle stays opaque: what discovery found never crosses back to a caller,
// only a token that this module can exchange for a launch plan. What it holds
// widened from a path to a { executable, prefixArguments } plan, because an npm
// global install of a JS-entrypoint package is launched as node.exe plus the
// vendor's entry script and a single string cannot describe that.
const executableLaunches = new WeakMap<CodexExecutableHandle, WindowsRuntimeLaunch>();

/** The arguments that put the Codex CLI into its app-server protocol mode. */
export const CODEX_APP_SERVER_ARGUMENTS: readonly string[] = Object.freeze([
  "app-server",
  "--stdio",
]);

export type CodexTransportDiagnostic =
  | { readonly kind: "direct-launch-succeeded" }
  | {
      readonly kind: "direct-launch-failed";
      readonly errorCode: string | null;
      readonly fallbackEligible: boolean;
    }
  | { readonly kind: "staging-started" }
  | {
      readonly kind: "staging-succeeded";
      readonly files: readonly string[];
    }
  | { readonly kind: "staging-failed"; readonly reason: string }
  // Staging copies codex.exe and its sidecar .exe files out of the directory
  // the runtime was found in. A JavaScript entry point has no such directory --
  // argv[0] is node.exe and its neighbours are Node's, not Codex's -- so the
  // fallback is skipped rather than pointed at the wrong tree. It is named
  // here rather than passed over in silence, because a fallback that quietly
  // stops applying to a whole class of install is exactly the kind of thing
  // that is discovered years later from a support thread.
  | {
      readonly kind: "staging-skipped";
      readonly reason: "javascript-entry-point";
    }
  | { readonly kind: "staged-launch-succeeded" }
  | {
      readonly kind: "staged-launch-failed";
      readonly errorCode: string | null;
    }
  | {
      readonly kind: "shutdown-forced";
      readonly gracefulWaitMilliseconds: number;
    }
  | {
      readonly kind: "cleanup-failed";
      readonly reason: string;
    }
  | { readonly kind: "cleanup-succeeded" }
  // What the CLI itself said. When a release stops accepting a flag or a
  // config key the workbench writes -- 0.153-alpha did exactly that to
  // `wire_api = "chat"` -- the runtime explains the refusal on stderr and then
  // exits, and this side used to see only a closed stream. Draining that into
  // nowhere turned every such refusal into an unexplained failure.
  | { readonly kind: "runtime-stderr"; readonly text: string };

export interface CodexProcessTransportDependencies {
  discoverExecutable(): Promise<CodexExecutableDiscoveryResult>;
  launchExecutable(
    executable: CodexExecutableHandle,
    environment?: NodeJS.ProcessEnv,
  ): Promise<ChildProcessWithoutNullStreams>;
  stageExecutable(executable: CodexExecutableHandle): Promise<{
    readonly executable: CodexExecutableHandle;
    readonly cleanupDirectory: string;
    readonly stagedFiles: readonly string[];
  }>;
  removeCleanupDirectory(directory: string): Promise<void>;
  recordDiagnostic(diagnostic: CodexTransportDiagnostic): void;
  waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMilliseconds: number,
  ): Promise<boolean>;
}

/**
 * Options for an endpoint-context transport (ticket 17). `environment`, when
 * present, is passed to every launch (direct and staged): the child then runs
 * on exactly this environment instead of inheriting the parent's. Absent
 * options keep the historical spawn byte-identical (`codex-desktop`).
 */
export interface CodexProcessTransportOptions {
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexSubscriptionLoginProcessDependencies {
  discoverExecutable(): Promise<CodexExecutableDiscoveryResult>;
  spawnProcess(
    executable: CodexExecutableHandle,
    arguments_: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly shell: false;
      readonly stdio: "ignore";
      readonly windowsHide: true;
    },
  ): ChildProcess;
  stageExecutable(executable: CodexExecutableHandle): Promise<{
    readonly executable: CodexExecutableHandle;
    readonly cleanupDirectory: string;
    readonly stagedFiles: readonly string[];
  }>;
  removeCleanupDirectory(directory: string): Promise<void>;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CodexCleanupDependencies {
  removeDirectory(directory: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}

const productionCleanupDependencies: CodexCleanupDependencies = Object.freeze({
  removeDirectory: (directory: string) =>
    rm(directory, { recursive: true, force: false }),
  wait: delay,
});

const discoverProductionExecutable = createProductionCodexExecutableDiscovery(
  holdExecutable,
);
const productionDependencies: CodexProcessTransportDependencies = Object.freeze({
  discoverExecutable: discoverProductionExecutable,
  // main-resync: main's plan-based launch (the handle carries a
  // WindowsRuntimeLaunch, so a .cmd shim's entry script is structurally
  // resolved, never re-parsed by a shell) keeps the lane's endpoint-context
  // `environment` passthrough: absent, the spawn options are exactly main's;
  // present, the child runs on exactly that environment (ticket 17).
  launchExecutable: (
    executable: CodexExecutableHandle,
    environment?: NodeJS.ProcessEnv,
  ) =>
    launchCodexRuntime(
      executableLaunch(executable),
      productionRuntimeSpawn,
      environment,
    ),
  stageExecutable: stageProductionCodexRuntime,
  removeCleanupDirectory: removeCodexCleanupDirectory,
  recordDiagnostic: writeCodexTransportDiagnostic,
  waitForExit,
});
const productionSubscriptionLoginDependencies: CodexSubscriptionLoginProcessDependencies =
  Object.freeze({
    discoverExecutable: discoverProductionExecutable,
    spawnProcess: (
      executable: CodexExecutableHandle,
      arguments_: readonly string[],
      options: Parameters<
        CodexSubscriptionLoginProcessDependencies["spawnProcess"]
      >[2],
    ) => {
      const plan = executableLaunch(executable);
      // The entry script, when there is one, precedes the runtime's own
      // arguments. argv stays an array handed to CreateProcess and the options
      // object is passed through untouched: there is no `shell: true` here or
      // anywhere else in this repository.
      return spawn(plan.executable, [...codexSpawnArguments(plan, arguments_)], options);
    },
    stageExecutable: stageProductionCodexRuntime,
    removeCleanupDirectory: removeCodexCleanupDirectory,
    environment: process.env,
  });

async function stageProductionCodexRuntime(
  executable: CodexExecutableHandle,
): Promise<{
  readonly executable: CodexExecutableHandle;
  readonly cleanupDirectory: string;
  readonly stagedFiles: readonly string[];
}> {
  const staged = await stageCodexRuntimeLaunch(executableLaunch(executable));
  return Object.freeze({
    executable: holdExecutable(staged.launch),
    cleanupDirectory: staged.cleanupDirectory,
    stagedFiles: staged.stagedFiles,
  });
}

function writeCodexTransportDiagnostic(diagnostic: CodexTransportDiagnostic): void {
  const row = `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    ...diagnostic,
  })}\n`;
  try {
    process.stderr.write(`[codex-transport] ${row}`);
  } catch {
    // A diagnostic sink must never change transport behaviour.
  }
  try {
    const information = diagnosticLogInitialized
      ? statSync(diagnosticLogPath, { throwIfNoEntry: false })
      : undefined;
    const reset =
      !diagnosticLogInitialized ||
      information === undefined ||
      information.size >= diagnosticLogMaximumBytes;
    if (reset) {
      writeFileSync(diagnosticLogPath, row, { encoding: "utf8", mode: 0o600 });
    } else {
      appendFileSync(diagnosticLogPath, row, "utf8");
    }
    diagnosticLogInitialized = true;
  } catch {
    // The stderr copy remains available if the bounded durable sink is unavailable.
  }
}

export function codexTransportDiagnosticFilePath(): string {
  return diagnosticLogPath;
}

/**
 * The production executable discovery, exported for endpoint-context adapters
 * (ticket 17): a static-catalog endpoint's `inspect` must be able to report
 * `runtime-not-located` without spawning a process, exactly like the claude
 * family's static-catalog endpoints.
 */
export function discoverOfficialCodexExecutable(): Promise<CodexExecutableDiscoveryResult> {
  return discoverProductionExecutable();
}

/**
 * Fresh launch plan used by local operations that must address the same Codex
 * installation as the next Session. The branded handle remains private to the
 * transport boundary; callers receive only the complete executable + prefix
 * argument plan needed to start native and JavaScript-entry installs alike.
 */
export async function discoverOfficialCodexLaunch(): Promise<WindowsRuntimeLaunch> {
  const discovery = await discoverProductionExecutable();
  if (discovery.kind !== "located") {
    throw new RuntimeAdapterError("runtime-not-located");
  }
  return executableLaunch(discovery.executable);
}

export async function createOfficialCodexTransport(
  dependencies: CodexProcessTransportDependencies = productionDependencies,
  options: CodexProcessTransportOptions = {},
): Promise<OfficialRuntimeTransport> {
  const discovery = await dependencies.discoverExecutable().catch(
    (): CodexExecutableDiscoveryResult => ({ kind: "not-located" }),
  );
  if (discovery.kind !== "located") {
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const executable = discovery.executable;
  const environment = options.environment;
  let cleanupDirectory: string | undefined;
  let child: ChildProcessWithoutNullStreams;

  try {
    child = await dependencies.launchExecutable(executable, environment);
    recordDiagnostic(dependencies, { kind: "direct-launch-succeeded" });
  } catch (error) {
    const fallbackEligible = isAccessDenied(error);
    recordDiagnostic(dependencies, {
      kind: "direct-launch-failed",
      errorCode: nativeErrorCode(error),
      fallbackEligible,
    });
    if (!fallbackEligible) throw new RuntimeAdapterError("runtime-unavailable");
    let staged: Awaited<ReturnType<CodexProcessTransportDependencies["stageExecutable"]>>;
    recordDiagnostic(dependencies, { kind: "staging-started" });
    try {
      staged = await dependencies.stageExecutable(executable);
      cleanupDirectory = staged.cleanupDirectory;
      recordDiagnostic(dependencies, {
        kind: "staging-succeeded",
        files: staged.stagedFiles,
      });
    } catch (stagingError) {
      recordDiagnostic(dependencies, {
        kind: "staging-failed",
        reason: stagingFailureReason(stagingError),
      });
      if (stagingError instanceof RuntimeAdapterError) throw stagingError;
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    try {
      child = await dependencies.launchExecutable(staged.executable, environment);
      recordDiagnostic(dependencies, { kind: "staged-launch-succeeded" });
    } catch (stagedLaunchError) {
      recordDiagnostic(dependencies, {
        kind: "staged-launch-failed",
        errorCode: nativeErrorCode(stagedLaunchError),
      });
      await removeStagedDirectory(dependencies, cleanupDirectory);
      throw new RuntimeAdapterError("runtime-unavailable");
    }
  }

  return new ProcessTransport(
    child,
    cleanupDirectory,
    (directory) => removeStagedDirectory(dependencies, directory),
    (process, timeoutMilliseconds) =>
      dependencies.waitForExit(process, timeoutMilliseconds),
    (diagnostic) => recordDiagnostic(dependencies, diagnostic),
  );
}

export async function createOfficialCodexSubscriptionLoginProcess(
  dependencies: CodexSubscriptionLoginProcessDependencies =
    productionSubscriptionLoginDependencies,
  signal: AbortSignal = neverAbortedSignal,
): Promise<SubscriptionAuthenticationChild> {
  return createOfficialCodexSubscriptionAuthenticationProcess(
    "login",
    dependencies,
    signal,
  );
}

export async function createOfficialCodexSubscriptionLogoutProcess(
  dependencies: CodexSubscriptionLoginProcessDependencies =
    productionSubscriptionLoginDependencies,
  signal: AbortSignal = neverAbortedSignal,
): Promise<SubscriptionAuthenticationChild> {
  return createOfficialCodexSubscriptionAuthenticationProcess(
    "logout",
    dependencies,
    signal,
  );
}

async function createOfficialCodexSubscriptionAuthenticationProcess(
  action: "login" | "logout",
  dependencies: CodexSubscriptionLoginProcessDependencies,
  signal: AbortSignal,
): Promise<SubscriptionAuthenticationChild> {
  assertSubscriptionLoginLaunchOpen(signal);
  const discovery = await dependencies.discoverExecutable().catch(
    (): CodexExecutableDiscoveryResult => ({ kind: "not-located" }),
  );
  if (discovery.kind !== "located") {
    throw new RuntimeAdapterError("runtime-not-located");
  }
  assertSubscriptionLoginLaunchOpen(signal);
  try {
    return await launchCodexSubscriptionLogin(
      discovery.executable,
      action,
      dependencies,
      signal,
    );
  } catch (error) {
    assertSubscriptionLoginLaunchOpen(signal);
    if (!isAccessDenied(error)) {
      throw new RuntimeAdapterError("runtime-unavailable");
    }
  }

  let staged: Awaited<
    ReturnType<CodexSubscriptionLoginProcessDependencies["stageExecutable"]>
  >;
  try {
    staged = await dependencies.stageExecutable(discovery.executable);
  } catch {
    throw new RuntimeAdapterError("runtime-unavailable");
  }
  try {
    assertSubscriptionLoginLaunchOpen(signal);
    return await launchCodexSubscriptionLogin(
      staged.executable,
      action,
      dependencies,
      signal,
      () => dependencies.removeCleanupDirectory(staged.cleanupDirectory),
    );
  } catch {
    try {
      await dependencies.removeCleanupDirectory(staged.cleanupDirectory);
    } catch {
      // The fixed launch failure remains the only public result.
    }
    throw new RuntimeAdapterError("runtime-unavailable");
  }
}

export async function removeCodexCleanupDirectory(
  directory: string,
  dependencies: CodexCleanupDependencies = productionCleanupDependencies,
): Promise<void> {
  const resolved = await resolveCleanupDirectory(directory);
  for (let retry = 0; ; retry += 1) {
    try {
      await dependencies.removeDirectory(resolved);
      return;
    } catch (error) {
      if (retry < 10 && isRetryableWindowsCleanupError(error)) {
        await dependencies.wait((retry + 1) * 100);
        const revalidated = await resolveCleanupDirectory(resolved);
        if (comparable(revalidated) !== comparable(resolved)) {
          throw new RuntimeAdapterError("temp-cleanup-guard");
        }
        continue;
      }
      throw new CodexCleanupError(
        `delete-failed:${nativeErrorCode(error) ?? "unknown"}`,
      );
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveCleanupDirectory(directory: string): Promise<string> {
  try {
    const source = await lstat(directory);
    if (!source.isDirectory() || source.isSymbolicLink()) {
      throw new RuntimeAdapterError("temp-cleanup-guard");
    }

    const resolvedDirectory = await realpath(directory);
    const resolvedTempRoot = await realpath(tmpdir());
    if (
      comparable(dirname(resolvedDirectory)) !== comparable(resolvedTempRoot) ||
      !cleanupLeafPattern.test(basename(resolvedDirectory))
    ) {
      throw new RuntimeAdapterError("temp-cleanup-guard");
    }
    await assertNoLinks(resolvedDirectory);
    return resolvedDirectory;
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw new RuntimeAdapterError("temp-cleanup-guard");
  }
}

async function assertNoLinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new RuntimeAdapterError("temp-cleanup-guard");
    if (entry.isDirectory()) await assertNoLinks(join(directory, entry.name));
  }
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

/**
 * The access-denied fallback, told which shape of runtime it was handed.
 *
 * Staging exists for one situation: a direct launch of the vendor's own
 * `codex.exe` was refused with EACCES/EPERM -- typically a security product
 * holding the file -- and a copy of the runtime under the OS temp directory
 * starts where the original would not. That is a statement about a DIRECTORY OF
 * NATIVE EXECUTABLES: `codex.exe` plus the sidecars a tool call needs.
 *
 * A JavaScript entry point has no such directory. argv[0] is `node.exe` and the
 * files beside it belong to Node, so the sidecar scan would either fail with
 * `required-runtime-file-missing:codex.exe` -- a reason that describes the
 * wrong thing and would send whoever reads it looking for a missing Codex
 * install -- or, worse, copy an unrelated `codex.exe` that happened to sit in
 * an npm prefix. So the fallback is SKIPPED for that shape, and the skip is
 * recorded as its own diagnostic. The direct launch failure remains the public
 * result, exactly as it does when staging is attempted and fails.
 */
export async function stageCodexRuntimeLaunch(
  plan: WindowsRuntimeLaunch,
  recordDiagnostic: (diagnostic: CodexTransportDiagnostic) => void =
    writeCodexTransportDiagnostic,
): Promise<{
  readonly launch: WindowsRuntimeLaunch;
  readonly cleanupDirectory: string;
  readonly stagedFiles: readonly string[];
}> {
  if (plan.prefixArguments.length > 0) {
    try {
      recordDiagnostic(
        Object.freeze({
          kind: "staging-skipped" as const,
          reason: "javascript-entry-point" as const,
        }),
      );
    } catch {
      // Diagnostics are observational and never gain control over the transport.
    }
    throw new CodexStagingError("staging-unavailable-for-javascript-entry-point");
  }
  const staged = await stageCodexRuntime(plan.executable);
  return Object.freeze({
    launch: Object.freeze({
      executable: join(staged.cleanupDirectory, "codex.exe"),
      prefixArguments: Object.freeze([]),
    }),
    cleanupDirectory: staged.cleanupDirectory,
    stagedFiles: staged.stagedFiles,
  });
}

export async function stageCodexRuntime(executable: string): Promise<{
  readonly cleanupDirectory: string;
  readonly stagedFiles: readonly string[];
}> {
  const directory = join(tmpdir(), `codex-adapter-${randomUUID().replaceAll("-", "")}`);
  let directoryCreated = false;
  try {
    await mkdir(directory);
    directoryCreated = true;
    await resolveCleanupDirectory(directory);
    const runtimeFiles = await validatedRuntimeFiles(executable);
    for (const file of runtimeFiles) {
      await copyFile(file.source, join(directory, file.name));
    }
    return Object.freeze({
      cleanupDirectory: directory,
      stagedFiles: Object.freeze(runtimeFiles.map((file) => file.name)),
    });
  } catch (error) {
    if (directoryCreated) {
      try {
        await removeCodexCleanupDirectory(directory);
      } catch {
        throw new RuntimeAdapterError("temp-cleanup");
      }
    }
    if (error instanceof RuntimeAdapterError) throw error;
    throw new CodexStagingError(
      `source-read-or-copy-failed:${nativeErrorCode(error) ?? "unknown"}`,
    );
  }
}

async function validatedRuntimeFiles(
  executable: string,
): Promise<readonly { readonly name: string; readonly source: string }[]> {
  const sourceDirectory = dirname(executable);
  let resolvedSourceDirectory: string;
  let entries: Dirent[];
  try {
    resolvedSourceDirectory = await realpath(sourceDirectory);
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    throw new CodexStagingError(
      `source-directory-unavailable:${nativeErrorCode(error) ?? "unknown"}`,
    );
  }

  const entriesByName = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const normalizedName = entry.name.toLocaleLowerCase("en-US");
    if (!stagedRuntimeFileNameSet.has(normalizedName)) continue;
    if (entriesByName.has(normalizedName)) {
      throw new CodexStagingError(`duplicate-runtime-file:${normalizedName}`);
    }
    entriesByName.set(normalizedName, entry);
  }
  for (const requiredName of requiredStagedRuntimeFileNames) {
    if (!entriesByName.has(requiredName)) {
      throw new CodexStagingError(`required-runtime-file-missing:${requiredName}`);
    }
  }

  const files: { readonly name: string; readonly source: string }[] = [];
  let totalBytes = 0;
  for (const name of stagedRuntimeFileNames) {
    const entry = entriesByName.get(name);
    if (entry === undefined) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new CodexStagingError(`runtime-file-not-regular:${name}`);
    }
    const source = join(sourceDirectory, entry.name);
    const information = await lstat(source);
    const resolvedSource = await realpath(source);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      comparable(dirname(resolvedSource)) !== comparable(resolvedSourceDirectory)
    ) {
      throw new CodexStagingError(`runtime-file-escaped-source:${name}`);
    }
    totalBytes += information.size;
    if (totalBytes > maximumStagedRuntimeBytes) {
      throw new CodexStagingError("runtime-files-too-large");
    }
    files.push(Object.freeze({ name, source: resolvedSource }));
  }

  if (comparable(files[0]?.source ?? "") !== comparable(await realpath(executable))) {
    throw new CodexStagingError("runtime-executable-mismatch");
  }
  return Object.freeze(files);
}

/**
 * argv for a launch plan, assembled in exactly ONE place.
 *
 * The vendor's entry script, when there is one, precedes the runtime's own
 * arguments; for a native plan `prefixArguments` is empty and this is the
 * identity it always was. Nothing is joined into a string and nothing is
 * re-parsed by a shell -- the whole point of resolving a `.cmd` shim
 * structurally instead of spawning it through cmd.exe.
 */
export function codexSpawnArguments(
  plan: WindowsRuntimeLaunch,
  arguments_: readonly string[],
): readonly string[] {
  return Object.freeze([...plan.prefixArguments, ...arguments_]);
}

export type CodexRuntimeSpawn = (
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly stdio: "pipe";
    readonly windowsHide: true;
    // main-resync: the lane's endpoint-context launch passes an explicit
    // environment; main's own call sites keep the two-field options object
    // and inherit the parent environment exactly as before.
    readonly env?: NodeJS.ProcessEnv;
  },
) => ChildProcessWithoutNullStreams;

const productionRuntimeSpawn: CodexRuntimeSpawn = (
  executable,
  arguments_,
  options,
) => spawn(executable, [...arguments_], options);

/**
 * Keep a bounded head of the runtime's stderr so a failure can say what the CLI
 * complained about. Bounded and head-only: the first refusal is the one that
 * explains the exit, and the stream still drains either way.
 */
function captureCodexRuntimeStderr(child: ChildProcessWithoutNullStreams): void {
  const chunks: Buffer[] = [];
  let captured = 0;
  runtimeStderr.set(child, chunks);
  child.stderr.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const remaining = maximumRuntimeStderrBytes - captured;
    if (remaining <= 0) return;
    const retained = bytes.subarray(0, remaining);
    chunks.push(retained);
    captured += retained.length;
  });
  child.stderr.resume();
}

/** The captured stderr, once. Absent when the runtime said nothing. */
export function takeCodexRuntimeStderr(
  child: ChildProcessWithoutNullStreams,
): string | undefined {
  const chunks = runtimeStderr.get(child);
  if (chunks === undefined) return undefined;
  runtimeStderr.delete(child);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length === 0 ? undefined : text;
}

export function launchCodexRuntime(
  plan: WindowsRuntimeLaunch,
  spawnProcess: CodexRuntimeSpawn = productionRuntimeSpawn,
  environment?: NodeJS.ProcessEnv,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      plan.executable,
      codexSpawnArguments(plan, CODEX_APP_SERVER_ARGUMENTS),
      {
        stdio: "pipe",
        windowsHide: true,
        ...(environment === undefined ? {} : { env: environment }),
      },
    );
    captureCodexRuntimeStderr(child);

    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.on("error", () => {});
      resolve(child);
    });
  });
}

async function launchCodexSubscriptionLogin(
  executable: CodexExecutableHandle,
  action: "login" | "logout",
  dependencies: CodexSubscriptionLoginProcessDependencies,
  signal: AbortSignal,
  cleanup: () => Promise<void> = async () => undefined,
): Promise<SubscriptionAuthenticationChild> {
  assertSubscriptionLoginLaunchOpen(signal);
  const environment = { ...dependencies.environment };
  for (const key of protectedSubscriptionAuthenticationEnvironmentKeys) {
    delete environment[key];
  }
  const child = dependencies.spawnProcess(
    executable,
    Object.freeze([action]),
    Object.freeze({
      env: Object.freeze(environment),
      shell: false as const,
      stdio: "ignore" as const,
      windowsHide: true as const,
    }),
  );
  await waitForSubscriptionAuthenticationProcessSpawn(child);
  const owned = ownSubscriptionAuthenticationProcess(child, cleanup);
  if (signal.aborted) {
    await owned.terminate();
    throw new Error("Subscription authentication launch was cancelled.");
  }
  return owned;
}

function assertSubscriptionLoginLaunchOpen(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Subscription authentication launch was cancelled.");
  }
}

function isAccessDenied(error: unknown): boolean {
  const code = nativeErrorCode(error);
  return code === "EACCES" || code === "EPERM";
}

function nativeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function stagingFailureReason(error: unknown): string {
  if (error instanceof CodexStagingError) return error.diagnosticReason;
  if (error instanceof RuntimeAdapterError) return error.category;
  return nativeErrorCode(error) ?? "unexpected-error";
}

function cleanupFailureReason(error: unknown): string {
  if (error instanceof CodexCleanupError) return error.diagnosticReason;
  if (error instanceof RuntimeAdapterError) return error.category;
  return nativeErrorCode(error) ?? "unexpected-error";
}

async function removeStagedDirectory(
  dependencies: CodexProcessTransportDependencies,
  directory: string,
): Promise<void> {
  try {
    await dependencies.removeCleanupDirectory(directory);
    recordDiagnostic(dependencies, { kind: "cleanup-succeeded" });
  } catch (error) {
    recordDiagnostic(dependencies, {
      kind: "cleanup-failed",
      reason: cleanupFailureReason(error),
    });
    throw error;
  }
}

function isRetryableWindowsCleanupError(error: unknown): boolean {
  const code = nativeErrorCode(error);
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

function recordDiagnostic(
  dependencies: CodexProcessTransportDependencies,
  diagnostic: CodexTransportDiagnostic,
): void {
  try {
    dependencies.recordDiagnostic(Object.freeze(diagnostic));
  } catch {
    // Diagnostics are observational and never gain control over the transport.
  }
}

class CodexStagingError extends RuntimeAdapterError {
  readonly diagnosticReason: string;

  constructor(diagnosticReason: string) {
    super("runtime-unavailable");
    this.diagnosticReason = diagnosticReason;
  }
}

class CodexCleanupError extends RuntimeAdapterError {
  readonly diagnosticReason: string;

  constructor(diagnosticReason: string) {
    super("temp-cleanup");
    this.diagnosticReason = diagnosticReason;
  }
}

class ProcessTransport implements OfficialRuntimeTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly cleanupDirectory: string | undefined;
  private readonly removeCleanupDirectory: (directory: string) => Promise<void>;
  private readonly waitForExit: (
    child: ChildProcessWithoutNullStreams,
    timeoutMilliseconds: number,
  ) => Promise<boolean>;
  private readonly recordDiagnostic: (diagnostic: CodexTransportDiagnostic) => void;
  private readonly lines: AsyncIterator<string>;
  private readonly reader: ReadLineInterface;
  private stopResult: Promise<void> | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    cleanupDirectory: string | undefined,
    removeCleanupDirectory: (directory: string) => Promise<void>,
    waitForExit: (
      child: ChildProcessWithoutNullStreams,
      timeoutMilliseconds: number,
    ) => Promise<boolean>,
    recordDiagnostic: (diagnostic: CodexTransportDiagnostic) => void,
  ) {
    this.child = child;
    this.cleanupDirectory = cleanupDirectory;
    this.removeCleanupDirectory = removeCleanupDirectory;
    this.waitForExit = waitForExit;
    this.recordDiagnostic = recordDiagnostic;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines = this.reader[Symbol.asyncIterator]();
  }

  async send(line: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async receive(): Promise<string | null> {
    const result = await this.lines.next();
    return result.done ? null : result.value;
  }

  stop(): Promise<void> {
    this.stopResult ??= this.stopOnce();
    return this.stopResult;
  }

  private async stopOnce(): Promise<void> {
    let shutdownFailed = false;
    const complaint = takeCodexRuntimeStderr(this.child);
    if (complaint !== undefined) {
      this.recordDiagnostic({ kind: "runtime-stderr", text: complaint });
    }
    try {
      this.child.stdin.end();
    } catch {
      shutdownFailed = true;
    }

    this.reader.close();
    this.child.stdout.resume();
    let exited = await this.waitForExit(this.child, 5_000);
    if (!exited) {
      this.recordDiagnostic({
        kind: "shutdown-forced",
        gracefulWaitMilliseconds: 5_000,
      });
      try {
        this.child.kill();
      } catch {
        shutdownFailed = true;
      }
      exited = await this.waitForExit(this.child, 5_000);
    }
    if (
      !exited ||
      (this.child.exitCode !== null && this.child.exitCode !== 0) ||
      (this.child.exitCode === null && this.child.signalCode === null)
    ) {
      shutdownFailed = true;
    }

    if (exited && this.cleanupDirectory) {
      await this.removeCleanupDirectory(this.cleanupDirectory);
    }
    if (shutdownFailed) throw new RuntimeAdapterError("runtime-shutdown");
  }
}

function holdExecutable(launch: WindowsRuntimeLaunch): CodexExecutableHandle {
  const executable = Object.freeze({}) as CodexExecutableHandle;
  executableLaunches.set(executable, launch);
  return executable;
}

function executableLaunch(executable: CodexExecutableHandle): WindowsRuntimeLaunch {
  const launch = executableLaunches.get(executable);
  if (launch === undefined) throw new RuntimeAdapterError("runtime-not-located");
  return launch;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMilliseconds);
    const onExit = () => {
      finish(true);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}
