import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CodexAdapter,
  catalogModelExtraKeys,
} from "../../src/agent-runtime/codex-adapter.ts";
import type { CodexCatalogObservation } from "../../src/agent-runtime/codex-adapter.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import type {
  NormalizedRuntimeEvent,
  RuntimeInput,
  RuntimeResume,
} from "../../src/agent-runtime/index.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";

const requestedProfile = {
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
};

function catalogAdapter(): CodexAdapter {
  return new CodexAdapter(() =>
    ScriptedTransport.fromFixture(new URL("./fixtures/catalog-success.jsonl", import.meta.url)),
  );
}

function fixtureAdapter(fixture: string): CodexAdapter {
  return new CodexAdapter(() =>
    ScriptedTransport.fromFixture(new URL(`./fixtures/${fixture}`, import.meta.url)),
  );
}

function currentFullCatalogModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "future-model-id",
    model: "future-model-native",
    upgrade: "future-model-next",
    upgradeInfo: {
      model: "future-model-next",
      upgradeCopy: null,
      modelLink: "https://provider.invalid/future-model-next",
      migrationMarkdown: "Move to Future Model Next.\n",
    },
    availabilityNux: { message: "Available with your subscription" },
    displayName: "Future Model",
    description: "Runtime-owned model description.",
    hidden: false,
    supportedReasoningEfforts: [
      {
        reasoningEffort: "native-burst",
        description: "Runtime-owned future effort",
      },
    ],
    defaultReasoningEffort: "native-burst",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: ["fast"],
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Increased speed" },
    ],
    defaultServiceTier: "priority",
    isDefault: true,
    // Admitted 2026-08-15 from a real `model/list` read: every model carried
    // both. Observed `modelSpecialty` was `null` on all seven models and
    // `multiAgentVersion` was `"v1"`, `"v2"` or `null`.
    modelSpecialty: null,
    multiAgentVersion: "v2",
    ...overrides,
  };
}

function codexSteerTransport(
  steerResult: unknown,
  includeSuccessfulTerminal = true,
): ScriptedTransport {
  const frames: string[] = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
          },
        ],
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        thread: { id: "thread-fixed" },
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "thread-fixed" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: { turn: { id: "turn-fixed", status: "inProgress" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "thread-fixed",
        turn: { id: "turn-fixed", status: "inProgress" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 6, result: steerResult }),
  ];
  if (includeSuccessfulTerminal) {
    frames.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-fixed",
          turnId: "turn-fixed",
          item: { id: "item-fixed", type: "agentMessage" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-fixed",
          turnId: "turn-fixed",
          item: {
            id: "item-fixed",
            type: "agentMessage",
            phase: "final_answer",
            text: "GUIDANCE_APPLIED_IN_SAME_TURN",
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-fixed",
          turn: { id: "turn-fixed", status: "completed" },
        },
      }),
    );
  }
  return new ScriptedTransport(frames);
}

async function startAndObserve(fixture: string) {
  const binding = await fixtureAdapter(fixture).start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return events;
}

async function resumeAndObserve(fixture: string) {
  const transport = await ScriptedTransport.fromFixture(
    new URL(`./fixtures/${fixture}`, import.meta.url),
  );
  const adapter = new CodexAdapter(async () => transport);
  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return { binding, events, transport };
}

async function collectIterator(
  iterator: AsyncIterator<NormalizedRuntimeEvent>,
): Promise<NormalizedRuntimeEvent[]> {
  const events: NormalizedRuntimeEvent[] = [];
  for (;;) {
    const result = await iterator.next();
    if (result.done) return events;
    events.push(result.value);
  }
}

async function inspectWithInjectedCatalogPage(page: unknown): Promise<{
  readonly error: unknown;
  readonly transport: ScriptedTransport;
}> {
  const injectedLine = '{"injected":"catalog-page"}';
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    injectedLine,
  ]);
  const adapter = new CodexAdapter(async () => transport);
  const originalParse = JSON.parse;
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) =>
    text === injectedLine
      ? { jsonrpc: "2.0", id: 3, result: page }
      : originalParse(text, reviver)) as typeof JSON.parse;
  try {
    await adapter.inspect("C:\\synthetic-project");
    return { error: undefined, transport };
  } catch (error) {
    return { error, transport };
  } finally {
    JSON.parse = originalParse;
  }
}

function currentOfficialResumeResult(opaqueSessionReference: string) {
  return {
    activePermissionProfile: null,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "C:\\synthetic-project",
    initialTurnsPage: null,
    instructionSources: [],
    itemsBackwardsCursor: null,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    multiAgentMode: "explicitRequestOnly",
    reasoningEffort: "ultra",
    runtimeWorkspaceRoots: [],
    sandbox: { type: "dangerFullAccess" },
    serviceTier: null,
    thread: {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: "0.147.0-alpha.synthetic",
      createdAt: 1,
      cwd: "C:\\synthetic-project",
      ephemeral: false,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: opaqueSessionReference,
      modelProvider: "openai",
      name: null,
      parentThreadId: null,
      path: null,
      preview: "",
      recencyAt: null,
      section: null,
      sectionEnteredAt: null,
      sessionId: "session-fixed",
      source: "appServer",
      status: { type: "idle" },
      threadSource: null,
      turns: [],
      updatedAt: 2,
    },
    turnsBackwardsCursor: null,
  };
}

async function observeTokenUsage(tokenUsages: readonly unknown[]) {
  const contents = await readFile(
    new URL("./fixtures/single-turn-success.jsonl", import.meta.url),
    "utf8",
  );
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  const terminalIndex = lines.findIndex((line) => {
    const message = JSON.parse(line) as {
      readonly method?: string;
      readonly params?: { readonly threadId?: string };
    };
    return (
      message.method === "turn/completed" && message.params?.threadId === "thread-fixed"
    );
  });
  assert.notEqual(terminalIndex, -1);
  lines.splice(
    terminalIndex,
    0,
    ...tokenUsages.map((tokenUsage) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-fixed",
          turnId: "turn-fixed",
          tokenUsage,
        },
      }),
    ),
  );
  const transport = new ScriptedTransport(lines);
  const adapter = new CodexAdapter(async () => transport);
  const binding = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return { events, transport };
}

const tokenCounts = Object.freeze({
  totalTokens: 120,
  inputTokens: 80,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 0,
  outputTokens: 20,
  reasoningOutputTokens: 10,
});

const tokenUsage = Object.freeze({
  total: tokenCounts,
  last: Object.freeze({
    totalTokens: 20,
    inputTokens: 10,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 2,
  }),
  modelContextWindow: 258_400,
});

test("inspect preserves each model's supported Effort Levels", async () => {
  const adapter = new CodexAdapter(() =>
    ScriptedTransport.fromFixture(new URL("./fixtures/catalog-success.jsonl", import.meta.url)),
  );

  const catalog = await adapter.inspect("C:\\synthetic-project");

  assert.deepEqual(catalog.models, [
    {
      id: "gpt-5.6-sol",
      displayName: "Sol Display",
      effortLevels: ["high", "ultra"],
      effortLevelLabels: ["Focused review", "Coordinated deep review"],
    },
    {
      id: "gpt-5.5-codex",
      displayName: "Codex Display",
      effortLevels: ["medium", "high"],
      effortLevelLabels: ["Measured pass", "Thorough pass"],
    },
  ]);
  assert.deepEqual(catalog.executionModes, ["single-agent"]);
  assert.deepEqual(catalog.accessModes, ["full-access"]);
});

test("inspect admits the current exact model variant and preserves an unknown safe Effort Level", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "future-model-id",
            model: "future-model-native",
            displayName: "Future Model",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "native-burst",
                description: "Runtime-owned future effort",
              },
            ],
          },
        ],
        nextCursor: null,
      },
    }),
  ]);

  const catalog = await new CodexAdapter(async () => transport).inspect(
    "C:\\synthetic-project",
  );

  assert.deepEqual(catalog.models, [
    {
      id: "future-model-id",
      displayName: "Future Model",
      effortLevels: ["native-burst"],
      effortLevelLabels: ["Runtime-owned future effort"],
    },
  ]);
});

test("inspect accepts a missing nextCursor as an exact terminal page", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [{ id: "model-001", supportedReasoningEfforts: ["low"] }],
      },
    }),
  ]);

  const catalog = await new CodexAdapter(async () => transport).inspect(
    "C:\\synthetic-project",
  );

  assert.deepEqual(catalog.models, [
    { id: "model-001", effortLevels: ["low"] },
  ]);
  assert.deepEqual(
    transport.recordedOutboundJsonl()
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
      .filter((message) => message.method === "model/list")
      .map((message) => message.params),
    [{}],
  );
  assert.equal(transport.recordedStopCalls(), 1);
});

test("inspect accepts the current exact model variant without a model key", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "future-model-id",
            displayName: "Future Model",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "native-burst",
                description: "Runtime-owned future effort",
              },
            ],
          },
        ],
        nextCursor: null,
      },
    }),
  ]);

  const catalog = await new CodexAdapter(async () => transport).inspect(
    "C:\\synthetic-project",
  );

  assert.deepEqual(catalog.models, [
    {
      id: "future-model-id",
      displayName: "Future Model",
      effortLevels: ["native-burst"],
      effortLevelLabels: ["Runtime-owned future effort"],
    },
  ]);
  assert.equal(transport.recordedStopCalls(), 1);
});

test("inspect accepts the full exact current model response and drops unrequested metadata", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { data: [currentFullCatalogModel()], nextCursor: null },
    }),
  ]);

  const catalog = await new CodexAdapter(async () => transport).inspect(
    "C:\\synthetic-project",
  );

  assert.deepEqual(catalog.models, [
    {
      id: "future-model-id",
      displayName: "Future Model",
      effortLevels: ["native-burst"],
      effortLevelLabels: ["Runtime-owned future effort"],
    },
  ]);
  assert.equal(transport.recordedStopCalls(), 1);
});

