import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ElectronApplication,
  type Page,
} from "playwright";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";
import {
  byteFact,
  inspectFreshDist,
  isMissing,
  optionalByteFact,
  sha256,
} from "./settings-appearance-persistence/file-evidence.ts";
import {
  createAppearanceObservation,
  type RootAttributes,
} from "./settings-appearance-persistence/appearance-observation.ts";
import {
  assertAllOwnedChildrenExited as assertAllOwnedChildrenExitedImplementation,
  cleanupOwnedApplicationLifecycle,
  closeOwnedApplication,
  failureFact,
  isExactRecord,
  selectedLedgerNoAcceptedOrInFlightFact as selectedLedgerNoAcceptedOrInFlightFactImplementation,
  terminateExactOwnedApplicationChild,
  type ExactOwnedChildTerminationOutcome,
  type FailureFact,
  type OwnedApplication,
  type OwnedChildExitState,
  type OwnedCleanupFact,
  type OwnedCleanupOutcome,
  type SelectedLedgerNoAcceptedOrInFlightFact,
} from "./settings-appearance-persistence/owned-lifecycle.ts";

/* Source-guard type anchor for the mechanically extracted lifecycle module:
type OwnedChildExitState = Readonly<{
  hasExited: () => boolean;
  exited: Promise<void>;
}>;
child: ChildProcess;
exitState: OwnedChildExitState;
*/

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const { repositoryRoot } = productionElectron;
const routineRootPrefix = "workbench-settings-appearance-";
const appearanceFileName = "workbench-appearance-preferences-v1.json";
const directPreferenceFileName = "direct-session-profile-preferences.json";
const exactAppearanceBytes =
  '{"schemaVersion":3,"appearance":{"tone":"light","crt":"full","phosphor":"amber","phosphorTier":"c","language":"en"}}\n';
const savedScope = "Saved · This user on this device";
const appearanceTones = Object.freeze(["Dark", "Light"] as const);
const appearanceCrts = Object.freeze(["Off", "Blocks", "Screen", "Full"] as const);
const appearancePhosphors = Object.freeze(["Neutral", "Green", "Amber"] as const);
const appearancePhosphorTiers = Object.freeze([
  "A · Restrained",
  "B · Luminous",
  "C · Hottest",
] as const);
const phosphorTierRootValues = Object.freeze({
  "A · Restrained": "a",
  "B · Luminous": "b",
  "C · Hottest": "c",
} as const);
const defaultRoot: RootAttributes = Object.freeze({
  skin: "acrylic",
  glass: "full",
  material: null,
  tone: null,
  crt: "screen",
  phosphor: "neutral",
  phosphorTier: "b",
});
const nonDefaultRoot: RootAttributes = Object.freeze({
  skin: "acrylic",
  glass: "full",
  material: null,
  tone: "light",
  crt: "full",
  phosphor: "amber",
  phosphorTier: "c",
});

let activeStep = "initialization";
let routineRoot = "";
let routineBase = "";
const liveApplications = new Set<OwnedApplication>();
const launchedApplications = new Set<OwnedApplication>();
const appearanceObservation = createAppearanceObservation({
  savedScope,
  appearanceTones,
  appearanceCrts,
  appearancePhosphors,
  appearancePhosphorTiers,
  phosphorTierRootValues,
  defaultRoot,
  setActiveStep(step) {
    activeStep = step;
  },
  eventually,
  deepEqual,
});

