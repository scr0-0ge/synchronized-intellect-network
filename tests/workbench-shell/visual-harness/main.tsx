/* The same stylesheets the product entry loads, in the same order. Cascade
   order is part of what this harness exists to show, so a sheet the product
   loads last may not be missing here: theme-legibility.css reached index.tsx
   and never reached this file, and every QA look and every measurement taken
   here was therefore taken against a cascade the product does not have. */
import "../../../src/workbench-shell/renderer/styles.css";
import "../../../src/workbench-shell/renderer/themes/theme-acrylic.css";
import "../../../src/workbench-shell/renderer/themes/theme-crt.css";
import "../../../src/workbench-shell/renderer/themes/theme-schemes.css";
import "../../../src/workbench-shell/renderer/themes/theme-legibility.css";
import { continuationStopFixture } from "./continuation-stop-fixture.ts";

import type {
  WorkbenchCreateProjectResult,
  WorkbenchDirectInputRequest,
  WorkbenchDirectSessionProfileLoadRequest,
  WorkbenchDirectSessionProfileDefaultRequest,
  WorkbenchDirectSessionProfileDefaultResult,
  WorkbenchAnyPublicDirectSessionProfileResult,
  WorkbenchHostedProjectResult,
  WorkbenchInterruptRequest,
  WorkbenchInterruptResult,
  WorkbenchSteerRequest,
  WorkbenchSteerResult,
  WorkbenchOpenProjectResult,
  WorkbenchProjectHistoryAdoptionResult,
  WorkbenchProjectHistoryDiscoveryResult,
  WorkbenchProjectHistoryHideRequest,
  WorkbenchProjectHistoryHideResult,
  WorkbenchProjectSelectionRequest,
  WorkbenchProjectSelectionResult,
  WorkbenchSessionMetadataMutationRequest,
  WorkbenchSessionMetadataMutationResult,
  WorkbenchSessionRemovalRequest,
  WorkbenchProjectRemovalResult,
  WorkbenchSessionRemovalResult,
  WorkbenchSubmissionResult,
} from "../../../src/workbench-shell/contract.ts";
import type {
  WorkbenchProjectTransferListener,
  WorkbenchRendererTransferBridge as WorkbenchRendererBridge,
} from "../../../src/workbench-shell/preload-bridge.ts";
import { createWorkbenchProjectTransferEncoder } from "../../../src/workbench-shell/result-sanitizer.ts";
import {
  defaultWorkbenchAppearancePreference,
  publicAppearancePreferenceLoaded,
  publicAppearancePreferenceSaved,
  publicClaudePermissionHandlingLoaded,
  publicClaudePermissionHandlingSaved,
  publicEndpointProbed,
  publicEndpointKeySaved,
  publicEndpointKeyStatusLoaded,
  publicEndpointCatalogFreshnessLoaded,
  publicRuntimeExecutablesLoaded,
  publicRuntimeExecutableSaved,
  defaultWorkbenchRuntimeExecutablePaths,
  publicRuntimeEndpointDiscovery,
} from "../../../src/workbench-shell/contract.ts";
import { mountWorkbench } from "../../../src/workbench-shell/renderer/mount.tsx";
import type { WorkbenchWindowRendererBridge } from "../../../src/workbench-shell/window-control-bridge.ts";
import type { WorkbenchWindowState } from "../../../src/workbench-shell/window-control-bridge.ts";
import {
  codeBlockCopyVisualFixture,
  claudeInterruptedVisualFixture,
  claudeRunningVisualFixture,
  emptyVisualFixture,
  interruptedVisualFixture,
  interruptVisualFixture,
  inFlightSessionRemovalVisualFixture,
  openedProjectVisualFixture,
  promptSuggestionsVisualFixture,
  sessionMetadataVisualFixture,
  secondSessionVisualFixture,
  stalePromptSuggestionsVisualFixture,
  unavailableVisualFixture,
  visualDirectProfile,
  visualFixture,
} from "./fixture.ts";
import {
  createTranscriptPerformanceFixture,
  transcriptPerformanceFixture,
  transcriptPerformanceUpdatedFixture,
} from "./transcript-performance-fixture.ts";
import { createTranscriptFollowScrollFixture } from "./transcript-follow-scroll-fixture.ts";
import { createTranscriptDensityFixture } from "./transcript-density-fixture.ts";

