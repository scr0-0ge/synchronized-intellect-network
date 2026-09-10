import assert from "node:assert/strict";
import test from "node:test";

import {
  CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
  CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
  createCliUpdateService,
  isMicrosoftStoreManagedCodexInstall,
  isWingetManagedClaudeInstall,
  parseWingetListOutput,
  type CliUpdateCommandOutcome,
  type CliUpdateCommandRunner,
} from "../../src/workbench-shell/cli-update-check.ts";
import {
  publicCliUpdateCheckCompleted,
  publicCliUpdateRunFailed,
  publicCliUpdateRunUpdated,
  type WorkbenchCliUpdateCheckReport,
} from "../../src/workbench-shell/cli-update-contract.ts";

/**
 * Ticket 18 unit surface: every spawn is a fake (real winget / update runs
 * belong to the 副主管 acceptance), the winget parse is pinned against the
 * spike's real output shapes, and the service's spawn discipline is
 * asserted on the recorded runner calls.
 */

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMilliseconds: number;
}

class FakeRunner implements CliUpdateCommandRunner {
  readonly calls: RecordedCall[] = [];
  #outcome: (call: RecordedCall) => CliUpdateCommandOutcome;

  constructor(
    outcome:
      | CliUpdateCommandOutcome
      | ((call: RecordedCall) => CliUpdateCommandOutcome),
  ) {
    this.#outcome = typeof outcome === "function" ? outcome : () => outcome;
  }

