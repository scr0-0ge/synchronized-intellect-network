import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  clearConfiguredRuntimeExecutables,
  setConfiguredRuntimeExecutable,
} from "../../src/agent-runtime/configured-executable.ts";
import {
  createProductionCodexExecutableDiscovery,
  type CodexExecutableDiscoveryResult,
  type CodexExecutableHandle,
} from "../../src/agent-runtime/codex/executable-discovery.ts";
import type { WindowsRuntimeLaunch } from "../../src/agent-runtime/windows-executable-admission.ts";

// Public issue #2, the Codex half. A user runs the command that project's own
// README documents:
//
//     npm install -g @openai/codex
//
// On Windows that writes NO .exe. It writes codex.cmd, codex.ps1 and an
// extensionless sh script into the npm prefix, and puts the code that actually
// runs at <prefix>\node_modules\@openai\codex\<the package's bin entry>.
// `codex --version` works in their terminal; the Workbench said "No Agent
// Runtime is available", because discovery asked `where.exe` for the literal
// `codex.exe` -- and given an explicit extension `where.exe` does not consult
// PATHEXT, so not one of the three shims npm wrote was visible to it.
//
// These fixtures are the real layout rather than a mock of it: a real
// package.json with a real `bin` map, a real entry script, and a real node to
// run it. The claim the first test makes is STARTED, not located -- a plan that
// resolves and then cannot spawn would be the same defect wearing a different
// error message.

const codexPackage = join("node_modules", "@openai", "codex");

interface NpmGlobalFixture {
  readonly prefix: string;
  readonly entry: string;
  readonly marker: string;
}

interface Discovery {
  readonly result: CodexExecutableDiscoveryResult;
  readonly launches: readonly WindowsRuntimeLaunch[];
}

/** The bytes npm actually lays down for a JS-entrypoint global install. */
async function npmGlobalInstall(
  register: (teardown: () => void) => void,
  options?: { readonly binEntry?: string; readonly marker?: string },
): Promise<NpmGlobalFixture> {
  const marker = options?.marker ?? "codex-fixture";
  const root = await mkdtemp(join(tmpdir(), "uaw-codex-npm-"));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });
  const prefix = join(root, "npm");
  const packageDirectory = join(prefix, codexPackage);
  await mkdir(packageDirectory, { recursive: true });

  const binEntry = options?.binEntry ?? "bin/codex.js";
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.50.0",
      bin: { codex: binEntry },
    }),
  );
  const entry = join(packageDirectory, binEntry);
  await mkdir(dirname(entry), { recursive: true });
  // A real entry point, so "started" can be observed rather than asserted.
  await writeFile(
    entry,
    `process.stdout.write(\`${marker} \${process.argv.slice(2).join(" ")}\`);\n`,
  );

  // The three shims npm writes. Not one of them is ever spawned; they exist so
  // the fixture is the layout a user really has.
  for (const shim of ["codex.cmd", "codex.ps1", "codex"]) {
    await writeFile(join(prefix, shim), "REM npm shim\n");
  }
  return { prefix, entry, marker };
}

/**
 * Pin every location discovery consults. Without this the test answers
 * according to whatever the machine running it happens to have installed --
 * and %LOCALAPPDATA%\OpenAI\Codex\bin is exactly where the official installer
 * puts Codex, i.e. on the box of the contributor most likely to be editing
 * this file.
 *
 * A captured `undefined` is DELETED rather than assigned back: assigning it
 * would set the literal string "undefined" and poison every later test in this
 * process.
 */
function isolateDiscovery(
  register: (teardown: () => void) => void,
  home: string,
  appData: string,
  extraPath: readonly string[] = [],
): void {
  const previous = new Map<string, string | undefined>([
    ["APPDATA", process.env.APPDATA],
    ["LOCALAPPDATA", process.env.LOCALAPPDATA],
    ["USERPROFILE", process.env.USERPROFILE],
    ["PATH", process.env.PATH],
  ]);
  register(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearConfiguredRuntimeExecutables();
  });
  process.env.USERPROFILE = home;
  process.env.APPDATA = appData;
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  // System32 keeps where.exe runnable; the node directory is what lets a
  // JavaScript entry point find an interpreter, exactly as npm's own shim does.
  process.env.PATH = [
    join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32"),
    dirname(process.execPath),
    ...extraPath,
  ].join(";");
}

async function discover(): Promise<Discovery> {
  const launches: WindowsRuntimeLaunch[] = [];
  const run = createProductionCodexExecutableDiscovery(
    (launch: WindowsRuntimeLaunch) => {
      launches.push(launch);
      return Object.freeze({}) as CodexExecutableHandle;
    },
  );
  return { result: await run(), launches };
}

/**
 * The handle stays opaque. A located result carries a branded empty object and
 * nothing else, so no resolved path crosses back to a caller -- the property
 * `runtime-discovery.test.ts` has always asserted, restated here because this
 * file is where the plan now has a second field to leak.
 */
function locatedLaunch(discovery: Discovery, path: string): WindowsRuntimeLaunch {
  assert.equal(discovery.result.kind, "located");
  assert.equal(discovery.launches.length, 1);
  if (discovery.result.kind !== "located") throw new Error("unreachable");
  assert.deepEqual(Object.keys(discovery.result.executable), []);
  assert.equal(JSON.stringify(discovery.result).includes(path), false);
  return discovery.launches[0] as WindowsRuntimeLaunch;
}

