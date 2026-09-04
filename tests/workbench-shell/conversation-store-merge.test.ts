import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runConversationStoreMergeCli } from "../../scripts/merge-conversation-stores.ts";
import {
  applyConversationStoreMerge,
  assessConversationStoreRecoveryEvidence,
  conversationStoreStagingAuthorizationStatement,
  planConversationStoreMerge,
  renderConversationStoreMergeReport,
} from "../../src/workbench-shell/conversation-store-merge.ts";
import { createTestDirectory } from "../helpers/test-lifecycle.ts";

const baseSlots = [
  "project-ledger-v1-00000000-0000-4000-8000-000000000001",
  "project-ledger-v1-00000000-0000-4000-8000-000000000002",
  "project-ledger-v1-00000000-0000-4000-8000-000000000003",
  "project-ledger-v1-00000000-0000-4000-8000-000000000004",
] as const;
const incomingUniqueSlot =
  "project-ledger-v1-00000000-0000-4000-8000-000000000005";

test("a missing-ledger count alone is structurally insufficient migration evidence", () => {
  assert.deepEqual(
    assessConversationStoreRecoveryEvidence({
      kind: "missing-ledger-report",
      missingLedgerCount: 2,
    }),
    {
      kind: "insufficient-evidence",
      reason: "store-roots-not-inventoried",
      destructiveRecoveryAllowed: false,
      nextRequiredEvidence: "complete-prepared-store-copy-inventories",
    },
  );
  assert.throws(
    () =>
      assessConversationStoreRecoveryEvidence({
        kind: "missing-ledger-report",
        missingLedgerCount: 2,
        deleteMissingEntries: true,
      }),
    { message: "invalid-conversation-store-recovery-evidence" },
  );
});

