import type { Clock } from "../../coordinator/auto-iteration/clock.ts";
import type {
  QuotaObservation,
  QuotaWindowObservation,
} from "../../coordinator/auto-iteration/quota-pool.ts";

export type CodexAppServerRequest = (
  method: "account/rateLimits/read",
  params: null,
) => Promise<unknown>;

export interface ObserveCodexAccountRateLimitsOptions {
  readonly quotaPoolId: string;
  readonly clock: Clock;
  readonly request: CodexAppServerRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWindow(
  name: "primary" | "secondary",
  value: unknown,
): QuotaWindowObservation | undefined {
  if (value === null) {
    return Object.freeze({
      name,
      usedFraction: null,
      resetsAt: null,
      windowDurationMinutes: null,
    });
  }
  if (!isRecord(value)) return undefined;
  const usedPercent = value.usedPercent;
  const resetsAt = value.resetsAt;
  const windowDurationMinutes = value.windowDurationMins;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof resetsAt !== "number" ||
    !Number.isSafeInteger(resetsAt) ||
    resetsAt <= 0 ||
    typeof windowDurationMinutes !== "number" ||
    !Number.isSafeInteger(windowDurationMinutes) ||
    windowDurationMinutes <= 0
  ) {
    return undefined;
  }
  const resetsAtMilliseconds = resetsAt * 1_000;
  if (!Number.isSafeInteger(resetsAtMilliseconds)) return undefined;
  return Object.freeze({
    name,
    usedFraction: usedPercent / 100,
    resetsAt: resetsAtMilliseconds,
    windowDurationMinutes,
  });
}

function unknownObservation(
  options: ObserveCodexAccountRateLimitsOptions,
  observedAt: number,
): QuotaObservation {
  return Object.freeze({
    quotaPoolId: options.quotaPoolId,
    source: "codex-account:account/rateLimits/read",
    observedAt,
    status: "unknown",
    windows: Object.freeze([]),
  });
}

/** Maps one zero-inference app-server read into the shared-account pool shape. */
export async function observeCodexAccountRateLimits(
  options: ObserveCodexAccountRateLimitsOptions,
): Promise<QuotaObservation> {
  let value: unknown;
  try {
    value = await options.request("account/rateLimits/read", null);
  } catch {
    return unknownObservation(options, options.clock.now());
  }
  const observedAt = options.clock.now();
  if (!isRecord(value) || !isRecord(value.rateLimits)) {
    return unknownObservation(options, observedAt);
  }
  const primary = readWindow("primary", value.rateLimits.primary);
  const secondary = readWindow("secondary", value.rateLimits.secondary);
  if (primary === undefined || secondary === undefined) {
    return unknownObservation(options, observedAt);
  }
  return Object.freeze({
    quotaPoolId: options.quotaPoolId,
    source: "codex-account:account/rateLimits/read",
    observedAt,
    status: "observed",
    windows: Object.freeze([primary, secondary]),
  });
}
