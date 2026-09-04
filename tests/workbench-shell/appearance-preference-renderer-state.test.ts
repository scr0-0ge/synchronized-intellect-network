import assert from "node:assert/strict";
import test from "node:test";

import {
  beginWorkbenchAppearancePreferenceChange,
  completeWorkbenchAppearancePreferenceHydration,
  completeWorkbenchAppearancePreferenceSave,
  initialWorkbenchAppearancePersistenceState,
} from "../../src/workbench-shell/renderer/appearance-preference-state.ts";

const loadedLight = Object.freeze({
  ok: true as const,
  status: "loaded" as const,
  appearance: Object.freeze({
    tone: "light" as const,
    crt: "full" as const,
    phosphor: "amber" as const,
    phosphorTier: "a" as const,
    language: "zh-CN" as const,
  }),
});
const saved = Object.freeze({
  ok: true as const,
  status: "saved" as const,
  message: "Appearance preference was durably saved." as const,
});
const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "appearance-preference-unavailable" as const,
    message:
      "Appearance preferences could not be loaded or saved. Keep the current appearance and try again." as const,
  }),
});

test("renderer appearance persistence begins on the fixed default and hydrates one exact native preference", () => {
  assert.deepEqual(initialWorkbenchAppearancePersistenceState, {
    appearance: {
      tone: "dark",
      crt: "screen",
      phosphor: "neutral",
      phosphorTier: "b",
      language: "en",
    },
    intentRevision: 0,
    saveRevision: 0,
    phase: "hydrating",
  });
  assert.equal(Object.isFrozen(initialWorkbenchAppearancePersistenceState), true);
  assert.equal(
    Object.isFrozen(initialWorkbenchAppearancePersistenceState.appearance),
    true,
  );

  const hydrated = completeWorkbenchAppearancePreferenceHydration(
    initialWorkbenchAppearancePersistenceState,
    0,
    loadedLight,
  );
  assert.deepEqual(hydrated, {
    appearance: loadedLight.appearance,
    intentRevision: 0,
    saveRevision: 0,
    phase: "saved",
  });
  assert.notEqual(hydrated.appearance, loadedLight.appearance);
  assert.equal(Object.isFrozen(hydrated.appearance), true);

  const failed = completeWorkbenchAppearancePreferenceHydration(
    initialWorkbenchAppearancePersistenceState,
    0,
    unavailable,
  );
  assert.deepEqual(failed, {
    ...initialWorkbenchAppearancePersistenceState,
    phase: "error",
  });
});

test("late asynchronous hydration cannot overwrite a newer user appearance intent", () => {
  const change = beginWorkbenchAppearancePreferenceChange(
    initialWorkbenchAppearancePersistenceState,
    { type: "set-phosphor", phosphor: "green" },
  );
  assert.deepEqual(change.request, {
    revision: 1,
    preference: {
      tone: "dark",
      crt: "screen",
      phosphor: "green",
      phosphorTier: "b",
      language: "en",
    },
  });
  assert.deepEqual(change.state, {
    appearance: {
      tone: "dark",
      crt: "screen",
      phosphor: "green",
      phosphorTier: "b",
      language: "en",
    },
    intentRevision: 1,
    saveRevision: 1,
    phase: "saving",
  });

  assert.equal(
    completeWorkbenchAppearancePreferenceHydration(
      change.state,
      0,
      loadedLight,
    ),
    change.state,
  );
});

test("a same-value choice during hydration is a newer durable intent that late hydration cannot overwrite", () => {
  const choice = beginWorkbenchAppearancePreferenceChange(
    initialWorkbenchAppearancePersistenceState,
    { type: "set-tone", tone: "dark" },
  );
  assert.deepEqual(choice.request, {
    revision: 1,
    preference: {
      tone: "dark",
      crt: "screen",
      phosphor: "neutral",
      phosphorTier: "b",
      language: "en",
    },
  });
  assert.deepEqual(choice.state, {
    appearance: {
      tone: "dark",
      crt: "screen",
      phosphor: "neutral",
      phosphorTier: "b",
      language: "en",
    },
    intentRevision: 1,
    saveRevision: 1,
    phase: "saving",
  });
  assert.equal(
    completeWorkbenchAppearancePreferenceHydration(
      choice.state,
      0,
      loadedLight,
    ),
    choice.state,
  );
});

