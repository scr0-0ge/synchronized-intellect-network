import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  detectProviderAttemptBuildMarker,
  preflightProviderAttempt,
} from "../../src/workbench-shell/provider-attempt-plan.ts";

const defaultInput = Object.freeze({
  liveClaudeMode: undefined,
  f102CaptureMode: undefined,
  sourceBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  distBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
});

test("default provider attempt is exactly four named real discovery rounds within 20-24 operations", () => {
  const result = preflightProviderAttempt(defaultInput);

  assert.deepEqual(result, {
    ok: true,
    plan: {
      protocol: "provider-request-budget-v1",
      buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      mode: "default",
      operationLimit: 24,
      bounds: {
        minimum: 20,
        maximum: 24,
        codexMinimum: 12,
        codexMaximum: 16,
        claudeMinimum: 8,
        claudeMaximum: 8,
      },
      rounds: [
        {
          name: "independent-headless",
          minimum: 5,
          maximum: 6,
        },
        {
          name: "item-4-lazy-picker",
          minimum: 5,
          maximum: 6,
        },
        {
          name: "positive-continuation-composition",
          minimum: 5,
          maximum: 6,
        },
        {
          name: "positive-new-session-explicit-refresh",
          minimum: 5,
          maximum: 6,
        },
      ],
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.ok && Object.isFrozen(result.plan.rounds), true);
});

test("every valid optional attempt mode whose worst case exceeds 24 is rejected with literal bounds", () => {
  const rows = [
    {
      liveClaudeMode: "isolated-fixed-marker",
      f102CaptureMode: undefined,
      bounds: { minimum: 23, maximum: 27 },
    },
    {
      liveClaudeMode: undefined,
      f102CaptureMode: "before",
      bounds: { minimum: 28, maximum: 33 },
    },
    {
      liveClaudeMode: undefined,
      f102CaptureMode: "after",
      bounds: { minimum: 28, maximum: 33 },
    },
    {
      liveClaudeMode: "isolated-fixed-marker",
      f102CaptureMode: "before",
      bounds: { minimum: 31, maximum: 36 },
    },
    {
      liveClaudeMode: "isolated-fixed-marker",
      f102CaptureMode: "after",
      bounds: { minimum: 31, maximum: 36 },
    },
  ] as const;

  for (const row of rows) {
    let inertEffects = 0;
    const result = preflightProviderAttempt({
        ...defaultInput,
        liveClaudeMode: row.liveClaudeMode,
        f102CaptureMode: row.f102CaptureMode,
      });
    if (result.ok) inertEffects += 1;
    assert.deepEqual(
      result,
      {
        ok: false,
        error: {
          category: "attempt-budget-exceeded",
          bounds: row.bounds,
          operationLimit: 24,
        },
      },
    );
    assert.equal(inertEffects, 0);
  }
});

test("dist marker detection accepts one exact marker and rejects missing or duplicate markers", () => {
  assert.equal(
    detectProviderAttemptBuildMarker(`prefix:${PROVIDER_ATTEMPT_BUILD_MARKER}:suffix`),
    PROVIDER_ATTEMPT_BUILD_MARKER,
  );
  assert.equal(detectProviderAttemptBuildMarker("stale"), undefined);
  assert.equal(
    detectProviderAttemptBuildMarker(
      `${PROVIDER_ATTEMPT_BUILD_MARKER}:${PROVIDER_ATTEMPT_BUILD_MARKER}`,
    ),
    undefined,
  );
});

test("invalid flags and missing, stale, malformed, accessor, Proxy, or extra marker input fail closed", () => {
  const accessor = { ...defaultInput } as Record<string, unknown>;
  Object.defineProperty(accessor, "distBuildMarker", {
    enumerable: true,
    get() {
      throw new Error("PRIVATE_ACCESSOR_MUST_NOT_RUN");
    },
  });
  const hidden = { ...defaultInput };
  Object.defineProperty(hidden, "privateMarker", {
    enumerable: false,
    value: "PRIVATE_MARKER",
  });
  const sparse = new Array(4);
  sparse[0] = undefined;
  sparse[1] = undefined;
  sparse[2] = PROVIDER_ATTEMPT_BUILD_MARKER;
  const cases: readonly unknown[] = [
    { ...defaultInput, liveClaudeMode: "true" },
    { ...defaultInput, f102CaptureMode: "during" },
    { ...defaultInput, distBuildMarker: undefined },
    { ...defaultInput, distBuildMarker: "stale-build" },
    { ...defaultInput, sourceBuildMarker: "stale-source" },
    { ...defaultInput, extra: true },
    accessor,
    hidden,
    new Proxy({ ...defaultInput }, {}),
    sparse,
    null,
  ];

  for (const value of cases) {
    const result = preflightProviderAttempt(value);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("invalid input unexpectedly produced a plan");
    assert.ok(
      result.error.category === "invalid-attempt-input" ||
        result.error.category === "build-marker-mismatch",
    );
    assert.deepEqual(Reflect.ownKeys(result).sort(), ["error", "ok"]);
  }
});
