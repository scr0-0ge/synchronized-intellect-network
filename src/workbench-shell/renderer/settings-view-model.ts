import type {
  SubscriptionAuthenticationEndpointId,
  WorkbenchRuntimeEndpointDiscovery,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchRuntimeEndpointId,
  WorkbenchRuntimeExecutableRejection,
  WorkbenchRuntimeInstallStep,
  WorkbenchSubscriptionAuthenticationAction,
  WorkbenchSubscriptionAuthenticationBlockers,
  WorkbenchSubscriptionAuthenticationPublicResponse,
  WorkbenchSubscriptionAuthenticationState,
} from "../contract.ts";
import {
  WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS,
  type WorkbenchSubscriptionAuthenticationActionOutcome,
} from "../subscription-authentication-coordinator.ts";
import { WORKBENCH_RUNTIME_ENDPOINT_IDS } from "../runtime-endpoint-identity.ts";
import type { WorkbenchAppearancePersistencePhase } from "./appearance-preference-state.ts";
import {
  railCopy,
  newSessionRailLabel,
  newSessionRailAccessibleLabel,
} from "./copy/rail-copy.ts";
import {
  appearancePersistenceLabels,
  endpointKeyProviderCopy,
  settingsCopy,
  subscriptionAuthCopy as authCopy,
  type AppearancePersistenceLabel,
  type SettingsProviderBadgeLabel,
  type SubscriptionAuthenticationActionLabel,
  type SubscriptionAuthenticationLabel,
} from "./copy/settings-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import {
  presentationText,
  workbenchLocalizedText,
  type WorkbenchPresentationText,
} from "./presentation-text.ts";

export type WorkbenchSurface = "project" | "settings";

export interface SettingsRailPresentation {
  readonly newSessionLabel: typeof newSessionRailLabel;
  readonly newSessionAccessibleLabel: typeof newSessionRailAccessibleLabel;
  readonly settingsCurrent: boolean;
  readonly settingsAttention: boolean;
}

export interface AppearancePersistencePresentation {
  readonly label: AppearancePersistenceLabel;
  readonly durable: boolean;
  readonly error: boolean;
}

/**
 * The one state word on a provider card (w233). `kind` is what the card's
 * primary action answers to; the internal discovery category itself stays in
 * the card's collapsed details.
 */
export interface SettingsProviderBadgePresentation {
  readonly kind:
    | "ready"
    | "sign-in-needed"
    | "api-key-needed"
    | "cli-missing"
    | "check-failed"
    | "not-checked";
  readonly label: SettingsProviderBadgeLabel;
  readonly tone: "ok" | "warn" | "off";
}

export interface SettingsSubscriptionAuthenticationEntry {
  readonly authentication: WorkbenchSubscriptionAuthenticationState;
  readonly inspectionPending: boolean;
  readonly preparationPending: WorkbenchSubscriptionAuthenticationAction | null;
  readonly pendingAction: WorkbenchSubscriptionAuthenticationAction | null;
  /**
   * How far the most recent authentication action got, or `null` when none has
   * been attempted since the last fresh inspection. `partially-completed` means
   * the provider CLI acted but the Workbench could not record it, so this entry
   * must never be presented with either the success or the failure sentence.
   */
  readonly outcome: WorkbenchSubscriptionAuthenticationActionOutcome | null;
  readonly feedback: WorkbenchPresentationText | null;
  /**
   * The sign-in URL the running provider CLI printed, or `null` when it has
   * printed none. There is no third state: the product cannot see whether the
   * browser opened, so it shows the link it actually received and otherwise
   * shows nothing at all.
   *
   * A credential -- it lives in renderer state for the length of one sign-in
   * and is never logged or persisted.
   */
  readonly signInUrl: string | null;
  readonly blockers: WorkbenchSubscriptionAuthenticationBlockers | null;
  readonly confirmation: Readonly<{
    preparationKey: string;
    action: WorkbenchSubscriptionAuthenticationAction;
    resumableSessionCount: number;
    projectCount: number;
  }> | null;
}

/**
 * Subscription-authentication rows keyed by endpoint id. The map is partial by
 * construction: only endpoints that participate in subscription authentication
 * carry a row, so a static-key endpoint (GLM Coding Plan) is structurally
 * absent here rather than present-and-ignored, and every reader has to face
 * that absence instead of dereferencing a row that was never created.
 */
export type SettingsSubscriptionAuthenticationState = Readonly<
  Partial<
    Record<WorkbenchRuntimeEndpointId, SettingsSubscriptionAuthenticationEntry>
  >
