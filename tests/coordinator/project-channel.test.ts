import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter as AgentRuntimeAdapter,
  ResumableRuntimeBinding as RuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import {
  CoordinatorError,
  createWorkbenchCoordinator,
  type CommandReceipt,
  type DirectProjectCommand,
  type ProjectChannel,
  type ProjectUpdate,
  type StartDirectProjectCommand,
} from "../../src/coordinator/index.ts";

const desiredProfile: SessionProfile = {
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
};

const catalog: RuntimeCatalog = {
  runtime: "codex",
  models: [{ id: "gpt-5.6-sol", effortLevels: ["high", "ultra"] }],
  executionModes: ["single-agent"],
  accessModes: ["full-access"],
};

const completedEvents: readonly NormalizedRuntimeEvent[] = [
  { kind: "session-started" },
  { kind: "turn-started" },
  { kind: "item-started", itemType: "agent-message" },
  { kind: "item-completed", itemType: "agent-message" },
  { kind: "agent-message", text: "FIXED_COORDINATOR_MARKER" },
  { kind: "turn-completed", status: "completed" },
];
const testSessionReference = "deterministic-session-reference";

test("opening an existing ledger adds indexes for update reads without a schema bump", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-update-indexes-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const initial = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  await initial.close();

  const plans = (database: DatabaseSync) => ({
    perCommandEventRead: database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT data_json
           FROM updates
          WHERE command_id = ? AND kind = 'runtime-event'
          ORDER BY cursor`,
      )
      .all("command") as unknown as Array<{ readonly detail: string }>,
    sessionModelReplyCursors: database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT session_id, MAX(cursor) AS cursor
           FROM updates
          WHERE project_id = ?
            AND session_id IS NOT NULL
            AND kind = 'runtime-event'
            AND json_extract(data_json, '$.event.kind') = 'agent-message'
          GROUP BY session_id`,
      )
      .all("project") as unknown as Array<{ readonly detail: string }>,
  });

  const before = new DatabaseSync(databasePath);
  before.exec(`
    DROP INDEX IF EXISTS updates_command_kind_cursor;
    DROP INDEX IF EXISTS updates_project_session_kind;
  `);
  const schemaVersion = Number(
    (before.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  const scanPlans = plans(before);
  before.close();
  assert.ok(
    [scanPlans.perCommandEventRead, scanPlans.sessionModelReplyCursors].every(
      (queryPlan) =>
        queryPlan.some(({ detail }) => detail.includes("SCAN updates")),
    ),
    JSON.stringify(scanPlans),
  );

  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  await reopened.close();

  const after = new DatabaseSync(databasePath, { readOnly: true });
  const searchPlans = plans(after);
  const indexNames = after
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'updates'
        ORDER BY name`,
    )
    .all() as unknown as Array<{ readonly name: string }>;
  const reopenedSchemaVersion = Number(
    (after.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  after.close();

  assert.match(
    searchPlans.perCommandEventRead.map(({ detail }) => detail).join("\n"),
    /SEARCH updates USING INDEX updates_command_kind_cursor/u,
  );
  assert.match(
    searchPlans.sessionModelReplyCursors
      .map(({ detail }) => detail)
      .join("\n"),
    /SEARCH updates USING INDEX updates_project_session_kind/u,
  );
  assert.deepEqual(
    indexNames.map(({ name }) => name),
    ["updates_command_kind_cursor", "updates_project_session_kind"],
  );
  assert.equal(reopenedSchemaVersion, schemaVersion);
});

test("Session recency cursor stops at the last model reply", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-reply-recency-"));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath: join(root, "ledger.sqlite"),
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  t.after(async () => {
    await channel.close();
    await rm(root, { recursive: true, force: true });
  });

  const receipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, receipt);
  const snapshot = await channel.snapshot();
  const updates = await collectUpdatesThrough(
    channel.observe({ after: 0 }),
    snapshot.cursor,
  );
  const reply = updates.find(
    (update) =>
      update.kind === "runtime-event" && update.event.kind === "agent-message",
  );
  const terminal = updates.find((update) => update.kind === "completed");
  assert.ok(reply);
  assert.ok(terminal);
  assert.ok(terminal.cursor > reply.cursor);
  assert.equal(
    snapshot.commands[0]?.session?.lastModelReplyCursor,
    reply.cursor,
    "completion and other later updates do not replace model-reply recency",
  );
  assert.equal(
    snapshot.commands[0]?.session?.acceptedCommandCursor,
    receipt.acceptedCursor,
    "the Session projection carries the command acceptance used while waiting for its first reply",
  );
});

test("snapshot reuses hot event timelines while cold rehydration stays field-identical", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-snapshot-event-cache-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(root, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  let channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
  }).openProject(projectDirectory);
  const resumeIdentity = {
    schemaVersion: 1 as const,
    endpointId: "codex-desktop" as const,
    nativeProfile: desiredProfile,
  };
  const firstReceipt = await channel.act(
    directCommand({ runtimeResumeIdentity: resumeIdentity }),
    { endpointId: "codex-desktop" },
  );
  const first = await waitForTerminalCommand(channel, firstReceipt);
  assert.ok(first.session !== undefined);

  const secondReceipt = await channel.act(
    {
      kind: "direct",
      commandKind: "continue",
      idempotencyKey: "snapshot-cache-continue",
      runtime: "codex",
      targetSessionId: first.session.sessionId,
      profile: desiredProfile,
      runtimeResumeIdentity: resumeIdentity,
      input: "fixed coordinator input",
    },
    { endpointId: "codex-desktop" },
  );
  await waitForTerminalCommand(channel, secondReceipt);
  const hot = await channel.snapshot();
  const hotAgain = await channel.snapshot();
  assert.deepEqual(hotAgain, hot, "a hot cache preserves every projected field");
  await channel.close();

  channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const cold = await channel.snapshot();
  await channel.close();
  assert.deepEqual(
    cold,
    hot,
    "incremental and full cold reads produce field-identical snapshots",
  );
  assert.strictEqual(
    hot.commands[0]?.session?.events,
    first.session.events,
    "a later command does not rebuild an earlier event timeline",
  );
  assert.strictEqual(
    hotAgain.commands[0]?.session?.events,
    hot.commands[0]?.session?.events,
    "unchanged event timelines are reused rather than read and parsed again",
  );
  assert.strictEqual(
    hotAgain.commands[1]?.session?.events,
    hot.commands[1]?.session?.events,
    "the incrementally added timeline is also reused once caught up",
  );
});

test("reasoning events survive terminal commit and both durable readback interfaces exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-w488-store-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory);
  const reasoning: NormalizedRuntimeEvent = { kind: "reasoning", text: "Compare the alternatives before choosing." };
  const events = [...completedEvents.slice(0, 2), reasoning, ...completedEvents.slice(2)];
  const adapter = new ReferenceAdapter(catalog, events);
  let channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
  t.after(async () => { await channel.close(); await rm(root, { recursive: true, force: true }); });
  const receipt = await channel.act(directCommand());
  const completed = await waitForTerminalCommand(channel, receipt);
  assert.equal(completed.status, "completed", "the store must admit the new reasoning event");
  assert.deepEqual(completed.session?.events, events, "terminal commit must not duplicate already-persisted reasoning");
  await channel.close();
  channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
  const snapshot = await channel.snapshot();
  assert.deepEqual(snapshot.commands[0]?.session?.events, events, "snapshot hydration preserves reasoning after reopen");
  const updates = await collectUpdatesThrough(channel.observe({ after: 0 }), snapshot.cursor);
  assert.deepEqual(updates.filter((u) => u.kind === "runtime-event").map((u) => u.kind === "runtime-event" ? u.event : undefined), events,
    "cursor replay preserves reasoning after reopen");
});

test("unknown runtime event fields degrade without ending the turn or entering durable readback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-runtime-extra-fields-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory);
  const warnings = t.mock.method(console, "warn", () => {});
  // Equivalent to a newer CLI/binding adding metadata to its normalized wire.
  const sourceEvents = JSON.parse(JSON.stringify([
    ...completedEvents.slice(0, 2).map((event) => ({ ...event, nextCliMetadata: "UNADMITTED" })),
    {
      kind: "progress",
      activity: "tool",
      nextCliMetadata: { query: "UNADMITTED" },
      tool: {
        type: "commandExecution",
        name: "Bash",
        nextCliToolMetadata: "UNADMITTED",
        parameter: {
          kind: "command",
          value: "pnpm test",
          truncated: false,
          nextCliParameterMetadata: "UNADMITTED",
        },
      },
    },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Edit",
        fileChanges: {
          files: [{
            path: "a.ts",
            truncated: false,
            lines: { additions: 2, deletions: 1, nextCliLineMetadata: "UNADMITTED" },
            nextCliFileMetadata: "UNADMITTED",
          }],
          totalFiles: 1,
          truncated: false,
          nextCliSummaryMetadata: "UNADMITTED",
        },
      },
    },
    { kind: "reasoning", text: "Check the search results.", nextCliMetadata: "UNADMITTED" },
    ...completedEvents.slice(2, -1).map((event) => ({ ...event, nextCliMetadata: "UNADMITTED" })),
    {
      kind: "turn-completed", status: "completed", nextCliMetadata: "UNADMITTED",
      context: { basis: "active-context", usedTokens: 144, windowTokens: 258_400, nextCliUsage: "UNADMITTED" },
    },
  ])) as NormalizedRuntimeEvent[];
  const expected: NormalizedRuntimeEvent[] = [
    ...completedEvents.slice(0, 2),
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "commandExecution",
        name: "Bash",
        parameter: { kind: "command", value: "pnpm test", truncated: false },
      },
    },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Edit",
        fileChanges: {
          files: [{
            path: "a.ts",
            truncated: false,
            lines: { additions: 2, deletions: 1 },
          }],
          totalFiles: 1,
          truncated: false,
        },
      },
    },
    { kind: "reasoning", text: "Check the search results." },
    ...completedEvents.slice(2, -1),
    { kind: "turn-completed", status: "completed", context: { basis: "active-context", usedTokens: 144, windowTokens: 258_400 } },
  ];
  const adapter = new ReferenceAdapter(catalog, sourceEvents);
  let channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
  t.after(async () => { await channel.close(); await rm(root, { recursive: true, force: true }); });
  const receipt = await channel.act(directCommand());
  const completed = await waitForTerminalCommand(channel, receipt);
  assert.equal(completed.status, "completed");
  assert.equal(completed.failureCategory, undefined);
  assert.deepEqual(completed.session?.events, expected);
  const diagnostics = warnings.mock.calls.map((call) => call.arguments);
  assert.equal(diagnostics.length, 9, "one diagnostic per affected event, including nested fields");
  assert.match(JSON.stringify(diagnostics), /nextCliMetadata/u);
  assert.match(JSON.stringify(diagnostics), /context.nextCliUsage/u);
  assert.match(JSON.stringify(diagnostics), /tool.nextCliToolMetadata/u);
  assert.match(JSON.stringify(diagnostics), /tool\.parameter\.nextCliParameterMetadata/u);
  assert.match(JSON.stringify(diagnostics), /tool\.fileChanges\.nextCliSummaryMetadata/u);
  assert.match(JSON.stringify(diagnostics), /tool\.fileChanges\.files\[0\]\.nextCliFileMetadata/u);
  assert.match(JSON.stringify(diagnostics), /tool\.fileChanges\.files\[0\]\.lines\.nextCliLineMetadata/u);
  assert.doesNotMatch(JSON.stringify(diagnostics), /UNADMITTED/u, "diagnostics name fields, not their values");
  assert.match(JSON.stringify(sourceEvents), /UNADMITTED/u, "the input is not mutated");
  await channel.close();
  channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
  const snapshot = await channel.snapshot();
  assert.deepEqual(snapshot.commands[0]?.session?.events, expected);
  const replay = await collectUpdatesThrough(channel.observe({ after: 0 }), snapshot.cursor);
  assert.deepEqual(replay.filter((u) => u.kind === "runtime-event").map((u) => u.event), expected);
  assert.equal(warnings.mock.calls.length, 9, "stored readback has no unknown fields to diagnose again");
});

test("unknown tool and parameter fields are diagnosed and stripped before durable readback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-runtime-tool-extra-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const warnings = t.mock.method(console, "warn", () => {});
  const cases = [
    {
      tool: { type: "webSearch", name: "Web Search", nextCliSearch: { query: "UNADMITTED" } },
      expected: { type: "webSearch", name: "Web Search" },
      field: "tool.nextCliSearch",
    },
    {
      tool: { type: "commandExecution", name: "Run command", parameter: { kind: "command", value: "echo hello", truncated: false, nextCliParameter: "UNADMITTED" } },
      expected: { type: "commandExecution", name: "Run command", parameter: { kind: "command", value: "echo hello", truncated: false } },
      field: "tool.parameter.nextCliParameter",
    },
  ] as const;
  for (const [index, row] of cases.entries()) {
    await t.test(row.field, async () => {
      const projectDirectory = join(root, String(index));
      const databasePath = join(projectDirectory, "ledger.sqlite");
      await mkdir(projectDirectory);
      const sourceEvents = JSON.parse(JSON.stringify([
        ...completedEvents.slice(0, 2),
        { kind: "progress", activity: "tool", tool: row.tool },
        ...completedEvents.slice(2),
      ])) as NormalizedRuntimeEvent[];
      const expected: NormalizedRuntimeEvent[] = [
        ...completedEvents.slice(0, 2),
        { kind: "progress", activity: "tool", tool: row.expected },
        ...completedEvents.slice(2),
      ];
      const adapter = new ReferenceAdapter(catalog, sourceEvents);
      let channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
      try {
        const receipt = await channel.act(directCommand());
        const terminal = await waitForTerminalCommand(channel, receipt);
        assert.equal(terminal.status, "completed");
        assert.deepEqual(terminal.session?.events, expected);
        assert.deepEqual(warnings.mock.calls.at(-1)?.arguments, [
          "[coordinator] Ignored unknown runtime event fields",
          { kind: "progress", fields: [row.field] },
        ]);
        assert.match(JSON.stringify(sourceEvents), /UNADMITTED/u, "input is not mutated");
        await channel.close();
        channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
        const snapshot = await channel.snapshot();
        assert.deepEqual(snapshot.commands[0]?.session?.events, expected);
        const replay = await collectUpdatesThrough(channel.observe({ after: 0 }), snapshot.cursor);
        assert.deepEqual(replay.filter((u) => u.kind === "runtime-event").map((u) => u.event), expected);
      } finally {
        await channel.close();
      }
    });
  }
  assert.equal(warnings.mock.calls.length, 2, "readback never re-emits ingress diagnostics");
});

for (const [label, malformed] of [
  ["non-string text", { kind: "reasoning", text: 42 }],
  ["unknown kind", { kind: "vendor-reasoning", text: "text" }],
] as const) {
  test(`reasoning store rejects ${label} before persistence`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "uaw-w488-shape-"));
    const projectDirectory = join(root, "project");
    await mkdir(projectDirectory);
    const adapter = new ReferenceAdapter(catalog, [malformed as unknown as NormalizedRuntimeEvent, ...completedEvents]);
    const channel = await createWorkbenchCoordinator({ databasePath: join(root, "ledger.sqlite"), adapter }).openProject(projectDirectory);
    t.after(async () => { await channel.close(); await rm(root, { recursive: true, force: true }); });
    const receipt = await channel.act(directCommand());
    const completed = await waitForTerminalCommand(channel, receipt);
    assert.equal(completed.status, "recovery-required", `the store rejects ${label}`);
    assert.equal(completed.session?.events.length, 0, "no malformed event may be durably appended");
  });
}

test("runtime ingress still rejects malformed known fields alongside unknown additions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "uaw-runtime-known-fields-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const malformedTools = [
    { type: "webSearch" },
    { name: "Web Search" },
    { type: 42, name: "Web Search" },
    { type: "vendor-new-tool", name: "Web Search" },
    { type: "webSearch", name: 42 },
    { type: "webSearch", name: "Web Search", sourceType: "vendor" },
    { type: "unknown", name: "Tool" },
    { type: "unknown", name: "Tool", sourceType: 42 },
    { type: "unknown", name: "Tool", sourceType: "x".repeat(100_000) },
    ...[
      null,
      { value: "echo hello", truncated: false },
      { kind: "command", truncated: false },
      { kind: "command", value: "echo hello" },
      { kind: "query", value: "echo hello", truncated: false },
      { kind: "command", value: 42, truncated: false },
      { kind: "command", value: "echo hello", truncated: "false" },
    ].map((parameter) => ({
      type: "commandExecution", name: "Run command",
      parameter: parameter === null ? null : { ...parameter, nextCliParameter: "UNADMITTED" },
    })),
  ];
  const malformedEvents = [
    { itemType: "agent-message" },
    { kind: "item-started" },
    { kind: "item-completed", itemType: 42 },
    { kind: "agent-message", text: null },
    { kind: "reasoning" },
    { kind: "reasoning", text: 42 },
    { kind: "progress" },
    { kind: "progress", activity: 42 },
    { kind: "progress", activity: "web-search" },
    { kind: "progress", activity: "tool", tool: null },
    { kind: "progress", activity: "tool", tool: 42 },
    ...malformedTools.map((tool) => ({
      kind: "progress", activity: "tool", tool: { ...tool, nextCliTool: "UNADMITTED" },
    })),
    { kind: "turn-completed" },
    { kind: "turn-completed", status: "failed" },
    { kind: "turn-completed", status: "completed", context: null },
    { kind: "turn-completed", status: "completed", context: { basis: "active-context", windowTokens: 258_400, nextCliUsage: true } },
    { kind: "turn-completed", status: "completed", context: { basis: "active-context", usedTokens: "144", windowTokens: 258_400, nextCliUsage: true } },
    { kind: "turn-interrupted", status: "completed" },
    { kind: "failed" },
    { kind: "failed", category: 42 },
    { kind: "failed", category: "new-failure" },
  ];
  for (const [index, malformed] of malformedEvents.entries()) {
    const projectDirectory = join(root, String(index));
    await mkdir(projectDirectory);
    const event = { ...malformed, nextCliMetadata: "UNADMITTED" } as unknown as NormalizedRuntimeEvent;
    const channel = await createWorkbenchCoordinator({
      databasePath: join(projectDirectory, "ledger.sqlite"),
      adapter: new ReferenceAdapter(catalog, [event, ...completedEvents]),
    }).openProject(projectDirectory);
    try {
      const receipt = await channel.act(directCommand());
      const terminal = await waitForTerminalCommand(channel, receipt);
      assert.equal(terminal.status, "recovery-required", JSON.stringify(malformed));
      assert.deepEqual(terminal.session?.events, [], "no malformed event enters the store");
    } finally {
      await channel.close();
    }
  }
});

const requestedProfileProjection = Object.freeze({
  kind: "recorded" as const,
  runtimeFamilyLabel: "Codex",
  endpointLabel: "Codex desktop",
  modelLabel: "Solution 5.6",
  workIntensityControlLabel: Object.freeze({
    label: "Reasoning",
    provenance: "runtime-catalog" as const,
  }),
  workIntensityLabel: "Maximum",
  executionModeLabel: "Single agent",
  accessModeLabel: "Full access",
});

function directCommand(
  overrides: Partial<StartDirectProjectCommand> = {},
): StartDirectProjectCommand {
  return {
    kind: "direct",
    commandKind: "start",
    idempotencyKey: "command-key-1",
    runtime: "codex",
    catalogRevision: "catalog-revision-09",
    preferences: { global: desiredProfile },
    profile: desiredProfile,
    input: "fixed coordinator input",
    ...overrides,
  };
}

class CompletingBinding implements RuntimeBinding {
  readonly profile = desiredProfile;
  readonly opaqueSessionReference = testSessionReference;

  async send(input: RuntimeInput): Promise<void> {
    assert.deepEqual(input, { text: "fixed coordinator input" });
  }

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    for (const event of completedEvents) yield structuredClone(event);
  }
}

class CompletingAdapter implements AgentRuntimeAdapter {
  readonly starts: RuntimeStart[] = [];
  readonly resumes: RuntimeResume[] = [];
  inspectCalls = 0;
  readonly beforeInspect?: () => void;

  constructor(beforeInspect?: () => void) {
    this.beforeInspect = beforeInspect;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    this.beforeInspect?.();
    return structuredClone(catalog);
  }

  async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    return new CompletingBinding();
  }

  async resume(request: RuntimeResume): Promise<RuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return new CompletingBinding();
  }
}

class ObservedProfileAdapter extends CompletingAdapter {
  observed: SessionProfile | undefined | "throw";

  constructor(observed: SessionProfile | undefined | "throw") {
    super();
    this.observed = observed;
  }

  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    return this.binding();
  }

  override async resume(request: RuntimeResume): Promise<RuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return this.binding();
  }

  private binding(): RuntimeBinding {
    const observed = this.observed;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(input: RuntimeInput): Promise<void> {
        assert.deepEqual(input, { text: "fixed coordinator input" });
      },
      effectiveProfile(): SessionProfile | undefined {
        if (observed === "throw") {
          throw new Error("PRIVATE_EFFECTIVE_OBSERVER_FAILURE");
        }
        return observed === undefined ? undefined : structuredClone(observed);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        for (const event of completedEvents) yield structuredClone(event);
      },
    };
  }
}

class StartFailingAdapter extends CompletingAdapter {
  readonly nativeBody: string;

  constructor(nativeBody: string) {
    super();
    this.nativeBody = nativeBody;
  }

  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    throw new Error(this.nativeBody);
  }
}

class FirstStartFailingAdapter extends CompletingAdapter {
  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    if (this.starts.length === 1) {
      throw new Error("NATIVE_FIRST_START_FAILURE_SENTINEL");
    }
    return new CompletingBinding();
  }
}

class InspectFailingAdapter extends CompletingAdapter {
  override async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    throw new Error("NATIVE_INSPECT_FAILURE_SENTINEL");
  }
}

class UnexpectedProfileFailingAdapter implements AgentRuntimeAdapter {
  private readonly profileAttemptedPromise: Promise<void>;
  private markProfileAttempted!: () => void;

  constructor() {
    this.profileAttemptedPromise = new Promise((resolve) => {
      this.markProfileAttempted = resolve;
    });
  }

  async profileAttempted(): Promise<void> {
    await this.profileAttemptedPromise;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    const adapter = this;
    return {
      runtime: "codex",
      get models(): RuntimeCatalog["models"] {
        adapter.markProfileAttempted();
        throw new Error("NATIVE_UNEXPECTED_PROFILE_SENTINEL");
      },
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    throw new Error("start must not follow a profile failure");
  }

  async resume(_request: RuntimeResume): Promise<RuntimeBinding> {
    throw new Error("resume must not follow a profile failure");
  }
}

class SendFailingAdapter extends CompletingAdapter {
  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(_input: RuntimeInput): Promise<void> {
        throw new Error("NATIVE_SEND_FAILURE_SENTINEL");
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        throw new Error("events must not start after a send failure");
      },
    };
  }
}

class EventRejectingAdapter extends CompletingAdapter {
  eventNextCalls = 0;
  eventReturnCalls = 0;

  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    const adapter = this;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(_input: RuntimeInput): Promise<void> {},
      events(): AsyncIterable<NormalizedRuntimeEvent> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<NormalizedRuntimeEvent> {
            return {
              async next(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                adapter.eventNextCalls += 1;
                throw new Error("NATIVE_EVENT_FAILURE_SENTINEL");
              },
              async return(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                adapter.eventReturnCalls += 1;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
  }
}

class CancellableEventAdapter extends CompletingAdapter {
  eventReturnCalls = 0;
  private cancelled = false;
  private pendingNext?: (
    result: IteratorResult<NormalizedRuntimeEvent>,
  ) => void;
  private readonly eventsStartedPromise: Promise<void>;
  private markEventsStarted!: () => void;

  constructor() {
    super();
    this.eventsStartedPromise = new Promise((resolve) => {
      this.markEventsStarted = resolve;
    });
  }

  async eventsStarted(): Promise<void> {
    await this.eventsStartedPromise;
  }

  releaseWithoutReturn(): void {
    this.cancelled = true;
    this.pendingNext?.({ done: true, value: undefined });
    this.pendingNext = undefined;
  }

  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    const adapter = this;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(_input: RuntimeInput): Promise<void> {},
      events(): AsyncIterable<NormalizedRuntimeEvent> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<NormalizedRuntimeEvent> {
            return {
              next(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                if (adapter.cancelled) {
                  return Promise.resolve({ done: true, value: undefined });
                }
                adapter.markEventsStarted();
                return new Promise((resolve) => {
                  adapter.pendingNext = resolve;
                });
              },
              async return(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                adapter.eventReturnCalls += 1;
                adapter.releaseWithoutReturn();
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
  }
}

class ThrowingReturnAccessorAdapter extends CompletingAdapter {
  returnAccessorReads = 0;
  private pendingNext?: (
    result: IteratorResult<NormalizedRuntimeEvent>,
  ) => void;
  private readonly eventsStartedPromise: Promise<void>;
  private markEventsStarted!: () => void;

  constructor() {
    super();
    this.eventsStartedPromise = new Promise((resolve) => {
      this.markEventsStarted = resolve;
    });
  }

  async eventsStarted(): Promise<void> {
    await this.eventsStartedPromise;
  }

  release(): void {
    this.pendingNext?.({ done: true, value: undefined });
    this.pendingNext = undefined;
  }

  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    const adapter = this;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(_input: RuntimeInput): Promise<void> {},
      events(): AsyncIterable<NormalizedRuntimeEvent> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<NormalizedRuntimeEvent> {
            return {
              next(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                adapter.markEventsStarted();
                return new Promise((resolve) => {
                  adapter.pendingNext = resolve;
                });
              },
              get return(): AsyncIterator<NormalizedRuntimeEvent>["return"] {
                adapter.returnAccessorReads += 1;
                if (adapter.returnAccessorReads === 1) {
                  throw new Error("NATIVE_RETURN_ACCESSOR_SENTINEL");
                }
                return async () => {
                  adapter.release();
                  return { done: true, value: undefined };
                };
              },
            };
          },
        };
      },
    };
  }
}

type HeldLifecycleSeam = "inspect" | "start" | "send";

class HeldLifecycleAdapter implements AgentRuntimeAdapter {
  readonly trace: string[] = [];
  private readonly heldSeam: HeldLifecycleSeam;
  private readonly seamReachedPromise: Promise<void>;
  private markSeamReached!: () => void;
  private readonly releaseSeamPromise: Promise<void>;
  private releaseSeam!: () => void;
  private pendingEvent?: (
    result: IteratorResult<NormalizedRuntimeEvent>,
  ) => void;

  constructor(heldSeam: HeldLifecycleSeam) {
    this.heldSeam = heldSeam;
    this.seamReachedPromise = new Promise((resolve) => {
      this.markSeamReached = resolve;
    });
    this.releaseSeamPromise = new Promise((resolve) => {
      this.releaseSeam = resolve;
    });
  }

  async seamReached(): Promise<void> {
    await this.seamReachedPromise;
  }

  release(): void {
    this.releaseSeam();
  }

  private async cross(seam: HeldLifecycleSeam): Promise<void> {
    this.trace.push(`${seam}-enter`);
    if (this.heldSeam === seam) {
      this.markSeamReached();
      await this.releaseSeamPromise;
    }
    this.trace.push(`${seam}-exit`);
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    await this.cross("inspect");
    return structuredClone(catalog);
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    await this.cross("start");
    const adapter = this;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(_input: RuntimeInput): Promise<void> {
        await adapter.cross("send");
      },
      events(): AsyncIterable<NormalizedRuntimeEvent> {
        return {
          [Symbol.asyncIterator](): AsyncIterator<NormalizedRuntimeEvent> {
            return {
              next(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                adapter.trace.push("events-next");
                return new Promise((resolve) => {
                  adapter.pendingEvent = resolve;
                });
              },
              async return(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                adapter.trace.push("events-return");
                adapter.pendingEvent?.({ done: true, value: undefined });
                adapter.pendingEvent = undefined;
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
  }

  async resume(_request: RuntimeResume): Promise<RuntimeBinding> {
    return this.start({ projectDirectory: "resume", profile: desiredProfile });
  }
}

class DeferredInspectAdapter extends CompletingAdapter {
  sendCalls = 0;
  eventStreamCalls = 0;
  private readonly expectedInput: string;
  private readonly inspectionStartedPromise: Promise<void>;
  private markInspectionStarted!: () => void;
  private readonly releaseInspectionPromise: Promise<void>;
  private releaseInspection!: () => void;

  constructor(expectedInput = "fixed coordinator input") {
    super();
    this.expectedInput = expectedInput;
    this.inspectionStartedPromise = new Promise((resolveInspectionStarted) => {
      this.markInspectionStarted = resolveInspectionStarted;
    });
    this.releaseInspectionPromise = new Promise((resolveInspection) => {
      this.releaseInspection = resolveInspection;
    });
  }

  async inspectionStarted(): Promise<void> {
    await this.inspectionStartedPromise;
  }

  release(): void {
    this.releaseInspection();
  }

  override async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    this.markInspectionStarted();
    await this.releaseInspectionPromise;
    return structuredClone(catalog);
  }

  override async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.starts.push(structuredClone(request));
    const adapter = this;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(input: RuntimeInput): Promise<void> {
        adapter.sendCalls += 1;
        assert.deepEqual(input, { text: adapter.expectedInput });
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        adapter.eventStreamCalls += 1;
        for (const event of completedEvents) yield structuredClone(event);
      },
    };
  }
}

class HeldSerialEffectsAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  activeEffects = 0;
  maximumActiveEffects = 0;
  readonly trace: string[] = [];
  private readonly firstEventsStartedPromise: Promise<void>;
  private markFirstEventsStarted!: () => void;
  private readonly releaseFirstEventsPromise: Promise<void>;
  private releaseFirstEvents!: () => void;

  constructor() {
    this.firstEventsStartedPromise = new Promise((resolve) => {
      this.markFirstEventsStarted = resolve;
    });
    this.releaseFirstEventsPromise = new Promise((resolve) => {
      this.releaseFirstEvents = resolve;
    });
  }

  async firstEventsStarted(): Promise<void> {
    await this.firstEventsStartedPromise;
  }

  release(): void {
    this.releaseFirstEvents();
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    const ordinal = ++this.inspectCalls;
    this.activeEffects += 1;
    this.maximumActiveEffects = Math.max(
      this.maximumActiveEffects,
      this.activeEffects,
    );
    this.trace.push(`inspect-${ordinal}`);
    return structuredClone(catalog);
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    const ordinal = ++this.startCalls;
    this.trace.push(`start-${ordinal}`);
    const adapter = this;
    return {
      profile: desiredProfile,
      opaqueSessionReference: testSessionReference,
      async send(input: RuntimeInput): Promise<void> {
        adapter.trace.push(`send-${ordinal}:${input.text}`);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        adapter.trace.push(`events-${ordinal}-start`);
        try {
          if (ordinal === 1) {
            adapter.markFirstEventsStarted();
            await adapter.releaseFirstEventsPromise;
          }
          for (const event of completedEvents) yield structuredClone(event);
        } finally {
          adapter.trace.push(`events-${ordinal}-end`);
          adapter.activeEffects -= 1;
        }
      },
    };
  }

  async resume(_request: RuntimeResume): Promise<RuntimeBinding> {
    return this.start({ projectDirectory: "resume", profile: desiredProfile });
  }
}

class ReferenceBinding implements RuntimeBinding {
  readonly profile = desiredProfile;
  readonly opaqueSessionReference = testSessionReference;
  readonly sourceEvents: NormalizedRuntimeEvent[];

  constructor(sourceEvents: NormalizedRuntimeEvent[]) {
    this.sourceEvents = sourceEvents;
  }

  async send(_input: RuntimeInput): Promise<void> {}

  async *events(): AsyncIterable<NormalizedRuntimeEvent> {
    for (const event of this.sourceEvents) yield event;
  }
}

class ReferenceAdapter implements AgentRuntimeAdapter {
  readonly sourceCatalog: RuntimeCatalog;
  readonly sourceEvents: NormalizedRuntimeEvent[];

  constructor(
    sourceCatalog: RuntimeCatalog,
    sourceEvents: NormalizedRuntimeEvent[],
  ) {
    this.sourceCatalog = sourceCatalog;
    this.sourceEvents = sourceEvents;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    return this.sourceCatalog;
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    return new ReferenceBinding(this.sourceEvents);
  }

  async resume(_request: RuntimeResume): Promise<RuntimeBinding> {
    return new ReferenceBinding(this.sourceEvents);
  }
}

async function collectUpdatesThrough<T extends { readonly cursor: number }>(
  updates: AsyncIterable<T>,
  capturedTail: number,
): Promise<T[]> {
  const iterator = updates[Symbol.asyncIterator]();
  try {
    return await takeUpdatesThrough(iterator, capturedTail);
  } finally {
    await iterator.return?.();
  }
}

async function takeUpdatesThrough<T extends { readonly cursor: number }>(
  iterator: AsyncIterator<T>,
  capturedTail: number,
): Promise<T[]> {
  const collected: T[] = [];
  while (true) {
    const result = await iterator.next();
    assert.equal(result.done, false, "observation ended before the captured tail");
    const update = result.value;
    assert.ok(update !== undefined);
    assert.ok(update.cursor <= capturedTail);
    collected.push(update);
    if (update.cursor === capturedTail) return collected;
  }
}

async function waitForTerminalCommand(
  channel: ProjectChannel,
  receipt: CommandReceipt,
) {
  let snapshot = await channel.snapshot();
  let command = snapshot.commands.find(
    (candidate) => candidate.commandId === receipt.commandId,
  );
  if (
    command?.status === "completed" ||
    command?.status === "failed" ||
    command?.status === "recovery-required"
  ) {
    return command;
  }

  const iterator = channel
    .observe({ after: snapshot.cursor })
    [Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await iterator.next();
      assert.equal(result.done, false, "channel closed before terminal command state");
      const update = result.value;
      if (
        update?.commandId === receipt.commandId &&
        (update.kind === "completed" ||
          update.kind === "failed" ||
          update.kind === "recovery-required")
      ) {
        snapshot = await channel.snapshot();
        command = snapshot.commands.find(
          (candidate) => candidate.commandId === receipt.commandId,
        );
        assert.ok(command !== undefined);
        return command;
      }
    }
  } finally {
    await iterator.return?.();
  }
}

test("act returns its durable receipt while Adapter inspection remains pending", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const exactInput = "  accepted input\n第二行保持原样  ";
  const adapter = new DeferredInspectAdapter(exactInput);
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  let earlyReceipt: CommandReceipt | undefined;
  const actResult = channel.act(directCommand({ input: exactInput })).then((receipt) => {
    earlyReceipt = receipt;
    return receipt;
  });

  try {
    await adapter.inspectionStarted();
    assert.ok(earlyReceipt !== undefined);
    assert.equal(adapter.starts.length, 0, "no Runtime Session exists before inspection");

    const receipt = earlyReceipt;
    const preRuntimeSessionSnapshot = await channel.snapshot();
    assert.equal(preRuntimeSessionSnapshot.commands.length, 1);
    assert.equal(preRuntimeSessionSnapshot.commands[0]?.status, "in-flight");
    assert.equal(preRuntimeSessionSnapshot.commands[0]?.input, exactInput);
    assert.deepEqual(
      await collectUpdatesThrough(
        channel.observe({ after: 0 }),
        receipt.acceptedCursor,
      ),
      [
        {
          cursor: receipt.acceptedCursor,
          commandId: receipt.commandId,
          kind: "accepted",
          status: "accepted",
        },
      ],
    );

    adapter.release();
    assert.equal((await waitForTerminalCommand(channel, receipt)).status, "completed");
  } finally {
    adapter.release();
    await actResult.catch(() => undefined);
    await channel.close();
  }
});

test("concurrent commands return ordered receipts while their effects remain serial", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new HeldSerialEffectsAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const receiptOrder: string[] = [];
  const queuedExactInput = "  queued input\n第二行保持原样  ";
  const firstAct = channel
    .act(directCommand({ idempotencyKey: "ordered-command-1", input: "first" }))
    .then((receipt) => {
      receiptOrder.push("first");
      return receipt;
    });
  const secondAct = channel
    .act(
      directCommand({
        idempotencyKey: "ordered-command-2",
        input: queuedExactInput,
      }),
    )
    .then((receipt) => {
      receiptOrder.push("second");
      return receipt;
    });

  try {
    await adapter.firstEventsStarted();
    const [firstReceipt, secondReceipt] = await Promise.all([firstAct, secondAct]);
    assert.deepEqual(receiptOrder, ["first", "second"]);
    assert.ok(firstReceipt.acceptedCursor < secondReceipt.acceptedCursor);
    assert.equal(adapter.inspectCalls, 1);
    assert.equal(adapter.maximumActiveEffects, 1);
    const writer = new DatabaseSync(databasePath);
    const durableSecond = writer
      .prepare("SELECT target_session_id FROM commands WHERE command_id = ?")
      .get(secondReceipt.commandId) as { target_session_id: string };
    try {
      writer
        .prepare("UPDATE commands SET target_session_id = ? WHERE command_id = ?")
        .run("temporarily-unlinked-session", secondReceipt.commandId);
      const queuedSnapshot = await channel.snapshot();
      assert.deepEqual(
        queuedSnapshot.commands.map((command) => command.status),
        ["in-flight", "accepted"],
      );
      assert.deepEqual(queuedSnapshot.commands[1], {
        commandId: secondReceipt.commandId,
        runtime: "codex",
        status: "accepted",
        input: queuedExactInput,
      });
    } finally {
      writer
        .prepare("UPDATE commands SET target_session_id = ? WHERE command_id = ?")
        .run(durableSecond.target_session_id, secondReceipt.commandId);
      writer.close();
    }

    adapter.release();
    const [firstCommand, secondCommand] = await Promise.all([
      waitForTerminalCommand(channel, firstReceipt),
      waitForTerminalCommand(channel, secondReceipt),
    ]);
    assert.deepEqual(
      [firstCommand.status, secondCommand.status],
      ["completed", "completed"],
    );
    assert.equal(adapter.inspectCalls, 2);
    assert.equal(adapter.maximumActiveEffects, 1);
    assert.deepEqual(adapter.trace, [
      "inspect-1",
      "start-1",
      "send-1:first",
      "events-1-start",
      "events-1-end",
      "inspect-2",
      "start-2",
      `send-2:${queuedExactInput}`,
      "events-2-start",
      "events-2-end",
    ]);
  } finally {
    adapter.release();
    await Promise.all([firstAct.catch(() => undefined), secondAct.catch(() => undefined)]);
    await channel.close();
  }
});

test("same-payload retries converge at accepted, in-flight, and terminal states", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new DeferredInspectAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const command = directCommand({ idempotencyKey: "lifecycle-retry-key" });
  const firstReceipt = await channel.act(command);

  try {
    const acceptedSnapshotResult = channel.snapshot();
    const acceptedRetryResult = channel.act(command);
    const acceptedSnapshot = await acceptedSnapshotResult;
    assert.equal(acceptedSnapshot.commands[0]?.status, "accepted");
    assert.equal(acceptedSnapshot.commands[0]?.input, command.input);
    assert.equal(acceptedSnapshot.commands.length, 1);
    assert.deepEqual(await acceptedRetryResult, firstReceipt);

    await adapter.inspectionStarted();
    const inFlightSnapshot = await channel.snapshot();
    const inFlightCursor = inFlightSnapshot.cursor;
    assert.equal(inFlightSnapshot.commands[0]?.status, "in-flight");
    assert.equal(inFlightSnapshot.commands[0]?.input, command.input);
    assert.equal(inFlightSnapshot.commands.length, 1);
    assert.deepEqual(await channel.act(command), firstReceipt);
    assert.equal((await channel.snapshot()).cursor, inFlightCursor);

    await assert.rejects(
      channel.act({ ...command, input: "conflicting lifecycle retry" }),
      (error) =>
        error instanceof CoordinatorError &&
        error.category === "idempotency-conflict",
    );
    const afterConflict = await channel.snapshot();
    assert.equal(afterConflict.cursor, inFlightCursor);
    assert.deepEqual(afterConflict.commands.map((summary) => summary.input), [
      command.input,
    ]);

    adapter.release();
    const terminal = await waitForTerminalCommand(channel, firstReceipt);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.input, command.input);
    const terminalSnapshot = await channel.snapshot();
    assert.deepEqual(await channel.act(command), firstReceipt);
    assert.equal((await channel.snapshot()).cursor, terminalSnapshot.cursor);
    assert.deepEqual(terminalSnapshot.commands.map((summary) => summary.input), [
      command.input,
    ]);
    assert.equal(adapter.inspectCalls, 1);
    assert.equal(adapter.starts.length, 1);
    assert.equal(adapter.sendCalls, 1);
    assert.equal(adapter.eventStreamCalls, 1);

    const updates = await collectUpdatesThrough(
      channel.observe({ after: 0 }),
      terminalSnapshot.cursor,
    );
    assert.deepEqual(
      updates.map((update) => update.kind),
      [
        "accepted",
        "in-flight",
        "profile-resolved",
        "interrupt-capability",
        ...completedEvents.map(() => "runtime-event"),
        "completed",
      ],
    );
  } finally {
    adapter.release();
    await channel.close();
  }
});

test("ProjectChannel reports durable turn activity without mutating the Work Ledger", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new DeferredInspectAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const receipt = await channel.act(
    directCommand({ idempotencyKey: "turn-activity-key" }),
  );

  try {
    assert.equal(channel.readTurnActivity(), "accepted");
    const acceptedCursor = (await channel.snapshot()).cursor;
    assert.equal(channel.readTurnActivity(), "accepted");
    assert.equal((await channel.snapshot()).cursor, acceptedCursor);

    await adapter.inspectionStarted();
    assert.equal(channel.readTurnActivity(), "in-flight");
    const inFlightCursor = (await channel.snapshot()).cursor;
    assert.equal(channel.readTurnActivity(), "in-flight");
    assert.equal((await channel.snapshot()).cursor, inFlightCursor);

    adapter.release();
    assert.equal((await waitForTerminalCommand(channel, receipt)).status, "completed");
    assert.equal(channel.readTurnActivity(), "idle");
    const terminalCursor = (await channel.snapshot()).cursor;
    assert.equal(channel.readTurnActivity(), "idle");
    assert.equal((await channel.snapshot()).cursor, terminalCursor);

    await channel.close();
    assert.equal(channel.readTurnActivity(), "unknown");
  } finally {
    adapter.release();
    await channel.close().catch(() => undefined);
  }
});

test("background inspect, profile, start, send, event, and terminal failures stay fixed and contained", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const eventRejectingAdapter = new EventRejectingAdapter();
  const cases: Array<{
    readonly name: string;
    readonly adapter: AgentRuntimeAdapter;
    readonly command: DirectProjectCommand;
    readonly expectedStatus: "failed" | "recovery-required";
    readonly expectedCategory?: "profile-resolution-failed" | "runtime-failed";
  }> = [
    {
      name: "inspect",
      adapter: new InspectFailingAdapter(),
      command: directCommand(),
      expectedStatus: "failed",
      expectedCategory: "runtime-failed",
    },
    {
      name: "profile",
      adapter: new CompletingAdapter(),
      command: directCommand({
        preferences: {
          global: { ...desiredProfile, model: "unsupported-private-model" },
        },
      }),
      expectedStatus: "failed",
      expectedCategory: "profile-resolution-failed",
    },
    {
      name: "start",
      adapter: new StartFailingAdapter("NATIVE_START_FAILURE_SENTINEL"),
      command: directCommand(),
      expectedStatus: "recovery-required",
    },
    {
      name: "send",
      adapter: new SendFailingAdapter(),
      command: directCommand(),
      expectedStatus: "recovery-required",
    },
    {
      name: "event",
      adapter: eventRejectingAdapter,
      command: directCommand(),
      expectedStatus: "recovery-required",
    },
    {
      name: "terminal",
      adapter: new ReferenceAdapter(structuredClone(catalog), [
        { kind: "session-started" },
      ]),
      command: directCommand(),
      expectedStatus: "recovery-required",
    },
  ];

  for (const failureCase of cases) {
    const caseDirectory = join(temporaryDirectory, failureCase.name);
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const channel = await createWorkbenchCoordinator({
      databasePath,
      adapter: failureCase.adapter,
    }).openProject(projectDirectory);
    const receipt = await channel.act(failureCase.command);
    const terminal = await waitForTerminalCommand(channel, receipt);
    const snapshot = await channel.snapshot();
    const replay = await collectUpdatesThrough(
      channel.observe({ after: 0 }),
      snapshot.cursor,
    );

    assert.equal(terminal.status, failureCase.expectedStatus, failureCase.name);
    assert.equal(
      terminal.failureCategory,
      failureCase.expectedCategory,
      failureCase.name,
    );
    assert.equal(
      /NATIVE_|unsupported-private-model/.test(JSON.stringify({ snapshot, replay })),
      false,
      failureCase.name,
    );
    // An unknown/failed turn is never completed. Session usability is separate:
    // these send/event/terminal fixtures still acknowledge a fresh resume.
    const settledCommand = snapshot.commands.find(
      (command) => command.status === failureCase.expectedStatus,
    );
    assert.notEqual(settledCommand?.status, "completed", `${failureCase.name}: not completed`);
    assert.equal(
      settledCommand?.session?.resumable,
      ["send", "event", "terminal"].includes(failureCase.name),
      `${failureCase.name}: usability follows the independent resume observation`,
    );
    await channel.close();
  }

  assert.equal(eventRejectingAdapter.eventNextCalls, 1);
  assert.equal(eventRejectingAdapter.eventReturnCalls, 1);
});

test("a continuation failure records WHY: the adapter category reaches the durable row and survives reopen (F223)", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  class ResumeRejectingAdapter extends CompletingAdapter {
    override async resume(request: RuntimeResume): Promise<RuntimeBinding> {
      this.resumes.push(structuredClone(request));
      throw new RuntimeAdapterError("unsupported-selection");
    }
  }
  const adapter = new ResumeRejectingAdapter();
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter,
  }).openProject(projectDirectory);
  const startReceipt = await channel.act(
    directCommand({
      runtimeResumeIdentity: {
        schemaVersion: 1,
        endpointId: "codex-desktop",
        nativeProfile: desiredProfile,
      },
    }),
    { endpointId: "codex-desktop" },
  );
  const started = await waitForTerminalCommand(channel, startReceipt);
  assert.equal(started.status, "completed");
  const sessionId = started.session?.sessionId;
  assert.ok(sessionId !== undefined);

  const continueReceipt = await channel.act(
    {
      kind: "direct",
      commandKind: "continue",
      idempotencyKey: "continue-records-why",
      runtime: "codex",
      targetSessionId: sessionId,
      profile: desiredProfile,
      runtimeResumeIdentity: {
        schemaVersion: 1,
        endpointId: "codex-desktop",
        nativeProfile: desiredProfile,
      },
      input: "fixed coordinator input",
    },
    { endpointId: "codex-desktop" },
  );
  const terminal = await waitForTerminalCommand(channel, continueReceipt);
  assert.equal(terminal.status, "recovery-required");
  assert.equal(adapter.resumes.length, 1);
  // The summary contract is unchanged: a recovery-required command never
  // surfaces a failureCategory to snapshot consumers...
  assert.equal(terminal.failureCategory, undefined);
  await channel.close();

  // ...while the durable row itself now names the adapter's reason.
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = reader
      .prepare("SELECT status, failure_category FROM commands WHERE command_id = ?")
      .get(continueReceipt.commandId) as {
      status: string;
      failure_category: string | null;
    };
    assert.equal(row.status, "recovery-required");
    assert.equal(row.failure_category, "unsupported-selection");
  } finally {
    reader.close();
  }

  // Reopening runs the startup sweep over uncertain commands; the recorded
  // reason must survive that sweep instead of being reset to NULL.
  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  await reopened.close();
  const afterReopen = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = afterReopen
      .prepare("SELECT status, failure_category FROM commands WHERE command_id = ?")
      .get(continueReceipt.commandId) as {
      status: string;
      failure_category: string | null;
    };
    assert.equal(row.status, "recovery-required");
    assert.equal(row.failure_category, "unsupported-selection");
  } finally {
    afterReopen.close();
  }
});

test("a recovery barrier stays on its Session while an independent replacement Session can complete", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new FirstStartFailingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const firstReceipt = await channel.act(directCommand());
  const recoveryRequired = await waitForTerminalCommand(channel, firstReceipt);
  assert.equal(recoveryRequired.status, "recovery-required");
  const affectedSessionId = recoveryRequired.session?.sessionId;
  assert.equal(typeof affectedSessionId, "string");

  await assert.rejects(
    channel.act({
      kind: "direct",
      commandKind: "continue",
      idempotencyKey: "affected-session-continuation",
      runtime: "codex",
      targetSessionId: affectedSessionId!,
      profile: desiredProfile,
      input: "fixed coordinator input",
    }),
    (error: unknown) =>
      error instanceof CoordinatorError &&
      error.category === "continuation-unavailable",
  );

  const replacementReceipt = await channel.act(
    directCommand({ idempotencyKey: "independent-replacement-session" }),
  );
  const replacement = await waitForTerminalCommand(channel, replacementReceipt);
  assert.equal(replacement.status, "completed");
  const snapshot = await channel.snapshot();
  assert.deepEqual(
    snapshot.commands.map((command) => command.status),
    ["recovery-required", "completed"],
  );
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.resumes.length, 0);
  await channel.close();
});

test("an unexpected profile exception reaches the fixed durable profile failure", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new UnexpectedProfileFailingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const receipt = await channel.act(directCommand());
  await adapter.profileAttempted();
  await channel.close();

  const reopenedChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  try {
    const snapshot = await reopenedChannel.snapshot();
    assert.deepEqual(snapshot.commands[0], {
      commandId: receipt.commandId,
      runtime: "codex",
      status: "failed",
      failureCategory: "profile-resolution-failed",
      input: "fixed coordinator input",
      session: {
        sessionId: snapshot.commands[0]?.session?.sessionId,
        displayName: "fixed coordinator input",
        archived: false,
        profile: desiredProfile,
        acceptedCommandCursor: receipt.acceptedCursor,
        resumable: false,
        events: [],
      },
    });
    assert.equal(
      JSON.stringify(snapshot).includes("NATIVE_UNEXPECTED_PROFILE_SENTINEL"),
      false,
    );
  } finally {
    await reopenedChannel.close();
  }
});

test("close preserves safely retryable work at the acceptance seam", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const actResult = channel.act(directCommand());
  const firstClose = channel.close();
  const repeatedClose = channel.close();

  try {
    assert.strictEqual(repeatedClose, firstClose);
    const receipt = await actResult;
    await firstClose;

    const reopenedAdapter = new CompletingAdapter();
    const reopenedChannel = await createWorkbenchCoordinator({
      databasePath,
      adapter: reopenedAdapter,
    }).openProject(projectDirectory);
    try {
      const command = await waitForTerminalCommand(reopenedChannel, receipt);
      assert.equal(command?.commandId, receipt.commandId);
      assert.equal(command?.status, "completed");
      assert.equal(adapter.inspectCalls, 0);
      assert.equal(adapter.starts.length, 0);
      assert.equal(reopenedAdapter.inspectCalls, 1);
      assert.equal(reopenedAdapter.starts.length, 1);
      assert.equal(reopenedAdapter.resumes.length, 0);
    } finally {
      await reopenedChannel.close();
    }
  } finally {
    await actResult.catch(() => undefined);
    await firstClose.catch(() => undefined);
  }
});

test("close cancels an active runtime iterator before SQLite closes", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CancellableEventAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const receipt = await channel.act(directCommand());
  await adapter.eventsStarted();
  const cursorBeforeClose = (await channel.snapshot()).cursor;
  const observer = channel
    .observe({ after: cursorBeforeClose })
    [Symbol.asyncIterator]();
  const pendingObservation = observer.next();
  const firstClose = channel.close();

  try {
    assert.strictEqual(channel.close(), firstClose);
    assert.deepEqual(await pendingObservation, { done: true, value: undefined });
    assert.equal(adapter.eventReturnCalls, 1);
    await firstClose;

    const reopenedChannel = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
    }).openProject(projectDirectory);
    try {
      const command = (await reopenedChannel.snapshot()).commands[0];
      assert.equal(command?.commandId, receipt.commandId);
      assert.equal(command?.status, "recovery-required");
      assert.equal(command?.failureCategory, undefined);
    } finally {
      await reopenedChannel.close();
    }
  } finally {
    adapter.releaseWithoutReturn();
    await firstClose.catch(() => undefined);
  }
});

test("a throwing runtime return accessor cannot escape or split close", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new ThrowingReturnAccessorAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const receipt = await channel.act(directCommand());
  await adapter.eventsStarted();
  let closeResult: Promise<void> | undefined;

  try {
    assert.doesNotThrow(() => {
      closeResult = channel.close();
    });
    assert.ok(closeResult !== undefined);
    assert.strictEqual(channel.close(), closeResult);
    assert.equal(adapter.returnAccessorReads, 1);
    adapter.release();
    await closeResult;

    const reopenedChannel = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
    }).openProject(projectDirectory);
    try {
      const command = (await reopenedChannel.snapshot()).commands[0];
      assert.equal(command?.commandId, receipt.commandId);
      assert.equal(command?.status, "recovery-required");
      assert.equal(command?.failureCategory, undefined);
    } finally {
      await reopenedChannel.close();
    }
  } finally {
    adapter.release();
    await (closeResult ?? channel.close()).catch(() => undefined);
  }
});

for (const outcome of ["completed", "interrupted", "failed"] as const) {
  test(`a validated ${outcome} turn survives close at iterator exhaustion`, async (t) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
    const projectDirectory = join(temporaryDirectory, "project");
    const databasePath = join(temporaryDirectory, "ledger.sqlite");
    await mkdir(projectDirectory);
    t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

    const terminalEvent: NormalizedRuntimeEvent = outcome === "completed"
      ? { kind: "turn-completed", status: "completed" }
      : outcome === "interrupted"
        ? { kind: "turn-interrupted", status: "interrupted" }
        : { kind: "failed", category: "turn-failed" };
    const events = [...completedEvents.slice(0, -1), terminalEvent];
    let closeResult: Promise<void> | undefined;
    let channel: ProjectChannel;
    let markClosing!: () => void;
    const closing = new Promise<void>((resolve) => { markClosing = resolve; });
    class ClosingAdapter extends CompletingAdapter {
      override async start(request: RuntimeStart): Promise<RuntimeBinding> {
        this.starts.push(structuredClone(request));
        return {
          profile: desiredProfile,
          opaqueSessionReference: testSessionReference,
          async send() {},
          async *events() {
            yield* events;
            // The runtime has returned its complete, valid turn. Close races
            // with the coordinator consuming done:true, while SQLite is open.
            closeResult = channel.close();
            markClosing();
          },
        };
      }
    }
    const adapter = new ClosingAdapter();
    channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
      projectDirectory,
    );
    const receipt = await channel.act(directCommand());
    await closing;
    await closeResult;

    const reopenedAdapter = new CompletingAdapter();
    const reopened = await createWorkbenchCoordinator({
      databasePath,
      adapter: reopenedAdapter,
    }).openProject(projectDirectory);
    try {
      const snapshot = await reopened.snapshot();
      const command = snapshot.commands.find(row => row.commandId === receipt.commandId);
      assert.ok(command?.session);
      assert.equal(command.status, outcome === "completed" ? "completed" : "failed",
        "validated terminal outcome must survive channel close");
      assert.deepEqual(command.session.events, events, "terminal transcript survives reopen");
      assert.equal(command.failureCategory,
        outcome === "completed" ? undefined : outcome === "interrupted" ? "interrupted" : "runtime-failed");
      assert.equal(command.session.resumable, outcome !== "failed");
      const replay = await collectUpdatesThrough(reopened.observe({ after: 0 }), snapshot.cursor);
      assert.equal(replay.filter(update => update.kind === "recovery-required").length, 0);
      assert.equal(replay.filter(update => update.kind === "runtime-event").length, events.length);
      assert.equal(replay.filter(update => update.kind === "completed" || update.kind === "failed").length, 1);
      assert.equal(reopenedAdapter.starts.length + reopenedAdapter.resumes.length, 0,
        "startup must not replay an already completed effect");
      if (outcome !== "failed") {
        const continued = await reopened.act({
          kind: "direct",
          commandKind: "continue",
          idempotencyKey: "after-terminal-close",
          runtime: "codex",
          profile: desiredProfile,
          input: "fixed coordinator input",
          targetSessionId: command.session.sessionId,
        });
        assert.equal((await waitForTerminalCommand(reopened, continued)).status, "completed");
        assert.equal(reopenedAdapter.starts.length, 0, "no replacement Session");
        assert.equal(reopenedAdapter.resumes.length, 1);
        assert.equal(reopenedAdapter.resumes[0]?.opaqueSessionReference, testSessionReference);
      }
    } finally {
      await reopened.close();
    }
  });
}

for (const tail of ["exhausted", "synchronous-close", "conflicting", "cancelled-terminal"] as const) {
  test(`close validates the runtime tail: ${tail}`, async (t) => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
    const projectDirectory = join(temporaryDirectory, "project");
    const databasePath = join(temporaryDirectory, "ledger.sqlite");
    await mkdir(projectDirectory);
    t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
    let reachTail!: () => void;
    const tailReached = new Promise<void>(resolve => { reachTail = resolve; });
    let releaseTail!: (result: IteratorResult<NormalizedRuntimeEvent>) => void;
    const pendingTail = new Promise<IteratorResult<NormalizedRuntimeEvent>>(resolve => {
      releaseTail = resolve;
    });
    let returnCalls = 0;
    let closeResult: Promise<void> | undefined;
    class TailAdapter extends CompletingAdapter {
      override async start(): Promise<RuntimeBinding> {
        let index = 0;
        const prefix = tail === "cancelled-terminal" ? completedEvents.slice(0, -1) : completedEvents;
        return {
          profile: desiredProfile,
          opaqueSessionReference: testSessionReference,
          async send() {},
          events(): AsyncIterableIterator<NormalizedRuntimeEvent> {
            return {
              [Symbol.asyncIterator]() { return this; },
              async next(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                if (index < prefix.length) return { done: false, value: prefix[index++]! };
                if (index++ === prefix.length) {
                  // Unlike a caller waiting on tailReached, this closes inside
                  // next(), before the coordinator checks its closed flag.
                  if (tail === "synchronous-close") closeResult = channel.close();
                  reachTail();
                  return pendingTail;
                }
                return { done: true, value: undefined };
              },
              async return(): Promise<IteratorResult<NormalizedRuntimeEvent>> {
                returnCalls += 1;
                releaseTail(tail === "cancelled-terminal"
                  ? { done: false, value: { kind: "turn-completed", status: "completed" } }
                  : { done: true, value: undefined });
                return { done: true, value: undefined };
              },
            };
          },
        };
      }
    }
    const channel = await createWorkbenchCoordinator({ databasePath, adapter: new TailAdapter() })
      .openProject(projectDirectory);
    const receipt = await channel.act(directCommand());
    await tailReached;
    const closed = closeResult ?? channel.close();
    try {
      assert.equal(returnCalls, tail === "cancelled-terminal" ? 1 : 0,
        "close must drain an observed terminal rather than cancel its validation tail");
    } finally {
      releaseTail(tail === "conflicting"
        ? { done: false, value: { kind: "agent-message", text: "conflicting tail" } }
        : { done: true, value: undefined });
      await closed;
    }
    const reopened = await createWorkbenchCoordinator({ databasePath, adapter: new CompletingAdapter() })
      .openProject(projectDirectory);
    try {
      const command = (await reopened.snapshot()).commands.find(row => row.commandId === receipt.commandId);
      const completed = tail === "exhausted" || tail === "synchronous-close";
      assert.equal(command?.status, completed ? "completed" : "recovery-required",
        "only an uncancelled, non-conflicting terminal stream certifies completion");
      // A turn whose terminal never certified still keeps what it streamed: runtime events
      // are persisted as they arrive, not only at commitTerminal, so the recorded prefix survives.
      // The certified terminal itself is the one event a non-certifying tail does not earn.
      assert.deepEqual(
        command?.session?.events,
        completed ? completedEvents : completedEvents.slice(0, -1),
      );
    } finally {
      await reopened.close();
    }
  });
}

test("close contains held inspect, start, and send calls at their lifecycle seams", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  for (const heldSeam of ["inspect", "start", "send"] as const) {
    const caseDirectory = join(temporaryDirectory, heldSeam);
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const adapter = new HeldLifecycleAdapter(heldSeam);
    const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
      projectDirectory,
    );
    const receipt = await channel.act(directCommand());
    await adapter.seamReached();
    const observer = channel
      .observe({ after: (await channel.snapshot()).cursor })
      [Symbol.asyncIterator]();
    const pendingObservation = observer.next();
    let closeSettled = false;
    const closeResult = channel.close().then(() => {
      closeSettled = true;
    });

    assert.deepEqual(await pendingObservation, { done: true, value: undefined });
    await Promise.resolve();
    assert.equal(closeSettled, false, heldSeam);
    const isClosedError = (error: unknown) =>
      error instanceof CoordinatorError && error.category === "channel-closed";
    await assert.rejects(channel.snapshot(), isClosedError);
    await assert.rejects(channel.act(directCommand()), isClosedError);

    adapter.release();
    await closeResult;
    const expectedTrace: Record<HeldLifecycleSeam, readonly string[]> = {
      inspect: ["inspect-enter", "inspect-exit"],
      start: [
        "inspect-enter",
        "inspect-exit",
        "start-enter",
        "start-exit",
        "events-return",
      ],
      send: [
        "inspect-enter",
        "inspect-exit",
        "start-enter",
        "start-exit",
        "send-enter",
        "send-exit",
        "events-return",
      ],
    };
    assert.deepEqual(adapter.trace, expectedTrace[heldSeam], heldSeam);

    const reopenedAdapter = new CompletingAdapter();
    const reopenedChannel = await createWorkbenchCoordinator({
      databasePath,
      adapter: reopenedAdapter,
    }).openProject(projectDirectory);
    try {
      const command =
        heldSeam === "send"
          ? (await reopenedChannel.snapshot()).commands[0]
          : await waitForTerminalCommand(reopenedChannel, receipt);
      assert.equal(command?.commandId, receipt.commandId, heldSeam);
      assert.equal(
        command?.status,
        heldSeam === "send" ? "recovery-required" : "completed",
        heldSeam,
      );
      assert.equal(
        reopenedAdapter.inspectCalls,
        heldSeam === "inspect" ? 1 : 0,
        heldSeam,
      );
      assert.equal(
        reopenedAdapter.starts.length,
        heldSeam === "inspect" ? 1 : 0,
        heldSeam,
      );
      assert.equal(
        reopenedAdapter.resumes.length,
        heldSeam === "inspect" ? 0 : 1,
        heldSeam,
      );
    } finally {
      await reopenedChannel.close();
    }
  }
});

test("a direct command is durable before Adapter inspection and completes with its resolved profile", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter(() => {
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const command = reader
        .prepare("SELECT status FROM commands")
        .get() as { status: string };
      const updates = reader
        .prepare("SELECT kind, status FROM updates ORDER BY cursor")
        .all()
        .map((row) => ({
          kind: String(row.kind),
          status: String(row.status),
        }));
      assert.equal(command.status, "in-flight");
      assert.deepEqual(updates, [
        { kind: "accepted", status: "accepted" },
        { kind: "in-flight", status: "in-flight" },
      ]);
    } finally {
      reader.close();
    }
  });
  const coordinator = createWorkbenchCoordinator({ databasePath, adapter });
  const channel = await coordinator.openProject(projectDirectory);

  const receipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, receipt);
  const snapshot = await channel.snapshot();

  assert.equal(receipt.status, "accepted");
  assert.deepEqual(adapter.starts, [
    { projectDirectory, profile: desiredProfile },
  ]);
  assert.equal(snapshot.commands.length, 1);
  assert.equal(snapshot.commands[0]?.commandId, receipt.commandId);
  assert.equal(snapshot.commands[0]?.status, "completed");
  assert.deepEqual(snapshot.commands[0]?.session?.profile, desiredProfile);
  assert.deepEqual(snapshot.commands[0]?.session?.events, completedEvents);

  await channel.close();
});

test("a semantically identical idempotent retry returns the original receipt without work or updates", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const firstReceipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, firstReceipt);
  const cursorAfterFirstAct = (await channel.snapshot()).cursor;
  const reorderedSameCommand: DirectProjectCommand = {
    input: "fixed coordinator input",
    profile: desiredProfile,
    preferences: {
      global: {
        accessMode: "full-access",
        executionMode: "single-agent",
        effortLevel: "ultra",
        model: "gpt-5.6-sol",
      },
    },
    catalogRevision: "catalog-revision-09",
    runtime: "codex",
    idempotencyKey: "command-key-1",
    commandKind: "start",
    kind: "direct",
  };

  const retryReceipt = await channel.act(reorderedSameCommand);

  assert.deepEqual(retryReceipt, firstReceipt);
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.starts.length, 1);
  const retriedSnapshot = await channel.snapshot();
  assert.equal(retriedSnapshot.cursor, cursorAfterFirstAct);
  assert.equal(retriedSnapshot.commands.length, 1);
  assert.equal(retriedSnapshot.commands[0]?.input, reorderedSameCommand.input);
  await channel.close();
});

test("a conflicting idempotency payload fails with a fixed category and no attempted value or path", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "private-project-sentinel");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const originalReceipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, originalReceipt);
  const cursorBeforeConflict = (await channel.snapshot()).cursor;
  const attemptedValue = "private-conflicting-input-sentinel";

  await assert.rejects(
    channel.act(directCommand({ input: attemptedValue })),
    (error) => {
      if (!(error instanceof CoordinatorError)) return false;
      const publicShape = `${error.category}\n${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
      return (
        error.category === "idempotency-conflict" &&
        !publicShape.includes(attemptedValue) &&
        !publicShape.includes(projectDirectory)
      );
    },
  );
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.starts.length, 1);
  const afterConflict = await channel.snapshot();
  assert.equal(afterConflict.cursor, cursorBeforeConflict);
  assert.equal(afterConflict.commands.length, 1);
  assert.equal(afterConflict.commands[0]?.input, "fixed coordinator input");
  assert.equal(JSON.stringify(afterConflict).includes(attemptedValue), false);
  await channel.close();
});

