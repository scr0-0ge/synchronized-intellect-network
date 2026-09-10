import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRuntimeAdapter,
  RuntimeBinding,
  RuntimeCatalog,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import {
  createRuntimeEndpointDirectory,
  type RuntimeEndpointRegistration,
} from "../../src/agent-runtime/runtime-endpoint-directory.ts";
import {
  publicRuntimeEndpointDiscovery,
  publicSingleInspectedRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointId,
} from "../../src/workbench-shell/contract.ts";
import {
  areRegisteredEndpointIdsInOrder,
  isRegisteredRuntimeEndpointId,
  runtimeEndpointOrdinal,
  WORKBENCH_RUNTIME_ENDPOINT_IDS,
} from "../../src/workbench-shell/runtime-endpoint-identity.ts";
import {
  createDirectSessionProfileSnapshot,
  type DirectSessionProfileEndpointCatalog,
} from "../../src/workbench-shell/direct-session-profile-snapshot.ts";
import {
  createWorkbenchRuntimeEndpointAdapter,
  readWorkbenchDirectRuntimeEndpoints,
  type WorkbenchDirectRuntimeEndpointSnapshot,
} from "../../src/workbench-shell/runtime-endpoint-adapter.ts";
import { sanitizeWorkbenchDirectSessionProfileResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { createDirectSessionProfilePreferenceStore } from "../../src/workbench-shell/preference-store.ts";
import {
  WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS,
} from "../../src/workbench-shell/subscription-authentication-coordinator.ts";
import {
  initialSettingsSubscriptionAuthenticationState,
  subscriptionAuthenticationSelectionKey,
} from "../../src/workbench-shell/renderer/settings-view-model.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  directProfileEndpoints,
  initialRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { createTestDirectory } from "../helpers/test-lifecycle.ts";

/*
 * Proof that the endpoint identity layer is data-driven (issue 04, extended
 * in issue 05): a third, test-only fake endpoint flows through registration,
 * snapshot, preference, view, and sanitization plumbing correctly. Since
 * issue 05 the production union itself carries three endpoints (GLM joined
 * as `glm-coding-plan`); the cast below still lets a roster carry further
 * registered ids in future tickets without widening the union first.
 */
const THIRD_ENDPOINT_ID = "test-third-endpoint" as WorkbenchRuntimeEndpointId;
const THREE_ENDPOINT_IDS: readonly WorkbenchRuntimeEndpointId[] =
  Object.freeze(["codex-desktop", "claude-code-desktop", THIRD_ENDPOINT_ID]);

test("the canonical roster now carries the eight production endpoints in registration order", () => {
  assert.deepEqual(WORKBENCH_RUNTIME_ENDPOINT_IDS, [
    "codex-desktop",
    "claude-code-desktop",
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
    "kimi-platform",
    "claude-api",
    "codex-api",
  ]);
  assert.equal(isRegisteredRuntimeEndpointId("codex-desktop"), true);
  assert.equal(isRegisteredRuntimeEndpointId("glm-coding-plan"), true);
  assert.equal(isRegisteredRuntimeEndpointId("kimi-code"), true);
  assert.equal(isRegisteredRuntimeEndpointId("deepseek-api"), true);
  assert.equal(isRegisteredRuntimeEndpointId("kimi-platform"), true);
  assert.equal(isRegisteredRuntimeEndpointId("claude-api"), true);
  assert.equal(isRegisteredRuntimeEndpointId("codex-api"), true);
  assert.equal(isRegisteredRuntimeEndpointId(THIRD_ENDPOINT_ID), false);
  assert.equal(runtimeEndpointOrdinal("codex-desktop"), 0);
  assert.equal(runtimeEndpointOrdinal("claude-code-desktop"), 1);
  assert.equal(runtimeEndpointOrdinal("glm-coding-plan"), 2);
  assert.equal(runtimeEndpointOrdinal("kimi-code"), 3);
  assert.equal(runtimeEndpointOrdinal("deepseek-api"), 4);
  assert.equal(runtimeEndpointOrdinal("kimi-platform"), 5);
  assert.equal(runtimeEndpointOrdinal("claude-api"), 6);
  assert.equal(runtimeEndpointOrdinal("codex-api"), 7);
  assert.equal(
    subscriptionAuthenticationSelectionKey("codex-desktop"),
    WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
  );
  assert.equal(
    subscriptionAuthenticationSelectionKey("claude-code-desktop"),
    WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
  );
  assert.throws(
    () => subscriptionAuthenticationSelectionKey("glm-coding-plan"),
    TypeError,
  );
  assert.equal(
    areRegisteredEndpointIdsInOrder(["claude-code-desktop"]),
    true,
  );
  assert.equal(
    areRegisteredEndpointIdsInOrder([
      "claude-code-desktop",
      "codex-desktop",
    ]),
    false,
  );
  assert.equal(
    areRegisteredEndpointIdsInOrder([
      "codex-desktop",
      "claude-code-desktop",
      "glm-coding-plan",
    ]),
    true,
  );
});

test("a third endpoint registers in the Runtime Endpoint Directory and snapshots as a peer", () => {
  const directory = createRuntimeEndpointDirectory([
    directoryRegistration("codex-desktop", "Codex", "third-proof-codex-model"),
    directoryRegistration(
      "claude-code-desktop",
      "Claude",
      "third-proof-claude-model",
    ),
    directoryRegistration(
      THIRD_ENDPOINT_ID,
      "Third Fixture",
      "third-fixture-model",
    ),
  ]);
  const snapshot = directory.snapshot();
  assert.equal(snapshot.endpoints.length, 3);
  const third = snapshot.endpoints.find(
    (endpoint) => endpoint.runtimeFamily === "Third Fixture",
  );
  assert.ok(third);
  assert.equal(third.profiles.length, 1);
  assert.equal(third.profiles[0]?.modelLabel, "Shared Model");
  assert.ok(
    snapshot.endpoints.every((endpoint) => endpoint.availability === "online"),
  );
});

test("a third endpoint admits through roster-driven identity data, not through widened hard-coding", () => {
  assert.equal(isRegisteredRuntimeEndpointId(THIRD_ENDPOINT_ID, THREE_ENDPOINT_IDS), true);
  assert.equal(runtimeEndpointOrdinal(THIRD_ENDPOINT_ID, THREE_ENDPOINT_IDS), 2);
  assert.equal(
    areRegisteredEndpointIdsInOrder(
      ["codex-desktop", THIRD_ENDPOINT_ID],
      THREE_ENDPOINT_IDS,
    ),
    true,
  );
  assert.equal(
    areRegisteredEndpointIdsInOrder(
      [THIRD_ENDPOINT_ID, "claude-code-desktop"],
      THREE_ENDPOINT_IDS,
    ),
    false,
  );
  assert.deepEqual(
    publicSingleInspectedRuntimeEndpointDiscovery(
      THIRD_ENDPOINT_ID,
      "catalog-ready",
      THREE_ENDPOINT_IDS,
    ).statuses.map((status) => [status.endpointId, status.category]),
    [
      ["codex-desktop", "not-inspected"],
      ["claude-code-desktop", "not-inspected"],
      [THIRD_ENDPOINT_ID, "catalog-ready"],
    ],
  );
});

test("the endpoint adapter freeze admits a third endpoint snapshot when the roster says three", async () => {
  const load = thirdEndpointAdapterLoader(THREE_ENDPOINT_IDS);
  const accepted = await load("C:\\Project", "catalog-default");
  assert.equal(accepted.endpoints.length, 3);
  assert.equal(accepted.endpoints[2]?.endpointId, THIRD_ENDPOINT_ID);
  assert.deepEqual(
    accepted.endpointDiscovery.statuses.map((status) => status.endpointId),
    THREE_ENDPOINT_IDS,
  );
  assert.equal(Object.isFrozen(accepted.endpoints), true);

  const canonicalOnly = thirdEndpointAdapterLoader();
  await assert.rejects(
    canonicalOnly("C:\\Project", "catalog-default"),
    /invalid-runtime-endpoint/u,
  );

  const reordered = thirdEndpointAdapterLoader(THREE_ENDPOINT_IDS, [
    "codex-desktop",
    THIRD_ENDPOINT_ID,
    "claude-code-desktop",
  ]);
  await assert.rejects(
    reordered("C:\\Project", "catalog-default"),
    /runtime-endpoint/u,
  );
});

test("a third endpoint catalog resolves selections and defaults in the direct-session snapshot", () => {
  const snapshot = thirdEndpointProfileSnapshot();
  const profile = snapshot.publicResult.profile;
  assert.equal(profile.endpoints.length, 3);
  assert.equal(profile.endpoints[2]?.endpointLabel, "Third fixture endpoint");

  assert.throws(
    () => thirdEndpointProfileSnapshot(WORKBENCH_RUNTIME_ENDPOINT_IDS),
    /invalid-endpoints/u,
  );

  const thirdSelection = selectionAt(profile, 2, 0, 0);
  const resolved = snapshot.resolveSelection(thirdSelection);
  assert.ok(resolved);
  assert.deepEqual(resolved.profile, {
    model: "third-fixture-model",
    effortLevel: "third-effort",
    executionMode: "single-agent",
    accessMode: "full-access",
  } satisfies SessionProfile);
  assert.equal(resolved.endpointIndex, 2);

  const withDefault = snapshot.withDesiredDefault(thirdSelection);
  assert.equal(
    withDefault.publicResult.profile.desiredDefault.kind,
    "resolved",
  );
});

test("a third endpoint preference round-trips through the endpoint-keyed preference store", async (t) => {
  const directory = await createTestDirectory(
    t,
    join(tmpdir(), "third-endpoint-preferences-"),
  );
  const store = createDirectSessionProfilePreferenceStore({
    filePath: join(directory, "direct-profile.json"),
  });
  const committed = await store.saveDefault({
    endpointKey: "test-third-endpoint",
    model: "third-fixture-model",
    workIntensity: "third-effort",
  });
  assert.deepEqual(committed.endpoints, [
    {
      endpointKey: "test-third-endpoint",
      model: "third-fixture-model",
      models: [{ model: "third-fixture-model", workIntensity: "third-effort" }],
    },
  ]);
  const reopened = createDirectSessionProfilePreferenceStore({
    filePath: join(directory, "direct-profile.json"),
  });
  assert.deepEqual(await reopened.read(), committed);
  await reopened.close();
  await store.close();
});

test("the settings view model derives its endpoint rows from discovery data", () => {
  const discovery = publicRuntimeEndpointDiscovery(
    THREE_ENDPOINT_IDS.map((endpointId) => ({
      endpointId,
      category: "catalog-ready" as const,
    })),
  );
  const state = initialSettingsSubscriptionAuthenticationState(discovery);
  for (const endpointId of THREE_ENDPOINT_IDS) {
    if (endpointId === THIRD_ENDPOINT_ID) {
      // The fake endpoint is not a subscription-authentication participant;
      // its row stays absent even when discovery reports it catalog-ready.
      assert.equal(state[endpointId], undefined);
      continue;
    }
    assert.deepEqual(state[endpointId], {
      authentication: "unknown",
      inspectionPending: false,
      preparationPending: null,
      pendingAction: null,
      outcome: null,
      feedback: null,
      blockers: null,
      confirmation: null,
    });
  }
  // The production roster includes glm-coding-plan, which is not a
  // subscription-authentication participant: its row stays absent even when
  // discovery reports it.
  const canonicalState = initialSettingsSubscriptionAuthenticationState(
    publicRuntimeEndpointDiscovery(
      WORKBENCH_RUNTIME_ENDPOINT_IDS.map((endpointId) => ({
        endpointId,
        category: "catalog-ready" as const,
      })),
    ),
  );
  assert.deepEqual(Object.keys(canonicalState).sort(), [
    "claude-code-desktop",
    "codex-desktop",
  ]);
  const renderer = completeDirectSessionProfileLoad(
    beginDirectSessionProfileLoad(initialRendererState),
    thirdEndpointPublicResult(),
  );
  assert.deepEqual(
    directProfileEndpoints(renderer).map((endpoint) => endpoint.endpointId),
    THREE_ENDPOINT_IDS,
  );
});

test("sanitization accepts a third endpoint result for a three-roster and fails closed for the canonical roster", () => {
  const value = thirdEndpointPublicResult();

  const accepted = sanitizeWorkbenchDirectSessionProfileResult(
    value,
    { kind: "catalog-default" },
    THREE_ENDPOINT_IDS,
  );
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.profile.endpoints.length, 3);
    assert.equal(
      accepted.profile.endpoints[2]?.endpointId,
      THIRD_ENDPOINT_ID,
    );
    assert.equal(
      JSON.stringify(accepted).includes("test-third-endpoint"),
      true,
    );
  }

  const canonical = sanitizeWorkbenchDirectSessionProfileResult(value, {
    kind: "catalog-default",
  });
  assert.equal(canonical.ok, false);
  if (!canonical.ok) {
    assert.equal(canonical.error.category, "profile-unavailable");
  }

  const reordered = sanitizeWorkbenchDirectSessionProfileResult(
    {
      ...value,
      profile: {
        ...value.profile,
        endpoints: [
          value.profile.endpoints[0]!,
          value.profile.endpoints[2]!,
          value.profile.endpoints[1]!,
        ],
      },
    },
    { kind: "catalog-default" },
    THREE_ENDPOINT_IDS,
  );
  assert.equal(reordered.ok, false);
});

