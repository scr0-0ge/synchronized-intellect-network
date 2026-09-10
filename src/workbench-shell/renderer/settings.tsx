import { SettingsSubscriptionUsage } from "./settings-subscription-usage.tsx";
import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import {
  type WorkbenchClaudePermissionHandling,
  type WorkbenchConfigurableRuntime,
  type WorkbenchRuntimeExecutablePaths,
  type WorkbenchRuntimeExecutableRejection,
  type WorkbenchAppearancePreference,
  type WorkbenchEndpointCatalogFreshnessReport,
  type WorkbenchEndpointFamilyId,
  type WorkbenchFamilyEndpointPreference,
  type WorkbenchFamilyEndpointPreferences,
  type WorkbenchRendererBridge,
  type WorkbenchRuntimeEndpointId,
  type WorkbenchSubscriptionAuthenticationAction,
} from "../contract.ts";
import {
  type WorkbenchCliUpdateBridge,
  type WorkbenchCliUpdateCheckReport,
  type WorkbenchCliUpdateCliId,
  type WorkbenchCliUpdateRunFailureReason,
} from "../cli-update-contract.ts";
import type { HistoryRecoverySnapshotResult } from "../history-recovery-contract.ts";
import {
  type WorkbenchAppearanceAction,
  type WorkbenchAppearancePersistencePhase,
} from "./appearance-preference-state.ts";
import type { WorkbenchClaudePermissionHandlingPersistencePhase } from "./claude-permission-handling-state.ts";
import type { WorkbenchEndpointKeyPanel } from "./endpoint-key-state.ts";
import {
  directEndpointStatusRows,
  directFacadeEndpointStatusRows,
  workbenchFacadeFamilyOfEndpointId,
  type WorkbenchDirectProfileState,
  type WorkbenchRuntimeEndpointStatusRow,
} from "./view-model.ts";
import {
  appearancePersistencePresentation,
  groupSettingsProviderRows,
  initialSettingsSubscriptionAuthenticationState,
  settingsProviderAvailabilityPresentation,
  settingsProviderStatusMeanings,
  settingsSubscriptionAuthenticationPresentation,
  type SettingsRuntimeExecutablePhase,
  type SettingsSubscriptionAuthenticationEntry,
  type SettingsSubscriptionAuthenticationState,
} from "./settings-view-model.ts";
import { HistoryRecoverySettingsCard } from "./history-recovery-settings.tsx";

import { runtimeClass } from "./view-types.ts";
import { InspectorFact } from "./inspector.tsx";
import { commonCopy } from "./copy/common-copy.ts";
import { chromeCopy } from "./copy/chrome-copy.ts";
import { endpointIdentityCopy } from "./copy/runtime-profile-copy.ts";
import {
  runtimeExecutableCopy,
  runtimeExecutableRejectionCopy,
  runtimeLookupCopy,
  runtimeLookupPlaceCopy,
} from "./copy/runtime-lookup-copy.ts";
import {
  settingsCopy,
  bindingStatusAriaCopy,
  bindActionAriaCopy,
  authConsequencesCopy,
  endpointCatalogFreshnessCopy,
  cliUpdateCopy,
  familyFacadeCopy,
  workbenchEndpointKeyCopy,
  type ProviderGroupHeading,
  type WorkbenchEndpointKeyCopyEndpointId,
} from "./copy/settings-copy.ts";
import { defaultWorkbenchFamilyEndpointPreferences } from "../contract.ts";

export interface WorkbenchCatalogFreshnessPanel {
  readonly unavailable: boolean;
  readonly reports:
    | readonly WorkbenchEndpointCatalogFreshnessReport[]
    | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}

/**
 * One CLI's update-run lifecycle inside its provider row. "succeeded"
 * shows the restart reminder; "succeeded-quiet" is the reminder after the
 * user chose "Not now". The current check report still controls Update.
 */
export type WorkbenchCliUpdateRunPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "succeeded" }
  | { readonly kind: "succeeded-quiet" }
  | { readonly kind: "failed"; readonly reason: WorkbenchCliUpdateRunFailureReason }
  | { readonly kind: "unavailable" };

/**
 * The restart action's lifecycle (issue 184). "requesting" is terminal on
 * the happy path: `queued` means the main process has started its drain and
 * this window is going away, so the button stays busy rather than returning
 * to a state that invites a second press. Only a refusal comes back.
 */
export type WorkbenchCliUpdateRelaunchPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | { readonly kind: "failed" };

/**
 * Presentation contract for the CLI update block (ticket 18): the
 * memoized startup check reports (null = initial check pending), per-CLI run phases, the button
 * trigger, and the restart-reminder dismissal. Present only when the
 * bridge exposes the CLI update channels.
 */
export interface WorkbenchCliUpdatePanel {
  readonly reports: readonly WorkbenchCliUpdateCheckReport[] | null;
  readonly runPhase: (
    cliId: WorkbenchCliUpdateCliId,
  ) => WorkbenchCliUpdateRunPhase;
  readonly onUpdate: (cliId: WorkbenchCliUpdateCliId) => void;
  readonly onAcknowledgeRestart: (cliId: WorkbenchCliUpdateCliId) => void;
  /** A check is in flight; the retry control reads busy (issue 184). */
  readonly checking: boolean;
  /** Re-run the read-only check after it failed (issue 184). */
  readonly onRecheck: () => void;
  /** The app-wide restart action's lifecycle (issue 184). */
  readonly relaunchPhase: WorkbenchCliUpdateRelaunchPhase;
  /** Take the restart the success reminder offers (issue 184). */
  readonly onRestartNow: () => void;
}

const idleCliUpdateRunPhase: WorkbenchCliUpdateRunPhase = Object.freeze({
  kind: "idle",
});

const idleCliUpdateRelaunchPhase: WorkbenchCliUpdateRelaunchPhase =
  Object.freeze({ kind: "idle" });

function cliIdForEndpoint(
  endpointId: WorkbenchRuntimeEndpointId,
): WorkbenchCliUpdateCliId | undefined {
  if (endpointId === "claude-code-desktop") return "claude-code";
  if (endpointId === "codex-desktop") return "codex";
  return undefined;
}

