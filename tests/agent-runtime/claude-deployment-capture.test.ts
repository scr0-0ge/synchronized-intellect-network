import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CATALOG_ARGUMENTS,
  createClaudeSessionArguments,
} from "../../src/agent-runtime/claude/process-transport.ts";
import {
  buildClaudeDeploymentCapturePlan,
  evaluateClaudeDeploymentCaptureResponses,
  formatClaudeDeploymentCaptureDisclosure,
} from "../../scripts/validate-claude-deployment.ts";

test("Claude deployment capture plans the byte-identical catalog and Session argv under stripped and provider-preserved environments", () => {
  const plan = buildClaudeDeploymentCapturePlan({
    projectDirectory: "C:\\synthetic-project",
    outputDirectory: "C:\\synthetic-captures",
    sourceEnvironment: {
      SAFE_SETTING: "preserved",
      ANTHROPIC_API_KEY: "PRIVATE_CREDENTIAL_CANARY",
      CLAUDE_CODE_USE_BEDROCK: "1",
    },
    model: "opus-alias",
    includeSessionTurn: false,
  });

  assert.deepEqual(
    plan.environments.map((environment) => ({
      name: environment.name,
      mode: environment.mode,
      selectorKeys: environment.selectorKeys,
      apiKey: environment.environment.ANTHROPIC_API_KEY,
    })),
    [
      {
        name: "stripped",
        mode: "subscription",
        selectorKeys: [],
        apiKey: undefined,
      },
      {
        name: "provider-preserved",
        mode: "bedrock",
        selectorKeys: ["CLAUDE_CODE_USE_BEDROCK"],
        apiKey: undefined,
      },
    ],
  );
  assert.equal(plan.invocations.length, 6);
  for (const environment of plan.environments) {
    const invocations = plan.invocations.filter(
      (invocation) => invocation.environment === environment.name,
    );
    assert.deepEqual(
      invocations.map((invocation) => invocation.kind),
      ["auth-status", "catalog", "session"],
    );
    assert.deepEqual(invocations[0]?.arguments, ["auth", "status", "--json"]);
    assert.deepEqual(invocations[1]?.arguments, CLAUDE_CATALOG_ARGUMENTS);
    assert.deepEqual(
      invocations[2]?.arguments,
      createClaudeSessionArguments({
        projectDirectory: "C:\\synthetic-project",
        profile: {
          model: "opus-alias",
          effortLevel: "xhigh",
          executionMode: "ultracode",
          accessMode: "full-access",
        },
        permissionMode: "bypassPermissions",
      }),
    );
    assert.deepEqual(
      invocations.map((invocation) => invocation.turnConsumption),
      ["zero-turn", "zero-turn", "zero-turn"],
    );
  }
  assert.equal(
    formatClaudeDeploymentCaptureDisclosure(plan),
    "ABOUT_TO_RUN live-claude-invocations=6 zero-turn=6 turn-consuming=0 output=C:\\synthetic-captures",
  );
});

test("Claude deployment capture makes optional Session-turn spend explicit before execution", () => {
  const plan = buildClaudeDeploymentCapturePlan({
    projectDirectory: "project",
    outputDirectory: "captures",
    sourceEnvironment: { CLAUDE_CODE_USE_VERTEX: "true" },
    model: "vertex-model",
    includeSessionTurn: true,
  });

  assert.deepEqual(
    plan.invocations.map((invocation) => invocation.turnConsumption),
    ["zero-turn", "zero-turn", "one-turn", "zero-turn", "zero-turn", "one-turn"],
  );
  assert.equal(
    formatClaudeDeploymentCaptureDisclosure(plan),
    "ABOUT_TO_RUN live-claude-invocations=6 zero-turn=4 turn-consuming=2 output=captures",
  );
});

test("Claude deployment capture rejects an ambiguous provider environment before any invocation", () => {
  assert.throws(
    () =>
      buildClaudeDeploymentCapturePlan({
        projectDirectory: "project",
        outputDirectory: "captures",
        sourceEnvironment: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_VERTEX: "1",
        },
        model: "model",
        includeSessionTurn: false,
      }),
    /exactly one Claude deployment selector/u,
  );
});

test("Claude deployment probe accepts an additive model key through the production parser", () => {
  const projection = evaluateClaudeDeploymentCaptureResponses(
    {
      models: [
        {
          value: "us.anthropic.claude-opus-v1:0",
          futureRoutingHint: "PRIVATE_CAPTURE_VALUE",
        },
      ],
    },
    validCaptureSettings(),
  );

  assert.deepEqual(projection.settingsParser, { outcome: "accepted" });
  assert.deepEqual(projection.catalogParser, {
    outcome: "accepted",
    summary: "models=1",
  });
  assert.deepEqual(projection.observation, {
    toleratedKeys: ["futureRoutingHint"],
    rejections: [],
    rejectionsOmitted: 0,
    toleratedSettingSources: [],
    settingsErrorCount: 0,
  });
});

