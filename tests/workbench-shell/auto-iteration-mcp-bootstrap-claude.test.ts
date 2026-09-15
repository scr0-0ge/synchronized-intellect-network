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
  type AutoIterationMcpPipeDiagnostic,
} from "../../src/workbench-shell/auto-iteration-mcp-host.ts";
import {
  createClaudeSessionArguments,
  discoverClaudeLaunch,
} from "../../src/agent-runtime/claude/process-transport.ts";

/**
 * END-TO-END GUARD, real Claude Code CLI + fake Anthropic HTTP, zero real
 * inference (issue #8 / the annual-report worker flow): the CLI spawns the Workbench bootstrap
 * as its `workbench` stdio MCP server, the bootstrap connects to the host's
 * named pipe, and `tools/call mcp__workbench__submit_handoff` reaches the
 * REAL backend coordinator through the bridge. The assertion is the durable
 * ledger: the handoff row with a `persisted` receipt, read the same way the
 * M0 main-wiring guard reads it.
 *
 * Machine dependencies (deliberately RED, never skipped, when absent):
 * - a locatable Claude Code CLI through the production `discoverClaudeLaunch`
 *   (on the project machine: `~/.local/bin/claude.exe`, 2.1.267);
 * - `dist/main/auto-iteration-mcp-bootstrap.js` from `.\pnpm.bat build:main`.
 *
 * The fake Anthropic server is an in-process HTTP server on 127.0.0.1: the
 * first /v1/messages reply carries one `tool_use` block calling
 * `mcp__workbench__submit_handoff`; the second reply ends the turn. No
 * provider credential is used or read; the config/home trees are throwaway
 * directories under the lane scratch root (`UAW_LANE_SCRATCH`, else
 * `RUNNER_TEMP`, else the OS temp).
 */

const fixtureModel = "fixture-claude-model";

