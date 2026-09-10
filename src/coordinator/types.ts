import type {
  NormalizedRuntimeEvent,
  RuntimeUserInputQuestion,
  RuntimeUserInputResponse,
  NormalizedRuntimeUserInputEvent,
  RuntimeFailureCategory,
  SessionProfile,
} from "../agent-runtime/index.ts";
import type {
  SessionProfilePreferenceLayers,
  SessionProfilePreferences,
} from "../session-profile/index.ts";
import type {
  SessionMetadataMutationRequest,
  SessionMetadataMutationResult,
} from "../session-metadata.ts";
import type {
  EffectiveSessionProfileProjection,
  RequestedSessionProfileProjection,
} from "./profile-projection.ts";
import type { DurableRuntimeEndpointId } from "./work-ledger-auth-generation.ts";

export type Cursor = number;

export type ProjectCommandStatus =
  | "accepted"
  | "in-flight"
  | "completed"
  | "quota-paused"
  | "failed"
  | "recovery-required";

/** Exact durable command activity used by main-process interruption policy. */
export type ProjectTurnActivity =
  | "idle"
  | "accepted"
  | "in-flight"
  | "unknown";

export type ProjectCommandFailureCategory =
  | "profile-resolution-failed"
  | "runtime-failed"
  | "quota-expired"
  | "interrupted";

/**
 * Why a command landed in `recovery-required`, carried by the durable
 * `failure_category` column so the record names the adapter's reason instead
 * of NULL (F223). `binding-drift` is the coordinator's own invariant check on
 * a returned binding. NULL remains the value for programmatic recovery —
 * channel shutdown, a lost claim race, or the startup sweep — where there is
 * no error to name. This original error remains separate from `recovery`,
 * which describes a fresh resume observation, not the preceding turn's error.
 */
export type ProjectRecoveryFailureCategory =
  | RuntimeFailureCategory
  | "binding-drift";

/** Presence records an unknown turn outcome, not a failed or successful turn. */
export type ProjectCommandRecovery =
  | { readonly resume: "confirmed" }
  | {
      readonly resume: "unconfirmed";
      readonly reason: ProjectRecoveryFailureCategory
        | "session-reference-unavailable" | "authentication-changed"
        | "channel-closed" | "resume-timeout" | "resume-unconfirmed";
    };

export type ProjectInterruptCapability =
  | { readonly status: "idle" | "unknown" }
  | {
      readonly status: "pending" | "available" | "unsupported" | "requested";
      readonly commandId: string;
    };

export interface ProjectInterruptRequest {
  readonly commandId: string;
}

export type ProjectInterruptResult =
  | { readonly status: "requested" }
  | { readonly status: "not-running" | "unsupported" | "unavailable" };

export type ProjectSteerCapability =
  | { readonly status: "idle" | "unknown" }
  | {
      readonly status:
        | "pending"
        | "available"
        | "unsupported"
        | "submitting"
        | "unavailable";
      readonly commandId: string;
    };

export interface ProjectSteerRequest {
  readonly commandId: string;
  readonly input: string;
}

export type ProjectSteerResult =
  | { readonly status: "accepted" }
  | { readonly status: "not-running" | "unsupported" | "unavailable" };

/** Durable per-command timeline; provider events plus locally accepted steering input. */
export type ProjectRecordedTurnEvent =
  | NormalizedRuntimeEvent
  | { readonly kind: "user-message"; readonly text: string };

/** Command-private native routing identity captured before durable acceptance. */
export interface ProjectRuntimeResumeIdentity {
  readonly schemaVersion: 1;
  readonly endpointId: DurableRuntimeEndpointId;
  readonly nativeProfile: SessionProfile;
}

interface DirectProjectCommandBase {
  readonly kind: "direct";
  readonly idempotencyKey: string;
  readonly runtime: "codex";
  readonly input: string;
  /** Trusted immutable profile selected or resolved behind the renderer seam. */
  readonly profile: SessionProfile;
  /** Private durable route back to the native profile selected at acceptance. */
  readonly runtimeResumeIdentity?: ProjectRuntimeResumeIdentity;
}

export interface StartDirectProjectCommand extends DirectProjectCommandBase {
  readonly commandKind: "start";
  readonly catalogRevision: string;
  readonly preferences: SessionProfilePreferenceLayers;
  readonly overrides?: SessionProfilePreferences;
  /** Sanitized catalog-owned wording captured at durable acceptance. */
  readonly requestedProfileProjection?: RequestedSessionProfileProjection;
}

export interface ContinueDirectProjectCommand extends DirectProjectCommandBase {
  readonly commandKind: "continue";
  /** Trusted Workbench identity; renderer selection keys are resolved before act(). */
  readonly targetSessionId: string;
  /**
   * Versioned catalog-owned wording for this continuation turn. Older durable
   * envelopes omit it; new changed-profile input must not impersonate that
   * legacy shape.
   */
  readonly profileProjection?: {
    readonly version: 1;
    readonly requested: RequestedSessionProfileProjection;
  };
}

