import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
  private readonly onStart?: (request: RuntimeStart) => Promise<void>;
  #startGate: Promise<void> | undefined;
  #releaseStartGate: (() => void) | undefined;

  constructor(onStart?: (request: RuntimeStart) => Promise<void>) {
    this.onStart = onStart;
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
    this.resumeInputs.push(request.profile.model);
    return new ScriptedBinding(request.opaqueSessionReference);
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
