import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { measureSurface, startSurfaceServer } from "./rendered-surface/measure.ts";
import { PHOSPHOR_SURFACES } from "./rendered-surface/surfaces.ts";

test(
  "a stalled startup stage reports and terminates its captured child and removes scratch state",
  { timeout: 30_000 },
  async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "uaw-measure-lifecycle-test-"));
    const previous = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
      stallStage: process.env.UAW_MEASURE_TEST_STALL_STAGE,
      inactivityTimeout: process.env.UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS,
    };
    let server: Awaited<ReturnType<typeof startSurfaceServer>> | undefined;
    let measuredChildPid: number | undefined;
    let scratchEntriesBeforeMeasurement: readonly string[] = [];

    try {
      process.env.TEMP = scratchRoot;
      process.env.TMP = scratchRoot;
      process.env.TMPDIR = scratchRoot;
      process.env.UAW_MEASURE_TEST_STALL_STAGE = "Electron app readiness";
      process.env.UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS = "5000";
      server = await startSurfaceServer();
      scratchEntriesBeforeMeasurement = (await readdir(scratchRoot)).sort();
      const request = PHOSPHOR_SURFACES.find(
        (candidate) => candidate.surfaceId === "phosphor-tier-a-light-normal-green",
      );
      assert.ok(request, "the lifecycle probe surface is missing");

      await assert.rejects(measureSurface(server, request), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /phosphor-tier-a-light-normal-green timed out after 5000 ms without stage progress/u,
        );
        assert.match(error.message, /while waiting for Electron app readiness/u);
        const pidMatch = /\(pid (\d+)\)/u.exec(error.message);
        assert.ok(pidMatch, `timeout did not identify the captured child: ${error.message}`);
        measuredChildPid = Number(pidMatch[1]);
        return true;
      });

      assert.ok(measuredChildPid !== undefined);
      assert.equal(processExists(measuredChildPid), false, `pid ${measuredChildPid} survived cleanup`);
      assert.deepEqual(
        (await readdir(scratchRoot)).sort(),
        scratchEntriesBeforeMeasurement,
        "rendered-surface scratch state survived the failed measurement",
      );
    } finally {
      try {
        if (server !== undefined) await server.close();
      } finally {
        restoreEnvironment("TEMP", previous.TEMP);
        restoreEnvironment("TMP", previous.TMP);
        restoreEnvironment("TMPDIR", previous.TMPDIR);
        restoreEnvironment("UAW_MEASURE_TEST_STALL_STAGE", previous.stallStage);
        restoreEnvironment(
          "UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS",
          previous.inactivityTimeout,
        );
        await rm(scratchRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  },
);

test(
  "a stalled compositor stage fails inside its driver bound and cleans the hidden window state",
  { timeout: 30_000 },
  async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), "uaw-measure-lifecycle-test-"));
    const previous = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
      stallStage: process.env.UAW_MEASURE_TEST_STALL_STAGE,
      inactivityTimeout: process.env.UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS,
    };
    let server: Awaited<ReturnType<typeof startSurfaceServer>> | undefined;
    let scratchEntriesBeforeMeasurement: readonly string[] = [];

    try {
      process.env.TEMP = scratchRoot;
      process.env.TMP = scratchRoot;
      process.env.TMPDIR = scratchRoot;
      process.env.UAW_MEASURE_TEST_STALL_STAGE = "final compositor settle";
      process.env.UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS = "20000";
      server = await startSurfaceServer();
      scratchEntriesBeforeMeasurement = (await readdir(scratchRoot)).sort();
      const request = PHOSPHOR_SURFACES.find(
        (candidate) => candidate.surfaceId === "phosphor-tier-a-light-normal-green",
      );
      assert.ok(request, "the lifecycle probe surface is missing");

      await assert.rejects(measureSurface(server, request), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /phosphor-tier-a-light-normal-green failed \(exit 1\)/u,
        );
        assert.match(
          error.message,
          /timed out after 10000 ms while waiting for final compositor settle/u,
        );
        return true;
      });
      assert.deepEqual(
        (await readdir(scratchRoot)).sort(),
        scratchEntriesBeforeMeasurement,
        "hidden-window measurement scratch state survived the failed compositor stage",
      );
    } finally {
      try {
        if (server !== undefined) await server.close();
      } finally {
        restoreEnvironment("TEMP", previous.TEMP);
        restoreEnvironment("TMP", previous.TMP);
        restoreEnvironment("TMPDIR", previous.TMPDIR);
        restoreEnvironment("UAW_MEASURE_TEST_STALL_STAGE", previous.stallStage);
        restoreEnvironment(
          "UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS",
          previous.inactivityTimeout,
        );
        await rm(scratchRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  },
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
