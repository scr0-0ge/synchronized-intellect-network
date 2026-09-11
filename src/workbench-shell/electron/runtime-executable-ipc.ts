import {
  admitLaunchTarget,
  productionWindowsAdmissionDependencies,
  type LaunchRejection,
  type WindowsRuntimeLaunchAdmission,
} from "../../agent-runtime/windows-executable-admission.ts";
import {
  provisionRuntimeCli,
  type CliProvisioningOutcome,
} from "../../agent-runtime/cli-provisioning.ts";
import { setConfiguredRuntimeExecutable } from "../../agent-runtime/configured-executable.ts";
import {
  CLAUDE_RUNTIME_LOOKUP_SURFACE,
  CODEX_RUNTIME_LOOKUP_SURFACE,
} from "../../agent-runtime/runtime-lookup-surface.ts";
import {
  WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL,
  WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL,
  WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL,
  publicRuntimeExecutableRejected,
  publicRuntimeExecutableSaved,
  publicRuntimeExecutableUnavailable,
  publicRuntimeExecutablesLoaded,
  publicRuntimeInstallFailed,
  publicRuntimeInstalled,
  type WorkbenchConfigurableRuntime,
  type WorkbenchRuntimeExecutablePaths,
  type WorkbenchRuntimeExecutableRejection,
} from "../contract.ts";
import {
  reconstructWorkbenchRuntimeExecutableSaveRequest,
  reconstructWorkbenchRuntimeInstallRequest,
  sanitizeWorkbenchRuntimeInstallDetail,
} from "../result-sanitizer.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface RuntimeExecutableRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface RuntimeExecutableBrowserWindowBoundary {
  readonly webContents: RuntimeExecutableRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
}

type RuntimeExecutableChannel =
  | typeof WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL
  | typeof WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL
  | typeof WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL;

export interface RuntimeExecutableIpcMainBoundary {
  handle(channel: RuntimeExecutableChannel, listener: BoundaryListener): void;
  removeHandler(channel: RuntimeExecutableChannel): void;
}

export interface WorkbenchRuntimeExecutableSource {
  readRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablePaths>;
  saveRuntimeExecutables(
    executables: WorkbenchRuntimeExecutablePaths,
  ): Promise<WorkbenchRuntimeExecutablePaths>;
}

export interface WorkbenchRuntimeExecutableIpcBinding {
  dispose(): void;
}

/**
 * A path a user typed is refused with a REASON, at the moment they press Save,
 * rather than stored and left to fail silently at the next session start. The
 * reason vocabulary is fixed and carries no path, so nothing about the user's
 * filesystem crosses the boundary -- only the name of what went wrong.
 */
export function runtimeExecutableRejectionFor(
  reason: LaunchRejection,
): WorkbenchRuntimeExecutableRejection {
  switch (reason) {
    case "not-absolute":
      return "not-absolute";
    case "missing":
      return "not-found";
    case "not-a-regular-file":
      return "not-a-file";
    case "not-a-native-executable-name":
    case "unsupported-shape":
    case "unsupported-entry":
      return "unsupported-shape";
    case "package-manifest-unreadable":
    case "package-manifest-declares-no-entry":
    case "entry-escapes-its-package":
    case "entry-missing":
      return "no-install-beside-it";
    case "node-interpreter-not-located":
      return "no-node-interpreter";
    default:
      return "unusable";
  }
}

export type RuntimeExecutableAdmission = (
  runtime: WorkbenchConfigurableRuntime,
  executablePath: string,
) => Promise<WindowsRuntimeLaunchAdmission>;

/** Installs the runtime into the private directory; production runs npm. */
export type RuntimeExecutableProvisioning = (
  runtime: WorkbenchConfigurableRuntime,
  publish: (runtime: WorkbenchConfigurableRuntime, value: string) => void,
) => Promise<CliProvisioningOutcome>;

const productionProvisioning: RuntimeExecutableProvisioning = (runtime, publish) =>
  provisionRuntimeCli(runtime, { publish });

const productionAdmission: RuntimeExecutableAdmission = (
  runtime,
  executablePath,
) =>
  admitLaunchTarget(
    executablePath,
    runtime === "codex"
      ? CODEX_RUNTIME_LOOKUP_SURFACE
      : CLAUDE_RUNTIME_LOOKUP_SURFACE,
    productionWindowsAdmissionDependencies,
  );

