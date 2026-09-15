import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchBackend,
  type WorkbenchAnnualReportCapability,
} from "../../src/workbench-shell/backend.ts";
import { publicSingleInspectedRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchRuntimeEndpointAdapter } from "../../src/workbench-shell/runtime-endpoint-adapter.ts";

test("annual-report start resolves only the current snapshot selection and admits one job per Project", async () => {
  const base = resolve(process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir());
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "w312-backend-"));
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  let finish: (() => void) | undefined;
  const completion = new Promise<void>((resolveCompletion) => { finish = resolveCompletion; });
  const starts: Array<{ projectDirectory: string; model: string }> = [];
  const activity: number[] = [];
  const capability: WorkbenchAnnualReportCapability = {
    async start(input) {
      starts.push({ projectDirectory: input.projectDirectory, model: input.profile.model });
      return { status: "started", completion };
    },
    async readLatest() { return null; },
    async resolveLatestOutputDirectory() { return null; },
  };
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "profile.json"),
    adapter: new CatalogOnlyAdapter(),
    annualReportCapability: capability,
    onAnnualReportJobActivityChange: (delta) => activity.push(delta),
  });
  try {
    const loaded = await backend.loadDirectSessionProfile();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const endpoint = loaded.profile.endpoints[0]!;
    const model = endpoint.models[0]!;
    const request = {
      snapshotKey: loaded.profile.snapshotKey,
      endpointKey: endpoint.key,
      modelKey: model.key,
      workIntensityKey: model.workIntensities[0]!.key,
      executionModeKey: endpoint.executionModes[0]!.key,
      accessModeKey: endpoint.accessModes[0]!.key,
    };
    assert.deepEqual(await backend.startAnnualReportJob?.(request), { ok: true, status: "started" });
    const duplicate = await backend.startAnnualReportJob?.(request);
    assert.equal(duplicate?.ok, false);
    if (duplicate && !duplicate.ok) assert.equal(duplicate.error.category, "already-running");
    assert.deepEqual(starts, [{ projectDirectory, model: "fake-model" }]);
    assert.deepEqual(activity, [1]);

    finish?.();
    await completion;
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    assert.deepEqual(activity, [1, -1]);

    const refreshed = await backend.loadDirectSessionProfile();
    assert.equal(refreshed.ok, true);
    const stale = await backend.startAnnualReportJob?.(request);
    assert.equal(stale?.ok, false);
    if (stale && !stale.ok) {
      assert.equal(stale.error.category, "invalid-profile-selection");
      assert.match(stale.error.message, /expired/u);
    }
  } finally {
    finish?.();
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inspect-only endpoint explains that its key or runtime cannot start the job", async () => {
  const base = resolve(process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir());
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "w312-inspect-only-"));
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  const delegate = new CatalogOnlyAdapter();
  const adapter = createWorkbenchRuntimeEndpointAdapter(delegate, async () => ({
    endpoints: [{
      endpointId: "codex-api",
      preferenceKey: "codex-api",
      runtimeFamilyLabel: "Codex",
      endpointLabel: "Codex API",
      catalog: await delegate.inspect(),
      desiredDefault: {
        model: "fake-model",
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      directStart: "inspect-only",
    }],
    endpointDiscovery: publicSingleInspectedRuntimeEndpointDiscovery(
      "codex-api",
      "catalog-ready",
    ),
  }));
  let starts = 0;
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "profile.json"),
    adapter,
    annualReportCapability: {
      async start() {
        starts += 1;
        return { status: "started", completion: Promise.resolve() };
      },
      async readLatest() { return null; },
      async resolveLatestOutputDirectory() { return null; },
    },
  });
  try {
    const loaded = await backend.loadDirectSessionProfile();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const endpoint = loaded.profile.endpoints[0]!;
    const model = endpoint.models[0]!;
    const result = await backend.startAnnualReportJob?.({
      snapshotKey: loaded.profile.snapshotKey,
      endpointKey: endpoint.key,
      modelKey: model.key,
      workIntensityKey: model.workIntensities[0]!.key,
      executionModeKey: endpoint.executionModes[0]!.key,
      accessModeKey: endpoint.accessModes[0]!.key,
    });
    assert.equal(result?.ok, false);
    if (result && !result.ok) {
      assert.equal(result.error.category, "invalid-profile-selection");
      assert.match(result.error.message, /key or runtime is unavailable/u);
    }
    assert.equal(starts, 0);
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class CatalogOnlyAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "codex",
      models: [{ id: "fake-model", effortLevels: ["default"] }],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }
  async start(_request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    throw new Error("annual report capability must own the test transport");
  }
  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    throw new Error("not used");
  }
}
