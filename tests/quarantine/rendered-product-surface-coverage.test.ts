/*
 * F123: breadth coverage for owner-visible renderer states.
 *
 * F118 proves the default Project and Settings surfaces deeply. This file asks
 * the orthogonal question: do the renderer's alternate Project states still
 * resolve visible computed ink and leave glyph pixels in Chromium? Every
 * request uses the existing visual fixture and measureSurface's isolated,
 * seeded --user-data-dir. No Agent Runtime or owner profile is opened.
 *
 * The light variant is reached through the product's real Appearance control,
 * then returned to the Project before capture. Settings itself is deliberately
 * not an asserted surface here: that concurrent lane belongs to F177.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, type TestContext } from "node:test";

import {
  judgeText,
  parseResolvedColor,
  type TextVerdict,
} from "../harness/rendered-surface/contrast.ts";
import {
  MEASUREMENT_VIEWPORT,
  measureSurface,
  startSurfaceServer,
  type MeasuredSurface,
  type MeasuredText,
  type SurfaceRequest,
  type SurfaceStep,
} from "../harness/rendered-surface/measure.ts";

type TextTarget = Readonly<{
  signature?: string;
  text: string;
}>;

type ProjectSurface = Readonly<{
  key: string;
  query: string;
  readySelector: string;
  steps?: readonly SurfaceStep[];
  settleMs?: number;
  targets: readonly TextTarget[];
}>;

const PROJECT_SURFACES: readonly ProjectSurface[] = Object.freeze([
  {
    key: "empty-project",
    query: "?project=empty",
    readySelector: ".empty-project-card",
    targets: [
      { signature: "h1", text: "Start the first Agent Session" },
      { signature: "span.sg-text", text: "Explain how this Project is laid out" },
      { signature: "p.inspector-empty-copy", text: "No Session selected." },
    ],
  },
  {
    key: "code-copy-idle",
    query: "?scenario=code-copy",
    readySelector: ".codeblock-copy",
    targets: [
      { signature: "span", text: "Copy" },
      { signature: "code", text: 'const greeting = "hello";' },
    ],
  },
  {
    key: "code-copy-copied",
    query: "?scenario=code-copy",
    readySelector: ".codeblock-copy",
    steps: [{ click: ".codeblock-copy" }],
    targets: [
      { signature: "span", text: "Copied" },
      { signature: "code", text: 'const greeting = "hello";' },
    ],
  },
  {
    key: "expanded-event-log",
    query: "?project=default",
    readySelector: ".disclosure",
    steps: [
      {
        click: ".disclosure",
        settleSelector: ".event-log:not([hidden])",
      },
    ],
    targets: [
      { signature: "span.ev-kind", text: "session-started" },
      { signature: "span.ev-kind", text: "turn-completed" },
    ],
  },
  {
    key: "failed-command-blocked",
    query: "?scenario=terminal",
    readySelector: ".blocked-composer",
    targets: [
      { signature: "h3", text: "Failed" },
      { signature: "b", text: "This Session can't be continued" },
      { signature: "dd.tone-failed", text: "Failed" },
    ],
  },
  {
    key: "recovery-required-blocked",
    query: "?project=default",
    readySelector: ".composer",
    steps: [
      {
        click: '.session-row[aria-label^="Agent Session 03,"]',
        settleSelector: ".recovery-block",
      },
    ],
    targets: [
      { signature: "h3", text: "Recovery required" },
      { signature: "span.rule-label", text: "Outcome unknown" },
      { signature: "b", text: "Outcome unknown" },
    ],
  },
  {
    key: "active-turn-interrupt",
    query: "?scenario=interrupt",
    readySelector: ".stop-button",
    targets: [
      { signature: "button.send.stop-button", text: "Stop" },
      { signature: "p.control-note", text: "Stop this running turn" },
      { signature: "dd.tone-in-flight", text: "Running" },
    ],
  },
  {
    key: "interrupted-turn",
    query: "?scenario=interrupt",
    readySelector: ".stop-button",
    steps: [
      {
        click: ".stop-button",
        settleSelector: ".interruption-block",
      },
    ],
    targets: [
      { signature: "h3", text: "The turn was interrupted" },
      { signature: "span.rule-label", text: "Turn interrupted" },
      { signature: "dd.tone-interrupted", text: "Interrupted" },
    ],
  },
  {
    key: "new-session-mode",
    query: "?scenario=draft-blocked",
    readySelector: ".composer",
    steps: [
      {
        click: ".new-session-button.rail-action",
        settleSelector: ".fresh-start-state",
      },
    ],
    targets: [
      { signature: "h1", text: "New Agent Session" },
      { signature: "p", text: "Start with a fresh conversation." },
      { signature: "span.chip-val", text: "Choose endpoint" },
    ],
  },
  {
    key: "endpoint-picker",
    query: "?project=empty",
    readySelector: ".empty-project-card",
    steps: [
      {
        click: "#direct-runtime-endpoint",
        settleSelector: ".popover-endpoint .opt-endpoint:not(.is-disabled)",
      },
    ],
    targets: [
      { signature: "div.picker-col-head", text: "Endpoint" },
      { signature: "span.opt-label.rt-codex", text: "Codex" },
      { signature: "span.opt-label.rt-claude", text: "Claude" },
    ],
  },
  {
    key: "model-picker",
    query: "?project=empty",
    readySelector: ".empty-project-card",
    steps: [
      {
        click: "#direct-runtime-endpoint",
        settleSelector: ".popover-endpoint .opt-endpoint:not(.is-disabled)",
      },
      { click: "#direct-model", settleSelector: ".popover-model" },
    ],
    targets: [
      { signature: "div.picker-col-head", text: "Model" },
      { signature: "span.opt-label.rt-codex", text: "gpt-5.6-sol" },
      { signature: "p.picker-note", text: "public catalog labels" },
    ],
  },
  {
    key: "work-intensity-picker",
    query: "?project=empty",
    readySelector: ".empty-project-card",
    steps: [
      {
        click: "#direct-runtime-endpoint",
        settleSelector: ".popover-endpoint .opt-endpoint:not(.is-disabled)",
      },
      {
        click: "#direct-work-intensity",
        settleSelector: ".popover-intensity",
      },
    ],
    targets: [
      { signature: "span.islider-current", text: "ultra" },
      { signature: "span.pos", text: "6 / 6" },
      { signature: "p.picker-note", text: "runtime supplied no control label" },
    ],
  },
  {
    key: "profile-loading",
    query: "?project=empty&profile=loading",
    readySelector: ".empty-project-card",
    steps: [
      {
        click: "#direct-runtime-endpoint",
        settleSelector: ".profile-loading",
      },
    ],
    targets: [
      { signature: "span.working", text: "Reading endpoint catalogs…" },
      { signature: "span", text: "Each runtime is inspected in its own boundary." },
    ],
  },
  {
    key: "profile-unavailable",
    query: "?project=empty&profile=unavailable",
    readySelector: ".empty-project-card",
    steps: [
      {
        click: "#direct-runtime-endpoint",
        settleSelector: ".control-note.is-error",
      },
    ],
    targets: [
      { signature: "p.picker-note", text: "Only endpoints with a Catalog ready status can be selected." },
      { signature: "span.endpoint-status-label", text: "Inspection failed" },
    ],
  },
  {
    key: "profile-without-default",
    query: "?project=empty&profile=no-default",
    readySelector: ".empty-project-card",
    steps: [
      {
        click: "#direct-runtime-endpoint",
        settleSelector: ".popover-endpoint .opt-endpoint:not(.is-disabled)",
      },
    ],
    targets: [
      { signature: "p.picker-note", text: "Only endpoints with a Catalog ready status can be selected." },
      { signature: "div.picker-col-head", text: "Endpoint" },
    ],
  },
  {
    key: "runtime-not-located",
    query: "?scenario=runtime-not-located",
    readySelector: ".runtime-not-located-state",
    targets: [
      { signature: "h1", text: "No Agent Runtime is available" },
      { signature: "span.chip-val", text: "No endpoint available" },
      { signature: "p.runtime-boundary-copy", text: "Sign-in happens in each provider's own app." },
    ],
  },
  {
    key: "archived-session-list",
    query: "?scenario=session-metadata",
    readySelector: ".archived-disclosure",
    steps: [
      {
        click: ".archived-disclosure",
        settleSelector: ".archived-session-list",
      },
    ],
    targets: [
      { signature: "button.archived-disclosure", text: "Archived (1)" },
      { signature: "span.sr-title", text: "归档-" },
    ],
  },
  {
    key: "archived-session-blocked",
    query: "?scenario=session-metadata",
    readySelector: ".archived-disclosure",
    steps: [
      {
        click: ".archived-disclosure",
        settleSelector: ".archived-session-list",
      },
      {
        click: '.session-row[aria-label*="archived"]',
        settleSelector: ".blocked-composer",
      },
    ],
    targets: [
      { signature: "b", text: "Archived Agent Session" },
      { signature: "span", text: "Restore it from Archived" },
    ],
  },
  {
    key: "submission-pending",
    query: "?scenario=draft-blocked&submission=pending",
    readySelector: ".submit-button",
    steps: [{ click: ".submit-button" }],
    targets: [
      { signature: "button.send.submit-button", text: "Accepting…" },
      { signature: "span", text: "Waiting for durable acceptance…" },
    ],
  },
  {
    key: "submission-error",
    query: "?scenario=draft-blocked&submission=error",
    readySelector: ".submit-button",
    steps: [{ click: ".submit-button" }],
    targets: [
      { signature: "button.send.submit-button", text: "Send" },
      { signature: "span", text: "Direct input could not be durably accepted." },
    ],
  },
  {
    key: "unavailable-registered-project",
    query: "?scenario=unavailable",
    readySelector: ".empty-project-card",
    targets: [
      { signature: "span.pm-name", text: "Archive Notes" },
      { signature: "h1", text: "Start the first Agent Session" },
      { signature: "p", text: "No Agent Sessions in this Project yet. The first message starts one." },
    ],
  },
]);

const toneGroup = '[aria-labelledby="appearance-tone-label"]';
const crtGroup = '[aria-labelledby="appearance-crt-label"]';

function requestFor(
  surface: ProjectSurface,
  tone: "dark" | "light",
): SurfaceRequest {
  if (tone === "dark") {
    return {
      surfaceId: `f123-${surface.key}-dark`,
      query: surface.query,
      readySelector: surface.readySelector,
      steps: surface.steps,
      settleMs: surface.settleMs,
      readyTimeoutMs: 30_000,
    };
  }
  return {
    surfaceId: `f123-${surface.key}-light`,
    query: surface.query,
    readySelector: surface.readySelector,
    readyTimeoutMs: 30_000,
    steps: [
      {
        click: "button.settings-rail-button",
        settleSelector: ".settings",
      },
      {
        click: "button.appearance-option",
        within: crtGroup,
        text: "Off",
      },
      {
        click: "button.appearance-option",
        within: toneGroup,
        text: "Light",
      },
      {
        click: "button.settings-rail-button",
        settleSelector: surface.readySelector,
      },
      ...(surface.steps ?? []),
    ],
    settleMs: surface.settleMs,
  };
}

type MeasurementOutcome =
  | Readonly<{ ok: true; surface: MeasuredSurface }>
  | Readonly<{ ok: false; message: string }>;

type BreadthInventorySeal = Readonly<{
  count: number;
  sha256: string;
}>;

type BreadthContrastShortfall = Readonly<{
  surfaceId: string;
  signature: string;
  text: string;
  ratio: number;
  threshold: number;
  analyticRatio: number;
  paintedRatio: number | null;
}>;

type ExpectedBreadthShortfall = Readonly<{
  surfaceId: string;
  signature: string;
  text: string;
  measuredRatio: number;
  threshold: number;
  reason: string;
}>;

const BASELINE_SINGLE_TONE_TARGETS: Readonly<Record<string, readonly TextTarget[]>> =
  Object.freeze({
    "f123-archived-session-list-light": Object.freeze([
      { signature: "span.st.st-failed", text: "✕" },
    ]),
  });

/*
 * The denominator is deliberately frozen. Recomputing it dynamically would
 * let a hidden or deleted string shrink the universe while coverage continued
 * to report 100%. Each digest seals the sorted surfaceId/signature/text keys;
 * any addition, removal, rename, or substitution requires an explicit census
 * update instead of silently moving the denominator.
 * Automatic continuation adds one help node on 13 states in both tones (26
 * sites); all prior sites remain. Its English and Chinese content is exercised
 * by auto-continue-composer-entry.test.ts; this inventory measures English.
 */
