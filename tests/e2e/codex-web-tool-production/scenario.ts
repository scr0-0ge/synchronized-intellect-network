import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAdapter } from "../../../src/agent-runtime/codex-adapter.ts";
import {
  codexTransportDiagnosticFilePath,
  createOfficialCodexTransport,
} from "../../../src/agent-runtime/codex/process-transport.ts";
import {
  createWorkbenchBackend,
  type WorkbenchBackend,
} from "../../../src/workbench-shell/backend.ts";

import {
  defaultTimeoutMilliseconds,
  DriverFailure,
  failureCategory,
  FIXED_CODEX_WEB_TOOL_INSTRUCTION,
  type CodexWebToolProductionFailureCategory,
  type CodexWebToolProductionOptions,
  type CodexWebToolProductionResult,
  type DiagnosticCounts,
} from "./contract.ts";
import {
  createEvidence,
  createRetainedDiagnostic,
  diagnosticLifecycleIsCoherent,
  parseEvidence,
  publishFinalEvidence,
  readDiagnosticCursor,
  readNewDiagnosticCounts,
  removePendingEvidence,
  reopenRetainedDiagnostic,
  retainVerifiedDiagnostic,
} from "./evidence.ts";
import {
  assertGuardedRoutineRoot,
  createManifest,
  listStagedRuntimeLeaves,
  pathExists,
  removeGuardedRoutineRoot,
  sameManifest,
} from "./guarded-root.ts";
import {
  correlatedTerminalCommand,
  createTrackedTransportFactory,
  emptyProtocolCounts,
  observeWorkbench,
  parsePublicAnswer,
  stopTrackedTransports,
  type Observation,
  type TransportMetrics,
} from "./tracked-transport.ts";

const defaultEvidencePath = fileURLToPath(
  new URL(
    "../../../.scratch/unified-ai-workbench/evidence/worker-224-f67-web-tool-production.json",
    import.meta.url,
  ),
);

