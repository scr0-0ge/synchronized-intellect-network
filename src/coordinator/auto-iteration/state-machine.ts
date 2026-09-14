import type { WorkOrderStatus } from "./contract.ts";

const transitions = Object.freeze({
  executing: Object.freeze(["delivered", "blocked", "waiting-for-quota"]),
  delivered: Object.freeze(["awaiting-review"]),
  "awaiting-review": Object.freeze(["review-approved", "rework", "blocked"]),
  "review-approved": Object.freeze(["awaiting-integration", "integrated"]),
  "awaiting-integration": Object.freeze(["integrated", "rework", "blocked"]),
  integrated: Object.freeze([]),
  rework: Object.freeze(["executing"]),
  blocked: Object.freeze(["executing", "rework"]),
  "waiting-for-quota": Object.freeze(["executing", "blocked"]),
} satisfies Readonly<Record<WorkOrderStatus, readonly WorkOrderStatus[]>>);

export class WorkOrderTransitionError extends Error {
  readonly from: WorkOrderStatus;
  readonly to: WorkOrderStatus;
  readonly allowed: readonly WorkOrderStatus[];

  constructor(
    from: WorkOrderStatus,
    to: WorkOrderStatus,
    allowed: readonly WorkOrderStatus[],
  ) {
    super(
      `Work Order transition ${from} -> ${to} is invalid; allowed: ${
        allowed.length === 0 ? "none" : allowed.join(", ")
      }.`,
    );
    this.name = "WorkOrderTransitionError";
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

export function assertWorkOrderTransition(
  from: WorkOrderStatus,
  to: WorkOrderStatus,
): WorkOrderStatus {
  const allowed: readonly WorkOrderStatus[] = transitions[from];
  if (!allowed.includes(to)) throw new WorkOrderTransitionError(from, to, allowed);
  return to;
}
