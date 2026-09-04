import { spawn } from "node:child_process";

interface Win32ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly creationDate: string | null;
}

export interface DescendantProcessRecord {
  readonly pid: number;
  readonly creationDate: string | null;
  readonly name: string;
}

export interface DescendantTreeCapture {
  readonly method: "win32-process-snapshot-transitive-closure";
  readonly rootPid: number;
  readonly descendants: readonly DescendantProcessRecord[];
}

export interface DescendantSweepSummary {
  readonly method: "win32-process-snapshot-transitive-closure";
  readonly rootPid: number;
  readonly preQuitDescendantCount: number;
  readonly preQuitDescendantNames: readonly string[];
  readonly preQuitDescendants: readonly DescendantProcessRecord[];
  readonly survivorCountAfterQuit: number;
  readonly survivorsAfterQuit: readonly DescendantProcessRecord[];
  readonly sweepMilliseconds: number;
}

/**
 * One point-in-time enumeration of Win32 processes as (pid, parentPid, name,
 * creationDate). The optional CIM filter restricts the query to specific
 * ProcessId values so the post-quit survivor poll stays cheap. The query only
 * observes; nothing here can signal or terminate any process (F41).
 */
async function readWin32ProcessTable(
  cimFilter?: string,
): Promise<readonly Win32ProcessTableEntry[]> {
  const filterClause = cimFilter === undefined ? "" : ` -Filter '${cimFilter}'`;
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
    `$items = @(Get-CimInstance -ClassName Win32_Process${filterClause} -ErrorAction Stop | ` +
    "ForEach-Object { @{ pid = [int64]$_.ProcessId; parentPid = [int64]$_.ParentProcessId; " +
    "name = [string]$_.Name; creationDate = $(if ($null -ne $_.CreationDate) " +
    "{ $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } }); " +
    "ConvertTo-Json -Compress -Depth 4 @{ items = $items }";
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = await Promise.race([
    new Promise<{ code: number | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit({ code }));
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("f72-process-table-query-timeout")),
        30_000,
      ),
    ),
  ]);
  if (exit.code !== 0) {
    console.error(
      `F72_PROCESS_TABLE_QUERY_STDERR ${stderr.trim().slice(0, 2_000)}`,
    );
    throw new Error("f72-process-table-query-failed");
  }
  const parsed = JSON.parse(stdout) as { readonly items?: unknown };
  if (!Array.isArray(parsed.items)) {
    throw new Error("f72-process-table-shape-invalid");
  }
  return Object.freeze(
    parsed.items.map((item: unknown) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("pid" in item) ||
        !("parentPid" in item) ||
        !("name" in item) ||
        !("creationDate" in item) ||
        !Number.isSafeInteger(item.pid) ||
        (item.pid as number) < 0 ||
        !Number.isSafeInteger(item.parentPid) ||
        (item.parentPid as number) < 0 ||
        typeof item.name !== "string" ||
        (typeof item.creationDate !== "string" && item.creationDate !== null)
      ) {
        throw new Error("f72-process-table-entry-invalid");
      }
      return Object.freeze({
        pid: item.pid as number,
        parentPid: item.parentPid as number,
        name: item.name,
        creationDate: item.creationDate as string | null,
      });
    }),
  );
}

/**
 * A parent's creation can never postdate a real child's creation, so an edge
 * that violates that order is a stale ParentProcessId left by PID reuse and is
 * excluded rather than swept into the closure of a foreign process.
 */
function creationOrderConsistent(
  parentCreationDate: string | null,
  childCreationDate: string | null,
): boolean {
  if (parentCreationDate === null || childCreationDate === null) return true;
  const parent = Date.parse(parentCreationDate);
  const child = Date.parse(childCreationDate);
  if (Number.isNaN(parent) || Number.isNaN(child)) return true;
  return child >= parent;
}

/**
 * The transitive-descendant closure of the launched primary PID, captured just
 * before the true quit. Identity is (pid + creationDate) so PID reuse can
 * neither fake a survivor nor hide one.
 */