let submissionCalls = 0;
let interruptCalls = 0;
let steerCalls = 0;
let profileLoads = 0;
let defaultSaveCalls = 0;
let projectSelectionCalls = 0;
let openProjectCalls = 0;
let createProjectCalls = 0;
let sessionMetadataCalls = 0;
let sessionRemovalCalls = 0;
let projectRemovalCalls = 0;
let projectHistoryDiscoveryCalls = 0;
let projectHistoryAdoptionCalls = 0;
let projectHistoryHideCalls = 0;
let emptySecondaryHistoryHidden = false;
let transcriptFollowScrollRevision = 0;
let projectListener: WorkbenchProjectTransferListener | undefined;
let encodeProjectResult = createWorkbenchProjectTransferEncoder();
const emitProjectResult = (result: WorkbenchHostedProjectResult): void => {
  projectListener?.(encodeProjectResult(result));
};
let resolveStaleProjectHistory:
  | ((result: WorkbenchProjectHistoryDiscoveryResult) => void)
  | undefined;

window.addEventListener("qa-transcript-performance-update", () => {
  emitProjectResult(
    Object.freeze({ ok: true, view: transcriptPerformanceUpdatedFixture }),
  );
});

window.addEventListener("qa-transcript-performance-burst", (event) => {
  const requestedTurnCount =
    event instanceof CustomEvent && Number.isInteger(event.detail)
      ? Number(event.detail)
      : 510;
  const finalTurnCount = Math.max(501, Math.min(550, requestedTurnCount));
  for (let turnCount = 501; turnCount <= finalTurnCount; turnCount += 1) {
    emitProjectResult(
      Object.freeze({
        ok: true,
        view: createTranscriptPerformanceFixture(turnCount),
      }),
    );
  }
});

window.addEventListener("qa-transcript-follow-scroll-update", () => {
  transcriptFollowScrollRevision += 1;
  const requestedTurnCount = Number(
    new URLSearchParams(window.location.search).get("turns") ?? "80",
  );
  emitProjectResult(
    Object.freeze({
      ok: true,
      view: createTranscriptFollowScrollFixture(
        Number.isInteger(requestedTurnCount) ? requestedTurnCount : 80,
        transcriptFollowScrollRevision,
      ),
    }),
  );
});

window.addEventListener("qa-prompt-suggestions-next-turn", () => {
  emitProjectResult(
    Object.freeze({ ok: true, view: stalePromptSuggestionsVisualFixture }),
  );
});

/* The product entry stamps this from `?material=on`, which Electron main sets
   whenever the window presents native Windows acrylic — the shipping look on
   this owner's machine. `theme-acrylic.css` selects on it to suppress the
   painted backdrop, so without it every QA look was taken against the
   material-off branch of the product's own cascade. The product also strips its
   query string afterwards; this harness must not, because its scenario switches
   live there. */
if (new URLSearchParams(window.location.search).get("material") === "on") {
  document.documentElement.dataset.material = "on";
}

document.documentElement.dataset.qaSubmissionCalls = "0";
document.documentElement.dataset.qaInterruptCalls = "0";
document.documentElement.dataset.qaLastInterruptRequest = "";
document.documentElement.dataset.qaSteerCalls = "0";
document.documentElement.dataset.qaLastSteerRequest = "";
document.documentElement.dataset.qaLastSubmissionKind = "";
document.documentElement.dataset.qaLastSubmissionReceipt = "";
document.documentElement.dataset.qaProfileLoads = "0";
document.documentElement.dataset.qaDefaultSaveCalls = "0";
document.documentElement.dataset.qaProjectSelectionCalls = "0";
document.documentElement.dataset.qaOpenProjectCalls = "0";
document.documentElement.dataset.qaCreateProjectCalls = "0";
document.documentElement.dataset.qaSessionMetadataCalls = "0";
document.documentElement.dataset.qaSessionRemovalCalls = "0";
document.documentElement.dataset.qaProjectRemovalCalls = "0";
document.documentElement.dataset.qaProjectHistoryDiscoveryCalls = "0";
document.documentElement.dataset.qaProjectHistoryAdoptionCalls = "0";
document.documentElement.dataset.qaProjectHistoryHideCalls = "0";
document.documentElement.dataset.qaLastSessionMetadata = "";
document.documentElement.dataset.qaLastSessionRemoval = "";
document.documentElement.dataset.qaLastProjectRemoval = "";
document.documentElement.dataset.qaLastProjectHistoryDiscovery = "";

