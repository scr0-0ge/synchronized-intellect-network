/**
 * Workbench-owned isolated CODEX_HOME for the kimi-platform endpoint
 * (ticket 17: kimi CN platform — OpenAI face only — carried by the codex CLI
 * custom-provider route).
 *
 * ADR-0001 semantics, unchanged: transport configuration lives in the
 * runtime's own isolated home. The workbench seeds `config.toml` inside a
 * dedicated directory (`%APPDATA%` pattern, same location budget discipline
 * as `glmIsolatedClaudeConfigDir`) pointing `model_provider` at the CN
 * platform's OpenAI face with `wire_api = "responses"` and an `env_key` naming our
 * key variable. The user-level `~/.codex` is never read, written, or merged:
 * the directory is workbench-owned, and a damaged or drifted `config.toml`
 * is rebuilt to the canonical content on the next launch.
 *
 * All operations are synchronous on purpose: seeding is three tiny syscalls
 * on the healthy path and runs once per adapter operation (inspect / start /
 * resume) before any process is spawned.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isValidEndpointBaseUrl } from "../claude/endpoint-env-factory.ts";
import { RuntimeAdapterError } from "../index.ts";
import { KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT } from "./endpoint-env-factory.ts";
import { KIMI_PLATFORM_DEFAULT_MODEL_ID } from "./kimi-platform-models.ts";

/** Provider id inside the seeded config.toml (`model_providers.<id>`). */
export const KIMI_PLATFORM_CODEX_PROVIDER_ID = "kimi-platform";

export const KIMI_PLATFORM_CONFIG_TOML_FILE_NAME = "config.toml";

export interface KimiPlatformCodexHomeConfiguration {
  /** The isolated CODEX_HOME directory (workbench-owned, required). */
  readonly homeDirectory: string;
  /** Explicit provider base URL; env override / contract default otherwise. */
  readonly baseUrl?: string;
  /** Default model id; the static catalog default applies when absent. */
  readonly defaultModel?: string;
  /** Environment the base URL override is read from (tests inject fakes). */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

export interface KimiPlatformCodexHomeState {
  readonly homeDirectory: string;
  readonly configPath: string;
  /** Whether this call had to (re)write config.toml. */
  readonly restored: boolean;
}

/**
 * Stable, user-scoped isolated CODEX_HOME for kimi-platform spawns. Default
 * base is `%APPDATA%` (user-scoped, survives temp cleanup); non-Windows hosts
 * without APPDATA fall back to the OS temp directory — the same budget as the
 * claude-family isolated config dirs. The path can never resolve into the
 * user-level `~/.codex`: it is always `<base>/synchronized-intellect-network/
 * kimi-platform-codex-home`.
 */
export function kimiPlatformIsolatedCodexHomeDir(
  baseDirectory: string = process.env.APPDATA ?? tmpdir(),
): string {
  return join(baseDirectory, "synchronized-intellect-network", "kimi-platform-codex-home");
}

/** Resolve the provider base URL: override > env contract var > default. */
export function resolveKimiPlatformBaseUrl(
  configuration: KimiPlatformCodexHomeConfiguration,
): string {
  const environment = configuration.sourceEnvironment ?? process.env;
  const override =
    typeof configuration.baseUrl === "string" &&
    configuration.baseUrl.trim().length > 0
      ? configuration.baseUrl
      : environment[KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar];
  const baseUrl =
    typeof override === "string" && override.trim().length > 0
      ? override
      : KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
  if (!isValidEndpointBaseUrl(baseUrl)) {
    throw new RuntimeAdapterError("invalid-input");
  }
  return baseUrl;
}

/**
 * The canonical config.toml content for the given configuration. Byte-stable:
 * seeding compares the existing file against exactly this string, so a
 * hand-edited, truncated, or stale (old base URL / old model) file is a
 * detected corruption and gets rebuilt.
 */
export function composeKimiPlatformConfigToml(
  configuration: KimiPlatformCodexHomeConfiguration,
): string {
  const baseUrl = resolveKimiPlatformBaseUrl(configuration);
  const defaultModel =
    typeof configuration.defaultModel === "string" &&
    configuration.defaultModel.trim().length > 0
      ? configuration.defaultModel
      : KIMI_PLATFORM_DEFAULT_MODEL_ID;
  if (defaultModel.includes("\0") || defaultModel.includes('"')) {
    throw new RuntimeAdapterError("invalid-input");
  }
  return [
    "# Managed by synchronized-intellect-network (Synchronized Intellect Network).",
    "# Isolated codex home for the kimi-platform endpoint (ticket 17).",
    "# Workbench-owned: a damaged config.toml is rebuilt on the next launch;",
    "# nothing in this directory ever merges with a user-level ~/.codex.",
    `model = "${defaultModel}"`,
    `model_provider = "${KIMI_PLATFORM_CODEX_PROVIDER_ID}"`,
    // Live-verified 2026-09-05: moonshot /v1/responses rejects
    // reasoning.effort "default" (invalid_request_error). The workbench
    // "default" tier means unpinned; codex forwards its resolved effort to
    // the wire, so we pin a real provider value. "high" matches the
    // platform's own default behavior for forced-thinking coding models.
    'model_reasoning_effort = "high"',
    // Model metadata (ticket 21 micro-fix, binary-verified against the
    // installed codex 0.153.1): `model_context_window` IS a live ConfigToml
    // key there, and the session reports floor(95% × 262144) = 249036
    // usable tokens — the discount is the model-metadata
    // `effective_context_window_percent` default, NOT a failed seed (the
    // earlier "non-effect" reading in ticket 19 mistook the discount for a
    // fallback). `model_max_output_tokens` is NOT a ConfigToml key in
    // 0.153.1 (0 occurrences in the binary) — writing it was pure
    // decoration, so it is no longer seeded.
    "model_context_window = 262144",
    "",
    `[model_providers.${KIMI_PLATFORM_CODEX_PROVIDER_ID}]`,
    `name = "${KIMI_PLATFORM_CODEX_PROVIDER_ID}"`,
    `base_url = "${baseUrl}"`,
    `env_key = "${KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar}"`,
    // Live-verified 2026-09-05: codex 0.153-alpha dropped `wire_api = "chat"`
    // ("no longer supported" on startup); the CN platform serves the
    // Responses API at /v1/responses (verified HTTP 200), so "responses"
    // is the correct — and only working — wire for this transport.
    'wire_api = "responses"',
    "",
  ].join("\n");
}

/**
 * Ensure the isolated CODEX_HOME exists and carries the canonical
 * config.toml. Missing directory, missing file, unreadable file, and any
 * content drift from the canonical seeding are all repaired by rewriting the
 * canonical content (`restored: true`); a healthy directory is left untouched
 * (`restored: false`).
 */
export function ensureKimiPlatformCodexHome(
  configuration: KimiPlatformCodexHomeConfiguration,
): KimiPlatformCodexHomeState {
  const homeDirectory = configuration.homeDirectory;
  if (
    typeof homeDirectory !== "string" ||
    homeDirectory.trim().length === 0 ||
    homeDirectory.includes("\0")
  ) {
    throw new RuntimeAdapterError("invalid-input");
  }
  const canonical = composeKimiPlatformConfigToml(configuration);
  mkdirSync(homeDirectory, { recursive: true });
  const configPath = join(homeDirectory, KIMI_PLATFORM_CONFIG_TOML_FILE_NAME);
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
