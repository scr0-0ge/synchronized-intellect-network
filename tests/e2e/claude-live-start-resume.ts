import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";

const startMarker = "UAW_LIVE_START_V1";
const resumeMarker = "UAW_LIVE_RESUME_V1";
const isolatedRoot = await mkdtemp(join(tmpdir(), "uaw-claude-resume-"));
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
  await started.send({ text: `Reply with exactly ${startMarker}` });
  const startEvents = await collect(started.events());
  assertCompleted(startEvents, startMarker);
  const startEffective = started.effectiveProfile();
  if (startEffective === undefined) {
    throw new RuntimeAdapterError("unsupported-selection");
  }

  phase = "resume";
  const resumed = await adapter.resume({
    projectDirectory: isolatedRoot,
    profile,
    opaqueSessionReference: started.opaqueSessionReference,
  });
  await resumed.send({ text: `Reply with exactly ${resumeMarker}` });
  const resumeEvents = await collect(resumed.events());
  assertCompleted(resumeEvents, resumeMarker);
  const resumeEffective = resumed.effectiveProfile();
  if (resumeEffective === undefined) {
    throw new RuntimeAdapterError("unsupported-selection");
  }

  console.log(
    `CLAUDE_LIVE_START_RESUME ${JSON.stringify({
      status: "passed",
      runtime: "claude",
      modelLabel: model.displayName ?? "catalog-label-unavailable",
      effort: resumeEffective.effortLevel,
      permission: "bypassPermissions",
      opaqueSessionReference: resumed.opaqueSessionReference,
      startEventKinds: startEvents.map((event) => event.kind),
      resumeEventKinds: resumeEvents.map((event) => event.kind),
      startMarkerObserved: true,
      resumeMarkerObserved: true,
      liveTurns: 2,
    })}`,
  );
} catch (error) {
  exitCode = 1;
  console.log(
    `CLAUDE_LIVE_START_RESUME_FAILED ${phase} ${
      error instanceof RuntimeAdapterError ? error.category : "fixed-internal"
    }`,
  );
} finally {
  try {
    await rm(isolatedRoot, { recursive: true, force: false, maxRetries: 2 });
  } catch {
    exitCode = 1;
    console.log("CLAUDE_LIVE_START_RESUME_CLEANUP_FAILED");
  }
}

process.exitCode = exitCode;

function assertCompleted(
  events: readonly NormalizedRuntimeEvent[],
  marker: string,
): void {
  const expectedKinds = [
    "session-started",
    "turn-started",
    "item-started",
    "item-completed",
    "agent-message",
    "turn-completed",
  ];
  const message = events.find(
    (event): event is Extract<NormalizedRuntimeEvent, { kind: "agent-message" }> =>
      event.kind === "agent-message",
  );
  if (
    JSON.stringify(events.map((event) => event.kind)) !==
      JSON.stringify(expectedKinds) ||
    message?.text !== marker
  ) {
    throw new RuntimeAdapterError("turn-failed");
  }
}

async function collect(
  events: AsyncIterable<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent[]> {
  const values: NormalizedRuntimeEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}
