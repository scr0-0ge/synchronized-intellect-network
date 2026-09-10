import { isValidEndpointBaseUrl } from "../agent-runtime/claude/endpoint-env-factory.ts";

/**
 * Zero-reasoning model-list fetch for the static Runtime Endpoints (ticket 14
 * module phase). One GET against the provider's documented /models endpoint —
 * free of token burn, so a startup pull does not violate adjudication (a)
 * (which bans token-burning probes from discovery, not free catalog pulls).
 * Five faces are wired: the GLM anthropic face (`<base>/v1/models`, entries
 * carry display_name/created_at — live-verified 2026-09-04, ticket 14), the
 * GLM openai face (`<base>/models`, same source), the Kimi Platform faces —
 * international (`https://api.moonshot.ai/v1/models`, kimi-api-research §6)
 * and CN (`https://api.moonshot.cn/v1/models`, live-verified 200 in ticket
 * 11 Comments with the owner's platform key; the CN domain is what the
 * kimi-platform endpoint's seeded transport actually talks to) — and the
 * DeepSeek face (`https://api.deepseek.com/models`, deepseek-api-research
 * §6). The openai-compatible faces are id-only: `created`/`owned_by` are
 * ignored.
 *
 * Kimi Code is a separate subscription product at `api.kimi.com/coding/`.
 * Its research record explicitly leaves a zero-inference models-list route
 * unverified, so it has no face here. In particular, a Kimi Code token must
 * never be sent to either Moonshot Platform face.
 *
 * Parsing is exact-shape fail-closed: the payload must be an object with a
 * `data` array of objects whose `id` is a non-empty, trimmed, whitespace- and
 * control-character-free string (unknown extra fields are ignored, optional
 * display metadata that fails validation is dropped, never propagated).
 * Like the GLM endpoint probe, the failure side is a coarse reason enum
 * sanitized by construction: no raw network error text, no response body, no
 * URL and no key material can travel inside an outcome, and `fetch` is
 * injectable so tests drive every path with fakes. Real network calls with
 * real keys belong to the supervisor's live acceptance, not to tests.
 */

export const ENDPOINT_MODELS_LIST_TIMEOUT_MILLISECONDS = 10_000;

/**
 * Upper bound for the injected deadline. A startup background pull must never
 * be able to hang the app because a caller passed an oversized timeout: values
 * above the ceiling are clamped down to it instead of throwing.
 */
export const ENDPOINT_MODELS_LIST_TIMEOUT_CEILING_MILLISECONDS = 10_000;

const MAXIMUM_LISTED_MODELS = 256;
const MAXIMUM_MODEL_ID_LENGTH = 200;
const MAXIMUM_DISPLAY_NAME_LENGTH = 200;
const MAXIMUM_CREATED_AT_LENGTH = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const WHITESPACE_PATTERN = /\s/u;
/** CLI-side context-window variant notation ("[1m]"), never returned by /models. */
const CONTEXT_VARIANT_SUFFIX_PATTERN = /\[[^\]]*\]$/u;

export type EndpointModelsListFaceId =
  | "glm-anthropic"
  | "glm-openai"
  | "kimi-platform"
  | "kimi-platform-cn"
  | "deepseek";

export interface EndpointModelsListEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: string;
}

export type EndpointModelsListFailureReason =
  | "token-missing"
  | "invalid-base-url"
  | "unauthorized"
  | "endpoint-error"
  | "server-error"
  | "network"
  | "timeout"
  | "malformed-response";

export type EndpointModelsListOutcome =
  | {
      readonly outcome: "success";
      readonly models: readonly EndpointModelsListEntry[];
    }
  | {
      readonly outcome: "failure";
      readonly reason: EndpointModelsListFailureReason;
    };

export interface EndpointModelsListFace {
  readonly faceId: EndpointModelsListFaceId;
  readonly defaultBaseUrl: string;
  readonly path: string;
  /** Throws on shape violations; a valid-but-empty `data` array is a success. */
  readonly parse: (payload: unknown) => readonly EndpointModelsListEntry[];
}

export const ENDPOINT_MODELS_LIST_FACES: Readonly<
  Record<EndpointModelsListFaceId, EndpointModelsListFace>
