import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  AutoIterationCoordinatorPort,
  HostBoundToolActor,
  SupervisorToolRequest,
  SupervisorToolResponse,
  WorkerToolRequest,
  WorkerToolResponse,
} from "../../src/coordinator/auto-iteration/contract.ts";
import { createSessionAuthority } from "../../src/coordinator/auto-iteration/session-authority.ts";
import {
  createAutoIterationMcpServer,
  type AutoIterationMcpServer,
} from "../../src/workbench-shell/auto-iteration-mcp-server.ts";
import {
  createAutoIterationMcpPipeHost,
  type AutoIterationMcpPipeDiagnostic,
} from "../../src/workbench-shell/auto-iteration-mcp-host.ts";
import {
  claudeMcpConfigJson,
  createClaudeSessionArguments,
} from "../../src/agent-runtime/claude/process-transport.ts";
import type { SessionProfile } from "../../src/agent-runtime/index.ts";

/**
 * Guards for the Workbench MCP bootstrap bridge host side (issue #8): the
 * named-pipe host, the standalone bootstrap entry a CLI spawns, and the
 * `--mcp-config` payload the Claude adapter receives. The end-to-end guards
 * with real CLIs live in `auto-iteration-mcp-bootstrap-claude.test.ts` and
 * `auto-iteration-mcp-bootstrap-codex.test.ts`.
 *
 * The bootstrap process guard needs the BUILT second Vite entry
 * `dist/main/auto-iteration-mcp-bootstrap.js`. It is deliberately RED (never
 * skipped) when that file is missing: run `.\pnpm.bat build:main` first.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bootstrapEntry = join(repositoryRoot, "dist", "main", "auto-iteration-mcp-bootstrap.js");

class RecordingPort implements AutoIterationCoordinatorPort {
  readonly calls: string[] = [];

  async request(
    actor: Extract<HostBoundToolActor, { readonly kind: "supervisor" }>,
    request: SupervisorToolRequest,
  ): Promise<SupervisorToolResponse>;
  async request(
    actor: Extract<HostBoundToolActor, { readonly kind: "worker" }>,
    request: WorkerToolRequest,
  ): Promise<WorkerToolResponse>;
  async request(
    _actor: HostBoundToolActor,
    request: SupervisorToolRequest | WorkerToolRequest,
  ): Promise<SupervisorToolResponse | WorkerToolResponse> {
    this.calls.push(request.kind);
    return {
      kind: "inbox-read",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: 2,
      entries: [],
    };
  }
}

function workerBridge() {
  const port = new RecordingPort();
  const authority = createSessionAuthority();
  authority.bindSession({
    actor: {
      kind: "worker",
      sessionId: "worker-session",
      workOrderId: "work-order-1",
      attemptId: "attempt-1",
    },
  });
  const servers = new Map<string, AutoIterationMcpServer>();
  const serverForSession = (sessionId: string) => {
    const existing = servers.get(sessionId);
    if (existing !== undefined) return existing;
    const server = createAutoIterationMcpServer({
      sessionId,
      authority,
      port,
    });
    servers.set(sessionId, server);
    return server;
  };
  return { port, serverForSession };
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
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function nextResponse(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return parsed;
  } catch {
    return undefined;
  }
}

test("the named-pipe bridge serves a spawned bootstrap through the real in-process MCP server", async (t) => {
  assert.ok(
    bootstrapEntry,
    "bootstrap entry path must resolve inside the repository",
  );
  await assertBuildEntryExists();
  const { port, serverForSession } = workerBridge();
  const diagnostics: AutoIterationMcpPipeDiagnostic[] = [];
  const host = createAutoIterationMcpPipeHost({
    bootstrapEntry,
    serverForSession,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(() => host.close());
  const binding = host.openBinding("worker-session");
  assert.match(binding.pipeName, /^\\\\\.\\pipe\\/u);
  assert.equal(binding.bootstrap.command, process.execPath);
  assert.deepEqual(binding.bootstrap.args, [
    bootstrapEntry,
    binding.pipeName,
    binding.token,
  ]);
  assert.deepEqual(binding.bootstrap.env, { ELECTRON_RUN_AS_NODE: "1" });

  const child = spawn(
    binding.bootstrap.command,
    [...binding.bootstrap.args],
    Object.freeze({
      env: { ...process.env, ...binding.bootstrap.env },
      stdio: "pipe",
      windowsHide: true,
    }),
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  assert.equal(child.pid !== undefined, true, "the bootstrap process must spawn");

  const responses: Record<string, unknown>[] = [];
  const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutLines.on("line", (line) => {
    const parsed = nextResponse(line);
    if (parsed !== undefined) responses.push(parsed);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const userFrame = (id: number, method: string, params?: unknown) =>
    `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`;
  child.stdin.write(userFrame(1, "initialize", { protocolVersion: "2025-06-18" }));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(userFrame(2, "tools/list"));
  child.stdin.write(
    userFrame(3, "tools/call", {
      name: "read_inbox",
      arguments: {
        requestIdempotencyKey: "pipe-guard-read-1",
        expectedVersion: 1,
        observedTenure: { roleSlotId: "project-supervisor", generation: 1 },
        roleSlotId: "project-supervisor",
      },
    }),
  );

  const initialize = await waitFor("initialize over the pipe", () =>
    responses.find((response) => response.id === 1),
  );
  const initializeResult = initialize.result as {
    serverInfo: { name: string };
  };
  assert.equal(initializeResult.serverInfo.name, "workbench-auto-iteration");
  const listed = await waitFor("tools/list over the pipe", () =>
    responses.find((response) => response.id === 2),
  );
  const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read_work_order_status", "submit_handoff", "read_inbox"],
  );
  const inboxRead = await waitFor("tools/call over the pipe", () =>
    responses.find((response) => response.id === 3),
  );
  const content = (inboxRead.result as { content: Array<{ text: string }> }).content;
  const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
  assert.equal(payload.kind, "inbox-read");
  assert.deepEqual(port.calls, ["read-inbox"]);
  assert.equal(stderr, "");
  assert.deepEqual(diagnostics, []);

  child.kill();
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
});

test("a binding accepts exactly one connection and is spent when it ends", async (t) => {
  await assertBuildEntryExists();
  const { serverForSession } = workerBridge();
  const diagnostics: AutoIterationMcpPipeDiagnostic[] = [];
  const host = createAutoIterationMcpPipeHost({
    bootstrapEntry,
    serverForSession,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(() => host.close());
  const binding = host.openBinding("worker-session");

  const first = connect(binding.pipeName);
  t.after(() => first.destroy());
  await new Promise<void>((resolve) => first.once("connect", resolve));
  first.write(`${JSON.stringify({ type: "binding-hello", token: binding.token })}\n`);

  const second = connect(binding.pipeName);
  t.after(() => second.destroy());
  const secondOutcome = await new Promise<"connected" | "refused">((resolve) => {
    second.once("connect", () => resolve("connected"));
    second.once("close", () => resolve("refused"));
    second.once("error", () => resolve("refused"));
  });
  // The refused client can observe a connect before the host destroys it, so
  // the refusal is asserted on the host diagnostic and the socket ending,
  // not on which event fired first.
  if (secondOutcome === "connected") {
    await new Promise<void>((resolve) => {
      if (second.destroyed) resolve();
      else second.once("close", () => resolve());
    });
  }
  await waitFor("second-connection-refused diagnostic", () =>
    diagnostics.some((diagnostic) => diagnostic.kind === "second-connection-refused")
      ? diagnostics
      : undefined,
  );

  first.destroy();
  await waitFor("binding spent after its connection ends", () =>
    diagnostics.some((diagnostic) => diagnostic.kind === "connection-closed")
      ? diagnostics
      : undefined,
  );
  const third = connect(binding.pipeName);
  t.after(() => third.destroy());
  const thirdOutcome = await new Promise<"connected" | "refused">((resolve) => {
    const timer = setTimeout(() => resolve("connected"), 1_500);
    const settle = (outcome: "connected" | "refused") => {
      clearTimeout(timer);
      resolve(outcome);
    };
    third.once("connect", () => settle("connected"));
    third.once("close", () => settle("refused"));
    third.once("error", () => settle("refused"));
  });
  assert.equal(thirdOutcome, "refused", "a spent binding must not accept again");
  host.closeBinding(binding);
  assert.equal(host.openBinding("worker-session").token.length > 0, true);
});

test("a connection presenting the wrong one-shot token is dropped without any tool traffic", async (t) => {
  await assertBuildEntryExists();
  const { port, serverForSession } = workerBridge();
  const diagnostics: AutoIterationMcpPipeDiagnostic[] = [];
  const host = createAutoIterationMcpPipeHost({
    bootstrapEntry,
    serverForSession,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(() => host.close());
  const binding = host.openBinding("worker-session");

  const socket = connect(binding.pipeName);
  t.after(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    `${JSON.stringify({ type: "binding-hello", token: "not-the-token" })}\n`,
  );
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })}\n`,
  );
  await waitFor("binding-token-mismatch diagnostic", () =>
    diagnostics.some((diagnostic) => diagnostic.kind === "binding-token-mismatch")
      ? diagnostics
      : undefined,
  );
  await new Promise<void>((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
  assert.deepEqual(port.calls, []);
});

test("the bootstrap exits non-zero when the host pipe breaks", async (t) => {
  await assertBuildEntryExists();
  const { serverForSession } = workerBridge();
  const host = createAutoIterationMcpPipeHost({ bootstrapEntry, serverForSession });
  const binding = host.openBinding("worker-session");
  const child = spawn(
    binding.bootstrap.command,
    [...binding.bootstrap.args],
    Object.freeze({
      env: { ...process.env, ...binding.bootstrap.env },
      stdio: "pipe",
      windowsHide: true,
    }),
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  // Prove the connection was live first: one full JSON-RPC roundtrip.
  const responses: Record<string, unknown>[] = [];
  const stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutLines.on("line", (line) => {
    const parsed = nextResponse(line);
    if (parsed !== undefined) responses.push(parsed);
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
  );
  const initialize = await waitFor("initialize before the pipe breaks", () =>
    responses.find((response) => response.id === 1),
  );
  assert.ok("result" in initialize);

  host.close();
  const code = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("close", (exitCode) => resolve(exitCode));
  });
  assert.notEqual(code, 0, "a broken pipe must exit non-zero");
});

test("claude session arguments carry exactly the workbench MCP server when a binding is present and stay empty otherwise", () => {
  const profile: SessionProfile = Object.freeze({
    model: "fixture-model",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const plain = createClaudeSessionArguments({
    projectDirectory: "C:\\proj",
    profile,
    permissionMode: "bypassPermissions",
  });
  const plainConfigIndex = plain.indexOf("--mcp-config");
  assert.ok(plainConfigIndex > 0);
  assert.equal(plain[plainConfigIndex + 1], '{"mcpServers":{}}');
  assert.equal(plain.includes("--strict-mcp-config"), true);

  const bound = createClaudeSessionArguments({
    projectDirectory: "C:\\proj",
    profile,
    permissionMode: "bypassPermissions",
    workbenchMcp: {
      command: "C:\\node\\node.exe",
      args: ["C:\\app\\dist\\main\\auto-iteration-mcp-bootstrap.js", "\\\\.\\pipe\\x", "tok"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  });
  const configIndex = bound.indexOf("--mcp-config");
  assert.ok(configIndex > 0);
  assert.equal(bound[configIndex + 1], claudeMcpConfigJson({
    command: "C:\\node\\node.exe",
    args: ["C:\\app\\dist\\main\\auto-iteration-mcp-bootstrap.js", "\\\\.\\pipe\\x", "tok"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  }));
  assert.equal(bound.includes("--strict-mcp-config"), true);
  const parsed = JSON.parse(bound[configIndex + 1]) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(parsed.mcpServers), ["workbench"]);
  assert.deepEqual(parsed.mcpServers.workbench, {
    command: "C:\\node\\node.exe",
    args: ["C:\\app\\dist\\main\\auto-iteration-mcp-bootstrap.js", "\\\\.\\pipe\\x", "tok"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

test("claudeMcpConfigJson omits env when the binding carries none", () => {
  assert.equal(
    claudeMcpConfigJson({
      command: "node",
      args: ["bootstrap.js", "pipe", "token"],
    }),
    '{"mcpServers":{"workbench":{"command":"node","args":["bootstrap.js","pipe","token"]}}}',
  );
});

async function assertBuildEntryExists(): Promise<void> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(bootstrapEntry);
  } catch {
    assert.fail(
      `missing ${bootstrapEntry}: run .\\pnpm.bat build:main to emit the second Vite entry before this guard`,
    );
  }
}
