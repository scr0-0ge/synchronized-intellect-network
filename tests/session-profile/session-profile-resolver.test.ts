import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeCatalog } from "../../src/agent-runtime/index.ts";
import {
  resolveSessionProfile,
  SessionProfileResolutionError,
} from "../../src/session-profile/index.ts";

const codexCatalog: RuntimeCatalog = {
  runtime: "codex",
  models: [
    { id: "gpt-5.6-sol", effortLevels: ["high", "ultra"] },
    { id: "gpt-5.5-codex", effortLevels: ["medium", "high"] },
  ],
  executionModes: ["single-agent", "coordinated"],
  accessModes: ["restricted", "full-access"],
};

test("the desired Codex default resolves with the supplied catalog revision", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-08",
    preferences: {
      global: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    },
  });

  assert.deepEqual(resolved, {
    runtime: "codex",
    profile: {
      model: "gpt-5.6-sol",
      effortLevel: "ultra",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    catalogRevision: "catalog-revision-08",
  });
});

test("Agent Runtime preferences override conflicting global preferences per field", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-runtime",
    preferences: {
      global: {
        model: "gpt-5.5-codex",
        effortLevel: "medium",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      runtime: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    },
  });

  assert.deepEqual(resolved.profile, {
    model: "gpt-5.6-sol",
    effortLevel: "ultra",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
});

test("partial layers resolve independently instead of replacing the whole profile", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-partial-layers",
    preferences: {
      global: {
        model: "gpt-5.5-codex",
        effortLevel: "medium",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      runtime: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
      },
      models: {
        "gpt-5.6-sol": { executionMode: "single-agent" },
      },
    },
    overrides: { accessMode: "full-access" },
  });

  assert.deepEqual(resolved.profile, {
    model: "gpt-5.6-sol",
    effortLevel: "ultra",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
});

test("only the selected model preference layer can override stored intensity and access", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-model",
    preferences: {
      global: {
        model: "gpt-5.5-codex",
        effortLevel: "medium",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      runtime: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      models: {
        "gpt-5.6-sol": {
          effortLevel: "high",
          executionMode: "coordinated",
          accessMode: "restricted",
        },
        "gpt-5.5-codex": {
          effortLevel: "medium",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
      },
    },
  });

  assert.deepEqual(resolved.profile, {
    model: "gpt-5.6-sol",
    effortLevel: "high",
    executionMode: "coordinated",
    accessMode: "restricted",
  });
});

test("explicit overrides select the model first and win independently for every field", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-explicit",
    preferences: {
      global: {
        model: "gpt-5.6-sol",
        effortLevel: "high",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      runtime: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      models: {
        "gpt-5.6-sol": {
          effortLevel: "ultra",
          executionMode: "coordinated",
          accessMode: "restricted",
        },
        "gpt-5.5-codex": {
          effortLevel: "medium",
          executionMode: "coordinated",
          accessMode: "restricted",
        },
      },
    },
    overrides: {
      model: "gpt-5.5-codex",
      effortLevel: "high",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });

  assert.deepEqual(resolved.profile, {
    model: "gpt-5.5-codex",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
});

test("an explicit model selects only that model's stored preferences", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-explicit-model",
    preferences: {
      global: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      models: {
        "gpt-5.6-sol": {
          effortLevel: "high",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        "gpt-5.5-codex": {
          effortLevel: "medium",
          executionMode: "coordinated",
          accessMode: "restricted",
        },
      },
    },
    overrides: { model: "gpt-5.5-codex" },
  });

  assert.deepEqual(resolved.profile, {
    model: "gpt-5.5-codex",
    effortLevel: "medium",
    executionMode: "coordinated",
    accessMode: "restricted",
  });
});

