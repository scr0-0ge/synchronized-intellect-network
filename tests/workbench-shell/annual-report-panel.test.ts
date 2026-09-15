import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium, type Browser } from "playwright";
import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type { WorkbenchAnnualReportSnapshot } from "../../src/workbench-shell/contract.ts";
import { createViteBrowserTestServer, createViteSsrTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratchRoot = process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
mkdirSync(scratchRoot, { recursive: true });
process.env.TEMP = scratchRoot;
process.env.TMP = scratchRoot;

test("the result panel renders document fields, independent review, exceptions, and document reasons", async () => {
  const server = await createViteSsrTestServer({
    appType: "custom", configFile: false, logLevel: "silent",
    plugins: [solid({ ssr: true })], root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/annual-report-panel.tsx",
    ) as { AnnualReportPanel: (props: Record<string, unknown>) => unknown };
    const html = renderToString(() => module.AnnualReportPanel({
      snapshot: fixture,
      starting: false,
      error: null,
      opening: false,
      onOpenFolder: () => undefined,
    }));
    assert.match(html, /1 passed · 1 need a human · 2 documents/u);
    assert.match(html, /good\.pdf/u);
    assert.match(html, /Revenue by segment/u);
    assert.match(html, /1,234 \(USD millions · FY 2025\)/u);
    assert.match(html, /passed/u);
    assert.match(html, /bad\.pdf/u);
    assert.match(html, /Document reason: text-layer-absent/u);
    assert.match(html, /Exceptions/u);
    assert.match(html, /No cited page was supplied\./u);
    assert.match(html, /Open report folder/u);

    const running = structuredClone(fixture) as any;
    running.job.status = "running";
    running.job.documents = [
      {
        ...fixture.job.documents[0],
        fileName: "skipped.pdf",
        status: "needs-human",
        fields: fixture.job.documents[0]!.fields.map((field) => ({
          ...field, status: "pending", reviewStatus: "pending",
        })),
      },
      {
        ...fixture.job.documents[0],
        fileName: "active.pdf",
        status: "in-progress",
        fields: [
          fixture.job.documents[0]!.fields[0],
          { ...fixture.job.documents[0]!.fields[1], status: "pending", reviewStatus: "pending" },
        ],
      },
    ];
    running.records = null;
    const progressHtml = renderToString(() => module.AnnualReportPanel({
      snapshot: running,
      starting: false,
      error: null,
      opening: false,
      onOpenFolder: () => undefined,
    }));
    assert.match(progressHtml, /3 \/ 4 fields · current: active\.pdf · geo/u);
  } finally {
    await server.close();
  }
});

test("the result panel does not clip or scroll horizontally at three supported widths in both tones", async () => {
  const probeUrl = "/__annual_report_panel_probe";
  const moduleId = "/__annual_report_panel_probe.tsx";
  const plugin: Plugin = {
    name: "annual-report-panel-probe",
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
        import { AnnualReportPanel } from "/src/workbench-shell/renderer/annual-report-panel.tsx";
        document.documentElement.setAttribute("data-skin", "acrylic");
        document.documentElement.setAttribute("data-glass", "full");
        const snapshot = ${JSON.stringify(fixture)};
        render(() => AnnualReportPanel({
          snapshot, starting: false, error: null, opening: false, onOpenFolder: () => undefined,
        }), document.querySelector("#probe"));
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
          const panel = document.querySelector<HTMLElement>(".annual-report-panel")!;
          const panelRect = panel.getBoundingClientRect();
          const cells = Array.from(document.querySelectorAll<HTMLElement>(".annual-report-field-row > span"));
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

const fixture: WorkbenchAnnualReportSnapshot = {
  job: {
    schemaVersion: 1,
    status: "completed",
    projectDirectory: ".",
    outputDirectory: "annual-report/20260915-120000",
    startedAt: "2026-09-15T12:00:00.000Z",
    endedAt: "2026-09-15T12:01:00.000Z",
    observedModel: "fake-model",
    configurationVersion: "default-fields-draft-2026-09-14",
    documents: [
      {
        fileName: "good.pdf", status: "needs-human", reason: null,
        pdfPages: 2, textLayer: "present",
        fields: [
          { id: "segment", status: "found", reviewStatus: "passed", attemptMs: 20, error: null },
          { id: "geo", status: "not-found-in-scope", reviewStatus: "needs-human", attemptMs: 10, error: null },
        ],
      },
      {
        fileName: "bad.pdf", status: "needs-human", reason: "text-layer-absent",
        pdfPages: 1, textLayer: "absent", fields: [],
      },
    ],
    stats: {
      pdfFiles: 2, documents: 2, fields: 2, fieldsVerified: 1,
      fieldsNeedingHuman: 1, documentsNeedingHuman: 2,
    },
    report: {
      recordsPath: "annual-report/20260915-120000/records.json",
      markdownPath: "annual-report/20260915-120000/report.md",
      pdfPath: "annual-report/20260915-120000/report.pdf",
      pdfNote: "1000 bytes",
    },
    lastError: null,
  },
  records: [{
    document: { fileName: "good.pdf", pdfPageCount: 2, company: "Good", reportingPeriod: "FY 2025" },
    taskStatus: "needs-human",
    fields: [
      {
        id: "segment", displayName: "Revenue by segment", note: "Note 1",
        status: "found", reviewStatus: "passed", value: "1,234 (USD millions · FY 2025)",
        endReason: "passed", attempts: [{
          n: 1, status: "found", reviewStatus: "passed", checks: [], verdict: "agree", problems: [], failureReason: null,
        }],
      },
      {
        id: "geo", displayName: "Revenue by geography", note: "Note 1",
        status: "not-found-in-scope", reviewStatus: "needs-human", value: null,
        endReason: "extraction-needs-human", attempts: [{
          n: 1, status: "not-found-in-scope", reviewStatus: "needs-human", checks: [],
          verdict: "cannot-verify", problems: [{ code: "no-evidence", message: "No cited page was supplied." }],
          failureReason: null,
        }],
      },
    ],
  }],
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
