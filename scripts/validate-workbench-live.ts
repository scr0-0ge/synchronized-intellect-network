import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { CodexAdapter } from "../src/agent-runtime/codex-adapter.ts";
import { createOfficialCodexTransport } from "../src/agent-runtime/codex/process-transport.ts";
import type { OfficialRuntimeTransport } from "../src/agent-runtime/codex/transport.ts";
import { createWorkbenchBackend } from "../src/workbench-shell/backend.ts";
import type {
  WorkbenchCommandView,
  WorkbenchProjectResult,
} from "../src/workbench-shell/contract.ts";

const optInName = "UAW_CODEX_LIVE_VALIDATION";
const expectedMarker = "UNIFIED_WORKBENCH_LIVE_OK";
const fixedInstruction =
  "Do not use tools. Do not inspect, create, modify, move, or delete files. " +
  "Respond with exactly UNIFIED_WORKBENCH_LIVE_OK and nothing else.";
const liveDirectoryPattern = /^unified-workbench-live-[A-Za-z0-9_-]+$/u;
const adapterTempPattern = /^codex-adapter-[0-9a-f]{32}$/u;
const validationTimeoutMilliseconds = 180_000;

type LiveFailureCategory =
  | "opt-in-required"
  | "temporary-project"
  | "initial-view"
  | "durable-acceptance"
  | "terminal-outcome"
  | "fixed-profile"
  | "approval-request"
  | "exact-marker"
  | "project-mutation"
  | "runtime-shutdown"
  | "cleanup"
  | "unexpected";

class LiveValidationFailure extends Error {
  readonly category: LiveFailureCategory;