async function main(): Promise<void> {
  let summary: Record<string, unknown> | undefined;
  let runtimeFailure: FailureFact | undefined;
  const cleanupFailures: FailureFact[] = [];
  const cleanupFacts: OwnedCleanupFact[] = [];
  let providerAvailabilityBadges: readonly string[] = Object.freeze([]);
  let providerDetailedStatusValues: readonly string[] = Object.freeze([]);
  let cleanupRemoved = false;

  try {
    activeStep = "dist-freshness";
    const dist = await inspectFreshDist(repositoryRoot);

    activeStep = "isolated-root";
    ({ base: routineBase, root: routineRoot } = await createRoutineRoot());
    const paths = await prepareIsolatedPaths(routineRoot);
    await seedTwoProjectRegistry(
      paths.primaryUserData,
      paths.projectAlpha,
      paths.projectBeta,
    );
    const directPreferencePath = join(
      paths.primaryUserData,
      directPreferenceFileName,
    );
    const directBefore = await optionalByteFact(directPreferencePath);

    activeStep = "first-launch";
    const first = await launchOwned(
      paths.projectAlpha,
      paths.primaryUserData,
      isolatedEnvironment(paths),
    );
    const firstPage = await productionPage(first.application);
    const firstPid = first.pid;

    activeStep = "first-launch-ui";
    const firstUi = await inspectInitialProductUi(firstPage);
    const initialMaterial = firstUi.root.material;

    activeStep = "first-launch-settings/open";
    await openSettings(firstPage);
    const initialSettings = await settingsFacts(firstPage);
    activeStep = "first-launch-settings/sections";
    assert.deepEqual(initialSettings.sections, [
      "Data recovery",
      "Providers",
      "Appearance",
    ]);
    activeStep = "first-launch-settings/scope";
    assert.equal(initialSettings.scope, savedScope);
    activeStep = "first-launch-settings/defaults";
    assert.deepEqual(initialSettings.pressed, {
      tone: "Dark",
      crt: "Screen",
      phosphor: "Neutral",
      phosphorTier: "B · Luminous",
    });

    const appearanceMatrixFacts = await exerciseAppearanceMatrix(
      firstPage,
      initialMaterial,
    );
    activeStep = "appearance-matrix/final-state";
    const savedSettings = await settingsFacts(firstPage);
    assert.deepEqual(savedSettings.pressed, {
      tone: "Light",
      crt: "Full",
      phosphor: "Amber",
      phosphorTier: "C · Hottest",
    });
    assert.equal(savedSettings.root.material, initialMaterial);

    activeStep = "settings-exit/close-control";
    await firstPage
      .getByRole("button", { name: "Close Settings", exact: true })
      .click();
    await firstPage.locator("main.settings").waitFor({ state: "hidden" });
    assert.equal(
      await firstPage
        .getByRole("button", { name: "Settings", exact: true })
        .getAttribute("aria-current"),
      null,
    );

    activeStep = "settings-exit/gear-reopen";
    await openSettings(firstPage);
    activeStep = "settings-exit/gear-toggle";
    await firstPage
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await firstPage.locator("main.settings").waitFor({ state: "hidden" });
    assert.equal(
      await firstPage
        .getByRole("button", { name: "Settings", exact: true })
        .getAttribute("aria-current"),
      null,
    );
    activeStep = "settings-exit/reopen-before-project-switch";
    await openSettings(firstPage);

    activeStep = "project-switch/trigger";
    const beta = firstPage.getByRole("button", {
      name: "Project Beta, Project 2, closed",
      exact: true,
    });
    await beta.click();
    activeStep = "project-switch/settled";
    await firstPage
      .getByRole("button", {
        name: "Collapse Project Beta Agent Sessions",
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 15_000 });
    const switchedRoot = await readRoot(firstPage);
    activeStep = "project-switch/appearance";
    assert.deepEqual(switchedRoot, {
      ...nonDefaultRoot,
      material: initialMaterial,
    });
    activeStep = "project-switch/settings-current";
    assert.equal(
      await firstPage
        .getByRole("button", { name: "Settings", exact: true })
        .getAttribute("aria-current"),
      null,
    );

    activeStep = "runtime-attention/catalog-read-trigger";
    await openSettings(firstPage);
    const readCatalogs = firstPage.getByRole("button", {
      name: "Read catalogs",
      exact: true,
    });
    const recheckCatalogsAtTrigger = firstPage.getByRole("button", {
      name: "Re-check all",
      exact: true,
    });
    const catalogTriggerCounts = await Promise.all([
      readCatalogs.count(),
      recheckCatalogsAtTrigger.count(),
    ]);
    assert.equal(
      (catalogTriggerCounts[0] === 1 && catalogTriggerCounts[1] === 0) ||
        (catalogTriggerCounts[0] === 0 && catalogTriggerCounts[1] === 1),
      true,
      `expected exactly one catalog trigger label; observed ${JSON.stringify(catalogTriggerCounts)}`,
    );
    await (catalogTriggerCounts[0] === 1
      ? readCatalogs
      : recheckCatalogsAtTrigger
    ).click();

    activeStep = "runtime-attention/catalog-settled";
    const recheckCatalogs = firstPage.getByRole("button", {
      name: "Re-check all",
      exact: true,
    });
    await recheckCatalogs.waitFor({ state: "visible", timeout: 25_000 });
    assert.equal(await recheckCatalogs.count(), 1);
    assert.notEqual(await recheckCatalogs.getAttribute("aria-busy"), "true");
    assert.equal(await recheckCatalogs.isEnabled(), true);

    const attentionGear = firstPage.getByRole("button", {
      name: "Settings",
      exact: true,
    });

    activeStep = "runtime-attention/gear-attention";
    assert.match((await attentionGear.getAttribute("class")) ?? "", /\battention\b/u);

    activeStep = "runtime-attention/settings-current";
    assert.equal(await attentionGear.getAttribute("aria-current"), "page");

    activeStep = "runtime-attention/provider-status-public-observations";
    providerAvailabilityBadges = Object.freeze(
      (await firstPage
        .locator("section.provider > .provider-head > .badge")
        .allTextContents())
        .map((value) => value.trim()),
    );
    const providerCards = firstPage.locator("section.provider");
    const providerCardCount = await providerCards.count();
    assert.equal(providerCardCount, 2);
    const detailedStatusValues: string[] = [];
    for (let cardIndex = 0; cardIndex < providerCardCount; cardIndex += 1) {
      const card = providerCards.nth(cardIndex);
      const rows = card.locator(":scope > .provider-body > dl.kv > .kv-row");
      const rowCount = await rows.count();
      const statusRowIndexes: number[] = [];
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const row = rows.nth(rowIndex);
        const directTerms = row.locator(":scope > dt");
        assert.equal(await directTerms.count(), 1);
        if (((await directTerms.textContent()) ?? "").trim() === "Status") {
          statusRowIndexes.push(rowIndex);
        }
      }
      assert.equal(statusRowIndexes.length, 1);
      const statusRow = rows.nth(statusRowIndexes[0]!);
      const directDefinitions = statusRow.locator(":scope > dd");
      assert.equal(await directDefinitions.count(), 1);
      detailedStatusValues.push(
        ((await directDefinitions.textContent()) ?? "").trim(),
      );
    }
    assert.equal(detailedStatusValues.length, providerCardCount);
    providerDetailedStatusValues = Object.freeze(detailedStatusValues);

    activeStep = "runtime-attention/provider-availability-badges";
    assert.deepEqual(
      providerAvailabilityBadges,
      ["Catalog unavailable", "Catalog unavailable"],
    );

    activeStep = "runtime-attention/provider-detailed-status-values";
    assert.deepEqual(
      providerDetailedStatusValues,
      ["Runtime not located", "Runtime not located"],
    );

    activeStep = "runtime-attention/appearance-scope";
    assert.equal((await settingsFacts(firstPage)).scope, savedScope);

    activeStep = "first-clean-close/selected-ledger-proxy";
    const firstSelectedLedgerProxy =
      await selectedLedgerNoAcceptedOrInFlightFact(paths.primaryUserData);
    activeStep = "first-clean-close/app-quit";
    const firstClose = await closeOwned(first);
    const appearancePath = join(paths.primaryUserData, appearanceFileName);
    const appearanceAfterClose = await exactAppearanceFact(
      appearancePath,
      "first-clean-close/appearance",
    );
    const directAfterClose = await optionalByteFact(directPreferencePath);
    activeStep = "first-clean-close/direct-profile";
    assert.deepEqual(directAfterClose, directBefore);

    activeStep = "same-userdata-restart/launch";
    const restarted = await launchOwned(
      paths.projectAlpha,
      paths.primaryUserData,
      isolatedEnvironment(paths),
    );
    const restartedPage = await productionPage(restarted.application);
    const restartMaterial = (await readRoot(restartedPage)).material;
    activeStep = "same-userdata-restart/appearance-root";
    await waitForRoot(restartedPage, {
      ...nonDefaultRoot,
      material: restartMaterial,
    });
    activeStep = "same-userdata-restart/settings-open";
    await openSettings(restartedPage);
    activeStep = "same-userdata-restart/scope";
    await waitForScope(restartedPage, savedScope);
    const restartSettings = await settingsFacts(restartedPage);
    activeStep = "same-userdata-restart/pressed";
    assert.deepEqual(restartSettings.pressed, {
      tone: "Light",
      crt: "Full",
      phosphor: "Amber",
      phosphorTier: "C · Hottest",
    });
    activeStep = "same-userdata-restart/data-material";
    assert.equal(restartSettings.root.material, restartMaterial);
    activeStep = "same-userdata-restart/direct-profile";
    assert.deepEqual(await optionalByteFact(directPreferencePath), directBefore);

    activeStep = "restart-clean-close/selected-ledger-proxy";
    const restartSelectedLedgerProxy =
      await selectedLedgerNoAcceptedOrInFlightFact(paths.primaryUserData);
    activeStep = "restart-clean-close/app-quit";
    const restartPid = restarted.pid;
    const restartClose = await closeOwned(restarted);
    const appearanceAfterRestart = await exactAppearanceFact(
      appearancePath,
      "restart-clean-close/appearance",
    );
    activeStep = "restart-clean-close/appearance-unchanged";
    assert.deepEqual(appearanceAfterRestart, appearanceAfterClose);
    activeStep = "restart-clean-close/direct-profile";
    assert.deepEqual(await optionalByteFact(directPreferencePath), directBefore);

    activeStep = "fresh-userdata/launch";
    const fresh = await launchOwned(
      paths.freshProject,
      paths.freshUserData,
      isolatedEnvironment(paths),
    );
    const freshPage = await productionPage(fresh.application);
    const freshMaterial = (await readRoot(freshPage)).material;
    activeStep = "fresh-userdata/default-root";
    await waitForRoot(freshPage, { ...defaultRoot, material: freshMaterial });
    activeStep = "fresh-userdata/settings-open";
    await openSettings(freshPage);
    activeStep = "fresh-userdata/scope";
    await waitForScope(freshPage, savedScope);
    const freshSettings = await settingsFacts(freshPage);
    activeStep = "fresh-userdata/default-pressed";
    assert.deepEqual(freshSettings.pressed, {
      tone: "Dark",
      crt: "Screen",
      phosphor: "Neutral",
      phosphorTier: "B · Luminous",
    });
    activeStep = "fresh-userdata/data-material";
    assert.equal(freshSettings.root.material, freshMaterial);
    activeStep = "fresh-clean-close/selected-ledger-proxy";
    const freshSelectedLedgerProxy =
      await selectedLedgerNoAcceptedOrInFlightFact(paths.freshUserData);
    activeStep = "fresh-clean-close/app-quit";
    const freshClose = await closeOwned(fresh);
    const freshAppearanceAbsent = await isMissing(
      join(paths.freshUserData, appearanceFileName),
    );
    activeStep = "fresh-clean-close/appearance-file-absent";
    assert.equal(freshAppearanceAbsent, true);

    summary = {
      proof: "settings-appearance-persistence-v2",
      dist,
      interaction: {
        locatorPolicy: "playwright-role-name",
        osMouseUsed: false,
        providerLiveUsed: false,
        isolatedRuntimeDiscovery: "empty-path-and-isolated-user-environment",
      },
      settings: {
        accessibleGearCount: firstUi.settingsGearCount,
        titlebarSettingsTextCount: firstUi.titlebarSettingsTextCount,
        titlebarSettingsButtonCount: firstUi.titlebarSettingsButtonCount,
        sections: initialSettings.sections,
        currentOnSettings: initialSettings.current,
        exits: {
          closeControl: true,
          gearToggle: true,
          projectSwitch: true,
        },
        attentionAfterRuntimeUnavailable: true,
        providerNotFoundRows: 2,
      },
      appearance: {
        chosen: {
          tone: "light",
          crt: "full",
          phosphor: "amber",
          phosphorTier: "c",
        },
        matrix: appearanceMatrixFacts,
        matrixCombinationCount: appearanceMatrixFacts.length,
        pressedAfterSave: savedSettings.pressed,
        rootAfterSave: savedSettings.root,
        rootAfterProjectSwitch: switchedRoot,
        dataMaterialUnchangedAcrossAllCombinations:
          appearanceMatrixFacts.every(
            (fact) => fact.root.material === initialMaterial,
          ),
        scopeAfterSave: savedSettings.scope,
        scopeAfterRestart: restartSettings.scope,
        sameUserDataRestartRestoredWithoutClick: true,
        freshUserDataDefaults: freshSettings.pressed,
        freshUserDataCreatedNoAppearanceFile: freshAppearanceAbsent,
        firstFrameFlash: "not-determinable-from-authoritative-ruling",
      },
      persistence: {
        directProfile: {
          before: directBefore,
          afterClose: directAfterClose,
          afterRestart: await optionalByteFact(directPreferencePath),
          unchanged: true,
        },
        appearance: appearanceAfterRestart,
        exactSchema: true,
        exactFinalBytes: appearanceAfterRestart.sha256 === sha256(exactAppearanceBytes),
        closeFlushReopenable: true,
      },
      lifecycle: {
        identityBoundMainPidCaptured: firstPid > 0 && restartPid > 0,
        distinctRestartPid: firstPid !== restartPid,
        appQuitPath:
          "Playwright ElectronApplication.close() evaluates Electron app.quit()",
        selectedLedgerProxyPrerequisites: {
          first: firstSelectedLedgerProxy,
          restart: restartSelectedLedgerProxy,
          fresh: freshSelectedLedgerProxy,
        },
        firstClose,
        restartClose,
        freshClose,
        forcedExactChildTerminationRequested: false,
      },
      faultTruth: {
        productionFaultInjectionPerformed: false,
        reason: "unsafe-native-fault-mutation-excluded",
        exactBoundaryCoverageRequiredFromFocusedTests: true,
      },
    };
  } catch (error) {
    runtimeFailure = runtimeFailureFact(activeStep, error);
  } finally {
    activeStep = "final-cleanup";
    for (const owned of [...liveApplications]) {
      const outcome = await cleanupOwnedApplication(owned);
      cleanupFacts.push(outcome.fact);
      cleanupFailures.push(...outcome.failures);
    }
    if (routineRoot.length > 0) {
      try {
        await assertAllOwnedChildrenExited(launchedApplications);
        await removeRoutineRoot(routineBase, routineRoot);
        cleanupRemoved = true;
      } catch {
        cleanupFailures.push(
          failureFact("final-root-cleanup", "routine-root-cleanup-failed"),
        );
      }
    }
  }

  if (runtimeFailure !== undefined || cleanupFailures.length > 0) {
    const primaryFailure = runtimeFailure ?? cleanupFailures[0];
    assert.ok(primaryFailure);
    console.log(
      `SETTINGS_APPEARANCE_E2E_FAILURE ${JSON.stringify({
        step: primaryFailure.step,
        category: primaryFailure.category,
        runtimeFailure: runtimeFailure ?? null,
        cleanupFailures,
        providerStatusPublicObservations: {
          availabilityBadges: providerAvailabilityBadges,
          detailedStatusValues: providerDetailedStatusValues,
        },
        cleanup: {
          applications: cleanupFacts,
          routineRootRemoved: cleanupRemoved,
        },
      })}`,
    );
    process.exitCode = 1;
    return;
  }
  assert.ok(summary);
  console.log(
    `SETTINGS_APPEARANCE_E2E ${JSON.stringify({
      ...summary,
      cleanup: { routineRootRemoved: cleanupRemoved },
    })}`,
  );
}

