import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
} from "../../src/coordinator/auto-iteration/contract.ts";
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
  readonly resumeInputs: string[] = [];

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    assert.equal(request.profile.model, profile.model);
    this.startInputs.push(request.profile.model);
    return new ScriptedBinding(`native-start-${this.startInputs.length}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeInputs.push(request.profile.model);
    return new ScriptedBinding(request.opaqueSessionReference);
  }
}

interface Harness {
  readonly backend: WorkbenchBackend;
  readonly adapter: ScriptedLoopAdapter;
  readonly projectDirectory: string;
  readonly databasePath: string;
  readonly root: string;
}

async function createHarness(prefix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const databasePath = join(root, "workbench.sqlite");
  const adapter = new ScriptedLoopAdapter();
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  return { backend, adapter, projectDirectory, databasePath, root };
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

function workOrderSubmission(workerProfile: SessionProfile) {
  return {
    objective: "Summarize the fixture repository",
    acceptanceCriteria: ["summary mentions the fixture"],
    baselineCommitSha: "0123456789abcdef0123456789abcdef01234567",
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
    workOrder: workOrderSubmission(profile),
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
    workOrder: workOrderSubmission(profile),
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

