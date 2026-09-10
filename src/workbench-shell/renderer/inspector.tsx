import { Show, type Component, type JSX } from "solid-js";
import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchSessionProfileProjection,
} from "../contract.ts";
import { contextUsedTokensLabel, displayValue } from "./view-model.ts";

import {
  fixedExecutionModeLabel,
  fixedAccessModeLabel,
  workbenchFallbackControlLabel,
  workbenchFallbackControlLabelTitle,
  recordedRequestedProfile,
  commandRuntimeFamily,
  runtimeClass,
  commandStatusLabel,
} from "./view-types.ts";
import { composerControlCopy } from "./copy/composer-copy.ts";
import {
  inspectorCopy,
  ordinalPositionCopy,
  endpointProfileCopy,
  matchesRequestedCopy,
  differsFromRequestedCopy,
} from "./copy/inspector-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";

export const SessionInspector: Component<{
  readonly active: boolean;
  readonly command: WorkbenchCommandView | undefined;
  readonly view: WorkbenchHostedProjectView;
  readonly onCollapse: () => void;
}> = (props) => {
  const requested = () => recordedRequestedProfile(props.command);
  const workIntensityControlLabel = () => {
    const control = requested()?.workIntensityControlLabel;
    return control?.provenance === "runtime-catalog"
      ? control.label
      : composerControlCopy.workIntensity;
  };
  const context = () => props.command?.session?.context;
  const turns = () =>
    props.command?.session?.timeline.filter(
      (event) => event.kind === "turn-started",
    ).length ?? 0;
  return (
    <aside
      class="inspector"
      aria-labelledby="inspector-title"
      aria-hidden={props.active ? undefined : "true"}
    >
      <div class="insp-head">
        <span class="rail-title" id="inspector-title">
          {inspectorCopy.railTitle}
        </span>
        <button
          type="button"
          class="icon-btn"
          aria-label={inspectorCopy.hideInspector}
          title={inspectorCopy.hideInspector}
          onClick={props.onCollapse}
        >
          ›
        </button>
      </div>
      <Show
        when={props.command}
        fallback={
          <>
            <div class="insp-section">
              <p class="inspector-empty-copy">
                {inspectorCopy.emptyCopy}
              </p>
            </div>
            <div class="insp-section">
              <div class="insp-label">{inspectorCopy.projectSection}</div>
              <dl class="kv">
                <InspectorFact label={inspectorCopy.nameLabel} value={props.view.project.label} />
                <InspectorFact
                  label={inspectorCopy.registeredLabel}
                  value={ordinalPositionCopy(
                    String(
                      props.view.projectSelection.projects.findIndex(
                        (project) => project.selected,
                      ) + 1,
                    ),
                    String(props.view.projectSelection.projects.length),
                  )}
                />
                <InspectorFact
                  label={inspectorCopy.accessLabel}
                  value={inspectorCopy.fullAccessTrusted}
                  tone="ok"
                />
              </dl>
              <div class="independent-note">
                <span aria-hidden="true">◆</span>
                <span>
                  {inspectorCopy.trustNote}
                </span>
              </div>
            </div>
          </>
        }
      >
        {(command) => (
          <>
            <div class="insp-section">
              <div class="insp-label">
                {inspectorCopy.profileSection}{" "}
                <span class="qualifier">{inspectorCopy.recordedQualifier}</span>
              </div>
              <dl class="kv">
                <InspectorFact
                  label={inspectorCopy.endpointLabel}
                  value={endpointProfileCopy(
                    requested()?.runtimeFamilyLabel ??
                      commandRuntimeFamily(command()),
                    requested()?.endpointLabel,
                  )}
                  vendor={runtimeClass(commandRuntimeFamily(command()))}
                />
                <InspectorFact
                  label={inspectorCopy.modelLabel}
                  value={requested()?.modelLabel ?? inspectorCopy.notRecorded}
                  vendor={runtimeClass(commandRuntimeFamily(command()))}
                />
                <InspectorFact
                  label={
                    <>
                      {workIntensityControlLabel()} {" "}
                      <Show
                        when={
                          requested()?.workIntensityControlLabel.provenance ===
                          "not-recorded"
                        }
                      >
                        <i
                          class="prov"
                          aria-label={workbenchFallbackControlLabel}
                          title={workbenchFallbackControlLabelTitle}
                        >
                          ⓦ
                        </i>
                      </Show>
                    </>
                  }
                  value={requested()?.workIntensityLabel ?? inspectorCopy.notRecorded}
                />
              </dl>
            </div>
            <div class="insp-section">
              <div class="insp-label">
                {inspectorCopy.modesSection}{" "}
                <span class="qualifier">{inspectorCopy.independentQualifier}</span>
              </div>
              <dl class="kv">
                <InspectorFact
                  label={inspectorCopy.executionLabel}
                  value={
                    requested()?.executionModeLabel ?? fixedExecutionModeLabel
                  }
                />
                <InspectorFact
                  label={inspectorCopy.accessLabel}
                  value={requested()?.accessModeLabel ?? fixedAccessModeLabel}
                  tone="ok"
                />
              </dl>
              <Show
                when={
                  command().status !== "failed" &&
                  command().status !== "recovery-required"
                }
              >
                <div class="independent-note">
                  <span aria-hidden="true">◆</span>
                  <span>
                    {inspectorCopy.independenceNote}
                  </span>
                </div>
              </Show>
            </div>
            <div class="insp-section">
              <div class="insp-label">
                {inspectorCopy.effectiveSection}{" "}
                <span class="qualifier">{inspectorCopy.postTurnQualifier}</span>
              </div>
              <dl class="kv">
                <InspectorFact
                  label={inspectorCopy.modelLabel}
                  value={effectiveProfileLabel(
                    command().session?.profile,
                    "model",
                    observationPending(command()),
                  )}
                  vendor={runtimeClass(commandRuntimeFamily(command()))}
                />
                <InspectorFact
                  label={workIntensityControlLabel()}
                  value={effectiveProfileLabel(
                    command().session?.profile,
                    "workIntensity",
                    observationPending(command()),
                  )}
                />
                <InspectorFact
                  label={inspectorCopy.accessLabel}
                  value={effectiveProfileLabel(
                    command().session?.profile,
                    "accessMode",
                    observationPending(command()),
                  )}
                />
              </dl>
            </div>
            <div class="insp-section">
              <div class="insp-label">{inspectorCopy.stateSection}</div>
              <dl class="kv">
                <InspectorFact
                  label={inspectorCopy.statusLabel}
                  value={commandStatusLabel(command())}
                  tone={
                    command().failureCategory === "interrupted"
                      ? "interrupted"
                      : command().status
                  }
                />
                <InspectorFact label={inspectorCopy.turnsLabel} value={String(turns())} mono />
                <InspectorFact
                  label={inspectorCopy.eventsLabel}
                  value={String(command().session?.timeline.length ?? 0)}
                  mono
                />
                <InspectorFact
                  label={inspectorCopy.resumableLabel}
                  value={command().session?.resumable ? inspectorCopy.yesValue : inspectorCopy.noValue}
                  tone={
                    command().session?.resumable
                      ? "ok"
                      : command().status === "failed"
                        ? "failed"
                        : "warn"
                  }
                />
                <Show when={contextUsedTokensLabel(context())}>
                  {(label) => (
                    <InspectorFact label={inspectorCopy.contextLabel} value={label()} mono />
                  )}
                </Show>
              </dl>
            </div>
          </>
        )}
      </Show>
    </aside>
  );
};

