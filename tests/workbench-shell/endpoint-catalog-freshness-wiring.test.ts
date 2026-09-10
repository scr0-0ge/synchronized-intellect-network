import assert from "node:assert/strict";
import test from "node:test";

import { GLM_STATIC_CATALOG } from "../../src/agent-runtime/claude/glm-catalog.ts";
import {
  discoverRuntimeEndpointComposition,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import type { ResumableAgentRuntimeAdapter } from "../../src/agent-runtime/index.ts";
import {
  installWorkbenchEndpointCatalogFreshnessIpc,
} from "../../src/workbench-shell/electron/endpoint-catalog-freshness-ipc.ts";
import {
  publicEndpointCatalogFreshnessLoaded,
  publicEndpointCatalogFreshnessRefreshed,
  publicEndpointCatalogFreshnessUnavailable,
  WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  type WorkbenchEndpointCatalogFreshnessReport,
} from "../../src/workbench-shell/contract.ts";
import {
  sanitizeWorkbenchEndpointCatalogFreshnessResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

/**
 * WO16 Part 3 wiring: composition merges enrolled models into the static
 * catalog (conservative default tier, append-only), the freshness IPC
 * surface serves sanitized reports, and hostile payloads fail closed.
 */

class StaticCatalogAdapter implements ResumableAgentRuntimeAdapter {
  async inspect() {
    return GLM_STATIC_CATALOG;
  }
  async start(): Promise<never> {
    throw new Error("not under test");
  }
  async resume(): Promise<never> {
    throw new Error("not under test");
  }
}

test("enrolled models join the composed catalog after the curated ones with the single default tier", async () => {
  const discovery = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    glmAdapter: new StaticCatalogAdapter(),
    kimiEnvironment: {},
    deepseekEnvironment: {},
    catalogAugmentation: (endpointId) =>
      endpointId === "glm-coding-plan"
        ? [
            Object.freeze({ id: "glm-6", effortLevels: Object.freeze(["default"]) }),
            // Already curated: deduplicated, never a duplicate row.
            Object.freeze({ id: "glm-5.3[1m]", effortLevels: Object.freeze(["default"]) }),
            // Empty tiers would be a broken enrollment: skipped, not fatal.
            Object.freeze({ id: "glm-broken", effortLevels: Object.freeze([]) }),
          ]
        : [],
  });
  const glmEndpoint = discovery.endpoints.find(
    (endpoint) => endpoint.endpointId === "glm-coding-plan",
  );
  assert.ok(glmEndpoint);
  assert.deepEqual(
    glmEndpoint.catalog.models.map((model) => model.resolvedModel),
    ["glm-5.3[1m]", "glm-5.3-flash[1m]", "glm-6"],
  );
  const enrolled = glmEndpoint.catalog.models[2]!;
  assert.deepEqual(enrolled.effortLevelLabels, ["default"]);
  // The enrolled model is startable through the registration profiles.
  const glmRegistration = discovery.registrations.find(
    (registration) => registration.endpointId === "glm-coding-plan",
  );
  assert.ok(glmRegistration);
  const enrolledProfile = glmRegistration.capabilitySnapshot.profiles.find(
    (profile) => profile.runtimeProfile.model === enrolled.id,
  );
  assert.ok(enrolledProfile);
  assert.equal(enrolledProfile.nativeRuntimeProfile?.effortLevel, "default");
});

test("without augmentation the static catalog is byte-identical (zero-diff default)", async () => {
  const withNone = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    glmAdapter: new StaticCatalogAdapter(),
    kimiEnvironment: {},
    deepseekEnvironment: {},
  });
  const withEmpty = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    glmAdapter: new StaticCatalogAdapter(),
    kimiEnvironment: {},
    deepseekEnvironment: {},
    catalogAugmentation: () => [],
  });
  assert.deepEqual(withNone.endpoints, withEmpty.endpoints);
});

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain {
  readonly handlers = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

class FakeSender {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(): void {}
  removeListener(): void {}
}

class FakeWindow {
  readonly webContents = new FakeSender();
  on(): void {}
  removeListener(): void {}
}

function report(overrides: Partial<WorkbenchEndpointCatalogFreshnessReport> = {}): WorkbenchEndpointCatalogFreshnessReport {
  return Object.freeze({
    endpointId: "glm-coding-plan",
    status: "fresh",
    newModels: Object.freeze([
      Object.freeze({ id: "glm-6", displayName: "GLM 6", createdAt: "2026-09-05T00:00:00Z" }),
    ]),
    enrolledModels: Object.freeze([Object.freeze({ id: "glm-6" })]),
    ...overrides,
  });
}

test("the freshness IPC serves sanitized reports on load and refresh, and fails closed otherwise", async () => {
  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  let refreshCalls = 0;
  const binding = installWorkbenchEndpointCatalogFreshnessIpc({
    ipcMain: ipc,
    window,
    service: {
      async refresh() {
        refreshCalls += 1;
        return [report()];
      },
    },
  });
  assert.ok(ipc.handlers.has(WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL));
  assert.ok(ipc.handlers.has(WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL));

  const event = { sender: window.webContents };
  const loaded = await ipc.handlers.get(
    WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  )!(event);
  assert.deepEqual(loaded, publicEndpointCatalogFreshnessLoaded([report()]));
  const refreshed = await ipc.handlers.get(
    WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  )!(event);
  assert.deepEqual(refreshed, publicEndpointCatalogFreshnessRefreshed([report()]));
  assert.equal(refreshCalls, 2);

  // Foreign senders and failures collapse to the fixed unavailable result.
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL)!({
      sender: new FakeSender(),
    }),
    publicEndpointCatalogFreshnessUnavailable(),
  );
  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("the sanitizer accepts exact reports and fails closed on hostile shapes", () => {
  assert.deepEqual(
    sanitizeWorkbenchEndpointCatalogFreshnessResult(
      publicEndpointCatalogFreshnessLoaded([report()]),
    ),
    publicEndpointCatalogFreshnessLoaded([report()]),
  );
  for (const hostile of [
    null,
    42,
    { ok: true, status: "loaded", reports: "nope" },
    { ok: true, status: "loaded", reports: [{ endpointId: "codex-desktop", status: "fresh", newModels: [], enrolledModels: [] }] },
    { ok: true, status: "loaded", reports: [{ endpointId: "kimi-code", status: "weird", newModels: [], enrolledModels: [] }] },
    { ok: true, status: "loaded", reports: [report({ newModels: [{ id: "has space" }] })] },
    { ok: true, status: "loaded", reports: [report({ newModels: [{ id: "x", extra: true } as unknown as { id: string }] })] },
    { ok: true, status: "loaded", reports: [report({ newModels: [{ id: `x${"\u0000"}` }] })] },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchEndpointCatalogFreshnessResult(hostile),
      publicEndpointCatalogFreshnessUnavailable(),
    );
  }
  // A silent-failure report with zero models is a valid, calm result.
  assert.deepEqual(
    sanitizeWorkbenchEndpointCatalogFreshnessResult(
      publicEndpointCatalogFreshnessLoaded([
        report({ status: "silent-failure", newModels: [], enrolledModels: [] }),
      ]),
    ),
    publicEndpointCatalogFreshnessLoaded([
      report({ status: "silent-failure", newModels: [], enrolledModels: [] }),
    ]),
  );
});
