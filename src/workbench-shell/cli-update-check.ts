import { execFile } from "node:child_process";

import { discoverClaudeLaunch } from "../agent-runtime/claude/process-transport.ts";
import { discoverOfficialCodexLaunch } from "../agent-runtime/codex/process-transport.ts";
import type { WindowsRuntimeLaunch } from "../agent-runtime/windows-executable-admission.ts";
import {
  publicCliUpdateRunFailed,
  publicCliUpdateRunUpdated,
  type WorkbenchCliUpdateCheckReport,
  type WorkbenchCliUpdateCliId,
  type WorkbenchCliUpdateRunResult,
} from "./cli-update-contract.ts";

/**
 * CLI update check + update run (ticket 18; spike evidence
 * `evidence/cli-update-spike.md`; design fixed in ticket 15).
 *
 * Spawn discipline, same shape as the repo's other child-process surfaces:
 * `execFile` only (no shell), `windowsHide: true` always, a hard timeout
 * on every command, and a capped output buffer. Sanitization is by
 * construction: the command runner collapses everything a child process
 * can report (raw stdout aside, which stays inside this module) into a
 * coarse exit enum, and the only values that leave are the frozen public
 * results of `cli-update-contract.ts`. Version strings survive only after
 * a strict token check, so no arbitrary winget output can ride along.
 *
 * Check semantics: claude is checked through the read-only
 * `winget list --id Anthropic.ClaudeCode`; every failure is the retryable
 * "check-failed" state. codex has no read-only check (spike §3) and
 * reports the first-class "no-check" state. A confirmed check is memoized:
 * it runs once per process (the startup background call), and later
 * callers — including the Settings surface — receive that report. A
 * failed check is not memoized, so Settings can explain and retry it.
 *
 * Update semantics: winget-managed claude runs through winget; other
 * installs use the CLI's own `update` subcommand. The standalone Codex
 * installed by the Microsoft Store ChatGPT app runs through that Store
 * package instead: its own updater refuses the installation method even
 * though winget exposes the managing package. Updates are never called
 * automatically; the only caller is the user's Settings button via the run
 * IPC channel. Known codex install-method refusals outside the recognised
 * desktop install have their own honest result; other non-zero exits remain
 * the generic "update-failed".
 *
 * Confirmation (issue 183). A zero exit is the updater's claim, not the
 * machine's state: the winget-managed `claude update` was measured exiting
 * zero while installing nothing, and reporting that as success is the
 * owner's worst outcome — he restarts, sees the old version, and repairs
 * by hand. The winget branch therefore reads the installed version back
 * from the same read-only query the check already uses, and answers from
 * what is on disk: a changed version is "updated"; an unchanged version
 * after a clean exit is "no-change"; and a clean exit that cannot be read
 * back is "result-unknown". The read-back also drops the memo, so the
 * Settings row stops advertising the version the update just replaced
 * without waiting for a restart.
 *
 * Codex and non-winget Claude use the runtime's own fresh launch discovery
 * before and after the updater, then run that complete plan with `--version`.
 * This includes a JavaScript shim's prefix arguments and deliberately drops
 * the old plan after the updater. The answer therefore describes the version
 * a newly started Session will launch, not a CLI process that is already
 * running.
 */

/** Read-only winget query cap; the check must never hang the app. */
export const CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS = 30_000;
/**
 * Update cap: the winget-managed claude package is a single ~250 MB exe,
 * so the run timeout matches the repo's subscription-authentication
 * ceiling instead of the check ceiling.
 */
export const CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS = 600_000;

const maximumCommandOutputBytes = 1_048_576;
const wingetPackageId = "Anthropic.ClaudeCode";
const codexDesktopStoreProductId = "9PLM9XGG6VKS";
const versionTokenPattern = /^[0-9]+(?:\.[0-9A-Za-z+\-]+)*$/u;

/**
 * The coarse outcome enum every spawned command collapses into. Raw
 * errors, exit details and stderr stop here; stdout is returned only for
 * the internal winget parse and is never exposed by this module. The one
 * exception is the non-zero stderr STRING, which stays inside this module
 * for install-method classification (codex's updater states its refusal
 * there) and never leaves as text.
 */
