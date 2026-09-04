/*
 * The rendered-surface guard — `F118`.
 *
 * Every other visual guard in this repository compares SOURCE TEXT. That
 * catches divergence between the product and the design corpus and is
 * structurally incapable of catching a layout or a colour that is wrong in
 * BOTH. A control gained a fifth child while its grid declared four tracks, the
 * New Session action dropped to a second row, and several hundred passing tests
 * could not see it. `F66`/`F87` is the same failure from the other end: a text
 * legibility repair was pinned by a test that asserted the wrong tokens, so the
 * fix and its test could not reach the string the owner complained about.
 *
 * This guard renders the real renderer in a real Chromium and reads back:
 *
 *   GEOMETRY — where the engine actually put things, so a wrap into an
 *   undeclared row is visible even when the stylesheet is untouched and both
 *   copies of it agree.
 *
 *   COMPOSITED COLOUR — the surface under every string, read out of the
 *   compositor's own output buffer. Gradients, stacked alpha, backdrop-filter
 *   and anything painted over the text are included by construction instead of
 *   approximated against a background somebody assumed.
 *
 * Cost boundary: this starts a Vite dev server and hidden Electron renderers
 * against the local visual fixture. No Agent Runtime, no app-server, no
 * provider request, and no window is ever shown.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  contrastRatio,
  formatRgb,
  isLargeText,
  judgeText,
  parseResolvedColor,
  roundTo,
  type TextVerdict,
} from "../harness/rendered-surface/contrast.ts";
import {
  MEASUREMENT_VIEWPORT,
  measureSurface,
  startSurfaceServer,
  type MeasuredSurface,
} from "../harness/rendered-surface/measure.ts";
import {
  CHROME_WORST_CASE_SURFACES,
  EXPECTED_SHORTFALLS,
  GROUND_IDENTITY_GROUP,
  GROUND_SURFACES,
  MEASURED_SURFACES,
  NATIVE_MATERIAL_SURFACE,
  REPAIRED_SITES,
  SETTINGS_GROUND_SURFACES,
  WIDTH_SURFACES,
  type Shortfall,
} from "../harness/rendered-surface/surfaces.ts";

/**
 * Measuring is the expensive part, so every surface is rendered once and each
 * observation below asserts over the same readings. The observations stay
 * separate (`F36`): a combined pass/fail could not say WHICH one failed, and a
 * rendered result is the expensive kind to lose.
 */
let measurement: Promise<readonly MeasuredSurface[]> | undefined;

function measureAll(): Promise<readonly MeasuredSurface[]> {
  measurement ??= (async () => {
    const server = await startSurfaceServer();
    try {
      const surfaces: MeasuredSurface[] = [];
      for (const request of MEASURED_SURFACES) {
        surfaces.push(await measureSurface(server, request));
      }
      return surfaces;
    } finally {
      await server.close();
    }
  })();
  return measurement;
}

let groundMeasurement: Promise<readonly MeasuredSurface[]> | undefined;

function measureGrounds(): Promise<readonly MeasuredSurface[]> {
  groundMeasurement ??= (async () => {
    const server = await startSurfaceServer();
    try {
      const surfaces: MeasuredSurface[] = [];
      for (const request of GROUND_SURFACES) {
        surfaces.push(await measureSurface(server, request));
      }
      return surfaces;
    } finally {
      await server.close();
    }
  })();
  return groundMeasurement;
}

/**
 * The largest per-pixel channel distance permitted across a pane boundary.
 *
 * Three, because three is what the product measures with the CRT layer OFF —
 * `ground-dark-crt-off`, which none of this cycle's changes touch, reads a
 * maximum of 3 with 11 of its 12 boundary pairs at exactly 0. That residue is
 * the acrylic identity gradient behind the whole window, which is one material
 * with a gradient behind it rather than a pane painting itself.
 *
 * This is a RATCHET pinned to a control, not a tolerance chosen to fit. Before
 * the `F102` repair the same boundaries measured 8 (dark), 21 and 26 (light);
 * any return of a private pane ground puts them back above 3.
 */
const MAX_SEAM_DELTA = 3;

/**
 * Surface roots that stay mounted while another surface is active.
 *
 * Their strings remain in `surface.texts`; this classification only says which
 * surface owns the paint obligation. Every dormant root must still prove that
 * it is also measured active and painted, so this cannot become a place to hide
 * globally invisible text.
 */
const DORMANT_SURFACE_ANCESTORS = new Set(["main.stage", "aside.inspector"]);

function dormantSurfaceAncestor(text: MeasuredSurface["texts"][number]): string | null {
  const observed = (
    text as MeasuredSurface["texts"][number] & {
      readonly ariaHiddenAncestors?: readonly string[];
    }
  ).ariaHiddenAncestors;
  return observed?.find((ancestor) => DORMANT_SURFACE_ANCESTORS.has(ancestor)) ?? null;
}

function paintObligatedTexts(surface: MeasuredSurface): MeasuredSurface["texts"] {
  return surface.texts.filter((text) => dormantSurfaceAncestor(text) === null);
}

let widthMeasurement: Promise<readonly MeasuredSurface[]> | undefined;

function measureWidths(): Promise<readonly MeasuredSurface[]> {
  widthMeasurement ??= measureSet(WIDTH_SURFACES);
  return widthMeasurement;
}

