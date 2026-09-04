/*
 * The QA harness's copy of the product's offscreen origin rule (issue 161).
 *
 * The product rule lives in src/workbench-shell/electron/window-placement.ts and
 * is TypeScript. Electron 37 runs the main process on Node 22 without type
 * stripping, so this harness cannot import that file at runtime. It carries the
 * rule instead, and tests/workbench-shell/window-placement.test.ts holds the two
 * implementations against each other over a table of display layouts so they
 * cannot drift apart silently.
 *
 * Exported separately from electron-main.mjs so the guard can import it without
 * starting an Electron app.
 */

/** Must equal OFFSCREEN_PLACEMENT_MARGIN in the product module. */
export const OFFSCREEN_PLACEMENT_MARGIN = 64;

/** Must equal OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN in the product module. */
export const OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN = Object.freeze({
  x: 30_000,
  y: 0,
});

/**
 * An origin strictly to the right of every display, so a window placed here has
 * an empty intersection with the virtual screen whatever its size.
 *
 * @param {ReadonlyArray<{ x: number, y: number, width: number, height: number }>} displays
 * @returns {{ x: number, y: number }}
 */
export function offscreenWindowOrigin(displays) {
  if (displays.length === 0) return OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN;
  const right = Math.max(...displays.map((display) => display.x + display.width));
  const top = Math.min(...displays.map((display) => display.y));
  return Object.freeze({ x: right + OFFSCREEN_PLACEMENT_MARGIN, y: top });
}
