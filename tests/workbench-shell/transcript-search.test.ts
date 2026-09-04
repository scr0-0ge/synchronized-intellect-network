import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { WorkbenchTimelineEvent } from "../../src/workbench-shell/contract.ts";
import {
  countTranscriptSearchMatches,
  filterTranscriptGroups,
  groupTimelineEvents,
  isTranscriptSearchShortcut,
  type TimelineEventGroup,
} from "../../src/workbench-shell/renderer/transcript-search.ts";

function userMessage(text: string): WorkbenchTimelineEvent {
  return Object.freeze({ kind: "user-message" as const, text });
}

function agentMessage(text: string): WorkbenchTimelineEvent {
  return Object.freeze({ kind: "agent-message" as const, text });
}

const firstTurn: readonly WorkbenchTimelineEvent[] = Object.freeze([
  userMessage("fix login bug"),
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({
    kind: "item-started" as const,
    itemType: "agent-message" as const,
  }),
  agentMessage("Fixed the login flow"),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

const secondTurn: readonly WorkbenchTimelineEvent[] = Object.freeze([
  userMessage("add tests for it"),
  Object.freeze({ kind: "turn-started" as const }),
  agentMessage("Added unit tests"),
  Object.freeze({
    kind: "item-completed" as const,
    itemType: "agent-message" as const,
  }),
]);

const groupedFixture: readonly TimelineEventGroup[] = Object.freeze([
  ...groupTimelineEvents(firstTurn),
  ...groupTimelineEvents(secondTurn),
]);

test("grouping semantics survive the move into the view-model layer", () => {
  const first = Object.freeze(userMessage("first"));
  const second = Object.freeze(userMessage("second"));
  const grouped = groupTimelineEvents(Object.freeze([
    first,
    Object.freeze({ kind: "session-started" as const }),
    Object.freeze({ kind: "turn-started" as const }),
    agentMessage("one"),
    Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
    second,
    Object.freeze({ kind: "turn-started" as const }),
    Object.freeze({
      kind: "item-started" as const,
      itemType: "agent-message" as const,
    }),
  ]));

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]?.userMessage, first);
  assert.deepEqual(grouped[0]?.events.map((event) => event.kind), [
    "session-started",
    "turn-started",
    "agent-message",
    "turn-completed",
  ]);
  assert.equal(grouped[1]?.userMessage, second);
  assert.deepEqual(grouped[1]?.events.map((event) => event.kind), [
    "turn-started",
    "item-started",
  ]);
  assert.equal(
    grouped.every(
      (group) => Object.isFrozen(group) && Object.isFrozen(group.events),
    ),
    true,
  );
  assert.equal(
    grouped.every((group) =>
      group.events.every(
        (event) =>
          (event as { readonly kind: string }).kind !== "user-message",
      ),
    ),
    true,
    "runtime slices exclude user-message events",
  );

  const legacy = groupTimelineEvents(Object.freeze([
    Object.freeze({ kind: "session-started" as const }),
    Object.freeze({ kind: "turn-started" as const }),
    agentMessage("legacy one"),
    Object.freeze({ kind: "turn-started" as const }),
    agentMessage("legacy two"),
  ]));
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map((group) => group.events.map((event) => event.kind)), [
    ["session-started", "turn-started", "agent-message"],
    ["turn-started", "agent-message"],
  ]);

  const mixedPrefix = groupTimelineEvents(Object.freeze([
    Object.freeze({ kind: "session-started" as const }),
    userMessage("modern"),
    Object.freeze({ kind: "turn-started" as const }),
  ]));
  assert.equal(mixedPrefix.length, 2);
  assert.deepEqual(mixedPrefix[0]?.events.map((event) => event.kind), [
    "session-started",
  ]);
  assert.equal(mixedPrefix[1]?.userMessage?.text, "modern");
});

test("the client-side filter matches user text, agent text, and normalized events case-insensitively", () => {
  assert.deepEqual(
    visibleTexts(filterTranscriptGroups(groupedFixture, "login")),
    ["fix login bug"],
  );
  assert.deepEqual(
    visibleTexts(filterTranscriptGroups(groupedFixture, "LOGIN")),
    ["fix login bug"],
    "matching is case-insensitive in both directions",
  );
  assert.deepEqual(
    visibleTexts(filterTranscriptGroups(groupedFixture, "tests")),
    ["add tests for it"],
  );
  assert.deepEqual(
    visibleTexts(filterTranscriptGroups(groupedFixture, "added unit")),
    ["add tests for it"],
    "agent message prose is searchable",
  );
  assert.deepEqual(
    visibleTexts(filterTranscriptGroups(groupedFixture, "item-completed")),
    ["add tests for it"],
    "normalized event kinds are searchable",
  );
  assert.deepEqual(
    visibleTexts(filterTranscriptGroups(groupedFixture, "turn-completed")),
    ["fix login bug"],
  );
});

