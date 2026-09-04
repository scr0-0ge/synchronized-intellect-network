import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import type {
  ContinueDirectProjectCommand,
  ProjectChannel,
  StartDirectProjectCommand,
} from "../../src/coordinator/index.ts";
import {
  createWorkLedgerAuthGenerationModule,
  type WorkLedgerAuthGenerationModule,
} from "../../src/coordinator/work-ledger-auth-generation.ts";

const emptyRegistry = `${JSON.stringify({
  schemaVersion: 1,
  revision: 0,
  nextProjectOrdinal: 1,
  selectedRecordKey: null,
  records: [],
})}\n`;

const pristineCodexContext = JSON.stringify({
  schemaVersion: 1,
  endpointId: "codex-desktop",
  management: "pristine-legacy",
});

const pristineClaudeContext = JSON.stringify({
  schemaVersion: 1,
  endpointId: "claude-code-desktop",
  management: "pristine-legacy",
});

const coordinatorProfile: SessionProfile = Object.freeze({
  model: "fixture-model",
  effortLevel: "fixture-effort",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const coordinatorCatalog: RuntimeCatalog = Object.freeze({
  runtime: "fixture-runtime",
  models: Object.freeze([
    Object.freeze({
      id: coordinatorProfile.model,
      effortLevels: Object.freeze([coordinatorProfile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze([coordinatorProfile.executionMode]),
  accessModes: Object.freeze([coordinatorProfile.accessMode]),
});

test("auth generation exposes one frozen exact two-endpoint snapshot from one state revision", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "auth-pair-snapshot-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const auth = createWorkLedgerAuthGenerationModule({ dataDirectory });

  assert.deepEqual(auth.captureRuntimeEndpointAuthGenerationSnapshot(), {
    codex: {
      schemaVersion: 1,
      endpointId: "codex-desktop",
      management: "pristine-legacy",
    },
    claude: {
      schemaVersion: 1,
      endpointId: "claude-code-desktop",
      management: "pristine-legacy",
    },
  });
  const before = auth.captureRuntimeEndpointAuthGenerationSnapshot();
  assert.ok(before);
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Object.isFrozen(before.codex), true);
  assert.equal(Object.isFrozen(before.claude), true);
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    emptyRegistry,
    "utf8",
  );

  const preparation = auth.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "login",
  });
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") throw new Error("synthetic mutation blocked");
  assert.equal(
    auth.beginAuthenticationMutation({
      preparationKey: preparation.preparationKey,
    }).kind,
    "begun",
  );
  const after = auth.captureRuntimeEndpointAuthGenerationSnapshot();
  assert.ok(after);
  assert.equal(after.codex.management, "managed");
  assert.equal(after.claude.management, "pristine-legacy");
});

const coordinatorEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({ kind: "agent-message" as const, text: "preserved transcript" }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

class CompletingCoordinatorBinding implements ResumableRuntimeBinding {
  readonly profile = coordinatorProfile;
  readonly opaqueSessionReference: string;

  constructor(opaqueSessionReference: string) {
    this.opaqueSessionReference = opaqueSessionReference;
  }

  async send(_input: RuntimeInput): Promise<void> {}

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    for (const event of coordinatorEvents) yield structuredClone(event);
  }
}

class CompletingCoordinatorAdapter implements ResumableAgentRuntimeAdapter {
  readonly starts: RuntimeStart[] = [];
  readonly resumes: RuntimeResume[] = [];

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(coordinatorCatalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.starts.push(structuredClone(request));
    return new CompletingCoordinatorBinding(`native-${this.starts.length}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return new CompletingCoordinatorBinding(request.opaqueSessionReference);
  }
}

function startCommand(idempotencyKey: string): StartDirectProjectCommand {
  return Object.freeze({
    kind: "direct" as const,
    commandKind: "start" as const,
    idempotencyKey,
    runtime: "codex" as const,
    catalogRevision: "fixture-catalog-revision",
    preferences: Object.freeze({ global: coordinatorProfile }),
    profile: coordinatorProfile,
    input: "preserved command",
  });
}

function continueCommand(
  idempotencyKey: string,
  targetSessionId: string,
): ContinueDirectProjectCommand {
  return Object.freeze({
    kind: "direct" as const,
    commandKind: "continue" as const,
    idempotencyKey,
    runtime: "codex" as const,
    targetSessionId,
    profile: coordinatorProfile,
    input: "must not reach native resume",
  });
}

async function waitForTerminal(channel: ProjectChannel): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await channel.snapshot();
    if (
      snapshot.commands.length > 0 &&
      snapshot.commands.every((command) =>
        ["completed", "failed", "recovery-required"].includes(command.status),
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("coordinator did not reach a terminal state");
}

type LedgerSessionSeed = {
  readonly id: string;
  readonly status:
    | "accepted"
    | "starting"
    | "in-flight"
    | "completed"
    | "failed"
    | "recovery-required";
  readonly authenticationContext?: string | null;
  readonly commandAuthenticationContext?: string | null;
  readonly opaqueSessionReference?: string | null;
};

function createLedger(
  databasePath: string,
  projectId: string,
  canonicalDirectory: string,
  seeds: readonly LedgerSessionSeed[],
): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
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
      auth_context_json TEXT,
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
      ),
      auth_context_json TEXT
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
    PRAGMA user_version = 3;
  `);
  database
    .prepare("INSERT INTO projects (project_id, directory_digest) VALUES (?, ?)")
    .run(
      projectId,
      createHash("sha256")
        .update(
          process.platform === "win32"
            ? canonicalDirectory.toLowerCase()
            : canonicalDirectory,
          "utf8",
        )
        .digest("hex"),
    );
  const insertCommand = database.prepare(`
    INSERT INTO commands (
      command_id, project_id, idempotency_digest, payload_digest,
      digest_version, command_kind, target_session_id, runtime, status,
      failure_category, accepted_cursor, private_envelope_json, effect_phase,
      outcome_uncertain, auth_context_json
    ) VALUES (?, ?, ?, ?, 2, 'start', ?, 'codex', ?, NULL, 1, '{}', ?, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO sessions (
      session_id, project_id, root_command_id, profile_json,
      opaque_session_reference, lifecycle_status, auth_context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const seed of seeds) {
    const commandId = `command-${seed.id}`;
    const durableStatus = seed.status === "starting" ? "in-flight" : seed.status;
    const effectPhase =
      seed.status === "accepted"
        ? "unclaimed"
        : seed.status === "starting"
          ? "binding-claimed"
          : seed.status === "in-flight"
            ? "awaiting-terminal"
            : seed.status === "recovery-required"
              ? "binding-claimed"
              : "committed";
    insertCommand.run(
      commandId,
      projectId,
      `idempotency-${seed.id}`,
      `payload-${seed.id}`,
      seed.id,
      durableStatus,
      effectPhase,
      seed.status === "starting" ||
        seed.status === "in-flight" ||
        seed.status === "recovery-required"
        ? 1
        : 0,
      seed.commandAuthenticationContext !== undefined
        ? seed.commandAuthenticationContext
        : seed.authenticationContext === undefined
          ? pristineCodexContext
          : seed.authenticationContext,
    );
    insertSession.run(
      seed.id,
      projectId,
      commandId,
      JSON.stringify(coordinatorProfile),
      seed.opaqueSessionReference ??
        (seed.status === "completed" ? `native-${seed.id}` : null),
      durableStatus,
      seed.authenticationContext === undefined
        ? pristineCodexContext
        : seed.authenticationContext,
    );
  }
  database.close();
}

function createVersionTwoEmptyLedger(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
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
    PRAGMA user_version = 2;
  `);
  database.close();
}

test("pristine legacy resume remains eligible until the first durable authentication mutation", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-generation-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(join(dataDirectory, "project-registry-v1.json"), emptyRegistry, "utf8");

  const generations = [
    "auth-generation-v1-00000000-0000-4000-8000-000000000001",
    "auth-generation-v1-00000000-0000-4000-8000-000000000002",
    "auth-generation-v1-00000000-0000-4000-8000-000000000002",
  ];
  const preparationKeys = [
    "auth-preparation-v1-00000000-0000-4000-8000-000000000001",
    "auth-preparation-v1-00000000-0000-4000-8000-000000000002",
    "auth-preparation-v1-00000000-0000-4000-8000-000000000003",
  ];
  const module = createWorkLedgerAuthGenerationModule({
    dataDirectory,
    createGeneration: () => generations.shift()!,
    createPreparationKey: () => preparationKeys.shift()!,
  });

  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    true,
  );
  const preparation = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(preparation.kind, "ready");
  if (preparation.kind !== "ready") assert.fail("expected ready preparation");
  assert.equal(
    module.beginAuthenticationMutation({
      preparationKey: preparation.preparationKey,
    }).kind,
    "begun",
  );
  assert.equal(
    module.beginAuthenticationMutation({
      preparationKey: preparation.preparationKey,
    }).kind,
    "rejected",
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    false,
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "claude-code-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    true,
    "the Codex mutation does not advance Claude's endpoint-local generation",
  );

  const managedContext = module.captureForAcceptedCommand("codex-desktop");
  assert.notEqual(managedContext, undefined);
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: managedContext,
      commandContext: managedContext,
    }),
    true,
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "claude-code-desktop",
      sessionContext: managedContext,
      commandContext: managedContext,
    }),
    false,
  );

  const nextPreparation = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "login",
  });
  assert.equal(nextPreparation.kind, "ready");
  assert.equal(
    nextPreparation.kind === "ready"
      ? module.beginAuthenticationMutation({
          preparationKey: nextPreparation.preparationKey,
        }).kind
      : "wrong-preparation",
    "begun",
  );
  const currentContext = module.captureForAcceptedCommand("codex-desktop");
  assert.notEqual(currentContext, undefined);
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: managedContext,
      commandContext: managedContext,
    }),
    false,
    "a previously current managed generation is stale",
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: currentContext,
      commandContext: currentContext,
    }),
    true,
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: { ...currentContext, extra: true },
      commandContext: currentContext,
    }),
    false,
  );

  const duplicateGeneration = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(duplicateGeneration.kind, "ready");
  assert.equal(
    duplicateGeneration.kind === "ready"
      ? module.beginAuthenticationMutation({
          preparationKey: duplicateGeneration.preparationKey,
        }).kind
      : "wrong-preparation",
    "persistence-failed",
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: currentContext,
      commandContext: currentContext,
    }),
    true,
  );

  const reopened = createWorkLedgerAuthGenerationModule({ dataDirectory });
  assert.equal(
    reopened.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: currentContext,
      commandContext: currentContext,
    }),
    true,
  );
  assert.equal(
    reopened.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: managedContext,
      commandContext: managedContext,
    }),
    false,
  );
  assert.equal(
    reopened.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    false,
  );
});

