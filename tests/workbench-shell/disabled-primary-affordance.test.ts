/*
 * F215 — a disabled primary button must be tellable from a live one.
 *
 * Worker 464 measured, in the running renderer, that `.btn.primary[disabled]`
 * and `.btn.primary` resolved to the SAME colour, the SAME background, the
 * SAME border and the SAME opacity. The only difference the product offered
 * was `cursor: not-allowed` — and a cursor does not exist on a touch screen,
 * does not exist in a screenshot, and does not exist for anyone who has not
 * already moved a pointer onto the control to ask.
 *
 * Three rules had to be read together to see it:
 *
 *   1. `styles.css` `.btn[disabled] { color: var(--fg-3); opacity: .65 }` and
 *      `.btn.primary { color: … }` carry EQUAL specificity (0,2,0), so the
 *      later `.btn.primary` takes the colour and the disabled colour never
 *      arrives.
 *   2. The disabled rule names no border at all, so the accent border stands.
 *   3. `theme-legibility.css` restores `opacity: 1` under the shipped acrylic
 *      skin, for a real reason — whole-control dimming pushed useful
 *      explanations and labels under the contrast floor.
 *
 * Each rule is defensible alone. The defect is what they COMPOSE to, which is
 * why this guard reads a real document instead of the stylesheets: a text
 * assertion over any one of the three would have found nothing wrong, and an
 * assertion over all three would have been asserting the route rather than the
 * destination. What is asserted here is what a screenshot would show.
 *
 * Cost boundary: one Vite dev server and one hidden Electron renderer against
 * the local visual fixture. No Agent Runtime, no app-server, no provider
 * request, and no window is ever shown.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AA_NORMAL_TEXT,
  compositeOver,
  contrastRatio,
  isLargeText,
  parseResolvedColor,
  roundTo,
} from "../harness/rendered-surface/contrast.ts";
import type { Rgba } from "../harness/rendered-surface/measure.ts";
import { startSurfaceServer } from "../harness/rendered-surface/measure.ts";
import {
  channelDistance,
  controlById,
  formatSample,
  measureDisabledAffordance,
  type AffordanceControl,
  type AffordanceMeasurement,
  type AffordanceReading,
  type AffordanceTone,
} from "../harness/rendered-surface/disabled-affordance.ts";
import {
  measureReducedMotionToneFlip,
  type ReducedMotionToneFlip,
} from "../harness/rendered-surface/reduced-motion-tone-flip.ts";

/**
 * The probe builds the product's own class lists, disabled and not, so a
 * reading can never be a paraphrase of the markup. `new-session` carries the
 * exact class list and the exact `kbd` child of the control F207 was about,
 * `primary` is the bare family, and `plain` is the control the acrylic
 * legibility block's premise is TRUE for — it is the in-run control every
 * number below is compared against rather than a remembered one.
 */
const PROBE_CONTROLS: readonly AffordanceControl[] = Object.freeze([
  { id: "primary-enabled", classes: "btn primary", label: "New Agent Session", disabled: false },
  { id: "primary-disabled", classes: "btn primary", label: "New Agent Session", disabled: true },
  {
    id: "new-session-enabled",
    classes: "btn primary new-session-button",
    label: "New Agent Session",
    kbd: "Ctrl N",
    disabled: false,
  },
  {
    id: "new-session-disabled",
    classes: "btn primary new-session-button",
    label: "New Agent Session",
    kbd: "Ctrl N",
    disabled: true,
  },
  { id: "plain-enabled", classes: "btn", label: "Open Project", disabled: false },
  { id: "plain-disabled", classes: "btn", label: "Open Project", disabled: true },
]);

const TONES: readonly AffordanceTone[] = Object.freeze(["dark", "light"]);

/**
 * The smallest per-channel composited difference this guard will accept as a
 * visible one.
 *
 * Eight, because the rendered-surface guard already pins THREE as the largest
 * distance two points on what is meant to be ONE painted surface may differ by
 * (`MAX_SEAM_DELTA`, itself pinned to a measured control). A difference that
 * has to survive being called a different surface must clear that floor with
 * room, and eight does. Before the repair every one of these deltas measured
 * exactly ZERO, so this constant is not what makes the guard fail — it is what
 * stops a one-channel cosmetic nudge from being called a repair.
 */
const MIN_VISIBLE_DELTA = 8;

