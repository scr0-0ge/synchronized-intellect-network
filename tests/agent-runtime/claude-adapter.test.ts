import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RuntimeAdapterError,
  type ResumableAgentRuntimeAdapter,
} from "../../src/agent-runtime/index.ts";
import {
  ClaudeAdapter,
  formatClaudeCatalogDriftDiagnostic,
  type ClaudeCatalogObservation,
  type ClaudeSessionCapabilityStore,
  type PersistedClaudeSessionCapability,
} from "../../src/agent-runtime/claude/adapter.ts";
import { ClaudeDiagnosticError } from "../../src/agent-runtime/claude/diagnostics.ts";
import type {
  ClaudeCatalogTransport,
  ClaudePermissionMode,
  ClaudeSessionTransportRequest,
  ClaudeToolPermissionRequest,
} from "../../src/agent-runtime/claude/transport.ts";
import type {
  ProviderOperationKind,
  ProviderRequestBudget,
} from "../../src/agent-runtime/provider-request-budget.ts";
import { discoverRuntimeEndpointComposition } from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import { locateClaudeRuntimeForThisTestFile } from "../helpers/vendor-cli-presence.ts";

// The claude-api endpoint's discovery category depends on whether a Claude CLI
// exists on this machine; the seam turns that into an injected input. See
// tests/helpers/vendor-cli-presence.ts.
locateClaudeRuntimeForThisTestFile();

const selection = Object.freeze({
  model: "directory-model",
  effortLevel: "directory-effort",
  executionMode: "single-agent",
  accessMode: "full-access",
});

test("Claude inspect uses only initialize control flow and preserves real catalog relations", async () => {
  const transport = new InitializationTransport({
    models: [
      {
        value: "opus-alias",
        resolvedModel: "claude-opus-canonical",
        displayName: "Opus",
        description: "Complex work",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
        supportsAutoMode: true,
        promoListPrice: "$20",
      },
      {
        value: "haiku-alias",
        displayName: "Haiku",
        description: "Quick work",
      },
    ],
  });
  const catalog = await new ClaudeAdapter(async () => transport).inspect(
    "project",
  );

  assert.deepEqual(catalog, {
    runtime: "claude",
    models: [
      {
        id: "opus-alias",
        resolvedModel: "claude-opus-canonical",
        displayName: "Opus",
        effortLevels: ["low", "high", "max"],
      },
      {
        id: "haiku-alias",
        displayName: "Haiku",
        effortLevels: ["default"],
        effortLevelLabels: ["Default"],
      },
    ],
    executionModes: ["single-agent"],
    accessModes: ["full-access"],
  });
  assert.equal(transport.sent.length, 2);
  assert.deepEqual(transport.sent[0]!.request, {
    subtype: "initialize",
    hooks: null,
  });
  assert.deepEqual(transport.sent[1]!.request, { subtype: "get_settings" });
  assert.equal(transport.userFrames, 0);
  assert.equal(transport.stopped, 1);
  assert.equal(JSON.stringify(catalog).includes("promoListPrice"), false);
  assert.equal(JSON.stringify(catalog).includes("$20"), false);
});

test("Claude accepts one additive model key, records its name, and drops its value", async () => {
  const privateDriftValue = "PRIVATE_FUTURE_ROUTING_VALUE";
  const observations: ClaudeCatalogObservation[] = [];
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [
          {
            value: "us.anthropic.claude-opus-v1:0",
            description: "Bedrock-shaped fixture, not a deployment claim",
            futureRoutingHint: privateDriftValue,
          },
        ],
      }),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("project");

  assert.deepEqual(catalog.models, [
    {
      id: "us.anthropic.claude-opus-v1:0",
      effortLevels: ["default"],
      effortLevelLabels: ["Default"],
    },
  ]);
  assert.equal(JSON.stringify(catalog).includes("futureRoutingHint"), false);
  assert.equal(JSON.stringify(catalog).includes(privateDriftValue), false);
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    toleratedKeys: ["futureRoutingHint"],
    rejections: [],
    rejectionsOmitted: 0,
    toleratedSettingSources: [],
    settingsErrorCount: 0,
  });
});

test("Claude records and drops the already-tolerated catalog envelope additions", async () => {
  const privateEnvelopeValue = "PRIVATE_ENVELOPE_VALUE";
  const observations: ClaudeCatalogObservation[] = [];
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [{ value: "envelope-drift-model" }],
        futureCatalogVersion: privateEnvelopeValue,
      }),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("project");

  assert.deepEqual(observations[0]?.toleratedKeys, ["futureCatalogVersion"]);
  assert.equal(JSON.stringify(catalog).includes("futureCatalogVersion"), false);
  assert.equal(JSON.stringify(catalog).includes(privateEnvelopeValue), false);
});

test("Claude rejects unsafe key names on the catalog envelope", async () => {
  const response = JSON.parse(
    '{"models":[{"value":"envelope-control-model"}],"__proto__":"PRIVATE"}',
  );
  await assert.rejects(
    () =>
      new ClaudeAdapter(async () => new InitializationTransport(response)).inspect(
        "project",
      ),
    fixedRuntimeError("catalog-invalid"),
  );
});

test("Claude quarantines one malformed model row while keeping its usable siblings", async () => {
  const observations: ClaudeCatalogObservation[] = [];
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [
          { value: "usable-before", description: "still selectable" },
          {
            value: "malformed-row",
            displayName: 42,
            description: "invalid recognized value",
          },
          { value: "usable-after", description: "also selectable" },
        ],
      }),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("project");

  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["usable-before", "usable-after"],
  );
  assert.deepEqual(observations, [
    {
      toleratedKeys: [],
      rejections: [
        {
          row: 1,
          modelId: "malformed-row",
          addedKeys: [],
          missingKeys: [],
          invalidKeys: ["displayName"],
        },
      ],
      rejectionsOmitted: 0,
      toleratedSettingSources: [],
      settingsErrorCount: 0,
    },
  ]);
});

test("Claude bounds repeated row rejections while preserving their omitted count", async () => {
  const observations: ClaudeCatalogObservation[] = [];
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [
          ...Array.from({ length: 40 }, (_, index) => ({
            value: `malformed-${index}`,
            displayName: 42,
          })),
          { value: "bounded-rejection-survivor" },
        ],
      }),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("project");

  assert.deepEqual(catalog.models.map((model) => model.id), [
    "bounded-rejection-survivor",
  ]);
  assert.equal(observations[0]?.rejections.length, 32);
  assert.equal(observations[0]?.rejectionsOmitted, 8);
});

test("Claude keeps a missing required model key fatal when no usable row remains", async () => {
  const observations: ClaudeCatalogObservation[] = [];
  await assert.rejects(
    () =>
      new ClaudeAdapter(
        async () =>
          new InitializationTransport({
            models: [{ description: "value is still required" }],
          }),
        undefined,
        undefined,
        undefined,
        (observation) => observations.push(observation),
      ).inspect("project"),
    fixedRuntimeError("catalog-invalid"),
  );

  assert.deepEqual(observations, [
    {
      toleratedKeys: [],
      rejections: [
        {
          row: 0,
          modelId: "<unknown>",
          addedKeys: [],
          missingKeys: ["value"],
          invalidKeys: [],
        },
      ],
      rejectionsOmitted: 0,
      toleratedSettingSources: [],
      settingsErrorCount: 0,
    },
  ]);
});

test("Claude rejects an unrecognized value on a recognized model key", async () => {
  const observations: ClaudeCatalogObservation[] = [];
  await assert.rejects(
    () =>
      new ClaudeAdapter(
        async () =>
          new InitializationTransport({
            models: [
              {
                value: "recognized-key-invalid-value",
                supportsEffort: "future-boolean-literal",
                futureRoutingHint: "PRIVATE_MUST_NOT_MASK_INVALID_VALUE",
              },
            ],
          }),
        undefined,
        undefined,
        undefined,
        (observation) => observations.push(observation),
      ).inspect("project"),
    fixedRuntimeError("catalog-invalid"),
  );

  assert.deepEqual(observations[0]?.rejections, [
    {
      row: 0,
      modelId: "recognized-key-invalid-value",
      addedKeys: ["futureRoutingHint"],
      missingKeys: [],
      invalidKeys: ["supportsEffort"],
    },
  ]);
  assert.deepEqual(observations[0]?.toleratedKeys, []);
});

test("Claude rejects unsafe key names at the additive model boundary", async () => {
  const unsafeRecords = [
    JSON.parse('{"value":"prototype-row","__proto__":"PRIVATE"}'),
    JSON.parse('{"value":"constructor-row","constructor":"PRIVATE"}'),
    { value: "control-row", ["future\nfield"]: "PRIVATE" },
    { value: "bidi-row", ["future\u202efield"]: "PRIVATE" },
    { value: "trim-row", [" futureField"]: "PRIVATE" },
    { value: "surrogate-row", ["future\ud800field"]: "PRIVATE" },
    { value: "unbounded-row", ["x".repeat(121)]: "PRIVATE" },
  ];

  for (const [row, candidate] of unsafeRecords.entries()) {
    const observations: ClaudeCatalogObservation[] = [];
    await assert.rejects(
      () =>
        new ClaudeAdapter(
          async () => new InitializationTransport({ models: [candidate] }),
          undefined,
          undefined,
          undefined,
          (observation) => observations.push(observation),
        ).inspect("project"),
      fixedRuntimeError("catalog-invalid"),
      `unsafe key row ${row}`,
    );
    assert.deepEqual(
      observations[0]?.rejections[0]?.invalidKeys,
      ["keyNames"],
      `unsafe key row ${row}`,
    );
    assert.deepEqual(
      observations[0]?.rejections[0]?.addedKeys,
      [],
      `unsafe key row ${row}`,
    );
  }
});

test("Claude catalog inspection records tolerated setting sources and validated settings errors", async () => {
  const privateSourceValue = "PRIVATE_SOURCE_VALUE";
  const privateErrorDetail = "PRIVATE_ERROR_DETAIL";
  const observations: ClaudeCatalogObservation[] = [];
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport(
        { models: [{ value: "settings-drift-model" }] },
        undefined,
        {
          ...claudeSettingsResponse("high", false),
          sources: [
            {
              source: "futureManagedSettings",
              settings: { managedCanary: privateSourceValue },
            },
          ],
          errors: [
            {
              file: "settings.json",
              path: "/project/settings.json",
              message: privateErrorDetail,
            },
          ],
        },
      ),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("project");

  assert.deepEqual(catalog.models.map((model) => model.id), [
    "settings-drift-model",
  ]);
  assert.deepEqual(observations, [
    {
      toleratedKeys: [],
      rejections: [],
      rejectionsOmitted: 0,
      toleratedSettingSources: ["futureManagedSettings"],
      settingsErrorCount: 1,
    },
  ]);
  assert.equal(JSON.stringify(catalog).includes(privateSourceValue), false);
  assert.equal(JSON.stringify(catalog).includes(privateErrorDetail), false);
});

test("Claude catalog drift diagnostics name tolerated and quarantined facts without raw values", () => {
  const observation: ClaudeCatalogObservation = Object.freeze({
    toleratedKeys: Object.freeze(["futureRoutingHint"]),
    rejections: Object.freeze([
      Object.freeze({
        row: 2,
        modelId: "rejected-model",
        addedKeys: Object.freeze([]),
        missingKeys: Object.freeze([]),
        invalidKeys: Object.freeze(["supportsEffort"]),
      }),
    ]),
    rejectionsOmitted: 3,
    toleratedSettingSources: Object.freeze(["futureManagedSettings"]),
    settingsErrorCount: 1,
  });

  const formatted = formatClaudeCatalogDriftDiagnostic(observation);
  assert.equal(
    formatted,
    'CLAUDE_CATALOG_DRIFT tolerated-keys=["futureRoutingHint"] ' +
      'quarantined-model="rejected-model" row=2 added=[] missing=[] invalid=["supportsEffort"] ' +
      'quarantined-omitted=3 tolerated-setting-sources=["futureManagedSettings"] settings-errors=1',
  );
  assert.equal(formatted?.includes("PRIVATE"), false);
  assert.equal(
    formatClaudeCatalogDriftDiagnostic({
      toleratedKeys: [],
      rejections: [],
      rejectionsOmitted: 0,
      toleratedSettingSources: [],
      settingsErrorCount: 0,
    }),
    undefined,
  );
});

