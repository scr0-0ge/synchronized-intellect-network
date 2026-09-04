import {
  WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
  type HistoryRecoveryActionResult,
  type HistoryRecoveryBrowseResult,
  type HistoryRecoveryCancelResult,
  type HistoryRecoverySnapshotResult,
} from "../history-recovery-contract.ts";
import type { HistoricalRecoveryLibrary } from "../history-recovery.ts";
import {
  failedAction,
  reconstructHistoryRecoveryBrowseRequest,
  reconstructHistoryRecoveryCancelRequest,
  reconstructHistoryRecoveryPerformRequest,
  reconstructHistoryRecoverySnapshotRequest,
  unavailableBrowse,
  unavailableSnapshot,
} from "../history-recovery-sanitizer.ts";
import type {
  BrowserWindowBoundary,
  RendererSender,
} from "./project-view-ipc.ts";

type HistoryRecoveryChannel =
  | typeof WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL
  | typeof WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL
  | typeof WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL
  | typeof WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL;
type BoundaryListener = (...values: unknown[]) => unknown;

export interface HistoryRecoveryIpcMainBoundary {
  handle(channel: HistoryRecoveryChannel, listener: BoundaryListener): void;
  removeHandler(channel: HistoryRecoveryChannel): void;
}

export interface HistoryRecoveryIpcBinding {
  dispose(): Promise<void>;
}

export function installHistoryRecoveryIpc(options: {
  readonly ipcMain: HistoryRecoveryIpcMainBoundary;
  readonly window: BrowserWindowBoundary;
  readonly source: HistoricalRecoveryLibrary;
}): HistoryRecoveryIpcBinding {
  let disposed = false;
  let documentOwner: object = Object.freeze({});
  const sender = options.window.webContents;

  const onDidStartLoading = (): void => {
    const prior = documentOwner;
    documentOwner = Object.freeze({});
    void options.source.close(prior);
  };
  const onTerminalSender = (): void => {
    void dispose();
  };
  const onWindowClosed = (): void => {
    void dispose();
  };

  sender.on("did-start-loading", onDidStartLoading);
  sender.on("render-process-gone", onTerminalSender);
  sender.on("destroyed", onTerminalSender);
  options.window.on("closed", onWindowClosed);

  options.ipcMain.handle(
    WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    async (event: unknown, ...values: unknown[]): Promise<HistoryRecoverySnapshotResult> => {
      const reconstructed = reconstructHistoryRecoverySnapshotRequest(values[0]);
      if (
        values.length !== 1 ||
        !reconstructed.ok ||
        !ownsSender(event, sender) ||
        disposed
      ) {
        return unavailableSnapshot(
          reconstructed.ok
            ? reconstructed.value.requestKey
            : "history-request-v1-invalid",
          "invalid-request",
        );
      }
      const owner = documentOwner;
      const result = await options.source.execute(owner, reconstructed.value);
      return owner === documentOwner && !disposed && !sender.isDestroyed()
        ? (result as HistoryRecoverySnapshotResult)
        : unavailableSnapshot(reconstructed.value.requestKey, "bridge-closed");
    },
  );
  options.ipcMain.handle(
    WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
    async (event: unknown, ...values: unknown[]): Promise<HistoryRecoveryBrowseResult> => {
      const reconstructed = reconstructHistoryRecoveryBrowseRequest(values[0]);
      if (
        values.length !== 1 ||
        !reconstructed.ok ||
        !ownsSender(event, sender) ||
        disposed
      ) {
        return unavailableBrowse(
          reconstructed.ok
            ? reconstructed.value.requestKey
            : "history-request-v1-invalid",
          "invalid-request",
        );
      }
      const owner = documentOwner;
      const result = await options.source.execute(owner, reconstructed.value);
      return owner === documentOwner && !disposed && !sender.isDestroyed()
        ? (result as HistoryRecoveryBrowseResult)
        : unavailableBrowse(reconstructed.value.requestKey, "bridge-closed");
    },
  );
  options.ipcMain.handle(
    WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
    async (event: unknown, ...values: unknown[]): Promise<HistoryRecoveryActionResult> => {
      const reconstructed = reconstructHistoryRecoveryPerformRequest(values[0]);
      if (
        values.length !== 1 ||
        !reconstructed.ok ||
        !ownsSender(event, sender) ||
        disposed
      ) {
        return reconstructed.ok
          ? failedAction(reconstructed.value, "invalid-request")
          : failedAction(
              Object.freeze({
                version: 1 as const,
                action: "preserve" as const,
                requestKey: "history-request-v1-invalid",
                operationKey: "history-operation-v1-invalid",
                snapshotKey: "history-capability-v1:invalid",
                sourceKey: "history-capability-v1:invalid",
              }),
              "invalid-request",
            );
      }
      const owner = documentOwner;
      const result = await options.source.execute(owner, reconstructed.value);
      return owner === documentOwner && !disposed && !sender.isDestroyed()
        ? (result as HistoryRecoveryActionResult)
        : failedAction(reconstructed.value, "bridge-closed");
    },
  );
  options.ipcMain.handle(
    WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
    async (event: unknown, ...values: unknown[]): Promise<HistoryRecoveryCancelResult> => {
      const reconstructed = reconstructHistoryRecoveryCancelRequest(values[0]);
      const request = reconstructed.ok
        ? reconstructed.value
        : Object.freeze({
            version: 1 as const,
            requestKey: "history-request-v1-invalid",
            operationKey: "history-operation-v1-invalid",
          });
      if (
        values.length !== 1 ||
        !reconstructed.ok ||
        !ownsSender(event, sender) ||
        disposed
      ) {
        return Object.freeze({
          version: 1 as const,
          kind: "cancel" as const,
          requestKey: request.requestKey,
          operationKey: request.operationKey,
          status: disposed ? "bridge-closed" as const : "unknown-request" as const,
        });
      }
      const owner = documentOwner;
      const result = await options.source.cancel(owner, reconstructed.value);
      return owner === documentOwner && !disposed && !sender.isDestroyed()
        ? result
        : Object.freeze({
            version: 1 as const,
            kind: "cancel" as const,
            requestKey: request.requestKey,
            operationKey: request.operationKey,
            status: "bridge-closed" as const,
          });
    },
  );

  return Object.freeze({ dispose });

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    sender.removeListener("did-start-loading", onDidStartLoading);
    sender.removeListener("render-process-gone", onTerminalSender);
    sender.removeListener("destroyed", onTerminalSender);
    options.window.removeListener("closed", onWindowClosed);
    for (const channel of [
      WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
      WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
      WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
      WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
    ] as const) {
      options.ipcMain.removeHandler(channel);
    }
    const owner = documentOwner;
    documentOwner = Object.freeze({});
    await options.source.close(owner);
  }
}

function ownsSender(event: unknown, sender: RendererSender): boolean {
  return typeof event === "object" &&
    event !== null &&
    "sender" in event &&
    event.sender === sender &&
    !sender.isDestroyed();
}
