import type {
  EffectiveSessionProfileProjection,
  ProjectCommandFailureCategory,
  ProjectCommandStatus,
  ProjectTurnActivity,
  RequestedSessionProfileProjection,
} from "../coordinator/index.ts";
import type { ProjectCommandRecovery } from "../coordinator/types.ts";
import {
  SESSION_DISPLAY_NAME_MAX_CODE_POINTS,
  type SessionMetadataMutationResult,
  type SessionMetadataOperation,
} from "../session-metadata.ts";
import type { SubscriptionAuthenticationEndpointId } from "../agent-runtime/subscription-authentication.ts";
import type { HistoryRecoveryRendererBridge } from "./history-recovery-contract.ts";
import type { WorkbenchClipboardRendererBridge } from "./clipboard-bridge.ts";
import type { WorkbenchNotificationRendererBridge } from "./notification-bridge.ts";
import { WORKBENCH_RUNTIME_ENDPOINT_IDS } from "./runtime-endpoint-identity.ts";

/** Claude subscription account snapshot; null means never observed. */
export type WorkbenchSubscriptionUsageObservation = import("../agent-runtime/index.ts").RuntimeSubscriptionUsageObservation;
export type WorkbenchSubscriptionUsageResult =
  | { readonly ok: true; readonly observation: WorkbenchSubscriptionUsageObservation | null }
  | { readonly ok: false };
export const WORKBENCH_LOAD_SUBSCRIPTION_USAGE_CHANNEL = "workbench:load-subscription-usage";
export const WORKBENCH_SUBSCRIPTION_USAGE_CHANGED_CHANNEL = "workbench:subscription-usage-changed";

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
export const WORKBENCH_LOAD_ENDPOINT_PREFERENCES_CHANNEL =
  "workbench:load-endpoint-preferences";
export const WORKBENCH_SAVE_ENDPOINT_PREFERENCE_CHANNEL =
  "workbench:save-endpoint-preference";
export const WORKBENCH_LOAD_RUNTIME_EXECUTABLES_CHANNEL =
  "workbench:load-runtime-executables";
export const WORKBENCH_SAVE_RUNTIME_EXECUTABLE_CHANNEL =
  "workbench:save-runtime-executable";
export const WORKBENCH_INSTALL_RUNTIME_EXECUTABLE_CHANNEL =
  "workbench:install-runtime-executable";
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
/**
 * The endpoints whose API-transport keys are managed through the parameterized
 * endpoint-key surface (WO16 Part 1). One channel set, one sanitizer pair, one
 * renderer state machine serve every endpoint here; GLM semantics are
 * unchanged (the former GLM-only channels `workbench:load-glm-endpoint-key-status`
 * etc. became these endpoint-parameterized names in the same change).
 */
export const WORKBENCH_ENDPOINT_KEY_ENDPOINT_IDS = Object.freeze([
  "glm-coding-plan",
  "kimi-code",
  "deepseek-api",
  "kimi-platform",
  "claude-api",
  "codex-api",
] as const);

export type WorkbenchEndpointKeyEndpointId = (typeof WORKBENCH_ENDPOINT_KEY_ENDPOINT_IDS)[number];

/** The closed set of endpoint-key IPC channel names (five per endpoint). */
export type WorkbenchEndpointKeyChannel =
  | `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/load-status`
  | `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/save`
  | `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/remove`
  | `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/reveal`
  | `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/probe`;

export interface WorkbenchEndpointKeyChannels {
  readonly loadStatus: `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/load-status`;
  readonly save: `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/save`;
  readonly remove: `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/remove`;
  readonly reveal: `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/reveal`;
  readonly probe: `workbench:endpoint-key/${WorkbenchEndpointKeyEndpointId}/probe`;
}

export const WORKBENCH_ENDPOINT_KEY_CHANNELS: Readonly<
  Record<WorkbenchEndpointKeyEndpointId, WorkbenchEndpointKeyChannels>
> = Object.freeze({
  "glm-coding-plan": Object.freeze({
    loadStatus: "workbench:endpoint-key/glm-coding-plan/load-status",
    save: "workbench:endpoint-key/glm-coding-plan/save",
    remove: "workbench:endpoint-key/glm-coding-plan/remove",
    reveal: "workbench:endpoint-key/glm-coding-plan/reveal",
    probe: "workbench:endpoint-key/glm-coding-plan/probe",
  }),
  "kimi-code": Object.freeze({
    loadStatus: "workbench:endpoint-key/kimi-code/load-status",
    save: "workbench:endpoint-key/kimi-code/save",
    remove: "workbench:endpoint-key/kimi-code/remove",
    reveal: "workbench:endpoint-key/kimi-code/reveal",
    probe: "workbench:endpoint-key/kimi-code/probe",
  }),
  "deepseek-api": Object.freeze({
    loadStatus: "workbench:endpoint-key/deepseek-api/load-status",
    save: "workbench:endpoint-key/deepseek-api/save",
    remove: "workbench:endpoint-key/deepseek-api/remove",
    reveal: "workbench:endpoint-key/deepseek-api/reveal",
    probe: "workbench:endpoint-key/deepseek-api/probe",
  }),
  "kimi-platform": Object.freeze({
    loadStatus: "workbench:endpoint-key/kimi-platform/load-status",
    save: "workbench:endpoint-key/kimi-platform/save",
    remove: "workbench:endpoint-key/kimi-platform/remove",
    reveal: "workbench:endpoint-key/kimi-platform/reveal",
    probe: "workbench:endpoint-key/kimi-platform/probe",
  }),
  "claude-api": Object.freeze({
    loadStatus: "workbench:endpoint-key/claude-api/load-status",
    save: "workbench:endpoint-key/claude-api/save",
    remove: "workbench:endpoint-key/claude-api/remove",
    reveal: "workbench:endpoint-key/claude-api/reveal",
    probe: "workbench:endpoint-key/claude-api/probe",
  }),
  "codex-api": Object.freeze({
    loadStatus: "workbench:endpoint-key/codex-api/load-status",
    save: "workbench:endpoint-key/codex-api/save",
    remove: "workbench:endpoint-key/codex-api/remove",
    reveal: "workbench:endpoint-key/codex-api/reveal",
    probe: "workbench:endpoint-key/codex-api/probe",
  }),
});

/**
 * The endpoints whose Anthropic-compatible provider base URL is a persisted,
 * optional Settings override (w223 shipped this for `codex-api`; w232
 * generalizes it, adding an endpoint dimension to the same IPC/state shape
 * instead of copying it three times, and covers `glm-coding-plan`,
 * `deepseek-api` and `kimi-code`).
 */
export const WORKBENCH_BASE_URL_ENDPOINT_IDS = Object.freeze([
  "glm-coding-plan",
  "deepseek-api",
  "kimi-code",
  "codex-api",
] as const);

export type WorkbenchBaseUrlEndpointId =
  (typeof WORKBENCH_BASE_URL_ENDPOINT_IDS)[number];

export type WorkbenchBaseUrlChannel =
  | `workbench:base-url/${WorkbenchBaseUrlEndpointId}/load`
  | `workbench:base-url/${WorkbenchBaseUrlEndpointId}/save`;

