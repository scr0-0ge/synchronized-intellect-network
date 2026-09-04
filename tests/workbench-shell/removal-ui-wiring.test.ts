import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { copyLocaleDictionaries as commonCopyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/common-copy.ts";
import { copyLocaleDictionaries as dialogsCopyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/dialogs-copy.ts";
import { copyLocaleDictionaries as railCopyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/rail-copy.ts";

const mountPath = new URL(
  "../../src/workbench-shell/renderer/mount.tsx",
  import.meta.url,
);
const projectRailPath = new URL(
  "../../src/workbench-shell/renderer/project-rail.tsx",
  import.meta.url,
);
const dialogsPath = new URL(
  "../../src/workbench-shell/renderer/dialogs.tsx",
  import.meta.url,
);
const statesPath = new URL(
  "../../src/workbench-shell/renderer/states.tsx",
  import.meta.url,
);
const railCopyPath = new URL(
  "../../src/workbench-shell/renderer/copy/rail-copy.ts",
  import.meta.url,
);
const dialogsCopyPath = new URL(
  "../../src/workbench-shell/renderer/copy/dialogs-copy.ts",
  import.meta.url,
);
test("renderer exposes separate Session and Project removal controls behind one explicit accessible confirmation", async () => {
  const [mountSource, projectRailSource, dialogsSource, statesSource] =
    await Promise.all([
      readFile(mountPath, "utf8"),
      readFile(projectRailPath, "utf8"),
      readFile(dialogsPath, "utf8"),
      readFile(statesPath, "utf8"),
    ]);
  assert.match(
    projectRailSource,
    /aria-label=\{deleteSessionAriaCopy\(props\.command\.label\)\}/u,
  );
  assert.equal(
    railCopyLocaleDictionaries.en.deleteSessionAriaCopy("Agent Session Alpha"),
    "Delete Agent Session Alpha",
  );
  assert.match(
    projectRailSource,
    /aria-label=\{removeProjectAriaCopy\(project\.label\)\}/u,
  );
  assert.equal(
    railCopyLocaleDictionaries.en.removeProjectAriaCopy("Project Alpha"),
    "Remove Project Alpha from Workbench",
  );
  assert.match(dialogsSource, /role="alertdialog"/u);
  assert.match(dialogsSource, /aria-modal="true"/u);
  assert.match(dialogsSource, /confirmation\(\)\.confirmLabel/u);
  assert.match(
    dialogsSource,
    /\{dialogsCopy\.cancel\}/u,
  );
  assert.equal(dialogsCopyLocaleDictionaries.en.cancel, "Cancel");
  assert.doesNotMatch(
    [mountSource, projectRailSource, dialogsSource, statesSource].join("\n"),
    /window\.confirm|\bconfirm\s*\(/u,
  );
});

test("renderer sends only presentation-derived opaque requests and keeps blocked feedback live", async () => {
  const sources = await Promise.all([
    readFile(mountPath, "utf8"),
    readFile(projectRailPath, "utf8"),
    readFile(dialogsPath, "utf8"),
    readFile(statesPath, "utf8"),
    readFile(railCopyPath, "utf8"),
    readFile(dialogsCopyPath, "utf8"),
  ]);
  const [mountSource] = sources;
  const removalSource = sources.join("\n");

  assert.match(
    mountSource!,
    /props\.bridge\s*\.removeSession\(current\.request\)/u,
  );
  assert.match(
    mountSource!,
    /props\.bridge\s*\.removeProject\(current\.request\)/u,
  );
  assert.match(mountSource!, /removalFeedback\(current\.kind, result\)/u);
  assert.match(removalSource, /aria-live="polite"/u);
  assert.doesNotMatch(removalSource, /sessionId/u);
});

test("removing the last Project leaves visible Open and Create recovery actions", async () => {
  const statesSource = await readFile(statesPath, "utf8");
  const start = statesSource.indexOf("export const FailureState:");
  const end = statesSource.indexOf("\n);", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const failureState = statesSource.slice(start, end + 3);
  assert.match(failureState, /onClick=\{props\.onOpenProject\}/u);
  assert.match(failureState, /onClick=\{props\.onCreateProject\}/u);
  assert.match(failureState, /\bcommonCopy\.openProject\b/u);
  assert.equal(commonCopyLocaleDictionaries.en.openProject, "Open Project…");
  assert.match(failureState, /\bcommonCopy\.createProject\b/u);
  assert.equal(
    commonCopyLocaleDictionaries.en.createProject,
    "Create Project…",
  );
});
