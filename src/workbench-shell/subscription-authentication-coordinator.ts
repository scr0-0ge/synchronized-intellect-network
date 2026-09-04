import type {
  AuthenticationMutationBeginResult,
  AuthenticationMutationPreparation,
  DurableRuntimeEndpointId,
  WorkLedgerAuthGenerationModule,
} from "../coordinator/work-ledger-auth-generation.ts";
import type {
  SubscriptionAuthenticationActionResult,
  SubscriptionAuthenticationActionStart,
  SubscriptionAuthenticationEndpointId,
  SubscriptionAuthenticationService,
} from "../agent-runtime/subscription-authentication.ts";
import type {
  WorkbenchSubscriptionAuthenticationAction,
  WorkbenchSubscriptionAuthenticationBlockers,
  WorkbenchSubscriptionAuthenticationBoundaryResult,
  WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority,
  WorkbenchSubscriptionAuthenticationPublicRequest,
  WorkbenchSubscriptionAuthenticationPublicResponse,
  WorkbenchSubscriptionAuthenticationState,
} from "./contract.ts";
import {
  sanitizeSubscriptionAuthenticationPublicRequest,
  sanitizeSubscriptionAuthenticationPublicResponse,
} from "./result-sanitizer.ts";

export const WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY = Object.freeze({
  credentialHeading: "The Workbench never handles credentials",
  credentialSentence:
    "This page never asks for a password, API key or token, never reads a credential file, and never stores credentials. None of those controls may be added.",
  consequence:
    "Recorded conversations stay in the Workbench. Resumable Sessions for this provider will no longer be resumable when this authentication action begins.",
  logoutRequested: "The Workbench asked the provider CLI to log out.",
  // The rotation is now committed last, so this outcome is reported only when
  // the provider CLI was never launched. Nothing durable can have moved, which
  // is what makes the second sentence an accurate promise rather than a hope.
  logoutNotRequested:
    "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
  logoutPartiallyCompleted:
    "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
  loginPartiallyCompleted:
    "The Workbench asked the provider CLI to log in but could not record the sign-in change. Sessions started before this login can no longer be resumed, even where the Workbench still offers to resume them.",
  logoutBlocked: "Log out is blocked.",
} as const);

/**
 * How far an authentication action actually got.
 *
 * The Workbench performs two separable effects for one authentication action:
 * the fallible provider-CLI launch, and the irreversible work-ledger auth
 * generation rotation that makes existing Sessions unresumable. No transaction
 * spans both, so the pair has three honest outcomes rather than two.
 *
 * - `requested` — the provider CLI was launched **and** the rotation was
 *   committed. This is the only outcome the confirmed consequence describes.
 * - `not-requested` — the provider CLI was never launched, so nothing durable
 *   changed and every Session stays exactly as resumable as it was. Reporting
 *   this outcome is a promise that nothing was lost.
 * - `partially-completed` — the provider CLI was launched but the rotation was
 *   not committed. Something happened, so this must never be reported as
 *   `not-requested`; the rotation did not, so it must never be reported as
 *   `requested`. Its copy names the consequence in the reader's terms.
 */
export type WorkbenchSubscriptionAuthenticationActionOutcome =
  | "requested"
  | "not-requested"
  | "partially-completed";

export const WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS = Object.freeze({
  settingsRoot: ".settings",
  providerRegion: "section.provider-settings",
  providerCard: "section.provider",
  providerName: ":scope > .provider-head .ph-name",
  providerActions: ":scope > .provider-actions",
  subscriptionStatus:
    ':scope > .provider-actions .provider-binding-status[role="status"]',
} as const);

export const WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS =
  Object.freeze({
    codex: "endpoint-selection-v1-01",
    claude: "endpoint-selection-v1-02",
  } as const);

export interface WorkbenchSubscriptionAuthenticationMutationAuthority {
  prepare(request: {
    readonly endpointSelectionKey: string;
    readonly action: WorkbenchSubscriptionAuthenticationAction;
  }): Promise<AuthenticationMutationPreparation> | AuthenticationMutationPreparation;
  /**
   * Re-run every begin-time guard **without** writing anything durable.
   *
   * The coordinator calls this before it launches the provider CLI so that
   * blocker drift and stale consequences still refuse the action while refusing
   * is free. An authority that omits `authorize` keeps its guards, but they run
   * only inside {@link begin} — that is, after the provider CLI has already been
   * asked to act, which can only be reported as `partially-completed`.
   *
   * `authorize` must leave the preparation usable: {@link begin} still consumes
   * it, and {@link cancel} still releases it.
   */
  authorize?(request: {
    readonly preparationKey: string;
    readonly endpointSelectionKey: string;
    readonly action: WorkbenchSubscriptionAuthenticationAction;
    readonly confirmationRequired: boolean;
  }):
    | Promise<WorkbenchAuthenticationMutationAuthorizeResult>
    | WorkbenchAuthenticationMutationAuthorizeResult;
  /**
   * Commit the irreversible work-ledger auth generation rotation.
   *
   * This is the only durable step of an authentication action, so the
   * coordinator calls it **last** — after the provider CLI has actually been
   * launched. A failure here therefore leaves a partial outcome rather than a
   * silently destroyed one.
   */
  begin(request: {
    readonly preparationKey: string;
  }): Promise<WorkbenchAuthenticationMutationBeginResult> | WorkbenchAuthenticationMutationBeginResult;
  cancel(request: { readonly preparationKey: string }): Promise<boolean> | boolean;
  /**
   * Record one freshly observed provider sign-in state for an endpoint.
   *
   * This is the feed behind the account-observation discriminator: a Session is
   * stamped with the sign-in run it was started under, and a run only ends when
   * the Workbench actually observes sign-in leave. Nothing here is an account —
   * the only value that crosses is the same three-valued signal the Settings
   * card already shows, and `unknown` is inert by design so a failed status read
   * never refuses a healthy Session.
   *
   * An authority that omits `observe` keeps every prior behaviour: no mark is
   * ever minted, so every comparison stays `not-comparable` and the durable
   * generation gate remains the only gate. Failure to record is never fatal —
   * the prior mark simply stands.
   */
  observe?(request: {
    readonly endpointSelectionKey: string;
    readonly state: WorkbenchSubscriptionAuthenticationState;
  }): Promise<void> | void;
  attemptNativeResume?(
    sessionControlKey: string,
  ):
    | Promise<WorkbenchSubscriptionAuthenticationResumeObservation>
    | WorkbenchSubscriptionAuthenticationResumeObservation;
}

