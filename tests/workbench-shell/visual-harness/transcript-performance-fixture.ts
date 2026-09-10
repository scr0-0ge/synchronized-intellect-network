import type {
  WorkbenchHostedProjectView,
  WorkbenchTimelineEvent,
} from "../../../src/workbench-shell/contract.ts";

import { visualFixture } from "./fixture.ts";

export function createTranscriptPerformanceFixture(
  turnCount: number,
): WorkbenchHostedProjectView {
  const turns = Object.freeze(
    Array.from({ length: turnCount }, (_, index) => {
    const ordinal = index + 1;
    const timeline: readonly WorkbenchTimelineEvent[] = Object.freeze([
      Object.freeze({
        kind: "user-message" as const,
        text:
          ordinal === 7 || ordinal === 493
            ? `PERF_SEARCH_NEEDLE turn ${ordinal}`
            : `Seeded user turn ${ordinal}`,
      }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({
        kind: "agent-message" as const,
        text:
          ordinal === 493
            ? `${Array.from(
                { length: 40 },
                (_, line) =>
                  `Seeded detail ${line + 1}. This line keeps the first literal match below the initial viewport.`,
              ).join("\n\n")}\n\nPERF_DEEP_NEEDLE is the first and only deep match.`
            : `Seeded agent response ${ordinal}. This bounded sentence keeps turn heights deterministic.`,
      }),
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
    ]);
    return Object.freeze({
      profile: visualFixture.commands[0]!.session!.profile,
      timeline,
    });
    }),
  );
  const timeline = Object.freeze(turns.flatMap((turn) => turn.timeline));
  return Object.freeze({
    ...visualFixture,
    observation: Object.freeze({ cursor: timeline.length, live: true }),
    commands: Object.freeze([
      Object.freeze({
        ...visualFixture.commands[0]!,
        key: "command-performance",
        label: "2,000 event transcript",
        session: Object.freeze({
          ...visualFixture.commands[0]!.session!,
          timeline,
          turns,
        }),
      }),
      ...visualFixture.commands.slice(1),
    ]),
    initialSelectionKey: "command-performance",
  });
}

export const transcriptPerformanceFixture =
  createTranscriptPerformanceFixture(500);

export const transcriptPerformanceUpdatedFixture =
  createTranscriptPerformanceFixture(501);

if (transcriptPerformanceFixture.commands[0]!.session!.timeline.length < 2_000) {
  throw new Error("The transcript performance fixture must contain >= 2,000 events.");
}

export const transcriptPerformanceEventCount =
  transcriptPerformanceFixture.commands[0]!.session!.timeline.length;
