/**
 * Static model roster and catalog for the codex-api endpoint (ticket 21,
 * charter completion: the real OpenAI backend through the codex CLI in an
 * isolated CODEX_HOME). Leaf module: imported by the seeding module (default
 * model line) and the catalog/context module, so it must not import either.
 *
 * The codex CLI serves its own built-in catalog through `model/list`, but a
 * static-catalog endpoint never probes the CLI for model identity (same rule
 * as every static endpoint since GLM). The ids below are real gpt-5.x family
 * wire names with their real reasoning-effort sets, as observed from real
 * `model/list` reads recorded by this repo's fixtures (tests/agent-runtime/
 * fixtures/catalog-success.jsonl: gpt-5.6-sol high/ultra, gpt-5.5-codex
 * medium/high; gpt-5.6-codex medium/high) — the same names `thread/start`
 * puts on the wire and the UI presents.
 *
 * Effort: only REAL provider effort values appear here (no `default`
 * unpinned tier), so the codex binding forwards each tier verbatim — no
 * per-endpoint effort mapping is needed on this endpoint.
 */

import type { RuntimeCatalog } from "../index.ts";

/** Static roster: real gpt-5.x family ids from real model/list reads. */
export const CODEX_API_MODEL_IDS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-codex",
  "gpt-5.5-codex",
] as const);

export type CodexApiModelId = (typeof CODEX_API_MODEL_IDS)[number];

/** The budget-discipline default: the same pick as codex-desktop. */
export const CODEX_API_DEFAULT_MODEL_ID: CodexApiModelId = "gpt-5.6-sol";

export function isCodexApiStaticCatalogModelId(
  value: string,
): value is CodexApiModelId {
  return (CODEX_API_MODEL_IDS as readonly string[]).includes(value);
}

const CODEX_API_SOL_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "high",
  "ultra",
]);

const CODEX_API_CODEX_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "medium",
  "high",
]);

const CODEX_API_MODEL_EFFORT_TIERS: Readonly<
  Record<CodexApiModelId, readonly string[]>
> = Object.freeze({
  "gpt-5.6-sol": CODEX_API_SOL_EFFORT_LEVELS,
  "gpt-5.6-codex": CODEX_API_CODEX_EFFORT_LEVELS,
  "gpt-5.5-codex": CODEX_API_CODEX_EFFORT_LEVELS,
});

/** Static Runtime Catalog for the codex-api endpoint. */
export const CODEX_API_STATIC_CATALOG: RuntimeCatalog = Object.freeze({
  runtime: "codex-api",
  models: Object.freeze(
    CODEX_API_MODEL_IDS.map((id) =>
      Object.freeze({
        id,
        effortLevels: Object.freeze([...CODEX_API_MODEL_EFFORT_TIERS[id]]),
      }),
    ),
  ),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});