class InMemoryEndpointAdapter implements AgentRuntimeAdapter {
  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    return thirdCatalog();
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    throw new Error("The test adapter must not be started.");
  }
}

function directoryRegistration(
  endpointId: string,
  runtimeFamily: string,
  nativeModel: string,
): RuntimeEndpointRegistration {
  return {
    registrationId: `third-proof-${endpointId}`,
    endpointId,
    runtimeFamily,
    executionLocation: "local",
    adapter: new InMemoryEndpointAdapter(),
    capabilitySnapshot: {
      snapshotId: `${endpointId}-capabilities-1`,
      freshness: "fresh",
      availability: "online",
      contracts: {
        supervisorWorkOrders: true,
        workerSessions: true,
        normalizedEvents: true,
      },
      profiles: [
        {
          profileId: `${endpointId}-full-profile`,
          modelLabel: "Shared Model",
          workIntensityLabel: "Maximum",
          runtimeProfile: {
            model: nativeModel,
            effortLevel: "maximum",
            executionMode: "single-agent",
            accessMode: "full-access",
          },
        },
      ],
    },
    policy: {
      maximumBudgetUnits: 100,
      availableConcurrency: 2,
      allowedAccessModes: ["full-access"],
      allowedWorkerEndpointIds: [...THREE_ENDPOINT_IDS],
    },
  };
}

