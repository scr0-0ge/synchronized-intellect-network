import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  Tray,
} from "electron";

import { createFileClaudeSessionCapabilityStore } from "../../agent-runtime/claude/session-capability-store.ts";
import { createOfficialClaudeSubscriptionAuthenticationProvider } from "../../agent-runtime/claude/subscription-authentication.ts";
import type {
  ClaudeToolPermissionHandler,
  ClaudeToolPermissionRequest,
} from "../../agent-runtime/claude/transport.ts";
import { createOfficialCodexSubscriptionAuthenticationProvider } from "../../agent-runtime/codex/subscription-authentication.ts";
import { createSubscriptionAuthenticationService } from "../../agent-runtime/subscription-authentication.ts";
import { createWorkLedgerAuthGenerationModule } from "../../coordinator/work-ledger-auth-generation.ts";
import {
  createWorkbenchAppearancePreferenceStore,
  type WorkbenchAppearancePreferenceStore,
} from "../appearance-preference-store.ts";
import {
  createWorkbenchCreateProjectController,
  type WorkbenchCreateProjectController,
} from "../create-project-controller.ts";
import { createNodeWorkbenchCreateProjectFilesystem } from "../create-project-filesystem.ts";
import { openWorkbenchCreateProjectStateStore } from "../create-project-store.ts";
import { resolveConversationStoreRoot } from "../conversation-store-root.ts";
import {
  createWorkbenchProjectHost,
  type WorkbenchProjectHost,
} from "../project-host.ts";
import {
  createHistoricalRecoveryLibrary,
  type HistoricalRecoveryLibrary,
} from "../history-recovery.ts";
import { createProductionRuntimeEndpointAdapter } from "../runtime-endpoint-composition.ts";
import {
  PROVIDER_ATTEMPT_BUILD_MARKER_SWITCH,
  PROVIDER_ATTEMPT_LOCATOR_SWITCH,
  PROVIDER_ATTEMPT_PROTOCOL_SWITCH,
  loadProviderRequestBudgetForElectronMain,
} from "../provider-attempt-runtime.ts";
import {
  WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS,
  createWorkbenchSubscriptionAuthenticationCoordinator,
  createWorkLedgerSubscriptionAuthenticationMutationAuthority,
} from "../subscription-authentication-coordinator.ts";
import {
  installWorkbenchAppearancePreferenceIpc,
  type WorkbenchAppearancePreferenceIpcBinding,
} from "./appearance-preference-ipc.ts";
import {
  installWorkbenchClaudePermissionHandlingIpc,
  type WorkbenchClaudePermissionHandlingIpcBinding,
} from "./claude-permission-handling-ipc.ts";
import {
  installWorkbenchRuntimeExecutableIpc,
  type WorkbenchRuntimeExecutableIpcBinding,
} from "./runtime-executable-ipc.ts";
import { setConfiguredRuntimeExecutable } from "../../agent-runtime/configured-executable.ts";
import {
  installWorkbenchClipboardIpc,
  type WorkbenchClipboardIpcBinding,
} from "./clipboard-ipc.ts";
import {
  installWorkbenchNotificationIpc,
  type WorkbenchNotificationIpcBinding,
} from "./notification-ipc.ts";
import {
  installWorkbenchProjectViewIpc,
  type ProjectViewIpcBinding,
} from "./project-view-ipc.ts";
import {
  installHistoryRecoveryIpc,
  type HistoryRecoveryIpcBinding,
} from "./history-recovery-ipc.ts";
import { createElectronHistoryRecoveryExportChooser } from "./history-recovery-export-chooser.ts";
import { createDeferredProductionHistoryRecoverySourceDiscovery } from "./history-recovery-source-discovery.ts";
import {
  installWorkbenchSubscriptionAuthenticationActionIpc,
  type WorkbenchSubscriptionAuthenticationIpcBinding,
} from "./subscription-authentication-ipc.ts";
import {
  closeWorkbenchBackendAfterInitialization,
  createWorkbenchLifecycleController,
  createWorkbenchWindowRestorer,
} from "./lifecycle.ts";
import { createPackagedBootstrapRuntimeAdapter } from "./bootstrap-runtime-adapter.ts";
import { createElectronProjectDirectoryChooser } from "./project-directory-chooser.ts";
import { createElectronProjectSaveTargetChooser } from "./project-save-target-chooser.ts";
import {
  formatNativeWindowFrameHookDiagnostic,
  installNativeWindowFrameReassertion,
  type NativeWindowFrameReassertionInstallation,
} from "./native-window-frame-persistence.ts";
import {
  configureWindowsAcrylicWindow,
  designedWindowGround,
  formatNativeWindowFrameDiagnostic,
  formatNativeWindowMaterialDiagnostic,
  shouldPresentWindowsAcrylic,
  type NativeWindowMaterialState,
  type NativeWindowMaterialVerification,
} from "./native-window-material.ts";
import { initializeWorkbenchProjectHost } from "./startup.ts";
import { startProjectHostAfterRecoveryPreparation } from "./startup.ts";
import { createWorkbenchTrayIcon } from "./tray-icon.ts";
import {
  formatWindowPlacementDiagnostic,
  offscreenWindowOptions,
  offscreenWindowOrigin,
  resolveWindowPlacement,
  WINDOW_PLACEMENT_SWITCH,
  type OffscreenWindowOptions,
  type WindowPlacementDecision,
} from "./window-placement.ts";
import {
  installWorkbenchWindowControlIpc,
  type WorkbenchWindowControlIpcBinding,
} from "../window-control-bridge.ts";

