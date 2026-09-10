import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  type CDPSession,
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
const qaOrigin = "http://127.0.0.1:4196";
const outputDirectoryArgument = process.argv.indexOf("--output-dir");
const outputDirectory = resolve(
  outputDirectoryArgument < 0
    ? "test-results/transcript-density"
    : (process.argv[outputDirectoryArgument + 1] ??
      "test-results/transcript-density"),
);
const viewportWidths = Object.freeze([
  360, 400, 440, 479, 480, 481, 520, 560, 600, 619, 620, 621, 700, 779, 780,
  781,
]);
const isolatedProfile = await mkdtemp(
  join(resolve(tmpdir()), "workbench-transcript-density-"),
);
const server = await createServer({
  configFile: resolve(projectRoot, "vite.qa.config.ts"),
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 4196, strictPort: true },
});
let application: ElectronApplication | undefined;

try {
  await mkdir(outputDirectory, { recursive: true });
  await server.listen();
  application = await electron.launch({
    args: [electronMain],
    env: {
      ...process.env,
      UAW_QA_URL: `${qaOrigin}/?scenario=transcript-density&phase=active&turns=1&locale=en`,
      UAW_QA_USER_DATA_DIR: isolatedProfile,
      UAW_QA_WIDTH: "1280",
      UAW_QA_HEIGHT: "820",
    },
  });
  const page = await application.firstWindow();
  const launchSafety = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("missing QA window");
    const primary = screen.getPrimaryDisplay().bounds;
    window.setBounds({
      x: primary.x + primary.width + 64,
      y: primary.y,
      width: 1280,
      height: 820,
    });
    window.setFocusable(false);
    window.webContents.setBackgroundThrottling(false);
    window.showInactive();
    return {
      bounds: window.getBounds(),
      display: primary,
      focusable: window.isFocusable(),
      focused: window.isFocused(),
      visible: window.isVisible(),
    };
  });
  await page.locator(".turn-progress", { hasText: "Bash npm test" }).waitFor();

  const active = await readDensity(page);
  assert.equal(active.progress, "Bash npm test");
  assert.equal(active.fileSummaries.length, 2);
  assert.equal(active.suggestions.length, 0);
  assert.ok(active.eventDetails.some((detail) => detail.includes("Read src/renderer/transcript.tsx")));
  assert.ok(active.eventDetails.some((detail) => detail.includes("Edit src/renderer/transcript.tsx")));
  assert.ok(active.eventDetails.some((detail) => detail.includes("Bash npm test")));
  assert.ok(active.answerCharacters > active.supportCharacters * 4);
  const activeWidths = await scanWidths(page, "active");

  await page.goto(
    `${qaOrigin}/?scenario=transcript-density&phase=completed&turns=1&locale=en`,
  );
  await page.getByRole("button", { name: "Check the remaining tests" }).waitFor();
  const completed = await readDensity(page);
  assert.equal(completed.progress, null);
  assert.equal(completed.fileSummaries.length, 2);
  assert.equal(completed.suggestions.length, 3);
  assert.ok(completed.answerCharacters > completed.supportCharacters * 4);
  const completedWidths = await scanWidths(page, "completed");

  await page
    .getByRole("button", { name: "Check the remaining tests" })
    .click();
  assert.equal(
    await page.getByRole("textbox", { name: "Reply to this Agent Session…" }).inputValue(),
    "Check the remaining tests",
  );
  assert.equal(
    await page.locator("html").getAttribute("data-qa-submission-calls"),
    "0",
  );

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(
    `${qaOrigin}/?scenario=transcript-density&phase=completed&turns=60&locale=en`,
  );
  await page.getByRole("button", { name: "Check the remaining tests" }).waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await measureProgrammaticScroll(page);
  const beforeMetrics = await cdp.send("Performance.getMetrics");
  const performance = await measureProgrammaticScroll(page, cdp, beforeMetrics.metrics);
  await cdp.detach();
  assert.equal(
    performance.over50,
    0,
    `60-turn transcript regressed above 50 ms: ${JSON.stringify(performance)}`,
  );
  assert.equal(performance.frames, 90);

  const result = Object.freeze({
    fixture: "seeded-production-renderer",
    liveProviderTurns: 0,
    launchSafety,
    viewportWidths,
    active,
    activeWidths,
    completed,
    completedWidths,
    performance,
  });
  await writeFile(
    join(outputDirectory, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`TRANSCRIPT_DENSITY_SMOKE ${JSON.stringify(result)}\n`);
} finally {
  await application?.close();
  await server.close();
  await rm(isolatedProfile, { recursive: true, force: true });
}

