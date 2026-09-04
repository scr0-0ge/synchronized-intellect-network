import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  expectedJourneyEventKinds,
  journeyScenarios,
  type DurableCommandObservation,
  type PerReplyAttributionLiveEvidence,
  type SanitizedUserJourneyObservation,
  type UserJourneyDurableEvidenceRow,
  type UserJourneyEvidenceArtifact,
  type UserJourneyEvidenceSeal,
  type UserJourneyObservation,
  type UserJourneyRunOptions,
} from "./contracts.ts";

export async function finalWriteAndSealAttributionEvidence(
  evidencePath: string,
  evidence: PerReplyAttributionLiveEvidence,
): Promise<UserJourneyEvidenceSeal> {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const expectedBytes = Buffer.from(serialized, "utf8");
  await mkdir(dirname(evidencePath), { recursive: true });
  const pendingPath = join(
    dirname(evidencePath),
    `.${basename(evidencePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    await writeFile(pendingPath, expectedBytes, { flag: "wx" });
    await rename(pendingPath, evidencePath);
    renamed = true;
  } finally {
    if (!renamed) await rm(pendingPath, { force: true });
  }
  const finalBytes = await readFile(evidencePath);
  assert.equal(finalBytes.equals(expectedBytes), true);
  assert.deepEqual(
    JSON.parse(finalBytes.toString("utf8")),
    JSON.parse(serialized),
  );
  return Object.freeze({
    path: evidencePath,
    bytes: finalBytes.byteLength,
    sha256: createHash("sha256").update(finalBytes).digest("hex"),
  });
}

export function readDurableCommands(databasePath: string): readonly DurableCommandObservation[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT command_kind, status, accepted_cursor, target_session_id
           FROM commands
          ORDER BY accepted_cursor`,
      )
      .all() as unknown as Array<{
      command_kind: unknown;
      status: unknown;
      accepted_cursor: unknown;
      target_session_id: unknown;
    }>;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          commandKind:
            row.command_kind === "start" || row.command_kind === "continue"
              ? row.command_kind
              : "missing",
          status: typeof row.status === "string" ? row.status : "missing",
          acceptedCursor:
            typeof row.accepted_cursor === "number" ? row.accepted_cursor : -1,
          targetSessionId:
            typeof row.target_session_id === "string"
              ? row.target_session_id
              : null,
        }),
      ),
    );
  } finally {
    database.close();
  }
}

export function durableTargetMatchesPair(
  rows: readonly DurableCommandObservation[],
  index: number,
): boolean {
  const pairStart = index - (index % 2);
  const start = rows[pairStart];
  const continued = rows[pairStart + 1];
  return (
    start?.status === "completed" &&
    continued?.status === "completed" &&
    start.targetSessionId !== null &&
    start.targetSessionId === continued.targetSessionId
  );
}

export async function readUserJourneyEvidenceArtifact(
  evidencePath: string,
): Promise<UserJourneyEvidenceArtifact> {
  const resolvedPath = resolveEvidencePath(evidencePath);
  return parseUserJourneyEvidence(await readFile(resolvedPath, "utf8"));
}

export async function exportUserJourneyEvidence(
  options: UserJourneyRunOptions,
  temporaryRoot: string,
  observations: readonly UserJourneyObservation[],
  durableRows: readonly DurableCommandObservation[],
): Promise<void> {
  if (options.evidencePath === undefined) return;
  const evidencePath = resolveEvidencePath(options.evidencePath);
  assertEvidenceOutsideTemporaryRoot(evidencePath, temporaryRoot);
  const current = createUserJourneyEvidence(observations, durableRows);
  const existing = await readExistingUserJourneyEvidence(evidencePath);
  const combined = mergeUserJourneyEvidence(existing, current);
  const seal = await finalWriteAndSealEvidence(evidencePath, combined);
  if (options.onEvidenceSealed === undefined) {
    emitEvidenceSeal(seal);
  } else {
    options.onEvidenceSealed(seal);
  }
}

