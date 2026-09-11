import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  cliInstallDirectory,
  DEFAULT_NPM_REGISTRY,
  npmRegistryFor,
  provisionRuntimeCli,
  type CliInstallRun,
} from "../../src/agent-runtime/cli-provisioning.ts";
import {
  clearConfiguredRuntimeExecutables,
  configuredRuntimeExecutable,
  type ConfigurableRuntime,
} from "../../src/agent-runtime/configured-executable.ts";
import type { WindowsRuntimeLaunch } from "../../src/agent-runtime/windows-executable-admission.ts";

// The installer runs the real npm on a user's machine; here npm is replaced by
// a function that lays down the bytes `npm install -g --prefix <dir>` really
// writes on Windows (verified 2026-09-11 against @anthropic-ai/claude-code
// 2.1.268 and @openai/codex 0.154.0), so that everything AFTER npm -- the
// version read-back, the interpreter beside the shim, the escape-hatch handoff
// and the product's own discovery -- runs against real admission on real
// files. What is not exercised here is the download itself; the evidence
// probe for w192 does that once, against the registry, into a temp root.

interface Fixture {
  readonly root: string;
  readonly nodeDirectory: string;
  readonly nodeExecutable: string;
  readonly installRoot: string;
}

async function fixture(register: (teardown: () => void) => void): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "uaw-cli-provision-")));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });
  // start.bat's private node: node.exe with npm beside it, exactly as the
  // official zip lays it out.
  const nodeDirectory = join(root, "node", "bin");
  await mkdir(join(nodeDirectory, "node_modules", "npm", "bin"), { recursive: true });
  const nodeExecutable = join(nodeDirectory, "node.exe");
  await writeFile(nodeExecutable, "MZ node fixture\n");
  await writeFile(join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"), "// npm\n");
  return {
    root,
    nodeDirectory,
    nodeExecutable,
    installRoot: join(root, "cli"),
  };
}

/** What npm leaves behind for `-g --prefix <prefix>` of each package. */
async function layDownNpmGlobal(
  prefix: string,
  runtime: ConfigurableRuntime,
  version: string,
): Promise<void> {
  const packageName = runtime === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
  const binEntry = runtime === "claude" ? "bin/claude.exe" : "bin/codex.js";
  const packageDirectory = join(prefix, "node_modules", ...packageName.split("/"));
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: packageName, version, bin: { [runtime]: binEntry } }),
  );
  await writeFile(
    join(packageDirectory, binEntry),
    runtime === "claude" ? "MZ claude fixture\n" : "process.stdout.write('codex');\n",
  );
  for (const shim of [`${runtime}.cmd`, `${runtime}.ps1`, runtime]) {
    await writeFile(join(prefix, shim), "REM npm shim\n");
  }
}

interface RecordedInstall {
  readonly node: string;
  readonly arguments: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function fakeNpm(
  behaviour: (prefix: string) => Promise<CliInstallRun>,
  record: RecordedInstall[],
) {
  return async (
    node: string,
    arguments_: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv },
  ): Promise<CliInstallRun> => {
    record.push({ node, arguments: arguments_, env: options.env });
    const prefix = arguments_[arguments_.indexOf("--prefix") + 1]!;
    return behaviour(prefix);
  };
}

/**
 * PATH is pinned so `node.exe` cannot be found on whatever the running
 * machine has, and the configured registry is cleared afterwards: the
 * installer publishes into process-wide state.
 */
function pinEnvironment(register: (teardown: () => void) => void): void {
  const previousPath = process.env.PATH;
  register(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    clearConfiguredRuntimeExecutables();
  });
  process.env.PATH = join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32");
}