test("preparation scans every registered Project and blockers outrank terminal consequences", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-guard-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const records = [
    {
      recordKey: "project-record-v1-00000000-0000-4000-8000-000000000001",
      canonicalDirectory: join(dataDirectory, "project-a"),
      ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000001",
    },
    {
      recordKey: "project-record-v1-00000000-0000-4000-8000-000000000002",
      canonicalDirectory: join(dataDirectory, "project-b"),
      ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000002",
    },
  ] as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      nextProjectOrdinal: 3,
      selectedRecordKey: records[0].recordKey,
      records,
    })}\n`,
    "utf8",
  );
  const module = createWorkLedgerAuthGenerationModule({ dataDirectory });
  const firstLedger = join(ledgerDirectory, `${records[0].ledgerSlot}.sqlite`);
  const secondLedger = join(ledgerDirectory, `${records[1].ledgerSlot}.sqlite`);
  createLedger(firstLedger, "project-a", records[0].canonicalDirectory, [
    { id: "accepted", status: "accepted" },
    { id: "terminal-a", status: "completed" },
  ]);
  createLedger(secondLedger, "project-b", records[1].canonicalDirectory, [
    { id: "starting", status: "starting" },
    { id: "running", status: "in-flight" },
    { id: "recovery", status: "recovery-required" },
    {
      id: "unknown-membership",
      status: "completed",
      authenticationContext: null,
    },
    {
      id: "contradictory-membership",
      status: "completed",
      authenticationContext: pristineClaudeContext,
      commandAuthenticationContext: pristineCodexContext,
    },
    {
      id: "unaffected-claude",
      status: "completed",
      authenticationContext: pristineClaudeContext,
    },
    { id: "terminal-b", status: "completed" },
  ]);

  assert.deepEqual(
    module.prepareAuthenticationMutation({
      endpointId: "codex-desktop",
      action: "logout",
    }),
    {
      kind: "blocked",
      blockers: {
        accepted: 1,
        starting: 1,
        inFlight: 1,
        recoveryRequired: 1,
        unknown: 1,
      },
    },
  );

  for (const databasePath of [firstLedger, secondLedger]) {
    const database = new DatabaseSync(databasePath);
    database
      .prepare(
        `UPDATE commands
            SET status = 'failed', effect_phase = 'committed', outcome_uncertain = 0
          WHERE status IN ('accepted', 'in-flight', 'recovery-required')`,
      )
      .run();
    database
      .prepare(
        `UPDATE sessions
            SET lifecycle_status = 'failed', opaque_session_reference = NULL
          WHERE lifecycle_status IN ('accepted', 'in-flight', 'recovery-required')`,
      )
      .run();
    database
      .prepare(
        `UPDATE sessions
            SET auth_context_json = ?, opaque_session_reference = NULL
          WHERE session_id IN ('unknown-membership', 'contradictory-membership')`,
      )
      .run(pristineCodexContext);
    database
      .prepare(
        `UPDATE commands
            SET auth_context_json = ?
          WHERE target_session_id IN ('unknown-membership', 'contradictory-membership')`,
      )
      .run(pristineCodexContext);
    database.close();
  }

  const confirmation = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(confirmation.kind, "confirmation-required");
  assert.deepEqual(
    confirmation.kind === "confirmation-required"
      ? confirmation.consequences
      : null,
    { resumableSessionCount: 2, projectCount: 2 },
  );
  assert.equal(
    confirmation.kind === "confirmation-required" &&
      module.cancelAuthenticationMutation({
        preparationKey: confirmation.preparationKey,
      }),
    true,
  );
  assert.equal(
    confirmation.kind === "confirmation-required"
      ? module.beginAuthenticationMutation({
          preparationKey: confirmation.preparationKey,
        }).kind
      : "wrong-preparation",
    "rejected",
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: JSON.parse(pristineCodexContext),
      commandContext: JSON.parse(pristineCodexContext),
    }),
    true,
  );
  const staleConfirmation = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(staleConfirmation.kind, "confirmation-required");
  const driftedLedger = new DatabaseSync(secondLedger);
  driftedLedger
    .prepare(
      "UPDATE sessions SET opaque_session_reference = NULL WHERE session_id = 'terminal-b'",
    )
    .run();
  driftedLedger.close();
  assert.equal(
    staleConfirmation.kind === "confirmation-required"
      ? module.beginAuthenticationMutation({
          preparationKey: staleConfirmation.preparationKey,
        }).kind
      : "wrong-preparation",
    "stale",
  );
});

test("a registry-to-ledger directory mismatch is unknown rather than an empty Project", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-membership-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = {
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000090",
    canonicalDirectory: join(dataDirectory, "registered-project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000090",
  } as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: record.recordKey,
      records: [record],
    })}\n`,
    "utf8",
  );
  createLedger(
    join(ledgerDirectory, `${record.ledgerSlot}.sqlite`),
    "wrong-project",
    join(dataDirectory, "different-project"),
    [],
  );
  const module = createWorkLedgerAuthGenerationModule({ dataDirectory });

  assert.deepEqual(
    module.prepareAuthenticationMutation({
      endpointId: "codex-desktop",
      action: "logout",
    }),
    {
      kind: "blocked",
      blockers: {
        accepted: 0,
        starting: 0,
        inFlight: 0,
        recoveryRequired: 0,
        unknown: 1,
      },
    },
  );
});

