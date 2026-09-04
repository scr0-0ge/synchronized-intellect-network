export const WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL =
  "workbench:history-recovery:snapshot:v1";
export const WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL =
  "workbench:history-recovery:browse:v1";
export const WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL =
  "workbench:history-recovery:perform:v1";
export const WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL =
  "workbench:history-recovery:cancel:v1";

export const historyRecoveryBounds = Object.freeze({
  minimumPageSize: 1,
  maximumPageSize: 50,
  maximumCount: 2_147_483_647,
  maximumOrdinal: 2_147_483_647,
  maximumPhysicalSources: 64,
  maximumFilesPerSource: 4_096,
  maximumTraversalDepth: 8,
  maximumFileBytes: 4 * 1_024 * 1_024 * 1_024,
  maximumSourceBytes: 8 * 1_024 * 1_024 * 1_024,
  maximumPublicResponseBytes: 512 * 1_024,
  preparationDeadlineMilliseconds: 30_000,
  captureAttempts: 3,
  maximumConcurrentReadsPerSender: 4,
  closeGraceMilliseconds: 5_000,
});

export type HistoryRecoveryProblemCode =
  | "bridge-closed"
  | "busy"
  | "cancelled"
  | "capture-drift"
  | "cleanup-pending"
  | "export-unavailable"
  | "invalid-request"
  | "library-unavailable"
  | "permission-denied"
  | "quota-exceeded"
  | "source-unavailable"
  | "stale-capability"
  | "unsupported-artifact"
  | "unsupported-schema"
  | "verification-failed";

export interface HistoryRecoveryProblem {
  readonly code: HistoryRecoveryProblemCode;
  readonly message: string;
}

const problemMessages: Readonly<Record<HistoryRecoveryProblemCode, string>> =
  Object.freeze({
    "bridge-closed": "Data recovery was closed. Reopen Settings and try again.",
    busy: "Another data recovery operation is still finishing.",
    cancelled: "The data recovery operation was cancelled before commit.",
    "capture-drift": "The source changed while its recovery copy was being verified.",
    "cleanup-pending": "The recovery copy is safe, but private cleanup is still pending.",
    "export-unavailable": "The recovery copy could not be exported safely.",
    "invalid-request": "The data recovery request was rejected.",
    "library-unavailable": "The Historical Recovery Library is unavailable.",
    "permission-denied": "The recovery source could not be read with current permissions.",
    "quota-exceeded": "The recovery source exceeds the bounded recovery allowance.",
    "source-unavailable": "The recovery source is not available for this action.",
    "stale-capability": "Recovery information changed. Review the refreshed overview.",
    "unsupported-artifact": "The exact source copy was preserved, but its metadata cannot be browsed safely.",
    "unsupported-schema": "This historical data format cannot be browsed safely.",
    "verification-failed": "The recovery copy could not be verified.",
  });

export function historyRecoveryProblem(
  code: HistoryRecoveryProblemCode,
): HistoryRecoveryProblem {
  return Object.freeze({ code, message: problemMessages[code] });
}

export interface HistoryRecoveryCounts {
  readonly projects: number;
  readonly sessions: number;
  readonly commands: number;
  readonly updates: number;
}

export type HistoryRecoverySourceSummary =
  | {
      readonly sourceKey: string;
      readonly label: string;
      readonly role: "current" | "historical";
      readonly state:
        | "current"
        | "available"
        | "empty"
        | "preserved"
        | "acknowledged"
        | "cleanup-pending";
      readonly action: "none" | "preserve" | "acknowledge";
      readonly counts: HistoryRecoveryCounts;
    }
  | {
      readonly sourceKey: string;
      readonly label: string;
      readonly role: "current" | "historical";
      readonly state: "unavailable";
      readonly action: "none";
      readonly counts: null;
    };

export interface HistoryRecoveryLibrarySummary {
  readonly libraryKey: string;
  readonly label: "Historical Recovery Library";
  readonly generationCount: number;
}

export interface HistoryRecoverySnapshot {
  readonly snapshotKey: string;
  readonly attention: boolean;
  readonly library: HistoryRecoveryLibrarySummary;
  readonly sources: readonly HistoryRecoverySourceSummary[];
}

export interface HistoryRecoverySnapshotRequest {
  readonly version: 1;
  readonly requestKey: string;
}

export type HistoryRecoverySnapshotResult =
  | {
      readonly version: 1;
      readonly kind: "snapshot";
      readonly requestKey: string;
      readonly status: "ready" | "partial";
      readonly snapshot: HistoryRecoverySnapshot;
    }
  | {
      readonly version: 1;
      readonly kind: "snapshot";
      readonly requestKey: string;
      readonly status: "unavailable";
      readonly problem: HistoryRecoveryProblem;
    };

export interface HistoryRecoveryPageRequest {
  readonly after: number | null;
  readonly size: number;
}

export type HistoryRecoveryBrowseRequest =
  | {
      readonly version: 1;
      readonly kind: "generations";
      readonly requestKey: string;
      readonly snapshotKey: string;
      readonly libraryKey: string;
      readonly page: HistoryRecoveryPageRequest;
    }
  | {
      readonly version: 1;
      readonly kind: "projects";
      readonly requestKey: string;
      readonly snapshotKey: string;
      readonly generationKey: string;
      readonly page: HistoryRecoveryPageRequest;
    }
  | {
      readonly version: 1;
      readonly kind: "sessions";
      readonly requestKey: string;
      readonly snapshotKey: string;
      readonly projectKey: string;
      readonly page: HistoryRecoveryPageRequest;
    }
  | {
      readonly version: 1;
      readonly kind: "turns";
      readonly requestKey: string;
      readonly snapshotKey: string;
      readonly sessionKey: string;
      readonly page: HistoryRecoveryPageRequest;
    };

