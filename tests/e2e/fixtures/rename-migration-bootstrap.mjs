// Only used by rename-migration.ts: synthetic paths, no native dialogs or network.
import { app, dialog } from "electron";
import { pathToFileURL } from "node:url";

app.setPath("appData", process.env.W69_APP_DATA);
globalThis.renameNotices = [];
dialog.showMessageBox = async (...args) => {
  globalThis.renameNotices.push(args.at(-1));
  return { response: 0, checkboxChecked: false };
};
globalThis.fetch = async () => { throw new Error("w69-network-disabled"); };
if (process.env.W69_SEED_ONLY === "1") {
  app.setName(process.env.W69_SEED_NAME ?? "unified-agent-workbench");
} else {
  void import(pathToFileURL(process.env.W69_MAIN).href);
}
