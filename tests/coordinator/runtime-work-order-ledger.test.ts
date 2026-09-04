import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type {
  AgentRuntimeAdapter,
  RuntimeBinding,
  RuntimeCatalog,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createRuntimeEndpointDirectory,
  type BoundSupervisorSession,
  type RuntimeEndpointDirectory,
  type RuntimeEndpointDirectorySnapshot,
  type RuntimeEndpointRegistration,
  type RuntimeNeutralWorkOrder,
} from "../../src/agent-runtime/runtime-endpoint-directory.ts";
import {
  createRuntimeWorkOrderLedger,
  RuntimeWorkOrderLedgerCrashError,
  RuntimeWorkOrderLedgerError,
} from "../../src/coordinator/runtime-work-order-ledger.ts";

class InMemoryLedgerEndpointAdapter implements AgentRuntimeAdapter {
  readonly effects = {
    inspect: 0,
    start: 0,
    resume: 0,
    send: 0,
    event: 0,
  };

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.effects.inspect += 1;
    return {
      runtime: "in-memory",
      models: [],
      executionModes: [],
      accessModes: [],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.effects.start += 1;
    throw new Error("The ledger must never invoke an Adapter.");
  }
}

test("a submission is durably accepted before pure authorization and exact slot ownership", (t) => {
  const fixture = createDirectoryFixture({
    localLimit: 2,
    remoteLimit: 2,
  });
  const databasePath = ownedDatabasePath(t, "accept-authorize-slot");
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-accept-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });

  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  assert.deepEqual(Reflect.ownKeys(ledger), []);
  const result = ledger.coordinate({
    kind: "submit",
    workOrder,
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });

  assert.equal(result.kind, "submission");
  assert.equal(result.status, "authorized");
  assert.equal(result.revision, 2);
  assert.match(result.workOrderKey, /^rwok_[A-Za-z0-9_-]{32}$/u);
  assert.equal("effectIntent" in result, false);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.revision, 2);
  assert.equal(
    snapshot.directorySnapshotKey,
    fixture.snapshot.directorySnapshotKey,
  );
  assert.deepEqual(snapshot.orders, [
    {
      workOrderKey: result.workOrderKey,
      directorySnapshotKey: fixture.snapshot.directorySnapshotKey,
      endpointSnapshotKey: fixture.remote.endpointSnapshotKey,
      profileSnapshotKey: fixture.remoteFull.profileSnapshotKey,
      requestedAccessMode: "full-access",
      lifecycle: "authorized",
      effectPhase: "unclaimed",
      denialCategory: null,
      slot: {
        state: "owned",
        units: 1,
        acquiredRevision: 2,
        releasedRevision: null,
      },
      worker: null,
    },
  ]);
  assertFrozenTree(result);
  assertFrozenTree(snapshot);
  assertAllAdapterEffectsZero(fixture);
  ledger.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  assert.deepEqual(reopened.snapshot(), snapshot);
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("a durable start claim precedes one running Worker, progress, Handoff, and slot release", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "running-handoff-release");
  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const submission = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-lifecycle-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });

  const claim = ledger.coordinate({
    kind: "claim-start",
    workOrderKey: submission.workOrderKey,
  });
  assert.equal(claim.kind, "effect-intent");
  assert.equal(claim.revision, 3);
  assert.deepEqual(claim.effectIntent, {
    kind: "start-worker",
    claimKey: claim.effectIntent.claimKey,
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
    directorySnapshotKey: fixture.snapshot.directorySnapshotKey,
    endpointSnapshotKey: fixture.remote.endpointSnapshotKey,
    profileSnapshotKey: fixture.remoteFull.profileSnapshotKey,
    accessMode: "full-access",
  });
  assert.match(claim.effectIntent.claimKey, /^rwck_[A-Za-z0-9_-]{32}$/u);
  assert.match(claim.effectIntent.workerKey, /^rwwk_[A-Za-z0-9_-]{32}$/u);
  assert.equal(ledger.snapshot().orders[0]?.lifecycle, "start-claimed");
  assert.equal(ledger.snapshot().orders[0]?.slot.state, "owned");

  const running = ledger.coordinate({
    kind: "confirm-start",
    workOrderKey: submission.workOrderKey,
    claimKey: claim.effectIntent.claimKey,
    outcome: "started",
  });
  assert.deepEqual(running, {
    kind: "transition",
    status: "running",
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
    revision: 4,
  });
  const progress = ledger.coordinate({
    kind: "record-progress",
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
    sequence: 1,
  });
  assert.equal(progress.status, "running");
  assert.equal(progress.revision, 5);

  const completed = ledger.coordinate({
    kind: "record-handoff",
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
    handoffKey: "handoff-lifecycle-001",
  });
  assert.deepEqual(completed, {
    kind: "transition",
    status: "completed",
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
    revision: 6,
  });
  const finalOrder = ledger.snapshot().orders[0];
  assert.ok(finalOrder);
  assert.equal(finalOrder.lifecycle, "completed");
  assert.equal(finalOrder.effectPhase, "committed");
  assert.deepEqual(finalOrder.slot, {
    state: "released",
    units: 1,
    acquiredRevision: 2,
    releasedRevision: 6,
  });
  assert.deepEqual(finalOrder.worker, {
    workerKey: claim.effectIntent.workerKey,
    lifecycle: "completed",
    progressSequence: 1,
    handoffState: "recorded",
    controlState: "none",
  });

  const duplicate = ledger.coordinate({
    kind: "record-handoff",
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
    handoffKey: "handoff-lifecycle-001",
  });
  assert.deepEqual(duplicate, completed);
  assert.equal(ledger.snapshot().revision, 6);
  assertAllAdapterEffectsZero(fixture);
  ledger.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  assert.equal(reopened.snapshot().revision, 6);
  assert.deepEqual(reopened.snapshot().orders[0], finalOrder);
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("safe pre-start cancellation and confirmed start failure release once for endpoint reuse", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const ledger = createRuntimeWorkOrderLedger({
    databasePath: ownedDatabasePath(t, "known-no-worker-release"),
    directory: fixture.directory,
  });
  const first = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-safe-cancel-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  const cancelled = ledger.coordinate({
    kind: "cancel-before-start",
    workOrderKey: first.workOrderKey,
  });
  assert.deepEqual(cancelled, {
    kind: "transition",
    status: "cancelled",
    workOrderKey: first.workOrderKey,
    workerKey: null,
    revision: 3,
  });
  assert.deepEqual(
    ledger.coordinate({
      kind: "cancel-before-start",
      workOrderKey: first.workOrderKey,
    }),
    cancelled,
  );

  const second = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-start-failure-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  assert.equal(second.status, "authorized");
  const claim = ledger.coordinate({
    kind: "claim-start",
    workOrderKey: second.workOrderKey,
  });
  assert.equal(claim.kind, "effect-intent");
  const failed = ledger.coordinate({
    kind: "confirm-start",
    workOrderKey: second.workOrderKey,
    claimKey: claim.effectIntent.claimKey,
    outcome: "failed",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.revision, 7);
  assert.deepEqual(
    ledger.coordinate({
      kind: "confirm-start",
      workOrderKey: second.workOrderKey,
      claimKey: claim.effectIntent.claimKey,
      outcome: "failed",
    }),
    failed,
  );

  const successor = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-release-successor-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  assert.equal(successor.status, "authorized");
  assert.equal(successor.revision, 9);
  assert.deepEqual(
    ledger.snapshot().orders.map((order) => [
      order.lifecycle,
      order.slot.state,
      order.slot.releasedRevision,
    ]),
    [
      ["cancelled", "released", 3],
      ["failed", "released", 7],
      ["authorized", "owned", null],
    ],
  );
  assertAllAdapterEffectsZero(fixture);
  ledger.close();
});