let settingsMeasurement: Promise<readonly MeasuredSurface[]> | undefined;

function measureSettingsGrounds(): Promise<readonly MeasuredSurface[]> {
  settingsMeasurement ??= measureSet(SETTINGS_GROUND_SURFACES);
  return settingsMeasurement;
}

let chromeMeasurement: Promise<readonly MeasuredSurface[]> | undefined;

function measureChromeWorstCases(): Promise<readonly MeasuredSurface[]> {
  chromeMeasurement ??= measureSet(CHROME_WORST_CASE_SURFACES);
  return chromeMeasurement;
}

async function measureSet(
  requests: readonly Parameters<typeof measureSurface>[1][],
): Promise<readonly MeasuredSurface[]> {
  const server = await startSurfaceServer();
  try {
    const surfaces: MeasuredSurface[] = [];
    for (const request of requests) surfaces.push(await measureSurface(server, request));
    return surfaces;
  } finally {
    await server.close();
  }
}

after(async () => {
  if (measurement !== undefined) await measurement.catch(() => undefined);
  if (groundMeasurement !== undefined) await groundMeasurement.catch(() => undefined);
  if (widthMeasurement !== undefined) await widthMeasurement.catch(() => undefined);
  if (settingsMeasurement !== undefined) await settingsMeasurement.catch(() => undefined);
  if (chromeMeasurement !== undefined) await chromeMeasurement.catch(() => undefined);
});

test("the WCAG arithmetic this guard rests on is correct on known values", () => {
  assert.equal(
    roundTo(contrastRatio(rgba(0, 0, 0), rgba(255, 255, 255)), 3),
    21,
    "black on white is the defined maximum",
  );
  assert.equal(roundTo(contrastRatio(rgba(119, 119, 119), rgba(255, 255, 255)), 3), 4.478);
  assert.equal(isLargeText(11, "700"), false);
  assert.equal(isLargeText(24, "400"), true);
  assert.equal(isLargeText(18.67, "700"), true);
  assert.equal(AA_NORMAL_TEXT, 4.5);
  assert.equal(AA_LARGE_TEXT, 3);

  /* Chromium reports `color(srgb …)` once a value has passed through
     `color-mix()`. If that form did not parse, every mixed colour would drop
     out of the sweep and the guard would report a clean run over less of the
     product than it claims to cover. */
  assert.deepEqual(parseResolvedColor("rgb(138, 138, 149)"), {
    red: 138,
    green: 138,
    blue: 149,
    alpha: 1,
  });
  assert.deepEqual(parseResolvedColor("rgba(0, 0, 0, 0.2)"), {
    red: 0,
    green: 0,
    blue: 0,
    alpha: 0.2,
  });
  assert.deepEqual(parseResolvedColor("color(srgb 0 0 0 / 0.5)"), {
    red: 0,
    green: 0,
    blue: 0,
    alpha: 0.5,
  });
  assert.deepEqual(parseResolvedColor("color(srgb 1 1 1)"), {
    red: 255,
    green: 255,
    blue: 255,
    alpha: 1,
  });
  assert.throws(() => parseResolvedColor("chartreuse"), /unparsable resolved colour/u);
});

test("the harness renders the real product and produces readings, on every surface", async () => {
  const surfaces = await measureAll();
  assert.equal(surfaces.length, MEASURED_SURFACES.length);

  const observedDormantRoots = new Set<string>();

  for (const surface of surfaces) {
    const where = surface.surfaceId;
    assert.deepEqual(surface.viewport, MEASUREMENT_VIEWPORT, `${where}: viewport`);
    assert.equal(surface.devicePixelRatio, 1, `${where}: scale factor is pinned`);
    assert.deepEqual(
      { width: surface.capture.width, height: surface.capture.height },
      MEASUREMENT_VIEWPORT,
      `${where}: capture maps 1:1 onto CSS pixels`,
    );
    assert.equal(surface.root.skin, "acrylic", `${where}: the product skin is active`);

    /* A control that produces no output is not a control that passed. */
    assert.ok(surface.texts.length >= 60, `${where}: only ${surface.texts.length} strings measured`);
    assert.ok(surface.grids.length >= 20, `${where}: only ${surface.grids.length} grids measured`);

    const unpainted = paintObligatedTexts(surface).filter((text) =>
      text.boxes.every((box) => box.inkedPixels === 0),
    );
    assert.deepEqual(
      unpainted.map((text) => `${text.signature} "${text.text}"`),
      [],
      `${where}: strings that left no mark on the screen — the reading for these is not a contrast reading`,
    );

    const dormant = surface.texts.filter(
      (text) => dormantSurfaceAncestor(text) !== null,
    );
    for (const text of dormant) {
      observedDormantRoots.add(dormantSurfaceAncestor(text)!);
    }
    assert.deepEqual(
      dormant
        .filter((text) => text.occludedBy === null)
        .map(
          (text) =>
            `${text.signature} "${text.text}" under ${dormantSurfaceAncestor(text)}`,
        ),
      [],
      `${where}: dormant surface strings are not actually covered by the active surface`,
    );

    const blocking = surface.consoleMessages.filter(
      (message) => !message.includes("Autofill") && !message.includes("devtools"),
    );
    assert.deepEqual(blocking, [], `${where}: renderer console was not clean`);
  }

  assert.deepEqual(
    [...observedDormantRoots].sort(),
    [...DORMANT_SURFACE_ANCESTORS].sort(),
    "the measured Settings surfaces exercise every declared dormant surface root",
  );
  for (const root of DORMANT_SURFACE_ANCESTORS) {
    assert.ok(
      surfaces.some((surface) =>
        paintObligatedTexts(surface).some(
          (text) =>
            text.surfaceAncestor === root &&
            text.boxes.some((box) => box.inkedPixels > 0),
        ),
      ),
      `${root}: never measured active and painted, so dormancy would be an exclusion rather than a surface distinction`,
    );
  }
});

