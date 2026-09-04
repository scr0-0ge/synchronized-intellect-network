import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyInterruptTerminal,
  createIndependentObservationRecorder,
} from "../e2e/live-proof-observations.ts";

test("live proof records durable acceptance and normalized completion independently", () => {
  const emitted: unknown[] = [];
  const recorder = createIndependentObservationRecorder(
    ["durable-acceptance", "normalized-completion"] as const,
    (observation) => emitted.push(observation),
  );

  assert.deepEqual(recorder.snapshot(), [
    { name: "durable-acceptance", observed: false },
    { name: "normalized-completion", observed: false },
  ]);

  recorder.record("durable-acceptance", {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });

  assert.deepEqual(recorder.snapshot(), [
    {
      name: "durable-acceptance",
      observed: true,
      ordinal: 1,
      value: {
        ok: true,
        status: "accepted",
        message: "Direct input was durably accepted.",
      },
    },
    { name: "normalized-completion", observed: false },
  ]);
  assert.deepEqual(recorder.outstanding(), ["normalized-completion"]);

  recorder.record("normalized-completion", {
    terminalStatus: "completed",
    normalizedEventKinds: ["turn-completed"],
  });

  assert.deepEqual(recorder.outstanding(), []);
  assert.deepEqual(
    emitted.map((observation) =>
      (observation as { readonly name: string }).name,
    ),
    ["durable-acceptance", "normalized-completion"],
  );
});

test("live interrupt terminal state remains unknown when only iterator end is observed", () => {
  const recorder = createIndependentObservationRecorder(
    ["control-receipt", "terminal-state", "iterator-ended"] as const,
    () => undefined,
  );

  recorder.record("control-receipt", { observed: true });
  recorder.record("iterator-ended", { ended: true });

  assert.deepEqual(recorder.snapshot(), [
    {
      name: "control-receipt",
      observed: true,
      ordinal: 1,
      value: { observed: true },
    },
    { name: "terminal-state", observed: false },
    {
      name: "iterator-ended",
      observed: true,
      ordinal: 2,
      value: { ended: true },
    },
  ]);
  assert.deepEqual(recorder.outstanding(), ["terminal-state"]);
});

test("live interrupt terminal classification distinguishes stopped from completed", () => {
  assert.deepEqual(
    classifyInterruptTerminal({
      kind: "turn-interrupted",
      status: "interrupted",
    }),
    {
      state: "stopped",
      normalizedEventKind: "turn-interrupted",
      interruptionStatus: "interrupted",
    },
  );
  assert.deepEqual(
    classifyInterruptTerminal({ kind: "failed", category: "turn-failed" }),
    {
      state: "stopped",
      normalizedEventKind: "failed",
      failureCategory: "turn-failed",
    },
  );
  assert.deepEqual(
    classifyInterruptTerminal({ kind: "turn-completed", status: "completed" }),
    {
      state: "completed",
      normalizedEventKind: "turn-completed",
      completionStatus: "completed",
    },
  );
  assert.equal(classifyInterruptTerminal({ kind: "turn-started" }), undefined);
});