app.setName("unified-agent-workbench");
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

/*
 * Read once, at module scope, because a startup failure can be presented
 * before the ready handler runs and the failure window obeys the same rule as
 * the main window. `app.commandLine` is populated before "ready"; `screen` is
 * not, which is why the origin is resolved lazily below.
 */
const windowPlacement: WindowPlacementDecision = resolveWindowPlacement({
  isolatedUserDataDirectory: app.commandLine.hasSwitch("user-data-dir"),
  placementSwitchValue: app.commandLine.hasSwitch(WINDOW_PLACEMENT_SWITCH)
    ? app.commandLine.getSwitchValue(WINDOW_PLACEMENT_SWITCH)
    : null,
});

/**
 * The extra BrowserWindow options an offscreen launch carries, or nothing at
 * all. A default launch spreads an empty object, so its options are the exact
 * object this file built before the switch existed.
 */
function windowPlacementOptions(): OffscreenWindowOptions | Record<string, never> {
  if (windowPlacement.kind !== "offscreen") return {};
  return offscreenWindowOptions(
    app.isReady() ? screen.getAllDisplays().map((display) => display.bounds) : [],
  );
}

function reportWindowPlacement(surface: string): void {
  console.info(
    formatWindowPlacementDiagnostic(
      surface,
      windowPlacement,
      windowPlacement.kind === "offscreen"
        ? offscreenWindowOrigin(
            app.isReady()
              ? screen.getAllDisplays().map((display) => display.bounds)
              : [],
          )
        : null,
    ),
  );
}

let mainWindow: BrowserWindow | null = null;
let restorableWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: WorkbenchProjectHost | null = null;
let projectViewIpc: ProjectViewIpcBinding | null = null;
let clipboardIpc: WorkbenchClipboardIpcBinding | null = null;
let notificationIpc: WorkbenchNotificationIpcBinding | null = null;
let historyRecovery: HistoricalRecoveryLibrary | null = null;
let historyRecoveryIpc: HistoryRecoveryIpcBinding | null = null;
let historyRecoveryIpcShutdown: Promise<void> = Promise.resolve();
let windowControlIpc: WorkbenchWindowControlIpcBinding | null = null;
let appearancePreferenceIpc: WorkbenchAppearancePreferenceIpcBinding | null =
  null;
let claudePermissionHandlingIpc: WorkbenchClaudePermissionHandlingIpcBinding | null =
  null;
let runtimeExecutableIpc: WorkbenchRuntimeExecutableIpcBinding | null = null;
let subscriptionAuthenticationIpc: WorkbenchSubscriptionAuthenticationIpcBinding | null =
  null;
let subscriptionAuthenticationShutdown: Promise<void> = Promise.resolve();
let appearancePreferenceStore: WorkbenchAppearancePreferenceStore | null =
  null;
