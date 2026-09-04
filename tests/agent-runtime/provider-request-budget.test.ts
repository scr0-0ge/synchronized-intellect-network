import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_REQUEST_BUDGET_MANIFEST,
  ProviderRequestBudgetError,
  completeProviderAttemptRound,
  initializeProviderRequestBudget,
  openProviderRequestBudget,
  verifyCompletedDefaultProviderAttempt,
  type ProviderOperationKind,
} from "../../src/agent-runtime/provider-request-budget.ts";
import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  preflightProviderAttempt,
} from "../../src/workbench-shell/provider-attempt-plan.ts";

const childScript = new URL(
  "./fixtures/provider-budget-child.ts",
  import.meta.url,
);

test("exactly 24 cross-process claims produce effects and claim 25 produces none", async (t) => {
  const attempt = await createAttempt(t, "concurrent");
  const effects = join(attempt.root, "effects");
  await mkdir(effects);
  const exits: Array<number | null> = [];
  for (let index = 0; index < 24; index += 1) {
    exits.push(await runChild(
      "effect",
      attempt.locator,
      operationKinds[index % operationKinds.length]!,
      join(effects, `effect-${String(index + 1).padStart(2, "0")}.txt`),
    ));
  }
  assert.deepEqual(exits, Array.from({ length: 24 }, () => 0));

  const rejectedEffectPath = join(effects, "effect-25.txt");
  assert.equal(
    await runChild(
      "effect",
      attempt.locator,
      operationKinds[24 % operationKinds.length]!,
      rejectedEffectPath,
    ),
    2,
  );
  const effectFiles = await readdir(effects);
  assert.equal(effectFiles.length, 24);
  assert.equal(effectFiles.includes("effect-25.txt"), false);

  let extraEffect = false;
  await assert.rejects(
    openProviderRequestBudget({
      locator: attempt.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    })
      .claim("codex-initialize")
      .then(() => {
        extraEffect = true;
      }),
    isBudgetFailure("budget-exhausted"),
  );
  assert.equal(extraEffect, false);
});

test("a crash or transport failure after claim stays charged", async (t) => {
  for (const mode of ["crash", "transport-failure"] as const) {
    await t.test(mode, async (subtest) => {
      const attempt = await createAttempt(subtest, mode);
      const failedExit = await runChild(
        mode,
        attempt.locator,
        "claude-auth-status",
      );
      assert.notEqual(failedExit, 0);

      let effects = 0;
      const budget = openProviderRequestBudget({
        locator: attempt.locator,
        expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      });
      for (let index = 0; index < 23; index += 1) {
        await budget.claim(operationKinds[index % operationKinds.length]!);
        effects += 1;
      }
      await assert.rejects(
        budget.claim("claude-catalog-initialize").then(() => {
          effects += 1;
        }),
        isBudgetFailure("budget-exhausted"),
      );
      assert.equal(effects, 23);
    });
  }
});

test("malformed ledger, wrong protocol, stale marker, invalid mode, and allocation uncertainty fail before effect", async (t) => {
  const cases = [
    {
      name: "malformed claim",
      mutate: async (locator: string) =>
        writeFile(join(locator, "claim-01.json"), "not-json\n", "utf8"),
      category: "ledger-invalid",
    },
    {
      name: "malformed round",
      mutate: async (locator: string) =>
        writeFile(join(locator, "round-01.json"), "not-json\n", "utf8"),
      category: "ledger-invalid",
    },
    {
      name: "wrong protocol",
      mutate: async (locator: string) =>
        writeManifest(locator, {
          protocol: "wrong-protocol",
          buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
          mode: "default",
          operationLimit: 24,
        }),
      category: "ledger-invalid",
    },
    {
      name: "invalid mode",
      mutate: async (locator: string) =>
        writeManifest(locator, {
          protocol: "provider-request-budget-v1",
          buildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
          mode: "optional",
          operationLimit: 24,
        }),
      category: "ledger-invalid",
    },
    {
      name: "allocation uncertainty",
      mutate: async (locator: string) => {
        const lock = join(locator, "allocation.lock");
        await mkdir(lock);
        await writeFile(join(lock, "uncertain"), "uncertain\n", "utf8");
      },
      category: "allocation-uncertain",
    },
  ] as const;

  for (const row of cases) {
    await t.test(row.name, async (subtest) => {
      const attempt = await createAttempt(subtest, row.name.replaceAll(" ", "-"));
      await row.mutate(attempt.locator);
      let effects = 0;
      await assert.rejects(
        openProviderRequestBudget({
          locator: attempt.locator,
          expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
        })
          .claim("codex-account-read")
          .then(() => {
            effects += 1;
          }),
        isBudgetFailure(row.category),
      );
      assert.equal(effects, 0);
    });
  }

  await t.test("stale marker", async (subtest) => {
    const attempt = await createAttempt(subtest, "stale-marker");
    let effects = 0;
    await assert.rejects(
      openProviderRequestBudget({
        locator: attempt.locator,
        expectedBuildMarker: "provider-request-budget-v1.stale",
      })
        .claim("codex-account-read")
        .then(() => {
          effects += 1;
        }),
      isBudgetFailure("build-marker-mismatch"),
    );
    assert.equal(effects, 0);
  });
});