test("running cancellation and interruption retain ownership through claim and release only when committed", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const ledger = createRuntimeWorkOrderLedger({
    databasePath: ownedDatabasePath(t, "running-controls"),
    directory: fixture.directory,
  });
  const first = startRunningOrder(
    ledger,
    fixture,
    "ledger-order-control-cancel-001",
  );
  const cancelClaim = ledger.coordinate({
    kind: "claim-control",
    workOrderKey: first.workOrderKey,
    workerKey: first.workerKey,
    action: "cancel",
  });
  assert.equal(cancelClaim.kind, "effect-intent");
  assert.equal(cancelClaim.effectIntent.kind, "cancel-worker");
  assert.equal(cancelClaim.revision, 5);
  assert.equal(ledger.snapshot().orders[0]?.lifecycle, "control-claimed");
  assert.equal(ledger.snapshot().orders[0]?.slot.state, "owned");
  const cancelled = ledger.coordinate({
    kind: "confirm-control",
    workOrderKey: first.workOrderKey,
    workerKey: first.workerKey,
    claimKey: cancelClaim.effectIntent.claimKey,
    outcome: "committed",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.revision, 6);
  assert.equal(ledger.snapshot().orders[0]?.slot.releasedRevision, 6);

  const second = startRunningOrder(
    ledger,
    fixture,
    "ledger-order-control-interrupt-001",
  );
  const failedClaim = ledger.coordinate({
    kind: "claim-control",
    workOrderKey: second.workOrderKey,
    workerKey: second.workerKey,
    action: "interrupt",
  });
  assert.equal(failedClaim.kind, "effect-intent");
  const knownFailure = ledger.coordinate({
    kind: "confirm-control",
    workOrderKey: second.workOrderKey,
    workerKey: second.workerKey,
    claimKey: failedClaim.effectIntent.claimKey,
    outcome: "failed",
  });
  assert.equal(knownFailure.status, "running");
  assert.equal(ledger.snapshot().orders[1]?.slot.state, "owned");
  const interruptClaim = ledger.coordinate({
    kind: "claim-control",
    workOrderKey: second.workOrderKey,
    workerKey: second.workerKey,
    action: "interrupt",
  });
  assert.equal(interruptClaim.kind, "effect-intent");
  assert.notEqual(
    interruptClaim.effectIntent.claimKey,
    failedClaim.effectIntent.claimKey,
  );
  const interrupted = ledger.coordinate({
    kind: "confirm-control",
    workOrderKey: second.workOrderKey,
    workerKey: second.workerKey,
    claimKey: interruptClaim.effectIntent.claimKey,
    outcome: "committed",
  });
  assert.equal(interrupted.status, "interrupted");
  const final = ledger.snapshot().orders[1];
  assert.ok(final);
  assert.equal(final.slot.state, "released");
  assert.deepEqual(final.worker, {
    workerKey: second.workerKey,
    lifecycle: "interrupted",
    progressSequence: 0,
    handoffState: "none",
    controlState: "committed",
  });
  assertAllAdapterEffectsZero(fixture);
  ledger.close();
});

test("a crash before acceptance commit rolls back the only attempted durable mutation", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "crash-before-acceptance");
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-crash-before-acceptance-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });
  const boundSupervisor = supervisorFor(fixture, "local", "full-access");
  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "before-acceptance-commit",
  });
  assert.throws(
    () =>
      crashing.coordinate({
        kind: "submit",
        workOrder,
        boundSupervisor,
      }),
    fixedCrash("before-acceptance-commit"),
  );
  crashing.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  assert.deepEqual(reopened.snapshot(), {
    revision: 0,
    directorySnapshotKey: fixture.snapshot.directorySnapshotKey,
    orders: [],
  });
  const retry = reopened.coordinate({
    kind: "submit",
    workOrder,
    boundSupervisor,
  });
  assert.equal(retry.status, "authorized");
  assert.equal(retry.revision, 2);
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("a crash after acceptance reopens unreserved and resumes pure authorization", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "crash-after-acceptance");
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-crash-after-acceptance-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });
  const boundSupervisor = supervisorFor(fixture, "local", "full-access");
  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "after-acceptance-before-authorization",
  });
  assert.throws(
    () => crashing.coordinate({ kind: "submit", workOrder, boundSupervisor }),
    fixedCrash("after-acceptance-before-authorization"),
  );
  crashing.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const accepted = reopened.snapshot().orders[0];
  assert.ok(accepted);
  assert.equal(reopened.snapshot().revision, 1);
  assert.equal(accepted.lifecycle, "accepted");
  assert.equal(accepted.effectPhase, "unclaimed");
  assert.equal(accepted.slot.state, "unreserved");
  const retry = reopened.coordinate({ kind: "submit", workOrder, boundSupervisor });
  assert.equal(retry.workOrderKey, accepted.workOrderKey);
  assert.equal(retry.status, "authorized");
  assert.equal(retry.revision, 2);
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("a crash after pure authorization leaves no authorization or slot mutation", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "crash-after-authorization");
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-crash-after-authorization-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });
  const boundSupervisor = supervisorFor(fixture, "local", "full-access");
  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "after-authorization-before-slot-commit",
  });
  assert.throws(
    () => crashing.coordinate({ kind: "submit", workOrder, boundSupervisor }),
    fixedCrash("after-authorization-before-slot-commit"),
  );
  crashing.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const accepted = reopened.snapshot().orders[0];
  assert.ok(accepted);
  assert.equal(reopened.snapshot().revision, 1);
  assert.equal(accepted.lifecycle, "accepted");
  assert.equal(accepted.slot.state, "unreserved");
  const retry = reopened.coordinate({ kind: "submit", workOrder, boundSupervisor });
  assert.equal(retry.status, "authorized");
  assert.equal(retry.revision, 2);
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("a crash after slot commit reopens authorized ownership without an effect claim", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "crash-after-slot");
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-crash-after-slot-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });
  const boundSupervisor = supervisorFor(fixture, "local", "full-access");
  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "after-slot-commit-before-effect-claim",
  });
  assert.throws(
    () => crashing.coordinate({ kind: "submit", workOrder, boundSupervisor }),
    fixedCrash("after-slot-commit-before-effect-claim"),
  );
  crashing.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const authorized = reopened.snapshot().orders[0];
  assert.ok(authorized);
  assert.equal(reopened.snapshot().revision, 2);
  assert.equal(authorized.lifecycle, "authorized");
  assert.equal(authorized.effectPhase, "unclaimed");
  assert.equal(authorized.slot.state, "owned");
  const duplicate = reopened.coordinate({ kind: "submit", workOrder, boundSupervisor });
  assert.equal(duplicate.workOrderKey, authorized.workOrderKey);
  assert.equal(duplicate.revision, 2);
  const claim = reopened.coordinate({
    kind: "claim-start",
    workOrderKey: authorized.workOrderKey,
  });
  assert.equal(claim.kind, "effect-intent");
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("a crash after a terminal fact replays the committed release without a second revision", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "crash-after-terminal");
  const setup = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const submission = setup.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-crash-after-terminal-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  setup.close();

  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "after-terminal-fact-before-response",
  });
  assert.throws(
    () =>
      crashing.coordinate({
        kind: "cancel-before-start",
        workOrderKey: submission.workOrderKey,
      }),
    fixedCrash("after-terminal-fact-before-response"),
  );
  crashing.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const terminal = reopened.snapshot().orders[0];
  assert.ok(terminal);
  assert.equal(reopened.snapshot().revision, 3);
  assert.equal(terminal.lifecycle, "cancelled");
  assert.equal(terminal.slot.state, "released");
  assert.equal(terminal.slot.releasedRevision, 3);
  const duplicate = reopened.coordinate({
    kind: "cancel-before-start",
    workOrderKey: submission.workOrderKey,
  });
  assert.equal(duplicate.revision, 3);
  assert.equal(reopened.snapshot().revision, 3);
  assertAllAdapterEffectsZero(fixture);
  reopened.close();
});

