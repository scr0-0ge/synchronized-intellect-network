import { RuntimeAdapterError } from "../index.ts";
import type {
  NormalizedRuntimeUserInputEvent, RuntimeFailureCategory, RuntimeUserInputChannel,
  RuntimeUserInputId, RuntimeUserInputQuestion, RuntimeUserInputRequest, RuntimeUserInputResponse,
} from "../index.ts";
import type { OfficialRuntimeTransport } from "./transport.ts";
import {
  ProviderRequestBudgetError,
  type ProviderOperationKind,
  type ProviderRequestBudget,
} from "../provider-request-budget.ts";

type JsonObject = Record<string, unknown>;

const userInputMethod = "item/tool/requestUserInput";
const userInputTimeoutMilliseconds = 300_000;
// Consecutive, not cumulative: a CLI that prints a notice after every frame is
// noisy, not broken, while one that answers only noise still runs out.
const maximumConsecutiveNonProtocolLines = 64;
// Only the request/response half of the wire is bounded. A turn's event stream
// is legitimately quiet while a tool runs, but `initialize`, `account/read` and
// `model/list` are answered immediately or not at all -- and a CLI that accepts
// the handshake and then says nothing used to leave startup waiting forever,
// which is a dead window with no error rather than a failure anyone can read.
const requestResponseTimeoutMilliseconds = 60_000;

interface CodexUserInputRequest {
  readonly id: RuntimeUserInputId;
  readonly threadId: string;
  readonly turnId: string;
  readonly questions: readonly RuntimeUserInputQuestion[];
  readonly isBlocking: boolean;
  readonly timeoutMilliseconds: number;
}

interface UserInputState {
  readonly wire: CodexUserInputRequest;
  request?: RuntimeUserInputRequest;
  timer?: ReturnType<typeof setTimeout>;
  receipt?: {
    readonly resolution: "answered";
    readonly completion: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: RuntimeAdapterError) => void;
  };
  status: "received" | "pending" | "responding" | "answered";
}

