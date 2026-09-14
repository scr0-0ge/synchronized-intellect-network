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
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export const PROCESS_TREE_EXIT_TIMEOUT_MS = 15_000;

/** Every pid descending from `rootPid` (root included) while the tree is alive. */
export function captureProcessTree(rootPid, t, label = 'launcher smoke') {
  const captured = spawnSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$rootPid = ${String(rootPid)}; ` +
        '$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop); ' +
        '$tree = [System.Collections.Generic.HashSet[int]]::new(); [void]$tree.Add($rootPid); ' +
        'do { $count = $tree.Count; foreach ($process in $processes) { ' +
        'if ($tree.Contains([int]$process.ParentProcessId)) { [void]$tree.Add([int]$process.ProcessId) } ' +
        '} } while ($tree.Count -gt $count); ' +
        '[Console]::Out.Write((@($tree | Sort-Object) -join ","))',
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  const pids = (captured.stdout ?? '')
    .trim()
    .split(',')
    .map(Number)
    .filter(Number.isSafeInteger);
  if (captured.status === 0 && pids.length > 0) return pids;
  t.diagnostic(
    `${label} process-tree capture failed; waiting for root pid ${String(rootPid)} only: ` +
      `${captured.stderr?.trim() || captured.error?.message || `status=${String(captured.status)}`}`,
  );
  return [rootPid];
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