export const SettingsScreen: Component<{
  readonly onClose: () => void;
  readonly profile: WorkbenchDirectProfileState;
  readonly subscriptionAuthentication?: SettingsSubscriptionAuthenticationState;
  readonly historyRecoveryResult?: HistoryRecoverySnapshotResult | null;
  readonly historyRecoveryBridge?: Omit<WorkbenchRendererBridge, "observeProject">;
  readonly onHistoryRecoverySnapshot?: (
    result: HistoryRecoverySnapshotResult,
  ) => void;
  readonly onRefreshHistoryRecovery?: () => void;
  readonly onBindSubscriptionAuthentication?: (
    endpointId: WorkbenchRuntimeEndpointId,
  ) => void;
  readonly onBeginSubscriptionAuthentication?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ) => void;
  readonly onCancelSubscriptionAuthentication?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ) => void;
  readonly appearance: WorkbenchAppearancePreference;
  readonly appearancePersistencePhase: WorkbenchAppearancePersistencePhase;
  readonly onAppearance: (action: WorkbenchAppearanceAction) => void;
  readonly runtimeExecutables?: WorkbenchRuntimeExecutablePaths;
  readonly runtimeExecutablePhases?: Readonly<
    Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeExecutablePhase>>
  >;
  readonly onSaveRuntimeExecutable?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly claudePermissionHandling: WorkbenchClaudePermissionHandling;
  readonly claudePermissionHandlingPersistencePhase: WorkbenchClaudePermissionHandlingPersistencePhase;
  readonly onClaudePermissionHandling: (
    permissionHandling: WorkbenchClaudePermissionHandling,
  ) => void;
  /**
   * Present only when the renderer bridge exposes the endpoint-key channels.
   * This is the independent API-transport surface (ADR 0022): one key block
   * per static-key endpoint (GLM, Kimi Code, DeepSeek, Kimi Platform — the
   * two Kimi sides render inside the merged Kimi card), rendered in the
   * slot where subscription rows place their login controls, never merging
   * into the subscription login/logout surface of the codex/claude rows.
   */
  readonly endpointKeyPanels?: Partial<
    Record<WorkbenchEndpointKeyCopyEndpointId, WorkbenchEndpointKeyPanel>
  >;
  /**
   * Catalog freshness for the static-key endpoints (ticket 14): present
   * only when the bridge exposes the freshness channels. Renders the
   * "N new models available" surfacing and the manual refresh per provider
   * row; silent failures never disturb the error surface.
   */
  readonly catalogFreshness?: WorkbenchCatalogFreshnessPanel;
  readonly canRead: boolean;
  readonly onRead: () => void;
  /**
   * The family facades (tickets 20/25): each merged card's segment switch
   * both selects the side shown and persists the manual backend preference
   * that orders the facade's automatic resolution.
   */
  readonly endpointPreferences: WorkbenchFamilyEndpointPreferences;
  readonly onEndpointPreference: (
    preference: WorkbenchFamilyEndpointPreference,
  ) => void;
}> = (props) => {
  let settingsElement!: HTMLElement;
  let closeButton!: HTMLButtonElement;
  let returnFocus: HTMLElement | null = null;
  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButton.focus({ preventScroll: true });
  });
  onCleanup(() => {
    const target = returnFocus;
    queueMicrotask(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  });
  const endpointPreferences = () =>
    props.endpointPreferences ?? defaultWorkbenchFamilyEndpointPreferences;
  const endpointRows = () =>
    directFacadeEndpointStatusRows(
      props.profile,
      endpointPreferences(),
      props.subscriptionAuthentication,
    );
  const endpointGroups = () => groupSettingsProviderRows(endpointRows());
  /** Raw per-backend rows feeding each merged family card's two sides. */
  const familySideRows = (): Readonly<
    Record<
      WorkbenchEndpointFamilyId,
      Readonly<
        Partial<
          Record<WorkbenchRuntimeEndpointId, WorkbenchRuntimeEndpointStatusRow>
        >
      >
    >
  > => {
    const rows = directEndpointStatusRows(props.profile);
    const pick = (endpointId: WorkbenchRuntimeEndpointId) =>
      rows.find((row) => row.endpointId === endpointId);
    const family = (
      ...endpointIds: readonly WorkbenchRuntimeEndpointId[]
    ) => endpointIds.map((endpointId) => pick(endpointId));
    const [claudeA, claudeB] = family("claude-code-desktop", "claude-api");
    const [codexA, codexB] = family("codex-desktop", "codex-api");
    const [kimiA, kimiB] = family("kimi-code", "kimi-platform");
    return Object.freeze({
      claude: Object.freeze({
        ...(claudeA === undefined ? {} : { "claude-code-desktop": claudeA }),
        ...(claudeB === undefined ? {} : { "claude-api": claudeB }),
      }),
      codex: Object.freeze({
        ...(codexA === undefined ? {} : { "codex-desktop": codexA }),
        ...(codexB === undefined ? {} : { "codex-api": codexB }),
      }),
      kimi: Object.freeze({
        ...(kimiA === undefined ? {} : { "kimi-code": kimiA }),
        ...(kimiB === undefined ? {} : { "kimi-platform": kimiB }),
      }),
    });
  };
  const authentication = () =>
    props.subscriptionAuthentication ??
    initialSettingsSubscriptionAuthenticationState(
      props.profile.result?.endpointDiscovery,
    );
  // CLI updates (ticket 18): the preload bridge carries the surface as an
  // intersection (see preload-bridge.ts), so the renderer bridge narrows
  // back to it here — present only when both channels exist.
  const cliUpdateBridge = ():
    | (WorkbenchRendererBridge & WorkbenchCliUpdateBridge)
    | undefined => {
    const bridge = props.historyRecoveryBridge;
    if (bridge === undefined) return undefined;
    // The central renderer-bridge interface does not carry this lane's
    // surface (contract.ts is outside this ticket's territory), so the
    // capability check runs against the widened shape before narrowing.
    const surface = bridge as unknown as Partial<WorkbenchCliUpdateBridge>;
    if (
      typeof surface.checkCliUpdates !== "function" ||
      typeof surface.runCliUpdate !== "function" ||
      typeof surface.relaunchApp !== "function"
    ) {
      return undefined;
    }
    return bridge as WorkbenchRendererBridge & WorkbenchCliUpdateBridge;
  };
  const [cliUpdateReports, setCliUpdateReports] = createSignal<
    readonly WorkbenchCliUpdateCheckReport[] | null
  >(null);
  const [cliUpdateRunPhases, setCliUpdateRunPhases] = createSignal<
    Partial<Record<WorkbenchCliUpdateCliId, WorkbenchCliUpdateRunPhase>>
  >({});
  const [cliUpdateChecking, setCliUpdateChecking] = createSignal(false);
  const [cliUpdateRelaunchPhase, setCliUpdateRelaunchPhase] =
    createSignal<WorkbenchCliUpdateRelaunchPhase>(idleCliUpdateRelaunchPhase);
  let cliUpdateActive = true;
  const failCliUpdateCheck = (): void => {
    if (!cliUpdateActive) return;
    setCliUpdateReports([
      { cliId: "claude-code", status: "check-failed" },
      { cliId: "codex", status: "no-check" },
    ]);
  };
  // Confirmed checks reuse main's memo. Failed checks retry the read-only
  // query, including the post-run refresh and explicit update-check retry.
  const refreshCliUpdateReports = (): Promise<void> => {
    const bridge = cliUpdateBridge();
    if (bridge === undefined) return Promise.resolve();
    setCliUpdateChecking(true);
    return bridge
      .checkCliUpdates()
      .then((result) => {
        if (!cliUpdateActive) return;
        if (result.ok) setCliUpdateReports(result.reports);
        else failCliUpdateCheck();
      })
      .catch(failCliUpdateCheck)
      .then(() => {
        if (!cliUpdateActive) return;
        setCliUpdateChecking(false);
      });
  };
  onMount(() => {
    void refreshCliUpdateReports();
  });
  onCleanup(() => {
    cliUpdateActive = false;
  });
  const runCliUpdate = (cliId: WorkbenchCliUpdateCliId): void => {
    const bridge = cliUpdateBridge();
    if (bridge === undefined) return;
    if (cliUpdateRunPhases()[cliId]?.kind === "running") return;
    setCliUpdateRunPhases((current) => ({
      ...current,
      [cliId]: Object.freeze({ kind: "running" as const }),
    }));
    void bridge
      .runCliUpdate(cliId)
      .then((result) => {
        if (!cliUpdateActive) return;
        setCliUpdateRunPhases((current) => ({
          ...current,
          [cliId]: result.ok
            ? Object.freeze({ kind: "succeeded" as const })
            : result.error.category === "cli-update-run-failed"
              ? Object.freeze({
                  kind: "failed" as const,
                  reason: result.error.reason,
                })
              : Object.freeze({ kind: "unavailable" as const }),
        }));
      })
      .catch(() => {
        if (!cliUpdateActive) return;
        setCliUpdateRunPhases((current) => ({
          ...current,
          [cliId]: Object.freeze({ kind: "unavailable" as const }),
        }));
      })
      // Whatever the run reported, the row must now describe the machine
      // rather than the version it advertised before the press. Its own
      // failure is swallowed so a refresh problem can never rewrite the
      // run's verdict.
      .then(() => refreshCliUpdateReports());
  };
  const acknowledgeCliUpdateRestart = (
    cliId: WorkbenchCliUpdateCliId,
  ): void => {
    setCliUpdateRunPhases((current) => ({
      ...current,
      [cliId]:
        current[cliId]?.kind === "succeeded"
          ? Object.freeze({ kind: "succeeded-quiet" as const })
          : current[cliId],
    }));
  };
  // Issue 184: a check that failed must leave the owner able to act. The
  // row says the check failed and this retries it, in place, without a
  // restart of the app.
  const recheckCliUpdates = (): void => {
    if (cliUpdateChecking()) return;
    void refreshCliUpdateReports();
  };
  // Issue 184: the success copy told him to restart and then offered only
  // "Not now". This is the action it was describing. Main takes the same
  // quit path the tray Quit item takes, so the durable state is flushed
  // before the process is replaced.
  const restartCliUpdateApp = (): void => {
    const bridge = cliUpdateBridge();
    if (bridge === undefined) return;
    if (cliUpdateRelaunchPhase().kind === "requesting") return;
    setCliUpdateRelaunchPhase(Object.freeze({ kind: "requesting" as const }));
    void bridge
      .relaunchApp()
      .then((result) => {
        // `queued` is terminal: the drain is running and this window is on
        // its way out, so only a refusal changes the phase again.
        if (!cliUpdateActive || result.ok) return;
        setCliUpdateRelaunchPhase(Object.freeze({ kind: "failed" as const }));
      })
      .catch(() => {
        if (!cliUpdateActive) return;
        setCliUpdateRelaunchPhase(Object.freeze({ kind: "failed" as const }));
      });
  };
  const cliUpdatePanel = (): WorkbenchCliUpdatePanel | undefined =>
    cliUpdateBridge() === undefined
      ? undefined
      : Object.freeze({
          reports: cliUpdateReports(),
          runPhase: (cliId: WorkbenchCliUpdateCliId) =>
            cliUpdateRunPhases()[cliId] ?? idleCliUpdateRunPhase,
          onUpdate: runCliUpdate,
          onAcknowledgeRestart: acknowledgeCliUpdateRestart,
          checking: cliUpdateChecking(),
          onRecheck: recheckCliUpdates,
          relaunchPhase: cliUpdateRelaunchPhase(),
          onRestartNow: restartCliUpdateApp,
        });
  const persistence = () =>
    appearancePersistencePresentation(props.appearancePersistencePhase);
  const permissionPersistence = () =>
    appearancePersistencePresentation(
      props.claudePermissionHandlingPersistencePhase === "load-error" ||
        props.claudePermissionHandlingPersistencePhase === "save-error"
        ? "error"
        : props.claudePermissionHandlingPersistencePhase,
    );
  return (
    <main
      ref={settingsElement}
      class="settings"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = Array.from(
          settingsElement.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first === undefined || last === undefined) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
          <div class="settings-inner">
          <div class="settings-title-row">
            <h1>{settingsCopy.title}</h1>
            <button
              ref={closeButton}
              type="button"
              class="icon-btn settings-close-button"
              aria-label={settingsCopy.closeAria}
              title={chromeCopy.projectMenuTitle}
              onClick={props.onClose}
            >
              ×
            </button>
          </div>
          <p class="lede">
            {settingsCopy.lede}
          </p>

          <HistoryRecoverySettingsCard
            bridge={props.historyRecoveryBridge ?? Object.freeze({})}
            result={props.historyRecoveryResult ?? null}
            onSnapshot={
              props.onHistoryRecoverySnapshot ?? (() => undefined)
            }
            onRefresh={props.onRefreshHistoryRecovery ?? (() => undefined)}
          />

          <div class="section-head providers-section-head">
            <h2 id="providers-title">{settingsCopy.providersHeading}</h2>
            <button
              type="button"
              class="btn ghost sm providers-recheck"
              disabled={!props.canRead}
              aria-busy={props.profile.phase === "loading"}
              onClick={props.onRead}
            >
              {props.profile.phase === "loading"
                ? settingsCopy.readingCatalogs
                : props.profile.phase === "idle"
                  ? settingsCopy.readCatalogs
                  : settingsCopy.recheckAll}
            </button>
          </div>
          <section
            class="provider-settings"
            aria-labelledby="providers-title"
          >
            <div class="guard">
              <span class="g-glyph" aria-hidden="true">
                🔒
              </span>
              <div>
                <b>{settingsCopy.credentialHeading}</b>
                <p>
                  {settingsCopy.credentialSentence}
                </p>
              </div>
            </div>

            <Show when={endpointGroups().catalogAvailable.length > 0}>
              <ProviderGroup
                heading={settingsCopy.catalogAvailableHeading}
                rows={endpointGroups().catalogAvailable}
                authentication={authentication()}
                endpointKeyPanels={props.endpointKeyPanels}
                catalogFreshness={props.catalogFreshness}
                cliUpdate={cliUpdatePanel()}
                familySideRows={familySideRows()}
                endpointPreferences={props.endpointPreferences}
                onEndpointPreference={props.onEndpointPreference}
                runtimeExecutables={props.runtimeExecutables}
                runtimeExecutablePhases={props.runtimeExecutablePhases}
                onSaveExecutablePath={props.onSaveRuntimeExecutable}
                onBind={props.onBindSubscriptionAuthentication}
                onBegin={props.onBeginSubscriptionAuthentication}
                onCancel={props.onCancelSubscriptionAuthentication}
              />
            </Show>
            <Show when={endpointGroups().catalogUnavailable.length > 0}>
              <ProviderGroup
                heading={settingsCopy.catalogUnavailableHeading}
                rows={endpointGroups().catalogUnavailable}
                authentication={authentication()}
                endpointKeyPanels={props.endpointKeyPanels}
                catalogFreshness={props.catalogFreshness}
                cliUpdate={cliUpdatePanel()}
                familySideRows={familySideRows()}
                endpointPreferences={props.endpointPreferences}
                onEndpointPreference={props.onEndpointPreference}
                runtimeExecutables={props.runtimeExecutables}
                runtimeExecutablePhases={props.runtimeExecutablePhases}
                onSaveExecutablePath={props.onSaveRuntimeExecutable}
                onBind={props.onBindSubscriptionAuthentication}
                onBegin={props.onBeginSubscriptionAuthentication}
                onCancel={props.onCancelSubscriptionAuthentication}
              />
            </Show>
            <Show when={endpointGroups().notInspected.length > 0}>
              <ProviderGroup
                heading={settingsCopy.notCheckedHeading}
                rows={endpointGroups().notInspected}
                authentication={authentication()}
                endpointKeyPanels={props.endpointKeyPanels}
                catalogFreshness={props.catalogFreshness}
                cliUpdate={cliUpdatePanel()}
                familySideRows={familySideRows()}
                endpointPreferences={props.endpointPreferences}
                onEndpointPreference={props.onEndpointPreference}
                runtimeExecutables={props.runtimeExecutables}
                runtimeExecutablePhases={props.runtimeExecutablePhases}
                onSaveExecutablePath={props.onSaveRuntimeExecutable}
                onBind={props.onBindSubscriptionAuthentication}
                onBegin={props.onBeginSubscriptionAuthentication}
                onCancel={props.onCancelSubscriptionAuthentication}
              />
            </Show>

            <section
              class="provider-group other-providers"
              aria-labelledby="other-providers-title"
            >
              <h3 id="other-providers-title">{settingsCopy.otherProvidersHeading}</h3>
              <p>{settingsCopy.otherProvidersSentence}</p>
            </section>

            <section
              class="provider-status-key"
              aria-labelledby="provider-status-key-title"
            >
              <h3 id="provider-status-key-title">{settingsCopy.statusMeaningsHeading}</h3>
              <dl>
                <For each={settingsProviderStatusMeanings}>
                  {(meaning) => (
                    <div>
                      <dt>{meaning.label}</dt>
                      <dd>{meaning.detail}</dd>
                    </div>
                  )}
                </For>
              </dl>
            </section>
          </section>

          <SettingsSubscriptionUsage bridge={props.historyRecoveryBridge} />

          <div class="section-head permission-section-head">
            <h2 id="claude-permissions-title">
              {settingsCopy.claudePermissionsHeading}
            </h2>
            <span
              class={`settings-scope ${
                permissionPersistence().error ? "error" : ""
              }`.trim()}
            >
              {permissionPersistence().label}
            </span>
          </div>
          <section
            class="appearance-settings"
            aria-labelledby="claude-permissions-title"
          >
            <div class="appearance-row">
              <span class="appearance-copy">
                <b id="claude-permission-handling-label">
                  {settingsCopy.permissionHandlingLabel}
                </b>
                <span id="claude-permission-handling-hint">
                  {settingsCopy.permissionHandlingHint}
                </span>
              </span>
              <span
                class="appearance-options"
                role="group"
                aria-labelledby="claude-permission-handling-label"
                aria-describedby="claude-permission-handling-hint"
              >
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={
                    props.claudePermissionHandling === "without-asking"
                  }
                  disabled={
                    props.claudePermissionHandlingPersistencePhase === "saving"
                  }
                  onClick={() =>
                    props.onClaudePermissionHandling("without-asking")
                  }
                >
                  {settingsCopy.withoutAskingPermissionOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={
                    props.claudePermissionHandling === "ask-when-needed"
                  }
                  disabled={
                    props.claudePermissionHandlingPersistencePhase === "saving"
                  }
                  onClick={() =>
                    props.onClaudePermissionHandling("ask-when-needed")
                  }
                >
                  {settingsCopy.askWhenNeededPermissionOption}
                </button>
              </span>
            </div>
          </section>
          <Show
            when={
              props.claudePermissionHandlingPersistencePhase === "save-error"
            }
          >
            <p class="appearance-persistence-error" role="alert">
              {settingsCopy.permissionPersistenceErrorSentence}
            </p>
          </Show>
          <Show
            when={
              props.claudePermissionHandlingPersistencePhase === "load-error"
            }
          >
            <p class="appearance-persistence-error" role="alert">
              {settingsCopy.permissionLoadErrorSentence}
            </p>
          </Show>

          <div class="section-head appearance-section-head">
            <h2 id="appearance-title">{settingsCopy.appearanceHeading}</h2>
            <span
              class={`settings-scope ${
                persistence().error ? "error" : ""
              }`.trim()}
            >
              {persistence().label}
            </span>
          </div>
          <section
            class="appearance-settings"
            aria-labelledby="appearance-title"
          >
            <div class="appearance-row">
              <span class="appearance-copy">
                <b id="appearance-language-label">{settingsCopy.languageLabel}</b>
                <span>{settingsCopy.languageHint}</span>
              </span>
              <span
                class="appearance-options"
                role="group"
                aria-labelledby="appearance-language-label"
              >
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={(props.appearance.language ?? "en") === "en"}
                  onClick={() =>
                    props.onAppearance({ type: "set-language", language: "en" })
                  }
                >
                  {settingsCopy.englishOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.language === "zh-CN"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-language",
                      language: "zh-CN",
                    })
                  }
                >
                  {settingsCopy.simplifiedChineseOption}
                </button>
              </span>
            </div>
            <div class="appearance-row">
              <span class="appearance-copy">
                <b id="appearance-tone-label">{settingsCopy.toneLabel}</b>
                <span>{settingsCopy.toneHint}</span>
              </span>
              <span
                class="appearance-options"
                role="group"
                aria-labelledby="appearance-tone-label"
              >
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.tone === "dark"}
                  onClick={() =>
                    props.onAppearance({ type: "set-tone", tone: "dark" })
                  }
                >
                  {settingsCopy.darkOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.tone === "light"}
                  onClick={() =>
                    props.onAppearance({ type: "set-tone", tone: "light" })
                  }
                >
                  {settingsCopy.lightOption}
                </button>
              </span>
            </div>
            <div class="appearance-row">
              <span class="appearance-copy">
                <b id="appearance-crt-label">{settingsCopy.crtLabel}</b>
                <span>{settingsCopy.crtHint}</span>
              </span>
              <span
                class="appearance-options"
                role="group"
                aria-labelledby="appearance-crt-label"
              >
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.crt === "off"}
                  onClick={() =>
                    props.onAppearance({ type: "set-crt", crt: "off" })
                  }
                >
                  {settingsCopy.offOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.crt === "blocks"}
                  onClick={() =>
                    props.onAppearance({ type: "set-crt", crt: "blocks" })
                  }
                >
                  {settingsCopy.blocksOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.crt === "screen"}
                  onClick={() =>
                    props.onAppearance({ type: "set-crt", crt: "screen" })
                  }
                >
                  {settingsCopy.screenOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.crt === "full"}
                  onClick={() =>
                    props.onAppearance({ type: "set-crt", crt: "full" })
                  }
                >
                  {settingsCopy.fullOption}
                </button>
              </span>
            </div>
            <div class="appearance-row">
              <span class="appearance-copy">
                <b id="appearance-phosphor-label">{settingsCopy.phosphorLabel}</b>
                <span>{settingsCopy.phosphorHint}</span>
              </span>
              <span
                class="appearance-options"
                role="group"
                aria-labelledby="appearance-phosphor-label"
              >
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.phosphor === "neutral"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-phosphor",
                      phosphor: "neutral",
                    })
                  }
                >
                  {settingsCopy.neutralOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.phosphor === "green"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-phosphor",
                      phosphor: "green",
                    })
                  }
                >
                  {settingsCopy.greenOption}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.phosphor === "amber"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-phosphor",
                      phosphor: "amber",
                    })
                  }
                >
                  {settingsCopy.amberOption}
                </button>
              </span>
            </div>
            <div class="appearance-row">
              <span class="appearance-copy">
                <b id="appearance-phosphor-tier-label">{settingsCopy.lightGlowLabel}</b>
                <span>
                  {settingsCopy.lightGlowHint}
                </span>
              </span>
              <span
                class="appearance-options"
                role="group"
                aria-labelledby="appearance-phosphor-tier-label"
              >
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.phosphorTier === "a"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-phosphor-tier",
                      phosphorTier: "a",
                    })
                  }
                >
                  {settingsCopy.tierARestrained}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.phosphorTier === "b"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-phosphor-tier",
                      phosphorTier: "b",
                    })
                  }
                >
                  {settingsCopy.tierBLuminous}
                </button>
                <button
                  type="button"
                  class="appearance-option"
                  aria-pressed={props.appearance.phosphorTier === "c"}
                  onClick={() =>
                    props.onAppearance({
                      type: "set-phosphor-tier",
                      phosphorTier: "c",
                    })
                  }
                >
                  {settingsCopy.tierCHottest}
                </button>
              </span>
            </div>
          </section>
          <Show when={props.appearancePersistencePhase === "error"}>
            <p class="appearance-persistence-error" role="alert">
              {settingsCopy.persistenceErrorSentence}
            </p>
          </Show>
      </div>
    </main>
  );
};

