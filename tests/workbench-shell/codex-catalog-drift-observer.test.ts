import assert from "node:assert/strict";
import test from "node:test";

import type { CodexCatalogObservation } from "../../src/agent-runtime/codex-adapter.ts";
import {
  createProductionCodexAdapter,
  formatCodexCatalogDriftDiagnostic,
  productionCodexCatalogObserver,
} from "../../src/workbench-shell/runtime-endpoint-composition.ts";
import { ScriptedTransport } from "../agent-runtime/support/scripted-transport.ts";

/**
 * `F110` round 2, A.4. The previous ruling justified losing exact-shape drift
 * detection on the ground that it "is replaced by an explicit witnessed-names
 * channel" — while both production constructions passed two arguments, the
 * observer stayed `undefined`, and the channel's only consumer was a
 * manually-run script. These tests pin the wiring that makes the clause true:
 * `createProductionCodexAdapter` is the one production construction, it
 * carries `productionCodexCatalogObserver`, and the observer lands every
 * non-empty observation on the main-process console — the same surface the
 * native-window-material diagnostic already uses.
 */

function driftObservation(
  overrides: Partial<CodexCatalogObservation> = {},
): CodexCatalogObservation {
  return {
    toleratedKeys: [],
    rejections: [],
    rejectionsOmitted: 0,
    ...overrides,
  };
}

async function withCapturedWarnings<T>(
  action: () => Promise<T> | T,
): Promise<{ readonly result: T; readonly warnings: readonly string[] }> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(String).join(" "));
  };
  try {
    const result = await action();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

test("the drift diagnostic names every observed fact and stays silent on none", () => {
  assert.equal(formatCodexCatalogDriftDiagnostic(driftObservation()), undefined);

  assert.equal(
    formatCodexCatalogDriftDiagnostic(
      driftObservation({ toleratedKeys: ["hasMore", "speculativeDecoding"] }),
    ),
    "CODEX_CATALOG_DRIFT tolerated-keys=[hasMore,speculativeDecoding]",
  );

  assert.equal(
    formatCodexCatalogDriftDiagnostic(
      driftObservation({
        rejections: [
          {
            modelId: "broken-model-id",
            unknownKeys: ["brandNewField"],
            missingKeys: ["supportedReasoningEfforts"],
            invalidValueKeys: [],
          },
        ],
        rejectionsOmitted: 2,
      }),
    ),
    "CODEX_CATALOG_DRIFT quarantined-model=broken-model-id " +
      "added=[brandNewField] removed=[supportedReasoningEfforts] invalid=[] " +
      "quarantined-omitted=2",
  );
});

test("the production observer warns on drift and never on a clean read", async () => {
  const clean = await withCapturedWarnings(() =>
    productionCodexCatalogObserver(driftObservation()),
  );
  assert.deepEqual(clean.warnings, []);

  const drifted = await withCapturedWarnings(() =>
    productionCodexCatalogObserver(
      driftObservation({ toleratedKeys: ["hasMore"] }),
    ),
  );
  assert.deepEqual(drifted.warnings, [
    "CODEX_CATALOG_DRIFT tolerated-keys=[hasMore]",
  ]);
});

test("the production Codex adapter carries the observer through a real inspect", async () => {
  const catalogPage = (models: readonly Record<string, unknown>[]) => [
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { data: models, nextCursor: null },
    }),
  ];
  const validModel = {
    id: "model-001",
    supportedReasoningEfforts: ["low"],
  };

  // Drift — a tolerated vendor key and a quarantined model — reaches the
  // main-process console with both facts named.
  const drifted = await withCapturedWarnings(async () => {
    const transport = new ScriptedTransport(
      catalogPage([
        { ...validModel, speculativeDecoding: true },
        { id: "broken-model-id", supportedReasoningEfforts: [] },
      ]),
    );
    return createProductionCodexAdapter(undefined, async () => transport).inspect(
      "C:\\synthetic-project",
    );
  });
  assert.deepEqual(
    drifted.result.models.map((model) => model.id),
    ["model-001"],
  );
  assert.deepEqual(drifted.warnings, [
    "CODEX_CATALOG_DRIFT tolerated-keys=[speculativeDecoding] " +
      "quarantined-model=broken-model-id added=[] removed=[] " +
      "invalid=[supportedReasoningEfforts]",
  ]);

  // A clean read stays silent.
  const clean = await withCapturedWarnings(async () => {
    const transport = new ScriptedTransport(catalogPage([validModel]));
    return createProductionCodexAdapter(undefined, async () => transport).inspect(
      "C:\\synthetic-project",
    );
  });
  assert.equal(clean.result.models.length, 1);
  assert.deepEqual(clean.warnings, []);

  // The observer fires on the FAILING path too — a rejected catalog is
  // exactly when the owner needs to know which field moved.
  const failed = await withCapturedWarnings(async () => {
    const transport = new ScriptedTransport(
      catalogPage([{ id: "broken-model-id", supportedReasoningEfforts: [] }]),
    );
    try {
      await createProductionCodexAdapter(undefined, async () => transport).inspect(
        "C:\\synthetic-project",
      );
      return "unexpected-success";
    } catch {
      return "failed-as-expected";
    }
  });
  assert.equal(failed.result, "failed-as-expected");
  assert.deepEqual(failed.warnings, [
    "CODEX_CATALOG_DRIFT quarantined-model=broken-model-id " +
      "added=[] removed=[] invalid=[supportedReasoningEfforts]",
  ]);
});
