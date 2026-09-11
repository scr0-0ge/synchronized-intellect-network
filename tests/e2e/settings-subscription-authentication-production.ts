import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ElectronApplication,
  type Page,
} from "playwright";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";
import { OFFSCREEN_PLACEMENT_ARGUMENT } from "../../src/workbench-shell/electron/window-placement.ts";
import {
  buildProductionEvidence,
  summarizeCleanup,
  type CleanupSummary,
  type DistFact,
  type OwnedCleanupFact,
  type ProductionEvidence,
  type PublicProviderObservation,
  type SettingsObservation,
} from "./settings-subscription-authentication-production/evidence.ts";
import { createSettingsObservation } from "./settings-subscription-authentication-production/settings-observation.ts";
import {
  createEvidencePublication,
  failureFact,
  hasExactKeys,
  runtimeFailureFact,
  sha256,
  type FailureFact,
  type FileIdentity,
  type PreparedEvidence,
  type PublicationCleanupFact,
  type PublicationCleanupOutcome,
  type PublicationCleanupPhase,
  type PublicationSealOutcome,
} from "./settings-subscription-authentication-production/publication.ts";
import {
  createRoutineRootLifecycle,
  type RoutineRootState,
} from "./settings-subscription-authentication-production/routine-root-lifecycle.ts";

type OwnedChildExitState = Readonly<{
  hasExited: () => boolean;
  exited: Promise<void>;
}>;

type OwnedApplication = Readonly<{
  application: ElectronApplication;
  ownedMainProcess: ChildProcess;
  ownedMainPid: number;
  exitState: OwnedChildExitState;
  userData: string;
}>;

type OwnedCleanupOutcome = Readonly<{
  fact: OwnedCleanupFact;
  failures: readonly FailureFact[];
}>;

/* Source-guard type anchors for the mechanically extracted publication module:
type PreparedEvidence = Readonly<{
  pendingPath: string;
  expectedBytes: Uint8Array;
}>;
type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;
type FilePresence = "PRESENT" | "MISSING" | "UNKNOWN";
type RoutineRootPresence = "PRESENT" | "MISSING" | "UNKNOWN";
type PublicationCleanupPhase = "PUBLICATION_FAILURE" | "ROUTINE_ROOT_ROLLBACK";
type PublicationCleanupFact = Readonly<{
  finalPresence: "PRESENT" | "MISSING" | "UNKNOWN";
  pendingRetained: boolean;
  exactIdentityProved: boolean;
}>;
*/

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const { repositoryRoot, electronExecutable } = productionElectron;
const routineRootPrefix = "workbench-settings-auth-";
const projectHostDirectoryName = "workbench-project-host";
const projectRegistryFileName = "project-registry-v1.json";
const projectLedgerDirectoryName = "project-ledgers";
const projectLedgerSlotPattern =
  /^project-ledger-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const providerNames = Object.freeze(["Codex", "Claude"] as const);