test("restart after a claimed start retains outcome-unknown capacity and emits no replay intent", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "unknown-start-outcome");
  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "after-effect-claim-before-external-acknowledgement",
  });
  const submission = crashing.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-unknown-start-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  assert.throws(
    () =>
      crashing.coordinate({
        kind: "claim-start",
        workOrderKey: submission.workOrderKey,
      }),
    (error: unknown) =>
      error instanceof RuntimeWorkOrderLedgerCrashError &&
      error.point ===
        "after-effect-claim-before-external-acknowledgement",
  );
  crashing.close();

  const recovered = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const unknown = recovered.snapshot().orders[0];
  assert.ok(unknown);
  assert.equal(unknown.lifecycle, "recovery-required");
  assert.equal(unknown.effectPhase, "outcome-unknown");
  assert.equal(unknown.slot.state, "owned");
  assert.equal(unknown.slot.releasedRevision, null);
  assert.equal(unknown.worker, null);
  assert.throws(
    () =>
      recovered.coordinate({
        kind: "claim-start",
        workOrderKey: submission.workOrderKey,
      }),
    fixedLedgerError("transition-invalid"),
  );

  const successor = recovered.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-unknown-successor-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  if (successor.kind !== "submission") assert.fail("expected submission");
  assert.equal(successor.status, "denied");
  assert.equal(successor.denialCategory, "endpoint-capacity-denied");
  assert.deepEqual(
    recovered.snapshot().orders.map((order) => [
      order.lifecycle,
      order.effectPhase,
      order.slot.state,
    ]),
    [
      ["recovery-required", "outcome-unknown", "owned"],
      ["denied", "committed", "unreserved"],
    ],
  );
  assertAllAdapterEffectsZero(fixture);
  recovered.close();
});

test("restart during a claimed interruption retains the linked Worker and owned slot", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "unknown-control-outcome");
  const setup = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const running = startRunningOrder(
    setup,
    fixture,
    "ledger-order-unknown-control-001",
  );
  setup.close();

  const crashing = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
    crashPoint: "after-effect-claim-before-external-acknowledgement",
  });
  assert.throws(
    () =>
      crashing.coordinate({
        kind: "claim-control",
        workOrderKey: running.workOrderKey,
        workerKey: running.workerKey,
        action: "interrupt",
      }),
    (error: unknown) =>
      error instanceof RuntimeWorkOrderLedgerCrashError &&
      error.point ===
        "after-effect-claim-before-external-acknowledgement",
  );
  crashing.close();

  const recovered = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const unknown = recovered.snapshot().orders[0];
  assert.ok(unknown);
  assert.equal(unknown.lifecycle, "recovery-required");
  assert.equal(unknown.effectPhase, "outcome-unknown");
  assert.equal(unknown.slot.state, "owned");
  assert.deepEqual(unknown.worker, {
    workerKey: running.workerKey,
    lifecycle: "recovery-required",
    progressSequence: 0,
    handoffState: "none",
    controlState: "outcome-unknown",
  });
  assertAllAdapterEffectsZero(fixture);
  recovered.close();
});

test("capacity counts slot units by exact endpoint while duplicates converge and released capacity is reusable", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 2, remoteLimit: 2 });
  const ledger = createRuntimeWorkOrderLedger({
    databasePath: ownedDatabasePath(t, "exact-endpoint-capacity"),
    directory: fixture.directory,
  });
  const remoteOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-multislot-remote-001",
    target: "remote",
    slots: 2,
    accessMode: "full-access",
  });
  const remoteSupervisor = supervisorFor(fixture, "local", "full-access");
  const remote = ledger.coordinate({
    kind: "submit",
    workOrder: remoteOrder,
    boundSupervisor: remoteSupervisor,
  });
  assert.equal(remote.status, "authorized");
  const duplicate = ledger.coordinate({
    kind: "submit",
    workOrder: {
      ...remoteOrder,
      budget: { ...remoteOrder.budget },
      concurrency: { ...remoteOrder.concurrency },
    },
    boundSupervisor: { ...remoteSupervisor },
  });
  assert.deepEqual(duplicate, remote);
  assert.equal(ledger.snapshot().revision, 2);

  const contended = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-multislot-contended-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: remoteSupervisor,
  });
  if (contended.kind !== "submission") assert.fail("expected submission");
  assert.equal(contended.status, "denied");
  assert.equal(contended.denialCategory, "endpoint-capacity-denied");

  const independent = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-independent-local-001",
      target: "local",
      slots: 2,
      accessMode: "restricted",
    }),
    boundSupervisor: supervisorFor(fixture, "remote", "restricted"),
  });
  assert.equal(independent.status, "authorized");
  assert.notEqual(
    fixture.local.endpointSnapshotKey,
    fixture.remote.endpointSnapshotKey,
  );
  assert.equal(fixture.local.profiles[0]?.modelLabel, "Twin Model");
  assert.equal(fixture.remote.profiles[0]?.modelLabel, "Twin Model");

  ledger.coordinate({
    kind: "cancel-before-start",
    workOrderKey: remote.workOrderKey,
  });
  const reused = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-order-reused-remote-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: remoteSupervisor,
  });
  assert.equal(reused.status, "authorized");
  assert.equal(
    ledger.snapshot().orders.filter((order) => order.slot.state === "owned")
      .length,
    2,
  );
  assertAllAdapterEffectsZero(fixture);
  ledger.close();
});

test("a different Directory epoch replaces only fully terminal history and preserves exact old endpoint keys", (t) => {
  const original = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "terminal-epoch-replacement");
  const first = createRuntimeWorkOrderLedger({
    databasePath,
    directory: original.directory,
  });
  const submission = first.coordinate({
    kind: "submit",
    workOrder: workOrderFor(original, {
      idempotencyKey: "ledger-order-terminal-epoch-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(original, "local", "full-access"),
  });
  first.coordinate({
    kind: "cancel-before-start",
    workOrderKey: submission.workOrderKey,
  });
  first.close();

  const replacement = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  assert.notEqual(
    replacement.snapshot.directorySnapshotKey,
    original.snapshot.directorySnapshotKey,
  );
  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: replacement.directory,
  });
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.revision, 4);
  assert.equal(
    snapshot.directorySnapshotKey,
    replacement.snapshot.directorySnapshotKey,
  );
  assert.equal(
    snapshot.orders[0]?.directorySnapshotKey,
    original.snapshot.directorySnapshotKey,
  );
  assert.equal(
    snapshot.orders[0]?.endpointSnapshotKey,
    original.remote.endpointSnapshotKey,
  );
  assert.equal(snapshot.orders[0]?.slot.state, "released");
  assertAllAdapterEffectsZero(original);
  assertAllAdapterEffectsZero(replacement);
  reopened.close();
});

test("a different Directory epoch with surviving ownership fails closed without database mutation", (t) => {
  const original = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "owned-epoch-reconciliation");
  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: original.directory,
  });
  ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(original, {
      idempotencyKey: "ledger-order-owned-epoch-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(original, "local", "full-access"),
  });
  ledger.close();
  const before = readFileSync(databasePath);
  const replacement = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });

  assert.throws(
    () =>
      createRuntimeWorkOrderLedger({
        databasePath,
        directory: replacement.directory,
      }),
    fixedLedgerError("directory-reconciliation-required"),
  );
  assert.deepEqual(readFileSync(databasePath), before);
  assertAllAdapterEffectsZero(original);
  assertAllAdapterEffectsZero(replacement);
});