test("Claude tolerated model data cannot cross the product catalog sanitizer boundary", async () => {
  const privateDriftValue = "PRIVATE_SANITIZER_BOUNDARY_VALUE";
  const observations: ClaudeCatalogObservation[] = [];
  const claudeAdapter = new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [
          {
            value: "sanitized-claude-model",
            displayName: "Sanitized Claude model",
            futureRoutingHint: privateDriftValue,
          },
        ],
      }),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  );
  const codexAdapter: ResumableAgentRuntimeAdapter = {
    async inspect() {
      return {
        runtime: "codex",
        models: [
          {
            id: "sanitizer-control-model",
            effortLevels: ["high"],
          },
        ],
        executionModes: ["single-agent"],
        accessModes: ["full-access"],
      };
    },
    async start() {
      throw new Error("not exercised by catalog discovery");
    },
    async resume() {
      throw new Error("not exercised by catalog discovery");
    },
  };

  const discovery = await discoverRuntimeEndpointComposition({
    projectDirectory: "project",
    codexAdapter,
    claudeAdapter,
    glmEnvironment: {},
    deepseekEnvironment: {},
    kimiPlatformEnvironment: {},
    claudeApiEnvironment: {},
    codexApiEnvironment: {},
  });
  const publicProductValue = JSON.stringify(discovery);

  assert.deepEqual(
    discovery.endpointDiscovery.statuses.map((status) => status.category),
    [
      "catalog-ready",
      "catalog-ready",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
      "authentication-required",
    ],
  );
  assert.equal(publicProductValue.includes("futureRoutingHint"), false);
  assert.equal(publicProductValue.includes(privateDriftValue), false);
  assert.deepEqual(observations[0]?.toleratedKeys, ["futureRoutingHint"]);
});

test("Claude inspect keeps a sparse native model value for the existing display fallback", async () => {
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [
          {
            value: "native-sparse-model",
            description: "Sparse but valid",
            supportsEffort: true,
            supportedEffortLevels: ["xhigh"],
          },
        ],
      }),
  ).inspect("project");
  assert.deepEqual(catalog.models[0], {
    id: "native-sparse-model",
    effortLevels: ["xhigh"],
  });
});

test("Claude exposes ultracode only as a confirmed xhigh work-intensity variant", async () => {
  const confirmed = await new ClaudeAdapter(
    async () =>
      new InitializationTransport(
        {
          models: [
            {
              value: "opus-alias",
              supportsEffort: true,
              supportedEffortLevels: ["low", "xhigh", "max"],
            },
            {
              value: "haiku-alias",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"],
            },
          ],
        },
        undefined,
        claudeSettingsResponse("xhigh", true),
      ),
  ).inspect("project");

  assert.deepEqual(confirmed.executionModes, ["single-agent"]);
  assert.deepEqual(confirmed.models[0]?.workIntensityVariants, [
    {
      value: "ultracode",
      label: "ultracode",
      nativeEffortLevel: "xhigh",
      baseExecutionMode: "single-agent",
      executionMode: "ultracode",
    },
  ]);
  assert.equal(confirmed.models[1]?.workIntensityVariants, undefined);

  const disabled = await new ClaudeAdapter(
    async () =>
      new InitializationTransport(
        {
          models: [
            {
              value: "opus-alias",
              supportsEffort: true,
              supportedEffortLevels: ["xhigh"],
            },
          ],
        },
        undefined,
        claudeSettingsResponse("xhigh", false),
      ),
  ).inspect("project");
  assert.equal(disabled.models[0]?.workIntensityVariants, undefined);
});

test("Claude inspect carries newly published native effort values verbatim", async () => {
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport({
        models: [
          {
            value: "native-future-effort-model",
            supportsEffort: true,
            supportedEffortLevels: ["low", "ultra"],
          },
        ],
      }),
  ).inspect("project");

  assert.deepEqual(catalog.models[0], {
    id: "native-future-effort-model",
    effortLevels: ["low", "ultra"],
  });
});

test("Claude drops an additive ultracode model field instead of treating it as applied settings", async () => {
  const observations: ClaudeCatalogObservation[] = [];
  const catalog = await new ClaudeAdapter(
    async () =>
      new InitializationTransport(
        {
          models: [
            {
              value: "model-with-native-extra-field",
              supportsEffort: true,
              supportedEffortLevels: ["xhigh"],
              ultracode: true,
            },
          ],
        },
        undefined,
        claudeSettingsResponse("xhigh", false),
      ),
    undefined,
    undefined,
    undefined,
    (observation) => observations.push(observation),
  ).inspect("project");

  assert.equal(catalog.models[0]?.workIntensityVariants, undefined);
  assert.equal(JSON.stringify(catalog).includes("ultracode"), false);
  assert.deepEqual(observations[0]?.toleratedKeys, ["ultracode"]);
});

test("Claude inspect fails closed on malformed and turn-bearing initialization frames", async () => {
  const malformedRows = [
    {
      models: [
        { value: "model", resolvedModel: 42, description: "x" },
      ],
    },
    {
      models: [
        {
          value: "model",
          resolvedModel: "https://invalid.example/model",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          resolvedModel: "C:\\invalid\\model",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          resolvedModel: "safe\u202ereversed",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          description: "x",
          promoListPrice: { amount: 20 },
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          description: "x",
          supportsEffort: true,
          supportedEffortLevels: [],
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          description: "x",
          supportsEffort: false,
          supportedEffortLevels: ["low"],
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          description: "x",
          supportsEffort: true,
          supportedEffortLevels: ["low", 42],
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          description: "x",
          supportsEffort: true,
          supportedEffortLevels: ["low", "low"],
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          description: "x",
          supportsEffort: true,
          supportedEffortLevels: ["low", "api_key=PRIVATE"],
        },
      ],
    },
    {
      models: [
        { value: "duplicate", description: "x" },
        { value: "duplicate", description: "x" },
      ],
    },
    {
      models: [
        {
          value: "model",
          resolvedModel: "native://private-model",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          resolvedModel: "/private/model",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          resolvedModel: "safe\u202ereversed",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          displayName: "https://PRIVATE.invalid/model",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          displayName: "api_key=PRIVATE",
          description: "x",
        },
      ],
    },
    {
      models: [
        {
          value: "model",
          displayName: "safe\u202ereversed",
          description: "x",
        },
      ],
    },
  ];
  for (const response of malformedRows) {
    const transport = new InitializationTransport(response);
    await assert.rejects(
      () => new ClaudeAdapter(async () => transport).inspect("project"),
      fixedRuntimeError("catalog-invalid"),
    );
    assert.equal(transport.stopped, 1);
  }

  const turnBearing = new InitializationTransport({ models: [] }, "assistant");
  await assert.rejects(
    () => new ClaudeAdapter(async () => turnBearing).inspect("project"),
    fixedRuntimeError("protocol-invalid"),
  );
  assert.equal(turnBearing.stopped, 1);
});

for (const row of [
  { name: "missing sources", body: { effective: {}, applied: { model: "opus-alias", effort: "xhigh", ultracode: true } } },
  { name: "missing applied effort", body: { effective: {}, sources: [], applied: { model: "opus-alias", ultracode: true } } },
  { name: "missing applied", body: { effective: {}, sources: [] } },
  { name: "changed sources", body: { effective: {}, sources: {}, private: "PRIVATE_SETTINGS_CANARY" } },
  { name: "changed body", body: [], category: "runtime-unavailable" as const },
  { name: "removed get_settings", body: {}, rejected: true, category: "runtime-unavailable" as const },
]) {
  test(`Claude CLI drift: catalog remains usable without optional settings (${row.name})`, async (t) => {
    const summaries: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string) => {
      summaries.push(String(chunk));
      return true;
    });
    const createTransport = () => {
      const transport = new InitializationTransport({ models: [{ value: "opus-alias", supportsEffort: true, supportedEffortLevels: ["high", "xhigh"] }] }, undefined, row.body);
      if (row.rejected) {
        const receive = transport.receive.bind(transport);
        transport.receive = async () => {
          const line = await receive();
          if (line === null) return line;
          const frame = JSON.parse(line);
          if (frame.response?.request_id?.includes("settings")) {
            frame.response = { subtype: "error", request_id: frame.response.request_id, error: "Unknown control subtype: get_settings" };
          }
          return JSON.stringify(frame);
        };
      }
      return transport;
    };
    const transport = createTransport();
    const catalog = await new ClaudeAdapter(async () => transport).inspect("project");
    assert.deepEqual(catalog.models, [{ id: "opus-alias", effortLevels: ["high", "xhigh"] }]);
    assert.equal(transport.stopped, 1);
    assert.equal(transport.userFrames, 0);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!, /optional-data-unavailable.*gate=catalog-settings/u);
    assert.equal(JSON.stringify({ catalog, summaries }).includes("PRIVATE_SETTINGS_CANARY"), false);

    // Inspect may omit an unconfirmed variant; executing a selected profile
    // may not omit its confirmation or send a prompt on guessed settings.
    const sessionTransport = createTransport();
    await assert.rejects(() => new ClaudeAdapter(async () => sessionTransport, async () => sessionTransport).start({
      projectDirectory: "project",
      profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
    }), fixedRuntimeError(row.category ?? "protocol-invalid"));
    assert.equal(sessionTransport.stopped, 1);
    assert.equal(sessionTransport.userFrames, 0);
  });
}

test("Claude CLI drift: optional catalog settings do not mask broken framing or correlation", async () => {
  for (const mutation of ["turn-bearing", "wrong-id", "malformed-json", "missing-response"]) {
    const transport = new InitializationTransport({ models: [{ value: "model" }] });
    const receive = transport.receive.bind(transport);
    transport.receive = async () => {
      const line = await receive();
      if (line === null) return line;
      const frame = JSON.parse(line);
      if (frame.response?.request_id?.includes("settings")) {
        if (mutation === "turn-bearing") return JSON.stringify({ type: "assistant" });
        if (mutation === "malformed-json") return "{";
        if (mutation === "missing-response") delete frame.response;
        else frame.response.request_id = "not-our-request";
      }
      return JSON.stringify(frame);
    };
    await assert.rejects(() => new ClaudeAdapter(async () => transport).inspect("project"),
      fixedRuntimeError(mutation === "wrong-id" ? "runtime-shutdown" : "protocol-invalid"));
    assert.equal(transport.userFrames, 0);
    assert.equal(transport.stopped, 1);
  }
});

test("Claude catalog-fatal rejection names the exact gate and adversarial row without weakening the fixed Runtime error", async () => {
  const transport = new InitializationTransport({
    models: [
      {
        value: "duplicated-model",
        supportsEffort: true,
        supportedEffortLevels: ["xhigh"],
      },
      {
        value: "duplicated-model",
        supportsEffort: true,
        supportedEffortLevels: ["xhigh"],
      },
    ],
  });

  let failure: unknown;
  try {
    await new ClaudeAdapter(async () => transport).inspect("project");
  } catch (error) {
    failure = error;
  }

  assert.equal(failure instanceof ClaudeDiagnosticError, true);
  assert.equal(failure instanceof RuntimeAdapterError, true);
  assert.equal((failure as RuntimeAdapterError).category, "catalog-invalid");
  assert.equal((failure as Error).message, "Agent Runtime operation failed.");
  assert.deepEqual((failure as ClaudeDiagnosticError).diagnostic, {
    kind: "catalog-shape-rejected",
    category: "catalog-invalid",
    gate: "models",
    row: 1,
    addedKeys: [],
    missingKeys: [],
    invalidKeys: ["value"],
    detail: JSON.stringify({
      value: "duplicated-model",
      supportsEffort: true,
      supportedEffortLevels: ["xhigh"],
    }),
  });
  assert.equal(transport.stopped, 1);
});

test("Claude start streams one turn through the normalized Runtime seam", async () => {
  const nativeSessionCanary = "native-session-must-remain-private";
  const sessionTransport = new SuccessfulSessionTransport(
    nativeSessionCanary,
    "Reply with exactly UAW_FAKE_START",
    "UAW_FAKE_START",
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => sessionTransport,
  );
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  const started = await adapter.start({
    projectDirectory: "project",
    profile,
  });
  assert.notEqual(started.opaqueSessionReference, nativeSessionCanary);
  assert.equal(JSON.stringify(started).includes(nativeSessionCanary), false);
  const observable = started as typeof started & {
    effectiveProfile(): typeof profile | undefined;
  };
  assert.equal(typeof observable.effectiveProfile, "function");
  assert.equal(observable.effectiveProfile(), undefined);
  await started.send({ text: "Reply with exactly UAW_FAKE_START" });

  assert.deepEqual(await collect(started.events()), [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "UAW_FAKE_START" },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.equal(sessionTransport.stopped, 1);
  assert.deepEqual(observable.effectiveProfile(), profile);
  assert.deepEqual(
    sessionTransport.sent.map((message) => message.type),
    ["control_request", "control_request", "user", "control_response"],
  );
});

test("Claude start preserves a Chinese turn through the normalized Runtime seam", async () => {
  const prompt = "请用中文回答这个项目是什么";
  const reply = "这是一个统一的 Agent Workbench。";
  const sessionTransport = new SuccessfulSessionTransport(
    "native-chinese-session-must-remain-private",
    prompt,
    reply,
  );
  const binding = await new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => sessionTransport,
  ).start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });

  await binding.send({ text: prompt });
  assert.deepEqual(await collect(binding.events()), [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: reply },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.equal(sessionTransport.stopped, 1);
});

test("Claude carries its post-result prompt suggestion on the completed turn", async () => {
  const suggestion = "检查这次改动还缺哪些测试";
  const transport = new SuccessfulSessionTransport(
    "native-suggestion-session-must-remain-private",
    "完成这个改动",
    "改动已完成。",
    false,
    {
      postResultFrames: [
        {
          type: "prompt_suggestion",
          suggestion,
          uuid: "suggestion-frame-id",
          session_id: "native-suggestion-session-must-remain-private",
        },
      ],
    },
  );
  const binding = await new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  ).start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });

  await binding.send({ text: "完成这个改动" });
  assert.deepEqual((await collect(binding.events())).at(-1), {
    kind: "turn-completed",
    status: "completed",
    suggestions: [suggestion],
  });
  assert.equal(transport.stopped, 1);
});

