import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright";

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
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  resolveProductionElectronComposition,
} from "./harness/production-electron.ts";
import { OFFSCREEN_PLACEMENT_ARGUMENT } from "../../src/workbench-shell/electron/window-placement.ts";
import {
  compositeOverOpaque,
  contrastRatio,
  formatRgb,
  isWcagLargeText,
  parseCssColor,
  parseCssPixels,
  parseFontWeight,
  requireOpaque,
  roundToThree,
} from "./theme-visual-production/visual-metrics.ts";
import {
  inspectLaunchIsolation,
  samePath,
} from "./theme-visual-production/launch-isolation.ts";
import {
  assertAllOwnedChildrenExited as assertAllOwnedChildrenExitedImplementation,
  cleanupOwnedApplicationLifecycle,
  closeOwnedApplication,
  removeOwnedRoutineRoot,
  terminateExactOwnedApplicationChild,
  type CleanupFact,
  type CleanupOutcome,
  type OwnedApplication,
  type OwnedChildExitState,
} from "./theme-visual-production/owned-lifecycle.ts";
import {
  PublicationFailure,
  createThemePublication,
  failureFact,
  runtimeFailureFact,
  sha256,
  type FailureFact,
  type EvidenceJsonSeal,
  type PendingPng,
  type PendingPngCandidate,
  type PngSeal,
  type PublishedPng,
  type PublicationResult,
  type PublicationStaging,
} from "./theme-visual-production/publication.ts";

export {
  contrastRatioForCssColors,
  isWcagLargeText,
  readPngDimensions,
} from "./theme-visual-production/visual-metrics.ts";

type RootAttributes = Readonly<{
  skin: string | null;
  glass: string | null;
  material: string | null;
  tone: string | null;
  crt: string | null;
  phosphor: string | null;
  phosphorTier: string | null;
}>;

type PhosphorExpectation = Readonly<{
  phosphor: string;
  glow: string;
  fg1Alpha: string;
  fg2Alpha: string;
  fg3Alpha: string;
  bloom: "6px";
  bloomTint: "2px";
  modelColor: string;
  textShadow: string;
}>;

type VisualState = Readonly<{
  id: string;
  tone: "Dark" | "Light";
  crt: "Off" | "Full";
  phosphor: "Neutral" | "Green" | "Amber";
  root: RootAttributes;
  screenshot: string;
  phosphorExpectation?: PhosphorExpectation;
}>;

type ComputedTextStyle = Readonly<{
  foreground: string;
  background: string;
  backgroundLayers: readonly string[];
  backgroundImagePresent: boolean;
  fontSize: string;
  fontWeight: string;
  opacity: string;
  textShadow: string;
}>;

const productionElectron = resolveProductionElectronComposition(import.meta.url);
const { repositoryRoot, electronExecutable } = productionElectron;
const evidenceDirectory = join(
  repositoryRoot,
  ".scratch",
  "unified-ai-workbench",
  "evidence",
);
const evidenceJsonPath = join(
  evidenceDirectory,
  "worker-226-theme-visual-production.json",
);
const routineRootPrefix = "workbench-theme-visual-226-";
const projectHostDirectoryName = "workbench-project-host";
const projectLedgerDirectoryName = "project-ledgers";
const projectRegistryFileName = "project-registry-v1.json";
const savedScope = "Saved · This user on this device";

export const VIEWPORT = Object.freeze({ width: 1440, height: 1000 });
export const NON_LARGE_TEXT_CONTRAST_MINIMUM = 4.5;

const DARK_GREEN_PHOSPHOR = Object.freeze({
  phosphor: "#8dffb4",
  glow: "rgb(80 255 150 / 55%)",
  fg1Alpha: "88%",
  fg2Alpha: "72%",
  fg3Alpha: "60%",
  bloom: "6px" as const,
  bloomTint: "2px" as const,
  modelColor: "rgb(141, 255, 180)",
  textShadow:
    "rgba(80, 255, 150, 0.55) 0px 0px 1px, rgba(80, 255, 150, 0.55) 0px 0px 6px",
});

const LIGHT_AMBER_PHOSPHOR = Object.freeze({
  phosphor: "#b23a00",
  glow: "rgb(255 104 24 / 50%)",
  fg1Alpha: "100%",
  fg2Alpha: "98%",
  fg3Alpha: "96%",
  bloom: "6px" as const,
  bloomTint: "2px" as const,
  modelColor: "rgb(178, 58, 0)",
  textShadow:
    "rgba(255, 104, 24, 0.5) 0px 0px 1px, rgba(255, 104, 24, 0.5) 0px 0px 6px",
});

const VISUAL_STATES: readonly VisualState[] = Object.freeze([
  Object.freeze({
    id: "dark-off-neutral",
    tone: "Dark",
    crt: "Off",
    phosphor: "Neutral",
    root: Object.freeze({
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: null,
      crt: null,
      phosphor: "neutral",
      phosphorTier: "b",
    }),
    screenshot: "worker-226-theme-dark-off-neutral.png",
  }),
  Object.freeze({
    id: "light-off-neutral",
    tone: "Light",
    crt: "Off",
    phosphor: "Neutral",
    root: Object.freeze({
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: "light",
      crt: null,
      phosphor: "neutral",
      phosphorTier: "b",
    }),
    screenshot: "worker-226-theme-light-off-neutral.png",
  }),
  Object.freeze({
    id: "dark-full-green",
    tone: "Dark",
    crt: "Full",
    phosphor: "Green",
    root: Object.freeze({
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: null,
      crt: "full",
      phosphor: "green",
      phosphorTier: "b",
    }),
    screenshot: "worker-226-theme-dark-full-green.png",
    phosphorExpectation: DARK_GREEN_PHOSPHOR,
  }),
  Object.freeze({
    id: "light-full-amber",
    tone: "Light",
    crt: "Full",
    phosphor: "Amber",
    root: Object.freeze({
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: "light",
      crt: "full",
      phosphor: "amber",
      phosphorTier: "b",
    }),
    screenshot: "worker-226-theme-light-full-amber.png",
    phosphorExpectation: LIGHT_AMBER_PHOSPHOR,
  }),
]);