export interface WorkbenchBaseUrlChannels {
  readonly load: `workbench:base-url/${WorkbenchBaseUrlEndpointId}/load`;
  readonly save: `workbench:base-url/${WorkbenchBaseUrlEndpointId}/save`;
}

export const WORKBENCH_BASE_URL_CHANNELS: Readonly<
  Record<WorkbenchBaseUrlEndpointId, WorkbenchBaseUrlChannels>
> = Object.freeze({
  "glm-coding-plan": Object.freeze({
    load: "workbench:base-url/glm-coding-plan/load",
    save: "workbench:base-url/glm-coding-plan/save",
  }),
  "deepseek-api": Object.freeze({
    load: "workbench:base-url/deepseek-api/load",
    save: "workbench:base-url/deepseek-api/save",
  }),
  "kimi-code": Object.freeze({
    load: "workbench:base-url/kimi-code/load",
    save: "workbench:base-url/kimi-code/save",
  }),
  "codex-api": Object.freeze({
    load: "workbench:base-url/codex-api/load",
    save: "workbench:base-url/codex-api/save",
  }),
});

export const WORKBENCH_DIRECT_INPUT_MAX_LENGTH = 8_000;
export const WORKBENCH_SESSION_DISPLAY_NAME_MAX_CODE_POINTS =
  SESSION_DISPLAY_NAME_MAX_CODE_POINTS;
export const WORKBENCH_LOAD_ENDPOINT_CATALOG_FRESHNESS_CHANNEL =
  "workbench:load-endpoint-catalog-freshness";
export const WORKBENCH_REFRESH_ENDPOINT_CATALOG_FRESHNESS_CHANNEL =
  "workbench:refresh-endpoint-catalog-freshness";

export const WORKBENCH_ENDPOINT_KEY_MAX_LENGTH = 4_096;
/** Compatibility alias from the GLM-only era; same value, generic name now. */
export const WORKBENCH_GLM_ENDPOINT_KEY_MAX_LENGTH =
  WORKBENCH_ENDPOINT_KEY_MAX_LENGTH;

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
 * A base-URL-endpoint's provider base URL override: plain user-typed text,
 * not a secret, so it lives in the appearance preference store rather than
 * the safeStorage-encrypted endpoint secret envelope (same split the
 * executable-path escape hatch uses). An empty string means "not set" --
 * that endpoint's official default applies -- matching the executable-path
 * convention so the key set never varies.
 *
 * Shipped for `codex-api` alone in ticket 21 (w223); w232 generalizes the
 * same shape across all four base-URL endpoints instead of duplicating it.
 */
export const WORKBENCH_BASE_URL_MAX_LENGTH = 2_048;

export const defaultWorkbenchBaseUrl = "";

export type WorkbenchBaseUrlRejection = "invalid-url";

export interface WorkbenchBaseUrlUnavailableFailure {
  readonly category: "base-url-unavailable";
  readonly message: "The base URL could not be loaded or saved. Keep the current value and try again.";
}

export interface WorkbenchBaseUrlRejectedFailure {
  readonly category: "base-url-rejected";
  readonly message: "That base URL cannot be used.";
  readonly reason: WorkbenchBaseUrlRejection;
}

export type WorkbenchBaseUrlFailure =
  | WorkbenchBaseUrlUnavailableFailure
  | WorkbenchBaseUrlRejectedFailure;

export type WorkbenchBaseUrlLoadResult =
  | {
      readonly ok: true;
      readonly status: "loaded";
      readonly baseUrl: string;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchBaseUrlUnavailableFailure;
    };

export type WorkbenchBaseUrlSaveResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly baseUrl: string;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchBaseUrlFailure;
    };

/**
 * The family facade's manual backend preferences (ticket 25, generalizing
 * ticket 20's Kimi-only surface). Each family's facade merges its two
 * endpoints into one presentation entry; the per-family preference is the
 * persisted ordering between them -- the preferred backend resolves first
 * when it is usable. The values are the real backend endpointIds (the
 * real-name discipline: the ledger records these ids), and each family's
 * default is exactly its automatic order, so an untouched preference and
 * the automatic resolution agree (claude/codex: subscription first, per
 * the ticket 25 resolution ruling; kimi: kimi-code first, per ticket 20).
 */
export type WorkbenchKimiEndpointPreference = "kimi-code" | "kimi-platform";

export type WorkbenchClaudeEndpointPreference =
  | "claude-code-desktop"
  | "claude-api";

export type WorkbenchCodexEndpointPreference = "codex-desktop" | "codex-api";

export type WorkbenchFamilyEndpointPreference =
  | WorkbenchKimiEndpointPreference
  | WorkbenchClaudeEndpointPreference
  | WorkbenchCodexEndpointPreference;

/** The facade families (ticket 25): the id names the family card/segment. */
export type WorkbenchEndpointFamilyId = "claude" | "codex" | "kimi";

export type WorkbenchFamilyEndpointPreferences = Readonly<{
  claude: WorkbenchClaudeEndpointPreference;
  codex: WorkbenchCodexEndpointPreference;
  kimi: WorkbenchKimiEndpointPreference;
}>;

export const defaultWorkbenchKimiEndpointPreference: WorkbenchKimiEndpointPreference =
  "kimi-code";

export const defaultWorkbenchClaudeEndpointPreference: WorkbenchClaudeEndpointPreference =
  "claude-code-desktop";

export const defaultWorkbenchCodexEndpointPreference: WorkbenchCodexEndpointPreference =
  "codex-desktop";

export const defaultWorkbenchFamilyEndpointPreferences: WorkbenchFamilyEndpointPreferences =
  Object.freeze({
    claude: defaultWorkbenchClaudeEndpointPreference,
    codex: defaultWorkbenchCodexEndpointPreference,
    kimi: defaultWorkbenchKimiEndpointPreference,
  });

/** Which family a backend preference belongs to (values are total). */
export function workbenchEndpointPreferenceFamily(
  preference: WorkbenchFamilyEndpointPreference,
): WorkbenchEndpointFamilyId {
  if (
    preference === "claude-code-desktop" ||
    preference === "claude-api"
  ) {
    return "claude";
  }
  if (preference === "codex-desktop" || preference === "codex-api") {
    return "codex";
  }
  return "kimi";
}

export interface WorkbenchEndpointPreferenceFailure {
  readonly category: "endpoint-preference-unavailable";
  readonly message:
    "The endpoint preference could not be loaded or saved. Keep the current choice and try again.";
}

export type WorkbenchEndpointPreferenceLoadResult =
  | {
      readonly ok: true;
      readonly status: "loaded";
      readonly preferences: WorkbenchFamilyEndpointPreferences;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointPreferenceFailure;
    };

export type WorkbenchEndpointPreferenceSaveResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly message: "The endpoint preference was durably saved.";
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointPreferenceFailure;
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

/**
 * The product installing a runtime for the user, into its own private
 * directory, then pointing the escape hatch at it. Same durable store, same
 * discovery seam, one more way to fill the field.
 */
export interface WorkbenchRuntimeInstallRequest {
  readonly runtime: WorkbenchConfigurableRuntime;
}

