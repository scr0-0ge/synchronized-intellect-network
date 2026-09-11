/**
 * Workbench-owned isolated CODEX_HOME for the codex-api endpoint (ticket 21:
 * the real OpenAI backend, carried by the codex CLI's custom-provider route
 * — same route kimi-platform uses, ticket 17).
 *
 * ADR-0001 semantics, unchanged from the kimi-platform seeding (ticket 17):
 * transport configuration lives in the runtime's own isolated home. The
 * workbench seeds `config.toml` inside a dedicated directory (`%APPDATA%`
 * pattern, same location budget as `glmIsolatedClaudeConfigDir`) declaring a
 * custom `model_provider` pointed at the real OpenAI backend with
 * `wire_api = "responses"` and an `env_key` naming our injected variable
 * `OPENAI_API_KEY`, which the codex-api env factory fills from the dedicated
 * `CODEX_API_KEY` source or the secret envelope store. The user-level
 * `~/.codex` is never read, written, or merged.
 *
 * The provider id must not be `openai` (or any other codex CLI built-in
 * provider id): the CLI validates `model_providers` against its reserved
 * built-in ids and refuses the entire config, falling back to defaults, if
 * one is redeclared — CLI's own error names the fix: "Rename your custom
 * provider (for example, `openai-custom`)". Live-verified on both 0.153.4
 * and 0.154.0 (ticket 21 rework) — the reserved-id rejection is not a
 * version-specific regression, so this file cannot rely on any codex CLI
 * version tolerating a redeclared built-in id.
 *
 * No model-metadata seeds here (unlike kimi-platform): the gpt-5.x family
 * is in the codex CLI's own built-in catalog, so there is no unknown-model
 * metadata problem to paper over.
 *
 * All operations are synchronous on purpose (same budget as kimi-platform).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isValidEndpointBaseUrl } from "../claude/endpoint-env-factory.ts";
import { RuntimeAdapterError } from "../index.ts";
import { CODEX_API_ENDPOINT_ENV_CONTRACT } from "./endpoint-env-factory.ts";
import { CODEX_API_DEFAULT_MODEL_ID } from "./codex-api-models.ts";

/**
 * Provider id inside the seeded config.toml (`model_providers.<id>`). Must
 * stay outside the codex CLI's reserved built-in provider ids (`openai`
 * included) — see the file header for the validation this avoids.
 */
export const CODEX_API_CODEX_PROVIDER_ID = "openai-custom";

export const CODEX_API_CONFIG_TOML_FILE_NAME = "config.toml";

export interface CodexApiCodexHomeConfiguration {
  /** The isolated CODEX_HOME directory (workbench-owned, required). */
  readonly homeDirectory: string;
  /** Explicit provider base URL; env override / contract default otherwise. */
  readonly baseUrl?: string;
  /** Default model id; the static catalog default applies when absent. */
  readonly defaultModel?: string;
  /** Environment the base URL override is read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

export interface CodexApiCodexHomeState {
  readonly homeDirectory: string;
  readonly configPath: string;
  /** Whether this call had to (re)write config.toml. */
  readonly restored: boolean;
}

/**
 * Stable, user-scoped isolated CODEX_HOME for codex-api spawns. Default base
 * is `%APPDATA%` (user-scoped, survives temp cleanup); non-Windows hosts
 * without APPDATA fall back to the OS temp directory. The path can never
 * resolve into the user-level `~/.codex`.
 */
export function codexApiIsolatedCodexHomeDir(
  baseDirectory: string = process.env.APPDATA ?? tmpdir(),
): string {
  return join(baseDirectory, "synchronized-intellect-network", "codex-api-codex-home");
}

/** Resolve the provider base URL: override > env contract var > default. */
export function resolveCodexApiBaseUrl(
  configuration: CodexApiCodexHomeConfiguration,
): string {
  const environment = configuration.sourceEnvironment ?? process.env;
  const override =
    typeof configuration.baseUrl === "string" &&
    configuration.baseUrl.trim().length > 0
      ? configuration.baseUrl
      : environment[CODEX_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar];
  const baseUrl =
    typeof override === "string" && override.trim().length > 0
      ? override
      : CODEX_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
  if (!isValidEndpointBaseUrl(baseUrl)) {
    throw new RuntimeAdapterError("invalid-input");
  }
  return baseUrl;
}

/**
 * The canonical config.toml content for the given configuration. Byte-stable
 * (same corruption-detection contract as the kimi-platform seeding).
 */
export function composeCodexApiConfigToml(
  configuration: CodexApiCodexHomeConfiguration,
): string {
  const baseUrl = resolveCodexApiBaseUrl(configuration);
  const defaultModel =
    typeof configuration.defaultModel === "string" &&
    configuration.defaultModel.trim().length > 0
      ? configuration.defaultModel
      : CODEX_API_DEFAULT_MODEL_ID;
  if (defaultModel.includes("\0") || defaultModel.includes('"')) {
    throw new RuntimeAdapterError("invalid-input");
  }
  return [
    "# Managed by synchronized-intellect-network (Synchronized Intellect Network).",
    "# Isolated codex home for the codex-api endpoint (ticket 21).",
    "# Workbench-owned: a damaged config.toml is rebuilt on the next launch;",
    "# nothing in this directory ever merges with a user-level ~/.codex.",
    `model = "${defaultModel}"`,
    `model_provider = "${CODEX_API_CODEX_PROVIDER_ID}"`,
    "",
    `[model_providers.${CODEX_API_CODEX_PROVIDER_ID}]`,
    `name = "${CODEX_API_CODEX_PROVIDER_ID}"`,
    `base_url = "${baseUrl}"`,
    `env_key = "${CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeyInjectedEnvVar}"`,
    // Live-verified on the codex 0.153 line (ticket 17, moonshot): 0.153
    // dropped `wire_api = "chat"`; the Responses wire is the one this CLI
    // generation speaks, and the OpenAI backend serves it natively.
    'wire_api = "responses"',
    "",
  ].join("\n");
}

/**
 * Ensure the isolated CODEX_HOME exists and carries the canonical
 * config.toml (same repair contract as the kimi-platform seeding: missing,
 * unreadable, or drifted content is rebuilt; healthy content is untouched).
 */
export function ensureCodexApiCodexHome(
  configuration: CodexApiCodexHomeConfiguration,
): CodexApiCodexHomeState {
  const homeDirectory = configuration.homeDirectory;
  if (
    typeof homeDirectory !== "string" ||
    homeDirectory.trim().length === 0 ||
    homeDirectory.includes("\0")
  ) {
    throw new RuntimeAdapterError("invalid-input");
  }
  const canonical = composeCodexApiConfigToml(configuration);
  mkdirSync(homeDirectory, { recursive: true });
  const configPath = join(homeDirectory, CODEX_API_CONFIG_TOML_FILE_NAME);
  let existing: string | undefined;
  try {
    existing = readFileSync(configPath, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === canonical) {
    return Object.freeze({ homeDirectory, configPath, restored: false });
  }
  writeFileSync(configPath, canonical, { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ homeDirectory, configPath, restored: true });
}
