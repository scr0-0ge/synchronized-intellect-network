import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { AutoIterationCoordinatorPort } from "../coordinator/auto-iteration/contract.ts";
import type {
  AutoIterationToolOperation,
  SessionAuthority,
} from "../coordinator/auto-iteration/session-authority.ts";
import { createAutoIterationToolBridge } from "../coordinator/auto-iteration/tool-bridge.ts";

type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly error: { readonly code: number; readonly message: string };
    };

interface JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly additionalProperties: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface AutoIterationMcpServer {
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

export interface AutoIterationMcpServerDependencies {
  readonly sessionId: string;
  readonly authority: SessionAuthority;
  readonly port: AutoIterationCoordinatorPort;
}

export interface AutoIterationMcpStdioDependencies
  extends AutoIterationMcpServerDependencies {
  readonly input?: Readable;
  readonly output?: Writable;
}

const operationByToolName = Object.freeze({
  submit_work_order: "submit-work-order",
  read_work_order_status: "read-work-order-status",
  submit_handoff: "submit-handoff",
  read_inbox: "read-inbox",
  submit_review_decision: "submit-review-decision",
  request_supervisor_rotation: "request-supervisor-rotation",
} as const satisfies Readonly<Record<string, AutoIterationToolOperation>>);

type McpToolName = keyof typeof operationByToolName;

const toolNameByOperation = new Map<AutoIterationToolOperation, McpToolName>(
  Object.entries(operationByToolName).map(([name, operation]) => [
    operation,
    name as McpToolName,
  ]),
);

const roleGenerationSchema = Object.freeze({
  type: "object",
  properties: {
    roleSlotId: { type: "string", minLength: 1 },
    generation: { type: "integer", minimum: 0 },
  },
  required: ["roleSlotId", "generation"],
  additionalProperties: false,
});

const profileSchema = Object.freeze({
  type: "object",
  properties: {
    model: { type: "string", minLength: 1 },
    effortLevel: { type: "string", minLength: 1 },
    executionMode: { type: "string", minLength: 1 },
    accessMode: { type: "string", minLength: 1 },
  },
  required: ["model", "effortLevel", "executionMode", "accessMode"],
  additionalProperties: false,
});

const sessionCreationSchema = Object.freeze({
  type: "object",
  properties: {
    endpointId: {
      type: "string",
      enum: [
        "codex-desktop",
        "claude-code-desktop",
        "glm-coding-plan",
        "kimi-code",
        "deepseek-api",
        "kimi-platform",
        "claude-api",
        "codex-api",
      ],
    },
    profile: profileSchema,
  },
  required: ["endpointId", "profile"],
  additionalProperties: false,
});

const handoffKeySchema = Object.freeze({
  type: "object",
  properties: {
    workOrderId: { type: "string", minLength: 1 },
    attemptId: { type: "string", minLength: 1 },
    handoffId: { type: "string", minLength: 1 },
  },
  required: ["workOrderId", "attemptId", "handoffId"],
  additionalProperties: false,
});

const commonProperties = Object.freeze({
  requestIdempotencyKey: { type: "string", minLength: 1 },
  expectedVersion: { type: "integer", minimum: 0 },
  observedTenure: roleGenerationSchema,
});

const commonRequired = Object.freeze([
  "requestIdempotencyKey",
  "expectedVersion",
  "observedTenure",
]);

function inputSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): JsonSchema {
  return Object.freeze({
    type: "object",
    properties: Object.freeze({ ...commonProperties, ...properties }),
    required: Object.freeze([...commonRequired, ...required]),
    // Extra model fields are discarded by the bridge. In particular, an actor,
    // role, or session id supplied by a model never overrides the host binding.
    additionalProperties: true,
  });
}

