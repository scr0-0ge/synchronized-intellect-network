import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createCliUpdateService } from "../../src/workbench-shell/cli-update-check.ts";
import { installWorkbenchCliUpdateIpc } from "../../src/workbench-shell/cli-update-ipc.ts";
import { createWorkbenchLifecycleController } from "../../src/workbench-shell/electron/lifecycle.ts";
import {
  WORKBENCH_CHECK_CLI_UPDATES_CHANNEL,
  WORKBENCH_RELAUNCH_APP_CHANNEL,
  WORKBENCH_RUN_CLI_UPDATE_CHANNEL,
  publicCliUpdateCheckCompleted,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRelaunchQueued,
  publicCliUpdateRelaunchUnavailable,
  publicCliUpdateRunFailed,
  publicCliUpdateRunUnavailable,
  publicCliUpdateRunUpdated,
} from "../../src/workbench-shell/cli-update-contract.ts";
import {
  reconstructWorkbenchCliUpdateRunRequest,
  sanitizeWorkbenchCliUpdateCheckResult,
  sanitizeWorkbenchCliUpdateRelaunchResult,
  sanitizeWorkbenchCliUpdateRunResult,
} from "../../src/workbench-shell/cli-update-sanitizer.ts";

/**
 * Ticket 18 IPC surface on the lane's parameterized binding pattern, plus
 * the fail-closed sanitizer matrix. Every service double is a fake — no
 * real winget or update command is ever spawned from tests.
 */

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain {
  readonly handlers = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

class FakeSender {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(): void {}
  removeListener(): void {}
}

class FakeWindow {
  readonly webContents = new FakeSender();
  on(): void {}
  removeListener(): void {}
}

const claudeUpdateAvailable = Object.freeze({
  cliId: "claude-code" as const,
  status: "update-available" as const,
  currentVersion: "2.1.220",
  availableVersion: "2.1.258",
});
const codexNoCheck = Object.freeze({
  cliId: "codex" as const,
  status: "no-check" as const,
});

test("the CLI update IPC serves the memoized check and only the requested run, and fails closed otherwise", async () => {
  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  const calls: string[] = [];
  const binding = installWorkbenchCliUpdateIpc({
    ipcMain: ipc,
    window,
    service: {
      async check() {
        calls.push("check");
        return [claudeUpdateAvailable, codexNoCheck];
      },
      async run(cliId) {
        calls.push(`run:${cliId}`);
        return publicCliUpdateRunUpdated(cliId);
      },
    },
    requestRelaunch: () => calls.push("relaunch"),
  });
  assert.ok(ipc.handlers.has(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL));
  assert.ok(ipc.handlers.has(WORKBENCH_RUN_CLI_UPDATE_CHANNEL));
  assert.ok(ipc.handlers.has(WORKBENCH_RELAUNCH_APP_CHANNEL));

  const event = { sender: window.webContents };
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL)!(event),
    publicCliUpdateCheckCompleted([claudeUpdateAvailable, codexNoCheck]),
  );
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RUN_CLI_UPDATE_CHANNEL)!(event, "codex"),
    publicCliUpdateRunUpdated("codex"),
  );
  assert.deepEqual(calls, ["check", "run:codex"]);

  // The relaunch action (ticket 21 cleanup): owned sender gets `queued`
  // and the main-process callback runs after the reply is produced.
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RELAUNCH_APP_CHANNEL)!(event),
    publicCliUpdateRelaunchQueued(),
  );
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(calls, ["check", "run:codex", "relaunch"]);

  // Foreign senders and malformed requests collapse to the fixed
  // unavailable results — never to an exception across the boundary.
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL)!({
      sender: new FakeSender(),
    }),
    publicCliUpdateCheckUnavailable(),
  );
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RUN_CLI_UPDATE_CHANNEL)!(
      event,
      "not-a-cli",
    ),
    publicCliUpdateRunUnavailable(),
  );
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RUN_CLI_UPDATE_CHANNEL)!(
      event,
      { cliId: "claude-code" },
    ),
    publicCliUpdateRunUnavailable(),
  );
  // A foreign sender never triggers a relaunch.
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RELAUNCH_APP_CHANNEL)!({
      sender: new FakeSender(),
    }),
    publicCliUpdateRelaunchUnavailable(),
  );
  // A throwing service degrades to unavailable, not to a crash.
  const throwingBinding = installWorkbenchCliUpdateIpc({
    ipcMain: ipc,
    window,
    service: {
      async check() {
        throw new Error("boom");
      },
      async run() {
        throw new Error("boom");
      },
    },
    requestRelaunch: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL)!(event),
    publicCliUpdateCheckUnavailable(),
  );
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RUN_CLI_UPDATE_CHANNEL)!(
      event,
      "claude-code",
    ),
    publicCliUpdateRunUnavailable(),
  );
  // A relaunch callback that throws after the reply is contained: the
  // handler still answers `queued` and the throw never crashes the loop.
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RELAUNCH_APP_CHANNEL)!(event),
    publicCliUpdateRelaunchQueued(),
  );
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  throwingBinding.dispose();

  binding.dispose();
  assert.equal(ipc.handlers.has(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL), false);
  assert.equal(ipc.handlers.has(WORKBENCH_RUN_CLI_UPDATE_CHANNEL), false);
  assert.equal(ipc.handlers.has(WORKBENCH_RELAUNCH_APP_CHANNEL), false);
});

