import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  WorkbenchCommandView,
  WorkbenchAnyPublicDirectSessionProfileResult,
  WorkbenchCatalogDefaultPublicProfileResult,
  WorkbenchDirectSessionProfileDefaultResult,
  WorkbenchHostedProjectResult,
  WorkbenchHostedProjectView,
  WorkbenchRuntimeEndpointDiscovery,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchSubmissionResult,
} from "../../src/workbench-shell/contract.ts";
import { defaultWorkbenchAppearancePreference } from "../../src/workbench-shell/contract.ts";
import { commonCopy } from "../../src/workbench-shell/renderer/copy/common-copy.ts";
import {
  blockedComposerCopy,
  composerActionsCopy,
  composerControlCopy,
  composerFeedbackCopy,
  continuationInputCopy,
  directInputCopy,
  pickerCopy,
  profileChipCopy,
  runtimeNotLocatedCopy,
  unavailableComposerCopy,
  unavailableInputCopy,
} from "../../src/workbench-shell/renderer/copy/composer-copy.ts";
import {
  differsFromRequestedCopy,
  inspectorCopy,
  matchesRequestedCopy,
} from "../../src/workbench-shell/renderer/copy/inspector-copy.ts";
import {
  archivedGroupCopy,
  railCopy,
} from "../../src/workbench-shell/renderer/copy/rail-copy.ts";
import { runtimeProfileCopy } from "../../src/workbench-shell/renderer/copy/runtime-profile-copy.ts";
import {
  failureCopy,
  statusCopy,
} from "../../src/workbench-shell/renderer/copy/session-status-copy.ts";
import { settingsCopy } from "../../src/workbench-shell/renderer/copy/settings-copy.ts";
import { liveWorkbenchCopy } from "../../src/workbench-shell/renderer/copy/shell-copy.ts";
import { stageCopy } from "../../src/workbench-shell/renderer/copy/stage-copy.ts";
import { presentationText } from "../../src/workbench-shell/renderer/presentation-text.ts";
import {
  beginDirectInputSubmission,
  beginDirectSessionProfileDefaultSave,
  beginDirectSessionProfileLoad,
  beginDirectSessionProfileRefreshFromProviders,
  beginCreateProject,
  beginOpenProject,
  beginProjectSelection,
  cancelNewAgentSessionMode,
  canCancelNewAgentSessionMode,
  canCreateProject,
  canEnterNewAgentSessionMode,
  canOpenProject,
  canSelectProject,
  canRefreshDirectSessionProfileFromProviders,
  canUseDirectSessionProfileAsDefault,
  canSubmitDirectInput,
  cancelDirectSessionProfileLoad,
  completeDirectInputSubmission,
  completeDirectSessionProfileDefaultSave,
  completeDirectSessionProfileLoad,
  completeCreateProject,
  completeOpenProject,
  completeProjectSelection,
  continuationDirectSessionProfileLoadRequest,
  contextRingPresentation,
  contextUsedTokensLabel,
  directInputMode,
  directWorkIntensityPresentationLabel,
  enterNewAgentSessionMode,
  hasHostedProjectView,
  initialRendererState,
  isInterruptShortcut,
  pendingContinuationDirectSessionProfileLoad,
  prepareDirectSessionProfileForProjectSurface,
  replaceProjectResult,
  selectDirectEndpoint,
  selectDirectExecutionMode,
  selectDirectModel,
  selectDirectWorkIntensity,
  selectProjectCommand,
  selectedCommand,
  updateDirectInputDraft,
} from "../../src/workbench-shell/renderer/view-model.ts";

test("Escape interruption shortcut accepts only one plain deliberate keypress", () => {
  const exact = {
    key: "Escape",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
  };
  assert.equal(isInterruptShortcut(exact), true);
  for (const changed of [
    { ...exact, key: "Esc" },
    { ...exact, ctrlKey: true },
    { ...exact, metaKey: true },
    { ...exact, altKey: true },
    { ...exact, shiftKey: true },
    { ...exact, repeat: true },
    { ...exact, isComposing: true },
  ]) {
    assert.equal(isInterruptShortcut(changed), false);
  }
});

test("an interrupted terminal remains an exact same-Session continuation target", () => {
  const completed = resumableSessionCommand(
    "command-interrupted",
    "Interrupted Session",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000215",
  );
  const interrupted = Object.freeze({
    ...completed,
    status: "failed" as const,
    failureCategory: "interrupted" as const,
  });
  const state = replaceProjectResult(
    initialRendererState,
    result(view(215, [interrupted], interrupted.key)),
  );
  assert.equal(directInputMode(state), "continue");
  assert.equal(
    continuationDirectSessionProfileLoadRequest(state)?.selectionKey,
    interrupted.session?.selectionKey,
  );
  assert.equal(failureCopy.interrupted.includes("can continue"), true);
});

test("renderer loads and retries profile options without losing the draft or silently selecting an unavailable default", () => {
  const drafted = updateDirectInputDraft(
    initialRendererState,
    "Keep this local draft while options load.",
  );
  const loading = beginDirectSessionProfileLoad(drafted);
  assert.equal(loading.profile.phase, "loading");
  assert.equal(loading.composer.draft, drafted.composer.draft);

  const unavailableDiscovery = endpointDiscovery(
    "authentication-required",
    "inspection-failed",
  );
  const failed = completeDirectSessionProfileLoad(loading, {
    ok: false,
    endpointDiscovery: unavailableDiscovery,
    error: {
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
    },
  });
  assert.equal(failed.profile.phase, "unavailable");
  assert.equal(failed.profile.result?.endpointDiscovery, unavailableDiscovery);
  assert.deepEqual(failed.profile.result?.endpointDiscovery.statuses, [
    {
      endpointId: "codex-desktop",
      category: "authentication-required",
    },
    {
      endpointId: "claude-code-desktop",
      category: "inspection-failed",
    },
  ]);
  assert.equal(failed.composer.draft, drafted.composer.draft);

  const retrying = beginDirectSessionProfileLoad(failed);
  const noDefault = completeDirectSessionProfileLoad(
    retrying,
    profileResult("unavailable"),
  );
  assert.equal(noDefault.profile.phase, "ready");
  assert.equal(noDefault.profile.selectedEndpointKey, null);
  assert.equal(noDefault.profile.selectedModelKey, null);
  assert.equal(noDefault.profile.selectedWorkIntensityKey, null);
  assert.equal(canSubmitDirectInput(noDefault), false);
  assert.equal(noDefault.composer.draft, drafted.composer.draft);

  const endpointSelected = selectDirectEndpoint(noDefault, "endpoint-1");
  const firstModel = selectDirectModel(endpointSelected, "model-1");
  const highSelected = selectDirectWorkIntensity(firstModel, "intensity-high");
  const resetForOverlap = selectDirectModel(highSelected, "model-2");
  const resetForOneOption = selectDirectModel(resetForOverlap, "model-3");
  assert.equal(highSelected.profile.selectedWorkIntensityKey, "intensity-high");
  assert.equal(
    resetForOverlap.profile.selectedWorkIntensityKey,
    "intensity-medium",
  );
  assert.equal(
    resetForOneOption.profile.selectedWorkIntensityKey,
    "intensity-ultra",
  );
  assert.equal(canSubmitDirectInput(resetForOneOption), true);
  const explicit = selectDirectWorkIntensity(
    resetForOneOption,
    "intensity-ultra",
  );
  assert.equal(explicit.profile.selectedWorkIntensityKey, "intensity-ultra");
  assert.equal(canSubmitDirectInput(explicit), true);
  assert.equal(Object.isFrozen(explicit.profile), true);
});

test("replacement profile loading prefills only an exact resolved tuple and otherwise stays blank with truthful manual copy", () => {
  const request = Object.freeze({
    kind: "replacement-session" as const,
    sourceSelectionKey: "command-2",
    sourceSnapshotCursor: 14,
  });
  const otherRequest = Object.freeze({
    ...request,
    sourceSelectionKey: "command-3",
  });
  const otherCursorRequest = Object.freeze({
    ...request,
    sourceSnapshotCursor: request.sourceSnapshotCursor + 1,
  });
  const ordinaryReady = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    profileResult(),
  );
  assert.notEqual(ordinaryReady.profile.selectedEndpointKey, null);
  const loading = beginDirectSessionProfileLoad(ordinaryReady, request);
  assert.deepEqual(
    [
      loading.profile.selectedEndpointKey,
      loading.profile.selectedModelKey,
      loading.profile.selectedWorkIntensityKey,
      loading.profile.selectedExecutionModeKey,
      loading.profile.selectedAccessModeKey,
    ],
    [null, null, null, null, null],
  );

  assert.equal(
    completeDirectSessionProfileLoad(
      loading,
      replacementProfileResult("resolved"),
      otherRequest,
    ),
    loading,
  );
  assert.equal(
    completeDirectSessionProfileLoad(
      loading,
      replacementProfileResult("resolved"),
      otherCursorRequest,
    ),
    loading,
  );
  const resolved = completeDirectSessionProfileLoad(
    loading,
    replacementProfileResult("resolved"),
    request,
  );
  assert.deepEqual(
    {
      endpoint: resolved.profile.selectedEndpointKey,
      model: resolved.profile.selectedModelKey,
      intensity: resolved.profile.selectedWorkIntensityKey,
      execution: resolved.profile.selectedExecutionModeKey,
      access: resolved.profile.selectedAccessModeKey,
    },
    {
      endpoint: "endpoint-1",
      model: "model-1",
      intensity: "intensity-high",
      execution: "execution-1",
      access: "access-1",
    },
  );

  const manual = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(ordinaryReady, request),
    replacementProfileResult("manual-selection-required"),
    request,
  );
  assert.deepEqual(
    {
      endpoint: manual.profile.selectedEndpointKey,
      model: manual.profile.selectedModelKey,
      intensity: manual.profile.selectedWorkIntensityKey,
      execution: manual.profile.selectedExecutionModeKey,
      access: manual.profile.selectedAccessModeKey,
    },
    {
      endpoint: null,
      model: null,
      intensity: null,
      execution: null,
      access: null,
    },
  );
  assert.equal(
    presentationText(manual.profile.feedback),
    "Exact prefill from this Session’s recorded profile is unavailable in the current catalog. Choose a Session Profile manually.",
  );
  assert.equal(
    typeof manual.profile.feedback === "string"
      ? null
      : manual.profile.feedback?.key,
    "profile.replacement-unavailable",
  );
  assert.equal(canSubmitDirectInput(manual), false);
  const cancelled = cancelDirectSessionProfileLoad(loading);
  assert.equal(cancelled.profile.phase, "idle");
  assert.equal(
    completeDirectSessionProfileLoad(
      cancelled,
      replacementProfileResult("resolved"),
      request,
    ),
    cancelled,
  );
  assert.equal(
    manual.profile.result?.ok
      ? "desiredDefault" in manual.profile.result.profile
      : true,
    false,
  );
});

test("replacement profile loading is revoked by source cursor or membership changes before a late completion", () => {
  const source = command("command-2", "Agent Session 02", "failed");
  const request = Object.freeze({
    kind: "replacement-session" as const,
    sourceSelectionKey: source.key,
    sourceSnapshotCursor: 14,
  });
  const sourceState = replaceProjectResult(
    initialRendererState,
    result(view(14, [source], source.key)),
  );
  const beginReplacement = () =>
    beginDirectSessionProfileLoad(
      enterNewAgentSessionMode(sourceState),
      request,
    );

  const cursorInvalidated = replaceProjectResult(
    beginReplacement(),
    result(view(15, [source], source.key)),
  );
  assert.equal(cursorInvalidated.profile.phase, "idle");
  assert.equal(
    completeDirectSessionProfileLoad(
      cursorInvalidated,
      replacementProfileResult("resolved"),
      request,
    ),
    cursorInvalidated,
  );

  const sourceInvalidated = replaceProjectResult(
    beginReplacement(),
    result(view(14, [], null)),
  );
  assert.equal(sourceInvalidated.profile.phase, "idle");
  assert.equal(
    completeDirectSessionProfileLoad(
      sourceInvalidated,
      replacementProfileResult("resolved"),
      request,
    ),
    sourceInvalidated,
  );
});

test("renderer resets Work Intensity to the target model's first Runtime option only when the model changes", () => {
  const selected = readyState();
  const sameModel = selectDirectModel(selected, "model-1");
  const overlappingTarget = selectDirectModel(selected, "model-2");
  const disjointSource = selectDirectWorkIntensity(
    selectDirectModel(selected, "model-2"),
    "intensity-medium",
  );
  const disjointTarget = selectDirectModel(disjointSource, "model-1");
  const oneOptionTarget = selectDirectModel(selected, "model-3");

  assert.deepEqual(
    {
      sameModel: sameModel.profile.selectedWorkIntensityKey,
      overlappingTarget:
        overlappingTarget.profile.selectedWorkIntensityKey,
      disjointTarget: disjointTarget.profile.selectedWorkIntensityKey,
      oneOptionTarget: oneOptionTarget.profile.selectedWorkIntensityKey,
    },
    {
      sameModel: "intensity-high",
      overlappingTarget: "intensity-medium",
      disjointTarget: "intensity-low",
      oneOptionTarget: "intensity-ultra",
    },
  );
});

test("renderer preserves the draft and does not retry when the Runtime was not located", async () => {
  const drafted = updateDirectInputDraft(
    initialRendererState,
    "Keep this draft while the Runtime is repaired.",
  );
  const loading = beginDirectSessionProfileLoad(drafted);
  const unavailableDiscovery = endpointDiscovery(
    "runtime-not-located",
    "runtime-not-located",
  );
  const notLocated = completeDirectSessionProfileLoad(
    loading,
    {
      ok: false,
      endpointDiscovery: unavailableDiscovery,
      error: {
        category: "runtime-not-located",
        message:
          "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
      },
    },
  );

  assert.equal(notLocated.profile.phase, "runtime-not-located");
  assert.equal(presentationText(notLocated.profile.feedback), runtimeNotLocatedCopy);
  assert.equal(
    typeof notLocated.profile.feedback === "string"
      ? null
      : notLocated.profile.feedback?.key,
    "profile.runtime-not-located",
  );
  assert.equal(
    runtimeNotLocatedCopy,
    "The Workbench looked for the runtimes it knows about and found neither of them installed and signed in on this machine. Sessions can't start until at least one is ready.",
  );
  assert.equal(
    notLocated.profile.result?.endpointDiscovery,
    unavailableDiscovery,
  );
  assert.deepEqual(notLocated.profile.result?.endpointDiscovery.statuses, [
    { endpointId: "codex-desktop", category: "runtime-not-located" },
    {
      endpointId: "claude-code-desktop",
      category: "runtime-not-located",
    },
  ]);
  assert.equal(
    notLocated.profile.result?.ok === false
      ? notLocated.profile.result.error.message
      : null,
    "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
  );
  assert.equal(notLocated.composer.draft, drafted.composer.draft);
  assert.equal(beginDirectSessionProfileLoad(notLocated), notLocated);
  assert.equal(canRefreshDirectSessionProfileFromProviders(notLocated), true);
  const refreshing = beginDirectSessionProfileRefreshFromProviders(notLocated);
  assert.equal(refreshing.profile.phase, "loading");
  assert.equal(refreshing.composer.draft, drafted.composer.draft);
  const refreshed = completeDirectSessionProfileLoad(
    refreshing,
    profileResult(),
  );
  assert.equal(refreshed.profile.phase, "ready");
  assert.equal(refreshed.composer.draft, drafted.composer.draft);
  assert.equal(canSubmitDirectInput(notLocated), false);

  const stageSource = await readFile(
    new URL("../../src/workbench-shell/renderer/stage.tsx", import.meta.url),
    "utf8",
  );
  const runtimeState = stageSource.slice(
    stageSource.indexOf("const RuntimeNotLocatedState"),
    stageSource.indexOf("function commandTurnStateClass"),
  );
  assert.match(runtimeState, /<h1>\{stageCopy\.noRuntimeTitle\}<\/h1>/u);
  assert.equal(stageCopy.noRuntimeTitle, "No Agent Runtime is available");
  assert.doesNotMatch(
    runtimeState,
    /runtime-settings-direction|highlighted Settings gear/u,
  );
  assert.match(
    runtimeState,
    /<button[\s\S]*?\{stageCopy\.openSettings\}[\s\S]*?<\/button>/u,
  );
  assert.equal(stageCopy.openSettings, "Open Settings");
  assert.doesNotMatch(runtimeState, />\s*Open Providers\s*<\/button>/u);
  assert.doesNotMatch(runtimeState, /Retry/u);
});