export type WorkbenchAuthenticationMutationBeginResult =
  | Readonly<{
      kind: "begun";
      endpointSelectionKey: string;
      action: WorkbenchSubscriptionAuthenticationAction;
    }>
  | Exclude<AuthenticationMutationBeginResult, { readonly kind: "begun" }>;

/**
 * The verdict of the revocable authorization phase. Only `authorized` permits
 * the provider CLI to be launched; every other member means nothing external
 * and nothing durable has happened yet.
 */
export type WorkbenchAuthenticationMutationAuthorizeResult =
  | Readonly<{ kind: "authorized" }>
  | Readonly<{
      kind: "blocked";
      blockers: WorkbenchSubscriptionAuthenticationBlockers;
    }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "rejected" }>;

export interface WorkbenchSubscriptionAuthenticationResumeObservation {
  readonly nativeResumeRequested: boolean;
  readonly transcript: readonly string[];
}

export interface WorkbenchSubscriptionAuthenticationEndpoint {
  readonly endpointSelectionKey: string;
  readonly endpointId: SubscriptionAuthenticationEndpointId;
  readonly label: "Codex" | "Claude";
}

export type WorkbenchSubscriptionAuthenticationCatalogLabel =
  | "Catalog available"
  | "Catalog unavailable"
  | "Not checked";

export interface WorkbenchSubscriptionAuthenticationRenderedCard {
  readonly label: "Codex" | "Claude";
  readonly catalog: WorkbenchSubscriptionAuthenticationCatalogLabel;
  readonly subscriptionHeading: "Subscription sign-in";
  readonly authentication: "Bound" | "Sign-in required" | "Unknown";
  readonly actions: readonly Readonly<{ label: string; disabled: boolean }>[];
  /**
   * How far the most recent authentication action got, or `null` when no
   * action has been attempted since the last fresh inspection. `feedback`
   * always carries the copy for this exact outcome.
   */
  readonly outcome: WorkbenchSubscriptionAuthenticationActionOutcome | null;
  readonly feedback: string | null;
  readonly blockedStatement: string | null;
  readonly blockers: readonly Readonly<{ label: string; count: number }>[];
  readonly confirmation: Readonly<{
    statement: string;
    resumableSessionCount: number;
    projectCount: number;
    actions: readonly Readonly<{ label: string; disabled: boolean }>[];
  }> | null;
}

export interface WorkbenchSubscriptionAuthenticationRenderedSettings {
  readonly heading: "Settings";
  readonly sections: readonly ["Providers", "Appearance"];
  readonly selectorCounts: Readonly<Record<string, number>>;
  readonly exactTexts: readonly string[];
  readonly cards: readonly [
    WorkbenchSubscriptionAuthenticationRenderedCard,
    WorkbenchSubscriptionAuthenticationRenderedCard,
  ];
  readonly credentialControls: false;
  readonly embeddedBrowserControls: false;
  readonly otherProviderControls: false;
}

type EndpointPresentationState = {
  authentication: WorkbenchSubscriptionAuthenticationState;
  operation: number;
  preparationPending: boolean;
  pendingAction: WorkbenchSubscriptionAuthenticationAction | null;
  actionCompletion: Promise<SubscriptionAuthenticationActionResult> | null;
  outcome: WorkbenchSubscriptionAuthenticationActionOutcome | null;
  feedback: string | null;
  blockers: Extract<
    WorkbenchSubscriptionAuthenticationPublicResponse,
    { readonly kind: "blocked" }
  >["blockers"] | null;
  confirmation: Readonly<{
    preparationKey: string;
    action: WorkbenchSubscriptionAuthenticationAction;
    resumableSessionCount: number;
    projectCount: number;
  }> | null;
};

type PreparationRecord = Readonly<{
  endpointSelectionKey: string;
  action: WorkbenchSubscriptionAuthenticationAction;
  /** Whether the reader was shown, and accepted, the consequence statement. */
  confirmationRequired: boolean;
}>;