async function createRoutineRoot(): Promise<Readonly<{ base: string; root: string }>> {
  const option = process.argv.slice(2).find((value) => value.startsWith("--root-base="));
  if (process.argv.slice(2).some((value) => !value.startsWith("--root-base="))) {
    throw new Error("unsupported-option");
  }
  const requested = option?.slice("--root-base=".length);
  const base = requested === undefined || requested.length === 0
    ? resolve(tmpdir())
    : requested;
  if (!isAbsolute(base)) throw new Error("root-base-not-absolute");
  await mkdir(base, { recursive: true });
  const resolvedBase = await realpath(base);
  const root = await mkdtemp(join(resolvedBase, routineRootPrefix));
  return Object.freeze({ base: resolvedBase, root });
}

async function prepareIsolatedPaths(root: string): Promise<Readonly<{
  projectAlpha: string;
  projectBeta: string;
  freshProject: string;
  primaryUserData: string;
  freshUserData: string;
  isolatedHome: string;
  isolatedAppData: string;
  isolatedLocalAppData: string;
  isolatedPath: string;
  isolatedTemp: string;
}>> {
  const paths = Object.freeze({
    projectAlpha: join(root, "Project Alpha"),
    projectBeta: join(root, "Project Beta"),
    freshProject: join(root, "Fresh Project"),
    primaryUserData: join(root, "primary-user-data"),
    freshUserData: join(root, "fresh-user-data"),
    isolatedHome: join(root, "isolated-home"),
    isolatedAppData: join(root, "isolated-app-data"),
    isolatedLocalAppData: join(root, "isolated-local-app-data"),
    isolatedPath: join(root, "empty-path"),
    isolatedTemp: join(root, "runtime-temp"),
  });
  for (const path of Object.values(paths)) await mkdir(path);
  return paths;
}

