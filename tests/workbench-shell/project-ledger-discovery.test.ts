import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import type {
  WorkbenchHostedProjectResult,
  WorkbenchProjectHistoryDiscoveryResult,
} from "../../src/workbench-shell/contract.ts";
import { createWorkbenchProjectHost } from "../../src/workbench-shell/project-host.ts";
import {
  discoverProjectLedgers,
  projectDirectoryDigest,
} from "../../src/workbench-shell/project-ledger-discovery.ts";
import {
  createTestDirectory,
  registerTestCleanup,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

const ledgerDirectoryName = "project-ledgers";
const registryFileName = "project-registry-v1.json";

const syntheticProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent" as const,
  accessMode: "full-access" as const,
});

const syntheticCatalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: syntheticProfile.model,
      displayName: syntheticProfile.model,
      effortLevels: Object.freeze([syntheticProfile.effortLevel]),
      effortLevelLabels: Object.freeze([syntheticProfile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent" as const]),
  accessModes: Object.freeze(["full-access" as const]),
});

const terminalEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({
    kind: "item-started" as const,
    itemType: "agent-message" as const,
  }),
  Object.freeze({
    kind: "item-completed" as const,
    itemType: "agent-message" as const,
  }),
  Object.freeze({
    kind: "agent-message" as const,
    text: "A bounded public completion.",
  }),
  Object.freeze({
    kind: "turn-completed" as const,
    status: "completed" as const,
  }),
]);

/** Records real Sessions into a real ledger without launching anything. */
class SyntheticAdapter implements ResumableAgentRuntimeAdapter {
  private started = 0;
  private hold: Promise<void> | undefined;
  private release: (() => void) | undefined;

  /** Keeps the next turn live until `releaseTurn` is called. */
  holdNextTurn(): void {
    this.hold = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseTurn(): void {
    this.release?.();
    this.release = undefined;
  }

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(syntheticCatalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.started += 1;
    return this.binding(
      request.profile,
      `private-synthetic-capability-${this.started}`,
    );
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile, request.opaqueSessionReference);
  }

  private binding(
    profile: SessionProfile,
    opaqueSessionReference: string,
  ): ResumableRuntimeBinding {
    const held = this.hold;
    return {
      profile: structuredClone(profile),
      opaqueSessionReference,
      async send(_input: RuntimeInput): Promise<void> {
        // The synthetic runtime accepts input and records nothing extra.
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        for (const event of terminalEvents) {
          if (held !== undefined && event.kind === "turn-completed") {
            await held;
          }
          yield structuredClone(event);
        }
      },
    };
  }
}

type Host = Awaited<ReturnType<typeof createWorkbenchProjectHost>>;