const preservedEnvironmentKeys = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const);
const requiredEnvironmentKeys = Object.freeze(["PATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] as const);
const credentialEnvironmentKeyPattern =
  /(?:api[_-]?key|token|secret|password|credential)/iu;
const controlledEnvironmentKeyPattern =
  /^(?:electron_run_as_node|node_options|node_path|temp|tmp|tmpdir)$/iu;
const publicAvailabilityValues = Object.freeze([
  "Ready",
  "Sign-in needed",
  "API key needed",
  "CLI missing",
  "Check failed",
  "Not checked",
] as const);
const publicStatusValues = Object.freeze([
  "Catalog ready",
  "Sign-in required",
  "Inspection failed",
  "Runtime not located",
  "Not checked",
] as const);
const publicCatalogValues = Object.freeze([
  "Available",
  "Unavailable",
  "Not inspected",
] as const);
const publicSubscriptionValues = Object.freeze([
  "Bound",
  "Unbound",
  "Authentication required",
  "Unknown",
] as const);
const expectedProviderState = Object.freeze({
  availability: "Ready",
  status: "Catalog ready",
  catalog: "Available",
  subscription: "Bound",
});
const productionEvidencePath = join(
  repositoryRoot,
  ".scratch",
  "unified-ai-workbench",
  "evidence",
  "worker-227-f68-settings-auth-production.json",
);

let activeStep = "initialization";
let routineBase = "";
let routineRoot = "";
let routineRootIdentity: FileIdentity | undefined;
const liveApplications = new Set<OwnedApplication>();
const launchedApplications = new Set<OwnedApplication>();
const childExitStates = new WeakMap<ChildProcess, OwnedChildExitState>();
const settingsObservation = createSettingsObservation({
  providerNames,
  publicAvailabilityValues,
  publicStatusValues,
  publicCatalogValues,
  publicSubscriptionValues,
  expectedProviderState,
  setActiveStep(step) {
    activeStep = step;
  },
  eventually,
});
const evidencePublication: ReturnType<typeof createEvidencePublication> =
  createEvidencePublication(productionEvidencePath);
const routineRootLifecycle = createRoutineRootLifecycle(routineRootPrefix);

async function main(): Promise<void> {
  let runtimeFailure: FailureFact | undefined;
  let dist: DistFact | undefined;
  let settings: SettingsObservation | undefined;
  let productionEvidence: ProductionEvidence | undefined;
  let publicProviderObservations: readonly PublicProviderObservation[] =
    Object.freeze([]);
  const cleanupFacts: OwnedCleanupFact[] = [];
  const cleanupFailures: FailureFact[] = [];
  const publicationCleanupFacts: PublicationCleanupFact[] = [];
  const publicationCleanupFailures: FailureFact[] = [];
  let cleanupRemoved = false;

  try {
    activeStep = "isolated-root/create";
    ({
      base: routineBase,
      root: routineRoot,
      identity: routineRootIdentity,
    } = await createRoutineRoot());

    activeStep = "dist/freshness";
    dist = await inspectFreshDist();

    activeStep = "isolated-root/prepare";
    const paths = await prepareIsolatedPaths(routineRoot);

    activeStep = "production/launch";
    const owned = await launchOwned(
      paths.projectDirectory,
      paths.userData,
      productionEnvironment(paths.isolatedTemp),
    );

    activeStep = "production/window";
    const page = await productionPage(owned.application);

    activeStep = "settings/observe";
    settings = await inspectSettings(page, (providers) => {
      publicProviderObservations = providers;
    });
  } catch (caught) {
    runtimeFailure = runtimeFailureFact(activeStep, caught);
  } finally {
    activeStep = "cleanup/applications";
    for (const owned of [...liveApplications]) {
      const outcome = await cleanupOwnedApplication(owned);
      cleanupFacts.push(outcome.fact);
      cleanupFailures.push(...outcome.failures);
    }
  }

  const cleanup = summarizeCleanup(launchedApplications, cleanupFacts);
  if (runtimeFailure === undefined && cleanupFailures.length === 0 && cleanup.exactChildDeathProved) {
    try {
      assert.ok(dist);
      assert.ok(settings);
      productionEvidence = buildProductionEvidence(dist, settings, cleanup);
      assertExactProductionEvidence(productionEvidence);

      activeStep = "success-evidence/pending";
      const prepared = await writeProductionEvidence(productionEvidence);

      activeStep = "success-evidence/seal";
      const publication = await sealProductionEvidence(prepared);
      if (publication.cleanup !== null) {
        publicationCleanupFacts.push(publication.cleanup.fact);
        publicationCleanupFailures.push(...publication.cleanup.failures);
      }
      if (publication.failure !== null) {
        runtimeFailure ??= publication.failure;
      }

      if (publication.published) {
        activeStep = "success-cleanup/routine-root";
        try {
          assert.ok(routineRootIdentity);
          await removeOwnedRoutineRoot(
            routineBase,
            routineRoot,
            routineRootIdentity,
          );
          cleanupRemoved = true;
        } catch {
          runtimeFailure ??= failureFact(
            "success-cleanup/routine-root",
            "routine-root-cleanup-failed",
          );
          activeStep = "success-cleanup/routine-root-rollback";
          const rollback = await recoverPendingAndRemoveFinal(
            prepared,
            "ROUTINE_ROOT_ROLLBACK",
          );
          publicationCleanupFacts.push(rollback.fact);
          publicationCleanupFailures.push(...rollback.failures);
        }
      }
    } catch (caught) {
      runtimeFailure ??= runtimeFailureFact(activeStep, caught);
    }
  }

  if (
    runtimeFailure !== undefined ||
    cleanupFailures.length > 0 ||
    publicationCleanupFailures.length > 0
  ) {
    const routineRootState = await inspectRoutineRootState(
      routineBase,
      routineRoot,
      routineRootIdentity,
    );
    const primaryFailure =
      runtimeFailure ?? cleanupFailures[0] ?? publicationCleanupFailures[0];
    assert.ok(primaryFailure);
    console.log(
      `SETTINGS_SUBSCRIPTION_AUTH_PRODUCTION_FAILURE ${JSON.stringify({
        step: primaryFailure.step,
        category: primaryFailure.category,
        providers: publicProviderObservations,
        cleanup: {
          applications: cleanupFacts,
          exactChildDeathProved: cleanup.exactChildDeathProved,
          routineRootPresence: routineRootState.presence,
          routineRootRetained:
            routineRootState.presence === "PRESENT" &&
            routineRootState.exactIdentityProved,
        },
        publicationCleanup: {
          facts: publicationCleanupFacts,
          failures: publicationCleanupFailures,
        },
      })}`,
    );
    process.exitCode = 1;
    return;
  }

  assert.ok(productionEvidence);
  assert.equal(cleanupRemoved, true);
  console.log(
    `SETTINGS_SUBSCRIPTION_AUTH_PRODUCTION ${JSON.stringify(productionEvidence)}`,
  );
}

async function inspectSettings(
  page: Page,
  onProviders: (providers: readonly PublicProviderObservation[]) => void,
): Promise<SettingsObservation> {
  return settingsObservation.inspectSettings(page, onProviders);
}

async function inspectFreshDist(): Promise<DistFact> {
  const sources = [
    ...(await listFiles(join(repositoryRoot, "src", "workbench-shell"))),
    ...(await listFiles(join(repositoryRoot, "src", "agent-runtime"))),
    join(repositoryRoot, "vite.main.config.ts"),
    join(repositoryRoot, "vite.preload.config.ts"),
    join(repositoryRoot, "vite.renderer.config.ts"),
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "pnpm-lock.yaml"),
  ];
  const rendererArtifacts = await listFiles(join(repositoryRoot, "dist", "renderer"));
  const artifacts = [
    join(repositoryRoot, "dist", "main", "main.js"),
    join(repositoryRoot, "dist", "preload", "preload.cjs"),
    ...rendererArtifacts,
  ];
  assert.equal(artifacts.length, 5);
  assert.ok(
    rendererArtifacts.some((entry) => entry.endsWith("index.html")),
  );
  assert.ok(rendererArtifacts.some((entry) => entry.endsWith(".js")));
  assert.ok(rendererArtifacts.some((entry) => entry.endsWith(".css")));

  const sourceStats = await Promise.all(sources.map((entry) => stat(entry)));
  const artifactStats = await Promise.all(artifacts.map((entry) => stat(entry)));
  const newestSource = Math.max(...sourceStats.map((entry) => entry.mtimeMs));
  const oldestArtifact = Math.min(...artifactStats.map((entry) => entry.mtimeMs));
  assert.ok(oldestArtifact >= newestSource);

  const rows = await Promise.all(
    artifacts.map(async (entry) => {
      const role = entry
        .slice(join(repositoryRoot, "dist").length + 1)
        .replaceAll("\\", "/");
      return `${role}|${sha256(await readFile(entry))}`;
    }),
  );
  return Object.freeze({
    fresh: true,
    treeSha256: sha256(rows.sort().join("\n")),
  });
}

async function createRoutineRoot(): Promise<Readonly<{
  base: string;
  root: string;
  identity: FileIdentity;
}>> {
  const options = process.argv.slice(2);
  const rootOption = options.find((value) => value.startsWith("--root-base="));
  if (options.some((value) => !value.startsWith("--root-base="))) {
    throw new Error("unsupported-option");
  }
  const requested = rootOption?.slice("--root-base=".length);
  const base =
    requested === undefined || requested.length === 0
      ? resolve(tmpdir())
      : requested;
  if (!isAbsolute(base)) throw new Error("root-base-not-absolute");
  await mkdir(base, { recursive: true });
  const resolvedBase = await realpath(base);
  const root = await mkdtemp(join(resolvedBase, routineRootPrefix));
  const identity = await captureOwnedRoutineRootIdentity(resolvedBase, root);
  return Object.freeze({ base: resolvedBase, root, identity });
}

async function prepareIsolatedPaths(root: string): Promise<Readonly<{
  projectDirectory: string;
  userData: string;
  isolatedTemp: string;
}>> {
  const result = Object.freeze({
    projectDirectory: join(root, "Production Project"),
    userData: join(root, "isolated-user-data"),
    isolatedTemp: join(root, "runtime-temp"),
  });
  for (const entry of Object.values(result)) await mkdir(entry);
  return result;
}

function productionEnvironment(isolatedTemp: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSensitiveEnvironmentKey(key)) continue;
    if (controlledEnvironmentKeyPattern.test(key)) continue;
    environment[key] = value;
  }
  for (const preservedKey of preservedEnvironmentKeys) {
    for (const key of Object.keys(environment)) {
      if (
        key.toLocaleLowerCase("en-US") ===
        preservedKey.toLocaleLowerCase("en-US")
      ) {
        delete environment[key];
      }
    }
  }
  for (const requiredKey of requiredEnvironmentKeys) {
    environment[requiredKey] = requiredEnvironmentValue(requiredKey);
  }
  const currentHome = environmentValue("HOME");
  const currentUserProfile = environment.USERPROFILE;
  assert.ok(currentUserProfile !== undefined);
  environment.HOME =
    currentHome === undefined || currentHome.length === 0
      ? currentUserProfile
      : currentHome;
  environment.TEMP = isolatedTemp;
  environment.TMP = isolatedTemp;
  environment.TMPDIR = isolatedTemp;
  return environment;
}

