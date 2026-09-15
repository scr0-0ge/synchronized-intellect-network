/**
 * Process-tree capture and exit waiting for the launcher smokes that start the
 * real application (w256). A production start on Windows is a tree -- cmd.exe,
 * Electron, its GPU and renderer children -- and killing only the root pid
 * leaves the rest holding the isolated profile open. Every smoke that starts
 * the app captures the tree while it is alive, stops it by pid, then waits for
 * every captured pid to be gone before the scratch directory is removed.
 *
 * Shared by start.test.mjs (the `electron .` start) and packaged-smoke.test.mjs
 * (the packaged executable) so the two never drift apart.
 *
 * w361: `ParentProcessId` alone is not proof of descent. Windows recycles pids
 * and Win32_Process never updates a process's recorded parent once that parent
 * exits, so a long-lived unrelated process (this machine's own Claude Desktop,
 * in the incident that found this) can be misread as root's child purely
 * because root's pid was later recycled onto the number its real parent used
 * to hold. A candidate only joins the tree when all three hold: its parent
 * chain reaches root through other verified members, it was created at or
 * after root (a real descendant cannot predate its ancestor), and its
 * executable path or command line is recognisably this run's own. Anything
 * that clears only some of the three is reported as a diagnostic and left
 * alone -- killing by pid always lists the verified members individually,
 * never `/T`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const PROCESS_TREE_EXIT_TIMEOUT_MS = 15_000;

// One row per Win32_Process, captured once per snapshot. CreationDate is
// converted to Unix epoch milliseconds in PowerShell itself so the JS side
// never has to parse WMI's own datetime string format, and `-InputObject
// @($rows)` (rather than piping into ConvertTo-Json) keeps a single-process
// result an array instead of Windows PowerShell 5.1 unwrapping it to a
// bare object.
const SNAPSHOT_SCRIPT = `
$epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
$rows = foreach ($process in Get-CimInstance Win32_Process -ErrorAction Stop) {
  $created = 0
  if ($process.CreationDate) {
    $created = [long](($process.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds)
  }
  [PSCustomObject]@{
    Pid = [int]$process.ProcessId
    ParentPid = [int]$process.ParentProcessId
    Created = $created
    Path = [string]$process.ExecutablePath
    CommandLine = [string]$process.CommandLine
  }
}
[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress))
`;

function querySystemProcesses() {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim().length === 0) {
    return { ok: false, error: result.stderr?.trim() || result.error?.message || `status=${String(result.status)}` };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      ok: true,
      processes: rows.map((row) => ({
        pid: Number(row.Pid),
        parentPid: Number(row.ParentPid),
        creationTime: Number(row.Created),
        executablePath: typeof row.Path === 'string' ? row.Path : '',
        commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
      })),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Splits a whole-machine process snapshot into the subset provably descended
 * from `rootPid` and a diagnostic list of everything the raw ParentProcessId
 * chain alone would have pulled in. `processes` is the flat table (root's own
 * row included, in any order); `isOwned(process)` recognises this run's own
 * executable or command line (its isolated profile, its packaged output, its
 * own --user-data-dir). Root itself is exempt from every check: its identity
 * came from the caller having started it, not from anything in this table.
 *
 * A candidate that fails the date or ownership check is never expanded from,
 * even if its own parent chain would otherwise reach root -- so nothing can
 * ride into the trusted set by hanging off a pid that itself only looked
 * related by number.
 */
export function selectProcessTreeMembers(processes, rootPid, isOwned) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const root = byPid.get(rootPid);
  if (root === undefined) {
    return { members: [rootPid], diagnostics: [] };
  }

  const members = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const process of processes) {
      if (members.has(process.pid) || !members.has(process.parentPid)) continue;
      if (process.creationTime < root.creationTime) continue;
      if (!isOwned(process)) continue;
      members.add(process.pid);
      grew = true;
    }
  }

  // The unverified parent-id chain, for diagnostics only: shows exactly what
  // today's incident would have pulled in, even though none of it is trusted.
  const blind = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const process of processes) {
      if (blind.has(process.pid) || !blind.has(process.parentPid)) continue;
      blind.add(process.pid);
      grew = true;
    }
  }

  const diagnostics = [];
  for (const pid of blind) {
    if (members.has(pid)) continue;
    const process = byPid.get(pid);
    const reasons = [];
    if (process.creationTime < root.creationTime) {
      reasons.push(`created ${String(root.creationTime - process.creationTime)}ms before root (likely pid reuse)`);
    }
    if (!isOwned(process)) {
      reasons.push(
        `executable/command line is not recognised as this run's own: ${
          process.executablePath || process.commandLine || '(unknown)'
        }`,
      );
    }
    if (reasons.length === 0) {
      reasons.push("an ancestor between it and root failed the same checks");
    }
    diagnostics.push({ pid, reason: reasons.join('; ') });
  }

  return { members: [...members], diagnostics };
}

/**
 * Builds an `isOwned` predicate from this run's own directories: a packaged
 * output, an isolated profile, a build directory. A process is recognised
 * either by its executable living under one of `roots` (matched on a path
 * boundary, so `...\app` does not also match `...\app2`), or by one of
 * `roots` appearing anywhere in its command line -- Electron/Chromium
 * re-launch the same executable for GPU, renderer and utility children and
 * carry the launch flags (including --user-data-dir) on every one of them.
 */
export function ownedUnder(roots) {
  const needles = roots
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => path.resolve(root).toLowerCase());
  return (process) => {
    const executablePath = process.executablePath ? path.resolve(process.executablePath).toLowerCase() : '';
    const commandLine = process.commandLine.toLowerCase();
    return needles.some(
      (needle) =>
        commandLine.includes(needle) || executablePath === needle || executablePath.startsWith(`${needle}${path.sep}`),
    );
  };
}

/**
 * Every pid descending from `rootPid` (root included) while the tree is
 * alive, verified by `selectProcessTreeMembers`. `isOwned` defaults to
 * rejecting everything, so a caller that forgets to pass one gets only root
 * back rather than a silently permissive tree.
 */
export function captureProcessTree(rootPid, t, { label = 'launcher smoke', isOwned = () => false } = {}) {
  const snapshot = querySystemProcesses();
  if (!snapshot.ok) {
    t.diagnostic(
      `${label} process-tree capture failed; waiting for root pid ${String(rootPid)} only: ${snapshot.error}`,
    );
    return [rootPid];
  }
  const { members, diagnostics } = selectProcessTreeMembers(snapshot.processes, rootPid, isOwned);
  for (const { pid, reason } of diagnostics) {
    t.diagnostic(
      `${label} process-tree: pid ${String(pid)} reaches root ${String(rootPid)} through ParentProcessId alone, ` +
        `not counted as a descendant (${reason})`,
    );
  }
  return members;
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until every pid is gone or the limit passes, and report which. The
 * survivors are returned rather than asserted on: the launcher smoke reports
 * them, the packaged smoke stops them by pid.
 */
export async function waitForProcessTreeExit(t, pids, label = 'launcher smoke') {
  const started = performance.now();
  let remaining = pids.filter(processIsAlive);
  while (remaining.length > 0 && performance.now() - started < PROCESS_TREE_EXIT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = pids.filter(processIsAlive);
  }
  t.diagnostic(
    `${label} process-tree exit: elapsed=${String(Math.round(performance.now() - started))}ms ` +
      `limit=${String(PROCESS_TREE_EXIT_TIMEOUT_MS)}ms captured=${String(pids.length)} ` +
      `remaining=${remaining.length === 0 ? 'none' : remaining.join(',')}`,
  );
  return remaining;
}