function observeHost(host: Host): {
  readonly latest: () => WorkbenchHostedProjectResult | undefined;
  readonly dispose: () => void;
  readonly waitFor: (
    predicate: (result: WorkbenchHostedProjectResult) => boolean,
  ) => Promise<WorkbenchHostedProjectResult>;
} {
  const results: WorkbenchHostedProjectResult[] = [];
  const waiters = new Set<{
    readonly predicate: (result: WorkbenchHostedProjectResult) => boolean;
    readonly resolve: (result: WorkbenchHostedProjectResult) => void;
  }>();
  const dispose = host.observeProject((result) => {
    results.push(result);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result)) continue;
      waiters.delete(waiter);
      waiter.resolve(result);
    }
  });
  return {
    latest: () => results[results.length - 1],
    dispose,
    waitFor(predicate) {
      const existing = [...results].reverse().find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
}

function selectionKeyFor(
  result: WorkbenchHostedProjectResult,
  label: string,
): string {
  if (!result.ok) assert.fail("Expected a live Project view.");
  const project = result.view.projectSelection.projects.find(
    (candidate) => candidate.label === label,
  );
  if (project === undefined) assert.fail(`Expected the ${label} Project.`);
  return project.selectionKey;
}

async function ledgerFiles(dataDirectory: string): Promise<readonly string[]> {
  const entries = await readdir(join(dataDirectory, ledgerDirectoryName)).catch(
    () => [] as string[],
  );
  return entries.filter((name) => name.endsWith(".sqlite")).sort();
}

async function fingerprintLedgers(
  dataDirectory: string,
): Promise<Record<string, string>> {
  const fingerprints: Record<string, string> = {};
  for (const name of await ledgerFiles(dataDirectory)) {
    const bytes = await readFile(
      join(dataDirectory, ledgerDirectoryName, name),
    );
    fingerprints[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return fingerprints;
}

async function readRegistry(dataDirectory: string): Promise<{
  readonly revision: number;
  readonly records: readonly {
    readonly recordKey: string;
    readonly canonicalDirectory: string;
    readonly ledgerSlot: string;
  }[];
}> {
  return JSON.parse(
    await readFile(join(dataDirectory, registryFileName), "utf8"),
  );
}

async function submitOneSession(host: Host): Promise<void> {
  const loaded = await host.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  if (!loaded.ok) assert.fail("Expected one synthetic Session profile.");
  const endpoint = loaded.profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const accepted = await host.submitDirectInput({
    kind: "start",
    input: "Record one synthetic Agent Session.",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: endpoint.key,
    modelKey: model.key,
    workIntensityKey: model.workIntensities[0]!.key,
    executionModeKey: endpoint.executionModes[0]!.key,
    accessModeKey: endpoint.accessModes[0]!.key,
  });
  assert.equal(accepted.ok, true);
}

/**
 * Builds the legitimate two-ledger state the inventory/adopt path must keep
 * supporting. A second empty ledger is prepared in an isolated fixture store,
 * copied into the test store, and then explicitly chosen through the product's
 * history-selection result. Product behaviour never copies or mints it.
 */
async function strandOneHistory(t: TestContext, options: {
  readonly dataDirectory: string;
  readonly strandedDirectory: string;
  readonly otherDirectory: string;
}): Promise<{
  readonly host: Host;
  readonly adapter: SyntheticAdapter;
  readonly strandedSlot: string;
}> {
  const adapter = new SyntheticAdapter();
  const host = await createWorkbenchProjectHost({
    dataDirectory: options.dataDirectory,
    fallbackProjectDirectory: options.strandedDirectory,
    adapter,
  });
  registerTestClosable(t, host);
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 1,
  );
  await submitOneSession(host);
  // The turn must reach a terminal status before the Project is switched away,
  // otherwise the stranded ledger records an interrupted turn instead of the
  // completed conversation the owner is trying to get back.
  await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.commands.length === 1 &&
      result.view.commands[0]?.status === "completed",
  );
  const strandedSlot = (await readRegistry(options.dataDirectory)).records[0]!
    .ledgerSlot;

  assert.equal((await host.registerTrustedProject(options.otherDirectory)).ok, true);
  const both = await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 2,
  );
  assert.deepEqual(
    await host.removeProject({
      selectionKey: selectionKeyFor(both, basename(options.strandedDirectory)),
    }),
    { status: "removed" },
  );
  await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 1,
  );

  const fixtureDataDirectory = join(
    options.dataDirectory,
    "isolated-empty-ledger-fixture",
  );
  const fixtureHost = await createWorkbenchProjectHost({
    dataDirectory: fixtureDataDirectory,
    fallbackProjectDirectory: options.strandedDirectory,
    adapter: new SyntheticAdapter(),
  });
  registerTestClosable(t, fixtureHost);
  const fixtureSlot = (await readRegistry(fixtureDataDirectory)).records[0]!
    .ledgerSlot;
  await fixtureHost.close();
  await copyFile(
    join(
      fixtureDataDirectory,
      ledgerDirectoryName,
      `${fixtureSlot}.sqlite`,
    ),
    join(options.dataDirectory, ledgerDirectoryName, `${fixtureSlot}.sqlite`),
  );

  const choice = await host.registerTrustedProject(options.strandedDirectory);
  if (!choice.ok || choice.status !== "history-selection-required") {
    assert.fail("Expected the duplicate-history chooser fixture.");
  }
  const emptyHistory = choice.snapshot.histories.find(
    (history) => history.sessionCount === 0,
  );
  assert.notEqual(emptyHistory, undefined);
  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: emptyHistory!.historyKey }),
    { status: "adopted" },
  );
  await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.projectSelection.projects.length === 2 &&
      result.view.commands.length === 0 &&
      result.view.projectSelection.projects.some(
        (project) =>
          project.label === basename(options.strandedDirectory) &&
          project.selected,
      ),
  );
  observation.dispose();
  return { host, adapter, strandedSlot };
}

