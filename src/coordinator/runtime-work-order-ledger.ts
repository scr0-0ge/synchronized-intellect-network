import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  type BoundSupervisorSession,
  type RuntimeDirectorySnapshotKey,
  type RuntimeEndpointAccessMode,
  type RuntimeEndpointDirectory,
  RuntimeEndpointDirectoryError,
  type RuntimeEndpointDirectoryFailureCategory,
  type RuntimeEndpointSnapshotKey,
  type RuntimeNeutralWorkOrder,
  type RuntimeProfileSnapshotKey,
} from "../agent-runtime/runtime-endpoint-directory.ts";

export type RuntimeWorkOrderLifecycle =
  | "accepted"
  | "denied"
  | "authorized"
  | "start-claimed"
  | "running"
  | "control-claimed"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "recovery-required";

export type RuntimeWorkOrderEffectPhase =
  | "unclaimed"
  | "start-claimed"
  | "running"
  | "control-claimed"
  | "committed"
  | "outcome-unknown";

export type RuntimeWorkOrderSlotState = "unreserved" | "owned" | "released";
export type RuntimeWorkOrderDenialCategory =
  | RuntimeEndpointDirectoryFailureCategory
  | "endpoint-capacity-denied";

export type RuntimeWorkOrderLedgerCrashPoint =
  | "before-acceptance-commit"
  | "after-acceptance-before-authorization"
  | "after-authorization-before-slot-commit"
  | "after-slot-commit-before-effect-claim"
  | "after-effect-claim-before-external-acknowledgement"
  | "after-terminal-fact-before-response";

export type RuntimeWorkOrderLedgerFailureCategory =
  | "command-invalid"
  | "idempotency-conflict"
  | "work-order-not-found"
  | "transition-invalid"
  | "claim-conflict"
  | "worker-link-invalid"
  | "terminal-conflict"
  | "directory-reconciliation-required"
  | "durable-state-invalid"
  | "storage-failed"
  | "ledger-closed";

export class RuntimeWorkOrderLedgerError extends Error {
  readonly category: RuntimeWorkOrderLedgerFailureCategory;

