import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createCliUpdateService,
  createExecFileCommandRunner,
} from "../../src/workbench-shell/cli-update-check.ts";
import {
  publicCliUpdateRunFailed,
  publicCliUpdateRunUnavailable,
} from "../../src/workbench-shell/cli-update-contract.ts";
import { sanitizeWorkbenchCliUpdateRunResult } from "../../src/workbench-shell/cli-update-sanitizer.ts";
import { copyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/settings-copy.ts";

const wingetClaude =
  "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe";

test("the production execFile callback keeps codex refusal stderr for honest classification", async () => {
  const refusal =
    "Error: Could not detect the Codex installation method. Please update manually.";
  const fakeExecFile: Parameters<typeof createExecFileCommandRunner>[0] = (
    _file,
    args,
    _options,
    callback,
  ) => {
    if (args.at(-1) === "--version") {
      callback(null, "codex-cli 1.0.0\n");
      return;
    }
    const error = Object.assign(new Error("Command failed"), {
      code: 1,
      killed: false,
      signal: null,
    });
    // Node's execFile supplies stderr as the third callback argument. The
    // production adapter must not assume it also exists on the Error object.
    const nodeCallback = callback as unknown as (
      callbackError: typeof error,
      stdout: string,
      stderr: string,
    ) => void;
    nodeCallback(error, "", refusal);
  };
  const service = createCliUpdateService({
    runner: createExecFileCommandRunner(fakeExecFile),
    resolveCodexExecutable: async () => "C:\\codex\\codex.exe",
  });

  assert.deepEqual(
    await service.run("codex"),
    publicCliUpdateRunFailed("unsupported-install"),
  );
});

test("registered failure reasons do not relax the exact IPC shape", () => {
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRunResult(
      {
        ...publicCliUpdateRunFailed("unsupported-install"),
        unregistered: true,
      },
      "codex",
    ),
    publicCliUpdateRunUnavailable(),
  );
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRunResult(
      publicCliUpdateRunFailed("result-unknown"),
      "claude-code",
    ),
    publicCliUpdateRunFailed("result-unknown"),
  );
  assert.deepEqual(
    sanitizeWorkbenchCliUpdateRunResult(
      {
        ok: false,
        error: {
          ...publicCliUpdateRunFailed("result-unknown").error,
          unregistered: true,
        },
      },
      "codex",
    ),
    publicCliUpdateRunUnavailable(),
  );
});

test("result-unknown tells both locales when the next new session cannot be verified", () => {
  assert.equal(
    copyLocaleDictionaries.en.cliUpdateCopy.failedResultUnknownSentence,
    "The update command finished, but the version for the next new session could not be verified. Check again before starting a new session.",
  );
  assert.equal(
    copyLocaleDictionaries["zh-CN"].cliUpdateCopy
      .failedResultUnknownSentence,
    "更新命令已结束，但无法核实下一个新会话的版本。请在新建会话前重新检查。",
  );
});

test("a generic command failure does not invent a file-lock explanation", async () => {
  const settings = await readFile(
    new URL("../../src/workbench-shell/renderer/settings.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(settings, /copy\.failureInUseAdvice/u);
});

test("a fresh pre-run disk read prevents an external update from becoming this run's success", async () => {
  let installedVersion = "2.1.220";
  const calls: string[] = [];
  const service = createCliUpdateService({
    resolveClaudeExecutable: async () => wingetClaude,
    resolveWingetExecutable: async () => "winget",
    runner: {
      async run(command) {
        calls.push(command.args[0]!);
        if (command.args[0] === "upgrade") {
          // This update button changes nothing: the package was already
          // updated outside Workbench after its startup check.
          return { exit: "zero", stdout: "" };
        }
        return {
          exit: "zero",
          stdout:
            installedVersion === "2.1.220"
              ? "Claude Code Anthropic.ClaudeCode 2.1.220 2.1.258\r\n"
              : "Claude Code Anthropic.ClaudeCode 2.1.258\r\n",
        };
      },
    },
  });

  await service.check();
  installedVersion = "2.1.258";

  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunFailed("no-change"),
  );
  assert.deepEqual(calls, ["list", "list", "upgrade", "list"]);
});

test("a clean winget exit with an unreadable installed result stays result-unknown", async () => {
  let listCalls = 0;
  const service = createCliUpdateService({
    resolveClaudeExecutable: async () => wingetClaude,
    resolveWingetExecutable: async () => "winget",
    runner: {
      async run(command) {
        if (command.args[0] === "upgrade") {
          return { exit: "zero", stdout: "" };
        }
        listCalls++;
        return listCalls === 1
          ? {
              exit: "zero",
              stdout:
                "Claude Code Anthropic.ClaudeCode 2.1.220 2.1.258\r\n",
            }
          : { exit: "non-zero", stderr: "source unavailable" };
      },
    },
  });

  assert.deepEqual(
    await service.run("claude-code"),
    publicCliUpdateRunFailed("result-unknown"),
  );
});