test("a Directory denial is durable while idempotency conflicts and post-close calls never mutate", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "denial-conflict-close");
  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-durable-denial-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });
  const staleBinding = {
    ...supervisorFor(fixture, "local", "full-access"),
    endpointSnapshotKey: `rtek_${"Q".repeat(32)}` as typeof fixture.local.endpointSnapshotKey,
  };
  const denied = ledger.coordinate({
    kind: "submit",
    workOrder,
    boundSupervisor: staleBinding,
  });
  if (denied.kind !== "submission") assert.fail("expected submission");
  assert.equal(denied.status, "denied");
  assert.equal(denied.denialCategory, "selection-invalid");
  assert.deepEqual(ledger.snapshot().orders[0]?.slot, {
    state: "unreserved",
    units: 1,
    acquiredRevision: null,
    releasedRevision: null,
  });
  assert.deepEqual(
    ledger.coordinate({ kind: "submit", workOrder, boundSupervisor: staleBinding }),
    denied,
  );
  assert.throws(
    () =>
      ledger.coordinate({
        kind: "submit",
        workOrder: { ...workOrder, objective: "A conflicting objective." },
        boundSupervisor: staleBinding,
      }),
    fixedLedgerError("idempotency-conflict"),
  );
  assert.throws(
    () =>
      ledger.coordinate({
        kind: "submit",
        workOrder,
        boundSupervisor: { ...staleBinding, sessionKey: "conflicting-session" },
      }),
    fixedLedgerError("idempotency-conflict"),
  );
  ledger.close();
  const before = readFileSync(databasePath);
  assert.throws(() => ledger.snapshot(), fixedLedgerError("ledger-closed"));
  assert.throws(
    () =>
      ledger.coordinate({
        kind: "cancel-before-start",
        workOrderKey: denied.workOrderKey,
      }),
    fixedLedgerError("ledger-closed"),
  );
  ledger.close();
  assert.deepEqual(readFileSync(databasePath), before);
  assertAllAdapterEffectsZero(fixture);
});

test("a late duplicate submission converges on its original authorization fact", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const ledger = createRuntimeWorkOrderLedger({
    databasePath: ownedDatabasePath(t, "late-submission-replay"),
    directory: fixture.directory,
  });
  const workOrder = workOrderFor(fixture, {
    idempotencyKey: "ledger-order-late-submit-replay-001",
    target: "remote",
    slots: 1,
    accessMode: "full-access",
  });
  const boundSupervisor = supervisorFor(fixture, "local", "full-access");
  const original = ledger.coordinate({
    kind: "submit",
    workOrder,
    boundSupervisor,
  });
  ledger.coordinate({
    kind: "cancel-before-start",
    workOrderKey: original.workOrderKey,
  });
  assert.equal(ledger.snapshot().revision, 3);
  assert.deepEqual(
    ledger.coordinate({ kind: "submit", workOrder, boundSupervisor }),
    original,
  );
  assert.equal(ledger.snapshot().revision, 3);
  assertAllAdapterEffectsZero(fixture);
  ledger.close();
});

test("adversarial factory and command shapes fail without evaluating accessors", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const ledger = createRuntimeWorkOrderLedger({
    databasePath: ownedDatabasePath(t, "adversarial-shapes"),
    directory: fixture.directory,
  });
  let reads = 0;
  const accessorCommand = {};
  Object.defineProperty(accessorCommand, "kind", {
    enumerable: true,
    get() {
      reads += 1;
      return "submit";
    },
  });
  assert.throws(
    () => ledger.coordinate(accessorCommand as never),
    fixedLedgerError("command-invalid"),
  );
  const hostileCommand = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("must not escape");
      },
    },
  );
  assert.throws(
    () => ledger.coordinate(hostileCommand as never),
    fixedLedgerError("command-invalid"),
  );
  const hostileOptions = new Proxy(
    {},
    {
      has() {
        throw new Error("must not escape");
      },
      ownKeys() {
        throw new Error("must not escape");
      },
    },
  );
  assert.throws(
    () => createRuntimeWorkOrderLedger(hostileOptions as never),
    fixedLedgerError("command-invalid"),
  );
  assert.equal(reads, 0);
  assertAllAdapterEffectsZero(fixture);
  ledger.close();
});

test("three complete replay summaries over one exact Directory snapshot are byte-identical", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const summaries = [0, 1, 2].map((index) =>
    deterministicReplaySummary(t, fixture, index));
  assert.equal(new Set(summaries).size, 1);
  const hashes = summaries.map(prefixedTestDigest);
  assert.equal(new Set(hashes).size, 1);
  assert.equal(
    hashes[0],
    "sha256:5166899ee6010186bea7a8c00974abe17c5f6640195ead584b4690cae2b0f7e2",
  );
  assertAllAdapterEffectsZero(fixture);
});

test("a retired terminal epoch still rejects a forged re-owned historical slot", (t) => {
  const original = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "historical-terminal-corrupt");
  const first = createRuntimeWorkOrderLedger({
    databasePath,
    directory: original.directory,
  });
  const submission = first.coordinate({
    kind: "submit",
    workOrder: workOrderFor(original, {
      idempotencyKey: "ledger-historical-terminal-corrupt-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(original, "local", "full-access"),
  });
  first.coordinate({
    kind: "cancel-before-start",
    workOrderKey: submission.workOrderKey,
  });
  first.close();
  const replacement = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const rotated = createRuntimeWorkOrderLedger({
    databasePath,
    directory: replacement.directory,
  });
  rotated.close();
  mutateDatabase(databasePath, (database) =>
    database.exec(
      `UPDATE runtime_work_order_ledger_slots
          SET slot_state = 'owned', released_revision = NULL`,
    ));
  assertCorruptDatabaseRejected(
    databasePath,
    replacement,
    "historical-terminal-reowned",
  );
  assertAllAdapterEffectsZero(original);
  assertAllAdapterEffectsZero(replacement);
});

test("a corrupt terminal epoch is rejected before a replacement epoch can mutate it", (t) => {
  const original = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "corrupt-before-epoch-replacement");
  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: original.directory,
  });
  const submission = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(original, {
      idempotencyKey: "ledger-corrupt-before-epoch-replacement-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(original, "local", "full-access"),
  });
  ledger.coordinate({
    kind: "cancel-before-start",
    workOrderKey: submission.workOrderKey,
  });
  ledger.close();
  mutateDatabase(databasePath, (database) =>
    database.exec(
      "UPDATE runtime_work_order_ledger_orders SET effect_phase = 'running'",
    ));
  const before = readFileSync(databasePath);
  const replacement = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  assert.throws(
    () =>
      createRuntimeWorkOrderLedger({
        databasePath,
        directory: replacement.directory,
      }),
    fixedLedgerError("durable-state-invalid"),
  );
  assert.deepEqual(readFileSync(databasePath), before);
  assertAllAdapterEffectsZero(original);
  assertAllAdapterEffectsZero(replacement);
});