function isRequestId(value: unknown): value is RuntimeUserInputId {
  return (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new RuntimeAdapterError("protocol-invalid");
  return value;
}

/** Consume only the documented user-input wire, rebuilding every exposed field. */
function readUserInputRequest(message: JsonObject): CodexUserInputRequest {
  if (!isRequestId(message.id)) throw new RuntimeAdapterError("protocol-invalid");
  const params = asObject(message.params, "protocol-invalid");
  const threadId = requiredText(params.threadId);
  const turnId = requiredText(params.turnId);
  requiredText(params.itemId);
  if (!Array.isArray(params.questions) || params.questions.length === 0) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const ids = new Set<string>();
  const questions = params.questions.map((value): RuntimeUserInputQuestion => {
    const question = asObject(value, "protocol-invalid");
    const id = requiredText(question.id);
    const header = requiredText(question.header);
    const text = requiredText(question.question);
    if (ids.has(id) || typeof question.isOther !== "boolean" || typeof question.isSecret !== "boolean") {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    ids.add(id);
    if (question.options !== null && (!Array.isArray(question.options) || question.options.length === 0)) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    const options = (question.options ?? []).map((value: unknown) => {
      const option = asObject(value, "protocol-invalid");
      const label = requiredText(option.label);
      if (typeof option.description !== "string") throw new RuntimeAdapterError("protocol-invalid");
      return Object.freeze({ label, description: option.description });
    });
    return Object.freeze({ id, header, text, kind: question.options === null ? "free-text" : "choice",
      options: Object.freeze(options), allowFreeText: question.options === null || question.isOther,
      isSecret: question.isSecret });
  });
  if (params.isBlocking !== undefined && typeof params.isBlocking !== "boolean") {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const timeout = params.autoResolutionMs;
  if (timeout !== undefined && timeout !== null &&
      (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0)) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return { id: message.id, threadId, turnId, questions: Object.freeze(questions),
    isBlocking: params.isBlocking ?? true,
    timeoutMilliseconds: Math.min(timeout ?? userInputTimeoutMilliseconds, userInputTimeoutMilliseconds) };
}

/** Callers supply fixed product wording, never native payloads or credentials. */
export function reportCodexDiagnostic(message: string): void {
  try {
    process.stderr.write(`[codex-cli] ${message}\n`);
  } catch {
    // Losing diagnostics must not change the outcome of a Runtime operation.
  }
}

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

/**
 * One wire message that crossed the peer boundary, for diagnostics only
 * (ticket 19: capturing the real app-server event stream that
 * `CodexRuntimeBinding.events()` validates). The observer receives a
 * structured clone — it can record, but never mutate or replace, peer
 * state — and an observer fault can never change peer behaviour.
 */
export interface CodexPeerMessageObservation {
  readonly direction: "inbound" | "outbound";
  readonly message: JsonObject;
}

export type CodexPeerMessageObserver = (
  observation: CodexPeerMessageObservation,
) => void;

export function toRuntimeError(
  error: unknown,
  fallback: ConstructorParameters<typeof RuntimeAdapterError>[0],
): RuntimeAdapterError {
  return error instanceof RuntimeAdapterError ? error : new RuntimeAdapterError(fallback);
}

export class CodexJsonlPeer {
  private readonly transport: OfficialRuntimeTransport;
  private readonly providerRequestBudget: ProviderRequestBudget | undefined;
  private readonly messageObserver: CodexPeerMessageObserver | undefined;
  private readonly bufferedNotifications: JsonObject[] = [];
  private nextRequestId = 1;
  private stopped = false;
  private reportedNonProtocolOutput = false;
  private readonly userInputRequests = new Map<RuntimeUserInputId, UserInputState>();
  private readonly userInputListeners = new Set<(event: NormalizedRuntimeUserInputEvent) => void>();
  readonly userInput: RuntimeUserInputChannel = Object.freeze({
    pending: () => Object.freeze([...this.userInputRequests.values()]
      .filter((state) => state.status === "pending").map((state) => state.request!)),
    subscribe: (listener: (event: NormalizedRuntimeUserInputEvent) => void) => {
      this.userInputListeners.add(listener);
      return () => { this.userInputListeners.delete(listener); };
    },
    answer: (response: RuntimeUserInputResponse) => this.answerUserInput(response),
    cancel: (id: RuntimeUserInputId) => this.respondToUserInput(id, {}, "cancelled"),
  });
  private pendingEventRequest:
    | {
        readonly id: number;
        readonly observeResult: (result: unknown) => void;
        /** False when only this request fails, never the turn carrying it. */
        readonly acknowledgementEndsTurn: boolean;
        readonly resolve: () => void;
        readonly reject: (error: RuntimeAdapterError) => void;
      }
    | undefined;

  constructor(
    transport: OfficialRuntimeTransport,
    providerRequestBudget?: ProviderRequestBudget,
    messageObserver?: CodexPeerMessageObserver,
  ) {
    this.transport = transport;
    this.providerRequestBudget = providerRequestBudget;
    this.messageObserver = messageObserver;
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

    const deadline = Date.now() + requestResponseTimeoutMilliseconds;
    while (true) {
      const message = await this.read(deadline);
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

  /**
   * Issue #6 case 9: `acknowledgementEndsTurn` says whether a rejected or
   * drifted acknowledgement puts the *turn* in doubt. `turn/interrupt` asks
   * the runtime to end the turn, so a broken receipt leaves the turn's fate
   * unknown and stays fail-closed (`true`). `turn/steer` only adds input to a
   * turn that keeps running whether or not the request lands, so its failure
   * belongs to the caller alone (`false`) -- the event stream reads on and the
   * Session stays continuable.
   */
  async requestFromEventStream(
    method: string,
    params: JsonObject,
    observeResult: (result: unknown) => void,
    acknowledgementEndsTurn = true,
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
        acknowledgementEndsTurn,
        resolve,
        reject,
      };
    });
    // close() can reject the receipt while the stdin write is still pending.
    // Observe it now; awaiting the original promise below still reports failure.
    void completion.catch(() => {});
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

  /** The binding authorizes the request only after proving its active thread/turn. */
  activateUserInput(id: unknown, threadId: string, turnId: string): void {
    const state = isRequestId(id) ? this.userInputRequests.get(id) : undefined;
    if (this.stopped || state === undefined || state.status !== "received" ||
        state.wire.threadId !== threadId || state.wire.turnId !== turnId) {
      throw new RuntimeAdapterError("correlation-invalid");
    }
    state.status = "pending";
    state.request = Object.freeze({ id: state.wire.id, questions: state.wire.questions,
      isBlocking: state.wire.isBlocking, expiresAt: Date.now() + state.wire.timeoutMilliseconds });
    state.timer = setTimeout(() => {
      // A missing UI/answer cannot leave the app-server waiting indefinitely.
      // No default is selected: an empty answer map is the native cancellation.
      void this.respondToUserInput(state.wire.id, {}, "timed-out").catch(() => {});
    }, state.wire.timeoutMilliseconds);
    this.emitUserInput({ kind: "user-input-requested", request: state.request });
  }

  resolveUserInputNotification(message: JsonObject): void {
    const params = asObject(message.params, "protocol-invalid");
    const state = isRequestId(params.requestId) ? this.userInputRequests.get(params.requestId) : undefined;
    if (!state) throw new RuntimeAdapterError("unexpected-server-request");
    if (state.wire.threadId !== params.threadId) throw new RuntimeAdapterError("correlation-invalid");
    this.resolveUserInput(state, state.receipt?.resolution ?? "runtime-resolved");
  }

  private async answerUserInput(response: RuntimeUserInputResponse): Promise<void> {
    if (!isObject(response) || Object.keys(response).length !== 2 ||
        !isRequestId(response.requestId) || !Array.isArray(response.answers)) {
      throw new RuntimeAdapterError("invalid-input");
    }
    const state = this.userInputRequests.get(response.requestId);
    if (this.stopped || state?.status !== "pending" || response.answers.length !== state.wire.questions.length) {
      throw new RuntimeAdapterError("invalid-input");
    }
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    for (const entry of response.answers) {
      if (!isObject(entry) || Object.keys(entry).length !== 2 || typeof entry.questionId !== "string" ||
          !Array.isArray(entry.values) || entry.values.length === 0 || hasOwn(answers, entry.questionId)) {
        throw new RuntimeAdapterError("invalid-input");
      }
      const question = state.wire.questions.find((question) => question.id === entry.questionId);
      if (!question || entry.values.some((value: unknown) => typeof value !== "string" || !value.trim() ||
          (!question.allowFreeText && !question.options.some((option) => option.label === value)))) {
        throw new RuntimeAdapterError("invalid-input");
      }
      answers[entry.questionId] = { answers: [...entry.values] };
    }
    await this.respondToUserInput(response.requestId, answers, "answered");
  }

  private async respondToUserInput(
    id: RuntimeUserInputId,
    answers: Record<string, { answers: string[] }>,
    resolution: "answered" | "cancelled" | "timed-out",
  ): Promise<void> {
    const state = this.userInputRequests.get(id);
    if (this.stopped || state?.status !== "pending") throw new RuntimeAdapterError("invalid-input");
    state.status = "responding";
    if (resolution === "answered") {
      let resolveReceipt!: () => void;
      let rejectReceipt!: (error: RuntimeAdapterError) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveReceipt = resolve;
        rejectReceipt = reject;
      });
      void completion.catch(() => {});
      state.receipt = { resolution, completion, resolve: resolveReceipt, reject: rejectReceipt };
    }
    clearTimeout(state.timer);
    try {
      // This is a response on the existing peer, not a new turn/request id.
      await this.write({ jsonrpc: "2.0", id, result: { answers } });
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (this.userInputRequests.get(id) !== state) {
      await state.receipt?.completion; // Server cleanup/stop won the write race.
      return;
    }
    // A successful pipe write proves only that the response left this process.
    // Codex confirms consumption with the correlated serverRequest/resolved.
    if (state.receipt !== undefined) {
      await state.receipt.completion;
      return;
    }
    state.status = "answered";
    this.emitUserInput({ kind: "user-input-resolved", requestId: id, resolution });
  }

  private emitUserInput(event: NormalizedRuntimeUserInputEvent): void {
    Object.freeze(event);
    for (const listener of this.userInputListeners) {
      try { listener(event); } catch {
        reportCodexDiagnostic("A user-input listener failed; runtime request handling continues.");
      }
    }
  }

  private resolveUserInput(state: UserInputState, resolution: "answered" | "runtime-resolved" | "session-ended"): void {
    clearTimeout(state.timer);
    this.userInputRequests.delete(state.wire.id);
    if (state.request !== undefined && state.status !== "answered") {
      this.emitUserInput({ kind: "user-input-resolved", requestId: state.wire.id, resolution });
    }
    if (state.receipt !== undefined) {
      if (resolution === state.receipt.resolution) state.receipt.resolve();
      else state.receipt.reject(new RuntimeAdapterError("runtime-shutdown"));
    }
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
      // The acknowledgement always fails its own caller. Whether it also ends
      // the turn is the caller's declared contract, not this reader's guess.
      const settleFailure = (failure: RuntimeAdapterError): boolean => {
        this.pendingEventRequest = undefined;
        pending.reject(failure);
        return pending.acknowledgementEndsTurn;
      };
      if (hasResult === hasError) {
        const failure = new RuntimeAdapterError("protocol-invalid");
        if (settleFailure(failure)) throw failure;
        continue;
      }
      if (hasError) {
        const failure = new RuntimeAdapterError("protocol-rejected");
        if (settleFailure(failure)) throw failure;
        continue;
      }
      try {
        pending.observeResult(message.result);
      } catch (error) {
        const failure = toRuntimeError(error, "protocol-invalid");
        if (settleFailure(failure)) throw failure;
        continue;
      }
      this.pendingEventRequest = undefined;
      pending.resolve();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const state of this.userInputRequests.values()) this.resolveUserInput(state, "session-ended");
    this.userInputListeners.clear();
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
    this.observeMessage("outbound", message);
  }

  /**
   * One protocol message, past whatever else the CLI printed on stdout.
   *
   * A CLI release that adds an upgrade banner, a deprecation notice or a blank
   * line to stdout is not a broken protocol, and treating it as one took the
   * product down before a turn was ever sent. Such a line cannot be a JSON-RPC
   * message at all -- a JSON object is `{` once trimmed -- so it is skipped and
   * named once, rather than ending the operation.
   *
   * Two things stay strict. A line that DOES open an object is parsed, and a
   * damaged one still fails: swallowing it would silently lose a real frame.
   * And the skip is bounded per gap, so a CLI that answers nothing but noise
   * fails rather than reading forever -- a hang is worse than an error.
   */
  private async read(deadline?: number): Promise<JsonObject> {
    let skipped = 0;
    while (true) {
      let line: string | null;
      try {
        line =
          deadline === undefined
            ? await this.transport.receive()
            : await this.receiveBefore(deadline);
      } catch (error) {
        throw toRuntimeError(error, "transport-failed");
      }
      if (line === null) throw new RuntimeAdapterError("transport-failed");

      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        skipped += 1;
        if (skipped > maximumConsecutiveNonProtocolLines) {
          throw new RuntimeAdapterError("protocol-invalid");
        }
        if (!this.reportedNonProtocolOutput) {
          this.reportedNonProtocolOutput = true;
          reportCodexDiagnostic(
            "Codex CLI stdout carried output that is not protocol JSON; " +
              "those lines are ignored and the operation continues.",
          );
        }
        continue;
      }
      skipped = 0;

      let message: unknown;
      try {
        message = JSON.parse(trimmed) as unknown;
      } catch {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      if (!isObject(message)) throw new RuntimeAdapterError("protocol-invalid");
      this.observeMessage("inbound", message);
      return message;
    }
  }

  /**
   * The next line, or a failure once the deadline passes. The abandoned receive
   * is left to the transport: every caller of this stops the peer on failure.
   */
  private async receiveBefore(deadline: number): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.transport.receive(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RuntimeAdapterError("transport-failed")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private observeMessage(
    direction: "inbound" | "outbound",
    message: JsonObject,
  ): void {
    const observer = this.messageObserver;
    if (observer === undefined) return;
    try {
      observer({ direction, message: structuredClone(message) });
    } catch {
      // A diagnostic observer must never change peer behaviour.
    }
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
    if (message.method === userInputMethod) {
      const wire = readUserInputRequest(message);
      if (this.userInputRequests.has(wire.id)) throw new RuntimeAdapterError("correlation-invalid");
      this.userInputRequests.set(wire.id, { wire, status: "received" });
      return;
    }
    if (message.method === "serverRequest/resolved" && !hasOwn(message, "id")) {
      const params = asObject(message.params, "protocol-invalid");
      if (!isRequestId(params.requestId) || typeof params.threadId !== "string" || !params.threadId) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      const state = this.userInputRequests.get(params.requestId);
      if (!state) throw new RuntimeAdapterError("unexpected-server-request");
      if (state.wire.threadId !== params.threadId) throw new RuntimeAdapterError("correlation-invalid");
      // Apply cleanup in binding consumption order, including startup-buffered
      // request/resolution pairs. Reading ahead must not invalidate the request.
      return;
    }
    if (hasOwn(message, "id") || message.method === "serverRequest/resolved") {
      reportCodexDiagnostic(
        "Codex CLI sent an unrecognized server request; it was rejected because the Runtime cannot answer an unknown blocking request.",
      );
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
