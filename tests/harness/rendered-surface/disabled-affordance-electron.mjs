/*
 * The Electron half of the disabled-affordance measurement (F215).
 *
 * F215 is a CASCADE outcome, not a string: `styles.css` `.btn[disabled]` and
 * `.btn.primary` carry equal specificity (0,2,0) so the later `.btn.primary`
 * wins the colour, the disabled rule never names a border, and the acrylic
 * legibility restoration returns the opacity to 1. Three independent rules had
 * to compose to produce it, and no assertion over stylesheet TEXT can reach
 * the result — which is why this driver reads a real document instead.
 *
 * It reports two independent kinds of fact per control:
 *
 *   1. RESOLVED STYLE. What the engine produced after `var()`, `color-mix()`
 *      and the whole cascade — the answer to "did the disabled rule arrive".
 *   2. COMPOSITED PIXELS. The ground and the glyph read out of the
 *      compositor's own output buffer, using the same two-capture separation
 *      `measure-electron.mjs` uses: a pixel is ground only if hiding the
 *      probe's ink left it bit-identical. That is the answer to "would a
 *      human, or a screenshot, see a difference" — and a cursor, which is the
 *      only difference F215 leaves, exists in neither.
 *
 * The window is never shown. Nothing here takes the owner's screen (F8/F17).
 *
 * Contract: reads a job JSON path from UAW_AFFORDANCE_JOB, writes one
 * `UAW_AFFORDANCE <json>` line to stdout, exits. Any failure is reported as
 * `UAW_AFFORDANCE_FAILURE <json>` with a non-zero exit code.
 */
import { readFile } from "node:fs/promises";

import { app, BrowserWindow } from "electron";

/* Identical to the measurement driver: a pixel that moved at all is ink. */
const INK_EPSILON = 0;
const driverStartedAt = Date.now();

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

