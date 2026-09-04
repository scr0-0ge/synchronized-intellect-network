/* F149. A control whose `disabled` expression omits a term its own handler
   refuses on is a button that looks willing and does nothing: no spinner, no
   notice, no dialog. This file holds the two controls that were caught in that
   state, and the invariant that is meant to catch the next one.

   The live half deliberately holds the renderer inside the window the defect
   lives in. In the product a session archive/rename/delete IPC settles in a few
   hundred milliseconds; the `session-metadata-stuck` harness scenario returns a
   promise that never settles, so `sessionMetadataPending` latches true and the
   two controls can be looked at, and clicked, at leisure. */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";

import { removeTestDirectory } from "../helpers/test-lifecycle.ts";
import { createViteBrowserTestServer } from "../helpers/vite-server.ts";
import type { WorkbenchCatalogDefaultPublicProfileResult } from "../../src/workbench-shell/contract.ts";
import {
  beginCreateProject,
  beginDirectInputSubmission,
  beginDirectSessionProfileDefaultSave,
  beginDirectSessionProfileLoad,
  beginOpenProject,
  beginProjectSelection,
  canCancelNewAgentSessionMode,
  canCreateProject,
  canEnterNewAgentSessionMode,
  canOpenProject,
  canSelectProject,
  canSubmitDirectInput,
  canUseDirectSessionProfileAsDefault,
  cancelNewAgentSessionMode,
  completeDirectSessionProfileLoad,
  enterNewAgentSessionMode,
  initialRendererState,
  replaceProjectResult,
  updateDirectInputDraft,
  type WorkbenchRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { visualFixture } from "./visual-harness/fixture.ts";

const harnessRoot = fileURLToPath(
  new URL("./visual-harness/", import.meta.url),
);
const harnessMain = fileURLToPath(
  new URL("./visual-harness/electron-main.mjs", import.meta.url),
);
const electronExecutable = createRequire(import.meta.url)("electron") as string;
const activeApplications = new Set<ElectronApplication>();

let isolatedUserDataRoot = "";
let server: ViteDevServer | undefined;
let harnessUrl = "";

before(async () => {
  isolatedUserDataRoot = resolve(
    await mkdtemp(join(tmpdir(), "uaw-guard-disabled-")),
  );
  server = await createViteBrowserTestServer({
    configFile: false,
    root: harnessRoot,
    logLevel: "silent",
    plugins: [solid()],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  harnessUrl = server.resolvedUrls?.local[0] ?? "";
  assert.notEqual(harnessUrl, "", "the renderer harness must listen");
});

after(async () => {
  try {
    await closeActiveApplications();
  } finally {
    try {
      await server?.close();
    } finally {
      if (isolatedUserDataRoot !== "") {
        assert.equal(isAbsolute(isolatedUserDataRoot), true);
        assert.match(basename(isolatedUserDataRoot), /^uaw-guard-disabled-/u);
        await removeTestDirectory(isolatedUserDataRoot);
      }
    }
  }
});

/* The controls this file is about, named by the class the rail gives them. Both
   sit in the header of the selected Project, beside the two that were already
   correct. */
const HISTORIES_TRIGGER = ".proj.is-open .project-histories-trigger";
const PROJECT_REMOVAL_TRIGGER = ".proj.is-open .project-removal-trigger";
const ARCHIVE_TRIGGER = ".session-archive-trigger";
const SESSION_REMOVAL_TRIGGER = ".session-removal-trigger";

interface ControlObservation {
  readonly present: boolean;
  readonly disabled: boolean;
}

function observeControls(page: Page): Promise<Record<string, ControlObservation>> {
  return page.evaluate((selectors) => {
    const entries = Object.entries(selectors).map(([name, selector]) => {
      const node = document.querySelector<HTMLButtonElement>(selector);
      return [
        name,
        { present: node !== null, disabled: node?.disabled ?? false },
      ] as const;
    });
    return Object.fromEntries(entries) as Record<
      string,
      { present: boolean; disabled: boolean }
    >;
  }, {
    histories: HISTORIES_TRIGGER,
    projectRemoval: PROJECT_REMOVAL_TRIGGER,
    archive: ARCHIVE_TRIGGER,
    sessionRemoval: SESSION_REMOVAL_TRIGGER,
  });
}

function observeEffects(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({
    discoveryCalls:
      document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ?? "0",
    metadataCalls:
      document.documentElement.dataset.qaSessionMetadataCalls ?? "0",
    confirmationOpen: String(
      document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
    ),
  }));
}

test(
  "the Project history and Project removal controls are disabled while a session-metadata mutation is in flight",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness(
      "scenario=session-metadata-stuck",
    );
    try {
      /* Anti-vacuity, first half: with nothing in flight the two controls exist
         and are live. A fix that simply nailed them shut would pass the real
         assertion below and fail here. */
      const atRest = await observeControls(page);
      assert.deepEqual(
        atRest,
        {
          histories: { present: true, disabled: false },
          projectRemoval: { present: true, disabled: false },
          archive: { present: true, disabled: false },
          sessionRemoval: { present: true, disabled: false },
        },
        "with no mutation in flight all four Project/Session controls are live",
      );

      /* Anti-vacuity, second half: they are live because a click on one of them
         actually reaches its handler. */
      await page.locator(HISTORIES_TRIGGER).click({ timeout: 5_000 });
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ===
            "1",
        undefined,
        { timeout: 5_000 },
      );
      await page
        .locator(".project-histories-dialog .removal-dialog-actions .btn")
        .click({ timeout: 5_000 });
      await page
        .locator('[role="dialog"][aria-modal="true"]')
        .waitFor({ state: "hidden", timeout: 5_000 });

      /* Latch the pending mutation. The harness never settles it. */
      await page.locator(ARCHIVE_TRIGGER).first().click({ timeout: 5_000 });
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSessionMetadataCalls === "1",
        undefined,
        { timeout: 5_000 },
      );

      const inFlight = await observeControls(page);
      assert.deepEqual(
        inFlight,
        {
          histories: { present: true, disabled: true },
          projectRemoval: { present: true, disabled: true },
          archive: { present: true, disabled: true },
          sessionRemoval: { present: true, disabled: true },
        },
        [
          "While `sessionMetadataPending` is true, mount.tsx refuses",
          "`requestProjectHistories` (:936) and `requestProjectRemoval` (:920).",
          "Every control that routes to a refusing handler must say so with",
          "`disabled`; one that does not swallows the click in silence.",
        ].join(" "),
      );

      /* And the refusal is real, not merely declared: a click that the browser
         does deliver produces no effect at all. Dispatched rather than driven
         through the pointer because Playwright will not click a disabled
         control, which is exactly the state under test. */
      const before = await observeEffects(page);
      await page.evaluate((selectors) => {
        for (const selector of selectors) {
          document.querySelector<HTMLButtonElement>(selector)?.click();
        }
      }, [HISTORIES_TRIGGER, PROJECT_REMOVAL_TRIGGER]);
      await page.waitForTimeout(150);
      assert.deepEqual(
        await observeEffects(page),
        before,
        "a click delivered during the mutation reaches a handler that refuses it",
      );
    } finally {
      await application.close();
    }
  },
);

