import {
  WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  publicClaudePermissionHandlingLoaded,
  publicClaudePermissionHandlingSaved,
  publicClaudePermissionHandlingUnavailable,
  type WorkbenchClaudePermissionHandling,
} from "../contract.ts";
import { reconstructWorkbenchClaudePermissionHandling } from "../result-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface ClaudePermissionHandlingRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface ClaudePermissionHandlingBrowserWindowBoundary {
  readonly webContents: ClaudePermissionHandlingRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface ClaudePermissionHandlingIpcMainBoundary {
  handle(
    channel:
      | typeof WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL
      | typeof WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(
    channel:
      | typeof WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL
      | typeof WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  ): void;
}

export interface WorkbenchClaudePermissionHandlingSource {
  readClaudePermissionHandling(): Promise<WorkbenchClaudePermissionHandling>;
  saveClaudePermissionHandling(
    permissionHandling: WorkbenchClaudePermissionHandling,
  ): Promise<WorkbenchClaudePermissionHandling>;
}

export interface WorkbenchClaudePermissionHandlingIpcBinding {
  dispose(): void;
}

export function installWorkbenchClaudePermissionHandlingIpc(options: {
  readonly ipcMain: ClaudePermissionHandlingIpcMainBoundary;
  readonly window: ClaudePermissionHandlingBrowserWindowBoundary;
  readonly source: WorkbenchClaudePermissionHandlingSource;
}): WorkbenchClaudePermissionHandlingIpcBinding {
  let disposed = false;
  let actionOpen = true;

  const loadHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      values.length !== 1 ||
      disposed ||
      !actionOpen ||
      sender === undefined
    ) {
      return publicClaudePermissionHandlingUnavailable();
    }
    try {
      const reconstructed = reconstructWorkbenchClaudePermissionHandling(
        await options.source.readClaudePermissionHandling(),
      );
      if (
        !reconstructed.ok ||
        disposed ||
        !actionOpen ||
        sender.isDestroyed()
      ) {
        return publicClaudePermissionHandlingUnavailable();
      }
      return publicClaudePermissionHandlingLoaded(
        reconstructed.permissionHandling,
      );
    } catch {
      return publicClaudePermissionHandlingUnavailable();
    }
  };

  const saveHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      values.length !== 2 ||
      disposed ||
      !actionOpen ||
      sender === undefined
    ) {
      return publicClaudePermissionHandlingUnavailable();
    }
    const reconstructed = reconstructWorkbenchClaudePermissionHandling(
      values[1],
    );
    if (!reconstructed.ok) {
      return publicClaudePermissionHandlingUnavailable();
    }
    try {
      await options.source.saveClaudePermissionHandling(
        reconstructed.permissionHandling,
      );
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicClaudePermissionHandlingUnavailable();
      }
      return publicClaudePermissionHandlingSaved();
    } catch {
      return publicClaudePermissionHandlingUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(
    WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
    loadHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
    saveHandler,
  );
  // Captured while the window is still alive. Reading the `webContents`
  // getter on a destroyed BrowserWindow throws `Object has been destroyed`,
  // and dispose() runs from the window's own "closed" handler, where the
  // window is destroyed by definition (issue 172). A reference taken here
  // keeps answering removeListener afterwards, so nothing has to be caught.
  const rendererSender = options.window.webContents;
  rendererSender.on(
    "render-process-gone",
    terminalLifecycleListener,
  );
  rendererSender.on("destroyed", terminalLifecycleListener);
  options.window.on("closed", terminalLifecycleListener);

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      actionOpen = false;
      options.ipcMain.removeHandler(
        WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      );
      options.ipcMain.removeHandler(
        WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
      );
      rendererSender.removeListener(
        "render-process-gone",
        terminalLifecycleListener,
      );
      rendererSender.removeListener(
        "destroyed",
        terminalLifecycleListener,
      );
      options.window.removeListener("closed", terminalLifecycleListener);
    },
  });
}

function owningSender(
  value: unknown,
  window: ClaudePermissionHandlingBrowserWindowBoundary,
): ClaudePermissionHandlingRendererSender | undefined {
  try {
    if (typeof value !== "object" || value === null || !("sender" in value)) {
      return undefined;
    }
    const sender = (value as { readonly sender?: unknown }).sender;
    const owner = window.webContents;
    return sender === owner && !owner.isDestroyed() ? owner : undefined;
  } catch {
    return undefined;
  }
}
