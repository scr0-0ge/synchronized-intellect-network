/*
 * The Node half of the reduced-motion tone-flip measurement (F225).
 *
 * Reuses the caller's rendered-surface Vite server — the product's own
 * stylesheets in the product's own load order — and drives one hidden Electron
 * renderer whose only job is to answer whether a `data-tone` flip starts a
 * transition when the reader has asked for reduced motion.
 *
 * Deliberately much smaller than `disabled-affordance.ts`: it takes no
 * screenshots and composites nothing. The question is about the cascade and
 * the animation timeline, and a pixel cannot see either — the pixel settles
 * one frame later, which is exactly why the defect this guards was invisible
 * to every capture-based reading the repository already had.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";

import { MEASUREMENT_VIEWPORT, surfaceUrl } from "./measure.ts";

const driverPath = fileURLToPath(
  new URL("./reduced-motion-tone-flip-electron.mjs", import.meta.url),
);
const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;
const DRIVER_TIMEOUT_MS = 120_000;

/** One animation or transition the engine reported as running. */
export type RunningAnimation = Readonly<{
  kind: string;
  property: string | null;
  playState: string;
  currentTime: number | null;
}>;

export type ToneFlipReading = Readonly<{
  classes: string;
  text: string;
  disabled: boolean;
  color: string;
  backgroundColor: string;
  borderTopColor: string;
  opacity: string;
  cursor: string;
}>;

export type ReducedMotionToneFlip = Readonly<{
  url: string;
  viewport: Readonly<{ width: number; height: number }>;
  /** Whether the media feature actually matched, so the guard cannot no-op. */
  reducedMotionMatches: boolean;
  rootDataset: Readonly<Record<string, string>>;
  /** Everything already animating before the flip. Reported, never asserted on. */
  baselineAnimations: readonly RunningAnimation[];
  /** Transitions THIS flip started, by object identity against the baseline. */
  startedByFlip: readonly RunningAnimation[];
  /** Transitions targeting a mounted `.btn.primary` once the flip has landed. */
  onMountedPrimary: readonly RunningAnimation[];
  /** `.btn.primary` as the PRODUCT mounted it, read at the instant of the flip. */
  mounted: readonly ToneFlipReading[];
  /** The same class list, built AFTER the flip, so it can start no transition. */
  probe: ToneFlipReading;
}>;

export type ReducedMotionToneFlipRequest = Readonly<{
  query: string;
  readySelector: string;
  probe: Readonly<{ classes: string; label: string }>;
  viewport?: Readonly<{ width: number; height: number }>;
}>;

/**
 * One attempt, and one retry — the same policy `disabled-affordance.ts`
 * carries, and for the same reason: a Windows Electron child can die in
 * Chromium's teardown after a complete payload, and a crashed process is not
 * one whose word can be taken on anything. Both failures are reported if the
 * retry also fails, so a real breakage cannot hide behind "it passed the
 * second time".
 */
export async function measureReducedMotionToneFlip(
  server: ViteDevServer,
  request: ReducedMotionToneFlipRequest,
): Promise<ReducedMotionToneFlip> {
  try {
    return await attemptToneFlip(server, request);
  } catch (first) {
    try {
      return await attemptToneFlip(server, request);
    } catch (second) {
      throw new AggregateError(
        [first, second],
        `reduced-motion tone-flip measurement of ${request.query} failed twice`,
      );
    }
  }
}

async function attemptToneFlip(
  server: ViteDevServer,
  request: ReducedMotionToneFlipRequest,
): Promise<ReducedMotionToneFlip> {
  const scratch = await mkdtemp(join(tmpdir(), "uaw-tone-flip-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const jobPath = join(scratch, "job.json");
    await writeFile(
      jobPath,
      JSON.stringify({
        url: surfaceUrl(server, request.query),
        viewport: request.viewport ?? MEASUREMENT_VIEWPORT,
        readySelector: request.readySelector,
        probe: request.probe,
      }),
      "utf8",
    );

    child = spawn(
      electronBinary,
      [driverPath, `--user-data-dir=${join(scratch, "user-data")}`],
      {
        windowsHide: true,
        env: {
          ...process.env,
          UAW_REDUCED_MOTION_JOB: jobPath,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        },
      },
    );

    const { code, stdout, stderr } = await collectDriver(child);
    const success = readTaggedLine(stdout, "UAW_REDUCED_MOTION ");
    if (code === 0 && success !== null) return success as ReducedMotionToneFlip;

    const failure = readTaggedLine(stdout, "UAW_REDUCED_MOTION_FAILURE ");
    const detail =
      failure === null
        ? `${stdout}\n${stderr}`.trim().slice(0, 2_000)
        : JSON.stringify(failure);
    throw new Error(`reduced-motion tone-flip measurement failed (exit ${code}): ${detail}`);
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

function collectDriver(child: ChildProcessWithoutNullStreams): Promise<
  Readonly<{ code: number; stdout: string; stderr: string }>
> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `reduced-motion tone-flip driver produced no result within ${DRIVER_TIMEOUT_MS} ms:` +
            ` ${stderr.trim().slice(-800)}`,
        ),
      );
    }, DRIVER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: exitCode ?? 1, stdout, stderr });
    });
  });
}

function readTaggedLine(stdout: string, tag: string): unknown {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith(tag)) return JSON.parse(line.slice(tag.length));
  }
  return null;
}
