import assert from "node:assert/strict";

import type { Page } from "playwright";

import {
  allInsideViewport,
  centerHits,
  layoutState,
  sameLayout,
} from "./viewport-layout.ts";

export async function inspectProjectActions(
  page: Page,
  expectedSurface: "wide" | "compact",
): Promise<Record<string, unknown>> {
  const beforeLayout = await layoutState(page);
  const trigger = page.getByRole("button", {
    name: "Create or open a Project",
    exact: true,
  });
  assert.equal(await trigger.count(), 1);
  assert.equal(await trigger.isVisible(), true);
  const triggerSurface = await trigger.evaluate((element) =>
    element.closest(".rail") !== null
      ? "wide"
      : element.closest(".stage") !== null
        ? "compact"
        : "unknown",
  );
  assert.equal(triggerSurface, expectedSurface);

  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Project actions",
    exact: true,
  });
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.count(), 1);
  const create = dialog.getByRole("button", {
    name: "Create Project…",
    exact: true,
  });
  const open = dialog.getByRole("button", {
    name: "Open Project…",
    exact: true,
  });
  assert.equal(await create.count(), 1);
  assert.equal(await open.count(), 1);
  const rectanglesInViewport = await allInsideViewport(dialog, create, open);
  const centerHitTargets = (await centerHits(create)) && (await centerHits(open));
  const initialFocusInside = await dialog.evaluate((element) =>
    element.contains(document.activeElement),
  );
  await page.keyboard.press("Tab");
  const tabReachesAction = await dialog.evaluate((element) =>
    element.contains(document.activeElement),
  );
  const layoutStable = sameLayout(beforeLayout, await layoutState(page));
  await page.keyboard.press("Escape");
  const escapeClosed = (await dialog.count()) === 0;
  const focusReturned = await trigger.evaluate(
    (element) => document.activeElement === element,
  );
  await trigger.focus();
  await page.keyboard.press("Space");
  await dialog.waitFor({ state: "visible" });
  const spaceOpened = await dialog.isVisible();
  await page.keyboard.press("Escape");

  const observation = {
    triggerCount: 1,
    triggerSurface,
    dialogCount: 1,
    actionCounts: { create: 1, open: 1 },
    rectanglesInViewport,
    centerHitTargets,
    initialFocusInside,
    tabReachesAction,
    escapeClosed,
    focusReturned,
    spaceOpened,
    layoutStable,
  };
  assert.deepEqual(observation, {
    triggerCount: 1,
    triggerSurface: expectedSurface,
    dialogCount: 1,
    actionCounts: { create: 1, open: 1 },
    rectanglesInViewport: true,
    centerHitTargets: true,
    initialFocusInside: true,
    tabReachesAction: true,
    escapeClosed: true,
    focusReturned: true,
    spaceOpened: true,
    layoutStable: true,
  });
  return observation;
}
