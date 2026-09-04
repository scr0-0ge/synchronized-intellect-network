import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_COMPOSER_HISTORY_LIMIT,
  composerHistoryDirection,
  initialWorkbenchComposerHistoryState,
  navigateComposerHistory,
  recordAcceptedComposerInput,
  type WorkbenchComposerHistoryKeyEvent,
  type WorkbenchComposerHistoryState,
} from "../../src/workbench-shell/renderer/composer-history.ts";

const plainArrowUp: WorkbenchComposerHistoryKeyEvent = Object.freeze({
  key: "ArrowUp",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  defaultPrevented: false,
});

test("composer history accepts only plain ArrowUp and ArrowDown navigation", () => {
  assert.equal(composerHistoryDirection(plainArrowUp), "older");
  assert.equal(
    composerHistoryDirection({ ...plainArrowUp, key: "ArrowDown" }),
    "newer",
  );
  for (const adversarial of [
    { ...plainArrowUp, key: "Up" },
    { ...plainArrowUp, ctrlKey: true },
    { ...plainArrowUp, metaKey: true },
    { ...plainArrowUp, altKey: true },
    { ...plainArrowUp, shiftKey: true },
    { ...plainArrowUp, isComposing: true },
    { ...plainArrowUp, defaultPrevented: true },
  ]) {
    assert.equal(composerHistoryDirection(adversarial), null);
  }
});

test("accepted composer history is Project-scoped and retains the latest bounded window", () => {
  let state = initialWorkbenchComposerHistoryState;
  for (let index = 0; index <= WORKBENCH_COMPOSER_HISTORY_LIMIT; index += 1) {
    state = recordAcceptedComposerInput(state, "project-a", `input-${index}`);
  }
  state = recordAcceptedComposerInput(state, "project-b", "other-project");

  const first = navigateComposerHistory(state, "project-a", {
    direction: "older",
    draft: "",
    selectionStart: 0,
    selectionEnd: 0,
  });
  assert.equal(first.handled, true);
  assert.equal(first.draft, `input-${WORKBENCH_COMPOSER_HISTORY_LIMIT}`);

  let oldest = first;
  for (let index = 1; index < WORKBENCH_COMPOSER_HISTORY_LIMIT; index += 1) {
    oldest = navigateComposerHistory(oldest.state, "project-a", {
      direction: "older",
      draft: oldest.draft,
      selectionStart: oldest.draft.length,
      selectionEnd: oldest.draft.length,
    });
  }
  assert.equal(oldest.draft, "input-1");
  assert.notEqual(oldest.draft, "input-0");

  const otherProject = navigateComposerHistory(state, "project-b", {
    direction: "older",
    draft: "",
    selectionStart: 0,
    selectionEnd: 0,
  });
  assert.equal(otherProject.draft, "other-project");
});

test("history navigation preserves multiline caret movement and restores the prior draft forward", () => {
  let state = recordAcceptedComposerInput(
    initialWorkbenchComposerHistoryState,
    "project-a",
    "older input",
  );
  state = recordAcceptedComposerInput(state, "project-a", "newer input");
  const draft = "keep this\nmultiline draft";
  const secondLinePosition = draft.indexOf("\n") + 4;

  const nativeUp = navigateComposerHistory(state, "project-a", {
    direction: "older",
    draft,
    selectionStart: secondLinePosition,
    selectionEnd: secondLinePosition,
  });
  assert.equal(nativeUp.handled, false);
  assert.equal(nativeUp.state, state);
  assert.equal(nativeUp.draft, draft);

  const newest = navigateComposerHistory(state, "project-a", {
    direction: "older",
    draft,
    selectionStart: 3,
    selectionEnd: 3,
  });
  assert.equal(newest.handled, true);
  assert.equal(newest.draft, "newer input");

  const oldest = navigateComposerHistory(newest.state, "project-a", {
    direction: "older",
    draft: newest.draft,
    selectionStart: newest.draft.length,
    selectionEnd: newest.draft.length,
  });
  assert.equal(oldest.draft, "older input");

  const forward = navigateComposerHistory(oldest.state, "project-a", {
    direction: "newer",
    draft: oldest.draft,
    selectionStart: oldest.draft.length,
    selectionEnd: oldest.draft.length,
  });
  assert.equal(forward.draft, "newer input");
  const restored = navigateComposerHistory(forward.state, "project-a", {
    direction: "newer",
    draft: forward.draft,
    selectionStart: forward.draft.length,
    selectionEnd: forward.draft.length,
  });
  assert.equal(restored.handled, true);
  assert.equal(restored.draft, draft);
  assert.equal(restored.state.navigation, null);

  const selection = navigateComposerHistory(state, "project-a", {
    direction: "older",
    draft,
    selectionStart: 0,
    selectionEnd: 4,
  });
  assert.equal(selection.handled, false);
});