> = Object.freeze({
  "glm-anthropic": Object.freeze({
    faceId: "glm-anthropic",
    defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    path: "/v1/models",
    parse: parseGlmAnthropicPayload,
  }),
  "glm-openai": Object.freeze({
    faceId: "glm-openai",
    defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    path: "/models",
    parse: parseOpenAiCompatiblePayload,
  }),
  "kimi-platform": Object.freeze({
    faceId: "kimi-platform",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    path: "/models",
    parse: parseOpenAiCompatiblePayload,
  }),
  "kimi-platform-cn": Object.freeze({
    faceId: "kimi-platform-cn",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    path: "/models",
    parse: parseOpenAiCompatiblePayload,
  }),
  deepseek: Object.freeze({
    faceId: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com",
    path: "/models",
    parse: parseOpenAiCompatiblePayload,
  }),
});

export const GLM_ANTHROPIC_MODELS_LIST_URL = modelsListUrl("glm-anthropic");
export const GLM_OPENAI_MODELS_LIST_URL = modelsListUrl("glm-openai");
export const KIMI_PLATFORM_MODELS_LIST_URL = modelsListUrl("kimi-platform");
export const KIMI_PLATFORM_CN_MODELS_LIST_URL = modelsListUrl("kimi-platform-cn");
export const DEEPSEEK_MODELS_LIST_URL = modelsListUrl("deepseek");