export interface WorkbenchSubscriptionAuthenticationCoordinator {
  readonly keyAuthority: WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority;
  sanitizePublicRequest(
    value: unknown,
  ): WorkbenchSubscriptionAuthenticationBoundaryResult<WorkbenchSubscriptionAuthenticationPublicRequest>;
  sanitizePublicResponse(
    value: unknown,
  ): WorkbenchSubscriptionAuthenticationBoundaryResult<WorkbenchSubscriptionAuthenticationPublicResponse>;
  request(
    value: unknown,
  ): Promise<WorkbenchSubscriptionAuthenticationBoundaryResult<WorkbenchSubscriptionAuthenticationPublicResponse>>;
  cancelPreparation(preparationKey: string): Promise<boolean>;
  setCatalogObservation(
    endpointSelectionKey: string,
    catalog: WorkbenchSubscriptionAuthenticationCatalogLabel,
  ): void;
  renderSettings(): WorkbenchSubscriptionAuthenticationRenderedSettings;
  attemptNativeResume(
    sessionControlKey: string,
  ): Promise<WorkbenchSubscriptionAuthenticationResumeObservation>;
  close(): Promise<void>;
}

export function createWorkbenchSubscriptionAuthenticationCoordinator(options: {
  readonly endpoints: readonly [
    WorkbenchSubscriptionAuthenticationEndpoint,
    WorkbenchSubscriptionAuthenticationEndpoint,
  ];
  readonly authentication: Pick<
    SubscriptionAuthenticationService,
    "inspect" | "startAction" | "close"
  >;
  readonly mutations: WorkbenchSubscriptionAuthenticationMutationAuthority;
}): WorkbenchSubscriptionAuthenticationCoordinator {
  const endpoints = new Map(
    options.endpoints.map((endpoint) => [endpoint.endpointSelectionKey, endpoint]),
  );
  if (endpoints.size !== options.endpoints.length) {
    throw new TypeError("Duplicate subscription authentication selection key.");
  }
  const states = new Map<string, EndpointPresentationState>();
  const catalogs = new Map<string, WorkbenchSubscriptionAuthenticationCatalogLabel>();
  for (const endpoint of options.endpoints) {
    states.set(endpoint.endpointSelectionKey, {
      authentication: "unknown",
      operation: 0,
      preparationPending: false,
      pendingAction: null,
      actionCompletion: null,
      outcome: null,
      feedback: null,
      blockers: null,
      confirmation: null,
    });
    catalogs.set(endpoint.endpointSelectionKey, "Not checked");
  }
  const preparations = new Map<string, PreparationRecord>();
  const activePreparationKeys = new Set<string>();
  let closed = false;

  const keyAuthority: WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority =
    Object.freeze({
      isEndpointSelectionKey: (value: string) => endpoints.has(value),
      isPreparationKey: (value: string) => activePreparationKeys.has(value),
    });

  const sanitizePublicRequest = (value: unknown) =>
    sanitizeSubscriptionAuthenticationPublicRequest(value, keyAuthority);
  const sanitizePublicResponse = (value: unknown) =>
    sanitizeSubscriptionAuthenticationPublicResponse(value, keyAuthority);

  /**
   * Feed one observed sign-in state to the account-observation authority.
   *
   * Called only where the coordinator has just learned a *fresh* state for an
   * endpoint, never from a superseded operation: a stale reading could end or
   * restart a sign-in run that never changed. Recording is best effort, because
   * an unrecorded observation leaves the prior mark standing, which is exactly
   * the pre-observation behaviour.
   */
  const observeAuthentication = (
    endpointSelectionKey: string,
    authentication: WorkbenchSubscriptionAuthenticationState,
  ): void => {
    const observe = options.mutations.observe;
    if (observe === undefined) return;
    try {
      void Promise.resolve(
        observe({ endpointSelectionKey, state: authentication }),
      ).catch(() => undefined);
    } catch {
      // An observation that cannot be made durable leaves the prior mark.
    }
  };

  const acceptedResponse = (
    value: WorkbenchSubscriptionAuthenticationPublicResponse,
  ): WorkbenchSubscriptionAuthenticationBoundaryResult<WorkbenchSubscriptionAuthenticationPublicResponse> => {
    const sanitized = sanitizePublicResponse(value);
    return sanitized.accepted
      ? sanitized
      : Object.freeze({ accepted: false as const });
  };

  return Object.freeze({
    keyAuthority,
    sanitizePublicRequest,
    sanitizePublicResponse,
    async request(value: unknown) {
      if (closed) return Object.freeze({ accepted: false as const });
      const reconstructed = sanitizePublicRequest(value);
      if (!reconstructed.accepted) return reconstructed;
      const request = reconstructed.value;
      if ("preparationKey" in request) {
        const preparation = preparations.get(request.preparationKey);
        if (preparation === undefined) {
          return Object.freeze({ accepted: false as const });
        }
        preparations.delete(request.preparationKey);
        activePreparationKeys.delete(request.preparationKey);
        const state = states.get(preparation.endpointSelectionKey);
        const endpoint = endpoints.get(preparation.endpointSelectionKey);
        if (
          state === undefined ||
          endpoint === undefined ||
          !state.preparationPending ||
          state.pendingAction !== null
        ) {
          return Object.freeze({ accepted: false as const });
        }
        state.preparationPending = false;
        state.confirmation = null;

        // Phase 1 — revocable authorization. Blocker drift and stale
        // consequences must refuse the action while refusing still costs
        // nothing: no provider process, no durable rotation.
        let authorization: WorkbenchAuthenticationMutationAuthorizeResult;
        try {
          authorization =
            options.mutations.authorize === undefined
              ? Object.freeze({ kind: "authorized" as const })
              : await options.mutations.authorize({
                  preparationKey: request.preparationKey,
                  endpointSelectionKey: preparation.endpointSelectionKey,
                  action: preparation.action,
                  confirmationRequired: preparation.confirmationRequired,
                });
        } catch {
          authorization = Object.freeze({ kind: "rejected" as const });
        }
        if (authorization.kind !== "authorized") {
          await releasePreparation(options.mutations, request.preparationKey);
          if (authorization.kind === "blocked") {
            state.blockers = authorization.blockers;
            state.outcome = null;
            state.feedback = null;
            return acceptedResponse({
              kind: "blocked",
              blockers: authorization.blockers,
            });
          }
          return Object.freeze({ accepted: false as const });
        }

        // Phase 2 — the fallible provider-CLI launch. Still nothing durable.
        state.operation += 1;
        const operation = state.operation;
        state.pendingAction = preparation.action;
        state.blockers = null;
        const settleNotRequested = () => {
          if (state.operation === operation) state.pendingAction = null;
          state.actionCompletion = null;
          state.outcome = "not-requested";
          state.feedback = actionFeedback(preparation.action, "not-requested");
          return acceptedResponse({
            kind: "authentication-action-not-requested",
            action: preparation.action,
          });
        };
        let start: SubscriptionAuthenticationActionStart;
        try {
          start = await options.authentication.startAction(
            endpoint.endpointId,
            preparation.action,
          );
          if (
            start.endpointId !== endpoint.endpointId ||
            start.action !== preparation.action ||
            (start.request !== "started" && start.request !== "not-started")
          ) {
            throw new TypeError("Subscription authentication start drifted.");
          }
        } catch {
          await releasePreparation(options.mutations, request.preparationKey);
          return settleNotRequested();
        }
        if (start.request === "not-started") {
          await releasePreparation(options.mutations, request.preparationKey);
          return settleNotRequested();
        }
        const completion = start.completion;
        state.actionCompletion = completion;
        void completion.then((result) => {
          finishAction(state, operation, completion);
          // A completed login or logout is the other place the Workbench learns
          // a fresh sign-in state, and the only one that can end a sign-in run
          // the reader deliberately closed. Drifted endpoints teach nothing.
          if (
            result.endpointId === endpoint.endpointId &&
            isAuthenticationState(result.authentication)
          ) {
            observeAuthentication(
              preparation.endpointSelectionKey,
              result.authentication,
            );
          }
        }, () => {
          finishAction(state, operation, completion);
        });

        // Phase 3 — the irreversible durable rotation, committed last. The
        // provider CLI has already been asked to act, so neither failure nor
        // drift may now be reported as "nothing happened".
        let begun: WorkbenchAuthenticationMutationBeginResult;
        try {
          begun = await options.mutations.begin({
            preparationKey: request.preparationKey,
          });
        } catch {
          begun = Object.freeze({ kind: "persistence-failed" as const });
        }
        const committed =
          begun.kind === "begun" &&
          begun.endpointSelectionKey === preparation.endpointSelectionKey &&
          begun.action === preparation.action;
        state.outcome = committed ? "requested" : "partially-completed";
        state.feedback = actionFeedback(preparation.action, state.outcome);
        return acceptedResponse({
          // The partial outcome carries its own kind across the seam. Collapsing
          // it into "requested" would be true only about the launch and silent
          // about the resumability the rotation failed to fence.
          kind: committed
            ? "authentication-action-requested"
            : "authentication-action-partially-completed",
          action: preparation.action,
        });
      }

      const endpoint = endpoints.get(request.endpointSelectionKey);
      const state = states.get(request.endpointSelectionKey);
      if (endpoint === undefined || state === undefined) {
        return Object.freeze({ accepted: false as const });
      }
      if (!("action" in request)) {
        if (state.preparationPending) {
          return Object.freeze({ accepted: false as const });
        }
        if (state.pendingAction !== null) {
          const actionCompletion = state.actionCompletion;
          const actionOperation = state.operation;
          if (actionCompletion === null) {
            return Object.freeze({ accepted: false as const });
          }
          await actionCompletion;
          if (
            closed ||
            state.operation !== actionOperation ||
            state.pendingAction !== null
          ) {
            return Object.freeze({ accepted: false as const });
          }
        }
        const operation = state.operation;
        let authentication: WorkbenchSubscriptionAuthenticationState;
        try {
          const snapshot = await options.authentication.inspect(endpoint.endpointId);
          authentication =
            snapshot.endpointId === endpoint.endpointId
              ? workbenchAuthenticationState(snapshot.authentication)
              : "unknown";
        } catch {
          authentication = "unknown";
        }
        if (
          closed ||
          state.operation !== operation ||
          state.pendingAction !== null ||
          !isAuthenticationState(authentication)
        ) {
          return Object.freeze({ accepted: false as const });
        }
        state.authentication = authentication;
        observeAuthentication(request.endpointSelectionKey, authentication);
        state.outcome = null;
        state.feedback = null;
        state.blockers = null;
        state.confirmation = null;
        return acceptedResponse({ kind: "authentication-state", state: authentication });
      }

      if (
        state.preparationPending ||
        state.pendingAction !== null ||
        (request.action === "logout" && state.authentication !== "bound") ||
        (request.action === "login" &&
          state.authentication !== "sign-in-required")
      ) {
        return Object.freeze({ accepted: false as const });
      }
      state.preparationPending = true;
      let preparation: AuthenticationMutationPreparation;
      try {
        preparation = await options.mutations.prepare(request);
      } catch {
        state.preparationPending = false;
        return Object.freeze({ accepted: false as const });
      }
      if (preparation.kind === "blocked") {
        state.preparationPending = false;
        state.blockers = preparation.blockers;
        state.confirmation = null;
        state.outcome = null;
        state.feedback = null;
        return acceptedResponse(preparation);
      }
      if (activePreparationKeys.has(preparation.preparationKey)) {
        state.preparationPending = false;
        return Object.freeze({ accepted: false as const });
      }
      activePreparationKeys.add(preparation.preparationKey);
      preparations.set(
        preparation.preparationKey,
        Object.freeze({
          endpointSelectionKey: request.endpointSelectionKey,
          action: request.action,
          confirmationRequired: preparation.kind === "confirmation-required",
        }),
      );
      state.blockers = null;
      state.outcome = null;
      state.feedback = null;
      state.confirmation =
        preparation.kind === "confirmation-required"
          ? Object.freeze({
              preparationKey: preparation.preparationKey,
              action: request.action,
              resumableSessionCount:
                preparation.consequences.resumableSessionCount,
              projectCount: preparation.consequences.projectCount,
            })
          : null;
      return acceptedResponse(preparation);
    },
    async cancelPreparation(preparationKey: string) {
      if (closed || !activePreparationKeys.has(preparationKey)) return false;
      const preparation = preparations.get(preparationKey);
      const cancelled = await options.mutations.cancel({ preparationKey });
      if (!cancelled) return false;
      activePreparationKeys.delete(preparationKey);
      preparations.delete(preparationKey);
      if (preparation !== undefined) {
        const state = states.get(preparation.endpointSelectionKey);
        if (state !== undefined) state.preparationPending = false;
        if (state?.confirmation?.preparationKey === preparationKey) {
          state.confirmation = null;
        }
      }
      return true;
    },
    setCatalogObservation(endpointSelectionKey, catalog) {
      if (!closed && endpoints.has(endpointSelectionKey)) {
        catalogs.set(endpointSelectionKey, catalog);
      }
    },
    renderSettings() {
      const cards = options.endpoints.map((endpoint) =>
        renderCard(
          endpoint.label,
          catalogs.get(endpoint.endpointSelectionKey) ?? "Not checked",
          requiredState(states, endpoint.endpointSelectionKey),
        ),
      ) as unknown as readonly [
        WorkbenchSubscriptionAuthenticationRenderedCard,
        WorkbenchSubscriptionAuthenticationRenderedCard,
      ];
      return Object.freeze({
        heading: "Settings" as const,
        sections: Object.freeze(["Providers", "Appearance"] as const),
        selectorCounts: Object.freeze({
          [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS.settingsRoot]: 1,
          [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS.providerRegion]: 1,
          [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS.providerCard]: 2,
          [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS.providerName]: 2,
          [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS.providerActions]: 2,
          [WORKBENCH_SUBSCRIPTION_AUTHENTICATION_SELECTORS.subscriptionStatus]: 2,
        }),
        exactTexts: Object.freeze([
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.credentialHeading,
          WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.credentialSentence,
        ]),
        cards: Object.freeze(cards),
        credentialControls: false as const,
        embeddedBrowserControls: false as const,
        otherProviderControls: false as const,
      });
    },
    async attemptNativeResume(sessionControlKey: string) {
      if (closed || options.mutations.attemptNativeResume === undefined) {
        return Object.freeze({
          nativeResumeRequested: false,
          transcript: Object.freeze([]),
        });
      }
      return options.mutations.attemptNativeResume(sessionControlKey);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const state of states.values()) {
        state.operation += 1;
        state.preparationPending = false;
      }
      const keys = [...activePreparationKeys];
      activePreparationKeys.clear();
      preparations.clear();
      await Promise.all(
        keys.map((preparationKey) =>
          Promise.resolve(options.mutations.cancel({ preparationKey })).catch(
            () => false,
          ),
        ),
      );
      await options.authentication.close();
    },
  } satisfies WorkbenchSubscriptionAuthenticationCoordinator);
}

