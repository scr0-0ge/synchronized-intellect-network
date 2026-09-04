import { dialog, type BrowserWindow } from "electron";

import type {
  BrowserWindowBoundary,
  ProjectDirectoryChooser,
} from "./project-view-ipc.ts";

export function createElectronProjectDirectoryChooser(): ProjectDirectoryChooser {
  return Object.freeze({
    chooseProjectDirectory(window: BrowserWindowBoundary) {
      return dialog.showOpenDialog(window as BrowserWindow, {
        title: "Open Project",
        buttonLabel: "Open Project",
        properties: ["openDirectory"],
      });
    },
  });
}