test("the 2026-08-15 admitted vendor fields stay validated, dropped, and closed", async () => {
  // The real CLI shipped `modelSpecialty` and `multiAgentVersion` on every
  // model and the sixteen-key set rejected all seven, taking Codex catalog
  // reads down in the built product. Admitting them is rule 1's deliberate
  // extension, so the adversarial half has to hold: the admitted values are
  // validated — never waved through — and must not reach the product.
  const inspectWith = async (model: Record<string, unknown>) =>
    await new CodexAdapter(async () =>
      new ScriptedTransport([
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: { data: [model], nextCursor: null },
        }),
      ]),
    ).inspect("C:\\synthetic-project");

  // The real observed shape is accepted, and neither new field is forwarded.
  const catalog = await inspectWith(currentFullCatalogModel());
  assert.deepEqual(Object.keys(catalog.models[0]!).sort(), [
    "displayName",
    "effortLevels",
    "effortLevelLabels",
    "id",
  ].sort());
  assert.equal(
    JSON.stringify(catalog).includes("multiAgentVersion"),
    false,
  );
  assert.equal(JSON.stringify(catalog).includes("modelSpecialty"), false);

  // `multiAgentVersion` is legitimately null on some real models.
  await inspectWith(currentFullCatalogModel({ multiAgentVersion: null }));

  // `F110`, decided 2026-08-16: the next unadmitted *additive* vendor key is
  // now tolerated rather than fatal. Both live outages were additions, and the
  // value is dropped by construction, so failing closed on them bought nothing
  // and cost the whole Codex endpoint. Subtraction stays fatal — see below.
  const tolerated = await inspectWith(
    currentFullCatalogModel({ speculativeDecoding: true }),
  );
  assert.deepEqual(Object.keys(tolerated.models[0]!).sort(), [
    "displayName",
    "effortLevels",
    "effortLevelLabels",
    "id",
  ].sort());
  assert.equal(
    JSON.stringify(tolerated).includes("speculativeDecoding"),
    false,
  );

  // `F110` round 2 note: "omitting an admitted key is still not the exact
  // shape" used to be a hostile row here. That assertion enforced the exact
  // boundary this order reverses — a full model that loses an unconsumed key
  // now reclassifies to the richest smaller recognised shape instead of
  // taking the catalog down; the reclassification is proven in the boundary
  // sentinel test below.
  for (const hostile of [
    // Admitted keys are validated, not waved through.
    currentFullCatalogModel({ multiAgentVersion: 2 }),
    currentFullCatalogModel({ multiAgentVersion: "  v2  " }),
    currentFullCatalogModel({ multiAgentVersion: "v".repeat(121) }),
    currentFullCatalogModel({ modelSpecialty: false }),
    currentFullCatalogModel({ modelSpecialty: "" }),
  ]) {
    await assert.rejects(
      inspectWith(hostile),
      (error: unknown) =>
        error instanceof RuntimeAdapterError &&
        error.category === "catalog-invalid",
      JSON.stringify(Object.keys(hostile)),
    );
  }
});

/**
 * The `F110` tolerance is only safe because the value of a tolerated key is
 * unreachable, so that is what gets proven — not a list of key names somebody
 * remembered to write down.
 *
 * Twelve keys nobody has ever seen, each carrying a distinctive sentinel value,
 * are injected at once. The product model must still have exactly its four
 * members, and neither the sentinel names nor the sentinel values may appear
 * anywhere in the serialised catalog. The parser returns a fresh frozen literal,
 * `normalizeCatalog` rebuilds another, and `sanitizeInspectedCatalog` narrows a
 * third, so a leak at any of the three projections fails this.
 */
test("F110 tolerated vendor keys are unreachable, not merely unlisted", async () => {
  const sentinelKeys = [
    "speculativeDecoding",
    "pricingTier",
    "promoListPrice",
    "trainingCutoff",
    "contextWindowTokens",
    "vendorTelemetryUrl",
    "experimentBucket",
    "internalCodename",
    "deprecationDate",
    "regionAvailability",
    "billingAccountHint",
    "rolloutPercentage",
  ] as const;
  const additions: Record<string, unknown> = {};
  for (const [index, key] of sentinelKeys.entries()) {
    additions[key] = `SENTINEL_VALUE_${index}_${key.toUpperCase()}`;
  }

  const observations: CodexCatalogObservation[] = [];
  const catalog = await new CodexAdapter(
    async () =>
      new ScriptedTransport([
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            data: [currentFullCatalogModel(additions)],
            nextCursor: null,
          },
        }),
      ]),
    undefined,
    (observation) => observations.push(observation),
  ).inspect("C:\\synthetic-project");

  assert.deepEqual(Object.keys(catalog.models[0]!).sort(), [
    "displayName",
    "effortLevels",
    "effortLevelLabels",
    "id",
  ].sort());

  const serialized = JSON.stringify(catalog);
  for (const [index, key] of sentinelKeys.entries()) {
    assert.equal(serialized.includes(key), false, `leaked key name ${key}`);
    assert.equal(
      serialized.includes(`SENTINEL_VALUE_${index}_${key.toUpperCase()}`),
      false,
      `leaked sentinel value for ${key}`,
    );
  }

  // The observation is the half `F110` was actually missing: something has to
  // say *which* field moved, or the owner cannot tell a vendor change from a
  // broken install.
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]!.toleratedKeys, [...sentinelKeys].sort());
  assert.deepEqual(observations[0]!.rejections, []);
  assert.equal(observations[0]!.rejectionsOmitted, 0);
});

/**
 * `F110` round 2 replaced this test's predecessor, which asserted that
 * tolerance applied at exactly one layer ("and never at a nested layer") and
 * that a full model missing an admitted key was fatal. Both assertions
 * enforced the ruling the 2026-08-16 order explicitly reverses: the nested
 * vendor-owned record layers now carry the same asymmetric tolerance, and a
 * full model that loses an unconsumed key reclassifies instead of dying.
 *
 * What the boundary still refuses — at EVERY layer, which is what this test
 * pins: key names must be printable, bounded, and free of prototype-pollution
 * names. A single hostile model quarantines; with no surviving sibling the
 * read stays a loud `catalog-invalid`.
 */
test("F110 round 2: key-name hygiene fails closed at every tolerated layer", async () => {
  const inspectWith = async (result: Record<string, unknown>) =>
    await new CodexAdapter(async () =>
      new ScriptedTransport([
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, result }),
      ]),
    ).inspect("C:\\synthetic-project");
  const pageWith = (model: Record<string, unknown>) => ({
    data: [model],
    nextCursor: null,
  });

  const hostile: readonly (readonly [string, Record<string, unknown>])[] = [
    // Prototype-pollution names are refused as key names outright.
    ["__proto__ key", pageWith(currentFullCatalogModel({ ["__proto__"]: "x" }))],
    ["constructor key", pageWith(currentFullCatalogModel({ constructor: "x" }))],
    ["prototype key", pageWith(currentFullCatalogModel({ prototype: "x" }))],
    // Key names must stay printable and bounded.
    ["control character key", pageWith(currentFullCatalogModel({ "bad\u0000key": 1 }))],
    ["bidi override key", pageWith(currentFullCatalogModel({ "bad\u202ekey": 1 }))],
    ["untrimmed key", pageWith(currentFullCatalogModel({ "  padded  ": 1 }))],
    ["empty key", pageWith(currentFullCatalogModel({ "": 1 }))],
    ["overlong key", pageWith(currentFullCatalogModel({ ["k".repeat(121)]: 1 }))],
    // The same hygiene binds each newly tolerated layer.
    [
      "__proto__ key on an effort entry",
      pageWith(
        currentFullCatalogModel({
          supportedReasoningEfforts: [
            {
              reasoningEffort: "native-burst",
              description: "Runtime-owned future effort",
              ["__proto__"]: "x",
            },
          ],
        }),
      ),
    ],
    [
      "control character key on a service tier",
      pageWith(
        currentFullCatalogModel({
          serviceTiers: [
            {
              id: "priority",
              name: "Fast",
              description: "Increased speed",
              "bad\u0000key": 1,
            },
          ],
        }),
      ),
    ],
    [
      "__proto__ key on upgradeInfo",
      pageWith(
        currentFullCatalogModel({
          upgradeInfo: { model: "future-model-next", ["__proto__"]: "x" },
        }),
      ),
    ],
    [
      "overlong key on availabilityNux",
      pageWith(
        currentFullCatalogModel({
          availabilityNux: { message: "Available", ["k".repeat(121)]: 1 },
        }),
      ),
    ],
    // The page envelope has no quarantine beneath it: a hostile page key is
    // fatal directly.
    [
      "__proto__ key on the page envelope",
      Object.defineProperty(
        { data: [currentFullCatalogModel()], nextCursor: null },
        "__proto__",
        { value: "x", enumerable: true, configurable: true },
      ) as Record<string, unknown>,
    ],
  ];

  for (const [label, result] of hostile) {
    await assert.rejects(
      inspectWith(result),
      (error: unknown) =>
        error instanceof RuntimeAdapterError &&
        error.category === "catalog-invalid",
      label,
    );
  }
});

/**
 * The superset predicate is exercised directly here because these inputs cannot
 * survive the wire: everything reaching the parser in production has been
 * through `JSON.parse`, which only ever produces plain enumerable data
 * properties. The rule still has to hold at the predicate, because the exact
 * predicate enforced it for free via `keys.length === expectedKeys.length` and
 * dropping that arithmetic would silently drop the guarantee with it.
 */
test("F110 superset tolerance sweeps every own key, not just the required ones", () => {
  const required = ["id", "displayName"] as const;
  const base = () => ({ id: "m", displayName: "M" }) as Record<string, unknown>;

  assert.deepEqual(catalogModelExtraKeys(base(), required), []);
  assert.deepEqual(
    catalogModelExtraKeys({ ...base(), zeta: 1, alpha: 2 }, required),
    ["alpha", "zeta"],
  );

  // Subtraction is still fatal.
  assert.equal(catalogModelExtraKeys({ id: "m" }, required), undefined);

  const nonEnumerable = base();
  Object.defineProperty(nonEnumerable, "hiddenExtra", {
    value: 1,
    enumerable: false,
    configurable: true,
  });
  assert.equal(catalogModelExtraKeys(nonEnumerable, required), undefined);

  const accessor = base();
  Object.defineProperty(accessor, "accessorExtra", {
    get: () => 1,
    enumerable: true,
    configurable: true,
  });
  assert.equal(catalogModelExtraKeys(accessor, required), undefined);

  const accessorOnRequired = { displayName: "M" } as Record<string, unknown>;
  Object.defineProperty(accessorOnRequired, "id", {
    get: () => "m",
    enumerable: true,
    configurable: true,
  });
  assert.equal(catalogModelExtraKeys(accessorOnRequired, required), undefined);

  const symbolKeyed = base();
  (symbolKeyed as Record<symbol, unknown>)[Symbol("s")] = 1;
  assert.equal(catalogModelExtraKeys(symbolKeyed, required), undefined);

  assert.equal(catalogModelExtraKeys(null, required), undefined);
  assert.equal(catalogModelExtraKeys([], required), undefined);
  assert.equal(
    catalogModelExtraKeys(Object.create(null) as object, required),
    undefined,
  );
  assert.equal(
    catalogModelExtraKeys(new Proxy(base(), {}), required),
    undefined,
  );
});

