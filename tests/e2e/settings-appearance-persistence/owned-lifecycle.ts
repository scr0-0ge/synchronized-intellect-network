import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ElectronApplication } from "playwright";

export type OwnedChildExitState = Readonly<{
  hasExited: () => boolean;
  exited: Promise<void>;
}>;

export type OwnedApplication = Readonly<{
  application: ElectronApplication;
  child: ChildProcess;
  exitState: OwnedChildExitState;
  pid: number;
  userData: string;
}>;

export type FailureFact = Readonly<{
  step: string;
  category: string;
}>;

export type OwnedCleanupFact = Readonly<{
  pidCaptured: true;
  gracefulCloseAttempted: boolean;
  gracefulCloseSucceeded: boolean;
  terminationFallbackUsed: boolean;
  forcedExactChildTerminationRequested: boolean;
  exited: boolean;
}>;

export type OwnedCleanupOutcome = Readonly<{
  fact: OwnedCleanupFact;
  failures: readonly FailureFact[];
}>;

export type ExactOwnedChildTerminationOutcome = Readonly<{
  cleanupKind: "exact-owned-child-termination-fallback";
  forcedExactChildTerminationRequested: boolean;
  exited: boolean;
  failure: FailureFact | null;
}>;

export type SelectedLedgerNoAcceptedOrInFlightFact = Readonly<{
  source: "selected-project-ledger";
  observation: "no-accepted-or-in-flight-commands";
  projectHostIdleEstablished: false;
}>;

const projectHostDirectoryName = "workbench-project-host";
const projectRegistryFileName = "project-registry-v1.json";
const projectLedgerDirectoryName = "project-ledgers";
const projectLedgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function closeOwnedApplication(
  owned: OwnedApplication,
  liveApplications: Set<OwnedApplication>,
): Promise<Readonly<{
  appQuitRequested: true;
  pidCaptured: true;
  forcedExactChildTerminationRequested: false;
  exited: true;
}>> {
  await withTimeout(owned.application.close(), 10_000);
  await waitForOwnedChildExit(owned, 5_000);
  liveApplications.delete(owned);
  return Object.freeze({
    appQuitRequested: true,
    pidCaptured: true,
    forcedExactChildTerminationRequested: false,
    exited: true,
  });
}

export async function terminateExactOwnedApplicationChild(
  owned: OwnedApplication,
  liveApplications: Set<OwnedApplication>,
): Promise<ExactOwnedChildTerminationOutcome> {
  let forcedExactChildTerminationRequested = false;
  let failure: FailureFact | null = null;
  try {
    assert.equal(owned.child.pid, owned.pid);
    if (!owned.exitState.hasExited()) {
      forcedExactChildTerminationRequested = true;
      owned.child.kill();
    }
    await waitForOwnedChildExit(owned, 5_000);
  } catch {
    failure = failureFact(
      "final-exact-owned-child-termination",
      "exact-owned-child-termination-failed",
    );
  }
  const exited = owned.exitState.hasExited();
  if (exited) liveApplications.delete(owned);
  return Object.freeze({
    cleanupKind: "exact-owned-child-termination-fallback",
    forcedExactChildTerminationRequested,
    exited,
    failure,
  });
}

export async function cleanupOwnedApplicationLifecycle(
  owned: OwnedApplication,
  liveApplications: Set<OwnedApplication>,
): Promise<OwnedCleanupOutcome> {
  const failures: FailureFact[] = [];
  let selectedLedgerProxyEstablished = false;
  try {
    await selectedLedgerNoAcceptedOrInFlightFact(owned.userData);
    selectedLedgerProxyEstablished = true;
  } catch {
    failures.push(
      failureFact("final-selected-ledger-proxy", "selected-ledger-proxy-unavailable"),
    );
  }

  if (selectedLedgerProxyEstablished) {
    try {
      await closeOwnedApplication(owned, liveApplications);
      return Object.freeze({
        fact: Object.freeze({
          pidCaptured: true,
          gracefulCloseAttempted: true,
          gracefulCloseSucceeded: true,
          terminationFallbackUsed: false,
          forcedExactChildTerminationRequested: false,
          exited: true,
        }),
        failures,
      });
    } catch {
      failures.push(
        failureFact("final-application-close", "owned-application-close-failed"),
      );
    }
  }

  const termination = await terminateExactOwnedApplicationChild(
    owned,
    liveApplications,
  );
  if (termination.failure !== null) failures.push(termination.failure);
  return Object.freeze({
    fact: Object.freeze({
      pidCaptured: true,
      gracefulCloseAttempted: selectedLedgerProxyEstablished,
      gracefulCloseSucceeded: false,
      terminationFallbackUsed: true,
      forcedExactChildTerminationRequested:
        termination.forcedExactChildTerminationRequested,
      exited: termination.exited,
    }),
    failures,
  });
}

