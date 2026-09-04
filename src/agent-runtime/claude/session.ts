import { randomUUID } from "node:crypto";

import type {
  InterruptibleRuntimeBinding,
  NormalizedRuntimeEvent,
  RuntimeInterruptAvailability,
  RuntimeContextUsage,
  RuntimeInput,
  SessionProfile,
} from "../index.ts";
import { RuntimeAdapterError } from "../index.ts";
import type { ProviderRequestBudget } from "../provider-request-budget.ts";
import {
  readClaudeAppliedSettings,
  type ClaudeAppliedSettings,
} from "./settings.ts";
import type {
  ClaudeCatalogTransport,
  ClaudePermissionMode,
  ClaudeToolPermissionDecision,
  ClaudeToolPermissionHandler,
} from "./transport.ts";

const maximumProtocolLineLength = 1_048_576;
const maximumInitializationFrames = 64;
const protocolTimeoutMilliseconds = 60_000;
const droppableSystemSubtypes = new Set([
  "api_retry",
  "background_tasks_changed",
  "commands_changed",
  "compact_boundary",
  "elicitation_complete",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "local_command_output",
  "memory_recall",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "notification",
  "plugin_install",
  "session_state_changed",
  "status",
  "task_notification",
  "task_progress",
  "task_started",
  "task_updated",
  "thinking_tokens",
]);
const droppableFrameTypes = new Set([
  "active_goal",
  "prompt_suggestion",
  "rate_limit_event",
  "tool_progress",
  "tool_use_summary",
]);
const droppableAssistantBlockTypes = new Set([
  "redacted_thinking",
  "thinking",
  "tool_use",
]);

export interface ClaudeSessionInitialization {
  readonly catalog: unknown;
  readonly stopHookCallbackId: string;
  readonly appliedSettings?: ClaudeAppliedSettings;
}

export type ClaudeCorrelationFailureDiscriminator =
  | "user-before-session-started"
  | "user-input-echo-repeated"
  | "interrupt-marker-unconfirmed-or-repeated"
  | "user-frame-unrecognized"
  | "assistant-before-turn-started"
  | "assistant-parent-tool-use"
  | "unclassified-correlation";

export type ClaudeFrameValueType =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "other"
  | "string";

export interface ClaudeFrameShapeEntry {
  readonly path: string;
  readonly type: ClaudeFrameValueType;
}

class ClaudeCorrelationError extends RuntimeAdapterError {
  readonly discriminator: ClaudeCorrelationFailureDiscriminator;

  constructor(discriminator: ClaudeCorrelationFailureDiscriminator) {
    super("correlation-invalid");
    this.discriminator = discriminator;
  }
}

