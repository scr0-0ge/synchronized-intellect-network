import { render } from "solid-js/web";
import { SettingsScreen } from "../../../src/workbench-shell/renderer/settings.tsx";
import { initialRendererState } from "../../../src/workbench-shell/renderer/view-model.ts";
import {
  defaultWorkbenchAppearancePreference,
  defaultWorkbenchClaudePermissionHandling,
  defaultWorkbenchFamilyEndpointPreferences,
  type WorkbenchCliUpdateBridge,
  type WorkbenchRendererBridge,
} from "../../../src/workbench-shell/contract.ts";
import { setLocale } from "../../../src/workbench-shell/renderer/locale.ts";

const host = document.getElementById("root")!;
const bridge = (window as unknown as {
  cliUpdateProbe: WorkbenchCliUpdateBridge;
}).cliUpdateProbe;
const noOp = () => undefined;
if (new URLSearchParams(window.location.search).get("locale") === "zh-CN") {
  setLocale("zh-CN");
}

render(() => (
  <SettingsScreen
    onClose={noOp}
    profile={initialRendererState.profile}
    historyRecoveryBridge={bridge as WorkbenchRendererBridge & WorkbenchCliUpdateBridge}
    appearance={defaultWorkbenchAppearancePreference}
    appearancePersistencePhase="saved"
    onAppearance={noOp}
    claudePermissionHandling={defaultWorkbenchClaudePermissionHandling}
    claudePermissionHandlingPersistencePhase="saved"
    onClaudePermissionHandling={noOp}
    canRead={false}
    onRead={noOp}
    endpointPreferences={defaultWorkbenchFamilyEndpointPreferences}
    onEndpointPreference={noOp}
  />
), host);
