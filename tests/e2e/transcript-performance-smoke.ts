import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const viteExecutable = fileURLToPath(
  new URL("../../node_modules/vite/bin/vite.js", import.meta.url),
);
const electronMain = fileURLToPath(
  new URL(
    "../workbench-shell/visual-harness/electron-smoke-main.mjs",
    import.meta.url,
  ),
);
const qaOrigin = "http://127.0.0.1:4191";

interface TranscriptMetrics {
  readonly documentNodes: number;
  readonly transcriptNodes: number;
  readonly renderedGroups: number;
  readonly renderedTurns: number;
  readonly renderedEvents: number;
  readonly firstGroup: number | null;
  readonly lastGroup: number | null;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly distanceFromBottom: number;
}

interface LocaleSmokeResult {
  readonly locale: "en" | "zh-CN";
  readonly initial: TranscriptMetrics;
  readonly history: TranscriptMetrics;
  readonly afterSingleUpdate: TranscriptMetrics;
  readonly afterBurst: TranscriptMetrics;
}

const preview = spawn(
  process.execPath,
  [
    viteExecutable,
    "preview",
    "--config",
    "vite.qa.config.ts",
    "--port",
    "4191",
    "--strictPort",
  ],
  {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let previewOutput = "";
preview.stdout.on("data", (chunk: Buffer) => {
  previewOutput += chunk.toString("utf8");
});
preview.stderr.on("data", (chunk: Buffer) => {
  previewOutput += chunk.toString("utf8");
});

try {
  await waitForPreview(preview);
  const results = Object.freeze([
    await smokeLocale("en"),
    await smokeLocale("zh-CN"),
  ]);
  process.stdout.write(
    `TRANSCRIPT_PERFORMANCE_SMOKE ${JSON.stringify({
      fixtureEvents: 2_000,
      results,
    })}\n`,
  );
} finally {
  await stopPreview(preview);
}

async function smokeLocale(
  locale: "en" | "zh-CN",
): Promise<LocaleSmokeResult> {
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [electronMain],
      env: {
        ...process.env,
        UAW_QA_URL: `${qaOrigin}/?scenario=transcript-performance&locale=${locale}`,
        UAW_QA_WIDTH: "1280",
        UAW_QA_HEIGHT: "820",
      },
    });
    const page = await application.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.waitForSelector(".timeline-group");
    await page.waitForFunction(
      () => document.documentElement.lang === new URL(location.href).searchParams.get("locale"),
    );
    await waitForBottom(page, 499);

    const initial = await transcriptMetrics(page);
    assert.ok(initial.documentNodes < 1_000, "initial document DOM is bounded");
    assert.ok(initial.transcriptNodes < 700, "initial transcript DOM is bounded");
    assert.ok(initial.renderedGroups <= 24, "initial turn-group window is bounded");
    assert.equal(initial.lastGroup, 499);

    await page.keyboard.press("Control+f");
    assert.equal(
      await page.evaluate(
        () => document.activeElement?.classList.contains("transcript-search-input") ?? false,
      ),
      true,
      "Ctrl+F focuses transcript search",
    );
    await page.keyboard.type("PERF_SEARCH_NEEDLE");
    await page.waitForFunction(() => document.querySelectorAll(".timeline-group").length === 2);
    assert.equal(
      (await page.locator(".transcript-search-count").textContent())?.trim(),
      locale === "zh-CN" ? "显示 2 / 500 个回合" : "2 of 500 turns",
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () =>
        (document.querySelector<HTMLInputElement>(".transcript-search-input")?.value ??
          "missing") === "",
    );
    const jumpButton = page.locator(".transcript-jump-latest");
    await jumpButton.waitFor({ state: "visible" });
    assert.equal(
      await jumpButton.getAttribute("aria-label"),
      locale === "zh-CN" ? "回到最新" : "Jump to latest",
    );
    await jumpButton.click();
    await waitForBottom(page, 499);

    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".transcript");
      if (scroller === null) throw new Error("missing transcript scroller");
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 1_200);
      scroller.dispatchEvent(new Event("scroll"));
    });
    await jumpButton.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const first = document
        .querySelector(".timeline-group")
        ?.getAttribute("data-transcript-group-index");
      return first !== null && first !== undefined && Number(first) < 489;
    });
    const history = await transcriptMetrics(page);
    assert.ok(history.renderedGroups <= 28, "history window stays bounded");

    await jumpButton.click();
    await waitForBottom(page, 499);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("qa-transcript-performance-update")),
    );
    await waitForBottom(page, 500);
    const afterSingleUpdate = await transcriptMetrics(page);

    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("qa-transcript-performance-burst", { detail: 510 }),
      ),
    );
    await waitForBottom(page, 509);
    const afterBurst = await transcriptMetrics(page);
    assert.ok(afterBurst.transcriptNodes < 900, "burst leaves transcript DOM bounded");
    assert.ok(afterBurst.renderedGroups <= 28, "burst leaves turn window bounded");
    assert.deepEqual(pageErrors, []);

    return Object.freeze({
      locale,
      initial,
      history,
      afterSingleUpdate,
      afterBurst,
    });
  } finally {
    await application?.close();
  }
}

async function transcriptMetrics(page: Page): Promise<TranscriptMetrics> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".transcript");
    if (scroller === null) throw new Error("missing transcript scroller");
    const groups = Array.from(
      scroller.querySelectorAll<HTMLElement>(".timeline-group"),
    );
    const groupIndex = (element: HTMLElement | undefined): number | null => {
      if (element === undefined) return null;
      const value = Number(element.dataset.transcriptGroupIndex);
      return Number.isInteger(value) ? value : null;
    };
    return {
      documentNodes: document.querySelectorAll("*").length,
      transcriptNodes: scroller.querySelectorAll("*").length,
      renderedGroups: groups.length,
      renderedTurns: scroller.querySelectorAll(".turn").length,
      renderedEvents: scroller.querySelectorAll(".event-log > li").length,
      firstGroup: groupIndex(groups[0]),
      lastGroup: groupIndex(groups.at(-1)),
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      distanceFromBottom: Math.round(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      ),
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

async function waitForPreview(
  processHandle: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (processHandle.exitCode !== null) {
      throw new Error(`QA preview exited early.\n${previewOutput}`);
    }
    try {
      const response = await fetch(qaOrigin);
      if (response.ok) return;
    } catch {
      // The preview listener is not ready yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for QA preview.\n${previewOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopPreview(
  processHandle: ChildProcess,
): Promise<void> {
  if (processHandle.exitCode !== null) return;
  processHandle.kill();
  await Promise.race([
    new Promise<void>((resolve) => processHandle.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}
