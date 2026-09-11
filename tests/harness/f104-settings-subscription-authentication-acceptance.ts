import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export const F104_PROVIDER_CASES = Object.freeze([
  Object.freeze({
    provider: "codex" as const,
    label: "Codex" as const,
    endpointSelectionKey: "endpoint-selection-01",
  }),
  Object.freeze({
    provider: "claude" as const,
    label: "Claude" as const,
    endpointSelectionKey: "endpoint-selection-02",
  }),
]);

export const F104_COPY = Object.freeze({
  // Narrowed per ADR 0022 (§0 conflict two); mirrors
  // WORKBENCH_SUBSCRIPTION_AUTHENTICATION_COPY and settings-copy.ts.
  credentialHeading: "Subscription credentials never pass through the Workbench",
  credentialSentence:
    "Subscription sign-in happens in each provider's own app. This page never asks for a subscription password or token, never reads a subscription credential file, and never stores subscription credentials. The one exception is disclosed in the GLM Coding Plan API key section below.",
  boundAction: "Log out",
  signedOutAction: "Login",
  consequence:
    "Recorded conversations stay in the Workbench. Resumable Sessions for this provider will no longer be resumable when this authentication action begins.",
  confirmLogout: "Ask the provider CLI to log out",
  cancel: "Cancel",
  logoutRequested: "The Workbench asked the provider CLI to log out.",
  logoutNotRequested:
    "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
  logoutPartiallyCompleted:
    "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
  logoutBlocked: "Log out is blocked.",
});

export const F104_SETTINGS_SELECTORS = Object.freeze({
  settingsRoot: ".settings",
  providerRegion: "section.provider-settings",
  providerCard: "section.provider",
  providerName: ":scope > .provider-head .ph-name",
  providerActions: ":scope > .provider-actions",
  subscriptionStatus:
    ':scope > .provider-actions .provider-binding-status[role="status"]',
});

export const F104_FORBIDDEN_PUBLIC_FIELDS = Object.freeze([
  "executable",
  "arguments",
  "args",
  "argumentList",
  "environment",
  "env",
  "workingDirectory",
  "cwd",
  "commandLine",
  "path",
  "url",
  "URL",
  "stdout",
  "stderr",
  "exitCode",
  "signal",
  "error",
  "rawError",
  "nativeError",
  "endpointId",
  "providerId",
  "sessionId",
  "threadId",
  "nativeEndpointId",
  "nativeEndpointIdentity",
  "nativeSessionId",
  "nativeSessionIdentity",
  "nativeThreadId",
  "nativeIdentity",
  "nativePayload",
  "providerRequest",
  "providerResponse",
  "providerPayload",
  "providerPrivateRequest",
  "providerPrivateResponse",
  "generation",
  "previousGeneration",
  "currentGeneration",
  "generationMatches",
  "account",
  "accountName",
  "accountLabel",
  "accountEmail",
  "accountIdentifier",
  "email",
  "username",
  "accountId",
  "organization",
  "plan",
  "profile",
  "identity",
  "identityHash",
  "accountFingerprint",
  "sameAccount",
  "differentAccount",
  "accountChanged",
  "password",
  "apiKey",
  "oauthToken",
  "oauthAccessToken",
  "oauthRefreshToken",
  "accessToken",
  "refreshToken",
  "apiToken",
  "token",
  "credential",
  "credentialDocument",
  "credentialFile",
  "credentialPath",
  "credentialFileLocation",
  "credentialIndicator",
  "derivedSecretIndicator",
  "secretIndicator",
] as const);

export const F104_BLOCKER_LABELS = Object.freeze({
  accepted: "Accepted",
  starting: "Starting",
  inFlight: "Running",
  recoveryRequired: "Recovery required",
  unknown: "Unknown",
});

export type F104Provider = "codex" | "claude";
export type F104ProviderLabel = "Codex" | "Claude";
export type F104AuthenticationState =
  | "bound"
  | "sign-in-required"
  | "unknown";
export type F104AuthenticationAction = "login" | "logout";
export type F104CatalogLabel =
  | "Catalog available"
  | "Catalog unavailable"
  | "Not checked";

export type F104PublicRequest =
  | Readonly<{ endpointSelectionKey: string }>
  | Readonly<{
      endpointSelectionKey: string;
      action: F104AuthenticationAction;
    }>
  | Readonly<{ preparationKey: string }>;

export type F104BlockerCounts = Readonly<{
  accepted: number;
  starting: number;
  inFlight: number;
  recoveryRequired: number;
  unknown: number;
}>;

export type F104PublicResponse =
  | Readonly<{
      kind: "authentication-state";
      state: F104AuthenticationState;
    }>
  | Readonly<{
      kind: "blocked";
      blockers: F104BlockerCounts;
    }>
  | Readonly<{
      kind: "confirmation-required";
      preparationKey: string;
      consequences: Readonly<{
        resumableSessionCount: number;
        projectCount: number;
      }>;
    }>
  | Readonly<{
      kind: "ready";
      preparationKey: string;
    }>
  | Readonly<{
      kind: "authentication-action-requested";
      action: F104AuthenticationAction;
    }>
  | Readonly<{
      kind: "authentication-action-not-requested";
      action: F104AuthenticationAction;
    }>
  | Readonly<{
      kind: "authentication-action-partially-completed";
      action: F104AuthenticationAction;
    }>
  // Mirrors the product union: the sign-in URL a running login printed.
  | Readonly<{
      kind: "authentication-sign-in-url";
      url: string;
    }>;

export type F104BoundaryResult<Value> =
  | Readonly<{ accepted: true; value: Value }>
  | Readonly<{ accepted: false }>;

