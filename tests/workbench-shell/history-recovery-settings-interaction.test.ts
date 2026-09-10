import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { chromium, type Browser, type Page } from "playwright";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";

import { createViteBrowserTestServer } from "../helpers/vite-server.ts";

let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createViteBrowserTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: fileURLToPath(new URL("../../", import.meta.url)),
    plugins: [
      {
        name: "history-recovery-settings-test-page",
        configureServer(server) {
          server.middlewares.use("/__history_recovery", (_request, response) => {
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><html lang="en"><body><main id="root"></main><script type="module" src="/tests/workbench-shell/visual-harness/history-recovery-settings-probe.tsx"></script></body></html>',
            );
          });
        },
      },
      solid(),
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/__history_recovery`;
  const executablePath = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
  assert.ok(executablePath, "an installed Chromium is required; never install one from this test");
  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

test("Settings stays quiet when no historical recovery data was found", async () => {
  const page = await openProbe("clean");
  try {
    assert.equal(await page.locator(".history-recovery-card").count(), 0);
  } finally {
    await page.close();
  }
});

test("a genuinely unavailable recovery library says what remains available and what to try", async () => {
  const page = await openProbe("library-unavailable");
  try {
    const card = page.locator(".history-recovery-card");
    const alert = card.getByRole("alert");
    await alert.getByText(
      "Data recovery could not be prepared. Your current Project remains available. Restart Workbench to try again.",
      { exact: true },
    ).waitFor();
    assert.equal(await card.locator(".history-recovery-attention").count(), 0);
    assert.doesNotMatch(
      (await alert.textContent()) ?? "",
      /Historical Recovery Library|owner-only-postcondition|unavailable/u,
    );
  } finally {
    await page.close();
  }
});

test("a synthetic historical store exposes its inventory and can be preserved", async () => {
  const page = await openProbe("success");
  try {
    const card = page.locator(".history-recovery-card");
    await card.getByRole("heading", { name: "Data recovery", exact: true }).waitFor();
    await card.getByText("Historical local data needs review.", { exact: false }).waitFor();

    await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
    await card.getByText(
      "1 Projects · 2 Sessions · 3 commands · 4 updates",
      { exact: true },
    ).waitFor();
    await card.getByRole("button", { name: "Preserve", exact: true }).click();
    await card.getByText(
      "Recovery 1 was preserved in the Historical Recovery Library. Browse its metadata here, or use Export exact copy… to retrieve the complete preserved history.",
      { exact: true },
    ).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.preserveCalls),
      "1",
    );
  } finally {
    await page.close();
  }
});

test("contract failures are human-readable and do not expose internal details", async () => {
  const page = await openProbe("failure");
  try {
    const card = page.locator(".history-recovery-card");
    await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
    await card.getByRole("button", { name: "Preserve", exact: true }).click();
    const alert = card.getByRole("alert");
    await alert.getByText("The recovery copy could not be verified.", { exact: true }).waitFor();
    assert.doesNotMatch(
      (await alert.textContent()) ?? "",
      /[A-Za-z]:\\|AppData|workbench-project-host/u,
    );
  } finally {
    await page.close();
  }
});

test("a rejected preserve call still leaves visible, path-free failure feedback", async () => {
  const page = await openProbe("rejected");
  try {
    const card = page.locator(".history-recovery-card");
    await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
    await card.getByRole("button", { name: "Preserve", exact: true }).click();
    const alert = card.getByRole("alert");
    await alert.getByText("Data recovery information is unavailable.", { exact: true }).waitFor();
    assert.doesNotMatch(
      (await alert.textContent()) ?? "",
      /[A-Za-z]:\\|AppData|workbench-project-host/u,
    );
  } finally {
    await page.close();
  }
});

test("an unreadable historical store explains the permission fix and retry", async () => {
  const page = await openProbe("permission-denied");
  try {
    const card = page.locator(".history-recovery-card");
    await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
    const alert = card.getByRole("alert");
    await alert.getByText(
      "Workbench could not read this historical store. Check that your Windows account has permission to read it, then restart Workbench to retry.",
      { exact: true },
    ).waitFor();
    assert.doesNotMatch(
      (await alert.textContent()) ?? "",
      /[A-Za-z]:\\|AppData|private-history|EPERM/u,
    );
  } finally {
    await page.close();
  }
});

async function openProbe(scenario: string): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  await page.goto(`${url}?scenario=${scenario}`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.locator("#root").waitFor({ state: "attached" });
  return page;
}
