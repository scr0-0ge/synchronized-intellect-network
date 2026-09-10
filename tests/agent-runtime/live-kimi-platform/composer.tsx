// Opt-in live probe: real Composer, driven by the real backend's sanitized view.
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { DirectInputComposer } from "../../../src/workbench-shell/renderer/composer.tsx";
import { initialRendererState } from "../../../src/workbench-shell/renderer/view-model.ts";
import "../../../src/workbench-shell/renderer/styles.css";

const bridge = window as any;
const [view, setView] = createSignal<any>();
const [draft, setDraft] = createSignal("Reply exactly GUIDED. Do not use tools.");
const noOp = () => undefined;
// This probe has one isolated backend, not the full Project Host. Supply its
// selected-project shell metadata; command and capability state stay untouched.
bridge.updateProbe = (backendView: any) => setView({
  ...backendView,
  projectSelection: { projects: [{
    label: backendView.project.label, availability: "available", selected: true,
    selectionKey: "probe-project",
  }] },
});
render(() => <Show when={view()}><DirectInputComposer
  view={view()} selected={view().commands[0]}
  composer={{ ...initialRendererState.composer, draft: draft() }}
  profile={initialRendererState.profile} newSession={initialRendererState.newSession}
  projectSwitch={initialRendererState.projectSwitch} projectOpen={initialRendererState.projectOpen}
  centered={false} onDraft={setDraft} onNavigateComposerHistory={() => null}
  onLoadProfile={noOp} onEnterNewSession={noOp} onCancelNewSession={noOp}
  onEndpoint={noOp} onModel={noOp} onWorkIntensity={noOp} onExecutionMode={noOp}
  onAccessMode={noOp} onUseAsDefault={noOp} onSubmit={noOp}
  onSteer={() => bridge.probeSteer(draft())} onInterrupt={() => bridge.probeInterrupt()}
/></Show>, document.getElementById("root")!);
