import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as nodeUtilTypes } from "node:util";

import {
  RuntimeAdapterError,
  type NormalizedRuntimeEvent,
  type RuntimeToolActivity,
  type RuntimeUserInputId,
  type RuntimeUserInputRequest,
  type ResumableAgentRuntimeAdapter,
  type ResumableRuntimeBinding,
  type RuntimeCatalog,
  type RuntimeFailureCategory,
  type SessionProfile,
} from "../agent-runtime/index.ts";
import {
  runtimeProfileProjectionPreservesLockedModes,
} from "../agent-runtime/runtime-profile-projection.ts";
import { resolveSessionProfile } from "../session-profile/index.ts";
import {
  createSessionMetadataModule,
  type SessionMetadataModule,
} from "../session-metadata.ts";
import {
  cloneEffectiveSessionProfileProjection,
  cloneRequestedSessionProfileProjection,
  projectEffectiveSessionProfile,
  type EffectiveSessionProfileProjection,
  type RequestedSessionProfileProjection,
} from "./profile-projection.ts";
import {
  CoordinatorError,
  type CommandReceipt,
  type DirectProjectCommand,
  type DurableProjectUpdate,
  type ProjectChannel,
  type ProjectUserInputView,
  type ProjectUserInputResponse,
  type ProjectUserInputResponseResult,
  type ProjectCommandFailureCategory,
  type ProjectCommandRecovery,
  type ProjectCommandRuntimeContext,
  type ProjectRecoveryFailureCategory,
  type ProjectCommandStatus,
  type ProjectCommandSummary,
  type ProjectContinuationProfileRequest,
  type ProjectContinuationProfileResult,
  type ProjectInterruptCapability,
  type ProjectInterruptRequest,
  type ProjectInterruptResult,
  type ProjectSteerCapability,
  type ProjectSteerRequest,
  type ProjectSteerResult,
  type ProjectRuntimeResumeIdentity,
  type ProjectRuntimeResumeIdentityMapping,
  type ProjectRecordedTurnEvent,
  type ProjectSessionMetadataMutationRequest,
  type ProjectSessionMetadataMutationResult,
  type ProjectSessionRemovalRequest,
  type ProjectSessionRemovalResult,
  type ProjectSnapshotChanges,
  type ProjectSnapshot,
  type ProjectTurnActivity,
  type ProjectUpdate,
  type WorkbenchCoordinator,
} from "./types.ts";
import {
  parseDurableAccountObservation,
  parseDurableAuthenticationContext,
  type DurableAccountObservation,
  type DurableAuthenticationContext,
  type DurableRuntimeEndpointId,
  type WorkLedgerAuthGenerationModule,
} from "./work-ledger-auth-generation.ts";
import {
  SESSION_CONTINUATION_MAX_STEPS,
  type SessionContinuationStop,
} from "./session-continuation-plan.ts";

/**
 * Endpoint roster the channel admits when no explicit roster is injected.
 * Kept to the two subscription endpoints so direct coordinator consumers and
 * their tests observe no behavior change; the Workbench shell injects its
 * full registered roster (which adds the api-key GLM endpoint).
 */
const defaultRuntimeContextEndpointIds: readonly DurableRuntimeEndpointId[] =
  Object.freeze(["codex-desktop", "claude-code-desktop"]);

/** Every endpoint id a stored command envelope can legally carry. */
const allDurableRuntimeEndpointIds: readonly DurableRuntimeEndpointId[] =
  Object.freeze([
    "codex-desktop",
    "claude-code-desktop",
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
    "kimi-platform",
    "claude-api",
    "codex-api",
  ]);

function validateRuntimeContextEndpointIds(
  value: readonly DurableRuntimeEndpointId[] | undefined,
): readonly DurableRuntimeEndpointId[] {
  const ids = value ?? defaultRuntimeContextEndpointIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => !isDurableRuntimeEndpointId(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new CoordinatorError("invalid-command");
  }
  return Object.freeze([...ids]);
}

function isDurableRuntimeEndpointId(
  value: unknown,
): value is DurableRuntimeEndpointId {
  return (
    value === "codex-desktop" ||
    value === "claude-code-desktop" ||
    value === "glm-coding-plan" ||
    value === "kimi-code" ||
    value === "deepseek-api" ||
    value === "kimi-platform" ||
    value === "claude-api" ||
    value === "codex-api"
  );
}

type CommandRow = {
  command_id: string;
  target_session_id: string | null;
  runtime: "codex";
  status: ProjectCommandStatus;
  failure_category:
    | ProjectCommandFailureCategory
    | ProjectRecoveryFailureCategory
    | "quota-paused"
    | null;
  accepted_cursor: number;
  private_envelope_json: string | null;
};

type SessionRow = {
  session_id: string;
  root_command_id: string;
  profile_json: string;
  opaque_session_reference: string | null;
  lifecycle_status: ProjectCommandStatus;
  root_private_envelope_json: string | null;
  root_accepted_cursor: number;
  auth_context_json: string | null;
  account_observation_json: string | null;
  display_name: string | null;
  display_name_source: string | null;
  display_ordinal: number;
  archived: number;
};

type UpdateRow = {
  cursor: number;
  command_id: string;
  kind: DurableProjectUpdate["kind"];
  status: ProjectCommandStatus;
  session_id: string | null;
  data_json: string | null;
};

type ObserverWaiter = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

type PromiseController<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

type AcceptanceResult = {
  readonly receipt: CommandReceipt;
  readonly newlyAccepted: boolean;
};

type EffectiveProfileObservation = {
  readonly projection?: EffectiveSessionProfileProjection;
  readonly protocolFailure: boolean;
};

type ObserverState = {
  readonly after: number | undefined;
  readonly createdOpen: boolean;
  cursor: number;
  snapshotPending: boolean;
  started: boolean;
  done: boolean;
  waiter?: ObserverWaiter;
  operationTail: Promise<void>;
};

type RuntimeIteratorState = {
  readonly iterator: AsyncIterator<NormalizedRuntimeEvent>;
  readonly commandId: string;
  done: boolean;
  terminalObserved?: boolean;
  cancellation?: Promise<void>;
};

type ActiveRuntimeControl = {
  readonly commandId: string;
  readonly sessionId: string;
  readonly binding: ResumableRuntimeBinding;
  readonly events: NormalizedRuntimeEvent[];
  persistedEventCount: number;
  steerPending: boolean;
  interruptRequested: boolean;
  publishedCapability?: Exclude<
    ProjectInterruptCapability["status"],
    "idle" | "unknown"
  >;
};

type CommandKind = "start" | "continue";
type EffectPhase =
  | "legacy"
  | "unclaimed"
  | "binding-claimed"
  | "binding-ready"
  | "send-claimed"
  | "awaiting-terminal"
  | "committed";

type ExecutionCommandRow = {
  command_id: string;
  command_kind: CommandKind;
  target_session_id: string;
  status: ProjectCommandStatus;
  private_envelope_json: string;
  effect_phase: EffectPhase;
  auth_context_json: string | null;
};

type ExecutionSessionRow = {
  session_id: string;
  profile_json: string;
  opaque_session_reference: string | null;
  lifecycle_status: ProjectCommandStatus;
  auth_context_json: string | null;
  account_observation_json: string | null;
  archived: number;
};

export class SqliteWorkbenchCoordinator implements WorkbenchCoordinator {
  readonly databasePath: string;
  readonly adapter: ResumableAgentRuntimeAdapter;
  readonly authGeneration: WorkLedgerAuthGenerationModule | undefined;
  readonly endpointIds: readonly DurableRuntimeEndpointId[];
  private opened = false;

  constructor(
    databasePath: string,
    adapter: ResumableAgentRuntimeAdapter,
    authGeneration?: WorkLedgerAuthGenerationModule,
    endpointIds?: readonly DurableRuntimeEndpointId[],
  ) {
    this.databasePath = databasePath;
    this.adapter = adapter;
    this.authGeneration = authGeneration;
    this.endpointIds = validateRuntimeContextEndpointIds(endpointIds);
  }

  async openProject(directory: string): Promise<ProjectChannel> {
    if (this.opened || directory.trim().length === 0 || this.databasePath.trim().length === 0) {
      throw new CoordinatorError("invalid-command");
    }
    this.opened = true;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.databasePath);
      initializeSchema(database);
      database.exec(`
        CREATE INDEX IF NOT EXISTS updates_command_kind_cursor
          ON updates(command_id, kind, cursor);
        CREATE INDEX IF NOT EXISTS updates_project_session_kind
          ON updates(project_id, session_id, kind);
      `);
      const projectDirectory = resolve(directory);
      const projectId = bindProject(database, projectDirectory);
      const sessionMetadata = createSessionMetadataModule(database, projectId);
      sessionMetadata.assertStoredRows();
      recoverInterruptedCommands(database, projectId);
      const channel = new SqliteProjectChannel(
        database,
        projectId,
        projectDirectory,
        this.adapter,
        sessionMetadata,
        this.authGeneration,
        this.endpointIds,
      );
      channel.startRecoveredExecutions();
      return channel;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // The public error remains fixed even if SQLite close also fails.
      }
      this.opened = false;
      if (error instanceof CoordinatorError) throw error;
      throw new CoordinatorError("storage-failed");
    }
  }
}

class SqliteProjectChannel implements ProjectChannel {
  private readonly database: DatabaseSync;
  private readonly projectId: string;
  private readonly projectDirectory: string;
  private readonly adapter: ResumableAgentRuntimeAdapter;
  private readonly sessionMetadata: SessionMetadataModule;
  private readonly authGeneration: WorkLedgerAuthGenerationModule | undefined;
  private readonly endpointIds: readonly DurableRuntimeEndpointId[];
  private closed = false;
  private closePromise?: Promise<void>;
  private acceptanceTail: Promise<void> = Promise.resolve();
  private executionTail: Promise<void> = Promise.resolve();
  private commitGeneration = 0;
  private readonly observers = new Set<ObserverState>();
  private activeRuntimeIterator?: RuntimeIteratorState;
  private activeRuntimeControl?: ActiveRuntimeControl;
  private executionBinding?: ResumableRuntimeBinding;
  private quotaExpiryTimer?: ReturnType<typeof setTimeout>;
  private userInputSessionId?: string;
  private readonly userInputEntries = new Map<string, { requestId: RuntimeUserInputId; view: ProjectUserInputView }>();
  private readonly userInputListeners = new Set<() => void>();
  private runtimeEventCacheCursor = 0;
  private readonly runtimeEventsByCommandId = new Map<
    string,
    readonly ProjectRecordedTurnEvent[]
  >();
  private readonly sessionModelReplyCursors = new Map<string, number>();
  private readonly storedCommandCache = new Map<
    string,
    { readonly source: string; readonly command: DirectProjectCommand }
  >();

  constructor(
    database: DatabaseSync,
    projectId: string,
    projectDirectory: string,
    adapter: ResumableAgentRuntimeAdapter,
    sessionMetadata: SessionMetadataModule,
    authGeneration?: WorkLedgerAuthGenerationModule,
    endpointIds: readonly DurableRuntimeEndpointId[] = defaultRuntimeContextEndpointIds,
  ) {
    this.database = database;
    this.projectId = projectId;
    this.projectDirectory = projectDirectory;
    this.adapter = adapter;
    this.sessionMetadata = sessionMetadata;
    this.authGeneration = authGeneration;
    this.endpointIds = validateRuntimeContextEndpointIds(endpointIds);
  }

  startRecoveredExecutions(): void {
    this.refreshQuotaPauses();
    // Reopening must not perpetuate an app-side lockout. Recheck only the
    // latest unknown command of each blocked Session with a saved native route.
    const recoveries = this.database.prepare(`
      SELECT commands.command_id, commands.failure_category
        FROM commands JOIN sessions ON sessions.session_id = commands.target_session_id
       WHERE commands.project_id = ? AND commands.digest_version = 2
         AND commands.status = 'recovery-required'
         AND sessions.lifecycle_status = 'recovery-required'
         AND sessions.opaque_session_reference IS NOT NULL
         AND commands.accepted_cursor = (
           SELECT MAX(prior.accepted_cursor) FROM commands prior
            WHERE prior.target_session_id = sessions.session_id AND prior.status = 'recovery-required'
         )
       ORDER BY commands.accepted_cursor
    `).all(this.projectId) as Array<{ command_id: string; failure_category: ProjectRecoveryFailureCategory | null }>;
    for (const row of recoveries) {
      this.executionTail = this.executionTail.then(async () => {
        if (!this.closed) await this.recordRecoveryRequired(row.command_id, row.failure_category ?? undefined);
      }).catch(() => { /* The durable unknown outcome remains visible if storage is unavailable. */ });
    }
    const rows = this.database
      .prepare(
        `SELECT command_id
           FROM commands
          WHERE project_id = ?
            AND digest_version = 2
            AND status IN ('accepted', 'in-flight')
            AND effect_phase IN ('unclaimed', 'binding-ready')
          ORDER BY accepted_cursor`,
      )
      .all(this.projectId) as unknown as Array<{ command_id: string }>;
    for (const row of rows) {
      this.scheduleExecution(row.command_id, Promise.resolve());
    }
  }

  act(
    command: DirectProjectCommand,
    runtimeContext?: ProjectCommandRuntimeContext,
  ): Promise<CommandReceipt> {
    let commandSnapshot: DirectProjectCommand;
    let runtimeContextSnapshot: ProjectCommandRuntimeContext | undefined;
    try {
      this.assertOpen();
      validateCommand(command, this.endpointIds);
      commandSnapshot = cloneDirectCommand(command);
      runtimeContextSnapshot = validateRuntimeContext(
        runtimeContext,
        this.authGeneration !== undefined,
        this.endpointIds,
      );
    } catch (error) {
      return Promise.reject(
        error instanceof CoordinatorError
          ? error
          : new CoordinatorError("invalid-command"),
      );
    }
    const receiptController = createPromiseController<CommandReceipt>();
    const acceptance = this.acceptanceTail.then(async () => {
      try {
        const accepted = await this.performAcceptance(
          commandSnapshot,
          runtimeContextSnapshot,
        );
        if (accepted.newlyAccepted) {
          const executionStart = createPromiseController<void>();
          this.scheduleExecution(accepted.receipt.commandId, executionStart.promise);
          receiptController.resolve(accepted.receipt);
          queueMicrotask(() => executionStart.resolve(undefined));
          return;
        }
        receiptController.resolve(accepted.receipt);
      } catch (error) {
        receiptController.reject(
          error instanceof CoordinatorError
            ? error
            : new CoordinatorError("storage-failed"),
        );
      }
    });
    this.acceptanceTail = acceptance.then(
      () => undefined,
      () => undefined,
    );
    return receiptController.promise;
  }

  validateContinuationProfile(
    request: ProjectContinuationProfileRequest,
  ): Promise<ProjectContinuationProfileResult> {
    let requestSnapshot: ProjectContinuationProfileRequest;
    try {
      this.assertOpen();
      requestSnapshot = validateContinuationProfileRequest(request);
    } catch (error) {
      return Promise.reject(
        error instanceof CoordinatorError
          ? error
          : new CoordinatorError("invalid-command"),
      );
    }
    return this.acceptanceTail.then(async () => {
      try {
        this.assertOpen();
        const row = this.database
          .prepare(
            `SELECT profile_json, opaque_session_reference, lifecycle_status,
                    archived, account_observation_json
               FROM sessions
              WHERE project_id = ? AND session_id = ?`,
          )
          .get(this.projectId, requestSnapshot.sessionId) as
          | Pick<
              ExecutionSessionRow,
              | "profile_json"
              | "opaque_session_reference"
              | "lifecycle_status"
              | "account_observation_json"
            > & { readonly archived: number }
          | undefined;
        if (
          row === undefined ||
          row.archived !== 0 ||
          (row.lifecycle_status !== "completed" && !this.sessionHasQuotaPause(requestSnapshot.sessionId)) ||
          row.opaque_session_reference === null ||
          row.opaque_session_reference.trim().length === 0 ||
          !this.isAccountObservationCurrent(row.account_observation_json)
        ) {
          return Object.freeze({ status: "incompatible" as const });
        }
        const currentProfile = parseStoredProfile(row.profile_json);
        if (this.sessionHasQuotaPause(requestSnapshot.sessionId) && !sameProfile(currentProfile, requestSnapshot.profile)) {
          return Object.freeze({ status: "incompatible" as const });
        }
        const compatible = await this.isCompatibleContinuationProfile(
          currentProfile,
          requestSnapshot.profile,
        );
        return Object.freeze({
          status: compatible ? ("compatible" as const) : ("incompatible" as const),
        });
      } catch (error) {
        if (error instanceof CoordinatorError) throw error;
        throw new CoordinatorError("storage-failed");
      }
    });
  }