/**
 * How many of the three independent composited channels — fill, border, glyph
 * — must carry the difference.
 *
 * Two, not three: the destination is "a human can tell", not a particular
 * route to it, and a future treatment that speaks through fill and border
 * without touching the ink is a legitimate answer. Two is still a real bar;
 * the shipped defect scored ZERO of three.
 */
const MIN_CHANGED_CHANNELS = 2;

/**
 * Two surfaces, one server.
 *
 * `project` is where the composer lives and is the surface every delta below
 * is measured on. `mounted` is measured for one reason: the blocked composer
 * is the one state the fixture can be put into that MOUNTS the real control
 * this defect is about — `class="btn primary new-session-button"`, `kbd` child
 * and all — so the probe's synthesized twin can be checked against the
 * product's own. Without it every number here would rest on the assumption
 * that a button assembled from the product's class list behaves like the
 * product's button, and F118 exists because that is the assumption nobody
 * should make.
 *
 * The fixture mounts it ENABLED: `replacementSessionRefusal` returns null
 * whenever the selection is valid, and no fixture scenario currently produces
 * a refusal. So this surface pins the probe's enabled twin, and nothing here
 * claims to have caught the product rendering a disabled one.
 */
const AFFORDANCE_SURFACES = Object.freeze({
  project: { query: "?project=default", readySelector: ".composer" },
  mounted: {
    query: "?scenario=terminal",
    readySelector: ".blocked-composer",
  },
} as const);

type AffordancePair = Readonly<{
  project: AffordanceMeasurement;
  mounted: AffordanceMeasurement;
  reducedMotion: ReducedMotionToneFlip;
}>;

let measurement: Promise<AffordancePair> | undefined;

function measureAffordance(): Promise<AffordancePair> {
  measurement ??= (async () => {
    const server = await startSurfaceServer();
    try {
      const project = await measureDisabledAffordance(server, {
        ...AFFORDANCE_SURFACES.project,
        tones: TONES,
        controls: PROBE_CONTROLS,
      });
      const mounted = await measureDisabledAffordance(server, {
        ...AFFORDANCE_SURFACES.mounted,
        tones: TONES,
        controls: PROBE_CONTROLS,
      });
      /* Third drive, same server, no captures: it costs an Electron start and
         a page load, not a measurement pass. See the F225 test for why the
         question it answers cannot be asked of the two above. */
      const reducedMotion = await measureReducedMotionToneFlip(server, {
        ...AFFORDANCE_SURFACES.mounted,
        probe: { classes: "btn primary", label: "New Agent Session" },
      });
      return { project, mounted, reducedMotion };
    } finally {
      await server.close();
    }
  })();
  return measurement;
}

type ChannelDeltas = Readonly<{
  fill: number;
  border: number;
  glyph: number;
  changed: readonly string[];
}>;

function deltasBetween(
  enabled: AffordanceReading,
  disabled: AffordanceReading,
): ChannelDeltas {
  const fill = channelDistance(enabled.painted.fill, disabled.painted.fill);
  const border = channelDistance(
    enabled.painted.border[0] ?? null,
    disabled.painted.border[0] ?? null,
  );
  const glyph = channelDistance(enabled.painted.paintedGlyph, disabled.painted.paintedGlyph);
  const changed = (
    [
      ["fill", fill],
      ["border", border],
      ["glyph", glyph],
    ] as const
  )
    .filter(([, delta]) => Number.isFinite(delta) && delta >= MIN_VISIBLE_DELTA)
    .map(([name]) => name);
  return { fill, border, glyph, changed };
}

/**
 * The label's contrast against the surface the label is actually painted on.
 *
 * Two models, the same pair the rendered-surface guard keeps: `analytic` is
 * the resolved `color` composited over the measured fill — the WCAG model —
 * and `painted` is the glyph pixel the compositor produced against the ground
 * beneath it. They are reported together and the WORSE of the two is the
 * number a claim rests on, so antialiasing cannot flatter a reading.
 */
