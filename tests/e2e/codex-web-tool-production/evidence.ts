import { createHash } from "node:crypto";
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

import {
  DriverFailure,
  isRecord,
  type CodexWebToolProductionEvidence,
  type CodexWebToolProductionRetainedDiagnostic,
  type DiagnosticArtifactSeal,
  type DiagnosticCounts,
  type ProtocolCounts,
} from "./contract.ts";
import { nativeErrorCode } from "./guarded-root.ts";
import {
  parsePublicAnswer,
  type TransportMetrics,
} from "./tracked-transport.ts";

const diagnosticKinds = [
  "direct-launch-succeeded",
  "direct-launch-failed",
  "staging-started",
  "staging-succeeded",
  "staging-failed",
  "staged-launch-succeeded",
  "staged-launch-failed",
  "shutdown-forced",
  "cleanup-succeeded",
  "cleanup-failed",
] as const;

type DiagnosticKind = (typeof diagnosticKinds)[number];

export type DiagnosticCursor = Readonly<{ bytes: Buffer }>;

export async function readCodexWebToolProductionEvidence(
  evidencePath: string,
): Promise<CodexWebToolProductionEvidence> {
  return parseEvidence(await readFile(evidencePath, "utf8"));
}

export function createEvidence(
  metrics: TransportMetrics,
  diagnostics: DiagnosticCounts,
  answer: Readonly<{ title: string; url: string }>,
  stagingNewResidue: number,
): CodexWebToolProductionEvidence {
  return Object.freeze({
    schema: "codex-web-tool-production-v1" as const,
    source: "production-codex-subscription" as const,
    result: "passed" as const,
    observations: Object.freeze({
      durableAccepted: true as const,
      terminalCompleted: true as const,
      protocol: Object.freeze({ ...metrics.protocol }),
      finalAgentMessages: 1 as const,
      title: answer.title,
      url: answer.url,
      projectManifestUnchanged: true as const,
    }),
    lifecycle: Object.freeze({
      transportsCreated: metrics.created,
      transportsStopped: metrics.stopped,
      transportsActive: 0 as const,
      transportStopFailures: 0 as const,
      backendClosed: true as const,
      observationDisposed: true as const,
      stagingNewResidue: stagingNewResidue as 0,
      guardedRootRemoved: true as const,
    }),
    transportDiagnostics: Object.freeze({ ...diagnostics }),
  });
}

export function createRetainedDiagnostic(
  evidence: CodexWebToolProductionEvidence,
): CodexWebToolProductionRetainedDiagnostic {
  return Object.freeze({
    schema: "codex-web-tool-production-retained-v1" as const,
    source: evidence.source,
    result: "final-pass-not-reopened" as const,
    observations: evidence.observations,
    lifecycle: Object.freeze({
      transportsCreated: evidence.lifecycle.transportsCreated,
      transportsStopped: evidence.lifecycle.transportsStopped,
      transportsActive: 0 as const,
      transportStopFailures: 0 as const,
      backendClosed: true as const,
      observationDisposed: true as const,
      stagingNewResidue: 0 as const,
      guardedRootRemovalReady: true as const,
    }),
    transportDiagnostics: evidence.transportDiagnostics,
  });
}

export async function publishFinalEvidence(
  pendingPath: string,
  finalPath: string,
): Promise<void> {
  await rename(pendingPath, finalPath);
}

export async function reopenRetainedDiagnostic(
  path: string,
  expectedBytes: Buffer,
): Promise<Buffer> {
  const reopened = await readFile(path);
  if (!reopened.equals(expectedBytes)) {
    throw new DriverFailure("evidence-write");
  }
  parseRetainedDiagnostic(reopened.toString("utf8"));
  return reopened;
}

