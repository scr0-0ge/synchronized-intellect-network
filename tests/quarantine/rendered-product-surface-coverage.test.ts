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
import test, { after } from "node:test";

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
      { signature: "p.control-note", text: "Loading Agent Runtime Session Profile options…" },
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
      { signature: "p.control-note.is-error", text: "Session Profile options are unavailable" },
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
      { signature: "p.control-note", text: "Choose a model and Work Intensity." },
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
    "f123-empty-project-dark": { count: 70, sha256: "7e7988fa27f40a4978625192e5be88849d7d07cd0fc2481b93231a63373bb1da" },
    "f123-empty-project-light": { count: 74, sha256: "4c4451784413c7db1c1dc5648276a02be01e3e767399d4daa83a9fca14bcd19a" },
    "f123-code-copy-idle-dark": { count: 112, sha256: "b0645766f8518ec108f62ef2bb54a28d6fa0b7a2c0aa5a275eebf75e568fdc86" },
    "f123-code-copy-idle-light": { count: 112, sha256: "985dc5e5f67167bc97e0c61f516077076b680058b9ba2476d11dcc03b2e49e14" },
    "f123-code-copy-copied-dark": { count: 112, sha256: "f8d474caba8b0c6edbe4ddcee0d6b0c742147f098e1c30bf51fc2a23eed82cba" },
    "f123-code-copy-copied-light": { count: 112, sha256: "bed668c55e8b1d6dbd04ae29b18bedd77426ffeded73887d49cfc4ef4129732a" },
    "f123-expanded-event-log-dark": { count: 125, sha256: "146b551957e610adfd9ec4c4a823755cb050326000957f6f3b5ee0ebc35f8bb7" },
    "f123-expanded-event-log-light": { count: 125, sha256: "abed095014aeeffcca4877c2300f7c44af9cba5e5591fff31bcef50c3282604c" },
    /* A selected blocked Session names its fresh-profile exit instead of falsely
       claiming the current selection is missing; measured site counts stay fixed. */
    "f123-failed-command-blocked-dark": { count: 80, sha256: "2b544c2a46bccdf87c0d578a7a8bc49f05b6f2b2774c88a96e44c5ccb1794e57" },
    "f123-failed-command-blocked-light": { count: 83, sha256: "945e424778ba16e38b4effda84acd458e9342ab2762240b809431107a248ee9c" },
    "f123-recovery-required-blocked-dark": { count: 90, sha256: "57bb9f8167d944de939369009725a904c1a44573a911d2fd5ae5100d12c21be3" },
    "f123-recovery-required-blocked-light": { count: 90, sha256: "83093a2eb037e543c530acb72214c14cfbe966f573a6707942739a49501c4af1" },
    "f123-active-turn-interrupt-dark": { count: 118, sha256: "6be82827f2068252591a2a005d612c13f182516223923b1b6dc58275d0c08d77" },
    "f123-active-turn-interrupt-light": { count: 118, sha256: "db4fa1a4e8a271ff68e098b320ad24f9d01c65eefd8bfedf3e5608d12e1c2a2d" },
    "f123-interrupted-turn-dark": { count: 111, sha256: "b29c8a1406f7e90e204273e9af0f05f2bc82ec7dd1d84d4b92d694358c80c8cf" },
    "f123-interrupted-turn-light": { count: 111, sha256: "13a090f20065e6c95b47ce9ca86a048ff614193cf023dfcbb2af3f31384a446e" },
    "f123-new-session-mode-dark": { count: 61, sha256: "510d3d662a777b1a6cdacba34daa2e90aac947b62186b9d63c9c094d164d3b35" },
    "f123-new-session-mode-light": { count: 61, sha256: "720b8ec5d1b894a09276c69c6083df4f59bdda3855658e64805efd3e10c34d6f" },
    /* Ticket 25 census re-seal (worker 20): the family facades renamed the
       desktop segment labels ("Codex desktop"/"Claude Code desktop" became
       "Subscription") and the hidden family backends left the picker,
       statusbar and runtime-not-located surfaces, so every surface carrying
       endpoint secondary text re-seals from the post-facade measurement.
       Counts are unchanged everywhere: no text site left the census, the
       substitutions are the renamed segment labels and the merged rows. */
    "f123-endpoint-picker-dark": { count: 77, sha256: "55f5b557812673d0e3f339482ae65b83fecaf3f4a7d3a570626a95a0e17fbef6" },
    "f123-endpoint-picker-light": { count: 77, sha256: "72b4daacec49b3b9ff02d2399aa9b630f2b9da0187c505c3c459a46ab276c3c0" },
    "f123-model-picker-dark": { count: 77, sha256: "194758df010d0fe2befc9f019f5f84d2f3d48c50927bce516fb49fa376bdb4e8" },
    "f123-model-picker-light": { count: 77, sha256: "760159ace33a4069383d50a6d6fb793db6c9354e1cb8d4705a4b32138f6f19d2" },
    "f123-work-intensity-picker-dark": { count: 84, sha256: "11da8753af4f2e973112af8398e341009b1ffc4f135689a92eeec70161b37d76" },
    "f123-work-intensity-picker-light": { count: 84, sha256: "39eb55f67fa85254228c9a3d89c68670b0d0e0865e82cd4be500bce70b84dc18" },
    "f123-profile-loading-dark": { count: 73, sha256: "323238766cab0522a895546b4731850e20d1a3f56750d4ddfc64bd73e69bcec8" },
    "f123-profile-loading-light": { count: 73, sha256: "54e2fa3cb5ec053955565931e0fbaf1659dea850fcd41c165044a1a91d5321d4" },
    "f123-profile-unavailable-dark": { count: 74, sha256: "0eaa53cca57fbddc50f36d981214462912a00ac1df3e2819c93ec48cab408b85" },
    "f123-profile-unavailable-light": { count: 74, sha256: "0ab91c875d7a4864458db263ab500cbb8f641129a1da25910190b50ea351c170" },
    "f123-profile-without-default-dark": { count: 75, sha256: "ac8a081509771342f291b912a2f81f44a0a5d4ff9feac5b75d3b2a2b6e497719" },
    "f123-profile-without-default-light": { count: 75, sha256: "bea31d228f45512a98edad827358fefae6c1fdf5ae37916f92e4788ede0b68af" },
    /* main-resync census re-seal (worker 19): both lines of descent edited the
       runtime-not-located surface independently -- the lane's WO23 reworded the
       runtimeBoundary sentence ("never asks for a password, API key, or token"
       became "never asks for or stores subscription credentials; a provider
       API key saved in Settings is encrypted with your OS user account."),
       and main's worker 477 replaced "No lookup path is exposed." with "Not
       found under any name that was checked." (issue #2). The merged tree
       carries BOTH sentences, so neither sealed hash was valid any more;
       re-sealed from the post-merge rendered-surface measurement. */
    "f123-runtime-not-located-dark": { count: 53, sha256: "5b39a05bdc7fae09f6d813872800c5271115a833804ca62c2e711e66a801d615" },
    "f123-runtime-not-located-light": { count: 53, sha256: "2f400d6ff3b0c991279f261da35ac8451d959690c0f95a763c75a9fe42416d5c" },
    "f123-archived-session-list-dark": { count: 112, sha256: "dd143599f232b9163cc810b4c9f593f8952a49544250f62627661f31ac1451fd" },
    "f123-archived-session-list-light": { count: 112, sha256: "eb21d602e3895187ba6dc7dff1f3b1db49aeb9aacc438058594361bdc2018b9d" },
    /* The archived blocked surface carries the same selected-Session footer. */
    "f123-archived-session-blocked-dark": { count: 97, sha256: "e961effb95d5942af252fd5ad8c982c18a050c51ba7cca77047e59b0232be062" },
    "f123-archived-session-blocked-light": { count: 97, sha256: "bd7be25b75d3b00fcd1f93ae6feebcdf74a08c464149f15218bf8ff05be7a862" },
    "f123-submission-pending-dark": { count: 113, sha256: "857d7cf2c885bbc39c384e6b5d6e2f0f31e75b58860ed890eacb0ef278dcbb90" },
    "f123-submission-pending-light": { count: 113, sha256: "af998d01191535efe4ed378abe76b1722551f2128106d9e2bf22304c60676028" },
    "f123-submission-error-dark": { count: 113, sha256: "546f190318093b83b27a496a56c81bc56d40efafdb867ea691fac8ee995be8b8" },
    "f123-submission-error-light": { count: 113, sha256: "9b68eb5047e5b15ac1b5290190dcf47f0a989bd1ec028fb26c7490c90732ba2a" },
    "f123-unavailable-registered-project-dark": { count: 58, sha256: "900c36a254a71df7a0fc431795151da39958e8a59a84c17ad60da86c5deef4b4" },
    "f123-unavailable-registered-project-light": { count: 58, sha256: "5c2b83116d462bf453cec7ba542838376b5f1c84ec906677a6ded283e51e46ef" },
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
let breadthAudit: Promise<BreadthAudit> | undefined;

function measureAll(): Promise<ReadonlyMap<string, MeasurementOutcome>> {
  sweep ??= (async () => {
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
    }
  })();
  return sweep;
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
    timeout: 180_000,
  }, async () => {
    const outcome = (await measureAll()).get(request.surfaceId);
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
