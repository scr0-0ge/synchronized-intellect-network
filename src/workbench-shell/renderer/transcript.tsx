import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  useContext,
  type Component,
} from "solid-js";
import type {
  WorkbenchCommandView,
  WorkbenchFileChangeSummary,
  WorkbenchSessionProfileProjection,
} from "../contract.ts";

import {
  filterTranscriptGroups,
  groupTimelineEvents,
  splitTranscriptSearchText,
  transcriptEventMetadataMatchesQuery,
  type RuntimeTimelineEvent,
  type TimelineEventGroup,
} from "./transcript-search.ts";
import {
  calculateTranscriptWindow,
  estimatedTranscriptOffset,
  flushLatestSnapshot,
  queueLatestSnapshot,
  sliceTranscriptWindow,
  transcriptGroupAtOffset,
  TRANSCRIPT_LIVE_MAX_FLUSH_MS,
  type LatestSnapshotQueue,
} from "./transcript-window.ts";
import { locale } from "./locale.ts";
import { WorkbenchRendererBridgeContext, runtimeClass } from "./view-types.ts";
import { EmptyState } from "./states.tsx";
import { CommandWithoutSession } from "./composer.tsx";
import {
  transcriptCopy,
  transcriptFailureBodyCopy,
  turnRecoveryBodyCopy,
  turnStateCopy,
  transcriptSearchCountCopy,
  turnOrdinalCopy,
  guidanceTurnOrdinalCopy,
  eventsDisclosureCopy,
  effectiveNotRecordedCopy,
  effectivePendingObservationCopy,
  effectivePendingObservationRequestedCopy,
  effectiveUnobservedCopy,
  effectiveUnobservedRequestedCopy,
  differsFromRequestedWithFallbackCopy,
} from "./copy/transcript-copy.ts";
import { composerControlCopy } from "./copy/composer-copy.ts";
import {
  prefixedProfileValueCopy,
  profileNotRecordedSummaryCopy,
  recordedProfileSummaryCopy,
} from "./copy/runtime-profile-copy.ts";
import { dynamicCopy } from "./copy/dynamic-copy.ts";
import { failureCopy } from "./copy/session-status-copy.ts";

type TranscriptSession = NonNullable<WorkbenchCommandView["session"]>;
type ProgressTimelineEvent = Extract<
  RuntimeTimelineEvent,
  { readonly kind: "progress" }
>;

const TRANSCRIPT_ESTIMATED_GROUP_HEIGHT = 128;
const TRANSCRIPT_INITIAL_VISIBLE_GROUPS = 6;
const TRANSCRIPT_OVERSCAN_GROUPS = 8;
const TRANSCRIPT_BOTTOM_DISTANCE_PX = 2;

interface TranscriptViewport {
  readonly firstVisibleIndex: number;
  readonly visibleGroupCount: number;
}

const jumpToLatestCopy = Object.freeze({
  en: "Jump to latest",
  "zh-CN": "回到最新",
});

