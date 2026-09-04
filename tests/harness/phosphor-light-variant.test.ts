import assert from "node:assert/strict";
import test, { after } from "node:test";

import { judgeText } from "./rendered-surface/contrast.ts";
import {
  measureSurface,
  startSurfaceServer,
  type MeasuredSurface,
} from "./rendered-surface/measure.ts";
import { PHOSPHOR_SURFACES } from "./rendered-surface/surfaces.ts";

type Tier = "a" | "b" | "c";
type Tone = "dark" | "light";
type Crt = "normal" | "fullscreen";
type Phosphor = "green" | "amber";

type SurfaceIdentity = Readonly<{
  tier: Tier;
  tone: Tone;
  crt: Crt;
  phosphor: Phosphor;
}>;

type Profile = Readonly<{
  color: string;
  glow: string;
  paintedGlyph: Readonly<{
    red: number;
    green: number;
    blue: number;
    alpha: number;
  }>;
}>;

const darkProfiles: Readonly<Record<Phosphor, Profile>> = Object.freeze({
  green: profile("rgb(141, 255, 180)", "rgba(80, 255, 150, 0.55)", 141, 255, 180),
  amber: profile("rgb(255, 196, 107)", "rgba(255, 176, 60, 0.55)", 255, 196, 107),
});

const lightProfiles: Readonly<Record<Tier, Readonly<Record<Phosphor, Profile>>>> =
  Object.freeze({
    a: Object.freeze({
      green: profile("rgb(8, 113, 63)", "rgba(0, 190, 82, 0.4)", 8, 113, 63),
      amber: profile("rgb(163, 70, 0)", "rgba(235, 90, 12, 0.38)", 163, 70, 0),
    }),
    b: Object.freeze({
      green: profile("rgb(0, 114, 54)", "rgba(0, 255, 105, 0.52)", 0, 114, 54),
      amber: profile("rgb(178, 58, 0)", "rgba(255, 104, 24, 0.5)", 178, 58, 0),
    }),
    c: Object.freeze({
      green: profile("rgb(0, 111, 53)", "rgba(0, 255, 105, 0.68)", 0, 111, 53),
      amber: profile("rgb(180, 59, 0)", "rgba(255, 92, 12, 0.64)", 180, 59, 0),
    }),
  });

let measurement: Promise<readonly MeasuredSurface[]> | undefined;
let contrastMeasurement: Promise<readonly MeasuredSurface[]> | undefined;

function measurePhosphorMatrix(): Promise<readonly MeasuredSurface[]> {
  measurement ??= (async () => {
    const server = await startSurfaceServer();
    try {
      const surfaces: MeasuredSurface[] = [];
      for (const request of PHOSPHOR_SURFACES) {
        surfaces.push(await measureSurface(server, request));
      }
      return surfaces;
    } finally {
      await server.close();
    }
  })();
  return measurement;
}

function measureLightContrastMatrix(): Promise<readonly MeasuredSurface[]> {
  contrastMeasurement ??= (async () => {
    await measurePhosphorMatrix();
    const server = await startSurfaceServer();
    try {
      const surfaces: MeasuredSurface[] = [];
      for (const request of PHOSPHOR_SURFACES.filter((candidate) =>
        candidate.surfaceId.includes("-light-"),
      )) {
        surfaces.push(
          await measureSurface(server, {
            ...request,
            preserveTextShadow: false,
          }),
        );
      }
      return surfaces;
    } finally {
      await server.close();
    }
  })();
  return contrastMeasurement;
}

after(async () => {
  if (measurement !== undefined) await measurement.catch(() => undefined);
  if (contrastMeasurement !== undefined) {
    await contrastMeasurement.catch(() => undefined);
  }
});

test("F177 reaches every A/B/C × tone × normal/fullscreen × Green/Amber product state", async () => {
  const surfaces = await measurePhosphorMatrix();
  assert.equal(surfaces.length, 24);
  assert.deepEqual(
    surfaces.map((surface) => ({ id: surface.surfaceId, root: surface.root })),
    (["a", "b", "c"] as const).flatMap((tier) =>
      (["dark", "light"] as const).flatMap((tone) =>
        (["normal", "fullscreen"] as const).flatMap((crt) =>
          (["green", "amber"] as const).map((phosphor) =>
            root({ tier, tone, crt, phosphor }),
          ),
        ),
      ),
    ),
  );
});

test("the praised dark Phosphor computed and painted render is invariant across A/B/C", async () => {
  const surfaces = (await measurePhosphorMatrix()).filter((surface) =>
    surface.surfaceId.includes("-dark-"),
  );
  for (const surface of surfaces) {
    const identity = parseIdentity(surface.surfaceId);
    assert.deepEqual(
      modelFact(surface),
      expectedFact(surface.surfaceId, identity, darkProfiles[identity.phosphor]),
    );
  }

  for (const crt of ["normal", "fullscreen"] as const) {
    for (const phosphor of ["green", "amber"] as const) {
      const facts = (["a", "b", "c"] as const).map((tier) => {
        const surface = requireSurface(surfaces, { tier, tone: "dark", crt, phosphor });
        const { surfaceId: _surfaceId, ...render } = modelFact(surface);
        return render;
      });
      assert.deepEqual(
        facts,
        [facts[0], facts[0], facts[0]],
        `${crt}/${phosphor}: tier changed dark rendering`,
      );
    }
  }
});

