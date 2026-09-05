import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  clearConfiguredRuntimeExecutables,
  setConfiguredRuntimeExecutable,
} from "../../src/agent-runtime/configured-executable.ts";
import { discoverClaudeLaunch } from "../../src/agent-runtime/claude/process-transport.ts";
import type { WindowsRuntimeLaunch } from "../../src/agent-runtime/windows-executable-admission.ts";

// Public issue #2. A user runs the command the vendor's own README documents:
//
//     npm install -g @anthropic-ai/claude-code
//
// On Windows that writes NO .exe. It writes claude.cmd, claude.ps1 and an
// extensionless sh script into the npm prefix, and puts the code that actually
// runs at <prefix>\node_modules\@anthropic-ai\claude-code\<the package's bin
// entry>. `claude --version` works in their terminal; the Workbench said "No
// Agent Runtime is available".
//
// These fixtures are the real layout, not a mock of it: a real package.json
// with a real `bin` map, a real entry script, and a real node to run it. The
// point of the first test is that the runtime is STARTED, not merely located --
// a plan that resolves and then cannot spawn would be the same defect wearing a
// different error message.

const claudePackage = join("node_modules", "@anthropic-ai", "claude-code");

interface NpmGlobalFixture {
  readonly prefix: string;
  readonly entry: string;
}

/** The bytes npm actually lays down for a JS-entrypoint global install. */
async function npmGlobalInstall(
  register: (teardown: () => void) => void,
  options?: { readonly binEntry?: string },
): Promise<NpmGlobalFixture> {
  const root = await mkdtemp(join(tmpdir(), "uaw-npm-global-"));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });
  const prefix = join(root, "npm");
  const packageDirectory = join(prefix, claudePackage);
  await mkdir(packageDirectory, { recursive: true });

  const binEntry = options?.binEntry ?? "cli.js";
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@anthropic-ai/claude-code",
      version: "2.0.0",
      bin: { claude: binEntry },
    }),
  );
  const entry = join(packageDirectory, binEntry);
  await mkdir(dirname(entry), { recursive: true });
  // A real entry point, so "started" can be observed rather than asserted.
  await writeFile(
    entry,
    'process.stdout.write(`claude-code-fixture ${process.argv.slice(2).join(" ")}`);\n',
  );

  // The three shims npm writes. Not one of them is ever spawned; they exist so
  // the fixture is the layout a user really has.
  for (const shim of ["claude.cmd", "claude.ps1", "claude"]) {
    await writeFile(join(prefix, shim), "REM npm shim\n");
  }
  return { prefix, entry };
}

/**
 * Pin every location discovery consults. Without this the test answers
 * according to whatever the machine running it happens to have installed --
 * and ~/.local/bin/claude.exe is exactly where the native installer puts Claude
 * Code, i.e. on the box of the contributor most likely to be editing this file.
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
  // System32 keeps where.exe runnable; the node directory is what lets a
  // JavaScript entry point find an interpreter, exactly as npm's own shim does.
  process.env.PATH = [
    join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32"),
    dirname(process.execPath),
    ...extraPath,
  ].join(";");
}

async function startAndRead(
  launch: WindowsRuntimeLaunch,
  argument: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      launch.executable,
      [...launch.prefixArguments, argument],
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

test("an npm global install with a JavaScript entry point is discovered AND started", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  isolateDiscovery(
    (teardown) => t.after(teardown),
    join(fixture.prefix, "..", "home"),
    dirname(fixture.prefix),
  );

  const launch = await discoverClaudeLaunch();

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
    await startAndRead(launch, "--version"),
    "claude-code-fixture --version",
  );
});

test("an npm global install whose bin entry is a native binary is launched directly", async (t) => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "uaw-npm-native-"));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  const prefix = join(root, "npm");
  const packageDirectory = join(prefix, claudePackage);
  await mkdir(join(packageDirectory, "vendor"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ bin: { claude: "vendor/claude.exe" } }),
  );
  const binary = join(packageDirectory, "vendor", "claude.exe");
  await writeFile(binary, "");
  await writeFile(join(prefix, "claude.cmd"), "REM npm shim\n");
  isolateDiscovery((teardown) => t.after(teardown), join(root, "home"), root);

  assert.deepEqual(await discoverClaudeLaunch(), {
    executable: await realpath(binary),
    prefixArguments: [],
  });
});

test("one npm install found under several names on PATH is one runtime, not an ambiguity", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  // APPDATA points somewhere empty, so the ONLY way to this install is PATH --
  // where a bare-name lookup returns both `claude` and `claude.cmd`. Before the
  // fix a lookup asked for `claude.exe` and found neither.
  const empty = await mkdtemp(join(tmpdir(), "uaw-npm-empty-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  isolateDiscovery(
    (teardown) => t.after(teardown),
    join(empty, "home"),
    empty,
    [fixture.prefix],
  );

  const launch = await discoverClaudeLaunch();
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    await startAndRead(launch, "--help"),
    "claude-code-fixture --help",
  );
});

test("the executable path a user supplies rescues a machine discovery cannot serve", async (t) => {
  if (process.platform !== "win32") return;
  const fixture = await npmGlobalInstall((teardown) => t.after(teardown));
  // APPDATA and PATH point somewhere with no install at all, so the ONLY route
  // to the runtime is the answer the user gave. This is the escape hatch on its
  // own: it has to work when every automatic route has already failed.
  const empty = await mkdtemp(join(tmpdir(), "uaw-npm-none-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  isolateDiscovery((teardown) => t.after(teardown), join(empty, "home"), empty);

  await assert.rejects(
    () => discoverClaudeLaunch(),
    (error: unknown) =>
      error instanceof RuntimeAdapterError &&
      error.category === "runtime-not-located",
  );

  // The user names the shim they can actually see in Explorer.
  setConfiguredRuntimeExecutable("claude", join(fixture.prefix, "claude.cmd"));
  const launch = await discoverClaudeLaunch();
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    await startAndRead(launch, "--version"),
    "claude-code-fixture --version",
  );
});

test("a stored executable path that has stopped working never strands the user on it", async (t) => {
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
    "claude",
    join(fixture.prefix, "moved-away", "claude.cmd"),
  );
  const launch = await discoverClaudeLaunch();
  assert.deepEqual(launch.prefixArguments, [await realpath(fixture.entry)]);
  assert.equal(
    await startAndRead(launch, "--version"),
    "claude-code-fixture --version",
  );
});
