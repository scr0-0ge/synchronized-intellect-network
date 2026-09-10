/**
 * Per-endpoint process environment factory for the claude adapter family
 * (spec section A). One adapter codebase serves several Runtime Endpoints;
 * each endpoint describes its own spawn environment here:
 *
 * - `subscription`: the historical cleansing semantics, byte-identical to the
 *   pre-endpoint behaviour (`createClaudeProcessEnvironment(source,
 *   "subscription")` is the regression anchor).
 * - `api-key`: cleanse, then inject `ANTHROPIC_API_KEY` from the endpoint's
 *   own source variable (claude-api endpoint, P3 instance).
 * - `glm`: cleanse, then inject `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
 *   and the model-identity truth keys (`ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_
 *   MODEL`), so the wire carries the GLM model name, never a claude alias.
 *
 * Injections always happen after cleansing, so a hostile parent environment
 * cannot smuggle credentials into an endpoint process. Token values only ever
 * move from the source environment into the spawned process environment; they
 * are never logged, snapshotted, or persisted here.
 */

import type { SessionProfile } from "../index.ts";

export type ClaudeEndpointEnvironmentMode = "subscription" | "api-key" | "glm";

/**
 * Fine-grained failure reasons. `token-*` and `api-key-*` reasons surface to
 * callers as `authentication-required`; everything else is `invalid-input`.
 */
export type ClaudeEndpointEnvironmentReason =
  | "invalid-source"
  | "invalid-mode"
  | "token-missing"
  | "token-malformed"
  | "api-key-missing"
  | "api-key-malformed"
  | "base-url-invalid"
  | "model-invalid"
  | "config-dir-invalid";

export class ClaudeEndpointEnvironmentError extends Error {
  readonly reason: ClaudeEndpointEnvironmentReason;

  constructor(reason: ClaudeEndpointEnvironmentReason, message: string) {
    super(message);
    this.name = "ClaudeEndpointEnvironmentError";
    this.reason = reason;
  }
}

export const CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BEARER_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const);

export const CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS = Object.freeze([
  "CLAUDECODE",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
] as const);

