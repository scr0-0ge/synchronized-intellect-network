import { KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT } from "../agent-runtime/codex/endpoint-env-factory.ts";
import {
  KIMI_PLATFORM_ENDPOINT_KEY_NAME,
  KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/codex/kimi-platform-key.ts";
import { probeEndpoint } from "./endpoint-probe.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";
import {
  createWorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

export {
  KIMI_PLATFORM_ENDPOINT_KEY_NAME,
  KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
} from "../agent-runtime/codex/kimi-platform-key.ts";

/**
 * Bare HTTP connectivity probe for the kimi-platform endpoint (ticket 17).
 * The preferred probe is the zero-inference `GET <platform>/v1/models` with
 * a Bearer header — the exact request the supervisor's live check used
 * (ticket 11 Comments: 200 with the four catalog models, at zero cost). A
 * 2xx proves auth + connectivity, nothing more — the honest scope of every
 * probe on this surface. The probe base URL is the provider base URL the
 * seeded config.toml carries (`https://api.moonshot.cn/v1` by default), so
 * `/models` appends cleanly; unlike DeepSeek no face-stripping is needed.
 */
export interface KimiPlatformEndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeKimiPlatformEndpoint(
  options: KimiPlatformEndpointProbeOptions,
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
 * The kimi-platform endpoint's key source: the shared parameterized factory
 * (WO16 Part 1) bound to the kimi-platform key name, the
 * `KIMI_PLATFORM_API_KEY` environment fallback, and the models-list probe
 * above. Since ticket 20 the endpoint-key channel roster
 * (`WORKBENCH_ENDPOINT_KEY_ENDPOINT_IDS`) carries this endpoint too, so the
 * same source serves the settings key surface and the composition's
 * `source.resolve()`.
 */
export function createWorkbenchKimiPlatformKeySource(
  options: Omit<
    WorkbenchEndpointKeySourceOptions,
    "keyName" | "envContract" | "probeRequest"
  >,
): WorkbenchEndpointKeySource {
  return createWorkbenchEndpointKeySource({
    ...options,
    keyName: KIMI_PLATFORM_ENDPOINT_KEY_NAME,
    envContract: {
      authTokenEnvVar: KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar,
      baseUrlEnvVar: KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
      defaultBaseUrl: KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    },
    probeRequest: probeKimiPlatformEndpoint,
  });
}