test("removing and re-adding one Project adopts its only ledger without minting", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-ledger-readd-"));
  const returningDirectory = join(root, "Returning Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(returningDirectory);
  await mkdir(otherDirectory);

  const host = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: returningDirectory,
    adapter: new SyntheticAdapter(),
  });
  registerTestClosable(t, host);
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  const initial = await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 1,
  );
  await submitOneSession(host);
  await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.commands.length === 1 &&
      result.view.commands[0]?.status === "completed",
  );
  const originalSlot = (await readRegistry(dataDirectory)).records[0]!.ledgerSlot;

  assert.equal((await host.registerTrustedProject(otherDirectory)).ok, true);
  const both = await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 2,
  );
  assert.deepEqual(
    await host.removeProject({
      selectionKey: selectionKeyFor(both, basename(returningDirectory)),
    }),
    { status: "removed" },
  );
  await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 1,
  );

  const filesBeforeReadd = await ledgerFiles(dataDirectory);
  const fingerprintsBeforeReadd = await fingerprintLedgers(dataDirectory);
  const candidatesBeforeReadd = discoverProjectLedgers({
    ledgerDirectory: join(dataDirectory, ledgerDirectoryName),
    canonicalDirectory: returningDirectory,
  });
  assert.deepEqual(
    candidatesBeforeReadd.map((candidate) => candidate.ledgerSlot),
    [originalSlot],
    "the removed Project's ledger must be the one exact digest match",
  );
  assert.deepEqual(await host.registerTrustedProject(returningDirectory), {
    ok: true,
    status: "selected",
    message: "Project was opened with its existing conversation history.",
  });
  const restored = await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 2,
  );
  if (!restored.ok) assert.fail("Expected the returning Project.");
  const registered = (await readRegistry(dataDirectory)).records.find(
    (record) => record.canonicalDirectory === returningDirectory,
  )!;

  assert.equal(registered.ledgerSlot, originalSlot);
  assert.equal(restored.view.commands.length, 1);
  assert.equal(restored.view.commands[0]?.status, "completed");
  assert.deepEqual(await ledgerFiles(dataDirectory), filesBeforeReadd);
  assert.deepEqual(
    await fingerprintLedgers(dataDirectory),
    fingerprintsBeforeReadd,
    "re-adoption may rewrite the Project Registry but never a ledger file",
  );
  assert.equal(initial.ok, true);
});

test("a Project with no matching ledger mints one new slot and opens normally", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-ledger-first-open-"));
  const initialDirectory = join(root, "Initial Project");
  const newDirectory = join(root, "Never Opened Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(initialDirectory);
  await mkdir(newDirectory);

  const host = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: initialDirectory,
    adapter: new SyntheticAdapter(),
  });
  registerTestClosable(t, host);
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 1,
  );

  const filesBefore = await ledgerFiles(dataDirectory);
  assert.deepEqual(
    discoverProjectLedgers({
      ledgerDirectory: join(dataDirectory, ledgerDirectoryName),
      canonicalDirectory: newDirectory,
    }),
    [],
  );
  assert.deepEqual(await host.registerTrustedProject(newDirectory), {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  const opened = await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.projectSelection.projects.length === 2 &&
      result.view.projectSelection.projects[1]?.selected === true,
  );
  if (!opened.ok) assert.fail("Expected the new Project.");
  assert.equal(opened.view.commands.length, 0);
  assert.equal((await ledgerFiles(dataDirectory)).length, filesBefore.length + 1);
  const record = (await readRegistry(dataDirectory)).records.find(
    (candidate) => candidate.canonicalDirectory === newDirectory,
  );
  assert.notEqual(record, undefined);

  await submitOneSession(host);
  await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.commands.length === 1 &&
      result.view.commands[0]?.status === "completed",
  );
});