>;

export interface SettingsSubscriptionAuthenticationPresentation {
  readonly label: SubscriptionAuthenticationLabel;
  readonly tone: "ok" | "warn";
  readonly detail: string;
  readonly actionLabel: SubscriptionAuthenticationActionLabel;
  readonly action: WorkbenchSubscriptionAuthenticationAction | null;
  readonly pending: boolean;
  readonly inspectionPending: boolean;
  readonly outcome: WorkbenchSubscriptionAuthenticationActionOutcome | null;
  readonly feedback: string | null;
  readonly blockedStatement: string | null;
  readonly blockers: readonly Readonly<{ label: string; count: number }>[];
}

/**
 * Endpoint-id → opaque subscription-authentication selection key. Data-driven
 * lookup: every endpoint that participates in subscription authentication has
 * exactly one row here. Static-key endpoints (GLM Coding Plan) do not
 * participate — their authentication state is presented through endpoint
 * discovery, never through the subscription login/logout panel — so they have
 * no row and `subscriptionAuthenticationSelectionKey` refuses them.
 */
const subscriptionAuthenticationSelectionKeys: Readonly<
  Record<SubscriptionAuthenticationEndpointId, string>
> = Object.freeze({
  "codex-desktop":
    WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
  "claude-code-desktop":
    WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
});

/** Subscription-authentication participants, in panel order. */
export const SUBSCRIPTION_AUTHENTICATION_ENDPOINT_IDS: readonly SubscriptionAuthenticationEndpointId[] =
  Object.freeze(
    Object.keys(
      subscriptionAuthenticationSelectionKeys,
    ) as SubscriptionAuthenticationEndpointId[],
  );

/** Whether this endpoint binds through the subscription login/logout panel. */
export function isSubscriptionAuthenticationEndpointId(
  endpointId: WorkbenchRuntimeEndpointId,
): endpointId is SubscriptionAuthenticationEndpointId {
  return Object.prototype.hasOwnProperty.call(
    subscriptionAuthenticationSelectionKeys,
    endpointId,
  );
}

export function subscriptionAuthenticationSelectionKey(
  endpointId: WorkbenchRuntimeEndpointId,
): string {
  if (!isSubscriptionAuthenticationEndpointId(endpointId)) {
    throw new TypeError("unknown-subscription-authentication-endpoint");
  }
  return subscriptionAuthenticationSelectionKeys[endpointId];
}

export function initialSettingsSubscriptionAuthenticationState(
  discovery?: WorkbenchRuntimeEndpointDiscovery,
): SettingsSubscriptionAuthenticationState {
  const endpointIds = (
    discovery?.statuses.map((status) => status.endpointId) ??
    WORKBENCH_RUNTIME_ENDPOINT_IDS
  ).filter(isSubscriptionAuthenticationEndpointId);
  const entries: Partial<
    Record<WorkbenchRuntimeEndpointId, SettingsSubscriptionAuthenticationEntry>
  > = {};
  for (const endpointId of endpointIds) {
    entries[endpointId] = entry();
  }
  return Object.freeze(entries);
}

