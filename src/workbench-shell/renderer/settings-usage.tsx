import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { WorkbenchRendererBridge, WorkbenchSubscriptionUsageResult } from "../contract.ts";
import { subscriptionUsageToUsageObservation, type RuntimeUsageObservation } from "../../agent-runtime/index.ts";
import { locale } from "./locale.ts";
import { settingsUsageCopy as copy } from "./copy/settings-usage-copy.ts";

/** Row identity for the usage template. Order is fixed by `ROW_ORDER`, not by data. */
export type UsageEndpointRowKey = "codex" | "claude" | "glm" | "deepseek" | "kimi";

const ROW_ORDER: readonly UsageEndpointRowKey[] = ["codex", "claude", "glm", "deepseek", "kimi"];

/** Providers whose CLI never reports usage. Distinct from "not yet observed". */
const UNREPORTED_ROWS: ReadonlySet<UsageEndpointRowKey> = new Set(["codex"]);

/** Live-mounted card: Claude's row comes from the existing subscription-usage bridge channel; no new IPC. */
export const SettingsUsage: Component<{
  readonly bridge?: Pick<WorkbenchRendererBridge, "observeSubscriptionUsage">;
}> = props => {
  const [result, setResult] = createSignal<WorkbenchSubscriptionUsageResult>({ ok: true, observation: null, usage: {} });
  onMount(() => {
    const dispose = props.bridge?.observeSubscriptionUsage?.(setResult);
    if (dispose) onCleanup(dispose);
  });
  const observations = (): Partial<Record<UsageEndpointRowKey, RuntimeUsageObservation>> => {
    const current = result();
    if (!current.ok) return {};
    return {
      ...current.usage,
      ...(current.observation === null ? {} : { claude: subscriptionUsageToUsageObservation("claude", current.observation) }),
    };
  };
  return <UsageSnapshot result={result()} observations={observations()} />;
};

/**
 * Pure rendering of a per-provider usage snapshot. Adding a sixth data source
 * for an already-listed provider is a new `observations` entry; this
 * component does not change.
 */
export const UsageSnapshot: Component<{
  readonly result: WorkbenchSubscriptionUsageResult;
  readonly observations: Partial<Record<UsageEndpointRowKey, RuntimeUsageObservation>>;
}> = props => {
  const date = (milliseconds: number) => new Intl.DateTimeFormat(locale(), {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(milliseconds);
  const windowLine = (window: RuntimeUsageObservation["windows"][number]) => {
    const resets = window.resetsAt === undefined ? copy.unknown : date(window.resetsAt);
    const label = copy.windowLabel[window.label];
    return window.utilization === undefined
      ? copy.labelled(label, copy.resets(resets))
      : copy.labelled(label, `${copy.used(new Intl.NumberFormat(locale(), {
          style: "percent", maximumFractionDigits: 1,
        }).format(window.utilization))} · ${copy.resets(resets)}`);
  };
  return <section class="provider-settings" aria-labelledby="usage-title">
    <div class="section-head"><h2 id="usage-title">{copy.heading}</h2></div>
    <p>{copy.hint}</p>
    <Show when={!props.result.ok}><p role="status">{copy.unreadable}</p></Show>
    <dl class="provider-usage-rows">
      <For each={ROW_ORDER}>{key => {
        const observation = () => props.observations[key];
        return <div>
          <dt>{copy.providerName[key]}</dt>
          <Show when={!UNREPORTED_ROWS.has(key)} fallback={<dd>{copy.notReported}</dd>}>
            <Show when={observation()} fallback={<dd>{copy.notYetObserved}</dd>}>
              {(observed) => <>
                <For each={observed().windows}>{window => <dd>{windowLine(window)}</dd>}</For>
                <dd>{copy.observed(date(observed().observedAt))}</dd>
              </>}
            </Show>
          </Show>
        </div>;
      }}</For>
    </dl>
  </section>;
};
