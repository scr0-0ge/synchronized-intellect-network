import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import type {
  ClaudeCorrelationFailureDiscriminator,
  ClaudeFrameShapeEntry,
} from "../../src/agent-runtime/claude/session.ts";
import {
  classifyInterruptTerminal,
  createIndependentObservationRecorder,
  type InterruptTerminalObservation,
} from "./live-proof-observations.ts";

const interruptPrompt =
  "Reply with UAW_INTERRUPT_READY, then count from 1 to 5000.";
const resumePrompt = "Reply with exactly UAW_RESUME_AFTER_INTERRUPT_V1";
const resumeMarker = "UAW_RESUME_AFTER_INTERRUPT_V1";
const runResumeProof =
  process.env.UAW_CLAUDE_LIVE_SCOPE !== "interrupt-observations-only";
type ObservedInterruptTerminal = InterruptTerminalObservation &
  Readonly<{
    correlationDiscriminator:
      | ClaudeCorrelationFailureDiscriminator
      | "not-applicable";
  }>;

const isolatedRoot = await mkdtemp(join(tmpdir(), "uaw-claude-live-"));
let exitCode = 0;
let phase = "catalog";
try {
  const adapter = new ClaudeAdapter();
  const catalog = await adapter.inspect(isolatedRoot);
  const model =
    catalog.models.find(
      (candidate) =>
        /haiku/iu.test(candidate.displayName ?? candidate.id) &&
        candidate.effortLevels.includes("low"),
    ) ?? catalog.models.find((candidate) => candidate.effortLevels.includes("low"));
  if (model === undefined) throw new RuntimeAdapterError("unsupported-selection");
  const profile = Object.freeze({
    model: model.id,
    effortLevel: "low",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  phase = "start";
  const started = await adapter.start({
    projectDirectory: isolatedRoot,
    profile,
  });
  phase = "interrupt-turn";
  await started.send({ text: interruptPrompt });
  const iterator = started.events()[Symbol.asyncIterator]();
  const prefix = [await requiredEvent(iterator), await requiredEvent(iterator)];
  if (
    prefix[0]?.kind !== "session-started" ||
    prefix[1]?.kind !== "turn-started"
  ) {
    throw new RuntimeAdapterError("correlation-invalid");
  }
  const correlationObservable = started as typeof started & {
    correlationFailureDiscriminator():
      | ClaudeCorrelationFailureDiscriminator
      | undefined;
    unrecognizedUserFrameShape():
      | readonly ClaudeFrameShapeEntry[]
      | undefined;
  };
  const interruptObservations = createIndependentObservationRecorder(
    ["control-receipt", "terminal-state", "iterator-ended"] as const,
    (observation) =>
      console.log(
        `CLAUDE_LIVE_INTERRUPT_OBSERVATION ${JSON.stringify(observation)}`,
      ),
  );
  let terminalState: ObservedInterruptTerminal | undefined;
  const interrupt = started.interrupt().then(() => {
    interruptObservations.record("control-receipt", { received: true });
  });
  const interruptedEvents = collectIterator(iterator, (event) => {
    const classified = classifyInterruptTerminal(event);
    if (classified !== undefined && terminalState === undefined) {
      const correlationDiscriminator =
        classified.state === "failed" &&
        classified.failureCategory === "correlation-invalid"
          ? (correlationObservable.correlationFailureDiscriminator() ??
            "unclassified-correlation")
          : "not-applicable";
      terminalState = Object.freeze({
        ...classified,
        correlationDiscriminator,
      });
      if (correlationDiscriminator === "user-frame-unrecognized") {
        const entries =
          correlationObservable.unrecognizedUserFrameShape() ??
          Object.freeze([]);
        console.log(
          `CLAUDE_LIVE_UNRECOGNIZED_USER_FRAME_SHAPE ${JSON.stringify({
            entries,
            declinedValuePaths: entries
              .filter(
                (entry) => entry.type !== "array" && entry.type !== "object",
              )
              .map((entry) => entry.path),
            valuesCaptured: false,
          })}`,
        );
      }
      interruptObservations.record("terminal-state", terminalState);
    }
  }).then((events) => {
    interruptObservations.record("iterator-ended", { ended: true });
    return events;
  });
  const interruptOutcomes = await Promise.allSettled([
    interrupt,
    interruptedEvents,
  ]);
  const interruptSnapshot = interruptObservations.snapshot();
  console.log(
    `CLAUDE_LIVE_INTERRUPT_OBSERVATIONS_FINAL ${JSON.stringify(
      interruptSnapshot,
    )}`,
  );
  if (
    interruptOutcomes.some((outcome) => outcome.status === "rejected") ||
    interruptObservations.outstanding().length > 0 ||
    terminalState?.state !== "stopped"
  ) {
    throw new RuntimeAdapterError("turn-failed");
  }
  const interruptedTail = (
    interruptOutcomes[1] as PromiseFulfilledResult<NormalizedRuntimeEvent[]>
  ).value;

  let resumedEventKinds: readonly string[] = Object.freeze([]);
  let resume = "not-run-revision-1";
  let markerObserved = false;
  let effective = started.effectiveProfile();
  if (runResumeProof) {
    phase = "resume-start";
    const resumed = await adapter.resume({
      projectDirectory: isolatedRoot,
      profile,
      opaqueSessionReference: started.opaqueSessionReference,
    });
    phase = "resume-turn";
    await resumed.send({ text: resumePrompt });
    const resumedEvents = await collect(resumed.events());
    effective = resumed.effectiveProfile();
    const expectedKinds = [
      "session-started",
      "turn-started",
      "item-started",
      "item-completed",
      "agent-message",
      "turn-completed",
    ];
    resumedEventKinds = resumedEvents.map((event) => event.kind);
    const marker = resumedEvents.find(
      (
        event,
      ): event is Extract<NormalizedRuntimeEvent, { kind: "agent-message" }> =>
        event.kind === "agent-message",
    )?.text;
    markerObserved = marker === resumeMarker;
    if (
      JSON.stringify(resumedEventKinds) !== JSON.stringify(expectedKinds) ||
      !markerObserved ||
      effective === undefined
    ) {
      throw new RuntimeAdapterError("turn-failed");
    }
    resume = "same-opaque-capability-completed";
  }

  console.log(
    `CLAUDE_LIVE_ADAPTER ${JSON.stringify({
      status: "passed",
      effort: effective?.effortLevel ?? "not-determinable",
      permission: "bypassPermissions",
      interrupt: "control-receipt-and-stopped-terminal-observed",
      interruptTerminalState: terminalState.state,
      interruptCorrelationDiscriminator:
        terminalState.correlationDiscriminator,
      interruptIteratorEnded: true,
      resume,
      interruptedEventKinds: [...prefix, ...interruptedTail].map(
        (event) => event.kind,
      ),
      resumedEventKinds,
      markerObserved,
      liveTurns: runResumeProof ? 2 : 1,
    })}`,
  );
} catch (error) {
  exitCode = 1;
  console.log(
    `CLAUDE_LIVE_ADAPTER_FAILED ${phase} ${
      error instanceof RuntimeAdapterError ? error.category : "fixed-internal"
    }`,
  );
} finally {
  try {
    await rm(isolatedRoot, { recursive: true, force: false, maxRetries: 2 });
  } catch {
    exitCode = 1;
    console.log("CLAUDE_LIVE_ADAPTER_CLEANUP_FAILED");
  }
}

process.exitCode = exitCode;

async function requiredEvent(
  iterator: AsyncIterator<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent> {
  const result = await iterator.next();
  if (result.done) throw new RuntimeAdapterError("runtime-shutdown");
  return result.value;
}

async function collect(
  events: AsyncIterable<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent[]> {
  const values: NormalizedRuntimeEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

async function collectIterator(
  iterator: AsyncIterator<NormalizedRuntimeEvent>,
  observe: (event: NormalizedRuntimeEvent) => void = () => undefined,
): Promise<NormalizedRuntimeEvent[]> {
  const values: NormalizedRuntimeEvent[] = [];
  for (;;) {
    const result = await iterator.next();
    if (result.done) return values;
    observe(result.value);
    values.push(result.value);
  }
}
