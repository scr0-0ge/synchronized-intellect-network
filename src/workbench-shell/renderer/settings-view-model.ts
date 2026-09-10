import type {
  SubscriptionAuthenticationEndpointId,
  WorkbenchRuntimeEndpointDiscovery,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchRuntimeEndpointId,
  WorkbenchRuntimeExecutableRejection,
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
  providerGroupHeadingCopy,
  settingsProviderStatusMeaningsData,
  subscriptionAuthCopy as authCopy,
  type AppearancePersistenceLabel,
  type ProviderGroupHeading,
  type SettingsProviderStatusMeaningLabel,
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

export interface SettingsProviderAvailabilityPresentation {
  readonly group: "catalog-available" | "catalog-unavailable" | "not-inspected";
  readonly label: ProviderGroupHeading;
  readonly tone: "ok" | "warn" | "off";
}

export interface SettingsProviderStatusMeaning {
  readonly category: WorkbenchRuntimeEndpointDiscoveryCategory;
  readonly label: SettingsProviderStatusMeaningLabel;
  readonly detail: string;
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
        blockers: null,
        confirmation: null,
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

export { settingsOtherProvidersCopy } from "./copy/settings-copy.ts";

export const settingsProviderStatusMeanings: readonly SettingsProviderStatusMeaning[] =
  settingsProviderStatusMeaningsData;

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

export function settingsProviderAvailabilityPresentation(
  category: WorkbenchRuntimeEndpointDiscoveryCategory,
): SettingsProviderAvailabilityPresentation {
  if (category === "catalog-ready") {
    return Object.freeze({
      group: "catalog-available",
      label: providerGroupHeadingCopy.catalogAvailable,
      tone: "ok",
    });
  }
  if (category === "not-inspected") {
    return Object.freeze({
      group: "not-inspected",
      label: providerGroupHeadingCopy.notChecked,
      tone: "off",
    });
  }
  return Object.freeze({
    group: "catalog-unavailable",
    label: providerGroupHeadingCopy.catalogUnavailable,
    tone:
      category === "authentication-required" || category === "inspection-failed"
        ? "warn"
        : "off",
  });
}

export function groupSettingsProviderRows<
  Row extends Readonly<{
    category: WorkbenchRuntimeEndpointDiscoveryCategory;
  }>,
>(rows: readonly Row[]): Readonly<{
  catalogAvailable: readonly Row[];
  catalogUnavailable: readonly Row[];
  notInspected: readonly Row[];
}> {
  const catalogAvailable: Row[] = [];
  const catalogUnavailable: Row[] = [];
  const notInspected: Row[] = [];
  for (const row of rows) {
    switch (settingsProviderAvailabilityPresentation(row.category).group) {
      case "catalog-available":
        catalogAvailable.push(row);
        break;
      case "catalog-unavailable":
        catalogUnavailable.push(row);
        break;
      case "not-inspected":
        notInspected.push(row);
        break;
    }
  }
  return Object.freeze({
    catalogAvailable: Object.freeze(catalogAvailable),
    catalogUnavailable: Object.freeze(catalogUnavailable),
    notInspected: Object.freeze(notInspected),
  });
}