test("captured consumers can close after one snapshot or a gap-free replay tail", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const receipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, receipt);
  const snapshot = await channel.snapshot();

  const currentObservation = await collectUpdatesThrough(
    channel.observe(),
    snapshot.cursor,
  );
  assert.deepEqual(currentObservation, [
    {
      cursor: snapshot.cursor,
      commandId: null,
      kind: "snapshot",
      status: "snapshot",
      snapshot,
    },
  ]);

  const replay = await collectUpdatesThrough(
    channel.observe({ after: receipt.acceptedCursor }),
    snapshot.cursor,
  );
  assert.deepEqual(
    replay.map((update) => update.kind),
    [
      "in-flight",
      "profile-resolved",
      "interrupt-capability",
      ...completedEvents.map(() => "runtime-event"),
      "completed",
    ],
  );
  assert.deepEqual(
    replay.map((update) => update.cursor),
    Array.from(
      { length: snapshot.cursor - receipt.acceptedCursor },
      (_, index) => receipt.acceptedCursor + index + 1,
    ),
  );
  assert.equal(new Set(replay.map((update) => update.cursor)).size, replay.length);
  assert.deepEqual(
    replay
      .filter((update) => update.kind === "runtime-event")
      .map((update) => update.event),
    completedEvents,
  );

  await assert.rejects(
    async () =>
      collectUpdatesThrough(
        channel.observe({ after: snapshot.cursor + 1 }),
        snapshot.cursor + 1,
      ),
    (error) =>
      error instanceof CoordinatorError && error.category === "invalid-cursor",
  );
  for (const invalidCursor of [-1, 0.5, Number.NaN]) {
    await assert.rejects(
      async () =>
        collectUpdatesThrough(
          channel.observe({ after: invalidCursor }),
          snapshot.cursor,
        ),
      (error) =>
        error instanceof CoordinatorError && error.category === "invalid-cursor",
    );
  }
  await channel.close();
});