/** Which step an install stopped at; a FIXED vocabulary, like the rejections. */
export type WorkbenchRuntimeInstallStep =
  | "node-not-located"
  | "npm-not-located"
  | "install-failed"
  | "not-discovered";

/** npm's own last words, path-redacted and bounded before they cross. */
export const WORKBENCH_RUNTIME_INSTALL_DETAIL_MAX_LENGTH = 2_048;
export const WORKBENCH_RUNTIME_INSTALL_VERSION_MAX_LENGTH = 64;

export interface WorkbenchRuntimeInstallFailedFailure {
  readonly category: "runtime-install-failed";
  readonly message: "The private copy could not be installed.";
  readonly step: WorkbenchRuntimeInstallStep;
  readonly detail: string;
}

export type WorkbenchRuntimeInstallResult =
  | {
      readonly ok: true;
      readonly status: "installed";
      readonly runtime: WorkbenchConfigurableRuntime;
      readonly version: string;
      readonly executables: WorkbenchRuntimeExecutablePaths;
    }
  | {
      readonly ok: false;
      readonly error:
        | WorkbenchRuntimeInstallFailedFailure
        | WorkbenchRuntimeExecutableUnavailableFailure;
    };

/**
 * Same closed activity vocabulary as the runtime's progress events; the
 * renderer localizes these activity labels. Reasoning and messages carry text.
 */
export type WorkbenchProgressActivity =
  | "thinking"
  | "tool"
  | "retrying"
  | "rate-limited"
  | "status";

/** Failure reasons already admitted by the durable Runtime event stream. */
export const WORKBENCH_RUNTIME_FAILURE_CATEGORIES = Object.freeze([
  "approval-required",
  "authentication-required",
  "catalog-invalid",
  "correlation-invalid",
  "invalid-input",
  "protocol-invalid",
  "protocol-rejected",
  "runtime-shutdown",
  "runtime-not-located",
  "runtime-unavailable",
  "temp-cleanup",
  "temp-cleanup-guard",
  "transport-failed",
  "turn-failed",
  "unexpected-server-request",
  "unsupported-selection",
] as const);

export type WorkbenchRuntimeFailureCategory =
  (typeof WORKBENCH_RUNTIME_FAILURE_CATEGORIES)[number];

export function isWorkbenchRuntimeFailureCategory(
  value: unknown,
): value is WorkbenchRuntimeFailureCategory {
  return WORKBENCH_RUNTIME_FAILURE_CATEGORIES.some(category => category === value);
}

/** Parsed Runtime tool facts; the renderer localizes the type and fallback. */
export type WorkbenchToolActivityType =
  | "tool_use"
  | "commandExecution"
  | "fileChange"
  | "webSearch"
  | "unknown";

export interface WorkbenchChangedFileSummary {
  readonly path: string;
  readonly truncated: boolean;
  readonly lines?: {
    readonly additions: number;
    readonly deletions: number;
  };
}

export interface WorkbenchFileChangeSummary {
  readonly files: readonly WorkbenchChangedFileSummary[];
  readonly totalFiles: number;
  readonly truncated: boolean;
}

export interface WorkbenchToolActivity {
  readonly type: WorkbenchToolActivityType;
  readonly name: string;
  readonly parameter?: {
    readonly kind: "command" | "path";
    readonly value: string;
    readonly truncated: boolean;
  };
  readonly fileChanges?: WorkbenchFileChangeSummary;
  readonly sourceType?: string;
}

export type WorkbenchTimelineEvent =
  | { readonly kind: "user-message"; readonly text: string }
  | { readonly kind: "session-started" }
  | { readonly kind: "turn-started" }
  | { readonly kind: "item-started"; readonly itemType: "agent-message" }
  | { readonly kind: "item-completed"; readonly itemType: "agent-message" }
  | { readonly kind: "agent-message"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "progress";
      readonly activity: WorkbenchProgressActivity;
      readonly tool?: WorkbenchToolActivity;
    }
  | {
      readonly kind: "turn-completed";
      readonly status: "completed";
      readonly suggestions?: readonly string[];
    }
  | { readonly kind: "turn-interrupted"; readonly status: "interrupted" }
  | { readonly kind: "turn-paused"; readonly reason: "quota-exhausted" }
  | {
      readonly kind: "failed";
      /** Older renderer payloads have no reason; absence means unknown. */
      readonly category?: WorkbenchRuntimeFailureCategory;
    };

export interface WorkbenchSessionContextUsage {
  readonly usedTokens: number;
  readonly windowTokens: number | null;
}

