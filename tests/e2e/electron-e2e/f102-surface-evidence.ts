import { join } from "node:path";

import type { ElectronApplication, Page } from "playwright";

export async function captureF102SurfaceEvidence(
  application: ElectronApplication,
  page: Page,
  prefix: "before" | "after",
  repositoryRoot: string,
): Promise<void> {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  await page
    .getByRole("heading", { name: "Settings", exact: true, level: 1 })
    .waitFor({ state: "visible", timeout: 10_000 });
  for (const [group, choice] of [
    ["Tone", "Dark"],
    ["CRT", "Off"],
  ] as const) {
    const button = page
      .getByRole("group", { name: group, exact: true })
      .getByRole("button", { name: choice, exact: true });
    await button.click();
    await page.waitForFunction(
      ({ expectedGroup, expectedChoice }) => {
        const attribute = expectedGroup === "Tone" ? "data-tone" : "data-crt";
        const expectedValue =
          (expectedGroup === "Tone" && expectedChoice === "Dark") ||
          (expectedGroup === "CRT" && expectedChoice === "Off")
            ? null
            : expectedChoice.toLocaleLowerCase("en-US");
        return (
          document.documentElement.getAttribute(attribute) === expectedValue
        );
      },
      { expectedGroup: group, expectedChoice: choice },
      { timeout: 10_000 },
    );
  }
  await page
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await page.locator(".transcript .column").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const evidenceDirectory = join(
    repositoryRoot,
    ".scratch",
    "unified-ai-workbench",
    "evidence",
  );
  for (const dimensions of [
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ] as const) {
    await application.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined) throw new Error("f102-window-missing");
        if (window.isMaximized()) window.unmaximize();
        // Resizing must not move the window. center() used to drag it to the
        // middle of the primary display, which is precisely where an offscreen
        // test launch must never appear (issue 161).
        const [originX, originY] = window.getPosition();
        window.setContentSize(size.width, size.height, false);
        window.setPosition(originX, originY);
      },
      dimensions,
    );
    await page.setViewportSize(dimensions);
    await page.waitForFunction(
      (size) => innerWidth === size.width && innerHeight === size.height,
      dimensions,
      { timeout: 10_000 },
    );
    await page.screenshot({
      path: join(
        evidenceDirectory,
        `worker-265-f102-${prefix}-${dimensions.width}x${dimensions.height}.png`,
      ),
      fullPage: false,
      scale: "css",
    });
  }
  const measurements = [];
  for (const dimensions of [
    { width: 3072, height: 1680, label: "owner-maximized-proxy" },
    { width: 3840, height: 2160, label: "unscaled-4k" },
  ] as const) {
    await page.setViewportSize(dimensions);
    for (const maxWidth of ["min(100%, 1100px)", "none"] as const) {
      measurements.push(
        await measureF102ZeroGlyphCapacity(page, dimensions.label, maxWidth),
      );
    }
  }
  await page
    .getByRole("button", { name: "Hide inspector", exact: true })
    .click();
  await page.setViewportSize({ width: 3840, height: 2160 });
  for (const maxWidth of ["min(100%, 1100px)", "none"] as const) {
    measurements.push(
      await measureF102ZeroGlyphCapacity(
        page,
        "unscaled-4k-inspector-collapsed",
        maxWidth,
      ),
    );
  }
  await page
    .getByRole("button", { name: "Show Session panel", exact: true })
    .click();
  console.log(`F102_LINE_MEASURE ${JSON.stringify(measurements)}`);
}

async function measureF102ZeroGlyphCapacity(
  page: Page,
  viewportLabel: string,
  maxWidth: "min(100%, 1100px)" | "none",
): Promise<Record<string, unknown>> {
  return page.locator(".transcript .column").evaluate(
    async (element, options) => {
      if (!(element instanceof HTMLElement)) throw new Error("f102-column-missing");
      const oldValue = element.style.getPropertyValue("max-width");
      const oldPriority = element.style.getPropertyPriority("max-width");
      const probe = document.createElement("div");
      probe.className = "prose";
      probe.style.visibility = "hidden";
      probe.style.pointerEvents = "none";
      probe.textContent = "0".repeat(4096);
      try {
        element.style.setProperty("max-width", options.maxWidth, "important");
        element.append(probe);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const node = probe.firstChild;
        if (!(node instanceof Text)) throw new Error("f102-probe-text-missing");
        const rows = new Map<number, number>();
        const range = document.createRange();
        for (let offset = 0; offset < node.length; offset += 1) {
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getClientRects()[0];
          if (rect === undefined || rect.width <= 0) continue;
          const row = Math.round(rect.top * devicePixelRatio);
          rows.set(row, (rows.get(row) ?? 0) + 1);
        }
        const completeRows = [...rows.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, count]) => count);
        completeRows.pop();
        const columnStyle = getComputedStyle(element);
        const textStyle = getComputedStyle(probe);
        return {
          viewportLabel: options.viewportLabel,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
          inspectorVisible:
            document.querySelector(".inspector")?.getClientRects().length === 1,
          maxWidth: options.maxWidth,
          columnOuterWidth: element.getBoundingClientRect().width,
          textWidth: probe.getBoundingClientRect().width,
          paddingInline:
            Number.parseFloat(columnStyle.paddingLeft) +
            Number.parseFloat(columnStyle.paddingRight),
          font: textStyle.font,
          probe: "repeated digit zero",
          completeRowCount: completeRows.length,
          minimumCharactersPerCompleteLine: Math.min(...completeRows),
          maximumCharactersPerCompleteLine: Math.max(...completeRows),
        };
      } finally {
        probe.remove();
        if (oldValue === "") element.style.removeProperty("max-width");
        else element.style.setProperty("max-width", oldValue, oldPriority);
      }
    },
    { viewportLabel, maxWidth },
  );
}