window.addEventListener("qa-resolve-stale-project-history", () => {
  resolveStaleProjectHistory?.({
    status: "discovered",
    snapshot: {
      projectLabel: "Atlas Fieldnotes",
      histories: [
        {
          historyKey:
            "project-history:00000000-0000-4000-8000-000000000301",
          current: true,
          sessionCount: 3,
          commandCount: 7,
          updateCount: 24,
          byteSize: 73_728,
          lastModified: "2026-08-18T07:16:50Z",
          schemaVersion: 5,
        },
        {
          historyKey:
            "project-history:00000000-0000-4000-8000-000000000302",
          current: false,
          sessionCount: 1,
          commandCount: 2,
          updateCount: 15,
          byteSize: 61_440,
          lastModified: "2026-08-17T22:10:00Z",
          schemaVersion: 5,
        },
      ],
    },
  });
  resolveStaleProjectHistory = undefined;
});

function glmHarnessKeyConfigured(): boolean {
  return new URLSearchParams(window.location.search).get("glm") !== "empty";
}

const bridge: WorkbenchRendererBridge = Object.freeze({
  writeClipboardText(text: string) {
    document.documentElement.dataset.qaCopiedCode = text;
    document.documentElement.dataset.qaClipboardBridgeCalls = String(
      Number(document.documentElement.dataset.qaClipboardBridgeCalls ?? "0") + 1,
    );
    return Promise.resolve(
      Object.freeze({ ok: true as const, status: "copied" as const }),
    );
  },
  loadAppearancePreference() {
    const language =
      new URLSearchParams(window.location.search).get("locale") === "zh-CN"
        ? "zh-CN"
        : "en";
    return Promise.resolve(
      publicAppearancePreferenceLoaded(
        Object.freeze({ ...defaultWorkbenchAppearancePreference, language }),
      ),
    );
  },
  saveAppearancePreference() {
    return Promise.resolve(publicAppearancePreferenceSaved());
  },
  loadClaudePermissionHandling() {
    return Promise.resolve(
      publicClaudePermissionHandlingLoaded("without-asking"),
    );
  },
  saveClaudePermissionHandling() {
    return Promise.resolve(publicClaudePermissionHandlingSaved());
  },
  // Visual QA fakes for the endpoint-key blocks (ADR 0022; one per static-key
  // endpoint). The default shows a configured durable key so every state of
  // the block is visible; `?glm=empty` shows the unconfigured GLM state. No
  // real key ever appears here.
  loadEndpointKeyStatus() {
    return Promise.resolve(
      publicEndpointKeyStatusLoaded({
        configured: glmHarnessKeyConfigured(),
        maskedHint: glmHarnessKeyConfigured() ? "••••demo" : null,
        isPersistent: true,
        environmentFallback: false,
      }),
    );
  },
  saveEndpointKey() {
    return Promise.resolve(publicEndpointKeySaved("••••demo", true));
  },
  removeEndpointKey() {
    return Promise.resolve({
      ok: true as const,
      status: "removed" as const,
      snapshot: {
        configured: false,
        maskedHint: null,
        isPersistent: true,
        environmentFallback: false,
      },
    });
  },
  revealEndpointKey() {
    return Promise.resolve({
      ok: true as const,
      status: "revealed" as const,
      value: "test-secret-harness",
      snapshot: {
        configured: true,
        maskedHint: "••••demo",
        isPersistent: true,
        environmentFallback: false,
      },
    });
  },
  probeEndpointKey() {
    return Promise.resolve(publicEndpointProbed({ outcome: "success" }));
  },
  // Visual QA fake for catalog freshness (ticket 14): one enrolled model on
  // the GLM row so the "new (untiered)" surfacing is visible; the other
  // static-key endpoints report a calm silent failure.
  loadEndpointCatalogFreshness() {
    return Promise.resolve(
      publicEndpointCatalogFreshnessLoaded([
        Object.freeze({
          endpointId: "glm-coding-plan" as const,
          status: "fresh" as const,
          newModels: Object.freeze([
            Object.freeze({
              id: "glm-harness-new",
              displayName: "GLM Harness New",
            }),
          ]),
          enrolledModels: Object.freeze([
            Object.freeze({ id: "glm-harness-new" }),
          ]),
        }),
        Object.freeze({
          endpointId: "kimi-code" as const,
          status: "silent-failure" as const,
          newModels: Object.freeze([]),
          enrolledModels: Object.freeze([]),
        }),
        Object.freeze({
          endpointId: "deepseek-api" as const,
          status: "silent-failure" as const,
          newModels: Object.freeze([]),
          enrolledModels: Object.freeze([]),
        }),
      ]),
    );
  },
  refreshEndpointCatalogFreshness() {
    return Promise.resolve(
      publicEndpointCatalogFreshnessLoaded([
        Object.freeze({
          endpointId: "glm-coding-plan" as const,
          status: "fresh" as const,
          newModels: Object.freeze([
            Object.freeze({
              id: "glm-harness-new",
              displayName: "GLM Harness New",
            }),
          ]),
          enrolledModels: Object.freeze([
            Object.freeze({ id: "glm-harness-new" }),
          ]),
        }),
        Object.freeze({
          endpointId: "kimi-code" as const,
          status: "silent-failure" as const,
          newModels: Object.freeze([]),
          enrolledModels: Object.freeze([]),
        }),
        Object.freeze({
          endpointId: "deepseek-api" as const,
          status: "silent-failure" as const,
          newModels: Object.freeze([]),
          enrolledModels: Object.freeze([]),
        }),
      ]),
    );
  },
  loadRuntimeExecutables() {
    return Promise.resolve(
      publicRuntimeExecutablesLoaded(defaultWorkbenchRuntimeExecutablePaths),
    );
  },
  saveRuntimeExecutable() {
    return Promise.resolve(
      publicRuntimeExecutableSaved(defaultWorkbenchRuntimeExecutablePaths),
    );
  },
  observeProject(listener: WorkbenchProjectTransferListener) {
    encodeProjectResult = createWorkbenchProjectTransferEncoder();
    projectListener = listener;
    const projectMode = new URLSearchParams(window.location.search).get("project");
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    emitProjectResult(
      Object.freeze({
        ok: true,
        view:
          scenario === "transcript-performance"
            ? transcriptPerformanceFixture
            : scenario === "transcript-follow-scroll"
              ? createTranscriptFollowScrollFixture(
                  Number(
                    new URLSearchParams(window.location.search).get("turns") ??
                      "80",
                  ),
                )
            : scenario === "transcript-density"
              ? createTranscriptDensityFixture(
                  Number(
                    new URLSearchParams(window.location.search).get("turns") ??
                      "1",
                  ),
                  new URLSearchParams(window.location.search).get("phase") ===
                    "active"
                    ? "active"
                    : "completed",
                )
            : scenario === "interrupt"
            ? interruptVisualFixture
            : scenario === "claude-running"
            ? claudeRunningVisualFixture
            : scenario === "code-copy"
            ? codeBlockCopyVisualFixture
            : scenario === "continuation-stop"
              ? continuationStopFixture
            : scenario === "prompt-suggestions"
            ? promptSuggestionsVisualFixture
            : scenario === "session-metadata" ||
                scenario === "session-metadata-stuck"
            ? sessionMetadataVisualFixture
            : scenario === "session-removal-active"
              ? inFlightSessionRemovalVisualFixture
            : projectMode === "empty" ||
                scenario === "picker" ||
                scenario === "runtime-not-located"
              ? emptyVisualFixture
              : scenario === "unavailable"
                ? unavailableVisualFixture
                : projectMode === "second" || scenario === "selected"
                  ? secondSessionVisualFixture
                  : visualFixture,
      }),
    );
    return () => {
      if (projectListener === listener) projectListener = undefined;
    };
  },
  removeSession(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult> {
    sessionRemovalCalls += 1;
    document.documentElement.dataset.qaSessionRemovalCalls = String(
      sessionRemovalCalls,
    );
    document.documentElement.dataset.qaLastSessionRemoval =
      JSON.stringify(request);
    return Promise.resolve({ status: "blocked", activity: "unknown" });
  },
  mutateSessionMetadata(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult> {
    sessionMetadataCalls += 1;
    document.documentElement.dataset.qaSessionMetadataCalls = String(
      sessionMetadataCalls,
    );
    document.documentElement.dataset.qaLastSessionMetadata =
      JSON.stringify(request);
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    /* A metadata mutation that never settles, so `sessionMetadataPending` latches
       true and stays there. It is the only way to hold the renderer inside the
       few-hundred-millisecond window in which F149's two controls can be observed
       and clicked at leisure. */
    if (scenario === "session-metadata-stuck") {
      return new Promise<WorkbenchSessionMetadataMutationResult>(
        () => undefined,
      );
    }
    if (scenario === "session-metadata" && request.operation.kind === "archive") {
      return Promise.resolve({ status: "archived" });
    }
    return Promise.resolve({ status: "unavailable" });
  },
  removeProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectRemovalResult> {
    projectRemovalCalls += 1;
    document.documentElement.dataset.qaProjectRemovalCalls = String(
      projectRemovalCalls,
    );
    document.documentElement.dataset.qaLastProjectRemoval =
      JSON.stringify(request);
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "project-removal-success") {
      queueMicrotask(() => {
        emitProjectResult({
          ok: true,
          empty: true,
        });
      });
      return Promise.resolve({ status: "removed" });
    }
    return Promise.resolve({ status: "blocked", activity: "in-flight" });
  },
  /* Optional on the public bridge, always present on the real preload bridge,
     and the renderer keys the Project-histories affordance off its presence.
     Omitting it here rendered a Project header this build does not ship — one
     child short of the real one. `unavailable` is a real terminal outcome, so
     the affordance is drawn without inventing a history to discover. */
  discoverProjectHistories(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectHistoryDiscoveryResult> {
    projectHistoryDiscoveryCalls += 1;
    document.documentElement.dataset.qaProjectHistoryDiscoveryCalls = String(
      projectHistoryDiscoveryCalls,
    );
    document.documentElement.dataset.qaLastProjectHistoryDiscovery =
      JSON.stringify(request);
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "history-stale") {
      if (projectHistoryDiscoveryCalls === 1) {
        return new Promise((resolve) => {
          resolveStaleProjectHistory = resolve;
        });
      }
      return Promise.resolve({
        status: "discovered",
        snapshot: {
          projectLabel: "Atlas Fieldnotes",
          histories: [
            {
              historyKey:
                "project-history:00000000-0000-4000-8000-000000000303",
              current: true,
              sessionCount: 3,
              commandCount: 7,
              updateCount: 24,
              byteSize: 73_728,
              lastModified: "2026-08-18T07:16:50Z",
              schemaVersion: 5,
            },
          ],
        },
      });
    }
    if (scenario === "history-zero") {
      return Promise.resolve({
        status: "discovered",
        snapshot: { projectLabel: "Atlas Fieldnotes", histories: [] },
      });
    }
    if (scenario === "history-one") {
      return Promise.resolve({
        status: "discovered",
        snapshot: {
          projectLabel: "Atlas Fieldnotes",
          histories: [
            {
              historyKey:
                "project-history:00000000-0000-4000-8000-000000000201",
              current: true,
              sessionCount: 3,
              commandCount: 7,
              updateCount: 24,
              byteSize: 73_728,
              lastModified: "2026-08-18T07:16:50Z",
              schemaVersion: 5,
            },
          ],
        },
      });
    }
    if (
      scenario === "history-multiple" ||
      scenario === "history-empty-secondary"
    ) {
      return Promise.resolve({
        status: "discovered",
        snapshot: {
          projectLabel: "Atlas Fieldnotes",
          histories: [
            {
              historyKey:
                "project-history:00000000-0000-4000-8000-000000000201",
              current: true,
              sessionCount: 3,
              commandCount: 7,
              updateCount: 24,
              byteSize: 73_728,
              lastModified: "2026-08-18T07:16:50Z",
              schemaVersion: 5,
            },
            ...(scenario === "history-empty-secondary" &&
            emptySecondaryHistoryHidden
              ? []
              : [
                  {
                    historyKey:
                      "project-history:00000000-0000-4000-8000-000000000202",
                    current: false,
                    sessionCount:
                      scenario === "history-empty-secondary" ? 0 : 1,
                    commandCount:
                      scenario === "history-empty-secondary" ? 0 : 2,
                    updateCount:
                      scenario === "history-empty-secondary" ? 0 : 15,
                    byteSize:
                      scenario === "history-empty-secondary" ? 49_152 : 61_440,
                    lastModified: "2026-08-17T22:10:00Z",
                    schemaVersion: 5,
                  },
                ]),
          ],
        },
      });
    }
    return Promise.resolve({ status: "unavailable" });
  },
  adoptProjectHistory(): Promise<WorkbenchProjectHistoryAdoptionResult> {
    projectHistoryAdoptionCalls += 1;
    document.documentElement.dataset.qaProjectHistoryAdoptionCalls = String(
      projectHistoryAdoptionCalls,
    );
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "open-history-choice") {
      queueMicrotask(() => {
        emitProjectResult({ ok: true, view: openedProjectVisualFixture });
      });
      return Promise.resolve({ status: "adopted" });
    }
    return Promise.resolve({ status: "unavailable" });
  },
  hideProjectHistory(
    request: WorkbenchProjectHistoryHideRequest,
  ): Promise<WorkbenchProjectHistoryHideResult> {
    projectHistoryHideCalls += 1;
    document.documentElement.dataset.qaProjectHistoryHideCalls = String(
      projectHistoryHideCalls,
    );
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (
      scenario === "history-empty-secondary" &&
      request.historyKey ===
        "project-history:00000000-0000-4000-8000-000000000202"
    ) {
      emptySecondaryHistoryHidden = true;
      return Promise.resolve({ status: "hidden" });
    }
    return Promise.resolve({ status: "ineligible" });
  },
  createProject(): Promise<WorkbenchCreateProjectResult> {
    createProjectCalls += 1;
    document.documentElement.dataset.qaCreateProjectCalls = String(
      createProjectCalls,
    );
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "create-pending") return new Promise(() => undefined);
    if (scenario === "create-created") {
      queueMicrotask(() => {
        emitProjectResult({ ok: true, view: openedProjectVisualFixture });
      });
      return Promise.resolve({ outcome: "created" });
    }
    if (scenario === "create-recovery-required") {
      return Promise.resolve({ outcome: "created-recovery-required" });
    }
    if (scenario === "create-cancelled") {
      return Promise.resolve({ outcome: "cancelled" });
    }
    return Promise.resolve({ outcome: "unavailable" });
  },
  openProject(): Promise<WorkbenchOpenProjectResult> {
    openProjectCalls += 1;
    document.documentElement.dataset.qaOpenProjectCalls = String(
      openProjectCalls,
    );
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "open-pending") return new Promise(() => undefined);
    if (scenario === "open-history-choice") {
      return Promise.resolve({
        ok: true,
        status: "history-selection-required",
        message:
          "Choose which existing conversation history this Project should show. Nothing changed yet.",
        snapshot: {
          projectLabel: "Returning Project",
          histories: [
            {
              historyKey:
                "project-history:00000000-0000-4000-8000-000000000401",
              current: false,
              sessionCount: 3,
              commandCount: 7,
              updateCount: 24,
              byteSize: 73_728,
              lastModified: "2026-08-18T07:16:50Z",
              schemaVersion: 5,
            },
            {
              historyKey:
                "project-history:00000000-0000-4000-8000-000000000402",
              current: false,
              sessionCount: 1,
              commandCount: 2,
              updateCount: 15,
              byteSize: 61_440,
              lastModified: "2026-08-17T22:10:00Z",
              schemaVersion: 5,
            },
          ],
        },
      });
    }
    if (scenario === "open-adopted") {
      queueMicrotask(() => {
        emitProjectResult({ ok: true, view: openedProjectVisualFixture });
      });
      return Promise.resolve({
        ok: true,
        status: "opened",
        message: "Project was opened with its existing conversation history.",
      });
    }
    if (scenario === "open-selected") {
      queueMicrotask(() => {
        emitProjectResult({ ok: true, view: openedProjectVisualFixture });
      });
      return Promise.resolve({
        ok: true,
        status: "opened",
        message: "Project was opened.",
      });
    }
    return Promise.resolve({
      ok: true,
      status: "cancelled",
      message: "Open Project was cancelled. Nothing changed.",
    });
  },
  selectProject(
    _request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectSelectionResult> {
    projectSelectionCalls += 1;
    document.documentElement.dataset.qaProjectSelectionCalls = String(
      projectSelectionCalls,
    );
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "switching") return new Promise(() => undefined);
    if (scenario === "history-stale") {
      queueMicrotask(() => {
        emitProjectResult({ ok: true, view: secondSessionVisualFixture });
      });
      return Promise.resolve({
        ok: true,
        status: "selected",
        message: "Project was opened.",
      });
    }
    if (scenario === "unavailable") {
      return Promise.resolve({
        ok: false,
        error: {
          category: "project-unavailable",
          message:
            "This Project is unavailable. Choose another Project or restore its directory.",
        },
      });
    }
    return Promise.resolve({
      ok: true,
      status: "selected",
      message: "Project was opened.",
    });
  },
  loadDirectSessionProfile(
    request: WorkbenchDirectSessionProfileLoadRequest,
  ): Promise<WorkbenchAnyPublicDirectSessionProfileResult> {
    profileLoads += 1;
    document.documentElement.dataset.qaProfileLoads = String(profileLoads);
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    const mode = new URLSearchParams(window.location.search).get("profile");
    if (mode === "loading") return new Promise(() => undefined);
    if (scenario === "runtime-not-located") {
      return Promise.resolve({
        ok: false,
        endpointDiscovery: publicRuntimeEndpointDiscovery([
          { endpointId: "codex-desktop", category: "runtime-not-located" },
          { endpointId: "claude-code-desktop", category: "runtime-not-located" },
        ]),
        error: {
          category: "runtime-not-located",
          message:
            "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
        },
      });
    }
    if (mode === "unavailable" || scenario === "unavailable") {
      return Promise.resolve({
        ok: false,
        endpointDiscovery: publicRuntimeEndpointDiscovery([
          { endpointId: "codex-desktop", category: "inspection-failed" },
          { endpointId: "claude-code-desktop", category: "inspection-failed" },
        ]),
        error: {
          category: "profile-unavailable",
          message:
            "Codex Session Profile options are unavailable. Keep your draft and try again.",
        },
      });
    }
    if (mode === "no-default" && visualDirectProfile.ok) {
      return Promise.resolve({
        ok: true,
        endpointDiscovery: visualDirectProfile.endpointDiscovery,
        profile: {
          ...visualDirectProfile.profile,
          desiredDefault: { kind: "unavailable" },
        },
      });
    }
    if (request.kind === "continuation-session" && visualDirectProfile.ok) {
      const endpoint = visualDirectProfile.profile.endpoints[0]!;
      const desired = visualDirectProfile.profile.desiredDefault;
      if (desired.kind !== "resolved") {
        return Promise.resolve({
          ok: false,
          endpointDiscovery: visualDirectProfile.endpointDiscovery,
          error: {
            category: "continuation-unavailable",
            message:
              "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
          },
        });
      }
      return Promise.resolve({
        ok: true,
        endpointDiscovery: visualDirectProfile.endpointDiscovery,
        profile: {
          snapshotKey: "qa-continuation-snapshot",
          endpoints: Object.freeze([endpoint] as const),
          continuationPrefill: Object.freeze({
            kind: "resolved" as const,
            endpointKey: desired.endpointKey,
            modelKey: desired.modelKey,
            workIntensityKey: desired.workIntensityKey,
            executionModeKey: desired.executionModeKey,
            accessModeKey: desired.accessModeKey,
          }),
        },
      });
    }
    return Promise.resolve(visualDirectProfile);
  },
  useDirectSessionProfileAsDefault(
    _request: WorkbenchDirectSessionProfileDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult> {
    defaultSaveCalls += 1;
    document.documentElement.dataset.qaDefaultSaveCalls =
      String(defaultSaveCalls);
    const mode = new URLSearchParams(window.location.search).get(
      "preference",
    );
    if (mode === "pending") return new Promise(() => undefined);
    if (mode === "unavailable") {
      return Promise.resolve({
        ok: false,
        error: {
          category: "preference-unavailable",
          message:
            "Codex Session Profile default could not be durably saved. Keep your selection and try again.",
        },
      });
    }
    return Promise.resolve({
      ok: true,
      status: "saved",
      message: "Session Profile default was durably saved.",
    });
  },
  submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult> {
    submissionCalls += 1;
    document.documentElement.dataset.qaSubmissionCalls = String(submissionCalls);
    document.documentElement.dataset.qaLastSubmissionKind = request.kind;
    const mode = new URLSearchParams(window.location.search).get("submission");
    if (mode === "pending") return new Promise(() => undefined);
    if (mode === "error") {
      return Promise.resolve({
        ok: false,
        error: {
          category: "submission-unavailable",
          message:
            "Direct input could not be durably accepted. Keep your draft and try again.",
        },
      });
    }
    const receipt = {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    } as const;
    document.documentElement.dataset.qaLastSubmissionReceipt = receipt.status;
    return Promise.resolve(receipt);
  },
  interruptActiveTurn(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult> {
    interruptCalls += 1;
    document.documentElement.dataset.qaInterruptCalls = String(interruptCalls);
    document.documentElement.dataset.qaLastInterruptRequest =
      JSON.stringify(request);
    const scenario = new URLSearchParams(window.location.search).get("scenario");
    if (scenario === "interrupt" || scenario === "claude-running") {
      queueMicrotask(() => {
        emitProjectResult(
          Object.freeze({
            ok: true,
            view:
              scenario === "claude-running"
                ? claudeInterruptedVisualFixture
                : interruptedVisualFixture,
          }),
        );
      });
    }
    return Promise.resolve({
      ok: true,
      status: "requested",
      message: "Interrupt requested.",
    });
  },
  steerActiveTurn(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult> {
    steerCalls += 1;
    document.documentElement.dataset.qaSteerCalls = String(steerCalls);
    document.documentElement.dataset.qaLastSteerRequest = JSON.stringify(request);
    return Promise.resolve({
      ok: true,
      status: "accepted",
      message: "Guidance was accepted into the running turn.",
    });
  },
});

const root = document.querySelector<HTMLElement>("#root");
if (root !== null) {
  const windowBridge = Object.freeze({
    observeState(listener: (state: WorkbenchWindowState) => void) {
      listener(Object.freeze({ maximized: false }));
      return (): void => undefined;
    },
    minimize() {},
    toggleMaximize() {},
    close() {},
  }) satisfies WorkbenchWindowRendererBridge;
  mountWorkbench(root, bridge, windowBridge);
  const scenario = new URLSearchParams(window.location.search).get("scenario");
  const surface = new URLSearchParams(window.location.search).get("surface");
  if (scenario === "session-metadata") {
    document.documentElement.dataset.qaSessionMetadataScenario = "ready";
  }
  if (surface === "settings" || surface === "providers") {
    queueMicrotask(() => {
      document
        .querySelector<HTMLButtonElement>(".settings-rail-button")
        ?.click();
    });
  }
  if (scenario === "picker" || scenario === "runtime-not-located") {
    queueMicrotask(() => {
      document
        .querySelector<HTMLButtonElement>("#direct-runtime-endpoint")
        ?.click();
    });
  }
  if (scenario === "terminal") {
    queueMicrotask(() => {
      document
        .querySelectorAll<HTMLButtonElement>(".session-row")
        .item(1)
        .click();
    });
  }
  if (scenario === "new-session" || scenario === "draft-blocked") {
    queueMicrotask(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        "#direct-input",
      );
      if (textarea !== null) {
        textarea.value =
          scenario === "draft-blocked"
            ? "Keep this local draft in the selected Project."
            : "Keep this local draft while choosing a fresh Session Profile.";
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      if (scenario === "new-session") {
        document
          .querySelector<HTMLButtonElement>(".new-session-button")
          ?.click();
      }
    });
  }
  if (scenario === "switching") {
    queueMicrotask(() => {
      document
        .querySelectorAll<HTMLButtonElement>(".registered-project-button")
        .item(1)
        .click();
    });
  }
  if (
    scenario === "open-pending" ||
    scenario === "open-cancelled" ||
    scenario === "open-selected"
  ) {
    queueMicrotask(() => {
      if (scenario === "open-cancelled") {
        document
          .querySelectorAll<HTMLButtonElement>(".session-row")
          .item(1)
          .click();
      }
      document
        .querySelector<HTMLButtonElement>(".open-project-button")
        ?.click();
    });
  }
  if (
    scenario === "create-pending" ||
    scenario === "create-cancelled" ||
    scenario === "create-recovery-required" ||
    scenario === "create-created"
  ) {
    queueMicrotask(() => {
      document
        .querySelector<HTMLButtonElement>(".create-project-button")
        ?.click();
    });
  }
}