async function openHarness(
  query: string,
): Promise<Readonly<{ application: ElectronApplication; page: Page }>> {
  const userDataDirectory = resolve(
    await mkdtemp(join(isolatedUserDataRoot, "guard-disabled-")),
  );
  assert.equal(isAbsolute(userDataDirectory), true);
  assert.equal(
    userDataDirectory.startsWith(`${isolatedUserDataRoot}${sep}`),
    true,
  );
  assert.match(basename(userDataDirectory), /^guard-disabled-/u);
  const targetUrl = new URL(harnessUrl);
  targetUrl.search = query;
  // One line per launch (issue 161 item 4).
  console.log(
    `qa harness launch: surface=${targetUrl.search || "(no query)"} userData=${userDataDirectory} (visual-harness/electron-main.mjs places it off every monitor)`,
  );
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [harnessMain, `--user-data-dir=${userDataDirectory}`],
      env: {
        ...process.env,
        UAW_QA_URL: targetUrl.href,
        UAW_QA_WIDTH: "1280",
        UAW_QA_HEIGHT: "820",
      },
      timeout: 15_000,
    });
    activeApplications.add(application);
    application.on("close", () => activeApplications.delete(application!));
    const page = await application.firstWindow({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    await page.locator(".app").waitFor({ state: "visible" });
    return Object.freeze({ application, page });
  } catch (error) {
    if (application) await closeAfterSetupFailure(application, error);
    throw error;
  }
}