test("Providers profile refresh preserves the selected continuation or terminal Session and local draft", () => {
  const continuation = resumableSessionCommand(
    "command-refresh-continuation",
    "Continuation Session",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000214",
  );
  const terminal = command(
    "command-refresh-terminal",
    "Terminal Session",
    "failed",
  );
  const continuationState = updateDirectInputDraft(
    replaceProjectResult(
      initialRendererState,
      result(view(214, [continuation, terminal], continuation.key)),
    ),
    "Keep this Project-local draft during a catalog refresh.",
  );
  const terminalState = selectProjectCommand(
    continuationState,
    terminal.key,
  );

  assert.equal(directInputMode(continuationState), "continue");
  assert.equal(directInputMode(terminalState), "unavailable");
  assert.equal(
    beginDirectSessionProfileLoad(continuationState),
    continuationState,
  );

  for (const scoped of [continuationState, terminalState]) {
    assert.equal(canRefreshDirectSessionProfileFromProviders(scoped), true);
    const refreshing = beginDirectSessionProfileRefreshFromProviders(scoped);
    assert.notEqual(refreshing, scoped);
    assert.equal(refreshing.profile.phase, "loading");
    assert.equal(refreshing.result, scoped.result);
    assert.equal(refreshing.selectedKey, scoped.selectedKey);
    assert.equal(refreshing.composer, scoped.composer);
    assert.equal(refreshing.composer.draft, scoped.composer.draft);
    const refreshed = completeDirectSessionProfileLoad(
      refreshing,
      profileResult(),
    );
    assert.equal(refreshed.profile.phase, "ready");
    assert.equal(refreshed.result, scoped.result);
    assert.equal(refreshed.selectedKey, scoped.selectedKey);
    assert.equal(refreshed.composer.draft, scoped.composer.draft);
  }
});

test("Providers profile refresh blocks duplicate and recovery-sensitive pending actions by identity", () => {
  const current = resumableSessionCommand(
    "command-refresh-blockers",
    "Current Session",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000215",
  );
  const stable = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(215, [current], current.key, 0, "available", 801)),
  );
  const loading = beginDirectSessionProfileRefreshFromProviders(stable);
  const savingDefault = beginDirectSessionProfileDefaultSave(readyState()).state;
  const openingProject = beginOpenProject(stable);
  const recoveringProject = Object.freeze({
    ...stable,
    projectOpen: Object.freeze({
      ...stable.projectOpen,
      phase: "recovery-required" as const,
      operation: "open" as const,
    }),
  });
  const switchingProject = beginProjectSelection(stable, 1).state;
  const continuationRequest = continuationDirectSessionProfileLoadRequest(stable)!;
  const readyContinuation = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(stable, continuationRequest),
    continuationProfileResult(),
    continuationRequest,
  );
  const submittingContinuation = beginDirectInputSubmission(
    updateDirectInputDraft(readyContinuation, "Continue this Session."),
  ).state;
  const awaitingSession = Object.freeze({
    ...stable,
    newSession: Object.freeze({
      ...stable.newSession,
      phase: "awaiting-visible" as const,
    }),
  });

  assert.equal(openingProject.projectOpen.phase, "pending");
  assert.equal(switchingProject.projectSwitch.phase, "pending");
  assert.equal(submittingContinuation.composer.phase, "pending");
  for (const blocked of [
    loading,
    savingDefault,
    openingProject,
    recoveringProject,
    switchingProject,
    submittingContinuation,
    awaitingSession,
  ]) {
    assert.equal(canRefreshDirectSessionProfileFromProviders(blocked), false);
    assert.equal(
      beginDirectSessionProfileRefreshFromProviders(blocked),
      blocked,
    );
  }
});

test("switching endpoints resets to an actionable first model and intensity, including switch-back", () => {
  const drafted = updateDirectInputDraft(
    initialRendererState,
    "Keep this selection actionable across endpoint switches.",
  );
  const loaded = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(drafted),
    switchingProfileResult(),
  );
  assert.equal(loaded.profile.selectedEndpointKey, "endpoint-1");
  assert.equal(loaded.profile.selectedModelKey, "model-1");
  assert.equal(loaded.profile.selectedWorkIntensityKey, "intensity-high");

  const second = selectDirectEndpoint(loaded, "endpoint-2");
  assert.equal(second.profile.selectedModelKey, "model-4");
  assert.equal(second.profile.selectedWorkIntensityKey, "intensity-default");
  assert.equal(canSubmitDirectInput(second), true);

  const firstAgain = selectDirectEndpoint(second, "endpoint-1");
  assert.equal(firstAgain.profile.selectedModelKey, "model-1");
  assert.equal(firstAgain.profile.selectedWorkIntensityKey, "intensity-low");
  assert.equal(canSubmitDirectInput(firstAgain), true);
  const firstModel = firstAgain.profile.result?.ok
    ? firstAgain.profile.result.profile.endpoints[0]?.models[0]
    : undefined;
  assert.equal(
    directWorkIntensityPresentationLabel(
      second.profile.result?.ok
        ? second.profile.result.profile.endpoints[1]?.models[0]
        : undefined,
      "default",
    ),
    "default",
  );
  assert.equal(
    directWorkIntensityPresentationLabel(firstModel, "low"),
    "low",
  );
});

test("the Work Intensity chip follows index-zero selection for Codex and Claude", async () => {
  const loaded = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    switchingProfileResult(),
  );
  const codex = selectDirectWorkIntensity(loaded, "intensity-low");
  const claude = selectDirectEndpoint(codex, "endpoint-2");

  assert.equal(codex.profile.selectedWorkIntensityKey, "intensity-low");
  assert.equal(claude.profile.selectedWorkIntensityKey, "intensity-default");

  const composerSource = await readFile(
    new URL("../../src/workbench-shell/renderer/composer.tsx", import.meta.url),
    "utf8",
  );
  const controlStart = composerSource.indexOf('id="direct-work-intensity"');
  assert.notEqual(controlStart, -1);
  const intensityPopoverStart = composerSource.indexOf(
    "const IntensityPopover",
  );
  assert.notEqual(intensityPopoverStart, -1);
  const intensityPopover = composerSource.slice(
    intensityPopoverStart,
    composerSource.indexOf("const FixedModeChip", intensityPopoverStart),
  );
  assert.match(
    intensityPopover,
    /onClick=\{\(event\) => selectIntensityInput\(event\.currentTarget\)\}/u,
  );
});

