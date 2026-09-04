import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  runCommandLine,
  sanitizeLiveUserJourneyCliFailure,
} from "./live-user-journey/cli.ts";

export {
  expectedJourneyEventKinds,
  LiveUserJourneyRunFailure,
} from "./live-user-journey/contracts.ts";
export type {
  LiveUserJourneyApplicationBoundary,
  LiveUserJourneyChildProcessBoundary,
  LiveUserJourneyFailureKind,
  LiveUserJourneyFailureOutcome,
  LiveUserJourneySystemBoundary,
  LiveUserJourneyTurnCapture,
  PerReplyAttributionLiveEvidence,
  PerReplyAttributionRuntimeProof,
  SanitizedUserJourneyObservation,
  TestDoubleUserJourneyRunOptions,
  UserJourneyDurableEvidenceRow,
  UserJourneyEvidenceArtifact,
  UserJourneyEvidenceSeal,
  UserJourneyName,
  UserJourneyObservation,
  UserJourneyPreflightRunOptions,
  UserJourneyRunOptions,
  UserJourneyRuntime,
} from "./live-user-journey/contracts.ts";
export { readUserJourneyEvidenceArtifact } from "./live-user-journey/evidence.ts";
export {
  runLiveUserJourney,
  runLiveUserJourneyPreflight,
} from "./live-user-journey/live-two-turn.ts";
export { runLivePerReplyAttributionProof } from "./live-user-journey/per-reply-attribution.ts";
export { runTestDoubleUserJourneys } from "./live-user-journey/test-double.ts";
export { sanitizeLiveUserJourneyCliFailure };

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runCommandLine();
  } catch (error) {
    process.exitCode = 1;
    console.log(
      `LIVE_USER_JOURNEY_FAILED ${JSON.stringify(
        sanitizeLiveUserJourneyCliFailure(error),
      )}`,
    );
  }
}

