/*
 * The Node half of the disabled-affordance measurement (F215).
 *
 * Reuses the rendered-surface Vite server — the product's own stylesheets in
 * the product's own load order — and drives one hidden Electron renderer that
 * reports, per tone, what the engine resolved and what the compositor painted
 * for an enabled and a disabled control of the same class list.
 *
 * Separate from `measure.ts` on purpose. That harness answers "is every string
 * on this surface legible", and its shape (texts, grids, grounds, seams) is
 * sealed by inventories several guards pin. This one answers a different
 * question — "can a disabled control be told apart from a live one" — and a
 * control in a state the fixture does not currently render has to be built to
 * be asked at all.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";

import {
  MEASUREMENT_VIEWPORT,
  surfaceUrl,
  type Rgba,
} from "./measure.ts";

const driverPath = fileURLToPath(
  new URL("./disabled-affordance-electron.mjs", import.meta.url),
);
const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;
const DRIVER_TIMEOUT_MS = 120_000;

export type AffordanceTone = "dark" | "light";

/** One control the probe builds, named by the class list the product ships. */
export type AffordanceControl = Readonly<{
  id: string;
  classes: string;
  label: string;
  kbd?: string;
  disabled: boolean;
}>;

export type PaintedSample = Rgba & Readonly<{ count?: number }>;

export type PaintedControl = Readonly<{
  /** The button's own fill, read where no glyph can fall. */
  fill: PaintedSample | null;
  fillSpread: number;
  labelGround: PaintedSample | null;
  paintedGlyph: PaintedSample | null;
  inkedPixels: number;
  comparedPixels: number;
  border: readonly (Rgba & Readonly<{ x: number; y: number }>)[];
}>;

export type AffordanceReading = Readonly<{
  id: string;
  classes: string;
  disabled: boolean;
  color: string;
  backgroundColor: string;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  borderTopWidth: string;
  opacity: string;
  cursor: string;
  filter: string;
  fontSizePx: number;
  fontWeight: string;
  viewport: Readonly<{ width: number; height: number }>;
  rect: Readonly<{ top: number; left: number; width: number; height: number }>;
  labelRect: Readonly<{ top: number; left: number; width: number; height: number }>;
  chromeRect: Readonly<{ top: number; left: number; width: number; height: number }>;
  painted: PaintedControl;
}>;

/** A `.btn.primary` the PRODUCT mounted, as opposed to one the probe built. */
export type MountedPrimaryButton = Readonly<{
  classes: string;
  text: string;
  disabled: boolean;
  color: string;
  backgroundColor: string;
  borderTopColor: string;
  opacity: string;
  cursor: string;
}>;

export type AffordanceToneMeasurement = Readonly<{
  tone: AffordanceTone;
  capture: Readonly<{ width: number; height: number }>;
  mountedPrimaryButtons: readonly MountedPrimaryButton[];
  controls: readonly AffordanceReading[];
}>;

export type AffordanceMeasurement = Readonly<{
  url: string;
  viewport: Readonly<{ width: number; height: number }>;
  /** The shipped root state, so a reading can never be attributed to a skin
      the product does not actually run under. */
  rootDataset: Readonly<Record<string, string>>;
  tones: readonly AffordanceToneMeasurement[];
}>;

export type AffordanceRequest = Readonly<{
  query: string;
  readySelector: string;
  tones: readonly AffordanceTone[];
  controls: readonly AffordanceControl[];
  viewport?: Readonly<{ width: number; height: number }>;
}>;

/**
 * One attempt, and one retry.
 *
 * Observed once during this harness's own bring-up: the driver emitted a
 * complete, well-formed `UAW_AFFORDANCE` payload and then exited 0x80000003
 * (STATUS_BREAKPOINT) out of Chromium's teardown. The measurement was finished
 * and correct; the process death happened after it.
 *
 * The result is still discarded rather than accepted, because a driver that
 * dies during shutdown is not a driver whose word can be taken on anything —
 * accepting the payload would be deciding, on no evidence, which half of a
 * crashed process to believe. A second attempt is taken instead, and if that
 * one also fails BOTH failures are reported, so a real breakage can never be
 * hidden behind "it passed the second time".
 */
export async function measureDisabledAffordance(
  server: ViteDevServer,
  request: AffordanceRequest,
): Promise<AffordanceMeasurement> {
  try {
    return await attemptDisabledAffordance(server, request);
  } catch (first) {
    try {
      return await attemptDisabledAffordance(server, request);
    } catch (second) {
      throw new AggregateError(
        [first, second],
        `disabled-affordance measurement of ${request.query} failed twice`,
      );
    }
  }
}

async function attemptDisabledAffordance(
  server: ViteDevServer,
  request: AffordanceRequest,
): Promise<AffordanceMeasurement> {
  const scratch = await mkdtemp(join(tmpdir(), "uaw-affordance-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const jobPath = join(scratch, "job.json");
    await writeFile(
      jobPath,
      JSON.stringify({
        url: surfaceUrl(server, request.query),
        viewport: request.viewport ?? MEASUREMENT_VIEWPORT,
        readySelector: request.readySelector,
        tones: request.tones,
        controls: request.controls,
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
          UAW_AFFORDANCE_JOB: jobPath,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        },
      },
    );

    const { code, stdout, stderr } = await collectDriver(child);
    const success = readTaggedLine(stdout, "UAW_AFFORDANCE ");
    if (code === 0 && success !== null) return success as AffordanceMeasurement;

    const failure = readTaggedLine(stdout, "UAW_AFFORDANCE_FAILURE ");
    const detail =
      failure === null
        ? `${stdout}\n${stderr}`.trim().slice(0, 2_000)
        : JSON.stringify(failure);
    throw new Error(`disabled-affordance measurement failed (exit ${code}): ${detail}`);
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
          `disabled-affordance driver produced no result within ${DRIVER_TIMEOUT_MS} ms:` +
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
      if (process.env.UAW_AFFORDANCE_DEBUG === "1") process.stderr.write(chunk);
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

/**
 * The delta a screenshot would show, and a cursor would not.
 *
 * Deliberately over the composited pixel rather than over the resolved style:
 * two different declarations can composite to the same colour, and a reader
 * who is told "the rule changed" still cannot conclude "the button looks
 * different". This is the number that supports that conclusion.
 */
export function channelDistance(a: Rgba | null, b: Rgba | null): number {
  if (a === null || b === null) return Number.NaN;
  return Math.max(
    Math.abs(a.red - b.red),
    Math.abs(a.green - b.green),
    Math.abs(a.blue - b.blue),
  );
}

export function formatSample(sample: Rgba | null): string {
  if (sample === null) return "none";
  return `rgba(${Math.round(sample.red)}, ${Math.round(sample.green)}, ${Math.round(
    sample.blue,
  )}, ${Math.round(sample.alpha)})`;
}

export function controlById(
  tone: AffordanceToneMeasurement,
  id: string,
): AffordanceReading {
  const found = tone.controls.find((control) => control.id === id);
  if (found === undefined) {
    throw new Error(`${tone.tone}: no affordance reading for control ${id}`);
  }
  return found;
}
