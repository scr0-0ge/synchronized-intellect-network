import assert from "node:assert/strict";

export type Rgba = Readonly<{
  red: number;
  green: number;
  blue: number;
  alpha: number;
}>;

export function isWcagLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.666_666_7 && fontWeight >= 700);
}

export function contrastRatioForCssColors(
  foreground: string,
  background: string,
): number {
  const foregroundColor = parseCssColor(foreground);
  const backgroundColor = parseCssColor(background);
  assert.equal(foregroundColor.alpha, 1, "foreground-must-be-opaque");
  assert.equal(backgroundColor.alpha, 1, "background-must-be-opaque");
  return roundToThree(contrastRatio(foregroundColor, backgroundColor));
}

export function readPngDimensions(
  value: Uint8Array,
): Readonly<{ width: number; height: number }> {
  const bytes = Buffer.from(value);
  if (bytes.byteLength < 24) throw new Error("png-too-small");
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error("invalid-png-signature");
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("invalid-png-ihdr");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("invalid-png-dimensions");
  return Object.freeze({ width, height });
}

export function parseCssColor(value: string): Rgba {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized === "transparent") {
    return Object.freeze({ red: 0, green: 0, blue: 0, alpha: 0 });
  }
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/u.exec(normalized);
  if (hex !== null) {
    const color = hex[1]!;
    return Object.freeze({
      red: Number.parseInt(color.slice(0, 2), 16),
      green: Number.parseInt(color.slice(2, 4), 16),
      blue: Number.parseInt(color.slice(4, 6), 16),
      alpha: hex[2] === undefined ? 1 : Number.parseInt(hex[2], 16) / 255,
    });
  }
  const functional = /^rgba?\((.*)\)$/u.exec(normalized);
  if (functional !== null) {
    const body = functional[1]!;
    const pieces = body.includes(",")
      ? body.split(",").map((piece) => piece.trim())
      : body.replace("/", " / ").trim().split(/\s+/u);
    const slash = pieces.indexOf("/");
    const channels = slash >= 0 ? pieces.slice(0, slash) : pieces.slice(0, 3);
    const alphaText = slash >= 0 ? pieces[slash + 1] : pieces[3];
    if (channels.length !== 3) throw new Error("unsupported-css-color");
    return Object.freeze({
      red: parseRgbChannel(channels[0]!),
      green: parseRgbChannel(channels[1]!),
      blue: parseRgbChannel(channels[2]!),
      alpha: alphaText === undefined ? 1 : parseAlpha(alphaText),
    });
  }
  const srgb = /^color\(srgb\s+(.+)\)$/u.exec(normalized);
  if (srgb !== null) {
    const pieces = srgb[1]!.replace("/", " / ").trim().split(/\s+/u);
    const slash = pieces.indexOf("/");
    const channels = slash >= 0 ? pieces.slice(0, slash) : pieces.slice(0, 3);
    if (channels.length !== 3) throw new Error("unsupported-css-color");
    return Object.freeze({
      red: Number.parseFloat(channels[0]!) * 255,
      green: Number.parseFloat(channels[1]!) * 255,
      blue: Number.parseFloat(channels[2]!) * 255,
      alpha: slash < 0 ? 1 : parseAlpha(pieces[slash + 1]!),
    });
  }
  throw new Error("unsupported-css-color");
}

function parseRgbChannel(value: string): number {
  const parsed = value.endsWith("%")
    ? (Number.parseFloat(value) / 100) * 255
    : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) {
    throw new Error("invalid-rgb-channel");
  }
  return parsed;
}

function parseAlpha(value: string): number {
  const parsed = value.endsWith("%")
    ? Number.parseFloat(value) / 100
    : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("invalid-alpha-channel");
  }
  return parsed;
}

export function requireOpaque(color: Rgba): Rgba {
  assert.equal(color.alpha, 1);
  return color;
}

export function compositeOverOpaque(foreground: Rgba, background: Rgba): Rgba {
  assert.equal(background.alpha, 1);
  return Object.freeze({
    red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
    green:
      foreground.green * foreground.alpha +
      background.green * (1 - foreground.alpha),
    blue:
      foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
    alpha: 1,
  });
}

export function contrastRatio(left: Rgba, right: Rgba): number {
  const light = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(color: Rgba): number {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function formatRgb(color: Rgba): string {
  return `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`;
}

export function parseCssPixels(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(value.trim());
  if (match === null) throw new Error("invalid-css-pixels");
  return Number.parseFloat(match[1]!);
}

export function parseFontWeight(value: string): number {
  if (value === "normal") return 400;
  if (value === "bold") return 700;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error("invalid-font-weight");
  }
  return parsed;
}

export function roundToThree(value: number): number {
  return Math.round(value * 1000) / 1000;
}
