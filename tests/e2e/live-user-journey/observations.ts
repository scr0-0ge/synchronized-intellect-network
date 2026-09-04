import assert from "node:assert/strict";

import type {
  WorkbenchCommandView,
  WorkbenchProjectResult,
  WorkbenchProjectView,
  WorkbenchTimelineEvent,
} from "../../../src/workbench-shell/contract.ts";
import {
  expectedJourneyEventKinds,
  type CapturedJourneyTurn,
  type DurableCommandObservation,
  type JourneyScenario,
  type UserJourneyObservation,
  type UserJourneyRuntime,
} from "./contracts.ts";
import {
  normalizeRuntime,
  safeReplySummary,
  scenariosFor,
} from "./shared.ts";

export function captureViewTurn(
  view: WorkbenchProjectView,
  scenario: JourneyScenario,
  accepted: boolean,
  modelLabel: string,
  effortLabel: string,
): CapturedJourneyTurn {
  const command = commandForRuntime(view, scenario.runtime);
  assert.ok(command?.session);
  const turns = splitTimeline(command.session.timeline);
  const turnIndex = scenario.commandKind === "start" ? 0 : 1;
  const turn = turns[turnIndex];
  assert.ok(turn);
  assert.equal(turn.prompt, scenario.prompt);
  const requested = command.session.profile.requested;
  const runtimeObserved =
    requested.kind === "recorded"
      ? normalizeRuntime(requested.runtimeFamilyLabel)
      : "missing";
  const replyText = turn.events
    .filter(
      (event): event is Extract<WorkbenchTimelineEvent, { kind: "agent-message" }> =>
        event.kind === "agent-message",
    )
    .map((event) => event.text)
    .join("\n")
    .trim();
  const terminal = turn.events.at(-1);
  const terminalState =
    terminal?.kind === "turn-completed"
      ? terminal.status
      : terminal?.kind === "failed"
        ? "failed"
        : command.status;
  return Object.freeze({
    scenario,
    runtimeObserved,
    accepted,
    eventKinds: Object.freeze(turn.events.map((event) => event.kind)),
    terminalState,
    replyText,
    agentSessionCount: view.commands.length,
    sessionRowLabel: command.key,
    modelLabel,
    effortLabel,
  });
}

export function completeObservation(
  turn: CapturedJourneyTurn,
  durable: DurableCommandObservation | undefined,
  sameTargetSession: boolean,
  sameAgentSessionRow: boolean,
  source: UserJourneyObservation["source"],
): UserJourneyObservation {
  const expected = turn.scenario.expectedReply;
  const replyMatchesExpected = turn.replyText === expected;
  return Object.freeze({
    schema: "live-user-journey-observation-v1" as const,
    name: turn.scenario.name,
    source,
    runtime: turn.scenario.runtime,
    runtimeObserved: turn.runtimeObserved,
    language: turn.scenario.language,
    prompt: turn.scenario.prompt,
    commandKind: turn.scenario.commandKind,
    durableCommandKind: durable?.commandKind ?? "missing",
    accepted: turn.accepted,
    eventCount: turn.eventKinds.length,
    eventKinds: turn.eventKinds,
    terminalState: turn.terminalState,
    replySummary: replyMatchesExpected
      ? expected
      : safeReplySummary(turn.replyText),
    replyMatchesExpected,
    agentSessionCount: turn.agentSessionCount,
    sameTargetSession,
    sameAgentSessionRow,
    modelLabel: turn.modelLabel,
    effortLabel: turn.effortLabel,
  });
}

export function assertLiveObservations(
  observations: readonly UserJourneyObservation[],
  runtime: UserJourneyRuntime,
): void {
  assertCompletedJourneyObservations(
    observations,
    runtime,
    "production-renderer-live",
    1,
  );
}

