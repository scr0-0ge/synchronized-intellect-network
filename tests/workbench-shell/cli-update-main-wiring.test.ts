import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
  CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
  createCliUpdateService,
  createExecFileCommandRunner,
} from "../../src/workbench-shell/cli-update-check.ts";

/**
 * Ticket 18 production wiring pins: main creates the service, fires the
 * zero-side-effect check exactly once in the background (never awaited,
 * rejection swallowed), installs the two-channel IPC beside the other
 * bindings, and disposes it with the window. The spawn discipline —
 * execFile (no shell), windowsHide always, hard timeouts, capped buffer —
 * is pinned on the adapter itself with a fake execFile, because the real
 * commands belong to the 副主管 acceptance, never to tests.
 */

test("main wires the CLI update service, the once-only background check, and the IPC binding", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /import \{[\s\S]*createCliUpdateService,[\s\S]*type CliUpdateService,[\s\S]*\} from "\.\.\/cli-update-check\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*installWorkbenchCliUpdateIpc,[\s\S]*type WorkbenchCliUpdateIpcBinding,[\s\S]*\} from "\.\.\/cli-update-ipc\.ts";/u,
  );
  // The startup check runs once, in the background, with both outcomes
  // swallowed — exactly like the catalog freshness pull before it.
  assert.match(
    source,
    /cliUpdateService = createCliUpdateService\(\);\s+void cliUpdateService\s+\.check\(\)\s+\.then\(\(\) => undefined, \(\) => undefined\);/u,
  );
  // Issue 184: the restart action is wired to a button, so what ends the
  // process is now the owner's data. `app.relaunch()` only registers the
  // successor; the quit beside it decides whether the durable state was
  // flushed first. It must be `app.quit()` -- the same call the tray Quit
  // item makes, which raises `before-quit` and runs the lifecycle drain --
  // and never `app.exit()`, which skips both.
  assert.match(
    source,
    /cliUpdateIpc = installWorkbenchCliUpdateIpc\(\{\s+ipcMain,\s+window: createdWindow,\s+service: cliUpdateService,\s+\/\/ The "restart now" action \(ticket 21 cleanup[\s\S]*?requestRelaunch: \(\) => \{\s+app\.relaunch\(\);\s+app\.quit\(\);\s+\},\s+\}\);/u,
  );
  const relaunchBody = /requestRelaunch: \(\) => \{([\s\S]*?)\},/u.exec(source);
  assert.notEqual(relaunchBody, null);
  assert.doesNotMatch(relaunchBody![1]!, /app\.exit\(/u);
  // The drain the restart now depends on is only reachable because main
  // routes `before-quit` into the lifecycle controller.
  assert.match(source, /app\.on\("before-quit", lifecycle\.handleBeforeQuit\);/u);
  // Disposal is symmetric with the freshness binding (window closed).
  // main-resync: the teardown moved into main's per-step isolated list
  // (binding-teardown.ts); the step still clears both slots.
  assert.match(
    source,
    /const closing = cliUpdateIpc;\s+cliUpdateIpc = null;\s+closing\?\.dispose\(\);\s+cliUpdateService = null;/u,
  );
  // No other call site can spawn an update: main never calls the
  // service's run itself — the only path is the IPC run channel.
  assert.doesNotMatch(source, /cliUpdateService\??\.run\(/u);
  assert.equal(
    (source.match(/installWorkbenchCliUpdateIpc\(/gu) ?? []).length,
    1,
  );
});

test("the execFile adapter spawns with windowsHide, no shell, hard timeouts, and a capped buffer", async () => {
  const spawns: Array<{
    readonly file: string;
    readonly args: readonly string[];
    readonly options: Record<string, unknown>;
  }> = [];
  const fakeSpawn: Parameters<typeof createExecFileCommandRunner>[0] = (
    file,
    args,
    options,
    callback,
  ) => {
    spawns.push({ file, args: [...args], options: options as Record<string, unknown> });
    callback(null, "ok");
  };
  const runner = createExecFileCommandRunner(fakeSpawn);

  const outcome = await runner.run({
    file: "winget",
    args: ["list"],
    timeoutMilliseconds: CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
  });
  assert.deepEqual(outcome, { exit: "zero", stdout: "ok" });
  assert.equal(spawns.length, 1);
  const options = spawns[0]!.options;
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS);
  assert.equal(typeof options.maxBuffer, "number");
  assert.ok((options.maxBuffer as number) > 0);
  assert.equal(options.encoding, "utf8");
  // execFile is shell-less by construction: no shell option is ever set.
  assert.equal("shell" in options, false);
});

test("the execFile adapter classifies timeout, launch, and non-zero exits into the coarse enum", async () => {
  const timeoutError = Object.assign(
    new Error("_process termination"),
    { killed: true, signal: "SIGTERM", code: null },
  );
  const maxBufferError = Object.assign(
    new Error("stdout maxBuffer length exceeded"),
    { killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
  );
  const launchError = Object.assign(new Error("spawn ENOENT"), {
    code: "ENOENT",
    killed: false,
    signal: undefined,
  });
  const exitError = Object.assign(new Error("exit 1"), {
    code: 1,
    killed: false,
    signal: null,
  });

  const cases = [
    { error: timeoutError, expected: "timeout" },
    // A maxBuffer kill is not a timeout — the outcome is simply not a
    // clean zero exit.
    { error: maxBufferError, expected: "non-zero" },
    { error: launchError, expected: "launch-failed" },
    { error: exitError, expected: "non-zero" },
  ] as const;

  for (const { error, expected } of cases) {
    const fakeSpawn: Parameters<typeof createExecFileCommandRunner>[0] = (
      _file,
      _args,
      _options,
      callback,
    ) => {
      callback(error, "");
    };
    const runner = createExecFileCommandRunner(fakeSpawn);
    const outcome = await runner.run({
      file: "claude",
      args: ["update"],
      timeoutMilliseconds: CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
    });
    assert.equal(
      outcome.exit,
      expected,
      `expected ${expected} for ${error.message}`,
    );
  }
});

test("the service never exposes raw command output through its public results", async () => {
  const service = createCliUpdateService({
    runner: {
      async run() {
        return {
          exit: "zero",
          stdout: "C:\\Users\\test-user\\private-path token-ish-text",
        };
      },
    },
    resolveWingetExecutable: async () => "winget",
    resolveClaudeExecutable: async () => "claude.exe",
    resolveCodexExecutable: async () => "codex.exe",
  });
  const reports = await service.check();
  const serialized = JSON.stringify([
    reports,
    await service.run("codex"),
  ]);
  assert.doesNotMatch(serialized, /private-path/u);
  assert.doesNotMatch(serialized, /token-ish/u);
  // The unparsable stdout degrades to the silent check-failed state.
  assert.deepEqual(reports[0], {
    cliId: "claude-code",
    status: "check-failed",
  });
});
