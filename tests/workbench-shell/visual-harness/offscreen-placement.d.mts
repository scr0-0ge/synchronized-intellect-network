/* Types for offscreen-placement.mjs, which must stay plain JavaScript because
   Electron's main process runs it without type stripping. Only the guard in
   tests/workbench-shell/window-placement.test.ts imports it from TypeScript, and
   that guard compares the two implementations' actual values, so a drift here
   cannot hide a drift there. */

export declare const OFFSCREEN_PLACEMENT_MARGIN: number;

export declare const OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN: Readonly<{
  x: number;
  y: number;
}>;

export declare function offscreenWindowOrigin(
  displays: ReadonlyArray<
    Readonly<{ x: number; y: number; width: number; height: number }>
  >,
): Readonly<{ x: number; y: number }>;