export interface HistoryRecoveryGenerationItem {
  readonly kind: "generation";
  readonly ordinal: number;
  readonly label: string;
  readonly generationKey: string;
  readonly sourceLabel: string;
  readonly counts: HistoryRecoveryCounts;
}

export interface HistoryRecoveryProjectItem {
  readonly kind: "project";
  readonly ordinal: number;
  readonly label: string;
  readonly projectKey: string;
  readonly counts: HistoryRecoveryCounts;
}

export interface HistoryRecoverySessionItem {
  readonly kind: "session";
  readonly ordinal: number;
  readonly label: string;
  readonly sessionKey: string;
  readonly status:
    | "accepted"
    | "in-flight"
    | "completed"
    | "failed"
    | "recovery-required";
  readonly commandCount: number;
  readonly turnCount: number;
}

export interface HistoryRecoveryTurnItem {
  readonly kind: "turn";
  readonly ordinal: number;
  readonly label: string;
  readonly status:
    | "accepted"
    | "in-flight"
    | "completed"
    | "failed"
    | "recovery-required";
  readonly eventCount: number;
}

export type HistoryRecoveryBrowseItem =
  | HistoryRecoveryGenerationItem
  | HistoryRecoveryProjectItem
  | HistoryRecoverySessionItem
  | HistoryRecoveryTurnItem;

export interface HistoryRecoveryPageResult {
  readonly after: number | null;
  readonly nextAfter: number | null;
  readonly totalCount: number;
  readonly items: readonly HistoryRecoveryBrowseItem[];
}

export type HistoryRecoveryBrowseResult =
  | {
      readonly version: 1;
      readonly kind: "browse";
      readonly requestKey: string;
      readonly status: "ready";
      readonly snapshotKey: string;
      readonly branch: "generations" | "projects" | "sessions" | "turns";
      readonly parentKey: string;
      readonly page: HistoryRecoveryPageResult;
    }
  | {
      readonly version: 1;
      readonly kind: "browse";
      readonly requestKey: string;
      readonly status: "stale" | "unavailable" | "cancelled";
      readonly problem: HistoryRecoveryProblem;
    };

export type HistoryRecoveryPerformRequest =
  | {
      readonly version: 1;
      readonly action: "preserve" | "acknowledge";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly snapshotKey: string;
      readonly sourceKey: string;
    }
  | {
      readonly version: 1;
      readonly action: "export-copy";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly snapshotKey: string;
      readonly generationKey: string;
    };

export interface HistoryRecoveryGenerationReference {
  readonly ordinal: number;
  readonly label: string;
  readonly generationKey: string;
  readonly counts: HistoryRecoveryCounts;
}

export interface HistoryRecoveryExportReference {
  readonly label: string;
  readonly warning: "The exported copy may contain conversation history and private local metadata.";
}

export type HistoryRecoveryActionResult =
  | {
      readonly version: 1;
      readonly action: "preserve";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly status: "preserved" | "already-preserved";
      readonly snapshot: HistoryRecoverySnapshot;
      readonly generation: HistoryRecoveryGenerationReference;
      readonly cleanup: "complete" | "pending";
    }
  | {
      readonly version: 1;
      readonly action: "acknowledge";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly status: "acknowledged" | "already-acknowledged";
      readonly snapshot: HistoryRecoverySnapshot;
      readonly cleanup: "complete" | "pending";
    }
  | {
      readonly version: 1;
      readonly action: "export-copy";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly status: "exported" | "already-exported";
      readonly export: HistoryRecoveryExportReference;
    }
  | {
      readonly version: 1;
      readonly action: "export-copy";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly status: "chooser-cancelled" | "outcome-unknown";
    }
  | {
      readonly version: 1;
      readonly action: "preserve" | "acknowledge" | "export-copy";
      readonly requestKey: string;
      readonly operationKey: string;
      readonly status: "cancelled" | "failed";
      readonly problem: HistoryRecoveryProblem;
    };

export interface HistoryRecoveryCancelRequest {
  readonly version: 1;
  readonly requestKey: string;
  readonly operationKey: string;
}

export interface HistoryRecoveryCancelResult {
  readonly version: 1;
  readonly kind: "cancel";
  readonly requestKey: string;
  readonly operationKey: string;
  readonly status:
    | "cancel-requested"
    | "already-terminal"
    | "unknown-request"
    | "bridge-closed";
}

export interface HistoryRecoveryRendererBridge {
  getSnapshot(
    request: HistoryRecoverySnapshotRequest,
  ): Promise<HistoryRecoverySnapshotResult>;
  browse(
    request: HistoryRecoveryBrowseRequest,
  ): Promise<HistoryRecoveryBrowseResult>;
  perform(
    request: HistoryRecoveryPerformRequest,
  ): Promise<HistoryRecoveryActionResult>;
  cancel(
    request: HistoryRecoveryCancelRequest,
  ): Promise<HistoryRecoveryCancelResult>;
}
