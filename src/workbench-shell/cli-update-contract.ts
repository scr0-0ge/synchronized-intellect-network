/**
 * Re-export shim for the CLI update public contract. The surface lived here
 * self-contained from ticket 18 (the lane could not open contract.ts then);
 * ticket 21's cleanup package incorporated it into `contract.ts` verbatim
 * (plus the new relaunch action). This shim keeps every existing import
 * path — settings.tsx, the preload bridge, the sanitizer, the check
 * service, the IPC binding, and the tests — byte-stable; new consumers
 * should import from contract.ts directly.
 */

export {
  WORKBENCH_CHECK_CLI_UPDATES_CHANNEL,
  WORKBENCH_RUN_CLI_UPDATE_CHANNEL,
  WORKBENCH_RELAUNCH_APP_CHANNEL,
  WORKBENCH_CLI_UPDATE_CLI_IDS,
  publicCliUpdateCheckCompleted,
  publicCliUpdateCheckUnavailable,
  publicCliUpdateRunUpdated,
  publicCliUpdateRunFailed,
  publicCliUpdateRunUnavailable,
  publicCliUpdateRelaunchQueued,
  publicCliUpdateRelaunchUnavailable,
} from "./contract.ts";
export type {
  WorkbenchCliUpdateCliId,
  WorkbenchCliUpdateCheckReport,
  WorkbenchCliUpdateCheckResult,
  WorkbenchCliUpdateRunFailureReason,
  WorkbenchCliUpdateRunResult,
  WorkbenchCliUpdateRelaunchResult,
  WorkbenchCliUpdateBridge,
} from "./contract.ts";