export interface EndpointModelsListOptions {
  readonly face: EndpointModelsListFaceId;
  readonly authToken: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

export async function fetchEndpointModelsList(
  options: EndpointModelsListOptions,
): Promise<EndpointModelsListOutcome> {
  const face = (ENDPOINT_MODELS_LIST_FACES as Readonly<
    Record<string, EndpointModelsListFace | undefined>
  >)[options.face];
  if (face === undefined) {
    throw new TypeError("models-list options.face must be a known face id");
  }
  if (
    typeof options.authToken !== "string" ||
    options.authToken.trim().length === 0 ||
    options.authToken.includes("\0")
  ) {
    return Object.freeze({ outcome: "failure", reason: "token-missing" });
  }
  const baseUrl = options.baseUrl ?? face.defaultBaseUrl;
  if (!isValidEndpointBaseUrl(baseUrl)) {
    return Object.freeze({ outcome: "failure", reason: "invalid-base-url" });
  }
  const listFetch = options.fetch ?? globalThis.fetch;
  const timeoutMilliseconds = resolveTimeoutMilliseconds(options.timeoutMilliseconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    let response: Response;
    try {
      response = await listFetch(`${trimTrailingSlash(baseUrl)}${face.path}`, {
        method: "GET",
        // A redirect to another origin would silently carry the bearer header
        // to whatever host answered; refusing is the fail-closed behavior.
        redirect: "error",
        signal: controller.signal,
        headers: Object.freeze({
          accept: "application/json",
          authorization: `Bearer ${options.authToken}`,
        }),
      });
    } catch (error) {
      return Object.freeze(
        controller.signal.aborted || isAbortError(error)
          ? { outcome: "failure", reason: "timeout" }
          : { outcome: "failure", reason: "network" },
      );
    }
    if (response.status >= 200 && response.status < 300) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // A body read aborted by the deadline is a timeout, not malformation.
        return Object.freeze(
          controller.signal.aborted
            ? { outcome: "failure", reason: "timeout" }
            : { outcome: "failure", reason: "malformed-response" },
        );
      }
      try {
        return Object.freeze({ outcome: "success", models: face.parse(payload) });
      } catch {
        return Object.freeze({ outcome: "failure", reason: "malformed-response" });
      }
    }
    if (response.status === 401 || response.status === 403) {
      return Object.freeze({ outcome: "failure", reason: "unauthorized" });
    }
    if (response.status >= 500) {
      return Object.freeze({ outcome: "failure", reason: "server-error" });
    }
    return Object.freeze({ outcome: "failure", reason: "endpoint-error" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Given the current catalog's model ids and a fetched list's ids, returns the
 * listed ids the catalog does not know yet — in list order, deduplicated, as
 * bare base ids: the CLI-side context-window variant suffix ("[1m]") is
 * stripped from both sides, because /models returns bare ids while the static
 * catalog carries suffixed ones (ticket 14 §[1m] 变体处理).
 */
export function findNewEndpointModelIds(
  catalogModelIds: readonly string[],
  listedModelIds: readonly string[],
): readonly string[] {
  const known = new Set(catalogModelIds.map(stripContextVariantSuffix));
  const emitted = new Set<string>();
  const added: string[] = [];
  for (const listed of listedModelIds) {
    const base = stripContextVariantSuffix(listed);
    if (base.length === 0 || known.has(base) || emitted.has(base)) continue;
    emitted.add(base);
    added.push(base);
  }
  return Object.freeze(added);
}

function modelsListUrl(faceId: EndpointModelsListFaceId): string {
  const face = ENDPOINT_MODELS_LIST_FACES[faceId];
  return `${face.defaultBaseUrl}${face.path}`;
}

function resolveTimeoutMilliseconds(value: number | undefined): number {
  const requested = value ?? ENDPOINT_MODELS_LIST_TIMEOUT_MILLISECONDS;
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    throw new TypeError(
      "models-list timeoutMilliseconds must be a positive finite number",
    );
  }
  return Math.min(requested, ENDPOINT_MODELS_LIST_TIMEOUT_CEILING_MILLISECONDS);
}

class EndpointModelsPayloadError extends Error {
  constructor() {
    super("models-list payload violated the expected shape");
    this.name = "EndpointModelsPayloadError";
  }
}

function parseGlmAnthropicPayload(
  payload: unknown,
): readonly EndpointModelsListEntry[] {
  const data = requirePayloadDataArray(payload);
  const entries: EndpointModelsListEntry[] = [];
  for (const raw of data) {
    const record = requireEntryObject(raw);
    if (!isAcceptableModelId(record.id)) {
      throw new EndpointModelsPayloadError();
    }
    const displayName = acceptableDisplayString(
      (record as { display_name?: unknown }).display_name,
      MAXIMUM_DISPLAY_NAME_LENGTH,
    );
    const createdAt = acceptableDisplayString(
      (record as { created_at?: unknown }).created_at,
      MAXIMUM_CREATED_AT_LENGTH,
    );
    entries.push(
      Object.freeze({
        id: record.id,
        ...(displayName === undefined ? {} : { displayName }),
        ...(createdAt === undefined ? {} : { createdAt }),
      }),
    );
  }
  return Object.freeze(entries);
}

function parseOpenAiCompatiblePayload(
  payload: unknown,
): readonly EndpointModelsListEntry[] {
  const data = requirePayloadDataArray(payload);
  const entries: EndpointModelsListEntry[] = [];
  for (const raw of data) {
    const record = requireEntryObject(raw);
    if (!isAcceptableModelId(record.id)) {
      throw new EndpointModelsPayloadError();
    }
    entries.push(Object.freeze({ id: record.id }));
  }
  return Object.freeze(entries);
}

function requirePayloadDataArray(payload: unknown): readonly unknown[] {
  if (!isPlainObject(payload)) {
    throw new EndpointModelsPayloadError();
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length > MAXIMUM_LISTED_MODELS) {
    throw new EndpointModelsPayloadError();
  }
  return data;
}

function requireEntryObject(value: unknown): { id: unknown } {
  if (!isPlainObject(value)) {
    throw new EndpointModelsPayloadError();
  }
  return value as { id: unknown };
}

function isAcceptableModelId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > MAXIMUM_MODEL_ID_LENGTH) {
    return false;
  }
  if (value !== value.trim()) {
    return false;
  }
  return !CONTROL_CHARACTER_PATTERN.test(value) && !WHITESPACE_PATTERN.test(value);
}

/**
 * Optional display metadata is dropped (not fatal) whenever it fails these
 * coarse checks: a hostile endpoint must not be able to smuggle control
 * characters or oversized strings into renderer-facing surfaces, but a bad
 * display name must not poison an otherwise usable model id either.
 */
function acceptableDisplayString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length === 0 || value.length > maximumLength) {
    return undefined;
  }
  if (value !== value.trim()) {
    return undefined;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripContextVariantSuffix(value: string): string {
  return value.replace(CONTEXT_VARIANT_SUFFIX_PATTERN, "");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