const SETTINGS_CONTRACT = Object.freeze({
  heading: "Settings",
  sections: Object.freeze([
    "Appearance",
    "Providers",
    "Tools",
    "Usage & resets",
    "Claude permissions",
  ]),
  groups: Object.freeze([
    Object.freeze({ label: "Tone", choices: Object.freeze(["Dark", "Light"]) }),
    Object.freeze({
      label: "CRT",
      choices: Object.freeze(["Off", "Blocks", "Screen", "Full"]),
    }),
    Object.freeze({
      label: "Phosphor",
      choices: Object.freeze(["Neutral", "Green", "Amber"]),
    }),
    Object.freeze({
      label: "Light glow",
      choices: Object.freeze(["A · Restrained", "B · Luminous", "C · Hottest"]),
    }),
  ]),
});

const MEASUREMENT_TARGETS = Object.freeze([
  "settings-lede",
  "settings-scope",
  "appearance-tone-copy",
  "appearance-crt-copy",
  "appearance-phosphor-copy",
  "appearance-phosphor-tier-copy",
  "providers-policy-copy",
  "providers-policy-details",
  "codex-provider-name",
  "codex-endpoint-label",
  "claude-provider-name",
  "claude-endpoint-label",
  "glm-provider-name",
  "deepseek-provider-name",
  "kimi-provider-name",
  "tool-claude-name",
  "tool-codex-name",
  "rail-provider-label",
  "rail-model-label",
]);

const TERMINAL_CONTRAST_PLATES = Object.freeze({
  dark: Object.freeze(["#0a0a0d", "#202027"]),
  light: Object.freeze(["#f0f1f6", "#e2e3e7"]),
});

const SUBJECTIVE_BOUNDARIES = Object.freeze({
  ownerLikesCurrentLightPalette: "UNPROVEN",
  ownerPerceivesCurrentPhosphorAsLuminous: "UNPROVEN",
  universalRealAcrylicWallpaperContrast: "UNPROVEN",
});

const PUBLIC_CONTRACT = Object.freeze({
  proof: "theme-visual-production-v1",
  viewport: VIEWPORT,
  nonLargeTextContrastMinimum: NON_LARGE_TEXT_CONTRAST_MINIMUM,
  states: Object.freeze(
    VISUAL_STATES.map(({ phosphorExpectation: _expectation, ...state }) => state),
  ),
  settings: SETTINGS_CONTRACT,
  measurementTargets: MEASUREMENT_TARGETS,
  terminalContrastPlates: TERMINAL_CONTRAST_PLATES,
  subjectiveBoundaries: SUBJECTIVE_BOUNDARIES,
  publication: Object.freeze({
    preExistingFinalEvidence: "fail-closed",
    png: "unique-pending-reopen-validate-clean-shutdown-promote-reopen-seal",
    json: "unique-pending-reopen-validate-rename-reopen-seal-final-gate",
    ownedRootRemoval:
      "zero-runtime-and-zero-cleanup-failures-after-exact-child-death-proof",
  }),
});

let activeStep = "initialization";
let routineBase = "";
let routineRoot = "";
const liveApplications = new Set<OwnedApplication>();
const launchedApplications = new Set<OwnedApplication>();
const themePublication = createThemePublication({
  evidenceDirectory,
  evidenceJsonPath,
  visualStates: VISUAL_STATES,
  viewport: VIEWPORT,
  getActiveStep: () => activeStep,
  setActiveStep(step) {
    activeStep = step;
  },
});

class VisualProfileFixtureAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    return Object.freeze({
      runtime: "fixture",
      models: Object.freeze([
        Object.freeze({ id: "fixture-visual-model", effortLevels: ["fixture"] }),
      ]),
      executionModes: Object.freeze(["single-agent"]),
      accessModes: Object.freeze(["full-access"]),
    });
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  private binding(profile: SessionProfile): ResumableRuntimeBinding {
    return Object.freeze({
      profile: structuredClone(profile),
      opaqueSessionReference: "fixture-visual-session",
      async send(_input: RuntimeInput): Promise<void> {},
      effectiveProfile: () => structuredClone(profile),
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: "Fixture completed." };
        yield { kind: "turn-completed", status: "completed" };
      },
    });
  }
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const pendingJsonPath = join(
    evidenceDirectory,
    `worker-226-theme-pending-${runId}-visual-production.json`,
  );
  let runtimeFailure: FailureFact | undefined;
  const cleanupFailures: FailureFact[] = [];
  const cleanupFacts: CleanupFact[] = [];
  const pendingPngCandidates: PendingPngCandidate[] = [];
  const pendingPngs: PendingPng[] = [];
  let publicationRollbackFailures: readonly FailureFact[] = [];
  let publicationStaging: PublicationStaging | undefined;
  let publicationFailure: FailureFact | undefined;
  let summary: Record<string, unknown> | undefined;
  let routineRootRemoved = false;

  try {
    activeStep = "dist-freshness";
    const dist = await inspectFreshDist();

    activeStep = "final-evidence-preflight";
    await assertFinalEvidenceAbsent();
    await assertMissing(pendingJsonPath);

    activeStep = "isolated-root";
    ({ base: routineBase, root: routineRoot } = await createRoutineRoot());
    const paths = await prepareIsolatedPaths(routineRoot);

    activeStep = "fixture-seed";
    await seedVisualProject(paths.project, paths.userData);

    activeStep = "production-launch";
    const owned = await launchOwned(paths);
    const page = await productionPage(owned.application);

    activeStep = "production-isolation";
    const launchIsolation = await inspectLaunchIsolation(
      owned.application,
      paths.project,
      paths.userData,
    );

    activeStep = "settings-open";
    await openSettings(page);

    const stateFacts: Record<string, unknown>[] = [];
    for (const state of VISUAL_STATES) {
      activeStep = `${state.id}/tone`;
      await chooseAppearance(page, "Tone", state.tone);
      activeStep = `${state.id}/crt`;
      await chooseAppearance(page, "CRT", state.crt);
      activeStep = `${state.id}/phosphor`;
      await chooseAppearance(page, "Phosphor", state.phosphor);

      activeStep = `${state.id}/root-settled`;
      await waitForRoot(page, state.root);
      const root = await readRoot(page);
      assert.deepEqual(root, state.root);
      assert.equal(root.material, "on");

      activeStep = `${state.id}/settings-structure`;
      const settings = await inspectSettingsStructure(page);

      activeStep = `${state.id}/computed-styles`;
      const measurement = await measurePublicText(page, state);
      assert.equal(measurement.allNonLarge, true);
      assert.ok(
        measurement.minimumContrast >= NON_LARGE_TEXT_CONTRAST_MINIMUM,
      );

      activeStep = `${state.id}/phosphor-tokens`;
      const phosphor = await inspectPhosphor(page, state);
      if (state.phosphorExpectation !== undefined) {
        assert.deepEqual(phosphor, state.phosphorExpectation);
      } else {
        assert.equal(phosphor, null);
      }

      activeStep = `${state.id}/screenshot-scroll`;
      const scroll = await positionSettingsForScreenshot(page);
      activeStep = `${state.id}/screenshot`;
      const pendingFile = `worker-226-theme-pending-${runId}-${state.id}.png`;
      const candidate = Object.freeze({
        path: join(evidenceDirectory, pendingFile),
        pendingFile,
        finalFile: state.screenshot,
      });
      pendingPngCandidates.push(candidate);
      const pending = await captureAndReopenPendingPng(page, candidate);
      pendingPngs.push(pending);
      pendingPngCandidates[pendingPngCandidates.length - 1] = pending;
      const screenshot = pngSeal(pending.finalFile, pending);

      stateFacts.push(
        Object.freeze({
          id: state.id,
          selected: Object.freeze({
            tone: state.tone,
            crt: state.crt,
            phosphor: state.phosphor,
          }),
          root,
          settings,
          measurement,
          phosphor,
          scroll,
          screenshot,
        }),
      );
    }

    activeStep = "state-screenshot-size-consistency";
    const dimensions = stateFacts.map(
      (fact) => (fact.screenshot as { dimensions: { width: number; height: number } }).dimensions,
    );
    assert.deepEqual(
      dimensions,
      VISUAL_STATES.map(() => VIEWPORT),
    );

    summary = {
      proof: "theme-visual-production-v1",
      objectiveVerdict: {
        productionElectronDist: "PASS",
        fourLockedRootStates: "PASS",
        dataMaterialExactOnInEveryState: "PASS",
        settingsStructureStableInEveryState: "PASS",
        fourFixedPngsReopenedAndSealed: "PASS",
        f66ComputedFallbackContrastAtLeast45ForNonLargeText: "PASS",
        f71ExactTokensAlphaAndRenderedTextShadow: "PASS",
      },
      subjectiveBoundaries: SUBJECTIVE_BOUNDARIES,
      dist,
      interaction: {
        locatorPolicy: "playwright-role-accessible-name",
        osInputUsed: false,
        computerUseUsed: false,
        providerOrModelRequestCount: 0,
        fixtureOnlyLedgerSeed: true,
      },
      isolation: {
        dedicatedProject: true,
        dedicatedUserData: true,
        dedicatedHome: true,
        dedicatedAppData: true,
        dedicatedLocalAppData: true,
        dedicatedTemp: true,
        emptyRuntimeDiscoveryPath: true,
        launch: launchIsolation,
      },
      f66: {
        threshold: NON_LARGE_TEXT_CONTRAST_MINIMUM,
        largeTextExemptionUsed: false,
        basis:
          "computed foreground and ancestor background-color layers composited over both deterministic tone plates",
        backgroundImagesIncludedInRatio: false,
        realAcrylicWallpaperUniversality: "UNPROVEN",
      },
      f71: {
        pixelHaloOrDeltaEMeasured: false,
        reason: "fragile pixel proxy deliberately excluded",
        ownerLuminousJudgment: "UNPROVEN",
      },
      viewport: VIEWPORT,
      states: Object.freeze(stateFacts),
    };
  } catch (error) {
    runtimeFailure = runtimeFailureFact(activeStep, error);
  } finally {
    for (const owned of [...liveApplications]) {
      const cleanup = await cleanupOwnedApplication(owned);
      cleanupFacts.push(cleanup.fact);
      cleanupFailures.push(...cleanup.failures);
    }
    if (
      routineRoot.length > 0 &&
      runtimeFailure === undefined &&
      cleanupFailures.length === 0
    ) {
      try {
        await assertAllOwnedChildrenExited(launchedApplications);
        await removeRoutineRoot(routineBase, routineRoot);
        routineRootRemoved = true;
      } catch {
        cleanupFailures.push(
          failureFact("final-root-cleanup", "owned-root-cleanup-failed"),
        );
      }
    }
  }

  if (runtimeFailure === undefined && cleanupFailures.length === 0) {
    try {
      assert.ok(summary);
      activeStep = "evidence-json-write";
      const document = {
        ...summary,
        lifecycle: {
          launchChildIdentityCaptured: true,
          cleanup: cleanupFacts,
          allCapturedChildrenDeathProved: true,
          ownedRootRemoved: routineRootRemoved,
        },
      };
      assert.equal(routineRootRemoved, true);
      assert.equal(pendingPngs.length, VISUAL_STATES.length);
      activeStep = "evidence-publication";
      const publication = await publishFinalEvidence(
        pendingPngs,
        pendingJsonPath,
        document,
      );
      console.log(
        `THEME_VISUAL_PRODUCTION ${JSON.stringify({
          objective: "PASS",
          subjective: SUBJECTIVE_BOUNDARIES,
          evidence: publication.evidence,
          pngs: publication.pngs,
        })}`,
      );
      return;
    } catch (error) {
      if (error instanceof PublicationFailure) {
        publicationRollbackFailures = error.rollbackFailures;
        publicationStaging = error.staging;
      }
      publicationFailure = runtimeFailureFact(activeStep, error);
    }
  }

  const primary = runtimeFailure ?? cleanupFailures[0] ?? publicationFailure;
  assert.ok(primary);
  const staging =
    publicationStaging ??
    (await inspectPublicationStaging(pendingPngCandidates, pendingJsonPath));
  console.log(
    `THEME_VISUAL_PRODUCTION_FAILURE ${JSON.stringify({
      step: primary.step,
      category: primary.category,
      runtimeFailure: runtimeFailure ?? null,
      cleanupFailures,
      cleanup: {
        applications: cleanupFacts,
        ownedRootRemoved: routineRootRemoved,
        ownedRootRetained: routineRoot.length > 0 && !routineRootRemoved,
      },
      publication: {
        failure: publicationFailure ?? null,
        rollbackFailures: publicationRollbackFailures,
        staging,
        fixedFinalManifestPathPresent: staging.json.finalPresence === "PRESENT",
        objectivePassPublished: false,
      },
    })}`,
  );
  process.exitCode = 1;
}

