import type {
  NormalizedRuntimeEvent,
  ResumableRuntimeBinding,
  RuntimeInterruptAvailability,
  RuntimeSteerAvailability,
  RuntimeContextUsage,
  RuntimeInput,
  SessionProfile,
} from "../index.ts";
import { RuntimeAdapterError } from "../index.ts";
import { asObject, CodexJsonlPeer, toRuntimeError } from "./protocol.ts";

type JsonObject = Record<string, unknown>;

interface FinalMessageCandidate {
  readonly itemId: string;
  readonly sequence: number;
  readonly text: string;
}

interface CorrelatedItem extends JsonObject {
  readonly id: string;
  readonly type: string;
}

export interface CodexNativeTurnAccess {
  readonly approvalPolicy: "never";
  readonly sandboxPolicy: { readonly type: "dangerFullAccess" };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const tokenCountKeys = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length && actual.every((key) => expected.includes(key))
  );
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readTokenCounts(value: unknown): JsonObject {
  const counts = asObject(value, "protocol-invalid");
  if (
    !hasExactKeys(counts, tokenCountKeys) ||
    tokenCountKeys.some((key) => !isTokenCount(counts[key]))
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return counts;
}

function readContextUsage(value: unknown): RuntimeContextUsage {
  const usage = asObject(value, "protocol-invalid");
  if (!hasExactKeys(usage, ["last", "modelContextWindow", "total"])) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  readTokenCounts(usage.total);
  const last = readTokenCounts(usage.last);
  if (
    !isTokenCount(usage.modelContextWindow) ||
    (usage.modelContextWindow as number) < (last.totalTokens as number)
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return Object.freeze({
    basis: "active-context",
    usedTokens: last.totalTokens as number,
    windowTokens: usage.modelContextWindow as number,
  });
}

export class CodexRuntimeBinding implements ResumableRuntimeBinding {
  readonly profile: SessionProfile;
  readonly opaqueSessionReference: string;
  private readonly peer: CodexJsonlPeer;
  private readonly threadId: string;
  private readonly nativeAccess: CodexNativeTurnAccess;
  private readonly sessionKind: "new" | "resumed";
  private turnId: string | undefined;
  private sent = false;
  private eventsConsumed = false;
  private terminal = false;
  private steerPending = false;
  private interruptRequested = false;
  private interruptConfirmed = false;

  constructor(
    peer: CodexJsonlPeer,
    threadId: string,
    profile: SessionProfile,
    nativeAccess: CodexNativeTurnAccess,
    sessionKind: "new" | "resumed",
  ) {
    this.peer = peer;
    this.threadId = threadId;
    this.profile = Object.freeze({ ...profile });
    this.opaqueSessionReference = threadId;
    this.nativeAccess = nativeAccess;
    this.sessionKind = sessionKind;
  }

  effectiveProfile(): SessionProfile {
    return this.profile;
  }

  async send(input: RuntimeInput): Promise<void> {
    if (this.sent || !isRuntimeInput(input)) {
      await this.stopAfterFailure("invalid-input");
    }
    this.sent = true;

    try {
      const result = asObject(
        await this.peer.request("turn/start", {
          threadId: this.threadId,
          input: [{ type: "text", text: input.text }],
          model: this.profile.model,
          effort: this.profile.effortLevel,
          approvalPolicy: this.nativeAccess.approvalPolicy,
          sandboxPolicy: this.nativeAccess.sandboxPolicy,
        }),
        "correlation-invalid",
      );
      const turn = asObject(result.turn, "correlation-invalid");
      const turnId = stringValue(turn.id);
      if (!turnId || turn.status !== "inProgress") {
        throw new RuntimeAdapterError("correlation-invalid");
      }
      this.turnId = turnId;
    } catch (error) {
      const failure = toRuntimeError(error, "runtime-unavailable");
      await this.stopAfterFailure(failure.category);
    }
  }

  interruptAvailability(): RuntimeInterruptAvailability {
    return this.eventsConsumed &&
      !this.terminal &&
      !this.interruptRequested &&
      !this.steerPending
      ? "available"
      : "unavailable";
  }

  steerAvailability(): RuntimeSteerAvailability {
    return this.eventsConsumed &&
      !this.terminal &&
      !this.interruptRequested &&
      !this.steerPending
      ? "available"
      : "unavailable";
  }

  async steer(input: RuntimeInput): Promise<void> {
    if (
      this.steerAvailability() !== "available" ||
      !this.turnId ||
      !isRuntimeInput(input)
    ) {
      throw new RuntimeAdapterError("invalid-input");
    }
    this.steerPending = true;
    try {
      await this.peer.requestFromEventStream(
        "turn/steer",
        {
          threadId: this.threadId,
          expectedTurnId: this.turnId,
          input: [{ type: "text", text: input.text }],
        },
        (result) => {
          const response = asObject(result, "protocol-invalid");
          if (
            !hasExactKeys(response, ["turnId"]) ||
            stringValue(response.turnId) !== this.turnId
          ) {
            throw new RuntimeAdapterError("protocol-invalid");
          }
        },
      );
    } finally {
      this.steerPending = false;
    }
  }

  async interrupt(): Promise<void> {
    if (this.interruptAvailability() !== "available" || !this.turnId) {
      throw new RuntimeAdapterError("invalid-input");
    }
    this.interruptRequested = true;
    await this.peer.requestFromEventStream(
      "turn/interrupt",
      { threadId: this.threadId, turnId: this.turnId },
      (result) => {
        const response = asObject(result, "protocol-invalid");
        if (Object.keys(response).length !== 0) {
          throw new RuntimeAdapterError("protocol-invalid");
        }
        this.interruptConfirmed = true;
      },
    );
  }

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    if (this.eventsConsumed || !this.sent || !this.turnId) {
      yield await this.failureAfterStop("invalid-input");
      return;
    }
    this.eventsConsumed = true;

    let terminal = false;
    let sequence = 0;
    let sessionStartedSequence = this.sessionKind === "resumed" ? 0 : undefined;
    let resumedThreadStartedSeen = false;
    let turnStartedSequence: number | undefined;
    const agentStartedSequences = new Map<string, number>();
    const explicitFinals: FinalMessageCandidate[] = [];
    const phaseUnknownFinals: FinalMessageCandidate[] = [];
    let context: RuntimeContextUsage | undefined;
    const buffered = this.peer.takeBufferedNotifications();

    try {
      // A successful resume already establishes the Session. Current Runtime
      // releases omit thread/started here; older releases may still send one.
      if (this.sessionKind === "resumed") {
        yield { kind: "session-started" };
      }
      while (true) {
        const message = buffered.shift() ?? (await this.peer.nextNotification());
        sequence += 1;
        const method = message.method;
        const params = asObject(message.params ?? {}, "protocol-invalid");

        if (method === "thread/started") {
          const thread = asObject(params.thread ?? {}, "correlation-invalid");
          const eventThreadId = stringValue(params.threadId ?? thread.id);
          if (!eventThreadId) throw new RuntimeAdapterError("correlation-invalid");
          if (eventThreadId !== this.threadId) continue;
          if (this.sessionKind === "resumed") {
            if (resumedThreadStartedSeen || turnStartedSequence !== undefined) {
              throw new RuntimeAdapterError("correlation-invalid");
            }
            resumedThreadStartedSeen = true;
            continue;
          }
          if (sessionStartedSequence !== undefined) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          sessionStartedSequence = sequence;
          yield { kind: "session-started" };
          continue;
        }

        if (method === "turn/started") {
          const correlation = this.readTurnCorrelation(params);
          if (correlation === "unrelated") continue;
          if (turnStartedSequence !== undefined) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          turnStartedSequence = sequence;
          yield { kind: "turn-started" };
          continue;
        }

        if (method === "item/started" || method === "item/completed") {
          const correlation = this.readItemCorrelation(params);
          if (correlation === "unrelated") continue;
          const item = correlation;
          if (item.type !== "agentMessage") continue;

          if (method === "item/started") {
            if (agentStartedSequences.has(item.id)) {
              throw new RuntimeAdapterError("correlation-invalid");
            }
            agentStartedSequences.set(item.id, sequence);
            yield { kind: "item-started", itemType: "agent-message" };
            continue;
          }

          if (typeof item.text !== "string") {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          const candidate = { itemId: item.id, sequence, text: item.text };
          if (item.phase === "final_answer") explicitFinals.push(candidate);
          else if (item.phase === undefined) phaseUnknownFinals.push(candidate);
          continue;
        }

        if (method === "thread/tokenUsage/updated") {
          const observed = this.readContextCorrelation(params);
          if (observed === "unrelated") continue;
          context = observed;
          continue;
        }

        if (method === "turn/completed") {
          const correlation = this.readTurnCorrelation(params);
          if (correlation === "unrelated") continue;
          const turn = asObject(params.turn, "correlation-invalid");
          if (turn.status === "interrupted") {
            if (!this.interruptConfirmed) {
              throw new RuntimeAdapterError("correlation-invalid");
            }
            await this.peer.stop();
            terminal = true;
            this.terminal = true;
            yield { kind: "turn-interrupted", status: "interrupted" };
            return;
          }
          if (turn.status !== "completed") throw new RuntimeAdapterError("turn-failed");

          const finals = explicitFinals.length > 0 ? explicitFinals : phaseUnknownFinals;
          if (
            sessionStartedSequence === undefined ||
            turnStartedSequence === undefined ||
            finals.length !== 1
          ) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          const finalMessage = finals[0];
          const itemStartedSequence = agentStartedSequences.get(finalMessage.itemId);
          if (
            itemStartedSequence === undefined ||
            !(sessionStartedSequence < turnStartedSequence) ||
            !(turnStartedSequence < itemStartedSequence) ||
            !(itemStartedSequence < finalMessage.sequence) ||
            !(finalMessage.sequence < sequence)
          ) {
            throw new RuntimeAdapterError("correlation-invalid");
          }

          await this.peer.stop();
          terminal = true;
          this.terminal = true;
          yield { kind: "item-completed", itemType: "agent-message" };
          yield { kind: "agent-message", text: finalMessage.text };
          yield {
            kind: "turn-completed",
            status: "completed",
            ...(context === undefined ? {} : { context }),
          };
          return;
        }
      }
    } catch (error) {
      let failure = toRuntimeError(error, "protocol-invalid");
      if (failure.category === "transport-failed") {
        failure = new RuntimeAdapterError("correlation-invalid");
      }
      try {
        await this.peer.stop();
      } catch (stopError) {
        failure = toRuntimeError(stopError, "runtime-shutdown");
      }
      terminal = true;
      this.terminal = true;
      yield { kind: "failed", category: failure.category };
    } finally {
      if (!terminal) {
        this.terminal = true;
        try {
          await this.peer.stop();
        } catch {
          // The consumer abandoned observation; shutdown is still attempted and no native detail escapes.
        }
      }
    }
  }

  private readTurnCorrelation(params: JsonObject): JsonObject | "unrelated" {
    const turn = asObject(params.turn, "correlation-invalid");
    const eventThreadId = stringValue(params.threadId);
    const eventTurnId = stringValue(turn.id);
    if (!eventThreadId || !eventTurnId) throw new RuntimeAdapterError("correlation-invalid");
    if (eventThreadId !== this.threadId) return "unrelated";
    if (eventTurnId !== this.turnId) throw new RuntimeAdapterError("correlation-invalid");
    return turn;
  }

  private readItemCorrelation(params: JsonObject): CorrelatedItem | "unrelated" {
    const item = asObject(params.item, "correlation-invalid");
    const eventThreadId = stringValue(params.threadId);
    const eventTurnId = stringValue(params.turnId);
    const itemId = stringValue(item.id);
    const itemType = stringValue(item.type);
    if (!eventThreadId || !eventTurnId || !itemId || !itemType) {
      throw new RuntimeAdapterError("correlation-invalid");
    }
    if (eventThreadId !== this.threadId) return "unrelated";
    if (eventTurnId !== this.turnId) throw new RuntimeAdapterError("correlation-invalid");
    return { ...item, id: itemId, type: itemType };
  }

  private readContextCorrelation(
    params: JsonObject,
  ): RuntimeContextUsage | "unrelated" {
    const eventThreadId = stringValue(params.threadId);
    const eventTurnId = stringValue(params.turnId);
    if (!eventThreadId || !eventTurnId) {
      throw new RuntimeAdapterError("correlation-invalid");
    }
    if (eventThreadId !== this.threadId) return "unrelated";
    if (eventTurnId !== this.turnId) throw new RuntimeAdapterError("correlation-invalid");
    return readContextUsage(params.tokenUsage);
  }

  private async stopAfterFailure(
    category: ConstructorParameters<typeof RuntimeAdapterError>[0],
  ): Promise<never> {
    try {
      await this.peer.stop();
    } catch {
      throw new RuntimeAdapterError("runtime-shutdown");
    }
    throw new RuntimeAdapterError(category);
  }

  private async failureAfterStop(
    category: ConstructorParameters<typeof RuntimeAdapterError>[0],
  ): Promise<NormalizedRuntimeEvent> {
    try {
      await this.peer.stop();
      return { kind: "failed", category };
    } catch {
      return { kind: "failed", category: "runtime-shutdown" };
    }
  }
}

function isRuntimeInput(value: RuntimeInput): value is RuntimeInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}
