import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

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
  serveAutoIterationMcpStdio,
} from "../../src/workbench-shell/auto-iteration-mcp-server.ts";

class InboxPort implements AutoIterationCoordinatorPort {
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
    return {
      kind: "inbox-read",
      requestIdempotencyKey: request.requestIdempotencyKey,
      currentVersion: 2,
      entries: [],
    };
  }
}

function workerServer() {
  const authority = createSessionAuthority();
  authority.bindSession({
    actor: {
      kind: "worker",
      sessionId: "worker-session",
      workOrderId: "work-order-1",
      attemptId: "attempt-1",
    },
  });
  return createAutoIterationMcpServer({
    sessionId: "worker-session",
    authority,
    port: new InboxPort(),
  });
}

test("MCP tools/list exposes only the host-bound worker subset and no identity input", async () => {
  const server = workerServer();

  const initialized = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture-client", version: "1" },
    },
  });
  assert.deepEqual(initialized, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "workbench-auto-iteration", version: "1" },
    },
  });

  const listed = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.ok(listed && "result" in listed);
  if (!listed || !("result" in listed)) throw new Error("tools/list failed");
  const tools = (listed.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["read_work_order_status", "submit_handoff", "read_inbox"],
  );
  for (const tool of tools) {
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
    };
    assert.equal("sessionId" in schema.properties, false);
    assert.equal("actor" in schema.properties, false);
    assert.equal("role" in schema.properties, false);
  }

  const supervisorAuthority = createSessionAuthority();
  supervisorAuthority.bindSession({
    actor: {
      kind: "supervisor",
      sessionId: "supervisor-session",
      tenure: { roleSlotId: "project-supervisor", generation: 2 },
    },
  });
  const supervisorListed = await createAutoIterationMcpServer({
    sessionId: "supervisor-session",
    authority: supervisorAuthority,
    port: new InboxPort(),
  }).handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.ok(supervisorListed && "result" in supervisorListed);
  if (!supervisorListed || !("result" in supervisorListed)) {
    throw new Error("supervisor tools/list failed");
  }
  const supervisorTools = (
    supervisorListed.result as { tools: Array<{ name: string }> }
  ).tools.map((tool) => tool.name);
  assert.deepEqual(supervisorTools, [
    "submit_work_order",
    "read_work_order_status",
    "read_inbox",
    "submit_review_decision",
    "request_supervisor_rotation",
  ]);
  assert.deepEqual(
    [...new Set([...tools.map((tool) => tool.name), ...supervisorTools])].sort(),
    [
      "read_inbox",
      "read_work_order_status",
      "request_supervisor_rotation",
      "submit_handoff",
      "submit_review_decision",
      "submit_work_order",
    ],
  );
});

test("stdio MCP server maps tools/call to the coordinator and returns a text result", async (t) => {
  const authority = createSessionAuthority();
  authority.bindSession({
    actor: {
      kind: "worker",
      sessionId: "worker-session",
      workOrderId: "work-order-1",
      attemptId: "attempt-1",
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    lines.push(...chunk.trim().split("\n"));
  });
  const served = serveAutoIterationMcpStdio({
    sessionId: "worker-session",
    authority,
    port: new InboxPort(),
    input,
    output,
  });
  t.after(() => served.close());

  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "read_inbox",
        arguments: {
          requestIdempotencyKey: "request-stdio",
          expectedVersion: 1,
          observedTenure: {
            roleSlotId: "project-supervisor",
            generation: 2,
          },
          roleSlotId: "project-supervisor",
        },
      },
    })}\n`,
  );

  for (let attempt = 0; attempt < 20 && lines.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]!) as {
    result: { content: Array<{ type: string; text: string }> };
  };
  assert.equal(response.result.content[0]?.type, "text");
  assert.deepEqual(JSON.parse(response.result.content[0]!.text), {
    kind: "inbox-read",
    requestIdempotencyKey: "request-stdio",
    currentVersion: 2,
    entries: [],
  });
});
