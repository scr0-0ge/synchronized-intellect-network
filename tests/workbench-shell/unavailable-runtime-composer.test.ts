import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import { createViteSsrTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("unavailable Runtime composer keeps an empty context slot before the disabled Send button", async () => {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const renderedModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/composer.tsx",
    )) as {
      readonly UnavailableRuntimeComposer: (props: {
        readonly composer: { readonly draft: string };
      }) => unknown;
    };
    const html = renderToString(() =>
      renderedModule.UnavailableRuntimeComposer({
        composer: { draft: "preserved draft" },
      }),
    );
    const inputSideChildren = html.match(
      /<div class="input-side">([\s\S]*?)<\/div>/u,
    )?.[1]?.replace(/<!--[\s\S]*?-->/gu, "");

    assert.equal(
      inputSideChildren,
      '<span></span><button type="button" class="send" disabled>Send <kbd>Ctrl ↵</kbd></button>',
    );
    assert.doesNotMatch(html, /class="ctx-ring"/u);
  } finally {
    await server.close();
  }
});