test("cancel, begin-time recheck, and replay consume preparations without partial invalidation", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-stale-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(join(dataDirectory, "project-registry-v1.json"), emptyRegistry, "utf8");
  const keys = [
    "auth-preparation-v1-00000000-0000-4000-8000-000000000020",
    "auth-preparation-v1-00000000-0000-4000-8000-000000000021",
    "auth-preparation-v1-00000000-0000-4000-8000-000000000022",
  ];
  const module = createWorkLedgerAuthGenerationModule({
    dataDirectory,
    createGeneration: () =>
      "auth-generation-v1-00000000-0000-4000-8000-000000000020",
    createPreparationKey: () => keys.shift()!,
  });
  const cancelled = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(cancelled.kind, "ready");
  assert.equal(
    cancelled.kind === "ready" &&
      module.cancelAuthenticationMutation({
        preparationKey: cancelled.preparationKey,
      }),
    true,
  );
  assert.equal(
    cancelled.kind === "ready"
      ? module.beginAuthenticationMutation({
          preparationKey: cancelled.preparationKey,
        }).kind
      : "wrong-preparation",
    "rejected",
  );

  const stale = module.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(stale.kind, "ready");
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = {
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000020",
    canonicalDirectory: join(dataDirectory, "drifted-project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000020",
  } as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: record.recordKey,
      records: [record],
    })}\n`,
    "utf8",
  );
  createLedger(
    join(ledgerDirectory, `${record.ledgerSlot}.sqlite`),
    "drift",
    record.canonicalDirectory,
    [{ id: "accepted-after-prepare", status: "accepted" }],
  );
  assert.deepEqual(
    stale.kind === "ready"
      ? module.beginAuthenticationMutation({
          preparationKey: stale.preparationKey,
        })
      : null,
    {
      kind: "blocked",
      blockers: {
        accepted: 1,
        starting: 0,
        inFlight: 0,
        recoveryRequired: 0,
        unknown: 0,
      },
    },
  );
  assert.equal(
    module.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    true,
  );
  assert.equal(
    stale.kind === "ready"
      ? module.beginAuthenticationMutation({
          preparationKey: stale.preparationKey,
        }).kind
      : "wrong-preparation",
    "rejected",
  );
});

test("generation persistence failure leaves the prior eligibility state intact", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-write-fail-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(join(dataDirectory, "project-registry-v1.json"), emptyRegistry, "utf8");
  createWorkLedgerAuthGenerationModule({ dataDirectory });
  const failing = createWorkLedgerAuthGenerationModule({
    dataDirectory,
    createGeneration: () =>
      "auth-generation-v1-00000000-0000-4000-8000-000000000030",
    createPreparationKey: () =>
      "auth-preparation-v1-00000000-0000-4000-8000-000000000030",
    atomicReplace: () => {
      throw new Error("injected-persistence-failure");
    },
  });
  const preparation = failing.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(preparation.kind, "ready");
  assert.equal(
    preparation.kind === "ready"
      ? failing.beginAuthenticationMutation({
          preparationKey: preparation.preparationKey,
        }).kind
      : "wrong-preparation",
    "persistence-failed",
  );
  assert.equal(
    failing.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    true,
  );
  assert.equal(
    failing.captureForAcceptedCommand("codex-desktop")?.management,
    "pristine-legacy",
  );
});

test("partial, extra-shaped, malformed, and missing durable managed state fail closed", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-malformed-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(join(dataDirectory, "project-registry-v1.json"), emptyRegistry, "utf8");
  const statePath = join(dataDirectory, "work-ledger-auth-generations-v1.json");
  createWorkLedgerAuthGenerationModule({ dataDirectory });
  const malformedStates: readonly unknown[] = [
    {
      schemaVersion: 1,
      revision: 1,
      endpoints: [
        { endpointId: "codex-desktop", management: "managed" },
        { endpointId: "claude-code-desktop", management: "pristine-legacy" },
      ],
    },
    {
      schemaVersion: 1,
      revision: 1,
      endpoints: [
        {
          endpointId: "codex-desktop",
          management: "managed",
          generation:
            "auth-generation-v1-00000000-0000-4000-8000-000000000040",
          account: "must-not-exist",
        },
        { endpointId: "claude-code-desktop", management: "pristine-legacy" },
      ],
    },
    { schemaVersion: 1, revision: 1, endpoints: "unreadable" },
  ];
  for (const malformed of malformedStates) {
    await writeFile(statePath, `${JSON.stringify(malformed)}\n`, "utf8");
    const reopened = createWorkLedgerAuthGenerationModule({ dataDirectory });
    assert.equal(reopened.captureForAcceptedCommand("codex-desktop"), undefined);
    assert.equal(
      reopened.isNativeResumeEligible({
        endpointId: "codex-desktop",
        sessionContext: null,
        commandContext: null,
      }),
      false,
    );
    assert.equal(
      reopened.prepareAuthenticationMutation({
        endpointId: "codex-desktop",
        action: "logout",
      }).kind,
      "blocked",
    );
  }

  await rm(statePath, { force: true });
  const missing = createWorkLedgerAuthGenerationModule({ dataDirectory });
  assert.equal(missing.captureForAcceptedCommand("codex-desktop"), undefined);
  assert.equal(
    missing.isNativeResumeEligible({
      endpointId: "codex-desktop",
      sessionContext: null,
      commandContext: null,
    }),
    false,
  );
});

test("a committed generation survives restart, preserves the transcript, and gates native resume", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-resume-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = {
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000010",
    canonicalDirectory: join(dataDirectory, "project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000010",
  } as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: record.recordKey,
      records: [record],
    })}\n`,
    "utf8",
  );
  const generation =
    "auth-generation-v1-00000000-0000-4000-8000-000000000010";
  const authGeneration: WorkLedgerAuthGenerationModule =
    createWorkLedgerAuthGenerationModule({
      dataDirectory,
      createGeneration: () => generation,
      createPreparationKey: () =>
        "auth-preparation-v1-00000000-0000-4000-8000-000000000010",
    });
  const databasePath = join(ledgerDirectory, `${record.ledgerSlot}.sqlite`);
  const adapter = new CompletingCoordinatorAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration,
  }).openProject(record.canonicalDirectory);

  await channel.act(startCommand("start-before-mutation"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(channel);
  const before = await channel.snapshot();
  assert.equal(before.commands[0]?.session?.resumable, true);
  const sessionId = before.commands[0]?.session?.sessionId;
  assert.equal(typeof sessionId, "string");

  const preparation = authGeneration.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(preparation.kind, "confirmation-required");
  assert.equal(
    preparation.kind === "confirmation-required"
      ? authGeneration.beginAuthenticationMutation({
          preparationKey: preparation.preparationKey,
        }).kind
      : "wrong-preparation",
    "begun",
  );

  const after = await channel.snapshot();
  assert.deepEqual(
    after.commands.map(({ commandId, input, session, status }) => ({
      commandId,
      input,
      status,
      events: session?.events,
      resumable: session?.resumable,
    })),
    before.commands.map(({ commandId, input, session, status }) => ({
      commandId,
      input,
      status,
      events: session?.events,
      resumable: false,
    })),
  );
  await assert.rejects(
    channel.act(continueCommand("stale-resume", sessionId!), {
      endpointId: "codex-desktop",
    }),
    { category: "continuation-unavailable" },
  );
  assert.equal(adapter.resumes.length, 0);

  await channel.act(startCommand("start-after-mutation"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(channel);
  const managedSnapshot = await channel.snapshot();
  const managedSession = managedSnapshot.commands.find(
    (command) => command.input === "preserved command" &&
      command.session?.sessionId !== sessionId,
  )?.session;
  assert.equal(managedSession?.resumable, true);
  await channel.act(
    continueCommand("current-resume", managedSession!.sessionId),
    { endpointId: "codex-desktop" },
  );
  await waitForTerminal(channel);
  assert.equal(adapter.resumes.length, 1);
  await channel.close();

  const restartedGeneration = createWorkLedgerAuthGenerationModule({
    dataDirectory,
  });
  const restartedAdapter = new CompletingCoordinatorAdapter();
  const restarted = await createWorkbenchCoordinator({
    databasePath,
    adapter: restartedAdapter,
    authGeneration: restartedGeneration,
  }).openProject(record.canonicalDirectory);
  const restartedSnapshot = await restarted.snapshot();
  assert.equal(restartedSnapshot.commands[0]?.session?.resumable, false);
  assert.ok(
    restartedSnapshot.commands.some(
      (command) =>
        command.session?.sessionId === managedSession?.sessionId &&
        command.session.resumable,
    ),
  );
  await assert.rejects(
    restarted.act(continueCommand("stale-resume-after-restart", sessionId!), {
      endpointId: "codex-desktop",
    }),
    { category: "continuation-unavailable" },
  );
  assert.equal(restartedAdapter.resumes.length, 0);
  assert.deepEqual(
    restartedSnapshot.commands[0]?.session?.events,
    before.commands[0]?.session?.events,
  );
  await restarted.close();
});

test("malformed Session generation removes resumability without removing transcript data", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-session-malformed-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = {
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000050",
    canonicalDirectory: join(dataDirectory, "project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000050",
  } as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: record.recordKey,
      records: [record],
    })}\n`,
    "utf8",
  );
  const authGeneration = createWorkLedgerAuthGenerationModule({ dataDirectory });
  const databasePath = join(ledgerDirectory, `${record.ledgerSlot}.sqlite`);
  const adapter = new CompletingCoordinatorAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration,
  }).openProject(record.canonicalDirectory);
  await channel.act(startCommand("malformed-session-start"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(channel);
  const before = await channel.snapshot();
  const sessionId = before.commands[0]?.session?.sessionId;
  assert.equal(typeof sessionId, "string");

  const database = new DatabaseSync(databasePath);
  database
    .prepare("UPDATE sessions SET auth_context_json = ? WHERE session_id = ?")
    .run(
      JSON.stringify({
        schemaVersion: 1,
        endpointId: "codex-desktop",
        management: "pristine-legacy",
        extra: true,
      }),
      sessionId!,
    );
  database.close();

  const after = await channel.snapshot();
  assert.equal(after.commands[0]?.session?.resumable, false);
  assert.deepEqual(
    after.commands[0]?.session?.events,
    before.commands[0]?.session?.events,
  );
  assert.equal(after.commands[0]?.input, before.commands[0]?.input);
  assert.equal(
    authGeneration.prepareAuthenticationMutation({
      endpointId: "codex-desktop",
      action: "logout",
    }).kind,
    "blocked",
  );
  await assert.rejects(
    channel.act(continueCommand("malformed-session-resume", sessionId!), {
      endpointId: "codex-desktop",
    }),
    { category: "continuation-unavailable" },
  );
  assert.equal(adapter.resumes.length, 0);
  await channel.close();
});

test("a registered migrated Work Ledger survives two auth cycles per provider across restarts and preserves recovery blockers", async (t) => {
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "workbench-auth-registered-legacy-"),
  );
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = {
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000055",
    canonicalDirectory: join(dataDirectory, "project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000055",
  } as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: record.recordKey,
      records: [record],
    })}\n`,
    "utf8",
  );
  const databasePath = join(ledgerDirectory, `${record.ledgerSlot}.sqlite`);
  const original = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingCoordinatorAdapter(),
  }).openProject(record.canonicalDirectory);
  await original.act(startCommand("registered-legacy-root"));
  await waitForTerminal(original);
  await original.close();

  const versionTwo = new DatabaseSync(databasePath);
  versionTwo.exec(`
    DROP INDEX sessions_project_display_ordinal_unique;
    ALTER TABLE sessions DROP COLUMN display_ordinal;
    ALTER TABLE sessions DROP COLUMN account_observation_json;
    ALTER TABLE sessions DROP COLUMN archived;
    ALTER TABLE sessions DROP COLUMN display_name_source;
    ALTER TABLE sessions DROP COLUMN display_name;
    ALTER TABLE commands DROP COLUMN auth_context_json;
    ALTER TABLE sessions DROP COLUMN auth_context_json;
    PRAGMA user_version = 2;
  `);
  versionTwo.close();

  const generations = createWorkLedgerAuthGenerationModule({ dataDirectory });
  const migrated = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingCoordinatorAdapter(),
    authGeneration: generations,
  }).openProject(record.canonicalDirectory);
  assert.equal((await migrated.snapshot()).commands[0]?.session?.resumable, true);
  await migrated.close();

  for (const endpointId of [
    "codex-desktop",
    "claude-code-desktop",
  ] as const) {
    for (const action of ["logout", "login"] as const) {
      const preparation = generations.prepareAuthenticationMutation({
        endpointId,
        action,
      });
      assert.deepEqual(
        preparation.kind === "confirmation-required"
          ? {
              kind: preparation.kind,
              consequences: preparation.consequences,
            }
          : preparation,
        {
          kind: "confirmation-required",
          consequences: { resumableSessionCount: 1, projectCount: 1 },
        },
      );
      assert.equal(
        preparation.kind === "confirmation-required" &&
          generations.cancelAuthenticationMutation({
            preparationKey: preparation.preparationKey,
          }),
        true,
      );
    }
  }

  const lastGeneration = new Map<string, string>();
  for (let round = 1; round <= 2; round += 1) {
    for (const endpointId of [
      "codex-desktop",
      "claude-code-desktop",
    ] as const) {
      for (const action of ["logout", "login"] as const) {
        // Recreate the module before every action. The state and the legacy-row
        // classification must therefore survive the same process boundary as an
        // app restart instead of relying on an in-memory preparation cache.
        const restarted = createWorkLedgerAuthGenerationModule({ dataDirectory });
        const preparation = restarted.prepareAuthenticationMutation({
          endpointId,
          action,
        });
        if (round === 1 && endpointId === "codex-desktop" && action === "logout") {
          assert.deepEqual(
            preparation.kind === "confirmation-required"
              ? {
                  kind: preparation.kind,
                  consequences: preparation.consequences,
                }
              : preparation,
            {
              kind: "confirmation-required",
              consequences: { resumableSessionCount: 1, projectCount: 1 },
            },
          );
        } else {
          assert.equal(preparation.kind, "ready");
        }
        assert.notEqual(preparation.kind, "blocked");
        if (preparation.kind === "blocked") continue;
        assert.deepEqual(
          restarted.beginAuthenticationMutation({
            preparationKey: preparation.preparationKey,
          }),
          { kind: "begun", endpointId, action },
        );

        const snapshot = restarted.captureRuntimeEndpointAuthGenerationSnapshot();
        assert.ok(snapshot);
        const endpoint =
          endpointId === "codex-desktop" ? snapshot.codex : snapshot.claude;
        assert.equal(endpoint.management, "managed");
        if (endpoint.management === "managed") {
          const prior = lastGeneration.get(endpointId);
          if (prior !== undefined) assert.notEqual(endpoint.generation, prior);
          lastGeneration.set(endpointId, endpoint.generation);
        }
      }
    }
  }

  const afterRestart = createWorkLedgerAuthGenerationModule({ dataDirectory });
  const persistent = afterRestart.captureRuntimeEndpointAuthGenerationSnapshot();
  assert.ok(persistent);
  assert.equal(persistent.codex.management, "managed");
  assert.equal(persistent.claude.management, "managed");
  if (persistent.codex.management === "managed") {
    assert.equal(persistent.codex.generation, lastGeneration.get("codex-desktop"));
  }
  if (persistent.claude.management === "managed") {
    assert.equal(
      persistent.claude.generation,
      lastGeneration.get("claude-code-desktop"),
    );
  }

  const partialContext = new DatabaseSync(databasePath);
  partialContext
    .prepare("UPDATE commands SET auth_context_json = ?")
    .run(pristineCodexContext);
  partialContext.close();
  for (const endpointId of [
    "codex-desktop",
    "claude-code-desktop",
  ] as const) {
    for (const action of ["logout", "login"] as const) {
      assert.deepEqual(
        afterRestart.prepareAuthenticationMutation({ endpointId, action }),
        {
          kind: "blocked",
          blockers: {
            accepted: 0,
            starting: 0,
            inFlight: 0,
            recoveryRequired: 0,
            unknown: 1,
          },
        },
      );
    }
  }

  const restoreExactLegacyAbsence = new DatabaseSync(databasePath);
  restoreExactLegacyAbsence
    .prepare("UPDATE commands SET auth_context_json = NULL")
    .run();
  restoreExactLegacyAbsence.close();

  const recovery = new DatabaseSync(databasePath);
  recovery
    .prepare(
      `UPDATE commands
          SET status = 'recovery-required',
              effect_phase = 'binding-claimed',
              outcome_uncertain = 1`,
    )
    .run();
  recovery
    .prepare(
      `UPDATE sessions
          SET lifecycle_status = 'recovery-required',
              opaque_session_reference = NULL`,
    )
    .run();
  recovery.close();

  for (const endpointId of [
    "codex-desktop",
    "claude-code-desktop",
  ] as const) {
    for (const action of ["logout", "login"] as const) {
      assert.deepEqual(
        generations.prepareAuthenticationMutation({ endpointId, action }),
        {
          kind: "blocked",
          blockers: {
            accepted: 0,
            starting: 0,
            inFlight: 0,
            recoveryRequired: 1,
            unknown: 0,
          },
        },
      );
    }
  }
});