type FamilySideRows = Readonly<
  Record<
    WorkbenchEndpointFamilyId,
    Readonly<
      Partial<
        Record<WorkbenchRuntimeEndpointId, WorkbenchRuntimeEndpointStatusRow>
      >
    >
  >
>;

const ProviderGroup: Component<{
  readonly heading: ProviderGroupHeading;
  readonly rows: readonly WorkbenchRuntimeEndpointStatusRow[];
  readonly authentication: SettingsSubscriptionAuthenticationState;
  readonly endpointKeyPanels?: Partial<
    Record<WorkbenchEndpointKeyCopyEndpointId, WorkbenchEndpointKeyPanel>
  >;
  readonly catalogFreshness?: WorkbenchCatalogFreshnessPanel;
  readonly cliUpdate?: WorkbenchCliUpdatePanel;
  readonly familySideRows: FamilySideRows;
  readonly endpointPreferences: WorkbenchFamilyEndpointPreferences;
  readonly onEndpointPreference: (
    preference: WorkbenchFamilyEndpointPreference,
  ) => void;
  readonly runtimeExecutables?: WorkbenchRuntimeExecutablePaths;
  readonly runtimeExecutablePhases?: Readonly<
    Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeExecutablePhase>>
  >;
  readonly onSaveExecutablePath?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly onBind?: (endpointId: WorkbenchRuntimeEndpointId) => void;
  readonly onBegin?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ) => void;
  readonly onCancel?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ) => void;
}> = (props) => {
  const headingId = () =>
    props.heading === settingsCopy.catalogAvailableHeading
      ? "available-catalogs-title"
      : props.heading === settingsCopy.catalogUnavailableHeading
        ? "unavailable-catalogs-title"
        : "unchecked-catalogs-title";
  const rowFamily = (endpointId: WorkbenchRuntimeEndpointId) =>
    workbenchFacadeFamilyOfEndpointId(endpointId);
  const preferences = () =>
    props.endpointPreferences ?? defaultWorkbenchFamilyEndpointPreferences;
  return (
    <section class="provider-group" aria-labelledby={headingId()}>
      <h3 id={headingId()}>{props.heading}</h3>
      <div class="provider-endpoint-list">
        <For each={props.rows}>
          {(row) => {
            const family = rowFamily(row.endpointId);
            return (
              <Show
                when={family !== undefined}
                fallback={
                  <ProviderCard
                    row={row}
                    authentication={props.authentication[row.endpointId]}
                    endpointKeyPanels={props.endpointKeyPanels}
                    catalogFreshness={props.catalogFreshness}
                    cliUpdate={props.cliUpdate}
                    executablePath={props.runtimeExecutables?.[row.runtime]}
                    executablePhase={props.runtimeExecutablePhases?.[row.runtime]}
                    onSaveExecutablePath={props.onSaveExecutablePath}
                    onBind={props.onBind}
                    onBegin={props.onBegin}
                    onCancel={props.onCancel}
                  />
                }
              >
                <Show
                  when={family === "kimi"}
                  fallback={
                    <SubscriptionFacadeProviderCard
                      row={row}
                      family={family === "claude" ? "claude" : "codex"}
                      sides={props.familySideRows[family === "claude" ? "claude" : "codex"]}
                      preference={preferences()[family === "claude" ? "claude" : "codex"]}
                      onPreference={props.onEndpointPreference}
                      authentication={props.authentication}
                      endpointKeyPanels={props.endpointKeyPanels}
                      catalogFreshness={props.catalogFreshness}
                      cliUpdate={props.cliUpdate}
                      executablePath={props.runtimeExecutables}
                      executablePhases={props.runtimeExecutablePhases}
                      onSaveExecutablePath={props.onSaveExecutablePath}
                      onBind={props.onBind}
                      onBegin={props.onBegin}
                      onCancel={props.onCancel}
                    />
                  }
                >
                  <KimiFacadeProviderCard
                    row={row}
                    sides={props.familySideRows.kimi}
                    preference={preferences().kimi}
                    onPreference={props.onEndpointPreference}
                    endpointKeyPanels={props.endpointKeyPanels}
                    catalogFreshness={props.catalogFreshness}
                  />
                </Show>
              </Show>
            );
          }}
        </For>
      </div>
    </section>
  );
};

