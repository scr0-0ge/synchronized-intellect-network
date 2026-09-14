/**
 * GLM Coding Plan proactive usage-window read (w292). Zhipu's Anthropic-
 * compatible endpoint carries no rate-limit headers (verified: `/v1/messages`
 * responses have none), so the only way to show the same "5-hour / 7-day"
 * telemetry Codex/Claude get is a direct GET against Zhipu's own monitor API,
 * live-verified by the owner (2026-09-14) against both bases:
 *
 *   GET <monitorBase>/api/monitor/usage/quota/limit
 *   Authorization: <GLM key, verbatim, no "Bearer ">
 *   Accept-Language: en-US,en
 *   Content-Type: application/json
 *   -> { code, msg, success, data: { level, limits: [
 *          { type: "CREDIT_LIMIT", unit, number, percentage, nextResetTime, ... }
 *        ] } }
 *
 * `unit: 3, number: 5` is the 5-hour window; `unit: 6, number: 1` is the
 * 7-day window (confirmed by the owner's second live sample). `percentage` is
 * 0-100 used%, `nextResetTime` is already epoch milliseconds.
 *
 * A live sample against this same worker's configured key returned HTTP 200
 * with `{ code: 1000, success: false, msg: "Authentication Failed" }` (no
 * `data`) on both bases -- an authentication failure this endpoint reports
 * as HTTP 200, not 401. The parser below never trusts the HTTP status alone:
 * it requires `success === true` and a well-shaped `data.limits` regardless
 * of status, so that failure mode (and any other) degrades to `undefined`
 * the same way a non-200 or a missing `limits` would.
 *
 * The GET reuses the endpoint's already-configured key and Base URL (the
 * same live resolvers / `GLM_ANTHROPIC_AUTH_TOKEN` env fallback the spawn
 * environment factory uses) and never invents a second credential path. It
 * never fabricates a percentage: any missing credential, network failure, or
 * unrecognized response shape reports a fixed diagnostic and yields
 * `undefined`, which composition already renders as "not yet observed".
 */

import type {
  ControllableRuntimeBinding,
  RuntimeResume,
  RuntimeStart,
  RuntimeUsageObservation,
  RuntimeUsageObserver,
  RuntimeUsageWindow,
} from "../index.ts";
import { isVendorRecord } from "../vendor-wire.ts";
import { ClaudeAdapter } from "./adapter.ts";
import {
  GLM_ENDPOINT_ENV_CONTRACT,
  isValidEndpointBaseUrl,
} from "./endpoint-env-factory.ts";

export const GLM_USAGE_WINDOWS_SOURCE = "zhipu-monitor" as const;
export const GLM_USAGE_WINDOWS_PATH = "/api/monitor/usage/quota/limit";
export const GLM_USAGE_WINDOWS_TIMEOUT_MILLISECONDS = 10_000;

/** A vendor-controlled array; bounded the same way every other vendor array in this codebase is. */
const maximumCreditLimitEntries = 32;

function reportGlmUsageWindowsDiagnostic(message: string): void {
  try {
    process.stderr.write(`[glm-usage-windows] ${message}\n`);
  } catch {
    // Losing a diagnostic must not change the outcome of a Runtime operation.
  }
}