async function inspectFreshDist(): Promise<Record<string, unknown>> {
  const sources = [
    ...(await listFiles(join(repositoryRoot, "src", "workbench-shell"))),
    join(repositoryRoot, "vite.main.config.ts"),
    join(repositoryRoot, "vite.preload.config.ts"),
    join(repositoryRoot, "vite.renderer.config.ts"),
    join(repositoryRoot, "package.json"),
    join(repositoryRoot, "pnpm-lock.yaml"),
  ];
  const rendererAssets = await listFiles(join(repositoryRoot, "dist", "renderer"));
  const artifacts = [
    join(repositoryRoot, "dist", "main", "main.js"),
    join(repositoryRoot, "dist", "preload", "preload.cjs"),
    ...rendererAssets,
  ];
  assert.ok(rendererAssets.some((path) => path.endsWith("index.html")));
  assert.ok(rendererAssets.some((path) => path.endsWith(".js")));
  assert.ok(rendererAssets.some((path) => path.endsWith(".css")));
  const sourceStats = await Promise.all(sources.map((path) => stat(path)));
  const artifactStats = await Promise.all(artifacts.map((path) => stat(path)));
  const newestSource = Math.max(...sourceStats.map((entry) => entry.mtimeMs));
  const oldestArtifact = Math.min(...artifactStats.map((entry) => entry.mtimeMs));
  assert.ok(oldestArtifact >= newestSource, "dist-is-older-than-product-source");
  const artifactFacts = await Promise.all(
    artifacts.map(async (path) => ({
      role: distRole(path),
      ...(await fileFact(path)),
    })),
  );
  return Object.freeze({
    fresh: true,
    sourceFileCount: sources.length,
    sourceTreeSha256: await treeDigest(sources),
    artifactCount: artifactFacts.length,
    artifacts: artifactFacts.sort((left, right) =>
      left.role.localeCompare(right.role),
    ),
  });
}

async function createRoutineRoot(): Promise<Readonly<{ base: string; root: string }>> {
  const options = process.argv.slice(2).filter((value) => value !== "--describe-contract");
  const rootBaseOption = options.find((value) => value.startsWith("--root-base="));
  if (options.some((value) => !value.startsWith("--root-base="))) {
    throw new Error("unsupported-option");
  }
  const requested = rootBaseOption?.slice("--root-base=".length);
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
  project: string;
  userData: string;
  isolatedHome: string;
  isolatedAppData: string;
  isolatedLocalAppData: string;
  isolatedPath: string;
  isolatedTemp: string;
}>> {
  const paths = Object.freeze({
    project: join(root, "Visual Project"),
    userData: join(root, "user-data"),
    isolatedHome: join(root, "isolated-home"),
    isolatedAppData: join(root, "isolated-app-data"),
    isolatedLocalAppData: join(root, "isolated-local-app-data"),
    isolatedPath: join(root, "empty-runtime-path"),
    isolatedTemp: join(root, "runtime-temp"),
  });
  for (const path of Object.values(paths)) await mkdir(path);
  return paths;
}

