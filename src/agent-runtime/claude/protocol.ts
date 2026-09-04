import { randomUUID } from "node:crypto";

import { RuntimeAdapterError } from "../index.ts";
import type { ProviderRequestBudget } from "../provider-request-budget.ts";
import {
  readClaudeAppliedSettings,
  type ClaudeAppliedSettings,
  type ClaudeSettingsObservationCollector,
} from "./settings.ts";
import type { ClaudeCatalogTransport } from "./transport.ts";
import { ClaudeDiagnosticError } from "./diagnostics.ts";

const maximumProtocolLineLength = 1_048_576;
const maximumInitializationFrames = 64;
const initializationTimeoutMilliseconds = 60_000;
const turnBearingFrameTypes = new Set(["user", "assistant", "result"]);

export type ClaudeControlResponseGate = "initialize" | "get_settings";

export type ClaudeControlResponseParseResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "success"; readonly response: Record<string, unknown> };

export interface ClaudeCatalogInitialization {
  readonly catalog: unknown;
  readonly appliedSettings?: ClaudeAppliedSettings;
}

export async function initializeClaudeCatalog(
  transport: ClaudeCatalogTransport,
  providerRequestBudget?: ProviderRequestBudget,
  settingsObservation?: ClaudeSettingsObservationCollector,
): Promise<ClaudeCatalogInitialization> {
  const requestId = `catalog-${randomUUID()}`;
  await providerRequestBudget?.claim("claude-catalog-initialize");
  await sendControlRequest(transport, requestId, {
    subtype: "initialize",
    hooks: null,
  });
  const catalog = await receiveControlResponse(transport, requestId, "initialize");
  const settingsRequestId = `catalog-settings-${randomUUID()}`;
  await sendControlRequest(transport, settingsRequestId, {
    subtype: "get_settings",
  });
  const appliedSettings = readClaudeAppliedSettings(
    await receiveControlResponse(transport, settingsRequestId, "get_settings"),
    settingsObservation,
  );
  return Object.freeze({
    catalog,
    ...(appliedSettings === undefined ? {} : { appliedSettings }),
  });
}

async function sendControlRequest(
  transport: ClaudeCatalogTransport,
  requestId: string,
  request: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await transport.send(
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request,
      }),
    );
  } catch {
    throw new RuntimeAdapterError("transport-failed");
  }
}

async function receiveControlResponse(
  transport: ClaudeCatalogTransport,
  requestId: string,
  gate: ClaudeControlResponseGate,
): Promise<unknown> {
  for (let index = 0; index < maximumInitializationFrames; index += 1) {
    const line = await receiveWithTimeout(transport);
    if (line === null) throw new RuntimeAdapterError("runtime-shutdown");
    if (line.length > maximumProtocolLineLength) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    const parsed = parseClaudeControlResponseLine(line, requestId, gate);
    if (parsed.kind === "success") return parsed.response;
  }
  throw new RuntimeAdapterError("protocol-invalid");
}

export function parseClaudeControlResponseLine(
  line: string,
  requestId: string,
  gate: ClaudeControlResponseGate,
): ClaudeControlResponseParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) {
    return Object.freeze({ kind: "ignored" as const });
  }
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    throw controlResponseDiagnostic("protocol-invalid", gate, null, ["json"], trimmed);
  }
  if (!isRecord(message) || typeof message.type !== "string") {
    throw controlResponseDiagnostic("protocol-invalid", gate, null, ["message"], trimmed);
  }
  if (turnBearingFrameTypes.has(message.type)) {
    throw controlResponseDiagnostic("protocol-invalid", gate, null, ["type"], trimmed);
  }
  if (message.type !== "control_response") {
    return Object.freeze({ kind: "ignored" as const });
  }
  if (!isRecord(message.response)) {
    throw controlResponseDiagnostic("protocol-invalid", gate, null, ["response"], trimmed);
  }
  if (message.response.request_id !== requestId) {
    return Object.freeze({ kind: "ignored" as const });
  }
  if (message.response.subtype !== "success") {
    throw controlResponseDiagnostic(
      "runtime-unavailable",
      gate,
      null,
      ["subtype"],
      privateJson(message.response),
    );
  }
  if (!isRecord(message.response.response)) {
    throw controlResponseDiagnostic(
      "runtime-unavailable",
      gate,
      null,
      ["response"],
      privateJson(message.response),
    );
  }
  return Object.freeze({
    kind: "success" as const,
    response: message.response.response,
  });
}

function controlResponseDiagnostic(
  category: "protocol-invalid" | "runtime-unavailable",
  gate: ClaudeControlResponseGate,
  row: number | null,
  invalidKeys: readonly string[],
  detail: string,
): ClaudeDiagnosticError {
  return new ClaudeDiagnosticError(category, {
    kind: "control-response-rejected",
    category,
    gate,
    row,
    addedKeys: Object.freeze([]),
    missingKeys: Object.freeze([]),
    invalidKeys: Object.freeze([...invalidKeys]),
    detail,
  });
}

function privateJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable-control-response";
  }
}

async function receiveWithTimeout(
  transport: ClaudeCatalogTransport,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      transport.receive(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RuntimeAdapterError("transport-failed")),
          initializationTimeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
