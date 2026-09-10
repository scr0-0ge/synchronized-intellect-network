/**
 * DeepSeek API endpoint catalog and endpoint context (ticket 12, design of
 * record 2026-09-04: single pay-as-you-go instance, no subscription face —
 * the id deliberately carries no "plan").
 *
 * The claude CLI under a DeepSeek endpoint still carries its own
 * (claude-named) built-in catalog, so the DeepSeek endpoint's Runtime
 * Catalog is provided statically here and never read from CLI probing.
 * Model ids are the true wire names of the DeepSeek Anthropic-compatible
 * face (`https://api.deepseek.com/anthropic`), which is also what the UI
 * presents: renderer model identity comes from this catalog, and the env
 * factory injects the same names as ANTHROPIC_DEFAULT_*_MODEL aliases so
 * the wire carries them too (spec section A three-layer model identity
 * truth).
 *
 * HARD DESIGN CONSTRAINT — silent model mapping. The DeepSeek
 * Anthropic-compatible endpoint does NOT reject unknown model names: it
 * silently maps them to `deepseek-v4-flash` (`claude-opus*` → pro,
 * `claude-haiku*`/`claude-sonnet*` and ANY unrecognized name → flash,
 * never a 400). Two consequences that this module exists to enforce:
 *
 * 1. The GLM "bogus name is rejected with 400" negative-control
 *    acceptance method is NOT portable to DeepSeek — a misspelled
 *    injection does not fail loudly, it silently downgrades the session
 *    to flash.
 * 2. Model-identity truth therefore rests entirely on the static catalog
 *    + profile-aware clamping + the three-slot alias injection below
 *    (a claude name can never reach the wire), plus the get_settings
 *    echo verification the wiring ticket must add (work orders for this
 *    endpoint must include an "alias injection echoes the true name in
 *    the CLI" verification item).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeCatalog } from "../index.ts";
import type { ClaudeEndpointContext } from "./adapter.ts";
import type { ClaudeEndpointEnvironmentResolver } from "./endpoint-env-factory.ts";

/**
 * Environment-variable contract for the DeepSeek API endpoint. The token
 * variable is DeepSeek-specific on purpose and deliberately distinct from
 * the vendor-documented `DEEPSEEK_API_KEY`: an ambient vendor key must be
 * opted in explicitly, never scooped up implicitly (same reasoning as GLM
 * not reading `ANTHROPIC_AUTH_TOKEN`).
 */
export const DEEPSEEK_ENDPOINT_ENV_CONTRACT = Object.freeze({
  baseUrlEnvVar: "DEEPSEEK_ANTHROPIC_BASE_URL",
  authTokenEnvVar: "DEEPSEEK_ANTHROPIC_AUTH_TOKEN",
  modelEnvVar: "DEEPSEEK_ANTHROPIC_MODEL",
  defaultBaseUrl: "https://api.deepseek.com/anthropic",
} as const);

/** Static roster confirmed for ticket 12. */
export const DEEPSEEK_MODEL_IDS = Object.freeze([
  "deepseek-v4-pro[1m]",
  "deepseek-v4-flash",
] as const);

export type DeepseekModelId = (typeof DEEPSEEK_MODEL_IDS)[number];

/**
 * `deepseek-v4-pro[1m]` is the default (the vendor's own Claude Code guide
 * main-dialogue tier); `deepseek-v4-flash` is the light/fast tier.
 * `deepseek-v4-flash-vision-exp` is deliberately NOT catalogued
 * (experimental, incomplete feature set).
 */
export const DEEPSEEK_DEFAULT_MODEL_ID: DeepseekModelId = "deepseek-v4-pro[1m]";

export function isDeepseekStaticCatalogModelId(
  value: string,
): value is DeepseekModelId {
  return (DEEPSEEK_MODEL_IDS as readonly string[]).includes(value);
}

/**
 * Effort tiers for both catalogued models (ticket 12 ruling): the
 * Anthropic-face `reasoning.effort` knob accepts `low` / `high` / `max`
 * (documented default `high`; thinking is enabled by default). There is
 * deliberately NO `default` tier on this endpoint: effort is always
 * pinned explicitly, so a session can never fall back to an unpinned
 * level whose effective value would be unobservable from the Workbench.
 */
export const DEEPSEEK_MODEL_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "low",
  "high",
  "max",
]);

