import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const electronMain = fileURLToPath(
  new URL(
    "../workbench-shell/visual-harness/electron-smoke-main.mjs",
    import.meta.url,
  ),
);
const qaOrigin = "http://127.0.0.1:4192";

interface TranscriptMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distanceFromBottom: number;
  readonly jumpLatestVisible: boolean;
  readonly firstGroup: number | null;
  readonly lastGroup: number | null;
}

interface Observation {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly raw?: unknown;
  readonly error?: string;
}

type DetachMethod = "scrollbar-drag" | "keyboard-page-up" | "wheel";

const observations: Observation[] = [];
const isolatedProfile = await mkdtemp(
  join(resolve(tmpdir()), "workbench-transcript-follow-"),
);
const server = await createServer({
  configFile: resolve(projectRoot, "vite.qa.config.ts"),
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 4192, strictPort: true },
});
let application: ElectronApplication | undefined;

try {
  await server.listen();
  application = await electron.launch({
    args: [electronMain],
    env: {
      ...process.env,
      UAW_QA_URL: `${qaOrigin}/?scenario=transcript-follow-scroll&turns=80`,
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

  for (const method of [
    "scrollbar-drag",
    "keyboard-page-up",
    "wheel",
  ] as const) {
    await observe(`A1-${method}`, async () =>
      observeStreamingDetach(page, method),
    );
  }
  await observe("A2-bottom-only-reattach", async () =>
    observeBottomOnlyReattach(page),
  );
  await observe("A3-measured-anchor", async () =>
    observeMeasuredAnchor(page),
  );
  await observe("A4-keyed-disclosure", async () =>
    observeKeyedDisclosure(page),
  );
  await observe("A5-short-transcript-follow", async () =>
    observeShortTranscript(page),
  );
  await observe("A6-programmatic-baseline", async () =>
    observeProgrammaticLatestSequence(page),
  );

  process.stdout.write(
    `TRANSCRIPT_FOLLOW_SCROLL_SMOKE ${JSON.stringify({
      fixture: "seeded-local",
      isolatedUserData: resolve(actualUserData) === resolve(isolatedProfile),
      observations,
    })}\n`,
  );
  const failures = observations.filter((observation) => observation.status === "fail");
  assert.deepEqual(
    failures.map((failure) => failure.id),
    [],
    failures.map((failure) => `${failure.id}: ${failure.error}`).join("\n"),
  );
} finally {
  await application?.close();
  await server.close();
  await rm(isolatedProfile, { recursive: true, force: true });
}

async function observe(
  id: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    observations.push(Object.freeze({ id, status: "pass", raw: await run() }));
  } catch (error) {
    observations.push(
      Object.freeze({
        id,
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function observeStreamingDetach(
  page: Page,
  method: DetachMethod,
): Promise<unknown> {
  await openFixture(page, 80);
  await prepareDetachInput(page, method);
  const before = await transcriptMetrics(page);
  await startStreamingBurst(page, 40);
  await page.waitForFunction(
    (initialHeight) => {
      const scroller = document.querySelector<HTMLElement>(".transcript");
      return scroller !== null && scroller.scrollHeight > initialHeight;
    },
    before.scrollHeight,
    { polling: 5 },
  );
  await page.locator(".transcript").evaluate((scroller) => {
    scroller.dataset.qaDetachInputEvents = "0";
  });
  await applyDetachInput(page, method);
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.qaTranscriptStreamingUpdates === "40",
    undefined,
    { polling: 5 },
  );
  await page.waitForTimeout(150);
  const afterInput = await transcriptMetrics(page);
  const afterStreamingUpdate = await transcriptMetrics(page);
  const streamingUpdates = await page.locator("html").getAttribute(
    "data-qa-transcript-streaming-updates",
  );
  const inputEvents = await page.locator(".transcript").getAttribute(
    "data-qa-detach-input-events",
  );
  assert.ok(
    afterStreamingUpdate.distanceFromBottom > 20,
    `${method} must remain detached throughout streaming updates: ${JSON.stringify({ streamingUpdates, inputEvents, before, afterInput, afterStreamingUpdate })}`,
  );
  assert.equal(afterStreamingUpdate.jumpLatestVisible, true);
  assert.equal(streamingUpdates, "40");
  assert.notEqual(inputEvents, "0", `${method} did not reach the scroller`);
  return Object.freeze({
    streamingUpdates,
    inputEvents,
    before,
    afterInput,
    afterStreamingUpdate,
  });
}

async function observeBottomOnlyReattach(page: Page): Promise<unknown> {
  await openFixture(page, 80);
  await prepareDetachInput(page, "keyboard-page-up");
  const before = await transcriptMetrics(page);
  await startStreamingBurst(page, 40);
  await page.waitForFunction(
    (initialHeight) => {
      const scroller = document.querySelector<HTMLElement>(".transcript");
      return scroller !== null && scroller.scrollHeight > initialHeight;
    },
    before.scrollHeight,
    { polling: 5 },
  );
  await applyDetachInput(page, "keyboard-page-up");
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.qaTranscriptStreamingUpdates === "40",
    undefined,
    { polling: 5 },
  );
  await page.waitForTimeout(150);

  const detached = await transcriptMetrics(page);
  assert.equal(
    detached.jumpLatestVisible,
    true,
    `pending keyboard detach did not stick: ${JSON.stringify(detached)}`,
  );
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - 12,
    );
    scroller.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(150);
  const nearBottom = await transcriptMetrics(page);
  assert.ok(nearBottom.distanceFromBottom > 2);
  assert.equal(nearBottom.jumpLatestVisible, true);

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(150);
  const atBottom = await transcriptMetrics(page);
  assert.ok(atBottom.distanceFromBottom <= 2);
  assert.equal(atBottom.jumpLatestVisible, false);
  return Object.freeze({ detached, nearBottom, atBottom });
}

async function observeMeasuredAnchor(page: Page): Promise<unknown> {
  await openFixture(page, 80);
  await installHeldAnimationFrames(page);
  const result = await page.evaluate(() => {
    const controller = window.__qaAnimationFrameController;
    if (controller === undefined) {
      throw new Error("missing QA animation-frame controller");
    }
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    controller.setHeld(true);
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 1_000);
    scroller.dispatchEvent(new Event("scroll"));

    const scrollerTop = scroller.getBoundingClientRect().top;
    const visible = Array.from(
      scroller.querySelectorAll<HTMLElement>(".timeline-group"),
    ).find((group) => group.getBoundingClientRect().bottom > scrollerTop + 1);
    if (visible === undefined) throw new Error("missing measured anchor");
    const anchorIndex = Number(visible.dataset.transcriptGroupIndex);
    const anchorTop = (): number => {
      const anchor = scroller.querySelector<HTMLElement>(
        `[data-transcript-group-index="${anchorIndex}"]`,
      );
      if (anchor === null) throw new Error("measured anchor left the window");
      return anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    };
    const expectedTop = anchorTop();
    const viewportCallbacks = controller.flushBatch();
    const newlyRenderedAbove = Array.from(
      scroller.querySelectorAll<HTMLElement>(".timeline-group"),
    )
      .filter(
        (group) => Number(group.dataset.transcriptGroupIndex) < anchorIndex,
      )
      .sort(
        (left, right) =>
          Number(left.dataset.transcriptGroupIndex) -
          Number(right.dataset.transcriptGroupIndex),
      )[0];
    if (newlyRenderedAbove === undefined) {
      throw new Error("no newly rendered group exists above the measured anchor");
    }
    newlyRenderedAbove.style.paddingBottom = "240px";
    const beforeMeasurementTop = anchorTop();
    const measurementCallbacks = controller.flushBatch();
    const afterMeasurementTop = anchorTop();
    controller.release();
    return {
      anchorIndex,
      expectedTop,
      beforeMeasurementTop,
      afterMeasurementTop,
      viewportCallbacks,
      measurementCallbacks,
      measuredGroupIndex: Number(
        newlyRenderedAbove.dataset.transcriptGroupIndex,
      ),
    };
  });
  assert.ok(result.viewportCallbacks > 0);
  assert.ok(result.measurementCallbacks > 0);
  assert.ok(
    Math.abs(result.beforeMeasurementTop - result.expectedTop) > 2,
    "the fixture must expose a pre-compensation measurement shift",
  );
  assert.ok(
    Math.abs(result.afterMeasurementTop - result.expectedTop) <= 1.25,
    `measured anchor moved by ${result.afterMeasurementTop - result.expectedTop}px`,
  );
  return Object.freeze(result);
}

async function observeKeyedDisclosure(page: Page): Promise<unknown> {
  const turnCount = 80;
  await openFixture(page, turnCount);
  const initial = await transcriptMetrics(page);
  assert.notEqual(initial.firstGroup, null);
  assert.notEqual(initial.lastGroup, null);
  const targetIndex = Math.floor(
    ((initial.firstGroup ?? 0) + (initial.lastGroup ?? 0)) / 2,
  );
  const targetKey = `turn:${targetIndex + 1}:group:1`;
  const targetSelector =
    `.timeline-group[data-transcript-group-key="${targetKey}"]`;
  const target = page.locator(
    `${targetSelector} .disclosure`,
  );
  await target.waitFor({ state: "visible" });
  assert.equal(await target.getAttribute("aria-expanded"), "false");
  await target.click();
  assert.equal(await target.getAttribute("aria-expanded"), "true");
  const controlId = await target.getAttribute("aria-controls");
  assert.ok(controlId);
  const originalGroup = await page.locator(targetSelector).elementHandle();
  assert.ok(originalGroup);
  const selectedText = await page.locator(targetSelector).evaluate((group) => {
    const paragraph = group.querySelector(".turn-body.prose p");
    if (paragraph === null) throw new Error("missing target response paragraph");
    const selection = window.getSelection();
    if (selection === null) throw new Error("missing document selection");
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.addRange(range);
    return selection.toString();
  });
  assert.match(selectedText, new RegExp(`Seeded response ${targetIndex + 1}\\.1`, "u"));

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.scrollTop = Math.max(0, scroller.scrollTop - 800);
    scroller.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(
    ({ firstGroup, key }) => {
      const first = document.querySelector<HTMLElement>(".timeline-group");
      return (
        Number(first?.dataset.transcriptGroupIndex) !== firstGroup &&
        document.querySelector(
          `.timeline-group[data-transcript-group-key="${key}"]`,
        ) !== null
      );
    },
    { firstGroup: initial.firstGroup, key: targetKey },
  );
  const overlap = await originalGroup.evaluate(
    (group, { key, expectedText }) => {
      const current = document.querySelector(
        `.timeline-group[data-transcript-group-key="${key}"]`,
      );
      const selection = window.getSelection();
      const selectedGroup = selection?.anchorNode?.parentElement?.closest<HTMLElement>(
        ".timeline-group",
      );
      return {
        sameNode: current === group,
        connected: group.isConnected,
        controlId: group.querySelector(".disclosure")?.getAttribute("aria-controls"),
        expanded: group.querySelector(".disclosure")?.getAttribute("aria-expanded"),
        selectedText: selection?.toString() ?? "",
        selectedGroupKey: selectedGroup?.dataset.transcriptGroupKey ?? null,
        selectionMatches: selection?.toString() === expectedText,
      };
    },
    { key: targetKey, expectedText: selectedText },
  );
  assert.deepEqual(overlap, {
    sameNode: true,
    connected: true,
    controlId,
    expanded: "true",
    selectedText,
    selectedGroupKey: targetKey,
    selectionMatches: true,
  });

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(
    (key) =>
      document.querySelector(
        `.timeline-group[data-transcript-group-key="${key}"]`,
      ) === null,
    targetKey,
  );
  assert.equal(
    await page.locator(`[aria-controls="${controlId}"]`).count(),
    0,
    "a keyed turn leaving the window must unmount instead of lending its DOM to another turn",
  );

  await page.locator(".transcript-jump-latest").click();
  await waitForBottom(page, turnCount - 1);
  await target.waitFor({ state: "visible" });
  const returnedControlId = await target.getAttribute("aria-controls");
  const returnedExpanded = await target.getAttribute("aria-expanded");
  assert.notEqual(returnedControlId, controlId);
  assert.equal(returnedExpanded, "true");

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(
    (key) =>
      document.querySelector(
        `.timeline-group[data-transcript-group-key="${key}"]`,
      ) === null,
    targetKey,
  );
  const query = `Seeded user turn ${targetIndex + 1}`;
  await page.locator(".transcript-search-input").fill(query);
  const filteredTarget = page.locator(targetSelector);
  await filteredTarget.waitFor({ state: "visible" });
  const searchResult = await filteredTarget.evaluate((group, expected) => {
    const mark = Array.from(
      group.querySelectorAll<HTMLElement>("mark[data-transcript-search-match]"),
    ).find((candidate) => candidate.textContent === expected);
    const scroller = group.closest<HTMLElement>(".transcript");
    if (mark === undefined || scroller === null) {
      throw new Error("missing target search match");
    }
    const matchRect = mark.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return {
      renderedIndex: Number(group.dataset.transcriptGroupIndex),
      expanded: group.querySelector(".disclosure")?.getAttribute("aria-expanded"),
      markedText: mark.textContent,
      visible:
        matchRect.top >= scrollerRect.top && matchRect.bottom <= scrollerRect.bottom,
    };
  }, query);
  assert.deepEqual(searchResult, {
    renderedIndex: 0,
    expanded: "true",
    markedText: query,
    visible: true,
  });
  return Object.freeze({
    targetIndex,
    targetKey,
    controlId,
    overlap,
    returnedControlId,
    returnedExpanded,
    searchResult,
  });
}

async function observeShortTranscript(page: Page): Promise<unknown> {
  await openFixture(page, 1);
  const before = await transcriptMetrics(page);
  assert.ok(
    before.scrollHeight <= before.clientHeight,
    "the seeded short transcript must not overflow",
  );
  await page.locator(".transcript").hover();
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.dataset.qaWheelEvents = "0";
    scroller.addEventListener(
      "wheel",
      () => {
        scroller.dataset.qaWheelEvents = String(
          Number(scroller.dataset.qaWheelEvents ?? "0") + 1,
        );
      },
      { once: true },
    );
  });
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(50);
  const afterWheel = await transcriptMetrics(page);
  const wheelEvents = await page.locator(".transcript").getAttribute(
    "data-qa-wheel-events",
  );
  assert.equal(wheelEvents, "1", "the real wheel input must reach the scroller");
  await page.evaluate(() =>
    window.dispatchEvent(new Event("qa-transcript-follow-scroll-update")),
  );
  await page.waitForTimeout(250);
  const after = await transcriptMetrics(page);
  assert.equal(after.jumpLatestVisible, false);
  assert.ok(after.distanceFromBottom <= 2);
  return Object.freeze({ before, afterWheel, wheelEvents, after });
}

async function observeProgrammaticLatestSequence(page: Page): Promise<unknown> {
  await openFixture(page, 80);
  const before = await transcriptMetrics(page);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("qa-transcript-follow-scroll-update")),
  );
  await page.waitForTimeout(250);
  await waitForBottom(page, 79);
  const afterProgrammaticLatest = await transcriptMetrics(page);
  assert.ok(afterProgrammaticLatest.scrollTop >= before.scrollTop);
  assert.equal(afterProgrammaticLatest.jumpLatestVisible, false);

  await focusScroller(page);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(120);
  const afterBoundaryDown = await transcriptMetrics(page);
  assert.equal(afterBoundaryDown.jumpLatestVisible, false);
  assert.ok(afterBoundaryDown.distanceFromBottom <= 2);

  await page.keyboard.press("PageUp");
  await page.waitForTimeout(150);
  const afterUserUp = await transcriptMetrics(page);
  assert.equal(
    afterUserUp.jumpLatestVisible,
    true,
    `the next upward user scroll was not classified as detach: ${JSON.stringify({ before, afterProgrammaticLatest, afterBoundaryDown, afterUserUp })}`,
  );
  assert.ok(afterUserUp.distanceFromBottom > 20);
  return Object.freeze({
    before,
    afterProgrammaticLatest,
    afterBoundaryDown,
    afterUserUp,
  });
}

