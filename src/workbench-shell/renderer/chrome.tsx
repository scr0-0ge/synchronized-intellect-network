import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchProjectView,
} from "../contract.ts";
import type { WorkbenchWindowRendererBridge } from "../window-control-bridge.ts";
import {
  directEndpointStatusRows,
  directWorkIntensityPresentationLabel,
  type WorkbenchDirectProfileState,
} from "./view-model.ts";
import { type WorkbenchSurface } from "./settings-view-model.ts";

import {
  fixedExecutionModeLabel,
  fixedAccessModeLabel,
  recordedRequestedProfile,
  commandRuntimeFamily,
  runtimeClass,
  commandStatusLabel,
  commandStatusGlyph,
  commandStatusGlyphClass,
} from "./view-types.ts";
import { chromeCopy } from "./copy/chrome-copy.ts";

export const Titlebar: Component<{
  readonly view: WorkbenchHostedProjectView;
  readonly windowBridge: WorkbenchWindowRendererBridge;
  readonly surface: WorkbenchSurface;
  readonly onSurface: (surface: WorkbenchSurface) => void;
}> = (props) => {
  const [maximized, setMaximized] = createSignal(false);
  onMount(() => {
    const dispose = props.windowBridge.observeState((state) => {
      setMaximized(state.maximized);
    });
    onCleanup(dispose);
  });
  const selectedIndex = () =>
    Math.max(
      0,
      props.view.projectSelection.projects.findIndex(
        (project) => project.selected,
      ),
    );
  return (
    <header class="titlebar">
      <div class="tb-group">
        <span class="mark" aria-hidden="true">
          U
        </span>
        <button
          type="button"
          class="project-menu"
          aria-current={props.surface === "project" ? "page" : undefined}
          title={chromeCopy.projectMenuTitle}
          onClick={() => props.onSurface("project")}
        >
          <span class="pm-index" aria-hidden="true">
            {String(selectedIndex() + 1).padStart(2, "0")}
          </span>
          <span class="pm-name">{props.view.project.label}</span>
          <span class="pm-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>
      <div class="caption-buttons">
        <button
          type="button"
          class="caption-btn"
          aria-label={chromeCopy.minimize}
          title={chromeCopy.minimize}
          onClick={() => props.windowBridge.minimize()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5.5h10" />
          </svg>
        </button>
        <button
          type="button"
          class="caption-btn"
          data-maximized={maximized()}
          aria-label={maximized() ? chromeCopy.restore : chromeCopy.maximize}
          title={maximized() ? chromeCopy.restore : chromeCopy.maximize}
          onClick={() => props.windowBridge.toggleMaximize()}
        >
          <svg
            class="glyph-maximize"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
          <svg
            class="glyph-restore"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path d="M2.5 2.5v-2h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        </button>
        <button
          type="button"
          class="caption-btn close"
          aria-label={chromeCopy.close}
          title={chromeCopy.close}
          onClick={() => props.windowBridge.close()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </header>
  );
};

export const WorkbenchStatusbar: Component<{
  readonly view: WorkbenchProjectView;
  readonly selected: WorkbenchCommandView | undefined;
  readonly profile: WorkbenchDirectProfileState;
  readonly surface: WorkbenchSurface;
  readonly runtimeUnavailable: boolean;
  readonly startingNewSession: boolean;
}> = (props) => {
  const endpoints = () =>
    props.profile.phase === "ready" && props.profile.result?.ok
      ? props.profile.result.profile.endpoints
      : [];
  const endpointRows = () => directEndpointStatusRows(props.profile);
  const selectedEndpoint = () =>
    endpoints().find(
      (endpoint) => endpoint.key === props.profile.selectedEndpointKey,
    );
  const selectedModel = () =>
    selectedEndpoint()?.models.find(
      (model) => model.key === props.profile.selectedModelKey,
    );
  const selectedIntensity = () =>
    selectedModel()?.workIntensities.find(
      (option) => option.key === props.profile.selectedWorkIntensityKey,
    );
  const recorded = () =>
    props.startingNewSession
      ? undefined
      : recordedRequestedProfile(props.selected);
  const family = () =>
    recorded()?.runtimeFamilyLabel ??
    selectedEndpoint()?.runtimeFamilyLabel ??
    (props.selected === undefined ? undefined : commandRuntimeFamily(props.selected));
  const model = () =>
    recorded()?.modelLabel ?? selectedModel()?.label;
  const intensity = () =>
    recorded()?.workIntensityLabel ??
    directWorkIntensityPresentationLabel(
      selectedModel(),
      selectedIntensity()?.label,
    );
  const executionMode = () =>
    recorded()?.executionModeLabel ??
    selectedEndpoint()?.executionModes.find(
      (option) => option.key === props.profile.selectedExecutionModeKey,
    )?.label ??
    fixedExecutionModeLabel;
  const accessMode = () =>
    recorded()?.accessModeLabel ??
    selectedEndpoint()?.accessModes.find(
      (option) => option.key === props.profile.selectedAccessModeKey,
    )?.label ??
    fixedAccessModeLabel;
  const vendor = () => runtimeClass(family() ?? "");
  const terminal = () =>
    !props.startingNewSession &&
    props.selected !== undefined &&
    !props.selected.session?.resumable;

  return (
    <footer class="statusbar">
      <Show
        when={props.surface === "project"}
        fallback={
          <>
            <For each={endpointRows()}>
              {(row, index) => (
                <>
                  <Show when={index() > 0}>
                    <span class="sb-divider" aria-hidden="true" />
                  </Show>
                  <span class="sb-item">
                    <span
                      class={
                        "rt-dot " + runtimeClass(row.runtimeFamilyLabel)
                      }
                      aria-hidden="true"
                    />
                    <span
                      class={"v " + runtimeClass(row.runtimeFamilyLabel)}
                    >
                      {row.runtimeFamilyLabel} · {row.statusLabel}
                    </span>
                  </span>
                </>
              )}
            </For>
            <span class="sb-spacer" />
            <span class="sb-item sb-hide-narrow">
              <span class="v">{chromeCopy.credentialsNote}</span>
            </span>
          </>
        }
      >
        <Show
          when={!props.runtimeUnavailable}
          fallback={
            <>
              <span class="sb-item sb-none">
                <span class="st st-recovery" aria-hidden="true">
                  !
                </span>
                <span class="v">{chromeCopy.noRuntimeEndpoint}</span>
              </span>
              <span class="sb-divider" aria-hidden="true" />
            </>
          }
        >
          <Show
            when={family()}
            fallback={
              <>
                <span class="sb-item">
                  <span class="k">{chromeCopy.nextRunKey}</span>
                  <span class="v">{chromeCopy.nextRunNone}</span>
                </span>
                <span class="sb-divider" aria-hidden="true" />
              </>
            }
          >
            {(runtimeFamily) => (
              <>
                <span class="sb-item">
                  <span class={"rt-dot " + vendor()} aria-hidden="true" />
                  <span class={"v " + vendor()}>{runtimeFamily()}</span>
                </span>
                <Show when={model()}>
                  {(modelLabel) => (
                    <>
                      <span class="sb-divider" aria-hidden="true" />
                      <span class="sb-item mono">
                        <span class={"v " + vendor()}>{modelLabel()}</span>
                      </span>
                    </>
                  )}
                </Show>
                <Show when={intensity()}>
                  {(intensityLabel) => (
                    <>
                      <span class="sb-divider" aria-hidden="true" />
                      <span
                        class="sb-item truncate status-intensity"
                        classList={{ "is-terminal": terminal() }}
                        title={intensityLabel()}
                      >
                        <span class="k">{chromeCopy.intensityKey}</span>
                        <span class="v">{intensityLabel()}</span>
                      </span>
                    </>
                  )}
                </Show>
                <span class="sb-divider" aria-hidden="true" />
              </>
            )}
          </Show>
        </Show>
        <span class="sb-item sb-mode">
          <span class="k">{chromeCopy.execKey}</span>
          <span class="v">{executionMode()}</span>
        </span>
        <span class="sb-divider" aria-hidden="true" />
        <span class="sb-item sb-access">
          <span class="k">{chromeCopy.accessKey}</span>
          <span class="v">{accessMode()}</span>
        </span>
        <span class="sb-spacer" />
        <Show
          when={props.runtimeUnavailable}
          fallback={
            <>
              <Show when={props.selected === undefined}>
                <span class="sb-item sb-hide-narrow">
                  <span class="k">{chromeCopy.sendShortcutKey}</span>
                  <span class="v">{chromeCopy.sendShortcutVerb}</span>
                </span>
              </Show>
              <Show when={props.selected?.interrupt?.status === "available"}>
                <span class="sb-item sb-hide-narrow status-interrupt-shortcut">
                  <span class="k">{chromeCopy.interruptShortcutKey}</span>
                  <span class="v">{chromeCopy.interruptShortcutVerb}</span>
                </span>
              </Show>
              <Show when={props.selected}>
                {(command) => (
                  <span
                    class="sb-item sb-hide-narrow"
                    classList={{
                      "status-failed":
                        command().status === "failed" &&
                        command().failureCategory !== "interrupted",
                      "status-interrupted":
                        command().failureCategory === "interrupted",
                      "status-recovery":
                        command().status === "recovery-required",
                    }}
                  >
                    <span
                      class={"st " + commandStatusGlyphClass(command())}
                      aria-hidden="true"
                    >
                      {commandStatusGlyph(command())}
                    </span>
                    <span class="v">
                      {command().failureCategory === "interrupted"
                        ? chromeCopy.turnInterruptedStatus
                        : command().status === "failed"
                          ? chromeCopy.sessionFailedStatus
                          : command().status === "recovery-required"
                            ? chromeCopy.recoveryRequiredStatus
                            : commandStatusLabel(command())}
                    </span>
                  </span>
                )}
              </Show>
            </>
          }
        >
          <span class="sb-item sb-hide-narrow">
            <span class="v">{chromeCopy.draftPreserved}</span>
          </span>
        </Show>
      </Show>
    </footer>
  );
};