test("two matching ledgers require the existing history choice without minting", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-ledger-choice-"));
  const returningDirectory = join(root, "Ambiguous Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(returningDirectory);
  await mkdir(otherDirectory);

  const { host, strandedSlot } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory: returningDirectory,
    otherDirectory,
  });
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  const withReturningProject = await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 2,
  );
  assert.deepEqual(
    await host.removeProject({
      selectionKey: selectionKeyFor(
        withReturningProject,
        basename(returningDirectory),
      ),
    }),
    { status: "removed" },
  );
  await observation.waitFor(
    (result) => result.ok && result.view.projectSelection.projects.length === 1,
  );

  const candidates = discoverProjectLedgers({
    ledgerDirectory: join(dataDirectory, ledgerDirectoryName),
    canonicalDirectory: returningDirectory,
  });
  assert.equal(candidates.length, 2);
  const filesBeforeChoice = await ledgerFiles(dataDirectory);
  const fingerprintsBeforeChoice = await fingerprintLedgers(dataDirectory);
  const choice = await host.registerTrustedProject(returningDirectory);
  assert.equal(choice.ok, true);
  if (!choice.ok || choice.status !== "history-selection-required") {
    assert.fail("Expected the existing history chooser.");
  }
  assert.equal(
    choice.message,
    "Choose which existing conversation history this Project should show. Nothing changed yet.",
  );
  assert.equal(choice.snapshot.projectLabel, "Ambiguous Project");
  assert.equal(choice.snapshot.histories.length, 2);
  assert.equal(
    choice.snapshot.histories.every((history) => history.current === false),
    true,
  );
  assert.equal(
    (await readRegistry(dataDirectory)).records.some(
      (record) => record.canonicalDirectory === returningDirectory,
    ),
    false,
    "the host must not register a Project until the owner chooses",
  );
  assert.deepEqual(await ledgerFiles(dataDirectory), filesBeforeChoice);
  assert.deepEqual(
    await fingerprintLedgers(dataDirectory),
    fingerprintsBeforeChoice,
  );

  const recorded = choice.snapshot.histories.find(
    (history) => history.sessionCount === 1,
  );
  assert.notEqual(recorded, undefined);
  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: recorded!.historyKey }),
    { status: "adopted" },
  );
  const restored = await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.projectSelection.projects.length === 2 &&
      result.view.commands.length === 1,
  );
  assert.equal(restored.ok, true);
  assert.equal(
    (await readRegistry(dataDirectory)).records.find(
      (record) => record.canonicalDirectory === returningDirectory,
    )?.ledgerSlot,
    strandedSlot,
  );
  assert.deepEqual(await ledgerFiles(dataDirectory), filesBeforeChoice);
  assert.deepEqual(
    await fingerprintLedgers(dataDirectory),
    fingerprintsBeforeChoice,
  );
});

test("discovery attributes every ledger by the digest that ledger stores about itself", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-ledger-discovery-"));
  const strandedDirectory = join(root, "Stranded Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(strandedDirectory);
  await mkdir(otherDirectory);

  const { host, strandedSlot } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory,
    otherDirectory,
  });
  await host.close();

  const registry = await readRegistry(dataDirectory);
  const registered = registry.records.find(
    (record) => record.canonicalDirectory === strandedDirectory,
  )!;
  assert.notEqual(registered.ledgerSlot, strandedSlot);
  assert.equal((await ledgerFiles(dataDirectory)).length, 3);

  const ledgerDirectory = join(dataDirectory, ledgerDirectoryName);
  const stranded = discoverProjectLedgers({
    ledgerDirectory,
    canonicalDirectory: strandedDirectory,
    registeredLedgerSlot: registered.ledgerSlot,
  });
  assert.deepEqual(
    [...stranded].map((ledger) => ledger.ledgerSlot).sort(),
    [registered.ledgerSlot, strandedSlot].sort(),
  );
  const orphan = stranded.find((ledger) => ledger.ledgerSlot === strandedSlot)!;
  const current = stranded.find(
    (ledger) => ledger.ledgerSlot === registered.ledgerSlot,
  )!;
  assert.equal(orphan.registered, false);
  assert.equal(current.registered, true);
  // The stranded ledger still holds the recorded conversation; the isolated
  // duplicate fixture that this test explicitly chose is empty.
  assert.equal(orphan.sessionCount, 1);
  assert.equal(orphan.commandCount, 1);
  assert.equal(orphan.updateCount > 0, true);
  assert.equal(current.sessionCount, 0);
  assert.equal(orphan.byteSize > 0, true);
  assert.match(orphan.lastModified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(orphan.schemaVersion > 0, true);

  // The third ledger belongs to the other directory and is never offered here.
  const otherRecord = registry.records.find(
    (record) => record.canonicalDirectory === otherDirectory,
  )!;
  assert.equal(
    stranded.some((ledger) => ledger.ledgerSlot === otherRecord.ledgerSlot),
    false,
  );
  assert.deepEqual(
    discoverProjectLedgers({
      ledgerDirectory,
      canonicalDirectory: otherDirectory,
      registeredLedgerSlot: otherRecord.ledgerSlot,
    }).map((ledger) => ledger.ledgerSlot),
    [otherRecord.ledgerSlot],
  );
  assert.notEqual(
    projectDirectoryDigest(strandedDirectory),
    projectDirectoryDigest(otherDirectory),
  );
  // A directory that owns nothing is offered nothing, never a nearest match.
  assert.deepEqual(
    discoverProjectLedgers({
      ledgerDirectory,
      canonicalDirectory: join(root, "Never Registered"),
    }),
    [],
  );
});