test("Exec and Access are non-interactive fixed chips with no fake picker", async () => {
  const composerSource = await readFile(
    new URL("../../src/workbench-shell/renderer/composer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    composerSource,
    /<FixedModeChip\s+label=\{composerControlCopy\.exec\}/u,
  );
  assert.match(
    composerSource,
    /<FixedModeChip\s+label=\{composerControlCopy\.access\}/u,
  );
  assert.equal(composerControlCopy.exec, "Exec");
  assert.equal(composerControlCopy.access, "Access");
  assert.match(
    composerSource,
    /const FixedModeChip:[\s\S]*?<span class="chip locked">/u,
  );
  assert.doesNotMatch(
    composerSource,
    /InteractiveFixedModeChip|FixedModePopover/u,
  );
  assert.doesNotMatch(
    composerSource,
    /kind="(?:execution|access)"[\s\S]*?aria-haspopup="dialog"/u,
  );
});

test("renderer uses labeled keyboard-operable chips, popovers, and a discrete intensity slider", async () => {
  const [
    mountSource,
    chromeSource,
    composerSource,
    dialogsSource,
    inspectorSource,
    projectRailSource,
    settingsSource,
    stageSource,
    statesSource,
    transcriptSource,
    transcriptSearchSource,
    viewTypesSource,
    viewModelSource,
    stylesSource,
    acrylicSource,
  ] = await Promise.all(
    [
      "../../src/workbench-shell/renderer/mount.tsx",
      "../../src/workbench-shell/renderer/chrome.tsx",
      "../../src/workbench-shell/renderer/composer.tsx",
      "../../src/workbench-shell/renderer/dialogs.tsx",
      "../../src/workbench-shell/renderer/inspector.tsx",
      "../../src/workbench-shell/renderer/project-rail.tsx",
      "../../src/workbench-shell/renderer/settings.tsx",
      "../../src/workbench-shell/renderer/stage.tsx",
      "../../src/workbench-shell/renderer/states.tsx",
      "../../src/workbench-shell/renderer/transcript.tsx",
      "../../src/workbench-shell/renderer/transcript-search.ts",
      "../../src/workbench-shell/renderer/view-types.ts",
      "../../src/workbench-shell/renderer/view-model.ts",
      "../../src/workbench-shell/renderer/styles.css",
      "../../src/workbench-shell/renderer/themes/theme-acrylic.css",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const rendererSource = [
    mountSource,
    chromeSource,
    composerSource,
    dialogsSource,
    inspectorSource,
    projectRailSource,
    settingsSource,
    stageSource,
    statesSource,
    transcriptSource,
    transcriptSearchSource,
    viewTypesSource,
  ].join("\n");
  const source = [rendererSource, viewModelSource, stylesSource].join("\n");

  assert.match(source, /id="direct-runtime-endpoint"[\s\S]*?aria-haspopup="dialog"/u);
  assert.match(source, /id="direct-model"[\s\S]*?aria-haspopup="dialog"/u);
  assert.match(source, /id="direct-work-intensity"[\s\S]*?aria-haspopup="dialog"/u);
  assert.match(source, /class="islider-range"[\s\S]*?type="range"/u);
  assert.match(source, /aria-valuetext=\{[\s\S]*?selectedPresentationLabel\(\)/u);
  assert.match(composerSource, /class="islider-track"/u);
  assert.match(composerSource, /class="islider-rail"/u);
  assert.match(composerSource, /class="islider-fill"/u);
  assert.match(composerSource, /class="islider-stop"/u);
  assert.match(composerSource, /class="islider-thumb"/u);
  assert.doesNotMatch(source, /<select/u);
  assert.match(source, /<For each=\{props\.models\}>/u);
  assert.match(source, /<For each=\{options\(\)\}>/u);
  assert.match(
    composerSource,
    /props\.selectedModel\?\.workIntensityLabel \?\? composerControlCopy\.workIntensity/u,
  );
  assert.equal(composerControlCopy.workIntensity, "Work Intensity");
  assert.match(
    viewTypesSource,
    /workbenchFallbackControlLabel\s*=\s*runtimeProfileCopy\.workbenchFallbackControlLabel/u,
  );
  assert.equal(
    runtimeProfileCopy.workbenchFallbackControlLabel,
    "Workbench fallback label",
  );
  assert.doesNotMatch(rendererSource, /model\.provenanceLabel/u);
  assert.doesNotMatch(rendererSource, /model\.workIntensities\.length/u);
  assert.doesNotMatch(rendererSource, /workIntensityPresentation/u);
  assert.doesNotMatch(rendererSource, /Runtime catalog:/u);
  assert.doesNotMatch(rendererSource, /\b(?:fast|balance|extra)\b/u);
  assert.match(composerSource, /selectedWorkIntensity\(\)\?\.label/u);
  const profilePopover = composerSource.slice(
    composerSource.indexOf("const ProfilePopover"),
    composerSource.indexOf("const IntensityPopover"),
  );
  assert.doesNotMatch(profilePopover, /endpoint\.models\.length/u);
  // Ticket 20/25: the picker list is the facade view — each family's two
  // endpoints present as the single entry resolved from the persisted
  // per-family preferences.
  assert.match(
    profilePopover,
    /<For each=\{directFacadeEndpointStatusRows\(/u,
  );
  assert.match(
    profilePopover,
    /props\.endpointPreferences\s*\?\?\s*defaultWorkbenchFamilyEndpointPreferences/u,
  );
  assert.match(profilePopover, /\{row\.endpointLabel\}/u);
  assert.doesNotMatch(rendererSource, /Review provider status from Settings in the Project rail/u);
  assert.equal(rendererSource.match(/Open Providers/gu)?.length ?? 0, 0);
  assert.equal(
    stageSource.match(/stageCopy\.openSettings/gu)?.length ?? 0,
    1,
  );
  assert.equal(stageCopy.openSettings, "Open Settings");
  assert.match(
    composerSource,
    /props\.composer\.draft\.length > 0[\s\S]*?unavailableComposerCopy\.pausedBody[\s\S]*?unavailableComposerCopy\.pausedBodyNoDraft/u,
  );
  assert.equal(
    unavailableComposerCopy.pausedBody,
    "Your draft is kept. It will send once an endpoint is available.",
  );
  assert.equal(
    unavailableComposerCopy.pausedBodyNoDraft,
    "No Agent Runtime is available. Composing resumes once one is ready.",
  );
  assert.match(
    composerSource,
    /\{pickerCopy\.noLevelsNote\}/u,
  );
  assert.equal(
    pickerCopy.noLevelsNote,
    "This model reports no intensity levels, so there is nothing to choose. That is the catalog as given, not a failure.",
  );
  assert.match(
    composerSource,
    /<button[\s\S]*?class="btn primary new-session-button"[\s\S]*?\{composerActionsCopy\.newAgentSession\}[\s\S]*?<\/button>/u,
  );
  assert.equal(composerActionsCopy.newAgentSession, "New Agent Session");
  assert.match(stageSource, /\{stageCopy\.returnToSelectedSession\}/u);
  assert.equal(stageCopy.returnToSelectedSession, "Return to selected Session");
  assert.match(source, /enterNewAgentSessionMode/u);
  assert.match(source, /cancelNewAgentSessionMode/u);
  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/u);
  assert.match(
    stageSource,
    /<FreshStartStageState[\s\S]*?canReturn=\{canCancelNewAgentSessionMode\(rendererState\(\)\)\}[\s\S]*?onReturn=\{props\.onCancelNewSession\}/u,
  );
  assert.match(
    stageSource,
    /class="btn primary"[\s\S]*?disabled=\{!props\.canReturn\}[\s\S]*?\{stageCopy\.returnToSelectedSession\}/u,
  );
  assert.match(
    projectRailSource,
    /props\.selectedKey !== null[\s\S]*?selectedProjectAvailable\(\)/u,
  );
  assert.match(composerSource, /blockedComposerCopy\.cantContinue/u);
  assert.equal(blockedComposerCopy.cantContinue, "This Session can't be continued");
  assert.match(composerSource, /profileChipCopy\.useAsDefault/u);
  assert.equal(profileChipCopy.useAsDefault, "Use as default");
  assert.doesNotMatch(source, /Retry profile load|Reload profile options/u);
  assert.match(source, /useDirectSessionProfileAsDefault/u);
  assert.match(source, /aria-busy=\{defaultSavePending\(\)\}/u);
  assert.match(source, /class="proj-toggle registered-project-button"/u);
  assert.match(source, /aria-current=\{project\.selected \? "page"/u);
  assert.match(source, /aria-busy=\{pending\(\)\}/u);
  assert.match(projectRailSource, /railCopy\.collapsedAvailable/u);
  assert.equal(railCopy.collapsedAvailable, "Opening this Project loads its Sessions.");
  assert.match(projectRailSource, /activeCommands\(\)\.slice\(0, 5\)/u);
  assert.match(
    projectRailSource,
    /archivedGroupCopy\(archivedCommands\(\)\.length\)/u,
  );
  assert.equal(archivedGroupCopy(3), "Archived (3)");
  assert.match(source, /aria-expanded=\{currentDisclosure\(\)\.archivedExpanded\}/u);
  assert.match(
    source,
    /sessionArchiveControlPresentation\(props\.command, actionsDisabled\(\)\)/u,
  );
  assert.match(
    source,
    /aria-label=\{archivePresentation\(\)\.accessibleName\}[\s\S]*?title=\{archivePresentation\(\)\.title\}[\s\S]*?disabled=\{archivePresentation\(\)\.disabled\}/u,
  );
  assert.match(
    projectRailSource,
    /<button[\s\S]*?type="button"[\s\S]*?class="[^"]*open-project-button[^"]*"[\s\S]*?commonCopy\.openProject[\s\S]*?<\/button>/u,
  );
  assert.equal(commonCopy.openProject, "Open Project…");
  assert.match(source, /props\.bridge\.openProject\(\)/u);
  assert.match(
    projectRailSource,
    /<button[\s\S]*?type="button"[\s\S]*?class="[^"]*create-project-button[^"]*"[\s\S]*?commonCopy\.createProject[\s\S]*?<\/button>/u,
  );
  assert.equal(commonCopy.createProject, "Create Project…");
  assert.match(source, /props\.bridge\.createProject\(\)/u);
  assert.match(
    source,
    /aria-busy=\{[\s\S]*?props\.projectOpen\.phase === "pending"[\s\S]*?props\.projectOpen\.operation === "open"/u,
  );
  assert.match(
    projectRailSource,
    /\{railCopy\.popoverFoot\}/u,
  );
  assert.equal(
    railCopy.popoverFoot,
    "Choosing a directory trusts that Project for the existing Full access mode. Full paths stay private.",
  );
  assert.match(
    source,
    /kind === "endpoint" && props\.profile\.phase === "idle"[\s\S]*?props\.onLoadProfile\(\)/u,
  );
  assert.doesNotMatch(rendererSource, /onFocus=/u);
  assert.match(
    composerSource,
    /composerFeedbackCopy\.endpointsReadOnOpen/u,
  );
  assert.equal(
    composerFeedbackCopy.endpointsReadOnOpen,
    "Endpoints are read when you open the picker. Nothing runs before that.",
  );
  assert.match(
    mountSource,
    /const enterNewSession = \(\): void => \{[\s\S]*?enterNewAgentSessionMode\(current\)/u,
  );
  assert.doesNotMatch(
    mountSource,
    /onEnterNewSession=\{[^}]*loadDirectSessionProfile/u,
  );
  assert.doesNotMatch(stylesSource, /\.chip\.locked-mode/u);
  assert.match(
    stylesSource,
    /\.profile-popover\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*10000;[\s\S]*?max-width:\s*min\(400px, calc\(100vw - 80px\)\)/u,
  );
  assert.doesNotMatch(stylesSource, /\.profile-popover\s*\{[^}]*bottom:/u);
  assert.equal(/<input[^>]+(?:path|directory)/iu.test(rendererSource), false);
  assert.match(inspectorSource, /\{inspectorCopy\.independenceNote\}/u);
  assert.match(inspectorCopy.independenceNote, /Execution Mode/u);
  assert.match(inspectorCopy.independenceNote, /Access Mode/u);
  assert.match(mountSource, /selectDirectExecutionMode\(current, key\)/u);
  assert.match(mountSource, /selectDirectAccessMode\(current, key\)/u);
  assert.doesNotMatch(composerSource, /InteractiveFixedModeChip|FixedModePopover/u);
  assert.match(inspectorCopy.independenceNote, /downgraded silently/u);
  assert.match(
    inspectorSource,
    /control\?\.provenance === "runtime-catalog"[\s\S]*?control\.label/u,
  );
  assert.match(inspectorSource, /\{inspectorCopy\.effectiveSection\}/u);
  assert.equal(inspectorCopy.effectiveSection, "Effective");
  assert.match(inspectorSource, /\{inspectorCopy\.postTurnQualifier\}/u);
  assert.equal(inspectorCopy.postTurnQualifier, "Post-turn");
  assert.match(
    inspectorSource,
    /matchesRequestedCopy\(value\.label\)[\s\S]*?differsFromRequestedCopy\(dynamicCopy\.observedDifferentValue\)/u,
  );
  assert.equal(matchesRequestedCopy("Profile"), "Profile · matches requested");
  assert.equal(
    differsFromRequestedCopy("Profile"),
    "Profile · differs from requested",
  );
  assert.match(
    inspectorSource,
    /effective\.kind === "unknown"[\s\S]*?observationPending[\s\S]*?inspectorCopy\.pendingObservationValue[\s\S]*?inspectorCopy\.unobservedValue/u,
  );
  assert.equal(inspectorCopy.unobservedValue, "Not observed");
  assert.equal(inspectorCopy.pendingObservationValue, "Pending observation");
  assert.match(
    mountSource,
    /const initialWorkbenchAppearance = defaultWorkbenchAppearancePreference/u,
  );
  assert.deepEqual(defaultWorkbenchAppearancePreference, {
    tone: "dark",
    crt: "screen",
    phosphor: "neutral",
    phosphorTier: "b",
    language: "en",
  });
  assert.match(mountSource, /setAttribute\("data-skin", "acrylic"\)/u);
  assert.match(mountSource, /setAttribute\("data-glass", "full"\)/u);
  assert.match(mountSource, /setAttribute\("data-tone", "light"\)/u);
  assert.match(mountSource, /removeAttribute\("data-tone"\)/u);
  assert.match(
    mountSource,
    /setAttribute\("data-crt", appearance\.crt\)/u,
  );
  assert.match(mountSource, /removeAttribute\("data-crt"\)/u);
  assert.match(
    mountSource,
    /setAttribute\("data-phosphor", appearance\.phosphor\)/u,
  );
  assert.match(
    mountSource,
    /setAttribute\("data-phosphor-tier", appearance\.phosphorTier\)/u,
  );
  assert.match(mountSource, /removeAttribute\("data-scheme"\)/u);
  assert.doesNotMatch(
    mountSource,
    /(?:setAttribute|removeAttribute)\("data-material"/u,
  );
  assert.match(
    acrylicSource,
    /:root\[data-skin~="acrylic"\]:not\(\[data-material="on"\]\) body::before/u,
  );
  assert.match(
    acrylicSource,
    /:root\[data-skin~="acrylic"\]\[data-tone="light"\]:not\(\[data-material="on"\]\) body::before/u,
  );
  assert.doesNotMatch(
    mountSource,
    /WorkbenchAppearanceScheme|appearanceSchemes|crtEnabled|acrylicEnabled|value: "campbell"/u,
  );
  assert.match(settingsSource, /<h1>\{settingsCopy\.title\}<\/h1>/u);
  assert.equal(settingsCopy.title, "Settings");
  assert.match(settingsSource, /aria-label=\{settingsCopy\.closeAria\}/u);
  assert.equal(settingsCopy.closeAria, "Close Settings");
  assert.match(
    projectRailSource,
    /settings-rail-button[\s\S]*?aria-label=\{railCopy\.settingsLabel\}[\s\S]*?aria-current=\{footPresentation\(\)\.settingsCurrent/u,
  );
  assert.equal(railCopy.settingsLabel, "Settings");
  assert.match(transcriptSource, /groupTimelineEvents/u);
  assert.match(
    transcriptSearchSource,
    /export function groupTimelineEvents/u,
  );
  assert.match(transcriptSource, /<span class="caret" aria-hidden="true"/u);
  assert.match(transcriptSource, /agentMessageBlocks/u);
});

test("renderer turn grouping does not create a phantom trailing lifecycle turn", async () => {
  const [transcriptSearchSource, transcriptSource] = await Promise.all(
    [
      "../../src/workbench-shell/renderer/transcript-search.ts",
      "../../src/workbench-shell/renderer/transcript.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const grouping = transcriptSearchSource.slice(
    transcriptSearchSource.indexOf("export function groupTimelineEvents"),
    transcriptSearchSource.indexOf("export function filterTranscriptGroups"),
  );

  assert.match(
    grouping,
    /event\.kind === "turn-started"[\s\S]*?current\.some[\s\S]*?flush\(\)/u,
  );
  assert.match(grouping, /current\.push\(event\);[\s\S]*?flush\(\);/u);
  assert.doesNotMatch(grouping, /turn-completed|failed/u);
  assert.match(
    transcriptSource,
    /event\.kind === "failed"[\s\S]*?return "failed"[\s\S]*?event\.kind === "turn-completed"/u,
  );
});

test("every Settings navigation latch has a Project-surface counterpart", async () => {
  const [mountSource, settingsSource] = await Promise.all(
    [
      "../../src/workbench-shell/renderer/mount.tsx",
      "../../src/workbench-shell/renderer/settings.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const changeSurface = mountSource.slice(
    mountSource.indexOf("const changeSurface"),
    mountSource.indexOf("const selectCommand"),
  );
  const selectCommandSource = mountSource.slice(
    mountSource.indexOf("const selectCommand"),
    mountSource.indexOf("const cancelNewSession"),
  );
  const selectProjectSource = mountSource.slice(
    mountSource.indexOf("const selectHostedProject"),
    mountSource.indexOf("const openProject"),
  );
  assert.match(
    changeSurface,
    /surface\(\) === "settings" && nextSurface === "settings"[\s\S]*?"project"/u,
    "the sole Settings entry is also a toggle exit",
  );
  assert.match(
    changeSurface,
    /destination === "settings"[\s\S]*?refreshDirectSessionProfileFromProviders\(\);[\s\S]*?refreshSubscriptionAuthentication\(\);/u,
    "a Settings visit starts the independent catalog and auth reads",
  );
  assert.match(selectCommandSource, /setSurface\("project"\);/u);
  assert.match(selectProjectSource, /setSurface\("project"\);/u);
  assert.match(
    mountSource,
    /<SettingsScreen[\s\S]*?onClose=\{\(\) => props\.onSurface\("project"\)\}/u,
  );
  assert.match(
    settingsSource,
    /aria-label=\{settingsCopy\.closeAria\}[\s\S]*?onClick=\{props\.onClose\}/u,
  );
  assert.equal(settingsCopy.closeAria, "Close Settings");
});

test("renderer context ring presents only a known positive window", () => {
  assert.equal(contextRingPresentation(undefined, true), null);
  assert.equal(
    contextRingPresentation({ usedTokens: 12_000, windowTokens: null }, true),
    null,
  );
  assert.equal(
    contextUsedTokensLabel({ usedTokens: 12_000, windowTokens: null }),
    "12,000 tokens used",
  );
  assert.equal(
    contextRingPresentation(
      { usedTokens: 122_000, windowTokens: 200_000 },
      false,
    ),
    null,
  );
  assert.equal(
    contextRingPresentation({ usedTokens: 0, windowTokens: 0 }, true),
    null,
  );
  assert.deepEqual(
    contextRingPresentation(
      { usedTokens: 122_000, windowTokens: 200_000 },
      true,
    ),
    {
      usedPercent: 61,
      remainingPercent: 39,
      remainingTokens: 78_000,
      state: "normal",
      title:
        "Context window · 78,000 of 200,000 tokens remaining (61% used)",
      ariaLabel: "Context window 61 percent used",
    },
  );
});

test("renderer saves the selected profile only through the explicit default action", () => {
  const drafted = updateDirectInputDraft(
    readyState(),
    "Keep this draft while the default is saved.",
  );
  const selectedModel = selectDirectModel(drafted, "model-2");
  const selected = selectDirectWorkIntensity(
    selectedModel,
    "intensity-medium",
  );
  const selectedEndpointDiscovery = selected.profile.result?.endpointDiscovery;
  assert.ok(selectedEndpointDiscovery);
  assert.equal(canUseDirectSessionProfileAsDefault(selected), true);

  const first = beginDirectSessionProfileDefaultSave(selected);
  const duplicate = beginDirectSessionProfileDefaultSave(first.state);
  const ignoredSelection = selectDirectModel(first.state, "model-1");

  assert.deepEqual(first.request, {
    snapshotKey: "snapshot-1",
    endpointKey: "endpoint-1",
    modelKey: "model-2",
    workIntensityKey: "intensity-medium",
    executionModeKey: "execution-1",
    accessModeKey: "access-1",
  });
  assert.equal(Object.isFrozen(first.request), true);
  assert.equal(first.state.profile.defaultPreference.phase, "pending");
  assert.equal(canUseDirectSessionProfileAsDefault(first.state), false);
  assert.equal(canSubmitDirectInput(first.state), false);
  assert.equal(duplicate.request, null);
  assert.equal(duplicate.state, first.state);
  assert.equal(ignoredSelection, first.state);
  assert.equal(first.state.composer.draft, drafted.composer.draft);
  assert.equal(
    first.state.profile.result?.endpointDiscovery,
    selectedEndpointDiscovery,
  );

  const failed = completeDirectSessionProfileDefaultSave(
    first.state,
    preferenceUnavailable(),
  );
  assert.equal(failed.profile.defaultPreference.phase, "error");
  assert.equal(
    presentationText(failed.profile.defaultPreference.feedback),
    "Codex Session Profile default could not be durably saved. Keep your selection and try again.",
  );
  assert.equal(
    typeof failed.profile.defaultPreference.feedback === "string"
      ? null
      : failed.profile.defaultPreference.feedback?.key,
    "profile.default-unavailable",
  );
  assert.equal(failed.profile.selectedModelKey, "model-2");
  assert.equal(failed.profile.selectedWorkIntensityKey, "intensity-medium");
  assert.equal(failed.composer.draft, drafted.composer.draft);
  assert.equal(failed.profile.selectedAccessModeKey, "access-1");
  assert.equal(
    failed.profile.result?.endpointDiscovery,
    selectedEndpointDiscovery,
  );

  const retry = beginDirectSessionProfileDefaultSave(failed);
  const saved = completeDirectSessionProfileDefaultSave(retry.state, {
    ok: true,
    status: "saved",
    message: "Session Profile default was durably saved.",
  });
  assert.equal(saved.profile.defaultPreference.phase, "saved");
  assert.equal(
    presentationText(saved.profile.defaultPreference.feedback),
    "Session Profile default was durably saved.",
  );
  assert.equal(
    typeof saved.profile.defaultPreference.feedback === "string"
      ? null
      : saved.profile.defaultPreference.feedback?.key,
    "profile.default-saved",
  );
  assert.deepEqual(
    saved.profile.result?.ok
      ? "desiredDefault" in saved.profile.result.profile
        ? saved.profile.result.profile.desiredDefault
        : undefined
      : undefined,
    {
      kind: "resolved",
      endpointKey: "endpoint-1",
      modelKey: "model-2",
      workIntensityKey: "intensity-medium",
      executionModeKey: "execution-1",
      accessModeKey: "access-1",
    },
  );
  assert.equal(saved.composer.draft, drafted.composer.draft);
  assert.equal(
    saved.profile.result?.endpointDiscovery,
    selectedEndpointDiscovery,
  );
  assert.deepEqual(saved.profile.result?.endpointDiscovery.statuses, [
    { endpointId: "codex-desktop", category: "catalog-ready" },
    {
      endpointId: "claude-code-desktop",
      category: "runtime-not-located",
    },
  ]);
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.profile.defaultPreference), true);
});

test("renderer shows and enforces a catalog-declared Execution Mode implication without coupling Access", () => {
  const loaded = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    coupledProfileResult(),
  );
  assert.equal(loaded.profile.selectedExecutionModeKey, "execution-1");

  const coupled = selectDirectWorkIntensity(
    loaded,
    "intensity-coordinated",
  );
  assert.equal(coupled.profile.selectedWorkIntensityKey, "intensity-coordinated");
  assert.equal(coupled.profile.selectedExecutionModeKey, "execution-2");
  assert.equal(coupled.profile.selectedAccessModeKey, "access-1");
  assert.equal(
    selectDirectExecutionMode(coupled, "execution-1"),
    coupled,
  );

  const independent = selectDirectWorkIntensity(coupled, "intensity-focused");
  assert.equal(independent.profile.selectedExecutionModeKey, "execution-1");
  assert.equal(independent.profile.selectedAccessModeKey, "access-1");
  assert.equal(
    JSON.stringify(profileResult()).includes("impliedExecutionModeKey"),
    false,
  );
});

test("renderer replaces live views while keeping selection stable with deterministic fallback", () => {
  const command1 = command("command-1", "Agent Session 01");
  const command2 = command("command-2", "Agent Session 02");
  const command3 = command("command-3", "Agent Session 03");
  const first = result(view(1, [command1, command2], "command-1"));
  const later = result(view(5, [command2, command3], "command-2"));
  const fallback = result(view(8, [command3], "command-3"));

  const firstState = replaceProjectResult(initialRendererState, first);
  const selectedState = selectProjectCommand(firstState, "command-2");
  const stableState = replaceProjectResult(selectedState, later);
  const fallbackState = replaceProjectResult(stableState, fallback);

  assert.equal(firstState.selectedKey, "command-1");
  if (!hasHostedProjectView(first)) assert.fail("Expected a Project view.");
  assert.equal(selectedCommand(first.view, selectedState.selectedKey)?.key, "command-2");
  assert.equal(stableState.selectedKey, "command-2");
  assert.equal(stableState.result, later);
  assert.equal(stableState.profile, selectedState.profile);
  assert.equal(fallbackState.selectedKey, "command-3");
  assert.equal(fallbackState.result, fallback);
  assert.equal(Object.isFrozen(fallbackState), true);
});

test("archiving the selected row chooses an active fallback and keeps an all-archived Project usable", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "Model One",
    "Deep",
    "00000000-0000-4000-8000-000000000081",
  );
  const second = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "Model Two",
    "Deep",
    "00000000-0000-4000-8000-000000000082",
  );
  const archived = (source: WorkbenchCommandView): WorkbenchCommandView => ({
    ...source,
    session: {
      ...source.session!,
      archived: true,
      resumable: false,
      selectionKey: null,
    },
  });
  const initial = replaceProjectResult(
    initialRendererState,
    result(view(1, [first, second], first.key)),
  );
  const firstArchived = replaceProjectResult(
    initial,
    result(view(2, [archived(first), second], first.key)),
  );
  assert.equal(firstArchived.selectedKey, second.key);
  assert.equal(selectedCommand(hasHostedProjectView(firstArchived.result)
    ? firstArchived.result!.view
    : view(0, [], null), firstArchived.selectedKey)?.session?.archived, false);

  const allArchived = replaceProjectResult(
    firstArchived,
    result(view(3, [archived(first), archived(second)], first.key)),
  );
  assert.equal(allArchived.selectedKey, second.key);
  assert.equal(selectedCommand(hasHostedProjectView(allArchived.result)
    ? allArchived.result!.view
    : view(0, [], null), allArchived.selectedKey)?.session?.archived, true);
  assert.deepEqual(
    selectedCommand(hasHostedProjectView(allArchived.result)
      ? allArchived.result!.view
      : view(0, [], null), allArchived.selectedKey)?.session?.timeline,
    second.session?.timeline,
  );

  const restored = replaceProjectResult(
    allArchived,
    result(view(4, [archived(first), second], second.key)),
  );
  assert.equal(restored.selectedKey, second.key);
  assert.equal(selectedCommand(hasHostedProjectView(restored.result)
    ? restored.result!.view
    : view(0, [], null), restored.selectedKey)?.session?.archived, false);
});

test("renderer copy is explicitly live same-channel direct Agent Runtime submission", () => {
  assert.deepEqual(liveWorkbenchCopy, {
    pill: "Live · direct Agent Runtime",
    projectContext: "One live Project",
    footerFollow: "Same-channel durable follow",
    footerMode: "Direct submission",
  });
  assert.equal(
    directInputCopy.hint,
    "Starts a new Agent Session · Ctrl/⌘ + Enter",
  );
  assert.equal(
    directInputCopy.placeholder,
    "Describe the task. Ctrl+Enter to start the Session.",
  );
  assert.equal(continuationInputCopy.placeholder, "Reply to this Agent Session…");
  assert.equal(statusCopy.accepted, "Accepted");
  assert.equal(statusCopy["in-flight"], "Running");
  const serialized = JSON.stringify({
    liveWorkbenchCopy,
    directInputCopy,
    statusCopy,
  });
  assert.equal(/captured|finite|not live|read only/iu.test(serialized), false);
});

test("renderer prevents invalid and pending duplicate submissions then clears on durable acceptance", () => {
  const emptyAttempt = beginDirectInputSubmission(initialRendererState);
  assert.equal(emptyAttempt.request, null);
  assert.equal(emptyAttempt.state, initialRendererState);
  const drafted = updateDirectInputDraft(
    readyState(),
    "Start a bounded implementation.",
  );
  assert.equal(canSubmitDirectInput(drafted), true);

  const firstAttempt = beginDirectInputSubmission(drafted);
  const duplicateAttempt = beginDirectInputSubmission(firstAttempt.state);
  const ignoredEdit = updateDirectInputDraft(
    firstAttempt.state,
    "A second local draft must not replace pending input.",
  );
  const ignoredProfileChange = selectDirectModel(
    firstAttempt.state,
    "model-2",
  );

  assert.deepEqual(firstAttempt.request, {
    kind: "start",
    input: "Start a bounded implementation.",
    snapshotKey: "snapshot-1",
    endpointKey: "endpoint-1",
    modelKey: "model-1",
    workIntensityKey: "intensity-high",
    executionModeKey: "execution-1",
    accessModeKey: "access-1",
  });
  assert.equal(Object.isFrozen(firstAttempt.request), true);
  assert.equal(firstAttempt.state.composer.phase, "pending");
  assert.equal(canSubmitDirectInput(firstAttempt.state), false);
  assert.equal(duplicateAttempt.request, null);
  assert.equal(duplicateAttempt.state, firstAttempt.state);
  assert.equal(ignoredEdit, firstAttempt.state);
  assert.equal(ignoredProfileChange, firstAttempt.state);

  const acceptedCommand = command(
    "command-1",
    "Agent Session 01",
    "accepted",
  );
  const liveAccepted = replaceProjectResult(
    firstAttempt.state,
    result(view(1, [acceptedCommand], "command-1")),
  );
  const accepted = completeDirectInputSubmission(
    liveAccepted,
    acceptedSubmission(),
  );

  assert.equal(liveAccepted.selectedKey, "command-1");
  assert.equal(liveAccepted.composer.phase, "pending");
  assert.equal(accepted.composer.draft, "");
  assert.equal(accepted.composer.phase, "accepted");
  assert.equal(
    presentationText(accepted.composer.feedback),
    "Direct input was durably accepted.",
  );
  assert.equal(
    typeof accepted.composer.feedback === "string"
      ? null
      : accepted.composer.feedback?.key,
    "submission.accepted",
  );
  if (!hasHostedProjectView(accepted.result)) assert.fail("Expected a Project view.");
  assert.equal(
    selectedCommand(
      accepted.result.view,
      accepted.selectedKey,
    )?.status,
    "accepted",
  );
  const nextDraft = updateDirectInputDraft(accepted, "A later instruction.");
  assert.equal(nextDraft.composer.phase, "idle");
  assert.equal(canSubmitDirectInput(nextDraft), false);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.composer), true);
});

test("renderer preserves the local draft on fixed rejection and blocks malformed text", () => {
  const malformedDrafts = [
    " \n\t ",
    "x".repeat(8_001),
    `broken-${String.fromCharCode(0xd800)}`,
  ];
  for (const draft of malformedDrafts) {
    const state = updateDirectInputDraft(initialRendererState, draft);
    const ready = updateDirectInputDraft(readyState(), draft);
    assert.equal(canSubmitDirectInput(state), false);
    assert.equal(canSubmitDirectInput(ready), false);
    assert.equal(beginDirectInputSubmission(ready).request, null);
  }

  const draft = "Keep this draft if durable acceptance fails.";
  const pending = beginDirectInputSubmission(
    updateDirectInputDraft(readyState(), draft),
  ).state;
  const failed = completeDirectInputSubmission(pending, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  });

  assert.equal(failed.composer.draft, draft);
  assert.equal(failed.composer.phase, "error");
  assert.equal(
    presentationText(failed.composer.feedback),
    "Direct input could not be durably accepted. Keep your draft and try again.",
  );
  assert.equal(
    typeof failed.composer.feedback === "string"
      ? null
      : failed.composer.feedback?.key,
    "submission.unavailable",
  );
  assert.equal(canSubmitDirectInput(failed), true);
});

test("renderer helpers preserve empty, failed, and recovery-required states", () => {
  const empty = view(0, [], null);
  assert.equal(selectedCommand(empty, null), undefined);
  const failed = command("command-1", "Agent Session 01", "failed");
  const recovery = command(
    "command-2",
    "Agent Session 02",
    "recovery-required",
  );
  const projectView = view(4, [failed, recovery], "command-1");

  assert.equal(selectedCommand(projectView, null)?.status, "failed");
  assert.equal(
    selectedCommand(projectView, "command-2")?.status,
    "recovery-required",
  );
  assert.equal(statusCopy.failed, "Failed");
  assert.equal(statusCopy["recovery-required"], "Recovery required");
  assert.equal(
    failureCopy["runtime-failed"],
    "The Agent Runtime reported a fixed failure category.",
  );
});

test("a completed first turn owes the selected Session its continuation capability so a second message is submittable (F219)", () => {
  /* The path a second message is actually written on: one Project, one start
     turn, and no restart. Worker 466 measured Send disabled here for 55 s and
     across five attempts, with no title, no aria-disabled and no reason line,
     because the continuation capability was never loaded and never asked for. */
  const empty = replaceProjectResult(
    initialRendererState,
    result(view(6, [], null)),
  );
  assert.equal(directInputMode(empty), "start");
  const firstDraft = updateDirectInputDraft(
    empty,
    "请用中文回答：Electron 的主进程和渲染进程有什么区别？",
  );
  const started = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(firstDraft),
    profileResult(),
  );
  assert.equal(started.profile.phase, "ready");
  assert.equal(canSubmitDirectInput(started), true);
  const submitted = beginDirectInputSubmission(started);
  assert.notEqual(submitted.request, null);
  const accepted = completeDirectInputSubmission(
    submitted.state,
    acceptedSubmission(),
  );

  const resumable = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000156",
  );
  const settled = replaceProjectResult(
    accepted,
    result(view(7, [resumable], resumable.key)),
  );
  const continuing = updateDirectInputDraft(
    settled,
    "接着你上面的回答：把你刚才那段代码改写成 TypeScript。",
  );

  /* The trap, stated exactly: the target bar already says this Session will be
     continued, and the profile is `ready` — but ready holding the
     `catalog-default` request that started the Session, which is not the
     continuation request Send requires. */
  assert.equal(directInputMode(continuing), "continue");
  assert.equal(continuing.profile.phase, "ready");
  assert.equal(continuing.profile.loadRequest?.kind, "catalog-default");
  assert.equal(canSubmitDirectInput(continuing), false);

  /* So the renderer still owes this Session a continuation load, and owing it
     is not conditional on the profile being untouched. */
  const owed = pendingContinuationDirectSessionProfileLoad(continuing);
  assert.deepEqual(owed, {
    kind: "continuation-session",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000156",
  });

  const ready = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(continuing, owed!),
    continuationProfileResult(),
    owed!,
  );
  assert.equal(canSubmitDirectInput(ready), true);
  assert.equal(
    beginDirectInputSubmission(ready).request?.kind,
    "continue",
  );

  /* Once loaded it is not owed again, so the effect that issues it cannot
     loop, and a third message stays submittable. */
  assert.equal(pendingContinuationDirectSessionProfileLoad(ready), null);
  assert.equal(
    pendingContinuationDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(ready, owed!),
    ),
    null,
  );

  /* Selecting a different Session owes a fresh capability rather than reusing
     the one already loaded. */
  const other = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000157",
  );
  const switched = selectProjectCommand(
    replaceProjectResult(ready, result(view(8, [resumable, other], resumable.key))),
    other.key,
  );
  assert.deepEqual(pendingContinuationDirectSessionProfileLoad(switched), {
    kind: "continuation-session",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000157",
  });
});