function createUserJourneyEvidence(
  observations: readonly UserJourneyObservation[],
  durableRows: readonly DurableCommandObservation[],
): UserJourneyEvidenceArtifact {
  assert.ok(observations.length > 0);
  assert.equal(observations.length, durableRows.length);
  const source = observations[0]!.source;
  const sanitizedObservations = observations.map((observation) =>
    Object.freeze({
      schema: "live-user-journey-sanitized-observation-v1" as const,
      name: observation.name,
      source: observation.source,
      runtime: observation.runtime,
      runtimeObserved: observation.runtimeObserved,
      language: observation.language,
      commandKind: observation.commandKind,
      durableCommandKind: observation.durableCommandKind,
      accepted: observation.accepted,
      eventCount: observation.eventCount,
      eventKinds: Object.freeze([...observation.eventKinds]),
      terminalState: observation.terminalState,
      replySummary: observation.replySummary,
      replyMatchesExpected: observation.replyMatchesExpected,
      agentSessionCount: observation.agentSessionCount,
      sameTargetSession: observation.sameTargetSession,
      sameAgentSessionRow: observation.sameAgentSessionRow,
    }),
  );
  const sanitizedDurableRows = observations.map((observation, index) => {
    const durable = durableRows[index];
    assert.ok(durable);
    assert.equal(durable.commandKind, observation.commandKind);
    assert.equal(durable.status, "completed");
    assert.ok(Number.isSafeInteger(durable.acceptedCursor));
    assert.ok(durable.acceptedCursor >= 0);
    assert.equal(observation.sameTargetSession, true);
    return Object.freeze({
      schema: "live-user-journey-durable-row-v1" as const,
      name: observation.name,
      runtime: observation.runtime,
      sequence: observation.commandKind === "start" ? (1 as const) : (2 as const),
      commandKind: observation.commandKind,
      status: "completed" as const,
      acceptedCursor: durable.acceptedCursor,
      targetSession: `${observation.runtime}-session-1` as
        | "codex-session-1"
        | "claude-session-1",
    });
  });
  return parseUserJourneyEvidence(
    `${JSON.stringify(
      {
        schema: "live-user-journey-evidence-v1",
        source,
        observations: sanitizedObservations,
        durableRows: sanitizedDurableRows,
      },
      null,
      2,
    )}\n`,
  );
}

