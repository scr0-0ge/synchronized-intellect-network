import { GLM_DEFAULT_MODEL_ID } from "../agent-runtime/claude/glm-catalog.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";
import { probeEndpoint } from "./endpoint-probe.ts";

/**
 * Bare HTTP connectivity probe for the GLM Coding Plan endpoint — the GLM
 * specialization of the shared `probeEndpoint` shape (WO16 Part 2). One
 * minimal POST to `<baseUrl>/v1/messages` with the `x-api-key` header shape
 * live-verified on 2026-09-04; the CLI-side context-window variant suffix
 * ("[1m]") is stripped here so the raw /v1/messages endpoint receives the
 * base wire name (a suffixed name is rejected with HTTP 400 code 1214).
 *
 * Design of record: ADR 0022; see endpoint-probe.ts for the shared contract.
 */

export const GLM_ENDPOINT_PROBE_TIMEOUT_MILLISECONDS = 10_000;

export interface GlmEndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeGlmEndpoint(
  options: GlmEndpointProbeOptions,
): Promise<WorkbenchEndpointProbeOutcome> {
  return probeEndpoint({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    shape: Object.freeze({
      kind: "anthropic-messages",
      auth: "x-api-key",
      // CLI model ids carry a context-window variant suffix ("[1m]"); the raw
      // /v1/messages endpoint rejects it, so the probe strips the suffix and
      // sends the base wire name (live-verified 2026-09-04).
      modelId: GLM_DEFAULT_MODEL_ID.replace(/\[[^\]]*\]$/u, ""),
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
}
