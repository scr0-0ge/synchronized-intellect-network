/**
 * codex-api endpoint catalog exports and endpoint context (ticket 21). The
 * static roster, default model, and effort tiers live in
 * `codex-api-models.ts` (leaf module, re-exported here); the CODEX_HOME
 * seeding lives in `codex-api-codex-home.ts`; this module adds the endpoint
 * configuration and the codex-adapter endpoint context that bind them
 * together — mirroring `kimi-platform-catalog.ts` (ticket 17).
 *
 * The static catalog also carries the account-gate skip: a context-provided
 * `staticCatalog` makes `start`/`resume` skip the chatgpt-account gate
 * (`account/read` answers for the CLI's own subscription, not for an
 * env-key provider — codex-adapter.ts `CodexEndpointContext`).
 *
 * Identity constants for the endpoint secret envelope store live in
 * `codex-api-endpoint-key.ts`.
 */

import type { CodexEndpointContext } from "../codex-adapter.ts";
import type { CodexEndpointEnvironmentResolver } from "./endpoint-env-factory.ts";
import { ensureCodexApiCodexHome } from "./codex-api-codex-home.ts";
import { CODEX_API_STATIC_CATALOG } from "./codex-api-models.ts";

export {
  CODEX_API_MODEL_IDS,
  CODEX_API_DEFAULT_MODEL_ID,
  CODEX_API_STATIC_CATALOG,
  isCodexApiStaticCatalogModelId,
} from "./codex-api-models.ts";
export type { CodexApiModelId } from "./codex-api-models.ts";
export {
  ensureCodexApiCodexHome,
  composeCodexApiConfigToml,
  resolveCodexApiBaseUrl,
  codexApiIsolatedCodexHomeDir,
  CODEX_API_CODEX_PROVIDER_ID,
  CODEX_API_CONFIG_TOML_FILE_NAME,
} from "./codex-api-codex-home.ts";
export type {
  CodexApiCodexHomeConfiguration,
  CodexApiCodexHomeState,
} from "./codex-api-codex-home.ts";

export interface CodexApiEndpointConfiguration {
  /** Explicit provider base URL; env override / contract default otherwise. */
  readonly baseUrl?: string;
  /**
   * Live base URL resolver (w223: the Settings "Base URL (optional)" field
   * on the Codex · API card). Invoked once per `prepareEndpoint()` call --
   * the same per-spawn cadence as `resolveApiKey` -- so a save takes effect
   * on the next operation without recomposing the adapter. Its result wins
   * over `baseUrl` when present; an empty/undefined result falls through to
   * `baseUrl`, then the env override, then the contract default.
   */
  readonly resolveBaseUrl?: () => string | undefined | Promise<string | undefined>;
  /**
   * Live key resolver for the endpoint secret envelope store (ADR 0022).
   * Invoked once per spawn environment resolution; `undefined` falls back to
   * the `CODEX_API_KEY` source environment variable.
   */
  readonly resolveApiKey?: () => string | undefined;
  /** Workbench-owned isolated CODEX_HOME for every codex-api spawn. */
  readonly codexHome: string;
  /** Source environment the key/base URL are read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Environment source for the codex-api endpoint: the resolved store key
 * (when present) plus the isolated CODEX_HOME, both consumed by the codex
 * endpoint environment factory's codex-api cleanse-then-inject arm.
 */
export function createCodexApiEnvironmentSource(
  configuration: CodexApiEndpointConfiguration,
): CodexEndpointEnvironmentResolver {
  return () => {
    const resolvedApiKey = configuration.resolveApiKey?.();
    return Object.freeze({
      mode: "codex-api" as const,
      ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
      codexHome: configuration.codexHome,
    });
  };
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The full codex-adapter endpoint context for the codex-api endpoint:
 * static catalog, per-spawn environment source, and the CODEX_HOME seeding
 * step that runs before every operation (inspect included) so a healthy
 * transport config is a precondition of `catalog-ready`.
 */
export function createCodexApiEndpointContext(
  configuration: CodexApiEndpointConfiguration,
): CodexEndpointContext {
  return Object.freeze({
    environmentSource: createCodexApiEnvironmentSource(configuration),
    ...(configuration.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: configuration.sourceEnvironment }),
    prepareEndpoint: async () => {
      const resolved = await configuration.resolveBaseUrl?.();
      const liveBaseUrl = isNonEmpty(resolved) ? resolved : configuration.baseUrl;
      ensureCodexApiCodexHome({
        homeDirectory: configuration.codexHome,
        ...(isNonEmpty(liveBaseUrl) ? { baseUrl: liveBaseUrl } : {}),
        ...(configuration.sourceEnvironment === undefined
          ? {}
          : { sourceEnvironment: configuration.sourceEnvironment }),
      });
    },
    staticCatalog: CODEX_API_STATIC_CATALOG,
  });
}