let createProjectController: WorkbenchCreateProjectController | undefined;
let backendInitialization: Promise<void> = Promise.resolve();
let shutdownRequested = false;
let startupFailurePresented = false;

function disposeNotificationIpcBinding(): void {
  notificationIpc?.dispose();
  notificationIpc = null;
}

const startupFailureHeading =
  "Synchronized Intellect Network could not finish starting.";
const startupFailureAdvice =
  "Close this window to exit. No part of the app is left running in the background.";

export function claudeToolPermissionDialogDetail(
  request: ClaudeToolPermissionRequest,
): string {
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(request.input, null, 2);
  } catch {
    serializedInput = "[Input could not be displayed]";
  }
  if (serializedInput.length > 4_000) {
    serializedInput = `${serializedInput.slice(0, 4_000)}\n…`;
  }
  const context = [
    request.description,
    request.decisionReason === undefined
      ? undefined
      : `Reason: ${request.decisionReason}`,
    request.blockedPath === undefined
      ? undefined
      : `Blocked path: ${request.blockedPath}`,
  ].filter((value): value is string => value !== undefined);
  return [
    ...context,
    ...(context.length === 0 ? [] : [""]),
    "This Claude Session is set to Ask when needed. Approve this single tool use?",
    "",
    `Input:\n${serializedInput}`,
  ].join("\n");
}

const requestClaudeToolPermission: ClaudeToolPermissionHandler = async (
  request,
) => {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    return Object.freeze({
      behavior: "deny" as const,
      message: "The Workbench approval window is unavailable.",
    });
  }
  try {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Claude tool permission",
      message:
        request.title ??
        request.displayName ??
        `Claude wants to use ${request.toolName}`,
      detail: claudeToolPermissionDialogDetail(request),
      buttons: ["Allow once", "Deny"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0
      ? Object.freeze({ behavior: "allow" as const })
      : Object.freeze({
          behavior: "deny" as const,
          message: "The user denied this tool request.",
        });
  } catch {
    return Object.freeze({
      behavior: "deny" as const,
      message: "The Workbench could not present this approval request.",
    });
  }
};

const windowRestorer = createWorkbenchWindowRestorer(() => restorableWindow);

const lifecycle = createWorkbenchLifecycleController({
  readTurnActivity() {
    return backend?.readTurnActivity() ?? "unknown";
  },
  isTrayReady() {
    return tray !== null && !tray.isDestroyed();
  },
  hideWindow() {
    mainWindow?.hide();
  },
  disposeProjectView() {
    shutdownRequested = true;
    const closingHistoryRecoveryIpc = historyRecoveryIpc;
    historyRecoveryIpc = null;
    historyRecoveryIpcShutdown =
      closingHistoryRecoveryIpc?.dispose() ?? historyRecoveryIpcShutdown;
    const closingSubscriptionAuthenticationIpc = subscriptionAuthenticationIpc;
    subscriptionAuthenticationIpc = null;
    subscriptionAuthenticationShutdown =
      closingSubscriptionAuthenticationIpc?.dispose() ??
      subscriptionAuthenticationShutdown;
    appearancePreferenceIpc?.dispose();
    appearancePreferenceIpc = null;
    claudePermissionHandlingIpc?.dispose();
    claudePermissionHandlingIpc = null;
    runtimeExecutableIpc?.dispose();
    runtimeExecutableIpc = null;
    windowControlIpc?.dispose();
    windowControlIpc = null;
    clipboardIpc?.dispose();
    clipboardIpc = null;
    disposeNotificationIpcBinding();
    projectViewIpc?.dispose();
    projectViewIpc = null;
  },
  async closeBackend() {
    await subscriptionAuthenticationShutdown;
    await historyRecoveryIpcShutdown;
    try {
      await closeWorkbenchBackendAfterInitialization(
        backendInitialization,
        () => {
          const closingBackend = backend;
          const closingCreateProjectController = createProjectController;
          const closingAppearancePreferenceStore = appearancePreferenceStore;
          backend = null;
          createProjectController = undefined;
          appearancePreferenceStore = null;
          if (
            closingBackend === null &&
            closingCreateProjectController === undefined &&
            closingAppearancePreferenceStore === null
          ) {
            return null;
          }
          return {
            async close() {
              try {
                await closingCreateProjectController?.close();
              } finally {
                try {
                  await closingBackend?.close();
                } finally {
                  await closingAppearancePreferenceStore?.close();
                }
              }
            },
          };
        },
      );
    } finally {
      const closingHistoryRecovery = historyRecovery;
      historyRecovery = null;
      await closingHistoryRecovery?.close();
    }
  },
  exit() {
    app.exit(0);
  },
});

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  startPrimaryWorkbench();
}