export interface WorkbenchTurnView {
  /** This turn's outcome remains unknown even after later turns complete. */
  readonly recovery?: ProjectCommandRecovery;
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

/** Durable product status; never substitutes for a Runtime turn result. */
export type WorkbenchContinuationStop = import("../coordinator/session-continuation-plan.ts").SessionContinuationStop;

/** In-memory only: which step of a running plan is in flight. */
export type WorkbenchContinuationProgress = import("../coordinator/session-continuation-plan.ts").SessionContinuationProgress;

export interface WorkbenchCommandView {
  readonly key: string;
  readonly label: string;
  readonly runtime: string;
  readonly status: ProjectCommandStatus;
  readonly failureCategory?: ProjectCommandFailureCategory;
  /** Provider-reported reset instant while `status` is `quota-paused`; epoch milliseconds. */
  readonly quotaPauseResetsAt?: number;
  readonly continuationStop?: WorkbenchContinuationStop;
  /** Present only while this projected command owns the running turn. */
  readonly continuationProgress?: WorkbenchContinuationProgress;
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

export interface WorkbenchEmptyProjectRegistry {
  readonly ok: true;
  readonly empty: true;
}

export type WorkbenchHostedProjectResult =
  | { readonly ok: true; readonly view: WorkbenchHostedProjectView }
  | WorkbenchEmptyProjectRegistry
  | { readonly ok: false; readonly error: WorkbenchProjectFailure };

/** Main/preload wire only. Renderer listeners still receive complete public views. */
export type WorkbenchProjectTransfer =
  | { readonly kind: "snapshot"; readonly revision: number; readonly result: WorkbenchHostedProjectResult }
  | { readonly kind: "delta"; readonly revision: number; readonly baseRevision: number;
      readonly view: Omit<WorkbenchHostedProjectView, "commands"> & {
        readonly commands: readonly (Omit<WorkbenchCommandView, "session"> & {
          readonly session?: Omit<NonNullable<WorkbenchCommandView["session"]>, "timeline" | "turns"> & {
            readonly turns: readonly (WorkbenchTurnView | { readonly reuse: number })[];
          };
        })[];
      };
    };

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
  /**
   * Present only after confirming archive of a Session whose last turn outcome
   * was never established. It has the same one-literal meaning as deletion's
   * acknowledgement and never releases an active-turn barrier.
   */
  readonly acknowledgedUnknownOutcome?: true;
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

/**
 * The one refusal a chosen directory can earn on its own account, named.
 *
 * A drive root (`C:\`, `E:\`, a mapped `Z:\`, the root of a UNC share) is
 * refused deliberately: a Project is an agent's working directory, and a whole
 * volume is not a working directory anyone asked for. Before F-w187 the same
 * choice failed by accident -- `basename("C:\")` is empty, so label derivation
 * threw -- AFTER the ledger had been created and opened, and the reader got
 * "try again", which could not work. The refusal is now explicit, happens
 * before anything touches disk, and says what to choose instead.
 */
export const WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL =
  "A drive root cannot be a Project. Choose a folder inside the drive instead." as const;

export interface WorkbenchProjectSelectionFailure {
  readonly category:
    | "invalid-project-selection"
    | "project-unavailable"
    | "project-switch-unavailable"
    | "project-directory-is-drive-root";
  readonly message:
    | "Reload the Project list and choose an available Project."
    | "This Project is unavailable. Choose another Project or restore its directory."
    | "The Project could not be opened. Keep the current Project and try again."
    | typeof WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL;
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

export type WorkbenchProjectPathFailureReason =
  | "selected-file" | "directory-missing" | "destination-exists"
  | "parent-directory-missing" | "parent-is-file" | "parent-is-alias"
  | "parent-is-reparse" | "parent-unavailable" | "create-denied" | "unknown";

/** Only the chosen operation's in-memory result; never a persisted Project field. */
export interface WorkbenchProjectPathFailure {
  readonly reason: WorkbenchProjectPathFailureReason;
  readonly targetPath: string;
}

export type WorkbenchOpenProjectFailure =
  | {
      readonly failure?: WorkbenchProjectPathFailure;
      readonly category: "project-open-unavailable";
      readonly message: "Open Project could not be completed. Keep the current Project and try again.";
    }
  /** The chooser let the reader pick a drive root; see the selection failure. */
  | {
      readonly category: "project-directory-is-drive-root";
      readonly message: typeof WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL;
    };

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

export type WorkbenchCreateProjectResult =
  | { readonly outcome: "unavailable"; readonly failure?: WorkbenchProjectPathFailure }
  | { readonly outcome: Exclude<WorkbenchCreateProjectOutcome, "unavailable"> };

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
  | "claude-code-desktop"
  | "glm-coding-plan"
  | "kimi-code"
  | "deepseek-api"
  | "kimi-platform"
  | "claude-api"
  | "codex-api";

export type WorkbenchRuntimeEndpointDiscoveryCategory =
  | "catalog-ready"
  | "runtime-not-located"
  | "authentication-required"
  | "inspection-failed"
  | "not-inspected";

export interface WorkbenchRuntimeEndpointDiscoveryStatus {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly category: WorkbenchRuntimeEndpointDiscoveryCategory;
}

export interface WorkbenchRuntimeEndpointDiscovery {
  /** One status per registered endpoint, in registration order. */
  readonly statuses: readonly WorkbenchRuntimeEndpointDiscoveryStatus[];
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
    }>
  /**
   * The sign-in URL the running provider CLI printed.
   *
   * Answers the inspection the renderer already has in flight while a login
   * runs, so no new channel exists: that request used to resolve only when the
   * CLI exited, and it now resolves early -- once -- if a URL appears first.
   * The renderer re-inspects afterwards, so the run still ends on a real
   * inspected `authentication-state`.
   *
   * Emitted ONLY when the CLI actually printed a URL. There is no "waiting for
   * sign-in" variant and no placeholder: the product cannot see whether the
   * browser opened, and a state it cannot observe is one it must not claim.
   *
   * THE VALUE IS A CREDENTIAL. An OAuth authorisation URL generally carries a
   * single-use code. It crosses this boundary to be displayed and for no other
   * purpose: it is never logged, never written to the ledger or any other
   * durable store, and never captured into a fixture.
   */
  | Readonly<{
      kind: "authentication-sign-in-url";
      url: string;
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

/**
 * Endpoint ids that participate in subscription authentication, re-exported so
 * renderer modules keep contract.ts as their single shell-boundary import.
 */
export type { SubscriptionAuthenticationEndpointId };

/**
 * Subscription-authentication requests can only name endpoints that
 * participate in subscription authentication (OAuth logins). Static-key
 * endpoints such as `glm-coding-plan` never appear here — their
 * authentication state is presented through endpoint discovery instead.
 */
export interface WorkbenchSubscriptionAuthenticationRequest {
  readonly endpointId: SubscriptionAuthenticationEndpointId;
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

/**
 * API-transport endpoint key management (ADR 0022). Every static-key endpoint
 * (GLM Coding Plan, Kimi Code, DeepSeek API) shares this one parameterized
 * surface: the key lives in the identity-bound secret envelope store in the
 * main process; the renderer only ever sees names, masks and booleans unless
 * the user explicitly reveals the value. `environmentFallback` reports that
 * the endpoint's contract auth-token environment variable (for example
 * `GLM_ANTHROPIC_AUTH_TOKEN`) is present as the P2 fallback key source even
 * though the store itself holds no key.
 */
export interface WorkbenchEndpointKeySnapshot {
  readonly configured: boolean;
  /** `"••••"` plus at most the last four characters; `null` when unconfigured. */
  readonly maskedHint: string | null;
  readonly isPersistent: boolean;
  readonly environmentFallback: boolean;
}

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeySnapshot = WorkbenchEndpointKeySnapshot;

export type WorkbenchEndpointKeyFailureCategory =
  | "endpoint-key-unavailable"
  | "endpoint-key-invalid-value";

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeyFailureCategory =
  WorkbenchEndpointKeyFailureCategory;

export interface WorkbenchEndpointKeyFailure {
  readonly category: WorkbenchEndpointKeyFailureCategory;
  readonly message: string;
}

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeyFailure = WorkbenchEndpointKeyFailure;

export type WorkbenchEndpointKeyStatusResult =
  | {
      readonly ok: true;
      readonly status: "loaded";
      readonly snapshot: WorkbenchEndpointKeySnapshot;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointKeyFailure;
    };

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeyStatusResult =
  WorkbenchEndpointKeyStatusResult;

export type WorkbenchEndpointKeySaveResult =
  | {
      readonly ok: true;
      readonly status: "saved";
      readonly maskedHint: string;
      readonly isPersistent: boolean;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointKeyFailure;
    };

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeySaveResult = WorkbenchEndpointKeySaveResult;

export type WorkbenchEndpointKeyRemoveResult =
  | {
      readonly ok: true;
      readonly status: "removed";
      readonly snapshot: WorkbenchEndpointKeySnapshot;
    }
  | {
      readonly ok: true;
      readonly status: "not-configured";
      readonly snapshot: WorkbenchEndpointKeySnapshot;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointKeyFailure;
    };

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeyRemoveResult =
  WorkbenchEndpointKeyRemoveResult;

export type WorkbenchEndpointKeyRevealResult =
  | {
      readonly ok: true;
      readonly status: "revealed";
      readonly value: string;
      readonly snapshot: WorkbenchEndpointKeySnapshot;
    }
  | {
      readonly ok: true;
      readonly status: "not-configured";
      readonly snapshot: WorkbenchEndpointKeySnapshot;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointKeyFailure;
    };

/** Compatibility alias from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointKeyRevealResult =
  WorkbenchEndpointKeyRevealResult;

/**
 * Connectivity probe outcome. The probe is a minimal zero- or one-token
 * request (shape depends on the provider contract) that validates key +
 * endpoint reachability only — never model identity. Failures carry a coarse
 * reason — never the raw network error, response body, URL, or key material.
 */
export type WorkbenchEndpointProbeFailureReason =
  | "token-missing"
  | "invalid-base-url"
  | "unauthorized"
  | "endpoint-error"
  | "server-error"
  | "network"
  | "timeout";

export type WorkbenchEndpointProbeOutcome =
  | { readonly outcome: "success" }
  | {
      readonly outcome: "failure";
      readonly reason: WorkbenchEndpointProbeFailureReason;
    };

/** Compatibility aliases from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointProbeFailureReason =
  WorkbenchEndpointProbeFailureReason;
export type WorkbenchGlmEndpointProbeOutcome = WorkbenchEndpointProbeOutcome;

export type WorkbenchEndpointProbeResult =
  | {
      readonly ok: true;
      readonly status: "probed";
      readonly probe: WorkbenchEndpointProbeOutcome;
    }
  | {
      readonly ok: false;
      readonly error: WorkbenchEndpointKeyFailure;
    };

/**
 * Catalog freshness for the static-key endpoints (ticket 14 / WO16 Part 3).
 * The zero-inference /models pull runs at startup (silent) and on the
 * Settings manual refresh; every failure degrades silently to the static
 * catalog. Reports carry ids and optional display metadata only.
 */
export interface WorkbenchEndpointCatalogFreshnessModelEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: string;
}

/**
 * The endpoints enrolled in catalog freshness (the /models pull surface).
 * Deliberately narrower than the endpoint-key roster: only the static-key
 * endpoints with an enrolled zero-inference pull carry a freshness report
 * (kimi-platform/claude-api/codex-api are not enrolled yet — ticket 21
 * evidence notes the follow-up).
 */
export type WorkbenchEndpointCatalogFreshnessEndpointId =
  | "glm-coding-plan"
  | "kimi-code"
  | "deepseek-api";

export interface WorkbenchEndpointCatalogFreshnessReport {
  readonly endpointId: WorkbenchEndpointCatalogFreshnessEndpointId;
  /** "fresh" when the last pull succeeded (zero new models included). */
  readonly status: "fresh" | "silent-failure";
  readonly newModels: readonly WorkbenchEndpointCatalogFreshnessModelEntry[];
  readonly enrolledModels: readonly WorkbenchEndpointCatalogFreshnessModelEntry[];
}

export type WorkbenchEndpointCatalogFreshnessResult =
  | {
      readonly ok: true;
      readonly status: "loaded" | "refreshed";
      readonly reports: readonly WorkbenchEndpointCatalogFreshnessReport[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly category: "endpoint-catalog-freshness-unavailable";
        readonly message: string;
      };
    };

/** Compatibility aliases from the GLM-only era of this surface. */
export type WorkbenchGlmEndpointProbeResult = WorkbenchEndpointProbeResult;

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
      readonly message: "Session Profile default was durably saved.";
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

/** Ephemeral Runtime questions, separate from permission approval and turn history. */
export interface WorkbenchUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly text: string;
  readonly kind: "choice" | "free-text";
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly allowFreeText: boolean;
  readonly isSecret: boolean;
}

export type WorkbenchUserInputResolution =
  | "answered" | "cancelled" | "timed-out" | "runtime-resolved" | "session-ended";

export type WorkbenchUserInputView =
  | {
      readonly requestKey: string;
      readonly state: "pending";
      readonly questions: readonly WorkbenchUserInputQuestion[];
      readonly isBlocking: boolean;
      readonly expiresAt: number;
    }
  | { readonly requestKey: string; readonly state: WorkbenchUserInputResolution };

export type WorkbenchUserInputReadRequest = { readonly sessionKey: string };
export type WorkbenchUserInputResult =
  | { readonly ok: true; readonly requests: readonly WorkbenchUserInputView[] }
  | { readonly ok: false };
export type WorkbenchUserInputResponse =
  | { readonly kind: "cancel"; readonly requestKey: string }
  | {
      readonly kind: "answer";
      readonly requestKey: string;
      readonly answers: readonly { readonly questionId: string; readonly values: readonly string[] }[];
    };
export type WorkbenchUserInputResponseResult = {
  /** Answered confirms the reply was written, not that the turn completed. */
  readonly status: "answered" | "cancelled" | "invalid-answer" | "unavailable";
};

export const WORKBENCH_READ_USER_INPUT_CHANNEL = "workbench:read-user-input";
export const WORKBENCH_RESPOND_USER_INPUT_CHANNEL = "workbench:respond-user-input";
export const WORKBENCH_USER_INPUT_CHANGED_CHANNEL = "workbench:user-input-changed";

export interface WorkbenchUserInputBridge {
  /** Invalidation only; read the currently selected Session's ephemeral snapshot. */
  observeUserInput(listener: () => void): () => void;
  readUserInput(request: WorkbenchUserInputReadRequest): Promise<WorkbenchUserInputResult>;
  respondToUserInput(request: WorkbenchUserInputResponse): Promise<WorkbenchUserInputResponseResult>;
}

export interface WorkbenchRendererBridge
  extends Partial<HistoryRecoveryRendererBridge>,
    Partial<WorkbenchClipboardRendererBridge>,
    Partial<WorkbenchNotificationRendererBridge>,
    Partial<WorkbenchUserInputBridge> {
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
  loadBaseUrl?(
    endpointId: WorkbenchBaseUrlEndpointId,
  ): Promise<WorkbenchBaseUrlLoadResult>;
  saveBaseUrl?(
    endpointId: WorkbenchBaseUrlEndpointId,
    baseUrl: string,
  ): Promise<WorkbenchBaseUrlSaveResult>;
  loadEndpointPreferences?(): Promise<WorkbenchEndpointPreferenceLoadResult>;
  saveEndpointPreference?(
    preference: WorkbenchFamilyEndpointPreference,
  ): Promise<WorkbenchEndpointPreferenceSaveResult>;
  loadEndpointKeyStatus?(
    endpointId: WorkbenchEndpointKeyEndpointId,
  ): Promise<WorkbenchEndpointKeyStatusResult>;
  saveEndpointKey?(
    endpointId: WorkbenchEndpointKeyEndpointId,
    request: Readonly<{ keyValue: string }>,
  ): Promise<WorkbenchEndpointKeySaveResult>;
  removeEndpointKey?(
    endpointId: WorkbenchEndpointKeyEndpointId,
  ): Promise<WorkbenchEndpointKeyRemoveResult>;
  revealEndpointKey?(
    endpointId: WorkbenchEndpointKeyEndpointId,
  ): Promise<WorkbenchEndpointKeyRevealResult>;
  probeEndpointKey?(
    endpointId: WorkbenchEndpointKeyEndpointId,
  ): Promise<WorkbenchEndpointProbeResult>;
  loadEndpointCatalogFreshness?(): Promise<WorkbenchEndpointCatalogFreshnessResult>;
  refreshEndpointCatalogFreshness?(): Promise<WorkbenchEndpointCatalogFreshnessResult>;
  loadRuntimeExecutables(): Promise<WorkbenchRuntimeExecutablesLoadResult>;
  saveRuntimeExecutable(
    request: WorkbenchRuntimeExecutableSaveRequest,
  ): Promise<WorkbenchRuntimeExecutableSaveResult>;
  installRuntimeExecutable?(
    request: WorkbenchRuntimeInstallRequest,
  ): Promise<WorkbenchRuntimeInstallResult>;
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
  /** Read once and receive passive updates; never starts a provider request. */
  observeSubscriptionUsage?(listener: (result: WorkbenchSubscriptionUsageResult) => void): () => void;
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

export function publicBaseUrlLoaded(
  baseUrl: string,
): WorkbenchBaseUrlLoadResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    baseUrl,
  });
}

export function publicBaseUrlSaved(
  baseUrl: string,
): WorkbenchBaseUrlSaveResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    baseUrl,
  });
}