function finishAction(
  state: EndpointPresentationState,
  operation: number,
  completion: Promise<SubscriptionAuthenticationActionResult>,
): void {
  if (state.operation !== operation) return;
  state.pendingAction = null;
  if (state.actionCompletion === completion) state.actionCompletion = null;
}

function renderCard(
  label: "Codex" | "Claude",
  catalog: WorkbenchSubscriptionAuthenticationCatalogLabel,
  state: EndpointPresentationState,
): WorkbenchSubscriptionAuthenticationRenderedCard {
  const actionLabel =
    state.authentication === "bound"
      ? "Log out"
      : state.authentication === "sign-in-required"
        ? "Login"
        : "Re-check";
  const confirmation = state.confirmation;
  return Object.freeze({
    label,
    catalog,
    subscriptionHeading: "Subscription sign-in" as const,
    authentication:
      state.authentication === "bound"
        ? "Bound"
        : state.authentication === "sign-in-required"
          ? "Sign-in required"
          : "Unknown",
    actions: Object.freeze([
      Object.freeze({
        label: actionLabel,
        disabled:
          state.preparationPending ||
          state.pendingAction !== null ||
          state.blockers !== null,
      }),
    ]),
    outcome: state.outcome,
    feedback: state.feedback,
    blockedStatement:
      state.blockers === null
        ? null
        : state.authentication === "bound"
          ? WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.logoutBlocked
          : "Login is blocked.",
    blockers:
      state.blockers === null
        ? Object.freeze([])
        : Object.freeze(
            ([
              ["accepted", "Accepted"],
              ["starting", "Starting"],
              ["inFlight", "Running"],
              ["recoveryRequired", "Recovery required"],
              ["unknown", "Unknown"],
            ] as const)
              .filter(([key]) => state.blockers?.[key] !== 0)
              .map(([key, blockerLabel]) =>
                Object.freeze({
                  label: blockerLabel,
                  count: state.blockers?.[key] ?? 0,
                }),
              ),
          ),
    confirmation:
      confirmation === null
        ? null
        : Object.freeze({
            statement: WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.consequence,
            resumableSessionCount: confirmation.resumableSessionCount,
            projectCount: confirmation.projectCount,
            actions: Object.freeze([
              Object.freeze({
                label:
                  confirmation.action === "logout"
                    ? "Ask the provider CLI to log out"
                    : "Continue with Login",
                disabled: false,
              }),
              Object.freeze({ label: "Cancel", disabled: false }),
            ]),
          }),
  });
}