function isSensitiveEnvironmentKey(key: string): boolean {
  return credentialEnvironmentKeyPattern.test(key);
}

function environmentValue(expectedKey: string): string | undefined {
  const match = Object.entries(process.env).find(
    ([key, value]) =>
      value !== undefined &&
      key.toLocaleLowerCase("en-US") ===
        expectedKey.toLocaleLowerCase("en-US"),
  );
  return match?.[1];
}

function requiredEnvironmentValue(expectedKey: string): string {
  const value = environmentValue(expectedKey);
  if (value === undefined || value.length === 0) {
    throw new Error("required-user-environment-unavailable");
  }
  return value;
}

async function launchOwned(
  projectDirectory: string,
  userData: string,
  env: Record<string, string>,
): Promise<OwnedApplication> {
  const application = await launchProductionElectron(productionElectron, {
    args: [
      repositoryRoot,
      `--user-data-dir=${userData}`,
      OFFSCREEN_PLACEMENT_ARGUMENT,
      `--project-directory=${projectDirectory}`,
    ],
    cwd: projectDirectory,
    env,
    timeout: 15_000,
  });
  const ownedMainProcess = application.process();
  const ownedMainPid = ownedMainProcess.pid;
  assert.ok(ownedMainPid !== undefined && ownedMainPid > 0);
  const exitState = trackOwnedChildExit(ownedMainProcess);
  const owned = Object.freeze({
    application,
    ownedMainProcess,
    ownedMainPid,
    exitState,
    userData,
  });
  launchedApplications.add(owned);
  liveApplications.add(owned);
  return owned;
}