export const CLAUDE_DEPLOYMENT_SELECTOR_KEYS = Object.freeze([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const);

const SDK_ENVIRONMENT_MARKERS = Object.freeze({
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_AGENT_SDK_VERSION: "0.3.220",
} as const);

/**
 * Environment-variable contract for the GLM Coding Plan endpoint. The token
 * variable is GLM-specific on purpose: an ambient `ANTHROPIC_AUTH_TOKEN` must
 * never be forwarded to the GLM endpoint (that would send an Anthropic
 * credential to a third-party host).
 */
export const GLM_ENDPOINT_ENV_CONTRACT = Object.freeze({
  baseUrlEnvVar: "GLM_ANTHROPIC_BASE_URL",
  authTokenEnvVar: "GLM_ANTHROPIC_AUTH_TOKEN",
  modelEnvVar: "GLM_ANTHROPIC_MODEL",
  defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
} as const);

/** Zhipu-documented alias overrides that put GLM names on the wire. */
export interface ClaudeEndpointDefaultAliasModels {
  readonly opus?: string;
  readonly sonnet?: string;
  readonly haiku?: string;
}

export interface ClaudeEndpointEnvironment {
  readonly mode: ClaudeEndpointEnvironmentMode;
  /** api-key mode: source variable holding the key (default ANTHROPIC_API_KEY). */
  readonly apiKeyEnvVar?: string;
  /**
   * api-key mode: explicit key value (the endpoint secret envelope store,
   * claude-api endpoint). When absent the source environment variable is read
   * exactly as before. A value that is present but empty or NUL-containing
   * fails loudly instead of silently falling back to the environment
   * variable (same discipline as glm-mode `authToken`).
   */
  readonly apiKey?: string;
  /** glm mode: explicit base URL (env override / contract default otherwise). */
  readonly baseUrl?: string;
  /** glm mode: source variable holding the token (contract default otherwise). */
  readonly authTokenEnvVar?: string;
  /**
   * glm mode: explicit token value (the endpoint secret envelope store). When
   * absent the source environment variable is read exactly as before. A value
   * that is present but empty or NUL-containing fails loudly instead of
   * silently falling back to the environment variable.
   */
  readonly authToken?: string;
  /** glm mode: optional explicit ANTHROPIC_MODEL override. */
  readonly model?: string;
  /**
   * glm mode: source variable for the env-side model override when
   * `model` itself is absent (WO16 Part 2: parameterized so each endpoint
   * reads its OWN contract variable — Kimi `KIMI_CODE_ANTHROPIC_MODEL`,
   * DeepSeek `DEEPSEEK_ANTHROPIC_MODEL` — instead of the GLM default, which
   * used to let an ambient GLM variable pin another endpoint's model).
   */
  readonly modelEnvVar?: string;
  /** glm mode: ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL truth injection. */
  readonly defaultAliasModels?: ClaudeEndpointDefaultAliasModels;
  /** All modes: isolated CLAUDE_CONFIG_DIR for this endpoint. */
  readonly configDir?: string;
}

/** Spawn context an environment source may inspect (the native profile). */
export interface ClaudeEndpointEnvironmentContext {
  readonly profile?: SessionProfile;
}

/** Profile-aware descriptor resolver (the GLM endpoint uses this arm). */
export type ClaudeEndpointEnvironmentResolver = (
  context: Readonly<ClaudeEndpointEnvironmentContext>,
) => ClaudeEndpointEnvironment;

export type ClaudeEndpointEnvironmentSource =
  | ClaudeEndpointEnvironment
  | ClaudeEndpointEnvironmentResolver;

export function createClaudeOAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of [
    ...CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS,
    ...CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS,
    ...CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  ]) {
    delete environment[key];
  }
  return environment;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readValidatedEnvValue(
  source: NodeJS.ProcessEnv,
  name: string,
  missingReason: ClaudeEndpointEnvironmentReason,
  malformedReason: ClaudeEndpointEnvironmentReason,
  label: string,
): string {
  const value = source[name];
  if (value === undefined || value.trim().length === 0) {
    throw new ClaudeEndpointEnvironmentError(
      missingReason,
      `${label}: environment variable ${name} is not set.`,
    );
  }
  if (value.includes("\0")) {
    throw new ClaudeEndpointEnvironmentError(
      malformedReason,
      `${label}: environment variable ${name} must be NUL-free.`,
    );
  }
  return value;
}

export function isValidEndpointBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]")
  );
}

const defaultAliasModelKeys = Object.freeze({
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
} as const);

