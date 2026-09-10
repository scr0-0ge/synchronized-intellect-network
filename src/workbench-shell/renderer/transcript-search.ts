import type {
  WorkbenchSessionProfileProjection,
  WorkbenchTimelineEvent,
} from "../contract.ts";
import type { WorkbenchNewAgentSessionShortcutEvent } from "./view-model.ts";

export type UserMessageTimelineEvent = Extract<
  WorkbenchTimelineEvent,
  { readonly kind: "user-message" }
>;

export type RuntimeTimelineEvent = Exclude<
  WorkbenchTimelineEvent,
  UserMessageTimelineEvent
>;

export interface TimelineEventGroup {
  /** Stable business identity: Direct Project Command ordinal plus its same-turn group ordinal. */
  readonly key: string;
  readonly userMessage?: UserMessageTimelineEvent;
  readonly events: readonly RuntimeTimelineEvent[];
  readonly profile?: WorkbenchSessionProfileProjection;
  /** Direct Project Command ordinal, shared by its same-turn guidance. */
  readonly turnOrdinal: number;
  readonly guidance: boolean;
}

export interface TranscriptSearchTextSegment {
  readonly text: string;
  readonly match: boolean;
}

export function groupTimelineEvents(
  events: readonly WorkbenchTimelineEvent[],
  profile?: WorkbenchSessionProfileProjection,
  fixedTurnOrdinal?: number,
): readonly TimelineEventGroup[] {
  const groups: TimelineEventGroup[] = [];
  let userMessage: UserMessageTimelineEvent | undefined;
  let current: RuntimeTimelineEvent[] = [];
  let guidance = false;
  let seenUserMessage = false;
  const flush = (): void => {
    if (userMessage === undefined && current.length === 0) return;
    const sourceGroupOrdinal = groups.length + 1;
    const turnOrdinal = fixedTurnOrdinal ?? sourceGroupOrdinal;
    const groupOrdinal = fixedTurnOrdinal === undefined ? 1 : sourceGroupOrdinal;
    groups.push(
      Object.freeze({
        key: `turn:${turnOrdinal}:group:${groupOrdinal}`,
        ...(userMessage === undefined ? {} : { userMessage }),
        events: Object.freeze(current),
        ...(profile === undefined ? {} : { profile }),
        turnOrdinal,
        guidance,
      }),
    );
    userMessage = undefined;
    current = [];
    guidance = false;
  };

  if (!events.some((event) => event.kind === "user-message")) {
    for (const event of events) {
      if (event.kind === "user-message") continue;
      if (
        event.kind === "turn-started" &&
        current.some((candidate) => candidate.kind === "turn-started")
      ) {
        flush();
      }
      current.push(event);
    }
    flush();
    return Object.freeze(groups);
  }

  for (const event of events) {
    if (event.kind === "user-message") {
      flush();
      guidance = fixedTurnOrdinal !== undefined && seenUserMessage;
      userMessage = event;
      seenUserMessage = true;
      continue;
    }
    current.push(event);
  }
  flush();
  return Object.freeze(groups);
}

/**
 * Case-insensitive client-side turn filter. An empty or blank query is a
 * passthrough: the exact input array reference comes back so clearing the box
 * does not create a redundant filtered collection.
 */
export function filterTranscriptGroups(
  groups: readonly TimelineEventGroup[],
  query: string,
): readonly TimelineEventGroup[] {
  try {
    const needle = query.trim().toLowerCase();
    if (!Array.isArray(groups)) return Object.freeze([]);
    if (needle.length === 0) return groups;
    return Object.freeze(
      groups.filter((group) =>
        transcriptGroupHaystack(group).includes(needle),
      ),
    );
  } catch {
    return Object.freeze([]);
  }
}

export function countTranscriptSearchMatches(
  groups: readonly TimelineEventGroup[],
  query: string,
): number {
  return filterTranscriptGroups(groups, query).length;
}

export function splitTranscriptSearchText(
  text: string,
  query: string,
): readonly TranscriptSearchTextSegment[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return Object.freeze([Object.freeze({ text, match: false })]);
  }

  const haystack = text.toLowerCase();
  const segments: TranscriptSearchTextSegment[] = [];
  let offset = 0;
  for (;;) {
    const matchIndex = haystack.indexOf(needle, offset);
    if (matchIndex < 0) break;
    if (matchIndex > offset) {
      segments.push(
        Object.freeze({ text: text.slice(offset, matchIndex), match: false }),
      );
    }
    const matchEnd = matchIndex + needle.length;
    segments.push(
      Object.freeze({ text: text.slice(matchIndex, matchEnd), match: true }),
    );
    offset = matchEnd;
  }
  if (segments.length === 0) {
    return Object.freeze([Object.freeze({ text, match: false })]);
  }
  if (offset < text.length) {
    segments.push(Object.freeze({ text: text.slice(offset), match: false }));
  }
  return Object.freeze(segments);
}

export function transcriptEventMetadataMatchesQuery(
  event: RuntimeTimelineEvent,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return false;
  return transcriptEventMetadataSearchText(event).includes(needle);
}

function transcriptGroupHaystack(group: TimelineEventGroup): string {
  const parts = [
    group.userMessage?.text ?? "",
    ...group.events.map(transcriptEventSearchText),
  ];
  return parts
    .filter((part) => part.length > 0)
    .join("\n")
    .toLowerCase();
}

function transcriptEventSearchText(event: RuntimeTimelineEvent): string {
  switch (event.kind) {
    case "session-started":
    case "turn-started":
      return event.kind;
    case "item-started":
    case "item-completed":
      return `${event.kind} ${event.itemType}`;
    case "agent-message":
    case "reasoning":
      return `${event.kind}\n${event.text}`;
    case "progress":
      return `${event.kind} ${event.activity}`;
    case "turn-completed":
    case "turn-interrupted":
      return `${event.kind} ${event.status}`;
    case "failed":
      return event.kind;
    case "turn-paused":
      return `${event.kind} ${event.reason}`;
  }
}

function transcriptEventMetadataSearchText(event: RuntimeTimelineEvent): string {
  switch (event.kind) {
    case "turn-paused":
      return `${event.kind} ${event.reason}`;
    case "session-started":
    case "turn-started":
    case "agent-message":
    case "reasoning":
    case "failed":
      return event.kind;
    case "item-started":
    case "item-completed":
      return `${event.kind} ${event.itemType}`;
    case "progress":
      return `${event.kind} ${event.activity}`;
    case "turn-completed":
    case "turn-interrupted":
      return `${event.kind} ${event.status}`;
  }
}

export function isTranscriptSearchShortcut(
  event: WorkbenchNewAgentSessionShortcutEvent,
): boolean {
  return (
    event.key.toLowerCase() === "f" &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing
  );
}
