import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  expectedJourneyEventKinds,
  LiveUserJourneyRunFailure,
  readUserJourneyEvidenceArtifact,
  runLiveUserJourney,
  runLiveUserJourneyPreflight,
  runTestDoubleUserJourneys,
  sanitizeLiveUserJourneyCliFailure,
  type LiveUserJourneySystemBoundary,
  type UserJourneyEvidenceSeal,
  type UserJourneyObservation,
} from "../e2e/live-user-journey.ts";
import {
  createTemporaryRoot,
  removeTemporaryRoot,
} from "../e2e/live-user-journey/shared.ts";
import { withProcessEnvironment } from "../helpers/process-state.ts";

test("CLI failure reporting admits fixed public codes and never arbitrary Error text", () => {
  const privateSentinel = "private-provider-exception-must-not-escape";
  const arbitrary = sanitizeLiveUserJourneyCliFailure(
    new Error(privateSentinel),
  );
  assert.deepEqual(arbitrary, {
    status: "failed",
    category: "fixed-internal",
  });
  assert.equal(JSON.stringify(arbitrary).includes(privateSentinel), false);

  let assertionFailure: unknown;
  try {
    assert.fail(privateSentinel);
  } catch (error) {
    assertionFailure = error;
  }
  const assertionReport = sanitizeLiveUserJourneyCliFailure(assertionFailure);
  assert.deepEqual(assertionReport, {
    status: "failed",
    category: "assertion-failed",
  });
  assert.equal(JSON.stringify(assertionReport).includes(privateSentinel), false);

  assert.deepEqual(
    sanitizeLiveUserJourneyCliFailure(
      new Error("live-user-journey-evidence-path-required"),
    ),
    {
      status: "failed",
      category: "live-user-journey-evidence-path-required",
    },
  );
});

