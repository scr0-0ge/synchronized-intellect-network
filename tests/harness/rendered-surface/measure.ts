/*
 * The Node half of the rendered-surface measurement (F118).
 *
 * Serves the real renderer — the product's own stylesheets and the product's
 * own component tree — over a Vite dev server, then drives one hidden Electron
 * renderer per surface and returns what the engine actually produced.
 *
 * Nothing here starts an Agent Runtime, an app-server, or a provider request.
 * The bridge the harness page mounts against is the existing local visual
 * fixture, so a measurement costs nothing and is repeatable offline.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ViteDevServer } from "vite";
import solid from "vite-plugin-solid";

import { createViteBrowserTestServer } from "../../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const harnessRoot = fileURLToPath(
  new URL("../../workbench-shell/visual-harness", import.meta.url),
);
const driverPath = fileURLToPath(new URL("./measure-electron.mjs", import.meta.url));
const electronBinary = createRequire(import.meta.url)("electron") as unknown as string;
const MEASUREMENT_STAGE_INACTIVITY_TIMEOUT_MS = 45_000;

/*
 * A Windows Electron child occasionally dies with STATUS_BREAKPOINT
 * (0x80000003) while Chromium tears itself down — after the driver has already
 * emitted its complete `UAW_MEASUREMENT` line and called `app.exit(0)`. The
 * crashed attempt's reading is not trusted anyway: it is discarded whole and
 * the surface re-rendered from scratch, so every accepted reading still comes
 * from a child that exited cleanly. Three attempts bound the retry; a crash
 * that reproduces three times in a row — or any exit without a complete
 * success line — stays red. Observed on hosted runners 2026-09-01: run
 * 33508893358 (width-settings-owner-proxy, 1904x1041) and run 33509699404
 * (project-histories-dark-000000, 1280x820), each on a different surface.
 */
const MEASUREMENT_TEARDOWN_CRASH_ATTEMPTS = 3;
const MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS = 5_000;
const closedMeasurementChildren = new WeakSet<ChildProcessWithoutNullStreams>();
const releasedMeasurementChildren = new WeakSet<ChildProcessWithoutNullStreams>();

export type Rgba = Readonly<{ red: number; green: number; blue: number; alpha: number }>;

export type BackgroundSample = Rgba & Readonly<{ count: number }>;

export type MeasuredTextBox = Readonly<{
  top: number;
  left: number;
  width: number;
  height: number;
  comparedPixels: number;
  inkedPixels: number;
  /** The colour the compositor actually painted at the best-covered glyph pixel. */
  paintedGlyph: Rgba | null;
  backgroundSamples: readonly BackgroundSample[];
}>;

export type MeasuredText = Readonly<{
  signature: string;
  region: "titlebar" | "statusbar" | null;
  /** Nearest long-lived Project surface root, whether active or dormant. */
  surfaceAncestor: "main.stage" | "aside.inspector" | null;
  /**
   * Every explicit `aria-hidden="true"` ancestor, nearest first.
   *
   * Kept as observation rather than verdict: decorative glyphs also use
   * `aria-hidden`, while the test decides which ancestors name a dormant
   * surface. The text and its pixels remain in the measurement either way.
   */
  ariaHiddenAncestors: readonly string[];
  /** Whatever is stacked above this string, if anything. Diagnostic. */
  occludedBy: string | null;
  text: string;
  color: string;
  fontSizePx: number;
  fontWeight: string;
  textShadow: string | null;
  textStrokeColor: string;
  textStrokeWidthPx: number;
  inheritedOpacity: number;
  opacityChain: readonly Readonly<{ signature: string; opacity: number }>[];
  colorSource: string | null;
  boxes: readonly MeasuredTextBox[];
}>;

export type MeasuredGrid = Readonly<{
  signature: string;
  autoFlow: string;
  templateColumns: string;
  templateRows: string;
  declaredColumnTracks: number;
  inFlowChildCount: number;
  autoPlacedChildCount: number;
  renderedRowCount: number;
  /** Rows recovered from painted geometry, each naming the children on it. */
  rows: readonly Readonly<{
    top: number;
    bottom: number;
    members: readonly string[];
  }>[];
  rect: Readonly<{ top: number; left: number; width: number; height: number }>;
  children: readonly Readonly<{
    signature: string;
    top: number;
    left: number;
    width: number;
    height: number;
    explicitlyPlaced: boolean;
  }>[];
}>;

