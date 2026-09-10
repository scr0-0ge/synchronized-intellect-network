import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeCatalog } from "../../src/agent-runtime/index.ts";
import {
  createDirectSessionProfileSnapshot,
  type DirectSessionProfileEndpointCatalog,
} from "../../src/workbench-shell/direct-session-profile-snapshot.ts";
import {
  publicRuntimeEndpointDiscovery,
  type WorkbenchDirectSessionProfileSelection,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointId,
} from "../../src/workbench-shell/contract.ts";
import { dissimilarNeutralEndpointFixtures } from "./fixtures/neutral-public-contract-fixtures.ts";

/*
 * These fixtures model the pre-GLM two-endpoint regression subset; the
 * canonical production roster now carries a third endpoint (glm-coding-plan,
 * issue 05), so two-endpoint snapshots opt into their explicit roster.
 */
const FIXTURE_ENDPOINT_IDS: readonly WorkbenchRuntimeEndpointId[] =
  Object.freeze(["codex-desktop", "claude-code-desktop"]);

test("two dissimilar fake endpoints keep a shared model label as two exact private relations", () => {
  const snapshot = fixtureSnapshot();
  const publicProfile = snapshot.publicResult.profile;

  assert.deepEqual(
    publicProfile.endpoints.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      runtimeFamilyLabel: endpoint.runtimeFamilyLabel,
      endpointLabel: endpoint.endpointLabel,
      models: endpoint.models.map((model) => ({
        label: model.label,
        provenanceLabel: model.provenanceLabel,
        workIntensityLabel: model.workIntensityLabel,
        optionCount: model.workIntensities.length,
      })),
    })),
    [
      {
        endpointId: "codex-desktop",
        runtimeFamilyLabel: "Quartz Runtime",
        endpointLabel: "Quartz Studio",
        models: [
          {
            label: "Shared Compass",
            provenanceLabel: "Shared Compass",
            workIntensityLabel: "Deliberation",
            optionCount: 2,
          },
          {
            label: "Quartz Vector",
            provenanceLabel: "Quartz Vector",
            workIntensityLabel: "Review span",
            optionCount: 1,
          },
        ],
      },
      {
        endpointId: "claude-code-desktop",
        runtimeFamilyLabel: "Nimbus Runtime",
        endpointLabel: "Nimbus Relay",
        models: [
          {
            label: "Shared Compass",
            provenanceLabel: "Shared Compass",
            workIntensityLabel: null,
            optionCount: 3,
          },
        ],
      },
    ],
  );

  const quartz = selectionAt(publicProfile, 0, 0, 0);
  const nimbus = selectionAt(publicProfile, 1, 0, 0);
  const quartzPrivate = snapshot.resolveSelection(quartz);
  const nimbusPrivate = snapshot.resolveSelection(nimbus);
  assert.notEqual(quartz.endpointKey, nimbus.endpointKey);
  assert.notEqual(quartz.modelKey, nimbus.modelKey);
  assert.notDeepEqual(quartzPrivate?.profile, nimbusPrivate?.profile);
  assert.equal(quartzPrivate?.endpointIndex, 0);
  assert.equal(nimbusPrivate?.endpointIndex, 1);

  const serialized = JSON.stringify(snapshot.publicResult);
  for (const forbidden of privateFixtureValues()) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("replacement prefill resolves one complete private tuple to current opaque selection keys", () => {
  const snapshot = fixtureSnapshot();
  const current = selectionAt(snapshot.publicResult.profile, 0, 0, 0);
  const recorded = snapshot.resolveSelection(current);
  assert.ok(recorded);

  assert.deepEqual(snapshot.resolveReplacementPrefill(recorded.profile), {
    kind: "resolved",
    endpointKey: current.endpointKey,
    modelKey: current.modelKey,
    workIntensityKey: current.workIntensityKey,
    executionModeKey: current.executionModeKey,
    accessModeKey: current.accessModeKey,
  });
});

test("replacement prefill rejects an inherited private tuple shape", () => {
  const snapshot = fixtureSnapshot();
  const current = selectionAt(snapshot.publicResult.profile, 0, 0, 0);
  const recorded = snapshot.resolveSelection(current);
  assert.ok(recorded);
  const inherited = Object.assign(
    Object.create({ sourceCommandIdentity: "must-not-identify-profile" }),
    recorded.profile,
  ) as typeof recorded.profile;

  assert.deepEqual(snapshot.resolveReplacementPrefill(inherited), {
    kind: "manual-selection-required",
  });
});

test("replacement prefill returns an explicit manual state when the recorded tuple is unavailable", () => {
  const snapshot = fixtureSnapshot();
  const current = selectionAt(snapshot.publicResult.profile, 0, 0, 0);
  const recorded = snapshot.resolveSelection(current);
  assert.ok(recorded);

  assert.deepEqual(
    snapshot.resolveReplacementPrefill({
      ...recorded.profile,
      model: "missing-private-model",
    }),
    { kind: "manual-selection-required" },
  );
});

