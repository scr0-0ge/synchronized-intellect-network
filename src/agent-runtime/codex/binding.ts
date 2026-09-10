import type {
  NormalizedRuntimeEvent,
  ResumableRuntimeBinding,
  RuntimeInterruptAvailability,
  RuntimeProgressActivity,
  RuntimeSteerAvailability,
  RuntimeToolActivity,
  RuntimeContextUsage,
  RuntimeInput,
  RuntimeUserInputChannel,
  SessionProfile,
} from "../index.ts";
import { RuntimeAdapterError } from "../index.ts";
import { redactToolActivityCredentials } from "../tool-activity-redaction.ts";
import { isVendorRecord } from "../vendor-wire.ts";
import { asObject, CodexJsonlPeer, reportCodexDiagnostic, toRuntimeError } from "./protocol.ts";

type JsonObject = Record<string, unknown>;

const unknownToolName = "未知工具";
const unknownToolType = "unknown";
const maximumToolActivitySourceTypeCharacters = 240;
const maximumToolActivityParameterCharacters = 120;
const maximumFileChangeSummaryFiles = 3;

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

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readTokenCounts(value: unknown): JsonObject {
  const counts = asObject(value, "protocol-invalid");
  if (
    !isVendorRecord(counts, tokenCountKeys) ||
    tokenCountKeys.some((key) => !isTokenCount(counts[key]))
  ) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  return { totalTokens: counts.totalTokens };
}

