/*
 * The surfaces the rendered-surface guard measures, and the shortfalls it is
 * currently allowed to see.
 *
 * Kept beside the driver rather than inside the test so the evidence generator
 * and the guard measure the same thing by construction. A surface added for a
 * report is a surface the guard checks.
 */
import { MEASUREMENT_VIEWPORT, OWNER_PROXY_VIEWPORT, type SurfaceRequest } from "./measure.ts";

const toneGroup = '[aria-labelledby="appearance-tone-label"]';
const crtGroup = '[aria-labelledby="appearance-crt-label"]';
const phosphorGroup = '[aria-labelledby="appearance-phosphor-label"]';
const phosphorTierGroup = '[aria-labelledby="appearance-phosphor-tier-label"]';
const returnToProject = Object.freeze({
  click: "button.settings-rail-button",
  settleSelector: ".composer",
});

/**
 * Appearance is reached the way a user reaches it — through the real Settings
 * controls — so a surface can never be measured in a state the product cannot
 * actually be put into.
 */
export const MEASURED_SURFACES: readonly SurfaceRequest[] = Object.freeze([
  {
    surfaceId: "project-dark-crt-screen",
    query: "?project=default",
    readySelector: ".composer",
  },
  {
    surfaceId: "project-light-crt-off",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [
      { click: "button.appearance-option", within: crtGroup, text: "Off" },
      { click: "button.appearance-option", within: toneGroup, text: "Light" },
      returnToProject,
    ],
  },
  {
    surfaceId: "settings-dark-crt-screen",
    query: "?surface=settings",
    readySelector: ".settings",
  },
  {
    surfaceId: "settings-light-crt-screen",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [{ click: "button.appearance-option", within: toneGroup, text: "Light" }],
  },
]);

/**
 * The complete F177 matrix: A/B/C × tone × normal/fullscreen CRT ×
 * Green/Amber.
 *
 * Every state is reached through the real Settings controls and then measured
 * on the Project surface. `preserveTextShadow` is deliberately opt-in here:
 * the general WCAG sweep removes glow, while this matrix exists to make glow a
 * rendered fact rather than a source-token claim.
 */
export const PHOSPHOR_SURFACES: readonly SurfaceRequest[] = Object.freeze(
  ([
    ["a", "A · Restrained"],
    ["b", "B · Luminous"],
    ["c", "C · Hottest"],
  ] as const).flatMap(([tier, tierLabel]) =>
    (["Dark", "Light"] as const).flatMap((tone) =>
      (["Off", "Full"] as const).flatMap((crt) =>
        (["Green", "Amber"] as const).map((phosphor) => ({
          surfaceId:
            `phosphor-tier-${tier}-${tone.toLocaleLowerCase("en-US")}-` +
            `${crt === "Off" ? "normal" : "fullscreen"}-` +
            phosphor.toLocaleLowerCase("en-US"),
          query: "?surface=settings",
          readySelector: ".settings",
          readyTimeoutMs: 30_000,
          steps: [
            {
              click: "button.appearance-option",
              within: phosphorTierGroup,
              text: tierLabel,
            },
            { click: "button.appearance-option", within: toneGroup, text: tone },
            { click: "button.appearance-option", within: crtGroup, text: crt },
            {
              click: "button.appearance-option",
              within: phosphorGroup,
              text: phosphor,
            },
            returnToProject,
          ],
          preserveTextShadow: true,
        })),
      ),
    ),
  ),
);

/**
 * The Project surfaces whose pane GROUNDS are measured (`F102`).
 *
 * Separate from `MEASURED_SURFACES` because the question is different. Those
 * four exist to sweep text contrast and deliberately include Settings, which
 * has its own authored reading ground. These five exist to answer whether the
 * rail, the stage and the inspector composite to ONE colour at ONE alpha, so
 * every one of them is the three-pane Project surface.
 *
 * The default appearance is `tone: dark, crt: screen` (`contract.ts`) under
 * `data-glass="full"` (`mount.tsx`), so the first entry is the state the owner
 * actually photographed. `crt-off` is the control: if the panes agree with CRT
 * off and disagree with it on, the CRT layer owns the difference and no amount
 * of reading the base stylesheet would have found it.
 *
 * Material on and off are both measured because they are the two backdrops the
 * product really has. Off is the deterministic CSS fallback every contrast
 * number rests on; on is real Windows acrylic, where the alpha channel of the
 * captured pixel says outright whether a pane is see-through — which is the
 * only way to compare TRANSPARENCY rather than just colour.
 */