test("Claude ignores malformed or foreign post-result suggestion frames without losing completion", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-optional-suggestion-session",
    "prompt",
    "ANSWER",
    false,
    {
      postResultFrames: [
        { type: "prompt_suggestion", session_id: "native-optional-suggestion-session" },
        { type: "prompt_suggestion", suggestion: 42, session_id: "native-optional-suggestion-session" },
        { type: "prompt_suggestion", suggestion: " \t\n ", session_id: "native-optional-suggestion-session" },
        { type: "prompt_suggestion", suggestion: "bad\u000bcontrol", session_id: "native-optional-suggestion-session" },
        { type: "prompt_suggestion", suggestion: "belongs elsewhere", session_id: "foreign-session" },
        { type: "future_optional_frame", private: "PRIVATE_OPTIONAL_CANARY" },
        ["future-array-shape"],
      ],
    },
  );
  const binding = await new ClaudeAdapter(
    async () => transport,
    async () => transport,
  ).start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });

  await binding.send({ text: "prompt" });
  const events = await collect(binding.events());
  assert.deepEqual(events.at(-1), {
    kind: "turn-completed",
    status: "completed",
  });
  assert.equal(JSON.stringify(events).includes("PRIVATE_OPTIONAL_CANARY"), false);
  assert.equal(transport.stopped, 1);
});

test("Claude carries result usage with an explicitly unknown context window", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-usage-session-must-remain-private",
    "Reply with exactly UAW_FAKE_USAGE",
    "UAW_FAKE_USAGE",
    false,
    {
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 5,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 20,
        },
        inference_geo: "synthetic-region",
        iterations: 1,
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "synthetic-tier",
        speed: "synthetic-speed",
      },
    },
  );
  const binding = await new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  ).start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply with exactly UAW_FAKE_USAGE" });

  assert.deepEqual((await collect(binding.events())).at(-1), {
    kind: "turn-completed",
    status: "completed",
    context: { basis: "turn-usage", usedTokens: 65, windowTokens: null },
  });
  assert.equal(transport.stopped, 1);
});

test("Claude CLI drift: invalid optional usage is discarded with diagnostics, not a failed turn", async (t) => {
  const summaries: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => {
    summaries.push(String(chunk));
    return true;
  });
  const baseUsage = {
    input_tokens: 10,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 5,
  };
  const adversarial = [
    { name: "missing count", value: { input_tokens: 10, output_tokens: 5 } },
    { name: "changed envelope", value: [baseUsage] },
    { name: "null usage", value: null },
    { name: "renamed counts", value: { tokens: baseUsage, private: "PRIVATE_USAGE_CANARY" } },
    { name: "changed count type", value: { ...baseUsage, output_tokens: "5" } },
    { name: "negative count", value: { ...baseUsage, input_tokens: -1 } },
    { name: "non-integer count", value: { ...baseUsage, output_tokens: 1.5 } },
    { name: "overflow sum", value: { ...baseUsage, input_tokens: Number.MAX_SAFE_INTEGER } },
  ];

  for (const row of adversarial) {
    const prompt = `Reply with exactly UAW_FAKE_USAGE_${row.name.length}`;
    const reply = `UAW_FAKE_USAGE_${row.name.length}`;
    const transport = new SuccessfulSessionTransport(
      "native-adversarial-usage-session-private",
      prompt,
      reply,
      false,
      { usage: row.value },
    );
    const binding = await new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => transport,
    ).start({
      projectDirectory: "project",
      profile: {
        model: "opus-alias",
        effortLevel: "high",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    await binding.send({ text: prompt });
    const events = await collect(binding.events());
    assert.deepEqual(
      events.at(-1),
      { kind: "turn-completed", status: "completed" },
      row.name,
    );
    assert.equal(
      events.some((event) => "context" in event),
      false,
      row.name,
    );
    assert.equal(transport.stopped, 1, row.name);
    assert.equal(summaries.length, adversarial.indexOf(row) + 1, row.name);
    assert.match(summaries.at(-1)!, /optional-data-unavailable.*gate=context-usage/u);
    assert.equal(JSON.stringify({ events, summaries }).includes("PRIVATE_USAGE_CANARY"), false);
  }
});

for (const capabilities of [
  { interrupt_receipt_v1: true, interrupt_cancel_queued_v1: true, private: "PRIVATE_CAPABILITY_CANARY" },
  ["interrupt_receipt_v1", 42],
  null,
  undefined,
  ["interrupt_receipt_v1"],
  ["interrupt_cancel_queued_v1"],
  [],
]) {
  test(`Claude CLI drift: reduced controls for capabilities ${JSON.stringify(capabilities)}`, async (t) => {
    const summaries: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string) => {
      summaries.push(String(chunk));
      return true;
    });
    const transport = new SuccessfulSessionTransport("private-session", "prompt", "ANSWER");
    const receive = transport.receive.bind(transport);
    transport.receive = async () => {
      const line = await receive();
      if (line === null) return line;
      const message = JSON.parse(line);
      if (message.type === "system" && message.subtype === "init") {
        message.capabilities = capabilities;
      }
      return JSON.stringify(message);
    };
    const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({
      projectDirectory: "project",
      profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
    });
    await binding.send({ text: "prompt" });
    const iterator = binding.events()[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { kind: "session-started" });
    assert.equal(binding.interruptAvailability!(), "unsupported");
    assert.equal(binding.steerAvailability!(), "unsupported");
    const writes = transport.sent.length;
    await assert.rejects(() => binding.interrupt!(), fixedRuntimeError("unsupported-selection"));
    await assert.rejects(() => binding.steer!({ text: "correction" }), fixedRuntimeError("unsupported-selection"));
    assert.equal(transport.sent.length, writes, "unsupported controls must not reach the wire");
    const events = await collectIterator(iterator);
    assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
    assert.equal(transport.stopped, 1);
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!, /optional-data-unavailable.*gate=interrupt-and-steer/u);
    assert.equal(JSON.stringify({ events, summaries }).includes("PRIVATE_CAPABILITY_CANARY"), false);
  });
}

test("Claude CLI drift: new init version and capability keys leave known controls available", async (t) => {
  const summaries: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { summaries.push(String(chunk)); return true; });
  const transport = new SuccessfulSessionTransport("private-session", "prompt", "ANSWER");
  const receive = transport.receive.bind(transport);
  transport.receive = async () => {
    const line = await receive();
    if (line === null) return line;
    const message = JSON.parse(line);
    if (message.type === "system" && message.subtype === "init") {
      message.claude_code_version = "999.0.0-garbage";
      message.capabilities.push("future_control_v9");
      message.future = { private: "PRIVATE_INIT_CANARY" };
    }
    return JSON.stringify(message);
  };
  const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({
    projectDirectory: "project",
    profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
  });
  await binding.send({ text: "prompt" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { kind: "session-started" });
  assert.equal(binding.interruptAvailability!(), "available");
  assert.equal(binding.steerAvailability!(), "available");
  const events = await collectIterator(iterator);
  assert.equal(events.at(-1)?.kind, "turn-completed");
  assert.equal(summaries.length, 0);
  assert.equal(JSON.stringify(events).includes("PRIVATE_INIT_CANARY"), false);
});

test("Claude CLI drift: optional data never excuses missing identity, permission, model or completion evidence", async () => {
  for (const key of ["session_id", "permissionMode", "model", "terminal_reason", "result"]) {
    const transport = new SuccessfulSessionTransport("private-session", "prompt", "ANSWER", false, { usage: {} });
    const receive = transport.receive.bind(transport);
    transport.receive = async () => {
      const line = await receive();
      if (line === null) return line;
      const message = JSON.parse(line);
      if (message.type === "system" && message.subtype === "init") {
        if (["session_id", "permissionMode", "model"].includes(key)) {
          message.capabilities = { interrupt_receipt_v1: true };
          delete message[key];
        }
      }
      if (message.type === "result") delete message[key];
      return JSON.stringify(message);
    };
    const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({
      projectDirectory: "project",
      profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
    });
    await binding.send({ text: "prompt" });
    const events = await collect(binding.events());
    assert.deepEqual(events.at(-1), { kind: "failed", category: ["terminal_reason", "result"].includes(key) ? "turn-failed" : "unsupported-selection" }, key);
    assert.equal(events.some(event => event.kind === "turn-completed" || "context" in event), false);
    assert.equal(transport.stopped, 1);
  }
});

test("Claude resume resolves only an in-memory opaque capability and keeps native identity private", async () => {
  const nativeSessionCanary = "native-resume-session-must-remain-private";
  const transports = [
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "Reply with exactly UAW_FAKE_FIRST",
      "UAW_FAKE_FIRST",
    ),
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "Reply with exactly UAW_FAKE_RESUME",
      "UAW_FAKE_RESUME",
    ),
  ];
  const requests: ClaudeSessionTransportRequest[] = [];
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async (request) => {
      requests.push({ ...request });
      return transports.shift()!;
    },
  );
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const first = await adapter.start({ projectDirectory: "project", profile });
  await first.send({ text: "Reply with exactly UAW_FAKE_FIRST" });
  assert.equal((await collect(first.events())).at(-1)?.kind, "turn-completed");

  const resumed = await adapter.resume({
    projectDirectory: "project",
    profile,
    opaqueSessionReference: first.opaqueSessionReference,
  });
  assert.equal(resumed.opaqueSessionReference, first.opaqueSessionReference);
  assert.equal(JSON.stringify(resumed).includes(nativeSessionCanary), false);
  await resumed.send({ text: "Reply with exactly UAW_FAKE_RESUME" });
  assert.deepEqual(await collect(resumed.events()), [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "UAW_FAKE_RESUME" },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.resumeSessionIdentity, undefined);
  assert.equal(requests[1]!.resumeSessionIdentity, nativeSessionCanary);
});

test("a Claude Session survives an app restart: a persisted capability rehydrates resume on a fresh adapter (F220)", async () => {
  const nativeSessionCanary = "native-restart-session-must-remain-private";
  const persisted = new Map<string, PersistedClaudeSessionCapability>();
  const capabilityStore: ClaudeSessionCapabilityStore = {
    load: () => new Map(persisted),
    save(reference, capability) {
      persisted.set(reference, capability);
    },
  };
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  // The first app run: start a Session and complete one turn.
  const firstAdapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () =>
      new SuccessfulSessionTransport(
        nativeSessionCanary,
        "Reply with exactly UAW_FAKE_FIRST",
        "UAW_FAKE_FIRST",
      ),
    undefined,
    undefined,
    undefined,
    capabilityStore,
  );
  const first = await firstAdapter.start({ projectDirectory: "project", profile });
  await first.send({ text: "Reply with exactly UAW_FAKE_FIRST" });
  assert.equal((await collect(first.events())).at(-1)?.kind, "turn-completed");

  // The restart: a NEW adapter instance whose only inheritance is the store.
  const requests: ClaudeSessionTransportRequest[] = [];
  const secondAdapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async (request) => {
      requests.push({ ...request });
      return new SuccessfulSessionTransport(
        nativeSessionCanary,
        "Reply with exactly UAW_FAKE_RESUME",
        "UAW_FAKE_RESUME",
      );
    },
    undefined,
    undefined,
    undefined,
    capabilityStore,
  );
  const resumed = await secondAdapter.resume({
    projectDirectory: "project",
    profile,
    opaqueSessionReference: first.opaqueSessionReference,
  });
  assert.equal(resumed.opaqueSessionReference, first.opaqueSessionReference);
  assert.equal(JSON.stringify(resumed).includes(nativeSessionCanary), false);
  await resumed.send({ text: "Reply with exactly UAW_FAKE_RESUME" });
  assert.equal((await collect(resumed.events())).at(-1)?.kind, "turn-completed");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.resumeSessionIdentity, nativeSessionCanary);

  // The store holds exactly the one capability, keyed by the opaque
  // reference, and the native identity still never leaves the binding.
  assert.equal(persisted.size, 1);
  assert.equal(
    persisted.get(first.opaqueSessionReference)?.sessionIdentity,
    nativeSessionCanary,
  );

  // A store that cannot load must degrade to today's behaviour, not fail the
  // adapter: constructing over a throwing store still starts Sessions.
  const throwingStoreAdapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () =>
      new SuccessfulSessionTransport(
        nativeSessionCanary,
        "Reply with exactly UAW_FAKE_DEGRADED",
        "UAW_FAKE_DEGRADED",
      ),
    undefined,
    undefined,
    undefined,
    {
      load(): ReadonlyMap<string, PersistedClaudeSessionCapability> {
        throw new Error("synthetic store read failure");
      },
      save() {
        throw new Error("synthetic store write failure");
      },
    },
  );
  const degraded = await throwingStoreAdapter.start({
    projectDirectory: "project",
    profile,
  });
  await degraded.send({ text: "Reply with exactly UAW_FAKE_DEGRADED" });
  assert.equal((await collect(degraded.events())).at(-1)?.kind, "turn-completed");
});

