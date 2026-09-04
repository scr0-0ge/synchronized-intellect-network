import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchTimelineEvent } from "../../src/workbench-shell/contract.ts";
import {
  countTranscriptSearchMatches,
  filterTranscriptGroups,
  groupTimelineEvents,
} from "../../src/workbench-shell/renderer/transcript-search.ts";
import {
  calculateTranscriptWindow,
  estimatedTranscriptOffset,
  flushLatestSnapshot,
  queueLatestSnapshot,
  sliceTranscriptWindow,
  transcriptGroupAtOffset,
  TRANSCRIPT_LIVE_MAX_FLUSH_MS,
  type LatestSnapshotQueue,
} from "../../src/workbench-shell/renderer/transcript-window.ts";

function userMessage(text: string): WorkbenchTimelineEvent {
  return Object.freeze({ kind: "user-message" as const, text });
}

function agentMessage(text: string): WorkbenchTimelineEvent {
  return Object.freeze({ kind: "agent-message" as const, text });
}

test("the transcript window stays bounded while moving through a 2,000-turn session", () => {
  const atBottom = calculateTranscriptWindow({
    totalGroups: 2_000,
    firstVisibleIndex: 1_988,
    visibleGroupCount: 12,
    overscanGroups: 8,
  });
  assert.deepEqual(atBottom, {
    startIndex: 1_980,
    endIndex: 2_000,
    hiddenBefore: 1_980,
    hiddenAfter: 0,
  });

  const inHistory = calculateTranscriptWindow({
    totalGroups: 2_000,
    firstVisibleIndex: 300,
    visibleGroupCount: 12,
    overscanGroups: 8,
  });
  assert.deepEqual(inHistory, {
    startIndex: 292,
    endIndex: 320,
    hiddenBefore: 292,
    hiddenAfter: 1_680,
  });
  assert.ok(inHistory.endIndex - inHistory.startIndex <= 28);
});

test("empty and single-turn sessions clamp to exact immutable windows", () => {
  const empty = calculateTranscriptWindow({
    totalGroups: 0,
    firstVisibleIndex: 10,
    visibleGroupCount: 10,
    overscanGroups: 4,
  });
  assert.deepEqual(empty, {
    startIndex: 0,
    endIndex: 0,
    hiddenBefore: 0,
    hiddenAfter: 0,
  });
  assert.equal(Object.isFrozen(empty), true);

  const single = calculateTranscriptWindow({
    totalGroups: 1,
    firstVisibleIndex: -10,
    visibleGroupCount: 10,
    overscanGroups: 4,
  });
  assert.deepEqual(single, {
    startIndex: 0,
    endIndex: 1,
    hiddenBefore: 0,
    hiddenAfter: 0,
  });
});

test("measured variable-height groups refine virtual offsets without changing boundaries", () => {
  const measured = new Map<number, number>([
    [0, 100],
    [1, 300],
  ]);
  assert.equal(estimatedTranscriptOffset(0, measured, 128), 0);
  assert.equal(estimatedTranscriptOffset(2, measured, 128), 400);
  assert.equal(estimatedTranscriptOffset(3, measured, 128), 528);
  assert.equal(transcriptGroupAtOffset(3, 99, measured, 128), 0);
  assert.equal(transcriptGroupAtOffset(3, 100, measured, 128), 1);
  assert.equal(transcriptGroupAtOffset(3, 399, measured, 128), 1);
  assert.equal(transcriptGroupAtOffset(3, 400, measured, 128), 2);
  assert.equal(transcriptGroupAtOffset(0, 10, measured, 128), 0);
});

test("search filters the full grouped list before windowing without weakening match counts", () => {
  const timeline = Object.freeze(
    Array.from({ length: 100 }, (_, index) =>
      Object.freeze([
        userMessage(
          index === 2 || index === 97
            ? `needle ${index}`
            : `turn ${index}`,
        ),
        agentMessage(`answer ${index}`),
      ]),
    ).flat(),
  );
  const groups = groupTimelineEvents(timeline);
  const filtered = filterTranscriptGroups(groups, "needle");
  const window = calculateTranscriptWindow({
    totalGroups: filtered.length,
    firstVisibleIndex: 1,
    visibleGroupCount: 1,
    overscanGroups: 0,
  });

  assert.equal(countTranscriptSearchMatches(groups, "needle"), 2);
  assert.deepEqual(
    sliceTranscriptWindow(filtered, window).map(
      (group) => group.userMessage?.text,
    ),
    ["needle 97"],
  );

  const noMatches = filterTranscriptGroups(groups, "absent");
  const emptyWindow = calculateTranscriptWindow({
    totalGroups: noMatches.length,
    firstVisibleIndex: 0,
    visibleGroupCount: 10,
    overscanGroups: 4,
  });
  assert.equal(countTranscriptSearchMatches(groups, "absent"), 0);
  assert.deepEqual(sliceTranscriptWindow(noMatches, emptyWindow), []);
});

test("rapid live snapshots schedule once and flush only the newest snapshot", () => {
  assert.equal(TRANSCRIPT_LIVE_MAX_FLUSH_MS, 100);
  let queue: LatestSnapshotQueue<{ readonly revision: number }> = Object.freeze({
    pending: undefined,
    flushScheduled: false,
  });
  let scheduleRequests = 0;

  for (let revision = 1; revision <= 50; revision += 1) {
    const queued = queueLatestSnapshot(
      queue,
      Object.freeze({ revision }),
    );
    queue = queued.queue;
    if (queued.shouldScheduleFlush) scheduleRequests += 1;
  }

  assert.equal(scheduleRequests, 1);
  const flushed = flushLatestSnapshot(queue);
  assert.deepEqual(flushed.snapshot, { revision: 50 });
  assert.deepEqual(flushed.queue, {
    pending: undefined,
    flushScheduled: false,
  });
});