test("a migrated missing generation keeps the complete legacy resume path only while pristine", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-legacy-resume-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  await writeFile(join(dataDirectory, "project-registry-v1.json"), emptyRegistry, "utf8");
  const projectDirectory = join(dataDirectory, "project");
  const databasePath = join(dataDirectory, "legacy-ledger.sqlite");
  const originalAdapter = new CompletingCoordinatorAdapter();
  const original = await createWorkbenchCoordinator({
    databasePath,
    adapter: originalAdapter,
  }).openProject(projectDirectory);
  await original.act(startCommand("legacy-root"));
  await waitForTerminal(original);
  const originalSnapshot = await original.snapshot();
  const sessionId = originalSnapshot.commands[0]?.session?.sessionId;
  assert.equal(typeof sessionId, "string");
  await original.close();

  const versionTwo = new DatabaseSync(databasePath);
  versionTwo.exec(`
    DROP INDEX sessions_project_display_ordinal_unique;
    ALTER TABLE sessions DROP COLUMN display_ordinal;
    ALTER TABLE sessions DROP COLUMN account_observation_json;
    ALTER TABLE sessions DROP COLUMN archived;
    ALTER TABLE sessions DROP COLUMN display_name_source;
    ALTER TABLE sessions DROP COLUMN display_name;
    ALTER TABLE commands DROP COLUMN auth_context_json;
    ALTER TABLE sessions DROP COLUMN auth_context_json;
    PRAGMA user_version = 2;
  `);
  versionTwo.close();

  const generations = createWorkLedgerAuthGenerationModule({ dataDirectory });
  const adapter = new CompletingCoordinatorAdapter();
  const migrated = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration: generations,
  }).openProject(projectDirectory);
  assert.equal((await migrated.snapshot()).commands[0]?.session?.resumable, true);
  await migrated.act(continueCommand("legacy-pristine-resume", sessionId!), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(migrated);
  assert.equal(adapter.resumes.length, 1);

  const preparation = generations.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(preparation.kind, "ready");
  assert.equal(
    preparation.kind === "ready"
      ? generations.beginAuthenticationMutation({
          preparationKey: preparation.preparationKey,
        }).kind
      : "wrong-preparation",
    "begun",
  );
  await assert.rejects(
    migrated.act(continueCommand("legacy-managed-rejection", sessionId!), {
      endpointId: "codex-desktop",
    }),
    { category: "continuation-unavailable" },
  );
  assert.equal(adapter.resumes.length, 1);
  assert.equal((await migrated.snapshot()).commands[0]?.session?.resumable, false);
  await migrated.close();
});