export type GroundSample = Rgba & Readonly<{ count: number }>;

export type ProbedPoint = Rgba &
  Readonly<{
    x: number;
    y: number;
    /** True when a glyph fell on this point, so it is not a ground reading. */
    carriedInk: boolean;
  }>;

/**
 * The composited ground of one pane (`F102`).
 *
 * `samples` is the distinct colours actually painted over the pane's own
 * uncovered area, most common first. A pane painted as one flat surface has
 * exactly one entry.
 */
export type MeasuredGround = Readonly<{
  selector: string;
  present: boolean;
  signature: string | null;
  declaredBackgroundColor?: string;
  declaredBackgroundImage?: string;
  declaredBackdropFilter?: string;
  declaredWebkitBackdropFilter?: string;
  rect: Readonly<{ top: number; left: number; width: number; height: number }> | null;
  points: readonly Readonly<{ x: number; y: number }>[];
  samples: readonly GroundSample[];
}>;

/** Points straddling one pane boundary at a matched height. */
export type MeasuredSeam = Readonly<{
  leftSelector: string;
  rightSelector: string;
  boundaryX: number;
  samples: readonly Readonly<{
    y: number;
    offset: number;
    left: ProbedPoint;
    right: ProbedPoint;
  }>[];
}>;

/** Points immediately above and below a horizontal chrome/body boundary. */
export type MeasuredVerticalSeam = Readonly<{
  topSelector: string;
  bottomSelector: string;
  boundaryY: number;
  samples: readonly Readonly<{
    x: number;
    offset: number;
    top: ProbedPoint;
    bottom: ProbedPoint;
  }>[];
}>;

/**
 * The painted box of one named element, with no colour reading attached.
 *
 * Separate from `MeasuredGround` on purpose. A ground reading requires the
 * element to expose uncovered pixels AND obliges it to declare no fill of its
 * own, which is the contract the `F102` ground gates enforce. `.input-shell`
 * and `.target-bar` legitimately paint themselves, so they can never be ground
 * targets — but their HORIZONTAL EXTENT is exactly what the remaining half of
 * `F102` is about. This channel carries extent without making a colour claim.
 */
export type MeasuredExtent = Readonly<{
  selector: string;
  present: boolean;
  signature: string | null;
  /** The border box, in CSS pixels, in viewport coordinates. */
  rect: Readonly<{ top: number; left: number; width: number; height: number }> | null;
  /** The content box — the border box less border and padding on each side. */
  content: Readonly<{ left: number; width: number }> | null;
  declaredMaxWidth: string | null;
}>;

/** One element inside the conversation that draws a visible vertical edge. */
export type PaintedEdge = Readonly<{
  scope: string;
  signature: string;
  left: number;
  right: number;
  width: number;
}>;

export type MeasuredSurface = Readonly<{
  surfaceId: string;
  url: string;
  viewport: Readonly<{ width: number; height: number }>;
  devicePixelRatio: number;
  capture: Readonly<{ width: number; height: number }>;
  root: Readonly<Record<string, string | null>>;
  /**
   * Whether the acrylic skin's own fallback backdrop is painting (`F51`).
   *
   * `beforeContent === "none"` means the fallback pseudo-element does not
   * exist — the state the product enters whenever it signals native material,
   * including when the native probe came back `undetermined`.
   */
  fallbackGround: Readonly<{
    rootBackground: string;
    bodyBackground: string;
    beforeContent: string;
    beforeBackgroundImage: string;
  }>;
  grids: readonly MeasuredGrid[];
  texts: readonly MeasuredText[];
  grounds: readonly MeasuredGround[];
  extents: readonly MeasuredExtent[];
  paintedEdges: readonly PaintedEdge[];
  seams: readonly MeasuredSeam[];
  verticalSeams: readonly MeasuredVerticalSeam[];
  consoleMessages: readonly string[];
}>;

export type SurfaceStep = Readonly<{
  click: string;
  within?: string;
  text?: string;
  settleSelector?: string;
}>;

