/*
 * WCAG arithmetic over MEASURED colour.
 *
 * The inputs here are not authored token text. The background of every reading
 * is a pixel the compositor produced, and the foreground is the colour the
 * engine resolved after `var()`, `color-mix()`, `currentcolor` and the whole
 * cascade — so a wrong value is visible to this module even when product and
 * design corpus agree on the wrong value, which is the case source comparison
 * cannot reach (F118).
 */
import type { MeasuredText, MeasuredTextBox, Rgba } from "./measure.ts";

/** WCAG 2.2 AA, 1.4.3. Non-large text has no exemption at these sizes. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;

export type Reading = Readonly<{
  ratio: number;
  foreground: Rgba;
  background: Rgba;
  backgroundIsDeterministic: boolean;
  box: MeasuredTextBox;
}>;

export type TextVerdict = Readonly<{
  signature: string;
  occludedBy: string | null;
  text: string;
  colorSource: string | null;
  resolvedColor: string;
  fontSizePx: number;
  fontWeight: string;
  threshold: number;
  inheritedOpacity: number;
  inkedPixels: number;
  /** Resolved `color` composited over the measured surface. The WCAG model. */
  analytic: Reading;
  /** The painted glyph pixel against the measured surface. The empirical model. */
  painted: Reading | null;
  /** The kinder of the two, and therefore the number a failure claim rests on. */
  ratio: number;
  passes: boolean;
  /** One model passes and the other does not: reported, never silently resolved. */
  modelsDisagree: boolean;
  hasNonDeterministicBackground: boolean;
}>;

export function isLargeText(fontSizePx: number, fontWeight: string): boolean {
  const weight = Number.parseInt(fontWeight, 10);
  if (fontSizePx >= 24) return true;
  return fontSizePx >= 18.66 && Number.isFinite(weight) && weight >= 700;
}

export function thresholdFor(fontSizePx: number, fontWeight: string): number {
  return isLargeText(fontSizePx, fontWeight) ? AA_LARGE_TEXT : AA_NORMAL_TEXT;
}

/**
 * Chromium reports `rgb()`/`rgba()` for plain colours and `color(srgb …)` once
 * a value has passed through `color-mix()`. Both forms carry the same measured
 * colour and both must parse, or every `color-mix()` site would silently drop
 * out of the sweep.
 */
export function parseResolvedColor(value: string): Rgba {
  const functional = /^rgba?\(([^)]+)\)$/u.exec(value.trim());
  if (functional !== null) {
    const parts = (functional[1] ?? "").split(/[,/\s]+/u).filter((part) => part !== "");
    const [red, green, blue, alpha] = parts.map((part) =>
      part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part),
    );
    return {
      red: requireFinite(red, value),
      green: requireFinite(green, value),
      blue: requireFinite(blue, value),
      alpha: alpha === undefined ? 1 : requireFinite(alpha, value),
    };
  }

  const srgb = /^color\(srgb\s+([^)]+)\)$/u.exec(value.trim());
  if (srgb !== null) {
    const [channels, alphaPart] = (srgb[1] ?? "").split("/");
    const parts = (channels ?? "").trim().split(/\s+/u).map(Number.parseFloat);
    const [red, green, blue] = parts;
    const alpha = alphaPart === undefined ? 1 : Number.parseFloat(alphaPart.trim());
    return {
      red: requireFinite(red, value) * 255,
      green: requireFinite(green, value) * 255,
      blue: requireFinite(blue, value) * 255,
      alpha: requireFinite(alpha, value),
    };
  }

  throw new Error(`unparsable resolved colour: ${value}`);
}

function requireFinite(value: number | undefined, source: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`unparsable resolved colour: ${source}`);
  }
  return value;
}

export function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.alpha;
  return {
    red: foreground.red * alpha + background.red * (1 - alpha),
    green: foreground.green * alpha + background.green * (1 - alpha),
    blue: foreground.blue * alpha + background.blue * (1 - alpha),
    alpha: 1,
  };
}