export async function initializeClaudeSession(
  transport: ClaudeCatalogTransport,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<ClaudeSessionInitialization> {
  const requestId = `session-${randomUUID()}`;
  const stopHookCallbackId = `stop-${randomUUID()}`;
  await providerRequestBudget?.claim("claude-session-initialize");
  await write(transport, {
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "initialize",
      hooks: { Stop: [{ hookCallbackIds: [stopHookCallbackId] }] },
    },
  });
  let catalog: unknown;
  for (let index = 0; index < maximumInitializationFrames; index += 1) {
    const message = await read(transport);
    if (message.type !== "control_response") {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    const response = record(message.response, "protocol-invalid");
    if (response.request_id !== requestId) continue;
    if (response.subtype !== "success" || !isPlainRecord(response.response)) {
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    catalog = response.response;
    break;
  }
  if (catalog === undefined) throw new RuntimeAdapterError("protocol-invalid");

  const settingsRequestId = `session-settings-${randomUUID()}`;
  await write(transport, {
    type: "control_request",
    request_id: settingsRequestId,
    request: { subtype: "get_settings" },
  });
  for (let index = 0; index < maximumInitializationFrames; index += 1) {
    const message = await read(transport);
    if (message.type !== "control_response") {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    const response = record(message.response, "protocol-invalid");
    if (response.request_id !== settingsRequestId) continue;
    if (response.subtype !== "success" || !isPlainRecord(response.response)) {
      throw new RuntimeAdapterError("runtime-unavailable");
    }
    const appliedSettings = readClaudeAppliedSettings(response.response);
    return Object.freeze({
      catalog,
      stopHookCallbackId,
      ...(appliedSettings === undefined ? {} : { appliedSettings }),
    });
  }
  throw new RuntimeAdapterError("protocol-invalid");
}

export class ClaudeRuntimeBinding implements InterruptibleRuntimeBinding {
  readonly profile: SessionProfile;
  readonly opaqueSessionReference: string;
  readonly #transport: ClaudeCatalogTransport;
  readonly #expectedModel: string;
  readonly #stopHookCallbackId: string;
  readonly #observeSessionIdentity: (identity: string) => void;
  readonly #expectedSessionIdentity: string | undefined;
  readonly #providerRequestBudget: ProviderRequestBudget | undefined;
  readonly #permissionMode: ClaudePermissionMode;
  readonly #requestToolPermission: ClaudeToolPermissionHandler | undefined;
  readonly #ultracodeConfirmed: boolean;
  #sentInput: string | undefined;
  #eventsConsumed = false;
  #sessionStarted = false;
  #terminal = false;
  #capabilities = new Set<string>();
  #interruptConfirmed = false;
  #effectiveProfile: SessionProfile | undefined;
  readonly #permissionRequestIds = new Set<string>();
  readonly #permissionToolUseIds = new Set<string>();
  #correlationFailureDiscriminator:
    | ClaudeCorrelationFailureDiscriminator
    | undefined;
  #unrecognizedUserFrameShape:
    | readonly ClaudeFrameShapeEntry[]
    | undefined;
  #interruptPending:
    | {
        readonly requestId: string;
        readonly resolve: () => void;
        readonly reject: (error: RuntimeAdapterError) => void;
      }
    | undefined;

  constructor(input: {
    readonly transport: ClaudeCatalogTransport;
    readonly profile: SessionProfile;
    readonly opaqueSessionReference: string;
    readonly expectedModel: string;
    readonly stopHookCallbackId: string;
    readonly observeSessionIdentity: (identity: string) => void;
    readonly expectedSessionIdentity?: string;
    readonly providerRequestBudget?: ProviderRequestBudget;
    readonly permissionMode: ClaudePermissionMode;
    readonly requestToolPermission?: ClaudeToolPermissionHandler;
    readonly ultracodeConfirmed: boolean;
  }) {
    this.#transport = input.transport;
    this.profile = Object.freeze({ ...input.profile });
    this.opaqueSessionReference = input.opaqueSessionReference;
    this.#expectedModel = input.expectedModel;
    this.#stopHookCallbackId = input.stopHookCallbackId;
    this.#observeSessionIdentity = input.observeSessionIdentity;
    this.#expectedSessionIdentity = input.expectedSessionIdentity;
    this.#providerRequestBudget = input.providerRequestBudget;
    this.#permissionMode = input.permissionMode;
    this.#requestToolPermission = input.requestToolPermission;
    this.#ultracodeConfirmed = input.ultracodeConfirmed;
  }

  async send(input: RuntimeInput): Promise<void> {
    if (this.#sentInput !== undefined || !isRuntimeInput(input)) {
      await this.#stopAndThrow("invalid-input");
    }
    this.#sentInput = input.text;
    try {
      await this.#providerRequestBudget?.claim("claude-inference-frame");
      await write(this.#transport, {
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content: [{ type: "text", text: input.text }],
        },
        parent_tool_use_id: null,
      });
    } catch (error) {
      await this.#stopAndThrow(
        error instanceof RuntimeAdapterError
          ? error.category
          : "transport-failed",
      );
    }
  }

  effectiveProfile(): SessionProfile | undefined {
    return this.#effectiveProfile;
  }

  correlationFailureDiscriminator():
    | ClaudeCorrelationFailureDiscriminator
    | undefined {
    return this.#correlationFailureDiscriminator;
  }

  unrecognizedUserFrameShape():
    | readonly ClaudeFrameShapeEntry[]
    | undefined {
    return this.#unrecognizedUserFrameShape;
  }

  async interrupt(): Promise<void> {
    if (
      !this.#eventsConsumed ||
      !this.#sessionStarted ||
      this.#terminal ||
      this.#interruptPending !== undefined
    ) {
      throw new RuntimeAdapterError("invalid-input");
    }
    if (
      !this.#capabilities.has("interrupt_receipt_v1") ||
      !this.#capabilities.has("interrupt_cancel_queued_v1") ||
      this.#providerRequestBudget !== undefined
    ) {
      throw new RuntimeAdapterError("unsupported-selection");
    }
    const requestId = `interrupt-${randomUUID()}`;
    const receipt = new Promise<void>((resolve, reject) => {
      this.#interruptPending = {
        requestId,
        resolve,
        reject,
      };
    });
    try {
      await write(this.#transport, {
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt", cancel_queued: true },
      });
    } catch (error) {
      this.#interruptPending = undefined;
      throw error;
    }
    await receipt;
  }

  interruptAvailability(): RuntimeInterruptAvailability {
    if (!this.#eventsConsumed || !this.#sessionStarted || this.#terminal) {
      return "unavailable";
    }
    if (
      !this.#capabilities.has("interrupt_receipt_v1") ||
      !this.#capabilities.has("interrupt_cancel_queued_v1") ||
      this.#providerRequestBudget !== undefined
    ) {
      return "unsupported";
    }
    return this.#interruptPending === undefined ? "available" : "unavailable";
  }

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    if (
      this.#eventsConsumed ||
      this.#sentInput === undefined
    ) {
      yield await this.#failureAfterStop("invalid-input");
      return;
    }
    this.#eventsConsumed = true;
    let terminal = false;
    let sessionIdentity: string | undefined;
    let sessionStarted = false;
    let turnStarted = false;
    let inputEchoSeen = false;
    let interruptMarkerSeen = false;
    let itemStarted = false;
    let finalText: string | undefined;
    let effectiveEffortObserved = false;

    try {
      while (true) {
        const message = await read(this.#transport);
        if (message.type === "system") {
          if (message.subtype !== "init") {
            if (
              !sessionStarted ||
              typeof message.subtype !== "string" ||
              !droppableSystemSubtypes.has(message.subtype)
            ) {
              throw new RuntimeAdapterError("protocol-invalid");
            }
            assertSession(message, sessionIdentity);
            if (
              message.subtype === "status" &&
              message.permissionMode !== undefined &&
              !matchesClaudePermissionMode(
                message.permissionMode,
                this.#permissionMode,
              )
            ) {
              throw new RuntimeAdapterError("unsupported-selection");
            }
            continue;
          }
          if (sessionStarted) {
            throw new RuntimeAdapterError("protocol-invalid");
          }
          if (
            !isSafeIdentity(message.session_id) ||
            (this.#expectedSessionIdentity !== undefined &&
              message.session_id !== this.#expectedSessionIdentity) ||
            message.model !== this.#expectedModel ||
            !matchesClaudePermissionMode(
              message.permissionMode,
              this.#permissionMode,
            ) ||
            (message.capabilities !== undefined &&
              !isStringArray(message.capabilities))
          ) {
            throw new RuntimeAdapterError("unsupported-selection");
          }
          sessionIdentity = message.session_id;
          this.#capabilities = new Set(
            message.capabilities === undefined ? [] : message.capabilities,
          );
          this.#observeSessionIdentity(sessionIdentity);
          sessionStarted = true;
          this.#sessionStarted = true;
          yield Object.freeze({ kind: "session-started" as const });
          turnStarted = true;
          yield Object.freeze({ kind: "turn-started" as const });
          continue;
        }
        if (message.type === "user") {
          if (!sessionStarted) {
            throw new ClaudeCorrelationError("user-before-session-started");
          }
          assertSession(message, sessionIdentity);
          if (isEchoedInput(message, this.#sentInput)) {
            if (inputEchoSeen) {
              throw new ClaudeCorrelationError("user-input-echo-repeated");
            }
            inputEchoSeen = true;
            continue;
          }
          const postInterruptTextFrame = isPostInterruptTextFrame(message);
          if (isInterruptMarker(message) || postInterruptTextFrame) {
            if (
              !this.#interruptConfirmed ||
              interruptMarkerSeen
            ) {
              throw new ClaudeCorrelationError(
                "interrupt-marker-unconfirmed-or-repeated",
              );
            }
            interruptMarkerSeen = true;
            continue;
          }
          if (!isToolResultMessage(message)) {
            this.#unrecognizedUserFrameShape = describeFrameShape(message);
            throw new ClaudeCorrelationError("user-frame-unrecognized");
          }
          continue;
        }
        if (message.type === "assistant") {
          if (!turnStarted) {
            throw new ClaudeCorrelationError("assistant-before-turn-started");
          }
          assertSession(message, sessionIdentity);
          if (message.parent_tool_use_id !== null) {
            throw new ClaudeCorrelationError("assistant-parent-tool-use");
          }
          const candidate = assistantText(message);
          if (candidate !== undefined) {
            finalText = candidate;
            if (!itemStarted) {
              itemStarted = true;
              yield Object.freeze({
                kind: "item-started" as const,
                itemType: "agent-message" as const,
              });
            }
          }
          continue;
        }
        if (message.type === "control_request") {
          const request = record(message.request, "unexpected-server-request");
          if (request.subtype === "can_use_tool") {
            if (!sessionStarted) {
              throw new RuntimeAdapterError("correlation-invalid");
            }
            await this.#handleToolPermissionRequest(message, request);
            continue;
          }
          const input = record(request.input, "protocol-invalid");
          const effectiveEffortLevel =
            input.effort === undefined
              ? "default"
              : record(input.effort, "protocol-invalid").level;
          if (
            !isSafeIdentity(message.request_id) ||
            request.subtype !== "hook_callback" ||
            request.callback_id !== this.#stopHookCallbackId ||
            input.hook_event_name !== "Stop" ||
            input.session_id !== sessionIdentity ||
            !matchesClaudePermissionMode(
              input.permission_mode,
              this.#permissionMode,
            ) ||
            effectiveEffortLevel !== this.profile.effortLevel ||
            (this.profile.executionMode === "ultracode" &&
              (!this.#ultracodeConfirmed || effectiveEffortLevel !== "xhigh")) ||
            effectiveEffortObserved
          ) {
            throw new RuntimeAdapterError("unsupported-selection");
          }
          effectiveEffortObserved = true;
          this.#effectiveProfile = Object.freeze({ ...this.profile });
          await write(this.#transport, {
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {},
            },
          });
          continue;
        }
        if (message.type === "control_response") {
          const pending = this.#interruptPending;
          const response = record(message.response, "protocol-invalid");
          const payload = record(response.response, "protocol-invalid");
          if (
            pending === undefined ||
            response.subtype !== "success" ||
            response.request_id !== pending.requestId ||
            !isStringArray(payload.still_queued) ||
            payload.still_queued.length !== 0 ||
            (payload.cancelled !== undefined &&
              !isStringArray(payload.cancelled))
          ) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          this.#interruptPending = undefined;
          this.#interruptConfirmed = true;
          pending.resolve();
          continue;
        }
        if (message.type === "result") {
          assertSession(message, sessionIdentity);
          if (
            this.#interruptConfirmed &&
            message.subtype === "error_during_execution" &&
            message.is_error === true &&
            (message.terminal_reason === "aborted_streaming" ||
              message.terminal_reason === "aborted_tools") &&
            effectiveEffortObserved
          ) {
            await this.#transport.stop();
            terminal = true;
            this.#terminal = true;
            yield Object.freeze({
              kind: "turn-interrupted" as const,
              status: "interrupted" as const,
            });
            return;
          }
          if (
            message.subtype !== "success" ||
            message.is_error !== false ||
            message.terminal_reason !== "completed" ||
            typeof message.result !== "string" ||
            message.result !== finalText ||
            !sessionStarted ||
            !turnStarted ||
            !itemStarted ||
            !effectiveEffortObserved
          ) {
            throw new RuntimeAdapterError("turn-failed");
          }
          const context = readResultContextUsage(message.usage);
          await this.#transport.stop();
          terminal = true;
          this.#terminal = true;
          yield Object.freeze({
            kind: "item-completed" as const,
            itemType: "agent-message" as const,
          });
          yield Object.freeze({ kind: "agent-message" as const, text: finalText });
          yield Object.freeze({
            kind: "turn-completed" as const,
            status: "completed" as const,
            ...(context === undefined ? {} : { context }),
          });
          return;
        }
        if (droppableFrameTypes.has(String(message.type))) {
          if (!sessionStarted) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          assertSession(message, sessionIdentity);
          continue;
        }
        throw new RuntimeAdapterError("protocol-invalid");
      }
    } catch (error) {
      let failure =
        error instanceof RuntimeAdapterError
          ? error
          : new RuntimeAdapterError("protocol-invalid");
      try {
        await this.#transport.stop();
      } catch {
        failure = new RuntimeAdapterError("runtime-shutdown");
      }
      terminal = true;
      this.#terminal = true;
      this.#correlationFailureDiscriminator =
        failure.category !== "correlation-invalid"
          ? undefined
          : failure instanceof ClaudeCorrelationError
            ? failure.discriminator
            : "unclassified-correlation";
      this.#rejectInterrupt(failure);
      yield Object.freeze({ kind: "failed" as const, category: failure.category });
    } finally {
      if (!terminal) {
        this.#terminal = true;
        this.#rejectInterrupt(new RuntimeAdapterError("runtime-shutdown"));
        try {
          await this.#transport.stop();
        } catch {
          // Iterator abandonment remains private; shutdown was still attempted.
        }
      }
    }
  }

  #rejectInterrupt(error: RuntimeAdapterError): void {
    const pending = this.#interruptPending;
    if (pending === undefined) return;
    this.#interruptPending = undefined;
    pending.reject(error);
  }

  async #handleToolPermissionRequest(
    message: Record<string, unknown>,
    request: Record<string, unknown>,
  ): Promise<void> {
    const requestId = message.request_id;
    const input = record(request.input, "protocol-invalid");
    if (
      !hasExactKeys(message, ["request", "request_id", "type"]) ||
      !hasRequiredAndOnlyKnownKeys(
        request,
        ["input", "subtype", "tool_name", "tool_use_id"],
        [
          "agent_id",
          "blocked_path",
          "decision_reason",
          "description",
          "display_name",
          "permission_suggestions",
          "title",
        ],
      ) ||
      !isSafeIdentity(requestId) ||
      !isSafeIdentity(request.tool_name) ||
      !isSafeIdentity(request.tool_use_id) ||
      (request.agent_id !== undefined && !isSafeIdentity(request.agent_id)) ||
      !isOptionalSafeDisplayText(request.blocked_path) ||
      !isOptionalSafeDisplayText(request.decision_reason) ||
      !isOptionalSafeDisplayText(request.description) ||
      !isOptionalSafeDisplayText(request.display_name) ||
      !isOptionalSafeDisplayText(request.title) ||
      (request.permission_suggestions !== undefined &&
        !isClaudePermissionSuggestions(request.permission_suggestions))
    ) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (this.#permissionMode !== "manual") {
      throw new RuntimeAdapterError("unsupported-selection");
    }
    const toolUseCorrelationKey = `${request.agent_id ?? "main"}\0${request.tool_use_id}`;
    if (
      this.#permissionRequestIds.has(requestId) ||
      this.#permissionToolUseIds.has(toolUseCorrelationKey)
    ) {
      throw new RuntimeAdapterError("correlation-invalid");
    }
    this.#permissionRequestIds.add(requestId);
    this.#permissionToolUseIds.add(toolUseCorrelationKey);
    const handler = this.#requestToolPermission;
    if (handler === undefined) {
      throw new RuntimeAdapterError("approval-required");
    }
    let decision: ClaudeToolPermissionDecision;
    try {
      decision = await handler(
        Object.freeze({
          toolName: request.tool_name,
          input: Object.freeze({ ...input }),
          toolUseId: request.tool_use_id,
          ...(request.agent_id === undefined
            ? {}
            : { agentId: request.agent_id }),
          ...(request.blocked_path === undefined
            ? {}
            : { blockedPath: request.blocked_path }),
          ...(request.decision_reason === undefined
            ? {}
            : { decisionReason: request.decision_reason }),
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.display_name === undefined
            ? {}
            : { displayName: request.display_name }),
          ...(request.description === undefined
            ? {}
            : { description: request.description }),
        }),
      );
    } catch {
      throw new RuntimeAdapterError("approval-required");
    }
    if (!isClaudeToolPermissionDecision(decision)) {
      throw new RuntimeAdapterError("approval-required");
    }
    await write(this.#transport, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response:
          decision.behavior === "allow"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: decision.message },
      },
    });
  }

  async #stopAndThrow(
    category: ConstructorParameters<typeof RuntimeAdapterError>[0],
  ): Promise<never> {
    try {
      await this.#transport.stop();
    } catch {
      throw new RuntimeAdapterError("runtime-shutdown");
    }
    throw new RuntimeAdapterError(category);
  }

  async #failureAfterStop(
    category: ConstructorParameters<typeof RuntimeAdapterError>[0],
  ): Promise<NormalizedRuntimeEvent> {
    try {
      await this.#transport.stop();
      return Object.freeze({ kind: "failed" as const, category });
    } catch {
      return Object.freeze({
        kind: "failed" as const,
        category: "runtime-shutdown" as const,
      });
    }
  }
}

