/* F211. The blocked composer's exit gained a sentence in F207, and the sentence
   was wrong. It said "the Workbench is still settling another action, or no
   Session is selected" — and the most conspicuous thing in flight when that
   panel appears is the Session that just failed, so the owner read it as saying
   a running Session stops him opening another one. He refuted it, and he was
   right: not one of the ten terms `replacementSessionRefusal` evaluates observes
   a turn in flight. The product behaviour was correct; the copy described
   behaviour the product does not have.

   `blocked-composer-exit-invariant.test.ts` is the control next door and cannot
   catch this class: it reads the `disabled` attribute and knows nothing about
   what the panel SAYS. A panel that shuts the exit correctly and then explains
   it with any sentence at all passes it.

   So this file reads the sentence. The load-bearing part is `TERM_HOLDS` below:
   an independent restatement of what each refusal term means, written against
   the state rather than by calling the production decision. A reason string
   shown for a state whose term is not the refusing one turns this red, which is
   exactly the defect F211 was — a true-sounding sentence about an untested
   cause. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";

import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { copyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/composer-copy.ts";
import type { WorkbenchHostedProjectView } from "../../src/workbench-shell/contract.ts";
import {
  hasHostedProjectView,
  initialRendererState,
  replaceProjectResult,
  replacementSessionRefusal,
  replacementSessionRequest,
  selectedCommand,
  type WorkbenchRendererState,
  type WorkbenchReplacementSessionRefusal,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { visualFixture } from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const viewModelUrl = new URL(
  "../../src/workbench-shell/renderer/view-model.ts",
  import.meta.url,
);

type Component = (props: Readonly<Record<string, unknown>>) => unknown;

/* Everything that renders has to come out of the ONE module graph the SSR server
   builds. `locale.ts` holds its active locale in module scope, so the copy of it
   this file imports statically is a different instance from the one the rendered
   components read: switching the locale on that copy changes nothing they can
   see, and the zh-CN half of this file would silently assert against English. */
interface RenderModules {
  readonly stage: Component;
  readonly blockedComposer: Component;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
  readonly dictionaries: typeof copyLocaleDictionaries;
}

const noOp = (): void => undefined;

/* Deliberately NOT `replacementSessionRefusal`. This is a second, independent
   statement of what each term means, so that a production decision which mapped
   a term onto the wrong condition — or reordered two of them — disagrees with
   something other than itself. Every entry answers one question: is the
   condition this sentence describes actually true of this state? */
const TERM_HOLDS: Readonly<
  Record<
    WorkbenchReplacementSessionRefusal,
    (state: WorkbenchRendererState) => boolean
  >
> = Object.freeze({
  "project-view-failed": (state) => !hasHostedProjectView(state.result),
  "project-switch-pending": (state) => state.projectSwitch.phase === "pending",
  "project-open-pending": (state) => state.projectOpen.phase === "pending",
  "project-open-recovery-required": (state) =>
    state.projectOpen.phase === "recovery-required",
  "project-has-no-commands": (state) =>
    hasHostedProjectView(state.result) && state.result.view.commands.length === 0,
  "new-session-already-starting": (state) =>
    state.newSession.phase !== "inactive",
  "message-awaiting-acceptance": (state) => state.composer.phase === "pending",
  "catalog-loading": (state) => state.profile.phase === "loading",
  "default-preference-saving": (state) =>
    state.profile.defaultPreference.phase === "pending",
  "no-selection": (state) => state.selectedKey === null,
  "selection-not-in-project": (state) =>
    hasHostedProjectView(state.result) &&
    state.selectedKey !== null &&
    !state.result.view.commands.some(
      (command) => command.key === state.selectedKey,
    ),
});

const REASONS = Object.freeze(
  Object.keys(TERM_HOLDS) as readonly WorkbenchReplacementSessionRefusal[],
);

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

/* `command-absent` matches no command in the fixture. It is the only way to
   reach `selection-not-in-project` through the Stage: `selectedCommand` falls
   back to the view's initial selection for an unknown key, so the panel still
   renders while the handler's membership term refuses. */
const SELECTIONS = [
  null,
  "command-1",
  "command-2",
  "command-3",
  "command-absent",
] as const;

