/**
 * Per-endpoint authentication semantics for the claude adapter family
 * (spec section B).
 *
 * - `subscription-oauth`: the historical classifier, byte-identical. Login and
 *   logout are provider flows and remain available.
 * - `api-key-static`: the endpoint carries a static token in its spawn
 *   environment. The `claude auth status --json` output is informational
 *   only — the healthy live shape is endpoint-pinned: `oauth_token` under an
 *   env bearer token (GLM/Kimi/DeepSeek; live spike 2026-09-02; the CLI
 *   reports an env bearer token as `oauth_token`, not `api_key`) and
 *   `api_key` under an injected ANTHROPIC_API_KEY (claude-api; P1 spike).
 *   Bound-ness is proven by the endpoint accepting a turn, never by this
 *   shape. Login/logout do not apply.
 */

import type { SubscriptionAuthenticationState } from "../subscription-authentication.ts";
import {
  classifyClaudeSubscriptionAuthentication,
  parseClaudeAuthenticationStatus,
} from "./authentication-status.ts";

export type ClaudeEndpointAuthenticationMode =
  | "subscription-oauth"
  | "api-key-static";

export const CLAUDE_ENDPOINT_AUTHENTICATION_MODES: readonly ClaudeEndpointAuthenticationMode[] =
  Object.freeze(["subscription-oauth", "api-key-static"]);

/**
 * Which `authMethod` the healthy `claude auth status --json` shape carries for
 * a static-key endpoint. The env **bearer-token** endpoints (GLM, Kimi,
 * DeepSeek — the CLI reports an env bearer token as `oauth_token`) and the
 * env **api-key** endpoint (claude-api: the CLI reports an injected
 * ANTHROPIC_API_KEY as `api_key`) each have exactly one healthy mechanism,
 * and a shape from the *other* mechanism means a different credential leaked
 * into the process — never bound.
 */
export type ClaudeApiKeyStaticHealthyAuthMethod = "oauth_token" | "api_key";

export const CLAUDE_API_KEY_STATIC_HEALTHY_AUTH_METHODS: readonly ClaudeApiKeyStaticHealthyAuthMethod[] =
  Object.freeze(["oauth_token", "api_key"]);

export type ApiKeyStaticProbeOutcome =
  | "accepted"
  | "rejected"
  | "unreachable"
  | "not-run";

/**
 * Mode-aware gate classifier for `claude auth status --json` output. The
 * subscription branch delegates to the historical classifier, so
 * `claude-code-desktop` behaviour is unchanged.
 */
export function classifyClaudeAuthenticationForMode(
  output: string,
  mode: ClaudeEndpointAuthenticationMode = "subscription-oauth",
  apiKeyStaticHealthyAuthMethod: ClaudeApiKeyStaticHealthyAuthMethod = "oauth_token",
): SubscriptionAuthenticationState {
  if (mode === "subscription-oauth") {
    return classifyClaudeSubscriptionAuthentication(output);
  }
  return classifyApiKeyStaticAuthenticationStatusShape(
    parseClaudeAuthenticationStatus(output),
    apiKeyStaticHealthyAuthMethod,
  );
}

/**
 * Static-key shape reading. Only the endpoint's own healthy live shape reads
 * as passable (`bound`): `oauth_token` for the env bearer-token endpoints
 * (live spike 2026-09-02), `api_key` for the claude-api endpoint (P1 spike:
 * the CLI reports an injected ANTHROPIC_API_KEY as `api_key`); a `claude.ai`
 * OAuth residue must never read as bound for a static-key endpoint, and the
 * *other* mechanism's shape means a different credential leaked into the
 * process — both stay `unknown`.
 */
export function classifyApiKeyStaticAuthenticationStatusShape(
  status:
    | ReturnType<typeof parseClaudeAuthenticationStatus>
    | undefined,
  healthyAuthMethod: ClaudeApiKeyStaticHealthyAuthMethod = "oauth_token",
): SubscriptionAuthenticationState {
  if (status === undefined) return "unknown";
  if (
    status.loggedIn === true &&
    status.authMethod === healthyAuthMethod &&
    status.apiProvider === "firstParty"
  ) {
    return "bound";
  }
  if (
    status.loggedIn === false &&
    status.authMethod === "none" &&
    status.apiProvider === "firstParty"
  ) {
    return "sign-in-required";
  }
  return "unknown";
}

export const CLAUDE_ENDPOINT_API_KEY_STATIC_PROBE_OUTCOMES: readonly ApiKeyStaticProbeOutcome[] =
  Object.freeze(["accepted", "rejected", "unreachable", "not-run"]);

/**
 * Bound-ness classification for a static-key endpoint. The probe is a minimal
 * turn against the endpoint: only its acceptance proves the key. The auth
 * status shape is never an input here.
 */
export function classifyApiKeyStaticAuthentication(input: {
  readonly keyConfigured: boolean;
  readonly probeOutcome: ApiKeyStaticProbeOutcome;
}): Readonly<{
  readonly state: SubscriptionAuthenticationState;
  readonly reason: string;
}> {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.keyConfigured !== "boolean" ||
    !CLAUDE_ENDPOINT_API_KEY_STATIC_PROBE_OUTCOMES.includes(input.probeOutcome)
  ) {
    throw new TypeError(
      "classifyApiKeyStaticAuthentication expects { keyConfigured: boolean, probeOutcome }.",
    );
  }
  if (input.probeOutcome === "not-run") {
    return { state: "unknown", reason: "probe-not-run" };
  }
  if (!input.keyConfigured) {
    return { state: "sign-in-required", reason: "key-not-configured" };
  }
  if (input.probeOutcome === "accepted") {
    return { state: "bound", reason: "key-accepted-by-endpoint" };
  }
  if (input.probeOutcome === "rejected") {
    return { state: "sign-in-required", reason: "key-rejected-by-endpoint" };
  }
  return { state: "unknown", reason: "endpoint-unreachable" };
}

/**
 * Login/logout availability per authentication mode. Static-key endpoints
 * report both actions unavailable: their binding is key configuration plus a
 * probe, not a provider session.
 */
export function claudeAuthenticationActionAvailability(
  mode: ClaudeEndpointAuthenticationMode,
): Readonly<
  Record<
    "login" | "logout",
    Readonly<{ readonly status: "available" | "unavailable"; readonly reason?: string }>
  >
> {
  if (!CLAUDE_ENDPOINT_AUTHENTICATION_MODES.includes(mode)) {
    throw new TypeError(`Unknown claude authentication mode: ${String(mode)}.`);
  }
  if (mode === "subscription-oauth") {
    return Object.freeze({
      login: Object.freeze({ status: "available" as const }),
      logout: Object.freeze({ status: "available" as const }),
    });
  }
  return Object.freeze({
    login: Object.freeze({
      status: "unavailable" as const,
      reason:
        "api-key-static endpoints carry a static token; binding is key configuration plus probe, not a login flow",
    }),
    logout: Object.freeze({
      status: "unavailable" as const,
      reason:
        "api-key-static endpoints have no provider session to terminate; key replacement is the equivalent operation",
    }),
  });
}