test("Claude resumes one native Session with a changed model and effort and reports the exact effective turn profile", async () => {
  const nativeSessionCanary = "native-changed-profile-session-must-remain-private";
  const catalogModels = [
    {
      value: "fable-alias",
      resolvedModel: "claude-fable-canonical",
      displayName: "Fable",
      description: "Balanced work",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    },
    {
      value: "opus-alias",
      resolvedModel: "claude-opus-canonical",
      displayName: "Opus",
      description: "Complex work",
      supportsEffort: true,
      supportedEffortLevels: ["high", "max"],
    },
  ];
  const transports = [
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "Reply with exactly UAW_FAKE_FABLE",
      "UAW_FAKE_FABLE",
      false,
      {
        catalogModels,
        model: "claude-fable-canonical",
        effort: "low",
      },
    ),
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "Reply with exactly UAW_FAKE_OPUS",
      "UAW_FAKE_OPUS",
      false,
      {
        catalogModels,
        model: "claude-opus-canonical",
        effort: "high",
      },
    ),
  ];
  const requests: ClaudeSessionTransportRequest[] = [];
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async (request) => {
      requests.push(structuredClone(request));
      return transports.shift()!;
    },
  );
  const firstProfile = Object.freeze({
    model: "fable-alias",
    effortLevel: "low",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const changedProfile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  const first = await adapter.start({
    projectDirectory: "project",
    profile: firstProfile,
  });
  await first.send({ text: "Reply with exactly UAW_FAKE_FABLE" });
  assert.equal((await collect(first.events())).at(-1)?.kind, "turn-completed");
  assert.deepEqual(first.effectiveProfile?.(), firstProfile);

  const resumed = await adapter.resume({
    projectDirectory: "project",
    profile: changedProfile,
    opaqueSessionReference: first.opaqueSessionReference,
  });
  assert.equal(resumed.opaqueSessionReference, first.opaqueSessionReference);
  assert.deepEqual(resumed.profile, changedProfile);
  await resumed.send({ text: "Reply with exactly UAW_FAKE_OPUS" });
  assert.equal((await collect(resumed.events())).at(-1)?.kind, "turn-completed");
  assert.deepEqual(resumed.effectiveProfile?.(), changedProfile);
  assert.deepEqual(
    requests.map((request) => ({
      profile: request.profile,
      resumeSessionIdentity: request.resumeSessionIdentity,
    })),
    [
      { profile: firstProfile, resumeSessionIdentity: undefined },
      { profile: changedProfile, resumeSessionIdentity: nativeSessionCanary },
    ],
  );
});

test("Claude keeps one Session while work intensity transitions through ultracode", async () => {
  const nativeSessionCanary = "native-ultracode-session-must-remain-private";
  const catalogModels = [
    {
      value: "opus-alias",
      resolvedModel: "claude-opus-canonical",
      supportsEffort: true,
      supportedEffortLevels: ["high", "xhigh", "max"],
    },
  ];
  const transports = [
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "ordinary",
      "ordinary-ok",
      false,
      { catalogModels, effort: "high", settingsUltracode: false },
    ),
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "ultracode",
      "ultracode-ok",
      false,
      { catalogModels, effort: "xhigh", settingsUltracode: true },
    ),
    new SuccessfulSessionTransport(
      nativeSessionCanary,
      "max",
      "max-ok",
      false,
      { catalogModels, effort: "max", settingsUltracode: false },
    ),
  ];
  const requests: ClaudeSessionTransportRequest[] = [];
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async (request) => {
      requests.push(structuredClone(request));
      return transports.shift()!;
    },
  );
  const ordinaryProfile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const ultracodeProfile = Object.freeze({
    model: "opus-alias",
    effortLevel: "xhigh",
    executionMode: "ultracode",
    accessMode: "full-access",
  });
  const maxProfile = Object.freeze({
    model: "opus-alias",
    effortLevel: "max",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  const ordinary = await adapter.start({
    projectDirectory: "project",
    profile: ordinaryProfile,
  });
  await ordinary.send({ text: "ordinary" });
  assert.equal((await collect(ordinary.events())).at(-1)?.kind, "turn-completed");

  const ultracode = await adapter.resume({
    projectDirectory: "project",
    profile: ultracodeProfile,
    opaqueSessionReference: ordinary.opaqueSessionReference,
  });
  await ultracode.send({ text: "ultracode" });
  assert.equal((await collect(ultracode.events())).at(-1)?.kind, "turn-completed");
  assert.deepEqual(ultracode.effectiveProfile?.(), ultracodeProfile);

  const maximum = await adapter.resume({
    projectDirectory: "project",
    profile: maxProfile,
    opaqueSessionReference: ordinary.opaqueSessionReference,
  });
  await maximum.send({ text: "max" });
  assert.equal((await collect(maximum.events())).at(-1)?.kind, "turn-completed");
  assert.deepEqual(maximum.effectiveProfile?.(), maxProfile);

  assert.deepEqual(
    requests.map((request) => ({
      profile: request.profile,
      resumeSessionIdentity: request.resumeSessionIdentity,
    })),
    [
      { profile: ordinaryProfile, resumeSessionIdentity: undefined },
      {
        profile: ultracodeProfile,
        resumeSessionIdentity: nativeSessionCanary,
      },
      { profile: maxProfile, resumeSessionIdentity: nativeSessionCanary },
    ],
  );
});

test("Claude rejects ultracode unless get_settings confirms the applied flag", async () => {
  const missingFlag = claudeSettingsResponse("xhigh", true);
  delete (missingFlag.applied as Record<string, unknown>).ultracode;
  const rows = [
    { name: "missing", settingsResponse: missingFlag },
    {
      name: "false",
      settingsResponse: claudeSettingsResponse("xhigh", false),
    },
  ];
  for (const row of rows) {
    const transport = new SuccessfulSessionTransport(
      `native-${row.name}-ultracode-session-private`,
      "must-not-send",
      "must-not-receive",
      false,
      {
        catalogModels: [
          {
            value: "opus-alias",
            supportsEffort: true,
            supportedEffortLevels: ["xhigh"],
          },
        ],
        effort: "xhigh",
        settingsResponse: row.settingsResponse,
      },
    );
    const adapter = new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => transport,
    );
    await assert.rejects(
      adapter.start({
        projectDirectory: "project",
        profile: {
          model: "opus-alias",
          effortLevel: "xhigh",
          executionMode: "ultracode",
          accessMode: "full-access",
        },
      }),
      fixedRuntimeError("unsupported-selection"),
      row.name,
    );
    assert.deepEqual(
      transport.sent.map((message) => message.type),
      ["control_request", "control_request"],
    );
    assert.equal(transport.stopped, 1);
  }
});

test("Claude interrupt correlates the synthetic user marker and reports one honest stopped terminal", async () => {
  const transport = new InterruptibleSessionTransport();
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply slowly with UAW_FAKE_INTERRUPT" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "session-started" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "turn-started" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "item-started", itemType: "agent-message" },
  });
  const controllable = binding as typeof binding & {
    interrupt(): Promise<void>;
    correlationFailureDiscriminator(): string | undefined;
  };
  assert.equal(typeof controllable.interrupt, "function");
  assert.equal(typeof binding.steer, "function");
  assert.equal(binding.steerAvailability?.(), "available");
  assert.equal(binding.interruptAvailability?.(), "available");

  let controlReceiptObserved = false;
  let terminalObserved: unknown;
  let iteratorEnded = false;
  const interrupt = controllable.interrupt().then(() => {
    controlReceiptObserved = true;
  });
  const remaining = collectIterator(iterator, (event) => {
    if (
      event.kind === "failed" ||
      event.kind === "turn-completed" ||
      event.kind === "turn-interrupted"
    ) {
      terminalObserved = event;
    }
  }).then((events) => {
    iteratorEnded = true;
    return events;
  });
  await interrupt;
  assert.equal(controlReceiptObserved, true);
  const remainingEvents = await remaining;
  assert.deepEqual(terminalObserved, {
    kind: "turn-interrupted",
    status: "interrupted",
  });
  assert.equal(iteratorEnded, true);
  assert.deepEqual(remainingEvents, [
    { kind: "turn-interrupted", status: "interrupted" },
  ]);
  assert.deepEqual(transport.interruptRequest, {
    subtype: "interrupt",
    cancel_queued: true,
  });
  assert.equal(controllable.correlationFailureDiscriminator(), undefined);
  assert.equal(binding.interruptAvailability?.(), "unavailable");
  assert.equal(transport.stopped, 1);
});

test("Claude steer interrupts before injecting a correction, keeps completed work in one Session, and completes only the corrected leg", async () => {
  const transport = new SteerableSessionTransport();
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "WRONG=41; first finish COMPLETED_STEP=alpha" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  const events = [
    (await iterator.next()).value,
    (await iterator.next()).value,
    (await iterator.next()).value,
  ];
  assert.equal(typeof binding.steer, "function");
  assert.equal(binding.steerAvailability?.(), "available");

  const steer = binding.steer!({ text: "CORRECTION: use 73" });
  let nextEventSettled = false;
  const nextEvent = iterator.next().then((step) => {
    nextEventSettled = true;
    return step;
  });
  await steer;
  await transport.oldLegResultRead;
  await Promise.resolve();

  // Acceptance 1: the correction is delivered during the active turn, only
  // after the matching interrupt receipt, and uses the live Session identity.
  assert.deepEqual(transport.steeringWrites, [
    {
      type: "control_request",
      request: { subtype: "interrupt", cancel_queued: true },
    },
    {
      type: "user",
      session_id: transport.sessionIdentity,
      message: {
        role: "user",
        content: [{ type: "text", text: "CORRECTION: use 73" }],
      },
      parent_tool_use_id: null,
    },
  ]);
  assert.equal(transport.correctionWrittenAfterReceipt, true);

  // Acceptance 3: the old leg has already produced aborted_streaming, but it
  // did not finish with the wrong number and did not close the binding.
  assert.equal(nextEventSettled, false);
  assert.equal(transport.stopped, 0);
  assert.equal(binding.steerAvailability?.(), "unavailable");

  transport.continueCorrectedLeg();
  const firstContinuationEvent = await nextEvent;
  assert.equal(firstContinuationEvent.done, false);
  events.push(firstContinuationEvent.value);
  events.push(...(await collectIterator(iterator)));

  // Acceptance 2: there was no replacement Session and the already-completed
  // work remains visible before the answer produced from the corrected value.
  assert.deepEqual(new Set(transport.systemSessionIdentities), new Set([
    transport.sessionIdentity,
  ]));
  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "agent-message", text: "COMPLETED_STEP=alpha" },
    { kind: "item-completed", itemType: "agent-message" },
    {
      kind: "agent-message",
      text: "COMPLETED_STEP=alpha; CORRECT=73",
    },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.equal(transport.stopped, 1);
  assert.equal(binding.steerAvailability?.(), "unavailable");
});

test("Claude steer rejects a continuation init that changes the active Session", async () => {
  const transport = new SteerableSessionTransport();
  const binding = await new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  ).start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "WRONG=41; first finish COMPLETED_STEP=alpha" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();

  const steer = binding.steer!({ text: "CORRECTION: use 73" });
  const remaining = collectIterator(iterator);
  await steer;
  await transport.oldLegResultRead;
  transport.continueCorrectedLeg("different-native-session");

  assert.deepEqual(await remaining, [
    { kind: "failed", category: "correlation-invalid" },
  ]);
  assert.equal(transport.stopped, 1);
});

test("Claude provider-attempt mode truthfully disables unbudgeted interruption", async () => {
  const claims: ProviderOperationKind[] = [];
  const budget: ProviderRequestBudget = Object.freeze({
    async claim(operation: ProviderOperationKind) {
      claims.push(operation);
    },
  });
  const transport = new InterruptibleSessionTransport();
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
    budget,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply slowly with UAW_FAKE_INTERRUPT" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "session-started" },
  });

  assert.equal(binding.interruptAvailability?.(), "unsupported");
  assert.equal(binding.steerAvailability?.(), "unsupported");
  await assert.rejects(
    () =>
      (binding as typeof binding & { interrupt(): Promise<void> }).interrupt(),
    fixedRuntimeError("unsupported-selection"),
  );
  await assert.rejects(
    () => binding.steer!({ text: "must not start an unbudgeted correction" }),
    fixedRuntimeError("unsupported-selection"),
  );
  assert.equal(transport.interruptRequest, undefined);
  assert.deepEqual(claims, [
    "claude-session-initialize",
    "claude-inference-frame",
  ]);

  await iterator.return?.();
});

