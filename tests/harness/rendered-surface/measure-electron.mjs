/*
 * The Electron half of the rendered-surface measurement (F118).
 *
 * Launches a hidden BrowserWindow — a real Chromium renderer, the same engine
 * the product ships — loads a surface, and reports two kinds of fact that no
 * source-text comparison can produce:
 *
 *   1. GEOMETRY. Where the engine actually put things.
 *   2. COMPOSITED COLOUR. Read out of the compositor's own output buffer, so
 *      gradients, stacked alpha and backdrop-filter are included by
 *      construction rather than approximated by arithmetic over a background
 *      somebody assumed.
 *
 * The window is never shown. Nothing here takes the owner's screen (F8/F17).
 *
 * Contract: reads a job JSON path from UAW_MEASURE_JOB, writes one
 * `UAW_MEASUREMENT <json>` line to stdout, exits. Any failure is reported as
 * `UAW_MEASUREMENT_FAILURE <json>` with a non-zero exit code.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

const programPath = fileURLToPath(new URL("./in-page-program.js", import.meta.url));

/**
 * A pixel counts as background only if hiding every glyph on the page left it
 * bit-identical. Anything that moved is ink and is excluded from the background
 * set, so a neighbouring glyph can never be read as this string's surface.
 */
const INK_EPSILON = 0;
const driverStartedAt = Date.now();
const surfaceId = process.env.UAW_MEASURE_SURFACE ?? null;

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