async function closeActiveApplications(): Promise<void> {
  const errors: unknown[] = [];
  for (const application of [...activeApplications]) {
    try {
      await application.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Multiple Electron applications failed to close.",
    );
  }
}

async function closeAfterSetupFailure(
  application: ElectronApplication,
  setupError: unknown,
): Promise<never> {
  try {
    await application.close();
  } catch (closeError) {
    throw new AggregateError(
      [setupError, closeError],
      "Electron harness setup and application cleanup both failed.",
    );
  }
  throw setupError;
}

/* ---------------------------------------------------------------------------
   The invariant.

   The repair above is two terms. The reason a cycle was spent on it is that this
   is the fifth instance of one shape (F60, F77, F88, F141, F149) and the repo
   held no control that could find the sixth. `renderer-view-model.test.ts:1042`
   is six fixed regexes about one screen pair; it could not catch an instance
   anywhere else.

   What follows is a control that does not know which pair is broken. For every
   predicate/handler pair in `view-model.ts` that is a pure reducer over the
   closed phase unions, it asserts

       predicate(state) === handlerHadAnEffect(state)

   over the COMPLETE product of those unions. Both directions are asserted:
   `predicate true && handler refuses` is F149 exactly, and `predicate false &&
   handler acts` is a control that lies about being shut.

   Read the scope honestly. This sweeps the product of the six `phase` unions.
   Every other field is held at one fully-populated, valid configuration, chosen
   so that no DATA guard in any handler can fire. That is deliberate — it is what
   makes a disagreement mean "the predicate and the handler disagree about state"
   rather than "the fixture was incomplete" — and it is also exactly why this
   invariant cannot see the data-guard class at all. See the report for what that
   leaves uncovered.

   The phase lists are DERIVED from view-model.ts at test time and checked against
   the swept lists. A union that gains a member turns this file red rather than
   quietly shrinking the sweep to a sample. --------------------------------- */


const COMPOSER_PHASES = ["idle", "pending", "accepted", "error"] as const;
const PROFILE_PHASES = [
  "idle",
  "loading",
  "ready",
  "unavailable",
  "runtime-not-located",
] as const;
const DEFAULT_PREFERENCE_PHASES = ["idle", "pending", "saved", "error"] as const;
const NEW_SESSION_PHASES = [
  "inactive",
  "active",
  "submitting",
  "awaiting-visible",
] as const;
const PROJECT_SWITCH_PHASES = ["idle", "pending", "error"] as const;
const PROJECT_OPEN_PHASES = [
  "idle",
  "pending",
  "opened",
  "created",
  "cancelled",
  "recovery-required",
  "error",
] as const;

/* The draft axis is not a phase, but several of the predicates read it and they
   disagree about which value permits them: the Project-acquisition pair requires
   an empty draft, submission requires a valid non-empty one. Both are swept so
   that no pair is asserted only in the draft state that suits it. */
const DRAFTS = ["", "Carry the plan forward."] as const;

/* `state.result` is a three-way discriminant, not a boolean: several predicates
   read `state.result?.ok`, and `directInputMode` (view-model.ts:2355) separates
   `null` from `{ok:false}` explicitly. Holding it at the live case would leave
   those terms unexercised, so it is swept too. */
