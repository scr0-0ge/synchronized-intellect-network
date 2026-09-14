import type {
  CoordinatorToolRequest,
  HostBoundToolActor,
} from "./contract.ts";

export type AutoIterationToolOperation = CoordinatorToolRequest["kind"];

export const SUPERVISOR_TOOL_OPERATIONS = Object.freeze([
  "submit-work-order",
  "read-work-order-status",
  "read-inbox",
  "submit-review-decision",
  "request-supervisor-rotation",
] as const satisfies readonly AutoIterationToolOperation[]);

export const WORKER_TOOL_OPERATIONS = Object.freeze([
  "read-work-order-status",
  "submit-handoff",
  "read-inbox",
] as const satisfies readonly AutoIterationToolOperation[]);

export interface HostSessionToolBinding {
  readonly actor: HostBoundToolActor;
  /** Omit to expose the complete tool subset for this actor's role. */
  readonly allowedOperations?: readonly AutoIterationToolOperation[];
}

export interface SessionAuthority {
  bindSession(binding: HostSessionToolBinding): void;
  unbindSession(sessionId: string): void;
  operationsForSession(
    sessionId: string,
  ): readonly AutoIterationToolOperation[];
  authorize(
    sessionId: string,
    operation: AutoIterationToolOperation,
  ): HostBoundToolActor | null;
}

interface StoredBinding {
  readonly actor: HostBoundToolActor;
  readonly allowedOperations: readonly AutoIterationToolOperation[];
}

function operationsForActor(
  actor: HostBoundToolActor,
): readonly AutoIterationToolOperation[] {
  return actor.kind === "supervisor"
    ? SUPERVISOR_TOOL_OPERATIONS
    : WORKER_TOOL_OPERATIONS;
}

function cloneActor(actor: HostBoundToolActor): HostBoundToolActor {
  if (actor.kind === "supervisor") {
    return Object.freeze({
      kind: "supervisor",
      sessionId: actor.sessionId,
      tenure: Object.freeze({
        roleSlotId: actor.tenure.roleSlotId,
        generation: actor.tenure.generation,
      }),
    });
  }
  return Object.freeze({
    kind: "worker",
    sessionId: actor.sessionId,
    workOrderId: actor.workOrderId,
    attemptId: actor.attemptId,
  });
}

class InMemorySessionAuthority implements SessionAuthority {
  readonly #bindings = new Map<string, StoredBinding>();

  bindSession(binding: HostSessionToolBinding): void {
    const permitted = operationsForActor(binding.actor);
    const permittedSet = new Set<AutoIterationToolOperation>(permitted);
    const requested = binding.allowedOperations ?? permitted;
    const allowedOperations = [...new Set(requested)];
    for (const operation of allowedOperations) {
      if (!permittedSet.has(operation)) {
        throw new Error(
          `${binding.actor.kind} cannot be bound to ${operation}`,
        );
      }
    }
    this.#bindings.set(
      binding.actor.sessionId,
      Object.freeze({
        actor: cloneActor(binding.actor),
        allowedOperations: Object.freeze(allowedOperations),
      }),
    );
  }

  unbindSession(sessionId: string): void {
    this.#bindings.delete(sessionId);
  }

  operationsForSession(
    sessionId: string,
  ): readonly AutoIterationToolOperation[] {
    return this.#bindings.get(sessionId)?.allowedOperations ?? Object.freeze([]);
  }

  authorize(
    sessionId: string,
    operation: AutoIterationToolOperation,
  ): HostBoundToolActor | null {
    const binding = this.#bindings.get(sessionId);
    if (!binding?.allowedOperations.includes(operation)) return null;
    return binding.actor;
  }
}

export function createSessionAuthority(): SessionAuthority {
  return new InMemorySessionAuthority();
}
