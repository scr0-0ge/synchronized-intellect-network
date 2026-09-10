/**
 * kimi-platform endpoint catalog exports and endpoint context (ticket 17:
 * the CN platform's OpenAI face carried by the codex CLI custom-provider
 * route — the platform has no anthropic face, live-verified in ticket 11
 * Comments).
 *
 * The static roster, default model, and effort ruling live in
 * `kimi-platform-models.ts` (leaf module, re-exported here); the CODEX_HOME
 * seeding lives in `kimi-platform-codex-home.ts`; this module adds the
 * endpoint configuration and the codex-adapter endpoint context that bind
 * them together.
 */

import type { CodexEndpointContext } from "../codex-adapter.ts";
import type { CodexEndpointEnvironmentResolver } from "./endpoint-env-factory.ts";
import { ensureKimiPlatformCodexHome } from "./kimi-platform-codex-home.ts";
import { KIMI_PLATFORM_STATIC_CATALOG } from "./kimi-platform-models.ts";

export {
  KIMI_PLATFORM_MODEL_IDS,
  KIMI_PLATFORM_DEFAULT_MODEL_ID,
  KIMI_PLATFORM_EFFORT_LEVELS,
  KIMI_PLATFORM_STATIC_CATALOG,
  isKimiPlatformStaticCatalogModelId,
} from "./kimi-platform-models.ts";
export type { KimiPlatformModelId } from "./kimi-platform-models.ts";
export {
  ensureKimiPlatformCodexHome,
  composeKimiPlatformConfigToml,
  resolveKimiPlatformBaseUrl,
  kimiPlatformIsolatedCodexHomeDir,
  KIMI_PLATFORM_CODEX_PROVIDER_ID,
  KIMI_PLATFORM_CONFIG_TOML_FILE_NAME,
} from "./kimi-platform-codex-home.ts";
export type {
  KimiPlatformCodexHomeConfiguration,
  KimiPlatformCodexHomeState,
} from "./kimi-platform-codex-home.ts";

export interface KimiPlatformEndpointConfiguration {
  /** Explicit provider base URL; env override / contract default otherwise. */
  readonly baseUrl?: string;
  /**
   * Live key resolver for the endpoint secret envelope store (ADR 0022).
   * Invoked once per spawn environment resolution, so a key saved (or
   * removed) applies to the next session without reconstructing the adapter.
   * When it returns `undefined` the source environment variable is read as
   * the fallback (store first, `KIMI_PLATFORM_API_KEY` env fallback).
   */
  readonly resolveApiKey?: () => string | undefined;
  /** Workbench-owned isolated CODEX_HOME for every kimi-platform spawn. */
  readonly codexHome: string;
  /** Source environment the key/base URL are read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Environment source for the kimi-platform endpoint: the resolved store key
 * (when present) plus the isolated CODEX_HOME, both consumed by the codex
 * endpoint environment factory's cleanse-then-inject arm.
 */
export function createKimiPlatformEnvironmentSource(
  configuration: KimiPlatformEndpointConfiguration,
): CodexEndpointEnvironmentResolver {
  return () => {
    const resolvedApiKey = configuration.resolveApiKey?.();
    return Object.freeze({
      mode: "kimi-platform" as const,
      ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
      codexHome: configuration.codexHome,
    });
  };
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The full codex-adapter endpoint context for the kimi-platform endpoint:
 * static catalog, per-spawn environment source, and the CODEX_HOME seeding
 * step that runs before every operation (inspect included) so a healthy
 * transport config is a precondition of `catalog-ready`, and a damaged
 * config.toml is rebuilt before any process is spawned.
 */
export function createKimiPlatformEndpointContext(
  configuration: KimiPlatformEndpointConfiguration,
): CodexEndpointContext {
  return Object.freeze({
    environmentSource: createKimiPlatformEnvironmentSource(configuration),
    ...(configuration.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: configuration.sourceEnvironment }),
    prepareEndpoint: () => {
      ensureKimiPlatformCodexHome({
        homeDirectory: configuration.codexHome,
        ...(isNonEmpty(configuration.baseUrl)
          ? { baseUrl: configuration.baseUrl }
          : {}),
        ...(configuration.sourceEnvironment === undefined
          ? {}
          : { sourceEnvironment: configuration.sourceEnvironment }),
      });
      return Promise.resolve();
    },
    staticCatalog: KIMI_PLATFORM_STATIC_CATALOG,
  });
}
