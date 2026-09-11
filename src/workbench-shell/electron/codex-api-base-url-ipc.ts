import { isValidEndpointBaseUrl } from "../../agent-runtime/claude/endpoint-env-factory.ts";
import {
  WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL,
  WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
  publicCodexApiBaseUrlLoaded,
  publicCodexApiBaseUrlRejected,
  publicCodexApiBaseUrlSaved,
  publicCodexApiBaseUrlUnavailable,
} from "../contract.ts";
import { reconstructWorkbenchCodexApiBaseUrl } from "../result-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface CodexApiBaseUrlRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface CodexApiBaseUrlBrowserWindowBoundary {
  readonly webContents: CodexApiBaseUrlRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface CodexApiBaseUrlIpcMainBoundary {
  handle(
    channel:
      | typeof WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL
      | typeof WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(
    channel:
      | typeof WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL
      | typeof WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
  ): void;
}

export interface WorkbenchCodexApiBaseUrlSource {
  readCodexApiBaseUrl(): Promise<string>;
  saveCodexApiBaseUrl(baseUrl: string): Promise<string>;
}

export interface WorkbenchCodexApiBaseUrlIpcBinding {
  dispose(): void;
}

/**
 * IPC surface for the codex-api endpoint's provider base URL override
 * (ticket 21 follow-up, w223): same load/save shape as
 * claude-permission-handling-ipc.ts, backed by the appearance preference
 * store instead of the safeStorage-encrypted endpoint secret envelope --
 * the value is plain user-typed text, not a secret.
 *
 * A blank draft clears the override (the OpenAI default applies) and is
 * never refused, mirroring the runtime-executable escape hatch. A non-blank
 * draft that is not `http(s)://` is refused at save time with a reason, and
 * never reaches the store -- no connectivity probe here (ticket scope).
 */
export function installWorkbenchCodexApiBaseUrlIpc(options: {
  readonly ipcMain: CodexApiBaseUrlIpcMainBoundary;
  readonly window: CodexApiBaseUrlBrowserWindowBoundary;
  readonly source: WorkbenchCodexApiBaseUrlSource;
}): WorkbenchCodexApiBaseUrlIpcBinding {
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
      return publicCodexApiBaseUrlUnavailable();
    }
    try {
      const baseUrl = await options.source.readCodexApiBaseUrl();
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicCodexApiBaseUrlUnavailable();
      }
      return publicCodexApiBaseUrlLoaded(baseUrl);
    } catch {
      return publicCodexApiBaseUrlUnavailable();
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
      return publicCodexApiBaseUrlUnavailable();
    }
    const reconstructed = reconstructWorkbenchCodexApiBaseUrl(values[1]);
    if (!reconstructed.ok) return publicCodexApiBaseUrlUnavailable();
    const trimmed = reconstructed.baseUrl.trim();
    // An empty field clears the override and returns to the OpenAI default;
    // clearing must never be refused (same rule as the runtime executables).
    if (trimmed.length > 0 && !isValidEndpointBaseUrl(trimmed)) {
      return publicCodexApiBaseUrlRejected("invalid-url");
    }
    try {
      const saved = await options.source.saveCodexApiBaseUrl(trimmed);
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicCodexApiBaseUrlUnavailable();
      }
      return publicCodexApiBaseUrlSaved(saved);
    } catch {
      return publicCodexApiBaseUrlUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL, loadHandler);
  options.ipcMain.handle(WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL, saveHandler);
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
      options.ipcMain.removeHandler(WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL);
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
  window: CodexApiBaseUrlBrowserWindowBoundary,
): CodexApiBaseUrlRendererSender | undefined {
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
