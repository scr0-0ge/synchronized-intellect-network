/**
 * Kimi Code endpoint catalog and endpoint context (ticket 11, design of
 * record 2026-09-04: subscription face, plan A).
 *
 * The claude CLI under a Kimi endpoint still carries its own (claude-named)
 * built-in catalog, so the Kimi endpoint's Runtime Catalog is provided
 * statically here and never read from CLI probing. Model ids are the true
 * wire names of the Kimi Code subscription face (`api.kimi.com/coding/`),
 * which is also what the UI presents: renderer model identity comes from
 * this catalog, and the env factory injects the same names as
 * ANTHROPIC_DEFAULT_*_MODEL aliases so the wire carries them too (spec
 * section A three-layer model identity truth).
 *
 * Authentication on the Kimi Anthropic-compatible face is Bearer-only:
 * `Authorization: Bearer <KIMI_CODE_ANTHROPIC_AUTH_TOKEN>` (the Messages
 * OpenAPI declares bearerAuth only). An `x-api-key` header is NOT accepted
 * by this endpoint — any future bare-probe module for Kimi must use the
 * Bearer shape (the GLM probe's x-api-key shape is not portable here).
 * No zero-inference models-list route is verified for this subscription
 * face, so catalog freshness must not substitute either Moonshot Platform
 * `/v1/models` face: those are separate products with separate credentials
 * and model ids.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeCatalog } from "../index.ts";
import type { ClaudeEndpointContext } from "./adapter.ts";
import type { ClaudeEndpointEnvironmentResolver } from "./endpoint-env-factory.ts";

/**
 * Environment-variable contract for the Kimi Code endpoint (subscription
 * face). The token variable is Kimi-specific on purpose: an ambient
 * `ANTHROPIC_AUTH_TOKEN` must never be forwarded to the Kimi endpoint
 * (that would send an Anthropic credential to a third-party host).
 */
export const KIMI_ENDPOINT_ENV_CONTRACT = Object.freeze({
  baseUrlEnvVar: "KIMI_CODE_ANTHROPIC_BASE_URL",
  authTokenEnvVar: "KIMI_CODE_ANTHROPIC_AUTH_TOKEN",
  modelEnvVar: "KIMI_CODE_ANTHROPIC_MODEL",
  defaultBaseUrl: "https://api.kimi.com/coding/",
} as const);

/** Static roster confirmed for ticket 11 (subscription-face model ids). */
export const KIMI_MODEL_IDS = Object.freeze([
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "k3-256k",
  "k3",
] as const);

export type KimiModelId = (typeof KIMI_MODEL_IDS)[number];

/**
 * The only universally available model on the subscription face: `k3` needs
 * Moderato+ (its 1M tier Allegretto+), `kimi-for-coding-highspeed` needs
 * Allegretto+, while `kimi-for-coding` (K2.7 Code) is available to every
 * member — the only safe default (research §3, §9.6).
 */
export const KIMI_DEFAULT_MODEL_ID: KimiModelId = "kimi-for-coding";

export function isKimiStaticCatalogModelId(value: string): value is KimiModelId {
  return (KIMI_MODEL_IDS as readonly string[]).includes(value);
}

/**
 * Effort tiers per model family (ticket 11 ruling). The k3 family exposes
 * an official effort knob (`low` / `high` / `max`, documented default
 * `max`); changing the tier mid-conversation destroys prefix-cache hits,
 * so tier selection happens before a session starts. The k2.7-code family
 * (`kimi-for-coding`, `-highspeed`) has no documented effort tiers — its
 * thinking mode is forced on and cannot be disabled — so it carries the
 * single `default` tier: effort deliberately not pinned (no --effort
 * argument), the session handshake accepts whatever effective level the
 * CLI resolved.
 */
export const KIMI_K3_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "low",
  "high",
  "max",
]);

export const KIMI_K27_CODE_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "default",
]);

const KIMI_MODEL_EFFORT_TIERS: Readonly<
  Record<KimiModelId, readonly string[]>
> = Object.freeze({
  "kimi-for-coding": KIMI_K27_CODE_EFFORT_LEVELS,
  "kimi-for-coding-highspeed": KIMI_K27_CODE_EFFORT_LEVELS,
  "k3-256k": KIMI_K3_EFFORT_LEVELS,
  k3: KIMI_K3_EFFORT_LEVELS,
});

