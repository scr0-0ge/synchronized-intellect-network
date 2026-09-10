import {
  WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
  publicEndpointCatalogFreshnessLoaded,
  publicEndpointCatalogFreshnessRefreshed,
  publicEndpointCatalogFreshnessUnavailable,
  type WorkbenchEndpointCatalogFreshnessModelEntry,
  type WorkbenchEndpointCatalogFreshnessReport,
} from "../contract.ts";
import type { EndpointCatalogFreshnessService } from "../endpoint-catalog-freshness.ts";
import type {
  EndpointKeyBrowserWindowBoundary,
  EndpointKeyIpcMainBoundary,
  EndpointKeyRendererSender,
} from "./endpoint-key-ipc.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface WorkbenchEndpointCatalogFreshnessIpcBinding {
  dispose(): void;
}

/**
 * IPC surface for catalog freshness (ticket 14 / WO16 Part 3). One load
 * channel (settings open) and one refresh channel (the manual button);
 * behind both, the zero-inference pull and every failure stays silent — the
 * renderer only ever sees sanitized id-level reports or the fixed
 * unavailable result.
 */
export function installWorkbenchEndpointCatalogFreshnessIpc(options: {
  readonly ipcMain: EndpointKeyIpcMainBoundary;
  readonly window: EndpointKeyBrowserWindowBoundary;
  readonly service: Pick<EndpointCatalogFreshnessService, "refresh">;
}): WorkbenchEndpointCatalogFreshnessIpcBinding {
  let disposed = false;
  let actionOpen = true;

  const reports = (): Promise<readonly WorkbenchEndpointCatalogFreshnessReport[]> =>
    options.service.refresh().then((fresh) => fresh.map(toPublicReport));

  const loadHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointCatalogFreshnessUnavailable();
    }
    try {
      return publicEndpointCatalogFreshnessLoaded(await reports());
    } catch {
      return publicEndpointCatalogFreshnessUnavailable();
    }
  };

  const refreshHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicEndpointCatalogFreshnessUnavailable();
    }
    try {
      return publicEndpointCatalogFreshnessRefreshed(await reports());
    } catch {
      return publicEndpointCatalogFreshnessUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(
    WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
    loadHandler,
  );
  options.ipcMain.handle(
    WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
    refreshHandler,
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
        WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
      );
      options.ipcMain.removeHandler(
        WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL,
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

function toPublicReport(
  report: Awaited<
    ReturnType<EndpointCatalogFreshnessService["refresh"]>
  >[number],
): WorkbenchEndpointCatalogFreshnessReport {
  return Object.freeze({
    endpointId: report.endpointId,
    status: report.status,
    newModels: Object.freeze(report.newModels.map(toPublicEntry)),
    enrolledModels: Object.freeze(report.enrolledModels.map(toPublicEntry)),
  });
}

function toPublicEntry(
  entry: { readonly id: string; readonly displayName?: string; readonly createdAt?: string },
): WorkbenchEndpointCatalogFreshnessModelEntry {
  return Object.freeze({
    id: entry.id,
    ...(entry.displayName === undefined
      ? {}
      : { displayName: entry.displayName }),
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
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
