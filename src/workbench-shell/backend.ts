import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentRuntimeAdapter,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeModel,
  RuntimeStart,
  SessionProfile,
} from "../agent-runtime/index.ts";
import { RuntimeAdapterError } from "../agent-runtime/index.ts";
import type { WorkbenchUserInputBridge, WorkbenchUserInputReadRequest, WorkbenchUserInputResponse, WorkbenchUserInputResult, WorkbenchUserInputResponseResult } from "./contract.ts";
import { reconstructUserInputRead, reconstructUserInputResponse, sanitizeUserInputResult } from "./user-input-sanitizer.ts";
import {
  CoordinatorError,
  createWorkbenchCoordinator,
  createSessionContinuationPlan,
  parseSessionContinuationPlan,
  sessionContinuationStepInput,
} from "../coordinator/index.ts";
import type {
  AutoIterationProjectAuthority,
  Cursor,
  DurableRuntimeEndpointId,
  PendingAutoIterationOutboxEntry,
  ProjectChannel,
  ProjectRuntimeResumeIdentity,
  ProjectSnapshot,
  ProjectTurnActivity,
  ProjectUpdate,
} from "../coordinator/index.ts";
import type { WorkLedgerAuthGenerationModule } from "../coordinator/index.ts";
import type {
  AutoIterationCoordinatorPort,
  ArtifactReference,
  ContextUsageObservation,
  HandoffIdempotencyKey,
  HostBoundToolActor,
  IntegrationCandidate,
  PublishOutcome,
  ReviewerToolRequest,
  ReviewerToolResponse,
  SessionCreationParameters,
  SubmitHandoffRequest,
  SupervisorToolRequest,
  SupervisorToolResponse,
  WorkerToolRequest,
  WorkerToolResponse,
} from "../coordinator/auto-iteration/contract.ts";
import { createExecutionJobRunner } from "../coordinator/auto-iteration/execution-job.ts";
import type { ApprovedGate } from "../coordinator/auto-iteration/execution-job.ts";
import {
  createIntegrationCandidateBuilder,
  INTEGRATION_TARGET_REF,
} from "../coordinator/auto-iteration/integration-candidate.ts";
import { createIntegrationRunner } from "../coordinator/auto-iteration/integration-runner.ts";
import {
  createWorkspaceManager,
  runGitCommand,
} from "../coordinator/auto-iteration/workspace-manager.ts";
import {
  setCapabilityProbeSinks,
} from "../coordinator/auto-iteration/capability-probe.ts";
import { resolveSessionProfile } from "../session-profile/index.ts";
import { createSessionAuthority } from "../coordinator/auto-iteration/session-authority.ts";
import type { SessionAuthority } from "../coordinator/auto-iteration/session-authority.ts";
import { createSessionTurnArbiter } from "../coordinator/auto-iteration/session-arbiter.ts";
import type { SessionTurnArbiter } from "../coordinator/auto-iteration/session-arbiter.ts";
import {
  createAutoIterationMcpServer,
  type AutoIterationMcpServer,
} from "./auto-iteration-mcp-server.ts";
import {
  createAutoIterationBindingRegistry,
  type AutoIterationBindingRegistry,
} from "./auto-iteration-mcp-host.ts";
import { WORKBENCH_RUNTIME_ENDPOINT_IDS } from "./runtime-endpoint-identity.ts";
import {
  createDirectSessionProfilePreferenceStore,
  LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY,
  type DirectSessionProfilePreferenceSnapshot,
  type DirectSessionProfilePreferenceStore,
} from "./preference-store.ts";
import {
  isValidWorkbenchDirectInput,
  publicInvalidProfileSelection,
  publicInvalidProfileDefaultSelection,
  publicInvalidSubmission,
  publicInterruptRequested,
  publicInterruptUnavailable,
  publicInvalidInterrupt,
  publicInvalidSteer,
  publicContinuationProfileUnavailable,
  publicContinuationModelUnavailable,
  publicProfileUnavailable,
  publicRuntimeEndpointDiscovery,
  publicRuntimeNotLocated,
  publicSingleInspectedRuntimeEndpointDiscovery,
  publicUniformRuntimeEndpointDiscovery,
  publicProfileDefaultSaved,
  publicPreferenceUnavailable,
  publicSubmissionAccepted,
  publicSteerAccepted,
  publicSteerUnavailable,
  publicRuntimeStartUnsupported,
  publicUnavailableSubmission,
  publicContinuationUnavailable,
  type WorkbenchAnyDirectSessionProfileResult,
  type WorkbenchAnnualReportJobRequest,
  type WorkbenchAnnualReportSnapshot,
  type WorkbenchAnnualReportStartResult,
  type WorkbenchStartAutoIterationSupervisorRequest,
  type WorkbenchStartAutoIterationSupervisorResult,
  type WorkbenchDirectInputRequest,
  type WorkbenchBackendDirectSessionProfile,
  type WorkbenchBackendContinuationDirectSessionProfile,
  type WorkbenchBackendReplacementDirectSessionProfile,
  type WorkbenchCatalogDefaultProfileResult,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchDirectSessionProfileResultFor,
  type WorkbenchProjectListener,
  type WorkbenchInterruptRequest,
  type WorkbenchInterruptResult,
  type WorkbenchSteerRequest,
  type WorkbenchSteerResult,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointDiscoveryCategory,
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchReplacementPrefill,
  type WorkbenchReplacementSessionProfileResult,
  type WorkbenchContinuationPrefill,
  type WorkbenchContinuationSessionProfileResult,
  type WorkbenchSubmissionResult,
} from "./contract.ts";
import {
  createDirectSessionProfileSnapshot,
  type DirectSessionProfileCatalog,
  type DirectSessionProfileSnapshot,
  type WorkIntensityExecutionModeCoupling,
} from "./direct-session-profile-snapshot.ts";
import {
  createWorkbenchLiveView,
  type WorkbenchLiveView,
} from "./live-view.ts";
import {
  reconstructWorkbenchDirectInputRequest,
  reconstructWorkbenchDirectSessionProfileDefaultRequest,
  reconstructWorkbenchDirectSessionProfileLoadRequest,
  reconstructWorkbenchInterruptRequest,
  reconstructWorkbenchSteerRequest,
  reconstructWorkbenchSessionMetadataMutationRequest,
  reconstructWorkbenchSessionRemovalRequest,
} from "./result-sanitizer.ts";
import {
  readWorkbenchDirectRuntimeEndpoints,
  readWorkbenchRuntimeResumeIdentityResolver,
  type WorkbenchDirectRuntimeEndpointCatalog,
  type WorkbenchDirectRuntimeEndpointSnapshot,
} from "./runtime-endpoint-adapter.ts";

export interface WorkbenchBackend extends Partial<WorkbenchUserInputBridge> {
  /**
   * Trusted host seam for the auto-iteration first loop: the Project's
   * authority, the per-Session MCP tool servers, and the outbox drain. This
   * never crosses renderer IPC; the renderer sees the sanitized projection.
   */
  readonly autoIteration?: WorkbenchAutoIterationService;
  observeProject(listener: WorkbenchProjectListener): () => void;
  readTurnActivity(): ProjectTurnActivity;
  interruptActiveTurn?(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult>;
  steerActiveTurn?(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult>;
  /** Trusted host seam. Renderer-owned opaque keys must resolve before this call. */
  removeSession?(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult>;
  mutateSessionMetadata?(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult>;
  loadDirectSessionProfile(): Promise<WorkbenchCatalogDefaultProfileResult>;
  loadDirectSessionProfile<
    Request extends WorkbenchDirectSessionProfileLoadRequest,
  >(
    request: Request,
  ): Promise<WorkbenchDirectSessionProfileResultFor<Request>>;
  useDirectSessionProfileAsDefault(
    request:
      | WorkbenchDirectSessionProfileDefaultRequest
      | WorkbenchBackendLegacyDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult>;
  submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult>;
  startAnnualReportJob?(
    request: Omit<WorkbenchAnnualReportJobRequest, "projectId">,
  ): Promise<WorkbenchAnnualReportStartResult>;
  readAnnualReportJob?(): Promise<WorkbenchAnnualReportSnapshot | null>;
  resolveAnnualReportOutputDirectory?(): Promise<string | null>;
  startAutoIterationSupervisor?(
    request: Omit<WorkbenchStartAutoIterationSupervisorRequest, "projectId">,
  ): Promise<WorkbenchStartAutoIterationSupervisorResult>;
  close(): Promise<void>;
}

export interface WorkbenchAnnualReportCapability {
  start(input: Readonly<{
    projectDirectory: string;
    adapter: AgentRuntimeAdapter;
    profile: SessionProfile;
  }>): Promise<
    | Readonly<{ status: "no-pdfs" }>
    | Readonly<{ status: "started"; completion: Promise<void> }>
  >;
  readLatest(projectDirectory: string): Promise<WorkbenchAnnualReportSnapshot | null>;
  resolveLatestOutputDirectory(projectDirectory: string): Promise<string | null>;
}

/** Backend-only compatibility for the protected headless catalog validator. */
export interface WorkbenchBackendLegacyDefaultRequest {
  readonly snapshotKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
}

const initialCodexProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});
type CatalogSnapshot = {
  readonly value: DirectSessionProfileSnapshot;
  readonly compatibilityRuntime: string;
  readonly endpointPreferenceKeys: readonly string[];
  readonly directStartByEndpoint: readonly ("supported" | "inspect-only")[];
};

interface ActiveContinuationCapability {
  readonly selectionKey: string;
  readonly prefill: WorkbenchContinuationPrefill;
}

export interface WorkbenchDirectEndpointPresentation {
  readonly preferenceKey: string;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
}

const productionEndpointPresentation: WorkbenchDirectEndpointPresentation =
  Object.freeze({
    preferenceKey: LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
  });

const noLaunchAdapter: ResumableAgentRuntimeAdapter = Object.freeze({
  async inspect() {
    throw new RuntimeAdapterError("runtime-unavailable");
  },
  async start() {
    throw new RuntimeAdapterError("runtime-unavailable");
  },
  async resume() {
    throw new RuntimeAdapterError("runtime-unavailable");
  },
});

/**
 * The bootstrap entry the bridge hands to CLIs: the file sitting beside this
 * module's compiled output (`main.js` → `auto-iteration-mcp-bootstrap.js`).
 * In the source tree that is the TypeScript entry itself (Node's own type
 * stripping runs it); in the packaged app it is only readable when shipped
 * outside the asar — an unusable entry degrades visibly through the
 * registry's diagnostics instead of blocking Sessions.
 */
function autoIterationBootstrapEntry(): string {
  return fileURLToPath(
    new URL("./auto-iteration-mcp-bootstrap.js", import.meta.url),
  );
}

/**
 * The single v1 supervisor role (issue #8 §3: "one supervisor role"). A
 * second `startAutoIterationSupervisor` call for the same Project always
 * finds this slot already bound and is refused before a Session starts.
 */
const AUTO_ITERATION_SUPERVISOR_ROLE_SLOT_ID = "project-supervisor";

const AUTO_ITERATION_INITIAL_SUPERVISOR_OPENING_INPUT =
  "Workbench auto-iteration: you are the supervisor for this Project. Wait " +
  "for the objective, then use the submit_work_order tool to dispatch it.";

export async function createWorkbenchBackend(options: {
  readonly projectDirectory: string;
  readonly databasePath: string;
  readonly packagedBootstrap?: boolean;
  readonly adapter?: AgentRuntimeAdapter;
  readonly preferencePath?: string;
  readonly preferenceStore?: DirectSessionProfilePreferenceStore;
  readonly directEndpointPresentation?: WorkbenchDirectEndpointPresentation;
  readonly authGeneration?: WorkLedgerAuthGenerationModule;
  readonly annualReportCapability?: WorkbenchAnnualReportCapability;
  readonly onAnnualReportJobActivityChange?: (delta: 1 | -1) => void;
  /** Issue #8 M4: overridable for tests; see `AutoIterationServiceOptions`. */
  readonly scanWorkspaceProcesses?: (
    workspacePath: string,
  ) => Promise<readonly WorkspaceProcessRecord[]>;
}): Promise<WorkbenchBackend> {
  // w300: the Workbench MCP binding registry retains each pipe while the
  // auto-iteration service carries its bootstrap spec on the exact command
  // object submitted to the coordinator. Ordinary commands omit the field.
  const serverLookup: {
    serverForSession(sessionId: string): AutoIterationMcpServer;
  } = {
    serverForSession: () => {
      throw new Error("auto-iteration-server-lookup-unbound");
    },
  };
  const workbenchBindings = createAutoIterationBindingRegistry({
    bootstrapEntry: autoIterationBootstrapEntry(),
    serverForSession: (sessionId) => serverLookup.serverForSession(sessionId),
    onDiagnostic: (diagnostic) => {
      console.warn(
        "[auto-iteration-mcp]",
        JSON.stringify(diagnostic),
      );
    },
  });
  const adapter = toResumableAdapter(options.adapter ?? noLaunchAdapter);
  const preferenceStore =
    options.preferenceStore ??
    createDirectSessionProfilePreferenceStore({
      filePath:
        options.preferencePath ??
        join(dirname(options.databasePath), "direct-session-profile-preferences.json"),
    });
  const coordinator = createWorkbenchCoordinator({
    databasePath: options.databasePath,
    adapter,
    authGeneration: options.authGeneration,
    // The shell admits its full registered endpoint roster (including the
    // api-key endpoints GLM/Kimi/DeepSeek); the coordinator's own default
    // stays narrower.
    endpointIds: [...WORKBENCH_RUNTIME_ENDPOINT_IDS],
  });
  const channel = await coordinator.openProject(options.projectDirectory);
  try {
    const liveView = createWorkbenchLiveView({
      channel,
      projectDirectory: options.projectDirectory,
      ...(options.packagedBootstrap === true ? { packagedBootstrap: true } : {}),
    });
    return createBackend(
      liveView,
      channel,
      adapter,
      options.projectDirectory,
      preferenceStore,
      options.directEndpointPresentation ?? productionEndpointPresentation,
      workbenchBindings,
      serverLookup,
      join(
        options.preferencePath === undefined
          ? dirname(options.databasePath)
          : dirname(options.preferencePath),
        "attempts",
        basename(options.databasePath, extname(options.databasePath)),
      ),
      options.annualReportCapability,
      options.onAnnualReportJobActivityChange,
      options.scanWorkspaceProcesses,
    );
  } catch (error) {
    // `openProject` has already opened -- and created -- the SQLite ledger for
    // this directory, and the caller only ever sees the rejection, so nothing
    // downstream holds the channel to close it. Every construction step after
    // this point can still throw: `createWorkbenchLiveView` does exactly that
    // for a directory whose label cannot be derived (a drive root, F-w187 /
    // public issue #5), and each failed attempt used to leave one more open
    // handle on the ledger file for the lifetime of the process.
    workbenchBindings.close();
    await channel.close().catch(() => undefined);
    throw error;
  }
}

function toResumableAdapter(
  adapter: AgentRuntimeAdapter,
): ResumableAgentRuntimeAdapter {
  if (
    "resume" in adapter &&
    typeof (adapter as { readonly resume?: unknown }).resume === "function"
  ) {
    return adapter as ResumableAgentRuntimeAdapter;
  }
  return Object.freeze({
    inspect: (projectDirectory: string) => adapter.inspect(projectDirectory),
    start: async (
      request: RuntimeStart,
    ): Promise<ResumableRuntimeBinding> => {
      const binding = await adapter.start(request);
      if (
        !("opaqueSessionReference" in binding) ||
        typeof binding.opaqueSessionReference !== "string"
      ) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      return binding as ResumableRuntimeBinding;
    },
    async resume() {
      throw new RuntimeAdapterError("runtime-unavailable");
    },
  });
}

export interface WorkbenchAutoIterationService {
  readonly authority: AutoIterationProjectAuthority;
  /** Appoints the first supervisor tenure for a host-known product Session. */
  bindInitialSupervisor(request: {
    readonly roleSlotId: string;
    readonly sessionId: string;
  }): Promise<{ readonly roleSlotId: string; readonly tenureId: string; readonly generation: number }>;
  /**
   * Starts a product Session through the same production seam the outbox uses
   * for workers and successors (inspect → resolve → durable command). Returns
   * the new Session id, or undefined when the launch could not be accepted.
   */
  startHostSession(request: {
    readonly endpointId: DurableRuntimeEndpointId;
    readonly profile: SessionProfile;
    readonly input: string;
  }): Promise<string | undefined>;
  /** The same server a CLI bootstrap process would reach through the local bridge. */
  mcpServerForSession(sessionId: string): AutoIterationMcpServer;
  /**
   * Issue #8 M3: the Session id of the independent Review Attempt started
   * for one Handoff, once known. Host-runtime, in-memory, best-effort (no
   * durable review-session-binding record); undefined before the Session
   * starts or after a Project reopen loses the in-memory map.
   */
  reviewSessionIdFor(handoff: HandoffIdempotencyKey): string | undefined;
  /** Live Workbench MCP bridge registry (w300); guards observe its size. */
  readonly workbenchBindings: AutoIterationBindingRegistry;
  /** Idempotent pass over the durable outbox; safe to call at any turn boundary. */
  drainPendingOutbox(): Promise<void>;
  close(): Promise<void>;
}

interface AutoIterationServiceOptions {
  readonly channel: ProjectChannel & {
    readonly autoIteration: AutoIterationProjectAuthority;
  };
  readonly adapter: ResumableAgentRuntimeAdapter;
  readonly projectDirectory: string;
  readonly managedWorkspaceRoot: string;
  /**
   * Workbench MCP bridge bindings (w300). The service retains each host pipe,
   * attaches its spec to the exact coordinator command, and resolves the
   * per-Session server through `serverForSession` at association time.
   */
  readonly workbenchBindings: AutoIterationBindingRegistry;
  /** Late-bound per-Session server lookup the registry serves through. */
  readonly serverLookup: {
    serverForSession(sessionId: string): AutoIterationMcpServer;
  };
  /**
   * Issue #8 M4 (w349 unsettled): overridable so tests can exercise the
   * red/green path with a fake list instead of a real Win32_Process scan.
   * Defaults to `processesReferencingWorkspace`.
   */
  readonly scanWorkspaceProcesses?: (
    workspacePath: string,
  ) => Promise<readonly WorkspaceProcessRecord[]>;
}

export interface WorkspaceProcessRecord {
  readonly pid: number;
  readonly commandLine: string;
}

/**
 * Issue #8 M4: a worker Session backgrounding a process (e.g. a test suite
 * left running) leaves no host job record, so `captureHandoffArtifacts`'s
 * existing job-status check cannot see it. Windows exposes no per-PID
 * working-directory query, and the worker Session's own OS process id is
 * not part of any interface this host layer can reach (agent-runtime keeps
 * native process identity to itself) — so this is a best-effort command-line
 * match against the workspace's real path, using the same read-only
 * Win32_Process primitive the launcher test's process-tree helper walks by
 * PID, rather than a PID-tree walk this layer cannot root. A background
 * process invoked without that path appearing in its argv is not caught.
 * Never signals or terminates a process; a scan failure fails open (treated
 * as no survivors) so an environment without PowerShell cannot wedge every
 * handoff shut.
 */
async function processesReferencingWorkspace(
  workspacePath: string,
): Promise<readonly WorkspaceProcessRecord[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Env:UAW_AUTO_ITERATION_WORKSPACE_MATCH) }); " +
    "[Console]::Out.Write((ConvertTo-Json -Compress @($items | ForEach-Object { " +
    "@{ pid = [int64]$_.ProcessId; commandLine = [string]$_.CommandLine } })))";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, UAW_AUTO_ITERATION_WORKSPACE_MATCH: workspacePath },
        },
      );
    } catch {
      resolveResult([]);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (records: readonly WorkspaceProcessRecord[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(records);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish([]));
    child.once("close", (code) => {
      if (code !== 0 || stdout.trim().length === 0) {
        finish([]);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout.trim());
        const list = Array.isArray(parsed) ? parsed : [parsed];
        finish(
          list
            .filter(
              (entry): entry is { pid: unknown; commandLine: unknown } =>
                typeof entry === "object" && entry !== null,
            )
            .map((entry) => ({
              pid: Number(entry.pid),
              commandLine: String(entry.commandLine ?? ""),
            }))
            .filter((entry) => Number.isFinite(entry.pid)),
        );
      } catch {
        finish([]);
      }
    });
  });
}

