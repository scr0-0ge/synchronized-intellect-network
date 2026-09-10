import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type { WorkbenchHostedProjectView } from "../../src/workbench-shell/contract.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { railCopy } from "../../src/workbench-shell/renderer/copy/rail-copy.ts";
import {
  beginCreateProject,
  beginOpenProject,
  beginProjectSelection,
  completeCreateProject,
  completeOpenProject,
  completeProjectSelection,
  initialRendererState,
  replaceProjectResult,
  type WorkbenchRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import {
  openedProjectVisualFixture,
  sessionMetadataLongNonAsciiName,
  sessionMetadataVisualFixture,
  secondSessionVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

interface ProjectRailModule {
  readonly ProjectRail: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
}

interface SessionRailRowModule {
  readonly SessionRailRow: (
    props: Readonly<Record<string, unknown>>,
  ) => unknown;
}

interface ProjectRailDisclosureState {
  readonly scopeEpoch: number;
  readonly projects: readonly ProjectRailProjectDisclosureState[];
}

interface ProjectRailProjectDisclosureState {
  readonly expanded: boolean;
  readonly overflowAvailable: boolean;
  readonly overflowExpanded: boolean;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly archivedExpanded: boolean;
}

type ProjectRailDisclosureAction =
  | Readonly<{ type: "toggle-project"; projectIndex: number }>
  | Readonly<{ type: "toggle-overflow"; projectIndex: number }>
  | Readonly<{ type: "toggle-archived"; projectIndex: number }>;

interface ProjectRailStateModule {
  readonly initialProjectRailDisclosureState: (
    scopeEpoch: number,
    activeCount: number,
    archivedCount: number,
    selectedProjectIndex?: number,
    projectCount?: number,
  ) => ProjectRailDisclosureState;
  readonly reduceProjectRailDisclosure: (
    state: ProjectRailDisclosureState,
    action: ProjectRailDisclosureAction,
  ) => ProjectRailDisclosureState;
}

interface ProjectRailReconcileModule extends ProjectRailStateModule {
  readonly reconcileProjectRailDisclosure: (
    state: ProjectRailDisclosureState,
    scopeEpoch: number,
    activeCount: number,
    archivedCount: number,
    selectedProjectIndex?: number,
    projectCount?: number,
  ) => ProjectRailDisclosureState;
}

interface ProjectScopeCorrelationModule {
  readonly didAuthoritativeProjectScopeChange: (
    previous: WorkbenchRendererState,
    next: WorkbenchRendererState,
  ) => boolean;
  readonly nextProjectScopeEpoch: (
    epoch: number,
    previous: WorkbenchRendererState,
    next: WorkbenchRendererState,
  ) => number;
}

interface InjectedProjectRailModule
  extends ProjectRailModule, ProjectRailStateModule {}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;

/**
 * The rail's disclosure and scope state may never be derived from a Project's
 * display label or from a selection key. Both orders are checked, and the two
 * halves are allowed to sit anywhere within a bounded window rather than on one
 * physical line, so reflowing the offending expression cannot hide it. The
 * nearest legitimate pairing in the real rail source is 621 characters apart.
 */
const RAIL_SCOPE_DERIVATION =
  /(?:project\.label|selectionKey)[\s\S]{0,300}?(?:disclosure|scope|epoch)|(?:disclosure|scope|epoch)[\s\S]{0,300}?(?:project\.label|selectionKey)/iu;

/**
 * A bare `slice(indexOf(a), indexOf(b))` silently becomes the empty string once
 * either anchor is renamed, which turns every negative assertion over it into a
 * guard that cannot fail. Both anchors are proven present first.
 */
function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  const section = source.slice(startIndex, endIndex);
  assert.notEqual(section.trim(), "", `empty section: ${start} … ${end}`);
  return section;
}

function projectDisclosure(
  state: ProjectRailDisclosureState,
  projectIndex = 0,
): ProjectRailProjectDisclosureState {
  const project = state.projects[projectIndex];
  assert.ok(project, `Project ${projectIndex} has disclosure state`);
  return project;
}

test("rail foot is the one accessible Settings entry beside the shortened New Session action", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const projectHtml = renderProjectRail(ProjectRail, viewWithCommandCount(1), {
      surface: "project",
    });
    const settingsHtml = renderProjectRail(ProjectRail, viewWithCommandCount(1), {
      surface: "settings",
    });
    const unavailableHtml = renderProjectRail(
      ProjectRail,
      viewWithCommandCount(1),
      {
        surface: "project",
        runtimeUnavailable: true,
      },
    );

    for (const html of [projectHtml, settingsHtml, unavailableHtml]) {
      const foot = html.match(/<div class="rail-foot">([\s\S]*?)<\/div>/u)?.[1];
      assert.ok(foot, "the Project rail renders one foot action group");
      assert.equal(foot.match(/aria-label="Settings"/gu)?.length, 1);
      assert.equal(foot.match(/>\s*⚙\s*<\/button>/gu)?.length, 1);
      assert.match(
        foot,
        /class="rail-action new-session-button"[^>]*aria-label="New Agent Session \(Ctrl\+N\)"[\s\S]*?New Session[\s\S]*?<kbd>Ctrl N<\/kbd>/u,
      );
      assert.doesNotMatch(foot, />\s*New Agent Session\s*</u);
    }

    assert.match(
      projectHtml,
      /class="icon-btn settings-rail-button" aria-label="Settings" title="Settings"/u,
    );
    assert.doesNotMatch(projectHtml, /aria-current="page"[^>]*aria-label="Settings"/u);
    assert.match(
      settingsHtml,
      /class="icon-btn settings-rail-button" aria-label="Settings" title="Settings" aria-current="page"/u,
    );
    assert.match(
      unavailableHtml,
      /class="icon-btn settings-rail-button attention" aria-label="Settings"/u,
    );

    const disabledHtml = renderProjectRail(ProjectRail, viewWithCommandCount(1), {
      actionBlocked: true,
    });
    assert.match(
      disabledHtml,
      /class="rail-action new-session-button" disabled(?:=""|\s)/u,
    );
  });
});

