import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import { createViteSsrTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("Inspector facts preserve caller-supplied punctuation and casing", async () => {
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
      "/src/workbench-shell/renderer/inspector.tsx",
    )) as {
      readonly InspectorFact: (props: {
        readonly label: string;
        readonly value: string;
      }) => unknown;
    };
    const facts = [
      { label: "Name", value: "unified-ai-workbench" },
      { label: "Model", value: "GPT-5.6-Sol" },
      { label: "Model", value: "GPT-5.4-Mini" },
    ] as const;

    const renderedValues = facts.map(({ label, value }) => {
      const html = renderToString(() =>
        renderedModule.InspectorFact({ label, value }),
      );

      return html.match(/<dd[^>]*>([^<]*)<\/dd>/u)?.[1];
    });

    assert.deepEqual(renderedValues, [
      "unified-ai-workbench",
      "GPT-5.6-Sol",
      "GPT-5.4-Mini",
    ]);
  } finally {
    await server.close();
  }
});