/**
 * The merged Kimi card (ticket 20): one "Kimi" presentation for the two
 * genuinely different Kimi endpoints. The badge and the group placement
 * follow the facade row — the backend the selector would resolve to — while
 * the body shows the active segment's own honest status and its complete
 * key management. The segment switch doubles as the persisted manual
 * preference that orders the facade's automatic resolution.
 */
const KimiFacadeProviderCard: Component<{
  readonly row: WorkbenchRuntimeEndpointStatusRow;
  readonly sides: Readonly<
    Partial<
      Record<"kimi-code" | "kimi-platform", WorkbenchRuntimeEndpointStatusRow>
    >
  >;
  readonly preference: WorkbenchFamilyEndpointPreferences["kimi"];
  readonly onPreference: (
    preference: WorkbenchFamilyEndpointPreference,
  ) => void;
  readonly endpointKeyPanels?: Partial<
    Record<WorkbenchEndpointKeyCopyEndpointId, WorkbenchEndpointKeyPanel>
  >;
  readonly catalogFreshness?: WorkbenchCatalogFreshnessPanel;
}> = (props) => {
  const headingId = "provider-kimi-heading";
  const availability = () =>
    settingsProviderAvailabilityPresentation(props.row.category);
  const activeRow = () => props.sides[props.preference];
  const segmentLabel = (
    backend: WorkbenchFamilyEndpointPreferences["kimi"],
  ): string =>
    backend === "kimi-code"
      ? endpointIdentityCopy.kimi.endpointLabel
      : endpointIdentityCopy.kimiPlatform.endpointLabel;
  const endpointKeyPanel = ():
    | {
        readonly endpointId: WorkbenchEndpointKeyCopyEndpointId;
        readonly panel: WorkbenchEndpointKeyPanel;
      }
    | undefined => {
    const panels = props.endpointKeyPanels;
    if (panels === undefined) return undefined;
    const endpointId = props.preference as WorkbenchEndpointKeyCopyEndpointId;
    const panel = panels[endpointId];
    return panel === undefined ? undefined : { endpointId, panel };
  };
  const endpointFreshnessReport = ():
    | WorkbenchEndpointCatalogFreshnessReport
    | undefined =>
    props.catalogFreshness?.reports?.find(
      (report) => report.endpointId === props.preference,
    );
  return (
    <section class="provider provider-kimi" aria-labelledby={headingId}>
      <div class="provider-head">
        <span class={"rt-dot " + runtimeClass(props.row.runtimeFamilyLabel)} aria-hidden="true" />
        <div>
          <div
            id={headingId}
            class={"ph-name " + runtimeClass(props.row.runtimeFamilyLabel)}
          >
            {props.row.runtimeFamilyLabel}
          </div>
          <div class="ph-sub">
            {activeRow()?.endpointLabel ?? segmentLabel(props.preference)}
          </div>
        </div>
        <span class={"badge " + availability().tone}>
          {availability().label}
        </span>
      </div>
      <div class="provider-body">
        <div
          class="kimi-segments"
          role="group"
          aria-label={familyFacadeCopy.segmentsLabel("Kimi")}
        >
          {(["kimi-code", "kimi-platform"] as const).map((backend) => (
            <button
              type="button"
              class="btn sm kimi-segment"
              classList={{ ghost: props.preference !== backend }}
              aria-pressed={props.preference === backend}
              onClick={() => props.onPreference(backend)}
            >
              {segmentLabel(backend)}
            </button>
          ))}
        </div>
        <dl class="kv">
          <InspectorFact
            label={settingsCopy.statusFactLabel}
            value={activeRow()?.statusLabel ?? props.row.statusLabel}
            tone={availability().tone}
          />
          <InspectorFact
            label={settingsCopy.catalogFactLabel}
            value={
              activeRow()?.category === "catalog-ready"
                ? settingsCopy.catalogReadyValue
                : activeRow()?.category === "not-inspected"
                  ? settingsCopy.notInspectedValue
                  : settingsCopy.catalogUnavailableValue
            }
            tone={activeRow()?.category === "catalog-ready" ? "ok" : undefined}
          />
          <Show when={activeRow()?.endpoint}>
            {(endpoint) => (
              <InspectorFact
                label={settingsCopy.modelsFactLabel}
                value={String(endpoint().models.length)}
                mono
              />
            )}
          </Show>
        </dl>
        <p class="provider-status-detail">
          {activeRow()?.detail ?? props.row.detail}
        </p>
      </div>
      <div class="provider-actions">
        <Show when={endpointKeyPanel()}>
          {(entry) => (
            <EndpointKeyControls
              endpointId={entry().endpointId}
              panel={entry().panel}
            />
          )}
        </Show>
        <Show when={endpointFreshnessReport()}>
          {(report) => (
            <EndpointCatalogFreshnessControls
              report={report()}
              refreshing={props.catalogFreshness?.refreshing ?? false}
              onRefresh={() => props.catalogFreshness?.onRefresh()}
            />
          )}
        </Show>
      </div>
    </section>
  );
};