test("observation without a cursor continues from its snapshot into later durable commits", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new DeferredInspectAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const iterator = channel.observe()[Symbol.asyncIterator]();
  let pendingAct: Promise<CommandReceipt> | undefined;

  try {
    const initial = await iterator.next();
    assert.equal(initial.done, false);
    assert.equal(initial.value?.kind, "snapshot");
    assert.equal(initial.value?.cursor, 0);

    const waitingForAccepted = iterator.next();
    pendingAct = channel.act(directCommand());
    await adapter.inspectionStarted();

    const accepted = await waitingForAccepted;
    const inFlight = await iterator.next();
    assert.equal(accepted.done, false);
    assert.equal(inFlight.done, false);
    assert.deepEqual(
      [accepted.value, inFlight.value].map((update) => [update?.cursor, update?.kind]),
      [
        [1, "accepted"],
        [2, "in-flight"],
      ],
    );
  } finally {
    adapter.release();
    await pendingAct?.catch(() => undefined);
    await iterator.return?.();
    await channel.close();
  }
});

test("cursor observation catches up and then wakes for later commits without a gap", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const firstReceipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, firstReceipt);
  const firstTail = (await channel.snapshot()).cursor;
  const options = Object.freeze({ after: firstReceipt.acceptedCursor });
  const iterator = channel.observe(options)[Symbol.asyncIterator]();

  try {
    const catchUp = await takeUpdatesThrough(iterator, firstTail);
    const waitingForLiveCommit = iterator.next();

    const secondAct = channel.act(
      directCommand({ idempotencyKey: "command-key-live" }),
    );
    const firstLive = await waitingForLiveCommit;
    assert.equal(firstLive.done, false);
    assert.equal(firstLive.value?.kind, "accepted");
    assert.equal(firstLive.value?.cursor, firstTail + 1);

    const secondReceipt = await secondAct;
    await waitForTerminalCommand(channel, secondReceipt);
    const finalTail = (await channel.snapshot()).cursor;
    const remainingLive = await takeUpdatesThrough(iterator, finalTail);
    const observed = [
      ...catchUp,
      firstLive.value as ProjectUpdate,
      ...remainingLive,
    ];

    assert.deepEqual(
      observed.map((update) => update.cursor),
      Array.from(
        { length: finalTail - firstReceipt.acceptedCursor },
        (_, index) => firstReceipt.acceptedCursor + index + 1,
      ),
    );
    assert.equal(new Set(observed.map((update) => update.cursor)).size, observed.length);
    assert.equal(adapter.inspectCalls, 2);
    assert.deepEqual(options, { after: firstReceipt.acceptedCursor });
  } finally {
    await iterator.return?.();
    await channel.close();
  }
});

