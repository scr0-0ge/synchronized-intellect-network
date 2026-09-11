import { installWorkbenchSubscriptionUsageIpc } from "./subscription-usage-ipc.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  safeStorage,
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
  createWorkbenchGlmEndpointKeySource,
  endpointSecretEnvelopeStorePath,
  GLM_ENDPOINT_KEY_SUBJECT,
  type WorkbenchEndpointKeySource,
} from "../glm-endpoint-key.ts";
import {
  createWorkbenchKimiEndpointKeySource,
  KIMI_ENDPOINT_KEY_SUBJECT,
} from "../kimi-endpoint-key.ts";
import {
  createWorkbenchDeepseekEndpointKeySource,
  DEEPSEEK_ENDPOINT_KEY_SUBJECT,
} from "../deepseek-endpoint-key.ts";
import {
  createWorkbenchKimiPlatformKeySource,
  KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
} from "../kimi-platform-key.ts";
import {
  createWorkbenchClaudeApiEndpointKeySource,
  CLAUDE_API_ENDPOINT_KEY_SUBJECT,
} from "../claude-api-endpoint-key.ts";
import {
  createWorkbenchCodexApiEndpointKeySource,
  CODEX_API_ENDPOINT_KEY_SUBJECT,
} from "../codex-api-endpoint-key.ts";
import { CODEX_API_ENDPOINT_ENV_CONTRACT } from "../../agent-runtime/codex/endpoint-env-factory.ts";
import {
  createEndpointCatalogFreshnessService,
  type EndpointCatalogFreshnessService,
} from "../endpoint-catalog-freshness.ts";
import {
  createCliUpdateService,
  type CliUpdateService,
} from "../cli-update-check.ts";
import {
  installWorkbenchCliUpdateIpc,
  type WorkbenchCliUpdateIpcBinding,
} from "../cli-update-ipc.ts";
import { GLM_ENDPOINT_ENV_CONTRACT } from "../../agent-runtime/claude/endpoint-env-factory.ts";
import { DEEPSEEK_ENDPOINT_ENV_CONTRACT } from "../../agent-runtime/claude/deepseek-catalog.ts";
import { EndpointSecretEnvelopeStore } from "../endpoint-secret-envelope-store.ts";
import {
  createWorkbenchCreateProjectController,
  type WorkbenchCreateProjectController,
} from "../create-project-controller.ts";
import { createNodeWorkbenchCreateProjectFilesystem } from "../create-project-filesystem.ts";
import { openWorkbenchCreateProjectStateStore } from "../create-project-store.ts";
import { resolveConversationStoreRoot } from "../conversation-store-root.ts";
import { migrateRenamedSettings, type RenameSettingsNotice } from "../rename-settings-migration.ts";
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
  installWorkbenchEndpointKeyIpc,
  type WorkbenchEndpointKeyIpcBinding,
} from "./endpoint-key-ipc.ts";
import {
  installWorkbenchEndpointCatalogFreshnessIpc,
  type WorkbenchEndpointCatalogFreshnessIpcBinding,
} from "./endpoint-catalog-freshness-ipc.ts";
import {
  installWorkbenchClaudePermissionHandlingIpc,
  type WorkbenchClaudePermissionHandlingIpcBinding,
} from "./claude-permission-handling-ipc.ts";
import {
  installWorkbenchCodexApiBaseUrlIpc,
  type WorkbenchCodexApiBaseUrlIpcBinding,
} from "./codex-api-base-url-ipc.ts";
import {
  installWorkbenchEndpointPreferenceIpc,
  type WorkbenchEndpointPreferenceIpcBinding,
} from "./endpoint-preference-ipc.ts";
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
  closeDurableStateAfterListenerShutdown,
  runWorkbenchTeardownSteps,
  type WorkbenchTeardownFailure,
} from "./binding-teardown.ts";
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

app.setName("synchronized-intellect-network");
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
let nativeFrameReassertion: NativeWindowFrameReassertionInstallation | null =
  null;
let appearancePreferenceIpc: WorkbenchAppearancePreferenceIpcBinding | null =
  null;
let claudePermissionHandlingIpc: WorkbenchClaudePermissionHandlingIpcBinding | null =
  null;