export type SurfaceRequest = Readonly<{
  surfaceId: string;
  query: string;
  readySelector: string;
  /** Maximum initial mount wait; defaults to the driver's 15-second guard. */
  readyTimeoutMs?: number;
  steps?: readonly SurfaceStep[];
  settleMs?: number;
  /**
   * Root dataset keys set before measuring. Only `material` belongs here: the
   * product entry sets it from its own startup parameters and no appearance
   * control may rewrite it (D12), so it cannot be reached by clicking.
   */
  rootAttributes?: Readonly<Record<string, string>>;
  /**
   * Preserve the product's resolved text-shadow in the painted capture.
   * Ordinary WCAG measurements remove it because shadows receive no contrast
   * credit; Phosphor evidence opts in because the glow itself is the subject.
   */
  preserveTextShadow?: boolean;
  /**
   * Optional absolute PNG destination for the pre-hide compositor capture.
   * The child writes only inside its owned scratch root; the parent publishes
   * this destination with fail-if-present semantics after a successful exit.
   */
  screenshotPath?: string;
  /**
   * Harness-only colour behind a material-on transparent renderer. Pure desktop
   * endpoints exercise the real compositing stack without changing wallpaper.
   */
  windowBackground?: "#000000" | "#ffffff" | "#d32f2f";
  /**
   * The renderer size for this surface. Defaults to `MEASUREMENT_VIEWPORT`.
   *
   * A width question cannot be answered at a width where the rule under test
   * never engages: the 1100px reading cap first bites above a 1368px viewport,
   * so every reading taken at the pinned 1440 is taken just past the knee and
   * says nothing about the owner's screen. Overriding the size is therefore
   * part of the measurement, not a convenience — but it stays per-request so
   * the contrast sweep keeps its single pinned size and stays comparable
   * between runs.
   */
  viewport?: Readonly<{ width: number; height: number }>;
}>;

export const MEASUREMENT_VIEWPORT = Object.freeze({ width: 1440, height: 1000 });

/**
 * The owner's recorded screen, in CSS pixels: a 3840x2160 panel at 125%.
 *
 * Recorded in the `F102` ledger entry as an inference from the durable
 * material-probe record, not as a recovered screenshot size. Used here because
 * it is the only width at which the reported impression can be reproduced at
 * all — at 1440 the cap does not engage and there is nothing to see.
 */
export const OWNER_PROXY_VIEWPORT = Object.freeze({ width: 3072, height: 1680 });

/**
 * The QA page declares a strict CSP for its own production-fidelity reasons.
 * A dev server's module client is not part of what this harness measures, and
 * the shipped CSP is guarded separately by the production CSP test, so the meta
 * tag is dropped for the measurement run only. Content Security Policy has no
 * effect on layout or on colour, which is all this harness reads.
 */
const dropCspForMeasurement = {
  name: "uaw-drop-csp-for-measurement",
  transformIndexHtml(html: string): string {
    return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/u, "");
  },
};

export async function startSurfaceServer(): Promise<ViteDevServer> {
  const server = await createViteBrowserTestServer({
    configFile: false,
    logLevel: "silent",
    root: harnessRoot,
    plugins: [dropCspForMeasurement, solid()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
      fs: { allow: [repositoryRoot] },
    },
  });
  await server.listen();
  return server;
}

