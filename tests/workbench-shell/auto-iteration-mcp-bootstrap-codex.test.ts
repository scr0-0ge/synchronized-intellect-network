import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import {
  createKimiPlatformEndpointContext,
  ensureKimiPlatformCodexHome,
} from "../../src/agent-runtime/codex/kimi-platform-catalog.ts";
import { discoverOfficialCodexLaunch } from "../../src/agent-runtime/codex/process-transport.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";
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
import type { HandoffIdempotencyKey } from "../../src/coordinator/auto-iteration/contract.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type { WorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type {
  AutoIterationMcpServer,
  JsonRpcRequest,
} from "../../src/workbench-shell/auto-iteration-mcp-server.ts";
import {
  createAutoIterationMcpPipeHost,
  type AutoIterationMcpPipeBinding,
  type AutoIterationMcpPipeDiagnostic,
} from "../../src/workbench-shell/auto-iteration-mcp-host.ts";

/**
 * END-TO-END GUARD, real Codex CLI (0.153.4 on this machine) + fake Responses
 * HTTP, zero real inference (issue #8 / the annual-report worker flow): the CLI receives the
 * Workbench `workbench` MCP server through the two `-c mcp_servers.workbench.*`
 * session overrides (the shape w262 §4.3 measured on 0.154.0), spawns the
 * bootstrap, and a model-issued function call to the handoff tool reaches the
 * REAL backend coordinator through the named pipe. The assertion is the
 * durable ledger: the handoff row with a `persisted` receipt, read the same
 * way the M0 main-wiring guard reads it.
 *
 * Machine dependencies (deliberately RED, never skipped, when absent):
 * - a locatable Codex CLI through the production `discoverOfficialCodexLaunch`;
 * - `dist/main/auto-iteration-mcp-bootstrap.js` from `.\pnpm.bat build:main`.
 *
 * The fake Responses provider is an in-process HTTP server on 127.0.0.1
 * carrying the codex-api custom-provider route (isolated CODEX_HOME seeded by
 * the production `createCodexApiEndpointContext`, base_url pinned to the fake
 * server, fake OPENAI_API_KEY). No provider credential is used or read.
 *
 * The spawn arguments are exactly the production shape minus the missing
 * executor seam (reported separately): the transport factory is injected here
 * because `OfficialRuntimeTransportFactory` cannot yet carry per-session MCP
 * overrides.
 */

const fixtureModel = "fixture-codex-model";

