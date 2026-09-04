/* F207. The blocked composer tells the user their selection cannot be continued
   and offers one way out of that state: the New Agent Session button. The button
   decided its own availability from one member of one phase union; the handler
   behind it, `enterReplacementSession`, refused on `canEnterNewAgentSessionMode`
   — eight terms — plus two selection terms of its own. Measured across the
   rendered phase product, the two disagreed in 11,440 of the 12,160 states in
   which the control was offered, and in every one of those the click could not
   change the stage by a character.

   `guard-versus-disabled-invariant.test.ts` is the control that was built to
   catch this class and cannot: it sweeps `predicate(state) === handlerActed(state)`
   over pure `view-model.ts` reducer pairs, and every one of those handlers opens
   with `if (!canX(state)) return state`, so that side is structurally incapable
   of disagreeing. What it locks is the delegation discipline INSIDE the view
   model. All six recorded instances of this class live in the renderer, which it
   never renders.

   So this file renders. It drives the real `WorkbenchStage` — the real branch
   selection in `stage.tsx`, the real `BlockedComposer` in `composer.tsx` — over
   the phase product, and reads the `disabled` attribute off the produced
   document rather than off the props that produced it. Two observations are kept
   separate on purpose, because a combined one cannot tell a still-broken control
   from a correctly shut one:

     OFFERED  the button exists in the blocked panel and carries no `disabled`
     ACTS     `enterReplacementSession` would issue a profile-load request

   The invariant is that those two are the same boolean in every swept state. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";

import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
} from "../../src/workbench-shell/contract.ts";
import {
  canEnterNewAgentSessionMode,
  enterNewAgentSessionMode,
  initialRendererState,
  replaceProjectResult,
  replacementSessionRefusal,
  replacementSessionRequest,
  selectedCommand,
  type WorkbenchRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { visualFixture } from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const viewModelUrl = new URL(
  "../../src/workbench-shell/renderer/view-model.ts",
  import.meta.url,
);
const mountUrl = new URL(
  "../../src/workbench-shell/renderer/mount.tsx",
  import.meta.url,
);

type StageComponent = (props: Readonly<Record<string, unknown>>) => unknown;

const noOp = (): void => undefined;

/* The phase lists are DERIVED from view-model.ts below and checked against
   these, so a union that gains a member turns this file red rather than quietly
   shrinking the sweep to a sample. */
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

/* The selection axis, and it is what keeps the live half of this invariant from
   being vacuous. `command-1` is resumable and completed, so `directInputMode`
   answers "continue" and the blocked panel is then reachable only through a
   blocking phase — and every blocking phase is ALSO a handler-refusal term, so a
   sweep holding the selection there would never once see the button legitimately
   live, and "nail the button shut" would pass it. `command-2` (failed, no
   session) and `command-3` (recovery-required, not resumable) reach the panel
   through the trailing selected-command test in `directInputMode`, which is not
   a term of the handler: those are the states in which the exit must stay open.
   `null` exercises the handler's own `selectedKey === null` refusal, which is
   invisible to the Stage — see the proxy note in `BlockedComposer`. */
const SELECTIONS = [null, "command-1", "command-2", "command-3"] as const;

interface Observation {
  readonly describe: string;
  readonly offered: boolean;
  readonly acts: boolean;
}