async function openFixture(page: Page, turnCount: number): Promise<void> {
  await page.goto(
    `${qaOrigin}/?scenario=transcript-follow-scroll&turns=${turnCount}&locale=en`,
  );
  await page.waitForSelector(".timeline-group");
  await waitForBottom(page, turnCount - 1);
}

async function startStreamingBurst(page: Page, updateCount: number): Promise<void> {
  await page.evaluate((count) => {
    document.documentElement.dataset.qaTranscriptStreamingUpdates = "0";
    let emitted = 0;
    const publish = (): void => {
      emitted += 1;
      document.documentElement.dataset.qaTranscriptStreamingUpdates = String(emitted);
      window.dispatchEvent(new Event("qa-transcript-follow-scroll-update"));
      if (emitted >= count) window.clearInterval(interval);
    };
    const interval = window.setInterval(publish, 5);
    publish();
  }, updateCount);
}

async function prepareDetachInput(
  page: Page,
  method: DetachMethod,
): Promise<void> {
  if (method === "wheel") {
    await page.locator(".transcript").hover();
    await countDetachInputEvents(page, "wheel");
    return;
  }
  if (method === "keyboard-page-up") {
    await focusScroller(page);
    await countDetachInputEvents(page, "keydown");
    return;
  }
  await countDetachInputEvents(page, "scroll");
}