test("selected Project starts expanded with five Sessions and one exact overflow control", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const html = renderProjectRail(ProjectRail, viewWithCommandCount(7));
    const selected = selectedProjectSection(html);
    const toggle = projectToggle(selected);
    const panel = selected.match(
      /<div[^>]*class="proj-sessions"[^>]*>/u,
    )?.[0];
    assert.ok(panel, "the selected Project renders its Session panel");

    assert.match(selected, /class="proj is-open"/u);
    assert.match(selected, /data-open="true"/u);
    assert.match(toggle, /type="button"/u);
    assert.match(toggle, /aria-current="page"/u);
    assert.match(toggle, /aria-expanded="true"/u);
    assert.match(toggle, /aria-controls="project-sessions-1"/u);
    assert.match(panel, /id="project-sessions-1"/u);
    assert.match(selected, /class="proj-open-dot"/u);
    assert.match(selected, /aria-label="7 active Agent Sessions">7</u);
    assert.match(selected, /aria-label="New Agent Session in Atlas Fieldnotes"/u);
    assert.equal(selected.match(/class="session-row(?: [^"]*)?"/gu)?.length, 5);

    const overflow = overflowButton(selected);
    assert.equal(buttonText(overflow), "Show 2 more");
    assert.match(overflow, /type="button"/u);
    assert.match(overflow, /aria-expanded="false"/u);
    assert.match(overflow, /aria-controls="project-sessions-1"/u);
  });
});

test("selected Project disclosure has an honest action name", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const toggle = projectToggle(
      selectedProjectSection(
        renderProjectRail(ProjectRail, viewWithCommandCount(7)),
      ),
    );
    assert.match(
      toggle,
      /aria-label="Collapse Atlas Fieldnotes Agent Sessions"/u,
    );
    assert.match(toggle, /title="Collapse this Project's Sessions"/u);
  });
});

test("Project-folder collapse preserves the overflow choice and Show fewer reverses it", async () => {
  await withProjectRailStateModule((stateModule) => {
    const initial = stateModule.initialProjectRailDisclosureState(4, 7, 0);
    assert.deepEqual(initial, {
      scopeEpoch: 4,
      projects: [
        {
          expanded: true,
          overflowAvailable: true,
          overflowExpanded: false,
          activeCount: 7,
          archivedCount: 0,
          archivedExpanded: false,
        },
      ],
    });
    assert.equal(Object.isFrozen(initial), true);
    assert.equal(Object.isFrozen(initial.projects), true);

    const showingAll = stateModule.reduceProjectRailDisclosure(initial, {
      type: "toggle-overflow",
      projectIndex: 0,
    });
    assert.deepEqual(showingAll, {
      ...initial,
      projects: [
        {
          ...projectDisclosure(initial),
          overflowExpanded: true,
        },
      ],
    });

    const folderCollapsed = stateModule.reduceProjectRailDisclosure(
      showingAll,
      { type: "toggle-project", projectIndex: 0 },
    );
    assert.deepEqual(folderCollapsed, {
      ...showingAll,
      projects: [
        {
          ...projectDisclosure(showingAll),
          expanded: false,
        },
      ],
    });

    const folderReopened = stateModule.reduceProjectRailDisclosure(
      folderCollapsed,
      { type: "toggle-project", projectIndex: 0 },
    );
    assert.deepEqual(folderReopened, showingAll);

    const showingFive = stateModule.reduceProjectRailDisclosure(
      folderReopened,
      { type: "toggle-overflow", projectIndex: 0 },
    );
    assert.deepEqual(showingFive, initial);
  });
});

test("expanding a second Project preserves the first Project disclosure", async () => {
  await withProjectRailReconcileModule((stateModule) => {
    const initial = stateModule.initialProjectRailDisclosureState(4, 2, 0, 0, 2);
    const twoExpanded = stateModule.reduceProjectRailDisclosure(initial, {
      type: "toggle-project",
      projectIndex: 1,
    });

    assert.deepEqual(
      twoExpanded.projects.flatMap((project, index) =>
        project.expanded ? [index] : [],
      ),
      [0, 1],
      "opening Project 2 must not collapse Project 1",
    );

    const selectedSecond = stateModule.reconcileProjectRailDisclosure(
      initial,
      5,
      4,
      0,
      1,
      2,
    );
    assert.deepEqual(
      selectedSecond.projects.flatMap((project, index) =>
        project.expanded ? [index] : [],
      ),
      [0, 1],
      "a completed Project switch restores the target without closing the prior Project",
    );
  });
});

test("Session append preserves overflow while drop then growth normalizes it collapsed", async () => {
  await withProjectRailReconcileModule((stateModule) => {
    const initial = stateModule.initialProjectRailDisclosureState(9, 7, 0);
    const showingAll = stateModule.reduceProjectRailDisclosure(initial, {
      type: "toggle-overflow",
      projectIndex: 0,
    });

    const appended = stateModule.reconcileProjectRailDisclosure(
      showingAll,
      9,
      8,
      0,
    );
    assert.deepEqual(appended, {
      ...showingAll,
      projects: [
        {
          ...projectDisclosure(showingAll),
          activeCount: 8,
        },
      ],
    });
    assert.equal(projectDisclosure(appended).overflowExpanded, true);
    assert.equal(
      stateModule.reconcileProjectRailDisclosure(showingAll, 9, 7, 0),
      showingAll,
      "same-scope reorder and rotating snapshot keys are not disclosure inputs",
    );

    const dropped = stateModule.reconcileProjectRailDisclosure(
      appended,
      9,
      5,
      0,
    );
    assert.deepEqual(dropped, {
      ...appended,
      projects: [
        {
          ...projectDisclosure(appended),
          overflowAvailable: false,
          overflowExpanded: false,
          activeCount: 5,
        },
      ],
    });
    assert.equal(Object.isFrozen(dropped), true);

    const grown = stateModule.reconcileProjectRailDisclosure(
      dropped,
      9,
      6,
      0,
    );
    assert.deepEqual(grown, {
      ...dropped,
      projects: [
        {
          ...projectDisclosure(dropped),
          overflowAvailable: true,
          overflowExpanded: false,
          activeCount: 6,
        },
      ],
    });

    const folderCollapsed = stateModule.reduceProjectRailDisclosure(
      showingAll,
      { type: "toggle-project", projectIndex: 0 },
    );
    const restored = stateModule.reconcileProjectRailDisclosure(
      folderCollapsed,
      10,
      8,
      0,
    );
    assert.deepEqual(restored, {
      scopeEpoch: 10,
      projects: [
        {
          expanded: true,
          overflowAvailable: true,
          overflowExpanded: true,
          activeCount: 8,
          archivedCount: 0,
          archivedExpanded: false,
        },
      ],
    });
  });
});