async function write(
  transport: ClaudeCatalogTransport,
  message: Record<string, unknown>,
): Promise<void> {
  try {
    await transport.send(JSON.stringify(message));
  } catch {
    throw new RuntimeAdapterError("transport-failed");
  }
}

async function read(
  transport: ClaudeCatalogTransport,
): Promise<Record<string, unknown>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let line: string | null;
  try {
    line = await Promise.race([
      transport.receive(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new RuntimeAdapterError("transport-failed")),
          protocolTimeoutMilliseconds,
        );
      }),
    ]);
  } catch (error) {
    throw error instanceof RuntimeAdapterError
      ? error
      : new RuntimeAdapterError("transport-failed");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (line === null) throw new RuntimeAdapterError("runtime-shutdown");
  if (line.length > maximumProtocolLineLength) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return record(message, "protocol-invalid");
}

function assertSession(
  message: Record<string, unknown>,
  sessionIdentity: string | undefined,
): void {
  if (sessionIdentity === undefined || message.session_id !== sessionIdentity) {
    throw new RuntimeAdapterError("correlation-invalid");
  }
}

function matchesClaudePermissionMode(
  value: unknown,
  expected: ClaudePermissionMode,
): boolean {
  return expected === "bypassPermissions"
    ? value === "bypassPermissions"
    : value === "manual" || value === "default";
}

