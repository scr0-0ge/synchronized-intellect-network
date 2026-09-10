import {
  DEEPSEEK_ENDPOINT_ENV_CONTRACT,
} from "../agent-runtime/claude/deepseek-catalog.ts";
import {
  DEEPSEEK_ENDPOINT_KEY_NAME,
  DEEPSEEK_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/claude/deepseek-endpoint-key.ts";
import { probeEndpoint } from "./endpoint-probe.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";
import {
  createWorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

export {
  DEEPSEEK_ENDPOINT_KEY_NAME,
  DEEPSEEK_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/claude/deepseek-endpoint-key.ts";

/**
 * Bare HTTP connectivity probe for the DeepSeek API endpoint (WO16 Part 2).
 * The preferred probe is the zero-inference `GET <platform>/models` with a
 * Bearer header (ticket-13 research §6) — no model id is sent at all, which
 * is exactly right for this endpoint: unknown model names are silently mapped
 * to `deepseek-v4-flash` and answered 200 (deepseek-catalog.ts hard design
 * constraint), so a messages-shaped probe could never prove model identity
 * and must never rely on implicit model resolution. A 2xx here proves auth +
 * connectivity, nothing more — the honest scope of every probe on this
 * surface.
 *
 * The probe target lives on the platform face, not the Anthropic face the
 * sessions use: the resolved endpoint base URL's trailing `/anthropic`
 * segment is stripped (the contract default `https://api.deepseek.com/anthropic`
 * therefore probes `https://api.deepseek.com/models`; a custom proxy base
 * gets the same deterministic strip).
 */
export interface DeepseekEndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeDeepseekEndpoint(
  options: DeepseekEndpointProbeOptions,
): Promise<WorkbenchEndpointProbeOutcome> {
  return probeEndpoint({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    shape: Object.freeze({ kind: "openai-models-list" }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
}

// If a messages-shaped fallback arm is ever added, it must pin an explicit
// catalog model id (see the hard design constraint above) — implicit model
// resolution can never back a DeepSeek probe.

/**
 * The DeepSeek API endpoint's key source: the shared parameterized factory
 * (WO16 Part 1) bound to the DeepSeek key name, the
 * `DEEPSEEK_ANTHROPIC_AUTH_TOKEN` environment fallback, and the platform-face
 * models-list probe above.
 */
export function createWorkbenchDeepseekEndpointKeySource(
  options: Omit<
    WorkbenchEndpointKeySourceOptions,
    "keyName" | "envContract" | "probeRequest" | "probeBaseUrl"
  >,
): WorkbenchEndpointKeySource {
  return createWorkbenchEndpointKeySource({
    ...options,
    keyName: DEEPSEEK_ENDPOINT_KEY_NAME,
    envContract: {
      authTokenEnvVar: DEEPSEEK_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
      baseUrlEnvVar: DEEPSEEK_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
      defaultBaseUrl: DEEPSEEK_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    },
    probeRequest: probeDeepseekEndpoint,
    probeBaseUrl: resolveDeepseekProbeBaseUrl,
  });
}

function resolveDeepseekProbeBaseUrl(
  environment: NodeJS.ProcessEnv,
): string {
  const explicit =
    environment[DEEPSEEK_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar];
  const resolved =
    typeof explicit === "string" && explicit.trim().length > 0
      ? explicit
      : DEEPSEEK_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
  return resolved.replace(/\/anthropic\/?$/u, "");
}