/**
 * The `F118` geometry invariant.
 *
 * A grid that declares more than one column track and lets the engine
 * auto-place its children in row flow is stating that the tracks it named are
 * all the tracks there are. If the children occupy more than one rendered row,
 * the declaration and the rendered result disagree — which is exactly what
 * happened when a fifth child was added to a four-track control.
 *
 * There is no exception list, deliberately. A grid that genuinely wants several
 * rows says so in CSS — by placing its children explicitly, or by declaring
 * `grid-auto-flow: column` so overflow becomes a column instead of a row — and
 * both of those are honoured below. That keeps the escape hatch inside the
 * stylesheet, where a reviewer sees it, instead of inside this file, where it
 * would become a place to hide a wrap.
 */
test("no multi-track control wraps into a row it never declared", async () => {
  const surfaces = await measureAll();
  const wrapped: string[] = [];

  for (const surface of surfaces) {
    for (const grid of surface.grids) {
      if (grid.declaredColumnTracks <= 1) continue;
      if (!grid.autoFlow.startsWith("row")) continue;
      if (grid.autoPlacedChildCount !== grid.inFlowChildCount) continue;
      if (grid.renderedRowCount === 1) continue;

      const firstRow = grid.rows[0];
      const overflow = grid.rows.slice(1).flatMap((row) => row.members);
      wrapped.push(
        `${surface.surfaceId}: ${grid.signature} declares ${grid.declaredColumnTracks} column ` +
          `track(s) [${grid.templateColumns}] and auto-places ${grid.inFlowChildCount} children, ` +
          `but they render on ${grid.renderedRowCount} rows. Row 1 holds ` +
          `[${firstRow?.members.join(", ") ?? ""}]; [${overflow.join(", ")}] fell past it. ` +
          `Add the missing track, remove a child, place the children explicitly, or set ` +
          `grid-auto-flow: column so overflow becomes a column.`,
      );
    }
  }

  assert.deepEqual(wrapped, [], "controls wrapped past their declared tracks");
});

/**
 * The `F66`/`F87` colour invariant.
 *
 * Every string is checked against the surface it is ACTUALLY painted on, at the
 * WCAG AA threshold its own rendered size and weight select. Recorded sizes at
 * the tertiary text token are 9.5–13px here, so the large-text exemption
 * applies to nothing in this sweep.
 */
test("every rendered string meets AA on the surface it is actually painted on", async () => {
  const surfaces = await measureAll();
  const unregistered: string[] = [];
  const deteriorated: string[] = [];

  for (const surface of surfaces) {
    for (const verdict of paintObligatedTexts(surface).map(judgeText)) {
      if (verdict.passes) continue;
      const registered = findShortfall(surface.surfaceId, verdict.signature);
      if (registered === undefined) {
        unregistered.push(describe(surface.surfaceId, verdict));
        continue;
      }
      if (verdict.ratio < registered.measuredRatio - 0.05) {
        deteriorated.push(
          `${describe(surface.surfaceId, verdict)} — recorded at ${registered.measuredRatio}:1, now worse`,
        );
      }
    }
  }

  assert.deepEqual(unregistered, [], "strings below AA on their real surface");
  assert.deepEqual(deteriorated, [], "recorded shortfalls that got worse");
});

/**
 * The two component corrections this guard was built to prove, guarded by name.
 *
 * Both defects are still byte-identical in the design corpus, which has no
 * authorisation to be amended for them, so the product carries the repair alone.
 * If it is ever reverted to match the corpus, these ten readings are where it
 * shows — with the number it was at before, so the regression is legible rather
 * than merely red.
 */
test("the sites repaired in this cycle are still measured and still above AA", async () => {
  const surfaces = await measureAll();
  const regressed: string[] = [];

  for (const site of REPAIRED_SITES) {
    const surface = surfaces.find((candidate) => candidate.surfaceId === site.surfaceId);
    assert.ok(surface, `repaired site names an unmeasured surface: ${site.surfaceId}`);
    const verdict = paintObligatedTexts(surface)
      .map(judgeText)
      .find((candidate) => candidate.signature === site.signature);
    if (verdict === undefined) {
      regressed.push(`${site.surfaceId}: ${site.signature} is no longer rendered at all`);
      continue;
    }
    if (!verdict.passes) {
      regressed.push(
        `${site.surfaceId}: ${site.signature} is back below AA at ${verdict.ratio}:1 ` +
          `(it measured ${site.wasRatio}:1 before the correction in theme-legibility.css)`,
      );
    }
  }

  assert.deepEqual(regressed, [], "repaired legibility sites that regressed");
});

