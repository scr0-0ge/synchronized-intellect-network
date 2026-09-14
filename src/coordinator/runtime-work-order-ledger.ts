/** Runtime/process state retained on one auto-iteration ExecutionAttempt. */
export type RuntimeWorkOrderLifecycle =
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

/** Resource ownership is monotonic and independent from business delivery. */
export type RuntimeWorkOrderSlotState = "unreserved" | "owned" | "released";