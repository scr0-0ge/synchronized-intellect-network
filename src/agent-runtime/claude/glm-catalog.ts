/**
 * GLM Coding Plan endpoint catalog and endpoint context (spec section C).
 *
 * The claude CLI under a GLM endpoint still carries its own (claude-named)
 * built-in catalog, so the GLM endpoint's Runtime Catalog is provided
 * statically here and never read from CLI probing. Model ids are the true
 * wire names (Zhipu Anthropic-compatible endpoint), which is also what the
 * UI presents: renderer model identity comes from this catalog, and the env
 * factory injects the same names as ANTHROPIC_DEFAULT_*_MODEL aliases so the
 * wire carries them too (spec section A three-layer model identity truth).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeCatalog } from "../index.ts";
import type { ClaudeEndpointContext } from "./adapter.ts";
import type { ClaudeEndpointEnvironmentResolver } from "./endpoint-env-factory.ts";
import { GLM_ENDPOINT_ENV_CONTRACT } from "./endpoint-env-factory.ts";

/** Static roster confirmed for P2 (ticket 05). */
export const GLM_MODEL_IDS = Object.freeze([
  "glm-5.3[1m]",
  "glm-5.3-flash[1m]",
] as const);

export type GlmModelId = (typeof GLM_MODEL_IDS)[number];

export const GLM_DEFAULT_MODEL_ID: GlmModelId = "glm-5.3[1m]";

export function isGlmStaticCatalogModelId(value: string): value is GlmModelId {
  return (GLM_MODEL_IDS as readonly string[]).includes(value);
}

/**
 * Static Runtime Catalog for the GLM endpoint. Effort tiers are the owner's
 * four-tier ruling (2026-09-03): default / low / high / max. `default` means
 * effort is deliberately not pinned (no --effort argument); the session
 * handshake then accepts whatever effective level the CLI resolved. The
 * other tiers are CLI-native effort levels and echo strictly.
 */
export const GLM_MODEL_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "default",
  "low",
  "high",
  "max",
]);

export const GLM_STATIC_CATALOG: RuntimeCatalog = Object.freeze({
  runtime: "glm",
  models: Object.freeze(
    GLM_MODEL_IDS.map((id) =>
      Object.freeze({
        id,
        effortLevels: Object.freeze([...GLM_MODEL_EFFORT_LEVELS]),
      }),
    ),
  ),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

export interface GlmEndpointConfiguration {
  /** Explicit base URL; env override / contract default apply when absent. */
  readonly baseUrl?: string;
  /** Token source variable; the GLM contract default applies when absent. */
  readonly authTokenEnvVar?: string;
  /**
   * Live token resolver for the endpoint secret envelope store (ADR 0022).
   * Invoked once per session start, so a key saved (or removed) in Settings
   * applies to the next spawn without reconstructing the adapter. When it
   * returns `undefined` the source environment variable is read exactly as
   * before (P2 fallback); a resolver that throws propagates loudly.
   */
  readonly resolveAuthToken?: () => string | undefined;
  /**
   * Live base-URL resolver backed by the Settings "Base URL (optional)"
   * field (w232), same invocation discipline as `resolveAuthToken`: called
   * once per session start, taking precedence over `baseUrl` / the
   * environment variable / the contract default when it returns a
   * non-empty string.
   */
  readonly resolveBaseUrl?: () => string | undefined;
  /** Isolated CLAUDE_CONFIG_DIR for every GLM spawn (required). */
  readonly configDir: string;
  /** Source environment the token/base URL are read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Profile-aware environment source for the GLM endpoint. The alias override
 * names the model actually selected for the session, clamped to the static
 * catalog: a non-GLM model id can never be injected as an alias (a bogus
 * selection is rejected by the adapter before the session proceeds).
 */
export function createGlmEndpointEnvironmentSource(
  configuration: GlmEndpointConfiguration,
): ClaudeEndpointEnvironmentResolver {
  return (context) => {
    const profileModel = context.profile?.model;
    const model =
      profileModel !== undefined && isGlmStaticCatalogModelId(profileModel)
        ? profileModel
        : GLM_DEFAULT_MODEL_ID;
    const resolvedAuthToken = configuration.resolveAuthToken?.();
    const resolvedBaseUrl = configuration.resolveBaseUrl?.();
    const effectiveBaseUrl = isNonEmpty(resolvedBaseUrl)
      ? resolvedBaseUrl
      : configuration.baseUrl;
    return Object.freeze({
      mode: "glm" as const,
      ...(isNonEmpty(effectiveBaseUrl)
        ? { baseUrl: effectiveBaseUrl }
        : {}),
      ...(isNonEmpty(configuration.authTokenEnvVar)
        ? { authTokenEnvVar: configuration.authTokenEnvVar }
        : {}),
      ...(resolvedAuthToken === undefined
        ? {}
        : { authToken: resolvedAuthToken }),
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

/** The full claude-adapter endpoint context for the GLM Coding Plan endpoint. */
export function createGlmEndpointContext(
  configuration: GlmEndpointConfiguration,
): ClaudeEndpointContext {
  return Object.freeze({
    environmentSource: createGlmEndpointEnvironmentSource(configuration),
    ...(configuration.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: configuration.sourceEnvironment }),
    authenticationMode: "api-key-static",
    staticCatalog: GLM_STATIC_CATALOG,
  });
}

/**
 * Stable, user-scoped isolated config directory for GLM spawns. The real
 * `~/.claude` OAuth store must never be visible to a GLM process (spec
 * section A structural guarantee), and a fixed path keeps the directory
 * reusable instead of leaking one temp dir per spawn. Default base is
 * `%APPDATA%` (user-scoped, survives temp cleanup); non-Windows hosts
 * without APPDATA fall back to the OS temp directory.
 */
export function glmIsolatedClaudeConfigDir(
  baseDirectory: string = process.env.APPDATA ?? tmpdir(),
): string {
  return join(baseDirectory, "synchronized-intellect-network", "glm-claude-config");
}

export { GLM_ENDPOINT_ENV_CONTRACT };