let codexApiBaseUrlIpc: WorkbenchCodexApiBaseUrlIpcBinding | null = null;
let subscriptionUsageIpc: ReturnType<typeof installWorkbenchSubscriptionUsageIpc> | null = null;
let endpointPreferenceIpc: WorkbenchEndpointPreferenceIpcBinding | null =
  null;
let endpointKeyIpc: WorkbenchEndpointKeyIpcBinding[] = [];
let endpointCatalogFreshnessIpc: WorkbenchEndpointCatalogFreshnessIpcBinding | null =
  null;
let cliUpdateService: CliUpdateService | null = null;
let cliUpdateIpc: WorkbenchCliUpdateIpcBinding | null = null;
// One key source per static-key endpoint (GLM, Kimi, DeepSeek), each bound
// to its own envelope subject over the one shared store file.
let glmEndpointKeySource: WorkbenchEndpointKeySource | null = null;
let kimiEndpointKeySource: WorkbenchEndpointKeySource | null = null;
let deepseekEndpointKeySource: WorkbenchEndpointKeySource | null = null;
let kimiPlatformEndpointKeySource: WorkbenchEndpointKeySource | null = null;
let claudeApiEndpointKeySource: WorkbenchEndpointKeySource | null = null;
let codexApiEndpointKeySource: WorkbenchEndpointKeySource | null = null;
// In-memory mirror of the preference store's codex-api base URL (w223), kept
// current by hydration at startup and every successful save. Sync reads let
// the codex-api key source's "Test connection" probe use the saved override
// without giving the probe's base-URL resolver a disk read on every call --
// the store itself stays the single source of truth; this is a read cache.
let codexApiBaseUrlOverride = "";
let endpointCatalogFreshnessService: EndpointCatalogFreshnessService | null =
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
  // Cleared before it is disposed, so a dispose that fails cannot leave the
  // binding live for a second attempt (issue 172).
  const closing = notificationIpc;
  notificationIpc = null;
  closing?.dispose();
}

function reportTeardownFailure(failure: WorkbenchTeardownFailure): void {
  // Reaches `run-app.log` beside the launch diagnostics. A teardown failure
  // that vanishes is how a visible race becomes a silent one.
  console.error(`[teardown] step=${failure.name} failed`, failure.error);
}

/*
 * The one list of bindings the main window owns, and the one place it runs.
 *
 * The lifecycle drain and the window's own "closed" handler both need this, in
 * either order. They used to hold two hand-maintained copies of it that had
 * drifted apart — the drain's omitted `nativeFrameReassertion` — and each ran
 * its copy as a plain statement sequence, so one `dispose()` throwing abandoned
 * every later binding. Every step here clears its slot before disposing, which
 * makes a second run a no-op, and the steps are run independently, which stops
 * one failure from cancelling nine unrelated ones.
 */