test("the renderer wires the continuation capability it owes, not a one-shot idle load (F219)", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
    "utf8",
  );
  /* The effect must ask what is owed. Reinstating an idle-profile gate here is
     exactly what left Send permanently disabled after a completed turn. */
  assert.equal(
    source.includes("pendingContinuationDirectSessionProfileLoad(current)"),
    true,
  );
  assert.equal(source.includes('current.profile.phase !== "idle"'), false);
});

test("renderer loads a fresh same-endpoint continuation capability and submits changed opaque model and intensity keys", () => {
  const resumable = command(
    "command-1",
    "Agent Session 01",
    "completed",
  );
  const withSession: WorkbenchCommandView = {
    ...resumable,
    session: {
      archived: false,
      metadataKey:
        "session-metadata:00000000-0000-4000-8000-000000000704",
      profile: recordedProfileProjection("gpt-5.6-sol", "ultra"),
      timeline: [{ kind: "turn-completed", status: "completed" }],
      removalKey:
        "session-removal:00000000-0000-4000-8000-000000000704",
      resumable: true,
      selectionKey:
        "session-selection:00000000-0000-4000-8000-000000000011",
    },
  };
  const selected = replaceProjectResult(
    initialRendererState,
    result(view(7, [withSession], withSession.key)),
  );
  const drafted = updateDirectInputDraft(selected, "Continue this bounded task.");
  assert.equal(directInputMode(drafted), "continue");
  assert.equal(canSubmitDirectInput(drafted), false);
  assert.equal(canUseDirectSessionProfileAsDefault(drafted), false);
  const loadRequest = continuationDirectSessionProfileLoadRequest(drafted);
  assert.deepEqual(loadRequest, {
    kind: "continuation-session",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000011",
  });
  const loading = beginDirectSessionProfileLoad(drafted, loadRequest!);
  assert.equal(loading.profile.phase, "loading");
  assert.equal(canSubmitDirectInput(loading), false);
  const ready = completeDirectSessionProfileLoad(
    loading,
    continuationProfileResult(),
    loadRequest!,
  );
  assert.deepEqual(
    {
      endpoint: ready.profile.selectedEndpointKey,
      model: ready.profile.selectedModelKey,
      intensity: ready.profile.selectedWorkIntensityKey,
      execution: ready.profile.selectedExecutionModeKey,
      access: ready.profile.selectedAccessModeKey,
    },
    {
      endpoint: "endpoint-claude",
      model: "model-fable",
      intensity: "intensity-low",
      execution: "execution-fixed",
      access: "access-fixed",
    },
  );
  assert.equal(canSubmitDirectInput(ready), true);

  const providerLocked = selectDirectEndpoint(ready, "endpoint-forged");
  const executionLocked = selectDirectExecutionMode(
    ready,
    "execution-forged",
  );
  assert.equal(providerLocked, ready);
  assert.equal(executionLocked, ready);

  const opusDefault = selectDirectModel(ready, "model-opus");
  assert.equal(opusDefault.profile.selectedModelKey, "model-opus");
  assert.equal(opusDefault.profile.selectedWorkIntensityKey, "intensity-max");
  assert.equal(opusDefault.profile.selectedExecutionModeKey, "execution-fixed");
  assert.equal(canSubmitDirectInput(opusDefault), false);
  const changed = selectDirectWorkIntensity(opusDefault, "intensity-high");
  assert.equal(canSubmitDirectInput(changed), true);
  const ultracode = selectDirectWorkIntensity(changed, "intensity-ultracode");
  assert.equal(ultracode.profile.selectedExecutionModeKey, "execution-fixed");
  assert.equal(ultracode.profile.selectedAccessModeKey, "access-fixed");
  assert.equal(canSubmitDirectInput(ultracode), true);
  const maximum = selectDirectWorkIntensity(
    ultracode,
    "intensity-ordinary-max",
  );
  assert.equal(maximum.profile.selectedExecutionModeKey, "execution-fixed");
  assert.equal(maximum.profile.selectedAccessModeKey, "access-fixed");
  assert.equal(canSubmitDirectInput(maximum), true);
  const withoutXhigh = selectDirectModel(maximum, "model-fable");
  assert.equal(withoutXhigh.profile.selectedWorkIntensityKey, "intensity-low");
  assert.equal(
    selectDirectWorkIntensity(withoutXhigh, "intensity-ultracode"),
    withoutXhigh,
  );
  const switchedBack = selectDirectModel(withoutXhigh, "model-opus");
  assert.equal(switchedBack.profile.selectedWorkIntensityKey, "intensity-max");
  assert.notEqual(
    switchedBack.profile.selectedWorkIntensityKey,
    "intensity-ultracode",
  );
  const attempt = beginDirectInputSubmission(changed);
  assert.deepEqual(attempt.request, {
    kind: "continue",
    input: "Continue this bounded task.",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000011",
    snapshotKey: "snapshot-continuation",
    endpointKey: "endpoint-claude",
    modelKey: "model-opus",
    workIntensityKey: "intensity-high",
    executionModeKey: "execution-fixed",
    accessModeKey: "access-fixed",
  });
  assert.equal(
    presentationText(attempt.state.composer.feedback),
    continuationInputCopy.pending,
  );
  assert.equal(
    typeof attempt.state.composer.feedback === "string"
      ? null
      : attempt.state.composer.feedback?.key,
    "composer.continuation-pending",
  );
  const rejected = completeDirectInputSubmission(attempt.state, {
    ok: false,
    error: {
      category: "continuation-unavailable",
      message:
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    },
  });
  assert.equal(rejected.composer.draft, "Continue this bounded task.");
  assert.equal(rejected.composer.phase, "error");

  const unavailableSession: WorkbenchCommandView = {
    ...withSession,
    status: "recovery-required",
    session: {
      ...withSession.session!,
      resumable: false,
      selectionKey: null,
    },
  };
  const unavailable = updateDirectInputDraft(
    replaceProjectResult(
      initialRendererState,
      result(view(8, [unavailableSession], unavailableSession.key)),
    ),
    "Keep this draft.",
  );
  assert.equal(directInputMode(unavailable), "unavailable");
  assert.equal(unavailableInputCopy.label, "Direct input unavailable");
  assert.match(unavailableInputCopy.hint, /cannot be continued safely/iu);
  assert.equal(canSubmitDirectInput(unavailable), false);
  assert.equal(beginDirectInputSubmission(unavailable).request, null);
  assert.equal(unavailable.composer.draft, "Keep this draft.");
});