function labelContrast(reading: AffordanceReading): Readonly<{
  analytic: number;
  painted: number | null;
  worst: number;
}> {
  const ground = reading.painted.labelGround ?? reading.painted.fill;
  assert.ok(
    ground !== null,
    `${reading.id}: no glyph-free ground pixel was recovered for the label`,
  );
  const groundRgba: Rgba = { ...ground, alpha: 255 };
  const resolved = parseResolvedColor(reading.color);
  const opacity = Number.parseFloat(reading.opacity);
  const inheritedAlpha = resolved.alpha * (Number.isFinite(opacity) ? opacity : 1);
  const analytic = contrastRatio(
    compositeOver({ ...resolved, alpha: inheritedAlpha }, groundRgba),
    groundRgba,
  );
  const glyph = reading.painted.paintedGlyph;
  const painted =
    glyph === null ? null : contrastRatio({ ...glyph, alpha: 255 }, groundRgba);
  return {
    analytic,
    painted,
    worst: painted === null ? analytic : Math.min(analytic, painted),
  };
}

function reportControl(tone: AffordanceTone, reading: AffordanceReading): string {
  return JSON.stringify({
    tone,
    id: reading.id,
    classes: reading.classes,
    disabled: reading.disabled,
    color: reading.color,
    backgroundColor: reading.backgroundColor,
    borderTopColor: reading.borderTopColor,
    opacity: reading.opacity,
    cursor: reading.cursor,
    /* Reported so the AA threshold the contrast observation applies is a
       measured consequence rather than a choice: 12.5px at weight 550 is not
       large text, so 4.5:1 is the floor and 3:1 never applies here. */
    fontSizePx: reading.fontSizePx,
    fontWeight: reading.fontWeight,
    isLargeText: isLargeText(reading.fontSizePx, reading.fontWeight),
    paintedFill: formatSample(reading.painted.fill),
    paintedBorder: formatSample(reading.painted.border[0] ?? null),
    paintedGlyph: formatSample(reading.painted.paintedGlyph),
    inkedPixels: reading.painted.inkedPixels,
  });
}

test("F215 a disabled primary button is distinguishable from a live one without a pointer", async () => {
  const { project: affordance } = await measureAffordance();

  /* The reading only means anything under the skin the product ships. */
  assert.equal(affordance.rootDataset.skin, "acrylic");
  assert.equal(affordance.rootDataset.glass, "full");

  const indistinguishable: {
    tone: AffordanceTone;
    family: string;
    enabled: AffordanceReading;
    disabled: AffordanceReading;
    deltas: ChannelDeltas;
  }[] = [];

  for (const tone of affordance.tones) {
    for (const reading of tone.controls) {
      process.stdout.write(`F215_CONTROL ${reportControl(tone.tone, reading)}\n`);
      assert.ok(
        reading.painted.inkedPixels > 0,
        `${tone.tone} ${reading.id}: the label left no mark at all, so no reading below is about a visible string`,
      );
    }

    for (const family of ["primary", "new-session"] as const) {
      const enabled = controlById(tone, `${family}-enabled`);
      const disabled = controlById(tone, `${family}-disabled`);
      assert.equal(disabled.disabled, true, `${tone.tone} ${family}: the probe control is not disabled`);

      const deltas = deltasBetween(enabled, disabled);
      process.stdout.write(
        `F215_DELTA ${JSON.stringify({ tone: tone.tone, family, ...deltas })}\n`,
      );

      /* Stated as its own assertion so a failure names the actual defect
         rather than a number: the cursor was the whole of the difference. */
      assert.notEqual(
        enabled.cursor,
        disabled.cursor,
        `${tone.tone} ${family}: the disabled control does not even change the cursor`,
      );
      /* Collected rather than asserted in place, so a red run reports EVERY
         tone and family. Failing at the first would have hidden light behind
         dark, and half the evidence is not evidence of half a defect. */
      indistinguishable.push({ tone: tone.tone, family, enabled, disabled, deltas });
    }
  }

  assert.deepEqual(
    indistinguishable
      .filter((entry) => entry.deltas.changed.length < MIN_CHANGED_CHANNELS)
      .map(
        (entry) =>
          `${entry.tone} ${entry.family}: fill ${entry.deltas.fill}, border ` +
          `${entry.deltas.border}, glyph ${entry.deltas.glyph} — ` +
          `${entry.deltas.changed.length} of 3 channels clear ${MIN_VISIBLE_DELTA}; ` +
          `cursor (${entry.enabled.cursor} vs ${entry.disabled.cursor}) is the rest of ` +
          `the difference, and a cursor does not exist on a touch device or in a screenshot`,
      ),
    [],
    "a disabled primary button is not distinguishable from a live one without a pointer",
  );
});

