import type {
  EffectiveSessionProfileProjection,
  ProjectCommandFailureCategory,
  ProjectCommandStatus,
  ProjectTurnActivity,
  RequestedSessionProfileProjection,
} from "../coordinator/index.ts";
import {
  SESSION_DISPLAY_NAME_MAX_CODE_POINTS,
  type SessionMetadataMutationResult,
  type SessionMetadataOperation,
} from "../session-metadata.ts";
import type { HistoryRecoveryRendererBridge } from "./history-recovery-contract.ts";
import type { WorkbenchClipboardRendererBridge } from "./clipboard-bridge.ts";
import type { WorkbenchNotificationRendererBridge } from "./notification-bridge.ts";

export const WORKBENCH_OBSERVE_CHANNEL = "workbench:observe-project";
export const WORKBENCH_DISPOSE_CHANNEL =
  "workbench:dispose-project-observation";
export const WORKBENCH_PROJECT_VIEW_CHANNEL = "workbench:project-view";
export const WORKBENCH_LOAD_PROFILE_CHANNEL =
  "workbench:load-direct-session-profile";
export const WORKBENCH_SUBMIT_CHANNEL = "workbench:submit-direct-input";
export const WORKBENCH_INTERRUPT_CHANNEL = "workbench:interrupt-active-turn";
export const WORKBENCH_STEER_CHANNEL = "workbench:steer-active-turn";
export const WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL =
  "workbench:use-direct-session-profile-as-default";
export const WORKBENCH_SELECT_PROJECT_CHANNEL = "workbench:select-project";
export const WORKBENCH_REMOVE_SESSION_CHANNEL = "workbench:remove-session";
export const WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL =
  "workbench:mutate-session-metadata";
export const WORKBENCH_REMOVE_PROJECT_CHANNEL = "workbench:remove-project";
export const WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL =
  "workbench:discover-project-histories";
export const WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL =
  "workbench:adopt-project-history";
export const WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL =
  "workbench:hide-project-history";
export const WORKBENCH_OPEN_PROJECT_CHANNEL = "workbench:open-project";
export const WORKBENCH_CREATE_PROJECT_CHANNEL = "workbench:create-project";
export const WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL =
  "workbench:load-appearance-preference";
export const WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL =
  "workbench:save-appearance-preference";
export const WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL =
  "workbench:load-claude-permission-handling";
export const WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL =
  "workbench:save-claude-permission-handling";
export const WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL =
  "workbench:load-runtime-executables";
export const WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL =
  "workbench:save-runtime-executable";
export const WORKBENCH_INSPECT_SUBSCRIPTION_AUTHENTICATION_CHANNEL =
  "workbench:inspect-subscription-authentication";
export const WORKBENCH_BIND_SUBSCRIPTION_AUTHENTICATION_CHANNEL =
  "workbench:bind-subscription-authentication";
export const WORKBENCH_CANCEL_SUBSCRIPTION_AUTHENTICATION_CHANNEL =
  "workbench:cancel-subscription-authentication";
export const WORKBENCH_PREPARE_SUBSCRIPTION_AUTHENTICATION_CHANNEL =
  "workbench:prepare-subscription-authentication";
export const WORKBENCH_BEGIN_SUBSCRIPTION_AUTHENTICATION_CHANNEL =
  "workbench:begin-subscription-authentication";
export const WORKBENCH_CANCEL_PREPARED_SUBSCRIPTION_AUTHENTICATION_CHANNEL =
  "workbench:cancel-prepared-subscription-authentication";

export const WORKBENCH_DIRECT_INPUT_MAX_LENGTH = 8_000;
export const WORKBENCH_SESSION_DISPLAY_NAME_MAX_CODE_POINTS =
  SESSION_DISPLAY_NAME_MAX_CODE_POINTS;

export type WorkbenchAppearanceTone = "dark" | "light";
export type WorkbenchAppearanceCrt = "off" | "blocks" | "screen" | "full";
export type WorkbenchAppearancePhosphor = "neutral" | "green" | "amber";
export type WorkbenchAppearancePhosphorTier = "a" | "b" | "c";
export type WorkbenchLanguage = "en" | "zh-CN";
export type WorkbenchClaudePermissionHandling =
  | "without-asking"
  | "ask-when-needed";

export const defaultWorkbenchClaudePermissionHandling: WorkbenchClaudePermissionHandling =
  "without-asking";

export interface WorkbenchAppearancePreference {
  readonly tone: WorkbenchAppearanceTone;
  readonly crt: WorkbenchAppearanceCrt;
  readonly phosphor: WorkbenchAppearancePhosphor;
  readonly phosphorTier: WorkbenchAppearancePhosphorTier;
  /** Missing only on legacy in-process callers; every persisted/public value is normalized. */
  readonly language?: WorkbenchLanguage;
}

export const defaultWorkbenchAppearancePreference: WorkbenchAppearancePreference =
  Object.freeze({
    tone: "dark",
    crt: "screen",
    phosphor: "neutral",
    phosphorTier: "b",
    language: "en",
  });

export interface WorkbenchAppearancePreferenceFailure {
  readonly category: "appearance-preference-unavailable";
  readonly message: "Appearance preferences could not be loaded or saved. Keep the current appearance and try again.";
}

export type WorkbenchAppearancePreferenceLoadResult =
  | {
      readonly ok: true;
      readonly status: "loaded";
      readonly appearance: WorkbenchAppearancePreference;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchAppearancePreferenceFailure;
    };

export type WorkbenchAppearancePreferenceSaveResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly message: "Appearance preference was durably saved.";
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchAppearancePreferenceFailure;
    };

export interface WorkbenchClaudePermissionHandlingFailure {
  readonly category: "claude-permission-handling-unavailable";
  readonly message: "Claude permission handling could not be loaded or saved. Keep the current choice and try again.";
}

export type WorkbenchClaudePermissionHandlingLoadResult =
  | {
      readonly ok: true;
      readonly status: "loaded";
      readonly permissionHandling: WorkbenchClaudePermissionHandling;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchClaudePermissionHandlingFailure;
    };

export type WorkbenchClaudePermissionHandlingSaveResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly message: "Claude permission handling was durably saved.";
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchClaudePermissionHandlingFailure;
    };

/**
 * The escape hatch: where a user says the runtime executable actually is.
 *
 * An empty string means "not set" rather than a key that comes and goes, so the
 * exact-shape validators on this boundary keep one key set to check.
 */