test("every missing effective field fails with the fixed incomplete category", () => {
  const incompletePreferences = [
    { effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access" },
    { model: "gpt-5.6-sol", executionMode: "single-agent", accessMode: "full-access" },
    { model: "gpt-5.6-sol", effortLevel: "ultra", accessMode: "full-access" },
    { model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent" },
  ];

  for (const global of incompletePreferences) {
    assert.throws(
      () =>
        resolveSessionProfile({
          catalog: codexCatalog,
          catalogRevision: "catalog-revision-incomplete",
          preferences: { global },
        }),
      (error) => {
        if (!(error instanceof SessionProfileResolutionError)) return false;
        assert.equal(error.category, "incomplete-profile");
        assert.equal(error.message, "Session Profile resolution failed.");
        assert.equal(error.stack, `${error.name}: ${error.message}`);
        return true;
      },
    );
  }
});

test("unsupported selections fail without downgrade and expose runtime-neutral alternatives", () => {
  const unsupportedProfiles = [
    {
      profile: {
        model: "private-model-value",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      effortLevels: [],
      sentinel: "private-model-value",
    },
    {
      profile: {
        model: "gpt-5.6-sol",
        effortLevel: "private-effort-value",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      effortLevels: ["high", "ultra"],
      sentinel: "private-effort-value",
    },
    {
      profile: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "private-execution-value",
        accessMode: "full-access",
      },
      effortLevels: ["high", "ultra"],
      sentinel: "private-execution-value",
    },
    {
      profile: {
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "private-access-value",
      },
      effortLevels: ["high", "ultra"],
      sentinel: "private-access-value",
    },
  ];
  const validProfile = {
    model: "gpt-5.6-sol",
    effortLevel: "ultra",
    executionMode: "single-agent",
    accessMode: "full-access",
  };

  for (const source of ["inherited", "explicit"] as const) {
    for (const { profile, effortLevels, sentinel } of unsupportedProfiles) {
      assert.throws(
        () =>
          resolveSessionProfile({
            catalog: codexCatalog,
            catalogRevision: "catalog-revision-unsupported",
            preferences: { global: source === "inherited" ? profile : validProfile },
            overrides: source === "explicit" ? profile : undefined,
          }),
        (error) => {
          if (!(error instanceof SessionProfileResolutionError)) return false;
          assert.equal(error.category, "unsupported-selection");
          assert.deepEqual(error.alternatives, {
            models: ["gpt-5.6-sol", "gpt-5.5-codex"],
            effortLevels,
            executionModes: ["single-agent", "coordinated"],
            accessModes: ["restricted", "full-access"],
          });
          assert.equal(JSON.stringify(error).includes(sentinel), false);
          assert.equal(error.stack, `${error.name}: ${error.message}`);
          return true;
        },
      );
    }
  }
});

test("model and Work Intensity changes independently retain the current Full Access", () => {
  const currentProfile = {
    model: "gpt-5.6-sol",
    effortLevel: "ultra",
    executionMode: "single-agent",
    accessMode: "full-access",
  };
  const preferences = {
    global: {
      model: "gpt-5.5-codex",
      effortLevel: "medium",
      executionMode: "coordinated",
      accessMode: "restricted",
    },
    runtime: {
      model: "gpt-5.5-codex",
      effortLevel: "high",
      executionMode: "coordinated",
      accessMode: "restricted",
    },
    models: {
      "gpt-5.6-sol": {
        effortLevel: "high",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      "gpt-5.5-codex": {
        effortLevel: "medium",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
    },
  };

  const changedModel = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-change-model",
    preferences,
    currentProfile,
    overrides: { model: "gpt-5.5-codex" },
  });
  const changedEffort = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-change-effort",
    preferences,
    currentProfile,
    overrides: { effortLevel: "high" },
  });
  const changedExecution = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-change-execution",
    preferences,
    currentProfile,
    overrides: { executionMode: "coordinated" },
  });

  assert.deepEqual(changedModel.profile, {
    model: "gpt-5.5-codex",
    effortLevel: "medium",
    executionMode: "coordinated",
    accessMode: "full-access",
  });
  assert.deepEqual(changedEffort.profile, {
    model: "gpt-5.6-sol",
    effortLevel: "high",
    executionMode: "single-agent",
    accessMode: "full-access",
  });
  assert.deepEqual(changedExecution.profile, {
    model: "gpt-5.6-sol",
    effortLevel: "ultra",
    executionMode: "coordinated",
    accessMode: "full-access",
  });
});

test("an explicit Access Mode change applies without changing model or Work Intensity", () => {
  const resolved = resolveSessionProfile({
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-change-access",
    preferences: {
      global: {
        model: "gpt-5.5-codex",
        effortLevel: "medium",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
    },
    currentProfile: {
      model: "gpt-5.6-sol",
      effortLevel: "ultra",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    overrides: { accessMode: "restricted" },
  });

  assert.deepEqual(resolved.profile, {
    model: "gpt-5.6-sol",
    effortLevel: "ultra",
    executionMode: "single-agent",
    accessMode: "restricted",
  });
});

test("a stale existing Access Mode fails visibly instead of downgrading", () => {
  const catalogWithoutFullAccess: RuntimeCatalog = {
    ...codexCatalog,
    accessModes: ["restricted"],
  };

  assert.throws(
    () =>
      resolveSessionProfile({
        catalog: catalogWithoutFullAccess,
        catalogRevision: "catalog-revision-stale-access",
        preferences: {},
        currentProfile: {
          model: "gpt-5.6-sol",
          effortLevel: "ultra",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
      }),
    (error) => {
      if (!(error instanceof SessionProfileResolutionError)) return false;
      assert.equal(error.category, "unsupported-selection");
      assert.deepEqual(error.alternatives?.accessModes, ["restricted"]);
      return true;
    },
  );
});

test("resolution leaves every caller-owned input unchanged after success and failure", () => {
  const successInput = {
    catalog: codexCatalog,
    catalogRevision: "catalog-revision-immutable-success",
    preferences: {
      global: {
        model: "gpt-5.5-codex",
        effortLevel: "medium",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      runtime: {
        model: "gpt-5.6-sol",
        effortLevel: "high",
        executionMode: "coordinated",
        accessMode: "restricted",
      },
      models: {
        "gpt-5.5-codex": {
          effortLevel: "high",
          executionMode: "single-agent",
          accessMode: "restricted",
        },
      },
    },
    currentProfile: {
      model: "gpt-5.6-sol",
      effortLevel: "ultra",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    overrides: { model: "gpt-5.5-codex" },
  };
  const successSnapshot = structuredClone(successInput);
  const firstResolution = resolveSessionProfile(successInput);
  const secondResolution = resolveSessionProfile(successInput);
  assert.deepEqual(secondResolution, firstResolution);
  assert.deepEqual(successInput, successSnapshot);

  const failureInput = {
    ...successInput,
    catalogRevision: "catalog-revision-immutable-failure",
    overrides: { accessMode: "private-access-value" },
  };
  const failureSnapshot = structuredClone(failureInput);
  assert.throws(
    () => resolveSessionProfile(failureInput),
    (error) =>
      error instanceof SessionProfileResolutionError &&
      error.category === "unsupported-selection",
  );
  assert.deepEqual(failureInput, failureSnapshot);
});
