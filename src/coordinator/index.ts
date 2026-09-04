import type { ResumableAgentRuntimeAdapter } from "../agent-runtime/index.ts";
import { SqliteWorkbenchCoordinator } from "./sqlite-project-channel.ts";
import type { WorkbenchCoordinator } from "./types.ts";
import type { WorkLedgerAuthGenerationModule } from "./work-ledger-auth-generation.ts";

export type {
  CommandReceipt,
  ContinueDirectProjectCommand,
  CoordinatorFailureCategory,
  Cursor,
  DirectProjectCommand,
  DurableProjectUpdate,
  ProjectChannel,
  ProjectCommandFailureCategory,
  ProjectCommandRuntimeContext,
  ProjectCommandStatus,
  ProjectCommandSummary,
  ProjectContinuationProfileRequest,
  ProjectContinuationProfileResult,
  ProjectInterruptCapability,
  ProjectInterruptRequest,
  ProjectInterruptResult,
  ProjectSteerCapability,
  ProjectSteerRequest,
  ProjectSteerResult,
  ProjectRuntimeResumeIdentity,
  ProjectRuntimeResumeIdentityMapping,
  ProjectRecordedTurnEvent,
  ProjectSessionSummary,
  ProjectSessionMetadataMutationRequest,
  ProjectSessionMetadataMutationResult,
  ProjectSessionRemovalRequest,
  ProjectSessionRemovalResult,
  ProjectSnapshot,
  ProjectTurnActivity,
  ProjectUpdate,
  StartDirectProjectCommand,
  WorkbenchCoordinator,
} from "./types.ts";
export {
  SESSION_DISPLAY_NAME_MAX_CODE_POINTS,
  createSessionMetadataModule,
  normalizeSessionDisplayName,
} from "../session-metadata.ts";
export type {
  SessionDisplayNameSource,
  SessionMetadataModule,
  SessionMetadataOperation,
  SessionMetadataProjection,
  SessionMetadataProjectionRow,
  StoredSessionMetadata,
} from "../session-metadata.ts";
export { CoordinatorError } from "./types.ts";
export {
  cloneEffectiveSessionProfileProjection,
  cloneRequestedSessionProfileProjection,
  observedDifferentProfileValueLabel,
  projectEffectiveSessionProfile,
  unknownEffectiveSessionProfileProjection,
} from "./profile-projection.ts";
export type {
  EffectiveSessionProfileDisplayValue,
  EffectiveSessionProfileProjection,
  RequestedSessionProfileProjection,
  WorkIntensityControlLabelProjection,
} from "./profile-projection.ts";

export interface WorkbenchCoordinatorOptions {
  /** One SQLite file owned by this bounded, single-Project coordinator. */
  readonly databasePath: string;
  /** Accepted opaque-resume seam; production supplies the Codex Adapter. */
  readonly adapter: ResumableAgentRuntimeAdapter;
  /** Optional until the Workbench-private F104 module is composed at startup. */
  readonly authGeneration?: WorkLedgerAuthGenerationModule;
}

export function createWorkbenchCoordinator(
  options: WorkbenchCoordinatorOptions,
): WorkbenchCoordinator {
  return new SqliteWorkbenchCoordinator(
    options.databasePath,
    options.adapter,
    options.authGeneration,
  );
}

export {
  accountSignInChangedRefusalCopy,
  createWorkLedgerAuthGenerationModule,
  parseDurableAccountObservation,
  parseDurableAuthenticationContext,
} from "./work-ledger-auth-generation.ts";
export type {
  AccountObservationVerdict,
  AuthenticationMutationBeginResult,
  AuthenticationMutationBlockers,
  AuthenticationMutationConsequences,
  AuthenticationMutationPreparation,
  DurableAccountObservation,
  DurableAuthenticationContext,
  DurableRuntimeEndpointId,
  ObservedAuthenticationState,
  RuntimeEndpointAuthGenerationSnapshot,
  WorkbenchAuthenticationAction,
  WorkLedgerAuthGenerationModule,
  WorkLedgerAuthGenerationOptions,
} from "./work-ledger-auth-generation.ts";
