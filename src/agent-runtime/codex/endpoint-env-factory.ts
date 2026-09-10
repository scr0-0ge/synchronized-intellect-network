/**
 * Per-endpoint process environment factory for the codex adapter family
 * (ticket 17: kimi CN platform via the codex CLI transport).
 *
 * The historical codex-desktop spawn path never touches this factory: it
 * launches without an `env` option and inherits the parent environment
 * byte-identically. Only an adapter carrying a `CodexEndpointContext` builds
 * its spawn environment here:
 *
 * - `kimi-platform`: cleanse, then inject `CODEX_HOME` (the workbench-owned
 *   isolated codex home) and `KIMI_PLATFORM_API_KEY` (the `env_key` the
 *   seeded `config.toml` names). The cleanse removes every ambient OpenAI/
 *   codex credential AND any ambient `CODEX_HOME`, so a hostile or merely
 *   configured parent environment can neither send an OpenAI credential to
 *   Moonstock hosts nor point the endpoint process at a user-level `~/.codex`.
 * - `codex-api`: cleanse, then inject `CODEX_HOME` and `OPENAI_API_KEY`
 *   resolved from the dedicated `CODEX_API_KEY` source variable or the
 *   endpoint secret envelope store (ticket 21). The ambient
 *   `OPENAI_API_KEY`/`CODEX_API_KEY` are cleansed before injection, so a
 *   host's own OpenAI credential never becomes this endpoint's key.
 *
 * Injections always happen after cleansing. Token values only ever move from
 * the source environment or the endpoint secret envelope store into the
 * spawned process environment; they are never logged, snapshotted, or
 * persisted here.
 */

import { RuntimeAdapterError } from "../index.ts";

export type CodexEndpointEnvironmentReason =
  | "invalid-source"
  | "invalid-mode"
  | "token-missing"
  | "token-malformed"
  | "codex-home-invalid";

export class CodexEndpointEnvironmentError extends Error {
  readonly reason: CodexEndpointEnvironmentReason;

  constructor(reason: CodexEndpointEnvironmentReason, message: string) {
    super(message);
    this.name = "CodexEndpointEnvironmentError";
    this.reason = reason;
  }
}

/**
 * Credential and deployment keys an endpoint-context codex spawn never
 * inherits from its parent. `OPENAI_*`/`CODEX_API_KEY` would let an ambient
 * OpenAI credential answer where the kimi platform key should; `CODEX_HOME`
 * would point the process at a home this endpoint does not own (ticket 17:
 * zero contact with the user-level `~/.codex`).
 */
export const CODEX_ENDPOINT_CLEANSE_ENVIRONMENT_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
] as const);

/**
 * Environment-variable contract for the kimi-platform endpoint (CN platform,
 * OpenAI face via the codex CLI custom-provider route, ticket 17). The key
 * variable name is simultaneously the `env_key` written into the seeded
 * `config.toml` — the two must never diverge, which is why the factory does
 * not offer a per-call override of `apiKeyEnvVar`.
 */
export const KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT = Object.freeze({
  apiKeyEnvVar: "KIMI_PLATFORM_API_KEY",
  baseUrlEnvVar: "KIMI_PLATFORM_BASE_URL",
  defaultBaseUrl: "https://api.moonshot.cn/v1",
} as const);

/**
 * Environment-variable contract for the codex-api endpoint (ticket 21:
 * the real OpenAI backend through the codex CLI's own openai provider in an
 * isolated CODEX_HOME). The SOURCE variable is the dedicated `CODEX_API_KEY`
 * — a host's ambient OPENAI_API_KEY belongs to the host's own OpenAI usage
 * and is cleansed, never read (the same naming discipline as claude-api's
 * CLAUDE_API_KEY). The INJECTED variable is `OPENAI_API_KEY`, which is also
 * the `env_key` the seeded config.toml names; the two are pinned together
 * here and never diverge.
 */
export const CODEX_API_ENDPOINT_ENV_CONTRACT = Object.freeze({
  apiKeySourceEnvVar: "CODEX_API_KEY",
  apiKeyInjectedEnvVar: "OPENAI_API_KEY",
  baseUrlEnvVar: "CODEX_API_BASE_URL",
  defaultBaseUrl: "https://api.openai.com/v1",
} as const);

export type CodexEndpointEnvironmentMode = "kimi-platform" | "codex-api";

