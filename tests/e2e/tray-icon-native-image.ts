import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkbenchTrayIcon } from "../../src/workbench-shell/electron/tray-icon.ts";

const resultMarker = "TRAY_ICON_NATIVE_RESULT ";
const probeMarker = "TRAY_ICON_NATIVE_PROBE ";
const temporaryRootPattern = /^workbench-tray-icon-native-[A-Za-z0-9_-]+$/u;
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixturePath = fileURLToPath(
  new URL("./fixtures/tray-icon-native-image.cjs", import.meta.url),
);
const electronExecutable = createRequire(import.meta.url)("electron") as string;

interface FixtureResult {
  readonly schema: "workbench-tray-icon-native-v1";
  readonly category:
    | "native-tray-icon-available"
    | "native-tray-icon-unavailable"
    | "native-fixture-failed";
  readonly nativeImageEmpty?: boolean;
  readonly nativeImageSize?: Readonly<{ width: number; height: number }>;
  readonly pngBytes?: number;
  readonly trayConstructed?: boolean;
  readonly trayErrorCategory?: "tray-construction-failed" | null;
  readonly topLevelFailure?: true;
  readonly passed: boolean;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function productionTrayIconDataUrl(): string {
  let dataUrl = "";
  createWorkbenchTrayIcon({
    createFromDataURL(candidate) {
      dataUrl = candidate;
      return { isEmpty: () => false };
    },
  });
  assert.notEqual(dataUrl, "", "production tray factory did not emit a data URL");
  return dataUrl;
}

function isolatedElectronEnvironment(paths: Readonly<{
  home: string;
  appData: string;
  localAppData: string;
  temp: string;
}>): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_?KEY|CREDENTIALS?)(?:_|$)/iu.test(
        key,
      ) ||
      ["electron_run_as_node", "node_options", "node_path"].includes(
        key.toLocaleLowerCase("en-US"),
      )
    ) {
      delete environment[key];
    }
  }
  const drive = paths.home.slice(0, 2);
  const homePath = paths.home.slice(2);
  environment.HOME = paths.home;
  environment.USERPROFILE = paths.home;
  environment.HOMEDRIVE = drive;
  environment.HOMEPATH = homePath.startsWith("\\") ? homePath : `\\${homePath}`;
  environment.APPDATA = paths.appData;
  environment.LOCALAPPDATA = paths.localAppData;
  environment.TEMP = paths.temp;
  environment.TMP = paths.temp;
  environment.TMPDIR = paths.temp;
  return environment;
}

function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseFixtureResult(stdout: string): FixtureResult {
  const lines = stdout.split(/\r?\n/u);
  const resultLines = lines.filter((line) => line.startsWith(resultMarker));
  assert.equal(resultLines.length, 1, "native fixture must emit exactly one result");
  const parsed = JSON.parse(resultLines[0]!.slice(resultMarker.length)) as unknown;
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  const result = parsed as FixtureResult;
  assert.equal(result.schema, "workbench-tray-icon-native-v1");
  assert.match(
    result.category,
    /^(?:native-tray-icon-(?:available|unavailable)|native-fixture-failed)$/u,
  );
  assert.equal(typeof result.passed, "boolean");
  return result;
}

async function removeProvedTemporaryRoot(root: string): Promise<void> {
  const information = await lstat(root);
  assert.equal(information.isDirectory(), true);
  assert.equal(information.isSymbolicLink(), false);
  const [resolvedRoot, resolvedTemporaryDirectory] = await Promise.all([
    realpath(root),
    realpath(resolve(tmpdir())),
  ]);
  assert.equal(
    resolvedRoot.toLocaleLowerCase("en-US"),
    resolve(root).toLocaleLowerCase("en-US"),
  );
  assert.equal(
    dirname(resolvedRoot).toLocaleLowerCase("en-US"),
    resolvedTemporaryDirectory.toLocaleLowerCase("en-US"),
  );
  assert.match(basename(resolvedRoot), temporaryRootPattern);
  await rm(resolvedRoot, { force: false, recursive: true });
}

async function run(): Promise<void> {
  const root = await mkdtemp(
    join(resolve(tmpdir()), "workbench-tray-icon-native-"),
  );
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const appData = join(home, "app-data");
  const localAppData = join(home, "local-app-data");
  const temp = join(home, "temp");
  await Promise.all(
    [userData, home, appData, localAppData, temp].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );

  const dataUrl = productionTrayIconDataUrl();
  const child = spawn(
    electronExecutable,
    [
      fixturePath,
      `--user-data-dir=${userData}`,
      `--tray-icon-data-url=${dataUrl}`,
    ],
    {
      cwd: repositoryRoot,
      env: isolatedElectronEnvironment({ home, appData, localAppData, temp }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const ownedPid = child.pid;
  assert.ok(ownedPid !== undefined && ownedPid > 0);
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.resume();

  const exitPromise = waitForChildExit(child);
  let exit = await waitWithTimeout(exitPromise, 10_000);
  let forcedExactChildTerminationRequested = false;
  if (exit === null) {
    assert.equal(child.pid, ownedPid);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    forcedExactChildTerminationRequested = true;
    child.kill();
    exit = await waitWithTimeout(exitPromise, 5_000);
  }
  const exactChildDeathProved =
    exit !== null &&
    child.pid === ownedPid &&
    (child.exitCode !== null || child.signalCode !== null);
  assert.equal(exactChildDeathProved, true, "exact Electron child survived probe");
  await removeProvedTemporaryRoot(root);

  const result = parseFixtureResult(stdout);
  const category =
    forcedExactChildTerminationRequested
      ? "forced-exact-child-termination-requested"
      : result.topLevelFailure === true
        ? "native-fixture-failed"
        : result.nativeImageEmpty !== false
          ? "native-image-empty"
          : result.trayConstructed !== true
            ? "tray-construction-failed"
            : result.passed !== true || exit?.code !== 0
              ? "native-fixture-verdict-failed"
              : "native-tray-icon-available";
  const observation = Object.freeze({
    category,
    nativeImageEmpty: result.nativeImageEmpty ?? null,
    nativeImageSize: result.nativeImageSize ?? null,
    pngBytes: result.pngBytes ?? null,
    trayConstructed: result.trayConstructed ?? null,
    exitCode: exit?.code ?? null,
    signalPresent: exit?.signal !== null,
    forcedExactChildTerminationRequested,
    exactChildDeathProved,
  });
  console.log(`${probeMarker}${JSON.stringify(observation)}`);

  assert.equal(category, "native-tray-icon-available");
}

run().catch(() => {
  console.error(
    `TRAY_ICON_NATIVE_PROBE_RED ${JSON.stringify({ category: "probe-runner-failed" })}`,
  );
  process.exitCode = 1;
});