/**
 * The register may only shrink by repair, never by convenience. An entry that
 * now passes has to be deleted, so the register cannot outlive the problem and
 * make the product look worse than it is — nor can it quietly become the place
 * failures go.
 */
test("every recorded shortfall is still a real, still-failing measurement", async () => {
  const surfaces = await measureAll();
  const stale: string[] = [];

  for (const shortfall of EXPECTED_SHORTFALLS) {
    const surface = surfaces.find((candidate) => candidate.surfaceId === shortfall.surfaceId);
    assert.ok(surface, `recorded shortfall names an unmeasured surface: ${shortfall.surfaceId}`);
    const verdict = paintObligatedTexts(surface)
      .map(judgeText)
      .find((candidate) => candidate.signature === shortfall.signature);
    if (verdict === undefined) {
      stale.push(`${shortfall.surfaceId}: ${shortfall.signature} is no longer rendered`);
      continue;
    }
    assert.equal(verdict.threshold, shortfall.threshold, `${shortfall.signature}: threshold`);
    if (verdict.passes) {
      stale.push(
        `${shortfall.surfaceId}: ${shortfall.signature} now measures ${verdict.ratio}:1 and passes — ` +
          "delete the entry from EXPECTED_SHORTFALLS",
      );
    }
  }

  assert.deepEqual(stale, [], "recorded shortfalls that no longer describe the product");
});

/**
 * The acrylic determinism caveat, measured rather than asserted.
 *
 * With `data-material="on"` the CSS fallback backdrop is suppressed and the
 * real backdrop is the user's desktop wallpaper through Windows acrylic, so
 * actual contrast is not determinable from inside the app. Every reading above
 * is taken against the DETERMINISTIC fallback, and this observation proves that
 * is what happened: a fully opaque alpha channel at every sampled background
 * pixel means no reading depended on what is behind the window.
 */
test("every contrast reading was taken against a deterministic, opaque backdrop", async () => {
  const surfaces = await measureAll();
  const seeThrough: string[] = [];

  for (const surface of surfaces) {
    assert.equal(
      surface.root.material,
      null,
      `${surface.surfaceId}: measured with native material off, which is what makes the backdrop deterministic`,
    );
    for (const verdict of paintObligatedTexts(surface).map(judgeText)) {
      if (verdict.hasNonDeterministicBackground) {
        seeThrough.push(`${surface.surfaceId}: ${verdict.signature}`);
      }
    }
  }

  assert.deepEqual(seeThrough, [], "readings taken through a see-through window pixel");
});

/**
 * The other half of the same caveat, and the reason the readings above are a
 * floor rather than a promise.
 *
 * `theme-acrylic.css` paints its fallback backdrop only while native material
 * is off. Every number this guard produces therefore rests on that fallback,
 * and this observation measures how load-bearing it is: with
 * `data-material="on"` the composited surface under the product's own text
 * changes, on its own, with no other input.
 *
 * What it changes INTO here is an artifact of the measuring window, not a
 * product fact, and this test deliberately asserts nothing about it. The
 * shipped app is composited by DWM against the user's desktop wallpaper, which
 * a plain offscreen BrowserWindow does not reproduce — an earlier version of
 * this test claimed the captured pixels would go transparent and was simply
 * wrong. That is the point: in the material-on state the real backdrop is not
 * determinable from inside any test here.
 *
 * It follows that the deterministic numbers argue for raising the floor. They
 * never license tuning a token until one wallpaper looks acceptable.
 */
test("the deterministic readings depend on a fallback that native material removes", async () => {
  const server = await startSurfaceServer();
  try {
    const withMaterial = await measureSurface(server, NATIVE_MATERIAL_SURFACE);
    assert.equal(withMaterial.root.material, "on");
    assert.ok(withMaterial.texts.length >= 60, "the same product surface is rendered");

    const fallbackSurface = (await measureAll()).find(
      (surface) => surface.surfaceId === "project-dark-crt-screen",
    );
    const fallbackSurfaces = new Map(
      fallbackSurface === undefined
        ? []
        : paintObligatedTexts(fallbackSurface)
            .map(judgeText)
            .map((verdict) => [verdict.signature, verdict]),
    );
    assert.ok(fallbackSurfaces.size > 0, "the material-off comparison surface was measured");

    let compared = 0;
    let shifted = 0;
    for (const verdict of paintObligatedTexts(withMaterial).map(judgeText)) {
      const fallback = fallbackSurfaces.get(verdict.signature);
      if (fallback === undefined) continue;
      compared += 1;
      const distance =
        Math.abs(verdict.analytic.background.red - fallback.analytic.background.red) +
        Math.abs(verdict.analytic.background.green - fallback.analytic.background.green) +
        Math.abs(verdict.analytic.background.blue - fallback.analytic.background.blue);
      if (distance > 0) shifted += 1;
    }

    assert.ok(compared >= 60, `only ${compared} strings could be compared across the two states`);
    assert.ok(
      shifted > 0,
      "switching native material on left every measured surface identical, which would mean the " +
        "fallback backdrop is not load-bearing and the acrylic caveat recorded here is wrong",
    );
  } finally {
    await server.close();
  }
});

