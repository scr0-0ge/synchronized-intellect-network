import assert from "node:assert/strict";
import test from "node:test";

import {
  reconstructWorkbenchSessionMetadataMutationRequest,
} from "../../src/workbench-shell/result-sanitizer.ts";

const metadataKey =
  "session-metadata:00000000-0000-4000-8000-000000000005";

test("archive acknowledgement is one exact public shape and unknown keys still fail closed", () => {
  const acknowledged = {
    metadataKey,
    operation: { kind: "archive" },
    acknowledgedUnknownOutcome: true,
  } as const;
  assert.deepEqual(
    reconstructWorkbenchSessionMetadataMutationRequest(acknowledged),
    { ok: true, request: acknowledged },
  );

  for (const malformed of [
    { ...acknowledged, acknowledgedUnknownOutcome: false },
    { ...acknowledged, acknowledgedUnknownOutcome: "true" },
    { ...acknowledged, unregistered: true },
    {
      ...acknowledged,
      operation: { kind: "archive", unregistered: true },
    },
    {
      metadataKey,
      operation: { kind: "restore" },
      acknowledgedUnknownOutcome: true,
    },
    {
      metadataKey,
      operation: { kind: "rename", displayName: "not an archive" },
      acknowledgedUnknownOutcome: true,
    },
  ]) {
    assert.deepEqual(
      reconstructWorkbenchSessionMetadataMutationRequest(malformed),
      { ok: false },
    );
  }
});