function startPrimaryWorkbench(): void {
  app.on("second-instance", () => windowRestorer.requestRestore());
  app.on("before-quit", lifecycle.handleBeforeQuit);
  app.whenReady().then(async () => {
  if (shutdownRequested) return;
  const distributionDirectory = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
  );
  const rendererPath = join(distributionDirectory, "renderer", "index.html");
  const preloadPath = join(distributionDirectory, "preload", "preload.cjs");
  const startupProjectDirectory = readSwitch("project-directory");
  const providerRequestBudget = loadProviderRequestBudgetForElectronMain({
    locator: readOptionalAttemptSwitch(PROVIDER_ATTEMPT_LOCATOR_SWITCH),
    protocol: readOptionalAttemptSwitch(PROVIDER_ATTEMPT_PROTOCOL_SWITCH),
    buildMarker: readOptionalAttemptSwitch(
      PROVIDER_ATTEMPT_BUILD_MARKER_SWITCH,
    ),
  });
  const electronUserDataDirectory = app.getPath("userData");
  const explicitUserDataDirectory = app.commandLine.hasSwitch("user-data-dir")
    ? app.commandLine.getSwitchValue("user-data-dir")
    : undefined;
  const projectHostDataDirectory = resolveConversationStoreRoot({
    platform: process.platform,
    roamingAppDataDirectory: process.env.APPDATA,
    windowsUserProfileDirectory: app.getPath("home"),
    electronUserDataDirectory,
    ...(explicitUserDataDirectory === undefined
      ? {}
      : { explicitUserDataDirectory }),
  });
  const recovery = createHistoricalRecoveryLibrary({
    dataDirectory: join(electronUserDataDirectory, "history-recovery-v1"),
    sourceDiscovery: createDeferredProductionHistoryRecoverySourceDiscovery({
      readAppDataDirectory: () => app.getPath("appData"),
      currentUserDataDirectory: electronUserDataDirectory,
    }),
    exportChooser: Object.freeze({
      async choose(options: {
        readonly suggestedName: string;
        readonly warning: "The exported copy may contain conversation history and private local metadata.";
      }) {
        const window = mainWindow;
        if (window === null || window.isDestroyed()) {
          throw new Error("history-recovery-window-unavailable");
        }
        return createElectronHistoryRecoveryExportChooser(window).choose(
          options,
        );
      },
    }),
  });
  historyRecovery = recovery;

  backendInitialization = (async () => {
    const startup = await startProjectHostAfterRecoveryPreparation({
      prepareRecovery: () => recovery.prepareLaunch(),
      shutdownStarted: () => shutdownRequested,
      async startProjectHost() {
        const authGeneration = createWorkLedgerAuthGenerationModule({
          dataDirectory: projectHostDataDirectory,
        });
        // One store for every adapter instance this process constructs, so
        // concurrent project hosts share a single durable capability file
        // (F220) beside the project ledgers, main-process-private.
        const claudeSessionCapabilityStore = createFileClaudeSessionCapabilityStore(
          join(projectHostDataDirectory, "claude-session-capabilities-v1.json"),
        );
        appearancePreferenceStore = createWorkbenchAppearancePreferenceStore({
          filePath: join(
            app.getPath("userData"),
            "workbench-appearance-preferences-v1.json",
          ),
        });
        const initializedPreferenceStore = appearancePreferenceStore;
        let host: WorkbenchProjectHost | null = null;
        try {
          host = await initializeWorkbenchProjectHost({
            isPackaged: app.isPackaged,
            userDataDirectory: electronUserDataDirectory,
            conversationStoreDirectory: projectHostDataDirectory,
            currentWorkingDirectory: process.cwd(),
            ...(startupProjectDirectory === undefined
              ? {}
              : { startupProjectDirectory }),
            async createProjectHost(startup) {
              const runtimeAdapter = await createProductionRuntimeEndpointAdapter({
                authGeneration,
                providerRequestBudget,
                claudeSessionCapabilityStore,
                claudePermissionHandling: {
                  async readPermissionMode() {
                    return (await initializedPreferenceStore.readClaudePermissionHandling()) ===
                      "without-asking"
                      ? "bypassPermissions"
                      : "manual";
                  },
                  requestToolPermission: requestClaudeToolPermission,
                },
                ...(app.isPackaged && startupProjectDirectory === undefined
                  ? {
                      blockedProjectDirectory: startup.fallbackProjectDirectory,
                      decorateDirectoryAdapter: (delegate) =>
                        createPackagedBootstrapRuntimeAdapter({
                          bootstrapProjectDirectory:
                            startup.fallbackProjectDirectory,
                          delegate,
                        }),
                    }
                  : {}),
              });
              return createWorkbenchProjectHost({
                ...startup,
                adapter: runtimeAdapter,
                authGeneration,
              });
            },
          });
        } catch {
          host = null;
        }
        return Object.freeze({ host, authGeneration });
      },
    });
    if (startup === null || shutdownRequested) return;
    backend = startup.host;
    const authGeneration = startup.authGeneration;

    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    Menu.setApplicationMenu(null);
    const windowOptions = {
      width: 1440,
      height: 900,
      minWidth: 360,
      minHeight: 640,
      frame: false,
      show: false,
      // {} for every launch the owner starts himself; an origin no monitor
      // covers for the isolated agent and test launches that asked for one.
      ...windowPlacementOptions(),
      title: "Synchronized Intellect Network",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        devTools: false,
      },
    };
    const acrylicWindowOptions = supportsAcrylicBackgroundMaterial()
      ? {
          backgroundColor: "#00000000",
          backgroundMaterial: "acrylic" as const,
        }
      : null;
    let createdWindow: BrowserWindow;
    let nativeMaterialState: NativeWindowMaterialState =
      acrylicWindowOptions === null ? "unavailable" : "undetermined";
    // Kept so the frame-suppression HRESULTs reach run-app.log. Taking .state
    // alone is what made F204 invisible for eight days.
    let nativeMaterialVerification: NativeWindowMaterialVerification | null =
      null;
    let nativeFrameReassertion: NativeWindowFrameReassertionInstallation | null =
      null;
    try {
      createdWindow = new BrowserWindow({
        ...windowOptions,
        ...(acrylicWindowOptions ?? {
          backgroundColor: designedWindowGround,
        }),
      });
      if (acrylicWindowOptions !== null) {
        nativeMaterialVerification =
          await configureWindowsAcrylicWindow(createdWindow);
        nativeMaterialState = nativeMaterialVerification.state;
      }
    } catch (error) {
      if (acrylicWindowOptions === null) throw error;
      nativeMaterialState = "unavailable";
      createdWindow = new BrowserWindow({
        ...windowOptions,
        backgroundColor: designedWindowGround,
      });
    }
    mainWindow = createdWindow;
    // F204. The launch-time suppression above is a one-shot; Windows repaints
    // the caption every time it recomputes the accent, which on a wallpaper
    // slideshow with AutoColorization is every ten minutes. Gated on the same
    // capability check as the launch-time probe (F79) and on nothing else, so
    // there is exactly one answer in this file to "does this build touch DWM".
    // Hooked immediately after window creation, before any further await, so a
    // colour change during startup is not missed.
    if (acrylicWindowOptions !== null) {
      nativeFrameReassertion = installNativeWindowFrameReassertion({
        window: createdWindow,
        report: (line) => console.info(line),
      });
    }
    restorableWindow = createdWindow;
    windowRestorer.windowAvailable();
    // A quit requested while no window could host its confirmation is resumed
    // here, now that one can. Not wired to the startup-failure window: that one
    // is never `mainWindow`, so the question would still have nowhere to go.
    lifecycle.handleWindowAvailable();
    const initializedBackend = backend;
    if (initializedBackend !== null) {
      const stateStore = await openWorkbenchCreateProjectStateStore({
        dataDirectory: projectHostDataDirectory,
      });
      if (stateStore.ok) {
        try {
          createProjectController =
            await createWorkbenchCreateProjectController({
              chooser: createElectronProjectSaveTargetChooser(createdWindow),
              filesystem: createNodeWorkbenchCreateProjectFilesystem(),
              stateStore: stateStore.store,
              host: initializedBackend,
            });
        } catch {
          await stateStore.store.close().catch(() => undefined);
        }
      }
    }
    if (shutdownRequested) return;
    const initializedAppearancePreferenceStore = appearancePreferenceStore;
    if (initializedAppearancePreferenceStore === null) return;
    // A path the user saved in an earlier session has to reach discovery
    // BEFORE the channel that serves catalog reads is installed. Pushed after,
    // a profile load could arrive first and the escape hatch would appear not to
    // work until the second launch after it was used.
    try {
      const storedExecutables =
        await initializedAppearancePreferenceStore.readRuntimeExecutables();
      setConfiguredRuntimeExecutable("codex", storedExecutables.codex);
      setConfiguredRuntimeExecutable("claude", storedExecutables.claude);
    } catch {
      // An unreadable store leaves discovery on its ordinary tiers. It must not
      // stop the Workbench from starting.
    }
    projectViewIpc = installWorkbenchProjectViewIpc({
      ipcMain,
      window: createdWindow,
      source: initializedBackend,
      directoryChooser: createElectronProjectDirectoryChooser(),
      createProjectController: createProjectController,
    });
    clipboardIpc = installWorkbenchClipboardIpc({
      ipcMain,
      window: createdWindow,
      clipboard,
    });
    notificationIpc = installWorkbenchNotificationIpc({
      ipcMain,
      window: createdWindow,
      notification: Notification,
      platform: process.platform,
    });
    historyRecoveryIpc = installHistoryRecoveryIpc({
      ipcMain,
      window: createdWindow,
      source: recovery,
    });
    windowControlIpc = installWorkbenchWindowControlIpc({
      ipcMain,
      window: createdWindow,
    });
    appearancePreferenceIpc = installWorkbenchAppearancePreferenceIpc({
      ipcMain,
      window: createdWindow,
      source: initializedAppearancePreferenceStore,
    });
    claudePermissionHandlingIpc = installWorkbenchClaudePermissionHandlingIpc({
      ipcMain,
      window: createdWindow,
      source: initializedAppearancePreferenceStore,
    });
    runtimeExecutableIpc = installWorkbenchRuntimeExecutableIpc({
      ipcMain,
      window: createdWindow,
      source: initializedAppearancePreferenceStore,
    });
    const subscriptionAuthenticationActionService =
      createSubscriptionAuthenticationService({
        providers: Object.freeze([
          createOfficialCodexSubscriptionAuthenticationProvider(
            undefined,
            providerRequestBudget,
          ),
          createOfficialClaudeSubscriptionAuthenticationProvider(
            undefined,
            providerRequestBudget,
          ),
        ]),
        timeoutMilliseconds: 600_000,
        inspectionTimeoutMilliseconds: 10_000,
      });
    const subscriptionAuthenticationService =
      createWorkbenchSubscriptionAuthenticationCoordinator({
        endpoints: Object.freeze([
          Object.freeze({
            endpointSelectionKey:
              WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
            endpointId: "codex-desktop" as const,
            label: "Codex" as const,
          }),
          Object.freeze({
            endpointSelectionKey:
              WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
            endpointId: "claude-code-desktop" as const,
            label: "Claude" as const,
          }),
        ]),
        authentication: subscriptionAuthenticationActionService,
        mutations: createWorkLedgerSubscriptionAuthenticationMutationAuthority({
          authGeneration,
          endpointSelections: new Map([
            [
              WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.codex,
              "codex-desktop" as const,
            ],
            [
              WORKBENCH_SUBSCRIPTION_AUTHENTICATION_ENDPOINT_SELECTIONS.claude,
              "claude-code-desktop" as const,
            ],
          ]),
        }),
      });
    subscriptionAuthenticationIpc =
      installWorkbenchSubscriptionAuthenticationActionIpc({
        ipcMain,
        window: createdWindow,
        source: subscriptionAuthenticationService,
      });

    const rendererUrl = pathToFileURL(rendererPath);
    rendererUrl.searchParams.set("material-state", nativeMaterialState);
    const presentWindowsAcrylic =
      shouldPresentWindowsAcrylic(nativeMaterialState);
    if (presentWindowsAcrylic) {
      rendererUrl.searchParams.set("material", "on");
    }
    const rendererHref = rendererUrl.toString();
    const openWorkbench = (): void => windowRestorer.requestRestore();
    try {
      tray = new Tray(createWorkbenchTrayIcon(nativeImage));
      tray.setToolTip("Synchronized Intellect Network");
      tray.on("click", openWorkbench);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "Open Synchronized Intellect Network",
            click: openWorkbench,
          },
          { type: "separator" },
          {
            label: "Quit",
            click() {
              app.quit();
            },
          },
        ]),
      );
    } catch {
      tray?.destroy();
      tray = null;
    }
    createdWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    createdWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== rendererHref) event.preventDefault();
    });
    reportWindowPlacement("main-window");
    createdWindow.once("ready-to-show", () => {
      // showInactive() never changes the foreground window. It is what an
      // offscreen launch must use; a launch the owner started still wants the
      // window in front of him.
      if (windowPlacement.kind === "offscreen") createdWindow.showInactive();
      else createdWindow.show();
    });
    createdWindow.on("close", lifecycle.handleWindowClose);
    createdWindow.on("query-session-end", lifecycle.handleQuerySessionEnd);
    createdWindow.on("session-end", lifecycle.handleSessionEnd);
    createdWindow.once("closed", () => {
      const closingHistoryRecoveryIpc = historyRecoveryIpc;
      historyRecoveryIpc = null;
      historyRecoveryIpcShutdown =
        closingHistoryRecoveryIpc?.dispose() ?? historyRecoveryIpcShutdown;
      const closingSubscriptionAuthenticationIpc =
        subscriptionAuthenticationIpc;
      subscriptionAuthenticationIpc = null;
      subscriptionAuthenticationShutdown =
        closingSubscriptionAuthenticationIpc?.dispose() ??
        subscriptionAuthenticationShutdown;
      appearancePreferenceIpc?.dispose();
      appearancePreferenceIpc = null;
      claudePermissionHandlingIpc?.dispose();
      claudePermissionHandlingIpc = null;
      runtimeExecutableIpc?.dispose();
      runtimeExecutableIpc = null;
      windowControlIpc?.dispose();
      windowControlIpc = null;
      nativeFrameReassertion?.dispose();
      nativeFrameReassertion = null;
      clipboardIpc?.dispose();
      clipboardIpc = null;
      disposeNotificationIpcBinding();
      projectViewIpc?.dispose();
      projectViewIpc = null;
      mainWindow = null;
      restorableWindow = null;
    });
    await createdWindow.loadURL(rendererHref).catch(() => undefined);
    console.info(formatNativeWindowMaterialDiagnostic(nativeMaterialState));
    console.info(
      formatNativeWindowFrameDiagnostic(nativeMaterialVerification),
    );
    console.info(formatNativeWindowFrameHookDiagnostic(nativeFrameReassertion));
  })();
  await backendInitialization.catch(() => undefined);
  // The await above deliberately swallows the reason. Re-read the settled
  // promise so an initialization that died before it could show a window is
  // still presented to the user instead of leaving a headless process.
  const initializationFailure = await backendInitialization.then(
    () => null,
    (error: unknown) => Object.freeze({ error }),
  );
  if (initializationFailure !== null && !shutdownRequested) {
    presentStartupFailure(initializationFailure.error);
  }
  }).catch((error: unknown) => {
    if (shutdownRequested) return;
    presentStartupFailure(error);
  });
}