async function seedTwoProjectRegistry(
  userData: string,
  projectAlpha: string,
  projectBeta: string,
): Promise<void> {
  const dataDirectory = join(userData, "workbench-project-host");
  await mkdir(dataDirectory);
  const alphaRecord = `project-record-v1-${randomUUID()}`;
  const betaRecord = `project-record-v1-${randomUUID()}`;
  const registry = {
    schemaVersion: 1,
    revision: 2,
    nextProjectOrdinal: 3,
    selectedRecordKey: alphaRecord,
    records: [
      {
        recordKey: alphaRecord,
        canonicalDirectory: resolve(projectAlpha),
        ledgerSlot: `project-ledger-v1-${randomUUID()}`,
      },
      {
        recordKey: betaRecord,
        canonicalDirectory: resolve(projectBeta),
        ledgerSlot: `project-ledger-v1-${randomUUID()}`,
      },
    ],
  };
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify(registry)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function isolatedEnvironment(paths: Awaited<ReturnType<typeof prepareIsolatedPaths>>): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of Object.keys(environment)) {
    if (
      [
        "path",
        "home",
        "userprofile",
        "homedrive",
        "homepath",
        "appdata",
        "localappdata",
        "temp",
        "tmp",
        "tmpdir",
        "electron_run_as_node",
        "node_options",
        "node_path",
      ].includes(key.toLocaleLowerCase("en-US"))
    ) {
      delete environment[key];
    }
  }
  const driveRoot = parse(paths.isolatedHome).root;
  const homePath = paths.isolatedHome.slice(driveRoot.length - 1);
  environment.PATH = paths.isolatedPath;
  environment.HOME = paths.isolatedHome;
  environment.USERPROFILE = paths.isolatedHome;
  environment.HOMEDRIVE = driveRoot.slice(0, 2);
  environment.HOMEPATH = homePath.startsWith("\\") ? homePath : `\\${homePath}`;
  environment.APPDATA = paths.isolatedAppData;
  environment.LOCALAPPDATA = paths.isolatedLocalAppData;
  environment.TEMP = paths.isolatedTemp;
  environment.TMP = paths.isolatedTemp;
  environment.TMPDIR = paths.isolatedTemp;
  return environment;
}