export async function runCodexWebToolProduction(
  options: CodexWebToolProductionOptions = {},
): Promise<CodexWebToolProductionResult> {
  const evidencePath = resolve(options.evidencePath ?? defaultEvidencePath);
  const retainedDiagnosticPath = `${evidencePath}.retained.json`;
  if (
    (await pathExists(evidencePath)) ||
    (await pathExists(retainedDiagnosticPath))
  ) {
    return Object.freeze({
      ok: false,
      category: "evidence-exists",
      rootRetained: false,
      diagnosticArtifact: Object.freeze({ retained: false }),
    });
  }

  const temporaryParentDirectory = resolve(
    options.temporaryParentDirectory ?? tmpdir(),
  );
  const stagingParentDirectory = resolve(
    options.stagingParentDirectory ?? tmpdir(),
  );
  const diagnosticFilePath = resolve(
    options.diagnosticFilePath ?? codexTransportDiagnosticFilePath(),
  );
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
  const metrics: TransportMetrics = {
    created: 0,
    stopped: 0,
    stopFailures: 0,
    active: new Set(),
    protocol: emptyProtocolCounts(),
  };
  let rootDirectory: string | undefined;
  let projectDirectory: string | undefined;
  let backend: WorkbenchBackend | undefined;
  let observation: Observation | undefined;
  let manifestBefore: ReadonlyMap<string, string> | undefined;
  let answer: Readonly<{ title: string; url: string }> | undefined;
  let primaryFailure: CodexWebToolProductionFailureCategory | undefined;
  let cleanupFailure: CodexWebToolProductionFailureCategory | undefined;
  let backendClosed = false;
  let observationDisposed = false;
  let projectManifestUnchanged = false;
  let stagingNewResidue = -1;
  let diagnostics: DiagnosticCounts | undefined;
  let pendingEvidencePath: string | undefined;

  const diagnosticCursor = await readDiagnosticCursor(diagnosticFilePath);
  const stagedRuntimeBefore = await listStagedRuntimeLeaves(
    stagingParentDirectory,
  ).catch(
    () => undefined,
  );

  try {
    rootDirectory = await mkdtemp(
      join(temporaryParentDirectory, "uaw-codex-web-tool-"),
    );
    rootDirectory = await assertGuardedRoutineRoot(
      rootDirectory,
      temporaryParentDirectory,
    );
    options.onTemporaryRootCreated?.(rootDirectory);
    projectDirectory = join(rootDirectory, "Project");
    await mkdir(projectDirectory);
    manifestBefore = await createManifest(projectDirectory);
    if (manifestBefore.size !== 0) throw new DriverFailure("temporary-root");

    const adapter = new CodexAdapter(
      createTrackedTransportFactory(
        metrics,
        options.createTransport ?? createOfficialCodexTransport,
      ),
    );
    backend = await createWorkbenchBackend({
      projectDirectory,
      databasePath: join(rootDirectory, "workbench.sqlite"),
      adapter,
    });
    observation = observeWorkbench(backend, timeoutMilliseconds);
    const initial = await observation.waitFor(() => true);
    if (!initial.ok || initial.view.commands.length !== 0) {
      throw new DriverFailure("initial-view");
    }
    const initialKeys = new Set(
      initial.view.commands.map((command) => command.key),
    );

    const loaded = await backend.loadDirectSessionProfile();
    if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
      throw new DriverFailure("profile-unavailable");
    }
    const selected = loaded.profile.desiredDefault;
    const acceptance = await backend.submitDirectInput({
      kind: "start",
      input: FIXED_CODEX_WEB_TOOL_INSTRUCTION,
      snapshotKey: loaded.profile.snapshotKey,
      endpointKey: selected.endpointKey,
      modelKey: selected.modelKey,
      workIntensityKey: selected.workIntensityKey,
      executionModeKey: selected.executionModeKey,
      accessModeKey: selected.accessModeKey,
    });
    if (!acceptance.ok || acceptance.status !== "accepted") {
      throw new DriverFailure("durable-acceptance");
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
    if (terminalCommand.status !== "completed" || !terminalCommand.session) {
      throw new DriverFailure("terminal-outcome");
    }
    if (metrics.protocol.approvalRequests !== 0) {
      throw new DriverFailure("approval-request");
    }
    if (
      metrics.protocol.webSearchStarted < 1 ||
      metrics.protocol.webSearchCompleted < 1
    ) {
      throw new DriverFailure("web-search-not-observed");
    }
    if (metrics.protocol.turnCompleted < 1) {
      throw new DriverFailure("turn-completion-not-observed");
    }
    const finalMessages = terminalCommand.session.timeline.filter(
      (event) => event.kind === "agent-message",
    );
    const publicTurnCompletions = terminalCommand.session.timeline.filter(
      (event) => event.kind === "turn-completed",
    );
    if (finalMessages.length !== 1 || publicTurnCompletions.length !== 1) {
      throw new DriverFailure("agent-message-invalid");
    }
    answer = parsePublicAnswer(finalMessages[0]!.text);
  } catch (error) {
    primaryFailure = failureCategory(error);
  } finally {
    try {
      observation?.dispose();
      observationDisposed = observation?.disposed === true;
    } catch {
      cleanupFailure ??= "backend-close";
    }
    try {
      await stopTrackedTransports(metrics);
    } catch {
      cleanupFailure ??= "runtime-shutdown";
    }
    if (backend !== undefined) {
      try {
        await backend.close();
        backendClosed = true;
      } catch {
        cleanupFailure ??= "backend-close";
      }
    }
    try {
      await stopTrackedTransports(metrics);
    } catch {
      cleanupFailure ??= "runtime-shutdown";
    }
  }

  if (
    projectDirectory !== undefined &&
    manifestBefore !== undefined
  ) {
    try {
      projectManifestUnchanged = sameManifest(
        manifestBefore,
        await createManifest(projectDirectory),
      );
    } catch {
      projectManifestUnchanged = false;
    }
    if (!projectManifestUnchanged) primaryFailure ??= "project-mutation";
  }

  try {
    diagnostics = await readNewDiagnosticCounts(
      diagnosticFilePath,
      diagnosticCursor,
    );
    if (!diagnosticLifecycleIsCoherent(diagnostics, metrics.created)) {
      cleanupFailure ??= "transport-diagnostics";
    }
  } catch {
    cleanupFailure ??= "transport-diagnostics";
  }

  const stagedRuntimeAfter = await listStagedRuntimeLeaves(
    stagingParentDirectory,
  ).catch(
    () => undefined,
  );
  if (stagedRuntimeBefore !== undefined && stagedRuntimeAfter !== undefined) {
    stagingNewResidue = [...stagedRuntimeAfter].filter(
      (leaf) => !stagedRuntimeBefore.has(leaf),
    ).length;
    if (stagingNewResidue !== 0) cleanupFailure ??= "staging-residue";
  } else {
    cleanupFailure ??= "staging-residue";
  }

  if (
    metrics.created !== 3 ||
    metrics.stopped !== metrics.created ||
    metrics.stopFailures !== 0 ||
    metrics.active.size !== 0
  ) {
    cleanupFailure ??= "runtime-shutdown";
  }
  if (!backendClosed) cleanupFailure ??= "backend-close";
  if (!observationDisposed) cleanupFailure ??= "backend-close";

  const failure = primaryFailure ?? cleanupFailure;
  if (
    failure !== undefined ||
    rootDirectory === undefined ||
    answer === undefined ||
    diagnostics === undefined
  ) {
    return Object.freeze({
      ok: false,
      category: failure ?? "unexpected",
      rootRetained:
        rootDirectory !== undefined && (await pathExists(rootDirectory)),
      diagnosticArtifact: Object.freeze({ retained: false }),
    });
  }

  const evidence = createEvidence(
    metrics,
    diagnostics,
    answer,
    stagingNewResidue,
  );
  const evidenceBytes = Buffer.from(
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  const retainedDiagnostic = createRetainedDiagnostic(evidence);
  const retainedDiagnosticBytes = Buffer.from(
    `${JSON.stringify(retainedDiagnostic, null, 2)}\n`,
    "utf8",
  );

  try {
    pendingEvidencePath = join(
      dirname(evidencePath),
      `.${basename(evidencePath)}.pending-${randomUUID()}`,
    );
    await writeFile(pendingEvidencePath, evidenceBytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const reopenedPending = await readFile(pendingEvidencePath);
    if (!reopenedPending.equals(evidenceBytes)) {
      throw new DriverFailure("evidence-write");
    }
    parseEvidence(reopenedPending.toString("utf8"));
    await writeFile(retainedDiagnosticPath, retainedDiagnosticBytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await reopenRetainedDiagnostic(
      retainedDiagnosticPath,
      retainedDiagnosticBytes,
    );
  } catch {
    await removePendingEvidence(pendingEvidencePath);
    await removePendingEvidence(retainedDiagnosticPath);
    return Object.freeze({
      ok: false,
      category: "evidence-write",
      rootRetained: await pathExists(rootDirectory),
      diagnosticArtifact: Object.freeze({ retained: false }),
    });
  }

  try {
    await removeGuardedRoutineRoot(rootDirectory, temporaryParentDirectory);
    if (await pathExists(rootDirectory)) throw new DriverFailure("root-cleanup");
  } catch {
    await removePendingEvidence(pendingEvidencePath);
    await removePendingEvidence(retainedDiagnosticPath);
    return Object.freeze({
      ok: false,
      category: "root-cleanup",
      rootRetained: await pathExists(rootDirectory),
      diagnosticArtifact: Object.freeze({ retained: false }),
    });
  }

  try {
    await (
      options.publishFinalEvidence ?? publishFinalEvidence
    )(pendingEvidencePath, evidencePath);
    pendingEvidencePath = undefined;
    const reopened = await readFile(evidencePath);
    if (!reopened.equals(evidenceBytes)) {
      throw new DriverFailure("evidence-write");
    }
    const reopenedEvidence = parseEvidence(reopened.toString("utf8"));
    await unlink(retainedDiagnosticPath);
    if (await pathExists(retainedDiagnosticPath)) {
      throw new DriverFailure("evidence-write");
    }
    return Object.freeze({
      ok: true,
      evidence: reopenedEvidence,
      seal: Object.freeze({
        bytes: reopened.byteLength,
        sha256: createHash("sha256").update(reopened).digest("hex"),
      }),
    });
  } catch {
    await removePendingEvidence(pendingEvidencePath);
    await removePendingEvidence(evidencePath);
    const retainedSeal = await retainVerifiedDiagnostic(
      retainedDiagnosticPath,
      retainedDiagnosticBytes,
    );
    return Object.freeze({
      ok: false,
      category: "evidence-write",
      rootRetained: false,
      diagnosticArtifact: retainedSeal,
    });
  }
}
