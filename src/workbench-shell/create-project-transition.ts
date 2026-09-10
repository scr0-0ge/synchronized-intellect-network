import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import type {
  WorkbenchCreateProjectOutcome,
  WorkbenchCreateProjectResult,
} from "./contract.ts";
import { publicCreateProjectResult } from "./contract.ts";

export type WorkbenchCreateProjectPhase =
  | "chooser-ready"
  | "chooser-claimed"
  | "create-ready"
  | "create-claimed"
  | "register-ready"
  | "register-claimed"
  | "response-ready";

export type WorkbenchCreateProjectChooserResult =
  | "selected"
  | "cancelled"
  | "failed"
  | "malformed";

export type WorkbenchCreateProjectCreateResult =
  | "created"
  | "collision-file"
  | "collision-directory"
  | "collision-alias"
  | "collision-reparse"
  | "target-appeared"
  | "parent-directory-missing"
  | "parent-is-file"
  | "parent-is-alias"
  | "parent-is-reparse"
  | "parent-unavailable"
  | "create-denied"
  | "create-failed-known-no-commit"
  | "unknown";

export type WorkbenchCreateProjectRegistrationResult =
  | "committed"
  | "rejected-known-no-commit"
  | "unavailable-known-no-commit"
  | "unknown";

export interface WorkbenchCreateProjectActiveOperation {
  readonly operationNumber: number;
  readonly phase: WorkbenchCreateProjectPhase;
  readonly targetToken: string | null;
  readonly chooserResult: WorkbenchCreateProjectChooserResult | null;
  readonly createResult: WorkbenchCreateProjectCreateResult | null;
  readonly registrationResult: WorkbenchCreateProjectRegistrationResult | null;
  readonly createCommitted: boolean;
  readonly registrationCommitted: boolean;
  readonly outcome: WorkbenchCreateProjectOutcome | null;
}

export interface WorkbenchCreateProjectCompletedOperation {
  readonly operationNumber: number;
  readonly phase: "completed";
  readonly targetToken: string | null;
  readonly chooserResult: WorkbenchCreateProjectChooserResult | null;
  readonly createResult: WorkbenchCreateProjectCreateResult | null;
  readonly registrationResult: WorkbenchCreateProjectRegistrationResult | null;
  readonly createCommitted: boolean;
  readonly registrationCommitted: boolean;
  readonly outcome: WorkbenchCreateProjectOutcome;
}

export interface WorkbenchCreateProjectState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly lifecycle: "open" | "closed";
  readonly nextOperationNumber: number;
  readonly active: WorkbenchCreateProjectActiveOperation | null;
  readonly last: WorkbenchCreateProjectCompletedOperation | null;
  readonly recoveryTargets: readonly string[];
}

export type WorkbenchCreateProjectEffect =
  | {
      readonly kind: "choose-save-target";
      readonly operationNumber: number;
    }
  | {
      readonly kind: "create-if-absent" | "register-trusted-project";
      readonly operationNumber: number;
      readonly targetToken: string;
    };

export type WorkbenchCreateProjectTransitionEvent =
  | { readonly kind: "initialize" }
  | { readonly kind: "open-controller-lifecycle" }
  | { readonly kind: "renderer-create-intent" }
  | {
      readonly kind: "claim-effect";
      readonly operationNumber: number;
      readonly effectKind: WorkbenchCreateProjectEffect["kind"];
    }
  | {
      readonly kind: "chooser-result";
      readonly operationNumber: number;
      readonly result: string;
      readonly targetToken: string | null;
    }
  | {
      readonly kind: "create-result";
      readonly operationNumber: number;
      readonly result: string;
    }
  | {
      readonly kind: "registration-result";
      readonly operationNumber: number;
      readonly result: string;
    }
  | { readonly kind: "deliver-result"; readonly operationNumber: number }
  | { readonly kind: "restart" }
  | { readonly kind: "close" };

export interface WorkbenchCreateProjectTransitionResult {
  readonly state: WorkbenchCreateProjectState;
  readonly applied: boolean;
  readonly code: string;
  readonly effects: readonly WorkbenchCreateProjectEffect[];
  readonly publicResults: readonly WorkbenchCreateProjectResult[];
}

