import {
  CLAUDE_API_ENDPOINT_ENV_CONTRACT,
  CLAUDE_API_ENDPOINT_KEY_NAME,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/claude/claude-api-endpoint.ts";
import { probeEndpoint } from "./endpoint-probe.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";
import {
  createWorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

export {
  CLAUDE_API_ENDPOINT_KEY_NAME,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/claude/claude-api-endpoint.ts";

/**
 * Bare HTTP connectivity probe for the claude-api endpoint (ticket 21). The
 * preferred probe is the zero-inference `GET <base>/v1/models` with the
 * `x-api-key` + `anthropic-version` header pair the Anthropic Models API
 * documents — no tokens are spent. A 2xx proves auth + connectivity,
 * nothing more — the honest scope of every probe on this surface.
 */
export interface ClaudeApiEndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeClaudeApiEndpoint(
  options: ClaudeApiEndpointProbeOptions,
): Promise<WorkbenchEndpointProbeOutcome> {
  return probeEndpoint({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    shape: Object.freeze({ kind: "anthropic-models-list" }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
}

/**
 * The claude-api endpoint's key source: the shared parameterized factory
 * (WO16 Part 1) bound to the claude-api key name, the dedicated
 * `CLAUDE_API_KEY` environment fallback, and the models-list probe above.
 */
export function createWorkbenchClaudeApiEndpointKeySource(
  options: Omit<
    WorkbenchEndpointKeySourceOptions,
    "keyName" | "envContract" | "probeRequest"
  >,
): WorkbenchEndpointKeySource {
  return createWorkbenchEndpointKeySource({
    ...options,
    keyName: CLAUDE_API_ENDPOINT_KEY_NAME,
    envContract: {
      authTokenEnvVar: CLAUDE_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
      baseUrlEnvVar: CLAUDE_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
      defaultBaseUrl: CLAUDE_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    },
    probeRequest: probeClaudeApiEndpoint,
  });
}
