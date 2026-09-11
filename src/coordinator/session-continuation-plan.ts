import { randomUUID } from "node:crypto";

import type {
  CommandReceipt,
  DirectProjectCommand,
  ProjectChannel,
  ProjectCommandRuntimeContext,
} from "./types.ts";

export const SESSION_CONTINUATION_MAX_STEPS = 10;

export interface SessionContinuationPlanRequest {
  readonly steps: number;
  readonly input: string;
}

/** Product-owned stop, separate from the last Runtime turn's outcome. */
export interface SessionContinuationStop {
  readonly step: number;
  readonly limit: number;
  readonly reason: "turn-not-completed" | "continuation-unavailable" | "observation-unavailable" | "submission-unavailable" | "interrupted-by-user";
}

/** Which step of the bounded plan is currently running; absent once stopped or done. */
export interface SessionContinuationProgress {
  readonly step: number;
  readonly limit: number;
}

/** Undefined is ordinary composer text; null is an invalid explicit plan. */
export function parseSessionContinuationPlan(input: string): SessionContinuationPlanRequest | null | undefined {
  if (!/^\/auto-continue(?:\s|$)/u.test(input)) return undefined;
  const match = /^\/auto-continue ([1-9]\d*)\r?\n([\s\S]+)$/u.exec(input);
  if (!match || Number(match[1]) > SESSION_CONTINUATION_MAX_STEPS || !match[2]!.trim()) return null;
  return Object.freeze({ steps: Number(match[1]), input: match[2]! });
}

/** The Runtime always receives the plan's instruction verbatim; step/limit are product-side observation data, never prompt text. */
export function sessionContinuationStepInput(plan: SessionContinuationPlanRequest, _step: number): string {
  return plan.input;
}

/** One explicit, bounded plan per open Project; reopening history never arms it. */
export function createSessionContinuationPlan(
  channel: ProjectChannel,
  reportStop?: (commandId: string, stop: SessionContinuationStop) => void,
  reportProgress?: (commandId: string, progress: SessionContinuationProgress) => void,
) {
  let generation = 0;
  let closing = false;
  let cancelObserver: (() => void) | undefined;
  // Belongs to whichever follow() is current; reused so a user-initiated
  // cancel can report through the same path a natural stop would take.
  let activeStop: ((reason: SessionContinuationStop["reason"]) => void) | undefined;
  const runs = new Set<Promise<void>>();

  /** Pass "interrupted-by-user" only for a real user action; a plan replacement or close must stay silent. */
  function cancel(reason?: "interrupted-by-user"): number {
    if (reason !== undefined) activeStop?.(reason);
    generation += 1;
    cancelObserver?.();
    cancelObserver = undefined;
    return generation;
  }

  async function follow(
    first: CommandReceipt,
    command: DirectProjectCommand,
    runtimeContext: ProjectCommandRuntimeContext | undefined,
    plan: SessionContinuationPlanRequest,
    intent: number,
  ): Promise<void> {
    const iterator = channel.observe({ after: first.acceptedCursor })[Symbol.asyncIterator]();
    cancelObserver = () => { void iterator.return?.().catch(() => undefined); };
    let current = first;
    let step = 1;
    let unavailableReason: SessionContinuationStop["reason"] = "observation-unavailable";
    const active = () => !closing && generation === intent;
    const stop = (reason: SessionContinuationStop["reason"]) => {
      if (!active()) return;
      const stopped = Object.freeze({ step, limit: plan.steps, reason });
      reportStop?.(current.commandId, stopped);
      channel.recordContinuationStop?.(current.commandId, stopped);
      console.warn("[coordinator] Automatic continuation stopped", stopped);
    };
    activeStop = stop;
    try {
      while (active()) {
        unavailableReason = "observation-unavailable";
        const next = await iterator.next();
        if (!active()) return;
        if (next.done) { stop("observation-unavailable"); return; }
        const update = next.value;
        if (update.commandId !== current.commandId ||
            update.status === "accepted" || update.status === "in-flight") continue;
        if (update.status !== "completed") {
          stop(update.kind === "failed" && update.failureCategory === "interrupted"
            ? "interrupted-by-user" : "turn-not-completed");
          return;
        }
        if (step === plan.steps) return;
        const snapshot = await channel.snapshot();
        if (!active()) return;
        const completed = snapshot.commands.find((entry) => entry.commandId === current.commandId);
        if (completed?.status !== "completed" || completed.recovery !== undefined || !completed.session?.resumable) {
          stop("continuation-unavailable");
          return;
        }
        const requested = command.commandKind === "start"
          ? command.requestedProfileProjection
          : command.profileProjection?.requested;
        unavailableReason = "submission-unavailable";
        current = await channel.act(Object.freeze({
          kind: "direct", commandKind: "continue", runtime: command.runtime,
          idempotencyKey: randomUUID(), targetSessionId: completed.session.sessionId,
          profile: command.profile,
          ...(requested === undefined ? {} : { profileProjection: { version: 1 as const, requested } }),
          ...(command.runtimeResumeIdentity === undefined ? {} : { runtimeResumeIdentity: command.runtimeResumeIdentity }),
          input: sessionContinuationStepInput(plan, step + 1),
        }), runtimeContext);
        step += 1;
        reportProgress?.(current.commandId, Object.freeze({ step, limit: plan.steps }));
      }
    } catch {
      // No retry: an observation/acceptance error is never a completed turn.
      stop(unavailableReason);
    } finally {
      // Do not make a user's takeover wait for a pending Runtime event.
      void iterator.return?.().catch(() => undefined);
      if (generation === intent) {
        cancelObserver = undefined;
        activeStop = undefined;
      }
    }
  }

  return Object.freeze({
    cancel,
    async submit(
      command: DirectProjectCommand,
      runtimeContext: ProjectCommandRuntimeContext | undefined,
      plan: SessionContinuationPlanRequest | undefined,
      intent: number,
    ): Promise<CommandReceipt> {
      const receipt = await channel.act(plan === undefined ? command : Object.freeze({
        ...command, input: sessionContinuationStepInput(plan, 1),
      }), runtimeContext);
      if (plan !== undefined && plan.steps > 1 && generation === intent && !closing) {
        reportProgress?.(receipt.commandId, Object.freeze({ step: 1, limit: plan.steps }));
        const run = follow(receipt, command, runtimeContext, plan, intent);
        runs.add(run);
        void run.then(() => runs.delete(run), () => runs.delete(run));
      }
      return receipt;
    },
    async close(): Promise<void> {
      closing = true;
      cancel();
      await Promise.allSettled([...runs]);
    },
  });
}