test("a rejected catalog names the field that moved, in both directions", async () => {
  const observations: CodexCatalogObservation[] = [];
  const adapter = new CodexAdapter(
    async () =>
      new ScriptedTransport([
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            data: [
              // `F110` round 2: losing an unconsumed full-only key now
              // reclassifies instead of rejecting, so a genuine shape
              // mismatch has to lose a CONSUMED key — no recognised shape
              // exists without `supportedReasoningEfforts`.
              (() => {
                const model = currentFullCatalogModel({ brandNewField: 1 });
                delete (model as Record<string, unknown>)
                  .supportedReasoningEfforts;
                return model;
              })(),
            ],
            nextCursor: null,
          },
        }),
      ]),
    undefined,
    (observation) => observations.push(observation),
  );

  await assert.rejects(
    adapter.inspect("C:\\synthetic-project"),
    (error: unknown) =>
      error instanceof RuntimeAdapterError &&
      error.category === "catalog-invalid",
  );

  // The observation must survive the failure — a rejected catalog is exactly
  // when the diagnosis is needed — and must separate "the vendor added x" from
  // "the vendor removed y", because those demand opposite responses.
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.rejections.length, 1);
  assert.deepEqual(observations[0]!.rejections[0]!.unknownKeys, [
    "brandNewField",
  ]);
  assert.deepEqual(observations[0]!.rejections[0]!.missingKeys, [
    "supportedReasoningEfforts",
  ]);
  assert.deepEqual(observations[0]!.rejections[0]!.invalidValueKeys, []);
  assert.equal(observations[0]!.rejections[0]!.modelId, "future-model-id");
});

test("an observer that throws cannot turn a good catalog into a failed one", async () => {
  const catalog = await new CodexAdapter(
    async () =>
      new ScriptedTransport([
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: { data: [currentFullCatalogModel()], nextCursor: null },
        }),
      ]),
    undefined,
    () => {
      throw new Error("observer fault");
    },
  ).inspect("C:\\synthetic-project");

  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]!.id, "future-model-id");
});

test("inspect accepts the exact legacy Effort object without a description", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "model-001",
            supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
          },
        ],
        nextCursor: null,
      },
    }),
  ]);

  const catalog = await new CodexAdapter(async () => transport).inspect(
    "C:\\synthetic-project",
  );

  assert.deepEqual(catalog.models, [
    { id: "model-001", effortLevels: ["ultra"] },
  ]);
  assert.equal(transport.recordedStopCalls(), 1);
});

/**
 * Until `F110` round 2 (2026-08-16) this block was "inspect rejects inexact
 * Codex catalog pages and models": every row below was asserted FATAL for the
 * whole catalog. That contract is the one the probe measured eight-of-nine
 * outages against, and the order reverses it — an additive vendor key at any
 * catalog layer is tolerated, observed by name, and dropped. The old rows are
 * kept as acceptance rows so the same wire shapes stay pinned, now to the
 * inverted outcome, with the observation asserting exactly which key was seen.
 */
test("vendor additions at every catalog layer are tolerated, observed, and dropped", async () => {
  const rows: readonly (readonly [
    string,
    Record<string, unknown>,
    readonly string[],
    readonly string[],
  ])[] = [
    [
      "page envelope with nextCursor",
      {
        data: [{ id: "model-001", supportedReasoningEfforts: ["low"] }],
        nextCursor: null,
        extra: true,
      },
      ["extra"],
      ["model-001"],
    ],
    [
      "page envelope without nextCursor",
      {
        data: [{ id: "model-001", supportedReasoningEfforts: ["low"] }],
        extra: true,
      },
      ["extra"],
      ["model-001"],
    ],
    [
      "legacy model shape",
      {
        data: [
          { id: "model-001", supportedReasoningEfforts: ["low"], extra: true },
        ],
        nextCursor: null,
      },
      ["extra"],
      ["model-001"],
    ],
    [
      "legacy effort entry",
      {
        data: [
          {
            id: "model-001",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", extra: true },
            ],
          },
        ],
        nextCursor: null,
      },
      ["extra"],
      ["model-001"],
    ],
    [
      "current model shape without a native model key",
      {
        data: [
          {
            id: "model-001",
            displayName: "Current model",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
            ],
            extra: true,
          },
        ],
        nextCursor: null,
      },
      ["extra"],
      ["model-001"],
    ],
    [
      "current effort entry",
      {
        data: [
          {
            id: "model-001",
            model: "model-native",
            displayName: "Current model",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low", effort: "low" },
            ],
          },
        ],
        nextCursor: null,
      },
      ["effort"],
      ["model-001"],
    ],
    [
      "upgradeInfo",
      {
        data: [
          currentFullCatalogModel({
            upgradeInfo: {
              model: "future-model-next",
              upgradeCopy: null,
              modelLink: null,
              migrationMarkdown: null,
              extra: true,
            },
          }),
        ],
        nextCursor: null,
      },
      ["extra"],
      ["future-model-id"],
    ],
    [
      "availabilityNux",
      {
        data: [
          currentFullCatalogModel({
            availabilityNux: { message: "Available", extra: true },
          }),
        ],
        nextCursor: null,
      },
      ["extra"],
      ["future-model-id"],
    ],
    [
      "service tier entry",
      {
        data: [
          currentFullCatalogModel({
            serviceTiers: [
              {
                id: "priority",
                name: "Fast",
                description: "Increased speed",
                extra: true,
              },
            ],
          }),
        ],
        nextCursor: null,
      },
      ["extra"],
      ["future-model-id"],
    ],
  ];

  for (const [label, result, expectedTolerated, expectedModelIds] of rows) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, result }),
    ]);
    const observations: CodexCatalogObservation[] = [];
    const catalog = await new CodexAdapter(
      async () => transport,
      undefined,
      (observation) => observations.push(observation),
    ).inspect("C:\\synthetic-project");

    assert.deepEqual(
      catalog.models.map((model) => model.id),
      expectedModelIds,
      label,
    );
    // The tolerated key is named to the observation and appears nowhere in
    // the product catalog.
    assert.equal(observations.length, 1, label);
    assert.deepEqual(observations[0]!.toleratedKeys, expectedTolerated, label);
    assert.deepEqual(observations[0]!.rejections, [], label);
    for (const tolerated of expectedTolerated) {
      // Match the serialized KEY form: `effort` may not appear as a key even
      // though `effortLevels` legitimately does.
      assert.equal(
        JSON.stringify(catalog).includes(`"${tolerated}":`),
        false,
        `${label}: leaked ${tolerated}`,
      );
    }
    assert.equal(transport.recordedStopCalls(), 1, label);
  }
});

/**
 * `F110` round 2, A.3 — the Supervisor's reversal of the no-quarantine
 * ruling: one unusable model quarantines that one model, the rest of the
 * catalog ships, and the drop is never silent — the rejection names the model
 * and what moved on it, in the direction that moved (added / removed /
 * invalid value).
 */
test("one unusable model quarantines alone and the survivors ship, visibly", async () => {
  const sibling = currentFullCatalogModel({
    id: "sibling-model-id",
    model: "sibling-model-native",
    isDefault: false,
  });
  const rows: readonly (readonly [
    string,
    Record<string, unknown>,
    Readonly<{
      modelId: string;
      unknownKeys: readonly string[];
      missingKeys: readonly string[];
      invalidValueKeys: readonly string[];
    }>,
  ])[] = [
    [
      "recognised key with an unusable value",
      currentFullCatalogModel({ id: "broken-model-id", hidden: "nope" }),
      {
        modelId: "broken-model-id",
        unknownKeys: [],
        missingKeys: [],
        invalidValueKeys: ["hidden"],
      },
    ],
    [
      "current shape with legacy string efforts",
      {
        id: "broken-model-id",
        model: "model-native",
        displayName: "Current model",
        supportedReasoningEfforts: ["low"],
      },
      {
        modelId: "broken-model-id",
        unknownKeys: [],
        missingKeys: [],
        invalidValueKeys: ["supportedReasoningEfforts"],
      },
    ],
    [
      "empty effort list",
      { id: "broken-model-id", supportedReasoningEfforts: [] },
      {
        modelId: "broken-model-id",
        unknownKeys: [],
        missingKeys: [],
        invalidValueKeys: ["supportedReasoningEfforts"],
      },
    ],
    [
      "no recognised shape at all",
      { id: "broken-model-id", brandNewField: 1 },
      {
        modelId: "broken-model-id",
        unknownKeys: ["brandNewField"],
        // The full recognised shape minus the one key the candidate carries.
        missingKeys: [
          "additionalSpeedTiers",
          "availabilityNux",
          "defaultReasoningEffort",
          "defaultServiceTier",
          "description",
          "displayName",
          "hidden",
          "inputModalities",
          "isDefault",
          "model",
          "modelSpecialty",
          "multiAgentVersion",
          "serviceTiers",
          "supportedReasoningEfforts",
          "supportsPersonality",
          "upgrade",
          "upgradeInfo",
        ],
        invalidValueKeys: [],
      },
    ],
    [
      "multiple invalid values are all named at once",
      currentFullCatalogModel({
        id: "broken-model-id",
        hidden: "nope",
        isDefault: "also-nope",
      }),
      {
        modelId: "broken-model-id",
        unknownKeys: [],
        missingKeys: [],
        invalidValueKeys: ["hidden", "isDefault"],
      },
    ],
  ];

  for (const [label, brokenModel, expectedRejection] of rows) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { data: [brokenModel, sibling], nextCursor: null },
      }),
    ]);
    const observations: CodexCatalogObservation[] = [];
    const catalog = await new CodexAdapter(
      async () => transport,
      undefined,
      (observation) => observations.push(observation),
    ).inspect("C:\\synthetic-project");

    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ["sibling-model-id"],
      label,
    );
    assert.equal(observations.length, 1, label);
    assert.deepEqual(observations[0]!.rejections, [expectedRejection], label);
    assert.equal(observations[0]!.rejectionsOmitted, 0, label);
    // A quarantined model's stray keys never count as catalog-wide drift.
    assert.deepEqual(observations[0]!.toleratedKeys, [], label);
    assert.equal(transport.recordedStopCalls(), 1, label);
  }

  // With no surviving sibling the read stays a loud failure: an empty
  // catalog reached silently would be worse than the outage it replaces.
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [{ id: "broken-model-id", supportedReasoningEfforts: [] }],
        nextCursor: null,
      },
    }),
  ]);
  const observations: CodexCatalogObservation[] = [];
  await assert.rejects(
    new CodexAdapter(
      async () => transport,
      undefined,
      (observation) => observations.push(observation),
    ).inspect("C:\\synthetic-project"),
    (error) =>
      error instanceof RuntimeAdapterError &&
      error.category === "catalog-invalid",
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.rejections.length, 1);
  assert.equal(transport.recordedStopCalls(), 1);
});

/**
 * The nine-row next-vendor-change probe from the `F110` round-2 Work Order —
 * nine plausible next moves by the vendor, eight of which took the whole
 * Codex endpoint out of the product before this change. Kept as a permanent
 * gate so the acceptance stays a measurement: every row must leave the
 * catalog alive, and the one row with a genuinely unusable model must
 * quarantine it visibly rather than kill the catalog. Row 10 extends the
 * dispatcher's table with the page envelope, which is the same failure class.
 */