export function completeSettingsSubscriptionAuthenticationResponse(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
  response: WorkbenchSubscriptionAuthenticationPublicResponse,
): SettingsSubscriptionAuthenticationState {
  const current = state[endpointId];
  if (current === undefined) return state;
  switch (response.kind) {
    case "authentication-state":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        authentication: response.state,
        inspectionPending: false,
        preparationPending: null,
        pendingAction: null,
        outcome: null,
        feedback: null,
        // A fresh inspected state means the sign-in run this URL belonged to is
        // over. Leaving a spent authorisation code on the card would offer the
        // reader a link that no longer signs anyone in.
        signInUrl: null,
        blockers: null,
        confirmation: null,
      });
    // The action stays pending: this response answers the standing inspection
    // early rather than ending it, and the caller re-inspects so the run still
    // finishes on a real state.
    case "authentication-sign-in-url":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        // The inspection that carried this has returned, so the card is free to
        // ask again; the action itself is still pending and stays pending.
        inspectionPending: false,
        signInUrl: response.url,
      });
    case "blocked":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        preparationPending: null,
        blockers: response.blockers,
        confirmation: null,
        outcome: null,
        feedback: null,
      });
    case "confirmation-required":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        inspectionPending: false,
        preparationPending: null,
        blockers: null,
        outcome: null,
        feedback: null,
        confirmation: Object.freeze({
          preparationKey: response.preparationKey,
          action:
            current.authentication === "bound" ? "logout" : "login",
          resumableSessionCount: response.consequences.resumableSessionCount,
          projectCount: response.consequences.projectCount,
        }),
      });
    case "ready":
      return state;
    case "authentication-action-requested":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        inspectionPending: false,
        preparationPending: null,
        pendingAction: response.action,
        blockers: null,
        confirmation: null,
        outcome: "requested",
        feedback: authenticationActionFeedback(
          response.action,
          "requested",
        ),
      });
    case "authentication-action-not-requested":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        inspectionPending: false,
        preparationPending: null,
        pendingAction: null,
        blockers: null,
        confirmation: null,
        outcome: "not-requested",
        feedback: authenticationActionFeedback(
          response.action,
          "not-requested",
        ),
      });
    case "authentication-action-partially-completed":
      return replaceAuthenticationEntry(state, endpointId, {
        ...current,
        inspectionPending: false,
        preparationPending: null,
        // Unlike a committed action, nothing will arrive later to clear this
        // entry: the surface deliberately does not re-inspect, because a fresh
        // inspection replaces the sentence that names what the reader lost. So
        // the card must be left usable rather than pinned as still acting.
        pendingAction: null,
        blockers: null,
        confirmation: null,
        outcome: "partially-completed",
        feedback: authenticationActionFeedback(
          response.action,
          "partially-completed",
        ),
      });
  }
}

/**
 * Record that an authentication action reached only the provider CLI: it was
 * launched, but the Workbench could not record the auth generation rotation.
 *
 * The public response vocabulary now carries this outcome as its own kind, so
 * this reducer is the same transition reached without a response in hand — it
 * delegates rather than keeping a second copy that could drift. Neither
 * neighbouring outcome may be reused here: "not-requested" would claim nothing
 * happened, and "requested" would hide that resumability was not fenced.
 */
export function completeSettingsSubscriptionAuthenticationPartialOutcome(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
  action: WorkbenchSubscriptionAuthenticationAction,
): SettingsSubscriptionAuthenticationState {
  return completeSettingsSubscriptionAuthenticationResponse(state, endpointId, {
    kind: "authentication-action-partially-completed",
    action,
  });
}

export function beginSettingsSubscriptionAuthenticationInspection(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
): SettingsSubscriptionAuthenticationState {
  const current = state[endpointId];
  if (
    current === undefined ||
    current.pendingAction !== null ||
    current.preparationPending !== null ||
    current.inspectionPending
  ) {
    return state;
  }
  return replaceAuthenticationEntry(state, endpointId, {
    ...current,
    inspectionPending: true,
    outcome: null,
    feedback: workbenchLocalizedText(
      "authentication.inspecting",
      () => authCopy.inspectingFeedback,
    ),
    blockers: null,
    confirmation: null,
  });
}

export function beginSettingsSubscriptionAuthenticationPreparation(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
  action: WorkbenchSubscriptionAuthenticationAction,
): SettingsSubscriptionAuthenticationState {
  const current = state[endpointId];
  if (
    current === undefined ||
    current.pendingAction !== null ||
    current.preparationPending !== null ||
    current.inspectionPending
  ) {
    return state;
  }
  return replaceAuthenticationEntry(state, endpointId, {
    ...current,
    preparationPending: action,
    outcome: null,
    feedback: workbenchLocalizedText(
      action === "logout"
        ? "authentication.preparing-logout"
        : "authentication.preparing-login",
      () => action === "logout"
        ? authCopy.preparingLogoutFeedback
        : authCopy.preparingLoginFeedback,
    ),
    blockers: null,
    confirmation: null,
  });
}

export function beginSettingsSubscriptionAuthenticationAction(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
  action: WorkbenchSubscriptionAuthenticationAction,
): SettingsSubscriptionAuthenticationState {
  const current = state[endpointId];
  if (current === undefined || current.pendingAction !== null) return state;
  return replaceAuthenticationEntry(state, endpointId, {
    ...current,
    inspectionPending: false,
    preparationPending: null,
    pendingAction: action,
    outcome: null,
    feedback: workbenchLocalizedText(
      action === "logout"
        ? "authentication.acting-logout"
        : "authentication.acting-login",
      () => action === "logout"
        ? authCopy.actingLogoutFeedback
        : authCopy.actingLoginFeedback,
    ),
    blockers: null,
    confirmation: null,
  });
}