const PROJECT_RESULTS = [
  null,
  Object.freeze({
    ok: false as const,
    error: Object.freeze({
      category: "project-view-unavailable" as const,
      message: "Live Project data is unavailable.",
    }),
  }),
  Object.freeze({ ok: true as const, view: visualFixture }),
] as const;

/* Project 1 in the fixture is unselected and available, which is what
   `canSelectProject` requires of a target beyond its state guards. */
const SELECTABLE_TARGET_INDEX = 1;

interface GuardPair {
  readonly name: string;
  readonly can: (state: WorkbenchRendererState) => boolean;
  readonly acts: (state: WorkbenchRendererState) => boolean;
}

const PAIRS: readonly GuardPair[] = Object.freeze([
  {
    name: "canOpenProject / beginOpenProject",
    can: canOpenProject,
    acts: (state) => beginOpenProject(state) !== state,
  },
  {
    name: "canCreateProject / beginCreateProject",
    can: canCreateProject,
    acts: (state) => beginCreateProject(state) !== state,
  },
  {
    name: "canSelectProject / beginProjectSelection",
    can: (state) => canSelectProject(state, SELECTABLE_TARGET_INDEX),
    acts: (state) => {
      const attempt = beginProjectSelection(state, SELECTABLE_TARGET_INDEX);
      return attempt.request !== null && attempt.state !== state;
    },
  },
  {
    name: "canEnterNewAgentSessionMode / enterNewAgentSessionMode",
    can: canEnterNewAgentSessionMode,
    acts: (state) => enterNewAgentSessionMode(state) !== state,
  },
  {
    name: "canCancelNewAgentSessionMode / cancelNewAgentSessionMode",
    can: canCancelNewAgentSessionMode,
    acts: (state) => cancelNewAgentSessionMode(state) !== state,
  },
  {
    name:
      "canUseDirectSessionProfileAsDefault / beginDirectSessionProfileDefaultSave",
    can: canUseDirectSessionProfileAsDefault,
    acts: (state) => {
      const attempt = beginDirectSessionProfileDefaultSave(state);
      return attempt.request !== null && attempt.state !== state;
    },
  },
  {
    name: "canSubmitDirectInput / beginDirectInputSubmission",
    can: canSubmitDirectInput,
    acts: (state) => {
      const attempt = beginDirectInputSubmission(state);
      return attempt.request !== null && attempt.state !== state;
    },
  },
]);