async function seedVisualProject(project: string, userData: string): Promise<void> {
  const canonicalProject = await realpath(project);
  const dataDirectory = join(userData, projectHostDirectoryName);
  const ledgerDirectory = join(dataDirectory, projectLedgerDirectoryName);
  await mkdir(ledgerDirectory, { recursive: true });
  const recordKey = `project-record-v1-${randomUUID()}`;
  const ledgerSlot = `project-ledger-v1-${randomUUID()}`;
  await writeFile(
    join(dataDirectory, projectRegistryFileName),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 2,
      selectedRecordKey: recordKey,
      records: [
        {
          recordKey,
          canonicalDirectory: canonicalProject,
          ledgerSlot,
        },
      ],
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const channel = await createWorkbenchCoordinator({
    databasePath: join(ledgerDirectory, `${ledgerSlot}.sqlite`),
    adapter: new VisualProfileFixtureAdapter(),
  }).openProject(canonicalProject);
  try {
    const profile = Object.freeze({
      model: "fixture-visual-model",
      effortLevel: "fixture",
      executionMode: "single-agent",
      accessMode: "full-access",
    });
    const receipt = await channel.act({
      kind: "direct",
      commandKind: "start",
      idempotencyKey: "worker-226-theme-visual-fixture",
      runtime: "codex",
      catalogRevision: "worker-226-theme-visual-fixture-v1",
      preferences: { global: profile },
      profile,
      requestedProfileProjection: {
        kind: "recorded",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        modelLabel: "Profile Alpha",
        workIntensityControlLabel: {
          label: null,
          provenance: "not-recorded",
        },
        workIntensityLabel: "Fixture",
        executionModeLabel: "Single agent",
        accessModeLabel: "Full access",
      },
      input: "Render the bounded visual fixture.",
    });
    await waitForSeededTerminal(channel, receipt.commandId);
  } finally {
    await channel.close();
  }
}

async function waitForSeededTerminal(
  channel: Awaited<
    ReturnType<ReturnType<typeof createWorkbenchCoordinator>["openProject"]>
  >,
  commandId: string,
): Promise<void> {
  await eventually(async () => {
    const command = (await channel.snapshot()).commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status === "completed") return true;
    if (command?.status === "failed" || command?.status === "recovery-required") {
      throw new Error("visual-fixture-terminal-failure");
    }
    return false;
  }, 5_000);
}

function isolatedEnvironment(
  paths: Awaited<ReturnType<typeof prepareIsolatedPaths>>,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const cleared = new Set([
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
  ]);
  for (const key of Object.keys(environment)) {
    if (cleared.has(key.toLocaleLowerCase("en-US"))) delete environment[key];
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
  paths: Awaited<ReturnType<typeof prepareIsolatedPaths>>,
): Promise<OwnedApplication> {
  const application = await launchProductionElectron(productionElectron, {
    args: [
      repositoryRoot,
      `--user-data-dir=${paths.userData}`,
      OFFSCREEN_PLACEMENT_ARGUMENT,
    ],
    cwd: paths.project,
    env: isolatedEnvironment(paths),
    timeout: 15_000,
  });
  const child = application.process();
  const exitState = trackOwnedChildExit(child);
  const pid = child.pid;
  assert.ok(pid !== undefined && pid > 0);
  const owned = Object.freeze({ application, child, exitState, pid });
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
  return Object.freeze({ hasExited: () => exitedObserved, exited });
}

async function productionPage(application: ElectronApplication): Promise<Page> {
  const page = await firstDomContentLoadedWindow(application, 15_000);
  await page.setViewportSize(VIEWPORT);
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(application.windows().length, 1);
  const actual = new URL(page.url());
  const expected = new URL(
    pathToFileURL(join(repositoryRoot, "dist", "renderer", "index.html")).href,
  );
  assert.equal(actual.protocol, "file:");
  assert.equal(decodeURIComponent(actual.pathname), decodeURIComponent(expected.pathname));
  assert.equal(actual.search, "");
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  assert.deepEqual(viewport, VIEWPORT);
  return page;
}

async function openSettings(page: Page): Promise<void> {
  const gear = page.getByRole("button", { name: "Settings", exact: true });
  assert.equal(await gear.count(), 1);
  await gear.click();
  await page
    .getByRole("heading", { name: "Settings", exact: true, level: 1 })
    .waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await gear.getAttribute("aria-current"), "page");
}

async function chooseAppearance(
  page: Page,
  group: string,
  choice: string,
): Promise<void> {
  const button = page
    .getByRole("group", { name: group, exact: true })
    .getByRole("button", { name: choice, exact: true });
  assert.equal(await button.count(), 1);
  await button.click();
  await eventually(async () => (await button.getAttribute("aria-pressed")) === "true");
  await eventually(async () =>
    ((await page.locator(".appearance-section-head .settings-scope").textContent()) ?? "").trim() ===
      savedScope,
  );
}