test("4-ledger and 2-ledger seeded copies merge to one lossless union and report every conflict", async (t) => {
  // Keep the seeded conflict path below the legacy Windows SQLite path limit
  // when TEMP is deliberately rooted inside a long-path isolated clone.
  const fixtureRoot = await createTestDirectory(t, join(tmpdir(), "csm-"));
  const baseStore = join(fixtureRoot, "owner-user-data", "workbench-project-host");
  const incomingStore = join(
    fixtureRoot,
    "container-user-data",
    "workbench-project-host",
  );
  const outputStore = join(
    fixtureRoot,
    "merged-user-data",
    "workbench-project-host",
  );
  const authorizationPath = join(fixtureRoot, "staging-authorization.json");

  await seedStore(
    baseStore,
    "canonical-copy",
    baseSlots.map((slot, index) => ({ slot, seed: `base-${index + 1}` })),
  );
  await seedStore(incomingStore, "redirected-copy", [
    { slot: baseSlots[3], seed: "redirected-conflicting-fourth" },
    { slot: incomingUniqueSlot, seed: "redirected-unique-fifth" },
  ]);

  const plan = await planConversationStoreMerge({
    copyDirectories: [baseStore, incomingStore],
  });
  assert.deepEqual(plan.counts.sourceLedgerFiles, [4, 2]);
  assert.equal(plan.counts.inputLedgerFiles, 6);
  assert.equal(plan.counts.activeOutputLedgerFiles, 5);
  assert.equal(plan.counts.preservedLedgerVersions, 6);
  assert.equal(plan.counts.conflicts, 1);
  assert.equal(plan.counts.unpreservedFileVersions, 0);
  assert.deepEqual(
    plan.conflicts.map((conflict) => ({
      relativePath: conflict.relativePath,
      incomingSourceLabel: conflict.incomingSourceLabel,
      kind: conflict.kind,
    })),
    [
      {
        relativePath: `project-ledgers/${baseSlots[3]}.sqlite`,
        incomingSourceLabel: "redirected-copy",
        kind: "different-bytes-at-same-path",
      },
    ],
  );

  const dryRun = renderConversationStoreMergeReport(plan, { dryRun: true });
  assert.match(dryRun, /4 ledger files/u);
  assert.match(dryRun, /2 ledger files/u);
  assert.match(dryRun, /6 ledger versions observed/u);
  assert.match(dryRun, /5 active ledger files/u);
  assert.match(dryRun, /1 conflicting variant preserved separately/u);
  assert.match(dryRun, /No source file will be changed/u);
  assert.match(dryRun, new RegExp(`${baseSlots[3]}\\.sqlite`, "u"));
  let cliDryRun = "";
  await runConversationStoreMergeCli(
    ["--dry-run", "--base-copy", baseStore, "--copy", incomingStore],
    { write: (text) => { cliDryRun += text; } },
  );
  assert.equal(cliDryRun, dryRun);
  await assert.rejects(stat(outputStore), { code: "ENOENT" });

  const before = await sourceBytes(baseStore, incomingStore);
  await writeFile(
    authorizationPath,
    `${JSON.stringify(stagingAuthorization(plan, outputStore))}\n`,
    "utf8",
  );
  for (const unsafeReport of [
    join(outputStore, "report.md"),
    join(outputStore, "conversation-store-merge-v1.json"),
  ]) {
    await assert.rejects(
      runConversationStoreMergeCli([
        "--base-copy",
        baseStore,
        "--copy",
        incomingStore,
        "--output",
        outputStore,
        "--authorization",
        authorizationPath,
        "--report",
        unsafeReport,
      ]),
      { message: "conversation-store-report-overlaps-output" },
    );
    await assert.rejects(stat(outputStore), { code: "ENOENT" });
  }
  let cliApplied = "";
  await runConversationStoreMergeCli(
    [
      "--copy",
      incomingStore,
      "--base-copy",
      baseStore,
      "--output",
      outputStore,
      "--authorization",
      authorizationPath,
    ],
    { write: (text) => { cliApplied += text; } },
  );
  assert.match(cliApplied, /Mode: \*\*applied to a new merged copy\*\*/u);
  const manifest = JSON.parse(
    await readFile(join(outputStore, "conversation-store-merge-v1.json"), "utf8"),
  ) as { readonly counts: { readonly unpreservedFileVersions: number } };
  assert.equal(manifest.counts.unpreservedFileVersions, 0);
  assert.deepEqual(await sourceBytes(baseStore, incomingStore), before);
  assert.equal(
    await ledgerSeed(join(outputStore, "project-ledgers", `${baseSlots[3]}.sqlite`)),
    "base-4",
  );
  assert.equal(
    await ledgerSeed(
      join(outputStore, "project-ledgers", `${incomingUniqueSlot}.sqlite`),
    ),
    "redirected-unique-fifth",
  );
  assert.equal(
    await ledgerSeed(join(outputStore, plan.conflicts[0]!.preservedRelativePath)),
    "redirected-conflicting-fourth",
  );
});

