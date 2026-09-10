import {
  WORKBENCH_CLI_UPDATE_CLI_IDS,
  publicCliUpdateCheckCompleted,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRelaunchQueued,
  publicCliUpdateRelaunchUnavailable,
  publicCliUpdateRunFailed,
  publicCliUpdateRunUnavailable,
  publicCliUpdateRunUpdated,
  type WorkbenchCliUpdateCheckReport,
  type WorkbenchCliUpdateCheckResult,
  type WorkbenchCliUpdateCliId,
  type WorkbenchCliUpdateRelaunchResult,
  type WorkbenchCliUpdateRunFailureReason,
  type WorkbenchCliUpdateRunResult,
} from "./cli-update-contract.ts";

/**
 * Renderer-boundary sanitizers for the CLI update surface (ticket 18),
 * same discipline as the history-recovery sanitizer: everything the
 * renderer sends is reconstructed from an exact plain-data shape, and
 * everything the renderer receives is re-validated and re-frozen from the
 * public constructors — hostile values fail closed to the fixed
 * unavailable results. Version strings accept only the strict version
 * charset the check module already enforces, so no arbitrary IPC payload
 * can smuggle text through a version field.
 */

const versionTokenPattern = /^[0-9]+(?:\.[0-9A-Za-z+\-]+)*$/u;
const runFailureReasons: readonly WorkbenchCliUpdateRunFailureReason[] =
  Object.freeze([
    "timeout",
    "launch-failed",
    "update-failed",
    "unsupported-install",
    "no-change",
    "result-unknown",
  ]);

export type CliUpdateReconstruction<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

const rejected = Object.freeze({ ok: false as const });

export function reconstructWorkbenchCliUpdateRunRequest(
  value: unknown,
): CliUpdateReconstruction<WorkbenchCliUpdateCliId> {
  // The preload payload is the bare validated cliId string; any object
  // (or foreign value) is rejected — the run channel takes no structured
  // input a hostile renderer could shape.
  if (
    typeof value !== "string" ||
    !(WORKBENCH_CLI_UPDATE_CLI_IDS as readonly string[]).includes(value)
  ) {
    return rejected;
  }
  return Object.freeze({
    ok: true as const,
    value: value as WorkbenchCliUpdateCliId,
  });
}

export function sanitizeWorkbenchCliUpdateCheckResult(
  value: unknown,
): WorkbenchCliUpdateCheckResult {
  try {
    if (
      isPlainDataRecord(value) &&
      hasExactKeys(value, ["ok", "reports", "status"]) &&
      value.ok === true &&
      value.status === "checked" &&
      Array.isArray(value.reports)
    ) {
      // The check always reports both CLIs, claude first: an exact-shape
      // requirement, so a truncated, reordered, or duplicated payload
      // fails closed.
      if (value.reports.length !== 2) {
        return publicCliUpdateCheckUnavailable();
      }
      const reports = value.reports.map(reconstructCheckReport);
      if (
        reports[0]!.cliId !== "claude-code" ||
        reports[1]!.cliId !== "codex" ||
        reports[1].status !== "no-check"
      ) {
        return publicCliUpdateCheckUnavailable();
      }
      return publicCliUpdateCheckCompleted(reports);
    }
    if (isUnavailableShape(value, "cli-update-check-unavailable")) {
      return publicCliUpdateCheckUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicCliUpdateCheckUnavailable();
}

export function sanitizeWorkbenchCliUpdateRunResult(
  value: unknown,
  cliId: WorkbenchCliUpdateCliId,
): WorkbenchCliUpdateRunResult {
  try {
    if (
      isPlainDataRecord(value) &&
      hasExactKeys(value, ["cliId", "ok", "status"]) &&
      value.ok === true &&
      value.status === "updated" &&
      value.cliId === cliId
    ) {
      return publicCliUpdateRunUpdated(cliId);
    }
    if (isUnavailableShape(value, "cli-update-run-unavailable")) {
      return publicCliUpdateRunUnavailable();
    }
    if (
      isPlainDataRecord(value) &&
      hasExactKeys(value, ["error", "ok"]) &&
      value.ok === false &&
      isPlainDataRecord(value.error) &&
      hasExactKeys(value.error, ["category", "message", "reason"]) &&
      value.error.category === "cli-update-run-failed" &&
      typeof value.error.reason === "string" &&
      (runFailureReasons as readonly string[]).includes(value.error.reason)
    ) {
      return publicCliUpdateRunFailed(
        value.error.reason as WorkbenchCliUpdateRunFailureReason,
      );
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicCliUpdateRunUnavailable();
}

export function sanitizeWorkbenchCliUpdateRelaunchResult(
  value: unknown,
): WorkbenchCliUpdateRelaunchResult {
  try {
    if (
      isPlainDataRecord(value) &&
      hasExactKeys(value, ["ok", "status"]) &&
      value.ok === true &&
      value.status === "queued"
    ) {
      return publicCliUpdateRelaunchQueued();
    }
    if (isUnavailableShape(value, "relaunch-unavailable")) {
      return publicCliUpdateRelaunchUnavailable();
    }
  } catch {
    // Accessor-like and proxy values fail closed at the renderer boundary.
  }
  return publicCliUpdateRelaunchUnavailable();
}

function reconstructCheckReport(value: unknown): WorkbenchCliUpdateCheckReport {
  if (!isPlainDataRecord(value)) {
    throw new Error("invalid-cli-update-check-report");
  }
  if (
    isPlainDataRecord(value) &&
    hasExactKeys(value, ["cliId", "status"]) &&
    value.cliId === "codex" &&
    value.status === "no-check"
  ) {
    return Object.freeze({ cliId: "codex", status: "no-check" });
  }
  if (value.cliId !== "claude-code") {
    throw new Error("invalid-cli-update-check-report");
  }
  if (
    hasExactKeys(value, ["cliId", "status"]) &&
    (value.status === "up-to-date" || value.status === "check-failed")
  ) {
    return Object.freeze({ cliId: "claude-code", status: value.status });
  }
  if (value.status !== "update-available") {
    throw new Error("invalid-cli-update-check-report");
  }
  if (
    !hasExactKeys(value, [
      "availableVersion",
      "cliId",
      "currentVersion",
      "status",
    ]) ||
    typeof value.currentVersion !== "string" ||
    typeof value.availableVersion !== "string" ||
    !isVersionToken(value.currentVersion) ||
    !isVersionToken(value.availableVersion)
  ) {
    throw new Error("invalid-cli-update-check-report");
  }
  return Object.freeze({
    cliId: "claude-code",
    status: "update-available",
    currentVersion: value.currentVersion,
    availableVersion: value.availableVersion,
  });
}

function isVersionToken(value: string): boolean {
  return value.length <= 32 && value.length > 0 && versionTokenPattern.test(value);
}

/**
 * Plain-data guard mirroring the repo sanitizer discipline: a frozen-shape
 * candidate must be a prototype-less-or-plain object, never an array or
 * an accessor trap.
 */
function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Exact-key check: an extra key anywhere fails the whole shape. */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => actual.includes(key));
}

/** The fixed unavailable error shape, keys and all. */
function isUnavailableShape(
  value: unknown,
  category: string,
): boolean {
  return (
    isPlainDataRecord(value) &&
    hasExactKeys(value, ["error", "ok"]) &&
    value.ok === false &&
    isPlainDataRecord(value.error) &&
    hasExactKeys(value.error, ["category", "message"]) &&
    value.error.category === category &&
    typeof value.error.message === "string"
  );
}