const profile: SessionProfile = Object.freeze({
  model: fixtureModel,
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const catalog: RuntimeCatalog = Object.freeze({
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
  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    assert.equal(request.profile.model, fixtureModel);
    return new ScriptedBinding(`native-start-${Date.now()}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return new ScriptedBinding(request.opaqueSessionReference);
  }
}

interface FakeAnthropicServer {
  readonly port: number;
  readonly server: Server;
  readonly messageRequests: number;
  setHandoffArguments(arguments_: Record<string, unknown>): void;
  close(): Promise<void>;
}

function startFakeAnthropicServer(): Promise<FakeAnthropicServer> {
  let messageRequests = 0;
  let handoffArguments: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      if (request.url?.includes("count_tokens")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(404).end();
        return;
      }
      messageRequests += 1;
      const reply = messageRequests === 1
        ? toolUseReply(handoffArguments)
        : endTurnReply();
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of reply) {
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
        get messageRequests() {
          return messageRequests;
        },
        setHandoffArguments(arguments_: Record<string, unknown>) {
          handoffArguments = arguments_;
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

function messageFrame(id: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: fixtureModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  };
}

function toolUseReply(
  handoffArguments: Record<string, unknown>,
): Record<string, unknown>[] {
  const input = JSON.stringify(handoffArguments);
  return [
    messageFrame("fixture-tool-use"),
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_fixture_handoff",
        name: "mcp__workbench__submit_handoff",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: input },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ];
}

function endTurnReply(): Record<string, unknown>[] {
  return [
    messageFrame("fixture-end-turn"),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "handoff submitted" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
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
  // The lane scratch convention (common2.md / packaged-smoke precedent):
  // the runner supplies UAW_LANE_SCRATCH or RUNNER_TEMP; the OS temp is the
  // last resort. Spawns in this guard use shell:false, so a spaced path is
  // structurally safe here; the lane root and CI runners are space-free.
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

test("the real Claude CLI delivers a worker handoff through the bootstrap pipe bridge into the durable ledger", async (t) => {
  const root = await mkdtemp(join(realpathSync(scratchParent()), "w300-claude-e2e-"));
  const home = join(root, "home");
  const roaming = join(home, "AppData", "Roaming");
  const local = join(home, "AppData", "Local");
  const claudeConfig = join(root, "claude-config");
  const projectDirectory = join(root, "Project");
  const databasePath = join(root, "workbench.sqlite");
  for (const directory of [home, roaming, local, claudeConfig, projectDirectory]) {
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

  const launch = await discoverClaudeLaunch().catch(() => undefined);
  assert.ok(
    launch !== undefined,
    "no Claude Code CLI located through the production discovery (PATH, %APPDATA%\\npm, ~\\.local\\bin, managed roots); this guard is machine-dependent by design",
  );

  const fake = await startFakeAnthropicServer();
  t.after(async () => {
    await fake.close().catch(() => undefined);
  });

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
    profile,
    input: "supervisor opening turn",
  });
  assert.ok(typeof supervisorSessionId === "string");
  await service.bindInitialSupervisor({
    roleSlotId: "project-supervisor",
    sessionId: supervisorSessionId,
  });
  const supervisorServer = service.mcpServerForSession(supervisorSessionId);
  const submitted = await callTool(supervisorServer, "submit_work_order", {
    requestIdempotencyKey: "claude-e2e-submit-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    workOrder: {
      objective: "Deliver a fixture handoff through the bootstrap bridge",
      acceptanceCriteria: ["handoff reaches the durable ledger"],
      baselineCommitSha: "0123456789abcdef0123456789abcdef01234567",
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
    handoffId: "handoff-claude-e2e-1",
  };
  fake.setHandoffArguments({
    requestIdempotencyKey: "claude-e2e-handoff-1",
    expectedVersion: 1,
    observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
    handoff: {
      idempotencyKey: handoffKey,
      body: "Delivered by the real Claude CLI through the bootstrap bridge.",
      artifactIds: [],
    },
  });

  const arguments_ = createClaudeSessionArguments({
    projectDirectory,
    profile,
    permissionMode: "bypassPermissions",
    workbenchMcp: binding.bootstrap,
  });
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    CLAUDE_CONFIG_DIR: claudeConfig,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
    ANTHROPIC_AUTH_TOKEN: "w300-fake-token",
    ANTHROPIC_MODEL: fixtureModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: fixtureModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: fixtureModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fixtureModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    NO_PROXY: "127.0.0.1,localhost",
  });

  const child = spawn(
    launch.executable,
    [...launch.prefixArguments, ...arguments_],
    Object.freeze({
      cwd: projectDirectory,
      env: environment,
      stdio: "pipe",
      windowsHide: true,
    }),
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const stdoutFrames: Record<string, unknown>[] = [];
  const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutLines.on("line", (line) => {
    if (line.trim().length === 0) return;
    try {
      stdoutFrames.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Non-JSON diagnostics on stdout are not interesting to this guard.
    }
  });
  const childExit = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  child.stdin.write(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: "Submit your handoff now." },
    })}\n`,
  );

  // THE assertion, read the way the M0 wiring guard reads it (`read_work_order_status`
  // receipts; the overview does not expose them). The work order version moves
  // as the wakeup drains, so the probe tries the few reachable versions rather
  // than guessing one.
  const status = await waitFor("handoff persisted in the ledger", async () => {
    for (let version = 1; version <= 4; version += 1) {
      const response = await callTool(
        supervisorServer,
        "read_work_order_status",
        {
          requestIdempotencyKey: `claude-e2e-status-${version}-${Date.now()}`,
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
      `the handoff never reached the ledger; claude exit pending=${child.exitCode === null}, provider /v1/messages calls=${fake.messageRequests}, stderr=${stderr.slice(0, 2_000)}, stdout frames=${stdoutFrames
        .map((frame) => String(frame.type ?? frame.subtype ?? "?"))
        .join(",")}`,
    );
  }

  // The bridge saw no second connection attempt from the CLI's bootstrap.
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

  child.kill();
  await childExit;
});

async function assertAccessible(path: string, hint: string): Promise<void> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(path);
  } catch {
    assert.fail(`missing ${path} (${hint})`);
  }
}
