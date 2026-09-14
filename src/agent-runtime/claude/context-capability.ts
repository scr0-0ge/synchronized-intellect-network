import type { Clock } from "../../coordinator/auto-iteration/clock.ts";

export type ClaudeContextUsageQuality =
  | "authoritative"
  | "estimated"
  | "unknown";

export interface ClaudeContextUsageObservation {
  readonly source: "claude-control:get_context_usage";
  readonly observedAt: number;
  readonly sessionId: string;
  readonly model: string;
  readonly quality: ClaudeContextUsageQuality;
  readonly totalTokens: number | null;
  readonly maxTokens: number | null;
  readonly fraction: number | null;
}

export type ClaudeContextControlRequest = (
  request: Readonly<{ subtype: "get_context_usage" }>,
) => Promise<unknown>;

export interface ObserveClaudeContextUsageOptions {
  readonly sessionId: string;
  readonly model: string;
  readonly clock: Clock;
  /** Must be bound to the live Session before its terminal binding closes. */
  readonly request: ClaudeContextControlRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownObservation(
  options: ObserveClaudeContextUsageOptions,
  observedAt: number,
): ClaudeContextUsageObservation {
  return Object.freeze({
    source: "claude-control:get_context_usage",
    observedAt,
    sessionId: options.sessionId,
    model: options.model,
    quality: "unknown",
    totalTokens: null,
    maxTokens: null,
    fraction: null,
  });
}

/**
 * Reads the two same-source values used by rotation. It deliberately ignores
 * the Runtime's percentage and auto-compaction threshold: neither is the
 * owner-approved totalTokens/maxTokens ratio.
 */
export async function observeClaudeContextUsage(
  options: ObserveClaudeContextUsageOptions,
): Promise<ClaudeContextUsageObservation> {
  let value: unknown;
  try {
    value = await options.request({ subtype: "get_context_usage" });
  } catch {
    return unknownObservation(options, options.clock.now());
  }
  const observedAt = options.clock.now();
  if (!isRecord(value)) return unknownObservation(options, observedAt);

  const { totalTokens, maxTokens, model } = value;
  if (
    typeof totalTokens !== "number" ||
    !Number.isSafeInteger(totalTokens) ||
    totalTokens < 0 ||
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    totalTokens > maxTokens ||
    model !== options.model
  ) {
    return unknownObservation(options, observedAt);
  }

  return Object.freeze({
    source: "claude-control:get_context_usage",
    observedAt,
    sessionId: options.sessionId,
    model: options.model,
    quality: "authoritative",
    totalTokens,
    maxTokens,
    fraction: totalTokens / maxTokens,
  });
}

/**
 * Selects a structured modelUsage window only by the active model identity.
 * It never uses insertion order or substitutes the largest advertised window.
 */
export function selectClaudeActiveModelWindow(
  modelUsage: unknown,
  activeModel: string,
): number | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const entry = modelUsage[activeModel];
  if (!isRecord(entry)) return undefined;
  const value = entry.contextWindow;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}