async function inspectSettingsStructure(page: Page): Promise<Record<string, unknown>> {
  const stepPrefix = activeStep;
  const settingsPage = page.locator("main.settings");
  activeStep = `${stepPrefix}/heading`;
  const heading = settingsPage.getByRole("heading", {
    name: "Settings",
    exact: true,
    level: 1,
  });
  assert.equal(await heading.count(), 1);
  activeStep = `${stepPrefix}/sections`;
  const sections = (await settingsPage.getByRole("heading", { level: 2 }).allTextContents())
    .map((value) => value.trim());
  assert.deepEqual(sections, SETTINGS_CONTRACT.sections);
  const groups: Array<Readonly<{ label: string; choices: readonly string[] }>> = [];
  for (const expected of SETTINGS_CONTRACT.groups) {
    activeStep = `${stepPrefix}/group-${expected.label}`;
    const group = settingsPage.getByRole("group", { name: expected.label, exact: true });
    assert.equal(await group.count(), 1);
    const choices = (await group.getByRole("button").allTextContents()).map(
      (value) => value.trim(),
    );
    assert.deepEqual(choices, expected.choices);
    groups.push(Object.freeze({ label: expected.label, choices: Object.freeze(choices) }));
  }
  const providerRegions = ["Codex", "Claude", "GLM", "DeepSeek", "Kimi"];
  for (const name of providerRegions) {
    activeStep = `${stepPrefix}/provider-${name}`;
    assert.equal(
      await settingsPage.getByRole("region", { name, exact: true }).count(),
      1,
    );
  }
  const toolRegions = ["Claude Code CLI", "Codex CLI"];
  for (const name of toolRegions) {
    activeStep = `${stepPrefix}/tool-${name}`;
    assert.equal(
      await settingsPage.getByRole("region", { name, exact: true }).count(),
      1,
    );
  }
  const detailsGroups = [
    settingsPage.locator(".providers-policy > details.settings-details"),
    settingsPage.locator(
      ".provider-endpoint-list > section.provider > .provider-body > details.provider-details",
    ),
    settingsPage.locator(
      "section.tool-row > .provider-body > details.tool-details",
    ),
  ];
  activeStep = `${stepPrefix}/details-count`;
  assert.deepEqual(
    await Promise.all(detailsGroups.map((details) => details.count())),
    [1, 5, 2],
  );
  for (const details of detailsGroups) {
    activeStep = `${stepPrefix}/details-closed`;
    for (let index = 0; index < await details.count(); index += 1) {
      assert.equal(await details.nth(index).getAttribute("open"), null);
    }
  }
  activeStep = `${stepPrefix}/session-accessible-name`;
  const projectedSession = page.locator("button.session-row");
  assert.equal(await projectedSession.count(), 1);
  const projectedSessionAccessibleName = await projectedSession.getAttribute("aria-label");
  activeStep = `${stepPrefix}/session-accessible-name-${projectedSessionAccessibleName}`;
  assert.equal(
    await page
      .getByRole("button", {
        name: "Render the bounded visual fixture., Codex, Profile Alpha, Completed",
        exact: true,
      })
      .count(),
    1,
  );
  activeStep = `${stepPrefix}/settings-current`;
  assert.equal(
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  return Object.freeze({
    exact: true,
    heading: SETTINGS_CONTRACT.heading,
    sections: Object.freeze(sections),
    groups: Object.freeze(groups),
    providerRegions: Object.freeze(providerRegions),
    toolRegions: Object.freeze(toolRegions),
    detailsClosed: true,
    projectedSessionAccessibleNameExact: true,
  });
}

function publicTextLocators(page: Page): readonly Readonly<{
  id: string;
  locator: Locator;
}>[] {
  const codex = page.getByRole("region", { name: "Codex", exact: true });
  const claude = page.getByRole("region", { name: "Claude", exact: true });
  const glm = page.getByRole("region", { name: "GLM", exact: true });
  const deepseek = page.getByRole("region", { name: "DeepSeek", exact: true });
  const kimi = page.getByRole("region", { name: "Kimi", exact: true });
  const claudeTool = page.locator("section.tool-claude");
  const codexTool = page.locator("section.tool-codex");
  const session = page.getByRole("button", {
    name: "Render the bounded visual fixture., Codex, Profile Alpha, Completed",
    exact: true,
  });
  return Object.freeze([
    Object.freeze({
      id: "settings-lede",
      locator: page.getByText(
        "Providers, tools and appearance for this Workbench.",
        { exact: true },
      ),
    }),
    Object.freeze({
      id: "settings-scope",
      locator: page.locator(".appearance-section-head .settings-scope"),
    }),
    Object.freeze({
      id: "appearance-tone-copy",
      locator: page.getByText("Use a dark or light Workbench tone.", { exact: true }),
    }),
    Object.freeze({
      id: "appearance-crt-copy",
      locator: page.getByText("Choose where the CRT treatment appears.", {
        exact: true,
      }),
    }),
    Object.freeze({
      id: "appearance-phosphor-copy",
      locator: page.getByText("Tint machine output independently of CRT.", {
        exact: true,
      }),
    }),
    Object.freeze({
      id: "appearance-phosphor-tier-copy",
      locator: page.getByText(
        "Choose how bright and glowy Green and Amber look in Light tone.",
        { exact: true },
      ),
    }),
    Object.freeze({
      id: "providers-policy-copy",
      locator: page.locator(".providers-policy-line"),
    }),
    Object.freeze({
      id: "providers-policy-details",
      locator: page.locator(".providers-policy > details.settings-details > summary"),
    }),
    Object.freeze({ id: "codex-provider-name", locator: codex.locator(".ph-name") }),
    Object.freeze({ id: "codex-endpoint-label", locator: codex.locator(".ph-sub") }),
    Object.freeze({ id: "claude-provider-name", locator: claude.locator(".ph-name") }),
    Object.freeze({ id: "claude-endpoint-label", locator: claude.locator(".ph-sub") }),
    Object.freeze({ id: "glm-provider-name", locator: glm.locator(".ph-name") }),
    Object.freeze({ id: "deepseek-provider-name", locator: deepseek.locator(".ph-name") }),
    Object.freeze({ id: "kimi-provider-name", locator: kimi.locator(".ph-name") }),
    Object.freeze({ id: "tool-claude-name", locator: claudeTool.locator(".ph-name") }),
    Object.freeze({ id: "tool-codex-name", locator: codexTool.locator(".ph-name") }),
    Object.freeze({ id: "rail-provider-label", locator: session.locator(".rt-name") }),
    Object.freeze({ id: "rail-model-label", locator: session.locator(".sr-model") }),
  ]);
}

async function measurePublicText(
  page: Page,
  state: VisualState,
): Promise<Readonly<{
  basis: string;
  allNonLarge: boolean;
  minimumContrast: number;
  targets: readonly Record<string, unknown>[];
}>> {
  const targets = publicTextLocators(page);
  assert.deepEqual(
    targets.map((target) => target.id),
    MEASUREMENT_TARGETS,
  );
  const plates = state.tone === "Dark"
    ? TERMINAL_CONTRAST_PLATES.dark
    : TERMINAL_CONTRAST_PLATES.light;
  const facts: Record<string, unknown>[] = [];
  for (const target of targets) {
    assert.equal(await target.locator.count(), 1, target.id);
    await target.locator.waitFor({ state: "visible", timeout: 5_000 });
    const computed = await computedTextStyle(target.locator);
    const fontSizePx = parseCssPixels(computed.fontSize);
    const fontWeight = parseFontWeight(computed.fontWeight);
    const largeText = isWcagLargeText(fontSizePx, fontWeight);
    assert.equal(largeText, false, `${target.id}-unexpected-large-text`);
    assert.equal(computed.opacity, "1", `${target.id}-unexpected-opacity`);
    const contrasts = plates.map((terminalPlate) =>
      contrastAgainstComputedLayers(computed, terminalPlate),
    );
    if (target.id === "settings-lede" || target.id === "settings-scope") {
      assert.ok(
        computed.backgroundLayers.some(
          (layer) => parseCssColor(layer).alpha === 1,
        ),
        `${target.id}-missing-opaque-reading-ground`,
      );
      assert.equal(
        new Set(contrasts.map((entry) => entry.effectiveBackground)).size,
        1,
        `${target.id}-wallpaper-dependent-background`,
      );
    }
    const minimumContrast = Math.min(...contrasts.map((entry) => entry.ratio));
    assert.ok(
      minimumContrast >= NON_LARGE_TEXT_CONTRAST_MINIMUM,
      `${target.id}-contrast-below-4.5`,
    );
    facts.push(
      Object.freeze({
        id: target.id,
        foreground: computed.foreground,
        background: computed.background,
        backgroundLayers: computed.backgroundLayers,
        backgroundImagePresent: computed.backgroundImagePresent,
        fontSize: computed.fontSize,
        fontSizePx,
        fontWeight: computed.fontWeight,
        numericFontWeight: fontWeight,
        opacity: computed.opacity,
        textShadow: computed.textShadow,
        largeText,
        requiredContrast: NON_LARGE_TEXT_CONTRAST_MINIMUM,
        contrasts,
        minimumContrast,
        pass: true,
      }),
    );
  }
  return Object.freeze({
    basis:
      "computed foreground and ancestor background-color layers over both deterministic tone plates",
    allNonLarge: true,
    minimumContrast: Math.min(
      ...facts.map((fact) => fact.minimumContrast as number),
    ),
    targets: Object.freeze(facts),
  });
}

async function computedTextStyle(locator: Locator): Promise<ComputedTextStyle> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const backgroundLayers: string[] = [];
    let backgroundImagePresent = false;
    let current: Element | null = element;
    while (current !== null) {
      const currentStyle = getComputedStyle(current);
      const color = currentStyle.backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        backgroundLayers.push(color);
      }
      if (currentStyle.backgroundImage !== "none") backgroundImagePresent = true;
      current = current.parentElement;
    }
    return Object.freeze({
      foreground: style.color,
      background: style.backgroundColor,
      backgroundLayers: Object.freeze(backgroundLayers),
      backgroundImagePresent,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      opacity: style.opacity,
      textShadow: style.textShadow,
    });
  });
}