  constructor(category: RuntimeWorkOrderLedgerFailureCategory) {
    super("Runtime Work Order Ledger operation failed.");
    this.name = "RuntimeWorkOrderLedgerError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export class RuntimeWorkOrderLedgerCrashError extends Error {
  readonly point: RuntimeWorkOrderLedgerCrashPoint;

  constructor(point: RuntimeWorkOrderLedgerCrashPoint) {
    super("Runtime Work Order Ledger simulated crash.");
    this.name = "RuntimeWorkOrderLedgerCrashError";
    this.point = point;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface RuntimeWorkOrderLedgerOptions {
  readonly databasePath: string;
  readonly directory: RuntimeEndpointDirectory;
  /** Deterministic test-only crash injection. No payload is passed through it. */
  readonly crashPoint?: RuntimeWorkOrderLedgerCrashPoint;
}

export type RuntimeWorkOrderLedgerCommand =
  | {
      readonly kind: "submit";
      readonly workOrder: RuntimeNeutralWorkOrder;
      readonly boundSupervisor: BoundSupervisorSession;
    }
  | { readonly kind: "claim-start"; readonly workOrderKey: string }
  | {
      readonly kind: "confirm-start";
      readonly workOrderKey: string;
      readonly claimKey: string;
      readonly outcome: "started" | "failed";
    }
  | {
      readonly kind: "cancel-before-start";
      readonly workOrderKey: string;
    }
  | {
      readonly kind: "record-progress";
      readonly workOrderKey: string;
      readonly workerKey: string;
      readonly sequence: number;
    }
  | {
      readonly kind: "record-handoff";
      readonly workOrderKey: string;
      readonly workerKey: string;
      readonly handoffKey: string;
    }
  | {
      readonly kind: "claim-control";
      readonly workOrderKey: string;
      readonly workerKey: string;
      readonly action: "cancel" | "interrupt";
    }
  | {
      readonly kind: "confirm-control";
      readonly workOrderKey: string;
      readonly workerKey: string;
      readonly claimKey: string;
      readonly outcome: "committed" | "failed";
    };

export interface RuntimeWorkOrderEffectIntent {
  readonly kind: "start-worker" | "cancel-worker" | "interrupt-worker";
  readonly claimKey: string;
  readonly workOrderKey: string;
  readonly workerKey: string;
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly endpointSnapshotKey: RuntimeEndpointSnapshotKey;
  readonly profileSnapshotKey: RuntimeProfileSnapshotKey;
  readonly accessMode: RuntimeEndpointAccessMode;
}

export type RuntimeWorkOrderLedgerResult =
  | {
      readonly kind: "submission";
      readonly status: "accepted" | "authorized" | "denied";
      readonly workOrderKey: string;
      readonly revision: number;
      readonly denialCategory: RuntimeWorkOrderDenialCategory | null;
    }
  | {
      readonly kind: "effect-intent";
      readonly status: "claimed";
      readonly workOrderKey: string;
      readonly revision: number;
      readonly effectIntent: RuntimeWorkOrderEffectIntent;
    }
  | {
      readonly kind: "transition";
      readonly status: RuntimeWorkOrderLifecycle;
      readonly workOrderKey: string;
      readonly workerKey: string | null;
      readonly revision: number;
    };

export interface RuntimeWorkOrderLedgerSnapshot {
  readonly revision: number;
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly orders: readonly RuntimeWorkOrderLedgerOrderSnapshot[];
}

export interface RuntimeWorkOrderLedgerOrderSnapshot {
  readonly workOrderKey: string;
  readonly directorySnapshotKey: RuntimeDirectorySnapshotKey;
  readonly endpointSnapshotKey: RuntimeEndpointSnapshotKey;
  readonly profileSnapshotKey: RuntimeProfileSnapshotKey;
  readonly requestedAccessMode: RuntimeEndpointAccessMode;
  readonly lifecycle: RuntimeWorkOrderLifecycle;
  readonly effectPhase: RuntimeWorkOrderEffectPhase;
  readonly denialCategory: RuntimeWorkOrderDenialCategory | null;
  readonly slot: {
    readonly state: RuntimeWorkOrderSlotState;
    readonly units: number;
    readonly acquiredRevision: number | null;
    readonly releasedRevision: number | null;
  };
  readonly worker: null | {
    readonly workerKey: string;
    readonly lifecycle:
      | "running"
      | "control-claimed"
      | "completed"
      | "cancelled"
      | "interrupted"
      | "recovery-required";
    readonly progressSequence: number;
    readonly handoffState: "none" | "recorded";
    readonly controlState:
      | "none"
      | "cancel-claimed"
      | "interrupt-claimed"
      | "committed"
      | "outcome-unknown";
  };
}

export interface RuntimeWorkOrderLedger {
  coordinate(command: RuntimeWorkOrderLedgerCommand): RuntimeWorkOrderLedgerResult;
  snapshot(): RuntimeWorkOrderLedgerSnapshot;
  close(): void;
}

type OrderRow = {
  work_order_key: string;
  idempotency_key: string;
  work_order_digest: string;
  supervisor_binding_digest: string;
  intent_json: string;
  supervisor_binding_json: string;
  directory_epoch_key: string;
  endpoint_snapshot_key: string;
  profile_snapshot_key: string;
  requested_access_mode: RuntimeEndpointAccessMode;
  lifecycle_state: RuntimeWorkOrderLifecycle;
  effect_phase: RuntimeWorkOrderEffectPhase;
  denial_category: RuntimeWorkOrderDenialCategory | null;
  accepted_revision: number;
  authorization_revision: number | null;
  claim_revision: number | null;
  terminal_revision: number | null;
  active_claim_key: string | null;
  provisional_worker_key: string | null;
  worker_key: string | null;
  control_action: "cancel" | "interrupt" | null;
  progress_sequence: number;
  handoff_digest: string | null;
};

type SlotRow = {
  work_order_key: string;
  slot_state: RuntimeWorkOrderSlotState;
  directory_snapshot_key: string | null;
  endpoint_snapshot_key: string | null;
  slot_units: number;
  acquired_revision: number | null;
  released_revision: number | null;
};

type AuthorizationRow = {
  work_order_key: string;
  directory_snapshot_key: string;
  supervisor_endpoint_snapshot_key: string;
  supervisor_profile_snapshot_key: string;
  worker_endpoint_snapshot_key: string;
  worker_profile_snapshot_key: string;
  access_mode: RuntimeEndpointAccessMode;
  host_capability_ceiling: "codex-full-access" | "restricted";
  budget_units: number;
  slot_units: number;
  endpoint_concurrency_limit: number;
  work_order_digest: string;
  authorization_revision: number;
};

type WorkerRow = {
  worker_key: string;
  work_order_key: string;
  directory_snapshot_key: string;
  endpoint_snapshot_key: string;
  profile_snapshot_key: string;
  access_mode: RuntimeEndpointAccessMode;
  lifecycle_state:
    | "running"
    | "control-claimed"
    | "completed"
    | "cancelled"
    | "interrupted"
    | "recovery-required";
  created_revision: number;
  progress_sequence: number;
  handoff_digest: string | null;
  control_state:
    | "none"
    | "cancel-claimed"
    | "interrupt-claimed"
    | "committed"
    | "outcome-unknown";
  terminal_revision: number | null;
};

type EpochRow = {
  directory_epoch_key: string;
  activated_revision: number;
  retired_revision: number | null;
};

type EventRow = {
  event_id: number;
  revision: number;
  work_order_key: string;
  event_kind: string;
  lifecycle_state: string;
  effect_phase: string;
  category: string | null;
  claim_key: string | null;
};

const SCHEMA_VERSION = 1;
const TABLES = [
  "runtime_work_order_ledger_authorizations",
  "runtime_work_order_ledger_epochs",
  "runtime_work_order_ledger_events",
  "runtime_work_order_ledger_meta",
  "runtime_work_order_ledger_orders",
  "runtime_work_order_ledger_slots",
  "runtime_work_order_ledger_workers",
] as const;

const USER_SCHEMA_OBJECTS = {
  runtime_work_order_ledger_authorizations: {
    type: "table",
    tableName: "runtime_work_order_ledger_authorizations",
    sqlFingerprint:
      "sha256:56a06e739fc946f5e351e260a09685f3b6563274767240b9e2cf4db021a19c29",
  },
  runtime_work_order_ledger_authorizations_endpoint_idx: {
    type: "index",
    tableName: "runtime_work_order_ledger_authorizations",
    sqlFingerprint:
      "sha256:8bae3d0be4e2d2b94d19408da07b446da68c900381eba8758d8db16769a176cd",
  },
  runtime_work_order_ledger_epochs: {
    type: "table",
    tableName: "runtime_work_order_ledger_epochs",
    sqlFingerprint:
      "sha256:0755c37e4d7f067789f3e6c254ba9135641814b8c6a1bf1b882523edd70abb0c",
  },
  runtime_work_order_ledger_events: {
    type: "table",
    tableName: "runtime_work_order_ledger_events",
    sqlFingerprint:
      "sha256:c05928d311bee1a94dc67830dd8cb6211c399605648e691dd2e9252367173474",
  },
  runtime_work_order_ledger_events_order_revision_idx: {
    type: "index",
    tableName: "runtime_work_order_ledger_events",
    sqlFingerprint:
      "sha256:9490fb53869012f00ad60f64823860dc94ff6f55aa6923783cbbca886a81fadc",
  },
  runtime_work_order_ledger_meta: {
    type: "table",
    tableName: "runtime_work_order_ledger_meta",
    sqlFingerprint:
      "sha256:65fce56744d6446b7d9413c93d1ad989a0de07ac977dbb1ec90abdc9d0066294",
  },
  runtime_work_order_ledger_orders: {
    type: "table",
    tableName: "runtime_work_order_ledger_orders",
    sqlFingerprint:
      "sha256:510a5a8a6b8f3d2385458d9da3cc960797256391cf111ab76d322269875602e3",
  },
  runtime_work_order_ledger_orders_idempotency_uidx: {
    type: "index",
    tableName: "runtime_work_order_ledger_orders",
    sqlFingerprint:
      "sha256:dd9a629e393acf9a9489bc54cf9874305bb6e1de787bfe08b99a559f6243a631",
  },
  runtime_work_order_ledger_orders_worker_uidx: {
    type: "index",
    tableName: "runtime_work_order_ledger_orders",
    sqlFingerprint:
      "sha256:26995564c046ff7de993939aee365abdcab1c8510aeaf30c7eb1604aa7b5cab0",
  },
  runtime_work_order_ledger_slots: {
    type: "table",
    tableName: "runtime_work_order_ledger_slots",
    sqlFingerprint:
      "sha256:d603d4a3e04b3170d19e8e57e55789d1126e9411a7a0146a4f927dfaab5d9cb9",
  },
  runtime_work_order_ledger_slots_owned_endpoint_idx: {
    type: "index",
    tableName: "runtime_work_order_ledger_slots",
    sqlFingerprint:
      "sha256:1e82c17fb8c226517986daae38abf0404e8fc3a2075399de89fe3eb84ee4ec90",
  },
  runtime_work_order_ledger_workers: {
    type: "table",
    tableName: "runtime_work_order_ledger_workers",
    sqlFingerprint:
      "sha256:8083efa707bfa76ecbfc99198b84e784240e6590c95d6c34a70463b37507d9cb",
  },
  runtime_work_order_ledger_workers_order_uidx: {
    type: "index",
    tableName: "runtime_work_order_ledger_workers",
    sqlFingerprint:
      "sha256:3d9210f08b6c988ac233438c6c19e0054523b83f2d5d9efe16daffb475c339d0",
  },
} as const;

const SQLITE_OWNED_SCHEMA_OBJECTS = {
  sqlite_autoindex_runtime_work_order_ledger_authorizations_1: {
    type: "index",
    tableName: "runtime_work_order_ledger_authorizations",
    sqlFingerprint: null,
  },
  sqlite_autoindex_runtime_work_order_ledger_epochs_1: {
    type: "index",
    tableName: "runtime_work_order_ledger_epochs",
    sqlFingerprint: null,
  },
  sqlite_autoindex_runtime_work_order_ledger_orders_1: {
    type: "index",
    tableName: "runtime_work_order_ledger_orders",
    sqlFingerprint: null,
  },
  sqlite_autoindex_runtime_work_order_ledger_slots_1: {
    type: "index",
    tableName: "runtime_work_order_ledger_slots",
    sqlFingerprint: null,
  },
  sqlite_autoindex_runtime_work_order_ledger_workers_1: {
    type: "index",
    tableName: "runtime_work_order_ledger_workers",
    sqlFingerprint: null,
  },
  sqlite_sequence: {
    type: "table",
    tableName: "sqlite_sequence",
    sqlFingerprint:
      "sha256:4cb1eaf14467f226196148cb5688569660cb290d414bae4c1c450b149b62befd",
  },
} as const;

const SCHEMA_OBJECTS = {
  ...USER_SCHEMA_OBJECTS,
  ...SQLITE_OWNED_SCHEMA_OBJECTS,
} as const;

class RuntimeWorkOrderLedgerModule implements RuntimeWorkOrderLedger {
  readonly #database: DatabaseSync;
  readonly #directory: RuntimeEndpointDirectory;
  readonly #crashPoint: RuntimeWorkOrderLedgerCrashPoint | undefined;
  #closed = false;

  constructor(options: RuntimeWorkOrderLedgerOptions) {
    const validatedOptions = cloneFactoryOptions(options as unknown);
    this.#directory = validatedOptions.directory;
    this.#crashPoint = validatedOptions.crashPoint;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(validatedOptions.databasePath);
      this.#database = database;
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA trusted_schema = OFF");
      database.exec("PRAGMA busy_timeout = 5000");
      initializeSchema(database, this.#directory.snapshot().directorySnapshotKey);
      this.#assertDurableState(false);
      this.#bindDirectoryEpoch();
      this.#assertDurableState();
      this.#recoverClaimedEffects();
      this.#assertDurableState();
    } catch (error) {
      try {
        database?.close();
      } catch {
        // The fixed public failure is retained.
      }
      if (
        error instanceof RuntimeWorkOrderLedgerError ||
        error instanceof RuntimeWorkOrderLedgerCrashError
      ) {
        throw error;
      }
      throw new RuntimeWorkOrderLedgerError("storage-failed");
    }
  }

  coordinate(command: RuntimeWorkOrderLedgerCommand): RuntimeWorkOrderLedgerResult {
    return this.#publicOperation(() => {
      this.#assertOpen();
      this.#assertDurableState();
      if (!isRecord(command)) {
        throw new RuntimeWorkOrderLedgerError("command-invalid");
      }
      const kind = ownDataValue(command, "kind");
      if (typeof kind !== "string") {
        throw new RuntimeWorkOrderLedgerError("command-invalid");
      }
      switch (kind) {
        case "submit":
          assertCommandKeys(command, ["kind", "workOrder", "boundSupervisor"]);
          return this.#submit(
            ownDataValue(command, "workOrder") as RuntimeNeutralWorkOrder,
            ownDataValue(command, "boundSupervisor") as BoundSupervisorSession,
          );
        case "claim-start":
          assertCommandKeys(command, ["kind", "workOrderKey"]);
          return this.#claimStart(
            ownDataValue(command, "workOrderKey") as string,
          );
        case "confirm-start":
          assertCommandKeys(command, [
            "kind",
            "workOrderKey",
            "claimKey",
            "outcome",
          ]);
          return this.#confirmStart(
            ownDataValue(command, "workOrderKey") as string,
            ownDataValue(command, "claimKey") as string,
            ownDataValue(command, "outcome") as "started" | "failed",
          );
        case "cancel-before-start":
          assertCommandKeys(command, ["kind", "workOrderKey"]);
          return this.#cancelBeforeStart(
            ownDataValue(command, "workOrderKey") as string,
          );
        case "record-progress":
          assertCommandKeys(command, [
            "kind",
            "workOrderKey",
            "workerKey",
            "sequence",
          ]);
          return this.#recordProgress(
            ownDataValue(command, "workOrderKey") as string,
            ownDataValue(command, "workerKey") as string,
            ownDataValue(command, "sequence") as number,
          );
        case "record-handoff":
          assertCommandKeys(command, [
            "kind",
            "workOrderKey",
            "workerKey",
            "handoffKey",
          ]);
          return this.#recordHandoff(
            ownDataValue(command, "workOrderKey") as string,
            ownDataValue(command, "workerKey") as string,
            ownDataValue(command, "handoffKey") as string,
          );
        case "claim-control":
          assertCommandKeys(command, [
            "kind",
            "workOrderKey",
            "workerKey",
            "action",
          ]);
          return this.#claimControl(
            ownDataValue(command, "workOrderKey") as string,
            ownDataValue(command, "workerKey") as string,
            ownDataValue(command, "action") as "cancel" | "interrupt",
          );
        case "confirm-control":
          assertCommandKeys(command, [
            "kind",
            "workOrderKey",
            "workerKey",
            "claimKey",
            "outcome",
          ]);
          return this.#confirmControl(
            ownDataValue(command, "workOrderKey") as string,
            ownDataValue(command, "workerKey") as string,
            ownDataValue(command, "claimKey") as string,
            ownDataValue(command, "outcome") as "committed" | "failed",
          );
        default:
          throw new RuntimeWorkOrderLedgerError("command-invalid");
      }
    });
  }

  snapshot(): RuntimeWorkOrderLedgerSnapshot {
    return this.#publicOperation(() => {
      this.#assertOpen();
      this.#assertDurableState();
      return this.#readSnapshot();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
    } catch {
      throw new RuntimeWorkOrderLedgerError("storage-failed");
    }
  }

  #submit(
    workOrderInput: RuntimeNeutralWorkOrder,
    boundSupervisorInput: BoundSupervisorSession,
  ): RuntimeWorkOrderLedgerResult {
    const workOrder = cloneWorkOrder(workOrderInput as unknown);
    const boundSupervisor = cloneBoundSupervisor(boundSupervisorInput as unknown);
    const digest = digestWorkOrder(workOrder);
    const bindingDigest = digestBoundSupervisor(boundSupervisor);
    let row = this.#orderByIdempotencyKey(workOrder.idempotencyKey);

    if (row !== undefined) {
      if (
        row.work_order_digest !== digest ||
        row.supervisor_binding_digest !== bindingDigest
      ) {
        throw new RuntimeWorkOrderLedgerError("idempotency-conflict");
      }
      if (row.lifecycle_state !== "accepted") {
        return submissionResult(row);
      }
    } else {
      const workOrderKey = opaqueKey("rwok");
      const intentJson = JSON.stringify(workOrder);
      const bindingJson = JSON.stringify(boundSupervisor);
      transaction(this.#database, () => {
        const revision = nextRevision(this.#database);
        this.#database
          .prepare(
            `INSERT INTO runtime_work_order_ledger_orders (
               work_order_key, idempotency_key, work_order_digest,
               supervisor_binding_digest, intent_json, supervisor_binding_json,
               directory_epoch_key, endpoint_snapshot_key, profile_snapshot_key,
               requested_access_mode, lifecycle_state, effect_phase,
               denial_category, accepted_revision, authorization_revision,
               claim_revision, terminal_revision, active_claim_key,
               provisional_worker_key, worker_key, control_action,
               progress_sequence, handoff_digest
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'unclaimed',
                       NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)`,
          )
          .run(
            workOrderKey,
            workOrder.idempotencyKey,
            digest,
            bindingDigest,
            intentJson,
            bindingJson,
            workOrder.directorySnapshotKey,
            workOrder.endpointSnapshotKey,
            workOrder.profileSnapshotKey,
            workOrder.requestedAccessMode,
            revision,
          );
        this.#database
          .prepare(
            `INSERT INTO runtime_work_order_ledger_slots (
               work_order_key, slot_state, directory_snapshot_key,
               endpoint_snapshot_key, slot_units, acquired_revision,
               released_revision
             ) VALUES (?, 'unreserved', NULL, NULL, ?, NULL, NULL)`,
          )
          .run(workOrderKey, workOrder.concurrency.slots);
        appendEvent(
          this.#database,
          revision,
          workOrderKey,
          "accepted",
          "accepted",
          "unclaimed",
        );
        this.#crash("before-acceptance-commit");
      });
      this.#crash("after-acceptance-before-authorization");
      row = this.#requiredOrder(workOrderKey);
    }

    let authorized;
    try {
      authorized = this.#directory.authorizeAcceptedWorkOrder(
        { state: "accepted", workOrder },
        boundSupervisor,
      );
    } catch (error) {
      if (!(error instanceof RuntimeEndpointDirectoryError)) throw error;
      return this.#recordDenial(row, error.category);
    }
    if (authorized.workOrderDigest !== digest) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    this.#crash("after-authorization-before-slot-commit");

    const result = transaction(this.#database, () => {
      const current = this.#requiredOrder(row.work_order_key);
      if (current.lifecycle_state !== "accepted") {
        return submissionResult(current);
      }
      const owned = this.#ownedUnits(
        authorized.directorySnapshotKey,
        authorized.worker.endpointSnapshotKey,
      );
      if (
        owned + authorized.authorization.concurrencySlots >
        authorized.authorization.endpointConcurrencyLimit
      ) {
        return this.#recordDenialInTransaction(
          current,
          "endpoint-capacity-denied",
        );
      }
      const revision = nextRevision(this.#database);
      this.#database
        .prepare(
          `INSERT INTO runtime_work_order_ledger_authorizations (
             work_order_key, directory_snapshot_key,
             supervisor_endpoint_snapshot_key, supervisor_profile_snapshot_key,
             worker_endpoint_snapshot_key, worker_profile_snapshot_key,
             access_mode, host_capability_ceiling, budget_units, slot_units,
             endpoint_concurrency_limit, work_order_digest,
             authorization_revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.work_order_key,
          authorized.directorySnapshotKey,
          authorized.supervisor.endpointSnapshotKey,
          authorized.supervisor.profileSnapshotKey,
          authorized.worker.endpointSnapshotKey,
          authorized.worker.profileSnapshotKey,
          authorized.authorization.accessMode,
          authorized.authorization.hostCapabilityCeiling,
          authorized.authorization.budgetUnits,
          authorized.authorization.concurrencySlots,
          authorized.authorization.endpointConcurrencyLimit,
          authorized.workOrderDigest,
          revision,
        );
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_slots
              SET slot_state = 'owned', directory_snapshot_key = ?,
                  endpoint_snapshot_key = ?, acquired_revision = ?
            WHERE work_order_key = ? AND slot_state = 'unreserved'`,
        )
        .run(
          authorized.directorySnapshotKey,
          authorized.worker.endpointSnapshotKey,
          revision,
          current.work_order_key,
        );
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = 'authorized', authorization_revision = ?
            WHERE work_order_key = ?`,
        )
        .run(revision, current.work_order_key);
      appendEvent(
        this.#database,
        revision,
        current.work_order_key,
        "authorized",
        "authorized",
        "unclaimed",
      );
      return deepFreeze<RuntimeWorkOrderLedgerResult>({
        kind: "submission",
        status: "authorized",
        workOrderKey: current.work_order_key,
        revision,
        denialCategory: null,
      });
    });
    this.#crash("after-slot-commit-before-effect-claim");
    this.#assertDurableState();
    return result;
  }

  #recordDenial(
    row: OrderRow,
    category: RuntimeWorkOrderDenialCategory,
  ): RuntimeWorkOrderLedgerResult {
    return transaction(this.#database, () =>
      this.#recordDenialInTransaction(this.#requiredOrder(row.work_order_key), category),
    );
  }

  #recordDenialInTransaction(
    row: OrderRow,
    category: RuntimeWorkOrderDenialCategory,
  ): RuntimeWorkOrderLedgerResult {
    if (row.lifecycle_state !== "accepted") {
      return submissionResult(row);
    }
    const revision = nextRevision(this.#database);
    this.#database
      .prepare(
        `UPDATE runtime_work_order_ledger_orders
            SET lifecycle_state = 'denied', effect_phase = 'committed',
                denial_category = ?, authorization_revision = ?,
                terminal_revision = ?
          WHERE work_order_key = ?`,
      )
      .run(category, revision, revision, row.work_order_key);
    appendEvent(
      this.#database,
      revision,
      row.work_order_key,
      "denied",
      "denied",
      "committed",
      category,
    );
    return deepFreeze({
      kind: "submission",
      status: "denied",
      workOrderKey: row.work_order_key,
      revision,
      denialCategory: category,
    });
  }

  #claimStart(workOrderKeyInput: string): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const row = this.#requiredOrder(workOrderKey);
    if (row.lifecycle_state !== "authorized") {
      throw new RuntimeWorkOrderLedgerError(
        row.lifecycle_state === "start-claimed"
          ? "claim-conflict"
          : "transition-invalid",
      );
    }
    const authorization = this.#requiredAuthorization(workOrderKey);
    const claimKey = opaqueKey("rwck");
    const workerKey = opaqueKey("rwwk");
    const revision = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (current.lifecycle_state !== "authorized") {
        throw new RuntimeWorkOrderLedgerError("claim-conflict");
      }
      const next = nextRevision(this.#database);
      const result = this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = 'start-claimed',
                  effect_phase = 'start-claimed', claim_revision = ?,
                  active_claim_key = ?, provisional_worker_key = ?
            WHERE work_order_key = ? AND lifecycle_state = 'authorized'`,
        )
        .run(next, claimKey, workerKey, workOrderKey);
      if (Number(result.changes) !== 1) {
        throw new RuntimeWorkOrderLedgerError("claim-conflict");
      }
      appendEvent(
        this.#database,
        next,
        workOrderKey,
        "start-claimed",
        "start-claimed",
        "start-claimed",
        null,
        claimKey,
      );
      return next;
    });
    this.#crash("after-effect-claim-before-external-acknowledgement");
    this.#assertDurableState();
    return deepFreeze({
      kind: "effect-intent",
      status: "claimed",
      workOrderKey,
      revision,
      effectIntent: {
        kind: "start-worker",
        claimKey,
        workOrderKey,
        workerKey,
        directorySnapshotKey:
          authorization.directory_snapshot_key as RuntimeDirectorySnapshotKey,
        endpointSnapshotKey:
          authorization.worker_endpoint_snapshot_key as RuntimeEndpointSnapshotKey,
        profileSnapshotKey:
          authorization.worker_profile_snapshot_key as RuntimeProfileSnapshotKey,
        accessMode: authorization.access_mode,
      },
    });
  }

  #confirmStart(
    workOrderKeyInput: string,
    claimKeyInput: string,
    outcome: "started" | "failed",
  ): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const claimKey = requiredOpaqueLedgerKey(claimKeyInput, "rwck");
    if (outcome !== "started" && outcome !== "failed") {
      throw new RuntimeWorkOrderLedgerError("command-invalid");
    }
    const existing = this.#requiredOrder(workOrderKey);
    if (
      existing.active_claim_key === claimKey &&
      ((outcome === "started" && existing.lifecycle_state === "running") ||
        (outcome === "failed" && existing.lifecycle_state === "failed"))
    ) {
      return transitionResult(
        existing,
        Number(existing.terminal_revision ?? existing.claim_revision),
      );
    }
    if (
      existing.lifecycle_state !== "start-claimed" ||
      existing.active_claim_key !== claimKey ||
      existing.provisional_worker_key === null
    ) {
      throw new RuntimeWorkOrderLedgerError("claim-conflict");
    }
    const authorization = this.#requiredAuthorization(workOrderKey);
    const workerKey = existing.provisional_worker_key;
    const transition = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (
        current.lifecycle_state !== "start-claimed" ||
        current.active_claim_key !== claimKey ||
        current.provisional_worker_key !== workerKey
      ) {
        throw new RuntimeWorkOrderLedgerError("claim-conflict");
      }
      const revision = nextRevision(this.#database);
      if (outcome === "failed") {
        this.#releaseSlot(workOrderKey, revision);
        this.#database
          .prepare(
            `UPDATE runtime_work_order_ledger_orders
                SET lifecycle_state = 'failed', effect_phase = 'committed',
                    terminal_revision = ?
              WHERE work_order_key = ?`,
          )
          .run(revision, workOrderKey);
        appendEvent(
          this.#database,
          revision,
          workOrderKey,
          "start-failed",
          "failed",
          "committed",
          null,
          claimKey,
        );
        return deepFreeze<RuntimeWorkOrderLedgerResult>({
          kind: "transition",
          status: "failed",
          workOrderKey,
          workerKey: null,
          revision,
        });
      }
      this.#database
        .prepare(
          `INSERT INTO runtime_work_order_ledger_workers (
             worker_key, work_order_key, directory_snapshot_key,
             endpoint_snapshot_key, profile_snapshot_key, access_mode,
             lifecycle_state, created_revision, progress_sequence,
             handoff_digest, control_state, terminal_revision
           ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 0, NULL, 'none', NULL)`,
        )
        .run(
          workerKey,
          workOrderKey,
          authorization.directory_snapshot_key,
          authorization.worker_endpoint_snapshot_key,
          authorization.worker_profile_snapshot_key,
          authorization.access_mode,
          revision,
        );
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = 'running', effect_phase = 'running',
                  worker_key = ?
            WHERE work_order_key = ?`,
        )
        .run(workerKey, workOrderKey);
      appendEvent(
        this.#database,
        revision,
        workOrderKey,
        "start-confirmed",
        "running",
        "running",
        null,
        claimKey,
      );
      return deepFreeze<RuntimeWorkOrderLedgerResult>({
        kind: "transition",
        status: "running",
        workOrderKey,
        workerKey,
        revision,
      });
    });
    if (outcome === "failed") {
      this.#crash("after-terminal-fact-before-response");
    }
    this.#assertDurableState();
    return transition;
  }

  #recordProgress(
    workOrderKeyInput: string,
    workerKeyInput: string,
    sequenceInput: number,
  ): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const workerKey = requiredOpaqueLedgerKey(workerKeyInput, "rwwk");
    if (!isInteger(sequenceInput, 1, Number.MAX_SAFE_INTEGER)) {
      throw new RuntimeWorkOrderLedgerError("command-invalid");
    }
    const row = this.#requiredOrder(workOrderKey);
    if (row.lifecycle_state !== "running" || row.worker_key !== workerKey) {
      throw new RuntimeWorkOrderLedgerError("worker-link-invalid");
    }
    if (sequenceInput === Number(row.progress_sequence)) {
      return transitionResult(row, currentRevision(this.#database));
    }
    if (sequenceInput !== Number(row.progress_sequence) + 1) {
      throw new RuntimeWorkOrderLedgerError("transition-invalid");
    }
    const revision = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (current.lifecycle_state !== "running" || current.worker_key !== workerKey) {
        throw new RuntimeWorkOrderLedgerError("worker-link-invalid");
      }
      const next = nextRevision(this.#database);
      this.#database
        .prepare(
          "UPDATE runtime_work_order_ledger_orders SET progress_sequence = ? WHERE work_order_key = ?",
        )
        .run(sequenceInput, workOrderKey);
      this.#database
        .prepare(
          "UPDATE runtime_work_order_ledger_workers SET progress_sequence = ? WHERE worker_key = ?",
        )
        .run(sequenceInput, workerKey);
      appendEvent(
        this.#database,
        next,
        workOrderKey,
        "progress",
        "running",
        "running",
      );
      return next;
    });
    this.#assertDurableState();
    return deepFreeze({
      kind: "transition",
      status: "running",
      workOrderKey,
      workerKey,
      revision,
    });
  }

  #recordHandoff(
    workOrderKeyInput: string,
    workerKeyInput: string,
    handoffKeyInput: string,
  ): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const workerKey = requiredOpaqueLedgerKey(workerKeyInput, "rwwk");
    if (!isIdentifier(handoffKeyInput, 8, 128)) {
      throw new RuntimeWorkOrderLedgerError("command-invalid");
    }
    const handoffDigest = prefixedDigest(handoffKeyInput);
    const existing = this.#requiredOrder(workOrderKey);
    if (existing.lifecycle_state === "completed") {
      if (
        existing.worker_key === workerKey &&
        existing.handoff_digest === handoffDigest
      ) {
        return transitionResult(existing, Number(existing.terminal_revision));
      }
      throw new RuntimeWorkOrderLedgerError("terminal-conflict");
    }
    if (existing.lifecycle_state !== "running" || existing.worker_key !== workerKey) {
      throw new RuntimeWorkOrderLedgerError("worker-link-invalid");
    }
    const result = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (current.lifecycle_state !== "running" || current.worker_key !== workerKey) {
        throw new RuntimeWorkOrderLedgerError("worker-link-invalid");
      }
      const revision = nextRevision(this.#database);
      this.#releaseSlot(workOrderKey, revision);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = 'completed', effect_phase = 'committed',
                  handoff_digest = ?, terminal_revision = ?
            WHERE work_order_key = ?`,
        )
        .run(handoffDigest, revision, workOrderKey);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_workers
              SET lifecycle_state = 'completed', handoff_digest = ?,
                  terminal_revision = ?
            WHERE worker_key = ? AND work_order_key = ?`,
        )
        .run(handoffDigest, revision, workerKey, workOrderKey);
      appendEvent(
        this.#database,
        revision,
        workOrderKey,
        "handoff",
        "completed",
        "committed",
      );
      return deepFreeze<RuntimeWorkOrderLedgerResult>({
        kind: "transition",
        status: "completed",
        workOrderKey,
        workerKey,
        revision,
      });
    });
    this.#crash("after-terminal-fact-before-response");
    this.#assertDurableState();
    return result;
  }

  #cancelBeforeStart(workOrderKeyInput: string): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const existing = this.#requiredOrder(workOrderKey);
    if (existing.lifecycle_state === "cancelled" && existing.worker_key === null) {
      return transitionResult(existing, Number(existing.terminal_revision));
    }
    if (existing.lifecycle_state !== "authorized") {
      throw new RuntimeWorkOrderLedgerError("transition-invalid");
    }
    const result = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (current.lifecycle_state !== "authorized") {
        throw new RuntimeWorkOrderLedgerError("transition-invalid");
      }
      const revision = nextRevision(this.#database);
      this.#releaseSlot(workOrderKey, revision);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = 'cancelled', effect_phase = 'committed',
                  terminal_revision = ?
            WHERE work_order_key = ?`,
        )
        .run(revision, workOrderKey);
      appendEvent(
        this.#database,
        revision,
        workOrderKey,
        "pre-start-cancelled",
        "cancelled",
        "committed",
      );
      return deepFreeze<RuntimeWorkOrderLedgerResult>({
        kind: "transition",
        status: "cancelled",
        workOrderKey,
        workerKey: null,
        revision,
      });
    });
    this.#crash("after-terminal-fact-before-response");
    this.#assertDurableState();
    return result;
  }

  #claimControl(
    workOrderKeyInput: string,
    workerKeyInput: string,
    action: "cancel" | "interrupt",
  ): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const workerKey = requiredOpaqueLedgerKey(workerKeyInput, "rwwk");
    if (action !== "cancel" && action !== "interrupt") {
      throw new RuntimeWorkOrderLedgerError("command-invalid");
    }
    const existing = this.#requiredOrder(workOrderKey);
    if (existing.lifecycle_state !== "running" || existing.worker_key !== workerKey) {
      throw new RuntimeWorkOrderLedgerError("worker-link-invalid");
    }
    const authorization = this.#requiredAuthorization(workOrderKey);
    const claimKey = opaqueKey("rwck");
    const revision = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (current.lifecycle_state !== "running" || current.worker_key !== workerKey) {
        throw new RuntimeWorkOrderLedgerError("worker-link-invalid");
      }
      const next = nextRevision(this.#database);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = 'control-claimed',
                  effect_phase = 'control-claimed', claim_revision = ?,
                  active_claim_key = ?, control_action = ?
            WHERE work_order_key = ?`,
        )
        .run(next, claimKey, action, workOrderKey);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_workers
              SET lifecycle_state = 'control-claimed', control_state = ?
            WHERE worker_key = ? AND work_order_key = ?`,
        )
        .run(
          action === "cancel" ? "cancel-claimed" : "interrupt-claimed",
          workerKey,
          workOrderKey,
        );
      appendEvent(
        this.#database,
        next,
        workOrderKey,
        `${action}-claimed`,
        "control-claimed",
        "control-claimed",
        action,
        claimKey,
      );
      return next;
    });
    this.#crash("after-effect-claim-before-external-acknowledgement");
    this.#assertDurableState();
    return deepFreeze({
      kind: "effect-intent",
      status: "claimed",
      workOrderKey,
      revision,
      effectIntent: {
        kind: action === "cancel" ? "cancel-worker" : "interrupt-worker",
        claimKey,
        workOrderKey,
        workerKey,
        directorySnapshotKey:
          authorization.directory_snapshot_key as RuntimeDirectorySnapshotKey,
        endpointSnapshotKey:
          authorization.worker_endpoint_snapshot_key as RuntimeEndpointSnapshotKey,
        profileSnapshotKey:
          authorization.worker_profile_snapshot_key as RuntimeProfileSnapshotKey,
        accessMode: authorization.access_mode,
      },
    });
  }

  #confirmControl(
    workOrderKeyInput: string,
    workerKeyInput: string,
    claimKeyInput: string,
    outcome: "committed" | "failed",
  ): RuntimeWorkOrderLedgerResult {
    const workOrderKey = requiredOpaqueLedgerKey(workOrderKeyInput, "rwok");
    const workerKey = requiredOpaqueLedgerKey(workerKeyInput, "rwwk");
    const claimKey = requiredOpaqueLedgerKey(claimKeyInput, "rwck");
    if (outcome !== "committed" && outcome !== "failed") {
      throw new RuntimeWorkOrderLedgerError("command-invalid");
    }
    const existing = this.#requiredOrder(workOrderKey);
    if (
      outcome === "committed" &&
      existing.active_claim_key === claimKey &&
      existing.worker_key === workerKey &&
      (existing.lifecycle_state === "cancelled" ||
        existing.lifecycle_state === "interrupted")
    ) {
      return transitionResult(existing, Number(existing.terminal_revision));
    }
    if (
      outcome === "failed" &&
      existing.active_claim_key === claimKey &&
      existing.worker_key === workerKey &&
      existing.lifecycle_state === "running" &&
      existing.control_action === null
    ) {
      return transitionResult(existing, currentRevision(this.#database));
    }
    if (
      existing.lifecycle_state !== "control-claimed" ||
      existing.worker_key !== workerKey ||
      existing.active_claim_key !== claimKey ||
      existing.control_action === null
    ) {
      throw new RuntimeWorkOrderLedgerError("claim-conflict");
    }
    const action = existing.control_action;
    const result = transaction(this.#database, () => {
      const current = this.#requiredOrder(workOrderKey);
      if (
        current.lifecycle_state !== "control-claimed" ||
        current.worker_key !== workerKey ||
        current.active_claim_key !== claimKey ||
        current.control_action !== action
      ) {
        throw new RuntimeWorkOrderLedgerError("claim-conflict");
      }
      const revision = nextRevision(this.#database);
      if (outcome === "failed") {
        this.#database
          .prepare(
            `UPDATE runtime_work_order_ledger_orders
                SET lifecycle_state = 'running', effect_phase = 'running',
                    control_action = NULL
              WHERE work_order_key = ?`,
          )
          .run(workOrderKey);
        this.#database
          .prepare(
            `UPDATE runtime_work_order_ledger_workers
                SET lifecycle_state = 'running', control_state = 'none'
              WHERE worker_key = ? AND work_order_key = ?`,
          )
          .run(workerKey, workOrderKey);
        appendEvent(
          this.#database,
          revision,
          workOrderKey,
          `${action}-failed`,
          "running",
          "running",
          action,
          claimKey,
        );
        return deepFreeze<RuntimeWorkOrderLedgerResult>({
          kind: "transition",
          status: "running",
          workOrderKey,
          workerKey,
          revision,
        });
      }
      const terminal = action === "cancel" ? "cancelled" : "interrupted";
      this.#releaseSlot(workOrderKey, revision);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_orders
              SET lifecycle_state = ?, effect_phase = 'committed',
                  terminal_revision = ?
            WHERE work_order_key = ?`,
        )
        .run(terminal, revision, workOrderKey);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_workers
              SET lifecycle_state = ?, control_state = 'committed',
                  terminal_revision = ?
            WHERE worker_key = ? AND work_order_key = ?`,
        )
        .run(terminal, revision, workerKey, workOrderKey);
      appendEvent(
        this.#database,
        revision,
        workOrderKey,
        terminal,
        terminal,
        "committed",
        action,
        claimKey,
      );
      return deepFreeze<RuntimeWorkOrderLedgerResult>({
        kind: "transition",
        status: terminal,
        workOrderKey,
        workerKey,
        revision,
      });
    });
    if (outcome === "committed") {
      this.#crash("after-terminal-fact-before-response");
    }
    this.#assertDurableState();
    return result;
  }

  #releaseSlot(workOrderKey: string, revision: number): void {
    const slot = this.#database
      .prepare(
        "SELECT * FROM runtime_work_order_ledger_slots WHERE work_order_key = ?",
      )
      .get(workOrderKey) as SlotRow | undefined;
    if (
      slot === undefined ||
      slot.slot_state !== "owned" ||
      slot.acquired_revision === null ||
      Number(slot.acquired_revision) >= revision ||
      slot.released_revision !== null
    ) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    const result = this.#database
      .prepare(
        `UPDATE runtime_work_order_ledger_slots
            SET slot_state = 'released', released_revision = ?
          WHERE work_order_key = ? AND slot_state = 'owned'
            AND released_revision IS NULL`,
      )
      .run(revision, workOrderKey);
    if (Number(result.changes) !== 1) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
  }

  #requiredAuthorization(workOrderKey: string): AuthorizationRow {
    const row = this.#database
      .prepare(
        "SELECT * FROM runtime_work_order_ledger_authorizations WHERE work_order_key = ?",
      )
      .get(workOrderKey) as AuthorizationRow | undefined;
    if (row === undefined) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    return row;
  }

  #ownedUnits(
    directorySnapshotKey: RuntimeDirectorySnapshotKey,
    endpointSnapshotKey: RuntimeEndpointSnapshotKey,
  ): number {
    const row = this.#database
      .prepare(
        `SELECT COALESCE(SUM(slot_units), 0) AS units
           FROM runtime_work_order_ledger_slots
          WHERE slot_state = 'owned'
            AND directory_snapshot_key = ?
            AND endpoint_snapshot_key = ?`,
      )
      .get(directorySnapshotKey, endpointSnapshotKey) as { units: number };
    return Number(row.units);
  }

  #orderByIdempotencyKey(idempotencyKey: string): OrderRow | undefined {
    return this.#database
      .prepare(
        "SELECT * FROM runtime_work_order_ledger_orders WHERE idempotency_key = ?",
      )
      .get(idempotencyKey) as OrderRow | undefined;
  }

  #requiredOrder(workOrderKey: string): OrderRow {
    const row = this.#database
      .prepare(
        "SELECT * FROM runtime_work_order_ledger_orders WHERE work_order_key = ?",
      )
      .get(workOrderKey) as OrderRow | undefined;
    if (row === undefined) {
      throw new RuntimeWorkOrderLedgerError("work-order-not-found");
    }
    return row;
  }

  #bindDirectoryEpoch(): void {
    const supplied = this.#directory.snapshot().directorySnapshotKey;
    const meta = readMeta(this.#database);
    if (meta.current_directory_epoch_key === supplied) return;
    const surviving = this.#database
      .prepare(
        `SELECT 1
           FROM runtime_work_order_ledger_orders AS orders
           JOIN runtime_work_order_ledger_slots AS slots
             ON slots.work_order_key = orders.work_order_key
          WHERE slots.slot_state = 'owned'
             OR orders.lifecycle_state NOT IN (
               'denied', 'completed', 'failed', 'cancelled', 'interrupted'
             )
          LIMIT 1`,
      )
      .get();
    if (surviving !== undefined) {
      throw new RuntimeWorkOrderLedgerError(
        "directory-reconciliation-required",
      );
    }
    transaction(this.#database, () => {
      const revision = nextRevision(this.#database);
      this.#database
        .prepare(
          `UPDATE runtime_work_order_ledger_epochs
              SET retired_revision = ?
            WHERE directory_epoch_key = ? AND retired_revision IS NULL`,
        )
        .run(revision, meta.current_directory_epoch_key);
      this.#database
        .prepare(
          `INSERT INTO runtime_work_order_ledger_epochs (
             directory_epoch_key, activated_revision, retired_revision
           ) VALUES (?, ?, NULL)`,
        )
        .run(supplied, revision);
      this.#database
        .prepare(
          "UPDATE runtime_work_order_ledger_meta SET current_directory_epoch_key = ? WHERE singleton = 1",
        )
        .run(supplied);
    });
  }

  #recoverClaimedEffects(): void {
    const claimed = this.#database
      .prepare(
        `SELECT work_order_key, lifecycle_state, worker_key,
                active_claim_key, control_action
           FROM runtime_work_order_ledger_orders
          WHERE lifecycle_state IN ('start-claimed', 'control-claimed')
          ORDER BY accepted_revision`,
      )
      .all() as unknown as Array<{
      work_order_key: string;
      lifecycle_state: "start-claimed" | "control-claimed";
      worker_key: string | null;
      active_claim_key: string | null;
      control_action: "cancel" | "interrupt" | null;
    }>;
    if (claimed.length === 0) return;
    transaction(this.#database, () => {
      const revision = nextRevision(this.#database);
      for (const row of claimed) {
        if (
          row.active_claim_key === null ||
          (row.lifecycle_state === "start-claimed" && row.worker_key !== null) ||
          (row.lifecycle_state === "control-claimed" &&
            (row.worker_key === null || row.control_action === null))
        ) {
          throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
        }
        this.#database
          .prepare(
            `UPDATE runtime_work_order_ledger_orders
                SET lifecycle_state = 'recovery-required',
                    effect_phase = 'outcome-unknown'
              WHERE work_order_key = ?`,
          )
          .run(row.work_order_key);
        if (row.worker_key !== null) {
          const workerUpdate = this.#database
            .prepare(
              `UPDATE runtime_work_order_ledger_workers
                  SET lifecycle_state = 'recovery-required',
                      control_state = 'outcome-unknown'
                WHERE worker_key = ? AND work_order_key = ?`,
            )
            .run(row.worker_key, row.work_order_key);
          if (Number(workerUpdate.changes) !== 1) {
            throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
          }
        }
        appendEvent(
          this.#database,
          revision,
          row.work_order_key,
          "outcome-unknown",
          "recovery-required",
          "outcome-unknown",
          row.control_action,
          row.active_claim_key,
        );
      }
    });
  }

  #assertDurableState(validateCurrentDirectory = true): void {
    assertSchema(this.#database);
    const meta = readMeta(this.#database);
    if (
      meta.schema_version !== SCHEMA_VERSION ||
      !Number.isSafeInteger(meta.revision) ||
      meta.revision < 0 ||
      !isOpaqueKey(meta.current_directory_epoch_key, "rtdk")
    ) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    const foreignKeys = this.#database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    assertEpochRows(this.#database, meta);
    const orders = this.#database
      .prepare("SELECT * FROM runtime_work_order_ledger_orders ORDER BY accepted_revision")
      .all() as unknown as OrderRow[];
    const orderKeys = new Set(orders.map((order) => order.work_order_key));
    assertEventRows(this.#database, meta.revision, orderKeys);
    for (const order of orders) {
      const workOrder = parseWorkOrder(order.intent_json);
      const boundSupervisor = parseBoundSupervisor(order.supervisor_binding_json);
      if (
        order.work_order_digest !== digestWorkOrder(workOrder) ||
        order.supervisor_binding_digest !== digestBoundSupervisor(boundSupervisor) ||
        order.idempotency_key !== workOrder.idempotencyKey ||
        order.directory_epoch_key !== workOrder.directorySnapshotKey ||
        order.endpoint_snapshot_key !== workOrder.endpointSnapshotKey ||
        order.profile_snapshot_key !== workOrder.profileSnapshotKey ||
        order.requested_access_mode !== workOrder.requestedAccessMode
      ) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
      const slot = this.#database
        .prepare(
          "SELECT * FROM runtime_work_order_ledger_slots WHERE work_order_key = ?",
        )
        .get(order.work_order_key) as SlotRow | undefined;
      const authorization = this.#database
        .prepare(
          "SELECT * FROM runtime_work_order_ledger_authorizations WHERE work_order_key = ?",
        )
        .get(order.work_order_key) as AuthorizationRow | undefined;
      const workers = this.#database
        .prepare(
          "SELECT * FROM runtime_work_order_ledger_workers WHERE work_order_key = ? ORDER BY worker_key",
        )
        .all(order.work_order_key) as unknown as WorkerRow[];
      if (slot === undefined || Number(slot.slot_units) !== workOrder.concurrency.slots) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
      assertStoredOrderRelations(
        order,
        slot,
        authorization,
        workers,
        workOrder,
        meta.revision,
      );
      if (
        validateCurrentDirectory &&
        order.directory_epoch_key === meta.current_directory_epoch_key
      ) {
        this.#assertCurrentEpochAuthorization(
          order,
          slot,
          workOrder,
          boundSupervisor,
          authorization,
          workers[0],
        );
      }
    }
    const overLimit = this.#database
      .prepare(
        `SELECT 1
           FROM runtime_work_order_ledger_slots AS slots
           JOIN runtime_work_order_ledger_authorizations AS authorization
             ON authorization.work_order_key = slots.work_order_key
          WHERE slots.slot_state = 'owned'
          GROUP BY slots.directory_snapshot_key, slots.endpoint_snapshot_key
         HAVING SUM(slots.slot_units) > MIN(authorization.endpoint_concurrency_limit)
             OR MIN(authorization.endpoint_concurrency_limit) <>
                MAX(authorization.endpoint_concurrency_limit)
          LIMIT 1`,
      )
      .get();
    if (overLimit !== undefined) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
  }

  #assertCurrentEpochAuthorization(
    order: OrderRow,
    slot: SlotRow,
    workOrder: RuntimeNeutralWorkOrder,
    boundSupervisor: BoundSupervisorSession,
    authorization: AuthorizationRow | undefined,
    worker: WorkerRow | undefined,
  ): void {
    if (order.lifecycle_state === "accepted") {
      if (
        slot.slot_state !== "unreserved" ||
        slot.directory_snapshot_key !== null ||
        slot.endpoint_snapshot_key !== null ||
        slot.acquired_revision !== null ||
        slot.released_revision !== null
      ) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
      return;
    }
    if (order.lifecycle_state === "denied") {
      if (slot.slot_state !== "unreserved" || order.denial_category === null) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
      return;
    }
    let authorized;
    try {
      authorized = this.#directory.authorizeAcceptedWorkOrder(
        { state: "accepted", workOrder },
        boundSupervisor,
      );
    } catch {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    if (
      authorization === undefined ||
      authorization.work_order_digest !== authorized.workOrderDigest ||
      authorization.directory_snapshot_key !== authorized.directorySnapshotKey ||
      authorization.worker_endpoint_snapshot_key !== authorized.worker.endpointSnapshotKey ||
      authorization.worker_profile_snapshot_key !== authorized.worker.profileSnapshotKey ||
      authorization.supervisor_endpoint_snapshot_key !== authorized.supervisor.endpointSnapshotKey ||
      authorization.supervisor_profile_snapshot_key !== authorized.supervisor.profileSnapshotKey ||
      authorization.access_mode !== authorized.authorization.accessMode ||
      authorization.host_capability_ceiling !==
        authorized.authorization.hostCapabilityCeiling ||
      Number(authorization.budget_units) !==
        authorized.authorization.budgetUnits ||
      Number(authorization.slot_units) !== authorized.authorization.concurrencySlots ||
      Number(authorization.endpoint_concurrency_limit) !==
        authorized.authorization.endpointConcurrencyLimit ||
      slot.directory_snapshot_key !== authorized.directorySnapshotKey ||
      slot.endpoint_snapshot_key !== authorized.worker.endpointSnapshotKey ||
      Number(slot.acquired_revision) !== Number(order.authorization_revision)
    ) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    const releasedLifecycle = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(order.lifecycle_state);
    if (
      (releasedLifecycle &&
        (slot.slot_state !== "released" ||
          slot.released_revision === null ||
          Number(slot.released_revision) !== Number(order.terminal_revision) ||
          Number(slot.released_revision) <= Number(slot.acquired_revision))) ||
      (!releasedLifecycle &&
        (slot.slot_state !== "owned" || slot.released_revision !== null))
    ) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    const expectedPhase: RuntimeWorkOrderEffectPhase =
      order.lifecycle_state === "authorized"
        ? "unclaimed"
        : order.lifecycle_state === "start-claimed"
          ? "start-claimed"
          : order.lifecycle_state === "running"
            ? "running"
            : order.lifecycle_state === "control-claimed"
              ? "control-claimed"
              : order.lifecycle_state === "recovery-required"
                ? "outcome-unknown"
                : "committed";
    if (order.effect_phase !== expectedPhase) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    if (
      ["running", "control-claimed", "completed", "interrupted"].includes(
        order.lifecycle_state,
      ) &&
      worker === undefined
    ) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
    if (worker !== undefined) {
      if (
        worker.work_order_key !== order.work_order_key ||
        worker.directory_snapshot_key !== authorization.directory_snapshot_key ||
        worker.endpoint_snapshot_key !== authorization.worker_endpoint_snapshot_key ||
        worker.profile_snapshot_key !== authorization.worker_profile_snapshot_key ||
        worker.access_mode !== authorization.access_mode ||
        Number(worker.progress_sequence) !== Number(order.progress_sequence) ||
        worker.handoff_digest !== order.handoff_digest ||
        worker.lifecycle_state !== order.lifecycle_state
      ) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
      if (
        order.lifecycle_state === "completed" &&
        (worker.handoff_digest === null || worker.terminal_revision !== order.terminal_revision)
      ) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
    }
  }

  #readSnapshot(): RuntimeWorkOrderLedgerSnapshot {
    const meta = readMeta(this.#database);
    const rows = this.#database
      .prepare(
        `SELECT orders.*, slots.slot_state, slots.slot_units,
                slots.acquired_revision AS slot_acquired_revision,
                slots.released_revision AS slot_released_revision
           FROM runtime_work_order_ledger_orders AS orders
           JOIN runtime_work_order_ledger_slots AS slots
             ON slots.work_order_key = orders.work_order_key
          ORDER BY orders.accepted_revision, orders.work_order_key`,
      )
      .all() as unknown as Array<OrderRow & {
      slot_state: RuntimeWorkOrderSlotState;
      slot_units: number;
      slot_acquired_revision: number | null;
      slot_released_revision: number | null;
    }>;
    const orders = rows.map((row): RuntimeWorkOrderLedgerOrderSnapshot => {
      const worker = row.worker_key === null
        ? undefined
        : (this.#database
            .prepare(
              "SELECT * FROM runtime_work_order_ledger_workers WHERE worker_key = ?",
            )
            .get(row.worker_key) as WorkerRow | undefined);
      if (row.worker_key !== null && worker === undefined) {
        throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
      }
      return {
        workOrderKey: row.work_order_key,
        directorySnapshotKey: row.directory_epoch_key as RuntimeDirectorySnapshotKey,
        endpointSnapshotKey: row.endpoint_snapshot_key as RuntimeEndpointSnapshotKey,
        profileSnapshotKey: row.profile_snapshot_key as RuntimeProfileSnapshotKey,
        requestedAccessMode: row.requested_access_mode,
        lifecycle: row.lifecycle_state,
        effectPhase: row.effect_phase,
        denialCategory: row.denial_category,
        slot: {
          state: row.slot_state,
          units: Number(row.slot_units),
          acquiredRevision:
            row.slot_acquired_revision === null
              ? null
              : Number(row.slot_acquired_revision),
          releasedRevision:
            row.slot_released_revision === null
              ? null
              : Number(row.slot_released_revision),
        },
        worker: worker === undefined
          ? null
          : {
              workerKey: worker.worker_key,
              lifecycle: worker.lifecycle_state,
              progressSequence: Number(worker.progress_sequence),
              handoffState: worker.handoff_digest === null ? "none" : "recorded",
              controlState: worker.control_state,
            },
      };
    });
    return deepFreeze({
      revision: Number(meta.revision),
      directorySnapshotKey:
        meta.current_directory_epoch_key as RuntimeDirectorySnapshotKey,
      orders,
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new RuntimeWorkOrderLedgerError("ledger-closed");
  }

  #crash(point: RuntimeWorkOrderLedgerCrashPoint): void {
    if (this.#crashPoint === point) {
      throw new RuntimeWorkOrderLedgerCrashError(point);
    }
  }

  #publicOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof RuntimeWorkOrderLedgerError ||
        error instanceof RuntimeWorkOrderLedgerCrashError
      ) {
        throw error;
      }
      throw new RuntimeWorkOrderLedgerError("storage-failed");
    }
  }
}