export interface CodexEndpointEnvironment {
  readonly mode: CodexEndpointEnvironmentMode;
  /**
   * Explicit key value (the endpoint secret envelope store). When absent the
   * mode's SOURCE environment variable is read as the fallback. A value that
   * is present but empty or NUL-containing fails loudly instead of silently
   * falling back to the environment variable.
   */
  readonly apiKey?: string;
  /** Workbench-owned isolated CODEX_HOME (required for this endpoint). */
  readonly codexHome?: string;
}

/** Spawn context an environment source may inspect (reserved). */
export interface CodexEndpointEnvironmentContext {
  // No profile arm yet: the codex transport takes its model per request, so
  // the kimi-platform spawn environment is profile-independent today.
}

export type CodexEndpointEnvironmentResolver = (
  context: Readonly<CodexEndpointEnvironmentContext>,
) => CodexEndpointEnvironment;

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createCodexEndpointProcessEnvironment(
  source: NodeJS.ProcessEnv,
  endpoint: CodexEndpointEnvironment,
): NodeJS.ProcessEnv {
  if (typeof source !== "object" || source === null) {
    throw new CodexEndpointEnvironmentError(
      "invalid-source",
      "source environment must be an object.",
    );
  }
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    (endpoint.mode !== "kimi-platform" && endpoint.mode !== "codex-api")
  ) {
    throw new CodexEndpointEnvironmentError(
      "invalid-mode",
      'endpoint.mode must be "kimi-platform" or "codex-api".',
    );
  }

  const environment = { ...source };
  for (const key of CODEX_ENDPOINT_CLEANSE_ENVIRONMENT_KEYS) {
    delete environment[key];
  }

  if (!isNonEmptyString(endpoint.codexHome) || endpoint.codexHome.includes("\0")) {
    throw new CodexEndpointEnvironmentError(
      "codex-home-invalid",
      `${endpoint.mode} endpoint: codexHome must be a non-empty, NUL-free string.`,
    );
  }
  environment.CODEX_HOME = endpoint.codexHome;

  const keyVariable =
    endpoint.mode === "kimi-platform"
      ? KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar
      : CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar;
  const injectedVariable =
    endpoint.mode === "kimi-platform"
      ? KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar
      : CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeyInjectedEnvVar;
  let apiKey: string;
  if (endpoint.apiKey === undefined) {
    // No stored key: the environment fallback applies verbatim
    // (token-missing when the variable is absent).
    const value = source[keyVariable];
    if (value === undefined || value.trim().length === 0) {
      throw new CodexEndpointEnvironmentError(
        "token-missing",
        `${endpoint.mode} endpoint: environment variable ${keyVariable} is not set.`,
      );
    }
    if (value.includes("\0")) {
      throw new CodexEndpointEnvironmentError(
        "token-malformed",
        `${endpoint.mode} endpoint: environment variable ${keyVariable} must be NUL-free.`,
      );
    }
    apiKey = value;
  } else if (isNonEmptyString(endpoint.apiKey) && !endpoint.apiKey.includes("\0")) {
    apiKey = endpoint.apiKey;
  } else {
    throw new CodexEndpointEnvironmentError(
      "token-malformed",
      `${endpoint.mode} endpoint: stored api key must be a non-empty, NUL-free string.`,
    );
  }
  environment[injectedVariable] = apiKey;

  return environment;
}

/**
 * Resolve-and-map wrapper mirroring the claude family's
 * `resolveClaudeProcessEnvironment`: builds the spawn environment through the
 * factory and surfaces endpoint failures as `RuntimeAdapterError` categories
 * (`token-*` → `authentication-required`, everything else `invalid-input`).
 */
export function resolveCodexEndpointProcessEnvironment(
  source: NodeJS.ProcessEnv,
  environmentSource: CodexEndpointEnvironmentResolver,
  context: Readonly<CodexEndpointEnvironmentContext> = Object.freeze({}),
): NodeJS.ProcessEnv {
  try {
    return Object.freeze(
      createCodexEndpointProcessEnvironment(source, environmentSource(context)),
    );
  } catch (error) {
    if (error instanceof CodexEndpointEnvironmentError) {
      throw new RuntimeAdapterError(
        error.reason === "token-missing" || error.reason === "token-malformed"
          ? "authentication-required"
          : "invalid-input",
      );
    }
    throw new RuntimeAdapterError("invalid-input");
  }
}