test("the relaunch sanitizer accepts only the exact queued shape and fails closed otherwise", () => {
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRelaunchResult(publicCliUpdateRelaunchQueued()),
    publicCliUpdateRelaunchQueued(),
  );
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRelaunchResult(publicCliUpdateRelaunchUnavailable()),
    publicCliUpdateRelaunchUnavailable(),
  );
  for (const hostile of [
    null,
    42,
    { ok: true, status: "queued", extra: true },
    { ok: true, status: "started" },
    { ok: false, error: { category: "relaunch-unavailable" } },
    { ok: false, error: { category: "some-other-category", message: "x" } },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchCliUpdateRelaunchResult(hostile),
      publicCliUpdateRelaunchUnavailable(),
      `expected rejection for ${JSON.stringify(hostile)}`,
    );
  }
});

test("the run request reconstruction accepts only the two CLI ids", () => {
  assert.deepEqual(reconstructWorkbenchCliUpdateRunRequest("codex"), {
    ok: true,
    value: "codex",
  });
  assert.deepEqual(reconstructWorkbenchCliUpdateRunRequest("claude-code"), {
    ok: true,
    value: "claude-code",
  });
  for (const hostile of [
    null,
    42,
    {},
    { cliId: "claude-code" },
    { cliId: "glm-coding-plan" },
    "",
    "glm-coding-plan",
    ["codex"],
  ]) {
    assert.deepEqual(
      reconstructWorkbenchCliUpdateRunRequest(hostile),
      { ok: false },
      `expected rejection for ${JSON.stringify(hostile)}`,
    );
  }
});