void runDriver().catch((error) => {
  process.stderr.write(
    `UAW_AFFORDANCE_DRIVER_FAILURE ${JSON.stringify({
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
      await waitForStage("affordance job read", 5_000, () =>
        readFile(process.env.UAW_AFFORDANCE_JOB ?? "", "utf8"),
      ),
    );

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
    announceStage("hidden BrowserWindow created");

    await waitForStage("surface navigation", 30_000, () => window.loadURL(job.url));
    await waitFor(window, job.readySelector, 20_000, "ready selector");
    await waitForStage("probe installation", 10_000, () =>
      run(window, buildProbeProgram(job.controls)),
    );

    const rootDataset = await evaluate(
      window,
      "({ ...document.documentElement.dataset })",
    );

    const tones = [];
    for (const tone of job.tones) {
      tones.push(await measureTone(window, tone));
    }

    await waitForStage("affordance result write", 5_000, () =>
      emit("UAW_AFFORDANCE", {
        url: job.url,
        viewport: job.viewport,
        rootDataset,
        tones,
      }),
    );
    exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await waitForStage("affordance failure write", 2_000, () =>
        emit("UAW_AFFORDANCE_FAILURE", { message }),
      );
    } catch (emitError) {
      process.stderr.write(
        `UAW_AFFORDANCE_FAILURE_WRITE ${JSON.stringify({
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
          `UAW_AFFORDANCE_WINDOW_CLEANUP_FAILURE ${JSON.stringify({
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
 * One tone, measured end to end.
 *
 * `data-tone` is set and removed exactly as `mount.tsx applyWorkbenchAppearance`
 * sets and removes it, so neither tone is measured in a state the product
 * cannot actually be put into.
 */
async function measureTone(window, tone) {
  await waitForStage(`${tone} tone application`, 10_000, () =>
    evaluate(window, `globalThis.__uawAffordance.setTone(${JSON.stringify(tone)})`),
  );
  await waitForStage(`${tone} probe show`, 10_000, () =>
    evaluate(window, "globalThis.__uawAffordance.show()"),
  );
  const controls = await waitForStage(`${tone} resolved style read`, 10_000, () =>
    evaluate(window, "globalThis.__uawAffordance.read()"),
  );
  /* Read while the probe is mounted and in the same tone, so a mounted control
     and its probe twin can be compared without either being remembered. */
  const mountedPrimaryButtons = await waitForStage(
    `${tone} mounted primary read`,
    10_000,
    () => evaluate(window, "globalThis.__uawAffordance.readMounted()"),
  );
  const inked = await capture(window, `${tone} inked`);
  const hidden = await waitForStage(`${tone} ink hiding`, 10_000, () =>
    evaluate(window, "globalThis.__uawAffordance.hideInk()"),
  );
  if (hidden < controls.length) {
    throw new Error(
      `${tone}: ink-hiding pass marked ${hidden} nodes but ${controls.length} controls were read`,
    );
  }
  const plain = await capture(window, `${tone} plain`);
  await waitForStage(`${tone} ink restoration`, 10_000, () =>
    evaluate(window, "globalThis.__uawAffordance.restoreInk()"),
  );
  await waitForStage(`${tone} probe hide`, 10_000, () =>
    evaluate(window, "globalThis.__uawAffordance.hide()"),
  );

  return {
    tone,
    capture: { width: plain.width, height: plain.height },
    mountedPrimaryButtons,
    controls: controls.map((control) => ({
      ...control,
      painted: sampleControl(control, inked, plain),
    })),
  };
}

/**
 * Ground and glyph for one control, separated by the two captures.
 *
 * The `labelRect` box is where the string is, so its unchanged pixels are the
 * surface the string is painted on and its furthest-moved pixel is the
 * best-covered glyph. The `chromeRect` box is the button's own padding strip,
 * which carries no glyph by construction and is therefore the fill reading a
 * screenshot comparison rests on. `borderPoints` sit on the border box itself.
 */
function sampleControl(control, inked, plain) {
  const viewport = control.viewport;
  const label = classify(control.labelRect, viewport, inked, plain);
  const chrome = classify(control.chromeRect, viewport, inked, plain);
  return {
    fill: chrome.background,
    fillSpread: chrome.distinctBackgrounds,
    labelGround: label.background,
    paintedGlyph: label.paintedGlyph,
    inkedPixels: label.inkedPixels,
    comparedPixels: label.comparedPixels,
    border: control.borderPoints.map((point) => {
      const device = devicePoint(point, viewport, plain);
      const [red, green, blue, alpha] = pixelAt(plain, device.x, device.y);
      return { x: point.x, y: point.y, red, green, blue, alpha };
    }),
  };
}

function classify(box, viewport, inked, plain) {
  const counts = new Map();
  let inkedPixels = 0;
  let comparedPixels = 0;
  let bestDistance = -1;
  let paintedGlyph = null;

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
        }
        continue;
      }
      const key = `${background[0]},${background[1]},${background[2]},${background[3]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const ranked = [...counts]
    .map(([key, count]) => {
      const [red, green, blue, alpha] = key.split(",").map(Number);
      return { red, green, blue, alpha, count };
    })
    .sort((a, b) => b.count - a.count);

  return {
    comparedPixels,
    inkedPixels,
    distinctBackgrounds: ranked.length,
    background: ranked[0] ?? null,
    paintedGlyph:
      paintedGlyph === null
        ? null
        : {
            red: paintedGlyph[0],
            green: paintedGlyph[1],
            blue: paintedGlyph[2],
            alpha: paintedGlyph[3],
          },
  };
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
 * The in-page program, built around the caller's control list so the probe
 * renders the product's OWN class lists rather than a paraphrase of them.
 */
function buildProbeProgram(controls) {
  const controlsJson = JSON.stringify(controls);
  return [
    "globalThis.__uawAffordance = (() => {",
    `  const controls = ${controlsJson};`,
    "",
    "  function setTone(tone) {",
    "    const root = document.documentElement;",
    "    /* Exactly what mount.tsx applyWorkbenchAppearance does for this axis. */",
    '    if (tone === "light") root.setAttribute("data-tone", "light");',
    '    else root.removeAttribute("data-tone");',
    '    return root.getAttribute("data-tone");',
    "  }",
    "",
    "  function show() {",
    "    hide();",
    "    /* Anchored over the stage so the probe composites on the same painted",
    "       panel the real primary buttons sit on, and carries no ground of its",
    "       own — a container background would replace the very thing measured. */",
    '    const stage = document.querySelector("main.stage") ?? document.body;',
    "    const anchor = stage.getBoundingClientRect();",
    '    const host = document.createElement("div");',
    '    host.id = "uaw-affordance-probe";',
    "    host.style.cssText = [",
    '      "position:fixed",',
    '      "left:" + Math.round(anchor.left + 24) + "px",',
    '      "top:" + Math.round(anchor.top + 24) + "px",',
    '      "display:flex",',
    '      "flex-direction:column",',
    '      "align-items:flex-start",',
    '      "gap:14px",',
    '      "z-index:2147483000",',
    '      "background:none",',
    '      "border:0",',
    '      "margin:0",',
    '      "padding:0",',
    '    ].join(";");',
    "    for (const control of controls) {",
    '      const button = document.createElement("button");',
    '      button.type = "button";',
    "      button.className = control.classes;",
    "      button.dataset.uawProbe = control.id;",
    '      if (control.disabled) button.setAttribute("disabled", "");',
    '      const ink = document.createElement("span");',
    '      ink.className = "uaw-affordance-ink";',
    "      ink.textContent = control.label;",
    "      button.append(ink);",
    "      if (control.kbd) {",
    '        const kbd = document.createElement("kbd");',
    '        kbd.className = "uaw-affordance-ink";',
    "        kbd.textContent = control.kbd;",
    "        button.append(kbd);",
    "      }",
    "      host.append(button);",
    "    }",
    "    document.body.append(host);",
    "    return controls.length;",
    "  }",
    "",
    "  function hide() {",
    '    const existing = document.getElementById("uaw-affordance-probe");',
    "    if (existing !== null) existing.remove();",
    "    return true;",
    "  }",
    "",
    "  /* visibility:hidden removes the glyph and nothing else: the button keeps",
    "     its own fill, border and box, so the second capture differs from the",
    "     first at ink pixels only. */",
    "  function hideInk() {",
    "    let hidden = 0;",
    '    for (const node of document.querySelectorAll("#uaw-affordance-probe .uaw-affordance-ink")) {',
    '      node.style.visibility = "hidden";',
    "      hidden += 1;",
    "    }",
    "    return hidden;",
    "  }",
    "",
    "  function restoreInk() {",
    '    for (const node of document.querySelectorAll("#uaw-affordance-probe .uaw-affordance-ink")) {',
    '      node.style.visibility = "";',
    "    }",
    "    return true;",
    "  }",
    "",
    "  function read() {",
    "    const viewport = { width: window.innerWidth, height: window.innerHeight };",
    "    const readings = [];",
    "    for (const control of controls) {",
    "      const button = document.querySelector(",
    '        \'#uaw-affordance-probe [data-uaw-probe="\' + control.id + \'"]\',',
    "      );",
    '      if (button === null) throw new Error("probe control missing: " + control.id);',
    "      const style = getComputedStyle(button);",
    "      const rect = button.getBoundingClientRect();",
    '      const ink = button.querySelector(".uaw-affordance-ink");',
    "      const inkRect = ink.getBoundingClientRect();",
    "      readings.push({",
    "        id: control.id,",
    "        classes: control.classes,",
    "        disabled: button.disabled === true,",
    "        color: style.color,",
    "        backgroundColor: style.backgroundColor,",
    "        borderTopColor: style.borderTopColor,",
    "        borderRightColor: style.borderRightColor,",
    "        borderBottomColor: style.borderBottomColor,",
    "        borderLeftColor: style.borderLeftColor,",
    "        borderTopWidth: style.borderTopWidth,",
    "        opacity: style.opacity,",
    "        cursor: style.cursor,",
    "        filter: style.filter,",
    "        fontSizePx: Number.parseFloat(style.fontSize),",
    "        fontWeight: style.fontWeight,",
    "        viewport,",
    "        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },",
    "        /* The label box, where the ink is. */",
    "        labelRect: {",
    "          top: inkRect.top,",
    "          left: inkRect.left,",
    "          width: inkRect.width,",
    "          height: inkRect.height,",
    "        },",
    "        /* A glyph-free strip of the button's own fill: inside the border and",
    "           left of the label. `.btn` carries 12px of horizontal padding. */",
    "        chromeRect: {",
    "          top: rect.top + 3,",
    "          left: rect.left + 2,",
    "          width: Math.max(2, inkRect.left - rect.left - 3),",
    "          height: Math.max(2, rect.height - 6),",
    "        },",
    "        /* The border box itself. Floored, because the device mapping",
    "           rounds, and rect.top + 0.5 would round INTO the fill — reporting",
    "           the fill twice under the name of two different channels. */",
    "        borderPoints: [",
    "          { x: Math.floor(rect.left + rect.width / 2), y: Math.floor(rect.top) },",
    "          {",
    "            x: Math.floor(rect.left + rect.width / 2),",
    "            y: Math.floor(rect.top + rect.height) - 1,",
    "          },",
    "        ],",
    "      });",
    "    }",
    "    return readings;",
    "  }",
    "",
    "",
    "  /* The primary buttons the PRODUCT mounted, not the ones the probe built.",
    "     Reported so a reader can check the probe against a real control rather",
    "     than take on trust that a synthesized class list behaves like one. */",
    "  function readMounted() {",
    '    const mounted = [...document.querySelectorAll(".btn.primary")].filter(',
    '      (node) => node.closest("#uaw-affordance-probe") === null,',
    "    );",
    "    return mounted.map((node) => {",
    "      const style = getComputedStyle(node);",
    "      return {",
    "        classes: node.className,",
    '        text: (node.textContent ?? "").trim().slice(0, 60),',
    "        disabled: node.disabled === true,",
    "        color: style.color,",
    "        backgroundColor: style.backgroundColor,",
    "        borderTopColor: style.borderTopColor,",
    "        opacity: style.opacity,",
    "        cursor: style.cursor,",
    "      };",
    "    });",
    "  }",
    "",
    "  return { setTone, show, hide, hideInk, restoreInk, read, readMounted };",
    "})();",
  ].join("\n");
}

/*
 * Classification rests on bit-identical pixel comparison, so its input must
 * itself be bit-stable: a single capture can race a still-landing repaint and
 * hand the classifier a frame in which every compared pixel has moved (hosted
 * runner 2026-09-01, run 33510494560: plain-disabled recovered no glyph-free
 * ground pixel exactly that way). Capture until two consecutive frames agree
 * byte for byte; a page that never settles is a loud failure, not a reading.
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
      return { width: size.width, height: size.height, bitmap };
    }
    previous = { width: size.width, height: size.height, bitmap };
  }
  throw new Error(`${stage}: no two consecutive captures agreed byte for byte`);
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
    if (deadline - Date.now() <= 0) {
      throw new Error(`timed out after ${timeoutMs} ms while waiting for ${stage}: ${selector}`);
    }
    await waitForStage(`${stage} compositor settle`, 5_000, () => settle(window, 100));
  }
}

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

async function run(window, source) {
  await window.webContents.executeJavaScript(`${source}\n;void 0;`, true);
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(`(${expression})`, true);
}

function announceStage(stage) {
  process.stderr.write(
    `UAW_AFFORDANCE_STAGE ${JSON.stringify({
      pid: process.pid,
      elapsedMs: Date.now() - driverStartedAt,
      stage,
    })}\n`,
  );
}

async function waitForStage(stage, timeoutMs, operation) {
  announceStage(stage);
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
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
