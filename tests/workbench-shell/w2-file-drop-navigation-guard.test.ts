import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import solid from "vite-plugin-solid";

import {
  appendDroppedFileTexts,
  resolveDroppedFileTexts,
} from "../../src/workbench-shell/file-drop-bridge.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

interface ComposerModule {
  readonly preventFileDropNavigation: (event: DragEvent) => void;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function dragEvent(types: readonly string[]) {
  let prevented = 0;
  return {
    event: {
      dataTransfer: { types },
      preventDefault: () => {
        prevented += 1;
      },
    } as unknown as DragEvent,
    prevented: () => prevented,
  };
}

test("file drags always prevent navigation, including drops outside the composer", async (t) => {
  const server = await createViteSsrTestServer({
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    root: repositoryRoot,
    plugins: [solid({ ssr: true })],
    server: { middlewareMode: true },
  });
  t.after(() => server.close());

  const composer = await server.ssrLoadModule(
    "/src/workbench-shell/renderer/composer.tsx",
  ) as ComposerModule;
  const fileDrag = dragEvent(["Files"]);
  const textDrag = dragEvent(["text/plain"]);

  composer.preventFileDropNavigation(fileDrag.event);
  composer.preventFileDropNavigation(textDrag.event);

  assert.equal(fileDrag.prevented(), 1, "file drops cannot navigate the BrowserWindow");
  assert.equal(textDrag.prevented(), 0, "ordinary text drags retain their browser behavior");

  const source = await readFile(
    new URL("../../src/workbench-shell/renderer/composer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /window\.addEventListener\("dragover", preventFileDropNavigation\)/u);
  assert.match(source, /window\.addEventListener\("drop", preventFileDropNavigation\)/u);
  assert.match(source, /window\.removeEventListener\("dragover", preventFileDropNavigation\)/u);
  assert.match(source, /window\.removeEventListener\("drop", preventFileDropNavigation\)/u);
});

test("a dropped directory follows the same absolute-path insertion route as a file", () => {
  const directory = { name: "notes" } as File;
  const paths = resolveDroppedFileTexts(
    { files: [{ file: directory, name: directory.name }] },
    { getPathForFile: () => "C:\\work\\notes" },
  );

  assert.deepEqual(paths, ["C:\\work\\notes"]);
  assert.equal(
    appendDroppedFileTexts("Please inspect", paths),
    "Please inspect\nC:\\work\\notes",
  );
});
