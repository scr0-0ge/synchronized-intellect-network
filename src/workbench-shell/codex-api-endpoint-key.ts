import { CODEX_API_ENDPOINT_ENV_CONTRACT } from "../agent-runtime/codex/endpoint-env-factory.ts";
import {
  CODEX_API_ENDPOINT_KEY_NAME,
  CODEX_API_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/codex/codex-api-endpoint-key.ts";
import { probeEndpoint } from "./endpoint-probe.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";
import {
  createWorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

export {
  CODEX_API_ENDPOINT_KEY_NAME,
  CODEX_API_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/codex/codex-api-endpoint-key.ts";

/**
 * Bare HTTP connectivity probe for the codex-api endpoint (ticket 21): the
 * zero-inference `GET <base>/models` with a Bearer header against the OpenAI
 * platform face (the provider base URL the seeded config.toml carries,
 * `https://api.openai.com/v1` by default, so `/models` appends cleanly). A
 * 2xx proves auth + connectivity, nothing more.
 */
export interface CodexApiEndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeCodexApiEndpoint(
  options: CodexApiEndpointProbeOptions,
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

/**
 * The codex-api endpoint's key source: the shared parameterized factory
 * (WO16 Part 1) bound to the codex-api key name, the dedicated
 * `CODEX_API_KEY` environment fallback, and the models-list probe above.
 */
export function createWorkbenchCodexApiEndpointKeySource(
  options: Omit<
    WorkbenchEndpointKeySourceOptions,
    "keyName" | "envContract" | "probeRequest"
  >,
): WorkbenchEndpointKeySource {
  return createWorkbenchEndpointKeySource({
    ...options,
    keyName: CODEX_API_ENDPOINT_KEY_NAME,
    envContract: {
      authTokenEnvVar: CODEX_API_ENDPOINT_ENV_CONTRACT.apiKeySourceEnvVar,
      baseUrlEnvVar: CODEX_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
      defaultBaseUrl: CODEX_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    },
    probeRequest: probeCodexApiEndpoint,
  });
}