/**
 * The exact sentence for one outcome. Every branch states what the Workbench
 * did, and the `partially-completed` branch additionally names what the reader
 * lost — it is the only outcome whose cost is not visible from the action name.
 */
export function actionFeedback(
  action: WorkbenchSubscriptionAuthenticationAction,
  outcome: WorkbenchSubscriptionAuthenticationActionOutcome,
): string {
  if (action === "logout") {
    if (outcome === "requested") {
      return WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.logoutRequested;
    }
    return outcome === "not-requested"
      ? WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.logoutNotRequested
      : WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.logoutPartiallyCompleted;
  }
  if (outcome === "requested") {
    return "The Workbench asked the provider CLI to log in.";
  }
  return outcome === "not-requested"
    ? "The Workbench could not ask the provider CLI to log in."
    : WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY.loginPartiallyCompleted;
}

/**
 * Hand a consumed preparation back to the authority when the coordinator has
 * decided not to commit it. Failure to release is never fatal: the preparation
 * is already unreachable from the renderer, and no durable state depends on it.
 */
async function releasePreparation(
  mutations: WorkbenchSubscriptionAuthenticationMutationAuthority,
  preparationKey: string,
): Promise<void> {
  try {
    await mutations.cancel({ preparationKey });
  } catch {
    // A preparation that cannot be released simply expires with the authority.
  }
}

