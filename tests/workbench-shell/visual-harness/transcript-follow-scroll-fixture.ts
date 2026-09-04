import type {
  WorkbenchHostedProjectView,
  WorkbenchTimelineEvent,
} from "../../../src/workbench-shell/contract.ts";

import { visualFixture } from "./fixture.ts";

export function createTranscriptFollowScrollFixture(
  turnCount: number,
  streamingRevision = 0,
): WorkbenchHostedProjectView {
  const boundedTurnCount = Math.max(1, Math.min(120, Math.floor(turnCount)));
  const turns = Object.freeze(
    Array.from({ length: boundedTurnCount }, (_, index) => {
      const active = index === boundedTurnCount - 1;
      const ordinal = index + 1;
      const paragraphCount = boundedTurnCount === 1 ? 1 : 1 + (index % 5);
      const response = Array.from(
        { length: paragraphCount },
        (__, paragraphIndex) =>
          `Seeded response ${ordinal}.${paragraphIndex + 1} keeps this turn's measured height deterministic.`,
      ).join("\n\n");
      const streamingSuffix =
        active && streamingRevision > 0
          ? `\n\n${Array.from(
              { length: streamingRevision * 3 },
              (__, updateIndex) =>
                `Streaming update ${streamingRevision}.${updateIndex + 1} remains locally seeded.`,
            ).join("\n\n")}`
          : "";
      const timeline: readonly WorkbenchTimelineEvent[] = Object.freeze([
        Object.freeze({
          kind: "user-message" as const,
          text: `Seeded user turn ${ordinal}`,
        }),
        Object.freeze({ kind: "turn-started" as const }),
        Object.freeze({
          kind: "item-started" as const,
          itemType: "agent-message" as const,
        }),
        Object.freeze({
          kind: "agent-message" as const,
          text: response + streamingSuffix,
        }),
        ...(active
          ? []
          : [
              Object.freeze({
                kind: "turn-completed" as const,
                status: "completed" as const,
              }),
            ]),
      ]);
      return Object.freeze({
        profile: visualFixture.commands[0]!.session!.profile,
        timeline,
      });
    }),
  );
  const timeline = Object.freeze(turns.flatMap((turn) => turn.timeline));
  const seededCommand = visualFixture.commands[0]!;
  return Object.freeze({
    ...visualFixture,
    observation: Object.freeze({
      cursor: timeline.length + streamingRevision,
      live: true,
    }),
    commands: Object.freeze([
      Object.freeze({
        ...seededCommand,
        key: "command-follow-scroll",
        label: "Seeded transcript follow and scroll",
        status: "in-flight" as const,
        session: Object.freeze({
          ...seededCommand.session!,
          timeline,
          turns,
        }),
      }),
      ...visualFixture.commands.slice(1),
    ]),
    initialSelectionKey: "command-follow-scroll",
  });
}

