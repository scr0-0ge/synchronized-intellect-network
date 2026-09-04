import assert from "node:assert/strict";

import type { Page } from "playwright";

import { oldHistoryMarker } from "./fixture.ts";

export async function inspectFreshStart(
  page: Page,
): Promise<Record<string, unknown>> {
  const sessionRows = page.locator(".rail .session-row");
  await sessionRows.first().waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText(oldHistoryMarker, { exact: false }).waitFor({
    state: "visible",
  });
  const originalOrder = await sessionRows.allTextContents();
  const originalTitle = compactText(
    (await page.locator(".stage-title").textContent()) ?? "",
  );
  const oldPoint = await page
    .getByText(oldHistoryMarker, { exact: false })
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

  await page.locator(".rail .rail-action").click();
  await page.locator(".fresh-start-state").waitFor({ state: "visible" });
  const markerDomCount = await page
    .getByText(oldHistoryMarker, { exact: false })
    .count();
  const markerInAccessibilityTree = (await accessibilityNames(page)).some(
    (name) => name.includes(oldHistoryMarker),
  );
  const focusableTranscriptCount = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) =>
        element.getClientRects().length > 0 &&
        element.closest(".transcript") !== null,
    ).length,
  );
  const oldPointHitsTranscript = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit?.closest(".transcript") !== null;
  }, oldPoint);
  const stageTitle = compactText(
    (await page.locator(".stage-title").textContent()) ?? "",
  );
  const statusbarText = compactText(
    (await page.locator(".statusbar").textContent()) ?? "",
  );
  const composer = {
    textareaEnabled: await page.locator("#direct-input").isEnabled(),
    endpointControlEnabled: await page
      .locator("#direct-runtime-endpoint")
      .isEnabled(),
    sendVisible: await page
      .getByRole("button", { name: /^Start\b/u })
      .isVisible(),
  };
  const freshObservation = {
    markerDomCount,
    markerInAccessibilityTree,
    focusableTranscriptCount,
    oldPointHitsTranscript,
    transcriptCount: await page.locator(".transcript").count(),
    selectedSessionCount: await page
      .locator('.session-row[aria-current="true"]')
      .count(),
    stageTitle,
    oldTitleAbsent: stageTitle !== originalTitle,
    inspectorCount: await page.locator(".inspector").count(),
    oldStatusAbsent:
      !statusbarText.includes("Fixture model") &&
      !statusbarText.includes("Fixture effort"),
    composer,
  };
  assert.deepEqual(freshObservation, {
    markerDomCount: 0,
    markerInAccessibilityTree: false,
    focusableTranscriptCount: 0,
    oldPointHitsTranscript: false,
    transcriptCount: 0,
    selectedSessionCount: 0,
    stageTitle: "New Agent Session",
    oldTitleAbsent: true,
    inspectorCount: 0,
    oldStatusAbsent: true,
    composer: {
      textareaEnabled: true,
      endpointControlEnabled: true,
      sendVisible: true,
    },
  });

  await page
    .getByRole("button", {
      name: "Return to selected Session",
      exact: true,
    })
    .click();
  await page.getByText(oldHistoryMarker, { exact: false }).waitFor({
    state: "visible",
  });
  const restore = {
    markerCount: await page.getByText(oldHistoryMarker, { exact: false }).count(),
    orderMatches:
      JSON.stringify(await sessionRows.allTextContents()) ===
      JSON.stringify(originalOrder),
    selected: await sessionRows.first().getAttribute("aria-current"),
  };
  assert.deepEqual(restore, {
    markerCount: 1,
    orderMatches: true,
    selected: "true",
  });
  return { ...freshObservation, restore };
}

async function accessibilityNames(page: Page): Promise<readonly string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send("Accessibility.getFullAXTree");
    return tree.nodes
      .filter((node) => node.ignored !== true)
      .map((node) => node.name?.value)
      .filter((value): value is string => typeof value === "string");
  } finally {
    await session.detach();
  }
}

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