function isClaudeToolPermissionDecision(
  value: unknown,
): value is ClaudeToolPermissionDecision {
  if (!isPlainRecord(value)) return false;
  if (value.behavior === "allow") {
    return hasExactKeys(value, ["behavior"]);
  }
  return (
    value.behavior === "deny" &&
    hasExactKeys(value, ["behavior", "message"]) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 2_000 &&
    !value.message.includes("\0")
  );
}

function isEchoedInput(
  message: Record<string, unknown>,
  expected: string,
): boolean {
  if (message.parent_tool_use_id !== null || !isPlainRecord(message.message)) {
    return false;
  }
  const content = message.message.content;
  return (
    message.message.role === "user" &&
    Array.isArray(content) &&
    content.length === 1 &&
    isPlainRecord(content[0]) &&
    content[0].type === "text" &&
    content[0].text === expected
  );
}

function isToolResultMessage(message: Record<string, unknown>): boolean {
  if (
    !isPlainRecord(message.message) ||
    message.message.role !== "user" ||
    (message.parent_tool_use_id !== null &&
      typeof message.parent_tool_use_id !== "string")
  ) {
    return false;
  }
  const content = message.message.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) => isPlainRecord(block) && block.type === "tool_result",
    )
  );
}

function isInterruptMarker(message: Record<string, unknown>): boolean {
  return (
    message.parent_tool_use_id === null &&
    isPlainRecord(message.message) &&
    message.message.role === "user" &&
    message.message.content === "[Request interrupted by user]"
  );
}

