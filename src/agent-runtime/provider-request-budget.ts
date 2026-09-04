import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  PROVIDER_ATTEMPT_OPERATION_LIMIT,
  PROVIDER_ATTEMPT_PROTOCOL,
  type ProviderAttemptPlan,
  type ProviderAttemptRoundName,
} from "../workbench-shell/provider-attempt-plan.ts";

export type ProviderOperationKind =
  | "codex-initialize"
  | "codex-account-read"
  | "codex-model-list-page"
  | "claude-auth-status"
  | "claude-catalog-initialize"
  | "claude-session-initialize"
  | "claude-inference-frame";

export interface ProviderRequestBudget {
  claim(operation: ProviderOperationKind): Promise<void>;
}

export type ProviderRequestBudgetFailureCategory =
  | "allocation-uncertain"
  | "budget-exhausted"
  | "build-marker-mismatch"
  | "ledger-invalid"
  | "unknown-operation";

export class ProviderRequestBudgetError extends Error {
  readonly category: ProviderRequestBudgetFailureCategory;

  constructor(category: ProviderRequestBudgetFailureCategory) {
    super(`provider-request-budget:${category}`);
    this.name = "ProviderRequestBudgetError";
    this.category = category;
  }
}

export const PROVIDER_REQUEST_BUDGET_MANIFEST = "attempt.json" as const;

export interface CompletedDefaultProviderAttempt {
  readonly complete: true;
  readonly operationCount: number;
  readonly operationLimit: typeof PROVIDER_ATTEMPT_OPERATION_LIMIT;
}

const allocationLockName = "allocation.lock";
const attemptLeafPattern = /^provider-request-attempt-[a-z0-9-]{1,80}$/u;
const claimFilePattern = /^claim-([0-9]{2})\.json$/u;
const roundFilePattern = /^round-([0-9]{2})\.json$/u;
const maximumLedgerFileBytes = 4_096;
const allocationWaitMilliseconds = 5_000;
const operationKinds = new Set<ProviderOperationKind>([
  "codex-initialize",
  "codex-account-read",
  "codex-model-list-page",
  "claude-auth-status",
  "claude-catalog-initialize",
  "claude-session-initialize",
  "claude-inference-frame",
]);
const defaultRoundNames = Object.freeze([
  "independent-headless",
  "item-4-lazy-picker",
  "positive-continuation-composition",
  "positive-new-session-explicit-refresh",
] as const satisfies readonly ProviderAttemptRoundName[]);

interface AttemptManifest {
  readonly protocol: typeof PROVIDER_ATTEMPT_PROTOCOL;
  readonly buildMarker: typeof PROVIDER_ATTEMPT_BUILD_MARKER;
  readonly mode: "default";
  readonly operationLimit: typeof PROVIDER_ATTEMPT_OPERATION_LIMIT;
}

interface ClaimRecord extends AttemptManifest {
  readonly ordinal: number;
  readonly operation: ProviderOperationKind;
}

interface RoundRecord extends AttemptManifest {
  readonly ordinal: number;
  readonly name: ProviderAttemptRoundName;
  readonly firstClaimOrdinal: number;
  readonly lastClaimOrdinal: number;
}