function readContextUsage(value: unknown): RuntimeContextUsage {
  const usage = asObject(value, "protocol-invalid");
  if (!isVendorRecord(usage, ["last", "modelContextWindow", "total"])) {
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
  readonly userInput: RuntimeUserInputChannel;
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
  private readonly acceptedGuidance: string[] = [];
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
    this.userInput = peer.userInput;
    this.threadId = threadId;
    this.profile = Object.freeze({ ...profile });
    this.opaqueSessionReference = threadId;
    this.nativeAccess = nativeAccess;
    this.sessionKind = sessionKind;
  }

  effectiveProfile(): SessionProfile {
    return this.profile;
  }

  /**
   * Start transport shutdown before awaiting iterator.return() or event draining.
   * Returns immediately, even if receive/stop is pending; not an exit receipt.
   */
  close(): void {
    this.terminal = true;
    void this.peer.stop().catch(() => {
      reportCodexDiagnostic("Codex CLI transport shutdown failed after close was requested; runtime exit was not confirmed.");
    });
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
          // "default" is a static-catalog tier meaning "effort not pinned"
          // (kimi-platform). Live-verified 2026-09-05: omitting the field
          // makes codex resolve a literal "default" internally and forward
          // it, which moonshot rejects (invalid_request_error). Map the
          // unpinned tier to a real provider value; per-endpoint effort
          // mapping tables are the proper follow-up.
          ...(this.profile.effortLevel === "default"
            ? { effort: "high" as const }
            : { effort: this.profile.effortLevel }),
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
            !isVendorRecord(response, ["turnId"]) ||
            stringValue(response.turnId) !== this.turnId
          ) {
            throw new RuntimeAdapterError("protocol-invalid");
          }
          this.acceptedGuidance.push(input.text);
        },
        // Issue #6 case 9: the Runtime documents rejections for steering a
        // turn that is not steerable (no active turn, wrong turn, review or
        // compaction). Every one of those left the turn running; only the
        // guidance failed. Refusing the guidance must not end the Session.
        false,
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
        if (!isVendorRecord(response)) {
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
    let guidanceBoundarySequence: number | undefined;
    const historicalUsageTurns = new Set<string>();
    const readSegmentFinal = (): FinalMessageCandidate => {
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
        (guidanceBoundarySequence !== undefined && !(guidanceBoundarySequence < itemStartedSequence)) ||
        !(itemStartedSequence < finalMessage.sequence) ||
        !(finalMessage.sequence < sequence)
      ) {
        throw new RuntimeAdapterError("correlation-invalid");
      }
      return finalMessage;
    };
    const reasoningItems = new Map<string, Map<number, string>>();
    const completedReasoningItems = new Set<string>();
    let reasoningEmitted = false;
    let reasoningUnavailable = false;
    const omitReasoning = (): void => {
      if (!reasoningUnavailable) {
        reportCodexDiagnostic("Codex CLI reasoning output is unrecognized; further reasoning display is unavailable for this turn. The answer is still being collected.");
      }
      reasoningUnavailable = true;
    };
    const reasoningFragment = (text: string, newPart: boolean): NormalizedRuntimeEvent => {
      const separator = newPart && reasoningEmitted ? "\n\n" : "";
      reasoningEmitted = true;
      return { kind: "reasoning", text: separator + text };
    };
    let context: RuntimeContextUsage | undefined;
    let contextDriftReported = false;
    let advisoryDriftReported = false;
    // Issue #6 case 4: same-turn activity notes, coalesced on transition so
    // a chatty notification stream cannot flood the durable store.
    let lastProgressKey: string | undefined;
    const yieldableProgress = (
      activity: RuntimeProgressActivity,
      tool?: RuntimeToolActivity,
    ): NormalizedRuntimeEvent | undefined => {
      const key = progressKey(activity, tool);
      if (key === lastProgressKey) return undefined;
      lastProgressKey = key;
      return Object.freeze({
        kind: "progress" as const,
        activity,
        ...(tool === undefined ? {} : { tool }),
      });
    };
    const buffered = this.peer.takeBufferedNotifications();

    try {
      // A successful resume already establishes the Session. Current Runtime
      // releases omit thread/started here; older releases may still send one.
      if (this.sessionKind === "resumed") {
        yield { kind: "session-started" };
      }
      while (true) {
        const fromStartupBuffer = buffered.length > 0;
        const message = buffered.shift() ?? (await this.peer.nextNotification());
        sequence += 1;
        const method = message.method;
        if (method === "item/tool/requestUserInput") {
          if (sessionStartedSequence === undefined || turnStartedSequence === undefined) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          this.peer.activateUserInput(message.id, this.threadId, this.turnId);
          continue;
        }
        if (method === "serverRequest/resolved") {
          this.peer.resolveUserInputNotification(message);
          continue;
        }
        switch (method) {
          case "thread/started":
          case "turn/started":
          case "item/reasoning/summaryTextDelta":
          case "item/started":
          case "item/completed":
          case "thread/tokenUsage/updated":
          case "turn/completed":
          case "error":
            break;
          default:
            // The peer has already rejected approval/unknown server requests and
            // checked lifecycle correlation. We consume no advisory payload.
            if (!isRecord(message.params ?? {}) && !advisoryDriftReported) {
              advisoryDriftReported = true;
              reportCodexDiagnostic("Codex CLI advisory notification output is unrecognized; its payload was ignored. The turn continues.");
            }
            continue;
        }
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

        if (method === "item/reasoning/summaryTextDelta") {
          const eventThreadId = stringValue(params.threadId);
          if (!eventThreadId) throw new RuntimeAdapterError("correlation-invalid");
          if (eventThreadId !== this.threadId) continue;
          if (params.turnId !== this.turnId || turnStartedSequence === undefined ||
              typeof params.itemId !== "string" || !reasoningItems.has(params.itemId) ||
              completedReasoningItems.has(params.itemId)) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          if (reasoningUnavailable) continue;
          if (typeof params.delta !== "string" || !Number.isSafeInteger(params.summaryIndex) ||
              (params.summaryIndex as number) < 0) {
            omitReasoning();
            continue;
          }
          const summaries = reasoningItems.get(params.itemId)!;
          const index = params.summaryIndex as number;
          if (params.delta.length > 0) {
            const progress = yieldableProgress("thinking");
            if (progress !== undefined) yield progress;
            const prefix = summaries.get(index) ?? "";
            summaries.set(index, prefix + params.delta);
            yield reasoningFragment(params.delta, prefix.length === 0);
          }
          continue;
        }

        if (method === "item/started" || method === "item/completed") {
          const correlation = this.readItemCorrelation(params);
          if (correlation === "unrelated") continue;
          const item = correlation;
          if (item.type !== "agentMessage") {
            // Codex acknowledges steering before it finishes the old model
            // response. Only the matching consumed user input starts the new
            // response segment (measured on Kimi's Responses face, 0.153.4).
            // Keep exactly one final per segment, not "pick the last of many".
            if (
              method === "item/completed" && item.type === "userMessage" &&
              this.acceptedGuidance.length > 0 &&
              Array.isArray(item.content) && item.content.length === 1 &&
              isVendorRecord(item.content[0], ["type", "text"]) &&
              item.content[0].type === "text" &&
              item.content[0].text === this.acceptedGuidance[0]
            ) {
              if (explicitFinals.length > 0 || phaseUnknownFinals.length > 0) {
                const previous = readSegmentFinal();
                yield { kind: "item-completed", itemType: "agent-message" };
                yield { kind: "agent-message", text: previous.text };
              }
              this.acceptedGuidance.shift();
              explicitFinals.length = 0;
              phaseUnknownFinals.length = 0;
              guidanceBoundarySequence = sequence;
            }
            if (item.type === "reasoning" && method === "item/started") {
              if (reasoningItems.has(item.id)) throw new RuntimeAdapterError("correlation-invalid");
              reasoningItems.set(item.id, new Map());
            }
            if (item.type === "reasoning" && method === "item/completed") {
              const streamed = reasoningItems.get(item.id);
              if (!streamed || completedReasoningItems.has(item.id)) throw new RuntimeAdapterError("correlation-invalid");
              completedReasoningItems.add(item.id);
              if (reasoningUnavailable) continue;
              const summary = item.summary ?? [];
              if (!Array.isArray(summary) || summary.some((text) => typeof text !== "string")) {
                omitReasoning();
                continue;
              }
              for (const [index, text] of (summary as string[]).entries()) {
                const prefix = streamed.get(index) ?? "";
                if (!text.startsWith(prefix)) throw new RuntimeAdapterError("correlation-invalid");
                const suffix = text.slice(prefix.length);
                if (suffix.length) yield reasoningFragment(suffix, prefix.length === 0);
              }
            }
            // A non-message item starting is visible same-turn activity
            // (issue #6 case 4): reasoning items mean thinking, command /
            // file / web items mean a tool is running. The userMessage echo
            // is the input itself, not activity, and stays quiet. A completed
            // fileChange adds its final path/count summary after the diff body
            // has been reduced and discarded.
            if (
              !isUserMessageItem(item.type) &&
              (method === "item/started" || item.type === "fileChange")
            ) {
              const progress = yieldableProgress(
                itemReasoningLike(item.type) ? "thinking" : "tool",
                itemReasoningLike(item.type)
                  ? undefined
                  : codexToolActivity(item, method === "item/completed"),
              );
              if (progress !== undefined) yield progress;
            }
            continue;
          }

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
          if (item.phase === "commentary") {
            if (!agentStartedSequences.has(item.id)) throw new RuntimeAdapterError("correlation-invalid");
            yield { kind: "item-completed", itemType: "agent-message" };
            yield { kind: "agent-message", text: item.text };
            continue;
          }
          const candidate = { itemId: item.id, sequence, text: item.text };
          // The real app-server wire (codex 0.153.0-alpha.5, responses
          // transport, captured 2026-09-05 — ticket 19) spells an unphased
          // agentMessage item as JSON `null` rather than as an absent key;
          // both absence spellings are the same legal variant. Any other
          // phase value keeps excluding the item from the finals, so the
          // turn still fails closed on an unrecognized phase.
          if (item.phase === "final_answer") explicitFinals.push(candidate);
          else if (item.phase === undefined || item.phase === null) {
            phaseUnknownFinals.push(candidate);
          }
          continue;
        }

        if (method === "thread/tokenUsage/updated") {
          try {
            const observed = this.readContextCorrelation(
              params,
              historicalUsageTurns,
              this.sessionKind === "resumed" && fromStartupBuffer && turnStartedSequence === undefined,
            );
            if (observed === "unrelated") continue;
            context = observed;
          } catch (error) {
            // Correlation still fails closed. Only the optional meter's payload
            // can be dropped; its numbers are never guessed or partially used.
            if (!(error instanceof RuntimeAdapterError) || error.category !== "protocol-invalid") throw error;
            context = undefined;
            if (!contextDriftReported) {
              contextDriftReported = true;
              reportCodexDiagnostic("Codex CLI tokenUsage output is unrecognized; the context meter is unavailable for this reading. The turn continues.");
            }
          }
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

          const finalMessage = readSegmentFinal();

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

        // Unknown-but-correlated notifications stay skippable wire noise,
        // with one honest exception (issue #6 case 4): a `error` frame
        // carrying willRetry is the CLI saying a provider call failed and it
        // is trying again -- exactly the signal whose absence made a
        // retrying turn look dead. Anything not shaped exactly like that is
        // skipped untouched, as before.
        if (method === "error") {
          const errorPayload = params.error;
          if (
            isRecord(errorPayload) &&
            errorPayload.willRetry === true
          ) {
            const progress = yieldableProgress("retrying");
            if (progress !== undefined) yield progress;
          }
          continue;
        }
      }
    } catch (error) {
      let failure = toRuntimeError(error, "protocol-invalid");
      if (failure.category === "transport-failed") {
        failure = new RuntimeAdapterError("correlation-invalid");
      }
      if (failure.category === "protocol-invalid" || failure.category === "correlation-invalid") {
        reportCodexDiagnostic("Codex CLI turn output is unrecognized, incomplete, or cannot be correlated; completion was not confirmed. The turn cannot be accepted as successful.");
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
    return {
      ...item,
      id: itemId,
      type: isSafeIdentity(itemType) ? itemType : unknownToolType,
    };
  }

  private readContextCorrelation(
    params: JsonObject,
    historicalUsageTurns: Set<string>,
    resumeSnapshot: boolean,
  ): RuntimeContextUsage | "unrelated" {
    const eventThreadId = stringValue(params.threadId);
    const eventTurnId = stringValue(params.turnId);
    if (!eventThreadId || !eventTurnId) {
      throw new RuntimeAdapterError("correlation-invalid");
    }
    if (eventThreadId !== this.threadId) return "unrelated";
    // The resume snapshot is buffered before this turn's lifecycle starts.
    // Its different, well-formed turn id belongs to history, not this meter.
    // Later events may repeat that known snapshot; an unknown id during the
    // active turn still fails, as do missing ids and all item/terminal drift.
    if (eventTurnId !== this.turnId && resumeSnapshot) historicalUsageTurns.add(eventTurnId);
    if (historicalUsageTurns.has(eventTurnId)) return "unrelated";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reasoning-style item types report thinking; every other item runs something. */
function itemReasoningLike(itemType: string): boolean {
  return itemType.toLowerCase().includes("reason");
}

/** The input's own wire echo (kimi-platform spells it `userMessage`). */
function isUserMessageItem(itemType: string): boolean {
  return itemType.toLowerCase() === "usermessage";
}

function codexToolActivity(
  item: CorrelatedItem,
  completed: boolean,
): RuntimeToolActivity {
  const name = readableToolName(item.name);
  switch (item.type) {
    case "commandExecution": {
      const parameter = toolActivityParameter("command", item.command);
      return Object.freeze({
        type: "commandExecution" as const,
        name,
        ...(parameter === undefined ? {} : { parameter }),
      });
    }
    case "fileChange": {
      const parameter = fileChangeParameter(item);
      const fileChanges = completed ? fileChangeSummary(item) : undefined;
      return Object.freeze({
        type: "fileChange" as const,
        name,
        ...(parameter === undefined ? {} : { parameter }),
        ...(fileChanges === undefined ? {} : { fileChanges }),
      });
    }
    case "webSearch":
      return Object.freeze({ type: "webSearch" as const, name });
    default:
      // The item remains visible without pretending that an unfamiliar
      // provider type is a known tool. Its own type/name are enough
      // for the presentation half to say exactly what was not recognized.
      return Object.freeze({
        type: "unknown" as const,
        sourceType: item.type,
        name,
      });
  }
}

function fileChangeSummary(
  item: CorrelatedItem,
): RuntimeToolActivity["fileChanges"] | undefined {
  if (!Array.isArray(item.changes)) return undefined;
  const files: NonNullable<RuntimeToolActivity["fileChanges"]>["files"][number][] = [];
  let totalFiles = 0;
  for (const change of item.changes) {
    if (!isRecord(change)) continue;
    const parameter = toolActivityParameter("path", change.path);
    if (parameter === undefined) continue;
    totalFiles += 1;
    if (files.length === maximumFileChangeSummaryFiles) continue;
    const lines = unifiedDiffLineSummary(change.diff);
    files.push(Object.freeze({
      path: parameter.value,
      truncated: parameter.truncated,
      ...(lines === undefined ? {} : { lines }),
    }));
  }
  if (totalFiles === 0) return undefined;
  return Object.freeze({
    files: Object.freeze(files),
    totalFiles,
    truncated: totalFiles > files.length,
  });
}

function unifiedDiffLineSummary(
  value: unknown,
): { readonly additions: number; readonly deletions: number } | undefined {
  if (typeof value !== "string") return undefined;
  let additions = 0;
  let deletions = 0;
  let remainingOld = 0;
  let remainingNew = 0;
  let sawHunk = false;
  let inHunk = false;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header !== null) {
      if (inHunk && (remainingOld !== 0 || remainingNew !== 0)) return undefined;
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      if (
        !Number.isSafeInteger(oldStart) ||
        !Number.isSafeInteger(newStart) ||
        !Number.isSafeInteger(oldCount) ||
        !Number.isSafeInteger(newCount)
      ) {
        return undefined;
      }
      remainingOld = oldCount;
      remainingNew = newCount;
      sawHunk = true;
      inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) return undefined;
    if (!inHunk) continue;
    if (remainingOld === 0 && remainingNew === 0) {
      inHunk = false;
      continue;
    }
    if (line === "\\ No newline at end of file") continue;
    switch (line[0]) {
      case " ":
        remainingOld -= 1;
        remainingNew -= 1;
        break;
      case "+":
        remainingNew -= 1;
        additions += 1;
        break;
      case "-":
        remainingOld -= 1;
        deletions += 1;
        break;
      default:
        return undefined;
    }
    if (remainingOld < 0 || remainingNew < 0) return undefined;
  }
  if (!sawHunk || remainingOld !== 0 || remainingNew !== 0) return undefined;
  return Object.freeze({ additions, deletions });
}

function readableToolName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240
    ? value
    : unknownToolName;
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumToolActivitySourceTypeCharacters &&
    !value.includes("\0")
  );
}