function isPostInterruptTextFrame(
  message: Record<string, unknown>,
): boolean {
  if (
    !hasExactKeys(message, [
      "message",
      "parent_tool_use_id",
      "session_id",
      "timestamp",
      "type",
      "uuid",
    ]) ||
    message.type !== "user" ||
    message.parent_tool_use_id !== null ||
    typeof message.session_id !== "string" ||
    typeof message.timestamp !== "string" ||
    typeof message.uuid !== "string" ||
    !isPlainRecord(message.message) ||
    !hasExactKeys(message.message, ["content", "role"]) ||
    message.message.role !== "user" ||
    !Array.isArray(message.message.content) ||
    message.message.content.length !== 1 ||
    !isPlainRecord(message.message.content[0]) ||
    !hasExactKeys(message.message.content[0], ["text", "type"]) ||
    typeof message.message.content[0].text !== "string" ||
    typeof message.message.content[0].type !== "string"
  ) {
    return false;
  }
  return true;
}

function assistantText(message: Record<string, unknown>): string | undefined {
  if (!isPlainRecord(message.message) || message.message.role !== "assistant") {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const content = message.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const text: string[] = [];
  for (const block of content) {
    if (!isPlainRecord(block) || typeof block.type !== "string") {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      text.push(block.text);
      continue;
    }
    if (!isDroppableAssistantBlock(block)) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
  }
  return text.length === 0 ? undefined : text.join("");
}

function isDroppableAssistantBlock(
  block: Record<string, unknown>,
): boolean {
  if (!droppableAssistantBlockTypes.has(String(block.type))) return false;
  if (block.type === "thinking") {
    return (
      typeof block.thinking === "string" && typeof block.signature === "string"
    );
  }
  if (block.type === "redacted_thinking") {
    return typeof block.data === "string";
  }
  return (
    isSafeIdentity(block.id) &&
    isSafeIdentity(block.name) &&
    Object.prototype.hasOwnProperty.call(block, "input")
  );
}

function isRuntimeInput(value: RuntimeInput): value is RuntimeInput {
  return (
    isPlainRecord(value) &&
    Reflect.ownKeys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "text") &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}

function record(
  value: unknown,
  category: ConstructorParameters<typeof RuntimeAdapterError>[0],
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new RuntimeAdapterError(category);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
      );
    });
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const sortedExpected = [...expected].sort(compareOrdinal);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function readResultContextUsage(value: unknown): RuntimeContextUsage | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new RuntimeAdapterError("protocol-invalid");
  const requiredKeys = [
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
  ] as const;
  const optionalKeys = [
    "cache_creation",
    "inference_geo",
    "iterations",
    "server_tool_use",
    "service_tier",
    "speed",
  ] as const;
  if (
    !hasRequiredAndOnlyKnownKeys(value, requiredKeys, optionalKeys) ||
    requiredKeys.some(
      (key) =>
        typeof value[key] !== "number" ||
        !Number.isSafeInteger(value[key]) ||
        (value[key] as number) < 0,
    )
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const usedTokens = requiredKeys.reduce(
    (sum, key) => sum + (value[key] as number),
    0,
  );
  if (!Number.isSafeInteger(usedTokens)) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return Object.freeze({ basis: "turn-usage", usedTokens, windowTokens: null });
}

function hasRequiredAndOnlyKnownKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => allowed.has(key))
  );
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes("\0")
  );
}

function isOptionalSafeDisplayText(value: unknown): value is string | undefined {
  return value === undefined || isSafeDisplayText(value);
}

function isSafeDisplayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_000 &&
    !value.includes("\0")
  );
}

function isClaudePermissionSuggestions(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(isClaudePermissionSuggestion)
  );
}

function isClaudePermissionSuggestion(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const destinationIsValid =
    value.destination === undefined ||
    value.destination === "userSettings" ||
    value.destination === "projectSettings" ||
    value.destination === "localSettings" ||
    value.destination === "session";
  if (!destinationIsValid) return false;
  if (
    value.type === "addRules" ||
    value.type === "replaceRules" ||
    value.type === "removeRules"
  ) {
    return (
      hasRequiredAndOnlyKnownKeys(
        value,
        ["behavior", "rules", "type"],
        ["destination"],
      ) &&
      (value.behavior === "allow" ||
        value.behavior === "deny" ||
        value.behavior === "ask") &&
      Array.isArray(value.rules) &&
      value.rules.length <= 100 &&
      value.rules.every(isClaudePermissionRule)
    );
  }
  if (value.type === "setMode") {
    return (
      hasRequiredAndOnlyKnownKeys(value, ["mode", "type"], ["destination"]) &&
      (value.mode === "default" ||
        value.mode === "acceptEdits" ||
        value.mode === "plan" ||
        value.mode === "bypassPermissions" ||
        value.mode === "dontAsk" ||
        value.mode === "auto")
    );
  }
  if (value.type === "addDirectories" || value.type === "removeDirectories") {
    return (
      hasRequiredAndOnlyKnownKeys(
        value,
        ["directories", "type"],
        ["destination"],
      ) &&
      Array.isArray(value.directories) &&
      value.directories.length <= 100 &&
      value.directories.every(isSafeDisplayText)
    );
  }
  return false;
}