test("Claude CLI drift: a steered continuation can lose control capabilities without losing its answer", async (t) => {
  const summaries: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { summaries.push(String(chunk)); return true; });
  const transport = new SteerableSessionTransport();
  t.after(() => transport.stop());
  const receive = transport.receive.bind(transport);
  transport.receive = async () => {
    const line = await receive();
    if (line === null) return line;
    const frame = JSON.parse(line);
    if (frame.type === "system" && transport.systemSessionIdentities.length === 2) frame.capabilities = {};
    return JSON.stringify(frame);
  };
  const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({
    projectDirectory: "project",
    profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
  });
  await binding.send({ text: "WRONG=41; first finish COMPLETED_STEP=alpha" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  assert.equal(binding.steerAvailability!(), "available");
  const steer = binding.steer!({ text: "CORRECTION: use 73" });
  let reducedControlsObserved = false;
  const remaining = collectIterator(iterator, event => {
    if (event.kind === "agent-message" && event.text === "COMPLETED_STEP=alpha") {
      assert.equal(binding.interruptAvailability!(), "unsupported");
      assert.equal(binding.steerAvailability!(), "unsupported");
      reducedControlsObserved = true;
    }
  });
  await steer;
  await transport.oldLegResultRead;
  transport.continueCorrectedLeg();
  const events = await remaining;
  assert.equal(reducedControlsObserved, true);
  assert.ok(events.some(event => event.kind === "agent-message" && event.text === "COMPLETED_STEP=alpha; CORRECT=73"));
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!, /optional-data-unavailable.*gate=interrupt-and-steer/u);
});

test("Claude interrupt correlates the observed post-receipt user frame before reporting stopped", async () => {
  const transport = new InterruptibleSessionTransport(
    "unrecognized-text-block",
    false,
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply slowly with UAW_FAKE_INTERRUPT" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "session-started" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "turn-started" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "item-started", itemType: "agent-message" },
  });
  const controllable = binding as typeof binding & {
    interrupt(): Promise<void>;
    correlationFailureDiscriminator(): string | undefined;
    unrecognizedUserFrameShape():
      | readonly Readonly<{ path: string; type: string }>[]
      | undefined;
  };
  let controlReceiptObserved = false;
  let terminalObserved: unknown;
  let iteratorEnded = false;
  const interrupt = controllable.interrupt().then(() => {
    controlReceiptObserved = true;
  });
  const remaining = collectIterator(iterator, (event) => {
    if (
      event.kind === "failed" ||
      event.kind === "turn-completed" ||
      event.kind === "turn-interrupted"
    ) {
      terminalObserved = event;
    }
  }).then((events) => {
    iteratorEnded = true;
    return events;
  });

  await interrupt;
  assert.equal(controlReceiptObserved, true);
  const remainingEvents = await remaining;
  assert.deepEqual(terminalObserved, {
    kind: "turn-interrupted",
    status: "interrupted",
  });
  assert.equal(iteratorEnded, true);
  assert.deepEqual(remainingEvents, [
    { kind: "turn-interrupted", status: "interrupted" },
  ]);
  assert.equal(controllable.correlationFailureDiscriminator(), undefined);
  assert.equal(transport.stopped, 1);
});

// Issue #6 (QA batch) case 3: a confirmed interrupt whose terminal result
// drifts from the wire shapes this build knows — a terminal_reason a newer
// CLI spells differently, or a mid-stream stop where the Stop hook never
// fires — must still report one honest interrupted terminal. The receipt is
// positive evidence the Runtime accepted the stop; spelling drift must not
// demote it to a fixed failure that ends the whole Session.
for (const drift of [
  { name: "unrecognized terminal_reason", drift: { terminalReason: "aborted" } },
  { name: "no Stop-hook echo", drift: { omitStopHook: true } },
  {
    name: "both",
    drift: { omitStopHook: true, terminalReason: "interrupted_by_user" },
  },
] as const) {
  test(`Claude interrupt with a drifted result wire (${drift.name}) still reports interrupted, not a fixed failure`, async () => {
    const transport = new InterruptibleSessionTransport(
      "synthetic-marker",
      true,
      drift.drift,
    );
    const adapter = new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => transport,
    );
    const binding = await adapter.start({
      projectDirectory: "project",
      profile: {
        model: "opus-alias",
        effortLevel: "high",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    await binding.send({ text: "Reply slowly with UAW_FAKE_INTERRUPT" });
    const iterator = binding.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const controllable = binding as typeof binding & {
      interrupt(): Promise<void>;
    };
    // The receipt is only observed by the running event loop, so interrupt
    // and iterator consumption must proceed concurrently (same shape as the
    // strict-shape interrupt tests above).
    const interrupt = controllable.interrupt();
    const events: unknown[] = [];
    const pump = (async () => {
      while (true) {
        const step = await iterator.next();
        if (step.done) break;
        events.push(step.value);
      }
    })();
    await interrupt;
    await pump;
    assert.deepEqual(events, [
      { kind: "turn-interrupted", status: "interrupted" },
    ]);
    assert.equal(transport.stopped, 1);
    assert.equal(binding.interruptAvailability?.(), "unavailable");
  });
}

const correlationRejectionFixtures = [
  {
    fixture: "user-before-session-started",
    discriminator: "user-before-session-started",
  },
  {
    fixture: "user-input-echo-repeated",
    discriminator: "user-input-echo-repeated",
  },
  {
    fixture: "interrupt-marker-unconfirmed-or-repeated",
    discriminator: "interrupt-marker-unconfirmed-or-repeated",
  },
  {
    fixture: "post-interrupt-text-frame-unconfirmed",
    discriminator: "interrupt-marker-unconfirmed-or-repeated",
  },
  {
    fixture: "user-frame-unrecognized",
    discriminator: "user-frame-unrecognized",
  },
  {
    fixture: "assistant-before-turn-started",
    discriminator: "assistant-before-turn-started",
  },
  {
    fixture: "assistant-parent-tool-use",
    discriminator: "assistant-parent-tool-use",
  },
] as const;

for (const row of correlationRejectionFixtures) {
  test(`Claude reports fixed correlation discriminator ${row.discriminator}`, async () => {
    const transport = new CorrelationRejectingSessionTransport(row.fixture);
    const adapter = new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => transport,
    );
    const binding = await adapter.start({
      projectDirectory: "project",
      profile: {
        model: "opus-alias",
        effortLevel: "high",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    await binding.send({ text: "Reply with exactly UAW_FAKE_CORRELATION" });

    assert.deepEqual((await collect(binding.events())).at(-1), {
      kind: "failed",
      category: "correlation-invalid",
    });
    const observable = binding as typeof binding & {
      correlationFailureDiscriminator(): string | undefined;
      unrecognizedUserFrameShape():
        | readonly Readonly<{ path: string; type: string }>[]
        | undefined;
    };
    assert.equal(
      typeof observable.correlationFailureDiscriminator,
      "function",
    );
    assert.equal(
      observable.correlationFailureDiscriminator(),
      row.discriminator,
    );
    if (row.discriminator === "user-frame-unrecognized") {
      assert.deepEqual(observable.unrecognizedUserFrameShape(), [
        { path: "$", type: "object" },
        { path: "$.message", type: "object" },
        { path: "$.message.content", type: "string" },
        { path: "$.message.role", type: "string" },
        { path: "$.parent_tool_use_id", type: "null" },
        { path: "$.session_id", type: "string" },
        { path: "$.type", type: "string" },
      ]);
    } else {
      assert.equal(observable.unrecognizedUserFrameShape(), undefined);
    }
    assert.equal(transport.stopped, 1);
  });
}

test("Claude surfaces thinking but does not mistake allowed quota telemetry for rate limiting (issue #6 cases 1a/4)", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-tool-session-must-remain-private",
    "Use one fake tool, then reply UAW_FAKE_TOOL_DONE",
    "UAW_FAKE_TOOL_DONE",
    true,
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({
    text: "Use one fake tool, then reply UAW_FAKE_TOOL_DONE",
  });

  // Thinking is real activity; the fixture's rate_limit_event says allowed,
  // not blocked. Vendor signatures and redacted blocks remain private.
  assert.deepEqual(await collect(binding.events()), [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "progress", activity: "thinking" },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "tool_use",
        name: "Read",
        parameter: {
          kind: "path",
          value: "src/agent-runtime/index.ts",
          truncated: false,
        },
      },
    },
    { kind: "reasoning", text: "private" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "UAW_FAKE_TOOL_DONE" },
    { kind: "turn-completed", status: "completed" },
  ]);
});

test("Claude names an unnamed tool honestly and marks a clipped path", async () => {
  const originalPath = `src/${"long-directory-".repeat(12)}component.ts`;
  const transport = new SuccessfulSessionTransport(
    "native-unnamed-tool-session-must-remain-private",
    "Use one fake tool, then reply UAW_FAKE_UNKNOWN_TOOL_DONE",
    "UAW_FAKE_UNKNOWN_TOOL_DONE",
    true,
    {
      omitToolUseName: true,
      toolUseInput: {
        path: originalPath,
        private_payload: "do not copy this whole input object",
      },
    },
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Use one fake tool, then reply UAW_FAKE_UNKNOWN_TOOL_DONE" });

  const toolProgress = (await collect(binding.events())).filter(
    (event) => event.kind === "progress" && event.activity === "tool",
  );
  assert.deepEqual(toolProgress, [
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "tool_use",
        name: "未知工具",
        parameter: {
          kind: "path",
          value: `${Array.from(originalPath).slice(0, 119).join("")}…`,
          truncated: true,
        },
      },
    },
  ]);
});

test("Claude coalesces repeated provider retries into one retrying progress note (issue #6 case 4)", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-api-retry-session-must-remain-private",
    "Reply with exactly UAW_FAKE_RETRY_DONE",
    "UAW_FAKE_RETRY_DONE",
    true,
    { apiRetrySystemFrames: true },
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply with exactly UAW_FAKE_RETRY_DONE" });

  // Two api_retry frames arrive; the second is a consecutive repeat of the
  // same activity and must not produce a second durable row.
  const events = await collect(binding.events());
  const retryingNotes = events.filter(
    (event) => event.kind === "progress" && event.activity === "retrying",
  );
  assert.deepEqual(retryingNotes, [{ kind: "progress", activity: "retrying" }]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
});

test("Claude drops an unrecognized assistant content block and preserves the answer", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-unknown-block-session-private",
    "Reply with exactly UAW_FAKE_UNKNOWN_BLOCK",
    "UAW_FAKE_UNKNOWN_BLOCK",
    false,
    { prependUnknownAssistantBlock: true },
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply with exactly UAW_FAKE_UNKNOWN_BLOCK" });

  assert.deepEqual((await collect(binding.events())).at(-1), {
    kind: "turn-completed",
    status: "completed",
  });
});

test("Claude reports effective model, effort, and permission instead of echoing a requested profile", async () => {
  const rows = [
    {
      name: "model",
      profile: { model: "opus-alias", effortLevel: "high" },
      reported: { model: "different-effective-model" },
    },
    {
      name: "permission",
      profile: { model: "opus-alias", effortLevel: "high" },
      reported: { permission: "default" },
    },
    {
      name: "effort",
      profile: { model: "opus-alias", effortLevel: "max" },
      reported: { effort: "high", settingsEffort: "max" },
    },
  ] as const;
  for (const row of rows) {
    const transport = new SuccessfulSessionTransport(
      `native-${row.name}-session-private`,
      `Reply with exactly UAW_FAKE_${row.name.toUpperCase()}`,
      `UAW_FAKE_${row.name.toUpperCase()}`,
      false,
      row.reported,
    );
    const adapter = new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => transport,
    );
    const binding = await adapter.start({
      projectDirectory: "project",
      profile: {
        ...row.profile,
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
    await binding.send({
      text: `Reply with exactly UAW_FAKE_${row.name.toUpperCase()}`,
    });
    const events = await collect(binding.events());
    assert.deepEqual(events.at(-1), {
      kind: "failed",
      category: "unsupported-selection",
    });
    assert.equal(binding.effectiveProfile(), undefined);
  }
});

test("Claude treats a documented absent effort field as the effective default only for a no-effort model", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-default-effort-session-private",
    "Reply with exactly UAW_FAKE_DEFAULT_EFFORT",
    "UAW_FAKE_DEFAULT_EFFORT",
    false,
    { omitEffort: true },
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "default",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const binding = await adapter.start({ projectDirectory: "project", profile });
  await binding.send({ text: "Reply with exactly UAW_FAKE_DEFAULT_EFFORT" });

  assert.deepEqual((await collect(binding.events())).at(-1), {
    kind: "turn-completed",
    status: "completed",
  });
  assert.deepEqual(binding.effectiveProfile(), profile);
});

test("Claude derives turn start from the accepted input plus system init when stdout omits a user echo", async () => {
  const transport = new SuccessfulSessionTransport(
    "native-no-echo-session-private",
    "Reply with exactly UAW_FAKE_NO_ECHO",
    "UAW_FAKE_NO_ECHO",
    false,
    { echoUser: false },
  );
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  const binding = await adapter.start({
    projectDirectory: "project",
    profile: {
      model: "opus-alias",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "Reply with exactly UAW_FAKE_NO_ECHO" });
  assert.deepEqual(await collect(binding.events()), [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "UAW_FAKE_NO_ECHO" },
    { kind: "turn-completed", status: "completed" },
  ]);
});

test("Claude rejects malformed start and send shapes through fixed errors", async () => {
  let sessionFactoryCalls = 0;
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => {
      sessionFactoryCalls += 1;
      return new SuccessfulSessionTransport(
        "native-adversarial-session-private",
        "Reply with exactly UAW_FAKE_ADVERSARIAL",
        "UAW_FAKE_ADVERSARIAL",
      );
    },
  );
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  await assert.rejects(
    () =>
      adapter.start({
        projectDirectory: 42,
        profile,
      } as never),
    fixedRuntimeError("invalid-input"),
  );
  assert.equal(sessionFactoryCalls, 0);

  const binding = await adapter.start({ projectDirectory: "project", profile });
  const getterInput = Object.defineProperty({}, "text", {
    enumerable: true,
    get() {
      throw new Error("private-getter-must-not-run");
    },
  });
  await assert.rejects(
    () => binding.send(getterInput as never),
    fixedRuntimeError("invalid-input"),
  );
});