const ledgerProfile: SessionProfile = Object.freeze({
  model: fixtureModel,
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const codexProfile: SessionProfile = Object.freeze({
  model: "kimi-k2.7-code",
  effortLevel: "default",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const ledgerCatalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({ id: fixtureModel, effortLevels: Object.freeze(["high"]) }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const turnEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({ kind: "agent-message" as const, text: "FIXTURE_TURN_BODY" }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

class ScriptedBinding implements ResumableRuntimeBinding {
  readonly profile = ledgerProfile;
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
  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(ledgerCatalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    assert.equal(request.profile.model, fixtureModel);
    return new ScriptedBinding(`native-start-${Date.now()}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return new ScriptedBinding(request.opaqueSessionReference);
  }
}

interface FakeResponsesServer {
  readonly port: number;
  readonly server: Server;
  readonly responsesRequests: number;
  setFunctionCall(
    namespace: string | undefined,
    name: string,
    arguments_: Record<string, unknown>,
  ): void;
  close(): Promise<void>;
}

function startFakeResponsesServer(): Promise<FakeResponsesServer> {
  let responsesRequests = 0;
  let callNamespace: string | undefined = "mcp__workbench";
  let callName = "submit_handoff";
  let callArguments: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (!request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      responsesRequests += 1;
      const frames =
        responsesRequests === 1
          ? functionCallReply(callName, callNamespace, callArguments)
          : finalAnswerReply();
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) {
        response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
      }
      response.end();
    })().catch(() => response.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolve({
        port: address.port,
        server,
        get responsesRequests() {
          return responsesRequests;
        },
        setFunctionCall(
          namespace: string | undefined,
          name: string,
          arguments_: Record<string, unknown>,
        ) {
          callNamespace = namespace;
          callName = name;
          callArguments = arguments_;
        },
        close() {
          server.closeAllConnections();
          return new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          });
        },
      });
    });
  });
}

function responseObject(
  output: unknown[],
  usage: Record<string, number>,
): Record<string, unknown> {
  return {
    id: `resp_fixture_${usage.input_tokens}_${usage.output_tokens}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "gpt-5.6-sol",
    output,
    usage: {
      input_tokens: usage.input_tokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.output_tokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  };
}

function functionCallReply(
  name: string,
  namespace: string | undefined,
  callArguments: Record<string, unknown>,
): Record<string, unknown>[] {
  const argumentsJson = JSON.stringify(callArguments);
  const namespaced = namespace === undefined ? {} : { namespace };
  const functionCall = {
    id: "fc_fixture_handoff",
    type: "function_call",
    status: "completed",
    call_id: "call_fixture_handoff",
    name,
    ...namespaced,
    arguments: argumentsJson,
  };
  return [
    {
      type: "response.created",
      response: responseObject([], { input_tokens: 12, output_tokens: 0 }),
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionCall, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: functionCall.id,
      output_index: 0,
      delta: argumentsJson,
    },
    { type: "response.output_item.done", output_index: 0, item: functionCall },
    {
      type: "response.completed",
      response: responseObject([functionCall], {
        input_tokens: 12,
        output_tokens: 6,
      }),
    },
  ];
}

function finalAnswerReply(): Record<string, unknown>[] {
  const message = {
    id: "msg_fixture_final",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      { type: "output_text", text: "handoff submitted", annotations: [] },
    ],
  };
  return [
    {
      type: "response.created",
      response: responseObject([], { input_tokens: 20, output_tokens: 0 }),
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: "handoff submitted",
    },
    {
      type: "response.content_part.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "handoff submitted", annotations: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: responseObject([message], {
        input_tokens: 20,
        output_tokens: 4,
      }),
    },
  ];
}

async function waitFor<T>(
  describe: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMilliseconds = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${describe}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

function scratchParent(): string {
  return process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir();
}

async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== "EBUSY") {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
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

let lastTransportDiagnostics = "production factory (no custom transport)";

test("the real Codex CLI delivers a worker handoff through the bootstrap pipe bridge into the durable ledger", async (t) => {
  const root = await mkdtemp(join(realpathSync(scratchParent()), "w300-codex-e2e-"));
  const home = join(root, "home");
  const roaming = join(home, "AppData", "Roaming");
  const local = join(home, "AppData", "Local");
  const codexHome = join(root, "codex-home");
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  for (const directory of [home, roaming, local, codexHome, projectDirectory]) {
    await mkdir(directory, { recursive: true });
  }
  t.after(async () => {
    await removeTree(root);
  });

  const bootstrapEntry = join(
    realpathSync(join(import.meta.dirname, "..", "..")),
    "dist",
    "main",
    "auto-iteration-mcp-bootstrap.js",
  );
  await assertAccessible(bootstrapEntry, "run .\\pnpm.bat build:main");

  const launch = await discoverOfficialCodexLaunch().catch(() => undefined);
  assert.ok(
    launch !== undefined,
    "no Codex CLI located through the production discovery; this guard is machine-dependent by design",
  );

  const fake = await startFakeResponsesServer();
  t.after(async () => {
    await fake.close().catch(() => undefined);
  });

  // The kimi-platform route is the custom-provider shape this CLI generation
  // actually exposes model-visible function tools for (measured: gpt-5.6-sol
  // over a custom responses provider advertised NO tools at all on 0.154.0).
  // Seeding happens through the adapter's own `prepareEndpoint` (the default
  // endpoint-context factory), exactly as in production.
  const codexAdapter = new CodexAdapter(
    undefined,
    undefined,
    undefined,
    createKimiPlatformEndpointContext({
      codexHome,
      baseUrl: `http://127.0.0.1:${fake.port}`,
      resolveApiKey: () => "w300-fake-codex-key",
      sourceEnvironment: Object.freeze({
        ...process.env,
        NO_PROXY: "127.0.0.1,localhost",
      }),
    }),
  );

  const adapter = new ScriptedLoopAdapter();
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  t.after(async () => {
    await backend.close().catch(() => undefined);
  });
  const service = backend.autoIteration;
  assert.ok(service, "the backend must expose the auto-iteration service");

  const supervisorSessionId = await service.startHostSession({
    endpointId: "codex-desktop",
    profile: ledgerProfile,
    input: "supervisor opening turn",
  });
  assert.ok(typeof supervisorSessionId === "string");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "codex-e2e-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      objective: "Deliver a fixture handoff through the bootstrap bridge",
      acceptanceCriteria: ["handoff reaches the durable ledger"],
      baselineCommitSha: "0123456789abcdef0123456789abcdef01234567",
      territory: { writePaths: ["src/"], readOnlyPaths: ["docs/"] },
      responsibleRoleSlotId: "project-supervisor",
      completionCondition: { gitIntegration: "not-required" },
      workerSession: { endpointId: "codex-desktop", profile: ledgerProfile },
    },
  });
  assert.equal(submitted.kind, "work-order-submitted");
  const workOrderId = (submitted.workOrder as Record<string, unknown>)
    .workOrderId as string;
  const attemptId = (submitted.attempt as Record<string, unknown>)
    .attemptId as string;

  const workerSessionId = await waitFor("worker Session binding", () => {
    const order = service.authority
      .readAutoIterationOverview()
      .workOrders.find((candidate) => candidate.workOrderId === workOrderId);
    return order?.workerSessionBound ? order.workerSessionId ?? undefined : undefined;
  });

  const diagnostics: AutoIterationMcpPipeDiagnostic[] = [];
  const host = createAutoIterationMcpPipeHost({
    bootstrapEntry,
    serverForSession: (sessionId) => service.mcpServerForSession(sessionId),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(() => host.close());
  const binding = host.openBinding(workerSessionId);

  const handoffKey: HandoffIdempotencyKey = {
    workOrderId,
    attemptId,
    handoffId: "handoff-codex-e2e-1",
  };
  fake.setFunctionCall(
    "mcp__workbench",
    "submit_handoff",
    {
      requestIdempotencyKey: "codex-e2e-handoff-1",
      expectedVersion: 1,
      observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
      handoff: {
        idempotencyKey: handoffKey,
        body: "Delivered by the real Codex CLI through the bootstrap bridge.",
        artifactIds: [],
      },
    },
  );

  const runtime = await codexAdapter.start({
    projectDirectory,
    profile: codexProfile,
    workbenchMcp: binding.bootstrap,
  });
  const stopRuntime = async () => {
    const stop = (runtime as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop().catch(() => undefined);
  };
  t.after(async () => {
    await stopRuntime();
  });

  // codex builds the thread's model-visible tool catalog at turn start and
  // starts the workbench MCP server lazily at thread creation; a turn fired
  // immediately races the ~60ms handshake and runs with zero MCP tools
  // (measured on 0.153.4/0.154.0). One bounded wait closes that race.
  await new Promise<void>((resolve) => setTimeout(resolve, 2_000));

  // The product contract: send() first, then consume events() — calling
  // events() before the turn exists stops the transport by design.
  await runtime.send({ text: "Submit your handoff now." });

  const observedEvents: string[] = [];
  let failureCategory: string | undefined;
  const turnDone = (async () => {
    for await (const event of runtime.events()) {
      observedEvents.push(event.kind);
      if (event.kind === "failed") {
        failureCategory = (event as { category?: string }).category;
      }
      if (
        event.kind === "turn-completed" ||
        event.kind === "failed" ||
        event.kind === "turn-interrupted" ||
        event.kind === "turn-paused"
      ) {
        return event.kind;
      }
    }
    return "stream-end";
  })();

  const status = await waitFor("handoff persisted in the ledger", async () => {
    for (let version = 1; version <= 4; version += 1) {
      const response = await callTool(
        supervisorServer,
        "read_work_order_status",
        {
          requestIdempotencyKey: `codex-e2e-status-${version}-${Date.now()}`,
          expectedVersion: version,
          observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
          workOrderId,
        },
      ).catch(() => undefined);
      if (response === undefined || response.kind !== "work-order-status") {
        continue;
      }
      const handoffs = response.handoffs as Array<
        Record<string, HandoffIdempotencyKey>
      >;
      const receipts = response.receipts as Array<{ level?: string }>;
      if (
        handoffs.some(
          (handoff) => handoff.idempotencyKey?.handoffId === handoffKey.handoffId,
        ) &&
        receipts.some((receipt) => receipt.level === "persisted")
      ) {
        return response;
      }
    }
    return undefined;
  }, 90_000).catch(() => undefined);
  if (status === undefined) {
    assert.fail(
      `the handoff never reached the ledger; provider /responses calls=${fake.responsesRequests}, observed runtime events=${observedEvents.join(",")}, failure=${failureCategory ?? "none"}, transport=${lastTransportDiagnostics}`,
    );
  }

  assert.equal(
    diagnostics.some(
      (diagnostic) => diagnostic.kind === "second-connection-refused",
    ),
    false,
  );

  await waitFor("supervisor wakeup after the handoff", async () => {
    const order = service.authority
      .readAutoIterationOverview()
      .workOrders.find((candidate) => candidate.workOrderId === workOrderId);
    return order?.status === "awaiting-review" ? order : undefined;
  }, 30_000);

  await turnDone;
  await stopRuntime();
});

async function assertAccessible(path: string, hint: string): Promise<void> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
  } catch {
    assert.fail(`missing ${path} (${hint})`);
  }
}
