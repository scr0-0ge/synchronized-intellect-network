import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

const facadeUrl = new URL("../e2e/f72-close-to-tray.ts", import.meta.url);
const idleUrl = new URL("../e2e/f72-close-to-tray/idle.ts", import.meta.url);
const heldActiveUrl = new URL(
  "../e2e/f72-close-to-tray/held-active.ts",
  import.meta.url,
);
const supportUrl = new URL(
  "../e2e/f72-close-to-tray/support.ts",
  import.meta.url,
);
const windowLifecycleUrl = new URL(
  "../e2e/f72-close-to-tray/window-lifecycle.ts",
  import.meta.url,
);
const descendantSweepUrl = new URL(
  "../e2e/f72-close-to-tray/descendant-sweep.ts",
  import.meta.url,
);

test("only the held turn owner acknowledges release across app-server invocations", async () => {
  const source = await readFile(heldActiveUrl, "utf8");
  const runtimeSource = extractHeldRuntimeSource(source);
  const temporaryRoot = await mkdtemp(
    join(resolve(tmpdir()), "workbench-f72-held-driver-test-"),
  );
  const projectDirectory = join(temporaryRoot, "project");
  const controlDirectory = join(temporaryRoot, "control");
  const appServerPath = join(projectDirectory, "app-server.cjs");
  const readyPath = join(controlDirectory, "held-runtime-ready.json");
  const releasePendingPath = join(
    controlDirectory,
    "held-runtime-release.pending",
  );
  const releasePath = join(controlDirectory, "held-runtime-release.txt");
  const exitPath = join(controlDirectory, "held-runtime-exit.json");
  const ownerNonce = randomUUID();
  let catalogRuntime: ChildProcessWithoutNullStreams | undefined;
  let turnRuntime: ChildProcessWithoutNullStreams | undefined;

  try {
    await Promise.all([
      mkdir(projectDirectory),
      mkdir(controlDirectory),
    ]);
    await writeFile(appServerPath, runtimeSource, {
      encoding: "utf8",
      flag: "wx",
    });

    const environment = {
      ...process.env,
      UAW_F72_HELD_CONTROL_DIRECTORY: controlDirectory,
      UAW_F72_HELD_OWNER_NONCE: ownerNonce,
    };
    catalogRuntime = spawn(process.execPath, [appServerPath], {
      cwd: projectDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    turnRuntime = spawn(process.execPath, [appServerPath], {
      cwd: projectDirectory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const catalogProtocol = observeProtocol(catalogRuntime);
    const turnProtocol = observeProtocol(turnRuntime);

    writeProtocol(catalogRuntime, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "model/list", params: {} },
    ]);
    await waitForProtocol(
      catalogProtocol,
      (messages) => hasResponses(messages, [1, 2]),
    );

    writeProtocol(turnRuntime, [
      { jsonrpc: "2.0", id: 11, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 12, method: "thread/start", params: {} },
      { jsonrpc: "2.0", id: 13, method: "turn/start", params: {} },
    ]);
    const ready = await readControlJson(readyPath);

    catalogRuntime.stdin.end();
    await waitForChildExit(catalogRuntime);
    const nonTurnAckAbsent = !(await fileExists(exitPath));

    await writeFile(releasePendingPath, `${ownerNonce}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(releasePendingPath, releasePath);
    await waitForProtocol(
      turnProtocol,
      (messages) =>
        messages.some((message) => message.method === "turn/completed"),
    );
    await waitForChildExit(turnRuntime);
    const exitAcknowledgement = await readControlJson(exitPath);

    assert.deepEqual(
      {
        nonTurnAckAbsent,
        readyOwnedByTurnInvocation:
          Number.isSafeInteger(turnRuntime.pid) && ready.pid === turnRuntime.pid,
        itemCompleted: turnProtocol.messages.some(
          (message) => message.method === "item/completed",
        ),
        turnCompleted: turnProtocol.messages.some(
          (message) => message.method === "turn/completed",
        ),
        releasedAcknowledgement:
          exitAcknowledgement.reason === "released" &&
          exitAcknowledgement.exitCode === 0,
        exitOwnedByReadyInvocation:
          exitAcknowledgement.pid === ready.pid,
        ownerExitedCleanly: turnRuntime.exitCode === 0,
      },
      {
        nonTurnAckAbsent: true,
        readyOwnedByTurnInvocation: true,
        itemCompleted: true,
        turnCompleted: true,
        releasedAcknowledgement: true,
        exitOwnedByReadyInvocation: true,
        ownerExitedCleanly: true,
      },
    );
  } finally {
    await Promise.all([
      stopOwnedTestChild(catalogRuntime),
      stopOwnedTestChild(turnRuntime),
    ]);
    await removeOwnedTestRoot(temporaryRoot);
  }
});

test("F72 held-active driver is explicit, durable, owner-bound, and cleanup-safe", async () => {
  const [
    facadeSource,
    idleSource,
    heldActiveSource,
    supportSource,
    windowLifecycleSource,
    descendantSweepSource,
  ] = await Promise.all([
    readFile(facadeUrl, "utf8"),
    readFile(idleUrl, "utf8"),
    readFile(heldActiveUrl, "utf8"),
    readFile(supportUrl, "utf8"),
    readFile(windowLifecycleUrl, "utf8"),
    readFile(descendantSweepUrl, "utf8"),
  ]);
  const source = [
    facadeSource,
    idleSource,
    heldActiveSource,
    supportSource,
    windowLifecycleSource,
    descendantSweepSource,
  ].join("\n");
  const heldScenario = sourceSlice(
    heldActiveSource,
    "async function runHeldActiveScenario(): Promise<void> {",
    "async function prepareHeldCodexRuntime(",
  );
  const scenarioGate = sourceSlice(
    facadeSource,
    "function readScenario(",
    "async function runIdleScenario(): Promise<void> {",
  );
  const heldRuntimePreparation = sourceSlice(
    heldActiveSource,
    "async function prepareHeldCodexRuntime(",
    "function heldCodexRuntimeSource(",
  );
  const heldRuntimeSource = sourceSlice(
    heldActiveSource,
    "function heldCodexRuntimeSource(",
    "async function readHeldRuntimeManifest(",
  );
  const heldRuntimeManifest = sourceSlice(
    heldActiveSource,
    "async function readHeldRuntimeManifest(",
    "async function releaseHeldRuntime(",
  );
  const heldRuntimeRelease = sourceSlice(
    heldActiveSource,
    "async function releaseHeldRuntime(",
    "async function waitForHeldRuntimeExitAcknowledgement(",
  );
  const heldRuntimeExitAcknowledgement = sourceSlice(
    heldActiveSource,
    "async function waitForHeldRuntimeExitAcknowledgement(",
    "function assertHeldRuntimeOwnership(",
  );
  const heldPublicSummary = sourceSlice(
    heldScenario,
    "    summary = {",
    "  } catch (error) {",
  );
  const heldRuntimeControl = sourceSlice(
    heldActiveSource,
    "async function prepareHeldCodexRuntime(",
    "async function waitForSingleOwnedLedgerPath(",
  );
  const durableObservation = sourceSlice(
    heldActiveSource,
    "function readDurableCommandObservation(",
    "async function waitForDurableCommandStatus(",
  );
  const dialogObservation = sourceSlice(
    heldActiveSource,
    "async function installHeldActiveDialogObservation(",
    "async function restoreHeldWindowViaSecondInstance(",
  );
  const rootRemoval = sourceSlice(
    supportSource,
    "async function removeOwnedTemporaryRoot(",
    "async function pathExists(",
  );

  assert.match(
    source,
    /type F72Scenario = "idle" \| "held-active";/u,
  );
  assert.match(
    scenarioGate,
    /arguments_\.length === 1 && arguments_\[0\] === "--scenario=held-active"/u,
  );
  assert.match(scenarioGate, /throw new Error\("f72-scenario-invalid"\)/u);
  assert.match(
    source,
    /const scenario = readScenario\(process\.argv\.slice\(2\)\);[\s\S]*scenario === "held-active"[\s\S]*runHeldActiveScenario\(\)[\s\S]*runIdleScenario\(\)/u,
  );
  assert.doesNotMatch(source, /UAW_F72_SCENARIO|process\.env\.[A-Z_]*SCENARIO/u);

  assert.match(
    heldRuntimePreparation,
    /copyFile\(process\.execPath, heldExecutablePath\)/u,
  );
  assert.match(
    heldRuntimePreparation,
    /writeFile\(appServerPath, heldCodexRuntimeSource\(\), \{[\s\S]*flag: "wx"/u,
  );
  assert.match(
    heldRuntimePreparation,
    /assertOwnedRegularFile\(heldExecutablePath, options\.temporaryRoot\)/u,
  );
  assert.match(
    heldRuntimePreparation,
    /assertOwnedRegularFile\(appServerPath, options\.temporaryRoot\)/u,
  );
  assert.match(heldRuntimeSource, /process\.env\.UAW_F72_HELD_OWNER_NONCE/u);
  assert.match(
    heldRuntimePreparation,
    /const exitPath = join\(options\.controlDirectory, "held-runtime-exit\.json"\)/u,
  );
  assert.match(
    heldRuntimeSource,
    /function publishControlFile\(targetPath, contents\) \{[\s\S]*writeFileSync\(pendingPath, contents,[\s\S]*flag: "wx"[\s\S]*renameSync\(pendingPath, targetPath\)/u,
  );
  assert.match(heldRuntimeSource, /let heldTurnOwned = false;/u);
  assertOrdered(heldRuntimeSource, [
    "if (!heldTurnOwned) process.exit(exitCode);",
    "publishControlFile(\n      exitPath,",
  ]);
  assertOrdered(heldRuntimeSource, [
    "publishControlFile(\n      readyPath,",
    "heldTurnOwned = true;",
    "waitForRelease();",
  ]);
  assert.match(heldRuntimeSource, /method === "turn\/start"/u);
  assert.match(heldRuntimeSource, /method: "turn\/completed"/u);
  assert.doesNotMatch(heldRuntimeSource, /input\[[^\]]*\]\.text|\.params\.input/u);
  assert.match(
    heldRuntimeManifest,
    /hasExactObjectKeys\(value, \[[\s\S]*"executablePath"[\s\S]*"ownerNonce"[\s\S]*"pid"[\s\S]*"projectDirectory"[\s\S]*"schema"/u,
  );
  assert.match(heldRuntimeManifest, /value\.ownerNonce !== control\.ownerNonce/u);
  assert.match(
    heldRuntimeManifest,
    /comparablePath\(value\.executablePath\) !==[\s\S]*comparablePath\(control\.heldExecutablePath\)/u,
  );
  assert.match(heldRuntimeManifest, /await processAlive\(value\.pid as number\)/u);
  assert.match(
    heldRuntimeRelease,
    /assertOwnedControlFileTarget\([\s\S]*control\.releasePath[\s\S]*"held-runtime-release\.txt"/u,
  );
  assert.match(
    heldRuntimeRelease,
    /const releasePendingPath = join\([\s\S]*control\.controlDirectory,[\s\S]*"held-runtime-release\.pending"[\s\S]*\)/u,
  );
  assert.match(
    heldRuntimeRelease,
    /writeFile\(releasePendingPath, `\$\{control\.ownerNonce\}\\n`, \{[\s\S]*flag: "wx"/u,
  );
  assertOrdered(heldRuntimeRelease, [
    "await writeFile(releasePendingPath,",
    "await rename(releasePendingPath, control.releasePath);",
  ]);
  assert.match(heldRuntimeSource, /const SELF_WATCHDOG_MILLISECONDS = \d+;/u);
  assert.match(
    heldRuntimeSource,
    /setTimeout\([\s\S]*finishOwnedRuntime\("watchdog", \d+\)[\s\S]*SELF_WATCHDOG_MILLISECONDS/u,
  );
  assert.match(
    heldRuntimeSource,
    /publishControlFile\([\s\S]*exitPath[\s\S]*schema: "f72-held-codex-runtime-exit-v1"[\s\S]*ownerNonce/u,
  );
  assert.match(
    heldRuntimeSource,
    /release !== ownerNonce \+ "\\n"[\s\S]*finishOwnedRuntime\("released", 0\)/u,
  );
  assert.match(
    heldRuntimeExitAcknowledgement,
    /hasExactObjectKeys\(value, \[[\s\S]*"exitCode"[\s\S]*"executablePath"[\s\S]*"ownerNonce"[\s\S]*"pid"[\s\S]*"projectDirectory"[\s\S]*"reason"[\s\S]*"schema"/u,
  );
  assert.match(
    heldRuntimeExitAcknowledgement,
    /value\.ownerNonce !== control\.ownerNonce/u,
  );
  assert.match(
    heldRuntimeExitAcknowledgement,
    /value\.pid !== manifest\.pid/u,
  );
  assert.match(
    heldScenario,
    /waitForHeldRuntimeExitAcknowledgement\([\s\S]*"released"/u,
  );
  assert.doesNotMatch(
    heldPublicSummary,
    /\b(?:primaryPid|secondaryPid|heldRuntimePid|commandId|exitAcknowledgement|ownerNonce|executablePath|projectDirectory)\s*:/u,
  );
  assert.match(
    heldPublicSummary,
    /identityCorrelation:\s*\{[\s\S]*primaryChildCaptured:[\s\S]*secondaryChildCaptured:[\s\S]*runtimeReadyExitSameInvocation:[\s\S]*sameWindow:[\s\S]*sameWebContents:/u,
  );
  assert.match(
    heldPublicSummary,
    /exitCorrelation:\s*\{[\s\S]*sameNonce:[\s\S]*sameExecutable:[\s\S]*sameProject:[\s\S]*samePid:[\s\S]*released:[\s\S]*exitCodeZero:/u,
  );
  assert.doesNotMatch(heldRuntimeControl, /process\.kill|\.kill\(\s*manifest\.pid/u);
  assert.doesNotMatch(heldRuntimeControl, /(?:taskkill|Get-Process|Stop-Process|wmic|Win32_Process)/iu);
  assert.doesNotMatch(source, /stopOwnedHeldRuntime/u);

  assert.match(source, /import \{ DatabaseSync \} from "node:sqlite";/u);
  assert.match(durableObservation, /new DatabaseSync\(databasePath, \{ readOnly: true \}\)/u);
  assert.match(
    durableObservation,
    /SELECT command_id, status, accepted_cursor[\s\S]*FROM commands[\s\S]*ORDER BY accepted_cursor/u,
  );
  assert.match(
    durableObservation,
    /SELECT cursor, command_id, kind, status[\s\S]*FROM updates[\s\S]*ORDER BY cursor/u,
  );
  assert.doesNotMatch(durableObservation, /private_envelope_json|data_json/u);
  assert.match(
    heldScenario,
    /assert\.deepEqual\(acceptedResult, \{[\s\S]*ok: true,[\s\S]*status: "accepted",[\s\S]*message: "Direct input was durably accepted\."/u,
  );
  assert.match(
    heldScenario,
    /assertDurableLifecycle\(inFlightObservation, commandId, \[[\s\S]*"accepted"[\s\S]*"in-flight"/u,
  );
  assert.match(
    heldScenario,
    /assertDurableLifecycle\(terminalObservation, commandId, \[[\s\S]*"accepted"[\s\S]*"in-flight"[\s\S]*"completed"/u,
  );

  assert.match(dialogObservation, /const response = hideAuthorized \? 1 : 0;/u);
  assert.match(
    heldScenario,
    /buttons: \["Keep open", "Hide to tray"\],[\s\S]*defaultId: 0,[\s\S]*cancelId: 0,[\s\S]*response: 1/u,
  );
  assert.match(heldScenario, /parentWindowId: initialWindow\.id/u);
  assert.match(heldScenario, /dialogCalls: 1/u);

  assert.match(heldScenario, /restoreHeldWindowViaSecondInstance\(/u);
  assert.match(heldScenario, /id: initialWindow\.id/u);
  assert.match(heldScenario, /webContentsId: initialWindow\.webContentsId/u);
  assert.match(heldScenario, /sameWindow: true/u);
  assert.match(heldScenario, /sameWebContents: true/u);
  assertOrdered(heldScenario, [
    "const inFlightObservation = await waitForDurableCommandStatus(",
    "window.close();",
    "restoreHeldWindowViaSecondInstance(",
    "releaseHeldRuntime(heldRuntimeControl, heldRuntimeManifest)",
    "const terminalObservation = await waitForDurableCommandStatus(",
    "const heldRuntimeExitAcknowledgement =",
  ]);

  assert.match(
    heldScenario,
    /heldRuntimeExited[\s\S]*primaryExited[\s\S]*secondaryExited[\s\S]*isolatedRootRemoved/u,
  );
  assert.match(
    heldScenario,
    /if \([\s\S]*heldRuntimeExitAcknowledged[\s\S]*heldRuntimeExited[\s\S]*primaryExited[\s\S]*secondaryExited[\s\S]*\) \{[\s\S]*removeOwnedTemporaryRoot\(temporaryRoot\)/u,
  );
  assert.match(rootRemoval, /lstat\(root\)/u);
  assert.match(rootRemoval, /information\.isSymbolicLink\(\)/u);
  assert.match(rootRemoval, /realpath\(root\)/u);
  assert.match(rootRemoval, /dirname\(resolvedRoot\) !== resolvedTemporaryDirectory/u);
  assert.match(rootRemoval, /temporaryRootPattern\.test\(basename\(resolvedRoot\)\)/u);
  assert.match(rootRemoval, /rm\(resolvedRoot, \{ recursive: true, force: true \}\)/u);

  const idleScenario = sourceSlice(
    idleSource,
    "async function runIdleScenario(): Promise<void> {",
    "async function observeIdleCloseOutcome(",
  );
  assert.match(idleScenario, /schema: "f72-close-to-tray-production-e2e-v1"/u);
  assert.match(idleScenario, /dialogCalls: 0/u);
  assert.match(idleScenario, /sameWindow: true/u);
  assert.match(idleScenario, /appearanceReopenedAndParsed: true/u);
});

test("held-active authorizes exactly one safe close dialog and proves no destructive approval", async () => {
  const source = await readFile(heldActiveUrl, "utf8");
  const heldScenario = sourceSlice(
    source,
    "async function runHeldActiveScenario(): Promise<void> {",
    "async function prepareHeldCodexRuntime(",
  );
  const dialogObservation = sourceSlice(
    source,
    "async function installHeldActiveDialogObservation(",
    "async function restoreHeldWindowViaSecondInstance(",
  );

  assert.match(
    heldScenario,
    /installHeldActiveDialogObservation\([\s\S]*initialWindow\.id[\s\S]*heldRuntimeControl\.dialogObservationPath/u,
  );
  assert.match(
    dialogObservation,
    /phase: "awaiting-active-close"[\s\S]*hideAuthorizationUsed: false/u,
  );
  assert.match(
    dialogObservation,
    /state\.phase === "awaiting-active-close"[\s\S]*!state\.hideAuthorizationUsed[\s\S]*parentWindowId === expectedWindowId[\s\S]*buttons\.length === 2[\s\S]*buttons\[0\] === "Keep open"[\s\S]*buttons\[1\] === "Hide to tray"[\s\S]*options\.defaultId === 0[\s\S]*options\.cancelId === 0/u,
  );
  assert.match(dialogObservation, /const response = hideAuthorized \? 1 : 0;/u);
  assert.doesNotMatch(
    dialogObservation,
    /(?:includes|indexOf)\("Quit anyway"\)[^;\n]*(?:\?|&&)[^;\n]*1/u,
  );
  assert.match(
    dialogObservation,
    /writeFileSync\([\s\S]*observationPath[\s\S]*\{ encoding: "utf8", flag \}/u,
  );
  assert.match(dialogObservation, /writeHeldDialogState\("wx"\)/u);
  assert.match(
    dialogObservation,
    /state\.phase = "true-quit-armed"[\s\S]*target\.__f72WriteHeldDialogState\(\)/u,
  );
  assert.match(
    heldScenario,
    /const preQuitDialogProof = await armHeldActiveTrueQuit\([\s\S]*dialogCalls: 1[\s\S]*destructiveAutoApprovals: 0/u,
  );
  assert.match(
    heldScenario,
    /const finalDialogProof = await readHeldDialogObservationLog\([\s\S]*phase: "true-quit-armed"[\s\S]*dialogCalls: 1[\s\S]*destructiveAutoApprovals: 0/u,
  );
  assertOrdered(heldScenario, [
    "const preQuitDialogProof = await armHeldActiveTrueQuit(",
    "await application.evaluate(({ app }) => app.quit());",
    "const finalDialogProof = await readHeldDialogObservationLog(",
  ]);
});

test("idle close preserves a bounded sanitized public lifecycle observation on failure", async () => {
  const source = await readFile(idleUrl, "utf8");

  assert.match(
    source,
    /type IdleCloseDialogClassification =\s*\| "activity-guard"\s*\| "tray-unavailable"\s*\| "none";/u,
  );
  assert.match(
    source,
    /type IdleCloseOutcome =\s*\| "hidden-success"\s*\| "safe-keep-open-dialog"\s*\| "fixed-failure";/u,
  );
  assert.match(
    source,
    /type IdleCloseStep =\s*\| "close-hidden"\s*\| "close-kept-open-dialog"\s*\| "close-outcome-unresolved";/u,
  );

  const idleScenario = sourceSlice(
    source,
    "async function runIdleScenario(): Promise<void> {",
    "async function observeIdleCloseOutcome(",
  );
  const idleCloseObserver = sourceSlice(
    source,
    "async function observeIdleCloseOutcome(",
    "async function installDialogAndRestoreObservation(",
  );
  const idleDialogObservation = sourceSlice(
    source,
    "async function installDialogAndRestoreObservation(",
    "async function inspectSingleInstanceSourceGate(",
  );

  assert.match(
    source,
    /interface IdleCloseObservation \{[\s\S]*readonly step: IdleCloseStep;[\s\S]*readonly outcome: IdleCloseOutcome;[\s\S]*readonly dialog: IdleCloseDialogObservation;[\s\S]*readonly preWindow: IdleCloseWindowObservation;[\s\S]*readonly postWindow: IdleCloseWindowObservation;[\s\S]*readonly sameWindow: boolean;[\s\S]*readonly sameWebContents: boolean;[\s\S]*\}/u,
  );
  assert.match(
    source,
    /interface IdleCloseDialogObservation \{[\s\S]*readonly callCount: number;[\s\S]*readonly classification: IdleCloseDialogClassification;[\s\S]*readonly buttons: readonly string\[\] \| null;[\s\S]*readonly defaultId: number \| null;[\s\S]*readonly cancelId: number \| null;[\s\S]*readonly response: 0 \| null;[\s\S]*\}/u,
  );
  assert.match(
    source,
    /interface IdleCloseWindowObservation \{[\s\S]*readonly count: number \| null;[\s\S]*readonly id: number \| null;[\s\S]*readonly webContentsId: number \| null;[\s\S]*readonly destroyed: boolean \| null;[\s\S]*readonly visible: boolean \| null;[\s\S]*\}/u,
  );

  assert.match(idleCloseObserver, /timeoutMilliseconds = 10_000/u);
  assert.match(
    idleCloseObserver,
    /const deadline = Date\.now\(\) \+ timeoutMilliseconds;[\s\S]*while \(Date\.now\(\) < deadline\)[\s\S]*setTimeout\(resolveWait, 25\)/u,
  );
  assert.match(
    idleCloseObserver,
    /BrowserWindow\.getAllWindows\(\)[\s\S]*window\.close\(\)/u,
  );
  assert.match(
    idleCloseObserver,
    /preWindow:[\s\S]*count:[\s\S]*id:[\s\S]*webContentsId:[\s\S]*destroyed:[\s\S]*visible:/u,
  );
  assert.match(
    idleCloseObserver,
    /postWindow:[\s\S]*count:[\s\S]*id:[\s\S]*webContentsId:[\s\S]*destroyed:[\s\S]*visible:/u,
  );
  assert.match(
    idleCloseObserver,
    /sameWindow[\s\S]*sameWebContents[\s\S]*dialog\.callCount === 0[\s\S]*dialog\.classification === "none"[\s\S]*dialog\.buttons === null[\s\S]*dialog\.defaultId === null[\s\S]*dialog\.cancelId === null[\s\S]*dialog\.response === null/u,
  );
  assert.match(
    idleCloseObserver,
    /step: "close-hidden",[\s\S]*outcome: "hidden-success"/u,
  );
  assert.match(
    idleCloseObserver,
    /dialog\.callCount === 1[\s\S]*dialog\.classification !== "none"[\s\S]*dialog\.buttons !== null[\s\S]*dialog\.defaultId === 0[\s\S]*dialog\.cancelId === 0[\s\S]*dialog\.response === 0[\s\S]*step: "close-kept-open-dialog",[\s\S]*outcome: "safe-keep-open-dialog"/u,
  );
  assert.match(
    idleCloseObserver,
    /step: "close-outcome-unresolved",[\s\S]*outcome: "fixed-failure"/u,
  );
  assert.doesNotMatch(idleCloseObserver, /\b(?:url|stack|provider|stdout|stderr)\b/iu);

  assert.match(
    idleDialogObservation,
    /callCount: 0,[\s\S]*classification: "none"[\s\S]*buttons: null[\s\S]*defaultId: null[\s\S]*cancelId: null[\s\S]*response: null/u,
  );
  assert.match(
    idleDialogObservation,
    /buttons\[0\] === "Keep open"[\s\S]*buttons\[1\] === "Hide to tray"[\s\S]*"activity-guard"/u,
  );
  assert.match(
    idleDialogObservation,
    /buttons\[0\] === "Keep open"[\s\S]*buttons\[1\] === "Quit\\u2026"[\s\S]*"tray-unavailable"/u,
  );
  assert.match(
    idleDialogObservation,
    /const response = 0 as const;[\s\S]*return \{ response, checkboxChecked: false \}/u,
  );
  assert.doesNotMatch(
    idleDialogObservation,
    /const response\s*=\s*[^;]*(?:\?|&&)[^;]*1|response:\s*1/u,
  );
  assert.doesNotMatch(
    idleDialogObservation,
    /options\?\.(?:message|detail|title)|\b(?:message|detail|title):\s*options/u,
  );

  assert.doesNotMatch(
    idleScenario,
    /const hiddenWindow = await waitForMainWindow\([\s\S]*!window\.visible/u,
  );
  assert.match(
    idleScenario,
    /const closeObservation = await observeIdleCloseOutcome\([\s\S]*application,[\s\S]*initialWindow/u,
  );
  assert.match(
    idleScenario,
    /if \(closeObservation\.outcome !== "hidden-success"\) \{[\s\S]*schema: "f72-idle-close-diagnostic-v1",[\s\S]*step: closeObservation\.step,[\s\S]*category: "f72-idle-close-outcome-not-hidden",[\s\S]*observation: closeObservation,[\s\S]*F72_IDLE_CLOSE_DIAGNOSTIC \$\{JSON\.stringify\(idleCloseDiagnostic\)\}[\s\S]*throw new Error\("f72-idle-close-outcome-not-hidden"\)/u,
  );
  assert.doesNotMatch(
    sourceSlice(
      idleScenario,
      "const idleCloseDiagnostic = {",
      "throw new Error(\"f72-idle-close-outcome-not-hidden\");",
    ),
    /\b(?:error|stack|path|pid|url|provider|message|detail|title|stdout|stderr)\s*:/iu,
  );
  assertOrdered(idleScenario, [
    "const closeObservation = await observeIdleCloseOutcome(",
    'if (closeObservation.outcome !== "hidden-success") {',
    "console.error(",
    'throw new Error("f72-idle-close-outcome-not-hidden");',
    "const hiddenWindow = closeObservation.postWindow;",
    "primaryFailure = { error };",
    "await stopOwnedApplication(",
  ]);
});

test("cleanup authorizes termination only through captured ChildProcess state", async () => {
  const [idleSource, heldActiveSource, supportSource] = await Promise.all([
    readFile(idleUrl, "utf8"),
    readFile(heldActiveUrl, "utf8"),
    readFile(supportUrl, "utf8"),
  ]);
  const idleScenario = sourceSlice(
    idleSource,
    "async function runIdleScenario(): Promise<void> {",
    "async function observeIdleCloseOutcome(",
  );
  const heldScenario = sourceSlice(
    heldActiveSource,
    "async function runHeldActiveScenario(): Promise<void> {",
    "async function prepareHeldCodexRuntime(",
  );
  const cleanup = sourceSlice(
    supportSource,
    "async function stopOwnedApplication(",
    "async function removeOwnedTemporaryRoot(",
  );
  const ownedApplicationCleanup = sourceSlice(
    supportSource,
    "async function stopOwnedApplication(",
    "async function stopOwnedChild(",
  );
  const ownedChildCleanup = sourceSlice(
    supportSource,
    "async function stopOwnedChild(",
    "async function waitForExactOwnedChildExit(",
  );
  const exactExitWait = sourceSlice(
    supportSource,
    "async function waitForExactOwnedChildExit(",
    "function isExactOwnedChildAlive(",
  );
  const exactAliveGate = sourceSlice(
    supportSource,
    "function isExactOwnedChildAlive(",
    "async function processAlive(",
  );

  for (const scenario of [idleScenario, heldScenario]) {
    assert.match(scenario, /let ownedMainProcess: ChildProcess \| undefined;/u);
    assert.match(
      scenario,
      /const primaryProcess = application\.process\(\);[\s\S]*const primaryPid = primaryProcess\.pid;[\s\S]*ownedMainProcess = primaryProcess;/u,
    );
    assert.match(
      scenario,
      /stopOwnedApplication\([\s\S]*application,[\s\S]*ownedMainProcess,[\s\S]*ownedMainPid/u,
    );
  }
  assert.match(
    ownedApplicationCleanup,
    /currentMainProcess !== ownedMainProcess[\s\S]*currentMainProcess\.pid !== ownedMainPid/u,
  );
  assertOrdered(ownedApplicationCleanup, [
    "application.close()",
    "waitForExactOwnedChildExit(",
    "isExactOwnedChildAlive(ownedMainProcess, ownedMainPid)",
    "ownedMainProcess.kill()",
  ]);
  assert.match(
    ownedChildCleanup,
    /isExactOwnedChildAlive\(child, ownedPid\)[\s\S]*child\.kill\(\)[\s\S]*waitForExactOwnedChildExit/u,
  );
  assert.match(
    exactAliveGate,
    /child\.pid === ownedPid[\s\S]*child\.exitCode === null[\s\S]*child\.signalCode === null/u,
  );
  assert.doesNotMatch(exactAliveGate, /processAlive|process\.kill/u);
  assert.match(
    exactExitWait,
    /child\.exitCode !== null[\s\S]*child\.signalCode !== null[\s\S]*waitForChildProcessExit\(child\)[\s\S]*exitObserved && !\(await processAlive\(ownedPid\)\)/u,
  );
  assert.doesNotMatch(
    cleanup,
    /processAlive\([^)]*\)[\s\S]{0,160}(?:child|ownedMainProcess)\.kill\(\)/u,
  );
  assert.doesNotMatch(cleanup, /waitUntilDead\(ownedPid/u);
});

test("scenario and cleanup failures are preserved together before guarded root removal", async () => {
  const [facadeSource, idleSource, heldActiveSource, supportSource] =
    await Promise.all([
      readFile(facadeUrl, "utf8"),
      readFile(idleUrl, "utf8"),
      readFile(heldActiveUrl, "utf8"),
      readFile(supportUrl, "utf8"),
    ]);
  const idleScenario = sourceSlice(
    idleSource,
    "async function runIdleScenario(): Promise<void> {",
    "async function observeIdleCloseOutcome(",
  );
  const heldScenario = sourceSlice(
    heldActiveSource,
    "async function runHeldActiveScenario(): Promise<void> {",
    "async function prepareHeldCodexRuntime(",
  );
  const restore = sourceSlice(
    heldActiveSource,
    "async function restoreHeldWindowViaSecondInstance(",
    "export { runHeldActiveScenario };",
  );
  const failureAggregation = sourceSlice(
    supportSource,
    "function throwCleanupFailures(",
    "export {",
  );
  const safeFailure = sourceSlice(
    facadeSource,
    "function safeFailureMessage(",
    "async function main(): Promise<void>",
  );

  for (const [name, scenario] of [
    ["idle", idleScenario],
    ["held-active", heldScenario],
  ] as const) {
    assert.match(
      scenario,
      /let primaryFailure: \{ readonly error: unknown \} \| undefined;/u,
      `${name} must retain its primary failure`,
    );
    assert.match(
      scenario,
      /catch \(error\) \{\s*primaryFailure = \{ error \};\s*throw error;\s*\} finally \{\s*const cleanupFailures: unknown\[\] = \[\];/u,
      `${name} must enter cleanup with the primary failure preserved`,
    );
    assert.match(
      scenario,
      /try \{[\s\S]*stopOwnedApplication\([\s\S]*\);[\s\S]*\} catch \(error\) \{\s*cleanupFailures\.push\(error\);\s*\}/u,
      `${name} must capture application cleanup failure`,
    );
    assert.match(
      scenario,
      /if \(primaryFailure === undefined && cleanupFailures\.length === 0\) \{[\s\S]*removeOwnedTemporaryRoot\(temporaryRoot\)/u,
      `${name} must retain the root after primary or cleanup failure`,
    );
    assert.match(
      scenario,
      /throwCleanupFailures\([\s\S]*primaryFailure,[\s\S]*cleanupFailures,/u,
      `${name} must aggregate cleanup with the primary failure`,
    );
  }
  assert.match(
    idleScenario,
    /if \(!primaryExited \|\| !secondaryExited\)[\s\S]*f72-idle-cleanup-death-proof-incomplete/u,
  );
  assert.match(
    heldScenario,
    /!heldRuntimeExitAcknowledged \|\|[\s\S]*!heldRuntimeExited \|\|[\s\S]*!primaryExited \|\|[\s\S]*!secondaryExited[\s\S]*f72-held-cleanup-death-proof-incomplete/u,
  );
  assert.match(
    failureAggregation,
    /if \(cleanupFailures\.length === 0\) return;[\s\S]*throw new AggregateError\([\s\S]*\[primaryFailure\.error, \.\.\.cleanupFailures\]/u,
  );
  assert.match(
    restore,
    /catch \(error\) \{[\s\S]*catch \(cleanupError\) \{[\s\S]*throw new AggregateError\([\s\S]*\[error, cleanupError\]/u,
  );
  assert.match(safeFailure, /error instanceof AggregateError/u);
  assert.match(
    safeFailure,
    /error\.errors[\s\S]*\.map\(safeFailureMessage\)/u,
  );
  assert.match(
    facadeSource,
    /console\.error\(safeFailureMessage\(error\)\)/u,
  );
});

interface ProtocolObservation {
  readonly messages: Array<Record<string, unknown>>;
  malformed: boolean;
}

function extractHeldRuntimeSource(source: string): string {
  const heldRuntime = sourceSlice(
    source,
    "function heldCodexRuntimeSource(): string {",
    "async function readHeldRuntimeManifest(",
  );
  const startMarker = "return String.raw`";
  const start = heldRuntime.indexOf(startMarker);
  const end = heldRuntime.lastIndexOf("`;");
  assert.notEqual(start, -1, "f72-held-double-source-start-missing");
  assert.notEqual(end, -1, "f72-held-double-source-end-missing");
  assert.ok(start < end, "f72-held-double-source-order-invalid");
  return heldRuntime.slice(start + startMarker.length, end);
}

function observeProtocol(
  child: ChildProcessWithoutNullStreams,
): ProtocolObservation {
  const observation: ProtocolObservation = { messages: [], malformed: false };
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as unknown;
        if (typeof message !== "object" || message === null) {
          observation.malformed = true;
          continue;
        }
        observation.messages.push(message as Record<string, unknown>);
      } catch {
        observation.malformed = true;
      }
    }
  });
  child.stdout.on("error", () => {
    observation.malformed = true;
  });
  child.stdin.on("error", () => {
    observation.malformed = true;
  });
  child.on("error", () => {
    observation.malformed = true;
  });
  child.stderr.resume();
  return observation;
}

function writeProtocol(
  child: ChildProcessWithoutNullStreams,
  messages: readonly Record<string, unknown>[],
): void {
  if (child.stdin.destroyed) throw new Error("f72-held-double-stdin-closed");
  child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
}

function hasResponses(
  messages: readonly Record<string, unknown>[],
  expectedIds: readonly number[],
): boolean {
  return expectedIds.every((id) =>
    messages.some((message) => message.id === id),
  );
}

async function waitForProtocol(
  observation: ProtocolObservation,
  predicate: (messages: readonly Record<string, unknown>[]) => boolean,
  // Hosted runners start two cold node children on slow disks; the handshake
  // itself is semantic-free, so the tolerance is generous rather than tight.
  timeoutMilliseconds = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (observation.malformed) {
      throw new Error("f72-held-double-protocol-invalid");
    }
    if (predicate(observation.messages)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("f72-held-double-protocol-timeout");
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("f72-held-double-exit-timeout");
}

async function readControlJson(
  controlPath: string,
  timeoutMilliseconds = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(controlPath, "utf8")) as unknown;
      if (typeof value !== "object" || value === null) break;
      return value as Record<string, unknown>;
    } catch (error) {
      if (nativeErrorCode(error) !== "ENOENT") break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("f72-held-double-control-invalid");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (nativeErrorCode(error) === "ENOENT") return false;
    throw new Error("f72-held-double-control-read-failed");
  }
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function stopOwnedTestChild(
  child: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  if (!child.stdin.destroyed) child.stdin.end();
  try {
    await waitForChildExit(child, 250);
    return;
  } catch {
    // Continue to the captured ChildProcess-only termination below.
  }
  child.kill();
  try {
    await waitForChildExit(child, 1_000);
  } catch {
    throw new Error("f72-held-double-cleanup-failed");
  }
}

async function removeOwnedTestRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !/^workbench-f72-held-driver-test-[A-Za-z0-9_-]+$/u.test(
      basename(resolvedRoot),
    )
  ) {
    throw new Error("f72-held-double-root-ownership-invalid");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

function sourceSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  assert.ok(start < end, `source markers out of order: ${startMarker}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, markers: readonly string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${marker}`);
    assert.ok(next > cursor, `ordered marker regressed: ${marker}`);
    cursor = next;
  }
}