async function countDetachInputEvents(
  page: Page,
  eventName: "keydown" | "scroll" | "wheel",
): Promise<void> {
  await page.evaluate((name) => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.dataset.qaDetachInputEvents = "0";
    scroller.addEventListener(name, () => {
      scroller.dataset.qaDetachInputEvents = String(
        Number(scroller.dataset.qaDetachInputEvents ?? "0") + 1,
      );
    });
  }, eventName);
}

async function applyDetachInput(
  page: Page,
  method: DetachMethod,
): Promise<void> {
  if (method === "wheel") {
    await page.mouse.wheel(0, -650);
    return;
  }
  if (method === "keyboard-page-up") {
    await page.keyboard.press("PageUp");
    return;
  }
  const scrollbar = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    const rect = scroller.getBoundingClientRect();
    return {
      x: rect.right - 5,
      bottom: rect.bottom,
      top: rect.top,
    };
  });
  for (const offset of [4, 8, 12, 16, 20]) {
    const startY = scrollbar.bottom - offset;
    await page.mouse.move(scrollbar.x, startY);
    await page.mouse.down();
    await page.mouse.move(
      scrollbar.x,
      Math.max(scrollbar.top + 20, startY - 140),
    );
    await page.mouse.up();
    const moved = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".transcript");
      if (scroller === null) throw new Error("missing transcript scroller");
      return (
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 20
      );
    });
    if (moved) return;
  }
}