export function createRuntimeWorkOrderLedger(
  options: RuntimeWorkOrderLedgerOptions,
): RuntimeWorkOrderLedger {
  return new RuntimeWorkOrderLedgerModule(options);
}

function initializeSchema(
  database: DatabaseSync,
  directorySnapshotKey: RuntimeDirectorySnapshotKey,
): void {
  const existingObjects = readSchemaObjects(database);
  const existing = readUserTables(database);
  if (existingObjects.length === 0) {
    transaction(database, () => {
      database.exec(`
        CREATE TABLE runtime_work_order_ledger_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          current_directory_epoch_key TEXT NOT NULL
        ) STRICT;
        CREATE TABLE runtime_work_order_ledger_epochs (
          directory_epoch_key TEXT PRIMARY KEY,
          activated_revision INTEGER NOT NULL CHECK (activated_revision >= 0),
          retired_revision INTEGER CHECK (
            retired_revision IS NULL OR retired_revision > activated_revision
          )
        ) STRICT;
        CREATE TABLE runtime_work_order_ledger_orders (
          work_order_key TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          work_order_digest TEXT NOT NULL,
          supervisor_binding_digest TEXT NOT NULL,
          intent_json TEXT NOT NULL,
          supervisor_binding_json TEXT NOT NULL,
          directory_epoch_key TEXT NOT NULL REFERENCES runtime_work_order_ledger_epochs(directory_epoch_key),
          endpoint_snapshot_key TEXT NOT NULL,
          profile_snapshot_key TEXT NOT NULL,
          requested_access_mode TEXT NOT NULL CHECK (requested_access_mode IN ('full-access', 'restricted')),
          lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('accepted', 'denied', 'authorized', 'start-claimed', 'running', 'control-claimed', 'completed', 'failed', 'cancelled', 'interrupted', 'recovery-required')),
          effect_phase TEXT NOT NULL CHECK (effect_phase IN ('unclaimed', 'start-claimed', 'running', 'control-claimed', 'committed', 'outcome-unknown')),
          denial_category TEXT,
          accepted_revision INTEGER NOT NULL CHECK (accepted_revision > 0),
          authorization_revision INTEGER,
          claim_revision INTEGER,
          terminal_revision INTEGER,
          active_claim_key TEXT,
          provisional_worker_key TEXT,
          worker_key TEXT,
          control_action TEXT CHECK (control_action IS NULL OR control_action IN ('cancel', 'interrupt')),
          progress_sequence INTEGER NOT NULL CHECK (progress_sequence >= 0),
          handoff_digest TEXT
        ) STRICT;
        CREATE TABLE runtime_work_order_ledger_authorizations (
          work_order_key TEXT PRIMARY KEY REFERENCES runtime_work_order_ledger_orders(work_order_key),
          directory_snapshot_key TEXT NOT NULL,
          supervisor_endpoint_snapshot_key TEXT NOT NULL,
          supervisor_profile_snapshot_key TEXT NOT NULL,
          worker_endpoint_snapshot_key TEXT NOT NULL,
          worker_profile_snapshot_key TEXT NOT NULL,
          access_mode TEXT NOT NULL CHECK (access_mode IN ('full-access', 'restricted')),
          host_capability_ceiling TEXT NOT NULL CHECK (host_capability_ceiling IN ('codex-full-access', 'restricted')),
          budget_units INTEGER NOT NULL CHECK (budget_units >= 0),
          slot_units INTEGER NOT NULL CHECK (slot_units > 0),
          endpoint_concurrency_limit INTEGER NOT NULL CHECK (endpoint_concurrency_limit >= 0),
          work_order_digest TEXT NOT NULL,
          authorization_revision INTEGER NOT NULL CHECK (authorization_revision > 0)
        ) STRICT;
        CREATE TABLE runtime_work_order_ledger_slots (
          work_order_key TEXT PRIMARY KEY REFERENCES runtime_work_order_ledger_orders(work_order_key),
          slot_state TEXT NOT NULL CHECK (slot_state IN ('unreserved', 'owned', 'released')),
          directory_snapshot_key TEXT,
          endpoint_snapshot_key TEXT,
          slot_units INTEGER NOT NULL CHECK (slot_units > 0),
          acquired_revision INTEGER,
          released_revision INTEGER
        ) STRICT;
        CREATE TABLE runtime_work_order_ledger_workers (
          worker_key TEXT PRIMARY KEY,
          work_order_key TEXT NOT NULL REFERENCES runtime_work_order_ledger_orders(work_order_key),
          directory_snapshot_key TEXT NOT NULL,
          endpoint_snapshot_key TEXT NOT NULL,
          profile_snapshot_key TEXT NOT NULL,
          access_mode TEXT NOT NULL CHECK (access_mode IN ('full-access', 'restricted')),
          lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('running', 'control-claimed', 'completed', 'cancelled', 'interrupted', 'recovery-required')),
          created_revision INTEGER NOT NULL CHECK (created_revision > 0),
          progress_sequence INTEGER NOT NULL CHECK (progress_sequence >= 0),
          handoff_digest TEXT,
          control_state TEXT NOT NULL CHECK (control_state IN ('none', 'cancel-claimed', 'interrupt-claimed', 'committed', 'outcome-unknown')),
          terminal_revision INTEGER
        ) STRICT;
        CREATE TABLE runtime_work_order_ledger_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          work_order_key TEXT NOT NULL REFERENCES runtime_work_order_ledger_orders(work_order_key),
          event_kind TEXT NOT NULL,
          lifecycle_state TEXT NOT NULL,
          effect_phase TEXT NOT NULL,
          category TEXT,
          claim_key TEXT
        ) STRICT;
        CREATE UNIQUE INDEX runtime_work_order_ledger_orders_idempotency_uidx
          ON runtime_work_order_ledger_orders(idempotency_key);
        CREATE UNIQUE INDEX runtime_work_order_ledger_orders_worker_uidx
          ON runtime_work_order_ledger_orders(worker_key)
          WHERE worker_key IS NOT NULL;
        CREATE INDEX runtime_work_order_ledger_authorizations_endpoint_idx
          ON runtime_work_order_ledger_authorizations(directory_snapshot_key, worker_endpoint_snapshot_key);
        CREATE INDEX runtime_work_order_ledger_slots_owned_endpoint_idx
          ON runtime_work_order_ledger_slots(slot_state, directory_snapshot_key, endpoint_snapshot_key);
        CREATE UNIQUE INDEX runtime_work_order_ledger_workers_order_uidx
          ON runtime_work_order_ledger_workers(work_order_key);
        CREATE INDEX runtime_work_order_ledger_events_order_revision_idx
          ON runtime_work_order_ledger_events(work_order_key, revision);
      `);
      database
        .prepare(
          `INSERT INTO runtime_work_order_ledger_meta (
             singleton, schema_version, revision, current_directory_epoch_key
           ) VALUES (1, ?, 0, ?)`,
        )
        .run(SCHEMA_VERSION, directorySnapshotKey);
      database
        .prepare(
          `INSERT INTO runtime_work_order_ledger_epochs (
             directory_epoch_key, activated_revision, retired_revision
           ) VALUES (?, 0, NULL)`,
        )
        .run(directorySnapshotKey);
    });
    return;
  }
  if (!sameStrings(existing, [...TABLES])) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  assertSchema(database);
}