export async function selectedLedgerNoAcceptedOrInFlightFact(
  userData: string,
): Promise<SelectedLedgerNoAcceptedOrInFlightFact> {
  const registryContents = await readFile(
    join(userData, projectHostDirectoryName, projectRegistryFileName),
    "utf8",
  );
  const registry: unknown = JSON.parse(registryContents);
  assert.ok(
    isExactRecord(registry, [
      "nextProjectOrdinal",
      "records",
      "revision",
      "schemaVersion",
      "selectedRecordKey",
    ]),
  );
  assert.equal(registry.schemaVersion, 1);
  assert.equal(typeof registry.selectedRecordKey, "string");
  assert.ok(Array.isArray(registry.records));
  const selected = registry.records.find(
    (candidate: unknown) =>
      isExactRecord(candidate, [
        "canonicalDirectory",
        "ledgerSlot",
        "recordKey",
      ]) && candidate.recordKey === registry.selectedRecordKey,
  );
  assert.ok(
    isExactRecord(selected, [
      "canonicalDirectory",
      "ledgerSlot",
      "recordKey",
    ]),
  );
  if (typeof selected.ledgerSlot !== "string") {
    assert.fail("selected Project ledger slot is not a string");
  }
  const ledgerSlot = selected.ledgerSlot;
  assert.match(ledgerSlot, projectLedgerSlotPattern);

  const database = new DatabaseSync(
    join(
      userData,
      projectHostDirectoryName,
      projectLedgerDirectoryName,
      `${ledgerSlot}.sqlite`,
    ),
    { readOnly: true },
  );
  try {
    const project = database
      .prepare("SELECT project_id FROM projects LIMIT 1")
      .get() as { readonly project_id: string } | undefined;
    if (typeof project?.project_id !== "string") {
      assert.fail("selected Project ledger has no Project identity");
    }
    const projectId = project.project_id;
    const row = database
      .prepare(
        `SELECT status
           FROM commands
          WHERE project_id = ?
            AND status IN ('accepted', 'in-flight')
          ORDER BY CASE status WHEN 'in-flight' THEN 0 ELSE 1 END,
                   accepted_cursor
          LIMIT 1`,
      )
      .get(projectId) as
      | { readonly status: "accepted" | "in-flight" }
      | undefined;
    assert.equal(row, undefined);
  } finally {
    database.close();
  }
  return Object.freeze({
    source: "selected-project-ledger",
    observation: "no-accepted-or-in-flight-commands",
    projectHostIdleEstablished: false,
  });
}

export async function assertAllOwnedChildrenExited(
  applications: ReadonlySet<OwnedApplication>,
): Promise<void> {
  for (const owned of applications) {
    assert.equal(owned.child.pid, owned.pid);
    assert.equal(owned.exitState.hasExited(), true);
  }
}

export function failureFact(step: string, category: string): FailureFact {
  return Object.freeze({ step, category });
}

export function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every(
      (key) =>
        keys.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.value !== undefined,
    )
  );
}

async function waitForOwnedChildExit(
  owned: OwnedApplication,
  timeout: number,
): Promise<void> {
  assert.equal(owned.child.pid, owned.pid);
  await withTimeout(owned.exitState.exited, timeout);
  assert.equal(owned.exitState.hasExited(), true);
}

function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error("operation-timeout")), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectValue(error);
      },
    );
  });
}
