import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchCommandView } from "../../src/workbench-shell/contract.ts";
import {
  requiresRecoveryArchiveAcknowledgement,
  sessionArchiveControlPresentation,
  sessionMetadataRequest,
} from "../../src/workbench-shell/renderer/session-metadata-presentation.ts";

const recoverySession: WorkbenchCommandView = Object.freeze({
  key: "command-recovery",
  label: "Outcome unknown",
  runtime: "Codex",
  status: "recovery-required",
  session: Object.freeze({
    archived: false,
    metadataKey:
      "session-metadata:00000000-0000-4000-8000-000000000501",
    profile: Object.freeze({
      requested: Object.freeze({ kind: "not-recorded" as const }),
      effective: Object.freeze({ kind: "not-recorded" as const }),
    }),
    timeline: Object.freeze([]),
    removalKey:
      "session-removal:00000000-0000-4000-8000-000000000501",
    resumable: false,
    selectionKey: null,
  }),
});

test("recovery-required archive requires an explicit acknowledgement and sends its exact request", () => {
  const control = sessionArchiveControlPresentation(recoverySession, false);
  assert.equal(control.disabled, false);
  assert.deepEqual(control.operation, { kind: "archive" });
  assert.equal(
    requiresRecoveryArchiveAcknowledgement(recoverySession, control.operation),
    true,
  );

  assert.deepEqual(
    sessionMetadataRequest(recoverySession, { kind: "archive" }),
    {
      metadataKey: recoverySession.session?.metadataKey,
      operation: { kind: "archive" },
    },
  );

  assert.deepEqual(
    sessionMetadataRequest(recoverySession, { kind: "archive" }, true),
    {
      metadataKey: recoverySession.session?.metadataKey,
      operation: { kind: "archive" },
      acknowledgedUnknownOutcome: true,
    },
  );
});

test("ordinary archive and recovery restore retain their two-key metadata request", () => {
  const completed = Object.freeze({
    ...recoverySession,
    status: "completed" as const,
  });
  const restoredRecovery = Object.freeze({
    ...recoverySession,
    session: Object.freeze({ ...recoverySession.session!, archived: true }),
  });

  assert.deepEqual(
    sessionMetadataRequest(completed, { kind: "archive" }, true),
    {
      metadataKey: completed.session?.metadataKey,
      operation: { kind: "archive" },
    },
  );
  assert.equal(
    sessionArchiveControlPresentation(restoredRecovery, false).disabled,
    false,
  );
  assert.equal(
    requiresRecoveryArchiveAcknowledgement(restoredRecovery, { kind: "restore" }),
    false,
  );
  assert.deepEqual(
    sessionMetadataRequest(restoredRecovery, { kind: "restore" }, true),
    {
      metadataKey: restoredRecovery.session?.metadataKey,
      operation: { kind: "restore" },
    },
  );
});
