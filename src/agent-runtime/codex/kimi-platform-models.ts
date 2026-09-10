/**
 * Static model roster and catalog for the kimi-platform endpoint (ticket 17).
 * Leaf module: imported by the seeding module (default model line) and the
 * catalog/context module, so it must not import either.
 *
 * The codex CLI under a custom model_provider still serves its own built-in
 * catalog through `model/list`, so the kimi-platform endpoint's Runtime
 * Catalog is provided statically here and never read from CLI probing (same
 * rule as the GLM/Kimi/DeepSeek claude-family endpoints). Model ids are the
 * platform-face full names confirmed live via `api.moonshot.cn/v1/models`
 * (ticket 11 Comments), which is also what the UI presents and what
 * `thread/start` puts on the wire.
 *
 * Effort: this ticket ships the single `default` tier only. The mapping from
 * codex's effort parameter through `wire_api = "chat"` to the platform's
 * reasoning-effort semantics is an explicit live-spike item for the
 * supervisor (ticket 17: "effort 映射待真机 spike，别猜") — no tier is
 * invented here.
 */

import type { RuntimeCatalog } from "../index.ts";

/**
 * Static roster confirmed live (ticket 11 Comments: /v1/models returned
 * exactly these). Order is the presentation order; the default is the
 * budget-discipline pick (ticket 17: acceptance on k2.7-code, ~¥0.15/turn;
 * k3 high-price tiers are never used for testing).
 */
export const KIMI_PLATFORM_MODEL_IDS = Object.freeze([
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k3",
  "kimi-k2.6",
] as const);

export type KimiPlatformModelId = (typeof KIMI_PLATFORM_MODEL_IDS)[number];

export const KIMI_PLATFORM_DEFAULT_MODEL_ID: KimiPlatformModelId =
  "kimi-k2.7-code";

export function isKimiPlatformStaticCatalogModelId(
  value: string,
): value is KimiPlatformModelId {
  return (KIMI_PLATFORM_MODEL_IDS as readonly string[]).includes(value);
}

/**
 * Effort tiers: `default` only, deliberately unpinned — the effort mapping
 * awaits the supervisor's live spike (module header). Adding tiers later is
 * a data change here plus the spike-verified native mapping.
 */
export const KIMI_PLATFORM_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "default",
]);

/** Static Runtime Catalog for the kimi-platform endpoint. */
export const KIMI_PLATFORM_STATIC_CATALOG: RuntimeCatalog = Object.freeze({
  runtime: "kimi-platform",
  models: Object.freeze(
    KIMI_PLATFORM_MODEL_IDS.map((id) =>
      Object.freeze({
        id,
        effortLevels: Object.freeze([...KIMI_PLATFORM_EFFORT_LEVELS]),
      }),
    ),
  ),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});