export function publicBaseUrlRejected(
  reason: WorkbenchBaseUrlRejection,
): Extract<WorkbenchBaseUrlSaveResult, { readonly ok: false }> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "base-url-rejected",
      message: "That base URL cannot be used.",
      reason,
    }),
  });
}

export function publicBaseUrlUnavailable(): Extract<
  WorkbenchBaseUrlLoadResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "base-url-unavailable",
      message:
        "The base URL could not be loaded or saved. Keep the current value and try again.",
    }),
  });
}

export function publicEndpointPreferencesLoaded(
  preferences: WorkbenchFamilyEndpointPreferences,
): WorkbenchEndpointPreferenceLoadResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    preferences,
  });
}

export function publicEndpointPreferenceSaved(): WorkbenchEndpointPreferenceSaveResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    message: "The endpoint preference was durably saved.",
  });
}

export function publicEndpointPreferenceUnavailable(): Extract<
  WorkbenchEndpointPreferenceLoadResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "endpoint-preference-unavailable",
      message:
        "The endpoint preference could not be loaded or saved. Keep the current choice and try again.",
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

export function publicRuntimeInstalled(
  runtime: WorkbenchConfigurableRuntime,
  version: string,
  executables: WorkbenchRuntimeExecutablePaths,
): WorkbenchRuntimeInstallResult {
  return Object.freeze({
    ok: true,
    status: "installed",
    runtime,
    version,
    executables: Object.freeze({
      codex: executables.codex,
      claude: executables.claude,
    }),
  });
}