export interface WorkbenchRuntimeExecutablePaths {
  readonly codex: string;
  readonly claude: string;
}

export const WORKBENCH_RUNTIME_EXECUTABLE_PATH_MAX_LENGTH = 4_096;

export const defaultWorkbenchRuntimeExecutablePaths: WorkbenchRuntimeExecutablePaths =
  Object.freeze({ codex: "", claude: "" });

export type WorkbenchConfigurableRuntime = "codex" | "claude";

/**
 * Why a path a user supplied cannot be used. A FIXED vocabulary: the reason
 * crosses the boundary, the path never does.
 */
export type WorkbenchRuntimeExecutableRejection =
  | "not-absolute"
  | "not-found"
  | "not-a-file"
  | "unsupported-shape"
  | "no-install-beside-it"
  | "no-node-interpreter"
  | "unusable";

export interface WorkbenchRuntimeExecutableUnavailableFailure {
  readonly category: "runtime-executable-unavailable";
  readonly message: "The executable path could not be loaded or saved. Keep the current value and try again.";
}

export interface WorkbenchRuntimeExecutableRejectedFailure {
  readonly category: "runtime-executable-rejected";
  readonly message: "That path cannot be used to start this runtime.";
  readonly reason: WorkbenchRuntimeExecutableRejection;
}

export type WorkbenchRuntimeExecutableFailure =
  | WorkbenchRuntimeExecutableUnavailableFailure
  | WorkbenchRuntimeExecutableRejectedFailure;

export type WorkbenchRuntimeExecutablesLoadResult =
  | {
      readonly ok: true;
      readonly status: "loaded";
      readonly executables: WorkbenchRuntimeExecutablePaths;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchRuntimeExecutableUnavailableFailure;
    };

export type WorkbenchRuntimeExecutableSaveResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly executables: WorkbenchRuntimeExecutablePaths;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchRuntimeExecutableFailure;
    };

export interface WorkbenchRuntimeExecutableSaveRequest {
  readonly runtime: WorkbenchConfigurableRuntime;
  /** An empty string clears the override and returns to ordinary discovery. */
  readonly executablePath: string;
}

export type WorkbenchTimelineEvent =
  | { readonly kind: "user-message"; readonly text: string }
  | { readonly kind: "session-started" }
  | { readonly kind: "turn-started" }
  | { readonly kind: "item-started"; readonly itemType: "agent-message" }
  | { readonly kind: "item-completed"; readonly itemType: "agent-message" }
  | { readonly kind: "agent-message"; readonly text: string }
  | { readonly kind: "turn-completed"; readonly status: "completed" }
  | { readonly kind: "turn-interrupted"; readonly status: "interrupted" }
  | {
      readonly kind: "failed";
      /** Accepted for source compatibility; sanitizers never emit a category. */
      readonly category?: string;
    };

export interface WorkbenchSessionContextUsage {
  readonly usedTokens: number;
  readonly windowTokens: number | null;
}

export interface WorkbenchTurnView {
  /** Requested and effective profile recorded for this exact Direct Project Command. */
  readonly profile: WorkbenchSessionProfileProjection;
  /** The user input and Runtime events owned by this exact command. */
  readonly timeline: readonly WorkbenchTimelineEvent[];
}

export type WorkbenchInterruptControl =
  | {
      readonly status: "available";
      /** Snapshot-scoped authority for this exact running turn. */
      readonly interruptKey: string;
    }
  | {
      readonly status: "pending";
      readonly reason: "Interrupt becomes available when the Runtime turn starts.";
    }
  | {
      readonly status: "unsupported";
      readonly reason: "This Runtime does not support interruption.";
    }
  | {
      readonly status: "requested";
      readonly reason: "Interrupt requested. Waiting for the Runtime to stop.";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "Interrupt is unavailable for this turn.";
    };

export type WorkbenchSteerControl =
  | {
      readonly status: "available";
      /** Snapshot-scoped authority for this exact running turn. */
      readonly steerKey: string;
    }
  | {
      readonly status: "pending";
      readonly reason: "Same-turn guidance becomes available when the Runtime turn starts.";
    }
  | {
      readonly status: "unsupported";
      readonly reason: "This Runtime does not support same-turn guidance. Your draft stays local.";
    }
  | {
      readonly status: "submitting";
      readonly reason: "Sending guidance to this running turn.";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "Same-turn guidance is unavailable. Your draft stays local.";
    };

export interface WorkbenchCommandView {
  readonly key: string;
  readonly label: string;
  readonly runtime: string;
  readonly status: ProjectCommandStatus;
  readonly failureCategory?: ProjectCommandFailureCategory;
  /** Present only while this projected command owns the running turn. */
  readonly interrupt?: WorkbenchInterruptControl;
  /** Same-turn semantics only; unsupported Runtimes never reinterpret this as queueing. */
  readonly steer?: WorkbenchSteerControl;
  readonly session?: {
    readonly context?: WorkbenchSessionContextUsage;
    readonly profile: WorkbenchSessionProfileProjection;
    readonly timeline: readonly WorkbenchTimelineEvent[];
    /**
     * Exact per-command slices used for reply attribution. Absent only on an
     * older renderer payload; consumers must not substitute the latest
     * Session profile when it is absent.
     */
    readonly turns?: readonly WorkbenchTurnView[];
    /** Rotates with the latest sanitized snapshot and resolves only to deletion. */
    readonly removalKey: string;
    /** Rotates with the latest sanitized snapshot and resolves only to metadata mutation. */
    readonly metadataKey: string;
    readonly archived: boolean;
    /** Rotates with the latest sanitized snapshot and is never a durable ID. */
    readonly selectionKey: string | null;
    readonly resumable: boolean;
  };
}

export type WorkbenchRequestedSessionProfileProjection =
  | RequestedSessionProfileProjection
  | { readonly kind: "not-recorded" };

export type WorkbenchEffectiveSessionProfileProjection =
  | EffectiveSessionProfileProjection
  | { readonly kind: "not-recorded" };

export interface WorkbenchSessionProfileProjection {
  /**
   * Compile-time compatibility for pre-projection readers. The public
   * sanitizer accepts only the two exact fields below and rejects extras.
   */
  readonly [unsupportedLegacyField: string]: unknown;
  readonly requested: WorkbenchRequestedSessionProfileProjection;
  readonly effective: WorkbenchEffectiveSessionProfileProjection;
}