test("F215 the disabled primary keeps a legible label in both tones", async () => {
  const { project: affordance } = await measureAffordance();

  const belowFloor: string[] = [];

  for (const tone of affordance.tones) {
    /* The product's own already-shipped disabled treatment, measured in this
       same run rather than remembered, is the floor the new one must clear.
       Comparing against a number written down earlier would let the floor
       drift silently underneath the comparison. */
    const plainDisabled = labelContrast(controlById(tone, "plain-disabled"));
    /* And the reading the correction replaced, measured in the same run: the
       enabled ink is what a disabled primary used to be painted with, so the
       cost of the repair is a subtraction this guard can actually perform
       rather than a claim the report has to be trusted on. */
    const leaked = labelContrast(controlById(tone, "primary-enabled"));

    for (const family of ["primary", "new-session"] as const) {
      const disabled = controlById(tone, `${family}-disabled`);
      const reading = labelContrast(disabled);
      /* The threshold below is 4.5 because the engine says this is normal
         text, not because 4.5 was chosen. A future larger button label would
         legitimately fall to 3:1, and this is where that would surface. */
      assert.equal(
        isLargeText(disabled.fontSizePx, disabled.fontWeight),
        false,
        `${tone.tone} ${family}: the label is large text, so AA_NORMAL_TEXT is the wrong floor to be holding it to`,
      );
      process.stdout.write(
        `F215_CONTRAST ${JSON.stringify({
          tone: tone.tone,
          family,
          resolvedColor: disabled.color,
          ground: formatSample(disabled.painted.labelGround ?? disabled.painted.fill),
          analytic: roundTo(reading.analytic, 2),
          painted: reading.painted === null ? null : roundTo(reading.painted, 2),
          worst: roundTo(reading.worst, 2),
          aaFloor: AA_NORMAL_TEXT,
          plainDisabledWorst: roundTo(plainDisabled.worst, 2),
          replacedWorst: roundTo(leaked.worst, 2),
        })}\n`,
      );

      if (reading.worst < AA_NORMAL_TEXT) {
        belowFloor.push(
          `${tone.tone} ${family}: ${roundTo(reading.worst, 2)}:1 against its own painted ` +
            `surface, under the ${AA_NORMAL_TEXT}:1 AA floor. Making a control visibly ` +
            `unavailable may not be paid for by making its label unreadable — that is the ` +
            `exact trade theme-legibility.css exists to refuse`,
        );
      }
      if (reading.worst < plainDisabled.worst - 0.01) {
        belowFloor.push(
          `${tone.tone} ${family}: ${roundTo(reading.worst, 2)}:1, below the ` +
            `${roundTo(plainDisabled.worst, 2)}:1 the product's own plain disabled button ` +
            `reads in the same run. A new disabled treatment may not be dimmer than the one ` +
            `already shipped beside it`,
        );
      }
    }
  }

  assert.deepEqual(belowFloor, [], "the disabled primary label fell below a measured floor");
});