const toolDefinitions = Object.freeze({
  submit_work_order: Object.freeze({
    name: "submit_work_order",
    description: "Submit a bounded Work Order for a new Worker Session.",
    inputSchema: inputSchema(
      {
        workOrder: {
          type: "object",
          properties: {
            objective: { type: "string", minLength: 1 },
            acceptanceCriteria: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            baselineCommitSha: { type: "string", minLength: 1 },
            territory: {
              type: "object",
              properties: {
                writePaths: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "Project-relative paths only.",
                },
                readOnlyPaths: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "Project-relative paths only.",
                },
              },
              required: ["writePaths", "readOnlyPaths"],
              additionalProperties: false,
            },
            responsibleRoleSlotId: { type: "string", minLength: 1 },
            completionCondition: {
              type: "object",
              properties: {
                gitIntegration: {
                  type: "string",
                  enum: ["required", "not-required"],
                },
              },
              required: ["gitIntegration"],
              additionalProperties: false,
            },
            workerSession: sessionCreationSchema,
          },
          required: [
            "objective",
            "acceptanceCriteria",
            "baselineCommitSha",
            "territory",
            "responsibleRoleSlotId",
            "completionCondition",
            "workerSession",
          ],
          additionalProperties: true,
        },
      },
      ["workOrder"],
    ),
  }),
  read_work_order_status: Object.freeze({
    name: "read_work_order_status",
    description: "Read the durable state associated with one Work Order.",
    inputSchema: inputSchema(
      { workOrderId: { type: "string", minLength: 1 } },
      ["workOrderId"],
    ),
  }),
  submit_handoff: Object.freeze({
    name: "submit_handoff",
    description:
      "Submit a Worker Handoff using Coordinator-captured artifact ids.",
    inputSchema: inputSchema(
      {
        handoff: {
          type: "object",
          properties: {
            idempotencyKey: handoffKeySchema,
            body: { type: "string", minLength: 1 },
            artifactIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
          },
          required: ["idempotencyKey", "body", "artifactIds"],
          additionalProperties: true,
        },
      },
      ["handoff"],
    ),
  }),
  read_inbox: Object.freeze({
    name: "read_inbox",
    description: "Read pending entries addressed to a stable RoleSlot.",
    inputSchema: inputSchema(
      { roleSlotId: { type: "string", minLength: 1 } },
      ["roleSlotId"],
    ),
  }),
  submit_review_decision: Object.freeze({
    name: "submit_review_decision",
    description: "Submit an explicit disposition for one Handoff version.",
    inputSchema: inputSchema(
      {
        decision: {
          type: "object",
          properties: {
            handoff: handoffKeySchema,
            handoffVersion: { type: "integer", minimum: 0 },
            decision: {
              type: "string",
              enum: ["approve", "rework", "blocked", "transfer"],
            },
            reason: { type: "string", minLength: 1 },
            targetRoleSlotId: { type: "string", minLength: 1 },
          },
          required: ["handoff", "handoffVersion", "decision", "reason"],
          additionalProperties: true,
        },
      },
      ["decision"],
    ),
  }),
  request_supervisor_rotation: Object.freeze({
    name: "request_supervisor_rotation",
    description:
      "Request a successor Supervisor Session for a stable supervisor RoleSlot.",
    inputSchema: inputSchema(
      {
        roleSlotId: { type: "string", minLength: 1 },
        successorSession: sessionCreationSchema,
      },
      ["roleSlotId", "successorSession"],
    ),
  }),
} as const satisfies Readonly<Record<McpToolName, McpToolDefinition>>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function requestId(request: JsonRpcRequest): JsonRpcId {
  return request.id ?? null;
}

export function createAutoIterationMcpServer(
  dependencies: AutoIterationMcpServerDependencies,
): AutoIterationMcpServer {
  const bridge = createAutoIterationToolBridge(dependencies);
  const server: AutoIterationMcpServer = {
    async handle(request: JsonRpcRequest) {
      const id = requestId(request);
      switch (request.method) {
        case "initialize": {
          const requestedProtocol =
            isRecord(request.params) &&
            typeof request.params.protocolVersion === "string"
              ? request.params.protocolVersion
              : "2025-06-18";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: requestedProtocol,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "workbench-auto-iteration", version: "1" },
            },
          };
        }
        case "notifications/initialized":
        case "notifications/cancelled":
          return null;
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list": {
          const available = dependencies.authority.operationsForSession(
            dependencies.sessionId,
          );
          const tools = available.flatMap((operation) => {
            const name = toolNameByOperation.get(operation);
            return name === undefined ? [] : [toolDefinitions[name]];
          });
          return { jsonrpc: "2.0", id, result: { tools } };
        }
        case "tools/call": {
          if (!isRecord(request.params)) {
            return error(id, -32602, "tools/call params must be an object");
          }
          const name = request.params.name;
          if (
            typeof name !== "string" ||
            !(name in operationByToolName)
          ) {
            return error(id, -32602, "unknown Workbench tool");
          }
          const operation = operationByToolName[name as McpToolName];
          const response = await bridge.call(
            dependencies.sessionId,
            operation,
            request.params.arguments,
          );
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(response) }],
              isError: response.kind === "rejected",
            },
          };
        }
        default:
          return request.id === undefined
            ? null
            : error(id, -32601, "method not found");
      }
    },
  };
  return Object.freeze(server);
}

export function serveAutoIterationMcpStdio(
  dependencies: AutoIterationMcpStdioDependencies,
): { close(): void } {
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const server = createAutoIterationMcpServer(dependencies);
  const lines = createInterface({ input, crlfDelay: Infinity });

  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(error(null, -32700, "parse error"))}\n`);
      return;
    }
    if (
      !isRecord(parsed) ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string"
    ) {
      output.write(`${JSON.stringify(error(null, -32600, "invalid request"))}\n`);
      return;
    }
    void server
      .handle(parsed as unknown as JsonRpcRequest)
      .then((response) => {
        if (response !== null) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch(() => {
        output.write(
          `${JSON.stringify(error(requestId(parsed as unknown as JsonRpcRequest), -32603, "internal error"))}\n`,
        );
      });
  });

  return Object.freeze({ close: () => lines.close() });
}
