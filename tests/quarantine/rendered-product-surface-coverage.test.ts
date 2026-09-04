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
 */
const FROZEN_BREADTH_INVENTORY: Readonly<Record<string, BreadthInventorySeal>> =
  Object.freeze({
    "f123-empty-project-dark": { count: 71, sha256: "ea5fd50eaf79b7fc5e7c0f9a6e4ee00970cf2c966c468543756c7c8fdd068588" },
    "f123-empty-project-light": { count: 75, sha256: "2a64f05288417de61a4dc5c3d4d6b5af6e5c760cdaeb1be808af2470e6e64e76" },
    "f123-code-copy-idle-dark": { count: 113, sha256: "750072d4ff535225c346e2219dd13517cf6bb1ea46d63d44bf1905fee2ccf2c4" },
    "f123-code-copy-idle-light": { count: 113, sha256: "2ceff70b975591b3517363e053c3c9fde3bc863fdd96801be39c114d54d3a3d2" },
    "f123-code-copy-copied-dark": { count: 113, sha256: "b83628715c38393305aeb4ef760c8dc27ce917302493d6be45569faa86805c49" },
    "f123-code-copy-copied-light": { count: 113, sha256: "c6d3de22fa79c14fc5631c445f48b33361779d717cef506beefcfd596d4fd17f" },
    "f123-expanded-event-log-dark": { count: 126, sha256: "3baf81f921033b66bb3071e85292e99ed34a852eeb28daba0bbad125c793a947" },
    "f123-expanded-event-log-light": { count: 126, sha256: "ddd49ca059922587b416a4285f6b62461003d4def2a2e3ce0b2832e308e3b406" },
    "f123-failed-command-blocked-dark": { count: 82, sha256: "12daf93dae73bbf2ec402e94e8234057eb7ee8dad7cb7c82cf15f5a81bdafcdc" },
    "f123-failed-command-blocked-light": { count: 85, sha256: "53b0f311efff1682dee4efdff686bc19d3ecfb5e503005707aafd961cbc1db57" },
    "f123-recovery-required-blocked-dark": { count: 92, sha256: "ce44fc26f3aa6232575478f419de763fafa973250e3c7c56695e015ef6ca5bec" },
    "f123-recovery-required-blocked-light": { count: 92, sha256: "c7366f6a2abfc8232d036f900a1c4f799a4b5e4b849081ea04c61c380547c3d9" },
    "f123-active-turn-interrupt-dark": { count: 120, sha256: "4b9df6d3a9f4758ad9c8f09afe567452cc27c9f725ae7b21bd027162615c2cea" },
    "f123-active-turn-interrupt-light": { count: 120, sha256: "bf79126d35b9fe9dce08bac25546383a264d837c6631556c217a1e5d3d7c274b" },
    "f123-interrupted-turn-dark": { count: 112, sha256: "93b6a6278310ca0a18e408f41f63769d345f6a052dc24730c1a26906e286ed46" },
    "f123-interrupted-turn-light": { count: 112, sha256: "3dfbc6e29938a6077b021eb1dd46fb13abf3f4afd068f493b587cdbb458b44f7" },
    "f123-new-session-mode-dark": { count: 62, sha256: "43cb3369bc7c7000538f131bf886339c32d204cc8d37d0232d915fb2345d9b42" },
    "f123-new-session-mode-light": { count: 62, sha256: "c1e4fd3fd4f5c09622d88c77a9d47d01d07568b3dbaa4217910f3b7897c560db" },
    "f123-endpoint-picker-dark": { count: 79, sha256: "0a0db3f9e78d121f89b1d25c05518dd9f1df6b15353ffcb51ac2e0415d5574d4" },
    "f123-endpoint-picker-light": { count: 79, sha256: "469727cc1d812079fa094ec439a475908d93100228496a8e3b3ebe665db4c512" },
    "f123-model-picker-dark": { count: 78, sha256: "ed48396137281b22bb542cf312649e94d3dd3b14d01a9b87356ec62366f43966" },
    "f123-model-picker-light": { count: 78, sha256: "8089b4018609f29b283cfc6c473d30fc0ebb4b47fcf7a9babfd3f813521b9fb0" },
    "f123-work-intensity-picker-dark": { count: 85, sha256: "950f9bbb6f5aaf9aaf96c53532f46d29c1620bb7c2578266691bb1d1469eab49" },
    "f123-work-intensity-picker-light": { count: 85, sha256: "f020ac229cdb8cf5ebc699ba36670495cc72fea304b989ff0dad7be61cfc62ce" },
    "f123-profile-loading-dark": { count: 74, sha256: "2a1c4e6a1a14949915d46cef243a7d551e7faea85d2fde2b13eaf56572f8e0d1" },
    "f123-profile-loading-light": { count: 74, sha256: "633965ce6ff0107b06d6abdee9bb73ef3a1b3b07a0e4752e35f150b2c2bff427" },
    "f123-profile-unavailable-dark": { count: 76, sha256: "214a14ea55417b38edad7d2f0f1057290909fbf3134395e48045b202fab4d815" },
    "f123-profile-unavailable-light": { count: 76, sha256: "64e3e242bfaa8b455602a3d889e6f2be4954c16d7c4e4c0aaf76d56c7c3d8da1" },
    "f123-profile-without-default-dark": { count: 77, sha256: "906009c968884ac1565f55c7f719bcb050a20065714784e5e0008e3159f03c3d" },
    "f123-profile-without-default-light": { count: 77, sha256: "7dc807ce11f5cc2614d236339d3879f15f9014a9fc16944597a8e9eb19e4b67d" },
    "f123-runtime-not-located-dark": { count: 55, sha256: "d1a2374e9e1b0bde91804d5cec0700d38ca9531d54b6c3785004ace6a66d1a65" },
    "f123-runtime-not-located-light": { count: 55, sha256: "032fe71a6910b30874ddc6fb1cd39c1d3c21a7603fab268612e0a460b1d59fe9" },
    "f123-archived-session-list-dark": { count: 113, sha256: "be1990583859504e4c6dfc76f47f17fffcea34572e65b52da7a8ab8347af9294" },
    "f123-archived-session-list-light": { count: 113, sha256: "cbba8325bb2e543e9b55d66151fdbae5ba500c5eabfa2b6110fa63fd142de240" },
    "f123-archived-session-blocked-dark": { count: 99, sha256: "767d276443007729b839f4e1a96fa1e8119a7997236308b6046a1f3716a59e40" },
    "f123-archived-session-blocked-light": { count: 99, sha256: "1a69df6ae8fb4ffb5a3b42e2a6b8d443982d8bd3c22fa8744e43c09f9e969284" },
    "f123-submission-pending-dark": { count: 114, sha256: "9c0e02adf5532476265442a6d50dc2acea3e3ea84ca3ebdc6c455a12220bfa0b" },
    "f123-submission-pending-light": { count: 114, sha256: "771b4751e6a55266c49120a965496f0509b39a81539534fb547287dc4908429e" },
    "f123-submission-error-dark": { count: 114, sha256: "20043674249660f1da149593282cac70540941c2748ed1631d33ca6a01769dc8" },
    "f123-submission-error-light": { count: 114, sha256: "f4b4a0c598b0ae154c66959694c7d448978f0cbf45336d3fd6dedbd213adc094" },
    "f123-unavailable-registered-project-dark": { count: 59, sha256: "1a6bc219b0acf269da04fd126918adfde285bacbec834f3bd3cf69a01ffd2e46" },
    "f123-unavailable-registered-project-light": { count: 59, sha256: "c92033fbfeddc39a90bc8b6e6ad17a3bf818139c0f91a45cb3e46fe61c6e238d" },
  });

