import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium, type Browser } from "playwright";
import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type { WorkbenchAutoIterationView } from "../../src/workbench-shell/auto-iteration-view-contract.ts";
import { createViteBrowserTestServer, createViteSsrTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratchRoot = process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
mkdirSync(scratchRoot, { recursive: true });
process.env.TEMP = scratchRoot;
process.env.TMP = scratchRoot;

test("the panel renders the supervisor line, the work order table, waitingFor, inbox, and quota block -- and the unbound fallbacks", async () => {
  const server = await createViteSsrTestServer({
    appType: "custom", configFile: false, logLevel: "silent",
    plugins: [solid({ ssr: true })], root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/auto-iteration-panel.tsx",
    ) as { AutoIterationPanel: (props: Record<string, unknown>) => unknown };
    const html = renderToString(() => module.AutoIterationPanel({ view: fixture }));
    assert.match(html, /project-supervisor/u);
    assert.match(html, /generation 2/u);
    assert.match(html, /active/u);
    assert.match(html, /2 pending inbox/u);
    assert.match(html, /Quota blocked/u);
    assert.match(html, /Last observed/u);
    assert.match(html, /wo-1/u);
    assert.match(html, /wo-2/u);
    assert.match(html, /wo-3/u);
    assert.match(html, /executing/u);
    assert.match(html, /awaiting-review/u);
    assert.match(html, /waiting-for-quota/u);
    assert.match(html, /running/u);
    assert.match(html, /completed/u);
    assert.match(html, /worker-execution/u);
    assert.match(html, /supervisor-review/u);
    // wo-3's own waitingFor is "quota", distinct from the project-level
    // quotaBlocked chip asserted above.
    assert.match(html, /quota</u);
    assert.match(html, /bound/u);
    assert.match(html, />—</u); // the unbound worker Session and the null waitingFor both render an em dash.

    const empty: WorkbenchAutoIterationView = Object.freeze({
      status: "active",
      supervisor: null,
      workOrders: Object.freeze([]),
      pendingInboxEntries: 0,
      quotaBlocked: false,
      lastObservedAt: null,
    });
    const emptyHtml = renderToString(() => module.AutoIterationPanel({ view: empty }));
    assert.match(emptyHtml, /No supervisor is bound yet\./u);
    assert.match(emptyHtml, /No work orders yet\./u);
    assert.match(emptyHtml, /0 pending inbox/u);
    assert.doesNotMatch(emptyHtml, /Quota blocked/u);
    assert.match(emptyHtml, /Last observed never/u);
  } finally {
    await server.close();
  }
});

test("the panel does not clip or scroll horizontally at three supported widths in both tones", async () => {
  const probeUrl = "/__auto_iteration_panel_probe";
  const moduleId = "/__auto_iteration_panel_probe.tsx";
  const plugin: Plugin = {
    name: "auto-iteration-panel-probe",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== probeUrl) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<main id="probe"></main><script type="module" src="${moduleId}"></script>`);
      });
    },
    resolveId(id) { if (id === moduleId) return id; },
    load(id) {
      if (id !== moduleId) return;
      return `
        import { render } from "solid-js/web";
        import "/src/workbench-shell/renderer/styles.css";
        import "/src/workbench-shell/renderer/themes/theme-acrylic.css";
        import { AutoIterationPanel } from "/src/workbench-shell/renderer/auto-iteration-panel.tsx";
        document.documentElement.setAttribute("data-skin", "acrylic");
        document.documentElement.setAttribute("data-glass", "full");
        const view = ${JSON.stringify(fixture)};
        render(() => AutoIterationPanel({ view }), document.querySelector("#probe"));
      `;
    },
  };
  const server = await createViteBrowserTestServer({
    appType: "custom", configFile: false, logLevel: "silent",
    plugins: [plugin, solid()], root: repositoryRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address !== null && typeof address === "object");
    browser = await chromium.launch({ executablePath: installedChromiumExecutable(), headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}${probeUrl}`);
    for (const width of [620, 900, 1440]) {
      for (const tone of ["dark", "light"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((nextTone) => {
          if (nextTone === "light") document.documentElement.setAttribute("data-tone", "light");
          else document.documentElement.removeAttribute("data-tone");
        }, tone);
        const geometry = await page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>(".auto-iteration-panel")!;
          const panelRect = panel.getBoundingClientRect();
          const cells = Array.from(document.querySelectorAll<HTMLElement>(".auto-iteration-work-order-row > span"));
          return {
            pageScrollWidth: document.documentElement.scrollWidth,
            pageClientWidth: document.documentElement.clientWidth,
            panelScrollWidth: panel.scrollWidth,
            panelClientWidth: panel.clientWidth,
            cellsInside: cells.every((cell) => {
              const rect = cell.getBoundingClientRect();
              return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1;
            }),
          };
        });
        assert.equal(geometry.pageScrollWidth, geometry.pageClientWidth, `${width}px ${tone} page`);
        assert.equal(geometry.panelScrollWidth, geometry.panelClientWidth, `${width}px ${tone} panel`);
        assert.equal(geometry.cellsInside, true, `${width}px ${tone} cells`);
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

const fixture: WorkbenchAutoIterationView = {
  status: "active",
  supervisor: { roleSlotId: "project-supervisor", generation: 2, tenureStatus: "active" },
  workOrders: [
    {
      workOrderId: "wo-1", status: "executing", attemptCount: 1,
      workerSessionBound: true, workerRuntimeLifecycle: "running",
      delivered: false, reviewDecided: false, integrated: false,
      waitingFor: "worker-execution",
    },
    {
      workOrderId: "wo-2", status: "awaiting-review", attemptCount: 1,
      workerSessionBound: true, workerRuntimeLifecycle: "completed",
      delivered: true, reviewDecided: false, integrated: false,
      waitingFor: "supervisor-review",
    },
    {
      workOrderId: "wo-3", status: "waiting-for-quota", attemptCount: 2,
      workerSessionBound: false, workerRuntimeLifecycle: "accepted",
      delivered: false, reviewDecided: false, integrated: false,
      waitingFor: "quota",
    },
  ],
  pendingInboxEntries: 2,
  quotaBlocked: true,
  lastObservedAt: Date.parse("2026-09-15T12:00:00.000Z"),
};

function installedChromiumExecutable(): string {
  const executable = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
  assert.ok(executable);
  return executable;
}
