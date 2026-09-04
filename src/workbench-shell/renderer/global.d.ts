import type { WorkbenchRendererBridge } from "../contract.ts";
import type { WorkbenchWindowRendererBridge } from "../window-control-bridge.ts";

declare global {
  interface Window {
    readonly workbench: WorkbenchRendererBridge;
    readonly workbenchWindow: WorkbenchWindowRendererBridge;
  }
}

export {};