function assertSchema(database: DatabaseSync): void {
  if (!sameStrings(readUserTables(database), [...TABLES])) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  for (const table of TABLES) {
    const row = database
      .prepare(
        "SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?",
      )
      .get(table) as { strict: number } | undefined;
    if (row === undefined || Number(row.strict) !== 1) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
  }
  const objects = readSchemaObjects(database);
  const expectedNames = Object.keys(SCHEMA_OBJECTS).sort();
  if (!sameStrings(objects.map((row) => row.name), expectedNames)) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  for (const row of objects) {
    const expected = SCHEMA_OBJECTS[
      row.name as keyof typeof SCHEMA_OBJECTS
    ];
    if (
      expected === undefined ||
      row.type !== expected.type ||
      row.tableName !== expected.tableName ||
      (row.sql === null
        ? null
        : prefixedDigest(row.sql.replace(/\s+/gu, " ").trim())) !==
        expected.sqlFingerprint
    ) {
      throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
    }
  }
}

function readSchemaObjects(database: DatabaseSync): Array<{
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
}> {
  return database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_master
        ORDER BY name`,
    )
    .all() as unknown as Array<{
    type: string;
    name: string;
    tableName: string;
    sql: string | null;
  }>;
}

function readUserTables(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>
  ).map((row) => row.name);
}

function readMeta(database: DatabaseSync): {
  singleton: number;
  schema_version: number;
  revision: number;
  current_directory_epoch_key: string;
} {
  const rows = database
    .prepare(
      "SELECT singleton, schema_version, revision, current_directory_epoch_key FROM runtime_work_order_ledger_meta",
    )
    .all() as unknown as Array<{
    singleton: number;
    schema_version: number;
    revision: number;
    current_directory_epoch_key: string;
  }>;
  if (rows.length !== 1) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  const row = rows[0];
  if (row === undefined) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  if (Number(row.singleton) !== 1) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  return row;
}

function assertEpochRows(
  database: DatabaseSync,
  meta: ReturnType<typeof readMeta>,
): void {
  const epochs = database
    .prepare(
      "SELECT * FROM runtime_work_order_ledger_epochs ORDER BY activated_revision, directory_epoch_key",
    )
    .all() as unknown as EpochRow[];
  assertDurable(epochs.length > 0);
  for (const [index, epoch] of epochs.entries()) {
    assertDurable(
      isOpaqueKey(epoch.directory_epoch_key, "rtdk") &&
        isInteger(Number(epoch.activated_revision), 0, meta.revision),
    );
    if (index === 0) assertDurable(Number(epoch.activated_revision) === 0);
    const next = epochs[index + 1];
    if (next === undefined) {
      assertDurable(
        epoch.directory_epoch_key === meta.current_directory_epoch_key &&
          epoch.retired_revision === null,
      );
    } else {
      assertDurable(
        isInteger(Number(epoch.retired_revision), 1, meta.revision) &&
          Number(epoch.retired_revision) === Number(next.activated_revision) &&
          Number(next.activated_revision) > Number(epoch.activated_revision),
      );
    }
  }
}

function assertEventRows(
  database: DatabaseSync,
  metaRevision: number,
  orderKeys: ReadonlySet<string>,
): void {
  const events = database
    .prepare(
      "SELECT * FROM runtime_work_order_ledger_events ORDER BY event_id",
    )
    .all() as unknown as EventRow[];
  const lifecycles: readonly string[] = [
    "accepted",
    "denied",
    "authorized",
    "start-claimed",
    "running",
    "control-claimed",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "recovery-required",
  ];
  const effectPhases: readonly string[] = [
    "unclaimed",
    "start-claimed",
    "running",
    "control-claimed",
    "committed",
    "outcome-unknown",
  ];
  const acceptedKeys = new Set<string>();
  for (const event of events) {
    assertDurable(
      isInteger(Number(event.event_id), 1, Number.MAX_SAFE_INTEGER) &&
        isInteger(Number(event.revision), 1, metaRevision) &&
        isLedgerOpaqueKey(event.work_order_key, "rwok") &&
        orderKeys.has(event.work_order_key) &&
        isIdentifier(event.event_kind, 1, 64) &&
        lifecycles.includes(event.lifecycle_state) &&
        effectPhases.includes(event.effect_phase) &&
        (event.category === null || isIdentifier(event.category, 1, 128)) &&
        (event.claim_key === null ||
          isLedgerOpaqueKey(event.claim_key, "rwck")),
    );
    if (event.event_kind === "accepted") {
      assertDurable(!acceptedKeys.has(event.work_order_key));
      acceptedKeys.add(event.work_order_key);
    }
  }
  assertDurable(
    acceptedKeys.size === orderKeys.size &&
      [...orderKeys].every((key) => acceptedKeys.has(key)),
  );
}

function assertStoredOrderRelations(
  order: OrderRow,
  slot: SlotRow,
  authorization: AuthorizationRow | undefined,
  workers: readonly WorkerRow[],
  workOrder: RuntimeNeutralWorkOrder,
  metaRevision: number,
): void {
  assertDurable(
    isLedgerOpaqueKey(order.work_order_key, "rwok") &&
      isPrefixedSha256(order.work_order_digest) &&
      isPrefixedSha256(order.supervisor_binding_digest) &&
      isOpaqueKey(order.directory_epoch_key, "rtdk") &&
      isOpaqueKey(order.endpoint_snapshot_key, "rtek") &&
      isOpaqueKey(order.profile_snapshot_key, "rtpk") &&
      isInteger(Number(order.accepted_revision), 1, metaRevision) &&
      isInteger(Number(order.progress_sequence), 0, Number.MAX_SAFE_INTEGER) &&
      slot.work_order_key === order.work_order_key &&
      isInteger(Number(slot.slot_units), 1, 1_000_000) &&
      Number(slot.slot_units) === workOrder.concurrency.slots &&
      workers.length <= 1,
  );
  assertNullableRevision(order.authorization_revision, metaRevision);
  assertNullableRevision(order.claim_revision, metaRevision);
  assertNullableRevision(order.terminal_revision, metaRevision);
  assertDurable(
    order.authorization_revision === null ||
      Number(order.authorization_revision) > Number(order.accepted_revision),
  );
  assertDurable(
    order.claim_revision === null ||
      (order.authorization_revision !== null &&
        Number(order.claim_revision) > Number(order.authorization_revision)),
  );
  assertDurable(
    order.terminal_revision === null ||
      (order.lifecycle_state === "denied"
        ? order.terminal_revision === order.authorization_revision
        : Number(order.terminal_revision) >
          Math.max(
            Number(order.authorization_revision ?? order.accepted_revision),
            Number(order.claim_revision ?? order.accepted_revision),
          )),
  );
  assertDurable(
    (order.active_claim_key === null ||
      isLedgerOpaqueKey(order.active_claim_key, "rwck")) &&
      (order.provisional_worker_key === null ||
        isLedgerOpaqueKey(order.provisional_worker_key, "rwwk")) &&
      (order.worker_key === null ||
        isLedgerOpaqueKey(order.worker_key, "rwwk")) &&
      (order.handoff_digest === null || isPrefixedSha256(order.handoff_digest)),
  );

  const unauthorised =
    order.lifecycle_state === "accepted" || order.lifecycle_state === "denied";
  if (unauthorised) {
    assertDurable(
      authorization === undefined &&
        slot.slot_state === "unreserved" &&
        slot.directory_snapshot_key === null &&
        slot.endpoint_snapshot_key === null &&
        slot.acquired_revision === null &&
        slot.released_revision === null,
    );
  } else {
    assertDurable(authorization !== undefined);
    assertAuthorizationRelations(
      order,
      slot,
      authorization,
      workOrder,
      metaRevision,
    );
  }

  const worker = workers[0];
  assertDurable(
    (order.worker_key === null && worker === undefined) ||
      (order.worker_key !== null &&
        worker !== undefined &&
        worker.worker_key === order.worker_key),
  );

  switch (order.lifecycle_state) {
    case "accepted":
      assertDurable(
        order.effect_phase === "unclaimed" &&
          order.denial_category === null &&
          order.authorization_revision === null &&
          order.claim_revision === null &&
          order.terminal_revision === null &&
          order.active_claim_key === null &&
          order.provisional_worker_key === null &&
          order.worker_key === null &&
          order.control_action === null &&
          Number(order.progress_sequence) === 0 &&
          order.handoff_digest === null,
      );
      break;
    case "denied":
      assertDurable(
        order.effect_phase === "committed" &&
          isDenialCategory(order.denial_category) &&
          order.authorization_revision !== null &&
          order.terminal_revision === order.authorization_revision &&
          order.claim_revision === null &&
          order.active_claim_key === null &&
          order.provisional_worker_key === null &&
          order.worker_key === null &&
          order.control_action === null &&
          Number(order.progress_sequence) === 0 &&
          order.handoff_digest === null,
      );
      break;
    case "authorized":
      assertDurable(
        isAuthorizedBase(order) &&
          order.effect_phase === "unclaimed" &&
          order.claim_revision === null &&
          order.active_claim_key === null &&
          order.provisional_worker_key === null &&
          order.worker_key === null &&
          order.control_action === null &&
          Number(order.progress_sequence) === 0,
      );
      break;
    case "start-claimed":
      assertDurable(
        isClaimedBase(order) &&
          order.effect_phase === "start-claimed" &&
          order.worker_key === null &&
          order.control_action === null &&
          Number(order.progress_sequence) === 0,
      );
      break;
    case "running":
      assertDurable(
        isClaimedBase(order) &&
          order.effect_phase === "running" &&
          order.worker_key === order.provisional_worker_key &&
          order.control_action === null &&
          worker !== undefined,
      );
      break;
    case "control-claimed":
      assertDurable(
        isClaimedBase(order) &&
          order.effect_phase === "control-claimed" &&
          order.worker_key === order.provisional_worker_key &&
          order.control_action !== null &&
          worker !== undefined,
      );
      break;
    case "completed":
      assertDurable(
        isClaimedTerminalBase(order) &&
          order.worker_key === order.provisional_worker_key &&
          order.control_action === null &&
          order.handoff_digest !== null &&
          worker !== undefined,
      );
      break;
    case "failed":
      assertDurable(
        isClaimedTerminalBase(order) &&
          order.worker_key === null &&
          order.control_action === null &&
          Number(order.progress_sequence) === 0 &&
          order.handoff_digest === null &&
          worker === undefined,
      );
      break;
    case "cancelled":
      assertDurable(
        isTerminalBase(order) &&
          order.handoff_digest === null &&
          ((worker === undefined &&
            order.claim_revision === null &&
            order.active_claim_key === null &&
            order.provisional_worker_key === null &&
            order.worker_key === null &&
            order.control_action === null &&
            Number(order.progress_sequence) === 0) ||
            (worker !== undefined &&
              order.worker_key === order.provisional_worker_key &&
              order.control_action === "cancel")),
      );
      break;
    case "interrupted":
      assertDurable(
        isClaimedTerminalBase(order) &&
          order.worker_key === order.provisional_worker_key &&
          order.control_action === "interrupt" &&
          order.handoff_digest === null &&
          worker !== undefined,
      );
      break;
    case "recovery-required":
      assertDurable(
        isClaimedBase(order) &&
          order.effect_phase === "outcome-unknown" &&
          order.terminal_revision === null &&
          order.handoff_digest === null &&
          ((worker === undefined &&
            order.worker_key === null &&
            order.control_action === null &&
            Number(order.progress_sequence) === 0) ||
            (worker !== undefined &&
              order.worker_key === order.provisional_worker_key &&
              order.control_action !== null)),
      );
      break;
  }
  if (worker !== undefined && authorization !== undefined) {
    assertWorkerRelations(order, authorization, worker, metaRevision);
  }
}

function assertAuthorizationRelations(
  order: OrderRow,
  slot: SlotRow,
  authorization: AuthorizationRow,
  workOrder: RuntimeNeutralWorkOrder,
  metaRevision: number,
): void {
  assertDurable(
    authorization.work_order_key === order.work_order_key &&
      authorization.work_order_digest === order.work_order_digest &&
      authorization.directory_snapshot_key === order.directory_epoch_key &&
      authorization.worker_endpoint_snapshot_key ===
        order.endpoint_snapshot_key &&
      authorization.worker_profile_snapshot_key === order.profile_snapshot_key &&
      authorization.access_mode === order.requested_access_mode &&
      isOpaqueKey(authorization.directory_snapshot_key, "rtdk") &&
      isOpaqueKey(authorization.supervisor_endpoint_snapshot_key, "rtek") &&
      isOpaqueKey(authorization.supervisor_profile_snapshot_key, "rtpk") &&
      isOpaqueKey(authorization.worker_endpoint_snapshot_key, "rtek") &&
      isOpaqueKey(authorization.worker_profile_snapshot_key, "rtpk") &&
      Number(authorization.budget_units) === workOrder.budget.units &&
      Number(authorization.slot_units) === workOrder.concurrency.slots &&
      isInteger(Number(authorization.endpoint_concurrency_limit), 0, 1_000_000) &&
      Number(authorization.slot_units) <=
        Number(authorization.endpoint_concurrency_limit) &&
      Number(authorization.authorization_revision) ===
        Number(order.authorization_revision) &&
      isInteger(Number(authorization.authorization_revision), 1, metaRevision) &&
      authorization.host_capability_ceiling ===
        (authorization.access_mode === "full-access"
          ? "codex-full-access"
          : "restricted") &&
      slot.directory_snapshot_key === authorization.directory_snapshot_key &&
      slot.endpoint_snapshot_key ===
        authorization.worker_endpoint_snapshot_key &&
      Number(slot.slot_units) === Number(authorization.slot_units) &&
      Number(slot.acquired_revision) ===
        Number(authorization.authorization_revision),
  );
  const released = ["completed", "failed", "cancelled", "interrupted"].includes(
    order.lifecycle_state,
  );
  assertDurable(
    released
      ? slot.slot_state === "released" &&
          order.terminal_revision !== null &&
          Number(slot.released_revision) === Number(order.terminal_revision) &&
          Number(slot.released_revision) > Number(slot.acquired_revision)
      : slot.slot_state === "owned" && slot.released_revision === null,
  );
}

function assertWorkerRelations(
  order: OrderRow,
  authorization: AuthorizationRow,
  worker: WorkerRow,
  metaRevision: number,
): void {
  assertDurable(
    isLedgerOpaqueKey(worker.worker_key, "rwwk") &&
      worker.work_order_key === order.work_order_key &&
      worker.directory_snapshot_key === authorization.directory_snapshot_key &&
      worker.endpoint_snapshot_key ===
        authorization.worker_endpoint_snapshot_key &&
      worker.profile_snapshot_key === authorization.worker_profile_snapshot_key &&
      worker.access_mode === authorization.access_mode &&
      worker.lifecycle_state === order.lifecycle_state &&
      isInteger(Number(worker.created_revision), 1, metaRevision) &&
      Number(worker.created_revision) >
        Number(order.authorization_revision ?? 0) &&
      Number(worker.progress_sequence) === Number(order.progress_sequence) &&
      worker.handoff_digest === order.handoff_digest,
  );
  const terminal = ["completed", "cancelled", "interrupted"].includes(
    order.lifecycle_state,
  );
  assertDurable(
    terminal
      ? worker.terminal_revision === order.terminal_revision
      : worker.terminal_revision === null,
  );
  const expectedControl = order.lifecycle_state === "control-claimed"
    ? order.control_action === "cancel"
      ? "cancel-claimed"
      : "interrupt-claimed"
    : order.lifecycle_state === "cancelled" ||
        order.lifecycle_state === "interrupted"
      ? "committed"
      : order.lifecycle_state === "recovery-required"
        ? "outcome-unknown"
        : "none";
  assertDurable(worker.control_state === expectedControl);
}

function isAuthorizedBase(order: OrderRow): boolean {
  return (
    order.denial_category === null &&
    order.authorization_revision !== null &&
    order.terminal_revision === null &&
    order.handoff_digest === null
  );
}

function isClaimedBase(order: OrderRow): boolean {
  return (
    isAuthorizedBase(order) &&
    order.claim_revision !== null &&
    order.active_claim_key !== null &&
    order.provisional_worker_key !== null
  );
}

function isTerminalBase(order: OrderRow): boolean {
  return (
    order.effect_phase === "committed" &&
    order.denial_category === null &&
    order.authorization_revision !== null &&
    order.terminal_revision !== null
  );
}

function isClaimedTerminalBase(order: OrderRow): boolean {
  return (
    isTerminalBase(order) &&
    order.claim_revision !== null &&
    order.active_claim_key !== null &&
    order.provisional_worker_key !== null
  );
}

function assertNullableRevision(value: number | null, maximum: number): void {
  assertDurable(value === null || isInteger(Number(value), 1, maximum));
}

function assertDurable(condition: unknown): asserts condition {
  if (!condition) throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
}

function isPrefixedSha256(value: unknown): value is string {
  return (
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
  );
}

function isLedgerOpaqueKey(
  value: unknown,
  prefix: "rwok" | "rwck" | "rwwk",
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{32}$`, "u").test(value)
  );
}

