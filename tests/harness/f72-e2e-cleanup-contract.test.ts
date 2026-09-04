import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const electronHarnessUrl = new URL("../e2e/electron-e2e.ts", import.meta.url);
const productionHarnessUrl = new URL(
  "../e2e/f56-f57-production.ts",
  import.meta.url,
);

const [electronHarness, productionHarness] = await Promise.all([
  readFile(electronHarnessUrl, "utf8"),
  readFile(productionHarnessUrl, "utf8"),
]);

const closeTails = [
  {
    name: "main Electron E2E",
    source: sourceBetween(
      electronHarness,
      "async function closeApplication(",
      "class ProcessStartObserver",
    ),
  },
  {
    name: "F56/F57 production E2E",
    source: sourceBetween(
      productionHarness,
      "async function closeOwnedApplication(",
      "async function processAlive(",
    ),
  },
] as const;

test("E2E cleanup falls back only from graceful close to the exact captured child", () => {
  for (const [name, harness, expectedCaptures] of [
    ["main Electron E2E", electronHarness, 3],
    ["F56/F57 production E2E", productionHarness, 1],
  ] as const) {
    const captures = [
      ...harness.matchAll(
        /(\w+) = application\.process\(\);\s*(\w+) = \1\.pid(?: \?\? -1)?;/gu,
      ),
    ];
    assert.equal(
      captures.length,
      expectedCaptures,
      `${name} must capture every application child object and its exact PID together`,
    );
  }

  for (const { name, source } of closeTails) {
    assert.ok(
      /const currentMainProcess = application\.process\(\);[\s\S]*currentMainProcess !== ownedMainProcess[\s\S]*currentMainProcess\.pid !== ownedMainPid/u.test(
        source,
      ),
      `${name} must reject a cleanup target that no longer matches the captured child and PID`,
    );
    assert.doesNotMatch(
      source,
      /application\.process\(\)\.kill\(\)|taskkill|\/IM\b|Stop-Process|Get-Process|pkill|killall|wmic|electron\.exe/iu,
      `${name} must not reacquire or discover a process to terminate`,
    );
    assert.deepEqual(
      source.match(/\b[A-Za-z_]\w*\.kill\(\)/gu) ?? [],
      ["ownedMainProcess.kill()"],
      `${name} must have exactly one destructive kill site on the captured child`,
    );
    assert.ok(
      /withTimeout\(\s*application\.close\(\)|Promise\.race\(\[\s*application\.close\(\)/u.test(
        source,
      ),
      `${name} must bound the product-owned close attempt`,
    );

    const gracefulClose = source.indexOf("application.close()");
    const exactLiveCheck = source.indexOf(
      "isExactOwnedChildAlive(ownedMainProcess, ownedMainPid)",
    );
    const exactKill = source.indexOf("ownedMainProcess.kill()");
    const deathProofs = [
      ...source.matchAll(
        /waitForExactOwnedChildExit\(\s*ownedMainProcess,\s*ownedMainPid/gu,
      ),
    ];
    const verifiedDeath = deathProofs.at(-1)?.index ?? -1;
    assert.ok(gracefulClose >= 0, `${name} must request product-owned close`);
    assert.ok(
      gracefulClose < exactLiveCheck,
      `${name} must wait for product-owned close before considering fallback`,
    );
    assert.ok(
      exactLiveCheck < exactKill,
      `${name} must prove the exact captured child is still alive before fallback`,
    );
    assert.ok(
      exactKill < verifiedDeath,
      `${name} must verify the exact PID is dead after fallback`,
    );
  }
});

test("PID liveness can retain a root but can never authorize destructive fallback", () => {
  for (const { name, authorization, deathProof } of [
    {
      name: "main Electron E2E",
      authorization: sourceBetween(
        electronHarness,
        "function isExactOwnedChildAlive(",
        "async function terminateExactOwnedChild(",
      ),
      deathProof: sourceBetween(
        electronHarness,
        "async function waitForExactOwnedChildExit(",
        "function isExactOwnedChildAlive(",
      ),
    },
    {
      name: "F56/F57 production E2E",
      authorization: sourceBetween(
        productionHarness,
        "function isExactOwnedChildAlive(",
        "async function processAlive(",
      ),
      deathProof: sourceBetween(
        productionHarness,
        "async function waitForExactOwnedChildExit(",
        "function isExactOwnedChildAlive(",
      ),
    },
  ] as const) {
    assert.match(authorization, /child\.pid === ownedPid/u);
    assert.match(authorization, /child\.exitCode === null/u);
    assert.match(authorization, /child\.signalCode === null/u);
    assert.doesNotMatch(
      authorization,
      /process\.kill\(|processAlive\(|isProcessAlive\(/u,
      `${name} must authorize kill from only the captured child object, PID match, and ChildProcess exit state`,
    );

    const childExitObservation = deathProof.indexOf("const exitObserved");
    const conservativePidProbe = Math.max(
      deathProof.indexOf("!isProcessAlive(ownedPid)"),
      deathProof.indexOf("!(await processAlive(ownedPid))"),
    );
    assert.ok(childExitObservation >= 0, `${name} must observe child exit`);
    assert.ok(
      childExitObservation < conservativePidProbe,
      `${name} may probe PID liveness only after the captured child reports exit`,
    );
    assert.match(
      deathProof,
      /return exitObserved &&/u,
      `${name} must short-circuit the PID probe until child exit is observed`,
    );
  }
});

test("emitted cleanup facts distinguish graceful close from a forced exact-child termination request", () => {
  for (const { name, harness, closeTail } of [
    {
      name: "main Electron E2E",
      harness: electronHarness,
      closeTail: closeTails[0].source,
    },
    {
      name: "F56/F57 production E2E",
      harness: productionHarness,
      closeTail: closeTails[1].source,
    },
  ] as const) {
    assert.match(
      harness,
      /type ApplicationCleanupOutcome = Readonly<\{[\s\S]*gracefulCloseSucceeded: boolean;[\s\S]*forcedExactChildTerminationRequested: boolean;[\s\S]*exactChildDeathProved: true;[\s\S]*\}>;/u,
      `${name} must give the three cleanup facts one explicit result shape`,
    );

    const gracefulTry = /try \{(?<body>[\s\S]*?)\} catch \{/u.exec(closeTail)
      ?.groups?.["body"];
    if (gracefulTry === undefined) {
      assert.fail(`${name} must retain a bounded graceful-close try`);
    }
    assert.match(gracefulTry, /application\.close\(\)[\s\S]*gracefulCloseSucceeded = true/u);
    assert.equal(
      closeTail.match(/gracefulCloseSucceeded = true/gu)?.length,
      1,
      `${name} must record graceful success only in the close try`,
    );

    const fallbackGuard = /if \(\s*!exited &&\s*isExactOwnedChildAlive\(ownedMainProcess, ownedMainPid\)\s*\) \{(?<body>[\s\S]*?)\n\s*\}/u.exec(
      closeTail,
    )?.groups?.["body"];
    if (fallbackGuard === undefined) {
      assert.fail(`${name} must retain the exact captured-child fallback guard`);
    }
    assert.match(
      fallbackGuard,
      /forcedExactChildTerminationRequested = true;\s*ownedMainProcess\.kill\(\);/u,
    );
    assert.equal(
      closeTail.match(/forcedExactChildTerminationRequested = true/gu)?.length,
      1,
      `${name} must record the termination request only inside the exact-child guard`,
    );
    assert.match(
      closeTail,
      /if \(!exited\) \{[\s\S]*?throw new [\s\S]*?\n\s*\}[\s\S]*?return Object\.freeze\(\{[\s\S]*?exactChildDeathProved: true/u,
      `${name} may return a death proof only after the survivor branch throws`,
    );
    assert.match(
      closeTail,
      /gracefulCloseSucceeded:\s*gracefulCloseSucceeded &&\s*!forcedExactChildTerminationRequested/u,
      `${name} must never label a forced termination as graceful close`,
    );
  }

  const productionMain = sourceBetween(
    productionHarness,
    "async function main(): Promise<void>",
    "async function seedProductionHistory(",
  );
  assert.doesNotMatch(
    productionMain,
    /applicationClosed|ownedMainProcessExited/u,
    "F56/F57 must replace the ambiguous close/death aliases",
  );
  assert.match(
    productionMain,
    /applicationCleanup = await closeOwnedApplication\([\s\S]*if \(\s*primaryFailure === undefined &&\s*cleanupFailures\.length === 0 &&\s*applicationCleanup\?\.exactChildDeathProved === true\s*\)[\s\S]*cleanup: \{\s*\.\.\.applicationCleanup,\s*isolatedRootRemoved,/u,
    "F56/F57 must emit the actual close outcome returned by cleanup",
  );
  assert.match(productionMain, /f56-f57-production-e2e-v2/u);

  const electronMain = sourceBetween(
    electronHarness,
    "async function main(): Promise<void>",
    "async function createIsolatedPaths(",
  );
  assert.doesNotMatch(
    electronMain,
    /ownedApplicationsClosed/u,
    "the main E2E must not collapse graceful and forced outcomes into closed=true",
  );
  assert.match(electronMain, /electron-e2e-summary-v2/u);
  assert.match(electronMain, /electron-e2e-diagnostics-v2/u);
  assert.match(
    electronMain,
    /applicationCloseOutcomes:\s*applicationCleanupDiagnostics/u,
    "the main E2E must emit phase-specific close outcomes in its result",
  );
  assert.match(
    electronMain,
    /exactChildDeathsProved =\s*applicationCleanupDiagnostics\.length === 3 &&\s*applicationCleanupDiagnostics\.every\(\s*\(outcome\) => outcome\.exactChildDeathProved,[\s\S]*exactChildDeathsProved/u,
    "the main E2E must derive its aggregate death fact from all three phase outcomes",
  );
  assert.match(
    electronHarness,
    /phase:\s*"item4",\s*\.\.\.cleanup/u,
    "the isolated Item 4 cleanup must retain its own disclosure",
  );
  assert.match(
    electronHarness,
    /phase:\s*"positive",\s*\.\.\.cleanup/u,
    "positive cleanup must retain its own disclosure",
  );
  assert.match(
    electronHarness,
    /phase:\s*"negative",\s*\.\.\.cleanup/u,
    "negative cleanup must retain its own disclosure",
  );
});

test("the main E2E always stops its observer and preserves primary plus cleanup failures", () => {
  const observedCases = [
    sourceBetween(
      electronHarness,
      "async function observePositiveComposition(",
      "async function observeItem4Composition(",
    ),
    sourceBetween(
      electronHarness,
      "async function observeItem4Composition(",
      "async function exerciseLiveClaudeComposer(",
    ),
    sourceBetween(
      electronHarness,
      "async function observeNegativeComposition(",
      "function negativeEnvironment(",
    ),
  ];

  for (const source of observedCases) {
    assert.match(
      source,
      /catch \(error\) \{\s*primaryFailure = \{ error \};\s*throw error;\s*\} finally \{/u,
      "the pending test failure must remain available to cleanup",
    );
    assert.match(source, /const cleanupFailures: unknown\[\] = \[\];/u);
    assert.match(
      source,
      /try \{\s*const cleanup = await closeApplication\([\s\S]*?\);\s*if \(cleanup !== undefined\) \{[\s\S]*?applicationCleanupDiagnostics\.push\([\s\S]*?\);\s*\}\s*\} catch \(error\) \{\s*cleanupFailures\.push\(error\);\s*\}/u,
      "application close outcome or failure must be captured rather than skip later cleanup",
    );
    assert.match(
      source,
      /try \{\s*events = await observer\.stop\(\);\s*\} catch \(error\) \{\s*cleanupFailures\.push\(error\);\s*\}/u,
      "observer.stop must be attempted independently of application close",
    );
    assert.match(
      source,
      /throwCleanupFailures\(primaryFailure, cleanupFailures,/u,
      "cleanup failures must be aggregated with any primary failure",
    );
    assert.ok(
      source.indexOf("await closeApplication(") <
        source.indexOf("events = await observer.stop()"),
      "the observer must remain active through the application close attempt",
    );
  }

  const observerStop = sourceBetween(
    electronHarness,
    "  async stop(): Promise<readonly ProcessStartEvent[]>",
    "function parseProcessEvent(",
  );
  assert.match(observerStop, /this\.childPid/u);
  assert.match(
    observerStop,
    /isExactOwnedChildAlive\(this\.child, this\.childPid\)[\s\S]*this\.child\.kill\(\)[\s\S]*waitForExactOwnedChildExit\(\s*this\.child,\s*this\.childPid/u,
    "an observer that cannot stop cleanly must use the same exact-child fallback and death proof",
  );
  assert.match(
    observerStop,
    /await this\.drainOutput\(\)[\s\S]*this\.outputClosed[\s\S]*this\.lines\.removeAllListeners\(\)/u,
    "the observer must drain its output and release its line listeners before returning the final snapshot",
  );
  assert.match(
    electronHarness,
    /error instanceof AggregateError[\s\S]*E2E_CLEANUP_FAILED/u,
    "the emitted safe failure must disclose aggregated cleanup failure",
  );
  const electronClose = sourceBetween(
    electronHarness,
    "async function closeApplication(",
    "function throwCleanupFailures(",
  );
  assert.match(
    electronClose,
    /catch \{\s*gracefulCloseFailed = true;\s*\}[\s\S]*if \(gracefulCloseFailed\) \{\s*throw new HarnessFailure\(\s*"E2E_CLEANUP_FAILED"/u,
    "the main E2E must report a failed product-owned close even after proving exact-child death",
  );
  const internalStepBoundary = sourceBetween(
    electronHarness,
    "async function runInternalStep<T>(",
    "function classifyInternalFailure(",
  );
  assert.match(
    internalStepBoundary,
    /error instanceof HarnessFailure \|\| error instanceof AggregateError/u,
    "step boundaries must not collapse an aggregated primary and cleanup failure",
  );
});

test("owned roots are removed only after successful death proofs and lstat/realpath guards", () => {
  const productionMain = sourceBetween(
    productionHarness,
    "async function main(): Promise<void>",
    "async function seedProductionHistory(",
  );
  assert.match(
    productionMain,
    /catch \(error\) \{\s*primaryFailure = \{ error \};\s*throw error;\s*\} finally \{/u,
  );
  assert.match(
    productionMain,
    /await closeOwnedApplication\([\s\S]*?\);[\s\S]*if \(\s*primaryFailure === undefined &&\s*cleanupFailures\.length === 0 &&\s*applicationCleanup\?\.exactChildDeathProved === true\s*\) \{\s*try \{\s*await removeOwnedTemporaryRoot/u,
    "the production root must not be removed after an unproved application cleanup",
  );
  assert.match(
    productionMain,
    /throwCleanupFailures\(\s*primaryFailure,\s*cleanupFailures,/u,
  );

  const electronMain = sourceBetween(
    electronHarness,
    "async function main(): Promise<void>",
    "async function createIsolatedPaths(",
  );
  assert.match(
    electronMain,
    /if \(temporaryRoot\.length > 0 && failure === undefined\)/u,
    "the main harness must retain its owned root after any case or cleanup failure",
  );

  for (const { name, source } of [
    {
      name: "main Electron E2E",
      source: sourceBetween(
        electronHarness,
        "async function removeOwnedTemporaryRoot(",
        "function safeFailure(",
      ),
    },
    {
      name: "F56/F57 production E2E",
      source: sourceBetween(
        productionHarness,
        "async function removeOwnedTemporaryRoot(",
        "function productionEnvironment(",
      ),
    },
  ] as const) {
    const lstatGuard = source.indexOf("await lstat(");
    const resolvedRoot = source.indexOf("await realpath(");
    const recursiveRemoval = source.indexOf("await rm(");
    assert.ok(lstatGuard >= 0, `${name} must lstat its owned root`);
    assert.ok(
      lstatGuard < resolvedRoot && resolvedRoot < recursiveRemoval,
      `${name} must lstat and realpath before recursive removal`,
    );
    assert.match(source, /isDirectory\(\)[\s\S]*isSymbolicLink\(\)/u);
    assert.match(source, /await realpath\(tmpdir\(\)\)/u);
  }
});

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