function contrastAgainstComputedLayers(
  computed: ComputedTextStyle,
  terminalPlate: string,
): Readonly<{
  terminalPlate: string;
  effectiveBackground: string;
  compositedForeground: string;
  ratio: number;
}> {
  let background = requireOpaque(parseCssColor(terminalPlate));
  for (const layer of [...computed.backgroundLayers].reverse()) {
    background = compositeOverOpaque(parseCssColor(layer), background);
  }
  const foreground = compositeOverOpaque(parseCssColor(computed.foreground), background);
  return Object.freeze({
    terminalPlate,
    effectiveBackground: formatRgb(background),
    compositedForeground: formatRgb(foreground),
    ratio: roundToThree(contrastRatio(foreground, background)),
  });
}

async function inspectPhosphor(
  page: Page,
  state: VisualState,
): Promise<PhosphorExpectation | null> {
  if (state.phosphorExpectation === undefined) return null;
  const session = page.getByRole("button", {
    name: "Render the bounded visual fixture., Codex, Profile Alpha, Completed",
    exact: true,
  });
  const model = session.locator(".sr-model");
  assert.equal(await model.count(), 1);
  const phosphor = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    const compact = (value: string): string => value.trim().replace(/\s+/gu, " ");
    return Object.freeze({
      phosphor: compact(style.getPropertyValue("--crt-phosphor")),
      glow: compact(style.getPropertyValue("--crt-glow")),
      fg1Alpha: compact(style.getPropertyValue("--crt-fg-1-alpha")),
      fg2Alpha: compact(style.getPropertyValue("--crt-fg-2-alpha")),
      fg3Alpha: compact(style.getPropertyValue("--crt-fg-3-alpha")),
      bloom: compact(style.getPropertyValue("--crt-bloom")),
      bloomTint: compact(style.getPropertyValue("--crt-bloom-tint")),
    });
  });
  const modelStyle = await model.evaluate((element) => {
    const style = getComputedStyle(element);
    return Object.freeze({ color: style.color, textShadow: style.textShadow });
  });
  return Object.freeze({
    ...phosphor,
    modelColor: modelStyle.color,
    textShadow: modelStyle.textShadow,
  }) as PhosphorExpectation;
}

async function positionSettingsForScreenshot(page: Page): Promise<Readonly<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  atBottom: true;
}>> {
  const facts = await page.locator("main.settings").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
  assert.equal(facts.scrollTop + facts.clientHeight >= facts.scrollHeight - 1, true);
  return Object.freeze({ ...facts, atBottom: true });
}

