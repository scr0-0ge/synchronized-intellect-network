import type {
  WorkbenchHostedProjectView,
  WorkbenchTimelineEvent,
} from "../../../src/workbench-shell/contract.ts";

import { visualFixture } from "./fixture.ts";

export type TranscriptDensityPhase = "active" | "completed";

const longAnswer = [
  "## What changed",
  "The transcript now names the work in progress while keeping the substantive answer in the same reading column. I checked the adapter boundary, the durable projection, and the renderer before updating the focused tests.",
  "The file summary contains paths and line counts only. The original patch body is discarded before it reaches the public contract, so the transcript can explain the result without repeating source content.",
  "## Verification",
  "- Ran the focused runtime, coordinator, live-view, sanitizer, and renderer checks.",
  "- Exercised long paths and summaries whose line counts are unavailable.",
  "- Confirmed the narrow layout still exposes the reply, the summary, and the composer.",
  "The remaining trade-off is deliberate: live tool activity shows only the newest operation, while completed file summaries stay attached to the turn. That keeps transient work from becoming a permanent wall of status lines.",
].join("\n\n");

export function createTranscriptDensityFixture(
  turnCount = 1,
  phase: TranscriptDensityPhase = "completed",
): WorkbenchHostedProjectView {
  const boundedTurnCount = Math.max(1, Math.min(60, Math.floor(turnCount)));
  const turns = Object.freeze(
    Array.from({ length: boundedTurnCount }, (_, index) => {
      const ordinal = index + 1;
      const finalTurn = ordinal === boundedTurnCount;
      const active = finalTurn && phase === "active";
      const answer = boundedTurnCount === 1
        ? longAnswer
        : `Turn ${ordinal} completed a focused implementation check.\n\nThe answer remains the primary content while the compact path summaries record what changed.`;
      const timeline: readonly WorkbenchTimelineEvent[] = Object.freeze([
        Object.freeze({
          kind: "user-message" as const,
          text: finalTurn
            ? "Show what you are doing, what files changed, and suggest the next useful checks."
            : `Seeded density turn ${ordinal}`,
        }),
        Object.freeze({ kind: "turn-started" as const }),
        Object.freeze({
          kind: "progress" as const,
          activity: "tool" as const,
          tool: Object.freeze({
            type: "tool_use" as const,
            name: "Read",
            parameter: Object.freeze({
              kind: "path" as const,
              value: "src/renderer/transcript.tsx",
              truncated: false,
            }),
          }),
        }),
        Object.freeze({
          kind: "progress" as const,
          activity: "tool" as const,
          tool: Object.freeze({
            type: "fileChange" as const,
            name: "Edit",
            parameter: Object.freeze({
              kind: "path" as const,
              value: "src/renderer/transcript.tsx",
              truncated: false,
            }),
            fileChanges: Object.freeze({
              files: Object.freeze([
                Object.freeze({
                  path: "src/renderer/transcript.tsx",
                  truncated: false,
                  lines: Object.freeze({ additions: 12, deletions: 4 }),
                }),
                Object.freeze({
                  path: "src/renderer/styles.css",
                  truncated: false,
                  lines: Object.freeze({ additions: 6, deletions: 1 }),
                }),
                Object.freeze({
                  path: "tests/tool-activity-ui.test.ts",
                  truncated: false,
                }),
              ]),
              totalFiles: 4,
              truncated: true,
            }),
          }),
        }),
        Object.freeze({
          kind: "item-started" as const,
          itemType: "agent-message" as const,
        }),
        Object.freeze({ kind: "agent-message" as const, text: answer }),
        Object.freeze({
          kind: "item-completed" as const,
          itemType: "agent-message" as const,
        }),
        Object.freeze({
          kind: "progress" as const,
          activity: "tool" as const,
          tool: Object.freeze({
            type: "fileChange" as const,
            name: "Edit",
            parameter: Object.freeze({
              kind: "path" as const,
              value: "README.md",
              truncated: false,
            }),
            fileChanges: Object.freeze({
              files: Object.freeze([
                Object.freeze({
                  path: "README.md",
                  truncated: false,
                  lines: Object.freeze({ additions: 2, deletions: 0 }),
                }),
              ]),
              totalFiles: 1,
              truncated: false,
            }),
          }),
        }),
        Object.freeze({
          kind: "progress" as const,
          activity: "tool" as const,
          tool: Object.freeze({
            type: "commandExecution" as const,
            name: "Bash",
            parameter: Object.freeze({
              kind: "command" as const,
              value: "npm test",
              truncated: false,
            }),
          }),
        }),
        ...(active
          ? []
          : [
              Object.freeze({
                kind: "turn-completed" as const,
                status: "completed" as const,
                ...(finalTurn
                  ? {
                      suggestions: Object.freeze([
                        "Check the remaining tests",
                        "Explain the implementation trade-off",
                        "Review the narrow-window result",
                      ]),
                    }
                  : {}),
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
    observation: Object.freeze({ cursor: timeline.length, live: true }),
    commands: Object.freeze([
      Object.freeze({
        ...seededCommand,
        key: "command-1",
        label: "Long turn with work details",
        status: phase === "active" ? "in-flight" as const : "completed" as const,
        session: Object.freeze({
          ...seededCommand.session!,
          timeline,
          turns,
        }),
      }),
      ...visualFixture.commands.slice(1),
    ]),
    initialSelectionKey: "command-1",
  });
}