test("a staged merged copy remains a lossless input to a later staged merge", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-remerge-"));
  const firstStore = join(root, "first", "workbench-project-host");
  const secondStore = join(root, "second", "workbench-project-host");
  const firstOutput = join(root, "first-output", "workbench-project-host");
  const laterStore = join(root, "later", "workbench-project-host");
  const laterOutput = join(root, "later-output", "workbench-project-host");
  await seedStore(firstStore, "remerge-first", [
    { slot: baseSlots[0], seed: "first-active" },
  ]);
  await seedStore(secondStore, "remerge-second", [
    { slot: baseSlots[0], seed: "second-preserved" },
  ]);
  const firstPlan = await planConversationStoreMerge({
    copyDirectories: [firstStore, secondStore],
  });
  await applyConversationStoreMerge({
    plan: firstPlan,
    outputDirectory: firstOutput,
    authorization: stagingAuthorization(firstPlan, firstOutput),
  });
  const firstConflictBytes = await readFile(
    join(firstOutput, firstPlan.conflicts[0]!.preservedRelativePath),
  );
  const firstManifestPath = join(
    firstOutput,
    "conversation-store-merge-v1.json",
  );
  const legacyManifest = JSON.parse(
    await readFile(firstManifestPath, "utf8"),
  ) as Record<string, unknown>;
  delete legacyManifest.planDigest;
  delete legacyManifest.preservedFiles;
  await writeFile(
    firstManifestPath,
    `${JSON.stringify(legacyManifest, null, 2)}\n`,
    "utf8",
  );
  const firstManifestBytes = await readFile(
    firstManifestPath,
  );

  await seedStore(laterStore, "remerge-later", [
    { slot: baseSlots[0], seed: "later-preserved" },
  ]);
  const laterPlan = await planConversationStoreMerge({
    copyDirectories: [firstOutput, laterStore],
  });
  const mergedSource = laterPlan.sources.find((source) =>
    source.sourceLabel.startsWith("merged-"),
  );
  assert.ok(mergedSource);
  assert.deepEqual(laterPlan.counts.sourceLedgerFiles, [2, 1]);
  assert.equal(laterPlan.counts.inputLedgerFiles, 3);
  assert.equal(laterPlan.counts.preservedLedgerVersions, 3);
  assert.equal(laterPlan.counts.unpreservedFileVersions, 0);
  const priorConflictMapping = laterPlan.inputMappings.find((mapping) =>
    mapping.sourceLabel === mergedSource.sourceLabel &&
    mapping.relativePath.endsWith(firstPlan.conflicts[0]!.preservedRelativePath),
  );
  const priorManifestMapping = laterPlan.inputMappings.find((mapping) =>
    mapping.sourceLabel === mergedSource.sourceLabel &&
    mapping.relativePath.endsWith("conversation-store-merge-v1.json"),
  );
  assert.ok(priorConflictMapping);
  assert.ok(priorManifestMapping);

  await applyConversationStoreMerge({
    plan: laterPlan,
    outputDirectory: laterOutput,
    authorization: stagingAuthorization(laterPlan, laterOutput),
  });
  assert.deepEqual(
    await readFile(join(laterOutput, priorConflictMapping.destinationRelativePath)),
    firstConflictBytes,
  );
  assert.deepEqual(
    await readFile(join(laterOutput, priorManifestMapping.destinationRelativePath)),
    firstManifestBytes,
  );
  assert.equal(await ledgerSeed(join(laterOutput, `project-ledgers/${baseSlots[0]}.sqlite`)), "first-active");
  assert.equal(
    await ledgerSeed(join(laterOutput, laterPlan.conflicts.at(-1)!.preservedRelativePath)),
    "later-preserved",
  );
});

test("diverged descendants of one merged copy receive distinct inventory identities", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-forks-"));
  const firstStore = join(root, "first", "workbench-project-host");
  const secondStore = join(root, "second", "workbench-project-host");
  const mergedStore = join(root, "merged", "workbench-project-host");
  const forkA = join(root, "fork-a", "workbench-project-host");
  const forkB = join(root, "fork-b", "workbench-project-host");
  const outputStore = join(root, "reconciled", "workbench-project-host");
  await seedStore(firstStore, "fork-origin-first", [
    { slot: baseSlots[0], seed: "origin-first" },
  ]);
  await seedStore(secondStore, "fork-origin-second", [
    { slot: baseSlots[0], seed: "origin-second" },
  ]);
  const originPlan = await planConversationStoreMerge({
    copyDirectories: [firstStore, secondStore],
  });
  await applyConversationStoreMerge({
    plan: originPlan,
    outputDirectory: mergedStore,
    authorization: stagingAuthorization(originPlan, mergedStore),
  });
  await cp(mergedStore, forkA, { recursive: true });
  await cp(mergedStore, forkB, { recursive: true });
  await setLedgerSeed(
    join(forkA, "project-ledgers", `${baseSlots[0]}.sqlite`),
    "fork-a-active",
  );
  await setLedgerSeed(
    join(forkB, "project-ledgers", `${baseSlots[0]}.sqlite`),
    "fork-b-preserved",
  );

  const forkPlan = await planConversationStoreMerge({
    copyDirectories: [forkA, forkB],
  });
  assert.equal(new Set(forkPlan.sources.map((source) => source.sourceLabel)).size, 2);
  const forkConflict = forkPlan.conflicts.find(
    (conflict) =>
      conflict.relativePath === `project-ledgers/${baseSlots[0]}.sqlite`,
  );
  assert.ok(forkConflict);
  assert.equal(forkPlan.counts.unpreservedFileVersions, 0);
  await applyConversationStoreMerge({
    plan: forkPlan,
    outputDirectory: outputStore,
    authorization: stagingAuthorization(forkPlan, outputStore),
  });
  assert.equal(
    await ledgerSeed(join(outputStore, "project-ledgers", `${baseSlots[0]}.sqlite`)),
    "fork-a-active",
  );
  assert.equal(
    await ledgerSeed(join(outputStore, forkConflict.preservedRelativePath)),
    "fork-b-preserved",
  );
});

