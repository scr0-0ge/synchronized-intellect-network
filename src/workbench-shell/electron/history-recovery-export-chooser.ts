import { dialog, type BrowserWindow } from "electron";

import type { HistoryRecoveryExportChooser } from "../history-recovery.ts";
import type { BrowserWindowBoundary } from "./project-view-ipc.ts";

export function createElectronHistoryRecoveryExportChooser(
  window: BrowserWindowBoundary,
): HistoryRecoveryExportChooser {
  return Object.freeze({
    async choose(options: {
      readonly suggestedName: string;
      readonly warning: "The exported copy may contain conversation history and private local metadata.";
    }) {
      const result = await dialog.showSaveDialog(window as BrowserWindow, {
        title: "Export exact historical recovery copy",
        message: options.warning,
        buttonLabel: "Export exact copy",
        defaultPath: options.suggestedName,
        filters: [
          Object.freeze({
            name: "Workbench historical recovery copy",
            extensions: ["uawr-history"],
          }),
        ],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      return result.canceled || typeof result.filePath !== "string"
        ? null
        : Object.freeze({ targetPath: result.filePath });
    },
  });
}