/**
 * The startup failure boundary (`F117`).
 *
 * A throw anywhere on the startup path used to leave a live process with no
 * window, no tray and no menu — invisible, and unquittable short of Task
 * Manager. Whatever failed, the user must be left with something they can see
 * and something they can close.
 *
 * Closing the failure surface calls `app.exit`, which does not emit
 * `before-quit`. That is deliberate: this path never consults a backend that
 * failed to exist, and it never reaches the `before-quit` guard, whose
 * behaviour with no backend sits beside `D16.2` and is an owner decision.
 */
function presentStartupFailure(error: unknown): void {
  if (startupFailurePresented) return;
  startupFailurePresented = true;
  console.error(startupFailureHeading, error);
  const reason =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string" && error.length > 0
        ? error
        : "unknown-startup-failure";

  const existingWindow = mainWindow;
  if (existingWindow !== null && !existingWindow.isDestroyed()) {
    // A window already exists, so the ordinary window lifecycle already owns its
    // close and quit path. All that is missing is for the user to be able to see
    // it: a window that never reached "ready-to-show" was never shown.
    try {
      existingWindow.show();
      return;
    } catch {
      // Fall through to the dedicated failure surface.
    }
  }

  try {
    // Without this the default Electron menu survives, offering a Quit item that
    // routes through the guard and silently does nothing.
    Menu.setApplicationMenu(null);
  } catch {
    // The window frame still closes without a menu.
  }

  let failureWindow: BrowserWindow | null = null;
  try {
    failureWindow = new BrowserWindow({
      width: 720,
      height: 460,
      // Same rule as the main window: {} for the owner's own launch, an origin
      // no monitor covers plus focusable:false for an isolated agent or test
      // launch that asked for it. Still shown on creation either way, and a
      // non-focusable window cannot take the foreground when it is.
      ...windowPlacementOptions(),
      show: true,
      title: "Synchronized Intellect Network",
      backgroundColor: designedWindowGround,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        devTools: false,
      },
    });
  } catch {
    failureWindow = null;
  }

  if (failureWindow === null) {
    try {
      dialog.showErrorBox(startupFailureHeading, `${startupFailureAdvice}\n\n${reason}`);
    } catch {
      // The console diagnostic above is the last remaining surface.
    }
    disposeNotificationIpcBinding();
    app.exit(1);
    return;
  }

  const window = failureWindow;
  reportWindowPlacement("startup-failure-window");
  restorableWindow = window;
  windowRestorer.windowAvailable();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const exitAfterFailure = (): void => {
    disposeNotificationIpcBinding();
    app.exit(1);
  };
  window.on("close", exitAfterFailure);
  window.once("closed", exitAfterFailure);
  void window.loadURL(startupFailurePage(reason)).catch(() => undefined);
}