test("every refusal term the view model can return has a sentence, and no sentence outlives its term", async () => {
  const source = await readFile(viewModelUrl, "utf8");
  const declared = (typeName: string): readonly string[] => {
    const match = source.match(
      new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`, "u"),
    );
    const body = match?.[1];
    assert.ok(body !== undefined, `view-model.ts no longer declares ${typeName}`);
    return [...body.matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]!);
  };

  const union = [
    ...declared("WorkbenchNewAgentSessionRefusal"),
    ...declared("WorkbenchReplacementSessionRefusal"),
  ].sort();
  assert.ok(union.length > 0, "the refusal union parsed to nothing");

  assert.deepEqual(
    [...REASONS].sort(),
    union,
    "this file's independent term table has drifted from the union view-model.ts " +
      "declares. Restate the new term here rather than deleting the check.",
  );

  for (const [locale, dictionary] of Object.entries(copyLocaleDictionaries)) {
    assert.deepEqual(
      Object.keys(dictionary.blockedComposerCopy.exitUnavailableReason).sort(),
      union,
      `${locale} carries a sentence for a term that does not exist, or is missing ` +
        "one for a term that does. The panel would fall through to an empty string.",
    );
  }
});

test("both languages say something, say something different, and neither claims a running Session blocks a new one", () => {
  /* The F211 claim family. None of the ten terms observes a turn in flight, so
     a sentence that mentions one is describing behaviour the product does not
     have — which is the whole of this defect. */
  const untestedCause =
    /running|in.?flight|still settling|another action|busy|正在运行|运行中|其他操作|忙/iu;

  for (const [locale, dictionary] of Object.entries(copyLocaleDictionaries)) {
    const sentences = dictionary.blockedComposerCopy
      .exitUnavailableReason as Readonly<Record<string, string>>;
    const seen = new Map<string, string>();
    for (const [reason, sentence] of Object.entries(sentences)) {
      assert.ok(
        sentence.trim().length > 0,
        `${locale} ${reason} is blank; the panel would shut the exit and say nothing`,
      );
      assert.doesNotMatch(
        sentence,
        untestedCause,
        `${locale} ${reason} names a cause no term of the refusal tests. F211 was ` +
          "exactly this sentence: the predicate never looks at a turn in flight.",
      );
      const duplicate = seen.get(sentence);
      assert.equal(
        duplicate,
        undefined,
        `${locale} says the same thing for ${reason} and ${duplicate}; one of ` +
          "them is describing a state it does not describe",
      );
      seen.set(sentence, reason);
    }
  }

  /* The other half of "no sentence claims a cause the predicate does not test":
     the predicate really does not test it. Read off the decision's own source. */
  assert.ok(REASONS.length > 0, "the term table is empty, so nothing is checked");
});

test("the refusal decision reads no turn activity, so no sentence about one could be true", async () => {
  const source = await readFile(viewModelUrl, "utf8");
  const start = source.indexOf("export function newAgentSessionModeRefusal");
  const end = source.indexOf("export function canEnterNewAgentSessionMode");
  assert.ok(start >= 0 && end > start, "the refusal decision has been renamed");
  const decision = source.slice(start, end);

  assert.doesNotMatch(
    decision,
    /in-?flight|turn|running|steer|interrupt/iu,
    "the refusal now reads something about a turn or Session in flight. If that " +
      "is deliberate the copy has to change with it — F211 was the copy claiming " +
      "this while the predicate did not.",
  );
});

test(
  "the panel names the term that is actually refusing, in both languages",
  { timeout: 180_000 },
  async () => {
    await withModules(async ({ stage, blockedComposer, setLocale, dictionaries }) => {
      /* Half one: the component's own mapping, over every term including the
         ones the Stage cannot reach. Each sentence must render for its term and
         for no other. */
      for (const locale of ["en", "zh-CN"] as const) {
        setLocale(locale);
        const expected = dictionaries[locale].blockedComposerCopy
          .exitUnavailableReason as Readonly<Record<string, string>>;
        for (const reason of REASONS) {
          const html = renderToString(() =>
            blockedComposer({
              command: visualFixture.commands[1],
              newSession: initialRendererState.newSession,
              replacementSessionRefusal: reason,
              onEnterReplacementSession: noOp,
            }),
          );
          assert.equal(
            reasonText(html),
            expected[reason],
            `${locale}: the panel shows the wrong sentence for ${reason}`,
          );
          if (reason === "no-selection") {
            assert.match(
              html,
              new RegExp(dictionaries[locale].composerFeedbackCopy.footRequiresSelection, "u"),
              `${locale}: the no-selection footer must remain visible when there really is no selection`,
            );
          }
        }
        const open = renderToString(() =>
          blockedComposer({
            command: visualFixture.commands[1],
            newSession: initialRendererState.newSession,
            replacementSessionRefusal: null,
            onEnterReplacementSession: noOp,
          }),
        );
        assert.equal(
          reasonText(open),
          null,
          `${locale}: the panel explains a refusal while the exit is open`,
        );
        assert.doesNotMatch(
          open,
          new RegExp(dictionaries[locale].composerFeedbackCopy.footRequiresSelection, "u"),
          `${locale}: an enabled New Agent Session exit must not claim a selection is missing`,
        );
        const freshProfileCopy = dictionaries[locale].composerFeedbackCopy
          .footStartsFreshProfile;
        assert.ok(freshProfileCopy.length > 0);
        assert.match(
          open,
          new RegExp(freshProfileCopy, "u"),
          `${locale}: an enabled exit must say that the new Session gets a fresh profile selection`,
        );
      }
      setLocale("en");

      /* Half two: the wiring, swept. The sentence must belong to the term that
         is refusing in THAT state, and the term must actually hold there. */
      const english = dictionaries.en.blockedComposerCopy
        .exitUnavailableReason as Readonly<Record<string, string>>;
      const byText = new Map(
        Object.entries(english).map(([reason, sentence]) => [sentence, reason]),
      );

      const observed = new Set<string>();
      let rendered = 0;
      let explained = 0;
      let silentAndOpen = 0;
      const wrongTerm: string[] = [];
      const unexplained: string[] = [];
      const explainedButOpen: string[] = [];

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
                    const refusal = replacementSessionRefusal(state);

                    /* The narrowing terms left inside `replacementSessionRequest`
                       are dead only for as long as this holds. */
                    assert.equal(
                      replacementSessionRequest(state) === null,
                      refusal !== null,
                      "the refusal and the request disagree about the same state; " +
                        "a term has been written in one and not the other (F207)",
                    );

                    const html = renderToString(() => stage(stageProps(state)));
                    if (!html.includes("blocked-composer")) continue;
                    rendered += 1;

                    const shown = reasonText(html);
                    const describe =
                      `selected=${selectedKey ?? "none"} composer=${composer} ` +
                      `profile=${profile} defaultPreference=${defaultPreference} ` +
                      `newSession=${newSession} projectSwitch=${projectSwitch} ` +
                      `projectOpen=${projectOpen}`;

                    if (shown === null) {
                      if (refusal === null) silentAndOpen += 1;
                      else if (newSession !== "awaiting-visible") {
                        unexplained.push(`${describe} :: refused by ${refusal}`);
                      }
                      continue;
                    }

                    explained += 1;
                    const named = byText.get(shown);
                    if (named === undefined) {
                      wrongTerm.push(`${describe} :: unknown sentence ${shown}`);
                      continue;
                    }
                    observed.add(named);
                    if (refusal === null) {
                      explainedButOpen.push(`${describe} :: named ${named}`);
                      continue;
                    }
                    if (named !== refusal) {
                      wrongTerm.push(
                        `${describe} :: says ${named}, refused by ${refusal}`,
                      );
                      continue;
                    }
                    if (
                      !TERM_HOLDS[named as WorkbenchReplacementSessionRefusal](
                        state,
                      )
                    ) {
                      wrongTerm.push(
                        `${describe} :: says ${named}, which is not true here`,
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }

      assert.ok(
        rendered > 10_000,
        `the blocked panel rendered in only ${rendered} swept states; the sweep ` +
          "has stopped reaching it and proves nothing",
      );
      assert.ok(
        explained > 0,
        "no swept state explains its refusal, so a panel that never says anything " +
          "would satisfy this file",
      );
      assert.ok(
        silentAndOpen > 0,
        "no swept state leaves the exit open, so 'says nothing when open' holds " +
          "vacuously",
      );

      assert.deepEqual(
        wrongTerm.slice(0, 10),
        [],
        `${wrongTerm.length} of ${explained} explained states name a term that is ` +
          "not the one refusing, or not true of the state at all. That is F211: a " +
          "sentence describing behaviour the product does not have.",
      );
      assert.deepEqual(
        unexplained.slice(0, 10),
        [],
        `${unexplained.length} states shut the only exit and say nothing about why. ` +
          "F211 required the panel to name the reason, not merely to have one.",
      );
      assert.deepEqual(
        explainedButOpen.slice(0, 10),
        [],
        `${explainedButOpen.length} states explain a refusal while the exit is live`,
      );

      /* Which terms the Stage can actually reach, recorded rather than assumed.
         If a refactor stops the sweep reaching one of these, the guard weakens
         silently unless this fails. Five of the eleven are absent for reasons
         that are properties of the Stage, not gaps in the sweep, and the
         component half above covers all eleven regardless:

           project-view-failed        the panel needs a loaded view to render
           project-has-no-commands    an empty Project renders EmptyProjectState
           new-session-already-starting  a non-inactive newSession takes the
                                      fresh-start branch, whose only blocked
                                      presentation is awaiting-visible — and
                                      that one is explained by `waitingBody`
                                      already, so the reason is suppressed
           no-selection               `selectedCommand` falls back to the view's
           selection-not-in-project   initial selection, which in this fixture is
                                      continuable, so an absent or unmatched key
                                      renders the direct composer instead */
      assert.deepEqual(
        [...observed].sort(),
        [
          "catalog-loading",
          "default-preference-saving",
          "message-awaiting-acceptance",
          "project-open-pending",
          "project-open-recovery-required",
          "project-switch-pending",
        ],
        "the set of refusals the Stage sweep reaches has changed",
      );
    });
  },
);

function reasonText(html: string): string | null {
  const match = html.match(
    /<span[^>]*class="bb-blocked-reason"[^>]*>([\s\S]*?)<\/span>/u,
  );
  if (match?.[1] === undefined) return null;
  const text = match[1].replace(/<!--[\s\S]*?-->/gu, "").trim();
  return text.length === 0 ? null : text;
}

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
  const view: WorkbenchHostedProjectView = hasHostedProjectView(state.result)
    ? state.result.view
    : visualFixture;
  return {
    active: true,
    view,
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

async function withModules(
  assertion: (modules: RenderModules) => Promise<void>,
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
    const [stageModule, composerModule, localeModule, copyModule] =
      await Promise.all([
        server.ssrLoadModule("/src/workbench-shell/renderer/stage.tsx"),
        server.ssrLoadModule("/src/workbench-shell/renderer/composer.tsx"),
        server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts"),
        server.ssrLoadModule(
          "/src/workbench-shell/renderer/copy/composer-copy.ts",
        ),
      ]);
    const stage = (stageModule as { WorkbenchStage?: Component }).WorkbenchStage;
    const blockedComposer = (composerModule as { BlockedComposer?: Component })
      .BlockedComposer;
    const setLocale = (
      localeModule as { setLocale?: RenderModules["setLocale"] }
    ).setLocale;
    const dictionaries = (
      copyModule as { copyLocaleDictionaries?: typeof copyLocaleDictionaries }
    ).copyLocaleDictionaries;
    assert.ok(
      typeof stage === "function",
      "stage.tsx no longer exports WorkbenchStage",
    );
    assert.ok(
      typeof blockedComposer === "function",
      "composer.tsx no longer exports BlockedComposer",
    );
    assert.ok(typeof setLocale === "function", "locale.ts no longer exports setLocale");
    assert.ok(
      dictionaries !== undefined,
      "composer-copy.ts no longer exports copyLocaleDictionaries",
    );
    /* Same object identity as the statically imported one would be a lie about
       what this file is testing; assert instead that the two agree, so the
       non-rendering tests above and the rendered ones below check one corpus. */
    assert.deepEqual(
      Object.keys(dictionaries.en.blockedComposerCopy.exitUnavailableReason),
      Object.keys(
        copyLocaleDictionaries.en.blockedComposerCopy.exitUnavailableReason,
      ),
    );
    await assertion({ stage, blockedComposer, setLocale, dictionaries });
  } finally {
    await server.close();
  }
}