test("one unreadable or foreign file can never break discovery, and discovery never writes", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-ledger-hostile-"));
  const strandedDirectory = join(root, "Hostile Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(strandedDirectory);
  await mkdir(otherDirectory);

  const { host } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory,
    otherDirectory,
  });
  await host.close();

  const ledgerDirectory = join(dataDirectory, ledgerDirectoryName);
  const registered = (await readRegistry(dataDirectory)).records.find(
    (record) => record.canonicalDirectory === strandedDirectory,
  )!.ledgerSlot;
  const expected = discoverProjectLedgers({
    ledgerDirectory,
    canonicalDirectory: strandedDirectory,
    registeredLedgerSlot: registered,
  });
  assert.equal(expected.length, 2);

  // A well-named file that is not a database at all, plus names that do not
  // spell a registry slot. None of them may appear, and none may throw.
  await writeFile(
    join(
      ledgerDirectory,
      "project-ledger-v1-00000000-0000-4000-8000-000000000000.sqlite",
    ),
    "PRIVATE_NOT_A_DATABASE",
    "utf8",
  );
  await writeFile(join(ledgerDirectory, "not-a-ledger.sqlite"), "x", "utf8");
  await writeFile(
    join(ledgerDirectory, "project-ledger-v1-nope.sqlite"),
    "x",
    "utf8",
  );
  await writeFile(join(ledgerDirectory, "notes.txt"), "x", "utf8");

  const before = await fingerprintLedgers(dataDirectory);
  const beforeNames = await readdir(ledgerDirectory);
  const survived = discoverProjectLedgers({
    ledgerDirectory,
    canonicalDirectory: strandedDirectory,
    registeredLedgerSlot: registered,
  });
  assert.deepEqual(
    survived.map((ledger) => ledger.ledgerSlot).sort(),
    expected.map((ledger) => ledger.ledgerSlot).sort(),
  );
  assert.equal(
    JSON.stringify(survived).includes("PRIVATE_NOT_A_DATABASE"),
    false,
  );

  // Discovery opens every ledger read-only: no byte changes, and no journal,
  // write-ahead-log or shared-memory sidecar is ever created beside one.
  assert.deepEqual(await fingerprintLedgers(dataDirectory), before);
  assert.deepEqual((await readdir(ledgerDirectory)).sort(), beforeNames.sort());

  // A missing store directory is an empty answer, never a thrown discovery.
  assert.deepEqual(
    discoverProjectLedgers({
      ledgerDirectory: join(root, "no-such-store"),
      canonicalDirectory: strandedDirectory,
    }),
    [],
  );
});