async function readExistingUserJourneyEvidence(
  evidencePath: string,
): Promise<UserJourneyEvidenceArtifact | undefined> {
  try {
    return parseUserJourneyEvidence(await readFile(evidencePath, "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function mergeUserJourneyEvidence(
  existing: UserJourneyEvidenceArtifact | undefined,
  current: UserJourneyEvidenceArtifact,
): UserJourneyEvidenceArtifact {
  if (existing === undefined) return current;
  if (existing.source !== current.source) {
    throw new Error("journey-evidence-schema-invalid:source-mismatch");
  }
  const existingNames = new Set(
    existing.observations.map((observation) => observation.name),
  );
  for (const observation of current.observations) {
    if (existingNames.has(observation.name)) {
      throw new Error("journey-evidence-schema-invalid:duplicate-scenario");
    }
  }
  const order = new Map(
    journeyScenarios.map((scenario, index) => [scenario.name, index] as const),
  );
  const observations = [...existing.observations, ...current.observations].sort(
    (left, right) => order.get(left.name)! - order.get(right.name)!,
  );
  const durableRows = [...existing.durableRows, ...current.durableRows].sort(
    (left, right) => order.get(left.name)! - order.get(right.name)!,
  );
  return parseUserJourneyEvidence(
    `${JSON.stringify(
      {
        schema: "live-user-journey-evidence-v1",
        source: current.source,
        observations,
        durableRows,
      },
      null,
      2,
    )}\n`,
  );
}

async function finalWriteAndSealEvidence(
  evidencePath: string,
  evidence: UserJourneyEvidenceArtifact,
): Promise<UserJourneyEvidenceSeal> {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const expectedBytes = Buffer.from(serialized, "utf8");
  await mkdir(dirname(evidencePath), { recursive: true });
  const pendingPath = join(
    dirname(evidencePath),
    `.${basename(evidencePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let renamed = false;
  try {
    await writeFile(pendingPath, expectedBytes, { flag: "wx" });
    await rename(pendingPath, evidencePath);
    renamed = true;
  } finally {
    if (!renamed) await rm(pendingPath, { force: true });
  }
  const finalBytes = await readFile(evidencePath);
  if (!finalBytes.equals(expectedBytes)) {
    throw new Error("journey-evidence-final-write-changed");
  }
  parseUserJourneyEvidence(finalBytes.toString("utf8"));
  return Object.freeze({
    path: evidencePath,
    bytes: finalBytes.byteLength,
    sha256: createHash("sha256").update(finalBytes).digest("hex"),
  });
}

function parseUserJourneyEvidence(serialized: string): UserJourneyEvidenceArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("journey-evidence-schema-invalid:json");
  }
  const root = exactEvidenceRecord(
    parsed,
    ["schema", "source", "observations", "durableRows"],
    "root",
  );
  if (root.schema !== "live-user-journey-evidence-v1") {
    throw new Error("journey-evidence-schema-invalid:root-schema");
  }
  const source = root.source;
  if (source !== "test-double" && source !== "production-renderer-live") {
    throw new Error("journey-evidence-schema-invalid:root-source");
  }
  if (!Array.isArray(root.observations) || !Array.isArray(root.durableRows)) {
    throw new Error("journey-evidence-schema-invalid:root-arrays");
  }
  const observations = root.observations.map((value) =>
    parseSanitizedObservation(value, source),
  );
  const durableRows = root.durableRows.map(parseDurableEvidenceRow);
  assertEvidenceCollection(source, observations, durableRows);
  return Object.freeze({
    schema: "live-user-journey-evidence-v1" as const,
    source,
    observations: Object.freeze(observations),
    durableRows: Object.freeze(durableRows),
  });
}

function parseSanitizedObservation(
  value: unknown,
  source: UserJourneyEvidenceArtifact["source"],
): SanitizedUserJourneyObservation {
  const observation = exactEvidenceRecord(
    value,
    [
      "schema",
      "name",
      "source",
      "runtime",
      "runtimeObserved",
      "language",
      "commandKind",
      "durableCommandKind",
      "accepted",
      "eventCount",
      "eventKinds",
      "terminalState",
      "replySummary",
      "replyMatchesExpected",
      "agentSessionCount",
      "sameTargetSession",
      "sameAgentSessionRow",
    ],
    "observation",
  );
  const scenario = journeyScenarios.find(
    (candidate) => candidate.name === observation.name,
  );
  if (scenario === undefined) {
    throw new Error("journey-evidence-schema-invalid:observation-name");
  }
  const allowedSessionCounts =
    source === "production-renderer-live" ? [1] : [1, 2];
  if (
    observation.schema !== "live-user-journey-sanitized-observation-v1" ||
    observation.source !== source ||
    observation.runtime !== scenario.runtime ||
    observation.runtimeObserved !== scenario.runtime ||
    observation.language !== scenario.language ||
    observation.commandKind !== scenario.commandKind ||
    observation.durableCommandKind !== scenario.commandKind ||
    observation.accepted !== true ||
    observation.eventCount !== expectedJourneyEventKinds.length ||
    observation.terminalState !== "completed" ||
    observation.replySummary !== scenario.expectedReply ||
    observation.replyMatchesExpected !== true ||
    typeof observation.agentSessionCount !== "number" ||
    !allowedSessionCounts.includes(observation.agentSessionCount) ||
    observation.sameTargetSession !== true ||
    observation.sameAgentSessionRow !== true ||
    !Array.isArray(observation.eventKinds) ||
    observation.eventKinds.length !== expectedJourneyEventKinds.length ||
    !observation.eventKinds.every(
      (kind, index) => kind === expectedJourneyEventKinds[index],
    )
  ) {
    throw new Error("journey-evidence-schema-invalid:observation-value");
  }
  return Object.freeze({
    schema: "live-user-journey-sanitized-observation-v1" as const,
    name: scenario.name,
    source,
    runtime: scenario.runtime,
    runtimeObserved: scenario.runtime,
    language: scenario.language,
    commandKind: scenario.commandKind,
    durableCommandKind: scenario.commandKind,
    accepted: true as const,
    eventCount: expectedJourneyEventKinds.length,
    eventKinds: Object.freeze([...expectedJourneyEventKinds]),
    terminalState: "completed" as const,
    replySummary: scenario.expectedReply,
    replyMatchesExpected: true as const,
    agentSessionCount: observation.agentSessionCount,
    sameTargetSession: true as const,
    sameAgentSessionRow: true as const,
  });
}

function parseDurableEvidenceRow(value: unknown): UserJourneyDurableEvidenceRow {
  const row = exactEvidenceRecord(
    value,
    [
      "schema",
      "name",
      "runtime",
      "sequence",
      "commandKind",
      "status",
      "acceptedCursor",
      "targetSession",
    ],
    "durable-row",
  );
  const scenario = journeyScenarios.find((candidate) => candidate.name === row.name);
  if (scenario === undefined) {
    throw new Error("journey-evidence-schema-invalid:durable-row-name");
  }
  const sequence = scenario.commandKind === "start" ? 1 : 2;
  const targetSession = `${scenario.runtime}-session-1` as
    | "codex-session-1"
    | "claude-session-1";
  if (
    row.schema !== "live-user-journey-durable-row-v1" ||
    row.runtime !== scenario.runtime ||
    row.sequence !== sequence ||
    row.commandKind !== scenario.commandKind ||
    row.status !== "completed" ||
    !Number.isSafeInteger(row.acceptedCursor) ||
    typeof row.acceptedCursor !== "number" ||
    row.acceptedCursor < 0 ||
    row.targetSession !== targetSession
  ) {
    throw new Error("journey-evidence-schema-invalid:durable-row-value");
  }
  return Object.freeze({
    schema: "live-user-journey-durable-row-v1" as const,
    name: scenario.name,
    runtime: scenario.runtime,
    sequence,
    commandKind: scenario.commandKind,
    status: "completed" as const,
    acceptedCursor: row.acceptedCursor,
    targetSession,
  });
}

function assertEvidenceCollection(
  source: UserJourneyEvidenceArtifact["source"],
  observations: readonly SanitizedUserJourneyObservation[],
  durableRows: readonly UserJourneyDurableEvidenceRow[],
): void {
  if (observations.length !== durableRows.length) {
    throw new Error("journey-evidence-schema-invalid:collection-length");
  }
  const names = observations.map((observation) => observation.name);
  const uniqueNames = new Set(names);
  const allowedLengths = [2, 4];
  if (!allowedLengths.includes(names.length) || uniqueNames.size !== names.length) {
    throw new Error("journey-evidence-schema-invalid:collection-members");
  }
  const sessionCounts = observations.map(
    (observation) => observation.agentSessionCount,
  );
  const allCountsAreOne = sessionCounts.every((count) => count === 1);
  const fullSingleRunCounts = [1, 1, 2, 2].every(
    (count, index) => sessionCounts[index] === count,
  );
  const validSessionCounts =
    allCountsAreOne ||
    (source === "test-double" && names.length === 4 && fullSingleRunCounts);
  if (!validSessionCounts) {
    throw new Error("journey-evidence-schema-invalid:session-counts");
  }
  const canonicalNames = journeyScenarios
    .filter((scenario) => uniqueNames.has(scenario.name))
    .map((scenario) => scenario.name);
  if (canonicalNames.some((name, index) => names[index] !== name)) {
    throw new Error("journey-evidence-schema-invalid:collection-order");
  }
  for (const runtime of ["codex", "claude"] as const) {
    const runtimeNames = names.filter((name) => name.startsWith(`${runtime}-`));
    if (runtimeNames.length !== 0 && runtimeNames.length !== 2) {
      throw new Error("journey-evidence-schema-invalid:runtime-pair");
    }
  }
  for (const [index, row] of durableRows.entries()) {
    const observation = observations[index];
    if (
      observation === undefined ||
      row.name !== observation.name ||
      row.runtime !== observation.runtime ||
      row.commandKind !== observation.commandKind
    ) {
      throw new Error("journey-evidence-schema-invalid:row-observation-pair");
    }
  }
  for (const runtime of ["codex", "claude"] as const) {
    const pair = durableRows.filter((row) => row.runtime === runtime);
    if (
      pair.length === 2 &&
      !(pair[0]!.acceptedCursor < pair[1]!.acceptedCursor)
    ) {
      throw new Error("journey-evidence-schema-invalid:cursor-order");
    }
  }
}

function exactEvidenceRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`journey-evidence-schema-invalid:${label}-object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`journey-evidence-schema-invalid:${label}-keys`);
  }
  return value as Record<string, unknown>;
}

export function resolveEvidencePath(evidencePath: string): string {
  if (evidencePath.trim().length === 0) {
    throw new Error("journey-evidence-path-empty");
  }
  return resolve(evidencePath);
}

function assertEvidenceOutsideTemporaryRoot(
  evidencePath: string,
  temporaryRoot: string,
): void {
  const relation = relative(resolve(temporaryRoot), evidencePath);
  const outside =
    relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
  if (!outside) {
    throw new Error("journey-evidence-path-inside-routine-root");
  }
}

export function emitEvidenceSeal(seal: UserJourneyEvidenceSeal): void {
  console.log(`LIVE_USER_JOURNEY_EVIDENCE ${JSON.stringify(seal)}`);
}

export async function findOnlyProjectLedger(userDataDirectory: string): Promise<string> {
  const ledgerDirectory = join(
    userDataDirectory,
    "workbench-project-host",
    "project-ledgers",
  );
  const entries = await readdir(ledgerDirectory, { withFileTypes: true });
  const ledgers = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".sqlite"),
  );
  assert.equal(ledgers.length, 1, "isolated user data must contain one Project ledger");
  return join(ledgerDirectory, ledgers[0]!.name);
}