test("renderer save receipts settle only the latest revision and keep failed local intent visible", () => {
  const first = beginWorkbenchAppearancePreferenceChange(
    initialWorkbenchAppearancePersistenceState,
    { type: "set-tone", tone: "light" },
  );
  const second = beginWorkbenchAppearancePreferenceChange(first.state, {
    type: "set-crt",
    crt: "off",
  });
  assert.equal(first.request?.revision, 1);
  assert.equal(second.request?.revision, 2);
  assert.equal(
    completeWorkbenchAppearancePreferenceSave(
      second.state,
      first.request!.revision,
      saved,
    ),
    second.state,
  );

  const failed = completeWorkbenchAppearancePreferenceSave(
    second.state,
    second.request!.revision,
    unavailable,
  );
  assert.deepEqual(failed, {
    appearance: {
      tone: "light",
      crt: "off",
      phosphor: "neutral",
      phosphorTier: "b",
      language: "en",
    },
    intentRevision: 2,
    saveRevision: 2,
    phase: "error",
  });

  const retry = beginWorkbenchAppearancePreferenceChange(failed, {
    type: "set-phosphor",
    phosphor: "amber",
  });
  const settled = completeWorkbenchAppearancePreferenceSave(
    retry.state,
    retry.request!.revision,
    saved,
  );
  assert.deepEqual(settled, {
    appearance: {
      tone: "light",
      crt: "off",
      phosphor: "amber",
      phosphorTier: "b",
      language: "en",
    },
    intentRevision: 3,
    saveRevision: 3,
    phase: "saved",
  });
});

test("idempotent appearance choices do not write or advance intent", () => {
  const settled = completeWorkbenchAppearancePreferenceHydration(
    initialWorkbenchAppearancePersistenceState,
    0,
    {
      ok: true,
      status: "loaded",
      appearance: initialWorkbenchAppearancePersistenceState.appearance,
    },
  );
  for (const action of [
    { type: "set-tone", tone: "dark" },
    { type: "set-crt", crt: "screen" },
    { type: "set-phosphor", phosphor: "neutral" },
    { type: "set-phosphor-tier", phosphorTier: "b" },
    { type: "set-language", language: "en" },
  ] as const) {
    const unchanged = beginWorkbenchAppearancePreferenceChange(
      settled,
      action,
    );
    assert.equal(unchanged.state, settled);
    assert.equal(unchanged.request, null);
  }
});

test("the light Phosphor tier defaults to B and a tier choice becomes immediate durable intent", () => {
  assert.equal(
    initialWorkbenchAppearancePersistenceState.appearance.phosphorTier,
    "b",
  );

  const change = beginWorkbenchAppearancePreferenceChange(
    initialWorkbenchAppearancePersistenceState,
    { type: "set-phosphor-tier", phosphorTier: "c" },
  );
  assert.deepEqual(change.request, {
    revision: 1,
    preference: {
      tone: "dark",
      crt: "screen",
      phosphor: "neutral",
      phosphorTier: "c",
      language: "en",
    },
  });
  assert.deepEqual(change.state.appearance, change.request?.preference);
});

test("a language choice becomes immediate durable intent without changing the other appearance axes", () => {
  const change = beginWorkbenchAppearancePreferenceChange(
    initialWorkbenchAppearancePersistenceState,
    { type: "set-language", language: "zh-CN" },
  );
  assert.deepEqual(change.request, {
    revision: 1,
    preference: {
      tone: "dark",
      crt: "screen",
      phosphor: "neutral",
      phosphorTier: "b",
      language: "zh-CN",
    },
  });
  assert.deepEqual(change.state.appearance, change.request?.preference);
});