test("returning from a Settings catalog refresh reloads the selected continuation capability", () => {
  const selectedSession = resumableSessionCommand(
    "command-1",
    "Settings Round-trip Session",
    "fable-5",
    "low",
    "00000000-0000-4000-8000-000000000031",
  );
  const drafted = updateDirectInputDraft(
    replaceProjectResult(
      initialRendererState,
      result(view(31, [selectedSession], selectedSession.key)),
    ),
    "Continue after reviewing Settings.",
  );
  const settingsLoading = beginDirectSessionProfileRefreshFromProviders(drafted);
  const settingsReady = completeDirectSessionProfileLoad(
    settingsLoading,
    profileResult("resolved"),
    { kind: "catalog-default" },
  );
  assert.equal(settingsReady.profile.phase, "ready");
  assert.deepEqual(settingsReady.profile.loadRequest, {
    kind: "catalog-default",
  });
  assert.equal(canSubmitDirectInput(settingsReady), false);

  const returned = prepareDirectSessionProfileForProjectSurface(settingsReady);
  assert.equal(returned.profile.phase, "idle");
  assert.equal(returned.profile.loadRequest, null);
  assert.equal(returned.composer.draft, drafted.composer.draft);
  const continuationRequest = continuationDirectSessionProfileLoadRequest(returned);
  assert.deepEqual(continuationRequest, {
    kind: "continuation-session",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000031",
  });

  const continuationReady = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(returned, continuationRequest!),
    continuationProfileResult(),
    continuationRequest!,
  );
  assert.equal(continuationReady.profile.phase, "ready");
  assert.equal(
    continuationReady.profile.loadRequest?.kind,
    "continuation-session",
  );
  assert.equal(canSubmitDirectInput(continuationReady), true);
});

test("renderer revokes a continuation catalog on stale capability and prefills each newly selected Session independently", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Fable Session",
    "fable-5",
    "low",
    "00000000-0000-4000-8000-000000000021",
  );
  const second = resumableSessionCommand(
    "command-2",
    "Opus Session",
    "opus-5",
    "high",
    "00000000-0000-4000-8000-000000000022",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(view(21, [first, second], first.key)),
  );
  const firstRequest = continuationDirectSessionProfileLoadRequest(base)!;
  const firstReady = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(base, firstRequest),
    continuationProfileResult(),
    firstRequest,
  );
  assert.equal(firstReady.profile.selectedModelKey, "model-fable");

  const selectedSecond = selectProjectCommand(firstReady, second.key);
  assert.equal(selectedSecond.profile.phase, "idle");
  const secondRequest = continuationDirectSessionProfileLoadRequest(
    selectedSecond,
  );
  assert.deepEqual(secondRequest, {
    kind: "continuation-session",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000022",
  });
  const secondReady = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(selectedSecond, secondRequest!),
    continuationProfileResult("model-opus", "intensity-high"),
    secondRequest!,
  );
  assert.equal(secondReady.profile.selectedModelKey, "model-opus");
  assert.equal(secondReady.profile.selectedWorkIntensityKey, "intensity-high");

  const staleSecond: WorkbenchCommandView = {
    ...second,
    session: {
      ...second.session!,
      selectionKey:
        "session-selection:00000000-0000-4000-8000-000000000023",
    },
  };
  const invalidated = replaceProjectResult(
    secondReady,
    result(view(22, [first, staleSecond], second.key)),
  );
  assert.equal(invalidated.profile.phase, "idle");
  assert.equal(canSubmitDirectInput(updateDirectInputDraft(invalidated, "next")), false);
});

test("renderer keeps continuation and guidance drafts with the Session they were written for", () => {
  const first = Object.freeze({
    ...resumableSessionCommand(
      "command-1",
      "Running Session",
      "fable-5",
      "low",
      "00000000-0000-4000-8000-000000000041",
    ),
    status: "in-flight" as const,
  });
  const second = resumableSessionCommand(
    "command-2",
    "Completed Session",
    "opus-5",
    "high",
    "00000000-0000-4000-8000-000000000042",
  );
  const selectedFirst = replaceProjectResult(
    initialRendererState,
    result(view(23, [first, second], first.key)),
  );
  const draftedFirst = updateDirectInputDraft(
    selectedFirst,
    "Guidance for the running Session only.",
  );

  const selectedSecond = selectProjectCommand(draftedFirst, second.key);
  assert.equal(selectedSecond.composer.draft, "");
  assert.equal(canSubmitDirectInput(selectedSecond), false);

  const secondProfileRequest = continuationDirectSessionProfileLoadRequest(
    selectedSecond,
  )!;
  const secondReady = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(selectedSecond, secondProfileRequest),
    continuationProfileResult("model-opus", "intensity-high"),
    secondProfileRequest,
  );
  const draftedSecond = updateDirectInputDraft(
    secondReady,
    "Reply for the completed Session only.",
  );
  const secondSubmission = beginDirectInputSubmission(draftedSecond);
  assert.deepEqual(secondSubmission.request, {
    kind: "continue",
    input: "Reply for the completed Session only.",
    selectionKey: second.session!.selectionKey,
    snapshotKey: "snapshot-continuation",
    endpointKey: "endpoint-claude",
    modelKey: "model-opus",
    workIntensityKey: "intensity-high",
    executionModeKey: "execution-fixed",
    accessModeKey: "access-fixed",
  });

  const viewedFirstWhileSecondPending = selectProjectCommand(
    secondSubmission.state,
    first.key,
  );
  assert.equal(viewedFirstWhileSecondPending.composer.phase, "pending");
  assert.equal(
    viewedFirstWhileSecondPending.composer.draft,
    "Guidance for the running Session only.",
  );
  const acceptedSecond = completeDirectInputSubmission(
    viewedFirstWhileSecondPending,
    acceptedSubmission(),
  );
  assert.equal(acceptedSecond.composer.phase, "idle");
  const returnedFirst = selectProjectCommand(acceptedSecond, first.key);
  assert.equal(
    returnedFirst.composer.draft,
    "Guidance for the running Session only.",
  );
  const returnedSecond = selectProjectCommand(returnedFirst, second.key);
  assert.equal(returnedSecond.composer.draft, "");
});

test("renderer explicitly enters and leaves New Agent Session mode without losing draft or selection", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000011",
  );
  const second = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000012",
  );
  const selected = replaceProjectResult(
    initialRendererState,
    result(view(9, [first, second], first.key)),
  );
  const drafted = updateDirectInputDraft(
    selected,
    "Keep this draft across the explicit mode change.",
  );

  assert.equal(canEnterNewAgentSessionMode(drafted), true);
  const entered = enterNewAgentSessionMode(drafted);
  assert.equal(entered.newSession.phase, "active");
  assert.equal(directInputMode(entered), "start");
  assert.equal(entered.selectedKey, first.key);
  assert.equal(entered.composer.draft, drafted.composer.draft);
  assert.equal(entered.profile.phase, "idle");

  const loading = beginDirectSessionProfileLoad(entered);
  assert.equal(loading.profile.phase, "loading");
  assert.equal(beginDirectSessionProfileLoad(loading), loading);
  assert.equal(canCancelNewAgentSessionMode(loading), true);
  const loaded = completeDirectSessionProfileLoad(loading, profileResult());
  const returnedBySelection = selectProjectCommand(loaded, second.key);
  assert.equal(returnedBySelection.newSession.phase, "inactive");
  assert.equal(returnedBySelection.composer.draft, drafted.composer.draft);
  assert.equal(returnedBySelection.selectedKey, second.key);
  assert.equal(returnedBySelection.profile.phase, "idle");
  assert.equal(directInputMode(returnedBySelection), "continue");

  const reentered = enterNewAgentSessionMode(returnedBySelection);
  const cancelled = cancelNewAgentSessionMode(reentered);
  assert.equal(cancelled.newSession.phase, "inactive");
  assert.equal(cancelled.composer.draft, drafted.composer.draft);
  assert.equal(cancelled.selectedKey, second.key);
  assert.equal(cancelled.profile.phase, "idle");
  assert.equal(directInputMode(cancelled), "continue");

  const enteredAgain = enterNewAgentSessionMode(cancelled);
  assert.equal(enteredAgain.profile.result, null);
  assert.equal(enteredAgain.profile.phase, "idle");
  assert.equal(enteredAgain.composer.draft, drafted.composer.draft);
});

test("selecting any existing Session exits every New Agent Session phase", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000013",
  );
  const second = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000014",
  );
  const inactive = replaceProjectResult(
    initialRendererState,
    result(view(9, [first, second], first.key)),
  );
  const active = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(
      enterNewAgentSessionMode(
        updateDirectInputDraft(inactive, "Start another Session."),
      ),
    ),
    profileResult(),
  );
  const submitting = beginDirectInputSubmission(active).state;
  const awaitingVisible = completeDirectInputSubmission(
    submitting,
    acceptedSubmission(),
  );

  for (const state of [inactive, active, submitting, awaitingVisible]) {
    for (const target of [first, second]) {
      const returned = selectProjectCommand(state, target.key);
      assert.equal(
        returned.newSession.phase,
        "inactive",
        `${state.newSession.phase} must return through ${target.label}`,
      );
      assert.equal(returned.selectedKey, target.key);
    }
  }

  for (const state of [active, submitting, awaitingVisible]) {
    const returned = cancelNewAgentSessionMode(state);
    assert.equal(
      returned.newSession.phase,
      "inactive",
      `${state.newSession.phase} must return through the explicit affordance`,
    );
    assert.equal(returned.selectedKey, first.key);
  }

  assert.equal(selectProjectCommand(submitting, first.key).composer.phase, "pending");
  assert.equal(
    selectProjectCommand(awaitingVisible, first.key).composer.phase,
    "accepted",
  );

  const third = resumableSessionCommand(
    "command-3",
    "Agent Session 03",
    "gpt-5.6-sol",
    "medium",
    "00000000-0000-4000-8000-000000000015",
  );
  const acceptedAfterReturningDuringSubmission = completeDirectInputSubmission(
    selectProjectCommand(submitting, first.key),
    acceptedSubmission(),
  );
  assert.equal(acceptedAfterReturningDuringSubmission.newSession.phase, "inactive");
  assert.equal(acceptedAfterReturningDuringSubmission.selectedKey, first.key);
  assert.equal(acceptedAfterReturningDuringSubmission.composer.phase, "accepted");
  const visibleAfterReturningDuringSubmission = replaceProjectResult(
    acceptedAfterReturningDuringSubmission,
    result(view(10, [first, second, third], first.key)),
  );
  assert.equal(visibleAfterReturningDuringSubmission.newSession.phase, "inactive");
  assert.equal(visibleAfterReturningDuringSubmission.selectedKey, first.key);

  const visibleAfterReturningWhileAwaiting = replaceProjectResult(
    selectProjectCommand(awaitingVisible, second.key),
    result(view(11, [first, second, third], first.key)),
  );
  assert.equal(visibleAfterReturningWhileAwaiting.newSession.phase, "inactive");
  assert.equal(visibleAfterReturningWhileAwaiting.selectedKey, second.key);
});

test("renderer preserves explicit start on failure and selects one newly visible sanitized Session across both acceptance races", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000021",
  );
  const secondAccepted: WorkbenchCommandView = {
    key: "command-2",
    label: "Agent Session 02",
    runtime: "Codex",
    status: "accepted",
    session: {
      archived: false,
      metadataKey:
        "session-metadata:00000000-0000-4000-8000-000000000705",
      profile: recordedProfileProjection("gpt-5.6-codex", "high"),
      timeline: [],
      removalKey:
        "session-removal:00000000-0000-4000-8000-000000000705",
      resumable: false,
      selectionKey: null,
    },
  };
  const readyExplicitStart = () => {
    const selected = replaceProjectResult(
      initialRendererState,
      result(view(10, [first], first.key)),
    );
    const entered = enterNewAgentSessionMode(
      updateDirectInputDraft(selected, "Start a distinct second Session."),
    );
    return completeDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(entered),
      profileResult(),
    );
  };

  const failureAttempt = beginDirectInputSubmission(readyExplicitStart());
  assert.equal(failureAttempt.state.newSession.phase, "submitting");
  assert.deepEqual(failureAttempt.state.newSession.baselineKeys, [first.key]);
  assert.equal(beginDirectInputSubmission(failureAttempt.state).request, null);
  const rejected = completeDirectInputSubmission(
    failureAttempt.state,
    {
      ok: false,
      error: {
        category: "submission-unavailable",
        message:
          "Direct input could not be durably accepted. Keep your draft and try again.",
      },
    },
  );
  assert.equal(rejected.newSession.phase, "active");
  assert.equal(rejected.composer.draft, "Start a distinct second Session.");
  assert.equal(directInputMode(rejected), "start");
  assert.equal(canCancelNewAgentSessionMode(rejected), true);

  const acceptanceFirstAttempt = beginDirectInputSubmission(
    readyExplicitStart(),
  );
  const awaiting = completeDirectInputSubmission(
    acceptanceFirstAttempt.state,
    acceptedSubmission(),
  );
  assert.equal(awaiting.newSession.phase, "awaiting-visible");
  assert.equal(awaiting.composer.draft, "");
  assert.match(
    presentationText(awaiting.composer.feedback) ?? "",
    /durably accepted/iu,
  );
  assert.equal(directInputMode(awaiting), "unavailable");
  assert.equal(canSubmitDirectInput(awaiting), false);
  const selectedSecond = replaceProjectResult(
    awaiting,
    result(view(11, [first, secondAccepted], first.key)),
  );
  assert.equal(selectedSecond.selectedKey, secondAccepted.key);
  assert.equal(selectedSecond.newSession.phase, "inactive");
  assert.equal(selectedSecond.profile.phase, "idle");
  assert.equal(directInputMode(selectedSecond), "unavailable");

  const completedSecond = resumableSessionCommand(
    secondAccepted.key,
    secondAccepted.label,
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000022",
  );
  const continuableSecond = replaceProjectResult(
    selectedSecond,
    result(view(12, [first, completedSecond], first.key)),
  );
  assert.equal(continuableSecond.selectedKey, completedSecond.key);
  assert.equal(directInputMode(continuableSecond), "continue");

  const viewFirstAttempt = beginDirectInputSubmission(readyExplicitStart());
  const visibleBeforeResult = replaceProjectResult(
    viewFirstAttempt.state,
    result(view(13, [first, secondAccepted], first.key)),
  );
  assert.equal(visibleBeforeResult.selectedKey, secondAccepted.key);
  assert.equal(visibleBeforeResult.newSession.phase, "submitting");
  assert.equal(visibleBeforeResult.newSession.visibleKey, secondAccepted.key);
  const acceptedAfterView = completeDirectInputSubmission(
    visibleBeforeResult,
    acceptedSubmission(),
  );
  assert.equal(acceptedAfterView.selectedKey, secondAccepted.key);
  assert.equal(acceptedAfterView.newSession.phase, "inactive");

  const terminalWithoutSession: WorkbenchCommandView = {
    key: "command-2",
    label: "Direct Command 02",
    runtime: "Codex",
    status: "failed",
    failureCategory: "runtime-failed",
  };
  const terminalAcceptanceFirst = completeDirectInputSubmission(
    beginDirectInputSubmission(readyExplicitStart()).state,
    acceptedSubmission(),
  );
  const recoveredAfterAcceptance = replaceProjectResult(
    terminalAcceptanceFirst,
    result(view(14, [first, terminalWithoutSession], first.key)),
  );
  assert.equal(recoveredAfterAcceptance.selectedKey, terminalWithoutSession.key);
  assert.equal(recoveredAfterAcceptance.newSession.phase, "inactive");
  assert.equal(recoveredAfterAcceptance.composer.phase, "error");
  assert.match(
    presentationText(recoveredAfterAcceptance.composer.feedback) ?? "",
    /durably accepted.*no resumable Session/iu,
  );
  assert.equal(directInputMode(recoveredAfterAcceptance), "unavailable");
  assert.equal(canEnterNewAgentSessionMode(recoveredAfterAcceptance), true);

  const terminalViewFirstAttempt = beginDirectInputSubmission(
    readyExplicitStart(),
  );
  const terminalBeforeAcceptance = replaceProjectResult(
    terminalViewFirstAttempt.state,
    result(view(15, [first, terminalWithoutSession], first.key)),
  );
  assert.equal(terminalBeforeAcceptance.selectedKey, terminalWithoutSession.key);
  assert.equal(terminalBeforeAcceptance.newSession.phase, "submitting");
  assert.equal(
    terminalBeforeAcceptance.newSession.visibleKey,
    terminalWithoutSession.key,
  );
  const recoveredAfterView = completeDirectInputSubmission(
    terminalBeforeAcceptance,
    acceptedSubmission(),
  );
  assert.equal(recoveredAfterView.newSession.phase, "inactive");
  assert.equal(recoveredAfterView.composer.phase, "error");
  assert.match(
    presentationText(recoveredAfterView.composer.feedback) ?? "",
    /durably accepted.*no resumable Session/iu,
  );

  const ambiguousAttempt = beginDirectInputSubmission(readyExplicitStart());
  const ambiguousAwaiting = completeDirectInputSubmission(
    ambiguousAttempt.state,
    acceptedSubmission(),
  );
  const thirdAccepted: WorkbenchCommandView = {
    ...secondAccepted,
    key: "command-3",
    label: "Agent Session 03",
  };
  const ambiguous = replaceProjectResult(
    ambiguousAwaiting,
    result(view(16, [first, secondAccepted, thirdAccepted], first.key)),
  );
  assert.equal(ambiguous.selectedKey, first.key);
  assert.equal(ambiguous.newSession.phase, "awaiting-visible");
  assert.equal(canSubmitDirectInput(ambiguous), false);
});