/*
 * Widening is allowed to discover product defects, not to erase them. This is
 * an exact ratchet: a new failure, deterioration > 0.05, a changed threshold,
 * or an entry that has since passed all fails the suite. The issue report owns
 * the product follow-up; this Work Order owns tests only.
 */
const DARK_SEND_KBD_SHORTFALL_SURFACES = Object.freeze([
  "f123-active-turn-interrupt-dark",
  "f123-archived-session-list-dark",
  "f123-code-copy-copied-dark",
  "f123-code-copy-idle-dark",
  "f123-empty-project-dark",
  "f123-endpoint-picker-dark",
  "f123-expanded-event-log-dark",
  "f123-interrupted-turn-dark",
  "f123-new-session-mode-dark",
  "f123-profile-loading-dark",
  "f123-profile-unavailable-dark",
  "f123-profile-without-default-dark",
  "f123-runtime-not-located-dark",
  "f123-submission-pending-dark",
  "f123-unavailable-registered-project-dark",
]);

const EXPECTED_BREADTH_SHORTFALLS: readonly ExpectedBreadthShortfall[] = Object.freeze([
  ...DARK_SEND_KBD_SHORTFALL_SURFACES.map((surfaceId) => ({
    surfaceId,
    signature: "kbd#2",
    text: "Ctrl ↵",
    measuredRatio: 3.835,
    threshold: 4.5,
    reason:
      "The dark Send-button shortcut uses the known tertiary palette shortfall; product palette remediation is outside this test-only Work Order.",
  })),
  {
    surfaceId: "f123-model-picker-dark",
    signature: "kbd#2",
    text: "Ctrl ↵",
    measuredRatio: 3.951,
    threshold: 4.5,
    reason:
      "The picker changes the measured ground but leaves the dark Send-button shortcut below AA; product remediation is out of scope.",
  },
  ...[
    ["span.rt-codex.rt-name", "Codex", 3.944],
    ["span.rt-codex.sr-model", "Solution 5.6", 3.944],
    ["span.sep", "·", 4.421],
  ].map(([signature, text, measuredRatio]) => ({
    surfaceId: "f123-archived-session-blocked-light",
    signature: String(signature),
    text: String(text),
    measuredRatio: Number(measuredRatio),
    threshold: 4.5,
    reason:
      "Light archived-session runtime metadata is below AA on its measured row ground; report only under this Work Order.",
  })),
  ...[
    ["f123-endpoint-picker-dark", "span.endpoint-status-label", "· Catalog ready", 3.932],
    ["f123-endpoint-picker-dark", "span.opt-sub", "Codex desktop", 3.932],
    ["f123-endpoint-picker-light", "span.endpoint-status-label", "· Catalog ready", 4.233],
    ["f123-endpoint-picker-light", "span.opt-sub", "Codex desktop", 4.278],
  ].map(([surfaceId, signature, text, measuredRatio]) => ({
    surfaceId: String(surfaceId),
    signature: String(signature),
    text: String(text),
    measuredRatio: Number(measuredRatio),
    threshold: 4.5,
    reason:
      "Endpoint secondary/status text is below AA on the measured picker ground; product remediation belongs to a follow-up.",
  })),
  ...[
    ["f123-work-intensity-picker-dark", "span.count", "0 / 8,000", 2.884],
    [
      "f123-work-intensity-picker-dark",
      "span#2",
      "Your draft stays local until the Session is durably accepted.",
      2.884,
    ],
    ["f123-work-intensity-picker-light", "span.count", "0 / 8,000", 3.264],
    [
      "f123-work-intensity-picker-light",
      "span#2",
      "Your draft stays local until the Session is durably accepted.",
      3.264,
    ],
  ].map(([surfaceId, signature, text, measuredRatio]) => ({
    surfaceId: String(surfaceId),
    signature: String(signature),
    text: String(text),
    measuredRatio: Number(measuredRatio),
    threshold: 4.5,
    reason:
      "Work-intensity draft/count tertiary text is below AA on the measured picker ground; report only under this Work Order.",
  })),
]);

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