export interface WorkbenchProjectView {
  readonly project: {
    readonly label: string;
  };
  readonly observation: {
    readonly cursor: number;
    readonly live: true;
  };
  readonly commands: readonly WorkbenchCommandView[];
  readonly initialSelectionKey: string | null;
}

export interface WorkbenchProjectFailure {
  readonly category: "project-view-unavailable";
  readonly message: "Live Project data is unavailable.";
}

export type WorkbenchProjectResult =
  | { readonly ok: true; readonly view: WorkbenchProjectView }
  | { readonly ok: false; readonly error: WorkbenchProjectFailure };

export type WorkbenchProjectListener = (result: WorkbenchProjectResult) => void;

export type WorkbenchProjectAvailability =
  | "available"
  | "missing"
  | "unreadable";

export interface WorkbenchProjectOption {
  readonly label: string;
  readonly availability: WorkbenchProjectAvailability;
  readonly selected: boolean;
  /** Rotates with the exact sanitized Project-list snapshot. */
  readonly selectionKey: string;
}

export interface WorkbenchProjectSelectionSnapshot {
  readonly projects: readonly WorkbenchProjectOption[];
}

export interface WorkbenchHostedProjectView extends WorkbenchProjectView {
  readonly projectSelection: WorkbenchProjectSelectionSnapshot;
}

export type WorkbenchHostedProjectResult =
  | { readonly ok: true; readonly view: WorkbenchHostedProjectView }
  | { readonly ok: false; readonly error: WorkbenchProjectFailure };

export type WorkbenchHostedProjectListener = (
  result: WorkbenchHostedProjectResult,
) => void;

export interface WorkbenchProjectSelectionRequest {
  readonly selectionKey: string;
}

export interface WorkbenchSessionRemovalRequest {
  /** Snapshot-scoped capability; never a durable Session identity. */
  readonly removalKey: string;
  /**
   * Present only when the owner confirmed a removal whose last turn outcome was
   * never established. It releases the terminal `recovery-required` barrier and
   * nothing else: active work still blocks. The only legal value is `true`.
   */
  readonly acknowledgedUnknownOutcome?: true;
}

export interface WorkbenchSessionMetadataMutationRequest {
  /** Snapshot-scoped capability; never a durable Session identity. */
  readonly metadataKey: string;
  readonly operation: SessionMetadataOperation;
}

export type WorkbenchSessionMetadataMutationResult =
  | SessionMetadataMutationResult
  | { readonly status: "unavailable" };

export type WorkbenchSessionRemovalResult =
  | { readonly status: "removed" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "blocked";
      readonly activity: Exclude<ProjectTurnActivity, "idle">;
    };

export type WorkbenchProjectRemovalResult =
  | { readonly status: "removed" }
  | { readonly status: "invalid-selection" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "blocked";
      readonly activity: Exclude<ProjectTurnActivity, "idle">;
    };

/**
 * One recorded conversation history that belongs to a Project's directory.
 *
 * A Project directory can own more than one history because older product
 * versions or external recovery can leave multiple matching ledgers. Each
 * history is attributed to its directory by the digest the ledger itself
 * stores, never by a name or a guess.
 *
 * Counts only — never a Session name, a prompt, a reply or a path.
 */
export interface WorkbenchProjectHistoryOption {
  /** Snapshot-scoped capability; never a durable ledger identity. */
  readonly historyKey: string;
  /** True for the history this Project shows today. */
  readonly current: boolean;
  readonly sessionCount: number;
  readonly commandCount: number;
  readonly updateCount: number;
  readonly byteSize: number;
  /** UTC, second precision: `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly lastModified: string;
  readonly schemaVersion: number;
}

export interface WorkbenchProjectHistorySnapshot {
  readonly projectLabel: string;
  readonly histories: readonly WorkbenchProjectHistoryOption[];
}

export type WorkbenchProjectHistoryDiscoveryResult =
  | {
      readonly status: "discovered";
      readonly snapshot: WorkbenchProjectHistorySnapshot;
    }
  | { readonly status: "invalid-selection" }
  | { readonly status: "unavailable" };

export interface WorkbenchProjectHistoryAdoptionRequest {
  /** Snapshot-scoped capability minted by the last discovery. */
  readonly historyKey: string;
}

/**
 * Adoption points the Project Registry at the chosen history. No ledger file
 * is opened for writing, copied, moved, merged or deleted, so every other
 * history remains discoverable and the owner can switch back.
 */
export type WorkbenchProjectHistoryAdoptionResult =
  | { readonly status: "adopted" }
  | { readonly status: "invalid-selection" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "blocked";
      readonly activity: Exclude<ProjectTurnActivity, "idle">;
    };

export interface WorkbenchProjectHistoryHideRequest {
  /** Snapshot-scoped capability minted by the last discovery. */
  readonly historyKey: string;
}

/**
 * Hiding records one host-private visibility choice and leaves the ledger file
 * untouched. Only a non-current history with zero recorded Sessions is
 * eligible; the host re-reads that count immediately before committing.
 */
export type WorkbenchProjectHistoryHideResult =
  | { readonly status: "hidden" }
  | { readonly status: "ineligible" }
  | { readonly status: "invalid-selection" }
  | { readonly status: "unavailable" };

export interface WorkbenchProjectSelectionFailure {
  readonly category:
    | "invalid-project-selection"
    | "project-unavailable"
    | "project-switch-unavailable";
  readonly message:
    | "Reload the Project list and choose an available Project."
    | "This Project is unavailable. Choose another Project or restore its directory."
    | "The Project could not be opened. Keep the current Project and try again.";
}

export type WorkbenchProjectSelectionResult =
  | {
      readonly ok: true;
      readonly status: "selected";
      readonly message:
        | "Project was opened."
        | "Project was opened with its existing conversation history.";
    }
  | {
      readonly ok: true;
      readonly status: "history-selection-required";
      readonly message: "Choose which existing conversation history this Project should show. Nothing changed yet.";
      readonly snapshot: WorkbenchProjectHistorySnapshot;
    }
  | { readonly ok: false; readonly error: WorkbenchProjectSelectionFailure };

export interface WorkbenchOpenProjectFailure {
  readonly category: "project-open-unavailable";
  readonly message: "Open Project could not be completed. Keep the current Project and try again.";
}