test("malformed durable root, schema, and row states fail closed without mutation", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 2, remoteLimit: 2 });
  const acceptedBase = ownedDatabasePath(t, "matrix-accepted-base");
  const acceptedLedger = createRuntimeWorkOrderLedger({
    databasePath: acceptedBase,
    directory: fixture.directory,
    crashPoint: "after-acceptance-before-authorization",
  });
  assert.throws(
    () =>
      acceptedLedger.coordinate({
        kind: "submit",
        workOrder: workOrderFor(fixture, {
          idempotencyKey: "ledger-matrix-accepted-001",
          target: "remote",
          slots: 1,
          accessMode: "full-access",
        }),
        boundSupervisor: supervisorFor(fixture, "local", "full-access"),
      }),
    fixedCrash("after-acceptance-before-authorization"),
  );
  acceptedLedger.close();

  const authorizedBase = ownedDatabasePath(t, "matrix-authorized-base");
  const authorizedLedger = createRuntimeWorkOrderLedger({
    databasePath: authorizedBase,
    directory: fixture.directory,
  });
  authorizedLedger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-matrix-authorized-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  authorizedLedger.close();

  const runningBase = ownedDatabasePath(t, "matrix-running-base");
  const runningLedger = createRuntimeWorkOrderLedger({
    databasePath: runningBase,
    directory: fixture.directory,
  });
  startRunningOrder(
    runningLedger,
    fixture,
    "ledger-matrix-running-001",
  );
  runningLedger.close();

  const terminalBase = ownedDatabasePath(t, "matrix-terminal-base");
  const terminalLedger = createRuntimeWorkOrderLedger({
    databasePath: terminalBase,
    directory: fixture.directory,
  });
  const terminalSubmission = terminalLedger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-matrix-terminal-001",
      target: "local",
      slots: 1,
      accessMode: "restricted",
    }),
    boundSupervisor: supervisorFor(fixture, "remote", "restricted"),
  });
  terminalLedger.coordinate({
    kind: "cancel-before-start",
    workOrderKey: terminalSubmission.workOrderKey,
  });
  terminalLedger.close();

  const duplicateBase = ownedDatabasePath(t, "matrix-duplicate-base");
  const duplicateLedger = createRuntimeWorkOrderLedger({
    databasePath: duplicateBase,
    directory: fixture.directory,
  });
  for (const [index, target] of ["remote", "local"].entries()) {
    duplicateLedger.coordinate({
      kind: "submit",
      workOrder: workOrderFor(fixture, {
        idempotencyKey: `ledger-matrix-duplicate-00${index + 1}`,
        target: target as "local" | "remote",
        slots: 1,
        accessMode: "full-access",
      }),
      boundSupervisor: supervisorFor(fixture, "local", "full-access"),
    });
  }
  duplicateLedger.close();

  const deniedBase = ownedDatabasePath(t, "matrix-denied-base");
  const deniedLedger = createRuntimeWorkOrderLedger({
    databasePath: deniedBase,
    directory: fixture.directory,
  });
  const denied = deniedLedger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-matrix-denied-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: {
      ...supervisorFor(fixture, "local", "full-access"),
      endpointSnapshotKey: `rtek_${"S".repeat(32)}` as typeof fixture.local.endpointSnapshotKey,
    },
  });
  assert.equal(denied.status, "denied");
  deniedLedger.close();

  const staleDirectory = `rtdk_${"D".repeat(32)}`;
  const staleEndpoint = `rtek_${"E".repeat(32)}`;
  const staleProfile = `rtpk_${"P".repeat(32)}`;
  const zeroDigest = `sha256:${"0".repeat(64)}`;
  const matrix = [
    {
      name: "root-extra-table",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec("CREATE TABLE forged_root (value TEXT) STRICT"),
    },
    {
      name: "root-extra-nonprefixed-index",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "CREATE INDEX unrelated_order_lifecycle_idx ON runtime_work_order_ledger_orders(lifecycle_state)",
        ),
    },
    {
      name: "root-extra-view",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "CREATE VIEW unrelated_order_keys AS SELECT work_order_key FROM runtime_work_order_ledger_orders",
        ),
    },
    {
      name: "root-extra-trigger",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          `CREATE TRIGGER unrelated_revision_audit
             AFTER UPDATE OF revision ON runtime_work_order_ledger_meta
             BEGIN SELECT NEW.revision; END`,
        ),
    },
    {
      name: "schema-extra-column",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "ALTER TABLE runtime_work_order_ledger_slots ADD COLUMN forged TEXT",
        ),
    },
    {
      name: "root-revision-underflow",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_meta SET revision = -1",
        ),
    },
    {
      name: "root-revision-behind-order",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_meta SET revision = 1",
        ),
    },
    {
      name: "current-epoch-marked-retired",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_epochs SET retired_revision = 3",
        ),
    },
    {
      name: "event-revision-ahead-of-root",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_events SET revision = 99",
        ),
    },
    {
      name: "row-shape-malformed-intent",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_orders SET intent_json = '{}'",
        ),
    },
    {
      name: "work-order-digest-conflict",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_orders SET work_order_digest = ?",
          )
          .run(zeroDigest),
    },
    {
      name: "accepted-phase-disagreement",
      base: acceptedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_orders SET effect_phase = 'committed'",
        ),
    },
    {
      name: "denied-unreserved-slot-shape",
      base: deniedBase,
      mutate: (database: DatabaseSync) =>
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_slots SET endpoint_snapshot_key = ?",
          )
          .run(staleEndpoint),
    },
    {
      name: "authorized-forged-claim",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_orders SET active_claim_key = ?",
          )
          .run(`rwck_${"C".repeat(32)}`),
    },
    {
      name: "malformed-ledger-key",
      base: authorizedBase,
      mutate: (database: DatabaseSync) => {
        const malformed = "work-order-not-opaque";
        database.exec("PRAGMA defer_foreign_keys = ON");
        for (const table of [
          "runtime_work_order_ledger_authorizations",
          "runtime_work_order_ledger_slots",
          "runtime_work_order_ledger_events",
        ]) {
          database
            .prepare(`UPDATE ${table} SET work_order_key = ?`)
            .run(malformed);
        }
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_orders SET work_order_key = ?",
          )
          .run(malformed);
      },
    },
    {
      name: "supervisor-binding-conflict",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_orders SET supervisor_binding_digest = ?",
          )
          .run(zeroDigest),
    },
    {
      name: "stale-directory-authorization",
      base: authorizedBase,
      mutate: (database: DatabaseSync) => {
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_authorizations SET directory_snapshot_key = ?",
          )
          .run(staleDirectory);
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_slots SET directory_snapshot_key = ?",
          )
          .run(staleDirectory);
      },
    },
    {
      name: "stale-endpoint-authorization",
      base: authorizedBase,
      mutate: (database: DatabaseSync) => {
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_authorizations SET worker_endpoint_snapshot_key = ?",
          )
          .run(staleEndpoint);
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_slots SET endpoint_snapshot_key = ?",
          )
          .run(staleEndpoint);
      },
    },
    {
      name: "stale-profile-authorization",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database
          .prepare(
            "UPDATE runtime_work_order_ledger_authorizations SET worker_profile_snapshot_key = ?",
          )
          .run(staleProfile),
    },
    {
      name: "slot-unit-underflow",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec("UPDATE runtime_work_order_ledger_slots SET slot_units = 0"),
    },
    {
      name: "invalid-slot-revisions",
      base: authorizedBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          `UPDATE runtime_work_order_ledger_slots
              SET slot_state = 'released',
                  released_revision = acquired_revision`,
        ),
    },
    {
      name: "terminal-phase-disagreement",
      base: terminalBase,
      mutate: (database: DatabaseSync) =>
        database.exec(
          "UPDATE runtime_work_order_ledger_orders SET effect_phase = 'running'",
        ),
    },
    {
      name: "terminal-revision-ahead-of-root",
      base: terminalBase,
      mutate: (database: DatabaseSync) => {
        database.exec(
          "UPDATE runtime_work_order_ledger_orders SET terminal_revision = 99",
        );
        database.exec(
          "UPDATE runtime_work_order_ledger_slots SET released_revision = 99",
        );
      },
    },
    {
      name: "duplicate-idempotency-key",
      base: duplicateBase,
      mutate: (database: DatabaseSync) => {
        database.exec(
          `DROP INDEX runtime_work_order_ledger_orders_idempotency_uidx;
           UPDATE runtime_work_order_ledger_orders
              SET idempotency_key = 'ledger-matrix-forged-duplicate';
           CREATE INDEX runtime_work_order_ledger_orders_idempotency_uidx
               ON runtime_work_order_ledger_orders(idempotency_key)`,
        );
      },
    },
    {
      name: "duplicate-worker-linkage",
      base: runningBase,
      mutate: (database: DatabaseSync) => {
        database.exec(
          `DROP INDEX runtime_work_order_ledger_workers_order_uidx;
           CREATE INDEX runtime_work_order_ledger_workers_order_uidx
               ON runtime_work_order_ledger_workers(work_order_key)`,
        );
        database
          .prepare(
            `INSERT INTO runtime_work_order_ledger_workers (
               worker_key, work_order_key, directory_snapshot_key,
               endpoint_snapshot_key, profile_snapshot_key, access_mode,
               lifecycle_state, created_revision, progress_sequence,
               handoff_digest, control_state, terminal_revision
             )
             SELECT ?, work_order_key, directory_snapshot_key,
                    endpoint_snapshot_key, profile_snapshot_key, access_mode,
                    lifecycle_state, created_revision, progress_sequence,
                    handoff_digest, control_state, terminal_revision
               FROM runtime_work_order_ledger_workers LIMIT 1`,
          )
          .run(`rwwk_${"W".repeat(32)}`);
      },
    },
  ] as const;

  for (const corrupt of matrix) {
    const databasePath = ownedDatabasePath(t, `matrix-${corrupt.name}`);
    copyFileSync(corrupt.base, databasePath);
    mutateDatabase(databasePath, corrupt.mutate);
    assertCorruptDatabaseRejected(databasePath, fixture, corrupt.name);
  }
  const matrixHash = prefixedTestDigest(
    `${matrix.map((entry) => entry.name).join("\n")}\n`,
  );
  assert.equal(
    matrixHash,
    "sha256:b4cc0e4b053678fb81359895002548a66552369d3e8e99daa1a4fec60c00da15",
  );
  assertAllAdapterEffectsZero(fixture);
});