test("one persistent overflow button changes between Show N more and Show fewer", async () => {
  const source = await readFile(
    new URL(
      "../../src/workbench-shell/renderer/project-rail.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const railSource = sourceSection(
    source,
    "const ProjectRail: Component",
    "const SessionRow: Component",
  );
  assert.equal(railSource.match(/class="more-row"/gu)?.length, 1);
  assert.doesNotMatch(railSource, /Show first 5/u);
  assert.match(
    railSource,
    /aria-expanded=\{currentDisclosure\(\)\.overflowExpanded\}/u,
  );
  assert.match(
    railSource,
    /currentDisclosure\(\)\.overflowExpanded\s*\? railCopy\.showFewer/u,
  );
  assert.equal(railCopy.showFewer, "Show fewer");
});

test("Project scope epoch advances exactly once for accepted target views and not replays", async () => {
  await withProjectScopeCorrelationModule(async (scopeModule) => {
    const ready = readyState(visualFixture);
    let epoch = 17;
    const advance = (
      previous: WorkbenchRendererState,
      next: WorkbenchRendererState,
      changed: boolean,
    ): void => {
      assert.equal(
        scopeModule.didAuthoritativeProjectScopeChange(previous, next),
        changed,
      );
      const expected = epoch + (changed ? 1 : 0);
      epoch = scopeModule.nextProjectScopeEpoch(epoch, previous, next);
      assert.equal(epoch, expected);
    };

    const resultFirstAttempt = beginProjectSelection(ready, 1).state;
    const resultFirstAccepted = completeProjectSelection(
      resultFirstAttempt,
      { ok: true, status: "selected", message: "Project was opened." },
    );
    advance(resultFirstAttempt, resultFirstAccepted, false);
    const resultFirstTarget = replaceProjectResult(resultFirstAccepted, {
      ok: true,
      view: secondSessionVisualFixture,
    });
    advance(resultFirstAccepted, resultFirstTarget, true);
    const targetReplay = replaceProjectResult(resultFirstTarget, {
      ok: true,
      view: rotateProjectSelectionKeys(secondSessionVisualFixture, "replay"),
    });
    advance(resultFirstTarget, targetReplay, false);

    const viewFirstAttempt = beginProjectSelection(ready, 1).state;
    const viewFirstTarget = replaceProjectResult(viewFirstAttempt, {
      ok: true,
      view: secondSessionVisualFixture,
    });
    advance(viewFirstAttempt, viewFirstTarget, false);
    const viewFirstAccepted = completeProjectSelection(viewFirstTarget, {
      ok: true,
      status: "selected",
      message: "Project was opened.",
    });
    advance(viewFirstTarget, viewFirstAccepted, true);

    const opening = beginOpenProject(ready);
    const openedViewFirst = replaceProjectResult(opening, {
      ok: true,
      view: openedProjectVisualFixture,
    });
    advance(opening, openedViewFirst, false);
    const opened = completeOpenProject(openedViewFirst, {
      ok: true,
      status: "opened",
      message: "Project was opened.",
    });
    advance(openedViewFirst, opened, true);

    const creating = beginCreateProject(ready);
    const createAccepted = completeCreateProject(creating, {
      outcome: "created",
    });
    advance(creating, createAccepted, false);
    const created = replaceProjectResult(createAccepted, {
      ok: true,
      view: openedProjectVisualFixture,
    });
    advance(createAccepted, created, true);

    const reopening = beginOpenProject(ready);
    const reopenAccepted = completeOpenProject(reopening, {
      ok: true,
      status: "opened",
      message: "Project was opened.",
    });
    advance(reopening, reopenAccepted, false);
    const rotatedCurrentView = rotateProjectSelectionKeys(
      visualFixture,
      "same-project",
    );
    const reopenCandidate = replaceProjectResult(reopenAccepted, {
      ok: true,
      view: rotatedCurrentView,
    });
    advance(reopenAccepted, reopenCandidate, false);
    const reopenedCurrent = replaceProjectResult(reopenCandidate, {
      ok: true,
      view: rotatedCurrentView,
    });
    advance(reopenCandidate, reopenedCurrent, false);

    const failedSwitchAttempt = beginProjectSelection(ready, 1).state;
    const failedSwitch = completeProjectSelection(failedSwitchAttempt, {
      ok: false,
      error: {
        category: "project-switch-unavailable",
        message:
          "The Project could not be opened. Keep the current Project and try again.",
      },
    });
    advance(failedSwitchAttempt, failedSwitch, false);

    const cancelledOpen = completeOpenProject(beginOpenProject(ready), {
      ok: true,
      status: "cancelled",
      message: "Open Project was cancelled. Nothing changed.",
    });
    advance(beginOpenProject(ready), cancelledOpen, false);

    const reordered = replaceProjectResult(ready, {
      ok: true,
      view: reorderProjects(visualFixture),
    });
    advance(ready, reordered, false);

    const source = await readFile(
      new URL(
        "../../src/workbench-shell/renderer/project-rail.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const correlationSource = sourceSection(
      source,
      "function didAuthoritativeProjectScopeChange",
      "function nextProjectScopeEpoch",
    );
    assert.doesNotMatch(
      correlationSource,
      /\.label|baselineSelectedIndex|targetIndex|findIndex/u,
    );
    assert.match(
      correlationSource,
      /pendingCurrentSelectionKeys\.includes\(\s*selectedProject\.selectionKey,?\s*\)/u,
    );
  });
});

test("Workbench routes only correlated Project transitions into rail scope reconciliation", async () => {
  const mountSource = await readFile(
    new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
    "utf8",
  );
  const appSource = sourceSection(
    mountSource,
    "const WorkbenchApp: Component",
    "const ResolvedWorkbench: Component",
  );
  assert.match(
    appSource,
    /const \[projectScopeEpoch, setProjectScopeEpoch\] = createSignal\(0\)/u,
  );
  assert.equal(
    appSource.match(/applyProjectStateTransition\(/gu)?.length,
    6,
    "subscription, switch, Open, Create, pending-history cancel, and pending-history adoption are the six correlated completion paths",
  );
  assert.match(
    appSource,
    /if \(cancelsPendingRegistration\) \{\s*applyProjectStateTransition\(\(currentState\) =>\s*completeOpenProject\(currentState, publicProjectOpenCancelled\(\)\)/u,
  );
  assert.match(
    appSource,
    /if \(completesPendingRegistration\) \{\s*applyProjectStateTransition\(\(currentState\) =>\s*completeOpenProject\(currentState, \{\s*ok: true,\s*status: "opened"/u,
  );
  assert.match(
    appSource,
    /setProjectScopeEpoch\(\(epoch\) =>\s*nextProjectScopeEpoch\(epoch, previous, next\)/u,
  );
  assert.match(
    appSource,
    /batch\(\(\) => \{\s*setState\(next\);\s*setProjectScopeEpoch/u,
  );
  assert.match(appSource, /projectScopeEpoch=\{projectScopeEpoch\(\)\}/u);

  const projectRailSource = await readFile(
    new URL(
      "../../src/workbench-shell/renderer/project-rail.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const railSource = sourceSection(
    projectRailSource,
    "const ProjectRail: Component",
    "const SessionRow: Component",
  );
  assert.equal(
    railSource.match(/props\.projectScopeEpoch/gu)?.length,
    3,
  );
  assert.doesNotMatch(railSource, RAIL_SCOPE_DERIVATION);
});

test("zero through five Sessions render ordinarily with no overflow control", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    for (const count of [0, 1, 5]) {
      const selected = selectedProjectSection(
        renderProjectRail(ProjectRail, viewWithCommandCount(count)),
      );
      assert.equal(
        selected.match(/class="session-row(?: [^"]*)?"/gu)?.length ?? 0,
        count,
      );
      assert.doesNotMatch(selected, /class="more-row"/u);
      assert.doesNotMatch(selected, /Show (?:\d+ more|fewer)/u);
    }

    const six = selectedProjectSection(
      renderProjectRail(ProjectRail, viewWithCommandCount(6)),
    );
    assert.equal(six.match(/class="session-row(?: [^"]*)?"/gu)?.length, 5);
    assert.equal(buttonText(overflowButton(six)), "Show 1 more");
  });
});

test("nonselected Project disclosure stays separate from its explicit switch action", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const html = renderProjectRail(ProjectRail, viewWithCommandCount(7));
    const sections = projectSections(html);
    assert.equal(sections.length, 3);
    const nonselectedAvailable = sections[1];
    assert.ok(nonselectedAvailable);
    const toggle = projectToggle(nonselectedAvailable);

    assert.match(nonselectedAvailable, /data-open="false"/u);
    assert.match(toggle, /type="button"/u);
    assert.match(toggle, /aria-expanded="false"/u);
    assert.match(
      toggle,
      /aria-label="Expand Atlas Fieldnotes Agent Sessions"/u,
    );
    assert.match(toggle, /title="Expand this Project's Sessions"/u);
    assert.doesNotMatch(nonselectedAvailable, /class="proj-empty"/u);
    assert.doesNotMatch(toggle, /disabled/u);
    assert.doesNotMatch(toggle, /aria-current/u);
    assert.doesNotMatch(nonselectedAvailable, /class="proj-open-dot"/u);
    const switchAction = projectSwitchButton(nonselectedAvailable);
    assert.equal(attributeValue(switchAction, "aria-label"), "Switch to Atlas Fieldnotes");
    assert.equal(
      attributeValue(switchAction, "title"),
      "Opening this Project loads its Sessions.",
    );
    assert.doesNotMatch(switchAction, /disabled/u);
    assert.match(
      nonselectedAvailable,
      /aria-label="Session count not loaded">—<\/span>/u,
    );
    assert.doesNotMatch(nonselectedAvailable, /class="session-row(?: [^"]*)?"/u);
    assert.doesNotMatch(nonselectedAvailable, /Agent Session 0\d/u);
    assert.doesNotMatch(html, /project-selection:|session-selection:/u);

    const source = await readFile(
      new URL(
        "../../src/workbench-shell/renderer/project-rail.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const railSource = sourceSection(
      source,
      "const ProjectRail: Component",
      "const SessionRow: Component",
    );
    assert.match(
      railSource,
      /class="proj-toggle registered-project-button"[\s\S]*?onClick=\{\(\) =>\s*updateDisclosure\(\{\s*type: "toggle-project",\s*projectIndex: index\(\),\s*\}\)\s*\}/u,
    );
    assert.match(
      railSource,
      /class="icon-btn project-switch-trigger"[\s\S]*?onClick=\{\(\) => props\.onSelectProject\(index\(\)\)\}/u,
    );
  });
});

test("cached nonselected Session rows look read-only and make no rename promise", async () => {
  await withSessionRailRowModule(({ SessionRailRow }) => {
    const command = visualFixture.commands[0];
    assert.ok(command?.session);
    const html = renderToString(() =>
      SessionRailRow({
        command,
        selected: false,
        disabled: true,
        readOnly: true,
        mutationPending: false,
        removalPending: false,
        onSelect: noOp,
        onMutate: async () => ({ status: "unchanged" }),
        onRequestRecoveryArchiveConfirmation: noOp,
        onRequestRemoval: noOp,
      }),
    );
    const row = sessionRowButton(html, command.label);

    assert.equal(hasBooleanAttribute(row, "disabled"), true);
    assert.equal(attributeValue(row, "aria-keyshortcuts"), undefined);
    assert.equal(
      attributeValue(row, "title"),
      "Cached view — read-only. Switch to this Project to select or rename this Session.",
    );
    assert.match(attributeValue(row, "class") ?? "", /\bis-read-only\b/u);
    assert.doesNotMatch(html, /class="session-row-actions"/u);
  });

  const source = await readFile(
    new URL(
      "../../src/workbench-shell/renderer/project-rail.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /\{railCopy\.cachedProjectReadOnlyNote\}/u);
});

test("adding one Project preserves existing disclosure choices", async () => {
  await withProjectRailReconcileModule((stateModule) => {
    const initial = stateModule.initialProjectRailDisclosureState(4, 2, 0, 0, 3);
    const twoExpanded = stateModule.reduceProjectRailDisclosure(initial, {
      type: "toggle-project",
      projectIndex: 1,
    });
    const appended = stateModule.reconcileProjectRailDisclosure(
      twoExpanded,
      5,
      1,
      0,
      3,
      4,
    );

    assert.deepEqual(
      appended.projects.flatMap((project, index) =>
        project.expanded ? [index] : [],
      ),
      [0, 1, 3],
    );
    assert.deepEqual(appended.projects[0], twoExpanded.projects[0]);
    assert.deepEqual(appended.projects[1], twoExpanded.projects[1]);
  });
});

test("an unloaded nonselected disclosure explains the per-run cache boundary", async () => {
  await withInjectedProjectRailModule((projectRailModule) => {
    const initial = projectRailModule.initialProjectRailDisclosureState(
      0,
      7,
      0,
      0,
      3,
    );
    const secondExpanded = projectRailModule.reduceProjectRailDisclosure(initial, {
      type: "toggle-project",
      projectIndex: 1,
    });
    const sections = projectSections(
      renderInjectedProjectRail(projectRailModule, secondExpanded),
    );
    const second = sections[1];
    assert.ok(second);

    assert.match(second, /data-open="true"/u);
    assert.match(
      second,
      /class="project-cache-note"[^>]*>Sessions are not loaded in this run\. Switch to this Project to load them\.<\/p>/u,
    );
    assert.doesNotMatch(second, /class="session-row(?: [^"]*)?"/u);
  });
});

test("runtime unavailable preserves disclosure but gates both New Session actions", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const selected = selectedProjectSection(
      renderProjectRail(ProjectRail, viewWithCommandCount(7), {
        runtimeUnavailable: true,
      }),
    );
    const toggle = projectToggle(selected);
    assert.doesNotMatch(toggle, /disabled/u);
    assert.match(toggle, /aria-expanded="true"/u);
    assert.match(
      selected,
      /aria-label="New Agent Session in Atlas Fieldnotes" title="No runtime endpoint is available" disabled/u,
    );

    const html = renderProjectRail(ProjectRail, viewWithCommandCount(7), {
      runtimeUnavailable: true,
    });
    assert.match(
      html,
      /<button type="button" class="rail-action new-session-button" disabled aria-label="New Agent Session \(Ctrl\+N\)">[\s\S]*?New Session[\s\S]*?<kbd>Ctrl N<\/kbd><\/button>/u,
    );
  });
});

test("a pre-Session command row does not advertise unavailable metadata actions", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const html = renderProjectRail(
      ProjectRail,
      viewWithCommandWithoutSession("Starting command"),
    );
    const row = sessionRowButton(html, "Starting command");

    assert.equal(attributeValue(row, "aria-keyshortcuts"), undefined);
    assert.equal(attributeValue(row, "title"), undefined);
    assert.doesNotMatch(html, /class="session-row-actions"/u);
  });
});

test("production Session rows bind Archive disabled state and title to the durable status matrix", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    for (const [status, disabled, title] of [
      [
        "accepted",
        true,
        "A turn is starting; archive is unavailable.",
      ],
      [
        "in-flight",
        true,
        "A turn is running; archive is unavailable.",
      ],
      ["completed", false, "Archive Agent Session"],
      ["failed", false, "Archive Agent Session"],
      [
        "recovery-required",
        false,
        "Confirm that this Session's final turn outcome is unknown to archive it. Archiving keeps it in Recovery required.",
      ],
    ] as const) {
      const html = renderProjectRail(
        ProjectRail,
        viewWithSingleSession(status, false, "Matrix Session"),
      );
      const archive = sessionActionButton(
        html,
        "session-archive-trigger",
        "Archive Matrix Session",
      );
      assert.equal(hasBooleanAttribute(archive, "disabled"), disabled, status);
      assert.equal(attributeValue(archive, "title"), title, status);
      assertIconOnlySessionAction(archive, title);
    }

    const activeHtml = renderProjectRail(
      ProjectRail,
      viewWithSingleSession("in-flight", false, "Matrix Session"),
    );
    const activeRow = sessionRowButton(activeHtml, "Matrix Session");
    assert.equal(attributeValue(activeRow, "aria-keyshortcuts"), "F2");
    assert.equal(
      attributeValue(activeRow, "title"),
      railCopy.renameHintTitle,
    );
    assert.doesNotMatch(activeHtml, /session-rename-trigger/u);

    const activeDelete = sessionActionButton(
      activeHtml,
      "session-removal-trigger",
      "Delete Matrix Session",
    );
    assert.equal(
      hasBooleanAttribute(activeDelete, "disabled"),
      false,
      "D16 Delete presentation remains under its independent backend guard",
    );
    assertIconOnlySessionAction(activeDelete, "Delete Agent Session");

    const archivedHtml = renderProjectRail(
      ProjectRail,
      viewWithSingleSession("failed", true, "Matrix Session"),
    );
    const restore = sessionActionButton(
      archivedHtml,
      "session-archive-trigger",
      "Restore Matrix Session",
    );
    assert.equal(hasBooleanAttribute(restore, "disabled"), false);
    assertIconOnlySessionAction(restore, "Restore Agent Session");
    const archivedDelete = sessionActionButton(
      archivedHtml,
      "session-removal-trigger",
      "Delete Matrix Session",
    );
    assertIconOnlySessionAction(archivedDelete, "Delete Agent Session");
    const archivedRow = sessionRowButton(archivedHtml, "Matrix Session");
    assert.equal(attributeValue(archivedRow, "aria-keyshortcuts"), "F2");
    assert.equal(
      attributeValue(archivedRow, "title"),
      railCopy.renameHintTitle,
    );

    const projectRailSource = await readFile(
      new URL(
        "../../src/workbench-shell/renderer/project-rail.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const sessionRowSource = sourceSection(
      projectRailSource,
      "const SessionRailRow: Component",
      "function commandModelLabel",
    );
    assert.match(
      sessionRowSource,
      /onDoubleClick=\{\(event\) =>\s*beginSessionRenameFromRowDoubleClick\(event, beginRename\)\s*\}/u,
    );
    assert.match(
      sessionRowSource,
      /onKeyDown=\{\(event\) =>\s*beginSessionRenameFromRowKeyboard\(event, beginRename\)\s*\}/u,
    );
    assert.match(
      sessionRowSource,
      /onDblClick=\{props\.renameAvailable \? props\.onDoubleClick : undefined\}/u,
    );
    assert.match(
      sessionRowSource,
      /onKeyDown=\{props\.renameAvailable \? props\.onKeyDown : undefined\}/u,
    );
    assert.doesNotMatch(sessionRowSource, /data-session-command-key/u);
  });
});