function startupFailurePage(reason: string): string {
  const page = [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" ",
    "content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    "<title>Synchronized Intellect Network</title><style>",
    `html,body{margin:0;height:100%;background:${designedWindowGround};color:#e9eaee;`,
    "font:14px/1.65 'Segoe UI',system-ui,sans-serif;}",
    "main{box-sizing:border-box;padding:36px;max-width:660px;}",
    "h1{font-size:19px;font-weight:600;margin:0 0 14px;}",
    "p{margin:0 0 16px;color:#a9adb8;}",
    "code{display:block;padding:12px 14px;border-radius:6px;",
    "background:rgba(255,255,255,.06);color:#e9eaee;",
    "white-space:pre-wrap;word-break:break-word;}",
    "</style></head><body><main>",
    `<h1>${escapeStartupFailureText(startupFailureHeading)}</h1>`,
    `<p>${escapeStartupFailureText(startupFailureAdvice)}</p>`,
    `<code>${escapeStartupFailureText(reason)}</code>`,
    "</main></body></html>",
  ].join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
}

function escapeStartupFailureText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readSwitch(name: string): string | undefined {
  const value = app.commandLine.getSwitchValue(name).trim();
  return value.length === 0 ? undefined : value;
}

function readOptionalAttemptSwitch(name: string): string | undefined {
  return app.commandLine.hasSwitch(name)
    ? app.commandLine.getSwitchValue(name)
    : undefined;
}

function supportsAcrylicBackgroundMaterial(): boolean {
  if (
    process.platform !== "win32" ||
    typeof BrowserWindow.prototype.setBackgroundMaterial !== "function"
  ) {
    return false;
  }
  try {
    const [major, , build] = process
      .getSystemVersion()
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    return (
      major !== undefined &&
      build !== undefined &&
      (major > 10 || (major === 10 && build >= 22_000))
    );
  } catch {
    return false;
  }
}