export const SessionTranscript: Component<{
  readonly command: WorkbenchCommandView | undefined;
}> = (props) => {
  const [renderedCommand, setRenderedCommand] = createSignal(props.command);
  const [followingLatest, setFollowingLatest] = createSignal(true);
  const [jumpLatestRequest, setJumpLatestRequest] = createSignal(0);
  let observedCommand = props.command;
  let transcriptScroller: HTMLDivElement | undefined;
  let frameHandle: number | undefined;
  let timeoutHandle: number | undefined;
  let snapshotQueue: LatestSnapshotQueue<
    WorkbenchCommandView | undefined
  > = Object.freeze({ pending: undefined, flushScheduled: false });

  const cancelScheduledFlush = (): void => {
    if (typeof window === "undefined") return;
    if (frameHandle !== undefined) {
      window.cancelAnimationFrame(frameHandle);
      frameHandle = undefined;
    }
    if (timeoutHandle !== undefined) {
      window.clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
  };

  const flushCommandSnapshot = (): void => {
    if (!snapshotQueue.flushScheduled) return;
    cancelScheduledFlush();
    const flushed = flushLatestSnapshot(snapshotQueue);
    snapshotQueue = flushed.queue;
    setRenderedCommand(() => flushed.snapshot);
  };

  const scheduleCommandFlush = (): void => {
    if (typeof window === "undefined") {
      flushCommandSnapshot();
      return;
    }
    frameHandle = window.requestAnimationFrame(() => {
      frameHandle = undefined;
      flushCommandSnapshot();
    });
    timeoutHandle = window.setTimeout(() => {
      timeoutHandle = undefined;
      flushCommandSnapshot();
    }, TRANSCRIPT_LIVE_MAX_FLUSH_MS);
  };

  createEffect(() => {
    const nextCommand = props.command;
    if (nextCommand === observedCommand) return;
    observedCommand = nextCommand;
    const queued = queueLatestSnapshot(snapshotQueue, nextCommand);
    snapshotQueue = queued.queue;
    if (queued.shouldScheduleFlush) scheduleCommandFlush();
  });

  onCleanup(cancelScheduledFlush);

  return (
    <div class="transcript-shell">
      <div class="transcript" ref={transcriptScroller} tabIndex={0}>
        <div class="column">
          <Show
            when={renderedCommand()}
            fallback={
              <EmptyState
                title={transcriptCopy.emptyTitle}
                body={transcriptCopy.emptyBody}
              />
            }
          >
            {(command) => (
              <Show
                when={command().session}
                fallback={<CommandWithoutSession command={command()} />}
              >
                {(session) => (
                  <SessionTranscriptBody
                    command={command()}
                    session={session()}
                    scrollContainer={() => transcriptScroller}
                    jumpLatestRequest={jumpLatestRequest()}
                    onFollowingLatestChange={setFollowingLatest}
                  />
                )}
              </Show>
            )}
          </Show>
        </div>
      </div>
      <Show when={!followingLatest() && renderedCommand()?.session !== undefined}>
        <button
          type="button"
          class="transcript-jump-latest"
          aria-label={jumpToLatestCopy[locale()]}
          onClick={() => setJumpLatestRequest((revision) => revision + 1)}
        >
          <span aria-hidden="true">↓</span>
          {jumpToLatestCopy[locale()]}
        </button>
      </Show>
    </div>
  );
};

const SessionTranscriptBody: Component<{
  readonly command: WorkbenchCommandView;
  readonly session: TranscriptSession;
  readonly scrollContainer: () => HTMLElement | undefined;
  readonly jumpLatestRequest: number;
  readonly onFollowingLatestChange: (following: boolean) => void;
}> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal("");
  let searchScopeKey = props.command.key;
  createEffect(() => {
    const nextScopeKey = props.command.key;
    if (nextScopeKey === searchScopeKey) return;
    searchScopeKey = nextScopeKey;
    setSearchQuery("");
  });
  const groups = createMemo(() => {
    if (props.session.turns === undefined) {
      return groupTimelineEvents(props.session.timeline);
    }
    return Object.freeze(
      props.session.turns.flatMap((turn, index) =>
        groupTimelineEvents(turn.timeline, turn.profile, index + 1),
      ),
    );
  });
  const visibleGroups = createMemo(() =>
    filterTranscriptGroups(groups(), searchQuery()),
  );
  const [viewport, setViewport] = createSignal<TranscriptViewport>(
    Object.freeze({
      firstVisibleIndex: Math.max(
        0,
        visibleGroups().length - TRANSCRIPT_INITIAL_VISIBLE_GROUPS,
      ),
      visibleGroupCount: TRANSCRIPT_INITIAL_VISIBLE_GROUPS,
    }),
  );
  const [measurementRevision, setMeasurementRevision] = createSignal(0);
  const measuredGroupHeights = new Map<number, number>();
  const timelineDisclosureStore = createTimelineDisclosureStore();
  let followingLatest = true;
  let detachedByUser = false;
  let mounted = false;
  let timelineWindowElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let scrollFrame: number | undefined;
  let scrollTimeout: number | undefined;
  let measureFrame: number | undefined;
  let searchMatchScrollFrame: number | undefined;
  let latestScrollFrame: number | undefined;
  let latestScrollTimeout: number | undefined;
  let pendingLatestScroll = false;
  let pendingLatestScrollOrigin: number | undefined;
  let observedJumpLatestRequest = props.jumpLatestRequest;
  let observedWindowScopeKey = props.command.key;
  let observedWindowQuery = searchQuery();
  let observedTimeline = props.session.timeline;

  const renderWindow = createMemo(() =>
    calculateTranscriptWindow({
      totalGroups: visibleGroups().length,
      firstVisibleIndex: viewport().firstVisibleIndex,
      visibleGroupCount: viewport().visibleGroupCount,
      overscanGroups: TRANSCRIPT_OVERSCAN_GROUPS,
    }),
  );
  const windowedGroups = createMemo(() =>
    sliceTranscriptWindow(visibleGroups(), renderWindow()),
  );
  const topSpacerHeight = (): number => {
    measurementRevision();
    return estimatedTranscriptOffset(
      renderWindow().startIndex,
      measuredGroupHeights,
      TRANSCRIPT_ESTIMATED_GROUP_HEIGHT,
    );
  };
  const bottomSpacerHeight = (): number => {
    measurementRevision();
    return Math.max(
      0,
      estimatedTranscriptOffset(
        visibleGroups().length,
        measuredGroupHeights,
        TRANSCRIPT_ESTIMATED_GROUP_HEIGHT,
      ) -
        estimatedTranscriptOffset(
          renderWindow().endIndex,
          measuredGroupHeights,
          TRANSCRIPT_ESTIMATED_GROUP_HEIGHT,
        ),
    );
  };

  const updateFollowingLatest = (next: boolean): void => {
    if (followingLatest === next) return;
    followingLatest = next;
    props.onFollowingLatestChange(next);
  };

  const visibleCountForScroller = (): number => {
    const height = props.scrollContainer()?.clientHeight ?? 0;
    return Math.max(
      1,
      Math.ceil(height / TRANSCRIPT_ESTIMATED_GROUP_HEIGHT) + 1,
    );
  };

  const setViewportAtLatest = (): void => {
    const totalGroups = visibleGroups().length;
    const visibleGroupCount = visibleCountForScroller();
    setViewport(
      Object.freeze({
        firstVisibleIndex: Math.max(0, totalGroups - visibleGroupCount),
        visibleGroupCount,
      }),
    );
  };

  const cancelLatestScroll = (): void => {
    pendingLatestScroll = false;
    pendingLatestScrollOrigin = undefined;
    if (
      latestScrollFrame !== undefined &&
      typeof window !== "undefined"
    ) {
      window.cancelAnimationFrame(latestScrollFrame);
      latestScrollFrame = undefined;
    }
    if (latestScrollTimeout !== undefined && typeof window !== "undefined") {
      window.clearTimeout(latestScrollTimeout);
      latestScrollTimeout = undefined;
    }
  };

  const scrollToLatest = (): void => {
    const scroller = props.scrollContainer();
    if (scroller === undefined) return;
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    pendingLatestScroll = false;
    pendingLatestScrollOrigin = undefined;
  };

  const queueScrollToLatest = (): void => {
    if (!pendingLatestScroll) {
      pendingLatestScrollOrigin = props.scrollContainer()?.scrollTop;
    }
    pendingLatestScroll = true;
    setViewportAtLatest();
    if (!mounted || typeof window === "undefined") return;
    if (latestScrollFrame !== undefined) return;
    const applyLatestScroll = (): void => {
      if (!pendingLatestScroll) return;
      if (latestScrollFrame !== undefined) {
        window.cancelAnimationFrame(latestScrollFrame);
        latestScrollFrame = undefined;
      }
      if (latestScrollTimeout !== undefined) {
        window.clearTimeout(latestScrollTimeout);
        latestScrollTimeout = undefined;
      }
      scrollToLatest();
    };
    latestScrollFrame = window.requestAnimationFrame(() => {
      latestScrollFrame = undefined;
      applyLatestScroll();
    });
    latestScrollTimeout = window.setTimeout(
      applyLatestScroll,
      TRANSCRIPT_LIVE_MAX_FLUSH_MS,
    );
  };

  const jumpToLatest = (): void => {
    detachedByUser = false;
    updateFollowingLatest(true);
    queueScrollToLatest();
  };

  const updateFollowingFromScroll = (): void => {
    const scroller = props.scrollContainer();
    if (scroller === undefined) return;
    const scrollTop = scroller.scrollTop;
    const distanceFromBottom = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - scrollTop,
    );

    if (searchQuery().trim().length > 0) {
      detachedByUser = true;
      updateFollowingLatest(false);
      return;
    }
    if (pendingLatestScroll) {
      const origin = pendingLatestScrollOrigin ?? scrollTop;
      if (
        Math.abs(scrollTop - origin) > 1 &&
        distanceFromBottom > TRANSCRIPT_BOTTOM_DISTANCE_PX
      ) {
        cancelLatestScroll();
        detachedByUser = true;
        updateFollowingLatest(false);
      }
      return;
    }
    if (distanceFromBottom <= TRANSCRIPT_BOTTOM_DISTANCE_PX) {
      detachedByUser = false;
      updateFollowingLatest(true);
      return;
    }
    detachedByUser = true;
    updateFollowingLatest(false);
  };

  const updateViewportFromScroll = (): void => {
    const scroller = props.scrollContainer();
    if (scroller === undefined) return;
    const scrollTop = scroller.scrollTop;
    const totalGroups = visibleGroups().length;
    if (totalGroups === 0) {
      setViewport(
        Object.freeze({ firstVisibleIndex: 0, visibleGroupCount: 1 }),
      );
      return;
    }
    const timelineTop = timelineWindowElement?.offsetTop ?? 0;
    const relativeTop = Math.max(0, scrollTop - timelineTop);
    const firstVisibleIndex = transcriptGroupAtOffset(
      totalGroups,
      relativeTop,
      measuredGroupHeights,
      TRANSCRIPT_ESTIMATED_GROUP_HEIGHT,
    );
    const lastVisibleIndex = transcriptGroupAtOffset(
      totalGroups,
      relativeTop + scroller.clientHeight,
      measuredGroupHeights,
      TRANSCRIPT_ESTIMATED_GROUP_HEIGHT,
    );
    const visibleGroupCount = Math.max(
      1,
      lastVisibleIndex - firstVisibleIndex + 1,
    );
    setViewport((current) =>
      current.firstVisibleIndex === firstVisibleIndex &&
      current.visibleGroupCount === visibleGroupCount
        ? current
        : Object.freeze({ firstVisibleIndex, visibleGroupCount }),
    );
  };

  const handleScroll = (): void => {
    updateFollowingFromScroll();
    if (
      scrollFrame !== undefined ||
      scrollTimeout !== undefined ||
      typeof window === "undefined"
    ) {
      return;
    }
    const applyScrollUpdate = (): void => {
      if (scrollFrame !== undefined) {
        window.cancelAnimationFrame(scrollFrame);
        scrollFrame = undefined;
      }
      if (scrollTimeout !== undefined) {
        window.clearTimeout(scrollTimeout);
        scrollTimeout = undefined;
      }
      updateViewportFromScroll();
    };
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      applyScrollUpdate();
    });
    scrollTimeout = window.setTimeout(
      applyScrollUpdate,
      TRANSCRIPT_LIVE_MAX_FLUSH_MS,
    );
  };

  const handleWheel = (event: WheelEvent): void => {
    if (event.deltaY >= 0) return;
    const scroller = props.scrollContainer();
    if (
      scroller === undefined ||
      scroller.scrollHeight <= scroller.clientHeight
    ) {
      return;
    }
    cancelLatestScroll();
    detachedByUser = true;
    updateFollowingLatest(false);
    const deltaMultiplier =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroller.clientHeight
          : 1;
    event.preventDefault();
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollTop + event.deltaY * deltaMultiplier,
    );
    updateFollowingFromScroll();
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    const scroller = props.scrollContainer();
    if (
      scroller === undefined ||
      event.target !== scroller ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const maximumScrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    let nextScrollTop: number;
    switch (event.key) {
      case "ArrowUp":
        nextScrollTop = scroller.scrollTop - 40;
        break;
      case "PageUp":
        nextScrollTop = scroller.scrollTop - scroller.clientHeight;
        break;
      case "Home":
        nextScrollTop = 0;
        break;
      case "ArrowDown":
        nextScrollTop = scroller.scrollTop + 40;
        break;
      case "PageDown":
        nextScrollTop = scroller.scrollTop + scroller.clientHeight;
        break;
      case "End":
        nextScrollTop = maximumScrollTop;
        break;
      default:
        return;
    }
    nextScrollTop = Math.min(maximumScrollTop, Math.max(0, nextScrollTop));
    event.preventDefault();
    if (nextScrollTop < scroller.scrollTop - 1) {
      cancelLatestScroll();
      detachedByUser = true;
      updateFollowingLatest(false);
    }
    scroller.scrollTop = nextScrollTop;
    updateFollowingFromScroll();
  };

  const measureRenderedGroups = (): void => {
    const timelineWindow = timelineWindowElement;
    if (timelineWindow === undefined) return;
    const scroller = props.scrollContainer();
    const anchorIndex = viewport().firstVisibleIndex;
    let anchorAdjustment = 0;
    let changed = false;
    for (const element of timelineWindow.querySelectorAll<HTMLElement>(
      "[data-transcript-group-index]",
    )) {
      const index = Number(element.dataset.transcriptGroupIndex);
      const height = element.getBoundingClientRect().height;
      if (!Number.isInteger(index) || index < 0 || height <= 0) continue;
      const previousHeight =
        measuredGroupHeights.get(index) ?? TRANSCRIPT_ESTIMATED_GROUP_HEIGHT;
      if (Math.abs(previousHeight - height) < 0.5) {
        continue;
      }
      measuredGroupHeights.set(index, height);
      if (!followingLatest && index < anchorIndex) {
        anchorAdjustment += height - previousHeight;
      }
      changed = true;
    }
    if (!changed) return;
    setMeasurementRevision((revision) => revision + 1);
    if (scroller !== undefined && Math.abs(anchorAdjustment) >= 0.5) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + anchorAdjustment);
    }
  };

  const queueMeasurement = (): void => {
    if (!mounted || typeof window === "undefined") return;
    if (measureFrame !== undefined) window.cancelAnimationFrame(measureFrame);
    measureFrame = window.requestAnimationFrame(() => {
      measureFrame = undefined;
      measureRenderedGroups();
    });
  };

  const queueScrollToFirstSearchMatch = (): void => {
    if (typeof window === "undefined") return;
    if (searchMatchScrollFrame !== undefined) {
      window.cancelAnimationFrame(searchMatchScrollFrame);
      searchMatchScrollFrame = undefined;
    }
    if (!mounted || searchQuery().trim().length === 0) return;
    searchMatchScrollFrame = window.requestAnimationFrame(() => {
      searchMatchScrollFrame = undefined;
      const scroller = props.scrollContainer();
      const match = timelineWindowElement?.querySelector<HTMLElement>(
        "mark[data-transcript-search-match]",
      );
      if (scroller === undefined || match === undefined || match === null) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const matchRect = match.getBoundingClientRect();
      if (
        matchRect.top < scrollerRect.top ||
        matchRect.bottom > scrollerRect.bottom
      ) {
        scroller.scrollTop +=
          matchRect.top -
          scrollerRect.top -
          (scroller.clientHeight - matchRect.height) / 2;
        updateViewportFromScroll();
      }
    });
  };

  createEffect(() => {
    renderWindow().startIndex;
    renderWindow().endIndex;
    queueMeasurement();
  });

  createEffect(() => {
    const nextRequest = props.jumpLatestRequest;
    if (nextRequest === observedJumpLatestRequest) return;
    observedJumpLatestRequest = nextRequest;
    jumpToLatest();
  });

  createEffect(() => {
    const nextScopeKey = props.command.key;
    const nextQuery = searchQuery();
    const nextTimeline = props.session.timeline;
    const scopeChanged = nextScopeKey !== observedWindowScopeKey;
    const queryChanged = nextQuery !== observedWindowQuery;
    const timelineChanged = nextTimeline !== observedTimeline;
    observedWindowScopeKey = nextScopeKey;
    observedWindowQuery = nextQuery;
    observedTimeline = nextTimeline;

    if (scopeChanged) {
      measuredGroupHeights.clear();
      timelineDisclosureStore.clear();
      setMeasurementRevision((revision) => revision + 1);
      detachedByUser = false;
      updateFollowingLatest(true);
      queueScrollToLatest();
      return;
    }
    if (queryChanged) {
      measuredGroupHeights.clear();
      setMeasurementRevision((revision) => revision + 1);
      cancelLatestScroll();
      detachedByUser = true;
      updateFollowingLatest(false);
      setViewport(
        Object.freeze({
          firstVisibleIndex: 0,
          visibleGroupCount: visibleCountForScroller(),
        }),
      );
      const scroller = props.scrollContainer();
      if (scroller !== undefined) scroller.scrollTop = 0;
      queueScrollToFirstSearchMatch();
      return;
    }
    if (timelineChanged && followingLatest) queueScrollToLatest();
  });

  onMount(() => {
    mounted = true;
    const scroller = props.scrollContainer();
    if (scroller !== undefined) {
      scroller.addEventListener("scroll", handleScroll, { passive: true });
      scroller.addEventListener("wheel", handleWheel, { passive: false });
      scroller.addEventListener("keydown", handleKeyDown);
    }
    resizeObserver = new ResizeObserver(() => {
      queueMeasurement();
      if (followingLatest) queueScrollToLatest();
    });
    if (timelineWindowElement !== undefined) {
      resizeObserver.observe(timelineWindowElement);
    }
    props.onFollowingLatestChange(true);
    queueMeasurement();
    queueScrollToLatest();
  });

  onCleanup(() => {
    mounted = false;
    const scroller = props.scrollContainer();
    if (scroller !== undefined) {
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("wheel", handleWheel);
      scroller.removeEventListener("keydown", handleKeyDown);
    }
    resizeObserver?.disconnect();
    if (typeof window !== "undefined") {
      if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
      if (scrollTimeout !== undefined) window.clearTimeout(scrollTimeout);
      if (measureFrame !== undefined) window.cancelAnimationFrame(measureFrame);
      if (searchMatchScrollFrame !== undefined) {
        window.cancelAnimationFrame(searchMatchScrollFrame);
      }
    }
    cancelLatestScroll();
  });

  const searching = () => searchQuery().trim().length > 0;
  return (
    <>
      <div class="transcript-tools">
        <input
          type="search"
          class="transcript-search-input"
          placeholder={transcriptCopy.searchPlaceholder}
          aria-label={transcriptCopy.searchAria}
          aria-keyshortcuts="Control+F"
          value={searchQuery()}
          onInput={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setSearchQuery("");
            }
          }}
        />
        <span class="transcript-search-count" role="status">
          {searching()
            ? transcriptSearchCountCopy(
                new Set(visibleGroups().map((group) => group.turnOrdinal)).size,
                new Set(groups().map((group) => group.turnOrdinal)).size,
              )
            : ""}
        </span>
      </div>
      <div class="timeline-window" ref={timelineWindowElement}>
        <div
          class="timeline-window-spacer"
          style={{ height: `${topSpacerHeight()}px` }}
          aria-hidden="true"
        />
        <Show when={searching() && visibleGroups().length === 0}>
          <EmptyState
            title={transcriptCopy.noSearchResultsTitle}
            body={transcriptCopy.noSearchResultsBody}
          />
        </Show>
        <TimelineTurns
          command={props.command}
          groups={windowedGroups()}
          searchQuery={searchQuery()}
          startIndex={renderWindow().startIndex}
          totalGroupCount={visibleGroups().length}
          disclosureStore={timelineDisclosureStore}
        />
        <div
          class="timeline-window-spacer"
          style={{ height: `${bottomSpacerHeight()}px` }}
          aria-hidden="true"
        />
      </div>
      <Show
        when={
          props.command.status === "failed" &&
          props.command.failureCategory !== "interrupted"
        }
      >
        <div class="rule rule-fail">
          <span class="rule-label">{transcriptCopy.sessionEndedRule}</span>
        </div>
        <div class="failure-block">
          <h3>{transcriptCopy.failedTitle}</h3>
          <p>
            {props.command.failureCategory === "quota-expired"
              ? failureCopy["quota-expired"] : transcriptFailureBodyCopy(props.session)}
          </p>
        </div>
      </Show>
      <Show when={props.command.failureCategory === "interrupted"}>
        <div class="rule">
          <span class="rule-label">{transcriptCopy.interruptedRule}</span>
        </div>
        <div class="failure-block recovery-block interruption-block">
          <h3>{transcriptCopy.interruptedTitle}</h3>
          <p>
            {transcriptCopy.interruptedBody}
          </p>
        </div>
      </Show>
      <For each={props.session.turns}>
        {(turn, index) => <Show when={turn.recovery}>
          {(recovery) => <div class="failure-block recovery-block">
            <h3>{turnOrdinalCopy(index() + 1)} · {transcriptCopy.outcomeUnknownRule}</h3>
            <p>{turnRecoveryBodyCopy(recovery())}</p>
          </div>}
        </Show>}
      </For>
      <Show when={props.command.status === "recovery-required" && !props.session.turns?.at(-1)?.recovery}>
        <div class="rule rule-fail">
          <span class="rule-label">{transcriptCopy.outcomeUnknownRule}</span>
        </div>
        <div class="failure-block recovery-block">
          <h3>{transcriptCopy.recoveryTitle}</h3>
          <p>
            {transcriptCopy.recoveryBody}
          </p>
        </div>
      </Show>
      <Show
        when={
          props.session.timeline.length === 0 &&
          props.command.status !== "failed" &&
          props.command.status !== "recovery-required"
        }
      >
        <EmptyState
          title={transcriptCopy.noNormalizedEventsTitle}
          body={transcriptCopy.noNormalizedEventsBody}
        />
      </Show>
      <div class="timeline-tail-spacer" aria-hidden="true"></div>
    </>
  );
};

type AgentMessageBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "unordered-list"; readonly items: readonly string[] }
  | { readonly kind: "ordered-list"; readonly items: readonly string[] }
  | { readonly kind: "code"; readonly text: string };

function agentMessageBlocks(text: string): readonly AgentMessageBlock[] {
  const blocks: AgentMessageBlock[] = [];
  let paragraph: string[] = [];
  let listKind: "unordered-list" | "ordered-list" | null = null;
  let listItems: string[] = [];
  let codeLines: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(
      Object.freeze({ kind: "paragraph", text: paragraph.join(" ") }),
    );
    paragraph = [];
  };
  const flushList = (): void => {
    if (listKind === null || listItems.length === 0) return;
    blocks.push(
      Object.freeze({ kind: listKind, items: Object.freeze(listItems) }),
    );
    listKind = null;
    listItems = [];
  };
  const flushCode = (): void => {
    if (codeLines === null) return;
    blocks.push(Object.freeze({ kind: "code", text: codeLines.join("\n") }));
    codeLines = null;
  };

  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (codeLines === null) {
        flushParagraph();
        flushList();
        codeLines = [];
      } else {
        flushCode();
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }
    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^#{1,3}\s+(.+)$/u.exec(trimmed);
    if (heading?.[1] !== undefined) {
      flushParagraph();
      flushList();
      blocks.push(Object.freeze({ kind: "heading", text: heading[1] }));
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/u.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/u.exec(trimmed);
    const nextListKind = unordered === null ? "ordered-list" : "unordered-list";
    const listItem = unordered?.[1] ?? ordered?.[1];
    if (listItem !== undefined) {
      flushParagraph();
      if (listKind !== null && listKind !== nextListKind) flushList();
      listKind = nextListKind;
      listItems.push(listItem);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }
  flushCode();
  flushParagraph();
  flushList();
  return Object.freeze(blocks);
}

