import {
  WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL,
  WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL,
  type WorkbenchSubscriptionUsageResult,
} from "../contract.ts";
import { sanitizeWorkbenchSubscriptionUsageResult } from "../result-sanitizer.ts";
import type { WorkbenchAppearancePreferenceStore } from "../appearance-preference-store.ts";

type Listener = (...values: unknown[]) => unknown;

export function installWorkbenchSubscriptionUsageIpc(options: {
  readonly ipcMain: {
    handle(channel: typeof WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL, listener: Listener): void;
    removeHandler(channel: typeof WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL): void;
  };
  readonly window: {
    readonly webContents: {
      isDestroyed(): boolean;
      send(channel: typeof WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL, result: WorkbenchSubscriptionUsageResult): void;
      on(event: string, listener: Listener): void;
      removeListener(event: string, listener: Listener): void;
    };
    on(event: "closed", listener: Listener): void;
    removeListener(event: "closed", listener: Listener): void;
  };
  readonly source: Pick<WorkbenchAppearancePreferenceStore, "readClaudeSubscriptionUsage">;
}) {
  let active = true;
  let disposed = false;
  const sender = options.window.webContents;
  const close = () => { active = false; };
  options.ipcMain.handle(WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL, async (...values) => {
    const event = values[0];
    if (values.length !== 1 || !active || sender.isDestroyed() ||
        typeof event !== "object" || event === null || !("sender" in event) || event.sender !== sender) {
      return { ok: false };
    }
    try {
      const observation = await options.source.readClaudeSubscriptionUsage();
      return !active || sender.isDestroyed() ? { ok: false } :
        sanitizeWorkbenchSubscriptionUsageResult({ ok: true, observation });
    } catch { return { ok: false }; }
  });
  sender.on("render-process-gone", close);
  sender.on("destroyed", close);
  options.window.on("closed", close);
  return Object.freeze({
    publish(result: WorkbenchSubscriptionUsageResult) {
      if (active && !sender.isDestroyed()) {
        sender.send(WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL, sanitizeWorkbenchSubscriptionUsageResult(result));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      options.ipcMain.removeHandler(WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL);
      sender.removeListener("render-process-gone", close);
      sender.removeListener("destroyed", close);
      options.window.removeListener("closed", close);
    },
  });
}