export type CliUpdateCommandOutcome =
  | { readonly exit: "zero"; readonly stdout: string }
  | { readonly exit: "non-zero"; readonly stderr: string }
  | { readonly exit: "timeout" }
  | { readonly exit: "launch-failed" };

export interface CliUpdateCommandRunner {
  run(options: {
    readonly file: string;
    readonly args: readonly string[];
    readonly timeoutMilliseconds: number;
  }): Promise<CliUpdateCommandOutcome>;
}

export interface CliUpdateServiceOptions {
  readonly runner?: CliUpdateCommandRunner;
  /** Complete fresh Claude launch plan; defaults to runtime discovery. */
  readonly discoverClaudeLaunch?: () => Promise<WindowsRuntimeLaunch | undefined>;
  /** Complete fresh Codex launch plan; defaults to runtime discovery. */
  readonly discoverCodexLaunch?: () => Promise<WindowsRuntimeLaunch | undefined>;
  /** Native-path injection retained for existing service callers and tests. */
  readonly resolveClaudeExecutable?: () => Promise<string | undefined>;
  /** Native-path injection retained for existing service callers and tests. */
  readonly resolveCodexExecutable?: () => Promise<string | undefined>;
  /** winget executable for the read-only check; defaults to PATH lookup. */
  readonly resolveWingetExecutable?: () => Promise<string | undefined>;
  readonly checkTimeoutMilliseconds?: number;
  readonly runTimeoutMilliseconds?: number;
}

export interface CliUpdateService {
  /**
   * Memoized: the first call runs the check, later calls share its report.
   * A run that can move the installed version drops the memo and re-reads
   * it, so the next caller sees the post-update truth (issue 183). A check
   * that failed is not memoized at all, so calling again retries it rather
   * than replaying the failure until the next process (issue 184).
   */
  check(): Promise<readonly WorkbenchCliUpdateCheckReport[]>;
  run(cliId: WorkbenchCliUpdateCliId): Promise<WorkbenchCliUpdateRunResult>;
}

/**
 * The memoized check, plus the installed claude version the same query
 * reported. The version stays inside this module: it is the confirmation
 * input for a run, not something the public report carries.
 */
interface CliUpdateCheckProbe {
  readonly reports: readonly WorkbenchCliUpdateCheckReport[];
  readonly claudeInstalledVersion: string | undefined;
}

