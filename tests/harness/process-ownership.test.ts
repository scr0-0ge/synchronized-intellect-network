import assert from "node:assert/strict";
import test from "node:test";

import { classifyObservedProcesses } from "../e2e/process-ownership.ts";

test("a foreign Runtime observed during the harness window is not owned", () => {
  const classification = classifyObservedProcesses(
    [
      {
        name: "codex.exe",
        pid: 41,
        parentPid: 40,
      },
    ],
    10,
  );

  assert.deepEqual([...classification.ownedPids], [10]);
  assert.deepEqual([...classification.foreignPids], [41]);
});

test("a Runtime parented into the harness Electron process is owned", () => {
  const classification = classifyObservedProcesses(
    [
      {
        name: "claude.exe",
        pid: 11,
        parentPid: 10,
      },
    ],
    10,
  );

  assert.deepEqual([...classification.ownedPids], [10, 11]);
  assert.deepEqual([...classification.foreignPids], []);
});

test("a Runtime parented into a foreign Electron process remains foreign", () => {
  const classification = classifyObservedProcesses(
    [
      {
        name: "electron.exe",
        pid: 20,
        parentPid: 19,
      },
      {
        name: "codex.exe",
        pid: 21,
        parentPid: 20,
      },
    ],
    10,
  );

  assert.deepEqual([...classification.ownedPids], [10]);
  assert.deepEqual([...classification.foreignPids], [20, 21]);
});

test("Electron descendants of Electron descendants are transitively owned", () => {
  const classification = classifyObservedProcesses(
    [
      {
        name: "electron.exe",
        pid: 12,
        parentPid: 11,
      },
      {
        name: "electron.exe",
        pid: 11,
        parentPid: 10,
      },
      {
        name: "codex.exe",
        pid: 13,
        parentPid: 12,
      },
    ],
    10,
  );

  assert.deepEqual([...classification.ownedPids].sort(), [10, 11, 12, 13]);
  assert.deepEqual([...classification.foreignPids], []);
});