export function relativeLuminance(color: Rgba): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map((channel) => {
    const normalized = Math.min(255, Math.max(0, channel)) / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(left: Rgba, right: Rgba): number {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort(
    (a, b) => b - a,
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * One verdict per measured string, from two independent models of the same
 * rendered fact.
 *
 * ANALYTIC — the resolved `color` composited over the measured surface. This is
 * what every accessibility tool computes, except that the surface here was read
 * out of the compositor instead of assumed.
 *
 * PAINTED — the colour the compositor actually put on screen at the
 * best-covered glyph pixel, against the same measured surface.
 *
 * They differ for a measurable reason. This product paints decorative CRT
 * layers ABOVE the text: a vignette and scan layer over the whole viewport, and
 * a sheen over the stage. Those layers are in the measured surface, and they
 * are also over the glyph — so the analytic model, which puts the glyph on top
 * of them, is wrong wherever they are opaque enough to matter. Measured on this
 * corpus, the default `crt="screen"` shifts a measured surface by as much as 94
 * levels per channel against `crt="off"`.
 *
 * The painted model has its own bound: at 10px no pixel need reach full glyph
 * coverage, so its reading is a floor rather than the exact glyph colour.
 *
 * Each model is therefore biased toward reporting failure, in different
 * situations. A string is called a failure only when BOTH models fail — the
 * defect then holds under either reading. Where they disagree the string is
 * reported as disagreeing rather than resolved by preferring whichever answer
 * is convenient.
 *
 * Worst-case is the reduction within each model: text crossing a gradient or a
 * pane edge must be legible everywhere it is painted, and an area-weighted mean
 * would let a large legible region hide a small illegible one — which is the
 * exact shape of defect this harness exists to find.
 */
export function judgeText(text: MeasuredText): TextVerdict {
  const resolved = parseResolvedColor(text.color);
  const effective: Rgba = { ...resolved, alpha: resolved.alpha * text.inheritedOpacity };
  const threshold = thresholdFor(text.fontSizePx, text.fontWeight);

  const analyticReadings: Reading[] = [];
  const paintedReadings: Reading[] = [];
  let nonDeterministic = false;

  for (const box of text.boxes) {
    for (const sample of box.backgroundSamples) {
      const background: Rgba = {
        red: sample.red,
        green: sample.green,
        blue: sample.blue,
        alpha: sample.alpha / 255,
      };
      /* Alpha below full means the window is see-through at that pixel and the
         real backdrop is whatever the desktop is showing. Determinism is a
         measured property here, not a claim. */
      const deterministic = sample.alpha === 255;
      if (!deterministic) nonDeterministic = true;

      const composited = compositeOver(effective, background);
      analyticReadings.push({
        ratio: roundTo(contrastRatio(composited, background), 3),
        foreground: composited,
        background,
        backgroundIsDeterministic: deterministic,
        box,
      });

      if (box.paintedGlyph !== null) {
        paintedReadings.push({
          ratio: roundTo(contrastRatio(box.paintedGlyph, background), 3),
          foreground: box.paintedGlyph,
          background,
          backgroundIsDeterministic: deterministic,
          box,
        });
      }
    }
  }
  if (analyticReadings.length === 0) {
    throw new Error(`no background readings for ${text.signature}`);
  }

  const analytic = worstOf(analyticReadings);
  const painted = paintedReadings.length === 0 ? null : worstOf(paintedReadings);
  const analyticPasses = analytic.ratio >= threshold;
  const paintedPasses = painted === null ? analyticPasses : painted.ratio >= threshold;

  return {
    signature: text.signature,
    occludedBy: text.occludedBy,
    text: text.text,
    colorSource: text.colorSource,
    resolvedColor: text.color,
    fontSizePx: text.fontSizePx,
    fontWeight: text.fontWeight,
    threshold,
    inheritedOpacity: text.inheritedOpacity,
    inkedPixels: text.boxes.reduce((total, box) => total + box.inkedPixels, 0),
    analytic,
    painted,
    ratio: Math.max(analytic.ratio, painted?.ratio ?? analytic.ratio),
    passes: analyticPasses || paintedPasses,
    modelsDisagree: analyticPasses !== paintedPasses,
    hasNonDeterministicBackground: nonDeterministic,
  };
}

function worstOf(readings: readonly Reading[]): Reading {
  return readings.reduce((lowest, reading) =>
    reading.ratio < lowest.ratio ? reading : lowest,
  );
}

export function formatRgb(color: Rgba): string {
  return `rgb(${Math.round(color.red)} ${Math.round(color.green)} ${Math.round(color.blue)})`;
}