const seededHistory = (): ReturnType<typeof recordAcceptedComposerInput> => {
  let state = recordAcceptedComposerInput(
    initialWorkbenchComposerHistoryState,
    "project-a",
    "deploy the staging build",
  );
  return recordAcceptedComposerInput(state, "project-a", "run the smoke tests");
};

// The caret is parked at the end of the recalled text after every recall
// (composer.tsx:686-689), which is what makes these sequences reachable.
const arrow = (
  state: WorkbenchComposerHistoryState,
  direction: "older" | "newer",
  draft: string,
  caret: number = draft.length,
  scopeKey: string = "project-a",
): ReturnType<typeof navigateComposerHistory> =>
  navigateComposerHistory(state, scopeKey, {
    direction,
    draft,
    selectionStart: caret,
    selectionEnd: caret,
  });

test("an edited recall survives ArrowUp to an older entry and ArrowDown back to it", () => {
  const recalled = arrow(seededHistory(), "older", "");
  assert.equal(recalled.draft, "run the smoke tests");

  const edited = `${recalled.draft} on windows`;
  const older = arrow(recalled.state, "older", edited);
  assert.equal(older.handled, true);
  assert.equal(older.draft, "deploy the staging build");

  const back = arrow(older.state, "newer", older.draft);
  assert.equal(back.handled, true);
  assert.equal(back.draft, edited);
});

test("an edited recall survives ArrowDown to a newer entry and ArrowUp back to it", () => {
  const newest = arrow(seededHistory(), "older", "");
  const oldest = arrow(newest.state, "older", newest.draft);
  assert.equal(oldest.draft, "deploy the staging build");

  const edited = `${oldest.draft} twice`;
  const newer = arrow(oldest.state, "newer", edited);
  assert.equal(newer.handled, true);
  assert.equal(newer.draft, "run the smoke tests");

  const back = arrow(newer.state, "older", newer.draft);
  assert.equal(back.handled, true);
  assert.equal(back.draft, edited);
});

test("an edited recall survives ArrowDown past the newest entry and ArrowUp back to it", () => {
  const recalled = arrow(seededHistory(), "older", "half-written thought", 0);
  assert.equal(recalled.draft, "run the smoke tests");

  const edited = `${recalled.draft} on windows`;
  const past = arrow(recalled.state, "newer", edited);
  assert.equal(past.handled, true);
  assert.equal(past.draft, "half-written thought");
  assert.equal(past.state.navigation, null);

  const back = arrow(past.state, "older", past.draft);
  assert.equal(back.handled, true);
  assert.equal(back.draft, edited);
});

test("ArrowUp at the oldest entry keeps an edit instead of replacing it", () => {
  const newest = arrow(seededHistory(), "older", "");
  const oldest = arrow(newest.state, "older", newest.draft);
  assert.equal(oldest.draft, "deploy the staging build");

  const edited = `${oldest.draft} tomorrow`;
  const clamped = arrow(oldest.state, "older", edited);
  assert.equal(clamped.handled, true);
  assert.equal(clamped.draft, edited);
});

test("history working copies do not outlive the navigation session", () => {
  const recalled = arrow(seededHistory(), "older", "");
  const edited = `${recalled.draft} on windows`;
  const parked = arrow(recalled.state, "older", edited);

  const committed = recordAcceptedComposerInput(
    parked.state,
    "project-a",
    "something else entirely",
  );
  assert.equal(committed.navigation, null);
  assert.equal(committed.workingSet, null);
  assert.equal(JSON.stringify(committed).includes("on windows"), false);

  const afterCommit = arrow(committed, "older", "");
  assert.equal(afterCommit.draft, "something else entirely");
  const older = arrow(afterCommit.state, "older", afterCommit.draft);
  assert.equal(older.draft, "run the smoke tests");
});

test("history working copies never cross a Project scope", () => {
  const seeded = recordAcceptedComposerInput(
    seededHistory(),
    "project-b",
    "run the smoke tests",
  );
  const recalled = arrow(seeded, "older", "");
  const edited = `${recalled.draft} on windows`;
  const parked = arrow(recalled.state, "older", edited);

  const otherScope = arrow(parked.state, "older", "", 0, "project-b");
  assert.equal(otherScope.handled, true);
  assert.equal(otherScope.draft, "run the smoke tests");
  assert.notEqual(otherScope.draft, edited);
});

test("an unhandled navigation stashes nothing and returns the state untouched", () => {
  const recalled = arrow(seededHistory(), "older", "");
  const edited = `${recalled.draft} on windows`;
  const multiline = `first line\n${edited}`;

  const nativeUp = arrow(recalled.state, "older", multiline);
  assert.equal(nativeUp.handled, false);
  assert.equal(nativeUp.state, recalled.state);
  assert.equal(nativeUp.draft, multiline);
});