export function clearSettingsSubscriptionAuthenticationConfirmation(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
): SettingsSubscriptionAuthenticationState {
  const current = state[endpointId];
  if (current === undefined) return state;
  return replaceAuthenticationEntry(state, endpointId, {
    ...current,
    confirmation: null,
  });
}

export function settingsSubscriptionAuthenticationPresentation(
  value: SettingsSubscriptionAuthenticationEntry,
): SettingsSubscriptionAuthenticationPresentation {
  const label =
    value.authentication === "bound"
      ? authCopy.boundLabel
      : value.authentication === "sign-in-required"
        ? authCopy.signInRequiredLabel
        : authCopy.unknownLabel;
  const action =
    value.authentication === "bound"
      ? "logout"
      : value.authentication === "sign-in-required"
        ? "login"
        : null;
  return Object.freeze({
    label,
    tone: value.authentication === "bound" ? "ok" : "warn",
    detail:
      value.authentication === "bound"
        ? authCopy.boundDetail
        : value.authentication === "sign-in-required"
          ? authCopy.signInRequiredDetail
          : authCopy.unknownDetail,
    actionLabel:
      value.authentication === "bound"
        ? authCopy.logoutAction
        : value.authentication === "sign-in-required"
          ? authCopy.loginAction
          : authCopy.recheckAction,
    action,
    pending:
      value.preparationPending !== null || value.pendingAction !== null,
    inspectionPending: value.inspectionPending,
    outcome: value.outcome,
    feedback: presentationText(value.feedback),
    blockedStatement:
      value.blockers === null
        ? null
        : value.authentication === "bound"
          ? dynamicCopy.authentication.logoutBlocked
          : authCopy.loginBlocked,
    blockers:
      value.blockers === null
        ? Object.freeze([])
        : Object.freeze(
            ([
              ["accepted", authCopy.blockerAccepted],
              ["starting", authCopy.blockerStarting],
              ["inFlight", authCopy.blockerRunning],
              ["recoveryRequired", authCopy.blockerRecoveryRequired],
              ["unknown", authCopy.blockerUnknown],
            ] as const)
              .filter(([key]) => value.blockers?.[key] !== 0)
              .map(([key, blockerLabel]) =>
                Object.freeze({
                  label: blockerLabel,
                  count: value.blockers?.[key] ?? 0,
                }),
              ),
          ),
  });
}

function authenticationActionFeedback(
  action: WorkbenchSubscriptionAuthenticationAction,
  outcome: WorkbenchSubscriptionAuthenticationActionOutcome,
): WorkbenchPresentationText {
  const key = `authentication.${action}.${outcome}`;
  return workbenchLocalizedText(key, () => {
    if (action === "logout") {
      return outcome === "requested"
        ? dynamicCopy.authentication.logoutRequested
        : outcome === "not-requested"
          ? dynamicCopy.authentication.logoutNotRequested
          : dynamicCopy.authentication.logoutPartiallyCompleted;
    }
    return outcome === "requested"
      ? dynamicCopy.authentication.loginRequested
      : outcome === "not-requested"
        ? dynamicCopy.authentication.loginNotRequested
        : dynamicCopy.authentication.loginPartiallyCompleted;
  });
}

function entry(): SettingsSubscriptionAuthenticationEntry {
  return Object.freeze({
    authentication: "unknown" as const,
    inspectionPending: false,
    preparationPending: null,
    pendingAction: null,
    outcome: null,
    feedback: null,
    signInUrl: null,
    blockers: null,
    confirmation: null,
  });
}

function replaceAuthenticationEntry(
  state: SettingsSubscriptionAuthenticationState,
  endpointId: WorkbenchRuntimeEndpointId,
  value: SettingsSubscriptionAuthenticationEntry,
): SettingsSubscriptionAuthenticationState {
  return Object.freeze({ ...state, [endpointId]: Object.freeze(value) });
}

export { settingsTopLevelSectionLabels } from "./copy/settings-copy.ts";

export function settingsRailPresentation(
  surface: WorkbenchSurface,
  runtimeUnavailable: boolean,
): SettingsRailPresentation {
  return Object.freeze({
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: surface === "settings",
    settingsAttention: runtimeUnavailable,
  });
}

/**
 * What happened to the executable path a user just submitted. "rejected" is not
 * an error state of the product -- it is the product answering the question the
 * user asked, with the reason, at the moment they asked it.
 */
export interface SettingsRuntimeExecutablePhase {
  readonly status: "saving" | "saved" | "cleared" | "rejected" | "unavailable";
  readonly rejection?: WorkbenchRuntimeExecutableRejection;
}