test("Project switching carries any draft but still blocks relevant pending actions and invalid targets", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000081",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(20, [first], first.key, 0, "available")),
  );
  assert.equal(canSelectProject(base, 1), true);
  assert.equal(canSelectProject(base, 0), false);
  assert.equal(canSelectProject(base, -1), false);
  assert.equal(canSelectProject(base, 99), false);

  assert.equal(
    canSelectProject(updateDirectInputDraft(base, "Keep this draft."), 1),
    true,
  );
  assert.equal(
    canSelectProject(updateDirectInputDraft(base, " "), 1),
    true,
  );
  const loading = beginDirectSessionProfileLoad(
    enterNewAgentSessionMode(base),
  );
  assert.equal(loading.profile.phase, "loading");
  assert.equal(canSelectProject(loading, 1), false);
  const ready = completeDirectSessionProfileLoad(loading, profileResult());
  const saving = beginDirectSessionProfileDefaultSave(ready).state;
  assert.equal(saving.profile.defaultPreference.phase, "pending");
  assert.equal(canSelectProject(saving, 1), false);
  const composerPending = {
    ...base,
    composer: { draft: "", phase: "pending" as const, feedback: null },
  };
  assert.equal(canSelectProject(composerPending, 1), false);
  const startPending = {
    ...base,
    newSession: {
      phase: "submitting" as const,
      baselineKeys: [first.key],
      visibleKey: null,
    },
  };
  assert.equal(canSelectProject(startPending, 1), false);
  const awaitingVisible = {
    ...base,
    newSession: {
      phase: "awaiting-visible" as const,
      baselineKeys: [first.key],
      visibleKey: null,
    },
  };
  assert.equal(canSelectProject(awaitingVisible, 1), false);

  const missing = replaceProjectResult(
    base,
    result(twoProjectView(21, [first], first.key, 0, "missing")),
  );
  assert.equal(canSelectProject(missing, 1), false);
  const unavailableSelected = replaceProjectResult(
    base,
    result(twoProjectView(22, [], null, 1, "missing")),
  );
  assert.equal(directInputMode(unavailableSelected), "unavailable");
  assert.equal(canSubmitDirectInput(unavailableSelected), false);
  assert.equal(canSelectProject(unavailableSelected, 0), true);
});

test("Open Project uses the switching gates, preserves state on cancel or failure, and resets only when a successful target view arrives", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000084",
  );
  const second = resumableSessionCommand(
    "command-7",
    "Agent Session 07",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000085",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(40, [first], first.key, 0, "available")),
  );
  const scoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  assert.equal(scoped.profile.phase, "ready");
  assert.equal(scoped.newSession.phase, "active");
  assert.equal(canOpenProject(scoped), true);
  assert.equal(
    canOpenProject(updateDirectInputDraft(scoped, "Keep this Project draft.")),
    true,
  );
  assert.equal(
    canOpenProject(beginProjectSelection(base, 1).state),
    false,
  );

  const pending = beginOpenProject(scoped);
  assert.equal(pending.projectOpen.phase, "pending");
  assert.equal(canOpenProject(pending), false);
  assert.equal(canSelectProject(pending, 1), false);
  assert.equal(beginDirectSessionProfileLoad(pending), pending);
  assert.equal(beginDirectSessionProfileDefaultSave(pending).request, null);
  assert.equal(beginDirectInputSubmission(pending).request, null);
  assert.equal(enterNewAgentSessionMode(pending), pending);
  assert.equal(cancelNewAgentSessionMode(pending), pending);
  assert.equal(
    updateDirectInputDraft(pending, "Must not replace state while opening."),
    pending,
  );

  const cancelled = completeOpenProject(pending, {
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
  });
  assert.equal(cancelled.projectOpen.phase, "cancelled");
  assert.equal(cancelled.result, scoped.result);
  assert.equal(cancelled.selectedKey, scoped.selectedKey);
  assert.equal(cancelled.composer, scoped.composer);
  assert.equal(cancelled.profile, scoped.profile);
  assert.equal(cancelled.newSession, scoped.newSession);
  assert.equal(canOpenProject(cancelled), true);

  const failed = completeOpenProject(beginOpenProject(scoped), {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    },
  });
  assert.equal(failed.projectOpen.phase, "error");
  assert.equal(failed.result, scoped.result);
  assert.equal(failed.composer, scoped.composer);
  assert.equal(failed.profile, scoped.profile);
  assert.equal(failed.newSession, scoped.newSession);

  const resultFirst = completeOpenProject(beginOpenProject(scoped), {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(resultFirst.projectOpen.phase, "pending");
  assert.equal(resultFirst.projectOpen.selectionAccepted, true);
  assert.equal(resultFirst.profile, scoped.profile);
  const target = result(
    twoProjectView(1, [second], second.key, 1, "available", 111),
  );
  const targetAfterResult = replaceProjectResult(resultFirst, target);
  assert.equal(targetAfterResult.projectOpen.phase, "opened");
  assert.equal(targetAfterResult.projectOpen.viewArrived, true);
  assert.equal(targetAfterResult.selectedKey, second.key);
  assert.equal(targetAfterResult.composer.draft, "");
  assert.equal(targetAfterResult.profile.phase, "idle");
  assert.equal(targetAfterResult.newSession.phase, "inactive");

  const viewFirstPending = beginOpenProject(scoped);
  const viewFirst = replaceProjectResult(viewFirstPending, target);
  assert.equal(viewFirst.projectOpen.phase, "pending");
  assert.equal(viewFirst.projectOpen.viewArrived, true);
  assert.equal(viewFirst.selectedKey, scoped.selectedKey);
  assert.equal(viewFirst.composer, scoped.composer);
  assert.equal(viewFirst.profile, scoped.profile);
  assert.equal(viewFirst.newSession, scoped.newSession);
  const completedAfterView = completeOpenProject(viewFirst, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(completedAfterView.projectOpen.phase, "opened");
  assert.equal(completedAfterView.selectedKey, second.key);
});

test("Open Project waits for an ambiguous history choice and preserves the one-ledger adoption announcement", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000281",
  );
  const restored = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000282",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(40, [first], first.key, 0, "available")),
  );
  const pending = beginOpenProject(base);
  const needsChoice = completeOpenProject(pending, {
    ok: true,
    status: "history-selection-required",
    message:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    snapshot: {
      projectLabel: "Returning Project",
      histories: [
        {
          historyKey:
            "project-history:00000000-0000-4000-8000-000000000283",
          current: false,
          sessionCount: 1,
          commandCount: 1,
          updateCount: 4,
          byteSize: 49_152,
          lastModified: "2026-08-21T10:00:00Z",
          schemaVersion: 5,
        },
        {
          historyKey:
            "project-history:00000000-0000-4000-8000-000000000284",
          current: false,
          sessionCount: 2,
          commandCount: 3,
          updateCount: 8,
          byteSize: 61_440,
          lastModified: "2026-08-20T10:00:00Z",
          schemaVersion: 5,
        },
      ],
    },
  });
  assert.equal(needsChoice.projectOpen.phase, "pending");
  assert.equal(needsChoice.projectOpen.selectionAccepted, false);
  assert.equal(needsChoice.projectOpen.viewArrived, false);
  assert.equal(
    presentationText(needsChoice.projectOpen.feedback),
    "Choose which existing conversation history this Project should show. Nothing changed yet.",
  );
  assert.equal(
    typeof needsChoice.projectOpen.feedback === "string"
      ? null
      : needsChoice.projectOpen.feedback?.key,
    "project.choose-history",
  );
  assert.equal(canOpenProject(needsChoice), false);

  const target = result(
    twoProjectView(1, [restored], restored.key, 1, "available", 211),
  );
  const adoptedView = replaceProjectResult(needsChoice, target);
  assert.equal(adoptedView.projectOpen.viewArrived, true);
  const chosen = completeOpenProject(adoptedView, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(chosen.projectOpen.phase, "opened");
  assert.equal(chosen.selectedKey, restored.key);

  const automaticView = replaceProjectResult(beginOpenProject(base), target);
  const automatic = completeOpenProject(automaticView, {
    ok: true,
    status: "opened",
    message: "Project was opened with its existing conversation history.",
  });
  assert.equal(automatic.projectOpen.phase, "opened");
  assert.equal(
    presentationText(automatic.projectOpen.feedback),
    "Project was opened with its existing conversation history.",
  );
  assert.equal(
    typeof automatic.projectOpen.feedback === "string"
      ? null
      : automatic.projectOpen.feedback?.key,
    "project.opened-with-history",
  );
});

test("an intentionally empty Project registry can recover through Open or Create Project", () => {
  const emptyRegistry = replaceProjectResult(initialRendererState, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });

  assert.equal(canOpenProject(emptyRegistry), true);
  assert.equal(canCreateProject(emptyRegistry), true);
  const opening = beginOpenProject(emptyRegistry);
  assert.equal(opening.projectOpen.phase, "pending");
  assert.equal(opening.projectOpen.baselineSelectedIndex, null);
  assert.equal(opening.projectOpen.baselineProjectCount, 0);
  assert.equal(beginCreateProject(emptyRegistry).projectOpen.phase, "pending");

  const live = replaceProjectResult(opening, result(view(1, [], null)));
  assert.equal(live.projectOpen.viewArrived, true);
  const opened = completeOpenProject(live, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(opened.projectOpen.phase, "opened");
  assert.equal(opened.result?.ok, true);
});

test("Create Project reuses strict acquisition correlation and resets exactly once only after a new target view", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000184",
  );
  const createdSession = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000185",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(40, [first], first.key, 0, "available", 501)),
  );
  const scoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );

  assert.equal(canCreateProject(scoped), true);
  const pending = beginCreateProject(scoped);
  assert.equal(pending.projectOpen.phase, "pending");
  assert.equal(pending.projectOpen.operation, "create");
  assert.equal(canCreateProject(pending), false);
  assert.equal(canOpenProject(pending), false);
  assert.equal(canSelectProject(pending, 1), false);
  assert.equal(updateDirectInputDraft(pending, "Blocked draft"), pending);

  for (const [outcome, phase] of [
    ["cancelled", "cancelled"],
    ["unavailable", "error"],
    ["created-recovery-required", "recovery-required"],
  ] as const) {
    const completed = completeCreateProject(beginCreateProject(scoped), { outcome });
    assert.equal(completed.projectOpen.phase, phase);
    assert.equal(completed.result, scoped.result);
    assert.equal(completed.selectedKey, scoped.selectedKey);
    assert.equal(completed.composer, scoped.composer);
    assert.equal(completed.profile, scoped.profile);
    assert.equal(completed.newSession, scoped.newSession);
  }

  const resultFirst = completeCreateProject(beginCreateProject(scoped), {
    outcome: "created",
  });
  assert.equal(resultFirst.projectOpen.phase, "pending");
  assert.equal(resultFirst.projectOpen.selectionAccepted, true);
  const rotatedCurrent = result(
    twoProjectView(41, [first], first.key, 0, "available", 511),
  );
  const stillPending = replaceProjectResult(resultFirst, rotatedCurrent);
  assert.equal(stillPending.projectOpen.phase, "pending");
  assert.equal(stillPending.projectOpen.viewArrived, false);
  assert.equal(stillPending.composer, scoped.composer);

  const target = result(createdProjectView(1, [createdSession], createdSession.key));
  const created = replaceProjectResult(stillPending, target);
  assert.equal(created.projectOpen.phase, "created");
  assert.equal(created.projectOpen.viewArrived, true);
  assert.equal(created.selectedKey, createdSession.key);
  assert.equal(created.composer.draft, "");
  assert.equal(created.profile.phase, "idle");
  assert.equal(created.newSession.phase, "inactive");
  const switchFromCreated = beginProjectSelection(created, 0);
  assert.notEqual(switchFromCreated.request, null);
  assert.equal(switchFromCreated.state.projectOpen.phase, "idle");
  assert.equal(switchFromCreated.state.projectOpen.feedback, null);

  const viewFirst = replaceProjectResult(beginCreateProject(scoped), target);
  assert.equal(viewFirst.projectOpen.phase, "pending");
  assert.equal(viewFirst.projectOpen.viewArrived, true);
  assert.equal(viewFirst.selectedKey, scoped.selectedKey);
  assert.equal(viewFirst.composer, scoped.composer);
  assert.equal(viewFirst.profile, scoped.profile);
  assert.equal(viewFirst.newSession, scoped.newSession);
  const completedAfterView = completeCreateProject(viewFirst, {
    outcome: "created",
  });
  assert.equal(completedAfterView.projectOpen.phase, "created");
  const later = replaceProjectResult(
    completedAfterView,
    result(createdProjectView(2, [createdSession], createdSession.key)),
  );
  assert.equal(later.composer, completedAfterView.composer);
  assert.equal(later.profile, completedAfterView.profile);
  assert.equal(later.newSession, completedAfterView.newSession);
});