export const GROUND_SURFACES: readonly SurfaceRequest[] = Object.freeze([
  {
    surfaceId: "ground-dark-crt-screen",
    query: "?project=default",
    readySelector: ".composer",
  },
  {
    surfaceId: "ground-dark-crt-screen-material",
    query: "?project=default",
    readySelector: ".composer",
    rootAttributes: { material: "on" },
    windowBackground: "#000000",
  },
  {
    surfaceId: "ground-light-crt-screen",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [
      { click: "button.appearance-option", within: toneGroup, text: "Light" },
      returnToProject,
    ],
  },
  {
    surfaceId: "ground-light-crt-screen-material",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [
      { click: "button.appearance-option", within: toneGroup, text: "Light" },
      returnToProject,
    ],
    rootAttributes: { material: "on" },
    windowBackground: "#ffffff",
  },
  {
    surfaceId: "ground-dark-crt-off",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [{ click: "button.appearance-option", within: crtGroup, text: "Off" }, returnToProject],
  },
]);

/**
 * Full acrylic over the luminance endpoints and a saturated control.
 *
 * These are hidden isolated BrowserWindows, not the owner's desktop. Native
 * material is signalled on so the CSS fallback is absent, then the harness-only
 * BrowserWindow background supplies the exact colour behind the transparent
 * product renderer. CRT is turned off through the real Appearance control so
 * the verdict belongs to the acrylic text treatment, not optional Phosphor.
 */
export const CHROME_WORST_CASE_SURFACES: readonly SurfaceRequest[] = Object.freeze(
  ([
    ["black", "#000000"],
    ["white", "#ffffff"],
    ["red", "#d32f2f"],
  ] as const).flatMap(([name, windowBackground]) => [
    {
      surfaceId: `chrome-dark-${name}`,
      query: "?surface=settings",
      readySelector: ".settings",
      steps: [
        { click: "button.appearance-option", within: crtGroup, text: "Off" },
        returnToProject,
      ],
      rootAttributes: { material: "on" },
      windowBackground,
    },
    {
      surfaceId: `chrome-light-${name}`,
      query: "?surface=settings",
      readySelector: ".settings",
      steps: [
        { click: "button.appearance-option", within: crtGroup, text: "Off" },
        { click: "button.appearance-option", within: toneGroup, text: "Light" },
        returnToProject,
      ],
      rootAttributes: { material: "on" },
      windowBackground,
    },
  ]),
);

/**
 * The surfaces whose HORIZONTAL EXTENT is measured — the open half of `F102`.
 *
 * Two viewports, deliberately, because a width rule is only a width rule where
 * it engages. `.column` caps at 1100px, which first bites above a 1368px
 * viewport with the inspector collapsed and above 1668px with it visible, so at
 * the pinned 1440x1000 contrast size the cap is inert and a reading taken there
 * would report agreement that only exists because nothing was constrained. The
 * narrow entries are kept as the CONTROL: whatever the wide surface shows must
 * be absent at 1440, or the reading is about something else.
 *
 * Settings is included because it has the same shape — one reading column
 * inside a full-width grid cell — and no ground gate reaches it at all.
 */
export const WIDTH_SURFACES: readonly SurfaceRequest[] = Object.freeze([
  {
    surfaceId: "width-project-owner-proxy",
    query: "?project=default",
    readySelector: ".composer",
    viewport: OWNER_PROXY_VIEWPORT,
  },
  {
    surfaceId: "width-project-pinned",
    query: "?project=default",
    readySelector: ".composer",
    viewport: MEASUREMENT_VIEWPORT,
  },
  {
    surfaceId: "width-settings-owner-proxy",
    query: "?surface=settings",
    readySelector: ".settings",
    viewport: OWNER_PROXY_VIEWPORT,
  },
  {
    surfaceId: "width-settings-pinned",
    query: "?surface=settings",
    readySelector: ".settings",
    viewport: MEASUREMENT_VIEWPORT,
  },
]);

/**
 * The Settings surface, whose ground no gate reached before this cycle.
 *
 * Kept out of `GROUND_SURFACES` because the contract is the OPPOSITE one.
 * Those five assert that no pane paints a ground of its own; Settings is
 * required to, and the requirement is an owner ruling — an opaque reading
 * ground so that native material and the user's wallpaper can never lower
 * contrast on a page of prose. Merging the two sets would have meant weakening
 * the pane assertion to let Settings through, which is the one thing a ratchet
 * must never do.
 *
 * Material on and off are both measured because opacity under native material
 * is the entire point of the ruling. If the ground is genuinely opaque, the two
 * read the same; if it is not, material-on is where it shows.
 */