export async function retainVerifiedDiagnostic(
  path: string,
  expectedBytes: Buffer,
): Promise<DiagnosticArtifactSeal> {
  try {
    let reopened: Buffer;
    try {
      reopened = await reopenRetainedDiagnostic(path, expectedBytes);
    } catch {
      await removePendingEvidence(path);
      await writeFile(path, expectedBytes, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      reopened = await reopenRetainedDiagnostic(path, expectedBytes);
    }
    return Object.freeze({
      retained: true as const,
      bytes: reopened.byteLength,
      sha256: createHash("sha256").update(reopened).digest("hex"),
    });
  } catch {
    return Object.freeze({ retained: false as const });
  }
}

export function parseEvidence(
  serialized: string,
): CodexWebToolProductionEvidence {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (
      !hasExactKeys(value, [
        "lifecycle",
        "observations",
        "result",
        "schema",
        "source",
        "transportDiagnostics",
      ]) ||
      value.schema !== "codex-web-tool-production-v1" ||
      value.source !== "production-codex-subscription" ||
      value.result !== "passed" ||
      !hasExactKeys(value.observations, [
        "durableAccepted",
        "finalAgentMessages",
        "projectManifestUnchanged",
        "protocol",
        "terminalCompleted",
        "title",
        "url",
      ]) ||
      value.observations.durableAccepted !== true ||
      value.observations.terminalCompleted !== true ||
      value.observations.finalAgentMessages !== 1 ||
      value.observations.projectManifestUnchanged !== true ||
      typeof value.observations.title !== "string" ||
      typeof value.observations.url !== "string" ||
      !hasExactKeys(value.observations.protocol, [
        "approvalRequests",
        "itemCompleted",
        "itemStarted",
        "turnCompleted",
        "webSearchCompleted",
        "webSearchStarted",
      ]) ||
      !hasExactKeys(value.lifecycle, [
        "backendClosed",
        "guardedRootRemoved",
        "observationDisposed",
        "stagingNewResidue",
        "transportStopFailures",
        "transportsActive",
        "transportsCreated",
        "transportsStopped",
      ]) ||
      value.lifecycle.backendClosed !== true ||
      value.lifecycle.guardedRootRemoved !== true ||
      value.lifecycle.observationDisposed !== true ||
      value.lifecycle.stagingNewResidue !== 0 ||
      value.lifecycle.transportStopFailures !== 0 ||
      value.lifecycle.transportsActive !== 0 ||
      !hasExactKeys(value.transportDiagnostics, [
        "cleanupFailed",
        "cleanupSucceeded",
        "directLaunchFailed",
        "directLaunchSucceeded",
        "shutdownForced",
        "stagedLaunchFailed",
        "stagedLaunchSucceeded",
        "stagingFailed",
        "stagingStarted",
        "stagingSucceeded",
      ])
    ) {
      throw new Error("invalid");
    }
    const counts = [
      ...Object.values(value.observations.protocol),
      value.lifecycle.transportsCreated,
      value.lifecycle.transportsStopped,
      ...Object.values(value.transportDiagnostics),
    ];
    const protocol = value.observations.protocol as unknown as ProtocolCounts;
    const transportDiagnostics =
      value.transportDiagnostics as unknown as DiagnosticCounts;
    if (
      counts.some(
        (count) =>
          typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0,
      ) ||
      protocol.approvalRequests !== 0 ||
      protocol.webSearchStarted < 1 ||
      protocol.webSearchCompleted < 1 ||
      protocol.turnCompleted < 1 ||
      protocol.webSearchStarted !== protocol.webSearchCompleted ||
      protocol.webSearchStarted > protocol.itemStarted ||
      protocol.webSearchCompleted > protocol.itemCompleted ||
      value.lifecycle.transportsCreated !== 3 ||
      value.lifecycle.transportsStopped !== 3 ||
      value.lifecycle.transportsStopped !== value.lifecycle.transportsCreated ||
      !diagnosticLifecycleIsCoherent(
        transportDiagnostics,
        value.lifecycle.transportsCreated,
      )
    ) {
      throw new Error("invalid");
    }
    parsePublicAnswer(
      `TITLE: ${value.observations.title}\nURL: ${value.observations.url}`,
    );
    return value as CodexWebToolProductionEvidence;
  } catch {
    throw new Error("codex-web-tool-production-evidence-invalid");
  }
}

function parseRetainedDiagnostic(
  serialized: string,
): CodexWebToolProductionRetainedDiagnostic {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (
      !hasExactKeys(value, [
        "lifecycle",
        "observations",
        "result",
        "schema",
        "source",
        "transportDiagnostics",
      ]) ||
      value.schema !== "codex-web-tool-production-retained-v1" ||
      value.source !== "production-codex-subscription" ||
      value.result !== "final-pass-not-reopened" ||
      !hasExactKeys(value.lifecycle, [
        "backendClosed",
        "guardedRootRemovalReady",
        "observationDisposed",
        "stagingNewResidue",
        "transportStopFailures",
        "transportsActive",
        "transportsCreated",
        "transportsStopped",
      ]) ||
      value.lifecycle.backendClosed !== true ||
      value.lifecycle.guardedRootRemovalReady !== true ||
      value.lifecycle.observationDisposed !== true ||
      value.lifecycle.stagingNewResidue !== 0 ||
      value.lifecycle.transportStopFailures !== 0 ||
      value.lifecycle.transportsActive !== 0
    ) {
      throw new Error("invalid");
    }
    parseEvidence(
      JSON.stringify({
        schema: "codex-web-tool-production-v1",
        source: value.source,
        result: "passed",
        observations: value.observations,
        lifecycle: {
          transportsCreated: value.lifecycle.transportsCreated,
          transportsStopped: value.lifecycle.transportsStopped,
          transportsActive: value.lifecycle.transportsActive,
          transportStopFailures: value.lifecycle.transportStopFailures,
          backendClosed: value.lifecycle.backendClosed,
          observationDisposed: value.lifecycle.observationDisposed,
          stagingNewResidue: value.lifecycle.stagingNewResidue,
          guardedRootRemoved: true,
        },
        transportDiagnostics: value.transportDiagnostics,
      }),
    );
    return value as CodexWebToolProductionRetainedDiagnostic;
  } catch {
    throw new Error("codex-web-tool-production-retained-invalid");
  }
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function emptyDiagnosticCounts(): DiagnosticCounts {
  return {
    directLaunchSucceeded: 0,
    directLaunchFailed: 0,
    stagingStarted: 0,
    stagingSucceeded: 0,
    stagingFailed: 0,
    stagedLaunchSucceeded: 0,
    stagedLaunchFailed: 0,
    shutdownForced: 0,
    cleanupSucceeded: 0,
    cleanupFailed: 0,
  };
}

