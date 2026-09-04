/* Issue 161. Two claims live here.

   The first is the gate: `--window-placement=offscreen` moves the window ONLY
   when the same launch also carries `--user-data-dir`, and a launch that carries
   neither adds nothing at all. "Adds nothing at all" is the load-bearing half —
   the owner's own `run-app.bat` launch must be the same window it has always
   been, which is why the decision is a value that main.ts spreads rather than a
   branch that rebuilds the options object.

   The second is that the QA harness's copy of the origin rule has not drifted
   from the product's. The harness runs in Electron's main process, which does
   not strip TypeScript types, so it cannot import the product module; the two
   implementations are held against each other here over a table of layouts. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  OFFSCREEN_PLACEMENT_ARGUMENT,
  OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN,
  OFFSCREEN_PLACEMENT_MARGIN,
  OFFSCREEN_WINDOW_PLACEMENT,
  WINDOW_PLACEMENT_SWITCH,
  formatWindowPlacementDiagnostic,
  offscreenWindowOptions,
  offscreenWindowOrigin,
  resolveWindowPlacement,
  type DisplayBounds,
} from "../../src/workbench-shell/electron/window-placement.ts";
import {
  OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN as HARNESS_FALLBACK_ORIGIN,
  OFFSCREEN_PLACEMENT_MARGIN as HARNESS_MARGIN,
  offscreenWindowOrigin as harnessOffscreenWindowOrigin,
} from "./visual-harness/offscreen-placement.mjs";
import { productionElectronArguments } from "../e2e/harness/production-electron.ts";

const LAYOUTS: ReadonlyArray<readonly DisplayBounds[]> = Object.freeze([
  [],
  [{ x: 0, y: 0, width: 3072, height: 1728 }],
  [{ x: 0, y: 0, width: 1920, height: 1080 }],
  [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: -200, width: 2560, height: 1440 },
  ],
  [
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 3840, height: 2160 },
  ],
  [
    { x: -1024, y: -768, width: 1024, height: 768 },
    { x: 0, y: 0, width: 1280, height: 1024 },
    { x: 1280, y: 300, width: 1920, height: 1080 },
  ],
]);

test("offscreen placement is refused unless the launch is an isolated profile that asked for it", () => {
  assert.deepEqual(
    resolveWindowPlacement({
      isolatedUserDataDirectory: true,
      placementSwitchValue: OFFSCREEN_WINDOW_PLACEMENT,
    }),
    { kind: "offscreen" },
  );
  assert.deepEqual(
    resolveWindowPlacement({
      isolatedUserDataDirectory: true,
      placementSwitchValue: "  offscreen  ",
    }),
    { kind: "offscreen" },
  );

  // The owner's own launch: no switches at all. This is the case that must add
  // nothing to the BrowserWindow options.
  assert.deepEqual(
    resolveWindowPlacement({
      isolatedUserDataDirectory: false,
      placementSwitchValue: null,
    }),
    { kind: "default", reason: "no-placement-switch" },
  );
  assert.deepEqual(
    resolveWindowPlacement({
      isolatedUserDataDirectory: true,
      placementSwitchValue: null,
    }),
    { kind: "default", reason: "no-placement-switch" },
  );

  // The switch alone is not enough. Anything that reaches the owner's real
  // conversation store keeps its window where he can see it.
  assert.deepEqual(
    resolveWindowPlacement({
      isolatedUserDataDirectory: false,
      placementSwitchValue: OFFSCREEN_WINDOW_PLACEMENT,
    }),
    { kind: "default", reason: "shared-user-data-directory" },
  );

  // A typo places the window where the launcher can see it, never somewhere it
  // cannot.
  for (const value of ["", "on", "onscreen", "OFFSCREEN", "off screen", "0"]) {
    assert.deepEqual(
      resolveWindowPlacement({
        isolatedUserDataDirectory: true,
        placementSwitchValue: value,
      }),
      { kind: "default", reason: "unrecognised-placement" },
      `placement value ${JSON.stringify(value)} must not be honoured`,
    );
  }
});

test("the offscreen origin leaves no intersection with the virtual screen, at any window size", () => {
  for (const layout of LAYOUTS) {
    const origin = offscreenWindowOrigin(layout);
    if (layout.length === 0) {
      assert.deepEqual(origin, OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN);
      continue;
    }
    const right = Math.max(...layout.map((display) => display.x + display.width));
    const top = Math.min(...layout.map((display) => display.y));
    const bottom = Math.max(
      ...layout.map((display) => display.y + display.height),
    );
    const left = Math.min(...layout.map((display) => display.x));
    assert.equal(origin.x, right + OFFSCREEN_PLACEMENT_MARGIN);
    assert.equal(origin.y, top);
    for (const size of [
      { width: 720, height: 460 },
      { width: 1280, height: 820 },
      { width: 1440, height: 900 },
      { width: 3840, height: 2160 },
    ]) {
      const overlapsHorizontally =
        Math.max(origin.x, left) < Math.min(origin.x + size.width, right);
      const overlapsVertically =
        Math.max(origin.y, top) < Math.min(origin.y + size.height, bottom);
      assert.equal(
        overlapsHorizontally && overlapsVertically,
        false,
        `a ${size.width}x${size.height} window at ${origin.x},${origin.y} must not touch the virtual screen`,
      );
    }
  }
});

test("the offscreen options are an origin, a taskbar suppression and no focus, and nothing else", () => {
  const options = offscreenWindowOptions([
    { x: 0, y: 0, width: 1920, height: 1080 },
  ]);
  // focusable:false is the half that stops the RESTORE path. A second instance,
  // a tray click and a notification click all call show() and then focus()
  // deliberately; an offscreen window that can be activated answers them by
  // taking the owner's keyboard with nothing to show for it. Both calls still
  // happen, so anything counting them still counts them.
  assert.deepEqual(options, {
    x: 1984,
    y: 0,
    skipTaskbar: true,
    focusable: false,
  });
  assert.deepEqual(Object.keys(options).sort(), [
    "focusable",
    "skipTaskbar",
    "x",
    "y",
  ]);
});

test("the QA harness carries the same origin rule as the product", async () => {
  assert.equal(HARNESS_MARGIN, OFFSCREEN_PLACEMENT_MARGIN);
  assert.deepEqual(HARNESS_FALLBACK_ORIGIN, OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN);
  for (const layout of LAYOUTS) {
    assert.deepEqual(
      harnessOffscreenWindowOrigin(layout),
      offscreenWindowOrigin(layout),
      `harness and product disagree for layout ${JSON.stringify(layout)}`,
    );
  }
});

test("a default launch adds no window option at all", async () => {
  const source = await readFile(
    fileURLToPath(
      new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    ),
    "utf8",
  );
  // The empty object is the whole claim: spreading it into windowOptions leaves
  // the object main.ts built before this switch existed.
  assert.match(
    source,
    /function windowPlacementOptions\(\)[\s\S]*?if \(windowPlacement\.kind !== "offscreen"\) return \{\};/u,
  );
  assert.match(source, /\.\.\.windowPlacementOptions\(\),/u);
  assert.match(
    source,
    /if \(windowPlacement\.kind === "offscreen"\) createdWindow\.showInactive\(\);\s+else createdWindow\.show\(\);/u,
  );
  // The gate is read from the command line and from nothing else.
  assert.match(
    source,
    /isolatedUserDataDirectory: app\.commandLine\.hasSwitch\("user-data-dir"\),/u,
  );
  // The startup-failure window takes the same options and is still created
  // shown; focusable:false is what keeps that from being an activation.
  assert.match(
    source,
    /failureWindow = new BrowserWindow\(\{[\s\S]*?\.\.\.windowPlacementOptions\(\),\s+show: true,/u,
  );
  // Nothing in this file re-implements a window boundary to suppress focus: the
  // suppression is a window option, so every existing call site is untouched.
  assert.doesNotMatch(source, /presentedWindow/u);
});

test("every production launch a test or an agent starts carries the switch", () => {
  const composition = Object.freeze({
    repositoryRoot: "C:/repo",
    electronExecutable: "C:/repo/electron.exe",
    rendererUrl: "file:///C:/repo/dist/renderer/index.html",
  });
  const args = productionElectronArguments(composition, "C:/profile");
  assert.equal(OFFSCREEN_PLACEMENT_ARGUMENT, "--window-placement=offscreen");
  assert.equal(
    OFFSCREEN_PLACEMENT_ARGUMENT,
    `--${WINDOW_PLACEMENT_SWITCH}=${OFFSCREEN_WINDOW_PLACEMENT}`,
  );
  assert.ok(args.includes(OFFSCREEN_PLACEMENT_ARGUMENT));
  assert.ok(args.includes("--user-data-dir=C:/profile"));
  assert.deepEqual(
    productionElectronArguments(composition, "C:/profile", ["--extra"]).at(-1),
    "--extra",
  );
});

test("the run log names the surface and the placement it opened", () => {
  assert.equal(
    formatWindowPlacementDiagnostic(
      "main-window",
      { kind: "offscreen" },
      { x: 3136, y: 0 },
    ),
    "[window-placement] surface=main-window;offscreen@3136,0;shown=inactive",
  );
  assert.equal(
    formatWindowPlacementDiagnostic(
      "startup-failure-window",
      { kind: "default", reason: "no-placement-switch" },
      null,
    ),
    "[window-placement] surface=startup-failure-window;default(no-placement-switch);shown=active",
  );
});
