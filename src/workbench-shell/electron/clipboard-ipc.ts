import {
  WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
  publicClipboardCopied,
  publicClipboardWriteUnavailable,
} from "../clipboard-bridge.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface WorkbenchClipboardRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface WorkbenchClipboardBrowserWindowBoundary {
  readonly webContents: WorkbenchClipboardRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface WorkbenchClipboardIpcMainBoundary {
  handle(
    channel: typeof WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(channel: typeof WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL): void;
}

export interface WorkbenchSystemClipboardBoundary {
  writeText(text: string): void;
  readText(): string;
}

export interface WorkbenchClipboardIpcBinding {
  dispose(): void;
}

export function installWorkbenchClipboardIpc(options: {
  readonly ipcMain: WorkbenchClipboardIpcMainBoundary;
  readonly window: WorkbenchClipboardBrowserWindowBoundary;
  readonly clipboard: WorkbenchSystemClipboardBoundary;
}): WorkbenchClipboardIpcBinding {
  let disposed = false;
  let actionOpen = true;

  const writeHandler: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      values.length !== 2 ||
      disposed ||
      !actionOpen ||
      sender === undefined ||
      typeof values[1] !== "string"
    ) {
      return publicClipboardWriteUnavailable();
    }
    const text = values[1];
    try {
      options.clipboard.writeText(text);
      if (
        disposed ||
        !actionOpen ||
        sender.isDestroyed() ||
        options.clipboard.readText() !== text
      ) {
        return publicClipboardWriteUnavailable();
      }
      return publicClipboardCopied();
    } catch {
      return publicClipboardWriteUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL, writeHandler);
  options.window.webContents.on(
    "render-process-gone",
    terminalLifecycleListener,
  );
  options.window.webContents.on("destroyed", terminalLifecycleListener);
  options.window.on("closed", terminalLifecycleListener);

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      actionOpen = false;
      options.ipcMain.removeHandler(WORKBENCH_WRITE_CLIPBOARD_TEXT_CHANNEL);
      options.window.webContents.removeListener(
        "render-process-gone",
        terminalLifecycleListener,
      );
      options.window.webContents.removeListener(
        "destroyed",
        terminalLifecycleListener,
      );
      options.window.removeListener("closed", terminalLifecycleListener);
    },
  });
}

function owningSender(
  value: unknown,
  window: WorkbenchClipboardBrowserWindowBoundary,
): WorkbenchClipboardRendererSender | undefined {
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
