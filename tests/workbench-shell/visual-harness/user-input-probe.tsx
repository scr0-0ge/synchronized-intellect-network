import "../../../src/workbench-shell/renderer/styles.css";
import "../../../src/workbench-shell/renderer/themes/theme-acrylic.css";
import "../../../src/workbench-shell/renderer/themes/theme-schemes.css";
import "../../../src/workbench-shell/renderer/themes/theme-legibility.css";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { WorkbenchStage } from "../../../src/workbench-shell/renderer/stage.tsx";
import { WorkbenchRendererBridgeContext } from "../../../src/workbench-shell/renderer/view-types.ts";
import { initialRendererState } from "../../../src/workbench-shell/renderer/view-model.ts";
import type { WorkbenchHostedProjectView, WorkbenchRendererBridge } from "../../../src/workbench-shell/contract.ts";
import { interruptVisualFixture } from "./fixture.ts";

const host = window as unknown as {
  qaReadInput(request: unknown): Promise<unknown>;
  qaRespond(request: unknown): Promise<unknown>;
  qaReadView?(): Promise<WorkbenchHostedProjectView>;
};
const [view, setView] = createSignal(interruptVisualFixture);
if (host.qaReadView) setInterval(async () => setView(await host.qaReadView!()), 100);
const bridge = {
  observeUserInput: (listener: () => void) => {
    window.addEventListener("qa-input-changed", listener);
    return () => window.removeEventListener("qa-input-changed", listener);
  },
  readUserInput: (request: unknown) => host.qaReadInput(request),
  respondToUserInput: (request: unknown) => host.qaRespond(request),
} as WorkbenchRendererBridge;
const noop = () => undefined;
document.documentElement.dataset.theme = "light";
document.body.style.height = "100vh";
const style = document.createElement("style");
style.textContent = "#root { height:100vh; width:100%; }";
document.head.append(style);
render(() => <WorkbenchRendererBridgeContext.Provider value={bridge}>
  <div class="app">
    <div class="titlebar" />
    <div class="body-grid inspector-collapsed">
      <div class="rail" />
      <WorkbenchStage active view={view()} selected={view().commands.find(c => c.key === view().initialSelectionKey)}
        composer={initialRendererState.composer} profile={initialRendererState.profile}
        newSession={initialRendererState.newSession} projectSwitch={initialRendererState.projectSwitch}
        projectOpen={initialRendererState.projectOpen} runtimeUnavailable={false} inspectorCollapsed
        canCreateProject={() => false} canOpenProject={() => false} onShowInspector={noop}
        onCreateProject={noop} onOpenProject={noop} onDraft={noop} onNavigateComposerHistory={() => null}
        onLoadProfile={noop} onOpenProviders={noop} onEnterNewSession={noop} replacementSessionRefusal={null}
        onEnterReplacementSession={noop} onCancelNewSession={noop} onEndpoint={noop} onModel={noop}
        onWorkIntensity={noop} onExecutionMode={noop} onAccessMode={noop} onUseAsDefault={noop}
        interruptPending={false} interruptFeedback={null} onInterrupt={noop}
        steerPending={false} steerFeedback={null} onSteer={undefined} onSubmit={noop}/>
    </div>
    <div class="statusbar" />
  </div>
</WorkbenchRendererBridgeContext.Provider>, document.getElementById("root")!);
