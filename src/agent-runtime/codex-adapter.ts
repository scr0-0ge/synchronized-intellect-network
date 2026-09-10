import { types as nodeUtilTypes } from "node:util";
import {
  vendorRecordExtraKeys as catalogModelExtraKeys,
  vendorRecordOwnKeys as catalogRecordOwnKeys,
  isSafeVendorText as isSafeCatalogText,
  hasUnpairedSurrogate,
  isVendorRecord,
} from "./vendor-wire.ts";
export { vendorRecordExtraKeys as catalogModelExtraKeys } from "./vendor-wire.ts";

import type {
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeModel,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "./index.ts";
import { RuntimeAdapterError } from "./index.ts";
import { CodexRuntimeBinding } from "./codex/binding.ts";
import type { CodexNativeTurnAccess } from "./codex/binding.ts";
import { createOfficialCodexTransport } from "./codex/process-transport.ts";
import { discoverOfficialCodexExecutable } from "./codex/process-transport.ts";
import type { CodexExecutableDiscoveryResult } from "./codex/executable-discovery.ts";
import type {
  CodexEndpointEnvironmentResolver,
} from "./codex/endpoint-env-factory.ts";
import { resolveCodexEndpointProcessEnvironment } from "./codex/endpoint-env-factory.ts";
import { asObject, CodexJsonlPeer, reportCodexDiagnostic, toRuntimeError } from "./codex/protocol.ts";
import type { OfficialRuntimeTransportFactory } from "./codex/transport.ts";
import type { ProviderRequestBudget } from "./provider-request-budget.ts";


/**
 * The exact recognised `model/list` model shape. Extended deliberately under
 * rule 1 (`F26`, `F34`) whenever the Runtime ships a new field: the structure
 * grows by an admitted key with a validating check and a matching adversarial
 * row, never by relaxing the gate into a pass-through.
 *
 * `modelSpecialty` and `multiAgentVersion` were admitted on 2026-08-15 after a
 * real catalog read against the official CLI returned all seven models carrying
 * them, which the previous sixteen-key set rejected as `catalog-invalid` — the
 * live outage `F110` predicted. Observed values were `null` for every
 * `modelSpecialty`, and `"v1"`, `"v2"` or `null` for `multiAgentVersion`. Both
 * are validated and then dropped by construction: `RuntimeModel` carries no
 * such member, so neither reaches the product (rule 20, `F34`).
 */
const currentFullCatalogModelKeys = [
  "additionalSpeedTiers",
  "availabilityNux",
  "defaultReasoningEffort",
  "defaultServiceTier",
  "description",
  "displayName",
  "hidden",
  "id",
  "inputModalities",
  "isDefault",
  "model",
  "modelSpecialty",
  "multiAgentVersion",
  "serviceTiers",
  "supportedReasoningEfforts",
  "supportsPersonality",
  "upgrade",
  "upgradeInfo",
] as const;

/**
 * The three smaller recognised model generations. Under the 2026-08-16 `F110`
 * round-2 decision every recognised catalog shape is an asymmetric superset
 * contract — required keys must be present, unknown additional keys are
 * tolerated — so a model is classified by the *richest* shape it satisfies.
 * Precedence does the discrimination the old exact-key arithmetic used to do:
 * every full model is also a superset of all three of these, and only the
 * classification order keeps it on the fully validated branch.
 */
const legacyCatalogModelKeys = ["id", "supportedReasoningEfforts"] as const;
const currentBriefCatalogModelKeys = [
  "displayName",
  "id",
  "supportedReasoningEfforts",
] as const;
const currentNamedCatalogModelKeys = [
  "displayName",
  "id",
  "model",
  "supportedReasoningEfforts",
] as const;

/**
 * One `model/list` page carries at most 1,000 models, and a global vendor change
 * hits every one of them identically, so an unbounded rejection log would repeat
 * the same diagnosis a thousand times. Keep a bounded sample and a count.
 */
const catalogRejectionRecordLimit = 32;

/**
 * Why one model was refused, in the directions that demand different
 * responses. A vendor that *added* `x` needs `x` admitted; a vendor that
 * *removed* `y` needs the product to stop requiring `y`; a vendor that sent a
 * recognised key with an unusable *value* needs that key's validation
 * revisited. A symmetric set difference cannot tell those apart, so they are
 * reported separately: `unknownKeys`/`missingKeys` diagnose a shape mismatch
 * against the full recognised shape, and `invalidValueKeys` names the
 * recognised fields whose values failed validation on a shape that matched.
 */
export type CodexCatalogRejection = Readonly<{
  readonly modelId: string;
  readonly unknownKeys: readonly string[];
  readonly missingKeys: readonly string[];
  readonly invalidValueKeys: readonly string[];
}>;

/**
 * What a catalog read observed about wire drift.
 *
 * `F110`'s live cost was not only that the parser failed closed — it was that
 * *nothing said which field*, so the owner could not tell a vendor change from a
 * broken install. This carries that fact out of the parser.
 */
export type CodexCatalogObservation = Readonly<{
  /**
   * Unrecognised keys admitted on an otherwise recognised catalog record, at
   * any tolerated layer: the page envelope, a model shape, an effort entry, a
   * service tier, `upgradeInfo`, or `availabilityNux`.
   */
  readonly toleratedKeys: readonly string[];
  readonly rejections: readonly CodexCatalogRejection[];
  /** Rejections beyond `catalogRejectionRecordLimit`, counted but not recorded. */
  readonly rejectionsOmitted: number;
}>;

export type CodexCatalogObserver = (
  observation: CodexCatalogObservation,
) => void;

/**
 * The collector is threaded through the parser as an explicit parameter rather
 * than as an observer callback. A callback would let vendor data drive
 * caller-supplied code from inside the parser, where a single throw would turn a
 * perfectly good catalog into a failed one. This can only accumulate; the one
 * call out happens at a single point in `inspect`.
 */
type CatalogObservationCollector = {
  readonly toleratedKeys: Set<string>;
  readonly rejections: CodexCatalogRejection[];
  rejectionsOmitted: number;
};

function createCatalogObservationCollector(): CatalogObservationCollector {
  return { toleratedKeys: new Set(), rejections: [], rejectionsOmitted: 0 };
}

function noteToleratedCatalogKeys(
  collector: CatalogObservationCollector,
  keys: readonly string[],
): void {
  for (const key of keys) collector.toleratedKeys.add(key);
}

function readCatalogDataProperty(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A failure that belongs to one model rather than to the wire. Everything
 * thrown with this class inside `parseNativeCatalogModel` quarantines that one
 * model; anything else — a bad page envelope, a repeated cursor, a duplicated
 * model id — stays fatal for the whole read. The class is deliberately NOT a
 * `RuntimeAdapterError`: it never crosses the adapter boundary, and keeping it
 * distinct means a page-level catch cannot accidentally swallow a wire fault.
 *
 * `shapeMismatch` selects the diagnosis: a value that matched no recognised
 * shape is diagnosed as key drift against the full shape, while a matched
 * shape with an unusable value names the offending recognised fields instead.
 */
class CatalogModelInvalidError extends Error {
  readonly invalidValueKeys: readonly string[];
  readonly shapeMismatch: boolean;

  constructor(invalidValueKeys: readonly string[], shapeMismatch = false) {
    super("catalog-model-invalid");
    this.invalidValueKeys = Object.freeze([...invalidValueKeys].sort());
    this.shapeMismatch = shapeMismatch;
  }
}

function noteRejectedCatalogModel(
  collector: CatalogObservationCollector,
  value: unknown,
  requiredKeys: readonly string[],
  failure: CatalogModelInvalidError,
): void {
  if (collector.rejections.length >= catalogRejectionRecordLimit) {
    collector.rejectionsOmitted += 1;
    return;
  }
  const ownKeys = catalogRecordOwnKeys(value);
  const keys = ownKeys ?? [];
  // The hygiene result gates the id read (`F134`): a value that is not a plain
  // data record was never inspected for keys, so nothing is read off it either.
  // For plain records the id is still read through its descriptor, never as a
  // property, so the diagnostic path cannot evaluate vendor-supplied code.
  const candidateId =
    ownKeys === undefined ? undefined : readCatalogDataProperty(value, "id");
  const keyDrift = failure.shapeMismatch;
  collector.rejections.push(
    Object.freeze({
      modelId: isSafeCatalogText(candidateId, 240) ? candidateId : "<unknown>",
      unknownKeys: Object.freeze(
        keyDrift
          ? keys.filter((key) => !requiredKeys.includes(key)).sort()
          : [],
      ),
      missingKeys: Object.freeze(
        keyDrift
          ? requiredKeys.filter((key) => !keys.includes(key)).sort()
          : [],
      ),
      invalidValueKeys: failure.invalidValueKeys,
    }),
  );
}

function toCatalogObservation(
  collector: CatalogObservationCollector,
): CodexCatalogObservation {
  return Object.freeze({
    toleratedKeys: Object.freeze([...collector.toleratedKeys].sort()),
    rejections: Object.freeze([...collector.rejections]),
    rejectionsOmitted: collector.rejectionsOmitted,
  });
}

/**
 * Per-endpoint context that lets one CodexAdapter class serve several
 * Runtime Endpoints (the codex-family counterpart of `ClaudeEndpointContext`;
 * adapter : endpoint = 1 : N):
 *
 * - `environmentSource`: every spawn builds its process environment through
 *   the codex endpoint environment factory (cleanse, then inject).
 * - `prepareEndpoint`: filesystem preparation (the kimi-platform CODEX_HOME
 *   seeding), awaited before every operation, inspect included.
 * - `discoverExecutable`: executable lookup for the spawn-free static
 *   inspection path; defaults to the production discovery.
 * - `staticCatalog`: when set, `inspect` serves this catalog without probing
 *   the CLI, and session selection is validated against this catalog — the
 *   CLI-reported catalog (which carries the provider's built-in names) is
 *   never trusted for model identity on such an endpoint. `start`/`resume`
 *   also skip the chatgpt-account gate: `account/read` answers for the
 *   CLI's own subscription, not for a custom model provider's env key.
 */
export interface CodexEndpointContext {
  readonly environmentSource: CodexEndpointEnvironmentResolver;
  /** Source environment the factory reads the endpoint key from. */
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly prepareEndpoint?: () => Promise<void>;
  readonly discoverExecutable?: () => Promise<CodexExecutableDiscoveryResult>;
  readonly staticCatalog?: RuntimeCatalog;
}

export class CodexAdapter implements ResumableAgentRuntimeAdapter {
  private readonly createTransport: OfficialRuntimeTransportFactory;
  private readonly providerRequestBudget: ProviderRequestBudget | undefined;
  private readonly onCatalogObservation: CodexCatalogObserver | undefined;
  readonly #endpointContext: CodexEndpointContext | undefined;

  constructor(
    createTransport?: OfficialRuntimeTransportFactory,
    providerRequestBudget?: ProviderRequestBudget,
    onCatalogObservation?: CodexCatalogObserver,
    endpointContext?: CodexEndpointContext,
  ) {
    this.providerRequestBudget = providerRequestBudget;
    this.onCatalogObservation = onCatalogObservation;
    this.#endpointContext = endpointContext;
    // Without an endpoint context the transport is the historical spawn:
    // inherited environment, CLI-owned catalog, chatgpt-account gate. With
    // one (kimi-platform, ticket 17), the default transport factory builds
    // the spawn environment through the codex endpoint environment factory
    // (cleanse, then inject CODEX_HOME + the endpoint key) and runs the
    // endpoint's filesystem preparation before every spawn.
    this.createTransport =
      createTransport ??
      (endpointContext === undefined
        ? createOfficialCodexTransport
        : async () => {
            const context = endpointContext;
            const environment = resolveCodexEndpointProcessEnvironment(
              context.sourceEnvironment ?? process.env,
              context.environmentSource,
            );
            await context.prepareEndpoint?.();
            // A context-provided discovery pre-gates the launch (static
            // endpoints keep inspect and spawn discovery coherent, and
            // tests stay hermetic); the production transport re-discovers
            // through its own dependencies exactly as before.
            if (context.discoverExecutable !== undefined) {
              const discovery = await context.discoverExecutable().catch(
                (): CodexExecutableDiscoveryResult => ({ kind: "not-located" }),
              );
              if (discovery.kind !== "located") {
                throw new RuntimeAdapterError("runtime-not-located");
              }
            }
            return createOfficialCodexTransport(undefined, { environment });
          });
  }

  /**
   * The one place a catalog observation leaves the adapter. It runs in a
   * `finally`, including on the failing path — a rejected catalog is precisely
   * when the owner needs to know which field moved — so an observer that throws
   * must not be able to replace the real outcome with its own error.
   */
  private emitCatalogObservation(
    collector: CatalogObservationCollector,
  ): void {
    const observer = this.onCatalogObservation;
    if (observer === undefined) return;
    try {
      observer(toCatalogObservation(collector));
    } catch {
      // An observation is diagnostics; it never changes what `inspect` returns.
    }
  }

  async inspect(projectDirectory: string): Promise<RuntimeCatalog> {
    if (projectDirectory.length === 0) throw new RuntimeAdapterError("invalid-input");

    const staticCatalog = this.#endpointContext?.staticCatalog;
    if (staticCatalog !== undefined && this.#endpointContext !== undefined) {
      // Static-catalog endpoints never probe the CLI for models. The endpoint
      // environment is validated first (a missing key is an authentication
      // state, reported without spawning anything), the endpoint's filesystem
      // preparation runs (CODEX_HOME seeding / repair), and the executable
      // must be locatable for sessions to be possible at all.
      resolveCodexEndpointProcessEnvironment(
        this.#endpointContext.sourceEnvironment ?? process.env,
        this.#endpointContext.environmentSource,
      );
      try {
        await (this.#endpointContext.prepareEndpoint?.() ?? undefined);
      } catch (error) {
        throw toRuntimeError(error, "runtime-unavailable");
      }
      const discovery = await (
        this.#endpointContext.discoverExecutable ?? discoverOfficialCodexExecutable
      )().catch((): CodexExecutableDiscoveryResult => ({ kind: "not-located" }));
      if (discovery.kind !== "located") {
        throw new RuntimeAdapterError("runtime-not-located");
      }
      return staticCatalog;
    }

    let peer: CodexJsonlPeer;
    try {
      peer = new CodexJsonlPeer(
        await this.createTransport(),
        this.providerRequestBudget,
      );
    } catch (error) {
      throw toRuntimeError(error, "runtime-unavailable");
    }

    const collector = createCatalogObservationCollector();
    try {
      await initialize(peer);
      await assertAuthenticated(peer);
      const nativeCatalog = await readNativeCatalog(peer, collector);
      return normalizeCatalog(nativeCatalog);
    } catch (error) {
      if (error instanceof RuntimeAdapterError && error.category === "catalog-invalid") {
        reportCodexDiagnostic("Codex CLI model/list output is unrecognized or inconsistent; model selection is unavailable. Refresh the catalog after the CLI output is supported; no model or effort was guessed.");
      } else if (error instanceof RuntimeAdapterError && (error.category === "protocol-invalid" || error.category === "protocol-rejected")) {
        reportCodexDiagnostic("Codex CLI initialization or account/read output is unrecognized or rejected; catalog inspection is unavailable. Authentication was not assumed.");
      }
      throw toRuntimeError(error, "runtime-unavailable");
    } finally {
      await peer.stop();
      this.emitCatalogObservation(collector);
    }
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    if (request.projectDirectory.length === 0) {
      throw new RuntimeAdapterError("invalid-input");
    }

    const staticCatalog = this.#endpointContext?.staticCatalog;
    if (staticCatalog !== undefined) {
      // Selection truth on a static-catalog endpoint is the static catalog,
      // checked before anything is spawned: a bogus selection must not cost
      // a process. The native `model/list` read and the chatgpt-account gate
      // are both skipped (they answer for the CLI's own provider).
      assertStaticProfileSelection(staticCatalog, request.profile);
    }

    let peer: CodexJsonlPeer;
    try {
      peer = new CodexJsonlPeer(
        await this.createTransport(),
        this.providerRequestBudget,
      );
    } catch (error) {
      throw toRuntimeError(error, "runtime-unavailable");
    }

    let keepRunning = false;
    try {
      await initialize(peer);
      if (staticCatalog === undefined) {
        await assertAuthenticated(peer);
        // `start` parses the same wire but is not the diagnostic path: its
        // observation is discarded so `inspect` keeps exactly one emission
        // point.
        const catalog = normalizeCatalog(
          await readNativeCatalog(peer, createCatalogObservationCollector()),
        );
        assertSelection(catalog, request);
      }
      const nativeAccess = toNativeAccess(request.profile.accessMode);
      const startResult = asObject(
        await peer.request("thread/start", {
          cwd: request.projectDirectory,
          model: request.profile.model,
          config: { model_reasoning_effort: request.profile.effortLevel },
          approvalPolicy: nativeAccess.approvalPolicy,
          sandbox: nativeAccess.threadSandbox,
          ephemeral: false,
        }),
        "correlation-invalid",
      );
      const thread = asObject(startResult.thread, "correlation-invalid");
      const threadId = typeof thread.id === "string" && thread.id.length > 0 ? thread.id : undefined;
      const sandbox = asObject(startResult.sandbox, "correlation-invalid");
      if (
        !threadId ||
        startResult.model !== request.profile.model ||
        startResult.reasoningEffort !== request.profile.effortLevel ||
        startResult.approvalPolicy !== nativeAccess.approvalPolicy ||
        sandbox.type !== nativeAccess.turnAccess.sandboxPolicy.type
      ) {
        throw new RuntimeAdapterError("unsupported-selection");
      }

      keepRunning = true;
      return new CodexRuntimeBinding(
        peer,
        threadId,
        request.profile,
        nativeAccess.turnAccess,
        "new",
      );
    } catch (error) {
      if (error instanceof RuntimeAdapterError && ["protocol-invalid", "protocol-rejected", "correlation-invalid", "unsupported-selection", "catalog-invalid"].includes(error.category)) {
        reportCodexDiagnostic("Codex CLI startup output is unrecognized, rejected, or did not confirm the requested model and permissions; no turn was sent. Startup remains unavailable until the CLI can confirm the selection.");
      }
      throw toRuntimeError(error, "runtime-unavailable");
    } finally {
      if (!keepRunning) await peer.stop();
    }
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    const validatedRequest = validateResumeRequest(request);
    const nativeAccess = toNativeAccess(validatedRequest.profile.accessMode);

    const staticCatalog = this.#endpointContext?.staticCatalog;
    if (staticCatalog !== undefined) {
      // Same static-selection rule as `start`, before anything is spawned.
      assertStaticProfileSelection(staticCatalog, validatedRequest.profile);
    }

    let peer: CodexJsonlPeer;
    try {
      peer = new CodexJsonlPeer(
        await this.createTransport(),
        this.providerRequestBudget,
      );
    } catch (error) {
      throw toRuntimeError(error, "runtime-unavailable");
    }

    let keepRunning = false;
    try {
      await initialize(peer);
      if (staticCatalog === undefined) {
        await assertAuthenticated(peer);
      }
      const resumeResultValue = await peer.request("thread/resume", {
        threadId: validatedRequest.opaqueSessionReference,
        excludeTurns: true,
        model: validatedRequest.profile.model,
        config: { model_reasoning_effort: validatedRequest.profile.effortLevel },
        approvalPolicy: nativeAccess.approvalPolicy,
        sandbox: nativeAccess.threadSandbox,
      });
      const { resumeResult, thread } = readResumeResult(
        resumeResultValue,
        "protocol-invalid",
      );
      const threadId = typeof thread.id === "string" && thread.id.length > 0 ? thread.id : undefined;
      if (!threadId || threadId !== validatedRequest.opaqueSessionReference) {
        throw new RuntimeAdapterError("correlation-invalid");
      }
      const sandbox = resumeResult.sandbox;
      // "default" is the static-catalog tier meaning "effort not pinned"
      // (kimi-platform). `thread/start` echoes the unpinned spelling back
      // verbatim, but `thread/resume` (measured on 0.153.4)
      // resolves the request's "default" against the thread's pinned
      // effort and echoes the resolved value ("high" under the seeded
      // kimi-platform home). A literal equality can never hold for this
      // tier on resume, so the resolved spelling is tolerated for the
      // unpinned tier only; every pinned tier keeps the strict echo.
      const effortEchoTolerated =
        validatedRequest.profile.effortLevel === "default";
      if (
        resumeResult.model !== validatedRequest.profile.model ||
        (!effortEchoTolerated &&
          resumeResult.reasoningEffort !==
            validatedRequest.profile.effortLevel) ||
        resumeResult.approvalPolicy !== nativeAccess.approvalPolicy ||
        sandbox.type !== nativeAccess.turnAccess.sandboxPolicy.type
      ) {
        throw new RuntimeAdapterError("unsupported-selection");
      }

      keepRunning = true;
      return new CodexRuntimeBinding(
        peer,
        threadId,
        validatedRequest.profile,
        nativeAccess.turnAccess,
        "resumed",
      );
    } catch (error) {
      if (error instanceof RuntimeAdapterError && ["protocol-invalid", "protocol-rejected", "correlation-invalid", "unsupported-selection"].includes(error.category)) {
        reportCodexDiagnostic("Codex CLI resume output is unrecognized, rejected, or did not confirm the session, model and permissions; no turn was sent. Resume remains unavailable; the saved session reference was not replaced.");
      }
      throw toRuntimeError(error, "runtime-unavailable");
    } finally {
      if (!keepRunning) await peer.stop();
    }
  }
}

async function initialize(peer: CodexJsonlPeer): Promise<void> {
  await peer.request("initialize", {
    clientInfo: {
      name: "synchronized-intellect-network",
      title: "Synchronized Intellect Network",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  await peer.notify("initialized");
}

/**
 * Reads only whether an account is present and which mechanism backs it. The
 * `account/read` response also carries account-scoped fields, and this function
 * deliberately never touches them: the sole property read is `account.type`, so
 * no email, plan, organization, token, or credential file ever reaches the
 * Workbench. That leaves a signed-in/signed-out signal that cannot distinguish
 * two accounts, which the durable Session discriminator honours by proving only
 * that the observed sign-in changed.
 */
async function assertAuthenticated(peer: CodexJsonlPeer): Promise<void> {
  const result = asObject(
    await peer.request("account/read", { refreshToken: false }),
    "protocol-invalid",
  );
  if (!Object.prototype.hasOwnProperty.call(result, "account")) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  if (result.account === null) {
    throw new RuntimeAdapterError("authentication-required");
  }
  if (typeof result.account !== "object" || Array.isArray(result.account)) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const accountType = (result.account as Record<string, unknown>).type;
  if (accountType === "apiKey") {
    throw new RuntimeAdapterError("authentication-required");
  }
  if (accountType !== "chatgpt") throw new RuntimeAdapterError("protocol-invalid");
}

async function readNativeCatalog(
  peer: CodexJsonlPeer,
  collector: CatalogObservationCollector,
): Promise<unknown> {
  const data: unknown[] = [];
  const seenCursors = new Set<string>();
  const seenModelIds = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = parseNativeCatalogPage(
      await peer.request("model/list", cursor === undefined ? {} : { cursor }),
      collector,
    );
    if (data.length + page.data.length > 1_000) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    for (const model of page.data) {
      if (seenModelIds.has(model.id)) {
        throw new RuntimeAdapterError("catalog-invalid");
      }
      seenModelIds.add(model.id);
    }
    data.push(...page.data);
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || nextCursor === null) {
      if (
        data.length === 0 &&
        collector.rejections.length + collector.rejectionsOmitted > 0
      ) {
        // Every model the vendor sent was quarantined — the vendor-wide drift
        // case. An empty catalog is an outage whichever way it is reached;
        // reaching it silently would trade the loud failure for a product
        // with no models and no explanation, so this stays fatal.
        throw new RuntimeAdapterError("catalog-invalid");
      }
      return { data };
    }
    if (seenCursors.has(nextCursor)) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

type NativeCatalogEffort = Readonly<{
  readonly reasoningEffort: string;
  readonly description?: string;
}>;

type NativeCatalogModel = Readonly<{
  readonly id: string;
  readonly displayName?: string;
  readonly supportedReasoningEfforts: readonly (string | NativeCatalogEffort)[];
}>;

type NativeCatalogPage = Readonly<{
  readonly data: readonly NativeCatalogModel[];
  readonly nextCursor?: string | null;
}>;

function parseNativeCatalogPage(
  value: unknown,
  collector: CatalogObservationCollector,
): NativeCatalogPage {
  // The page envelope is vendor-owned wire like every other catalog layer:
  // `data` must be present, `nextCursor` is validated when present, and an
  // unknown additional key is tolerated and observed rather than fatal.
  const pageExtraKeys = catalogModelExtraKeys(value, ["data"]);
  if (pageExtraKeys === undefined) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  const page = value as Record<string, unknown>;
  noteToleratedCatalogKeys(
    collector,
    pageExtraKeys.filter((key) => key !== "nextCursor"),
  );
  if (!isDenseCatalogArray(page.data) || page.data.length > 1_000) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  const data: NativeCatalogModel[] = [];
  for (const candidate of page.data) {
    try {
      data.push(parseNativeCatalogModel(candidate, collector));
    } catch (error) {
      if (!(error instanceof CatalogModelInvalidError)) throw error;
      // One unusable model quarantines that one model, never the catalog
      // (`F110` round 2). The rejection record is the visibility half of the
      // contract: the drop is named on the observation channel, which the
      // production observer carries to the main-process console. Anything
      // that is not a `CatalogModelInvalidError` — a wire fault, a page-level
      // defect — has already propagated above and stays fatal.
      noteRejectedCatalogModel(
        collector,
        candidate,
        currentFullCatalogModelKeys,
        error,
      );
    }
  }
  const nextCursor = page.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    !isSafeCatalogCursor(nextCursor)
  ) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  return Object.freeze({ data: Object.freeze(data), nextCursor });
}

type CatalogModelShape =
  | "legacy"
  | "current-brief"
  | "current-named"
  | "current-full";

const catalogModelShapePrecedence: readonly (readonly [
  CatalogModelShape,
  readonly string[],
])[] = [
  ["current-full", currentFullCatalogModelKeys],
  ["current-named", currentNamedCatalogModelKeys],
  ["current-brief", currentBriefCatalogModelKeys],
  ["legacy", legacyCatalogModelKeys],
];

/**
 * Classify a candidate by the richest recognised shape it satisfies.
 *
 * Every shape is an asymmetric superset contract, so a full model also
 * satisfies all three smaller shapes; trying the richest first is what keeps
 * it on the fully validated branch. The deliberate consequence: a model that
 * *lost* a full-only key no longer kills anything — it degrades to the richest
 * smaller shape it still satisfies, and the orphaned full-only keys surface as
 * tolerated drift on the observation channel. "Subset stays fatal" is measured
 * against the keys the product actually consumes (`id`,
 * `supportedReasoningEfforts`, and each classified shape's required keys):
 * losing one of those quarantines the model, because no recognised shape
 * matches without them. Measured against the vendor's fullest historical shape
 * it would recreate the `F110` outage class for removals of keys nobody reads.
 */
function classifyCatalogModel(value: unknown):
  | Readonly<{
      readonly shape: CatalogModelShape;
      readonly extraKeys: readonly string[];
    }>
  | undefined {
  for (const [shape, requiredKeys] of catalogModelShapePrecedence) {
    const extraKeys = catalogModelExtraKeys(value, requiredKeys);
    if (extraKeys !== undefined) return Object.freeze({ shape, extraKeys });
  }
  return undefined;
}

function parseNativeCatalogModel(
  value: unknown,
  collector: CatalogObservationCollector,
): NativeCatalogModel {
  const classified = classifyCatalogModel(value);
  if (classified === undefined) {
    throw new CatalogModelInvalidError([], true);
  }
  const model = value as Record<string, unknown>;
  // Tolerated keys are collected locally and flushed only when the model
  // parses: a quarantined model's stray keys belong to its rejection record,
  // not to catalog-wide drift.
  const toleratedKeys = [...classified.extraKeys];
  const invalidKeys = new Set<string>();

  if (!isSafeCatalogText(model.id, 240)) invalidKeys.add("id");
  if (
    !isDenseCatalogArray(model.supportedReasoningEfforts) ||
    model.supportedReasoningEfforts.length === 0 ||
    model.supportedReasoningEfforts.length > 1_000
  ) {
    invalidKeys.add("supportedReasoningEfforts");
  }
  const isLegacy = classified.shape === "legacy";
  if (!isLegacy && !isSafeCatalogDisplayText(model.displayName, 200)) {
    invalidKeys.add("displayName");
  }
  if (
    (classified.shape === "current-named" ||
      classified.shape === "current-full") &&
    !isSafeCatalogText(model.model, 240)
  ) {
    invalidKeys.add("model");
  }
  if (invalidKeys.size > 0) {
    throw new CatalogModelInvalidError([...invalidKeys]);
  }

  const entries = model.supportedReasoningEfforts as readonly unknown[];
  const efforts = isLegacy
    ? parseLegacyCatalogEfforts(entries, toleratedKeys)
    : parseCurrentCatalogEfforts(entries, toleratedKeys);
  if (classified.shape === "current-full") {
    validateCurrentFullCatalogModel(model, toleratedKeys);
  }
  noteToleratedCatalogKeys(collector, toleratedKeys);

  if (isLegacy) {
    return Object.freeze({
      id: model.id as string,
      supportedReasoningEfforts: efforts,
    });
  }
  return Object.freeze({
    id: model.id as string,
    displayName: model.displayName as string,
    supportedReasoningEfforts: efforts,
  });
}

/**
 * Legacy effort entries: a bare string, or a record requiring only
 * `reasoningEffort`. `description` is a recognised optional key and is
 * validated when present; unknown additional keys are tolerated and reported,
 * their values never read.
 */
function parseLegacyCatalogEfforts(
  entries: readonly unknown[],
  toleratedKeys: string[],
): readonly (string | NativeCatalogEffort)[] {
  const efforts = entries.map((candidate): string | NativeCatalogEffort => {
    if (isSafeCatalogText(candidate, 120)) return candidate;
    const extraKeys = catalogModelExtraKeys(candidate, ["reasoningEffort"]);
    if (extraKeys === undefined) {
      throw new CatalogModelInvalidError(["supportedReasoningEfforts"]);
    }
    const effort = candidate as Record<string, unknown>;
    if (
      !isSafeCatalogText(effort.reasoningEffort, 120) ||
      (effort.description !== undefined &&
        !isSafeCatalogDisplayText(effort.description, 120))
    ) {
      throw new CatalogModelInvalidError(["supportedReasoningEfforts"]);
    }
    toleratedKeys.push(...extraKeys.filter((key) => key !== "description"));
    return Object.freeze({
      reasoningEffort: effort.reasoningEffort,
      ...(effort.description === undefined
        ? {}
        : { description: effort.description }),
    });
  });
  if (
    new Set(
      efforts.map((effort) =>
        typeof effort === "string" ? effort : effort.reasoningEffort,
      ),
    ).size !== efforts.length
  ) {
    throw new CatalogModelInvalidError(["supportedReasoningEfforts"]);
  }
  return Object.freeze(efforts);
}

/**
 * Current effort entries: `reasoningEffort` and `description` both required —
 * the description is consumed as a rendered Effort label, which is what makes
 * its absence a real loss rather than tolerable drift. Unknown additional
 * keys are tolerated and reported, their values never read.
 */
function parseCurrentCatalogEfforts(
  entries: readonly unknown[],
  toleratedKeys: string[],
): readonly NativeCatalogEffort[] {
  const efforts = entries.map((candidate): NativeCatalogEffort => {
    const extraKeys = catalogModelExtraKeys(candidate, [
      "description",
      "reasoningEffort",
    ]);
    if (extraKeys === undefined) {
      throw new CatalogModelInvalidError(["supportedReasoningEfforts"]);
    }
    const effort = candidate as Record<string, unknown>;
    if (
      !isSafeCatalogText(effort.reasoningEffort, 120) ||
      !isSafeCatalogDisplayText(effort.description, 120)
    ) {
      throw new CatalogModelInvalidError(["supportedReasoningEfforts"]);
    }
    toleratedKeys.push(...extraKeys);
    return Object.freeze({
      reasoningEffort: effort.reasoningEffort,
      description: effort.description,
    });
  });
  if (
    new Set(efforts.map((effort) => effort.reasoningEffort)).size !==
    efforts.length
  ) {
    throw new CatalogModelInvalidError(["supportedReasoningEfforts"]);
  }
  return Object.freeze(efforts);
}

/**
 * Every recognised full-shape field stays validated before being dropped —
 * tolerance admits unknown *additions*, it never waves a recognised value
 * through. All invalid fields are collected before throwing so the rejection
 * record can name every field that moved in one observation (`F110`'s live
 * cost was that nothing named the field).
 */
function validateCurrentFullCatalogModel(
  model: Record<string, unknown>,
  toleratedKeys: string[],
): void {
  const invalidKeys = new Set<string>();
  if (!isSafeCatalogMetadataText(model.description, 4_000)) {
    invalidKeys.add("description");
  }
  if (typeof model.hidden !== "boolean") invalidKeys.add("hidden");
  if (!isSafeCatalogText(model.defaultReasoningEffort, 120)) {
    invalidKeys.add("defaultReasoningEffort");
  }
  if (typeof model.supportsPersonality !== "boolean") {
    invalidKeys.add("supportsPersonality");
  }
  if (typeof model.isDefault !== "boolean") invalidKeys.add("isDefault");
  if (model.upgrade !== null && !isSafeCatalogText(model.upgrade, 240)) {
    invalidKeys.add("upgrade");
  }

  // Admitted 2026-08-15 with the real observed shapes. Both are validated to
  // the same bound as the other optional identifiers on this wire and are then
  // dropped: neither is forwarded into `RuntimeModel`.
  if (
    model.modelSpecialty !== null &&
    !isSafeCatalogText(model.modelSpecialty, 120)
  ) {
    invalidKeys.add("modelSpecialty");
  }
  if (
    model.multiAgentVersion !== null &&
    !isSafeCatalogText(model.multiAgentVersion, 120)
  ) {
    invalidKeys.add("multiAgentVersion");
  }
  if (!isToleratedCatalogUpgradeInfo(model.upgradeInfo, toleratedKeys)) {
    invalidKeys.add("upgradeInfo");
  }
  if (!isToleratedCatalogAvailabilityNux(model.availabilityNux, toleratedKeys)) {
    invalidKeys.add("availabilityNux");
  }

  // `F110` round 2, A.2: `inputModalities` carries a VALUE set the vendor
  // owns, and no consumer anywhere reads it — the value is validated and then
  // dropped, exactly like the tolerated keys. So an unknown modality (the
  // vendor shipping video input) and a fourth entry are vendor drift to
  // tolerate, not grounds to reject; only genuinely unusable data — a
  // non-string, an unsafe string, a duplicate, an empty or unbounded list —
  // still fails. The bounds mirror `additionalSpeedTiers`, the neighbouring
  // validated-then-dropped list on this same shape.
  if (
    !isDenseCatalogArray(model.inputModalities) ||
    model.inputModalities.length === 0 ||
    model.inputModalities.length > 100 ||
    !model.inputModalities.every((modality) =>
      isSafeCatalogText(modality, 120),
    ) ||
    new Set(model.inputModalities).size !== model.inputModalities.length
  ) {
    invalidKeys.add("inputModalities");
  }

  if (
    !isDenseCatalogArray(model.additionalSpeedTiers) ||
    model.additionalSpeedTiers.length > 100 ||
    !model.additionalSpeedTiers.every((tier) => isSafeCatalogText(tier, 120)) ||
    new Set(model.additionalSpeedTiers).size !==
      model.additionalSpeedTiers.length
  ) {
    invalidKeys.add("additionalSpeedTiers");
  }

  if (
    !isDenseCatalogArray(model.serviceTiers) ||
    model.serviceTiers.length > 100
  ) {
    invalidKeys.add("serviceTiers");
  } else {
    const serviceTierIds: string[] = [];
    let tiersUsable = true;
    for (const candidate of model.serviceTiers) {
      const tierExtraKeys = catalogModelExtraKeys(candidate, [
        "description",
        "id",
        "name",
      ]);
      if (tierExtraKeys === undefined) {
        tiersUsable = false;
        break;
      }
      const tier = candidate as Record<string, unknown>;
      if (
        !isSafeCatalogText(tier.id, 120) ||
        !isSafeCatalogMetadataText(tier.name, 240) ||
        !isSafeCatalogMetadataText(tier.description, 1_000)
      ) {
        tiersUsable = false;
        break;
      }
      toleratedKeys.push(...tierExtraKeys);
      serviceTierIds.push(tier.id);
    }
    if (
      !tiersUsable ||
      new Set(serviceTierIds).size !== serviceTierIds.length
    ) {
      invalidKeys.add("serviceTiers");
    }
  }

  if (
    model.defaultServiceTier !== null &&
    !isSafeCatalogText(model.defaultServiceTier, 120)
  ) {
    invalidKeys.add("defaultServiceTier");
  }
  if (invalidKeys.size > 0) {
    throw new CatalogModelInvalidError([...invalidKeys]);
  }
}

/**
 * `upgradeInfo`: `model` required, the three copy fields recognised-optional
 * and validated when present, unknown additional keys tolerated. The whole
 * record is dropped after validation — nothing here reaches `RuntimeModel`.
 */
function isToleratedCatalogUpgradeInfo(
  value: unknown,
  toleratedKeys: string[],
): boolean {
  if (value === null) return true;
  const extraKeys = catalogModelExtraKeys(value, ["model"]);
  if (extraKeys === undefined) return false;
  const info = value as Record<string, unknown>;
  if (
    !isSafeCatalogText(info.model, 240) ||
    !isNullOrSafeCatalogMetadataText(info.upgradeCopy, 4_000) ||
    !isNullOrSafeCatalogMetadataText(info.modelLink, 2_048) ||
    !isNullOrSafeCatalogMetadataText(info.migrationMarkdown, 16_000)
  ) {
    return false;
  }
  toleratedKeys.push(
    ...extraKeys.filter(
      (key) =>
        key !== "upgradeCopy" &&
        key !== "modelLink" &&
        key !== "migrationMarkdown",
    ),
  );
  return true;
}

/**
 * `availabilityNux`: `message` required and validated, unknown additional
 * keys tolerated, the whole record dropped after validation.
 */
function isToleratedCatalogAvailabilityNux(
  value: unknown,
  toleratedKeys: string[],
): boolean {
  if (value === null) return true;
  const extraKeys = catalogModelExtraKeys(value, ["message"]);
  if (extraKeys === undefined) return false;
  const nux = value as Record<string, unknown>;
  if (!isSafeCatalogMetadataText(nux.message, 4_000)) return false;
  toleratedKeys.push(...extraKeys);
  return true;
}

function isDenseCatalogArray(value: unknown): value is unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
    return Array.from({ length: value.length }, (_, index) => String(index)).every(
      (key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          Object.prototype.hasOwnProperty.call(descriptor, "value")
        );
      },
    );
  } catch {
    return false;
  }
}

function isSafeCatalogCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1_024 &&
    /^[A-Za-z0-9][A-Za-z0-9._~+/=:-]*$/u.test(value) &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("://")
  );
}