test("replacement prefill requires every private tuple field and declared execution implication", () => {
  const snapshot = fixtureSnapshot();
  const current = selectionAt(snapshot.publicResult.profile, 0, 0, 0);
  const recorded = snapshot.resolveSelection(current);
  assert.ok(recorded);
  const mismatches = [
    { ...recorded.profile, model: "missing-private-model" },
    { ...recorded.profile, effortLevel: "missing-private-intensity" },
    { ...recorded.profile, executionMode: "missing-execution-mode" },
    { ...recorded.profile, accessMode: "missing-access-mode" },
  ];
  for (const mismatch of mismatches) {
    assert.deepEqual(snapshot.resolveReplacementPrefill(mismatch), {
      kind: "manual-selection-required",
    });
  }

  const coupledSelection = {
    ...selectionAt(snapshot.publicResult.profile, 0, 0, 1),
    executionModeKey:
      snapshot.publicResult.profile.endpoints[0]!.executionModes[1]!.key,
  };
  const coupled = snapshot.resolveSelection(coupledSelection);
  assert.ok(coupled);
  assert.equal(coupled.profile.executionMode, "coordinated-workflow");
  assert.deepEqual(
    snapshot.resolveReplacementPrefill({
      ...coupled.profile,
      executionMode: "single-agent",
    }),
    { kind: "manual-selection-required" },
  );
});

test("replacement prefill rejects duplicate complete relations even when labels differ", () => {
  const endpoints = fixtureEndpoints();
  const duplicateEndpoint: DirectSessionProfileEndpointCatalog = Object.freeze({
    ...endpoints[0]!,
    endpointId: "claude-code-desktop",
    runtimeFamilyLabel: "Different public family",
    endpointLabel: "Different public endpoint",
    catalogRevision: "catalog:duplicate-private-relation",
  });
  const snapshot = createDirectSessionProfileSnapshot({
    endpoints: Object.freeze([endpoints[0]!, duplicateEndpoint]),
    endpointDiscovery: endpointDiscoveryReady(),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  });
  const recorded = snapshot.resolveSelection(
    selectionAt(snapshot.publicResult.profile, 0, 0, 0),
  );
  assert.ok(recorded);

  assert.deepEqual(snapshot.resolveReplacementPrefill(recorded.profile), {
    kind: "manual-selection-required",
  });
});

test("replacement prefill ignores shared labels and array order while returning current keys", () => {
  const recordedSnapshot = fixtureSnapshot();
  const recordedSelection = selectionAt(
    recordedSnapshot.publicResult.profile,
    0,
    0,
    0,
  );
  const recorded = recordedSnapshot.resolveSelection(recordedSelection);
  assert.ok(recorded);

  const endpoints = fixtureEndpoints();
  const quartz = endpoints[0]!;
  const [sharedModel, vectorModel] = quartz.catalog.models;
  assert.ok(sharedModel);
  assert.ok(vectorModel);
  const reorderedSharedModel = Object.freeze({
    ...sharedModel,
    effortLevels: Object.freeze([...sharedModel.effortLevels].reverse()),
    effortLevelLabels: Object.freeze(
      [...(sharedModel.effortLevelLabels ?? [])].reverse(),
    ),
  });
  const reorderedQuartz: DirectSessionProfileEndpointCatalog = Object.freeze({
    ...quartz,
    catalog: Object.freeze({
      ...quartz.catalog,
      models: Object.freeze([vectorModel, reorderedSharedModel]),
    }),
    catalogRevision: "catalog:reordered",
  });
  const currentSnapshot = createDirectSessionProfileSnapshot({
    endpoints: Object.freeze([reorderedQuartz, endpoints[1]!]),
    endpointDiscovery: endpointDiscoveryReady(),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  });
  const currentSelection = selectionAt(
    currentSnapshot.publicResult.profile,
    0,
    1,
    1,
  );
  assert.equal(
    currentSnapshot.publicResult.profile.endpoints[0]!.models[1]!.label,
    currentSnapshot.publicResult.profile.endpoints[1]!.models[0]!.label,
  );

  assert.deepEqual(
    currentSnapshot.resolveReplacementPrefill(recorded.profile),
    {
      kind: "resolved",
      endpointKey: currentSelection.endpointKey,
      modelKey: currentSelection.modelKey,
      workIntensityKey: currentSelection.workIntensityKey,
      executionModeKey: currentSelection.executionModeKey,
      accessModeKey: currentSelection.accessModeKey,
    },
  );
});