test("long non-ASCII active and archived names retain exact action names and contained disclosure structure", async () => {
  await withProjectRailModule(async ({ ProjectRail }) => {
    const longName = sessionMetadataLongNonAsciiName;
    assert.equal(Array.from(longName).length, 80);

    const active = selectedProjectSection(
      renderProjectRail(ProjectRail, sessionMetadataVisualFixture),
    );
    assert.match(
      active,
      new RegExp(
        `<span class="sr-title">${escapeRegExp(longName)}</span>`,
        "u",
      ),
    );
    for (const [className, name, title] of [
      [
        "session-archive-trigger",
        `Archive ${longName}`,
        "Archive Agent Session",
      ],
      ["session-removal-trigger", `Delete ${longName}`, "Delete Agent Session"],
    ] as const) {
      assertIconOnlySessionAction(
        sessionActionButton(active, className, name),
        title,
      );
    }
    assert.doesNotMatch(active, /session-rename-trigger/u);
    assert.equal(
      attributeValue(sessionRowButton(active, longName), "aria-keyshortcuts"),
      "F2",
    );
    assert.match(
      active,
      /<div[^>]*class="session-row-shell"[^>]*>[\s\S]*?<div[^>]*class="session-row-actions"[^>]*>/u,
    );
    assert.match(active, /class="archived-disclosure"[^>]*>Archived \(1\)/u);
    assert.doesNotMatch(active, /class="archived-session-list"/u);

    const archived = selectedProjectSection(
      renderProjectRail(
        ProjectRail,
        viewWithSingleSession("failed", true, longName),
      ),
    );
    assert.match(archived, /class="archived-disclosure"[^>]*>Archived \(1\)/u);
    assert.match(archived, /class="archived-session-list"/u);
    assertIconOnlySessionAction(
      sessionActionButton(
        archived,
        "session-archive-trigger",
        `Restore ${longName}`,
      ),
      "Restore Agent Session",
    );
    assertIconOnlySessionAction(
      sessionActionButton(
        archived,
        "session-removal-trigger",
        `Delete ${longName}`,
      ),
      "Delete Agent Session",
    );
    assert.equal(
      attributeValue(sessionRowButton(archived, longName), "aria-keyshortcuts"),
      "F2",
    );
  });
});

