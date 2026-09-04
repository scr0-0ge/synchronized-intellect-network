import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createWorkbenchTrayIcon,
  workbenchTrayIconDataUrl,
  workbenchTrayMark,
  workbenchTrayMarkSvg,
} from "../../src/workbench-shell/electron/tray-icon.ts";

test("tray icon is an embedded native-compatible raster of the locked .mark tokens", () => {
  let observedDataUrl = "";
  const icon = {
    isEmpty: () => false,
  };

  assert.equal(
    createWorkbenchTrayIcon({
      createFromDataURL(dataUrl) {
        observedDataUrl = dataUrl;
        return icon;
      },
    }),
    icon,
  );

  assert.deepEqual(workbenchTrayMark, {
    glyph: "U",
    gradientAngleDegrees: 150,
    codexColor: "#22d3ff",
    claudeColor: "#ff9a3c",
    radius: 7,
    size: 18,
    textColor: "#0a0a0b",
    fontSize: 11,
    fontWeight: 800,
  });
  assert.equal(observedDataUrl, workbenchTrayIconDataUrl);
  assert.match(observedDataUrl, /^data:image\/png;base64,/u);
  const png = Buffer.from(observedDataUrl.split(",", 2)[1]!, "base64");
  assert.equal(png.byteLength, 699);
  assert.equal(
    createHash("sha256").update(png).digest("hex"),
    "2734a5f2effba804fa081231fd6c26df9d5ad26f848bdf774640daf6773a37a5",
  );
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 18);
  assert.equal(png.readUInt32BE(20), 18);

  assert.match(workbenchTrayMarkSvg, /viewBox="0 0 18 18"/u);
  assert.match(workbenchTrayMarkSvg, /data-css-angle="150deg"/u);
  assert.match(workbenchTrayMarkSvg, /stop-color="#22d3ff"/u);
  assert.match(workbenchTrayMarkSvg, /stop-color="#ff9a3c"/u);
  assert.match(workbenchTrayMarkSvg, /<rect width="18" height="18" rx="7"/u);
  assert.match(
    workbenchTrayMarkSvg,
    /<text[^>]+fill="#0a0a0b"[^>]+font-size="11"[^>]+font-weight="800"[^>]*>U<\/text>/u,
  );
});

test("tray icon rejects an empty nativeImage at the narrow production boundary", () => {
  assert.throws(
    () =>
      createWorkbenchTrayIcon({
        createFromDataURL() {
          return { isEmpty: () => true };
        },
      }),
    /workbench-tray-icon-unavailable/u,
  );
});