async function readDensity(page: Page): Promise<{
  readonly progress: string | null;
  readonly fileSummaries: readonly string[];
  readonly suggestions: readonly string[];
  readonly eventDetails: readonly string[];
  readonly answerCharacters: number;
  readonly supportCharacters: number;
}> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".turn:not(.turn-user) .turn-body");
    if (body === null) throw new Error("missing agent turn body");
    const fileSummaries = Array.from(
      body.querySelectorAll<HTMLElement>(".turn-file-changes"),
      (element) => element.innerText.trim(),
    );
    const progress = body.querySelector<HTMLElement>(".turn-progress")
      ?.innerText.trim() ?? null;
    const answerCharacters = Array.from(body.children)
      .filter(
        (element) =>
          !element.classList.contains("turn-file-changes") &&
          !element.classList.contains("turn-progress"),
      )
      .reduce((total, element) => total + (element.textContent?.trim().length ?? 0), 0);
    const suggestions = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".prompt-suggestion"),
      (element) => element.innerText.trim(),
    );
    const eventDetails = Array.from(
      document.querySelectorAll<HTMLElement>(".event-log li"),
      (element) => element.innerText.replace(/\s+/gu, " ").trim(),
    );
    return {
      progress,
      fileSummaries,
      suggestions,
      eventDetails,
      answerCharacters,
      supportCharacters:
        fileSummaries.join("").length + (progress?.length ?? 0),
    };
  });
}

async function scanWidths(
  page: Page,
  phase: "active" | "completed",
): Promise<readonly unknown[]> {
  const readings: unknown[] = [];
  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 820 });
    await page.evaluate(
      () => new Promise<void>((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
      ),
    );
    const reading = await page.evaluate((currentPhase) => {
      const stage = document.querySelector<HTMLElement>(".stage");
      const transcript = document.querySelector<HTMLElement>(".transcript");
      const summaries = Array.from(
        document.querySelectorAll<HTMLElement>(".turn-file-changes"),
      );
      const summary = summaries.at(-1);
      const progress = document.querySelector<HTMLElement>(".turn-progress");
      const suggestions = document.querySelector<HTMLElement>(".prompt-suggestions");
      const suggestionList = document.querySelector<HTMLElement>(".prompt-suggestion-list");
      const controlbar = document.querySelector<HTMLElement>(".composer > .controlbar");
      const composer = document.querySelector<HTMLElement>(".composer");
      if (stage === null || transcript === null || summary === undefined || composer === null) {
        throw new Error("missing density surface");
      }
      const viewportWidth = document.documentElement.clientWidth;
      const stageRect = stage.getBoundingClientRect();
      const transcriptRect = transcript.getBoundingClientRect();
      const summaryRect = summary.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const summaryReachable = summaries.every((element) => {
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return rect.bottom > transcriptRect.top && rect.top < transcriptRect.bottom;
      });
      let progressReachable: boolean | null = null;
      if (progress !== null) {
        progress.scrollIntoView({ block: "center" });
        const progressRect = progress.getBoundingClientRect();
        progressReachable =
          progressRect.bottom > transcriptRect.top &&
          progressRect.top < transcriptRect.bottom;
      }
      let firstSuggestionReachable: boolean | null = null;
      let lastSuggestionReachable: boolean | null = null;
      let suggestionOverflow = 0;
      if (suggestionList !== null) {
        const buttons = suggestionList.querySelectorAll<HTMLButtonElement>(
          ".prompt-suggestion",
        );
        const listRect = suggestionList.getBoundingClientRect();
        suggestionList.scrollLeft = 0;
        const firstRect = buttons.item(0).getBoundingClientRect();
        firstSuggestionReachable = firstRect.left >= listRect.left - 1;
        suggestionList.scrollLeft = suggestionList.scrollWidth;
        const lastRect = buttons.item(buttons.length - 1).getBoundingClientRect();
        lastSuggestionReachable = lastRect.right <= listRect.right + 1;
        suggestionOverflow = suggestionList.scrollWidth - suggestionList.clientWidth;
        suggestionList.scrollLeft = 0;
      }
      let firstControlReachable: boolean | null = null;
      let lastControlReachable: boolean | null = null;
      let controlOverflow = 0;
      if (controlbar !== null) {
        const controls = Array.from(controlbar.children).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement &&
            !element.classList.contains("chip-spacer") &&
            getComputedStyle(element).display !== "none",
        );
        const controlRect = controlbar.getBoundingClientRect();
        controlbar.scrollLeft = 0;
        const firstRect = controls.at(0)?.getBoundingClientRect();
        firstControlReachable = firstRect === undefined
          ? null
          : firstRect.left >= controlRect.left - 1;
        controlbar.scrollLeft = controlbar.scrollWidth;
        const lastRect = controls.at(-1)?.getBoundingClientRect();
        lastControlReachable = lastRect === undefined
          ? null
          : lastRect.right <= controlRect.right + 1;
        controlOverflow = controlbar.scrollWidth - controlbar.clientWidth;
        controlbar.scrollLeft = 0;
      }
      const withinStage = (rect: DOMRect): boolean =>
        rect.left >= stageRect.left - 1 && rect.right <= stageRect.right + 1;
      return {
        phase: currentPhase,
        viewportWidth,
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        transcriptOverflow: transcript.scrollWidth - transcript.clientWidth,
        stageWidth: Math.round(stageRect.width),
        stageHeight: Math.round(stageRect.height),
        transcriptHeight: Math.round(transcriptRect.height),
        summaryHeight: Math.round(summaryRect.height),
        summaryWithinStage: summaries.every((element) =>
          withinStage(element.getBoundingClientRect())
        ),
        summaryReachable,
        progressWithinStage:
          progress === null ? null : withinStage(progress.getBoundingClientRect()),
        progressReachable,
        suggestionsWithinStage:
          suggestions === null ? null : withinStage(suggestions.getBoundingClientRect()),
        suggestionsHeight:
          suggestions === null ? null : Math.round(suggestions.getBoundingClientRect().height),
        composerHeight: Math.round(composerRect.height),
        composerWithinStage: withinStage(composerRect),
        composerBottomVisible: composerRect.bottom <= stageRect.bottom + 1,
        suggestionOverflow,
        firstSuggestionReachable,
        lastSuggestionReachable,
        controlOverflow,
        firstControlReachable,
        lastControlReachable,
      };
    }, phase);
    if (width === 360 || width === 480 || width === 620) {
      await page.screenshot({
        path: join(outputDirectory, `${phase}-${width}.png`),
      });
    }
    assert.equal(reading.viewportWidth, width);
    assert.equal(reading.documentOverflow, 0);
    assert.ok(reading.transcriptOverflow <= 1);
    assert.equal(reading.summaryWithinStage, true);
    assert.equal(reading.summaryReachable, true);
    assert.equal(reading.composerWithinStage, true);
    assert.equal(
      reading.composerBottomVisible,
      true,
      `composer crossed the stage at ${width}px: ${JSON.stringify(reading)}`,
    );
    assert.ok(
      reading.transcriptHeight >= 100,
      `transcript viewport collapsed at ${width}px: ${JSON.stringify(reading)}`,
    );
    if (phase === "active") {
      assert.equal(reading.progressWithinStage, true);
      assert.equal(reading.progressReachable, true);
      assert.equal(reading.suggestionsWithinStage, null);
    } else {
      assert.equal(reading.progressWithinStage, null);
      assert.equal(reading.suggestionsWithinStage, true);
      assert.equal(reading.firstSuggestionReachable, true);
      assert.equal(reading.lastSuggestionReachable, true);
      assert.equal(reading.firstControlReachable, true);
      assert.equal(reading.lastControlReachable, true);
    }
    readings.push(reading);
  }
  return Object.freeze(readings);
}