test("desired-default changes retain the exact atomic endpoint discovery observation", () => {
  const snapshot = fixtureSnapshot();
  const selection = selectionAt(snapshot.publicResult.profile, 1, 0, 1);

  const updated = snapshot.withDesiredDefault(selection);

  assert.notEqual(updated, snapshot);
  assert.equal(
    updated.publicResult.endpointDiscovery,
    snapshot.publicResult.endpointDiscovery,
  );
  assert.deepEqual(updated.publicResult.endpointDiscovery, endpointDiscoveryReady());
  assert.deepEqual(updated.publicResult.profile.desiredDefault, {
    kind: "resolved",
    endpointKey: selection.endpointKey,
    modelKey: selection.modelKey,
    workIntensityKey: selection.workIntensityKey,
    executionModeKey: selection.executionModeKey,
    accessModeKey: selection.accessModeKey,
  });
  assert.equal(Object.isFrozen(updated.publicResult.endpointDiscovery), true);
  assert.equal(
    Object.isFrozen(updated.publicResult.endpointDiscovery.statuses),
    true,
  );
});

test("snapshot construction rejects a shape-correct endpoint Proxy before private catalog data is read", () => {
  const endpoints = fixtureEndpoints();
  const endpoint = { ...endpoints[0]! };
  let runtimeFamilyLabelReads = 0;
  const mutableEndpoint = new Proxy(endpoint, {
    get(target, property, receiver) {
      if (property === "runtimeFamilyLabel") {
        runtimeFamilyLabelReads += 1;
        return runtimeFamilyLabelReads === 1
          ? Reflect.get(target, property, receiver)
          : "C:\\PRIVATE\\runtime.exe";
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(
    () =>
      createDirectSessionProfileSnapshot({
        endpoints: Object.freeze([mutableEndpoint, endpoints[1]!]),
        endpointDiscovery: endpointDiscoveryReady(),
        endpointIds: FIXTURE_ENDPOINT_IDS,
      }),
    /invalid-endpoints/u,
  );
  assert.equal(runtimeFamilyLabelReads, 0);
});

test("snapshot construction rejects mutating Proxies across the complete private endpoint graph", () => {
  const endpoints = fixtureEndpoints();
  const discovery = endpointDiscoveryReady();
  const endpoint = endpoints[0]!;
  const catalog = endpoint.catalog;
  const model = catalog.models[0]!;
  const coupling = catalog.workIntensityExecutionModeCouplings?.[0];
  assert.ok(coupling);
  assert.ok(model.effortLevelLabels);
  const desiredDefault = {
    endpointIndex: 0,
    profile: {
      model: model.id,
      effortLevel: model.effortLevels[0]!,
      executionMode: catalog.executionModes[0]!,
      accessMode: catalog.accessModes[0]!,
    },
  };
  const options = { endpoints, endpointDiscovery: discovery };
  const withEndpoint = (replacement: unknown) => ({
    endpoints: [replacement, endpoints[1]!],
    endpointDiscovery: discovery,
  });
  const withCatalog = (replacement: unknown) =>
    withEndpoint({ ...endpoint, catalog: replacement });
  const cases = [
    snapshotProxyCase(
      "options record",
      { ...options },
      "endpointDiscovery",
      { executable: "C:\\PRIVATE\\runtime.exe" },
      (proxy) => proxy,
    ),
    snapshotProxyCase(
      "endpoints array",
      [...endpoints],
      "0",
      { ...endpoint, runtimeFamilyLabel: "C:\\PRIVATE\\runtime.exe" },
      (proxy) => ({ endpoints: proxy, endpointDiscovery: discovery }),
    ),
    snapshotProxyCase(
      "endpoint record",
      { ...endpoint },
      "runtimeFamilyLabel",
      "C:\\PRIVATE\\runtime.exe",
      withEndpoint,
    ),
    snapshotProxyCase(
      "discovery record",
      { ...discovery },
      "statuses",
      [{ executable: "C:\\PRIVATE\\runtime.exe" }],
      (proxy) => ({ endpoints, endpointDiscovery: proxy }),
    ),
    snapshotProxyCase(
      "statuses array",
      [...discovery.statuses],
      "0",
      { endpointId: "codex-desktop", category: "C:\\PRIVATE\\status" },
      (proxy) => ({ endpoints, endpointDiscovery: { statuses: proxy } }),
    ),
    snapshotProxyCase(
      "status record",
      { ...discovery.statuses[0]! },
      "category",
      "C:\\PRIVATE\\status",
      (proxy) => ({
        endpoints,
        endpointDiscovery: { statuses: [proxy, discovery.statuses[1]!] },
      }),
    ),
    snapshotProxyCase(
      "catalog record",
      { ...catalog },
      "runtime",
      "C:\\PRIVATE\\runtime.exe",
      withCatalog,
    ),
    snapshotProxyCase(
      "models array",
      [...catalog.models],
      "0",
      { ...model, id: "C:\\PRIVATE\\model" },
      (proxy) => withCatalog({ ...catalog, models: proxy }),
    ),
    snapshotProxyCase(
      "model record",
      { ...model },
      "id",
      "C:\\PRIVATE\\model",
      (proxy) => withCatalog({ ...catalog, models: [proxy] }),
    ),
    snapshotProxyCase(
      "effort-level array",
      [...model.effortLevels],
      "0",
      "C:\\PRIVATE\\effort",
      (proxy) =>
        withCatalog({ ...catalog, models: [{ ...model, effortLevels: proxy }] }),
    ),
    snapshotProxyCase(
      "effort-label array",
      [...model.effortLevelLabels],
      "0",
      "C:\\PRIVATE\\effort-label",
      (proxy) =>
        withCatalog({
          ...catalog,
          models: [{ ...model, effortLevelLabels: proxy }],
        }),
    ),
    snapshotProxyCase(
      "execution-mode array",
      [...catalog.executionModes],
      "0",
      "C:\\PRIVATE\\execution",
      (proxy) => withCatalog({ ...catalog, executionModes: proxy }),
    ),
    snapshotProxyCase(
      "access-mode array",
      [...catalog.accessModes],
      "0",
      "C:\\PRIVATE\\access",
      (proxy) => withCatalog({ ...catalog, accessModes: proxy }),
    ),
    snapshotProxyCase(
      "coupling array",
      [...catalog.workIntensityExecutionModeCouplings!],
      "0",
      { ...coupling, model: "C:\\PRIVATE\\model" },
      (proxy) =>
        withCatalog({
          ...catalog,
          workIntensityExecutionModeCouplings: proxy,
        }),
    ),
    snapshotProxyCase(
      "coupling record",
      { ...coupling },
      "model",
      "C:\\PRIVATE\\model",
      (proxy) =>
        withCatalog({
          ...catalog,
          workIntensityExecutionModeCouplings: [proxy],
        }),
    ),
    snapshotProxyCase(
      "execution-label array",
      [...endpoint.executionModeLabels],
      "0",
      "C:\\PRIVATE\\execution-label",
      (proxy) => withEndpoint({ ...endpoint, executionModeLabels: proxy }),
    ),
    snapshotProxyCase(
      "access-label array",
      [...endpoint.accessModeLabels],
      "0",
      "C:\\PRIVATE\\access-label",
      (proxy) => withEndpoint({ ...endpoint, accessModeLabels: proxy }),
    ),
    snapshotProxyCase(
      "desired-default record",
      { ...desiredDefault },
      "endpointIndex",
      "C:\\PRIVATE\\default",
      (proxy) => ({ ...options, desiredDefault: proxy }),
    ),
    snapshotProxyCase(
      "desired profile record",
      { ...desiredDefault.profile },
      "model",
      "C:\\PRIVATE\\model",
      (proxy) => ({
        ...options,
        desiredDefault: { ...desiredDefault, profile: proxy },
      }),
    ),
  ];

  for (const row of cases) {
    assert.throws(
      () =>
        createDirectSessionProfileSnapshot(
          row.value as Parameters<typeof createDirectSessionProfileSnapshot>[0],
        ),
      /invalid-endpoints/u,
      row.name,
    );
    assert.equal(row.reads(), 0, row.name);
  }
});

test("resolved identities deduplicate stably, suppress duplicate provenance, and retain a native fallback", () => {
  const snapshot = createDirectSessionProfileSnapshot({
    endpoints: [
      {
        endpointId: "codex-desktop",
        runtimeFamilyLabel: "Fixture Runtime",
        endpointLabel: "Fixture desktop",
        catalogRevision: "catalog:dedup",
        catalog: {
          runtime: "fixture-runtime",
          models: [
            {
              id: "private-default-selector",
              resolvedModel: "resolved-model[1m]",
              displayName: "Default (recommended)",
              effortLevels: ["low"],
              effortLevelLabels: ["Low description"],
            },
            {
              id: "private-explicit-selector",
              resolvedModel: "resolved-model[1m]",
              displayName: "Explicit model wording",
              effortLevels: ["max"],
            },
            {
              id: "native-fallback-model",
              displayName: "Fallback catalog wording",
              effortLevels: ["xhigh"],
            },
          ],
          executionModes: ["single-agent"],
          accessModes: ["full-access"],
        },
        executionModeLabels: ["Single agent"],
        accessModeLabels: ["Full access"],
      },
    ],
    endpointDiscovery: publicRuntimeEndpointDiscovery([
      { endpointId: "codex-desktop", category: "catalog-ready" },
      { endpointId: "claude-code-desktop", category: "not-inspected" },
    ]),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  });
  const profile = snapshot.publicResult.profile;

  assert.deepEqual(
    profile.endpoints[0]?.models.map((model) => ({
      label: model.label,
      provenanceLabel: model.provenanceLabel,
      workIntensities: model.workIntensities.map((option) => option.label),
    })),
    [
      {
        label: "resolved-model[1m]",
        provenanceLabel: null,
        workIntensities: ["low"],
      },
      {
        label: "native-fallback-model",
        provenanceLabel: "Fallback catalog wording",
        workIntensities: ["xhigh"],
      },
    ],
  );
  assert.equal(JSON.stringify(profile).includes("Default (recommended)"), false);
  const firstSelection = selectionAt(profile, 0, 0, 0);
  assert.equal(
    snapshot.resolveSelection(firstSelection)?.profile.model,
    "private-default-selector",
  );
});

test("Claude presentation maps only approved resolved identities and retains an unknown native fallback", () => {
  const snapshot = createDirectSessionProfileSnapshot({
    endpoints: [
      {
        endpointId: "claude-code-desktop",
        runtimeFamilyLabel: "Claude",
        endpointLabel: "Claude Code desktop",
        catalogRevision: "catalog:claude-products",
        catalog: {
          runtime: "claude-fixture",
          models: [
            {
              id: "private-opus-selector",
              resolvedModel: "claude-opus-5[1m]",
              displayName: "Default (recommended)",
              effortLevels: ["low"],
            },
            {
              id: "private-future-selector",
              resolvedModel: "claude-orbit-6",
              displayName: "Orbit",
              effortLevels: ["low"],
            },
          ],
          executionModes: ["single-agent"],
          accessModes: ["full-access"],
        },
        executionModeLabels: ["Single agent"],
        accessModeLabels: ["Full access"],
      },
    ],
    endpointDiscovery: publicRuntimeEndpointDiscovery([
      { endpointId: "codex-desktop", category: "not-inspected" },
      { endpointId: "claude-code-desktop", category: "catalog-ready" },
    ]),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  });

  assert.deepEqual(
    snapshot.publicResult.profile.endpoints[0]?.models.map((model) => ({
      label: model.label,
      provenanceLabel: model.provenanceLabel,
    })),
    [
      { label: "Opus 5", provenanceLabel: null },
      { label: "claude-orbit-6", provenanceLabel: "Orbit" },
    ],
  );
});

test("Codex presentation maps only approved resolved identities and retains an unknown native fallback", () => {
  const snapshot = createDirectSessionProfileSnapshot({
    endpoints: [
      {
        endpointId: "codex-desktop",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        catalogRevision: "catalog:codex-products",
        catalog: {
          runtime: "codex-fixture",
          models: [
            {
              id: "gpt-5.6-sol",
              displayName: "gpt-5.6-sol",
              effortLevels: ["low"],
            },
            {
              id: "gpt-5.6-terra",
              displayName: "gpt-5.6-terra",
              effortLevels: ["low"],
            },
            {
              id: "gpt-5.6-luna",
              displayName: "gpt-5.6-luna",
              effortLevels: ["low"],
            },
            {
              id: "gpt-5.5",
              displayName: "gpt-5.5",
              effortLevels: ["low"],
            },
            {
              id: "gpt-5.4",
              displayName: "gpt-5.4",
              effortLevels: ["low"],
            },
            {
              id: "gpt-5.4-mini",
              displayName: "gpt-5.4-mini",
              effortLevels: ["low"],
            },
            {
              id: "gpt-5.3-codex-spark",
              displayName: "gpt-5.3-codex-spark",
              effortLevels: ["low"],
            },
            {
              id: "gpt-6-future",
              displayName: "Future display name",
              effortLevels: ["low"],
            },
          ],
          executionModes: ["single-agent"],
          accessModes: ["full-access"],
        },
        executionModeLabels: ["Single agent"],
        accessModeLabels: ["Full access"],
      },
    ],
    endpointDiscovery: publicRuntimeEndpointDiscovery([
      { endpointId: "codex-desktop", category: "catalog-ready" },
      { endpointId: "claude-code-desktop", category: "not-inspected" },
    ]),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  });

  assert.deepEqual(
    snapshot.publicResult.profile.endpoints[0]?.models.map((model) => ({
      label: model.label,
      provenanceLabel: model.provenanceLabel,
    })),
    [
      { label: "GPT-5.6-Sol", provenanceLabel: null },
      { label: "GPT-5.6-Terra", provenanceLabel: null },
      { label: "GPT-5.6-Luna", provenanceLabel: null },
      { label: "GPT-5.5", provenanceLabel: null },
      { label: "GPT-5.4", provenanceLabel: null },
      { label: "GPT-5.4-Mini", provenanceLabel: null },
      { label: "GPT-5.3-Codex-Spark", provenanceLabel: null },
      { label: "gpt-6-future", provenanceLabel: "Future display name" },
    ],
  );
});

test("a catalog-declared Work Intensity coupling determines Execution Mode while the other fixture stays independent", () => {
  const snapshot = fixtureSnapshot();
  const profile = snapshot.publicResult.profile;
  const quartz = profile.endpoints[0];
  const quartzModel = quartz?.models[0];
  const independentIntensity = quartzModel?.workIntensities[0];
  const coupledIntensity = quartzModel?.workIntensities[1];
  const independentExecution = quartz?.executionModes[0];
  const coupledExecution = quartz?.executionModes[1];
  if (
    quartz === undefined ||
    quartzModel === undefined ||
    independentIntensity === undefined ||
    coupledIntensity === undefined ||
    independentExecution === undefined ||
    coupledExecution === undefined
  ) {
    assert.fail("Expected the coupled fixture relation.");
  }

  assert.equal(independentIntensity.impliedExecutionModeKey, undefined);
  assert.deepEqual(Object.keys(independentIntensity).sort(), ["key", "label"]);
  assert.equal(
    coupledIntensity.impliedExecutionModeKey,
    coupledExecution.key,
  );
  assert.equal(coupledExecution.label, "Coordinated workflow");

  const independentSelection = selectionAt(profile, 0, 0, 0);
  assert.deepEqual(snapshot.resolveSelection(independentSelection)?.profile, {
    model: "quartz-private-model-a",
    effortLevel: "q-brief",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  assert.deepEqual(
    snapshot.resolveSelection(independentSelection)?.requestedProfileProjection,
    {
      kind: "recorded",
      runtimeFamilyLabel: "Quartz Runtime",
      endpointLabel: "Quartz Studio",
      modelLabel: "Shared Compass",
      workIntensityControlLabel: {
        label: "Deliberation",
        provenance: "runtime-catalog",
      },
      workIntensityLabel: "q-brief",
      executionModeLabel: "Single agent",
      accessModeLabel: "Full access",
    },
  );

  const coupledSelection = Object.freeze({
    ...selectionAt(profile, 0, 0, 1),
    executionModeKey: coupledExecution.key,
  });
  assert.deepEqual(snapshot.resolveSelection(coupledSelection)?.profile, {
    model: "quartz-private-model-a",
    effortLevel: "q-deep",
    executionMode: "coordinated-workflow",
    accessMode: "full-access",
  });
  assert.equal(
    snapshot.resolveSelection({
      ...coupledSelection,
      executionModeKey: independentExecution.key,
    }),
    undefined,
  );

  const nimbusSelection = selectionAt(profile, 1, 0, 2);
  assert.deepEqual(
    Object.keys(profile.endpoints[1]!.models[0]!.workIntensities[2]!).sort(),
    ["key", "label"],
  );
  assert.deepEqual(snapshot.resolveSelection(nimbusSelection)?.profile, {
    model: "nimbus-private-model-b",
    effortLevel: "n-exhaustive",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  assert.deepEqual(
    snapshot.resolveSelection(nimbusSelection)?.requestedProfileProjection
      .workIntensityControlLabel,
    { label: null, provenance: "not-recorded" },
  );
});

test("selection resolution rejects stale snapshot keys as a distinct fail-closed case", () => {
  const current = fixtureSnapshot();
  const stale = fixtureSnapshot();
  const staleSelection = selectionAt(stale.publicResult.profile, 0, 0, 0);

  assert.equal(current.resolveSelection(staleSelection), undefined);
});

test("selection resolution rejects a model key owned by another endpoint", () => {
  const snapshot = fixtureSnapshot();
  const profile = snapshot.publicResult.profile;
  const quartz = selectionAt(profile, 0, 0, 0);
  const nimbus = selectionAt(profile, 1, 0, 0);

  assert.equal(
    snapshot.resolveSelection({ ...quartz, modelKey: nimbus.modelKey }),
    undefined,
  );
});

test("selection resolution rejects an intensity key owned by another model", () => {
  const snapshot = fixtureSnapshot();
  const profile = snapshot.publicResult.profile;
  const firstModel = selectionAt(profile, 0, 0, 0);
  const secondModel = selectionAt(profile, 0, 1, 0);

  assert.equal(
    snapshot.resolveSelection({
      ...firstModel,
      workIntensityKey: secondModel.workIntensityKey,
    }),
    undefined,
  );
});

test("selection resolution rejects a well-formed key that names nothing in the current snapshot", () => {
  const snapshot = fixtureSnapshot();
  const selection = selectionAt(snapshot.publicResult.profile, 0, 0, 0);

  assert.equal(
    snapshot.resolveSelection({
      ...selection,
      modelKey:
        "model-option:999:00000000-0000-4000-8000-000000000099",
    }),
    undefined,
  );
});

test("selection resolution rejects a shape-correct Proxy before any selection field is read", () => {
  const snapshot = fixtureSnapshot();
  const selection = { ...selectionAt(snapshot.publicResult.profile, 0, 0, 0) };
  let proxyOperations = 0;
  const mutableSelection = new Proxy(selection, {
    get(target, property, receiver) {
      proxyOperations += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(snapshot.resolveSelection(mutableSelection), undefined);
  assert.equal(snapshot.withDesiredDefault(mutableSelection), snapshot);
  assert.equal(proxyOperations, 0);
});

test("snapshot construction rejects every endpoint discovery contradiction as one atomic unit", () => {
  const endpoints = fixtureEndpoints();
  const exactDiscovery = endpointDiscoveryReady();
  const discoveryWithExtra = {
    ...exactDiscovery,
    nativePath: "C:\\PRIVATE\\runtime.exe",
  } as unknown as WorkbenchRuntimeEndpointDiscovery;
  const hiddenDiscovery = { ...exactDiscovery };
  Object.defineProperty(hiddenDiscovery, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolDiscovery = { ...exactDiscovery };
  Object.defineProperty(symbolDiscovery, Symbol("PRIVATE_DISCOVERY"), {
    value: "PRIVATE_DISCOVERY",
    enumerable: false,
  });
  const accessorDiscovery = {};
  Object.defineProperty(accessorDiscovery, "statuses", {
    get() {
      throw new Error("PRIVATE_DISCOVERY_ACCESSOR");
    },
    enumerable: true,
  });
  const prototypeDiscovery = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    exactDiscovery,
  );
  const sparseStatuses = new Array(2);
  sparseStatuses[0] = exactDiscovery.statuses[0];
  const thirdStatuses = [
    ...exactDiscovery.statuses,
    { endpointId: "codex-desktop", category: "not-inspected" },
  ];
  const hiddenStatus = { ...exactDiscovery.statuses[0]! };
  Object.defineProperty(hiddenStatus, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  const symbolStatus = { ...exactDiscovery.statuses[0]! };
  Object.defineProperty(symbolStatus, Symbol("PRIVATE_STATUS"), {
    value: "PRIVATE_STATUS",
    enumerable: false,
  });
  const accessorStatus = { endpointId: "codex-desktop" };
  Object.defineProperty(accessorStatus, "category", {
    get() {
      throw new Error("PRIVATE_STATUS_ACCESSOR");
    },
    enumerable: true,
  });
  const prototypeStatus = Object.assign(
    Object.create({ nativePath: "C:\\PRIVATE\\runtime.exe" }),
    exactDiscovery.statuses[0],
  );
  const unknownCodexCategory = {
    statuses: [
      { endpointId: "codex-desktop", category: "PRIVATE_UNKNOWN" },
      { endpointId: "claude-code-desktop", category: "catalog-ready" },
    ],
  } as unknown as WorkbenchRuntimeEndpointDiscovery;
  const claudeAuthentication = {
    statuses: [
      { endpointId: "codex-desktop", category: "not-inspected" },
      {
        endpointId: "claude-code-desktop",
        category: "authentication-required",
      },
    ],
  } as unknown as WorkbenchRuntimeEndpointDiscovery;
  const cases: readonly {
    readonly name: string;
    readonly endpoints: readonly DirectSessionProfileEndpointCatalog[];
    readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
  }[] = [
    {
      name: "ready set omits one catalog",
      endpoints,
      endpointDiscovery: publicRuntimeEndpointDiscovery([
        { endpointId: "codex-desktop", category: "catalog-ready" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
      ]),
    },
    {
      name: "catalog order contradicts the fixed endpoint tuple",
      endpoints: Object.freeze([endpoints[1]!, endpoints[0]!]),
      endpointDiscovery: exactDiscovery,
    },
    {
      name: "duplicate catalog identity",
      endpoints: Object.freeze([
        endpoints[0]!,
        Object.freeze({ ...endpoints[1]!, endpointId: "codex-desktop" }),
      ]),
      endpointDiscovery: exactDiscovery,
    },
    {
      name: "discovery carries an undeclared private key",
      endpoints,
      endpointDiscovery: discoveryWithExtra,
    },
    {
      name: "discovery carries a hidden private key",
      endpoints,
      endpointDiscovery:
        hiddenDiscovery as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "discovery carries a symbol key",
      endpoints,
      endpointDiscovery:
        symbolDiscovery as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "discovery carries an accessor",
      endpoints,
      endpointDiscovery:
        accessorDiscovery as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "discovery carries a custom prototype",
      endpoints,
      endpointDiscovery:
        prototypeDiscovery as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "discovery status tuple is sparse",
      endpoints,
      endpointDiscovery: {
        statuses: sparseStatuses,
      } as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "discovery carries a third status row",
      endpoints,
      endpointDiscovery: {
        statuses: thirdStatuses,
      } as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "status carries a hidden private key",
      endpoints,
      endpointDiscovery: {
        statuses: [hiddenStatus, exactDiscovery.statuses[1]],
      } as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "status carries a symbol key",
      endpoints,
      endpointDiscovery: {
        statuses: [symbolStatus, exactDiscovery.statuses[1]],
      } as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "status carries an accessor",
      endpoints,
      endpointDiscovery: {
        statuses: [accessorStatus, exactDiscovery.statuses[1]],
      } as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "status carries a custom prototype",
      endpoints,
      endpointDiscovery: {
        statuses: [prototypeStatus, exactDiscovery.statuses[1]],
      } as unknown as WorkbenchRuntimeEndpointDiscovery,
    },
    {
      name: "Codex category is not in the finite public set",
      endpoints: Object.freeze([endpoints[1]!]),
      endpointDiscovery: unknownCodexCategory,
    },
    {
      name: "Claude claims authentication-required",
      endpoints: Object.freeze([endpoints[1]!]),
      endpointDiscovery: claudeAuthentication,
    },
  ];

  for (const row of cases) {
    assert.throws(
      () =>
        createDirectSessionProfileSnapshot({
          endpoints: row.endpoints,
          endpointDiscovery: row.endpointDiscovery,
        }),
      /invalid-endpoints/u,
      row.name,
    );
  }
});

function fixtureSnapshot() {
  return createDirectSessionProfileSnapshot({
    endpoints: fixtureEndpoints(),
    endpointDiscovery: endpointDiscoveryReady(),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  });
}

function fixtureEndpoints(): readonly DirectSessionProfileEndpointCatalog[] {
  const fixtures = dissimilarNeutralEndpointFixtures();
  const firstCatalog = fixtures[0].adapter.catalog;
  const quartzCatalog: RuntimeCatalog = Object.freeze({
    ...firstCatalog,
    models: Object.freeze([
      ...firstCatalog.models,
      Object.freeze({
        id: "quartz-private-model-vector",
        resolvedModel: "Quartz Vector",
        displayName: "Quartz Vector",
        workIntensityLabel: "Review span",
        effortLevels: Object.freeze(["q-vector"]),
        effortLevelLabels: Object.freeze(["Vector review"]),
      }),
    ]),
  });
  const endpoints: readonly DirectSessionProfileEndpointCatalog[] =
    Object.freeze([
      endpointCatalog(
        "codex-desktop",
        fixtures[0],
        quartzCatalog,
        "catalog:quartz",
      ),
      endpointCatalog(
        "claude-code-desktop",
        fixtures[1],
        fixtures[1].adapter.catalog,
        "catalog:nimbus",
      ),
    ]);
  return endpoints;
}

function endpointCatalog(
  endpointId: WorkbenchRuntimeEndpointId,
  fixture: ReturnType<typeof dissimilarNeutralEndpointFixtures>[number],
  catalog: RuntimeCatalog,
  catalogRevision: string,
): DirectSessionProfileEndpointCatalog {
  return Object.freeze({
    endpointId,
    runtimeFamilyLabel: fixture.runtimeFamilyLabel,
    endpointLabel: fixture.endpointLabel,
    catalog,
    catalogRevision,
    executionModeLabels: Object.freeze(
      catalog.executionModes.map((mode) =>
        mode === "single-agent" ? "Single agent" : "Coordinated workflow",
      ),
    ),
    accessModeLabels: Object.freeze(["Full access"]),
  });
}

function endpointDiscoveryReady(): WorkbenchRuntimeEndpointDiscovery {
  return publicRuntimeEndpointDiscovery([
    { endpointId: "codex-desktop", category: "catalog-ready" },
    { endpointId: "claude-code-desktop", category: "catalog-ready" },
  ]);
}

function selectionAt(
  profile: ReturnType<typeof fixtureSnapshot>["publicResult"]["profile"],
  endpointIndex: number,
  modelIndex: number,
  intensityIndex: number,
): WorkbenchDirectSessionProfileSelection {
  const endpoint = profile.endpoints[endpointIndex];
  const model = endpoint?.models[modelIndex];
  const intensity = model?.workIntensities[intensityIndex];
  const executionMode = endpoint?.executionModes[0];
  const accessMode = endpoint?.accessModes[0];
  if (
    endpoint === undefined ||
    model === undefined ||
    intensity === undefined ||
    executionMode === undefined ||
    accessMode === undefined
  ) {
    assert.fail("Expected one complete endpoint-scoped selection.");
  }
  return Object.freeze({
    snapshotKey: profile.snapshotKey,
    endpointKey: endpoint.key,
    modelKey: model.key,
    workIntensityKey: intensity.key,
    executionModeKey: executionMode.key,
    accessModeKey: accessMode.key,
  });
}

function privateFixtureValues(): readonly string[] {
  return Object.freeze([
    "quartz-native-runtime",
    "quartz-private-model-a",
    "quartz-private-model-vector",
    "nimbus-native-runtime",
    "nimbus-private-model-b",
  ]);
}

function snapshotProxyCase<T extends object>(
  name: string,
  target: T,
  property: PropertyKey,
  privateValue: unknown,
  build: (proxy: T) => unknown,
): {
  readonly name: string;
  readonly value: unknown;
  readonly reads: () => number;
} {
  let reads = 0;
  const proxy = new Proxy(target, {
    get(current, currentProperty, receiver) {
      if (currentProperty === property) {
        reads += 1;
        if (reads > 1) return privateValue;
      }
      return Reflect.get(current, currentProperty, receiver);
    },
  });
  return Object.freeze({ name, value: build(proxy), reads: () => reads });
}