export type WorkbenchOpenProjectResult =
  | {
      readonly ok: true;
      readonly status: "opened";
      readonly message:
        | "Project was opened."
        | "Project was opened with its existing conversation history.";
    }
  | {
      readonly ok: true;
      readonly status: "history-selection-required";
      readonly message: "Choose which existing conversation history this Project should show. Nothing changed yet.";
      readonly snapshot: WorkbenchProjectHistorySnapshot;
    }
  | {
      readonly ok: true;
      readonly status: "cancelled";
      readonly message: "Open Project was cancelled. Nothing changed.";
    }
  | { readonly ok: false; readonly error: WorkbenchOpenProjectFailure };

export type WorkbenchCreateProjectOutcome =
  | "created"
  | "cancelled"
  | "unavailable"
  | "created-recovery-required";

export interface WorkbenchCreateProjectResult {
  readonly outcome: WorkbenchCreateProjectOutcome;
}

export interface WorkbenchSessionProfileOption {
  readonly key: string;
  readonly label: string;
}

export interface WorkbenchWorkIntensityOption
  extends WorkbenchSessionProfileOption {
  /** Present only when catalog data declares the Execution Mode implication. */
  readonly impliedExecutionModeKey?: string;
}

export interface WorkbenchModelOption extends WorkbenchSessionProfileOption {
  /** Runtime display wording retained as secondary provenance, when supplied. */
  readonly provenanceLabel: string | null;
  /** Null means the Runtime supplied no separate control label. */
  readonly workIntensityLabel: string | null;
  readonly workIntensities: readonly WorkbenchWorkIntensityOption[];
}

export type WorkbenchRuntimeEndpointId =
  | "codex-desktop"
  | "claude-code-desktop";

export type WorkbenchRuntimeEndpointDiscoveryCategory =
  | "catalog-ready"
  | "runtime-not-located"
  | "authentication-required"
  | "inspection-failed"
  | "not-inspected";

export interface WorkbenchCodexRuntimeEndpointDiscoveryStatus {
  readonly endpointId: "codex-desktop";
  readonly category: WorkbenchRuntimeEndpointDiscoveryCategory;
}

export interface WorkbenchClaudeRuntimeEndpointDiscoveryStatus {
  readonly endpointId: "claude-code-desktop";
  readonly category: WorkbenchRuntimeEndpointDiscoveryCategory;
}

export type WorkbenchRuntimeEndpointDiscoveryStatus =
  | WorkbenchCodexRuntimeEndpointDiscoveryStatus
  | WorkbenchClaudeRuntimeEndpointDiscoveryStatus;

export interface WorkbenchRuntimeEndpointDiscovery {
  readonly statuses: readonly [
    WorkbenchCodexRuntimeEndpointDiscoveryStatus,
    WorkbenchClaudeRuntimeEndpointDiscoveryStatus,
  ];
}

export type WorkbenchSubscriptionAuthenticationStatus =
  | "bound"
  | "unbound"
  | "authentication-required"
  | "unknown";

export type WorkbenchSubscriptionAuthenticationState =
  | "bound"
  | "sign-in-required"
  | "unknown";

export type WorkbenchSubscriptionAuthenticationAction = "login" | "logout";

export type WorkbenchSubscriptionAuthenticationPublicRequest =
  | Readonly<{ endpointSelectionKey: string }>
  | Readonly<{
      endpointSelectionKey: string;
      action: WorkbenchSubscriptionAuthenticationAction;
    }>
  | Readonly<{ preparationKey: string }>;

export interface WorkbenchSubscriptionAuthenticationBlockers {
  readonly accepted: number;
  readonly starting: number;
  readonly inFlight: number;
  readonly recoveryRequired: number;
  readonly unknown: number;
}

export type WorkbenchSubscriptionAuthenticationPublicResponse =
  | Readonly<{
      kind: "authentication-state";
      state: WorkbenchSubscriptionAuthenticationState;
    }>
  | Readonly<{
      kind: "blocked";
      blockers: WorkbenchSubscriptionAuthenticationBlockers;
    }>
  | Readonly<{
      kind: "confirmation-required";
      preparationKey: string;
      consequences: Readonly<{
        resumableSessionCount: number;
        projectCount: number;
      }>;
    }>
  | Readonly<{ kind: "ready"; preparationKey: string }>
  | Readonly<{
      kind: "authentication-action-requested";
      action: WorkbenchSubscriptionAuthenticationAction;
    }>
  | Readonly<{
      kind: "authentication-action-not-requested";
      action: WorkbenchSubscriptionAuthenticationAction;
    }>
  /**
   * The provider CLI was asked to act, but the Workbench could not record it.
   * Neither neighbouring kind may stand in: `not-requested` would promise that
   * nothing was lost, and `requested` would hide that resumability was never
   * fenced. It carries the same two keys so the seam stays exact.
   */
  | Readonly<{
      kind: "authentication-action-partially-completed";
      action: WorkbenchSubscriptionAuthenticationAction;
    }>;

export type WorkbenchSubscriptionAuthenticationBoundaryResult<Value> =
  | Readonly<{ accepted: true; value: Value }>
  | Readonly<{ accepted: false }>;

export interface WorkbenchSubscriptionAuthenticationOpaqueKeyAuthority {
  isEndpointSelectionKey(value: string): boolean;
  isPreparationKey(value: string): boolean;
}

export type WorkbenchSubscriptionAuthenticationEffect =
  | "pending"
  | "finished"
  | "cancelled"
  | "timed-out"
  | "launch-failed"
  | "shutdown-failed";

export interface WorkbenchSubscriptionAuthenticationRequest {
  readonly endpointId: WorkbenchRuntimeEndpointId;
}

export interface WorkbenchSubscriptionAuthenticationFailure {
  readonly category: "subscription-authentication-unavailable";
  readonly message: "Subscription authentication is unavailable. Keep the current status and try again.";
}

export type WorkbenchSubscriptionAuthenticationSnapshotResult =
  | {
      readonly ok: true;
      readonly endpointId: WorkbenchRuntimeEndpointId;
      readonly authentication: WorkbenchSubscriptionAuthenticationStatus;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchSubscriptionAuthenticationFailure;
    };

export type WorkbenchSubscriptionAuthenticationEffectResult =
  | {
      readonly ok: true;
      readonly endpointId: WorkbenchRuntimeEndpointId;
      readonly effect: WorkbenchSubscriptionAuthenticationEffect;
      readonly authentication: WorkbenchSubscriptionAuthenticationStatus;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchSubscriptionAuthenticationFailure;
    };