void runDriver().catch((error) => {
  process.stderr.write(
    `UAW_MEASUREMENT_DRIVER_FAILURE ${JSON.stringify({
      surfaceId,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  app.exit(1);
});

async function runDriver() {
  let window;
  let exitCode = 1;
  try {
    await waitForStage("Electron app readiness", 15_000, () => app.whenReady());
    const job = JSON.parse(
      await waitForStage("measurement job read", 5_000, () =>
        readFile(process.env.UAW_MEASURE_JOB ?? "", "utf8"),
      ),
    );
    const program = await waitForStage("in-page program read", 5_000, () =>
      readFile(programPath, "utf8"),
    );

    window = new BrowserWindow({
      width: job.viewport.width,
      height: job.viewport.height,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: job.windowBackground,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep hidden-page frame production available to invalidate/capturePage.
        // Driver completion does not depend on a renderer requestAnimationFrame.
        backgroundThrottling: false,
      },
    });
    announceStage("hidden BrowserWindow created");

    const consoleMessages = [];
    /* Electron moved this event from positional arguments to a details object;
       accept both so the driver is not silently blind on either version. */
    window.webContents.on("console-message", (details, level, message) => {
      const reported = typeof details === "object" && details !== null && "level" in details
        ? { level: String(details.level), message: String(details.message) }
        : { level: String(level), message: String(message) };
      if (reported.level === "error" || reported.level === "warning" || reported.level === "2" || reported.level === "3") {
        consoleMessages.push(`${reported.level}: ${reported.message}`);
      }
    });

    await waitForStage("surface navigation", 30_000, () => window.loadURL(job.url));

    /* An OS-level media feature has no click path. It is emulated through the
       renderer's own DevTools protocol, once the navigation has produced a
       renderer for the protocol to reach, and before the in-page program runs
       — so every step, settle and capture below happens in the requested
       configuration. The collected root reports what `matchMedia` resolved, so
       an emulation that failed to engage is visible in the reading rather than
       assumed. */
    const emulatedMediaFeatures = job.emulatedMediaFeatures ?? [];
    if (emulatedMediaFeatures.length > 0) {
      window.webContents.debugger.attach("1.3");
      await waitForStage("emulated media features", 10_000, () =>
        window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: emulatedMediaFeatures.map((feature) => ({
            name: String(feature.name),
            value: String(feature.value),
          })),
        }),
      );
      announceStage("emulated media features applied");
    }
    await waitForStage("in-page program injection", 10_000, () => run(window, program));
    await waitForStage("motion freeze", 10_000, () =>
      evaluate(
        window,
        `globalThis.__uawMeasure.freezeMotion(${JSON.stringify(Boolean(job.preserveTextShadow))})`,
      ),
    );
    await waitFor(
      window,
      job.readySelector,
      job.readyTimeoutMs ?? 15_000,
      "initial ready selector",
    );
    for (const [index, step] of (job.steps ?? []).entries()) {
      await waitForStage(`step ${index + 1} click`, 10_000, () => applyStep(window, step));
      await waitFor(
        window,
        step.settleSelector ?? job.readySelector,
        10_000,
        `step ${index + 1} settle selector`,
      );
    }
    for (const [key, value] of Object.entries(job.rootAttributes ?? {})) {
      await waitForStage(`root attribute ${key}`, 10_000, () =>
        evaluate(
          window,
          `(() => { document.documentElement.dataset[${JSON.stringify(key)}] = ${JSON.stringify(value)}; return true; })()`,
        ),
      );
    }
    await waitForStage("final compositor settle", 10_000, () =>
      settle(window, job.settleMs ?? 250),
    );

    const collected = await waitForStage("surface collection", 15_000, () =>
      evaluate(window, "globalThis.__uawMeasure.collect()"),
    );
    const inked = await capture(window, "inked capture");
    if (typeof job.screenshotPath === "string") {
      await waitForStage("screenshot write", 5_000, () =>
        writeFile(job.screenshotPath, inked.png, { flag: "wx" }),
      );
    }
    const hidden = await waitForStage("text hiding", 10_000, () =>
      evaluate(window, "globalThis.__uawMeasure.hideAllInk()"),
    );
    await waitForStage("plain compositor settle", 10_000, () => settle(window, 120));
    const plain = await capture(window, "plain capture");
    await waitForStage("text restoration", 10_000, () =>
      evaluate(window, "globalThis.__uawMeasure.restoreMeasuredText()"),
    );

    if (hidden !== collected.texts.length) {
      throw new Error(
        `text-hiding pass marked ${hidden} elements but ${collected.texts.length} were measured`,
      );
    }

    announceStage("measurement payload construction");
    const payload = {
      surfaceId: job.surfaceId,
      url: job.url,
      viewport: collected.viewport,
      devicePixelRatio: collected.devicePixelRatio,
      capture: { width: plain.width, height: plain.height },
      root: collected.root,
      mediaEnvironment: collected.mediaEnvironment,
      fallbackGround: collected.fallbackGround,
      grids: collected.grids,
      texts: collected.texts.map((text) => ({
        ...text,
        boxes: text.boxes.map((box) => sampleBox(box, collected.viewport, inked, plain)),
      })),
      extents: collected.extents,
      clippedControls: collected.clippedControls,
      paintedEdges: collected.paintedEdges,
      grounds: collected.grounds.map((ground) => ({
        ...ground,
        samples: aggregate(
          ground.points.map((point) => samplePoint(point, collected.viewport, inked, plain)),
        ),
      })),
      seams: collected.seams.map((seam) => ({
        ...seam,
        samples: seam.samples.map((sample) => ({
          y: sample.y,
          offset: sample.offset,
          left: samplePoint(sample.left, collected.viewport, inked, plain),
          right: samplePoint(sample.right, collected.viewport, inked, plain),
        })),
      })),
      verticalSeams: collected.verticalSeams.map((seam) => ({
        ...seam,
        samples: seam.samples.map((sample) => ({
          x: sample.x,
          offset: sample.offset,
          top: samplePoint(sample.top, collected.viewport, inked, plain),
          bottom: samplePoint(sample.bottom, collected.viewport, inked, plain),
        })),
      })),
      consoleMessages,
    };
    await waitForStage("measurement result write", 5_000, () =>
      emit("UAW_MEASUREMENT", payload),
    );
    exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await waitForStage("measurement failure write", 2_000, () =>
        emit("UAW_MEASUREMENT_FAILURE", { surfaceId, message }),
      );
    } catch (emitError) {
      process.stderr.write(
        `UAW_MEASUREMENT_FAILURE_WRITE ${JSON.stringify({
          surfaceId,
          message: emitError instanceof Error ? emitError.message : String(emitError),
          originalMessage: message,
        })}\n`,
      );
    }
  } finally {
    if (window !== undefined && !window.isDestroyed()) {
      try {
        window.destroy();
      } catch (error) {
        process.stderr.write(
          `UAW_MEASUREMENT_WINDOW_CLEANUP_FAILURE ${JSON.stringify({
            surfaceId,
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        exitCode = 1;
      }
    }
    app.exit(exitCode);
  }
}

/**
 * Every device pixel of one text box is classified by comparing the two
 * captures, which separates the string's own surface from the string itself
 * without knowing anything about either.
 *
 *   background — unchanged when all ink was hidden. These are the real
 *                composited surfaces the string is painted on: gradients,
 *                stacked alpha and backdrop-filter already applied.
 *   ink        — changed. The one that moved furthest is the best-covered
 *                glyph pixel available, and its INKED value is the colour the
 *                compositor actually put on screen for this text, including
 *                anything painted over it.
 *
 * `inkedPixels === 0` means the string left no mark at all. That is reported,
 * never silently treated as a passing reading.
 */
function sampleBox(box, viewport, inked, plain) {
  const counts = new Map();
  let inkedPixels = 0;
  let comparedPixels = 0;
  let bestDistance = -1;
  let paintedGlyph = null;
  let glyphLocalBackground = null;

  const bounds = deviceBounds(box, viewport, plain);
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const background = pixelAt(plain, x, y);
      const foreground = pixelAt(inked, x, y);
      comparedPixels += 1;
      const distance =
        Math.abs(foreground[0] - background[0]) +
        Math.abs(foreground[1] - background[1]) +
        Math.abs(foreground[2] - background[2]);
      if (distance > INK_EPSILON) {
        inkedPixels += 1;
        if (distance > bestDistance) {
          bestDistance = distance;
          paintedGlyph = foreground;
          glyphLocalBackground = background;
        }
        continue;
      }
      const key = `${background[0]},${background[1]},${background[2]},${background[3]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  /* A box with no clean pixel is entirely covered by its own glyphs. The
     background beneath the best-covered glyph is still a real reading. */
  if (counts.size === 0 && glyphLocalBackground !== null) {
    const [red, green, blue, alpha] = glyphLocalBackground;
    counts.set(`${red},${green},${blue},${alpha}`, 1);
  }

  return {
    ...box,
    comparedPixels,
    inkedPixels,
    paintedGlyph:
      paintedGlyph === null
        ? null
        : { red: paintedGlyph[0], green: paintedGlyph[1], blue: paintedGlyph[2], alpha: paintedGlyph[3] },
    backgroundSamples: [...counts].map(([key, count]) => {
      const [red, green, blue, alpha] = key.split(",").map(Number);
      return { red, green, blue, alpha, count };
    }),
  };
}

/**
 * One composited pixel, read out of the same two captures the text sampling
 * uses.
 *
 * `inked` is reported alongside `background` so a point that turned out to have
 * a glyph on it is visible as a fact rather than silently averaged into a
 * ground reading. The in-page pass already rejects points covered by a
 * descendant element, but a text node belongs to the element itself and is not
 * a descendant box, so this is the check that catches it.
 */
function samplePoint(point, viewport, inked, plain) {
  const device = devicePoint(point, viewport, plain);
  const background = pixelAt(plain, device.x, device.y);
  const foreground = pixelAt(inked, device.x, device.y);
  const distance =
    Math.abs(foreground[0] - background[0]) +
    Math.abs(foreground[1] - background[1]) +
    Math.abs(foreground[2] - background[2]);
  return {
    x: point.x,
    y: point.y,
    red: background[0],
    green: background[1],
    blue: background[2],
    alpha: background[3],
    carriedInk: distance > INK_EPSILON,
  };
}

/**
 * Distinct composited colours over a pane's probe points, most common first.
 *
 * A pane whose ground is one flat surface collapses to a single entry. More
 * than one entry is not a failure by itself — a gradient is a legitimate
 * design — so the spread is reported and the test decides.
 */
function aggregate(samples) {
  const counts = new Map();
  for (const sample of samples) {
    if (sample.carriedInk) continue;
    const key = `${sample.red},${sample.green},${sample.blue},${sample.alpha}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [red, green, blue, alpha] = key.split(",").map(Number);
      return { red, green, blue, alpha, count };
    })
    .sort((a, b) => b.count - a.count);
}