test("F110 round 2: the ten-row next-vendor-change probe leaves the catalog alive", async () => {
  const inspectObserved = async (result: Record<string, unknown>) => {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, result }),
    ]);
    const observations: CodexCatalogObservation[] = [];
    const catalog = await new CodexAdapter(
      async () => transport,
      undefined,
      (observation) => observations.push(observation),
    ).inspect("C:\\synthetic-project");
    assert.equal(transport.recordedStopCalls(), 1);
    assert.equal(observations.length, 1);
    return { catalog, observation: observations[0]! };
  };
  const pageWith = (...models: Record<string, unknown>[]) => ({
    data: models,
    nextCursor: null,
  });

  // Row 1: extra key on the 18-key top-level model.
  const row1 = await inspectObserved(
    pageWith(currentFullCatalogModel({ speculativeDecoding: true })),
  );
  assert.equal(row1.catalog.models.length, 1);
  assert.deepEqual(row1.observation.toleratedKeys, ["speculativeDecoding"]);

  // Row 2: extra key on a supportedReasoningEfforts entry.
  const row2 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({
        supportedReasoningEfforts: [
          {
            reasoningEffort: "native-burst",
            description: "Runtime-owned future effort",
            latencyClass: "interactive",
          },
        ],
      }),
    ),
  );
  assert.equal(row2.catalog.models.length, 1);
  assert.deepEqual(row2.observation.toleratedKeys, ["latencyClass"]);

  // Row 3: extra key on a serviceTiers entry.
  const row3 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({
        serviceTiers: [
          {
            id: "priority",
            name: "Fast",
            description: "Increased speed",
            regionScope: "eu",
          },
        ],
      }),
    ),
  );
  assert.equal(row3.catalog.models.length, 1);
  assert.deepEqual(row3.observation.toleratedKeys, ["regionScope"]);

  // Row 4: extra key on upgradeInfo.
  const row4 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({
        upgradeInfo: {
          model: "future-model-next",
          upgradeCopy: null,
          modelLink: null,
          migrationMarkdown: null,
          deadline: "2027-01-01",
        },
      }),
    ),
  );
  assert.equal(row4.catalog.models.length, 1);
  assert.deepEqual(row4.observation.toleratedKeys, ["deadline"]);

  // Row 5: extra key on availabilityNux.
  const row5 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({
        availabilityNux: {
          message: "Available with your subscription",
          dismissible: true,
        },
      }),
    ),
  );
  assert.equal(row5.catalog.models.length, 1);
  assert.deepEqual(row5.observation.toleratedKeys, ["dismissible"]);

  // Row 6: a new inputModalities VALUE — the vendor ships video input.
  const row6 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({ inputModalities: ["text", "image", "video"] }),
    ),
  );
  assert.equal(row6.catalog.models.length, 1);
  assert.deepEqual(row6.observation.rejections, []);
  assert.equal(JSON.stringify(row6.catalog).includes("video"), false);

  // Row 7: a fourth inputModalities entry (the old hard cap was 3).
  const row7 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({
        inputModalities: ["text", "image", "audio", "video"],
      }),
    ),
  );
  assert.equal(row7.catalog.models.length, 1);
  assert.deepEqual(row7.observation.rejections, []);

  // Row 8: a new top-level key on the 4-key model shape.
  const row8 = await inspectObserved(
    pageWith({
      id: "small-model-id",
      model: "small-model-native",
      displayName: "Small Model",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
      brandNewKey: true,
    }),
  );
  assert.deepEqual(
    row8.catalog.models.map((model) => model.id),
    ["small-model-id"],
  );
  assert.deepEqual(row8.observation.toleratedKeys, ["brandNewKey"]);

  // Row 9: one bad model among two otherwise-valid ones — quarantined
  // visibly, catalog alive. (The bad model must be bad on a validated field:
  // rows 6-7 stopped being bad when modality values became tolerated.)
  const row9 = await inspectObserved(
    pageWith(
      currentFullCatalogModel({ id: "broken-model-id", hidden: "nope" }),
      currentFullCatalogModel({
        id: "sibling-model-id",
        model: "sibling-model-native",
        isDefault: false,
      }),
    ),
  );
  assert.deepEqual(
    row9.catalog.models.map((model) => model.id),
    ["sibling-model-id"],
  );
  assert.deepEqual(row9.observation.rejections, [
    {
      modelId: "broken-model-id",
      unknownKeys: [],
      missingKeys: [],
      invalidValueKeys: ["hidden"],
    },
  ]);

  // Row 10: a new key on the page envelope itself.
  const row10 = await inspectObserved({
    data: [currentFullCatalogModel()],
    nextCursor: null,
    hasMore: false,
  });
  assert.equal(row10.catalog.models.length, 1);
  assert.deepEqual(row10.observation.toleratedKeys, ["hasMore"]);
});

/**
 * `F133` — the boundary sentinel. The previous ruling's boundary ("nested
 * objects keep set equality") was maintained by nothing: the tolerant
 * predicate could slide one layer down with the whole suite staying green.
 * The boundary after round 2 is different — required keys must be present
 * and recognised values stay validated, at EVERY catalog layer — and this
 * test is what goes red if it moves in either direction: if a required key
 * stops being required, the quarantine rows pass instead of rejecting; if
 * value validation is widened into a pass-through, the invalid-value rows
 * accept. The session wire keeps exact shapes; its own sentinels are the
 * `nativeExtra` rows in the resume tests below, which reject any additive
 * key on `thread/resume` results.
 */
test("F133: required keys and validated values hold at every tolerated layer", async () => {
  const sibling = currentFullCatalogModel({
    id: "sibling-model-id",
    model: "sibling-model-native",
    isDefault: false,
  });
  const inspectObserved = async (result: Record<string, unknown>) => {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, result }),
    ]);
    const observations: CodexCatalogObservation[] = [];
    const catalog = await new CodexAdapter(
      async () => transport,
      undefined,
      (observation) => observations.push(observation),
    ).inspect("C:\\synthetic-project");
    return { catalog, observation: observations[0]! };
  };

  // Subset stays fatal per layer: each row loses one required key at one
  // layer and must quarantine, proven by the surviving sibling.
  const subsetRows: readonly (readonly [
    string,
    Record<string, unknown>,
    readonly string[],
  ])[] = [
    [
      "model missing id",
      { supportedReasoningEfforts: ["low"] },
      [],
    ],
    [
      "legacy effort entry missing reasoningEffort",
      { id: "broken-model-id", supportedReasoningEfforts: [{}] },
      ["supportedReasoningEfforts"],
    ],
    [
      "current effort entry missing description",
      {
        id: "broken-model-id",
        model: "model-native",
        displayName: "Current model",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
      ["supportedReasoningEfforts"],
    ],
    [
      "service tier missing name",
      currentFullCatalogModel({
        id: "broken-model-id",
        serviceTiers: [{ id: "priority", description: "Increased speed" }],
      }),
      ["serviceTiers"],
    ],
    [
      "upgradeInfo missing model",
      currentFullCatalogModel({
        id: "broken-model-id",
        upgradeInfo: { upgradeCopy: null },
      }),
      ["upgradeInfo"],
    ],
    [
      "availabilityNux missing message",
      currentFullCatalogModel({ id: "broken-model-id", availabilityNux: {} }),
      ["availabilityNux"],
    ],
  ];
  for (const [label, brokenModel, expectedInvalid] of subsetRows) {
    const { catalog, observation } = await inspectObserved({
      data: [brokenModel, sibling],
      nextCursor: null,
    });
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ["sibling-model-id"],
      label,
    );
    assert.equal(observation.rejections.length, 1, label);
    assert.deepEqual(
      observation.rejections[0]!.invalidValueKeys,
      expectedInvalid,
      label,
    );
  }

  // The page envelope has no quarantine beneath it: losing `data` is fatal.
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { models: [sibling], nextCursor: null },
    }),
  ]);
  await assert.rejects(
    new CodexAdapter(async () => transport).inspect("C:\\synthetic-project"),
    (error) =>
      error instanceof RuntimeAdapterError &&
      error.category === "catalog-invalid",
  );

  // Reclassification, the deliberate subset exception: a full model that
  // LOSES an unconsumed full-only key degrades to the richest smaller
  // recognised shape instead of dying, and the orphaned full-only keys
  // surface as tolerated drift — visible, not silent.
  const degraded = currentFullCatalogModel({ vendorNewKey: true });
  delete (degraded as Record<string, unknown>).multiAgentVersion;
  const reclassified = await inspectObserved({
    data: [degraded],
    nextCursor: null,
  });
  assert.deepEqual(
    reclassified.catalog.models.map((model) => model.id),
    ["future-model-id"],
  );
  assert.deepEqual(reclassified.observation.rejections, []);
  assert.deepEqual(reclassified.observation.toleratedKeys, [
    "additionalSpeedTiers",
    "availabilityNux",
    "defaultReasoningEffort",
    "defaultServiceTier",
    "description",
    "hidden",
    "inputModalities",
    "isDefault",
    "modelSpecialty",
    "serviceTiers",
    "supportsPersonality",
    "upgrade",
    "upgradeInfo",
    "vendorNewKey",
  ]);
  assert.equal(
    JSON.stringify(reclassified.catalog).includes("vendorNewKey"),
    false,
  );
  assert.equal(
    JSON.stringify(reclassified.catalog).includes("modelSpecialty"),
    false,
  );
});

test("inspect validates every full current model field before dropping metadata", async () => {
  const invalidOverrides = [
    { upgrade: 42 },
    {
      upgradeInfo: {
        model: "future-model-next",
        upgradeCopy: null,
        modelLink: 42,
        migrationMarkdown: null,
      },
    },
    { availabilityNux: { message: 42 } },
    { description: "unsafe\u0000description" },
    { hidden: "false" },
    { defaultReasoningEffort: "" },
    // `F110` round 2, A.2: an unknown modality VALUE ("video") is tolerated —
    // no consumer reads the list. What still fails is genuinely unusable
    // data: a non-string, an unsafe string, a duplicate, an empty list.
    { inputModalities: [42] },
    { inputModalities: ["text", "text"] },
    { inputModalities: ["unsafe\u0000modality"] },
    { inputModalities: [] },
    { supportsPersonality: "true" },
    { additionalSpeedTiers: [42] },
    {
      serviceTiers: [
        { id: "priority", name: "Fast", description: 42 },
      ],
    },
    { defaultServiceTier: 42 },
    { isDefault: "true" },
  ] as const;

  for (const override of invalidOverrides) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          data: [currentFullCatalogModel(override)],
          nextCursor: null,
        },
      }),
    ]);

    await assert.rejects(
      new CodexAdapter(async () => transport).inspect("C:\\synthetic-project"),
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "catalog-invalid",
    );
    assert.equal(transport.recordedStopCalls(), 1);
  }
});

test("inspect rejects unsafe cursors before a subsequent model request", async () => {
  for (const nextCursor of [
    "",
    "opaque page 2",
    "opaque\u0000page-2",
    "opaque\u202epage-2",
    "C:/private-cursor",
    "https://provider.invalid/cursor",
    `a${"x".repeat(1_024)}`,
  ] as const) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          data: [{ id: "model-001", supportedReasoningEfforts: ["low"] }],
          nextCursor,
        },
      }),
    ]);
    const adapter = new CodexAdapter(async () => transport);

    await assert.rejects(
      adapter.inspect("C:\\synthetic-project"),
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "catalog-invalid",
    );
    assert.deepEqual(
      transport.recordedOutboundJsonl()
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
        .filter((message) => message.method === "model/list")
        .map((message) => message.params),
      [{}],
    );
    assert.equal(transport.recordedStopCalls(), 1);
  }
});

