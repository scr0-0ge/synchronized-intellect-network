import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
import {
  CoordinatorError,
  createWorkbenchCoordinator,
  type ContinueDirectProjectCommand,
  type ProjectChannel,
  type ProjectCommandSummary,
  type StartDirectProjectCommand,
} from "../../src/coordinator/index.ts";
import {
  accountSignInChangedRefusalCopy,
  createWorkLedgerAuthGenerationModule,
  parseDurableAccountObservation,
  type WorkLedgerAuthGenerationModule,
} from "../../src/coordinator/work-ledger-auth-generation.ts";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const profile: SessionProfile = Object.freeze({
  model: "fixture-model",
  effortLevel: "fixture-effort",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const catalog: RuntimeCatalog = Object.freeze({
  runtime: "fixture-runtime",
  models: Object.freeze([
    Object.freeze({
      id: profile.model,
      effortLevels: Object.freeze([profile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze([profile.executionMode]),
  accessModes: Object.freeze([profile.accessMode]),
});

const events: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({
    kind: "agent-message" as const,
    text: "PRESERVED_ACCOUNT_OBSERVATION_TRANSCRIPT",
  }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

const mark = (ordinal: number): string =>
  `account-observation-v1-00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

class CompletingBinding implements ResumableRuntimeBinding {
  readonly profile = profile;
  readonly opaqueSessionReference: string;

  constructor(opaqueSessionReference: string) {
    this.opaqueSessionReference = opaqueSessionReference;
  }

  async send(_input: RuntimeInput): Promise<void> {}

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    for (const event of events) yield structuredClone(event);
  }
}

class CompletingAdapter implements ResumableAgentRuntimeAdapter {
  readonly starts: RuntimeStart[] = [];
  readonly resumes: RuntimeResume[] = [];

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(catalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.starts.push(structuredClone(request));
    return new CompletingBinding(`native-${this.starts.length}`);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return new CompletingBinding(request.opaqueSessionReference);
  }
}

function startCommand(idempotencyKey: string): StartDirectProjectCommand {
  return Object.freeze({
    kind: "direct" as const,
    commandKind: "start" as const,
    idempotencyKey,
    runtime: "codex" as const,
    catalogRevision: "fixture-catalog-revision",
    preferences: Object.freeze({ global: profile }),
    profile,
    input: "opening turn",
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
    profile,
    input: "must never replay into another account",
  });
}

async function waitForTerminal(channel: ProjectChannel): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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

function observationModule(
  dataDirectory: string,
  marks: string[],
): WorkLedgerAuthGenerationModule {
  return createWorkLedgerAuthGenerationModule({
    dataDirectory,
    createAccountObservationMark: () => {
      const next = marks.shift();
      if (next === undefined) throw new Error("exhausted deterministic marks");
      return next;
    },
  });
}

async function temporaryProject(
  t: { after(fn: () => unknown): void },
  prefix: string,
): Promise<{
  readonly dataDirectory: string;
  readonly projectDirectory: string;
  readonly databasePath: string;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const projectDirectory = join(dataDirectory, "project");
  await mkdir(projectDirectory, { recursive: true });
  return {
    dataDirectory,
    projectDirectory,
    databasePath: join(dataDirectory, "ledger.sqlite"),
  };
}

function storedObservation(
  databasePath: string,
  sessionId: string,
): string | null {
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      reader
        .prepare(
          "SELECT account_observation_json FROM sessions WHERE session_id = ?",
        )
        .get(sessionId) as { account_observation_json: string | null }
    ).account_observation_json;
  } finally {
    reader.close();
  }
}

function onlySession(snapshot: {
  readonly commands: readonly ProjectCommandSummary[];
}): NonNullable<ProjectCommandSummary["session"]> {
  const session = snapshot.commands[0]?.session;
  assert.ok(session, "expected one durable Session in the snapshot");
  return session;
}

test("a Session stamped under one observed sign-in is refused after a different one", async (t) => {
  const { dataDirectory, projectDirectory, databasePath } =
    await temporaryProject(t, "f116-refusal-");
  const authGeneration = observationModule(dataDirectory, [mark(1), mark(2)]);
  assert.equal(
    authGeneration.observeEndpointAuthentication({
      endpointId: "codex-desktop",
      state: "bound",
    }),
    true,
  );

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration,
  }).openProject(projectDirectory);
  await channel.act(startCommand("f116-start"), { endpointId: "codex-desktop" });
  await waitForTerminal(channel);
  const session = onlySession(await channel.snapshot());
  assert.equal(session.resumable, true);
  assert.deepEqual(
    parseDurableAccountObservation(storedObservation(databasePath, session.sessionId)),
    {
      schemaVersion: 1,
      endpointId: "codex-desktop",
      mark: mark(1),
    },
  );
  assert.deepEqual(
    await channel.validateContinuationProfile({
      sessionId: session.sessionId,
      profile,
    }),
    { status: "compatible" },
  );

  // An out-of-band sign-out and a fresh sign-in: possibly another account.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "sign-in-required",
  });
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });

  const refused = onlySession(await channel.snapshot());
  assert.equal(refused.resumable, false);
  assert.deepEqual(
    await channel.validateContinuationProfile({
      sessionId: session.sessionId,
      profile,
    }),
    { status: "incompatible" },
  );
  await assert.rejects(
    channel.act(continueCommand("f116-continue", session.sessionId), {
      endpointId: "codex-desktop",
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.category === "continuation-unavailable",
  );

  // The refusal never silently drops the Session or its transcript.
  assert.equal(adapter.resumes.length, 0);
  assert.equal(refused.sessionId, session.sessionId);
  assert.equal(refused.displayName, session.displayName);
  assert.deepEqual(
    refused.events.map((event) =>
      event.kind === "agent-message" ? event.text : event.kind,
    ),
    events.map((event) =>
      event.kind === "agent-message" ? event.text : event.kind,
    ),
  );
  assert.equal(
    storedObservation(databasePath, session.sessionId) !== null,
    true,
  );
  await channel.close();
});

test("a stale stamp refuses at the execution seam before any native resume", async (t) => {
  const { dataDirectory, projectDirectory, databasePath } =
    await temporaryProject(t, "f116-execution-");
  const authGeneration = observationModule(dataDirectory, [mark(1), mark(2)]);
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });

  const first = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
    authGeneration,
  }).openProject(projectDirectory);
  await first.act(startCommand("f116-exec-start"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(first);
  const sessionId = onlySession(await first.snapshot()).sessionId;
  await first.close();

  // Accept a continuation and close before it is dispatched, so the durable
  // command survives as retryable work.
  const staged = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
    authGeneration,
  }).openProject(projectDirectory);
  const pending = staged.act(continueCommand("f116-exec-continue", sessionId), {
    endpointId: "codex-desktop",
  });
  const closing = staged.close();
  await pending;
  await closing;

  // The owner switches accounts out of band before the retry is dispatched.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "sign-in-required",
  });
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });

  const adapter = new CompletingAdapter();
  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration,
  }).openProject(projectDirectory);
  await waitForTerminal(reopened);
  const snapshot = await reopened.snapshot();
  const continuation = snapshot.commands.find(
    (command) => command.input === "must never replay into another account",
  );
  assert.equal(continuation?.status, "failed");
  assert.equal(continuation?.failureCategory, "runtime-failed");
  assert.equal(adapter.resumes.length, 0);
  assert.equal(adapter.starts.length, 0);
  await reopened.close();

  // Control: the identical staging flow without an account switch does resume,
  // so the refusal above is the discriminator and not the staging technique.
  const controlProject = await temporaryProject(t, "f116-execution-control-");
  const controlAuth = observationModule(controlProject.dataDirectory, [mark(1)]);
  controlAuth.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });
  const controlSeed = await createWorkbenchCoordinator({
    databasePath: controlProject.databasePath,
    adapter: new CompletingAdapter(),
    authGeneration: controlAuth,
  }).openProject(controlProject.projectDirectory);
  await controlSeed.act(startCommand("f116-control-start"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(controlSeed);
  const controlSessionId = onlySession(await controlSeed.snapshot()).sessionId;
  await controlSeed.close();

  const controlStaged = await createWorkbenchCoordinator({
    databasePath: controlProject.databasePath,
    adapter: new CompletingAdapter(),
    authGeneration: controlAuth,
  }).openProject(controlProject.projectDirectory);
  const controlPending = controlStaged.act(
    continueCommand("f116-control-continue", controlSessionId),
    { endpointId: "codex-desktop" },
  );
  const controlClosing = controlStaged.close();
  await controlPending;
  await controlClosing;

  const controlAdapter = new CompletingAdapter();
  const controlReopened = await createWorkbenchCoordinator({
    databasePath: controlProject.databasePath,
    adapter: controlAdapter,
    authGeneration: controlAuth,
  }).openProject(controlProject.projectDirectory);
  await waitForTerminal(controlReopened);
  const controlContinuation = (await controlReopened.snapshot()).commands.find(
    (command) => command.input === "must never replay into another account",
  );
  assert.equal(controlContinuation?.status, "completed");
  assert.equal(controlAdapter.resumes.length, 1);
  await controlReopened.close();
});

test("legacy and unobserved Sessions keep resuming and are never stamped blind", async (t) => {
  const { dataDirectory, projectDirectory, databasePath } =
    await temporaryProject(t, "f116-legacy-");
  const authGeneration = observationModule(dataDirectory, [mark(1)]);

  // No sign-in has been observed yet, so there is nothing to prove.
  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
    authGeneration,
  }).openProject(projectDirectory);
  await channel.act(startCommand("f116-legacy-start"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(channel);
  const session = onlySession(await channel.snapshot());
  assert.equal(storedObservation(databasePath, session.sessionId), null);
  assert.equal(session.resumable, true);

  // A later first observation must not retroactively refuse an unstamped row.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });
  assert.equal(onlySession(await channel.snapshot()).resumable, true);
  await channel.act(continueCommand("f116-legacy-continue", session.sessionId), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(channel);
  assert.equal(adapter.resumes.length, 1);
  assert.equal(storedObservation(databasePath, session.sessionId), null);
  await channel.close();
});

test("version two, three, and four era Ledgers all carry forward and still open", async (t) => {
  const { dataDirectory, projectDirectory } = await temporaryProject(
    t,
    "f116-migration-",
  );
  const authGeneration = observationModule(dataDirectory, [mark(1)]);
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });

  const downgrades = Object.freeze({
    4: [
      "DROP INDEX sessions_project_display_ordinal_unique;",
      "ALTER TABLE sessions DROP COLUMN display_ordinal;",
      "ALTER TABLE sessions DROP COLUMN account_observation_json;",
    ],
    3: [
      "DROP INDEX sessions_project_display_ordinal_unique;",
      "ALTER TABLE sessions DROP COLUMN display_ordinal;",
      "ALTER TABLE sessions DROP COLUMN account_observation_json;",
      "ALTER TABLE sessions DROP COLUMN archived;",
      "ALTER TABLE sessions DROP COLUMN display_name_source;",
      "ALTER TABLE sessions DROP COLUMN display_name;",
    ],
    2: [
      "DROP INDEX sessions_project_display_ordinal_unique;",
      "ALTER TABLE sessions DROP COLUMN display_ordinal;",
      "ALTER TABLE sessions DROP COLUMN account_observation_json;",
      "ALTER TABLE sessions DROP COLUMN archived;",
      "ALTER TABLE sessions DROP COLUMN display_name_source;",
      "ALTER TABLE sessions DROP COLUMN display_name;",
      "ALTER TABLE commands DROP COLUMN auth_context_json;",
      "ALTER TABLE sessions DROP COLUMN auth_context_json;",
    ],
  });

  for (const era of [2, 3, 4] as const) {
    const eraDirectory = join(projectDirectory, `era-${era}`);
    await mkdir(eraDirectory, { recursive: true });
    const databasePath = join(dataDirectory, `era-${era}.sqlite`);

    const seeded = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
      authGeneration,
    }).openProject(eraDirectory);
    await seeded.act(startCommand(`f116-era-${era}`), {
      endpointId: "codex-desktop",
    });
    await waitForTerminal(seeded);
    const sessionId = onlySession(await seeded.snapshot()).sessionId;
    await seeded.close();

    const downgrade = new DatabaseSync(databasePath);
    downgrade.exec(
      `${downgrades[era].join("\n")}\nPRAGMA user_version = ${era};`,
    );
    downgrade.close();

    const migrated = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
      authGeneration,
    }).openProject(eraDirectory);
    const session = onlySession(await migrated.snapshot());
    assert.equal(session.sessionId, sessionId);
    assert.equal(
      session.events.some(
        (event) =>
          event.kind === "agent-message" &&
          event.text === "PRESERVED_ACCOUNT_OBSERVATION_TRANSCRIPT",
      ),
      true,
      `era ${era} lost its transcript`,
    );
    // A migrated row carries no stamp and therefore never refuses on its own.
    assert.equal(storedObservation(databasePath, sessionId), null);
    assert.equal(session.resumable, true);
    await migrated.close();

    const reader = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      Number(
        (reader.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
      ),
      6,
      `era ${era} did not reach schema version six`,
    );
    assert.deepEqual(
      (
        reader.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{
          name: string;
        }>
      ).map((column) => column.name),
      [
        "session_id",
        "project_id",
        "root_command_id",
        "profile_json",
        "opaque_session_reference",
        "lifecycle_status",
        "auth_context_json",
        "display_name",
        "display_name_source",
        "archived",
        "account_observation_json",
        "display_ordinal",
      ],
      `era ${era} produced the wrong session columns`,
    );
    reader.close();

    // Reopening a freshly migrated Ledger must pass the row assertions again.
    const reopened = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
      authGeneration,
    }).openProject(eraDirectory);
    assert.equal(onlySession(await reopened.snapshot()).sessionId, sessionId);
    await reopened.close();
  }
});

test("an unadmitted or widened durable stamp fails the Ledger open closed", async (t) => {
  const { dataDirectory, projectDirectory } = await temporaryProject(
    t,
    "f116-adversarial-",
  );
  const authGeneration = observationModule(dataDirectory, [mark(1)]);
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });

  const rejected = Object.freeze([
    // A key the seam never admits, even beside a valid mark.
    JSON.stringify({
      schemaVersion: 1,
      endpointId: "codex-desktop",
      mark: mark(1),
      accountEmail: "owner@example.invalid",
    }),
    // An account-shaped substitute for the opaque mark.
    JSON.stringify({
      schemaVersion: 1,
      endpointId: "codex-desktop",
      mark: "owner@example.invalid",
    }),
    // A future schema version.
    JSON.stringify({
      schemaVersion: 2,
      endpointId: "codex-desktop",
      mark: mark(1),
    }),
    // An unknown endpoint.
    JSON.stringify({
      schemaVersion: 1,
      endpointId: "third-party-desktop",
      mark: mark(1),
    }),
    // A missing key.
    JSON.stringify({ schemaVersion: 1, mark: mark(1) }),
    // A non-canonical key order that would otherwise parse.
    `{"endpointId":"codex-desktop","mark":"${mark(1)}","schemaVersion":1}`,
    // Not an object at all.
    JSON.stringify([{ schemaVersion: 1, endpointId: "codex-desktop", mark: mark(1) }]),
    "not-json",
  ]);

  for (const [index, stamp] of rejected.entries()) {
    assert.equal(
      parseDurableAccountObservation(stamp),
      undefined,
      `stamp ${index} parsed when it must not`,
    );

    const caseDirectory = join(projectDirectory, `case-${index}`);
    await mkdir(caseDirectory, { recursive: true });
    const databasePath = join(dataDirectory, `case-${index}.sqlite`);
    const seeded = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
      authGeneration,
    }).openProject(caseDirectory);
    await seeded.act(startCommand(`f116-adversarial-${index}`), {
      endpointId: "codex-desktop",
    });
    await waitForTerminal(seeded);
    await seeded.close();

    const forged = new DatabaseSync(databasePath);
    forged.prepare("UPDATE sessions SET account_observation_json = ?").run(stamp);
    forged.close();

    await assert.rejects(
      createWorkbenchCoordinator({
        databasePath,
        adapter: new CompletingAdapter(),
        authGeneration,
      }).openProject(caseDirectory),
      (error: unknown) =>
        error instanceof CoordinatorError && error.category === "storage-failed",
      `stamp ${index} opened when it must fail closed`,
    );
  }
});

test("a stamp whose endpoint contradicts the Session authentication context fails closed", async (t) => {
  const { dataDirectory, projectDirectory, databasePath } =
    await temporaryProject(t, "f116-endpoint-drift-");
  const authGeneration = observationModule(dataDirectory, [mark(1)]);
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });
  const seeded = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
    authGeneration,
  }).openProject(projectDirectory);
  await seeded.act(startCommand("f116-endpoint-drift"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(seeded);
  await seeded.close();

  const forged = new DatabaseSync(databasePath);
  forged
    .prepare("UPDATE sessions SET account_observation_json = ?")
    .run(
      JSON.stringify({
        schemaVersion: 1,
        endpointId: "claude-code-desktop",
        mark: mark(1),
      }),
    );
  forged.close();

  await assert.rejects(
    createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
      authGeneration,
    }).openProject(projectDirectory),
    (error: unknown) =>
      error instanceof CoordinatorError && error.category === "storage-failed",
  );
});

test("the discriminator tracks only observed sign-in transitions and survives restart", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "f116-minting-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const authGeneration = observationModule(dataDirectory, [
    mark(1),
    mark(2),
    mark(3),
  ]);

  // Nothing observed yet: nothing to stamp and nothing to compare.
  assert.equal(authGeneration.captureAccountObservation("codex-desktop"), undefined);
  assert.equal(
    authGeneration.classifySessionAccountObservation(null),
    "not-comparable",
  );

  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });
  const first = authGeneration.captureAccountObservation("codex-desktop");
  assert.deepEqual(first, {
    schemaVersion: 1,
    endpointId: "codex-desktop",
    mark: mark(1),
  });
  assert.equal(Object.isFrozen(first), true);

  // A repeated bound observation is continuity, not a new sign-in.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });
  assert.deepEqual(
    authGeneration.captureAccountObservation("codex-desktop"),
    first,
  );

  // `unknown` is inert: a failed status read must not refuse healthy Sessions.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "unknown",
  });
  assert.deepEqual(
    authGeneration.captureAccountObservation("codex-desktop"),
    first,
  );
  assert.equal(
    authGeneration.classifySessionAccountObservation(JSON.stringify(first)),
    "same-sign-in",
  );

  // A signed-out gap ends the run; the stamp is no longer comparable.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "sign-in-required",
  });
  assert.equal(authGeneration.captureAccountObservation("codex-desktop"), undefined);
  assert.equal(
    authGeneration.classifySessionAccountObservation(JSON.stringify(first)),
    "not-comparable",
  );

  // Signing in again mints a fresh, unequal discriminator.
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });
  const second = authGeneration.captureAccountObservation("codex-desktop");
  assert.equal(second?.mark, mark(2));
  assert.equal(
    authGeneration.classifySessionAccountObservation(JSON.stringify(first)),
    "different-sign-in",
  );

  // The other endpoint is independent and still unobserved.
  assert.equal(
    authGeneration.captureAccountObservation("claude-code-desktop"),
    undefined,
  );

  // The observation is durable, so a restart is not read as a new sign-in.
  const restarted = observationModule(dataDirectory, [mark(4)]);
  assert.deepEqual(
    restarted.captureAccountObservation("codex-desktop"),
    second,
  );
  assert.equal(
    restarted.classifySessionAccountObservation(JSON.stringify(second)),
    "same-sign-in",
  );
  assert.equal(
    restarted.classifySessionAccountObservation(JSON.stringify(first)),
    "different-sign-in",
  );
  assert.equal(
    restarted.classifySessionAccountObservation("{}"),
    "unreadable",
  );

  // A stamped Session whose durable observation state is gone can no longer be
  // proven safe, so it fails closed rather than deferring.
  const stateFile = join(dataDirectory, "work-ledger-account-observations-v1.json");
  writeFileSync(stateFile, "corrupt", "utf8");
  const broken = observationModule(dataDirectory, []);
  assert.equal(broken.captureAccountObservation("codex-desktop"), undefined);
  assert.equal(
    broken.classifySessionAccountObservation(JSON.stringify(second)),
    "unreadable",
  );
  // An unstamped legacy Session is still never refused by a broken state.
  assert.equal(broken.classifySessionAccountObservation(null), "not-comparable");
});

test("the observation seam admits only the three non-secret states and no account channel", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "f116-seam-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const authGeneration = observationModule(dataDirectory, [mark(1)]);

  for (const request of [
    // A widened request carrying account material is refused outright.
    {
      endpointId: "codex-desktop",
      state: "bound",
      accountEmail: "owner@example.invalid",
    },
    { endpointId: "codex-desktop", state: "bound", plan: "pro" },
    { endpointId: "codex-desktop", state: "bound", apiKey: "secret" },
    // Unknown states and endpoints are refused.
    { endpointId: "codex-desktop", state: "logged-in" },
    { endpointId: "third-party-desktop", state: "bound" },
    { endpointId: "codex-desktop" },
    { state: "bound" },
  ] as ReadonlyArray<Record<string, unknown>>) {
    assert.equal(
      authGeneration.observeEndpointAuthentication(
        request as unknown as Parameters<
          WorkLedgerAuthGenerationModule["observeEndpointAuthentication"]
        >[0],
      ),
      false,
      `${JSON.stringify(request)} was admitted`,
    );
    assert.equal(
      authGeneration.captureAccountObservation("codex-desktop"),
      undefined,
    );
  }

  // Only the exact two-key request with an admitted state mints anything.
  assert.equal(
    authGeneration.observeEndpointAuthentication({
      endpointId: "codex-desktop",
      state: "bound",
    }),
    true,
  );
  assert.equal(
    authGeneration.captureAccountObservation("codex-desktop")?.mark,
    mark(1),
  );
});

test("no credential file, token, or account identifier participates in the derivation", () => {
  const derivationSources = Object.freeze([
    "src/coordinator/work-ledger-auth-generation.ts",
    "src/coordinator/sqlite-project-channel.ts",
    "src/agent-runtime/claude/authentication-status.ts",
  ]);
  // Every identifier that would mean the derivation had touched a credential or
  // an account identity. Comments naming them are the point of the guard, so the
  // scan runs over the code with comments removed.
  const forbidden = Object.freeze([
    "credentials.json",
    ".credentials",
    "auth.json",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "keychain",
    "Keychain",
    "accessToken",
    "refreshToken",
    "oauthToken",
    "apiKey",
    "accountEmail",
    "accountId",
    "accountIdentifier",
  ]);
  for (const relativePath of derivationSources) {
    const source = readFileSync(join(repositoryRoot, relativePath), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    for (const identifier of forbidden) {
      assert.equal(
        source.includes(identifier),
        false,
        `${relativePath} references ${identifier}`,
      );
    }
  }

  // The only signal the minting path consumes is the three-valued state, and
  // the durable stamp admits exactly three keys, none of which is account data.
  const observation = parseDurableAccountObservation({
    schemaVersion: 1,
    endpointId: "codex-desktop",
    mark: mark(1),
  });
  assert.ok(observation);
  assert.deepEqual(Object.keys(observation).sort(), [
    "endpointId",
    "mark",
    "schemaVersion",
  ]);
  // The mark is locally minted material, not a transform of anything readable.
  assert.match(observation.mark, /^account-observation-v1-[0-9a-f-]{36}$/u);
});

test("a Ledger opened without the observation module keeps its exact prior behaviour", async (t) => {
  const { dataDirectory, projectDirectory, databasePath } =
    await temporaryProject(t, "f116-uncomposed-");

  // No authGeneration at all: the shape every install has before the observation
  // feed is wired. Start, continue and resume must behave exactly as before.
  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
  }).openProject(projectDirectory);
  await channel.act(startCommand("f116-uncomposed-start"));
  await waitForTerminal(channel);
  const session = onlySession(await channel.snapshot());
  assert.equal(session.resumable, true);
  assert.equal(storedObservation(databasePath, session.sessionId), null);
  assert.deepEqual(
    await channel.validateContinuationProfile({
      sessionId: session.sessionId,
      profile,
    }),
    { status: "compatible" },
  );
  await channel.act(
    continueCommand("f116-uncomposed-continue", session.sessionId),
  );
  await waitForTerminal(channel);
  assert.equal(adapter.resumes.length, 1);
  await channel.close();

  // The Ledger is still at the current schema and reopens cleanly.
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    Number(
      (reader.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ),
    6,
  );
  reader.close();
  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  assert.equal(onlySession(await reopened.snapshot()).resumable, true);
  await reopened.close();
  assert.equal(dataDirectory.length > 0, true);
});

test("a stamped version-five Ledger still scans for Login and Logout, and a forged stamp blocks", async (t) => {
  // The Login/Logout consequence scan reads every registered Ledger directly.
  // Its version-five branch now reads and shape-checks account_observation_json,
  // so a real stamp must leave the scan readable — otherwise every Login and
  // Logout on the owner's own Ledgers would collapse to `blocked: unknown`.
  const dataDirectory = await mkdtemp(join(tmpdir(), "f116-auth-scan-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  const record = Object.freeze({
    recordKey: "project-record-v1-00000000-0000-4000-8000-000000000116",
    canonicalDirectory: join(dataDirectory, "project"),
    ledgerSlot: "project-ledger-v1-00000000-0000-4000-8000-000000000116",
  });
  await mkdir(record.canonicalDirectory, { recursive: true });
  writeFileSync(
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

  const marks = [mark(1)];
  const authGeneration = createWorkLedgerAuthGenerationModule({
    dataDirectory,
    createAccountObservationMark: () => {
      const next = marks.shift();
      if (next === undefined) throw new Error("exhausted deterministic marks");
      return next;
    },
  });
  authGeneration.observeEndpointAuthentication({
    endpointId: "codex-desktop",
    state: "bound",
  });

  const databasePath = join(ledgerDirectory, `${record.ledgerSlot}.sqlite`);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
    authGeneration,
  }).openProject(record.canonicalDirectory);
  await channel.act(startCommand("f116-scan-start"), {
    endpointId: "codex-desktop",
  });
  await waitForTerminal(channel);
  const session = onlySession(await channel.snapshot());
  assert.equal(session.resumable, true);
  // The scan below is only meaningful against a genuinely stamped row.
  assert.deepEqual(
    parseDurableAccountObservation(
      storedObservation(databasePath, session.sessionId),
    ),
    { schemaVersion: 1, endpointId: "codex-desktop", mark: mark(1) },
  );
  await channel.close();

  const scanned = authGeneration.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(
    scanned.kind,
    "confirmation-required",
    "a stamped version-five Ledger must stay readable to the consequence scan",
  );
  assert.deepEqual(
    scanned.kind === "confirmation-required" ? scanned.consequences : undefined,
    { resumableSessionCount: 1, projectCount: 1 },
  );
  assert.equal(
    authGeneration.cancelAuthenticationMutation({
      preparationKey: scanned.preparationKey,
    }),
    true,
  );

  // The same scan must fail closed on a stamp it does not admit, rather than
  // counting the Session as ordinary resumable work.
  const forged = new DatabaseSync(databasePath);
  forged
    .prepare("UPDATE sessions SET account_observation_json = ?")
    .run(JSON.stringify({ schemaVersion: 1, endpointId: "codex-desktop" }));
  forged.close();
  const blocked = authGeneration.prepareAuthenticationMutation({
    endpointId: "codex-desktop",
    action: "logout",
  });
  assert.equal(blocked.kind, "blocked");
  assert.deepEqual(
    blocked.kind === "blocked" ? blocked.blockers : undefined,
    {
      accepted: 0,
      starting: 0,
      inFlight: 0,
      recoveryRequired: 0,
      unknown: 1,
    },
  );
});

test("the refusal copy claims only what the discriminator proves", () => {
  assert.equal(
    accountSignInChangedRefusalCopy,
    "This Agent Session cannot be continued. A different provider sign-in is active now and this Session was started under an earlier one, so continuing could replay it into another account.",
  );
  // It must never claim to know which account is signed in.
  for (const forbidden of ["email", "account name", "signed in as", "@"]) {
    assert.equal(
      accountSignInChangedRefusalCopy.includes(forbidden),
      false,
      `the refusal copy leaks ${forbidden}`,
    );
  }
});