/**
 * `F102`, structurally: the ground is expressed once, on the common ancestor.
 *
 * The owner reported the conversation reading as a smaller sheet pasted onto
 * the window. The cause was never that the panes cited different tokens — it
 * was that a pane painted a fill of its own on top of a ground that already
 * existed. The uniform-acrylic ruling widens the common ancestor from the body
 * to the whole `.app`: titlebar, body-grid and statusbar are now regions of the
 * same material, not sibling plates. The existing BrowserWindow material is
 * also the only blur: a CSS backdrop-filter here would be a second acrylic
 * operation even if it covered the whole app.
 *
 * Kept separate from the rendered check below (`F36`). This one says which
 * declaration is wrong and survives a change of palette; that one says what the
 * eye would actually see and survives a change of structure. A single combined
 * assertion could not say which had failed.
 */
test("full acrylic paints one app ground and no child region ground", async () => {
  const surfaces = await measureGrounds();
  const painted: string[] = [];

  for (const surface of surfaces) {
    for (const ground of surface.grounds) {
      if (!ground.present || ground.selector === ".app") continue;
      const color = ground.declaredBackgroundColor ?? "";
      const image = ground.declaredBackgroundImage ?? "none";
      const transparent = color === "rgba(0, 0, 0, 0)" || color === "transparent";
      if (transparent && image === "none") continue;
      painted.push(
        `${surface.surfaceId}: ${ground.selector} declares background-color ${color} / ` +
          `background-image ${image}. Under one material only .app may.`,
      );
    }

    const app = surface.grounds.find((candidate) => candidate.selector === ".app");
    assert.ok(app?.present, `${surface.surfaceId}: .app was not measured`);
    assert.notEqual(
      app.declaredBackgroundColor,
      "rgba(0, 0, 0, 0)",
      `${surface.surfaceId}: .app carries the shared ground and must declare one`,
    );
    for (const ground of surface.grounds) {
      if (!ground.present) continue;
      assert.equal(
        ground.declaredBackdropFilter,
        "none",
        `${surface.surfaceId}: ${ground.selector} adds a second CSS material`,
      );
      if (ground.declaredWebkitBackdropFilter !== undefined) {
        assert.equal(
          ground.declaredWebkitBackdropFilter,
          "none",
          `${surface.surfaceId}: ${ground.selector} adds a second prefixed CSS material`,
        );
      }
    }
  }

  assert.deepEqual(painted, [], "panes painting a private ground inside the shared one");
});

/**
 * `F102`, as rendered: the panes the owner named are ONE surface.
 *
 * Asserted with native material on over an exact harness backdrop. Suppressing
 * the fallback removes its deliberate gradient and leaves the regions
 * themselves, which must then be exactly equal. No wallpaper or personalization
 * setting is changed to obtain that backdrop.
 */
test("titlebar, Project regions and statusbar composite to one colour", async () => {
  const surfaces = (await measureGrounds()).filter(
    (surface) => surface.root.material === "on",
  );
  assert.ok(surfaces.length >= 2, "both tones are measured with native material on");

  for (const surface of surfaces) {
    const dominant = GROUND_IDENTITY_GROUP.map((selector) => {
      const ground = surface.grounds.find((candidate) => candidate.selector === selector);
      assert.ok(ground?.present, `${surface.surfaceId}: ${selector} was not measured`);
      const top = ground.samples[0];
      assert.ok(
        top !== undefined,
        `${surface.surfaceId}: ${selector} exposed no uncovered ground to measure`,
      );
      return { selector, colour: `rgba(${top.red} ${top.green} ${top.blue} / ${top.alpha})` };
    });

    const distinct = new Set(dominant.map((entry) => entry.colour));
    assert.equal(
      distinct.size,
      1,
        `${surface.surfaceId}: the window regions composite to ${distinct.size} different colours — ` +
        dominant.map((entry) => `${entry.selector} ${entry.colour}`).join(", "),
    );
  }
});

/**
 * `F102`, at the edge the owner could actually see.
 *
 * Two panes can each be internally uniform and still meet at a step. This reads
 * pixels either side of every pane boundary at matched heights, which is the
 * measurement of "no visible edge where the grounds meet" and the one that
 * caught the CRT tube shading after the private fill was already gone.
 */