test("two cursor observers remain independent while a delayed consumer catches up durably", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const firstReceipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, firstReceipt);
  const firstTail = (await channel.snapshot()).cursor;
  const slowIterator = channel.observe({ after: 0 })[Symbol.asyncIterator]();
  const laterIterator = channel
    .observe({ after: firstReceipt.acceptedCursor })
    [Symbol.asyncIterator]();

  try {
    const slowFirst = await slowIterator.next();
    assert.equal(slowFirst.done, false);
    assert.equal(slowFirst.value?.cursor, 1);
    const laterCatchUp = await takeUpdatesThrough(laterIterator, firstTail);

    const laterReceipts = await Promise.all([
      channel.act(directCommand({ idempotencyKey: "command-key-2" })),
      channel.act(directCommand({ idempotencyKey: "command-key-3" })),
    ]);
    await Promise.all(
      laterReceipts.map((receipt) => waitForTerminalCommand(channel, receipt)),
    );
    const finalTail = (await channel.snapshot()).cursor;
    const slowCatchUp = await takeUpdatesThrough(slowIterator, finalTail);
    const laterLive = await takeUpdatesThrough(laterIterator, finalTail);
    const slowObserved = [slowFirst.value as ProjectUpdate, ...slowCatchUp];
    const laterObserved = [...laterCatchUp, ...laterLive];

    assert.deepEqual(
      slowObserved.map((update) => update.cursor),
      Array.from({ length: finalTail }, (_, index) => index + 1),
    );
    assert.deepEqual(
      laterObserved.map((update) => update.cursor),
      Array.from(
        { length: finalTail - firstReceipt.acceptedCursor },
        (_, index) => firstReceipt.acceptedCursor + index + 1,
      ),
    );
    assert.equal(adapter.inspectCalls, 3);
  } finally {
    await slowIterator.return?.();
    await laterIterator.return?.();
    await channel.close();
  }
});