const FROZEN_BREADTH_INVENTORY: Readonly<Record<string, BreadthInventorySeal>> =
  Object.freeze({
    /* 2026-09-08 causal re-seal: beadc5c intentionally moved the two
       collapsed-Project notes from painted .proj-empty rows to each Project
       toggle's title so collapsed Projects pack tightly. Reverting that commit
       restores div.proj-empty (available copy) and div.proj-empty#2
       (unavailable copy) on every surface; restoring it removes both again.
       cdecbf5 also intentionally replaced three rendered "Unknown" profile
       values with "Pending observation" on the active-turn surfaces and "Not
       observed" on the interrupted-turn surfaces, changing those four hashes
       without changing their counts. */
    /* 2026-09-11 causal re-seal: w246 replaced the titlebar's text "U"
       mark with the owner's non-text SVG SIN mark. Every covered surface
       therefore loses exactly one rendered text site; the measured
       shortfall inventory remains empty. */
    "f123-empty-project-dark": { count: 69, sha256: "40f676a71e71f56338c986b5104c295ab0835952892dcff0b1dfbaa260f90b3b" },
    "f123-empty-project-light": { count: 73, sha256: "01564ec3a7908ecce842d3209c96fd9bc871e0d764026e196017ee097ae61c33" },
    "f123-code-copy-idle-dark": { count: 111, sha256: "2127aa9745f031d41c188d4f4890a24a41ffcd7d53cd1a6071e2f1a22c8fe3e0" },
    "f123-code-copy-idle-light": { count: 111, sha256: "54650f5c4ad629fa43d5f3225c22718494bc635cf27a40adf46f0945e6b86b7a" },
    "f123-code-copy-copied-dark": { count: 111, sha256: "1383d58b722232114c69eba114f0b9528f9f0d5d6ee47df253bb1d48e51f8b5b" },
    "f123-code-copy-copied-light": { count: 111, sha256: "6024e5b8835419ef2097aabba699cb58e9bae9b8dcff066c8502d7454e9d0dba" },
    "f123-expanded-event-log-dark": { count: 124, sha256: "31e4ab1d75a5fff849e84ff5176841ae1d6f915ba0bc0c3823ecd63b934de628" },
    "f123-expanded-event-log-light": { count: 124, sha256: "5b8a36e3b38b2cc0fd4d4f3468574c131423140f088969bd3042529810348897" },
    /* A selected blocked Session names its fresh-profile exit instead of falsely
       claiming the current selection is missing; measured site counts stay fixed. */
    "f123-failed-command-blocked-dark": { count: 79, sha256: "ae3dc2a59012b1e200c2fe5cc8ab197419345334f692c7fc090732f80272fe8a" },
    "f123-failed-command-blocked-light": { count: 82, sha256: "7ea4999d842bf1b326cea56583c213771b698059e03afeef8a9a3bf224218915" },
    "f123-recovery-required-blocked-dark": { count: 89, sha256: "574b9dc981612d6f8d7d2b1516448c556692722a8009d6e4832ccd8707c8583e" },
    "f123-recovery-required-blocked-light": { count: 89, sha256: "c5112633e75cd4d102f36f61916bd23a9fb4138e1136833a066abdd590ce2ee2" },
    "f123-active-turn-interrupt-dark": { count: 117, sha256: "5261d1302b2a0035fc7cd0ac865705526ec58b2801c6963954778fbae27a1483" },
    "f123-active-turn-interrupt-light": { count: 117, sha256: "08cf126dfdd52d1b2f941e754d38a84c84b04b38965bb19b17ac993366ef32da" },
    "f123-interrupted-turn-dark": { count: 110, sha256: "88c7712be55732dfe2a01db8e5d98d26ee1394263233264cbd775bc0e8229f03" },
    "f123-interrupted-turn-light": { count: 110, sha256: "777667f1b4852e47d5c8c3a619ddc06685cb6a1df31683231d8933894c9c28c4" },
    "f123-new-session-mode-dark": { count: 60, sha256: "c04697a0b0ccc724764ec917f30dc6ee019c669af5acf4a5a5d8a0cfc8769cc4" },
    "f123-new-session-mode-light": { count: 60, sha256: "43ad9ce183d75d968ddff3ca1ec6966a7725a29ada6b19cf93f84f3b9a5f161f" },
    /* Ticket 25 census re-seal (worker 20): the family facades renamed the
       desktop segment labels ("Codex desktop"/"Claude Code desktop" became
       "Subscription") and the hidden family backends left the picker,
       statusbar and runtime-not-located surfaces, so every surface carrying
       endpoint secondary text re-seals from the post-facade measurement.
       Counts are unchanged everywhere: no text site left the census, the
       substitutions are the renamed segment labels and the merged rows. */
    "f123-endpoint-picker-dark": { count: 76, sha256: "ce0ea6537c1a38650b341bf57eb90dec385de39c88937573dfe0541a571b314f" },
    "f123-endpoint-picker-light": { count: 76, sha256: "02eec1aa787c39b323650d7d713083b382b094d18d55adcccd0eb5263c4e5ac8" },
    "f123-model-picker-dark": { count: 76, sha256: "3e5a686475a675ec96d2235fcee9133a9f2f6a2c27d58933b0aab9c270ee6baa" },
    "f123-model-picker-light": { count: 76, sha256: "8cbc106bc330dd4bdebe55d1eec4971493e341446df7d7cf57a599cc932721e8" },
    "f123-work-intensity-picker-dark": { count: 83, sha256: "95f625f8781b5cd16588b984a6d459519d62bd2f58db9c09695d6de62fd22c76" },
    "f123-work-intensity-picker-light": { count: 83, sha256: "c69e27e70520734a7f425e18857ceec8fbba094ae8252b97dfa9c031248003f4" },
    "f123-profile-loading-dark": { count: 71, sha256: "a7ee40e541b07ce38d5870a99320c3841c10195717a98d2eb6ca452567d124f9" },
    "f123-profile-loading-light": { count: 71, sha256: "61a698ddd0dd67feb3033e1975149786a54c17deed5e9c915737ea3229012650" },
    "f123-profile-unavailable-dark": { count: 72, sha256: "8fea3cb1ab83d9777ab98a286332c3b8b53361e255272ac4024a685e1a63d338" },
    "f123-profile-unavailable-light": { count: 72, sha256: "ed81f54e74bc73f9112cdc661e66ce04c5edf2df0abc98de2a3ddf52d753dc52" },
    "f123-profile-without-default-dark": { count: 73, sha256: "04a5afb277492b91fdaa71ec47c500bd8a9fd9ecd9b94352fbf1104e82c95625" },
    "f123-profile-without-default-light": { count: 73, sha256: "2934df5b31f3f755fd95c85bab49d2ad75cb04226df4a1a37b36f20ab8c59db8" },
    /* main-resync census re-seal (worker 19): both lines of descent edited the
       runtime-not-located surface independently -- the lane's WO23 reworded the
       runtimeBoundary sentence ("never asks for a password, API key, or token"
       became "never asks for or stores subscription credentials; a provider
       API key saved in Settings is encrypted with your OS user account."),
       and main's worker 477 replaced "No lookup path is exposed." with "Not
       found under any name that was checked." (issue #2). The merged tree
       carries BOTH sentences, so neither sealed hash was valid any more;
       re-sealed from the post-merge rendered-surface measurement. */
    "f123-runtime-not-located-dark": { count: 52, sha256: "f936854dfca1873c38d1688c2d2975ebbd1181b6de0d460662c0eb45e3e9b20c" },
    "f123-runtime-not-located-light": { count: 52, sha256: "a77bb4c834798ae7951db5c4277c04a111e8749ad4e4b118096e3347519b01ca" },
    "f123-archived-session-list-dark": { count: 111, sha256: "835a54b62b0d150fed7481eb09a306b232a136fafb60a9914e98eff9d4936e3f" },
    "f123-archived-session-list-light": { count: 111, sha256: "0bcdcb91fc91f3b17c2e94d046138304612fbfab1b1f3e964e096a2d4dc00b73" },
    /* The archived blocked surface carries the same selected-Session footer. */
    "f123-archived-session-blocked-dark": { count: 96, sha256: "10c62a0f26d8b9bdb535da9a0cc980393972db27968844bd6c2bc3d47939cbd1" },
    "f123-archived-session-blocked-light": { count: 96, sha256: "9f0026181b874d123685fcd0ff1e431666694954f9eff086c4e4439218a800fb" },
    "f123-submission-pending-dark": { count: 112, sha256: "4c0889562e4c6e282c233feb95905f73f05af86b694b8dafad7dc120d219a430" },
    "f123-submission-pending-light": { count: 112, sha256: "f383850e6722b57c9f7087dec85984709c9d134e83034d975dd50a0d545a0a80" },
    "f123-submission-error-dark": { count: 112, sha256: "2ad10ff5784fbabffba2dd669826aae33fdcd96689514d0a6807f314e169fc6b" },
    "f123-submission-error-light": { count: 112, sha256: "70a16cfc86988a84c60a72e649f641a2e16303721421be6b539905363838c6b7" },
    "f123-unavailable-registered-project-dark": { count: 57, sha256: "de14d35bca220c7acbc7e26dc7f04e7b8c523bf6f5ab3ef3c5921d37fa4b78a4" },
    "f123-unavailable-registered-project-light": { count: 57, sha256: "0d968a76a7b9250fb982c0a09c4f77a5b1589316e0e1b27476cb0274fa2485da" },
  });

