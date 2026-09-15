import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, basename, dirname, extname } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import type {
  CoordinatorToolRejectedResponse,
  HandoffIdempotencyKey,
  QuotaObservation,
} from "../../src/coordinator/auto-iteration/contract.ts";
import {
  emitContextUsageObservation,
  emitQuotaObservation,
} from "../../src/coordinator/auto-iteration/capability-probe.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type { WorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type {
  AutoIterationMcpServer,
  JsonRpcRequest,
} from "../../src/workbench-shell/auto-iteration-mcp-server.ts";
import type {
  AutoIterationOverview,
  AutoIterationWorkOrderOverview,
} from "../../src/coordinator/auto-iteration/contract.ts";

/**
 * The M0 first loop, fixed end to end through production seams with a fake
 * adapter (zero real inference turns): a product-created supervisor Session
 * submits a work order through the MCP tool wire; the outbox drain starts a
 * product-created worker Session; the worker submits its handoff through the
 * same tool wire; the Coordinator persists handoff, role inbox and wakeup in
 * one transaction; the per-Session arbiter wakes the supervisor parent with a
 * bounded continue; the supervisor's review decision approves the handoff;
 * after closing and reopening the Project the whole chain is still visible in
 * the ledger. A second loop proves an old-generation supervisor cannot submit
 * a disposal after a real successor cutover.
 */

const profile: SessionProfile = Object.freeze({
  model: "fixture-model",
  effortLevel: "fixture-effort",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const catalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: profile.model,
      effortLevels: Object.freeze([profile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze([profile.executionMode]),
  accessModes: Object.freeze([profile.accessMode]),
});

const turnEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({ kind: "agent-message" as const, text: "FIXTURE_TURN_BODY" }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

class ScriptedBinding implements ResumableRuntimeBinding {
  readonly profile = profile;
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
  readonly startInputs: string[] = [];
  readonly startRequests: RuntimeStart[] = [];
  readonly resumeInputs: string[] = [];
  /** Input texts of turns that actually ran, in send order. */
  readonly sentInputs: string[] = [];
  /** Interleaved resume/send trace for diagnosis. */
  readonly trace: string[] = [];
  private readonly onStart?: (request: RuntimeStart) => Promise<void>;
  private readonly onResume?: (request: RuntimeResume) => Promise<void>;
  #startGate: Promise<void> | undefined;
  #releaseStartGate: (() => void) | undefined;

  constructor(
    onStart?: (request: RuntimeStart) => Promise<void>,
    onResume?: (request: RuntimeResume) => Promise<void>,
  ) {
    this.onStart = onStart;
    this.onResume = onResume;
  }

  /**
   * w338: holds the NEXT adapter.start call open so a test can observe the
   * ledger while the outbox drain is blocked mid-dispatch, then let it run.
   */
  gateNextStart(): void {
    this.#startGate = new Promise<void>((resolve) => {
      this.#releaseStartGate = resolve;
    });
  }

  releaseStart(): void {
    this.#releaseStartGate?.();
    this.#startGate = undefined;
    this.#releaseStartGate = undefined;
  }

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    assert.equal(request.profile.model, profile.model);
    if (this.#startGate !== undefined) await this.#startGate;
    this.startInputs.push(request.profile.model);
    this.startRequests.push(request);
    await this.onStart?.(request);
    return new ScriptedBinding(`native-start-${this.startInputs.length}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.trace.push(`resume:${request.opaqueSessionReference}`);
    await this.onResume?.(request);
    this.resumeInputs.push(request.profile.model);
    const binding = new ScriptedBinding(request.opaqueSessionReference);
    const innerSend = binding.send.bind(binding);
    binding.send = async (input: RuntimeInput) => {
      this.trace.push(`send:${input.text.slice(0, 80)}`);
      this.sentInputs.push(input.text);
      await innerSend(input);
    };
    return binding;
  }
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Auto Iteration Test",
      GIT_AUTHOR_EMAIL: "auto-iteration@example.invalid",
      GIT_COMMITTER_NAME: "Auto Iteration Test",
      GIT_COMMITTER_EMAIL: "auto-iteration@example.invalid",
    },
    windowsHide: true,
  });
  return result.stdout.trim();
}

interface Harness {
  readonly backend: WorkbenchBackend;
  readonly adapter: ScriptedLoopAdapter;
  readonly projectDirectory: string;
  readonly databasePath: string;
  readonly baselineCommitSha: string;
  readonly root: string;
}

async function createHarness(prefix: string): Promise<Harness> {
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, prefix));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  await git(projectDirectory, "init", "--initial-branch=demo");
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await git(projectDirectory, "add", "baseline.txt");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");
  const databasePath = join(root, "workbench.sqlite");
  const adapter = new ScriptedLoopAdapter();
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  return {
    backend,
    adapter,
    projectDirectory,
    databasePath,
    baselineCommitSha,
    root,
  };
}

async function waitFor<T>(
  describe: string,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${describe}`);
}

let jsonRpcId = 0;

/** Windows releases the SQLite handle a beat after close; drain retries rm. */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== "EBUSY") {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function callTool(
  server: AutoIterationMcpServer,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: (jsonRpcId += 1),
    method: "tools/call",
    params: { name, arguments: arguments_ },
  };
  const response = await server.handle(request);
  assert.ok(response !== null, `${name} produced no response`);
  if (!("result" in response)) {
    throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  }
  const result = response.result as { content?: Array<{ type: string; text: string }> };
  assert.ok(
    Array.isArray(result.content) && result.content[0]?.type === "text",
    `${name} returned no text content`,
  );
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function findWorkOrder(
  overview: AutoIterationOverview,
  workOrderId: string,
): AutoIterationWorkOrderOverview | undefined {
  const order = overview.workOrders.find(
    (candidate) => candidate.workOrderId === workOrderId,
  );
  return order === undefined ? undefined : order;
}

function workOrderSubmission(
  workerProfile: SessionProfile,
  baselineCommitSha = "0123456789abcdef0123456789abcdef01234567",
) {
  return {
    objective: "Summarize the fixture repository",
    acceptanceCriteria: ["summary mentions the fixture"],
    baselineCommitSha,
    territory: { writePaths: ["src/"], readOnlyPaths: ["docs/"] },
    responsibleRoleSlotId: "project-supervisor",
    completionCondition: { gitIntegration: "not-required" },
    workerSession: {
      endpointId: "codex-desktop",
      profile: workerProfile,
    },
    // These cases exercise M0-M2 attempt/integration/recovery mechanics, not
    // issue #8 M3 independent review; opt out so submit-review-decision
    // isn't refused and no Review Attempt Session starts underneath them.
    review: "none" as const,
  };
}

async function startSupervisor(
  backend: WorkbenchBackend,
  openingInput: string,
): Promise<string> {
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");
  const sessionId = await service.startHostSession({
    endpointId: "codex-desktop",
    profile,
    input: openingInput,
  });
  assert.ok(typeof sessionId === "string", "the host Session must start");
  return sessionId;
}

test("the first loop runs end to end through production seams and survives a Project reopen", async (t) => {
  const harness = await createHarness("auto-iteration-m0-");
  let reopenedBackend: WorkbenchBackend | undefined;
  t.after(async () => {
    await reopenedBackend?.close().catch(() => undefined);
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  // The supervisor parent is a product-created Session.
  const supervisorSessionId = await startSupervisor(
    harness.backend,
    "supervisor opening turn",
  );
  const binding = await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  assert.equal(binding.generation, 1);

  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "m0-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;

  // The outbox drain starts the worker through the production Session seam.
  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });
  assert.notEqual(workerSessionId, supervisorSessionId);

  // The worker delivers through the same tool wire a CLI bootstrap would use.
  const workerServer = service.mcpServerForSession(workerSessionId);
  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-m0-1",
  };
  const handoff = await callTool(workerServer, "submit_handoff", {
    requestIdempotencyKey: "m0-handoff-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    handoff: {
      idempotencyKey: handoffKey,
      body: "The fixture summary is complete.",
      artifactIds: [],
    },
  });
  assert.equal(handoff.kind, "handoff-submitted");
  assert.equal(
    (handoff.receipt as Record<string, unknown>).level,
    "persisted",
  );

  // The parent is woken with a bounded summary input on the per-Session
  // arbiter; an empty inbox never produced a model turn before the handoff.
  assert.equal(harness.adapter.resumeInputs.length, 0);
  await waitFor("supervisor wakeup turn", () =>
    harness.adapter.resumeInputs.length === 1
      ? harness.adapter.resumeInputs
      : undefined,
  );
  await waitFor("wakeup settle in the ledger", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "inbox-wakeup",
    );
    return pending.length === 0 ? pending : undefined;
  });
  const awaiting = findWorkOrder(
    service.authority.readAutoIterationOverview(),
    workOrderId,
  );
  assert.equal(awaiting?.status, "awaiting-review");
  assert.equal(harness.adapter.resumeInputs.length, 1);

  const decided = await callTool(supervisorServer, "submit_review_decision", {
    requestIdempotencyKey: "m0-review-1",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    decision: {
      decision: "approve",
      handoff: handoffKey,
      handoffVersion: 1,
      reason: "acceptance criteria met",
    },
  });
  assert.equal(decided.kind, "review-decision-submitted");

  const finalOrder = await waitFor("approved work order", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.integrated ? order : undefined;
  });
  assert.equal(finalOrder.delivered, true);
  assert.equal(finalOrder.reviewDecided, true);

  // Closing and reopening the Project keeps the whole chain ledger-visible.
  await harness.backend.close();
  const reopenedAdapter = new ScriptedLoopAdapter();
  reopenedBackend = await createWorkbenchBackend({
    projectDirectory: harness.projectDirectory,
    databasePath: harness.databasePath,
    adapter: reopenedAdapter,
  });
  const reopenedService = reopenedBackend.autoIteration;
  assert.ok(reopenedService, "the reopened backend exposes the service");
  const reopenedOverview = reopenedService.authority.readAutoIterationOverview();
  assert.equal(reopenedOverview.supervisor?.generation, 1);
  assert.equal(
    reopenedOverview.supervisor?.sessionId,
    supervisorSessionId,
    "reopened ledger still names the first supervisor Session",
  );
  const reopenedOrder = findWorkOrder(reopenedOverview, workOrderId);
  assert.equal(reopenedOrder?.status, "integrated");
  assert.equal(reopenedOrder?.workerSessionId, workerSessionId);
  assert.equal(reopenedOrder?.delivered, true);
  assert.equal(reopenedOrder?.reviewDecided, true);

  // The reopened bindings serve the same tool wire without a second bind call.
  const reopenedStatus = await callTool(
    reopenedService.mcpServerForSession(supervisorSessionId),
    "read_work_order_status",
    {
      requestIdempotencyKey: "m0-reopen-read-1",
      expectedVersion: 3,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      workOrderId,
    },
  );
  assert.equal(reopenedStatus.kind, "work-order-status");
  const receipts = reopenedStatus.receipts as Array<Record<string, unknown>>;
  const levels = receipts.map((receipt) => receipt.level).sort();
  assert.deepEqual(levels, [
    "disposed",
    "included-in-parent-input",
    "persisted",
  ]);
});