/**
 * The merged subscription-family card (ticket 25): one "Claude" / "Codex"
 * presentation for the desktop-subscription and API endpoints. The badge and
 * the group placement follow the facade row — the backend the selector would
 * resolve to — while the body shows the active segment's own honest status.
 * The subscription face carries the existing login/logout/status controls
 * (plus the runtime lookup when the desktop CLI is missing); the API face
 * carries the existing generalized key controls. The segment switch doubles
 * as the persisted manual preference that orders the facade's automatic
 * (subscription-first) resolution.
 */
const SubscriptionFacadeProviderCard: Component<{
  readonly row: WorkbenchRuntimeEndpointStatusRow;
  readonly family: "claude" | "codex";
  readonly sides: Readonly<
    Partial<
      Record<WorkbenchRuntimeEndpointId, WorkbenchRuntimeEndpointStatusRow>
    >
  >;
  readonly preference: WorkbenchFamilyEndpointPreferences[WorkbenchEndpointFamilyId];
  readonly onPreference: (
    preference: WorkbenchFamilyEndpointPreference,
  ) => void;
  readonly authentication: SettingsSubscriptionAuthenticationState;
  readonly endpointKeyPanels?: Partial<
    Record<WorkbenchEndpointKeyCopyEndpointId, WorkbenchEndpointKeyPanel>
  >;
  readonly catalogFreshness?: WorkbenchCatalogFreshnessPanel;
  readonly cliUpdate?: WorkbenchCliUpdatePanel;
  readonly executablePath?: WorkbenchRuntimeExecutablePaths;
  readonly executablePhases?: Readonly<
    Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeExecutablePhase>>
  >;
  readonly onSaveExecutablePath?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly onBind?: (endpointId: WorkbenchRuntimeEndpointId) => void;
  readonly onBegin?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ) => void;
  readonly onCancel?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ) => void;
}> = (props) => {
  const subscriptionEndpointId: WorkbenchRuntimeEndpointId =
    props.family === "claude" ? "claude-code-desktop" : "codex-desktop";
  const apiEndpointId: WorkbenchRuntimeEndpointId =
    props.family === "claude" ? "claude-api" : "codex-api";
  const headingId = `provider-${props.family}-heading`;
  const availability = () =>
    settingsProviderAvailabilityPresentation(props.row.category);
  const subscriptionRow = () => props.sides[subscriptionEndpointId];
  const apiRow = () => props.sides[apiEndpointId];
  const onSubscriptionSide = () => props.preference === subscriptionEndpointId;
  const runtimeLookup = () => subscriptionRow()?.lookup ?? undefined;
  const configuredExecutablePath = () =>
    props.executablePath?.[props.family] ?? "";
  const activeRow = () =>
    onSubscriptionSide() ? subscriptionRow() : apiRow();
  const segmentLabel = (backend: WorkbenchRuntimeEndpointId): string =>
    backend === subscriptionEndpointId
      ? (props.family === "claude"
          ? endpointIdentityCopy.claude.endpointLabel
          : endpointIdentityCopy.codex.endpointLabel)
      : (props.family === "claude"
          ? endpointIdentityCopy.claudeApi.endpointLabel
          : endpointIdentityCopy.codexApi.endpointLabel);
  const authenticationEntry = () =>
    props.authentication[subscriptionEndpointId];
  const binding = () =>
    authenticationEntry() === undefined
      ? undefined
      : settingsSubscriptionAuthenticationPresentation(authenticationEntry()!);
  const endpointKeyPanel = ():
    | {
        readonly endpointId: WorkbenchEndpointKeyCopyEndpointId;
        readonly panel: WorkbenchEndpointKeyPanel;
      }
    | undefined => {
    if (!onSubscriptionSide()) {
      const panels = props.endpointKeyPanels;
      if (panels === undefined) return undefined;
      const endpointId =
        apiEndpointId as WorkbenchEndpointKeyCopyEndpointId;
      const panel = panels[endpointId];
      return panel === undefined ? undefined : { endpointId, panel };
    }
    return undefined;
  };
  // Catalog freshness is enrolled only for GLM and DeepSeek; Kimi Code has no
  // verified zero-inference models-list route, and claude-api/codex-api are not
  // enrolled.
  const cliUpdateEntry = ():
    | {
        readonly cliId: WorkbenchCliUpdateCliId;
        readonly report: WorkbenchCliUpdateCheckReport | undefined;
      }
    | undefined => {
    if (!onSubscriptionSide()) return undefined;
    const panel = props.cliUpdate;
    if (panel === undefined) return undefined;
    const cliId = cliIdForEndpoint(subscriptionEndpointId);
    if (cliId === undefined) return undefined;
    return Object.freeze({
      cliId,
      report: panel.reports?.find((report) => report.cliId === cliId),
    });
  };
  return (
    <section
      class={`provider provider-${props.family}`}
      aria-labelledby={headingId}
    >
      <div class="provider-head">
        <span class={"rt-dot " + runtimeClass(props.row.runtimeFamilyLabel)} aria-hidden="true" />
        <div>
          <div
            id={headingId}
            class={"ph-name " + runtimeClass(props.row.runtimeFamilyLabel)}
          >
            {props.row.runtimeFamilyLabel}
          </div>
          <div class="ph-sub">
            {activeRow()?.endpointLabel ?? segmentLabel(props.preference)}
          </div>
        </div>
        <span class={"badge " + availability().tone}>
          {availability().label}
        </span>
      </div>
      <div class="provider-body">
        <div
          class="kimi-segments"
          role="group"
          aria-label={familyFacadeCopy.segmentsLabel(props.row.runtimeFamilyLabel)}
        >
          {[subscriptionEndpointId, apiEndpointId].map((backend) => (
            <button
              type="button"
              class="btn sm kimi-segment"
              classList={{ ghost: props.preference !== backend }}
              aria-pressed={props.preference === backend}
              onClick={() => props.onPreference(backend)}
            >
              {segmentLabel(backend)}
            </button>
          ))}
        </div>
        <dl class="kv">
          <InspectorFact
            label={settingsCopy.statusFactLabel}
            value={activeRow()?.statusLabel ?? props.row.statusLabel}
            tone={availability().tone}
          />
          <InspectorFact
            label={settingsCopy.catalogFactLabel}
            value={
              activeRow()?.category === "catalog-ready"
                ? settingsCopy.catalogReadyValue
                : activeRow()?.category === "not-inspected"
                  ? settingsCopy.notInspectedValue
                  : settingsCopy.catalogUnavailableValue
            }
            tone={activeRow()?.category === "catalog-ready" ? "ok" : undefined}
          />
          <Show when={activeRow()?.endpoint}>
            {(endpoint) => (
              <InspectorFact
                label={settingsCopy.modelsFactLabel}
                value={String(endpoint().models.length)}
                mono
              />
            )}
          </Show>
        </dl>
        <p class="provider-status-detail">
          {activeRow()?.detail ?? props.row.detail}
        </p>
        <Show
          when={
            onSubscriptionSide() &&
            (runtimeLookup() !== undefined ||
              configuredExecutablePath().trim().length > 0)
          }
        >
          <div class="provider-lookup">
            <Show when={runtimeLookup()}>
              {(lookup) => (
                <>
                  <p class="provider-lookup-label">
                    {runtimeLookupCopy.lookedForLabel}
                  </p>
                  <ul class="provider-lookup-list">
                    <For each={lookup().places}>
                      {(place) => (
                        <li>{runtimeLookupPlaceCopy(place.names, place.location)}</li>
                      )}
                    </For>
                  </ul>
                  <p class="provider-lookup-get">
                    <span class="provider-lookup-get-label">
                      {runtimeLookupCopy.getItLabel}
                    </span>{" "}
                    <span class="provider-lookup-url">{lookup().installUrl}</span>
                  </p>
                </>
              )}
            </Show>
            <RuntimeExecutableField
              runtime={props.family}
              value={configuredExecutablePath()}
              phase={props.executablePhases?.[props.family]}
              onSave={props.onSaveExecutablePath}
            />
          </div>
        </Show>
      </div>
      <div class="provider-actions">
        <Show when={onSubscriptionSide() && binding() !== undefined}>
          {(_binding) => {
            const bindingValue = binding()!;
            return (
              <div class="provider-binding-copy">
                <span
                  class={`provider-binding-status ${bindingValue.tone}`}
                  role="status"
                  aria-label={bindingStatusAriaCopy(
                    props.row.runtimeFamilyLabel,
                    bindingValue.label,
                  )}
                >
                  <span>{settingsCopy.subscriptionSignIn}</span>
                  <strong>{bindingValue.label}</strong>
                </span>
                <p>{bindingValue.detail}</p>
                <Show when={bindingValue.feedback}>
                  {(feedback) => (
                    <p class="provider-binding-feedback" role="status" aria-live="polite">
                      {feedback()}
                    </p>
                  )}
                </Show>
                <Show when={bindingValue.blockedStatement}>
                  {(statement) => (
                    <div class="provider-auth-blockers" role="alert">
                      <p>{statement()}</p>
                      <ul>
                        <For each={bindingValue.blockers}>
                          {(blocker) => (
                            <li>
                              {blocker.label}: {blocker.count}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </Show>
                <Show when={authenticationEntry()!.confirmation}>
                  {(confirmation) => (
                    <div class="provider-auth-confirmation" role="group">
                      <p>
                        {settingsCopy.confirmationSentence}
                      </p>
                      <p>
                        {authConsequencesCopy(
                          confirmation().resumableSessionCount,
                          confirmation().projectCount,
                        )}
                      </p>
                      <div class="provider-auth-confirmation-actions">
                        <button
                          type="button"
                          class="btn sm"
                          disabled={props.onBegin === undefined}
                          onClick={() =>
                            props.onBegin?.(
                              subscriptionEndpointId,
                              confirmation().preparationKey,
                              confirmation().action,
                            )
                          }
                        >
                          {confirmation().action === "logout"
                            ? settingsCopy.confirmLogout
                            : settingsCopy.continueWithLogin}
                        </button>
                        <button
                          type="button"
                          class="btn ghost sm"
                          disabled={props.onCancel === undefined}
                          onClick={() =>
                            props.onCancel?.(
                              subscriptionEndpointId,
                              confirmation().preparationKey,
                            )
                          }
                        >
                          {commonCopy.cancel}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
                <div class="provider-binding-actions">
                  <Show when={authenticationEntry()!.confirmation === null}>
                    <button
                      type="button"
                      class="btn sm"
                      disabled={
                        props.onBind === undefined ||
                        bindingValue.pending ||
                        bindingValue.inspectionPending ||
                        bindingValue.blockedStatement !== null
                      }
                      aria-busy={
                        bindingValue.pending || bindingValue.inspectionPending
                      }
                      aria-label={bindActionAriaCopy(
                        bindingValue.actionLabel,
                        props.row.runtimeFamilyLabel,
                      )}
                      onClick={() => props.onBind?.(subscriptionEndpointId)}
                    >
                      {bindingValue.actionLabel}
                    </button>
                  </Show>
                </div>
              </div>
            );
          }}
        </Show>
        <Show when={endpointKeyPanel()}>
          {(entry) => (
            <EndpointKeyControls
              endpointId={entry().endpointId}
              panel={entry().panel}
            />
          )}
        </Show>
        <Show when={cliUpdateEntry()}>
          {(entry) => (
            <CliUpdateControls
              cliId={entry().cliId}
              report={entry().report}
              phase={props.cliUpdate?.runPhase(entry().cliId) ?? idleCliUpdateRunPhase}
              checking={props.cliUpdate?.checking ?? false}
              relaunchPhase={
                props.cliUpdate?.relaunchPhase ?? idleCliUpdateRelaunchPhase
              }
              onUpdate={() => props.cliUpdate?.onUpdate(entry().cliId)}
              onRecheck={() => props.cliUpdate?.onRecheck()}
              onRestartNow={() => props.cliUpdate?.onRestartNow()}
              onAcknowledgeRestart={() =>
                props.cliUpdate?.onAcknowledgeRestart(entry().cliId)
              }
            />
          )}
        </Show>
      </div>
    </section>
  );
};

/**
 * The way out of a discovery gap.
 *
 * This is a plain typed path, not a native chooser. Three source-scanning
 * guards pin the product's one native chooser call site to its own main-process
 * module and require this file to name no chooser API at all, so adding one
 * here would be new surface in files this change has no business widening.
 * Typing a path is what the failure text above already tells the user to do.
 * A saved override stays editable when a later runtime inspection fails, so
 * the user can replace or clear it without editing the preference file.
 */
const RuntimeExecutableField: Component<{
  readonly runtime: WorkbenchConfigurableRuntime;
  readonly value: string;
  readonly phase?: SettingsRuntimeExecutablePhase;
  readonly onSave?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  const fieldId = () => `runtime-executable-${props.runtime}`;
  const saving = () => props.phase?.status === "saving";
  return (
    <form
      class="runtime-executable-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave?.(props.runtime, draft().trim());
      }}
    >
      <label class="runtime-executable-label" for={fieldId()}>
        {runtimeExecutableCopy.fieldLabel}
      </label>
      <span id={`${fieldId()}-hint`} class="runtime-executable-hint">
        {runtimeExecutableCopy.fieldHint}
      </span>
      <span class="runtime-executable-controls">
        <input
          id={fieldId()}
          type="text"
          class="runtime-executable-input"
          spellcheck={false}
          autocomplete="off"
          disabled={saving()}
          aria-describedby={`${fieldId()}-hint`}
          placeholder={
            props.runtime === "codex"
              ? runtimeExecutableCopy.placeholderCodex
              : runtimeExecutableCopy.placeholderClaude
          }
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" class="btn sm" disabled={saving()}>
          {saving()
            ? runtimeExecutableCopy.savingAction
            : runtimeExecutableCopy.saveAction}
        </button>
        <button
          type="button"
          class="btn ghost sm"
          disabled={saving() || draft().trim().length === 0}
          onClick={() => {
            setDraft("");
            props.onSave?.(props.runtime, "");
          }}
        >
          {runtimeExecutableCopy.clearAction}
        </button>
      </span>
      <Show when={props.phase}>
        {(phase) => (
          <p
            class={
              phase().status === "rejected" || phase().status === "unavailable"
                ? "runtime-executable-error"
                : "runtime-executable-note"
            }
            role="status"
          >
            {phase().status === "rejected" && phase().rejection !== undefined
              ? runtimeExecutableRejectionCopy(
                  phase().rejection as WorkbenchRuntimeExecutableRejection,
                )
              : phase().status === "unavailable"
                ? runtimeExecutableCopy.unavailableSentence
                : phase().status === "cleared"
                  ? runtimeExecutableCopy.clearedSentence
                  : phase().status === "saved"
                    ? runtimeExecutableCopy.savedSentence
                    : ""}
          </p>
        )}
      </Show>
    </form>
  );
};

const ProviderCard: Component<{
  readonly row: WorkbenchRuntimeEndpointStatusRow;
  /**
   * Present only for subscription-authentication participants. Static-key
   * endpoints (GLM Coding Plan, Kimi Code, DeepSeek API) carry no
   * subscription binding: their card shows endpoint-discovery truth plus the
   * API-key management surface, in the same actions slot where subscription
   * rows place login controls.
   */
  readonly authentication: SettingsSubscriptionAuthenticationEntry | undefined;
  readonly endpointKeyPanels?: Partial<
    Record<WorkbenchEndpointKeyCopyEndpointId, WorkbenchEndpointKeyPanel>
  >;
  readonly catalogFreshness?: WorkbenchCatalogFreshnessPanel;
  readonly cliUpdate?: WorkbenchCliUpdatePanel;
  readonly executablePath?: string;
  readonly executablePhase?: SettingsRuntimeExecutablePhase;
  readonly onSaveExecutablePath?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly onBind?: (endpointId: WorkbenchRuntimeEndpointId) => void;
  readonly onBegin?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
    action: WorkbenchSubscriptionAuthenticationAction,
  ) => void;
  readonly onCancel?: (
    endpointId: WorkbenchRuntimeEndpointId,
    preparationKey: string,
  ) => void;
}> = (props) => {
  const headingId = () => `provider-${props.row.endpointId}-heading`;
  const availability = () =>
    settingsProviderAvailabilityPresentation(props.row.category);
  const endpointKeyPanel = ():
    | {
        readonly endpointId: WorkbenchEndpointKeyCopyEndpointId;
        readonly panel: WorkbenchEndpointKeyPanel;
      }
    | undefined => {
    const panels = props.endpointKeyPanels;
    if (panels === undefined) return undefined;
    const endpointId = props.row.endpointId as WorkbenchEndpointKeyCopyEndpointId;
    const panel = panels[endpointId];
    return panel === undefined ? undefined : { endpointId, panel };
  };
  const endpointFreshnessReport = ():
    | WorkbenchEndpointCatalogFreshnessReport
    | undefined =>
    props.catalogFreshness?.reports?.find(
      (report) => report.endpointId === props.row.endpointId,
    );
  const cliUpdateEntry = ():
    | {
        readonly cliId: WorkbenchCliUpdateCliId;
        readonly report: WorkbenchCliUpdateCheckReport | undefined;
      }
    | undefined => {
    const panel = props.cliUpdate;
    if (panel === undefined) return undefined;
    const cliId = cliIdForEndpoint(props.row.endpointId);
    if (cliId === undefined) return undefined;
    return Object.freeze({
      cliId,
      report: panel.reports?.find((report) => report.cliId === cliId),
    });
  };
  return (
    <section class="provider" aria-labelledby={headingId()}>
      <div class="provider-head">
        <span
          class={"rt-dot " + runtimeClass(props.row.runtimeFamilyLabel)}
          aria-hidden="true"
        />
        <div>
          <div
            id={headingId()}
            class={
              "ph-name " + runtimeClass(props.row.runtimeFamilyLabel)
            }
          >
            {props.row.runtimeFamilyLabel}
          </div>
          <div class="ph-sub">{props.row.endpointLabel}</div>
        </div>
        <span class={"badge " + availability().tone}>
          {availability().label}
        </span>
      </div>
      <div class="provider-body">
        <dl class="kv">
          <InspectorFact
            label={settingsCopy.statusFactLabel}
            value={props.row.statusLabel}
            tone={availability().tone}
          />
          <InspectorFact
            label={settingsCopy.catalogFactLabel}
            value={
              props.row.category === "catalog-ready"
                ? settingsCopy.catalogReadyValue
                : props.row.category === "not-inspected"
                  ? settingsCopy.notInspectedValue
                  : settingsCopy.catalogUnavailableValue
            }
            tone={props.row.category === "catalog-ready" ? "ok" : undefined}
          />
          <Show when={props.row.endpoint}>
            {(endpoint) => (
              <InspectorFact
                label={settingsCopy.modelsFactLabel}
                value={String(endpoint().models.length)}
                mono
              />
            )}
          </Show>
        </dl>
        <p class="provider-status-detail">{props.row.detail}</p>
        <Show when={props.row.lookup}>
          {(lookup) => (
            <div class="provider-lookup">
              <p class="provider-lookup-label">
                {runtimeLookupCopy.lookedForLabel}
              </p>
              <ul class="provider-lookup-list">
                <For each={lookup().places}>
                  {(place) => (
                    <li>{runtimeLookupPlaceCopy(place.names, place.location)}</li>
                  )}
                </For>
              </ul>
              <p class="provider-lookup-get">
                <span class="provider-lookup-get-label">
                  {runtimeLookupCopy.getItLabel}
                </span>{" "}
                <span class="provider-lookup-url">{lookup().installUrl}</span>
              </p>
              <RuntimeExecutableField
                runtime={props.row.runtime}
                value={props.executablePath ?? ""}
                phase={props.executablePhase}
                onSave={props.onSaveExecutablePath}
              />
            </div>
          )}
        </Show>
      </div>
      <div class="provider-actions">
        <Show when={props.authentication}>
          {(auth) => {
            const binding = () =>
              settingsSubscriptionAuthenticationPresentation(auth());
            return (
              <div class="provider-binding-copy">
                <span
                  class={`provider-binding-status ${binding().tone}`}
                  role="status"
                  aria-label={bindingStatusAriaCopy(props.row.runtimeFamilyLabel, binding().label)}
                >
                  <span>{settingsCopy.subscriptionSignIn}</span>
                  <strong>{binding().label}</strong>
                </span>
                <p>{binding().detail}</p>
                <Show when={binding().feedback}>
                  {(feedback) => (
                    <p class="provider-binding-feedback" role="status" aria-live="polite">
                      {feedback()}
                    </p>
                  )}
                </Show>
                <Show when={binding().blockedStatement}>
                  {(statement) => (
                    <div class="provider-auth-blockers" role="alert">
                      <p>{statement()}</p>
                      <ul>
                        <For each={binding().blockers}>
                          {(blocker) => (
                            <li>
                              {blocker.label}: {blocker.count}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </Show>
                <Show when={auth().confirmation}>
                  {(confirmation) => (
                    <div class="provider-auth-confirmation" role="group">
                      <p>
                        {settingsCopy.confirmationSentence}
                      </p>
                      <p>
                        {authConsequencesCopy(
                          confirmation().resumableSessionCount,
                          confirmation().projectCount,
                        )}
                      </p>
                      <div class="provider-auth-confirmation-actions">
                        <button
                          type="button"
                          class="btn sm"
                          disabled={props.onBegin === undefined}
                          onClick={() =>
                            props.onBegin?.(
                              props.row.endpointId,
                              confirmation().preparationKey,
                              confirmation().action,
                            )
                          }
                        >
                          {confirmation().action === "logout"
                            ? settingsCopy.confirmLogout
                            : settingsCopy.continueWithLogin}
                        </button>
                        <button
                          type="button"
                          class="btn ghost sm"
                          disabled={props.onCancel === undefined}
                          onClick={() =>
                            props.onCancel?.(
                              props.row.endpointId,
                              confirmation().preparationKey,
                            )
                          }
                        >
                          {commonCopy.cancel}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            );
          }}
        </Show>
        <Show when={endpointKeyPanel()}>
          {(entry) => (
            <EndpointKeyControls
              endpointId={entry().endpointId}
              panel={entry().panel}
            />
          )}
        </Show>
        <Show when={endpointFreshnessReport()}>
          {(report) => (
            <EndpointCatalogFreshnessControls
              report={report()}
              refreshing={props.catalogFreshness?.refreshing ?? false}
              onRefresh={() => props.catalogFreshness?.onRefresh()}
            />
          )}
        </Show>
        <Show when={cliUpdateEntry()}>
          {(entry) => (
            <CliUpdateControls
              cliId={entry().cliId}
              report={entry().report}
              phase={props.cliUpdate?.runPhase(entry().cliId) ?? idleCliUpdateRunPhase}
              checking={props.cliUpdate?.checking ?? false}
              relaunchPhase={
                props.cliUpdate?.relaunchPhase ?? idleCliUpdateRelaunchPhase
              }
              onUpdate={() => props.cliUpdate?.onUpdate(entry().cliId)}
              onRecheck={() => props.cliUpdate?.onRecheck()}
              onRestartNow={() => props.cliUpdate?.onRestartNow()}
              onAcknowledgeRestart={() =>
                props.cliUpdate?.onAcknowledgeRestart(entry().cliId)
              }
            />
          )}
        </Show>
        <div class="provider-binding-actions">
          <Show when={props.authentication}>
            {(auth) => {
              const binding = () =>
                settingsSubscriptionAuthenticationPresentation(auth());
              return (
                <Show when={auth().confirmation === null}>
                  <button
                    type="button"
                    class="btn sm"
                    disabled={
                      props.onBind === undefined ||
                      binding().pending ||
                      binding().inspectionPending ||
                      binding().blockedStatement !== null
                    }
                    aria-busy={binding().pending || binding().inspectionPending}
                    aria-label={bindActionAriaCopy(
                      binding().actionLabel,
                      props.row.runtimeFamilyLabel,
                    )}
                    onClick={() => props.onBind?.(props.row.endpointId)}
                  >
                    {binding().actionLabel}
                  </button>
                </Show>
              );
            }}
          </Show>
        </div>
      </div>
    </section>
  );
};

/**
 * Catalog-freshness surfacing for one static-key provider row (ticket 14 /
 * WO16 Part 3): "N new models available" with the id list — every entry
 * marked "new (untiered)" because auto-enrollment pins only the single
 * conservative `default` tier until the lane curates the real ones — plus
 * the manual refresh button. A silent pull failure renders one calm
 * sentence, never an error surface.
 */
const EndpointCatalogFreshnessControls: Component<{
  readonly report: WorkbenchEndpointCatalogFreshnessReport;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}> = (props) => {
  const copy = endpointCatalogFreshnessCopy;
  return (
    <div class="provider-binding-copy endpoint-catalog-freshness">
      <Show
        when={props.report.status === "fresh"}
        fallback={<p class="endpoint-catalog-freshness-silent">{copy.silentFailureSentence}</p>}
      >
        <Show when={props.report.newModels.length > 0}>
          <p
            class="endpoint-catalog-freshness-new"
            role="status"
          >
            {copy.newModelsHeading(props.report.newModels.length)}
          </p>
          <ul class="endpoint-catalog-freshness-list">
            <For each={props.report.newModels}>
              {(entry) => <li>{copy.newModelsItem(entry)}</li>}
            </For>
          </ul>
        </Show>
        <Show when={props.report.newModels.length === 0 && props.report.enrolledModels.length > 0}>
          <p class="endpoint-catalog-freshness-enrolled">
            {copy.enrolledListLabel}
          </p>
          <ul class="endpoint-catalog-freshness-list">
            <For each={props.report.enrolledModels}>
              {(entry) => <li>{copy.newModelsItem(entry)}</li>}
            </For>
          </ul>
        </Show>
      </Show>
      <div class="provider-binding-actions endpoint-catalog-freshness-actions">
        <button
          type="button"
          class="btn ghost sm"
          disabled={props.refreshing}
          aria-busy={props.refreshing}
          onClick={() => props.onRefresh()}
        >
          {props.refreshing ? copy.refreshingAction : copy.refreshAction}
        </button>
      </div>
    </div>
  );
};

/**
 * CLI update block for one provider row (ticket 18; 副主管裁决): claude's
 * update button appears only when the read-only check found a newer version
 * (a check failure renders a retry instead of inventing a version);
 * codex has no read-only check, so its button is the explicit
 * "check and update" action and is always present. Runs happen only on
 * this button, never automatically. Progress, success (with the restart
 * reminder, its "Restart now" and its "Not now") and failure render inline.
 * Every failure state carries only its own conclusion; none invents a file
 * lock or another cause the command did not establish.
 *
 * A failed check displays "Check for updates again" without a version claim. Main
 * retries failures and memoizes confirmed checks. Restart uses main's drain.
 */
const CliUpdateControls: Component<{
  readonly cliId: WorkbenchCliUpdateCliId;
  readonly report: WorkbenchCliUpdateCheckReport | undefined;
  readonly phase: WorkbenchCliUpdateRunPhase;
  readonly checking: boolean;
  readonly relaunchPhase: WorkbenchCliUpdateRelaunchPhase;
  readonly onUpdate: () => void;
  readonly onRecheck: () => void;
  readonly onRestartNow: () => void;
  readonly onAcknowledgeRestart: () => void;
}> = (props) => {
  const copy = cliUpdateCopy;
  const running = () => props.phase.kind === "running";
  const availableSentence = (): string | null => {
    if (props.cliId !== "claude-code") return null;
    const report = props.report;
    if (report === undefined || report.status !== "update-available") {
      return null;
    }
    return copy.updateAvailableSentence(
      report.currentVersion,
      report.availableVersion,
    );
  };
  const failureLead = (): string | null => {
    if (props.phase.kind !== "failed") return null;
    switch (props.phase.reason) {
      case "timeout":
        return copy.failedTimeoutSentence;
      case "launch-failed":
        return copy.failedLaunchSentence;
      case "unsupported-install":
        return copy.failedUnsupportedInstallSentence;
      case "no-change":
        return copy.failedNoChangeSentence;
      case "result-unknown":
        return copy.failedResultUnknownSentence;
      default:
        return copy.failedUpdateSentence;
    }
  };
  const actionLabel = (): string =>
    props.cliId === "claude-code" ? copy.updateAction : copy.checkAndUpdateAction;
  const buttonVisible = (): boolean => {
    if (props.cliId === "codex") return true;
    return props.report?.status === "update-available";
  };
  // claude's check is the only one that can fail (codex has no read-only
  // check to fail). When it does, the row must not go blank: the update
  // button is correctly absent -- there is no known newer version to
  // install -- so the retry takes its place rather than leaving nothing.
  const checkFailed = (): boolean =>
    props.cliId === "claude-code" && props.report?.status === "check-failed";
  const restarting = (): boolean => props.relaunchPhase.kind === "requesting";
  /*
   * w120. codex has no read-only check, so its button is the action itself and
   * pressing it starts a non-interactive install. Asking first is the whole
   * point: the row now says what will happen, and the press that begins it is
   * a second, deliberate one. claude keeps its existing single-press flow —
   * there the row already states the version it is moving to.
   */
  const [confirming, setConfirming] = createSignal(false);
  const needsConfirmation = (): boolean => props.cliId === "codex";
  const beforeSentences = (): readonly string[] =>
    props.cliId === "codex" && props.phase.kind === "idle"
      ? [copy.codexActionSentence, copy.codexVersionUnknownSentence]
      : [];
  return (
    <div class="provider-binding-copy cli-update">
      <For each={beforeSentences()}>
        {(sentence) => <p class="provider-binding-feedback">{sentence}</p>}
      </For>
      <Show when={availableSentence()}>
        {(sentence) => (
          <p class="provider-binding-feedback" role="status">
            {sentence()}
          </p>
        )}
      </Show>
      <Show when={props.phase.kind === "succeeded"}>
        <p class="provider-binding-feedback" role="status">
          {copy.succeededSentence}
        </p>
      </Show>
      <Show when={failureLead()}>
        {(lead) => (
          <>
            <p class="provider-binding-feedback" role="alert">
              {lead()}
            </p>
          </>
        )}
      </Show>
      <Show when={props.phase.kind === "unavailable"}>
        <p class="provider-binding-feedback" role="alert">
          {copy.unavailableSentence}
        </p>
      </Show>
      <Show when={checkFailed()}>
        <p class="provider-binding-feedback" role="alert">
          {copy.checkFailedSentence}
        </p>
      </Show>
      <Show when={props.relaunchPhase.kind === "failed"}>
        <p class="provider-binding-feedback" role="alert">
          {copy.relaunchFailedSentence}
        </p>
      </Show>
      <Show when={confirming()}>
        <p class="provider-binding-feedback cli-update-confirm" role="alert">
          {copy.confirmUpdateQuestion}
        </p>
      </Show>
      <div class="provider-binding-actions cli-update-actions">
        <Show when={buttonVisible() && !confirming()}>
          <button
            type="button"
            class="btn ghost sm"
            disabled={running()}
            aria-busy={running()}
            onClick={() => {
              if (needsConfirmation()) {
                setConfirming(true);
                return;
              }
              props.onUpdate();
            }}
          >
            {running() ? copy.runningAction : actionLabel()}
          </button>
        </Show>
        <Show when={confirming()}>
          <button
            type="button"
            class="btn sm"
            disabled={running()}
            aria-busy={running()}
            onClick={() => {
              setConfirming(false);
              props.onUpdate();
            }}
          >
            {copy.confirmUpdateAction}
          </button>
          <button
            type="button"
            class="btn ghost sm"
            onClick={() => setConfirming(false)}
          >
            {copy.cancelUpdateAction}
          </button>
        </Show>
        <Show when={checkFailed()}>
          <button
            type="button"
            class="btn ghost sm"
            disabled={props.checking}
            aria-busy={props.checking}
            onClick={() => props.onRecheck()}
          >
            {props.checking ? copy.checkingAction : copy.checkAgainAction}
          </button>
        </Show>
        <Show when={props.phase.kind === "succeeded"}>
          <button
            type="button"
            class="btn ghost sm"
            disabled={restarting()}
            aria-busy={restarting()}
            onClick={() => props.onRestartNow()}
          >
            {restarting() ? copy.restartingAction : copy.restartNowAction}
          </button>
          <button
            type="button"
            class="btn ghost sm"
            onClick={() => props.onAcknowledgeRestart()}
          >
            {copy.restartLaterAction}
          </button>
        </Show>
      </div>
    </div>
  );
};

/**
 * API-key management surface for one static-key provider row (ADR 0022; WO16
 * Part 1 generalized the GLM-only block — GLM, Kimi and DeepSeek render the
 * same structure). Rendered only inside its provider row's provider-actions
 * slot, in the position where subscription rows place their binding copy and
 * login controls: the key entry occupies the login-control position, and the
 * DPAPI disclosure sentences travel with it. The row head names the provider,
 * so this block carries no heading of its own — but both halves of the
 * protection truth stay (offline disk inspection / same-account processes),
 * and a provider with special key-handling rules (Kimi: shown once, at most 5
 * keys) states them here.
 */
const EndpointKeyControls: Component<{
  readonly endpointId: WorkbenchEndpointKeyCopyEndpointId;
  readonly panel: WorkbenchEndpointKeyPanel;
}> = (props) => {
  const copy = () => workbenchEndpointKeyCopy(props.endpointId);
  const inputId = () => `endpoint-key-input-${props.endpointId}`;
  const status = () => props.panel.snapshot;
  const busy = () => props.panel.busy;
  const ready = () => props.panel.phase === "ready" && status() !== null;
  const statusLabel = () =>
    props.panel.phase === "hydrating"
      ? copy().statusLoadingLabel
      : props.panel.phase === "unavailable"
        ? copy().unavailableSentence
        : status()?.configured === true
          ? `${copy().configuredLabel} · ${status()!.maskedHint}`
          : copy().notConfiguredLabel;
  const statusTone = () =>
    props.panel.phase === "ready" && status()?.configured === true
      ? "ok"
      : "warn";
  const keyHandlingWarning = () => {
    const warning = copy().keyHandlingWarning;
    return warning === undefined ? null : warning;
  };
  const probeSentence = () => {
    const outcome = props.panel.probeOutcome;
    if (outcome === null) return null;
    if (outcome.outcome === "success") {
      return copy().probeSuccessLabel;
    }
    switch (outcome.reason) {
      case "unauthorized":
        return copy().probeUnauthorizedLabel;
      case "endpoint-error":
        return copy().probeEndpointErrorLabel;
      case "server-error":
        return copy().probeServerErrorLabel;
      case "network":
        return copy().probeNetworkLabel;
      case "timeout":
        return copy().probeTimeoutLabel;
      case "token-missing":
        return copy().probeTokenMissingLabel;
      case "invalid-base-url":
        return copy().probeInvalidBaseUrlLabel;
    }
  };
  const feedbackSentence = () => {
    switch (props.panel.feedback) {
      case "save-invalid":
        return copy().saveInvalidSentence;
      case null:
        return null;
      default:
        return copy().unavailableSentence;
    }
  };
  return (
    <>
      <div class="provider-binding-copy endpoint-key-copy">
        <span
          class={`provider-binding-status endpoint-key-status ${statusTone()}`}
          role="status"
        >
          <span>{copy().keyValueLabel}</span>
          <strong>{statusLabel()}</strong>
        </span>
        <p>{copy().lede}</p>
        <p>{copy().storageSentence}</p>
        <p>{copy().protectionSentence}</p>
        <Show when={keyHandlingWarning()}>
          {(warning) => <p class="endpoint-key-handling-warning">{warning()}</p>}
        </Show>
        <Show when={ready()}>
          <p class="endpoint-key-persistence">
            {status()!.isPersistent
              ? copy().persistentLabel
              : copy().sessionOnlyLabel}
          </p>
          <Show when={status()!.environmentFallback}>
            <p class="endpoint-key-fallback">
              {copy().environmentFallbackLabel}
            </p>
          </Show>
          <Show when={props.panel.revealed && props.panel.revealedValue !== null}>
            <p class="endpoint-key-revealed">
              <code>{props.panel.revealedValue}</code>
            </p>
          </Show>
          <Show when={probeSentence()}>
            {(sentence) => (
              <p class="endpoint-key-probe" role="status">
                {sentence()}
              </p>
            )}
          </Show>
          <Show when={feedbackSentence()}>
            {(sentence) => (
              <p class="endpoint-key-feedback" role="alert">
                {sentence()}
              </p>
            )}
          </Show>
        </Show>
      </div>
      <Show when={ready()}>
        <div class="endpoint-key-controls">
          <div class="endpoint-key-entry">
            <label for={inputId()}>{copy().keyValueLabel}</label>
            <input
              id={inputId()}
              type="password"
              autocomplete="off"
              spellcheck={false}
              placeholder={copy().keyValuePlaceholder}
              value={props.panel.draft}
              disabled={busy() !== null}
              onInput={(event) => props.panel.onDraft(event.currentTarget.value)}
            />
          </div>
          <div class="provider-binding-actions endpoint-key-actions">
            <button
              type="button"
              class="btn sm"
              disabled={busy() !== null}
              onClick={() => props.panel.onSave()}
            >
              {copy().saveAction}
            </button>
            <button
              type="button"
              class="btn ghost sm"
              disabled={busy() !== null || status()!.configured !== true}
              aria-pressed={props.panel.revealed}
              onClick={() =>
                props.panel.revealed
                  ? props.panel.onHideReveal()
                  : props.panel.onReveal()
              }
            >
              {props.panel.revealed
                ? copy().hideRevealAction
                : copy().revealAction}
            </button>
            <button
              type="button"
              class="btn ghost sm"
              disabled={busy() !== null || status()!.configured !== true}
              onClick={() => props.panel.onRemove()}
            >
              {copy().removeAction}
            </button>
            <button
              type="button"
              class="btn ghost sm"
              disabled={busy() !== null}
              aria-busy={busy() === "probe"}
              onClick={() => props.panel.onProbe()}
            >
              {copy().probeAction}
            </button>
          </div>
        </div>
      </Show>
    </>
  );
};
