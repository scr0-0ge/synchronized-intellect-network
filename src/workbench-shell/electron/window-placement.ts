/*
 * Where the workbench puts its window, and who is allowed to ask for something
 * other than the default.
 *
 * The owner's machine is the machine every agent and every test runs on. A
 * launch from a Work Order used to land a 1440x900 window in the middle of his
 * screen, on top of whatever he was doing, and then take the foreground —
 * dozens of times per cycle. This module is the one place that decides not to.
 *
 * The decision is deliberately narrow. `--window-placement=offscreen` is
 * honoured ONLY when the same launch also carries `--user-data-dir`, which is
 * the marker of an isolated profile: rule 26 requires every agent and test
 * launch to carry one, and the owner's own launcher (`run-app.bat`, `electron .`)
 * carries none. A launch without both switches therefore takes the default path
 * with no options added at all — `offscreenWindowOptions` is never consulted and
 * the BrowserWindow options object is byte-for-byte what it was before this
 * module existed.
 *
 * Placement is by ORIGIN, not by hiding. A window that is never shown does not
 * reliably produce frames (worker 444; the QA harness moved show -> showInactive
 * for exactly that reason), so this module keeps the window shown — just at an
 * origin no monitor covers.
 *
 * `focusable: false` is the other half and is load-bearing. Showing inactive is
 * enough for the launch itself, but the restore path (a second instance, a tray
 * click, a notification click) calls `show()` and then `focus()` deliberately,
 * and an invisible window holding the owner's keyboard is worse than a visible
 * one. Measured: an offscreen window with the ordinary focus behaviour took the
 * foreground on `focus()`; the same window created `focusable: false` did not,
 * and rendered identically (481 vs 461 frames over two seconds). Both calls
 * still happen, so anything counting them still sees them.
 */

/** The command-line switch name, without the leading dashes. */
export const WINDOW_PLACEMENT_SWITCH = "window-placement";

/** The only recognised non-default value. */
export const OFFSCREEN_WINDOW_PLACEMENT = "offscreen";

/** The whole argument, so callers never re-spell it. */
export const OFFSCREEN_PLACEMENT_ARGUMENT =
  `--${WINDOW_PLACEMENT_SWITCH}=${OFFSCREEN_WINDOW_PLACEMENT}` as const;

/**
 * Distance placed beyond the right edge of every monitor. Any positive value
 * gives an empty intersection with the virtual screen; 64 is far enough that a
 * one-pixel rounding difference between DIP and physical coordinates cannot
 * bring a border back onto a display.
 */
export const OFFSCREEN_PLACEMENT_MARGIN = 64;

/**
 * Used when the display list is not available — `screen` throws before the app
 * is ready, and a startup failure can be presented that early. Well beyond any
 * real desktop and well inside the 16-bit window-coordinate range Windows still
 * uses in places.
 */
export const OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN = Object.freeze({
  x: 30_000,
  y: 0,
});

export interface WindowPlacementRequest {
  /** True when the launch carries `--user-data-dir`. */
  readonly isolatedUserDataDirectory: boolean;
  /** The `--window-placement` value, or null when the switch is absent. */
  readonly placementSwitchValue: string | null;
}

export type WindowPlacementDecision =
  | Readonly<{
      kind: "default";
      reason:
        | "no-placement-switch"
        | "unrecognised-placement"
        | "shared-user-data-directory";
    }>
  | Readonly<{ kind: "offscreen" }>;

export interface DisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OffscreenWindowOrigin {
  readonly x: number;
  readonly y: number;
}

export interface OffscreenWindowOptions extends OffscreenWindowOrigin {
  /**
   * A window nobody can see should not own a taskbar button either: dozens of
   * buttons appearing and vanishing is the same interruption in a thinner shape.
   */
  readonly skipTaskbar: true;
  /**
   * The window cannot be activated, so no call anywhere in this app can pull it
   * in front of the owner's work. See the note at the top of this file.
   */
  readonly focusable: false;
}

/**
 * The gate. Both conditions must hold, and an unrecognised value is refused
 * rather than treated as an instruction, so a typo places the window where the
 * launcher can see it instead of somewhere it cannot.
 */
export function resolveWindowPlacement(
  request: WindowPlacementRequest,
): WindowPlacementDecision {
  if (request.placementSwitchValue === null) {
    return Object.freeze({
      kind: "default" as const,
      reason: "no-placement-switch" as const,
    });
  }
  if (request.placementSwitchValue.trim() !== OFFSCREEN_WINDOW_PLACEMENT) {
    return Object.freeze({
      kind: "default" as const,
      reason: "unrecognised-placement" as const,
    });
  }
  if (!request.isolatedUserDataDirectory) {
    return Object.freeze({
      kind: "default" as const,
      reason: "shared-user-data-directory" as const,
    });
  }
  return Object.freeze({ kind: "offscreen" as const });
}

/**
 * An origin whose x is strictly greater than the right edge of every display,
 * which makes the intersection of any window rectangle placed here with the
 * virtual screen empty regardless of the window's size.
 */
export function offscreenWindowOrigin(
  displays: readonly DisplayBounds[],
): OffscreenWindowOrigin {
  if (displays.length === 0) return OFFSCREEN_PLACEMENT_FALLBACK_ORIGIN;
  const right = Math.max(...displays.map((display) => display.x + display.width));
  const top = Math.min(...displays.map((display) => display.y));
  return Object.freeze({ x: right + OFFSCREEN_PLACEMENT_MARGIN, y: top });
}

/** The BrowserWindow options an offscreen launch adds, and nothing else. */
export function offscreenWindowOptions(
  displays: readonly DisplayBounds[],
): OffscreenWindowOptions {
  return Object.freeze({
    ...offscreenWindowOrigin(displays),
    skipTaskbar: true as const,
    focusable: false as const,
  });
}

/** One run-log line per window, so a run leaves a trail instead of a blur. */
export function formatWindowPlacementDiagnostic(
  surface: string,
  decision: WindowPlacementDecision,
  origin: OffscreenWindowOrigin | null,
): string {
  const placement =
    decision.kind === "offscreen"
      ? `offscreen@${origin?.x ?? "?"},${origin?.y ?? "?"};shown=inactive`
      : `default(${decision.reason});shown=active`;
  return `[window-placement] surface=${surface};${placement}`;
}