const activeKeys = [
  "chooserResult",
  "createCommitted",
  "createResult",
  "operationNumber",
  "outcome",
  "phase",
  "registrationCommitted",
  "registrationResult",
  "targetToken",
] as const;
const completedKeys = activeKeys;
const stateKeys = [
  "active",
  "last",
  "lifecycle",
  "nextOperationNumber",
  "recoveryTargets",
  "revision",
  "schemaVersion",
] as const;
const createResults = [
  "created",
  "collision-file",
  "collision-directory",
  "collision-alias",
  "collision-reparse",
  "target-appeared",
  "parent-directory-missing",
  "parent-is-file",
  "parent-is-alias",
  "parent-is-reparse",
  "parent-unavailable",
  "create-denied",
  "create-failed-known-no-commit",
  "unknown",
] as const;
const knownNoCreateCommit = createResults.filter(
  (result) => result !== "created" && result !== "unknown",
);
const registrationResults = [
  "committed",
  "rejected-known-no-commit",
  "unavailable-known-no-commit",
  "unknown",
] as const;
const outcomes = [
  "created",
  "cancelled",
  "unavailable",
  "created-recovery-required",
] as const;
const maximumCounter = 2_147_483_647;

export function createEmptyWorkbenchCreateProjectState(): WorkbenchCreateProjectState {
  return {
    schemaVersion: 1,
    revision: 0,
    lifecycle: "open",
    nextOperationNumber: 1,
    active: null,
    last: null,
    recoveryTargets: [],
  };
}