test("the exact combined non-prefixed root-object canary rejects byte-preservingly before effects", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });
  const databasePath = ownedDatabasePath(t, "combined-root-object-canary");
  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  ledger.close();

  mutateDatabase(databasePath, (database) =>
    database.exec(
      `CREATE INDEX unrelated_order_lifecycle_idx
           ON runtime_work_order_ledger_orders(lifecycle_state);
       CREATE VIEW unrelated_order_keys AS
           SELECT work_order_key FROM runtime_work_order_ledger_orders;
       CREATE TRIGGER unrelated_revision_audit
           AFTER UPDATE OF revision ON runtime_work_order_ledger_meta
           BEGIN SELECT NEW.revision; END`,
    ));

  assertCorruptDatabaseRejected(
    databasePath,
    fixture,
    "combined-nonprefixed-index-view-trigger",
  );
  const canaryHash = prefixedTestDigest(
    "extra-nonprefixed-index\nextra-nonprefixed-view\nextra-nonprefixed-trigger\n",
  );
  assert.equal(
    canaryHash,
    "sha256:9697834e40d009be8a78b04d8a837811991918af04b2d49ba8b7851500659b19",
  );
  assertAllAdapterEffectsZero(fixture);
});

test("the exact forged owned-slot and Worker-link canaries reject before any intent", (t) => {
  const fixture = createDirectoryFixture({ localLimit: 1, remoteLimit: 1 });

  const pairBase = ownedDatabasePath(t, "canary-limit-one-base");
  const pairLedger = createRuntimeWorkOrderLedger({
    databasePath: pairBase,
    directory: fixture.directory,
  });
  const first = pairLedger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-canary-limit-one-first-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  const second = pairLedger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-canary-limit-one-second-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  assert.equal(first.status, "authorized");
  assert.equal(second.status, "denied");
  pairLedger.close();
  const overLimit = ownedDatabasePath(t, "canary-limit-one-forged");
  copyFileSync(pairBase, overLimit);
  mutateDatabase(overLimit, (database) => {
    database.prepare(
      `INSERT INTO runtime_work_order_ledger_authorizations (
         work_order_key, directory_snapshot_key,
         supervisor_endpoint_snapshot_key, supervisor_profile_snapshot_key,
         worker_endpoint_snapshot_key, worker_profile_snapshot_key,
         access_mode, host_capability_ceiling, budget_units, slot_units,
         endpoint_concurrency_limit, work_order_digest, authorization_revision
       )
       SELECT denied.work_order_key, source.directory_snapshot_key,
              source.supervisor_endpoint_snapshot_key,
              source.supervisor_profile_snapshot_key,
              source.worker_endpoint_snapshot_key,
              source.worker_profile_snapshot_key, source.access_mode,
              source.host_capability_ceiling, source.budget_units,
              source.slot_units, source.endpoint_concurrency_limit,
              denied.work_order_digest, denied.authorization_revision
         FROM runtime_work_order_ledger_orders AS denied,
              runtime_work_order_ledger_authorizations AS source
        WHERE denied.work_order_key = ? AND source.work_order_key = ?`,
    ).run(second.workOrderKey, first.workOrderKey);
    database
      .prepare(
        `UPDATE runtime_work_order_ledger_orders
            SET lifecycle_state = 'authorized', effect_phase = 'unclaimed',
                denial_category = NULL, terminal_revision = NULL
          WHERE work_order_key = ?`,
      )
      .run(second.workOrderKey);
    database.prepare(
      `UPDATE runtime_work_order_ledger_slots
          SET slot_state = 'owned',
              directory_snapshot_key = (
                SELECT directory_snapshot_key
                  FROM runtime_work_order_ledger_authorizations
                 WHERE work_order_key = ?
              ),
              endpoint_snapshot_key = (
                SELECT worker_endpoint_snapshot_key
                  FROM runtime_work_order_ledger_authorizations
                 WHERE work_order_key = ?
              ),
              acquired_revision = (
                SELECT authorization_revision
                  FROM runtime_work_order_ledger_orders
                 WHERE work_order_key = ?
              ),
              released_revision = NULL
        WHERE work_order_key = ?`,
    ).run(
      second.workOrderKey,
      second.workOrderKey,
      second.workOrderKey,
      second.workOrderKey,
    );
  });
  assertCorruptDatabaseRejected(overLimit, fixture, "two-owned-at-limit-one");

  const runningBase = ownedDatabasePath(t, "canary-running-base");
  const runningLedger = createRuntimeWorkOrderLedger({
    databasePath: runningBase,
    directory: fixture.directory,
  });
  startRunningOrder(
    runningLedger,
    fixture,
    "ledger-canary-running-released-001",
  );
  runningLedger.close();
  const runningReleased = ownedDatabasePath(t, "canary-running-released");
  copyFileSync(runningBase, runningReleased);
  mutateDatabase(runningReleased, (database) =>
    database.exec(
      `UPDATE runtime_work_order_ledger_slots
          SET slot_state = 'released', released_revision = (
            SELECT revision FROM runtime_work_order_ledger_meta
          )`,
    ));
  assertCorruptDatabaseRejected(runningReleased, fixture, "running-released");

  const recoveryBase = ownedDatabasePath(t, "canary-recovery-base");
  const recoverySetup = createRuntimeWorkOrderLedger({
    databasePath: recoveryBase,
    directory: fixture.directory,
  });
  const recoverySubmission = recoverySetup.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-canary-recovery-released-001",
      target: "local",
      slots: 1,
      accessMode: "restricted",
    }),
    boundSupervisor: supervisorFor(fixture, "remote", "restricted"),
  });
  recoverySetup.close();
  const recoveryCrash = createRuntimeWorkOrderLedger({
    databasePath: recoveryBase,
    directory: fixture.directory,
    crashPoint: "after-effect-claim-before-external-acknowledgement",
  });
  assert.throws(
    () =>
      recoveryCrash.coordinate({
        kind: "claim-start",
        workOrderKey: recoverySubmission.workOrderKey,
      }),
    fixedCrash("after-effect-claim-before-external-acknowledgement"),
  );
  recoveryCrash.close();
  const recovery = createRuntimeWorkOrderLedger({
    databasePath: recoveryBase,
    directory: fixture.directory,
  });
  assert.equal(recovery.snapshot().orders[0]?.effectPhase, "outcome-unknown");
  recovery.close();
  const recoveryReleased = ownedDatabasePath(t, "canary-recovery-released");
  copyFileSync(recoveryBase, recoveryReleased);
  mutateDatabase(recoveryReleased, (database) =>
    database.exec(
      `UPDATE runtime_work_order_ledger_slots
          SET slot_state = 'released', released_revision = (
            SELECT revision FROM runtime_work_order_ledger_meta
          )`,
    ));
  assertCorruptDatabaseRejected(
    recoveryReleased,
    fixture,
    "outcome-unknown-released",
  );

  const endpointBase = ownedDatabasePath(t, "canary-endpoint-base");
  const endpointLedger = createRuntimeWorkOrderLedger({
    databasePath: endpointBase,
    directory: fixture.directory,
  });
  endpointLedger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey: "ledger-canary-endpoint-mismatch-001",
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  endpointLedger.close();
  const endpointMismatch = ownedDatabasePath(t, "canary-endpoint-mismatch");
  copyFileSync(endpointBase, endpointMismatch);
  mutateDatabase(endpointMismatch, (database) =>
    database
      .prepare(
        "UPDATE runtime_work_order_ledger_slots SET endpoint_snapshot_key = ?",
      )
      .run(fixture.local.endpointSnapshotKey));
  assertCorruptDatabaseRejected(
    endpointMismatch,
    fixture,
    "owned-under-different-endpoint",
  );

  const canaryHash = prefixedTestDigest(
    "two-owned-at-limit-one\nrunning-released\noutcome-unknown-released\nowned-under-different-endpoint\ndifferent-epoch-owned\n",
  );
  assert.equal(
    canaryHash,
    "sha256:1d2e071bbc9f97fa79e805e7f9e66dc02a5e1567646760436de15b270e9b9e03",
  );
  assertAllAdapterEffectsZero(fixture);
});