const SearchHighlightedText: Component<{
  readonly text: string;
  readonly query: string;
}> = (props) => (
  <For each={splitTranscriptSearchText(props.text, props.query)}>
    {(segment) =>
      segment.match ? (
        <mark data-transcript-search-match>{segment.text}</mark>
      ) : (
        segment.text
      )
    }
  </For>
);

const AgentInlineText: Component<{
  readonly text: string;
  readonly searchQuery: string;
}> = (props) => {
  const tokens = () =>
    props.text
      .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/u)
      .filter((token) => token.length > 0);
  return (
    <For each={tokens()}>
      {(token) =>
        token.startsWith("`") ? (
          <code>
            <SearchHighlightedText
              text={token.slice(1, -1)}
              query={props.searchQuery}
            />
          </code>
        ) : token.startsWith("**") ? (
          <strong>
            <SearchHighlightedText
              text={token.slice(2, -2)}
              query={props.searchQuery}
            />
          </strong>
        ) : (
          <SearchHighlightedText text={token} query={props.searchQuery} />
        )
      }
    </For>
  );
};

const AgentCodeBlock: Component<{
  readonly text: string;
  readonly searchQuery: string;
}> = (props) => {
  const bridge = useContext(WorkbenchRendererBridgeContext);
  const [copyState, setCopyState] = createSignal<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  const copyCode = (): void => {
    let write: Promise<boolean> | undefined;
    try {
      const writeClipboardText = bridge?.writeClipboardText;
      write =
        writeClipboardText === undefined
          ? navigator.clipboard?.writeText(props.text).then(() => true)
          : writeClipboardText(props.text).then((result) => result.ok);
    } catch {
      setCopyState("failed");
      return;
    }
    if (write === undefined) {
      setCopyState("failed");
      return;
    }
    setCopyState("copying");
    void write.then(
      (copied) => setCopyState(copied ? "copied" : "failed"),
      () => setCopyState("failed"),
    );
  };
  const copyLabel = () =>
    copyState() === "copying"
      ? transcriptCopy.copyingButton
      : copyState() === "copied"
        ? transcriptCopy.copiedButton
        : copyState() === "failed"
          ? transcriptCopy.copyFailedButton
          : transcriptCopy.copyButton;
  return (
    <div class="codeblock-shell">
      <button
        type="button"
        class="codeblock-copy"
        aria-label={transcriptCopy.copyCodeAria}
        aria-busy={copyState() === "copying"}
        title={copyLabel()}
        onClick={copyCode}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5.5 4.5v-2h8v8h-2m-9-5h8v8h-8z" />
        </svg>
        <span aria-live="polite">{copyLabel()}</span>
      </button>
      <pre class="codeblock">
        <code>
          <SearchHighlightedText text={props.text} query={props.searchQuery} />
        </code>
      </pre>
    </div>
  );
};