test("inspect rejects hostile catalog records and arrays without evaluating accessors", async () => {
  const legacyModel = Object.freeze({
    id: "model-001",
    supportedReasoningEfforts: Object.freeze(["low"]),
  });
  let accessorReads = 0;
  const accessorPage = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperties(accessorPage, {
    data: {
      enumerable: true,
      get() {
        accessorReads += 1;
        return [legacyModel];
      },
    },
    nextCursor: { enumerable: true, value: null },
  });
  const hiddenExtraPage = {
    data: [legacyModel],
    nextCursor: null,
  } as Record<PropertyKey, unknown>;
  Object.defineProperty(hiddenExtraPage, "hidden", { value: true });
  const symbolExtraPage = {
    data: [legacyModel],
    nextCursor: null,
    [Symbol("extra")]: true,
  };
  const arrayWithExtra = [legacyModel] as Array<unknown> & { extra?: boolean };
  arrayWithExtra.extra = true;
  const sparseData = [legacyModel] as unknown[];
  sparseData.length = 2;
  const accessorModel = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperties(accessorModel, {
    id: {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "model-001";
      },
    },
    supportedReasoningEfforts: { enumerable: true, value: ["low"] },
  });
  const accessorEffort = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperties(accessorEffort, {
    description: { enumerable: true, value: "Low" },
    reasoningEffort: {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "low";
      },
    },
  });
  const currentModel = (efforts: unknown) => ({
    id: "model-001",
    model: "model-native",
    displayName: "Current model",
    supportedReasoningEfforts: efforts,
  });
  const effortsWithExtra = [
    { reasoningEffort: "low", description: "Low" },
  ] as Array<unknown> & { extra?: boolean };
  effortsWithExtra.extra = true;
  const sparseEfforts = [
    { reasoningEffort: "low", description: "Low" },
  ] as unknown[];
  sparseEfforts.length = 2;
  const hostilePages = [
    accessorPage,
    new Proxy({ data: [legacyModel], nextCursor: null }, {}),
    hiddenExtraPage,
    symbolExtraPage,
    { data: arrayWithExtra, nextCursor: null },
    { data: sparseData, nextCursor: null },
    { data: new Proxy([legacyModel], {}), nextCursor: null },
    { data: [new Proxy(legacyModel, {})], nextCursor: null },
    { data: [accessorModel], nextCursor: null },
    {
      data: [
        currentModel([
          new Proxy({ reasoningEffort: "low", description: "Low" }, {}),
        ]),
      ],
      nextCursor: null,
    },
    { data: [currentModel([accessorEffort])], nextCursor: null },
    {
      data: [
        currentModel(
          new Proxy([{ reasoningEffort: "low", description: "Low" }], {}),
        ),
      ],
      nextCursor: null,
    },
    { data: [currentModel(effortsWithExtra)], nextCursor: null },
    { data: [currentModel(sparseEfforts)], nextCursor: null },
  ] as const;

  for (const page of hostilePages) {
    const { error, transport } = await inspectWithInjectedCatalogPage(page);
    assert.equal(
      error instanceof RuntimeAdapterError ? error.category : undefined,
      "catalog-invalid",
    );
    assert.equal(transport.recordedStopCalls(), 1);
  }
  assert.equal(accessorReads, 0);
});

test("inspect rejects missing, malformed, and oversized nested catalog values", async () => {
  const invalidModels: readonly unknown[] = [
    { id: "model-001" },
    { id: "x".repeat(241), supportedReasoningEfforts: ["low"] },
    { id: " model-001", supportedReasoningEfforts: ["low"] },
    { id: "model-001", supportedReasoningEfforts: ["low\u0000"] },
    { id: "model-001", supportedReasoningEfforts: ["x".repeat(121)] },
    {
      id: "model-001",
      supportedReasoningEfforts: Array.from({ length: 1_001 }, (_, index) =>
        `effort-${index}`,
      ),
    },
    {
      id: "model-001",
      model: "x".repeat(241),
      displayName: "Current model",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
      ],
    },
    {
      id: "model-001",
      model: "model-native",
      displayName: "x".repeat(201),
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
      ],
    },
    {
      id: "model-001",
      model: "model-native",
      displayName: "Current model",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    },
    {
      id: "model-001",
      model: "model-native",
      displayName: "Current model",
      supportedReasoningEfforts: [
        { reasoningEffort: "x".repeat(121), description: "Low" },
      ],
    },
    {
      id: "model-001",
      model: "model-native",
      displayName: "Current model",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "x".repeat(121) },
      ],
    },
    {
      id: "model-001",
      model: "model-native",
      displayName: "Current model",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "unsafe\u202edescription" },
      ],
    },
  ];

  for (const model of invalidModels) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { data: [model], nextCursor: null },
      }),
    ]);

    await assert.rejects(
      new CodexAdapter(async () => transport).inspect("C:\\synthetic-project"),
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "catalog-invalid",
    );
    assert.equal(transport.recordedStopCalls(), 1);
  }
});

test("inspect bounds the complete two-page catalog and exposes no oversized partial result", async () => {
  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    id: `model-${index}`,
    supportedReasoningEfforts: ["low"],
  }));
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { data: firstPage, nextCursor: "page-2" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        data: [{ id: "model-1000", supportedReasoningEfforts: ["low"] }],
        nextCursor: null,
      },
    }),
  ]);
  const adapter = new CodexAdapter(async () => transport);
  let observedCatalog: unknown;

  await assert.rejects(
    adapter.inspect("C:\\synthetic-project").then((catalog) => {
      observedCatalog = catalog;
    }),
    (error) =>
      error instanceof RuntimeAdapterError && error.category === "catalog-invalid",
  );

  assert.equal(observedCatalog, undefined);
  assert.equal(
    transport.recordedOutboundJsonl().filter((line) => {
      const message = JSON.parse(line) as { readonly method?: string };
      return message.method === "model/list";
    }).length,
    2,
  );
});

test("a cross-model defect on page one stops the read before its cursor is followed", async () => {
  // Per-model defects quarantine and pagination continues (proven below);
  // what still stops the read cold, before another request leaves the
  // machine, is a defect no single model owns — here, a duplicated model id.
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          { id: "model-001", supportedReasoningEfforts: ["low"] },
          { id: "model-001", supportedReasoningEfforts: ["high"] },
        ],
        nextCursor: "page-2",
      },
    }),
  ]);

  await assert.rejects(
    new CodexAdapter(async () => transport).inspect("C:\\synthetic-project"),
    (error) =>
      error instanceof RuntimeAdapterError && error.category === "catalog-invalid",
  );
  assert.equal(
    transport.recordedOutboundJsonl().filter((line) => {
      const message = JSON.parse(line) as { readonly method?: string };
      return message.method === "model/list";
    }).length,
    1,
  );
});

test("a quarantined model on page one does not stop pagination", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        // Duplicate Efforts inside ONE model are that model's own defect:
        // quarantined, while the read carries on to the next page.
        data: [{ id: "model-001", supportedReasoningEfforts: ["low", "low"] }],
        nextCursor: "opaque-page-2",
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        data: [{ id: "model-002", supportedReasoningEfforts: ["low"] }],
        nextCursor: null,
      },
    }),
  ]);
  const observations: CodexCatalogObservation[] = [];

  const catalog = await new CodexAdapter(
    async () => transport,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("C:\\synthetic-project");

  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["model-002"],
  );
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]!.rejections, [
    {
      modelId: "model-001",
      unknownKeys: [],
      missingKeys: [],
      invalidValueKeys: ["supportedReasoningEfforts"],
    },
  ]);
  assert.deepEqual(
    transport.recordedOutboundJsonl()
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
      .filter((message) => message.method === "model/list")
      .map((message) => message.params),
    [{}, { cursor: "opaque-page-2" }],
  );
  assert.equal(transport.recordedStopCalls(), 1);
});

test("inspect rejects repeated page-two state without exposing page one", async () => {
  // A page-two envelope key or model key is additive vendor drift and is now
  // tolerated (proven in the layer-tolerance matrix). What stays fatal here
  // is progress the vendor cannot demonstrate: a cursor that repeats.
  const invalidSecondPages = [
    {
      data: [{ id: "model-002", supportedReasoningEfforts: ["low"] }],
      nextCursor: "opaque-page-2",
    },
  ] as const;

  for (const secondPage of invalidSecondPages) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: {
          data: [{ id: "model-001", supportedReasoningEfforts: ["low"] }],
          nextCursor: "opaque-page-2",
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, result: secondPage }),
    ]);
    const adapter = new CodexAdapter(async () => transport);
    let observedCatalog: unknown;

    await assert.rejects(
      adapter.inspect("C:\\synthetic-project").then((catalog) => {
        observedCatalog = catalog;
      }),
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "catalog-invalid",
    );
    assert.equal(observedCatalog, undefined);
    assert.deepEqual(
      transport.recordedOutboundJsonl()
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
        .filter((message) => message.method === "model/list")
        .map((message) => message.params),
      [{}, { cursor: "opaque-page-2" }],
    );
  }
});

test("inspect fails closed unless the Codex account is a ChatGPT subscription", async () => {
  for (const [account, category] of [
    [{ type: "apiKey" }, "authentication-required"],
    [{ type: "synthetic" }, "protocol-invalid"],
    [{}, "protocol-invalid"],
    [{ type: 42 }, "protocol-invalid"],
  ] as const) {
    const transport = new ScriptedTransport([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { server: "synthetic" },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { account, requiresOpenaiAuth: true },
      }),
    ]);
    const adapter = new CodexAdapter(async () => transport);

    await assert.rejects(adapter.inspect("C:\\synthetic-project"), (error) =>
      error instanceof RuntimeAdapterError &&
      error.category === category,
    );
    assert.deepEqual(
      transport.recordedOutboundJsonl().map(
        (line) => (JSON.parse(line) as { readonly method: string }).method,
      ),
      ["initialize", "initialized", "account/read"],
    );
    assert.equal(transport.recordedStopCalls(), 1);
  }
});

test("inspect follows every opaque model cursor and returns more than one hundred models", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `model-${String(index + 1).padStart(3, "0")}`,
    supportedReasoningEfforts: ["low"],
  }));
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { data: firstPage, nextCursor: "opaque-page-2" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        data: [{ id: "model-101", supportedReasoningEfforts: ["low"] }],
        nextCursor: null,
      },
    }),
  ]);
  const adapter = new CodexAdapter(async () => transport);

  const catalog = await adapter.inspect("C:\\synthetic-project");

  assert.equal(catalog.models.length, 101);
  assert.equal(catalog.models[0]?.id, "model-001");
  assert.equal(catalog.models[100]?.id, "model-101");
  assert.deepEqual(
    transport.recordedOutboundJsonl()
      .map((line) => JSON.parse(line) as { method: string; params: unknown })
      .filter((message) => message.method === "model/list")
      .map((message) => message.params),
    [{}, { cursor: "opaque-page-2" }],
  );
  assert.equal(transport.recordedStopCalls(), 1);
});

