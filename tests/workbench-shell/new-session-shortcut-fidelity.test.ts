import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface ShortcutEventCase {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

const ctrlN: ShortcutEventCase = Object.freeze({
  key: "n",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
});

test("New Agent Session shortcut recognizes only an unmodified Windows Ctrl+N chord", async () => {
  const { isNewAgentSessionShortcut } = await import(
    "../../src/workbench-shell/renderer/view-model.ts"
  );

  assert.equal(isNewAgentSessionShortcut(ctrlN), true);
  assert.equal(isNewAgentSessionShortcut({ ...ctrlN, key: "N" }), true);

  const editableCtrlN = {
    ...ctrlN,
    target: Object.freeze({ tagName: "TEXTAREA", isContentEditable: true }),
  };
  assert.equal(
    isNewAgentSessionShortcut(editableCtrlN),
    true,
    "Ctrl+N remains application-scoped while the composer owns focus",
  );

  for (const ignored of [
    { ...ctrlN, ctrlKey: false },
    { ...ctrlN, ctrlKey: false, metaKey: true },
    { ...ctrlN, metaKey: true },
    { ...ctrlN, altKey: true },
    { ...ctrlN, shiftKey: true },
    { ...ctrlN, repeat: true },
    { ...ctrlN, isComposing: true },
    { ...ctrlN, key: "m" },
    { ...ctrlN, key: "Enter" },
  ]) {
    assert.equal(isNewAgentSessionShortcut(ignored), false);
  }
});

test("mounted Workbench owns one leak-free Ctrl+N listener and routes through the visible New Session transition", async () => {
  const source = await readFile(
    new URL(
      "../../src/workbench-shell/renderer/mount.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const appStart = source.indexOf("const WorkbenchApp:");
  const appEnd = source.indexOf("const ResolvedWorkbench:");
  assert.ok(appStart >= 0 && appEnd > appStart);
  const appSource = source.slice(appStart, appEnd);

  const registration =
    'window.addEventListener("keydown", handleNewAgentSessionShortcut);';
  const cleanup =
    'window.removeEventListener("keydown", handleNewAgentSessionShortcut);';
  assert.equal(appSource.split(registration).length - 1, 1);
  assert.equal(appSource.split(cleanup).length - 1, 1);

  const enterStart = appSource.indexOf("  const enterNewSession");
  const handlerStart = appSource.indexOf(
    "  const handleNewAgentSessionShortcut",
  );
  const listenerStart = appSource.indexOf("  onMount(", handlerStart);
  assert.ok(
    enterStart >= 0 && handlerStart > enterStart && listenerStart > handlerStart,
  );

  const enterSource = appSource.slice(enterStart, handlerStart);
  assert.match(
    enterSource,
    /const current = state\(\);\s*if \(!canEnterNewAgentSessionMode\(current\)\) return;\s*invalidateDirectSessionProfileLoad\(\);\s*setState\(enterNewAgentSessionMode\(current\)\);\s*setSurface\("project"\);/u,
  );

  const handlerSource = appSource.slice(handlerStart, listenerStart);
  assert.match(
    handlerSource,
    /if \(!isNewAgentSessionShortcut\(event\)\) return;\s*event\.preventDefault\(\);\s*const current = state\(\);\s*if \(\s*canEnterNewAgentSessionMode\(current\) &&\s*directInputMode\(current\) === "unavailable"\s*\) \{\s*enterReplacementSession\(\);\s*return;\s*\}\s*enterNewSession\(\);/u,
  );
  assert.ok(
    handlerSource.indexOf("event.preventDefault();") <
      handlerSource.indexOf("enterReplacementSession();"),
    "the recognized chord suppresses the host default before a blocked transition can return",
  );
  assert.ok(
    handlerSource.indexOf("enterReplacementSession();") <
      handlerSource.indexOf("enterNewSession();"),
    "blocked selected Sessions take the recorded-profile path while ordinary contexts retain the default path",
  );
  assert.doesNotMatch(
    handlerSource,
    /props\.bridge|location\.reload|window\.open|BrowserWindow/u,
  );

  assert.equal(
    appSource.split("onEnterNewSession={enterNewSession}").length - 1,
    1,
    "visible actions and the shortcut share the same state transition",
  );
});