export async function initializeProviderRequestBudget(input: {
  readonly locator: string;
  readonly plan: ProviderAttemptPlan;
}): Promise<void> {
  if (
    !isExactDataRecord(input, ["locator", "plan"]) ||
    !isValidLocator(input.locator) ||
    !isExactDefaultPlan(input.plan)
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const locator = resolve(input.locator);
  try {
    await mkdir(locator, { mode: 0o700 });
    await writeDurableExclusive(
      join(locator, PROVIDER_REQUEST_BUDGET_MANIFEST),
      serializeManifest(defaultManifest()),
    );
  } catch {
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
}

export function openProviderRequestBudget(input: {
  readonly locator: string;
  readonly expectedBuildMarker: string;
}): ProviderRequestBudget {
  const captured = isExactDataRecord(input, ["expectedBuildMarker", "locator"])
    ? Object.freeze({
        locator: input.locator,
        expectedBuildMarker: input.expectedBuildMarker,
      })
    : undefined;
  return Object.freeze({
    async claim(operation: ProviderOperationKind): Promise<void> {
      if (!isProviderOperationKind(operation)) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      if (
        captured === undefined ||
        !isValidLocator(captured.locator) ||
        typeof captured.expectedBuildMarker !== "string"
      ) {
        throw new ProviderRequestBudgetError("ledger-invalid");
      }
      await claimProviderOperation(
        resolve(captured.locator),
        captured.expectedBuildMarker,
        operation,
      );
    },
  });
}

export async function completeProviderAttemptRound(input: {
  readonly locator: string;
  readonly expectedBuildMarker: string;
  readonly name: ProviderAttemptRoundName;
}): Promise<void> {
  if (
    !isExactDataRecord(input, ["expectedBuildMarker", "locator", "name"]) ||
    !isValidLocator(input.locator) ||
    !defaultRoundNames.includes(input.name as ProviderAttemptRoundName)
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  if (input.expectedBuildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER) {
    throw new ProviderRequestBudgetError("build-marker-mismatch");
  }
  const locator = resolve(input.locator);
  const lockPath = join(locator, allocationLockName);
  await validateLocatorDirectory(locator);
  await acquireAllocationLock(lockPath);
  let failure: unknown;
  try {
    const manifest = await readManifest(locator);
    const claims = await readClaims(locator, manifest);
    const rounds = await readRounds(locator, manifest);
    validateRoundRecords(rounds, claims, false);
    const ordinal = rounds.length + 1;
    if (
      ordinal > defaultRoundNames.length ||
      input.name !== defaultRoundNames[ordinal - 1]
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    const firstClaimOrdinal = rounds.at(-1)?.lastClaimOrdinal ?? 0;
    const record: RoundRecord = Object.freeze({
      ...manifest,
      ordinal,
      name: input.name as ProviderAttemptRoundName,
      firstClaimOrdinal: firstClaimOrdinal + 1,
      lastClaimOrdinal: claims.length,
    });
    validateRoundSegment(record, claims);
    const path = join(locator, roundFileName(ordinal));
    await writeDurableExclusive(path, serializeRound(record));
    if ((await readBoundedRegularFile(path)) !== serializeRound(record)) {
      throw new ProviderRequestBudgetError("allocation-uncertain");
    }
  } catch (error) {
    failure = error;
  }
  try {
    await rmdir(lockPath);
  } catch {
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
  if (failure !== undefined) {
    if (failure instanceof ProviderRequestBudgetError) throw failure;
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
}

export async function verifyCompletedDefaultProviderAttempt(input: {
  readonly locator: string;
  readonly expectedBuildMarker: string;
}): Promise<CompletedDefaultProviderAttempt> {
  if (
    !isExactDataRecord(input, ["expectedBuildMarker", "locator"]) ||
    !isValidLocator(input.locator) ||
    input.expectedBuildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const locator = resolve(input.locator);
  const lockPath = join(locator, allocationLockName);
  await validateLocatorDirectory(locator);
  await acquireAllocationLock(lockPath);
  let result: CompletedDefaultProviderAttempt | undefined;
  let failure: unknown;
  try {
    const manifest = await readManifest(locator);
    const claims = await readClaims(locator, manifest);
    const rounds = await readRounds(locator, manifest);
    validateRoundRecords(rounds, claims, true);
    const count = (operation: ProviderOperationKind) =>
      claims.filter((claim) => claim.operation === operation).length;
    if (
      count("codex-initialize") !== 4 ||
      count("codex-account-read") !== 4 ||
      count("codex-model-list-page") < 4 ||
      count("codex-model-list-page") > 8 ||
      count("claude-auth-status") !== 4 ||
      count("claude-catalog-initialize") !== 4 ||
      count("claude-session-initialize") !== 0 ||
      count("claude-inference-frame") !== 0 ||
      claims.length < 20 ||
      claims.length > PROVIDER_ATTEMPT_OPERATION_LIMIT
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    result = Object.freeze({
      complete: true as const,
      operationCount: claims.length,
      operationLimit: PROVIDER_ATTEMPT_OPERATION_LIMIT,
    });
  } catch (error) {
    failure = error;
  }
  try {
    await rmdir(lockPath);
  } catch {
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
  if (failure !== undefined) {
    if (failure instanceof ProviderRequestBudgetError) throw failure;
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
  return result!;
}

async function claimProviderOperation(
  locator: string,
  expectedBuildMarker: string,
  operation: ProviderOperationKind,
): Promise<void> {
  const lockPath = join(locator, allocationLockName);
  await validateLocatorDirectory(locator);
  await acquireAllocationLock(lockPath);
  let failure: unknown;
  try {
    const manifest = await readManifest(locator);
    if (manifest.buildMarker !== expectedBuildMarker) {
      throw new ProviderRequestBudgetError("build-marker-mismatch");
    }
    const claims = await readClaims(locator, manifest);
    validateRoundRecords(
      await readRounds(locator, manifest),
      claims,
      false,
    );
    if (claims.length >= manifest.operationLimit) {
      throw new ProviderRequestBudgetError("budget-exhausted");
    }
    const ordinal = claims.length + 1;
    const record: ClaimRecord = Object.freeze({
      ...manifest,
      ordinal,
      operation,
    });
    const path = join(locator, claimFileName(ordinal));
    await writeDurableExclusive(path, serializeClaim(record));
    if ((await readBoundedRegularFile(path)) !== serializeClaim(record)) {
      throw new ProviderRequestBudgetError("allocation-uncertain");
    }
  } catch (error) {
    failure = error;
  }

  try {
    await rmdir(lockPath);
  } catch {
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
  if (failure !== undefined) {
    if (failure instanceof ProviderRequestBudgetError) throw failure;
    throw new ProviderRequestBudgetError("allocation-uncertain");
  }
}

async function acquireAllocationLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + allocationWaitMilliseconds;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw new ProviderRequestBudgetError("allocation-uncertain");
      }
      try {
        if ((await readdir(lockPath)).length > 0) {
          throw new ProviderRequestBudgetError("allocation-uncertain");
        }
      } catch (inspectionError) {
        if (inspectionError instanceof ProviderRequestBudgetError) {
          throw inspectionError;
        }
        if (hasCode(inspectionError, "ENOENT")) continue;
        throw new ProviderRequestBudgetError("allocation-uncertain");
      }
      if (Date.now() >= deadline) {
        throw new ProviderRequestBudgetError("allocation-uncertain");
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 4));
    }
  }
}

async function readManifest(locator: string): Promise<AttemptManifest> {
  const contents = await readBoundedRegularFile(
    join(locator, PROVIDER_REQUEST_BUDGET_MANIFEST),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  if (
    !isExactDataRecord(parsed, [
      "buildMarker",
      "mode",
      "operationLimit",
      "protocol",
    ]) ||
    parsed.protocol !== PROVIDER_ATTEMPT_PROTOCOL ||
    parsed.buildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER ||
    parsed.mode !== "default" ||
    parsed.operationLimit !== PROVIDER_ATTEMPT_OPERATION_LIMIT
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const manifest = defaultManifest();
  if (contents !== serializeManifest(manifest)) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  return manifest;
}

async function readClaims(
  locator: string,
  manifest: AttemptManifest,
): Promise<readonly ClaimRecord[]> {
  let entries;
  try {
    entries = await readdir(locator, { withFileTypes: true });
  } catch {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const claimEntries = [];
  for (const entry of entries) {
    if (entry.name === PROVIDER_REQUEST_BUDGET_MANIFEST && entry.isFile()) {
      continue;
    }
    if (entry.name === allocationLockName && entry.isDirectory()) continue;
    if (
      roundFilePattern.test(entry.name) &&
      entry.isFile() &&
      !entry.isSymbolicLink()
    ) {
      continue;
    }
    const match = entry.name.match(claimFilePattern);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    claimEntries.push({ name: entry.name, ordinal: Number(match[1]) });
  }
  claimEntries.sort((left, right) => left.ordinal - right.ordinal);
  const claims: ClaimRecord[] = [];
  for (const [index, entry] of claimEntries.entries()) {
    const ordinal = index + 1;
    if (
      entry.ordinal !== ordinal ||
      entry.name !== claimFileName(ordinal) ||
      ordinal > manifest.operationLimit
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    const contents = await readBoundedRegularFile(join(locator, entry.name));
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    if (
      !isExactDataRecord(parsed, [
        "buildMarker",
        "mode",
        "operation",
        "operationLimit",
        "ordinal",
        "protocol",
      ]) ||
      parsed.protocol !== manifest.protocol ||
      parsed.buildMarker !== manifest.buildMarker ||
      parsed.mode !== manifest.mode ||
      parsed.operationLimit !== manifest.operationLimit ||
      parsed.ordinal !== ordinal ||
      !isProviderOperationKind(parsed.operation)
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    const record: ClaimRecord = Object.freeze({
      ...manifest,
      ordinal,
      operation: parsed.operation,
    });
    if (contents !== serializeClaim(record)) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    claims.push(record);
  }
  return Object.freeze(claims);
}

async function readRounds(
  locator: string,
  manifest: AttemptManifest,
): Promise<readonly RoundRecord[]> {
  let entries;
  try {
    entries = await readdir(locator, { withFileTypes: true });
  } catch {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const roundEntries = [];
  for (const entry of entries) {
    if (entry.name === PROVIDER_REQUEST_BUDGET_MANIFEST && entry.isFile()) {
      continue;
    }
    if (entry.name === allocationLockName && entry.isDirectory()) continue;
    if (
      claimFilePattern.test(entry.name) &&
      entry.isFile() &&
      !entry.isSymbolicLink()
    ) {
      continue;
    }
    const match = entry.name.match(roundFilePattern);
    if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    roundEntries.push({ name: entry.name, ordinal: Number(match[1]) });
  }
  roundEntries.sort((left, right) => left.ordinal - right.ordinal);
  const rounds: RoundRecord[] = [];
  for (const [index, entry] of roundEntries.entries()) {
    const ordinal = index + 1;
    if (
      entry.ordinal !== ordinal ||
      entry.name !== roundFileName(ordinal) ||
      ordinal > defaultRoundNames.length
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    const contents = await readBoundedRegularFile(join(locator, entry.name));
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    if (
      !isExactDataRecord(parsed, [
        "buildMarker",
        "firstClaimOrdinal",
        "lastClaimOrdinal",
        "mode",
        "name",
        "operationLimit",
        "ordinal",
        "protocol",
      ]) ||
      parsed.protocol !== manifest.protocol ||
      parsed.buildMarker !== manifest.buildMarker ||
      parsed.mode !== manifest.mode ||
      parsed.operationLimit !== manifest.operationLimit ||
      parsed.ordinal !== ordinal ||
      parsed.name !== defaultRoundNames[index] ||
      !Number.isSafeInteger(parsed.firstClaimOrdinal) ||
      !Number.isSafeInteger(parsed.lastClaimOrdinal)
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    const record: RoundRecord = Object.freeze({
      ...manifest,
      ordinal,
      name: parsed.name as ProviderAttemptRoundName,
      firstClaimOrdinal: parsed.firstClaimOrdinal as number,
      lastClaimOrdinal: parsed.lastClaimOrdinal as number,
    });
    if (contents !== serializeRound(record)) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    rounds.push(record);
  }
  return Object.freeze(rounds);
}

function validateRoundRecords(
  rounds: readonly RoundRecord[],
  claims: readonly ClaimRecord[],
  requireComplete: boolean,
): void {
  if (requireComplete && rounds.length !== defaultRoundNames.length) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  let lastClaimOrdinal = 0;
  for (const [index, round] of rounds.entries()) {
    if (
      round.ordinal !== index + 1 ||
      round.name !== defaultRoundNames[index] ||
      round.firstClaimOrdinal !== lastClaimOrdinal + 1
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    validateRoundSegment(round, claims);
    lastClaimOrdinal = round.lastClaimOrdinal;
  }
  if (requireComplete && lastClaimOrdinal !== claims.length) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
}

function validateRoundSegment(
  round: RoundRecord,
  claims: readonly ClaimRecord[],
): void {
  if (
    round.firstClaimOrdinal < 1 ||
    round.lastClaimOrdinal < round.firstClaimOrdinal ||
    round.lastClaimOrdinal > claims.length
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
  const segment = claims.slice(
    round.firstClaimOrdinal - 1,
    round.lastClaimOrdinal,
  );
  const count = (operation: ProviderOperationKind) =>
    segment.filter((claim) => claim.operation === operation).length;
  if (
    count("codex-initialize") !== 1 ||
    count("codex-account-read") !== 1 ||
    count("codex-model-list-page") < 1 ||
    count("codex-model-list-page") > 2 ||
    count("claude-auth-status") !== 1 ||
    count("claude-catalog-initialize") !== 1 ||
    count("claude-session-initialize") !== 0 ||
    count("claude-inference-frame") !== 0 ||
    segment.length < 5 ||
    segment.length > 6
  ) {
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
}

async function validateLocatorDirectory(locator: string): Promise<void> {
  try {
    const information = await lstat(locator);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
  } catch (error) {
    if (error instanceof ProviderRequestBudgetError) throw error;
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
}

async function readBoundedRegularFile(path: string): Promise<string> {
  try {
    const information = await lstat(path);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size <= 0 ||
      information.size > maximumLedgerFileBytes
    ) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    const contents = await readFile(path, "utf8");
    if (Buffer.byteLength(contents, "utf8") !== information.size) {
      throw new ProviderRequestBudgetError("ledger-invalid");
    }
    return contents;
  } catch (error) {
    if (error instanceof ProviderRequestBudgetError) throw error;
    throw new ProviderRequestBudgetError("ledger-invalid");
  }
}

async function writeDurableExclusive(path: string, contents: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    throw error;
  }
}

function defaultManifest(): AttemptManifest {
  return Object.freeze({
    protocol: PROVIDER_ATTEMPT_PROTOCOL,
    buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    mode: "default" as const,
    operationLimit: PROVIDER_ATTEMPT_OPERATION_LIMIT,
  });
}

function serializeManifest(value: AttemptManifest): string {
  return `${JSON.stringify(value)}\n`;
}

function serializeClaim(value: ClaimRecord): string {
  return `${JSON.stringify(value)}\n`;
}

function serializeRound(value: RoundRecord): string {
  return `${JSON.stringify(value)}\n`;
}

function claimFileName(ordinal: number): string {
  return `claim-${String(ordinal).padStart(2, "0")}.json`;
}

function roundFileName(ordinal: number): string {
  return `round-${String(ordinal).padStart(2, "0")}.json`;
}

function isProviderOperationKind(value: unknown): value is ProviderOperationKind {
  return typeof value === "string" && operationKinds.has(value as ProviderOperationKind);
}

function isValidLocator(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    resolve(value) === value &&
    attemptLeafPattern.test(basename(value))
  );
}

function isExactDefaultPlan(value: unknown): value is ProviderAttemptPlan {
  if (
    !isExactDataRecord(value, [
      "bounds",
      "buildMarker",
      "mode",
      "operationLimit",
      "protocol",
      "rounds",
    ]) ||
    value.protocol !== PROVIDER_ATTEMPT_PROTOCOL ||
    value.buildMarker !== PROVIDER_ATTEMPT_BUILD_MARKER ||
    value.mode !== "default" ||
    value.operationLimit !== PROVIDER_ATTEMPT_OPERATION_LIMIT ||
    !isExactDataRecord(value.bounds, [
      "claudeMaximum",
      "claudeMinimum",
      "codexMaximum",
      "codexMinimum",
      "maximum",
      "minimum",
    ]) ||
    value.bounds.minimum !== 20 ||
    value.bounds.maximum !== 24 ||
    value.bounds.codexMinimum !== 12 ||
    value.bounds.codexMaximum !== 16 ||
    value.bounds.claudeMinimum !== 8 ||
    value.bounds.claudeMaximum !== 8 ||
    !isDenseArray(value.rounds) ||
    value.rounds.length !== 4
  ) {
    return false;
  }
  const names = [
    "independent-headless",
    "item-4-lazy-picker",
    "positive-continuation-composition",
    "positive-new-session-explicit-refresh",
  ];
  return value.rounds.every(
    (round, index) =>
      isExactDataRecord(round, ["maximum", "minimum", "name"]) &&
      round.name === names[index] &&
      round.minimum === 5 &&
      round.maximum === 6,
  );
}

function isExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      keys.every(
        (key) => typeof key === "string" && expectedKeys.includes(key),
      ) &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          Object.prototype.hasOwnProperty.call(descriptor, "value")
        );
      })
    );
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
    return Array.from({ length: value.length }, (_, index) => String(index)).every(
      (key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
      },
    );
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