test("merged input refuses incomplete or loss-reporting provenance", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-provenance-"));
  const firstStore = join(root, "first", "workbench-project-host");
  const secondStore = join(root, "second", "workbench-project-host");
  const mergedStore = join(root, "merged", "workbench-project-host");
  const laterStore = join(root, "later", "workbench-project-host");
  await seedStore(firstStore, "provenance-first", [
    { slot: baseSlots[0], seed: "first" },
  ]);
  await seedStore(secondStore, "provenance-second", [
    { slot: baseSlots[0], seed: "second" },
  ]);
  await seedStore(laterStore, "provenance-later", [
    { slot: incomingUniqueSlot, seed: "later" },
  ]);
  const plan = await planConversationStoreMerge({
    copyDirectories: [firstStore, secondStore],
  });
  await applyConversationStoreMerge({
    plan,
    outputDirectory: mergedStore,
    authorization: stagingAuthorization(plan, mergedStore),
  });
  const manifestPath = join(mergedStore, "conversation-store-merge-v1.json");
  const validManifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;

  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...validManifest, counts: {} }, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [mergedStore, laterStore] }),
    { message: "conversation-store-copy-marker-invalid" },
  );
  const validCounts = validManifest.counts as Record<string, unknown>;
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      ...validManifest,
      counts: { ...validCounts, unpreservedFileVersions: 1 },
    }, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [mergedStore, laterStore] }),
    { message: "conversation-store-copy-marker-invalid" },
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(validManifest, null, 2)}\n`,
    "utf8",
  );
  const conflictPath = join(
    mergedStore,
    plan.conflicts[0]!.preservedRelativePath,
  );
  const conflictBytes = await readFile(conflictPath);
  await rm(conflictPath);
  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [mergedStore, laterStore] }),
    { message: "conversation-store-copy-marker-invalid" },
  );
  await writeFile(conflictPath, conflictBytes);
  await writeFile(conflictPath, Buffer.concat([conflictBytes, Buffer.from("tampered")]));
  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [mergedStore, laterStore] }),
    { message: "conversation-store-copy-marker-invalid" },
  );
});

test("nested decoy SQLite paths never inflate conversation-ledger counts", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-decoy-"));
  const firstStore = join(root, "first", "workbench-project-host");
  const secondStore = join(root, "second", "workbench-project-host");
  await seedStore(firstStore, "decoy-first", [
    { slot: baseSlots[0], seed: "first" },
  ]);
  await seedStore(secondStore, "decoy-second", [
    { slot: incomingUniqueSlot, seed: "second" },
  ]);
  const decoyDirectory = join(firstStore, "notes", "project-ledgers");
  await mkdir(decoyDirectory, { recursive: true });
  await writeFile(join(decoyDirectory, "decoy.sqlite"), "not a ledger\n", "utf8");

  const plan = await planConversationStoreMerge({
    copyDirectories: [firstStore, secondStore],
  });
  assert.deepEqual(plan.counts.sourceLedgerFiles, [1, 1]);
  assert.equal(plan.counts.inputLedgerFiles, 2);
  assert.equal(plan.counts.activeOutputLedgerFiles, 2);
  assert.equal(plan.counts.preservedLedgerVersions, 2);
});

test("apply rejects a caller-forged execution plan before creating output", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-forged-plan-"));
  const firstStore = join(root, "first", "workbench-project-host");
  const secondStore = join(root, "second", "workbench-project-host");
  const outputStore = join(root, "output", "workbench-project-host");
  await seedStore(firstStore, "forged-first", [
    { slot: baseSlots[0], seed: "first" },
  ]);
  await seedStore(secondStore, "forged-second", [
    { slot: incomingUniqueSlot, seed: "second" },
  ]);
  const plan = await planConversationStoreMerge({
    copyDirectories: [firstStore, secondStore],
  });
  const forgedPlan = {
    ...plan,
    uniqueFileVersions: [
      ...plan.uniqueFileVersions,
      {
        ...plan.uniqueFileVersions[0]!,
        destinationRelativePath: "forged-extra-copy.json",
      },
    ],
  } as typeof plan;

  await assert.rejects(
    applyConversationStoreMerge({
      plan: forgedPlan,
      outputDirectory: outputStore,
      authorization: stagingAuthorization(plan, outputStore),
    }),
    { message: "conversation-store-plan-drift" },
  );
  await assert.rejects(stat(outputStore), { code: "ENOENT" });
});

test("planner bounds conflict manifests so every produced output stays re-readable", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-manifest-bound-"));
  const firstStore = join(root, "first", "workbench-project-host");
  const secondStore = join(root, "second", "workbench-project-host");
  await seedStore(firstStore, "manifest-bound-first", [
    { slot: baseSlots[0], seed: "first" },
  ]);
  await seedStore(secondStore, "manifest-bound-second", [
    { slot: incomingUniqueSlot, seed: "second" },
  ]);
  await seedConflictingMetadataFiles(firstStore, secondStore, 512);
  const boundedPlan = await planConversationStoreMerge({
    copyDirectories: [firstStore, secondStore],
  });
  assert.equal(boundedPlan.counts.conflicts, 512);

  await seedConflictingMetadataFiles(firstStore, secondStore, 1, 512);
  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [firstStore, secondStore] }),
    { message: "conversation-store-merge-manifest-too-large" },
  );
});

test("staging refuses before writes without exact plan-bound owner authorization", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-authorization-"));
  const baseStore = join(root, "base", "workbench-project-host");
  const incomingStore = join(root, "incoming", "workbench-project-host");
  const outputStore = join(root, "staged", "workbench-project-host");
  await seedStore(
    baseStore,
    "authorization-base",
    baseSlots.map((slot, index) => ({ slot, seed: `base-${index + 1}` })),
  );
  await seedStore(incomingStore, "authorization-incoming", [
    { slot: baseSlots[3], seed: "incoming-conflict" },
    { slot: incomingUniqueSlot, seed: "incoming" },
  ]);
  const plan = await planConversationStoreMerge({
    copyDirectories: [baseStore, incomingStore],
  });
  const before = await sourceBytes(baseStore, incomingStore);

  await assert.rejects(
    applyConversationStoreMerge({
      plan,
      outputDirectory: outputStore,
    } as Parameters<typeof applyConversationStoreMerge>[0]),
    { message: "conversation-store-owner-authorization-required" },
  );
  await assert.rejects(
    applyConversationStoreMerge({
      plan,
      outputDirectory: outputStore,
      authorization: {
        ...stagingAuthorization(plan, outputStore),
        planDigest: `sha256:${"0".repeat(64)}`,
      },
    }),
    { message: "conversation-store-owner-authorization-invalid" },
  );
  await assert.rejects(
    runConversationStoreMergeCli([
      "--base-copy",
      baseStore,
      "--copy",
      incomingStore,
      "--output",
      outputStore,
    ]),
    { message: "conversation-store-owner-authorization-required" },
  );
  await assert.rejects(stat(outputStore), { code: "ENOENT" });
  assert.deepEqual(await sourceBytes(baseStore, incomingStore), before);
});

test("merge planning rejects an unmarked live-looking root and an extra-shaped copy marker", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-marker-"));
  const unmarked = join(root, "unmarked");
  const marked = join(root, "marked");
  await mkdir(unmarked);
  await mkdir(marked);
  await writeFile(
    join(marked, ".conversation-store-copy-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "seeded-conversation-store-copy",
      sourceLabel: "extra-shaped",
      seeded: true,
      surprise: "not-admitted",
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [unmarked, marked] }),
    { message: "conversation-store-copy-marker-missing" },
  );
  await assert.rejects(
    planConversationStoreMerge({ copyDirectories: [marked, marked] }),
    { message: "conversation-store-copy-marker-invalid" },
  );
});

test(
  "copy-root guard compares Windows namespace paths by physical identity",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-root-guard-"));
    const baseParent = join(root, "base");
    const baseStore = join(baseParent, "workbench-project-host");
    const incomingStore = join(root, "incoming", "workbench-project-host");
    await seedStore(baseStore, "root-guard-base", [
      { slot: baseSlots[0], seed: "base" },
    ]);
    await seedStore(incomingStore, "root-guard-incoming", [
      { slot: incomingUniqueSlot, seed: "incoming" },
    ]);

    await t.test("accepts an equivalent extended-length spelling", async () => {
      const namespacedPlan = await planConversationStoreMerge({
        copyDirectories: [
          toNamespacedPath(baseStore),
          toNamespacedPath(incomingStore),
        ],
      });
      assert.deepEqual(namespacedPlan.counts.sourceLedgerFiles, [1, 1]);
    });

    await t.test("rejects an extended-length path through a junction", async () => {
      const aliasedParent = join(root, "aliased-base");
      await symlink(baseParent, aliasedParent, "junction");
      await assert.rejects(
        planConversationStoreMerge({
          copyDirectories: [
            toNamespacedPath(join(aliasedParent, "workbench-project-host")),
            toNamespacedPath(incomingStore),
          ],
        }),
        { message: "conversation-store-copy-root-invalid" },
      );
    });
  },
);

test("apply refuses a source-overlapping output and any post-plan copy drift", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-safety-"));
  const baseStore = join(root, "base-user-data", "workbench-project-host");
  const incomingStore = join(
    root,
    "incoming-user-data",
    "workbench-project-host",
  );
  await seedStore(baseStore, "safety-base", [
    { slot: baseSlots[0], seed: "base" },
  ]);
  await seedStore(incomingStore, "safety-incoming", [
    { slot: incomingUniqueSlot, seed: "incoming" },
  ]);
  const plan = await planConversationStoreMerge({
    copyDirectories: [baseStore, incomingStore],
  });
  const nestedOutput = join(baseStore, "nested-output");

  await assert.rejects(
    applyConversationStoreMerge({
      plan,
      outputDirectory: nestedOutput,
      authorization: stagingAuthorization(plan, nestedOutput),
    }),
    { message: "conversation-store-output-overlaps-source" },
  );
  await assert.rejects(
    runConversationStoreMergeCli(
      [
        "--dry-run",
        "--base-copy",
        baseStore,
        "--copy",
        incomingStore,
        "--report",
        join(incomingStore, "unsafe-report.md"),
      ],
      { write() {} },
    ),
    { message: "conversation-store-report-overlaps-source" },
  );

  const sourceAlias = join(root, "base-source-alias");
  await symlink(
    baseStore,
    sourceAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliasedOutput = join(sourceAlias, "aliased-output");
  await assert.rejects(
    applyConversationStoreMerge({
      plan,
      outputDirectory: aliasedOutput,
      authorization: stagingAuthorization(plan, aliasedOutput),
    }),
    { message: "conversation-store-output-overlaps-source" },
  );
  await assert.rejects(
    runConversationStoreMergeCli(
      [
        "--dry-run",
        "--base-copy",
        baseStore,
        "--copy",
        incomingStore,
        "--report",
        join(sourceAlias, "aliased-report.md"),
      ],
      { write() {} },
    ),
    { message: "conversation-store-report-overlaps-source" },
  );

  await writeFile(join(incomingStore, "late-file.txt"), "late drift\n", "utf8");
  const externalOutput = join(root, "external-output");
  await assert.rejects(
    applyConversationStoreMerge({
      plan,
      outputDirectory: externalOutput,
      authorization: stagingAuthorization(plan, externalOutput),
    }),
    { message: "conversation-store-copy-drift" },
  );
  await assert.rejects(stat(externalOutput), { code: "ENOENT" });
});

test("planning rejects a non-quiescent SQLite copy instead of separating live sidecars", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "conversation-store-sidecar-"));
  const baseStore = join(root, "base", "workbench-project-host");
  const incomingStore = join(root, "incoming", "workbench-project-host");
  await seedStore(baseStore, "sidecar-base", [
    { slot: baseSlots[0], seed: "base" },
  ]);
  await seedStore(incomingStore, "sidecar-incoming", [
    { slot: incomingUniqueSlot, seed: "incoming" },
  ]);
  await writeFile(
    join(
      incomingStore,
      "project-ledgers",
      `${incomingUniqueSlot}.sqlite-wal`,
    ),
    "synthetic live sidecar\n",
    "utf8",
  );

  await assert.rejects(
    planConversationStoreMerge({
      copyDirectories: [baseStore, incomingStore],
    }),
    { message: "conversation-store-copy-not-quiescent" },
  );
});

async function seedStore(
  storeDirectory: string,
  sourceLabel: string,
  ledgers: ReadonlyArray<{ readonly slot: string; readonly seed: string }>,
): Promise<void> {
  const ledgerDirectory = join(storeDirectory, "project-ledgers");
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(
    join(storeDirectory, ".conversation-store-copy-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "seeded-conversation-store-copy",
      sourceLabel,
      seeded: true,
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(storeDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: "project-record-v1-00000000-0000-4000-8000-000000000001",
      records: [
        {
          recordKey: "project-record-v1-00000000-0000-4000-8000-000000000001",
          ordinal: 1,
          canonicalDirectory: "C:\\Seeded\\Project",
          ledgerSlot: baseSlots[0],
        },
      ],
    })}\n`,
    "utf8",
  );
  for (const ledger of ledgers) {
    const database = new DatabaseSync(join(ledgerDirectory, `${ledger.slot}.sqlite`));
    try {
      database.exec("CREATE TABLE fixture_seed (value TEXT NOT NULL)");
      database.prepare("INSERT INTO fixture_seed (value) VALUES (?)").run(ledger.seed);
    } finally {
      database.close();
    }
  }
}