export type DirectProjectCommand =
  | StartDirectProjectCommand
  | ContinueDirectProjectCommand;

/** Workbench-private authority resolved before durable command acceptance. */
export interface ProjectCommandRuntimeContext {
  readonly endpointId: DurableRuntimeEndpointId;
}

/** One durable selection-to-native route recovered from a Session's commands. */
export interface ProjectRuntimeResumeIdentityMapping {
  readonly endpointId: DurableRuntimeEndpointId;
  readonly selectionProfile: SessionProfile;
  readonly nativeProfile: SessionProfile;
}

/** Durable local acceptance; it does not claim external runtime completion. */
export interface CommandReceipt {
  readonly commandId: string;
  readonly acceptedCursor: Cursor;
  readonly status: "accepted";
}

export interface ProjectSessionSummary {
  readonly sessionId: string;
  /** Session-owned presentation metadata; never a native/provider identity. */
  readonly displayName: string;
  /** Runtime lifecycle remains independent from this reversible visibility bit. */
  readonly archived: boolean;
  readonly profile: SessionProfile;
  readonly requestedProfileProjection?: RequestedSessionProfileProjection;
  readonly effectiveProfileProjection?: EffectiveSessionProfileProjection;
  readonly events: readonly ProjectRecordedTurnEvent[];
  /** Last recorded `agent-message` cursor; backend-only rail recency signal. */
  readonly lastModelReplyCursor?: Cursor;
  /** This command's acceptance cursor; backend-only pending-reply recency signal. */
  readonly acceptedCommandCursor?: Cursor;
  /** Native resume material remains coordinator-only. */
  readonly resumable: boolean;
}

export interface ProjectCommandSummary {
  readonly commandId: string;
  readonly runtime: "codex";
  readonly status: ProjectCommandStatus;
  readonly failureCategory?: ProjectCommandFailureCategory;
  readonly recovery?: ProjectCommandRecovery;
  /** Exact accepted command input; absent only for legacy digest-v1 rows. */
  readonly input?: string;
  readonly session?: ProjectSessionSummary;
}

export interface ProjectSnapshot {
  readonly projectId: string;
  readonly cursor: Cursor;
  readonly commands: readonly ProjectCommandSummary[];
}

/** Authoritative command headers and event tails since one full/changes cursor. */
export interface ProjectSnapshotChanges {
  readonly projectId: string;
  readonly after: Cursor;
  readonly cursor: Cursor;
  /** Events contain only the tail after `after`; all other fields are current. */
  readonly commands: readonly ProjectCommandSummary[];
  /** Session-wide facts can change independently of a particular old command. */
  readonly sessions: readonly Pick<ProjectSessionSummary,
    "sessionId" | "displayName" | "archived" | "resumable" | "lastModelReplyCursor">[];
}

export interface ProjectSessionRemovalRequest {
  /** Trusted Workbench identity; renderer selection keys resolve before this seam. */
  readonly sessionId: string;
  /**
   * The owner has been shown what an unknown turn outcome means and has asked
   * for removal anyway. It releases only the historical `recovery-required`
   * barrier, independently of whether CLI resume was confirmed; `accepted`
   * and `in-flight` work still blocks, so D16.2's rule that deletion never
   * interrupts a running turn is unchanged. Only the literal `true` is a legal
   * value, so there is exactly one way to express the acknowledgement.
   */
  readonly acknowledgedUnknownOutcome?: true;
}

export type ProjectSessionMetadataMutationRequest =
  SessionMetadataMutationRequest;
export type ProjectSessionMetadataMutationResult =
  SessionMetadataMutationResult;

export interface ProjectContinuationProfileRequest {
  /** Trusted Workbench identity; renderer selection keys resolve before this seam. */
  readonly sessionId: string;
  /** Trusted candidate resolved from a current private Runtime catalog snapshot. */
  readonly profile: SessionProfile;
}

export type ProjectContinuationProfileResult =
  | { readonly status: "compatible" }
  | { readonly status: "incompatible" };

export type ProjectSessionRemovalResult =
  | { readonly status: "removed" }
  | { readonly status: "not-found" }
  | {
      readonly status: "blocked";
      /** Mirrors the main-process close guard when deletion could interrupt work. */
      readonly activity: Exclude<ProjectTurnActivity, "idle">;
    };

interface DurableProjectUpdateBase {
  readonly cursor: Cursor;
  readonly commandId: string;
  readonly status: ProjectCommandStatus;
}

