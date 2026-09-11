import { SettingsUsage } from "./settings-usage.tsx";
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
  type Component,
} from "solid-js";
import {
  type WorkbenchBaseUrlEndpointId,
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
import type { WorkbenchEndpointBaseUrlPanel } from "./endpoint-base-url-state.ts";
import {
  directEndpointStatusRows,
  directFacadeEndpointStatusRows,
  workbenchFacadeFamilyOfEndpointId,
  type WorkbenchDirectProfileState,
  type WorkbenchRuntimeEndpointStatusRow,
} from "./view-model.ts";
import {
  appearancePersistencePresentation,
  initialSettingsSubscriptionAuthenticationState,
  orderSettingsProviderRows,
  settingsProviderBadgePresentation,
  settingsSubscriptionAuthenticationPresentation,
  isPrivateCliInstallPath,
  type SettingsRuntimeExecutablePhase,
  type SettingsRuntimeInstallPhase,
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
  runtimeInstallCopy,
  runtimeInstallStepCopy,
  runtimeLookupCopy,
  runtimeLookupPlaceCopy,
} from "./copy/runtime-lookup-copy.ts";
import {
  settingsCopy,
  subscriptionAuthCopy,
  bindingStatusAriaCopy,
  bindActionAriaCopy,
  authConsequencesCopy,
  endpointCatalogFreshnessCopy,
  cliUpdateCopy,
  familyFacadeCopy,
  toolsCopy,
  workbenchEndpointKeyCopy,
  workbenchBaseUrlCopy,
  type WorkbenchEndpointKeyCopyEndpointId,
} from "./copy/settings-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import { defaultWorkbenchFamilyEndpointPreferences } from "../contract.ts";
import { WorkbenchRendererBridgeContext } from "./view-types.ts";

/**
 * The sign-in link the provider CLI printed, shown verbatim and copyable.
 *
 * Rendered ONLY when a URL was actually received -- the caller's `Show` is the
 * whole gate. There is deliberately no "waiting for sign-in" state here: the
 * Workbench spawns the CLI with its console hidden and cannot observe whether a
 * browser opened, so anything beyond "here is what the CLI printed" would be a
 * claim about something it never saw.
 *
 * The value is an OAuth authorisation URL and generally carries a single-use
 * code, so it is displayed and copied and nothing else: it is never logged and
 * never persisted. It is not rendered as an anchor -- the shell has no in-app
 * navigation for it, and handing a live credential to whatever would handle a
 * click is not worth the convenience of one.
 */
const SubscriptionSignInLink: Component<{ readonly url: string }> = (props) => {
  const bridge = useContext(WorkbenchRendererBridgeContext);
  const [phase, setPhase] = createSignal<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const label = () =>
    phase() === "copying"
      ? subscriptionAuthCopy.signInUrlCopyingAction
      : phase() === "copied"
        ? subscriptionAuthCopy.signInUrlCopiedAction
        : phase() === "failed"
          ? subscriptionAuthCopy.signInUrlCopyFailedAction
          : subscriptionAuthCopy.signInUrlCopyAction;
  const copyLink = (): void => {
    let write: Promise<boolean> | undefined;
    try {
      const writeClipboardText = bridge?.writeClipboardText;
      write =
        writeClipboardText === undefined
          ? navigator.clipboard?.writeText(props.url).then(() => true)
          : writeClipboardText(props.url).then((result) => result.ok);
    } catch {
      setPhase("failed");
      return;
    }
    if (write === undefined) {
      setPhase("failed");
      return;
    }
    setPhase("copying");
    void write.then(
      (copied) => setPhase(copied ? "copied" : "failed"),
      () => setPhase("failed"),
    );
  };
  return (
    <div class="provider-auth-signin-url" role="group">
      <p class="provider-auth-signin-url-heading">
        {subscriptionAuthCopy.signInUrlHeading}
      </p>
      <p>{subscriptionAuthCopy.signInUrlSentence}</p>
      <code class="provider-auth-signin-url-value">{props.url}</code>
      <button
        type="button"
        class="btn ghost sm provider-auth-signin-url-copy"
        aria-label={subscriptionAuthCopy.signInUrlCopyAria}
        aria-busy={phase() === "copying"}
        onClick={copyLink}
      >
        <span aria-live="polite">{label()}</span>
      </button>
    </div>
  );
};

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


/**
 * The family cards' segment labels: the two sides of Codex, Claude and Kimi.
 * Read from the same identity copy the status rows use, so a segment can never
 * name a backend differently from its own row.
 */
const FAMILY_SEGMENT_COPY_KEY: Readonly<
  Partial<Record<WorkbenchRuntimeEndpointId, keyof typeof endpointIdentityCopy>>
> = Object.freeze({
  "codex-desktop": "codex",
  "codex-api": "codexApi",
  "claude-code-desktop": "claude",
  "claude-api": "claudeApi",
  "kimi-code": "kimi",
  "kimi-platform": "kimiPlatform",
});

function segmentLabel(endpointId: WorkbenchRuntimeEndpointId): string {
  const key = FAMILY_SEGMENT_COPY_KEY[endpointId];
  return key === undefined ? endpointId : endpointIdentityCopy[key].endpointLabel;
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
  readonly runtimeInstallPhases?: Readonly<
    Partial<Record<WorkbenchConfigurableRuntime, SettingsRuntimeInstallPhase>>
  >;
  readonly onInstallRuntimeExecutable?: (
    runtime: WorkbenchConfigurableRuntime,
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
   * The GLM / DeepSeek / Kimi Code / Codex · API cards' "Base URL (optional)"
   * field (ticket 21/w223 shipped Codex · API alone; w232 generalizes to all
   * four). Present only when the bridge exposes the base-url channels for
   * that endpoint; rendered below each endpoint's API key row (Kimi Code:
   * only on the Code segment of the merged Kimi card).
   */
  readonly endpointBaseUrlPanels?: Partial<
    Record<WorkbenchBaseUrlEndpointId, WorkbenchEndpointBaseUrlPanel>
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
  // One card per provider in the owner's fixed order (w233): Codex, Claude,
  // GLM, DeepSeek, Kimi. A status change recolours a badge; it never moves a
  // card.
  const endpointRows = () =>
    orderSettingsProviderRows(
      directFacadeEndpointStatusRows(
        props.profile,
        endpointPreferences(),
        props.subscriptionAuthentication,
      ),
    );
  /** Raw per-backend rows feeding each merged family card's two sides. */
  const familySideRows = (): FamilySideRows => {
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
  /**
   * The Tools section (w233 step 2) describes the two CLIs, not the
   * providers: each row reads the desktop endpoint's discovery row for what
   * the lookup found, and the CLI update report for the version.
   */
  const toolRow = (
    endpointId: "claude-code-desktop" | "codex-desktop",
  ): WorkbenchRuntimeEndpointStatusRow | undefined =>
    directEndpointStatusRows(props.profile).find(
      (row) => row.endpointId === endpointId,
    );
  // Where the Data recovery card goes (w233): above Providers only while there
  // is something to review or act on. A machine whose recovery could not be
  // prepared -- every fresh install -- gets one muted line at the foot instead
  // of a red alert as the first thing on the page. The card's own visibility
  // gate and its logic are untouched.
  const recoveryUnavailable = () =>
    props.historyRecoveryResult?.status === "unavailable";
  const recoveryFootSentence = (): string | null => {
    const result = props.historyRecoveryResult;
    return result?.status === "unavailable"
      ? dynamicCopy.historyProblem[result.problem.code]
      : null;
  };
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

          {/* Appearance first (w233): language and tone are the first thing a
              new user changes, and putting them first costs no navigation
              machinery -- the alternative was a sticky mini-nav. */}
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

          <Show when={!recoveryUnavailable()}>
            <HistoryRecoverySettingsCard
              bridge={props.historyRecoveryBridge ?? Object.freeze({})}
              result={props.historyRecoveryResult ?? null}
              onSnapshot={
                props.onHistoryRecoverySnapshot ?? (() => undefined)
              }
              onRefresh={props.onRefreshHistoryRecovery ?? (() => undefined)}
            />
          </Show>

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
            <div class="providers-policy">
              <p class="providers-policy-line">{settingsCopy.credentialHeading}</p>
              <details class="settings-details">
                <summary>{settingsCopy.detailsSummary}</summary>
                <p>{settingsCopy.credentialSentence}</p>
              </details>
            </div>

            <div class="provider-endpoint-list">
              <For each={endpointRows()}>
                {(row) => {
                  const family = workbenchFacadeFamilyOfEndpointId(row.endpointId);
                  return (
                    <ProviderCard
                      row={row}
                      family={family}
                      sides={family === undefined ? undefined : familySideRows()[family]}
                      preference={
                        family === undefined ? undefined : endpointPreferences()[family]
                      }
                      onPreference={props.onEndpointPreference}
                      authentication={
                        authentication()[
                          family === "claude"
                            ? "claude-code-desktop"
                            : family === "codex"
                              ? "codex-desktop"
                              : row.endpointId
                        ]
                      }
                      endpointKeyPanels={props.endpointKeyPanels}
                      endpointBaseUrlPanels={props.endpointBaseUrlPanels}
                      catalogFreshness={props.catalogFreshness}
                      onBind={props.onBindSubscriptionAuthentication}
                      onBegin={props.onBeginSubscriptionAuthentication}
                      onCancel={props.onCancelSubscriptionAuthentication}
                    />
                  );
                }}
              </For>
            </div>
          </section>

          <div class="section-head tools-section-head">
            <h2 id="tools-title">{toolsCopy.heading}</h2>
          </div>
          <section class="tools-settings" aria-labelledby="tools-title">
            <ToolRow
              cliId="claude-code"
              runtime="claude"
              row={toolRow("claude-code-desktop")}
              executablePath={props.runtimeExecutables?.claude}
              executablePhase={props.runtimeExecutablePhases?.claude}
              onSaveExecutablePath={props.onSaveRuntimeExecutable}
              installPhase={props.runtimeInstallPhases?.claude}
              onInstallExecutable={props.onInstallRuntimeExecutable}
              cliUpdate={cliUpdatePanel()}
            />
            <ToolRow
              cliId="codex"
              runtime="codex"
              row={toolRow("codex-desktop")}
              executablePath={props.runtimeExecutables?.codex}
              executablePhase={props.runtimeExecutablePhases?.codex}
              onSaveExecutablePath={props.onSaveRuntimeExecutable}
              installPhase={props.runtimeInstallPhases?.codex}
              onInstallExecutable={props.onInstallRuntimeExecutable}
              cliUpdate={cliUpdatePanel()}
            />
          </section>

          {/* Usage slot: hangs after Providers and Tools. The component is
              w234's; nothing here reaches inside it. */}
          <SettingsUsage bridge={props.historyRecoveryBridge} />

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

          <Show when={recoveryFootSentence()}>
            {(sentence) => (
              <p class="settings-foot-note">
                {settingsCopy.recoveryFootLabel} · {sentence()}
              </p>
            )}
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

/**
 * One provider card (w233): the same shape for all five providers. A family
 * card (Codex, Claude, Kimi -- tickets 20/25) adds one segment switch for its
 * two backends; the switch is also the persisted manual preference that
 * orders the facade's automatic resolution. The head carries one plain-words
 * badge for the side being shown; the discovery facts and the detail
 * sentence sit behind "Details". The actions strip keeps the subscription
 * login controls, the API-key block and the catalog freshness controls. The
 * optional base URL sits behind its own Details disclosure instead of
 * competing with Save key. Everything about the CLI itself -- version, path,
 * install, update -- lives in the Tools section (step 2); a card whose CLI is
 * missing says so in one line and takes the reader there.
 */
const ProviderCard: Component<{
  readonly row: WorkbenchRuntimeEndpointStatusRow;
  readonly family?: WorkbenchEndpointFamilyId;
  readonly sides?: Readonly<
    Partial<
      Record<WorkbenchRuntimeEndpointId, WorkbenchRuntimeEndpointStatusRow>
    >
  >;
  readonly preference?: WorkbenchRuntimeEndpointId;
  readonly onPreference?: (
    preference: WorkbenchFamilyEndpointPreference,
  ) => void;
  /**
   * Present only for subscription-authentication participants (the desktop
   * side of Codex and Claude). Static-key endpoints carry no subscription
   * binding: their card shows the API-key management surface in the same
   * actions slot where subscription rows place login controls.
   */
  readonly authentication?: SettingsSubscriptionAuthenticationEntry;
  readonly endpointKeyPanels?: Partial<
    Record<WorkbenchEndpointKeyCopyEndpointId, WorkbenchEndpointKeyPanel>
  >;
  readonly endpointBaseUrlPanels?: Partial<
    Record<WorkbenchBaseUrlEndpointId, WorkbenchEndpointBaseUrlPanel>
  >;
  readonly catalogFreshness?: WorkbenchCatalogFreshnessPanel;
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
    props.family === undefined
      ? `provider-${props.row.endpointId}-heading`
      : `provider-${props.family}-heading`;
  const segments = (): readonly WorkbenchFamilyEndpointPreference[] =>
    props.family === "claude"
      ? ["claude-code-desktop", "claude-api"]
      : props.family === "codex"
        ? ["codex-desktop", "codex-api"]
        : props.family === "kimi"
          ? ["kimi-code", "kimi-platform"]
          : [];
  /** The side on screen: the family preference, or the row itself. */
  const activeEndpointId = (): WorkbenchRuntimeEndpointId =>
    props.family === undefined
      ? props.row.endpointId
      : (props.preference ?? segments()[0]!);
  const activeRow = (): WorkbenchRuntimeEndpointStatusRow =>
    props.sides?.[activeEndpointId()] ?? props.row;
  const subscriptionSide = () => cliIdForEndpoint(activeEndpointId()) !== undefined;
  const badge = () =>
    settingsProviderBadgePresentation(activeRow().category, activeEndpointId());
  /** The CLI this side runs on is missing: one line, and Tools has the rest. */
  const toolsHint = (): string | null =>
    activeRow().category === "runtime-not-located"
      ? toolsCopy.providerHint(
          props.row.runtime === "codex" ? toolsCopy.codexName : toolsCopy.claudeName,
        )
      : null;
  const authenticationEntry = () =>
    subscriptionSide() ? props.authentication : undefined;
  const binding = () => {
    const entry = authenticationEntry();
    return entry === undefined
      ? undefined
      : settingsSubscriptionAuthenticationPresentation(entry);
  };
  const endpointKeyPanel = ():
    | {
        readonly endpointId: WorkbenchEndpointKeyCopyEndpointId;
        readonly panel: WorkbenchEndpointKeyPanel;
      }
    | undefined => {
    const panels = props.endpointKeyPanels;
    if (panels === undefined || subscriptionSide()) return undefined;
    const endpointId = activeEndpointId() as WorkbenchEndpointKeyCopyEndpointId;
    const panel = panels[endpointId];
    return panel === undefined ? undefined : { endpointId, panel };
  };
  // The base-URL field (w232) is keyed by the endpoint on screen: GLM,
  // DeepSeek, Kimi Code and Codex · API carry one; the subscription sides,
  // Claude · API and Kimi Platform have no entry and so render nothing.
  const endpointBaseUrlPanel = (): WorkbenchEndpointBaseUrlPanel | undefined =>
    props.endpointBaseUrlPanels?.[activeEndpointId() as WorkbenchBaseUrlEndpointId];
  // Catalog freshness is enrolled only for GLM and DeepSeek; Kimi Code has no
  // verified zero-inference models-list route, and claude-api/codex-api are not
  // enrolled -- so the lookup simply finds nothing for those.
  const endpointFreshnessReport = ():
    | WorkbenchEndpointCatalogFreshnessReport
    | undefined =>
    props.catalogFreshness?.reports?.find(
      (report) => report.endpointId === activeEndpointId(),
    );
  return (
    <section
      class={props.family === undefined ? "provider" : `provider provider-${props.family}`}
      aria-labelledby={headingId()}
    >
      <div class="provider-head">
        <span
          class={"rt-dot " + runtimeClass(props.row.runtimeFamilyLabel)}
          aria-hidden="true"
        />
        <div>
          <div
            id={headingId()}
            class={"ph-name " + runtimeClass(props.row.runtimeFamilyLabel)}
          >
            {props.row.runtimeFamilyLabel}
          </div>
          <div class="ph-sub">{activeRow().endpointLabel}</div>
        </div>
        <span class={"badge " + badge().tone} title={activeRow().statusLabel}>
          {badge().label}
        </span>
      </div>
      <div class="provider-body">
        <Show when={props.family !== undefined}>
          <div
            class="provider-segments"
            role="group"
            aria-label={familyFacadeCopy.segmentsLabel(props.row.runtimeFamilyLabel)}
          >
            <For each={segments()}>
              {(backend) => (
                <button
                  type="button"
                  class="btn sm provider-segment"
                  classList={{ ghost: activeEndpointId() !== backend }}
                  aria-pressed={activeEndpointId() === backend}
                  onClick={() => props.onPreference?.(backend)}
                >
                  {segmentLabel(backend)}
                </button>
              )}
            </For>
          </div>
        </Show>
        <details class="settings-details provider-details">
          <summary>{settingsCopy.detailsSummary}</summary>
          <dl class="kv">
            <InspectorFact
              label={settingsCopy.statusFactLabel}
              value={activeRow().statusLabel}
              tone={badge().tone}
            />
            <InspectorFact
              label={settingsCopy.catalogFactLabel}
              value={
                activeRow().category === "catalog-ready"
                  ? settingsCopy.catalogReadyValue
                  : activeRow().category === "not-inspected"
                    ? settingsCopy.notInspectedValue
                    : settingsCopy.catalogUnavailableValue
              }
              tone={activeRow().category === "catalog-ready" ? "ok" : undefined}
            />
            <Show when={activeRow().endpoint}>
              {(endpoint) => (
                <InspectorFact
                  label={settingsCopy.modelsFactLabel}
                  value={String(endpoint().models.length)}
                  mono
                />
              )}
            </Show>
          </dl>
          <p class="provider-status-detail">{activeRow().detail}</p>
        </details>
        <Show when={toolsHint()}>
          {(hint) => <p class="provider-tools-hint">{hint()}</p>}
        </Show>
      </div>
      <div class="provider-actions">
        <Show when={binding()}>
          {(bindingValue) => {
            const entry = () => authenticationEntry()!;
            return (
              <div class="provider-binding-copy">
                <span
                  class={`provider-binding-status ${bindingValue().tone}`}
                  role="status"
                  aria-label={bindingStatusAriaCopy(
                    props.row.runtimeFamilyLabel,
                    bindingValue().label,
                  )}
                >
                  <span>{settingsCopy.subscriptionSignIn}</span>
                  <strong>{bindingValue().label}</strong>
                </span>
                <p>{bindingValue().detail}</p>
                <Show when={bindingValue().feedback}>
                  {(feedback) => (
                    <p class="provider-binding-feedback" role="status" aria-live="polite">
                      {feedback()}
                    </p>
                  )}
                </Show>
                <Show when={entry().signInUrl}>
                  {(url) => <SubscriptionSignInLink url={url()} />}
                </Show>
                <Show when={bindingValue().blockedStatement}>
                  {(statement) => (
                    <div class="provider-auth-blockers" role="alert">
                      <p>{statement()}</p>
                      <ul>
                        <For each={bindingValue().blockers}>
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
                <Show when={entry().confirmation}>
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
                              activeEndpointId(),
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
                              activeEndpointId(),
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
                  <Show when={entry().confirmation === null}>
                    <Show
                      when={activeRow().category === "runtime-not-located"}
                      fallback={
                        <button
                          type="button"
                          class="btn sm"
                          disabled={
                            props.onBind === undefined ||
                            bindingValue().pending ||
                            bindingValue().inspectionPending ||
                            bindingValue().blockedStatement !== null
                          }
                          aria-busy={
                            bindingValue().pending || bindingValue().inspectionPending
                          }
                          aria-label={bindActionAriaCopy(
                            bindingValue().actionLabel,
                            props.row.runtimeFamilyLabel,
                          )}
                          onClick={() => props.onBind?.(activeEndpointId())}
                        >
                          {bindingValue().actionLabel}
                        </button>
                      }
                    >
                      <a class="btn sm" href={`#tool-${activeRow().runtime}`}>
                        {toolsCopy.goToInstallAction}
                      </a>
                    </Show>
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
        <Show when={endpointBaseUrlPanel()}>
          {(panel) => (
            <EndpointBaseUrlControls
              endpointId={activeEndpointId() as WorkbenchBaseUrlEndpointId}
              panel={panel()}
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
 * One CLI in the Tools section (w233 step 2): what the lookup found, the
 * version when something actually reported one, the product's own install,
 * the update block (ticket 18 semantics unchanged) and, behind "Custom path",
 * the typed-path escape hatch. This is the only place these render; the
 * provider cards point here.
 */
const ToolRow: Component<{
  readonly cliId: WorkbenchCliUpdateCliId;
  readonly runtime: WorkbenchConfigurableRuntime;
  /** The desktop endpoint's discovery row; absent when the roster lacks it. */
  readonly row?: WorkbenchRuntimeEndpointStatusRow;
  readonly executablePath?: string;
  readonly executablePhase?: SettingsRuntimeExecutablePhase;
  readonly onSaveExecutablePath?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
  readonly installPhase?: SettingsRuntimeInstallPhase;
  readonly onInstallExecutable?: (runtime: WorkbenchConfigurableRuntime) => void;
  readonly cliUpdate?: WorkbenchCliUpdatePanel;
}> = (props) => {
  const name = () =>
    props.runtime === "codex" ? toolsCopy.codexName : toolsCopy.claudeName;
  const familyLabel = () => (props.runtime === "codex" ? "Codex" : "Claude");
  const headingId = () => `tool-${props.runtime}-heading`;
  const configuredPath = () => props.executablePath ?? "";
  const report = () =>
    props.cliUpdate?.reports?.find((entry) => entry.cliId === props.cliId);
  // Only a value somebody actually returned: the update check's current
  // version, or the version the product's own install read back.
  const version = (): string => {
    const installed = props.installPhase;
    if (installed?.status === "installed") return installed.version;
    const checked = report();
    if (checked?.status === "update-available") return checked.currentVersion;
    return toolsCopy.versionUnknown;
  };
  const presence = (): { readonly label: string; readonly tone: "ok" | "warn" | "off" } => {
    if (props.installPhase?.status === "installed" || isPrivateCliInstallPath(configuredPath())) {
      return { label: toolsCopy.found, tone: "ok" };
    }
    switch (props.row?.category) {
      case "runtime-not-located":
        return { label: toolsCopy.notFound, tone: "warn" };
      case "inspection-failed":
        return { label: toolsCopy.checkFailed, tone: "warn" };
      case "not-inspected":
      case undefined:
        return { label: toolsCopy.notChecked, tone: "off" };
      default:
        return { label: toolsCopy.found, tone: "ok" };
    }
  };
  const lookup = () => props.row?.lookup ?? undefined;
  const saving = () => props.executablePhase?.status === "saving";
  const installing = () => props.installPhase?.status === "installing";
  return (
    <section
      id={`tool-${props.runtime}`}
      class={`provider tool-row tool-${props.runtime}`}
      aria-labelledby={headingId()}
    >
      <div class="provider-head">
        <span class={"rt-dot " + runtimeClass(familyLabel())} aria-hidden="true" />
        <div>
          <div id={headingId()} class={"ph-name " + runtimeClass(familyLabel())}>
            {name()}
          </div>
          <div class="ph-sub">
            {toolsCopy.versionLabel} {version()}
            <Show when={configuredPath().trim().length > 0}>
              {" · "}
              <span class="tool-path">{configuredPath()}</span>
            </Show>
          </div>
        </div>
        <span class={"badge " + presence().tone} title={props.row?.statusLabel}>
          {presence().label}
        </span>
      </div>
      <div class="provider-body">
        <Show when={props.onInstallExecutable}>
          {(onInstall) => (
            <RuntimeInstallControl
              runtime={props.runtime}
              configuredPath={configuredPath()}
              phase={props.installPhase}
              disabled={saving() || installing()}
              onInstall={onInstall()}
            />
          )}
        </Show>
        <details class="settings-details tool-details">
          <summary>{toolsCopy.customPathSummary}</summary>
          <Show when={lookup()}>
            {(places) => (
              <>
                <p class="provider-lookup-label">
                  {runtimeLookupCopy.lookedForLabel}
                </p>
                <ul class="provider-lookup-list">
                  <For each={places().places}>
                    {(place) => (
                      <li>{runtimeLookupPlaceCopy(place.names, place.location)}</li>
                    )}
                  </For>
                </ul>
                <p class="provider-lookup-get">
                  <span class="provider-lookup-get-label">
                    {runtimeLookupCopy.getItLabel}
                  </span>{" "}
                  <span class="provider-lookup-url">{places().installUrl}</span>
                </p>
              </>
            )}
          </Show>
          <RuntimeExecutableField
            runtime={props.runtime}
            fieldScope={props.runtime}
            value={configuredPath()}
            phase={props.executablePhase}
            catalogReady={props.row?.category === "catalog-ready"}
            onSave={props.onSaveExecutablePath}
          />
        </details>
      </div>
      <Show when={props.cliUpdate}>
        {(panel) => (
          <div class="provider-actions">
            <CliUpdateControls
              cliId={props.cliId}
              report={report()}
              phase={panel().runPhase(props.cliId)}
              checking={panel().checking}
              relaunchPhase={panel().relaunchPhase}
              onUpdate={() => panel().onUpdate(props.cliId)}
              onRecheck={() => panel().onRecheck()}
              onRestartNow={() => panel().onRestartNow()}
              onAcknowledgeRestart={() => panel().onAcknowledgeRestart(props.cliId)}
            />
          </div>
        )}
      </Show>
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
  /**
   * A page-unique key, folded into the field id. Since w233 step 2 the field
   * renders once per runtime, in the Tools section, so the runtime name is
   * enough -- but the key stays explicit because a `<label for>` only ever
   * resolves to the first element carrying an id, and the w190 walkthrough
   * found two cards sharing one.
   */
  readonly fieldScope: string;
  readonly value: string;
  readonly phase?: SettingsRuntimeExecutablePhase;
  /**
   * Whether this runtime's endpoint is already Catalog ready. A "saved"
   * phase is a session-local echo of the Save action; it does not know a
   * later Re-check has already confirmed the runtime, so it must not keep
   * telling the user to run one.
   */
  readonly catalogReady?: boolean;
  readonly onSave?: (
    runtime: WorkbenchConfigurableRuntime,
    executablePath: string,
  ) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal(props.value);
  // The stored value only changes when a save or an install has answered, and
  // an install answers with a path the user never typed: show it.
  createEffect(on(() => props.value, (value) => setDraft(value), { defer: true }));
  const fieldId = () => `runtime-executable-${props.fieldScope}`;
  const visiblePhase = (): SettingsRuntimeExecutablePhase | undefined => {
    const phase = props.phase;
    if (phase === undefined) return undefined;
    return phase.status === "saved" && props.catalogReady ? undefined : phase;
  };
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
      <Show when={visiblePhase()}>
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

/**
 * The product installing the runtime itself, into its private directory.
 *
 * Four states and nothing invented: absent, installing (elapsed time only --
 * npm reports no real progress, so no bar is drawn), installed (version; the
 * field above shows the path), failed (the step it stopped at and where to go
 * instead). After a restart the session phase is gone; the durable path alone
 * says a private copy is installed.
 */
const RuntimeInstallControl: Component<{
  readonly runtime: WorkbenchConfigurableRuntime;
  readonly configuredPath: string;
  readonly phase?: SettingsRuntimeInstallPhase;
  readonly disabled: boolean;
  readonly onInstall: (runtime: WorkbenchConfigurableRuntime) => void;
}> = (props) => {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const elapsedSeconds = () =>
    props.phase?.status === "installing"
      ? Math.max(0, Math.floor((now() - props.phase.startedAt) / 1000))
      : 0;
  const privateCopyConfigured = () => isPrivateCliInstallPath(props.configuredPath);
  const installedByPath = () => props.phase === undefined && privateCopyConfigured();
  const sentence = (): string | undefined => {
    const phase = props.phase;
    if (phase === undefined) {
      return installedByPath() ? runtimeInstallCopy.installedPathSentence : undefined;
    }
    switch (phase.status) {
      case "installing":
        return runtimeInstallCopy.installingSentence(elapsedSeconds());
      case "installed":
        return runtimeInstallCopy.installedSentence(phase.version);
      case "failed":
        return phase.step === undefined
          ? runtimeInstallCopy.unavailableSentence
          : `${runtimeInstallStepCopy(phase.step)} ${runtimeInstallCopy.manualSentence}`;
    }
  };
  const failed = () => props.phase?.status === "failed";
  return (
    <div
      class="runtime-install"
      data-install-status={
        props.phase?.status ?? (installedByPath() ? "installed" : "absent")
      }
    >
      <Show when={!privateCopyConfigured()}>
        <button
          type="button"
          class="btn sm"
          disabled={props.disabled}
          onClick={() => props.onInstall(props.runtime)}
        >
          {props.runtime === "codex"
            ? runtimeInstallCopy.installActionCodex
            : runtimeInstallCopy.installActionClaude}
        </button>
      </Show>
      <Show when={sentence()}>
        {(text) => (
          <p
            class={failed() ? "runtime-executable-error" : "runtime-executable-note"}
            role="status"
            aria-live="polite"
          >
            {text()}
            <Show when={failed() && props.phase?.status === "failed" && props.phase.detail.length > 0}>
              <br />
              <code class="runtime-install-detail">
                {props.phase?.status === "failed" ? props.phase.detail : ""}
              </code>
            </Show>
          </p>
        )}
      </Show>
    </div>
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
  // w233. They are read at the moment that matters -- beside the question,
  // before the second press that installs -- instead of standing in front of
  // the button on every visit.
  const beforeSentences = (): readonly string[] =>
    props.cliId === "codex" && confirming()
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
 * DPAPI disclosure sentences travel with it (behind Details since w233). The
 * row head names the provider, so this block carries no heading of its own —
 * but both halves of the protection truth stay (offline disk inspection /
 * same-account processes), and a provider with special key-handling rules
 * (Kimi: shown once, at most 5 keys) states them here.
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
        {/* w233. The storage and protection truths (ADR 0022 §4) and the
            provider's key-handling rule stay on the card, behind Details; a
            degraded (session-only) store is a warning and stays in view. */}
        <details class="settings-details">
          <summary>{settingsCopy.detailsSummary}</summary>
          <p>{copy().lede}</p>
          <p>{copy().storageSentence}</p>
          <p>{copy().protectionSentence}</p>
          <Show when={keyHandlingWarning()}>
            {(warning) => <p class="endpoint-key-handling-warning">{warning()}</p>}
          </Show>
          <Show when={ready() && status()!.isPersistent}>
            <p class="endpoint-key-persistence">{copy().persistentLabel}</p>
          </Show>
        </details>
        <Show when={ready()}>
          <Show when={!status()!.isPersistent}>
            <p class="endpoint-key-persistence">{copy().sessionOnlyLabel}</p>
          </Show>
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

/**
 * A base-URL endpoint card's "Base URL (optional)" field (ticket 21/w223
 * shipped Codex · API alone; w232 generalizes the same control across GLM,
 * DeepSeek, Kimi Code and Codex · API instead of copying it four times):
 * plain text, not a secret, so it renders below the API key row, behind its
 * own Details disclosure, instead of competing with Save key. Empty means
 * that endpoint's own official default applies; a non-blank draft is
 * validated for http(s):// shape only, at save time, main-process side -- no
 * connectivity probe here (out of scope for this field).
 */
const EndpointBaseUrlControls: Component<{
  readonly endpointId: WorkbenchBaseUrlEndpointId;
  readonly panel: WorkbenchEndpointBaseUrlPanel;
}> = (props) => {
  const copy = () => workbenchBaseUrlCopy(props.endpointId);
  const inputId = () => `endpoint-base-url-input-${props.endpointId}`;
  const statusLabel = () =>
    props.panel.savedBaseUrl.length > 0
      ? props.panel.savedBaseUrl
      : copy().notSetLabel;
  const feedbackSentence = () => {
    switch (props.panel.feedback) {
      case "save-invalid":
        return copy().invalidSentence;
      case "save-failed":
        return copy().saveFailedSentence;
      case null:
        return null;
    }
  };
  return (
    <details class="settings-details endpoint-base-url-details">
      <summary>{copy().label}</summary>
      <div class="provider-binding-copy endpoint-base-url-copy">
        <span class="provider-binding-status endpoint-base-url-status" role="status">
          <span>{copy().savedLabel}</span>
          <strong>{statusLabel()}</strong>
        </span>
        <p>{copy().hint}</p>
        <div class="endpoint-key-entry endpoint-base-url-entry">
          <label for={inputId()}>{copy().label}</label>
          <input
            id={inputId()}
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder={copy().placeholder}
            value={props.panel.draft}
            disabled={props.panel.busy}
            onInput={(event) => props.panel.onDraft(event.currentTarget.value)}
          />
        </div>
        <div class="provider-binding-actions endpoint-base-url-actions">
          <button
            type="button"
            class="btn ghost sm"
            disabled={props.panel.busy}
            onClick={() => props.panel.onSave()}
          >
            {copy().saveAction}
          </button>
        </div>
        <Show when={feedbackSentence()}>
          {(sentence) => (
            <p class="endpoint-base-url-feedback" role="alert">
              {sentence()}
            </p>
          )}
        </Show>
      </div>
    </details>
  );
};