function disposeWindowScopedBindings(): void {
  runWorkbenchTeardownSteps(
    [
      {
        name: "historyRecoveryIpc",
        run() {
          const closing = historyRecoveryIpc;
          historyRecoveryIpc = null;
          historyRecoveryIpcShutdown =
            closing?.dispose() ?? historyRecoveryIpcShutdown;
        },
      },
      {
        name: "subscriptionAuthenticationIpc",
        run() {
          const closing = subscriptionAuthenticationIpc;
          subscriptionAuthenticationIpc = null;
          subscriptionAuthenticationShutdown =
            closing?.dispose() ?? subscriptionAuthenticationShutdown;
        },
      },
      {
        name: "appearancePreferenceIpc",
        run() {
          const closing = appearancePreferenceIpc;
          appearancePreferenceIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "claudePermissionHandlingIpc",
        run() {
          const closing = claudePermissionHandlingIpc;
          claudePermissionHandlingIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "codexApiBaseUrlIpc",
        run() {
          const closing = codexApiBaseUrlIpc;
          codexApiBaseUrlIpc = null;
          closing?.dispose();
        },
      },
      // main-resync: the lane's window-scoped bindings ride the same one list
      // (family endpoint preferences, the per-endpoint key bindings, catalog
      // freshness, CLI update) so they gain the per-step isolation this module
      // exists to provide instead of a second hand-maintained sequence.
      {
        name: "subscriptionUsageIpc",
        run() {
          const closing = subscriptionUsageIpc;
          subscriptionUsageIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "endpointPreferenceIpc",
        run() {
          const closing = endpointPreferenceIpc;
          endpointPreferenceIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "endpointKeyIpc",
        run() {
          const closing = endpointKeyIpc;
          endpointKeyIpc = [];
          for (const binding of closing) binding.dispose();
        },
      },
      {
        name: "endpointCatalogFreshnessIpc",
        run() {
          const closing = endpointCatalogFreshnessIpc;
          endpointCatalogFreshnessIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "cliUpdateIpc",
        run() {
          const closing = cliUpdateIpc;
          cliUpdateIpc = null;
          closing?.dispose();
          cliUpdateService = null;
        },
      },
      {
        name: "runtimeExecutableIpc",
        run() {
          const closing = runtimeExecutableIpc;
          runtimeExecutableIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "windowControlIpc",
        run() {
          const closing = windowControlIpc;
          windowControlIpc = null;
          closing?.dispose();
        },
      },
      {
        name: "nativeFrameReassertion",
        run() {
          const closing = nativeFrameReassertion;
          nativeFrameReassertion = null;
          closing?.dispose();
        },
      },
      {
        name: "clipboardIpc",
        run() {
          const closing = clipboardIpc;
          clipboardIpc = null;
          closing?.dispose();
        },
      },
      { name: "notificationIpc", run: disposeNotificationIpcBinding },
      {
        name: "projectViewIpc",
        run() {
          const closing = projectViewIpc;
          projectViewIpc = null;
          closing?.dispose();
        },
      },
    ],
    reportTeardownFailure,
  );
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
    disposeWindowScopedBindings();
  },
  async closeBackend() {
    await closeDurableStateAfterListenerShutdown({
      // Best-effort listener teardown. These used to be awaited here, in
      // sequence and outside the try below, so one rejecting `async dispose()`
      // skipped the whole flush and the drain exited anyway (issue 172).
      listenerShutdowns: [
        subscriptionAuthenticationShutdown,
        historyRecoveryIpcShutdown,
      ],
      report: reportTeardownFailure,
      closeDurableState: closeWorkbenchDurableState,
    });
  },
  exit() {
    app.exit(0);
  },
});

/** The mandatory half of the drain: everything that owes the user a flush. */
async function closeWorkbenchDurableState(): Promise<void> {
  try {
    await closeWorkbenchBackendAfterInitialization(backendInitialization, () => {
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
    });
  } finally {
    const closingHistoryRecovery = historyRecovery;
    historyRecovery = null;
    await closingHistoryRecovery?.close();
  }
}

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
  const renameSettingsNotice = await migrateRenamedSettings({
    userDataDirectory: electronUserDataDirectory,
    safeStorage,
    // CLI homes follow APPDATA, unlike preferences. An isolated profile must
    // not import the owner's CLI files when its environment was not isolated.
    ...(explicitUserDataDirectory === undefined
      ? { cliHomeBaseDirectory: process.env.APPDATA ?? tmpdir() }
      : process.env.APPDATA !== undefined &&
          resolve(process.env.APPDATA).toLowerCase() === dirname(electronUserDataDirectory).toLowerCase()
        ? { cliHomeBaseDirectory: dirname(electronUserDataDirectory) }
        : {}),
  });
  // Ordinary Windows launches anchor conversations to physical Roaming even
  // when Electron's Known Folders are redirected. Discover the same siblings.
  const recoveryUserDataDirectory = dirname(projectHostDataDirectory);
  const recovery = createHistoricalRecoveryLibrary({
    dataDirectory: join(electronUserDataDirectory, "history-recovery-v1"),
    sourceDiscovery: createDeferredProductionHistoryRecoverySourceDiscovery({
      readAppDataDirectory: () =>
        process.platform === "win32" && explicitUserDataDirectory === undefined
          ? dirname(recoveryUserDataDirectory)
          : app.getPath("appData"),
      currentUserDataDirectory: recoveryUserDataDirectory,
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
  // w215 (issue #6). Thirteen window-scoped IPC bindings — up to six of them
  // parameterized per configured endpoint key — each install their own
  // terminal-lifecycle listener(s) directly on this window and its
  // webContents. First measured at startup in ao-0909-w48-listener-warning.md
  // (20 "closed" on the BrowserWindow, 18 "destroyed"/"render-process-gone"
  // on WebContents); re-measured on this branch in
  // ao-0911-w215-max-listeners.md as 21/19/19. Both measurements agree it is a
  // fixed, non-growing fan-out (five open/close Settings cycles left every
  // count unchanged, re-verified by
  // tests/e2e/w215-window-terminal-listener-fanout.ts), not a leak. Node's
  // default cap of 10 warns on a stranger's first run anyway. Raise the
  // ceiling to comfortably more than twice the largest measurement, so the
  // startup log stays clean while an actual runaway leak would still
  // eventually warn.
  const windowTerminalListenerCeiling = 40;
  createdWindow.setMaxListeners(windowTerminalListenerCeiling);
  createdWindow.webContents.setMaxListeners(windowTerminalListenerCeiling);
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
  const rendererUrl = pathToFileURL(rendererPath);
  rendererUrl.searchParams.set("material-state", nativeMaterialState);
  const presentWindowsAcrylic =
    shouldPresentWindowsAcrylic(nativeMaterialState);
  if (presentWindowsAcrylic) {
    rendererUrl.searchParams.set("material", "on");
  }
  const rendererHref = rendererUrl.toString();
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  createdWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererHref) event.preventDefault();
  });
  createdWindow.once("ready-to-show", () => {
    if (windowPlacement.kind === "offscreen") createdWindow.showInactive();
    else createdWindow.show();
  });
  createdWindow.on("close", lifecycle.handleWindowClose);
  createdWindow.on("query-session-end", lifecycle.handleQuerySessionEnd);
  createdWindow.on("session-end", lifecycle.handleSessionEnd);
  createdWindow.once("closed", () => {
    disposeWindowScopedBindings();
    mainWindow = null;
    restorableWindow = null;
  });
  const rendererLoad = createdWindow
    .loadURL(rendererHref)
    .catch(() => undefined);
  // The window is created and shown here, before the recovery barrier below,
  // because nothing it needs is behind that barrier. Owner-only ACL
  // establishment is ~7 s of a launch on this machine; waiting for it left the
  // owner looking at no window at all for that long. Anything that genuinely
  // needs the capture to have happened first still waits: the Project host and
  // its ledgers are opened after the barrier, exactly as before.
  if (windowPlacement.kind === "offscreen") createdWindow.showInactive();
  else createdWindow.show();

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
        codexApiBaseUrlOverride =
          await appearancePreferenceStore.readCodexApiBaseUrl();
        // One shared secret-envelope store FILE for every API-transport
        // endpoint key (ADR 0022 multi-subject shape), platform-encrypted via
        // Electron safeStorage, beside the other userData stores. Each
        // endpoint gets its own store INSTANCE so every envelope is bound to
        // its endpoint's subject; the store re-reads the whole file per
        // operation and rewrites it atomically, so single-threaded
        // read-modify-write keeps the subjects from clobbering each other.
        const endpointSecretStorePath = endpointSecretEnvelopeStorePath(
          app.getPath("userData"),
        );
        const glmEndpointSecretEnvelopeStore = new EndpointSecretEnvelopeStore({
          subject: GLM_ENDPOINT_KEY_SUBJECT,
          safeStorage,
          storePath: endpointSecretStorePath,
        });
        const kimiEndpointSecretEnvelopeStore = new EndpointSecretEnvelopeStore({
          subject: KIMI_ENDPOINT_KEY_SUBJECT,
          safeStorage,
          storePath: endpointSecretStorePath,
        });
        const deepseekEndpointSecretEnvelopeStore =
          new EndpointSecretEnvelopeStore({
            subject: DEEPSEEK_ENDPOINT_KEY_SUBJECT,
            safeStorage,
            storePath: endpointSecretStorePath,
          });
        const kimiPlatformEndpointSecretEnvelopeStore =
          new EndpointSecretEnvelopeStore({
            subject: KIMI_PLATFORM_ENDPOINT_KEY_SUBJECT,
            safeStorage,
            storePath: endpointSecretStorePath,
          });
        const claudeApiEndpointSecretEnvelopeStore =
          new EndpointSecretEnvelopeStore({
            subject: CLAUDE_API_ENDPOINT_KEY_SUBJECT,
            safeStorage,
            storePath: endpointSecretStorePath,
          });
        const codexApiEndpointSecretEnvelopeStore =
          new EndpointSecretEnvelopeStore({
            subject: CODEX_API_ENDPOINT_KEY_SUBJECT,
            safeStorage,
            storePath: endpointSecretStorePath,
          });
        glmEndpointKeySource = createWorkbenchGlmEndpointKeySource({
          store: glmEndpointSecretEnvelopeStore,
          environment: process.env,
        });
        kimiEndpointKeySource = createWorkbenchKimiEndpointKeySource({
          store: kimiEndpointSecretEnvelopeStore,
          environment: process.env,
        });
        deepseekEndpointKeySource = createWorkbenchDeepseekEndpointKeySource({
          store: deepseekEndpointSecretEnvelopeStore,
          environment: process.env,
        });
        kimiPlatformEndpointKeySource = createWorkbenchKimiPlatformKeySource({
          store: kimiPlatformEndpointSecretEnvelopeStore,
          environment: process.env,
        });
        claudeApiEndpointKeySource = createWorkbenchClaudeApiEndpointKeySource({
          store: claudeApiEndpointSecretEnvelopeStore,
          environment: process.env,
        });
        codexApiEndpointKeySource = createWorkbenchCodexApiEndpointKeySource({
          store: codexApiEndpointSecretEnvelopeStore,
          environment: process.env,
          // "Test connection" honors the saved override (w223) over the
          // env-var / contract default, same precedence prepareEndpoint uses.
          probeBaseUrl: (environment) =>
            codexApiBaseUrlOverride.trim().length > 0
              ? codexApiBaseUrlOverride
              : (environment[CODEX_API_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar]
                  ?.trim() || CODEX_API_ENDPOINT_ENV_CONTRACT.defaultBaseUrl),
        });
        // Catalog freshness (ticket 14 / WO16 Part 3): zero-inference
        // /models pulls over the same key sources; enrollment persists
        // beside the other userData stores; every failure stays silent.
        // Kimi Code is intentionally absent: its subscription face has no
        // verified zero-inference models-list route. The two Moonshot
        // Platform faces in endpoint-models-list.ts accept Platform keys,
        // never Kimi Code subscription tokens.
        const initializedGlmKeySource = glmEndpointKeySource;
        const initializedDeepseekKeySource = deepseekEndpointKeySource;
        endpointCatalogFreshnessService = createEndpointCatalogFreshnessService({
          storeDirectory: app.getPath("userData"),
          environment: process.env,
          endpoints: Object.freeze([
            Object.freeze({
              endpointId: "glm-coding-plan" as const,
              face: "glm-anthropic" as const,
              resolveBaseUrl: (environment: NodeJS.ProcessEnv) =>
                resolveContractBaseUrl(environment, GLM_ENDPOINT_ENV_CONTRACT),
              staticCatalogModelIds: [],
              resolveToken: () => initializedGlmKeySource?.resolve(),
            }),
            Object.freeze({
              endpointId: "deepseek-api" as const,
              face: "deepseek" as const,
              // The pull lives on the platform face; strip the anthropic
              // face suffix the sessions use (same rule as the probe).
              resolveBaseUrl: (environment: NodeJS.ProcessEnv) =>
                resolveContractBaseUrl(
                  environment,
                  DEEPSEEK_ENDPOINT_ENV_CONTRACT,
                ).replace(/\/anthropic\/?$/u, ""),
              staticCatalogModelIds: [],
              resolveToken: () => initializedDeepseekKeySource?.resolve(),
            }),
          ]),
        });
        // Startup background pull: silent by design — the promise is
        // intentionally never awaited and never surfaces a rejection.
        void endpointCatalogFreshnessService
          .refresh()
          .then(() => undefined, () => undefined);
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
                async observeClaudeSubscriptionUsage(observation) {
                  try {
                    const stored = await appearancePreferenceStore!.saveClaudeSubscriptionUsage(observation);
                    subscriptionUsageIpc?.publish({ ok: true, observation: stored });
                  } catch {
                    subscriptionUsageIpc?.publish({ ok: false });
                  }
                },
                resolveGlmAuthToken: () => glmEndpointKeySource?.resolve(),
                resolveKimiAuthToken: () => kimiEndpointKeySource?.resolve(),
                resolveDeepseekAuthToken: () =>
                  deepseekEndpointKeySource?.resolve(),
                resolveKimiPlatformApiKey: () =>
                  kimiPlatformEndpointKeySource?.resolve(),
                resolveClaudeApiKey: () => claudeApiEndpointKeySource?.resolve(),
                resolveCodexApiKey: () => codexApiEndpointKeySource?.resolve(),
                resolveCodexApiBaseUrl: () => codexApiBaseUrlOverride,
                catalogAugmentation: (endpointId) =>
                  endpointId === "kimi-code"
                    ? []
                    : endpointCatalogFreshnessService?.augmentedModels(
                        endpointId as "glm-coding-plan" | "deepseek-api",
                      ) ?? [],
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
        } catch (error) {
          // The conversation store did not open. The application carries on
          // with `backend === null`, which turns every project operation into
          // `status: "unavailable"` — and this catch used to drop the reason,
          // so nothing anywhere said which storage failure it was. Recorded
          // here beside the launch diagnostics so `run-app.log` names it.
          //
          // Only half of worker 478's Tier-1: the user is still told nothing
          // beyond a generic unavailability. Carrying a cause and a next step
          // to the renderer means widening the project-view contract, and
          // whether a storage failure should be fatal at all is an owner
          // decision (it sits beside `D16.2`). Not taken here.
          console.error(
            "[startup] the conversation store could not be opened; project operations will report unavailable",
            error,
          );
          host = null;
        }
        return Object.freeze({ host, authGeneration });
      },
    });
    if (startup === null || shutdownRequested) return;
    backend = startup.host;
    const authGeneration = startup.authGeneration;

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
    codexApiBaseUrlIpc = installWorkbenchCodexApiBaseUrlIpc({
      ipcMain,
      window: createdWindow,
      source: {
        readCodexApiBaseUrl: () =>
          initializedAppearancePreferenceStore.readCodexApiBaseUrl(),
        async saveCodexApiBaseUrl(baseUrl: string): Promise<string> {
          const saved =
            await initializedAppearancePreferenceStore.saveCodexApiBaseUrl(
              baseUrl,
            );
          // Keep the sync probe/prepare cache current the moment a save
          // durably lands (w223); it is the only mirror they read from.
          codexApiBaseUrlOverride = saved;
          return saved;
        },
      },
    });
    subscriptionUsageIpc = installWorkbenchSubscriptionUsageIpc({
      ipcMain,
      window: createdWindow,
      source: initializedAppearancePreferenceStore,
    });
    endpointPreferenceIpc = installWorkbenchEndpointPreferenceIpc({
      ipcMain,
      window: createdWindow,
      source: initializedAppearancePreferenceStore,
    });
    runtimeExecutableIpc = installWorkbenchRuntimeExecutableIpc({
      ipcMain,
      window: createdWindow,
      source: initializedAppearancePreferenceStore,
    });
    // One parameterized key-IPC binding per static-key endpoint; each binding
    // owns its endpoint-scoped channels and dies with the window.
    endpointKeyIpc = [
      glmEndpointKeySource === null
        ? null
        : installWorkbenchEndpointKeyIpc({
            ipcMain,
            window: createdWindow,
            endpointId: "glm-coding-plan",
            source: glmEndpointKeySource,
          }),
      kimiEndpointKeySource === null
        ? null
        : installWorkbenchEndpointKeyIpc({
            ipcMain,
            window: createdWindow,
            endpointId: "kimi-code",
            source: kimiEndpointKeySource,
          }),
      deepseekEndpointKeySource === null
        ? null
        : installWorkbenchEndpointKeyIpc({
            ipcMain,
            window: createdWindow,
            endpointId: "deepseek-api",
            source: deepseekEndpointKeySource,
          }),
      kimiPlatformEndpointKeySource === null
        ? null
        : installWorkbenchEndpointKeyIpc({
            ipcMain,
            window: createdWindow,
            endpointId: "kimi-platform",
            source: kimiPlatformEndpointKeySource,
          }),
      claudeApiEndpointKeySource === null
        ? null
        : installWorkbenchEndpointKeyIpc({
            ipcMain,
            window: createdWindow,
            endpointId: "claude-api",
            source: claudeApiEndpointKeySource,
          }),
      codexApiEndpointKeySource === null
        ? null
        : installWorkbenchEndpointKeyIpc({
            ipcMain,
            window: createdWindow,
            endpointId: "codex-api",
            source: codexApiEndpointKeySource,
          }),
    ].filter((binding): binding is WorkbenchEndpointKeyIpcBinding => {
      return binding !== null;
    });
    if (endpointCatalogFreshnessService !== null) {
      endpointCatalogFreshnessIpc = installWorkbenchEndpointCatalogFreshnessIpc({
        ipcMain,
        window: createdWindow,
        service: endpointCatalogFreshnessService,
      });
    }
    // CLI updates (ticket 18): the zero-side-effect check runs once in the
    // background at startup (memoized; failures stay silent — the winget
    // query is read-only), and the run channel exists only for the
    // Settings button. Updates are never spawned automatically.
    cliUpdateService = createCliUpdateService();
    void cliUpdateService
      .check()
      .then(() => undefined, () => undefined);
    cliUpdateIpc = installWorkbenchCliUpdateIpc({
      ipcMain,
      window: createdWindow,
      service: cliUpdateService,
      // The "restart now" action (ticket 21 cleanup) registers a successor,
      // then uses before-quit's durable drain. Direct app.exit() would skip it.
      requestRelaunch: () => {
        app.relaunch();
        app.quit();
      },
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
    reportWindowPlacement("main-window");
    await rendererLoad;
    if (renameSettingsNotice !== null && !shutdownRequested) {
      await presentRenameSettingsNotice(createdWindow, renameSettingsNotice);
    }
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

/** A real, one-time surface; offscreen QA obeys the same placement as the app. */
async function presentRenameSettingsNotice(parent: BrowserWindow, notice: RenameSettingsNotice): Promise<void> {
  const window = new BrowserWindow({
    parent,
    modal: true,
    width: 780,
    height: 640,
    show: false,
    ...windowPlacementOptions(),
    title: "Your settings after the rename",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === "https://workbench.invalid/acknowledge-rename") {
      void notice.acknowledge().then(() => window.close()).catch(error => {
        console.error("[rename-settings] Could not remember acknowledgement", error);
        window.close(); // The pending record will show the explanation next launch.
      });
    }
  });
  window.once("ready-to-show", () => {
    if (windowPlacement.kind === "offscreen") window.showInactive();
    else window.show();
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Your settings after the rename</title><style>
    html,body{height:100%;margin:0}body{box-sizing:border-box;display:flex;flex-direction:column;padding:24px;font:15px/1.5 'Segoe UI',sans-serif;color:#1e2630;background:#fff}
    h1{font-size:22px;margin:0 0 14px}main{overflow:auto;flex:1}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}footer{padding-top:16px}
    a{display:inline-block;font:inherit;padding:8px 24px;border:1px solid #555;border-radius:4px;color:inherit;text-decoration:none}
    </style></head><body><h1>${notice.warning ? "Some previous settings need attention" : "Your settings after the rename"}</h1>
    <main><pre>${escapeStartupFailureText(notice.detail)}</pre></main>
    <footer><a role="button" href="https://workbench.invalid/acknowledge-rename">Continue</a></footer></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
    // it: a window that never reached "ready-to-show" was never shown. The
    // renderer may already show its loading state, but an initialization
    // rejection means that state can never resolve, so replace it with the
    // failure reason instead of leaving the user waiting forever.
    try {
      existingWindow.show();
      void existingWindow
        .loadURL(startupFailurePage(reason))
        .catch(() => undefined);
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

/** Env override > contract default, for the freshness pull's base URL. */
function resolveContractBaseUrl(
  environment: NodeJS.ProcessEnv,
  contract: { readonly baseUrlEnvVar: string; readonly defaultBaseUrl: string },
): string {
  const explicit = environment[contract.baseUrlEnvVar];
  return typeof explicit === "string" && explicit.trim().length > 0
    ? explicit
    : contract.defaultBaseUrl;
}

function readSwitch(name: string): string | undefined {  const value = app.commandLine.getSwitchValue(name).trim();
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
