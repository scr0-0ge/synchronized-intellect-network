import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { AA_NORMAL_TEXT, judgeText } from "../harness/rendered-surface/contrast.ts";
import { measureSurface, startSurfaceServer } from "../harness/rendered-surface/measure.ts";

// Drive the Session's own trash button, not the Project removal button. The
// fixture mounts the real dialog and stylesheets in a hidden, isolated Electron
// renderer; opening the confirmation neither deletes a Session nor calls a provider.
const SESSION_TRIGGER = '.session-removal-trigger[aria-label="Delete Agent Session 01"]';
const EXPECTED_TEXT = [
  "Confirm removal",
  "Delete Agent Session?",
  "Delete Agent Session 01 and its recorded conversation? This cannot be undone.",
  "Cancel",
  "Delete Session",
];

let server: Awaited<ReturnType<typeof startSurfaceServer>>;
before(async () => { server = await startSurfaceServer(); });
after(async () => { await server?.close(); });

for (const tone of ["dark", "light"] as const) {
  for (const transparency of ["no-preference", "reduce"] as const) {
    test(`W6 direct Session deletion clears 4.5:1 in ${tone}, transparency ${transparency}`, {
      timeout: 120_000,
    }, async () => {
      const surface = await measureSurface(server, {
        surfaceId: `w6-session-removal-${tone}-${transparency}`,
        query: "?surface=settings&material=on",
        readySelector: ".settings",
        steps: [
          ...(tone === "light" ? [{
            click: ".appearance-option",
            within: '[aria-labelledby="appearance-tone-label"]',
            text: "Light",
            settleSelector: 'html[data-tone="light"]',
          }] : []),
          { click: ".settings-rail-button", settleSelector: SESSION_TRIGGER },
          { click: SESSION_TRIGGER, settleSelector: '.removal-dialog[role="alertdialog"]' },
        ],
        settleMs: 200,
        viewport: { width: 1280, height: 820 },
        windowBackground: "#000000",
        emulatedMediaFeatures: [{
          name: "prefers-reduced-transparency",
          value: transparency,
        }],
      });

      // Read both settings back: four successful measurements of the same
      // configuration would not cover the Windows transparency-off regression.
      assert.equal(surface.root.skin, "acrylic");
      assert.equal(surface.root.tone, tone === "light" ? "light" : null);
      assert.equal(surface.mediaEnvironment.reducedTransparency, transparency);

      const visible = surface.texts.filter((text) => text.occludedBy === null);
      assert.deepEqual(visible.map((text) => text.text), EXPECTED_TEXT,
        "measure every dialog string, including the Session-specific warning and destructive action");
      const verdicts = visible.map(judgeText);
      process.stdout.write(`W6_SESSION_CONTRAST ${JSON.stringify({
        tone,
        transparency,
        texts: verdicts.map((verdict) => ({
          text: verdict.text,
          resolvedColor: verdict.resolvedColor,
          background: verdict.analytic.background,
          analytic: verdict.analytic.ratio,
          painted: verdict.painted?.ratio ?? null,
          ratio: verdict.ratio,
          modelsDisagree: verdict.modelsDisagree,
        })),
      })}\n`);

      for (const verdict of verdicts) {
        assert.ok(verdict.inkedPixels > 0, `${verdict.text}: no painted glyphs measured`);
        assert.equal(verdict.hasNonDeterministicBackground, false,
          `${verdict.text}: the measured dialog ground must be opaque`);
      }
      assert.deepEqual(
        verdicts.filter((verdict) => verdict.ratio < AA_NORMAL_TEXT).map((verdict) => ({
          text: verdict.text,
          ratio: verdict.ratio,
          resolvedColor: verdict.resolvedColor,
        })),
        [],
        `${tone}, transparency ${transparency}: every Session deletion string must clear ${AA_NORMAL_TEXT}:1`,
      );
    });
  }
}