function requiredState(
  states: ReadonlyMap<string, EndpointPresentationState>,
  key: string,
): EndpointPresentationState {
  const state = states.get(key);
  if (state === undefined) throw new TypeError("Unknown authentication endpoint.");
  return state;
}

function isAuthenticationState(
  value: unknown,
): value is WorkbenchSubscriptionAuthenticationState {
  return value === "bound" || value === "sign-in-required" || value === "unknown";
}

export function createWorkLedgerSubscriptionAuthenticationMutationAuthority(
  options: {
    readonly authGeneration: WorkLedgerAuthGenerationModule;
    readonly endpointSelections: ReadonlyMap<string, DurableRuntimeEndpointId>;
  },
): WorkbenchSubscriptionAuthenticationMutationAuthority {
  const reverse = new Map<DurableRuntimeEndpointId, string>();
  for (const [selectionKey, endpointId] of options.endpointSelections) {
    if (reverse.has(endpointId)) {
      throw new TypeError("Duplicate durable authentication endpoint.");
    }
    reverse.set(endpointId, selectionKey);
  }
  return Object.freeze({
    prepare(request) {
      const endpointId = options.endpointSelections.get(
        request.endpointSelectionKey,
      );
      return endpointId === undefined
        ? blockedUnknownPreparation()
        : options.authGeneration.prepareAuthenticationMutation({
            endpointId,
            action: request.action,
          });
    },
    authorize(request) {
      const endpointId = options.endpointSelections.get(
        request.endpointSelectionKey,
      );
      if (endpointId === undefined) {
        return Object.freeze({ kind: "rejected" as const });
      }
      // The ledger module exposes no read-only re-scan, so re-run the same
      // guard through a probe preparation and release it again. Preparing is
      // in-memory only; the generation file is written by `begin` alone.
      try {
        const probe = options.authGeneration.prepareAuthenticationMutation({
          endpointId,
          action: request.action,
        });
        if (probe.kind === "blocked") {
          return Object.freeze({
            kind: "blocked" as const,
            blockers: probe.blockers,
          });
        }
        options.authGeneration.cancelAuthenticationMutation({
          preparationKey: probe.preparationKey,
        });
        return (probe.kind === "confirmation-required") ===
          request.confirmationRequired
          ? Object.freeze({ kind: "authorized" as const })
          : Object.freeze({ kind: "stale" as const });
      } catch {
        return Object.freeze({ kind: "rejected" as const });
      }
    },
    begin(request) {
      const result = options.authGeneration.beginAuthenticationMutation(request);
      if (result.kind !== "begun") return result;
      const endpointSelectionKey = reverse.get(result.endpointId);
      return endpointSelectionKey === undefined
        ? Object.freeze({ kind: "rejected" as const })
        : Object.freeze({
            kind: "begun" as const,
            endpointSelectionKey,
            action: result.action,
          });
    },
    cancel: (request) =>
      options.authGeneration.cancelAuthenticationMutation(request),
    observe(request) {
      const endpointId = options.endpointSelections.get(
        request.endpointSelectionKey,
      );
      // An unknown selection key names no durable endpoint, so there is nothing
      // to observe and nothing to mint.
      if (endpointId === undefined) return;
      options.authGeneration.observeEndpointAuthentication({
        endpointId,
        state: request.state,
      });
    },
  } satisfies WorkbenchSubscriptionAuthenticationMutationAuthority);
}