/*
 * Widening is allowed to discover product defects, not to erase them. This is
 * an exact ratchet: a new failure, deterioration > 0.05, a changed threshold,
 * or an entry that has since passed all fails the suite. Keep only active,
 * owner-reserved shortfalls here; the current rendered inventory has none.
 */
const EXPECTED_BREADTH_SHORTFALLS: readonly ExpectedBreadthShortfall[] = Object.freeze([]);

const REQUESTS = Object.freeze(
  PROJECT_SURFACES.flatMap((surface) =>
    (["dark", "light"] as const).map((tone) => ({
      definition: surface,
      tone,
      request: requestFor(surface, tone),
    })),
  ),
);

let sweep: Promise<ReadonlyMap<string, MeasurementOutcome>> | undefined;
let sweepElapsedMs: number | undefined;
let breadthAudit: Promise<BreadthAudit> | undefined;

/* Every per-surface test awaits the same sweep, so whichever runs first carries the whole
   cost: one Chromium, every surface in REQUESTS measured in series. That cost is a property
   of the machine, not of the surfaces. 180s covered it on the machine this file was written
   on; on a clean GitHub runner three green runs spent 127-137s of it (main runs 34519070212,
   34520553827, 34533189195) and PR #7 run 34535514948 spent ~182s and was killed, while
   the 68 tests behind it passed on the very sweep that had just finished. The bound only
   has to tell "still measuring" from "hung", and 600s still does that. The test that paid
   for the sweep reports what it cost, green runs included. */
