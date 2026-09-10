import {
  WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
  WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
  publicAppearancePreferenceLoaded,
  publicAppearancePreferenceSaved,
  publicAppearancePreferenceUnavailable,
  type WorkbenchAppearancePreference,
} from "../contract.ts";
import { reconstructWorkbenchAppearancePreference } from "../result-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface AppearancePreferenceRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface AppearancePreferenceBrowserWindowBoundary {
  readonly webContents: AppearancePreferenceRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface AppearancePreferenceIpcMainBoundary {
  handle(
    channel:
      | typeof WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL
      | typeof WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(
    channel:
      | typeof WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL
      | typeof WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
  ): void;
}

export interface WorkbenchAppearancePreferenceSource {
  read(): Promise<WorkbenchAppearancePreference>;
  save(
    preference: WorkbenchAppearancePreference,
  ): Promise<WorkbenchAppearancePreference>;
}

export interface WorkbenchAppearancePreferenceIpcBinding {
  dispose(): void;
}

export function installWorkbenchAppearancePreferenceIpc(options: {
  readonly ipcMain: AppearancePreferenceIpcMainBoundary;
  readonly window: AppearancePreferenceBrowserWindowBoundary;
  readonly source: WorkbenchAppearancePreferenceSource;
}): WorkbenchAppearancePreferenceIpcBinding {
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
      return publicAppearancePreferenceUnavailable();
    }
    try {
      const reconstructed = reconstructWorkbenchAppearancePreference(
        await options.source.read(),
      );
      if (
        !reconstructed.ok ||
        disposed ||
        !actionOpen ||
        sender.isDestroyed()
      ) {
        return publicAppearancePreferenceUnavailable();
      }
      return publicAppearancePreferenceLoaded(reconstructed.preference);
    } catch {
      return publicAppearancePreferenceUnavailable();
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
      return publicAppearancePreferenceUnavailable();
    }
    const reconstructed = reconstructWorkbenchAppearancePreference(values[1]);
    if (!reconstructed.ok) return publicAppearancePreferenceUnavailable();
    try {
      await options.source.save(reconstructed.preference);
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicAppearancePreferenceUnavailable();
      }
      return publicAppearancePreferenceSaved();
    } catch {
      return publicAppearancePreferenceUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(
    WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
    loadHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
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
        WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
      );
      options.ipcMain.removeHandler(
        WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
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
  window: AppearancePreferenceBrowserWindowBoundary,
): AppearancePreferenceRendererSender | undefined {
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