test("a failed target projection cannot consume a later authoritative Create result", () => {
  const current = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000186",
  );
  const createdSession = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000187",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(60, [current], current.key, 0, "available", 601)),
  );
  const scoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  const projectionFailure: WorkbenchHostedProjectResult = {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  };
  const target = result(
    createdProjectView(1, [createdSession], createdSession.key),
  );

  const failedBeforeCreated = replaceProjectResult(
    beginCreateProject(scoped),
    projectionFailure,
  );
  assert.equal(failedBeforeCreated.projectOpen.phase, "pending");
  assert.equal(failedBeforeCreated.result, scoped.result);
  assert.equal(failedBeforeCreated.selectedKey, scoped.selectedKey);
  const accepted = completeCreateProject(failedBeforeCreated, {
    outcome: "created",
  });
  assert.equal(accepted.projectOpen.phase, "pending");
  assert.equal(accepted.projectOpen.selectionAccepted, true);
  const created = replaceProjectResult(accepted, target);
  assert.equal(created.projectOpen.phase, "created");
  assert.equal(created.selectedKey, createdSession.key);
  assert.equal(created.composer.draft, "");

  const failedBeforeRecovery = replaceProjectResult(
    beginCreateProject(scoped),
    projectionFailure,
  );
  const recovery = completeCreateProject(failedBeforeRecovery, {
    outcome: "created-recovery-required",
  });
  assert.equal(recovery.projectOpen.phase, "recovery-required");
  assert.equal(canOpenProject(recovery), true);
  const repeatedFailure = replaceProjectResult(recovery, projectionFailure);
  assert.equal(repeatedFailure.projectOpen.phase, "recovery-required");
  assert.equal(repeatedFailure.result, scoped.result);
  assert.equal(repeatedFailure.selectedKey, scoped.selectedKey);
  assert.equal(repeatedFailure.composer, scoped.composer);
  assert.equal(canOpenProject(repeatedFailure), true);
  const lateTarget = replaceProjectResult(recovery, target);
  assert.equal(lateTarget.projectOpen.phase, "recovery-required");
  assert.equal(lateTarget.selectedKey, scoped.selectedKey);
  assert.equal(lateTarget.composer, scoped.composer);
  assert.equal(lateTarget.profile, scoped.profile);
  assert.equal(lateTarget.newSession, scoped.newSession);
});

test("F141 repro: New Agent Session entered before Create recovery still has an exit", () => {
  const current = resumableSessionCommand(
    "command-f141",
    "Agent Session F141",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000241",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(80, [current], current.key, 0, "available", 701)),
  );
  const entered = enterNewAgentSessionMode(base);
  const recovery = completeCreateProject(beginCreateProject(entered), {
    outcome: "created-recovery-required",
  });

  assert.equal(entered.newSession.phase, "active");
  assert.equal(recovery.newSession.phase, "active");
  assert.equal(recovery.projectOpen.phase, "recovery-required");
  assert.equal(canCancelNewAgentSessionMode(recovery), true);

  const exited = cancelNewAgentSessionMode(recovery);
  assert.equal(exited.newSession.phase, "inactive");
  assert.equal(exited.projectOpen.phase, "recovery-required");
  assert.equal(exited.selectedKey, current.key);

  const projectPending = beginCreateProject(entered);
  assert.equal(projectPending.projectOpen.phase, "pending");
  assert.equal(canCancelNewAgentSessionMode(projectPending), false);
  const exitedDuringProjectPending = cancelNewAgentSessionMode(projectPending);
  assert.equal(exitedDuringProjectPending, projectPending);

  const switching = beginProjectSelection(entered, 1).state;
  assert.equal(switching.projectSwitch.phase, "pending");
  assert.equal(canCancelNewAgentSessionMode(switching), false);
  const exitedDuringProjectSwitch = cancelNewAgentSessionMode(switching);
  assert.equal(exitedDuringProjectSwitch, switching);
});

test("view-first Create recovery preserves Project scope and enables only Open Project", () => {
  const current = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000194",
  );
  const createdSession = resumableSessionCommand(
    "command-2",
    "Agent Session 02",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000195",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(80, [current], current.key, 0, "available", 701)),
  );
  const scoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  const target = result(
    createdProjectView(1, [createdSession], createdSession.key),
  );
  const viewFirst = replaceProjectResult(beginCreateProject(scoped), target);
  const recovery = completeCreateProject(viewFirst, {
    outcome: "created-recovery-required",
  });

  const resultFirstRecovery = completeCreateProject(
    beginCreateProject(scoped),
    { outcome: "created-recovery-required" },
  );
  const lateRecoveryView = replaceProjectResult(resultFirstRecovery, target);

  assert.equal(lateRecoveryView.projectOpen.phase, "recovery-required");
  assert.equal(lateRecoveryView.selectedKey, scoped.selectedKey);
  assert.equal(lateRecoveryView.composer, scoped.composer);
  assert.equal(lateRecoveryView.profile, scoped.profile);
  assert.equal(lateRecoveryView.newSession, scoped.newSession);

  assert.equal(recovery.projectOpen.phase, "recovery-required");
  assert.equal(recovery.selectedKey, scoped.selectedKey);
  assert.equal(recovery.composer, scoped.composer);
  assert.equal(recovery.profile, scoped.profile);
  assert.equal(recovery.newSession, scoped.newSession);
  assert.equal(canOpenProject(recovery), true);
  assert.equal(canCreateProject(recovery), false);
  assert.equal(canSelectProject(recovery, 0), false);
  assert.equal(canEnterNewAgentSessionMode(recovery), false);
  assert.equal(canCancelNewAgentSessionMode(recovery), true);
  const exitedNewSession = cancelNewAgentSessionMode(recovery);
  assert.equal(exitedNewSession.newSession.phase, "inactive");
  assert.equal(exitedNewSession.projectOpen, recovery.projectOpen);
  assert.equal(canUseDirectSessionProfileAsDefault(recovery), false);
  assert.equal(canSubmitDirectInput(recovery), false);
  assert.equal(updateDirectInputDraft(recovery, "blocked"), recovery);
  assert.equal(selectDirectModel(recovery, "model-2"), recovery);
  assert.equal(
    selectDirectWorkIntensity(recovery, "intensity-high"),
    recovery,
  );
  assert.equal(selectProjectCommand(recovery, createdSession.key), recovery);

  const opening = beginOpenProject(recovery);
  assert.equal(opening.projectOpen.phase, "pending");
  assert.equal(opening.projectOpen.operation, "open");
  assert.equal(opening.projectOpen.resetRequired, true);

  for (const unresolved of [
    completeOpenProject(beginOpenProject(recovery), {
      ok: true,
      status: "cancelled",
      message: "Open Project was cancelled. Nothing changed.",
    }),
    completeOpenProject(beginOpenProject(recovery), {
      ok: false,
      error: {
        category: "project-open-unavailable",
        message:
          "Open Project could not be completed. Keep the current Project and try again.",
      },
    }),
  ]) {
    assert.equal(unresolved.projectOpen.phase, "recovery-required");
    assert.equal(canOpenProject(unresolved), true);
    assert.equal(canCreateProject(unresolved), false);
    assert.equal(unresolved.composer, scoped.composer);
    assert.equal(unresolved.profile, scoped.profile);
    assert.equal(unresolved.newSession, scoped.newSession);
  }

  const recoveredView = replaceProjectResult(opening, target);
  assert.equal(recoveredView.projectOpen.viewArrived, true);
  assert.equal(recoveredView.composer, scoped.composer);
  const recovered = completeOpenProject(recoveredView, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(recovered.projectOpen.phase, "opened");
  assert.equal(recovered.selectedKey, createdSession.key);
  assert.equal(recovered.composer.draft, "");
  assert.equal(recovered.profile.phase, "idle");
  assert.equal(recovered.newSession.phase, "inactive");
  assert.equal(canCreateProject(recovered), true);
});

test("Open Project ignores a stale current-Project view before a different target and resets exactly once", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000086",
  );
  const second = resumableSessionCommand(
    "command-9",
    "Agent Session 09",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000087",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(50, [first], first.key, 0, "available", 401)),
  );
  const scoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  const pending = beginOpenProject(scoped);
  const staleCurrent = result(
    twoProjectView(51, [first], first.key, 0, "available", 411),
  );
  const afterStaleCurrent = replaceProjectResult(pending, staleCurrent);

  assert.equal(afterStaleCurrent.projectOpen.phase, "pending");
  assert.equal(afterStaleCurrent.projectOpen.viewArrived, false);
  assert.equal(afterStaleCurrent.selectedKey, scoped.selectedKey);
  assert.equal(afterStaleCurrent.composer, scoped.composer);
  assert.equal(afterStaleCurrent.profile, scoped.profile);
  assert.equal(afterStaleCurrent.newSession, scoped.newSession);

  const acceptedBeforeTarget = completeOpenProject(afterStaleCurrent, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(acceptedBeforeTarget.projectOpen.phase, "pending");
  assert.equal(acceptedBeforeTarget.projectOpen.selectionAccepted, true);
  assert.equal(acceptedBeforeTarget.projectOpen.viewArrived, false);
  assert.equal(acceptedBeforeTarget.profile, scoped.profile);
  assert.equal(acceptedBeforeTarget.newSession, scoped.newSession);

  const target = result(
    twoProjectView(1, [second], second.key, 1, "available", 421),
  );
  const opened = replaceProjectResult(acceptedBeforeTarget, target);
  assert.equal(opened.projectOpen.phase, "opened");
  assert.equal(opened.projectOpen.viewArrived, true);
  assert.equal(opened.selectedKey, second.key);
  assert.equal(opened.composer.draft, "");
  assert.equal(opened.composer.phase, "idle");
  assert.equal(opened.profile.phase, "idle");
  assert.equal(opened.profile.result, null);
  assert.equal(opened.newSession.phase, "inactive");

  const targetScoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(opened)),
    profileResult(),
  );
  const laterTarget = result(
    twoProjectView(2, [second], second.key, 1, "available", 431),
  );
  const afterLaterTarget = replaceProjectResult(targetScoped, laterTarget);
  assert.equal(afterLaterTarget.projectOpen.phase, "opened");
  assert.equal(afterLaterTarget.selectedKey, second.key);
  assert.equal(afterLaterTarget.composer, targetScoped.composer);
  assert.equal(afterLaterTarget.profile, targetScoped.profile);
  assert.equal(afterLaterTarget.newSession, targetScoped.newSession);

  const staleBeforeTargetFirst = replaceProjectResult(
    beginOpenProject(scoped),
    result(twoProjectView(52, [first], first.key, 0, "available", 441)),
  );
  assert.equal(staleBeforeTargetFirst.projectOpen.viewArrived, false);
  const targetBeforeResult = replaceProjectResult(
    staleBeforeTargetFirst,
    result(twoProjectView(1, [second], second.key, 1, "available", 451)),
  );
  assert.equal(targetBeforeResult.projectOpen.phase, "pending");
  assert.equal(targetBeforeResult.projectOpen.viewArrived, true);
  assert.equal(targetBeforeResult.selectedKey, scoped.selectedKey);
  assert.equal(targetBeforeResult.profile, scoped.profile);
  assert.equal(targetBeforeResult.newSession, scoped.newSession);
  const openedAfterTarget = completeOpenProject(targetBeforeResult, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(openedAfterTarget.projectOpen.phase, "opened");
  assert.equal(openedAfterTarget.selectedKey, second.key);
  assert.equal(openedAfterTarget.profile.phase, "idle");
  assert.equal(openedAfterTarget.newSession.phase, "inactive");
});

