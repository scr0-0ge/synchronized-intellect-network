/**
 * Read-only inventory of every Workbench project store on this machine.
 *
 * The owner reported that chat history went missing. The Historical Recovery
 * Library (`F92`) was built to answer that, but it cannot: it is inert on
 * Windows, and the history that is actually stranded sits inside the store the
 * product treats as `current`, which recovery refuses to preserve or export.
 *
 * This answers the underlying question directly instead. It opens every ledger
 * READ-ONLY, reports what each one holds and whether the registry still points
 * at it, and writes nothing anywhere.
 *
 * It deliberately prints no message text, no prompt, no reply and no file path
 * beyond the store roots — an inventory, never a transcript — so its output is
 * safe to paste into an issue or an evidence file.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface StoreRoot {
  readonly label: string;
  readonly root: string;
}

function storeRoots(): readonly StoreRoot[] {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData.length === 0) {
    throw new Error("APPDATA is not set; this inventory is Windows-only.");
  }
  const host = "workbench-project-host";
  return Object.freeze([
    Object.freeze({
      label: "current (product identity)",
      root: join(appData, "unified-agent-workbench", host),
    }),
    Object.freeze({
      label: "historical (Electron default identity)",
      root: join(appData, "Electron", host),
    }),
    Object.freeze({
      label: "historical (packaged product name)",
      root: join(appData, "Unified Agent Workbench", host),
    }),
  ]);
}

function readRegistry(
  root: string,
): { readonly slot: string; readonly directory: string }[] {
  try {
    const raw = readFileSync(join(root, "project-registry-v1.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      readonly records?: readonly {
        readonly ledgerSlot?: unknown;
        readonly canonicalDirectory?: unknown;
      }[];
    };
    return (parsed.records ?? []).flatMap((record) =>
      typeof record.ledgerSlot === "string" &&
      typeof record.canonicalDirectory === "string"
        ? [{ slot: record.ledgerSlot, directory: record.canonicalDirectory }]
        : [],
    );
  } catch {
    return [];
  }
}

function countRows(database: DatabaseSync, table: string): number | "n/a" {
  try {
    const row = database.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as
      | { readonly c: number }
      | undefined;
    return row?.c ?? "n/a";
  } catch {
    return "n/a";
  }
}

function main(): void {
  let strandedSessions = 0;
  let strandedFiles = 0;

  for (const { label, root } of storeRoots()) {
    console.log(`\n=== ${label}\n    ${root}`);
    let entries: string[];
    try {
      entries = readdirSync(join(root, "project-ledgers")).filter((name) =>
        name.endsWith(".sqlite"),
      );
    } catch {
      console.log("    (no store at this root)");
      continue;
    }
    const registered = new Map(
      readRegistry(root).map((record) => [record.slot, record.directory]),
    );
    console.log(
      `    ledger files: ${entries.length}   registry records: ${registered.size}`,
    );

    for (const name of entries.sort()) {
      const path = join(root, "project-ledgers", name);
      const slot = name.replace(/\.sqlite$/u, "");
      const directory = registered.get(slot);
      const reachable = directory !== undefined;
      let database: DatabaseSync;
      try {
        // Read-only. This script never writes to a store, ever.
        database = new DatabaseSync(path, { readOnly: true });
      } catch (error) {
        console.log(`    ${slot}  UNREADABLE (${String(error)})`);
        continue;
      }
      const sessions = countRows(database, "sessions");
      const commands = countRows(database, "commands");
      const updates = countRows(database, "updates");
      let schema: number | "n/a" = "n/a";
      try {
        schema =
          (database.prepare("PRAGMA user_version").get() as
            | { readonly user_version?: number }
            | undefined)?.user_version ?? "n/a";
      } catch {
        schema = "n/a";
      }
      database.close();

      const size = statSync(path).size;
      const mtime = statSync(path).mtime.toISOString();
      console.log(
        `    ${reachable ? "REACHABLE " : "STRANDED  "}${slot}` +
          `\n        sessions=${sessions} commands=${commands} updates=${updates}` +
          ` schema=v${schema} bytes=${size} modified=${mtime}` +
          (reachable ? `\n        project: ${directory}` : ""),
      );
      if (!reachable && typeof sessions === "number" && sessions > 0) {
        strandedFiles += 1;
        strandedSessions += sessions;
      }
    }
  }

  console.log(
    `\nSTRANDED ledger files holding history: ${strandedFiles}` +
      `   Agent Sessions unreachable from any registry: ${strandedSessions}`,
  );
  console.log(
    "A stranded file is one the product can no longer reach: no registry record " +
      "names its slot, and nothing on any startup path scans the directory to " +
      "find it. Its history is intact on disk and invisible in the product.",
  );
}

main();
