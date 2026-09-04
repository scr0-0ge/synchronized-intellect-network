import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import type { WorkbenchWindowRendererBridge } from "../../src/workbench-shell/window-control-bridge.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { emptyVisualFixture } from "./visual-harness/fixture.ts";

type TitlebarComponent = (props: Readonly<Record<string, unknown>>) => unknown;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the renderer titlebar owns the three exact design caption controls", async () => {
  await withTitlebar(async (Titlebar) => {
    const windowBridge = Object.freeze({
      observeState() {
        return (): void => undefined;
      },
      minimize() {},
      toggleMaximize() {},
      close() {},
    }) satisfies WorkbenchWindowRendererBridge;
    const html = renderToString(() =>
      Titlebar({
        view: emptyVisualFixture,
        surface: "project",
        onSurface: (): void => undefined,
        runtimeUnavailable: false,
        windowBridge,
      }),
    );

    assert.match(
      html,
      /<div class="caption-buttons">[\s\S]*aria-label="Minimize" title="Minimize"[\s\S]*data-maximized="false" aria-label="Maximize" title="Maximize"[\s\S]*aria-label="Close" title="Close"[\s\S]*<\/div><\/header>$/u,
    );
    assert.equal(html.match(/class="caption-btn(?: close)?"/gu)?.length, 3);
    assert.match(html, /<path d="M0 5\.5h10"><\/path>/u);
    assert.match(
      html,
      /class="glyph-maximize"[\s\S]*<rect x="0\.5" y="0\.5" width="9" height="9"><\/rect>/u,
    );
    assert.match(
      html,
      /class="glyph-restore"[\s\S]*<path d="M2\.5 2\.5v-2h7v7h-2"><\/path>/u,
    );
    assert.match(html, /<path d="M0\.5 0\.5l9 9M9\.5 0\.5l-9 9"><\/path>/u);
    assert.doesNotMatch(html, />\s*Settings\s*</u);
    assert.doesNotMatch(html, /aria-label="Settings"|title="Settings"|⚙/u);
    assert.doesNotMatch(html, /providers-button|titlebar-actions/u);
  });

  const [source, styles] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/renderer/chrome.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../src/workbench-shell/renderer/styles.css", import.meta.url),
      "utf8",
    ),
  ]);
  const titlebarStart = source.indexOf("export const Titlebar:");
  const titlebarEnd = source.indexOf("export const WorkbenchStatusbar:");
  assert.ok(
    titlebarStart >= 0 && titlebarEnd > titlebarStart,
    "chrome.tsx exposes valid Titlebar source anchors",
  );
  const titlebar = source.slice(titlebarStart, titlebarEnd);
  assert.match(titlebar, /observeState/u);
  assert.match(titlebar, /data-maximized=\{maximized\(\)\}/u);
  assert.match(titlebar, /props\.windowBridge\.minimize\(\)/u);
  assert.match(titlebar, /props\.windowBridge\.toggleMaximize\(\)/u);
  assert.match(titlebar, /props\.windowBridge\.close\(\)/u);
  assert.doesNotMatch(titlebar, /Settings|providers-button|⚙/u);
  assert.doesNotMatch(styles, /\.titlebar-actions\s*\{\s*padding-right:\s*10px;/u);
});

async function withTitlebar(
  assertion: (Titlebar: TitlebarComponent) => Promise<void> | void,
): Promise<void> {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  try {
    const module = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/chrome.tsx",
    )) as { readonly Titlebar: TitlebarComponent };
    await assertion(module.Titlebar);
  } finally {
    await server.close();
  }
}