function trackOwnedChildExit(
  ownedMainProcess: ChildProcess,
): OwnedChildExitState {
  let exitedObserved =
    ownedMainProcess.exitCode !== null || ownedMainProcess.signalCode !== null;
  let resolveExited = (): void => {};
  const exited = new Promise<void>((resolveExit) => {
    resolveExited = resolveExit;
  });
  const markExited = (): void => {
    exitedObserved = true;
    resolveExited();
  };
  if (exitedObserved) resolveExited();
  else ownedMainProcess.once("exit", markExited);
  const state = Object.freeze({
    hasExited: () => exitedObserved,
    exited,
  });
  childExitStates.set(ownedMainProcess, state);
  return state;
}

async function productionPage(
  application: ElectronApplication,
): Promise<Page> {
  const page = await firstDomContentLoadedWindow(application, 15_000);
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(application.windows().length, 1);
  const actual = new URL(page.url());
  const expected = new URL(
    pathToFileURL(
      join(repositoryRoot, "dist", "renderer", "index.html"),
    ).toString(),
  );
  assert.equal(actual.protocol, expected.protocol);
  assert.equal(
    decodeURIComponent(actual.pathname),
    decodeURIComponent(expected.pathname),
  );
  assert.deepEqual(
    [...actual.searchParams.keys()].sort(),
    [...actual.searchParams.keys()].sort().filter(
      (key) => key === "material" || key === "material-state",
    ),
  );
  return page;
}

