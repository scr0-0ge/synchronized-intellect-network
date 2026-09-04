export interface RuntimeWorkIntensityVariant {
  /** Runtime-owned selectable wording; it is not a native effort value. */
  readonly value: string;
  readonly label: string;
  /** The ordinary effort value the Runtime actually sends to the model. */
  readonly nativeEffortLevel: string;
  /** Existing selectable execution mode whose UI identity remains unchanged. */
  readonly baseExecutionMode: string;
  /** Private workflow/session mode implied by selecting this variant. */
  readonly executionMode: string;
}

export interface RuntimeModel {
  readonly id: string;
  /** Runtime-resolved model identity, when the Runtime reports one safely. */
  readonly resolvedModel?: string;
  /** Runtime-owned model wording. When absent, callers carry `id` verbatim. */
  readonly displayName?: string;
  readonly effortLevels: readonly string[];
  /**
   * Runtime-owned wording positionally paired with `effortLevels`. A null
   * entry means the Runtime supplied no separate wording for that value.
   */
  readonly effortLevelLabels?: readonly (string | null)[];
  /** Runtime/model-owned label for the intensity control, when supplied. */
  readonly workIntensityLabel?: string;
  /**
   * Runtime-declared work-intensity choices that couple an ordinary effort to
   * a private workflow mode. Composition consumes this metadata before the
   * public catalog seam; callers must never treat `value` as a native effort.
   */
  readonly workIntensityVariants?: readonly RuntimeWorkIntensityVariant[];
}

export interface RuntimeCatalog {
  readonly runtime: string;
  readonly models: readonly RuntimeModel[];
  readonly executionModes: readonly string[];
  readonly accessModes: readonly string[];
}

export interface SessionProfile {
  readonly model: string;
  readonly effortLevel: string;
  readonly executionMode: string;
  readonly accessMode: string;
}

export interface RuntimeStart {
  readonly projectDirectory: string;
  readonly profile: SessionProfile;
}

export interface RuntimeResume {
  readonly projectDirectory: string;
  readonly profile: SessionProfile;
  readonly opaqueSessionReference: string;
}

export interface RuntimeContinuationProfileCompatibilityRequest {
  readonly projectDirectory: string;
  readonly currentProfile: SessionProfile;
  readonly requestedProfile: SessionProfile;
}

export type RuntimeContinuationProfileCompatibility =
  | "compatible"
  | "incompatible";

export interface RuntimeInput {
  readonly text: string;
}

export type RuntimeFailureCategory =
  | "approval-required"
  | "authentication-required"
  | "catalog-invalid"
  | "correlation-invalid"
  | "invalid-input"
  | "protocol-invalid"
  | "protocol-rejected"
  | "runtime-shutdown"
  | "runtime-not-located"
  | "runtime-unavailable"
  | "temp-cleanup"
  | "temp-cleanup-guard"
  | "transport-failed"
  | "turn-failed"
  | "unexpected-server-request"
  | "unsupported-selection";

/** Exact semantics: resident context has a window; per-turn usage never does. */
export type RuntimeContextUsage =
  | {
      readonly basis: "active-context";
      readonly usedTokens: number;
      readonly windowTokens: number;
    }
  | {
      readonly basis: "turn-usage";
      readonly usedTokens: number;
      readonly windowTokens: null;
    };

export type NormalizedRuntimeEvent =
  | { readonly kind: "session-started" }
  | { readonly kind: "turn-started" }
  | { readonly kind: "item-started"; readonly itemType: "agent-message" }
  | { readonly kind: "item-completed"; readonly itemType: "agent-message" }
  | { readonly kind: "agent-message"; readonly text: string }
  | {
      readonly kind: "turn-completed";
      readonly status: "completed";
      readonly context?: RuntimeContextUsage;
    }
  | { readonly kind: "turn-interrupted"; readonly status: "interrupted" }
  | { readonly kind: "failed"; readonly category: RuntimeFailureCategory };

export type RuntimeInterruptAvailability =
  | "available"
  | "unsupported"
  | "unavailable";

export type RuntimeSteerAvailability =
  | "available"
  | "unsupported"
  | "unavailable";

export interface RuntimeBinding {
  /** The runtime-confirmed selection; its four fields remain independent. */
  readonly profile: SessionProfile;
  /** This bounded vertical slice accepts exactly one input. */
  send(input: RuntimeInput): Promise<void>;
  /** Present only when the selected Runtime exposes live steering. */
  steer?(input: RuntimeInput): Promise<void>;
  /** Current same-turn steering truth; absence means the Runtime has no such contract. */
  steerAvailability?(): RuntimeSteerAvailability;
  /** Present only when the selected Runtime exposes live interruption. */
  interrupt?(): Promise<void>;
  /** Current binding truth; `available` is the only state that authorizes a call. */
  interruptAvailability?(): RuntimeInterruptAvailability;
  /** Undefined until the Runtime has reported all effective profile fields. */
  effectiveProfile?(): SessionProfile | undefined;
  /**
   * Consume exactly once through a terminal event. The Adapter stops its runtime
   * on completion, failure, or early iterator abandonment.
   */
  events(): AsyncIterable<NormalizedRuntimeEvent>;
}

export interface ResumableRuntimeBinding extends RuntimeBinding {
  /** Runtime-native Session identity retained as one opaque backend capability. */
  readonly opaqueSessionReference: string;
}

export interface SteerableRuntimeBinding extends ResumableRuntimeBinding {
  steer(input: RuntimeInput): Promise<void>;
  steerAvailability(): RuntimeSteerAvailability;
  effectiveProfile(): SessionProfile | undefined;
}

export interface InterruptibleRuntimeBinding extends ResumableRuntimeBinding {
  interrupt(): Promise<void>;
  interruptAvailability(): RuntimeInterruptAvailability;
  effectiveProfile(): SessionProfile | undefined;
}

export interface ControllableRuntimeBinding extends ResumableRuntimeBinding {
  steer(input: RuntimeInput): Promise<void>;
  steerAvailability(): RuntimeSteerAvailability;
  interrupt(): Promise<void>;
  interruptAvailability(): RuntimeInterruptAvailability;
  effectiveProfile(): SessionProfile | undefined;
}

export interface AgentRuntimeAdapter {
  inspect(projectDirectory: string): Promise<RuntimeCatalog>;
  start(request: RuntimeStart): Promise<RuntimeBinding>;
}

export interface ResumableAgentRuntimeAdapter extends AgentRuntimeAdapter {
  start(request: RuntimeStart): Promise<ResumableRuntimeBinding>;
  resume(request: RuntimeResume): Promise<ResumableRuntimeBinding>;
  /**
   * A multi-endpoint Adapter proves that two opaque selections resolve to the
   * same Runtime Endpoint before a continuation is durably accepted. A
   * single-endpoint Adapter may omit this capability.
   */
  continuationProfileCompatibility?(
    request: RuntimeContinuationProfileCompatibilityRequest,
  ):
    | RuntimeContinuationProfileCompatibility
    | Promise<RuntimeContinuationProfileCompatibility>;
}

export class RuntimeAdapterError extends Error {
  readonly category: RuntimeFailureCategory;

  constructor(category: RuntimeFailureCategory) {
    super("Agent Runtime operation failed.");
    this.name = "RuntimeAdapterError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}
