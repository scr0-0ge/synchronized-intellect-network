import assert from "node:assert/strict";
import test from "node:test";

import {
  publicEndpointKeyInvalidValue,
  publicEndpointKeyUnavailable,
  publicEndpointProbed,
  publicEndpointKeySaved,
  publicEndpointKeyStatusLoaded,
} from "../../src/workbench-shell/contract.ts";
import {
  reconstructWorkbenchEndpointKeySaveRequest,
  sanitizeWorkbenchEndpointKeyRemoveResult,
  sanitizeWorkbenchEndpointKeyRevealResult,
  sanitizeWorkbenchEndpointKeySaveResult,
  sanitizeWorkbenchEndpointKeyStatusResult,
  sanitizeWorkbenchEndpointProbeResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

/**
 * Rule 1 discipline for the GLM endpoint key boundary: exact-shape results,
 * fail-closed sanitization, and adversarial values (extras, wrong enums,
 * accessor-like objects, proxies, null prototypes) that all collapse to the
 * one fixed public failure.
 */

const snapshot = Object.freeze({
  configured: true,
  maskedHint: "••••6789",
  isPersistent: true,
  environmentFallback: false,
});

const unavailable = publicEndpointKeyUnavailable();

const adversarialValues = (): readonly unknown[] => {
  const getter = Object.defineProperty({}, "ok", {
    enumerable: true,
    get() {
      throw new Error("PRIVATE_GETTER");
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys(): never {
        throw new Error("PRIVATE_OWN_KEYS");
      },
      get(): never {
        throw new Error("PRIVATE_GET_TRAP");
      },
      has() {
        return true;
      },
    },
  );
  return [
    null,
    undefined,
    42,
    "string",
    [],
    getter,
    throwingProxy,
    Object.assign(Object.create(null), { ok: true, status: "loaded" }),
  ];
};

test("status result sanitizes the exact loaded shape and fails closed otherwise", () => {
  assert.deepEqual(
    sanitizeWorkbenchEndpointKeyStatusResult(
      publicEndpointKeyStatusLoaded(snapshot),
    ),
    publicEndpointKeyStatusLoaded(snapshot),
  );

  const notConfigured = publicEndpointKeyStatusLoaded({
    configured: false,
    maskedHint: null,
    isPersistent: false,
    environmentFallback: true,
  });
  assert.deepEqual(
    sanitizeWorkbenchEndpointKeyStatusResult(notConfigured),
    notConfigured,
  );

  for (const value of adversarialValues()) {
    assert.deepEqual(
      sanitizeWorkbenchEndpointKeyStatusResult(value),
      unavailable,
    );
  }
  for (const value of [
    { ...publicEndpointKeyStatusLoaded(snapshot), extra: true },
    { ...publicEndpointKeyStatusLoaded(snapshot), snapshot: { ...snapshot, extra: 1 } },
    { ...publicEndpointKeyStatusLoaded(snapshot), snapshot: { ...snapshot, maskedHint: "ABCD1234" } },
    { ...publicEndpointKeyStatusLoaded(snapshot), snapshot: { ...snapshot, maskedHint: null } },
    {
      ...publicEndpointKeyStatusLoaded(snapshot),
      snapshot: { ...snapshot, configured: false },
    },
    publicEndpointKeyUnavailable(),
  ] as unknown[]) {
    if (value === publicEndpointKeyUnavailable()) {
      // A well-formed failure is folded to the same fixed public failure.
      assert.deepEqual(
        sanitizeWorkbenchEndpointKeyStatusResult(value),
        unavailable,
      );
      continue;
    }
    assert.deepEqual(sanitizeWorkbenchEndpointKeyStatusResult(value), unavailable);
  }
});

test("save result sanitizes exactly the saved shape and maps its two failure categories", () => {
  const saved = publicEndpointKeySaved("••••1234", false);
  assert.deepEqual(sanitizeWorkbenchEndpointKeySaveResult(saved), saved);

  assert.deepEqual(
    sanitizeWorkbenchEndpointKeySaveResult(publicEndpointKeyInvalidValue()),
    publicEndpointKeyInvalidValue(),
  );
  assert.deepEqual(
    sanitizeWorkbenchEndpointKeySaveResult(unavailable),
    unavailable,
  );

  for (const value of [
    null,
    { ...saved, extra: true },
    { ...saved, maskedHint: "test-secret-9" },
    { ...saved, maskedHint: 12 },
    { ...saved, isPersistent: "yes" },
    { ok: true, status: "saved" },
  ]) {
    assert.deepEqual(sanitizeWorkbenchEndpointKeySaveResult(value), unavailable);
  }
});

test("remove and reveal results keep their three-way unions exact", () => {
  // Removal reports the post-removal state: nothing stored.
  const removed = {
    ok: true,
    status: "removed",
    snapshot: { ...snapshot, configured: false, maskedHint: null },
  } as const;
  const notConfigured = {
    ok: true,
    status: "not-configured",
    snapshot: { ...snapshot, configured: false, maskedHint: null },
  } as const;
  const revealed = {
    ok: true,
    status: "revealed",
    value: "test-secret-4",
    snapshot,
  } as const;

  assert.deepEqual(
    sanitizeWorkbenchEndpointKeyRemoveResult(removed),
    removed,
  );
  assert.deepEqual(
    sanitizeWorkbenchEndpointKeyRemoveResult(notConfigured),
    notConfigured,
  );
  assert.deepEqual(
    sanitizeWorkbenchEndpointKeyRevealResult(revealed),
    revealed,
  );
  assert.deepEqual(
    sanitizeWorkbenchEndpointKeyRevealResult(notConfigured),
    notConfigured,
  );

  for (const value of [
    { ...removed, extra: 1 },
    { ok: true, status: "removed", snapshot },
    { ...revealed, value: "" },
    { ...revealed, snapshot: { ...snapshot, maskedHint: "nope" } },
    { ...revealed, snapshot: { ...snapshot, configured: false, maskedHint: null } },
    { ok: true, status: "revealed", value: "test-secret-4" },
    null,
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchEndpointKeyRemoveResult(value),
      unavailable,
    );
    assert.deepEqual(
      sanitizeWorkbenchEndpointKeyRevealResult(value),
      unavailable,
    );
  }
});

test("probe result accepts only the exact outcome shapes", () => {
  const success = publicEndpointProbed({ outcome: "success" });
  assert.deepEqual(sanitizeWorkbenchEndpointProbeResult(success), success);
  const failure = publicEndpointProbed({
    outcome: "failure",
    reason: "unauthorized",
  });
  assert.deepEqual(sanitizeWorkbenchEndpointProbeResult(failure), failure);

  for (const value of [
    { ...success, extra: true },
    { ok: true, status: "probed", probe: { outcome: "exploded" } },
    { ok: true, status: "probed", probe: { outcome: "failure", reason: "top-secret-detail" } },
    { ok: true, status: "probed", probe: { outcome: "failure" } },
    { ok: true, status: "probed" },
    null,
  ]) {
    assert.deepEqual(sanitizeWorkbenchEndpointProbeResult(value), unavailable);
  }
});

test("save request reconstruction accepts only a valid keyValue record", () => {
  assert.deepEqual(
    reconstructWorkbenchEndpointKeySaveRequest({ keyValue: "test-secret-10" }),
    { ok: true, keyValue: "test-secret-10" },
  );
  for (const value of [
    null,
    [],
    { keyValue: "" },
    { keyValue: " padded " },
    { keyValue: "a\nb" },
    { keyValue: 42 },
    { keyValue: "x".repeat(4097) },
    { keyValue: "test-secret-10", extra: true },
    { keyvalue: "test-secret-10" },
  ]) {
    assert.deepEqual(
      reconstructWorkbenchEndpointKeySaveRequest(value),
      { ok: false },
    );
  }
});