export interface WorkbenchRuntimeEndpointOption {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly key: string;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly models: readonly WorkbenchModelOption[];
  readonly executionModes: readonly WorkbenchSessionProfileOption[];
  /** Access remains an endpoint-scoped selection independent of model/intensity. */
  readonly accessModes: readonly WorkbenchSessionProfileOption[];
}

export interface WorkbenchDirectSessionProfileSelection {
  readonly snapshotKey: string;
  readonly endpointKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
  readonly executionModeKey: string;
  readonly accessModeKey: string;
}

export type WorkbenchDesiredDefault =
  | {
      readonly kind: "resolved";
      readonly endpointKey: string;
      readonly modelKey: string;
      readonly workIntensityKey: string;
      readonly executionModeKey: string;
      readonly accessModeKey: string;
    }
  | { readonly kind: "unavailable" };

export type WorkbenchReplacementPrefill =
  | {
      readonly kind: "resolved";
      readonly endpointKey: string;
      readonly modelKey: string;
      readonly workIntensityKey: string;
      readonly executionModeKey: string;
      readonly accessModeKey: string;
    }
  | { readonly kind: "manual-selection-required" };

export interface WorkbenchCatalogDefaultProfileLoadRequest {
  readonly kind: "catalog-default";
}

export interface WorkbenchReplacementSessionProfileLoadRequest {
  readonly kind: "replacement-session";
  readonly sourceSelectionKey: string;
  readonly sourceSnapshotCursor: number;
}

export interface WorkbenchContinuationSessionProfileLoadRequest {
  readonly kind: "continuation-session";
  readonly selectionKey: string;
}

export type WorkbenchDirectSessionProfileLoadRequest =
  | WorkbenchCatalogDefaultProfileLoadRequest
  | WorkbenchReplacementSessionProfileLoadRequest
  | WorkbenchContinuationSessionProfileLoadRequest;

export interface WorkbenchDirectSessionProfile {
  readonly snapshotKey: string;
  readonly endpoints: readonly WorkbenchRuntimeEndpointOption[];
  readonly desiredDefault: WorkbenchDesiredDefault;
}

export interface WorkbenchReplacementDirectSessionProfile {
  readonly snapshotKey: string;
  readonly endpoints: readonly WorkbenchRuntimeEndpointOption[];
  readonly replacementPrefill: WorkbenchReplacementPrefill;
}

export interface WorkbenchContinuationPrefill {
  readonly kind: "resolved";
  readonly endpointKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
  readonly executionModeKey: string;
  readonly accessModeKey: string;
}

export interface WorkbenchContinuationDirectSessionProfile {
  readonly snapshotKey: string;
  /** Exactly one current endpoint, already proven compatible with the Session. */
  readonly endpoints: readonly [WorkbenchRuntimeEndpointOption];
  readonly continuationPrefill: WorkbenchContinuationPrefill;
}

export type WorkbenchLoadedDirectSessionProfile =
  | WorkbenchDirectSessionProfile
  | WorkbenchReplacementDirectSessionProfile
  | WorkbenchContinuationDirectSessionProfile;

/**
 * A backend-only compatibility projection for the protected catalog validator.
 * Implementations expose these aliases as non-enumerable properties, so the
 * renderer-facing sanitizer sees only WorkbenchDirectSessionProfile.
 */
export interface WorkbenchBackendDirectSessionProfile
  extends WorkbenchDirectSessionProfile {
  readonly runtime: string;
  readonly models: readonly WorkbenchModelOption[];
  readonly executionMode: {
    readonly value: "single-agent";
    readonly label: string;
    readonly fixed: true;
  };
  readonly accessMode: {
    readonly value: "full-access";
    readonly label: string;
    readonly fixed: true;
    readonly independent: true;
  };
}

export interface WorkbenchBackendReplacementDirectSessionProfile
  extends WorkbenchReplacementDirectSessionProfile {
  readonly runtime: string;
  readonly models: readonly WorkbenchModelOption[];
  readonly executionMode: {
    readonly value: "single-agent";
    readonly label: string;
    readonly fixed: true;
  };
  readonly accessMode: {
    readonly value: "full-access";
    readonly label: string;
    readonly fixed: true;
    readonly independent: true;
  };
}

export interface WorkbenchBackendContinuationDirectSessionProfile
  extends WorkbenchContinuationDirectSessionProfile {
  readonly runtime: string;
  readonly models: readonly WorkbenchModelOption[];
  readonly executionMode: {
    readonly value: "single-agent";
    readonly label: string;
    readonly fixed: true;
  };
  readonly accessMode: {
    readonly value: "full-access";
    readonly label: string;
    readonly fixed: true;
    readonly independent: true;
  };
}

export type WorkbenchProfileLoadFailure =
  | {
      readonly category: "profile-unavailable";
      readonly message: "Codex Session Profile options are unavailable. Keep your draft and try again.";
    }
  | {
      readonly category: "runtime-not-located";
      readonly message: "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.";
    }
  | {
      readonly category: "continuation-unavailable";
      readonly message: "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.";
    }
  | {
      readonly category: "continuation-model-unavailable";
      readonly message: "This Session's recorded model is no longer offered by its provider, so the next turn can't be prepared. The Session and its transcript are kept; start a New Agent Session to carry the work on.";
    };

type WorkbenchDirectSessionProfileFailureResult =
  {
    readonly ok: false;
    readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
    readonly error: WorkbenchProfileLoadFailure;
  };

export type WorkbenchCatalogDefaultProfileResult =
  | {
      readonly ok: true;
      readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
      readonly profile: WorkbenchBackendDirectSessionProfile;
    }
  | WorkbenchDirectSessionProfileFailureResult;

export type WorkbenchReplacementSessionProfileResult =
  | {
      readonly ok: true;
      readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
      readonly profile: WorkbenchBackendReplacementDirectSessionProfile;
    }
  | WorkbenchDirectSessionProfileFailureResult;

export type WorkbenchContinuationSessionProfileResult =
  | {
      readonly ok: true;
      readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
      readonly profile: WorkbenchBackendContinuationDirectSessionProfile;
    }
  | WorkbenchDirectSessionProfileFailureResult;

export type WorkbenchDirectSessionProfileResult =
  WorkbenchCatalogDefaultProfileResult;

