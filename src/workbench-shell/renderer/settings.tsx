import { For, Show, onCleanup, onMount, type Component } from "solid-js";
import {
  type WorkbenchClaudePermissionHandling,
  type WorkbenchAppearancePreference,
  type WorkbenchRendererBridge,
  type WorkbenchRuntimeEndpointId,
  type WorkbenchSubscriptionAuthenticationAction,
} from "../contract.ts";
import type { HistoryRecoverySnapshotResult } from "../history-recovery-contract.ts";
import {
  type WorkbenchAppearanceAction,
  type WorkbenchAppearancePersistencePhase,
} from "./appearance-preference-state.ts";
import type { WorkbenchClaudePermissionHandlingPersistencePhase } from "./claude-permission-handling-state.ts";
import {
  directEndpointStatusRows,
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
  type SettingsSubscriptionAuthenticationEntry,
  type SettingsSubscriptionAuthenticationState,
} from "./settings-view-model.ts";
import { HistoryRecoverySettingsCard } from "./history-recovery-settings.tsx";

import { runtimeClass } from "./view-types.ts";
import { InspectorFact } from "./inspector.tsx";
import { commonCopy } from "./copy/common-copy.ts";
import { chromeCopy } from "./copy/chrome-copy.ts";
import {
  settingsCopy,
  bindingStatusAriaCopy,
  bindActionAriaCopy,
  authConsequencesCopy,
  type ProviderGroupHeading,
} from "./copy/settings-copy.ts";

export const SettingsScreen: Component<{
  readonly onClose: () => void;
  readonly profile: WorkbenchDirectProfileState;
  readonly subscriptionAuthentication?: SettingsSubscriptionAuthenticationState;
  readonly historyRecoveryResult?: HistoryRecoverySnapshotResult | null;
  readonly historyRecoveryBridge?: WorkbenchRendererBridge;
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
  readonly claudePermissionHandling: WorkbenchClaudePermissionHandling;
  readonly claudePermissionHandlingPersistencePhase: WorkbenchClaudePermissionHandlingPersistencePhase;
  readonly onClaudePermissionHandling: (
    permissionHandling: WorkbenchClaudePermissionHandling,
  ) => void;
  readonly canRead: boolean;
  readonly onRead: () => void;
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
  const endpointRows = () => directEndpointStatusRows(props.profile);
  const endpointGroups = () => groupSettingsProviderRows(endpointRows());
  const authentication = () =>
    props.subscriptionAuthentication ??
    initialSettingsSubscriptionAuthenticationState(
      props.profile.result?.endpointDiscovery,
    );
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

const ProviderGroup: Component<{
  readonly heading: ProviderGroupHeading;
  readonly rows: readonly WorkbenchRuntimeEndpointStatusRow[];
  readonly authentication: SettingsSubscriptionAuthenticationState;
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
  return (
    <section class="provider-group" aria-labelledby={headingId()}>
      <h3 id={headingId()}>{props.heading}</h3>
      <div class="provider-endpoint-list">
        <For each={props.rows}>
          {(row) => (
            <ProviderCard
              row={row}
              authentication={props.authentication[row.endpointId]}
              onBind={props.onBind}
              onBegin={props.onBegin}
              onCancel={props.onCancel}
            />
          )}
        </For>
      </div>
    </section>
  );
};

const ProviderCard: Component<{
  readonly row: WorkbenchRuntimeEndpointStatusRow;
  readonly authentication: SettingsSubscriptionAuthenticationEntry;
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
  const binding = () =>
    settingsSubscriptionAuthenticationPresentation(props.authentication);
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
      </div>
      <div class="provider-actions">
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
          <Show when={props.authentication.confirmation}>
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
        <div class="provider-binding-actions">
          <Show when={props.authentication.confirmation === null}>
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
              aria-label={bindActionAriaCopy(binding().actionLabel, props.row.runtimeFamilyLabel)}
              onClick={() => props.onBind?.(props.row.endpointId)}
            >
              {binding().actionLabel}
            </button>
          </Show>
        </div>
      </div>
    </section>
  );
};
