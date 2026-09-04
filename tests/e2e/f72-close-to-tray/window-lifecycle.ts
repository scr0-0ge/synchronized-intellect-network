import type { ElectronApplication } from "playwright";

export interface WindowSnapshot {
  readonly count: number;
  readonly id: number;
  readonly webContentsId: number;
  readonly destroyed: boolean;
  readonly visible: boolean;
  readonly url: string;
}

export async function captureWindow(
  application: ElectronApplication,
): Promise<WindowSnapshot> {
  return application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const window = windows[0];
    if (window === undefined) throw new Error("f72-window-missing");
    return {
      count: windows.length,
      id: window.id,
      webContentsId: window.webContents.id,
      destroyed: window.isDestroyed(),
      visible: window.isVisible(),
      url: window.webContents.getURL(),
    };
  });
}

export async function waitForMainWindow(
  application: ElectronApplication,
  predicate: (window: WindowSnapshot) => boolean,
  timeoutMilliseconds = 10_000,
): Promise<WindowSnapshot> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const window = await captureWindow(application);
    if (predicate(window)) return window;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("f72-main-window-condition-timeout");
}