const AgentMessageBlockView: Component<{
  readonly block: AgentMessageBlock;
  readonly streaming: boolean;
  readonly searchQuery: string;
}> = (props) => {
  const caret = () => (
    <Show when={props.streaming}>
      <span class="caret" aria-hidden="true" />
    </Show>
  );
  switch (props.block.kind) {
    case "paragraph":
      return (
        <p>
          <AgentInlineText
            text={props.block.text}
            searchQuery={props.searchQuery}
          />
          {caret()}
        </p>
      );
    case "heading":
      return (
        <h3 class="agent-heading">
          <AgentInlineText
            text={props.block.text}
            searchQuery={props.searchQuery}
          />
          {caret()}
        </h3>
      );
    case "unordered-list": {
      const items = props.block.items;
      return (
        <ul>
          <For each={items}>
            {(item, index) => (
              <li>
                <AgentInlineText text={item} searchQuery={props.searchQuery} />
                <Show when={index() === items.length - 1}>
                  {caret()}
                </Show>
              </li>
            )}
          </For>
        </ul>
      );
    }
    case "ordered-list": {
      const items = props.block.items;
      return (
        <ol class="agent-list-ordered">
          <For each={items}>
            {(item, index) => (
              <li>
                <AgentInlineText text={item} searchQuery={props.searchQuery} />
                <Show when={index() === items.length - 1}>
                  {caret()}
                </Show>
              </li>
            )}
          </For>
        </ol>
      );
    }
    case "code":
      return (
        <>
          <AgentCodeBlock
            text={props.block.text}
            searchQuery={props.searchQuery}
          />
          {caret()}
        </>
      );
  }
};

const AgentMessageText: Component<{
  readonly text: string;
  readonly streaming: boolean;
  readonly searchQuery: string;
}> = (props) => {
  const blocks = createMemo(() => agentMessageBlocks(props.text));
  return (
    <Show
      when={blocks().length > 0}
      fallback={
        <p>
          <Show when={props.streaming}>
            <span class="caret" aria-hidden="true" />
          </Show>
        </p>
      }
    >
      <For each={blocks()}>
        {(block, index) => (
          <AgentMessageBlockView
            block={block}
            streaming={props.streaming && index() === blocks().length - 1}
            searchQuery={props.searchQuery}
          />
        )}
      </For>
    </Show>
  );
};

