import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { connect } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
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
  RuntimeWorkbenchMcpServer,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import type { HandoffIdempotencyKey } from "../../src/coordinator/auto-iteration/contract.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type { WorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type {
  AutoIterationMcpServer,
  JsonRpcRequest,
} from "../../src/workbench-shell/auto-iteration-mcp-server.ts";
import {
  createAutoIterationMcpPipeHost,
  type AutoIterationMcpPipeDiagnostic,
} from "../../src/workbench-shell/auto-iteration-mcp-host.ts";
import { codexWorkbenchLaunchArguments } from "../../src/agent-runtime/codex-adapter.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  createRuntimeEndpointDirectory,
  type RuntimeEndpointRegistration,
} from "../../src/agent-runtime/runtime-endpoint-directory.ts";

/**
 * Wiring guards for the Workbench MCP binding carrier (w300, supervisor
 * ruling): the auto-iteration service puts a named-pipe binding on its exact
 * `channel.act` command, the coordinator carries that runtime-only field to
 * the serialized executor without persisting it, the endpoint directory
 * forwards the field, and codex turns it into the measured `-c` session
 * overrides. All hermetic (fake adapters); the real-CLI wire proof lives in
 * `auto-iteration-mcp-bootstrap-claude.test.ts` / `-codex.test.ts`.
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
    Object.freeze({ id: profile.model, effortLevels: Object.freeze([profile.effortLevel]) }),
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

const execFileAsync = promisify(execFile);

async function initializeGitProject(projectDirectory: string): Promise<string> {
  const run = (...args: string[]) =>
    execFileAsync("git", args, {
      cwd: projectDirectory,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Auto Iteration Test",
        GIT_AUTHOR_EMAIL: "auto-iteration@example.invalid",
        GIT_COMMITTER_NAME: "Auto Iteration Test",
        GIT_COMMITTER_EMAIL: "auto-iteration@example.invalid",
      },
      windowsHide: true,
    });
  await run("init", "--initial-branch=demo");
  await writeFile(join(projectDirectory, "baseline.txt"), "baseline\n", "utf8");
  await run("add", "baseline.txt");
  await run("commit", "-m", "test: baseline");
  return (await run("rev-parse", "HEAD")).stdout.trim();
}

class RecordingBinding implements ResumableRuntimeBinding {
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

class RecordingLoopAdapter implements ResumableAgentRuntimeAdapter {
  readonly startRequests: RuntimeStart[] = [];
  readonly resumeRequests: RuntimeResume[] = [];

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startRequests.push(structuredClone(request));
    return new RecordingBinding(`native-start-${this.startRequests.length}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeRequests.push(structuredClone(request));
    return new RecordingBinding(request.opaqueSessionReference);
  }
}

async function waitFor<T>(
  describe: string,
  read: () => T | undefined,
  timeoutMilliseconds = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${describe}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

let jsonRpcId = 0;

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

/**
 * A minimal in-test bootstrap client over one binding's single connection:
 * hello, then the given requests, collecting one reply per request.
 */