export function createCliUpdateService(
  options: CliUpdateServiceOptions = {},
): CliUpdateService {
  const runner = options.runner ?? createExecFileCommandRunner();
  const discoverClaude =
    options.discoverClaudeLaunch ??
    (options.resolveClaudeExecutable === undefined
      ? defaultDiscoverClaudeLaunch
      : nativeLaunchDiscovery(options.resolveClaudeExecutable));
  const discoverCodex =
    options.discoverCodexLaunch ??
    (options.resolveCodexExecutable === undefined
      ? defaultDiscoverCodexLaunch
      : nativeLaunchDiscovery(options.resolveCodexExecutable));
  const resolveWinget =
    options.resolveWingetExecutable ?? defaultResolveWingetExecutable;
  const checkTimeout =
    options.checkTimeoutMilliseconds ?? CLI_UPDATE_CHECK_TIMEOUT_MILLISECONDS;
  const runTimeout =
    options.runTimeoutMilliseconds ?? CLI_UPDATE_RUN_TIMEOUT_MILLISECONDS;
  let probePromise: Promise<CliUpdateCheckProbe> | null = null;

  return Object.freeze({
    async check(): Promise<readonly WorkbenchCliUpdateCheckReport[]> {
      return (await probe()).reports;
    },
    async run(
      cliId: WorkbenchCliUpdateCliId,
    ): Promise<WorkbenchCliUpdateRunResult> {
      const beforeLaunch = await discoverCliLaunch(cliId);
      if (beforeLaunch === undefined) {
        return publicCliUpdateRunFailed("launch-failed");
      }
      // A winget-managed claude cannot update itself: `claude update`
      // exits zero reporting "Claude is managed by winget" while winget
      // still offers the newer version (issue #6 comment 2.2 -- the owner
      // updated, restarted, and the check still said 2.1.220). The
      // install's own channel is the updater, so the run goes there.
      if (
        cliId === "claude-code" &&
        isWingetManagedClaudeInstall(beforeLaunch.executable)
      ) {
        const winget = await resolveWinget();
        if (winget === undefined || winget.length === 0) {
          return publicCliUpdateRunFailed("launch-failed");
        }
        // Read the version on disk immediately before this run. A confirmed
        // startup check may be hours old, and the collaborator can update the
        // package through winget while Workbench remains open. Reusing that
        // memo would misattribute the external change to this button press.
        probePromise = null;
        const before = await probe();
        const wingetOutcome = await runner.run({
          file: winget,
          args: Object.freeze([
            "upgrade",
            "--id",
            wingetPackageId,
            "--source",
            "winget",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
          ]),
          timeoutMilliseconds: runTimeout,
        });
        // The install may have moved, so the memoized report is now a
        // claim about a machine that no longer exists. Drop it and read
        // the truth back; the Settings row picks the fresh report up from
        // this same memo, which is why no restart is needed to see it.
        probePromise = null;
        const after = await probe();
        return confirmWingetClaudeRun(wingetOutcome, before, after);
      }
      // The current Windows desktop app publishes Codex through
      // ~/.codex/packages/standalone and a stable bin junction. The bundled
      // CLI refuses `codex update`, but winget identifies the app's Microsoft
      // Store package. Route the user's explicit action to that real channel,
      // then reuse the launch-plan readback below rather than trusting winget.
      if (
        cliId === "codex" &&
        isMicrosoftStoreManagedCodexInstall(beforeLaunch.executable)
      ) {
        const winget = await resolveWinget();
        if (winget === undefined || winget.length === 0) {
          return publicCliUpdateRunFailed("launch-failed");
        }
        const beforeVersion = await readLaunchPlanVersion(cliId, beforeLaunch);
        const outcome = await runner.run({
          file: winget,
          args: Object.freeze([
            "upgrade",
            "--id",
            codexDesktopStoreProductId,
            "--exact",
            "--source",
            "msstore",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
            "--include-unknown",
          ]),
          timeoutMilliseconds: runTimeout,
        });
        const afterLaunch = await discoverCliLaunch(cliId);
        const afterVersion =
          afterLaunch === undefined
            ? undefined
            : await readLaunchPlanVersion(cliId, afterLaunch);
        return confirmLaunchPlanRun(
          cliId,
          outcome,
          beforeVersion,
          afterVersion,
        );
      }
      const beforeVersion = await readLaunchPlanVersion(cliId, beforeLaunch);
      const outcome = await runner.run({
        file: beforeLaunch.executable,
        args: launchArguments(beforeLaunch, "update"),
        timeoutMilliseconds: runTimeout,
      });
      // The updater can replace a binary, a junction, or an npm entry script.
      // Discover again instead of asking the old path what happened to it.
      const afterLaunch = await discoverCliLaunch(cliId);
      const afterVersion =
        afterLaunch === undefined
          ? undefined
          : await readLaunchPlanVersion(cliId, afterLaunch);
      return confirmLaunchPlanRun(
        cliId,
        outcome,
        beforeVersion,
        afterVersion,
      );
    },
  });

  async function discoverCliLaunch(
    cliId: WorkbenchCliUpdateCliId,
  ): Promise<WindowsRuntimeLaunch | undefined> {
    try {
      return await (cliId === "claude-code" ? discoverClaude() : discoverCodex());
    } catch {
      return undefined;
    }
  }

  async function readLaunchPlanVersion(
    cliId: WorkbenchCliUpdateCliId,
    launch: WindowsRuntimeLaunch,
  ): Promise<string | undefined> {
    const outcome = await runner.run({
      file: launch.executable,
      args: launchArguments(launch, "--version"),
      timeoutMilliseconds: checkTimeout,
    });
    return outcome.exit === "zero"
      ? parseCliVersionOutput(cliId, outcome.stdout)
      : undefined;
  }

  function probe(): Promise<CliUpdateCheckProbe> {
    if (probePromise === null) {
      // Share an in-flight query, but let the next caller retry a failure.
      // An older query must not clear a newer post-run probe.
      const pending: Promise<CliUpdateCheckProbe> = runCheck().then(
        (result) => {
          if (probePromise === pending && !isConfirmedProbe(result)) {
            probePromise = null;
          }
          return result;
        },
      );
      probePromise = pending;
    }
    return probePromise;
  }

  async function runCheck(): Promise<CliUpdateCheckProbe> {
    const claude = await checkClaude();
    return Object.freeze({
      reports: Object.freeze([
        claude.report,
        Object.freeze({
          cliId: "codex" as const,
          status: "no-check" as const,
        }),
      ]),
      claudeInstalledVersion: claude.installedVersion,
    });
  }

  async function checkClaude(): Promise<ClaudeCheckProbe> {
    try {
      const winget = await resolveWinget();
      if (winget === undefined || winget.length === 0) {
        return unconfirmedCheckFailure();
      }
      const outcome = await runner.run({
        file: winget,
        args: Object.freeze([
          "list",
          "--id",
          wingetPackageId,
          "--source",
          "winget",
          "--accept-source-agreements",
          "--disable-interactivity",
        ]),
        timeoutMilliseconds: checkTimeout,
      });
      if (outcome.exit !== "zero") return unconfirmedCheckFailure();
      const parsed = parseWingetListOutput(outcome.stdout);
      if (parsed === undefined) return unconfirmedCheckFailure();
      if (parsed.status === "up-to-date") {
        return Object.freeze({
          report: Object.freeze({
            cliId: "claude-code" as const,
            status: "up-to-date" as const,
          }),
          installedVersion: parsed.currentVersion,
        });
      }
      return Object.freeze({
        report: Object.freeze({
          cliId: "claude-code" as const,
          status: "update-available" as const,
          currentVersion: parsed.currentVersion,
          availableVersion: parsed.availableVersion,
        }),
        installedVersion: parsed.currentVersion,
      });
    } catch {
      return unconfirmedCheckFailure();
    }
  }
}

