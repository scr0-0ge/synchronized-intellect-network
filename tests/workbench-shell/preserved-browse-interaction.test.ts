import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before, type TestContext } from "node:test";

import { chromium, type Browser } from "playwright";
import solid from "vite-plugin-solid";
import type { ViteDevServer } from "vite";

import { createHistoricalRecoveryLibrary } from "../../src/workbench-shell/history-recovery.ts";
import type {
  HistoryRecoveryBrowseRequest,
  HistoryRecoveryPerformRequest,
  HistoryRecoverySnapshotRequest,
} from "../../src/workbench-shell/history-recovery-contract.ts";
import {
  sanitizeHistoryRecoveryActionResult,
  sanitizeHistoryRecoveryBrowseResult,
  sanitizeHistoryRecoverySnapshotResult,
} from "../../src/workbench-shell/history-recovery-sanitizer.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";
import { createViteBrowserTestServer } from "../helpers/vite-server.ts";
import {
  createSyntheticStore,
  syntheticLedgerSlot,
  writeSyntheticRegistry,
} from "./fixtures/synthetic-history-recovery-fixtures.ts";

let server: ViteDevServer;
let browser: Browser;
let url: string;

before(async () => {
  server = await createViteBrowserTestServer({
    appType: "custom", configFile: false, logLevel: "silent",
    root: fileURLToPath(new URL("../../", import.meta.url)),
    plugins: [{
      name: "preserved-browse-test-page",
      configureServer(server) {
        server.middlewares.use("/__preserved_browse", (_request, response) => {
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html lang="en"><body><main id="root"></main><script type="module" src="/tests/workbench-shell/visual-harness/preserved-browse-probe.tsx"></script></body></html>');
        });
      },
    }, solid()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/__preserved_browse`;
  const executablePath = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
  assert.ok(executablePath, "an installed Chromium is required");
  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  try { await browser?.close(); }
  finally { await server?.close(); }
});

test("preserving a synthetic store immediately exposes its Project, Session and Turn inventory", async (t) => {
  const { page, source, exportPath } = await openLibrary(t);
  const before = await readFile(source.ledgerPath!);
  const card = page.locator(".history-recovery-card");
  await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
  await card.getByRole("button", { name: "Preserve", exact: true }).click();
  await card.getByText(
    "Recovery 1 was preserved in the Historical Recovery Library. Browse its metadata here, or use Export exact copy… to retrieve the complete preserved history.",
    { exact: true },
  ).waitFor();
  // This must work without leaving Settings or manually refreshing the card.
  await card.getByRole("button").filter({ has: page.getByText("Recovery 1", { exact: true }) }).click();
  await card.getByRole("button").filter({ has: page.getByText("Project 1", { exact: true }) }).click();
  await card.getByRole("button").filter({ has: page.getByText("Session 1", { exact: true }) }).click();
  await card.getByText("Turn 1", { exact: true }).waitFor();
  await card.getByText("Turn 2", { exact: true }).waitFor();
  assert.equal(await card.locator("input, textarea, [contenteditable=true]").count(), 0);
  await card.getByText(
    "Conversation content is not displayed here. Export an exact copy to retrieve the complete preserved history.",
    { exact: true },
  ).waitFor();
  await card.getByRole("button", { name: "Export exact copy…", exact: true }).click();
  await card.getByText(
    "Recovery export 1 was exported to the location you selected as an exact copy.",
    { exact: true },
  ).waitFor();
  assert.equal((await readFile(exportPath)).subarray(0, 15).toString("utf8"), "UAWR-HISTORY-1\n");
  await card.getByRole("button", { name: "Back", exact: true }).click();
  await card.getByRole("button").filter({ has: page.getByText("Session 1", { exact: true }) }).waitFor();
  assert.equal(await card.getByText("Turn 1", { exact: true }).count(), 0);
  assert.deepEqual(await readFile(source.ledgerPath!), before);
});

test("a rejected browse shows a human-readable error rather than a blank library", async (t) => {
  const { page } = await openLibrary(t, { rejectBrowse: true });
  const card = page.locator(".history-recovery-card");
  await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
  await card.getByRole("alert").getByText("Data recovery information is unavailable.", { exact: true }).waitFor();
  assert.doesNotMatch((await card.textContent()) ?? "", /private-read-error|C:\\/u);
});

test("an empty synthetic store is explained and acknowledged without offering a conversation", async (t) => {
  const { page } = await openLibrary(t, { sourceKind: "empty" });
  const card = page.locator(".history-recovery-card");
  await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
  await card.getByText("0 Projects · 0 Sessions · 0 commands · 0 updates", { exact: true }).waitFor();
  await card.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await card.getByText("The verified empty historical store was acknowledged.", { exact: true }).waitFor();
  await card.getByText("0 preserved", { exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "Export exact copy…", exact: true }).count(), 0);
});

test("a damaged synthetic database is preserved but its unreadable inventory shows an explanation", async (t) => {
  const { page, source, exportPath } = await openLibrary(t, { sourceKind: "damaged" });
  const before = await readFile(source.ledgerPath!);
  const card = page.locator(".history-recovery-card");
  await card.getByRole("button", { name: "Review data recovery", exact: true }).click();
  await card.getByText("Metadata could not be inspected.", { exact: true }).waitFor();
  await card.getByText(
    "Preserve this store, then export an exact copy to retrieve its complete contents.",
    { exact: true },
  ).waitFor();
  assert.equal(await card.getByText("0 Projects · 0 Sessions · 0 commands · 0 updates", { exact: true }).count(), 0);
  assert.equal(await card.getByText("Available", { exact: true }).count(), 0);
  await card.getByRole("button", { name: "Preserve", exact: true }).click();
  await card.getByText(
    "Recovery 1 was preserved in the Historical Recovery Library. Browse its metadata here, or use Export exact copy… to retrieve the complete preserved history.",
    { exact: true },
  ).waitFor();
  await card.getByRole("button").filter({ has: page.getByText("Recovery 1", { exact: true }) }).click();
  await card.getByRole("alert").getByText("The recovery copy could not be verified.", { exact: true }).waitFor();
  await card.getByText(
    "Conversation content is not displayed here. Export an exact copy to retrieve the complete preserved history.",
    { exact: true },
  ).waitFor();
  await card.getByRole("button", { name: "Export exact copy…", exact: true }).click();
  await card.getByText(
    "Recovery export 1 was exported to the location you selected as an exact copy.",
    { exact: true },
  ).waitFor();
  assert.equal((await readFile(exportPath)).subarray(0, 15).toString("utf8"), "UAWR-HISTORY-1\n");
  assert.deepEqual(await readFile(source.ledgerPath!), before);
});

async function openLibrary(t: TestContext, options: {
  rejectBrowse?: boolean;
  sourceKind?: "empty" | "damaged";
} = {}) {
  const parent = await createTestDirectory(t, join(tmpdir(), "w78-"));
  const root = join(parent, "source");
  const exportPath = join(parent, "recovery-export.uawr-history");
  const source = options.sourceKind === "damaged"
    ? { root, ledgerPath: join(root, "project-ledgers", `${syntheticLedgerSlot}.sqlite`) }
    : await createSyntheticStore(root, options.sourceKind === "empty" ? 0 : 2);
  if (options.sourceKind === "damaged") {
    await mkdir(join(root, "project-ledgers"), { recursive: true });
    await writeSyntheticRegistry(root, [syntheticLedgerSlot]);
    // New malformed fixture; no existing database is damaged or overwritten.
    await writeFile(source.ledgerPath!, "synthetic damaged database", { flag: "wx" });
  }
  const library = createHistoricalRecoveryLibrary({
    dataDirectory: join(parent, "recovery"),
    sourceDiscovery: { async discover() {
      return [{ role: "historical", rootPath: source.root, providerClass: "synthetic-w78" }];
    } },
    exportChooser: { async choose() { return { targetPath: exportPath }; } },
    // The public read/UI behavior is under test, not Windows ACL setup.
    ownerOnlyStorage: { async establish() {}, async verify() { return true; } },
  });
  registerTestClosable(t, library);
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "the recovery card must not crash"));
  registerTestClosable(t, page);
  page.setDefaultTimeout(5_000);
  const owner = {};
  await page.exposeFunction("recoveryExecute", async (
    request: HistoryRecoverySnapshotRequest | HistoryRecoveryBrowseRequest | HistoryRecoveryPerformRequest,
  ) => {
    if ("kind" in request && options.rejectBrowse) {
      throw new Error("C:\\synthetic\\private-read-error.sqlite");
    }
    const result = structuredClone(await library.execute(owner, request));
    const sanitized = "action" in request
      ? sanitizeHistoryRecoveryActionResult(result, request)
      : "kind" in request
        ? sanitizeHistoryRecoveryBrowseResult(result, request)
        : sanitizeHistoryRecoverySnapshotResult(result, request.requestKey);
    assert.ok(sanitized, "real library results must survive the public sanitizer");
    return sanitized;
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  return { page, source, exportPath };
}