function blockedUnknownPreparation(): AuthenticationMutationPreparation {
  return Object.freeze({
    kind: "blocked" as const,
    blockers: Object.freeze({
      accepted: 0,
      starting: 0,
      inFlight: 0,
      recoveryRequired: 0,
      unknown: 1,
    }),
  });
}

export interface WorkbenchSubscriptionAuthenticationControlledRegistry {
  readAll(): Promise<Readonly<{
    revision: number;
    projects: readonly Readonly<{
      projectKey: string;
      selected: boolean;
      sessions: readonly Readonly<{
        sessionKey: string;
        endpointMembership: string | "unknown";
        activity:
          | "accepted"
          | "starting"
          | "in-flight"
          | "recovery-required"
          | "terminal"
          | "unknown";
        nativeResumable: boolean;
      }>[];
    }>[];
  }>>;
}

export interface WorkbenchSubscriptionAuthenticationControlledGenerations {
  read(endpointSelectionKey: string):
    | Readonly<{ classification: "pristine-legacy" }>
    | Readonly<{ classification: "managed"; generation: string }>
    | Readonly<{ classification: "malformed" }>
    | Readonly<{ classification: "unreadable" }>;
  commitManaged(endpointSelectionKey: string, generation: string): Promise<void>;
}

export interface WorkbenchSubscriptionAuthenticationControlledTranscripts {
  read(sessionControlKey: string): Readonly<{
    sessionControlKey: string;
    endpointSelectionKey: string;
    generation:
      | Readonly<{ kind: "missing" }>
      | Readonly<{ kind: "value"; value: string }>
      | Readonly<{ kind: "malformed" }>;
    preF104ResumeEligible: boolean;
    transcript: readonly string[];
  }> | undefined;
  requestNativeResume(sessionControlKey: string): void;
}

