import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type {
  AgentRuntimeAdapter,
  RuntimeBinding,
  RuntimeCatalog,
  RuntimeStart,
} from "../src/agent-runtime/index.ts";
import { CodexAdapter } from "../src/agent-runtime/codex-adapter.ts";
import { createOfficialCodexTransport } from "../src/agent-runtime/codex/process-transport.ts";
import type { OfficialRuntimeTransport } from "../src/agent-runtime/codex/transport.ts";
import type { WorkbenchDirectSessionProfileResult } from "../src/workbench-shell/contract.ts";
import { createWorkbenchBackend } from "../src/workbench-shell/backend.ts";

const optInName = "UAW_CODEX_CATALOG_VALIDATION";
const validationDirectoryPattern =
  /^unified-workbench-catalog-[A-Za-z0-9_-]+$/u;
const adapterTempPattern = /^codex-adapter-[0-9a-f]{32}$/u;

type TransportMetrics = {
  created: number;
  stopped: number;
  stopFailures: number;
  readonly active: Set<OfficialRuntimeTransport>;
};

type AdapterMetrics = {
  inspections: number;
  starts: number;
};

type AllowList = {
  durableSave: boolean;
  restartResolution: boolean;
  fixedExecutionMode: boolean;
  fixedAccessMode: boolean;
  agentSessionsStartedZero: boolean;
  inputsSentZero: boolean;
  approvalsRequestedZero: boolean;
  completeShutdown: boolean;
  projectManifestUnchanged: boolean;
  residueZero: boolean;
};

type SelectedDefault = {
  readonly modelLabel: string;
  readonly workIntensityLabel: string;
  readonly snapshotKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
};