test("adopting a discovered history is a registry re-point that is fully reversible", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-history-adoption-"));
  const strandedDirectory = join(root, "Adopting Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(strandedDirectory);
  await mkdir(otherDirectory);

  const { host, strandedSlot } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory,
    otherDirectory,
  });
  // The shared cleanup stack closes the Host before removing the OS-temp root.
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  const opened = await observation.waitFor((result) => result.ok);

  const discovered = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(opened, "Adopting Project"),
  });
  if (discovered.status !== "discovered") {
    assert.fail("Expected the Project's histories.");
  }
  assert.equal(discovered.snapshot.projectLabel, "Adopting Project");
  assert.equal(discovered.snapshot.histories.length, 2);
  assert.equal(
    discovered.snapshot.histories.filter((history) => history.current).length,
    1,
  );
  const stranded = discovered.snapshot.histories.find(
    (history) => !history.current,
  )!;
  assert.equal(stranded.sessionCount, 1);
  // Counts only: nothing in the public snapshot can spell a path or a name.
  assert.equal(
    /[A-Za-z]:\\|project-ledger-v1-|Adopting Project.*sqlite/u.test(
      JSON.stringify(discovered.snapshot.histories),
    ),
    false,
  );

  const beforeFiles = await ledgerFiles(dataDirectory);
  const registryBefore = await readRegistry(dataDirectory);
  assert.deepEqual(await host.adoptProjectHistory({ historyKey: stranded.historyKey }), {
    status: "adopted",
  });
  const restored = await observation.waitFor(
    (result) => result.ok && result.view.commands.length === 1,
  );
  assert.equal(restored.ok, true);

  // Registry re-point and nothing else: one field of one record moved.
  const registryAfter = await readRegistry(dataDirectory);
  assert.equal(registryAfter.revision > registryBefore.revision, true);
  assert.deepEqual(
    registryAfter.records.map((record) => record.recordKey).sort(),
    registryBefore.records.map((record) => record.recordKey).sort(),
  );
  const adopted = registryAfter.records.find(
    (record) => record.canonicalDirectory === strandedDirectory,
  )!;
  assert.equal(adopted.ledgerSlot, strandedSlot);
  assert.deepEqual(
    registryAfter.records
      .filter((record) => record.canonicalDirectory !== strandedDirectory)
      .map((record) => record.ledgerSlot),
    registryBefore.records
      .filter((record) => record.canonicalDirectory !== strandedDirectory)
      .map((record) => record.ledgerSlot),
  );
  // No ledger file was copied, moved or deleted by the adoption.
  assert.deepEqual(await ledgerFiles(dataDirectory), beforeFiles);

  // Reversible: the history that was current is still offered and adoptable.
  const reopened = observation.latest()!;
  const again = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(reopened, "Adopting Project"),
  });
  if (again.status !== "discovered") assert.fail("Expected the histories again.");
  const currentNow = again.snapshot.histories.find((history) => history.current)!;
  assert.equal(currentNow.sessionCount, 1);
  const previous = again.snapshot.histories.find((history) => !history.current)!;
  assert.equal(previous.sessionCount, 0);
  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: previous.historyKey }),
    { status: "adopted" },
  );
  await observation.waitFor(
    (result) => result.ok && result.view.commands.length === 0,
  );
  assert.equal(
    (await readRegistry(dataDirectory)).records.find(
      (record) => record.canonicalDirectory === strandedDirectory,
    )!.ledgerSlot,
    registryBefore.records.find(
      (record) => record.canonicalDirectory === strandedDirectory,
    )!.ledgerSlot,
  );
  assert.deepEqual(await ledgerFiles(dataDirectory), beforeFiles);
  observation.dispose();
});

