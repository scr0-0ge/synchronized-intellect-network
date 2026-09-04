import { app, BrowserWindow, screen } from "electron";

import { offscreenWindowOrigin } from "./offscreen-placement.mjs";

const url = process.env.UAW_QA_URL;
if (typeof url !== "string" || url.length === 0) {
  throw new Error("UAW_QA_URL is required");
}

/*
 * Issue 161. This harness runs on the owner's machine, dozens of launches per
 * `pnpm test`, and every one of them used to land a framed 1280x820 window in
 * the middle of his screen on top of whatever he was doing.
 *
 * The window is still SHOWN — a window that is never shown does not reliably
 * produce frames (worker 444), and this harness measures rendered surfaces — but
 * it is shown at an origin no monitor covers, and shown inactive so the
 * foreground window never changes.
 *
 * UAW_QA_PLACEMENT=hidden exists for exactly one caller:
 * tests/workbench-shell/offscreen-placement-renders.test.ts, which needs to see
 * the never-shown failure mode go red before it accepts the offscreen arm going
 * green. Nothing else sets it.
 */
const placement = process.env.UAW_QA_PLACEMENT ?? "offscreen";

void app.whenReady().then(async () => {
  const origin =
    placement === "offscreen"
      ? offscreenWindowOrigin(screen.getAllDisplays().map((display) => display.bounds))
      : null;

  const window = new BrowserWindow({
    width: Number(process.env.UAW_QA_WIDTH ?? "1280"),
    height: Number(process.env.UAW_QA_HEIGHT ?? "820"),
    ...(origin === null ? {} : { ...origin, skipTaskbar: true }),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The window below is shown inactive and therefore unfocused. Chromium
      // throttles timers and rendering in a window it considers backgrounded,
      // which is exactly the state a measurement harness must not be measured in.
      backgroundThrottling: false,
    },
  });

  await window.loadURL(url);
  if (origin !== null) window.showInactive();

  // One line per launch, so a run leaves a readable trail (issue 161 item 4).
  console.info(
    `[qa-harness] surface=${new URL(url).search || "(no query)"};placement=${
      origin === null ? "hidden" : `offscreen@${origin.x},${origin.y}`
    };bounds=${JSON.stringify(window.getBounds())}`,
  );
});

app.on("window-all-closed", () => app.quit());
