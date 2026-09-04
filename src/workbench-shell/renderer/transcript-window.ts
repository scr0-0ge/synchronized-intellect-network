export interface TranscriptWindowRequest {
  readonly totalGroups: number;
  readonly firstVisibleIndex: number;
  readonly visibleGroupCount: number;
  readonly overscanGroups: number;
}

export interface TranscriptWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

export interface LatestSnapshotQueue<Snapshot> {
  readonly pending: Snapshot | undefined;
  readonly flushScheduled: boolean;
}

export interface QueuedLatestSnapshot<Snapshot> {
  readonly queue: LatestSnapshotQueue<Snapshot>;
  readonly shouldScheduleFlush: boolean;
}

export interface FlushedLatestSnapshot<Snapshot> {
  readonly queue: LatestSnapshotQueue<Snapshot>;
  readonly snapshot: Snapshot | undefined;
}

export const TRANSCRIPT_LIVE_MAX_FLUSH_MS = 100;

const emptyTranscriptWindow: TranscriptWindow = Object.freeze({
  startIndex: 0,
  endIndex: 0,
  hiddenBefore: 0,
  hiddenAfter: 0,
});

export function calculateTranscriptWindow(
  request: TranscriptWindowRequest,
): TranscriptWindow {
  const totalGroups = nonNegativeInteger(request.totalGroups);
  if (totalGroups === 0) return emptyTranscriptWindow;

  const firstVisibleIndex = Math.min(
    totalGroups - 1,
    nonNegativeInteger(request.firstVisibleIndex),
  );
  const visibleGroupCount = Math.max(
    1,
    nonNegativeInteger(request.visibleGroupCount),
  );
  const overscanGroups = nonNegativeInteger(request.overscanGroups);
  const startIndex = Math.max(0, firstVisibleIndex - overscanGroups);
  const endIndex = Math.min(
    totalGroups,
    firstVisibleIndex + visibleGroupCount + overscanGroups,
  );

  return Object.freeze({
    startIndex,
    endIndex,
    hiddenBefore: startIndex,
    hiddenAfter: totalGroups - endIndex,
  });
}

export function sliceTranscriptWindow<Group>(
  groups: readonly Group[],
  window: TranscriptWindow,
): readonly Group[] {
  const startIndex = Math.min(
    groups.length,
    nonNegativeInteger(window.startIndex),
  );
  const endIndex = Math.min(
    groups.length,
    Math.max(startIndex, nonNegativeInteger(window.endIndex)),
  );
  return Object.freeze(groups.slice(startIndex, endIndex));
}

export function queueLatestSnapshot<Snapshot>(
  queue: LatestSnapshotQueue<Snapshot>,
  snapshot: Snapshot,
): QueuedLatestSnapshot<Snapshot> {
  return Object.freeze({
    queue: Object.freeze({
      pending: snapshot,
      flushScheduled: true,
    }),
    shouldScheduleFlush: !queue.flushScheduled,
  });
}

export function flushLatestSnapshot<Snapshot>(
  queue: LatestSnapshotQueue<Snapshot>,
): FlushedLatestSnapshot<Snapshot> {
  return Object.freeze({
    queue: Object.freeze({
      pending: undefined,
      flushScheduled: false,
    }),
    snapshot: queue.pending,
  });
}

export function estimatedTranscriptOffset(
  groupIndex: number,
  measuredHeights: ReadonlyMap<number, number>,
  estimatedGroupHeight: number,
): number {
  const endIndex = nonNegativeInteger(groupIndex);
  const fallbackHeight = positiveNumber(estimatedGroupHeight, 1);
  let offset = 0;
  for (let index = 0; index < endIndex; index += 1) {
    offset += positiveNumber(measuredHeights.get(index), fallbackHeight);
  }
  return offset;
}

export function transcriptGroupAtOffset(
  totalGroups: number,
  offset: number,
  measuredHeights: ReadonlyMap<number, number>,
  estimatedGroupHeight: number,
): number {
  const count = nonNegativeInteger(totalGroups);
  if (count === 0) return 0;
  const targetOffset = Math.max(0, finiteNumber(offset, 0));
  const fallbackHeight = positiveNumber(estimatedGroupHeight, 1);
  let accumulated = 0;
  for (let index = 0; index < count; index += 1) {
    const height = positiveNumber(measuredHeights.get(index), fallbackHeight);
    if (targetOffset < accumulated + height) return index;
    accumulated += height;
  }
  return count - 1;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(finiteNumber(value, 0)));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
