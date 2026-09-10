import { isValidEndpointBaseUrl } from "../agent-runtime/claude/endpoint-env-factory.ts";
import type { WorkbenchEndpointProbeOutcome } from "./contract.ts";

/**
 * Bare HTTP connectivity probe for the static-key Runtime Endpoints (ADR 0022
 * lane decision 3, generalized in WO16 Part 2 from the GLM-only module). The
 * probe shape is declared by each endpoint's contract:
 *
 * - `anthropic-messages`: one minimal POST to `<baseUrl>/v1/messages` — a
 *   single short message with `max_tokens: 1`, a few dozen tokens total. The
 *   auth header shape and the explicit model id are both pinned by the
 *   provider contract: GLM uses `x-api-key` (live-verified), Kimi accepts
 *   Bearer ONLY (its Messages OpenAPI declares bearerAuth alone — reusing the
 *   GLM `x-api-key` header shape is not portable there), and DeepSeek must not
 *   use this shape for identity reasons (unknown model names are silently
 *   mapped to `deepseek-v4-flash`, so a 200 would prove nothing about the
 *   model — a messages probe there may only ever pin an explicit catalog id).
 * - `openai-models-list`: a zero-inference `GET <baseUrl>/models` with a
 *   Bearer header (the DeepSeek preferred probe per ticket-12 research §6;
 *   also the platform-face list the Kimi pay-as-you-go face exposes).
 * - `anthropic-models-list`: a zero-inference `GET <baseUrl>/v1/models` with
 *   the `x-api-key` + `anthropic-version` header pair the Anthropic Models
 *   API documents (claude-api endpoint, ticket 21). Same honest scope: a 2xx
 *   proves auth + connectivity, nothing more.
 *
 * Every probe deliberately never goes through the provider CLI (whose smallest
 * round trip burns tens of thousands of input tokens) and never runs
 * automatically: the only caller is the user's explicit "test connection"
 * action in Settings.
 *
 * The outcome is a coarse reason enum, sanitized by construction: no raw
 * network error text, no response body, no URL and no key material can ever
 * travel inside an outcome. `fetch` is injectable, so tests drive every path
 * with fakes and never touch the network.
 */

export const ENDPOINT_PROBE_TIMEOUT_MILLISECONDS = 10_000;

/**
 * How the probe talks to the endpoint. `path` is appended to the resolved
 * base URL; `modelId` (messages shape) must be an explicit catalog model id —
 * never a resolved default the caller did not name.
 */
export type EndpointProbeShape =
  | {
      readonly kind: "anthropic-messages";
      /** `x-api-key` (GLM, live-verified) or `bearer` (Kimi, contract-only). */
      readonly auth: "x-api-key" | "bearer";
      readonly modelId: string;
    }
  | {
      readonly kind: "openai-models-list";
    }
  | {
      readonly kind: "anthropic-models-list";
    };

export interface EndpointProbeOptions {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly shape: EndpointProbeShape;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function probeEndpoint(
  options: EndpointProbeOptions,
): Promise<WorkbenchEndpointProbeOutcome> {
  if (!isValidEndpointBaseUrl(options.baseUrl)) {
    return Object.freeze({ outcome: "failure", reason: "invalid-base-url" });
  }
  const probeFetch = options.fetch ?? globalThis.fetch;
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? ENDPOINT_PROBE_TIMEOUT_MILLISECONDS;
  if (
    typeof timeoutMilliseconds !== "number" ||
    !Number.isFinite(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0
  ) {
    throw new TypeError("probe timeoutMilliseconds must be a positive number");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  let response: Response;
  try {
    if (options.shape.kind === "anthropic-messages") {
      response = await probeFetch(
        `${trimTrailingSlash(options.baseUrl)}/v1/messages`,
        {
          method: "POST",
          // A redirect to another origin would silently carry the key
          // header to whatever host answered; refusing is the fail-closed
          // behavior.
          redirect: "error",
          signal: controller.signal,
          headers:
            options.shape.auth === "x-api-key"
              ? Object.freeze({
                  "content-type": "application/json",
                  "x-api-key": options.authToken,
                  "anthropic-version": "2023-06-01",
                })
              : Object.freeze({
                  "content-type": "application/json",
                  authorization: `Bearer ${options.authToken}`,
                  "anthropic-version": "2023-06-01",
                }),
          body: JSON.stringify({
            model: options.shape.modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
      );
    } else if (options.shape.kind === "openai-models-list") {
      response = await probeFetch(`${trimTrailingSlash(options.baseUrl)}/models`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: Object.freeze({
          accept: "application/json",
          authorization: `Bearer ${options.authToken}`,
        }),
      });
    } else {
      response = await probeFetch(
        `${trimTrailingSlash(options.baseUrl)}/v1/models`,
        {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
          headers: Object.freeze({
            accept: "application/json",
            "x-api-key": options.authToken,
            "anthropic-version": "2023-06-01",
          }),
        },
      );
    }
  } catch (error) {
    return Object.freeze(
      controller.signal.aborted || isAbortError(error)
        ? { outcome: "failure", reason: "timeout" }
        : { outcome: "failure", reason: "network" },
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 200 && response.status < 300) {
    return Object.freeze({ outcome: "success" });
  }
  if (response.status === 401 || response.status === 403) {
    return Object.freeze({ outcome: "failure", reason: "unauthorized" });
  }
  if (response.status >= 500) {
    return Object.freeze({ outcome: "failure", reason: "server-error" });
  }
  return Object.freeze({ outcome: "failure", reason: "endpoint-error" });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