function devicePoint(point, viewport, image) {
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;
  return {
    x: Math.min(image.width - 1, Math.max(0, Math.round(point.x * scaleX))),
    y: Math.min(image.height - 1, Math.max(0, Math.round(point.y * scaleY))),
  };
}

function deviceBounds(box, viewport, image) {
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;
  const clampX = (value) => Math.min(image.width - 1, Math.max(0, value));
  const clampY = (value) => Math.min(image.height - 1, Math.max(0, value));
  return {
    left: clampX(Math.ceil(box.left * scaleX)),
    right: clampX(Math.floor((box.left + box.width) * scaleX) - 1),
    top: clampY(Math.ceil(box.top * scaleY)),
    bottom: clampY(Math.floor((box.top + box.height) * scaleY) - 1),
  };
}

/** Electron bitmaps are BGRA; the caller wants RGBA. */
function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [
    image.bitmap[offset + 2],
    image.bitmap[offset + 1],
    image.bitmap[offset],
    image.bitmap[offset + 3],
  ];
}

/**
 * A window that is never shown does not necessarily repaint everything it lays
 * out. `invalidate()` schedules a full repaint, then Electron's capture path
 * temporarily treats the still-hidden page as visible while obtaining the
 * snapshot. The wait between them belongs to the main process: waiting on a
 * hidden renderer's requestAnimationFrame chain is the hang this driver must
 * not recreate.
 *
 * Ink/ground separation rests on bit-identical pixel comparison, so its input
 * must itself be bit-stable: a single capture can race a still-landing repaint
 * and hand the classifier a frame in which every compared pixel has moved
 * (observed in the sibling affordance driver on a hosted runner, run
 * 33510494560). Capture until two consecutive frames agree byte for byte; a
 * page that never settles is a loud failure, not a reading.
 */