function isClaudePermissionRule(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasRequiredAndOnlyKnownKeys(value, ["toolName"], ["ruleContent"]) &&
    isSafeIdentity(value.toolName) &&
    (value.ruleContent === undefined ||
      value.ruleContent === null ||
      isSafeDisplayText(value.ruleContent))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function describeFrameShape(
  frame: Record<string, unknown>,
): readonly ClaudeFrameShapeEntry[] {
  const entries = new Map<string, ClaudeFrameShapeEntry>();
  const visit = (value: unknown, path: string): void => {
    const type = frameValueType(value);
    const key = `${path}\0${type}`;
    if (!entries.has(key)) entries.set(key, Object.freeze({ path, type }));
    if (type === "array") {
      for (const item of value as unknown[]) visit(item, `${path}[]`);
      return;
    }
    if (type !== "object") return;
    const recordValue = value as Record<string, unknown>;
    for (const name of Object.keys(recordValue).sort(compareOrdinal)) {
      visit(recordValue[name], `${path}.${name}`);
    }
  };
  visit(frame, "$");
  return Object.freeze(
    [...entries.values()].sort((left, right) => {
      const pathOrder = compareOrdinal(left.path, right.path);
      return pathOrder === 0
        ? compareOrdinal(left.type, right.type)
        : pathOrder;
    }),
  );
}

function frameValueType(value: unknown): ClaudeFrameValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainRecord(value)) return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "other";
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
