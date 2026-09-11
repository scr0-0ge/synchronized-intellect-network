import { randomUUID } from "node:crypto";

import type {
  ControllableRuntimeBinding,
  NormalizedRuntimeEvent,
  RuntimeInterruptAvailability,
  RuntimeContextUsage,
  RuntimeSubscriptionUsageObserver,
  RuntimeSubscriptionUsageWindow,
  RuntimeUsageObserver,
  RuntimeUsageWindow,
  RuntimeInput,
  RuntimeProgressActivity,
  RuntimeToolActivity,
  RuntimeSteerAvailability,
  SessionProfile,
} from "../index.ts";
import { RuntimeAdapterError } from "../index.ts";
import { redactToolActivityCredentials } from "../tool-activity-redaction.ts";
import { isVendorRecord } from "../vendor-wire.ts";
import { productionClaudeDiagnosticObserver } from "./diagnostics.ts";
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
const maximumConsecutiveNonProtocolLines = 64;
const protocolTimeoutMilliseconds = 60_000;
const reportedNonProtocolOutput = new WeakSet<ClaudeCatalogTransport>();
const unknownToolName = "未知工具";
const maximumToolActivityParameterCharacters = 120;
const maximumPostResultFrames = 64;
const postResultTimeoutMilliseconds = 5_000;
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
  "rate_limit_event",
  "tool_progress",
  "tool_use_summary",
]);
const droppableAssistantBlockTypes = new Set([
  "redacted_thinking",
  "thinking",
  "tool_use",
]);

/**
 * Issue #6 case 4: the frames below used to vanish silently, so a retrying
 * or thinking turn looked identical to a dead one. They now surface as the
 * closed "progress" activity vocabulary. Public thinking text travels
 * separately as reasoning fragments; redacted blocks and signatures do not.
 * Consecutive repeats coalesce at this seam (the last emitted activity is
 * tracked in the event loop), so a chatty CLI cannot flood the durable
 * store with identical rows.
 */
const systemSubtypeProgressActivities: Readonly<
  Record<string, RuntimeProgressActivity>
> = Object.freeze({
  api_retry: "retrying",
  status: "status",
  thinking_tokens: "thinking",
  task_started: "tool",
  task_progress: "tool",
  task_updated: "tool",
  task_notification: "tool",
});

const droppableFrameProgressActivities: Readonly<
  Record<string, RuntimeProgressActivity>
> = Object.freeze({
  tool_progress: "tool",
  tool_use_summary: "tool",
  active_goal: "status",
});

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
  | "session-identity-missing"
  | "session-identity-mismatch"
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
      if (["user", "assistant", "result", "control_request", "stream_event"].includes(message.type as string)) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      continue;
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
      if (["user", "assistant", "result", "control_request", "stream_event"].includes(message.type as string)) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      continue;
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

