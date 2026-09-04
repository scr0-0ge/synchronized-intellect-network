import type { ChildProcess } from "node:child_process";
import {
  access,
  lstat,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { ElectronApplication } from "playwright";

import {
  captureWindow as captureWindowLifecycle,
  type WindowSnapshot,
} from "./window-lifecycle.ts";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "../harness/production-electron.ts";

const productionElectron = resolveProductionElectronComposition(
  new URL("../f72-close-to-tray.ts", import.meta.url).href,
);
const {
  repositoryRoot,
  electronExecutable,
  rendererUrl: expectedRendererUrl,
} = productionElectron;
const temporaryRootPattern = /^workbench-f72-[A-Za-z0-9_-]+$/u;
const appearanceFileName = "workbench-appearance-preferences-v1.json";
const retainedElectronEnvironmentKeys: ReadonlySet<string> = new Set([
  "comspec",
  "number_of_processors",
  "os",
  "pathext",
  "processor_architecture",
  "processor_architew6432",
  "systemdrive",
  "systemroot",
  "windir",
] as const);
const rejectedCredentialEnvironmentKeyExamples = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_PASSWORD",
  "CLIENT_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
]);
const credentialEnvironmentKeyPattern =
  /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|BEARER_?TOKEN|ACCESS_?TOKEN|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|KEY)(?:_|$)/u;

interface SecondaryExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface HeldRuntimeControl {
  readonly temporaryRoot: string;
  readonly projectDirectory: string;
  readonly runtimeDirectory: string;
  readonly controlDirectory: string;
  readonly heldExecutablePath: string;
  readonly appServerPath: string;
  readonly readyPath: string;
  readonly releasePath: string;
  readonly exitPath: string;
  readonly dialogObservationPath: string;
  readonly ownerNonce: string;
}

async function captureWindow(
  application: ElectronApplication,
): Promise<WindowSnapshot> {
  return captureWindowLifecycle(application);
}

function captureChildOutput(): {
  readonly attach: (child: ChildProcess) => void;
  readonly snapshot: () => { readonly stdout: string; readonly stderr: string };
} {
  let stdout = "";
  let stderr = "";
  const append = (current: string, chunk: unknown) =>
    `${current}${String(chunk)}`.slice(-8_192);
  return {
    attach(child) {
      child.stdout?.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
    },
    snapshot: () => ({ stdout, stderr }),
  };
}

async function waitForChildExit(
  child: ChildProcess,
  output: ReturnType<typeof captureChildOutput>,
  timeoutMilliseconds: number,
): Promise<SecondaryExit> {
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("f72-secondary-exit-timeout")),
        timeoutMilliseconds,
      ),
    ),
  ]);
  return { ...result, ...output.snapshot() };
}

async function waitForProcessExit(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("f72-primary-exit-timeout")),
        timeoutMilliseconds,
      ),
    ),
  ]);
}

async function stopOwnedApplication(
  application: ElectronApplication | undefined,
  ownedMainProcess: ChildProcess | undefined,
  ownedMainPid: number | undefined,
): Promise<void> {
  if (application === undefined) {
    if (ownedMainProcess !== undefined || ownedMainPid !== undefined) {
      throw new Error("f72-owned-application-without-application");
    }
    return;
  }
  const currentMainProcess = application.process();
  if (
    ownedMainProcess === undefined ||
    ownedMainPid === undefined ||
    ownedMainPid <= 0 ||
    currentMainProcess !== ownedMainProcess ||
    currentMainProcess.pid !== ownedMainPid
  ) {
    throw new Error("f72-owned-application-process-mismatch");
  }
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("f72-application-close-timeout")),
          10_000,
        ),
      ),
    ]);
  } catch {
    // The exact launch-time ChildProcess fallback below is the only destructive
    // cleanup authority when product-owned graceful quit does not complete.
  }
  let exited = await waitForExactOwnedChildExit(
    ownedMainProcess,
    ownedMainPid,
    1_000,
  );
  if (!exited && isExactOwnedChildAlive(ownedMainProcess, ownedMainPid)) {
    ownedMainProcess.kill();
  }
  exited =
    exited ||
    (await waitForExactOwnedChildExit(ownedMainProcess, ownedMainPid, 5_000));
  if (!exited) {
    throw new Error("f72-exact-owned-application-survived-cleanup");
  }
}

async function stopOwnedChild(
  child: ChildProcess,
  ownedPid: number | undefined,
): Promise<void> {
  if (ownedPid === undefined || ownedPid <= 0 || child.pid !== ownedPid) {
    throw new Error("f72-owned-child-process-mismatch");
  }
  let exited = await waitForExactOwnedChildExit(child, ownedPid, 250);
  if (!exited && isExactOwnedChildAlive(child, ownedPid)) child.kill();
  exited =
    exited || (await waitForExactOwnedChildExit(child, ownedPid, 5_000));
  if (!exited) throw new Error("f72-exact-owned-child-survived-cleanup");
}

async function waitForExactOwnedChildExit(
  child: ChildProcess,
  ownedPid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (ownedPid <= 0 || child.pid !== ownedPid) return false;
  const exitObserved =
    child.exitCode !== null ||
    child.signalCode !== null ||
    (await Promise.race([
      waitForChildProcessExit(child).then(() => true),
      new Promise<false>((resolveWait) =>
        setTimeout(() => resolveWait(false), timeoutMilliseconds),
      ),
    ]));
  return exitObserved && !(await processAlive(ownedPid));
}

