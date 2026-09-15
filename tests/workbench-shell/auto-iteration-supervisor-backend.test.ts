import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import { publicSingleInspectedRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchRuntimeEndpointAdapter } from "../../src/workbench-shell/runtime-endpoint-adapter.ts";

const turnEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({ kind: "agent-message" as const, text: "FIXTURE_TURN_BODY" }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

const fakeProfile = Object.freeze({
  model: "fake-model",
  effortLevel: "default",
  executionMode: "single-agent",
  accessMode: "full-access",
});

class ScriptedBinding implements ResumableRuntimeBinding {
  readonly profile = fakeProfile;
  readonly opaqueSessionReference: string;
  constructor(opaqueSessionReference: string) {
    this.opaqueSessionReference = opaqueSessionReference;
  }
  async send(_input: RuntimeInput): Promise<void> {}
  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    for (const event of turnEvents) yield structuredClone(event);
  }
}

class ScriptedLoopAdapter implements ResumableAgentRuntimeAdapter {
  starts = 0;
  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "codex",
      models: [{ id: fakeProfile.model, effortLevels: [fakeProfile.effortLevel] }],
      executionModes: [fakeProfile.executionMode],
      accessModes: [fakeProfile.accessMode],
    };
  }
  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.starts += 1;
    return new ScriptedBinding(`native-start-${this.starts}`);
  }
  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return new ScriptedBinding(request.opaqueSessionReference);
  }
}

async function harness() {
  const base = resolve(process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir());
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "w336-backend-"));
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  const adapter = new ScriptedLoopAdapter();
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "profile.json"),
    adapter,
  });
  return { root, backend, adapter };
}

test("auto-iteration supervisor start resolves the current snapshot selection and admits one supervisor per Project", async () => {
  const { root, backend, adapter } = await harness();
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
    assert.deepEqual(await backend.startAutoIterationSupervisor?.(request), { ok: true, status: "started" });
    assert.equal(adapter.starts, 1);

    const overview = backend.autoIteration?.authority.readAutoIterationOverview();
    assert.equal(overview?.supervisor?.generation, 1);
    assert.equal(overview?.supervisor?.status, "active");

    // A second attempt for the same Project is refused before a second
    // Session is ever started -- the check happens before startHostSession,
    // and it takes priority over a merely-stale snapshot: retrying a stale
    // selection could never succeed once the one supervisor slot is taken,
    // so the reason given is the one that actually explains the refusal.
    const duplicate = await backend.startAutoIterationSupervisor?.(request);
    assert.equal(duplicate?.ok, false);
    if (duplicate && !duplicate.ok) assert.equal(duplicate.error.category, "already-active");
    assert.equal(adapter.starts, 1, "a refused duplicate must not start a second Session");

    const refreshed = await backend.loadDirectSessionProfile();
    assert.equal(refreshed.ok, true);
    const staleAfterBound = await backend.startAutoIterationSupervisor?.(request);
    assert.equal(staleAfterBound?.ok, false);
    if (staleAfterBound && !staleAfterBound.ok) {
      assert.equal(staleAfterBound.error.category, "already-active");
    }
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale snapshot selection is refused before any Session starts", async () => {
  const { root, backend, adapter } = await harness();
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
    // Reloading the profile rotates the in-memory snapshot's key before this
    // Project ever has a supervisor, so the stale rejection is reachable on
    // its own and is not masked by "already-active".
    const refreshed = await backend.loadDirectSessionProfile();
    assert.equal(refreshed.ok, true);
    const stale = await backend.startAutoIterationSupervisor?.(request);
    assert.equal(stale?.ok, false);
    if (stale && !stale.ok) {
      assert.equal(stale.error.category, "invalid-profile-selection");
      assert.match(stale.error.message, /expired/u);
    }
    assert.equal(adapter.starts, 0, "a refused stale selection must not start a Session");
    assert.equal(backend.autoIteration?.authority.readAutoIterationOverview().supervisor, null);
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inspect-only endpoint explains that its key or runtime cannot start the supervisor", async () => {
  const base = resolve(process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir());
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "w336-inspect-only-"));
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  const delegate = new ScriptedLoopAdapter();
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
    endpointDiscovery: publicSingleInspectedRuntimeEndpointDiscovery("codex-api", "catalog-ready"),
  }));
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "project.sqlite"),
    preferencePath: join(root, "profile.json"),
    adapter,
  });
  try {
    const loaded = await backend.loadDirectSessionProfile();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const endpoint = loaded.profile.endpoints[0]!;
    const model = endpoint.models[0]!;
    const result = await backend.startAutoIterationSupervisor?.({
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
    assert.equal(delegate.starts, 0);
  } finally {
    await backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});