export async function readDiagnosticCursor(
  path: string,
): Promise<DiagnosticCursor> {
  try {
    return Object.freeze({ bytes: await readFile(path) });
  } catch (error) {
    if (nativeErrorCode(error) === "ENOENT") {
      return Object.freeze({ bytes: Buffer.alloc(0) });
    }
    throw new DriverFailure("transport-diagnostics");
  }
}

export async function readNewDiagnosticCounts(
  path: string,
  cursor: DiagnosticCursor,
): Promise<DiagnosticCounts> {
  let after: Buffer;
  try {
    after = await readFile(path);
  } catch (error) {
    if (nativeErrorCode(error) === "ENOENT" && cursor.bytes.length === 0) {
      after = Buffer.alloc(0);
    } else {
      throw new DriverFailure("transport-diagnostics");
    }
  }
  const startsWithCursor =
    after.length >= cursor.bytes.length &&
    after.subarray(0, cursor.bytes.length).equals(cursor.bytes);
  const newBytes = startsWithCursor ? after.subarray(cursor.bytes.length) : after;
  const serialized = newBytes.toString("utf8");
  if (serialized.length > 0 && !serialized.endsWith("\n")) {
    throw new DriverFailure("transport-diagnostics");
  }
  const counts = emptyDiagnosticCounts();
  for (const line of serialized.split("\n").filter(Boolean)) {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || !isDiagnosticKind(value.kind)) {
      throw new DriverFailure("transport-diagnostics");
    }
    incrementDiagnostic(counts, value.kind);
  }
  return counts;
}

function isDiagnosticKind(value: unknown): value is DiagnosticKind {
  return (
    typeof value === "string" &&
    (diagnosticKinds as readonly string[]).includes(value)
  );
}

function incrementDiagnostic(
  counts: DiagnosticCounts,
  kind: DiagnosticKind,
): void {
  const keyByKind: Record<DiagnosticKind, keyof DiagnosticCounts> = {
    "direct-launch-succeeded": "directLaunchSucceeded",
    "direct-launch-failed": "directLaunchFailed",
    "staging-started": "stagingStarted",
    "staging-succeeded": "stagingSucceeded",
    "staging-failed": "stagingFailed",
    "staged-launch-succeeded": "stagedLaunchSucceeded",
    "staged-launch-failed": "stagedLaunchFailed",
    "shutdown-forced": "shutdownForced",
    "cleanup-succeeded": "cleanupSucceeded",
    "cleanup-failed": "cleanupFailed",
  };
  counts[keyByKind[kind]] += 1;
}

export function diagnosticLifecycleIsCoherent(
  counts: DiagnosticCounts,
  transportsCreated: number,
): boolean {
  const staged = counts.stagedLaunchSucceeded;
  return (
    counts.directLaunchSucceeded + staged === transportsCreated &&
    counts.directLaunchFailed === staged &&
    counts.stagingStarted === staged &&
    counts.stagingSucceeded === staged &&
    counts.cleanupSucceeded === staged &&
    counts.stagingFailed === 0 &&
    counts.stagedLaunchFailed === 0 &&
    counts.cleanupFailed === 0
  );
}

export async function removePendingEvidence(
  path: string | undefined,
): Promise<void> {
  if (path === undefined) return;
  try {
    await unlink(path);
  } catch (error) {
    if (nativeErrorCode(error) !== "ENOENT") {
      // A fixed failure is returned by the caller; native detail is never emitted.
    }
  }
}