test("Claude maps cleanup failure after rejected session initialization to one fixed category", async () => {
  const transport = new InitializationTransport({ models: [] });
  transport.stop = async () => {
    throw new Error("private-shutdown-detail");
  };
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => transport,
  );
  await assert.rejects(
    () =>
      adapter.start({
        projectDirectory: "project",
        profile: {
          model: "opus-alias",
          effortLevel: "high",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
      }),
    fixedRuntimeError("runtime-shutdown"),
  );
});

test("Claude Ask when needed completes allow and deny approval turns while resume keeps its captured mode", async () => {
  const firstTransport = new ApprovalSessionTransport(
    "native-manual-session-private",
    "manual-first",
    "manual-first-ok",
    "tool-first",
    "default",
    {
      requestExtras: {
        agent_id: "agent-private",
        blocked_path: "C:\\outside\\synthetic.txt",
        decision_reason: "The requested path is outside the allowed roots.",
        title: "Claude wants to read a file outside the project",
        display_name: "Read external file",
        description: "Read one file from outside the current project.",
        permission_suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Read", ruleContent: "C:\\outside\\**" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      },
    },
  );
  const resumedTransport = new ApprovalSessionTransport(
    "native-manual-session-private",
    "manual-resume",
    "manual-resume-ok",
    "tool-resume",
  );
  const bypassTransport = new SuccessfulSessionTransport(
    "native-bypass-session-private",
    "bypass-new",
    "bypass-new-ok",
  );
  const transports: ClaudeCatalogTransport[] = [
    firstTransport,
    resumedTransport,
    bypassTransport,
  ];
  const sessionRequests: ClaudeSessionTransportRequest[] = [];
  const approvalRequests: ClaudeToolPermissionRequest[] = [];
  let selectedMode: ClaudePermissionMode = "manual";
  let permissionReads = 0;
  const adapter = new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async (request) => {
      sessionRequests.push(structuredClone(request));
      return transports.shift()!;
    },
    undefined,
    {
      async readPermissionMode() {
        permissionReads += 1;
        return selectedMode;
      },
      async requestToolPermission(request) {
        approvalRequests.push(request);
        return request.toolUseId === "tool-first"
          ? Object.freeze({ behavior: "allow" as const })
          : Object.freeze({
              behavior: "deny" as const,
              message: "Synthetic user denial.",
            });
      },
    },
  );
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });

  const first = await adapter.start({ projectDirectory: "project", profile });
  await first.send({ text: "manual-first" });
  assert.equal((await collect(first.events())).at(-1)?.kind, "turn-completed");

  selectedMode = "bypassPermissions";
  const resumed = await adapter.resume({
    projectDirectory: "project",
    profile,
    opaqueSessionReference: first.opaqueSessionReference,
  });
  await resumed.send({ text: "manual-resume" });
  assert.equal((await collect(resumed.events())).at(-1)?.kind, "turn-completed");

  const bypass = await adapter.start({ projectDirectory: "project", profile });
  await bypass.send({ text: "bypass-new" });
  assert.equal((await collect(bypass.events())).at(-1)?.kind, "turn-completed");

  assert.equal(permissionReads, 2);
  assert.deepEqual(
    sessionRequests.map((request) => ({
      permissionMode: request.permissionMode,
      resumeSessionIdentity: request.resumeSessionIdentity,
    })),
    [
      { permissionMode: "manual", resumeSessionIdentity: undefined },
      {
        permissionMode: "manual",
        resumeSessionIdentity: "native-manual-session-private",
      },
      { permissionMode: "bypassPermissions", resumeSessionIdentity: undefined },
    ],
  );
  assert.deepEqual(
    approvalRequests.map((request) => ({
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      input: request.input,
      agentId: request.agentId,
      blockedPath: request.blockedPath,
      decisionReason: request.decisionReason,
      title: request.title,
      displayName: request.displayName,
      description: request.description,
      frozen: Object.isFrozen(request.input),
    })),
    [
      {
        toolName: "Read",
        toolUseId: "tool-first",
        input: { path: "synthetic.txt" },
        agentId: "agent-private",
        blockedPath: "C:\\outside\\synthetic.txt",
        decisionReason: "The requested path is outside the allowed roots.",
        title: "Claude wants to read a file outside the project",
        displayName: "Read external file",
        description: "Read one file from outside the current project.",
        frozen: true,
      },
      {
        toolName: "Read",
        toolUseId: "tool-resume",
        input: { path: "synthetic.txt" },
        agentId: undefined,
        blockedPath: undefined,
        decisionReason: undefined,
        title: undefined,
        displayName: undefined,
        description: undefined,
        frozen: true,
      },
    ],
  );
  assert.deepEqual(firstTransport.permissionResponse, {
    behavior: "allow",
    updatedInput: { path: "synthetic.txt" },
  });
  assert.deepEqual(resumedTransport.permissionResponse, {
    behavior: "deny",
    message: "Synthetic user denial.",
  });
  assert.equal(firstTransport.executedTools, 1);
  assert.equal(resumedTransport.executedTools, 0);
});

test("Claude Ask when needed rejects malformed and duplicate permission requests before tool execution", async () => {
  const fixtures = [
    {
      name: "missing tool use id",
      options: { requestExtras: { tool_use_id: undefined } },
    },
    { name: "empty agent id", options: { requestExtras: { agent_id: "" } } },

  ] as const;
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent" as const,
    accessMode: "full-access" as const,
  });

  for (const fixture of fixtures) {
    let handlerCalls = 0;
    const transport = new ApprovalSessionTransport(
      `native-${fixture.name.replaceAll(" ", "-")}`,
      fixture.name,
      "must-not-complete",
      `tool-${fixture.name.replaceAll(" ", "-")}`,
      "default",
      fixture.options,
    );
    const binding = await new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => transport,
      undefined,
      {
        readPermissionMode: async () => "manual",
        requestToolPermission: async () => {
          handlerCalls += 1;
          return Object.freeze({ behavior: "allow" as const });
        },
      },
    ).start({ projectDirectory: "project", profile });
    await binding.send({ text: fixture.name });
    assert.deepEqual((await collect(binding.events())).at(-1), {
      kind: "failed",
      category: "protocol-invalid",
    });
    assert.equal(handlerCalls, 0);
    assert.equal(transport.executedTools, 0);
  }

  for (const duplicateKind of ["request-id", "tool-use-id"] as const) {
    let duplicateHandlerCalls = 0;
    const duplicate = new ApprovalSessionTransport(
      `native-duplicate-${duplicateKind}`,
      `duplicate ${duplicateKind}`,
      "must-not-complete",
      `tool-duplicate-${duplicateKind}`,
      "default",
      { duplicateAfterResponse: duplicateKind },
    );
    const duplicateBinding = await new ClaudeAdapter(
      async () => {
        throw new Error("catalog transport is not the session transport");
      },
      async () => duplicate,
      undefined,
      {
        readPermissionMode: async () => "manual",
        requestToolPermission: async () => {
          duplicateHandlerCalls += 1;
          return Object.freeze({ behavior: "allow" as const });
        },
      },
    ).start({ projectDirectory: "project", profile });
    await duplicateBinding.send({ text: `duplicate ${duplicateKind}` });
    assert.deepEqual((await collect(duplicateBinding.events())).at(-1), {
      kind: "failed",
      category: "correlation-invalid",
    });
    assert.equal(duplicateHandlerCalls, 1);
    assert.equal(duplicate.executedTools, 0);
  }
});

test("Claude Ask when needed fails closed when the reported permission mode or approval decision drifts", async () => {
  const profile = Object.freeze({
    model: "opus-alias",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  const wrongMode = new ApprovalSessionTransport(
    "native-wrong-mode-session-private",
    "wrong-mode",
    "must-not-complete",
    "tool-wrong",
    "bypassPermissions",
  );
  const wrongModeBinding = await new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => wrongMode,
    undefined,
    {
      async readPermissionMode() {
        return "manual";
      },
      async requestToolPermission() {
        return Object.freeze({ behavior: "allow" as const });
      },
    },
  ).start({ projectDirectory: "project", profile });
  await wrongModeBinding.send({ text: "wrong-mode" });
  assert.deepEqual((await collect(wrongModeBinding.events())).at(-1), {
    kind: "failed",
    category: "unsupported-selection",
  });

  const invalidDecision = new ApprovalSessionTransport(
    "native-invalid-decision-session-private",
    "invalid-decision",
    "must-not-complete",
    "tool-invalid",
  );
  const invalidDecisionBinding = await new ClaudeAdapter(
    async () => {
      throw new Error("catalog transport is not the session transport");
    },
    async () => invalidDecision,
    undefined,
    {
      async readPermissionMode() {
        return "manual";
      },
      requestToolPermission: async () =>
        ({ behavior: "allow", extra: true }) as never,
    },
  ).start({ projectDirectory: "project", profile });
  await invalidDecisionBinding.send({ text: "invalid-decision" });
  assert.deepEqual((await collect(invalidDecisionBinding.events())).at(-1), {
    kind: "failed",
    category: "approval-required",
  });
});

test("Claude production catalog transport is headless, pipe-only, and never uses bare or a prompt", async () => {
  const source = await readFile(
    new URL(
      "../../src/agent-runtime/claude/process-transport.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /windowsHide:\s*true/u);
  assert.match(source, /stdio:\s*"pipe"/u);
  assert.match(source, /"--input-format",\s*"stream-json"/u);
  assert.match(source, /"--output-format",\s*"stream-json"/u);
  assert.match(source, /"--strict-mcp-config"/u);
  assert.doesNotMatch(source, /["']--bare["']/u);
  assert.doesNotMatch(source, /["']--print["']|["']-p["']/u);
});

class InitializationTransport implements ClaudeCatalogTransport {
  readonly sent: Record<string, unknown>[] = [];
  readonly #response: unknown;
  readonly #leadingFrameType: string | undefined;
  readonly #settingsResponse: unknown;
  #lines: string[] = [];
  stopped = 0;
  userFrames = 0;

  constructor(
    response: unknown,
    leadingFrameType?: string,
    settingsResponse: unknown = claudeSettingsResponse("high", false),
  ) {
    this.#response = response;
    this.#leadingFrameType = leadingFrameType;
    this.#settingsResponse = settingsResponse;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    const request = message.request as Record<string, unknown> | undefined;
    this.sent.push(message);
    if (message.type === "user") this.userFrames += 1;
    if (this.#leadingFrameType !== undefined) {
      this.#lines.push(JSON.stringify({ type: this.#leadingFrameType }));
    }
    this.#lines.push(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response:
            request?.subtype === "get_settings"
              ? this.#settingsResponse
              : this.#response,
        },
      }),
    );
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class SuccessfulSessionTransport implements ClaudeCatalogTransport {
  readonly sent: Record<string, unknown>[] = [];
  readonly #nativeSessionCanary: string;
  readonly #prompt: string;
  readonly #reply: string;
  readonly #withToolFrames: boolean;
  readonly #reported: {
    readonly model?: string;
    readonly permission?: string;
    readonly effort?: string;
    readonly catalogModels?: readonly unknown[];
    readonly echoUser?: boolean;
    readonly prependUnknownAssistantBlock?: boolean;
    readonly omitEffort?: boolean;
    readonly usage?: unknown;
    readonly settingsEffort?: string | null;
    readonly settingsUltracode?: boolean;
    readonly settingsResponse?: unknown;
    readonly apiRetrySystemFrames?: boolean;
    readonly omitToolUseName?: boolean;
    readonly toolUseInput?: unknown;
    readonly postResultFrames?: readonly unknown[];
  };
  readonly #lines: string[] = [];
  #hookCallbackId = "";
  stopped = 0;

  constructor(
    nativeSessionCanary: string,
    prompt: string,
    reply: string,
    withToolFrames = false,
    reported: {
      readonly model?: string;
      readonly permission?: string;
      readonly effort?: string;
      readonly catalogModels?: readonly unknown[];
      readonly echoUser?: boolean;
      readonly prependUnknownAssistantBlock?: boolean;
      readonly omitEffort?: boolean;
      readonly usage?: unknown;
      readonly settingsEffort?: string | null;
      readonly settingsUltracode?: boolean;
      readonly settingsResponse?: unknown;
      readonly apiRetrySystemFrames?: boolean;
      readonly omitToolUseName?: boolean;
      readonly toolUseInput?: unknown;
      readonly postResultFrames?: readonly unknown[];
    } = {},
  ) {
    this.#nativeSessionCanary = nativeSessionCanary;
    this.#prompt = prompt;
    this.#reply = reply;
    this.#withToolFrames = withToolFrames;
    this.#reported = reported;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === "control_request") {
      const request = message.request as Record<string, unknown>;
      if (request.subtype === "initialize") {
        const hooks = request.hooks as {
          Stop: { hookCallbackIds: string[] }[];
        };
        this.#hookCallbackId = hooks.Stop[0]!.hookCallbackIds[0]!;
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {
                models:
                  this.#reported.catalogModels ??
                  [
                    {
                      value: "opus-alias",
                      resolvedModel: "claude-opus-canonical",
                      displayName: "Opus",
                      description: "Complex work",
                      ...(this.#reported.omitEffort === true
                        ? {}
                        : {
                            supportsEffort: true,
                            supportedEffortLevels: ["low", "high", "max"],
                          }),
                    },
                  ],
              },
            },
          }),
        );
      }
      if (request.subtype === "get_settings") {
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response:
                this.#reported.settingsResponse ??
                claudeSettingsResponse(
                  this.#reported.settingsEffort ??
                    this.#reported.effort ??
                    "high",
                  this.#reported.settingsUltracode ?? false,
                ),
            },
          }),
        );
      }
      return;
    }
    if (message.type === "user") {
      const prefix = [
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: this.#reported.model ?? "claude-opus-canonical",
          permissionMode: this.#reported.permission ?? "bypassPermissions",
          capabilities: [
            "interrupt_receipt_v1",
            "interrupt_cancel_queued_v1",
          ],
          session_id: this.#nativeSessionCanary,
        }),
      ];
      if (this.#reported.echoUser !== false) {
        prefix.push(
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "text", text: this.#prompt }],
            },
            parent_tool_use_id: null,
            session_id: this.#nativeSessionCanary,
          }),
        );
      }
      if (this.#withToolFrames) {
        if (this.#reported.apiRetrySystemFrames === true) {
          // The provider-retry shape whose silence made a stalled turn look
          // dead (issue #6 case 4 / case 2's perceived hang).
          prefix.push(
            JSON.stringify({
              type: "system",
              subtype: "api_retry",
              session_id: this.#nativeSessionCanary,
            }),
            JSON.stringify({
              type: "system",
              subtype: "api_retry",
              session_id: this.#nativeSessionCanary,
            }),
          );
        }
        prefix.push(
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private", signature: "private" },
                {
                  type: "tool_use",
                  id: "tool-fixed",
                  ...(this.#reported.omitToolUseName === true
                    ? {}
                    : { name: "Read" }),
                  input: this.#reported.toolUseInput ?? {
                    path: "src/agent-runtime/index.ts",
                    private_payload: "do not copy this whole input object",
                  },
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: this.#nativeSessionCanary,
          }),
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-fixed",
                  content: "private tool result",
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: this.#nativeSessionCanary,
            tool_use_result: { private: true },
          }),
          JSON.stringify({
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed" },
            session_id: this.#nativeSessionCanary,
          }),
        );
      }
      this.#lines.push(
        ...prefix,
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              ...(this.#reported.prependUnknownAssistantBlock === true
                ? [{ type: "future_provider_block", private: true }]
                : []),
              { type: "text", text: this.#reply },
            ],
          },
          parent_tool_use_id: null,
          session_id: this.#nativeSessionCanary,
        }),
        JSON.stringify({
          type: "control_request",
          request_id: "stop-hook-request",
          request: {
            subtype: "hook_callback",
            callback_id: this.#hookCallbackId,
            input: {
              hook_event_name: "Stop",
              session_id: this.#nativeSessionCanary,
              permission_mode:
                this.#reported.permission ?? "bypassPermissions",
              ...(this.#reported.omitEffort === true
                ? {}
                : { effort: { level: this.#reported.effort ?? "high" } }),
            },
          },
        }),
      );
      return;
    }
    if (message.type === "control_response") {
      this.#lines.push(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: this.#reply,
          terminal_reason: "completed",
          session_id: this.#nativeSessionCanary,
          ...(this.#reported.usage === undefined
            ? {}
            : { usage: this.#reported.usage }),
        }),
        ...(this.#reported.postResultFrames ?? []).map((frame) =>
          JSON.stringify(frame),
        ),
      );
    }
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  finishInput(): void {}

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

