import type { BrowserWindowBoundary } from "./project-view-ipc.ts";

export interface WorkbenchProjectSaveTargetChooser {
  chooseProjectTarget(): Promise<unknown>;
}

export interface WorkbenchProjectSaveTargetOptions {
  readonly title: "Create Project";
  readonly buttonLabel: "Create Project";
  readonly properties: readonly ["dontAddToRecent"];
}

export type WorkbenchProjectShowSaveDialog = (
  window: BrowserWindowBoundary,
  options: WorkbenchProjectSaveTargetOptions,
) => Promise<unknown>;

const fixedCreateProjectOptions: WorkbenchProjectSaveTargetOptions =
  Object.freeze({
    title: "Create Project",
    buttonLabel: "Create Project",
    properties: Object.freeze(["dontAddToRecent"] as const),
  });

export function createWorkbenchProjectSaveTargetChooser(
  window: BrowserWindowBoundary,
  showSaveDialog: WorkbenchProjectShowSaveDialog,
): WorkbenchProjectSaveTargetChooser {
  return Object.freeze({
    chooseProjectTarget() {
      return showSaveDialog(window, fixedCreateProjectOptions);
    },
  });
}
