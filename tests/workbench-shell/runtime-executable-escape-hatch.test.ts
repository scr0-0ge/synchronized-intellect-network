import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL,
  WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL,
  WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL,
  defaultWorkbenchRuntimeExecutablePaths,
  type WorkbenchRuntimeExecutablePaths,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchRuntimeExecutableIpc,
  runtimeExecutableRejectionFor,
  type RuntimeExecutableBrowserWindowBoundary,
  type RuntimeExecutableIpcMainBoundary,
  type RuntimeExecutableRendererSender,
  type WorkbenchRuntimeExecutableSource,
} from "../../src/workbench-shell/electron/runtime-executable-ipc.ts";
import { createWorkbenchAppearancePreferenceStore } from "../../src/workbench-shell/appearance-preference-store.ts";
import { createWorkbenchPreloadBridge } from "../../src/workbench-shell/preload-bridge.ts";
import {
  clearConfiguredRuntimeExecutables,
  configuredRuntimeExecutable,
} from "../../src/agent-runtime/configured-executable.ts";
import { discoverClaudeLaunch } from "../../src/agent-runtime/claude/process-transport.ts";

// Public issue #2 finding 3: "There is no escape hatch. Settings has three
// sections and no executable-path field, no file picker, and no link."
//
// This exercises the hatch by USING it, end to end and in the product's own
// order: the renderer bridge shapes and sanitizes the request, the main-process
// handler admits the path, the durable store keeps it, discovery consults it,
// and the runtime it names actually starts. Nothing here is asserted from a
// description of the pipeline -- every hop is the real module.

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain implements RuntimeExecutableIpcMainBoundary {
  readonly handlers = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  async invoke(
    channel: string,
    sender: FakeSender,
    ...values: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("PRIVATE_MISSING_TEST_HANDLER");
    return handler({ sender }, ...values);
  }
}

class FakeSender implements RuntimeExecutableRendererSender {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
}

class FakeWindow implements RuntimeExecutableBrowserWindowBoundary {
  readonly webContents: FakeSender;
  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }
  on(): void {
    // no lifecycle listeners are needed for these cases
  }
  removeListener(): void {
    // no lifecycle listeners are needed for these cases
  }
}

/** The real durable store, on a real temporary file. */
function storeSource(filePath: string): WorkbenchRuntimeExecutableSource {
  const store = createWorkbenchAppearancePreferenceStore({ filePath });
  return Object.freeze({
    readRuntimeExecutables: () => store.readRuntimeExecutables(),
    saveRuntimeExecutables: (executables: WorkbenchRuntimeExecutablePaths) =>
      store.saveRuntimeExecutables(executables),
  });
}

/** The bytes an `npm install -g` really lays down for a JS-entrypoint package. */
async function npmGlobalInstall(
  register: (teardown: () => void) => void,
): Promise<{ readonly prefix: string; readonly entry: string }> {
  const root = await mkdtemp(join(tmpdir(), "uaw-hatch-"));
  register(() => {
    void rm(root, { recursive: true, force: true });
  });
  const prefix = join(root, "npm");
  const packageDirectory = join(
    prefix,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
  );
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ bin: { claude: "cli.js" } }),
  );
  const entry = join(packageDirectory, "cli.js");
  await writeFile(
    entry,
    'process.stdout.write(`started ${process.argv.slice(2).join(" ")}`);\n',
  );
  await writeFile(join(prefix, "claude.cmd"), "REM npm shim\n");
  return { prefix, entry };
}

function isolate(
  register: (teardown: () => void) => void,
  home: string,
  appData: string,
): void {
  const previous = new Map<string, string | undefined>([
    ["APPDATA", process.env.APPDATA],
    ["USERPROFILE", process.env.USERPROFILE],
    ["PATH", process.env.PATH],
  ]);
  register(() => {
    for (const [key, value] of previous) {
      // A captured undefined must be DELETED; assigning it back writes the
      // literal string "undefined" and poisons every later test here.
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearConfiguredRuntimeExecutables();
  });
  process.env.USERPROFILE = home;
  process.env.APPDATA = appData;
  process.env.PATH = [
    join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32"),
    dirname(process.execPath),
  ].join(";");
}

test("a path typed into Settings travels the real pipeline and starts the runtime", async (t) => {
  if (process.platform !== "win32") return;
  const install = await npmGlobalInstall((teardown) => t.after(teardown));
  const empty = await mkdtemp(join(tmpdir(), "uaw-hatch-empty-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  // Nothing is discoverable: no PATH entry, no npm prefix under APPDATA.
  isolate((teardown) => t.after(teardown), join(empty, "home"), empty);

  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const binding = installWorkbenchRuntimeExecutableIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source: storeSource(join(empty, "preferences.json")),
  });
  t.after(() => binding.dispose());

  // The renderer half: the real preload bridge, talking to the real handler.
  const bridge = createWorkbenchPreloadBridge({
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
    invoke: (channel: string, ...values: unknown[]) =>
      ipcMain.invoke(channel, sender, ...values),
  } as unknown as Parameters<typeof createWorkbenchPreloadBridge>[0]);

  assert.deepEqual(await bridge.loadRuntimeExecutables(), {
    ok: true,
    status: "loaded",
    executables: defaultWorkbenchRuntimeExecutablePaths,
  });

  // The user types the shim they can actually see and presses the button.
  const typed = join(install.prefix, "claude.cmd");
  const saved = await bridge.saveRuntimeExecutable({
    runtime: "claude",
    executablePath: typed,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.ok && saved.executables, {
    codex: "",
    claude: typed,
  });

  // It reached discovery...
  assert.equal(configuredRuntimeExecutable("claude"), typed);
  const launch = await discoverClaudeLaunch();
  assert.deepEqual(launch.prefixArguments, [await realpath(install.entry)]);

  // ...and the runtime it names really starts.
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      launch.executable,
      [...launch.prefixArguments, "--version"],
      { stdio: "pipe", windowsHide: true, shell: false },
    );
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      text += chunk;
    });
    child.once("error", reject);
    child.once("close", () => resolve(text));
  });
  assert.equal(output, "started --version");

  // It survives a restart: a second store over the same file reads it back.
  const reopened = storeSource(join(empty, "preferences.json"));
  assert.deepEqual(await reopened.readRuntimeExecutables(), {
    codex: "",
    claude: typed,
  });

  // And clearing it is never refused -- that is how a user undoes a bad answer.
  const cleared = await bridge.saveRuntimeExecutable({
    runtime: "claude",
    executablePath: "",
  });
  assert.equal(cleared.ok, true);
  assert.equal(configuredRuntimeExecutable("claude"), undefined);
});