export function publicRuntimeInstallFailed(
  step: WorkbenchRuntimeInstallStep,
  detail: string,
): Extract<WorkbenchRuntimeInstallResult, { readonly ok: false }> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "runtime-install-failed",
      message: "The private copy could not be installed.",
      step,
      detail,
    }),
  });
}

export function publicCreateProjectResult(outcome: "unavailable", failure: WorkbenchProjectPathFailure): WorkbenchCreateProjectResult;
export function publicCreateProjectResult(outcome: WorkbenchCreateProjectOutcome): WorkbenchCreateProjectResult;
export function publicCreateProjectResult(
  outcome: WorkbenchCreateProjectOutcome,
  failure?: WorkbenchProjectPathFailure,
): WorkbenchCreateProjectResult {
  if (outcome === "unavailable" && failure !== undefined) {
    return Object.freeze({ outcome, failure: publicProjectPathFailure(failure) });
  }
  return Object.freeze({ outcome });
}

function publicProjectPathFailure(failure: WorkbenchProjectPathFailure): WorkbenchProjectPathFailure {
  return Object.freeze({ reason: failure.reason, targetPath: failure.targetPath });
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

export function publicEmptyProjectRegistry(): WorkbenchEmptyProjectRegistry {
  return Object.freeze({ ok: true, empty: true });
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

export function publicProjectOpenUnavailable(failure?: WorkbenchProjectPathFailure): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-open-unavailable",
      ...(failure === undefined ? {} : { failure: publicProjectPathFailure(failure) }),
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    }),
  });
}

export function publicProjectDriveRootRefused(): WorkbenchProjectSelectionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-directory-is-drive-root",
      message: WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL,
    }),
  });
}

export function publicOpenProjectDriveRootRefused(): WorkbenchOpenProjectResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "project-directory-is-drive-root",
      message: WORKBENCH_PROJECT_DRIVE_ROOT_REFUSAL,
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
  statuses: readonly WorkbenchRuntimeEndpointDiscoveryStatus[],
): WorkbenchRuntimeEndpointDiscovery {
  return Object.freeze({
    statuses: Object.freeze(
      statuses.map((status) =>
        Object.freeze({
          endpointId: status.endpointId,
          category: status.category,
        }),
      ),
    ),
  });
}

/**
 * Discovery with the same category for every endpoint of the roster. The
 * roster defaults to the canonical registration order; a composition root or
 * test may pass its own.
 */
export function publicUniformRuntimeEndpointDiscovery(
  category: WorkbenchRuntimeEndpointDiscoveryCategory,
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
): WorkbenchRuntimeEndpointDiscovery {
  return publicRuntimeEndpointDiscovery(
    endpointIds.map((endpointId) => ({ endpointId, category })),
  );
}

/**
 * Discovery where one endpoint carries `category` and every other roster
 * endpoint is `not-inspected`.
 */
export function publicSingleInspectedRuntimeEndpointDiscovery(
  inspectedEndpointId: WorkbenchRuntimeEndpointId,
  category: WorkbenchRuntimeEndpointDiscoveryCategory,
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
): WorkbenchRuntimeEndpointDiscovery {
  return publicRuntimeEndpointDiscovery(
    endpointIds.map((endpointId) => ({
      endpointId,
      category:
        endpointId === inspectedEndpointId
          ? category
          : ("not-inspected" as const),
    })),
  );
}

export function publicProfileUnavailable(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery = publicUniformRuntimeEndpointDiscovery(
    "not-inspected",
  ),
): Extract<
  WorkbenchPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses,
    ),
    error: Object.freeze({
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
    }),
  });
}

export function publicRuntimeNotLocated(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery = publicUniformRuntimeEndpointDiscovery(
    "runtime-not-located",
  ),
): Extract<
  WorkbenchPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses,
    ),
    error: Object.freeze({
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
    }),
  });
}

export function publicContinuationProfileUnavailable(
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery = publicUniformRuntimeEndpointDiscovery(
    "not-inspected",
  ),
): Extract<
  WorkbenchAnyPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses,
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
  endpointDiscovery: WorkbenchRuntimeEndpointDiscovery = publicUniformRuntimeEndpointDiscovery(
    "not-inspected",
  ),
): Extract<
  WorkbenchAnyPublicDirectSessionProfileResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      endpointDiscovery.statuses,
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
    message: "Session Profile default was durably saved.",
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

/**
 * The one key-value shape accepted across the whole endpoint-key surface (every
 * provider): a non-empty, single-line, printable string within the length cap.
 * The renderer, the preload reconstruct and the main-process source all enforce
 * this same predicate, so a rejected value can never depend on which side
 * checked first.
 */