test("Claude deployment probe keeps a mixed catalog usable and names the rejected row", () => {
  const projection = evaluateClaudeDeploymentCaptureResponses(
    {
      models: [
        { value: "usable-model" },
        { value: "bad-model", displayName: 42 },
      ],
    },
    validCaptureSettings(),
  );

  assert.deepEqual(projection.catalogParser, {
    outcome: "accepted",
    summary: "models=1",
  });
  assert.deepEqual(projection.observation.rejections, [
    {
      row: 1,
      modelId: "bad-model",
      addedKeys: [],
      missingKeys: [],
      invalidKeys: ["displayName"],
    },
  ]);
});

test("Claude deployment probe still rejects a catalog with a missing required model key", () => {
  const projection = evaluateClaudeDeploymentCaptureResponses(
    { models: [{ description: "missing value" }] },
    validCaptureSettings(),
  );

  assert.equal(projection.catalogParser.outcome, "rejected");
  assert.equal(projection.catalogParser.category, "catalog-invalid");
  assert.equal(
    projection.catalogParser.diagnosticKind,
    "catalog-shape-rejected",
  );
  assert.equal(projection.catalogParser.gate, "models");
  assert.equal(projection.catalogParser.row, 0);
  assert.deepEqual(projection.observation.rejections[0]?.missingKeys, [
    "value",
  ]);
  assert.deepEqual(projection.observation.rejections[0]?.invalidKeys, []);
});

test("Claude deployment probe still rejects an unrecognized value on a recognized model key", () => {
  const projection = evaluateClaudeDeploymentCaptureResponses(
    {
      models: [
        {
          value: "invalid-recognized-value",
          supportsEffort: "future-boolean-literal",
          futureRoutingHint: "PRIVATE_MUST_NOT_MASK_INVALID_VALUE",
        },
      ],
    },
    validCaptureSettings(),
  );

  assert.equal(projection.catalogParser.outcome, "rejected");
  assert.equal(projection.catalogParser.gate, "models");
  assert.equal(projection.catalogParser.row, 0);
  assert.deepEqual(projection.observation.rejections[0]?.invalidKeys, [
    "supportsEffort",
  ]);
  assert.deepEqual(projection.observation.rejections[0]?.addedKeys, [
    "futureRoutingHint",
  ]);
  assert.deepEqual(projection.observation.rejections[0]?.missingKeys, []);
  assert.deepEqual(projection.observation.toleratedKeys, []);
});

test("Claude deployment probe treats unknown setting sources and validated errors as diagnostics", () => {
  const settings = validCaptureSettings();
  settings.sources = [
    {
      source: "futureManagedSettings",
      settings: { futureSetting: "PRIVATE_SOURCE_VALUE" },
    },
  ];
  settings.errors = [
    {
      file: "settings.json",
      path: "/project/settings.json",
      message: "PRIVATE_ERROR_DETAIL",
    },
  ];
  const projection = evaluateClaudeDeploymentCaptureResponses(
    { models: [{ value: "settings-drift-model" }] },
    settings,
  );

  assert.deepEqual(projection.settingsParser, { outcome: "accepted" });
  assert.deepEqual(projection.catalogParser, {
    outcome: "accepted",
    summary: "models=1",
  });
  assert.deepEqual(projection.observation.toleratedSettingSources, [
    "futureManagedSettings",
  ]);
  assert.equal(projection.observation.settingsErrorCount, 1);
  assert.equal(JSON.stringify(projection).includes("PRIVATE_SOURCE_VALUE"), false);
  assert.equal(JSON.stringify(projection).includes("PRIVATE_ERROR_DETAIL"), false);
});

test("Claude deployment probe keeps malformed settings errors fatal at get_settings", () => {
  const settings = validCaptureSettings();
  settings.errors = [
    {
      file: "settings.json",
      path: "/project/settings.json",
      message: 42,
    },
  ];
  const projection = evaluateClaudeDeploymentCaptureResponses(
    { models: [{ value: "catalog-remains-independently-parseable" }] },
    settings,
  );

  assert.deepEqual(projection.settingsParser, {
    outcome: "rejected",
    category: "protocol-invalid",
    gate: "get_settings",
  });
  assert.equal(projection.catalogParser.outcome, "accepted");
  assert.equal(projection.observation.settingsErrorCount, 0);
});

function validCaptureSettings(): Record<string, unknown> {
  return {
    effective: { effortLevel: "high" },
    sources: [
      {
        source: "flagSettings",
        settings: { effortLevel: "high" },
      },
    ],
    applied: {
      model: "claude-opus-canonical",
      effort: "high",
      ultracode: false,
    },
    errors: [],
  };
}