test("version-two Work Ledgers migrate exactly once and remain readable after restart", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "workbench-auth-migration-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = {
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000060",
    canonicalDirectory: join(dataDirectory, "project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000060",
  } as const;
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: record.recordKey,
      records: [record],
    })}\n`,
    "utf8",
  );
  const authGeneration = createWorkLedgerAuthGenerationModule({ dataDirectory });
  const databasePath = join(ledgerDirectory, `${record.ledgerSlot}.sqlite`);
  createVersionTwoEmptyLedger(databasePath);
  const adapter = new CompletingCoordinatorAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration,
  }).openProject(record.canonicalDirectory);
  assert.deepEqual(await channel.snapshot(), {
    projectId: (await channel.snapshot()).projectId,
    cursor: 0,
    commands: [],
  });
  await channel.close();

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    Number(
      (migrated.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ),
    6,
  );
  assert.deepEqual(
    (
      migrated.prepare("PRAGMA table_info(commands)").all() as unknown as Array<{
        name: string;
      }>
    ).map((column) => column.name).at(-1),
    "auth_context_json",
  );
  assert.equal(
    (
      migrated.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{
        name: string;
      }>
    ).map((column) => column.name).at(-1),
    "display_ordinal",
  );
  assert.deepEqual(
    (
      migrated.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{
        name: string;
      }>
    ).map((column) => column.name).slice(-6),
    [
      "auth_context_json",
      "display_name",
      "display_name_source",
      "archived",
      "account_observation_json",
      "display_ordinal",
    ],
  );
  migrated.close();

  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingCoordinatorAdapter(),
    authGeneration: createWorkLedgerAuthGenerationModule({ dataDirectory }),
  }).openProject(record.canonicalDirectory);
  assert.equal((await reopened.snapshot()).commands.length, 0);
  await reopened.close();
});
