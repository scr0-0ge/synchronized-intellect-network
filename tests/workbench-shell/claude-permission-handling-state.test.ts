import assert from "node:assert/strict";
import test from "node:test";

import {
  publicClaudePermissionHandlingLoaded,
  publicClaudePermissionHandlingSaved,
  publicClaudePermissionHandlingUnavailable,
} from "../../src/workbench-shell/contract.ts";
import {
  beginWorkbenchClaudePermissionHandlingChange,
  completeWorkbenchClaudePermissionHandlingHydration,
  completeWorkbenchClaudePermissionHandlingSave,
  initialWorkbenchClaudePermissionHandlingPersistenceState,
} from "../../src/workbench-shell/renderer/claude-permission-handling-state.ts";

test("Claude permission handling starts without asking and ignores stale hydration after user intent", () => {
  assert.deepEqual(initialWorkbenchClaudePermissionHandlingPersistenceState, {
    permissionHandling: "without-asking",
    confirmedPermissionHandling: "without-asking",
    intentRevision: 0,
    saveRevision: 0,
    phase: "hydrating",
  });
  const attempt = beginWorkbenchClaudePermissionHandlingChange(
    initialWorkbenchClaudePermissionHandlingPersistenceState,
    "ask-when-needed",
  );
  assert.deepEqual(attempt.request, {
    revision: 1,
    permissionHandling: "ask-when-needed",
  });
  assert.equal(
    completeWorkbenchClaudePermissionHandlingHydration(
      attempt.state,
      0,
      publicClaudePermissionHandlingLoaded("without-asking"),
    ),
    attempt.state,
  );
});

test("Claude permission persistence serializes intent and rolls a failed save back to the confirmed choice", () => {
  const hydrated = completeWorkbenchClaudePermissionHandlingHydration(
    initialWorkbenchClaudePermissionHandlingPersistenceState,
    0,
    publicClaudePermissionHandlingLoaded("ask-when-needed"),
  );
  const first = beginWorkbenchClaudePermissionHandlingChange(
    hydrated,
    "without-asking",
  );
  const blockedWhileSaving = beginWorkbenchClaudePermissionHandlingChange(
    first.state,
    "ask-when-needed",
  );
  assert.deepEqual(blockedWhileSaving, {
    state: first.state,
    request: null,
  });
  assert.equal(
    completeWorkbenchClaudePermissionHandlingSave(
      first.state,
      first.request!.revision + 1,
      publicClaudePermissionHandlingSaved(),
    ),
    first.state,
  );
  assert.deepEqual(
    completeWorkbenchClaudePermissionHandlingSave(
      first.state,
      first.request!.revision,
      publicClaudePermissionHandlingUnavailable(),
    ),
    {
      permissionHandling: "ask-when-needed",
      confirmedPermissionHandling: "ask-when-needed",
      intentRevision: 1,
      saveRevision: 1,
      phase: "save-error",
    },
  );
});

test("a load failure is distinct from a save failure and the displayed default can retry storage", () => {
  const unavailable = completeWorkbenchClaudePermissionHandlingHydration(
    initialWorkbenchClaudePermissionHandlingPersistenceState,
    0,
    publicClaudePermissionHandlingUnavailable(),
  );
  assert.deepEqual(unavailable, {
    permissionHandling: "without-asking",
    confirmedPermissionHandling: "without-asking",
    intentRevision: 0,
    saveRevision: 0,
    phase: "load-error",
  });
  const retry = beginWorkbenchClaudePermissionHandlingChange(
    unavailable,
    "without-asking",
  );
  assert.deepEqual(retry.request, {
    revision: 1,
    permissionHandling: "without-asking",
  });
  assert.deepEqual(
    completeWorkbenchClaudePermissionHandlingSave(
      retry.state,
      retry.request!.revision,
      publicClaudePermissionHandlingSaved(),
    ),
    {
      permissionHandling: "without-asking",
      confirmedPermissionHandling: "without-asking",
      intentRevision: 1,
      saveRevision: 1,
      phase: "saved",
    },
  );
});