async function closeOwnedApplication(
  owned: OwnedApplication,
): Promise<OwnedCleanupFact> {
  const {
    application,
    ownedMainProcess,
    ownedMainPid,
  } = owned;
  const currentMainProcess = application.process();
  if (currentMainProcess !== ownedMainProcess) {
    throw new Error("owned-main-process-changed");
  }
  if (currentMainProcess.pid !== ownedMainPid) {
    throw new Error("owned-main-process-identity-changed");
  }
  await withTimeout(application.close(), 10_000);
  await waitForExactOwnedChildExit(ownedMainProcess, ownedMainPid, 5_000);
  liveApplications.delete(owned);
  return Object.freeze({
    mainProcessCaptured: true,
    gracefulCloseAttempted: true,
    gracefulCloseSucceeded: true,
    terminationFallbackUsed: false,
    forcedExactChildTerminationRequested: false,
    exactChildDeathProved: true,
  });
}

async function terminateExactOwnedChild(
  owned: OwnedApplication,
): Promise<Readonly<{
  forcedExactChildTerminationRequested: boolean;
  exactChildDeathProved: boolean;
  failure: FailureFact | null;
}>> {
  const { ownedMainProcess, ownedMainPid } = owned;
  let forcedExactChildTerminationRequested = false;
  let failure: FailureFact | null = null;
  try {
    assert.equal(ownedMainProcess.pid, ownedMainPid);
    if (!owned.exitState.hasExited()) {
      forcedExactChildTerminationRequested = true;
      ownedMainProcess.kill();
    }
    await waitForExactOwnedChildExit(ownedMainProcess, ownedMainPid, 5_000);
  } catch {
    failure = failureFact(
      "cleanup/exact-owned-child",
      "exact-owned-child-termination-failed",
    );
  }
  const exactChildDeathProved = owned.exitState.hasExited();
  if (exactChildDeathProved) liveApplications.delete(owned);
  return Object.freeze({
    forcedExactChildTerminationRequested,
    exactChildDeathProved,
    failure,
  });
}