test("a path that cannot start the runtime is refused with the reason, not stored", async (t) => {
  if (process.platform !== "win32") return;
  const empty = await mkdtemp(join(tmpdir(), "uaw-hatch-reject-"));
  t.after(() => {
    void rm(empty, { recursive: true, force: true });
  });
  isolate((teardown) => t.after(teardown), join(empty, "home"), empty);

  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const source = storeSource(join(empty, "preferences.json"));
  const binding = installWorkbenchRuntimeExecutableIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source,
  });
  t.after(() => binding.dispose());
  const bridge = createWorkbenchPreloadBridge({
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
    invoke: (channel: string, ...values: unknown[]) =>
      ipcMain.invoke(channel, sender, ...values),
  } as unknown as Parameters<typeof createWorkbenchPreloadBridge>[0]);

  const rows: readonly (readonly [string, string])[] = [
    [String.raw`claude.cmd`, "not-absolute"],
    [join(empty, "absent.cmd"), "not-found"],
    [empty, "not-a-file"],
  ];
  for (const [typed, reason] of rows) {
    const result = await bridge.saveRuntimeExecutable({
      runtime: "claude",
      executablePath: typed,
    });
    assert.equal(result.ok, false, `${typed} must be refused`);
    assert.deepEqual(
      !result.ok && result.error,
      {
        category: "runtime-executable-rejected",
        message: "That path cannot be used to start this runtime.",
        reason,
      },
      `${typed} must be refused as ${reason}`,
    );
  }

  // A refused path is never stored, and never reaches discovery.
  assert.deepEqual(await source.readRuntimeExecutables(), {
    codex: "",
    claude: "",
  });
  assert.equal(configuredRuntimeExecutable("claude"), undefined);
});

test("no rejection reason carries a filesystem path across the boundary [8 assertions]", () => {
  // The reason vocabulary is fixed and closed. This is what lets the failure
  // text be specific without transporting anything from the user's disk --
  // path-redaction.ts is a load-bearing privacy boundary in this product.
  const reasons = [
    "blank",
    "control-character",
    "too-long",
    "not-absolute",
    "not-a-native-executable-name",
    "missing",
    "not-a-regular-file",
    "symbolic-link",
    "unresolvable",
    "resolved-away-from-a-native-executable",
    "unsupported-shape",
    "package-manifest-unreadable",
    "package-manifest-declares-no-entry",
    "entry-escapes-its-package",
    "entry-missing",
    "unsupported-entry",
    "node-interpreter-not-located",
  ] as const;
  const admitted = new Set([
    "not-absolute",
    "not-found",
    "not-a-file",
    "unsupported-shape",
    "no-install-beside-it",
    "no-node-interpreter",
    "unusable",
  ]);
  for (const reason of reasons) {
    const mapped = runtimeExecutableRejectionFor(reason);
    assert.equal(
      admitted.has(mapped),
      true,
      `${reason} must map into the closed public vocabulary`,
    );
    assert.doesNotMatch(mapped, /[\\/:]|%[A-Z]/u, `${mapped} must carry no path`);
  }
  // Every public reason is reachable, so none is dead vocabulary the renderer
  // has wording for and can never show.
  assert.deepEqual(
    new Set(reasons.map(runtimeExecutableRejectionFor)),
    admitted,
  );
});

test("all three fixed channels are registered and released", () => {
  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const binding = installWorkbenchRuntimeExecutableIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source: Object.freeze({
      readRuntimeExecutables: async () => defaultWorkbenchRuntimeExecutablePaths,
      saveRuntimeExecutables: async (value: WorkbenchRuntimeExecutablePaths) =>
        value,
    }),
  });
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL,
    WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL,
    WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL,
  ].sort());
  binding.dispose();
  assert.deepEqual([...ipcMain.handlers.keys()], []);
});