  constructor(category: LiveFailureCategory) {
    super("Live Workbench validation failed.");
    this.name = "LiveValidationFailure";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

type TransportMetrics = {
  created: number;
  stopped: number;
  stopFailures: number;
  readonly active: Set<OfficialRuntimeTransport>;
};

type Observation = {
  readonly results: WorkbenchProjectResult[];
  waitFor(
    predicate: (result: WorkbenchProjectResult) => boolean,
  ): Promise<WorkbenchProjectResult>;
  dispose(): void;
  readonly disposed: boolean;
};

async function main(): Promise<void> {
  if (process.env[optInName] !== "1") {
    emitFailure("opt-in-required", false, false, false);
    return;
  }

  const metrics: TransportMetrics = {
    created: 0,
    stopped: 0,
    stopFailures: 0,
    active: new Set(),
  };
  const adapterTempBefore = await listAdapterTempLeaves().catch(() => null);
  let rootDirectory: string | undefined;
  let projectDirectory: string | undefined;
  let backend: Awaited<ReturnType<typeof createWorkbenchBackend>> | undefined;
  let observation: Observation | undefined;
  let projectManifestBefore: ReadonlyMap<string, string> | undefined;
  let projectUnchanged = false;
  let backendClosed = false;
  let cleanupComplete = false;
  let validated = false;
  let failureCategory: LiveFailureCategory = "unexpected";

  try {
    rootDirectory = await mkdtemp(join(tmpdir(), "unified-workbench-live-"));
    rootDirectory = await assertGuardedLiveDirectory(rootDirectory);
    projectDirectory = join(rootDirectory, "Project");
    await mkdir(projectDirectory);
    projectManifestBefore = await createManifest(projectDirectory);
    if (projectManifestBefore.size !== 0) {
      throw new LiveValidationFailure("temporary-project");
    }

    const adapter = new CodexAdapter(createTrackedTransportFactory(metrics));
    backend = await createWorkbenchBackend({
      projectDirectory,
      databasePath: join(rootDirectory, "workbench.sqlite"),
      adapter,
    });
    observation = observeSanitizedWorkbench(backend);
    const initial = await observation.waitFor(() => true);
    if (!initial.ok || initial.view.commands.length !== 0) {
      throw new LiveValidationFailure("initial-view");
    }

    const initialKeys = new Set(
      initial.view.commands.map((command) => command.key),
    );
    const loadedProfile = await backend.loadDirectSessionProfile();
    if (
      !loadedProfile.ok ||
      loadedProfile.profile.desiredDefault.kind !== "resolved"
    ) {
      throw new LiveValidationFailure("fixed-profile");
    }
    const desiredProfile = loadedProfile.profile.desiredDefault;
    const acceptance = await backend.submitDirectInput({
      kind: "start",
      input: fixedInstruction,
      snapshotKey: loadedProfile.profile.snapshotKey,
      endpointKey: desiredProfile.endpointKey,
      modelKey: desiredProfile.modelKey,
      workIntensityKey: desiredProfile.workIntensityKey,
      executionModeKey: desiredProfile.executionModeKey,
      accessModeKey: desiredProfile.accessModeKey,
    });
    if (!acceptance.ok || acceptance.status !== "accepted") {
      throw new LiveValidationFailure("durable-acceptance");
    }

    const terminalResult = await observation.waitFor((result) => {
      if (!result.ok) return true;
      const newCommands = result.view.commands.filter(
        (command) => !initialKeys.has(command.key),
      );
      return (
        newCommands.length === 1 &&
        ["completed", "failed", "recovery-required"].includes(
          newCommands[0]!.status,
        )
      );
    });
    const terminalCommand = correlatedTerminalCommand(
      terminalResult,
      initialKeys,
    );
    validateTerminalCommand(terminalCommand);

    const approvalRequests = countApprovalRequests(
      observation.results,
      initialKeys,
    );
    if (approvalRequests !== 0) {
      throw new LiveValidationFailure("approval-request");
    }
    const exactMessages =
      terminalCommand.session?.timeline.filter(
        (event) => event.kind === "agent-message" && event.text === expectedMarker,
      ).length ?? 0;
    const allMessages =
      terminalCommand.session?.timeline.filter(
        (event) => event.kind === "agent-message",
      ).length ?? 0;
    if (exactMessages !== 1 || allMessages !== 1) {
      throw new LiveValidationFailure("exact-marker");
    }

    const projectManifestAfter = await createManifest(projectDirectory);
    projectUnchanged = sameManifest(
      projectManifestBefore,
      projectManifestAfter,
    );
    if (!projectUnchanged) {
      throw new LiveValidationFailure("project-mutation");
    }
    validated = true;
  } catch (error) {
    failureCategory =
      error instanceof LiveValidationFailure ? error.category : "unexpected";
  } finally {
    try {
      observation?.dispose();
      await stopTrackedTransports(metrics);
      if (backend !== undefined) {
        await backend.close();
        backendClosed = true;
      }
      await stopTrackedTransports(metrics);
    } catch {
      failureCategory = "runtime-shutdown";
      validated = false;
    }

    if (
      projectDirectory !== undefined &&
      projectManifestBefore !== undefined &&
      !projectUnchanged
    ) {
      try {
        projectUnchanged = sameManifest(
          projectManifestBefore,
          await createManifest(projectDirectory),
        );
      } catch {
        projectUnchanged = false;
      }
      if (!projectUnchanged && failureCategory === "unexpected") {
        failureCategory = "project-mutation";
      }
    }

    if (rootDirectory !== undefined) {
      try {
        await removeGuardedLiveDirectory(rootDirectory);
        cleanupComplete = !(await pathExists(rootDirectory));
      } catch {
        cleanupComplete = false;
      }
    }
  }

  const adapterTempAfter = await listAdapterTempLeaves().catch(() => null);
  const adapterTempClean =
    adapterTempBefore !== null &&
    adapterTempAfter !== null &&
    sameStringSet(adapterTempBefore, adapterTempAfter);
  const runtimeStopped =
    metrics.created === 3 &&
    metrics.stopped === 3 &&
    metrics.stopFailures === 0 &&
    metrics.active.size === 0;
  const lifecycleComplete =
    backendClosed &&
    observation?.disposed === true &&
    runtimeStopped &&
    cleanupComplete &&
    adapterTempClean;

  if (validated && projectUnchanged && lifecycleComplete) {
    console.log(
      JSON.stringify({
        ok: true,
        durableAcceptance: true,
        correlatedCompletion: true,
        fixedProfile: true,
        approvalRequests: 0,
        exactMarker: true,
        projectManifestUnchanged: true,
        backendClosed: true,
        observationDisposed: true,
        runtimeTransports: {
          created: metrics.created,
          stopped: metrics.stopped,
          active: metrics.active.size,
        },
        residue: {
          project: false,
          database: false,
          temp: false,
          process: false,
          listener: false,
        },
      }),
    );
    return;
  }

  if (!lifecycleComplete && failureCategory === "unexpected") {
    failureCategory = cleanupComplete ? "runtime-shutdown" : "cleanup";
  }
  emitFailure(
    failureCategory,
    backendClosed,
    metrics.active.size === 0,
    cleanupComplete && adapterTempClean,
  );
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
          throw new LiveValidationFailure("runtime-shutdown");
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
  const active = [...metrics.active];
  const results = await Promise.allSettled(
    active.map((transport) => transport.stop()),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new LiveValidationFailure("runtime-shutdown");
  }
}

function observeSanitizedWorkbench(
  backend: Awaited<ReturnType<typeof createWorkbenchBackend>>,
): Observation {
  const results: WorkbenchProjectResult[] = [];
  const waiters = new Set<{
    readonly predicate: (result: WorkbenchProjectResult) => boolean;
    readonly resolve: (result: WorkbenchProjectResult) => void;
    readonly reject: (error: LiveValidationFailure) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  let disposed = false;
  const sourceDispose = backend.observeProject((result) => {
    if (disposed) return;
    results.push(result);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(result);
    }
  });

  return {
    results,
    waitFor(predicate) {
      const existing = results.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<WorkbenchProjectResult>((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          reject: rejectWait,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            rejectWait(new LiveValidationFailure("terminal-outcome"));
          }, validationTimeoutMilliseconds),
        };
        waiters.add(waiter);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sourceDispose();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new LiveValidationFailure("terminal-outcome"));
      }
      waiters.clear();
    },
    get disposed() {
      return disposed;
    },
  };
}