/** Static Runtime Catalog for the Kimi Code endpoint. */
export const KIMI_STATIC_CATALOG: RuntimeCatalog = Object.freeze({
  runtime: "kimi",
  models: Object.freeze(
    KIMI_MODEL_IDS.map((id) =>
      Object.freeze({
        id,
        effortLevels: Object.freeze([...KIMI_MODEL_EFFORT_TIERS[id]]),
      }),
    ),
  ),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

export interface KimiEndpointConfiguration {
  /** Explicit base URL; env override / contract default apply when absent. */
  readonly baseUrl?: string;
  /** Token source variable; the Kimi contract default applies when absent. */
  readonly authTokenEnvVar?: string;
  /**
   * Live token resolver for the endpoint secret envelope store (ADR 0022).
   * Invoked once per session start, so a key saved (or removed) in Settings
   * applies to the next spawn without reconstructing the adapter. When it
   * returns `undefined` the source environment variable is read exactly as
   * before (P2 fallback); a resolver that throws propagates loudly.
   */
  readonly resolveAuthToken?: () => string | undefined;
  /** Isolated CLAUDE_CONFIG_DIR for every Kimi spawn (required). */
  readonly configDir: string;
  /** Source environment the token/base URL are read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Profile-aware environment source for the Kimi Code endpoint. The alias
 * override names the model actually selected for the session, clamped to
 * the static catalog: a non-Kimi model id can never be injected as an
 * alias (a bogus selection is rejected by the adapter before the session
 * proceeds).
 *
 * The resolver resolves every Kimi contract value itself — base URL
 * (configuration override > `KIMI_CODE_ANTHROPIC_BASE_URL` > contract
 * default), token variable name, and the optional
 * `KIMI_CODE_ANTHROPIC_MODEL` override — and therefore always hands the
 * shared factory a fully qualified descriptor. It reuses that factory's
 * `"glm"` mode, which is the generic cleanse-then-inject arm for
 * bearer-token Anthropic-compatible endpoints (ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN + the ANTHROPIC_DEFAULT_*_MODEL truth keys), passing
 * `modelEnvVar` so the model override fallback reads the Kimi contract
 * variable (WO16 Part 2 parameterization — an ambient GLM variable can no
 * longer pin a Kimi session's model).
 */
export function createKimiEndpointEnvironmentSource(
  configuration: KimiEndpointConfiguration,
): ClaudeEndpointEnvironmentResolver {
  const sourceEnvironment = configuration.sourceEnvironment ?? process.env;
  return (context) => {
    const profileModel = context.profile?.model;
    const model =
      profileModel !== undefined && isKimiStaticCatalogModelId(profileModel)
        ? profileModel
        : KIMI_DEFAULT_MODEL_ID;
    const resolvedAuthToken = configuration.resolveAuthToken?.();
    const envModel = sourceEnvironment[KIMI_ENDPOINT_ENV_CONTRACT.modelEnvVar];
    return Object.freeze({
      mode: "glm" as const,
      baseUrl: firstNonEmpty(
        configuration.baseUrl,
        sourceEnvironment[KIMI_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar],
        KIMI_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
      ),
      authTokenEnvVar: isNonEmpty(configuration.authTokenEnvVar)
        ? configuration.authTokenEnvVar
        : KIMI_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
      modelEnvVar: KIMI_ENDPOINT_ENV_CONTRACT.modelEnvVar,
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
  return KIMI_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
}

/** The full claude-adapter endpoint context for the Kimi Code endpoint. */
export function createKimiEndpointContext(
  configuration: KimiEndpointConfiguration,
): ClaudeEndpointContext {
  return Object.freeze({
    environmentSource: createKimiEndpointEnvironmentSource(configuration),
    ...(configuration.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: configuration.sourceEnvironment }),
    authenticationMode: "api-key-static",
    staticCatalog: KIMI_STATIC_CATALOG,
  });
}

/**
 * Stable, user-scoped isolated config directory for Kimi spawns. The real
 * `~/.claude` OAuth store must never be visible to a Kimi process (spec
 * section A structural guarantee), and a fixed path keeps the directory
 * reusable instead of leaking one temp dir per spawn. Default base is
 * `%APPDATA%` (user-scoped, survives temp cleanup); non-Windows hosts
 * without APPDATA fall back to the OS temp directory.
 */
export function kimiIsolatedClaudeConfigDir(
  baseDirectory: string = process.env.APPDATA ?? tmpdir(),
): string {
  return join(baseDirectory, "synchronized-intellect-network", "kimi-claude-config");
}
