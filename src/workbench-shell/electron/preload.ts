import { contextBridge, ipcRenderer, webUtils } from "electron";

import { createWorkbenchFilesPreloadBridge } from "../file-drop-bridge.ts";
import { createWorkbenchPreloadBridge } from "../preload-bridge.ts";
import { createWorkbenchWindowControlPreloadBridge } from "../window-control-bridge.ts";

const bridge = createWorkbenchPreloadBridge(ipcRenderer);
const windowBridge = createWorkbenchWindowControlPreloadBridge(ipcRenderer);
const filesBridge = createWorkbenchFilesPreloadBridge(webUtils);

contextBridge.exposeInMainWorld("workbench", bridge);
contextBridge.exposeInMainWorld("workbenchWindow", windowBridge);
contextBridge.exposeInMainWorld("workbenchFiles", filesBridge);
