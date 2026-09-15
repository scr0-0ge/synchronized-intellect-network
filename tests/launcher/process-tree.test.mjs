/**
 * w361: the process-tree helper must never mistake an unrelated process for
 * root's own descendant just because a stale ParentProcessId numerically
 * matches a recycled pid. This feeds `selectProcessTreeMembers` a constructed
 * process table (no real processes, no PowerShell) modeled directly on the
 * incident: root's pid had, hours earlier, belonged to an ancestor of the
 * owner's own Claude Desktop, which still records that stale number as its
 * parent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ownedUnder, selectProcessTreeMembers } from './process-tree.mjs';

const ROOT_PID = 3372;
const ROOT_CREATED = 100_000;
const OWNED_APP = 'C:\\lane\\app';
const OWNED_PROFILE = 'C:\\lane\\profile';
const isOwned = ownedUnder([OWNED_APP, OWNED_PROFILE]);

const table = [
  {
    pid: ROOT_PID,
    parentPid: 900, // whatever launched the test harness itself; never consulted
    creationTime: ROOT_CREATED,
    executablePath: 'C:\\Windows\\System32\\cmd.exe',
    commandLine: `cmd.exe /d /c start.bat --user-data-dir=${OWNED_PROFILE}`,
  },
  {
    // real child: Electron's main process
    pid: 4001,
    parentPid: ROOT_PID,
    creationTime: ROOT_CREATED + 50,
    executablePath: `${OWNED_APP}\\electron.exe`,
    commandLine: `"${OWNED_APP}\\electron.exe" . --user-data-dir=${OWNED_PROFILE} --window-placement=offscreen`,
  },
  {
    // real grandchild: Electron re-execs the same binary for its GPU helper
    pid: 4002,
    parentPid: 4001,
    creationTime: ROOT_CREATED + 80,
    executablePath: `${OWNED_APP}\\electron.exe`,
    commandLine: `"${OWNED_APP}\\electron.exe" --type=gpu-process --user-data-dir=${OWNED_PROFILE}`,
  },
  {
    // pid reuse, direct: an unrelated long-running process (Claude Desktop)
    // recorded ROOT_PID as its parent long before root existed at that number.
    pid: 5000,
    parentPid: ROOT_PID,
    creationTime: ROOT_CREATED - 50_000,
    executablePath: 'C:\\Users\\owner\\AppData\\Local\\AnthropicClaude\\app-2.110.0\\claude.exe',
    commandLine: '"C:\\Users\\owner\\AppData\\Local\\AnthropicClaude\\app-2.110.0\\claude.exe"',
  },
  {
    // pid reuse, one hop deeper: reachable only through the real child's pid
    // number, which was itself recycled from an older, unrelated process.
    pid: 6000,
    parentPid: 4001,
    creationTime: ROOT_CREATED - 40_000,
    executablePath: 'C:\\Users\\owner\\AppData\\Local\\SomeOtherApp\\other.exe',
    commandLine: '"C:\\Users\\owner\\AppData\\Local\\SomeOtherApp\\other.exe"',
  },
  {
    // timing and parentage both check out, but it is simply not this run's
    // process -- proves criterion 3 carries real weight, not redundant with 1+2.
    pid: 7000,
    parentPid: ROOT_PID,
    creationTime: ROOT_CREATED + 70,
    executablePath: 'C:\\Users\\owner\\AppData\\Local\\Temp\\unrelated-tool.exe',
    commandLine: '"C:\\Users\\owner\\AppData\\Local\\Temp\\unrelated-tool.exe" --do-something',
  },
];

test('selectProcessTreeMembers keeps only the verified descendants', () => {
  const { members, diagnostics } = selectProcessTreeMembers(table, ROOT_PID, isOwned);

  assert.deepEqual(
    [...members].sort((a, b) => a - b),
    [ROOT_PID, 4001, 4002],
  );

  const diagnosedPids = diagnostics.map((entry) => entry.pid).sort((a, b) => a - b);
  assert.deepEqual(diagnosedPids, [5000, 6000, 7000]);

  const reasonFor = new Map(diagnostics.map((entry) => [entry.pid, entry.reason]));
  assert.match(reasonFor.get(5000), /before root/u);
  assert.match(reasonFor.get(6000), /before root/u);
  assert.match(reasonFor.get(7000), /not recognised/u);
});

test('selectProcessTreeMembers reports only root when root is missing from the snapshot', () => {
  const { members, diagnostics } = selectProcessTreeMembers(
    table.filter((process) => process.pid !== ROOT_PID),
    ROOT_PID,
    isOwned,
  );
  assert.deepEqual(members, [ROOT_PID]);
  assert.deepEqual(diagnostics, []);
});

test('ownedUnder matches an executable under the root or the marker in a command line, not a same-prefix sibling', () => {
  const owned = ownedUnder(['C:\\lane\\app']);
  assert.equal(owned({ executablePath: 'C:\\lane\\app', commandLine: '' }), true);
  assert.equal(owned({ executablePath: 'C:\\lane\\app\\electron.exe', commandLine: '' }), true);
  assert.equal(owned({ executablePath: 'C:\\lane\\app2\\evil.exe', commandLine: '' }), false);
  assert.equal(
    owned({ executablePath: 'C:\\Windows\\System32\\cmd.exe', commandLine: 'cmd /c "C:\\lane\\app\\x.cmd"' }),
    true,
  );
  assert.equal(owned({ executablePath: 'C:\\Windows\\System32\\cmd.exe', commandLine: 'cmd /c whoami' }), false);
});
