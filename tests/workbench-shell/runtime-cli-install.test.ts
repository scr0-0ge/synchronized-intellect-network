import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL,
  defaultWorkbenchRuntimeExecutablePaths,
  publicRuntimeExecutableUnavailable,
  publicRuntimeInstallFailed,
  publicRuntimeInstalled,
  type WorkbenchRuntimeExecutablePaths,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchRuntimeExecutableIpc,
  type RuntimeExecutableBrowserWindowBoundary,
  type RuntimeExecutableIpcMainBoundary,
  type RuntimeExecutableProvisioning,
  type RuntimeExecutableRendererSender,
} from "../../src/workbench-shell/electron/runtime-executable-ipc.ts";
import { createWorkbenchAppearancePreferenceStore } from "../../src/workbench-shell/appearance-preference-store.ts";
import { createWorkbenchPreloadBridge } from "../../src/workbench-shell/preload-bridge.ts";
import {
  sanitizeWorkbenchRuntimeInstallDetail,
  sanitizeWorkbenchRuntimeInstallResult,
} from "../../src/workbench-shell/result-sanitizer.ts";
import {
  isPrivateCliInstallPath,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  copyLocaleDictionaries,
  runtimeInstallCopy,
  runtimeInstallStepCopy,
} from "../../src/workbench-shell/renderer/copy/runtime-lookup-copy.ts";
import { setLocale } from "../../src/workbench-shell/renderer/locale.ts";
import type { CliProvisioningOutcome } from "../../src/agent-runtime/cli-provisioning.ts";

// The Settings button that installs a CLI into the product's private
// directory. The installer itself is exercised in
// tests/agent-runtime/cli-provisioning.test.ts; here the question is whether
// pressing the button reaches it through the real bridge and handler, whether
// what comes back is stored where the Save button stores, and whether npm's
// words cross the boundary without the user's paths in them.

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain implements RuntimeExecutableIpcMainBoundary {
  readonly handlers = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  async invoke(channel: string, sender: FakeSender, ...values: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("PRIVATE_MISSING_TEST_HANDLER");
    return handler({ sender }, ...values);
  }
}

class FakeSender implements RuntimeExecutableRendererSender {
  isDestroyed(): boolean {
    return false;
  }
  on(): void {}
  removeListener(): void {}
}

class FakeWindow implements RuntimeExecutableBrowserWindowBoundary {
  readonly webContents: FakeSender;
  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }
  on(): void {}
  removeListener(): void {}
}

const privateShim = String.raw`C:\Users\someone\AppData\Local\synchronized-intellect-network\runtime\cli\claude\claude.cmd`;

function installedOutcome(runtime: "claude" | "codex"): CliProvisioningOutcome {
  return Object.freeze({
    kind: "installed",
    runtime,
    version: "2.1.268",
    directory: join(privateShim, ".."),
    configuredPath: privateShim,
    launch: Object.freeze({ executable: "C:\\x\\claude.exe", prefixArguments: Object.freeze([]) }),
    registry: "https://registry.npmjs.org/",
  });
}

async function harness(
  t: { after(fn: () => void): void },
  provision: RuntimeExecutableProvisioning,
) {
  const root = await mkdtemp(join(tmpdir(), "uaw-cli-install-"));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  const store = createWorkbenchAppearancePreferenceStore({ filePath: join(root, "preferences.json") });
  const published: string[] = [];
  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const binding = installWorkbenchRuntimeExecutableIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source: Object.freeze({
      readRuntimeExecutables: () => store.readRuntimeExecutables(),
      saveRuntimeExecutables: (executables: WorkbenchRuntimeExecutablePaths) =>
        store.saveRuntimeExecutables(executables),
    }),
    provision,
    publish: (runtime, value) => published.push(`${runtime}=${value ?? ""}`),
  });
  t.after(() => binding.dispose());
  const bridge = createWorkbenchPreloadBridge({
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
    invoke: (channel: string, ...values: unknown[]) => ipcMain.invoke(channel, sender, ...values),
  } as unknown as Parameters<typeof createWorkbenchPreloadBridge>[0]);
  return { bridge, store, published, ipcMain };
}

test("pressing Install reaches the installer through the real bridge and stores what it produced", async (t) => {
  const asked: string[] = [];
  const { bridge, store, published } = await harness(t, async (runtime, publish) => {
    asked.push(runtime);
    publish(runtime, privateShim);
    return installedOutcome(runtime);
  });

  const result = await bridge.installRuntimeExecutable!({ runtime: "claude" });
  assert.deepEqual(result, {
    ok: true,
    status: "installed",
    runtime: "claude",
    version: "2.1.268",
    executables: { codex: "", claude: privateShim },
  });
  assert.deepEqual(asked, ["claude"]);
  // The escape hatch was published exactly as the Save button would have.
  assert.deepEqual(published, [`claude=${privateShim}`]);
  // And the durable store now carries the path -- a restart reads it back.
  assert.deepEqual(await store.readRuntimeExecutables(), { codex: "", claude: privateShim });
  // The renderer recognises that path as the product's own install.
  assert.equal(isPrivateCliInstallPath(privateShim), true);
  assert.equal(isPrivateCliInstallPath(String.raw`C:\Users\someone\AppData\Roaming\npm\claude.cmd`), false);
});