test("an old-generation supervisor cannot submit a disposal after a real successor cutover", async (t) => {
  const harness = await createHarness("auto-iteration-cutover-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(
    harness.backend,
    "first supervisor opening turn",
  );
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "cutover-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;
  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });
  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-cutover-1",
  };
  const handoff = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "cutover-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "Delivered before the rotation.",
        artifactIds: [],
      },
    },
  );
  assert.equal(handoff.kind, "handoff-submitted");
  await waitFor("supervisor wakeup turn", () =>
    harness.adapter.resumeInputs.length === 1
      ? harness.adapter.resumeInputs
      : undefined,
  );
  await waitFor("wakeup settle in the ledger", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "inbox-wakeup",
    );
    return pending.length === 0 ? pending : undefined;
  });

  // A real successor Session must exist before the ledger completes cutover.
  const rotation = await callTool(
    supervisorServer,
    "request_supervisor_rotation",
    {
      requestIdempotencyKey: "cutover-rotate-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      roleSlotId: "project-supervisor",
      successorSession: { endpointId: "codex-desktop", profile },
    },
  );
  assert.equal(rotation.kind, "supervisor-rotation-requested");
  assert.equal(
    (rotation.tenure as Record<string, unknown>).status,
    "successor-preparing",
  );

  const successorOverview = await waitFor("successor cutover", () => {
    const overview = service.authority.readAutoIterationOverview();
    return overview.supervisor?.generation === 2 &&
      overview.supervisor.sessionId !== supervisorSessionId
      ? overview
      : undefined;
  });
  const successorSessionId = successorOverview.supervisor!.sessionId!;

  // The old generation is refused at the ledger even with a well-formed actor.
  const staleRejection = await service.authority.request(
    {
      kind: "supervisor",
      sessionId: supervisorSessionId,
      tenure: { roleSlotId: "project-supervisor", generation: 1 },
    },
    {
      kind: "submit-review-decision",
      requestIdempotencyKey: "cutover-stale-decision-1",
      expectedVersion: 2,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      decision: {
        decision: "approve",
        handoff: handoffKey,
        handoffVersion: 1,
        reason: "must be refused for the retired generation",
      },
    },
  );
  assert.equal(staleRejection.kind, "rejected");
  assert.equal(
    (staleRejection as CoordinatorToolRejectedResponse).category,
    "stale-generation",
  );

  // And the old Session's own tool wire no longer carries a live actor.
  const oldServerRejection = await callTool(
    supervisorServer,
    "submit_review_decision",
    {
      requestIdempotencyKey: "cutover-old-server-1",
      expectedVersion: 2,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      decision: {
        decision: "approve",
        handoff: handoffKey,
        handoffVersion: 1,
        reason: "must be refused after unbind",
      },
    },
  );
  assert.equal(oldServerRejection.kind, "rejected");
  assert.equal(oldServerRejection.category, "forbidden");

  // The successor generation can still dispose the same handoff.
  const successorDecision = await callTool(
    service.mcpServerForSession(successorSessionId),
    "submit_review_decision",
    {
      requestIdempotencyKey: "cutover-successor-decision-1",
      expectedVersion: 2,
      observedTenure: { roleSlotId: "project-supervisor", generation: 2 },
      decision: {
        decision: "approve",
        handoff: handoffKey,
        handoffVersion: 1,
        reason: "successor accepts",
      },
    },
  );
  assert.equal(successorDecision.kind, "review-decision-submitted");
  const finalOrder = await waitFor("successor disposal", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.integrated ? order : undefined;
  });
  assert.equal(finalOrder.status, "integrated");
});

/**
 * w338, issue #8 Lane C consumers through the production probe wiring: a
 * high-context observation of the ACTIVE supervisor's own Session (the
 * #8 §3 threshold is 70%) drives the same `request_supervisor_rotation`
 * chain the supervisor tool drives — the tenure parks at
 * `successor-preparing` and a real successor Session completes the cutover.
 */
test("a high-context observation rotates the supervisor through successor-preparing", async (t) => {
  const harness = await createHarness("auto-iteration-context-rotate-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(
    harness.backend,
    "context rotation supervisor opening turn",
  );
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });

  // Hold the successor Session start open so the parked tenure is
  // observable deterministically before the cutover completes.
  harness.adapter.gateNextStart();
  const accepted = await emitContextUsageObservation({
    source: "claude-control:get_context_usage",
    observedAt: Date.now(),
    sessionId: supervisorSessionId,
    model: profile.model,
    quality: "authoritative",
    totalTokens: 800_000,
    maxTokens: 1_000_000,
    fraction: 0.8,
  });
  assert.equal(accepted, true, "the backend wired the authority as the context sink");

  const preparing = await waitFor("successor-preparing tenure", () => {
    const supervisor = service.authority.readAutoIterationOverview().supervisor;
    return supervisor?.status === "successor-preparing" ? supervisor : undefined;
  });
  assert.equal(preparing.generation, 1, "the incumbent generation parks, it is not replaced in place");

  harness.adapter.releaseStart();
  const cutover = await waitFor("successor cutover", () => {
    const overview = service.authority.readAutoIterationOverview();
    return overview.supervisor?.generation === 2 &&
      overview.supervisor.sessionId !== supervisorSessionId
      ? overview
      : undefined;
  });
  assert.equal(cutover.supervisor?.status, "active");
});

/**
 * w338, issue #8 §3 quota projection: a Codex account read that positively
 * establishes exhaustion blocks new worker dispatch through the durable
 * outbox (the entry stays pending, nothing is lost), and a fresh read that
 * establishes availability releases both the Work Order and the dispatch.
 */
