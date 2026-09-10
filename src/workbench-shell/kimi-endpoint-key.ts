import {
  KIMI_ENDPOINT_ENV_CONTRACT,
  KIMI_DEFAULT_MODEL_ID,
} from "../agent-runtime/claude/kimi-catalog.ts";
import {
  KIMI_ENDPOINT_KEY_NAME,
  KIMI_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/claude/kimi-endpoint-key.ts";
import { probeEndpoint } from "./endpoint-probe.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";
import {
  createWorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

export {
  KIMI_ENDPOINT_KEY_NAME,
  KIMI_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/claude/kimi-endpoint-key.ts";

/**
 * Bare HTTP connectivity probe for the Kimi Code endpoint (WO16 Part 2). One
 * minimal POST to `<baseUrl>/v1/messages`, `max_tokens: 1` — but with the
 * Bearer auth header ONLY: the Kimi Anthropic-compatible face declares
 * bearerAuth alone, so the GLM probe's `x-api-key` header shape is not
 * portable here (ticket-13 research §6/§7). The model id is pinned to
 * `kimi-for-coding`, the one subscription-face model available to every
 * member tier: a probe model behind a higher membership could fail for
 * plan reasons the key's validity says nothing about. Forced thinking on
 * that model makes the one-token probe a "think-then-emit" truncation —
 * billing stays bounded and the 2xx still proves auth + connectivity.
 */
export interface KimiEndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeKimiEndpoint(
  options: KimiEndpointProbeOptions,
): Promise<WorkbenchEndpointProbeOutcome> {
  return probeEndpoint({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    shape: Object.freeze({
      kind: "anthropic-messages",
      auth: "bearer",
      modelId: KIMI_DEFAULT_MODEL_ID,
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
}

/**
 * The Kimi Code endpoint's key source: the shared parameterized factory
 * (WO16 Part 1) bound to the Kimi key name, the
 * `KIMI_CODE_ANTHROPIC_AUTH_TOKEN` environment fallback, and the Bearer-only
 * Kimi probe above.
 */
export function createWorkbenchKimiEndpointKeySource(
  options: Omit<
    WorkbenchEndpointKeySourceOptions,
    "keyName" | "envContract" | "probeRequest"
  >,
): WorkbenchEndpointKeySource {
  return createWorkbenchEndpointKeySource({
    ...options,
    keyName: KIMI_ENDPOINT_KEY_NAME,
    envContract: {
      authTokenEnvVar: KIMI_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
      baseUrlEnvVar: KIMI_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
      defaultBaseUrl: KIMI_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    },
    probeRequest: probeKimiEndpoint,
  });
}