test("iterator return and channel close promptly complete pending observers", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);

  const cancelled = channel.observe({ after: 0 })[Symbol.asyncIterator]();
  const pendingCancelledNext = cancelled.next();
  assert.deepEqual(await cancelled.return?.(), { done: true, value: undefined });
  assert.deepEqual(await pendingCancelledNext, { done: true, value: undefined });

  const firstClosed = channel.observe({ after: 0 })[Symbol.asyncIterator]();
  const secondClosed = channel.observe({ after: 0 })[Symbol.asyncIterator]();
  const dormantBeforeClose = channel
    .observe({ after: 0 })
    [Symbol.asyncIterator]();
  const pendingFirstClose = firstClosed.next();
  const pendingSecondClose = secondClosed.next();

  await channel.close();
  assert.deepEqual(await pendingFirstClose, { done: true, value: undefined });
  assert.deepEqual(await pendingSecondClose, { done: true, value: undefined });
  assert.deepEqual(await firstClosed.next(), { done: true, value: undefined });
  assert.deepEqual(await secondClosed.next(), { done: true, value: undefined });
  assert.deepEqual(await dormantBeforeClose.next(), {
    done: true,
    value: undefined,
  });
  await channel.close();

  const isClosedError = (error: unknown) =>
    error instanceof CoordinatorError && error.category === "channel-closed";
  await assert.rejects(channel.snapshot(), isClosedError);
  await assert.rejects(channel.act(directCommand()), isClosedError);
  await assert.rejects(async () => {
    const postClose = channel.observe({ after: 0 })[Symbol.asyncIterator]();
    await postClose.next();
  }, isClosedError);
});