test("idempotent current-Project reopening recognizes the latest rotated snapshot replay in both result/view orders", () => {
  const current = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000089",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(70, [current], current.key, 0, "available", 601)),
  );
  const loaded = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  const savingDefault = beginDirectSessionProfileDefaultSave(loaded);
  const savedDefault = completeDirectSessionProfileDefaultSave(
    savingDefault.state,
    {
      ok: true,
      status: "saved",
      message: "Session Profile default was durably saved.",
    },
  );
  const switchAttempt = beginProjectSelection(savedDefault, 1);
  const priorTransient = completeProjectSelection(switchAttempt.state, {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  const scoped = Object.freeze({
    ...priorTransient,
    composer: Object.freeze({
      draft: "",
      phase: "accepted" as const,
      feedback: "A prior Project action remains visible.",
    }),
  });
  assert.equal(canOpenProject(scoped), true);
  assert.equal(scoped.selectedKey, current.key);
  assert.equal(scoped.profile.phase, "ready");
  assert.equal(scoped.profile.defaultPreference.phase, "saved");
  assert.equal(scoped.newSession.phase, "active");
  assert.equal(scoped.composer.phase, "accepted");
  assert.equal(scoped.projectSwitch.phase, "error");
  const rotated = result(
    twoProjectView(71, [current], current.key, 0, "available", 611),
  );

  const viewFirstCandidate = replaceProjectResult(
    beginOpenProject(scoped),
    rotated,
  );
  assert.equal(viewFirstCandidate.projectOpen.phase, "pending");
  assert.equal(viewFirstCandidate.projectOpen.viewArrived, false);
  const viewFirstReplay = replaceProjectResult(viewFirstCandidate, rotated);
  assert.equal(viewFirstReplay.projectOpen.phase, "pending");
  assert.equal(viewFirstReplay.projectOpen.viewArrived, true);
  const viewFirstOpened = completeOpenProject(viewFirstReplay, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(viewFirstOpened.projectOpen.phase, "opened");
  assert.equal(viewFirstOpened.selectedKey, scoped.selectedKey);
  assert.equal(viewFirstOpened.composer, scoped.composer);
  assert.equal(viewFirstOpened.profile, scoped.profile);
  assert.equal(viewFirstOpened.newSession, scoped.newSession);
  assert.equal(viewFirstOpened.projectSwitch, scoped.projectSwitch);

  const resultFirstCandidate = replaceProjectResult(
    beginOpenProject(scoped),
    rotated,
  );
  const resultFirstPending = completeOpenProject(resultFirstCandidate, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(resultFirstPending.projectOpen.phase, "pending");
  assert.equal(resultFirstPending.projectOpen.selectionAccepted, true);
  assert.equal(resultFirstPending.projectOpen.viewArrived, false);
  const resultFirstOpened = replaceProjectResult(resultFirstPending, rotated);
  assert.equal(resultFirstOpened.projectOpen.phase, "opened");
  assert.equal(resultFirstOpened.selectedKey, scoped.selectedKey);
  assert.equal(resultFirstOpened.composer, scoped.composer);
  assert.equal(resultFirstOpened.profile, scoped.profile);
  assert.equal(resultFirstOpened.newSession, scoped.newSession);
  assert.equal(resultFirstOpened.projectSwitch, scoped.projectSwitch);

  const rotatedAgain = result(
    twoProjectView(72, [current], current.key, 0, "available", 621),
  );
  const afterMultipleRotations = replaceProjectResult(
    replaceProjectResult(beginOpenProject(scoped), rotated),
    rotatedAgain,
  );
  assert.equal(afterMultipleRotations.projectOpen.viewArrived, false);
  const afterOlderReplay = replaceProjectResult(
    afterMultipleRotations,
    rotated,
  );
  assert.equal(afterOlderReplay.projectOpen.viewArrived, false);
  const afterLatestReplay = replaceProjectResult(
    afterOlderReplay,
    rotatedAgain,
  );
  assert.equal(afterLatestReplay.projectOpen.phase, "pending");
  assert.equal(afterLatestReplay.projectOpen.viewArrived, true);
  assert.equal(afterLatestReplay.selectedKey, scoped.selectedKey);
  assert.equal(afterLatestReplay.composer, scoped.composer);
  assert.equal(afterLatestReplay.profile, scoped.profile);
  assert.equal(afterLatestReplay.newSession, scoped.newSession);
  assert.equal(afterLatestReplay.projectSwitch, scoped.projectSwitch);
});

test("idempotent current-Project reopening preserves Project-scoped state in both result/view orders", () => {
  const current = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000088",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(60, [current], current.key, 0, "available", 501)),
  );
  const scoped = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  assert.equal(scoped.profile.phase, "ready");
  assert.equal(scoped.newSession.phase, "active");

  const viewBeforeResult = replaceProjectResult(
    beginOpenProject(scoped),
    scoped.result!,
  );
  assert.equal(viewBeforeResult.projectOpen.phase, "pending");
  assert.equal(viewBeforeResult.projectOpen.viewArrived, true);
  assert.equal(viewBeforeResult.selectedKey, scoped.selectedKey);
  assert.equal(viewBeforeResult.composer, scoped.composer);
  assert.equal(viewBeforeResult.profile, scoped.profile);
  assert.equal(viewBeforeResult.newSession, scoped.newSession);
  const viewFirstOpened = completeOpenProject(viewBeforeResult, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(viewFirstOpened.projectOpen.phase, "opened");
  assert.equal(viewFirstOpened.composer, scoped.composer);
  assert.equal(viewFirstOpened.profile, scoped.profile);
  assert.equal(viewFirstOpened.newSession, scoped.newSession);

  const resultBeforeView = completeOpenProject(beginOpenProject(scoped), {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.equal(resultBeforeView.projectOpen.phase, "pending");
  assert.equal(resultBeforeView.projectOpen.selectionAccepted, true);
  assert.equal(resultBeforeView.projectOpen.viewArrived, false);
  const resultFirstOpened = replaceProjectResult(
    resultBeforeView,
    scoped.result!,
  );
  assert.equal(resultFirstOpened.projectOpen.phase, "opened");
  assert.equal(resultFirstOpened.selectedKey, scoped.selectedKey);
  assert.equal(resultFirstOpened.composer, scoped.composer);
  assert.equal(resultFirstOpened.profile, scoped.profile);
  assert.equal(resultFirstOpened.newSession, scoped.newSession);
});

test("Project selection uses the current snapshot key and resets Project-scoped UI state across both view/result races", () => {
  const first = resumableSessionCommand(
    "command-1",
    "Agent Session 01",
    "gpt-5.6-sol",
    "ultra",
    "00000000-0000-4000-8000-000000000082",
  );
  const second = resumableSessionCommand(
    "command-7",
    "Agent Session 07",
    "gpt-5.6-codex",
    "high",
    "00000000-0000-4000-8000-000000000083",
  );
  const base = replaceProjectResult(
    initialRendererState,
    result(twoProjectView(30, [first], first.key, 0, "available")),
  );
  const scopedReady = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(enterNewAgentSessionMode(base)),
    profileResult(),
  );
  assert.equal(scopedReady.profile.phase, "ready");
  assert.equal(scopedReady.newSession.phase, "active");

  const resultFirstAttempt = beginProjectSelection(scopedReady, 1);
  assert.deepEqual(resultFirstAttempt.request, {
    selectionKey:
      "project-selection:00000000-0000-4000-8000-000000000092",
  });
  assert.equal(resultFirstAttempt.state.projectSwitch.phase, "pending");
  assert.equal(beginProjectSelection(resultFirstAttempt.state, 1).request, null);
  assert.equal(
    updateDirectInputDraft(resultFirstAttempt.state, "cross-Project draft"),
    resultFirstAttempt.state,
  );
  const acceptedBeforeView = completeProjectSelection(
    resultFirstAttempt.state,
    { ok: true, status: "selected", message: "Project was opened." },
  );
  assert.equal(acceptedBeforeView.projectSwitch.phase, "pending");
  assert.equal(acceptedBeforeView.projectSwitch.selectionAccepted, true);
  assert.equal(
    hasHostedProjectView(acceptedBeforeView.result)
      ? acceptedBeforeView.result.view.commands[0]?.key
      : null,
    first.key,
  );

  const targetView = result(
    twoProjectView(1, [second], second.key, 1, "available", 101),
  );
  const targetRendered = replaceProjectResult(acceptedBeforeView, targetView);
  assert.equal(targetRendered.projectSwitch.phase, "idle");
  assert.equal(targetRendered.selectedKey, second.key);
  assert.equal(targetRendered.composer.draft, "");
  assert.equal(targetRendered.composer.phase, "idle");
  assert.equal(targetRendered.profile.phase, "idle");
  assert.equal(targetRendered.profile.result, null);
  assert.equal(targetRendered.newSession.phase, "inactive");
  assert.equal(directInputMode(targetRendered), "continue");

  const viewFirstAttempt = beginProjectSelection(scopedReady, 1);
  const viewBeforeResult = replaceProjectResult(
    viewFirstAttempt.state,
    targetView,
  );
  assert.equal(viewBeforeResult.projectSwitch.phase, "pending");
  assert.equal(viewBeforeResult.projectSwitch.viewArrived, true);
  assert.equal(viewBeforeResult.selectedKey, second.key);
  assert.equal(viewBeforeResult.profile.phase, "idle");
  assert.equal(viewBeforeResult.newSession.phase, "inactive");
  const completedAfterView = completeProjectSelection(viewBeforeResult, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.equal(completedAfterView.projectSwitch.phase, "idle");

  const failedAttempt = beginProjectSelection(scopedReady, 1);
  const failed = completeProjectSelection(failedAttempt.state, {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  assert.equal(failed.projectSwitch.phase, "error");
  assert.equal(failed.result, scopedReady.result);
  assert.equal(failed.profile, scopedReady.profile);
  assert.equal(failed.newSession, scopedReady.newSession);
  assert.match(
    presentationText(failed.projectSwitch.feedback) ?? "",
    /could not be opened/iu,
  );
});

function command(
  key: string,
  label: string,
  status: WorkbenchCommandView["status"] = "completed",
): WorkbenchCommandView {
  return { key, label, runtime: "codex", status };
}

function resumableSessionCommand(
  key: string,
  label: string,
  model: string,
  effortLevel: string,
  selectionUuid: string,
): WorkbenchCommandView {
  return {
    key,
    label,
    runtime: "codex",
    status: "completed",
    session: {
      archived: false,
      metadataKey:
        `session-metadata:20000000-0000-4000-8000-${selectionUuid.slice(-12)}`,
      profile: recordedProfileProjection(model, effortLevel),
      timeline: [{ kind: "turn-completed", status: "completed" }],
      removalKey:
        `session-removal:10000000-0000-4000-8000-${selectionUuid.slice(-12)}`,
      resumable: true,
      selectionKey: `session-selection:${selectionUuid}`,
    },
  };
}

function recordedProfileProjection(modelLabel: string, workIntensityLabel: string) {
  return {
    requested: {
      kind: "recorded" as const,
      runtimeFamilyLabel: "Codex",
      endpointLabel: "Codex desktop",
      modelLabel,
      workIntensityControlLabel: {
        label: null,
        provenance: "not-recorded" as const,
      },
      workIntensityLabel,
      executionModeLabel: "Single agent",
      accessModeLabel: "Full access",
    },
    effective: { kind: "unknown" as const },
  };
}

function twoProjectView(
  cursor: number,
  commands: readonly WorkbenchCommandView[],
  initialSelectionKey: string | null,
  selectedIndex: 0 | 1,
  secondAvailability: "available" | "missing" | "unreadable",
  keySeed = 91,
): WorkbenchHostedProjectView {
  const firstKey = String(keySeed).padStart(12, "0");
  const secondKey = String(keySeed + 1).padStart(12, "0");
  return {
    project: { label: "Shared Name" },
    observation: { cursor, live: true },
    commands,
    initialSelectionKey,
    projectSelection: {
      projects: [
        {
          label: "Shared Name",
          availability: "available",
          selected: selectedIndex === 0,
          selectionKey: `project-selection:00000000-0000-4000-8000-${firstKey}`,
        },
        {
          label: "Shared Name",
          availability: secondAvailability,
          selected: selectedIndex === 1,
          selectionKey: `project-selection:00000000-0000-4000-8000-${secondKey}`,
        },
      ],
    },
  };
}

function createdProjectView(
  cursor: number,
  commands: readonly WorkbenchCommandView[],
  initialSelectionKey: string | null,
): WorkbenchHostedProjectView {
  const baseline = twoProjectView(cursor, [], null, 0, "available", 601);
  return {
    project: { label: "New Project" },
    observation: { cursor, live: true },
    commands,
    initialSelectionKey,
    projectSelection: {
      projects: [
        ...baseline.projectSelection.projects.map((project) => ({
          ...project,
          selected: false,
        })),
        {
          label: "New Project",
          availability: "available",
          selected: true,
          selectionKey:
            "project-selection:00000000-0000-4000-8000-000000000603",
        },
      ],
    },
  };
}

function view(
  cursor: number,
  commands: readonly WorkbenchCommandView[],
  initialSelectionKey: string | null,
): WorkbenchHostedProjectView {
  return {
    project: { label: "Atlas Fieldnotes" },
    observation: { cursor, live: true },
    commands,
    initialSelectionKey,
    projectSelection: {
      projects: [
        {
          label: "Atlas Fieldnotes",
          availability: "available",
          selected: true,
          selectionKey:
            "project-selection:00000000-0000-4000-8000-000000000071",
        },
      ],
    },
  };
}

function result(projectView: WorkbenchHostedProjectView): Extract<
  WorkbenchHostedProjectResult,
  { readonly ok: true }
> {
  return { ok: true, view: projectView };
}

function acceptedSubmission(): WorkbenchSubmissionResult {
  return {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  };
}

function preferenceUnavailable(): WorkbenchDirectSessionProfileDefaultResult {
  return {
    ok: false,
    error: {
      category: "preference-unavailable",
      message:
        "Codex Session Profile default could not be durably saved. Keep your selection and try again.",
    },
  };
}

function endpointDiscovery(
  codexCategory: WorkbenchRuntimeEndpointDiscoveryCategory,
  claudeCategory: Exclude<
    WorkbenchRuntimeEndpointDiscoveryCategory,
    "authentication-required"
  >,
): WorkbenchRuntimeEndpointDiscovery {
  const statuses: WorkbenchRuntimeEndpointDiscovery["statuses"] = [
    Object.freeze({ endpointId: "codex-desktop", category: codexCategory }),
    Object.freeze({
      endpointId: "claude-code-desktop",
      category: claudeCategory,
    }),
  ];
  return Object.freeze({
    statuses: Object.freeze(statuses),
  });
}

function readyState() {
  return completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    profileResult(),
  );
}

function profileResult(
  desiredDefault: "resolved" | "unavailable" = "resolved",
): WorkbenchCatalogDefaultPublicProfileResult {
  return {
    ok: true,
    endpointDiscovery: endpointDiscovery(
      "catalog-ready",
      "runtime-not-located",
    ),
    profile: {
      snapshotKey: "snapshot-1",
      endpoints: [
        {
          endpointId: "codex-desktop",
          key: "endpoint-1",
          runtimeFamilyLabel: "Runtime family",
          endpointLabel: "Desktop endpoint",
          models: [
            {
              key: "model-1",
              label: "Display model one",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [
                { key: "intensity-low", label: "Low" },
                { key: "intensity-high", label: "High" },
              ],
            },
            {
              key: "model-2",
              label: "Display model two",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [
                { key: "intensity-medium", label: "Medium" },
                { key: "intensity-high", label: "High" },
              ],
            },
            {
              key: "model-3",
              label: "Display model three",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [
                { key: "intensity-ultra", label: "Ultra" },
              ],
            },
          ],
          executionModes: [{ key: "execution-1", label: "Single agent" }],
          accessModes: [{ key: "access-1", label: "Full access" }],
        },
      ],
      desiredDefault:
        desiredDefault === "resolved"
          ? {
              kind: "resolved",
              endpointKey: "endpoint-1",
              modelKey: "model-1",
              workIntensityKey: "intensity-high",
              executionModeKey: "execution-1",
              accessModeKey: "access-1",
            }
          : { kind: "unavailable" },
    },
  };
}

function replacementProfileResult(
  kind: "resolved" | "manual-selection-required",
): WorkbenchAnyPublicDirectSessionProfileResult {
  const base = profileResult();
  if (!base.ok || base.profile.desiredDefault.kind !== "resolved") {
    throw new Error("invalid-profile-fixture");
  }
  const { desiredDefault, ...catalog } = base.profile;
  return {
    ...base,
    profile: {
      ...catalog,
      replacementPrefill:
        kind === "resolved"
          ? desiredDefault
          : { kind: "manual-selection-required" },
    },
  };
}

function continuationProfileResult(
  modelKey = "model-fable",
  workIntensityKey = "intensity-low",
): WorkbenchAnyPublicDirectSessionProfileResult {
  return {
    ok: true,
    endpointDiscovery: endpointDiscovery(
      "not-inspected",
      "catalog-ready",
    ),
    profile: {
      snapshotKey: "snapshot-continuation",
      endpoints: [
        {
          endpointId: "claude-code-desktop",
          key: "endpoint-claude",
          runtimeFamilyLabel: "Claude",
          endpointLabel: "Claude Code desktop",
          models: [
            {
              key: "model-fable",
              label: "Fable 5",
              provenanceLabel: null,
              workIntensityLabel: "Work Intensity",
              workIntensities: [
                { key: "intensity-low", label: "low" },
              ],
            },
            {
              key: "model-opus",
              label: "Opus 5",
              provenanceLabel: null,
              workIntensityLabel: "Work Intensity",
              workIntensities: [
                {
                  key: "intensity-max",
                  label: "maximum",
                  impliedExecutionModeKey: "execution-other",
                },
                { key: "intensity-high", label: "high" },
                {
                  key: "intensity-ultracode",
                  label: "ultracode",
                  impliedExecutionModeKey: "execution-fixed",
                },
                { key: "intensity-ordinary-max", label: "max" },
              ],
            },
          ],
          executionModes: [
            { key: "execution-fixed", label: "Single agent" },
            { key: "execution-other", label: "Coordinated" },
          ],
          accessModes: [{ key: "access-fixed", label: "Full access" }],
        },
      ],
      continuationPrefill: {
        kind: "resolved",
        endpointKey: "endpoint-claude",
        modelKey,
        workIntensityKey,
        executionModeKey: "execution-fixed",
        accessModeKey: "access-fixed",
      },
    },
  };
}

function switchingProfileResult(): WorkbenchCatalogDefaultPublicProfileResult {
  return {
    ok: true,
    endpointDiscovery: endpointDiscovery("catalog-ready", "catalog-ready"),
    profile: {
      snapshotKey: "snapshot-switching",
      endpoints: [
        {
          endpointId: "codex-desktop",
          key: "endpoint-1",
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          models: [
            {
              key: "model-1",
              label: "GPT-5.6-Sol",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [
                { key: "intensity-low", label: "low" },
                { key: "intensity-high", label: "high" },
              ],
            },
          ],
          executionModes: [{ key: "execution-1", label: "Single agent" }],
          accessModes: [{ key: "access-1", label: "Full access" }],
        },
        {
          endpointId: "claude-code-desktop",
          key: "endpoint-2",
          runtimeFamilyLabel: "Claude",
          endpointLabel: "Claude Code desktop",
          models: [
            {
              key: "model-4",
              label: "Haiku 4.5",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [
                { key: "intensity-default", label: "default" },
              ],
            },
          ],
          executionModes: [{ key: "execution-2", label: "Single agent" }],
          accessModes: [{ key: "access-2", label: "Full access" }],
        },
      ],
      desiredDefault: {
        kind: "resolved",
        endpointKey: "endpoint-1",
        modelKey: "model-1",
        workIntensityKey: "intensity-high",
        executionModeKey: "execution-1",
        accessModeKey: "access-1",
      },
    },
  };
}

function coupledProfileResult(): WorkbenchCatalogDefaultPublicProfileResult {
  return {
    ok: true,
    endpointDiscovery: endpointDiscovery(
      "catalog-ready",
      "runtime-not-located",
    ),
    profile: {
      snapshotKey: "snapshot-coupled",
      endpoints: [
        {
          endpointId: "codex-desktop",
          key: "endpoint-coupled",
          runtimeFamilyLabel: "Fixture Runtime",
          endpointLabel: "Fixture endpoint",
          models: [
            {
              key: "model-coupled",
              label: "Fixture model",
              provenanceLabel: "Fixture catalog wording",
              workIntensityLabel: "Deliberation",
              workIntensities: [
                { key: "intensity-focused", label: "Focused" },
                {
                  key: "intensity-coordinated",
                  label: "Coordinated",
                  impliedExecutionModeKey: "execution-2",
                },
              ],
            },
          ],
          executionModes: [
            { key: "execution-1", label: "Single agent" },
            { key: "execution-2", label: "Coordinated workflow" },
          ],
          accessModes: [{ key: "access-1", label: "Full access" }],
        },
      ],
      desiredDefault: {
        kind: "resolved",
        endpointKey: "endpoint-coupled",
        modelKey: "model-coupled",
        workIntensityKey: "intensity-focused",
        executionModeKey: "execution-1",
        accessModeKey: "access-1",
      },
    },
  };
}
