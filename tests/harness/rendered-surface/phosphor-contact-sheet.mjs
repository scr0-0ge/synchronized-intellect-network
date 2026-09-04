/*
 * Worker 406 owner-facing contact sheets.
 *
 * Launched only by `phosphor-contact-sheet.ts`, which owns the disposable
 * userData/staging directory and waits for this Electron child to exit.
 *
 * The script only reads already sealed evidence PNGs and publishes three new
 * fail-if-present PNGs. It uses a hidden, software-rendered Chromium window and
 * a disposable userData directory; it never captures the owner's screen.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow } from "electron";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const evidenceDirectory = join(
  repositoryRoot,
  ".scratch",
  "unified-ai-workbench",
  "evidence",
);
const contactStage = resolve(process.env.UAW_CONTACT_STAGE ?? "");
assert.match(
  basename(contactStage),
  /^uaw-worker-406-contact-sheet-[A-Za-z0-9_-]+$/u,
  "contact-sheet stage identity is invalid",
);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

const stateRows = Object.freeze([
  Object.freeze({ key: "light-normal-green", label: "Normal · Green" }),
  Object.freeze({ key: "light-normal-amber", label: "Normal · Amber" }),
  Object.freeze({ key: "light-fullscreen-green", label: "Full CRT · Green" }),
  Object.freeze({ key: "light-fullscreen-amber", label: "Full CRT · Amber" }),
]);
const darkRows = Object.freeze([
  Object.freeze({ key: "dark-normal-green", label: "Normal · Green" }),
  Object.freeze({ key: "dark-normal-amber", label: "Normal · Amber" }),
  Object.freeze({ key: "dark-fullscreen-green", label: "Full CRT · Green" }),
  Object.freeze({ key: "dark-fullscreen-amber", label: "Full CRT · Amber" }),
]);

const sheets = Object.freeze([
  Object.freeze({
    output: "worker-406-phosphor-light-before-after.png",
    title: "Light Phosphor · before / recommended B after",
    subtitle: "Real product component tree + product CSS · 1440×1000 source captures",
    columns: Object.freeze([
      Object.freeze({ label: "BEFORE · muted", prefix: "before" }),
      Object.freeze({ label: "AFTER · recommended B", prefix: "after" }),
    ]),
    rows: stateRows,
    width: 1200,
    cardWidth: 520,
  }),
  Object.freeze({
    output: "worker-406-phosphor-dark-before-after.png",
    title: "Dark Phosphor · byte-identical before / after",
    subtitle: "All four PNG pairs have identical SHA-256 values",
    columns: Object.freeze([
      Object.freeze({ label: "BEFORE", prefix: "before" }),
      Object.freeze({ label: "AFTER", prefix: "after" }),
    ]),
    rows: darkRows,
    width: 1200,
    cardWidth: 520,
    verifyByteIdenticalPairs: true,
  }),
  Object.freeze({
    output: "worker-406-phosphor-light-candidates.png",
    title: "Light Phosphor · rendered brightness candidates",
    subtitle: "A restrained · B recommended/current · C hot",
    columns: Object.freeze([
      Object.freeze({ label: "A · restrained", prefix: "candidate-a" }),
      Object.freeze({ label: "B · recommended", prefix: "candidate-b" }),
      Object.freeze({ label: "C · hot", prefix: "candidate-c" }),
    ]),
    rows: stateRows,
    width: 1360,
    cardWidth: 400,
  }),
]);

let window;
void app.whenReady().then(async () => {
  let failed = false;
  const promoted = [];
  try {
    const published = [];
    const pending = [];
    for (const sheet of sheets) {
      await assertMissing(join(evidenceDirectory, sheet.output));
    }
    for (const sheet of sheets) {
      const outputPath = join(evidenceDirectory, sheet.output);
      const images = await Promise.all(
        sheet.rows.flatMap((row) =>
          sheet.columns.map(async (column) => {
            const file = `worker-406-phosphor-${column.prefix}-phosphor-${row.key}.png`;
            const path = join(evidenceDirectory, file);
            assert.equal(
              (await stat(path)).isFile(),
              true,
              `${file} is not a regular file`,
            );
            const bytes = await readFile(path);
            return Object.freeze({
              column: column.label,
              row: row.label,
              file,
              src: pathToFileURL(path).href,
              bytes: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            });
          }),
        ),
      );
      if (sheet.verifyByteIdenticalPairs === true) {
        for (const row of sheet.rows) {
          const pair = images.filter((image) => image.row === row.label);
          assert.equal(pair.length, 2, `${row.label}: expected one before/after pair`);
          assert.deepEqual(
            { bytes: pair[0].bytes, sha256: pair[0].sha256 },
            { bytes: pair[1].bytes, sha256: pair[1].sha256 },
            `${row.label}: dark before/after PNGs are not byte-identical`,
          );
        }
      }
      if (window === undefined) {
        window = new BrowserWindow({
          width: sheet.width,
          height: 900,
          show: false,
          useContentSize: true,
          paintWhenInitiallyHidden: true,
          backgroundColor: "#080b10",
          webPreferences: { backgroundThrottling: false },
        });
      } else {
        window.setContentSize(sheet.width, 900);
      }
      const htmlPath = join(
        contactStage,
        sheet.output.replace(/\.png$/u, ".html"),
      );
      await writeFile(htmlPath, html(sheet, images), {
        encoding: "utf8",
        flag: "wx",
      });
      await window.loadFile(htmlPath);
      await window.webContents.executeJavaScript(
        "Promise.all([...document.images].map((image) => image.decode()))",
      );
      const required = await window.webContents.executeJavaScript(
        "({ width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) })",
      );
      assert.ok(
        required.width <= sheet.width,
        `${sheet.output}: document is ${required.width}px wide in a ${sheet.width}px sheet`,
      );
      window.setContentSize(sheet.width, required.height);
      const fitted = await window.webContents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }))))",
      );
      assert.equal(fitted.innerWidth, sheet.width, `${sheet.output}: content width drifted`);
      assert.ok(
        fitted.scrollWidth <= fitted.innerWidth && fitted.scrollHeight <= fitted.innerHeight,
        `${sheet.output}: contact sheet still overflows its capture viewport`,
      );
      const png = (await window.capturePage()).toPNG();
      const stagedPath = join(contactStage, sheet.output);
      await writeFile(stagedPath, png, { flag: "wx" });
      pending.push(Object.freeze({ stagedPath, outputPath }));
      published.push(Object.freeze({
        file: basename(outputPath),
        bytes: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
      }));
    }
    for (const item of pending) {
      await copyFile(item.stagedPath, item.outputPath, fsConstants.COPYFILE_EXCL);
      promoted.push(item.outputPath);
    }
    process.stdout.write(`PHOSPHOR_CONTACT_SHEETS ${JSON.stringify(published)}\n`);
  } catch (error) {
    const rollbackFailures = [];
    for (const path of promoted.reverse()) {
      try {
        await rm(path, { force: false });
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    const failure = rollbackFailures.length === 0
      ? error
      : new AggregateError(
        [error, ...rollbackFailures],
        "contact-sheet publication and rollback both failed",
      );
    process.stderr.write(`PHOSPHOR_CONTACT_SHEET_FAILURE ${String(failure)}\n`);
    failed = true;
  } finally {
    if (window !== undefined && !window.isDestroyed()) window.destroy();
    app.exit(failed ? 1 : 0);
  }
});

function html(sheet, images) {
  const cells = sheet.rows.flatMap((row) =>
    sheet.columns.map((column) => {
      const image = images.find(
        (candidate) => candidate.row === row.label && candidate.column === column.label,
      );
      assert.ok(image, `${row.label} / ${column.label} is missing`);
      return `<figure><figcaption>${escapeHtml(row.label)}</figcaption><img alt="${escapeHtml(
        `${row.label} ${column.label}`,
      )}" src="${escapeHtml(image.src)}"><small>${escapeHtml(
        image.file,
      )}</small></figure>`;
    }),
  ).join("");
  const headers = sheet.columns.map((column) =>
    `<div class="column">${escapeHtml(column.label)}</div>`
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; min-height: 100%; background: #080b10; color: #e9f1ff; }
    body { padding: 24px 36px 30px; font: 15px/1.35 "Segoe UI", sans-serif; }
    h1 { margin: 0; font-size: 27px; letter-spacing: .01em; }
    p { margin: 5px 0 18px; color: #9cabc1; }
    .headers, main { display: grid; grid-template-columns: repeat(${sheet.columns.length}, ${sheet.cardWidth}px); gap: 18px; justify-content: center; }
    .headers { margin-bottom: 10px; }
    .column { color: #80bfff; font-size: 16px; font-weight: 700; letter-spacing: .05em; text-align: center; }
    main { row-gap: 18px; }
    figure { margin: 0; padding: 10px; border: 1px solid #27364b; border-radius: 8px; background: #111823; overflow: hidden; }
    figcaption { margin: 0 0 7px; color: #d5dfef; font-weight: 650; }
    img { display: block; width: 100%; height: auto; border: 1px solid #33445c; background: #fff; }
    small { display: block; margin-top: 6px; color: #71839e; font: 10px/1.2 ui-monospace, monospace; white-space: nowrap; }
  </style></head><body><h1>${escapeHtml(sheet.title)}</h1><p>${escapeHtml(
    sheet.subtitle,
  )}</p><div class="headers">${headers}</div><main>${cells}</main></body></html>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function assertMissing(path) {
  try {
    await stat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`evidence already exists: ${basename(path)}`);
}