test("restart observation replays the prior cursor before following new work without redispatch", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const initialChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const initialReceipt = await initialChannel.act(directCommand());
  await waitForTerminalCommand(initialChannel, initialReceipt);
  const priorTail = (await initialChannel.snapshot()).cursor;
  await initialChannel.close();

  const reopenedAdapter = new CompletingAdapter();
  const reopenedChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: reopenedAdapter,
  }).openProject(projectDirectory);
  const iterator = reopenedChannel
    .observe({ after: initialReceipt.acceptedCursor })
    [Symbol.asyncIterator]();

  try {
    const persisted = await takeUpdatesThrough(iterator, priorTail);
    assert.equal(reopenedAdapter.inspectCalls, 0);
    assert.deepEqual(await reopenedChannel.act(directCommand()), initialReceipt);
    assert.equal(reopenedAdapter.inspectCalls, 0);

    const waitingForLiveCommit = iterator.next();
    const newAct = reopenedChannel.act(
      directCommand({ idempotencyKey: "command-key-after-restart" }),
    );
    const firstLive = await waitingForLiveCommit;
    assert.equal(firstLive.done, false);
    const newReceipt = await newAct;
    await waitForTerminalCommand(reopenedChannel, newReceipt);
    const finalTail = (await reopenedChannel.snapshot()).cursor;
    const later = await takeUpdatesThrough(iterator, finalTail);
    const observed = [persisted, [firstLive.value as ProjectUpdate, ...later]].flat();

    assert.deepEqual(
      observed.map((update) => update.cursor),
      Array.from(
        { length: finalTail - initialReceipt.acceptedCursor },
        (_, index) => initialReceipt.acceptedCursor + index + 1,
      ),
    );
    assert.equal(reopenedAdapter.inspectCalls, 1);
    assert.equal(reopenedAdapter.starts.length, 1);
  } finally {
    await iterator.return?.();
    await reopenedChannel.close();
  }
});

test("a resolver rejection becomes one durable sanitized profile failure", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const attemptedModel = "private-model-sentinel";
  const receipt = await channel.act(
    directCommand({
      preferences: {
        global: { ...desiredProfile, model: attemptedModel },
      },
    }),
  );
  await waitForTerminalCommand(channel, receipt);

  const snapshot = await channel.snapshot();
  assert.equal(snapshot.commands[0]?.commandId, receipt.commandId);
  assert.deepEqual(snapshot.commands[0], {
    commandId: receipt.commandId,
    runtime: "codex",
    status: "failed",
    failureCategory: "profile-resolution-failed",
    input: "fixed coordinator input",
    session: {
      sessionId: snapshot.commands[0]?.session?.sessionId,
      displayName: "fixed coordinator input",
      archived: false,
      profile: desiredProfile,
      acceptedCommandCursor: receipt.acceptedCursor,
      resumable: false,
      events: [],
    },
  });
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.starts.length, 0);
  assert.equal(JSON.stringify(snapshot).includes(attemptedModel), false);
  const replay = await collectUpdatesThrough(
    channel.observe({ after: 0 }),
    snapshot.cursor,
  );
  assert.deepEqual(replay.at(-1), {
    cursor: snapshot.cursor,
    commandId: receipt.commandId,
    kind: "failed",
    status: "failed",
    failureCategory: "profile-resolution-failed",
  });
  await channel.close();
});

test("an Adapter rejection after an effect claim becomes a sanitized recovery barrier", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "private-project-sentinel");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const nativeBody = "NATIVE_PRIVATE_BODY_SENTINEL";
  const adapter = new StartFailingAdapter(nativeBody);
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const exactRecoveryInput = "  recovery input\n原样保留  ";
  const receipt = await channel.act(directCommand({ input: exactRecoveryInput }));
  await waitForTerminalCommand(channel, receipt);

  const snapshot = await channel.snapshot();
  assert.equal(snapshot.commands[0]?.commandId, receipt.commandId);
  assert.equal(snapshot.commands[0]?.status, "recovery-required");
  assert.equal(snapshot.commands[0]?.failureCategory, undefined);
  assert.equal(snapshot.commands[0]?.input, exactRecoveryInput);
  assert.equal(snapshot.commands.length, 1);
  assert.deepEqual(snapshot.commands[0]?.session?.profile, desiredProfile);
  assert.deepEqual(snapshot.commands[0]?.session?.events, []);
  const durablePublicShape = JSON.stringify({
    snapshot,
    replay: await collectUpdatesThrough(
      channel.observe({ after: 0 }),
      snapshot.cursor,
    ),
  });
  assert.equal(durablePublicShape.includes(nativeBody), false);
  assert.equal(durablePublicShape.includes(projectDirectory), false);
  await channel.close();
});

test("reopening dispatches accepted unclaimed work exactly once", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const originalAdapter = new CompletingAdapter();
  const originalChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: originalAdapter,
  }).openProject(projectDirectory);
  const receipt = await originalChannel.act(directCommand());
  await originalChannel.close();
  assert.equal(originalAdapter.inspectCalls, 0);
  assert.equal(originalAdapter.starts.length, 0);

  const reopenedAdapter = new CompletingAdapter();
  const reopenedChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: reopenedAdapter,
  }).openProject(projectDirectory);
  try {
    const command = await waitForTerminalCommand(reopenedChannel, receipt);
    assert.equal(command.commandId, receipt.commandId);
    assert.equal(command.status, "completed");
    assert.equal(command.input, "fixed coordinator input");
    assert.deepEqual(await reopenedChannel.act(directCommand()), receipt);
    assert.equal(reopenedAdapter.inspectCalls, 1);
    assert.equal(reopenedAdapter.starts.length, 1);
    assert.equal(reopenedAdapter.resumes.length, 0);
  } finally {
    await reopenedChannel.close();
  }
});

test("reopening retries an in-flight command whose external effects were never claimed", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const interruptedAdapter = new DeferredInspectAdapter();
  const originalChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: interruptedAdapter,
  }).openProject(projectDirectory);
  const pendingAct = originalChannel.act(directCommand());
  await interruptedAdapter.inspectionStarted();
  const originalReceipt = await pendingAct;
  const closeResult = originalChannel.close();
  interruptedAdapter.release();
  await closeResult;
  assert.equal(interruptedAdapter.starts.length, 0);

  const reopenedAdapter = new CompletingAdapter();
  const reopenedChannel = await createWorkbenchCoordinator({
    databasePath,
    adapter: reopenedAdapter,
  }).openProject(projectDirectory);
  try {
    const command = await waitForTerminalCommand(reopenedChannel, originalReceipt);
    assert.equal(command.status, "completed");
    assert.equal(command.input, "fixed coordinator input");
    assert.deepEqual(await reopenedChannel.act(directCommand()), originalReceipt);
    assert.equal(reopenedAdapter.inspectCalls, 1);
    assert.equal(reopenedAdapter.starts.length, 1);
    assert.equal(reopenedAdapter.resumes.length, 0);
  } finally {
    await reopenedChannel.close();
  }
});

test("completed and failed snapshots plus cursor replay survive close and reopen unchanged", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  for (const terminal of ["completed", "failed"] as const) {
    const caseDirectory = join(temporaryDirectory, terminal);
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const initialAdapter =
      terminal === "completed"
        ? new CompletingAdapter()
        : new ReferenceAdapter(structuredClone(catalog), [
            { kind: "session-started" },
            { kind: "failed", category: "turn-failed" },
          ]);
    const initialChannel = await createWorkbenchCoordinator({
      databasePath,
      adapter: initialAdapter,
    }).openProject(projectDirectory);
    const initialReceipt = await initialChannel.act(directCommand());
    await waitForTerminalCommand(initialChannel, initialReceipt);
    const snapshotBeforeClose = await initialChannel.snapshot();
    const replayBeforeClose = await collectUpdatesThrough(
      initialChannel.observe({ after: 0 }),
      snapshotBeforeClose.cursor,
    );
    assert.equal(snapshotBeforeClose.commands[0]?.status, terminal);
    assert.equal(snapshotBeforeClose.commands[0]?.input, "fixed coordinator input");
    await initialChannel.close();

    const reopenAdapter = new CompletingAdapter();
    const reopenedChannel = await createWorkbenchCoordinator({
      databasePath,
      adapter: reopenAdapter,
    }).openProject(projectDirectory);
    const reopenedSnapshot = await reopenedChannel.snapshot();
    assert.deepEqual(reopenedSnapshot, snapshotBeforeClose);
    assert.equal(reopenedSnapshot.commands[0]?.input, "fixed coordinator input");
    assert.deepEqual(
      await collectUpdatesThrough(
        reopenedChannel.observe({ after: 0 }),
        snapshotBeforeClose.cursor,
      ),
      replayBeforeClose,
    );
    assert.deepEqual(await reopenedChannel.act(directCommand()), initialReceipt);
    assert.equal((await reopenedChannel.snapshot()).cursor, snapshotBeforeClose.cursor);
    assert.equal(reopenAdapter.inspectCalls, 0);
    assert.equal(reopenAdapter.starts.length, 0);
    await reopenedChannel.close();
  }
});

test("one ProjectChannel serializes direct commands through the external Adapter seam", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  const adapter = new DeferredInspectAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const firstAct = channel.act(directCommand());
  await adapter.inspectionStarted();
  const secondAct = channel.act(
    directCommand({ idempotencyKey: "command-key-2" }),
  );

  assert.equal(adapter.inspectCalls, 1);
  adapter.release();
  const receipts = await Promise.all([firstAct, secondAct]);
  await Promise.all(
    receipts.map((receipt) => waitForTerminalCommand(channel, receipt)),
  );
  assert.equal(adapter.inspectCalls, 2);
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.sendCalls, 2);
  assert.equal(adapter.eventStreamCalls, 2);
  assert.deepEqual(
    (await channel.snapshot()).commands.map((command) => command.status),
    ["completed", "completed"],
  );
  await channel.close();
});

