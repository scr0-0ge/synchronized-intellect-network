import type { ResumableAgentRuntimeAdapter } from "../agent-runtime/index.ts";
import { SqliteWorkbenchCoordinator } from "./sqlite-project-channel.ts";
import type { WorkbenchCoordinator } from "./types.ts";
import type {
  DurableRuntimeEndpointId,
  WorkLedgerAuthGenerationModule,
} from "./work-ledger-auth-generation.ts";

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
  createSessionContinuationPlan,
  parseSessionContinuationPlan,
  sessionContinuationStepInput,
  SESSION_CONTINUATION_MAX_STEPS,
} from "./session-continuation-plan.ts";
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
  /**
   * Endpoint ids the channel admits in command runtime contexts and stored
   * runtime resume identities. Defaults to the two subscription endpoints so
   * direct consumers and tests are unchanged; the Workbench shell injects its
   * full registered roster, which includes the api-key endpoints (GLM). The
   * coordinator never imports the shell — the roster travels downward only.
   */
  readonly endpointIds?: readonly DurableRuntimeEndpointId[];
}

export function createWorkbenchCoordinator(
  options: WorkbenchCoordinatorOptions,
): WorkbenchCoordinator {
  return new SqliteWorkbenchCoordinator(
    options.databasePath,
    options.adapter,
    options.authGeneration,
    options.endpointIds,
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