export type DurableProjectUpdate =
  | (DurableProjectUpdateBase & {
      readonly kind: "accepted" | "in-flight" | "completed" | "quota-paused" | "recovery-required";
    })
  | (DurableProjectUpdateBase & {
      readonly kind: "profile-resolved";
      readonly sessionId: string;
      readonly profile: SessionProfile;
    })
  | (DurableProjectUpdateBase & {
      readonly kind: "runtime-event";
      readonly sessionId: string;
      readonly event: ProjectRecordedTurnEvent;
    })
  | (DurableProjectUpdateBase & {
      readonly kind: "interrupt-capability";
      readonly sessionId: string;
      readonly capability: Exclude<
        ProjectInterruptCapability["status"],
        "idle" | "unknown"
      >;
    })
  | (DurableProjectUpdateBase & {
      readonly kind: "failed";
      readonly failureCategory: ProjectCommandFailureCategory;
    });

export type ProjectUpdate =
  | DurableProjectUpdate
  | {
      readonly cursor: Cursor;
      readonly commandId: null;
      readonly kind: "snapshot";
      readonly status: "snapshot";
      readonly snapshot: ProjectSnapshot;
    };

export type ProjectUserInputView =
  | { readonly requestKey: string; readonly state: "pending";
      readonly questions: readonly RuntimeUserInputQuestion[]; readonly isBlocking: boolean; readonly expiresAt: number }
  | { readonly requestKey: string; readonly state: Extract<NormalizedRuntimeUserInputEvent, { kind: "user-input-resolved" }>["resolution"] };
export type ProjectUserInputResponse =
  | { readonly kind: "cancel"; readonly requestKey: string }
  | { readonly kind: "answer"; readonly requestKey: string; readonly answers: RuntimeUserInputResponse["answers"] };
export type ProjectUserInputResponseResult = { readonly status: "answered" | "cancelled" | "invalid-answer" | "unavailable" };

export interface ProjectChannel {
  /** Ephemeral questions on the existing active binding; never turn-history events. */
  readUserInput?(sessionId: string): readonly ProjectUserInputView[];
  observeUserInput?(listener: () => void): () => void;
  respondToUserInput?(request: ProjectUserInputResponse): Promise<ProjectUserInputResponseResult>;
  /**
   * Serializes commands. A same-key/same-payload retry returns the original
   * receipt; a different payload fails before external execution.
  */
  act(
    command: DirectProjectCommand,
    runtimeContext?: ProjectCommandRuntimeContext,
  ): Promise<CommandReceipt>;
  /** Read-only same-endpoint proof used before presenting continuation choices. */
  validateContinuationProfile(
    request: ProjectContinuationProfileRequest,
  ): Promise<ProjectContinuationProfileResult>;
  /** Reads private durable resume routes without exposing them in snapshots. */
  readSessionRuntimeResumeIdentities?(
    sessionId: string,
  ): Promise<readonly ProjectRuntimeResumeIdentityMapping[]>;
  /**
   * Hard-deletes one terminal Session's commands and events. Active or
   * outcome-unknown work is never interrupted and instead returns blocked.
   */
  removeSession(
    request: ProjectSessionRemovalRequest,
  ): Promise<ProjectSessionRemovalResult>;
  /**
   * Mutates only Session-owned display/archive metadata. Archive is reversible
   * and fail-closed for accepted, in-flight, or unknown work. A terminal
   * recovery-required Session needs the same explicit unknown-outcome
   * acknowledgement as deletion.
   */
  mutateSessionMetadata(
    request: ProjectSessionMetadataMutationRequest,
  ): Promise<ProjectSessionMetadataMutationResult>;
  readTurnActivity(): ProjectTurnActivity;
  /** Exact live control truth for the one serialized active turn. */
  readInterruptCapability?(): ProjectInterruptCapability;
  /** Requests one interruption only when the command and binding still match. */
  interruptActiveTurn?(
    request: ProjectInterruptRequest,
  ): Promise<ProjectInterruptResult>;
  /** Exact same-turn steering truth for the one serialized active turn. */
  readSteerCapability?(): ProjectSteerCapability;
  /** Adds input only to the still-matching active turn; never starts another turn. */
  steerActiveTurn?(
    request: ProjectSteerRequest,
  ): Promise<ProjectSteerResult>;
  snapshot(): Promise<ProjectSnapshot>;
  /** Optional for non-durable channel implementations; production supplies it. */
  snapshotChanges?(after: Cursor): Promise<ProjectSnapshotChanges>;
  /**
   * Without a cursor yields one current snapshot, then follows later durable
   * updates. With a cursor, catches up from SQLite before following live
   * in-process commits. The iterator ends when cancelled or the channel closes.
   */
  observe(options?: { readonly after?: Cursor }): AsyncIterable<ProjectUpdate>;
  close(): Promise<void>;
}

export interface WorkbenchCoordinator {
  openProject(directory: string): Promise<ProjectChannel>;
}

export type CoordinatorFailureCategory =
  | "channel-closed"
  | "continuation-unavailable"
  | "idempotency-conflict"
  | "invalid-command"
  | "invalid-cursor"
  | "project-mismatch"
  | "storage-failed";

export class CoordinatorError extends Error {
  readonly category: CoordinatorFailureCategory;

  constructor(category: CoordinatorFailureCategory) {
    super("Project coordination failed.");
    this.name = "CoordinatorError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}