test("hiding an empty history persists without changing a ledger and refuses recorded Sessions", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-history-hide-"));
  const strandedDirectory = join(root, "Hiding Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(strandedDirectory);
  await mkdir(otherDirectory);

  const { host, strandedSlot } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory,
    otherDirectory,
  });
  let reopenedHost: Host | undefined;
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  const opened = await observation.waitFor((result) => result.ok);
  const emptySlot = (await readRegistry(dataDirectory)).records.find(
    (record) => record.canonicalDirectory === strandedDirectory,
  )!.ledgerSlot;

  const firstDiscovery = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(opened, "Hiding Project"),
  });
  if (firstDiscovery.status !== "discovered") {
    assert.fail("Expected the Project's histories.");
  }
  const recordedHistory = firstDiscovery.snapshot.histories.find(
    (history) => !history.current,
  )!;
  assert.equal(recordedHistory.sessionCount, 1);
  const beforeRefusal = await fingerprintLedgers(dataDirectory);
  assert.deepEqual(
    await host.hideProjectHistory({ historyKey: recordedHistory.historyKey }),
    { status: "ineligible" },
  );
  assert.deepEqual(await fingerprintLedgers(dataDirectory), beforeRefusal);

  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: recordedHistory.historyKey }),
    { status: "adopted" },
  );
  await observation.waitFor(
    (result) => result.ok && result.view.commands.length === 1,
  );
  const secondDiscovery = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(observation.latest()!, "Hiding Project"),
  });
  if (secondDiscovery.status !== "discovered") {
    assert.fail("Expected the Project's histories after adoption.");
  }
  const emptyHistory = secondDiscovery.snapshot.histories.find(
    (history) => !history.current,
  )!;
  assert.equal(emptyHistory.sessionCount, 0);
  const beforeHide = await fingerprintLedgers(dataDirectory);
  assert.deepEqual(
    await host.hideProjectHistory({ historyKey: emptyHistory.historyKey }),
    { status: "hidden" },
  );
  assert.deepEqual(await fingerprintLedgers(dataDirectory), beforeHide);

  const hidden = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(observation.latest()!, "Hiding Project"),
  });
  if (hidden.status !== "discovered") {
    assert.fail("Expected the Project's remaining history.");
  }
  assert.equal(hidden.snapshot.histories.length, 1);
  assert.equal(hidden.snapshot.histories[0]?.current, true);
  const rawAfterHide = discoverProjectLedgers({
    ledgerDirectory: join(dataDirectory, ledgerDirectoryName),
    canonicalDirectory: strandedDirectory,
    registeredLedgerSlot: strandedSlot,
  });
  assert.equal(
    rawAfterHide.some(
      (history) =>
        history.ledgerSlot === emptySlot && history.sessionCount === 0,
    ),
    true,
    "the hidden empty ledger must remain byte-for-byte present on disk",
  );

  observation.dispose();
  await host.close();
  reopenedHost = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: strandedDirectory,
    adapter: new SyntheticAdapter(),
  });
  registerTestClosable(t, reopenedHost);
  const reopenedObservation = observeHost(reopenedHost);
  registerTestCleanup(t, reopenedObservation.dispose);
  const reopened = await reopenedObservation.waitFor((result) => result.ok);
  const afterRestart = await reopenedHost.discoverProjectHistories({
    selectionKey: selectionKeyFor(reopened, "Hiding Project"),
  });
  if (afterRestart.status !== "discovered") {
    assert.fail("Expected histories after restart.");
  }
  assert.equal(afterRestart.snapshot.histories.length, 1);
  assert.equal(afterRestart.snapshot.histories[0]?.current, true);
  assert.deepEqual(await fingerprintLedgers(dataDirectory), beforeHide);
});