function isNullOrSafeCatalogMetadataText(
  value: unknown,
  maximum: number,
): value is string | null | undefined {
  return value === undefined || value === null || isSafeCatalogMetadataText(value, maximum);
}

function isSafeCatalogMetadataText(
  value: unknown,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].length <= maximum &&
    !hasUnpairedSurrogate(value) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
      value,
    )
  );
}

function isSafeCatalogDisplayText(value: unknown, maximum: number): value is string {
  return (
    isSafeCatalogText(value, maximum) &&
    !value.includes("\\") &&
    !/^(?:[A-Za-z]:[\\/]|\/)/u.test(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) &&
    !/^Bearer\s+\S+/iu.test(value) &&
    !/-----BEGIN [A-Z ]+-----/u.test(value) &&
    !/(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu.test(value)
  );
}

function normalizeCatalog(nativeCatalog: unknown): RuntimeCatalog {
  const result = asObject(nativeCatalog, "catalog-invalid");
  if (!Array.isArray(result.data)) throw new RuntimeAdapterError("catalog-invalid");

  const modelIds = new Set<string>();
  const models: RuntimeModel[] = result.data.map((candidate) => {
    const model = asObject(candidate, "catalog-invalid");
    if (
      typeof model.id !== "string" ||
      modelIds.has(model.id) ||
      !Array.isArray(model.supportedReasoningEfforts)
    ) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    modelIds.add(model.id);

    const effortLevelLabels: (string | null)[] = [];
    const effortLevels = model.supportedReasoningEfforts.map((candidateEffort) => {
      if (typeof candidateEffort === "string") {
        effortLevelLabels.push(null);
        return candidateEffort;
      }
      const effort = asObject(candidateEffort, "catalog-invalid");
      const value = effort.reasoningEffort;
      if (typeof value !== "string") throw new RuntimeAdapterError("catalog-invalid");
      if (effort.description !== undefined && typeof effort.description !== "string") {
        throw new RuntimeAdapterError("catalog-invalid");
      }
      effortLevelLabels.push(
        typeof effort.description === "string" ? effort.description : null,
      );
      return value;
    });
    if (new Set(effortLevels).size !== effortLevels.length) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    if (model.displayName !== undefined && typeof model.displayName !== "string") {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    return {
      id: model.id,
      ...(typeof model.displayName === "string"
        ? { displayName: model.displayName }
        : {}),
      effortLevels,
      ...(effortLevelLabels.some((label) => label !== null)
        ? { effortLevelLabels }
        : {}),
    };
  });

  return {
    runtime: "codex",
    models,
    executionModes: ["single-agent"],
    accessModes: ["full-access"],
  };
}

function assertSelection(catalog: RuntimeCatalog, request: RuntimeStart): void {
  const model = catalog.models.find((candidate) => candidate.id === request.profile.model);
  if (
    !model ||
    !model.effortLevels.includes(request.profile.effortLevel) ||
    !catalog.executionModes.includes(request.profile.executionMode) ||
    !catalog.accessModes.includes(request.profile.accessMode)
  ) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
}

/**
 * Static-catalog selection gate (endpoint-context endpoints): the same rule
 * as `assertSelection`, stated over a bare profile so `resume` can share it.
 * The static catalog is the model-identity truth on such endpoints — a
 * selection outside it never reaches a spawn.
 */
function assertStaticProfileSelection(
  catalog: RuntimeCatalog,
  profile: SessionProfile,
): void {
  const model = catalog.models.find((candidate) => candidate.id === profile.model);
  if (
    !model ||
    !model.effortLevels.includes(profile.effortLevel) ||
    !catalog.executionModes.includes(profile.executionMode) ||
    !catalog.accessModes.includes(profile.accessMode)
  ) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
}

function toNativeAccess(accessMode: string): {
  readonly approvalPolicy: "never";
  readonly threadSandbox: "danger-full-access";
  readonly turnAccess: CodexNativeTurnAccess;
} {
  if (accessMode === "full-access") {
    return {
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnAccess: {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }
  throw new RuntimeAdapterError("unsupported-selection");
}

function asClosedObject(
  value: unknown,
  keys: readonly string[],
  category: ConstructorParameters<typeof RuntimeAdapterError>[0],
): Record<string, unknown> {
  const object = asObject(value, category);
  const actualKeys = Object.keys(object);
  if (
    actualKeys.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  ) {
    throw new RuntimeAdapterError(category);
  }
  return object;
}

function readResumeResult(
  value: unknown,
  category: ConstructorParameters<typeof RuntimeAdapterError>[0],
) {
  if (
    !isVendorRecord(value, ["thread", "model", "reasoningEffort", "approvalPolicy", "sandbox"]) ||
    !isVendorRecord(value.thread, ["id"]) ||
    !isVendorRecord(value.sandbox, ["type"]) ||
    typeof value.reasoningEffort !== "string" || value.reasoningEffort.length === 0
  ) {
    throw new RuntimeAdapterError(category);
  }
  // Only identity and the applied profile/access echo are consumed. Native
  // thread history and every other vendor field are dropped at this boundary.
  return {
    resumeResult: {
      model: value.model,
      reasoningEffort: value.reasoningEffort,
      approvalPolicy: value.approvalPolicy,
      sandbox: { type: value.sandbox.type },
    },
    thread: { id: value.thread.id },
  };
}

function validateResumeRequest(request: RuntimeResume): RuntimeResume {
  const requestObject = asClosedObject(
    request,
    ["projectDirectory", "profile", "opaqueSessionReference"],
    "invalid-input",
  );
  const profileObject = asClosedObject(
    requestObject.profile,
    ["model", "effortLevel", "executionMode", "accessMode"],
    "invalid-input",
  );
  const values = [
    requestObject.projectDirectory,
    requestObject.opaqueSessionReference,
    profileObject.model,
    profileObject.effortLevel,
    profileObject.executionMode,
    profileObject.accessMode,
  ];
  if (
    values.some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    )
  ) {
    throw new RuntimeAdapterError("invalid-input");
  }

  const profile = {
    model: profileObject.model as string,
    effortLevel: profileObject.effortLevel as string,
    executionMode: profileObject.executionMode as string,
    accessMode: profileObject.accessMode as string,
  };
  if (profile.executionMode !== "single-agent" || profile.accessMode !== "full-access") {
    throw new RuntimeAdapterError("unsupported-selection");
  }
  return {
    projectDirectory: requestObject.projectDirectory as string,
    profile,
    opaqueSessionReference: requestObject.opaqueSessionReference as string,
  };
}