export function isValidWorkbenchEndpointKeyValue(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WORKBENCH_ENDPOINT_KEY_MAX_LENGTH &&
    value.trim().length === value.length &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

/** Compatibility alias from the GLM-only era of this surface. */
export const isValidWorkbenchGlmEndpointKeyValue =
  isValidWorkbenchEndpointKeyValue;

export function publicEndpointKeyStatusLoaded(
  snapshot: WorkbenchEndpointKeySnapshot,
): WorkbenchEndpointKeyStatusResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    snapshot: freezeEndpointKeySnapshot(snapshot),
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeyStatusLoaded = publicEndpointKeyStatusLoaded;

function freezeEndpointKeySnapshot(
  snapshot: WorkbenchEndpointKeySnapshot,
): WorkbenchEndpointKeySnapshot {
  return Object.freeze({
    configured: snapshot.configured,
    maskedHint: snapshot.maskedHint,
    isPersistent: snapshot.isPersistent,
    environmentFallback: snapshot.environmentFallback,
  });
}

export function publicEndpointKeySaved(
  maskedHint: string,
  isPersistent: boolean,
): WorkbenchEndpointKeySaveResult {
  return Object.freeze({
    ok: true,
    status: "saved",
    maskedHint,
    isPersistent,
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeySaved = publicEndpointKeySaved;

export function publicEndpointKeyRemoved(
  snapshot: WorkbenchEndpointKeySnapshot,
): WorkbenchEndpointKeyRemoveResult {
  return Object.freeze({
    ok: true,
    status: "removed",
    snapshot: freezeEndpointKeySnapshot(snapshot),
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeyRemoved = publicEndpointKeyRemoved;

export function publicEndpointKeyNotConfigured(
  snapshot: WorkbenchEndpointKeySnapshot,
): {
  readonly ok: true;
  readonly status: "not-configured";
  readonly snapshot: WorkbenchEndpointKeySnapshot;
} {
  return Object.freeze({
    ok: true,
    status: "not-configured",
    snapshot: freezeEndpointKeySnapshot(snapshot),
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeyNotConfigured =
  publicEndpointKeyNotConfigured;

export function publicEndpointKeyRevealed(
  value: string,
  snapshot: WorkbenchEndpointKeySnapshot,
): WorkbenchEndpointKeyRevealResult {
  return Object.freeze({
    ok: true,
    status: "revealed",
    value,
    snapshot: freezeEndpointKeySnapshot(snapshot),
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeyRevealed = publicEndpointKeyRevealed;

export function publicEndpointProbed(
  probe: WorkbenchEndpointProbeOutcome,
): WorkbenchEndpointProbeResult {
  return Object.freeze(
    probe.outcome === "success"
      ? {
          ok: true,
          status: "probed",
          probe: Object.freeze({ outcome: "success" }),
        }
      : {
          ok: true,
          status: "probed",
          probe: Object.freeze({
            outcome: "failure",
            reason: probe.reason,
          }),
        },
  );
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointProbed = publicEndpointProbed;

export function publicEndpointKeyUnavailable(): Extract<
  | WorkbenchEndpointKeyStatusResult
  | WorkbenchEndpointKeySaveResult
  | WorkbenchEndpointKeyRemoveResult
  | WorkbenchEndpointKeyRevealResult
  | WorkbenchEndpointProbeResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "endpoint-key-unavailable",
      message:
        "Endpoint key management is unavailable. Keep the current key and try again.",
    }),
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeyUnavailable = publicEndpointKeyUnavailable;

export function publicEndpointKeyInvalidValue(): Extract<
  WorkbenchEndpointKeySaveResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "endpoint-key-invalid-value",
      message:
        "Enter a non-empty API key of at most 4,096 characters with no line breaks or control characters.",
    }),
  });
}

/** Compatibility alias from the GLM-only era of this surface. */
export const publicGlmEndpointKeyInvalidValue = publicEndpointKeyInvalidValue;

export function publicEndpointCatalogFreshnessLoaded(
  reports: readonly WorkbenchEndpointCatalogFreshnessReport[],
): WorkbenchEndpointCatalogFreshnessResult {
  return Object.freeze({
    ok: true,
    status: "loaded",
    reports: Object.freeze(reports.map(freezeFreshnessReport)),
  });
}

export function publicEndpointCatalogFreshnessRefreshed(
  reports: readonly WorkbenchEndpointCatalogFreshnessReport[],
): WorkbenchEndpointCatalogFreshnessResult {
  return Object.freeze({
    ok: true,
    status: "refreshed",
    reports: Object.freeze(reports.map(freezeFreshnessReport)),
  });
}

export function publicEndpointCatalogFreshnessUnavailable(): Extract<
  WorkbenchEndpointCatalogFreshnessResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "endpoint-catalog-freshness-unavailable",
      message:
        "Catalog freshness is unavailable in this window. The provider catalogs stay as they are.",
    }),
  });
}

function freezeFreshnessReport(
  report: WorkbenchEndpointCatalogFreshnessReport,
): WorkbenchEndpointCatalogFreshnessReport {
  return Object.freeze({
    endpointId: report.endpointId,
    status: report.status,
    newModels: Object.freeze(report.newModels.map(freezeFreshnessEntry)),
    enrolledModels: Object.freeze(report.enrolledModels.map(freezeFreshnessEntry)),
  });
}

function freezeFreshnessEntry(
  entry: WorkbenchEndpointCatalogFreshnessModelEntry,
): WorkbenchEndpointCatalogFreshnessModelEntry {
  return Object.freeze({
    id: entry.id,
    ...(entry.displayName === undefined
      ? {}
      : { displayName: entry.displayName }),
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
  });
}

/**
 * Public contract for the CLI update surface (ticket 18; design fixed in
 * ticket 15 and the spike evidence `evidence/cli-update-spike.md`;
 * incorporated into contract.ts by ticket 21's cleanup package — the former
 * self-contained `cli-update-contract.ts` is now a re-export shim so the
 * settings renderer import path stays stable).
 *
 * Like the history-recovery contract, this surface is consumed by both sides
 * of the preload boundary, so it declares channels, sanitized-by-construction
 * result types, and public constructors — never raw command output. Everything a
 * renderer can learn about a check or an update run is one of the coarse
 * enum states below plus validated version strings; winget/CLI stdout,
 * stderr, spawn errors and file paths never cross this boundary.
 *
 * Rulings baked into the shapes (副主管裁决, ticket 18):
 * - claude: check = read-only `winget list --id Anthropic.ClaudeCode`
 *   (versions/available columns); "check-failed" carries no version claim.
 *   Settings explains the failure and offers a read-only retry (issue 184).
 * - codex: no read-only check exists (spike §3), so "no-check" is a
 *   first-class state, not an error.
 * - Updates never run automatically; `run` exists only behind the
 *   Settings button.
 * - Ticket 21 cleanup: the restart reminder gains a real action —
 *   `relaunchApp` (new IPC `workbench:relaunch-app`) queues an
 *   `app.relaunch()` + exit in the owning main process. The renderer button
 *   wiring is deputy/renderer-ticket territory (see the wiring note in
 *   `evidence/charter-completion.md`).
 */

export const WORKBENCH_CHECK_CLI_UPDATES_CHANNEL = "workbench:check-cli-updates";
export const WORKBENCH_RUN_CLI_UPDATE_CHANNEL = "workbench:run-cli-update";
export const WORKBENCH_RELAUNCH_APP_CHANNEL = "workbench:relaunch-app";

export type WorkbenchCliUpdateCliId = "claude-code" | "codex";

export const WORKBENCH_CLI_UPDATE_CLI_IDS: readonly WorkbenchCliUpdateCliId[] =
  Object.freeze(["claude-code", "codex"]);

/**
 * One CLI's check outcome. `update-available` carries validated version
 * tokens only; `check-failed` is a retryable failure (claude could not
 * be queried); `no-check` is codex's honest capability state.
 */
export type WorkbenchCliUpdateCheckReport =
  | {
      readonly cliId: "claude-code";
      readonly status: "update-available";
      readonly currentVersion: string;
      readonly availableVersion: string;
    }
  | { readonly cliId: "claude-code"; readonly status: "up-to-date" }
  | { readonly cliId: "claude-code"; readonly status: "check-failed" }
  | { readonly cliId: "codex"; readonly status: "no-check" };

export type WorkbenchCliUpdateCheckResult =
  | {
      readonly ok: true;
      readonly status: "checked";
      readonly reports: readonly WorkbenchCliUpdateCheckReport[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly category: "cli-update-check-unavailable";
        readonly message: string;
      };
    };

/**
 * Coarse failure reasons for an update run. An unclassified non-zero exit
 * surfaces as "update-failed" without inventing a cause; no raw error text
 * ever crosses.
 *
 * All three update paths read the version before and after an updater.
 * Winget-managed `claude` compares the installed versions from `winget`;
 * Codex and non-winget Claude rediscover the runtime's full launch plan and
 * run it with `--version`, retaining shim prefix arguments. A changed version
 * is "updated"; an unchanged version after a zero exit is "no-change"; an
 * unreadable required readback after a zero exit is "result-unknown".
 */
export type WorkbenchCliUpdateRunFailureReason =
  | "timeout"
  | "launch-failed"
  | "update-failed"
  | "unsupported-install"
  | "no-change"
  | "result-unknown";

export type WorkbenchCliUpdateRunResult =
  | {
      readonly ok: true;
      readonly status: "updated";
      readonly cliId: WorkbenchCliUpdateCliId;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly category: "cli-update-run-unavailable";
        readonly message: string;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly category: "cli-update-run-failed";
        readonly reason: WorkbenchCliUpdateRunFailureReason;
        readonly message: string;
      };
    };

/**
 * The immediate-restart action (ticket 21 cleanup item 2). `queued` is the
 * terminal truth: the main process has scheduled the relaunch and the old
 * window is going away — there is deliberately no completion callback, so
 * the renderer must treat this result as its last act on the current
 * process.
 */
export type WorkbenchCliUpdateRelaunchResult =
  | { readonly ok: true; readonly status: "queued" }
  | {
      readonly ok: false;
      readonly error: {
        readonly category: "relaunch-unavailable";
        readonly message: string;
      };
    };

/**
 * The renderer-facing bridge slice for this surface. The preload bridge
 * implements it; the Settings CLI-update block narrows the renderer bridge
 * to it.
 */
export interface WorkbenchCliUpdateBridge {
  checkCliUpdates(): Promise<WorkbenchCliUpdateCheckResult>;
  runCliUpdate(
    cliId: WorkbenchCliUpdateCliId,
  ): Promise<WorkbenchCliUpdateRunResult>;
  relaunchApp(): Promise<WorkbenchCliUpdateRelaunchResult>;
}

const CHECK_UNAVAILABLE_MESSAGE =
  "CLI update checks are unavailable in this window. Nothing was checked.";
const RUN_UNAVAILABLE_MESSAGE =
  "CLI updates are unavailable in this window. Nothing was changed.";
const RELAUNCH_UNAVAILABLE_MESSAGE =
  "Restarting is unavailable in this window. The update stays installed.";
const RUN_FAILED_MESSAGES: Readonly<
  Record<WorkbenchCliUpdateRunFailureReason, string>
> = Object.freeze({
  timeout: "The update command did not finish in time. Nothing was changed.",
  "launch-failed":
    "The update command could not be started. Nothing was changed.",
  "update-failed":
    "The update command reported a failure. Nothing was changed.",
  "no-change":
    "The updater finished without an error but the installed version did not change. Nothing was updated.",
  "unsupported-install":
    "This CLI install is managed by its own channel (for example the desktop app it came with) and declines in-place updates. Nothing was changed.",
  "result-unknown":
    "The update command finished, but the installed version could not be verified. Check again before restarting.",
});

export function publicCliUpdateCheckCompleted(
  reports: readonly WorkbenchCliUpdateCheckReport[],
): WorkbenchCliUpdateCheckResult {
  return Object.freeze({
    ok: true,
    status: "checked",
    reports: Object.freeze(reports.map(freezeCheckReport)),
  });
}

export function publicCliUpdateCheckUnavailable(): Extract<
  WorkbenchCliUpdateCheckResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "cli-update-check-unavailable",
      message: CHECK_UNAVAILABLE_MESSAGE,
    }),
  });
}