test("no pane or chrome boundary shows a material step", async () => {
  const surfaces = await measureGrounds();
  const steps: string[] = [];

  for (const surface of surfaces) {
    assert.ok(surface.seams.length >= 2, `${surface.surfaceId}: both seams were measured`);
    for (const seam of surface.seams) {
      for (const sample of seam.samples) {
        if (sample.left.carriedInk || sample.right.carriedInk) continue;
        const delta =
          Math.abs(sample.left.red - sample.right.red) +
          Math.abs(sample.left.green - sample.right.green) +
          Math.abs(sample.left.blue - sample.right.blue) +
          Math.abs(sample.left.alpha - sample.right.alpha);
        if (delta <= MAX_SEAM_DELTA) continue;
        steps.push(
          `${surface.surfaceId}: ${seam.leftSelector} → ${seam.rightSelector} at y=${sample.y} ` +
            `(${sample.offset}px either side) steps by ${delta} — ` +
            `rgba(${sample.left.red} ${sample.left.green} ${sample.left.blue} / ${sample.left.alpha}) ` +
            `against rgba(${sample.right.red} ${sample.right.green} ${sample.right.blue} / ${sample.right.alpha})`,
        );
      }
    }
    assert.ok(
      surface.verticalSeams.length >= 2,
      `${surface.surfaceId}: both chrome/body seams were measured`,
    );
    for (const seam of surface.verticalSeams) {
      for (const sample of seam.samples) {
        if (sample.top.carriedInk || sample.bottom.carriedInk) continue;
        const delta =
          Math.abs(sample.top.red - sample.bottom.red) +
          Math.abs(sample.top.green - sample.bottom.green) +
          Math.abs(sample.top.blue - sample.bottom.blue) +
          Math.abs(sample.top.alpha - sample.bottom.alpha);
        if (delta <= MAX_SEAM_DELTA) continue;
        steps.push(
          `${surface.surfaceId}: ${seam.topSelector} → ${seam.bottomSelector} at x=${sample.x} ` +
            `(${sample.offset}px either side) steps by ${delta} — ` +
            `rgba(${sample.top.red} ${sample.top.green} ${sample.top.blue} / ${sample.top.alpha}) ` +
            `against rgba(${sample.bottom.red} ${sample.bottom.green} ${sample.bottom.blue} / ${sample.bottom.alpha})`,
        );
      }
    }
  }

  assert.deepEqual(steps, [], `material boundaries stepping by more than ${MAX_SEAM_DELTA}`);
});

/**
 * The thin plate is fixed above; this is the legibility verdict. Each hidden
 * BrowserWindow supplies an exact black, white or saturated-red colour behind
 * the material-on renderer, so no owner wallpaper or system setting changes.
 *
 * The owner rejected outline/stroke after seeing both tones because it blurred
 * these small glyphs. Every painted titlebar/statusbar string must therefore
 * clear AA with its foreground colour alone, with no stroke or glow. The brand
 * mark is a logotype and remains the sole WCAG 1.4.3 exclusion.
 */
test("chrome glyphs clear AA over worst-case desktop colours in both tones", async () => {
  const surfaces = await measureChromeWorstCases();
  assert.equal(surfaces.length, CHROME_WORST_CASE_SURFACES.length);

  for (const surface of surfaces) {
    assert.equal(surface.root.material, "on", `${surface.surfaceId}: native material signal`);
    const chrome = surface.texts.filter(
      (text) => text.region !== null && text.signature !== "span.mark",
    );
    assert.ok(chrome.length >= 8, `${surface.surfaceId}: only ${chrome.length} chrome strings`);

    for (const text of chrome) {
      const verdict = judgeText(text);
      assert.equal(
        verdict.hasNonDeterministicBackground,
        false,
        `${surface.surfaceId}: ${text.signature} was not measured over the harness endpoint`,
      );
      assert.equal(
        verdict.occludedBy,
        null,
        `${surface.surfaceId}: ${text.signature} is covered by ${verdict.occludedBy}`,
      );
      assert.equal(
        text.textStrokeWidthPx,
        0,
        `${surface.surfaceId}: ${text.signature} still has a ${text.textStrokeWidthPx}px stroke`,
      );
      assert.equal(
        text.textShadow,
        null,
        `${surface.surfaceId}: ${text.signature} still relies on ${text.textShadow}`,
      );
      assert.ok(
        verdict.painted !== null && verdict.painted.ratio >= verdict.threshold,
        describe(surface.surfaceId, verdict),
      );
    }
  }
});

/**
 * `F102`, the half that is a WIDTH.
 *
 * Every other gate here measures colour. A size cue is invisible to all of
 * them, and on the owner's screen it was the larger of the two: the transcript
 * drew its turn rules across a 1044px band while the input drew its own border
 * across 2472px, both centred on the same line — 714px of bare ground on each
 * side of the prose, directly above a control that ignored it. Two rectangles
 * of different widths sharing a centreline is the literal description of the
 * smaller sheet the owner reported.
 *
 * Asserted at two sizes on purpose. The wide one is where the cap engages and
 * where the defect lived; the pinned one is the control, and it is also the
 * size every other test here runs at, which is why none of them ever saw this.
 */
test("the conversation and its input stand on one reading line", async () => {
  const surfaces = await measureWidths();
  assert.equal(surfaces.length, WIDTH_SURFACES.length);
  const offLine: string[] = [];
  let checked = 0;

  for (const surface of surfaces) {
    const prose = surface.extents.find((extent) => extent.selector === ".column");
    const input = surface.extents.find((extent) => extent.selector === ".input-shell");
    if (prose?.content == null || input?.rect == null) continue;
    checked += 1;

    /* The prose is read at its CONTENT box and the input is seen at its BORDER
       box, because that is what each one actually presents to the eye. */
    const proseRight = prose.content.left + prose.content.width;
    const inputRight = input.rect.left + input.rect.width;
    if (Math.abs(prose.content.left - input.rect.left) > 0.5) {
      offLine.push(
        `${surface.surfaceId}: prose starts at ${prose.content.left} and the input at ${input.rect.left}`,
      );
    }
    if (Math.abs(proseRight - inputRight) > 0.5) {
      offLine.push(
        `${surface.surfaceId}: prose ends at ${proseRight} and the input at ${inputRight}`,
      );
    }

    /* The composer PANE stays full width. Capping it would put a new visible
       edge exactly where the complaint is, so a future repair that "fixes" the
       mismatch by shrinking the pane fails here instead of shipping. */
    const pane = surface.extents.find((extent) => extent.selector === ".composer");
    const stage = surface.extents.find((extent) => extent.selector === ".stage");
    assert.ok(pane?.rect != null && stage?.rect != null, `${surface.surfaceId}: pane and stage`);
    assert.equal(
      pane.rect.width,
      stage.rect.width,
      `${surface.surfaceId}: the composer pane must span the stage — only its contents are on the line`,
    );
  }

  assert.ok(checked >= 2, `only ${checked} surfaces carried both a reading column and an input`);
  assert.deepEqual(offLine, [], "the reading column and the input area are not on one line");
});

