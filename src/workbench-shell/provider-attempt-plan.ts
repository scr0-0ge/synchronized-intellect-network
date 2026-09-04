import { types as nodeUtilTypes } from "node:util";

export const PROVIDER_ATTEMPT_PROTOCOL = "provider-request-budget-v1" as const;
export const PROVIDER_ATTEMPT_BUILD_MARKER =
  "provider-request-budget-v1.2026-08-14" as const;
export const PROVIDER_ATTEMPT_OPERATION_LIMIT = 24 as const;

export type ProviderAttemptRoundName =
  | "independent-headless"
  | "item-4-lazy-picker"
  | "positive-continuation-composition"
  | "positive-new-session-explicit-refresh";

export interface ProviderAttemptBounds {
  readonly minimum: number;
  readonly maximum: number;
}

export interface ProviderAttemptPlan {
  readonly protocol: typeof PROVIDER_ATTEMPT_PROTOCOL;
  readonly buildMarker: typeof PROVIDER_ATTEMPT_BUILD_MARKER;
  readonly mode: "default";
  readonly operationLimit: typeof PROVIDER_ATTEMPT_OPERATION_LIMIT;
  readonly bounds: Readonly<{
    minimum: 20;
    maximum: 24;
    codexMinimum: 12;
    codexMaximum: 16;
    claudeMinimum: 8;
    claudeMaximum: 8;
  }>;
  readonly rounds: readonly Readonly<{
    name: ProviderAttemptRoundName;
    minimum: 5;
    maximum: 6;
  }>[];
}

export type ProviderAttemptPreflightResult =
  | { readonly ok: true; readonly plan: ProviderAttemptPlan }
  | {
      readonly ok: false;
      readonly error:
        | Readonly<{
            category: "invalid-attempt-input" | "build-marker-mismatch";
          }>
        | Readonly<{
            category: "attempt-budget-exceeded";
            bounds: ProviderAttemptBounds;
            operationLimit: typeof PROVIDER_ATTEMPT_OPERATION_LIMIT;
          }>;
    };

const defaultRounds = Object.freeze([
  frozenRound("independent-headless"),
  frozenRound("item-4-lazy-picker"),
  frozenRound("positive-continuation-composition"),
  frozenRound("positive-new-session-explicit-refresh"),
]);

const defaultPlan: ProviderAttemptPlan = Object.freeze({
  protocol: PROVIDER_ATTEMPT_PROTOCOL,
  buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  mode: "default" as const,
  operationLimit: PROVIDER_ATTEMPT_OPERATION_LIMIT,
  bounds: Object.freeze({
    minimum: 20 as const,
    maximum: 24 as const,
    codexMinimum: 12 as const,
    codexMaximum: 16 as const,
    claudeMinimum: 8 as const,
    claudeMaximum: 8 as const,
  }),
  rounds: defaultRounds,
});

export function preflightProviderAttempt(
  input: unknown,
): ProviderAttemptPreflightResult {
  if (
    !isExactDataRecord(input, [
      "distBuildMarker",
      "f102CaptureMode",
      "liveClaudeMode",
      "sourceBuildMarker",
    ]) ||
    (input.liveClaudeMode !== undefined &&
      input.liveClaudeMode !== "isolated-fixed-marker") ||
    (input.f102CaptureMode !== undefined &&
      input.f102CaptureMode !== "before" &&
      input.f102CaptureMode !== "after") ||
    typeof input.sourceBuildMarker !== "string" ||
    typeof input.distBuildMarker !== "string"
  ) {
    return rejected("invalid-attempt-input");
  }
  if (
    input.sourceBuildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER ||
    input.distBuildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER
  ) {
    return rejected("build-marker-mismatch");
  }

  const liveClaude = input.liveClaudeMode === "isolated-fixed-marker";
  const f102 = input.f102CaptureMode !== undefined;
  if (liveClaude || f102) {
    const bounds = liveClaude
      ? f102
        ? frozenBounds(31, 36)
        : frozenBounds(23, 27)
      : frozenBounds(28, 33);
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        category: "attempt-budget-exceeded" as const,
        bounds,
        operationLimit: PROVIDER_ATTEMPT_OPERATION_LIMIT,
      }),
    });
  }
  return Object.freeze({ ok: true as const, plan: defaultPlan });
}

export function detectProviderAttemptBuildMarker(
  bundledMainSource: unknown,
): typeof PROVIDER_ATTEMPT_BUILD_MARKER | undefined {
  if (
    typeof bundledMainSource !== "string" ||
    bundledMainSource.length === 0 ||
    bundledMainSource.length > 16 * 1024 * 1024
  ) {
    return undefined;
  }
  const first = bundledMainSource.indexOf(PROVIDER_ATTEMPT_BUILD_MARKER);
  return first >= 0 &&
    first === bundledMainSource.lastIndexOf(PROVIDER_ATTEMPT_BUILD_MARKER)
    ? PROVIDER_ATTEMPT_BUILD_MARKER
    : undefined;
}

function frozenRound(name: ProviderAttemptRoundName) {
  return Object.freeze({
    name,
    minimum: 5 as const,
    maximum: 6 as const,
  });
}

function frozenBounds(
  minimum: number,
  maximum: number,
): ProviderAttemptBounds {
  return Object.freeze({ minimum, maximum });
}

function rejected(
  category: "invalid-attempt-input" | "build-marker-mismatch",
): ProviderAttemptPreflightResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ category }),
  });
}

function isExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      keys.every(
        (key) => typeof key === "string" && expectedKeys.includes(key),
      ) &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          Object.prototype.hasOwnProperty.call(descriptor, "value")
        );
      })
    );
  } catch {
    return false;
  }
}
