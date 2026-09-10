import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { readClaudeAppliedSettings } from "../../src/agent-runtime/claude/settings.ts";

test("Claude get_settings accepts the exact envelope and returns only the sanitized applied projection", () => {
  const applied = readClaudeAppliedSettings({
    effective: {
      effortLevel: "xhigh",
      model: "opus-alias",
      ultracode: true,
      futureSettingKeptOpaque: { enabled: true },
    },
    sources: [
      {
        settings: {
          ultracode: true,
          futureSettingKeptOpaque: "source-value",
        },
        source: "flagSettings",
      },
      {
        settings: { theme: "dark" },
        source: "userSettings",
      },
    ],
    applied: {
      advisor: null,
      effort: "xhigh",
      model: "claude-opus-canonical",
      ultracode: true,
    },
    errors: [],
  });

  assert.deepEqual(applied, {
    model: "claude-opus-canonical",
    effort: "xhigh",
    advisor: null,
    ultracode: true,
  });
  assert.equal(Object.isFrozen(applied), true);
  assert.deepEqual(Object.keys(applied ?? {}).sort(), [
    "advisor",
    "effort",
    "model",
    "ultracode",
  ]);
});

test("Claude get_settings keeps missing applied data distinct from missing and false ultracode flags", () => {
  const envelope = {
    effective: {},
    sources: [],
    errors: [],
  };

  assert.equal(readClaudeAppliedSettings(envelope), undefined);

  const missingFlag = readClaudeAppliedSettings({
    ...envelope,
    applied: {
      effort: "xhigh",
      model: "claude-opus-canonical",
    },
  });
  assert.deepEqual(missingFlag, {
    model: "claude-opus-canonical",
    effort: "xhigh",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(missingFlag, "ultracode"),
    false,
  );

  const disabledFlag = readClaudeAppliedSettings({
    ...envelope,
    applied: {
      effort: "xhigh",
      model: "claude-opus-canonical",
      ultracode: false,
    },
  });
  assert.deepEqual(disabledFlag, {
    model: "claude-opus-canonical",
    effort: "xhigh",
    ultracode: false,
  });
});

test("Claude get_settings tolerates and records an unknown safe source name while dropping its settings", () => {
  const privateSourceValue = "PRIVATE_MANAGED_SETTING";
  const observation = {
    toleratedSettingSources: new Set<string>(),
    settingsErrorCount: 0,
  };
  const applied = readClaudeAppliedSettings(
    {
      ...validSettingsEnvelope(),
      sources: [
        {
          settings: { futureManagedSetting: privateSourceValue },
          source: "future managed/settings:v2",
        },
      ],
    },
    observation,
  );

  assert.deepEqual(applied, validAppliedSettings());
  assert.deepEqual([...observation.toleratedSettingSources], [
    "future managed/settings:v2",
  ]);
  assert.equal(
    JSON.stringify(applied).includes("future managed/settings:v2"),
    false,
  );
  assert.equal(JSON.stringify(applied).includes(privateSourceValue), false);
});

test("Claude get_settings demotes validated errors to a counted diagnostic and drops their detail", () => {
  const privateErrorDetail = "PRIVATE_SETTINGS_ERROR_DETAIL";
  const observation = {
    toleratedSettingSources: new Set<string>(),
    settingsErrorCount: 0,
  };
  const applied = readClaudeAppliedSettings(
    {
      ...validSettingsEnvelope(),
      errors: [
        {
          file: "settings.json",
          message: privateErrorDetail,
          path: "/project/settings.json",
        },
      ],
    },
    observation,
  );

  assert.deepEqual(applied, validAppliedSettings());
  assert.equal(observation.settingsErrorCount, 1);
  assert.equal(JSON.stringify(applied).includes(privateErrorDetail), false);
  assert.equal(JSON.stringify(applied).includes("settings.json"), false);
});

test("Claude get_settings fails closed on malformed consumed fields and adversarial record shapes", () => {
  const accessorApplied = validSettingsEnvelope();
  Object.defineProperty(accessorApplied.applied, "ultracode", {
    configurable: true,
    enumerable: true,
    get() {
      return true;
    },
  });

  const sparseSources: unknown[] = [];
  sparseSources.length = 1;

  const cases: readonly {
    readonly name: string;
    readonly value: unknown;
  }[] = [



    {
      name: "unsafe source name",
      value: {
        ...validSettingsEnvelope(),
        sources: [
          {
            settings: { ultracode: true },
            source: "future\nSettings",
          },
        ],
      },
    },
    {
      name: "non-string source name",
      value: {
        ...validSettingsEnvelope(),
        sources: [
          {
            settings: { ultracode: true },
            source: 42,
          },
        ],
      },
    },
    {
      name: "unpaired-surrogate source name",
      value: {
        ...validSettingsEnvelope(),
        sources: [
          {
            settings: { ultracode: true },
            source: "future\ud800Settings",
          },
        ],
      },
    },
    {
      name: "missing required applied key",
      value: {
        ...validSettingsEnvelope(),
        applied: {
          model: "claude-opus-canonical",
          ultracode: true,
        },
      },
    },
    {
      name: "effort must be a string or null",
      value: {
        ...validSettingsEnvelope(),
        applied: {
          ...validAppliedSettings(),
          effort: 42,
        },
      },
    },
    {
      name: "non-boolean ultracode flag",
      value: {
        ...validSettingsEnvelope(),
        applied: {
          ...validAppliedSettings(),
          ultracode: "true",
        },
      },
    },
    {
      name: "malformed settings error value",
      value: {
        ...validSettingsEnvelope(),
        errors: [
          {
            file: "settings.json",
            message: 42,
            path: "/project/settings.json",
          },
        ],
      },
    },

    {
      name: "sparse sources array",
      value: {
        ...validSettingsEnvelope(),
        sources: sparseSources,
      },
    },
    {
      name: "proxy envelope",
      value: new Proxy(validSettingsEnvelope(), {}),
    },
    {
      name: "accessor applied field",
      value: accessorApplied,
    },
    {
      name: "non-plain effective record",
      value: {
        ...validSettingsEnvelope(),
        effective: Object.create(null),
      },
    },
  ];

  for (const row of cases) {
    assert.throws(
      () => readClaudeAppliedSettings(row.value),
      isProtocolInvalid,
      row.name,
    );
  }
});

function validSettingsEnvelope() {
  return {
    effective: {
      effortLevel: "xhigh",
      model: "opus-alias",
      ultracode: true,
    },
    sources: [
      {
        settings: { ultracode: true },
        source: "flagSettings",
      },
    ],
    applied: validAppliedSettings(),
    errors: [],
  };
}

function validAppliedSettings() {
  return {
    effort: "xhigh",
    model: "claude-opus-canonical",
    ultracode: true,
  };
}

function isProtocolInvalid(error: unknown): boolean {
  return (
    error instanceof RuntimeAdapterError &&
    error.category === "protocol-invalid" &&
    error.message === "Agent Runtime operation failed."
  );
}