test("a Claude install is published to the escape hatch and confirmed by the product's own discovery", async (t) => {
  if (process.platform !== "win32") return;
  pinEnvironment((teardown) => t.after(teardown));
  const f = await fixture((teardown) => t.after(teardown));
  const installs: RecordedInstall[] = [];

  const outcome = await provisionRuntimeCli("claude", {
    installRoot: f.installRoot,
    privateNodeDirectory: f.nodeDirectory,
    environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    runInstall: fakeNpm(async (prefix) => {
      await layDownNpmGlobal(prefix, "claude", "2.1.268");
      return { exitCode: 0, outputTail: "added 2 packages" };
    }, installs),
  });

  assert.equal(outcome.kind, "installed");
  assert.equal(outcome.kind === "installed" && outcome.version, "2.1.268");
  const directory = cliInstallDirectory("claude", f.installRoot);
  assert.equal(outcome.directory, directory);
  assert.equal(outcome.registry, DEFAULT_NPM_REGISTRY);

  // npm was asked for exactly the documented install, into the private
  // directory, with the interpreter that runs it on the child's PATH.
  assert.equal(installs.length, 1);
  assert.equal(installs[0]!.node, f.nodeExecutable);
  assert.deepEqual(installs[0]!.arguments.slice(0, 6), [
    join(f.nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    "install",
    "-g",
    "--prefix",
    directory,
    "@anthropic-ai/claude-code@latest",
  ]);
  assert.ok(installs[0]!.env.PATH!.startsWith(`${f.nodeDirectory};`));

  // The shim is what the escape hatch holds; discovery resolved it
  // STRUCTURALLY to the vendor binary inside the private directory.
  assert.equal(configuredRuntimeExecutable("claude"), join(directory, "claude.cmd"));
  assert.ok(outcome.kind === "installed");
  assert.equal(
    outcome.launch.executable.toLowerCase(),
    join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe").toLowerCase(),
  );
  assert.deepEqual(outcome.launch.prefixArguments, []);
  // The interpreter that ran the install now sits beside the shim.
  assert.ok((await stat(join(directory, "node.exe"))).isFile());
});

test("a Codex install resolves to the node placed beside the shim running the package's JavaScript entry", async (t) => {
  if (process.platform !== "win32") return;
  pinEnvironment((teardown) => t.after(teardown));
  const f = await fixture((teardown) => t.after(teardown));

  const outcome = await provisionRuntimeCli("codex", {
    installRoot: f.installRoot,
    privateNodeDirectory: f.nodeDirectory,
    environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    runInstall: fakeNpm(async (prefix) => {
      await layDownNpmGlobal(prefix, "codex", "0.154.0");
      return { exitCode: 0, outputTail: "" };
    }, []),
  });

  assert.equal(outcome.kind, "installed");
  assert.ok(outcome.kind === "installed");
  assert.equal(outcome.version, "0.154.0");
  const directory = cliInstallDirectory("codex", f.installRoot);
  assert.equal(configuredRuntimeExecutable("codex"), join(directory, "codex.cmd"));
  assert.equal(outcome.launch.executable.toLowerCase(), join(directory, "node.exe").toLowerCase());
  assert.deepEqual(
    outcome.launch.prefixArguments.map((value) => value.toLowerCase()),
    [join(directory, "node_modules", "@openai", "codex", "bin", "codex.js").toLowerCase()],
  );
});

test("npm exiting 0 without leaving the package is a failure, not an install", async (t) => {
  if (process.platform !== "win32") return;
  pinEnvironment((teardown) => t.after(teardown));
  const f = await fixture((teardown) => t.after(teardown));

  const outcome = await provisionRuntimeCli("claude", {
    installRoot: f.installRoot,
    privateNodeDirectory: f.nodeDirectory,
    environment: { PATH: process.env.PATH },
    runInstall: fakeNpm(async (prefix) => {
      await mkdir(prefix, { recursive: true });
      return { exitCode: 0, outputTail: "" };
    }, []),
  });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.step, "install-failed");
  assert.equal(configuredRuntimeExecutable("claude"), undefined);
});

test("a failed npm run names the step and carries npm's own last words; nothing is published", async (t) => {
  if (process.platform !== "win32") return;
  pinEnvironment((teardown) => t.after(teardown));
  const f = await fixture((teardown) => t.after(teardown));

  const outcome = await provisionRuntimeCli("codex", {
    installRoot: f.installRoot,
    privateNodeDirectory: f.nodeDirectory,
    environment: {
      PATH: process.env.PATH,
      NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
    },
    runInstall: fakeNpm(
      async () => ({ exitCode: 1, outputTail: "npm error code ECONNRESET\nnpm error network" }),
      [],
    ),
  });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.step, "install-failed");
  assert.match(outcome.detail, /ECONNRESET/u);
  assert.equal(outcome.registry, "https://registry.npmmirror.com");
  assert.equal(configuredRuntimeExecutable("codex"), undefined);
});

test("an install the product's discovery does not resolve to is reported as not discovered", async (t) => {
  if (process.platform !== "win32") return;
  pinEnvironment((teardown) => t.after(teardown));
  const f = await fixture((teardown) => t.after(teardown));
  const elsewhere: WindowsRuntimeLaunch = Object.freeze({
    executable: join(f.root, "somewhere-else", "claude.exe"),
    prefixArguments: Object.freeze([]),
  });

  const outcome = await provisionRuntimeCli("claude", {
    installRoot: f.installRoot,
    privateNodeDirectory: f.nodeDirectory,
    environment: { PATH: process.env.PATH },
    runInstall: fakeNpm(async (prefix) => {
      await layDownNpmGlobal(prefix, "claude", "2.1.268");
      return { exitCode: 0, outputTail: "" };
    }, []),
    discover: async () => elsewhere,
  });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.step, "not-discovered");
});

test("without a node the installer stops at the first step and says so", async (t) => {
  if (process.platform !== "win32") return;
  pinEnvironment((teardown) => t.after(teardown));
  const f = await fixture((teardown) => t.after(teardown));
  let npmRan = false;

  const outcome = await provisionRuntimeCli("claude", {
    installRoot: f.installRoot,
    privateNodeDirectory: join(f.root, "no-node-here"),
    environment: { PATH: process.env.PATH },
    runInstall: async () => {
      npmRan = true;
      return { exitCode: 0, outputTail: "" };
    },
  });

  assert.equal(outcome.kind, "failed");
  assert.ok(outcome.kind === "failed");
  assert.equal(outcome.step, "node-not-located");
  assert.equal(npmRan, false);
});

test("the registry is npm's default unless NPM_CONFIG_REGISTRY says otherwise", () => {
  assert.equal(npmRegistryFor({}), DEFAULT_NPM_REGISTRY);
  assert.equal(npmRegistryFor({ NPM_CONFIG_REGISTRY: " " }), DEFAULT_NPM_REGISTRY);
  assert.equal(
    npmRegistryFor({ NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com" }),
    "https://registry.npmmirror.com",
  );
  assert.equal(dirname(cliInstallDirectory("codex", "C:\\root")), "C:\\root");
});
