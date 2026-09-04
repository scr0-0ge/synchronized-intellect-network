import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  initializeProviderRequestBudget,
} from "../../src/agent-runtime/provider-request-budget.ts";
import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  PROVIDER_ATTEMPT_PROTOCOL,
  preflightProviderAttempt,
} from "../../src/workbench-shell/provider-attempt-plan.ts";
import {
  loadProviderRequestBudgetForElectronMain,
} from "../../src/workbench-shell/provider-attempt-runtime.ts";

test("Electron main opens the exact shared attempt and malformed or partial state fails before effect", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "provider-attempt-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locator = resolve(root, "provider-request-attempt-electron-main");
  const preflight = preflightProviderAttempt({
    liveClaudeMode: undefined,
    f102CaptureMode: undefined,
    sourceBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    distBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  assert.equal(preflight.ok, true);
  if (!preflight.ok) throw new Error("synthetic preflight failed");
  await initializeProviderRequestBudget({ locator, plan: preflight.plan });

  assert.equal(
    loadProviderRequestBudgetForElectronMain({
      locator: undefined,
      protocol: undefined,
      buildMarker: undefined,
    }),
    undefined,
  );
  const budget = loadProviderRequestBudgetForElectronMain({
    locator,
    protocol: PROVIDER_ATTEMPT_PROTOCOL,
    buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  assert.ok(budget);
  let effects = 0;
  await budget.claim("codex-initialize");
  effects += 1;
  assert.equal(effects, 1);

  const invalid: readonly unknown[] = [
    { locator, protocol: undefined, buildMarker: undefined },
    {
      locator,
      protocol: "wrong-protocol",
      buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    },
    {
      locator,
      protocol: PROVIDER_ATTEMPT_PROTOCOL,
      buildMarker: "stale-marker",
    },
    {
      locator,
      protocol: PROVIDER_ATTEMPT_PROTOCOL,
      buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      extra: true,
    },
    new Proxy(
      {
        locator,
        protocol: PROVIDER_ATTEMPT_PROTOCOL,
        buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      },
      {},
    ),
  ];
  for (const value of invalid) {
    let invalidEffects = 0;
    assert.throws(
      () => loadProviderRequestBudgetForElectronMain(value),
      /provider-request-budget/u,
    );
    assert.equal(invalidEffects, 0);
  }
});