function pipeRoundTrip(
  spec: RuntimeWorkbenchMcpServer,
  requests: readonly string[],
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const replies: string[] = [];
    const socket = connect(spec.args[1] as string);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("pipe round trip timed out"));
    }, 5_000);
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "binding-hello", token: spec.args[2] })}\n`,
      );
      for (const request of requests) {
        socket.write(`${request}\n`);
      }
    });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      replies.push(line);
      if (replies.length >= requests.length) {
        clearTimeout(timeout);
        lines.close();
        socket.destroy();
        resolve(replies);
      }
    });
  });
}

function jsonRpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

test("the product-created worker Session gets workbenchMcp through the production seam", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "w300-wiring-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const baselineCommitSha = await initializeGitProject(projectDirectory);
  const databasePath = join(root, "workbench.sqlite");
  const adapter = new RecordingLoopAdapter();
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  // The supervisor Session start carries a binding through the executor.
  const supervisorSessionId = await service.startHostSession({
    endpointId: "codex-desktop",
    profile,
    input: "supervisor opening turn",
  });
  assert.ok(typeof supervisorSessionId === "string");
  const supervisorStart = await waitFor(
    "supervisor start request",
    () => adapter.startRequests[0],
  );
  const supervisorSpec = supervisorStart.workbenchMcp;
  assert.ok(supervisorSpec, "the supervisor start must carry a Workbench binding");
  assert.equal(supervisorSpec.command, process.execPath);
  assert.match(supervisorSpec.args[0]!, /auto-iteration-mcp-bootstrap\.(js|ts)$/u);
  assert.match(supervisorSpec.args[1]!, /^\\\\\.\\pipe\\/u);
  assert.equal(typeof supervisorSpec.args[2], "string");
  assert.deepEqual(supervisorSpec.env, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(
    Reflect.ownKeys(supervisorStart).includes("workbenchMcp"),
    true,
    "the runtime-only field itself must be present, not an undefined hole",
  );

  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });

  // The supervisor pipe answers a live MCP handshake and, once the tenure
  // binding exists, lists the supervisor tools — one connection, one shot.
  const supervisorPipe = supervisorStart.workbenchMcp!;
  const handshake = await pipeRoundTrip(supervisorPipe, [
    jsonRpc(1, "initialize", { protocolVersion: "2025-06-18" }),
    jsonRpc(2, "tools/list"),
  ]);
  assert.ok(
    (JSON.parse(handshake[0]!) as { result?: unknown }).result !== undefined,
    "the pipe serves initialize",
  );
  const tools = (
    JSON.parse(handshake[1]!) as { result: { tools: Array<{ name: string }> } }
  ).result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "publish_candidate",
      "read_inbox",
      "read_work_order_status",
      "request_supervisor_rotation",
      "submit_review_decision",
      "submit_work_order",
    ],
    "the supervisor pipe lists the bound supervisor tools",
  );

  // The worker Session start carries its own binding, and the pipe associates
  // AFTER the actor binding so the worker tools are already visible.
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "wiring-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      objective: "Fixture objective",
      acceptanceCriteria: ["fixture criterion"],
      baselineCommitSha,
      territory: { writePaths: ["src/"], readOnlyPaths: ["docs/"] },
      responsibleRoleSlotId: "project-supervisor",
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile },
    },
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;
  const workerStart = await waitFor("worker start request", () =>
    adapter.startRequests[1],
  );
  assert.notEqual(
    workerStart.projectDirectory,
    projectDirectory,
    "the worker runtime must start in its attempt worktree",
  );
  const workerSpec = workerStart.workbenchMcp;
  assert.ok(workerSpec, "the worker start must carry a Workbench binding");
  assert.notEqual(workerSpec.args[1], supervisorSpec.args[1]);
  // The handoff arrives through the SAME worker connection (one shot), so the
  // tools/list and the submit_handoff ride one round trip.
  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-wiring-1",
  };
  const workerHandshake = await pipeRoundTrip(workerSpec, [
    jsonRpc(3, "tools/list"),
    jsonRpc(4, "tools/call", {
      name: "submit_handoff",
      arguments: {
        requestIdempotencyKey: "wiring-handoff-1",
        expectedVersion: 1,
        observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
        handoff: {
          idempotencyKey: handoffKey,
          body: "Delivered through the wired bridge.",
          artifactIds: [],
        },
      },
    }),
  ]);
  const workerTools = (
    JSON.parse(workerHandshake[0]!) as { result: { tools: Array<{ name: string }> } }
  ).result.tools;
  assert.deepEqual(
    workerTools.map((tool) => tool.name),
    ["read_work_order_status", "submit_handoff", "read_inbox"],
  );
  const handoffPayload = JSON.parse(
    (JSON.parse(workerHandshake[1]!) as { result: { content: Array<{ text: string }> } })
      .result.content[0]!.text,
  ) as Record<string, unknown>;
  assert.equal(handoffPayload.kind, "handoff-submitted");
  assert.equal(
    (handoffPayload.receipt as Record<string, unknown>).level,
    "persisted",
  );

  const resumeRequest = await waitFor("wakeup resume request", () =>
    adapter.resumeRequests[0],
  );
  assert.ok(
    resumeRequest.workbenchMcp,
    "the supervisor wakeup resume must carry a fresh binding",
  );
  assert.notEqual(
    resumeRequest.workbenchMcp.args[1],
    supervisorSpec.args[1],
    "resume re-issues a fresh binding",
  );

  // No reservation leaked abnormally (timeouts/expiries would warn).
  await waitFor("awaiting-review", () => {
    const order = service.authority
      .readAutoIterationOverview()
      .workOrders.find((candidate) => candidate.workOrderId === workOrderId);
    return order?.status === "awaiting-review" ? order : undefined;
  });
  const abnormal = warnings.filter((line) =>
    line.includes("reservation-expired") ||
    line.includes("association-timeout") ||
    line.includes("registry-unavailable"),
  );
  assert.deepEqual(abnormal, []);
  assert.equal(service.workbenchBindings.size >= 3, true);
  await backend.close();
  assert.equal(service.workbenchBindings.size, 0);
});

test("the command's runtime-only Workbench binding reaches its executor without a FIFO claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "w300-command-carrier-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const adapter = new RecordingLoopAdapter();
  const databasePath = join(root, "workbench.sqlite");
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
  }).openProject(projectDirectory);
  t.after(async () => {
    await channel.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const spec: RuntimeWorkbenchMcpServer = Object.freeze({
    command: "node",
    args: Object.freeze(["bootstrap.js", "pipe-command", "token-command"]),
    env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
  });

  await channel.act(
    Object.freeze({
      kind: "direct" as const,
      commandKind: "start" as const,
      idempotencyKey: "command-carrier-start",
      runtime: "codex" as const,
      catalogRevision: "command-carrier-catalog",
      preferences: Object.freeze({ global: profile }),
      profile,
      input: "start with the command-owned binding",
      workbenchMcp: spec,
    }),
  );
  await waitFor("command-owned binding at the adapter", () =>
    adapter.startRequests[0],
  );
  assert.deepEqual(adapter.startRequests[0]!.workbenchMcp, spec);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const stored = database
    .prepare(
      "SELECT private_envelope_json FROM commands ORDER BY accepted_cursor LIMIT 1",
    )
    .get() as { readonly private_envelope_json: string };
  database.close();
  assert.equal(
    Reflect.ownKeys(JSON.parse(stored.private_envelope_json)).includes(
      "workbenchMcp",
    ),
    false,
    "the execution carrier must not enter the durable command envelope",
  );

  await channel.act({
    kind: "direct",
    commandKind: "start",
    idempotencyKey: "ordinary-start-after-command-carrier",
    runtime: "codex",
    catalogRevision: "ordinary-catalog",
    preferences: Object.freeze({ global: profile }),
    profile,
    input: "ordinary start",
  });
  await waitFor("ordinary start at the adapter", () => adapter.startRequests[1]);
  assert.equal(
    Reflect.ownKeys(adapter.startRequests[1]!).includes("workbenchMcp"),
    false,
  );
});

test("the coordinator keeps the command binding on its recovery resume probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "w300-recovery-carrier-"));
  const projectDirectory = join(root, "Project");
  await mkdir(projectDirectory);
  const startRequests: RuntimeStart[] = [];
  const resumeRequests: RuntimeResume[] = [];
  const adapter: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return structuredClone(catalog);
    },
    async start(request) {
      startRequests.push(structuredClone(request));
      return {
        profile,
        opaqueSessionReference: "recovery-command-ref",
        async send() {},
        async *events() {
          throw new Error("fixture stream failure");
        },
      };
    },
    async resume(request) {
      resumeRequests.push(structuredClone(request));
      return new RecordingBinding(request.opaqueSessionReference);
    },
  };
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "workbench.sqlite"),
    adapter,
  }).openProject(projectDirectory);
  t.after(async () => {
    await channel.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const spec: RuntimeWorkbenchMcpServer = Object.freeze({
    command: "node",
    args: Object.freeze(["bootstrap.js", "pipe-recovery", "token-recovery"]),
  });

  await channel.act({
    kind: "direct",
    commandKind: "start",
    idempotencyKey: "recovery-command-carrier",
    runtime: "codex",
    catalogRevision: "recovery-command-catalog",
    preferences: Object.freeze({ global: profile }),
    profile,
    input: "force the recovery probe",
    workbenchMcp: spec,
  });
  await waitFor("recovery resume probe", () => resumeRequests[0]);
  assert.deepEqual(startRequests[0]!.workbenchMcp, spec);
  assert.deepEqual(resumeRequests[0]!.workbenchMcp, spec);
});

test("an unassociated pipe buffers bounded frames, replays them on associate, and times out visibly", async (t) => {
  const diagnostics: AutoIterationMcpPipeDiagnostic[] = [];
  const host = createAutoIterationMcpPipeHost({
    bootstrapEntry: "unused-entry.js",
    serverForSession: (sessionId) =>
      ({
        handle: async (request: JsonRpcRequest) => ({
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: { echoed: sessionId, method: request.method },
        }),
      }) as AutoIterationMcpServer,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    associationTimeoutMilliseconds: 300,
  });
  t.after(() => host.close());
  const binding = host.openBinding();
  assert.equal(binding.sessionId, undefined);

  const replies: string[] = [];
  const socket = connect(binding.pipeName);
  t.after(() => socket.destroy());
  const replyLines = createInterface({ input: socket, crlfDelay: Infinity });
  replyLines.on("line", (line) => {
    if (line.trim().length > 0) replies.push(line);
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    `${JSON.stringify({ type: "binding-hello", token: binding.token })}\n`,
  );
  socket.write(`${jsonRpc(1, "initialize", { protocolVersion: "2025-06-18" })}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(replies, [], "nothing is served before association");

  assert.equal(host.associate(binding, "session-late"), true);
  await waitFor("buffered initialize replay", () =>
    replies.length === 1 ? replies : undefined,
  );
  const replayed = JSON.parse(replies[0]!) as { result: { echoed: string } };
  assert.equal(replayed.result.echoed, "session-late");

  // A second binding that never associates hits the bound and reports it.
  const orphan = host.openBinding();
  const orphanSocket = connect(orphan.pipeName);
  t.after(() => orphanSocket.destroy());
  await new Promise<void>((resolve) => orphanSocket.once("connect", resolve));
  orphanSocket.write(
    `${JSON.stringify({ type: "binding-hello", token: orphan.token })}\n`,
  );
  orphanSocket.write(`${jsonRpc(9, "ping")}\n`);
  await waitFor("association-timeout diagnostic", () =>
    diagnostics.some((diagnostic) => diagnostic.kind === "association-timeout")
      ? diagnostics
      : undefined,
  );
  await new Promise<void>((resolve) => {
    if (orphanSocket.destroyed) resolve();
    else orphanSocket.once("close", () => resolve());
  });
});

