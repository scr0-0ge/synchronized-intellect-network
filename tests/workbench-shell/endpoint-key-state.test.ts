import assert from "node:assert/strict";
import test from "node:test";

import {
  publicEndpointKeySaved,
  publicEndpointKeyStatusLoaded,
  publicEndpointKeyUnavailable,
  publicEndpointProbed,
} from "../../src/workbench-shell/contract.ts";
import {
  beginWorkbenchEndpointKeyProbe,
  beginWorkbenchEndpointKeyRemove,
  beginWorkbenchEndpointKeyReveal,
  beginWorkbenchEndpointKeySave,
  changeWorkbenchEndpointKeyDraft,
  completeWorkbenchEndpointKeyHydration,
  completeWorkbenchEndpointKeyProbe,
  completeWorkbenchEndpointKeyRemove,
  completeWorkbenchEndpointKeyReveal,
  completeWorkbenchEndpointKeySave,
  hideWorkbenchEndpointKeyReveal,
  initialWorkbenchEndpointKeyState,
} from "../../src/workbench-shell/renderer/endpoint-key-state.ts";

const readyState = completeWorkbenchEndpointKeyHydration(
  initialWorkbenchEndpointKeyState,
  publicEndpointKeyStatusLoaded({
    configured: false,
    maskedHint: null,
    isPersistent: true,
    environmentFallback: false,
  }),
);
const configuredState = completeWorkbenchEndpointKeyHydration(
  initialWorkbenchEndpointKeyState,
  publicEndpointKeyStatusLoaded({
    configured: true,
    maskedHint: "••••4321",
    isPersistent: true,
    environmentFallback: false,
  }),
);

test("hydration lands in ready with the snapshot or in unavailable on failure", () => {
  assert.equal(readyState.phase, "ready");
  assert.equal(readyState.snapshot?.configured, false);
  const failed = completeWorkbenchEndpointKeyHydration(
    initialWorkbenchEndpointKeyState,
    publicEndpointKeyUnavailable(),
  );
  assert.equal(failed.phase, "unavailable");
  // Hydration happens once; later results never regress the phase.
  assert.equal(
    completeWorkbenchEndpointKeyHydration(readyState, publicEndpointKeyUnavailable()),
    readyState,
  );
});

test("invalid drafts are refused locally with save-invalid feedback and no request", () => {
  // Interior control characters survive trimming, so the value is rejected.
  const drafted = changeWorkbenchEndpointKeyDraft(readyState, "bad\nkey");
  const attempt = beginWorkbenchEndpointKeySave(drafted);
  assert.equal(attempt.keyValue, null);
  assert.equal(attempt.state.feedback, "save-invalid");
  // Editing the draft clears the invalid feedback.
  assert.equal(
    changeWorkbenchEndpointKeyDraft(attempt.state, "test-secret-9").feedback,
    null,
  );
});

test("a valid save round trip updates the snapshot, clears the draft, reveal and probe", () => {
  const drafted = changeWorkbenchEndpointKeyDraft(readyState, "  test-secret-9  ");
  const attempt = beginWorkbenchEndpointKeySave(drafted);
  assert.equal(attempt.keyValue, "test-secret-9");
  assert.equal(attempt.state.busy, "save");
  const done = completeWorkbenchEndpointKeySave(
    attempt.state,
    publicEndpointKeySaved("••••et-9", false),
  );
  assert.equal(done.busy, null);
  assert.equal(done.snapshot?.configured, true);
  assert.equal(done.snapshot?.maskedHint, "••••et-9");
  assert.equal(done.snapshot?.isPersistent, false);
  assert.equal(done.draft, "");
  const failed = completeWorkbenchEndpointKeySave(
    attempt.state,
    publicEndpointKeyUnavailable(),
  );
  assert.equal(failed.busy, null);
  assert.equal(failed.feedback, "save-failed");
});

test("reveal, hide, remove, and probe transitions are guarded by busy and configured state", () => {
  // Nothing configured: reveal and remove refuse.
  assert.equal(beginWorkbenchEndpointKeyReveal(readyState), readyState);
  assert.equal(beginWorkbenchEndpointKeyRemove(readyState), readyState);

  const revealing = beginWorkbenchEndpointKeyReveal(configuredState);
  assert.equal(revealing.busy, "reveal");
  assert.equal(beginWorkbenchEndpointKeyRemove(revealing), revealing);
  const revealed = completeWorkbenchEndpointKeyReveal(revealing, {
    ok: true,
    status: "revealed",
    value: "test-secret-4321",
    snapshot: configuredState.snapshot!,
  });
  assert.equal(revealed.revealed, true);
  assert.equal(revealed.revealedValue, "test-secret-4321");
  assert.equal(hideWorkbenchEndpointKeyReveal(revealed).revealed, false);

  const removing = beginWorkbenchEndpointKeyRemove(configuredState);
  assert.equal(removing.busy, "remove");
  const removed = completeWorkbenchEndpointKeyRemove(removing, {
    ok: true,
    status: "removed",
    snapshot: {
      configured: false,
      maskedHint: null,
      isPersistent: true,
      environmentFallback: false,
    },
  });
  assert.equal(removed.busy, null);
  assert.equal(removed.snapshot?.configured, false);
  assert.equal(removed.revealed, false);

  const probing = beginWorkbenchEndpointKeyProbe(readyState);
  assert.equal(probing.busy, "probe");
  assert.deepEqual(
    completeWorkbenchEndpointKeyProbe(probing, publicEndpointProbed({
      outcome: "failure",
      reason: "unauthorized",
    })).probeOutcome,
    { outcome: "failure", reason: "unauthorized" },
  );
  const probeFailed = completeWorkbenchEndpointKeyProbe(
    probing,
    publicEndpointKeyUnavailable(),
  );
  assert.equal(probeFailed.feedback, "probe-failed");
});

test("late completions for a stale busy slot are ignored", () => {
  assert.equal(
    completeWorkbenchEndpointKeySave(readyState, publicEndpointKeySaved("••••4321", true)),
    readyState,
  );
  assert.equal(
    completeWorkbenchEndpointKeyRemove(configuredState, {
      ok: true,
      status: "removed",
      snapshot: configuredState.snapshot!,
    }),
    configuredState,
  );
});