type DirectoryFixture = ReturnType<typeof createDirectoryFixture>;
type EndpointSnapshot = RuntimeEndpointDirectorySnapshot["endpoints"][number];

function createDirectoryFixture(limits: {
  readonly localLimit: number;
  readonly remoteLimit: number;
}) {
  const localAdapter = new InMemoryLedgerEndpointAdapter();
  const remoteAdapter = new InMemoryLedgerEndpointAdapter();
  const directory = createRuntimeEndpointDirectory([
    ledgerRegistration({
      registrationId: "ledger-local-registration",
      endpointId: "ledger-local-endpoint",
      runtimeFamily: "family-a",
      executionLocation: "local",
      adapter: localAdapter,
      modelLabel: "Twin Model",
      nativeModel: "private-local-model",
      availableConcurrency: limits.localLimit,
      allowedWorkerEndpointIds: [
        "ledger-local-endpoint",
        "ledger-remote-endpoint",
      ],
    }),
    ledgerRegistration({
      registrationId: "ledger-remote-registration",
      endpointId: "ledger-remote-endpoint",
      runtimeFamily: "family-b",
      executionLocation: "remote-backed",
      adapter: remoteAdapter,
      modelLabel: "Twin Model",
      nativeModel: "private-remote-model",
      availableConcurrency: limits.remoteLimit,
      allowedWorkerEndpointIds: [
        "ledger-local-endpoint",
        "ledger-remote-endpoint",
      ],
    }),
  ]);
  const snapshot = directory.snapshot();
  const local = requiredEndpoint(snapshot, "family-a", "local");
  const remote = requiredEndpoint(snapshot, "family-b", "remote-backed");
  return {
    directory,
    snapshot,
    local,
    remote,
    localFull: requiredAccessProfile(local, "full-access"),
    localRestricted: requiredAccessProfile(local, "restricted"),
    remoteFull: requiredAccessProfile(remote, "full-access"),
    remoteRestricted: requiredAccessProfile(remote, "restricted"),
    adapters: [localAdapter, remoteAdapter] as const,
  };
}

function ledgerRegistration(input: {
  readonly registrationId: string;
  readonly endpointId: string;
  readonly runtimeFamily: string;
  readonly executionLocation: "local" | "remote-backed";
  readonly adapter: AgentRuntimeAdapter;
  readonly modelLabel: string;
  readonly nativeModel: string;
  readonly availableConcurrency: number;
  readonly allowedWorkerEndpointIds: readonly string[];
}): RuntimeEndpointRegistration {
  const profile = (
    accessMode: "full-access" | "restricted",
  ): RuntimeEndpointRegistration["capabilitySnapshot"]["profiles"][number] => ({
    profileId: `${input.endpointId}-${accessMode}`,
    modelLabel: input.modelLabel,
    workIntensityLabel:
      accessMode === "full-access" ? "Maximum" : "Constrained",
    runtimeProfile: {
      model: input.nativeModel,
      effortLevel: "maximum",
      executionMode: "single-agent",
      accessMode,
    },
  });
  return {
    registrationId: input.registrationId,
    endpointId: input.endpointId,
    runtimeFamily: input.runtimeFamily,
    executionLocation: input.executionLocation,
    adapter: input.adapter,
    capabilitySnapshot: {
      snapshotId: `${input.endpointId}-capabilities-1`,
      freshness: "fresh",
      availability: "online",
      contracts: {
        supervisorWorkOrders: true,
        workerSessions: true,
        normalizedEvents: true,
      },
      profiles: [profile("full-access"), profile("restricted")],
    },
    policy: {
      maximumBudgetUnits: 100,
      availableConcurrency: input.availableConcurrency,
      allowedAccessModes: ["full-access", "restricted"],
      allowedWorkerEndpointIds: input.allowedWorkerEndpointIds,
    },
  };
}

function workOrderFor(
  fixture: DirectoryFixture,
  input: {
    readonly idempotencyKey: string;
    readonly target: "local" | "remote";
    readonly slots: number;
    readonly accessMode: "full-access" | "restricted";
  },
): RuntimeNeutralWorkOrder {
  const endpoint = input.target === "local" ? fixture.local : fixture.remote;
  const profile = requiredAccessProfile(endpoint, input.accessMode);
  return {
    idempotencyKey: input.idempotencyKey,
    objective: "Complete one bounded Runtime-neutral Work Order.",
    input: "Return one sanitized Handoff after deterministic progress.",
    directorySnapshotKey: fixture.snapshot.directorySnapshotKey,
    endpointSnapshotKey: endpoint.endpointSnapshotKey,
    profileSnapshotKey: profile.profileSnapshotKey,
    requestedAccessMode: input.accessMode,
    budget: { units: 10 },
    concurrency: { slots: input.slots },
  };
}

function supervisorFor(
  fixture: DirectoryFixture,
  source: "local" | "remote",
  accessMode: "full-access" | "restricted",
): BoundSupervisorSession {
  const endpoint = source === "local" ? fixture.local : fixture.remote;
  return {
    sessionKey: `supervisor-session-${source}-${accessMode}`,
    directorySnapshotKey: fixture.snapshot.directorySnapshotKey,
    endpointSnapshotKey: endpoint.endpointSnapshotKey,
    profileSnapshotKey:
      requiredAccessProfile(endpoint, accessMode).profileSnapshotKey,
  };
}

function requiredEndpoint(
  snapshot: RuntimeEndpointDirectorySnapshot,
  runtimeFamily: string,
  executionLocation: "local" | "remote-backed",
): EndpointSnapshot {
  const endpoint = snapshot.endpoints.find(
    (candidate) =>
      candidate.runtimeFamily === runtimeFamily &&
      candidate.executionLocation === executionLocation,
  );
  assert.ok(endpoint);
  return endpoint;
}

function requiredAccessProfile(
  endpoint: EndpointSnapshot,
  accessMode: "full-access" | "restricted",
) {
  const profile = endpoint.profiles.find(
    (candidate) => candidate.accessMode === accessMode,
  );
  assert.ok(profile);
  return profile;
}

function ownedDatabasePath(t: TestContext, name: string): string {
  const verifiedParent = realpathSync(tmpdir());
  const root = realpathSync(
    mkdtempSync(join(verifiedParent, "uaw-worker-32-ledger-")),
  );
  assert.equal(dirname(root), verifiedParent);
  assert.equal(root.startsWith(`${verifiedParent}\\`), true);
  t.after(() => {
    const resolvedRoot = realpathSync(root);
    assert.equal(dirname(resolvedRoot), verifiedParent);
    assert.equal(resolvedRoot, root);
    rmSync(resolvedRoot, { recursive: true, force: false });
  });
  return resolve(root, `${name}.sqlite`);
}

function assertAllAdapterEffectsZero(fixture: DirectoryFixture): void {
  for (const adapter of fixture.adapters) {
    assert.deepEqual(adapter.effects, {
      inspect: 0,
      start: 0,
      resume: 0,
      send: 0,
      event: 0,
    });
  }
}

