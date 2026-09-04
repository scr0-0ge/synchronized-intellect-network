"use strict";

const { app, nativeImage, Tray } = require("electron");

const resultMarker = "TRAY_ICON_NATIVE_RESULT ";

function readTrayIconDataUrl() {
  const prefix = "--tray-icon-data-url=";
  const values = process.argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error("tray-icon-native-data-url-invalid");
  }
  return values[0];
}

function emitResult(result) {
  console.log(`${resultMarker}${JSON.stringify(result)}`);
}

async function run() {
  await app.whenReady();
  const dataUrl = readTrayIconDataUrl();
  const image = nativeImage.createFromDataURL(dataUrl);
  const nativeImageEmpty = image.isEmpty();
  const nativeImageSize = image.getSize();
  const pngBytes = image.toPNG().byteLength;
  let tray = null;
  let trayConstructed = false;
  let trayErrorCategory = null;

  try {
    tray = new Tray(image);
    trayConstructed = true;
  } catch {
    trayErrorCategory = "tray-construction-failed";
  } finally {
    tray?.destroy();
  }

  const passed = !nativeImageEmpty && trayConstructed;
  emitResult({
    schema: "workbench-tray-icon-native-v1",
    category: passed
      ? "native-tray-icon-available"
      : "native-tray-icon-unavailable",
    nativeImageEmpty,
    nativeImageSize,
    pngBytes,
    trayConstructed,
    trayErrorCategory,
    passed,
  });
  process.exitCode = passed ? 0 : 1;
  app.quit();
}

run().catch(() => {
  emitResult({
    schema: "workbench-tray-icon-native-v1",
    category: "native-fixture-failed",
    topLevelFailure: true,
    passed: false,
  });
  process.exitCode = 2;
  app.quit();
});