test("every phase union swept by the guard invariant is the one view-model.ts declares", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/renderer/view-model.ts", import.meta.url),
    "utf8",
  );
  const declared = (typeName: string): readonly string[] => {
    const match = source.match(
      new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`, "u"),
    );
    const body = match?.[1];
    assert.ok(
      body !== undefined,
      `view-model.ts no longer declares ${typeName}; the sweep cannot be trusted until this is re-derived`,
    );
    const members = [...body.matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]!);
    assert.ok(
      members.length > 0,
      `${typeName} parsed to zero members, so this guard is comparing nothing`,
    );
    return members;
  };

  assert.deepEqual(declared("WorkbenchComposerPhase"), [...COMPOSER_PHASES]);
  assert.deepEqual(declared("WorkbenchDirectProfilePhase"), [...PROFILE_PHASES]);
  assert.deepEqual(declared("WorkbenchDefaultPreferencePhase"), [
    ...DEFAULT_PREFERENCE_PHASES,
  ]);
  assert.deepEqual(declared("WorkbenchNewSessionPhase"), [
    ...NEW_SESSION_PHASES,
  ]);
  assert.deepEqual(declared("WorkbenchProjectSwitchPhase"), [
    ...PROJECT_SWITCH_PHASES,
  ]);
  assert.deepEqual(declared("WorkbenchProjectOpenPhase"), [
    ...PROJECT_OPEN_PHASES,
  ]);
});

function sweepStates(): readonly WorkbenchRendererState[] {
  const base = fullyPopulatedState();
  const states: WorkbenchRendererState[] = [];
  for (const result of PROJECT_RESULTS) {
    for (const draft of DRAFTS) {
      for (const composer of COMPOSER_PHASES) {
        for (const profile of PROFILE_PHASES) {
          for (const defaultPreference of DEFAULT_PREFERENCE_PHASES) {
            for (const newSession of NEW_SESSION_PHASES) {
              for (const projectSwitch of PROJECT_SWITCH_PHASES) {
                for (const projectOpen of PROJECT_OPEN_PHASES) {
                  states.push(
                    withPhases(base, {
                      result,
                      draft,
                      composer,
                      profile,
                      defaultPreference,
                      newSession,
                      projectSwitch,
                      projectOpen,
                    }),
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  /* Anti-vacuity: the size is stated as arithmetic over the unions rather than
     counted from the loop, so a sweep that silently stopped early cannot pass by
     agreeing with itself. */
  const expected =
    PROJECT_RESULTS.length *
    DRAFTS.length *
    COMPOSER_PHASES.length *
    PROFILE_PHASES.length *
    DEFAULT_PREFERENCE_PHASES.length *
    NEW_SESSION_PHASES.length *
    PROJECT_SWITCH_PHASES.length *
    PROJECT_OPEN_PHASES.length;
  assert.equal(states.length, expected);
  assert.equal(states.length, 40_320);
  return states;
}

function describe(state: WorkbenchRendererState): string {
  return [
    `result=${state.result === null ? "null" : state.result.ok ? "ok" : "failed"}`,
    `draft=${state.composer.draft === "" ? "empty" : "valid"}`,
    `composer=${state.composer.phase}`,
    `profile=${state.profile.phase}`,
    `defaultPreference=${state.profile.defaultPreference.phase}`,
    `newSession=${state.newSession.phase}`,
    `projectSwitch=${state.projectSwitch.phase}`,
    `projectOpen=${state.projectOpen.phase}`,
  ].join(" ");
}

test("every pure canX predicate agrees with its handler across the whole phase product", () => {
  const states = sweepStates();
  const disagreements: string[] = [];

  for (const state of states) {
    for (const pair of PAIRS) {
      const predicted = pair.can(state);
      const observed = pair.acts(state);
      if (predicted === observed) continue;
      disagreements.push(
        `${pair.name}: predicate=${predicted} handler-acted=${observed} at ${describe(state)}`,
      );
    }
  }

  assert.equal(PAIRS.length, 7);
  assert.deepEqual(
    disagreements.slice(0, 20),
    [],
    `${disagreements.length} of ${states.length * PAIRS.length} guard/handler observations disagree. ` +
      "A predicate that says yes while its handler refuses is a control that swallows " +
      "the click (F60, F77, F88, F141, F149); the reverse is a control that claims to " +
      "be shut while its handler would still act.",
  );
});

/* Anti-vacuity for the sweep itself. If the fixture were degenerate — a profile
   that never loads, a view with no selectable Project — every predicate would be
   false in every swept state and the assertion above would pass while proving
   nothing at all. This project has been bitten by exactly that. */
test("the swept fixture reaches states in which each predicate is true and each handler acts", () => {
  const states = sweepStates();
  for (const pair of PAIRS) {
    assert.ok(
      states.some((state) => pair.can(state)),
      `${pair.name}: the predicate is false in all ${states.length} swept states, so ` +
        "the invariant holds vacuously for this pair. Fix the fixture, not the assertion.",
    );
    assert.ok(
      states.some((state) => pair.acts(state)),
      `${pair.name}: the handler never acts in any swept state, so the invariant ` +
        "holds vacuously for this pair.",
    );
    assert.ok(
      states.some((state) => !pair.can(state)),
      `${pair.name}: the predicate is true in every swept state, so the sweep never ` +
        "exercises the refusing half of the invariant.",
    );
  }
});

function fullyPopulatedState(): WorkbenchRendererState {
  const withProject = replaceProjectResult(initialRendererState, {
    ok: true,
    view: visualFixture,
  });
  /* The catalog-default profile load is only accepted while the composer is in
     "start" mode, and with a Project selected and Sessions present the shell is
     in "continue" mode until New Agent Session is entered. Entering it is what
     makes a fully-populated profile reachable at all; the sweep then overrides
     `newSession.phase` across all four of its values regardless. */
  const started = enterNewAgentSessionMode(withProject);
  assert.equal(started.newSession.phase, "active");
  const drafted = updateDirectInputDraft(started, DRAFTS[1]);
  const loaded = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(drafted),
    sweepProfileResult(),
  );
  /* Anti-vacuity for the fixture: every DATA guard the seven handlers consult
     must already be satisfied here, or a disagreement above would mean
     "incomplete fixture" rather than "predicate and handler disagree". */
  assert.equal(loaded.profile.result?.ok, true);
  assert.notEqual(loaded.profile.selectedEndpointKey, null);
  assert.notEqual(loaded.profile.selectedModelKey, null);
  assert.notEqual(loaded.profile.selectedWorkIntensityKey, null);
  assert.notEqual(loaded.profile.selectedExecutionModeKey, null);
  assert.notEqual(loaded.profile.selectedAccessModeKey, null);
  assert.ok(visualFixture.commands.length > 0);
  const target =
    visualFixture.projectSelection.projects[SELECTABLE_TARGET_INDEX];
  assert.equal(target?.selected, false);
  assert.equal(target?.availability, "available");
  return loaded;
}

function withPhases(
  base: WorkbenchRendererState,
  phases: Readonly<{
    result: WorkbenchRendererState["result"];
    draft: string;
    composer: (typeof COMPOSER_PHASES)[number];
    profile: (typeof PROFILE_PHASES)[number];
    defaultPreference: (typeof DEFAULT_PREFERENCE_PHASES)[number];
    newSession: (typeof NEW_SESSION_PHASES)[number];
    projectSwitch: (typeof PROJECT_SWITCH_PHASES)[number];
    projectOpen: (typeof PROJECT_OPEN_PHASES)[number];
  }>,
): WorkbenchRendererState {
  return Object.freeze({
    ...base,
    result: phases.result,
    composer: Object.freeze({
      ...base.composer,
      draft: phases.draft,
      phase: phases.composer,
    }),
    profile: Object.freeze({
      ...base.profile,
      phase: phases.profile,
      defaultPreference: Object.freeze({
        ...base.profile.defaultPreference,
        phase: phases.defaultPreference,
      }),
    }),
    newSession: Object.freeze({
      ...base.newSession,
      phase: phases.newSession,
    }),
    projectSwitch: Object.freeze({
      ...base.projectSwitch,
      phase: phases.projectSwitch,
    }),
    projectOpen: Object.freeze({
      ...base.projectOpen,
      phase: phases.projectOpen,
    }),
  });
}

function sweepProfileResult(): WorkbenchCatalogDefaultPublicProfileResult {
  return {
    ok: true,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "catalog-ready" },
        { endpointId: "claude-code-desktop", category: "catalog-ready" },
      ],
    },
    profile: {
      snapshotKey: "snapshot-guard-sweep",
      endpoints: [
        {
          endpointId: "codex-desktop",
          key: "endpoint-1",
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          models: [
            {
              key: "model-1",
              label: "Sweep model",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [{ key: "intensity-1", label: "default" }],
            },
          ],
          executionModes: [{ key: "execution-1", label: "Single agent" }],
          accessModes: [{ key: "access-1", label: "Full access" }],
        },
      ],
      desiredDefault: {
        kind: "resolved",
        endpointKey: "endpoint-1",
        modelKey: "model-1",
        workIntensityKey: "intensity-1",
        executionModeKey: "execution-1",
        accessModeKey: "access-1",
      },
    },
  };
}