export function installWorkbenchRuntimeExecutableIpc(options: {
  readonly ipcMain: RuntimeExecutableIpcMainBoundary;
  readonly window: RuntimeExecutableBrowserWindowBoundary;
  readonly source: WorkbenchRuntimeExecutableSource;
  readonly admit?: RuntimeExecutableAdmission;
  readonly provision?: RuntimeExecutableProvisioning;
  readonly publish?: (
    runtime: WorkbenchConfigurableRuntime,
    value: string | undefined,
  ) => void;
}): WorkbenchRuntimeExecutableIpcBinding {
  const admit = options.admit ?? productionAdmission;
  const provision = options.provision ?? productionProvisioning;
  const publish = options.publish ?? setConfiguredRuntimeExecutable;
  let disposed = false;
  let actionOpen = true;
  // One npm at a time per runtime: two installs into the same directory would
  // race each other's files.
  const installing = new Set<WorkbenchConfigurableRuntime>();

  const loadHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 1 || disposed || !actionOpen || sender === undefined) {
      return publicRuntimeExecutableUnavailable();
    }
    try {
      const executables = await options.source.readRuntimeExecutables();
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicRuntimeExecutableUnavailable();
      }
      return publicRuntimeExecutablesLoaded(executables);
    } catch {
      return publicRuntimeExecutableUnavailable();
    }
  };

  const saveHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 2 || disposed || !actionOpen || sender === undefined) {
      return publicRuntimeExecutableUnavailable();
    }
    const reconstructed = reconstructWorkbenchRuntimeExecutableSaveRequest(
      values[1],
    );
    if (!reconstructed.ok) return publicRuntimeExecutableUnavailable();
    const { runtime, executablePath } = reconstructed.request;
    const trimmed = executablePath.trim();

    try {
      // An empty field clears the override and returns to ordinary discovery.
      // Clearing must never be refused: it is how a user undoes a bad answer.
      if (trimmed.length > 0) {
        const admission = await admit(runtime, trimmed);
        if (admission.kind === "rejected") {
          return publicRuntimeExecutableRejected(
            runtimeExecutableRejectionFor(admission.reason),
          );
        }
      }
      const current = await options.source.readRuntimeExecutables();
      const next = Object.freeze({
        codex: runtime === "codex" ? trimmed : current.codex,
        claude: runtime === "claude" ? trimmed : current.claude,
      });
      const saved = await options.source.saveRuntimeExecutables(next);
      publish(runtime, trimmed.length > 0 ? trimmed : undefined);
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicRuntimeExecutableUnavailable();
      }
      return publicRuntimeExecutableSaved(saved);
    } catch {
      return publicRuntimeExecutableUnavailable();
    }
  };

  // The product installing the runtime for the user. The result is the same
  // durable store write the Save button makes, with the path the installer
  // produced; "installed" means the product's own discovery located that copy.
  const installHandler: BoundaryListener = async (...values) => {
    const sender = owningSender(values[0], options.window);
    if (values.length !== 2 || disposed || !actionOpen || sender === undefined) {
      return publicRuntimeExecutableUnavailable();
    }
    const reconstructed = reconstructWorkbenchRuntimeInstallRequest(values[1]);
    if (!reconstructed.ok) return publicRuntimeExecutableUnavailable();
    const { runtime } = reconstructed.request;
    if (installing.has(runtime)) return publicRuntimeExecutableUnavailable();
    installing.add(runtime);
    try {
      const outcome = await provision(runtime, publish);
      if (outcome.kind === "failed") {
        return publicRuntimeInstallFailed(
          outcome.step,
          sanitizeWorkbenchRuntimeInstallDetail(outcome.detail),
        );
      }
      const current = await options.source.readRuntimeExecutables();
      const saved = await options.source.saveRuntimeExecutables(
        Object.freeze({
          codex: runtime === "codex" ? outcome.configuredPath : current.codex,
          claude: runtime === "claude" ? outcome.configuredPath : current.claude,
        }),
      );
      if (disposed || !actionOpen || sender.isDestroyed()) {
        return publicRuntimeExecutableUnavailable();
      }
      return publicRuntimeInstalled(runtime, outcome.version, saved);
    } catch {
      return publicRuntimeExecutableUnavailable();
    } finally {
      installing.delete(runtime);
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    actionOpen = false;
  };

  options.ipcMain.handle(WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL, loadHandler);
  options.ipcMain.handle(WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL, saveHandler);
  options.ipcMain.handle(WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL, installHandler);
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
      options.ipcMain.removeHandler(WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL);
      options.ipcMain.removeHandler(WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL);
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
  window: RuntimeExecutableBrowserWindowBoundary,
): RuntimeExecutableRendererSender | undefined {
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