test("a quota-exhausted observation blocks the projection and new worker dispatch until availability", async (t) => {
  const harness = await createHarness("auto-iteration-quota-block-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(
    harness.backend,
    "quota supervisor opening turn",
  );
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "quota-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });
  assert.notEqual(workerSessionId, supervisorSessionId);
  const startsBeforeExhaustion = harness.adapter.startInputs.length;

  const blocked = await emitQuotaObservation(
    Object.freeze({
      quotaPoolId: "codex-account:codex",
      source: "codex-account:account/rateLimits/read" as const,
      observedAt: Date.now(),
      status: "observed" as const,
      windows: Object.freeze([
        Object.freeze({
          name: "primary",
          usedFraction: 1,
          resetsAt: Date.now() + 60_000,
          windowDurationMinutes: 10_080,
        }),
        Object.freeze({
          name: "secondary",
          usedFraction: null,
          resetsAt: null,
          windowDurationMinutes: null,
        }),
      ]),
    }) satisfies QuotaObservation,
  );
  assert.equal(blocked, true, "the backend wired the authority as the quota sink");

  await waitFor("quotaWaiting projection input", () =>
    service.authority.readAutoIterationOverview().quotaWaiting ? true : undefined,
  );
  const blockedOrder = await waitFor("blocked work order", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.status === "waiting-for-quota" ? order : undefined;
  });
  assert.equal(blockedOrder.status, "waiting-for-quota");

  // A second work order submitted while blocked must NOT dispatch a worker;
  // its start-attempt entry stays pending in the durable outbox.
  const submittedWhileBlocked = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "quota-submit-2",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  assert.equal(submittedWhileBlocked.kind, "work-order-submitted");
  const blockedWorkOrderId = (submittedWhileBlocked.workOrder as Record<string, unknown>)
    .workOrderId as string;
  await waitFor("blocked dispatch attempt", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "start-attempt",
    );
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      blockedWorkOrderId,
    );
    return pending.length >= 1 && order?.workerSessionBound === false ? order : undefined;
  });
  assert.equal(
    harness.adapter.startInputs.length,
    startsBeforeExhaustion,
    "no new worker Session is started while the account is quota-blocked",
  );

  // A fresh read establishing availability releases the Work Order and the
  // pending dispatch proceeds through the same outbox.
  await emitQuotaObservation(
    Object.freeze({
      quotaPoolId: "codex-account:codex",
      source: "codex-account:account/rateLimits/read" as const,
      observedAt: Date.now(),
      status: "observed" as const,
      windows: Object.freeze([
        Object.freeze({
          name: "primary",
          usedFraction: 0.4,
          resetsAt: Date.now() + 3_600_000,
          windowDurationMinutes: 10_080,
        }),
        Object.freeze({
          name: "secondary",
          usedFraction: null,
          resetsAt: null,
          windowDurationMinutes: null,
        }),
      ]),
    }) satisfies QuotaObservation,
  );
  await waitFor("released work order", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.status === "executing" ? order : undefined;
  });
  const dispatched = await waitFor("released worker dispatch", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      blockedWorkOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });
  assert.notEqual(dispatched, supervisorSessionId);
  assert.equal(harness.adapter.startInputs.length, startsBeforeExhaustion + 1);
});

test("an integration-required attempt runs in one managed worktree and persists its frozen candidate", async (t) => {
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "auto-iteration-worktree-"));
  const remoteDirectory = join(root, "remote.git");
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await git(root, "init", "--bare", "--initial-branch=demo", remoteDirectory);
  await git(root, "clone", remoteDirectory, projectDirectory);
  await git(projectDirectory, "config", "user.name", "Auto Iteration Test");
  await git(
    projectDirectory,
    "config",
    "user.email",
    "auto-iteration@example.invalid",
  );
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  // The fixed integration gates call `pnpm.bat` inside the integration
  // worktree; the fixture ships an exit-0 stub so the loop can complete.
  await writeFile(
    join(projectDirectory, "pnpm.bat"),
    "@echo off\r\necho %1 gate passed\r\nexit /b 0\r\n",
    "utf8",
  );
  await git(projectDirectory, "add", "baseline.txt", "pnpm.bat");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  await git(projectDirectory, "push", "-u", "origin", "demo");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");

  let workerCommitSha: string | undefined;
  const adapter = new ScriptedLoopAdapter(async (request) => {
    if (request.projectDirectory === projectDirectory) return;
    await writeFile(
      join(request.projectDirectory, "worker-delivery.txt"),
      "delivered from isolated attempt\n",
      "utf8",
    );
    await git(request.projectDirectory, "add", "worker-delivery.txt");
    await git(request.projectDirectory, "commit", "-m", "feat: worker delivery");
    workerCommitSha = await git(request.projectDirectory, "rev-parse", "HEAD");
  });
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  let reopenedBackend: WorkbenchBackend | undefined;
  t.after(async () => {
    await reopenedBackend?.close().catch(() => undefined);
    await backend.close().catch(() => undefined);
    await removeTree(root);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(
    backend,
    "integration supervisor opening turn",
  );
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "integration-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      ...workOrderSubmission(profile),
      baselineCommitSha,
      completionCondition: { gitIntegration: "required" },
    },
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;

  await Promise.all([
    service.drainPendingOutbox(),
    service.drainPendingOutbox(),
  ]);
  const workerSessionId = await waitFor("isolated worker Session", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound && workerCommitSha !== undefined
      ? order.workerSessionId ?? undefined
      : undefined;
  });
  const workerStarts = adapter.startRequests.filter(
    (request) => request.projectDirectory !== projectDirectory,
  );
  assert.equal(workerStarts.length, 1, "the same attempt must not start twice");
  await assert.rejects(
    service.authority.bindAttemptSession({
      attemptId,
      sessionId: "duplicate-worker-session",
    }),
    /attempt-session-conflict/u,
    "a second Session cannot enter the same attempt",
  );
  const attemptDirectory = workerStarts[0]!.projectDirectory;
  assert.notEqual(attemptDirectory, projectDirectory);
  assert.equal(
    relative(projectDirectory, attemptDirectory).startsWith(".."),
    true,
    "the attempt worktree must not be nested in the Project",
  );
  assert.match(
    await git(attemptDirectory, "branch", "--show-current"),
    new RegExp(`${workOrderId}.*1`, "u"),
  );

  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-integration-1",
  };
  const handoff = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "integration-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "The committed worker delivery is ready for review.",
        artifactIds: [],
      },
    },
  );
  assert.equal(handoff.kind, "handoff-submitted");
  await waitFor("integration handoff wakeup", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "inbox-wakeup",
    );
    return pending.length === 0 ? pending : undefined;
  });

  const beforeReview = await callTool(
    supervisorServer,
    "read_work_order_status",
    {
      requestIdempotencyKey: "integration-read-before-review",
      expectedVersion: 2,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      workOrderId,
    },
  );
  const capturedArtifacts = (
    beforeReview.handoffs as Array<{ artifacts: Array<Record<string, unknown>> }>
  )[0]!.artifacts;
  assert.equal(
    capturedArtifacts.some(
      (artifact) =>
        artifact.kind === "git-commit" && artifact.commitSha === workerCommitSha,
    ),
    true,
    "submit_handoff must carry the host-captured worker commit",
  );
  assert.equal(
    capturedArtifacts.some((artifact) => artifact.kind === "execution-job"),
    true,
    "the handoff must retain the capture job identity",
  );

  const decided = await callTool(supervisorServer, "submit_review_decision", {
    requestIdempotencyKey: "integration-review-1",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    decision: {
      decision: "approve",
      handoff: handoffKey,
      handoffVersion: 1,
      reason: "the isolated commit meets the criterion",
    },
  });
  assert.equal(decided.kind, "review-decision-submitted");

  const withCandidate = await waitFor("persisted integration candidate", async () => {
    const status = await callTool(
      supervisorServer,
      "read_work_order_status",
      {
        requestIdempotencyKey: "integration-read-candidate",
        expectedVersion: 3,
        observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
        workOrderId,
      },
    );
    return Array.isArray(status.candidates) && status.candidates.length === 1
      ? status
      : undefined;
  });
  assert.equal(
    (withCandidate.workOrder as Record<string, unknown>).status,
    "awaiting-integration",
  );
  const candidate = (
    withCandidate.candidates as Array<Record<string, unknown>>
  )[0]!;
  assert.deepEqual(candidate.orderedCommitShas, [workerCommitSha]);
  assert.equal(
    (await service.authority.readPendingOutbox()).some(
      (entry) => entry.kind === "review-disposed",
    ),
    false,
    "candidate construction completes the review-disposed outbox entry",
  );

  const replayedHandoff = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "integration-handoff-replay-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "The committed worker delivery is ready for review.",
        artifactIds: [],
      },
    },
  );
  assert.equal(
    replayedHandoff.kind,
    "handoff-submitted",
    "a handoff retry remains idempotent after its attempt worktree is reclaimed",
  );

  await backend.close();
  reopenedBackend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter: new ScriptedLoopAdapter(),
  });
  const reopenedService = reopenedBackend.autoIteration;
  assert.ok(reopenedService);
  const reopenedStatus = await callTool(
    reopenedService.mcpServerForSession(supervisorSessionId),
    "read_work_order_status",
    {
      requestIdempotencyKey: "integration-read-reopened",
      // The integration outcome advanced the lifecycle one step past the
      // candidate (awaiting-integration v3 -> integrated v4).
      expectedVersion: 4,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      workOrderId,
    },
  );
  assert.equal(
    (reopenedStatus.candidates as Array<Record<string, unknown>>).length,
    1,
    "the frozen candidate must survive a Project reopen",
  );
  assert.equal(
    (reopenedStatus.workOrder as Record<string, unknown>).status,
    "integrated",
    "the fixture gates are green stubs, so the product integrates the candidate itself",
  );
});