const SWEEP_TEST_TIMEOUT_MS = 600_000;

function measureAll(): Promise<ReadonlyMap<string, MeasurementOutcome>> {
  sweep ??= (async () => {
    const started = performance.now();
    const server = await startSurfaceServer();
    const outcomes = new Map<string, MeasurementOutcome>();
    try {
      // Catch each request separately: one bad state may never erase evidence
      // from all later states in an unattended run.
      for (const { request } of REQUESTS) {
        try {
          outcomes.set(request.surfaceId, {
            ok: true,
            surface: await measureSurface(server, request),
          });
        } catch (error) {
          outcomes.set(request.surfaceId, {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return outcomes;
    } finally {
      await server.close();
      sweepElapsedMs = Math.round(performance.now() - started);
    }
  })();
  return sweep;
}

/* Only the test that started the sweep reports it: the others find it finished. */
async function measureAllReporting(t: TestContext): Promise<ReadonlyMap<string, MeasurementOutcome>> {
  const paying = sweep === undefined;
  const outcomes = await measureAll();
  if (paying) {
    t.diagnostic(`sweep of ${REQUESTS.length} surfaces: elapsed=${sweepElapsedMs}ms limit=${SWEEP_TEST_TIMEOUT_MS}ms`);
  }
  return outcomes;
}

function auditAll(): Promise<BreadthAudit> {
  breadthAudit ??= measureAll().then(buildBreadthAudit);
  return breadthAudit;
}

after(async () => {
  if (sweep !== undefined) await sweep.catch(() => undefined);
});

test("the F123 breadth registry pairs every Project state across dark and light", () => {
  assert.equal(PROJECT_SURFACES.length, 21);
  assert.equal(REQUESTS.length, PROJECT_SURFACES.length * 2);
  assert.equal(new Set(REQUESTS.map(({ request }) => request.surfaceId)).size, REQUESTS.length);
  for (const definition of PROJECT_SURFACES) {
    assert.ok(definition.targets.length >= 2, `${definition.key}: weak target seed`);
  }
});

test("F123-DC1: the light archived-session failure glyph reaches AA while the row stays visibly archived", async () => {
  const definition = PROJECT_SURFACES.find(
    (surface) => surface.key === "archived-session-list",
  );
  assert.ok(definition, "the archived-session surface must remain registered");

  const server = await startSurfaceServer();
  try {
    const measured = await measureSurface(
      server,
      requestFor(definition, "light"),
    );
    const failureGlyph = findTarget(measured, {
      signature: "span.st.st-failed",
      text: "✕",
    });
    const failureVerdict = judgeText(failureGlyph);
    assert.equal(failureVerdict.threshold, 4.5);
    assert.equal(
      failureVerdict.passes,
      true,
      `${measured.surfaceId}: archived failure glyph measured ${failureVerdict.ratio}:1, below ${failureVerdict.threshold}:1`,
    );

    const archivedTitle = findTarget(measured, {
      signature: "span.sr-title",
      text: "归档-",
    });
    const activeTitle = measured.texts.find(
      (candidate) =>
        candidate.signature.startsWith("span.sr-title") &&
        !candidate.text.includes("归档-") &&
        candidate.color === archivedTitle.color &&
        candidate.inheritedOpacity === 1,
    );
    assert.ok(activeTitle, "the measured surface must include an active Session title");
    assert.ok(
      activeTitle.inheritedOpacity - archivedTitle.inheritedOpacity >= 0.1,
      `${measured.surfaceId}: archived title opacity ${archivedTitle.inheritedOpacity} is not visibly distinct from active ${activeTitle.inheritedOpacity}`,
    );
  } finally {
    await server.close();
  }
});

for (const { definition, tone, request } of REQUESTS) {
  test(`${request.surfaceId} resolves computed ink and compositor-painted glyphs`, {
    timeout: SWEEP_TEST_TIMEOUT_MS,
  }, async (t) => {
    const outcome = (await measureAllReporting(t)).get(request.surfaceId);
    assert.ok(outcome, `${request.surfaceId}: no measurement outcome`);
    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    if (!outcome.ok) return;

    const measured = outcome.surface;
    assert.deepEqual(measured.viewport, MEASUREMENT_VIEWPORT);
    assert.equal(measured.devicePixelRatio, 1);
    assert.equal(measured.root.skin, "acrylic");
    assert.equal(measured.root.tone, tone === "light" ? "light" : null);
    assert.deepEqual(
      measured.consoleMessages.filter(
        (message) => !message.includes("Autofill") && !message.includes("devtools"),
      ),
      [],
      `${request.surfaceId}: renderer console`,
    );

    if (definition.key === "endpoint-picker") assertOpaquePopoverSurface(measured);

    for (const target of definition.targets) {
      const text = findTarget(measured, target);
      assertComputedAndPainted(measured.surfaceId, target, text);
    }
  });
}

test("the F123 alternate-Project breadth denominator remains a fixed inventory", async () => {
  const audit = await auditAll();
  process.stdout.write(`F123_BREADTH_MANIFEST ${JSON.stringify(audit.manifest)}\n`);
  assert.deepEqual(
    audit.manifest,
    FROZEN_BREADTH_INVENTORY,
    "the rendered text-site denominator changed; review the exact inventory before resealing it",
  );
});

test("every F123 family judges more than its legacy named strings", async () => {
  const audit = await auditAll();
  assert.deepEqual(
    audit.familyDeltas.filter(({ added }) => added <= 0),
    [],
    "a Project family gained no additional judged text sites",
  );
});

test("every F123 inventory site is structurally measured and contrast defects stay ratcheted", async () => {
  const audit = await auditAll();
  process.stdout.write(`F123_BREADTH_SHORTFALLS ${JSON.stringify(audit.shortfalls)}\n`);
  assert.deepEqual(
    audit.structuralFailures,
    [],
    "widened rendered coverage found an unresolved or unpainted text site",
  );

  const observed = new Map(
    audit.shortfalls.map((shortfall) => [breadthShortfallKey(shortfall), shortfall]),
  );
  const expected = new Map(
    EXPECTED_BREADTH_SHORTFALLS.map((shortfall) => [breadthShortfallKey(shortfall), shortfall]),
  );
  assert.equal(observed.size, audit.shortfalls.length, "duplicate observed breadth shortfall key");
  assert.equal(
    expected.size,
    EXPECTED_BREADTH_SHORTFALLS.length,
    "duplicate expected breadth shortfall key",
  );

  const unregistered = [...observed]
    .filter(([key]) => !expected.has(key))
    .map(([, shortfall]) => shortfall);
  const stale: string[] = [];
  const deteriorated: string[] = [];
  for (const [key, registered] of expected) {
    const current = observed.get(key);
    if (current === undefined) {
      stale.push(`${key}: now passes or is no longer rendered; remove the registry entry`);
      continue;
    }
    assert.equal(current.threshold, registered.threshold, `${key}: contrast threshold changed`);
    if (current.ratio < registered.measuredRatio - 0.05) {
      deteriorated.push(
        `${key}: ${current.ratio}:1 is worse than recorded ${registered.measuredRatio}:1`,
      );
    }
  }
  assert.deepEqual(unregistered, [], "widened rendered coverage found new contrast defects");
  assert.deepEqual(deteriorated, [], "recorded breadth contrast defects got worse");
  assert.deepEqual(stale, [], "recorded breadth contrast defects are stale");
});

test("F123 reports breadth as reproducible fractions over one denominator", async () => {
  const audit = await auditAll();
  assert.equal(audit.before, 107, "the pre-452 named obligation count changed");
  assert.equal(audit.judged, audit.denominator, "not every inventory site was judged");
  process.stdout.write(
    `F123_BREADTH_COVERAGE ${JSON.stringify({
      metric: "alternate-Project rendered text-site breadth",
      denominator: audit.denominator,
      before: audit.before,
      after: audit.judged,
      beforePercent: roundPercent(audit.before, audit.denominator),
      afterPercent: roundPercent(audit.judged, audit.denominator),
      families: audit.familyDeltas,
    })}\n`,
  );
});

function findTarget(surface: MeasuredSurface, target: TextTarget): MeasuredText {
  const text = surface.texts.find(
    (candidate) =>
      (target.signature === undefined || candidate.signature.startsWith(target.signature)) &&
      candidate.text.includes(target.text),
  );
  assert.ok(
    text,
    `${surface.surfaceId}: missing ${target.signature ?? "text"} containing ${JSON.stringify(target.text)}`,
  );
  return text;
}

function assertComputedAndPainted(
  surfaceId: string,
  target: TextTarget,
  text: MeasuredText,
): void {
  const verdict = inspectComputedAndPainted(surfaceId, target, text);
  const where = `${surfaceId}: ${target.signature ?? text.signature} ${JSON.stringify(target.text)}`;
  assert.ok(verdict.passes, `${where}: neither rendered contrast model reaches its threshold`);
}

function inspectComputedAndPainted(
  surfaceId: string,
  target: TextTarget,
  text: MeasuredText,
): TextVerdict {
  const where = `${surfaceId}: ${target.signature ?? text.signature} ${JSON.stringify(target.text)}`;
  const computed = parseResolvedColor(text.color);
  assert.ok(computed.alpha * text.inheritedOpacity > 0, `${where}: transparent computed ink`);
  assert.ok(text.fontSizePx > 0, `${where}: unresolved computed font size`);
  assert.ok(text.fontWeight.length > 0, `${where}: unresolved computed font weight`);

  const painted = text.boxes.find(
    (box) =>
      box.comparedPixels > 0 &&
      box.inkedPixels > 0 &&
      box.paintedGlyph !== null &&
      box.backgroundSamples.length > 0,
  );
  assert.ok(painted, `${where}: no compositor-painted glyph/background pair`);
  const paintedGlyph = painted.paintedGlyph;
  assert.ok(paintedGlyph, `${where}: compositor-painted glyph is absent`);
  assert.ok(paintedGlyph.alpha > 0, `${where}: painted glyph is transparent`);

  const verdict = judgeText(text);
  assert.ok(verdict.analytic.ratio > 1, `${where}: computed ink has no separation`);
  assert.ok(verdict.painted !== null, `${where}: painted contrast reading is absent`);
  assert.ok(verdict.painted.ratio > 1, `${where}: painted glyph has no separation`);
  return verdict;
}

function assertOpaquePopoverSurface(surface: MeasuredSurface): void {
  const popover = surface.popover;
  assert.ok(popover !== null, `${surface.surfaceId}: the endpoint popover was not measured`);
  assert.equal(
    parseResolvedColor(popover.declaredBackgroundColor).alpha,
    1,
    `${surface.surfaceId}: popover background must be opaque`,
  );
  const texts = surface.texts.filter(
    (text) =>
      text.occludedBy === null &&
      text.boxes.some(
        (box) =>
          box.left >= popover.rect.left &&
          box.top >= popover.rect.top &&
          box.left + box.width <= popover.rect.left + popover.rect.width &&
          box.top + box.height <= popover.rect.top + popover.rect.height,
      ),
  );
  assert.ok(texts.length >= 4, `${surface.surfaceId}: only ${texts.length} popover strings measured`);
  for (const text of texts) {
    const verdict = judgeText(text);
    assert.equal(
      verdict.passes,
      true,
      `${surface.surfaceId}: popover ${text.signature} ${JSON.stringify(text.text)} ` +
        `measures ${verdict.ratio}:1 below ${verdict.threshold}:1`,
    );
  }
}

type BreadthAudit = Readonly<{
  manifest: Readonly<Record<string, BreadthInventorySeal>>;
  denominator: number;
  before: number;
  judged: number;
  familyDeltas: readonly Readonly<{
    surfaceId: string;
    before: number;
    after: number;
    added: number;
  }>[];
  structuralFailures: readonly string[];
  shortfalls: readonly BreadthContrastShortfall[];
}>;

function buildBreadthAudit(
  outcomes: ReadonlyMap<string, MeasurementOutcome>,
): BreadthAudit {
  const manifest: Record<string, BreadthInventorySeal> = {};
  const familyDeltas: Array<{
    surfaceId: string;
    before: number;
    after: number;
    added: number;
  }> = [];
  const structuralFailures: string[] = [];
  const shortfalls: BreadthContrastShortfall[] = [];
  let denominator = 0;
  let before = 0;
  let judged = 0;

  for (const { definition, request } of REQUESTS) {
    const outcome = outcomes.get(request.surfaceId);
    assert.ok(outcome, `${request.surfaceId}: no measurement outcome for breadth census`);
    assert.equal(outcome.ok, true, outcome.ok ? undefined : outcome.message);
    if (!outcome.ok) continue;

    const baselineTexts = [
      ...definition.targets.map((target) => findTarget(outcome.surface, target)),
      ...(BASELINE_SINGLE_TONE_TARGETS[request.surfaceId] ?? []).map((target) =>
        findTarget(outcome.surface, target),
      ),
    ];
    const inventoryByKey = new Map<string, MeasuredText>();
    for (const text of [...breadthInventoryTexts(outcome.surface), ...baselineTexts]) {
      inventoryByKey.set(breadthKey(outcome.surface.surfaceId, text), text);
    }
    const inventory = [...inventoryByKey.values()];
    const keys = inventory.map((text) => breadthKey(outcome.surface.surfaceId, text)).sort();
    assert.equal(
      new Set(keys).size,
      keys.length,
      `${request.surfaceId}: duplicate rendered text-site keys`,
    );
    manifest[request.surfaceId] = Object.freeze({
      count: keys.length,
      sha256: createHash("sha256").update(JSON.stringify(keys), "utf8").digest("hex"),
    });

    const baselineKeys = baselineTexts.map((text) =>
      breadthKey(outcome.surface.surfaceId, text),
    );
    assert.equal(
      new Set(baselineKeys).size,
      baselineKeys.length,
      `${request.surfaceId}: two legacy targets resolve to the same rendered text site`,
    );
    for (const key of baselineKeys) {
      assert.ok(
        keys.includes(key),
        `${request.surfaceId}: legacy target is outside the frozen breadth inventory: ${key}`,
      );
    }

    for (const text of inventory) {
      judged += 1;
      try {
        const verdict = inspectComputedAndPainted(
          outcome.surface.surfaceId,
          { signature: text.signature, text: text.text },
          text,
        );
        if (!verdict.passes) {
          shortfalls.push({
            surfaceId: outcome.surface.surfaceId,
            signature: text.signature,
            text: text.text,
            ratio: verdict.ratio,
            threshold: verdict.threshold,
            analyticRatio: verdict.analytic.ratio,
            paintedRatio: verdict.painted?.ratio ?? null,
          });
        }
      } catch (error) {
        structuralFailures.push(
          `${breadthKey(outcome.surface.surfaceId, text)}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    denominator += keys.length;
    before += baselineKeys.length;
    familyDeltas.push({
      surfaceId: request.surfaceId,
      before: baselineKeys.length,
      after: keys.length,
      added: keys.length - baselineKeys.length,
    });
  }

  return Object.freeze({
    manifest: Object.freeze(manifest),
    denominator,
    before,
    judged,
    familyDeltas: Object.freeze(familyDeltas),
    structuralFailures: Object.freeze(structuralFailures),
    shortfalls: Object.freeze(
      shortfalls.sort((left, right) =>
        breadthShortfallKey(left).localeCompare(breadthShortfallKey(right)),
      ),
    ),
  });
}

function breadthInventoryTexts(surface: MeasuredSurface): readonly MeasuredText[] {
  const dormantRoots = new Set(["main.stage", "aside.inspector"]);
  return surface.texts.filter(
    (text) =>
      text.text.trim() !== "" &&
      !text.ariaHiddenAncestors.some((ancestor) => dormantRoots.has(ancestor)) &&
      text.occludedBy === null,
  );
}

function breadthKey(surfaceId: string, text: MeasuredText): string {
  return `${surfaceId}\u0000${text.signature}\u0000${text.text}`;
}

function breadthShortfallKey(
  shortfall: Pick<BreadthContrastShortfall, "surfaceId" | "signature" | "text">,
): string {
  return `${shortfall.surfaceId}\u0000${shortfall.signature}\u0000${shortfall.text}`;
}

function roundPercent(numerator: number, denominator: number): number {
  assert.ok(denominator > 0, "coverage denominator must be positive");
  return Math.round((numerator / denominator) * 10_000) / 100;
}
