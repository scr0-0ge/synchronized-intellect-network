/*
 * The Electron half of the reduced-motion tone-flip measurement (F225).
 *
 * F215's mounted-vs-probe comparison went red on a hosted runner and green on
 * the same commit's private run because the reading it takes is a race. This
 * driver removes the race so the underlying question can be answered
 * deterministically on any machine:
 *
 *   when a reader has asked for REDUCED motion, does flipping `data-tone` on
 *   `:root` start a transition?
 *
 * Two things make it deterministic where the F215 driver is not:
 *
 *   1. `--force-prefers-reduced-motion` pins the media feature, instead of
 *      inheriting whatever the host's animation setting happens to be. The
 *      driver reports whether the query actually matched, so a switch that
 *      stops working can never turn this guard into a no-op that passes.
 *   2. The flip and the reads happen in ONE synchronous script task. No
 *      animation frame can tick between them, so a transition that was
 *      started is always caught at progress 0 rather than sometimes caught
 *      and sometimes missed. That is the whole difference between the public
 *      run and the private one.
 *
 * The probe is built AFTER the flip on purpose: a freshly created element has
 * no before-change style, so it can never start a transition. It is the
 * control that separates "the light tone did not arrive" from "the light tone
 * arrived and the mounted tree is reporting an interpolation of the old one".
 *
 * The window is never shown. Nothing here takes the owner's screen (F8/F17).
 *
 * Contract: reads a job JSON path from UAW_REDUCED_MOTION_JOB, writes one
 * `UAW_REDUCED_MOTION <json>` line to stdout, exits. Any failure is reported
 * as `UAW_REDUCED_MOTION_FAILURE <json>` with a non-zero exit code.
 */
import { readFile } from "node:fs/promises";

import { app, BrowserWindow } from "electron";

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("force-prefers-reduced-motion");
app.disableHardwareAcceleration();

void runDriver().catch((error) => {
  process.stderr.write(
    `UAW_REDUCED_MOTION_DRIVER_FAILURE ${JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  app.exit(1);
});

async function runDriver() {
  let window;
  let exitCode = 1;
  try {
    await app.whenReady();
    const job = JSON.parse(await readFile(process.env.UAW_REDUCED_MOTION_JOB ?? "", "utf8"));

    window = new BrowserWindow({
      width: job.viewport.width,
      height: job.viewport.height,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    await window.loadURL(job.url);
    await waitFor(window, job.readySelector, 20_000);
    await run(window, buildFlipProgram(job.probe));

    const reducedMotionMatches = await evaluate(
      window,
      'matchMedia("(prefers-reduced-motion: reduce)").matches',
    );
    const rootDataset = await evaluate(window, "({ ...document.documentElement.dataset })");

    /* Settle first, so nothing left over from load is still interpolating and
       the flip below is the only thing this reading can be about. */
    await evaluate(window, "globalThis.__uawToneFlip.settle()");

    const flip = await evaluate(window, "globalThis.__uawToneFlip.flipAndRead()");

    process.stdout.write(
      `UAW_REDUCED_MOTION ${JSON.stringify({
        url: job.url,
        viewport: job.viewport,
        reducedMotionMatches,
        rootDataset,
        ...flip,
      })}\n`,
    );
    exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`UAW_REDUCED_MOTION_FAILURE ${JSON.stringify({ message })}\n`);
  } finally {
    if (window !== undefined && !window.isDestroyed()) {
      try {
        window.destroy();
      } catch (error) {
        process.stderr.write(
          `UAW_REDUCED_MOTION_WINDOW_CLEANUP_FAILURE ${JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        exitCode = 1;
      }
    }
    app.exit(exitCode);
  }
}

