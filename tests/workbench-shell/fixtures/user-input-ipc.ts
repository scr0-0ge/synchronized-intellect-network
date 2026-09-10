import { EventEmitter } from "node:events";
import { installWorkbenchProjectViewIpc, type ProjectViewSource } from "../../../src/workbench-shell/electron/project-view-ipc.ts";
import { createWorkbenchPreloadBridge } from "../../../src/workbench-shell/preload-bridge.ts";

/** Only Electron's process boundary is fake; main handlers and preload reconstruction are real. */
export function questionIpc(source: ProjectViewSource) {
  const mainEvents = new EventEmitter();
  const rendererEvents = new EventEmitter();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, value: unknown) => { rendererEvents.emit(channel, {}, structuredClone(value)); },
  });
  const window = Object.assign(new EventEmitter(), { webContents: sender });
  const main = Object.assign(mainEvents, {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  });
  const binding = installWorkbenchProjectViewIpc({ ipcMain: main, window, source });
  const invoke = async (channel: string, owner: unknown, ...values: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("missing IPC handler");
    return structuredClone(await handler({ sender: owner }, ...structuredClone(values)));
  };
  const bridge = createWorkbenchPreloadBridge({
    on: (channel, listener) => { rendererEvents.on(channel, listener); },
    removeListener: (channel, listener) => { rendererEvents.removeListener(channel, listener); },
    send: channel => { mainEvents.emit(channel, { sender }); },
    invoke: (channel, ...values) => invoke(channel, sender, ...values),
  });
  // The product mounts one project observation before its Stage is available.
  const disposeProject = bridge.observeProject(() => undefined);
  return { bridge, sender, handlers, invoke,
    dispose: () => { disposeProject(); binding.dispose(); rendererEvents.removeAllListeners(); } };
}
