import {
  WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL,
  WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
  publicEndpointPreferenceSaved,
  publicEndpointPreferencesLoaded,
  publicEndpointPreferenceUnavailable,
  type WorkbenchFamilyEndpointPreference,
  type WorkbenchFamilyEndpointPreferences,
} from "../contract.ts";
import {
  reconstructWorkbenchFamilyEndpointPreference,
  reconstructWorkbenchFamilyEndpointPreferences,
} from "../result-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface EndpointPreferenceRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface EndpointPreferenceBrowserWindowBoundary {
  readonly webContents: EndpointPreferenceRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

export interface EndpointPreferenceIpcMainBoundary {
  handle(
    channel:
      | typeof WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL
      | typeof WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(
    channel:
      | typeof WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL
      | typeof WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
  ): void;
}

/**
 * The family facade's persistence source (ticket 25, generalizing ticket 20's
 * Kimi-only binding): reads the whole per-family record, saves one family's
 * preference (the value names its family; the store keeps the other two).
 */
export interface WorkbenchEndpointPreferenceSource {
  readEndpointPreferences(): Promise<WorkbenchFamilyEndpointPreferences>;
  saveEndpointPreference(
    preference: WorkbenchFamilyEndpointPreference,
  ): Promise<WorkbenchFamilyEndpointPreference>;
}

export interface WorkbenchEndpointPreferenceIpcBinding {
  dispose(): void;
}

export function installWorkbenchEndpointPreferenceIpc(options: {
  readonly ipcMain: EndpointPreferenceIpcMainBoundary;
  readonly window: EndpointPreferenceBrowserWindowBoundary;
  readonly source: WorkbenchEndpointPreferenceSource;
}): WorkbenchEndpointPreferenceIpcBinding {
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
      return publicEndpointPreferenceUnavailable();
    }
    try {
      const reconstructed = reconstructWorkbenchFamilyEndpointPreferences(
        await options.source.readEndpointPreferences(),
      );
      if (
        !reconstructed.ok ||
        disposed ||
        !actionOpen ||
        sender.isDestroyed()
      ) {
        return publicEndpointPreferenceUnavailable();
      }
      return publicEndpointPreferencesLoaded(reconstructed.preferences);
    } catch {
      return publicEndpointPreferenceUnavailable();
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
      return publicEndpointPreferenceUnavailable();
    }
    const reconstructed = reconstructWorkbenchFamilyEndpointPreference(
      values[1],
    );
    if (!reconstructed.ok) {
      return publicEndpointPreferenceUnavailable();
    }
    try {
      await options.source.saveEndpointPreference(reconstructed.preference);
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicEndpointPreferenceUnavailable();
      }
      return publicEndpointPreferenceSaved();
    } catch {
      return publicEndpointPreferenceUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(
    WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL,
    loadHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
    saveHandler,
  );
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
      options.ipcMain.removeHandler(
        WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL,
      );
      options.ipcMain.removeHandler(
        WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL,
      );
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
  window: EndpointPreferenceBrowserWindowBoundary,
): EndpointPreferenceRendererSender | undefined {
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