export function publicCliUpdateRunUpdated(
  cliId: WorkbenchCliUpdateCliId,
): WorkbenchCliUpdateRunResult {
  return Object.freeze({ ok: true, status: "updated", cliId });
}

export function publicCliUpdateRunFailed(
  reason: WorkbenchCliUpdateRunFailureReason,
): Extract<WorkbenchCliUpdateRunResult, { readonly ok: false }> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "cli-update-run-failed",
      reason,
      message: RUN_FAILED_MESSAGES[reason],
    }),
  });
}

export function publicCliUpdateRunUnavailable(): Extract<
  WorkbenchCliUpdateRunResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "cli-update-run-unavailable",
      message: RUN_UNAVAILABLE_MESSAGE,
    }),
  });
}

export function publicCliUpdateRelaunchQueued(): WorkbenchCliUpdateRelaunchResult {
  return Object.freeze({ ok: true, status: "queued" });
}

export function publicCliUpdateRelaunchUnavailable(): Extract<
  WorkbenchCliUpdateRelaunchResult,
  { readonly ok: false }
> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      category: "relaunch-unavailable",
      message: RELAUNCH_UNAVAILABLE_MESSAGE,
    }),
  });
}

function freezeCheckReport(
  report: WorkbenchCliUpdateCheckReport,
): WorkbenchCliUpdateCheckReport {
  switch (report.status) {
    case "update-available":
      return Object.freeze({
        cliId: "claude-code" as const,
        status: "update-available" as const,
        currentVersion: report.currentVersion,
        availableVersion: report.availableVersion,
      });
    case "up-to-date":
      return Object.freeze({
        cliId: "claude-code" as const,
        status: "up-to-date" as const,
      });
    case "check-failed":
      return Object.freeze({
        cliId: "claude-code" as const,
        status: "check-failed" as const,
      });
    default:
      return Object.freeze({
        cliId: "codex" as const,
        status: "no-check" as const,
      });
  }
}