test("the check sanitizer accepts exact reports and fails closed on hostile shapes", () => {
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateCheckResult(
      publicCliUpdateCheckCompleted([claudeUpdateAvailable, codexNoCheck]),
    ),
    publicCliUpdateCheckCompleted([claudeUpdateAvailable, codexNoCheck]),
  );
  // Every silent state is a valid, calm report.
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateCheckResult(
      publicCliUpdateCheckCompleted([
        Object.freeze({ cliId: "claude-code", status: "check-failed" }),
        codexNoCheck,
      ]),
    ),
    publicCliUpdateCheckCompleted([
      Object.freeze({ cliId: "claude-code", status: "check-failed" }),
      codexNoCheck,
    ]),
  );
  for (const hostile of [
    null,
    42,
    { ok: true, status: "checked", reports: "nope" },
    {
      ok: true,
      status: "checked",
      reports: [
        Object.freeze({
          cliId: "claude-code",
          status: "update-available",
          currentVersion: "2.1.220",
          availableVersion: "2.1.258",
          extra: true,
        }),
      ],
    },
    {
      ok: true,
      status: "checked",
      reports: [
        // Text can never ride through a version field.
        Object.freeze({
          cliId: "claude-code",
          status: "update-available",
          currentVersion: "not a version",
          availableVersion: "2.1.258",
        }),
      ],
    },
    {
      ok: true,
      status: "checked",
      reports: [
        // codex only ever reports no-check.
        Object.freeze({ cliId: "codex", status: "update-available" }),
      ],
    },
    {
      ok: true,
      status: "checked",
      // Truncated: the codex half is missing.
      reports: [claudeUpdateAvailable],
    },
    {
      ok: true,
      status: "checked",
      // Reordered / duplicated halves fail the exact shape.
      reports: [codexNoCheck, claudeUpdateAvailable],
    },
    {
      ok: true,
      status: "checked",
      reports: [claudeUpdateAvailable, claudeUpdateAvailable],
    },
    {
      ok: true,
      status: "weird",
      reports: [],
    },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchCliUpdateCheckResult(hostile),
      publicCliUpdateCheckUnavailable(),
    );
  }
  // The unavailable error shape itself round-trips.
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateCheckResult(publicCliUpdateCheckUnavailable()),
    publicCliUpdateCheckUnavailable(),
  );
});

test("the run sanitizer pins the requested cliId and every coarse reason, failing closed otherwise", () => {
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRunResult(
      publicCliUpdateRunUpdated("claude-code"),
      "claude-code",
    ),
    publicCliUpdateRunUpdated("claude-code"),
  );
  for (const reason of [
    "timeout",
    "launch-failed",
    "update-failed",
    "unsupported-install",
    "no-change",
  ] as const) {
    assert.deepEqual(
      sanitizeWorkbenchCliUpdateRunResult(
        publicCliUpdateRunFailed(reason),
        "codex",
      ),
      publicCliUpdateRunFailed(reason),
    );
  }
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRunResult(
      publicCliUpdateRunUnavailable(),
      "codex",
    ),
    publicCliUpdateRunUnavailable(),
  );
  for (const hostile of [
    null,
    42,
    { ok: true, status: "updated", cliId: "codex" },
    { ok: true, status: "updated", cliId: "claude-code", extra: true },
    {
      ok: false,
      error: { category: "cli-update-run-failed", reason: "not-a-reason" },
    },
    { ok: false, error: { category: "cli-update-run-failed" } },
    { ok: false, error: { category: "some-other-category" } },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchCliUpdateRunResult(hostile, "claude-code"),
      publicCliUpdateRunUnavailable(),
    );
  }
});

/**
 * Issue 183 end to end. The pieces above are each pinned in isolation; the
 * owner's complaint was about what happens when they are joined, so this
 * runs the real service, the real IPC binding and the real preload
 * sanitizers over one injected updater and asserts the two things he
 * actually experiences: the verdict, and what the row reads next.
 *
 * Nothing is spawned. The runner is the injection seam production fills
 * with `createExecFileCommandRunner()`.
 */