test("a failed install names its step and carries npm's words with every path redacted; nothing is stored", async (t) => {
  const { bridge, store, published } = await harness(t, async (runtime) =>
    Object.freeze({
      kind: "failed",
      runtime,
      step: "install-failed",
      detail:
        "npm error code ECONNRESET\nnpm error path C:\\Users\\someone\\AppData\\Local\\synchronized-intellect-network\\runtime\\cli\\codex\nnpm error network",
      directory: "C:\\Users\\someone\\x",
      registry: "https://registry.npmjs.org/",
    }),
  );

  const result = await bridge.installRuntimeExecutable!({ runtime: "codex" });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error.category === "runtime-install-failed");
  assert.equal(result.error.step, "install-failed");
  assert.match(result.error.detail, /ECONNRESET/u);
  assert.doesNotMatch(result.error.detail, /someone/u);
  assert.doesNotMatch(result.error.detail, /[A-Z]:\\/u);
  assert.match(result.error.detail, /\[path\]/u);
  assert.deepEqual(published, []);
  assert.deepEqual(await store.readRuntimeExecutables(), defaultWorkbenchRuntimeExecutablePaths);
});

test("a second press while npm is still running is refused rather than started twice", async (t) => {
  let release: (() => void) | undefined;
  let starts = 0;
  const { bridge } = await harness(t, async (runtime, publish) => {
    starts += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    publish(runtime, privateShim);
    return installedOutcome(runtime);
  });

  const first = bridge.installRuntimeExecutable!({ runtime: "claude" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await bridge.installRuntimeExecutable!({ runtime: "claude" });
  assert.deepEqual(second, publicRuntimeExecutableUnavailable());
  release!();
  assert.equal((await first).ok, true);
  assert.equal(starts, 1);
});

test("the install result sanitizer accepts only the two public shapes and bounds the detail", () => {
  const installed = publicRuntimeInstalled("codex", "0.154.0", { codex: privateShim, claude: "" });
  assert.deepEqual(sanitizeWorkbenchRuntimeInstallResult(installed), installed);

  const failed = publicRuntimeInstallFailed("not-discovered", "x".repeat(5000));
  const sanitizedFailure = sanitizeWorkbenchRuntimeInstallResult(failed);
  assert.ok(!sanitizedFailure.ok && sanitizedFailure.error.category === "runtime-install-failed");
  assert.equal(sanitizedFailure.error.detail.length, 2048);

  // An unknown step, a stray key, or a version that is not text all fail closed.
  assert.deepEqual(
    sanitizeWorkbenchRuntimeInstallResult({ ...failed, error: { ...failed.error, step: "cosmic-rays" } }),
    publicRuntimeExecutableUnavailable(),
  );
  assert.deepEqual(
    sanitizeWorkbenchRuntimeInstallResult({ ...installed, extra: 1 }),
    publicRuntimeExecutableUnavailable(),
  );
  assert.deepEqual(
    sanitizeWorkbenchRuntimeInstallResult({ ...installed, version: "2.1\u0000" }),
    publicRuntimeExecutableUnavailable(),
  );
  assert.deepEqual(sanitizeWorkbenchRuntimeInstallResult(undefined), publicRuntimeExecutableUnavailable());

  // Tabs and newlines survive (npm's output is lines); other controls do not.
  assert.equal(sanitizeWorkbenchRuntimeInstallDetail("a\r\nb\tc\u0007d"), "a \nb\tc d");
  assert.equal(sanitizeWorkbenchRuntimeInstallDetail(42), "");
});

test("every install sentence exists in both locales and the mirror hint names a registry", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    setLocale(locale);
    const copy = copyLocaleDictionaries[locale].runtimeInstallCopy;
    assert.equal(runtimeInstallCopy.installActionClaude, copy.installActionClaude);
    assert.match(runtimeInstallCopy.installingSentence(7), /7/u);
    assert.match(runtimeInstallCopy.installedSentence("2.1.268"), /2\.1\.268/u);
    assert.match(runtimeInstallStepCopy("install-failed"), /NPM_CONFIG_REGISTRY/u);
    assert.match(runtimeInstallStepCopy("install-failed"), /registry\.npmmirror\.com/u);
    for (const step of ["node-not-located", "npm-not-located", "not-discovered"] as const) {
      assert.ok(runtimeInstallStepCopy(step).length > 0);
    }
  }
  setLocale("en");
});

test("the install channel is the one the bridge invokes", () => {
  assert.equal(WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL, "workbench:install-runtime-executable");
});