interface ApprovalSessionFixtureOptions {
  readonly requestExtras?: Readonly<Record<string, unknown>>;
  readonly messageExtras?: Readonly<Record<string, unknown>>;
  readonly duplicateAfterResponse?: "request-id" | "tool-use-id";
}

class ApprovalSessionTransport implements ClaudeCatalogTransport {
  readonly #lines: string[] = [];
  readonly #session: string;
  readonly #prompt: string;
  readonly #reply: string;
  readonly #toolUseId: string;
  readonly #reportedPermissionMode: "default" | "manual" | "bypassPermissions";
  readonly #options: ApprovalSessionFixtureOptions;
  #stopHookCallbackId = "";
  permissionResponse: unknown;
  executedTools = 0;
  stopped = 0;

  constructor(
    session: string,
    prompt: string,
    reply: string,
    toolUseId: string,
    reportedPermissionMode:
      | "default"
      | "manual"
      | "bypassPermissions" = "default",
    options: ApprovalSessionFixtureOptions = {},
  ) {
    this.#session = session;
    this.#prompt = prompt;
    this.#reply = reply;
    this.#toolUseId = toolUseId;
    this.#reportedPermissionMode = reportedPermissionMode;
    this.#options = options;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "control_request") {
      const request = message.request as Record<string, unknown>;
      if (request.subtype === "initialize") {
        const hooks = request.hooks as {
          Stop: { hookCallbackIds: string[] }[];
        };
        this.#stopHookCallbackId = hooks.Stop[0]!.hookCallbackIds[0]!;
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {
                models: [
                  {
                    value: "opus-alias",
                    resolvedModel: "claude-opus-canonical",
                    supportsEffort: true,
                    supportedEffortLevels: ["high"],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.subtype === "get_settings") {
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: claudeSettingsResponse("high", false),
            },
          }),
        );
      }
      return;
    }
    if (message.type === "user") {
      this.#lines.push(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-opus-canonical",
          permissionMode: this.#reportedPermissionMode,
          session_id: this.#session,
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: this.#prompt }],
          },
          parent_tool_use_id: null,
          session_id: this.#session,
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: this.#toolUseId,
                name: "Read",
                input: { path: "synthetic.txt" },
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: this.#session,
        }),
        JSON.stringify({
          type: "control_request",
          request_id: `permission-${this.#toolUseId}`,
          request: {
            subtype: "can_use_tool",
            tool_name: "Read",
            input: { path: "synthetic.txt" },
            tool_use_id: this.#toolUseId,
            ...this.#options.requestExtras,
          },
          ...this.#options.messageExtras,
        }),
      );
      return;
    }
    if (message.type !== "control_response") return;
    const response = message.response as Record<string, unknown>;
    if (response.request_id === `permission-${this.#toolUseId}`) {
      this.permissionResponse = structuredClone(response.response);
      if (this.#options.duplicateAfterResponse !== undefined) {
        this.#lines.push(
          JSON.stringify({
            type: "control_request",
            request_id:
              this.#options.duplicateAfterResponse === "request-id"
                ? `permission-${this.#toolUseId}`
                : `permission-replay-${this.#toolUseId}`,
            request: {
              subtype: "can_use_tool",
              tool_name: "Read",
              input: { path: "synthetic.txt" },
              tool_use_id: this.#toolUseId,
            },
          }),
        );
        return;
      }
      const permissionDecision = response.response as Record<string, unknown>;
      const allowed = permissionDecision.behavior === "allow";
      if (allowed) this.executedTools += 1;
      this.#lines.push(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: this.#toolUseId,
                content: allowed
                  ? "synthetic result"
                  : "Synthetic tool execution was denied.",
                is_error: !allowed,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: this.#session,
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: this.#reply }],
          },
          parent_tool_use_id: null,
          session_id: this.#session,
        }),
        JSON.stringify({
          type: "control_request",
          request_id: `stop-${this.#toolUseId}`,
          request: {
            subtype: "hook_callback",
            callback_id: this.#stopHookCallbackId,
            input: {
              hook_event_name: "Stop",
              session_id: this.#session,
              permission_mode:
                this.#reportedPermissionMode === "default"
                  ? "manual"
                  : this.#reportedPermissionMode,
              effort: { level: "high" },
            },
          },
        }),
      );
      return;
    }
    this.#lines.push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: this.#reply,
        terminal_reason: "completed",
        session_id: this.#session,
      }),
    );
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class CorrelationRejectingSessionTransport implements ClaudeCatalogTransport {
  readonly #lines: string[] = [];
  readonly #fixture: (typeof correlationRejectionFixtures)[number]["fixture"];
  readonly #session = "native-correlation-session-private";
  stopped = 0;

  constructor(
    fixture: (typeof correlationRejectionFixtures)[number]["fixture"],
  ) {
    this.#fixture = fixture;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "control_request") {
      const request = message.request as Record<string, unknown>;
      if (request.subtype === "initialize") {
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {
                models: [
                  {
                    value: "opus-alias",
                    resolvedModel: "claude-opus-canonical",
                    displayName: "Opus",
                    description: "Complex work",
                    supportsEffort: true,
                    supportedEffortLevels: ["high"],
                  },
                ],
              },
            },
          }),
        );
      }
      if (request.subtype === "get_settings") {
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: claudeSettingsResponse("high", false),
            },
          }),
        );
      }
      return;
    }
    if (message.type !== "user") return;

    const init = {
      type: "system",
      subtype: "init",
      model: "claude-opus-canonical",
      permissionMode: "bypassPermissions",
      session_id: this.#session,
    };
    const inputEcho = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Reply with exactly UAW_FAKE_CORRELATION" },
        ],
      },
      parent_tool_use_id: null,
      session_id: this.#session,
    };
    const interruptMarker = {
      type: "user",
      message: {
        role: "user",
        content: "[Request interrupted by user]",
      },
      parent_tool_use_id: null,
      session_id: this.#session,
    };
    const unknownUser = {
      type: "user",
      message: { role: "user", content: "UAW_UNRECOGNIZED_USER" },
      parent_tool_use_id: null,
      session_id: this.#session,
    };
    const postInterruptTextFrame = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "UAW_POST_INTERRUPT_TEXT" }],
      },
      parent_tool_use_id: null,
      session_id: this.#session,
      timestamp: "synthetic-timestamp",
      uuid: "synthetic-frame-uuid",
    };
    const assistant = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "UAW_ASSISTANT" }],
      },
      parent_tool_use_id: null,
      session_id: this.#session,
    };
    const frames: readonly Record<string, unknown>[] = (() => {
      switch (this.#fixture) {
        case "user-before-session-started":
          return [inputEcho];
        case "user-input-echo-repeated":
          return [init, inputEcho, inputEcho];
        case "interrupt-marker-unconfirmed-or-repeated":
          return [init, interruptMarker];
        case "post-interrupt-text-frame-unconfirmed":
          return [init, postInterruptTextFrame];
        case "user-frame-unrecognized":
          return [init, unknownUser];
        case "assistant-before-turn-started":
          return [assistant];
        case "assistant-parent-tool-use":
          return [init, { ...assistant, parent_tool_use_id: "tool-parent" }];
      }
    })();
    this.#lines.push(...frames.map((frame) => JSON.stringify(frame)));
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

interface InterruptibleResultDrift {
  /** Omit the post-receipt Stop-hook echo entirely (mid-stream interrupt). */
  readonly omitStopHook?: boolean;
  /** Spell a terminal_reason this build has never seen. */
  readonly terminalReason?: string;
  /** Spell a result subtype this build has never seen. */
  readonly subtype?: string;
}

class InterruptibleSessionTransport implements ClaudeCatalogTransport {
  readonly #lines: string[] = [];
  #hookCallbackId = "";
  readonly #session = "native-interrupt-session-private";
  readonly #postReceiptFrame:
    | "synthetic-marker"
    | "unrecognized-text-block";
  readonly #emitInputEcho: boolean;
  readonly #resultDrift: InterruptibleResultDrift;
  interruptRequest: Record<string, unknown> | undefined;
  stopped = 0;