function isDenialCategory(
  value: unknown,
): value is RuntimeWorkOrderDenialCategory {
  return [
    "acceptance-required",
    "authorization-denied",
    "capability-unavailable",
    "idempotency-conflict",
    "registration-invalid",
    "selection-invalid",
    "supervisor-binding-invalid",
    "work-order-invalid",
    "endpoint-capacity-denied",
  ].includes(value as string);
}

function currentRevision(database: DatabaseSync): number {
  return Number(readMeta(database).revision);
}

function nextRevision(database: DatabaseSync): number {
  const revision = currentRevision(database) + 1;
  const result = database
    .prepare(
      "UPDATE runtime_work_order_ledger_meta SET revision = ? WHERE singleton = 1",
    )
    .run(revision);
  if (Number(result.changes) !== 1) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  return revision;
}

function appendEvent(
  database: DatabaseSync,
  revision: number,
  workOrderKey: string,
  eventKind: string,
  lifecycle: RuntimeWorkOrderLifecycle,
  effectPhase: RuntimeWorkOrderEffectPhase,
  category: string | null = null,
  claimKey: string | null = null,
): void {
  database
    .prepare(
      `INSERT INTO runtime_work_order_ledger_events (
         revision, work_order_key, event_kind, lifecycle_state,
         effect_phase, category, claim_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revision,
      workOrderKey,
      eventKind,
      lifecycle,
      effectPhase,
      category,
      claimKey,
    );
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function submissionResult(row: OrderRow): RuntimeWorkOrderLedgerResult {
  const status = row.lifecycle_state === "denied"
    ? "denied"
    : row.lifecycle_state === "accepted"
      ? "accepted"
      : "authorized";
  const revision = row.lifecycle_state === "accepted"
    ? Number(row.accepted_revision)
    : Number(row.authorization_revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
  return deepFreeze({
    kind: "submission",
    status,
    workOrderKey: row.work_order_key,
    revision,
    denialCategory: row.denial_category,
  });
}

function transitionResult(
  row: OrderRow,
  revision: number,
): RuntimeWorkOrderLedgerResult {
  return deepFreeze({
    kind: "transition",
    status: row.lifecycle_state,
    workOrderKey: row.work_order_key,
    workerKey: row.worker_key,
    revision,
  });
}

function assertCommandKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isExactRecord(value, keys)) {
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
}

function requiredOpaqueLedgerKey(
  value: unknown,
  prefix: "rwok" | "rwck" | "rwwk",
): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_[A-Za-z0-9_-]{32}$`, "u").test(value)
  ) {
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
  return value;
}