/**
 * Issue #8 M4 backpressure: at most this many handoff events are actually
 * included in one wakeup's parent input; the rest wait for the next wakeup
 * instead of being silently sealed as delivered without ever being shown
 * (w349 gap: the summary text already capped its listing at 8, but
 * `markHandoffIncluded` used to run over the full, unbounded list).
 */
export const WAKEUP_HANDOFF_BATCH_LIMIT = 8;

class AutoIterationJobStillRunningError extends Error {
  constructor(jobId: string) {
    super(`execution job still running: ${jobId}`);
    this.name = "AutoIterationJobStillRunningError";
  }
}

function createBackendAutoIterationService(
  options: AutoIterationServiceOptions,
): WorkbenchAutoIterationService {
  const { channel, adapter, projectDirectory } = options;
  const authority: AutoIterationProjectAuthority = channel.autoIteration;
  const sessionAuthority: SessionAuthority = createSessionAuthority();
  // Issue #8 M2: bridges `startHostSession` to the `bindInitialSupervisor`
  // call the same caller makes moments later, so the durable tenure record
  // (not an in-memory table that a reopen would lose) ends up holding the
  // Session's own creation parameters. Entries live only between the two
  // calls; once bound, the ledger row is the source of truth.
  const pendingHostSessionParameters = new Map<string, SessionCreationParameters>();
  const arbiter: SessionTurnArbiter = createSessionTurnArbiter();
  const workspaceManager = createWorkspaceManager({
    repositoryPath: projectDirectory,
    managedRoot: options.managedWorkspaceRoot,
  });
  const executionJobs = createExecutionJobRunner({
    recordsRoot: join(options.managedWorkspaceRoot, "jobs"),
  });
  const candidateBuilder = createIntegrationCandidateBuilder({
    repositoryPath: projectDirectory,
    workspaceManager,
    jobs: executionJobs,
  });
  const integrationRunner = createIntegrationRunner({
    workspaceManager,
    jobs: executionJobs,
  });
  const scanWorkspaceProcesses =
    options.scanWorkspaceProcesses ?? processesReferencingWorkspace;
  // Gate plan for gateDefinitionVersion "issue-8-m3-v1" (frozen into every
  // candidate w337 records). The product WorkOrder contract carries no
  // per-order gate selection yet, so the default is build + typecheck; the
  // full test suite is deliberately never a default gate.
  const integrationGatePlan: readonly ApprovedGate[] = ["build", "typecheck"];
  const integrationRemoteName = INTEGRATION_TARGET_REF.split("/")[0]!;
  const integrationLocalBranch = INTEGRATION_TARGET_REF.slice(integrationRemoteName.length + 1);
  const attemptStarts = new Set<string>();
  // Issue #8 M3: in-process reentrancy guard, mirroring `attemptStarts`.
  // Cross-reopen duplicate starts are bounded by `channel.act`'s own
  // idempotency key (`auto-review-<handoff>`) reusing the same Session.
  const reviewSessionStarts = new Set<string>();
  /** Issue #8 M3: in-memory only; see `reviewSessionIdFor` on the public service. */
  const reviewSessionIdsByHandoff = new Map<string, string>();
  const mcpServersBySession = new Map<string, AutoIterationMcpServer>();
  let closed = false;
  // w338 probe wiring: host-known creation parameters of the Sessions this
  // service started. The context-rotation trigger mirrors the incumbent
  // supervisor's own endpoint/profile for its successor — the host never
  // invents session parameters, so without a recorded creation the trigger
  // degrades to a diagnostic and leaves the rotation to the supervisor tool.
  const hostSessionCreationParameters = new Map<
    string,
    { readonly endpointId: DurableRuntimeEndpointId; readonly profile: SessionProfile }
  >();
  // The registry is constructed before this service exists (it must wrap the
  // adapter handed to the coordinator); association only ever happens after
  // this assignment, so the indirection is safe.
  options.serverLookup.serverForSession = (sessionId: string) =>
    mcpServerForSession(sessionId);

  // The bridge never sees model-supplied identity: each server is bound to one
  // host-known Session, and every request re-drains the durable outbox so a
  // single model turn advances the loop.
  async function captureHandoffArtifacts(
    request: SubmitHandoffRequest,
  ): Promise<SubmitHandoffRequest> {
    const attemptId = request.handoff.idempotencyKey.attemptId;
    const jobId = `capture-${attemptId}`;
    let job = await executionJobs.read(jobId);
    if (job === null) {
      const workspace = await workspaceManager.readWorkspace(attemptId);
      if (
        workspace === null ||
        workspace.attemptId !== attemptId ||
        workspace.status !== "ready"
      ) {
        throw new Error("attempt-workspace-not-ready");
      }
      const workingDirectory = await workspaceManager.verifyWorkspaceCwd(attemptId);
      job = await executionJobs.run({
        jobId,
        recipe: "capture-artifact",
        inputVersion: request.expectedVersion,
        workingDirectory,
        commitMessage: `workbench: capture ${attemptId}`,
      });
    } else if (
      job.recipe !== "capture-artifact" ||
      job.inputVersion !== request.expectedVersion
    ) {
      throw new Error("artifact-capture-job-mismatch");
    }
    // Issue #8 M1: a handoff whose execution job has not finished is not a
    // delivery ("background tests still running" is not done). The durable
    // job record carries the status signal; refusal stays readable.
    if (job.status === "queued" || job.status === "running") {
      throw new AutoIterationJobStillRunningError(jobId);
    }
    if (
      job.status !== "succeeded" ||
      job.output?.kind !== "captured-artifact"
    ) {
      throw new Error(`artifact-capture-failed:${job.lastError ?? job.status}`);
    }
    const workspace = await workspaceManager.readWorkspace(attemptId);
    if (workspace?.status === "ready") {
      const workingDirectory = await workspaceManager.verifyWorkspaceCwd(attemptId);
      const head = await runGitCommand({
        cwd: workingDirectory,
        args: ["rev-parse", "--verify", "HEAD^{commit}"],
      });
      const status = await runGitCommand({
        cwd: workingDirectory,
        args: ["status", "--porcelain"],
      });
      if (
        head.exitCode !== 0 ||
        head.stdout.trim() !== job.output.commitSha ||
        status.exitCode !== 0 ||
        status.stdout.trim().length > 0
      ) {
        throw new Error("artifact-capture-workspace-mismatch");
      }
      // Issue #8 M4 (w349 unsettled): the job status above only reflects
      // this host's own capture job; a worker-started background process
      // (e.g. a backgrounded test run) is invisible to it. Reject with the
      // same category so the caller sees one consistent "not delivered yet"
      // signal, and log the concrete reason host-side.
      const survivors = await scanWorkspaceProcesses(workspace.path);
      if (survivors.length > 0) {
        console.warn(
          "[auto-iteration] handoff rejected: workspace still has a running process",
          attemptId,
          survivors.map((entry) => `${entry.pid}:${entry.commandLine}`).join("; "),
        );
        throw new AutoIterationJobStillRunningError(`${jobId}:worker-background-process`);
      }
    }
    const references: readonly ArtifactReference[] = [
      {
        artifactId: `artifact-${attemptId}-commit`,
        kind: "git-commit",
        commitSha: job.output.commitSha,
      },
      {
        artifactId: `artifact-${attemptId}-capture-job`,
        kind: "execution-job",
        jobId,
      },
    ];
    for (const reference of references) {
      await authority.recordArtifact(reference);
    }
    return {
      ...request,
      handoff: {
        ...request.handoff,
        artifactIds: [
          ...new Set([
            ...request.handoff.artifactIds,
            ...references.map((reference) => reference.artifactId),
          ]),
        ],
      },
    };
  }

  function drainingRequest(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SupervisorToolRequest,
  ): Promise<SupervisorToolResponse>;
  function drainingRequest(
    actor: Extract<HostBoundToolActor, { readonly kind: "worker" }>,
    request: WorkerToolRequest,
  ): Promise<WorkerToolResponse>;
  function drainingRequest(
    actor: Extract<HostBoundToolActor, { readonly kind: "reviewer" }>,
    request: ReviewerToolRequest,
  ): Promise<ReviewerToolResponse>;
  async function drainingRequest(
    actor: HostBoundToolActor,
    request: SupervisorToolRequest | WorkerToolRequest | ReviewerToolRequest,
  ): Promise<SupervisorToolResponse | WorkerToolResponse | ReviewerToolResponse> {
    let preparedRequest = request;
    if (actor.kind === "worker" && request.kind === "submit-handoff") {
      try {
        preparedRequest = await captureHandoffArtifacts(request);
      } catch (error) {
        if (error instanceof AutoIterationJobStillRunningError) {
          return {
            kind: "rejected",
            requestIdempotencyKey: request.requestIdempotencyKey,
            currentVersion: request.expectedVersion,
            operation: request.kind,
            category: "job-still-running",
          };
        }
        console.warn(
          "[auto-iteration] handoff artifact capture rejected",
          request.handoff.idempotencyKey.attemptId,
          error instanceof Error ? error.message : error,
        );
        return {
          kind: "rejected",
          requestIdempotencyKey: request.requestIdempotencyKey,
          currentVersion: request.expectedVersion,
          operation: request.kind,
          category: "invalid-request",
        };
      }
    }
    const response =
      actor.kind === "supervisor"
        ? authority.request(actor, preparedRequest as SupervisorToolRequest)
        : actor.kind === "worker"
          ? authority.request(actor, preparedRequest as WorkerToolRequest)
          : authority.request(actor, preparedRequest as ReviewerToolRequest);
    let settled = await response;

    // Issue #8 M3: a fresh live Handoff starts its independent Review
    // Attempt. Fires for a retried/idempotent submit_handoff too (readReviewResult
    // and the in-process start guard both make a repeat call a no-op); never
    // blocks the worker's own turn on the reviewer Session actually starting.
    if (
      actor.kind === "worker" &&
      request.kind === "submit-handoff" &&
      settled.kind === "handoff-submitted"
    ) {
      const handoffKey = request.handoff.idempotencyKey;
      void ensureReviewSessionStarted(handoffKey).catch((error) => {
        console.warn(
          "[auto-iteration] review session start deferred",
          handoffKey.handoffId,
          error instanceof Error ? error.message : error,
        );
      });
    }

    // Issue #8 M3: the coordinator authorized the read but has no git access;
    // the host fills in the diff before the reviewer ever sees the response.
    if (
      actor.kind === "reviewer" &&
      request.kind === "read-handoff-artifact" &&
      settled.kind === "handoff-artifact"
    ) {
      try {
        const diff = await computeHandoffDiff(settled.baselineCommitSha, settled.commitSha);
        settled = { ...settled, diff };
      } catch (error) {
        console.warn(
          "[auto-iteration] handoff diff computation failed",
          request.handoff.handoffId,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Issue #8 M3 publish policy: the coordinator validated eligibility but
    // cannot push; the host performs the real fetch/compare/push here and
    // reports the terminal or retriable outcome back in the same turn.
    if (
      actor.kind === "supervisor" &&
      request.kind === "publish-candidate" &&
      settled.kind === "publish-candidate-accepted"
    ) {
      const outcome = await publishIntegratedCandidate(settled.candidate);
      await authority.completePublish({
        integrationCandidateId: settled.candidate.integrationCandidateId,
        outcome,
      });
      settled = {
        kind: "publish-candidate-result",
        requestIdempotencyKey: settled.requestIdempotencyKey,
        currentVersion: settled.currentVersion,
        outcome,
      };
    }

    void drainPendingOutbox().catch(() => undefined);
    return settled;
  }

  const drainingPort: AutoIterationCoordinatorPort = {
    request: drainingRequest,
  };

  /*
   * w338, issue #8 Lane C — the one production probe wiring: the runtimes
   * emit capability observations through the module-level sinks, and THIS is
   * where those observations reach the Project authority.
   *
   * - Claude `get_context_usage` (active probe at the validated Stop-hook
   *   boundary) lands in `observeContextUsage`; an authoritative fraction at
   *   or above the #8 §3 draining threshold (70%) on the ACTIVE supervisor's
   *   own context drives the same `request_supervisor_rotation` chain the
   *   supervisor tool drives (tenure → `successor-preparing` → real
   *   successor cutover through the rotation outbox).
   * - Codex `account/rateLimits/read` (w257's single start/resume read)
   *   lands in `observeQuota`; the coordinator itself parks executing Work
   *   Orders at `waiting-for-quota` when a read establishes exhaustion, and
   *   the outbox drain below refuses to start new workers while blocked.
   */
  const supervisorRotationContextFraction = 0.7;

  async function requestContextRotationForHighContext(
    observation: ContextUsageObservation,
  ): Promise<void> {
    if (observation.quality !== "authoritative" || observation.fraction === null) {
      return;
    }
    if (observation.fraction < supervisorRotationContextFraction) return;
    const supervisor = authority.readAutoIterationOverview().supervisor;
    if (supervisor === null || supervisor.status !== "active") return;
    if (observation.sessionId !== supervisor.sessionId) return;
    const creation =
      hostSessionCreationParameters.get(supervisor.sessionId) ??
      authority.readSupervisorSessionCreationParameters(supervisor.sessionId);
    if (creation === undefined) {
      // Without host-known creation parameters (e.g. after a Project reopen)
      // the host cannot honestly name a successor Session; the supervisor
      // tool remains the rotation path.
      console.warn(
        "[auto-iteration] context rotation deferred: no host-known successor parameters",
        supervisor.roleSlotId,
      );
      return;
    }
    const actor = {
      kind: "supervisor" as const,
      sessionId: supervisor.sessionId,
      tenure: {
        roleSlotId: supervisor.roleSlotId,
        generation: supervisor.generation,
      },
    };
    const rotationRequest: SupervisorToolRequest = {
      kind: "request-supervisor-rotation",
      requestIdempotencyKey: `auto-context-rotation-${supervisor.roleSlotId}-g${supervisor.generation}`,
      expectedVersion: 1,
      observedTenure: {
        roleSlotId: supervisor.roleSlotId,
        generation: supervisor.generation,
      },
      roleSlotId: supervisor.roleSlotId,
      successorSession: {
        endpointId: creation.endpointId,
        profile: creation.profile,
      },
    };
    let response = await authority.request(actor, rotationRequest);
    if (
      response.kind === "rejected" &&
      response.category === "stale-version" &&
      response.currentVersion !== null
    ) {
      response = await authority.request(actor, {
        ...rotationRequest,
        expectedVersion: response.currentVersion,
      });
    }
    if (response.kind === "supervisor-rotation-requested") {
      void drainPendingOutbox().catch(() => undefined);
      return;
    }
    console.warn(
      "[auto-iteration] context rotation not accepted",
      response.kind === "rejected" ? response.category : response.kind,
    );
  }

  setCapabilityProbeSinks({
    contextUsage: async (observation) => {
      await authority.observeContextUsage(observation);
      await requestContextRotationForHighContext(observation);
    },
    quota: async (observation) => {
      await authority.observeQuota(observation);
      // A quota observation moves Work Orders between `executing` and
      // `waiting-for-quota`; pure auto-iteration commits carry no channel
      // update the drain reacts to, so the re-check is chained here (the
      // same pattern as drainingRequest).
      void drainPendingOutbox().catch(() => undefined);
    },
  });

  function mcpServerForSession(sessionId: string): AutoIterationMcpServer {
    const existing = mcpServersBySession.get(sessionId);
    if (existing !== undefined) return existing;
    const server = createAutoIterationMcpServer({
      sessionId,
      authority: sessionAuthority,
      port: drainingPort,
    });
    mcpServersBySession.set(sessionId, server);
    return server;
  }

  async function bindInitialSupervisor(request: {
    readonly roleSlotId: string;
    readonly sessionId: string;
  }) {
    const sessionCreationParameters = pendingHostSessionParameters.get(request.sessionId);
    pendingHostSessionParameters.delete(request.sessionId);
    const binding = await authority.bindInitialSupervisor({
      roleSlotId: request.roleSlotId,
      sessionId: request.sessionId,
      generation: 1,
      ...(sessionCreationParameters === undefined ? {} : { sessionCreationParameters }),
    });
    sessionAuthority.bindSession({
      actor: {
        kind: "supervisor",
        sessionId: request.sessionId,
        tenure: {
          roleSlotId: binding.roleSlotId,
          generation: binding.generation,
        },
      },
    });
    return binding;
  }

  /** Re-establishes host bindings after a Project reopen from the ledger alone. */
  function resumeBindings(): void {
    try {
      const overview = authority.readAutoIterationOverview();
      if (overview.supervisor !== null) {
        sessionAuthority.bindSession({
          actor: {
            kind: "supervisor",
            sessionId: overview.supervisor.sessionId,
            tenure: {
              roleSlotId: overview.supervisor.roleSlotId,
              generation: overview.supervisor.generation,
            },
          },
        });
      }
      for (const order of overview.workOrders) {
        if (order.workerSessionId === null) continue;
        sessionAuthority.bindSession({
          actor: {
            kind: "worker",
            sessionId: order.workerSessionId,
            workOrderId: order.workOrderId,
            attemptId: order.currentAttemptId,
          },
        });
      }
      // Issue #8 M4 (w353 unsettled): the same gap as the worker loop above
      // used to have — a Review Attempt still awaiting its verdict at reopen
      // time had no path back to a tool binding. Durable order state alone
      // decides which handoffs still need one; reviewSessionIdsByHandoff
      // (reviewSessionIdFor's backing map) is repopulated alongside it.
      for (const order of overview.workOrders) {
        if (order.status !== "awaiting-review") continue;
        const handoff = authority.readCurrentHandoff(order.workOrderId);
        if (handoff === undefined) continue;
        const policy = authority.readWorkOrder(order.workOrderId)?.review ?? {
          kind: "none" as const,
        };
        if (policy.kind !== "independent") continue;
        if (authority.readReviewResult(handoff) !== undefined) continue;
        const sessionId = authority.readReviewSessionId(handoff);
        if (sessionId === undefined) continue;
        sessionAuthority.bindSession({ actor: { kind: "reviewer", sessionId, handoff } });
        reviewSessionIdsByHandoff.set(
          `${handoff.workOrderId}:${handoff.attemptId}:${handoff.handoffId}`,
          sessionId,
        );
      }
    } catch {
      // A ledger that cannot be read for bindings leaves them simply absent;
      // the durable state is untouched and the next drain retries.
    }
  }

  async function sessionSummary(
    sessionId: string,
  ): Promise<ProjectSnapshot["commands"][number]["session"] | undefined> {
    try {
      const project = await channel.snapshot();
      return project.commands.find(
        (command) => command.session?.sessionId === sessionId,
      )?.session;
    } catch {
      return undefined;
    }
  }

  async function sessionInFlight(sessionId: string): Promise<boolean> {
    try {
      const project = await channel.snapshot();
      return project.commands.some(
        (command) =>
          command.session?.sessionId === sessionId &&
          (command.status === "accepted" || command.status === "in-flight"),
      );
    } catch {
      return true;
    }
  }

  /** Every handoff whose wakeup entry is still pending, in delivery order. */
  async function pendingWakeupHandoffs(
    roleSlotId: string,
  ): Promise<HandoffIdempotencyKey[]> {
    const entries = await authority.readPendingOutbox();
    const handoffs: HandoffIdempotencyKey[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== "inbox-wakeup") continue;
      const payload = entry.payload as {
        readonly roleSlotId?: string;
        readonly handoff?: HandoffIdempotencyKey;
      };
      if (payload?.roleSlotId !== roleSlotId || payload.handoff === undefined) {
        continue;
      }
      const dedupe = `${payload.handoff.workOrderId}\u0000${payload.handoff.attemptId}\u0000${payload.handoff.handoffId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      handoffs.push(payload.handoff);
    }
    return handoffs;
  }

  /** Issue #8 M3: each entry's independent review status, if any is recorded. */
  function reviewLabel(handoff: HandoffIdempotencyKey): string {
    const workOrder = authority.readWorkOrder(handoff.workOrderId);
    const policy = workOrder?.review ?? { kind: "none" as const };
    if (policy.kind === "none") return handoff.workOrderId;
    const result = authority.readReviewResult(handoff);
    if (result === undefined) return `${handoff.workOrderId} (review: pending)`;
    const problems = result.problems.length;
    return `${handoff.workOrderId} (review: ${result.verdict}${problems > 0 ? `, ${problems} problem${problems === 1 ? "" : "s"}` : ""})`;
  }

  /** One bounded line per wakeup, however many handoffs are pending. */
  function supervisorWakeupSummary(pendingHandoffs: readonly HandoffIdempotencyKey[]): string {
    const listed = pendingHandoffs.slice(0, WAKEUP_HANDOFF_BATCH_LIMIT).map(reviewLabel);
    const rest = pendingHandoffs.length - listed.length;
    return (
      `Workbench auto-iteration: ${pendingHandoffs.length} worker handoff` +
      `${pendingHandoffs.length === 1 ? "" : "s"} await${pendingHandoffs.length === 1 ? "s" : ""} your review ` +
      `(work order${listed.length === 1 ? "" : "s"}: ${listed.join(", ")}` +
      `${rest > 0 ? `; and ${rest} more` : ""}). ` +
      `Use the read_inbox tool, then submit_review_decision.`
    );
  }

  async function startSessionForAutoIteration(options_: {
    readonly idempotencyKey: string;
    readonly endpointId: DurableRuntimeEndpointId;
    readonly profile: SessionProfile;
    readonly input: string;
    readonly executionDirectory?: string;
  }): Promise<string | undefined> {
    // w300: bind the bootstrap spec to THIS command object. The coordinator
    // carries the runtime-only field to the executor and strips it before
    // durable storage; no adapter-wide FIFO can give it to another command.
    const mcpBinding = options.workbenchBindings.reserve(
      options_.idempotencyKey,
    );
    let catalog: RuntimeCatalog;
    try {
      catalog = await adapter.inspect(
        options_.executionDirectory ?? projectDirectory,
      );
    } catch {
      options.workbenchBindings.release(options_.idempotencyKey);
      return undefined;
    }
    let resolved: SessionProfile;
    try {
      resolved = resolveSessionProfile({
        catalog,
        catalogRevision: `auto-iteration:${randomUUID()}`,
        preferences: { global: options_.profile },
      }).profile;
    } catch {
      options.workbenchBindings.release(options_.idempotencyKey);
      return undefined;
    }
    try {
      const receipt = await channel.act(
        Object.freeze({
          kind: "direct" as const,
          commandKind: "start" as const,
          idempotencyKey: options_.idempotencyKey,
          runtime: "codex" as const,
          catalogRevision: `auto-iteration:${randomUUID()}`,
          preferences: Object.freeze({ global: resolved }),
          profile: resolved,
          input: options_.input,
          ...(mcpBinding === undefined
            ? {}
            : { workbenchMcp: mcpBinding.bootstrap }),
        }),
        Object.freeze({
          endpointId: options_.endpointId,
          ...(options_.executionDirectory === undefined
            ? {}
            : { executionDirectory: options_.executionDirectory }),
        }),
      );
      const project = await channel.snapshot();
      const sessionId = project.commands.find(
        (command) => command.commandId === receipt.commandId,
      )?.session?.sessionId;
      if (sessionId === undefined) {
        options.workbenchBindings.release(options_.idempotencyKey);
      } else {
        hostSessionCreationParameters.set(sessionId, {
          endpointId: options_.endpointId,
          profile: resolved,
        });
      }
      return sessionId;
    } catch {
      options.workbenchBindings.release(options_.idempotencyKey);
      return undefined;
    }
  }

  /**
   * Issue #8 M3 §3: starts an independent Review Attempt Session for one
   * live Handoff, through the same production seam as a worker attempt
   * (`startSessionForAutoIteration`), but with no workspace/worktree of its
   * own — it never writes, so it only needs read tools. A "none" review
   * policy, an already-recorded result, or a superseded (reworked-past)
   * Handoff are all silent no-ops, not errors.
   */
  async function ensureReviewSessionStarted(handoff: HandoffIdempotencyKey): Promise<void> {
    const dedupeKey = `${handoff.workOrderId}:${handoff.attemptId}:${handoff.handoffId}`;
    if (reviewSessionStarts.has(dedupeKey)) return;
    const workOrder = authority.readWorkOrder(handoff.workOrderId);
    if (workOrder === undefined || workOrder.currentAttemptId !== handoff.attemptId) return;
    const policy = workOrder.review ?? { kind: "none" as const };
    if (policy.kind !== "independent") return;
    if (authority.readReviewResult(handoff) !== undefined) return;
    reviewSessionStarts.add(dedupeKey);
    try {
      const idempotencyKey = `auto-review-${dedupeKey}`;
      const sessionId = await startSessionForAutoIteration({
        idempotencyKey,
        endpointId: policy.reviewerSession.endpointId,
        profile: policy.reviewerSession.profile,
        input:
          `Workbench auto-iteration: you are an independent Review Attempt for work ` +
          `order ${handoff.workOrderId}. Use the read_handoff_artifact tool to see the ` +
          `diff and the original work order text, then use submit_review with verdict ` +
          `"agree" or "disagree" and specific problems (a code and a message each). ` +
          `Report anything you cannot concretely verify with code "cannot-verify" ` +
          `rather than omitting it or guessing.`,
      });
      if (sessionId === undefined) return;
      sessionAuthority.bindSession({
        actor: { kind: "reviewer", sessionId, handoff },
      });
      options.workbenchBindings.associate(idempotencyKey, sessionId);
      reviewSessionIdsByHandoff.set(dedupeKey, sessionId);
      // Issue #8 M4 (w353 unsettled): durable counterpart of the map above,
      // so a Project reopen while this review is still in flight can
      // re-establish the binding (see resumeBindings). Best-effort, same as
      // the in-memory map it mirrors.
      await authority.bindReviewSession({ handoff, sessionId }).catch(() => undefined);
    } finally {
      reviewSessionStarts.delete(dedupeKey);
    }
  }

  /** Issue #8 M3: a bounded unified diff for the reviewer; git has no size limit of its own. */
  const REVIEW_DIFF_MAX_LINES = 4_000;

  async function computeHandoffDiff(
    baselineCommitSha: string,
    commitSha: string,
  ): Promise<string> {
    const result = await runGitCommand({
      cwd: projectDirectory,
      args: ["diff", `${baselineCommitSha}..${commitSha}`],
    });
    if (result.exitCode !== 0) {
      return `(diff unavailable: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 2_000)})`;
    }
    const lines = result.stdout.split(/\r?\n/u);
    if (lines.length <= REVIEW_DIFF_MAX_LINES) return result.stdout;
    return (
      `${lines.slice(0, REVIEW_DIFF_MAX_LINES).join("\n")}\n` +
      `... (truncated, ${lines.length - REVIEW_DIFF_MAX_LINES} more lines)`
    );
  }

  /**
   * Issue #8 M3 publish policy: the candidate is already `integrated`
   * (merged to the local target branch); this pushes that branch to its
   * remote. Reuses the exact target-moved detection shape as w340's
   * integration recheck, this time against the remote.
   */
  async function publishIntegratedCandidate(
    candidate: IntegrationCandidate,
  ): Promise<PublishOutcome> {
    return integrationRunner.publish({
      candidate,
      repositoryPath: projectDirectory,
      remoteName: integrationRemoteName,
      remoteBranch: integrationLocalBranch,
      localTargetBranch: integrationLocalBranch,
    });
  }

  async function resumeIdentityFor(
    sessionId: string,
    profile: SessionProfile,
  ): Promise<ProjectRuntimeResumeIdentity | undefined> {
    const read = channel.readSessionRuntimeResumeIdentities;
    if (read === undefined) return undefined;
    try {
      const mappings = await read.call(channel, sessionId);
      const mapping = mappings.find((candidate) =>
        samePrivateProfile(candidate.selectionProfile, profile),
      );
      if (mapping === undefined) return undefined;
      return {
        schemaVersion: 1,
        endpointId: mapping.endpointId,
        nativeProfile: mapping.nativeProfile,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Issue #8 M2: `channel.act` resolves at durable acceptance, before the
   * Runtime attempt (resume/start/send) is even tried (w342 evidence §7.b).
   * A wakeup continue whose resume lands in `recovery-required` must not be
   * treated as delivered, or `markHandoffIncluded` would falsely seal a
   * receipt for input the parent Session never actually received. Waits on
   * the command's own durable update stream for its terminal kind.
   */
  async function awaitWakeupDelivery(commandId: string, after: Cursor): Promise<boolean> {
    const iterator = channel.observe({ after })[Symbol.asyncIterator]();
    try {
      while (!closed) {
        const next = await iterator.next();
        if (next.done) return false;
        const update = next.value;
        if (update.commandId !== commandId) continue;
        if (update.kind === "completed") return true;
        if (
          update.kind === "recovery-required" ||
          update.kind === "failed" ||
          update.kind === "quota-paused"
        ) {
          return false;
        }
      }
      return false;
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
  }

  async function wakeSupervisor(request: {
    readonly roleSlotId: string;
    readonly handoff: {
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly handoffId: string;
    };
  }): Promise<boolean> {
    const supervisor = authority.readAutoIterationOverview().supervisor;
    if (supervisor === null || supervisor.status !== "active") return false;
    if (arbiter.busy(supervisor.sessionId)) return false;
    const wakeupKey = randomUUID();
    const mcpBinding = options.workbenchBindings.reserveForSession(
      wakeupKey,
      supervisor.sessionId,
    );
    // Claim the arbiter slot before any await so a second wakeup entry
    // handled in the same drain pass cannot queue a duplicate turn behind
    // this one (w267b §3: same-Session arbitration, different Sessions in
    // parallel).
    void arbiter
      .submit(supervisor.sessionId, "auto-wakeup", async () => {
        if (closed) {
          options.workbenchBindings.release(wakeupKey);
          return;
        }
        try {
          if (await sessionInFlight(supervisor.sessionId)) {
            options.workbenchBindings.release(wakeupKey);
            return;
          }
          const session = await sessionSummary(supervisor.sessionId);
          if (session === undefined || !session.resumable) {
            options.workbenchBindings.release(wakeupKey);
            return;
          }
          const resumeIdentity = await resumeIdentityFor(
            supervisor.sessionId,
            session.profile,
          );
          // Issue #8 §3 wakeup: an idle parent gets ONE bounded summary that
          // carries every handoff still pending at wake time; arrivals during
          // the turn stay pending and wake at the next turn boundary.
          const pendingHandoffs = await pendingWakeupHandoffs(request.roleSlotId);
          if (pendingHandoffs.length === 0) {
            options.workbenchBindings.release(wakeupKey);
            return;
          }
          // w300: a bound Session's resume re-issues a fresh binding
          // (supervisor ruling); the Session id is already known so the pipe
          // serves live.
          const receipt = await channel.act(
            Object.freeze({
              kind: "direct" as const,
              commandKind: "continue" as const,
              idempotencyKey: wakeupKey,
              runtime: "codex" as const,
              targetSessionId: session.sessionId,
              profile: session.profile,
              ...(resumeIdentity === undefined
                ? {}
                : { runtimeResumeIdentity: resumeIdentity }),
              ...(mcpBinding === undefined
                ? {}
                : { workbenchMcp: mcpBinding.bootstrap }),
              input: supervisorWakeupSummary(pendingHandoffs),
            }),
            resumeIdentity === undefined
              ? undefined
              : Object.freeze({ endpointId: resumeIdentity.endpointId }),
          );
          // Issue #8 M2: only a continue that truly became parent input
          // (the command reached `completed`, not `recovery-required` or
          // similar) may seal the second-level receipt. A non-delivery
          // leaves every pending handoff's inbox-wakeup entry pending, so
          // the next wakeup opportunity carries it again.
          const delivered = await awaitWakeupDelivery(
            receipt.commandId,
            receipt.acceptedCursor,
          );
          if (!delivered) {
            options.workbenchBindings.release(wakeupKey);
            console.warn(
              "[auto-iteration] supervisor wakeup did not become parent input; deferred",
              request.handoff.workOrderId,
            );
            void drainPendingOutbox().catch(() => undefined);
            return;
          }
          // Issue #8 M4: only the batch actually named in the summary text
          // is sealed as delivered; a handoff beyond the cap keeps its
          // inbox-wakeup entry pending and is carried again (with an
          // accurate "and N more" count) at the next wakeup.
          for (const handoff of pendingHandoffs.slice(0, WAKEUP_HANDOFF_BATCH_LIMIT)) {
            try {
              await authority.markHandoffIncluded({
                handoff,
                parentCommandId: receipt.commandId,
              });
            } catch (error) {
              console.warn(
                "[auto-iteration] supervisor wakeup inclusion deferred",
                handoff.workOrderId,
                error instanceof Error ? error.message : error,
              );
            }
          }
          // A handoff left pending past the cap keeps its own inbox-wakeup
          // outbox entry, so the system's existing "any committed update
          // re-drains" mechanism (not a new retry path) carries it forward;
          // `markHandoffIncluded`'s own transaction above already commits.
        } catch (error) {
          options.workbenchBindings.release(wakeupKey);
          console.warn(
            "[auto-iteration] supervisor wakeup deferred",
            request.handoff.workOrderId,
            error instanceof Error ? error.message : error,
          );
        }
      })
      .catch(() => undefined);
    return true;
  }

  async function completeRotation(request: {
    readonly roleSlotId: string;
    readonly tenureId: string;
    readonly successorSession: SessionCreationParameters;
  }): Promise<boolean> {
    const previous = authority.readAutoIterationOverview().supervisor;
    const successorSessionId = await startSessionForAutoIteration({
      idempotencyKey: `auto-rotation-${request.tenureId}`,
      endpointId: request.successorSession.endpointId,
      profile: request.successorSession.profile,
      input:
        "Workbench auto-iteration: you are the successor supervisor Session. " +
        "Use the read_inbox tool to take over the supervisor role.",
    });
    if (successorSessionId === undefined) return false;
    // w300: the successor Session's pipe starts serving immediately; its
    // tenure binding below is what turns the supervisor tools on.
    options.workbenchBindings.associate(
      `auto-rotation-${request.tenureId}`,
      successorSessionId,
    );
    const tenure = await authority.completeSupervisorRotation({
      roleSlotId: request.roleSlotId,
      successorSessionId,
    });
    if (previous !== null) sessionAuthority.unbindSession(previous.sessionId);
    sessionAuthority.bindSession({
      actor: {
        kind: "supervisor",
        sessionId: successorSessionId,
        tenure: {
          roleSlotId: tenure.roleSlotId,
          generation: tenure.generation,
        },
      },
    });
    return true;
  }

  async function handleOutboxEntry(
    entry: PendingAutoIterationOutboxEntry,
  ): Promise<boolean> {
    if (entry.kind === "start-attempt") {
      const payload = entry.payload as {
        readonly attemptId?: string;
        readonly attemptNumber?: number;
        readonly workOrderId?: string;
        readonly baselineCommitSha?: string;
        readonly workerSession?: SessionCreationParameters;
        readonly sessionConfiguration?: {
          readonly requested?: SessionCreationParameters;
        };
        /** Issue #8 M3 §3: the independent review's problems verbatim, when a rework attempt has one. */
        readonly reworkFeedback?: string;
      };
      const attemptId = payload?.attemptId;
      const creation =
        payload?.workerSession ?? payload?.sessionConfiguration?.requested;
      if (
        attemptId === undefined ||
        payload.attemptNumber === undefined ||
        payload.workOrderId === undefined ||
        payload.baselineCommitSha === undefined ||
        creation === undefined
      ) return false;
      if (attemptStarts.has(attemptId)) {
        console.warn("[auto-iteration] attempt start rejected: already running", attemptId);
        return false;
      }
      const overview = authority.readAutoIterationOverview();
      const workOrder = overview.workOrders.find(
        (order) => order.currentAttemptId === attemptId,
      );
      if (workOrder === undefined || workOrder.workerSessionBound) return false;
      // Issue #8 M2: block only when THIS work order's own pool is waiting;
      // a different pool's exhaustion (overview.quotaWaiting can be true for
      // any pool) must not stall an attempt whose own pool is fine. The
      // entry stays pending and the same entry resumes after its pool
      // releases.
      if (workOrder.status === "waiting-for-quota") return false;
      // Issue #8 M1: the per-Project worker concurrency cap. A queued work
      // order's start-attempt entry is the queue slot; it dispatches at a
      // drain once an earlier delivery or failure frees a worker.
      if (workOrder.status === "queued") return false;
      attemptStarts.add(attemptId);
      try {
        const existingWorkspace = await workspaceManager.readWorkspace(attemptId);
        const workspace =
          existingWorkspace ??
          await workspaceManager.createAttemptWorkspace({
            attemptId,
            branch: `workbench/${payload.workOrderId}/attempt-${payload.attemptNumber}`,
            baselineRef: payload.baselineCommitSha,
          });
        if (
          workspace.attemptId !== attemptId ||
          workspace.status !== "ready"
        ) {
          throw new Error("attempt-workspace-not-ready");
        }
        const executionDirectory = await workspaceManager.verifyWorkspaceCwd(attemptId);
        await authority.updateAttemptRuntime({
          attemptId,
          runtimeLifecycle: "accepted",
          slotState: "unreserved",
          workspaceId: workspace.workspaceId,
        });
        const sessionId = await startSessionForAutoIteration({
          idempotencyKey: `auto-attempt-${attemptId}`,
          endpointId: creation.endpointId,
          profile: creation.profile,
          executionDirectory,
          input:
            `Workbench auto-iteration: work order ${workOrder.workOrderId} is ` +
            `assigned to you. Use the read_work_order_status tool, do the work, ` +
            `then submit_handoff.` +
            (payload.reworkFeedback === undefined
              ? ""
              : `\n\nIndependent reviewer feedback from the previous attempt:\n${payload.reworkFeedback}`),
        });
        if (sessionId === undefined) return false;
        await authority.bindAttemptSession({
          attemptId,
          sessionId,
          configuration: { state: "requested", requested: creation },
        });
        await authority.updateAttemptRuntime({
          attemptId,
          runtimeLifecycle: "running",
          slotState: "owned",
          workspaceId: workspace.workspaceId,
        });
        sessionAuthority.bindSession({
          actor: {
            kind: "worker",
            sessionId,
            workOrderId: workOrder.workOrderId,
            attemptId,
          },
        });
        // w300: only now does the pipe know its Session — after the durable
        // attempt binding AND the in-process actor binding, so the CLI's
        // buffered MCP handshake replays against a Session that already sees
        // its worker tools.
        options.workbenchBindings.associate(
          `auto-attempt-${attemptId}`,
          sessionId,
        );
        return true;
      } finally {
        attemptStarts.delete(attemptId);
      }
    }
    if (entry.kind === "inbox-wakeup") {
      const payload = entry.payload as {
        readonly roleSlotId?: string;
        readonly handoff?: HandoffIdempotencyKey;
      };
      if (payload?.roleSlotId === undefined || payload?.handoff === undefined) {
        return false;
      }
      return wakeSupervisor({
        roleSlotId: payload.roleSlotId,
        handoff: payload.handoff,
      });
    }
    if (entry.kind === "rotation") {
      const payload = entry.payload as {
        readonly roleSlotId?: string;
        readonly tenureId?: string;
        readonly successorSession?: SessionCreationParameters;
      };
      if (
        payload?.roleSlotId === undefined ||
        payload?.tenureId === undefined ||
        payload?.successorSession === undefined
      ) {
        return false;
      }
      return completeRotation({
        roleSlotId: payload.roleSlotId,
        tenureId: payload.tenureId,
        successorSession: payload.successorSession,
      });
    }
    const payload = entry.payload as {
      readonly decision?: string;
      readonly handoff?: HandoffIdempotencyKey;
      readonly workspaceId?: string | null;
      readonly integration?: {
        readonly integrationCandidateId?: string;
        readonly expectedTargetBaselineCommitSha?: string;
        readonly orderedCommitShas?: readonly string[];
        readonly inputVersion?: number;
      };
    };
    if (payload.decision === undefined || payload.handoff === undefined) {
      return false;
    }
    if (payload.integration === undefined) {
      if (typeof payload.workspaceId === "string") {
        const reclaimed = await workspaceManager.reclaimWorkspace(payload.workspaceId);
        if (reclaimed.status !== "reclaimed") {
          console.warn(
            "[auto-iteration] attempt workspace reclaim deferred",
            payload.workspaceId,
            reclaimed.lastError,
          );
          return false;
        }
      }
      await authority.completeReviewDisposition({
        reviewDecisionId: payload.decision,
      });
    } else {
      const integration = payload.integration;
      if (
        integration.integrationCandidateId === undefined ||
        integration.expectedTargetBaselineCommitSha === undefined ||
        integration.orderedCommitShas === undefined ||
        integration.inputVersion === undefined
      ) {
        return false;
      }
      const built = await candidateBuilder.build({
        integrationCandidateId: integration.integrationCandidateId,
        expectedTargetBaselineCommitSha:
          integration.expectedTargetBaselineCommitSha,
        orderedCommitShas: integration.orderedCommitShas,
        gateDefinitionVersion: "issue-8-m3-v1",
        environment: `${process.platform}/${process.arch}; node ${process.version}`,
        handoffs: [payload.handoff],
        reviewDecisionIds: [payload.decision],
        version: 1,
        inputVersion: integration.inputVersion,
      });
      if (built.status !== "ready") {
        console.warn(
          "[auto-iteration] integration candidate not ready",
          integration.integrationCandidateId,
          built.status,
        );
        return false;
      }
      if (typeof payload.workspaceId === "string") {
        const reclaimed = await workspaceManager.reclaimWorkspace(payload.workspaceId);
        if (reclaimed.status !== "reclaimed") {
          console.warn(
            "[auto-iteration] attempt workspace reclaim deferred",
            payload.workspaceId,
            reclaimed.lastError,
          );
          return false;
        }
      }
      await authority.completeReviewDisposition({
        reviewDecisionId: payload.decision,
        candidate: built.candidate,
      });
    }
    return true;
  }

  /** Wakes the supervisor Session for a blocked integration; same arbiter path as the handoff wake. */
  async function wakeSupervisorForBlockedIntegration(request: {
    readonly workOrderId: string;
    readonly integrationCandidateId: string;
    readonly summary: string;
  }): Promise<boolean> {
    const supervisor = authority.readAutoIterationOverview().supervisor;
    if (supervisor === null || supervisor.status !== "active") return false;
    if (arbiter.busy(supervisor.sessionId)) return false;
    if (await sessionInFlight(supervisor.sessionId)) return false;
    const session = await sessionSummary(supervisor.sessionId);
    if (session === undefined || !session.resumable) return false;
    const resumeIdentity = await resumeIdentityFor(
      supervisor.sessionId,
      session.profile,
    );
    const wakeupKey = randomUUID();
    const mcpBinding = options.workbenchBindings.reserveForSession(
      wakeupKey,
      supervisor.sessionId,
    );
    void arbiter
      .submit(supervisor.sessionId, "auto-wakeup", async () => {
        if (closed) {
          options.workbenchBindings.release(wakeupKey);
          return;
        }
        try {
          await channel.act(
            Object.freeze({
              kind: "direct" as const,
              commandKind: "continue" as const,
              idempotencyKey: wakeupKey,
              runtime: "codex" as const,
              targetSessionId: session.sessionId,
              profile: session.profile,
              ...(resumeIdentity === undefined
                ? {}
                : { runtimeResumeIdentity: resumeIdentity }),
              ...(mcpBinding === undefined
                ? {}
                : { workbenchMcp: mcpBinding.bootstrap }),
              input:
                `Workbench auto-iteration: integration for work order ` +
                `${request.workOrderId} is blocked (${request.summary}). ` +
                `Use the read_inbox tool, then decide whether to re-issue or accept.`,
            }),
            resumeIdentity === undefined
              ? undefined
              : Object.freeze({ endpointId: resumeIdentity.endpointId }),
          );
        } catch (error) {
          options.workbenchBindings.release(wakeupKey);
          console.warn(
            "[auto-iteration] supervisor integration-blocked wakeup deferred",
            request.workOrderId,
            error instanceof Error ? error.message : error,
          );
        }
      })
      .catch(() => undefined);
    return true;
  }

  async function reclaimWorkspaceQuietly(workspaceId: string): Promise<void> {
    try {
      const reclaimed = await workspaceManager.reclaimWorkspace(workspaceId);
      if (reclaimed.status !== "reclaimed") {
        console.warn(
          "[auto-iteration] integration workspace reclaim deferred",
          workspaceId,
          reclaimed.lastError,
        );
      }
    } catch (error) {
      console.warn(
        "[auto-iteration] integration workspace reclaim failed",
        workspaceId,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Runs at most one outstanding integration per call. Terminal outcomes are
   * recorded in the Project transaction; deferrals stay retryable and are
   * never dressed up as a blocked candidate.
   */
  async function runPendingIntegrations(): Promise<boolean> {
    const backlog = await authority.readIntegrationBacklog();
    for (const item of backlog) {
      if (closed) return false;
      const candidateId = item.candidate.integrationCandidateId;
      let result;
      try {
        result = await integrationRunner.run({
          candidate: item.candidate,
          repositoryPath: projectDirectory,
          targetRef: INTEGRATION_TARGET_REF,
          localTargetBranch: integrationLocalBranch,
          gates: integrationGatePlan,
        });
      } catch (error) {
        console.warn(
          "[auto-iteration] integration deferred",
          candidateId,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      if (result.status === "deferred") {
        console.warn(
          "[auto-iteration] integration deferred",
          candidateId,
          result.reason,
        );
        continue;
      }
      await authority.completeIntegration({
        integrationCandidateId: candidateId,
        outcome: result.outcome,
      });
      // The candidate workspace was retained only until gates finished.
      await reclaimWorkspaceQuietly(candidateId);
      await reclaimWorkspaceQuietly(`integration-${candidateId}`);
      if (result.outcome.status === "blocked: target-moved") {
        await wakeSupervisorForBlockedIntegration({
          workOrderId: item.candidate.handoffs[0]?.workOrderId ?? "",
          integrationCandidateId: candidateId,
          summary: result.outcome.status,
        }).catch(() => undefined);
      }
      return true;
    }
    return false;
  }

  let draining = false;
  let drainQueued = false;
  let drainCompletion: Promise<void> = Promise.resolve();
  function drainPendingOutbox(): Promise<void> {
    if (closed) return Promise.resolve();
    if (draining) {
      drainQueued = true;
      return drainCompletion;
    }
    draining = true;
    drainCompletion = (async () => {
      try {
        while (!closed) {
          drainQueued = false;
          const entries = await authority.readPendingOutbox();
          let progressed = false;
          for (const entry of entries) {
            try {
              progressed =
                (await handleOutboxEntry(entry)) || progressed;
            } catch (error) {
              console.warn(
                "[auto-iteration] outbox entry deferred",
                entry.kind,
                error instanceof Error ? error.message : error,
              );
            }
          }
          if (!progressed) {
            try {
              progressed = (await runPendingIntegrations()) || progressed;
            } catch (error) {
              console.warn(
                "[auto-iteration] integration pass deferred",
                error instanceof Error ? error.message : error,
              );
            }
          }
          if (!progressed && !drainQueued) return;
        }
      } finally {
        draining = false;
      }
    })();
    return drainCompletion;
  }

  // Turn-boundary trigger: a durable command update (a turn ending, a session
  // appearing) re-checks deferred wakeups. Observation failures are ignored;
  // the outbox itself is the durable driver.
  let updateIterator: AsyncIterator<ProjectUpdate> | undefined;
  void (async () => {
    try {
      const cursor = (await channel.snapshot()).cursor;
      if (closed) return;
      updateIterator = channel.observe({ after: cursor })[Symbol.asyncIterator]();
      while (!closed) {
        const next = await updateIterator.next();
        if (next.done) return;
        void drainPendingOutbox().catch(() => undefined);
      }
    } catch {
      // The channel may close before this consumer; observation is optional.
    }
  })();

  resumeBindings();
  void drainPendingOutbox().catch(() => undefined);

  return Object.freeze({
    authority,
    bindInitialSupervisor,
    startHostSession: async (request: {
      readonly endpointId: DurableRuntimeEndpointId;
      readonly profile: SessionProfile;
      readonly input: string;
    }) => {
      const hostKey = `auto-host-${randomUUID()}`;
      const sessionId = await startSessionForAutoIteration({
        idempotencyKey: hostKey,
        endpointId: request.endpointId,
        profile: request.profile,
        input: request.input,
      });
      // w300: serve the pipe as soon as the Session id exists. The actor
      // binding (bindInitialSupervisor, done by the caller) is what turns
      // the supervisor tools on; until then the Session's tool list is
      // legitimately empty.
      if (sessionId !== undefined) {
        options.workbenchBindings.associate(hostKey, sessionId);
        // Issue #8 M2: held only until the caller's bindInitialSupervisor
        // call picks it up and persists it in the tenure record.
        pendingHostSessionParameters.set(sessionId, {
          endpointId: request.endpointId,
          profile: request.profile,
        });
      }
      return sessionId;
    },
    mcpServerForSession,
    reviewSessionIdFor: (handoff: HandoffIdempotencyKey) =>
      reviewSessionIdsByHandoff.get(
        `${handoff.workOrderId}:${handoff.attemptId}:${handoff.handoffId}`,
      ),
    workbenchBindings: options.workbenchBindings,
    drainPendingOutbox,
    async close(): Promise<void> {
      closed = true;
      await drainCompletion.catch(() => undefined);
      setCapabilityProbeSinks(undefined);
      await updateIterator?.return?.().catch(() => undefined);
      await arbiter.close();
      options.workbenchBindings.close();
    },
  });
}

function createBackend(
  liveView: WorkbenchLiveView,
  channel: ProjectChannel,
  adapter: ResumableAgentRuntimeAdapter,
  projectDirectory: string,
  preferenceStore: DirectSessionProfilePreferenceStore,
  endpointPresentation: WorkbenchDirectEndpointPresentation,
  workbenchBindings: AutoIterationBindingRegistry,
  serverLookup: {
    serverForSession(sessionId: string): AutoIterationMcpServer;
  },
  autoIterationManagedWorkspaceRoot: string,
  annualReportCapability?: WorkbenchAnnualReportCapability,
  onAnnualReportJobActivityChange?: (delta: 1 | -1) => void,
  /** Issue #8 M4: overridable for tests; see `AutoIterationServiceOptions`. */
  scanWorkspaceProcesses?: (
    workspacePath: string,
  ) => Promise<readonly WorkspaceProcessRecord[]>,
): WorkbenchBackend {
  let closePromise: Promise<void> | undefined;
  const profileLoadPromises = new Set<
    Promise<WorkbenchAnyDirectSessionProfileResult>
  >();
  let profileLoadGeneration = 0;
  const preferenceSavePromises = new Set<
    Promise<WorkbenchDirectSessionProfileDefaultResult>
  >();
  const submissionPromises = new Set<Promise<WorkbenchSubmissionResult>>();
  const sessionRemovalPromises = new Set<
    Promise<WorkbenchSessionRemovalResult>
  >();
  const sessionMetadataPromises = new Set<
    Promise<WorkbenchSessionMetadataMutationResult>
  >();
  const interruptPromises = new Set<Promise<WorkbenchInterruptResult>>();
  const steerPromises = new Set<Promise<WorkbenchSteerResult>>();
  let submissionTail: Promise<void> = Promise.resolve();
  let annualReportStarting = false;
  let annualReportCompletion: Promise<void> | undefined;
  let activeSnapshot: CatalogSnapshot | undefined;
  let activeSnapshotRecoveryCommandIds: ReadonlySet<string> | undefined;
  let activeContinuationCapability: ActiveContinuationCapability | undefined;
  const runtimeResumeIdentityResolver =
    readWorkbenchRuntimeResumeIdentityResolver(adapter);
  let closing = false;
  const continuationPlan = createSessionContinuationPlan(
    channel,
    (commandId, stop) => { liveView.reportContinuationStop(commandId, stop); },
    (commandId, progress) => { liveView.reportContinuationProgress(commandId, progress); },
  );
  // The Project channel created by `createWorkbenchBackend` always carries the
  // auto-iteration authority (schema v7); narrower injected channels keep the
  // service absent and the view shows the unavailable projection.
  const autoIteration =
    channel.autoIteration === undefined
      ? undefined
      : createBackendAutoIterationService({
          channel: channel as ProjectChannel & {
            readonly autoIteration: AutoIterationProjectAuthority;
          },
          adapter,
          projectDirectory,
          managedWorkspaceRoot: autoIterationManagedWorkspaceRoot,
          workbenchBindings,
          serverLookup,
          scanWorkspaceProcesses,
        });
  return Object.freeze({
    autoIteration,
    observeProject: (listener: WorkbenchProjectListener) =>
      liveView.observe(listener),
    observeUserInput: (listener: () => void) => channel.observeUserInput?.(listener) ?? (() => undefined),
    async readUserInput(request: WorkbenchUserInputReadRequest): Promise<WorkbenchUserInputResult> {
      const parsed = reconstructUserInputRead(request);
      const target = parsed && !closing ? liveView.resolveSessionMetadata(parsed.sessionKey) : undefined;
      if (!target) return { ok: false };
      return sanitizeUserInputResult({ ok: true, requests: channel.readUserInput?.(target.sessionId) ?? [] });
    },
    async respondToUserInput(request: WorkbenchUserInputResponse): Promise<WorkbenchUserInputResponseResult> {
      const parsed = reconstructUserInputResponse(request);
      if (closing || !parsed || !channel.respondToUserInput) return { status: "unavailable" };
      return channel.respondToUserInput(parsed);
    },
    readTurnActivity(): ProjectTurnActivity {
      if (closing) return "unknown";
      try {
        return channel.readTurnActivity();
      } catch {
        return "unknown";
      }
    },
    interruptActiveTurn(
      request: WorkbenchInterruptRequest,
    ): Promise<WorkbenchInterruptResult> {
      const reconstructed = reconstructWorkbenchInterruptRequest(request);
      if (!reconstructed.ok) return Promise.resolve(publicInvalidInterrupt());
      // The user's own Stop click: let the continuation plan record why it stopped.
      continuationPlan.cancel("interrupted-by-user");
      if (closing) return Promise.resolve(publicInterruptUnavailable());
      const resolved = liveView.resolveInterrupt(
        reconstructed.request.interruptKey,
      );
      if (resolved === undefined) return Promise.resolve(publicInvalidInterrupt());
      const interrupt = channel.interruptActiveTurn;
      if (typeof interrupt !== "function") {
        return Promise.resolve(publicInterruptUnavailable());
      }
      const operation = Promise.resolve()
        .then(() => interrupt.call(channel, resolved))
        .then(
          (result) =>
            result.status === "requested"
              ? publicInterruptRequested()
              : result.status === "not-running"
                ? publicInvalidInterrupt()
                : publicInterruptUnavailable(),
          () => publicInterruptUnavailable(),
        );
      interruptPromises.add(operation);
      void operation.then(
        () => interruptPromises.delete(operation),
        () => interruptPromises.delete(operation),
      );
      return operation;
    },
    steerActiveTurn(request: WorkbenchSteerRequest): Promise<WorkbenchSteerResult> {
      const reconstructed = reconstructWorkbenchSteerRequest(request);
      if (!reconstructed.ok) return Promise.resolve(publicInvalidSteer());
      continuationPlan.cancel();
      if (closing) return Promise.resolve(publicSteerUnavailable());
      const resolved = liveView.resolveSteer(reconstructed.request.steerKey);
      if (resolved === undefined) return Promise.resolve(publicInvalidSteer());
      const steer = channel.steerActiveTurn;
      if (typeof steer !== "function") {
        return Promise.resolve(publicSteerUnavailable());
      }
      const operation = Promise.resolve()
        .then(() =>
          steer.call(channel, {
            commandId: resolved.commandId,
            input: reconstructed.request.input,
          }),
        )
        .then(
          (result) =>
            result.status === "accepted"
              ? publicSteerAccepted()
              : result.status === "not-running"
                ? publicInvalidSteer()
                : publicSteerUnavailable(),
          () => publicSteerUnavailable(),
        );
      steerPromises.add(operation);
      void operation.then(
        () => steerPromises.delete(operation),
        () => steerPromises.delete(operation),
      );
      return operation;
    },
    removeSession(
      request: WorkbenchSessionRemovalRequest,
    ): Promise<WorkbenchSessionRemovalResult> {
      const reconstructed = reconstructWorkbenchSessionRemovalRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(Object.freeze({ status: "not-found" as const }));
      }
      if (closing) {
        return Promise.resolve(
          Object.freeze({
            status: "blocked" as const,
            activity: "unknown" as const,
          }),
        );
      }
      const resolved = liveView.resolveSessionRemoval(
        reconstructed.request.removalKey,
      );
      if (resolved === undefined) {
        return Promise.resolve(Object.freeze({ status: "not-found" as const }));
      }
      const operation: Promise<WorkbenchSessionRemovalResult> = channel
        .removeSession(
          reconstructed.request.acknowledgedUnknownOutcome === true
            ? Object.freeze({
                ...resolved,
                acknowledgedUnknownOutcome: true as const,
              })
            : resolved,
        )
        .then(async (result) => {
          if (result.status === "removed") {
            await liveView.refreshAfterSessionMutation();
          }
          return result;
        });
      sessionRemovalPromises.add(operation);
      void operation.then(
        () => sessionRemovalPromises.delete(operation),
        () => sessionRemovalPromises.delete(operation),
      );
      return operation;
    },
    mutateSessionMetadata(
      request: WorkbenchSessionMetadataMutationRequest,
    ): Promise<WorkbenchSessionMetadataMutationResult> {
      const reconstructed =
        reconstructWorkbenchSessionMetadataMutationRequest(request);
      if (!reconstructed.ok) {
        return Promise.resolve(Object.freeze({ status: "unavailable" as const }));
      }
      if (closing) {
        return Promise.resolve(Object.freeze({ status: "unavailable" as const }));
      }
      const resolved = liveView.resolveSessionMetadata(
        reconstructed.request.metadataKey,
      );
      if (resolved === undefined) {
        return Promise.resolve(Object.freeze({ status: "not-found" as const }));
      }
      const operation: Promise<WorkbenchSessionMetadataMutationResult> = channel
        .mutateSessionMetadata({
          sessionId: resolved.sessionId,
          operation: reconstructed.request.operation,
          ...(reconstructed.request.acknowledgedUnknownOutcome === true
            ? { acknowledgedUnknownOutcome: true as const }
            : {}),
        })
        .then(async (result) => {
          if (
            result.status === "renamed" ||
            result.status === "archived" ||
            result.status === "restored"
          ) {
            await liveView.refreshAfterSessionMutation();
          }
          return result;
        });
      sessionMetadataPromises.add(operation);
      void operation.then(
        () => sessionMetadataPromises.delete(operation),
        () => sessionMetadataPromises.delete(operation),
      );
      return operation;
    },
    loadDirectSessionProfile(
      request: WorkbenchDirectSessionProfileLoadRequest = Object.freeze({
        kind: "catalog-default",
      }),
    ): Promise<WorkbenchAnyDirectSessionProfileResult> {
      const reconstructed =
        reconstructWorkbenchDirectSessionProfileLoadRequest(request);
      if (closing || !reconstructed.ok) {
        return Promise.resolve(publicProfileUnavailable());
      }
      const exactRequest = reconstructed.request;
      const loadGeneration = ++profileLoadGeneration;
      const operation = (async () => {
        let endpointDiscovery = publicUniformRuntimeEndpointDiscovery(
          "not-inspected",
        );
        try {
          const project = await channel.snapshot();
          const initialReplacementSource =
            exactRequest.kind === "replacement-session" &&
            project.cursor === exactRequest.sourceSnapshotCursor
              ? await liveView.resolveReplacementProfileSource(exactRequest)
              : undefined;
          const initialContinuationSource =
            exactRequest.kind === "continuation-session"
              ? liveView.resolveContinuationSelection(exactRequest.selectionKey)
              : undefined;
          const initialContinuationRuntimeResumeIdentities =
            exactRequest.kind === "continuation-session"
              ? await liveView.resolveContinuationRuntimeResumeIdentities(
                  exactRequest.selectionKey,
                )
              : undefined;
          if (
            exactRequest.kind === "continuation-session" &&
            (initialContinuationSource === undefined ||
              initialContinuationRuntimeResumeIdentities === undefined)
          ) {
            return publicContinuationProfileUnavailable(endpointDiscovery);
          }
          const endpointLoader = readWorkbenchDirectRuntimeEndpoints(adapter);
          const endpointSnapshot =
            endpointLoader === undefined
              ? await inspectLegacyRuntimeEndpoint(
                  adapter,
                  projectDirectory,
                  endpointPresentation,
                )
              : await endpointLoader(
                  projectDirectory,
                  exactRequest.kind,
                  exactRequest.kind === "continuation-session"
                    ? Object.freeze({
                        recordedProfile: initialContinuationSource!.profile,
                        runtimeResumeIdentities:
                          initialContinuationRuntimeResumeIdentities!,
                      })
                    : undefined,
                );
          endpointDiscovery = endpointSnapshot.endpointDiscovery;
          if (endpointSnapshot.endpoints.length === 0) {
            return exactRequest.kind === "continuation-session"
              ? publicContinuationProfileUnavailable(endpointDiscovery)
              : profileLoadFailureForDiscovery(endpointDiscovery);
          }
          const preferences = await preferenceStore.read();
          const recordedContinuationEndpointId =
            exactRequest.kind === "continuation-session" &&
            endpointLoader !== undefined
              ? continuationEndpointId(
                  initialContinuationRuntimeResumeIdentities!,
                  initialContinuationSource!.profile,
                )
              : undefined;
          const continuationEndpointSources =
            exactRequest.kind === "continuation-session" &&
            recordedContinuationEndpointId !== undefined
              ? endpointSnapshot.endpoints.filter(
                  (source) =>
                    source.endpointId === recordedContinuationEndpointId,
                )
              : endpointSnapshot.endpoints;
          const continuationCandidate =
            exactRequest.kind === "continuation-session"
              ? resolveContinuationCatalogCandidate({
                  endpointSources: continuationEndpointSources,
                  preferences,
                  includeLegacyGlobalPreferences: endpointLoader === undefined,
                  recordedProfile: initialContinuationSource!.profile,
                })
              : undefined;
          if (
            exactRequest.kind === "continuation-session" &&
            continuationCandidate === undefined
          ) {
            /* A model-retirement claim needs the recorded endpoint's catalog.
               The legacy adapter is one known Codex endpoint; the endpoint
               directory instead uses the durable resume route. A catalog from
               another endpoint says nothing about this Session's provider. */
            return endpointLoader === undefined ||
              (recordedContinuationEndpointId !== undefined &&
                continuationEndpointSources.length === 1)
              ? publicContinuationModelUnavailable(endpointDiscovery)
              : publicContinuationProfileUnavailable(endpointDiscovery);
          }
          const snapshot = continuationCandidate?.snapshot ??
            createCatalogSnapshot(
              endpointSnapshot.endpoints,
              endpointDiscovery,
              preferences,
              endpointLoader === undefined,
            );
          let replacementPrefill: WorkbenchReplacementPrefill | undefined;
          const finalProject = await channel.snapshot();
          if (exactRequest.kind === "replacement-session") {
            const finalReplacementSource =
              finalProject.cursor === exactRequest.sourceSnapshotCursor
                ? await liveView.resolveReplacementProfileSource(exactRequest)
                : undefined;
            replacementPrefill =
              initialReplacementSource !== undefined &&
              finalReplacementSource !== undefined &&
              samePrivateProfile(
                initialReplacementSource,
                finalReplacementSource,
              )
                ? snapshot.value.resolveReplacementPrefill(
                    initialReplacementSource,
                  )
                : Object.freeze({ kind: "manual-selection-required" });
          }
          if (
            exactRequest.kind === "continuation-session" &&
            continuationCandidate !== undefined &&
            await liveView.resolveContinuationProfile(
              exactRequest.selectionKey,
              continuationCandidate.resolvedProfile,
            ) === undefined
          ) {
            return publicContinuationProfileUnavailable(endpointDiscovery);
          }
          if (closing) {
            return publicProfileUnavailable(
              downgradeCatalogReadyDiscovery(endpointDiscovery),
            );
          }
          const result =
            exactRequest.kind === "catalog-default"
              ? toBackendProfileResult(snapshot)
              : exactRequest.kind === "replacement-session"
                ? toBackendReplacementProfileResult(
                    snapshot,
                    replacementPrefill ??
                      Object.freeze({ kind: "manual-selection-required" }),
                  )
                : toBackendContinuationProfileResult(
                    snapshot,
                    continuationCandidate!.prefill,
                    endpointDiscovery,
                  );
          if (loadGeneration === profileLoadGeneration) {
            activeSnapshot = snapshot;
            activeSnapshotRecoveryCommandIds = recoveryRequiredCommandIds(finalProject);
            activeContinuationCapability =
              exactRequest.kind === "continuation-session"
                ? Object.freeze({
                    selectionKey: exactRequest.selectionKey,
                    prefill: continuationCandidate!.prefill,
                  })
                : undefined;
          }
          return result;
        } catch {
          if (exactRequest.kind === "continuation-session") {
            return publicContinuationProfileUnavailable(endpointDiscovery);
          }
          return profileLoadFailureForDiscovery(
            downgradeCatalogReadyDiscovery(endpointDiscovery),
          );
        }
      })();
      profileLoadPromises.add(operation);
      void operation.then(
        () => profileLoadPromises.delete(operation),
        () => profileLoadPromises.delete(operation),
      );
      return operation;
    },
    useDirectSessionProfileAsDefault(
      request:
        | WorkbenchDirectSessionProfileDefaultRequest
        | WorkbenchBackendLegacyDefaultRequest,
    ): Promise<WorkbenchDirectSessionProfileDefaultResult> {
      const snapshot = activeSnapshot;
      let reconstructed =
        reconstructWorkbenchDirectSessionProfileDefaultRequest(request);
      if (!reconstructed.ok && snapshot !== undefined) {
        const compatibilityRequest = completeLegacyDefaultRequest(
          request,
          snapshot,
        );
        if (compatibilityRequest !== undefined) {
          reconstructed =
            reconstructWorkbenchDirectSessionProfileDefaultRequest(
              compatibilityRequest,
            );
        }
      }
      if (!reconstructed.ok) {
        return Promise.resolve(publicInvalidProfileDefaultSelection());
      }
      if (closing) return Promise.resolve(publicPreferenceUnavailable());
      if (
        snapshot === undefined ||
        reconstructed.request.snapshotKey !==
          snapshot.value.publicResult.profile.snapshotKey
      ) {
        return Promise.resolve(publicInvalidProfileDefaultSelection());
      }
      const resolved = snapshot.value.resolveSelection(reconstructed.request);
      if (resolved === undefined) {
        return Promise.resolve(publicInvalidProfileDefaultSelection());
      }
      const operation = (async () => {
        try {
          await preferenceStore.saveDefault(
            Object.freeze({
              endpointKey:
                snapshot.endpointPreferenceKeys[resolved.endpointIndex]!,
              model: resolved.profile.model,
              workIntensity: resolved.profile.effortLevel,
            }),
          );
          if (activeSnapshot === snapshot) {
            activeSnapshot = Object.freeze({
              value: snapshot.value.withDesiredDefault(reconstructed.request),
              compatibilityRuntime: snapshot.compatibilityRuntime,
              endpointPreferenceKeys: snapshot.endpointPreferenceKeys,
              directStartByEndpoint: snapshot.directStartByEndpoint,
            });
          }
          return publicProfileDefaultSaved();
        } catch {
          return publicPreferenceUnavailable();
        }
      })();
      preferenceSavePromises.add(operation);
      void operation.then(
        () => preferenceSavePromises.delete(operation),
        () => preferenceSavePromises.delete(operation),
      );
      return operation;
    },
    submitDirectInput(
      request: WorkbenchDirectInputRequest,
    ): Promise<WorkbenchSubmissionResult> {
      const submittedWhileOpen = !closing;
      // A human submission takes over this Project immediately, even while an
      // older catalog/acceptance request is awaiting its serialized turn.
      const continuationIntent = continuationPlan.cancel();
      const operation = submissionTail.then(async (): Promise<WorkbenchSubmissionResult> => {
        const reconstructed = reconstructWorkbenchDirectInputRequest(request);
        if (!reconstructed.ok) {
          if (reconstructed.category === "invalid-input") {
            return publicInvalidSubmission();
          }
          return reconstructed.category === "continuation-unavailable"
            ? publicContinuationUnavailable()
            : publicInvalidProfileSelection();
        }
        if (!submittedWhileOpen) return publicUnavailableSubmission();
        const plan = parseSessionContinuationPlan(reconstructed.request.input);
        if (plan === null || (plan !== undefined &&
            !isValidWorkbenchDirectInput(sessionContinuationStepInput(plan, plan.steps)))) {
          return publicInvalidSubmission();
        }
        if (reconstructed.request.kind === "continue") {
          const continuationRequest = reconstructed.request;
          const snapshot = activeSnapshot;
          const capability = activeContinuationCapability;
          if (
            snapshot === undefined ||
            capability === undefined ||
            capability.selectionKey !== continuationRequest.selectionKey ||
            continuationRequest.snapshotKey !==
              snapshot.value.publicResult.profile.snapshotKey ||
            continuationRequest.endpointKey !== capability.prefill.endpointKey ||
            continuationRequest.executionModeKey !==
              capability.prefill.executionModeKey ||
            continuationRequest.accessModeKey !== capability.prefill.accessModeKey
          ) {
            return publicInvalidProfileSelection();
          }
          const resolved = snapshot.value.resolveSelection(continuationRequest);
          if (resolved === undefined || resolved.endpointIndex !== 0) {
            return publicInvalidProfileSelection();
          }
          const resolvedEndpoint =
            snapshot.value.publicResult.profile.endpoints[resolved.endpointIndex];
          if (resolvedEndpoint === undefined) return publicInvalidProfileSelection();
          const continuation = await liveView.resolveContinuationProfile(
            continuationRequest.selectionKey,
            resolved.profile,
          );
          if (continuation === undefined) return publicContinuationUnavailable();
          try {
            const runtimeResumeIdentity =
              runtimeResumeIdentityResolver === undefined
                ? undefined
                : await runtimeResumeIdentityResolver(
                    projectDirectory,
                    continuation.profile,
                  );
            if (
              runtimeResumeIdentityResolver !== undefined &&
              (runtimeResumeIdentity === undefined ||
                runtimeResumeIdentity.endpointId !== resolvedEndpoint.endpointId)
            ) {
              return publicContinuationUnavailable();
            }
            await continuationPlan.submit(
              Object.freeze({
                kind: "direct" as const,
                commandKind: "continue" as const,
                idempotencyKey: randomUUID(),
                runtime: "codex" as const,
                targetSessionId: continuation.targetSessionId,
                profile: continuation.profile,
                profileProjection: Object.freeze({
                  version: 1 as const,
                  requested: resolved.requestedProfileProjection,
                }),
                ...(runtimeResumeIdentity === undefined
                  ? {}
                  : { runtimeResumeIdentity }),
                input: continuationRequest.input,
              }),
              Object.freeze({ endpointId: resolvedEndpoint.endpointId }),
              plan,
              continuationIntent,
            );
            if (activeSnapshot === snapshot) {
              activeSnapshot = undefined;
              activeSnapshotRecoveryCommandIds = undefined;
              activeContinuationCapability = undefined;
            }
            return publicSubmissionAccepted();
          } catch (error) {
            return error instanceof CoordinatorError &&
              error.category === "continuation-unavailable"
              ? publicContinuationUnavailable()
              : publicUnavailableSubmission();
          }
        }

        const startRequest = reconstructed.request;
        const snapshot = activeSnapshot;
        const recoveryCommandIds = activeSnapshotRecoveryCommandIds;
        if (
          snapshot === undefined ||
          recoveryCommandIds === undefined ||
          startRequest.snapshotKey !==
            snapshot.value.publicResult.profile.snapshotKey
        ) {
          return publicInvalidProfileSelection();
        }
        try {
          const project = await channel.snapshot();
          if (hasNewRecoveryRequiredCommand(project, recoveryCommandIds)) {
            return publicUnavailableSubmission();
          }
        } catch {
          return publicUnavailableSubmission();
        }
        const resolved = snapshot.value.resolveSelection(startRequest);
        if (resolved === undefined) {
          return publicInvalidProfileSelection();
        }
        if (
          snapshot.directStartByEndpoint[resolved.endpointIndex] !== "supported"
        ) {
          return publicRuntimeStartUnsupported();
        }
        const selectedProfile: SessionProfile = resolved.profile;
        const resolvedEndpoint =
          snapshot.value.publicResult.profile.endpoints[resolved.endpointIndex];
        if (resolvedEndpoint === undefined) {
          return publicInvalidProfileSelection();
        }
        try {
          const runtimeResumeIdentity =
            runtimeResumeIdentityResolver === undefined
              ? undefined
              : await runtimeResumeIdentityResolver(
                  projectDirectory,
                  selectedProfile,
                );
          if (
            runtimeResumeIdentityResolver !== undefined &&
            (runtimeResumeIdentity === undefined ||
              runtimeResumeIdentity.endpointId !== resolvedEndpoint.endpointId)
          ) {
            return publicUnavailableSubmission();
          }
          await continuationPlan.submit(
            Object.freeze({
              kind: "direct" as const,
              commandKind: "start" as const,
              idempotencyKey: randomUUID(),
              runtime: "codex" as const,
              catalogRevision: resolved.catalogRevision,
              preferences: Object.freeze({ global: selectedProfile }),
              profile: selectedProfile,
              requestedProfileProjection: resolved.requestedProfileProjection,
              ...(runtimeResumeIdentity === undefined
                ? {}
                : { runtimeResumeIdentity }),
              input: startRequest.input,
            }),
            Object.freeze({ endpointId: resolvedEndpoint.endpointId }),
            plan,
            continuationIntent,
          );
          if (activeSnapshot === snapshot) {
            activeSnapshot = undefined;
            activeSnapshotRecoveryCommandIds = undefined;
            activeContinuationCapability = undefined;
          }
          return publicSubmissionAccepted();
        } catch {
          return publicUnavailableSubmission();
        }
      });
      submissionTail = operation.then(
        () => undefined,
        () => undefined,
      );
      submissionPromises.add(operation);
      void operation.then(
        () => submissionPromises.delete(operation),
        () => submissionPromises.delete(operation),
      );
      return operation;
    },
    async startAnnualReportJob(
      request: Omit<WorkbenchAnnualReportJobRequest, "projectId">,
    ): Promise<WorkbenchAnnualReportStartResult> {
      if (closing || annualReportCapability === undefined) {
        return annualReportStartFailure(
          "annual-report-unavailable",
          "Annual report jobs are unavailable in this build.",
        );
      }
      if (annualReportStarting || annualReportCompletion !== undefined) {
        return annualReportStartFailure(
          "already-running",
          "An annual report job is already running for this Project.",
        );
      }
      const snapshot = activeSnapshot;
      if (
        snapshot === undefined ||
        request.snapshotKey !== snapshot.value.publicResult.profile.snapshotKey
      ) {
        return annualReportStartFailure(
          "invalid-profile-selection",
          "The selected Session Profile expired. Reload the profile options and try again.",
        );
      }
      const resolved = snapshot.value.resolveSelection(request);
      if (resolved === undefined) {
        return annualReportStartFailure(
          "invalid-profile-selection",
          "The selected endpoint, model, or intensity is no longer available. Reload the profile options and try again.",
        );
      }
      if (snapshot.directStartByEndpoint[resolved.endpointIndex] !== "supported") {
        return annualReportStartFailure(
          "invalid-profile-selection",
          "The selected endpoint cannot start because its key or runtime is unavailable. Open Settings and try again.",
        );
      }
      annualReportStarting = true;
      let activityHandedToCompletion = false;
      onAnnualReportJobActivityChange?.(1);
      try {
        const started = await annualReportCapability.start({
          projectDirectory,
          adapter,
          profile: resolved.profile,
        });
        if (started.status === "no-pdfs") {
          return annualReportStartFailure(
            "no-pdfs",
            "This Project folder has no top-level PDF files to process.",
          );
        }
        const completion = started.completion.then(
          () => undefined,
          () => undefined,
        );
        annualReportCompletion = completion;
        activityHandedToCompletion = true;
        void completion.finally(() => {
          if (annualReportCompletion === completion) annualReportCompletion = undefined;
          onAnnualReportJobActivityChange?.(-1);
        });
        return Object.freeze({ ok: true, status: "started" });
      } catch {
        return annualReportStartFailure(
          "annual-report-unavailable",
          "The annual report job could not be started. Keep the folder open and try again.",
        );
      } finally {
        annualReportStarting = false;
        if (!activityHandedToCompletion) onAnnualReportJobActivityChange?.(-1);
      }
    },
    async startAutoIterationSupervisor(
      request: Omit<WorkbenchStartAutoIterationSupervisorRequest, "projectId">,
    ): Promise<WorkbenchStartAutoIterationSupervisorResult> {
      if (closing || autoIteration === undefined) {
        return autoIterationSupervisorStartFailure(
          "auto-iteration-unavailable",
          "Auto-iteration is unavailable in this build.",
        );
      }
      if (
        autoIteration.authority.readAutoIterationOverview().supervisor !== null
      ) {
        return autoIterationSupervisorStartFailure(
          "already-active",
          "This Project already has an auto-iteration supervisor. Open its Session to continue, or rotate from within it.",
        );
      }
      const snapshot = activeSnapshot;
      if (
        snapshot === undefined ||
        request.snapshotKey !== snapshot.value.publicResult.profile.snapshotKey
      ) {
        return autoIterationSupervisorStartFailure(
          "invalid-profile-selection",
          "The selected Session Profile expired. Reload the profile options and try again.",
        );
      }
      const resolved = snapshot.value.resolveSelection(request);
      if (resolved === undefined) {
        return autoIterationSupervisorStartFailure(
          "invalid-profile-selection",
          "The selected endpoint, model, or intensity is no longer available. Reload the profile options and try again.",
        );
      }
      if (snapshot.directStartByEndpoint[resolved.endpointIndex] !== "supported") {
        return autoIterationSupervisorStartFailure(
          "invalid-profile-selection",
          "The selected endpoint cannot start because its key or runtime is unavailable. Open Settings and try again.",
        );
      }
      const resolvedEndpoint =
        snapshot.value.publicResult.profile.endpoints[resolved.endpointIndex];
      if (resolvedEndpoint === undefined) {
        return autoIterationSupervisorStartFailure(
          "invalid-profile-selection",
          "The selected endpoint, model, or intensity is no longer available. Reload the profile options and try again.",
        );
      }
      const sessionId = await autoIteration.startHostSession({
        endpointId: resolvedEndpoint.endpointId,
        profile: resolved.profile,
        input: AUTO_ITERATION_INITIAL_SUPERVISOR_OPENING_INPUT,
      });
      if (sessionId === undefined) {
        return autoIterationSupervisorStartFailure(
          "start-failed",
          "The supervisor Session could not be started. Try again.",
        );
      }
      try {
        await autoIteration.bindInitialSupervisor({
          roleSlotId: AUTO_ITERATION_SUPERVISOR_ROLE_SLOT_ID,
          sessionId,
        });
      } catch {
        // A concurrent start already bound this Project's one supervisor
        // slot between the check above and this bind; the new Session is
        // left running unbound, same as any other race the outbox tolerates.
        return autoIterationSupervisorStartFailure(
          "already-active",
          "This Project already has an auto-iteration supervisor. Open its Session to continue, or rotate from within it.",
        );
      }
      return Object.freeze({ ok: true, status: "started" });
    },
    readAnnualReportJob(): Promise<WorkbenchAnnualReportSnapshot | null> {
      if (closing || annualReportCapability === undefined) return Promise.resolve(null);
      return annualReportCapability.readLatest(projectDirectory).catch(() => null);
    },
    resolveAnnualReportOutputDirectory(): Promise<string | null> {
      if (closing || annualReportCapability === undefined) return Promise.resolve(null);
      return annualReportCapability.resolveLatestOutputDirectory(projectDirectory).catch(() => null);
    },
    close(): Promise<void> {
      closing = true;
      continuationPlan.cancel();
      closePromise ??= (async () => {
        await Promise.all([...profileLoadPromises.values()]);
        await Promise.all([...preferenceSavePromises]);
        await Promise.all([...submissionPromises]);
        if (annualReportCompletion !== undefined) await annualReportCompletion;
        await Promise.allSettled([...sessionRemovalPromises]);
        await Promise.allSettled([...sessionMetadataPromises]);
        await Promise.allSettled([...interruptPromises]);
        await Promise.allSettled([...steerPromises]);
        activeSnapshot = undefined;
        activeSnapshotRecoveryCommandIds = undefined;
        activeContinuationCapability = undefined;
        await preferenceStore.close();
        await autoIteration?.close();
        await liveView.close();
        await channel.close();
        await continuationPlan.close();
      })();
      return closePromise;
    },
  }) as WorkbenchBackend;
}

function annualReportStartFailure(
  category: Exclude<WorkbenchAnnualReportStartResult, { readonly ok: true }>["error"]["category"],
  message: string,
): WorkbenchAnnualReportStartResult {
  return Object.freeze({ ok: false, error: Object.freeze({ category, message }) });
}

function autoIterationSupervisorStartFailure(
  category: Exclude<
    WorkbenchStartAutoIterationSupervisorResult,
    { readonly ok: true }
  >["error"]["category"],
  message: string,
): WorkbenchStartAutoIterationSupervisorResult {
  return Object.freeze({ ok: false, error: Object.freeze({ category, message }) });
}

function recoveryRequiredCommandIds(project: ProjectSnapshot): ReadonlySet<string> {
  return new Set(
    project.commands
      .filter((command) => command.status === "recovery-required")
      .map((command) => command.commandId),
  );
}

function hasNewRecoveryRequiredCommand(
  project: ProjectSnapshot,
  knownCommandIds: ReadonlySet<string>,
): boolean {
  return project.commands.some(
    (command) =>
      command.status === "recovery-required" &&
      !knownCommandIds.has(command.commandId),
  );
}

function createCatalogSnapshot(
  endpointSources: readonly WorkbenchDirectRuntimeEndpointCatalog[],
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
  preferences: DirectSessionProfilePreferenceSnapshot,
  includeLegacyGlobalPreferences: boolean,
): CatalogSnapshot {
  if (endpointSources.length === 0) throw new Error("invalid-endpoints");
  const prepared = endpointSources.map((source, endpointIndex) => {
    if (
      !isSafePreferenceEndpointKey(source.preferenceKey) ||
      !isSafeDisplayText(source.runtimeFamilyLabel, 160) ||
      !isSafeDisplayText(source.endpointLabel, 160) ||
      (source.directStart !== "supported" &&
        source.directStart !== "inspect-only")
    ) {
      throw new Error("invalid-endpoint-presentation");
    }
    const catalog = sanitizeCatalog(source.catalog);
    const catalogRevision = `catalog:${randomUUID()}`;
    const storedEndpoint = preferences.endpoints.find(
      (candidate) => candidate.endpointKey === source.preferenceKey,
    );
    const explicitPreference = storedEndpoint?.model !== undefined;
    const baseline =
      source.desiredDefault ?? firstAvailableProfile(catalog);
    let desiredProfile: SessionProfile | undefined;
    if (explicitPreference || source.desiredDefault !== undefined) {
      try {
        desiredProfile = resolveSessionProfile({
          catalog,
          catalogRevision,
          preferences: toResolverPreferences(
            preferences,
            source.preferenceKey,
            baseline,
            includeLegacyGlobalPreferences,
          ),
        }).profile;
      } catch {
        // An unavailable desired default is explicit and never downgraded.
      }
    }
    return Object.freeze({
      source,
      endpointIndex,
      catalog,
      catalogRevision,
      explicitPreference,
      desiredProfile,
    });
  });
  const desired =
    prepared.find(
      (candidate) =>
        candidate.explicitPreference && candidate.desiredProfile !== undefined,
    ) ??
    prepared.find((candidate) => candidate.desiredProfile !== undefined);
  const snapshot = createDirectSessionProfileSnapshot({
    endpoints: Object.freeze(
      prepared.map(({ source, catalog, catalogRevision }) =>
        Object.freeze({
          endpointId: source.endpointId,
          runtimeFamilyLabel: source.runtimeFamilyLabel,
          endpointLabel: source.endpointLabel,
          catalog,
          catalogRevision,
          executionModeLabels: Object.freeze(
            catalog.executionModes.map((mode) =>
              mode === "single-agent" ? "Single agent" : mode,
            ),
          ),
          accessModeLabels: Object.freeze(
            catalog.accessModes.map((mode) =>
              mode === "full-access"
                ? "Full access"
                : mode === "restricted"
                  ? "Restricted"
                  : mode,
            ),
          ),
        }),
      ),
    ),
    endpointDiscovery,
    ...(desired?.desiredProfile === undefined
      ? {}
      : {
          desiredDefault: Object.freeze({
            endpointIndex: desired.endpointIndex,
            profile: desired.desiredProfile,
          }),
        }),
  });
  return Object.freeze({
    value: snapshot,
    compatibilityRuntime: prepared[0]!.catalog.runtime,
    endpointPreferenceKeys: Object.freeze(
      prepared.map(({ source }) => source.preferenceKey),
    ),
    directStartByEndpoint: Object.freeze(
      prepared.map(({ source }) => source.directStart),
    ),
  });
}

interface ContinuationCatalogCandidate {
  readonly snapshot: CatalogSnapshot;
  readonly prefill: WorkbenchContinuationPrefill;
  readonly resolvedProfile: SessionProfile;
}

function resolveContinuationCatalogCandidate(options: {
  readonly endpointSources: readonly WorkbenchDirectRuntimeEndpointCatalog[];
  readonly preferences: DirectSessionProfilePreferenceSnapshot;
  readonly includeLegacyGlobalPreferences: boolean;
  readonly recordedProfile: SessionProfile;
}): ContinuationCatalogCandidate | undefined {
  const candidates: ContinuationCatalogCandidate[] = [];
  for (const source of options.endpointSources) {
    let snapshot: CatalogSnapshot;
    try {
      snapshot = createCatalogSnapshot(
        Object.freeze([source]),
        continuationEndpointDiscovery(source.endpointId),
        options.preferences,
        options.includeLegacyGlobalPreferences,
      );
    } catch {
      continue;
    }
    const prefill = snapshot.value.resolveReplacementPrefill(
      options.recordedProfile,
    );
    if (prefill.kind !== "resolved") continue;
    const resolved = snapshot.value.resolveSelection(
      Object.freeze({
        snapshotKey: snapshot.value.publicResult.profile.snapshotKey,
        endpointKey: prefill.endpointKey,
        modelKey: prefill.modelKey,
        workIntensityKey: prefill.workIntensityKey,
        executionModeKey: prefill.executionModeKey,
        accessModeKey: prefill.accessModeKey,
      }),
    );
    if (resolved === undefined) continue;
    candidates.push(
      Object.freeze({
        snapshot,
        prefill,
        resolvedProfile: resolved.profile,
      }),
    );
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function continuationEndpointDiscovery(
  endpointId: WorkbenchDirectRuntimeEndpointCatalog["endpointId"],
): WorkbenchRuntimeEndpointDiscovery {
  return publicSingleInspectedRuntimeEndpointDiscovery(
    endpointId,
    "catalog-ready",
  );
}

async function inspectLegacyRuntimeEndpoint(
  adapter: ResumableAgentRuntimeAdapter,
  projectDirectory: string,
  presentation: WorkbenchDirectEndpointPresentation,
): Promise<WorkbenchDirectRuntimeEndpointSnapshot> {
  try {
    const catalog = await adapter.inspect(projectDirectory);
    return Object.freeze({
      endpoints: Object.freeze([
        Object.freeze({
          endpointId: "codex-desktop" as const,
          preferenceKey: presentation.preferenceKey,
          runtimeFamilyLabel: presentation.runtimeFamilyLabel,
          endpointLabel: presentation.endpointLabel,
          catalog,
          desiredDefault: initialCodexProfile,
          directStart: "supported" as const,
        }),
      ]),
      endpointDiscovery: publicSingleInspectedRuntimeEndpointDiscovery(
        "codex-desktop",
        "catalog-ready",
      ),
    });
  } catch (error) {
    return Object.freeze({
      endpoints: Object.freeze([]),
      endpointDiscovery: publicSingleInspectedRuntimeEndpointDiscovery(
        "codex-desktop",
        legacyDiscoveryCategory(error),
      ),
    });
  }
}

function legacyDiscoveryCategory(
  error: unknown,
): Extract<
  WorkbenchRuntimeEndpointDiscoveryCategory,
  "authentication-required" | "inspection-failed" | "runtime-not-located"
> {
  if (error instanceof RuntimeAdapterError) {
    if (error.category === "runtime-not-located") {
      return "runtime-not-located";
    }
    if (error.category === "authentication-required") {
      return "authentication-required";
    }
  }
  return "inspection-failed";
}

function profileLoadFailureForDiscovery(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
): WorkbenchAnyDirectSessionProfileResult {
  const coherentDiscovery = downgradeCatalogReadyDiscovery(endpointDiscovery);
  return coherentDiscovery.statuses.every(
    (status) => status.category === "runtime-not-located",
  )
    ? publicRuntimeNotLocated(coherentDiscovery)
    : publicProfileUnavailable(coherentDiscovery);
}

function downgradeCatalogReadyDiscovery(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
): WorkbenchRuntimeEndpointDiscovery {
  return publicRuntimeEndpointDiscovery(
    endpointDiscovery.statuses.map((status) => ({
      endpointId: status.endpointId,
      category:
        status.category === "catalog-ready"
          ? ("inspection-failed" as const)
          : status.category,
    })),
  );
}

function firstAvailableProfile(catalog: DirectSessionProfileCatalog): SessionProfile {
  return Object.freeze({
    model: catalog.models[0]!.id,
    effortLevel: catalog.models[0]!.effortLevels[0]!,
    executionMode: catalog.executionModes[0]!,
    accessMode: catalog.accessModes[0]!,
  });
}

function toBackendProfileResult(
  snapshot: CatalogSnapshot,
): Extract<WorkbenchCatalogDefaultProfileResult, { readonly ok: true }> {
  const publicProfile = snapshot.value.publicResult.profile;
  const profile = {
    snapshotKey: publicProfile.snapshotKey,
    endpoints: publicProfile.endpoints,
    desiredDefault: publicProfile.desiredDefault,
  } as WorkbenchBackendDirectSessionProfile;
  defineBackendProfileCompatibility(profile, snapshot);
  return Object.freeze({
    ok: true as const,
    endpointDiscovery: snapshot.value.publicResult.endpointDiscovery,
    profile: Object.freeze(profile),
  });
}

function toBackendReplacementProfileResult(
  snapshot: CatalogSnapshot,
  replacementPrefill: WorkbenchReplacementPrefill,
): Extract<WorkbenchReplacementSessionProfileResult, { readonly ok: true }> {
  const publicProfile = snapshot.value.publicResult.profile;
  const profile = {
    snapshotKey: publicProfile.snapshotKey,
    endpoints: publicProfile.endpoints,
    replacementPrefill,
  } as WorkbenchBackendReplacementDirectSessionProfile;
  defineBackendProfileCompatibility(profile, snapshot);
  return Object.freeze({
    ok: true as const,
    endpointDiscovery: snapshot.value.publicResult.endpointDiscovery,
    profile: Object.freeze(profile),
  });
}

function toBackendContinuationProfileResult(
  snapshot: CatalogSnapshot,
  continuationPrefill: WorkbenchContinuationPrefill,
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery,
): Extract<WorkbenchContinuationSessionProfileResult, { readonly ok: true }> {
  const publicProfile = snapshot.value.publicResult.profile;
  const endpoint = publicProfile.endpoints[0];
  if (endpoint === undefined || publicProfile.endpoints.length !== 1) {
    throw new Error("invalid-continuation-endpoint");
  }
  const profile = {
    snapshotKey: publicProfile.snapshotKey,
    endpoints: Object.freeze([endpoint] as const),
    continuationPrefill,
  } as WorkbenchBackendContinuationDirectSessionProfile;
  defineBackendProfileCompatibility(profile, snapshot);
  return Object.freeze({
    ok: true as const,
    endpointDiscovery,
    profile: Object.freeze(profile),
  });
}

function defineBackendProfileCompatibility(
  profile:
    | WorkbenchBackendDirectSessionProfile
    | WorkbenchBackendReplacementDirectSessionProfile
    | WorkbenchBackendContinuationDirectSessionProfile,
  snapshot: CatalogSnapshot,
): void {
  const endpoint = profile.endpoints[0];
  if (endpoint === undefined) throw new Error("invalid-endpoint-catalog");
  Object.defineProperties(profile, {
    runtime: Object.freeze({
      value: snapshot.compatibilityRuntime,
      enumerable: false,
    }),
    models: Object.freeze({
      value: endpoint.models,
      enumerable: false,
    }),
    executionMode: Object.freeze({
      value: Object.freeze({
        value: "single-agent" as const,
        label: endpoint.executionModes[0]?.label ?? "Single agent",
        fixed: true as const,
      }),
      enumerable: false,
    }),
    accessMode: Object.freeze({
      value: Object.freeze({
        value: "full-access" as const,
        label: endpoint.accessModes[0]?.label ?? "Full access",
        fixed: true as const,
        independent: true as const,
      }),
      enumerable: false,
    }),
  });
}

function samePrivateProfile(left: SessionProfile, right: SessionProfile): boolean {
  return (
    left.model === right.model &&
    left.effortLevel === right.effortLevel &&
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function continuationEndpointId(
  mappings: readonly {
    readonly endpointId: WorkbenchDirectRuntimeEndpointCatalog["endpointId"];
    readonly selectionProfile: SessionProfile;
  }[],
  recordedProfile: SessionProfile,
): WorkbenchDirectRuntimeEndpointCatalog["endpointId"] | undefined {
  const matching = mappings.find((mapping) =>
    samePrivateProfile(mapping.selectionProfile, recordedProfile),
  );
  const anchor = matching ?? mappings[0];
  if (
    anchor === undefined ||
    mappings.some((mapping) => mapping.endpointId !== anchor.endpointId)
  ) {
    return undefined;
  }
  return anchor.endpointId;
}

function completeLegacyDefaultRequest(
  request: unknown,
  snapshot: CatalogSnapshot,
): WorkbenchDirectSessionProfileDefaultRequest | undefined {
  try {
    if (
      !isRecord(request) ||
      Object.keys(request).sort().join("\0") !==
        ["modelKey", "snapshotKey", "workIntensityKey"].sort().join("\0") ||
      typeof request.snapshotKey !== "string" ||
      typeof request.modelKey !== "string" ||
      typeof request.workIntensityKey !== "string"
    ) {
      return undefined;
    }
    const publicProfile = snapshot.value.publicResult.profile;
    const matches = publicProfile.endpoints.filter((endpoint) =>
      endpoint.models.some(
        (model) =>
          model.key === request.modelKey &&
          model.workIntensities.some(
            (intensity) => intensity.key === request.workIntensityKey,
          ),
      ),
    );
    const endpoint = matches.length === 1 ? matches[0] : undefined;
    const model = endpoint?.models.find(
      (candidate) => candidate.key === request.modelKey,
    );
    const intensity = model?.workIntensities.find(
      (candidate) => candidate.key === request.workIntensityKey,
    );
    const executionMode =
      intensity?.impliedExecutionModeKey === undefined
        ? endpoint?.executionModes[0]
        : endpoint?.executionModes.find(
            (candidate) =>
              candidate.key === intensity.impliedExecutionModeKey,
          );
    const accessMode = endpoint?.accessModes[0];
    if (
      endpoint === undefined ||
      executionMode === undefined ||
      accessMode === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      snapshotKey: request.snapshotKey,
      endpointKey: endpoint.key,
      modelKey: request.modelKey,
      workIntensityKey: request.workIntensityKey,
      executionModeKey: executionMode.key,
      accessModeKey: accessMode.key,
    });
  } catch {
    return undefined;
  }
}

function toResolverPreferences(
  preferences: DirectSessionProfilePreferenceSnapshot,
  endpointPreferenceKey: string,
  baseline: SessionProfile,
  includeLegacyGlobalPreferences: boolean,
) {
  const endpoint = preferences.endpoints.find(
    (candidate) => candidate.endpointKey === endpointPreferenceKey,
  );
  const models = Object.fromEntries(
    (endpoint?.models ?? []).map((entry) => [
      entry.model,
      Object.freeze({ effortLevel: entry.workIntensity }),
    ]),
  );
  return Object.freeze({
    global: Object.freeze({
      ...baseline,
      ...(!includeLegacyGlobalPreferences ||
      preferences.global.model === undefined
        ? {}
        : { model: preferences.global.model }),
      ...(!includeLegacyGlobalPreferences ||
      preferences.global.workIntensity === undefined
        ? {}
        : { effortLevel: preferences.global.workIntensity }),
    }),
    ...(endpoint?.model === undefined
      ? {}
      : { runtime: Object.freeze({ model: endpoint.model }) }),
    ...(endpoint === undefined || endpoint.models.length === 0
      ? {}
      : { models: Object.freeze(models) }),
  });
}

function isSafePreferenceEndpointKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function sanitizeCatalog(value: unknown): DirectSessionProfileCatalog {
  if (
    !isRecord(value) ||
    !hasExactRecordShape(
      value,
      ["runtime", "models", "executionModes", "accessModes"],
      ["workIntensityExecutionModeCouplings"],
    ) ||
    !isSafeLabel(value.runtime, 80)
  ) {
    throw new Error("invalid-catalog");
  }
  if (
    !hasOnlyArrayEntries(value.models) ||
    value.models.length === 0 ||
    !isStringArray(value.executionModes) ||
    !isStringArray(value.accessModes) ||
    value.executionModes.length === 0 ||
    !value.executionModes.includes("single-agent") ||
    !value.accessModes.includes("full-access")
  ) {
    throw new Error("invalid-catalog");
  }
  const executionModes: string[] = [];
  const seenExecutionModes = new Set<string>();
  for (const executionMode of value.executionModes) {
    if (
      !isSafeLabel(executionMode, 80) ||
      seenExecutionModes.has(executionMode)
    ) {
      throw new Error("invalid-catalog");
    }
    seenExecutionModes.add(executionMode);
    executionModes.push(executionMode);
  }
  const models: RuntimeModel[] = [];
  const modelIds = new Set<string>();
  for (const candidate of value.models) {
    if (
      !isRecord(candidate) ||
      !hasExactRecordShape(
        candidate,
        ["id", "effortLevels"],
        [
          "resolvedModel",
          "displayName",
          "workIntensityLabel",
          "effortLevelLabels",
        ],
      ) ||
      !hasOnlyArrayEntries(candidate.effortLevels)
    ) {
      throw new Error("invalid-catalog");
    }
    if (!isSafeLabel(candidate.id, 80)) throw new Error("invalid-catalog");
    if (
      candidate.resolvedModel !== undefined &&
      !isSafeDisplayText(candidate.resolvedModel, 160)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.displayName !== undefined &&
      !isSafeDisplayText(candidate.displayName, 160)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.workIntensityLabel !== undefined &&
      !isSafeDisplayText(candidate.workIntensityLabel, 160)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.effortLevelLabels !== undefined &&
      (!hasOnlyArrayEntries(candidate.effortLevelLabels) ||
        candidate.effortLevelLabels.length !== candidate.effortLevels.length)
    ) {
      throw new Error("invalid-catalog");
    }
    if (
      candidate.effortLevels.length === 0 ||
      modelIds.has(candidate.id)
    ) {
      throw new Error("invalid-catalog");
    }
    const effortLevels: string[] = [];
    const effortLevelLabels: (string | null)[] = [];
    const efforts = new Set<string>();
    for (const [effortIndex, effort] of candidate.effortLevels.entries()) {
      if (!isSafeLabel(effort, 32)) throw new Error("invalid-catalog");
      if (efforts.has(effort)) throw new Error("invalid-catalog");
      const displayLabel = candidate.effortLevelLabels?.[effortIndex];
      if (
        displayLabel !== undefined &&
        displayLabel !== null &&
        !isSafeDisplayText(displayLabel, 240)
      ) {
        throw new Error("invalid-catalog");
      }
      efforts.add(effort);
      effortLevels.push(effort);
      effortLevelLabels.push(displayLabel ?? null);
    }
    if (effortLevels.length === 0) continue;
    modelIds.add(candidate.id);
    models.push(
      Object.freeze({
        id: candidate.id,
        ...(typeof candidate.resolvedModel === "string"
          ? { resolvedModel: candidate.resolvedModel }
          : {}),
        ...(typeof candidate.displayName === "string"
          ? { displayName: candidate.displayName }
          : {}),
        effortLevels: Object.freeze(effortLevels),
        ...(candidate.effortLevelLabels === undefined
          ? {}
          : { effortLevelLabels: Object.freeze(effortLevelLabels) }),
        ...(typeof candidate.workIntensityLabel === "string"
          ? { workIntensityLabel: candidate.workIntensityLabel }
          : {}),
      }),
    );
  }
  if (models.length === 0) throw new Error("invalid-catalog");
  const workIntensityExecutionModeCouplings: WorkIntensityExecutionModeCoupling[] = [];
  const coupledIntensities = new Set<string>();
  const hasWorkIntensityExecutionModeCouplings = Object.prototype.hasOwnProperty.call(
    value,
    "workIntensityExecutionModeCouplings",
  );
  if (hasWorkIntensityExecutionModeCouplings) {
    if (
      !hasOnlyArrayEntries(value.workIntensityExecutionModeCouplings) ||
      value.workIntensityExecutionModeCouplings.length > 1_000
    ) {
      throw new Error("invalid-catalog");
    }
    for (const declaration of value.workIntensityExecutionModeCouplings) {
      if (
        !isRecord(declaration) ||
        !hasExactRecordShape(declaration, [
          "model",
          "workIntensity",
          "executionMode",
        ]) ||
        !isSafeLabel(declaration.model, 80) ||
        !isSafeLabel(declaration.workIntensity, 32) ||
        !isSafeLabel(declaration.executionMode, 80)
      ) {
        throw new Error("invalid-catalog");
      }
      const model = models.find(
        (candidate) => candidate.id === declaration.model,
      );
      const key = `${declaration.model}\u0000${declaration.workIntensity}`;
      if (
        model === undefined ||
        !model.effortLevels.includes(declaration.workIntensity) ||
        !executionModes.includes(declaration.executionMode) ||
        coupledIntensities.has(key)
      ) {
        throw new Error("invalid-catalog");
      }
      coupledIntensities.add(key);
      workIntensityExecutionModeCouplings.push(
        Object.freeze({
          model: declaration.model,
          workIntensity: declaration.workIntensity,
          executionMode: declaration.executionMode,
        }),
      );
    }
  }
  return deepFreeze({
    runtime: value.runtime,
    models,
    executionModes,
    accessModes: ["full-access"],
    ...(!hasWorkIntensityExecutionModeCouplings
      ? {}
      : {
          workIntensityExecutionModeCouplings: Object.freeze(
            workIntensityExecutionModeCouplings,
          ),
        }),
  });
}

function isSafeDisplayText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    [...value].length <= maximumLength &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    !value.includes("://") &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  );
}

function isSafeLabel(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9 .+_-]*$/u.test(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    hasOnlyArrayEntries(value) &&
    value.every((candidate) => typeof candidate === "string")
  );
}

function hasExactRecordShape(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Reflect.ownKeys(value);
  return (
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function hasOnlyArrayEntries(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (key === "length") return true;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      return false;
    }
    const index = Number(key);
    return Number.isSafeInteger(index) && index < value.length;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