// A long user prompt clamps to four visible lines by default with an
// explicit toggle (issue #6 case 5): the stored text is always complete —
// the timeline persists the full input verbatim — so the affordance is a
// reading aid, never a truncation. The threshold mirrors the clamp: below
// it the text cannot overflow, so no toggle is offered.
const USER_PROMPT_CLAMP_LINES = 4;
const USER_PROMPT_CLAMP_THRESHOLD = 4 * 90;

const isLongUserPrompt = (text: string): boolean =>
  text.length > USER_PROMPT_CLAMP_THRESHOLD || text.split("\n").length > USER_PROMPT_CLAMP_LINES;

const UserMessageTurn: Component<{
  readonly text: string;
  readonly searchQuery: string;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const long = () => isLongUserPrompt(props.text);
  return (
    <article class="turn turn-user">
      <header class="turn-head">
        <span class="turn-actor actor-user">{transcriptCopy.actorUser}</span>
      </header>
      <div
        class={`turn-body user-message-text${
          long() && !expanded() && props.searchQuery.trim().length === 0
            ? " is-clamped"
            : ""
        }`}
        aria-label={
          long() && !expanded() && props.searchQuery.trim().length === 0
            ? transcriptCopy.longPromptAria
            : undefined
        }
      >
        <SearchHighlightedText text={props.text} query={props.searchQuery} />
      </div>
      <Show when={long()}>
        <button
          type="button"
          class="user-message-toggle"
          aria-expanded={expanded()}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded()
            ? transcriptCopy.longPromptCollapse
            : transcriptCopy.longPromptExpand}
        </button>
      </Show>
    </article>
  );
};

interface TimelineDisclosureState {
  readonly turnKey: string;
  readonly active: boolean;
  readonly open: boolean;
  readonly userToggled: boolean;
}

interface TimelineDisclosureStore {
  readonly state: (
    turnKey: string,
    active: boolean,
  ) => TimelineDisclosureState;
  readonly reconcile: (turnKey: string, active: boolean) => void;
  readonly toggle: (turnKey: string, active: boolean) => void;
  readonly clear: () => void;
}

function initialTimelineDisclosureState(
  turnKey: string,
  active: boolean,
): TimelineDisclosureState {
  return Object.freeze({
    turnKey,
    active,
    open: active,
    userToggled: false,
  });
}

function reconcileTimelineDisclosure(
  state: TimelineDisclosureState,
  turnKey: string,
  active: boolean,
): TimelineDisclosureState {
  if (state.turnKey !== turnKey) {
    return initialTimelineDisclosureState(turnKey, active);
  }
  if (state.active === active) return state;
  return Object.freeze({
    ...state,
    active,
    open: state.userToggled ? state.open : active,
  });
}

function toggleTimelineDisclosure(
  state: TimelineDisclosureState,
): TimelineDisclosureState {
  return Object.freeze({
    ...state,
    open: !state.open,
    userToggled: true,
  });
}

function createTimelineDisclosureStore(): TimelineDisclosureStore {
  const [states, setStates] = createSignal<
    ReadonlyMap<string, TimelineDisclosureState>
  >(new Map());
  const update = (
    turnKey: string,
    active: boolean,
    change: (state: TimelineDisclosureState) => TimelineDisclosureState,
  ): void => {
    setStates((current) => {
      const recorded = current.get(turnKey);
      const next = change(
        recorded ?? initialTimelineDisclosureState(turnKey, active),
      );
      if (recorded === next) return current;
      const updated = new Map(current);
      updated.set(turnKey, next);
      return updated;
    });
  };
  return Object.freeze({
    state(turnKey: string, active: boolean): TimelineDisclosureState {
      const recorded = states().get(turnKey);
      return recorded === undefined
        ? initialTimelineDisclosureState(turnKey, active)
        : reconcileTimelineDisclosure(recorded, turnKey, active);
    },
    reconcile(turnKey: string, active: boolean): void {
      update(turnKey, active, (state) =>
        reconcileTimelineDisclosure(state, turnKey, active),
      );
    },
    toggle(turnKey: string, active: boolean): void {
      update(turnKey, active, toggleTimelineDisclosure);
    },
    clear(): void {
      setStates((current) => (current.size === 0 ? current : new Map()));
    },
  });
}

function rawTimelineEventDetail(
  event: RuntimeTimelineEvent,
  streaming: boolean,
): string {
  switch (event.kind) {
    case "session-started":
    case "turn-started":
    case "failed":
    case "turn-paused":
      return "";
    case "item-started":
    case "item-completed":
      return dynamicCopy.timelineToken[event.itemType];
    case "agent-message":
      return streaming ? event.text : "";
    case "reasoning":
      return event.text;
    case "progress":
      return progressActivityDetail(event);
    case "turn-completed":
      return dynamicCopy.timelineToken[event.status];
    case "turn-interrupted":
      return dynamicCopy.timelineToken[event.status];
  }
}

function progressActivityDetail(event: ProgressTimelineEvent): string {
  if (event.activity !== "tool" || event.tool === undefined) {
    return transcriptCopy.progressActivity[event.activity];
  }
  const tool = event.tool;
  const name =
    tool.name.trim().length === 0 || tool.name === "未知工具"
      ? transcriptCopy.unknownToolName
      : tool.name;
  const parts = [name];
  if (tool.parameter !== undefined) {
    parts.push(tool.parameter.value);
    if (tool.parameter.truncated) {
      parts.push(transcriptCopy.toolParameterTruncated);
    }
  }
  if (tool.type === "unknown" && tool.sourceType !== undefined) {
    parts.push(transcriptCopy.unknownToolType(tool.sourceType));
  }
  return parts.join(" ");
}

function fileChangeSummaryDetail(summary: WorkbenchFileChangeSummary): string {
  const details = summary.files.map((file) => {
    const parts = [file.path];
    if (file.truncated) parts.push(transcriptCopy.toolParameterTruncated);
    if (file.lines !== undefined) {
      parts.push(
        transcriptCopy.fileChangeLineCounts(
          file.lines.additions,
          file.lines.deletions,
        ),
      );
    }
    return parts.join(" ");
  });
  if (summary.truncated) {
    details.push(
      transcriptCopy.fileChangesOmitted(
        summary.totalFiles - summary.files.length,
      ),
    );
  }
  return transcriptCopy.fileChangeSummary(
    summary.totalFiles,
    details.join(transcriptCopy.fileChangeSeparator),
  );
}