function cloneFactoryOptions(value: unknown): RuntimeWorkOrderLedgerOptions {
  const withoutCrashPoint = isExactRecord(value, ["databasePath", "directory"]);
  const withCrashPoint = isExactRecord(value, [
    "databasePath",
    "directory",
    "crashPoint",
  ]);
  if (!withoutCrashPoint && !withCrashPoint) {
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
  const databasePath = ownDataValue(value, "databasePath");
  const directory = ownDataValue(value, "directory");
  const crashPoint = withCrashPoint
    ? ownDataValue(value, "crashPoint")
    : undefined;
  if (
    typeof databasePath !== "string" ||
    databasePath.trim().length === 0 ||
    !hasDataMethod(directory, "snapshot") ||
    !hasDataMethod(directory, "authorizeAcceptedWorkOrder") ||
    (crashPoint !== undefined && !isCrashPoint(crashPoint))
  ) {
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
  return {
    databasePath,
    directory: directory as RuntimeEndpointDirectory,
    ...(crashPoint === undefined ? {} : { crashPoint }),
  };
}

function cloneWorkOrder(value: unknown): RuntimeNeutralWorkOrder {
  if (
    !isExactRecord(value, [
      "idempotencyKey",
      "objective",
      "input",
      "directorySnapshotKey",
      "endpointSnapshotKey",
      "profileSnapshotKey",
      "requestedAccessMode",
      "budget",
      "concurrency",
    ]) ||
    !isIdentifier(value.idempotencyKey, 8, 128) ||
    !isText(value.objective, 1, 1_000) ||
    !isText(value.input, 1, 16_000) ||
    !isOpaqueKey(value.directorySnapshotKey, "rtdk") ||
    !isOpaqueKey(value.endpointSnapshotKey, "rtek") ||
    !isOpaqueKey(value.profileSnapshotKey, "rtpk") ||
    (value.requestedAccessMode !== "full-access" &&
      value.requestedAccessMode !== "restricted") ||
    !isExactRecord(value.budget, ["units"]) ||
    !isInteger(value.budget.units, 0, 1_000_000_000) ||
    !isExactRecord(value.concurrency, ["slots"]) ||
    !isInteger(value.concurrency.slots, 1, 1_000_000)
  ) {
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
  return deepFreeze({
    idempotencyKey: value.idempotencyKey,
    objective: value.objective,
    input: value.input,
    directorySnapshotKey:
      value.directorySnapshotKey as RuntimeDirectorySnapshotKey,
    endpointSnapshotKey: value.endpointSnapshotKey as RuntimeEndpointSnapshotKey,
    profileSnapshotKey: value.profileSnapshotKey as RuntimeProfileSnapshotKey,
    requestedAccessMode: value.requestedAccessMode,
    budget: { units: value.budget.units },
    concurrency: { slots: value.concurrency.slots },
  });
}

function cloneBoundSupervisor(value: unknown): BoundSupervisorSession {
  if (
    !isExactRecord(value, [
      "sessionKey",
      "directorySnapshotKey",
      "endpointSnapshotKey",
      "profileSnapshotKey",
    ]) ||
    !isIdentifier(value.sessionKey, 8, 128) ||
    !isOpaqueKey(value.directorySnapshotKey, "rtdk") ||
    !isOpaqueKey(value.endpointSnapshotKey, "rtek") ||
    !isOpaqueKey(value.profileSnapshotKey, "rtpk")
  ) {
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
  return deepFreeze({
    sessionKey: value.sessionKey,
    directorySnapshotKey:
      value.directorySnapshotKey as RuntimeDirectorySnapshotKey,
    endpointSnapshotKey: value.endpointSnapshotKey as RuntimeEndpointSnapshotKey,
    profileSnapshotKey: value.profileSnapshotKey as RuntimeProfileSnapshotKey,
  });
}

function parseWorkOrder(json: string): RuntimeNeutralWorkOrder {
  try {
    return cloneWorkOrder(JSON.parse(json) as unknown);
  } catch {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
}

function parseBoundSupervisor(json: string): BoundSupervisorSession {
  try {
    return cloneBoundSupervisor(JSON.parse(json) as unknown);
  } catch {
    throw new RuntimeWorkOrderLedgerError("durable-state-invalid");
  }
}

function digestWorkOrder(workOrder: RuntimeNeutralWorkOrder): string {
  return prefixedDigest(
    JSON.stringify({
      idempotencyKey: workOrder.idempotencyKey,
      objective: workOrder.objective,
      input: workOrder.input,
      directorySnapshotKey: workOrder.directorySnapshotKey,
      endpointSnapshotKey: workOrder.endpointSnapshotKey,
      profileSnapshotKey: workOrder.profileSnapshotKey,
      requestedAccessMode: workOrder.requestedAccessMode,
      budget: { units: workOrder.budget.units },
      concurrency: { slots: workOrder.concurrency.slots },
    }),
  );
}

function digestBoundSupervisor(bound: BoundSupervisorSession): string {
  return prefixedDigest(
    JSON.stringify({
      sessionKey: bound.sessionKey,
      directorySnapshotKey: bound.directorySnapshotKey,
      endpointSnapshotKey: bound.endpointSnapshotKey,
      profileSnapshotKey: bound.profileSnapshotKey,
    }),
  );
}

function prefixedDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function opaqueKey(prefix: "rwok" | "rwck" | "rwwk"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function isCrashPoint(value: unknown): value is RuntimeWorkOrderLedgerCrashPoint {
  return [
    "before-acceptance-commit",
    "after-acceptance-before-authorization",
    "after-authorization-before-slot-commit",
    "after-slot-commit-before-effect-claim",
    "after-effect-claim-before-external-acknowledgement",
    "after-terminal-fact-before-response",
  ].includes(value as string);
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some(
        (key) => typeof key !== "string" || !expectedKeys.includes(key),
      )
    ) {
      return false;
    }
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
      );
    });
  } catch {
    return false;
  }
}

function ownDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw new RuntimeWorkOrderLedgerError("command-invalid");
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof RuntimeWorkOrderLedgerError) throw error;
    throw new RuntimeWorkOrderLedgerError("command-invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hasDataMethod(value: unknown, name: string): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  try {
    let current: object | null = value;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        return (
          Object.prototype.hasOwnProperty.call(descriptor, "value") &&
          typeof descriptor.value === "function"
        );
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  } catch {
    return false;
  }
}

function isIdentifier(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function isText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isOpaqueKey(
  value: unknown,
  prefix: "rtdk" | "rtek" | "rtpk",
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}_[A-Za-z0-9_-]{32}$`, "u").test(value)
  );
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