function thirdCatalog(): RuntimeCatalog {
  return Object.freeze({
    runtime: "third-fixture",
    models: Object.freeze([
      Object.freeze({
        id: "third-fixture-model",
        displayName: "Third fixture model",
        effortLevels: Object.freeze(["third-effort"]),
        effortLevelLabels: Object.freeze(["Third effort"]),
      }),
    ]),
    executionModes: Object.freeze(["single-agent"]),
    accessModes: Object.freeze(["full-access"]),
  });
}

function thirdEndpointCatalogs(): readonly DirectSessionProfileEndpointCatalog[] {
  const codex: DirectSessionProfileEndpointCatalog = Object.freeze({
    endpointId: "codex-desktop",
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
    catalog: Object.freeze({
      runtime: "third-proof-codex",
      models: Object.freeze([
        Object.freeze({
          id: "third-proof-codex-model",
          displayName: "Third proof Codex model",
          effortLevels: Object.freeze(["high"]),
          effortLevelLabels: Object.freeze(["High"]),
        }),
      ]),
      executionModes: Object.freeze(["single-agent"]),
      accessModes: Object.freeze(["full-access"]),
    }),
    catalogRevision: "catalog:third-proof-codex",
    executionModeLabels: Object.freeze(["Single agent"]),
    accessModeLabels: Object.freeze(["Full access"]),
  });
  const claude: DirectSessionProfileEndpointCatalog = Object.freeze({
    endpointId: "claude-code-desktop",
    runtimeFamilyLabel: "Claude",
    endpointLabel: "Claude Code desktop",
    catalog: Object.freeze({
      runtime: "third-proof-claude",
      models: Object.freeze([
        Object.freeze({
          id: "third-proof-claude-model",
          displayName: "Third proof Claude model",
          effortLevels: Object.freeze(["high"]),
          effortLevelLabels: Object.freeze(["High"]),
        }),
      ]),
      executionModes: Object.freeze(["single-agent"]),
      accessModes: Object.freeze(["full-access"]),
    }),
    catalogRevision: "catalog:third-proof-claude",
    executionModeLabels: Object.freeze(["Single agent"]),
    accessModeLabels: Object.freeze(["Full access"]),
  });
  const third: DirectSessionProfileEndpointCatalog = Object.freeze({
    endpointId: THIRD_ENDPOINT_ID,
    runtimeFamilyLabel: "Third Fixture",
    endpointLabel: "Third fixture endpoint",
    catalog: thirdCatalog(),
    catalogRevision: "catalog:third-fixture",
    executionModeLabels: Object.freeze(["Single agent"]),
    accessModeLabels: Object.freeze(["Full access"]),
  });
  return Object.freeze([codex, claude, third]);
}