test("the whole surface answers from the machine, and the row reads true without a restart (issue 183)", async () => {
  const wingetClaude =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const stale =
    "名称        ID                   版本    可用\r\n" +
    "Claude Code Anthropic.ClaudeCode 2.1.220 2.1.258\r\n";
  // The measured real up-to-date row (owner's machine, 2026-09-07).
  const fresh =
    "名称        ID                   版本\r\n" +
    "Claude Code Anthropic.ClaudeCode 2.1.258\r\n";

  for (const scenario of ["installs", "exits-zero-and-installs-nothing"] as const) {
    let installed = false;
    const service = createCliUpdateService({
      runner: {
        async run(command) {
          if (command.args[0] === "upgrade") {
            if (scenario === "installs") installed = true;
            return { exit: "zero", stdout: "" };
          }
          return { exit: "zero", stdout: installed ? fresh : stale };
        },
      },
      resolveClaudeExecutable: async () => wingetClaude,
      resolveWingetExecutable: async () => "C:\\winget.exe",
    });
    const ipc = new FakeIpcMain();
    const window = new FakeWindow();
    const binding = installWorkbenchCliUpdateIpc({
      ipcMain: ipc,
      window,
      service,
      requestRelaunch: () => {
        throw new Error("the run path must never relaunch");
      },
    });
    const event = { sender: window.webContents };
    const invokeCheck = async () =>
      sanitizeWorkbenchCliUpdateCheckResult(
        await ipc.handlers.get(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL)!(event),
      );
    const invokeRun = async () =>
      sanitizeWorkbenchCliUpdateRunResult(
        await ipc.handlers.get(WORKBENCH_RUN_CLI_UPDATE_CHANNEL)!(
          event,
          reconstructWorkbenchCliUpdateRunRequest("claude-code").ok
            ? "claude-code"
            : undefined,
        ),
        "claude-code",
      );

    // What the Settings row shows before he presses anything.
    const opened = await invokeCheck();
    assert.deepEqual(opened.ok ? opened.reports[0] : undefined, {
      cliId: "claude-code",
      status: "update-available",
      currentVersion: "2.1.220",
      availableVersion: "2.1.258",
    });

    const run = await invokeRun();
    // The row re-reads as soon as the run resolves -- no restart.
    const after = await invokeCheck();
    const report = after.ok ? after.reports[0] : undefined;

    if (scenario === "installs") {
      assert.deepEqual(run, publicCliUpdateRunUpdated("claude-code"));
      // The stale advertisement is gone, so the Update button (which
      // renders only for update-available) is gone with it.
      assert.deepEqual(report, {
        cliId: "claude-code",
        status: "up-to-date",
      });
    } else {
      // The updater said nothing was wrong; the machine says otherwise.
      assert.deepEqual(run, publicCliUpdateRunFailed("no-change"));
      assert.equal(run.ok, false);
      // And the row still offers the retry, honestly.
      assert.deepEqual(report, {
        cliId: "claude-code",
        status: "update-available",
        currentVersion: "2.1.220",
        availableVersion: "2.1.258",
      });
    }
    binding.dispose();
  }
});

/**
 * Issue 184: the restart button. `relaunchApp` was built end to end and
 * nothing called it, and the reason worker 493 left it unwired was real --
 * main answered it with `app.exit(0)`, which skips `before-quit` and
 * therefore skips the lifecycle drain that closes the conversation store,
 * the create-project controller and the appearance store. A restart button
 * on that wiring is the one exit in the app that can drop the owner's work.
 *
 * These tests execute main's actual requestRelaunch callback over a fake
 * Electron boundary and the real IPC and lifecycle controller.
 */
function fakeElectronApp(events: string[]) {
  let beforeQuit: (() => void) | null = null;
  return Object.freeze({
    onBeforeQuit(handler: () => void): void {
      beforeQuit = handler;
    },
    relaunch(): void {
      events.push("relaunch-registered");
    },
    quit(): void {
      events.push("quit");
      // Electron raises `before-quit` on `app.quit()`. It does NOT raise it
      // on `app.exit()`, which is the whole point of this test.
      beforeQuit?.();
    },
    exit(): void {
      events.push("exit");
    },
  });
}

// Execute the production callback without starting Electron or its real store.
// Reading main here makes changing app.quit() to app.exit() break this test.
async function productionRelaunch(app: ReturnType<typeof fakeElectronApp>): Promise<() => void> {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );
  const callback = /requestRelaunch: (\(\) => \{[\s\S]*?\n      \}),/u.exec(source)?.[1];
  assert.ok(callback, "main must supply the restart callback");
  return new Function("app", `return (${callback});`)(app) as () => void;
}

