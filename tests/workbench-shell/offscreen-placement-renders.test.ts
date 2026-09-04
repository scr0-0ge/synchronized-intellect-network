/* Issue 161. The QA harness no longer puts its window on the owner's screen, and
   the whole value of that change depends on one thing staying true: the window
   it opens somewhere he cannot see is still a window the compositor is driving.

   The obvious way to keep a window off a screen is not to show it. That is the
   naive placement, and it does not work: worker 444 established that a
   never-shown window does not reliably produce frames, and the harness moved
   `show` to `showInactive` for exactly that reason. This guard holds both arms
   side by side in one run so it cannot pass vacuously — the never-shown arm must
   be seen RED (a stalled requestAnimationFrame chain) before the offscreen arm
   is accepted as GREEN.

   Note what the two arms do NOT differ in: `capturePage` returns painted pixels
   from both, because Electron's capture path treats a hidden page as visible for
   the duration of the snapshot. A guard written against a capture alone would
   pass on the stalled window. That is asserted here too, so nobody replaces the
   frame measurement with a cheaper-looking one. */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { _electron as electron, type ElectronApplication } from "playwright";

import { removeTestDirectory } from "../helpers/test-lifecycle.ts";

const harnessMain = fileURLToPath(
  new URL("./visual-harness/electron-main.mjs", import.meta.url),
);
const probePage = pathToFileURL(
  fileURLToPath(new URL("./visual-harness/placement-probe.html", import.meta.url)),
).href;
const electronExecutable = createRequire(import.meta.url)("electron") as string;

/** Long enough that a 60 Hz window produces ~100 frames and a stalled one a handful. */
const FRAME_WINDOW_MS = 1_700;

interface PlacementObservation {
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly virtualScreen: Readonly<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  }>;
  readonly intersectsVirtualScreen: boolean;
  readonly isVisible: boolean;
  readonly isFocused: boolean;
  readonly ticks: number;
  readonly captureEmpty: boolean;
  readonly captureMarkPixels: number;
}

const temporaryRoots: string[] = [];

after(async () => {
  for (const root of temporaryRoots) await removeTestDirectory(root);
});

test("an offscreen harness window keeps rendering; a never-shown one does not", async () => {
  const stalled = await observe("hidden");
  const placed = await observe("offscreen");

  // RED. The naive placement is a window nobody shows, and its frame chain is
  // not being serviced. Without this the green arm below proves nothing.
  assert.ok(
    stalled.ticks < 25,
    `a never-shown window should stall; it produced ${stalled.ticks} frames in ${FRAME_WINDOW_MS} ms`,
  );

  // GREEN. The placement the harness actually ships: off every monitor, shown,
  // never focused, and still being asked for frames.
  assert.equal(placed.intersectsVirtualScreen, false);
  assert.equal(placed.isVisible, true);
  assert.equal(placed.isFocused, false);
  assert.ok(
    placed.ticks >= 50,
    `an offscreen shown window should keep rendering; it produced ${placed.ticks} frames in ${FRAME_WINDOW_MS} ms`,
  );
  assert.ok(
    placed.ticks > stalled.ticks * 4,
    `the offscreen window (${placed.ticks}) must render far more than the stalled one (${stalled.ticks})`,
  );

  // capturePage survives the move, which is what the measurement harnesses read.
  assert.equal(placed.captureEmpty, false);
  assert.ok(
    placed.captureMarkPixels > 0,
    "the offscreen window's capture carries the page's own painted pixels",
  );

  // ...and capturePage alone cannot tell the two arms apart, so it must never
  // become this guard's only discriminator.
  assert.equal(stalled.captureEmpty, false);
});

test("the never-shown arm exists only for this guard", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(harnessMain, "utf8"),
  );
  assert.match(source, /UAW_QA_PLACEMENT/u);
  assert.match(source, /const placement = process\.env\.UAW_QA_PLACEMENT \?\? "offscreen";/u);
  // Electron exposes no isSkipTaskbar() getter, so the taskbar half of the
  // placement is held here at the source and in window-placement.test.ts.
  assert.match(source, /\{ \.\.\.origin, skipTaskbar: true \}/u);
  // Every other caller gets the offscreen placement without asking for it.
  for (const caller of [
    "./f56-f57-interaction-fidelity.test.ts",
    "./guard-versus-disabled-invariant.test.ts",
    "./project-history-discoverability.test.ts",
  ]) {
    const callerSource = await import("node:fs/promises").then((fs) =>
      fs.readFile(fileURLToPath(new URL(caller, import.meta.url)), "utf8"),
    );
    assert.doesNotMatch(callerSource, /UAW_QA_PLACEMENT/u);
  }
});

async function observe(
  placement: "offscreen" | "hidden",
): Promise<PlacementObservation> {
  const root = resolve(await mkdtemp(join(tmpdir(), "uaw-placement-guard-")));
  temporaryRoots.push(root);
  const userDataDirectory = resolve(await mkdtemp(join(root, "profile-")));

  const application: ElectronApplication = await electron.launch({
    executablePath: electronExecutable,
    args: [harnessMain, `--user-data-dir=${userDataDirectory}`],
    env: {
      ...process.env,
      UAW_QA_URL: probePage,
      UAW_QA_WIDTH: "1280",
      UAW_QA_HEIGHT: "820",
      UAW_QA_PLACEMENT: placement,
    },
    timeout: 30_000,
  });
  try {
    const page = await application.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState("domcontentloaded");
    // Reset rather than read the page's own counter, so the measurement window
    // is this wall-clock interval and not "since navigation".
    await page.evaluate(() => {
      (globalThis as unknown as { __placementTicks: number }).__placementTicks = 0;
    });
    await new Promise((settle) => setTimeout(settle, FRAME_WINDOW_MS));
    const ticks = await page.evaluate(
      () => (globalThis as unknown as { __placementTicks: number }).__placementTicks,
    );

    return await application.evaluate(
      async ({ BrowserWindow, screen }, observed) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined) throw new Error("placement-guard-window-missing");
        const displays = screen.getAllDisplays();
        const virtualScreen = {
          left: Math.min(...displays.map((display) => display.bounds.x)),
          top: Math.min(...displays.map((display) => display.bounds.y)),
          right: Math.max(
            ...displays.map((display) => display.bounds.x + display.bounds.width),
          ),
          bottom: Math.max(
            ...displays.map((display) => display.bounds.y + display.bounds.height),
          ),
        };
        const bounds = window.getBounds();
        const image = await window.webContents.capturePage(undefined, {
          stayHidden: false,
        });
        const bitmap = image.toBitmap();
        let captureMarkPixels = 0;
        // BGRA. #ff00aa is the probe page's fixed mark.
        for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
          if (
            bitmap[offset] === 170 &&
            bitmap[offset + 1] === 0 &&
            bitmap[offset + 2] === 255
          ) {
            captureMarkPixels += 1;
          }
        }
        return {
          bounds,
          virtualScreen,
          intersectsVirtualScreen:
            Math.max(bounds.x, virtualScreen.left) <
              Math.min(bounds.x + bounds.width, virtualScreen.right) &&
            Math.max(bounds.y, virtualScreen.top) <
              Math.min(bounds.y + bounds.height, virtualScreen.bottom),
          isVisible: window.isVisible(),
          isFocused: window.isFocused(),
          ticks: observed.ticks,
          captureEmpty: image.isEmpty(),
          captureMarkPixels,
        };
      },
      { ticks },
    );
  } finally {
    await application.close();
  }
}