export function createEndpointProcessEnvironment(
  source: NodeJS.ProcessEnv,
  endpoint: ClaudeEndpointEnvironment,
): NodeJS.ProcessEnv {
  if (typeof source !== "object" || source === null) {
    throw new ClaudeEndpointEnvironmentError(
      "invalid-source",
      "source environment must be an object.",
    );
  }
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    (endpoint.mode !== "subscription" &&
      endpoint.mode !== "api-key" &&
      endpoint.mode !== "glm")
  ) {
    throw new ClaudeEndpointEnvironmentError(
      "invalid-mode",
      'endpoint.mode must be one of "subscription", "api-key", "glm".',
    );
  }
  const environment = createClaudeOAuthEnvironment(source);
  switch (endpoint.mode) {
    case "subscription":
      break;
    case "api-key": {
      const name = isNonEmptyString(endpoint.apiKeyEnvVar)
        ? endpoint.apiKeyEnvVar
        : "ANTHROPIC_API_KEY";
      // The dedicated source variable is read, never the injected name: a
      // host's ambient ANTHROPIC_API_KEY (already cleansed above) must not be
      // smuggled back in as if it were this endpoint's key (claude-api naming
      // discipline: source CLAUDE_API_KEY, injection ANTHROPIC_API_KEY).
      let apiKey: string;
      if (endpoint.apiKey === undefined) {
        apiKey = readValidatedEnvValue(
          source,
          name,
          "api-key-missing",
          "api-key-malformed",
          "api-key endpoint",
        );
      } else if (
        isNonEmptyString(endpoint.apiKey) &&
        !endpoint.apiKey.includes("\0")
      ) {
        apiKey = endpoint.apiKey;
      } else {
        throw new ClaudeEndpointEnvironmentError(
          "api-key-malformed",
          "api-key endpoint: stored api key must be a non-empty, NUL-free string.",
        );
      }
      // When the source name differs from the injected name, the source
      // variable is scrubbed from the child env — the credential surface the
      // CLI sees carries exactly one key, under the one name it reads.
      delete environment[name];
      environment.ANTHROPIC_API_KEY = apiKey;
      break;
    }
    case "glm": {
      const envBaseUrl = source[GLM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar];
      const baseUrl = isNonEmptyString(endpoint.baseUrl)
        ? endpoint.baseUrl
        : isNonEmptyString(envBaseUrl)
          ? envBaseUrl
          : GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
      if (!isValidEndpointBaseUrl(baseUrl)) {
        throw new ClaudeEndpointEnvironmentError(
          "base-url-invalid",
          "glm endpoint: base URL must be https (http allowed only for localhost).",
        );
      }
      const tokenVarName = isNonEmptyString(endpoint.authTokenEnvVar)
        ? endpoint.authTokenEnvVar
        : GLM_ENDPOINT_ENV_CONTRACT.authTokenEnvVar;
      let token: string;
      if (endpoint.authToken === undefined) {
        // No stored key: the P2 environment fallback applies verbatim
        // (token-missing when the variable is absent).
        token = readValidatedEnvValue(
          source,
          tokenVarName,
          "token-missing",
          "token-malformed",
          "glm endpoint",
        );
      } else if (
        isNonEmptyString(endpoint.authToken) &&
        !endpoint.authToken.includes("\0")
      ) {
        token = endpoint.authToken;
      } else {
        throw new ClaudeEndpointEnvironmentError(
          "token-malformed",
          "glm endpoint: stored auth token must be a non-empty, NUL-free string.",
        );
      }
      environment.ANTHROPIC_BASE_URL = baseUrl;
      environment.ANTHROPIC_AUTH_TOKEN = token;
      const envModel =
        source[
          isNonEmptyString(endpoint.modelEnvVar)
            ? endpoint.modelEnvVar
            : GLM_ENDPOINT_ENV_CONTRACT.modelEnvVar
        ];
      const model = isNonEmptyString(endpoint.model)
        ? endpoint.model
        : isNonEmptyString(envModel)
          ? envModel
          : undefined;
      if (model !== undefined) {
        if (model.includes("\0")) {
          throw new ClaudeEndpointEnvironmentError(
            "model-invalid",
            "glm endpoint: model must be NUL-free.",
          );
        }
        environment.ANTHROPIC_MODEL = model;
      }
      const aliases = endpoint.defaultAliasModels;
      if (aliases !== undefined) {
        for (const alias of ["opus", "sonnet", "haiku"] as const) {
          const aliasModel = aliases[alias];
          if (aliasModel === undefined) continue;
          if (
            typeof aliasModel !== "string" ||
            aliasModel.trim().length === 0 ||
            aliasModel.includes("\0")
          ) {
            throw new ClaudeEndpointEnvironmentError(
              "model-invalid",
              `glm endpoint: defaultAliasModels.${alias} must be a non-empty, NUL-free string.`,
            );
          }
          environment[defaultAliasModelKeys[alias]] = aliasModel;
        }
      }
      break;
    }
  }
  if (endpoint.configDir !== undefined) {
    if (
      typeof endpoint.configDir !== "string" ||
      endpoint.configDir.trim().length === 0 ||
      endpoint.configDir.includes("\0")
    ) {
      throw new ClaudeEndpointEnvironmentError(
        "config-dir-invalid",
        "endpoint.configDir must be a non-empty, NUL-free string.",
      );
    }
    environment.CLAUDE_CONFIG_DIR = endpoint.configDir;
  }
  for (const [key, value] of Object.entries(SDK_ENVIRONMENT_MARKERS)) {
    environment[key] = value;
  }
  return environment;
}