test("the product integrates an approved frozen candidate itself: approve -> awaiting-integration -> integration job -> integrated", async (t) => {
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "auto-iteration-integrates-"));
  const remoteDirectory = join(root, "remote.git");
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await git(root, "init", "--bare", "--initial-branch=demo", remoteDirectory);
  await git(root, "clone", remoteDirectory, projectDirectory);
  await git(projectDirectory, "config", "user.name", "Auto Iteration Test");
  await git(
    projectDirectory,
    "config",
    "user.email",
    "auto-iteration@example.invalid",
  );
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  // Fixed gate stub: the integration gates call `pnpm.bat` inside the
  // integration worktree; exit 0 lets the loop reach the local target merge.
  await writeFile(
    join(projectDirectory, "pnpm.bat"),
    "@echo off\r\necho %1 gate passed\r\nexit /b 0\r\n",
    "utf8",
  );
  await git(projectDirectory, "add", "baseline.txt", "pnpm.bat");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  await git(projectDirectory, "push", "-u", "origin", "demo");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");

  let workerCommitSha: string | undefined;
  const adapter = new ScriptedLoopAdapter(async (request) => {
    if (request.projectDirectory === projectDirectory) return;
    await writeFile(
      join(request.projectDirectory, "worker-delivery.txt"),
      "delivered for integration\n",
      "utf8",
    );
    await git(request.projectDirectory, "add", "worker-delivery.txt");
    await git(request.projectDirectory, "commit", "-m", "feat: worker delivery");
    workerCommitSha = await git(request.projectDirectory, "rev-parse", "HEAD");
  });
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  let reopenedBackend: WorkbenchBackend | undefined;
  t.after(async () => {
    await reopenedBackend?.close().catch(() => undefined);
    await backend.close().catch(() => undefined);
    await removeTree(root);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(
    backend,
    "integration job supervisor opening turn",
  );
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "integrates-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      ...workOrderSubmission(profile),
      baselineCommitSha,
      completionCondition: { gitIntegration: "required" },
    },
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;

  await Promise.all([
    service.drainPendingOutbox(),
    service.drainPendingOutbox(),
  ]);
  const workerSessionId = await waitFor("isolated worker Session", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound && workerCommitSha !== undefined
      ? order.workerSessionId ?? undefined
      : undefined;
  });

  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-integrates-1",
  };
  const handoff = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "integrates-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "The committed delivery is ready for the product's own integration.",
        artifactIds: [],
      },
    },
  );
  assert.equal(handoff.kind, "handoff-submitted");
  await waitFor("integration handoff wakeup", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "inbox-wakeup",
    );
    return pending.length === 0 ? pending : undefined;
  });

  const decided = await callTool(supervisorServer, "submit_review_decision", {
    requestIdempotencyKey: "integrates-review-1",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    decision: {
      decision: "approve",
      handoff: handoffKey,
      handoffVersion: 1,
      reason: "the isolated commit meets the criterion",
    },
  });
  assert.equal(decided.kind, "review-decision-submitted");

  // The outbox drain builds the frozen candidate, then the product's own
  // integration job merges it through the fixed gates into the local target.
  const integrated = await waitFor("product-run integration", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.status === "integrated" ? order : undefined;
  });
  assert.equal(integrated.delivered, true);
  assert.equal(integrated.reviewDecided, true);

  const status = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "integrates-read-outcome",
    expectedVersion: 4,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrderId,
  });
  assert.equal(status.kind, "work-order-status");
  const candidate = (status.candidates as Array<Record<string, unknown>>)[0]!;
  const outcome = candidate.outcome as Record<string, unknown>;
  assert.equal(outcome.status, "integrated");
  const gates = outcome.gates as Array<Record<string, unknown>>;
  assert.deepEqual(
    gates.map((gate) => gate.gate),
    ["build", "typecheck"],
    "issue-8-m3-v1 runs build and typecheck when no shard glob is selected",
  );
  assert.ok(gates.every((gate) => gate.passed === true));
  const mergeCommitSha = outcome.mergeCommitSha as string;
  assert.equal(
    await git(projectDirectory, "rev-parse", "refs/heads/demo"),
    mergeCommitSha,
    "the LOCAL target branch carries the integration merge commit",
  );
  assert.equal(
    await git(projectDirectory, "rev-parse", `refs/heads/demo^{tree}`),
    (candidate.mergeTreeSha as string),
    "the landed tree is exactly the frozen candidate tree",
  );
  const remoteTip = await git(remoteDirectory, "rev-parse", "refs/heads/demo");
  assert.equal(
    remoteTip,
    baselineCommitSha,
    "nothing was pushed: publishing stays out of this cut",
  );

  // Closing and reopening the Project must not re-run a finished integration.
  const jobsRoot = join(root, "attempts", "workbench", "jobs");
  const recordsBefore = (await readdir(jobsRoot)).filter((name) =>
    name.endsWith(".json"),
  ).sort();
  assert.ok(recordsBefore.length > 0, "the integration left durable job records");
  await backend.close();
  reopenedBackend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter: new ScriptedLoopAdapter(),
  });
  const reopenedService = reopenedBackend.autoIteration;
  assert.ok(reopenedService);
  await reopenedService.drainPendingOutbox();
  const reopenedOrder = findWorkOrder(
    reopenedService.authority.readAutoIterationOverview(),
    workOrderId,
  );
  assert.equal(reopenedOrder?.status, "integrated");
  const recordsAfter = (await readdir(jobsRoot)).filter((name) =>
    name.endsWith(".json"),
  ).sort();
  assert.deepEqual(
    recordsAfter,
    recordsBefore,
    "an already integrated candidate is never re-run after reopen",
  );
  assert.equal(
    await git(projectDirectory, "rev-parse", "refs/heads/demo"),
    mergeCommitSha,
    "the local target branch did not move again",
  );
});
test("handoffs arriving during a supervisor turn wake once at the boundary with one merged summary", async (t) => {
  // The first supervisor wakeup turn is held open, so the later handoff
  // entries stay pending (same-Session arbitration); when the turn ends the
  // boundary drain must wake the idle parent ONCE with a bounded summary
  // carrying every still-pending handoff (issue #8 §3 wakeup, M1 merge).
  let gate: Promise<void> | undefined;
  let gateResolve!: () => void;
  const adapter = new ScriptedLoopAdapter(undefined, async () => {
    if (gate === undefined) {
      gate = new Promise<void>((resolve) => {
        gateResolve = resolve;
      });
      await gate;
    }
  });
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "auto-iteration-m1-parallel-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  await git(projectDirectory, "init", "--initial-branch=demo");
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await git(projectDirectory, "add", "baseline.txt");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "workbench.sqlite"),
    adapter,
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    await removeTree(root);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(backend, "m1 supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);

  const submittedOrders: Array<{ workOrderId: string; attemptId: string }> = [];
  for (const key of ["m1-parallel-submit-a", "m1-parallel-submit-b", "m1-parallel-submit-c"]) {
    const submitted = await callTool(supervisorServer, "submit_work_order", {
      requestIdempotencyKey: key,
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      workOrder: workOrderSubmission(profile, baselineCommitSha),
    });
    assert.equal(submitted.kind, "work-order-submitted");
    submittedOrders.push({
      workOrderId: (submitted.workOrder as Record<string, unknown>).workOrderId as string,
      attemptId: (submitted.attempt as Record<string, unknown>).attemptId as string,
    });
  }

  // Three worker Sessions run at the same time, in distinct worktrees.
  const workerSessions: string[] = [];
  for (const order of submittedOrders) {
    workerSessions.push(
      await waitFor(`worker Session for ${order.workOrderId}`, () => {
        const found = findWorkOrder(
          service.authority.readAutoIterationOverview(),
          order.workOrderId,
        );
        return found?.workerSessionBound ? found.workerSessionId ?? undefined : undefined;
      }),
    );
  }
  assert.equal(new Set(workerSessions).size, 3, "three distinct worker Sessions");
  for (const workerSessionId of workerSessions) {
    assert.notEqual(workerSessionId, supervisorSessionId);
  }
  const workerDirectories = adapter.startRequests
    .map((request) => request.projectDirectory)
    .filter((directory) => directory !== projectDirectory);
  assert.equal(workerDirectories.length, 3, "three workers must really overlap");
  assert.equal(new Set(workerDirectories).size, 3, "worker worktrees must differ");

  // The first handoff opens a wakeup turn; the test holds that turn open.
  const firstHandoff = await callTool(
    service.mcpServerForSession(workerSessions[0]!),
    "submit_handoff",
    {
      requestIdempotencyKey: "m1-parallel-handoff-0",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: {
          workOrderId: submittedOrders[0]!.workOrderId,
          attemptId: submittedOrders[0]!.attemptId,
          handoffId: "handoff-m1-parallel-0",
        },
        body: "Delivery 0 is complete.",
        artifactIds: [],
      },
    },
  );
  assert.equal(firstHandoff.kind, "handoff-submitted");
  await waitFor("the first wakeup turn to open", () =>
    adapter.trace.length === 1 ? adapter.trace : undefined,
  );

  // The other two handoffs arrive while the parent is mid-turn: their wakeup
  // entries must stay pending until the turn boundary.
  for (const index of [1, 2]) {
    const handoff = await callTool(
      service.mcpServerForSession(workerSessions[index]!),
      "submit_handoff",
      {
        requestIdempotencyKey: `m1-parallel-handoff-${index}`,
        expectedVersion: 1,
        observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
        handoff: {
          idempotencyKey: {
            workOrderId: submittedOrders[index]!.workOrderId,
            attemptId: submittedOrders[index]!.attemptId,
            handoffId: `handoff-m1-parallel-${index}`,
          },
          body: `Delivery ${index} is complete.`,
          artifactIds: [],
        },
      },
    );
    assert.equal(handoff.kind, "handoff-submitted");
  }
  assert.equal(adapter.trace.length, 1, "no second wakeup may start mid-turn");
  gateResolve();

  await waitFor("all three work orders awaiting review", () => {
    const overview = service.authority.readAutoIterationOverview();
    return submittedOrders.every(
      (order) => findWorkOrder(overview, order.workOrderId)?.status === "awaiting-review",
    )
      ? overview
      : undefined;
  });
  await waitFor("wakeup settle in the ledger", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "inbox-wakeup",
    );
    return pending.length === 0 ? pending : undefined;
  });
  assert.equal(
    adapter.resumeInputs.length,
    2,
    `exactly two wakeup turns: ${JSON.stringify(adapter.trace)}`,
  );
  assert.equal(adapter.sentInputs.length, 2, "two wakeup turns ran");
  const boundaryText = adapter.sentInputs[1] ?? "";
  assert.equal(
    boundaryText.includes(submittedOrders[1]!.workOrderId) &&
      boundaryText.includes(submittedOrders[2]!.workOrderId),
    true,
    `the boundary wakeup must carry both pending handoffs: ${boundaryText}`,
  );
  assert.equal(
    boundaryText.includes(submittedOrders[0]!.workOrderId),
    false,
    "the first handoff already rode the first wakeup",
  );

  const statuses = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "m1-parallel-read-b",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrderId: submittedOrders[1]!.workOrderId,
  });
  const statuses2 = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "m1-parallel-read-c",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrderId: submittedOrders[2]!.workOrderId,
  });
  const includedReceipt = (statuses.receipts as Array<Record<string, unknown>>).find(
    (receipt) => receipt.level === "included-in-parent-input",
  );
  const includedReceipt2 = (statuses2.receipts as Array<Record<string, unknown>>).find(
    (receipt) => receipt.level === "included-in-parent-input",
  );
  assert.ok(includedReceipt, "the second handoff has an inclusion receipt");
  assert.ok(includedReceipt2, "the third handoff has an inclusion receipt");
  assert.equal(
    includedReceipt!.parentCommandId,
    includedReceipt2!.parentCommandId,
    "one parent command carried both handoffs",
  );
});