/**
 * The product installing the runtime for the user. Four states; absence is
 * "not installed". `installing` carries only when it started, because npm
 * reports no real progress and a bar without one would be a fiction --
 * elapsed time is the truth available. A `failed` phase without a `step` is
 * the installer being unreachable, not a step it reached.
 */
export type SettingsRuntimeInstallPhase =
  | { readonly status: "installing"; readonly startedAt: number }
  | { readonly status: "installed"; readonly version: string }
  | {
      readonly status: "failed";
      readonly step?: WorkbenchRuntimeInstallStep;
      readonly detail: string;
    };

const privateCliInstallMarker = "\\synchronized-intellect-network\\runtime\\cli\\";

/**
 * Whether a configured path is the product's own private install. After a
 * restart the session phase is gone but the durable path remains, and it says
 * "installed" on its own.
 */
export function isPrivateCliInstallPath(executablePath: string | undefined): boolean {
  return (
    typeof executablePath === "string" &&
    executablePath.toLowerCase().includes(privateCliInstallMarker)
  );
}

export function appearancePersistencePresentation(
  phase: WorkbenchAppearancePersistencePhase,
): AppearancePersistencePresentation {
  switch (phase) {
    case "hydrating":
      return Object.freeze({
        label: appearancePersistenceLabels.hydrating,
        durable: false,
        error: false,
      });
    case "saving":
      return Object.freeze({
        label: appearancePersistenceLabels.saving,
        durable: false,
        error: false,
      });
    case "saved":
      return Object.freeze({
        label: appearancePersistenceLabels.saved,
        durable: true,
        error: false,
      });
    case "error":
      return Object.freeze({
        label: appearancePersistenceLabels.error,
        durable: false,
        error: true,
      });
  }
}

/** Whether an endpoint authenticates with a saved API key rather than a login. */
export function isApiKeyEndpointId(endpointId: WorkbenchRuntimeEndpointId): boolean {
  return Object.prototype.hasOwnProperty.call(endpointKeyProviderCopy, endpointId);
}

/**
 * Card badge from the endpoint's discovery category. "Authentication
 * required" reads as a missing key on an API-key face and as a missing
 * login on a subscription face -- the only two things a person can do about it.
 */
export function settingsProviderBadgePresentation(
  category: WorkbenchRuntimeEndpointDiscoveryCategory,
  endpointId: WorkbenchRuntimeEndpointId,
): SettingsProviderBadgePresentation {
  switch (category) {
    case "catalog-ready":
      return Object.freeze({ kind: "ready", label: settingsCopy.badgeReady, tone: "ok" });
    case "runtime-not-located":
      return Object.freeze({
        kind: "cli-missing",
        label: settingsCopy.badgeCliMissing,
        tone: "warn",
      });
    case "authentication-required":
      return isApiKeyEndpointId(endpointId)
        ? Object.freeze({
            kind: "api-key-needed",
            label: settingsCopy.badgeApiKeyNeeded,
            tone: "warn",
          })
        : Object.freeze({
            kind: "sign-in-needed",
            label: settingsCopy.badgeSignInNeeded,
            tone: "warn",
          });
    case "inspection-failed":
      return Object.freeze({
        kind: "check-failed",
        label: settingsCopy.badgeCheckFailed,
        tone: "warn",
      });
    case "not-inspected":
      return Object.freeze({
        kind: "not-checked",
        label: settingsCopy.badgeNotChecked,
        tone: "off",
      });
  }
}

/**
 * The fixed card order the owner ruled (w233): Codex, Claude, GLM, DeepSeek,
 * Kimi. Cards never move when a status changes.
 */
const SETTINGS_CARD_ORDER: readonly WorkbenchRuntimeEndpointId[] = Object.freeze([
  "codex-desktop",
  "codex-api",
  "claude-code-desktop",
  "claude-api",
  "glm-coding-plan",
  "deepseek-api",
  "kimi-code",
  "kimi-platform",
]);

export function orderSettingsProviderRows<
  Row extends Readonly<{ endpointId: WorkbenchRuntimeEndpointId }>,
>(rows: readonly Row[]): readonly Row[] {
  const rank = (row: Row): number => {
    const index = SETTINGS_CARD_ORDER.indexOf(row.endpointId);
    return index === -1 ? SETTINGS_CARD_ORDER.length : index;
  };
  return Object.freeze([...rows].sort((left, right) => rank(left) - rank(right)));
}
