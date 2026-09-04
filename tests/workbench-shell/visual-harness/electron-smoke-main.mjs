import { app, BrowserWindow } from "electron";

const url = process.env.UAW_QA_URL;
if (typeof url !== "string" || url.length === 0) {
  throw new Error("UAW_QA_URL is required");
}

const userDataDirectory = process.env.UAW_QA_USER_DATA_DIR;
if (typeof userDataDirectory === "string" && userDataDirectory.length > 0) {
  app.setPath("userData", userDataDirectory);
}

app.commandLine.appendSwitch("disable-gpu");

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: Number(process.env.UAW_QA_WIDTH ?? "1280"),
    height: Number(process.env.UAW_QA_HEIGHT ?? "820"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  await window.loadURL(url);
});

app.on("window-all-closed", () => app.quit());
