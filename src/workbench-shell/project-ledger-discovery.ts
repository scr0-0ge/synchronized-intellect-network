/**
 * Read-only discovery of every Project ledger that belongs to one directory.
 *
 * The Project Registry remains the durable index, while registration consults
 * this read-only inventory when the Registry no longer has a directory record.
 * `prepareRemoval` deliberately leaves the `.sqlite` file on disk, so opening
 * the same Project later can adopt its sole matching ledger or ask the owner to
 * choose when more than one legitimate history exists.
 *
 * Every ledger stores its own `projects.directory_digest`, so a stranded ledger
 * can be attributed to a directory DETERMINISTICALLY: open it read-only, compare
 * the digest, done. No heuristics, no guessing, no name matching.
 *
 * This module opens ledgers READ-ONLY and never writes anywhere. It reports an
 * inventory — counts, size, schema version, modification time — and never reads
 * message text, prompts, replies, display names or file paths, following the
 * rule the existing `scripts/inspect-history-stores.ts` inspector states: the
 * output must be an inventory, never a transcript. One unreadable or hostile
 * ledger can never break discovery: every open is wrapped and skipped on failure.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The exact slot spelling the Project registry mints and validates. Copied from
 * the registry writer so discovery can never be pointed at an arbitrary file
 * name that happens to sit in `project-ledgers/`.
 */
const ledgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A directory holding more ledger files than this is not enumerated further. */
const maximumDiscoveredLedgers = 1_000;

/** An inventory of one ledger file, with no transcript content of any kind. */
export interface DiscoveredProjectLedger {
  /** The registry slot spelling, i.e. the file's basename without `.sqlite`. */
  readonly ledgerSlot: string;
  /** True when the registry record for this directory currently points here. */
  readonly registered: boolean;
  readonly sessionCount: number;
  readonly commandCount: number;
  readonly updateCount: number;
  readonly byteSize: number;
  /** UTC, second precision: `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly lastModified: string;
  /** `PRAGMA user_version` of the ledger, or 0 when it could not be read. */
  readonly schemaVersion: number;
}

/**
 * The `projects.directory_digest` a ledger bound to `directory` must carry.
 *
 * This mirrors `bindProject` in the durable channel exactly — including the
 * Windows case fold — so a digest computed here matches a digest written there.
 * If the two ever diverge, discovery offers nothing rather than offering a
 * wrong ledger, and `bindProject` still refuses to open a mismatched slot.
 */
export function projectDirectoryDigest(directory: string): string {
  const resolved = resolve(directory);
  return createHash("sha256")
    .update(
      process.platform === "win32" ? resolved.toLowerCase() : resolved,
      "utf8",
    )
    .digest("hex");
}

/**
 * Every ledger in `ledgerDirectory` whose recorded directory digest matches
 * `canonicalDirectory`, newest modification first.
 *
 * `registeredLedgerSlot` marks which of them the Project currently shows; it is
 * only a label, and a slot that is absent from disk is simply not reported.
 * The returned records are frozen and carry counts only.
 */
export function discoverProjectLedgers(options: {
  readonly ledgerDirectory: string;
  readonly canonicalDirectory: string;
  readonly registeredLedgerSlot?: string;
}): readonly DiscoveredProjectLedger[] {
  const expectedDigest = projectDirectoryDigest(options.canonicalDirectory);
  let entries: readonly string[];
  try {
    entries = readdirSync(options.ledgerDirectory);
  } catch {
    // No store directory yet, or it is unreadable: nothing to offer.
    return Object.freeze([]);
  }
  const slots = entries
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => name.slice(0, -".sqlite".length))
    .filter((slot) => ledgerSlotPattern.test(slot))
    .sort()
    .slice(0, maximumDiscoveredLedgers);

  const discovered: DiscoveredProjectLedger[] = [];
  for (const slot of slots) {
    const record = inventoryLedger(
      join(options.ledgerDirectory, `${slot}.sqlite`),
      slot,
      expectedDigest,
      options.registeredLedgerSlot === slot,
    );
    if (record !== undefined) discovered.push(record);
  }
  // Newest first, then by slot so the order is total and stable across calls.
  discovered.sort((left, right) =>
    left.lastModified === right.lastModified
      ? left.ledgerSlot.localeCompare(right.ledgerSlot, "en-US")
      : left.lastModified < right.lastModified
        ? 1
        : -1,
  );
  return Object.freeze(discovered);
}

/**
 * Opens one ledger read-only and returns its inventory, or `undefined` when the
 * file is not a plain readable ledger for this directory.
 *
 * Everything here is defensive on purpose: the store directory is owner data
 * that other tools and earlier product identities have also written into.
 */
function inventoryLedger(
  databasePath: string,
  ledgerSlot: string,
  expectedDigest: string,
  registered: boolean,
): DiscoveredProjectLedger | undefined {
  let database: DatabaseSync | undefined;
  try {
    const information = lstatSync(databasePath);
    if (!information.isFile() || information.isSymbolicLink()) return undefined;
    // Read-only, always. Discovery never opens a ledger for writing.
    database = new DatabaseSync(databasePath, { readOnly: true });
    const project = database
      .prepare("SELECT directory_digest FROM projects LIMIT 1")
      .get() as { readonly directory_digest?: unknown } | undefined;
    if (project?.directory_digest !== expectedDigest) return undefined;
    const sessionCount = countRows(database, "sessions");
    const commandCount = countRows(database, "commands");
    const updateCount = countRows(database, "updates");
    if (
      sessionCount === undefined ||
      commandCount === undefined ||
      updateCount === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      ledgerSlot,
      registered,
      sessionCount,
      commandCount,
      updateCount,
      byteSize: safeCount(information.size) ? information.size : 0,
      lastModified: utcSecond(information.mtime),
      schemaVersion: schemaVersionOf(database),
    });
  } catch {
    // One unreadable, locked, corrupt or hostile ledger never breaks discovery.
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      // A handle that refuses to close still leaks nothing into the result.
    }
  }
}

function countRows(
  database: DatabaseSync,
  table: "sessions" | "commands" | "updates",
): number | undefined {
  try {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
      | { readonly count?: unknown }
      | undefined;
    const count = Number(row?.count);
    return safeCount(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

function schemaVersionOf(database: DatabaseSync): number {
  try {
    const row = database.prepare("PRAGMA user_version").get() as
      | { readonly user_version?: unknown }
      | undefined;
    const version = Number(row?.user_version);
    return safeCount(version) ? version : 0;
  } catch {
    return 0;
  }
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Latest instant `YYYY-MM-DDTHH:MM:SSZ` can spell without an expanded year. */
const latestRepresentableTime = Date.UTC(9999, 11, 31, 23, 59, 59);

function utcSecond(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time) || time < 0 || time > latestRepresentableTime) {
    return "1970-01-01T00:00:00Z";
  }
  return `${new Date(Math.trunc(time / 1_000) * 1_000)
    .toISOString()
    .slice(0, 19)}Z`;
}
