/**
 * Read-only inventory of every Workbench project store on this machine.
 *
 * Covers the current product identity and the three historical identities
 * used by the Historical Recovery Library. It opens inactive ledgers in
 * immutable read-only mode, reports what each one holds and whether the
 * registry still points at it, and writes nothing anywhere. A ledger with a
 * transaction sidecar is not opened; its counts are reported as unconfirmed.
 *
 * It deliberately prints no message text, no prompt, no reply and no file path
 * beyond the store roots — an inventory, never a transcript — so its output is
 * safe to paste into an issue or an evidence file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
      root: join(appData, "synchronized-intellect-network", host),
    }),
    Object.freeze({
      label: "historical (package identity)",
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

function hasTransactionSidecar(path: string): boolean {
  return ["-wal", "-shm", "-journal"].some((suffix) =>
    existsSync(`${path}${suffix}`),
  );
}

function schemaText(value: number | "n/a" | "unconfirmed"): string {
  return typeof value === "number" ? `v${value}` : value;
}

function main(): void {
  let strandedSessions = 0;
  let strandedFiles = 0;
  let unconfirmedStrandedFiles = 0;

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
      const transactionSidecarPresent = hasTransactionSidecar(path);
      let sessions: number | "n/a" | "unconfirmed" = "unconfirmed";
      let commands: number | "n/a" | "unconfirmed" = "unconfirmed";
      let updates: number | "n/a" | "unconfirmed" = "unconfirmed";
      let schema: number | "n/a" | "unconfirmed" = "unconfirmed";
      if (!transactionSidecarPresent) {
        let database: DatabaseSync;
        try {
          const uri = `${pathToFileURL(path).href}?mode=ro&immutable=1`;
          database = new DatabaseSync(uri, {
            readOnly: true,
            enableForeignKeyConstraints: false,
          });
        } catch (error) {
          console.log(`    ${slot}  UNREADABLE (${String(error)})`);
          continue;
        }
        sessions = countRows(database, "sessions");
        commands = countRows(database, "commands");
        updates = countRows(database, "updates");
        try {
          schema =
            (database.prepare("PRAGMA user_version").get() as
              | { readonly user_version?: number }
              | undefined)?.user_version ?? "n/a";
        } catch {
          schema = "n/a";
        }
        database.close();
      }

      const size = statSync(path).size;
      const mtime = statSync(path).mtime.toISOString();
      console.log(
        `    ${reachable ? "REACHABLE " : "STRANDED  "}${slot}` +
          `\n        sessions=${sessions} commands=${commands} updates=${updates}` +
          ` schema=${schemaText(schema)} bytes=${size} modified=${mtime}` +
          (transactionSidecarPresent
            ? "\n        counts unconfirmed within zero-write boundary: " +
              "transaction sidecar present"
            : "") +
          (reachable ? `\n        project: ${directory}` : ""),
      );
      if (!reachable && typeof sessions === "number" && sessions > 0) {
        strandedFiles += 1;
        strandedSessions += sessions;
      } else if (!reachable && transactionSidecarPresent) {
        unconfirmedStrandedFiles += 1;
      }
    }
  }

  console.log(
    `\nSTRANDED ledger files holding history: ${strandedFiles}` +
      `   Agent Sessions unreachable from any registry: ${strandedSessions}`,
  );
  if (unconfirmedStrandedFiles > 0) {
    console.log(
      `Stranded ledger files not counted within the zero-write boundary: ` +
        `${unconfirmedStrandedFiles}`,
    );
  }
  console.log(
    "A stranded file is one the product can no longer reach: no registry record " +
      "names its slot, and nothing on any startup path scans the directory to " +
      "find it. Its history is intact on disk and invisible in the product.",
  );
}

main();