test("inspect follows a continuation after page two and returns the complete catalog", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [{ id: "model-001", supportedReasoningEfforts: ["low"] }],
        nextCursor: "opaque-page-2",
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        data: [{ id: "model-002", supportedReasoningEfforts: ["low"] }],
        nextCursor: "opaque-page-3",
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: {
        data: [{ id: "model-003", supportedReasoningEfforts: ["low"] }],
        nextCursor: null,
      },
    }),
  ]);
  const adapter = new CodexAdapter(async () => transport);

  const catalog = await adapter.inspect("C:\\synthetic-project");

  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["model-001", "model-002", "model-003"],
  );
  assert.deepEqual(
    transport.recordedOutboundJsonl()
      .map((line) => JSON.parse(line) as { method: string; params: unknown })
      .filter((message) => message.method === "model/list")
      .map((message) => message.params),
    [
      {},
      { cursor: "opaque-page-2" },
      { cursor: "opaque-page-3" },
    ],
  );
  assert.equal(transport.recordedStopCalls(), 1);
});

test("the Agent Runtime seam preserves the fixed Runtime-not-located category for inspect, start, and resume", async () => {
  const adapter = new CodexAdapter(async () => {
    throw new RuntimeAdapterError("runtime-not-located");
  });
  const actions = [
    () => adapter.inspect("C:\\synthetic-project"),
    () =>
      adapter.start({
        projectDirectory: "C:\\synthetic-project",
        profile: requestedProfile,
      }),
    () =>
      adapter.resume({
        projectDirectory: "C:\\synthetic-project",
        profile: requestedProfile,
        opaqueSessionReference: "opaque-session-reference",
      }),
  ];

  for (const action of actions) {
    await assert.rejects(action(), (error) => {
      return (
        error instanceof RuntimeAdapterError &&
        error.category === "runtime-not-located" &&
        !error.stack?.includes("synthetic-project")
      );
    });
  }
});

test("construction and inspection remain inert to Agent Session work", async () => {
  const transport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/catalog-success.jsonl", import.meta.url),
  );
  let factoryCalls = 0;
  const adapter = new CodexAdapter(async () => {
    factoryCalls += 1;
    return transport;
  });
  assert.equal(factoryCalls, 0);

  await adapter.inspect("C:\\synthetic-project");

  assert.equal(factoryCalls, 1);
  assert.deepEqual(
    transport.recordedOutboundJsonl().map(
      (line) => (JSON.parse(line) as { method: string }).method,
    ),
    ["initialize", "initialized", "account/read", "model/list"],
  );
  assert.equal(transport.recordedStopCalls(), 1);
});

test("start rejects any unsupported explicit selection without downgrade", async () => {
  for (const profile of [
    { ...requestedProfile, model: "missing-model" },
    { ...requestedProfile, effortLevel: "missing-effort" },
    { ...requestedProfile, executionMode: "missing-execution" },
    { ...requestedProfile, accessMode: "missing-access" },
  ]) {
    await assert.rejects(
      catalogAdapter().start({ projectDirectory: "C:\\synthetic-project", profile }),
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "unsupported-selection",
    );
  }
});

test("start supplies one opaque Session reference without mutating caller values", async () => {
  const profile = Object.freeze({ ...requestedProfile });
  const request = Object.freeze({
    projectDirectory: "C:\\synthetic-project",
    profile,
  });
  const input = Object.freeze({ text: "fixed input" });

  const binding = await fixtureAdapter("single-turn-success.jsonl").start(request);
  assert.equal(
    typeof binding.opaqueSessionReference === "string" &&
      binding.opaqueSessionReference.length > 0,
    true,
  );
  assert.deepEqual(request, {
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });

  await binding.send(input);
  const events = [];
  for await (const event of binding.events()) events.push(event);

  assert.deepEqual(input, { text: "fixed input" });
  assert.equal(JSON.stringify(events).includes(binding.opaqueSessionReference), false);
});

test("a completed Agent Session resumes through a fresh one-input binding", async () => {
  const startTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/single-turn-success.jsonl", import.meta.url),
  );
  const resumeTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
  );
  const transports = [startTransport, resumeTransport];
  const adapter = new CodexAdapter(async () => {
    const transport = transports.shift();
    assert.equal(transport !== undefined, true);
    return transport as ScriptedTransport;
  });

  const started = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await started.send({ text: "fixed input" });
  for await (const _event of started.events()) {
    // A completed binding is the public prerequisite for resume.
  }

  const profile = Object.freeze({ ...requestedProfile });
  const request = Object.freeze({
    projectDirectory: "C:\\synthetic-project",
    profile,
    opaqueSessionReference: started.opaqueSessionReference,
  });
  const input = Object.freeze({ text: "fixed input" });
  const resumed = await adapter.resume(request);

  assert.notEqual(resumed, started);
  assert.equal(resumed.opaqueSessionReference === started.opaqueSessionReference, true);
  assert.deepEqual(resumed.profile, requestedProfile);
  assert.deepEqual(request, {
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: started.opaqueSessionReference,
  });

  await resumed.send(input);
  const events = [];
  for await (const event of resumed.events()) events.push(event);

  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "RESUMED_MARKER" },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.deepEqual(input, { text: "fixed input" });
  assert.equal(JSON.stringify(events).includes(resumed.opaqueSessionReference), false);
  assert.equal(startTransport.recordedStopCalls(), 1);
  assert.equal(resumeTransport.recordedStopCalls(), 1);
});

test("Codex interrupts one correlated turn and reports an intentional stopped terminal", async () => {
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        data: [
          {
            id: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
          },
        ],
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      result: {
        thread: { id: "thread-fixed" },
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "thread-fixed" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      result: { turn: { id: "turn-fixed", status: "inProgress" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/started",
      params: {
        threadId: "thread-fixed",
        turn: { id: "turn-fixed", status: "inProgress" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 6, result: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "thread-fixed",
        turn: { id: "turn-fixed", status: "interrupted" },
      },
    }),
  ]);
  const binding = await new CodexAdapter(async () => transport).start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await binding.send({ text: "count slowly" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "session-started" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "turn-started" },
  });
  assert.equal(binding.interruptAvailability?.(), "available");

  const receipt = binding.interrupt?.();
  assert.notEqual(receipt, undefined);
  const stopped = collectIterator(iterator);
  await receipt;

  assert.deepEqual(await stopped, [
    { kind: "turn-interrupted", status: "interrupted" },
  ]);
  assert.deepEqual(
    JSON.parse(transport.recordedOutboundJsonl().at(-1) ?? "null"),
    {
      jsonrpc: "2.0",
      id: 6,
      method: "turn/interrupt",
      params: { threadId: "thread-fixed", turnId: "turn-fixed" },
    },
  );
  assert.equal(binding.interruptAvailability?.(), "unavailable");
  assert.equal(transport.recordedStopCalls(), 1);
});

test("Codex steers the correlated active turn without starting a second turn", async () => {
  const transport = codexSteerTransport({ turnId: "turn-fixed" });
  const binding = await new CodexAdapter(async () => transport).start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await binding.send({ text: "Inspect the migration carefully." });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "session-started" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "turn-started" },
  });
  assert.equal(binding.steerAvailability?.(), "available");

  const accepted = binding.steer?.({ text: "Use the safer migration." });
  assert.notEqual(accepted, undefined);
  assert.equal(binding.steerAvailability?.(), "unavailable");
  const remaining = collectIterator(iterator);
  await accepted;

  assert.deepEqual(await remaining, [
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "GUIDANCE_APPLIED_IN_SAME_TURN" },
    { kind: "turn-completed", status: "completed" },
  ]);
  const outbound = transport.recordedOutboundJsonl().map((line) =>
    JSON.parse(line) as {
      readonly method?: string;
      readonly params?: unknown;
    },
  );
  assert.deepEqual(
    outbound.filter((message) => message.method === "turn/steer"),
    [
      {
        jsonrpc: "2.0",
        id: 6,
        method: "turn/steer",
        params: {
          threadId: "thread-fixed",
          expectedTurnId: "turn-fixed",
          input: [{ type: "text", text: "Use the safer migration." }],
        },
      },
    ],
  );
  assert.equal(
    outbound.filter((message) => message.method === "turn/start").length,
    1,
    "steering must not create a replacement turn",
  );
  assert.equal(binding.steerAvailability?.(), "unavailable");
  assert.equal(transport.recordedStopCalls(), 1);
});

test("Codex rejects every widened or mismatched turn/steer acknowledgement", async () => {
  for (const [name, steerResult] of [
    ["matching id plus extra key", { turnId: "turn-fixed", extra: true }],
    ["mismatched turn id", { turnId: "turn-other" }],
    ["missing turn id", {}],
  ] as const) {
    const transport = codexSteerTransport(steerResult, false);
    const binding = await new CodexAdapter(async () => transport).start({
      projectDirectory: "C:\\synthetic-project",
      profile: requestedProfile,
    });
    await binding.send({ text: "Inspect the migration carefully." });
    const iterator = binding.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();

    const steer = binding.steer?.({ text: "Use the safer migration." });
    assert.notEqual(steer, undefined, name);
    const remaining = collectIterator(iterator);
    await assert.rejects(
      steer!,
      (error) =>
        error instanceof RuntimeAdapterError && error.category === "protocol-invalid",
      name,
    );
    assert.deepEqual(
      await remaining,
      [{ kind: "failed", category: "protocol-invalid" }],
      name,
    );
    assert.equal(transport.recordedStopCalls(), 1, name);
  }
});

test("resume sends the exact closed official-runtime request on its fresh transport", async () => {
  const startTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/single-turn-success.jsonl", import.meta.url),
  );
  const resumeTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
  );
  const transports = [startTransport, resumeTransport];
  const adapter = new CodexAdapter(async () => {
    const transport = transports.shift();
    assert.equal(transport !== undefined, true);
    return transport as ScriptedTransport;
  });

  const started = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await started.send({ text: "fixed input" });
  for await (const _event of started.events()) {
    // Complete the source Agent Session before opening the fresh transport.
  }

  const resumed = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: started.opaqueSessionReference,
  });
  await resumed.send({ text: "fixed input" });
  for await (const _event of resumed.events()) {
    // Complete the resumed binding so request capture includes owned shutdown.
  }

  const outbound = resumeTransport.recordedOutboundJsonl().map((line) =>
    JSON.parse(line) as { method: string; params: Record<string, unknown> },
  );
  assert.deepEqual(
    outbound.map((message) => message.method),
    ["initialize", "initialized", "account/read", "thread/resume", "turn/start"],
  );
  const resumeRequest = outbound[3];
  assert.equal(resumeRequest?.method, "thread/resume");
  assert.deepEqual(Object.keys(resumeRequest?.params ?? {}).sort(), [
    "approvalPolicy",
    "config",
    "excludeTurns",
    "model",
    "sandbox",
    "threadId",
  ]);
  assert.equal(
    resumeRequest?.params.threadId === started.opaqueSessionReference,
    true,
  );
  assert.equal(resumeRequest?.params.excludeTurns, true);
  assert.equal(resumeRequest?.params.model, "gpt-5.6-sol");
  assert.deepEqual(resumeRequest?.params.config, { model_reasoning_effort: "ultra" });
  assert.equal(resumeRequest?.params.approvalPolicy, "never");
  assert.equal(resumeRequest?.params.sandbox, "danger-full-access");
  assert.equal(transports.length, 0);
});