function confirmLaunchPlanRun(
  cliId: WorkbenchCliUpdateCliId,
  outcome: CliUpdateCommandOutcome,
  beforeVersion: string | undefined,
  afterVersion: string | undefined,
): WorkbenchCliUpdateRunResult {
  if (beforeVersion !== undefined && afterVersion !== undefined) {
    if (beforeVersion !== afterVersion) {
      return publicCliUpdateRunUpdated(cliId);
    }
    if (outcome.exit === "zero") {
      return publicCliUpdateRunFailed("no-change");
    }
  } else {
    return publicCliUpdateRunFailed("result-unknown");
  }
  return failedCommandResult(cliId, outcome);
}

function failedCommandResult(
  cliId: WorkbenchCliUpdateCliId,
  outcome: CliUpdateCommandOutcome,
): WorkbenchCliUpdateRunResult {
  switch (outcome.exit) {
    case "zero":
      return publicCliUpdateRunFailed("result-unknown");
    case "timeout":
      return publicCliUpdateRunFailed("timeout");
    case "launch-failed":
      return publicCliUpdateRunFailed("launch-failed");
    default:
      return publicCliUpdateRunFailed(
        isUnsupportedCodexInstall(cliId, outcome)
          ? "unsupported-install"
          : "update-failed",
      );
  }
}

function isUnsupportedCodexInstall(
  cliId: WorkbenchCliUpdateCliId,
  outcome: CliUpdateCommandOutcome,
): boolean {
  return (
    cliId === "codex" &&
    outcome.exit === "non-zero" &&
    outcome.stderr.includes("Could not detect the Codex installation method")
  );
}

function launchArguments(
  launch: WindowsRuntimeLaunch,
  argument: "--version" | "update",
): readonly string[] {
  return Object.freeze([...launch.prefixArguments, argument]);
}

/** Parse only the two version lines emitted by the supported CLIs. */
export function parseCliVersionOutput(
  cliId: WorkbenchCliUpdateCliId,
  output: string,
): string | undefined {
  const line = output.trim();
  const matched =
    cliId === "codex"
      ? /^codex-cli (\S+)$/u.exec(line)
      : /^(\S+) \(Claude Code\)$/u.exec(line);
  const version = matched?.[1];
  return version !== undefined && isVersionToken(version) ? version : undefined;
}

/** One claude check: the public report plus the version behind it. */
interface ClaudeCheckProbe {
  readonly report: WorkbenchCliUpdateCheckReport;
  readonly installedVersion: string | undefined;
}

/**
 * Answer a winget upgrade from the machine rather than from the command.
 * A version that moved is an update whatever the exit code claimed; a
 * version that did not move after a clean exit is the "no-change" the
 * owner was never told about. A clean exit without both readable versions
 * is explicitly result-unknown: the exit code is never accepted as evidence
 * that an update happened. A launch failure also cannot claim an update if
 * another process happened to move the version during the read window.
 */