export type WorkbenchAnyDirectSessionProfileResult =
  | WorkbenchCatalogDefaultProfileResult
  | WorkbenchReplacementSessionProfileResult
  | WorkbenchContinuationSessionProfileResult;

export type WorkbenchDirectSessionProfileResultFor<
  Request extends WorkbenchDirectSessionProfileLoadRequest,
> = Request extends WorkbenchCatalogDefaultProfileLoadRequest
  ? WorkbenchCatalogDefaultProfileResult
  : Request extends WorkbenchReplacementSessionProfileLoadRequest
    ? WorkbenchReplacementSessionProfileResult
    : WorkbenchContinuationSessionProfileResult;

export type WorkbenchCatalogDefaultPublicProfileResult =
  | {
      readonly ok: true;
      readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
      readonly profile: WorkbenchDirectSessionProfile;
    }
  | WorkbenchDirectSessionProfileFailureResult;

export type WorkbenchReplacementSessionPublicProfileResult =
  | {
      readonly ok: true;
      readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
      readonly profile: WorkbenchReplacementDirectSessionProfile;
    }
  | WorkbenchDirectSessionProfileFailureResult;

export type WorkbenchContinuationSessionPublicProfileResult =
  | {
      readonly ok: true;
      readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
      readonly profile: WorkbenchContinuationDirectSessionProfile;
    }
  | WorkbenchDirectSessionProfileFailureResult;

export type WorkbenchPublicDirectSessionProfileResult =
  WorkbenchCatalogDefaultPublicProfileResult;

export type WorkbenchAnyPublicDirectSessionProfileResult =
  | WorkbenchCatalogDefaultPublicProfileResult
  | WorkbenchReplacementSessionPublicProfileResult
  | WorkbenchContinuationSessionPublicProfileResult;

export type WorkbenchPublicDirectSessionProfileResultFor<
  Request extends WorkbenchDirectSessionProfileLoadRequest,
> = Request extends WorkbenchCatalogDefaultProfileLoadRequest
  ? WorkbenchCatalogDefaultPublicProfileResult
  : Request extends WorkbenchReplacementSessionProfileLoadRequest
    ? WorkbenchReplacementSessionPublicProfileResult
    : WorkbenchContinuationSessionPublicProfileResult;

export interface WorkbenchDirectSessionProfileDefaultRequest
  extends WorkbenchDirectSessionProfileSelection {}

export interface WorkbenchDirectSessionProfileDefaultFailure {
  readonly category:
    | "invalid-profile-selection"
    | "preference-unavailable";
  readonly message:
    | "Reload Codex Session Profile options and choose a model and Work Intensity."
    | "Codex Session Profile default could not be durably saved. Keep your selection and try again.";
}

export type WorkbenchDirectSessionProfileDefaultResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly message: "Codex Session Profile default was durably saved.";
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchDirectSessionProfileDefaultFailure;
    };

export interface WorkbenchStartDirectInputRequest {
  readonly kind: "start";
  readonly input: string;
  readonly snapshotKey: string;
  readonly endpointKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
  readonly executionModeKey: string;
  readonly accessModeKey: string;
}

export interface WorkbenchContinueDirectInputRequest {
  readonly kind: "continue";
  readonly input: string;
  readonly selectionKey: string;
  readonly snapshotKey: string;
  readonly endpointKey: string;
  readonly modelKey: string;
  readonly workIntensityKey: string;
  readonly executionModeKey: string;
  readonly accessModeKey: string;
}

export type WorkbenchDirectInputRequest =
  | WorkbenchStartDirectInputRequest
  | WorkbenchContinueDirectInputRequest;

export interface WorkbenchSubmissionFailure {
  readonly category:
    | "invalid-input"
    | "invalid-profile-selection"
    | "continuation-unavailable"
    | "submission-unavailable";
  readonly message:
    | "Enter a non-empty instruction of at most 8,000 characters."
    | "Reload Codex Session Profile options and choose a model and Work Intensity."
    | "This Agent Session cannot be continued. Keep your draft and choose a resumable Session."
    | "Starting an Agent Session on this Runtime is not yet supported. Keep your draft and choose another endpoint."
    | "Direct input could not be durably accepted. Keep your draft and try again.";
}

export type WorkbenchSubmissionResult =
  | {
      readonly ok: true;
      readonly status: "accepted";
      readonly message: "Direct input was durably accepted.";
    }
  | { readonly ok: false; readonly error: WorkbenchSubmissionFailure };

export interface WorkbenchInterruptRequest {
  readonly interruptKey: string;
}

export interface WorkbenchInterruptFailure {
  readonly category: "invalid-interrupt" | "interrupt-unavailable";
  readonly message:
    | "Reload the running Agent Session and try again."
    | "Interrupt is unavailable for this turn.";
}

export type WorkbenchInterruptResult =
  | {
      readonly ok: true;
      readonly status: "requested";
      readonly message: "Interrupt requested.";
    }
  | { readonly ok: false; readonly error: WorkbenchInterruptFailure };

export interface WorkbenchSteerRequest {
  readonly steerKey: string;
  readonly input: string;
}

export interface WorkbenchSteerFailure {
  readonly category: "invalid-steer" | "steer-unavailable";
  readonly message:
    | "Reload the running Agent Session and try again."
    | "Same-turn guidance is unavailable. Your draft was kept.";
}

export type WorkbenchSteerResult =
  | {
      readonly ok: true;
      readonly status: "accepted";
      readonly message: "Guidance was accepted into the running turn.";
    }
  | { readonly ok: false; readonly error: WorkbenchSteerFailure };

