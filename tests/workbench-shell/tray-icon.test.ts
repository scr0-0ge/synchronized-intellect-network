import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createWorkbenchTrayIcon,
  WORKBENCH_TRAY_ICON_SIZES,
  workbenchTrayIconPath,
  workbenchTrayIconSizeForScaleFactor,
  workbenchTrayIconVariantForSystemTheme,
} from "../../src/workbench-shell/electron/tray-icon.ts";

const trayAssetsDirectory = fileURLToPath(
  new URL("../../assets/brand/tray", import.meta.url),
);

test("tray icon variant follows the system taskbar theme, not the app's own theme", () => {
  assert.equal(workbenchTrayIconVariantForSystemTheme(false), "dark");
  assert.equal(workbenchTrayIconVariantForSystemTheme(true), "light");
});

test("tray icon size steps up at each Windows DPI boundary and never below the packaged set", () => {
  assert.equal(workbenchTrayIconSizeForScaleFactor(1), 16);
  assert.equal(workbenchTrayIconSizeForScaleFactor(1.25), 20);
  assert.equal(workbenchTrayIconSizeForScaleFactor(1.5), 24);
  assert.equal(workbenchTrayIconSizeForScaleFactor(2), 32);
  assert.equal(workbenchTrayIconSizeForScaleFactor(3), 32);
  assert.deepEqual(WORKBENCH_TRAY_ICON_SIZES, [16, 20, 24, 32]);
});

test("tray icon path names the packaged PNG for a given variant and size", () => {
  assert.equal(
    workbenchTrayIconPath("C:\\brand\\tray", "dark", 16),
    join("C:\\brand\\tray", "sin-tray-dark-16.png"),
  );
  assert.equal(
    workbenchTrayIconPath("C:\\brand\\tray", "light", 32),
    join("C:\\brand\\tray", "sin-tray-light-32.png"),
  );
});

test("tray icon is built from the real packaged asset at the resolved path", () => {
  let observedPath = "";
  const icon = { isEmpty: () => false };

  const expectedPath = workbenchTrayIconPath(trayAssetsDirectory, "dark", 16);
  assert.equal(
    createWorkbenchTrayIcon(
      {
        createFromPath(path) {
          observedPath = path;
          return icon;
        },
      },
      expectedPath,
    ),
    icon,
  );
  assert.equal(observedPath, expectedPath);
});

test("tray icon rejects an empty nativeImage at the narrow production boundary", () => {
  assert.throws(
    () =>
      createWorkbenchTrayIcon(
        {
          createFromPath() {
            return { isEmpty: () => true };
          },
        },
        workbenchTrayIconPath(trayAssetsDirectory, "dark", 16),
      ),
    /workbench-tray-icon-unavailable/u,
  );
});

test("every packaged tray raster the production selectors can resolve exists on disk", async () => {
  const { access } = await import("node:fs/promises");
  for (const variant of ["dark", "light"] as const) {
    for (const size of WORKBENCH_TRAY_ICON_SIZES) {
      await access(workbenchTrayIconPath(trayAssetsDirectory, variant, size));
    }
  }
});
