import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { WorkbenchRendererBridge, WorkbenchSubscriptionUsageResult } from "../contract.ts";
import { locale } from "./locale.ts";
import { settingsUsageCopy as copy } from "./copy/settings-usage-copy.ts";

export const SettingsSubscriptionUsage: Component<{
  readonly bridge?: Pick<WorkbenchRendererBridge, "observeSubscriptionUsage">;
}> = props => {
  const [result, setResult] = createSignal<WorkbenchSubscriptionUsageResult>({ ok: true, observation: null });
  onMount(() => {
    const dispose = props.bridge?.observeSubscriptionUsage?.(setResult);
    if (dispose) onCleanup(dispose);
  });
  return <SubscriptionUsageSnapshot result={result()} />;
};

/** Pure rendering of the same sanitized snapshot received by Settings. */
export const SubscriptionUsageSnapshot: Component<{
  readonly result: WorkbenchSubscriptionUsageResult;
}> = props => {
  const observation = () => props.result.ok ? props.result.observation : null;
  const date = (milliseconds: number) => new Intl.DateTimeFormat(locale(), {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(milliseconds);
  return <section class="provider-settings" aria-labelledby="subscription-usage-title">
    <div class="section-head"><h2 id="subscription-usage-title">{copy.heading}</h2></div>
    <p>{copy.hint}</p>
    <h3>{copy.channel}</h3>
    <p>{copy.observed(observation() === null ? copy.unknown : date(observation()!.observedAt))}</p>
    <Show when={!props.result.ok}><p role="status">{copy.unreadable}</p></Show>
    <dl class="provider-status-meanings">
      <For each={["five_hour", "seven_day"] as const}>{key => {
        const window = () => observation()?.[key] ?? null;
        return <div>
          <dt>{key === "five_hour" ? copy.fiveHour : copy.sevenDay}</dt>
          <dd>{window() === null ? copy.unknown : copy.used(new Intl.NumberFormat(locale(), {
            style: "percent", maximumFractionDigits: 1,
          }).format(window()!.utilization))}</dd>
          <dd>{window() === null ? copy.resets(copy.unknown) : copy.resets(date(window()!.resetsAt * 1000))}</dd>
        </div>;
      }}</For>
    </dl>
    <p>{copy.unsupported}</p>
  </section>;
};