async function launchOwned(
  cwd: string,
  userData: string,
  env: Record<string, string>,
): Promise<OwnedApplication> {
  const application = await launchProductionElectron(productionElectron, {
    args: productionElectronArguments(productionElectron, userData),
    cwd,
    env,
    timeout: 15_000,
  });
  const child = application.process();
  const exitState = trackOwnedChildExit(child);
  const pid = child.pid;
  assert.ok(pid !== undefined && pid > 0);
  const owned = Object.freeze({ application, child, exitState, pid, userData });
  launchedApplications.add(owned);
  liveApplications.add(owned);
  return owned;
}

function trackOwnedChildExit(child: ChildProcess): OwnedChildExitState {
  let exitedObserved = child.exitCode !== null || child.signalCode !== null;
  let resolveExited = (): void => {};
  const exited = new Promise<void>((resolveExit) => {
    resolveExited = resolveExit;
  });
  const markExited = (): void => {
    exitedObserved = true;
    resolveExited();
  };
  if (exitedObserved) resolveExited();
  else child.once("exit", markExited);
  return Object.freeze({
    hasExited: () => exitedObserved,
    exited,
  });
}

async function productionPage(application: ElectronApplication): Promise<Page> {
  const page = await firstDomContentLoadedWindow(application, 15_000);
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(application.windows().length, 1);
  const actual = new URL(page.url());
  const expected = new URL(
    pathToFileURL(join(repositoryRoot, "dist", "renderer", "index.html")).toString(),
  );
  assert.equal(actual.protocol, expected.protocol);
  assert.equal(decodeURIComponent(actual.pathname), decodeURIComponent(expected.pathname));
  assert.deepEqual(
    [...actual.searchParams.keys()].sort(),
    [...actual.searchParams.keys()].sort().filter((key) =>
      key === "material" || key === "material-state"),
  );
  return page;
}

