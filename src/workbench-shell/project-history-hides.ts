import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const historyHideSchemaVersion = 1;
const maximumHistoryHideBytes = 256 * 1024;
const maximumHistoryHideRecords = 1_000;
const maximumHistoryHideRevision = Number.MAX_SAFE_INTEGER - 1;
const historyHideFileName = "project-history-hides-v1.json";
const historyHideReplacementName = "project-history-hides-v1.replacement";
const ledgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const directoryDigestPattern = /^[0-9a-f]{64}$/u;

type PrivateProjectHistoryHideRecord = Readonly<{
  directoryDigest: string;
  ledgerSlot: string;
}>;

type PrivateProjectHistoryHideState = Readonly<{
  schemaVersion: 1;
  revision: number;
  records: readonly PrivateProjectHistoryHideRecord[];
}>;

type ProjectHistoryHidePaths = Readonly<{
  stateFile: string;
  replacementFile: string;
}>;

/**
 * Durable, host-private visibility state for empty historical ledgers.
 *
 * This store never receives a ledger path and never opens a ledger. The caller
 * supplies only the directory digest and validated registry slot that discovery
 * already proved. A malformed store fails open for visibility (nothing is
 * hidden) and closed for mutation (no damaged state is overwritten).
 */
export interface ProjectHistoryHideStore {
  readonly available: boolean;
  isHidden(directoryDigest: string, ledgerSlot: string): boolean;
  hide(directoryDigest: string, ledgerSlot: string): Promise<boolean>;
}

export async function openProjectHistoryHideStore(
  dataDirectory: string,
): Promise<ProjectHistoryHideStore> {
  const paths = Object.freeze({
    stateFile: join(dataDirectory, historyHideFileName),
    replacementFile: join(dataDirectory, historyHideReplacementName),
  });
  const opened = await readState(paths).catch(() => undefined);
  if (opened === undefined) return unavailableStore();

  let state = opened;
  let identities = recordIdentities(state);
  return Object.freeze({
    available: true,
    isHidden(directoryDigest: string, ledgerSlot: string): boolean {
      return (
        directoryDigestPattern.test(directoryDigest) &&
        ledgerSlotPattern.test(ledgerSlot) &&
        identities.has(recordIdentity(directoryDigest, ledgerSlot))
      );
    },
    async hide(directoryDigest: string, ledgerSlot: string): Promise<boolean> {
      if (
        !directoryDigestPattern.test(directoryDigest) ||
        !ledgerSlotPattern.test(ledgerSlot)
      ) {
        return false;
      }
      const identity = recordIdentity(directoryDigest, ledgerSlot);
      if (identities.has(identity)) return true;
      if (
        state.records.length >= maximumHistoryHideRecords ||
        state.revision >= maximumHistoryHideRevision
      ) {
        return false;
      }
      const next = deepFreeze({
        schemaVersion: historyHideSchemaVersion as 1,
        revision: state.revision + 1,
        records: [
          ...state.records,
          { directoryDigest, ledgerSlot },
        ].sort(compareRecords),
      });
      if (!(await writeState(paths, state, next))) return false;
      state = next;
      identities = recordIdentities(state);
      return true;
    },
  });
}

function unavailableStore(): ProjectHistoryHideStore {
  return Object.freeze({
    available: false,
    isHidden: () => false,
    hide: async () => false,
  });
}

async function readState(
  paths: ProjectHistoryHidePaths,
): Promise<PrivateProjectHistoryHideState | undefined> {
  await mkdir(dirname(paths.stateFile), { recursive: true });
  let information: Awaited<ReturnType<typeof lstat>>;
  try {
    information = await lstat(paths.stateFile);
  } catch (error) {
    if (!isMissing(error)) return undefined;
    await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    return emptyState();
  }
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > maximumHistoryHideBytes
  ) {
    return undefined;
  }
  try {
    const contents = await readFile(paths.stateFile, "utf8");
    if (Buffer.byteLength(contents, "utf8") > maximumHistoryHideBytes) {
      return undefined;
    }
    const state = validateState(JSON.parse(contents));
    if (state === undefined) return undefined;
    await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    return state;
  } catch {
    return undefined;
  }
}

