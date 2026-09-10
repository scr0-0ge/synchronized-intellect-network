import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
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

async function openSettings(
  bridge: WorkbenchCliUpdateBridge,
  locale: "en" | "zh-CN" = "en",
): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
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
  return page;
}

test("Chinese Claude retry buttons name the sign-in and update checks", async () => {
  const page = await openSettings({
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([
      { cliId: "claude-code", status: "check-failed" },
      noCheck,
    ]),
    runCliUpdate: async (cliId) => publicCliUpdateRunUpdated(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  }, "zh-CN");
  try {
    const claudeCard = page.locator("section.provider-claude");
    await claudeCard.locator("button").filter({ hasText: /^重新检查登录$/u }).waitFor();
    await claudeCard.locator("button").filter({ hasText: /^重新检查更新$/u }).waitFor();
    assert.equal(
      await claudeCard.getByRole("button", { name: "重新检查", exact: true }).count(),
      0,
    );
  } finally { await page.close(); }
});

test("Settings restart button invokes relaunchApp and waits for the queued restart (issue 184)", async () => {
  let updated = false;
  let restarts = 0;
  const page = await openSettings({
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([
      updated ? { cliId: "claude-code", status: "up-to-date" } : available, noCheck,
    ]),
    runCliUpdate: async (cliId) => { updated = true; return publicCliUpdateRunUpdated(cliId); },
    relaunchApp: async () => { restarts++; return publicCliUpdateRelaunchQueued(); },
  });
  try {
    await page.getByRole("button", { name: "Update", exact: true }).click();
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

test("Settings replaces a failed post-run check with an actionable retry and fresh versions (issue 184)", async () => {
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
  const page = await openSettings({
    checkCliUpdates: async () => publicCliUpdateCheckCompleted(await service.check()),
    runCliUpdate: (cliId) => service.run(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.getByText("The update did not complete.", { exact: false }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    const retry = page.getByRole("button", { name: "Check for updates again", exact: true });
    assert.equal(await retry.count(), 1, "failed post-run check must leave Check for updates again visible");
    assert.equal(await page.getByText("Could not check whether", { exact: false }).count(), 1);
    assert.equal(await page.getByText("A new version is available:", { exact: false }).count(), 0, "failed check must remove the stale version claim");
    const beforeRetry = checks;
    sourceAvailable = true;
    current = "2.1.240";
    await retry.click();
    await page.getByRole("button", { name: "Update", exact: true }).waitFor();
    assert.equal(checks, beforeRetry + 1, "retry must perform a new read-only query");
    assert.equal(await page.getByText("A new version is available: 2.1.240 → 2.1.258.", { exact: true }).count(), 1);
    assert.equal(await retry.count(), 0);
  } finally { await page.close(); }
});

test("Settings discards stale versions when the post-run check IPC is unavailable or rejects (issue 184)", async () => {
  for (const failure of ["unavailable", "rejected"] as const) {
    let updated = false;
    const page = await openSettings({
      checkCliUpdates: async () => {
        if (!updated) return publicCliUpdateCheckCompleted([available, noCheck]);
        if (failure === "rejected") throw new Error("test IPC unavailable");
        return publicCliUpdateCheckUnavailable();
      },
      runCliUpdate: async (cliId) => { updated = true; return publicCliUpdateRunUpdated(cliId); },
      relaunchApp: async () => publicCliUpdateRelaunchQueued(),
    });
    try {
      await page.getByRole("button", { name: "Update", exact: true }).click();
      await page.getByText("The update finished.", { exact: false }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
      assert.equal(await page.getByText("A new version is available:", { exact: false }).count(), 0, `${failure}: failed refresh must discard stale version claims`);
      assert.equal(await page.getByRole("button", { name: "Check for updates again", exact: true }).count(), 1, `${failure}: failed refresh must offer retry`);
    } finally { await page.close(); }
  }
});

test("Settings offers Update after Not now and a successful retry finds a newer version (issue 184)", async () => {
  let checks = 0;
  const page = await openSettings({
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([
      ++checks === 2 ? { cliId: "claude-code", status: "check-failed" } : available, noCheck,
    ]),
    runCliUpdate: async (cliId) => publicCliUpdateRunUpdated(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await page.getByRole("button", { name: "Check for updates again", exact: true }).click();
    await page.getByText("A new version is available:", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Update", exact: true }).count(), 1, "successful retry must restore Update even after Not now");
  } finally { await page.close(); }
});

/*
 * w120. The codex row used to be a bare "Check and update" button with no
 * sentence of any kind, and one press started a non-interactive install in
 * the background. Two things are asserted here and they are separate: that the
 * row SAYS what pressing it will do, and that pressing it once does NOT do it.
 */
test("w120: the codex row states what the update will do before it is pressed", async () => {
  const page = await openSettings({
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([available, noCheck]),
    runCliUpdate: async (cliId) => publicCliUpdateRunUpdated(cliId),
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    const codexCard = page.locator("section.provider").filter({
      has: page.locator(".ph-name", { hasText: "Codex" }),
    });
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

test("w120: a codex update does not start until it is confirmed", async () => {
  let runs = 0;
  const page = await openSettings({
    checkCliUpdates: async () => publicCliUpdateCheckCompleted([available, noCheck]),
    runCliUpdate: async (cliId) => { runs += 1; return publicCliUpdateRunUpdated(cliId); },
    relaunchApp: async () => publicCliUpdateRelaunchQueued(),
  });
  try {
    const codexCard = page.locator("section.provider").filter({
      has: page.locator(".ph-name", { hasText: "Codex" }),
    });
    await codexCard.getByRole("button", { name: "Check and update", exact: true }).click();
    await codexCard.getByText("Update this CLI now?", { exact: true }).waitFor();
    assert.equal(runs, 0, "the first press must ask, not install");

    // Cancel leaves the machine alone and restores the original action.
    await codexCard.getByRole("button", { name: "Cancel", exact: true }).click();
    await codexCard.getByRole("button", { name: "Check and update", exact: true }).waitFor();
    assert.equal(runs, 0, "cancelling must not install anything");

    await codexCard.getByRole("button", { name: "Check and update", exact: true }).click();
    await codexCard.getByRole("button", { name: "Yes, update", exact: true }).click();
    await codexCard.getByText("The update finished.", { exact: false }).waitFor();
    assert.equal(runs, 1, "confirming must run the update exactly once");
  } finally { await page.close(); }
});