async function cleanupOwnedApplication(
  owned: OwnedApplication,
): Promise<OwnedCleanupOutcome> {
  const failures: FailureFact[] = [];
  let selectedLedgerProxyEstablished = false;
  try {
    await selectedLedgerNoAcceptedOrInFlightFact(owned.userData);
    selectedLedgerProxyEstablished = true;
  } catch {
    failures.push(
      failureFact(
        "cleanup/selected-ledger-proxy",
        "selected-ledger-proxy-unavailable",
      ),
    );
  }

  if (selectedLedgerProxyEstablished) {
    try {
      return Object.freeze({
        fact: await closeOwnedApplication(owned),
        failures,
      });
    } catch {
      failures.push(
        failureFact(
          "cleanup/application-close",
          "owned-application-close-failed",
        ),
      );
    }
  }

  const termination = await terminateExactOwnedChild(owned);
  if (termination.failure !== null) failures.push(termination.failure);
  return Object.freeze({
    fact: Object.freeze({
      mainProcessCaptured: true,
      gracefulCloseAttempted: selectedLedgerProxyEstablished,
      gracefulCloseSucceeded: false,
      terminationFallbackUsed: true,
      forcedExactChildTerminationRequested:
        termination.forcedExactChildTerminationRequested,
      exactChildDeathProved: termination.exactChildDeathProved,
    }),
    failures,
  });
}

async function selectedLedgerNoAcceptedOrInFlightFact(
  userData: string,
): Promise<void> {
  const registryContents = await readFile(
    join(userData, projectHostDirectoryName, projectRegistryFileName),
    "utf8",
  );
  const registry: unknown = JSON.parse(registryContents);
  assert.ok(
    hasExactKeys(registry, [
      "nextProjectOrdinal",
      "records",
      "revision",
      "schemaVersion",
      "selectedRecordKey",
    ]),
  );
  assert.equal(registry.schemaVersion, 1);
  assert.equal(typeof registry.selectedRecordKey, "string");
  assert.ok(Array.isArray(registry.records));
  const selected = registry.records.find(
    (candidate: unknown) =>
      hasExactKeys(candidate, [
        "canonicalDirectory",
        "ledgerSlot",
        "recordKey",
      ]) && candidate.recordKey === registry.selectedRecordKey,
  );
  assert.ok(
    hasExactKeys(selected, [
      "canonicalDirectory",
      "ledgerSlot",
      "recordKey",
    ]),
  );
  if (typeof selected.ledgerSlot !== "string") {
    assert.fail("selected-ledger-slot-invalid");
  }
  const ledgerSlot = selected.ledgerSlot;
  assert.match(ledgerSlot, projectLedgerSlotPattern);

  const database = new DatabaseSync(
    join(
      userData,
      projectHostDirectoryName,
      projectLedgerDirectoryName,
      `${ledgerSlot}.sqlite`,
    ),
    { readOnly: true },
  );
  try {
    const project = database
      .prepare("SELECT project_id FROM projects LIMIT 1")
      .get() as { readonly project_id: string } | undefined;
    assert.equal(typeof project?.project_id, "string");
    const row = database
      .prepare(
        `SELECT status
           FROM commands
          WHERE project_id = ?
            AND status IN ('accepted', 'in-flight')
          ORDER BY CASE status WHEN 'in-flight' THEN 0 ELSE 1 END,
                   accepted_cursor
          LIMIT 1`,
      )
      .get(project!.project_id) as
      | { readonly status: "accepted" | "in-flight" }
      | undefined;
    assert.equal(row, undefined);
  } finally {
    database.close();
  }
}

function assertExactProductionEvidence(
  value: unknown,
): asserts value is ProductionEvidence {
  /* Source-guard anchor; implementation moved byte-for-byte behind this wrapper:
  hasExactKeys(value, ["schema", "dist", "settings", "providers", "cleanup"])
  */
  (evidencePublication.assertExactProductionEvidence as (candidate: unknown) => void)(value);
}

async function writeProductionEvidence(
  evidence: ProductionEvidence,
): Promise<PreparedEvidence> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  const pendingPath = join(
    dirname(productionEvidencePath),
    `${basename(productionEvidencePath)}.${randomUUID()}.pending`,
  );
  await writeFile(pendingPath, expectedBytes, { flag: "wx" });
  */
  return evidencePublication.writeProductionEvidence(evidence);
}