test("the fifth work order queues until a delivery frees a worker slot", async (t) => {
  const harness = await createHarness("auto-iteration-m1-cap-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(harness.backend, "m1 cap supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);

  const orders: Array<{ workOrderId: string; attemptId: string }> = [];
  for (let index = 0; index < 5; index += 1) {
    const submitted = await callTool(supervisorServer, "submit_work_order", {
      requestIdempotencyKey: `m1-cap-submit-${index}`,
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
    });
    assert.equal(submitted.kind, "work-order-submitted");
    orders.push({
      workOrderId: (submitted.workOrder as Record<string, unknown>).workOrderId as string,
      attemptId: (submitted.attempt as Record<string, unknown>).attemptId as string,
    });
  }

  const workerStartDirectories = () =>
    harness.adapter.startRequests
      .map((request) => request.projectDirectory)
      .filter((directory) => directory !== harness.projectDirectory);

  await waitFor("the first four workers", () => {
    const overview = service.authority.readAutoIterationOverview();
    const bound = orders
      .slice(0, 4)
      .filter((order) => findWorkOrder(overview, order.workOrderId)?.workerSessionBound);
    return bound.length === 4 ? overview : undefined;
  });
  const overview = service.authority.readAutoIterationOverview();
  assert.equal(workerStartDirectories().length, 4, "the cap holds four workers");
  assert.equal(new Set(workerStartDirectories()).size, 4, "worktrees stay isolated");
  assert.equal(
    findWorkOrder(overview, orders[4]!.workOrderId)?.status,
    "queued",
    "the fifth work order reads as queued",
  );

  // A delivery frees a slot and the queued order auto-starts.
  const firstWorkerSessionId = await waitFor("first worker Session", () => {
    const found = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      orders[0]!.workOrderId,
    );
    return found?.workerSessionId ?? undefined;
  });
  const handoff = await callTool(
    service.mcpServerForSession(firstWorkerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "m1-cap-handoff-0",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: {
          workOrderId: orders[0]!.workOrderId,
          attemptId: orders[0]!.attemptId,
          handoffId: "handoff-m1-cap-0",
        },
        body: "First delivery done.",
        artifactIds: [],
      },
    },
  );
  assert.equal(handoff.kind, "handoff-submitted");
  const fifth = await waitFor("the queued order to auto-start", () => {
    const found = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      orders[4]!.workOrderId,
    );
    return found?.workerSessionBound && found.status === "executing" ? found : undefined;
  });
  assert.equal(workerStartDirectories().length, 5);
  assert.equal(fifth.workerSessionId === null, false);
});

test("a quota block stops even the first worker and release starts it", async (t) => {
  const harness = await createHarness("auto-iteration-m1-quota-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(harness.backend, "m1 quota supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);

  const exhausted = {
    quotaPoolId: "codex-account:codex",
    source: "codex-account:account/rateLimits/read" as const,
    observedAt: 1,
    status: "observed" as const,
    windows: [
      { name: "primary", usedFraction: 1, resetsAt: null, windowDurationMinutes: null },
    ],
  };
  await service.authority.observeQuota(exhausted);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "m1-quota-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  assert.equal(submitted.kind, "work-order-submitted");
  assert.equal(
    (submitted.workOrder as Record<string, unknown>).status,
    "waiting-for-quota",
    "a submission under a quota block must not claim a worker",
  );
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  await service.drainPendingOutbox();
  let overview = service.authority.readAutoIterationOverview();
  assert.equal(overview.quotaWaiting, true);
  assert.equal(findWorkOrder(overview, workOrderId)?.workerSessionBound, false);
  assert.equal(
    harness.adapter.startRequests.filter(
      (request) => request.projectDirectory !== harness.projectDirectory,
    ).length,
    0,
    "no worker may start while the quota is blocked",
  );

  await service.authority.observeQuota({
    ...exhausted,
    observedAt: 2,
    windows: [
      { name: "primary", usedFraction: 0.1, resetsAt: null, windowDurationMinutes: null },
    ],
  });
  overview = service.authority.readAutoIterationOverview();
  assert.equal(overview.quotaWaiting, false);
  assert.equal(findWorkOrder(overview, workOrderId)?.status, "executing");
  await service.drainPendingOutbox();
  await waitFor("the released worker", () => {
    const found = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return found?.workerSessionBound ? found.workerSessionId ?? undefined : undefined;
  });
});

