import {
  WORKBENCH_ENDPOINT_KEY_CHANNELS,
  publicEndpointKeyInvalidValue,
  publicEndpointKeyNotConfigured,
  publicEndpointKeyRemoved,
  publicEndpointKeyRevealed,
  publicEndpointKeySaved,
  publicEndpointKeyStatusLoaded,
  publicEndpointKeyUnavailable,
  publicEndpointProbed,
  type WorkbenchEndpointKeyChannels,
  type WorkbenchEndpointKeyEndpointId,
} from "../contract.ts";
import { reconstructWorkbenchEndpointKeySaveRequest } from "../result-sanitizer.ts";
import type { WorkbenchEndpointKeySource } from "../endpoint-key-source.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface EndpointKeyRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface EndpointKeyBrowserWindowBoundary {
  readonly webContents: EndpointKeyRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface EndpointKeyIpcMainBoundary {
  handle(channel: string, listener: BoundaryListener): void;
  removeHandler(channel: string): void;
}

export interface WorkbenchEndpointKeyIpcBinding {
  dispose(): void;
}

/**
 * IPC surface for one endpoint's API-transport key (ADR 0022; parameterized
 * over the endpoint in WO16 Part 1 — GLM, Kimi and DeepSeek each install one
 * binding with their own channel set and source). Names, masks and booleans
 * cross the boundary freely; the key value itself leaves the main process
 * only through the explicit reveal channel, and enters it only through the
 * save channel after exact-shape reconstruction.
 */
export function installWorkbenchEndpointKeyIpc(options: {
  readonly ipcMain: EndpointKeyIpcMainBoundary;
  readonly window: EndpointKeyBrowserWindowBoundary;
  readonly endpointId: WorkbenchEndpointKeyEndpointId;
  readonly source: WorkbenchEndpointKeySource;
}): WorkbenchEndpointKeyIpcBinding {
  const channels: WorkbenchEndpointKeyChannels =
    WORKBENCH_ENDPOINT_KEY_CHANNELS[options.endpointId];
  let disposed = false;
  let actionOpen = true;

  const loadStatusHandler: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointKeyUnavailable();
    }
    try {
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicEndpointKeyUnavailable();
      }
      return publicEndpointKeyStatusLoaded(options.source.status());
    } catch {
      return publicEndpointKeyUnavailable();
    }
  };

  const saveHandler: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 2 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointKeyUnavailable();
    }
    const reconstructed = reconstructWorkbenchEndpointKeySaveRequest(
      values[1],
    );
    if (!reconstructed.ok) return publicEndpointKeyInvalidValue();
    try {
      options.source.save(reconstructed.keyValue);
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicEndpointKeyUnavailable();
      }
      const snapshot = options.source.status();
      if (!snapshot.configured || snapshot.maskedHint === null) {
        return publicEndpointKeyUnavailable();
      }
      return publicEndpointKeySaved(
        snapshot.maskedHint,
        snapshot.isPersistent,
      );
    } catch {
      return publicEndpointKeyUnavailable();
    }
  };

  const removeHandler: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointKeyUnavailable();
    }
    try {
      const removed = options.source.remove();
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicEndpointKeyUnavailable();
      }
      const snapshot = options.source.status();
      return removed
        ? publicEndpointKeyRemoved(snapshot)
        : publicEndpointKeyNotConfigured(snapshot);
    } catch {
      return publicEndpointKeyUnavailable();
    }
  };

  const revealHandler: BoundaryListener = (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointKeyUnavailable();
    }
    try {
      const value = options.source.reveal();
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicEndpointKeyUnavailable();
      }
      const snapshot = options.source.status();
      if (value === undefined) {
        return publicEndpointKeyNotConfigured(snapshot);
      }
      return publicEndpointKeyRevealed(value, snapshot);
    } catch {
      return publicEndpointKeyUnavailable();
    }
  };

  const probeHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointKeyUnavailable();
    }
    try {
      const outcome = await options.source.probe();
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicEndpointKeyUnavailable();
      }
      return publicEndpointProbed(outcome);
    } catch {
      return publicEndpointKeyUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(channels.loadStatus, loadStatusHandler);
  options.ipcMain.handle(channels.save, saveHandler);
  options.ipcMain.handle(channels.remove, removeHandler);
  options.ipcMain.handle(channels.reveal, revealHandler);
  options.ipcMain.handle(channels.probe, probeHandler);
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
      options.ipcMain.removeHandler(channels.loadStatus);
      options.ipcMain.removeHandler(channels.save);
      options.ipcMain.removeHandler(channels.remove);
      options.ipcMain.removeHandler(channels.reveal);
      options.ipcMain.removeHandler(channels.probe);
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
  window: EndpointKeyBrowserWindowBoundary,
): EndpointKeyRendererSender | undefined {
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
