import {
  WORKBENCH_CHECK_CLI_UPDATES_CHANNEL,
  WORKBENCH_RELAUNCH_APP_CHANNEL,
  WORKBENCH_RUN_CLI_UPDATE_CHANNEL,
  publicCliUpdateCheckCompleted,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRelaunchQueued,
  publicCliUpdateRelaunchUnavailable,
  publicCliUpdateRunUnavailable,
} from "./cli-update-contract.ts";
import {
  reconstructWorkbenchCliUpdateRunRequest,
} from "./cli-update-sanitizer.ts";
import type { CliUpdateService } from "./cli-update-check.ts";
import type {
  EndpointKeyBrowserWindowBoundary,
  EndpointKeyIpcMainBoundary,
  EndpointKeyRendererSender,
} from "./electron/endpoint-key-ipc.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface WorkbenchCliUpdateIpcBinding {
  dispose(): void;
}

/**
 * IPC surface for CLI updates (ticket 18), on the parameterized pattern
 * the lane already uses (endpoint-key / catalog-freshness bindings): two
 * channels over one service, sender-ownership checks on every
 * invocation, terminal lifecycle closes the surface, and symmetric
 * disposal. The check channel is the zero-side-effect memoized check;
 * the run channel is the only door to an actual update and exists solely
 * for the Settings button — nothing here ever spawns an update on its
 * own.
 *
 * Ticket 21 cleanup item 2 adds the third channel `workbench:relaunch-app`
 * (the "restart now" half of the update reminder): the handler validates
 * sender ownership exactly like the other two, then hands off to the
 * `requestRelaunch` callback the main process supplies
 * (`app.relaunch()` + the graceful `app.quit()` drain). The exit happens AFTER the result
 * reaches the renderer, so the caller still gets its `queued` truth.
 */
export function installWorkbenchCliUpdateIpc(options: {
  readonly ipcMain: EndpointKeyIpcMainBoundary;
  readonly window: EndpointKeyBrowserWindowBoundary;
  readonly service: Pick<CliUpdateService, "check" | "run">;
  /** Main-process relaunch: queue app.relaunch() then exit. */
  readonly requestRelaunch: () => void;
}): WorkbenchCliUpdateIpcBinding {
  let disposed = false;
  let actionOpen = true;

  const checkHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicCliUpdateCheckUnavailable();
    }
    try {
      return publicCliUpdateCheckCompleted(await options.service.check());
    } catch {
      return publicCliUpdateCheckUnavailable();
    }
  };

  const runHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 2 || disposed || !actionOpen || sender === undefined) {
      return publicCliUpdateRunUnavailable();
    }
    const reconstructed = reconstructWorkbenchCliUpdateRunRequest(values[1]);
    if (!reconstructed.ok) {
      return publicCliUpdateRunUnavailable();
    }
    try {
      return await options.service.run(reconstructed.value);
    } catch {
      return publicCliUpdateRunUnavailable();
    }
  };

  const relaunchHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicCliUpdateRelaunchUnavailable();
    }
    try {
      // Queue the relaunch behind the current event-loop turn so the
      // `queued` result is written to the renderer before the process
      // goes away (Electron drains the reply first). A callback that
      // throws after the fact is contained — it must never crash main.
      setImmediate(() => {
        if (disposed) return;
        try {
          options.requestRelaunch();
        } catch {
          // Best-effort action; the failure surface is the app log.
        }
      });
      return publicCliUpdateRelaunchQueued();
    } catch {
      return publicCliUpdateRelaunchUnavailable();
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(
    WORKBENCH_CHECK_CLI_UPDATES_CHANNEL,
    checkHandler,
  );
  options.ipcMain.handle(WORKBENCH_RUN_CLI_UPDATE_CHANNEL, runHandler);
  options.ipcMain.handle(WORKBENCH_RELAUNCH_APP_CHANNEL, relaunchHandler);
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
      options.ipcMain.removeHandler(WORKBENCH_CHECK_CLI_UPDATES_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_RUN_CLI_UPDATE_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_RELAUNCH_APP_CHANNEL);
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
