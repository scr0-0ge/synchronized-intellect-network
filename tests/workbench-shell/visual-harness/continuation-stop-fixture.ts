import type { WorkbenchHostedProjectView, WorkbenchTimelineEvent } from "../../../src/workbench-shell/contract.ts";
import { visualFixture } from "./fixture.ts";

const original = visualFixture.commands[0]!;
const session = original.session!;
const turns = [1, 2].map((step) => ({
  profile: session.profile,
  timeline: [
    { kind: "user-message", text: `[Workbench 自动续办 ${step}/3]\nVerify the next step.` },
    { kind: "turn-started" },
    { kind: "agent-message", text: `Step ${step} completed and verified.` },
    { kind: "turn-completed", status: "completed" },
  ] satisfies WorkbenchTimelineEvent[],
}));

export const continuationBeforeStopFixture: WorkbenchHostedProjectView = {
  ...visualFixture, initialSelectionKey: original.key,
  commands: [{
    ...original,
    session: { ...session, selectionKey: null, resumable: false, turns, timeline: turns.flatMap(turn => turn.timeline) },
  }],
};

export const continuationStopFixture: WorkbenchHostedProjectView = {
  ...continuationBeforeStopFixture,
  commands: [{ ...continuationBeforeStopFixture.commands[0]!,
    continuationStop: { step: 2, limit: 3, reason: "continuation-unavailable" },
  }],
};
