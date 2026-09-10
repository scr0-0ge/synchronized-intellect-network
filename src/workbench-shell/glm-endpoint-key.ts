import { GLM_ENDPOINT_ENV_CONTRACT } from "../agent-runtime/claude/endpoint-env-factory.ts";
import type { EndpointSecretEnvelopeStore } from "./endpoint-secret-envelope-store.ts";
import { probeGlmEndpoint } from "./glm-endpoint-probe.ts";
import {
  createWorkbenchEndpointKeySource,
  endpointSecretEnvelopeStorePath,
  type WorkbenchEndpointKeySource,
  type WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

export { endpointSecretEnvelopeStorePath, maskEndpointSecretHint } from "./endpoint-key-source.ts";
export type {
  WorkbenchEndpointKeySource,
  WorkbenchEndpointKeySourceOptions,
} from "./endpoint-key-source.ts";

/**
 * Production constants for the GLM Coding Plan API-transport key (work order
 * 07, deputy-supervisor ruling 1). The subject binds every envelope this
 * Workbench writes for the GLM endpoint; the keyName is the endpoint-scoped
 * opaque short identifier; the store file lives in the Electron userData
 * directory (`%APPDATA%\synchronized-intellect-network` on Windows).
 *
 * Design of record: docs/adr/0022-api-transport-credential-envelope.md.
 */
export const GLM_ENDPOINT_KEY_SUBJECT =
  "workbench://runtime-endpoint/glm-coding-plan";
export const GLM_ENDPOINT_KEY_NAME = "glm-coding-plan";
export const GLM_ENDPOINT_SECRET_STORE_FILE_NAME =
  "endpoint-secret-envelope-store.json";

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeySource = WorkbenchEndpointKeySource;

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeySourceOptions =
  WorkbenchEndpointKeySourceOptions;

/**
 * The GLM Coding Plan endpoint's key source: the shared parameterized factory
 * (WO16 Part 1) bound to the GLM key name, the `GLM_ANTHROPIC_AUTH_TOKEN`
 * environment fallback, and the GLM probe (`x-api-key` POST
 * `<base>/v1/messages`, model id pinned to the GLM default wire name with the
 * "[1m]" variant suffix stripped — see glm-endpoint-probe.ts).
 */
export function createWorkbenchGlmEndpointKeySource(
  options: Omit<
    WorkbenchEndpointKeySourceOptions,
    "keyName" | "envContract" | "probeRequest"
  >,
): WorkbenchEndpointKeySource {
  return createWorkbenchEndpointKeySource({
    ...options,
    keyName: GLM_ENDPOINT_KEY_NAME,
    envContract: {
      authTokenEnvVar: GLM_ENDPOINT_ENV_CONTRACT.authTokenEnvVar,
      baseUrlEnvVar: GLM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar,
      defaultBaseUrl: GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl,
    },
    probeRequest: probeGlmEndpoint,
  });
}
