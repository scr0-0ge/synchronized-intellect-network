import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, type ElectronApplication } from "playwright";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const electronMain = fileURLToPath(
  new URL(
    "../workbench-shell/visual-harness/electron-smoke-main.mjs",
    import.meta.url,
  ),
);
const qaOrigin = "http://127.0.0.1:4194";
const isolatedProfile = await mkdtemp(
  join(resolve(tmpdir()), "workbench-transcript-search-"),
);
const server = await createServer({
  configFile: resolve(projectRoot, "vite.qa.config.ts"),
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 4194, strictPort: true },
});
let application: ElectronApplication | undefined;

try {
  await server.listen();
  application = await electron.launch({
    args: [electronMain],
    env: {
      ...process.env,
      UAW_QA_URL: `${qaOrigin}/?scenario=transcript-performance&locale=en`,
      UAW_QA_USER_DATA_DIR: isolatedProfile,
      UAW_QA_WIDTH: "1280",
      UAW_QA_HEIGHT: "820",
    },
  });
  const page = await application.firstWindow();
  const actualUserData = await application.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  assert.equal(resolve(actualUserData), resolve(isolatedProfile));
  await page.waitForSelector(".timeline-group");

  const search = page.locator(".transcript-search-input");
  await search.fill("NO_SUCH_TRANSCRIPT_TOKEN");
  await page.waitForFunction(
    () =>
      document.querySelector(".transcript-search-count")?.textContent?.trim() ===
      "0 of 500 turns",
  );
  const emptyResultText = await page.locator(".timeline-window").innerText();
  assert.match(
    emptyResultText,
    /No matching turns/u,
    "an empty search result explains why the transcript body is empty",
  );

  await search.fill("PERF_SEARCH_NEEDLE");
  await page.waitForFunction(
    () =>
      document.querySelector(".transcript-search-count")?.textContent?.trim() ===
      "2 of 500 turns",
  );
  const highlightedMatches = await page
    .locator("mark[data-transcript-search-match]")
    .allTextContents();
  assert.deepEqual(
    highlightedMatches,
    ["PERF_SEARCH_NEEDLE", "PERF_SEARCH_NEEDLE"],
    "every rendered literal match is visually marked",
  );

  await search.fill("PERF_DEEP_NEEDLE");
  const firstDeepMatch = page.locator(
    "mark[data-transcript-search-match]",
  ).first();
  await firstDeepMatch.waitFor();
  await page.waitForFunction(
    () => {
      const match = document.querySelector<HTMLElement>(
        "mark[data-transcript-search-match]",
      );
      const scroller = match?.closest(".transcript");
      if (match === null || !(scroller instanceof HTMLElement)) return false;
      const matchRect = match.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      return (
        matchRect.top >= scrollerRect.top &&
        matchRect.bottom <= scrollerRect.bottom
      );
    },
    undefined,
    { timeout: 2_000 },
  );
  const firstMatchPlacement = await firstDeepMatch.evaluate((match) => {
    const scroller = match.closest(".transcript");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("the search match has no transcript scroller");
    }
    const matchRect = match.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      visible:
        matchRect.top >= scrollerRect.top &&
        matchRect.bottom <= scrollerRect.bottom,
      scrollTop: scroller.scrollTop,
      matchTop: matchRect.top,
      scrollerTop: scrollerRect.top,
      scrollerBottom: scrollerRect.bottom,
    };
  });
  assert.equal(
    firstMatchPlacement.visible,
    true,
    `search must scroll the first literal match into view: ${JSON.stringify(firstMatchPlacement)}`,
  );

  await search.fill("turn-completed");
  await page.waitForFunction(
    () =>
      document.querySelector(".transcript-search-count")?.textContent?.trim() ===
      "500 of 500 turns",
  );
  const normalizedEventMatch = page
    .locator("mark[data-transcript-search-match]")
    .first();
  assert.equal(
    await normalizedEventMatch.textContent(),
    "turn-completed",
    "a normalized-event match reveals and marks its visible event label",
  );

  process.stdout.write(
    `TRANSCRIPT_SEARCH_SMOKE ${JSON.stringify({
      isolatedUserData: resolve(actualUserData) === resolve(isolatedProfile),
      emptyResultText,
      highlightedMatches,
      firstMatchPlacement,
      normalizedEventMatch: await normalizedEventMatch.textContent(),
    })}\n`,
  );
} finally {
  await application?.close();
  await server.close();
  await rm(isolatedProfile, { recursive: true, force: true });
}