test("normalized terminal failure events remain durable and finish the command as failed", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const failedEvents: NormalizedRuntimeEvent[] = [
    { kind: "session-started" },
    { kind: "failed", category: "turn-failed" },
  ];
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new ReferenceAdapter(structuredClone(catalog), failedEvents),
  }).openProject(projectDirectory);

  const exactFailureInput = "  failed turn input\n第二行  ";
  const receipt = await channel.act(directCommand({ input: exactFailureInput }));
  await waitForTerminalCommand(channel, receipt);
  const command = (await channel.snapshot()).commands[0];

  assert.equal(command?.status, "failed");
  assert.equal(command?.failureCategory, "runtime-failed");
  assert.equal(command?.input, exactFailureInput);
  assert.deepEqual(command?.session?.events, failedEvents);
  await channel.close();
});

test("completed-turn context and suggestions survive cloning, SQLite replay, and reopen", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-context-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const contextualEvents: NormalizedRuntimeEvent[] = [
    ...completedEvents.slice(0, -1),
    {
      kind: "turn-completed",
      status: "completed",
      context: {
        basis: "active-context",
        usedTokens: 144,
        windowTokens: 258_400,
      },
      suggestions: ["Check the remaining tests", "Explain the trade-off"],
    },
  ];
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new ReferenceAdapter(structuredClone(catalog), contextualEvents),
  }).openProject(projectDirectory);

  const receipt = await channel.act(directCommand());
  const terminal = await waitForTerminalCommand(channel, receipt);
  assert.equal(terminal.status, "completed");
  assert.deepEqual(terminal.session?.events, contextualEvents, "live snapshot clone");
  const snapshot = await channel.snapshot();
  const replay = await collectUpdatesThrough(channel.observe({ after: 0 }), snapshot.cursor);
  const completedUpdate = replay.find(
    (update) =>
      update.kind === "runtime-event" && update.event.kind === "turn-completed",
  );
  assert.deepEqual(
    completedUpdate?.kind === "runtime-event" ? completedUpdate.event : undefined,
    contextualEvents.at(-1),
    "durable update replay",
  );
  await channel.close();

  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  assert.deepEqual(
    (await reopened.snapshot()).commands[0]?.session?.events,
    contextualEvents,
    "reopened snapshot",
  );
  await reopened.close();
});

test("legacy cumulative context stays durable but is suppressed on replay and replaced by new versioned context", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-legacy-context-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const currentEvents: NormalizedRuntimeEvent[] = [
    ...completedEvents.slice(0, -1),
    {
      kind: "turn-completed",
      status: "completed",
      context: {
        basis: "active-context",
        usedTokens: 144,
        windowTokens: 258_400,
      },
    },
  ];
  const first = await createWorkbenchCoordinator({
    databasePath,
    adapter: new ReferenceAdapter(structuredClone(catalog), currentEvents),
  }).openProject(projectDirectory);
  const firstReceipt = await first.act(directCommand());
  await waitForTerminalCommand(first, firstReceipt);
  await first.close();

  const writer = new DatabaseSync(databasePath);
  const runtimeRows = writer
    .prepare(
      "SELECT cursor, data_json FROM updates WHERE kind = 'runtime-event' ORDER BY cursor",
    )
    .all() as unknown as Array<{ cursor: number; data_json: string }>;
  const terminalRow = runtimeRows.find((row) => {
    const value = JSON.parse(row.data_json) as { event?: { kind?: string } };
    return value.event?.kind === "turn-completed";
  });
  assert.ok(terminalRow);
  const legacyData = JSON.stringify({
    event: {
      kind: "turn-completed",
      status: "completed",
      context: { usedTokens: 142_239, windowTokens: 258_400 },
    },
  });
  writer
    .prepare("UPDATE updates SET data_json = ? WHERE cursor = ?")
    .run(legacyData, terminalRow.cursor);
  writer.close();

  const nextEvents: NormalizedRuntimeEvent[] = [
    ...completedEvents.slice(0, -1),
    {
      kind: "turn-completed",
      status: "completed",
      context: {
        basis: "active-context",
        usedTokens: 200,
        windowTokens: 258_400,
      },
    },
  ];
  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new ReferenceAdapter(structuredClone(catalog), nextEvents),
  }).openProject(projectDirectory);
  const legacyCommand = (await reopened.snapshot()).commands[0];
  assert.equal(
    legacyCommand?.session?.events.some(
      (event) => event.kind === "agent-message" && event.text === "FIXED_COORDINATOR_MARKER",
    ),
    true,
    "the historical transcript remains readable",
  );
  assert.deepEqual(legacyCommand?.session?.events.at(-1), {
    kind: "turn-completed",
    status: "completed",
  });
  const replay = await collectUpdatesThrough(
    reopened.observe({ after: 0 }),
    (await reopened.snapshot()).cursor,
  );
  const legacyTerminalReplay = replay.find(
    (update) =>
      update.commandId === firstReceipt.commandId &&
      update.kind === "runtime-event" &&
      update.event.kind === "turn-completed",
  );
  assert.deepEqual(
    legacyTerminalReplay?.kind === "runtime-event"
      ? legacyTerminalReplay.event
      : undefined,
    { kind: "turn-completed", status: "completed" },
  );

  const secondReceipt = await reopened.act(
    directCommand({ idempotencyKey: "new-versioned-context" }),
  );
  const secondTerminal = await waitForTerminalCommand(reopened, secondReceipt);
  assert.deepEqual(secondTerminal.session?.events.at(-1), nextEvents.at(-1));
  await reopened.close();

  const reader = new DatabaseSync(databasePath, { readOnly: true });
  const unchanged = reader
    .prepare("SELECT data_json FROM updates WHERE cursor = ?")
    .get(terminalRow.cursor) as unknown as { data_json: string };
  assert.equal(unchanged.data_json, legacyData, "compatibility hydration does not rewrite history");
  reader.close();
});

test("the durable seam rejects every adversarial context row before persistence", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-context-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const activeContext = () => ({
    basis: "active-context" as const,
    usedTokens: 144,
    windowTokens: 258_400,
  });
  const adversarial = [
    {
      name: "negative count",
      context: {
        basis: "active-context",
        usedTokens: -1,
        windowTokens: 258_400,
      },
    },
    {
      name: "non-integer count",
      context: {
        basis: "active-context",
        usedTokens: 1.5,
        windowTokens: 258_400,
      },
    },
    {
      name: "window smaller than used",
      context: {
        basis: "active-context",
        usedTokens: 144,
        windowTokens: 143,
      },
    },
    {
      name: "window present but not a number",
      context: {
        basis: "active-context",
        usedTokens: 144,
        windowTokens: "258400",
      },
    },
    {
      name: "missing semantic basis",
      context: { usedTokens: 144, windowTokens: 258_400 },
    },
    {
      name: "unknown semantic basis",
      context: {
        basis: "session-total",
        usedTokens: 144,
        windowTokens: 258_400,
      },
    },
    {
      name: "active context without a window",
      context: {
        basis: "active-context",
        usedTokens: 144,
        windowTokens: null,
      },
    },
    {
      name: "turn usage forged with an active window",
      context: {
        basis: "turn-usage",
        usedTokens: 144,
        windowTokens: 258_400,
      },
    },
    {
      name: "non-enumerable context extra",
      context: (() => {
        const context = activeContext();
        Object.defineProperty(context, "nativeExtra", { value: true });
        return context;
      })(),
    },
    {
      name: "symbol context extra",
      context: {
        ...activeContext(),
        [Symbol("native-extra")]: true,
      },
    },
    {
      name: "inherited context extra",
      context: Object.assign(
        Object.create({ nativeExtra: true }) as Record<string, unknown>,
        activeContext(),
      ),
    },
    {
      name: "accessor context field",
      context: (() => {
        const context = {
          basis: "active-context" as const,
          usedTokens: 144,
        } as Record<string, unknown>;
        Object.defineProperty(context, "windowTokens", {
          enumerable: true,
          get: () => 258_400,
        });
        return context;
      })(),
    },
    {
      name: "proxied context",
      context: new Proxy(activeContext(), {}),
    },
  ];

  for (const [index, row] of adversarial.entries()) {
    const caseDirectory = join(temporaryDirectory, String(index));
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const sourceEvents = [
      ...completedEvents.slice(0, -1),
      {
        kind: "turn-completed",
        status: "completed",
        context: row.context,
      } as never,
    ];
    const channel = await createWorkbenchCoordinator({
      databasePath,
      adapter: new ReferenceAdapter(structuredClone(catalog), sourceEvents),
    }).openProject(projectDirectory);
    const receipt = await channel.act(
      directCommand({ idempotencyKey: `invalid-context-${index}` }),
    );
    const terminal = await waitForTerminalCommand(channel, receipt);
    assert.equal(terminal.status, "recovery-required", row.name);
    assert.deepEqual(terminal.session?.events, completedEvents.slice(0, -1),
      `${row.name}: valid live output remains durable; the malformed terminal context does not`);
    await channel.close();
  }
});

test("repeated, conflicting, or non-final terminal events require recovery", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const malformedStreams: readonly (readonly NormalizedRuntimeEvent[])[] = [
    [
      { kind: "failed", category: "turn-failed" },
      { kind: "turn-completed", status: "completed" },
    ],
    [
      { kind: "turn-completed", status: "completed" },
      { kind: "failed", category: "turn-failed" },
    ],
    [
      { kind: "turn-completed", status: "completed" },
      { kind: "turn-completed", status: "completed" },
    ],
    [
      { kind: "turn-completed", status: "completed" },
      { kind: "agent-message", text: "post-terminal" },
    ],
  ];

  for (const [index, events] of malformedStreams.entries()) {
    const caseDirectory = join(temporaryDirectory, String(index));
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const channel = await createWorkbenchCoordinator({
      databasePath,
      adapter: new ReferenceAdapter(structuredClone(catalog), [...events]),
    }).openProject(projectDirectory);
    const receipt = await channel.act(
      directCommand({ idempotencyKey: `malformed-terminal-${index}` }),
    );
    const command = await waitForTerminalCommand(channel, receipt);

    assert.equal(command.status, "recovery-required", String(index));
    assert.equal(command.failureCategory, undefined, String(index));
    assert.deepEqual(command.session?.events, [], String(index));
    await channel.close();
  }
});

test("coordination leaves caller command, preference, catalog, override, and event inputs unchanged", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const sourceCatalog = structuredClone(catalog);
  const sourceEvents = structuredClone(completedEvents) as NormalizedRuntimeEvent[];
  const command = directCommand({
    preferences: {
      global: { ...desiredProfile },
      runtime: { effortLevel: "ultra" },
      models: {
        "gpt-5.6-sol": {
          executionMode: "single-agent",
          accessMode: "full-access",
        },
      },
    },
    overrides: { model: "gpt-5.6-sol" },
  });
  const commandBefore = structuredClone(command);
  const catalogBefore = structuredClone(sourceCatalog);
  const eventsBefore = structuredClone(sourceEvents);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new ReferenceAdapter(sourceCatalog, sourceEvents),
  }).openProject(projectDirectory);

  const receipt = await channel.act(command);
  await waitForTerminalCommand(channel, receipt);

  assert.deepEqual(command, commandBefore);
  assert.deepEqual(sourceCatalog, catalogBefore);
  assert.deepEqual(sourceEvents, eventsBefore);
  await channel.close();
});

test("empty command keys, revisions, and text inputs reject before any durable or Adapter work", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "project-channel-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  t.after(async () => {
    await channel.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  for (const invalidCommand of [
    directCommand({ idempotencyKey: "  " }),
    directCommand({ catalogRevision: "  " }),
    directCommand({ input: "  " }),
  ]) {
    const result = channel.act(invalidCommand);
    await assert.rejects(
      result,
      (error) =>
        error instanceof CoordinatorError && error.category === "invalid-command",
    );
  }
  assert.equal(adapter.inspectCalls, 0);
  assert.equal((await channel.snapshot()).cursor, 0);
});

test("runtime resume identity is exact, bounded, and acceptance-endpoint-bound", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "resume-identity-shape-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  t.after(async () => {
    await channel.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const validIdentity = {
    schemaVersion: 1 as const,
    endpointId: "codex-desktop" as const,
    nativeProfile: desiredProfile,
  };
  const invalidIdentities: readonly unknown[] = [
    { ...validIdentity, schemaVersion: 2 },
    { ...validIdentity, endpointId: "unknown-endpoint" },
    { ...validIdentity, extra: true },
    {
      ...validIdentity,
      nativeProfile: { ...desiredProfile, model: "x".repeat(1_025) },
    },
    {
      ...validIdentity,
      nativeProfile: { ...desiredProfile, accessMode: "restricted" },
    },
    {
      ...validIdentity,
      nativeProfile: { ...desiredProfile, extra: true },
    },
  ];
  for (const [index, runtimeResumeIdentity] of invalidIdentities.entries()) {
    await assert.rejects(
      channel.act(
        directCommand({
          idempotencyKey: `invalid-resume-identity-${index}`,
          runtimeResumeIdentity: runtimeResumeIdentity as never,
        }),
        { endpointId: "codex-desktop" },
      ),
      (error) =>
        error instanceof CoordinatorError && error.category === "invalid-command",
      String(index),
    );
  }
  await assert.rejects(
    channel.act(
      directCommand({
        idempotencyKey: "resume-identity-missing-context",
        runtimeResumeIdentity: validIdentity,
      }),
    ),
    (error) =>
      error instanceof CoordinatorError && error.category === "invalid-command",
  );
  await assert.rejects(
    channel.act(
      directCommand({
        idempotencyKey: "resume-identity-endpoint-mismatch",
        runtimeResumeIdentity: validIdentity,
      }),
      { endpointId: "claude-code-desktop" },
    ),
    (error) =>
      error instanceof CoordinatorError && error.category === "invalid-command",
  );
  assert.equal(adapter.inspectCalls, 0);
  assert.equal((await channel.snapshot()).cursor, 0);
});