  constructor(
    postReceiptFrame:
      | "synthetic-marker"
      | "unrecognized-text-block" = "synthetic-marker",
    emitInputEcho = true,
    resultDrift: InterruptibleResultDrift = {},
  ) {
    this.#postReceiptFrame = postReceiptFrame;
    this.#emitInputEcho = emitInputEcho;
    this.#resultDrift = resultDrift;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "control_request") {
      const request = message.request as Record<string, unknown>;
      if (request.subtype === "initialize") {
        const hooks = request.hooks as {
          Stop: { hookCallbackIds: string[] }[];
        };
        this.#hookCallbackId = hooks.Stop[0]!.hookCallbackIds[0]!;
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: {
                models: [
                  {
                    value: "opus-alias",
                    resolvedModel: "claude-opus-canonical",
                    displayName: "Opus",
                    description: "Complex work",
                    supportsEffort: true,
                    supportedEffortLevels: ["high"],
                  },
                ],
              },
            },
          }),
        );
        return;
      }
      if (request.subtype === "get_settings") {
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: claudeSettingsResponse("high", false),
            },
          }),
        );
        return;
      }
      if (request.subtype === "interrupt") {
        this.interruptRequest = { ...request };
        const postReceiptUserFrame =
          this.#postReceiptFrame === "synthetic-marker"
            ? {
                type: "user",
                message: {
                  role: "user",
                  content: "[Request interrupted by user]",
                },
                parent_tool_use_id: null,
                session_id: this.#session,
              }
            : {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    { type: "text", text: "UAW_UNRECOGNIZED_POST_RECEIPT" },
                  ],
                },
                parent_tool_use_id: null,
                session_id: this.#session,
                timestamp: "synthetic-timestamp",
                uuid: "synthetic-frame-uuid",
              };
        this.#lines.push(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: message.request_id,
              response: { still_queued: [], cancelled: [] },
            },
          }),
          JSON.stringify(postReceiptUserFrame),
          ...(this.#resultDrift.omitStopHook
            ? []
            : [
                JSON.stringify({
                  type: "control_request",
                  request_id: "interrupt-stop-hook",
                  request: {
                    subtype: "hook_callback",
                    callback_id: this.#hookCallbackId,
                    input: {
                      hook_event_name: "Stop",
                      session_id: this.#session,
                      permission_mode: "bypassPermissions",
                      effort: { level: "high" },
                    },
                  },
                }),
              ]),
          JSON.stringify({
            type: "result",
            subtype:
              this.#resultDrift.subtype ?? "error_during_execution",
            is_error: true,
            terminal_reason:
              this.#resultDrift.terminalReason ?? "aborted_streaming",
            session_id: this.#session,
          }),
        );
        return;
      }
    }
    if (message.type === "user") {
      this.#lines.push(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-opus-canonical",
          permissionMode: "bypassPermissions",
          capabilities: [
            "interrupt_receipt_v1",
            "interrupt_cancel_queued_v1",
          ],
          session_id: this.#session,
        }),
        ...(this.#emitInputEcho
          ? [
              JSON.stringify({
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Reply slowly with UAW_FAKE_INTERRUPT",
                    },
                  ],
                },
                parent_tool_use_id: null,
                session_id: this.#session,
              }),
            ]
          : []),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "UAW_FAKE_" }],
          },
          parent_tool_use_id: null,
          session_id: this.#session,
        }),
      );
    }
  }

  async receive(): Promise<string | null> {
    return this.#lines.shift() ?? null;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class SteerableSessionTransport implements ClaudeCatalogTransport {
  readonly sessionIdentity = "native-steer-session-private";
  readonly sent: Record<string, unknown>[] = [];
  readonly systemSessionIdentities: string[] = [];
  readonly #lines: string[] = [];
  readonly #receivers: ((line: string | null) => void)[] = [];
  #hookCallbackId = "";
  #interruptReceiptRead = false;
  #resolveOldLegResultRead!: () => void;
  readonly oldLegResultRead = new Promise<void>((resolve) => {
    this.#resolveOldLegResultRead = resolve;
  });
  correctionWrittenAfterReceipt = false;
  stopped = 0;

  get steeringWrites(): Record<string, unknown>[] {
    return this.sent
      .filter((message) => {
        const request = message.request as Record<string, unknown> | undefined;
        return request?.subtype === "interrupt" ||
          (message.type === "user" && message.session_id !== "");
      })
      .map((message) => {
        if (message.type === "control_request") {
          return { type: message.type, request: message.request };
        }
        return message;
      });
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === "control_request") {
      const request = message.request as Record<string, unknown>;
      if (request.subtype === "initialize") {
        const hooks = request.hooks as {
          Stop: { hookCallbackIds: string[] }[];
        };
        this.#hookCallbackId = hooks.Stop[0]!.hookCallbackIds[0]!;
        this.#push({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: {
              models: [
                {
                  value: "opus-alias",
                  resolvedModel: "claude-opus-canonical",
                  supportsEffort: true,
                  supportedEffortLevels: ["high"],
                },
              ],
            },
          },
        });
        return;
      }
      if (request.subtype === "get_settings") {
        this.#push({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: claudeSettingsResponse("high", false),
          },
        });
        return;
      }
      if (request.subtype === "interrupt") {
        this.#push({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: { still_queued: [], cancelled: [] },
          },
        });
        return;
      }
    }
    if (message.type !== "user") return;
    if (message.session_id === "") {
      this.#push(
        this.#init(this.sessionIdentity),
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "WRONG=41; first finish COMPLETED_STEP=alpha",
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: this.sessionIdentity,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "COMPLETED_STEP=alpha" }],
          },
          parent_tool_use_id: null,
          session_id: this.sessionIdentity,
        },
      );
      return;
    }
    this.correctionWrittenAfterReceipt = this.#interruptReceiptRead;
    this.#push(
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
        parent_tool_use_id: null,
        session_id: this.sessionIdentity,
        timestamp: "synthetic-timestamp",
        uuid: "synthetic-interrupt-marker",
      },
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        result: null,
        session_id: this.sessionIdentity,
      },
    );
  }

  continueCorrectedLeg(sessionIdentity = this.sessionIdentity): void {
    this.#push(
      this.#init(sessionIdentity),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "COMPLETED_STEP=alpha; CORRECT=73" },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionIdentity,
      },
      {
        type: "control_request",
        request_id: "steer-stop-hook",
        request: {
          subtype: "hook_callback",
          callback_id: this.#hookCallbackId,
          input: {
            hook_event_name: "Stop",
            session_id: sessionIdentity,
            permission_mode: "bypassPermissions",
            effort: { level: "high" },
          },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "completed",
        result: "COMPLETED_STEP=alpha; CORRECT=73",
        session_id: sessionIdentity,
      },
    );
  }

  async receive(): Promise<string | null> {
    const line = this.#lines.shift();
    const received = line ?? await new Promise<string | null>((resolve) => {
      this.#receivers.push(resolve);
    });
    if (received !== null) {
      const message = JSON.parse(received) as Record<string, unknown>;
      if (message.type === "system" && message.subtype === "init") {
        this.systemSessionIdentities.push(String(message.session_id));
      }
      if (message.type === "control_response") {
        const response = message.response as Record<string, unknown>;
        if (response.request_id === this.#interruptRequestId()) {
          this.#interruptReceiptRead = true;
        }
      }
      if (
        message.type === "result" &&
        message.terminal_reason === "aborted_streaming"
      ) {
        this.#resolveOldLegResultRead();
      }
    }
    return received;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
    while (this.#receivers.length > 0) this.#receivers.shift()!(null);
  }

  #init(sessionIdentity: string): Record<string, unknown> {
    return {
      type: "system",
      subtype: "init",
      model: "claude-opus-canonical",
      permissionMode: "bypassPermissions",
      capabilities: [
        "interrupt_receipt_v1",
        "interrupt_cancel_queued_v1",
      ],
      session_id: sessionIdentity,
    };
  }

  #interruptRequestId(): unknown {
    return this.sent.find((message) => {
      const request = message.request as Record<string, unknown> | undefined;
      return request?.subtype === "interrupt";
    })?.request_id;
  }

  #push(...messages: Record<string, unknown>[]): void {
    for (const message of messages) {
      const line = JSON.stringify(message);
      const receiver = this.#receivers.shift();
      if (receiver === undefined) this.#lines.push(line);
      else receiver(line);
    }
  }
}

function claudeSettingsResponse(
  effort: string | null,
  ultracode: boolean,
): Record<string, unknown> {
  return {
    effective: { effortLevel: effort, ultracode },
    sources: [
      {
        source: "flagSettings",
        settings: { effortLevel: effort, ultracode },
      },
    ],
    applied: {
      model: "opus-alias",
      effort,
      advisor: null,
      ultracode,
    },
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

async function collectIterator<T>(
  iterator: AsyncIterator<T>,
  observe: (value: T) => void = () => undefined,
): Promise<T[]> {
  const collected: T[] = [];
  for (;;) {
    const result = await iterator.next();
    if (result.done) return collected;
    collected.push(result.value);
    observe(result.value);
  }
}

function fixedRuntimeError(category: RuntimeAdapterError["category"]) {
  return (error: unknown) =>
    error instanceof RuntimeAdapterError &&
    error.category === category &&
    error.message === "Agent Runtime operation failed." &&
    error.stack ===
      "RuntimeAdapterError: Agent Runtime operation failed.";
}

for (const site of ["envelope", "request", "suggestions"] as const) {
  test(`vendor Claude permission ${site}: additions are dropped before handler and response`, async () => {
    const canary = { future_vendor_field: { redacted_thinking: "UNCONSUMED_VENDOR_CANARY" } };
    const options = site === "envelope"
      ? { messageExtras: canary }
      : site === "request"
        ? { requestExtras: canary }
        : { requestExtras: { permission_suggestions: [{ type: "future-suggestion", ...canary }] } };
    const transport = new ApprovalSessionTransport("native-vendor-permission", "prompt", "ANSWER", "tool-vendor", "default", options);
    const requests: ClaudeToolPermissionRequest[] = [];
    const binding = await new ClaudeAdapter(async () => transport, async () => transport, undefined, {
      readPermissionMode: async () => "manual",
      requestToolPermission: async request => { requests.push(request); return { behavior: "allow" }; },
    }).start({ projectDirectory: "project", profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" } });
    await binding.send({ text: "prompt" });
    const events = await collect(binding.events());
    assert.equal(events.at(-1)?.kind, "turn-completed");
    assert.equal(requests.length, 1);
    assert.equal(transport.executedTools, 1);
    const downstream = JSON.stringify({ events, requests, response: transport.permissionResponse });
    assert.equal(downstream.includes("UNCONSUMED_VENDOR_CANARY"), false);
    assert.equal(downstream.includes("future_vendor_field"), false);
  });
}

for (const site of ["envelope", "request"] as const) {
  test(`vendor Claude permission ${site}: missing and malformed required fields stay fatal`, async () => {
    for (const invalid of [undefined, 42]) {
      const options = site === "envelope" ? { messageExtras: { request_id: invalid } } : { requestExtras: { tool_name: invalid } };
      const transport = new ApprovalSessionTransport("native-vendor-required", "prompt", "ANSWER", "tool-vendor", "default", options);
      let handlerCalls = 0;
      const binding = await new ClaudeAdapter(async () => transport, async () => transport, undefined, {
        readPermissionMode: async () => "manual",
        requestToolPermission: async () => { handlerCalls += 1; return { behavior: "allow" }; },
      }).start({ projectDirectory: "project", profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" } });
      await binding.send({ text: "prompt" });
      assert.deepEqual((await collect(binding.events())).at(-1), { kind: "failed", category: "protocol-invalid" });
      assert.equal(handlerCalls, 0);
      assert.equal(transport.executedTools, 0);
    }
  });
}

async function observeVendorInterruptFrame(mutate: (frame: Record<string, any>) => void) {
  const transport = new InterruptibleSessionTransport("unrecognized-text-block", false);
  const receive = transport.receive.bind(transport);
  transport.receive = async () => {
    const line = await receive();
    if (line === null) return line;
    const frame = JSON.parse(line);
    if (frame.type === "user" && frame.timestamp !== undefined) mutate(frame);
    return JSON.stringify(frame);
  };
  const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({ projectDirectory: "project", profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" } });
  await binding.send({ text: "Reply slowly with UAW_FAKE_INTERRUPT" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  const receipt = binding.interrupt!();
  const remaining = collectIterator(iterator);
  await receipt;
  return remaining;
}

test("Claude close starts shutdown and rejects an outstanding interrupt without reading its receipt", async () => {
  const transport = new InterruptibleSessionTransport("unrecognized-text-block", false);
  const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({
    projectDirectory: "project", profile: { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" },
  });
  await binding.send({ text: "Reply slowly with UAW_FAKE_INTERRUPT" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  assert.equal(binding.interruptAvailability(), "available");
  const interrupt = binding.interrupt();
  const rejected = assert.rejects(interrupt, error => error instanceof RuntimeAdapterError && error.category === "runtime-shutdown");
  binding.close?.();
  binding.close?.();
  assert.equal(transport.stopped, 1, "close is idempotent and starts shutdown immediately");
  assert.equal(binding.interruptAvailability(), "unavailable");
  await rejected;
  await iterator.return?.();
});

for (const site of ["envelope", "message", "block"] as const) {
  const target = (frame: Record<string, any>): Record<string, any> => site === "envelope" ? frame : site === "message" ? frame.message : frame.message.content[0];
  test(`vendor Claude interrupt ${site}: additive key is dropped after confirmed receipt`, async () => {
    const events = await observeVendorInterruptFrame(frame => { target(frame).future_vendor_field = { redacted_thinking: "UNCONSUMED_VENDOR_CANARY" }; });
    assert.deepEqual(events, [{ kind: "turn-interrupted", status: "interrupted" }]);
    assert.equal(JSON.stringify(events).includes("UNCONSUMED_VENDOR_CANARY"), false);
  });
  test(`vendor Claude interrupt ${site}: required fields stay fatal`, async () => {
    const key = site === "envelope" ? "uuid" : site === "message" ? "role" : "text";
    for (const missing of [true, false]) {
      const events = await observeVendorInterruptFrame(frame => { if (missing) delete target(frame)[key]; else target(frame)[key] = 42; });
      assert.equal(events.at(-1)?.kind, "failed");
    }
  });
}