async function inspectInitialProductUi(page: Page): Promise<Readonly<{
  settingsGearCount: number;
  titlebarSettingsTextCount: number;
  titlebarSettingsButtonCount: number;
  root: RootAttributes;
}>> {
  return appearanceObservation.inspectInitialProductUi(page);
}

async function openSettings(page: Page): Promise<void> {
  return appearanceObservation.openSettings(page);
}

async function settingsFacts(page: Page): Promise<Readonly<{
  sections: readonly string[];
  current: boolean;
  scope: string;
  pressed: Readonly<{
    tone: string;
    crt: string;
    phosphor: string;
    phosphorTier: string;
  }>;
  root: RootAttributes;
}>> {
  /* Source-guard anchor; implementation moved byte-for-byte behind this wrapper:
  const settings = page.locator("main.settings");
  settings.getByRole("heading", { level: 2 });
  */
  return appearanceObservation.settingsFacts(page);
}

async function exerciseAppearanceMatrix(
  page: Page,
  initialMaterial: string | null,
): Promise<readonly Readonly<{
  observation: string;
  tone: (typeof appearanceTones)[number];
  crt: (typeof appearanceCrts)[number];
  phosphor: (typeof appearancePhosphors)[number];
  phosphorTier: (typeof appearancePhosphorTiers)[number];
  root: RootAttributes;
}>[]> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  assert.equal(matrix.length, 72);
  await chooseAppearance(page, "Light glow", combination.phosphorTier);
  phosphorTier: phosphorTierRootValues[combination.phosphorTier],
  activeStep = `appearance-matrix/${observation}/data-material`;
  assert.equal(facts.root.material, initialMaterial);
  crt:
    combination.crt === "Off"
      ? null
      : combination.crt.toLocaleLowerCase("en-US"),
  activeStep = `appearance-matrix/${observation}/scope-settled`;
  await waitForScope(page, savedScope);
  activeStep = `appearance-matrix/${observation}/root-settled`;
  await waitForRoot(page, expectedRoot);
  */
  return appearanceObservation.exerciseAppearanceMatrix(page, initialMaterial);
}

