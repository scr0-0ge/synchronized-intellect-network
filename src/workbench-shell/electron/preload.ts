import { contextBridge, ipcRenderer } from "electron";

import { createWorkbenchPreloadBridge } from "../preload-bridge.ts";
import { createWorkbenchWindowControlPreloadBridge } from "../window-control-bridge.ts";

const bridge = createWorkbenchPreloadBridge(ipcRenderer);
const windowBridge = createWorkbenchWindowControlPreloadBridge(ipcRenderer);

contextBridge.exposeInMainWorld("workbench", bridge);
contextBridge.exposeInMainWorld("workbenchWindow", windowBridge);