test("adoption refuses stale, forged, widened, and no-longer-offered histories", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-history-refusal-"));
  const strandedDirectory = join(root, "Refusing Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(strandedDirectory);
  await mkdir(otherDirectory);

  const { host } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory,
    otherDirectory,
  });
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  const opened = await observation.waitFor((result) => result.ok);
  const registryBefore = JSON.stringify(await readRegistry(dataDirectory));

  const discovered = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(opened, "Refusing Project"),
  });
  if (discovered.status !== "discovered") {
    assert.fail("Expected the Project's histories.");
  }
  const stranded = discovered.snapshot.histories.find(
    (history) => !history.current,
  )!;

  // Forged and widened requests never reach the registry writer.
  for (const request of [
    { historyKey: "project-history:not-a-uuid" },
    { historyKey: stranded.historyKey, extra: true },
    { historyKey: stranded.historyKey.replace("project-history:", "") },
    {},
  ] as unknown as { readonly historyKey: string }[]) {
    assert.deepEqual(await host.adoptProjectHistory(request), {
      status: "invalid-selection",
    });
  }

  // Discovering another Project rotates the keys: the earlier ones are dead.
  const otherDiscovery = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(opened, "Other Project"),
  });
  assert.equal(otherDiscovery.status, "discovered");
  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: stranded.historyKey }),
    { status: "invalid-selection" },
  );

  // A slot that discovery no longer offers for this exact directory is refused
  // even when its key is live: adoption re-checks the store before it writes.
  const refreshed = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(observation.latest()!, "Refusing Project"),
  });
  if (refreshed.status !== "discovered") assert.fail("Expected the histories.");
  const target = refreshed.snapshot.histories.find(
    (history) => !history.current,
  )!;
  const registeredSlots = new Set(
    (await readRegistry(dataDirectory)).records.map(
      (record) => record.ledgerSlot,
    ),
  );
  const strandedFile = (await ledgerFiles(dataDirectory)).find(
    (name) => !registeredSlots.has(name.replace(/\.sqlite$/u, "")),
  );
  assert.notEqual(strandedFile, undefined);
  await rm(join(dataDirectory, ledgerDirectoryName, strandedFile!), {
    force: true,
    maxRetries: 40,
    retryDelay: 50,
  });
  assert.equal((await ledgerFiles(dataDirectory)).includes(strandedFile!), false);
  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: target.historyKey }),
    { status: "invalid-selection" },
  );

  // Nothing was written at any point in this test.
  assert.equal(JSON.stringify(await readRegistry(dataDirectory)), registryBefore);
  observation.dispose();
});

test("a live turn blocks adoption, and the same choice succeeds once it finishes", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "workbench-history-blocked-"));
  const strandedDirectory = join(root, "Busy Project");
  const otherDirectory = join(root, "Other Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(strandedDirectory);
  await mkdir(otherDirectory);

  const { host, adapter } = await strandOneHistory(t, {
    dataDirectory,
    strandedDirectory,
    otherDirectory,
  });
  registerTestCleanup(t, () => adapter.releaseTurn());
  const observation = observeHost(host);
  registerTestCleanup(t, observation.dispose);
  await observation.waitFor((result) => result.ok);

  adapter.holdNextTurn();
  await submitOneSession(host);
  await observation.waitFor(
    (result) =>
      result.ok &&
      result.view.commands.length === 1 &&
      (result.view.commands[0]?.status === "accepted" ||
        result.view.commands[0]?.status === "in-flight"),
  );

  const discovered = await host.discoverProjectHistories({
    selectionKey: selectionKeyFor(observation.latest()!, "Busy Project"),
  });
  if (discovered.status !== "discovered") {
    assert.fail("Expected the Project's histories.");
  }
  const target = discovered.snapshot.histories.find(
    (history) => !history.current,
  )!;
  const blocked = await host.adoptProjectHistory({
    historyKey: target.historyKey,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(
    blocked.status === "blocked" &&
      (blocked.activity === "accepted" || blocked.activity === "in-flight"),
    true,
  );

  adapter.releaseTurn();
  await observation.waitFor(
    (result) =>
      result.ok && result.view.commands[0]?.status === "completed",
  );
  assert.deepEqual(
    await host.adoptProjectHistory({ historyKey: target.historyKey }),
    { status: "adopted" },
  );
  observation.dispose();
});

// A discovery result never carries a durable identity, so the renderer contract
// can only ever be handed counts. This guards that shape at the seam boundary.
test("the public discovery shape admits counts and rotating keys only", async () => {
  const result: WorkbenchProjectHistoryDiscoveryResult = {
    status: "discovered",
    snapshot: {
      projectLabel: "Project",
      histories: [
        {
          historyKey: "project-history:11111111-1111-4111-8111-111111111111",
          current: true,
          sessionCount: 0,
          commandCount: 0,
          updateCount: 0,
          byteSize: 0,
          lastModified: "1970-01-01T00:00:00Z",
          schemaVersion: 0,
        },
      ],
    },
  };
  assert.deepEqual(
    Object.keys(result.snapshot.histories[0]!).sort(),
    [
      "byteSize",
      "commandCount",
      "current",
      "historyKey",
      "lastModified",
      "schemaVersion",
      "sessionCount",
      "updateCount",
    ],
  );
});
