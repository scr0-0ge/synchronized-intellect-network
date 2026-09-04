import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as nodeUtilTypes } from "node:util";

import {
  RuntimeAdapterError,
  type NormalizedRuntimeEvent,
  type ResumableAgentRuntimeAdapter,
  type ResumableRuntimeBinding,
  type RuntimeCatalog,
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
  type ProjectCommandFailureCategory,
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
  type WorkLedgerAuthGenerationModule,
} from "./work-ledger-auth-generation.ts";

type CommandRow = {
  command_id: string;
  runtime: "codex";
  status: ProjectCommandStatus;
  failure_category:
    | ProjectCommandFailureCategory
    | ProjectRecoveryFailureCategory
    | null;
  accepted_cursor: number;
  private_envelope_json: string | null;
};

type SessionRow = {
  session_id: string;
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
  private opened = false;

  constructor(
    databasePath: string,
    adapter: ResumableAgentRuntimeAdapter,
    authGeneration?: WorkLedgerAuthGenerationModule,
  ) {
    this.databasePath = databasePath;
    this.adapter = adapter;
    this.authGeneration = authGeneration;
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
  private closed = false;
  private closePromise?: Promise<void>;
  private acceptanceTail: Promise<void> = Promise.resolve();
  private executionTail: Promise<void> = Promise.resolve();
  private commitGeneration = 0;
  private readonly observers = new Set<ObserverState>();
  private activeRuntimeIterator?: RuntimeIteratorState;
  private activeRuntimeControl?: ActiveRuntimeControl;

  constructor(
    database: DatabaseSync,
    projectId: string,
    projectDirectory: string,
    adapter: ResumableAgentRuntimeAdapter,
    sessionMetadata: SessionMetadataModule,
    authGeneration?: WorkLedgerAuthGenerationModule,
  ) {
    this.database = database;
    this.projectId = projectId;
    this.projectDirectory = projectDirectory;
    this.adapter = adapter;
    this.sessionMetadata = sessionMetadata;
    this.authGeneration = authGeneration;
  }

  startRecoveredExecutions(): void {
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
      validateCommand(command);
      commandSnapshot = cloneDirectCommand(command);
      runtimeContextSnapshot = validateRuntimeContext(
        runtimeContext,
        this.authGeneration !== undefined,
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
          row.lifecycle_status !== "completed" ||
          row.opaque_session_reference === null ||
          row.opaque_session_reference.trim().length === 0 ||
          !this.isAccountObservationCurrent(row.account_observation_json)
        ) {
          return Object.freeze({ status: "incompatible" as const });
        }
        const currentProfile = parseStoredProfile(row.profile_json);
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
        const command = hydrateStoredCommand(row.private_envelope_json);
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
    // `recovery-required` is terminal, not active: it is written precisely
    // because the runtime binding was lost, and nothing in the product can ever
    // move a row out of it again. Waiting therefore never helps, so the barrier
    // is released by an explicit owner acknowledgement rather than by time.
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
      (row.lifecycle_status !== "completed" && !queuedEligibility)
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
        this.containExecutionFailure(commandId);
      }
    });
    this.executionTail = execution.then(
      () => undefined,
      () => undefined,
    );
  }

  private containExecutionFailure(commandId: string): void {
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
        this.recordRecoveryRequired(commandId);
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
    if (this.closed || this.hasEarlierRecoveryBarrier(commandId)) return;
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
      } catch {
        this.recordFailure(commandId, "runtime-failed");
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
      if (
        !sameProfile(binding.profile, command.profile) ||
        binding.opaqueSessionReference.trim().length === 0 ||
        (existingReference !== null &&
          binding.opaqueSessionReference !== existingReference)
      ) {
        throw new Error("binding-drift");
      }
    } catch (error) {
      this.recordRecoveryRequired(commandId, recoveryFailureCategory(error));
      return;
    }
    if (!this.commitBinding(commandId, session.session_id, binding)) {
      this.recordRecoveryRequired(commandId);
      await closeUnusedBinding(binding);
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
      this.recordRecoveryRequired(commandId, recoveryFailureCategory(error));
      return;
    }
    if (this.closed) {
      this.recordRecoveryRequired(commandId);
      await closeUnusedBinding(binding);
      return;
    }
    this.database
      .prepare(
        "UPDATE commands SET effect_phase = 'awaiting-terminal', outcome_uncertain = 1 WHERE command_id = ? AND status = 'in-flight'",
      )
      .run(commandId);

    const events: NormalizedRuntimeEvent[] = [];
    let terminal: "completed" | "interrupted" | "failed" | "invalid" | undefined;
    let iteratorState: RuntimeIteratorState;
    try {
      iteratorState = {
        iterator: binding.events()[Symbol.asyncIterator](),
        commandId,
        done: false,
      };
    } catch (error) {
      this.recordRecoveryRequired(commandId, recoveryFailureCategory(error));
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
    this.publishActiveInterruptCapability(runtimeControl);
    try {
      while (true) {
        const pending = iteratorState.iterator.next();
        if (this.closed) void this.cancelRuntimeIterator(iteratorState);
        const result = await pending;
        if (result.done) {
          iteratorState.done = true;
          break;
        }
        const event = cloneRuntimeEvent(result.value);
        if (terminal !== undefined) {
          terminal = "invalid";
          break;
        }
        events.push(event);
        if (event.kind === "turn-completed") terminal = "completed";
        if (event.kind === "turn-interrupted") terminal = "interrupted";
        if (event.kind === "failed") terminal = "failed";
        if (terminal === undefined) {
          this.publishActiveInterruptCapability(runtimeControl);
        }
      }
    } catch (error) {
      this.recordRecoveryRequired(commandId, recoveryFailureCategory(error));
      return;
    } finally {
      if (!iteratorState.done) await this.cancelRuntimeIterator(iteratorState);
      if (this.activeRuntimeIterator === iteratorState) {
        this.activeRuntimeIterator = undefined;
      }
      if (this.activeRuntimeControl === runtimeControl) {
        this.activeRuntimeControl = undefined;
      }
    }
    if (this.closed) {
      this.recordRecoveryRequired(commandId);
      return;
    }
    if (
      terminal === "completed" ||
      terminal === "interrupted" ||
      terminal === "failed"
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
    this.recordRecoveryRequired(commandId);
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
    const command = hydrateStoredCommand(commandRow.private_envelope_json);
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

  private commitTerminal(
    commandId: string,
    sessionId: string,
    events: readonly NormalizedRuntimeEvent[],
    outcome: "completed" | "interrupted" | "failed",
    effectiveProfileProjection?: EffectiveSessionProfileProjection,
    persistedEventCount = 0,
  ): void {
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
    const rootCommand = hydrateStoredCommand(row.private_envelope_json);
    return rootCommand.commandKind === "start"
      ? rootCommand.requestedProfileProjection
      : undefined;
  }

  private recordRecoveryRequired(
    commandId: string,
    failureCategory?: ProjectRecoveryFailureCategory,
  ): void {
    const committed = transaction(this.database, () => {
      const row = this.database
        .prepare("SELECT target_session_id FROM commands WHERE command_id = ?")
        .get(commandId) as { target_session_id: string | null } | undefined;
      const result = this.database
        .prepare(
          "UPDATE commands SET status = 'recovery-required', failure_category = ?, outcome_uncertain = 1 WHERE command_id = ? AND status IN ('accepted', 'in-flight')",
        )
        .run(failureCategory ?? null, commandId);
      if (Number(result.changes) !== 1) return false;
      if (row?.target_session_id !== null && row?.target_session_id !== undefined) {
        this.database
          .prepare(
            "UPDATE sessions SET lifecycle_status = 'recovery-required' WHERE session_id = ?",
          )
          .run(row.target_session_id);
      }
      appendUpdate(
        this.database,
        this.projectId,
        commandId,
        "recovery-required",
        "recovery-required",
        row?.target_session_id ?? undefined,
      );
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
                (digest_version = 2 AND target_session_id = ? AND status = 'recovery-required')
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
                       WHEN 'recovery-required' THEN 0
                       WHEN 'in-flight' THEN 1
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

  async snapshot(): Promise<ProjectSnapshot> {
    this.assertOpen();
    const cursor = currentCursor(this.database, this.projectId);
    const rows = this.database
      .prepare(
        `SELECT command_id, runtime, status, failure_category, accepted_cursor,
                private_envelope_json
           FROM commands
          WHERE project_id = ?
          ORDER BY accepted_cursor`,
      )
      .all(this.projectId) as unknown as CommandRow[];
    const commands = rows.map((row) => this.commandSummary(row));
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
    for (const observer of [...this.observers]) this.finishObservation(observer);
    const runtimeCancellation =
      this.activeRuntimeIterator === undefined
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

  private commandSummary(row: CommandRow): ProjectCommandSummary {
    const currentCommand =
      row.private_envelope_json === null
        ? undefined
        : hydrateStoredCommand(row.private_envelope_json);
    const session = this.database
      .prepare(
        `SELECT sessions.session_id, sessions.profile_json,
                sessions.opaque_session_reference, sessions.lifecycle_status,
                sessions.auth_context_json,
                sessions.account_observation_json, sessions.display_name,
                sessions.display_name_source, sessions.display_ordinal,
                sessions.archived,
                root.private_envelope_json AS root_private_envelope_json,
                root.accepted_cursor AS root_accepted_cursor
           FROM sessions
           JOIN commands AS root ON root.command_id = sessions.root_command_id
          WHERE sessions.session_id = (
            SELECT target_session_id FROM commands WHERE command_id = ?
          )`,
      )
      .get(row.command_id) as SessionRow | undefined;
    const failureCategory = failedCommandFailureCategory(row);
    const summary: ProjectCommandSummary = {
      commandId: row.command_id,
      runtime: row.runtime,
      status: row.status,
      ...(failureCategory === undefined ? {} : { failureCategory }),
      ...(currentCommand === undefined ? {} : { input: currentCommand.input }),
    };
    if (session === undefined) return summary;
    let requestedProfileProjection: RequestedSessionProfileProjection | undefined;
    if (session.root_private_envelope_json !== null) {
      const rootCommand = hydrateStoredCommand(
        session.root_private_envelope_json,
      );
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
    const eventRows = this.database
      .prepare(
        `SELECT data_json
           FROM updates
          WHERE command_id = ? AND kind = 'runtime-event'
          ORDER BY cursor`,
      )
      .all(row.command_id) as unknown as Array<{ data_json: string }>;
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
        resumable:
          !metadata.archived &&
          session.lifecycle_status === "completed" &&
          session.opaque_session_reference !== null &&
          session.opaque_session_reference.trim().length > 0 &&
          this.isAccountObservationCurrent(session.account_observation_json) &&
          (this.authGeneration === undefined ||
            this.authGeneration.isSessionNativeResumable(
              session.auth_context_json,
            )),
        events: eventRows.map((eventRow) => {
          const data = JSON.parse(eventRow.data_json) as {
            event: ProjectRecordedTurnEvent;
          };
          return hydrateStoredRuntimeEvent(data.event);
        }),
      },
    };
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
      const command = hydrateStoredCommand(row.private_envelope_json);
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

function validateCommand(command: DirectProjectCommand): void {
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
    !isRuntimeResumeIdentity(command.runtimeResumeIdentity, command.profile)
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
): ProjectCommandRuntimeContext | undefined {
  if (value === undefined) {
    if (required) throw new CoordinatorError("invalid-command");
    return undefined;
  }
  if (
    !isExactDataRecord(value, ["endpointId"]) ||
    (value.endpointId !== "codex-desktop" &&
      value.endpointId !== "claude-code-desktop")
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
  if (
    !isExactDataRecord(request, ["operation", "sessionId"]) ||
    typeof request.sessionId !== "string" ||
    request.sessionId.trim().length === 0 ||
    !isRecord(request.operation)
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

function hydrateStoredCommand(value: string): DirectProjectCommand {
  const parsed = JSON.parse(value) as DirectProjectCommand;
  validateCommand(parsed);
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
): value is ProjectRuntimeResumeIdentity {
  return (
    isExactDataRecord(value, ["endpointId", "nativeProfile", "schemaVersion"]) &&
    value.schemaVersion === 1 &&
    (value.endpointId === "codex-desktop" ||
      value.endpointId === "claude-code-desktop") &&
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

function cloneRuntimeEvent(event: NormalizedRuntimeEvent): NormalizedRuntimeEvent {
  if (!isNormalizedRuntimeEvent(event)) throw new Error("invalid-runtime-event");
  switch (event.kind) {
    case "session-started":
    case "turn-started":
      return { kind: event.kind };
    case "item-started":
    case "item-completed":
      return { kind: event.kind, itemType: "agent-message" };
    case "agent-message":
      return { kind: "agent-message", text: event.text };
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
      };
    case "turn-interrupted":
      return { kind: "turn-interrupted", status: "interrupted" };
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
  "runtime-unavailable",
  "temp-cleanup",
  "temp-cleanup-guard",
  "transport-failed",
  "turn-failed",
  "unexpected-server-request",
  "unsupported-selection",
]);

function isNormalizedRuntimeEvent(
  value: unknown,
): value is NormalizedRuntimeEvent {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "session-started":
    case "turn-started":
      return hasOnlyKeys(value, ["kind"]);
    case "item-started":
    case "item-completed":
      return (
        hasOnlyKeys(value, ["itemType", "kind"]) &&
        value.itemType === "agent-message"
      );
    case "agent-message":
      return (
        hasOnlyKeys(value, ["kind", "text"]) &&
        typeof value.text === "string"
      );
    case "turn-completed":
      return (
        hasOnlyKeys(value, ["context", "kind", "status"]) &&
        value.status === "completed" &&
        (!hasOwn(value, "context") || isRuntimeContextUsage(value.context))
      );
    case "turn-interrupted":
      return (
        hasOnlyKeys(value, ["kind", "status"]) &&
        value.status === "interrupted"
      );
    case "failed":
      return (
        hasOnlyKeys(value, ["category", "kind"]) &&
        typeof value.category === "string" &&
        runtimeFailureCategories.has(value.category)
      );
    default:
      return false;
  }
}

function isRuntimeContextUsage(value: unknown): boolean {
  if (
    !isExactDataRecord(value, ["basis", "usedTokens", "windowTokens"]) ||
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

function hydrateUpdate(row: UpdateRow): DurableProjectUpdate {
  if (
    !Number.isSafeInteger(Number(row.cursor)) ||
    Number(row.cursor) <= 0 ||
    typeof row.command_id !== "string" ||
    row.command_id.length === 0 ||
    !["accepted", "in-flight", "completed", "failed", "recovery-required"].includes(
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
      return { ...base, kind: row.kind };
    case "completed":
      effectiveProjectionFromTerminalData("completed", row.data_json);
      return { ...base, kind: "completed" };
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
      throw new Error("invalid-update-kind");
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