test("codex launch arguments carry exactly the measured -c overrides with a TOML inline env table", () => {
  assert.deepEqual(
    codexWorkbenchLaunchArguments({
      command: "C:\\node\\node.exe",
      args: ["C:\\app\\bootstrap.js", "\\\\.\\pipe\\p", "tok"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    }),
    [
      "-c",
      "mcp_servers.workbench.command=C:\\node\\node.exe",
      "-c",
      'mcp_servers.workbench.args=["C:\\\\app\\\\bootstrap.js","\\\\\\\\.\\\\pipe\\\\p","tok"]',
      "-c",
      'mcp_servers.workbench.env={"ELECTRON_RUN_AS_NODE"="1"}',
    ],
  );
  assert.deepEqual(
    codexWorkbenchLaunchArguments({
      command: "node",
      args: ["bootstrap.js", "pipe", "token"],
    }),
    [
      "-c",
      "mcp_servers.workbench.command=node",
      "-c",
      'mcp_servers.workbench.args=["bootstrap.js","pipe","token"]',
    ],
  );
  assert.throws(
    () => codexWorkbenchLaunchArguments({ command: "", args: ["a"] }),
    RuntimeAdapterError,
  );
  assert.throws(
    () =>
      codexWorkbenchLaunchArguments({
        command: "node",
        args: ["a"],
        env: { BAD: "" },
      }),
    RuntimeAdapterError,
  );
});

test("the runtime endpoint directory forwards the optional binding to the endpoint adapter on start and resume", async () => {
  const seen: Array<Pick<RuntimeStart, "workbenchMcp">> = [];
  const seenResumes: Array<Pick<RuntimeResume, "workbenchMcp">> = [];
  const endpoint: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return {
        runtime: "fixture",
        models: [],
        executionModes: [],
        accessModes: [],
      };
    },
    async start(request) {
      seen.push(
        request.workbenchMcp === undefined
          ? {}
          : { workbenchMcp: request.workbenchMcp },
      );
      return {
        profile: request.profile,
        opaqueSessionReference: "endpoint-ref",
        async send() {},
        async *events() {
          yield { kind: "session-started" } as const;
        },
      };
    },
    async resume(request) {
      seenResumes.push(
        request.workbenchMcp === undefined
          ? {}
          : { workbenchMcp: request.workbenchMcp },
      );
      return {
        profile: request.profile,
        opaqueSessionReference: request.opaqueSessionReference,
        async send() {},
        async *events() {
          yield { kind: "session-started" } as const;
        },
      };
    },
  };
  const registration: RuntimeEndpointRegistration = Object.freeze({
    registrationId: "wiring-registration",
    endpointId: "wiring-endpoint",
    runtimeFamily: "codex",
    executionLocation: "local",
    adapter: endpoint,
    capabilitySnapshot: Object.freeze({
      snapshotId: "wiring-snapshot",
      freshness: "fresh",
      availability: "online",
      contracts: Object.freeze({
        supervisorWorkOrders: true,
        workerSessions: true,
        normalizedEvents: true,
      }),
      profiles: Object.freeze([
        Object.freeze({
          profileId: "wiring-profile",
          modelLabel: "Visible model",
          workIntensityLabel: "Visible effort",
          runtimeProfile: profile,
          nativeRuntimeProfile: profile,
        }),
      ]),
    }),
    policy: Object.freeze({
      maximumBudgetUnits: 1_000,
      availableConcurrency: 1,
      allowedAccessModes: Object.freeze(["full-access" as const]),
      allowedWorkerEndpointIds: Object.freeze(["wiring-endpoint"]),
    }),
  });
  const directory = createRuntimeEndpointDirectory([registration]);
  const adapter = directory.runtimeAdapter();
  const spec: RuntimeWorkbenchMcpServer = Object.freeze({
    command: "node",
    args: ["b.js", "\\\\.\\pipe\\x", "t"],
    env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1" }),
  });

  await adapter.start({
    projectDirectory: "project",
    profile,
    workbenchMcp: spec,
  });
  await adapter.start({ projectDirectory: "project", profile });
  await adapter.resume({
    projectDirectory: "project",
    profile,
    opaqueSessionReference: "endpoint-ref",
    workbenchMcp: spec,
  });
  await adapter.resume({
    projectDirectory: "project",
    profile,
    opaqueSessionReference: "endpoint-ref",
  });
  assert.deepEqual(seen, [{ workbenchMcp: spec }, {}]);
  assert.deepEqual(seenResumes, [{ workbenchMcp: spec }, {}]);
});