test("resume accepts the current official-runtime response shape", async () => {
  const contents = await readFile(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
    "utf8",
  );
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  lines[2] = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: currentOfficialResumeResult("thread-fixed"),
  });
  const transport = new ScriptedTransport(lines);
  const adapter = new CodexAdapter(async () => transport);

  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);

  assert.deepEqual(binding.profile, requestedProfile);
  assert.equal(binding.opaqueSessionReference, "thread-fixed");
  assert.deepEqual(events.at(-2), { kind: "agent-message", text: "RESUMED_MARKER" });
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
  assert.equal(transport.recordedStopCalls(), 1);
});

test("resume accepts the 0.151 thread shape whose one admitted addition is projectId (F220)", async () => {
  // Measured from a live `thread/resume` reply on codex-cli 0.151.0-alpha.7.1
  // (worker 468): the result envelope is unchanged and the thread object
  // carries exactly one key the previous generation did not, `projectId`.
  const contents = await readFile(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
    "utf8",
  );
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  const result = currentOfficialResumeResult("thread-fixed");
  lines[2] = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: {
      ...result,
      thread: { ...result.thread, projectId: null },
    },
  });
  const transport = new ScriptedTransport(lines);
  const adapter = new CodexAdapter(async () => transport);

  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);

  assert.deepEqual(binding.profile, requestedProfile);
  assert.equal(binding.opaqueSessionReference, "thread-fixed");
  assert.deepEqual(events.at(-2), { kind: "agent-message", text: "RESUMED_MARKER" });
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
  assert.equal(transport.recordedStopCalls(), 1);

  // The matching adversarial row (rule 1): the admitted key does not open the
  // thread to arbitrary additions — a 0.151-shaped thread with one more
  // native field still rejects exactly.
  const adversarialTransport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: { account: { type: "chatgpt" } } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        ...result,
        thread: { ...result.thread, projectId: null, nativeExtra: true },
      },
    }),
  ]);
  const adversarialAdapter = new CodexAdapter(async () => adversarialTransport);
  await assert.rejects(
    adversarialAdapter.resume({
      projectDirectory: "C:\\synthetic-project",
      profile: requestedProfile,
      opaqueSessionReference: "thread-fixed",
    }),
    (error) =>
      error instanceof RuntimeAdapterError &&
      error.category === "protocol-invalid",
  );
  assert.equal(adversarialTransport.recordedStopCalls(), 1);
});

test("resume applies a changed model and effort to one native thread and reports that exact effective profile", async () => {
  const changedProfile = Object.freeze({
    model: "gpt-5.5-codex",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const contents = await readFile(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
    "utf8",
  );
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  const nativeResume = JSON.parse(lines[2]!) as {
    readonly jsonrpc: string;
    readonly id: number;
    readonly result: Record<string, unknown>;
  };
  lines[2] = JSON.stringify({
    ...nativeResume,
    result: {
      ...nativeResume.result,
      model: changedProfile.model,
      reasoningEffort: changedProfile.effortLevel,
    },
  });
  const transport = new ScriptedTransport(lines);
  const adapter = new CodexAdapter(async () => transport);

  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: changedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);

  const outbound = transport.recordedOutboundJsonl().map((line) =>
    JSON.parse(line) as { readonly method: string; readonly params: Record<string, unknown> },
  );
  assert.deepEqual(outbound[3]?.params, {
    threadId: "thread-fixed",
    excludeTurns: true,
    model: changedProfile.model,
    config: { model_reasoning_effort: changedProfile.effortLevel },
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.deepEqual(outbound[4]?.params, {
    threadId: "thread-fixed",
    input: [{ type: "text", text: "fixed input" }],
    model: changedProfile.model,
    effort: changedProfile.effortLevel,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.equal(events.at(-1)?.kind, "turn-completed");
  assert.deepEqual(binding.effectiveProfile?.(), changedProfile);
});

test("resume normalizes a Chinese current Runtime lifecycle that omits thread/started", async () => {
  const exactInput = "用中文回答一下试试";
  const exactResponse = "中文续轮成功";
  const contents = await readFile(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
    "utf8",
  );
  const lines = contents
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.replace("RESUMED_MARKER", exactResponse));
  lines[2] = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: currentOfficialResumeResult("thread-fixed"),
  });
  const withoutResumedThreadStarted = lines.filter((line) => {
    const message = JSON.parse(line) as {
      readonly method?: string;
      readonly params?: { readonly thread?: { readonly id?: string } };
    };
    return !(
      message.method === "thread/started" &&
      message.params?.thread?.id === "thread-fixed"
    );
  });
  const transport = new ScriptedTransport(withoutResumedThreadStarted);
  const adapter = new CodexAdapter(async () => transport);

  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: exactInput });
  const events = [];
  for await (const event of binding.events()) events.push(event);

  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: exactResponse },
    { kind: "turn-completed", status: "completed" },
  ]);
  const turnStart = transport
    .recordedOutboundJsonl()
    .map((line) => JSON.parse(line) as { readonly method?: string; readonly params?: unknown })
    .find((message) => message.method === "turn/start");
  assert.deepEqual(turnStart?.params, {
    threadId: "thread-fixed",
    input: [{ type: "text", text: exactInput }],
    model: "gpt-5.6-sol",
    effort: "ultra",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
  assert.equal(transport.recordedStopCalls(), 1);
});

test("resume rejects malformed or unsupported requests before transport creation", async () => {
  const validRequest = {
    projectDirectory: "C:\\synthetic-project",
    profile: { ...requestedProfile },
    opaqueSessionReference: "opaque-synthetic-reference",
  };
  const invalidRequests: unknown[] = [
    undefined,
    null,
    {},
    { ...validRequest, projectDirectory: "" },
    { ...validRequest, projectDirectory: "   " },
    { ...validRequest, opaqueSessionReference: "" },
    { ...validRequest, opaqueSessionReference: "   " },
    { ...validRequest, profile: null },
    { ...validRequest, profile: { ...requestedProfile, model: "" } },
    { ...validRequest, profile: { ...requestedProfile, effortLevel: "" } },
    { ...validRequest, nativeExtra: true },
    { ...validRequest, profile: { ...requestedProfile, nativeExtra: true } },
  ];

  for (const request of invalidRequests) {
    let factoryCalls = 0;
    const adapter = new CodexAdapter(async () => {
      factoryCalls += 1;
      return new ScriptedTransport([]);
    });
    await assert.rejects(adapter.resume(request as RuntimeResume), (error) => {
      if (!(error instanceof RuntimeAdapterError)) return false;
      return (
        error.category === "invalid-input" &&
        error.message === "Agent Runtime operation failed." &&
        error.stack === "RuntimeAdapterError: Agent Runtime operation failed."
      );
    });
    assert.equal(factoryCalls, 0);
  }

  for (const profile of [
    { ...requestedProfile, executionMode: "multi-agent" },
    { ...requestedProfile, accessMode: "sandboxed" },
  ]) {
    let factoryCalls = 0;
    const adapter = new CodexAdapter(async () => {
      factoryCalls += 1;
      return new ScriptedTransport([]);
    });
    await assert.rejects(
      adapter.resume({ ...validRequest, profile }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.category === "unsupported-selection" &&
        error.message === "Agent Runtime operation failed.",
    );
    assert.equal(factoryCalls, 0);
  }
});

test("resume rejects invalid native results through fixed categories and stops", async () => {
  const opaqueReference = "opaque-synthetic-reference";
  const validResult = {
    thread: { id: opaqueReference },
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
  };
  const cases = [
    {
      response: { jsonrpc: "2.0", id: 3 },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, thread: { id: "" } },
      },
      category: "correlation-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, thread: { id: "opaque-other-reference" } },
      },
      category: "correlation-invalid",
    },
    {
      response: { jsonrpc: "2.0", id: 3, result: [] },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          thread: { id: opaqueReference },
          reasoningEffort: "ultra",
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
        },
      },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, model: "unsupported-model" },
      },
      category: "unsupported-selection",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, reasoningEffort: "unsupported-effort" },
      },
      category: "unsupported-selection",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, approvalPolicy: "unsupported-policy" },
      },
      category: "unsupported-selection",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, sandbox: { type: "unsupported-sandbox" } },
      },
      category: "unsupported-selection",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, sandbox: null },
      },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, nativeExtra: true },
      },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...validResult, thread: { id: opaqueReference, nativeExtra: true } },
      },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          ...validResult,
          sandbox: { type: "dangerFullAccess", nativeExtra: true },
        },
      },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: { ...currentOfficialResumeResult(opaqueReference), nativeExtra: true },
      },
      category: "protocol-invalid",
    },
    {
      response: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          ...currentOfficialResumeResult(opaqueReference),
          thread: {
            ...currentOfficialResumeResult(opaqueReference).thread,
            nativeExtra: true,
          },
        },
      },
      category: "protocol-invalid",
    },
  ] as const;

  for (const fixture of cases) {
    const transport = new ScriptedTransport([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result: { account: { type: "chatgpt" } } }),
      JSON.stringify(fixture.response),
    ]);
    const adapter = new CodexAdapter(async () => transport);
    const request = Object.freeze({
      projectDirectory: "C:\\synthetic-project",
      profile: Object.freeze({ ...requestedProfile }),
      opaqueSessionReference: opaqueReference,
    });
    const requestSnapshot = JSON.stringify(request);

    await assert.rejects(adapter.resume(request), (error) => {
      if (!(error instanceof RuntimeAdapterError)) return false;
      const publicShape = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
      return (
        error.category === fixture.category &&
        error.message === "Agent Runtime operation failed." &&
        !publicShape.includes(opaqueReference) &&
        !publicShape.includes("nativeExtra") &&
        !publicShape.includes("unsupported-model") &&
        !publicShape.includes("unsupported-effort") &&
        !publicShape.includes("unsupported-policy") &&
        !publicShape.includes("unsupported-sandbox")
      );
    });
    assert.equal(transport.recordedStopCalls(), 1);
    assert.equal(JSON.stringify(request) === requestSnapshot, true);
  }
});