/**
 * The same invariant stated as a picture rather than as arithmetic.
 *
 * Two boxes can share a measurement line and still look wrong if what they
 * PAINT does not. This asserts on the drawn edges: the turn rules inside the
 * transcript land exactly on the reading line, and nothing the composer paints
 * — except the pane itself, whose top hairline is a full-width separator by
 * design — reaches outside it.
 */
test("nothing the conversation paints crosses the reading line", async () => {
  const surfaces = await measureWidths();
  const crossing: string[] = [];
  let surfacesWithADrawnLine = 0;

  for (const surface of surfaces) {
    const prose = surface.extents.find((extent) => extent.selector === ".column");
    if (prose?.content == null) continue;
    const left = prose.content.left;
    const right = prose.content.left + prose.content.width;

    const drawnOnTheLine = surface.paintedEdges.filter(
      (edge) =>
        edge.scope === ".transcript" &&
        Math.abs(edge.left - left) <= 0.5 &&
        Math.abs(edge.right - right) <= 0.5,
    );
    if (drawnOnTheLine.length > 0) surfacesWithADrawnLine += 1;

    for (const edge of surface.paintedEdges) {
      if (edge.scope !== ".composer") continue;
      /* The pane's own top hairline runs the width of the stage deliberately:
         it separates the conversation from its input across the window, and
         narrowing it would draw the sheet outline this test exists to prevent. */
      if (edge.signature.startsWith("div.composer")) continue;
      if (edge.left >= left - 0.5 && edge.right <= right + 0.5) continue;
      crossing.push(
        `${surface.surfaceId}: ${edge.signature} paints ${edge.left}..${edge.right} ` +
          `outside the reading line ${left}..${right}`,
      );
    }
  }

  assert.ok(
    surfacesWithADrawnLine >= 1,
    "no surface drew anything on the reading line, so this observation proved nothing",
  );
  assert.deepEqual(crossing, [], "painted controls reaching outside the reading measure");
});

/**
 * The reading cap is still the thing being measured.
 *
 * Without this the two tests above would keep passing if the cap were removed:
 * an uncapped column and an uncapped input agree trivially, and the owner's
 * recorded objection to a frozen measure would have been resolved by accident
 * rather than by decision. `whyItStaysOpen` in the `F102` ledger entry reserves
 * that decision to him.
 */
test("the reading cap still engages on a wide window", async () => {
  const surfaces = await measureWidths();
  const wide = surfaces.find((surface) => surface.surfaceId === "width-project-owner-proxy");
  assert.ok(wide, "the owner-proxy width surface was measured");

  const column = wide.extents.find((extent) => extent.selector === ".column");
  const stage = wide.extents.find((extent) => extent.selector === ".stage");
  assert.ok(column?.rect != null && stage?.rect != null);
  /* Chromium reports `max-width` unresolved, so this is the authored cap
     verbatim — the same literal the source gate in appearance-fidelity pins. */
  assert.equal(column.declaredMaxWidth, "min(100%, 1100px)", "the cap is the declared one");
  assert.equal(column.rect.width, 1100, "the cap is the width actually used");
  assert.ok(
    stage.rect.width > column.rect.width + 200,
    `the stage is ${stage.rect.width}px, which is not wide enough for the cap to bind`,
  );
});

/**
 * Settings, which no gate reached at all until this cycle.
 *
 * Its contract is the INVERSE of the pane contract, so it could never have been
 * folded into the pane sweep: Settings is required to paint its own ground,
 * because the owner ruled that native material and the user's wallpaper must
 * never be able to lower contrast on a page of prose.
 *
 * The assertion is opacity at EVERY probed point, not at the dominant one. The
 * first version of this test also demanded a single flat colour and was simply
 * wrong about the product: the acrylic skin's light rake — `.app::before` in
 * theme-acrylic.css, a fixed 240px band of white at 5% fading downward to
 * nothing — falls across the top of every surface in the window, Settings
 * included. Composited over the flat opaque #0b0b0e reading ground it yields,
 * in dark tone, nine shades from rgb(20 20 23) at the first probed row down to
 * rgb(11 11 14) where the rake runs out — all of them fully opaque. (An
 * earlier version of this comment blamed the CRT tube overlay. It cannot be
 * that: theme-crt.css has no Settings rule; its tube shading hangs off
 * `.stage`, which is not in the DOM while Settings is open; and its vignette
 * layer paints only under the opt-in `data-crt-extras="curve"`, which nothing
 * sets.) A gradient is a legitimate design here; a hole is not, and a hole is
 * what this catches.
 */