function confirmWingetClaudeRun(
  outcome: CliUpdateCommandOutcome,
  before: CliUpdateCheckProbe,
  after: CliUpdateCheckProbe,
): WorkbenchCliUpdateRunResult {
  const installedBefore = before.claudeInstalledVersion;
  const installedAfter = after.claudeInstalledVersion;
  if (installedBefore !== undefined && installedAfter !== undefined) {
    if (
      installedAfter !== installedBefore &&
      outcome.exit !== "launch-failed"
    ) {
      return publicCliUpdateRunUpdated("claude-code");
    }
    if (outcome.exit === "zero") {
      return publicCliUpdateRunFailed("no-change");
    }
  }
  switch (outcome.exit) {
    case "zero":
      return publicCliUpdateRunFailed("result-unknown");
    case "timeout":
      return publicCliUpdateRunFailed("timeout");
    case "launch-failed":
      return publicCliUpdateRunFailed("launch-failed");
    default:
      return publicCliUpdateRunFailed("update-failed");
  }
}

/**
 * True when the check actually reached the machine. The codex report is
 * the constant "no-check" capability state, so claude's report is the
 * whole question: "check-failed" is the one outcome that learned nothing.
 */
function isConfirmedProbe(probe: CliUpdateCheckProbe): boolean {
  return !probe.reports.some(
    (report) =>
      report.cliId === "claude-code" && report.status === "check-failed",
  );
}

function unconfirmedCheckFailure(): ClaudeCheckProbe {
  return Object.freeze({
    report: claudeCheckFailed(),
    installedVersion: undefined,
  });
}

function claudeCheckFailed(): WorkbenchCliUpdateCheckReport {
  return Object.freeze({
    cliId: "claude-code" as const,
    status: "check-failed" as const,
  });
}

/**
 * Parse the read-only `winget list --id Anthropic.ClaudeCode` output.
 * Anchored on the package id token so localized headers (spike saw
 * 版本/可用) and display names containing spaces cannot shift the parse;
 * version tokens must pass the strict version charset or the whole check
 * degrades to the silent failure. Returns undefined for anything that is
 * not exactly one parsed data row.
 *
 * `currentVersion` rides on both states because it is what an update run
 * confirms itself against (issue 183): the up-to-date row is exactly the
 * shape a successful upgrade produces, so dropping the version there would
 * throw away the only evidence that the upgrade landed. Measured on the
 * owner's machine 2026-09-07: `Claude Code Anthropic.ClaudeCode 2.1.263`.
 */
export function parseWingetListOutput(
  output: string,
):
  | {
      readonly status: "update-available";
      readonly currentVersion: string;
      readonly availableVersion: string;
    }
  | { readonly status: "up-to-date"; readonly currentVersion: string }
  | undefined {
  const dataLine = output
    .split(/\r?\n/u)
    .find((line) => line.includes(wingetPackageId));
  if (dataLine === undefined) return undefined;
  const tokens = dataLine.trim().split(/\s+/u);
  const idIndex = tokens.indexOf(wingetPackageId);
  if (idIndex === -1) return undefined;
  const rest = tokens.slice(idIndex + 1);
  if (rest.length === 0 || !isVersionToken(rest[0]!)) return undefined;
  const currentVersion = rest[0]!;
  if (rest.length === 1) return { status: "up-to-date", currentVersion };
  if (!isVersionToken(rest[1]!)) return undefined;
  const availableVersion = rest[1]!;
  return availableVersion === currentVersion
    ? { status: "up-to-date", currentVersion }
    : { status: "update-available", currentVersion, availableVersion };
}

function isVersionToken(value: string): boolean {
  return value.length <= 32 && versionTokenPattern.test(value);
}

/**
 * True when the claude executable lives in a winget-managed package root
 * (`%LOCALAPPDATA%\Microsoft\WinGet\Packages\...`). Path-shape detection,
 * case-insensitive on Windows: the winget root is the only place that
 * spelling appears, and the CLI itself confirms the management ("Claude is
 * managed by winget") when run from there.
 */
export function isWingetManagedClaudeInstall(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const normalized = executable.replaceAll("/", "\\").toLowerCase();
  return normalized.includes("\\microsoft\\winget\\packages\\");
}

