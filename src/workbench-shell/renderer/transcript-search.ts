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
  readonly userMessage?: UserMessageTimelineEvent;
  readonly events: readonly RuntimeTimelineEvent[];
  readonly profile?: WorkbenchSessionProfileProjection;
}

export function groupTimelineEvents(
  events: readonly WorkbenchTimelineEvent[],
  profile?: WorkbenchSessionProfileProjection,
): readonly TimelineEventGroup[] {
  const groups: TimelineEventGroup[] = [];
  let userMessage: UserMessageTimelineEvent | undefined;
  let current: RuntimeTimelineEvent[] = [];
  const flush = (): void => {
    if (userMessage === undefined && current.length === 0) return;
    groups.push(
      Object.freeze({
        ...(userMessage === undefined ? {} : { userMessage }),
        events: Object.freeze(current),
        ...(profile === undefined ? {} : { profile }),
      }),
    );
    userMessage = undefined;
    current = [];
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
      userMessage = event;
      continue;
    }
    current.push(event);
  }
  flush();
  return Object.freeze(groups);
}

/**
 * Case-insensitive client-side turn filter. An empty or blank query is a
 * passthrough: the exact input array reference comes back so Solid's Index
 * keeps every rendered turn stable while the user clears the box.
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
      return `${event.kind}\n${event.text}`;
    case "turn-completed":
    case "turn-interrupted":
      return `${event.kind} ${event.status}`;
    case "failed":
      return event.kind;
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