function buildFlipProgram(probe) {
  const probeJson = JSON.stringify(probe);
  return `
globalThis.__uawToneFlip = (() => {
  const probe = ${probeJson};
  const PROBE_HOST_ID = "uaw-tone-flip-probe";

  /* Exactly what mount.tsx applyWorkbenchAppearance does for this axis. */
  function setTone(tone) {
    const root = document.documentElement;
    if (tone === "light") root.setAttribute("data-tone", "light");
    else root.removeAttribute("data-tone");
    return root.getAttribute("data-tone");
  }

  function mountedPrimaryButtons() {
    return [...document.querySelectorAll(".btn.primary")].filter(
      (node) => node.closest("#" + PROBE_HOST_ID) === null,
    );
  }

  function snapshot(node) {
    const style = getComputedStyle(node);
    return {
      classes: node.className,
      text: (node.textContent ?? "").trim().slice(0, 60),
      disabled: node.disabled === true,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderTopColor: style.borderTopColor,
      opacity: style.opacity,
      cursor: style.cursor,
    };
  }

  function buildProbe() {
    const existing = document.getElementById(PROBE_HOST_ID);
    if (existing !== null) existing.remove();
    const stage = document.querySelector("main.stage") ?? document.body;
    const anchor = stage.getBoundingClientRect();
    const host = document.createElement("div");
    host.id = PROBE_HOST_ID;
    host.style.cssText = [
      "position:fixed",
      "left:" + Math.round(anchor.left + 24) + "px",
      "top:" + Math.round(anchor.top + 24) + "px",
      "z-index:2147483000",
      "background:none",
      "border:0",
      "margin:0",
      "padding:0",
    ].join(";");
    const button = document.createElement("button");
    button.type = "button";
    button.className = probe.classes;
    const ink = document.createElement("span");
    ink.textContent = probe.label;
    button.append(ink);
    host.append(button);
    document.body.append(host);
    return button;
  }

  function describe(animation) {
    return {
      kind: animation.constructor.name,
      property: animation.transitionProperty ?? animation.animationName ?? null,
      playState: animation.playState,
      currentTime: animation.currentTime,
    };
  }

  function isTransition(animation) {
    return animation.constructor.name === "CSSTransition";
  }

  async function settle() {
    setTone("dark");
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return true;
  }

  /*
   * One synchronous task: flip, then read. No animation frame can tick in
   * between, so a transition the flip started is always observed here.
   *
   * The baseline is a Set of the Animation OBJECTS, not a count. The fixture is
   * still settling its own fonts and text when this runs, and a surface that
   * happens to have two of its own transitions in flight must not be able to
   * hide — or to manufacture — a finding. Identity comparison answers exactly
   * "what did THIS flip start", and nothing else.
   */
  function flipAndRead() {
    const baseline = new Set(document.getAnimations());
    const mountedNodes = mountedPrimaryButtons();

    setTone("light");

    const afterFlip = document.getAnimations();
    const startedByFlip = afterFlip
      .filter((animation) => !baseline.has(animation) && isTransition(animation))
      .map(describe);
    /* Every transition targeting the control this defect is about, whether the
       flip started it or merely retargeted one that was already running. */
    const onMountedPrimary = afterFlip
      .filter(
        (animation) =>
          isTransition(animation) &&
          animation.effect !== null &&
          mountedNodes.includes(animation.effect.target),
      )
      .map(describe);

    const mounted = mountedNodes.map(snapshot);
    const probeButton = buildProbe();
    const probeReading = snapshot(probeButton);
    probeButton.closest("#" + PROBE_HOST_ID).remove();
    setTone("dark");

    return {
      baselineAnimations: [...baseline].map(describe),
      startedByFlip,
      onMountedPrimary,
      mounted,
      probe: probeReading,
    };
  }

  return { settle, flipAndRead };
})();
`;
}

async function waitFor(window, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await evaluate(
      window,
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
    );
    if (found === true) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms while waiting for ${selector}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run(window, source) {
  await window.webContents.executeJavaScript(`${source}\n;void 0;`, true);
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(`(${expression})`, true);
}