test("rendered collapse and reopen preserve selected Project facts and expanded overflow", async () => {
  await withInjectedProjectRailModule((projectRailModule) => {
    const initial = projectRailModule.initialProjectRailDisclosureState(
      0,
      7,
      0,
      0,
      3,
    );
    const showingAll = projectRailModule.reduceProjectRailDisclosure(initial, {
      type: "toggle-overflow",
      projectIndex: 0,
    });
    const folderCollapsed = projectRailModule.reduceProjectRailDisclosure(
      showingAll,
      { type: "toggle-project", projectIndex: 0 },
    );

    const collapsed = selectedProjectSection(
      renderInjectedProjectRail(projectRailModule, folderCollapsed),
    );
    const collapsedToggle = projectToggle(collapsed);
    assert.match(collapsed, /class="proj is-open"/u);
    assert.match(collapsed, /data-open="false"/u);
    assert.match(collapsedToggle, /aria-current="page"/u);
    assert.match(collapsedToggle, /aria-expanded="false"/u);
    assert.match(
      collapsedToggle,
      /aria-label="Expand Atlas Fieldnotes Agent Sessions"/u,
    );
    assert.match(
      collapsedToggle,
      /title="Expand this Project's Sessions"/u,
    );
    assert.match(collapsed, /class="proj-open-dot"/u);
    assert.match(collapsed, /aria-label="7 active Agent Sessions">7/u);
    assert.match(
      collapsed,
      /aria-label="New Agent Session in Atlas Fieldnotes"/u,
    );
    assert.equal(
      collapsed.match(/class="session-row(?: [^"]*)?"/gu)?.length,
      7,
    );
    assert.equal(buttonText(overflowButton(collapsed)), "Show fewer");
    assert.match(overflowButton(collapsed), /aria-expanded="true"/u);

    const folderReopened = projectRailModule.reduceProjectRailDisclosure(
      folderCollapsed,
      { type: "toggle-project", projectIndex: 0 },
    );
    const reopened = selectedProjectSection(
      renderInjectedProjectRail(projectRailModule, folderReopened),
    );
    assert.match(reopened, /data-open="true"/u);
    assert.match(projectToggle(reopened), /aria-expanded="true"/u);
    assert.equal(
      reopened.match(/class="session-row(?: [^"]*)?"/gu)?.length,
      7,
    );
    assert.equal(buttonText(overflowButton(reopened)), "Show fewer");
    assert.equal(
      overflowButton(collapsed).match(/<button[^>]*>/u)?.[0],
      overflowButton(reopened).match(/<button[^>]*>/u)?.[0],
      "the persistent focused control keeps the same native-button identity surface",
    );

    const showingFive = projectRailModule.reduceProjectRailDisclosure(
      folderReopened,
      { type: "toggle-overflow", projectIndex: 0 },
    );
    const five = selectedProjectSection(
      renderInjectedProjectRail(projectRailModule, showingFive),
    );
    assert.equal(
      five.match(/class="session-row(?: [^"]*)?"/gu)?.length,
      5,
    );
    assert.equal(buttonText(overflowButton(five)), "Show 2 more");
    assert.match(overflowButton(five), /aria-expanded="false"/u);
  });
});

