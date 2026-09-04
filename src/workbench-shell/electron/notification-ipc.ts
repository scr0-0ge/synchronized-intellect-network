import {
  WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
  publicTurnNotificationNotShown,
  publicTurnNotificationShown,
  reconstructWorkbenchTurnNotificationRequest,
} from "../notification-bridge.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

export interface WorkbenchNotificationRendererSender {
  isDestroyed(): boolean;
  on(event: string, listener: BoundaryListener): void;
  removeListener(event: string, listener: BoundaryListener): void;
}

export interface WorkbenchNotificationWindowBoundary {
  readonly webContents: WorkbenchNotificationRendererSender;
  on(event: "closed", listener: BoundaryListener): void;
  removeListener(event: "closed", listener: BoundaryListener): void;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface WorkbenchSystemNotificationInstance {
  on(
    event: "click" | "close" | "failed",
    listener: BoundaryListener,
  ): WorkbenchSystemNotificationInstance;
  removeListener(
    event: "click" | "close" | "failed",
    listener: BoundaryListener,
  ): void;
  show(): void;
  close(): void;
}

export interface WorkbenchSystemNotificationBoundary {
  new (options: {
    readonly title: string;
    readonly body: string;
  }): WorkbenchSystemNotificationInstance;
  isSupported(): boolean;
}

export interface WorkbenchNotificationIpcMainBoundary {
  handle(
    channel: typeof WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
    listener: BoundaryListener,
  ): void;
  removeHandler(channel: typeof WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL): void;
}

export interface WorkbenchNotificationIpcBinding {
  dispose(): void;
}

/**
 * One-shot system toast authority for Agent turn completion.
 *
 * The main process keeps no turn state: the renderer decides that a command
 * reached a terminal outcome while the user could not see it, and calls once.
 * This side only re-checks the window focus, degrades silently when the OS
 * cannot show notifications, and focuses the window when a toast is clicked.
 */
export function installWorkbenchNotificationIpc(options: {
  readonly ipcMain: WorkbenchNotificationIpcMainBoundary;
  readonly window: WorkbenchNotificationWindowBoundary;
  readonly notification: WorkbenchSystemNotificationBoundary;
  readonly platform: NodeJS.Platform;
}): WorkbenchNotificationIpcBinding {
  let disposed = false;
  let actionOpen = true;
  const liveNotifications = new Map<
    WorkbenchSystemNotificationInstance,
    Readonly<{
      onClick: BoundaryListener;
      onClose: BoundaryListener;
      onFailed: BoundaryListener;
    }>
  >();

  const releaseNotification = (
    toast: WorkbenchSystemNotificationInstance,
    closeNativeNotification: boolean,
  ): void => {
    const listeners = liveNotifications.get(toast);
    liveNotifications.delete(toast);
    if (listeners !== undefined) {
      removeNotificationListener(toast, "click", listeners.onClick);
      removeNotificationListener(toast, "close", listeners.onClose);
      removeNotificationListener(toast, "failed", listeners.onFailed);
    }
    if (!closeNativeNotification) return;
    try {
      toast.close();
    } catch {
      // Native teardown is best-effort; ownership is already released.
    }
  };

  const closeNotificationAuthority = (): void => {
    actionOpen = false;
    for (const toast of [...liveNotifications.keys()]) {
      releaseNotification(toast, true);
    }
  };

  const notifyHandler: BoundaryListener = (...values) => {
    if (disposed || !actionOpen) {
      return publicTurnNotificationNotShown("bridge-closed");
    }
    const sender = owningSender(values[0], options.window);
    const request = reconstructWorkbenchTurnNotificationRequest(values[1]);
    if (
      values.length !== 2 ||
      sender === undefined ||
      sender.isDestroyed() ||
      !request.ok
    ) {
      return publicTurnNotificationNotShown("invalid-request");
    }
    let toast: WorkbenchSystemNotificationInstance | undefined;
    try {
      if (options.window.isFocused()) {
        return publicTurnNotificationNotShown("window-focused");
      }
      if (
        typeof options.notification.isSupported !== "function" ||
        !options.notification.isSupported()
      ) {
        return publicTurnNotificationNotShown("notifications-unavailable");
      }
      toast = new options.notification({
        title: request.value.title,
        body: request.value.body,
      });
      const ownedToast = toast;
      const onClick: BoundaryListener = (): void => {
        releaseNotification(ownedToast, false);
        focusMainWindow(options.window);
      };
      const onClose: BoundaryListener = (): void => {
        if (options.platform === "win32") {
          // Electron can emit `close` when a Windows banner times out while the
          // notification remains clickable in Action Center. Retire only this
          // unreliable signal; click/failed/dispose still own the toast.
          removeNotificationListener(ownedToast, "close", onClose);
          return;
        }
        releaseNotification(ownedToast, false);
      };
      const onFailed: BoundaryListener = (): void => {
        releaseNotification(ownedToast, false);
      };
      liveNotifications.set(
        ownedToast,
        Object.freeze({ onClick, onClose, onFailed }),
      );
      toast.on("click", onClick);
      toast.on("close", onClose);
      toast.on("failed", onFailed);
      toast.show();
      return publicTurnNotificationShown();
    } catch {
      if (toast !== undefined) {
        releaseNotification(toast, true);
      }
      return publicTurnNotificationNotShown("notifications-unavailable");
    }
  };

  const terminalLifecycleListener: BoundaryListener = () => {
    closeNotificationAuthority();
  };

  options.ipcMain.handle(
    WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL,
    notifyHandler,
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
      closeNotificationAuthority();
      options.ipcMain.removeHandler(WORKBENCH_NOTIFY_TURN_COMPLETED_CHANNEL);
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

function removeNotificationListener(
  toast: WorkbenchSystemNotificationInstance,
  event: "click" | "close" | "failed",
  listener: BoundaryListener,
): void {
  try {
    toast.removeListener(event, listener);
  } catch {
    // A broken native listener cannot retain JavaScript ownership.
  }
}

function focusMainWindow(window: WorkbenchNotificationWindowBoundary): void {
  try {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } catch {
    // A destroyed window cannot be focused; nothing else to do.
  }
}

function owningSender(
  value: unknown,
  window: WorkbenchNotificationWindowBoundary,
): WorkbenchNotificationRendererSender | undefined {
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
