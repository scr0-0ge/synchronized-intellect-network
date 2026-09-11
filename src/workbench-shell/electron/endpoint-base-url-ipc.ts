import { isValidEndpointBaseUrl } from "../../agent-runtime/claude/endpoint-env-factory.ts";
import {
  WORKBENCH_BASE_URL_CHANNELS,
  publicBaseUrlLoaded,
  publicBaseUrlRejected,
  publicBaseUrlSaved,
  publicBaseUrlUnavailable,
  type WorkbenchBaseUrlChannel,
  type WorkbenchBaseUrlEndpointId,
} from "../contract.ts";
import { reconstructWorkbenchBaseUrl } from "../result-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface EndpointBaseUrlRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface EndpointBaseUrlBrowserWindowBoundary {
  readonly webContents: EndpointBaseUrlRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface EndpointBaseUrlIpcMainBoundary {
  handle(channel: WorkbenchBaseUrlChannel, listener: BoundaryListener): void;
  removeHandler(channel: WorkbenchBaseUrlChannel): void;
}

export interface WorkbenchEndpointBaseUrlSource {
  readBaseUrl(): Promise<string>;
  saveBaseUrl(baseUrl: string): Promise<string>;
}

export interface WorkbenchEndpointBaseUrlIpcBinding {
  dispose(): void;
}

/**
 * IPC surface for one base-URL endpoint's provider base URL override
 * (ticket 21, w223; generalized with an endpoint dimension in w232 instead
 * of being copied per endpoint): same load/save shape as
 * claude-permission-handling-ipc.ts, backed by the appearance preference
 * store instead of the safeStorage-encrypted endpoint secret envelope --
 * the value is plain user-typed text, not a secret.
 *
 * A blank draft clears the override (that endpoint's official default
 * applies) and is never refused, mirroring the runtime-executable escape
 * hatch. A non-blank draft that is not `http(s)://` is refused at save time
 * with a reason, and never reaches the store -- no connectivity probe here
 * (ticket scope).
 */
export function installWorkbenchEndpointBaseUrlIpc(options: {
  readonly ipcMain: EndpointBaseUrlIpcMainBoundary;
  readonly window: EndpointBaseUrlBrowserWindowBoundary;
  readonly endpointId: WorkbenchBaseUrlEndpointId;
  readonly source: WorkbenchEndpointBaseUrlSource;
}): WorkbenchEndpointBaseUrlIpcBinding {
  let disposed = false;
  let actionOpen = true;
  const channels = WORKBENCH_BASE_URL_CHANNELS[options.endpointId];

  const loadHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (
      values.length !== 1 ||
      disposed ||
      !actionOpen ||
      sender === undefined
    ) {
      return publicBaseUrlUnavailable();
    }
    try {
      const baseUrl = await options.source.readBaseUrl();
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicBaseUrlUnavailable();
      }
      return publicBaseUrlLoaded(baseUrl);
    } catch {
      return publicBaseUrlUnavailable();
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
      return publicBaseUrlUnavailable();
    }
    const reconstructed = reconstructWorkbenchBaseUrl(values[1]);
    if (!reconstructed.ok) return publicBaseUrlUnavailable();
    const trimmed = reconstructed.baseUrl.trim();
    // An empty field clears the override and returns to that endpoint's
    // default; clearing must never be refused (same rule as the runtime
    // executables).
    if (trimmed.length > 0 && !isValidEndpointBaseUrl(trimmed)) {
      return publicBaseUrlRejected("invalid-url");
    }
    try {
      const saved = await options.source.saveBaseUrl(trimmed);
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicBaseUrlUnavailable();
      }
      return publicBaseUrlSaved(saved);
    } catch {
      return publicBaseUrlUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(channels.load, loadHandler);
  options.ipcMain.handle(channels.save, saveHandler);
  // Captured while the window is still alive. Reading the `webContents`
  // getter on a destroyed BrowserWindow throws `Object has been destroyed`,
  // and dispose() runs from the window's own "closed" handler, where the
  // window is destroyed by definition (issue 172). A reference taken here
  // keeps answering removeListener afterwards, so nothing has to be caught.
  const rendererSender = options.window.webContents;
  rendererSender.on("render-process-gone", terminalLifecycleListener);
  rendererSender.on("destroyed", terminalLifecycleListener);
  options.window.on("closed", terminalLifecycleListener);

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      actionOpen = false;
      options.ipcMain.removeHandler(channels.load);
      options.ipcMain.removeHandler(channels.save);
      rendererSender.removeListener(
        "render-process-gone",
        terminalLifecycleListener,
      );
      rendererSender.removeListener("destroyed", terminalLifecycleListener);
      options.window.removeListener("closed", terminalLifecycleListener);
    },
  });
}

function owningSender(
  value: unknown,
  window: EndpointBaseUrlBrowserWindowBoundary,
): EndpointBaseUrlRendererSender | undefined {
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
