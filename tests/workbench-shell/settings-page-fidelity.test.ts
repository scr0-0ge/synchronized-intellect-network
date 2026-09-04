import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchRuntimeEndpointDiscoveryCategory } from "../../src/workbench-shell/contract.ts";
import {
  appearancePersistencePresentation,
  groupSettingsProviderRows,
  settingsProviderAvailabilityPresentation,
  settingsRailPresentation,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  appearancePersistenceLabels,
  copyLocaleDictionaries as settingsCopyLocaleDictionaries,
  settingsOtherProvidersCopy,
  settingsProviderStatusMeaningsData as settingsProviderStatusMeanings,
  settingsTopLevelSectionLabels,
} from "../../src/workbench-shell/renderer/copy/settings-copy.ts";
import {
  newSessionRailAccessibleLabel,
  newSessionRailLabel,
} from "../../src/workbench-shell/renderer/copy/rail-copy.ts";

const categories: readonly WorkbenchRuntimeEndpointDiscoveryCategory[] = [
  "catalog-ready",
  "authentication-required",
  "inspection-failed",
  "runtime-not-located",
  "not-inspected",
];

test("Settings English copy exposes Providers, Claude permissions, and Appearance without invented provider capability", () => {
  assert.deepEqual(settingsTopLevelSectionLabels, [
    "Providers",
    "Claude permissions",
    "Appearance",
  ]);
  assert.deepEqual(
    settingsCopyLocaleDictionaries.en.settingsTopLevelSectionLabels,
    ["Providers", "Claude permissions", "Appearance"],
  );
  assert.equal(
    Object.isFrozen(
      settingsCopyLocaleDictionaries.en.settingsTopLevelSectionLabels,
    ),
    true,
  );
  assert.equal(
    settingsOtherProvidersCopy,
    "No other providers are configured in this build.",
  );

  const serialized = JSON.stringify({
    sections: settingsTopLevelSectionLabels,
    otherProviders: settingsOtherProvidersCopy,
    meanings: settingsProviderStatusMeanings,
  });
  assert.doesNotMatch(
    serialized,
    /API key|--bare|OpenCode|Add provider|Connect provider/iu,
  );
});

test("all exact endpoint categories keep not-inspected distinct from unavailable", () => {
  const expected = [
    [
      "catalog-ready",
      "catalog-available",
      "Catalog available",
      "ok",
      "Connected",
    ],
    [
      "authentication-required",
      "catalog-unavailable",
      "Catalog unavailable",
      "warn",
      "Sign-in required",
    ],
    [
      "inspection-failed",
      "catalog-unavailable",
      "Catalog unavailable",
      "warn",
      "Inspection failed",
    ],
    [
      "runtime-not-located",
      "catalog-unavailable",
      "Catalog unavailable",
      "off",
      "Not found",
    ],
    [
      "not-inspected",
      "not-inspected",
      "Not checked",
      "off",
      "Not checked",
    ],
  ] as const;

  assert.deepEqual(
    categories.map((category) => {
      const availability = settingsProviderAvailabilityPresentation(category);
      const meaning = settingsProviderStatusMeanings.find(
        (candidate) => candidate.category === category,
      );
      assert.ok(meaning);
      assert.equal(Object.isFrozen(availability), true);
      assert.equal(Object.isFrozen(meaning), true);
      return [
        category,
        availability.group,
        availability.label,
        availability.tone,
        meaning.label,
      ];
    }),
    expected,
  );
});

test("provider grouping is exact, ordered, frozen, and does not clone or expose another shape", () => {
  const rows = categories.map((category, index) =>
    Object.freeze({ category, endpointId: `endpoint-${index + 1}` }),
  );
  const groups = groupSettingsProviderRows(rows);

  assert.deepEqual(
    groups.catalogAvailable.map((row) => row.endpointId),
    ["endpoint-1"],
  );
  assert.deepEqual(
    groups.catalogUnavailable.map((row) => row.endpointId),
    ["endpoint-2", "endpoint-3", "endpoint-4"],
  );
  assert.deepEqual(
    groups.notInspected.map((row) => row.endpointId),
    ["endpoint-5"],
  );
  assert.equal(groups.catalogAvailable[0], rows[0]);
  assert.equal(Object.isFrozen(groups), true);
  assert.equal(Object.isFrozen(groups.catalogAvailable), true);
  assert.equal(Object.isFrozen(groups.catalogUnavailable), true);
  assert.equal(Object.isFrozen(groups.notInspected), true);
  assert.deepEqual(Object.keys(groups), [
    "catalogAvailable",
    "catalogUnavailable",
    "notInspected",
  ]);
});

test("rail presentation defines the single shortened Settings-foot entry and attention state", () => {
  assert.equal(newSessionRailLabel, "New Session");
  assert.equal(
    newSessionRailAccessibleLabel,
    "New Agent Session (Ctrl+N)",
  );
  assert.deepEqual(settingsRailPresentation("project", false), {
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: false,
    settingsAttention: false,
  });
  assert.deepEqual(settingsRailPresentation("settings", false), {
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: true,
    settingsAttention: false,
  });
  assert.deepEqual(settingsRailPresentation("project", true), {
    newSessionLabel: newSessionRailLabel,
    newSessionAccessibleLabel: newSessionRailAccessibleLabel,
    settingsCurrent: false,
    settingsAttention: true,
  });
});

test("appearance persistence labels distinguish hydration, saving, durable userData, and window-only failure", () => {
  assert.deepEqual(appearancePersistenceLabels, {
    hydrating: "Loading · This user on this device",
    saving: "Saving · This user on this device",
    saved: "Saved · This user on this device",
    error: "Not saved · Current window only",
  });
  assert.deepEqual(appearancePersistencePresentation("hydrating"), {
    label: appearancePersistenceLabels.hydrating,
    durable: false,
    error: false,
  });
  assert.deepEqual(appearancePersistencePresentation("saving"), {
    label: appearancePersistenceLabels.saving,
    durable: false,
    error: false,
  });
  assert.deepEqual(appearancePersistencePresentation("saved"), {
    label: appearancePersistenceLabels.saved,
    durable: true,
    error: false,
  });
  assert.deepEqual(appearancePersistencePresentation("error"), {
    label: appearancePersistenceLabels.error,
    durable: false,
    error: true,
  });

  const labels = ["hydrating", "saving", "saved", "error"].map((phase) =>
    appearancePersistencePresentation(
      phase as "hydrating" | "saving" | "saved" | "error",
    ).label,
  );
  assert.equal(/across Windows users|cloud|account/iu.test(labels.join(" ")), false);
});
