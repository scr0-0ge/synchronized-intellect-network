import { render } from "solid-js/web";

import { ProjectRail } from "../../src/workbench-shell/renderer/project-rail.tsx";
import {
  ProjectHistoriesDialog,
  RemovalConfirmationDialog,
} from "../../src/workbench-shell/renderer/dialogs.tsx";
import {
  projectRemovalConfirmation,
  removalFeedback,
} from "../../src/workbench-shell/renderer/removal-presentation.ts";
import {
  beginOpenProject,
  completeOpenProject,
  initialRendererState,
  projectHistoryAdoptionFeedback,
  replaceProjectResult,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { setLocale } from "../../src/workbench-shell/renderer/locale.ts";
import {
  openedProjectVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

declare global {
  interface Window {
    __worker445I18nProbe: Readonly<{
      setLocale: typeof setLocale;
      sameNodes: () => boolean;
    }>;
  }
}

const noOp = (): void => undefined;

setLocale("en");
const ready = replaceProjectResult(initialRendererState, {
  ok: true,
  view: visualFixture,
});
const opening = beginOpenProject(ready);
const viewArrived = replaceProjectResult(opening, {
  ok: true,
  view: openedProjectVisualFixture,
});
const opened = completeOpenProject(viewArrived, {
  ok: true,
  status: "opened",
  message: "Project was opened.",
});
const storedRemovalFeedback = removalFeedback("session", {
  status: "removed",
});
const storedProjectConfirmation = projectRemovalConfirmation({
  label: "Atlas Fieldnotes",
  availability: "available",
  selected: true,
  selectionKey:
    "project-selection:00000000-0000-4000-8000-000000000445",
});
const storedHistoryFeedback = projectHistoryAdoptionFeedback({
  status: "adopted",
});
const host = document.querySelector<HTMLElement>("#probe");
if (host === null) throw new Error("missing-i18n-probe-host");

render(
  () => (
    <>
      <ProjectRail
        view={openedProjectVisualFixture}
        selectedKey={openedProjectVisualFixture.initialSelectionKey}
        surface="project"
        onSurface={noOp}
        runtimeUnavailable={false}
        historyRecoveryAttention={false}
        projectSwitch={opened.projectSwitch}
        projectOpen={opened.projectOpen}
        projectScopeEpoch={0}
        canCreateProject={() => true}
        onCreateProject={noOp}
        canOpenProject={() => true}
        onOpenProject={noOp}
        canSelectProject={() => true}
        onSelectProject={noOp}
        onSelect={noOp}
        onEnterNewSession={noOp}
        draftBlocked={false}
        actionBlocked={false}
        sessionMetadataPending={false}
        onMutateSessionMetadata={async () => ({ status: "unavailable" })}
        removalPending={false}
        removalNotice={storedRemovalFeedback}
        onRequestSessionRemoval={noOp}
        onRequestProjectRemoval={noOp}
        projectHistoriesPending={false}
      />
      <RemovalConfirmationDialog
        confirmation={storedProjectConfirmation}
        pending={false}
        onCancel={noOp}
        onConfirm={noOp}
      />
      <ProjectHistoriesDialog
        projectLabel="Atlas Fieldnotes"
        result={null}
        pending={false}
        notice={storedHistoryFeedback}
        onClose={noOp}
        onAdopt={noOp}
        onHide={noOp}
      />
    </>
  ),
  host,
);

const projectFeedbackNode = document.querySelector(
  ".rail-feedback:not(.rail-removal-notice)",
);
const removalFeedbackNode = document.querySelector(".rail-removal-notice");
const removalTitleNode = document.querySelector(
  ".removal-dialog:not(.project-histories-dialog) h2",
);
const removalDescriptionNode = document.querySelector(
  ".removal-dialog:not(.project-histories-dialog) h2 + p",
);
const removalConfirmNode = document.querySelector(
  ".removal-dialog:not(.project-histories-dialog) .removal-confirm-button",
);
const historyFeedbackNode = document.querySelector(
  ".project-histories-notice",
);
if (
  projectFeedbackNode === null ||
  removalFeedbackNode === null ||
  removalTitleNode === null ||
  removalDescriptionNode === null ||
  removalConfirmNode === null ||
  historyFeedbackNode === null
) {
  throw new Error("missing-mounted-i18n-feedback");
}

window.__worker445I18nProbe = Object.freeze({
  setLocale,
  sameNodes: () =>
    document.querySelector(".rail-feedback:not(.rail-removal-notice)") ===
      projectFeedbackNode &&
    document.querySelector(".rail-removal-notice") === removalFeedbackNode &&
    document.querySelector(
      ".removal-dialog:not(.project-histories-dialog) h2",
    ) === removalTitleNode &&
    document.querySelector(
      ".removal-dialog:not(.project-histories-dialog) h2 + p",
    ) === removalDescriptionNode &&
    document.querySelector(
      ".removal-dialog:not(.project-histories-dialog) .removal-confirm-button",
    ) === removalConfirmNode &&
    document.querySelector(".project-histories-notice") ===
      historyFeedbackNode,
});