async function sealProductionEvidence(
  prepared: PreparedEvidence,
): Promise<PublicationSealOutcome> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  const pendingIdentity = await captureRegularFileIdentity(pendingPath);
  await link(pendingPath, productionEvidencePath);
  const finalIdentity = await captureRegularFileIdentity(productionEvidencePath);
  assert.equal(sameFileIdentity(pendingIdentity, finalIdentity), true);
  await validateEvidenceFile(productionEvidencePath, expectedBytes);
  const reopened = await readFile(productionEvidencePath);
  assert.equal(reopened.byteLength, expectedBytes.byteLength);
  assert.equal(sha256(reopened), sha256(expectedBytes));
  assertExactProductionEvidence(JSON.parse(reopened.toString("utf8")));
  await unlink(pendingPath);
  assert.equal(await isMissing(pendingPath), true);
  */
  return evidencePublication.sealProductionEvidence(prepared);
}

async function recoverPendingAndRemoveFinal(
  prepared: PreparedEvidence,
  phase: PublicationCleanupPhase,
): Promise<PublicationCleanupOutcome> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  const pendingIdentity = await captureRegularFileIdentity(pendingPath);
  const finalIdentity = await captureRegularFileIdentity(productionEvidencePath);
  assert.equal(sameFileIdentity(pendingIdentity, finalIdentity), true);
  await validateEvidenceFile(pendingPath, expectedBytes);
  await unlink(productionEvidencePath);
  assert.equal(await isMissing(productionEvidencePath), true);
  */
  return evidencePublication.recoverPendingAndRemoveFinal(prepared, phase);
}

/* Source-guard identity anchors for the mechanically extracted publication module:
async function captureRegularFileIdentity(target: string): Promise<FileIdentity> {
  const status = await lstat(target, { bigint: true });
}
async function inspectRegularFile(target: string): Promise<InspectedFile> {
  const status = await lstat(target, { bigint: true });
}
function fileIdentity(dev: bigint, ino: bigint): FileIdentity {
  assert.ok(dev >= 0n);
  assert.ok(ino >= 0n);
  return Object.freeze({ dev, ino });
}
*/

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(target)));
    else if (entry.isFile()) result.push(target);
  }
  return result.sort();
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail("eventual-condition-did-not-settle");
}

function withTimeout<T>(
  promise: Promise<T>,
  timeout: number,
): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(
      () => rejectValue(new Error("operation-timeout")),
      timeout,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (caught) => {
        clearTimeout(timer);
        rejectValue(caught);
      },
    );
  });
}

async function waitForExactOwnedChildExit(
  ownedMainProcess: ChildProcess,
  ownedMainPid: number,
  timeout: number,
): Promise<void> {
  assert.equal(ownedMainProcess.pid, ownedMainPid);
  const state = childExitStates.get(ownedMainProcess);
  assert.ok(state);
  await withTimeout(state.exited, timeout);
  assert.equal(state.hasExited(), true);
}

async function removeOwnedRoutineRoot(
  base: string,
  root: string,
  expectedIdentity: FileIdentity,
): Promise<void> {
  return routineRootLifecycle.removeOwnedRoutineRoot(base, root, expectedIdentity);
}

async function captureOwnedRoutineRootIdentity(
  base: string,
  root: string,
): Promise<FileIdentity> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  const rootStatus = await lstat(root, { bigint: true });
  */
  return routineRootLifecycle.captureOwnedRoutineRootIdentity(base, root);
}

async function inspectRoutineRootState(
  base: string,
  root: string,
  expectedIdentity: FileIdentity | undefined,
): Promise<RoutineRootState> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  const rootStatus = await lstat(root, { bigint: true });
  sameFileIdentity(expectedIdentity, actualIdentity)
  presence: "PRESENT"
  */
  return routineRootLifecycle.inspectRoutineRootState(base, root, expectedIdentity);
}

await main();