export function assertCompletedJourneyObservations(
  observations: readonly UserJourneyObservation[],
  runtime: UserJourneyRuntime,
  source: UserJourneyObservation["source"],
  agentSessionCount: number,
): void {
  assert.equal(observations.length, 2);
  const scenarios = scenariosFor(runtime);
  for (const [index, observation] of observations.entries()) {
    const scenario = scenarios[index];
    assert.ok(scenario);
    assert.equal(observation.schema, "live-user-journey-observation-v1");
    assert.equal(observation.name, scenario.name);
    assert.equal(observation.source, source);
    assert.equal(observation.runtime, runtime);
    assert.equal(observation.runtimeObserved, runtime);
    assert.equal(observation.language, scenario.language);
    assert.equal(observation.commandKind, scenario.commandKind);
    assert.equal(observation.commandKind, observation.durableCommandKind);
    assert.equal(observation.accepted, true);
    assert.deepEqual(observation.eventKinds, expectedJourneyEventKinds);
    assert.equal(observation.eventCount, expectedJourneyEventKinds.length);
    assert.equal(observation.terminalState, "completed");
    assert.equal(observation.replySummary, scenario.expectedReply);
    assert.equal(observation.replyMatchesExpected, true);
    assert.equal(observation.agentSessionCount, agentSessionCount);
    assert.equal(observation.sameTargetSession, true);
    assert.equal(observation.sameAgentSessionRow, true);
  }
}

export function observeProjectViews(
  subscribe: (
    listener: (result: WorkbenchProjectResult) => void,
  ) => () => void,
): Readonly<{
  dispose(): void;
  waitFor(predicate: (view: WorkbenchProjectView) => boolean): Promise<WorkbenchProjectView>;
}> {
  let latest: WorkbenchProjectView | undefined;
  const waiters = new Set<{
    readonly predicate: (view: WorkbenchProjectView) => boolean;
    readonly resolve: (view: WorkbenchProjectView) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  const dispose = subscribe((result) => {
    if (!result.ok) return;
    latest = result.view;
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result.view)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(result.view);
    }
  });
  return Object.freeze({
    dispose() {
      dispose();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("journey-observation-disposed"));
      }
      waiters.clear();
    },
    waitFor(predicate) {
      if (latest !== undefined && predicate(latest)) return Promise.resolve(latest);
      return new Promise<WorkbenchProjectView>((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          reject: rejectWait,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            rejectWait(new Error("journey-observation-timeout"));
          }, 10_000),
        };
        waiters.add(waiter);
      });
    },
  });
}

export function hasSettledTurn(
  view: WorkbenchProjectView,
  runtime: UserJourneyRuntime,
  expectedTurns: number,
): boolean {
  const command = commandForRuntime(view, runtime);
  if (command?.session === undefined) return false;
  const settled = command.status !== "accepted" && command.status !== "in-flight";
  return settled && splitTimeline(command.session.timeline).length >= expectedTurns;
}

export function commandForRuntime(
  view: WorkbenchProjectView,
  runtime: UserJourneyRuntime,
): WorkbenchCommandView | undefined {
  return view.commands.find((command) => {
    const requested = command.session?.profile.requested;
    return (
      requested?.kind === "recorded" &&
      requested.runtimeFamilyLabel.toLocaleLowerCase("en-US") === runtime
    );
  });
}

export function splitTimeline(
  timeline: readonly WorkbenchTimelineEvent[],
): readonly Readonly<{
  prompt: string;
  events: readonly Exclude<WorkbenchTimelineEvent, { kind: "user-message" }>[];
}>[] {
  const turns: Array<{
    prompt: string;
    events: Exclude<WorkbenchTimelineEvent, { kind: "user-message" }>[];
  }> = [];
  for (const event of timeline) {
    if (event.kind === "user-message") {
      turns.push({ prompt: event.text, events: [] });
      continue;
    }
    const turn = turns.at(-1);
    if (turn === undefined) throw new Error("journey-timeline-invalid");
    turn.events.push(event);
  }
  return Object.freeze(
    turns.map((turn) =>
      Object.freeze({
        prompt: turn.prompt,
        events: Object.freeze([...turn.events]),
      }),
    ),
  );
}
