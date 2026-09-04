import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { createWorkbenchProjectSaveTargetChooser } from "../../src/workbench-shell/electron/project-save-target-chooser-boundary.ts";
import type { BrowserWindowBoundary } from "../../src/workbench-shell/electron/project-view-ipc.ts";

test("injected save-target chooser is construction-inert and makes one owning-window fixed-option call", async () => {
  const owningWindow = Object.freeze({
    webContents: Object.freeze({
      send() {},
      isDestroyed() { return false; },
      on() {},
      removeListener() {},
    }),
    on() {},
    removeListener() {},
  }) satisfies BrowserWindowBoundary;
  const nativeResult = Object.freeze({ private: "native-result" });
  const calls: unknown[][] = [];
  const chooser = createWorkbenchProjectSaveTargetChooser(
    owningWindow,
    async (...args) => {
      calls.push(args);
      return nativeResult;
    },
  );

  assert.deepEqual(calls, []);
  assert.equal(await chooser.chooseProjectTarget(), nativeResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], owningWindow);
  assert.deepEqual(calls[0]?.[1], {
    title: "Create Project",
    buttonLabel: "Create Project",
    properties: ["dontAddToRecent"],
  });
  assert.deepEqual(Object.keys(calls[0]?.[1] as object).sort(), [
    "buttonLabel",
    "properties",
    "title",
  ]);
});

test("production has exact owning-window save-target calls for Create Project and Historical Recovery", async () => {
  const sourceRoot = new URL("../../src/workbench-shell/", import.meta.url);
  const files = await collectSourceFiles(sourceRoot);
  const matches: string[] = [];
  for (const file of files) {
    const source = await readFile(new URL(file, sourceRoot), "utf8");
    if (/dialog\.showSaveDialog/u.test(source)) matches.push(file);
  }
  assert.deepEqual(matches, [
    "electron/history-recovery-export-chooser.ts",
    "electron/project-save-target-chooser.ts",
  ]);

  const source = await readFile(
    new URL(
      "../../src/workbench-shell/electron/project-save-target-chooser.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /dialog\.showSaveDialog\(owningWindow as BrowserWindow, \{[\s\S]*?title: options\.title,[\s\S]*?buttonLabel: options\.buttonLabel,[\s\S]*?properties: \[\.\.\.options\.properties\],[\s\S]*?\}\)/u,
  );
  assert.equal((source.match(/dialog\.showSaveDialog/gu) ?? []).length, 1);
  for (const forbidden of [
    "defaultPath",
    "filters",
    "nameFieldLabel",
    "showsTagField",
    "securityScopedBookmarks",
    "createDirectory",
    "showOverwriteConfirmation",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }

  const historyRecoverySource = await readFile(
    new URL(
      "../../src/workbench-shell/electron/history-recovery-export-chooser.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    historyRecoverySource,
    /export function createElectronHistoryRecoveryExportChooser\(\s+window: BrowserWindowBoundary,\s+\): HistoryRecoveryExportChooser/u,
  );
  assert.match(
    historyRecoverySource,
    /dialog\.showSaveDialog\(window as BrowserWindow, \{\s+title: "Export exact historical recovery copy",\s+message: options\.warning,\s+buttonLabel: "Export exact copy",\s+defaultPath: options\.suggestedName,\s+filters: \[\s+Object\.freeze\(\{\s+name: "Workbench historical recovery copy",\s+extensions: \["uawr-history"\],\s+\}\),\s+\],\s+properties: \["showOverwriteConfirmation", "createDirectory"\],\s+\}\)/u,
  );
  assert.match(
    historyRecoverySource,
    /return result\.canceled \|\| typeof result\.filePath !== "string"\s+\? null\s+: Object\.freeze\(\{ targetPath: result\.filePath \}\);/u,
  );
  assert.equal(
    (historyRecoverySource.match(/dialog\.showSaveDialog/gu) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    historyRecoverySource,
    /title: "Create Project"|buttonLabel: "Create Project"|dontAddToRecent/u,
  );
});

async function collectSourceFiles(
  directory: URL,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      return collectSourceFiles(
        new URL(`${encodeURIComponent(entry.name)}/`, directory),
        `${relative}/`,
      );
    }
    return /\.tsx?$/u.test(entry.name) ? [relative] : [];
  }));
  return nested.flat().sort();
}