async function measureProgrammaticScroll(
  page: Page,
  cdp?: CDPSession,
  beforeMetrics?: readonly { readonly name: string; readonly value: number }[],
): Promise<{
  readonly step: number;
  readonly direction: "down";
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly frames: number;
  readonly frameDurationsMilliseconds: readonly number[];
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maxMilliseconds: number;
  readonly over16_7: number;
  readonly over50: number;
  readonly transcriptNodes: number;
  readonly cdpTaskDurationMilliseconds?: number;
}> {
  const measurement = await page.evaluate(async () => {
    const transcript = document.querySelector<HTMLElement>(".transcript");
    if (transcript === null) throw new Error("missing transcript");
    transcript.scrollTop = 0;
    await new Promise<void>((wake) => requestAnimationFrame(() => wake()));
    const frames: number[] = [];
    const step = Math.max(120, Math.floor(transcript.scrollHeight / 90));
    let previous = performance.now();
    for (let index = 0; index < 90; index += 1) {
      transcript.scrollTop = Math.min(
        transcript.scrollTop + step,
        transcript.scrollHeight,
      );
      await new Promise<void>((wake) => requestAnimationFrame(() => wake()));
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
    }
    const sorted = [...frames].sort((left, right) => left - right);
    const at = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
    const round = (value: number): number => Math.round(value * 10) / 10;
    return {
      step,
      direction: "down" as const,
      scrollHeight: transcript.scrollHeight,
      scrollTop: transcript.scrollTop,
      frames: frames.length,
      frameDurationsMilliseconds: frames.map(round),
      medianMilliseconds: round(at(0.5)),
      p95Milliseconds: round(at(0.95)),
      maxMilliseconds: round(sorted.at(-1)!),
      over16_7: frames.filter((value) => value > 16.7).length,
      over50: frames.filter((value) => value > 50).length,
      transcriptNodes: transcript.querySelectorAll("*").length,
    };
  });
  if (cdp === undefined || beforeMetrics === undefined) return measurement;
  const afterMetrics = (await cdp.send("Performance.getMetrics")).metrics;
  const metric = (
    metrics: readonly { readonly name: string; readonly value: number }[],
    name: string,
  ): number => metrics.find((entry) => entry.name === name)?.value ?? 0;
  return Object.freeze({
    ...measurement,
    cdpTaskDurationMilliseconds: Math.round(
      (metric(afterMetrics, "TaskDuration") -
        metric(beforeMetrics, "TaskDuration")) *
        10_000,
    ) / 10,
  });
}