test("resumed lifecycle rejects mismatched, incomplete, failed, or approval events", async () => {
  for (const [fixture, category] of [
    ["resume-mismatched-turn.jsonl", "correlation-invalid"],
    ["resume-missing-terminal.jsonl", "correlation-invalid"],
    ["resume-turn-failed.jsonl", "turn-failed"],
    ["resume-approval-request.jsonl", "approval-required"],
  ] as const) {
    const { binding, events, transport } = await resumeAndObserve(fixture);
    assert.deepEqual(events.at(-1), { kind: "failed", category });
    assert.equal(
      events.filter(
        (event) => event.kind === "failed" || event.kind === "turn-completed",
      ).length,
      1,
    );
    assert.equal(JSON.stringify(events).includes(binding.opaqueSessionReference), false);
    assert.equal(transport.recordedStopCalls(), 1);
  }
});

test("a resumed binding permits one input and one event consumer", async () => {
  const secondSendTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
  );
  const secondSendBinding = await new CodexAdapter(async () => secondSendTransport).resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await secondSendBinding.send({ text: "fixed input" });
  await assert.rejects(secondSendBinding.send({ text: "second input" }), (error) => {
    if (!(error instanceof RuntimeAdapterError)) return false;
    return (
      error.category === "invalid-input" &&
      !`${error.message}\n${error.stack}`.includes(secondSendBinding.opaqueSessionReference)
    );
  });
  assert.equal(secondSendTransport.recordedStopCalls(), 1);

  const noInputTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
  );
  const noInputBinding = await new CodexAdapter(async () => noInputTransport).resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  const noInputEvents = [];
  for await (const event of noInputBinding.events()) noInputEvents.push(event);
  assert.deepEqual(noInputEvents, [{ kind: "failed", category: "invalid-input" }]);
  assert.equal(noInputTransport.recordedStopCalls(), 1);

  const secondConsumerTransport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
  );
  const secondConsumerBinding = await new CodexAdapter(
    async () => secondConsumerTransport,
  ).resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await secondConsumerBinding.send({ text: "fixed input" });
  for await (const _event of secondConsumerBinding.events()) {
    // Consume the one allowed event stream.
  }
  const secondConsumerEvents = [];
  for await (const event of secondConsumerBinding.events()) secondConsumerEvents.push(event);
  assert.deepEqual(secondConsumerEvents, [
    { kind: "failed", category: "invalid-input" },
  ]);
  assert.equal(secondConsumerTransport.recordedStopCalls(), 1);
});

test("a resumed binding rejects malformed input and shuts down", async () => {
  for (const input of [
    undefined,
    null,
    {},
    { text: 1 },
    { text: "" },
    { text: "   " },
    { text: "fixed input", nativeExtra: true },
  ]) {
    const transport = await ScriptedTransport.fromFixture(
      new URL("./fixtures/resume-success.jsonl", import.meta.url),
    );
    const binding = await new CodexAdapter(async () => transport).resume({
      projectDirectory: "C:\\synthetic-project",
      profile: requestedProfile,
      opaqueSessionReference: "thread-fixed",
    });

    await assert.rejects(binding.send(input as RuntimeInput), (error) => {
      if (!(error instanceof RuntimeAdapterError)) return false;
      return (
        error.category === "invalid-input" &&
        error.message === "Agent Runtime operation failed." &&
        error.stack === "RuntimeAdapterError: Agent Runtime operation failed."
      );
    });
    assert.equal(transport.recordedStopCalls(), 1);
  }
});

test("abandoning resumed event iteration shuts down its fresh transport", async () => {
  const transport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
  );
  const binding = await new CodexAdapter(async () => transport).resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: "fixed input" });

  const iterator = binding.events()[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.deepEqual(first, { done: false, value: { kind: "session-started" } });
  assert.equal(JSON.stringify(first).includes(binding.opaqueSessionReference), false);
  assert.equal(typeof iterator.return, "function");
  await iterator.return?.();
  assert.equal(transport.recordedStopCalls(), 1);
});

test("resumed shutdown failure exposes only its fixed terminal category", async () => {
  const shutdownSentinel = "private-shutdown-sentinel";
  const transport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/resume-success.jsonl", import.meta.url),
    shutdownSentinel,
  );
  const binding = await new CodexAdapter(async () => transport).resume({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
    opaqueSessionReference: "thread-fixed",
  });
  await binding.send({ text: "fixed input" });

  const events = [];
  for await (const event of binding.events()) events.push(event);
  const publicOutput = JSON.stringify(events);
  assert.deepEqual(events.at(-1), { kind: "failed", category: "runtime-shutdown" });
  assert.equal(publicOutput.includes(binding.opaqueSessionReference), false);
  assert.equal(publicOutput.includes(shutdownSentinel), false);
  assert.equal(transport.recordedStopCalls(), 1);
});

test("start preserves the independent Session Profile and streams one correlated completion", async () => {
  const adapter = new CodexAdapter(() =>
    ScriptedTransport.fromFixture(
      new URL("./fixtures/single-turn-success.jsonl", import.meta.url),
    ),
  );

  const binding = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  assert.deepEqual(binding.profile, requestedProfile);

  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);

  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "FIXED_MARKER" },
    { kind: "turn-completed", status: "completed" },
  ]);
});

test("Codex carries the latest active context rather than accumulated Session usage", async () => {
  const laterUsage = {
    ...tokenUsage,
    total: { ...tokenCounts, totalTokens: 400_000 },
    last: {
      ...tokenUsage.last,
      totalTokens: 140,
    },
    modelContextWindow: 258_400,
  };
  const { events, transport } = await observeTokenUsage([tokenUsage, laterUsage]);

  assert.deepEqual(events.at(-1), {
    kind: "turn-completed",
    status: "completed",
    context: {
      basis: "active-context",
      usedTokens: 140,
      windowTokens: 258_400,
    },
  });
  assert.equal(transport.recordedStopCalls(), 1);
});

test("Codex token usage fails closed on every invalid context row", async () => {
  const adversarial = [
    {
      name: "negative count",
      value: { ...tokenUsage, total: { ...tokenCounts, totalTokens: -1 } },
    },
    {
      name: "non-integer count",
      value: { ...tokenUsage, total: { ...tokenCounts, totalTokens: 1.5 } },
    },
    {
      name: "negative active-context count",
      value: { ...tokenUsage, last: { ...tokenUsage.last, totalTokens: -1 } },
    },
    {
      name: "non-integer active-context count",
      value: { ...tokenUsage, last: { ...tokenUsage.last, totalTokens: 1.5 } },
    },
    {
      name: "unrecognized accumulated-count key",
      value: { ...tokenUsage, total: { ...tokenCounts, nativeExtra: 1 } },
    },
    {
      name: "unrecognized active-context key",
      value: { ...tokenUsage, last: { ...tokenUsage.last, nativeExtra: 1 } },
    },
    {
      name: "window smaller than active context",
      value: {
        ...tokenUsage,
        last: { ...tokenUsage.last, totalTokens: 121 },
        modelContextWindow: 120,
      },
    },
    {
      name: "window present but not a number",
      value: { ...tokenUsage, modelContextWindow: "258400" },
    },
    {
      name: "unrecognized extra key",
      value: { ...tokenUsage, futureProviderField: 1 },
    },
  ];

  for (const row of adversarial) {
    const { events, transport } = await observeTokenUsage([row.value]);
    assert.deepEqual(
      events.at(-1),
      { kind: "failed", category: "protocol-invalid" },
      row.name,
    );
    assert.equal(
      events.some((event) => event.kind === "turn-completed"),
      false,
      row.name,
    );
    assert.equal(transport.recordedStopCalls(), 1, row.name);
  }
});

test("the official-runtime Seam receives the ordered normalized-to-native request shapes", async () => {
  const transport = await ScriptedTransport.fromFixture(
    new URL("./fixtures/single-turn-success.jsonl", import.meta.url),
  );
  const adapter = new CodexAdapter(async () => transport);
  const binding = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  assert.equal(binding.profile.executionMode, "single-agent");
  assert.equal(binding.profile.accessMode, "full-access");
  await binding.send({ text: "fixed input" });
  for await (const _event of binding.events()) {
    // Consume the bounded Agent Session so the Adapter owns complete shutdown.
  }

  const outbound = transport.recordedOutboundJsonl().map((line) => {
    const message = JSON.parse(line) as { method: string; params: unknown };
    return { method: message.method, params: message.params };
  });
  assert.equal(outbound.length, 6);
  assert.deepEqual(outbound, [
    {
      method: "initialize",
      params: {
        clientInfo: {
          name: "unified-agent-workbench",
          title: "Synchronized Intellect Network",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    },
    { method: "initialized", params: {} },
    { method: "account/read", params: { refreshToken: false } },
    { method: "model/list", params: {} },
    {
      method: "thread/start",
      params: {
        cwd: "C:\\synthetic-project",
        model: "gpt-5.6-sol",
        config: { model_reasoning_effort: "ultra" },
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: false,
      },
    },
    {
      method: "turn/start",
      params: {
        threadId: "thread-fixed",
        input: [{ type: "text", text: "fixed input" }],
        model: "gpt-5.6-sol",
        effort: "ultra",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  ]);
});

test("a stream missing terminal correlation fails with one fixed category", async () => {
  const events = await startAndObserve("missing-terminal.jsonl");
  assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
});

test("malformed input, approval, and an unexpected server request fail closed", async () => {
  for (const [fixture, category] of [
    ["malformed-stream.jsonl", "protocol-invalid"],
    ["approval-request.jsonl", "approval-required"],
    ["unexpected-request.jsonl", "unexpected-server-request"],
  ] as const) {
    const events = await startAndObserve(fixture);
    assert.deepEqual(events.at(-1), { kind: "failed", category });
  }
});

test("a lifecycle event missing a correlation field fails closed", async () => {
  const events = await startAndObserve("missing-correlation.jsonl");
  assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
});

test("a target-session lifecycle event with a mismatched turn fails closed", async () => {
  const events = await startAndObserve("mismatched-turn.jsonl");
  assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
});

test("a native error is rejected without retaining its body", async () => {
  const binding = await fixtureAdapter("native-error.jsonl").start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });

  await assert.rejects(binding.send({ text: "fixed input" }), (error) => {
    if (!(error instanceof RuntimeAdapterError)) return false;
    const publicShape = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
    return error.category === "protocol-rejected" && !publicShape.includes("NATIVE_BODY_SENTINEL");
  });
});

test("shutdown failure exposes neither a path nor an opaque identifier", async () => {
  const privateSentinel = "C:\\private\\opaque-session-1234";
  const adapter = new CodexAdapter(() =>
    ScriptedTransport.fromFixture(
      new URL("./fixtures/single-turn-success.jsonl", import.meta.url),
      privateSentinel,
    ),
  );
  const binding = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: requestedProfile,
  });
  await binding.send({ text: "fixed input" });

  const events = [];
  for await (const event of binding.events()) events.push(event);
  const publicOutput = JSON.stringify(events);
  assert.deepEqual(events.at(-1), { kind: "failed", category: "runtime-shutdown" });
  assert.equal(publicOutput.includes(privateSentinel), false);
  assert.equal(publicOutput.includes("thread-fixed"), false);
  assert.equal(publicOutput.includes("turn-fixed"), false);
  assert.equal(publicOutput.includes("item-fixed"), false);
});