function correlatedTerminalCommand(
  result: WorkbenchProjectResult,
  initialKeys: ReadonlySet<string>,
): WorkbenchCommandView {
  if (!result.ok) throw new LiveValidationFailure("terminal-outcome");
  const newCommands = result.view.commands.filter(
    (command) => !initialKeys.has(command.key),
  );
  if (newCommands.length !== 1) {
    throw new LiveValidationFailure("terminal-outcome");
  }
  return newCommands[0]!;
}

function validateTerminalCommand(command: WorkbenchCommandView): void {
  if (command.status !== "completed" || command.session === undefined) {
    throw new LiveValidationFailure("terminal-outcome");
  }
  const profile = command.session.profile;
  if (
    profile.model !== "gpt-5.6-sol" ||
    profile.effortLevel !== "ultra" ||
    profile.executionMode !== "single-agent" ||
    profile.accessMode !== "full-access"
  ) {
    throw new LiveValidationFailure("fixed-profile");
  }
}

function countApprovalRequests(
  results: readonly WorkbenchProjectResult[],
  initialKeys: ReadonlySet<string>,
): number {
  let count = 0;
  for (const result of results) {
    if (!result.ok) continue;
    for (const command of result.view.commands) {
      if (initialKeys.has(command.key)) continue;
      for (const event of command.session?.timeline ?? []) {
        if (event.kind === "failed" && event.category === "approval-required") {
          count += 1;
        }
      }
    }
  }
  return count;
}

async function assertGuardedLiveDirectory(directory: string): Promise<string> {
  const information = await lstat(directory);
  const resolvedDirectory = await realpath(directory);
  const resolvedTemp = await realpath(tmpdir());
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    comparable(dirname(resolvedDirectory)) !== comparable(resolvedTemp) ||
    !liveDirectoryPattern.test(basename(resolvedDirectory))
  ) {
    throw new LiveValidationFailure("temporary-project");
  }
  return resolvedDirectory;
}

async function removeGuardedLiveDirectory(directory: string): Promise<void> {
  const resolvedDirectory = await assertGuardedLiveDirectory(directory);
  await assertNoLinks(resolvedDirectory);
  await rm(resolvedDirectory, { recursive: true, force: false, maxRetries: 2 });
}

async function assertNoLinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new LiveValidationFailure("cleanup");
    if (entry.isDirectory()) await assertNoLinks(join(directory, entry.name));
  }
}

async function createManifest(root: string): Promise<ReadonlyMap<string, string>> {
  const manifest = new Map<string, string>();
  await walkManifest(root, root, manifest);
  return manifest;
}

async function walkManifest(
  root: string,
  directory: string,
  manifest: Map<string, string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const manifestPath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      await walkManifest(root, absolutePath, manifest);
    } else if (entry.isSymbolicLink()) {
      manifest.set(manifestPath, "symbolic-link");
    } else if (entry.isFile()) {
      manifest.set(
        manifestPath,
        createHash("sha256").update(await readFile(absolutePath)).digest("hex"),
      );
    }
  }
}

function sameManifest(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, hash] of left) if (right.get(path) !== hash) return false;
  return true;
}

async function listAdapterTempLeaves(): Promise<ReadonlySet<string>> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && adapterTempPattern.test(entry.name))
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

function emitFailure(
  category: LiveFailureCategory,
  backendClosed: boolean,
  runtimeStopped: boolean,
  cleanupComplete: boolean,
): void {
  console.log(
    JSON.stringify({
      ok: false,
      category,
      backendClosed,
      runtimeStopped,
      cleanupComplete,
    }),
  );
  process.exitCode = 1;
}

await main();