test("every phase union swept by the blocked-composer exit invariant is the one view-model.ts declares", async () => {
  const source = await readFile(viewModelUrl, "utf8");
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

/* The fixture commands this sweep leans on. If the visual fixture is ever
   reshaped so that these are no longer the three shapes named above, the live
   half of the invariant would go quietly vacuous, so it is asserted rather than
   assumed. */
test("the visual fixture still holds the continuable and non-continuable Sessions the sweep needs", () => {
  const byKey = (key: string): WorkbenchCommandView => {
    const command = visualFixture.commands.find((entry) => entry.key === key);
    assert.ok(command !== undefined, `the fixture no longer holds ${key}`);
    return command;
  };
  const continuable = byKey("command-1");
  assert.equal(continuable.status, "completed");
  assert.equal(continuable.session?.resumable, true);
  assert.equal(continuable.session?.archived, false);
  assert.notEqual(continuable.session?.selectionKey, null);

  assert.equal(byKey("command-2").status, "failed");
  assert.equal(byKey("command-2").session, undefined);

  assert.equal(byKey("command-3").status, "recovery-required");
  assert.equal(byKey("command-3").session?.resumable, false);
});

test(
  "the blocked composer never offers an exit its handler would refuse, and never withholds one it would take",
  { timeout: 120_000 },
  async () => {
    await withStage(async (WorkbenchStage) => {
      const observations: Observation[] = [];

      for (const selectedKey of SELECTIONS) {
        const base = baseState(selectedKey);
        for (const composer of COMPOSER_PHASES) {
          for (const profile of PROFILE_PHASES) {
            for (const defaultPreference of DEFAULT_PREFERENCE_PHASES) {
              for (const newSession of NEW_SESSION_PHASES) {
                for (const projectSwitch of PROJECT_SWITCH_PHASES) {
                  for (const projectOpen of PROJECT_OPEN_PHASES) {
                    const state = withPhases(base, {
                      composer,
                      profile,
                      defaultPreference,
                      newSession,
                      projectSwitch,
                      projectOpen,
                    });

                    /* ACTS, decided first and without looking at any markup. */
                    const request = replacementSessionRequest(state);

                    /* OFFERED, read off the produced document. The Stage is
                       given the same decision the shell gives it in the product
                       (mount.tsx:1431), and nothing else about it. */
                    const html = renderToString(() =>
                      WorkbenchStage(stageProps(state)),
                    );
                    const button = observeExitButton(html);
                    if (!button.present) continue;

                    observations.push({
                      describe:
                        `selected=${selectedKey ?? "none"} ` +
                        `composer=${composer} profile=${profile} ` +
                        `defaultPreference=${defaultPreference} ` +
                        `newSession=${newSession} ` +
                        `projectSwitch=${projectSwitch} ` +
                        `projectOpen=${projectOpen}`,
                      offered: !button.disabled,
                      acts: request !== null,
                    });
                  }
                }
              }
            }
          }
        }
      }

      const falseOffers = observations.filter((o) => o.offered && !o.acts);
      const falseRefusals = observations.filter((o) => !o.offered && o.acts);
      const liveOffers = observations.filter((o) => o.offered && o.acts);
      const honestRefusals = observations.filter((o) => !o.offered && !o.acts);

      /* Anti-vacuity before the invariant, so that a sweep which renders nothing
         — or which renders only one side of the control — cannot pass by
         agreeing with itself. */
      assert.ok(
        observations.length > 10_000,
        `the blocked composer rendered in only ${observations.length} swept states; ` +
          "the sweep has stopped reaching the panel and proves nothing",
      );
      assert.ok(
        liveOffers.length > 0,
        "the exit is never live in any swept state, so this invariant would be " +
          "satisfied by a button nailed permanently shut. Fix the fixture, not " +
          "the assertion.",
      );
      assert.ok(
        honestRefusals.length > 0,
        "the exit is never shut in any swept state, so the refusing half of the " +
          "invariant is never exercised.",
      );

      assert.deepEqual(
        falseOffers.slice(0, 10).map((o) => o.describe),
        [],
        `${falseOffers.length} of ${observations.length} rendered states offer the ` +
          "blocked composer's only exit while `enterReplacementSession` would refuse " +
          "it. The user is told the Session cannot continue, handed the one way out, " +
          "and the click changes nothing — no spinner, no notice, no dialog (F207).",
      );
      assert.deepEqual(
        falseRefusals.slice(0, 10).map((o) => o.describe),
        [],
        `${falseRefusals.length} of ${observations.length} rendered states disable the ` +
          "blocked composer's only exit while the handler would have taken it. A " +
          "control that lies about being shut strands the user just as effectively.",
      );
    });
  },
);

/* The invariant above sees the control and the decision. It cannot see the wire
   between them: it hands the Stage a decision itself, so a shell that computed a
   DIFFERENT one would still pass it. These two assertions cover that wire, and
   they are deliberately narrow — they read the shape of two lines, and they know
   nothing about whether those lines are correct. */
test("the shell decides the blocked composer's exit once, from the state its handler reads", async () => {
  const source = await readFile(mountUrl, "utf8");

  assert.match(
    source,
    /replacementSessionRefusal=\{replacementSessionRefusal\(state\(\)\)\}/u,
    "the Stage must be given the decision computed from the shell's own state. " +
      "The Stage cannot compute it: with no selection its view of the state " +
      "reports the view's initial command as selected while `selectedKey` is " +
      "still null, which is one of the states the handler refuses in.",
  );

  const handlerStart = source.indexOf("  const enterReplacementSession");
  assert.ok(handlerStart >= 0, "enterReplacementSession has been renamed");
  const handlerSource = source.slice(handlerStart, handlerStart + 600);
  assert.match(
    handlerSource,
    /const request = replacementSessionRequest\(current\);\s*if \(request === null\) return;/u,
    "the handler must refuse through the same function the control is disabled " +
      "by. Any condition written out again here is a second decision, and a " +
      "second decision is what F207 was.",
  );
  assert.doesNotMatch(
    handlerSource.slice(0, handlerSource.indexOf("runDirectSessionProfileLoad")),
    /canEnterNewAgentSessionMode|selectedKey === null/u,
    "the handler has regrown a refusal term of its own",
  );
});

/* One further coherence check, on the handler rather than the control: the two
   halves of what a click does must agree. The request is dispatched to the main
   process while the transition is applied to the renderer, and nothing today
   forces those to be gated by the same condition. A state that issued the
   profile load while leaving the stage frozen would be F207 again, one layer
   down, and the user-visible symptom would be identical. */
test("a click that issues a replacement profile load always moves the stage with it", () => {
  let issued = 0;
  for (const selectedKey of SELECTIONS) {
    const base = baseState(selectedKey);
    for (const newSession of NEW_SESSION_PHASES) {
      for (const projectSwitch of PROJECT_SWITCH_PHASES) {
        for (const projectOpen of PROJECT_OPEN_PHASES) {
          for (const composer of COMPOSER_PHASES) {
            const state = withPhases(base, {
              composer,
              profile: "ready",
              defaultPreference: "idle",
              newSession,
              projectSwitch,
              projectOpen,
            });
            if (replacementSessionRequest(state) === null) continue;
            issued += 1;
            assert.notEqual(
              enterNewAgentSessionMode(state),
              state,
              `a replacement profile load is issued at ${newSession}/${projectSwitch}/` +
                `${projectOpen} while the renderer transition refuses, leaving the ` +
                "load running against a stage that never changed",
            );
            assert.equal(canEnterNewAgentSessionMode(state), true);
          }
        }
      }
    }
  }
  assert.ok(issued > 0, "no swept state issues a request, so this holds vacuously");
});

function baseState(selectedKey: string | null): WorkbenchRendererState {
  const withProject = replaceProjectResult(initialRendererState, {
    ok: true,
    view: visualFixture,
  });
  return Object.freeze({ ...withProject, selectedKey });
}

function withPhases(
  base: WorkbenchRendererState,
  phases: Readonly<{
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
    composer: Object.freeze({ ...base.composer, phase: phases.composer }),
    profile: Object.freeze({
      ...base.profile,
      phase: phases.profile,
      defaultPreference: Object.freeze({
        ...base.profile.defaultPreference,
        phase: phases.defaultPreference,
      }),
    }),
    newSession: Object.freeze({ ...base.newSession, phase: phases.newSession }),
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

function stageProps(
  state: WorkbenchRendererState,
): Readonly<Record<string, unknown>> {
  const view: WorkbenchHostedProjectView = state.result?.ok
    ? state.result.view
    : visualFixture;
  return {
    active: true,
    view,
    /* mount.tsx:1192 derives this with `selectedCommand`, which falls back to
       the view's initial selection when the key matches nothing. A plain `find`
       is a different function and would render a different panel. */
    selected: selectedCommand(view, state.selectedKey),
    composer: state.composer,
    profile: state.profile,
    newSession: state.newSession,
    projectSwitch: state.projectSwitch,
    projectOpen: state.projectOpen,
    runtimeUnavailable: false,
    inspectorCollapsed: true,
    onShowInspector: noOp,
    canCreateProject: () => false,
    onCreateProject: noOp,
    canOpenProject: () => false,
    onOpenProject: noOp,
    onDraft: noOp,
    onNavigateComposerHistory: () => null,
    onLoadProfile: noOp,
    onOpenProviders: noOp,
    onEnterNewSession: noOp,
    replacementSessionRefusal: replacementSessionRefusal(state),
    onEnterReplacementSession: noOp,
    onCancelNewSession: noOp,
    onEndpoint: noOp,
    onModel: noOp,
    onWorkIntensity: noOp,
    onExecutionMode: noOp,
    onAccessMode: noOp,
    onUseAsDefault: noOp,
    interruptPending: false,
    interruptFeedback: null,
    onInterrupt: undefined,
    steerPending: false,
    steerFeedback: null,
    onSteer: undefined,
    onSubmit: noOp,
  };
}

/* Scoped to the blocked panel on purpose. `new-session-button` is also worn by a
   ghost control inside `DirectInputComposer` and by a Project rail action;
   matching the class document-wide measures whichever renders first, which
   during this sweep is frequently not this control at all. */
function observeExitButton(
  html: string,
): Readonly<{ present: boolean; disabled: boolean }> {
  const panel = html.indexOf("blocked-composer");
  if (panel < 0) return Object.freeze({ present: false, disabled: false });
  const match = html
    .slice(panel)
    .match(/<button[^>]*new-session-button[^>]*>/u);
  if (match === null) return Object.freeze({ present: false, disabled: false });
  return Object.freeze({
    present: true,
    disabled: /\bdisabled\b/u.test(match[0]),
  });
}

async function withStage(
  assertion: (stage: StageComponent) => Promise<void>,
): Promise<void> {
  const server: ViteDevServer = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/stage.tsx",
    );
    const stage = (module as { WorkbenchStage?: StageComponent }).WorkbenchStage;
    assert.ok(
      typeof stage === "function",
      "stage.tsx no longer exports WorkbenchStage",
    );
    await assertion(stage);
  } finally {
    await server.close();
  }
}