export function createControlledSubscriptionAuthenticationMutationAuthority(
  options: {
    readonly registry: WorkbenchSubscriptionAuthenticationControlledRegistry;
    readonly generations: WorkbenchSubscriptionAuthenticationControlledGenerations;
    readonly transcripts: WorkbenchSubscriptionAuthenticationControlledTranscripts;
    readonly nextPreparationKey: () => string;
    readonly nextGeneration: () => string;
  },
): WorkbenchSubscriptionAuthenticationMutationAuthority {
  const preparations = new Map<
    string,
    Readonly<{
      endpointSelectionKey: string;
      action: WorkbenchSubscriptionAuthenticationAction;
      fingerprint: string;
    }>
  >();
  return Object.freeze({
    async prepare(request) {
      const scan = await scanControlledRegistry(
        options.registry,
        request.endpointSelectionKey,
      );
      if (hasBlockers(scan.blockers)) {
        return Object.freeze({ kind: "blocked" as const, blockers: scan.blockers });
      }
      const preparationKey = options.nextPreparationKey();
      if (preparations.has(preparationKey)) return blockedUnknownPreparation();
      preparations.set(
        preparationKey,
        Object.freeze({ ...request, fingerprint: scan.fingerprint }),
      );
      return scan.consequences.resumableSessionCount > 0
        ? Object.freeze({
            kind: "confirmation-required" as const,
            preparationKey,
            consequences: scan.consequences,
          })
        : Object.freeze({ kind: "ready" as const, preparationKey });
    },
    async authorize(request) {
      const preparation = preparations.get(request.preparationKey);
      if (preparation === undefined) {
        return Object.freeze({ kind: "rejected" as const });
      }
      const scan = await scanControlledRegistry(
        options.registry,
        preparation.endpointSelectionKey,
      );
      if (hasBlockers(scan.blockers)) {
        return Object.freeze({ kind: "blocked" as const, blockers: scan.blockers });
      }
      return scan.fingerprint === preparation.fingerprint
        ? Object.freeze({ kind: "authorized" as const })
        : Object.freeze({ kind: "stale" as const });
    },
    async begin(request) {
      const preparation = preparations.get(request.preparationKey);
      preparations.delete(request.preparationKey);
      if (preparation === undefined) {
        return Object.freeze({ kind: "rejected" as const });
      }
      const scan = await scanControlledRegistry(
        options.registry,
        preparation.endpointSelectionKey,
      );
      if (hasBlockers(scan.blockers)) {
        return Object.freeze({ kind: "blocked" as const, blockers: scan.blockers });
      }
      if (scan.fingerprint !== preparation.fingerprint) {
        return Object.freeze({ kind: "stale" as const });
      }
      try {
        await options.generations.commitManaged(
          preparation.endpointSelectionKey,
          options.nextGeneration(),
        );
      } catch {
        return Object.freeze({ kind: "persistence-failed" as const });
      }
      return Object.freeze({
        kind: "begun" as const,
        endpointSelectionKey: preparation.endpointSelectionKey,
        action: preparation.action,
      });
    },
    cancel(request) {
      return preparations.delete(request.preparationKey);
    },
    attemptNativeResume(sessionControlKey) {
      const session = options.transcripts.read(sessionControlKey);
      if (session === undefined) {
        return Object.freeze({
          nativeResumeRequested: false,
          transcript: Object.freeze([]),
        });
      }
      const endpoint = options.generations.read(session.endpointSelectionKey);
      const generationEligible =
        endpoint.classification === "pristine-legacy"
          ? session.generation.kind === "missing"
          : endpoint.classification === "managed" &&
            session.generation.kind === "value" &&
            session.generation.value === endpoint.generation;
      const nativeResumeRequested =
        generationEligible && session.preF104ResumeEligible;
      if (nativeResumeRequested) {
        options.transcripts.requestNativeResume(sessionControlKey);
      }
      return Object.freeze({
        nativeResumeRequested,
        transcript: Object.freeze([...session.transcript]),
      });
    },
  } satisfies WorkbenchSubscriptionAuthenticationMutationAuthority);
}

async function scanControlledRegistry(
  registry: WorkbenchSubscriptionAuthenticationControlledRegistry,
  endpointSelectionKey: string,
): Promise<Readonly<{
  blockers: Extract<
    WorkbenchSubscriptionAuthenticationPublicResponse,
    { readonly kind: "blocked" }
  >["blockers"];
  consequences: Readonly<{
    resumableSessionCount: number;
    projectCount: number;
  }>;
  fingerprint: string;
}>> {
  try {
    const snapshot = await registry.readAll();
    const blockers = {
      accepted: 0,
      starting: 0,
      inFlight: 0,
      recoveryRequired: 0,
      unknown: 0,
    };
    let resumableSessionCount = 0;
    const consequenceProjects = new Set<string>();
    for (const project of snapshot.projects) {
      for (const session of project.sessions) {
        if (session.endpointMembership === "unknown") {
          blockers.unknown += 1;
          continue;
        }
        if (session.endpointMembership !== endpointSelectionKey) continue;
        switch (session.activity) {
          case "accepted":
            blockers.accepted += 1;
            break;
          case "starting":
            blockers.starting += 1;
            break;
          case "in-flight":
            blockers.inFlight += 1;
            break;
          case "recovery-required":
            blockers.recoveryRequired += 1;
            break;
          case "unknown":
            blockers.unknown += 1;
            break;
          case "terminal":
            if (session.nativeResumable) {
              resumableSessionCount += 1;
              consequenceProjects.add(project.projectKey);
            }
            break;
        }
      }
    }
    return Object.freeze({
      blockers: Object.freeze(blockers),
      consequences: Object.freeze({
        resumableSessionCount,
        projectCount: consequenceProjects.size,
      }),
      fingerprint: JSON.stringify(snapshot),
    });
  } catch {
    return Object.freeze({
      blockers: Object.freeze({
        accepted: 0,
        starting: 0,
        inFlight: 0,
        recoveryRequired: 0,
        unknown: 1,
      }),
      consequences: Object.freeze({
        resumableSessionCount: 0,
        projectCount: 0,
      }),
      fingerprint: "unreadable",
    });
  }
}

function hasBlockers(blockers: {
  readonly accepted: number;
  readonly starting: number;
  readonly inFlight: number;
  readonly recoveryRequired: number;
  readonly unknown: number;
}): boolean {
  return Object.values(blockers).some((count) => count > 0);
}

function workbenchAuthenticationState(
  value: unknown,
): WorkbenchSubscriptionAuthenticationState {
  if (value === "bound") return "bound";
  if (value === "unbound" || value === "authentication-required") {
    return "sign-in-required";
  }
  return "unknown";
}
