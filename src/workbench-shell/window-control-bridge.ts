export const WORKBENCH_WINDOW_ACTION_CHANNEL = "workbench:window-action";
export const WORKBENCH_WINDOW_OBSERVE_CHANNEL = "workbench:window-observe";
export const WORKBENCH_WINDOW_DISPOSE_CHANNEL = "workbench:window-dispose";
export const WORKBENCH_WINDOW_STATE_CHANNEL = "workbench:window-state";

type WorkbenchWindowAction = "minimize" | "toggle-maximize" | "close";
type WindowStateListener = (
  event: unknown,
  value: unknown,
) => void;
type MainWindowListener = (
  event: unknown,
  ...values: readonly unknown[]
) => void;

export type WorkbenchWindowState = Readonly<{ maximized: boolean }>;

export interface WorkbenchWindowRendererBridge {
  observeState(listener: (state: WorkbenchWindowState) => void): () => void;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

export interface FixedWindowControlRendererIpc {
  on(
    channel: typeof WORKBENCH_WINDOW_STATE_CHANNEL,
    listener: WindowStateListener,
  ): void;
  removeListener(
    channel: typeof WORKBENCH_WINDOW_STATE_CHANNEL,
    listener: WindowStateListener,
  ): void;
  send(
    channel:
      | typeof WORKBENCH_WINDOW_ACTION_CHANNEL
      | typeof WORKBENCH_WINDOW_OBSERVE_CHANNEL
      | typeof WORKBENCH_WINDOW_DISPOSE_CHANNEL,
    ...values: readonly unknown[]
  ): void;
}

export interface WorkbenchWindowControlIpcMain {
  on(
    channel:
      | typeof WORKBENCH_WINDOW_ACTION_CHANNEL
      | typeof WORKBENCH_WINDOW_OBSERVE_CHANNEL
      | typeof WORKBENCH_WINDOW_DISPOSE_CHANNEL,
    listener: MainWindowListener,
  ): void;
  removeListener(
    channel:
      | typeof WORKBENCH_WINDOW_ACTION_CHANNEL
      | typeof WORKBENCH_WINDOW_OBSERVE_CHANNEL
      | typeof WORKBENCH_WINDOW_DISPOSE_CHANNEL,
    listener: MainWindowListener,
  ): void;
}

export interface WorkbenchWindowBoundary {
  readonly webContents: Readonly<{
    send(channel: typeof WORKBENCH_WINDOW_STATE_CHANNEL, value: unknown): void;
  }>;
  on(
    event: "maximize" | "unmaximize" | "closed",
    listener: () => void,
  ): void;
  removeListener(
    event: "maximize" | "unmaximize" | "closed",
    listener: () => void,
  ): void;
  isMaximized(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
}

export type WorkbenchWindowControlIpcBinding = Readonly<{
  dispose(): void;
}>;

export function createWorkbenchWindowControlPreloadBridge(
  ipc: FixedWindowControlRendererIpc,
): WorkbenchWindowRendererBridge {
  let activeDispose: (() => void) | undefined;
  const sendAction = (action: WorkbenchWindowAction): void => {
    ipc.send(WORKBENCH_WINDOW_ACTION_CHANNEL, action);
  };
  return Object.freeze({
    observeState(listener: (state: WorkbenchWindowState) => void): () => void {
      activeDispose?.();
      let active = true;
      const handler: WindowStateListener = (_event, value) => {
        if (!active) return;
        const state = reconstructWindowState(value);
        if (state !== undefined) listener(state);
      };
      ipc.on(WORKBENCH_WINDOW_STATE_CHANNEL, handler);
      ipc.send(WORKBENCH_WINDOW_OBSERVE_CHANNEL);
      const dispose = (): void => {
        if (!active) return;
        active = false;
        ipc.removeListener(WORKBENCH_WINDOW_STATE_CHANNEL, handler);
        ipc.send(WORKBENCH_WINDOW_DISPOSE_CHANNEL);
        if (activeDispose === dispose) activeDispose = undefined;
      };
      activeDispose = dispose;
      return dispose;
    },
    minimize(): void {
      sendAction("minimize");
    },
    toggleMaximize(): void {
      sendAction("toggle-maximize");
    },
    close(): void {
      sendAction("close");
    },
  });
}

export function installWorkbenchWindowControlIpc(options: {
  readonly ipcMain: WorkbenchWindowControlIpcMain;
  readonly window: WorkbenchWindowBoundary;
}): WorkbenchWindowControlIpcBinding {
  let disposed = false;
  let observing = false;
  const isOwner = (event: unknown): boolean =>
    typeof event === "object" &&
    event !== null &&
    Reflect.get(event, "sender") === options.window.webContents;
  const publishState = (): void => {
    if (!observing || disposed) return;
    try {
      options.window.webContents.send(
        WORKBENCH_WINDOW_STATE_CHANNEL,
        Object.freeze({ maximized: options.window.isMaximized() }),
      );
    } catch {
      observing = false;
    }
  };
  const onAction: MainWindowListener = (event, ...values) => {
    if (!isOwner(event) || values.length !== 1) return;
    switch (values[0]) {
      case "minimize":
        options.window.minimize();
        return;
      case "toggle-maximize":
        if (options.window.isMaximized()) options.window.unmaximize();
        else options.window.maximize();
        return;
      case "close":
        options.window.close();
        return;
    }
  };
  const onObserve: MainWindowListener = (event, ...values) => {
    if (!isOwner(event) || values.length !== 0) return;
    observing = true;
    publishState();
  };
  const onRendererDispose: MainWindowListener = (event, ...values) => {
    if (!isOwner(event) || values.length !== 0) return;
    observing = false;
  };
  const onWindowStateChanged = (): void => publishState();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observing = false;
    options.ipcMain.removeListener(WORKBENCH_WINDOW_ACTION_CHANNEL, onAction);
    options.ipcMain.removeListener(
      WORKBENCH_WINDOW_OBSERVE_CHANNEL,
      onObserve,
    );
    options.ipcMain.removeListener(
      WORKBENCH_WINDOW_DISPOSE_CHANNEL,
      onRendererDispose,
    );
    options.window.removeListener("maximize", onWindowStateChanged);
    options.window.removeListener("unmaximize", onWindowStateChanged);
    options.window.removeListener("closed", dispose);
  };

  options.ipcMain.on(WORKBENCH_WINDOW_ACTION_CHANNEL, onAction);
  options.ipcMain.on(WORKBENCH_WINDOW_OBSERVE_CHANNEL, onObserve);
  options.ipcMain.on(WORKBENCH_WINDOW_DISPOSE_CHANNEL, onRendererDispose);
  options.window.on("maximize", onWindowStateChanged);
  options.window.on("unmaximize", onWindowStateChanged);
  options.window.on("closed", dispose);
  return Object.freeze({ dispose });
}

function reconstructWindowState(
  value: unknown,
): WorkbenchWindowState | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    Object.keys(value)[0] !== "maximized"
  ) {
    return undefined;
  }
  const maximized = Reflect.get(value, "maximized");
  return typeof maximized === "boolean"
    ? Object.freeze({ maximized })
    : undefined;
}