function renderProjectRail(
  ProjectRail: ProjectRailModule["ProjectRail"],
  view: WorkbenchHostedProjectView,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return renderToString(() =>
    ProjectRail({
      view,
      selectedKey: view.initialSelectionKey,
      runtimeUnavailable: false,
      projectSwitch: initialRendererState.projectSwitch,
      projectOpen: initialRendererState.projectOpen,
      projectScopeEpoch: 0,
      canCreateProject: () => true,
      onCreateProject: noOp,
      canOpenProject: () => true,
      onOpenProject: noOp,
      canSelectProject: () => true,
      onSelectProject: noOp,
      onSelect: noOp,
      onEnterNewSession: noOp,
      surface: "project",
      onSurface: noOp,
      draftBlocked: false,
      actionBlocked: false,
      sessionMetadataPending: false,
      onMutateSessionMetadata: async () => ({ status: "failed" }),
      removalPending: false,
      removalNotice: null,
      onRequestSessionRemoval: noOp,
      onRequestProjectRemoval: noOp,
      ...overrides,
    }),
  );
}

function renderInjectedProjectRail(
  projectRailModule: InjectedProjectRailModule,
  disclosure: ProjectRailDisclosureState,
): string {
  const property = "__projectRailDisclosure";
  const original = Object.getOwnPropertyDescriptor(globalThis, property);
  Object.defineProperty(globalThis, property, {
    configurable: true,
    value: disclosure,
  });
  try {
    return renderProjectRail(
      projectRailModule.ProjectRail,
      viewWithCommandCount(7),
    );
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, property);
    } else {
      Object.defineProperty(globalThis, property, original);
    }
  }
}