export function surfaceUrl(server: ViteDevServer, query: string): string {
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("the surface server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}/${query}`;
}

export async function measureSurface(
  server: ViteDevServer,
  request: SurfaceRequest,
): Promise<MeasuredSurface> {
  if (request.screenshotPath !== undefined && !isAbsolute(request.screenshotPath)) {
    throw new Error("rendered-surface screenshot destination must be absolute");
  }
  const scratch = await mkdtemp(join(tmpdir(), "uaw-measure-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let operationError: unknown;
  try {
    for (let attempt = 1; ; attempt += 1) {
      /* Each attempt gets its own stage: the driver writes its screenshot with
         an exclusive flag, and a crashed Chromium can leave its profile dir
         locked, so nothing from a dead attempt is reused. */
      const stage = join(scratch, `attempt-${attempt}`);
      await mkdir(stage, { recursive: true });
      const jobPath = join(stage, "job.json");
      const stagedScreenshotPath =
        request.screenshotPath === undefined ? null : join(stage, "capture.png");
      await writeFile(
        jobPath,
        JSON.stringify({
          surfaceId: request.surfaceId,
          url: surfaceUrl(server, request.query),
          viewport: request.viewport ?? MEASUREMENT_VIEWPORT,
          readySelector: request.readySelector,
          readyTimeoutMs: request.readyTimeoutMs,
          steps: request.steps ?? [],
          settleMs: request.settleMs ?? 300,
          rootAttributes: request.rootAttributes ?? {},
          preserveTextShadow: request.preserveTextShadow ?? false,
          screenshotPath: stagedScreenshotPath,
          windowBackground: request.windowBackground ?? "#ffffff",
        }),
        "utf8",
      );

      child = spawn(
        electronBinary,
        [driverPath, `--user-data-dir=${join(stage, "user-data")}`],
        {
          windowsHide: true,
          env: {
            ...process.env,
            UAW_MEASURE_JOB: jobPath,
            UAW_MEASURE_SURFACE: request.surfaceId,
            ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
          },
        },
      );
      trackMeasurementChildClose(child);
      const { code, stdout, stderr } = await collectMeasurementChild(child, request.surfaceId);

      const success = readTaggedLine(stdout, "UAW_MEASUREMENT ");
      if (code === 0 && success !== null) {
        if (request.screenshotPath !== undefined && stagedScreenshotPath !== null) {
          await writeFile(request.screenshotPath, await readFile(stagedScreenshotPath), {
            flag: "wx",
          });
        }
        return success as MeasuredSurface;
      }
      /* A non-zero exit AFTER a complete success line is a teardown crash:
         discard the whole reading and re-render. Anything else is a real
         failure and stays red on the spot. */
      if (success !== null && attempt < MEASUREMENT_TEARDOWN_CRASH_ATTEMPTS) {
        process.stdout.write(
          `UAW_MEASUREMENT_TEARDOWN_CRASH_RETRY ${JSON.stringify({
            surfaceId: request.surfaceId,
            attempt,
            code,
          })}\n`,
        );
        continue;
      }
      const failure = readTaggedLine(stdout, "UAW_MEASUREMENT_FAILURE ");
      const detail =
        failure === null
          ? `${stdout}\n${stderr}`.trim().slice(0, 2_000)
          : JSON.stringify(failure);
      throw new Error(
        `rendered-surface measurement of ${request.surfaceId} failed (exit ${code}): ${detail}`,
      );
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (child !== undefined) {
      try {
        await stopOwnedMeasurementChild(child, request.surfaceId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        `rendered-surface cleanup of ${request.surfaceId} failed`,
      );
    }
  }
}

type MeasurementChildOutput = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

function trackMeasurementChildClose(child: ChildProcessWithoutNullStreams): void {
  child.once("close", () => closedMeasurementChildren.add(child));
}

function collectMeasurementChild(
  child: ChildProcessWithoutNullStreams,
  surfaceId: string,
): Promise<MeasurementChildOutput> {
  return new Promise((resolve, reject) => {
    const debug = process.env.UAW_MEASURE_DEBUG === "1";
    const inactivityTimeoutMs = measurementInactivityTimeoutMs();
    const childPid = child.pid;
    let stdout = "";
    let stderr = "";
    let stageRemainder = "";
    let lastStage = "Electron process startup";
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let forcedTerminationTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutError: Error | undefined;
    let spawnError: Error | undefined;
    let settled = false;
    const terminationErrors: unknown[] = [];

    const onStdout = (chunk: string): void => {
      if (settled) return;
      stdout += chunk;
    };

    const onStderr = (chunk: string): void => {
      if (settled) return;
      stderr += chunk;
      observeStages(chunk);
      if (debug) process.stderr.write(chunk);
    };

    const onError = (error: Error): void => {
      if (settled) return;
      spawnError = error;
      if (child.pid === undefined) {
        releasedMeasurementChildren.add(child);
        releaseMeasurementChildHandles(child);
        finish(error);
      }
    };

    const onClose = (exitCode: number | null): void => {
      if (settled) return;
      closedMeasurementChildren.add(child);
      if (timeoutError !== undefined) finish(timeoutError);
      else if (spawnError !== undefined) finish(spawnError);
      else finish(undefined, { code: exitCode ?? -1, stdout, stderr });
    };

    const finish = (
      error: unknown,
      output?: MeasurementChildOutput,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      clearTimeout(terminationTimer);
      clearTimeout(forcedTerminationTimer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error === undefined && output !== undefined) resolve(output);
      else reject(error);
    };

    const armInactivityTimer = (): void => {
      if (settled || timeoutError !== undefined) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (settled || timeoutError !== undefined) return;
        timeoutError = new Error(
          `rendered-surface measurement of ${surfaceId} timed out after ` +
            `${inactivityTimeoutMs} ms without stage progress while waiting for ` +
            `${lastStage} (pid ${String(childPid)})`,
        );
        requestMeasurementChildTermination(child, "SIGTERM", terminationErrors);
        terminationTimer = setTimeout(() => {
          if (settled) return;
          requestMeasurementChildTermination(child, "SIGKILL", terminationErrors);
          forcedTerminationTimer = setTimeout(() => {
            if (settled) return;
            releasedMeasurementChildren.add(child);
            releaseMeasurementChildHandles(child);
            finish(
              new AggregateError(
                [
                  timeoutError,
                  ...terminationErrors,
                  new Error(
                    `rendered-surface measurement of ${surfaceId} could not observe close ` +
                      `for its exact child pid ${String(childPid)} within ` +
                      `${MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS} ms`,
                  ),
                ],
                `rendered-surface measurement of ${surfaceId} timed out and cleanup failed`,
              ),
            );
          }, MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS / 2);
        }, MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS / 2);
      }, inactivityTimeoutMs);
    };

    const observeStages = (chunk: string): void => {
      stageRemainder += chunk;
      const lines = stageRemainder.split(/\r?\n/u);
      stageRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("UAW_MEASUREMENT_STAGE ")) continue;
        try {
          const observation = JSON.parse(
            line.slice("UAW_MEASUREMENT_STAGE ".length),
          ) as unknown;
          if (
            typeof observation === "object" &&
            observation !== null &&
            "stage" in observation &&
            typeof observation.stage === "string"
          ) {
            lastStage = observation.stage;
            armInactivityTimer();
          }
        } catch {
          // The complete stderr is retained below and reported if the child fails.
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    armInactivityTimer();
  });
}

function measurementInactivityTimeoutMs(): number {
  const requested = Number(process.env.UAW_MEASURE_TEST_INACTIVITY_TIMEOUT_MS);
  return Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MEASUREMENT_STAGE_INACTIVITY_TIMEOUT_MS)
    : MEASUREMENT_STAGE_INACTIVITY_TIMEOUT_MS;
}

async function stopOwnedMeasurementChild(
  child: ChildProcessWithoutNullStreams,
  surfaceId: string,
): Promise<void> {
  if (closedMeasurementChildren.has(child) || releasedMeasurementChildren.has(child)) return;
  if (child.pid === undefined) {
    releasedMeasurementChildren.add(child);
    releaseMeasurementChildHandles(child);
    return;
  }
  const childPid = child.pid;
  const terminationErrors: unknown[] = [];
  requestMeasurementChildTermination(child, "SIGTERM", terminationErrors);
  const forceAt = Date.now() + MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS / 2;
  const deadline = Date.now() + MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS;
  while (Date.now() < forceAt) {
    if (closedMeasurementChildren.has(child)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  requestMeasurementChildTermination(child, "SIGKILL", terminationErrors);
  while (Date.now() < deadline) {
    if (closedMeasurementChildren.has(child)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  releasedMeasurementChildren.add(child);
  releaseMeasurementChildHandles(child);
  throw new AggregateError(
    [
      ...terminationErrors,
      new Error(
        `rendered-surface cleanup of ${surfaceId} could not observe close for exact child pid ` +
          `${String(childPid)} within ${MEASUREMENT_CHILD_TERMINATION_TIMEOUT_MS} ms`,
      ),
    ],
    `rendered-surface cleanup of ${surfaceId} failed`,
  );
}

function requestMeasurementChildTermination(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  errors: unknown[],
): void {
  try {
    child.kill(signal);
  } catch (error) {
    errors.push(error);
  }
}

function releaseMeasurementChildHandles(child: ChildProcessWithoutNullStreams): void {
  child.stdout.removeAllListeners();
  child.stderr.removeAllListeners();
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

function readTaggedLine(stdout: string, tag: string): unknown {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith(tag)) return JSON.parse(line.slice(tag.length));
  }
  return null;
}