  async readSessionRuntimeResumeIdentities(
    sessionId: string,
  ): Promise<readonly ProjectRuntimeResumeIdentityMapping[]> {
    this.assertOpen();
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new CoordinatorError("invalid-command");
    }
    try {
      const rows = this.database
        .prepare(
          `SELECT private_envelope_json
             FROM commands
            WHERE project_id = ?
              AND target_session_id = ?
              AND digest_version = 2
              AND private_envelope_json IS NOT NULL
            ORDER BY accepted_cursor, command_id`,
        )
        .all(this.projectId, sessionId) as unknown as Array<{
          readonly private_envelope_json: string;
        }>;
      const mappings: ProjectRuntimeResumeIdentityMapping[] = [];
      const bySelectionProfile = new Map<
        string,
        ProjectRuntimeResumeIdentityMapping
      >();
      let endpointId:
        | ProjectRuntimeResumeIdentityMapping["endpointId"]
        | undefined;
      for (const row of rows) {
        const command = hydrateStoredCommand(
          row.private_envelope_json,
          this.endpointIds,
        );
        const identity = command.runtimeResumeIdentity;
        if (identity === undefined) continue;
        if (endpointId !== undefined && endpointId !== identity.endpointId) {
          throw new Error("conflicting-runtime-resume-endpoint");
        }
        endpointId = identity.endpointId;
        const selectionKey = canonicalProfile(command.profile);
        const existing = bySelectionProfile.get(selectionKey);
        if (existing !== undefined) {
          if (
            existing.endpointId !== identity.endpointId ||
            !sameProfile(existing.nativeProfile, identity.nativeProfile)
          ) {
            throw new Error("conflicting-runtime-resume-identity");
          }
          continue;
        }
        const mapping = Object.freeze({
          endpointId: identity.endpointId,
          selectionProfile: Object.freeze(cloneProfile(command.profile)),
          nativeProfile: Object.freeze(cloneProfile(identity.nativeProfile)),
        });
        bySelectionProfile.set(selectionKey, mapping);
        mappings.push(mapping);
      }
      return Object.freeze(mappings);
    } catch {
      throw new CoordinatorError("storage-failed");
    }
  }

  mutateSessionMetadata(
    request: ProjectSessionMetadataMutationRequest,
  ): Promise<ProjectSessionMetadataMutationResult> {
    let requestSnapshot: ProjectSessionMetadataMutationRequest;
    try {
      this.assertOpen();
      requestSnapshot = validateSessionMetadataMutationRequest(request);
    } catch (error) {
      return Promise.reject(
        error instanceof CoordinatorError
          ? error
          : new CoordinatorError("invalid-command"),
      );
    }
    const operation = this.acceptanceTail.then(() => {
      try {
        this.assertOpen();
        return this.sessionMetadata.mutate(requestSnapshot);
      } catch (error) {
        throw error instanceof CoordinatorError
          ? error
          : new CoordinatorError("storage-failed");
      }
    });
    this.acceptanceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  removeSession(
    request: ProjectSessionRemovalRequest,
  ): Promise<ProjectSessionRemovalResult> {
    let validated: ReturnType<typeof validateSessionRemovalRequest>;
    try {
      this.assertOpen();
      validated = validateSessionRemovalRequest(request);
    } catch (error) {
      return Promise.reject(
        error instanceof CoordinatorError
          ? error
          : new CoordinatorError("invalid-command"),
      );
    }
    const operation = this.acceptanceTail.then(() => {
      try {
        return this.performSessionRemoval(
          validated.sessionId,
          validated.acknowledgedUnknownOutcome,
        );
      } catch (error) {
        throw error instanceof CoordinatorError
          ? error
          : new CoordinatorError("storage-failed");
      }
    });
    this.acceptanceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private performSessionRemoval(
    sessionId: string,
    acknowledgedUnknownOutcome: boolean,
  ): ProjectSessionRemovalResult {
    const session = this.database
      .prepare(
        `SELECT lifecycle_status
           FROM sessions
          WHERE project_id = ? AND session_id = ?`,
      )
      .get(this.projectId, sessionId) as
      | { readonly lifecycle_status: ProjectCommandStatus }
      | undefined;
    if (session === undefined) {
      return Object.freeze({ status: "not-found" as const });
    }

    const active = this.database
      .prepare(
        `SELECT status
           FROM commands
          WHERE project_id = ?
            AND target_session_id = ?
            AND status IN ('accepted', 'in-flight', 'recovery-required')
          ORDER BY CASE status
            WHEN 'in-flight' THEN 0
            WHEN 'accepted' THEN 1
            ELSE 2
          END
          LIMIT 1`,
      )
      .get(this.projectId, sessionId) as
      | {
          readonly status: "accepted" | "in-flight" | "recovery-required";
        }
      | undefined;
    // Live work and an unknowable outcome are two different facts and are
    // decided separately. A running turn always wins: the acknowledgement can
    // never release it, so D16.2 holds unchanged.
    const liveActivity =
      active?.status === "in-flight" || active?.status === "accepted"
        ? active.status
        : session.lifecycle_status === "in-flight" ||
            session.lifecycle_status === "accepted"
          ? session.lifecycle_status
          : undefined;
    if (liveActivity !== undefined) {
      return Object.freeze({
        status: "blocked" as const,
        activity: liveActivity,
      });
    }
    // Historical uncertainty still needs acknowledgement before deletion,
    // independently of whether a fresh CLI resume made the Session usable.
    const outcomeUnknown =
      active?.status === "recovery-required" ||
      session.lifecycle_status === "recovery-required";
    if (outcomeUnknown && !acknowledgedUnknownOutcome) {
      return Object.freeze({
        status: "blocked" as const,
        activity: "unknown" as const,
      });
    }

    transaction(this.database, () => {
      this.database
        .prepare(
          `DELETE FROM updates
            WHERE command_id IN (
              SELECT command_id
                FROM commands
               WHERE project_id = ? AND target_session_id = ?
            )`,
        )
        .run(this.projectId, sessionId);
      const removedSession = this.database
        .prepare(
          "DELETE FROM sessions WHERE project_id = ? AND session_id = ?",
        )
        .run(this.projectId, sessionId);
      const removedCommands = this.database
        .prepare(
          "DELETE FROM commands WHERE project_id = ? AND target_session_id = ?",
        )
        .run(this.projectId, sessionId);
      if (
        Number(removedSession.changes) !== 1 ||
        Number(removedCommands.changes) < 1
      ) {
        throw new Error("session-removal-conflict");
      }
    });
    return Object.freeze({ status: "removed" as const });
  }

  private async performAcceptance(
    command: DirectProjectCommand,
    runtimeContext: ProjectCommandRuntimeContext | undefined,
  ): Promise<AcceptanceResult> {
    if (
      command.runtimeResumeIdentity !== undefined &&
      (runtimeContext === undefined ||
        runtimeContext.endpointId !== command.runtimeResumeIdentity.endpointId)
    ) {
      throw new CoordinatorError("invalid-command");
    }
    const idempotencyDigest = digest(command.idempotencyKey);
    const payloadDigest = digest(canonicalCommandPayload(command));
    const existing = this.database
      .prepare(
        `SELECT command_id, payload_digest, digest_version, accepted_cursor
           FROM commands
          WHERE project_id = ? AND idempotency_digest = ?`,
      )
      .get(this.projectId, idempotencyDigest) as
      | {
          command_id: string;
          payload_digest: string;
          digest_version: number;
          accepted_cursor: number;
        }
      | undefined;
    if (existing !== undefined) {
      const replayDigest =
        Number(existing.digest_version) === 1 && command.commandKind === "start"
          ? digest(canonicalLegacyCommandPayload(command))
          : payloadDigest;
      if (existing.payload_digest !== replayDigest) {
        throw new CoordinatorError("idempotency-conflict");
      }
      return {
        receipt: {
          commandId: existing.command_id,
          acceptedCursor: Number(existing.accepted_cursor),
          status: "accepted",
        },
        newlyAccepted: false,
      };
    }
    const commandId = randomUUID();
    const sessionId =
      command.commandKind === "start"
        ? randomUUID()
        : await this.validateContinuationTarget(command);
    if (this.hasRecoveryBarrierForSession(sessionId)) {
      throw new CoordinatorError("continuation-unavailable");
    }
    const authenticationContext = this.captureAuthenticationContext(
      runtimeContext,
    );
    const authenticationContextJson =
      authenticationContext === undefined
        ? null
        : JSON.stringify(authenticationContext);
    if (
      command.commandKind === "continue" &&
      !this.isContinuationGenerationEligible(
        sessionId,
        runtimeContext,
        authenticationContext,
      )
    ) {
      throw new CoordinatorError("continuation-unavailable");
    }
    const accountObservationJson =
      command.commandKind === "start"
        ? this.captureAccountObservationJson(runtimeContext)
        : null;
    const acceptedCursor = transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO commands (
             command_id, project_id, idempotency_digest, payload_digest,
             digest_version, command_kind, target_session_id, runtime, status,
             failure_category, accepted_cursor, private_envelope_json,
             effect_phase, outcome_uncertain, auth_context_json
           ) VALUES (?, ?, ?, ?, 2, ?, ?, 'codex', 'accepted', NULL, 0, ?,
                     'unclaimed', 0, ?)`,
        )
        .run(
          commandId,
          this.projectId,
          idempotencyDigest,
          payloadDigest,
          command.commandKind,
          sessionId,
          JSON.stringify(command),
          authenticationContextJson,
        );
      if (command.commandKind === "start") {
        const displayOrdinal = nextAvailableSessionDisplayOrdinal(
          this.database,
          this.projectId,
        );
        const metadata = this.sessionMetadata.acceptedInitial(
          command.input,
          displayOrdinal,
        );
        this.database
          .prepare(
            `INSERT INTO sessions (
               session_id, project_id, root_command_id, profile_json,
               opaque_session_reference, lifecycle_status, auth_context_json,
               display_name, display_name_source, account_observation_json,
               display_ordinal
             ) VALUES (?, ?, ?, ?, NULL, 'accepted', ?, ?, ?, ?, ?)`,
          )
          .run(
            sessionId,
            this.projectId,
            commandId,
            JSON.stringify(command.profile),
            authenticationContextJson,
            metadata.displayName,
            metadata.displayNameSource,
            accountObservationJson,
            displayOrdinal,
          );
      } else {
        this.database
          .prepare(
            "UPDATE sessions SET lifecycle_status = 'accepted' WHERE session_id = ?",
          )
          .run(sessionId);
      }
      const cursor = appendUpdate(
        this.database,
        this.projectId,
        commandId,
        "accepted",
        "accepted",
        sessionId,
      );
      this.database
        .prepare("UPDATE commands SET accepted_cursor = ? WHERE command_id = ?")
        .run(cursor, commandId);
      return cursor;
    });
    this.notifyCommittedUpdate();
    const receipt: CommandReceipt = {
      commandId,
      acceptedCursor,
      status: "accepted",
    };

    return { receipt, newlyAccepted: true };
  }

  private captureAuthenticationContext(
    runtimeContext: ProjectCommandRuntimeContext | undefined,
  ): DurableAuthenticationContext | undefined {
    if (this.authGeneration === undefined) return undefined;
    if (runtimeContext === undefined) {
      throw new CoordinatorError("invalid-command");
    }
    const captured = this.authGeneration.captureForAcceptedCommand(
      runtimeContext.endpointId,
    );
    if (captured === undefined) {
      throw new CoordinatorError("storage-failed");
    }
    return captured;
  }

  /**
   * The opaque discriminator for the provider sign-in this Session is being
   * started under. It is minted locally from the observed authentication state
   * alone, so nothing here reads or stores a credential. Absent observation
   * stamps NULL, which never refuses a later resume by itself.
   */
  private captureAccountObservationJson(
    runtimeContext: ProjectCommandRuntimeContext | undefined,
  ): string | null {
    if (this.authGeneration === undefined || runtimeContext === undefined) {
      return null;
    }
    const observation: DurableAccountObservation | undefined =
      this.authGeneration.captureAccountObservation(runtimeContext.endpointId);
    return observation === undefined ? null : JSON.stringify(observation);
  }

  /**
   * Refuses a replay only on a positive proof that the active provider sign-in
   * differs from the one this Session was started under, or on a stamp that no
   * longer parses. Legacy NULL stamps and unobserved endpoints defer to the
   * durable authentication-generation gate rather than invent a refusal.
   */
  private isAccountObservationCurrent(
    accountObservationJson: string | null,
  ): boolean {
    if (this.authGeneration === undefined) return true;
    const verdict = this.authGeneration.classifySessionAccountObservation(
      accountObservationJson,
    );
    return verdict !== "different-sign-in" && verdict !== "unreadable";
  }

  private isContinuationGenerationEligible(
    sessionId: string,
    runtimeContext: ProjectCommandRuntimeContext | undefined,
    commandContext: DurableAuthenticationContext | undefined,
  ): boolean {
    if (this.authGeneration === undefined) return true;
    if (runtimeContext === undefined || commandContext === undefined) return false;
    const row = this.database
      .prepare(
        `SELECT auth_context_json, account_observation_json
           FROM sessions
          WHERE project_id = ? AND session_id = ?`,
      )
      .get(this.projectId, sessionId) as
      | {
          readonly auth_context_json: string | null;
          readonly account_observation_json: string | null;
        }
      | undefined;
    return (
      row !== undefined &&
      this.isAccountObservationCurrent(row.account_observation_json) &&
      this.authGeneration.isNativeResumeEligible({
        endpointId: runtimeContext.endpointId,
        sessionContext: row.auth_context_json,
        commandContext,
      })
    );
  }

  private async validateContinuationTarget(
    command: Extract<DirectProjectCommand, { readonly commandKind: "continue" }>,
  ): Promise<string> {
    const row = this.database
      .prepare(
        `SELECT session_id, project_id, profile_json, opaque_session_reference,
                lifecycle_status, archived, auth_context_json,
                account_observation_json
           FROM sessions
          WHERE session_id = ?`,
      )
      .get(command.targetSessionId) as
      | (ExecutionSessionRow & { project_id: string })
      | undefined;
    if (row === undefined) throw new CoordinatorError("continuation-unavailable");
    if (row.project_id !== this.projectId) {
      throw new CoordinatorError("project-mismatch");
    }
    let storedProfile: SessionProfile;
    try {
      storedProfile = parseStoredProfile(row.profile_json);
    } catch {
      throw new CoordinatorError("continuation-unavailable");
    }
    const queuedEligibility =
      ["accepted", "in-flight"].includes(row.lifecycle_status) &&
      this.database
        .prepare(
          `SELECT 1
             FROM commands
            WHERE project_id = ?
              AND target_session_id = ?
              AND digest_version = 2
              AND status IN ('accepted', 'in-flight')
            LIMIT 1`,
        )
        .get(this.projectId, row.session_id) !== undefined;
    if (
      !sameLockedProfileFields(storedProfile, command.profile) ||
      row.archived !== 0 ||
      row.opaque_session_reference === null ||
      row.opaque_session_reference.trim().length === 0 ||
      (row.lifecycle_status !== "completed" && !queuedEligibility && !this.sessionHasQuotaPause(row.session_id)) ||
      (this.sessionHasQuotaPause(row.session_id) && !sameProfile(storedProfile, command.profile))
    ) {
      throw new CoordinatorError("continuation-unavailable");
    }
    if (!(await this.isCompatibleContinuationProfile(storedProfile, command.profile))) {
      throw new CoordinatorError("continuation-unavailable");
    }
    if (
      !sameProfile(storedProfile, command.profile) &&
      command.profileProjection === undefined
    ) {
      throw new CoordinatorError("continuation-unavailable");
    }
    return row.session_id;
  }

  private async isCompatibleContinuationProfile(
    currentProfile: SessionProfile,
    requestedProfile: SessionProfile,
  ): Promise<boolean> {
    if (!sameLockedProfileFields(currentProfile, requestedProfile)) return false;
    if (sameProfile(currentProfile, requestedProfile)) return true;
    const compatibility = this.adapter.continuationProfileCompatibility;
    if (typeof compatibility !== "function") return false;
    try {
      return (
        (await compatibility.call(this.adapter, {
          projectDirectory: this.projectDirectory,
          currentProfile: cloneProfile(currentProfile),
          requestedProfile: cloneProfile(requestedProfile),
        })) === "compatible"
      );
    } catch {
      return false;
    }
  }

  private scheduleExecution(
    commandId: string,
    executionStart: Promise<void>,
  ): void {
    const execution = this.executionTail.then(async () => {
      await executionStart;
      try {
        await this.performExecution(commandId);
      } catch {
        await this.containExecutionFailure(commandId);
      } finally {
        this.executionBinding = undefined;
      }
    });
    this.executionTail = execution.then(
      () => undefined,
      () => undefined,
    );
  }

  private async containExecutionFailure(commandId: string): Promise<void> {
    try {
      const row = this.database
        .prepare(
          "SELECT status, effect_phase, outcome_uncertain FROM commands WHERE command_id = ?",
        )
        .get(commandId) as
        | {
            status: ProjectCommandStatus;
            effect_phase: EffectPhase;
            outcome_uncertain: number;
          }
        | undefined;
      if (row === undefined || !["accepted", "in-flight"].includes(row.status)) {
        return;
      }
      if (
        Number(row.outcome_uncertain) === 1 ||
        ["binding-claimed", "send-claimed", "awaiting-terminal"].includes(
          row.effect_phase,
        )
      ) {
        await this.recordRecoveryRequired(commandId, undefined, this.executionBinding);
        return;
      }
      if (row.status === "in-flight") {
        this.recordFailure(commandId, "runtime-failed");
      }
    } catch {
      // Reopening performs the same fail-closed phase audit if storage recovers.
    }
  }

  private async performExecution(commandId: string): Promise<void> {
    if (this.closed) return;
    // Timers may run late; a queued resume still has the original absolute deadline.
    this.refreshQuotaPauses();
    // A queued input was authorized before the preceding outcome was known.
    // A later, deliberate user continuation is different: keep w148's fresh
    // CLI-resume decision and the original unknown-outcome record intact.
    // Expiry of a historical quota pause is not a new execution failure after
    // a successful resume that the user had already observed before queuing.
    const stopped = transaction(this.database, () => {
      const preceding = this.database.prepare(`
        SELECT previous.status, current.target_session_id AS session_id
          FROM commands current
          JOIN commands previous ON previous.target_session_id = current.target_session_id
            AND previous.accepted_cursor < current.accepted_cursor
          JOIN updates terminal ON terminal.command_id = previous.command_id
         WHERE current.command_id = ? AND current.status = 'accepted'
           AND previous.status IN ('failed', 'recovery-required')
           AND terminal.kind IN ('failed', 'recovery-required')
           AND terminal.cursor > current.accepted_cursor
           AND NOT (previous.failure_category IS 'quota-expired' AND EXISTS (
             SELECT 1 FROM commands resumed
               JOIN updates completed ON completed.command_id = resumed.command_id AND completed.kind = 'completed'
              WHERE resumed.target_session_id = current.target_session_id
                AND resumed.accepted_cursor > previous.accepted_cursor
                AND completed.cursor < current.accepted_cursor
           ))
           AND EXISTS (SELECT 1 FROM updates started
                        WHERE started.command_id = previous.command_id AND started.kind = 'in-flight')
         LIMIT 1
      `).get(commandId) as { status: string; session_id: string } | undefined;
      if (preceding === undefined) return undefined;
      this.database.prepare(`UPDATE commands SET status = 'failed', failure_category = 'runtime-failed',
        effect_phase = 'committed', outcome_uncertain = 0 WHERE command_id = ?`).run(commandId);
      // An interrupted Session with no remaining queued work is still resumable.
      this.database.prepare(`UPDATE sessions SET lifecycle_status = 'completed'
        WHERE session_id = ? AND lifecycle_status = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM commands WHERE target_session_id = ? AND status IN ('accepted', 'in-flight'))
      `).run(preceding.session_id, preceding.session_id);
      appendUpdate(this.database, this.projectId, commandId, "failed", "failed",
        preceding.session_id, { failureCategory: "runtime-failed" });
      return preceding;
    });
    if (stopped !== undefined) {
      console.warn("[coordinator] Queued continuation was not sent: preceding turn did not complete", {
        precedingStatus: stopped.status,
      });
      this.notifyCommittedUpdate();
      return;
    }
    if (this.hasEarlierRecoveryBarrier(commandId)) return;
    const began = transaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT status, target_session_id FROM commands WHERE command_id = ?",
        )
        .get(commandId) as
        | { status: ProjectCommandStatus; target_session_id: string | null }
        | undefined;
      if (
        row === undefined ||
        !["accepted", "in-flight"].includes(row.status) ||
        row.target_session_id === null
      ) {
        return false;
      }
      if (row.status === "accepted") {
        this.database
          .prepare("UPDATE commands SET status = 'in-flight' WHERE command_id = ?")
          .run(commandId);
        appendUpdate(
          this.database,
          this.projectId,
          commandId,
          "in-flight",
          "in-flight",
          row.target_session_id,
        );
      }
      this.database
        .prepare(
          "UPDATE sessions SET lifecycle_status = 'in-flight' WHERE session_id = ?",
        )
        .run(row.target_session_id);
      return true;
    });
    if (!began) return;
    this.notifyCommittedUpdate();

    let loaded: {
      command: DirectProjectCommand;
      commandRow: ExecutionCommandRow;
      session: ExecutionSessionRow;
    };
    try {
      loaded = this.loadExecution(commandId);
    } catch {
      this.recordFailure(commandId, "runtime-failed");
      return;
    }
    const { command, commandRow, session } = loaded;
    const storedProfile = parseStoredProfile(session.profile_json);
    if (
      command.commandKind === "continue"
        ? !sameLockedProfileFields(storedProfile, command.profile)
        : !sameProfile(storedProfile, command.profile)
    ) {
      this.recordFailure(commandId, "profile-resolution-failed");
      return;
    }

    if (
      command.commandKind === "start" &&
      session.opaque_session_reference === null
    ) {
      let catalog: RuntimeCatalog;
      try {
        catalog = await this.adapter.inspect(this.projectDirectory);
      } catch (error) {
        this.recordFailure(
          commandId,
          "runtime-failed",
          executionInspectionFailureCategory(error),
        );
        return;
      }
      if (this.closed || !this.isInFlight(commandId)) return;
      try {
        const resolved = resolveSessionProfile({
          catalog,
          catalogRevision: command.catalogRevision,
          preferences: command.preferences,
          overrides: command.overrides,
        }).profile;
        if (!sameProfile(resolved, command.profile)) {
          throw new Error("profile-drift");
        }
      } catch {
        this.recordFailure(commandId, "profile-resolution-failed");
        return;
      }
      this.recordProfileResolved(commandId, session.session_id, command.profile);
    }
    if (this.closed || !this.isInFlight(commandId)) return;

    const existingReference = session.opaque_session_reference;
    if (
      commandRow.effect_phase !== "unclaimed" &&
      commandRow.effect_phase !== "binding-ready"
    ) {
      return;
    }
    if (
      existingReference !== null &&
      !this.isNativeResumeAllowed(commandRow, session)
    ) {
      this.recordFailure(commandId, "runtime-failed");
      return;
    }
    if (!this.claimBinding(commandId)) return;
    let binding: ResumableRuntimeBinding;
    try {
      binding =
        command.commandKind === "start" && existingReference === null
          ? await this.adapter.start({
              projectDirectory: this.projectDirectory,
              profile: cloneProfile(command.profile),
            })
          : await this.adapter.resume({
              projectDirectory: this.projectDirectory,
              profile: cloneProfile(command.profile),
              opaqueSessionReference: existingReference ?? "",
            });
      this.executionBinding = binding;
      if (
        !sameProfile(binding.profile, command.profile) ||
        binding.opaqueSessionReference.trim().length === 0 ||
        (existingReference !== null &&
          binding.opaqueSessionReference !== existingReference)
      ) {
        throw new Error("binding-drift");
      }
    } catch (error) {
      if (this.executionBinding !== undefined) await closeUnusedBinding(this.executionBinding);
      await this.recordRecoveryRequired(commandId, recoveryFailureCategory(error), undefined,
        existingReference !== null && error instanceof RuntimeAdapterError &&
          ["protocol-rejected", "runtime-not-located", "authentication-required", "unsupported-selection"].includes(error.category) ? {
          resume: "unconfirmed", reason: recoveryFailureCategory(error) ?? "resume-unconfirmed",
        } : undefined);
      return;
    }
    if (!this.commitBinding(commandId, session.session_id, binding)) {
      await this.recordRecoveryRequired(commandId, undefined, binding);
      return;
    }
    if (this.closed) {
      await closeUnusedBinding(binding);
      return;
    }
    if (!this.claimSend(commandId)) {
      await closeUnusedBinding(binding);
      return;
    }
    try {
      await binding.send({ text: command.input });
    } catch (error) {
      await this.recordRecoveryRequired(commandId, recoveryFailureCategory(error), binding);
      return;
    }
    if (this.closed) {
      await this.recordRecoveryRequired(commandId, undefined, binding);
      return;
    }
    this.database
      .prepare(
        "UPDATE commands SET effect_phase = 'awaiting-terminal', outcome_uncertain = 1 WHERE command_id = ? AND status = 'in-flight'",
      )
      .run(commandId);

    const events: NormalizedRuntimeEvent[] = [];
    let terminal: "completed" | "interrupted" | "quota-paused" | "failed" | "invalid" | undefined;
    let iteratorState: RuntimeIteratorState;
    try {
      iteratorState = {
        iterator: binding.events()[Symbol.asyncIterator](),
        commandId,
        done: false,
      };
    } catch (error) {
      await this.recordRecoveryRequired(commandId, recoveryFailureCategory(error), binding);
      return;
    }
    this.activeRuntimeIterator = iteratorState;
    const runtimeControl: ActiveRuntimeControl = {
      commandId,
      sessionId: session.session_id,
      binding,
      events,
      persistedEventCount: 0,
      steerPending: false,
      interruptRequested: false,
    };
    this.activeRuntimeControl = runtimeControl;
    const disposeUserInput = this.attachUserInput(runtimeControl);
    this.publishActiveInterruptCapability(runtimeControl);
    try {
      while (true) {
        const pending = iteratorState.iterator.next();
        if (this.closed && !iteratorState.terminalObserved) {
          void this.cancelRuntimeIterator(iteratorState);
        }
        const result = await pending;
        if (result.done) {
          iteratorState.done = true;
          break;
        }
        const ignoredFields: string[] = [];
        const event = cloneRuntimeEvent(result.value, ignoredFields);
        if (ignoredFields.length > 0) {
          console.warn("[coordinator] Ignored unknown runtime event fields", {
            kind: event.kind,
            fields: ignoredFields,
          });
        }
        if (terminal !== undefined) {
          terminal = "invalid";
          break;
        }
        events.push(event);
        if (event.kind === "turn-completed") terminal = "completed";
        if (event.kind === "turn-interrupted") terminal = "interrupted";
        if (event.kind === "turn-paused") terminal = "quota-paused";
        if (event.kind === "failed") terminal = "failed";
        iteratorState.terminalObserved = terminal !== undefined;
        if (terminal === undefined) {
          if (event.kind === "reasoning" || event.kind === "progress" || event.kind === "agent-message") {
            this.persistActiveRuntimeEvents(runtimeControl);
          }
          this.publishActiveInterruptCapability(runtimeControl);
        }
      }
    } catch (error) {
      await this.recordRecoveryRequired(commandId, recoveryFailureCategory(error), binding);
      return;
    } finally {
      if (!iteratorState.done) await this.cancelRuntimeIterator(iteratorState);
      disposeUserInput();
      if (this.activeRuntimeIterator === iteratorState) {
        this.activeRuntimeIterator = undefined;
      }
      if (this.activeRuntimeControl === runtimeControl) {
        this.activeRuntimeControl = undefined;
      }
    }
    // Closing stops new work and observers, but finishClose keeps SQLite open
    // until this execution settles. A validated terminal stream is still a
    // known outcome: commit it before close rather than inventing uncertainty.
    // Cancellation before terminal observation can truncate a conflicting
    // suffix, so its done:true cannot certify even a subsequently received end.
    if (
      iteratorState.cancellation === undefined &&
      (terminal === "completed" ||
        terminal === "interrupted" ||
        terminal === "quota-paused" ||
        terminal === "failed")
    ) {
      const effectiveProfileObservation = this.observeEffectiveProfileProjection(
        session.session_id,
        command,
        binding,
      );
      this.commitTerminal(
        commandId,
        session.session_id,
        events,
        effectiveProfileObservation.protocolFailure ? "failed" : terminal,
        effectiveProfileObservation.projection,
        runtimeControl.persistedEventCount,
      );
      return;
    }
    // The iterator above was already drained or cancelled exactly once.
    await this.recordRecoveryRequired(commandId);
  }

  readUserInput(sessionId: string): readonly ProjectUserInputView[] {
    return this.closed || sessionId !== this.userInputSessionId ? [] :
      Object.freeze([...this.userInputEntries.values()].map(entry => entry.view));
  }

  observeUserInput(listener: () => void): () => void {
    this.userInputListeners.add(listener);
    return () => { this.userInputListeners.delete(listener); };
  }

  private publishUserInput(): void {
    for (const listener of this.userInputListeners) {
      try { listener(); } catch { this.userInputListeners.delete(listener); }
    }
  }

  private attachUserInput(control: ActiveRuntimeControl): () => void {
    this.userInputEntries.clear();
    this.userInputSessionId = control.sessionId;
    const input = control.binding.userInput;
    const requested = (request: RuntimeUserInputRequest) => {
      if ([...this.userInputEntries.values()].some(entry => entry.requestId === request.id)) return;
      const requestKey = `user-input:${randomUUID()}`;
      this.userInputEntries.set(requestKey, { requestId: request.id, view: Object.freeze({
        requestKey, state: "pending", questions: request.questions, isBlocking: request.isBlocking, expiresAt: request.expiresAt,
      }) });
    };
    const unsubscribe = input?.subscribe(event => {
      if (this.activeRuntimeControl !== control) return;
      if (event.kind === "user-input-requested") requested(event.request);
      else for (const [requestKey, entry] of this.userInputEntries) {
        if (entry.requestId === event.requestId) entry.view = Object.freeze({ requestKey, state: event.resolution });
      }
      this.publishUserInput();
    });
    input?.pending().forEach(requested);
    this.publishUserInput();
    return () => {
      unsubscribe?.();
      for (const [requestKey, entry] of this.userInputEntries) {
        if (entry.view.state === "pending") entry.view = Object.freeze({ requestKey, state: "session-ended" });
      }
      this.publishUserInput();
    };
  }

  async respondToUserInput(request: ProjectUserInputResponse): Promise<ProjectUserInputResponseResult> {
    const control = this.activeRuntimeControl;
    const entry = this.userInputEntries.get(request.requestKey);
    const input = control?.binding.userInput;
    if (this.closed || !input || control?.sessionId !== this.userInputSessionId || entry?.view.state !== "pending") {
      return { status: "unavailable" };
    }
    // This does not enter acceptanceTail/executionTail: the running turn is waiting for this answer.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        request.kind === "cancel" ? input.cancel(entry.requestId) : input.answer({ requestId: entry.requestId, answers: request.answers }),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("user-input-response-timeout")), 8000); }),
      ]);
      // Server cleanup can win the write race; only the Runtime's resolution confirms an answer.
      const state: ProjectUserInputView["state"] = this.userInputEntries.get(request.requestKey)?.view.state ?? "session-ended";
      return { status: state === "answered" || state === "cancelled" ? state : "unavailable" };
    } catch (error) {
      return { status: error instanceof RuntimeAdapterError && error.category === "invalid-input" &&
        entry.view.state === "pending" && request.kind === "answer" ? "invalid-answer" : "unavailable" };
    } finally { clearTimeout(deadline); }
  }

  private loadExecution(commandId: string): {
    command: DirectProjectCommand;
    commandRow: ExecutionCommandRow;
    session: ExecutionSessionRow;
  } {
    const commandRow = this.database
      .prepare(
        "SELECT command_id, command_kind, target_session_id, status, private_envelope_json, effect_phase, auth_context_json FROM commands WHERE command_id = ? AND project_id = ? AND digest_version = 2",
      )
      .get(commandId, this.projectId) as ExecutionCommandRow | undefined;
    if (
      commandRow === undefined ||
      commandRow.target_session_id === null ||
      commandRow.private_envelope_json === null
    ) {
      throw new Error("invalid-command-row");
    }
    const command = hydrateStoredCommand(
      commandRow.private_envelope_json,
      this.endpointIds,
    );
    if (
      command.commandKind !== commandRow.command_kind ||
      (command.commandKind === "continue" &&
        command.targetSessionId !== commandRow.target_session_id)
    ) {
      throw new Error("invalid-command-link");
    }
    const session = this.database
      .prepare(
        "SELECT session_id, profile_json, opaque_session_reference, lifecycle_status, auth_context_json, account_observation_json FROM sessions WHERE session_id = ? AND project_id = ?",
      )
      .get(commandRow.target_session_id, this.projectId) as
      | ExecutionSessionRow
      | undefined;
    if (session === undefined) throw new Error("invalid-session-row");
    return { command, commandRow, session };
  }

  private isNativeResumeAllowed(
    command: Pick<ExecutionCommandRow, "auth_context_json">,
    session: Pick<
      ExecutionSessionRow,
      "auth_context_json" | "account_observation_json"
    >,
  ): boolean {
    if (this.authGeneration === undefined) return true;
    if (!this.isAccountObservationCurrent(session.account_observation_json)) {
      return false;
    }
    const commandContext = parseDurableAuthenticationContext(
      command.auth_context_json,
    );
    if (commandContext === undefined) {
      return (
        command.auth_context_json === null &&
        session.auth_context_json === null &&
        this.authGeneration.isSessionNativeResumable(null)
      );
    }
    return this.authGeneration.isNativeResumeEligible({
      endpointId: commandContext.endpointId,
      sessionContext: session.auth_context_json,
      commandContext,
    });
  }

  private recordProfileResolved(
    commandId: string,
    sessionId: string,
    profile: SessionProfile,
  ): void {
    const existing = this.database
      .prepare(
        "SELECT 1 FROM updates WHERE command_id = ? AND kind = 'profile-resolved'",
      )
      .get(commandId);
    if (existing !== undefined) return;
    appendUpdate(
      this.database,
      this.projectId,
      commandId,
      "profile-resolved",
      "in-flight",
      sessionId,
      { profile },
    );
    this.notifyCommittedUpdate();
  }

  private claimBinding(commandId: string): boolean {
    const result = this.database
      .prepare(
        "UPDATE commands SET effect_phase = 'binding-claimed', outcome_uncertain = 1 WHERE command_id = ? AND status = 'in-flight' AND effect_phase IN ('unclaimed', 'binding-ready') AND outcome_uncertain = 0",
      )
      .run(commandId);
    return Number(result.changes) === 1;
  }

  private commitBinding(
    commandId: string,
    sessionId: string,
    binding: ResumableRuntimeBinding,
  ): boolean {
    try {
      return transaction(this.database, () => {
        const sessionResult = this.database
          .prepare(
            "UPDATE sessions SET opaque_session_reference = ? WHERE session_id = ? AND (opaque_session_reference IS NULL OR opaque_session_reference = ?)",
          )
          .run(
            binding.opaqueSessionReference,
            sessionId,
            binding.opaqueSessionReference,
          );
        if (Number(sessionResult.changes) !== 1) {
          throw new Error("binding-session-conflict");
        }
        const commandResult = this.database
          .prepare(
            "UPDATE commands SET effect_phase = 'binding-ready', outcome_uncertain = 0 WHERE command_id = ? AND status = 'in-flight' AND effect_phase = 'binding-claimed'",
          )
          .run(commandId);
        if (Number(commandResult.changes) !== 1) {
          throw new Error("binding-command-conflict");
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  private claimSend(commandId: string): boolean {
    const result = this.database
      .prepare(
        "UPDATE commands SET effect_phase = 'send-claimed', outcome_uncertain = 1 WHERE command_id = ? AND status = 'in-flight' AND effect_phase = 'binding-ready' AND outcome_uncertain = 0",
      )
      .run(commandId);
    return Number(result.changes) === 1;
  }

  /** A quota refusal ended the native process, but not the retained conversation.
   * Keep schema-v6's stopped/failed storage row; the exact terminal update is
   * the durable distinction between a resumable refusal and ordinary failure.
   */
  private commitQuotaPause(commandId: string, sessionId: string, events: readonly NormalizedRuntimeEvent[], persistedEventCount: number): void {
    const queued = this.database.prepare(
      "SELECT command_id FROM commands WHERE target_session_id = ? AND command_id <> ? AND status = 'accepted'",
    ).all(sessionId, commandId) as unknown as { command_id: string }[];
    if (queued.length > 0 || events.some(event => ["agent-message", "reasoning", "progress", "item-completed"].includes(event.kind))) {
      // No implicit retry of input accepted while the rejected attempt ran.
      // A queued/partly executed sequence is outside the initial-refusal rule.
      this.commitTerminal(commandId, sessionId, events.map(event => event.kind === "turn-paused"
        ? { kind: "failed", category: "turn-failed" } : event), "failed", undefined, persistedEventCount, queued.map(row => row.command_id));
      return;
    }
    const prior = this.database.prepare(
      `SELECT data_json FROM updates WHERE session_id = ? AND kind = 'quota-paused'
         AND cursor > COALESCE((SELECT MAX(cursor) FROM updates WHERE session_id = ? AND kind = 'completed'), 0)
       ORDER BY cursor LIMIT 1`,
    ).get(sessionId, sessionId) as { data_json: string } | undefined;
    const expiresAt = prior === undefined ? Date.now() + quotaPauseMaximumMs : readQuotaDeadline(prior.data_json);
    // Fresh per attempt, unlike expiresAt: this attempt's own provider reading, not chained.
    const resetsAt = events.find((event): event is Extract<NormalizedRuntimeEvent, { kind: "turn-paused" }> =>
      event.kind === "turn-paused")?.resetsAt;
    const committed = transaction(this.database, () => {
      const result = this.database.prepare(
        "UPDATE commands SET status = 'failed', failure_category = 'quota-paused', effect_phase = 'committed', outcome_uncertain = 0 WHERE command_id = ? AND status = 'in-flight' AND effect_phase = 'awaiting-terminal'",
      ).run(commandId);
      if (Number(result.changes) !== 1) return false;
      for (const event of events.slice(persistedEventCount)) appendUpdate(
        this.database, this.projectId, commandId, "runtime-event", "in-flight", sessionId, { event },
      );
      this.database.prepare("UPDATE sessions SET lifecycle_status = 'failed' WHERE session_id = ?").run(sessionId);
      appendUpdate(this.database, this.projectId, commandId, "quota-paused", "quota-paused", sessionId,
        resetsAt === undefined ? { expiresAt } : { expiresAt, resetsAt });
      return true;
    });
    if (committed) {
      this.refreshQuotaPauses();
      this.notifyCommittedUpdate();
    }
  }

  private quotaDeadline(commandId: string): number {
    const row = this.database.prepare("SELECT data_json FROM updates WHERE command_id = ? AND kind = 'quota-paused' ORDER BY cursor DESC LIMIT 1")
      .get(commandId) as { data_json: string } | undefined;
    return row === undefined ? 0 : readQuotaDeadline(row.data_json);
  }

  private quotaResetsAt(commandId: string): number | undefined {
    const row = this.database.prepare("SELECT data_json FROM updates WHERE command_id = ? AND kind = 'quota-paused' ORDER BY cursor DESC LIMIT 1")
      .get(commandId) as { data_json: string } | undefined;
    return row === undefined ? undefined : readQuotaResetsAt(row.data_json);
  }

  private sessionHasQuotaPause(sessionId: string): boolean {
    const row = this.database.prepare("SELECT command_id, failure_category FROM commands WHERE target_session_id = ? ORDER BY accepted_cursor DESC LIMIT 1")
      .get(sessionId) as { command_id: string; failure_category: string | null } | undefined;
    return row?.failure_category === "quota-paused" && this.quotaDeadline(row.command_id) > Date.now();
  }

  private refreshQuotaPauses(): void {
    clearTimeout(this.quotaExpiryTimer);
    if (this.closed) return;
    const rows = this.database.prepare("SELECT command_id, target_session_id FROM commands WHERE project_id = ? AND status = 'failed' AND failure_category = 'quota-paused'")
      .all(this.projectId) as unknown as { command_id: string; target_session_id: string }[];
    const deadlines = rows.map(row => ({ ...row, deadline: this.quotaDeadline(row.command_id) }));
    const expired = deadlines.filter(row => row.deadline <= Date.now());
    const next = Math.min(...deadlines.filter(row => row.deadline > Date.now()).map(row => row.deadline));
    if (expired.length > 0) transaction(this.database, () => {
      for (const row of expired) {
        this.database.prepare("UPDATE commands SET failure_category = 'quota-expired' WHERE command_id = ?").run(row.command_id);
        appendUpdate(this.database, this.projectId, row.command_id, "failed", "failed", row.target_session_id, { failureCategory: "quota-expired" });
      }
    });
    if (expired.length > 0) this.notifyCommittedUpdate();
    if (Number.isFinite(next)) {
      this.quotaExpiryTimer = setTimeout(() => this.refreshQuotaPauses(), Math.max(1, next - Date.now()));
      this.quotaExpiryTimer.unref();
    }
  }

  private commitTerminal(
    commandId: string,
    sessionId: string,
    events: readonly NormalizedRuntimeEvent[],
    outcome: "completed" | "interrupted" | "quota-paused" | "failed",
    effectiveProfileProjection?: EffectiveSessionProfileProjection,
    persistedEventCount = 0,
    rejectedQueuedInputs: readonly string[] = [],
  ): void {
    if (outcome === "quota-paused") {
      this.commitQuotaPause(commandId, sessionId, events, persistedEventCount);
      return;
    }
    const completed = outcome === "completed";
    const interrupted = outcome === "interrupted";
    const failureCategory: ProjectCommandFailureCategory | null = interrupted
      ? "interrupted"
      : completed
        ? null
        : "runtime-failed";
    const committed = transaction(this.database, () => {
      const result = this.database
        .prepare(
          "UPDATE commands SET status = ?, failure_category = ?, effect_phase = 'committed', outcome_uncertain = 0 WHERE command_id = ? AND status = 'in-flight' AND effect_phase = 'awaiting-terminal'",
        )
        .run(
          completed ? "completed" : "failed",
          failureCategory,
          commandId,
        );
      if (Number(result.changes) !== 1) return false;
      // Reject pre-pause queued input atomically with the refusal. A crash
      // between separate commits must not turn reopening into an implicit retry.
      for (const queuedCommandId of rejectedQueuedInputs) {
        this.database.prepare("UPDATE commands SET status = 'failed', failure_category = 'runtime-failed', effect_phase = 'committed', outcome_uncertain = 0 WHERE command_id = ?").run(queuedCommandId);
        appendUpdate(this.database, this.projectId, queuedCommandId, "failed", "failed", sessionId, { failureCategory: "runtime-failed" });
      }
      for (const event of events.slice(persistedEventCount)) {
        appendUpdate(
          this.database,
          this.projectId,
          commandId,
          "runtime-event",
          "in-flight",
          sessionId,
          { event },
        );
      }
      const hasQueued = this.database
        .prepare(
          "SELECT 1 FROM commands WHERE target_session_id = ? AND command_id <> ? AND status IN ('accepted', 'in-flight') LIMIT 1",
        )
        .get(sessionId, commandId);
      this.database
        .prepare(
          "UPDATE sessions SET lifecycle_status = ? WHERE session_id = ?",
        )
        .run(
          completed || interrupted
            ? (hasQueued === undefined ? "completed" : "accepted")
            : "failed",
          sessionId,
        );
      appendUpdate(
        this.database,
        this.projectId,
        commandId,
        completed ? "completed" : "failed",
        completed ? "completed" : "failed",
        sessionId,
        completed
          ? effectiveProfileProjection === undefined
            ? undefined
            : { effectiveProfileProjection }
          : {
              failureCategory,
              ...(effectiveProfileProjection === undefined
                ? {}
                : { effectiveProfileProjection }),
            },
      );
      return true;
    });
    if (committed) this.notifyCommittedUpdate();
  }

  private observeEffectiveProfileProjection(
    sessionId: string,
    command: DirectProjectCommand,
    binding: ResumableRuntimeBinding,
  ): EffectiveProfileObservation {
    const requestedProjection = this.requestedProjectionForCommand(sessionId, command);
    let observedProfile: unknown;
    try {
      observedProfile = binding.effectiveProfile?.();
    } catch {
      return { protocolFailure: true };
    }
    if (observedProfile === undefined) {
      return {
        protocolFailure: false,
        ...(requestedProjection === undefined
          ? {}
          : {
              projection: projectEffectiveSessionProfile({
                requestedProfile: command.profile,
                requestedProjection,
                observedProfile,
              }),
            }),
      };
    }
    if (!isExactReportedProfile(observedProfile)) {
      return { protocolFailure: true };
    }
    return {
      protocolFailure: !sameProfile(observedProfile, command.profile),
      ...(requestedProjection === undefined
        ? {}
        : {
            projection: projectEffectiveSessionProfile({
              requestedProfile: command.profile,
              requestedProjection,
              observedProfile,
            }),
          }),
    };
  }

  private requestedProjectionForCommand(
    sessionId: string,
    command: DirectProjectCommand,
  ): RequestedSessionProfileProjection | undefined {
    if (command.commandKind === "start") {
      return command.requestedProfileProjection;
    }
    if (command.profileProjection !== undefined) {
      return command.profileProjection.requested;
    }
    const row = this.database
      .prepare(
        `SELECT sessions.profile_json, commands.private_envelope_json
           FROM sessions
           JOIN commands ON commands.command_id = sessions.root_command_id
          WHERE sessions.session_id = ? AND sessions.project_id = ?`,
      )
      .get(sessionId, this.projectId) as
      | { private_envelope_json: string; profile_json: string }
      | undefined;
    if (row === undefined) return undefined;
    if (!sameProfile(parseStoredProfile(row.profile_json), command.profile)) {
      return undefined;
    }
    const rootCommand = hydrateStoredCommand(
      row.private_envelope_json,
      this.endpointIds,
    );
    return rootCommand.commandKind === "start"
      ? rootCommand.requestedProfileProjection
      : undefined;
  }

  private async probeRecoveryResume(
    commandId: string,
    binding?: ResumableRuntimeBinding,
  ): Promise<ProjectCommandRecovery> {
    if (binding !== undefined) {
      // Stop the old transport before establishing a fresh one-input binding.
      if (this.activeRuntimeIterator?.commandId === commandId) {
        try { binding.close?.(); } catch { /* Resume is checked independently of app cleanup. */ }
        await this.cancelRuntimeIterator(this.activeRuntimeIterator);
      } else {
        await closeUnusedBinding(binding);
      }
    }
    if (this.closed) return { resume: "unconfirmed", reason: "channel-closed" };
    const { command, commandRow, session } = this.loadExecution(commandId);
    const reference = session.opaque_session_reference ?? binding?.opaqueSessionReference;
    if (!reference) return { resume: "unconfirmed", reason: "session-reference-unavailable" };
    if (!this.isNativeResumeAllowed(commandRow, session)) {
      return { resume: "unconfirmed", reason: "authentication-changed" };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let resumed: ResumableRuntimeBinding | undefined;
    try {
      resumed = await Promise.race([
        this.adapter.resume({
          projectDirectory: this.projectDirectory,
          profile: cloneProfile(command.profile),
          opaqueSessionReference: reference,
        }).then(async value => {
          if (expired) await closeUnusedBinding(value);
          return value;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error("resume-timeout")); }, 8000);
        }),
      ]);
      if (!sameProfile(resumed.profile, command.profile) || resumed.opaqueSessionReference !== reference) {
        return { resume: "unconfirmed", reason: "binding-drift" };
      }
      if (this.closed) return { resume: "unconfirmed", reason: "channel-closed" };
      // A successful resume handshake is evidence about the Session, never the
      // previous input. No send() is performed and no outcome bit is cleared.
      this.database.prepare("UPDATE sessions SET opaque_session_reference = ?, profile_json = ? WHERE session_id = ?")
        .run(reference, JSON.stringify(command.profile), session.session_id);
      return { resume: "confirmed" };
    } catch (error) {
      return { resume: "unconfirmed", reason: expired ? "resume-timeout" : recoveryFailureCategory(error) ?? "resume-unconfirmed" };
    } finally {
      clearTimeout(timer);
      if (resumed !== undefined) await closeUnusedBinding(resumed);
    }
  }

  private async recordRecoveryRequired(
    commandId: string,
    failureCategory?: ProjectRecoveryFailureCategory,
    binding?: ResumableRuntimeBinding,
    observed?: ProjectCommandRecovery,
  ): Promise<void> {
    const recovery = observed ?? await this.probeRecoveryResume(commandId, binding);
    const committed = transaction(this.database, () => {
      const row = this.database
        .prepare("SELECT target_session_id FROM commands WHERE command_id = ?")
        .get(commandId) as { target_session_id: string | null } | undefined;
      const result = this.database
        .prepare(
          `UPDATE commands SET status = 'recovery-required', failure_category = ?, outcome_uncertain = 1,
                  effect_phase = CASE WHEN ? THEN 'committed' ELSE effect_phase END
            WHERE command_id = ? AND status IN ('accepted', 'in-flight', 'recovery-required')`,
        )
        .run(failureCategory ?? null, recovery.resume === "confirmed" ? 1 : 0, commandId);
      if (Number(result.changes) !== 1) return false;
      if (row?.target_session_id !== null && row?.target_session_id !== undefined) {
        // completed is the existing idle/resumable Session state. The command
        // remains recovery-required; committed here seals only the recovery decision.
        this.database
          .prepare("UPDATE sessions SET lifecycle_status = ? WHERE session_id = ?")
          .run(recovery.resume === "confirmed" ? "completed" : "recovery-required", row.target_session_id);
        if (recovery.resume === "confirmed") {
          this.database.prepare(`UPDATE commands SET effect_phase = 'committed'
            WHERE target_session_id = ? AND status = 'recovery-required'`).run(row.target_session_id);
        }
      }
      appendUpdate(this.database, this.projectId, commandId, "recovery-required", "recovery-required",
        row?.target_session_id ?? undefined, { recovery });
      return true;
    });
    if (committed) this.notifyCommittedUpdate();
  }

  private hasRecoveryBarrierForSession(sessionId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1
             FROM commands
            WHERE project_id = ?
              AND (
                (digest_version = 1 AND status IN ('accepted', 'in-flight', 'recovery-required'))
                OR
                (digest_version = 2 AND target_session_id = ? AND status = 'recovery-required' AND effect_phase != 'committed')
              )
            LIMIT 1`,
        )
        .get(this.projectId, sessionId) !== undefined
    );
  }

  private hasEarlierRecoveryBarrier(commandId: string): boolean {
    const current = this.database
      .prepare(
        "SELECT accepted_cursor, target_session_id FROM commands WHERE command_id = ?",
      )
      .get(commandId) as
      | { accepted_cursor: number; target_session_id: string | null }
      | undefined;
    if (current === undefined || current.target_session_id === null) return true;
    return (
      this.database
        .prepare(
          `SELECT 1
             FROM commands
            WHERE project_id = ?
              AND accepted_cursor < ?
              AND (
                (digest_version = 1 AND status IN ('accepted', 'in-flight', 'recovery-required'))
                OR
                (
                  digest_version = 2
                  AND target_session_id = ?
                  AND effect_phase != 'committed'
                  AND (status = 'recovery-required' OR outcome_uncertain = 1)
                )
              )
            LIMIT 1`,
        )
        .get(
          this.projectId,
          current.accepted_cursor,
          current.target_session_id,
        ) !== undefined
    );
  }

  private cancelRuntimeIterator(state: RuntimeIteratorState): Promise<void> {
    if (state.done) return Promise.resolve();
    if (state.cancellation !== undefined) return state.cancellation;
    try {
      const returnIterator = state.iterator.return;
      if (returnIterator === undefined) {
        state.cancellation = Promise.resolve();
        return state.cancellation;
      }
      state.cancellation = Promise.resolve(returnIterator.call(state.iterator)).then(
        () => {
          state.done = true;
        },
        () => undefined,
      );
    } catch {
      state.cancellation = Promise.resolve();
    }
    return state.cancellation;
  }

  readInterruptCapability(): ProjectInterruptCapability {
    if (this.closed) return Object.freeze({ status: "unknown" as const });
    try {
      const row = this.database
        .prepare(
          `SELECT command_id
             FROM commands
            WHERE project_id = ? AND status = 'in-flight'
            ORDER BY accepted_cursor
            LIMIT 1`,
        )
        .get(this.projectId) as { readonly command_id: string } | undefined;
      if (row === undefined) return Object.freeze({ status: "idle" as const });
      const control = this.activeRuntimeControl;
      if (control === undefined || control.commandId !== row.command_id) {
        return Object.freeze({
          status: "pending" as const,
          commandId: row.command_id,
        });
      }
      if (control.interruptRequested) {
        return Object.freeze({
          status: "requested" as const,
          commandId: row.command_id,
        });
      }
      if (
        typeof control.binding.interrupt !== "function" ||
        typeof control.binding.interruptAvailability !== "function"
      ) {
        return Object.freeze({
          status: "unsupported" as const,
          commandId: row.command_id,
        });
      }
      let availability;
      try {
        availability = control.binding.interruptAvailability();
      } catch {
        availability = "unavailable" as const;
      }
      return Object.freeze({
        status:
          availability === "available"
            ? "available" as const
            : availability === "unsupported"
              ? "unsupported" as const
              : "pending" as const,
        commandId: row.command_id,
      });
    } catch {
      return Object.freeze({ status: "unknown" as const });
    }
  }

  async interruptActiveTurn(
    request: ProjectInterruptRequest,
  ): Promise<ProjectInterruptResult> {
    if (
      !isExactDataRecord(request, ["commandId"]) ||
      typeof request.commandId !== "string" ||
      request.commandId.length === 0
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    const capability = this.readInterruptCapability();
    if (
      !("commandId" in capability) ||
      capability.commandId !== request.commandId
    ) {
      return Object.freeze({ status: "not-running" as const });
    }
    if (capability.status === "unsupported") {
      return Object.freeze({ status: "unsupported" as const });
    }
    if (capability.status !== "available") {
      return Object.freeze({ status: "unavailable" as const });
    }
    const control = this.activeRuntimeControl;
    const interrupt = control?.binding.interrupt;
    if (
      control === undefined ||
      control.commandId !== request.commandId ||
      typeof interrupt !== "function"
    ) {
      return Object.freeze({ status: "not-running" as const });
    }
    control.interruptRequested = true;
    this.publishActiveInterruptCapability(control);
    try {
      await interrupt.call(control.binding);
      return Object.freeze({ status: "requested" as const });
    } catch {
      return Object.freeze({ status: "unavailable" as const });
    }
  }

  readSteerCapability(): ProjectSteerCapability {
    if (this.closed) return Object.freeze({ status: "unknown" as const });
    try {
      const row = this.database
        .prepare(
          `SELECT command_id
             FROM commands
            WHERE project_id = ? AND status = 'in-flight'
            ORDER BY accepted_cursor
            LIMIT 1`,
        )
        .get(this.projectId) as { readonly command_id: string } | undefined;
      if (row === undefined) return Object.freeze({ status: "idle" as const });
      const control = this.activeRuntimeControl;
      if (control === undefined || control.commandId !== row.command_id) {
        return Object.freeze({
          status: "pending" as const,
          commandId: row.command_id,
        });
      }
      if (control.steerPending) {
        return Object.freeze({
          status: "submitting" as const,
          commandId: row.command_id,
        });
      }
      if (
        typeof control.binding.steer !== "function" ||
        typeof control.binding.steerAvailability !== "function"
      ) {
        return Object.freeze({
          status: "unsupported" as const,
          commandId: row.command_id,
        });
      }
      let availability;
      try {
        availability = control.binding.steerAvailability();
      } catch {
        availability = "unavailable" as const;
      }
      return Object.freeze({
        status:
          availability === "available"
            ? "available" as const
            : availability === "unsupported"
              ? "unsupported" as const
              : "unavailable" as const,
        commandId: row.command_id,
      });
    } catch {
      return Object.freeze({ status: "unknown" as const });
    }
  }

  async steerActiveTurn(
    request: ProjectSteerRequest,
  ): Promise<ProjectSteerResult> {
    if (
      !isExactDataRecord(request, ["commandId", "input"]) ||
      typeof request.commandId !== "string" ||
      request.commandId.length === 0 ||
      !isValidSteerInput(request.input)
    ) {
      return Object.freeze({ status: "unavailable" as const });
    }
    const capability = this.readSteerCapability();
    if (
      !("commandId" in capability) ||
      capability.commandId !== request.commandId
    ) {
      return Object.freeze({ status: "not-running" as const });
    }
    if (capability.status === "unsupported") {
      return Object.freeze({ status: "unsupported" as const });
    }
    if (capability.status !== "available") {
      return Object.freeze({ status: "unavailable" as const });
    }
    const control = this.activeRuntimeControl;
    const steer = control?.binding.steer;
    if (
      control === undefined ||
      control.commandId !== request.commandId ||
      typeof steer !== "function"
    ) {
      return Object.freeze({ status: "not-running" as const });
    }
    control.steerPending = true;
    this.publishActiveInterruptCapability(control);
    try {
      await steer.call(control.binding, { text: request.input });
      if (!this.recordAcceptedSteer(control, request.input)) {
        return Object.freeze({ status: "unavailable" as const });
      }
      return Object.freeze({ status: "accepted" as const });
    } catch {
      return Object.freeze({ status: "unavailable" as const });
    } finally {
      control.steerPending = false;
      this.publishActiveInterruptCapability(control);
    }
  }

  /** Commit visible runtime output while the turn is still running. The same
   * persisted count lets steering and terminal commits append only the tail. */
  private persistActiveRuntimeEvents(control: ActiveRuntimeControl): void {
    const count = control.events.length;
    transaction(this.database, () => {
      for (let index = control.persistedEventCount; index < count; index += 1) {
        appendUpdate(this.database, this.projectId, control.commandId,
          "runtime-event", "in-flight", control.sessionId,
          { event: control.events[index] });
      }
    });
    control.persistedEventCount = count;
    this.notifyCommittedUpdate();
  }

  private recordAcceptedSteer(
    control: ActiveRuntimeControl,
    input: string,
  ): boolean {
    if (this.activeRuntimeControl !== control) return false;
    const row = this.database
      .prepare(
        "SELECT status FROM commands WHERE project_id = ? AND command_id = ?",
      )
      .get(this.projectId, control.commandId) as
      | { readonly status: ProjectCommandStatus }
      | undefined;
    if (row?.status !== "in-flight") return false;
    const nextPersistedEventCount = control.events.length;
    transaction(this.database, () => {
      for (
        let index = control.persistedEventCount;
        index < nextPersistedEventCount;
        index += 1
      ) {
        appendUpdate(
          this.database,
          this.projectId,
          control.commandId,
          "runtime-event",
          "in-flight",
          control.sessionId,
          { event: control.events[index] },
        );
      }
      appendUpdate(
        this.database,
        this.projectId,
        control.commandId,
        "runtime-event",
        "in-flight",
        control.sessionId,
        { event: { kind: "user-message", text: input } },
      );
    });
    control.persistedEventCount = nextPersistedEventCount;
    this.notifyCommittedUpdate();
    return true;
  }

  private publishActiveInterruptCapability(control: ActiveRuntimeControl): void {
    const current = this.readInterruptCapability();
    if (
      !("commandId" in current) ||
      current.commandId !== control.commandId ||
      current.status === control.publishedCapability
    ) {
      return;
    }
    const row = this.database
      .prepare(
        "SELECT status FROM commands WHERE project_id = ? AND command_id = ?",
      )
      .get(this.projectId, control.commandId) as
      | { readonly status: ProjectCommandStatus }
      | undefined;
    if (row?.status !== "in-flight") return;
    appendUpdate(
      this.database,
      this.projectId,
      control.commandId,
      "interrupt-capability",
      "in-flight",
      control.sessionId,
      { capability: current.status },
    );
    control.publishedCapability = current.status;
    this.notifyCommittedUpdate();
  }

  /** Best-effort: a plan that already decided to stop must not wait on this write. */
  recordContinuationStop(commandId: string, stop: SessionContinuationStop): void {
    if (this.closed) return;
    try {
      const row = this.database
        .prepare("SELECT status, target_session_id FROM commands WHERE command_id = ?")
        .get(commandId) as { status: string; target_session_id: string | null } | undefined;
      if (row === undefined) return;
      this.database
        .prepare(
          `INSERT INTO updates (project_id, command_id, kind, status, session_id, data_json)
           VALUES (?, ?, 'continuation-stop', ?, ?, ?)`,
        )
        .run(this.projectId, commandId, row.status, row.target_session_id, JSON.stringify({ stop }));
    } catch {
      // The in-memory report already reached the renderer; only restart visibility is lost.
      return;
    }
    this.notifyCommittedUpdate();
  }

  private continuationStopForCommand(commandId: string): SessionContinuationStop | undefined {
    const row = this.database
      .prepare(
        "SELECT data_json FROM updates WHERE command_id = ? AND kind = 'continuation-stop' ORDER BY cursor DESC LIMIT 1",
      )
      .get(commandId) as { data_json: string | null } | undefined;
    if (row === undefined || row.data_json === null) return undefined;
    const data = JSON.parse(row.data_json) as { stop: unknown };
    if (!isExactDataRecord(data, ["stop"])) throw new Error("invalid-continuation-stop-update");
    const stop = data.stop;
    if (
      !isExactDataRecord(stop, ["step", "limit", "reason"]) ||
      !Number.isSafeInteger(stop.step) ||
      !Number.isSafeInteger(stop.limit) ||
      (stop.step as number) < 1 ||
      (stop.step as number) > (stop.limit as number) ||
      (stop.limit as number) > SESSION_CONTINUATION_MAX_STEPS ||
      (stop.reason !== "turn-not-completed" &&
        stop.reason !== "continuation-unavailable" &&
        stop.reason !== "observation-unavailable" &&
        stop.reason !== "submission-unavailable" &&
        stop.reason !== "interrupted-by-user")
    ) {
      throw new Error("invalid-continuation-stop-update");
    }
    return { step: stop.step as number, limit: stop.limit as number, reason: stop.reason };
  }

  readTurnActivity(): ProjectTurnActivity {
    if (this.closed) return "unknown";
    try {
      const row = this.database
        .prepare(
          `SELECT status
             FROM commands
            WHERE project_id = ?
              AND status IN ('accepted', 'in-flight', 'recovery-required')
            ORDER BY CASE status
                       WHEN 'in-flight' THEN 0
                       WHEN 'accepted' THEN 1
                       ELSE 2
                     END,
                     accepted_cursor
            LIMIT 1`,
        )
        .get(this.projectId) as
        | { readonly status: "accepted" | "in-flight" | "recovery-required" }
        | undefined;
      return row?.status === "recovery-required" ? "unknown" : (row?.status ?? "idle");
    } catch {
      return "unknown";
    }
  }

  async snapshotChanges(after: number): Promise<ProjectSnapshotChanges> {
    this.assertOpen();
    this.refreshQuotaPauses();
    const cursor = currentCursor(this.database, this.projectId);
    if (!Number.isSafeInteger(after) || after < 0 || after > cursor) {
      throw new CoordinatorError("invalid-cursor");
    }
    const rows = this.database.prepare(`
      SELECT command_id, target_session_id, runtime, status, failure_category,
        accepted_cursor, private_envelope_json
      FROM commands WHERE project_id = ? AND command_id IN (
        SELECT command_id FROM updates WHERE project_id = ? AND cursor > ?
      ) ORDER BY accepted_cursor
    `).all(this.projectId, this.projectId, after) as unknown as CommandRow[];
    this.synchronizeRuntimeEventCache(cursor);
    const sessions = this.readSnapshotSessions();
    return {
      projectId: this.projectId, after, cursor,
      commands: rows.map((row) =>
        this.commandSummary(
          row,
          row.target_session_id === null
            ? undefined
            : sessions.get(row.target_session_id),
          this.sessionModelReplyCursors,
          after,
        ),
      ),
      sessions: [...sessions.values()].map((session) =>
        this.projectSessionState(session, this.sessionModelReplyCursors),
      ),
    };
  }

  private projectSessionState(session: SessionRow, replies?: ReadonlyMap<string, number>) {
    const metadata = this.sessionMetadata.project(session);
    return {
      sessionId: session.session_id,
      displayName: metadata.displayName,
      archived: metadata.archived,
      ...(replies?.get(session.session_id) === undefined ? {} : { lastModelReplyCursor: replies.get(session.session_id)! }),
      resumable: !metadata.archived && (session.lifecycle_status === "completed" || this.sessionHasQuotaPause(session.session_id)) &&
        session.opaque_session_reference !== null && session.opaque_session_reference.trim().length > 0 &&
        this.isAccountObservationCurrent(session.account_observation_json) &&
        (this.authGeneration === undefined || this.authGeneration.isSessionNativeResumable(session.auth_context_json)),
    };
  }

  async snapshot(): Promise<ProjectSnapshot> {
    this.assertOpen();
    this.refreshQuotaPauses();
    const cursor = currentCursor(this.database, this.projectId);
    const rows = this.database
      .prepare(
        `SELECT command_id, target_session_id, runtime, status,
                failure_category, accepted_cursor, private_envelope_json
           FROM commands
          WHERE project_id = ?
          ORDER BY accepted_cursor`,
      )
      .all(this.projectId) as unknown as CommandRow[];
    this.synchronizeRuntimeEventCache(cursor);
    const sessions = this.readSnapshotSessions();
    const commands = rows.map((row) =>
      this.commandSummary(
        row,
        row.target_session_id === null
          ? undefined
          : sessions.get(row.target_session_id),
        this.sessionModelReplyCursors,
      ),
    );
    return { projectId: this.projectId, cursor, commands };
  }

  observe(options?: { readonly after?: number }): AsyncIterable<ProjectUpdate> {
    const after = options?.after;
    const state: ObserverState = {
      after,
      createdOpen: !this.closed,
      cursor: 0,
      snapshotPending: after === undefined,
      started: false,
      done: false,
      operationTail: Promise.resolve(),
    };

    const iterator: AsyncIterableIterator<ProjectUpdate> = {
      next: () => {
        if (!state.done && !this.closed) this.observers.add(state);
        const result = state.operationTail.then(async () => {
          try {
            return await this.nextObservation(state);
          } catch (error) {
            this.finishObservation(state);
            if (error instanceof CoordinatorError) throw error;
            throw new CoordinatorError("storage-failed");
          }
        });
        state.operationTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      return: async () => {
        this.finishObservation(state);
        await state.operationTail;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    clearTimeout(this.quotaExpiryTimer);
    for (const observer of [...this.observers]) this.finishObservation(observer);
    // iterator.return() cannot interrupt a generator blocked in receive().
    // Start transport shutdown first, through the production directory binding.
    try {
      this.activeRuntimeControl?.binding.close?.();
    } catch {
      // Shutdown initiation is not an outcome receipt; still drain the iterator.
    }
    const runtimeCancellation =
      this.activeRuntimeIterator === undefined ||
      this.activeRuntimeIterator.terminalObserved
        ? Promise.resolve()
        : this.cancelRuntimeIterator(this.activeRuntimeIterator);
    this.closePromise = this.finishClose(runtimeCancellation);
    return this.closePromise;
  }

  private async finishClose(runtimeCancellation: Promise<void>): Promise<void> {
    await this.acceptanceTail;
    await runtimeCancellation;
    await this.executionTail;
    try {
      this.database.close();
    } catch {
      throw new CoordinatorError("storage-failed");
    }
  }

  private async nextObservation(
    state: ObserverState,
  ): Promise<IteratorResult<ProjectUpdate>> {
    if (state.done) {
      this.finishObservation(state);
      return { done: true, value: undefined };
    }

    if (!state.started) {
      if (!state.createdOpen) this.assertOpen();
      if (this.closed) {
        this.finishObservation(state);
        return { done: true, value: undefined };
      }
      this.assertOpen();
      if (state.after !== undefined) {
        const tail = currentCursor(this.database, this.projectId);
        if (
          !Number.isSafeInteger(state.after) ||
          state.after < 0 ||
          state.after > tail
        ) {
          throw new CoordinatorError("invalid-cursor");
        }
        state.cursor = state.after;
      }
      state.started = true;
    }

    if (this.closed) {
      this.finishObservation(state);
      return { done: true, value: undefined };
    }

    if (state.snapshotPending) {
      const snapshot = await this.snapshot();
      if (state.done || this.closed) return { done: true, value: undefined };
      state.snapshotPending = false;
      state.cursor = snapshot.cursor;
      return {
        done: false,
        value: {
          cursor: snapshot.cursor,
          commandId: null,
          kind: "snapshot",
          status: "snapshot",
          snapshot,
        },
      };
    }

    while (!state.done && !this.closed) {
      const observedGeneration = this.commitGeneration;
      const row = this.database
        .prepare(
          `SELECT cursor, command_id, kind, status, session_id, data_json
             FROM updates
            WHERE project_id = ? AND cursor > ?
            ORDER BY cursor
            LIMIT 1`,
        )
        .get(this.projectId, state.cursor) as UpdateRow | undefined;
      if (row !== undefined) {
        const update = hydrateUpdate(row);
        if (update === undefined) {
          state.cursor = row.cursor;
          continue;
        }
        state.cursor = update.cursor;
        return { done: false, value: update };
      }
      await this.waitForCommittedUpdate(state, observedGeneration);
    }

    this.finishObservation(state);
    return { done: true, value: undefined };
  }

  private waitForCommittedUpdate(
    state: ObserverState,
    observedGeneration: number,
  ): Promise<void> {
    if (
      state.done ||
      this.closed ||
      this.commitGeneration !== observedGeneration
    ) {
      return Promise.resolve();
    }
    if (state.waiter !== undefined) return state.waiter.promise;
    let resolveWaiter!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    state.waiter = { promise, resolve: resolveWaiter };
    return promise;
  }

  private notifyCommittedUpdate(): void {
    this.commitGeneration += 1;
    for (const observer of this.observers) this.wakeObserver(observer);
  }

  private wakeObserver(state: ObserverState): void {
    const waiter = state.waiter;
    if (waiter === undefined) return;
    state.waiter = undefined;
    waiter.resolve();
  }

  private finishObservation(state: ObserverState): void {
    if (!state.done) state.done = true;
    this.wakeObserver(state);
    this.observers.delete(state);
  }

  private commandSummary(
    row: CommandRow,
    session: SessionRow | undefined,
    sessionModelReplies?: ReadonlyMap<string, number>,
    eventsAfter?: number,
  ): ProjectCommandSummary {
    const currentCommand = this.readStoredCommand(
      row.command_id,
      row.private_envelope_json,
    );
    const failureCategory = failedCommandFailureCategory(row);
    const continuationStop = this.continuationStopForCommand(row.command_id);
    const status: ProjectCommandStatus =
      row.status === "failed" && row.failure_category === "quota-paused" && this.quotaDeadline(row.command_id) > Date.now()
        ? "quota-paused" : row.status;
    const quotaPauseResetsAt = status === "quota-paused" ? this.quotaResetsAt(row.command_id) : undefined;
    const summary: ProjectCommandSummary = {
      commandId: row.command_id,
      runtime: row.runtime,
      status,
      ...(row.status === "recovery-required" ? { recovery: this.recoveryForCommand(row.command_id) } : {}),
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(currentCommand === undefined ? {} : { input: currentCommand.input }),
      ...(continuationStop === undefined ? {} : { continuationStop }),
      ...(quotaPauseResetsAt === undefined ? {} : { quotaPauseResetsAt }),
    };
    if (session === undefined) return summary;
    let requestedProfileProjection: RequestedSessionProfileProjection | undefined;
    if (session.root_private_envelope_json !== null) {
      const rootCommand = this.readStoredCommand(
        session.root_command_id,
        session.root_private_envelope_json,
      );
      if (rootCommand === undefined) throw new Error("invalid-command-envelope");
      if (currentCommand?.commandKind === "start") {
        requestedProfileProjection = currentCommand.requestedProfileProjection;
      } else if (
        currentCommand?.commandKind === "continue" &&
        currentCommand.profileProjection !== undefined
      ) {
        requestedProfileProjection = currentCommand.profileProjection.requested;
      } else if (
        rootCommand.commandKind === "start" &&
        (currentCommand === undefined ||
          sameProfile(rootCommand.profile, currentCommand.profile))
      ) {
        requestedProfileProjection = rootCommand.requestedProfileProjection;
      }
    }
    const effectiveProfileProjection =
      requestedProfileProjection === undefined
        ? undefined
        : this.effectiveProjectionForCommand(row.command_id);
    const metadata = this.sessionMetadata.project(session);
    const events =
      eventsAfter === undefined
        ? (this.runtimeEventsByCommandId.get(row.command_id) ?? [])
        : (this.database
            .prepare(
              `SELECT data_json
                 FROM updates
                WHERE command_id = ? AND kind = 'runtime-event' AND cursor > ?
                ORDER BY cursor`,
            )
            .all(row.command_id, eventsAfter) as unknown as Array<{
            data_json: string;
          }>).map(({ data_json }) => {
            const data = JSON.parse(data_json) as {
              event: ProjectRecordedTurnEvent;
            };
            return freezeRecordedTurnEvent(
              hydrateStoredRuntimeEvent(data.event),
            );
          });
    return {
      ...summary,
      session: {
        sessionId: session.session_id,
        displayName: metadata.displayName,
        archived: metadata.archived,
        profile: cloneProfile(
          currentCommand?.profile ?? parseStoredProfile(session.profile_json),
        ),
        ...(requestedProfileProjection === undefined
          ? {}
          : { requestedProfileProjection }),
        ...(effectiveProfileProjection === undefined
          ? {}
          : { effectiveProfileProjection }),
        ...(sessionModelReplies?.get(session.session_id) === undefined
          ? {}
          : {
              lastModelReplyCursor: sessionModelReplies.get(
                session.session_id,
              ),
            }),
        acceptedCommandCursor: row.accepted_cursor,
        resumable:
          !metadata.archived &&
          (session.lifecycle_status === "completed" || this.sessionHasQuotaPause(session.session_id)) &&
          session.opaque_session_reference !== null &&
          session.opaque_session_reference.trim().length > 0 &&
          this.isAccountObservationCurrent(session.account_observation_json) &&
          (this.authGeneration === undefined ||
            this.authGeneration.isSessionNativeResumable(
              session.auth_context_json,
            )),
        events,
      },
    };
  }

  private readSnapshotSessions(): ReadonlyMap<string, SessionRow> {
    const rows = this.database
      .prepare(
        `SELECT sessions.session_id, sessions.root_command_id,
                sessions.profile_json, sessions.opaque_session_reference,
                sessions.lifecycle_status, sessions.auth_context_json,
                sessions.account_observation_json, sessions.display_name,
                sessions.display_name_source, sessions.display_ordinal,
                sessions.archived,
                root.private_envelope_json AS root_private_envelope_json,
                root.accepted_cursor AS root_accepted_cursor
           FROM sessions
           JOIN commands AS root ON root.command_id = sessions.root_command_id
          WHERE sessions.project_id = ?`,
      )
      .all(this.projectId) as unknown as SessionRow[];
    return new Map(rows.map((row) => [row.session_id, row]));
  }

  private readStoredCommand(
    commandId: string,
    source: string | null,
  ): DirectProjectCommand | undefined {
    if (source === null) return undefined;
    const cached = this.storedCommandCache.get(commandId);
    if (cached?.source === source) return cached.command;
    const command = hydrateStoredCommand(source, this.endpointIds);
    this.storedCommandCache.set(commandId, { source, command });
    return command;
  }

  /** Keep complete timelines while reading and hydrating each durable event once. */
  private synchronizeRuntimeEventCache(cursor: number): void {
    if (cursor <= this.runtimeEventCacheCursor) return;
    const rows = this.database
      .prepare(
        `SELECT cursor, command_id, session_id, data_json
           FROM updates
          WHERE cursor > ? AND cursor <= ?
            AND project_id = ?
            AND kind = 'runtime-event'
          ORDER BY cursor`,
      )
      .all(
        this.runtimeEventCacheCursor,
        cursor,
        this.projectId,
      ) as unknown as Array<{
      readonly cursor: number;
      readonly command_id: string;
      readonly session_id: string | null;
      readonly data_json: string;
    }>;
    const additions = new Map<string, ProjectRecordedTurnEvent[]>();
    const replyCursors = new Map<string, number>();
    for (const row of rows) {
      const data = JSON.parse(row.data_json) as {
        event: ProjectRecordedTurnEvent;
      };
      const event = freezeRecordedTurnEvent(
        hydrateStoredRuntimeEvent(data.event),
      );
      if (event.kind === "agent-message") {
        if (row.session_id === null) throw new Error("invalid-runtime-update");
        replyCursors.set(row.session_id, Number(row.cursor));
      }
      const commandEvents = additions.get(row.command_id);
      if (commandEvents === undefined) {
        additions.set(row.command_id, [event]);
      } else {
        commandEvents.push(event);
      }
    }
    for (const [commandId, events] of additions) {
      this.runtimeEventsByCommandId.set(
        commandId,
        Object.freeze([
          ...(this.runtimeEventsByCommandId.get(commandId) ?? []),
          ...events,
        ]),
      );
    }
    for (const [sessionId, replyCursor] of replyCursors) {
      this.sessionModelReplyCursors.set(sessionId, replyCursor);
    }
    this.runtimeEventCacheCursor = cursor;
  }

  private recoveryForCommand(commandId: string): ProjectCommandRecovery {
    const row = this.database.prepare(
      "SELECT data_json FROM updates WHERE command_id = ? AND kind = 'recovery-required' ORDER BY cursor DESC LIMIT 1",
    ).get(commandId) as { data_json: string | null } | undefined;
    // Old records did not measure resume. Do not invent a Runtime refusal.
    if (row?.data_json == null) return { resume: "unconfirmed", reason: "resume-unconfirmed" };
    const data = JSON.parse(row.data_json) as { recovery: ProjectCommandRecovery };
    if (!isExactDataRecord(data, ["recovery"])) throw new Error("invalid-recovery-update");
    const recovery = data.recovery;
    if (isExactDataRecord(recovery, ["resume"]) && recovery.resume === "confirmed") return { resume: "confirmed" };
    if (isExactDataRecord(recovery, ["resume", "reason"]) && recovery.resume === "unconfirmed" &&
      (runtimeFailureCategories.has(recovery.reason) || ["runtime-not-located", "binding-drift",
        "session-reference-unavailable", "authentication-changed", "channel-closed", "resume-timeout", "resume-unconfirmed"].includes(recovery.reason))) {
      return { resume: "unconfirmed", reason: recovery.reason };
    }
    throw new Error("invalid-recovery-update");
  }

  private effectiveProjectionForCommand(
    commandId: string,
  ): EffectiveSessionProfileProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT kind, data_json
           FROM updates
          WHERE command_id = ? AND kind IN ('completed', 'failed')
          ORDER BY cursor DESC
          LIMIT 1`,
      )
      .get(commandId) as
      | { kind: "completed" | "failed"; data_json: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : effectiveProjectionFromTerminalData(row.kind, row.data_json);
  }

  private assertOpen(): void {
    if (this.closed) throw new CoordinatorError("channel-closed");
  }

  private recordFailure(
    commandId: string,
    failureCategory: ProjectCommandFailureCategory,
    runtimeFailureCategory?: RuntimeFailureCategory,
  ): void {
    const failed = transaction(this.database, () => {
      const row = this.database
        .prepare("SELECT target_session_id FROM commands WHERE command_id = ?")
        .get(commandId) as { target_session_id: string | null } | undefined;
      const result = this.database
        .prepare(
          `UPDATE commands
              SET status = 'failed', failure_category = ?,
                  effect_phase = 'committed', outcome_uncertain = 0
            WHERE command_id = ? AND status = 'in-flight' AND outcome_uncertain = 0`,
        )
        .run(failureCategory, commandId);
      if (Number(result.changes) === 0) return false;
      this.database
        .prepare(
          `UPDATE sessions
              SET lifecycle_status = 'failed'
            WHERE session_id = (
              SELECT target_session_id FROM commands WHERE command_id = ?
            )`,
        )
        .run(commandId);
      if (
        runtimeFailureCategory !== undefined &&
        typeof row?.target_session_id === "string"
      ) {
        appendUpdate(
          this.database,
          this.projectId,
          commandId,
          "runtime-event",
          "in-flight",
          row.target_session_id,
          { event: { kind: "failed", category: runtimeFailureCategory } },
        );
      }
      appendUpdate(
        this.database,
        this.projectId,
        commandId,
        "failed",
        "failed",
        row?.target_session_id ?? undefined,
        { failureCategory },
      );
      return true;
    });
    if (failed) this.notifyCommittedUpdate();
  }

  private isInFlight(commandId: string): boolean {
    const row = this.database
      .prepare("SELECT status FROM commands WHERE command_id = ?")
      .get(commandId) as { status: ProjectCommandStatus } | undefined;
    return row?.status === "in-flight";
  }
}

function createPromiseController<T>(): PromiseController<T> {
  let resolveController!: (value: T) => void;
  let rejectController!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveController = resolve;
    rejectController = reject;
  });
  return {
    promise,
    resolve: resolveController,
    reject: rejectController,
  };
}

const currentSchemaVersion = 6;
const quotaPauseMaximumMs = 24 * 60 * 60 * 1000;
const maximumQuotaResetsAtMs = 8_640_000_000_000;

function isValidQuotaResetsAt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximumQuotaResetsAtMs;
}

/** `resetsAt` is optional: written only when a provider reset instant was observed. */
function readQuotaPauseData(dataJson: string): { expiresAt: number; resetsAt?: number } {
  const value: unknown = JSON.parse(dataJson);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expiresAt", "resetsAt"]) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0 ||
    (hasOwn(value, "resetsAt") && !isValidQuotaResetsAt(value.resetsAt))
  ) {
    throw new Error("invalid-quota-pause");
  }
  return {
    expiresAt: value.expiresAt as number,
    ...(hasOwn(value, "resetsAt") ? { resetsAt: value.resetsAt as number } : {}),
  };
}

function readQuotaDeadline(dataJson: string): number {
  return readQuotaPauseData(dataJson).expiresAt;
}

function readQuotaResetsAt(dataJson: string): number | undefined {
  return readQuotaPauseData(dataJson).resetsAt;
}
const conceptualTables = ["commands", "projects", "sessions", "updates"] as const;
const versionOneColumns = Object.freeze({
  projects: ["project_id", "directory_digest"],
  commands: [
    "command_id",
    "project_id",
    "idempotency_digest",
    "payload_digest",
    "runtime",
    "status",
    "failure_category",
    "accepted_cursor",
  ],
  sessions: ["session_id", "command_id", "profile_json"],
  updates: [
    "cursor",
    "project_id",
    "command_id",
    "kind",
    "status",
    "session_id",
    "data_json",
  ],
});
const versionTwoColumns = Object.freeze({
  projects: ["project_id", "directory_digest"],
  commands: [
    "command_id",
    "project_id",
    "idempotency_digest",
    "payload_digest",
    "digest_version",
    "command_kind",
    "target_session_id",
    "runtime",
    "status",
    "failure_category",
    "accepted_cursor",
    "private_envelope_json",
    "effect_phase",
    "outcome_uncertain",
  ],
  sessions: [
    "session_id",
    "project_id",
    "root_command_id",
    "profile_json",
    "opaque_session_reference",
    "lifecycle_status",
  ],
  updates: versionOneColumns.updates,
});
const versionThreeColumns = Object.freeze({
  ...versionTwoColumns,
  commands: [...versionTwoColumns.commands, "auth_context_json"],
  sessions: [...versionTwoColumns.sessions, "auth_context_json"],
});
const versionFourColumns = Object.freeze({
  ...versionThreeColumns,
  sessions: [
    ...versionThreeColumns.sessions,
    "display_name",
    "display_name_source",
    "archived",
  ],
});
const versionFiveColumns = Object.freeze({
  ...versionFourColumns,
  sessions: [...versionFourColumns.sessions, "account_observation_json"],
});
const versionSixColumns = Object.freeze({
  ...versionFiveColumns,
  sessions: [...versionFiveColumns.sessions, "display_ordinal"],
});

function initializeSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  const version = readSchemaVersion(database);
  const tables = readConceptualTables(database);
  if (version === currentSchemaVersion) {
    assertSchema(database, versionSixColumns);
    assertVersionTwoRows(database);
    assertVersionFiveRows(database);
    assertVersionSixRows(database);
    return;
  }
  if (version === 0 && tables.length === 0) {
    transaction(database, () => {
      createVersionSixTables(database);
      database.exec(`PRAGMA user_version = ${currentSchemaVersion}`);
    });
    assertSchema(database, versionSixColumns);
    assertVersionSixRows(database);
    return;
  }
  if ((version === 0 || version === 1) && sameStrings(tables, conceptualTables)) {
    assertSchema(database, versionOneColumns);
    migrateVersionOne(database);
    assertSchema(database, versionTwoColumns);
    assertVersionTwoRows(database);
    migrateVersionTwo(database);
    assertSchema(database, versionThreeColumns);
    assertVersionTwoRows(database);
    migrateVersionThree(database);
    assertSchema(database, versionFourColumns);
    assertVersionTwoRows(database);
    migrateVersionFour(database);
    migrateVersionFiveAndAssert(database);
    return;
  }
  if (version === 2 && sameStrings(tables, conceptualTables)) {
    assertSchema(database, versionTwoColumns);
    assertVersionTwoRows(database);
    migrateVersionTwo(database);
    assertSchema(database, versionThreeColumns);
    assertVersionTwoRows(database);
    migrateVersionThree(database);
    assertSchema(database, versionFourColumns);
    assertVersionTwoRows(database);
    migrateVersionFour(database);
    migrateVersionFiveAndAssert(database);
    return;
  }
  if (version === 3 && sameStrings(tables, conceptualTables)) {
    assertSchema(database, versionThreeColumns);
    assertVersionTwoRows(database);
    migrateVersionThree(database);
    assertSchema(database, versionFourColumns);
    assertVersionTwoRows(database);
    migrateVersionFour(database);
    migrateVersionFiveAndAssert(database);
    return;
  }
  if (version === 4 && sameStrings(tables, conceptualTables)) {
    assertSchema(database, versionFourColumns);
    assertVersionTwoRows(database);
    migrateVersionFour(database);
    migrateVersionFiveAndAssert(database);
    return;
  }
  if (version === 5 && sameStrings(tables, conceptualTables)) {
    migrateVersionFiveAndAssert(database);
    return;
  }
  throw new CoordinatorError("storage-failed");
}

function migrateVersionFiveAndAssert(database: DatabaseSync): void {
  assertSchema(database, versionFiveColumns);
  assertVersionTwoRows(database);
  assertVersionFiveRows(database);
  migrateVersionFive(database);
  assertSchema(database, versionSixColumns);
  assertVersionTwoRows(database);
  assertVersionFiveRows(database);
  assertVersionSixRows(database);
}

function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return Number(row.user_version);
}

function readConceptualTables(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT name
           FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
}

function assertSchema(
  database: DatabaseSync,
  expected: Readonly<Record<(typeof conceptualTables)[number], readonly string[]>>,
): void {
  const tables = readConceptualTables(database);
  if (!sameStrings(tables, conceptualTables)) {
    throw new CoordinatorError("storage-failed");
  }
  for (const table of conceptualTables) {
    const tableRecord = database
      .prepare(
        "SELECT ncol, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?",
      )
      .get(table) as { ncol: number; strict: number } | undefined;
    if (
      tableRecord === undefined ||
      Number(tableRecord.strict) !== 1 ||
      Number(tableRecord.ncol) !== expected[table].length
    ) {
      throw new CoordinatorError("storage-failed");
    }
    const columns = (
      database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    if (!sameStrings(columns, expected[table])) {
      throw new CoordinatorError("storage-failed");
    }
  }
  const version =
    expected === versionOneColumns
      ? 1
      : expected === versionTwoColumns
        ? 2
        : expected === versionThreeColumns
          ? 3
          : expected === versionFourColumns
            ? 4
            : expected === versionFiveColumns
              ? 5
              : 6;
  assertForeignKeyShape(database, version);
  assertUniqueShape(database, version);
  if (version !== 1) assertVersionTwoConstraints(database);
  if (version >= 4) assertVersionFourConstraints(database, version);
}

function assertForeignKeyShape(
  database: DatabaseSync,
  version: 1 | 2 | 3 | 4 | 5 | 6,
): void {
  const expected = {
    projects: [],
    commands: ["project_id->projects.project_id"],
    sessions:
      version === 1
        ? ["command_id->commands.command_id"]
        : [
            "project_id->projects.project_id",
            "root_command_id->commands.command_id",
          ],
    updates: [
      "command_id->commands.command_id",
      "project_id->projects.project_id",
    ],
  } as const;
  for (const table of conceptualTables) {
    const actual = (
      database.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as Array<{
        from: string;
        table: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>
    )
      .map((row) => {
        if (row.on_update !== "NO ACTION" || row.on_delete !== "NO ACTION") {
          throw new CoordinatorError("storage-failed");
        }
        return `${row.from}->${row.table}.${row.to}`;
      })
      .sort();
    if (!sameStrings(actual, [...expected[table]].sort())) {
      throw new CoordinatorError("storage-failed");
    }
  }
}

function assertUniqueShape(
  database: DatabaseSync,
  version: 1 | 2 | 3 | 4 | 5 | 6,
): void {
  const expected = {
    projects: ["directory_digest", "project_id"],
    commands: ["command_id", "project_id,idempotency_digest"],
    sessions:
      version === 1
        ? ["command_id", "session_id"]
        : version === 6
          ? ["project_id,display_ordinal", "root_command_id", "session_id"]
          : ["root_command_id", "session_id"],
    updates: [],
  } as const;
  for (const table of conceptualTables) {
    const indexes = database
      .prepare(`PRAGMA index_list(${table})`)
      .all() as unknown as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const actual = indexes
      .filter((index) => Number(index.unique) === 1 && Number(index.partial) === 0)
      .map((index) =>
        (
          database.prepare(`PRAGMA index_info(${index.name})`).all() as unknown as Array<{
            seqno: number;
            name: string;
          }>
        )
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((column) => column.name)
          .join(","),
      )
      .sort();
    if (!sameStrings(actual, [...expected[table]].sort())) {
      throw new CoordinatorError("storage-failed");
    }
  }
}

function assertVersionTwoConstraints(database: DatabaseSync): void {
  const sqlFor = (table: string): string => {
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    if (row === undefined) throw new CoordinatorError("storage-failed");
    return row.sql.toLowerCase().replace(/\s+/gu, "");
  };
  const commands = sqlFor("commands");
  const sessions = sqlFor("sessions");
  const updates = sqlFor("updates");
  const requiredCommandFragments = [
    "check(digest_versionin(1,2))",
    "check(command_kindin('start','continue'))",
    "check(runtime='codex')",
    "check(statusin('accepted','in-flight','completed','failed','recovery-required'))",
    "check(accepted_cursor>=0)",
    "check(effect_phasein('legacy','unclaimed','binding-claimed','binding-ready','send-claimed','awaiting-terminal','committed'))",
    "check(outcome_uncertainin(0,1))",
  ];
  if (
    requiredCommandFragments.some((fragment) => !commands.includes(fragment)) ||
    !sessions.includes(
      "check(lifecycle_statusin('accepted','in-flight','completed','failed','recovery-required'))",
    ) ||
    !updates.includes("autoincrement")
  ) {
    throw new CoordinatorError("storage-failed");
  }
}

function assertVersionFourConstraints(
  database: DatabaseSync,
  version: number,
): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { readonly sql: string } | undefined;
  const sessions = row?.sql.toLowerCase().replace(/\s+/gu, "") ?? "";
  const displayNameSourceConstraint =
    "check(display_name_sourceisnullordisplay_name_sourcein('default','manual'))";
  if (
    !sessions.includes(displayNameSourceConstraint) ||
    !sessions.includes("check(archivedin(0,1))") ||
    !sessions.includes("archivedintegernotnulldefault0") ||
    (version === 6 &&
      (!sessions.includes("display_ordinalintegernotnull") ||
        !sessions.includes("check(display_ordinal>0)")))
  ) {
    throw new CoordinatorError("storage-failed");
  }
}

function sameStrings(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function createVersionTwoTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      directory_digest TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      idempotency_digest TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      digest_version INTEGER NOT NULL CHECK (digest_version IN (1, 2)),
      command_kind TEXT NOT NULL CHECK (command_kind IN ('start', 'continue')),
      target_session_id TEXT,
      runtime TEXT NOT NULL CHECK (runtime = 'codex'),
      status TEXT NOT NULL CHECK (
        status IN ('accepted', 'in-flight', 'completed', 'failed', 'recovery-required')
      ),
      failure_category TEXT,
      accepted_cursor INTEGER NOT NULL CHECK (accepted_cursor >= 0),
      private_envelope_json TEXT,
      effect_phase TEXT NOT NULL CHECK (
        effect_phase IN (
          'legacy', 'unclaimed', 'binding-claimed', 'binding-ready',
          'send-claimed', 'awaiting-terminal', 'committed'
        )
      ),
      outcome_uncertain INTEGER NOT NULL CHECK (outcome_uncertain IN (0, 1)),
      UNIQUE(project_id, idempotency_digest)
    ) STRICT;
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      root_command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
      profile_json TEXT NOT NULL,
      opaque_session_reference TEXT,
      lifecycle_status TEXT NOT NULL CHECK (
        lifecycle_status IN (
          'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
        )
      )
    ) STRICT;
    CREATE TABLE updates (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      command_id TEXT NOT NULL REFERENCES commands(command_id),
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      data_json TEXT
    ) STRICT;
  `);
}

function createVersionThreeTables(database: DatabaseSync): void {
  createVersionTwoTables(database);
  database.exec(`
    ALTER TABLE commands ADD COLUMN auth_context_json TEXT;
    ALTER TABLE sessions ADD COLUMN auth_context_json TEXT;
  `);
}

function createVersionFourTables(database: DatabaseSync): void {
  createVersionThreeTables(database);
  addVersionFourSessionMetadataColumns(database);
}

function createVersionFiveTables(database: DatabaseSync): void {
  createVersionFourTables(database);
  addVersionFiveAccountObservationColumn(database);
}

function createVersionSixTables(database: DatabaseSync): void {
  createVersionFiveTables(database);
  replaceVersionFiveSessionsTable(database);
}

function migrateVersionTwo(database: DatabaseSync): void {
  transaction(database, () => {
    database.exec(`
      ALTER TABLE commands ADD COLUMN auth_context_json TEXT;
      ALTER TABLE sessions ADD COLUMN auth_context_json TEXT;
      PRAGMA user_version = 3;
    `);
  });
}

function migrateVersionThree(database: DatabaseSync): void {
  transaction(database, () => {
    addVersionFourSessionMetadataColumns(database);
    database.exec("PRAGMA user_version = 4");
  });
}

function addVersionFourSessionMetadataColumns(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE sessions ADD COLUMN display_name TEXT;
    ALTER TABLE sessions ADD COLUMN display_name_source TEXT
      CHECK (
        display_name_source IS NULL OR
        display_name_source IN ('default', 'manual')
      );
    ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
      CHECK (archived IN (0, 1));
  `);
}

/**
 * Records which observed provider sign-in a Session was started under. Every
 * pre-existing row migrates to NULL, which means "no observation was recorded"
 * and never refuses a resume on its own.
 */
function addVersionFiveAccountObservationColumn(database: DatabaseSync): void {
  database.exec("ALTER TABLE sessions ADD COLUMN account_observation_json TEXT");
}

function migrateVersionFour(database: DatabaseSync): void {
  transaction(database, () => {
    addVersionFiveAccountObservationColumn(database);
    database.exec("PRAGMA user_version = 5");
  });
}

function migrateVersionFive(database: DatabaseSync): void {
  transaction(database, () => {
    replaceVersionFiveSessionsTable(database);
    database.exec("PRAGMA user_version = 6");
  });
}

function replaceVersionFiveSessionsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE migration_sessions_v6 (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      root_command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
      profile_json TEXT NOT NULL,
      opaque_session_reference TEXT,
      lifecycle_status TEXT NOT NULL CHECK (
        lifecycle_status IN (
          'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
        )
      ),
      auth_context_json TEXT,
      display_name TEXT,
      display_name_source TEXT CHECK (
        display_name_source IS NULL OR
        display_name_source IN ('default', 'manual')
      ),
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      account_observation_json TEXT,
      display_ordinal INTEGER NOT NULL CHECK (display_ordinal > 0)
    ) STRICT;

    INSERT INTO migration_sessions_v6 (
      session_id, project_id, root_command_id, profile_json,
      opaque_session_reference, lifecycle_status, auth_context_json,
      display_name, display_name_source, archived,
      account_observation_json, display_ordinal
    )
    SELECT session.session_id, session.project_id, session.root_command_id,
           session.profile_json, session.opaque_session_reference,
           session.lifecycle_status, session.auth_context_json,
           session.display_name, session.display_name_source,
           session.archived, session.account_observation_json,
           ROW_NUMBER() OVER (
             PARTITION BY session.project_id
             ORDER BY root.accepted_cursor, session.session_id
           )
      FROM sessions AS session
      JOIN commands AS root ON root.command_id = session.root_command_id;

    DROP TABLE sessions;
    ALTER TABLE migration_sessions_v6 RENAME TO sessions;
    CREATE UNIQUE INDEX sessions_project_display_ordinal_unique
      ON sessions(project_id, display_ordinal);
  `);
}

function migrateVersionOne(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    transaction(database, () => {
      database.exec(`
        ALTER TABLE updates RENAME TO migration_updates_v1;
        ALTER TABLE sessions RENAME TO migration_sessions_v1;
        ALTER TABLE commands RENAME TO migration_commands_v1;
        ALTER TABLE projects RENAME TO migration_projects_v1;
      `);
      createVersionTwoTables(database);
      database.exec(`
        INSERT INTO projects (project_id, directory_digest)
        SELECT project_id, directory_digest
          FROM migration_projects_v1;

        INSERT INTO commands (
          command_id, project_id, idempotency_digest, payload_digest,
          digest_version, command_kind, target_session_id, runtime, status,
          failure_category, accepted_cursor, private_envelope_json,
          effect_phase, outcome_uncertain
        )
        SELECT command_id, project_id, idempotency_digest, payload_digest,
               1, 'start', NULL, runtime, status, failure_category,
               accepted_cursor, NULL, 'legacy', 0
          FROM migration_commands_v1;

        INSERT INTO sessions (
          session_id, project_id, root_command_id, profile_json,
          opaque_session_reference, lifecycle_status
        )
        SELECT session.session_id, command.project_id, session.command_id,
               session.profile_json, NULL, command.status
          FROM migration_sessions_v1 AS session
          JOIN migration_commands_v1 AS command
            ON command.command_id = session.command_id;

        UPDATE commands
           SET target_session_id = (
             SELECT session_id
               FROM sessions
              WHERE root_command_id = commands.command_id
           );

        INSERT INTO updates (
          cursor, project_id, command_id, kind, status, session_id, data_json
        )
        SELECT cursor, project_id, command_id, kind, status, session_id, data_json
          FROM migration_updates_v1
         ORDER BY cursor;

        DROP TABLE migration_updates_v1;
        DROP TABLE migration_sessions_v1;
        DROP TABLE migration_commands_v1;
        DROP TABLE migration_projects_v1;
        PRAGMA user_version = 2;
      `);
      const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyRows.length !== 0) {
        throw new CoordinatorError("storage-failed");
      }
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function assertVersionTwoRows(database: DatabaseSync): void {
  const projectCount = database
    .prepare("SELECT COUNT(*) AS count FROM projects")
    .get() as { count: number };
  if (Number(projectCount.count) > 1) {
    throw new CoordinatorError("storage-failed");
  }
  const invalidCommand = database
    .prepare(
      `SELECT 1
         FROM commands
        WHERE runtime <> 'codex'
           OR digest_version NOT IN (1, 2)
           OR command_kind NOT IN ('start', 'continue')
           OR status NOT IN (
             'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
           )
           OR outcome_uncertain NOT IN (0, 1)
           OR (digest_version = 1 AND effect_phase <> 'legacy')
           OR (digest_version = 2 AND (
             private_envelope_json IS NULL OR trim(private_envelope_json) = ''
             OR target_session_id IS NULL OR effect_phase = 'legacy'
           ))
        LIMIT 1`,
    )
    .get();
  if (invalidCommand !== undefined) throw new CoordinatorError("storage-failed");
  const invalidSession = database
    .prepare(
      `SELECT 1
         FROM sessions
        WHERE lifecycle_status NOT IN (
          'accepted', 'in-flight', 'completed', 'failed', 'recovery-required'
        )
           OR trim(profile_json) = ''
           OR (opaque_session_reference IS NOT NULL AND trim(opaque_session_reference) = '')
        LIMIT 1`,
    )
    .get();
  if (invalidSession !== undefined) throw new CoordinatorError("storage-failed");
  const invalidLink = database
    .prepare(
      `SELECT 1
         FROM commands AS command
         LEFT JOIN sessions AS session
           ON session.session_id = command.target_session_id
          AND session.project_id = command.project_id
        WHERE command.digest_version = 2
          AND (
            session.session_id IS NULL
            OR (command.command_kind = 'start'
                AND session.root_command_id <> command.command_id)
            OR (command.command_kind = 'continue'
                AND session.root_command_id = command.command_id)
            OR command.accepted_cursor <= 0
            OR NOT EXISTS (
              SELECT 1
                FROM updates AS accepted
               WHERE accepted.cursor = command.accepted_cursor
                 AND accepted.project_id = command.project_id
                 AND accepted.command_id = command.command_id
                 AND accepted.kind = 'accepted'
                 AND accepted.status = 'accepted'
            )
          )
        LIMIT 1`,
    )
    .get();
  if (invalidLink !== undefined) throw new CoordinatorError("storage-failed");
  const versionTwoCommands = database
    .prepare(
      `SELECT command_id, idempotency_digest, payload_digest, command_kind,
              target_session_id, private_envelope_json
         FROM commands
        WHERE digest_version = 2`,
    )
    .all() as unknown as Array<{
      command_id: string;
      idempotency_digest: string;
      payload_digest: string;
      command_kind: CommandKind;
      target_session_id: string;
      private_envelope_json: string;
    }>;
  try {
    for (const row of versionTwoCommands) {
      // Historical envelopes are validated against every endpoint id the
      // ledger format has ever admitted, not the caller's injected roster:
      // a reopen must trust rows this or any earlier roster accepted.
      const command = hydrateStoredCommand(
        row.private_envelope_json,
        allDurableRuntimeEndpointIds,
      );
      if (
        command.commandKind !== row.command_kind ||
        (command.commandKind === "continue" &&
          command.targetSessionId !== row.target_session_id) ||
        digest(command.idempotencyKey) !== row.idempotency_digest ||
        digest(canonicalCommandPayload(command)) !== row.payload_digest
      ) {
        throw new Error("invalid-command-envelope");
      }
    }
    const profiles = database
      .prepare("SELECT profile_json FROM sessions")
      .all() as unknown as Array<{ profile_json: string }>;
    for (const row of profiles) parseStoredProfile(row.profile_json);
    const updates = database
      .prepare(
        "SELECT cursor, command_id, kind, status, session_id, data_json FROM updates ORDER BY cursor",
      )
      .all() as unknown as UpdateRow[];
    for (const row of updates) hydrateUpdate(row);
  } catch {
    throw new CoordinatorError("storage-failed");
  }
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length !== 0) throw new CoordinatorError("storage-failed");
}

/**
 * Exact-shape ROW assertion for the version-five account-observation stamp. It
 * runs on every open, so a stamp that is not the one canonical encoding, or
 * whose endpoint contradicts the Session's own durable authentication context,
 * fails the open closed instead of silently authorizing a replay. NULL is the
 * legal migrated value for every pre-existing row and always passes.
 */
function assertVersionFiveRows(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT account_observation_json, auth_context_json
         FROM sessions
        WHERE account_observation_json IS NOT NULL`,
    )
    .all() as unknown as Array<{
      account_observation_json: string;
      auth_context_json: string | null;
    }>;
  for (const row of rows) {
    const observation = parseDurableAccountObservation(
      row.account_observation_json,
    );
    if (observation === undefined) throw new CoordinatorError("storage-failed");
    const context = parseDurableAuthenticationContext(row.auth_context_json);
    if (context !== undefined && context.endpointId !== observation.endpointId) {
      throw new CoordinatorError("storage-failed");
    }
  }
}

function assertVersionSixRows(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT project_id, display_ordinal
         FROM sessions
        ORDER BY project_id, display_ordinal`,
    )
    .all() as unknown as Array<{
    readonly project_id: string;
    readonly display_ordinal: number;
  }>;
  const seen = new Set<string>();
  for (const row of rows) {
    const ordinal = Number(row.display_ordinal);
    const key = `${row.project_id}\u0000${ordinal}`;
    if (
      typeof row.project_id !== "string" ||
      row.project_id.length === 0 ||
      !Number.isSafeInteger(ordinal) ||
      ordinal <= 0 ||
      seen.has(key)
    ) {
      throw new CoordinatorError("storage-failed");
    }
    seen.add(key);
  }
}

function bindProject(database: DatabaseSync, directory: string): string {
  const resolvedDirectory = resolve(directory);
  const directoryDigest = digest(
    process.platform === "win32" ? resolvedDirectory.toLowerCase() : resolvedDirectory,
  );
  const existing = database
    .prepare("SELECT project_id, directory_digest FROM projects LIMIT 1")
    .get() as { project_id: string; directory_digest: string } | undefined;
  if (existing !== undefined) {
    if (existing.directory_digest !== directoryDigest) {
      throw new CoordinatorError("project-mismatch");
    }
    return existing.project_id;
  }
  const projectId = randomUUID();
  database
    .prepare("INSERT INTO projects (project_id, directory_digest) VALUES (?, ?)")
    .run(projectId, directoryDigest);
  return projectId;
}

function recoverInterruptedCommands(database: DatabaseSync, projectId: string): void {
  const rows = database
    .prepare(
      `SELECT command_id, target_session_id, effect_phase, outcome_uncertain
         FROM commands
        WHERE project_id = ?
          AND digest_version = 2
          AND status IN ('accepted', 'in-flight')
        ORDER BY accepted_cursor`,
    )
    .all(projectId) as unknown as Array<{
      command_id: string;
      target_session_id: string | null;
      effect_phase: EffectPhase;
      outcome_uncertain: number;
    }>;
  const uncertain = rows.filter(
    (row) =>
      Number(row.outcome_uncertain) === 1 ||
      ["binding-claimed", "send-claimed", "awaiting-terminal"].includes(
        row.effect_phase,
      ),
  );
  if (uncertain.length === 0) return;
  transaction(database, () => {
    for (const row of uncertain) {
      // failure_category is preserved: a reason recorded at the throw site
      // (F223) must survive the startup sweep instead of being reset to NULL.
      database
        .prepare(
          `UPDATE commands
              SET status = 'recovery-required',
                  outcome_uncertain = 1
            WHERE command_id = ?`,
        )
        .run(row.command_id);
      if (row.target_session_id !== null) {
        database
          .prepare(
            "UPDATE sessions SET lifecycle_status = 'recovery-required' WHERE session_id = ?",
          )
          .run(row.target_session_id);
      }
      appendUpdate(
        database,
        projectId,
        row.command_id,
        "recovery-required",
        "recovery-required",
        row.target_session_id ?? undefined,
      );
    }
  });
}

/**
 * Names the reason a command is being parked at `recovery-required` (F223).
 * Only two shapes carry one: an adapter error's category, and the
 * coordinator's own `binding-drift` invariant. Anything else stays NULL —
 * an unnamed reason is preferable to a wrong one.
 */
function recoveryFailureCategory(
  error: unknown,
): ProjectRecoveryFailureCategory | undefined {
  if (error instanceof RuntimeAdapterError) return error.category;
  if (error instanceof Error && error.message === "binding-drift") {
    return "binding-drift";
  }
  return undefined;
}

/** Exact failures from the post-acceptance catalog re-check; absence stays unknown. */
function executionInspectionFailureCategory(
  error: unknown,
): RuntimeFailureCategory | undefined {
  return error instanceof RuntimeAdapterError &&
    (error.category === "runtime-not-located" ||
      error.category === "authentication-required")
    ? error.category
    : undefined;
}

/**
 * The snapshot summary carries a failureCategory only for `failed` commands
 * and only from the closed `failed` vocabulary — the contract every summary
 * consumer validates against. The recovery reason (F223) lives in the durable
 * column alone and never widens this surface.
 */
function failedCommandFailureCategory(
  row: Pick<CommandRow, "status" | "failure_category">,
): ProjectCommandFailureCategory | undefined {
  if (row.status !== "failed" || row.failure_category === null) return undefined;
  return row.failure_category === "profile-resolution-failed" ||
    row.failure_category === "runtime-failed" ||
    row.failure_category === "quota-expired" ||
    row.failure_category === "interrupted"
    ? row.failure_category
    : undefined;
}

function appendUpdate(
  database: DatabaseSync,
  projectId: string,
  commandId: string,
  kind: DurableProjectUpdate["kind"],
  status: ProjectCommandStatus,
  sessionId?: string,
  data?: unknown,
): number {
  const result = database
    .prepare(
      `INSERT INTO updates (
         project_id, command_id, kind, status, session_id, data_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      commandId,
      kind,
      status,
      sessionId ?? null,
      data === undefined ? null : JSON.stringify(data),
    );
  return Number(result.lastInsertRowid);
}

function nextAvailableSessionDisplayOrdinal(
  database: DatabaseSync,
  projectId: string,
): number {
  const rows = database
    .prepare(
      `SELECT display_ordinal
         FROM sessions
        WHERE project_id = ?
        ORDER BY display_ordinal`,
    )
    .all(projectId) as unknown as Array<{ readonly display_ordinal: number }>;
  let candidate = 1;
  for (const row of rows) {
    const ordinal = Number(row.display_ordinal);
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
      throw new CoordinatorError("storage-failed");
    }
    if (ordinal === candidate) {
      if (candidate === Number.MAX_SAFE_INTEGER) {
        throw new CoordinatorError("storage-failed");
      }
      candidate += 1;
    } else if (ordinal > candidate) {
      break;
    }
  }
  return candidate;
}

function currentCursor(database: DatabaseSync, projectId: string): number {
  const row = database
    .prepare(
      `SELECT MAX(
         COALESCE((SELECT MAX(cursor) FROM updates WHERE project_id = ?), 0),
         COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'updates'), 0)
       ) AS cursor`,
    )
    .get(projectId) as { cursor: number };
  return Number(row.cursor);
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function validateCommand(
  command: DirectProjectCommand,
  endpointIds: readonly DurableRuntimeEndpointId[],
): void {
  if (
    !isRecord(command) ||
    command.kind !== "direct" ||
    command.runtime !== "codex" ||
    typeof command.idempotencyKey !== "string" ||
    command.idempotencyKey.trim().length === 0 ||
    typeof command.input !== "string" ||
    command.input.trim().length === 0 ||
    !isStoredProfile(command.profile)
  ) {
    throw new CoordinatorError("invalid-command");
  }
  const hasRuntimeResumeIdentity = hasOwn(command, "runtimeResumeIdentity");
  if (
    hasRuntimeResumeIdentity &&
    !isRuntimeResumeIdentity(
      command.runtimeResumeIdentity,
      command.profile,
      endpointIds,
    )
  ) {
    throw new CoordinatorError("invalid-command");
  }
  const commonKeys = [
    "commandKind",
    "idempotencyKey",
    "input",
    "kind",
    "profile",
    "runtime",
    ...(hasRuntimeResumeIdentity ? ["runtimeResumeIdentity"] : []),
  ];
  if (command.commandKind === "start") {
    if (
      typeof command.catalogRevision !== "string" ||
      command.catalogRevision.trim().length === 0 ||
      !isRecord(command.preferences) ||
      !hasOnlyKeys(command, [
        ...commonKeys,
        "catalogRevision",
        "overrides",
        "preferences",
        "requestedProfileProjection",
      ])
    ) {
      throw new CoordinatorError("invalid-command");
    }
    if (command.requestedProfileProjection !== undefined) {
      cloneRequestedSessionProfileProjection(command.requestedProfileProjection);
    }
    return;
  }
  if (
    command.commandKind !== "continue" ||
    typeof command.targetSessionId !== "string" ||
    command.targetSessionId.trim().length === 0 ||
    !hasOnlyKeys(command, [...commonKeys, "profileProjection", "targetSessionId"])
  ) {
    throw new CoordinatorError("invalid-command");
  }
  if (hasOwn(command, "profileProjection")) {
    if (
      !isRecord(command.profileProjection) ||
      !hasExactKeys(command.profileProjection, ["requested", "version"]) ||
      command.profileProjection.version !== 1
    ) {
      throw new CoordinatorError("invalid-command");
    }
    cloneRequestedSessionProfileProjection(command.profileProjection.requested);
  }
}

function validateContinuationProfileRequest(
  request: ProjectContinuationProfileRequest,
): ProjectContinuationProfileRequest {
  if (
    !isRecord(request) ||
    !hasExactKeys(request, ["profile", "sessionId"]) ||
    typeof request.sessionId !== "string" ||
    request.sessionId.trim().length === 0 ||
    !isStoredProfile(request.profile)
  ) {
    throw new CoordinatorError("invalid-command");
  }
  return Object.freeze({
    sessionId: request.sessionId,
    profile: Object.freeze(cloneProfile(request.profile)),
  });
}

function validateRuntimeContext(
  value: ProjectCommandRuntimeContext | undefined,
  required: boolean,
  endpointIds: readonly DurableRuntimeEndpointId[],
): ProjectCommandRuntimeContext | undefined {
  if (value === undefined) {
    if (required) throw new CoordinatorError("invalid-command");
    return undefined;
  }
  if (
    !isExactDataRecord(value, ["endpointId"]) ||
    !isDurableRuntimeEndpointId(value.endpointId) ||
    !endpointIds.includes(value.endpointId)
  ) {
    throw new CoordinatorError("invalid-command");
  }
  return Object.freeze({ endpointId: value.endpointId });
}

function validateSessionRemovalRequest(request: ProjectSessionRemovalRequest): {
  readonly sessionId: string;
  readonly acknowledgedUnknownOutcome: boolean;
} {
  // Two exact shapes, never a subset test: the acknowledgement key is either
  // absent or present carrying the single literal `true`.
  const acknowledged = isExactDataRecord(request, [
    "acknowledgedUnknownOutcome",
    "sessionId",
  ]);
  if (
    (!acknowledged && !isExactDataRecord(request, ["sessionId"])) ||
    typeof request.sessionId !== "string" ||
    request.sessionId.trim().length === 0 ||
    (acknowledged && request.acknowledgedUnknownOutcome !== true)
  ) {
    throw new CoordinatorError("invalid-command");
  }
  return {
    sessionId: request.sessionId,
    acknowledgedUnknownOutcome: acknowledged,
  };
}

function validateSessionMetadataMutationRequest(
  request: ProjectSessionMetadataMutationRequest,
): ProjectSessionMetadataMutationRequest {
  const acknowledged = isExactDataRecord(request, [
    "acknowledgedUnknownOutcome",
    "operation",
    "sessionId",
  ]);
  if (
    (!acknowledged &&
      !isExactDataRecord(request, ["operation", "sessionId"])) ||
    typeof request.sessionId !== "string" ||
    request.sessionId.trim().length === 0 ||
    !isRecord(request.operation)
  ) {
    throw new CoordinatorError("invalid-command");
  }
  if (
    acknowledged &&
    (request.operation.kind !== "archive" ||
      request.acknowledgedUnknownOutcome !== true)
  ) {
    throw new CoordinatorError("invalid-command");
  }
  if (request.operation.kind === "rename") {
    if (
      !isExactDataRecord(request.operation, ["displayName", "kind"]) ||
      typeof request.operation.displayName !== "string"
    ) {
      throw new CoordinatorError("invalid-command");
    }
    return Object.freeze({
      sessionId: request.sessionId,
      operation: Object.freeze({
        kind: "rename" as const,
        displayName: request.operation.displayName,
      }),
    });
  }
  if (
    (request.operation.kind !== "archive" &&
      request.operation.kind !== "restore") ||
    !isExactDataRecord(request.operation, ["kind"])
  ) {
    throw new CoordinatorError("invalid-command");
  }
  return Object.freeze({
    sessionId: request.sessionId,
    operation: Object.freeze({ kind: request.operation.kind }),
    ...(acknowledged
      ? { acknowledgedUnknownOutcome: true as const }
      : {}),
  });
}

function canonicalCommandPayload(command: DirectProjectCommand): string {
  // Presentation remains accepted-envelope metadata. Identity-free commands retain
  // their exact historical bytes, while new native routes are digest-bound.
  const commandValues =
    command.commandKind === "start"
      ? [
          "2",
          "start",
          canonicalLegacyCommandPayload(command),
          canonicalProfile(command.profile),
          command.input,
        ]
      : [
          "2",
          "continue",
          command.targetSessionId,
          canonicalProfile(command.profile),
          command.input,
        ];
  const identity = command.runtimeResumeIdentity;
  const values =
    identity === undefined
      ? commandValues
      : [
          ...commandValues,
          "runtime-resume-identity-v1",
          identity.endpointId,
          canonicalProfile(identity.nativeProfile),
        ];
  return values.map(lengthTagged).join("");
}

function canonicalLegacyCommandPayload(
  command: Extract<DirectProjectCommand, { readonly commandKind: "start" }>,
): string {
  const profileFields = (value: Readonly<Partial<SessionProfile>> | undefined) => ({
    model: value?.model ?? null,
    effortLevel: value?.effortLevel ?? null,
    executionMode: value?.executionMode ?? null,
    accessMode: value?.accessMode ?? null,
  });
  const models = Object.keys(command.preferences.models ?? {})
    .sort()
    .map((model) => [model, profileFields(command.preferences.models?.[model])]);
  return JSON.stringify({
    kind: command.kind,
    runtime: command.runtime,
    catalogRevision: command.catalogRevision,
    preferences: {
      global: profileFields(command.preferences.global),
      runtime: profileFields(command.preferences.runtime),
      models,
    },
    overrides: profileFields(command.overrides),
    input: command.input,
  });
}

function canonicalProfile(value: SessionProfile): string {
  return [value.model, value.effortLevel, value.executionMode, value.accessMode]
    .map(lengthTagged)
    .join("");
}

function lengthTagged(value: string): string {
  return String(Buffer.byteLength(value, "utf8")) + ":" + value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneProfile(profile: SessionProfile): SessionProfile {
  return {
    model: profile.model,
    effortLevel: profile.effortLevel,
    executionMode: profile.executionMode,
    accessMode: profile.accessMode,
  };
}

function cloneRuntimeResumeIdentity(
  identity: ProjectRuntimeResumeIdentity,
): ProjectRuntimeResumeIdentity {
  return Object.freeze({
    schemaVersion: 1 as const,
    endpointId: identity.endpointId,
    nativeProfile: Object.freeze(cloneProfile(identity.nativeProfile)),
  });
}

function cloneDirectCommand(command: DirectProjectCommand): DirectProjectCommand {
  const base = {
    kind: "direct" as const,
    commandKind: command.commandKind,
    idempotencyKey: command.idempotencyKey,
    runtime: "codex" as const,
    profile: cloneProfile(command.profile),
    ...(command.runtimeResumeIdentity === undefined
      ? {}
      : {
          runtimeResumeIdentity: cloneRuntimeResumeIdentity(
            command.runtimeResumeIdentity,
          ),
        }),
    input: command.input,
  };
  if (command.commandKind === "continue") {
    return {
      ...base,
      commandKind: "continue",
      targetSessionId: command.targetSessionId,
      ...(command.profileProjection === undefined
        ? {}
        : {
            profileProjection: Object.freeze({
              version: 1 as const,
              requested: cloneRequestedSessionProfileProjection(
                command.profileProjection.requested,
              ),
            }),
          }),
    };
  }
  const models = Object.fromEntries(
    Object.entries(command.preferences.models ?? {}).map(([model, preferences]) => [
      model,
      cloneProfilePreferences(preferences),
    ]),
  );
  return {
    ...base,
    commandKind: "start",
    catalogRevision: command.catalogRevision,
    preferences: {
      ...(command.preferences.global === undefined
        ? {}
        : { global: cloneProfilePreferences(command.preferences.global) }),
      ...(command.preferences.runtime === undefined
        ? {}
        : { runtime: cloneProfilePreferences(command.preferences.runtime) }),
      ...(Object.keys(models).length === 0 ? {} : { models }),
    },
    ...(command.overrides === undefined
      ? {}
      : { overrides: cloneProfilePreferences(command.overrides) }),
    ...(command.requestedProfileProjection === undefined
      ? {}
      : {
          requestedProfileProjection: cloneRequestedSessionProfileProjection(
            command.requestedProfileProjection,
          ),
        }),
  };
}

function hydrateStoredCommand(
  value: string,
  endpointIds: readonly DurableRuntimeEndpointId[],
): DirectProjectCommand {
  const parsed = JSON.parse(value) as DirectProjectCommand;
  validateCommand(parsed, endpointIds);
  return cloneDirectCommand(parsed);
}

function parseStoredProfile(value: string): SessionProfile {
  const parsed = JSON.parse(value);
  if (!isStoredProfile(parsed)) throw new Error("invalid-profile");
  return cloneProfile(parsed);
}

function isStoredProfile(value: unknown): value is SessionProfile {
  return (
    isExactDataRecord(value, [
      "accessMode",
      "effortLevel",
      "executionMode",
      "model",
    ]) &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    typeof value.effortLevel === "string" &&
    value.effortLevel.trim().length > 0 &&
    value.executionMode === "single-agent" &&
    value.accessMode === "full-access"
  );
}

function isExactReportedProfile(value: unknown): value is SessionProfile {
  return (
    isExactDataRecord(value, [
      "accessMode",
      "effortLevel",
      "executionMode",
      "model",
    ]) &&
    isBoundedRuntimeProfileValue(value.model) &&
    isBoundedRuntimeProfileValue(value.effortLevel) &&
    isBoundedRuntimeProfileValue(value.executionMode) &&
    isBoundedRuntimeProfileValue(value.accessMode)
  );
}

function isRuntimeResumeIdentity(
  value: unknown,
  selectionProfile: SessionProfile,
  endpointIds: readonly DurableRuntimeEndpointId[],
): value is ProjectRuntimeResumeIdentity {
  return (
    isExactDataRecord(value, ["endpointId", "nativeProfile", "schemaVersion"]) &&
    value.schemaVersion === 1 &&
    isDurableRuntimeEndpointId(value.endpointId) &&
    endpointIds.includes(value.endpointId) &&
    isExactReportedProfile(value.nativeProfile) &&
    runtimeProfileProjectionPreservesLockedModes(
      value.endpointId,
      selectionProfile,
      value.nativeProfile,
    )
  );
}

function isBoundedRuntimeProfileValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_024 &&
    !value.includes("\0")
  );
}

function sameProfile(left: SessionProfile, right: SessionProfile): boolean {
  return (
    left.model === right.model &&
    left.effortLevel === right.effortLevel &&
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function sameLockedProfileFields(
  left: SessionProfile,
  right: SessionProfile,
): boolean {
  return (
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactDataRecord(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) {
      return false;
    }
    return expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable
      );
    });
  } catch {
    return false;
  }
}

function isValidSteerInput(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 8_000 ||
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

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length && hasOnlyKeys(value, expected)
  );
}

async function closeUnusedBinding(binding: ResumableRuntimeBinding): Promise<void> {
  try {
    binding.close?.();
    const iterator = binding.events()[Symbol.asyncIterator]();
    await iterator.return?.();
  } catch {
    // The coordinator's fixed durable state is authoritative.
  }
}

function cloneProfilePreferences<T extends Readonly<Partial<SessionProfile>>>(
  profile: T,
): T {
  return {
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.effortLevel === undefined
      ? {}
      : { effortLevel: profile.effortLevel }),
    ...(profile.executionMode === undefined
      ? {}
      : { executionMode: profile.executionMode }),
    ...(profile.accessMode === undefined ? {} : { accessMode: profile.accessMode }),
  } as T;
}

function cloneRuntimeEvent(
  event: NormalizedRuntimeEvent,
  ignoredFields?: string[],
): NormalizedRuntimeEvent {
  if (!isNormalizedRuntimeEvent(event, ignoredFields)) throw new Error("invalid-runtime-event");
  switch (event.kind) {
    case "session-started":
    case "turn-started":
      return { kind: event.kind };
    case "item-started":
    case "item-completed":
      return { kind: event.kind, itemType: "agent-message" };
    case "agent-message":
    case "reasoning":
      return { kind: event.kind, text: event.text };
    case "progress":
      return Object.freeze({
        kind: "progress" as const,
        activity: event.activity,
        ...(event.tool === undefined
          ? {}
          : { tool: cloneRuntimeToolActivity(event.tool) }),
      });
    case "turn-completed":
      return {
        kind: "turn-completed",
        status: "completed",
        ...(event.context === undefined
          ? {}
          : {
              context:
                event.context.basis === "active-context"
                  ? {
                      basis: "active-context" as const,
                      usedTokens: event.context.usedTokens,
                      windowTokens: event.context.windowTokens,
                    }
                  : {
                      basis: "turn-usage" as const,
                      usedTokens: event.context.usedTokens,
                      windowTokens: null,
                    },
            }),
        ...(event.suggestions === undefined
          ? {}
          : { suggestions: Object.freeze([...event.suggestions]) }),
      };
    case "turn-interrupted":
      return { kind: "turn-interrupted", status: "interrupted" };
    case "turn-paused":
      return {
        kind: "turn-paused",
        reason: "quota-exhausted",
        ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
      };
    case "failed":
      return { kind: "failed", category: event.category };
  }
}

/**
 * Rows written before context semantics were versioned stored a two-key context
 * whose number may be accumulated Session usage. Preserve the row itself, but
 * never hydrate that ambiguous value as current context. Incoming Runtime
 * events do not pass through this compatibility path.
 */
function hydrateStoredRuntimeEvent(event: unknown): ProjectRecordedTurnEvent {
  if (
    isExactDataRecord(event, ["kind", "text"]) &&
    event.kind === "user-message" &&
    isValidSteerInput(event.text)
  ) {
    return Object.freeze({ kind: "user-message", text: event.text });
  }
  if (isLegacyTurnCompletedRuntimeEvent(event)) {
    return { kind: "turn-completed", status: "completed" };
  }
  return cloneRuntimeEvent(event as NormalizedRuntimeEvent);
}

function freezeRecordedTurnEvent(
  event: ProjectRecordedTurnEvent,
): ProjectRecordedTurnEvent {
  if (event.kind === "turn-completed") {
    if (event.context !== undefined) Object.freeze(event.context);
    if (event.suggestions !== undefined) Object.freeze(event.suggestions);
  }
  return Object.freeze(event);
}

function isLegacyTurnCompletedRuntimeEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["context", "kind", "status"]) &&
    value.kind === "turn-completed" &&
    value.status === "completed" &&
    isLegacyRuntimeContextUsage(value.context)
  );
}

function isLegacyRuntimeContextUsage(value: unknown): boolean {
  if (
    !isExactDataRecord(value, ["usedTokens", "windowTokens"]) ||
    typeof value.usedTokens !== "number" ||
    !Number.isSafeInteger(value.usedTokens) ||
    value.usedTokens < 0
  ) {
    return false;
  }
  return (
    value.windowTokens === null ||
    (typeof value.windowTokens === "number" &&
      Number.isSafeInteger(value.windowTokens) &&
      value.windowTokens >= value.usedTokens)
  );
}

const runtimeFailureCategories = new Set([
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
]);

const runtimeProgressActivities = new Set([
  "thinking",
  "tool",
  "retrying",
  "rate-limited",
  "status",
]);

const runtimeToolActivityTypes = new Set([
  "tool_use",
  "commandExecution",
  "fileChange",
  "webSearch",
  "unknown",
]);
const maximumRuntimeToolActivitySourceTypeCharacters = 240;

// Only live Runtime ingress supplies a collector. Stored rows keep exact shapes;
// ingress still validates every consumed field and clones fresh known-only literals.
function hasRuntimeEventKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  ignoredFields: string[] | undefined,
  path = "event",
): boolean {
  if (ignoredFields === undefined) return hasOnlyKeys(value, allowed);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) ignoredFields.push(`${path}.${key}`);
  }
  return true;
}

function isRuntimeDataRecord(
  value: unknown,
  required: readonly string[],
  ignoredFields: string[] | undefined,
  path: string,
): value is Record<string, unknown> {
  // Include additional data properties in the record check, not in the clone.
  // Required own/enumerable data fields and plain-record checks remain unchanged.
  const keys = ignoredFields !== undefined && isRecord(value) && !nodeUtilTypes.isProxy(value)
    ? [...new Set([...required, ...Object.keys(value)])]
    : required;
  return isExactDataRecord(value, keys) &&
    hasRuntimeEventKeys(value, required, ignoredFields, path);
}

function isNormalizedRuntimeEvent(
  value: unknown,
  ignoredFields?: string[],
): value is NormalizedRuntimeEvent {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "session-started":
    case "turn-started":
      return hasRuntimeEventKeys(value, ["kind"], ignoredFields);
    case "item-started":
    case "item-completed":
      return (
        hasRuntimeEventKeys(value, ["itemType", "kind"], ignoredFields) &&
        value.itemType === "agent-message"
      );
    case "agent-message":
    case "reasoning":
      return (
        hasRuntimeEventKeys(value, ["kind", "text"], ignoredFields) &&
        typeof value.text === "string"
      );
    case "progress":
      return (
        hasRuntimeEventKeys(value, ["activity", "kind", "tool"], ignoredFields) &&
        typeof value.activity === "string" &&
        runtimeProgressActivities.has(value.activity) &&
        (!hasOwn(value, "tool") || isRuntimeToolActivity(value.tool, ignoredFields))
      );
    case "turn-completed":
      return (
        hasRuntimeEventKeys(
          value,
          ["context", "kind", "status", "suggestions"],
          ignoredFields,
        ) &&
        value.status === "completed" &&
        (!hasOwn(value, "context") ||
          isRuntimeContextUsage(value.context, ignoredFields)) &&
        (!hasOwn(value, "suggestions") ||
          isRuntimePromptSuggestions(value.suggestions))
      );
    case "turn-interrupted":
      return (
        hasRuntimeEventKeys(value, ["kind", "status"], ignoredFields) &&
        value.status === "interrupted"
      );
    case "turn-paused":
      return (
        hasRuntimeEventKeys(value, ["kind", "reason", "resetsAt"], ignoredFields) &&
        value.reason === "quota-exhausted" &&
        (!hasOwn(value, "resetsAt") || isValidQuotaResetsAt(value.resetsAt))
      );
    case "failed":
      return (
        hasRuntimeEventKeys(value, ["category", "kind"], ignoredFields) &&
        typeof value.category === "string" &&
        runtimeFailureCategories.has(value.category)
      );
    default:
      return false;
  }
}

function cloneRuntimeToolActivity(
  tool: RuntimeToolActivity,
): RuntimeToolActivity {
  return Object.freeze({
    type: tool.type,
    name: tool.name,
    ...(tool.sourceType === undefined ? {} : { sourceType: tool.sourceType }),
    ...(tool.parameter === undefined
      ? {}
      : {
          parameter: Object.freeze({
            kind: tool.parameter.kind,
            value: tool.parameter.value,
            truncated: tool.parameter.truncated,
          }),
        }),
    ...(tool.fileChanges === undefined
      ? {}
      : {
          fileChanges: Object.freeze({
            files: Object.freeze(tool.fileChanges.files.map((file) =>
              Object.freeze({
                path: file.path,
                truncated: file.truncated,
                ...(file.lines === undefined
                  ? {}
                  : {
                      lines: Object.freeze({
                        additions: file.lines.additions,
                        deletions: file.lines.deletions,
                      }),
                    }),
              })
            )),
            totalFiles: tool.fileChanges.totalFiles,
            truncated: tool.fileChanges.truncated,
          }),
        }),
  });
}

function isRuntimeToolActivity(
  value: unknown,
  ignoredFields?: string[],
): value is RuntimeToolActivity {
  if (
    !isRecord(value) ||
    !hasRuntimeEventKeys(
      value,
      ["fileChanges", "name", "parameter", "sourceType", "type"],
      ignoredFields,
      "tool",
    ) ||
    typeof value.type !== "string" ||
    !runtimeToolActivityTypes.has(value.type) ||
    typeof value.name !== "string" ||
    (value.type === "unknown"
      ? !isRuntimeToolActivitySourceType(value.sourceType)
      : hasOwn(value, "sourceType")) ||
    (hasOwn(value, "parameter") &&
      !isRuntimeToolActivityParameter(value.parameter, ignoredFields)) ||
    (hasOwn(value, "fileChanges") &&
      (value.type !== "fileChange" ||
        !isRuntimeFileChangeSummary(value.fileChanges, ignoredFields)))
  ) {
    return false;
  }
  return true;
}

function isRuntimeFileChangeSummary(
  value: unknown,
  ignoredFields?: string[],
): boolean {
  if (
    !isRuntimeDataRecord(
      value,
      ["files", "totalFiles", "truncated"],
      ignoredFields,
      "tool.fileChanges",
    ) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 3 ||
    !Number.isSafeInteger(value.totalFiles) ||
    (value.totalFiles as number) < value.files.length ||
    value.truncated !== ((value.totalFiles as number) > value.files.length)
  ) {
    return false;
  }
  return value.files.every((file, index) => {
    if (!isRecord(file)) return false;
    return isRuntimeDataRecord(
      file,
      hasOwn(file, "lines")
        ? ["lines", "path", "truncated"]
        : ["path", "truncated"],
      ignoredFields,
      `tool.fileChanges.files[${index}]`,
    ) &&
    typeof file.path === "string" &&
    typeof file.truncated === "boolean" &&
    (!hasOwn(file, "lines") ||
      isRuntimeFileChangeLineSummary(
        file.lines,
        ignoredFields,
        `tool.fileChanges.files[${index}].lines`,
      ));
  });
}

function isRuntimeFileChangeLineSummary(
  value: unknown,
  ignoredFields: string[] | undefined,
  path: string,
): boolean {
  return (
    isRuntimeDataRecord(
      value,
      ["additions", "deletions"],
      ignoredFields,
      path,
    ) &&
    Number.isSafeInteger(value.additions) &&
    (value.additions as number) >= 0 &&
    Number.isSafeInteger(value.deletions) &&
    (value.deletions as number) >= 0
  );
}

function isRuntimeToolActivityParameter(
  value: unknown,
  ignoredFields?: string[],
): boolean {
  return (
    isRecord(value) &&
    (ignoredFields === undefined
      ? hasExactKeys(value, ["kind", "truncated", "value"])
      : ["kind", "truncated", "value"].every((key) => Object.prototype.propertyIsEnumerable.call(value, key)) &&
        hasRuntimeEventKeys(value, ["kind", "truncated", "value"], ignoredFields, "tool.parameter")) &&
    (value.kind === "command" || value.kind === "path") &&
    typeof value.value === "string" &&
    typeof value.truncated === "boolean"
  );
}

function isRuntimeToolActivitySourceType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumRuntimeToolActivitySourceTypeCharacters &&
    !value.includes("\0")
  );
}

function isRuntimePromptSuggestions(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isValidSteerInput)
  );
}

function isRuntimeContextUsage(value: unknown, ignoredFields?: string[]): boolean {
  if (
    !isRuntimeDataRecord(value, ["basis", "usedTokens", "windowTokens"], ignoredFields, "context") ||
    typeof value.usedTokens !== "number" ||
    !Number.isSafeInteger(value.usedTokens) ||
    value.usedTokens < 0
  ) {
    return false;
  }
  if (value.basis === "turn-usage") return value.windowTokens === null;
  return (
    value.basis === "active-context" &&
    typeof value.windowTokens === "number" &&
      Number.isSafeInteger(value.windowTokens) &&
      value.windowTokens >= value.usedTokens
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hydrateUpdate(row: UpdateRow): DurableProjectUpdate | undefined {
  if (
    !Number.isSafeInteger(Number(row.cursor)) ||
    Number(row.cursor) <= 0 ||
    typeof row.command_id !== "string" ||
    row.command_id.length === 0 ||
    !["accepted", "in-flight", "completed", "quota-paused", "failed", "recovery-required"].includes(
      row.status,
    )
  ) {
    throw new Error("invalid-update");
  }
  const base = {
    cursor: Number(row.cursor),
    commandId: row.command_id,
    status: row.status,
  };
  switch (row.kind) {
    case "accepted":
    case "in-flight":
    case "recovery-required":
    case "continuation-stop":
      return { ...base, kind: row.kind };
    case "completed":
      effectiveProjectionFromTerminalData("completed", row.data_json);
      return { ...base, kind: "completed" };
    case "quota-paused":
      readQuotaDeadline(row.data_json ?? "{}");
      return { ...base, kind: "quota-paused" };
    case "profile-resolved": {
      const data = JSON.parse(row.data_json ?? "{}") as { profile: SessionProfile };
      if (row.session_id === null || !isStoredProfile(data.profile)) {
        throw new Error("invalid-profile-update");
      }
      return {
        ...base,
        kind: "profile-resolved",
        sessionId: row.session_id ?? "",
        profile: cloneProfile(data.profile),
      };
    }
    case "runtime-event": {
      const data = JSON.parse(row.data_json ?? "{}") as {
        event: NormalizedRuntimeEvent;
      };
      if (row.session_id === null) throw new Error("invalid-runtime-update");
      return {
        ...base,
        kind: "runtime-event",
        sessionId: row.session_id ?? "",
        event: hydrateStoredRuntimeEvent(data.event),
      };
    }
    case "interrupt-capability": {
      const data = JSON.parse(row.data_json ?? "{}") as {
        capability?: unknown;
      };
      if (
        row.session_id === null ||
        (data.capability !== "pending" &&
          data.capability !== "available" &&
          data.capability !== "unsupported" &&
          data.capability !== "requested")
      ) {
        throw new Error("invalid-interrupt-capability-update");
      }
      return {
        ...base,
        kind: "interrupt-capability",
        sessionId: row.session_id,
        capability: data.capability,
      };
    }
    case "failed": {
      effectiveProjectionFromTerminalData("failed", row.data_json);
      const data = JSON.parse(row.data_json ?? "{}") as {
        failureCategory: ProjectCommandFailureCategory;
      };
      if (
        data.failureCategory !== "profile-resolution-failed" &&
        data.failureCategory !== "runtime-failed" &&
        data.failureCategory !== "quota-expired" &&
        data.failureCategory !== "interrupted"
      ) {
        throw new Error("invalid-failure-update");
      }
      return {
        ...base,
        kind: "failed",
        failureCategory: data.failureCategory,
      };
    }
    default:
      // A build from a newer version of this product can append a `kind` this
      // build has never heard of. Skipping it (instead of throwing) keeps the
      // rest of the ledger observable when an older build reopens a project a
      // newer build has already written to.
      console.warn("[coordinator] Skipped unknown ledger update kind", {
        kind: row.kind,
        cursor: base.cursor,
      });
      return undefined;
  }
}

function effectiveProjectionFromTerminalData(
  kind: "completed" | "failed",
  dataJson: string | null,
): EffectiveSessionProfileProjection | undefined {
  if (dataJson === null) {
    if (kind === "failed") throw new Error("invalid-failure-update");
    return undefined;
  }
  const data = JSON.parse(dataJson) as unknown;
  if (!isRecord(data)) throw new Error("invalid-terminal-update");
  const keys = Object.keys(data).sort();
  const allowed =
    kind === "completed"
      ? ["effectiveProfileProjection"]
      : ["effectiveProfileProjection", "failureCategory"];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    (kind === "completed" && keys.length !== 1) ||
    (kind === "failed" &&
      (keys.length < 1 ||
        keys.length > 2 ||
        !keys.includes("failureCategory")))
  ) {
    throw new Error("invalid-terminal-update");
  }
  return data.effectiveProfileProjection === undefined
    ? undefined
    : cloneEffectiveSessionProfileProjection(data.effectiveProfileProjection);
}