test("A/B/C light tiers expose their recorded computed ink, glow, and compositor-painted glyphs", async () => {
  const surfaces = (await measurePhosphorMatrix()).filter((surface) =>
    surface.surfaceId.includes("-light-"),
  );
  assert.equal(surfaces.length, 12);
  for (const surface of surfaces) {
    const identity = parseIdentity(surface.surfaceId);
    assert.deepEqual(
      modelFact(surface),
      expectedFact(
        surface.surfaceId,
        identity,
        lightProfiles[identity.tier][identity.phosphor],
      ),
    );
  }
});

test("the AA floor remains 4.5 and the exact profiles expose their Full-CRT exception instead of weakening it", async () => {
  const surfaces = await measureLightContrastMatrix();
  assert.equal(surfaces.length, 12, "light contrast matrix lost A/B/C × CRT × Phosphor coverage");
  for (const surface of surfaces) {
    const identity = parseIdentity(surface.surfaceId);
    const verdict = judgeText(requireModel(surface));
    assert.equal(verdict.threshold, 4.5, `${surface.surfaceId}: AA threshold drifted`);
    assert.ok(verdict.painted, `${surface.surfaceId}: no painted contrast reading`);
    if (identity.crt === "normal") {
      assert.ok(
        verdict.analytic.ratio >= verdict.threshold &&
          verdict.painted.ratio >= verdict.threshold,
        `${surface.surfaceId}: representative clean-state model fell below AA in one reading model`,
      );
    } else {
      assert.ok(
        verdict.analytic.ratio < verdict.threshold &&
          verdict.painted.ratio < verdict.threshold,
        `${surface.surfaceId}: remove the documented owner exception after both reading models genuinely reach AA`,
      );
    }
  }
});

function profile(
  color: string,
  glow: string,
  red: number,
  green: number,
  blue: number,
): Profile {
  return Object.freeze({
    color,
    glow,
    paintedGlyph: Object.freeze({ red, green, blue, alpha: 255 }),
  });
}

function expectedFact(
  surfaceId: string,
  identity: SurfaceIdentity,
  expected: Profile,
): ReturnType<typeof modelFact> {
  return Object.freeze({
    surfaceId,
    color: expected.color,
    textShadow:
      identity.crt === "fullscreen"
        ? `${expected.glow} 0px 0px 1px, ${expected.glow} 0px 0px 6px`
        : `${expected.glow} 0px 0px 2px`,
    paintedGlyph: expected.paintedGlyph,
  });
}

function modelFact(surface: MeasuredSurface): Readonly<{
  surfaceId: string;
  color: string;
  textShadow: string | null;
  paintedGlyph: Readonly<{ red: number; green: number; blue: number; alpha: number }>;
}> {
  const model = requireModel(surface);
  const paintedGlyph = model.boxes.find((box) => box.paintedGlyph !== null)?.paintedGlyph;
  assert.ok(paintedGlyph, `${surface.surfaceId}: model label left no painted glyph`);
  return Object.freeze({
    surfaceId: surface.surfaceId,
    color: model.color,
    textShadow: model.textShadow,
    paintedGlyph,
  });
}

function requireModel(surface: MeasuredSurface): MeasuredSurface["texts"][number] {
  const model = surface.texts.find((text) => text.signature.includes("sr-model"));
  assert.ok(model, `${surface.surfaceId}: model label was not rendered`);
  return model;
}

function root(identity: SurfaceIdentity): Readonly<Record<string, unknown>> {
  const { tier, tone, crt, phosphor } = identity;
  const id = `phosphor-tier-${tier}-${tone}-${crt}-${phosphor}`;
  return Object.freeze({
    id,
    root: Object.freeze({
      skin: "acrylic",
      glass: "full",
      tone: tone === "light" ? "light" : null,
      crt: crt === "fullscreen" ? "full" : null,
      phosphor,
      phosphorTier: tier,
      material: null,
    }),
  });
}

function parseIdentity(surfaceId: string): SurfaceIdentity {
  const match = /^phosphor-tier-(a|b|c)-(dark|light)-(normal|fullscreen)-(green|amber)$/u.exec(
    surfaceId,
  );
  assert.ok(match, `${surfaceId}: invalid Phosphor surface identity`);
  return Object.freeze({
    tier: match[1] as Tier,
    tone: match[2] as Tone,
    crt: match[3] as Crt,
    phosphor: match[4] as Phosphor,
  });
}

function requireSurface(
  surfaces: readonly MeasuredSurface[],
  identity: SurfaceIdentity,
): MeasuredSurface {
  const id = `phosphor-tier-${identity.tier}-${identity.tone}-${identity.crt}-${identity.phosphor}`;
  const surface = surfaces.find((candidate) => candidate.surfaceId === id);
  assert.ok(surface, `${id}: missing measured surface`);
  return surface;
}
