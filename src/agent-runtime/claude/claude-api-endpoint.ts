/**
 * Claude API endpoint (ticket 21, charter completion): the real Anthropic
 * backend reached with an injected ANTHROPIC_API_KEY through the same claude
 * CLI transport, per the five-blueprint owner ruling (2026-09-02) —
 * "its auth is a key rather than a login command".
 *
 * Key-naming discipline (deputy design of record): the SOURCE variable is
 * the dedicated `CLAUDE_API_KEY`, never the bare `ANTHROPIC_API_KEY` — a
 * host's ambient ANTHROPIC_API_KEY belongs to the host's own Anthropic
 * usage and must never silently become this endpoint's key (the same
 * discipline as GLM's GLM_ANTHROPIC_AUTH_TOKEN). The env factory cleanses
 * every ambient Anthropic credential first, then injects the resolved key
 * as ANTHROPIC_API_KEY — the name the CLI reads.
 *
 * Catalog: NO static override. Against the real Anthropic backend the CLI's
 * own catalog is the truth, so this endpoint probes it exactly like the
 * subscription endpoint (spec section C static-override rationale does not
 * apply — the CLI names are already the real names).
 *
 * Authentication: api-key-static. The healthy `claude auth status --json`
 * shape for this endpoint is `api_key` (P1 spike: the CLI reports an
 * injected ANTHROPIC_API_KEY as `api_key`), so the context pins
 * `apiKeyStaticHealthyAuthMethod: "api_key"` — the GLM/Kimi/DeepSeek
 * endpoints keep `oauth_token`.
 */

import type { ClaudeEndpointContext } from "./adapter.ts";
import type {
  ClaudeEndpointEnvironmentResolver,
} from "./endpoint-env-factory.ts";

/**
 * Environment-variable contract for the claude-api endpoint. The key source
 * variable is claude-api-specific on purpose (naming discipline above); the
 * base URL contract exists for the key-source probe and env override, while
 * sessions always use the CLI's own Anthropic endpoint unless the user
 * overrides the provider base.
 */
export const CLAUDE_API_ENDPOINT_ENV_CONTRACT = Object.freeze({
  apiKeySourceEnvVar: "CLAUDE_API_KEY",
  /** The name injected into the spawned CLI process (what the CLI reads). */
  apiKeyInjectedEnvVar: "ANTHROPIC_API_KEY",
  baseUrlEnvVar: "CLAUDE_API_BASE_URL",
  defaultBaseUrl: "https://api.anthropic.com",
} as const);

/** Envelope subject binding every claude-api endpoint secret envelope. */
export const CLAUDE_API_ENDPOINT_KEY_SUBJECT =
  "workbench://runtime-endpoint/claude-api";

/** Endpoint-scoped opaque short identifier for stored claude-api keys. */
export const CLAUDE_API_ENDPOINT_KEY_NAME = "claude-api";

/**
 * Shared multi-subject store file name — byte-identical to the GLM/Kimi/
 * DeepSeek/kimi-platform constants on purpose: one store file, many
 * subjects (ADR 0022).
 */
export const CLAUDE_API_ENDPOINT_SECRET_STORE_FILE_NAME =
  "endpoint-secret-envelope-store.json";

export interface ClaudeApiEndpointConfiguration {
  /**
   * Live key resolver for the endpoint secret envelope store (ADR 0022).
   * Invoked once per environment resolution, so a key saved (or removed) in
   * Settings applies to the next spawn without reconstructing the adapter.
   * When it returns `undefined` the `CLAUDE_API_KEY` source environment
   * variable is read as the fallback; a resolver that throws propagates
   * loudly.
   */
  readonly resolveApiKey?: () => string | undefined;
  /** Source environment the key is read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Environment source for the claude-api endpoint: the factory's `api-key`
 * arm with the dedicated source variable and the store-resolved key. No
 * configDir override: this endpoint shares the CLI's real config-directory
 * behaviour with the subscription endpoint and isolates nothing (there is
 * no third-party host to hide OAuth state from — the backend IS Anthropic).
 */
export function createClaudeApiEndpointEnvironmentSource(
  configuration: ClaudeApiEndpointConfiguration,
): ClaudeEndpointEnvironmentResolver {
  return () => {
    const resolvedApiKey = configuration.resolveApiKey?.();
    return Object.freeze({
      mode: "api-key" as const,
      apiKeyEnvVar: CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
      ...(resolvedApiKey === undefined ? {} : { apiKey: resolvedApiKey }),
    });
  };
}

/** The full claude-adapter endpoint context for the claude-api endpoint. */
export function createClaudeApiEndpointContext(
  configuration: ClaudeApiEndpointConfiguration,
): ClaudeEndpointContext {
  return Object.freeze({
    environmentSource: createClaudeApiEndpointEnvironmentSource(configuration),
    ...(configuration.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: configuration.sourceEnvironment }),
    authenticationMode: "api-key-static",
    apiKeyStaticHealthyAuthMethod: "api_key",
    // No staticCatalog: the real CLI catalog is this endpoint's catalog.
  });
}