function thirdEndpointDiscovery(): WorkbenchRuntimeEndpointDiscovery {
  return publicRuntimeEndpointDiscovery(
    THREE_ENDPOINT_IDS.map((endpointId) => ({
      endpointId,
      category: "catalog-ready" as const,
    })),
  );
}

function thirdEndpointProfileSnapshot(
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = THREE_ENDPOINT_IDS,
) {
  return createDirectSessionProfileSnapshot({
    endpoints: thirdEndpointCatalogs(),
    endpointDiscovery: thirdEndpointDiscovery(),
    endpointIds,
  });
}

function thirdEndpointAdapterLoader(
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
  catalogOrder: readonly WorkbenchRuntimeEndpointId[] = THREE_ENDPOINT_IDS,
) {
  const snapshot: WorkbenchDirectRuntimeEndpointSnapshot = Object.freeze({
    endpoints: Object.freeze(
      catalogOrder.map((endpointId, index) =>
        Object.freeze({
          endpointId,
          preferenceKey: endpointId,
          runtimeFamilyLabel: index === 2 ? "Third Fixture" : "Fixture",
          endpointLabel: `Fixture endpoint ${index + 1}`,
          catalog: thirdEndpointCatalogs()[index]!.catalog,
          directStart: "supported" as const,
        }),
      ),
    ),
    endpointDiscovery: thirdEndpointDiscovery(),
  });
  const adapter = createWorkbenchRuntimeEndpointAdapter(
    {
      async inspect() {
        return thirdCatalog();
      },
      async start() {
        throw new Error("unused-test-start");
      },
      async resume() {
        throw new Error("unused-test-resume");
      },
    },
    async () => snapshot,
    undefined,
    endpointIds,
  );
  const load = readWorkbenchDirectRuntimeEndpoints(adapter);
  assert.ok(load);
  return load;
}

function thirdEndpointPublicResult() {
  return thirdEndpointProfileSnapshot().publicResult;
}

function selectionAt(
  profile: ReturnType<typeof thirdEndpointProfileSnapshot>["publicResult"]["profile"],
  endpointIndex: number,
  modelIndex: number,
  intensityIndex: number,
) {
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