export class ClaudeRuntimeBinding implements ControllableRuntimeBinding {
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
  readonly #endpointUrl: string | undefined;
  #controlAttempted = false;
  #sentInput: string | undefined;
  #eventsConsumed = false;
  #sessionStarted = false;
  #terminal = false;
  readonly #observeSubscriptionUsage: RuntimeSubscriptionUsageObserver | undefined;
  readonly #observeUsage: RuntimeUsageObserver | undefined;
  readonly #usageEndpointKey: string;
  #capabilities = new Set<string>();
  #sessionIdentity: string | undefined;
  #interruptConfirmed = false;
  #steerPending = false;
  #steerAwaitingContinuationInit = false;
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
    readonly observeSubscriptionUsage?: RuntimeSubscriptionUsageObserver;
    /** Provider-agnostic usage-window sink; runs alongside `observeSubscriptionUsage`, never in place of it. */
    readonly observeUsage?: RuntimeUsageObserver;
    /** Row identity for `observeUsage` observations. Composition supplies this per endpoint. */
    readonly usageEndpointKey?: string;
    readonly expectedSessionIdentity?: string;
    readonly providerRequestBudget?: ProviderRequestBudget;
    readonly permissionMode: ClaudePermissionMode;
    readonly requestToolPermission?: ClaudeToolPermissionHandler;
    readonly ultracodeConfirmed: boolean;
    /** Captured from the endpoint descriptor used for this process. */
    readonly endpointUrl?: string;
  }) {
    this.#transport = input.transport;
    this.#observeSubscriptionUsage = input.observeSubscriptionUsage;
    this.#observeUsage = input.observeUsage;
    this.#usageEndpointKey = input.usageEndpointKey ?? "unknown";
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
    this.#endpointUrl = input.endpointUrl;
  }

  /** Initiate shutdown even when the event generator has never been started. */
  close(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#rejectInterrupt(new RuntimeAdapterError("runtime-shutdown"));
    void this.#transport.stop().catch(() => {
      // Shutdown was requested, not confirmed; provider details remain private.
    });
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
    const availability = this.interruptAvailability();
    if (availability !== "available") {
      throw new RuntimeAdapterError(
        availability === "unsupported" ? "unsupported-selection" : "invalid-input",
      );
    }
    await this.#requestInterrupt();
  }

  async steer(input: RuntimeInput): Promise<void> {
    if (!isRuntimeInput(input)) {
      throw new RuntimeAdapterError("invalid-input");
    }
    const availability = this.steerAvailability();
    if (availability !== "available") {
      throw new RuntimeAdapterError(
        availability === "unsupported" ? "unsupported-selection" : "invalid-input",
      );
    }
    const sessionIdentity = this.#sessionIdentity;
    if (sessionIdentity === undefined) {
      throw new RuntimeAdapterError("invalid-input");
    }
    this.#steerPending = true;
    try {
      await this.#requestInterrupt();
      await write(this.#transport, {
        type: "user",
        session_id: sessionIdentity,
        message: {
          role: "user",
          content: [{ type: "text", text: input.text }],
        },
        parent_tool_use_id: null,
      });
    } catch (error) {
      this.#steerPending = false;
      this.#steerAwaitingContinuationInit = false;
      throw error;
    }
  }

  steerAvailability(): RuntimeSteerAvailability {
    const interruptAvailability = this.#controlAvailability();
    if (interruptAvailability !== "available") return interruptAvailability;
    return this.#interruptPending === undefined && !this.#steerPending
      ? "available"
      : "unavailable";
  }

  async #requestInterrupt(): Promise<void> {
    this.#controlAttempted = true;
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
    const availability = this.#controlAvailability();
    if (availability !== "available") return availability;
    return this.#interruptPending === undefined && !this.#steerPending
      ? "available"
      : "unavailable";
  }

  #controlAvailability(): RuntimeInterruptAvailability {
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
    return "available";
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
    let lastProgressKey: string | undefined;
    let lastProgressActivity: RuntimeProgressActivity | undefined;
    let unknownNotificationReported = false;
    let unrelatedControlResponseReported = false;
    let currentMessage: Record<string, unknown> | undefined;
    let frameNumber = 0;
    const yieldableProgress = (
      activity: RuntimeProgressActivity,
      tool?: RuntimeToolActivity,
    ): NormalizedRuntimeEvent | undefined => {
      const key = progressKey(activity, tool);
      if (key === lastProgressKey) return undefined;
      lastProgressKey = key;
      lastProgressActivity = activity;
      return Object.freeze({
        kind: "progress" as const,
        activity,
        ...(tool === undefined ? {} : { tool }),
      });
    };
    let initialQuotaRefusal = true;
    let quotaRefusalText: string | undefined;
    // Most recent first-party rate_limit_event window resets, kept for the one
    // quota-exhausted yield below; unrelated to the GLM text path.
    let lastRateLimitWindowResetsAt: number | undefined;
    const reasoning = new ClaudeReasoningStream();
    let pendingTextEmitted = false;
    const promptSuggestions: string[] = [];
    const pendingMessage = (): NormalizedRuntimeEvent[] => {
      if (finalText === undefined || pendingTextEmitted) return [];
      pendingTextEmitted = true;
      return [{ kind: "agent-message", text: finalText }];
    };

    try {
      while (true) {
        const message = await read(this.#transport);
        currentMessage = message;
        frameNumber += 1;
        // Only the complete captured initial-refusal sequence establishes that
        // nothing ran. Other supported output still follows its normal parser,
        // but cannot later be reclassified as a safe quota pause.
        if (message.type !== "system" || message.subtype !== "init") {
          const rejection = initialQuotaRefusal && sessionStarted && quotaRefusalText === undefined
            ? initialGlmQuotaRefusalText(message, this.#endpointUrl) : undefined;
          if (rejection !== undefined) quotaRefusalText = rejection;
          else if (message.type !== "result") initialQuotaRefusal = false;
        }
        if (message.type === "system") {
          if (message.subtype !== "init") {
            if (
              !sessionStarted ||
              !isSafeIdentity(message.subtype)
            ) {
              throw new RuntimeAdapterError("protocol-invalid");
            }
            if (droppableSystemSubtypes.has(message.subtype) || message.session_id !== undefined) {
              assertSession(message, sessionIdentity);
            }
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
            const systemActivity = Object.hasOwn(systemSubtypeProgressActivities, message.subtype)
              ? systemSubtypeProgressActivities[message.subtype]
              : undefined;
            if (systemActivity !== undefined) {
              const progress = yieldableProgress(
                systemActivity,
                systemActivity === "tool"
                  ? unknownToolActivity(message.subtype)
                  : undefined,
              );
              if (progress !== undefined) yield progress;
            }
            continue;
          }
          if (sessionStarted) {
            // Native steer keeps this process and Session alive: the aborted
            // leg is followed by a second init before the corrected leg.
            if (!this.#steerAwaitingContinuationInit) {
              throw new RuntimeAdapterError("protocol-invalid");
            }
            assertSession(message, sessionIdentity);
            if (
              message.model !== this.#expectedModel ||
              !matchesClaudePermissionMode(
                message.permissionMode,
                this.#permissionMode,
              )
            ) {
              throw new RuntimeAdapterError("unsupported-selection");
            }
            this.#capabilities = readSessionCapabilities(message.capabilities);
            this.#steerAwaitingContinuationInit = false;
            this.#steerPending = false;
            this.#interruptConfirmed = false;
            interruptMarkerSeen = false;
            effectiveEffortObserved = false;
            reasoning.beginContinuation();
            continue;
          }
          if (
            !isSafeIdentity(message.session_id) ||
            (this.#expectedSessionIdentity !== undefined &&
              message.session_id !== this.#expectedSessionIdentity) ||
            message.model !== this.#expectedModel ||
            !matchesClaudePermissionMode(
              message.permissionMode,
              this.#permissionMode,
            )
          ) {
            throw new RuntimeAdapterError("unsupported-selection");
          }
          sessionIdentity = message.session_id;
          this.#sessionIdentity = sessionIdentity;
          this.#capabilities = readSessionCapabilities(message.capabilities);
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
        if (message.type === "stream_event") {
          if (!turnStarted) throw new RuntimeAdapterError("correlation-invalid");
          assertSession(message, sessionIdentity);
          // Subagent partials are not the selected Session's output.
          if (message.parent_tool_use_id !== null) continue;
          const fragments = reasoning.stream(record(message.event, "protocol-invalid"));
          if (fragments.length > 0) {
            yield* pendingMessage();
            const progress = yieldableProgress("thinking");
            if (progress !== undefined) yield progress;
            for (const text of fragments) yield { kind: "reasoning", text };
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
          const fragments = reasoning.assistant(message.message as Record<string, unknown>);
          if (fragments.length > 0 || candidate !== undefined) yield* pendingMessage();
          // A frame whose blocks are all thinking/tool_use says the turn is
          // alive before any text exists (issue #6 case 4); the final-text
          // candidate below is unaffected because text blocks never map to
          // an activity.
          for (const frameProgress of assistantFrameProgress(message)) {
            const progress = yieldableProgress(
              frameProgress.activity,
              frameProgress.tool,
            );
            if (progress !== undefined) yield progress;
          }
          for (const text of fragments) yield { kind: "reasoning", text };
          if (candidate !== undefined) {
            finalText = candidate;
            pendingTextEmitted = false;
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
          // "default" tier means effort was deliberately not pinned (no
          // --effort on the CLI command line). The CLI's Stop hook always
          // reports a concrete level — its internal default — never an
          // absent effort, so a literal echo equality can never hold for
          // this tier. Tolerate whatever effective level the CLI resolved
          // (only the GLM static catalog offers a "default" tier today).
          const effortEchoTolerated =
            this.profile.effortLevel === "default";
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
            (!effortEchoTolerated &&
              effectiveEffortLevel !== this.profile.effortLevel) ||
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
          // The CLI can replay our replies to its Stop/permission callbacks.
          // Only our outstanding interrupt request owns an interrupt receipt.
          if (pending === undefined || response.request_id !== pending.requestId) {
            if (!unrelatedControlResponseReported) {
              unrelatedControlResponseReported = true;
              productionClaudeDiagnosticObserver({
                kind: "optional-data-unavailable",
                category: "correlation-invalid",
                gate: "control-response",
                row: null,
                detail: correlationDiagnosticDetail(message, frameNumber, sessionIdentity, pending?.requestId),
              });
            }
            continue;
          }
          const payload = record(response.response, "protocol-invalid");
          if (
            response.subtype !== "success" ||
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
        if (message.type === "prompt_suggestion") {
          appendPromptSuggestion(
            promptSuggestions,
            readPromptSuggestion(message, sessionIdentity),
          );
          continue;
        }
        if (message.type === "result") {
          assertSession(message, sessionIdentity);
          if (initialQuotaRefusal && !this.#controlAttempted && quotaRefusalText !== undefined &&
              message.subtype === "success" && message.is_error === true &&
              message.terminal_reason === "api_error" && message.api_error_status === 429 &&
              message.result === quotaRefusalText && message.num_turns === 1 && message.queued_turn_count === 0 &&
              zeroQuotaUsage(message.usage)) {
            await this.#transport.stop();
            terminal = true;
            this.#terminal = true;
            const textResetsAt = glmQuotaRefusalResetsAt(quotaRefusalText);
            const resetsAt = textResetsAt ?? lastRateLimitWindowResetsAt;
            if (this.#observeUsage !== undefined && textResetsAt !== undefined) {
              const usageObservation = Object.freeze({
                endpointKey: this.#usageEndpointKey,
                windows: Object.freeze([
                  Object.freeze({ label: "quota-window" as const, resetsAt: textResetsAt }),
                ]),
                observedAt: Date.now(),
                source: "exhaustion-message" as const,
              });
              try { await this.#observeUsage(usageObservation); } catch {
                // Unavailable settings storage must not fail a healthy turn.
              }
            }
            yield resetsAt === undefined
              ? { kind: "turn-paused", reason: "quota-exhausted" }
              : { kind: "turn-paused", reason: "quota-exhausted", resetsAt };
            return;
          }
          // A steer has two results on the wire. The first closes only the
          // interrupted leg; the corrected leg supplies the binding terminal.
          if (
            this.#steerPending &&
            this.#interruptConfirmed &&
            message.subtype === "error_during_execution" &&
            message.is_error === true &&
            (message.terminal_reason === "aborted_streaming" ||
              message.terminal_reason === "aborted_tools")
          ) {
            this.#steerAwaitingContinuationInit = true;
            continue;
          }
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
            // A confirmed interrupt receipt is durable positive evidence that
            // the Runtime accepted the stop. A result that matches neither the
            // strict interrupted shape above nor the completed contract is
            // wire-spelling drift on the interrupted path (a terminal_reason
            // this build has not seen, or a Stop-hook echo that never fires
            // because the turn died mid-stream). Demoting it to `turn-failed`
            // would report a fixed failure and end the whole Session for a
            // stop the user asked for; the honest classification is
            // "interrupted" — the runtime stopped, recorded work is kept, and
            // the Session stays continuable. Without the receipt, the
            // fail-closed `turn-failed` below is unchanged.
            if (this.#interruptConfirmed) {
              await this.#transport.stop();
              terminal = true;
              this.#terminal = true;
              yield Object.freeze({
                kind: "turn-interrupted" as const,
                status: "interrupted" as const,
              });
              return;
            }
            throw new RuntimeAdapterError("turn-failed");
          }
          let context: RuntimeContextUsage | undefined;
          try {
            context = readResultContextUsage(message.usage);
          } catch (error) {
            if (!(error instanceof RuntimeAdapterError) || error.category !== "protocol-invalid") {
              throw error;
            }
            // Usage is optional telemetry, not completion evidence. Keep its
            // strict parser and discard the entire invalid projection; never
            // invent a count or lose an otherwise verified completed turn.
            productionClaudeDiagnosticObserver({
              kind: "optional-data-unavailable",
              category: "protocol-invalid",
              gate: "context-usage",
              row: null,
            });
          }
          await collectPostResultPromptSuggestions(
            this.#transport,
            sessionIdentity,
            promptSuggestions,
          );
          await this.#transport.stop();
          terminal = true;
          this.#terminal = true;
          // A completed turn is not proof that an outstanding stop was accepted.
          // Settle that caller as unconfirmed rather than leaving it hanging.
          this.#rejectInterrupt(new RuntimeAdapterError("correlation-invalid"));
          yield Object.freeze({
            kind: "item-completed" as const,
            itemType: "agent-message" as const,
          });
          yield* pendingMessage();
          yield Object.freeze({
            kind: "turn-completed" as const,
            status: "completed" as const,
            ...(context === undefined ? {} : { context }),
            ...(promptSuggestions.length === 0
              ? {}
              : { suggestions: Object.freeze([...promptSuggestions]) }),
          });
          return;
        }
        if (droppableFrameTypes.has(String(message.type))) {
          if (!sessionStarted) {
            throw new RuntimeAdapterError("correlation-invalid");
          }
          assertSession(message, sessionIdentity);
          let frameActivity: RuntimeProgressActivity | undefined =
            droppableFrameProgressActivities[String(message.type)];
          if (message.type === "rate_limit_event") {
            const info = message.rate_limit_info;
            const status = isPlainRecord(info) ? info.status : undefined;
            const windows = isPlainRecord(info) && isPlainRecord(info.unifiedWindows)
              ? info.unifiedWindows : undefined;
            const fiveHourWindow = readSubscriptionWindow(windows?.five_hour);
            const sevenDayWindow = readSubscriptionWindow(windows?.seven_day);
            // Optional telemetry stays off the turn-state/Project event lane.
            // Composition attaches this observer only to the first-party endpoint.
            if (this.#observeSubscriptionUsage !== undefined) {
              const observation = Object.freeze({
                five_hour: fiveHourWindow,
                seven_day: sevenDayWindow,
                observedAt: Date.now(),
              });
              try { await this.#observeSubscriptionUsage(observation); } catch {
                // Unavailable settings storage must not fail a healthy turn.
              }
            }
            if (this.#observeUsage !== undefined) {
              const windows: RuntimeUsageWindow[] = [];
              if (fiveHourWindow !== null) {
                windows.push({ label: "five-hour", utilization: fiveHourWindow.utilization, resetsAt: fiveHourWindow.resetsAt * 1000 });
              }
              if (sevenDayWindow !== null) {
                windows.push({ label: "seven-day", utilization: sevenDayWindow.utilization, resetsAt: sevenDayWindow.resetsAt * 1000 });
              }
              const usageObservation = Object.freeze({
                endpointKey: this.#usageEndpointKey,
                windows: Object.freeze(windows),
                observedAt: Date.now(),
                source: "rate-limit-event" as const,
              });
              try { await this.#observeUsage(usageObservation); } catch {
                // Unavailable settings storage must not fail a healthy turn.
              }
            }
            // The window that actually triggered names itself in rateLimitType.
            // When that isn't resolvable, take the earlier reset of the two
            // known windows rather than guess which one applies.
            const triggeredWindow = isPlainRecord(info) && info.rateLimitType === "five_hour"
              ? fiveHourWindow
              : isPlainRecord(info) && info.rateLimitType === "seven_day"
                ? sevenDayWindow
                : undefined;
            const knownWindows = [fiveHourWindow, sevenDayWindow].filter(
              (window): window is RuntimeSubscriptionUsageWindow => window !== null,
            );
            const windowResetsAt = triggeredWindow?.resetsAt ??
              (knownWindows.length === 0 ? undefined : Math.min(...knownWindows.map((window) => window.resetsAt)));
            // Provider epoch seconds; the quota-pause event carries milliseconds.
            if (windowResetsAt !== undefined) lastRateLimitWindowResetsAt = windowResetsAt * 1000;
            // This is quota telemetry, not a retry/wait instruction. An
            // allowed request can still have overageStatus="rejected".
            // Unknown optional telemetry cannot establish a blocked state.
            frameActivity = status === "rejected"
              ? "rate-limited"
              : lastProgressActivity === "rate-limited" &&
                  (status === "allowed" || status === "allowed_warning")
                ? "status"
                : undefined;
          }
          if (frameActivity !== undefined) {
            const progress = yieldableProgress(
              frameActivity,
              frameActivity === "tool"
                ? unknownToolActivity(String(message.type))
                : undefined,
            );
            if (progress !== undefined) yield progress;
          }
          continue;
        }
        // Unconsumed notification types carry no product event. Known control,
        // result, and message types above still validate all consumed fields.
        if (message.session_id !== undefined) assertSession(message, sessionIdentity);
        if (!unknownNotificationReported) {
          unknownNotificationReported = true;
          productionClaudeDiagnosticObserver({
            kind: "optional-data-unavailable",
            category: "protocol-invalid",
            gate: "notification",
            row: null,
          });
        }
      }
    } catch (error) {
      if (error instanceof RuntimeAdapterError && error.category === "correlation-invalid") {
        productionClaudeDiagnosticObserver({
          kind: "correlation-rejected",
          category: error.category,
          gate: "session-frame",
          row: frameNumber,
          detail: correlationDiagnosticDetail(currentMessage, frameNumber, sessionIdentity, this.#interruptPending?.requestId,
            error instanceof ClaudeCorrelationError ? error.discriminator : "unclassified-correlation"),
        });
      }
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
      !isVendorRecord(message, ["request", "request_id", "type"]) ||
      !isVendorRecord(request, ["input", "subtype", "tool_name", "tool_use_id"]) ||
      !isSafeIdentity(requestId) ||
      !isSafeIdentity(request.tool_name) ||
      !isSafeIdentity(request.tool_use_id) ||
      (request.agent_id !== undefined && !isSafeIdentity(request.agent_id)) ||
      !isOptionalSafeDisplayText(request.blocked_path) ||
      !isOptionalSafeDisplayText(request.decision_reason) ||
      !isOptionalSafeDisplayText(request.description) ||
      !isOptionalSafeDisplayText(request.display_name) ||
      !isOptionalSafeDisplayText(request.title)
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

function zeroQuotaUsage(value: unknown): boolean {
  return isPlainRecord(value) && ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .every(key => value[key] === 0);
}

function initialGlmQuotaRefusalText(message: Record<string, unknown>, endpointUrl: string | undefined): string | undefined {
  if (endpointUrl?.replace(/\/$/u, "") !== "https://open.bigmodel.cn/api/anthropic" ||
      message.type !== "assistant" || message.parent_tool_use_id !== null ||
      message.error !== "rate_limit" || message.is_api_error_message !== true ||
      !isPlainRecord(message.message) || message.message.role !== "assistant" ||
      message.message.model !== "<synthetic>" || !zeroQuotaUsage(message.message.usage) ||
      !Array.isArray(message.message.content) || message.message.content.length !== 1) return undefined;
  const block = message.message.content[0];
  return isPlainRecord(block) && block.type === "text" && typeof block.text === "string" &&
    /^API Error: Request rejected \(429\) · \[1310\]\[[^\]\r\n]+\]\[[^\]\r\n]+\]$/u.test(block.text)
    ? block.text : undefined;
}

/** GLM's 429 text names no timezone; only a literal UTC reading is parsed, never guessed. */
function glmQuotaRefusalResetsAt(text: string): number | undefined {
  const match = /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u.exec(text);
  if (match === null) return undefined;
  const parsed = Date.parse(`${match[1].replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  let skipped = 0;
  while (true) {
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
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      skipped += 1;
      if (skipped > maximumConsecutiveNonProtocolLines) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      if (!reportedNonProtocolOutput.has(transport)) {
        reportedNonProtocolOutput.add(transport);
        reportClaudeDiagnostic(
          "Claude CLI stdout carried output that is not protocol JSON; " +
            "those lines are ignored and the operation continues.",
        );
      }
      continue;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (!isVendorRecord(message, ["type"]) || !isSafeIdentity(message.type)) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    return message;
  }
}

function reportClaudeDiagnostic(message: string): void {
  try {
    process.stderr.write("[claude-cli] " + message + "\n");
  } catch {
    // Losing diagnostics must not change the outcome of a Runtime operation.
  }
}

async function collectPostResultPromptSuggestions(
  transport: ClaudeCatalogTransport,
  sessionIdentity: string | undefined,
  suggestions: string[],
): Promise<void> {
  const finishInput = transport.finishInput;
  if (finishInput === undefined) return;
  try {
    finishInput.call(transport);
  } catch {
    return;
  }
  const deadline = Date.now() + postResultTimeoutMilliseconds;
  for (let index = 0; index < maximumPostResultFrames; index += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const line = await receiveOptionalPostResultLine(transport, remaining);
    if (line === null) return;
    const message = parseOptionalPostResultLine(line);
    if (message === undefined || message.type !== "prompt_suggestion") continue;
    appendPromptSuggestion(
      suggestions,
      readPromptSuggestion(message, sessionIdentity),
    );
  }
}

async function receiveOptionalPostResultLine(
  transport: ClaudeCatalogTransport,
  timeoutMilliseconds: number,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      transport.receive(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMilliseconds);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseOptionalPostResultLine(
  line: string,
): Record<string, unknown> | undefined {
  if (line.length > maximumProtocolLineLength) return undefined;
  try {
    const message: unknown = JSON.parse(line);
    return isPlainRecord(message) && isSafeIdentity(message.type)
      ? message
      : undefined;
  } catch {
    return undefined;
  }
}

function readPromptSuggestion(
  message: Record<string, unknown>,
  sessionIdentity: string | undefined,
): string | undefined {
  return sessionIdentity !== undefined &&
      message.session_id === sessionIdentity &&
      isSafePromptSuggestion(message.suggestion)
    ? message.suggestion
    : undefined;
}

function appendPromptSuggestion(
  suggestions: string[],
  suggestion: string | undefined,
): void {
  if (suggestion !== undefined && !suggestions.includes(suggestion)) {
    suggestions.push(suggestion);
  }
}

function assertSession(
  message: Record<string, unknown>,
  sessionIdentity: string | undefined,
): void {
  if (sessionIdentity === undefined) {
    throw new ClaudeCorrelationError("session-identity-missing");
  }
  // One owned process supplies this stream. An omitted echo is not a second Session.
  if (message.session_id !== undefined && message.session_id !== sessionIdentity) {
    throw new ClaudeCorrelationError("session-identity-mismatch");
  }
}

function correlationDiagnosticDetail(
  message: Record<string, unknown> | undefined,
  frameNumber: number,
  sessionIdentity: string | undefined,
  requestId: string | undefined,
  reason?: ClaudeCorrelationFailureDiscriminator,
): string {
  const response = message?.response;
  const event = message?.event;
  // Native ids stay in the existing bounded private log, never the UI or stderr summary.
  return JSON.stringify({
    frameNumber,
    frameType: message?.type ?? null,
    frameSubtype: message?.subtype ?? null,
    streamEventType: isPlainRecord(event) ? event.type : null,
    expectedSessionId: sessionIdentity ?? null,
    receivedSessionId: message?.session_id ?? null,
    sessionIdPresent: message !== undefined && Object.hasOwn(message, "session_id"),
    expectedRequestId: requestId ?? null,
    receivedRequestId: isPlainRecord(response) ? response.request_id ?? null : message?.request_id ?? null,
    ...(reason === undefined ? {} : { reason }),
  });
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
    !isVendorRecord(message, [
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
    !isVendorRecord(message.message, ["content", "role"]) ||
    message.message.role !== "user" ||
    !Array.isArray(message.message.content) ||
    message.message.content.length !== 1 ||
    !isPlainRecord(message.message.content[0]) ||
    !isVendorRecord(message.message.content[0], ["text", "type"]) ||
    typeof message.message.content[0].text !== "string" ||
    typeof message.message.content[0].type !== "string"
  ) {
    return false;
  }
  return true;
}

/**
 * Each assistant block can establish distinct progress. Keeping the tool
 * blocks separate means Read -> Edit is not coalesced into one static generic
 * tool note; text-only blocks still establish no activity at all.
 */
function assistantFrameProgress(
  message: Record<string, unknown>,
): readonly Readonly<{
  activity: RuntimeProgressActivity;
  tool?: RuntimeToolActivity;
}>[] {
  if (!isPlainRecord(message.message)) return [];
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const progress: Array<{
    activity: RuntimeProgressActivity;
    tool?: RuntimeToolActivity;
  }> = [];
  for (const block of content) {
    if (!isPlainRecord(block)) continue;
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      progress.push({ activity: "thinking" });
    } else if (block.type === "tool_use") {
      progress.push({ activity: "tool", tool: claudeToolActivity(block) });
    } else if (isToolLikeUnknownBlock(block)) {
      progress.push({
        activity: "tool",
        tool: unknownToolActivity(block.type as string, block.name, block.input),
      });
    }
  }
  return progress;
}

function claudeToolActivity(block: Record<string, unknown>): RuntimeToolActivity {
  const name = isSafeIdentity(block.name) ? block.name : unknownToolName;
  const parameter = toolActivityParameter(block.input);
  return Object.freeze({
    type: "tool_use" as const,
    name,
    ...(parameter === undefined ? {} : { parameter }),
  });
}

function isToolLikeUnknownBlock(block: Record<string, unknown>): boolean {
  return (
    isSafeIdentity(block.type) &&
    isSafeIdentity(block.id) &&
    (Object.hasOwn(block, "name") || Object.hasOwn(block, "input"))
  );
}

function unknownToolActivity(
  sourceType: string,
  name?: unknown,
  input?: unknown,
): RuntimeToolActivity {
  const parameter = toolActivityParameter(input);
  return Object.freeze({
    type: "unknown" as const,
    sourceType,
    name: isSafeIdentity(name) ? name : unknownToolName,
    ...(parameter === undefined ? {} : { parameter }),
  });
}

/**
 * Only command and file-path fields cross this seam. Recognizable command-line
 * credentials are visibly redacted before whitespace collapse and truncation.
 * Values over 120 Unicode code points retain the first 119 plus `…` and set
 * `truncated`; no other input key is read or forwarded.
 */
function toolActivityParameter(
  input: unknown,
): RuntimeToolActivity["parameter"] | undefined {
  if (!isPlainRecord(input)) return undefined;
  const candidates: readonly ["command" | "path", unknown][] = [
    ["command", input.command],
    ["path", input.path],
    ["path", input.file_path],
    ["path", input.filePath],
  ];
  for (const [kind, value] of candidates) {
    if (typeof value !== "string") continue;
    const redacted = kind === "command" ? redactToolActivityCredentials(value) : value;
    const normalized = redacted.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0) continue;
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
  return undefined;
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
  ].join("\0");
}

/** Tracks only public thinking. Full assistant echoes contribute only the suffix
 * not already emitted by partials. Neither signatures nor redacted data enter it. */
class ClaudeReasoningStream {
  private active: { id: string; blocks: Map<number, string> } | undefined;
  private readonly emitted = new Map<string, Map<number, string>>();
  private hasText = false;

  beginContinuation(): void {
    this.active = undefined;
    this.emitted.clear();
  }

  stream(event: Record<string, unknown>): string[] {
    if (!isVendorRecord(event, ["type"]) || !isSafeIdentity(event.type)) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (!["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop"].includes(event.type)) return [];
    if (event.type === "message_start") {
      const message = record(event.message, "protocol-invalid");
      if (this.active || !isSafeIdentity(message.id) || message.role !== "assistant" || this.emitted.has(message.id)) {
        throw new RuntimeAdapterError("correlation-invalid");
      }
      this.active = { id: message.id, blocks: new Map() };
      this.emitted.set(message.id, new Map());
      return [];
    }
    const active = this.active;
    if (!active) throw new RuntimeAdapterError("correlation-invalid");
    if (event.type === "message_delta") return [];
    if (event.type === "message_stop") {
      this.active = undefined;
      return [];
    }
    if (!Number.isSafeInteger(event.index) || (event.index as number) < 0) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    const index = event.index as number;
    if (event.type === "content_block_start") {
      const block = record(event.content_block, "protocol-invalid");
      if (active.blocks.has(index) || !isVendorRecord(block, ["type"]) || !isSafeIdentity(block.type)) {
        throw new RuntimeAdapterError("protocol-invalid");
      }
      active.blocks.set(index, ["thinking", "redacted_thinking", "text", "tool_use"].includes(block.type) ? block.type : "ignored");
      if (block.type !== "thinking") return [];
      if (typeof block.thinking !== "string") throw new RuntimeAdapterError("protocol-invalid");
      return this.append(active.id, index, block.thinking);
    }
    const type = active.blocks.get(index);
    if (type === undefined || type === "stopped") throw new RuntimeAdapterError("correlation-invalid");
    if (event.type === "content_block_stop") {
      active.blocks.set(index, "stopped");
      return [];
    }
    if (event.type !== "content_block_delta") throw new RuntimeAdapterError("protocol-invalid");
    const delta = record(event.delta, "protocol-invalid");
    if (!isVendorRecord(delta, ["type"]) || !isSafeIdentity(delta.type)) {
      throw new RuntimeAdapterError("protocol-invalid");
    }
    if (delta.type === "thinking_delta" && type === "thinking") {
      if (typeof delta.thinking !== "string") throw new RuntimeAdapterError("protocol-invalid");
      return this.append(active.id, index, delta.thinking);
    }
    // Vendor-redacted content is discarded even if a frame puts prose in it.
    if (type === "redacted_thinking" || type === "ignored") return [];
    if ((delta.type === "signature_delta" && type === "thinking") ||
        (delta.type === "text_delta" && type === "text") ||
        (delta.type === "citations_delta" && type === "text") ||
        (delta.type === "input_json_delta" && type === "tool_use")) return [];
    if (!["thinking_delta", "signature_delta", "text_delta", "citations_delta", "input_json_delta"].includes(delta.type)) return [];
    throw new RuntimeAdapterError("protocol-invalid");
  }

  assistant(message: Record<string, unknown>): string[] {
    const emitted = typeof message.id === "string" ? this.emitted.get(message.id) : undefined;
    const fragments: string[] = [];
    for (const [index, block] of (message.content as Record<string, unknown>[]).entries()) {
      if (block.type !== "thinking") continue;
      const text = block.thinking as string;
      const prefix = emitted?.get(index) ?? "";
      if (!text.startsWith(prefix)) throw new RuntimeAdapterError("correlation-invalid");
      const suffix = text.slice(prefix.length);
      if (suffix.length) fragments.push(this.separate(suffix, prefix.length === 0));
    }
    if (typeof message.id === "string") this.emitted.delete(message.id);
    return fragments;
  }

  private append(id: string, index: number, text: string): string[] {
    if (!text.length) return [];
    const blocks = this.emitted.get(id)!;
    const prefix = blocks.get(index) ?? "";
    blocks.set(index, prefix + text);
    return [this.separate(text, prefix.length === 0)];
  }

  private separate(text: string, firstInBlock: boolean): string {
    const prefix = firstInBlock && this.hasText ? "\n\n" : "";
    this.hasText = true;
    return prefix + text;
  }
}

function assistantText(message: Record<string, unknown>): string | undefined {
  if (!isVendorRecord(message.message, ["role", "content"]) || message.message.role !== "assistant") {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const content = message.message.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new RuntimeAdapterError("protocol-invalid");
  }
  const text: string[] = [];
  for (const block of content) {
    if (!isVendorRecord(block, ["type"]) || !isSafeIdentity(block.type)) {
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
  if (!droppableAssistantBlockTypes.has(String(block.type))) return true;
  if (block.type === "thinking") {
    return (
      typeof block.thinking === "string" && typeof block.signature === "string"
    );
  }
  if (block.type === "redacted_thinking") {
    return typeof block.data === "string";
  }
  // The progress surface has an honest fallback for a missing/changed tool
  // name and simply omits an unusable input summary. An id still establishes
  // that this is a tool-use block rather than arbitrary assistant content.
  return isSafeIdentity(block.id);
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

function readSessionCapabilities(value: unknown): Set<string> {
  // An unfamiliar capability shape grants nothing. Do not infer support from
  // object keys, truthy values, or the valid subset of a malformed array.
  const valid = isStringArray(value);
  const capabilities = new Set<string>(valid ? value : []);
  if (
    !capabilities.has("interrupt_receipt_v1") ||
    !capabilities.has("interrupt_cancel_queued_v1")
  ) {
    productionClaudeDiagnosticObserver({
      kind: "optional-data-unavailable",
      category: value === undefined || valid ? "runtime-unavailable" : "protocol-invalid",
      gate: "interrupt-and-steer",
      row: null,
    });
  }
  return capabilities;
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
  if (
    !isVendorRecord(value, requiredKeys) ||
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

function isSafePromptSuggestion(value: unknown): value is string {
  if (
    !isSafeDisplayText(value) ||
    value.trim().length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
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

function readSubscriptionWindow(value: unknown): RuntimeSubscriptionUsageWindow | null {
  if (!isPlainRecord(value) || typeof value.utilization !== "number" ||
      !Number.isFinite(value.utilization) || value.utilization < 0 || value.utilization > 1 ||
      !Number.isSafeInteger(value.resetsAt) || (value.resetsAt as number) <= 0 ||
      (value.resetsAt as number) > 8_640_000_000_000) return null;
  return Object.freeze({ utilization: value.utilization, resetsAt: value.resetsAt as number });
}