const TimelineTurns: Component<{
  readonly command: WorkbenchCommandView;
  readonly groups: readonly TimelineEventGroup[];
  readonly searchQuery?: string;
  readonly startIndex?: number;
  readonly totalGroupCount?: number;
  readonly disclosureStore: TimelineDisclosureStore;
}> = (props) => {
  const startIndex = (): number => props.startIndex ?? 0;
  const totalGroupCount = (): number =>
    props.totalGroupCount ?? props.groups.length;
  const groupKeys = createMemo(() => props.groups.map((group) => group.key));
  const groupsByKey = createMemo(
    () => new Map(props.groups.map((group) => [group.key, group] as const)),
  );
  const groupStatus = (
    group: TimelineEventGroup,
    index: number,
  ): WorkbenchCommandView["status"] => {
    if (
      props.command.session?.turns?.[group.turnOrdinal - 1]?.recovery !== undefined
    ) {
      return "recovery-required";
    }
    if (group.events.some((event) => event.kind === "failed")) return "failed";
    if (group.events.some((event) => event.kind === "turn-completed")) {
      return "completed";
    }
    if (group.events.some((event) => event.kind === "turn-paused")) {
      return index === totalGroupCount() - 1 && props.command.failureCategory === "quota-expired" ? "failed" : "quota-paused";
    }
    return index === totalGroupCount() - 1
      ? props.command.status
      : "completed";
  };
  return (
    <For each={groupKeys()}>
      {(groupKey, index) => {
        const group = createMemo<TimelineEventGroup>(() => {
          const current = groupsByKey().get(groupKey);
          if (current === undefined) {
            throw new Error("timeline-group-key-unavailable");
          }
          return current;
        });
        const groupIndex = () => startIndex() + index();
        const status = () => groupStatus(group(), groupIndex());
        const turnLabel = () =>
          !group().guidance &&
          (status() === "failed" || status() === "recovery-required") &&
          !group().events.some((event) => event.kind === "turn-started")
            ? transcriptCopy.turnNotStarted
            : group().guidance
              ? guidanceTurnOrdinalCopy(group().turnOrdinal)
              : turnOrdinalCopy(group().turnOrdinal);
        const active = () =>
          (status() === "accepted" || status() === "in-flight") &&
          !group().events.some(
            (event) =>
              event.kind === "turn-completed" ||
              event.kind === "turn-interrupted" ||
              event.kind === "turn-paused" ||
              event.kind === "failed",
          );
        return (
          <section
            class="timeline-group"
            data-transcript-group-index={groupIndex()}
            data-transcript-group-key={groupKey}
          >
            <Show
              when={group().events.some(
                (event) => event.kind === "session-started",
              )}
            >
              <div class="rule rule-start">
                <span class="rule-label">
                  {transcriptCopy.sessionStartedRule}
                  <span class="mono">
                    {turnProfileSummary(group().profile, props.command.runtime)}
                  </span>
                </span>
              </div>            </Show>
            <Show when={group().userMessage}>
              {(userMessage) => (
                <UserMessageTurn
                  text={userMessage().text}
                  searchQuery={props.searchQuery ?? ""}
                />
              )}
            </Show>
            <div class="rule rule-end">
              <span class="rule-label">{turnLabel()}</span>
            </div>
            <TimelineTurn
              command={props.command}
              searchQuery={props.searchQuery ?? ""}
              profile={group().profile}
              turnKey={`${props.command.key}:${groupKey}`}
              events={group().events}
              status={status()}
              interrupted={group().events.some(
                (event) => event.kind === "turn-interrupted",
              )}
              active={active()}
              disclosureStore={props.disclosureStore}
            />
          </section>
        );
      }}
    </For>
  );
};