test("the Settings reading ground is fully opaque everywhere, in both tones", async () => {
  const surfaces = await measureSettingsGrounds();
  assert.equal(surfaces.length, SETTINGS_GROUND_SURFACES.length);
  const seeThrough: string[] = [];

  for (const surface of surfaces) {
    const settings = surface.grounds.find((candidate) => candidate.selector === ".settings");
    assert.ok(settings?.present, `${surface.surfaceId}: .settings was not measured`);
    assert.ok(
      settings.samples.length > 0,
      `${surface.surfaceId}: .settings exposed no uncovered ground to measure`,
    );
    for (const sample of settings.samples) {
      if (sample.alpha === 255) continue;
      seeThrough.push(
        `${surface.surfaceId}: rgba(${sample.red} ${sample.green} ${sample.blue} / ${sample.alpha}) ` +
          `at ${sample.count} probed point(s)`,
      );
    }
  }

  assert.deepEqual(
    seeThrough,
    [],
    "Settings ground pixels the wallpaper behind the window can reach",
  );
});

/**
 * The half of the same ruling that only native material can test.
 *
 * An opaque ground means the reading surface does not move when the backdrop
 * behind the window changes. Every other ground in the product does move — the
 * pane sweep above measures exactly that — so this is the one place where
 * material on and material off must produce the SAME pixels. If Settings ever
 * picks up a translucent layer, this is where it shows, and it needs no
 * tolerance to say so.
 */
test("native material cannot reach the Settings reading ground", async () => {
  const surfaces = await measureSettingsGrounds();
  const groundOf = (surfaceId: string): readonly string[] => {
    const surface = surfaces.find((candidate) => candidate.surfaceId === surfaceId);
    assert.ok(surface, `${surfaceId} was not measured`);
    const settings = surface.grounds.find((candidate) => candidate.selector === ".settings");
    assert.ok(settings?.present, `${surfaceId}: .settings was not measured`);
    return settings.samples.map(
      (sample) => `rgba(${sample.red} ${sample.green} ${sample.blue} / ${sample.alpha}) x${sample.count}`,
    );
  };

  for (const tone of ["dark", "light"] as const) {
    assert.deepEqual(
      groundOf(`settings-ground-${tone}-material`),
      groundOf(`settings-ground-${tone}`),
      `${tone}: switching native material on changed the Settings reading ground`,
    );
  }

  /* And the two tones are genuinely different grounds, so a palette collapse
     cannot make the comparison above pass by making everything the same. */
  assert.notDeepEqual(groundOf("settings-ground-dark"), groundOf("settings-ground-light"));
});

/**
 * `F51`/`F54`/`F78`, as a measurement rather than as three incompatible claims.
 *
 * The product signals native material whenever the probe did not positively
 * report it UNAVAILABLE — including when the probe came back `undetermined` —
 * and signalling it removes the acrylic skin's own fallback backdrop. That is a
 * deliberate fail-open, and it is only defensible while it is visible. This
 * pins the mechanism so it cannot become invisible: with material signalled,
 * the fallback is gone; with it unsignalled, the fallback is painting.
 */
test("signalling native material is what removes the fallback backdrop", async () => {
  const withMaterial = (await measureGrounds()).filter(
    (surface) => surface.root.material === "on",
  );
  const withoutMaterial = (await measureGrounds()).filter(
    (surface) => surface.root.material === null,
  );
  assert.ok(withMaterial.length >= 1 && withoutMaterial.length >= 1, "both states are measured");

  for (const surface of withMaterial) {
    assert.equal(
      surface.fallbackGround.beforeContent,
      "none",
      `${surface.surfaceId}: the fallback backdrop still exists with native material signalled`,
    );
  }
  for (const surface of withoutMaterial) {
    assert.equal(
      surface.fallbackGround.beforeContent,
      '""',
      `${surface.surfaceId}: the fallback backdrop is missing with native material unsignalled`,
    );
    assert.notEqual(
      surface.fallbackGround.beforeBackgroundImage,
      "none",
      `${surface.surfaceId}: the fallback backdrop exists but paints nothing`,
    );
  }
});

function findShortfall(surfaceId: string, signature: string): Shortfall | undefined {
  return EXPECTED_SHORTFALLS.find(
    (candidate) => candidate.surfaceId === surfaceId && candidate.signature === signature,
  );
}

function describe(surfaceId: string, verdict: TextVerdict): string {
  return (
    `${surfaceId}: ${verdict.signature} "${verdict.text}" measures ${verdict.ratio}:1 ` +
    `against a required ${verdict.threshold}:1 at ${verdict.fontSizePx}px/${verdict.fontWeight}. ` +
    `Authored colour ${verdict.colorSource ?? "(inherited)"} resolves to ${verdict.resolvedColor}; ` +
    `it is painted ${formatRgb(verdict.analytic.foreground)} on ${formatRgb(verdict.analytic.background)}. ` +
    `Resolved-colour model ${verdict.analytic.ratio}:1, painted-pixel model ${verdict.painted?.ratio ?? "n/a"}:1` +
    `${verdict.occludedBy === null ? "" : `; stacked under ${verdict.occludedBy}`}.`
  );
}

function rgba(red: number, green: number, blue: number): {
  red: number;
  green: number;
  blue: number;
  alpha: number;
} {
  return { red, green, blue, alpha: 1 };
}