function fileChangeParameter(
  item: CorrelatedItem,
): RuntimeToolActivity["parameter"] | undefined {
  const direct = toolActivityParameter("path", item.path);
  if (direct !== undefined) return direct;
  if (!Array.isArray(item.changes)) return undefined;
  for (const change of item.changes) {
    if (!isRecord(change)) continue;
    const parameter = toolActivityParameter("path", change.path);
    if (parameter !== undefined) return parameter;
  }
  return undefined;
}

/**
 * A tool event may carry one command or path only. Recognizable command-line
 * credentials are visibly redacted before whitespace collapse and truncation.
 * Values over 120 Unicode code points retain the first 119 plus `…` and set
 * `truncated`; every other item field stays on the vendor side.
 */
function toolActivityParameter(
  kind: "command" | "path",
  value: unknown,
): RuntimeToolActivity["parameter"] | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = kind === "command" ? redactToolActivityCredentials(value) : value;
  const normalized = redacted.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return undefined;
  const characters = Array.from(normalized);
  if (characters.length <= maximumToolActivityParameterCharacters) {
    return Object.freeze({ kind, value: normalized, truncated: false });
  }
  return Object.freeze({
    kind,
    value: `${characters.slice(0, maximumToolActivityParameterCharacters - 1).join("")}…`,
    truncated: true,
  });
}

function progressKey(
  activity: RuntimeProgressActivity,
  tool: RuntimeToolActivity | undefined,
): string {
  if (tool === undefined) return activity;
  return [
    activity,
    tool.type,
    tool.sourceType ?? "",
    tool.name,
    tool.parameter?.kind ?? "",
    tool.parameter?.value ?? "",
    tool.parameter?.truncated === true ? "1" : "0",
    tool.fileChanges === undefined ? "" : JSON.stringify(tool.fileChanges),
  ].join("\0");
}
