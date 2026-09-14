import { join } from "node:path";

/**
 * The brand kit's tray set is named by the taskbar it stays legible on:
 * `dark` reads on a light taskbar, `light` (white) reads on a dark one.
 */
export type WorkbenchTrayIconVariant = "dark" | "light";

export const WORKBENCH_TRAY_ICON_SIZES = Object.freeze([16, 20, 24, 32] as const);
export type WorkbenchTrayIconSize = (typeof WORKBENCH_TRAY_ICON_SIZES)[number];

/** Electron's `nativeTheme.shouldUseDarkColors` approximates the Windows taskbar theme. */
export function workbenchTrayIconVariantForSystemTheme(
  shouldUseDarkColors: boolean,
): WorkbenchTrayIconVariant {
  return shouldUseDarkColors ? "light" : "dark";
}

/** The nearest packaged raster at or above a display's scale factor. */
export function workbenchTrayIconSizeForScaleFactor(
  scaleFactor: number,
): WorkbenchTrayIconSize {
  if (scaleFactor <= 1) return 16;
  if (scaleFactor <= 1.25) return 20;
  if (scaleFactor <= 1.5) return 24;
  return 32;
}

export function workbenchTrayIconPath(
  trayAssetsDirectory: string,
  variant: WorkbenchTrayIconVariant,
  size: WorkbenchTrayIconSize,
): string {
  return join(trayAssetsDirectory, `sin-tray-${variant}-${size}.png`);
}

export interface WorkbenchNativeImage {
  isEmpty(): boolean;
}

export function createWorkbenchTrayIcon<T extends WorkbenchNativeImage>(
  nativeImageFactory: {
    readonly createFromPath: (path: string) => T;
  },
  iconPath: string,
): T {
  const icon = nativeImageFactory.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error("workbench-tray-icon-unavailable");
  return icon;
}