export const SETTINGS_GROUND_SURFACES: readonly SurfaceRequest[] = Object.freeze([
  {
    surfaceId: "settings-ground-dark",
    query: "?surface=settings",
    readySelector: ".settings",
  },
  {
    surfaceId: "settings-ground-dark-material",
    query: "?surface=settings",
    readySelector: ".settings",
    rootAttributes: { material: "on" },
  },
  {
    surfaceId: "settings-ground-light",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [{ click: "button.appearance-option", within: toneGroup, text: "Light" }],
  },
  {
    surfaceId: "settings-ground-light-material",
    query: "?surface=settings",
    readySelector: ".settings",
    steps: [{ click: "button.appearance-option", within: toneGroup, text: "Light" }],
    rootAttributes: { material: "on" },
  },
]);

/**
 * Every region the owner says is one sheet. Chrome wraps the four Project
 * regions so the order also matches their vertical/horizontal reading order.
 */
export const GROUND_IDENTITY_GROUP: readonly string[] = Object.freeze([
  ".titlebar",
  ".rail",
  ".transcript",
  ".composer",
  ".inspector",
  ".statusbar",
]);

/**
 * The same Project surface with Windows native material switched on.
 *
 * Not part of the asserted set, because there is nothing determinate to assert:
 * with `data-material="on"` the CSS fallback backdrop is suppressed and the
 * real backdrop is the user's desktop wallpaper. It is measured so the caveat
 * is a MEASUREMENT rather than a sentence — the alpha channel of the captured
 * surface says outright whether a reading depended on what is behind the window.
 */
export const NATIVE_MATERIAL_SURFACE: SurfaceRequest = Object.freeze({
  surfaceId: "project-dark-native-material",
  query: "?project=default",
  readySelector: ".composer",
  rootAttributes: { material: "on" },
});

/**
 * The ten readings that were below AA before this cycle's two component
 * corrections, named so the repair is guarded rather than incidentally covered.
 *
 * `span.sep` was painted with the hairline token `--line-2`; the three
 * `.removal-trigger` instances kept whole-control opacity while disabled. Both
 * are still byte-identical in the design corpus, so if the corrections are ever
 * reverted to match it, these sites are where it shows.
 */
export const REPAIRED_SITES: readonly Readonly<{
  surfaceId: string;
  signature: string;
  wasRatio: number;
}>[] = Object.freeze([
  { surfaceId: "project-dark-crt-screen", signature: "span.sep", wasRatio: 1.853 },
  { surfaceId: "project-light-crt-off", signature: "span.sep", wasRatio: 1.593 },
  { surfaceId: "settings-dark-crt-screen", signature: "span.sep", wasRatio: 1.853 },
  { surfaceId: "settings-light-crt-screen", signature: "span.sep", wasRatio: 1.593 },
  {
    surfaceId: "settings-dark-crt-screen",
    signature: "button.icon-btn.project-removal-trigger.removal-trigger",
    wasRatio: 1.716,
  },
  {
    surfaceId: "settings-dark-crt-screen",
    signature: "button.icon-btn.project-removal-trigger.removal-trigger#2",
    wasRatio: 1.685,
  },
  {
    surfaceId: "settings-dark-crt-screen",
    signature: "button.icon-btn.project-removal-trigger.removal-trigger#3",
    wasRatio: 1.685,
  },
  {
    surfaceId: "settings-light-crt-screen",
    signature: "button.icon-btn.project-removal-trigger.removal-trigger",
    wasRatio: 1.658,
  },
  {
    surfaceId: "settings-light-crt-screen",
    signature: "button.icon-btn.project-removal-trigger.removal-trigger#2",
    wasRatio: 1.658,
  },
  {
    surfaceId: "settings-light-crt-screen",
    signature: "button.icon-btn.project-removal-trigger.removal-trigger#3",
    wasRatio: 1.658,
  },
]);

export type Shortfall = Readonly<{
  surfaceId: string;
  signature: string;
  /** The ratio measured when this entry was recorded. A worse reading fails. */
  measuredRatio: number;
  threshold: number;
  reason: string;
}>;

/**
 * Strings that measurably miss AA and require an owner decision before they can
 * change. Each carries its measured number and why it is still here.
 *
 * This is a RATCHET, not an exemption list, and the guard enforces it in both
 * directions:
 *
 *   - an unregistered failure fails the run, so a new shortfall cannot be
 *     absorbed silently;
 *   - a reading worse than the recorded one fails the run, so a registered
 *     shortfall cannot quietly deteriorate;
 *   - a registered entry that now PASSES also fails the run, so a repaired site
 *     must be removed from this list instead of sitting here forever and making
 *     the register look bigger than the problem.
 *
 * Nothing may be added here to make a failure go away (`F26`). An entry is
 * legitimate only when the repair is a decision this project has reserved to
 * the owner. The current measured surfaces have no such shortfall.
 */
export const EXPECTED_SHORTFALLS: readonly Shortfall[] = Object.freeze([]);