async function writeState(
  paths: ProjectHistoryHidePaths,
  prior: PrivateProjectHistoryHideState,
  next: PrivateProjectHistoryHideState,
): Promise<boolean> {
  const contents = serializeState(next);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (await pathExists(paths.replacementFile)) return false;
    await mkdir(dirname(paths.stateFile), { recursive: true });
    handle = await open(paths.replacementFile, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(paths.replacementFile, paths.stateFile);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    const committed = await readCommittedState(paths.stateFile);
    if (committed !== undefined && serializeState(committed) === contents) {
      await rm(paths.replacementFile, { force: true }).catch(() => undefined);
      return true;
    }
    if (
      committed !== undefined &&
      serializeState(committed) === serializeState(prior)
    ) {
      await rm(paths.replacementFile, { force: true }).catch(() => undefined);
    }
    return false;
  }
}

async function readCommittedState(
  stateFile: string,
): Promise<PrivateProjectHistoryHideState | undefined> {
  try {
    return validateState(JSON.parse(await readFile(stateFile, "utf8")));
  } catch {
    return undefined;
  }
}

function validateState(
  value: unknown,
): PrivateProjectHistoryHideState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["records", "revision", "schemaVersion"]) ||
    value.schemaVersion !== historyHideSchemaVersion ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.revision as number) > maximumHistoryHideRevision ||
    !Array.isArray(value.records) ||
    value.records.length > maximumHistoryHideRecords ||
    value.revision !== value.records.length
  ) {
    return undefined;
  }
  const identities = new Set<string>();
  const records: PrivateProjectHistoryHideRecord[] = [];
  for (const candidate of value.records) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["directoryDigest", "ledgerSlot"]) ||
      typeof candidate.directoryDigest !== "string" ||
      !directoryDigestPattern.test(candidate.directoryDigest) ||
      typeof candidate.ledgerSlot !== "string" ||
      !ledgerSlotPattern.test(candidate.ledgerSlot)
    ) {
      return undefined;
    }
    const identity = recordIdentity(
      candidate.directoryDigest,
      candidate.ledgerSlot,
    );
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    records.push(
      Object.freeze({
        directoryDigest: candidate.directoryDigest,
        ledgerSlot: candidate.ledgerSlot,
      }),
    );
  }
  if (
    !records.every(
      (record, index) =>
        index === 0 || compareRecords(records[index - 1]!, record) <= 0,
    )
  ) {
    return undefined;
  }
  return deepFreeze({
    schemaVersion: historyHideSchemaVersion as 1,
    revision: value.revision as number,
    records,
  });
}

function emptyState(): PrivateProjectHistoryHideState {
  return deepFreeze({
    schemaVersion: historyHideSchemaVersion as 1,
    revision: 0,
    records: [],
  });
}

function serializeState(state: PrivateProjectHistoryHideState): string {
  return `${JSON.stringify(state)}\n`;
}

function recordIdentities(
  state: PrivateProjectHistoryHideState,
): Set<string> {
  return new Set(
    state.records.map((record) =>
      recordIdentity(record.directoryDigest, record.ledgerSlot),
    ),
  );
}

function recordIdentity(directoryDigest: string, ledgerSlot: string): string {
  return `${directoryDigest}:${ledgerSlot}`;
}

function compareRecords(
  left: PrivateProjectHistoryHideRecord,
  right: PrivateProjectHistoryHideRecord,
): number {
  return (
    left.directoryDigest.localeCompare(right.directoryDigest, "en-US") ||
    left.ledgerSlot.localeCompare(right.ledgerSlot, "en-US")
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

function isMissing(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