function startRunningOrder(
  ledger: ReturnType<typeof createRuntimeWorkOrderLedger>,
  fixture: DirectoryFixture,
  idempotencyKey: string,
): { readonly workOrderKey: string; readonly workerKey: string } {
  const submission = ledger.coordinate({
    kind: "submit",
    workOrder: workOrderFor(fixture, {
      idempotencyKey,
      target: "remote",
      slots: 1,
      accessMode: "full-access",
    }),
    boundSupervisor: supervisorFor(fixture, "local", "full-access"),
  });
  const claim = ledger.coordinate({
    kind: "claim-start",
    workOrderKey: submission.workOrderKey,
  });
  assert.equal(claim.kind, "effect-intent");
  const running = ledger.coordinate({
    kind: "confirm-start",
    workOrderKey: submission.workOrderKey,
    claimKey: claim.effectIntent.claimKey,
    outcome: "started",
  });
  assert.equal(running.status, "running");
  return {
    workOrderKey: submission.workOrderKey,
    workerKey: claim.effectIntent.workerKey,
  };
}

function assertFrozenTree(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozenTree(child);
}

function deterministicReplaySummary(
  t: TestContext,
  fixture: DirectoryFixture,
  index: number,
): string {
  const databasePath = ownedDatabasePath(t, `deterministic-replay-${index}`);
  const ledger = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const submit = (
    idempotencyKey: string,
    target: "local" | "remote",
    accessMode: "full-access" | "restricted",
  ) =>
    ledger.coordinate({
      kind: "submit",
      workOrder: workOrderFor(fixture, {
        idempotencyKey,
        target,
        slots: 1,
        accessMode,
      }),
      boundSupervisor: supervisorFor(
        fixture,
        target === "local" ? "remote" : "local",
        accessMode,
      ),
    });
  const start = (submission: ReturnType<typeof submit>) => {
    const claim = ledger.coordinate({
      kind: "claim-start",
      workOrderKey: submission.workOrderKey,
    });
    if (claim.kind !== "effect-intent") assert.fail("expected start claim");
    const running = ledger.coordinate({
      kind: "confirm-start",
      workOrderKey: submission.workOrderKey,
      claimKey: claim.effectIntent.claimKey,
      outcome: "started",
    });
    assert.equal(running.status, "running");
    return {
      workOrderKey: submission.workOrderKey,
      workerKey: claim.effectIntent.workerKey,
    };
  };

  const completed = start(
    submit("ledger-replay-completed-001", "remote", "full-access"),
  );
  ledger.coordinate({
    kind: "record-progress",
    workOrderKey: completed.workOrderKey,
    workerKey: completed.workerKey,
    sequence: 1,
  });
  ledger.coordinate({
    kind: "record-handoff",
    workOrderKey: completed.workOrderKey,
    workerKey: completed.workerKey,
    handoffKey: "ledger-replay-handoff-001",
  });

  const preStart = submit(
    "ledger-replay-prestart-cancelled-001",
    "local",
    "restricted",
  );
  ledger.coordinate({
    kind: "cancel-before-start",
    workOrderKey: preStart.workOrderKey,
  });

  const failed = submit(
    "ledger-replay-start-failed-001",
    "remote",
    "restricted",
  );
  const failedClaim = ledger.coordinate({
    kind: "claim-start",
    workOrderKey: failed.workOrderKey,
  });
  if (failedClaim.kind !== "effect-intent") assert.fail("expected start claim");
  ledger.coordinate({
    kind: "confirm-start",
    workOrderKey: failed.workOrderKey,
    claimKey: failedClaim.effectIntent.claimKey,
    outcome: "failed",
  });

  const cancelled = start(
    submit("ledger-replay-running-cancelled-001", "local", "full-access"),
  );
  const cancelClaim = ledger.coordinate({
    kind: "claim-control",
    workOrderKey: cancelled.workOrderKey,
    workerKey: cancelled.workerKey,
    action: "cancel",
  });
  if (cancelClaim.kind !== "effect-intent") assert.fail("expected control claim");
  ledger.coordinate({
    kind: "confirm-control",
    workOrderKey: cancelled.workOrderKey,
    workerKey: cancelled.workerKey,
    claimKey: cancelClaim.effectIntent.claimKey,
    outcome: "committed",
  });

  const interrupted = start(
    submit("ledger-replay-running-interrupted-001", "local", "restricted"),
  );
  const interruptClaim = ledger.coordinate({
    kind: "claim-control",
    workOrderKey: interrupted.workOrderKey,
    workerKey: interrupted.workerKey,
    action: "interrupt",
  });
  if (interruptClaim.kind !== "effect-intent") {
    assert.fail("expected control claim");
  }
  ledger.coordinate({
    kind: "confirm-control",
    workOrderKey: interrupted.workOrderKey,
    workerKey: interrupted.workerKey,
    claimKey: interruptClaim.effectIntent.claimKey,
    outcome: "committed",
  });
  ledger.close();

  const reopened = createRuntimeWorkOrderLedger({
    databasePath,
    directory: fixture.directory,
  });
  const snapshot = reopened.snapshot();
  const endpointRole = (key: string) => {
    if (key === fixture.local.endpointSnapshotKey) return "local";
    if (key === fixture.remote.endpointSnapshotKey) return "remote";
    assert.fail("unknown endpoint key in replay summary");
  };
  const profileRole = (key: string) => {
    const profiles = [
      [fixture.localFull.profileSnapshotKey, "local-full"],
      [fixture.localRestricted.profileSnapshotKey, "local-restricted"],
      [fixture.remoteFull.profileSnapshotKey, "remote-full"],
      [fixture.remoteRestricted.profileSnapshotKey, "remote-restricted"],
    ] as const;
    const profile = profiles.find(([profileKey]) => profileKey === key);
    assert.ok(profile);
    return profile[1];
  };
  const summary = {
    revision: snapshot.revision,
    orders: snapshot.orders.map((order) => ({
      endpoint: endpointRole(order.endpointSnapshotKey),
      profile: profileRole(order.profileSnapshotKey),
      accessMode: order.requestedAccessMode,
      lifecycle: order.lifecycle,
      effectPhase: order.effectPhase,
      denialCategory: order.denialCategory,
      slot: order.slot,
      worker: order.worker === null
        ? null
        : {
            lifecycle: order.worker.lifecycle,
            progressSequence: order.worker.progressSequence,
            handoffState: order.worker.handoffState,
            controlState: order.worker.controlState,
          },
    })),
  };
  reopened.close();
  assertAllAdapterEffectsZero(fixture);
  return `${JSON.stringify(summary)}\n`;
}

function mutateDatabase(
  databasePath: string,
  mutation: (database: DatabaseSync) => unknown,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("PRAGMA ignore_check_constraints = ON");
    mutation(database);
  } finally {
    database.close();
  }
}

function assertCorruptDatabaseRejected(
  databasePath: string,
  fixture: DirectoryFixture,
  label: string,
): void {
  const before = readFileSync(databasePath);
  assert.throws(
    () =>
      createRuntimeWorkOrderLedger({
        databasePath,
        directory: fixture.directory,
      }),
    fixedLedgerError("durable-state-invalid"),
    label,
  );
  assert.deepEqual(readFileSync(databasePath), before, label);
  assertAllAdapterEffectsZero(fixture);
}

function prefixedTestDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function fixedLedgerError(
  category: RuntimeWorkOrderLedgerError["category"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RuntimeWorkOrderLedgerError &&
    error.category === category &&
    error.message === "Runtime Work Order Ledger operation failed." &&
    error.stack ===
      "RuntimeWorkOrderLedgerError: Runtime Work Order Ledger operation failed.";
}

function fixedCrash(
  point: RuntimeWorkOrderLedgerCrashError["point"],
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof RuntimeWorkOrderLedgerCrashError &&
    error.point === point &&
    error.message === "Runtime Work Order Ledger simulated crash." &&
    error.stack ===
      "RuntimeWorkOrderLedgerCrashError: Runtime Work Order Ledger simulated crash.";
}