export async function captureDescendantTree(
  rootPid: number,
): Promise<DescendantTreeCapture> {
  const table = await readWin32ProcessTable();
  const rootEntry = table.find((entry) => entry.pid === rootPid);
  if (rootEntry === undefined) {
    throw new Error("f72-descendant-capture-root-missing");
  }
  const childrenByParent = new Map<number, Win32ProcessTableEntry[]>();
  for (const entry of table) {
    const siblings = childrenByParent.get(entry.parentPid) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.parentPid, siblings);
  }
  const descendants: DescendantProcessRecord[] = [];
  const visited = new Set<number>([rootPid]);
  const queue: { pid: number; creationDate: string | null }[] = [
    { pid: rootPid, creationDate: rootEntry.creationDate },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of childrenByParent.get(current.pid) ?? []) {
      if (visited.has(candidate.pid)) continue;
      if (
        !creationOrderConsistent(current.creationDate, candidate.creationDate)
      ) {
        continue;
      }
      visited.add(candidate.pid);
      descendants.push({
        pid: candidate.pid,
        creationDate: candidate.creationDate,
        name: candidate.name,
      });
      queue.push({ pid: candidate.pid, creationDate: candidate.creationDate });
    }
  }
  descendants.sort((left, right) => left.pid - right.pid);
  return Object.freeze({
    method: "win32-process-snapshot-transitive-closure",
    rootPid,
    descendants: Object.freeze(descendants),
  });
}

function descendantStillPresent(
  record: DescendantProcessRecord,
  entry: Win32ProcessTableEntry,
): boolean {
  if (record.pid !== entry.pid) return false;
  if (record.creationDate === null || entry.creationDate === null) {
    return record.name === entry.name;
  }
  return record.creationDate === entry.creationDate;
}

/**
 * After the primary exit is confirmed, poll until every captured descendant
 * (pid + creationDate) is gone, within a bounded timeout. Observation only: a
 * survivor is reported, never killed (F41). The caller fails the scenario when
 * survivorCountAfterQuit is not zero.
 */
export async function sweepDescendantSurvivors(
  capture: DescendantTreeCapture,
  timeoutMilliseconds = 10_000,
): Promise<DescendantSweepSummary> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMilliseconds;
  const cimFilter = capture.descendants
    .map((record) => `ProcessId=${record.pid}`)
    .join(" OR ");
  let survivors: readonly DescendantProcessRecord[] = capture.descendants;
  while (survivors.length > 0) {
    const present = await readWin32ProcessTable(cimFilter);
    survivors = capture.descendants.filter((record) =>
      present.some((entry) => descendantStillPresent(record, entry)),
    );
    if (survivors.length === 0 || Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return Object.freeze({
    method: capture.method,
    rootPid: capture.rootPid,
    preQuitDescendantCount: capture.descendants.length,
    preQuitDescendantNames: Object.freeze(
      capture.descendants.map((record) => record.name).sort(),
    ),
    preQuitDescendants: capture.descendants,
    survivorCountAfterQuit: survivors.length,
    survivorsAfterQuit: Object.freeze([...survivors]),
    sweepMilliseconds: Date.now() - startedAt,
  });
}

export function assertDescendantSweepClean(
  descendantSweep: DescendantSweepSummary,
  scenario: "idle" | "held-active",
): void {
  if (descendantSweep.survivorCountAfterQuit === 0) return;
  console.error(
    `F72_DESCENDANT_SWEEP_DIAGNOSTIC ${JSON.stringify({
      schema: "f72-descendant-sweep-diagnostic-v1",
      scenario,
      category: "f72-descendant-process-survived-true-quit",
      survivors: descendantSweep.survivorsAfterQuit.map((record) => ({
        pid: record.pid,
        name: record.name,
      })),
      sweep: descendantSweep,
    })}`,
  );
  throw new Error("f72-descendant-process-survived-true-quit");
}
