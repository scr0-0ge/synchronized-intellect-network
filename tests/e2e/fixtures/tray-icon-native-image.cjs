"use strict";

const { app, nativeImage, Tray } = require("electron");

const resultMarker = "TRAY_ICON_NATIVE_RESULT ";

function readTrayIconPath() {
  const prefix = "--tray-icon-path=";
  const values = process.argv
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error("tray-icon-native-path-invalid");
  }
  return values[0];
}

function emitResult(result) {
  console.log(`${resultMarker}${JSON.stringify(result)}`);
}

async function run() {
  await app.whenReady();
  const iconPath = readTrayIconPath();
  const image = nativeImage.createFromPath(iconPath);
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