async function main(): Promise<void> {
  if (process.env[optInName] !== "1") {
    emitFailure(emptyAllowList());
    return;
  }

  const transportMetrics: TransportMetrics = {
    created: 0,
    stopped: 0,
    stopFailures: 0,
    active: new Set(),
  };
  const adapterMetrics: AdapterMetrics = { inspections: 0, starts: 0 };
  const adapterTempBefore = await listAdapterTempLeaves().catch(() => null);
  const acceptedAdapter = new CodexAdapter(
    createTrackedTransportFactory(transportMetrics),
  );
  const adapter = createTrackedAdapter(acceptedAdapter, adapterMetrics);
  let rootDirectory: string | undefined;
  let backend: Awaited<ReturnType<typeof createWorkbenchBackend>> | undefined;
  let backendCloseCount = 0;
  let durableSave = false;
  let restartResolution = false;
  let fixedExecutionMode = false;
  let fixedAccessMode = false;
  let projectManifestUnchanged = false;
  let validated = false;

  try {
    rootDirectory = await mkdtemp(
      join(tmpdir(), "unified-workbench-catalog-"),
    );
    rootDirectory = await assertGuardedValidationDirectory(rootDirectory);
    const projectDirectory = join(rootDirectory, "Project");
    const databasePath = join(rootDirectory, "project.sqlite");
    const preferencePath = join(rootDirectory, "direct-profile.json");
    await mkdir(projectDirectory);
    const projectManifestBefore = await readdir(projectDirectory);

    backend = await createWorkbenchBackend({
      projectDirectory,
      databasePath,
      preferencePath,
      adapter,
    });
    const firstLoad = await backend.loadDirectSessionProfile();
    const firstDefault = selectedDefault(firstLoad);
    if (firstDefault === undefined) throw new Error("validation-failed");
    const firstFixedExecution =
      firstLoad.ok &&
      firstLoad.profile.executionMode.value === "single-agent" &&
      firstLoad.profile.executionMode.fixed;
    const firstFixedAccess =
      firstLoad.ok &&
      firstLoad.profile.accessMode.value === "full-access" &&
      firstLoad.profile.accessMode.fixed &&
      firstLoad.profile.accessMode.independent;
    const save = await backend.useDirectSessionProfileAsDefault({
      snapshotKey: firstDefault.snapshotKey,
      modelKey: firstDefault.modelKey,
      workIntensityKey: firstDefault.workIntensityKey,
    });
    durableSave = save.ok && adapterMetrics.starts === 0;
    await backend.close();
    backend = undefined;
    backendCloseCount += 1;

    backend = await createWorkbenchBackend({
      projectDirectory,
      databasePath,
      preferencePath,
      adapter,
    });
    const restartedLoad = await backend.loadDirectSessionProfile();
    const restartedDefault = selectedDefault(restartedLoad);
    if (restartedDefault === undefined) throw new Error("validation-failed");
    restartResolution =
      restartedDefault.modelLabel === firstDefault.modelLabel &&
      restartedDefault.workIntensityLabel ===
        firstDefault.workIntensityLabel &&
      restartedDefault.snapshotKey !== firstDefault.snapshotKey &&
      restartedDefault.modelKey !== firstDefault.modelKey &&
      restartedDefault.workIntensityKey !== firstDefault.workIntensityKey;
    fixedExecutionMode =
      firstFixedExecution &&
      restartedLoad.ok &&
      restartedLoad.profile.executionMode.value === "single-agent" &&
      restartedLoad.profile.executionMode.fixed;
    fixedAccessMode =
      firstFixedAccess &&
      restartedLoad.ok &&
      restartedLoad.profile.accessMode.value === "full-access" &&
      restartedLoad.profile.accessMode.fixed &&
      restartedLoad.profile.accessMode.independent;
    await backend.close();
    backend = undefined;
    backendCloseCount += 1;

    const projectManifestAfter = await readdir(projectDirectory);
    projectManifestUnchanged =
      projectManifestBefore.length === 0 &&
      projectManifestAfter.length === 0;
    validated =
      durableSave &&
      restartResolution &&
      fixedExecutionMode &&
      fixedAccessMode &&
      projectManifestUnchanged &&
      adapterMetrics.inspections === 2 &&
      adapterMetrics.starts === 0;
  } catch {
    validated = false;
  } finally {
    try {
      if (backend !== undefined) {
        await backend.close();
        backendCloseCount += 1;
      }
      await stopTrackedTransports(transportMetrics);
    } catch {
      validated = false;
    }
    if (rootDirectory !== undefined) {
      try {
        await removeGuardedValidationDirectory(rootDirectory);
      } catch {
        validated = false;
      }
    }
  }

  const adapterTempAfter = await listAdapterTempLeaves().catch(() => null);
  const completeShutdown =
    backendCloseCount === 2 &&
    transportMetrics.created === 2 &&
    transportMetrics.stopped === 2 &&
    transportMetrics.stopFailures === 0 &&
    transportMetrics.active.size === 0;
  const residueZero =
    rootDirectory !== undefined &&
    !(await pathExists(rootDirectory)) &&
    adapterTempBefore !== null &&
    adapterTempAfter !== null &&
    sameStringSet(adapterTempBefore, adapterTempAfter) &&
    completeShutdown;
  const allowList: AllowList = {
    durableSave,
    restartResolution,
    fixedExecutionMode,
    fixedAccessMode,
    agentSessionsStartedZero: adapterMetrics.starts === 0,
    inputsSentZero: adapterMetrics.starts === 0,
    approvalsRequestedZero: adapterMetrics.starts === 0,
    completeShutdown,
    projectManifestUnchanged,
    residueZero,
  };

  if (validated && Object.values(allowList).every(Boolean)) {
    emitSuccess();
    return;
  }
  emitFailure(allowList);
}

function createTrackedAdapter(
  adapter: AgentRuntimeAdapter,
  metrics: AdapterMetrics,
): AgentRuntimeAdapter {
  return Object.freeze({
    async inspect(projectDirectory: string): Promise<RuntimeCatalog> {
      metrics.inspections += 1;
      return adapter.inspect(projectDirectory);
    },
    async start(request: RuntimeStart): Promise<RuntimeBinding> {
      metrics.starts += 1;
      return adapter.start(request);
    },
  });
}