function viewWithCommandCount(count: number): WorkbenchHostedProjectView {
  const seed = visualFixture.commands[0];
  assert.ok(seed);
  const commands = Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        ...seed,
        key: `command-${index + 1}`,
        label: `Agent Session ${String(index + 1).padStart(2, "0")}`,
      }),
    ),
  );
  return Object.freeze({
    ...visualFixture,
    observation: Object.freeze({ cursor: count, live: true }),
    commands,
    initialSelectionKey: commands[0]?.key ?? null,
  });
}

function viewWithSingleSession(
  status: WorkbenchHostedProjectView["commands"][number]["status"],
  archived: boolean,
  label: string,
): WorkbenchHostedProjectView {
  const seed = visualFixture.commands[0];
  assert.ok(seed?.session);
  const command = Object.freeze({
    ...seed,
    label,
    status,
    session: Object.freeze({
      ...seed.session,
      archived,
      resumable: !archived && status === "completed",
      selectionKey:
        !archived && status === "completed"
          ? seed.session.selectionKey
          : null,
    }),
  });
  return Object.freeze({
    ...visualFixture,
    observation: Object.freeze({ cursor: 1, live: true }),
    commands: Object.freeze([command]),
    initialSelectionKey: command.key,
  });
}

function viewWithCommandWithoutSession(
  label: string,
): WorkbenchHostedProjectView {
  const seed = visualFixture.commands[0];
  assert.ok(seed);
  const { session: _session, ...commandWithoutSession } = seed;
  const command = Object.freeze({
    ...commandWithoutSession,
    label,
    status: "accepted" as const,
  });
  return Object.freeze({
    ...visualFixture,
    observation: Object.freeze({ cursor: 1, live: true }),
    commands: Object.freeze([command]),
    initialSelectionKey: command.key,
  });
}

function readyState(view: WorkbenchHostedProjectView): WorkbenchRendererState {
  return replaceProjectResult(initialRendererState, { ok: true, view });
}

function rotateProjectSelectionKeys(
  view: WorkbenchHostedProjectView,
  suffix: string,
): WorkbenchHostedProjectView {
  return Object.freeze({
    ...view,
    observation: Object.freeze({
      cursor: view.observation.cursor + 1,
      live: view.observation.live,
    }),
    projectSelection: Object.freeze({
      projects: Object.freeze(
        view.projectSelection.projects.map((project, index) =>
          Object.freeze({
            ...project,
            selectionKey: `project-selection:${suffix}:${index + 1}`,
          }),
        ),
      ),
    }),
  });
}

function reorderProjects(
  view: WorkbenchHostedProjectView,
): WorkbenchHostedProjectView {
  return Object.freeze({
    ...rotateProjectSelectionKeys(view, "reordered"),
    projectSelection: Object.freeze({
      projects: Object.freeze(
        [...view.projectSelection.projects]
          .reverse()
          .map((project, index) =>
            Object.freeze({
              ...project,
              selectionKey: `project-selection:reordered:${index + 1}`,
            }),
          ),
      ),
    }),
  });
}

function selectedProjectSection(html: string): string {
  const section = html.match(
    /<section[^>]*class="proj is-open"[^>]*>[\s\S]*?<\/section>/u,
  )?.[0];
  assert.ok(section, "the selected Project section renders");
  return section;
}

function projectSections(html: string): readonly string[] {
  return [...html.matchAll(/<section[^>]*class="[^"]*\bproj\b[^"]*"[^>]*>[\s\S]*?<\/section>/gu)]
    .map((match) => match[0] ?? "");
}

function projectToggle(section: string): string {
  const button = section.match(
    /<button[^>]*class="proj-toggle registered-project-button"[^>]*>/u,
  )?.[0];
  assert.ok(button, "the Project disclosure is a native button");
  return button;
}

function projectSwitchButton(section: string): string {
  const button = section.match(
    /<button[^>]*class="icon-btn project-switch-trigger"[^>]*>/u,
  )?.[0];
  assert.ok(button, "the Project switch is a separate native button");
  return button;
}