async function seedConflictingMetadataFiles(
  firstStore: string,
  secondStore: string,
  count: number,
  offset = 0,
): Promise<void> {
  const firstDirectory = join(firstStore, "bounded-conflicts");
  const secondDirectory = join(secondStore, "bounded-conflicts");
  await Promise.all([
    mkdir(firstDirectory, { recursive: true }),
    mkdir(secondDirectory, { recursive: true }),
  ]);
  for (let start = 0; start < count; start += 32) {
    const batch = Array.from(
      { length: Math.min(32, count - start) },
      (_, index) => offset + start + index,
    );
    await Promise.all(
      batch.flatMap((ordinal) => {
        const name = `conflict-${ordinal.toString().padStart(4, "0")}.json`;
        return [
          writeFile(join(firstDirectory, name), `first-${ordinal}\n`, "utf8"),
          writeFile(join(secondDirectory, name), `second-${ordinal}\n`, "utf8"),
        ];
      }),
    );
  }
}

function stagingAuthorization(
  plan: Awaited<ReturnType<typeof planConversationStoreMerge>>,
  outputDirectory: string,
) {
  return {
    schemaVersion: 1 as const,
    kind: "conversation-store-staging-authorization" as const,
    scope: "create-new-merged-copy-only" as const,
    planDigest: plan.planDigest,
    outputDirectory,
    approvedAt: "2026-08-20T20:00:00Z",
    ownerStatement: conversationStoreStagingAuthorizationStatement,
  } as const;
}

async function ledgerSeed(databasePath: string): Promise<string> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM fixture_seed")
      .get() as { readonly value: string };
    return row.value;
  } finally {
    database.close();
  }
}

async function setLedgerSeed(databasePath: string, value: string): Promise<void> {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("UPDATE fixture_seed SET value = ?").run(value);
  } finally {
    database.close();
  }
}

async function sourceBytes(
  baseStore: string,
  incomingStore: string,
): Promise<readonly string[]> {
  const paths = [
    join(baseStore, "project-registry-v1.json"),
    ...baseSlots.map((slot) =>
      join(baseStore, "project-ledgers", `${slot}.sqlite`),
    ),
    join(incomingStore, "project-registry-v1.json"),
    join(incomingStore, "project-ledgers", `${baseSlots[3]}.sqlite`),
    join(incomingStore, "project-ledgers", `${incomingUniqueSlot}.sqlite`),
  ];
  return Promise.all(paths.map(async (path) => (await readFile(path)).toString("base64")));
}