function selectedDefault(
  result: WorkbenchDirectSessionProfileResult,
): SelectedDefault | undefined {
  if (!result.ok || result.profile.desiredDefault.kind !== "resolved") {
    return undefined;
  }
  const desired = result.profile.desiredDefault;
  const model = result.profile.models.find(
    (candidate) => candidate.key === desired.modelKey,
  );
  const workIntensity = model?.workIntensities.find(
    (candidate) => candidate.key === desired.workIntensityKey,
  );
  if (model === undefined || workIntensity === undefined) return undefined;
  return Object.freeze({
    modelLabel: model.label,
    workIntensityLabel: workIntensity.label,
    snapshotKey: result.profile.snapshotKey,
    modelKey: model.key,
    workIntensityKey: workIntensity.key,
  });
}

function createTrackedTransportFactory(
  metrics: TransportMetrics,
): () => Promise<OfficialRuntimeTransport> {
  return async () => {
    const transport = await createOfficialCodexTransport();
    metrics.created += 1;
    let stopped = false;
    const tracked: OfficialRuntimeTransport = {
      send: (line) => transport.send(line),
      receive: () => transport.receive(),
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        try {
          await transport.stop();
        } catch {
          metrics.stopFailures += 1;
          throw new Error("validation-failed");
        } finally {
          metrics.stopped += 1;
          metrics.active.delete(tracked);
        }
      },
    };
    metrics.active.add(tracked);
    return tracked;
  };
}

async function stopTrackedTransports(metrics: TransportMetrics): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...metrics.active].map((transport) => transport.stop()),
  );
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    throw new Error("validation-failed");
  }
}

async function assertGuardedValidationDirectory(
  directory: string,
): Promise<string> {
  const information = await lstat(directory);
  const resolvedDirectory = await realpath(directory);
  const resolvedTemp = await realpath(tmpdir());
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    comparable(dirname(resolvedDirectory)) !== comparable(resolvedTemp) ||
    !validationDirectoryPattern.test(basename(resolvedDirectory))
  ) {
    throw new Error("validation-failed");
  }
  return resolvedDirectory;
}

async function removeGuardedValidationDirectory(
  directory: string,
): Promise<void> {
  const resolved = await assertGuardedValidationDirectory(directory);
  await assertNoLinks(resolved);
  await rm(resolved, { recursive: true, force: false, maxRetries: 2 });
}

async function assertNoLinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("validation-failed");
    if (entry.isDirectory()) await assertNoLinks(join(directory, entry.name));
  }
}

async function listAdapterTempLeaves(): Promise<ReadonlySet<string>> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter(
        (entry) => entry.isDirectory() && adapterTempPattern.test(entry.name),
      )
      .map((entry) => entry.name),
  );
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function comparable(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function emptyAllowList(): AllowList {
  return {
    durableSave: false,
    restartResolution: false,
    fixedExecutionMode: false,
    fixedAccessMode: false,
    agentSessionsStartedZero: false,
    inputsSentZero: false,
    approvalsRequestedZero: false,
    completeShutdown: false,
    projectManifestUnchanged: false,
    residueZero: false,
  };
}

function emitSuccess(): void {
  console.log(
    JSON.stringify({
      ok: true,
      durableSave: true,
      restartResolution: true,
      fixedExecutionMode: true,
      fixedAccessMode: true,
      agentSessionsStartedZero: true,
      inputsSentZero: true,
      approvalsRequestedZero: true,
      completeShutdown: true,
      projectManifestUnchanged: true,
      residueZero: true,
    }),
  );
}

function emitFailure(allowList: AllowList): void {
  console.log(JSON.stringify({ ok: false, ...allowList }));
  process.exitCode = 1;
}

await main();
