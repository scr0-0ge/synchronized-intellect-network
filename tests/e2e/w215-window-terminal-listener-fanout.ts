/*
 * w215 (issue #6) — a stranger's first run prints three
 * `MaxListenersExceededWarning`s before any window is visible. Thirteen
 * window-scoped IPC bindings each install their own terminal-lifecycle
 * listener(s) directly on the one production `BrowserWindow` and its
 * `webContents`; diagnosed as a fixed, non-growing fan-out in
 * `ao-0909-w48-listener-warning.md` (20 "closed", 18 "destroyed"/
 * "render-process-gone", constant across five Settings open/close cycles).
 * `main.ts` now raises the ceiling with `setMaxListeners`, which silences the
 * warning without touching the fan-out itself. This driver pins both halves
 * of that claim against a real, isolated, offscreen production launch: zero
 * `MaxListenersExceededWarning` lines on stderr, and the three listener
 * counts genuinely do not grow across five real Settings open/close cycles
 * (a regression that moved registration into a per-navigation code path
 * would still be caught here even though it would not print a warning).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ElectronApplication, Page } from "playwright";

import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";

const productionElectron = resolveProductionElectronComposition(
  import.meta.url,
);

interface TerminalListenerCounts {
  readonly closed: number;
  readonly destroyed: number;
  readonly renderProcessGone: number;
}

interface Sample {
  readonly label: string;
  readonly counts: TerminalListenerCounts;
}

async function readTerminalListenerCounts(
  application: ElectronApplication,
): Promise<TerminalListenerCounts> {
  return application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("w215-window-missing");
    return {
      closed: window.listenerCount("closed"),
      destroyed: window.webContents.listenerCount("destroyed"),
      renderProcessGone: window.webContents.listenerCount(
        "render-process-gone",
      ),
    };
  });
}

/**
 * All thirteen window-scoped bindings install from inside
 * `backendInitialization`, which resolves after the renderer has already
 * finished its own `domcontentloaded` — so a count read right after launch
 * can land mid fan-out. Wait for three consecutive unchanged reads (steady
 * state) before treating a count as the baseline the five Settings cycles
 * below must not exceed.
 */
async function waitForStableTerminalListenerCounts(
  application: ElectronApplication,
  timeoutMilliseconds = 15_000,
): Promise<TerminalListenerCounts> {
  const deadline = Date.now() + timeoutMilliseconds;
  let previous = await readTerminalListenerCounts(application);
  let stableReads = 1;
  while (Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const current = await readTerminalListenerCounts(application);
    if (
      current.closed === previous.closed &&
      current.destroyed === previous.destroyed &&
      current.renderProcessGone === previous.renderProcessGone
    ) {
      stableReads += 1;
      if (stableReads >= 3) return current;
    } else {
      stableReads = 1;
    }
    previous = current;
  }
  throw new Error("w215-listener-count-never-stabilized");
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Settings", exact: true, level: 1 })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await page
    .locator("main.settings")
    .waitFor({ state: "hidden", timeout: 10_000 });
}

function attachStderrCapture(application: ElectronApplication): {
  readonly warningLines: () => readonly string[];
} {
  const lines: string[] = [];
  application.process().stderr?.on("data", (chunk: unknown) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (line.includes("MaxListenersExceededWarning")) lines.push(line);
    }
  });
  return { warningLines: () => lines };
}

async function main(): Promise<void> {
  const isolatedHome = await mktempIsolatedHome();
  const projectDirectory = join(isolatedHome, "project");
  const userDataDirectory = join(isolatedHome, "user-data");
  await mkdir(projectDirectory, { recursive: true });

  let application: ElectronApplication | undefined;
  try {
    application = await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userDataDirectory),
      cwd: projectDirectory,
      env: {
        ...process.env,
        APPDATA: join(isolatedHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
      },
      timeout: 30_000,
    });
    const stderrCapture = attachStderrCapture(application);
    const page = await firstDomContentLoadedWindow(application, 15_000);

    const samples: Sample[] = [
      { label: "startup", counts: await waitForStableTerminalListenerCounts(application) },
    ];
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      await openSettings(page);
      samples.push({
        label: `settings-${cycle}`,
        counts: await readTerminalListenerCounts(application),
      });
      await closeSettings(page);
      samples.push({
        label: `return-${cycle}`,
        counts: await readTerminalListenerCounts(application),
      });
    }

    const baseline = samples[0].counts;
    for (const sample of samples) {
      assert.equal(
        sample.counts.closed,
        baseline.closed,
        `"closed" listener count grew at ${sample.label}`,
      );
      assert.equal(
        sample.counts.destroyed,
        baseline.destroyed,
        `"destroyed" listener count grew at ${sample.label}`,
      );
      assert.equal(
        sample.counts.renderProcessGone,
        baseline.renderProcessGone,
        `"render-process-gone" listener count grew at ${sample.label}`,
      );
    }
    assert.deepEqual(
      stderrCapture.warningLines(),
      [],
      "a real production launch must never print MaxListenersExceededWarning",
    );

    console.log(
      `W215_LISTENER_FANOUT_GUARD ${JSON.stringify({ samples, warningLineCount: stderrCapture.warningLines().length })}`,
    );
  } finally {
    await application?.close().catch(() => undefined);
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

async function mktempIsolatedHome(): Promise<string> {
  return mkdtemp(join(resolve(tmpdir()), "workbench-w215-"));
}

await main();