  run(options: {
    readonly file: string;
    readonly args: readonly string[];
    readonly timeoutMilliseconds: number;
  }): Promise<CliUpdateCommandOutcome> {
    const call = Object.freeze({
      file: options.file,
      args: Object.freeze([...options.args]),
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
    this.calls.push(call);
    return Promise.resolve(this.#outcome(call));
  }
}

const wingetUpgradeOutput = [
  "名称        ID                   版本    可用",
  "------------------------------------------------",
  "Claude Code Anthropic.ClaudeCode 2.1.220 2.1.258",
  "",
].join("\r\n");

test("parseWingetListOutput pins the spike's real shapes", () => {
  // Real localized output from the spike (§1.3): display name with a
  // space, localized headers, upgrade available.
  assert.deepEqual(parseWingetListOutput(wingetUpgradeOutput), {
    status: "update-available",
    currentVersion: "2.1.220",
    availableVersion: "2.1.258",
  });
  // No 可用 column → up to date. The installed version rides along: it is
  // what a run confirms itself against (issue 183), and this is exactly
  // the row a successful upgrade produces. Measured on the owner's machine
  // 2026-09-07: `winget list --id Anthropic.ClaudeCode --source winget
  // --accept-source-agreements --disable-interactivity` printed the
  // 名称/ID/版本 header and this single row, with no Source column.
  assert.deepEqual(
    parseWingetListOutput(
      "名称        ID                   版本\r\n" +
        "----------------------------------------\r\n" +
        "Claude Code Anthropic.ClaudeCode 2.1.263\r\n",
    ),
    { status: "up-to-date", currentVersion: "2.1.263" },
  );
  // Same version in both columns → still up to date.
  assert.deepEqual(
    parseWingetListOutput(
      "Claude Code Anthropic.ClaudeCode 2.1.258 2.1.258\r\n",
    ),
    { status: "up-to-date", currentVersion: "2.1.258" },
  );
  // English headers do not shift the id-anchored parse.
  assert.deepEqual(
    parseWingetListOutput(
      "Name       ID                   Version Available\r\nClaude Code Anthropic.ClaudeCode 1.0.0 1.0.1\r\n",
    ),
    { status: "update-available", currentVersion: "1.0.0", availableVersion: "1.0.1" },
  );
});

test("parseWingetListOutput degrades to undefined for unparsable or hostile output", () => {
  for (const hostile of [
    "",
    "No installed package found matching input criteria.",
    "名称 ID 版本\r\n",
    // The id substring inside another token must not satisfy the parse.
    "Claude Code xAnthropic.ClaudeCodex 1.0.0 1.0.1\r\n",
    // Non-version tokens after the id reject the whole row.
    "Claude Code Anthropic.ClaudeCode Unknown 1.0.1\r\n",
    "Claude Code Anthropic.ClaudeCode 2.1.220 not-a-version!\r\n",
    // Control characters can never ride along in a version field.
    "Claude Code Anthropic.ClaudeCode 2.1.2\u000020 9.9.9\r\n",
    // Path-shaped tokens are not versions.
    "Claude Code Anthropic.ClaudeCode C:\\Users\\test-user 9.9.9\r\n",
    // Version-like token beyond the length cap rejects the row.
    `Claude Code Anthropic.ClaudeCode ${"1".repeat(33)} 9.9.9\r\n`,
  ]) {
    assert.equal(
      parseWingetListOutput(hostile),
      undefined,
      `expected undefined for ${JSON.stringify(hostile)}`,
    );
  }
});

test("check runs the read-only winget list once, memoizes, and reports codex as no-check", async () => {
  const runner = new FakeRunner({
    exit: "zero",
    stdout: wingetUpgradeOutput,
  });
  const service = createCliUpdateService({
    runner,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  const reports = await service.check();
  assert.deepEqual(reports, [
    Object.freeze({
      cliId: "claude-code",
      status: "update-available",
      currentVersion: "2.1.220",
      availableVersion: "2.1.258",
    }),
    Object.freeze({ cliId: "codex", status: "no-check" }),
  ] satisfies readonly WorkbenchCliUpdateCheckReport[]);
  // Memoized: the second call shares the report, no second spawn.
  assert.deepEqual(await service.check(), reports);
  assert.equal(runner.calls.length, 1);
  // The only spawn is the read-only query with the check timeout cap.
  assert.deepEqual(runner.calls[0]!.file, "C:\\winget.exe");
  assert.deepEqual(runner.calls[0]!.args, [
    "list",
    "--id",
    "Anthropic.ClaudeCode",
    "--source",
    "winget",
    "--accept-source-agreements",
    "--disable-interactivity",
  ]);
  assert.equal(
    runner.calls[0]!.timeoutMilliseconds,
    CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
  );
});

test("every check failure stays the silent check-failed state", async () => {
  for (const outcome of [
    { exit: "non-zero", stderr: "" },
    { exit: "timeout" },
    { exit: "launch-failed" },
    // Zero exit with garbage stdout still cannot produce a report.
    { exit: "zero", stdout: "winget source is unavailable" },
  ] as const) {
    const service = createCliUpdateService({
      runner: new FakeRunner(outcome),
      resolveWingetExecutable: async () => "winget",
    });
    assert.deepEqual(await service.check(), [
      Object.freeze({ cliId: "claude-code", status: "check-failed" }),
      Object.freeze({ cliId: "codex", status: "no-check" }),
    ]);
  }
  // A missing winget resolver answer is equally silent.
  const missingWinget = createCliUpdateService({
    runner: new FakeRunner({ exit: "zero", stdout: "" }),
    resolveWingetExecutable: async () => undefined,
  });
  assert.deepEqual((await missingWinget.check())[0], {
    cliId: "claude-code",
    status: "check-failed",
  });
});

test("run executes the CLI's own update subcommand with the run timeout and maps every exit honestly", async () => {
  const cases = [
    { outcome: { exit: "zero", stdout: "" }, expected: publicCliUpdateRunFailed("no-change") },
    { outcome: { exit: "non-zero", stderr: "" }, expected: publicCliUpdateRunFailed("update-failed") },
    { outcome: { exit: "timeout" }, expected: publicCliUpdateRunFailed("timeout") },
    { outcome: { exit: "launch-failed" }, expected: publicCliUpdateRunFailed("launch-failed") },
  ] as const;
  for (const { outcome, expected } of cases) {
    const runner = new FakeRunner((call) =>
      call.args.at(-1) === "--version"
        ? { exit: "zero", stdout: versionOutput("claude-code", "1.0.0") }
        : outcome,
    );
    const service = createCliUpdateService({
      runner,
      resolveClaudeExecutable: async () => "C:\\claude\\claude.exe",
    });
    assert.deepEqual(await service.run("claude-code"), expected);
    assert.deepEqual(runner.calls[1],
      Object.freeze({
        file: "C:\\claude\\claude.exe",
        args: Object.freeze(["update"]),
        timeoutMilliseconds: CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
      }),
    );

    const codexRunner = new FakeRunner((call) =>
      call.args.at(-1) === "--version"
        ? { exit: "zero", stdout: versionOutput("codex", "1.0.0") }
        : outcome,
    );
    const codexService = createCliUpdateService({
      runner: codexRunner,
      resolveCodexExecutable: async () =>
        "C:\\codex\\994e8469124a0d31\\codex.exe",
    });
    assert.deepEqual(
      await codexService.run("codex"),
      expected,
    );
    assert.deepEqual(
      codexRunner.calls[1]!.file,
      "C:\\codex\\994e8469124a0d31\\codex.exe",
    );
  }
});

test("an unlocatable CLI is an honest launch-failed, never a fake success", async () => {
  const service = createCliUpdateService({
    runner: new FakeRunner({ exit: "zero", stdout: "" }),
    resolveClaudeExecutable: async () => undefined,
    resolveCodexExecutable: async () => undefined,
  });
  assert.deepEqual(await service.run("claude-code"), publicCliUpdateRunFailed("launch-failed"));
  assert.deepEqual(await service.run("codex"), publicCliUpdateRunFailed("launch-failed"));
});

test("the sanitized-by-construction reports round-trip through the public constructors", () => {
  const reports: readonly WorkbenchCliUpdateCheckReport[] = [
    Object.freeze({
      cliId: "claude-code",
      status: "update-available",
      currentVersion: "2.1.220",
      availableVersion: "2.1.258",
    }),
    Object.freeze({ cliId: "codex", status: "no-check" }),
  ];
  const result = publicCliUpdateCheckCompleted(reports);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.ok ? result.reports : []), true);
  assert.deepEqual(
    result.ok ? result.reports : [],
    reports,
  );
});

test("a winget-managed claude updates through winget upgrade, not its own no-op (issue #6 comment 2.2)", async () => {
  // Measured 2026-09-06 on the owner's machine: the winget-installed
  // claude's `update` exits zero saying it is managed by winget while
  // changing nothing. The run must go to the managing channel instead.
  const wingetPath =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  // The upgrade exits zero and the installed version moves, so the run is
  // confirmed rather than merely claimed (issue 183).
  const runner = new FakeRunner(installingWingetRunner());
  const service = createCliUpdateService({
    runner,
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunUpdated("claude-code"),
  );
  assert.deepEqual(runner.calls.filter((call) => call.args[0] === "upgrade"), [
    Object.freeze({
      file: "C:\\winget.exe",
      args: Object.freeze([
        "upgrade",
        "--id",
        "Anthropic.ClaudeCode",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
      ]),
      timeoutMilliseconds: CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
    }),
  ]);

  // The channel's own failures map honestly. The read-back still runs and
  // still reports the old version, so the failure survives confirmation.
  for (const { outcome, expected } of [
    { outcome: { exit: "non-zero", stderr: "upgrade failed" } as const, expected: publicCliUpdateRunFailed("update-failed") },
    { outcome: { exit: "timeout" } as const, expected: publicCliUpdateRunFailed("timeout") },
  ]) {
    const failing = createCliUpdateService({
      runner: new FakeRunner((call) =>
        call.args[0] === "upgrade"
          ? outcome
          : { exit: "zero", stdout: wingetUpgradeOutput },
      ),
      resolveClaudeExecutable: async () => wingetPath,
      resolveWingetExecutable: async () => "C:\\winget.exe",
    });
    assert.deepEqual(await failing.run("claude-code"), expected);
  }

  // A missing winget on a winget-managed install is a launch failure.
  const noWinget = createCliUpdateService({
    runner: new FakeRunner({ exit: "zero", stdout: "" }),
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => undefined,
  });
  assert.deepEqual(await noWinget.run("claude-code"), publicCliUpdateRunFailed("launch-failed"));
});

test("the Codex desktop standalone updates through its Microsoft Store package with launch-plan readback", async () => {
  // Measured 2026-09-09 on the owner's machine: the ChatGPT Store app
  // installs this standalone release tree and exposes it through the stable
  // Codex bin junction. `codex update` refuses this installation method, but
  // winget identifies the managing Store product as 9PLM9XGG6VKS.
  const codexPath =
    "C:\\Users\\u\\.codex\\packages\\standalone\\releases\\0.153.4-x86_64-pc-windows-msvc\\bin\\codex.exe";
  let versionReads = 0;
  const runner = new FakeRunner((call) => {
    if (call.args.at(-1) === "--version") {
      return {
        exit: "zero",
        stdout: versionOutput(
          "codex",
          versionReads++ === 0 ? "0.153.4" : "0.154.0",
        ),
      };
    }
    return { exit: "zero", stdout: "" };
  });
  const service = createCliUpdateService({
    runner,
    resolveCodexExecutable: async () => codexPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });

  assert.deepEqual(
    await service.run("codex"),
    publicCliUpdateRunUpdated("codex"),
  );
  assert.deepEqual(runner.calls, [
    {
      file: codexPath,
      args: ["--version"],
      timeoutMilliseconds: CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
    },
    {
      file: "C:\\winget.exe",
      args: [
        "upgrade",
        "--id",
        "9PLM9XGG6VKS",
        "--exact",
        "--source",
        "msstore",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
        "--include-unknown",
      ],
      timeoutMilliseconds: CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
    },
    {
      file: codexPath,
      args: ["--version"],
      timeoutMilliseconds: CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
    },
  ]);
});

test("Microsoft Store Codex classification matches the desktop app paths only on Windows", () => {
  for (const desktopPath of [
    "C:\\Users\\u\\.codex\\packages\\standalone\\releases\\0.153.4-x86_64-pc-windows-msvc\\bin\\codex.exe",
    "C:\\Users\\u\\.codex\\packages\\standalone\\current\\bin\\codex.exe",
    "C:/Users/u/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe",
  ]) {
    assert.equal(
      isMicrosoftStoreManagedCodexInstall(desktopPath, "win32"),
      true,
      desktopPath,
    );
  }
  for (const outside of [
    "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    "C:\\codex\\codex.exe",
    "C:\\Users\\u\\.codex-other\\packages\\standalone\\current\\bin\\codex.exe",
  ]) {
    assert.equal(
      isMicrosoftStoreManagedCodexInstall(outside, "win32"),
      false,
      outside,
    );
  }
  assert.equal(
    isMicrosoftStoreManagedCodexInstall(
      "/home/u/.codex/packages/standalone/current/bin/codex",
      "linux",
    ),
    false,
  );
});

test("a non-winget claude keeps using its own update subcommand", async () => {
  let versionReads = 0;
  const runner = new FakeRunner((call) =>
    call.args.at(-1) === "--version"
      ? {
          exit: "zero",
          stdout: versionOutput(
            "claude-code",
            versionReads++ === 0 ? "1.0.0" : "1.1.0",
          ),
        }
      : { exit: "zero", stdout: "" },
  );
  const service = createCliUpdateService({
    runner,
    resolveClaudeExecutable: async () => "C:\\claude\\claude.exe",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunUpdated("claude-code"),
  );
  assert.deepEqual(runner.calls[1]!.file, "C:\\claude\\claude.exe");
  assert.deepEqual(runner.calls[1]!.args, ["update"]);
});

test("isWingetManagedClaudeInstall matches only the winget package root, Windows only", () => {
  assert.equal(
    isWingetManagedClaudeInstall(
      "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe",
      "win32",
    ),
    true,
  );
  // Case and separator variants of the same root still match.
  assert.equal(
    isWingetManagedClaudeInstall(
      "c:/users/u/appdata/local/microsoft/winget/packages/x/claude.exe",
      "win32",
    ),
    true,
  );
  for (const outside of [
    "C:\\claude\\claude.exe",
    "C:\\Users\\u\\.claude\\local\\claude.exe",
    // A path that merely mentions winget elsewhere does not match.
    "C:\\tools\\winget\\claude.exe",
  ]) {
    assert.equal(isWingetManagedClaudeInstall(outside, "win32"), false);
  }
  assert.equal(
    isWingetManagedClaudeInstall(
      "/home/u/.local/bin/claude",
      "linux",
    ),
    false,
  );
});

test("a codex install its own updater refuses to classify is unsupported-install, not a lock (issue #6 comment 2.1)", async () => {
  // Measured 2026-09-06 on the owner's machine: the desktop-app-channel
  // codex answers `codex update` with exactly this stderr and a non-zero
  // exit. Reporting it as a file lock sent the owner chasing sessions that
  // did not exist.
  const refused = new FakeRunner((call) =>
    call.args.at(-1) === "--version"
      ? { exit: "zero", stdout: versionOutput("codex", "1.0.0") }
      : {
          exit: "non-zero",
          stderr:
            "Error: Could not detect the Codex installation method. Please update manually: https://developers.openai.com/codex/cli/",
        },
  );
  const service = createCliUpdateService({
    runner: refused,
    resolveCodexExecutable: async () =>
      "C:\\u\\AppData\\Local\\OpenAI\\Codex\\bin\\27d6a192e9c98618\\codex.exe",
  });
  assert.deepEqual(
    await service.run("codex"),
    publicCliUpdateRunFailed("unsupported-install"),
  );

  // Any other non-zero stderr is still the generic update failure.
  const otherFailure = createCliUpdateService({
    runner: new FakeRunner((call) =>
      call.args.at(-1) === "--version"
        ? { exit: "zero", stdout: versionOutput("codex", "1.0.0") }
        : { exit: "non-zero", stderr: "Error: disk full" },
    ),
    resolveCodexExecutable: async () => "C:\\codex\\codex.exe",
  });
  assert.deepEqual(
    await otherFailure.run("codex"),
    publicCliUpdateRunFailed("update-failed"),
  );

  // The refusal sentence must not swallow claude failures: claude never
  // classifies as unsupported-install from stderr.
  const claudeRefused = createCliUpdateService({
    runner: new FakeRunner((call) =>
      call.args.at(-1) === "--version"
        ? { exit: "zero", stdout: versionOutput("claude-code", "1.0.0") }
        : {
            exit: "non-zero",
            stderr: "Error: Could not detect the Codex installation method",
          },
    ),
    resolveClaudeExecutable: async () => "C:\\claude\\claude.exe",
  });
  assert.deepEqual(
    await claudeRefused.run("claude-code"),
    publicCliUpdateRunFailed("update-failed"),
  );
});

/**
 * Issue 183 guards. The owner pressed Update, was told it worked, restarted
 * and found the old version -- so a run's verdict may not be the updater's
 * word for it, and the screen may not need a restart to become true.
 */

/**
 * A winget runner whose upgrade installs: `list` answers 2.1.220 with
 * 2.1.258 available until the upgrade runs, and the up-to-date row after.
 */
function installingWingetRunner(): (call: RecordedCall) => CliUpdateCommandOutcome {
  let installed = false;
  return (call) => {
    if (call.args[0] === "upgrade") {
      installed = true;
      return { exit: "zero", stdout: "" };
    }
    return {
      exit: "zero",
      stdout: installed
        ? "Claude Code Anthropic.ClaudeCode 2.1.258\r\n"
        : wingetUpgradeOutput,
    };
  };
}

test("an updater that exits zero without moving the installed version is no-change, never success (issue 183)", async () => {
  const wingetPath =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  // The measured class: an updater reporting success while installing
  // nothing (the winget-managed `claude update` answering "Claude is
  // managed by winget" with exit zero, 2026-09-06). Here the upgrade exits
  // zero and the read-back still says 2.1.220.
  const runner = new FakeRunner((call) =>
    call.args[0] === "upgrade"
      ? { exit: "zero", stdout: "" }
      : { exit: "zero", stdout: wingetUpgradeOutput },
  );
  const service = createCliUpdateService({
    runner,
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunFailed("no-change"),
  );
  // The verdict came from a read-back, not from the exit code: exactly one
  // list before the upgrade (the memoized check) and one after it.
  assert.deepEqual(
    runner.calls.map((call) => call.args[0]),
    ["list", "upgrade", "list"],
  );
});

test("a moved installed version is the update, and it lands without a restart (issue 183)", async () => {
  const wingetPath =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const runner = new FakeRunner(installingWingetRunner());
  const service = createCliUpdateService({
    runner,
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  // Before the press the row advertises the update the owner can see.
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "update-available",
    currentVersion: "2.1.220",
    availableVersion: "2.1.258",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunUpdated("claude-code"),
  );
  // The memo was dropped by the run, so the very next check -- the one the
  // Settings row makes as soon as the run resolves -- describes the
  // machine. This is the whole of "restarting is not required for the
  // result to be correct": the stale update-available report is gone.
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "up-to-date",
  });
  // The run re-reads once before invoking winget so a version installed by
  // another process after the startup check cannot be credited to this
  // button press. Its post-run refresh is memoized for the renderer.
  assert.deepEqual(
    runner.calls.map((call) => call.args[0]),
    ["list", "list", "upgrade", "list"],
  );
});

test("the disk decides: a version that moved is the update even when the command exited non-zero (issue 183)", async () => {
  const wingetPath =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  // winget replaced the package and then failed something afterwards. The
  // exit code says the command lost; the machine says 2.1.258 is installed.
  // The machine wins -- that is the whole rule of the confirmation, and it
  // is what makes the "updated" verdict a fact rather than a claim. This
  // test is also the one that fails if the up-to-date read-back stops
  // carrying its installed version, which is the only evidence a
  // successful upgrade leaves behind.
  let upgraded = false;
  const runner = new FakeRunner((call) => {
    if (call.args[0] === "upgrade") {
      upgraded = true;
      return { exit: "non-zero", stderr: "post-install step failed" };
    }
    return {
      exit: "zero",
      stdout: upgraded
        ? "Claude Code Anthropic.ClaudeCode 2.1.258\r\n"
        : wingetUpgradeOutput,
    };
  });
  const service = createCliUpdateService({
    runner,
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunUpdated("claude-code"),
  );
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "up-to-date",
  });
});

test("a failed run leaves the report standing so the owner can retry (issue 183)", async () => {
  const wingetPath =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  const service = createCliUpdateService({
    runner: new FakeRunner((call) =>
      call.args[0] === "upgrade"
        ? { exit: "non-zero", stderr: "0x8a15002b" }
        : { exit: "zero", stdout: wingetUpgradeOutput },
    ),
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunFailed("update-failed"),
  );
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "update-available",
    currentVersion: "2.1.220",
    availableVersion: "2.1.258",
  });
});

test("an unconfirmable read-back is result-unknown rather than exit-code success (issue 183)", async () => {
  const wingetPath =
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";
  // winget answers the query with something unparsable, so there is no
  // version to compare. The check degrades to its failure state and the run
  // refuses to turn the command's zero exit into an update claim.
  const service = createCliUpdateService({
    runner: new FakeRunner((call) =>
      call.args[0] === "upgrade"
        ? { exit: "zero", stdout: "" }
        : { exit: "zero", stdout: "winget source is unavailable" },
    ),
    resolveClaudeExecutable: async () => wingetPath,
    resolveWingetExecutable: async () => "C:\\winget.exe",
  });
  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunFailed("result-unknown"),
  );
});

test("codex and non-winget claude report updated only when launch-plan readback changed", async () => {
  for (const cliId of ["codex", "claude-code"] as const) {
    const launch = fakeLaunch(`C:\\runtime\\${cliId}.exe`);
    let discoveries = 0;
    let versionReads = 0;
    const runner = new FakeRunner((call) => {
      if (call.args.at(-1) === "--version") {
        const version = versionReads++ === 0 ? "1.0.0" : "1.1.0";
        return { exit: "zero", stdout: versionOutput(cliId, version) };
      }
      return { exit: "zero", stdout: "updater said success" };
    });
    const service = createCliUpdateService({
      runner,
      ...launchDiscovery(cliId, async () => {
        discoveries += 1;
        return launch;
      }),
    });

    assert.deepEqual(await service.run(cliId), publicCliUpdateRunUpdated(cliId));
    assert.equal(discoveries, 2);
    assert.deepEqual(runner.calls.map((call) => call.args.at(-1)), [
      "--version",
      "update",
      "--version",
    ]);
  }
});

test("codex and non-winget claude report no-change when launch-plan readback stayed the same", async () => {
  for (const cliId of ["codex", "claude-code"] as const) {
    const launch = fakeLaunch(`C:\\runtime\\${cliId}.exe`);
    const runner = new FakeRunner((call) =>
      call.args.at(-1) === "--version"
        ? { exit: "zero", stdout: versionOutput(cliId, "1.0.0") }
        : { exit: "zero", stdout: "updater said success" },
    );
    const service = createCliUpdateService({
      runner,
      ...launchDiscovery(cliId, async () => launch),
    });

    assert.deepEqual(
      await service.run(cliId),
      publicCliUpdateRunFailed("no-change"),
    );
  }
});

test("codex and non-winget claude report result-unknown when either launch-plan readback is unreadable", async () => {
  for (const cliId of ["codex", "claude-code"] as const) {
    for (const unreadableRead of [0, 1] as const) {
      const launch = fakeLaunch(`C:\\runtime\\${cliId}.exe`);
      let versionReads = 0;
      const runner = new FakeRunner((call) => {
        if (call.args.at(-1) !== "--version") {
          return { exit: "zero", stdout: "updater said success" };
        }
        const unreadable = versionReads++ === unreadableRead;
        return {
          exit: "zero",
          stdout: unreadable ? "not a version" : versionOutput(cliId, "1.0.0"),
        };
      });
      const service = createCliUpdateService({
        runner,
        ...launchDiscovery(cliId, async () => launch),
      });

      assert.deepEqual(
        await service.run(cliId),
        publicCliUpdateRunFailed("result-unknown"),
      );
    }
  }
});

test("codex and non-winget claude discard a moved plan and read the next-session plan", async () => {
  for (const cliId of ["codex", "claude-code"] as const) {
    const before = fakeLaunch("C:\\node-old\\node.exe", `C:\\old\\${cliId}.js`);
    const after = fakeLaunch("C:\\node-new\\node.exe", `C:\\new\\${cliId}.js`);
    let discoveries = 0;
    const runner = new FakeRunner((call) => {
      if (call.args.at(-1) === "--version") {
        return {
          exit: "zero",
          stdout: versionOutput(
            cliId,
            call.file === before.executable ? "1.0.0" : "1.1.0",
          ),
        };
      }
      return { exit: "zero", stdout: "updater said success" };
    });
    const service = createCliUpdateService({
      runner,
      ...launchDiscovery(cliId, async () =>
        discoveries++ === 0 ? before : after,
      ),
    });

    assert.deepEqual(await service.run(cliId), publicCliUpdateRunUpdated(cliId));
    assert.deepEqual(runner.calls, [
      {
        file: before.executable,
        args: [...before.prefixArguments, "--version"],
        timeoutMilliseconds: CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
      },
      {
        file: before.executable,
        args: [...before.prefixArguments, "update"],
        timeoutMilliseconds: CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS,
      },
      {
        file: after.executable,
        args: [...after.prefixArguments, "--version"],
        timeoutMilliseconds: CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS,
      },
    ]);
  }
});

interface FakeLaunch {
  readonly executable: string;
  readonly prefixArguments: readonly string[];
}

function fakeLaunch(executable: string, ...prefixArguments: readonly string[]): FakeLaunch {
  return Object.freeze({
    executable,
    prefixArguments: Object.freeze([...prefixArguments]),
  });
}

function launchDiscovery(
  cliId: "codex" | "claude-code",
  discover: () => Promise<FakeLaunch>,
):
  | { readonly discoverCodexLaunch: () => Promise<FakeLaunch> }
  | { readonly discoverClaudeLaunch: () => Promise<FakeLaunch> } {
  return cliId === "codex"
    ? { discoverCodexLaunch: discover }
    : { discoverClaudeLaunch: discover };
}

function versionOutput(
  cliId: "codex" | "claude-code",
  version: string,
): string {
  return cliId === "codex"
    ? `codex-cli ${version}\n`
    : `${version} (Claude Code)\n`;
}

test("a failed check is not memoized, so asking again really asks the machine (issue 184)", async () => {
  // The failure the owner actually meets: the check succeeded at startup,
  // the post-run read-back could not reach the winget source, and the row
  // is left holding "check-failed". Before issue 184 that answer was
  // memoized for the life of the process, so every later ask -- reopening
  // Settings, pressing a retry -- replayed it without spawning anything,
  // and only a restart could clear it.
  let sourceAvailable = false;
  const runner = new FakeRunner(() =>
    sourceAvailable
      ? { exit: "zero", stdout: wingetUpgradeOutput }
      : { exit: "non-zero", stderr: "" },
  );
  const service = createCliUpdateService({
    runner,
    resolveWingetExecutable: async () => "winget",
  });

  assert.deepEqual(await service.check(), [
    Object.freeze({ cliId: "claude-code", status: "check-failed" }),
    Object.freeze({ cliId: "codex", status: "no-check" }),
  ]);
  assert.equal(runner.calls.length, 1);

  // Still failing: asking again spawns the query again rather than
  // returning the remembered failure.
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "check-failed",
  });
  assert.equal(runner.calls.length, 2);

  // The source comes back. The retry now reaches the machine and the row
  // can act again -- without the process ever being restarted.
  sourceAvailable = true;
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "update-available",
    currentVersion: "2.1.220",
    availableVersion: "2.1.258",
  });
  assert.equal(runner.calls.length, 3);

  // And a confirmed answer is still memoized: the once-per-process rule
  // is untouched for the case it was written for.
  assert.deepEqual((await service.check())[0], {
    cliId: "claude-code",
    status: "update-available",
    currentVersion: "2.1.220",
    availableVersion: "2.1.258",
  });
  assert.equal(runner.calls.length, 3);
});

test("concurrent callers still share one failing check, and only the next one retries (issue 184)", async () => {
  // Dropping the memo on failure must not turn every in-flight caller into
  // its own spawn: the mount load and the post-run refresh can overlap.
  const runner = new FakeRunner({ exit: "timeout" });
  const service = createCliUpdateService({
    runner,
    resolveWingetExecutable: async () => "winget",
  });
  const [first, second] = await Promise.all([
    service.check(),
    service.check(),
  ]);
  assert.deepEqual(first[0], {
    cliId: "claude-code",
    status: "check-failed",
  });
  assert.deepEqual(second, first);
  assert.equal(runner.calls.length, 1);
  await service.check();
  assert.equal(runner.calls.length, 2);
});