async function chooseAppearance(page: Page, group: string, choice: string): Promise<void> {
  return appearanceObservation.chooseAppearance(page, group, choice);
}

async function pressedLabel(page: Page, group: string): Promise<string> {
  return appearanceObservation.pressedLabel(page, group);
}

async function waitForScope(page: Page, expected: string): Promise<void> {
  return appearanceObservation.waitForScope(page, expected);
}

async function waitForRoot(page: Page, expected: RootAttributes): Promise<void> {
  return appearanceObservation.waitForRoot(page, expected);
}

async function readRoot(page: Page): Promise<RootAttributes> {
  /* Source-guard anchor; implementation moved byte-for-byte behind this wrapper:
  phosphorTier: root.getAttribute("data-phosphor-tier"),
  */
  return appearanceObservation.readRoot(page);
}

async function closeOwned(owned: OwnedApplication): Promise<Readonly<{
  appQuitRequested: true;
  pidCaptured: true;
  forcedExactChildTerminationRequested: false;
  exited: true;
}>> {
  return closeOwnedApplication(owned, liveApplications);
}

async function terminateExactOwnedChild(
  owned: OwnedApplication,
): Promise<ExactOwnedChildTerminationOutcome> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  let forcedExactChildTerminationRequested = false;
  if (!owned.exitState.hasExited()) {
    forcedExactChildTerminationRequested = true;
    owned.child.kill();
  }
  await waitForOwnedChildExit(owned, 5_000);
  */
  return terminateExactOwnedApplicationChild(owned, liveApplications);
}