export const InspectorFact: Component<{
  readonly label: JSX.Element;
  readonly value: string;
  readonly mono?: boolean;
  readonly vendor?: string;
  readonly tone?: string;
}> = (props) => (
  <div class="kv-row">
    <dt>{props.label}</dt>
    <dd
      classList={{ mono: props.mono === true }}
      class={(props.vendor ?? "") + " tone-" + (props.tone ?? "default")}
    >
      {displayValue(props.value)}
    </dd>
  </div>
);

type EffectiveProfileField = "model" | "workIntensity" | "accessMode";

/** A command that can still reach its post-turn observation. */
function observationPending(command: WorkbenchCommandView): boolean {
  return command.status === "accepted" || command.status === "in-flight";
}

/**
 * Issue #6 case 2, the Inspector half. Same rule as the transcript header: the
 * effective projection's `unknown` arm is a statement about the observation,
 * not about the selection, and the requested value sits two sections above it.
 * A running turn has not reached its post-turn observation yet; an ended one
 * never produced it.
 */
function effectiveProfileLabel(
  profile: WorkbenchSessionProfileProjection | undefined,
  field: EffectiveProfileField,
  observationPending: boolean,
): string {
  const effective = profile?.effective;
  if (effective === undefined || effective.kind === "not-recorded") {
    return inspectorCopy.notRecorded;
  }
  if (effective.kind === "unknown") {
    return observationPending
      ? inspectorCopy.pendingObservationValue
      : inspectorCopy.unobservedValue;
  }
  const value = effective[field];
  return value.comparison === "matches-requested"
    ? matchesRequestedCopy(value.label)
    : differsFromRequestedCopy(dynamicCopy.observedDifferentValue);
}