export interface WorkbenchRendererBridge
  extends Partial<HistoryRecoveryRendererBridge>,
    Partial<WorkbenchClipboardRendererBridge>,
    Partial<WorkbenchNotificationRendererBridge> {
  observeProject(listener: WorkbenchHostedProjectListener): () => void;
  inspectSubscriptionAuthentication?(
    request: Readonly<{ endpointSelectionKey: string }>,
  ): Promise<WorkbenchSubscriptionAuthenticationPublicResponse>;
  prepareSubscriptionAuthentication?(
    request: Readonly<{
      endpointSelectionKey: string;
      action: WorkbenchSubscriptionAuthenticationAction;
    }>,
  ): Promise<WorkbenchSubscriptionAuthenticationPublicResponse>;
  beginSubscriptionAuthentication?(
    request: Readonly<{ preparationKey: string }>,
  ): Promise<WorkbenchSubscriptionAuthenticationPublicResponse>;
  cancelPreparedSubscriptionAuthentication?(
    request: Readonly<{ preparationKey: string }>,
  ): Promise<void>;
  loadAppearancePreference(): Promise<WorkbenchAppearancePreferenceLoadResult>;
  saveAppearancePreference(
    preference: WorkbenchAppearancePreference,
  ): Promise<WorkbenchAppearancePreferenceSaveResult>;
  loadClaudePermissionHandling(): Promise<WorkbenchClaudePermissionHandlingLoadResult>;
  saveClaudePermissionHandling(
    permissionHandling: WorkbenchClaudePermissionHandling,
  ): Promise<WorkbenchClaudePermissionHandlingSaveResult>;
  loadRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablesLoadResult>;
  saveRuntimeExecutable(
    request: WorkbenchRuntimeExecutableSaveRequest,
  ): Promise<WorkbenchRuntimeExecutableSaveResult>;
  createProject(): Promise<WorkbenchCreateProjectResult>;
  openProject(): Promise<WorkbenchOpenProjectResult>;
  selectProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectSelectionResult>;
  removeSession(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult>;
  mutateSessionMetadata(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult>;
  removeProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectRemovalResult>;
  discoverProjectHistories?(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectHistoryDiscoveryResult>;
  adoptProjectHistory?(
    request: WorkbenchProjectHistoryAdoptionRequest,
  ): Promise<WorkbenchProjectHistoryAdoptionResult>;
  hideProjectHistory?(
    request: WorkbenchProjectHistoryHideRequest,
  ): Promise<WorkbenchProjectHistoryHideResult>;
  loadDirectSessionProfile(
    request: WorkbenchDirectSessionProfileLoadRequest,
  ): Promise<WorkbenchAnyPublicDirectSessionProfileResult>;
  useDirectSessionProfileAsDefault(
    request: WorkbenchDirectSessionProfileDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult>;
  submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult>;
  interruptActiveTurn?(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult>;
  steerActiveTurn?(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult>;
}

export function publicAppearancePreferenceLoaded(
  appearance: WorkbenchAppearancePreference,
): WorkbenchAppearancePreferenceLoadResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    appearance: Object.freeze({
      tone: appearance.tone,
      crt: appearance.crt,
      phosphor: appearance.phosphor,
      phosphorTier: appearance.phosphorTier,
      language: appearance.language ?? "en",
    }),
  });
}

export function publicAppearancePreferenceSaved(): WorkbenchAppearancePreferenceSaveResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    message: "Appearance preference was durably saved.",
  });
}

export function publicAppearancePreferenceUnavailable(): Extract<
  WorkbenchAppearancePreferenceLoadResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "appearance-preference-unavailable",
      message:
        "Appearance preferences could not be loaded or saved. Keep the current appearance and try again.",
    }),
  });
}

export function publicClaudePermissionHandlingLoaded(
  permissionHandling: WorkbenchClaudePermissionHandling,
): WorkbenchClaudePermissionHandlingLoadResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    permissionHandling,
  });
}

export function publicClaudePermissionHandlingSaved(): WorkbenchClaudePermissionHandlingSaveResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    message: "Claude permission handling was durably saved.",
  });
}

export function publicClaudePermissionHandlingUnavailable(): Extract<
  WorkbenchClaudePermissionHandlingLoadResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "claude-permission-handling-unavailable",
      message:
        "Claude permission handling could not be loaded or saved. Keep the current choice and try again.",
    }),
  });
}

export function publicRuntimeExecutablesLoaded(
  executables: WorkbenchRuntimeExecutablePaths,
): WorkbenchRuntimeExecutablesLoadResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    executables: Object.freeze({
      codex: executables.codex,
      claude: executables.claude,
    }),
  });
}

export function publicRuntimeExecutableSaved(
  executables: WorkbenchRuntimeExecutablePaths,
): WorkbenchRuntimeExecutableSaveResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    executables: Object.freeze({
      codex: executables.codex,
      claude: executables.claude,
    }),
  });
}

export function publicRuntimeExecutableRejected(
  reason: WorkbenchRuntimeExecutableRejection,
): Extract<WorkbenchRuntimeExecutableSaveResult, { readonly ok: false }> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "runtime-executable-rejected",
      message: "That path cannot be used to start this runtime.",
      reason,
    }),
  });
}

export function publicRuntimeExecutableUnavailable(): Extract<
  WorkbenchRuntimeExecutablesLoadResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "runtime-executable-unavailable",
      message:
        "The executable path could not be loaded or saved. Keep the current value and try again.",
    }),
  });
}

export function publicCreateProjectResult(
  outcome: WorkbenchCreateProjectOutcome,
): WorkbenchCreateProjectResult {
  return Object.freeze({ outcome });
}

export function publicProjectFailure(): WorkbenchProjectResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    }),
  });
}

export function publicHostedProjectFailure(): WorkbenchHostedProjectResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    }),
  });
}

export function publicProjectSelected(): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
}

export function publicProjectSelectedWithExistingHistory(): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: true,
    status: "selected",
    message: "Project was opened with its existing conversation history.",
  });
}

export function publicProjectHistorySelectionRequired(
  snapshot: WorkbenchProjectHistorySnapshot,
): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: true,
    status: "history-selection-required",
    message:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    snapshot,
  });
}

export function publicProjectOpened(): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
}

export function publicProjectOpenedWithExistingHistory(): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: true,
    status: "opened",
    message: "Project was opened with its existing conversation history.",
  });
}

export function publicOpenProjectHistorySelectionRequired(
  snapshot: WorkbenchProjectHistorySnapshot,
): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: true,
    status: "history-selection-required",
    message:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    snapshot,
  });
}

export function publicProjectOpenCancelled(): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
  });
}

export function publicProjectOpenUnavailable(): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    }),
  });
}

export function publicInvalidProjectSelection(): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "invalid-project-selection",
      message: "Reload the Project list and choose an available Project.",
    }),
  });
}

export function publicProjectUnavailable(): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-unavailable",
      message:
        "This Project is unavailable. Choose another Project or restore its directory.",
    }),
  });
}

export function publicProjectSwitchUnavailable(): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    }),
  });
}

