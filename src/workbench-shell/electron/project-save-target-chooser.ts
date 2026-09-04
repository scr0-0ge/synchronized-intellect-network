import { dialog, type BrowserWindow } from "electron";

import type { BrowserWindowBoundary } from "./project-view-ipc.ts";
import {
  createWorkbenchProjectSaveTargetChooser,
  type WorkbenchProjectSaveTargetChooser,
} from "./project-save-target-chooser-boundary.ts";

export type { WorkbenchProjectSaveTargetChooser } from "./project-save-target-chooser-boundary.ts";

export function createElectronProjectSaveTargetChooser(
  window: BrowserWindowBoundary,
): WorkbenchProjectSaveTargetChooser {
  return createWorkbenchProjectSaveTargetChooser(
    window,
    (owningWindow, options) =>
      dialog.showSaveDialog(owningWindow as BrowserWindow, {
        title: options.title,
        buttonLabel: options.buttonLabel,
        properties: [...options.properties],
      }),
  );
}
