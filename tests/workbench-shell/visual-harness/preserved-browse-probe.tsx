import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { HistoryRecoveryRendererBridge } from "../../../src/workbench-shell/history-recovery-contract.ts";
import { HistoryRecoverySettingsCard } from "../../../src/workbench-shell/renderer/history-recovery-settings.tsx";

const execute = (window as unknown as {
  recoveryExecute: HistoryRecoveryRendererBridge["getSnapshot"] &
    HistoryRecoveryRendererBridge["browse"] & HistoryRecoveryRendererBridge["perform"];
}).recoveryExecute;
const bridge: Partial<HistoryRecoveryRendererBridge> = {
  getSnapshot: execute,
  browse: execute,
  perform: execute,
};
const [result, setResult] = createSignal(await execute({
  version: 1, requestKey: "initial-snapshot",
}));

render(() => (
  <HistoryRecoverySettingsCard
    bridge={bridge}
    result={result()}
    onSnapshot={setResult}
    onRefresh={() => {
      void execute({ version: 1, requestKey: "refreshed-snapshot" }).then(setResult);
    }}
  />
), document.querySelector("#root")!);
