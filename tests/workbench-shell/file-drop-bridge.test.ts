import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchFilesPreloadBridge,
  appendDroppedFileTexts,
  readWorkbenchFilesBridge,
  resolveDroppedFileTexts,
  type WorkbenchFilesRendererBridge,
} from "../../src/workbench-shell/file-drop-bridge.ts";

function fakeFile(name: string): File {
  return { name } as unknown as File;
}

function bridgeWith(paths: readonly (string | undefined)[]): WorkbenchFilesRendererBridge {
  let index = 0;
  return Object.freeze({
    getPathForFile: () => paths[index++] ?? undefined,
  });
}

test("the preload bridge returns the native path and tolerates an empty spelling", () => {
  const bridge = createWorkbenchFilesPreloadBridge({
    getPathForFile: (file) =>
      file.name === "a.txt" ? "C:\\somewhere\\a.txt" : "",
  });
  assert.equal(bridge.getPathForFile(fakeFile("a.txt")), "C:\\somewhere\\a.txt");
  assert.equal(bridge.getPathForFile(fakeFile("b.txt")), undefined);
});

test("the preload bridge contains a throwing webUtils without leaking it", () => {
  const bridge = createWorkbenchFilesPreloadBridge({
    getPathForFile: () => {
      throw new Error("native failure");
    },
  });
  assert.equal(bridge.getPathForFile(fakeFile("a.txt")), undefined);
});

test("a drop resolves every file to a path, falling back to the display name", () => {
  const resolved = resolveDroppedFileTexts(
    {
      files: [
        { file: fakeFile("notes.txt"), name: "notes.txt" },
        { file: fakeFile("weird.bin"), name: "weird.bin" },
      ],
    },
    bridgeWith(["C:\\users\\me\\notes.txt", undefined]),
  );
  assert.deepEqual(resolved, ["C:\\users\\me\\notes.txt", "weird.bin"]);
});

test("an empty drop resolves to no insertions and leaves the draft untouched", () => {
  assert.deepEqual(resolveDroppedFileTexts({ files: [] }, bridgeWith([])), []);
  assert.equal(appendDroppedFileTexts("existing draft", []), "existing draft");
});

test("paths insert on their own lines after the trimmed draft", () => {
  assert.equal(
    appendDroppedFileTexts("", ["C:\\a.txt"]),
    "C:\\a.txt",
  );
  assert.equal(
    appendDroppedFileTexts("look at this  \n", ["C:\\a.txt", "C:\\b.txt"]),
    "look at this\nC:\\a.txt\nC:\\b.txt",
  );
  assert.equal(
    appendDroppedFileTexts("already has one\nC:\\a.txt", ["C:\\a.txt"]),
    "already has one\nC:\\a.txt\nC:\\a.txt",
  );
});

test("the renderer bridge reader admits only a callable surface", () => {
  const real = Object.freeze({ getPathForFile: () => "C:\\a.txt" });
  assert.equal(readWorkbenchFilesBridge(real), real);
  assert.equal(readWorkbenchFilesBridge(undefined), undefined);
  assert.equal(readWorkbenchFilesBridge(null), undefined);
  assert.equal(readWorkbenchFilesBridge({}), undefined);
  assert.equal(readWorkbenchFilesBridge({ getPathForFile: 4 }), undefined);
});