export function createWorkbenchCreateProjectTargetToken(
  targetPath: string,
): string {
  const normalizedTargetPath = normalize(targetPath);
  const identity = process.platform === "win32"
    ? normalizedTargetPath.toLocaleLowerCase("en-US")
    : normalizedTargetPath;
  return `candidate-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function validateWorkbenchCreateProjectState(
  value: unknown,
): value is WorkbenchCreateProjectState {
  try {
    if (!hasExactDataProperties(value, stateKeys)) return false;
    const state = value as unknown as WorkbenchCreateProjectState;
    if (
      state.schemaVersion !== 1 ||
      !isCounter(state.revision, true) ||
      (state.lifecycle !== "open" && state.lifecycle !== "closed") ||
      !isCounter(state.nextOperationNumber, false) ||
      !Array.isArray(state.recoveryTargets) ||
      state.recoveryTargets.length > 1_024
    ) {
      return false;
    }
    const recovery = new Set<string>();
    for (const token of state.recoveryTargets) {
      if (!isTargetToken(token) || recovery.has(token)) return false;
      recovery.add(token);
    }
    if (state.nextOperationNumber === 1 && recovery.size !== 0) {
      return false;
    }
    if (
      state.last !== null &&
      !validateCompletedOperation(state.last, recovery)
    ) {
      return false;
    }
    if (
      state.active !== null &&
      !validateActiveOperation(state.active, recovery)
    ) {
      return false;
    }
    if (state.nextOperationNumber === 2 && recovery.size !== 0) {
      const soleOperation = state.active ?? state.last;
      if (
        soleOperation === null ||
        soleOperation.targetToken === null ||
        recovery.size !== 1 ||
        !recovery.has(soleOperation.targetToken)
      ) {
        return false;
      }
    }
    if (state.lifecycle === "closed" && state.active !== null) return false;

    if (state.active === null && state.last === null) {
      return state.nextOperationNumber === 1;
    }
    if (state.active === null) {
      return state.last!.operationNumber === state.nextOperationNumber - 1;
    }
    if (state.active.operationNumber !== state.nextOperationNumber - 1) {
      return false;
    }
    if (state.last === null) return state.active.operationNumber === 1;
    return state.last.operationNumber === state.active.operationNumber - 1;
  } catch {
    return false;
  }
}

export function transitionWorkbenchCreateProject(
  suppliedState: unknown,
  suppliedEvent: unknown,
): WorkbenchCreateProjectTransitionResult {
  if (
    hasExactDataProperties(suppliedEvent, ["kind"]) &&
    (suppliedEvent as { kind: unknown }).kind === "initialize"
  ) {
    if (suppliedState === null || suppliedState === undefined) {
      return transitionResult(
        createEmptyWorkbenchCreateProjectState(),
        true,
        "initialized",
      );
    }
    if (!validateWorkbenchCreateProjectState(suppliedState)) {
      return transitionResult(
        suppliedState as WorkbenchCreateProjectState,
        false,
        "state-invalid",
      );
    }
    return transitionResult(suppliedState, false, "already-initialized");
  }

  if (!validateWorkbenchCreateProjectState(suppliedState)) {
    return transitionResult(
      suppliedState as WorkbenchCreateProjectState,
      false,
      "state-invalid",
    );
  }
  const state = suppliedState;
  if (!hasDataProperty(suppliedEvent, "kind")) {
    return transitionResult(state, false, "event-invalid");
  }
  const event = suppliedEvent as Record<string, unknown>;

  let result: WorkbenchCreateProjectTransitionResult;
  switch (event.kind) {
    case "open-controller-lifecycle":
      result = openControllerLifecycle(state, event);
      break;
    case "renderer-create-intent":
      result = acceptIntent(state, event);
      break;
    case "claim-effect":
      result = claimEffect(state, event);
      break;
    case "chooser-result":
    case "create-result":
    case "registration-result":
      result = recordEffectResult(state, event);
      break;
    case "deliver-result":
      result = deliverResult(state, event);
      break;
    case "restart":
      result = reconcileRestart(state, event);
      break;
    case "close":
      result = closeState(state, event);
      break;
    default:
      return transitionResult(state, false, "event-unsupported");
  }
  if (!result.applied || transitionStateIsValid(result.state)) {
    return result;
  }
  const code = result.state.revision > maximumCounter
    ? "revision-exhausted"
    : result.state.recoveryTargets.length > 1_024
      ? "recovery-capacity-exhausted"
      : "transition-produced-invalid-state";
  return transitionResult(
    state,
    false,
    code,
    [],
    event.kind === "renderer-create-intent"
      ? [publicCreateProjectResult("unavailable")]
      : [],
  );
}

function transitionStateIsValid(value: unknown): boolean {
  return validateWorkbenchCreateProjectState(value);
}

function openControllerLifecycle(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  if (!hasExactDataProperties(event, ["kind"])) {
    return transitionResult(state, false, "event-invalid");
  }
  if (state.lifecycle === "open") {
    return transitionResult(state, false, "lifecycle-open");
  }
  const next = cloneState(state);
  mutable(next).lifecycle = "open";
  incrementRevision(next);
  return transitionResult(next, true, "lifecycle-opened");
}

function acceptIntent(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  if (!hasExactDataProperties(event, ["kind"])) {
    return transitionResult(state, false, "public-input-invalid", [], [
      publicCreateProjectResult("unavailable"),
    ]);
  }
  if (state.lifecycle === "closed") {
    return transitionResult(state, false, "closed", [], [
      publicCreateProjectResult("unavailable"),
    ]);
  }
  if (state.active !== null) {
    return transitionResult(state, false, "operation-pending", [], [
      publicCreateProjectResult("unavailable"),
    ]);
  }
  if (state.nextOperationNumber === maximumCounter) {
    return transitionResult(state, false, "operation-number-exhausted", [], [
      publicCreateProjectResult("unavailable"),
    ]);
  }
  const next = cloneState(state);
  const operationNumber = next.nextOperationNumber;
  mutable(next).nextOperationNumber = operationNumber + 1;
  mutable(next).active = {
    operationNumber,
    phase: "chooser-ready",
    targetToken: null,
    chooserResult: null,
    createResult: null,
    registrationResult: null,
    createCommitted: false,
    registrationCommitted: false,
    outcome: null,
  };
  incrementRevision(next);
  return transitionResult(next, true, "intent-accepted");
}

function claimEffect(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  if (
    !hasExactDataProperties(event, [
      "effectKind",
      "kind",
      "operationNumber",
    ]) ||
    !isOperationNumber(event.operationNumber) ||
    typeof event.effectKind !== "string"
  ) {
    return transitionResult(state, false, "event-invalid");
  }
  if (state.active === null) {
    return transitionResult(state, false, "operation-not-active");
  }
  if (state.active.operationNumber !== event.operationNumber) {
    return transitionResult(state, false, "operation-mismatch");
  }
  const expected = expectedEffect(state.active.phase);
  if (expected === null) {
    return transitionResult(state, false, "effect-already-claimed");
  }
  if (event.effectKind !== expected) {
    return transitionResult(state, false, "effect-mismatch");
  }

  const next = cloneState(state);
  const active = mutable(next.active!);
  active.phase = claimedPhase(active.phase);
  incrementRevision(next);
  const effect: WorkbenchCreateProjectEffect = expected === "choose-save-target"
    ? { kind: expected, operationNumber: active.operationNumber }
    : {
        kind: expected,
        operationNumber: active.operationNumber,
        targetToken: active.targetToken!,
      };
  return transitionResult(next, true, "effect-claimed", [effect]);
}

function recordEffectResult(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  const kind = event.kind as
    | "chooser-result"
    | "create-result"
    | "registration-result";
  const expectedKeys = kind === "chooser-result"
    ? ["kind", "operationNumber", "result", "targetToken"]
    : ["kind", "operationNumber", "result"];
  if (
    !hasExactDataProperties(event, expectedKeys) ||
    !isOperationNumber(event.operationNumber) ||
    typeof event.result !== "string"
  ) {
    return transitionResult(state, false, "event-invalid");
  }
  if (
    state.active === null ||
    state.active.operationNumber !== event.operationNumber
  ) {
    return transitionResult(state, false, "late-result-ignored");
  }

  const normalized = normalizeResult(kind, event);
  if (isDuplicateResult(state.active, kind, normalized)) {
    return transitionResult(state, false, "duplicate-result-converged");
  }
  const requiredPhase = kind === "chooser-result"
    ? "chooser-claimed"
    : kind === "create-result"
      ? "create-claimed"
      : "register-claimed";
  if (state.active.phase !== requiredPhase) {
    return transitionResult(state, false, "result-out-of-order");
  }

  const next = cloneState(state);
  const active = mutable(next.active!);
  if (kind === "chooser-result") {
    active.chooserResult = normalized.result as WorkbenchCreateProjectChooserResult;
    if (normalized.result === "selected") {
      active.targetToken = normalized.targetToken!;
      if (next.recoveryTargets.includes(normalized.targetToken!)) {
        active.outcome = "created-recovery-required";
        active.phase = "response-ready";
      } else {
        active.phase = "create-ready";
      }
    } else if (normalized.result === "cancelled") {
      active.outcome = "cancelled";
      active.phase = "response-ready";
    } else {
      active.outcome = "unavailable";
      active.phase = "response-ready";
    }
  } else if (kind === "create-result") {
    active.createResult = normalized.result as WorkbenchCreateProjectCreateResult;
    if (normalized.result === "created") {
      active.createCommitted = true;
      active.phase = "register-ready";
    } else if (
      knownNoCreateCommit.includes(
        normalized.result as (typeof knownNoCreateCommit)[number],
      )
    ) {
      active.outcome = "unavailable";
      active.phase = "response-ready";
    } else {
      addRecoveryTarget(next, active.targetToken);
      active.outcome = "created-recovery-required";
      active.phase = "response-ready";
    }
  } else {
    active.registrationResult =
      normalized.result as WorkbenchCreateProjectRegistrationResult;
    if (normalized.result === "committed") {
      active.registrationCommitted = true;
      active.outcome = "created";
    } else {
      addRecoveryTarget(next, active.targetToken);
      active.outcome = "created-recovery-required";
    }
    active.phase = "response-ready";
  }
  incrementRevision(next);
  return transitionResult(next, true, "result-recorded");
}

function deliverResult(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  if (
    !hasExactDataProperties(event, ["kind", "operationNumber"]) ||
    !isOperationNumber(event.operationNumber)
  ) {
    return transitionResult(state, false, "event-invalid");
  }
  if (state.active === null) {
    if (state.last?.operationNumber === event.operationNumber) {
      return transitionResult(state, false, "response-replayed", [], [
        publicCreateProjectResult(state.last.outcome),
      ]);
    }
    return transitionResult(state, false, "operation-not-active");
  }
  if (
    state.active.operationNumber !== event.operationNumber ||
    state.active.phase !== "response-ready"
  ) {
    return transitionResult(state, false, "response-not-ready");
  }
  const next = cloneState(state);
  const active = next.active!;
  const outcome = active.outcome!;
  completeOperation(next, active, outcome);
  incrementRevision(next);
  return transitionResult(next, true, "response-delivered", [], [
    publicCreateProjectResult(outcome),
  ]);
}

function reconcileRestart(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  if (!hasExactDataProperties(event, ["kind"])) {
    return transitionResult(state, false, "event-invalid");
  }
  if (state.lifecycle === "closed" || state.active === null) {
    return transitionResult(state, false, "restart-stable");
  }
  if (state.active.phase === "chooser-ready" || state.active.phase === "response-ready") {
    return transitionResult(state, false, "restart-stable");
  }
  const next = cloneState(state);
  const active = mutable(next.active!);
  if (active.phase === "chooser-claimed" || active.phase === "create-ready") {
    active.outcome = "unavailable";
  } else {
    addRecoveryTarget(next, active.targetToken);
    active.outcome = "created-recovery-required";
  }
  active.phase = "response-ready";
  incrementRevision(next);
  return transitionResult(next, true, "restart-reconciled");
}

function closeState(
  state: WorkbenchCreateProjectState,
  event: Record<string, unknown>,
): WorkbenchCreateProjectTransitionResult {
  if (!hasExactDataProperties(event, ["kind"])) {
    return transitionResult(state, false, "event-invalid");
  }
  if (state.lifecycle === "closed") {
    return transitionResult(state, false, "already-closed");
  }
  const next = cloneState(state);
  const results: WorkbenchCreateProjectResult[] = [];
  if (next.active !== null) {
    const active = next.active;
    let outcome: WorkbenchCreateProjectOutcome;
    if (active.phase === "response-ready") {
      outcome = active.outcome!;
    } else if (
      active.phase === "create-claimed" ||
      active.phase === "register-ready" ||
      active.phase === "register-claimed"
    ) {
      addRecoveryTarget(next, active.targetToken);
      outcome = "created-recovery-required";
    } else {
      outcome = "unavailable";
    }
    completeOperation(next, active, outcome);
    results.push(publicCreateProjectResult(outcome));
  }
  mutable(next).lifecycle = "closed";
  incrementRevision(next);
  return transitionResult(next, true, "closed", [], results);
}

function validateActiveOperation(
  value: unknown,
  recovery: ReadonlySet<string>,
): value is WorkbenchCreateProjectActiveOperation {
  if (!hasExactDataProperties(value, activeKeys)) return false;
  const record = value as unknown as WorkbenchCreateProjectActiveOperation;
  if (
    !isOperationNumber(record.operationNumber) ||
    !isNullableMember(record.chooserResult, [
      "selected",
      "cancelled",
      "failed",
      "malformed",
    ]) ||
    !isNullableMember(record.createResult, createResults) ||
    !isNullableMember(record.registrationResult, registrationResults) ||
    !isNullableMember(record.outcome, outcomes) ||
    typeof record.createCommitted !== "boolean" ||
    typeof record.registrationCommitted !== "boolean" ||
    (record.registrationCommitted && !record.createCommitted) ||
    (record.targetToken !== null && !isTargetToken(record.targetToken))
  ) {
    return false;
  }
  if (
    record.phase === "chooser-ready" ||
    record.phase === "chooser-claimed"
  ) {
    return emptyBeforeChooser(record);
  }
  if (record.phase === "create-ready" || record.phase === "create-claimed") {
    return selectedTarget(record, recovery) &&
      record.createResult === null &&
      record.registrationResult === null &&
      !record.createCommitted &&
      !record.registrationCommitted &&
      record.outcome === null;
  }
  if (
    record.phase === "register-ready" ||
    record.phase === "register-claimed"
  ) {
    return selectedTarget(record, recovery) &&
      record.createResult === "created" &&
      record.createCommitted &&
      record.registrationResult === null &&
      !record.registrationCommitted &&
      record.outcome === null;
  }
  return record.phase === "response-ready" &&
    record.outcome !== null &&
    terminalRelation(record, recovery, false);
}

function validateCompletedOperation(
  value: unknown,
  recovery: ReadonlySet<string>,
): value is WorkbenchCreateProjectCompletedOperation {
  if (!hasExactDataProperties(value, completedKeys)) return false;
  const record = value as unknown as WorkbenchCreateProjectCompletedOperation;
  return record.phase === "completed" &&
    isOperationNumber(record.operationNumber) &&
    (record.targetToken === null || isTargetToken(record.targetToken)) &&
    isNullableMember(record.chooserResult, [
      "selected",
      "cancelled",
      "failed",
      "malformed",
    ]) &&
    isNullableMember(record.createResult, createResults) &&
    isNullableMember(record.registrationResult, registrationResults) &&
    typeof record.createCommitted === "boolean" &&
    typeof record.registrationCommitted === "boolean" &&
    (!record.registrationCommitted || record.createCommitted) &&
    outcomes.includes(record.outcome) &&
    terminalRelation(record, recovery, true);
}

function terminalRelation(
  record:
    | WorkbenchCreateProjectActiveOperation
    | WorkbenchCreateProjectCompletedOperation,
  recovery: ReadonlySet<string>,
  completed: boolean,
): boolean {
  const token = record.targetToken;
  const isRecovery = token !== null && recovery.has(token);
  if (record.outcome === "created") {
    return isTargetToken(token) &&
      record.chooserResult === "selected" &&
      record.createResult === "created" &&
      record.registrationResult === "committed" &&
      record.createCommitted &&
      record.registrationCommitted &&
      !isRecovery;
  }
  if (record.outcome === "cancelled") {
    return token === null &&
      record.chooserResult === "cancelled" &&
      record.createResult === null &&
      record.registrationResult === null &&
      !record.createCommitted &&
      !record.registrationCommitted;
  }
  if (record.outcome === "created-recovery-required") {
    if (
      !isTargetToken(token) ||
        record.chooserResult !== "selected" ||
      !isRecovery ||
      record.registrationCommitted
    ) {
      return false;
    }
    if (record.createResult === null || record.createResult === "unknown") {
      return !record.createCommitted && record.registrationResult === null;
    }
    return record.createResult === "created" &&
      record.createCommitted &&
      (record.registrationResult === null ||
        record.registrationResult === "rejected-known-no-commit" ||
        record.registrationResult === "unavailable-known-no-commit" ||
        record.registrationResult === "unknown");
  }
  if (
    record.outcome !== "unavailable" ||
    record.createCommitted ||
    record.registrationCommitted ||
    record.registrationResult !== null
  ) {
    return false;
  }
  if (token === null) {
    return record.createResult === null &&
      (record.chooserResult === null ||
        record.chooserResult === "failed" ||
        record.chooserResult === "malformed");
  }
  return isTargetToken(token) &&
    record.chooserResult === "selected" &&
    !isRecovery &&
    ((completed && record.createResult === null) ||
      knownNoCreateCommit.includes(
        record.createResult as (typeof knownNoCreateCommit)[number],
      ));
}

function emptyBeforeChooser(record: WorkbenchCreateProjectActiveOperation): boolean {
  return record.targetToken === null &&
    record.chooserResult === null &&
    record.createResult === null &&
    record.registrationResult === null &&
    !record.createCommitted &&
    !record.registrationCommitted &&
    record.outcome === null;
}

function selectedTarget(
  record: WorkbenchCreateProjectActiveOperation,
  recovery: ReadonlySet<string>,
): boolean {
  return isTargetToken(record.targetToken) &&
    record.chooserResult === "selected" &&
    !recovery.has(record.targetToken);
}

function normalizeResult(
  kind: "chooser-result" | "create-result" | "registration-result",
  event: Record<string, unknown>,
): { readonly result: string; readonly targetToken: string | null } {
  if (kind === "chooser-result") {
    if (
      event.result === "selected" &&
      isTargetToken(event.targetToken)
    ) {
      return {
        result: "selected",
        targetToken: event.targetToken,
      };
    }
    if (
      (event.result === "cancelled" || event.result === "failed") &&
      event.targetToken === null
    ) {
      return { result: event.result, targetToken: null };
    }
    return { result: "malformed", targetToken: null };
  }
  if (kind === "create-result") {
    return {
      result: createResults.includes(
        event.result as WorkbenchCreateProjectCreateResult,
      ) ? event.result as string : "unknown",
      targetToken: null,
    };
  }
  return {
    result: registrationResults.includes(
      event.result as WorkbenchCreateProjectRegistrationResult,
    ) ? event.result as string : "unknown",
    targetToken: null,
  };
}

function isDuplicateResult(
  active: WorkbenchCreateProjectActiveOperation,
  kind: "chooser-result" | "create-result" | "registration-result",
  normalized: ReturnType<typeof normalizeResult>,
): boolean {
  if (kind === "chooser-result") {
    return active.chooserResult === normalized.result &&
      (normalized.result !== "selected" ||
        active.targetToken === normalized.targetToken);
  }
  return kind === "create-result"
    ? active.createResult === normalized.result
    : active.registrationResult === normalized.result;
}

function expectedEffect(
  phase: WorkbenchCreateProjectPhase,
): WorkbenchCreateProjectEffect["kind"] | null {
  if (phase === "chooser-ready") return "choose-save-target";
  if (phase === "create-ready") return "create-if-absent";
  if (phase === "register-ready") return "register-trusted-project";
  return null;
}

function claimedPhase(phase: WorkbenchCreateProjectPhase): WorkbenchCreateProjectPhase {
  if (phase === "chooser-ready") return "chooser-claimed";
  if (phase === "create-ready") return "create-claimed";
  if (phase === "register-ready") return "register-claimed";
  return phase;
}

function completeOperation(
  state: WorkbenchCreateProjectState,
  active: WorkbenchCreateProjectActiveOperation,
  outcome: WorkbenchCreateProjectOutcome,
): void {
  mutable(state).last = {
    operationNumber: active.operationNumber,
    phase: "completed",
    targetToken: active.targetToken,
    chooserResult: active.chooserResult,
    createResult: active.createResult,
    registrationResult: active.registrationResult,
    createCommitted: active.createCommitted,
    registrationCommitted: active.registrationCommitted,
    outcome,
  };
  mutable(state).active = null;
}

function addRecoveryTarget(
  state: WorkbenchCreateProjectState,
  token: string | null,
): void {
  if (!isTargetToken(token) || state.recoveryTargets.includes(token)) return;
  mutable(state).recoveryTargets = [...state.recoveryTargets, token];
}

function incrementRevision(state: WorkbenchCreateProjectState): void {
  mutable(state).revision += 1;
}

function transitionResult(
  state: WorkbenchCreateProjectState,
  applied: boolean,
  code: string,
  effects: readonly WorkbenchCreateProjectEffect[] = [],
  publicResults: readonly WorkbenchCreateProjectResult[] = [],
): WorkbenchCreateProjectTransitionResult {
  return {
    state,
    applied,
    code,
    effects,
    publicResults,
  };
}

function cloneState(state: WorkbenchCreateProjectState): WorkbenchCreateProjectState {
  return JSON.parse(JSON.stringify(state)) as WorkbenchCreateProjectState;
}

function mutable<T>(value: T): { -readonly [K in keyof T]: T[K] } {
  return value as { -readonly [K in keyof T]: T[K] };
}

function isCounter(value: unknown, allowZero: boolean): value is number {
  return Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    (allowZero ? (value as number) >= 0 : (value as number) >= 1) &&
    (value as number) <= maximumCounter;
}

function isOperationNumber(value: unknown): value is number {
  return isCounter(value, false);
}

function isTargetToken(value: unknown): value is string {
  return typeof value === "string" &&
    /^candidate-[0-9a-f]{32}$/u.test(value);
}

function isPrivateTargetPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    isLocalAbsoluteTarget(value) &&
    isAbsolute(value) &&
    normalize(value) === value;
}

function isLocalAbsoluteTarget(value: string): boolean {
  return process.platform === "win32"
    ? /^[A-Za-z]:[\\/]/u.test(value)
    : value.startsWith("/") && !value.startsWith("//");
}

function isNullableMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T | null {
  return value === null ||
    (typeof value === "string" && allowed.includes(value as T));
}

function hasDataProperty(value: unknown, name: string): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable === true;
  } catch {
    return false;
  }
}

function hasExactDataProperties(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const keys = (ownKeys as string[]).sort();
    const wanted = [...expected].sort();
    return keys.length === wanted.length &&
      keys.every((key, index) => key === wanted[index]) &&
      wanted.every((key) => {
        const descriptor = descriptors[key];
        return descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable === true;
      });
  } catch {
    return false;
  }
}