async function focusScroller(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    scroller.tabIndex = -1;
    scroller.focus();
  });
}

async function transcriptMetrics(page: Page): Promise<TranscriptMetrics> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    const groups = Array.from(
      scroller.querySelectorAll<HTMLElement>(".timeline-group"),
    );
    const index = (group: HTMLElement | undefined): number | null => {
      if (group === undefined) return null;
      const parsed = Number(group.dataset.transcriptGroupIndex);
      return Number.isInteger(parsed) ? parsed : null;
    };
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      distanceFromBottom: Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      ),
      jumpLatestVisible:
        document.querySelector(".transcript-jump-latest") !== null,
      firstGroup: index(groups[0]),
      lastGroup: index(groups.at(-1)),
    };
  });
}

async function waitForBottom(page: Page, lastGroup: number): Promise<void> {
  await page.waitForFunction(
    (expectedLastGroup) => {
      const scroller = document.querySelector<HTMLElement>(".transcript");
      const groups = document.querySelectorAll<HTMLElement>(".timeline-group");
      if (scroller === null || groups.length === 0) return false;
      const renderedLastGroup = Number(
        groups.item(groups.length - 1).dataset.transcriptGroupIndex,
      );
      const distance =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      return renderedLastGroup === expectedLastGroup && distance <= 2;
    },
    lastGroup,
    { timeout: 10_000 },
  );
}

async function installHeldAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const qaWindow = window;
    if (qaWindow.__qaAnimationFrameController !== undefined) return;
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    let held = false;
    let nextHandle = 1_000_000;
    const callbacks = new Map<number, FrameRequestCallback>();
    const createController = () => ({
      setHeld(next: boolean): void {
        held = next;
      },
      size(): number {
        return callbacks.size;
      },
      flushBatch(): number {
        const batch = [...callbacks.values()];
        callbacks.clear();
        for (const callback of batch) callback(performance.now());
        return batch.length;
      },
      release(): number {
        held = false;
        return this.flushBatch();
      },
    });
    qaWindow.__qaAnimationFrameController = createController();
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      if (!held) return nativeRequest(callback);
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    };
    window.cancelAnimationFrame = (handle: number): void => {
      if (callbacks.delete(handle)) return;
      nativeCancel(handle);
    };
  });
}

declare global {
  interface Window {
    __qaAnimationFrameController?: {
      setHeld(next: boolean): void;
      size(): number;
      flushBatch(): number;
      release(): number;
    };
  }
}