export type F104InvalidConsumedFixture = Readonly<{
  category:
    | "missing"
    | "wrong-type"
    | "unknown-literal"
    | "contradictory";
  value: unknown;
}>;

export type F104ProviderFixture = Readonly<{
  recognizedBound: unknown;
  recognizedSignInRequired: unknown;
  consumedTopLevelKeys: readonly string[];
  invalidConsumed: readonly F104InvalidConsumedFixture[];
}>;

export type F104NativeStatusEntry =
  | Readonly<{ kind: "value"; value: unknown }>
  | Readonly<{ kind: "failure" }>
  | Readonly<{ kind: "pending"; deferred: ControlledDeferred<unknown> }>;

export class ControlledDeferred<Value> {
  readonly promise: Promise<Value>;
  private settle!: (value: Value) => void;

  constructor() {
    this.promise = new Promise<Value>((resolve) => {
      this.settle = resolve;
    });
  }

  resolve(value: Value): void {
    this.settle(value);
  }
}

export class ControlledEventLog {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }
}

export class ControlledScheduler {
  private nextHandle = 0;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    this.nextHandle += 1;
    this.callbacks.set(this.nextHandle, callback);
    return this.nextHandle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.callbacks.delete(handle);
  }

  fireNext(): void {
    const entry = this.callbacks.entries().next().value as
      | readonly [number, () => void]
      | undefined;
    assert.notEqual(entry, undefined, "controlled-timeout-missing");
    if (entry === undefined) return;
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

export class ControlledNativeChild {
  readonly finished: Promise<void>;
  private finish!: () => void;
  private settled = false;
  private recordedExitCode: number | null = null;

  constructor() {
    this.finished = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  exit(exitCode: number): void {
    if (this.settled) return;
    this.settled = true;
    this.recordedExitCode = exitCode;
    this.finish();
  }

  exitCode(): number | null {
    return this.recordedExitCode;
  }
}

export class ControlledNativeProviderTransport {
  readonly provider: F104Provider;
  readonly statusReads: number[] = [];
  readonly officialActionRequests: F104AuthenticationAction[] = [];
  readonly children: ControlledNativeChild[] = [];
  private readonly statuses: F104NativeStatusEntry[] = [];
  private launchFailure = false;

  private readonly events: ControlledEventLog;

  constructor(provider: F104Provider, events: ControlledEventLog) {
    this.provider = provider;
    this.events = events;
  }

  queueStatus(value: unknown): void {
    this.statuses.push(Object.freeze({ kind: "value", value }));
  }

  queueStatusFailure(): void {
    this.statuses.push(Object.freeze({ kind: "failure" }));
  }

  queuePendingStatus(): ControlledDeferred<unknown> {
    const deferred = new ControlledDeferred<unknown>();
    this.statuses.push(Object.freeze({ kind: "pending", deferred }));
    return deferred;
  }

  failNextLaunch(): void {
    this.launchFailure = true;
  }

  async readStatus(_signal: AbortSignal): Promise<unknown> {
    this.statusReads.push(this.statusReads.length + 1);
    this.events.record(`native-status:${this.provider}`);
    const next = this.statuses.shift();
    if (next === undefined || next.kind === "failure") {
      throw new Error("controlled-native-status-failure");
    }
    if (next.kind === "pending") return next.deferred.promise;
    return next.value;
  }

  async requestOfficialAction(
    action: F104AuthenticationAction,
    _signal: AbortSignal,
  ): Promise<ControlledNativeChild> {
    this.events.record(`official-action:${this.provider}:${action}`);
    if (this.launchFailure) {
      this.launchFailure = false;
      throw new Error("controlled-official-action-launch-failure");
    }
    this.officialActionRequests.push(action);
    const child = new ControlledNativeChild();
    this.children.push(child);
    return child;
  }
}

export interface F104ProviderAdapter {
  readonly provider: F104Provider;
  inspectAuthentication(): Promise<F104AuthenticationState>;
  launchOfficialAction(
    action: F104AuthenticationAction,
  ): Promise<ControlledNativeChild>;
}

export type F104SessionActivity =
  | "accepted"
  | "starting"
  | "in-flight"
  | "recovery-required"
  | "terminal"
  | "unknown";

export type F104EndpointMembership = string | "unknown";

export type F104GuardSession = Readonly<{
  sessionKey: string;
  endpointMembership: F104EndpointMembership;
  activity: F104SessionActivity;
  nativeResumable: boolean;
}>;

export type F104RegisteredProject = Readonly<{
  projectKey: string;
  selected: boolean;
  sessions: readonly F104GuardSession[];
}>;

export type F104RegistrySnapshot = Readonly<{
  revision: number;
  projects: readonly F104RegisteredProject[];
}>;

export class ControlledProjectRegistry {
  private revision = 1;
  private projects: readonly F104RegisteredProject[] = Object.freeze([]);
  private unreadable = false;
  readonly reads: number[] = [];

  replace(projects: readonly F104RegisteredProject[]): void {
    this.revision += 1;
    this.projects = freezeProjects(projects);
  }

  makeUnreadable(): void {
    this.revision += 1;
    this.unreadable = true;
  }

  makeReadable(): void {
    this.revision += 1;
    this.unreadable = false;
  }

  async readAll(): Promise<F104RegistrySnapshot> {
    this.reads.push(this.revision);
    if (this.unreadable) throw new Error("controlled-registry-unreadable");
    return Object.freeze({
      revision: this.revision,
      projects: freezeProjects(this.projects),
    });
  }
}

export type F104EndpointGenerationRecord =
  | Readonly<{ classification: "pristine-legacy" }>
  | Readonly<{ classification: "managed"; generation: string }>
  | Readonly<{ classification: "malformed" }>
  | Readonly<{ classification: "unreadable" }>;

export class ControlledGenerationStore {
  readonly commits: Array<
    Readonly<{
      endpointSelectionKey: string;
      generation: string;
    }>
  > = [];
  private readonly records = new Map<string, F104EndpointGenerationRecord>();
  private shouldFailCommit = false;
  private readonly events: ControlledEventLog;

  constructor(events: ControlledEventLog) {
    this.events = events;
  }

  set(
    endpointSelectionKey: string,
    record: F104EndpointGenerationRecord,
  ): void {
    this.records.set(endpointSelectionKey, Object.freeze({ ...record }));
  }

  read(endpointSelectionKey: string): F104EndpointGenerationRecord {
    return (
      this.records.get(endpointSelectionKey) ??
      Object.freeze({ classification: "pristine-legacy" as const })
    );
  }

  failNextCommit(): void {
    this.shouldFailCommit = true;
  }

  async commitManaged(
    endpointSelectionKey: string,
    generation: string,
  ): Promise<void> {
    this.events.record(`generation-commit:${endpointSelectionKey}`);
    if (this.shouldFailCommit) {
      this.shouldFailCommit = false;
      throw new Error("controlled-generation-commit-failure");
    }
    this.records.set(
      endpointSelectionKey,
      Object.freeze({ classification: "managed", generation }),
    );
    this.commits.push(Object.freeze({ endpointSelectionKey, generation }));
  }
}

export type F104SessionGeneration =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "value"; value: string }>
  | Readonly<{ kind: "malformed" }>;

export type F104TranscriptSession = Readonly<{
  sessionControlKey: string;
  endpointSelectionKey: string;
  generation: F104SessionGeneration;
  preF104ResumeEligible: boolean;
  transcript: readonly string[];
}>;

export class ControlledTranscriptStore {
  readonly nativeResumeRequests: string[] = [];
  private readonly sessions = new Map<string, F104TranscriptSession>();

  set(session: F104TranscriptSession): void {
    this.sessions.set(session.sessionControlKey, freezeTranscriptSession(session));
  }

  read(sessionControlKey: string): F104TranscriptSession | undefined {
    const session = this.sessions.get(sessionControlKey);
    return session === undefined ? undefined : freezeTranscriptSession(session);
  }

  requestNativeResume(sessionControlKey: string): void {
    this.nativeResumeRequests.push(sessionControlKey);
  }
}

export class ControlledOpaqueKeySource {
  private preparationOrdinal = 0;
  private generationOrdinal = 0;

  nextPreparationKey(): string {
    this.preparationOrdinal += 1;
    return `preparation-${String(this.preparationOrdinal).padStart(4, "0")}`;
  }

  nextGeneration(): string {
    this.generationOrdinal += 1;
    return `generation-${String(this.generationOrdinal).padStart(4, "0")}`;
  }
}

export type F104RenderedAction = Readonly<{
  label: string;
  disabled: boolean;
}>;

export type F104RenderedBlocker = Readonly<{
  label: string;
  count: number;
}>;

export type F104RenderedConfirmation = Readonly<{
  statement: string;
  resumableSessionCount: number;
  projectCount: number;
  actions: readonly F104RenderedAction[];
}>;

export type F104RenderedProviderCard = Readonly<{
  label: F104ProviderLabel;
  catalog: F104CatalogLabel;
  subscriptionHeading: "Subscription sign-in";
  authentication: "Bound" | "Sign-in required" | "Unknown";
  actions: readonly F104RenderedAction[];
  feedback: string | null;
  blockedStatement: string | null;
  blockers: readonly F104RenderedBlocker[];
  confirmation: F104RenderedConfirmation | null;
}>;

export type F104RenderedSettings = Readonly<{
  heading: "Settings";
  sections: readonly ["Providers", "Appearance"];
  selectorCounts: Readonly<Record<string, number>>;
  exactTexts: readonly string[];
  cards: readonly [F104RenderedProviderCard, F104RenderedProviderCard];
  credentialControls: false;
  embeddedBrowserControls: false;
  otherProviderControls: false;
}>;

export type F104ResumeObservation = Readonly<{
  nativeResumeRequested: boolean;
  transcript: readonly string[];
}>;

export interface F104AcceptanceSubject {
  sanitizePublicRequest(
    value: unknown,
  ): F104BoundaryResult<F104PublicRequest>;
  sanitizePublicResponse(
    value: unknown,
  ): F104BoundaryResult<F104PublicResponse>;
  request(value: unknown): Promise<F104BoundaryResult<F104PublicResponse>>;
  cancelPreparation(preparationKey: string): Promise<boolean>;
  renderSettings(): Promise<F104RenderedSettings>;
  setCatalogObservation(
    endpointSelectionKey: string,
    catalog: F104CatalogLabel,
  ): void;
  attemptNativeResume(sessionControlKey: string): Promise<F104ResumeObservation>;
  close(): Promise<void>;
}

export type F104SubjectInput = Readonly<{
  adapters: ReadonlyMap<string, F104ProviderAdapter>;
  registry: ControlledProjectRegistry;
  generations: ControlledGenerationStore;
  transcripts: ControlledTranscriptStore;
  opaqueKeys: ControlledOpaqueKeySource;
}>;

export interface F104AcceptanceFactory {
  providerFixture(provider: F104Provider): F104ProviderFixture;
  createProviderAdapter(input: Readonly<{
    provider: F104Provider;
    transport: ControlledNativeProviderTransport;
    scheduler: ControlledScheduler;
    inspectionTimeoutMilliseconds: number;
  }>): F104ProviderAdapter;
  createSubject(
    input: F104SubjectInput,
  ): F104AcceptanceSubject | Promise<F104AcceptanceSubject>;
}

type PreparationRecord = Readonly<{
  endpointSelectionKey: string;
  action: F104AuthenticationAction;
  consequenceCounts: Readonly<{
    resumableSessionCount: number;
    projectCount: number;
  }>;
  used: boolean;
}>;

type GuardDecision =
  | Readonly<{ kind: "blocked"; blockers: F104BlockerCounts }>
  | Readonly<{
      kind: "confirmation-required";
      consequences: Readonly<{
        resumableSessionCount: number;
        projectCount: number;
      }>;
    }>
  | Readonly<{ kind: "ready" }>;

type PresentationState = Readonly<{
  blocked: F104BlockerCounts | null;
  confirmation: Readonly<{
    preparationKey: string;
    resumableSessionCount: number;
    projectCount: number;
    action: F104AuthenticationAction;
  }> | null;
  pendingAction: F104AuthenticationAction | null;
  feedback: string | null;
}>;

class OracleProviderAdapter implements F104ProviderAdapter {
  readonly provider: F104Provider;
  private readonly fixture: F104ProviderFixture;
  private readonly transport: ControlledNativeProviderTransport;
  private readonly scheduler: ControlledScheduler;

  constructor(
    provider: F104Provider,
    fixture: F104ProviderFixture,
    transport: ControlledNativeProviderTransport,
    scheduler: ControlledScheduler,
    _inspectionTimeoutMilliseconds: number,
  ) {
    this.provider = provider;
    this.fixture = fixture;
    this.transport = transport;
    this.scheduler = scheduler;
  }

  async inspectAuthentication(): Promise<F104AuthenticationState> {
    const controller = new AbortController();
    let timeoutHandle: unknown;
    const timeout = new Promise<symbol>((resolve) => {
      timeoutHandle = this.scheduler.setTimeout(() => {
        controller.abort();
        resolve(timeoutMarker);
      });
    });
    try {
      const result = await Promise.race([
        this.transport.readStatus(controller.signal),
        timeout,
      ]);
      if (result === timeoutMarker) return "unknown";
      return classifyConsumedFixture(result, this.fixture);
    } catch {
      return "unknown";
    } finally {
      this.scheduler.clearTimeout(timeoutHandle);
    }
  }

  async launchOfficialAction(
    action: F104AuthenticationAction,
  ): Promise<ControlledNativeChild> {
    return this.transport.requestOfficialAction(
      action,
      new AbortController().signal,
    );
  }
}

const timeoutMarker = Symbol("controlled-timeout");

class OracleWorkbenchSubject implements F104AcceptanceSubject {
  private readonly authentication = new Map<string, F104AuthenticationState>();
  private readonly catalog = new Map<string, F104CatalogLabel>();
  private readonly presentations = new Map<string, PresentationState>();
  private readonly preparations = new Map<string, PreparationRecord>();
  private readonly operationOrder = new Map<string, number>();
  private readonly currentChildren = new Map<string, ControlledNativeChild>();
  private closed = false;
  private readonly input: F104SubjectInput;

  constructor(input: F104SubjectInput) {
    this.input = input;
    for (const providerCase of F104_PROVIDER_CASES) {
      this.authentication.set(providerCase.endpointSelectionKey, "unknown");
      this.catalog.set(providerCase.endpointSelectionKey, "Not checked");
      this.presentations.set(
        providerCase.endpointSelectionKey,
        emptyPresentation(),
      );
      this.operationOrder.set(providerCase.endpointSelectionKey, 0);
    }
  }

  sanitizePublicRequest(
    value: unknown,
  ): F104BoundaryResult<F104PublicRequest> {
    const record = plainDataRecord(value);
    if (record === undefined) return rejectedBoundary();
    const keys = Object.keys(record);
    if (sameKeys(keys, ["endpointSelectionKey"])) {
      if (!this.isKnownEndpointSelectionKey(record.endpointSelectionKey)) {
        return rejectedBoundary();
      }
      return acceptedBoundary(
        Object.freeze({ endpointSelectionKey: record.endpointSelectionKey }),
      );
    }
    if (sameKeys(keys, ["action", "endpointSelectionKey"])) {
      if (
        !this.isKnownEndpointSelectionKey(record.endpointSelectionKey) ||
        !isAuthenticationAction(record.action)
      ) {
        return rejectedBoundary();
      }
      return acceptedBoundary(
        Object.freeze({
          endpointSelectionKey: record.endpointSelectionKey,
          action: record.action,
        }),
      );
    }
    if (sameKeys(keys, ["preparationKey"])) {
      if (
        typeof record.preparationKey !== "string" ||
        !this.isCurrentPreparationKey(record.preparationKey)
      ) {
        return rejectedBoundary();
      }
      return acceptedBoundary(
        Object.freeze({ preparationKey: record.preparationKey }),
      );
    }
    return rejectedBoundary();
  }

  sanitizePublicResponse(
    value: unknown,
  ): F104BoundaryResult<F104PublicResponse> {
    const record = plainDataRecord(value);
    if (record === undefined || typeof record.kind !== "string") {
      return rejectedBoundary();
    }
    if (
      record.kind === "authentication-state" &&
      sameKeys(Object.keys(record), ["kind", "state"]) &&
      isAuthenticationState(record.state)
    ) {
      return acceptedBoundary(
        Object.freeze({ kind: record.kind, state: record.state }),
      );
    }
    if (
      record.kind === "blocked" &&
      sameKeys(Object.keys(record), ["blockers", "kind"])
    ) {
      const blockers = sanitizeBlockers(record.blockers);
      return blockers === undefined
        ? rejectedBoundary()
        : acceptedBoundary(Object.freeze({ kind: record.kind, blockers }));
    }
    if (
      record.kind === "confirmation-required" &&
      sameKeys(Object.keys(record), [
        "consequences",
        "kind",
        "preparationKey",
      ]) &&
      typeof record.preparationKey === "string" &&
      this.isCurrentPreparationKey(record.preparationKey)
    ) {
      const consequences = sanitizeConsequences(record.consequences);
      return consequences === undefined
        ? rejectedBoundary()
        : acceptedBoundary(
            Object.freeze({
              kind: record.kind,
              preparationKey: record.preparationKey,
              consequences,
            }),
          );
    }
    if (
      record.kind === "ready" &&
      sameKeys(Object.keys(record), ["kind", "preparationKey"]) &&
      typeof record.preparationKey === "string" &&
      this.isCurrentPreparationKey(record.preparationKey)
    ) {
      return acceptedBoundary(
        Object.freeze({
          kind: record.kind,
          preparationKey: record.preparationKey,
        }),
      );
    }
    if (
      (record.kind === "authentication-action-requested" ||
        record.kind === "authentication-action-not-requested" ||
        record.kind === "authentication-action-partially-completed") &&
      sameKeys(Object.keys(record), ["action", "kind"]) &&
      isAuthenticationAction(record.action)
    ) {
      return acceptedBoundary(
        Object.freeze({ kind: record.kind, action: record.action }),
      );
    }
    return rejectedBoundary();
  }

  async request(
    value: unknown,
  ): Promise<F104BoundaryResult<F104PublicResponse>> {
    if (this.closed) return rejectedBoundary();
    const request = this.sanitizePublicRequest(value);
    if (!request.accepted) return rejectedBoundary();
    if ("preparationKey" in request.value) {
      return this.beginPreparedAction(request.value.preparationKey);
    }
    if ("action" in request.value) {
      return this.prepareAction(
        request.value.endpointSelectionKey,
        request.value.action,
      );
    }
    return this.inspect(request.value.endpointSelectionKey);
  }

  async cancelPreparation(preparationKey: string): Promise<boolean> {
    const preparation = this.preparations.get(preparationKey);
    if (preparation === undefined || preparation.used) return false;
    this.preparations.set(
      preparationKey,
      Object.freeze({ ...preparation, used: true }),
    );
    this.presentations.set(
      preparation.endpointSelectionKey,
      emptyPresentation(),
    );
    return true;
  }

  async renderSettings(): Promise<F104RenderedSettings> {
    const cards = F104_PROVIDER_CASES.map((providerCase) =>
      this.renderCard(providerCase),
    ) as [F104RenderedProviderCard, F104RenderedProviderCard];
    return Object.freeze({
      heading: "Settings",
      sections: Object.freeze(["Providers", "Appearance"] as const),
      selectorCounts: Object.freeze({
        [F104_SETTINGS_SELECTORS.settingsRoot]: 1,
        [F104_SETTINGS_SELECTORS.providerRegion]: 1,
        [F104_SETTINGS_SELECTORS.providerCard]: 2,
        [F104_SETTINGS_SELECTORS.providerName]: 2,
        [F104_SETTINGS_SELECTORS.providerActions]: 2,
        [F104_SETTINGS_SELECTORS.subscriptionStatus]: 2,
      }),
      exactTexts: Object.freeze([
        F104_COPY.credentialHeading,
        F104_COPY.credentialSentence,
      ]),
      cards: Object.freeze(cards),
      credentialControls: false,
      embeddedBrowserControls: false,
      otherProviderControls: false,
    });
  }

  setCatalogObservation(
    endpointSelectionKey: string,
    catalog: F104CatalogLabel,
  ): void {
    if (!this.isKnownEndpointSelectionKey(endpointSelectionKey)) {
      throw new Error("unknown-controlled-endpoint-selection");
    }
    this.catalog.set(endpointSelectionKey, catalog);
  }

  async attemptNativeResume(
    sessionControlKey: string,
  ): Promise<F104ResumeObservation> {
    const session = this.input.transcripts.read(sessionControlKey);
    if (session === undefined) {
      return Object.freeze({
        nativeResumeRequested: false,
        transcript: Object.freeze([]),
      });
    }
    const endpoint = this.input.generations.read(
      session.endpointSelectionKey,
    );
    let generationEligible = false;
    if (endpoint.classification === "pristine-legacy") {
      generationEligible = session.generation.kind === "missing";
    } else if (endpoint.classification === "managed") {
      generationEligible =
        session.generation.kind === "value" &&
        session.generation.value === endpoint.generation;
    }
    const nativeResumeRequested =
      generationEligible && session.preF104ResumeEligible;
    if (nativeResumeRequested) {
      this.input.transcripts.requestNativeResume(sessionControlKey);
    }
    return Object.freeze({
      nativeResumeRequested,
      transcript: Object.freeze([...session.transcript]),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async inspect(
    endpointSelectionKey: string,
  ): Promise<F104BoundaryResult<F104PublicResponse>> {
    const adapter = this.input.adapters.get(endpointSelectionKey);
    if (adapter === undefined) return rejectedBoundary();
    const startingOrder = this.operationOrder.get(endpointSelectionKey) ?? 0;
    const state = await adapter.inspectAuthentication();
    if ((this.operationOrder.get(endpointSelectionKey) ?? 0) !== startingOrder) {
      return rejectedBoundary();
    }
    this.authentication.set(endpointSelectionKey, state);
    const response = Object.freeze({
      kind: "authentication-state" as const,
      state,
    });
    return this.sanitizePublicResponse(response);
  }

  private async prepareAction(
    endpointSelectionKey: string,
    action: F104AuthenticationAction,
  ): Promise<F104BoundaryResult<F104PublicResponse>> {
    const authentication = this.authentication.get(endpointSelectionKey);
    const presentation = this.presentations.get(endpointSelectionKey);
    if (
      presentation?.pendingAction !== null ||
      (action === "logout" && authentication !== "bound") ||
      (action === "login" && authentication !== "sign-in-required")
    ) {
      return rejectedBoundary();
    }
    const guard = await this.guard(endpointSelectionKey);
    if (guard.kind === "blocked") {
      this.presentations.set(
        endpointSelectionKey,
        Object.freeze({
          ...emptyPresentation(),
          blocked: guard.blockers,
        }),
      );
      return this.sanitizePublicResponse(
        Object.freeze({ kind: "blocked" as const, blockers: guard.blockers }),
      );
    }
    const preparationKey = this.input.opaqueKeys.nextPreparationKey();
    const consequenceCounts =
      guard.kind === "confirmation-required"
        ? guard.consequences
        : Object.freeze({ resumableSessionCount: 0, projectCount: 0 });
    this.preparations.set(
      preparationKey,
      Object.freeze({
        endpointSelectionKey,
        action,
        consequenceCounts,
        used: false,
      }),
    );
    if (guard.kind === "confirmation-required") {
      this.presentations.set(
        endpointSelectionKey,
        Object.freeze({
          ...emptyPresentation(),
          confirmation: Object.freeze({
            preparationKey,
            resumableSessionCount:
              guard.consequences.resumableSessionCount,
            projectCount: guard.consequences.projectCount,
            action,
          }),
        }),
      );
      return this.sanitizePublicResponse(
        Object.freeze({
          kind: "confirmation-required" as const,
          preparationKey,
          consequences: guard.consequences,
        }),
      );
    }
    this.presentations.set(endpointSelectionKey, emptyPresentation());
    return this.sanitizePublicResponse(
      Object.freeze({ kind: "ready" as const, preparationKey }),
    );
  }

  private async beginPreparedAction(
    preparationKey: string,
  ): Promise<F104BoundaryResult<F104PublicResponse>> {
    const preparation = this.preparations.get(preparationKey);
    if (preparation === undefined || preparation.used) return rejectedBoundary();
    this.preparations.set(
      preparationKey,
      Object.freeze({ ...preparation, used: true }),
    );
    const currentGuard = await this.guard(preparation.endpointSelectionKey);
    if (
      currentGuard.kind === "blocked" ||
      (preparation.consequenceCounts.resumableSessionCount === 0 &&
        currentGuard.kind === "confirmation-required") ||
      (currentGuard.kind === "confirmation-required" &&
        (currentGuard.consequences.resumableSessionCount >
          preparation.consequenceCounts.resumableSessionCount ||
          currentGuard.consequences.projectCount >
            preparation.consequenceCounts.projectCount))
    ) {
      this.presentations.set(
        preparation.endpointSelectionKey,
        currentGuard.kind === "blocked"
          ? Object.freeze({
              ...emptyPresentation(),
              blocked: currentGuard.blockers,
            })
          : emptyPresentation(),
      );
      return rejectedBoundary();
    }

    // The fallible provider launch runs before the irreversible generation
    // rotation. A launch that never happens must cost the reader nothing, so
    // the rotation is only committed once the provider CLI has actually been
    // asked to act.
    this.operationOrder.set(
      preparation.endpointSelectionKey,
      (this.operationOrder.get(preparation.endpointSelectionKey) ?? 0) + 1,
    );
    const adapter = this.input.adapters.get(preparation.endpointSelectionKey);
    if (adapter === undefined) return rejectedBoundary();
    this.presentations.set(
      preparation.endpointSelectionKey,
      Object.freeze({
        ...emptyPresentation(),
        pendingAction: preparation.action,
      }),
    );
    let child: ControlledNativeChild;
    try {
      child = await adapter.launchOfficialAction(preparation.action);
    } catch {
      this.presentations.set(
        preparation.endpointSelectionKey,
        Object.freeze({
          ...emptyPresentation(),
          feedback:
            preparation.action === "logout"
              ? F104_COPY.logoutNotRequested
              : null,
        }),
      );
      return this.sanitizePublicResponse(
        Object.freeze({
          kind: "authentication-action-not-requested" as const,
          action: preparation.action,
        }),
      );
    }
    this.currentChildren.set(preparation.endpointSelectionKey, child);

    // The provider CLI has acted. Whatever happens to the rotation now, the
    // outcome can never honestly be reported as "not requested".
    const generation = this.input.opaqueKeys.nextGeneration();
    let committed = true;
    try {
      await this.input.generations.commitManaged(
        preparation.endpointSelectionKey,
        generation,
      );
    } catch {
      committed = false;
    }
    const requestedFeedback =
      preparation.action !== "logout"
        ? null
        : committed
          ? F104_COPY.logoutRequested
          : F104_COPY.logoutPartiallyCompleted;
    this.presentations.set(
      preparation.endpointSelectionKey,
      Object.freeze({
        ...emptyPresentation(),
        pendingAction: preparation.action,
        feedback: requestedFeedback,
      }),
    );
    void child.finished.then(() => {
      if (this.currentChildren.get(preparation.endpointSelectionKey) === child) {
        this.presentations.set(
          preparation.endpointSelectionKey,
          Object.freeze({
            ...emptyPresentation(),
            feedback: requestedFeedback,
          }),
        );
      }
    });
    return this.sanitizePublicResponse(
      Object.freeze({
        kind: committed
          ? ("authentication-action-requested" as const)
          : ("authentication-action-partially-completed" as const),
        action: preparation.action,
      }),
    );
  }

  private async guard(endpointSelectionKey: string): Promise<GuardDecision> {
    const blockers = {
      accepted: 0,
      starting: 0,
      inFlight: 0,
      recoveryRequired: 0,
      unknown: 0,
    };
    const consequenceProjects = new Set<string>();
    let resumableSessionCount = 0;
    let snapshot: F104RegistrySnapshot;
    try {
      snapshot = await this.input.registry.readAll();
    } catch {
      return Object.freeze({
        kind: "blocked",
        blockers: Object.freeze({ ...blockers, unknown: 1 }),
      });
    }
    for (const project of snapshot.projects) {
      for (const session of project.sessions) {
        if (session.endpointMembership === "unknown") {
          blockers.unknown += 1;
          continue;
        }
        if (session.endpointMembership !== endpointSelectionKey) continue;
        if (session.activity === "accepted") blockers.accepted += 1;
        else if (session.activity === "starting") blockers.starting += 1;
        else if (session.activity === "in-flight") blockers.inFlight += 1;
        else if (session.activity === "recovery-required") {
          blockers.recoveryRequired += 1;
        } else if (session.activity === "unknown") blockers.unknown += 1;
        else if (session.nativeResumable) {
          resumableSessionCount += 1;
          consequenceProjects.add(project.projectKey);
        }
      }
    }
    const frozenBlockers = Object.freeze({ ...blockers });
    if (Object.values(frozenBlockers).some((count) => count > 0)) {
      return Object.freeze({ kind: "blocked", blockers: frozenBlockers });
    }
    if (resumableSessionCount > 0) {
      return Object.freeze({
        kind: "confirmation-required",
        consequences: Object.freeze({
          resumableSessionCount,
          projectCount: consequenceProjects.size,
        }),
      });
    }
    return Object.freeze({ kind: "ready" });
  }

  private renderCard(
    providerCase: (typeof F104_PROVIDER_CASES)[number],
  ): F104RenderedProviderCard {
    const authentication =
      this.authentication.get(providerCase.endpointSelectionKey) ?? "unknown";
    const presentation =
      this.presentations.get(providerCase.endpointSelectionKey) ??
      emptyPresentation();
    const authenticationLabel =
      authentication === "bound"
        ? "Bound"
        : authentication === "sign-in-required"
          ? "Sign-in required"
          : "Unknown";
    const blockers = Object.entries(presentation.blocked ?? {})
      .filter((entry): entry is [keyof F104BlockerCounts, number] =>
        Number.isSafeInteger(entry[1]) && entry[1] > 0,
      )
      .map(([key, count]) =>
        Object.freeze({ label: F104_BLOCKER_LABELS[key], count }),
      );
    let actions: readonly F104RenderedAction[];
    if (presentation.pendingAction !== null) {
      actions = Object.freeze([
        Object.freeze({
          label:
            presentation.pendingAction === "logout"
              ? F104_COPY.boundAction
              : F104_COPY.signedOutAction,
          disabled: true,
        }),
      ]);
    } else if (presentation.confirmation !== null) {
      actions = Object.freeze([]);
    } else if (authentication === "bound") {
      actions = Object.freeze([
        Object.freeze({
          label: F104_COPY.boundAction,
          disabled: presentation.blocked !== null,
        }),
      ]);
    } else if (authentication === "sign-in-required") {
      actions = Object.freeze([
        Object.freeze({ label: F104_COPY.signedOutAction, disabled: false }),
      ]);
    } else {
      actions = Object.freeze([
        Object.freeze({ label: "Re-check sign-in", disabled: false }),
      ]);
    }
    const confirmation =
      presentation.confirmation === null
        ? null
        : Object.freeze({
            statement: F104_COPY.consequence,
            resumableSessionCount:
              presentation.confirmation.resumableSessionCount,
            projectCount: presentation.confirmation.projectCount,
            actions: Object.freeze([
              Object.freeze({
                label:
                  presentation.confirmation.action === "logout"
                    ? F104_COPY.confirmLogout
                    : "Continue with Login",
                disabled: false,
              }),
              Object.freeze({ label: F104_COPY.cancel, disabled: false }),
            ]),
          });
    return Object.freeze({
      label: providerCase.label,
      catalog:
        this.catalog.get(providerCase.endpointSelectionKey) ?? "Not checked",
      subscriptionHeading: "Subscription sign-in",
      authentication: authenticationLabel,
      actions,
      feedback: presentation.feedback,
      blockedStatement:
        presentation.blocked === null ? null : F104_COPY.logoutBlocked,
      blockers: Object.freeze(blockers),
      confirmation,
    });
  }

  private isKnownEndpointSelectionKey(value: unknown): value is string {
    return (
      typeof value === "string" &&
      F104_PROVIDER_CASES.some(
        (providerCase) => providerCase.endpointSelectionKey === value,
      )
    );
  }

  private isCurrentPreparationKey(value: string): boolean {
    const preparation = this.preparations.get(value);
    return preparation !== undefined && !preparation.used;
  }
}

const oracleFixtures: Readonly<Record<F104Provider, F104ProviderFixture>> =
  Object.freeze({
    codex: Object.freeze({
      recognizedBound: Object.freeze({
        account: Object.freeze({ type: "chatgpt" }),
      }),
      recognizedSignInRequired: Object.freeze({ account: null }),
      consumedTopLevelKeys: Object.freeze(["account"]),
      invalidConsumed: Object.freeze([
        Object.freeze({ category: "missing", value: Object.freeze({}) }),
        Object.freeze({ category: "wrong-type", value: Object.freeze({ account: "none" }) }),
        Object.freeze({
          category: "unknown-literal",
          value: Object.freeze({ account: Object.freeze({ type: "future" }) }),
        }),
        Object.freeze({
          category: "contradictory",
          value: Object.freeze({
            account: Object.freeze({ type: "chatgpt", loggedOut: true }),
          }),
        }),
      ]),
    }),
    claude: Object.freeze({
      recognizedBound: Object.freeze({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
      }),
      recognizedSignInRequired: Object.freeze({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      }),
      consumedTopLevelKeys: Object.freeze([
        "loggedIn",
        "authMethod",
        "apiProvider",
      ]),
      invalidConsumed: Object.freeze([
        Object.freeze({
          category: "missing",
          value: Object.freeze({ loggedIn: false, authMethod: "none" }),
        }),
        Object.freeze({
          category: "wrong-type",
          value: Object.freeze({
            loggedIn: "false",
            authMethod: "none",
            apiProvider: "firstParty",
          }),
        }),
        Object.freeze({
          category: "unknown-literal",
          value: Object.freeze({
            loggedIn: false,
            authMethod: "renamed-none",
            apiProvider: "firstParty",
          }),
        }),
        Object.freeze({
          category: "contradictory",
          value: Object.freeze({
            loggedIn: true,
            authMethod: "none",
            apiProvider: "firstParty",
          }),
        }),
      ]),
    }),
  });

export function createOracleModelF104AcceptanceFactory(): F104AcceptanceFactory {
  const factory: F104AcceptanceFactory = {
    providerFixture(provider: F104Provider) {
      return oracleFixtures[provider];
    },
    createProviderAdapter(input) {
      return new OracleProviderAdapter(
        input.provider,
        oracleFixtures[input.provider],
        input.transport,
        input.scheduler,
        input.inspectionTimeoutMilliseconds,
      );
    },
    createSubject(input) {
      return new OracleWorkbenchSubject(input);
    },
  };
  return Object.freeze(factory);
}

function classifyConsumedFixture(
  value: unknown,
  fixture: F104ProviderFixture,
): F104AuthenticationState {
  const record = plainDataRecord(value);
  if (record === undefined) return "unknown";
  const consumed = Object.fromEntries(
    fixture.consumedTopLevelKeys.map((key) => [key, record[key]]),
  );
  const bound = plainDataRecord(fixture.recognizedBound);
  const signInRequired = plainDataRecord(fixture.recognizedSignInRequired);
  if (bound === undefined || signInRequired === undefined) return "unknown";
  const consumedBound = Object.fromEntries(
    fixture.consumedTopLevelKeys.map((key) => [key, bound[key]]),
  );
  const consumedSignInRequired = Object.fromEntries(
    fixture.consumedTopLevelKeys.map((key) => [key, signInRequired[key]]),
  );
  if (isDeepStrictEqual(consumed, consumedBound)) return "bound";
  if (isDeepStrictEqual(consumed, consumedSignInRequired)) {
    return "sign-in-required";
  }
  return "unknown";
}

function sanitizeBlockers(value: unknown): F104BlockerCounts | undefined {
  const record = plainDataRecord(value);
  const keys = [
    "accepted",
    "inFlight",
    "recoveryRequired",
    "starting",
    "unknown",
  ];
  if (record === undefined || !sameKeys(Object.keys(record), keys)) {
    return undefined;
  }
  if (!keys.every((key) => isNonNegativeSafeInteger(record[key]))) {
    return undefined;
  }
  return Object.freeze({
    accepted: record.accepted as number,
    starting: record.starting as number,
    inFlight: record.inFlight as number,
    recoveryRequired: record.recoveryRequired as number,
    unknown: record.unknown as number,
  });
}

function sanitizeConsequences(
  value: unknown,
): Readonly<{ resumableSessionCount: number; projectCount: number }> | undefined {
  const record = plainDataRecord(value);
  if (
    record === undefined ||
    !sameKeys(Object.keys(record), ["projectCount", "resumableSessionCount"]) ||
    !isNonNegativeSafeInteger(record.projectCount) ||
    !isNonNegativeSafeInteger(record.resumableSessionCount)
  ) {
    return undefined;
  }
  return Object.freeze({
    resumableSessionCount: record.resumableSessionCount,
    projectCount: record.projectCount,
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function plainDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.value === undefined ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((key, index) => key === [...expected].sort()[index])
  );
}

function isAuthenticationAction(value: unknown): value is F104AuthenticationAction {
  return value === "login" || value === "logout";
}

function isAuthenticationState(value: unknown): value is F104AuthenticationState {
  return (
    value === "bound" || value === "sign-in-required" || value === "unknown"
  );
}

function acceptedBoundary<Value>(value: Value): F104BoundaryResult<Value> {
  return Object.freeze({ accepted: true, value });
}

function rejectedBoundary(): F104BoundaryResult<never> {
  return Object.freeze({ accepted: false });
}

function emptyPresentation(): PresentationState {
  return Object.freeze({
    blocked: null,
    confirmation: null,
    pendingAction: null,
    feedback: null,
  });
}

function freezeProjects(
  projects: readonly F104RegisteredProject[],
): readonly F104RegisteredProject[] {
  return Object.freeze(
    projects.map((project) =>
      Object.freeze({
        projectKey: project.projectKey,
        selected: project.selected,
        sessions: Object.freeze(
          project.sessions.map((session) => Object.freeze({ ...session })),
        ),
      }),
    ),
  );
}

function freezeTranscriptSession(
  session: F104TranscriptSession,
): F104TranscriptSession {
  return Object.freeze({
    ...session,
    generation: Object.freeze({ ...session.generation }),
    transcript: Object.freeze([...session.transcript]),
  });
}