export function publicSubmissionAccepted(): WorkbenchSubmissionResult {
  return Object.freeze({
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
}

export function publicInterruptRequested(): Extract<
  WorkbenchInterruptResult,
  { readonly ok: true }
> {
  return Object.freeze({
    ok: true,
    status: "requested",
    message: "Interrupt requested.",
  });
}

export function publicInvalidInterrupt(): Extract<
  WorkbenchInterruptResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "invalid-interrupt",
      message: "Reload the running Agent Session and try again.",
    }),
  });
}

export function publicInterruptUnavailable(): Extract<
  WorkbenchInterruptResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "interrupt-unavailable",
      message: "Interrupt is unavailable for this turn.",
    }),
  });
}

export function publicSteerAccepted(): Extract<
  WorkbenchSteerResult,
  { readonly ok: true }
> {
  return Object.freeze({
    ok: true,
    status: "accepted",
    message: "Guidance was accepted into the running turn.",
  });
}

export function publicInvalidSteer(): Extract<
  WorkbenchSteerResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "invalid-steer",
      message: "Reload the running Agent Session and try again.",
    }),
  });
}

export function publicSteerUnavailable(): Extract<
  WorkbenchSteerResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "steer-unavailable",
      message: "Same-turn guidance is unavailable. Your draft was kept.",
    }),
  });
}

export function publicSubscriptionAuthenticationSnapshot(
  endpointId: WorkbenchRuntimeEndpointId,
  authentication: WorkbenchSubscriptionAuthenticationStatus,
): WorkbenchSubscriptionAuthenticationSnapshotResult {
  return Object.freeze({ ok: true, endpointId, authentication });
}

export function publicSubscriptionAuthenticationEffect(
  endpointId: WorkbenchRuntimeEndpointId,
  effect: WorkbenchSubscriptionAuthenticationEffect,
  authentication: WorkbenchSubscriptionAuthenticationStatus,
): WorkbenchSubscriptionAuthenticationEffectResult {
  return Object.freeze({ ok: true, endpointId, effect, authentication });
}

export function publicSubscriptionAuthenticationUnavailable():
  Extract<
    WorkbenchSubscriptionAuthenticationSnapshotResult,
    { readonly ok: false }
  > {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "subscription-authentication-unavailable",
      message:
        "Subscription authentication is unavailable. Keep the current status and try again.",
    }),
  });
}

export function publicRuntimeEndpointDiscovery(
  codexCategory: WorkbenchRuntimeEndpointDiscoveryCategory,
  claudeCategory: WorkbenchRuntimeEndpointDiscoveryCategory,
): WorkbenchRuntimeEndpointDiscovery {
  return Object.freeze({
    statuses: Object.freeze([
      Object.freeze({
        endpointId: "codex-desktop" as const,
        category: codexCategory,
      }),
      Object.freeze({
        endpointId: "claude-code-desktop" as const,
        category: claudeCategory,
      }),
    ] as const),
  });
}

export function publicProfileUnavailable(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery =
    publicRuntimeEndpointDiscovery("not-inspected", "not-inspected"),
): Extract<
  WorkbenchPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses[0].category,
      endpointDiscovery.statuses[1].category,
    ),
    error: Object.freeze({
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
    }),
  });
}

export function publicRuntimeNotLocated(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery =
    publicRuntimeEndpointDiscovery("runtime-not-located", "runtime-not-located"),
): Extract<
  WorkbenchPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses[0].category,
      endpointDiscovery.statuses[1].category,
    ),
    error: Object.freeze({
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
    }),
  });
}

export function publicContinuationProfileUnavailable(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery =
    publicRuntimeEndpointDiscovery("not-inspected", "not-inspected"),
): Extract<
  WorkbenchAnyPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses[0].category,
      endpointDiscovery.statuses[1].category,
    ),
    error: Object.freeze({
      category: "continuation-unavailable",
      message:
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    }),
  });
}

/* F214. A completed Session whose recorded model has left the provider's catalog
   is still resumable (its native thread is intact, and the inspector correctly
   reads `Resumable: Yes`), but its exact recorded profile can no longer be
   prefilled. The generic `continuation-unavailable` copy — "choose a resumable
   Session" — contradicted the inspector and named the wrong cause. This result
   names the real cause and does not deny the Session's resumability. Distinct
   from `publicContinuationProfileUnavailable`, which stays for the causes where
   the Session genuinely cannot be resumed (thread gone, session drift). */
export function publicContinuationModelUnavailable(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery =
    publicRuntimeEndpointDiscovery("not-inspected", "not-inspected"),
): Extract<
  WorkbenchAnyPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses[0].category,
      endpointDiscovery.statuses[1].category,
    ),
    error: Object.freeze({
      category: "continuation-model-unavailable",
      message:
        "This Session's recorded model is no longer offered by its provider, so the next turn can't be prepared. The Session and its transcript are kept; start a New Agent Session to carry the work on.",
    }),
  });
}

export function publicProfileDefaultSaved(): WorkbenchDirectSessionProfileDefaultResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    message: "Codex Session Profile default was durably saved.",
  });
}

export function publicInvalidProfileDefaultSelection(): WorkbenchDirectSessionProfileDefaultResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "invalid-profile-selection",
      message:
        "Reload Codex Session Profile options and choose a model and Work Intensity.",
    }),
  });
}

export function publicPreferenceUnavailable(): WorkbenchDirectSessionProfileDefaultResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "preference-unavailable",
      message:
        "Codex Session Profile default could not be durably saved. Keep your selection and try again.",
    }),
  });
}

export function publicInvalidSubmission(): WorkbenchSubmissionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "invalid-input",
      message: "Enter a non-empty instruction of at most 8,000 characters.",
    }),
  });
}

export function publicInvalidProfileSelection(): WorkbenchSubmissionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "invalid-profile-selection",
      message:
        "Reload Codex Session Profile options and choose a model and Work Intensity.",
    }),
  });
}

export function publicContinuationUnavailable(): WorkbenchSubmissionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "continuation-unavailable",
      message:
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    }),
  });
}

export function publicUnavailableSubmission(): WorkbenchSubmissionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    }),
  });
}

export function publicRuntimeStartUnsupported(): WorkbenchSubmissionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "submission-unavailable",
      message:
        "Starting an Agent Session on this Runtime is not yet supported. Keep your draft and choose another endpoint.",
    }),
  });
}

export function isValidWorkbenchDirectInput(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > WORKBENCH_DIRECT_INPUT_MAX_LENGTH ||
    value.trim().length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