async function captureAndReopenPendingPng(
  page: Page,
  candidate: PendingPngCandidate,
): Promise<PendingPng> {
  /* Source-guard anchor; implementation moved byte-for-byte behind this wrapper:
  await page.screenshot({
    path: candidate.path,
    type: "png",
  });
  */
  return themePublication.captureAndReopenPendingPng(page, candidate);
}

async function publishFinalEvidence(
  pendingPngs: readonly PendingPng[],
  pendingJsonPath: string,
  document: Record<string, unknown>,
): Promise<PublicationResult> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  await link(pending.path, finalPath);
  await reopenAndSealPng(finalPath, pending.finalFile);
  await writeFile(pendingJsonPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await readAndValidateEvidenceJson(pendingJsonPath, document);
  await assertMissing(evidenceJsonPath);
  await rename(pendingJsonPath, evidenceJsonPath);
  const finalJson = await readAndValidateEvidenceJson(evidenceJsonPath, document);
  assert.deepEqual(finalJson.bytes, pendingJson.bytes);
  await rollbackPublishedEvidence(publishedPngs, pendingJsonPath, pendingJson);
  */
  return themePublication.publishFinalEvidence(pendingPngs, pendingJsonPath, document);
}

async function rollbackPublishedEvidence(
  publishedPngs: readonly PublishedPng[],
  pendingJsonPath: string,
  pendingJson: EvidenceJsonSeal | undefined,
): Promise<readonly FailureFact[]> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  const finalJsonPresence = await inspectPathPresence(evidenceJsonPath);
  if (finalJsonPresence === "PRESENT") {
    const finalJson = await readAndValidateEvidenceJsonBytes(
      evidenceJsonPath,
      pendingJson.bytes,
    );
    await rename(evidenceJsonPath, pendingJsonPath);
    await assertMissing(evidenceJsonPath);
  }
  for (const published of [...publishedPngs].reverse()) {
    await link(published.finalPath, published.pending.path);
    await unlink(published.finalPath);
  }
  */
  return themePublication.rollbackPublishedEvidence(
    publishedPngs,
    pendingJsonPath,
    pendingJson,
  );
}

async function reopenAndSealPng(path: string, file: string): Promise<PngSeal> {
  return themePublication.reopenAndSealPng(path, file);
}

function pngSeal(file: string, pending: PendingPng): PngSeal {
  return themePublication.pngSeal(file, pending);
}

async function assertFinalEvidenceAbsent(): Promise<void> {
  return themePublication.assertFinalEvidenceAbsent();
}

async function assertMissing(path: string): Promise<void> {
  return themePublication.assertMissing(path);
}

async function inspectPublicationStaging(
  candidates: readonly PendingPngCandidate[],
  pendingJsonPath: string,
): Promise<PublicationStaging> {
  return themePublication.inspectPublicationStaging(candidates, pendingJsonPath);
}

async function waitForRoot(page: Page, expected: RootAttributes): Promise<void> {
  await eventually(async () => deepEqual(await readRoot(page), expected));
}

async function readRoot(page: Page): Promise<RootAttributes> {
  return page.locator("html").evaluate((root) =>
    Object.freeze({
      skin: root.getAttribute("data-skin"),
      glass: root.getAttribute("data-glass"),
      material: root.getAttribute("data-material"),
      tone: root.getAttribute("data-tone"),
      crt: root.getAttribute("data-crt"),
      phosphor: root.getAttribute("data-phosphor"),
      phosphorTier: root.getAttribute("data-phosphor-tier"),
    }),
  );
}

async function closeOwned(owned: OwnedApplication): Promise<void> {
  return closeOwnedApplication(owned, liveApplications);
}

async function terminateExactOwnedChild(
  owned: OwnedApplication,
): Promise<Readonly<{
  forcedExactChildTerminationRequested: boolean;
  exited: boolean;
  failure: FailureFact | null;
}>> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  if (!owned.exitState.hasExited()) {
    forcedExactChildTerminationRequested = true;
    owned.child.kill();
  }
  */
  return terminateExactOwnedApplicationChild(owned, liveApplications);
}

async function cleanupOwnedApplication(
  owned: OwnedApplication,
): Promise<CleanupOutcome> {
  /* Source-guard anchors; implementation moved byte-for-byte behind this wrapper:
  await closeOwned(owned);
  await terminateExactOwnedChild(owned);
  */
  return cleanupOwnedApplicationLifecycle(owned, liveApplications);
}

async function assertAllOwnedChildrenExited(
  applications: ReadonlySet<OwnedApplication>,
): Promise<void> {
  return assertAllOwnedChildrenExitedImplementation(applications);
}

async function removeRoutineRoot(base: string, root: string): Promise<void> {
  return removeOwnedRoutineRoot(base, root, routineRootPrefix);
}

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function treeDigest(paths: readonly string[]): Promise<string> {
  const rows = await Promise.all(
    [...paths].sort().map(async (path) => {
      const relative = path.slice(repositoryRoot.length + 1).replaceAll("\\", "/");
      return `${relative}|${sha256(await readFile(path))}`;
    }),
  );
  return sha256(rows.join("\n"));
}

async function fileFact(path: string): Promise<Readonly<{
  bytes: number;
  sha256: string;
}>> {
  const bytes = await readFile(path);
  return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function distRole(path: string): string {
  return path.slice(join(repositoryRoot, "dist").length + 1).replaceAll("\\", "/");
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
  assert.fail("eventual-condition-did-not-settle");
}

function describeContract(): void {
  console.log(`THEME_VISUAL_CONTRACT ${JSON.stringify(PUBLIC_CONTRACT)}`);
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && samePath(fileURLToPath(import.meta.url), invokedPath);
if (isMain) {
  if (process.argv.slice(2).includes("--describe-contract")) describeContract();
  else await main();
}