test("a blank query is an exact passthrough while real queries freeze filtered results", () => {
  assert.equal(filterTranscriptGroups(groupedFixture, ""), groupedFixture);
  assert.equal(
    filterTranscriptGroups(groupedFixture, "   \t "),
    groupedFixture,
    "whitespace-only queries keep every turn without re-rendering them",
  );

  const filtered = filterTranscriptGroups(groupedFixture, "login");
  assert.equal(Object.isFrozen(filtered), true);

  const noMatches = filterTranscriptGroups(groupedFixture, "nonexistent-needle");
  assert.deepEqual(noMatches, []);
  assert.equal(countTranscriptSearchMatches(groupedFixture, "nonexistent-needle"), 0);
  assert.equal(countTranscriptSearchMatches(groupedFixture, "login"), 1);
  assert.equal(countTranscriptSearchMatches(groupedFixture, ""), 2);

  let threw = false;
  try {
    filterTranscriptGroups(undefined as unknown as TimelineEventGroup[], "");
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "a hostile groups value degrades to zero matches");
  assert.deepEqual(
    filterTranscriptGroups(undefined as unknown as TimelineEventGroup[], ""),
    [],
  );
});

interface ShortcutEventCase {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

const ctrlF: ShortcutEventCase = Object.freeze({
  key: "f",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
});

test("transcript search shortcut recognizes only an unmodified Windows Ctrl+F chord", () => {
  assert.equal(isTranscriptSearchShortcut(ctrlF), true);
  assert.equal(isTranscriptSearchShortcut({ ...ctrlF, key: "F" }), true);

  for (const ignored of [
    { ...ctrlF, ctrlKey: false },
    { ...ctrlF, metaKey: true },
    { ...ctrlF, altKey: true },
    { ...ctrlF, shiftKey: true },
    { ...ctrlF, repeat: true },
    { ...ctrlF, isComposing: true },
    { ...ctrlF, key: "g" },
    { ...ctrlF, key: "Enter" },
  ]) {
    assert.equal(isTranscriptSearchShortcut(ignored), false);
  }
});

test("mounted Workbench owns exactly one leak-free Ctrl+F listener wired to the transcript search input", async () => {
  const [mountSource, transcriptSource] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/renderer/transcript.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  const registration =
    'window.addEventListener("keydown", handleTranscriptSearchShortcut);';
  const cleanup =
    'window.removeEventListener("keydown", handleTranscriptSearchShortcut);';
  assert.equal(mountSource.split(registration).length - 1, 1);
  assert.equal(mountSource.split(cleanup).length - 1, 1);

  const handlerStart = mountSource.indexOf(
    "const handleTranscriptSearchShortcut",
  );
  assert.ok(handlerStart >= 0);
  const handlerSource = mountSource.slice(
    handlerStart,
    mountSource.indexOf("onMount(", handlerStart),
  );
  assert.match(
    handlerSource,
    /if \(!isTranscriptSearchShortcut\(event\)\) return;\s*const input = document\.querySelector<HTMLInputElement>\(\s*"input\.transcript-search-input",\s*\);\s*if \(input === null\) return;\s*event\.preventDefault\(\);\s*input\.focus\(\);/u,
  );
  assert.doesNotMatch(
    handlerSource,
    /props\.bridge|window\.open|BrowserWindow/u,
  );

  assert.equal(
    transcriptSource.split('class="transcript-search-input"').length - 1,
    1,
  );
  assert.match(
    transcriptSource,
    /if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setSearchQuery\(""\);\s*\}/u,
  );
  assert.match(
    transcriptSource,
    /let searchScopeKey = props\.command\.key;\s*createEffect\(\(\) => \{\s*const nextScopeKey = props\.command\.key;\s*if \(nextScopeKey === searchScopeKey\) return;\s*searchScopeKey = nextScopeKey;\s*setSearchQuery\(""\);\s*\}\);/u,
    "a filter never leaks into the next selected Agent Session",
  );
});

function visibleTexts(
  groups: readonly TimelineEventGroup[],
): readonly (string | undefined)[] {
  return groups.map((group) => group.userMessage?.text);
}