test("runtime resume identity mappings are cursor-deduped, frozen, and conflict-closed", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "resume-identity-read-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  t.after(async () => {
    await channel.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const runtimeResumeIdentity = {
    schemaVersion: 1 as const,
    endpointId: "codex-desktop" as const,
    nativeProfile: desiredProfile,
  };
  const startReceipt = await channel.act(
    directCommand({ runtimeResumeIdentity }),
    { endpointId: "codex-desktop" },
  );
  const started = await waitForTerminalCommand(channel, startReceipt);
  const sessionId = started.session?.sessionId;
  assert.ok(sessionId !== undefined);
  assert.equal(typeof channel.readSessionRuntimeResumeIdentities, "function");

  const first = await channel.readSessionRuntimeResumeIdentities!(sessionId);
  assert.deepEqual(first, [
    {
      endpointId: "codex-desktop",
      selectionProfile: desiredProfile,
      nativeProfile: desiredProfile,
    },
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.equal(Object.isFrozen(first[0]?.selectionProfile), true);
  assert.equal(Object.isFrozen(first[0]?.nativeProfile), true);

  const continueCommand = (
    idempotencyKey: string,
    nativeProfile: SessionProfile,
  ): DirectProjectCommand => ({
    kind: "direct",
    commandKind: "continue",
    idempotencyKey,
    runtime: "codex",
    targetSessionId: sessionId,
    profile: desiredProfile,
    runtimeResumeIdentity: {
      schemaVersion: 1,
      endpointId: "codex-desktop",
      nativeProfile,
    },
    input: "fixed coordinator input",
  });
  const duplicateReceipt = await channel.act(
    continueCommand("duplicate-resume-identity", desiredProfile),
    { endpointId: "codex-desktop" },
  );
  await waitForTerminalCommand(channel, duplicateReceipt);
  assert.deepEqual(
    await channel.readSessionRuntimeResumeIdentities!(sessionId),
    first,
    "same mapping is retained once at its first cursor",
  );

  const conflictingReceipt = await channel.act(
    continueCommand("conflicting-resume-identity", {
      ...desiredProfile,
      model: "different-native-model",
    }),
    { endpointId: "codex-desktop" },
  );
  await waitForTerminalCommand(channel, conflictingReceipt);
  await assert.rejects(
    channel.readSessionRuntimeResumeIdentities!(sessionId),
    (error) =>
      error instanceof CoordinatorError && error.category === "storage-failed",
  );
});

test("requested display projection and post-turn match, difference, and unknown observations survive restart", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "profile-projection-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const cases = [
    {
      name: "matches",
      observed: desiredProfile,
      expectedStatus: "completed",
      expectedFailureCategory: undefined,
      expected: {
        kind: "observed",
        provenance: "post-turn-observation",
        model: { label: "Solution 5.6", comparison: "matches-requested" },
        workIntensity: { label: "Maximum", comparison: "matches-requested" },
        accessMode: { label: "Full access", comparison: "matches-requested" },
      },
    },
    {
      name: "differs",
      observed: {
        model: "PRIVATE_ALTERNATE_MODEL",
        effortLevel: "PRIVATE_ALTERNATE_EFFORT",
        executionMode: "single-agent",
        accessMode: "restricted",
      },
      expectedStatus: "failed",
      expectedFailureCategory: "runtime-failed",
      expected: {
        kind: "observed",
        provenance: "post-turn-observation",
        model: {
          label: "Observed different value",
          comparison: "differs-from-requested",
        },
        workIntensity: {
          label: "Observed different value",
          comparison: "differs-from-requested",
        },
        accessMode: {
          label: "Observed different value",
          comparison: "differs-from-requested",
        },
      },
    },
    {
      name: "unknown",
      observed: undefined,
      expectedStatus: "completed",
      expectedFailureCategory: undefined,
      expected: { kind: "unknown" },
    },
    {
      name: "observer-throws",
      observed: "throw" as const,
      expectedStatus: "failed",
      expectedFailureCategory: "runtime-failed",
      expected: undefined,
    },
  ] as const;

  for (const fixture of cases) {
    const caseDirectory = join(temporaryDirectory, fixture.name);
    const projectDirectory = join(caseDirectory, "project");
    const databasePath = join(caseDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const adapter = new ObservedProfileAdapter(fixture.observed);
    const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
      projectDirectory,
    );
    const receipt = await channel.act(
      directCommand({
        idempotencyKey: `projection-${fixture.name}`,
        requestedProfileProjection,
      }),
    );
    const terminal = await waitForTerminalCommand(channel, receipt);
    const snapshotBeforeClose = await channel.snapshot();
    assert.equal(snapshotBeforeClose.cursor, 11, `${fixture.name}: transition count`);
    assert.deepEqual(
      terminal.session?.requestedProfileProjection,
      requestedProfileProjection,
      `${fixture.name}: requested projection`,
    );
    assert.deepEqual(
      terminal.session?.effectiveProfileProjection,
      fixture.expected,
      `${fixture.name}: effective projection`,
    );
    assert.equal(terminal.status, fixture.expectedStatus, `${fixture.name}: status`);
    assert.equal(
      terminal.failureCategory,
      fixture.expectedFailureCategory,
      `${fixture.name}: failure category`,
    );
    const serialized = JSON.stringify(
      terminal.session?.effectiveProfileProjection ?? null,
    );
    assert.equal(
      serialized.includes("PRIVATE_ALTERNATE_MODEL"),
      false,
      `${fixture.name}: native model containment`,
    );
    assert.equal(
      serialized.includes("PRIVATE_ALTERNATE_EFFORT"),
      false,
      `${fixture.name}: native effort containment`,
    );
    await channel.close();

    const reopenedAdapter = new CompletingAdapter();
    const reopened = await createWorkbenchCoordinator({
      databasePath,
      adapter: reopenedAdapter,
    }).openProject(projectDirectory);
    assert.deepEqual(
      await reopened.snapshot(),
      snapshotBeforeClose,
      `${fixture.name}: restart projection`,
    );
    assert.equal(reopenedAdapter.inspectCalls, 0, `${fixture.name}: no redispatch`);
    await reopened.close();
  }
});

test("a continued Session records a mismatched post-turn observation and terminal-fails", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "profile-projection-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const adapter = new ObservedProfileAdapter(desiredProfile);
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const startReceipt = await channel.act(
    directCommand({ requestedProfileProjection }),
  );
  const started = await waitForTerminalCommand(channel, startReceipt);
  const sessionId = started.session?.sessionId;
  assert.equal(typeof sessionId, "string", "start Session identity");
  adapter.observed = {
    ...desiredProfile,
    effortLevel: "PRIVATE_LOWER_EFFORT",
  };
  const continueReceipt = await channel.act({
    kind: "direct",
    commandKind: "continue",
    idempotencyKey: "profile-projection-follow-up",
    runtime: "codex",
    targetSessionId: sessionId!,
    profile: desiredProfile,
    input: "fixed coordinator input",
  });
  await waitForTerminalCommand(channel, continueReceipt);
  const commands = (await channel.snapshot()).commands;
  assert.deepEqual(
    commands.map((command) => ({
      status: command.status,
      failureCategory: command.failureCategory,
    })),
    [
      { status: "completed", failureCategory: undefined },
      { status: "failed", failureCategory: "runtime-failed" },
    ],
    "reported effort drift is a protocol failure",
  );
  assert.deepEqual(
    commands.map((command) => command.session?.requestedProfileProjection),
    [requestedProfileProjection, requestedProfileProjection],
    "root projection retained across continuation",
  );
  assert.deepEqual(
    commands[1]?.session?.effectiveProfileProjection,
    {
      kind: "observed",
      provenance: "post-turn-observation",
      model: { label: "Solution 5.6", comparison: "matches-requested" },
      workIntensity: {
        label: "Observed different value",
        comparison: "differs-from-requested",
      },
      accessMode: { label: "Full access", comparison: "matches-requested" },
    },
    "follow-up effective observation",
  );
  assert.equal(
    JSON.stringify(commands).includes("PRIVATE_LOWER_EFFORT"),
    false,
    "follow-up native observation containment",
  );
  await channel.close();
});

test("projection is retained in the accepted envelope without changing idempotency or update ordering", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "profile-projection-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const adapter = new DeferredInspectAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  const firstAct = channel.act(directCommand({ requestedProfileProjection }));
  await adapter.inspectionStarted();
  const receipt = await firstAct;
  const database = new DatabaseSync(databasePath);
  const acceptedEnvelope = database
    .prepare("SELECT private_envelope_json FROM commands WHERE command_id = ?")
    .get(receipt.commandId) as { private_envelope_json: string };
  assert.deepEqual(
    JSON.parse(acceptedEnvelope.private_envelope_json).requestedProfileProjection,
    requestedProfileProjection,
    "acceptance envelope projection",
  );
  const alternatePresentation = {
    ...requestedProfileProjection,
    modelLabel: "Alternate safe presentation",
  };
  assert.deepEqual(
    await channel.act(directCommand({ requestedProfileProjection: alternatePresentation })),
    receipt,
    "same semantic payload receipt",
  );
  const retainedEnvelope = database
    .prepare("SELECT private_envelope_json FROM commands WHERE command_id = ?")
    .get(receipt.commandId) as { private_envelope_json: string };
  assert.equal(
    retainedEnvelope.private_envelope_json,
    acceptedEnvelope.private_envelope_json,
    "first accepted projection retained",
  );
  adapter.release();
  await waitForTerminalCommand(channel, receipt);
  assert.equal((await channel.snapshot()).cursor, 11, "unchanged update count/order");
  database.close();
  await channel.close();
});

test("an old command envelope remains readable and byte-identical without fabricated projections", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "profile-projection-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const channel = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const receipt = await channel.act(directCommand());
  await waitForTerminalCommand(channel, receipt);
  await channel.close();
  const database = new DatabaseSync(databasePath);
  const before = database
    .prepare(
      "SELECT private_envelope_json FROM commands WHERE command_id = ?",
    )
    .get(receipt.commandId) as { private_envelope_json: string };
  database.close();

  const reopened = await createWorkbenchCoordinator({
    databasePath,
    adapter: new CompletingAdapter(),
  }).openProject(projectDirectory);
  const historical = (await reopened.snapshot()).commands[0]?.session;
  assert.equal(historical?.requestedProfileProjection, undefined, "old requested shape");
  assert.equal(historical?.effectiveProfileProjection, undefined, "old effective shape");
  await reopened.close();
  const afterDatabase = new DatabaseSync(databasePath);
  const after = afterDatabase
    .prepare(
      "SELECT private_envelope_json FROM commands WHERE command_id = ?",
    )
    .get(receipt.commandId) as { private_envelope_json: string };
  afterDatabase.close();
  assert.equal(after.private_envelope_json, before.private_envelope_json, "no rewrite");
});

test("durable runtime resume identity endpoint and native profile are digest-bound", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "resume-identity-digest-"));
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));
  const corruptions = [
    {
      name: "endpoint",
      corrupt(identity: { endpointId: string; nativeProfile: SessionProfile }) {
        identity.endpointId = "claude-code-desktop";
      },
    },
    {
      name: "native-profile",
      corrupt(identity: { endpointId: string; nativeProfile: SessionProfile }) {
        identity.nativeProfile = {
          ...identity.nativeProfile,
          model: "tampered-native-model",
        };
      },
    },
  ];

  for (const fixture of corruptions) {
    const fixtureDirectory = join(temporaryDirectory, fixture.name);
    const projectDirectory = join(fixtureDirectory, "project");
    const databasePath = join(fixtureDirectory, "ledger.sqlite");
    await mkdir(projectDirectory, { recursive: true });
    const channel = await createWorkbenchCoordinator({
      databasePath,
      adapter: new CompletingAdapter(),
    }).openProject(projectDirectory);
    const receipt = await channel.act(
      directCommand({
        runtimeResumeIdentity: {
          schemaVersion: 1,
          endpointId: "codex-desktop",
          nativeProfile: desiredProfile,
        },
      }),
      { endpointId: "codex-desktop" },
    );
    await waitForTerminalCommand(channel, receipt);
    await channel.close();

    const database = new DatabaseSync(databasePath);
    const row = database
      .prepare(
        "SELECT private_envelope_json FROM commands WHERE command_id = ?",
      )
      .get(receipt.commandId) as { private_envelope_json: string };
    const envelope = JSON.parse(row.private_envelope_json) as {
      runtimeResumeIdentity: {
        endpointId: string;
        nativeProfile: SessionProfile;
      };
    };
    fixture.corrupt(envelope.runtimeResumeIdentity);
    database
      .prepare(
        "UPDATE commands SET private_envelope_json = ? WHERE command_id = ?",
      )
      .run(JSON.stringify(envelope), receipt.commandId);
    database.close();

    const adapter = new CompletingAdapter();
    await assert.rejects(
      createWorkbenchCoordinator({ databasePath, adapter }).openProject(
        projectDirectory,
      ),
      (error) =>
        error instanceof CoordinatorError && error.category === "storage-failed",
      fixture.name,
    );
    assert.equal(adapter.inspectCalls, 0, `${fixture.name}: no Adapter work`);
  }
});

test("adversarial display projections fail independently before durable mutation", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "profile-projection-"));
  const projectDirectory = join(temporaryDirectory, "project");
  const databasePath = join(temporaryDirectory, "ledger.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CompletingAdapter();
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(
    projectDirectory,
  );
  t.after(async () => {
    await channel.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const throwingProjection = { ...requestedProfileProjection } as Record<string, unknown>;
  Object.defineProperty(throwingProjection, "modelLabel", {
    enumerable: true,
    get() {
      throw new Error("PRIVATE_GETTER_SENTINEL");
    },
  });
  const cases = [
    {
      name: "extra field",
      value: { ...requestedProfileProjection, nativeModel: desiredProfile.model },
    },
    {
      name: "full path",
      value: { ...requestedProfileProjection, endpointLabel: "C:\\private\\runtime" },
    },
    {
      name: "opaque native key",
      value: {
        ...requestedProfileProjection,
        modelLabel: "Dm_jNv_EMAy_Y0OVELFexo_UKhItXc68dWq5HaRT2EVTas",
      },
    },
    {
      name: "control provenance drift",
      value: {
        ...requestedProfileProjection,
        workIntensityControlLabel: { label: "Reasoning", provenance: "native" },
      },
    },
    { name: "throwing getter", value: throwingProjection },
  ];
  for (const [index, fixture] of cases.entries()) {
    await assert.rejects(
      channel.act(
        directCommand({
          idempotencyKey: `invalid-projection-${index}`,
          requestedProfileProjection: fixture.value as never,
        }),
      ),
      (error) =>
        error instanceof CoordinatorError && error.category === "invalid-command",
      fixture.name,
    );
  }
  assert.equal((await channel.snapshot()).cursor, 0, "durable cursor unchanged");
  assert.equal(adapter.inspectCalls, 0, "Adapter inspection unchanged");
});