test("pressing restart drains durable state before the process ends (issue 184)", async () => {
  const events: string[] = [];
  const app = fakeElectronApp(events);
  let releaseFlush!: () => void;
  const flushed = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "in-flight",
    isTrayReady: () => true,
    hideWindow() {},
    disposeProjectView() {
      events.push("dispose-project-view");
    },
    closeBackend() {
      events.push("flush-started");
      return flushed.then(() => {
        events.push("flush-finished");
      });
    },
    exit() {
      app.exit();
    },
  });
  app.onBeforeQuit(() => lifecycle.handleBeforeQuit({ preventDefault() {} }));

  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  const binding = installWorkbenchCliUpdateIpc({
    ipcMain: ipc,
    window,
    service: {
      async check() {
        return [claudeUpdateAvailable, codexNoCheck];
      },
      async run(cliId) {
        return publicCliUpdateRunUpdated(cliId);
      },
    },
    requestRelaunch: await productionRelaunch(app),
  });

  const event = { sender: window.webContents };
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_RELAUNCH_APP_CHANNEL)!(event),
    publicCliUpdateRelaunchQueued(),
  );
  // The renderer has its `queued` answer and nothing has ended yet.
  assert.deepEqual([...events], []);
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));

  // The relaunch is registered and the drain has started. Crucially the
  // process has NOT ended: the flush is still in flight.
  assert.equal(events.includes("exit"), false, "restart must wait for the pending durable flush before exit");
  assert.deepEqual([...events], [
    "relaunch-registered",
    "quit",
    "dispose-project-view",
    "flush-started",
  ]);

  releaseFlush();
  await flushed;
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));

  // Only now does the process end, and the relaunch registered before it
  // is what starts the replacement.
  assert.deepEqual([...events], [
    "relaunch-registered",
    "quit",
    "dispose-project-view",
    "flush-started",
    "flush-finished",
    "exit",
  ]);
  assert.equal(events.indexOf("flush-finished") < events.indexOf("exit"), true);
  assert.equal(events.filter((name) => name === "exit").length, 1);
  binding.dispose();
});

test("a restart while the app is already draining does not exit around the flush (issue 184)", async () => {
  // The owner presses Restart now and then Quit, or presses twice. The
  // drain is idempotent, so the second request must join the running flush
  // rather than start a second exit path beside it.
  const events: string[] = [];
  const app = fakeElectronApp(events);
  let releaseFlush!: () => void;
  const flushed = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  const lifecycle = createWorkbenchLifecycleController({
    readTurnActivity: () => "in-flight",
    isTrayReady: () => true,
    hideWindow() {},
    disposeProjectView() {
      events.push("dispose-project-view");
    },
    closeBackend() {
      events.push("flush-started");
      return flushed;
    },
    exit() {
      app.exit();
    },
  });
  app.onBeforeQuit(() => lifecycle.handleBeforeQuit({ preventDefault() {} }));

  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  installWorkbenchCliUpdateIpc({
    ipcMain: ipc,
    window,
    service: {
      async check() {
        return [claudeUpdateAvailable, codexNoCheck];
      },
      async run(cliId) {
        return publicCliUpdateRunUpdated(cliId);
      },
    },
    requestRelaunch: await productionRelaunch(app),
  });

  const event = { sender: window.webContents };
  await ipc.handlers.get(WORKBENCH_RELAUNCH_APP_CHANNEL)!(event);
  await ipc.handlers.get(WORKBENCH_RELAUNCH_APP_CHANNEL)!(event);
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  releaseFlush();
  await flushed;
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));

  assert.equal(events.filter((name) => name === "flush-started").length, 1);
  assert.equal(events.filter((name) => name === "exit").length, 1);
  assert.equal(
    events.filter((name) => name === "dispose-project-view").length,
    1,
  );
});