function isExactOwnedChildAlive(
  child: ChildProcess,
  ownedPid: number,
): boolean {
  return (
    ownedPid > 0 &&
    child.pid === ownedPid &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(
  pid: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!(await processAlive(pid))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !(await processAlive(pid));
}

function waitForChildProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

async function removeOwnedTemporaryRoot(root: string): Promise<void> {
  const information = await lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("f72-temporary-root-type-check-failed");
  }
  const [resolvedRoot, resolvedTemporaryDirectory] = await Promise.all([
    realpath(root),
    realpath(tmpdir()),
  ]);
  const expectedRoot = resolve(root);
  if (
    resolvedRoot.toLocaleLowerCase("en-US") !==
      expectedRoot.toLocaleLowerCase("en-US") ||
    dirname(resolvedRoot) !== resolvedTemporaryDirectory ||
    !temporaryRootPattern.test(basename(resolvedRoot))
  ) {
    throw new Error("f72-temporary-root-ownership-check-failed");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function providerFreeProductionEnvironment(
  source: NodeJS.ProcessEnv,
  isolatedHome: string,
  isolatedTempDirectory: string,
  heldRuntime?: HeldRuntimeControl,
): Readonly<Record<string, string>> {
  if (
    !rejectedCredentialEnvironmentKeyExamples.every(isSensitiveEnvironmentKey)
  ) {
    throw new Error("f72-credential-scrub-invariant-failed");
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toLocaleLowerCase("en-US");
    if (
      typeof value === "string" &&
      retainedElectronEnvironmentKeys.has(normalizedKey) &&
      !isSensitiveEnvironmentKey(key)
    ) {
      environment[key] = value;
    }
  }
  const systemRoot = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase("en-US") === "systemroot",
  )?.[1];
  if (systemRoot === undefined) throw new Error("f72-system-root-unavailable");
  const systemPath = [
    join(systemRoot, "System32"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  environment.PATH = systemPath;
  if (heldRuntime !== undefined) {
    environment.PATH = `${heldRuntime.runtimeDirectory};${systemPath}`;
    environment.UAW_F72_HELD_CONTROL_DIRECTORY = heldRuntime.controlDirectory;
    environment.UAW_F72_HELD_OWNER_NONCE = heldRuntime.ownerNonce;
  }
  environment.USERPROFILE = isolatedHome;
  environment.HOMEDRIVE = dirname(isolatedHome).slice(0, 2);
  environment.HOMEPATH = isolatedHome.slice(2);
  environment.APPDATA = join(isolatedHome, "AppData", "Roaming");
  environment.LOCALAPPDATA = join(isolatedHome, "AppData", "Local");
  environment.TEMP = isolatedTempDirectory;
  environment.TMP = isolatedTempDirectory;
  return Object.freeze(environment);
}

/**
 * The two roots providerFreeProductionEnvironment redirects APPDATA and
 * LOCALAPPDATA to. Electron resolves app.getPath("appData") from APPDATA and
 * throws if that directory is absent, so an isolated home must materialise them
 * rather than only name them.
 */
function isolatedApplicationDataDirectories(
  isolatedHome: string,
): readonly string[] {
  return Object.freeze([
    join(isolatedHome, "AppData", "Roaming"),
    join(isolatedHome, "AppData", "Local"),
  ]);
}

function isSensitiveEnvironmentKey(key: string): boolean {
  const normalized = key.toLocaleUpperCase("en-US");
  return credentialEnvironmentKeyPattern.test(normalized);
}

function hasExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key) => typeof key === "string" && expectedKeys.includes(key),
    )
  );
}

function requiredString(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(errorCode);
  }
  return value;
}

function requiredSafeInteger(value: unknown, errorCode: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(errorCode);
  return value as number;
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32"
    ? absolute.toLocaleLowerCase("en-US")
    : absolute;
}

function throwCleanupFailures(
  primaryFailure: { readonly error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
  context: string,
): void {
  if (cleanupFailures.length === 0) return;
  throw new AggregateError(
    primaryFailure === undefined
      ? cleanupFailures
      : [primaryFailure.error, ...cleanupFailures],
    `${context} cleanup failed`,
  );
}


export {
  appearanceFileName,
  captureChildOutput,
  captureWindow,
  comparablePath,
  electronExecutable,
  expectedRendererUrl,
  firstDomContentLoadedWindow,
  hasExactObjectKeys,
  isolatedApplicationDataDirectories,
  launchProductionElectron,
  nativeErrorCode,
  pathExists,
  productionElectron,
  productionElectronArguments,
  processAlive,
  providerFreeProductionEnvironment,
  removeOwnedTemporaryRoot,
  repositoryRoot,
  requiredSafeInteger,
  requiredString,
  stopOwnedApplication,
  stopOwnedChild,
  throwCleanupFailures,
  waitForChildExit,
  waitForExactOwnedChildExit,
  waitForProcessExit,
  waitUntilDead,
};
export type { HeldRuntimeControl, SecondaryExit };
