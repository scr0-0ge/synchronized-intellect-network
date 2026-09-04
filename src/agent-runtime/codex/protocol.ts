import { RuntimeAdapterError } from "../index.ts";
import type { RuntimeFailureCategory } from "../index.ts";
import type { OfficialRuntimeTransport } from "./transport.ts";
import {
  ProviderRequestBudgetError,
  type ProviderOperationKind,
  type ProviderRequestBudget,
} from "../provider-request-budget.ts";

type JsonObject = Record<string, unknown>;

const approvalMethods = new Set([
  "applyPatchApproval",
  "execCommandApproval",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

const turnScopedLifecycleMethods = new Set([
  "item/agentMessage/delta",
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "item/commandExecution/outputDelta",
  "item/completed",
  "item/started",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/started",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function toRuntimeError(
  error: unknown,
  fallback: ConstructorParameters<typeof RuntimeAdapterError>[0],
): RuntimeAdapterError {
  return error instanceof RuntimeAdapterError ? error : new RuntimeAdapterError(fallback);
}

export class CodexJsonlPeer {
  private readonly transport: OfficialRuntimeTransport;
  private readonly providerRequestBudget: ProviderRequestBudget | undefined;
  private readonly bufferedNotifications: JsonObject[] = [];
  private nextRequestId = 1;
  private stopped = false;
  private pendingEventRequest:
    | {
        readonly id: number;
        readonly observeResult: (result: unknown) => void;
        readonly resolve: () => void;
        readonly reject: (error: RuntimeAdapterError) => void;
      }
    | undefined;

  constructor(
    transport: OfficialRuntimeTransport,
    providerRequestBudget?: ProviderRequestBudget,
  ) {
    this.transport = transport;
    this.providerRequestBudget = providerRequestBudget;
  }

  async request(method: string, params: JsonObject = {}): Promise<unknown> {
    const id = this.nextRequestId++;
    if (this.providerRequestBudget !== undefined) {
      const operation = codexProviderOperation(method);
      if (operation === undefined) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      await this.providerRequestBudget.claim(operation);
    }
    await this.write({ jsonrpc: "2.0", id, method, params });

    while (true) {
      const message = await this.read();
      if (hasOwn(message, "method")) {
        this.validateNotification(message);
        this.bufferedNotifications.push(message);
        continue;
      }

      if (message.id !== id) throw new RuntimeAdapterError("protocol-invalid");
      const hasResult = hasOwn(message, "result");
      const hasError = hasOwn(message, "error");
      if (hasResult === hasError) throw new RuntimeAdapterError("protocol-invalid");
      if (hasError) throw new RuntimeAdapterError("protocol-rejected");
      return message.result;
    }
  }

  async notify(method: string, params: JsonObject = {}): Promise<void> {
    if (this.providerRequestBudget !== undefined && method !== "initialized") {
      throw new ProviderRequestBudgetError("unknown-operation");
    }
    await this.write({ jsonrpc: "2.0", method, params });
  }

  async requestFromEventStream(
    method: string,
    params: JsonObject,
    observeResult: (result: unknown) => void,
  ): Promise<void> {
    if (this.stopped || this.pendingEventRequest !== undefined) {
      throw new RuntimeAdapterError("invalid-input");
    }
    if (this.providerRequestBudget !== undefined) {
      const operation = codexProviderOperation(method);
      if (operation === undefined) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      await this.providerRequestBudget.claim(operation);
    }
    const id = this.nextRequestId++;
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingEventRequest = {
        id,
        observeResult,
        resolve,
        reject,
      };
    });
    try {
      await this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.pendingEventRequest = undefined;
      throw error;
    }
    await completion;
  }

  takeBufferedNotifications(): JsonObject[] {
    return this.bufferedNotifications.splice(0);
  }

  async nextNotification(): Promise<JsonObject> {
    const buffered = this.bufferedNotifications.shift();
    if (buffered) return buffered;
    while (true) {
      const message = await this.read();
      if (hasOwn(message, "method")) {
        this.validateNotification(message);
        return message;
      }
      const pending = this.pendingEventRequest;
      if (pending === undefined || message.id !== pending.id) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      const hasResult = hasOwn(message, "result");
      const hasError = hasOwn(message, "error");
      if (hasResult === hasError) {
        const failure = new RuntimeAdapterError("protocol-invalid");
        this.pendingEventRequest = undefined;
        pending.reject(failure);
        throw failure;
      }
      if (hasError) {
        const failure = new RuntimeAdapterError("protocol-rejected");
        this.pendingEventRequest = undefined;
        pending.reject(failure);
        throw failure;
      }
      try {
        pending.observeResult(message.result);
      } catch (error) {
        const failure = toRuntimeError(error, "protocol-invalid");
        this.pendingEventRequest = undefined;
        pending.reject(failure);
        throw failure;
      }
      this.pendingEventRequest = undefined;
      pending.resolve();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const pending = this.pendingEventRequest;
    if (pending !== undefined) {
      this.pendingEventRequest = undefined;
      pending.reject(new RuntimeAdapterError("runtime-shutdown"));
    }
    try {
      await this.transport.stop();
    } catch {
      throw new RuntimeAdapterError("runtime-shutdown");
    }
  }

  private async write(message: JsonObject): Promise<void> {
    try {
      await this.transport.send(JSON.stringify(message));
    } catch {
      throw new RuntimeAdapterError("transport-failed");
    }
  }

  private async read(): Promise<JsonObject> {
    let line: string | null;
    try {
      line = await this.transport.receive();
    } catch {
      throw new RuntimeAdapterError("transport-failed");
    }
    if (line === null) throw new RuntimeAdapterError("transport-failed");

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (!isObject(message)) throw new RuntimeAdapterError("protocol-invalid");
    return message;
  }

  private validateNotification(message: JsonObject): void {
    if (typeof message.method !== "string" || message.method.length === 0) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (hasOwn(message, "result") || hasOwn(message, "error")) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (approvalMethods.has(message.method)) {
      throw new RuntimeAdapterError("approval-required");
    }
    if (hasOwn(message, "id") || message.method === "serverRequest/resolved") {
      throw new RuntimeAdapterError("unexpected-server-request");
    }
    if (turnScopedLifecycleMethods.has(message.method)) {
      const params = message.params;
      if (!isObject(params)) throw new RuntimeAdapterError("correlation-invalid");
      const turn = isObject(params.turn) ? params.turn : undefined;
      const thread = isObject(params.thread) ? params.thread : undefined;
      const threadId = params.threadId ?? thread?.id;
      const turnId = params.turnId ?? turn?.id;
      if (
        typeof threadId !== "string" ||
        threadId.length === 0 ||
        typeof turnId !== "string" ||
        turnId.length === 0
      ) {
        throw new RuntimeAdapterError("correlation-invalid");
      }
    }
  }
}

function codexProviderOperation(method: string): ProviderOperationKind | undefined {
  if (method === "initialize") return "codex-initialize";
  if (method === "account/read") return "codex-account-read";
  if (method === "model/list") return "codex-model-list-page";
  return undefined;
}

export function asObject(value: unknown, category: RuntimeFailureCategory): JsonObject {
  if (!isObject(value)) throw new RuntimeAdapterError(category);
  return value;
}