test("F215 the correction reaches every primary button and leaves the acrylic legibility block intact", async () => {
  const [legibility, composer, stage, states, affordance] = await Promise.all([
    readFile(
      new URL(
        "../../src/workbench-shell/renderer/themes/theme-legibility.css",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../../src/workbench-shell/renderer/composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/workbench-shell/renderer/stage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/workbench-shell/renderer/states.tsx", import.meta.url), "utf8"),
    measureAffordance(),
  ]);

  /* Every primary button the renderer can mount, and whether it can ever be
     shown disabled. The count is an observation, not a ceiling: a new one is
     reached by the class-scoped correction below without touching this list,
     and this assertion exists so a reader knows how many sites the claim is
     about rather than assuming it is about the one F207 named. */
  const sites = [
    ["composer.tsx", composer],
    ["stage.tsx", stage],
    ["states.tsx", states],
  ] as const;
  const primaryButtons: { file: string; disableable: boolean }[] = [];
  for (const [file, source] of sites) {
    for (const match of source.matchAll(/<button\b[\s\S]*?>/gu)) {
      const tag = match[0];
      if (!/class="btn primary(?:[ "])/u.test(tag)) continue;
      primaryButtons.push({ file, disableable: /\bdisabled=\{/u.test(tag) });
    }
  }
  process.stdout.write(`F215_PRIMARY_SITES ${JSON.stringify(primaryButtons)}\n`);
  assert.equal(
    primaryButtons.length,
    4,
    "the renderer's primary-button inventory moved; re-measure before trusting the coverage claim",
  );
  assert.equal(primaryButtons.filter((button) => button.disableable).length, 3);

  /* The correction is class-scoped, so it reaches all three disableable sites
     and any future one, rather than the single control F207 named. */
  assert.match(
    legibility,
    /:root\[data-skin~="acrylic"\] \.btn\.primary\[disabled\]\s*\{/u,
    "the disabled-primary correction is not class-scoped, so a new primary button would ship with F215",
  );
  assert.doesNotMatch(
    legibility,
    /\.new-session-button\[disabled\]/u,
    "F215 was corrected at one site instead of for the family",
  );

  /* The nine selectors the acrylic restoration is written for are still
     restored, and still in ONE rule. Undoing that block is the other way to
     make a disabled primary visible, and it is the way this repair must not
     have taken: it would hand the contrast problem back for eight controls
     that never had F215. */
  const acrylicRestoration =
    /(:root\[data-skin~="acrylic"\] \.project-row\[disabled\],[\s\S]*?)\{\s*opacity:\s*1;\s*\}/u.exec(
      legibility,
    );
  assert.ok(acrylicRestoration !== null, "the acrylic opacity restoration block is gone");
  for (const selector of [
    ".project-row[disabled]",
    ".rail-action[disabled]",
    ".btn[disabled]",
    ".chip[disabled]",
    ".input-shell.is-disabled",
    ".proj-toggle[disabled]",
    ".session-row[disabled]",
    ".picker-list .opt:disabled",
    ".endpoint-status-option.is-disabled",
  ]) {
    assert.ok(
      (acrylicRestoration[1] ?? "").includes(selector),
      `${selector} left the acrylic opacity restoration; the other eight controls are not this repair's to change`,
    );
  }

  /* Whole-control dimming is what that block refuses, so the correction may
     not smuggle it back in for the primary family either. */
  const correction =
    /:root\[data-skin~="acrylic"\] \.btn\.primary\[disabled\]\s*\{([^}]*)\}/u.exec(legibility);
  assert.ok(correction !== null);
  assert.doesNotMatch(
    correction[1] ?? "",
    /opacity|filter/u,
    "the disabled-primary correction reintroduces whole-control dimming, which is the trade theme-legibility.css exists to refuse",
  );

  /* The probe is not the only witness. A `.btn.primary` the PRODUCT mounted
     resolves to exactly what the probe's enabled twin resolves to, in both
     tones — so the deltas above are about the product's button and not about a
     lookalike the test built for itself. */
  for (const tone of affordance.mounted.tones) {
    process.stdout.write(
      `F215_MOUNTED_PRIMARY ${JSON.stringify({
        tone: tone.tone,
        buttons: tone.mountedPrimaryButtons,
      })}\n`,
    );
    assert.ok(
      tone.mountedPrimaryButtons.length > 0,
      `${tone.tone}: the mounted surface rendered no .btn.primary, so the probe has nothing to be checked against`,
    );
    const probe = controlById(tone, "primary-enabled");
    for (const mounted of tone.mountedPrimaryButtons) {
      assert.deepEqual(
        {
          disabled: mounted.disabled,
          color: mounted.color,
          backgroundColor: mounted.backgroundColor,
          borderTopColor: mounted.borderTopColor,
          opacity: mounted.opacity,
          cursor: mounted.cursor,
        },
        {
          disabled: probe.disabled,
          color: probe.color,
          backgroundColor: probe.backgroundColor,
          borderTopColor: probe.borderTopColor,
          opacity: probe.opacity,
          cursor: probe.cursor,
        },
        `${tone.tone}: the probe's primary button does not resolve to what the mounted one resolves to`,
      );
    }
  }
});

/*
 * F225 — a reader who asks for LESS motion must not be given more of it.
 *
 * The test above is the one that found this, and it found it the hard way: on
 * a hosted runner it goes red because the mounted `.btn.primary` reports the
 * PREVIOUS tone's colours in `oklab()` while the probe, built after the flip,
 * reports the new tone's. Both readings are correct. What is wrong is that a
 * transition was running at all.
 *
 * `styles.css` carried the widely copied reduced-motion snippet:
 *
 *     @media (prefers-reduced-motion: reduce) {
 *       *, *::before, *::after { transition-duration: 0.01ms !important; }
 *     }
 *
 * `animation-duration` in that same block is harmless, because
 * `animation-name` is `none` until an author names one — shortening a
 * duration can only shorten an animation that already exists.
 * `transition-duration` does not have that shape: `transition-property` is
 * `all` by default, so a universal `transition-duration` does not shorten
 * declared transitions, it CREATES one for every animatable property of every
 * element. This product declares exactly one transition; under reduced motion
 * it was running hundreds.
 *
 * They are 0.01ms long, so nothing is visible and no capture-based guard in
 * this repository could ever see them. But a transition still begins at
 * progress 0 and still advances only when the animation timeline ticks, and
 * `getComputedStyle` forces a style recalculation without ticking it. So in
 * the window between an attribute flip on `:root` and the next frame, every
 * already-mounted element reports its OLD value, serialized in the
 * interpolation space. Whether a frame lands in that window is a race, which
 * is why the same commit passed twice and failed once.
 *
 * This guard removes the race instead of inheriting it. The driver pins
 * `prefers-reduced-motion: reduce` rather than hoping the host has it, reports
 * whether the media feature actually matched so a broken switch cannot turn
 * the guard into a no-op, and performs the flip and the reads in ONE
 * synchronous task so no frame can tick between them. A transition that is
 * started is therefore always caught here, on every machine.
 */
test("F225 under reduced motion a tone flip starts no transition, and the mounted primary is not left reporting the previous tone", async () => {
  const { reducedMotion } = await measureAffordance();

  const startedProperties = [
    ...new Set(reducedMotion.startedByFlip.map((transition) => transition.property)),
  ].sort();

  process.stdout.write(
    `F225_TONE_FLIP ${JSON.stringify({
      reducedMotionMatches: reducedMotion.reducedMotionMatches,
      baselineAnimations: reducedMotion.baselineAnimations.length,
      startedByFlip: reducedMotion.startedByFlip.length,
      startedProperties,
      onMountedPrimary: reducedMotion.onMountedPrimary.map(
        (transition) => transition.property,
      ),
      mounted: reducedMotion.mounted,
      probe: reducedMotion.probe,
    })}\n`,
  );

  /* Without this the whole test is a no-op that always passes: the defect only
     exists while the media feature matches. */
  assert.equal(
    reducedMotion.reducedMotionMatches,
    true,
    "the driver did not actually put the renderer into reduced motion, so this guard proves nothing",
  );
  assert.equal(
    reducedMotion.rootDataset.skin,
    "acrylic",
    "the shipped skin is not the one under measurement",
  );

  /* What the flip started, by object identity against a baseline taken in the
     same synchronous task. The fixture's own declared animations and anything
     it still had in flight are therefore not this assertion's business, and a
     busy surface can neither hide a finding nor manufacture one. */
  assert.deepEqual(
    startedProperties,
    [],
    "changing the tone started transitions under reduced motion; a reader who asked for less " +
      "motion is being given a document where every animatable property interpolates",
  );
  /* And the control this defect is about carries none, whether the flip
     started it or retargeted one that was already running. */
  assert.deepEqual(
    reducedMotion.onMountedPrimary,
    [],
    "a transition is running on the mounted primary after the tone flip, so what " +
      "getComputedStyle reports for it is an interpolation and not the tone it is in",
  );

  /* The symptom the transitions produce, stated as the thing a reader would
     see: the control the product mounted must resolve to what the same class
     list resolves to when it is built fresh in the same tone. */
  assert.ok(
    reducedMotion.mounted.length > 0,
    "the mounted surface rendered no .btn.primary, so the probe has nothing to be checked against",
  );
  for (const mounted of reducedMotion.mounted) {
    assert.deepEqual(
      {
        color: mounted.color,
        backgroundColor: mounted.backgroundColor,
        borderTopColor: mounted.borderTopColor,
      },
      {
        color: reducedMotion.probe.color,
        backgroundColor: reducedMotion.probe.backgroundColor,
        borderTopColor: reducedMotion.probe.borderTopColor,
      },
      "under reduced motion the mounted primary is still reporting the tone it was in before " +
        "the flip, because a transition it should never have had is holding it at progress 0",
    );
  }
});
