import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium, type Browser } from "playwright";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import { createViteBrowserTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratchRoot = process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
mkdirSync(scratchRoot, { recursive: true });
process.env.TEMP = scratchRoot;
process.env.TMP = scratchRoot;

test("slash presets render exactly annual-report and help; Enter starts and Escape closes", async () => {
  const probeUrl = "/__annual_report_composer_probe";
  const moduleId = "/__annual_report_composer_probe.tsx";
  const plugin: Plugin = {
    name: "annual-report-composer-probe",
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
        import { createSignal } from "solid-js";
        import { render } from "solid-js/web";
        import { DirectInputComposer } from "/src/workbench-shell/renderer/composer.tsx";
        import { initialRendererState } from "/src/workbench-shell/renderer/view-model.ts";
        import { visualFixture } from "/tests/workbench-shell/visual-harness/fixture.ts";
        const [draft, setDraft] = createSignal("");
        let starts = 0;
        window.annualReportStarts = () => starts;
        const state = initialRendererState;
        const composer = { ...state.composer, get draft() { return draft(); } };
        const noOp = () => undefined;
        render(() => DirectInputComposer({
          view: visualFixture, selected: undefined, composer, profile: state.profile,
          newSession: state.newSession, projectSwitch: state.projectSwitch,
          projectOpen: state.projectOpen, centered: false, onDraft: setDraft,
          onNavigateComposerHistory: () => null, onLoadProfile: noOp,
          onEnterNewSession: noOp, onCancelNewSession: noOp, onEndpoint: noOp,
          onModel: noOp, onWorkIntensity: noOp, onExecutionMode: noOp,
          onAccessMode: noOp, onUseAsDefault: noOp, onSubmit: noOp,
          onStartAnnualReport: () => { starts += 1; },
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
    const input = page.locator("#direct-input");
    await input.fill("/");
    const menu = page.getByRole("listbox", { name: "Composer presets" });
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("option").allTextContents(), [
      "/annual-reportExtract the default annual-report fields from every PDF in this folder and build the report",
      "/helpList the available composer presets",
    ]);
    await input.press("Enter");
    assert.equal(await page.evaluate(() => (window as any).annualReportStarts()), 1);
    assert.equal(await menu.count(), 0);

    await input.fill("/");
    await menu.waitFor();
    await input.press("Escape");
    assert.equal(await menu.count(), 0);
    assert.equal(await input.inputValue(), "/");

    await input.fill("");
    await input.fill("/");
    await menu.waitFor();
    await input.press("ArrowDown");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "/help");
    assert.equal(await menu.getByText("Available presets").count(), 1);
    assert.equal(await page.evaluate(() => (window as any).annualReportStarts()), 1);
  } finally {
    await browser?.close();
    await server.close();
  }
});

function installedChromiumExecutable(): string {
  const executable = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
  assert.ok(executable);
  return executable;
}