function overflowButton(section: string): string {
  const button = section.match(
    /<button[^>]*class="more-row"[^>]*>[\s\S]*?<\/button>/u,
  )?.[0];
  assert.ok(button, "the overflow control renders after the Session list");
  return button;
}

function buttonText(button: string): string {
  return button.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim();
}

function sessionActionButton(
  html: string,
  className: string,
  accessibleName: string,
): string {
  const button = html.match(
    new RegExp(
      `<button[^>]*class="[^"]*\\b${escapeRegExp(className)}\\b[^"]*"[^>]*aria-label="${escapeRegExp(accessibleName)}"[^>]*>[\\s\\S]*?<\\/button>`,
      "u",
    ),
  )?.[0];
  assert.ok(button, `${accessibleName} renders as an actual production button`);
  return button;
}

function sessionRowButton(html: string, accessibleNamePrefix: string): string {
  const button = [...html.matchAll(/<button\b[^>]*>/gu)]
    .map((match) => match[0] ?? "")
    .find((candidate) => {
      const className = attributeValue(candidate, "class") ?? "";
      const accessibleName = attributeValue(candidate, "aria-label") ?? "";
      return (
        className.split(/\s+/u).includes("session-row") &&
        accessibleName.startsWith(accessibleNamePrefix + ", ")
      );
    });
  assert.ok(button, `${accessibleNamePrefix} renders as a Session row button`);
  return button;
}

function assertIconOnlySessionAction(button: string, title: string): void {
  assert.match(button, /class="[^"]*\bsession-icon-action\b/u);
  assert.equal(attributeValue(button, "title"), title);
  assert.match(button, /<svg\b[^>]*aria-hidden="true"[^>]*>/u);
  assert.equal(buttonText(button), "");
}

function attributeValue(element: string, name: string): string | undefined {
  return element.match(
    new RegExp(`\\b${escapeRegExp(name)}="([^"]*)"`, "u"),
  )?.[1];
}

function hasBooleanAttribute(element: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}(?:="")?(?:\\s|>)`, "u").test(
    element,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function withProjectRailModule(
  assertion: (projectRailModule: ProjectRailModule) => Promise<void> | void,
): Promise<void> {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const projectRailModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as ProjectRailModule;
    await assertion(projectRailModule);
  } finally {
    await server.close();
  }
}

async function withProjectRailStateModule(
  assertion: (projectRailModule: ProjectRailStateModule) => Promise<void> | void,
): Promise<void> {
  const exposeProjectRailState: Plugin = {
    name: "expose-project-rail-state",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/project-rail.tsx")
      ) {
        return `${source}\nexport { initialProjectRailDisclosureState, reduceProjectRailDisclosure };`;
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeProjectRailState, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const projectRailModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as ProjectRailStateModule;
    await assertion(projectRailModule);
  } finally {
    await server.close();
  }
}

async function withSessionRailRowModule(
  assertion: (projectRailModule: SessionRailRowModule) => Promise<void> | void,
): Promise<void> {
  const exposeSessionRailRow: Plugin = {
    name: "expose-session-rail-row",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/project-rail.tsx")
      ) {
        return `${source}\nexport { SessionRailRow };`;
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeSessionRailRow, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const projectRailModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as SessionRailRowModule;
    await assertion(projectRailModule);
  } finally {
    await server.close();
  }
}

async function withProjectRailReconcileModule(
  assertion: (
    projectRailModule: ProjectRailReconcileModule,
  ) => Promise<void> | void,
): Promise<void> {
  const exposeProjectRailState: Plugin = {
    name: "expose-project-rail-reconciliation",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/project-rail.tsx")
      ) {
        return `${source}\nexport { initialProjectRailDisclosureState, reduceProjectRailDisclosure, reconcileProjectRailDisclosure };`;
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeProjectRailState, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const projectRailModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as ProjectRailReconcileModule;
    await assertion(projectRailModule);
  } finally {
    await server.close();
  }
}

async function withProjectScopeCorrelationModule(
  assertion: (
    projectScopeModule: ProjectScopeCorrelationModule,
  ) => Promise<void> | void,
): Promise<void> {
  const exposeProjectScopeCorrelation: Plugin = {
    name: "expose-project-scope-correlation",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/project-rail.tsx")
      ) {
        return `${source}\nexport { didAuthoritativeProjectScopeChange };`;
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeProjectScopeCorrelation, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const projectScopeModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as ProjectScopeCorrelationModule;
    await assertion(projectScopeModule);
  } finally {
    await server.close();
  }
}

async function withInjectedProjectRailModule(
  assertion: (
    projectRailModule: InjectedProjectRailModule,
  ) => Promise<void> | void,
): Promise<void> {
  const injectProjectRailState: Plugin = {
    name: "inject-project-rail-state",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/project-rail.tsx")
      ) {
        return;
      }
      const signalSource = `  const [disclosure, setDisclosure] = createSignal(
    initialProjectRailDisclosureState(
      props.projectScopeEpoch,
      selectedActiveCommands().length,
      selectedArchivedCommands().length,
      selectedProjectIndex(),
      props.view.projectSelection.projects.length,
    ),
  );`;
      const injectedSignalSource = `  const injectedDisclosure = (
    globalThis as typeof globalThis & {
      readonly __projectRailDisclosure?: ProjectRailDisclosureState;
    }
  ).__projectRailDisclosure;
  const [disclosure, setDisclosure] = createSignal(
    injectedDisclosure ??
      initialProjectRailDisclosureState(
        props.projectScopeEpoch,
        selectedActiveCommands().length,
        selectedArchivedCommands().length,
        selectedProjectIndex(),
        props.view.projectSelection.projects.length,
      ),
  );`;
      assert.ok(
        source.includes(signalSource),
        "the test injects only at the ProjectRail disclosure initializer",
      );
      return `${source.replace(
        signalSource,
        injectedSignalSource,
      )}\nexport { initialProjectRailDisclosureState, reduceProjectRailDisclosure };`;
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [injectProjectRailState, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const projectRailModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/project-rail.tsx",
    )) as InjectedProjectRailModule;
    await assertion(projectRailModule);
  } finally {
    await server.close();
  }
}