async function startAndRead(
  launch: WindowsRuntimeLaunch,
  ...args: readonly string[]
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      launch.executable,
      [...launch.prefixArguments, ...args],
      // The same options shape the product uses. No shell, argv is an array.
      { stdio: "pipe", windowsHide: true, shell: false },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", () => resolve(output));
  });
}

test("a Codex npm global install with a JavaScript entry point is discovered AND started", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  isolateDiscovery(
    (teardown) => t.after(teardown),
    join(fixture.prefix, "..", "home"),
    dirname(fixture.prefix),
  );

  const launch = locatedLaunch(await discover(), fixture.entry);

  // argv[0] is a real node.exe; the vendor's entry script is argv[1]. Nothing
  // named .cmd, .ps1 or extensionless survives into the plan, so no shell is
  // needed to run it and none is used.
  assert.equal(launch.executable, await realpath(process.execPath));
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    /\.(?:cmd|ps1|bat)$/iu.test(JSON.stringify(launch)),
    false,
    "a shim must never appear in a launch plan",
  );

  // Located is not the claim. Started is.
  assert.equal(
    await startAndRead(launch, "app-server", "--stdio"),
    `${fixture.marker} app-server --stdio`,
  );
});

test("a Codex npm global install whose bin entry is a native binary becomes a native plan", async (t) => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "uaw-codex-native-"));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  const prefix = join(root, "npm");
  const packageDirectory = join(prefix, codexPackage);
  await mkdir(join(packageDirectory, "vendor"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ bin: { codex: "vendor/codex.exe" } }),
  );
  const binary = join(packageDirectory, "vendor", "codex.exe");
  await writeFile(binary, "");
  await writeFile(join(prefix, "codex.cmd"), "REM npm shim\n");
  isolateDiscovery((teardown) => t.after(teardown), join(root, "home"), root);

  assert.deepEqual(locatedLaunch(await discover(), binary), {
    executable: await realpath(binary),
    prefixArguments: [],
  });
});

test("one Codex install found under several names on PATH is one runtime, not an ambiguity", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  // APPDATA points somewhere empty, so the ONLY way to this install is PATH --
  // where a bare-name lookup returns both `codex` and `codex.cmd`. Those two
  // are one install: dedupe by candidate string and the pre-existing "more than
  // one candidate means ambiguous" rule would now fire on every npm install.
  const empty = await mkdtemp(join(tmpdir(), "uaw-codex-empty-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  isolateDiscovery(
    (teardown) => t.after(teardown),
    join(empty, "home"),
    empty,
    [fixture.prefix],
  );

  const launch = locatedLaunch(await discover(), fixture.entry);
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    await startAndRead(launch, "--version"),
    `${fixture.marker} --version`,
  );
});

test("two genuinely different Codex installs on PATH are still ambiguous", async (t) => {
  if (process.platform !== "win32") return;
  const first = await npmGlobalInstall((teardown) => t.after(teardown), {
    marker: "codex-fixture-one",
  });
  const second = await npmGlobalInstall((teardown) => t.after(teardown), {
    marker: "codex-fixture-two",
  });
  const empty = await mkdtemp(join(tmpdir(), "uaw-codex-two-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  isolateDiscovery(
    (teardown) => t.after(teardown),
    join(empty, "home"),
    empty,
    [first.prefix, second.prefix],
  );

  // Deduplicating by resolved launch plan must not cost the fail-closed rule:
  // two installs really are two answers and the product must not pick one.
  const discovery = await discover();
  assert.deepEqual(discovery.result, { kind: "ambiguous" });
  assert.deepEqual(discovery.launches, []);
});

test("the Codex executable path a user supplies rescues a machine discovery cannot serve", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  // APPDATA and PATH point somewhere with no install at all, so the ONLY route
  // to the runtime is the answer the user gave. This is the escape hatch on its
  // own: it has to work when every automatic route has already failed.
  const empty = await mkdtemp(join(tmpdir(), "uaw-codex-none-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  isolateDiscovery((teardown) => t.after(teardown), join(empty, "home"), empty);

  assert.deepEqual((await discover()).result, { kind: "not-located" });

  // The user names the shim they can actually see in Explorer.
  setConfiguredRuntimeExecutable("codex", join(fixture.prefix, "codex.cmd"));
  const launch = locatedLaunch(await discover(), fixture.entry);
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    await startAndRead(launch, "--version"),
    `${fixture.marker} --version`,
  );
});

test("a stored Codex path that has stopped working never strands the user on it", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  isolateDiscovery(
    (teardown) => t.after(teardown),
    join(fixture.prefix, "..", "home"),
    dirname(fixture.prefix),
  );

  // An answer that was right once and is now wrong -- the install moved, the
  // drive was remapped. Discovery must carry on past it and find the runtime
  // that IS there, rather than failing on the user's own stale input.
  setConfiguredRuntimeExecutable(
    "codex",
    join(fixture.prefix, "moved-away", "codex.cmd"),
  );
  const launch = locatedLaunch(await discover(), fixture.entry);
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    await startAndRead(launch, "--version"),
    `${fixture.marker} --version`,
  );
});