/** Static Runtime Catalog for the DeepSeek API endpoint. */
export const DEEPSEEK_STATIC_CATALOG: RuntimeCatalog = Object.freeze({
  runtime: "deepseek",
  models: Object.freeze(
    DEEPSEEK_MODEL_IDS.map((id) =>
      Object.freeze({
        id,
        effortLevels: Object.freeze([...DEEPSEEK_MODEL_EFFORT_LEVELS]),
      }),
    ),
  ),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

export interface DeepseekEndpointConfiguration {
  /** Explicit base URL; env override / contract default apply when absent. */
  readonly baseUrl?: string;
  /** Token source variable; the DeepSeek contract default applies when absent. */
  readonly authTokenEnvVar?: string;
  /**
   * Live token resolver for the endpoint secret envelope store (ADR 0022).
   * Invoked once per session start, so a key saved (or removed) in Settings
   * applies to the next spawn without reconstructing the adapter. When it
   * returns `undefined` the source environment variable is read exactly as
   * before (P2 fallback); a resolver that throws propagates loudly.
   */
  readonly resolveAuthToken?: () => string | undefined;
  /** Isolated CLAUDE_CONFIG_DIR for every DeepSeek spawn (required). */
  readonly configDir: string;
  /** Source environment the token/base URL are read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Profile-aware environment source for the DeepSeek API endpoint. The
 * alias override names the model actually selected for the session,
 * clamped to the static catalog: a non-DeepSeek model id can never be
 * injected as an alias (a bogus selection is rejected by the adapter
 * before the session proceeds). Because the endpoint silently maps
 * unknown names to flash instead of rejecting them, this clamping is not
 * a nicety but the ONLY structural guarantee that a claude name never
 * reaches the wire (see the module header's hard design constraint).
 *
 * The resolver resolves every DeepSeek contract value itself — base URL
 * (configuration override > `DEEPSEEK_ANTHROPIC_BASE_URL` > contract
 * default), token variable name, and the optional
 * `DEEPSEEK_ANTHROPIC_MODEL` override — and therefore always hands the
 * shared factory a fully qualified descriptor. It reuses that factory's
 * `"glm"` mode, which is the generic cleanse-then-inject arm for
 * bearer-token Anthropic-compatible endpoints (ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN + the ANTHROPIC_DEFAULT_*_MODEL truth keys), passing
 * `modelEnvVar` so the model override fallback reads the DeepSeek contract
 * variable (WO16 Part 2 parameterization — an ambient GLM variable can no
 * longer pin a DeepSeek session's model; with this endpoint's silent model
 * mapping, model identity truth is a structural guarantee, not a nicety).
 */
export function createDeepseekEndpointEnvironmentSource(
  configuration: DeepseekEndpointConfiguration,
): ClaudeEndpointEnvironmentResolver {
  const sourceEnvironment = configuration.sourceEnvironment ?? process.env;
  return (context) => {
    const profileModel = context.profile?.model;
    const model =
      profileModel !== undefined &&
      isDeepseekStaticCatalogModelId(profileModel)
        ? profileModel
        : DEEPSEEK_DEFAULT_MODEL_ID;
    const resolvedAuthToken = configuration.resolveAuthToken?.();
    const envModel =
      sourceEnvironment[DEEPSEEK_ENDPOINT_ENV_CONTRACT.modelEnvVar];
    return Object.freeze({
      mode: "glm" as const,
      baseUrl: firstNonEmpty(
        configuration.baseUrl,
        sourceEnvironment[DEEPSEEK_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar],
        DEEPSEEK_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
      ),
      authTokenEnvVar: isNonEmpty(configuration.authTokenEnvVar)
        ? configuration.authTokenEnvVar
        : DEEPSEEK_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
      modelEnvVar: DEEPSEEK_ENDPOINT_ENV_CONTRACT.modelEnvVar,
      ...(resolvedAuthToken === undefined
        ? {}
        : { authToken: resolvedAuthToken }),
      ...(isNonEmpty(envModel) ? { model: envModel } : {}),
      defaultAliasModels: Object.freeze({
        opus: model,
        sonnet: model,
        haiku: model,
      }),
      configDir: configuration.configDir,
    });
  };
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmpty(
  ...values: (string | undefined)[]
): string {
  for (const value of values) {
    if (isNonEmpty(value)) return value;
  }
  return DEEPSEEK_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
}

/** The full claude-adapter endpoint context for the DeepSeek API endpoint. */
export function createDeepseekEndpointContext(
  configuration: DeepseekEndpointConfiguration,
): ClaudeEndpointContext {
  return Object.freeze({
    environmentSource: createDeepseekEndpointEnvironmentSource(configuration),
    ...(configuration.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: configuration.sourceEnvironment }),
    authenticationMode: "api-key-static",
    staticCatalog: DEEPSEEK_STATIC_CATALOG,
  });
}

/**
 * Stable, user-scoped isolated config directory for DeepSeek spawns. The
 * real `~/.claude` OAuth store must never be visible to a DeepSeek
 * process (spec section A structural guarantee), and a fixed path keeps
 * the directory reusable instead of leaking one temp dir per spawn.
 * Default base is `%APPDATA%` (user-scoped, survives temp cleanup);
 * non-Windows hosts without APPDATA fall back to the OS temp directory.
 */
export function deepseekIsolatedClaudeConfigDir(
  baseDirectory: string = process.env.APPDATA ?? tmpdir(),
): string {
  return join(
    baseDirectory,
    "synchronized-intellect-network",
    "deepseek-claude-config",
  );
}