const TimelineTurn: Component<{
  readonly command: WorkbenchCommandView;
  readonly searchQuery?: string;
  readonly profile?: WorkbenchSessionProfileProjection;
  readonly turnKey: string;
  readonly events: readonly RuntimeTimelineEvent[];
  readonly status: WorkbenchCommandView["status"];
  readonly interrupted: boolean;
  readonly active: boolean;
  readonly disclosureStore: TimelineDisclosureStore;
}> = (props) => {
  const eventLogId = `timeline-events-${createUniqueId()}`;
  const runtimeFamily = () =>
    turnRuntimeFamily(props.profile, props.command.runtime);
  createEffect(() => {
    props.disclosureStore.reconcile(props.turnKey, props.active);
  });
  const disclosure = () =>
    props.disclosureStore.state(props.turnKey, props.active);
  const eventLogRevealedBySearch = () =>
    (props.searchQuery?.trim().length ?? 0) > 0 &&
    props.events.some((event) =>
      transcriptEventMetadataMatchesQuery(event, props.searchQuery ?? ""),
    );
  const eventLogOpen = () => disclosure().open || eventLogRevealedBySearch();
  const messages = () =>
    props.events.filter(
      (
        event,
      ): event is Extract<RuntimeTimelineEvent, { readonly kind: "agent-message" }> =>
        event.kind === "agent-message",
    );
  const streaming = () => props.active && messages().length > 0;
  const content = () => {
    const entries: Array<{ kind: "agent-message" | "reasoning"; text: string }> = [];
    for (const event of props.events) {
      if (event.kind !== "agent-message" && event.kind !== "reasoning") continue;
      const last = entries.at(-1);
      if (event.kind === "reasoning" && last?.kind === "reasoning") last.text += event.text;
      else entries.push({ kind: event.kind, text: event.text });
    }
    return entries;
  };
  // Issue #6 case 4: while a turn is alive, the newest progress note names
  // what the runtime is doing right now, so a thinking or retrying turn no
  // longer reads as a dead one. Ended turns keep their plain states.
  const latestProgress = (): string | null => {
    if (!props.active) return null;
    let latest: ProgressTimelineEvent | undefined;
    for (const event of props.events) {
      if (event.kind === "progress") latest = event;
    }
    return latest === undefined
      ? null
      : progressActivityDetail(latest);
  };
  const fileChangeSummaries = (): readonly WorkbenchFileChangeSummary[] => {
    const summaries: WorkbenchFileChangeSummary[] = [];
    for (const event of props.events) {
      if (
        event.kind === "progress" &&
        event.tool?.type === "fileChange" &&
        event.tool.fileChanges !== undefined
      ) {
        summaries.push(event.tool.fileChanges);
      }
    }
    return summaries;
  };
  return (
    <article class="turn">
      <header class="turn-head">
        <span
          class={"rt-dot " + runtimeClass(runtimeFamily())}
          aria-hidden="true"
        />
        <span
          class={
            "turn-actor rt-name " +
            runtimeClass(runtimeFamily())
          }
        >
          {runtimeFamily()}
        </span>
        <span
          class={
            "turn-model " + runtimeClass(runtimeFamily())
          }
        >
          {turnEffectiveProfileLabel(props.profile, "model", props.active)}
        </span>
        <span
          class={
            "turn-intensity " + runtimeClass(runtimeFamily())
          }
        >
          {prefixedProfileValueCopy(
            turnEffectiveProfileLabel(
              props.profile,
              "workIntensity",
              props.active,
            ),
          )}
        </span>
        <span
          class={
            "turn-state " +
            (props.interrupted ? "is-interrupted" : turnStateClass(props.status))
          }
          aria-live="polite"
          aria-atomic="true"
        >
          {props.active
            ? transcriptCopy.stateWorking
            : props.interrupted
              ? transcriptCopy.stateInterrupted
              : turnStateLabel(props.status)}
        </span>
        <span class="turn-spacer" />
        <button
          type="button"
          class="disclosure"
          aria-expanded={eventLogOpen()}
          aria-controls={eventLogId}
          onClick={() =>
            props.disclosureStore.toggle(props.turnKey, props.active)
          }
        >
          {eventsDisclosureCopy(props.events.length)}{" "}
          <span aria-hidden="true">{eventLogOpen() ? "▴" : "▾"}</span>
        </button>
      </header>
      <div class="turn-body prose">
        <Show
          when={content().length > 0}
          fallback={
            <p aria-live="polite">
              {props.active
                ? transcriptCopy.runtimeWorking
                : props.interrupted
                  ? transcriptCopy.interruptedBeforeMessage
                  : transcriptCopy.noAgentMessageRecorded}
            </p>
          }
        >
          <Index each={content()}>
            {(entry, index) => (
              <Show when={entry().kind === "reasoning"} fallback={
                <AgentMessageText
                  text={entry().text}
                  streaming={streaming() && index === content().length - 1}
                  searchQuery={props.searchQuery ?? ""}
                />
              }>
                <details class="turn-reasoning" open>
                  <summary>{transcriptCopy.reasoning}</summary>
                  <p style={{ "white-space": "pre-wrap" }}>
                    <SearchHighlightedText
                      text={entry().text}
                      query={props.searchQuery ?? ""}
                    />
                  </p>
                </details>
              </Show>
            )}
          </Index>
        </Show>
        <For each={fileChangeSummaries()}>
          {(summary) => (
            <p class="turn-file-changes">
              {fileChangeSummaryDetail(summary)}
            </p>
          )}
        </For>
        <Show when={props.active}>
          <p class="turn-progress" aria-live="polite">
            {latestProgress() ?? (content().length > 0 ? transcriptCopy.runtimeWorking : "")}
            <span class="caret" aria-hidden="true" />
          </p>
        </Show>
      </div>
      <ol
        id={eventLogId}
        class="event-log"
        aria-label={transcriptCopy.eventLogAria}
        hidden={!eventLogOpen()}
      >
        <Show when={eventLogOpen()}>
          <For each={props.events}>
            {(event, index) => (
              <li>
                <span>{String(index() + 1).padStart(2, "0")}</span>
                <span class="ev-kind">
                  <Show
                    when={transcriptEventMetadataMatchesQuery(
                      event,
                      props.searchQuery ?? "",
                    )}
                    fallback={dynamicCopy.timelineToken[event.kind]}
                  >
                    <mark data-transcript-search-match>
                      {dynamicCopy.timelineToken[event.kind]}
                    </mark>
                  </Show>
                </span>
                <span>
                  <SearchHighlightedText
                    text={rawTimelineEventDetail(event, streaming())}
                    query={props.searchQuery ?? ""}
                  />
                </span>
              </li>
            )}
          </For>
        </Show>
      </ol>
    </article>
  );
};

function recordedRequestedTurnProfile(
  profile: WorkbenchSessionProfileProjection | undefined,
) {
  const requested = profile?.requested;
  return requested?.kind === "recorded" ? requested : undefined;
}

function turnRuntimeFamily(
  profile: WorkbenchSessionProfileProjection | undefined,
  fallbackRuntime: string,
): string {
  return recordedRequestedTurnProfile(profile)?.runtimeFamilyLabel ?? fallbackRuntime;
}

/**
 * Issue #6 case 2. The effective projection's `unknown` arm carries no
 * per-field data, so it can only ever describe both nouns at once, and what it
 * describes is the *observation*: the coordinator records it for a turn that
 * ended before the Runtime reported an effective profile, and the live view
 * supplies it for every turn that has not ended yet. Neither state makes the
 * selection unknown -- the requested value is printed in the same line -- so
 * the label says which of the two it is instead of asserting a lost model.
 */
function turnEffectiveProfileLabel(
  profile: WorkbenchSessionProfileProjection | undefined,
  field: "model" | "workIntensity",
  observationPending: boolean,
): string {
  const noun = field === "model" ? composerControlCopy.model : composerControlCopy.workIntensity;
  const requested = recordedRequestedTurnProfile(profile);
  const requestedLabel =
    field === "model" ? requested?.modelLabel : requested?.workIntensityLabel;
  const effective = profile?.effective;
  if (effective === undefined || effective.kind === "not-recorded") {
    return effectiveNotRecordedCopy(noun);
  }
  if (effective.kind === "unknown") {
    if (observationPending) {
      return requestedLabel === undefined
        ? effectivePendingObservationCopy(noun)
        : effectivePendingObservationRequestedCopy(noun, requestedLabel);
    }
    return requestedLabel === undefined
      ? effectiveUnobservedCopy(noun)
      : effectiveUnobservedRequestedCopy(noun, requestedLabel);
  }
  const value = effective[field];
  return value.comparison === "matches-requested"
    ? value.label
    : differsFromRequestedWithFallbackCopy(
        dynamicCopy.observedDifferentValue,
        requestedLabel,
      );
}

function turnProfileSummary(
  profile: WorkbenchSessionProfileProjection | undefined,
  fallbackRuntime: string,
): string {
  const requested = recordedRequestedTurnProfile(profile);
  return requested === undefined
    ? profileNotRecordedSummaryCopy(fallbackRuntime)
    : recordedProfileSummaryCopy(requested);
}

export function turnStateClass(status: WorkbenchCommandView["status"]): string {
  switch (status) {
    case "accepted":
    case "in-flight":
      return "is-running";
    case "completed":
      return "is-done";
    case "quota-paused":
      return "is-recovery";
    case "failed":
      return "is-failed";
    case "recovery-required":
      return "is-recovery";
  }
}

function turnStateLabel(status: WorkbenchCommandView["status"]): string {
  return turnStateCopy[status];
}
