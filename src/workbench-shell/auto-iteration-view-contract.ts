/**
 * Sanitized, read-only renderer projection of the auto-iteration ledger.
 * Model-tool wiring never enters this contract; the Workbench backend is the
 * only producer and the renderer is never a second state authority.
 */

export interface WorkbenchAutoIterationSupervisorView {
  readonly roleSlotId: string;
  readonly generation: number;
  readonly tenureStatus:
    | "active"
    | "draining"
    | "successor-preparing"
    | "cutover"
    | "retired";
}

export interface WorkbenchAutoIterationWorkOrderView {
  readonly workOrderId: string;
  readonly status:
    | "executing"
    | "queued"
    | "delivered"
    | "awaiting-review"
    | "review-approved"
    | "awaiting-integration"
    | "integrated"
    | "rework"
    | "blocked"
    | "waiting-for-quota";
  readonly attemptCount: number;
  readonly workerSessionBound: boolean;
  readonly workerRuntimeLifecycle:
    | "accepted"
    | "denied"
    | "authorized"
    | "start-claimed"
    | "running"
    | "control-claimed"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "recovery-required";
  readonly delivered: boolean;
  readonly reviewDecided: boolean;
  readonly integrated: boolean;
  readonly waitingFor:
    | "worker-start"
    | "worker-execution"
    | "supervisor-review"
    | "integration"
    | "quota"
    /** Issue #8 M4: finer-grained reasons; see the same union in coordinator/auto-iteration/contract.ts. */
    | "supervisor-busy"
    | "supervisor-recovering"
    | "queued-limit"
    | `quota:${string}`
    | "review-pending"
    | "integration-running"
    | `integration-blocked:${string}`
    | "ready-to-publish"
    | null;
}

export interface WorkbenchAutoIterationView {
  /** `unavailable` while the Project channel carries no auto-iteration authority. */
  readonly status: "active" | "unavailable";
  readonly supervisor: WorkbenchAutoIterationSupervisorView | null;
  readonly workOrders: readonly WorkbenchAutoIterationWorkOrderView[];
  readonly pendingInboxEntries: number;
  readonly quotaBlocked: boolean;
  /** Newest sensor observation time in this Project; null before any read. */
  readonly lastObservedAt: number | null;
}

/** The projection shown before any auto-iteration authority exists. */
export const UNAVAILABLE_AUTO_ITERATION_VIEW: WorkbenchAutoIterationView =
  Object.freeze({
    status: "unavailable",
    supervisor: null,
    workOrders: Object.freeze([]),
    pendingInboxEntries: 0,
    quotaBlocked: false,
    lastObservedAt: null,
  });
