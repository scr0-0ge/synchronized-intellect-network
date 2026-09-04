import assert from "node:assert/strict";

import {
  LiveUserJourneyRunFailure,
  type LiveUserJourneyFailureOutcome,
} from "./contracts.ts";
import { runLivePerReplyAttributionProof } from "./per-reply-attribution.ts";
import {
  runLiveUserJourney,
  runLiveUserJourneyPreflight,
} from "./live-two-turn.ts";
import { emitObservation } from "./shared.ts";
import { runTestDoubleUserJourneys } from "./test-double.ts";

const fixedPublicCliFailureMessages = new Set<string>([
  "live-user-journey-evidence-path-required",
  "journey-evidence-path-empty",
  "journey-evidence-path-inside-routine-root",
  "journey-evidence-final-write-changed",
  "journey-test-double-runtimes-invalid",
]);

export function sanitizeLiveUserJourneyCliFailure(
  error: unknown,
): Readonly<{
  status: "failed";
  category: string;
  outcome?: LiveUserJourneyFailureOutcome;
}> {
  if (error instanceof LiveUserJourneyRunFailure) {
    return Object.freeze({
      status: "failed" as const,
      category: error.code,
      outcome: error.outcome,
    });
  }
  if (error instanceof assert.AssertionError) {
    return Object.freeze({
      status: "failed" as const,
      category: "assertion-failed",
    });
  }
  const message = error instanceof Error ? error.message : "";
  const category =
    fixedPublicCliFailureMessages.has(message) ||
    /^journey-evidence-schema-invalid:[a-z0-9-]+$/u.test(message)
      ? message
      : message ===
          "UAW_LIVE_USER_JOURNEY_MODE must be test-double, live, or per-reply-attribution"
        ? "invalid-mode"
        : message ===
            "live mode requires UAW_LIVE_USER_JOURNEY_RUNTIME=codex|claude"
          ? "live-runtime-required"
          : "fixed-internal";
  return Object.freeze({ status: "failed" as const, category });
}

export async function runCommandLine(): Promise<void> {
  const mode = process.env.UAW_LIVE_USER_JOURNEY_MODE ?? "test-double";
  const evidencePath = process.env.UAW_LIVE_USER_JOURNEY_EVIDENCE_PATH;
  if (mode === "test-double") {
    const observations = await runTestDoubleUserJourneys(emitObservation, {
      evidencePath,
    });
    console.log(
      `LIVE_USER_JOURNEY_SUMMARY ${JSON.stringify({
        source: "test-double",
        status: "passed",
        observationCount: observations.length,
      })}`,
    );
    return;
  }
  if (mode === "per-reply-attribution") {
    if (evidencePath === undefined) {
      throw new Error("live-user-journey-evidence-path-required");
    }
    const result = await runLivePerReplyAttributionProof(evidencePath);
    console.log(
      `F98_LIVE_SUMMARY ${JSON.stringify({
        source: "production-renderer-live",
        status: "passed",
        runtimes: result.evidence.runtimes.map((row) => row.runtime),
        liveTurns: result.evidence.runtimes.reduce(
          (total, row) => total + row.liveTurns,
          0,
        ),
      })}`,
    );
    return;
  }
  if (mode !== "live") {
    throw new Error(
      "UAW_LIVE_USER_JOURNEY_MODE must be test-double, live, or per-reply-attribution",
    );
  }
  const runtime = process.env.UAW_LIVE_USER_JOURNEY_RUNTIME;
  if (runtime !== "codex" && runtime !== "claude") {
    throw new Error("live mode requires UAW_LIVE_USER_JOURNEY_RUNTIME=codex|claude");
  }
  if (process.env.UAW_LIVE_USER_JOURNEY_PREFLIGHT === "1") {
    const profile = await runLiveUserJourneyPreflight(runtime);
    console.log(
      `LIVE_USER_JOURNEY_PREFLIGHT ${JSON.stringify({
        source: "production-renderer-live",
        runtime,
        status: "passed",
        agentSessionsStarted: 0,
        ...profile,
      })}`,
    );
    return;
  }
  const observations = await runLiveUserJourney(runtime, emitObservation, {
    evidencePath,
  });
  console.log(
    `LIVE_USER_JOURNEY_SUMMARY ${JSON.stringify({
      source: "production-renderer-live",
      runtime,
      status: "passed",
      observationCount: observations.length,
    })}`,
  );
}
