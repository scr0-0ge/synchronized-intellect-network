import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before, type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";
import { createViteBrowserTestServer } from "../helpers/vite-server.ts";
import { createCliUpdateService } from "../../src/workbench-shell/cli-update-check.ts";
import {
  publicCliUpdateCheckCompleted,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRelaunchQueued,
  publicCliUpdateRunUpdated,
  type WorkbenchCliUpdateBridge,
} from "../../src/workbench-shell/contract.ts";

let server: ViteDevServer;
let browser: Browser;
let url: string;
before(async () => {
  server = await createViteBrowserTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: fileURLToPath(new URL("../../", import.meta.url)),
    plugins: [{
      name: "cli-update-test-page",
      configureServer(server) {
        server.middlewares.use("/__cli_update", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html lang="en"><body><div id="root"></div><script type="module" src="/tests/workbench-shell/visual-harness/cli-update-probe.tsx"></script></body></html>');
        });
      },
    }, solid()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/__cli_update`;
  const executablePath = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
  assert.ok(executablePath, "an installed Chromium is required; never install one from this test");
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => {
  try { await browser?.close(); } finally { await server?.close(); }
});

const available = {
  cliId: "claude-code", status: "update-available",
  currentVersion: "2.1.220", availableVersion: "2.1.258",
} as const;
const noCheck = { cliId: "codex", status: "no-check" } as const;

/* The first page.goto of this file pays Vite's cold dependency pre-bundle and the first
   transform of the probe page: the server runs on an isolated cacheDir
   (tests/helpers/vite-server.ts), so nothing is ever warm. 5s covered that on the machine
   this file was written on and nowhere else: on a clean GitHub runner the first test of the
   file died at the bound on 2 of 3 runs of the same tree (main 34533189195 attempt 2,
   PR #7 run 34535514948) and passed the third at 6.3s, inside a second of it. The bound
   only has to tell "still loading" from "never loads", and 60s still does that. Every
   openSettings reports what the navigation cost, green runs included, so a slower machine
   shows up as a number before it shows up as a red. */
const PAGE_ACTION_TIMEOUT_MS = 60_000;

/* w233: codex's button reads "Update" too (it asks before it acts), and both
   update blocks live on the Tools rows (step 2), so every press below is
   scoped to its row. */
const claudeCardSelector = "section.tool-claude";
const codexRowSelector = "section.tool-codex";

async function openSettings(
  t: TestContext,
  bridge: WorkbenchCliUpdateBridge,
  locale: "en" | "zh-CN" = "en",
): Promise<Page> {
  const started = performance.now();
  const page = await browser.newPage();
  page.setDefaultTimeout(PAGE_ACTION_TIMEOUT_MS);
  page.on("pageerror", (error) => console.error(error.message));
  await page.exposeFunction("probeCheck", bridge.checkCliUpdates);
  await page.exposeFunction("probeRun", bridge.runCliUpdate);
  await page.exposeFunction("probeRelaunch", bridge.relaunchApp);
  await page.addInitScript(() => {
    const surface = window as unknown as Record<string, unknown>;
    surface.cliUpdateProbe = {
      checkCliUpdates: surface.probeCheck,
      runCliUpdate: surface.probeRun,
      relaunchApp: surface.probeRelaunch,
    };
  });
  await page.goto(`${url}?locale=${locale}`);
  await page.locator("main.settings").waitFor();
  t.diagnostic(`openSettings(${locale}): elapsed=${Math.round(performance.now() - started)}ms limit=${PAGE_ACTION_TIMEOUT_MS}ms`);
  return page;
}

test("Chinese Claude retry buttons name the sign-in and update checks", async t => {
  const page = await openSettings(t, {
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([
      { cliId: "claude-code", status: "check-failed" },
      noCheck,
    ]),
    runCliUpdate: async (cliId) => publicCliUpdateRunUpdated(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  }, "zh-CN");
  try {
    // Sign-in stays on the Claude provider card; the update check moved to
    // the Claude Tools row (w233 step 2). Neither is a bare "检查".
    const claudeCard = page.locator("section.provider-claude");
    const claudeTool = page.locator(claudeCardSelector);
    await claudeCard.locator("button").filter({ hasText: /^检查登录$/u }).waitFor();
    await claudeTool.locator("button").filter({ hasText: /^检查更新$/u }).waitFor();
    for (const scope of [claudeCard, claudeTool]) {
      assert.equal(await scope.getByRole("button", { name: "检查", exact: true }).count(), 0);
    }
  } finally { await page.close(); }
});

test("Settings restart button invokes relaunchApp and waits for the queued restart (issue 184)", async t => {
  let updated = false;
  let restarts = 0;
  const page = await openSettings(t, {
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([
      updated ? { cliId: "claude-code", status: "up-to-date" } : available, noCheck,
    ]),
    runCliUpdate: async (cliId) => { updated = true; return publicCliUpdateRunUpdated(cliId); },
    relaunchApp: async () => { restarts++; return publicCliUpdateRelaunchQueued(); },
  });
  try {
    await page.locator(claudeCardSelector).getByRole("button", { name: "Update", exact: true }).click();
    await page.getByText("The update finished.", { exact: false }).waitFor();
    const restart = page.getByRole("button", { name: "Restart now", exact: true });
    assert.equal(await restart.count(), 1, "successful update must offer Restart now");
    await restart.click();
    await page.getByRole("button", { name: "Restarting…", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Restarting…", exact: true }).isDisabled(), true);
    // Wait for the exposed bridge call to settle before checking its count.
    await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') !== null);
    assert.equal(restarts, 1, "Restart now must call the preload relaunch action once");
  } finally { await page.close(); }
});

test("Settings replaces a failed post-run check with an actionable retry and fresh versions (issue 184)", async t => {
  let sourceAvailable = true;
  let current = "2.1.220";
  let checks = 0;
  const service = createCliUpdateService({
    resolveWingetExecutable: async () => "winget",
    resolveClaudeExecutable: async () => "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe",
    runner: { async run(command) {
      if (command.args[0] === "upgrade") {
        sourceAvailable = false;
        return { exit: "non-zero", stderr: "" };
      }
      checks++;
      return sourceAvailable
        ? { exit: "zero", stdout: `Claude Code Anthropic.ClaudeCode ${current} 2.1.258` }
        : { exit: "non-zero", stderr: "" };
    } },
  });
  const page = await openSettings(t, {
    checkCliUpdates: async () => publicCliUpdateCheckCompleted(await service.check()),
    runCliUpdate: (cliId) => service.run(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    await page.locator(claudeCardSelector).getByRole("button", { name: "Update", exact: true }).click();
    await page.getByText("The update did not complete.", { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    const retry = page.getByRole("button", { name: "Check updates again", exact: true });
    assert.equal(await retry.count(), 1, "failed post-run check must leave Check for updates again visible");
    assert.equal(await page.getByText("Could not check whether", { exact: false }).count(), 1);
    assert.equal(await page.getByText("A new version is available:", { exact: false }).count(), 0, "failed check must remove the stale version claim");
    const beforeRetry = checks;
    sourceAvailable = true;
    current = "2.1.240";
    await retry.click();
    await page.locator(claudeCardSelector).getByRole("button", { name: "Update", exact: true }).waitFor();
    assert.equal(checks, beforeRetry + 1, "retry must perform a new read-only query");
    assert.equal(await page.getByText("A new version is available: 2.1.240 → 2.1.258.", { exact: true }).count(), 1);
    assert.equal(await retry.count(), 0);
  } finally { await page.close(); }
});

test("Settings discards stale versions when the post-run check IPC is unavailable or rejects (issue 184)", async t => {
  for (const failure of ["unavailable", "rejected"] as const) {
    let updated = false;
    const page = await openSettings(t, {
      checkCliUpdates: async () => {
        if (!updated) return publicCliUpdateCheckCompleted([available, noCheck]);
        if (failure === "rejected") throw new Error("test IPC unavailable");
        return publicCliUpdateCheckUnavailable();
      },
      runCliUpdate: async (cliId) => { updated = true; return publicCliUpdateRunUpdated(cliId); },
      relaunchApp: async () => publicCliUpdateRelaunchQueued(),
    });
    try {
      await page.locator(claudeCardSelector).getByRole("button", { name: "Update", exact: true }).click();
      await page.getByText("The update finished.", { exact: false }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      assert.equal(await page.getByText("A new version is available:", { exact: false }).count(), 0, `${failure}: failed refresh must discard stale version claims`);
      assert.equal(await page.getByRole("button", { name: "Check updates again", exact: true }).count(), 1, `${failure}: failed refresh must offer retry`);
    } finally { await page.close(); }
  }
});

test("Settings offers Update after Not now and a successful retry finds a newer version (issue 184)", async t => {
  let checks = 0;
  const page = await openSettings(t, {
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([
      ++checks === 2 ? { cliId: "claude-code", status: "check-failed" } : available, noCheck,
    ]),
    runCliUpdate: async (cliId) => publicCliUpdateRunUpdated(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    await page.locator(claudeCardSelector).getByRole("button", { name: "Update", exact: true }).click();
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await page.getByRole("button", { name: "Check updates again", exact: true }).click();
    await page.getByText("A new version is available:", { exact: false }).waitFor();
    assert.equal(await page.locator(claudeCardSelector).getByRole("button", { name: "Update", exact: true }).count(), 1, "successful retry must restore Update even after Not now");
  } finally { await page.close(); }
});

/*
 * w120. The codex row used to be a bare "Check and update" button with no
 * sentence of any kind, and one press started a non-interactive install in
 * the background. Two things are asserted here and they are separate: that the
 * row SAYS what pressing it will do, and that pressing it once does NOT do it.
 * w233 moved the two sentences to the confirmation moment: the first press
 * asks, and the sentences stand beside the question, before the press that
 * installs. The idle row is a button, not two paragraphs in front of one.
 */
test("w120: the codex row states what the update will do before the press that installs", async t => {
  let runs = 0;
  const page = await openSettings(t, {
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([available, noCheck]),
    runCliUpdate: async (cliId) => { runs += 1; return publicCliUpdateRunUpdated(cliId); },
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    const codexCard = page.locator(codexRowSelector);
    assert.equal(
      await codexCard.getByText("asks the channel that installed this CLI", { exact: false }).count(),
      0,
      "the idle row is a button, not an explanation in front of one",
    );
    await codexCard.getByRole("button", { name: "Update", exact: true }).click();
    await codexCard.getByText("Update this CLI now?", { exact: true }).waitFor();
    assert.equal(runs, 0, "the sentences are read before anything is installed");
    await codexCard
      .getByText("asks the channel that installed this CLI", { exact: false })
      .waitFor();
    await codexCard
      .getByText("not read until the update runs", { exact: false })
      .waitFor();
    // No invented version: the report carries none, so none may be shown.
    assert.equal(
      await codexCard.getByText(/\b\d+\.\d+\.\d+\b/u).count(),
      0,
      "the codex row must not display a version nobody sent it",
    );
  } finally { await page.close(); }
});

test("w120: a codex update does not start until it is confirmed", async t => {
  let runs = 0;
  const page = await openSettings(t, {
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([available, noCheck]),
    runCliUpdate: async (cliId) => { runs += 1; return publicCliUpdateRunUpdated(cliId); },
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    const codexCard = page.locator(codexRowSelector);
    await codexCard.getByRole("button", { name: "Update", exact: true }).click();
    await codexCard.getByText("Update this CLI now?", { exact: true }).waitFor();
    assert.equal(runs, 0, "the first press must ask, not install");

    // Cancel leaves the machine alone and restores the original action.
    await codexCard.getByRole("button", { name: "Cancel", exact: true }).click();
    await codexCard.getByRole("button", { name: "Update", exact: true }).waitFor();
    assert.equal(runs, 0, "cancelling must not install anything");

    await codexCard.getByRole("button", { name: "Update", exact: true }).click();
    await codexCard.getByRole("button", { name: "Yes, update", exact: true }).click();
    await codexCard.getByText("The update finished.", { exact: false }).waitFor();
    assert.equal(runs, 1, "confirming must run the update exactly once");
  } finally { await page.close(); }
});
