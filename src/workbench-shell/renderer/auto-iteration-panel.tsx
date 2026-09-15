import { For, Show, type Component } from "solid-js";

import type {
  WorkbenchAutoIterationView,
  WorkbenchAutoIterationWorkOrderView,
} from "../auto-iteration-view-contract.ts";
import { autoIterationCopy } from "./copy/auto-iteration-copy.ts";
import { locale } from "./locale.ts";

/**
 * Read-only projection of `WorkbenchAutoIterationView` (issue #8 §3: the
 * renderer is never a second state authority). Every field shown here comes
 * from that contract; there is no local mutation and no disposition action.
 */
export const AutoIterationPanel: Component<{
  readonly view: WorkbenchAutoIterationView;
}> = (props) => {
  const supervisor = () => props.view.supervisor;
  const lastObserved = (): string => {
    const at = props.view.lastObservedAt;
    if (at === null) return autoIterationCopy.neverObserved;
    return new Intl.DateTimeFormat(locale(), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(at);
  };
  const waitingForLabel = (
    waitingFor: WorkbenchAutoIterationWorkOrderView["waitingFor"],
  ): string => waitingFor ?? autoIterationCopy.waitingForNone;

  return (
    <section class="auto-iteration-panel" aria-labelledby="auto-iteration-title">
      <header class="auto-iteration-panel-head">
        <div>
          <h2 id="auto-iteration-title">{autoIterationCopy.title}</h2>
          <Show when={supervisor()} fallback={<p>{autoIterationCopy.noSupervisor}</p>}>
            {(bound) => (
              <p class="auto-iteration-supervisor">
                {autoIterationCopy.supervisorLine(
                  bound().roleSlotId,
                  bound().generation,
                  bound().tenureStatus,
                )}
              </p>
            )}
          </Show>
        </div>
      </header>

      <div class="auto-iteration-meta">
        <span class="auto-iteration-chip">
          {autoIterationCopy.pendingInbox(props.view.pendingInboxEntries)}
        </span>
        <Show when={props.view.quotaBlocked}>
          <span class="auto-iteration-chip is-warn">{autoIterationCopy.quotaBlocked}</span>
        </Show>
        <span class="auto-iteration-observed">
          {autoIterationCopy.lastObserved(lastObserved())}
        </span>
      </div>

      <Show
        when={props.view.workOrders.length > 0}
        fallback={<p class="auto-iteration-no-orders">{autoIterationCopy.noWorkOrders}</p>}
      >
        <div class="auto-iteration-work-order-table" role="table">
          <div class="auto-iteration-work-order-row auto-iteration-work-order-header" role="row">
            <span role="columnheader">{autoIterationCopy.workOrderId}</span>
            <span role="columnheader">{autoIterationCopy.status}</span>
            <span role="columnheader">{autoIterationCopy.lifecycle}</span>
            <span role="columnheader">{autoIterationCopy.workerSession}</span>
            <span role="columnheader">{autoIterationCopy.waitingFor}</span>
          </div>
          <For each={props.view.workOrders}>
            {(order) => (
              <div class="auto-iteration-work-order-row" role="row">
                <span role="cell" data-label={autoIterationCopy.workOrderId}>
                  {order.workOrderId}
                </span>
                <span role="cell" data-label={autoIterationCopy.status}>
                  <span class={`auto-iteration-chip status-${order.status}`}>{order.status}</span>
                </span>
                <span role="cell" data-label={autoIterationCopy.lifecycle}>
                  {order.workerRuntimeLifecycle}
                </span>
                <span role="cell" data-label={autoIterationCopy.workerSession}>
                  {order.workerSessionBound
                    ? autoIterationCopy.workerBound
                    : autoIterationCopy.workerUnbound}
                </span>
                <span role="cell" data-label={autoIterationCopy.waitingFor}>
                  {waitingForLabel(order.waitingFor)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
};