/** Same host as the configured Anthropic-compatible base URL (`open.bigmodel.cn` <-> `api.z.ai`). */
export function deriveGlmMonitorBaseUrl(anthropicBaseUrl: string): string | undefined {
  if (!isValidEndpointBaseUrl(anthropicBaseUrl)) return undefined;
  try {
    const url = new URL(anthropicBaseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/**
 * `GET .../api/monitor/usage/quota/limit` -> `RuntimeUsageObservation`. Fails
 * closed to `undefined` on any shape mismatch -- never throws, never
 * fabricates a window. `type !== "CREDIT_LIMIT"` or an unrecognized
 * `unit`/`number` pair is tolerated (skipped) rather than failing the whole
 * read, but the two required windows must each be valid exactly once. A
 * partial or ambiguous reading would otherwise display made-up completeness.
 */
export function parseGlmUsageWindowsResponse(
  value: unknown,
  endpointKey: string,
  observedAt: number,
): RuntimeUsageObservation | undefined {
  if (!isVendorRecord(value, ["code", "data", "success"]) || value.success !== true) {
    return undefined;
  }
  const data = value.data;
  if (!isVendorRecord(data, ["limits"]) || !Array.isArray(data.limits) ||
      data.limits.length > maximumCreditLimitEntries) {
    return undefined;
  }
  const windows: RuntimeUsageWindow[] = [];
  const seenLabels = new Set<RuntimeUsageWindow["label"]>();
  for (const entry of data.limits) {
    const label = glmCreditLimitWindowLabel(entry);
    if (label === undefined) continue;
    const window = parseGlmCreditLimitWindow(entry);
    if (window === undefined || seenLabels.has(label)) return undefined;
    seenLabels.add(window.label);
    windows.push(window);
  }
  if (!seenLabels.has("five-hour") || !seenLabels.has("seven-day")) return undefined;
  return Object.freeze({
    endpointKey,
    windows: Object.freeze(windows),
    observedAt,
    source: GLM_USAGE_WINDOWS_SOURCE,
  });
}

function parseGlmCreditLimitWindow(value: unknown): RuntimeUsageWindow | undefined {
  if (!isVendorRecord(value, ["nextResetTime", "number", "percentage", "type", "unit"])) {
    return undefined;
  }
  const label = glmCreditLimitWindowLabel(value);
  if (label === undefined) return undefined;
  const percentage = value.percentage;
  if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return undefined;
  }
  const resetsAt = value.nextResetTime;
  if (!Number.isSafeInteger(resetsAt) || (resetsAt as number) <= 0 || (resetsAt as number) > 8_640_000_000_000_000) {
    return undefined;
  }
  return Object.freeze({ label, utilization: percentage / 100, resetsAt: resetsAt as number });
}

function glmCreditLimitWindowLabel(value: unknown): RuntimeUsageWindow["label"] | undefined {
  if (!isVendorRecord(value, ["number", "type", "unit"]) || value.type !== "CREDIT_LIMIT") {
    return undefined;
  }
  return value.unit === 3 && value.number === 5
    ? "five-hour"
    : value.unit === 6 && value.number === 1
      ? "seven-day"
      : undefined;
}

export interface GlmUsageWindowsRequest {
  readonly endpointKey: string;
  readonly authToken: string;
  /** The endpoint's configured Anthropic-compatible base URL; the monitor host is derived from it. */
  readonly anthropicBaseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

/**
 * One GET, one parse. Never retried, never polled -- callers decide when to
 * call this (session start/resume). A redirect is refused rather than
 * followed: the same reason `endpoint-probe.ts` refuses one, an
 * unexpected-origin redirect must not carry the Authorization header there.
 */
export async function fetchGlmUsageWindows(
  request: GlmUsageWindowsRequest,
): Promise<RuntimeUsageObservation | undefined> {
  const monitorBaseUrl = deriveGlmMonitorBaseUrl(request.anthropicBaseUrl);
  if (monitorBaseUrl === undefined) {
    reportGlmUsageWindowsDiagnostic(
      "GLM usage-windows: the configured base URL is invalid; usage is not displayed for this session.",
    );
    return undefined;
  }
  const doFetch = request.fetch ?? globalThis.fetch;
  const timeoutMilliseconds = request.timeoutMilliseconds ?? GLM_USAGE_WINDOWS_TIMEOUT_MILLISECONDS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  let response: Response;
  try {
    response = await doFetch(`${monitorBaseUrl}${GLM_USAGE_WINDOWS_PATH}`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: Object.freeze({
        Authorization: request.authToken,
        "Accept-Language": "en-US,en",
        "Content-Type": "application/json",
      }),
    });
  } catch {
    reportGlmUsageWindowsDiagnostic(
      "GLM usage-windows request failed or timed out; usage is not displayed for this session.",
    );
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) {
    reportGlmUsageWindowsDiagnostic(
      "GLM usage-windows endpoint returned a non-200 response; usage is not displayed for this session.",
    );
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    reportGlmUsageWindowsDiagnostic(
      "GLM usage-windows response is not valid JSON; usage is not displayed for this session.",
    );
    return undefined;
  }
  const observation = parseGlmUsageWindowsResponse(body, request.endpointKey, Date.now());
  if (observation === undefined) {
    reportGlmUsageWindowsDiagnostic(
      "GLM usage-windows response is unrecognized, rejected, or carries no usable window; usage is not displayed for this session.",
    );
  }
  return observation;
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Same resolution order the spawn environment factory uses: live resolver, then the contract's env var. */
function readGlmAuthTokenFromEnvironment(source: NodeJS.ProcessEnv): string | undefined {
  const value = source[GLM_ENDPOINT_ENV_CONTRACT.authTokenEnvVar];
  return isNonEmpty(value) ? value : undefined;
}

function readGlmBaseUrlFromEnvironment(source: NodeJS.ProcessEnv): string | undefined {
  const value = source[GLM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar];
  return isNonEmpty(value) ? value : undefined;
}

export interface GlmUsageWindowsSource {
  readonly endpointKey: string;
  readonly observeUsage: RuntimeUsageObserver;
  readonly resolveAuthToken: () => string | undefined;
  readonly resolveBaseUrl: () => string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

/**
 * Builds the live credential resolvers `GlmRuntimeAdapterWithUsageWindows`
 * calls on every start/resume -- the same "live store resolver, env fallback,
 * contract default" chain `createGlmEndpointEnvironmentSource` already uses
 * for the spawn environment, so a key saved (or rotated) in Settings applies
 * to the next read without reconstructing anything. No new read path.
 */
export function createGlmUsageWindowsSource(options: {
  readonly endpointKey: string;
  readonly observeUsage: RuntimeUsageObserver;
  readonly environment: NodeJS.ProcessEnv;
  readonly resolveAuthToken?: () => string | undefined;
  readonly resolveBaseUrl?: () => string | undefined;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}): GlmUsageWindowsSource {
  return Object.freeze({
    endpointKey: options.endpointKey,
    observeUsage: options.observeUsage,
    fetch: options.fetch,
    timeoutMilliseconds: options.timeoutMilliseconds,
    resolveAuthToken: () => {
      const resolved = options.resolveAuthToken?.();
      return isNonEmpty(resolved)
        ? resolved
        : readGlmAuthTokenFromEnvironment(options.environment);
    },
    resolveBaseUrl: () => {
      const resolved = options.resolveBaseUrl?.();
      return isNonEmpty(resolved)
        ? resolved
        : readGlmBaseUrlFromEnvironment(options.environment) ??
          GLM_ENDPOINT_ENV_CONTRACT.defaultBaseUrl;
    },
  });
}

/**
 * Decorates the GLM `ClaudeAdapter` with a proactive read of Zhipu's monitor
 * endpoint after every successful start/resume, alongside the reactive
 * 429-exhaustion-text sink `ClaudeRuntimeBinding` already carries. Subclassed
 * (not wrapped in a plain delegate) so `instanceof ClaudeAdapter` keeps
 * holding for composition's static-catalog-augmentation check
 * (`runtime-endpoint-composition.ts`'s `usesStaticCatalogAugmentation` gate);
 * every other method and the binding `start`/`resume` return are inherited
 * unchanged.
 *
 * The fetch is fire-and-forget, started only after the binding already
 * exists: a slow or failing Zhipu read can never delay or fail a session
 * start, matching "GET monitor is not inference; failure never affects the
 * turn" (w292).
 */
export class GlmRuntimeAdapterWithUsageWindows extends ClaudeAdapter {
  readonly #usageWindows: GlmUsageWindowsSource;

  constructor(
    usageWindows: GlmUsageWindowsSource,
    ...rest: ConstructorParameters<typeof ClaudeAdapter>
  ) {
    super(...rest);
    this.#usageWindows = usageWindows;
  }

  override async start(request: RuntimeStart): Promise<ControllableRuntimeBinding> {
    const binding = await super.start(request);
    this.#observeUsageWindows();
    return binding;
  }

  override async resume(request: RuntimeResume): Promise<ControllableRuntimeBinding> {
    const binding = await super.resume(request);
    this.#observeUsageWindows();
    return binding;
  }

  #observeUsageWindows(): void {
    const authToken = this.#usageWindows.resolveAuthToken();
    if (authToken === undefined) {
      reportGlmUsageWindowsDiagnostic(
        "GLM usage-windows: no auth token is configured; usage is not displayed for this session.",
      );
      return;
    }
    const anthropicBaseUrl = this.#usageWindows.resolveBaseUrl();
    const { endpointKey, observeUsage, fetch: fetchImpl, timeoutMilliseconds } = this.#usageWindows;
    void fetchGlmUsageWindows({
      endpointKey,
      authToken,
      anthropicBaseUrl,
      fetch: fetchImpl,
      timeoutMilliseconds,
    })
      .then((observation) => (observation === undefined ? undefined : observeUsage(observation)))
      .catch(() => {
        // Usage-window telemetry must never affect a healthy session.
      });
  }
}