test("a handoff is rejected while its capture job is still running and accepted after it ends", async (t) => {
  const harness = await createHarness("auto-iteration-m1-job-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(harness.backend, "m1 job supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "m1-job-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  const workOrderId = (submitted.workOrder as Record<string, unknown>).workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>).attemptId as string;
  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });

  // A durable job record frozen mid-run: the "still running" signal exists on
  // the record, so the host can refuse the handoff without inventing state.
  const jobsRoot = join(
    dirname(harness.databasePath),
    "attempts",
    basename(harness.databasePath, extname(harness.databasePath)),
    "jobs",
  );
  const jobRecordPath = join(jobsRoot, `capture-${attemptId}.json`);
  await mkdir(jobsRoot, { recursive: true });
  await writeFile(
    jobRecordPath,
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: `capture-${attemptId}`,
      recipe: "capture-artifact",
      inputVersion: 1,
      workingDirectory: harness.projectDirectory,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      processes: [],
      exit: null,
      log: { path: "", head: "", tail: "", truncated: false, totalBytes: 0 },
      output: null,
      lastError: null,
    }, null, 2)}\n`,
    "utf8",
  );

  const handoffKey = { workOrderId, attemptId, handoffId: "handoff-m1-job-1" };
  const rejected = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "m1-job-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "Submitted while the suite still runs in the background.",
        artifactIds: [],
      },
    },
  );
  assert.equal(rejected.kind, "rejected");
  assert.equal(
    (rejected as unknown as CoordinatorToolRejectedResponse).category,
    "job-still-running",
    "the refusal must be readable as job-still-running",
  );
  const beforeEnd = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "m1-job-read-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrderId,
  });
  assert.equal(
    (beforeEnd.handoffs as unknown[]).length,
    0,
    "a running job must not let the handoff land",
  );

  // The job ends; the same handoff is then accepted.
  await rm(jobRecordPath);
  const accepted = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "m1-job-handoff-2",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "Submitted while the suite still runs in the background.",
        artifactIds: [],
      },
    },
  );
  assert.equal(accepted.kind, "handoff-submitted");
});

test("a quota block on one pool leaves a different pool's attempt free to dispatch", async (t) => {
  // Issue #8 M2: quota blocking must be scoped to the pool the attempt's own
  // endpoint draws from, not applied globally across every pool at once.
  const harness = await createHarness("auto-iteration-m2-pool-");
  t.after(async () => {
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(harness.backend, "m2 pool supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);

  await service.authority.observeQuota({
    quotaPoolId: "codex-account:codex",
    source: "codex-account:account/rateLimits/read",
    observedAt: 1,
    status: "observed",
    windows: [
      { name: "primary", usedFraction: 1, resetsAt: null, windowDurationMinutes: null },
    ],
  });

  const submittedCodex = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "m2-pool-submit-codex",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, harness.baselineCommitSha),
  });
  assert.equal(
    (submittedCodex.workOrder as Record<string, unknown>).status,
    "waiting-for-quota",
    "the codex-pool submission is blocked by its own pool's exhaustion",
  );
  const codexWorkOrderId = (submittedCodex.workOrder as Record<string, unknown>)
    .workOrderId as string;

  const submittedClaude = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "m2-pool-submit-claude",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      ...workOrderSubmission(profile, harness.baselineCommitSha),
      workerSession: { endpointId: "claude-code-desktop", profile },
    },
  });
  assert.equal(
    (submittedClaude.workOrder as Record<string, unknown>).status,
    "executing",
    "a different pool's submission is unaffected by the codex pool's exhaustion",
  );
  const claudeWorkOrderId = (submittedClaude.workOrder as Record<string, unknown>)
    .workOrderId as string;

  const claudeWorkerSessionId = await waitFor("claude-pool worker Session binding", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      claudeWorkOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });
  assert.notEqual(claudeWorkerSessionId, supervisorSessionId);

  const overview = service.authority.readAutoIterationOverview();
  assert.equal(
    findWorkOrder(overview, codexWorkOrderId)?.workerSessionBound,
    false,
    "the codex-pool order stays unbound while only its own pool is exhausted",
  );
  assert.equal(findWorkOrder(overview, codexWorkOrderId)?.status, "waiting-for-quota");
  assert.equal(
    harness.adapter.startRequests.length,
    2,
    "only the supervisor and the claude-pool worker started",
  );

  // Releasing the codex pool lets its own order dispatch too.
  await service.authority.observeQuota({
    quotaPoolId: "codex-account:codex",
    source: "codex-account:account/rateLimits/read",
    observedAt: 2,
    status: "observed",
    windows: [
      { name: "primary", usedFraction: 0.1, resetsAt: null, windowDurationMinutes: null },
    ],
  });
  await service.drainPendingOutbox();
  await waitFor("the released codex-pool worker", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      codexWorkOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });
});

test("the supervisor's own creation parameters survive a Project reopen and a high-context observation rotates using them", async (t) => {
  // Issue #8 M2 tenure cutover: the ≥70% trigger must read durably stored
  // creation parameters, not an in-memory table a reopen would empty.
  const harness = await createHarness("auto-iteration-m2-tenure-");
  let reopenedBackend: WorkbenchBackend | undefined;
  t.after(async () => {
    await reopenedBackend?.close().catch(() => undefined);
    await harness.backend.close();
    await removeTree(harness.root);
  });
  const service = harness.backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(harness.backend, "m2 tenure supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });

  await harness.backend.close();
  const reopenedAdapter = new ScriptedLoopAdapter();
  reopenedBackend = await createWorkbenchBackend({
    projectDirectory: harness.projectDirectory,
    databasePath: harness.databasePath,
    adapter: reopenedAdapter,
  });
  const reopenedService = reopenedBackend.autoIteration;
  assert.ok(reopenedService, "the reopened backend exposes the service");

  // Reads as active with no rotation before the observation lands.
  const beforeObservation = reopenedService.authority.readAutoIterationOverview();
  assert.equal(beforeObservation.supervisor?.generation, 1);
  assert.equal(beforeObservation.supervisor?.status, "active");

  const accepted = await emitContextUsageObservation({
    source: "claude-control:get_context_usage",
    observedAt: 1,
    sessionId: supervisorSessionId,
    model: profile.model,
    quality: "authoritative",
    totalTokens: 950,
    maxTokens: 1000,
    fraction: 0.95,
  });
  assert.equal(accepted, true, "the reopened backend retained the context sink");
  await reopenedService.drainPendingOutbox();

  const afterRotation = await waitFor("post-reopen rotation cutover", () => {
    const current = reopenedService.authority.readAutoIterationOverview();
    return current.supervisor?.generation === 2 &&
      current.supervisor.sessionId !== supervisorSessionId
      ? current
      : undefined;
  });
  assert.equal(afterRotation.supervisor?.status, "active");
  const successorSessionId = afterRotation.supervisor!.sessionId!;
  assert.notEqual(successorSessionId, supervisorSessionId);

  // The successor Session was created with the SAME profile as the original
  // supervisor: the host mirrored the durably stored creation parameters
  // rather than inventing new ones. It is the only Session started in the
  // reopened backend (the original supervisor was re-bound from the ledger,
  // never re-started).
  assert.equal(reopenedAdapter.startRequests.length, 1);
  assert.deepEqual(reopenedAdapter.startRequests[0]!.profile, profile);

  // The old generation cannot submit new decisions after cutover.
  const staleRejection = await reopenedService.authority.request(
    {
      kind: "supervisor",
      sessionId: supervisorSessionId,
      tenure: { roleSlotId: "project-supervisor", generation: 1 },
    },
    {
      kind: "read-inbox",
      requestIdempotencyKey: "m2-tenure-stale-read",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      roleSlotId: "project-supervisor",
    },
  );
  assert.equal(staleRejection.kind, "rejected");
  assert.equal((staleRejection as CoordinatorToolRejectedResponse).category, "stale-generation");
});

test("a wakeup whose continue lands in recovery-required does not falsely seal a delivery receipt, and the retried wakeup after recovery delivers it", async (t) => {
  // Issue #8 M2 (w342 evidence §7.b): `channel.act` resolves at durable
  // acceptance, before resume/send is even attempted. A wakeup whose resume
  // fails must not have `markHandoffIncluded` seal a receipt for input the
  // parent Session never actually received.
  let resumeCalls = 0;
  const adapter = new ScriptedLoopAdapter(undefined, async () => {
    resumeCalls += 1;
    if (resumeCalls === 1) {
      throw new Error("simulated wakeup resume failure");
    }
  });
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "auto-iteration-m2-recovery-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  await git(projectDirectory, "init", "--initial-branch=demo");
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await git(projectDirectory, "add", "baseline.txt");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "workbench.sqlite"),
    adapter,
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    await removeTree(root);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(backend, "m2 recovery supervisor");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "m2-recovery-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: workOrderSubmission(profile, baselineCommitSha),
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;
  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = findWorkOrder(
      service.authority.readAutoIterationOverview(),
      workOrderId,
    );
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });

  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-m2-recovery-1",
  };
  const handoff = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "m2-recovery-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "Delivered while the wakeup resume fails once.",
        artifactIds: [],
      },
    },
  );
  assert.equal(handoff.kind, "handoff-submitted");

  // The first wakeup attempt's resume fails; the coordinator's own recovery
  // probe (a second, independent resume) then confirms the Session is
  // reachable, so no external action is needed for it to become resumable
  // again.
  await waitFor(
    "the failed wakeup and its recovery probe",
    () => (resumeCalls >= 2 ? resumeCalls : undefined),
  );

  // Core fix: no inclusion receipt, and the wakeup entry stays pending.
  const statusAfterFailure = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "m2-recovery-read-1",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrderId,
  });
  assert.deepEqual(
    (statusAfterFailure.receipts as Array<Record<string, unknown>>).map(
      (receipt) => receipt.level,
    ),
    ["persisted"],
    "a wakeup that failed to become parent input must not seal an inclusion receipt",
  );
  assert.equal(
    (await service.authority.readPendingOutbox()).some(
      (entry) => entry.kind === "inbox-wakeup",
    ),
    true,
    "the wakeup entry stays pending after a failed delivery",
  );

  // The retried wakeup (triggered by the recovery-required update itself)
  // succeeds this time and delivers the handoff.
  await waitFor("the retried wakeup to deliver", async () => {
    const status = await callTool(supervisorServer, "read_work_order_status", {
      requestIdempotencyKey: "m2-recovery-read-2",
      expectedVersion: 2,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      workOrderId,
    });
    const levels = (status.receipts as Array<Record<string, unknown>>).map(
      (receipt) => receipt.level,
    );
    return levels.includes("included-in-parent-input") ? status : undefined;
  });
  await waitFor("wakeup settle in the ledger", async () => {
    const pending = (await service.authority.readPendingOutbox()).filter(
      (entry) => entry.kind === "inbox-wakeup",
    );
    return pending.length === 0 ? pending : undefined;
  });
  const finalOrder = findWorkOrder(
    service.authority.readAutoIterationOverview(),
    workOrderId,
  );
  assert.equal(finalOrder?.status, "awaiting-review");
});

test("issue #8 M3: an independent Review Attempt Session starts through the production seam, reads a real diff, and gates disposition until it submits", async (t) => {
  let workerCommitSha: string | undefined;
  const adapter = new ScriptedLoopAdapter(async (request) => {
    if (request.projectDirectory.endsWith("Project")) return; // supervisor / reviewer
    await writeFile(
      join(request.projectDirectory, "reviewed-delivery.txt"),
      "content the independent reviewer must see in the diff\n",
      "utf8",
    );
    await git(request.projectDirectory, "add", "reviewed-delivery.txt");
    await git(request.projectDirectory, "commit", "-m", "feat: worker delivery for review");
    workerCommitSha = await git(request.projectDirectory, "rev-parse", "HEAD");
  });
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "auto-iteration-review-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  await git(projectDirectory, "init", "--initial-branch=demo");
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await git(projectDirectory, "add", "baseline.txt");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "workbench.sqlite"),
    adapter,
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    await removeTree(root);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(backend, "review supervisor opening turn");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);

  // Deliberately omits `review`: the default independent policy applies.
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "review-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      objective: "Add the reviewed delivery file.",
      acceptanceCriteria: ["reviewed-delivery.txt exists with the expected content"],
      baselineCommitSha,
      territory: { writePaths: ["reviewed-delivery.txt"], readOnlyPaths: [] },
      responsibleRoleSlotId: "project-supervisor",
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
    },
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>).workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>).attemptId as string;

  // The resolved default policy differs the reviewer's endpoint from the worker's.
  const resolvedOrder = service.authority.readWorkOrder(workOrderId);
  assert.equal(resolvedOrder?.review?.kind, "independent");
  if (resolvedOrder?.review?.kind === "independent") {
    assert.equal(resolvedOrder.review.reviewerSession.endpointId, "claude-code-desktop");
    assert.equal(resolvedOrder.review.sameEndpointAsWorker, false);
  }

  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = findWorkOrder(service.authority.readAutoIterationOverview(), workOrderId);
    return order?.workerSessionBound && workerCommitSha !== undefined
      ? order.workerSessionId ?? undefined
      : undefined;
  });

  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-review-1",
  };
  const handoff = await callTool(
    service.mcpServerForSession(workerSessionId),
    "submit_handoff",
    {
      requestIdempotencyKey: "review-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "The worker's own reasoning: never sent to the reviewer.",
        artifactIds: [],
      },
    },
  );
  assert.equal(handoff.kind, "handoff-submitted");

  // The bounded wakeup summary carries the review's status (still pending
  // at this point: the reviewer Session races the supervisor's own wakeup).
  await waitFor("the supervisor wakeup summary mentioning the pending review", () =>
    adapter.sentInputs.some((text) => /await.*your review/u.test(text))
      ? adapter.sentInputs.find((text) => /await.*your review/u.test(text))
      : undefined,
  );
  const wakeupText = adapter.sentInputs.find((text) => /await.*your review/u.test(text))!;
  assert.match(wakeupText, /\(review: pending\)/u);

  // Disposition is refused before the independent review lands.
  const tooEarly = await callTool(supervisorServer, "submit_review_decision", {
    requestIdempotencyKey: "review-decide-too-early",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    decision: {
      handoff: handoffKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "looks fine",
    },
  });
  assert.equal(tooEarly.kind, "rejected");
  assert.equal(
    (tooEarly as unknown as CoordinatorToolRejectedResponse).category,
    "review-required",
  );

  const reviewerSessionId = await waitFor("the independent Review Attempt Session", () =>
    service.reviewSessionIdFor(handoffKey),
  );
  assert.notEqual(reviewerSessionId, workerSessionId);
  assert.notEqual(reviewerSessionId, supervisorSessionId);
  const reviewerServer = service.mcpServerForSession(reviewerSessionId);

  const artifact = await callTool(reviewerServer, "read_handoff_artifact", {
    requestIdempotencyKey: "review-artifact-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    handoff: handoffKey,
  });
  assert.equal(artifact.kind, "handoff-artifact");
  assert.equal(artifact.workOrderObjective, "Add the reviewed delivery file.");
  assert.deepEqual(artifact.acceptanceCriteria, [
    "reviewed-delivery.txt exists with the expected content",
  ]);
  assert.equal(artifact.commitSha, workerCommitSha);
  assert.match(artifact.diff as string, /reviewed-delivery\.txt/u);
  assert.match(
    artifact.diff as string,
    /content the independent reviewer must see in the diff/u,
  );
  assert.equal(
    "body" in artifact,
    false,
    "the worker's own Handoff body never reaches the reviewer",
  );

  // A reviewer Session may not read/submit for a Handoff it is not bound to.
  const wrongHandoff = await callTool(reviewerServer, "read_handoff_artifact", {
    requestIdempotencyKey: "review-artifact-wrong",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    handoff: { ...handoffKey, handoffId: "not-mine" },
  });
  assert.equal(wrongHandoff.kind, "rejected");

  const submittedReview = await callTool(reviewerServer, "submit_review", {
    requestIdempotencyKey: "review-submit-verdict-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    review: {
      handoff: handoffKey,
      verdict: "agree",
      problems: [],
    },
  });
  assert.equal(submittedReview.kind, "review-submitted");

  const decided = await callTool(supervisorServer, "submit_review_decision", {
    requestIdempotencyKey: "review-decide-now",
    expectedVersion: 2,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    decision: {
      handoff: handoffKey,
      handoffVersion: 1,
      decision: "approve",
      reason: "the independent reviewer agreed",
    },
  });
  assert.equal(decided.kind, "review-decision-submitted");

  const status = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "review-final-status",
    expectedVersion: 3,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrderId,
  });
  const independentReviews = status.independentReviews as Array<Record<string, unknown>>;
  assert.equal(independentReviews.length, 1);
  assert.equal(independentReviews[0]!.verdict, "agree");
  assert.equal(independentReviews[0]!.reviewerSessionId, reviewerSessionId);
});

test("issue #8 M3 publish policy: integrated stays un-pushed until publish_candidate, which really pushes and detects a moved remote", async (t) => {
  const scratchRoot =
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "auto-iteration-publish-"));
  const remoteDirectory = join(root, "remote.git");
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  await git(root, "init", "--bare", "--initial-branch=demo", remoteDirectory);
  await git(root, "clone", remoteDirectory, projectDirectory);
  await git(projectDirectory, "config", "user.name", "Auto Iteration Test");
  await git(projectDirectory, "config", "user.email", "auto-iteration@example.invalid");
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await writeFile(
    join(projectDirectory, "pnpm.bat"),
    "@echo off\r\necho %1 gate passed\r\nexit /b 0\r\n",
    "utf8",
  );
  await git(projectDirectory, "add", "baseline.txt", "pnpm.bat");
  await git(projectDirectory, "commit", "-m", "test: baseline");
  await git(projectDirectory, "push", "-u", "origin", "demo");
  const baselineCommitSha = await git(projectDirectory, "rev-parse", "HEAD");

  let deliveryCounter = 0;
  const adapter = new ScriptedLoopAdapter(async (request) => {
    if (request.projectDirectory === projectDirectory) return;
    deliveryCounter += 1;
    await writeFile(
      join(request.projectDirectory, `publish-delivery-${deliveryCounter}.txt`),
      `delivered ${deliveryCounter}\n`,
      "utf8",
    );
    await git(request.projectDirectory, "add", `publish-delivery-${deliveryCounter}.txt`);
    await git(request.projectDirectory, "commit", "-m", `feat: delivery ${deliveryCounter}`);
  });
  const backend = await createWorkbenchBackend({ projectDirectory, databasePath, adapter });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    await removeTree(root);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await startSupervisor(backend, "publish supervisor opening turn");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const supervisorTenure = { roleSlotId: "project-supervisor", generation: 1 };

  async function deliverAndIntegrate(
    keyPrefix: string,
    baseline: string,
  ): Promise<{ readonly workOrderId: string; readonly mergeCommitSha: string }> {
    const submitted = await callTool(supervisorServer, "submit_work_order", {
      requestIdempotencyKey: `${keyPrefix}-submit`,
      expectedVersion: 1,
      observedTenure: supervisorTenure,
      workOrder: {
        ...workOrderSubmission(profile),
        baselineCommitSha: baseline,
        completionCondition: { gitIntegration: "required" },
      },
    });
    assert.equal(submitted.kind, "work-order-submitted");
    const workOrderId = (submitted.workOrder as Record<string, unknown>).workOrderId as string;
    const attemptId = (submitted.attempt as Record<string, unknown>).attemptId as string;
    const workerSessionId = await waitFor(`${keyPrefix} worker Session`, () => {
      const order = findWorkOrder(service!.authority.readAutoIterationOverview(), workOrderId);
      return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
    });
    const handoffKey: HandoffIdempotencyKey = {
      workOrderId,
      attemptId,
      handoffId: `${keyPrefix}-handoff`,
    };
    const handoff = await callTool(service!.mcpServerForSession(workerSessionId), "submit_handoff", {
      requestIdempotencyKey: `${keyPrefix}-handoff-submit`,
      expectedVersion: 1,
      observedTenure: supervisorTenure,
      handoff: { idempotencyKey: handoffKey, body: "ready", artifactIds: [] },
    });
    assert.equal(handoff.kind, "handoff-submitted");
    const decided = await callTool(supervisorServer, "submit_review_decision", {
      requestIdempotencyKey: `${keyPrefix}-decide`,
      expectedVersion: 2,
      observedTenure: supervisorTenure,
      decision: { handoff: handoffKey, handoffVersion: 1, decision: "approve", reason: "accepted" },
    });
    assert.equal(decided.kind, "review-decision-submitted");
    const integrated = await waitFor(`${keyPrefix} integration`, () => {
      const order = findWorkOrder(service!.authority.readAutoIterationOverview(), workOrderId);
      return order?.status === "integrated" ? order : undefined;
    });
    assert.ok(integrated);
    const finalStatus = await callTool(supervisorServer, "read_work_order_status", {
      requestIdempotencyKey: `${keyPrefix}-read`,
      expectedVersion: 4,
      observedTenure: supervisorTenure,
      workOrderId,
    });
    const candidate = (finalStatus.candidates as Array<Record<string, unknown>>)[0]!;
    const outcome = candidate.outcome as Record<string, unknown>;
    assert.equal(outcome.status, "integrated");
    return {
      workOrderId,
      mergeCommitSha: outcome.mergeCommitSha as string,
    };
  }

  const first = await deliverAndIntegrate("publish-a", baselineCommitSha);
  const beforePublish = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "publish-a-preread",
    expectedVersion: 4,
    observedTenure: supervisorTenure,
    workOrderId: first.workOrderId,
  });
  const candidateAId = (
    (beforePublish.candidates as Array<Record<string, unknown>>)[0]!
  ).integrationCandidateId as string;
  assert.equal(
    await git(remoteDirectory, "rev-parse", "refs/heads/demo"),
    baselineCommitSha,
    "not yet published: the remote is untouched",
  );

  const published = await callTool(supervisorServer, "publish_candidate", {
    requestIdempotencyKey: "publish-a-publish",
    expectedVersion: 1,
    observedTenure: supervisorTenure,
    integrationCandidateId: candidateAId,
  });
  assert.equal(published.kind, "publish-candidate-result");
  const publishedOutcome = published.outcome as Record<string, unknown>;
  assert.equal(publishedOutcome.status, "published");
  assert.equal(publishedOutcome.remoteCommitSha, first.mergeCommitSha);
  assert.equal(
    await git(remoteDirectory, "rev-parse", "refs/heads/demo"),
    first.mergeCommitSha,
    "publish_candidate really pushed the local target branch",
  );

  // Idempotent replay: no second push is attempted, same outcome comes back.
  const republished = await callTool(supervisorServer, "publish_candidate", {
    requestIdempotencyKey: "publish-a-republish",
    expectedVersion: 1,
    observedTenure: supervisorTenure,
    integrationCandidateId: candidateAId,
  });
  assert.equal(republished.kind, "publish-candidate-result");
  assert.deepEqual(republished.outcome, published.outcome);

  // Second work order, integrated locally on top of the published tip.
  const second = await deliverAndIntegrate("publish-b", first.mergeCommitSha);
  const beforeSecondPublish = await callTool(supervisorServer, "read_work_order_status", {
    requestIdempotencyKey: "publish-b-preread",
    expectedVersion: 4,
    observedTenure: supervisorTenure,
    workOrderId: second.workOrderId,
  });
  const candidateBId = (
    (beforeSecondPublish.candidates as Array<Record<string, unknown>>)[0]!
  ).integrationCandidateId as string;

  // An external actor publishes directly to the bare remote, bypassing this
  // Project entirely -- exactly the race publish_candidate must catch.
  const externalClone = join(root, "external-clone");
  await git(root, "clone", remoteDirectory, externalClone);
  await git(externalClone, "config", "user.name", "External Publisher");
  await git(externalClone, "config", "user.email", "external@example.invalid");
  await writeFile(join(externalClone, "external-change.txt"), "from elsewhere\n", "utf8");
  await git(externalClone, "add", "external-change.txt");
  await git(externalClone, "commit", "-m", "external: unrelated publish");
  await git(externalClone, "push", "origin", "demo");
  const externalCommitSha = await git(externalClone, "rev-parse", "HEAD");
  assert.notEqual(externalCommitSha, first.mergeCommitSha);

  const blocked = await callTool(supervisorServer, "publish_candidate", {
    requestIdempotencyKey: "publish-b-publish",
    expectedVersion: 1,
    observedTenure: supervisorTenure,
    integrationCandidateId: candidateBId,
  });
  assert.equal(blocked.kind, "publish-candidate-result");
  const blockedOutcome = blocked.outcome as Record<string, unknown>;
  assert.equal(blockedOutcome.status, "blocked: target-moved");
  assert.equal(blockedOutcome.expectedBaselineCommitSha, first.mergeCommitSha);
  assert.equal(blockedOutcome.observedRemoteCommitSha, externalCommitSha);
  assert.equal(
    await git(remoteDirectory, "rev-parse", "refs/heads/demo"),
    externalCommitSha,
    "the blocked publish attempt must not have pushed anything",
  );

  // Only the supervisor may call publish_candidate.
  const workerAttemptForDenial = await waitFor("a bound worker Session to probe denial", () => {
    const order = findWorkOrder(service.authority.readAutoIterationOverview(), second.workOrderId);
    return order?.workerSessionId ?? undefined;
  });
  const deniedForWorker = await callTool(
    service.mcpServerForSession(workerAttemptForDenial),
    "publish_candidate",
    {
      requestIdempotencyKey: "publish-b-worker-denied",
      expectedVersion: 1,
      observedTenure: supervisorTenure,
      integrationCandidateId: candidateBId,
    },
  );
  assert.equal(deniedForWorker.kind, "rejected");
});