/**
 * The native launch discovery resolves the desktop app's stable bin junction,
 * so production normally reaches the versioned standalone release path. Keep
 * the stable junction shape too for injected/configured launch plans.
 */
export function isMicrosoftStoreManagedCodexInstall(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const normalized = executable.replaceAll("/", "\\").toLowerCase();
  return (
    /\\\.codex\\packages\\standalone\\(?:current|releases\\[^\\]+)\\bin\\codex\.exe$/u.test(
      normalized,
    ) ||
    normalized.endsWith(
      "\\appdata\\local\\programs\\openai\\codex\\bin\\codex.exe",
    )
  );
}

/**
 * execFile adapter: no shell, hidden window, capped buffer, coarse exits.
 * The non-zero exit keeps the raw stderr string for this module's own
 * install-method classification only; it is never exposed further.
 */
export function createExecFileCommandRunner(
  spawnImplementation: ExecFileCallbackImplementation = (file, args, options, callback) => {
    execFile(
      file,
      [...args],
      options,
      (error, stdout, stderr) => callback(error, stdout, stderr),
    );
  },
): CliUpdateCommandRunner {
  return Object.freeze({
    run(command: {
      readonly file: string;
      readonly args: readonly string[];
      readonly timeoutMilliseconds: number;
    }) {
      return new Promise<CliUpdateCommandOutcome>((resolveOutcome) => {
        spawnImplementation(
          command.file,
          [...command.args],
          {
            windowsHide: true,
            timeout: command.timeoutMilliseconds,
            maxBuffer: maximumCommandOutputBytes,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolveOutcome({ exit: "zero", stdout });
              return;
            }
            if (isTimeoutExit(error)) {
              resolveOutcome({ exit: "timeout" });
              return;
            }
            if (isLaunchExit(error)) {
              resolveOutcome({ exit: "launch-failed" });
              return;
            }
            resolveOutcome({
              exit: "non-zero",
              stderr:
                typeof stderr === "string"
                  ? stderr
                  : typeof error.stderr === "string"
                    ? error.stderr
                    : "",
            });
          },
        );
      });
    },
  });
}

/**
 * The injectable child-process seam: production adapts node's execFile
 * (shell-less, hidden window); tests inject fakes so no real command is
 * ever spawned from the suite.
 */
export interface ExecFileCallbackImplementation {
  (
    file: string,
    args: readonly string[],
    options: {
      readonly windowsHide: true;
      readonly timeout: number;
      readonly maxBuffer: number;
      readonly encoding: "utf8";
    },
    callback: (
      error: Error & {
        readonly code?: unknown;
        readonly killed?: unknown;
        readonly signal?: unknown;
        readonly stderr?: unknown;
      } | null,
      stdout: string,
      stderr?: string,
    ) => void,
  ): void;
}

function isTimeoutExit(
  error: Error & {
    readonly code?: unknown;
    readonly killed?: unknown;
    readonly signal?: unknown;
  },
): boolean {
  return (
    error.killed === true &&
    error.signal === "SIGTERM" &&
    error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function isLaunchExit(
  error: Error & {
    readonly code?: unknown;
    readonly killed?: unknown;
    readonly signal?: unknown;
  },
): boolean {
  return (
    error.code === "ENOENT" &&
    error.killed !== true &&
    (error.signal === null || error.signal === undefined)
  );
}

function nativeLaunchDiscovery(
  resolveExecutable: () => Promise<string | undefined>,
): () => Promise<WindowsRuntimeLaunch | undefined> {
  return async () => {
    const executable = await resolveExecutable();
    return executable === undefined || executable.length === 0
      ? undefined
      : Object.freeze({
          executable,
          prefixArguments: Object.freeze([]),
        });
  };
}

async function defaultDiscoverClaudeLaunch(): Promise<WindowsRuntimeLaunch | undefined> {
  try {
    return await discoverClaudeLaunch();
  } catch {
    return undefined;
  }
}

async function defaultDiscoverCodexLaunch(): Promise<WindowsRuntimeLaunch | undefined> {
  try {
    return await discoverOfficialCodexLaunch();
  } catch {
    return undefined;
  }
}

async function defaultResolveWingetExecutable(): Promise<string | undefined> {
  return "winget";
}