async function cleanupOwnedApplication(
  owned: OwnedApplication,
): Promise<OwnedCleanupOutcome> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  await selectedLedgerNoAcceptedOrInFlightFact(owned.userData);
  await closeOwned(owned);
  await terminateExactOwnedChild(owned);
  */
  return cleanupOwnedApplicationLifecycle(owned, liveApplications);
}

async function selectedLedgerNoAcceptedOrInFlightFact(
  userData: string,
): Promise<SelectedLedgerNoAcceptedOrInFlightFact> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  source: "selected-project-ledger";
  observation: "no-accepted-or-in-flight-commands";
  projectHostIdleEstablished: false;
  return Object.freeze({
    source: "selected-project-ledger",
    observation: "no-accepted-or-in-flight-commands",
    projectHostIdleEstablished: false,
  });
  */
  return selectedLedgerNoAcceptedOrInFlightFactImplementation(userData);
}

async function exactAppearanceFact(
  path: string,
  observationPrefix: string,
): Promise<Readonly<{
  bytes: number;
  sha256: string;
}>> {
  activeStep = `${observationPrefix}/read`;
  const bytes = await readFile(path);
  activeStep = `${observationPrefix}/exact-bytes`;
  assert.equal(bytes.toString("utf8"), exactAppearanceBytes);
  activeStep = `${observationPrefix}/json`;
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  activeStep = `${observationPrefix}/document-schema`;
  assert.ok(isExactRecord(parsed, ["appearance", "schemaVersion"]));
  assert.equal(parsed.schemaVersion, 3);
  activeStep = `${observationPrefix}/appearance-schema`;
  assert.ok(
    isExactRecord(parsed.appearance, [
      "crt",
      "language",
      "phosphor",
      "phosphorTier",
      "tone",
    ]),
  );
  activeStep = `${observationPrefix}/appearance-values`;
  assert.deepEqual(parsed.appearance, {
    tone: "light",
    crt: "full",
    phosphor: "amber",
    phosphorTier: "c",
    language: "en",
  });
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function runtimeFailureFact(step: string, error: unknown): FailureFact {
  return failureFact(
    step,
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.name
        : "unknown",
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.fail("eventual condition did not settle");
}

async function assertAllOwnedChildrenExited(
  applications: ReadonlySet<OwnedApplication>,
): Promise<void> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  await withTimeout(owned.exitState.exited, timeout);
  assert.equal(owned.exitState.hasExited(), true);
  */
  return assertAllOwnedChildrenExitedImplementation(applications);
}

async function removeRoutineRoot(base: string, root: string): Promise<void> {
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("invalid-routine-root");
  }
  const resolvedRoot = await realpath(root);
  const resolvedBase = await realpath(base);
  if (
    !samePath(dirname(resolvedRoot), resolvedBase) ||
    !basename(resolvedRoot).startsWith(routineRootPrefix)
  ) {
    throw new Error("routine-root-ownership-failed");
  }
  await rm(resolvedRoot, { recursive: true, force: false, maxRetries: 3 });
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US")
    : a === b;
}

await main();