async function capture(window, stage) {
  let previous = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await waitForStage(`${stage} compositor settle`, 10_000, () => settle(window, 80));
    const image = await waitForStage(`${stage} capturePage (attempt ${attempt})`, 15_000, () =>
      window.webContents.capturePage(undefined, { stayHidden: false }),
    );
    announceStage(`${stage} bitmap conversion (attempt ${attempt})`);
    const size = image.getSize();
    const bitmap = image.toBitmap();
    if (previous !== null && previous.bitmap.equals(bitmap)) {
      return {
        width: size.width,
        height: size.height,
        bitmap,
        png: image.toPNG(),
      };
    }
    previous = { width: size.width, height: size.height, bitmap };
  }
  throw new Error(`${stage}: no two consecutive captures agreed byte for byte`);
}

async function applyStep(window, step) {
  const clicked = await evaluate(
    window,
    `(() => {
      const scope = ${JSON.stringify(step.within ?? null)};
      const container = scope === null ? document : document.querySelector(scope);
      if (container === null) return "missing-scope";
      const candidates = [...container.querySelectorAll(${JSON.stringify(step.click)})];
      const wanted = ${JSON.stringify(step.text ?? null)};
      const target = wanted === null
        ? candidates[0]
        : candidates.find((node) => (node.textContent ?? "").trim() === wanted);
      if (target === undefined || target === null) return "missing-target";
      target.click();
      return "clicked";
    })()`,
  );
  if (clicked !== "clicked") {
    throw new Error(`step ${JSON.stringify(step)} failed: ${clicked}`);
  }
}

async function waitFor(window, selector, timeoutMs, stage) {
  if (typeof selector !== "string" || selector === "") return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const found = await waitForStage(`${stage} evaluation`, Math.min(5_000, remaining), () =>
      evaluate(window, `document.querySelector(${JSON.stringify(selector)}) !== null`),
    );
    if (found === true) return;
    const remainingAfterEvaluation = deadline - Date.now();
    if (remainingAfterEvaluation <= 0) {
      throw new Error(`timed out after ${timeoutMs} ms while waiting for ${stage}: ${selector}`);
    }
    await waitForStage(
      `${stage} compositor settle`,
      Math.min(5_000, remainingAfterEvaluation),
      () => settle(window, 100),
    );
  }
}

/**
 * Wait in the main process, then require a compositor presentation generated by
 * invalidate(). This preserves the old two-frame intent without depending on a
 * hidden renderer's requestAnimationFrame scheduler.
 */
async function settle(window, milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, Number(milliseconds)));
  await presentedFrame(window);
}

function presentedFrame(window) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(
      () => finish(new Error("timed out after 5000 ms while waiting for compositor presentation")),
      5_000,
    );

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try {
        window.webContents.endFrameSubscription();
      } catch (cleanupError) {
        if (error === undefined) {
          reject(cleanupError);
          return;
        }
      }
      if (error === undefined) resolve();
      else reject(error);
    };

    try {
      window.webContents.beginFrameSubscription(false, () => finish());
      window.webContents.invalidate();
    } catch (error) {
      finish(error);
    }
  });
}

/* The trailing `void 0` matters: a script's completion value is returned across
   the structured-clone boundary, and the program's last expression is an object
   carrying functions, which cannot be cloned. */
async function run(window, source) {
  await window.webContents.executeJavaScript(`${source}\n;void 0;`, true);
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(`(${expression})`, true);
}

function announceStage(stage) {
  process.stderr.write(
    `UAW_MEASUREMENT_STAGE ${JSON.stringify({
      surfaceId,
      pid: process.pid,
      elapsedMs: Date.now() - driverStartedAt,
      stage,
    })}\n`,
  );
}

async function waitForStage(stage, timeoutMs, operation) {
  announceStage(stage);
  let timeout;
  const operationPromise =
    process.env.UAW_MEASURE_TEST_STALL_STAGE === stage
      ? new Promise(() => undefined)
      : Promise.resolve().then(operation);
  try {
    return await Promise.race([
      operationPromise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs} ms while waiting for ${stage}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function emit(tag, payload) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${tag} ${JSON.stringify(payload)}\n`, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}
