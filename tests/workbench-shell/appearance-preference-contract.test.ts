import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
  WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
  publicAppearancePreferenceLoaded,
  publicAppearancePreferenceSaved,
  publicAppearancePreferenceUnavailable,
} from "../../src/workbench-shell/contract.ts";
import {
  reconstructWorkbenchAppearancePreference,
  sanitizeWorkbenchAppearancePreferenceLoadResult,
  sanitizeWorkbenchAppearancePreferenceSaveResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

const appearance = Object.freeze({
  tone: "light" as const,
  crt: "blocks" as const,
  phosphor: "green" as const,
  phosphorTier: "c" as const,
  language: "en" as const,
});
const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "appearance-preference-unavailable" as const,
    message:
      "Appearance preferences could not be loaded or saved. Keep the current appearance and try again." as const,
  }),
});

test("appearance preference channels and public results expose only the bounded preference contract", () => {
  assert.equal(
    WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
    "workbench:load-appearance-preference",
  );
  assert.equal(
    WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
    "workbench:save-appearance-preference",
  );

  const loaded = publicAppearancePreferenceLoaded(appearance);
  const saved = publicAppearancePreferenceSaved();
  const failed = publicAppearancePreferenceUnavailable();
  assert.deepEqual(loaded, {
    ok: true,
    status: "loaded",
    appearance,
  });
  assert.notEqual(loaded.appearance, appearance);
  assert.deepEqual(saved, {
    ok: true,
    status: "saved",
    message: "Appearance preference was durably saved.",
  });
  assert.deepEqual(failed, unavailable);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.appearance), true);
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(failed.error), true);
  assert.deepEqual(Object.keys(loaded).sort(), ["appearance", "ok", "status"]);
  assert.equal("schemaVersion" in loaded, false);
});

test("appearance preference reconstruction accepts one exact owned five-axis record and rejects adversarial shapes", () => {
  const reconstructed = reconstructWorkbenchAppearancePreference(appearance);
  assert.deepEqual(reconstructed, { ok: true, preference: appearance });
  assert.notEqual(reconstructed.ok && reconstructed.preference, appearance);
  assert.equal(
    reconstructed.ok && Object.isFrozen(reconstructed.preference),
    true,
  );

  const getter = Object.defineProperty(
    {
      crt: "blocks",
      language: "en",
      phosphor: "green",
      phosphorTier: "c",
    },
    "tone",
    { enumerable: true, get: () => "light" },
  );
  const symbolKey = { ...appearance, [Symbol("extra")]: true };
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("PRIVATE_PROXY_FAILURE");
      },
    },
  );
  const cases: readonly unknown[] = [
    null,
    [],
    { tone: "light", crt: "blocks" },
    { tone: "light", crt: "blocks", phosphor: "green" },
    {
      tone: "light",
      crt: "blocks",
      phosphor: "green",
      phosphorTier: "c",
    },
    { ...appearance, extra: true },
    { ...appearance, tone: "sepia" },
    { ...appearance, crt: "tube" },
    { ...appearance, phosphor: "blue" },
    { ...appearance, phosphorTier: "d" },
    { ...appearance, language: "fr" },
    Object.assign(Object.create(null), appearance),
    getter,
    symbolKey,
    throwingProxy,
  ];
  for (const value of cases) {
    assert.deepEqual(
      reconstructWorkbenchAppearancePreference(value),
      { ok: false },
    );
  }
});

test("appearance load sanitization clones exact data and fails closed on every extra, raw, accessor, or malformed row", () => {
  const valid = sanitizeWorkbenchAppearancePreferenceLoadResult({
    ok: true,
    status: "loaded",
    appearance,
  });
  assert.deepEqual(valid, {
    ok: true,
    status: "loaded",
    appearance,
  });
  assert.notEqual(valid.ok && valid.appearance, appearance);

  const validFailure = sanitizeWorkbenchAppearancePreferenceLoadResult(
    unavailable,
  );
  assert.deepEqual(validFailure, unavailable);
  assert.notEqual(validFailure, unavailable);

  const accessor = Object.defineProperty(
    { ok: true, status: "loaded" },
    "appearance",
    { enumerable: true, get: () => appearance },
  );
  const invalid: readonly unknown[] = [
    null,
    [],
    { ok: true, status: "loaded" },
    { ok: true, status: "loaded", appearance, extra: true },
    {
      ok: true,
      status: "loaded",
      appearance: { ...appearance, extra: true },
    },
    {
      ok: true,
      status: "loaded",
      appearance,
      schemaVersion: 1,
    },
    { ok: true, status: "saved", appearance },
    { ok: false, error: { ...unavailable.error, extra: true } },
    { ok: false, error: unavailable.error, extra: true },
    accessor,
    Object.assign(Object.create(null), {
      ok: true,
      status: "loaded",
      appearance,
    }),
  ];
  for (const value of invalid) {
    assert.deepEqual(
      sanitizeWorkbenchAppearancePreferenceLoadResult(value),
      unavailable,
    );
  }
});

test("appearance save sanitization admits only its exact receipt and never returns native document data", () => {
  const receipt = {
    ok: true,
    status: "saved",
    message: "Appearance preference was durably saved.",
  } as const;
  assert.deepEqual(
    sanitizeWorkbenchAppearancePreferenceSaveResult(receipt),
    receipt,
  );
  assert.deepEqual(
    sanitizeWorkbenchAppearancePreferenceSaveResult(unavailable),
    unavailable,
  );
  for (const value of [
    { ...receipt, extra: true },
    { ...receipt, schemaVersion: 1 },
    { ...receipt, appearance },
    { ...receipt, message: "saved" },
    { ok: true, status: "loaded", message: receipt.message },
    { ok: false, error: { ...unavailable.error, message: "private" } },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchAppearancePreferenceSaveResult(value),
      unavailable,
    );
  }
});