test("the closed operation enum accepts every counted kind and rejects unknown or malformed values before effect", async (t) => {
  const attempt = await createAttempt(t, "operation-kinds");
  const budget = openProviderRequestBudget({
    locator: attempt.locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  let effects = 0;
  for (const operation of operationKinds) {
    await budget.claim(operation);
    effects += 1;
  }
  assert.equal(effects, 7);

  for (const operation of [
    "codex-thread-start",
    "claude-interrupt",
    "",
    undefined,
    { kind: "codex-initialize" },
  ] as const) {
    await assert.rejects(
      (budget.claim as (value: unknown) => Promise<void>)(operation).then(() => {
        effects += 1;
      }),
      isBudgetFailure("unknown-operation"),
    );
  }
  assert.equal(effects, 7);
});

test("default completion verifies exactly four discovery rounds and only a 20-24 operation shape", async (t) => {
  const attempt = await createAttempt(t, "default-completion");
  const budget = openProviderRequestBudget({
    locator: attempt.locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  for (let round = 0; round < 4; round += 1) {
    await budget.claim("codex-initialize");
    await budget.claim("codex-account-read");
    await budget.claim("codex-model-list-page");
    await budget.claim("claude-auth-status");
    await budget.claim("claude-catalog-initialize");
    await completeProviderAttemptRound({
      locator: attempt.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      name: defaultRoundNames[round]!,
    });
  }
  assert.deepEqual(
    await verifyCompletedDefaultProviderAttempt({
      locator: attempt.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    }),
    { complete: true, operationCount: 20, operationLimit: 24 },
  );

  const maximum = await createAttempt(t, "maximum-completion");
  const maximumBudget = openProviderRequestBudget({
    locator: maximum.locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  for (const name of defaultRoundNames) {
    for (const operation of defaultDiscoveryRound) {
      await maximumBudget.claim(operation);
    }
    await maximumBudget.claim("codex-model-list-page");
    await completeProviderAttemptRound({
      locator: maximum.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      name,
    });
  }
  assert.deepEqual(
    await verifyCompletedDefaultProviderAttempt({
      locator: maximum.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    }),
    { complete: true, operationCount: 24, operationLimit: 24 },
  );

  const incomplete = await createAttempt(t, "incomplete-completion");
  await openProviderRequestBudget({
    locator: incomplete.locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  }).claim("codex-initialize");
  await assert.rejects(
    verifyCompletedDefaultProviderAttempt({
      locator: incomplete.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    }),
    isBudgetFailure("ledger-invalid"),
  );
});

test("named durable boundaries cannot certify duplicate or omitted default rounds", async (t) => {
  const attempt = await createAttempt(t, "named-rounds");
  const budget = openProviderRequestBudget({
    locator: attempt.locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });

  for (const operation of defaultDiscoveryRound) await budget.claim(operation);
  await completeProviderAttemptRound({
    locator: attempt.locator,
    expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    name: "independent-headless",
  });
  for (const operation of defaultDiscoveryRound) await budget.claim(operation);

  await assert.rejects(
    completeProviderAttemptRound({
      locator: attempt.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      name: "independent-headless",
    }),
    isBudgetFailure("ledger-invalid"),
  );
  await assert.rejects(
    verifyCompletedDefaultProviderAttempt({
      locator: attempt.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    }),
    isBudgetFailure("ledger-invalid"),
  );

  for (const invalid of [
    {
      locator: attempt.locator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      name: "item-4-lazy-picker",
      extra: true,
    },
    new Proxy(
      {
        locator: attempt.locator,
        expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
        name: "item-4-lazy-picker",
      },
      {},
    ),
  ]) {
    await assert.rejects(
      completeProviderAttemptRound(invalid as never),
      isBudgetFailure("ledger-invalid"),
    );
  }
});

const operationKinds = Object.freeze([
  "codex-initialize",
  "codex-account-read",
  "codex-model-list-page",
  "claude-auth-status",
  "claude-catalog-initialize",
  "claude-session-initialize",
  "claude-inference-frame",
] as const satisfies readonly ProviderOperationKind[]);

const defaultRoundNames = Object.freeze([
  "independent-headless",
  "item-4-lazy-picker",
  "positive-continuation-composition",
  "positive-new-session-explicit-refresh",
] as const);

const defaultDiscoveryRound = Object.freeze([
  "codex-initialize",
  "codex-account-read",
  "codex-model-list-page",
  "claude-auth-status",
  "claude-catalog-initialize",
] as const satisfies readonly ProviderOperationKind[]);

async function createAttempt(
  t: Pick<TestContext, "after">,
  name: string,
): Promise<{ readonly root: string; readonly locator: string }> {
  const root = await mkdtemp(join(tmpdir(), "provider-budget-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locator = join(root, `provider-request-attempt-${name}`);
  const preflight = preflightProviderAttempt({
    liveClaudeMode: undefined,
    f102CaptureMode: undefined,
    sourceBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    distBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
  });
  assert.equal(preflight.ok, true);
  if (!preflight.ok) throw new Error("default preflight rejected");
  await initializeProviderRequestBudget({ locator, plan: preflight.plan });
  return Object.freeze({ root, locator });
}

function runChild(
  mode: "effect" | "crash" | "transport-failure",
  locator: string,
  operation: ProviderOperationKind,
  effectPath?: string,
): Promise<number | null> {
  const child = spawn(
    process.execPath,
    [fileURLToPath(childScript), mode, locator, operation, ...(effectPath ? [effectPath] : [])],
    { stdio: "ignore", windowsHide: true },
  );
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function writeManifest(
  locator: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(locator, PROVIDER_REQUEST_BUDGET_MANIFEST),
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}

function isBudgetFailure(category: string) {
  return (error: unknown) =>
    error instanceof ProviderRequestBudgetError && error.category === category;
}
