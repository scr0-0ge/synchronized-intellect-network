import type { WorkbenchFilesRendererBridge } from "../file-drop-bridge.ts";
import type { WorkbenchPreloadBridge } from "../preload-bridge.ts";
import type { WorkbenchWindowRendererBridge } from "../window-control-bridge.ts";

declare global {
  interface Window {
    readonly workbench: WorkbenchPreloadBridge;
    readonly workbenchWindow: WorkbenchWindowRendererBridge;
    readonly workbenchFiles?: WorkbenchFilesRendererBridge;
  }
}

export {};