test("temporary-root safety accepts an aliased parent that resolves to the same physical temp directory", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-parent-alias-"),
  );
  const physicalTemp = join(controlRoot, "physical-temp");
  const aliasTemp = join(controlRoot, "alias-temp");
  try {
    await mkdir(physicalTemp);
    await symlink(physicalTemp, aliasTemp, "junction");
    await withProcessEnvironment(
      { TEMP: aliasTemp, TMP: aliasTemp },
      async () => {
        const root = await createTemporaryRoot();
        try {
          const physicalRoot = await realpath(root);
          assert.notEqual(
            resolve(root).toLocaleLowerCase("en-US"),
            physicalRoot.toLocaleLowerCase("en-US"),
          );
          assert.equal(
            dirname(physicalRoot).toLocaleLowerCase("en-US"),
            (await realpath(physicalTemp)).toLocaleLowerCase("en-US"),
          );
        } finally {
          await removeTemporaryRoot(root);
        }
      },
    );
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("live public seam retains its ledger after close failure and proves exact-child fallback cleanup", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-close-failure-"),
  );
  try {
    const evidencePath = join(controlRoot, "close-failure-evidence.json");
    const routineRoots: string[] = [];
    const child = controlledChildProcess(4207);
    let processReads = 0;
    const privateCloseText = "private-close-failure-must-not-escape";

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath,
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async ({ userDataDirectory }) => ({
            process: () => {
              processReads += 1;
              return child.process;
            },
            close: async () => {
              throw new Error(privateCloseText);
            },
            drive: async () => {
              await writeControlledLiveLedger(userDataDirectory, "codex");
              return controlledLiveTurns("codex");
            },
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.equal(failure.message, "live-user-journey-run-failed");
    assert.deepEqual(
      failure.errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
      ["live-user-journey-graceful-close-failed"],
    );
    assert.equal(JSON.stringify(failure).includes(privateCloseText), false);
    assert.equal(String(failure).includes(privateCloseText), false);
    assert.equal(processReads, 2);
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
    assert.equal(child.process.exitCode, null);
    assert.equal(child.process.signalCode, "SIGTERM");

    assert.equal(routineRoots.length, 1);
    assert.deepEqual(failure.outcome, {
      schema: "live-user-journey-failure-outcome-v1",
      runtime: "codex",
      failureKinds: ["graceful-close"],
      rootDisposition: "retained",
      retainedRoot: routineRoots[0],
      evidencePath: resolve(evidencePath),
      evidenceSeal: {
        path: resolve(evidencePath),
        bytes: 2213,
        sha256: "cd051d4852f7c9032b881805149d39596f3d202d8e7dd944632fe24cf317897e",
      },
      child: {
        capturedPid: 4207,
        state: "exited",
        deathProved: true,
        exitCode: null,
        signalCode: "SIGTERM",
      },
    });
    await access(routineRoots[0]!);
    await access(
      join(
        routineRoots[0]!,
        "user-data",
        "workbench-project-host",
        "project-ledgers",
        "journey.sqlite",
      ),
    );
    const retained = await readUserJourneyEvidenceArtifact(evidencePath);
    assert.equal(retained.source, "production-renderer-live");
    assert.deepEqual(
      retained.observations.map((observation) => observation.name),
      ["codex-start-english", "codex-continue-chinese"],
    );
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("live public seam aggregates primary, graceful-close, and death-proof failures without killing an impostor", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-aggregate-failure-"),
  );
  try {
    const routineRoots: string[] = [];
    const capturedChild = controlledChildProcess(4208);
    const impostorChild = controlledChildProcess(4208);
    let processReads = 0;
    let closeAttempts = 0;
    const privateTexts = [
      "private-primary-failure-must-not-escape",
      "private-close-failure-must-not-escape",
    ] as const;

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath: join(controlRoot, "must-not-exist.json"),
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async () => ({
            process: () => {
              processReads += 1;
              return processReads === 1
                ? capturedChild.process
                : impostorChild.process;
            },
            close: async () => {
              closeAttempts += 1;
              throw new Error(privateTexts[1]);
            },
            drive: async () => {
              throw new Error(privateTexts[0]);
            },
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, [
      "primary-journey",
      "graceful-close",
      "fallback-death-proof",
    ]);
    assert.deepEqual(
      failure.errors.map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
      [
        "live-user-journey-primary-journey-failed",
        "live-user-journey-graceful-close-failed",
        "live-user-journey-fallback-death-proof-failed",
      ],
    );
    const publicFailure = `${String(failure)}\n${JSON.stringify(failure)}`;
    for (const privateText of privateTexts) {
      assert.equal(publicFailure.includes(privateText), false);
    }
    assert.equal(processReads, 2);
    assert.equal(closeAttempts, 1);
    assert.deepEqual(capturedChild.killSignals, []);
    assert.deepEqual(impostorChild.killSignals, []);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
    await assertPathMissing(join(controlRoot, "must-not-exist.json"));
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("throwing child state accessors become a fixed death-proof failure and retain the root", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-hostile-child-"),
  );
  const routineRoots: string[] = [];
  try {
    const privateAccessorText = "private-child-accessor-must-not-escape";
    let killAttempts = 0;
    const hostileChild = {
      pid: 4214,
      get exitCode(): number | null {
        throw new Error(privateAccessorText);
      },
      get signalCode(): NodeJS.Signals | null {
        throw new Error(privateAccessorText);
      },
      kill(): boolean {
        killAttempts += 1;
        return true;
      },
      once(): unknown {
        throw new Error(privateAccessorText);
      },
      off(): unknown {
        throw new Error(privateAccessorText);
      },
    };

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath: join(controlRoot, "must-not-exist.json"),
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async () => ({
            process: () => hostileChild,
            close: async () => {
              throw new Error("private-close-failure-must-not-escape");
            },
            drive: async () => controlledLiveTurns("codex"),
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, [
      "graceful-close",
      "fallback-death-proof",
    ]);
    assert.equal(String(failure).includes(privateAccessorText), false);
    assert.equal(killAttempts, 0);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
  } finally {
    if (routineRoots[0] !== undefined && existsSync(routineRoots[0])) {
      await rm(routineRoots[0], { recursive: true, force: false });
    }
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("throwing child off accessor is aggregated as a fixed fallback cleanup failure", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-hostile-off-"),
  );
  const routineRoots: string[] = [];
  try {
    const privateAccessorText = "private-child-off-must-not-escape";
    let signalCode: NodeJS.Signals | null = null;
    let exitListener:
      | ((
          exitCode: number | null,
          nextSignalCode: NodeJS.Signals | null,
        ) => void)
      | undefined;
    const hostileChild = {
      pid: 4218,
      exitCode: null,
      get signalCode(): NodeJS.Signals | null {
        return signalCode;
      },
      kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
        signalCode = typeof signal === "string" ? signal : "SIGTERM";
        exitListener?.(null, signalCode);
        return true;
      },
      once(
        _event: "exit",
        listener: (
          exitCode: number | null,
          nextSignalCode: NodeJS.Signals | null,
        ) => void,
      ): unknown {
        exitListener = listener;
        return hostileChild;
      },
      get off(): never {
        throw new Error(privateAccessorText);
      },
    };

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath: join(controlRoot, "hostile-off-evidence.json"),
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async ({ userDataDirectory }) => ({
            process: () => hostileChild,
            close: async () => {
              throw new Error("private-close-failure-must-not-escape");
            },
            drive: async () => {
              await writeControlledLiveLedger(userDataDirectory, "codex");
              return controlledLiveTurns("codex");
            },
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, [
      "graceful-close",
      "fallback-death-proof",
    ]);
    assert.equal(JSON.stringify(failure).includes(privateAccessorText), false);
    assert.equal(failure.outcome.child.deathProved, true);
    assert.equal(failure.outcome.child.signalCode, "SIGTERM");
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
  } finally {
    await removeControlledRetainedRoots(routineRoots);
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("preflight retains its root when exact child death cannot be proved", async () => {
  const capturedChild = controlledChildProcess(4215);
  const impostorChild = controlledChildProcess(4215);
  const routineRoots: string[] = [];
  let processReads = 0;
  try {
    let failure: unknown;
    try {
      await runLiveUserJourneyPreflight("codex", {
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async () => ({
            process: () => {
              processReads += 1;
              return processReads === 1
                ? capturedChild.process
                : impostorChild.process;
            },
            close: async () => {
              throw new Error("private-preflight-close-must-not-escape");
            },
            drive: async () => [],
            preflight: async () => ({
              modelLabel: "gpt-5.6-sol",
              effortLabel: "ultra",
            }),
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, [
      "graceful-close",
      "fallback-death-proof",
    ]);
    assert.equal(
      String(failure).includes("private-preflight-close-must-not-escape"),
      false,
    );
    assert.equal(processReads, 2);
    assert.deepEqual(capturedChild.killSignals, []);
    assert.deepEqual(impostorChild.killSignals, []);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
  } finally {
    if (routineRoots[0] !== undefined && existsSync(routineRoots[0])) {
      await rm(routineRoots[0], { recursive: true, force: false });
    }
  }
});

test("preflight retains its root for primary and guarded-cleanup failures", async () => {
  for (const failureStage of ["primary", "cleanup"] as const) {
    const child = controlledChildProcess(
      failureStage === "primary" ? 4216 : 4217,
    );
    const routineRoots: string[] = [];
    let cleanupCalls = 0;
    const privateText = `private-preflight-${failureStage}-must-not-escape`;
    try {
      let failure: unknown;
      try {
        await runLiveUserJourneyPreflight("codex", {
          onTemporaryRootCreated: (root) => routineRoots.push(root),
          liveSystemBoundary: {
            launch: async () => ({
              process: () => child.process,
              close: async () => child.completeExit(0, null),
              drive: async () => [],
              preflight: async () => {
                if (failureStage === "primary") {
                  throw new Error(privateText);
                }
                return {
                  modelLabel: "gpt-5.6-sol",
                  effortLabel: "ultra",
                };
              },
            }),
            deleteGuardedTemporaryRoot: async () => {
              cleanupCalls += 1;
              throw new Error(privateText);
            },
          },
        });
      } catch (error) {
        failure = error;
      }

      assert.ok(failure instanceof LiveUserJourneyRunFailure);
      assert.deepEqual(
        failure.failureKinds,
        failureStage === "primary" ? ["primary-journey"] : ["root-cleanup"],
      );
      assert.equal(String(failure).includes(privateText), false);
      assert.equal(cleanupCalls, failureStage === "primary" ? 0 : 1);
      assert.deepEqual(child.killSignals, []);
      assert.equal(routineRoots.length, 1);
      await access(routineRoots[0]!);
    } finally {
      if (routineRoots[0] !== undefined && existsSync(routineRoots[0])) {
        await rm(routineRoots[0], { recursive: true, force: false });
      }
    }
  }
});

test("live public seam retains a sealed ledger and root when guarded cleanup fails", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-cleanup-failure-"),
  );
  try {
    const evidencePath = join(controlRoot, "cleanup-failure-evidence.json");
    const routineRoots: string[] = [];
    const child = controlledChildProcess(4209);
    const privateCleanupText = "private-cleanup-failure-must-not-escape";

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath,
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async ({ userDataDirectory }) => ({
            process: () => child.process,
            close: async () => child.completeExit(0, null),
            drive: async () => {
              await writeControlledLiveLedger(userDataDirectory, "codex");
              return controlledLiveTurns("codex");
            },
          }),
          deleteGuardedTemporaryRoot: async () => {
            throw new Error(privateCleanupText);
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, ["root-cleanup"]);
    assert.equal(String(failure).includes(privateCleanupText), false);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
    await access(
      join(
        routineRoots[0]!,
        "user-data",
        "workbench-project-host",
        "project-ledgers",
        "journey.sqlite",
      ),
    );
    const retained = await readUserJourneyEvidenceArtifact(evidencePath);
    assert.equal(retained.durableRows.length, 2);
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("successful live public seam seals and reopens evidence before deleting the guarded root", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-success-"),
  );
  try {
    const evidencePath = join(controlRoot, "successful-live-evidence.json");
    const routineRoots: string[] = [];
    const lifecycle: string[] = [];
    const seals: UserJourneyEvidenceSeal[] = [];
    const child = controlledChildProcess(4210);
    const observations = await runLiveUserJourney("codex", () => undefined, {
      evidencePath,
      onTemporaryRootCreated: (root) => routineRoots.push(root),
      onEvidenceSealed: (seal) => {
        lifecycle.push("sealed-and-reopened");
        assert.equal(routineRoots.length, 1);
        assert.equal(existsSync(routineRoots[0]!), true);
        seals.push(seal);
      },
      liveSystemBoundary: successfulControlledLiveBoundary(
        "codex",
        child,
        lifecycle,
      ),
    });

    assert.deepEqual(
      observations.map((observation) => observation.name),
      ["codex-start-english", "codex-continue-chinese"],
    );
    assert.deepEqual(lifecycle, [
      "launch",
      "capture-child",
      "drive",
      "graceful-close",
      "sealed-and-reopened",
    ]);
    assert.deepEqual(child.killSignals, []);
    assert.equal(child.process.exitCode, 0);
    assert.equal(child.process.signalCode, null);
    assert.equal(routineRoots.length, 1);
    await assertPathMissing(routineRoots[0]!);

    const evidenceBytes = await readFile(evidencePath);
    assert.deepEqual(seals, [
      {
        path: resolve(evidencePath),
        bytes: evidenceBytes.byteLength,
        sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
      },
    ]);
    await assertSanitizedLiveArtifact(evidencePath, [
      "codex-private-target",
      "Reply exactly:",
      "target_session_id",
      "targetSessionId",
      "replyText",
    ]);
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("post-close final-write callback failure retains both sanitized evidence and the exact ledger", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-export-failure-"),
  );
  try {
    const evidencePath = join(controlRoot, "post-write-evidence.json");
    const routineRoots: string[] = [];
    const lifecycle: string[] = [];
    const child = controlledChildProcess(4211);
    const privateExportText = "private-export-callback-must-not-escape";
    let sealObserved = false;

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath,
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        onEvidenceSealed: () => {
          lifecycle.push("sealed-and-reopened");
          sealObserved = true;
          throw new Error(privateExportText);
        },
        liveSystemBoundary: successfulControlledLiveBoundary(
          "codex",
          child,
          lifecycle,
        ),
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, ["evidence-export"]);
    assert.equal(String(failure).includes(privateExportText), false);
    assert.equal(sealObserved, true);
    assert.deepEqual(lifecycle, [
      "launch",
      "capture-child",
      "drive",
      "graceful-close",
      "sealed-and-reopened",
    ]);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
    await access(
      join(
        routineRoots[0]!,
        "user-data",
        "workbench-project-host",
        "project-ledgers",
        "journey.sqlite",
      ),
    );
    await assertSanitizedLiveArtifact(evidencePath, [
      privateExportText,
      "codex-private-target",
      "Reply exactly:",
      "target_session_id",
      "targetSessionId",
      "replyText",
    ]);
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("post-close malformed evidence fails closed without modifying it and retains the ledger root", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-malformed-evidence-"),
  );
  try {
    const evidencePath = join(controlRoot, "malformed-evidence.json");
    const malformedBytes = `${JSON.stringify({
      schema: "live-user-journey-evidence-v1",
      source: "production-renderer-live",
      observations: [],
      durableRows: [],
      rawProviderContent: "private-malformed-content",
    })}\n`;
    await writeFile(evidencePath, malformedBytes, "utf8");
    const routineRoots: string[] = [];
    const lifecycle: string[] = [];
    const child = controlledChildProcess(4212);

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath,
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: successfulControlledLiveBoundary(
          "codex",
          child,
          lifecycle,
        ),
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, ["evidence-export"]);
    assert.equal(String(failure).includes("private-malformed-content"), false);
    assert.deepEqual(lifecycle, [
      "launch",
      "capture-child",
      "drive",
      "graceful-close",
    ]);
    assert.equal(await readFile(evidencePath, "utf8"), malformedBytes);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("close and ledger failures remain distinct after exact-child death is proved", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-ledger-failure-"),
  );
  try {
    const routineRoots: string[] = [];
    const child = controlledChildProcess(4213);
    const privateTexts = [
      "private-close-timeout-must-not-escape",
      "private-missing-ledger-path-must-not-escape",
    ] as const;

    let failure: unknown;
    try {
      await runLiveUserJourney("codex", () => undefined, {
        evidencePath: join(controlRoot, "must-not-exist.json"),
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        liveSystemBoundary: {
          launch: async () => ({
            process: () => child.process,
            close: async () => {
              throw new Error(privateTexts[0]);
            },
            drive: async () => controlledLiveTurns("codex"),
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof LiveUserJourneyRunFailure);
    assert.deepEqual(failure.failureKinds, [
      "graceful-close",
      "ledger-read",
    ]);
    for (const privateText of privateTexts) {
      assert.equal(String(failure).includes(privateText), false);
    }
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
    assert.equal(routineRoots.length, 1);
    await access(routineRoots[0]!);
    await assertPathMissing(join(controlRoot, "must-not-exist.json"));
    await removeControlledRetainedRoots(routineRoots);
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

test("test-double journeys independently prove both runtimes start and continue across English and Chinese", async () => {
  const controlRoot = await mkdtemp(
    join(tmpdir(), "uaw-live-user-journey-harness-"),
  );
  try {
    await assert.rejects(
      runLiveUserJourney("codex", () => undefined),
      /live-user-journey-evidence-path-required/u,
    );
    const evidencePath = join(controlRoot, "successful-evidence.json");
    const emitted: UserJourneyObservation[] = [];
    const routineRoots: string[] = [];
    const seals: UserJourneyEvidenceSeal[] = [];
    const observations = await runTestDoubleUserJourneys(
      (observation) => emitted.push(observation),
      {
        evidencePath,
        onTemporaryRootCreated: (root) => routineRoots.push(root),
        onEvidenceSealed: (seal) => seals.push(seal),
      },
    );

    assert.deepEqual(emitted, observations);
    assert.deepEqual(
      observations.map((observation) => ({
        name: observation.name,
        source: observation.source,
        runtime: observation.runtime,
        runtimeObserved: observation.runtimeObserved,
        language: observation.language,
        prompt: observation.prompt,
        commandKind: observation.commandKind,
        durableCommandKind: observation.durableCommandKind,
        accepted: observation.accepted,
        eventCount: observation.eventCount,
        eventKinds: observation.eventKinds,
        terminalState: observation.terminalState,
        replySummary: observation.replySummary,
        replyMatchesExpected: observation.replyMatchesExpected,
        agentSessionCount: observation.agentSessionCount,
        sameTargetSession: observation.sameTargetSession,
        sameAgentSessionRow: observation.sameAgentSessionRow,
      })),
      [
      {
        name: "codex-start-english",
        source: "test-double",
        runtime: "codex",
        runtimeObserved: "codex",
        language: "english",
        prompt: "Reply exactly: UAW_CODEX_START_OK",
        commandKind: "start",
        durableCommandKind: "start",
        accepted: true,
        eventCount: 6,
        eventKinds: expectedJourneyEventKinds,
        terminalState: "completed",
        replySummary: "UAW_CODEX_START_OK",
        replyMatchesExpected: true,
        agentSessionCount: 1,
        sameTargetSession: true,
        sameAgentSessionRow: true,
      },
      {
        name: "codex-continue-chinese",
        source: "test-double",
        runtime: "codex",
        runtimeObserved: "codex",
        language: "chinese",
        prompt: "只回复：UAW_CODEX_CONTINUE_OK",
        commandKind: "continue",
        durableCommandKind: "continue",
        accepted: true,
        eventCount: 6,
        eventKinds: expectedJourneyEventKinds,
        terminalState: "completed",
        replySummary: "UAW_CODEX_CONTINUE_OK",
        replyMatchesExpected: true,
        agentSessionCount: 1,
        sameTargetSession: true,
        sameAgentSessionRow: true,
      },
      {
        name: "claude-start-english",
        source: "test-double",
        runtime: "claude",
        runtimeObserved: "claude",
        language: "english",
        prompt: "Reply exactly: UAW_CLAUDE_EN_OK",
        commandKind: "start",
        durableCommandKind: "start",
        accepted: true,
        eventCount: 6,
        eventKinds: expectedJourneyEventKinds,
        terminalState: "completed",
        replySummary: "UAW_CLAUDE_EN_OK",
        replyMatchesExpected: true,
        agentSessionCount: 2,
        sameTargetSession: true,
        sameAgentSessionRow: true,
      },
      {
        name: "claude-continue-chinese",
        source: "test-double",
        runtime: "claude",
        runtimeObserved: "claude",
        language: "chinese",
        prompt: "只回复：UAW_CLAUDE_ZH_OK",
        commandKind: "continue",
        durableCommandKind: "continue",
        accepted: true,
        eventCount: 6,
        eventKinds: expectedJourneyEventKinds,
        terminalState: "completed",
        replySummary: "UAW_CLAUDE_ZH_OK",
        replyMatchesExpected: true,
        agentSessionCount: 2,
        sameTargetSession: true,
        sameAgentSessionRow: true,
      },
      ],
    );

    assert.equal(routineRoots.length, 1);
    await assertPathMissing(routineRoots[0]!);

    const evidenceBytes = await readFile(evidencePath);
    assert.deepEqual(seals, [
      {
        path: resolve(evidencePath),
        bytes: evidenceBytes.byteLength,
        sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
      },
    ]);
    const evidence = await readUserJourneyEvidenceArtifact(evidencePath);
    assert.equal(evidence.schema, "live-user-journey-evidence-v1");
    assert.equal(evidence.source, "test-double");
    assert.deepEqual(
      evidence.observations.map((observation) => ({
        name: observation.name,
        source: observation.source,
        runtime: observation.runtime,
        runtimeObserved: observation.runtimeObserved,
        language: observation.language,
        commandKind: observation.commandKind,
        durableCommandKind: observation.durableCommandKind,
        accepted: observation.accepted,
        eventCount: observation.eventCount,
        eventKinds: observation.eventKinds,
        terminalState: observation.terminalState,
        replySummary: observation.replySummary,
        replyMatchesExpected: observation.replyMatchesExpected,
        agentSessionCount: observation.agentSessionCount,
        sameTargetSession: observation.sameTargetSession,
        sameAgentSessionRow: observation.sameAgentSessionRow,
      })),
      observations.map(({ prompt: _prompt, modelLabel: _model, effortLabel: _effort, schema: _schema, ...observation }) =>
        observation,
      ),
    );
    assert.deepEqual(
      evidence.durableRows.map(({ acceptedCursor: _cursor, ...row }) => row),
      [
      {
        schema: "live-user-journey-durable-row-v1",
        name: "codex-start-english",
        runtime: "codex",
        sequence: 1,
        commandKind: "start",
        status: "completed",
        targetSession: "codex-session-1",
      },
      {
        schema: "live-user-journey-durable-row-v1",
        name: "codex-continue-chinese",
        runtime: "codex",
        sequence: 2,
        commandKind: "continue",
        status: "completed",
        targetSession: "codex-session-1",
      },
      {
        schema: "live-user-journey-durable-row-v1",
        name: "claude-start-english",
        runtime: "claude",
        sequence: 1,
        commandKind: "start",
        status: "completed",
        targetSession: "claude-session-1",
      },
      {
        schema: "live-user-journey-durable-row-v1",
        name: "claude-continue-chinese",
        runtime: "claude",
        sequence: 2,
        commandKind: "continue",
        status: "completed",
        targetSession: "claude-session-1",
      },
      ],
    );
    assert.deepEqual(
      evidence.durableRows.map((row) => Number.isSafeInteger(row.acceptedCursor)),
      [true, true, true, true],
    );
    assert.ok(
      evidence.durableRows[0]!.acceptedCursor <
        evidence.durableRows[1]!.acceptedCursor,
    );
    assert.ok(
      evidence.durableRows[2]!.acceptedCursor <
        evidence.durableRows[3]!.acceptedCursor,
    );

    const serializedEvidence = evidenceBytes.toString("utf8");
    for (const forbidden of [
      "Reply exactly:",
      "只回复：",
      "target_session_id",
      "targetSessionId",
      "replyText",
      "codex-test-double-capability",
      "claude-test-double-capability",
    ]) {
      assert.equal(
        serializedEvidence.includes(forbidden),
        false,
        `sanitized evidence must exclude ${forbidden}`,
      );
    }

    await assertTwoRunEvidenceAggregation(controlRoot);
    await assertCleanupAcrossFailureAndException(controlRoot);
    await assertExactEvidenceSchemaFailsClosed(
      controlRoot,
      serializedEvidence,
    );
  } finally {
    await rm(controlRoot, { recursive: true, force: false });
  }
});

async function assertTwoRunEvidenceAggregation(controlRoot: string): Promise<void> {
  const evidencePath = join(controlRoot, "aggregated-evidence.json");
  const seals: UserJourneyEvidenceSeal[] = [];
  for (const [index, runtime] of (["codex", "claude"] as const).entries()) {
    const routineRoots: string[] = [];
    await runTestDoubleUserJourneys(() => undefined, {
      evidencePath,
      runtimes: [runtime],
      onTemporaryRootCreated: (root) => routineRoots.push(root),
      onEvidenceSealed: (seal) => seals.push(seal),
    });
    assert.equal(routineRoots.length, 1);
    await assertPathMissing(routineRoots[0]!);
    const retained = await readUserJourneyEvidenceArtifact(evidencePath);
    assert.equal(retained.observations.length, (index + 1) * 2);
    assert.equal(retained.durableRows.length, (index + 1) * 2);
  }
  assert.deepEqual(
    (await readUserJourneyEvidenceArtifact(evidencePath)).observations.map(
      (observation) => observation.name,
    ),
    [
      "codex-start-english",
      "codex-continue-chinese",
      "claude-start-english",
      "claude-continue-chinese",
    ],
  );
  const finalBytes = await readFile(evidencePath);
  assert.deepEqual(seals.at(-1), {
    path: resolve(evidencePath),
    bytes: finalBytes.byteLength,
    sha256: createHash("sha256").update(finalBytes).digest("hex"),
  });
}

async function assertCleanupAcrossFailureAndException(
  controlRoot: string,
): Promise<void> {
  for (const kind of ["assertion-failure", "exception"] as const) {
    const evidencePath = join(controlRoot, `${kind}-evidence.json`);
    const routineRoots: string[] = [];
    await assert.rejects(
      runTestDoubleUserJourneys(
        () => undefined,
        {
          evidencePath,
          onTemporaryRootCreated: (root) => routineRoots.push(root),
          onEvidenceSealed: () => {
            if (kind === "assertion-failure") {
              assert.fail("controlled-post-write-assertion-failure");
            }
            throw new Error("controlled-post-write-exception");
          },
        },
      ),
      kind === "assertion-failure"
        ? /controlled-post-write-assertion-failure/u
        : /controlled-post-write-exception/u,
    );
    assert.equal(routineRoots.length, 1);
    await assertPathMissing(routineRoots[0]!);
    const retained = await readUserJourneyEvidenceArtifact(evidencePath);
    assert.equal(retained.observations.length, 4);
    assert.equal(retained.durableRows.length, 4);
  }
}

async function assertExactEvidenceSchemaFailsClosed(
  controlRoot: string,
  validEvidence: string,
): Promise<void> {
  const malformedVariants: Array<
    readonly [
      string,
      (artifact: Record<string, unknown>) => void,
    ]
  > = [
    ["root-extra", (artifact) => {
      artifact.rawProviderContent = "must-not-be-admitted";
    }],
    ["observation-extra", (artifact) => {
      firstRecord(artifact, "observations").replyText = "must-not-be-admitted";
    }],
    ["durable-row-extra", (artifact) => {
      firstRecord(artifact, "durableRows").targetSessionId =
        "must-not-be-admitted";
    }],
    ["raw-reply-value", (artifact) => {
      firstRecord(artifact, "observations").replySummary =
        "must-not-be-admitted";
    }],
    ["raw-target-value", (artifact) => {
      firstRecord(artifact, "durableRows").targetSession =
        "must-not-be-admitted";
    }],
  ];
  let malformedPath = "";
  let malformedBytes = "";
  for (const [name, mutate] of malformedVariants) {
    const malformed = JSON.parse(validEvidence) as Record<string, unknown>;
    mutate(malformed);
    const serialized = `${JSON.stringify(malformed, null, 2)}\n`;
    const path = join(controlRoot, `${name}-evidence.json`);
    await writeFile(path, serialized, "utf8");
    await assert.rejects(
      readUserJourneyEvidenceArtifact(path),
      /journey-evidence-schema-invalid/u,
    );
    if (name === "root-extra") {
      malformedPath = path;
      malformedBytes = serialized;
    }
  }

  const routineRoots: string[] = [];
  await assert.rejects(
    runTestDoubleUserJourneys(() => undefined, {
      evidencePath: malformedPath,
      onTemporaryRootCreated: (root) => routineRoots.push(root),
    }),
    /journey-evidence-schema-invalid/u,
  );
  assert.equal(routineRoots.length, 1);
  await assertPathMissing(routineRoots[0]!);
  assert.equal(await readFile(malformedPath, "utf8"), malformedBytes);
}

function firstRecord(
  artifact: Record<string, unknown>,
  key: "observations" | "durableRows",
): Record<string, unknown> {
  const values = artifact[key];
  assert.ok(Array.isArray(values));
  const value = values[0];
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function controlledChildProcess(pid: number): Readonly<{
  process: Readonly<{
    pid: number;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    once(
      event: "exit",
      listener: (
        exitCode: number | null,
        signalCode: NodeJS.Signals | null,
      ) => void,
    ): unknown;
    off(
      event: "exit",
      listener: (
        exitCode: number | null,
        signalCode: NodeJS.Signals | null,
      ) => void,
    ): unknown;
  }>;
  killSignals: readonly (NodeJS.Signals | number)[];
  completeExit(
    nextExitCode: number | null,
    nextSignalCode: NodeJS.Signals | null,
  ): void;
}> {
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const exitListeners = new Set<
    (exitCode: number | null, signalCode: NodeJS.Signals | null) => void
  >();
  const killSignals: Array<NodeJS.Signals | number> = [];
  const completeExit = (
    nextExitCode: number | null,
    nextSignalCode: NodeJS.Signals | null,
  ): void => {
    exitCode = nextExitCode;
    signalCode = nextSignalCode;
    for (const listener of exitListeners) listener(exitCode, signalCode);
    exitListeners.clear();
  };
  const process = {
    pid,
    get exitCode(): number | null {
      return exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return signalCode;
    },
    kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
      killSignals.push(signal);
      completeExit(null, typeof signal === "string" ? signal : "SIGTERM");
      return true;
    },
    once(
      event: "exit",
      listener: (
        exitCode: number | null,
        signalCode: NodeJS.Signals | null,
      ) => void,
    ): unknown {
      assert.equal(event, "exit");
      exitListeners.add(listener);
      return process;
    },
    off(
      event: "exit",
      listener: (
        exitCode: number | null,
        signalCode: NodeJS.Signals | null,
      ) => void,
    ): unknown {
      assert.equal(event, "exit");
      exitListeners.delete(listener);
      return process;
    },
  };
  return Object.freeze({ process, killSignals, completeExit });
}

async function writeControlledLiveLedger(
  userDataDirectory: string,
  runtime: "codex" | "claude",
): Promise<void> {
  const ledgerDirectory = join(
    userDataDirectory,
    "workbench-project-host",
    "project-ledgers",
  );
  await mkdir(ledgerDirectory, { recursive: true });
  const database = new DatabaseSync(join(ledgerDirectory, "journey.sqlite"));
  try {
    database.exec(`
      CREATE TABLE commands (
        command_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted_cursor INTEGER NOT NULL,
        target_session_id TEXT
      )
    `);
    const insert = database.prepare(`
      INSERT INTO commands (
        command_kind,
        status,
        accepted_cursor,
        target_session_id
      ) VALUES (?, ?, ?, ?)
    `);
    insert.run("start", "completed", 1, `${runtime}-private-target`);
    insert.run("continue", "completed", 2, `${runtime}-private-target`);
  } finally {
    database.close();
  }
}

function controlledLiveTurns(runtime: "codex" | "claude") {
  const prefix = runtime === "codex" ? "CODEX" : "CLAUDE";
  return Object.freeze([
    Object.freeze({
      name: `${runtime}-start-english` as const,
      runtimeObserved: runtime,
      accepted: true,
      eventKinds: expectedJourneyEventKinds,
      terminalState: "completed",
      replyText: `UAW_${prefix}_${runtime === "codex" ? "START" : "EN"}_OK`,
      agentSessionCount: 1,
      sessionRowLabel: `${runtime}-controlled-row`,
      modelLabel: runtime === "codex" ? "GPT-5.6-Sol" : "Claude Sonnet 4",
      effortLabel: runtime === "codex" ? "ultra" : "default",
    }),
    Object.freeze({
      name: `${runtime}-continue-chinese` as const,
      runtimeObserved: runtime,
      accepted: true,
      eventKinds: expectedJourneyEventKinds,
      terminalState: "completed",
      replyText: `UAW_${prefix}_${runtime === "codex" ? "CONTINUE" : "ZH"}_OK`,
      agentSessionCount: 1,
      sessionRowLabel: `${runtime}-controlled-row`,
      modelLabel: runtime === "codex" ? "GPT-5.6-Sol" : "Claude Sonnet 4",
      effortLabel: runtime === "codex" ? "ultra" : "default",
    }),
  ]);
}

function successfulControlledLiveBoundary(
  runtime: "codex" | "claude",
  child: ReturnType<typeof controlledChildProcess>,
  lifecycle: string[],
): LiveUserJourneySystemBoundary {
  return Object.freeze({
    launch: async (
      input: Parameters<LiveUserJourneySystemBoundary["launch"]>[0],
    ) => {
      const { runtime: launchedRuntime, userDataDirectory } = input;
      assert.equal(launchedRuntime, runtime);
      lifecycle.push("launch");
      return Object.freeze({
        process: () => {
          lifecycle.push("capture-child");
          return child.process;
        },
        close: async () => {
          lifecycle.push("graceful-close");
          child.completeExit(0, null);
        },
        drive: async () => {
          lifecycle.push("drive");
          await writeControlledLiveLedger(userDataDirectory, runtime);
          return controlledLiveTurns(runtime);
        },
      });
    },
  });
}

async function assertSanitizedLiveArtifact(
  evidencePath: string,
  forbiddenValues: readonly string[],
): Promise<void> {
  const evidence = await readUserJourneyEvidenceArtifact(evidencePath);
  assert.equal(evidence.schema, "live-user-journey-evidence-v1");
  assert.equal(evidence.source, "production-renderer-live");
  assert.equal(evidence.observations.length, 2);
  assert.equal(evidence.durableRows.length, 2);
  const serialized = await readFile(evidencePath, "utf8");
  for (const forbidden of forbiddenValues) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `sanitized live evidence must exclude ${forbidden}`,
    );
  }
}

async function removeControlledRetainedRoots(
  roots: readonly string[],
): Promise<void> {
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    assert.equal(
      resolvedRoot.startsWith(`${resolve(tmpdir())}\\`),
      true,
    );
    assert.match(
      resolvedRoot.slice(resolvedRoot.lastIndexOf("\\") + 1),
      /^uaw-live-user-journey-[A-Za-z0-9_-]+$/u,
    );
    if (existsSync(resolvedRoot)) {
      await rm(resolvedRoot, { recursive: true, force: false });
    }
  }
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(
    access(path),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}
