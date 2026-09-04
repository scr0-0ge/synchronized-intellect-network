import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { type ElectronApplication, type Page } from "playwright";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import { createOfficialClaudeCatalogTransport } from "../../src/agent-runtime/claude/process-transport.ts";
import type { ClaudeCatalogTransport } from "../../src/agent-runtime/claude/transport.ts";
import { createOfficialCodexTransport } from "../../src/agent-runtime/codex/process-transport.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";
import {
  completeProviderAttemptRound,
  initializeProviderRequestBudget,
  openProviderRequestBudget,
  verifyCompletedDefaultProviderAttempt,
  type ProviderRequestBudget,
} from "../../src/agent-runtime/provider-request-budget.ts";
import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeModel,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import {
  PROVIDER_ATTEMPT_BUILD_MARKER,
  PROVIDER_ATTEMPT_PROTOCOL,
  detectProviderAttemptBuildMarker,
  preflightProviderAttempt,
} from "../../src/workbench-shell/provider-attempt-plan.ts";
import {
  PROVIDER_ATTEMPT_BUILD_MARKER_SWITCH,
  PROVIDER_ATTEMPT_LOCATOR_SWITCH,
  PROVIDER_ATTEMPT_PROTOCOL_SWITCH,
} from "../../src/workbench-shell/provider-attempt-runtime.ts";
import { createIndependentObservationRecorder } from "./live-proof-observations.ts";
import { sanitizeHeadlessCatalogFailure } from "./headless-catalog-failure.ts";
import { captureF102SurfaceEvidence } from "./electron-e2e/f102-surface-evidence.ts";
import { HarnessFailure, isHarnessFailure } from "./electron-e2e/harness-failure.ts";
import {
  arraysEqual,
  type CatalogObservation,
  claudeModelDisplayLabels,
  closeProfilePickerIfOpen,
  compactText,
  inspectRenderedCatalogs,
  item8Assertion,
  item9Assertion,
  type NormalizedModel,
  normalizeModels,
  profileChip,
  profileChipValue,
  type RenderedEndpointObservation,
  type RuntimeFamily,
  selectRenderedCatalogModel,
  selectRenderedIntensity,
} from "./electron-e2e/rendered-catalog-inspection.ts";
import {
  historicalNativeModel,
  inspectRenderedProfileProjection,
  inspectRendererBoundary,
  mismatchedNativeModel,
  projectedNativeModel,
  type RenderedProfileObservation,
  unknownNativeModel,
} from "./electron-e2e/rendered-profile-inspection.ts";
import {
  electronExecutable,
  expectedRendererUrl,
  productionElectron,
  repositoryRoot,
} from "./electron-e2e/production-composition.ts";
import {
  type ItemId,
  type ItemResult,
  type ItemStatus,
  result,
} from "./electron-e2e/result.ts";
import { runF169PackagedCopy } from "./f169-packaged-copy.ts";
import {
  firstDomContentLoadedWindow,
  launchProductionElectron,
  productionElectronArguments,
} from "./harness/production-electron.ts";
import {
  classifyObservedProcesses,
  type ObservedProcessStart,
  type ProcessOwnership,
} from "./process-ownership.ts";

type HarnessInternalStep =
  | "temporary-root-creation"
  | "provider-attempt-preflight"
  | "provider-attempt-initialization"
  | "provider-attempt-round-completion"
  | "provider-attempt-verification"
  | "isolated-path-setup"
  | "projected-session-seeding"
  | "codex-catalog-read"
  | "claude-catalog-read"
  | "item-4-composition"
  | "positive-composition"
  | "negative-item-24-composition"
  | "verdict-assembly"
  | "positive-composer-focus"
  | "positive-picker-discovery"
  | "item-4-after-observation-process-count"
  | "item-4-composer-focus"
  | "item-4-after-composer-focus-process-count"
  | "item-4-picker-discovery"
  | "item-4-after-picker-open-process-count"
  | "positive-catalog-not-ready-observation"
  | "positive-item-8-9-catalog-inspection"
  | "summary-emission"
  | "diagnostics-emission"
  | "item-verdict-emission";

type ProcessStartEvent = ObservedProcessStart;

type ProcessDescriptor = Readonly<{
  name: ProcessStartEvent["name"];
  pid: number;
}>;

type ProcessWindowDiagnostic = Readonly<{
  phase: "item4" | "positive" | "negative";
  owned: readonly ProcessDescriptor[];
  foreign: readonly ProcessDescriptor[];
}>;

type ApplicationCleanupOutcome = Readonly<{
  gracefulCloseSucceeded: boolean;
  forcedExactChildTerminationRequested: boolean;
  exactChildDeathProved: true;
}>;

type ApplicationCleanupDiagnostic = Readonly<
  ApplicationCleanupOutcome & {
    phase: "item4" | "positive" | "negative";
  }
>;

type RuntimeStartCounts = Readonly<{
  claude: number;
  claudeCatalog: number;
  claudePreflight: number;
  claudeUnclassified: number;
  codex: number;
  total: number;
}>;

type ProductFinding = Readonly<{
  id: string;
  severity: "high" | "medium" | "low";
  summary: string;
  source: string;
}>;

type LiveClaudeComposerObservation = Readonly<{
  executed: true;
  accepted: true;
  completed: true;
  markerObserved: true;
  modelLabel: string;
  effortLabel: string;
  normalizedEventKinds: readonly string[];
}>;

type PositiveObservation = Readonly<{
  item1: ItemResult;
  item2: ItemResult;
  item8: ItemResult;
  item9: ItemResult;
  endpoints: readonly RenderedEndpointObservation[];
  mainPid: number;
  observedAccessText: string;
  profileProjection: RenderedProfileObservation;
  liveClaudeComposer?: LiveClaudeComposerObservation;
}>;

type Item4Observation = Readonly<{
  item4: ItemResult;
  emptyProjectProven: boolean;
  discoveryPickerOpened: boolean;
  afterObservationRuntimeStarts: RuntimeStartCounts;
  afterComposerFocusRuntimeStarts: RuntimeStartCounts;
  afterPickerOpenRuntimeStarts: RuntimeStartCounts;
}>;

type NegativeObservation = Readonly<{
  item24: ItemResult;
  runtimeStarts: RuntimeStartCounts;
}>;

function toHeadlessCatalogHarnessFailure(
  runtime: RuntimeFamily,
  error: unknown,
): HarnessFailure {
  if (isHarnessFailure(error)) return error;
  const fixedContext =
    runtime === "codex"
      ? "the real Runtime catalog could not be read"
      : "the real Claude catalog could not be read";
  return new HarnessFailure(
    "E2E_HEADLESS_CATALOG_FAILED",
    `${fixedContext}; evidence=${JSON.stringify(sanitizeHeadlessCatalogFailure(error))}`,
  );
}

const temporaryRootPattern = /^workbench-electron-e2e-[A-Za-z0-9_-]+$/u;
const positiveConfiguration = "runtime-discoverable";
const negativeConfiguration = "runtime-undiscoverable";
const negativeDraft = "negative-control-draft-preserved";
const notLocatedHeading = "No Agent Runtime is available";
const notLocatedMessage =
  "The Workbench looked for the runtimes it knows about and found neither of them installed and signed in on this machine. Sessions can't start until at least one is ready.";
const draftPreservedMessage =
  "Your draft is kept. It will send once an endpoint is available.";
const continuationProfileReadyText =
  "Latest turn profile selected for the next turn.";

async function waitForContinuationProfileReady(page: Page): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const controlNotes = document.querySelectorAll(
        ".composer .control-note",
      );
      return (
        controlNotes.length === 1 &&
        controlNotes[0]?.textContent?.trim() === expected
      );
    },
    continuationProfileReadyText,
    { timeout: 20_000 },
  );
}

const historicalSolEfforts = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const liveClaudeMode = Object.prototype.hasOwnProperty.call(
  process.env,
  "UAW_E2E_CLAUDE_LIVE",
)
  ? process.env.UAW_E2E_CLAUDE_LIVE
  : undefined;
const f102CaptureMode = Object.prototype.hasOwnProperty.call(
  process.env,
  "UAW_E2E_F102_CAPTURE_PREFIX",
)
  ? process.env.UAW_E2E_F102_CAPTURE_PREFIX
  : undefined;
const runLiveClaudeComposer = liveClaudeMode === "isolated-fixed-marker";
const f102CapturePrefix =
  f102CaptureMode === "before" || f102CaptureMode === "after"
    ? f102CaptureMode
    : undefined;
const liveClaudeMarker = "UAW_E2E_CLAUDE_SESSION_V1";

let temporaryRoot = "";
let providerAttemptLocator = "";
let providerRequestBudget: ProviderRequestBudget | undefined;
const processWindowDiagnostics: ProcessWindowDiagnostic[] = [];
const applicationCleanupDiagnostics: ApplicationCleanupDiagnostic[] = [];

async function preflightDefaultProviderAttempt() {
  let bundledMain: string;
  try {
    bundledMain = await readFile(
      join(repositoryRoot, "dist", "main", "main.js"),
      "utf8",
    );
  } catch {
    throw new HarnessFailure(
      "E2E_PROVIDER_ATTEMPT_PREFLIGHT_REJECTED",
      "the production build marker is missing or unreadable",
    );
  }
  const result = preflightProviderAttempt({
    liveClaudeMode,
    f102CaptureMode,
    sourceBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
    distBuildMarker: detectProviderAttemptBuildMarker(bundledMain) ?? "",
  });
  if (!result.ok) {
    throw new HarnessFailure(
      "E2E_PROVIDER_ATTEMPT_PREFLIGHT_REJECTED",
      result.error.category === "attempt-budget-exceeded"
        ? "the requested attempt mode exceeds the 24-operation bound"
        : "the provider attempt flags or production build marker are invalid",
    );
  }
  return result.plan;
}

function requiredProviderRequestBudget(): ProviderRequestBudget {
  if (providerRequestBudget === undefined) {
    throw new HarnessFailure(
      "E2E_PROVIDER_ATTEMPT_PREFLIGHT_REJECTED",
      "the provider request governor was not initialized",
    );
  }
  return providerRequestBudget;
}

async function completeDefaultProviderRound(
  name:
    | "independent-headless"
    | "item-4-lazy-picker"
    | "positive-continuation-composition"
    | "positive-new-session-explicit-refresh",
): Promise<void> {
  await runInternalStep("provider-attempt-round-completion", () =>
    completeProviderAttemptRound({
      locator: providerAttemptLocator,
      expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      name,
    }),
  );
}

async function main(): Promise<void> {
  let summary: Record<string, unknown> | undefined;
  let failure: HarnessFailure | undefined;
  let exactChildDeathsProved = false;

  try {
    const attemptPlan = await runInternalStep(
      "provider-attempt-preflight",
      preflightDefaultProviderAttempt,
    );
    temporaryRoot = await runInternalStep("temporary-root-creation", () =>
      mkdtemp(join(resolve(tmpdir()), "workbench-electron-e2e-")),
    );
    providerAttemptLocator = resolve(
      temporaryRoot,
      "provider-request-attempt-default",
    );
    await runInternalStep("provider-attempt-initialization", async () => {
      await initializeProviderRequestBudget({
        locator: providerAttemptLocator,
        plan: attemptPlan,
      });
      providerRequestBudget = openProviderRequestBudget({
        locator: providerAttemptLocator,
        expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
      });
    });
    const paths = await runInternalStep("isolated-path-setup", () =>
      createIsolatedPaths(temporaryRoot),
    );
    await runInternalStep("projected-session-seeding", () =>
      seedProjectedSessions(
        paths.positiveProject,
        paths.positiveCollapsedProject,
        paths.positiveUserData,
      ),
    );
    const codexCatalog = await runInternalStep("codex-catalog-read", () =>
      readHeadlessCodexCatalog(
        paths.codexCatalogProject,
        requiredProviderRequestBudget(),
      ),
    );
    const claudeCatalog = await runInternalStep("claude-catalog-read", () =>
      readHeadlessClaudeCatalog(
        paths.claudeCatalogProject,
        requiredProviderRequestBudget(),
      ),
    );
    await completeDefaultProviderRound("independent-headless");
    const catalogs = Object.freeze([codexCatalog, claudeCatalog]);
    const item4 = await runInternalStep("item-4-composition", () =>
      observeItem4Composition(paths, catalogs.length),
    );
    await completeDefaultProviderRound("item-4-lazy-picker");
    const positive = await runInternalStep("positive-composition", () =>
      observePositiveComposition(paths, catalogs),
    );
    const negative = await runInternalStep("negative-item-24-composition", () =>
      observeNegativeComposition(paths),
    );
    const providerAttempt = await runInternalStep(
      "provider-attempt-verification",
      () =>
        verifyCompletedDefaultProviderAttempt({
          locator: providerAttemptLocator,
          expectedBuildMarker: PROVIDER_ATTEMPT_BUILD_MARKER,
        }),
    );
    summary = await runInternalStep("verdict-assembly", () => {
      const items = Object.freeze([
        positive.item1,
        positive.item2,
        item4.item4,
        positive.item8,
        positive.item9,
        negative.item24,
      ]);
      const findings = productFindings(items, positive.observedAccessText);
      const sol = codexCatalog.models.find(
        (model) => model.id === "gpt-5.6-sol",
      );
      const historicalCatalogMatches =
        codexCatalog.models.length === 7 &&
        arraysEqual(sol?.intensityValues ?? [], historicalSolEfforts) &&
        sol?.controlLabelProvenance === "workbench-fallback";

      const assembledSummary: Record<string, unknown> = {
        schema: "electron-e2e-summary-v2",
        composition: {
          built: true,
          main: "production",
          preload: "production-contextBridge",
          renderer: "production",
          adapterDirectory: "real-codex+real-claude",
        },
        providerAttempt: {
          complete: providerAttempt.complete,
          operationCount: providerAttempt.operationCount,
          operationLimit: providerAttempt.operationLimit,
          markerVerified: true,
        },
        catalog: {
          independentInspectionDirectories: !equalWindowsPath(
            paths.codexCatalogProject,
            paths.claudeCatalogProject,
          ),
          endpoints: catalogs.map(summarizeCatalog),
          rendererExactOrderAndCount: positive.item8.status === "settled",
          renderedEndpoints: positive.endpoints,
        },
        historicalCatalog: {
          matchesWorker43: historicalCatalogMatches,
          expectedModelCount: 7,
          observedModelCount: codexCatalog.models.length,
          expectedSolEfforts: historicalSolEfforts,
          observedSolEfforts: sol?.intensityValues ?? [],
          observedSolRuntimeControlLabel:
            sol === undefined ? "model-not-present" : sol.runtimeControlLabel,
          observedSolRenderedControlLabel:
            sol?.controlLabel ?? "model-not-present",
          observedSolControlLabelProvenance:
            sol?.controlLabelProvenance ?? "model-not-present",
        },
        configurations: {
          item8: positiveConfiguration,
          item24: negativeConfiguration,
          sameConfiguration: Object.is(
            positiveConfiguration,
            negativeConfiguration,
          ),
          negativeControlPassed: negative.item24.status === "settled",
          negativeRuntimeStarts: negative.runtimeStarts,
        },
        profileLoading: {
          trigger: "endpoint-picker-open",
          isolatedEmptyProject: item4.emptyProjectProven,
          pickerOpened: item4.discoveryPickerOpened,
          runtimeStartsAfterObservation: item4.afterObservationRuntimeStarts,
          runtimeStartsAfterComposerFocus:
            item4.afterComposerFocusRuntimeStarts,
          runtimeStartsAfterPickerOpen: item4.afterPickerOpenRuntimeStarts,
          exactlyOneCatalogLoadingChildRound:
            item4.item4.status === "settled",
        },
        profileProjection: positive.profileProjection,
        ...(positive.liveClaudeComposer === undefined
          ? {}
          : { liveClaudeComposer: positive.liveClaudeComposer }),
        items,
        findings,
      };
      assertPrivacySafeSummary(assembledSummary);
      return assembledSummary;
    });
  } catch (error) {
    failure = safeFailure(error);
  } finally {
    exactChildDeathsProved =
      applicationCleanupDiagnostics.length === 3 &&
      applicationCleanupDiagnostics.every(
        (outcome) => outcome.exactChildDeathProved,
      );
    if (temporaryRoot.length > 0 && failure === undefined) {
      if (!exactChildDeathsProved) {
        failure = new HarnessFailure(
          "E2E_CLEANUP_FAILED",
          "the isolated E2E root was retained without three exact child death proofs",
        );
      } else {
        try {
          await removeOwnedTemporaryRoot(temporaryRoot);
        } catch {
          failure = new HarnessFailure(
            "E2E_CLEANUP_FAILED",
            "the isolated E2E root could not be removed",
          );
        }
      }
    }
  }

  if (failure !== undefined) {
    console.log(`${failure.code} ${failure.safeMessage}`);
    process.exitCode = 1;
  } else if (summary !== undefined) {
    const finalSummary = summary;
    try {
      const items = await runInternalStep("summary-emission", () => {
        const completedSummary: Record<string, unknown> = {
          ...finalSummary,
          cleanup: {
            isolatedRootRemoved: true,
            applicationCloseOutcomes: applicationCleanupDiagnostics,
            exactChildDeathsProved,
          },
        };
        const serialized = JSON.stringify(completedSummary);
        const bytes = Buffer.byteLength(serialized, "utf8");
        const sha256 = createHash("sha256")
          .update(serialized, "utf8")
          .digest("hex");
        console.log(`E2E_SUMMARY ${serialized}`);
        console.log(`E2E_SUMMARY_BYTES ${bytes}`);
        console.log(`E2E_SUMMARY_SHA256 ${sha256}`);
        console.log(`E2E_VERDICT_SECTION ${serialized}`);
        console.log(`E2E_VERDICT_SECTION_BYTES ${bytes}`);
        console.log(`E2E_VERDICT_SECTION_SHA256 ${sha256}`);
        return finalSummary["items"] as readonly ItemResult[];
      });
      await runInternalStep("diagnostics-emission", () => {
        const diagnostics = JSON.stringify({
          schema: "electron-e2e-diagnostics-v2",
          applicationCloseOutcomes: applicationCleanupDiagnostics,
          exactChildDeathsProved,
          processWindows: processWindowDiagnostics,
        });
        const diagnosticsBytes = Buffer.byteLength(diagnostics, "utf8");
        const diagnosticsSha256 = createHash("sha256")
          .update(diagnostics, "utf8")
          .digest("hex");
        console.log(`E2E_DIAGNOSTICS_SECTION ${diagnostics}`);
        console.log(`E2E_DIAGNOSTICS_SECTION_BYTES ${diagnosticsBytes}`);
        console.log(`E2E_DIAGNOSTICS_SECTION_SHA256 ${diagnosticsSha256}`);
      });
      await runInternalStep("item-verdict-emission", () => {
        for (const item of items) {
          console.log(
            `E2E_ITEM_${item.item} ${item.status} | ${item.assertion} | ${item.detail}`,
          );
        }
        if (items.some((item) => item.status === "not-settled")) {
          console.log(
            `E2E_PRODUCT_ASSERTIONS_FAILED ${items
              .filter((item) => item.status === "not-settled")
              .map((item) => item.item)
              .join(",")}`,
          );
          process.exitCode = 1;
        } else {
          console.log("E2E_ALL_ASSERTIONS_SETTLED");
        }
      });
    } catch (error) {
      const emissionFailure = safeFailure(error);
      console.log(`${emissionFailure.code} ${emissionFailure.safeMessage}`);
      process.exitCode = 1;
    }
  }
}

async function createIsolatedPaths(root: string): Promise<{
  readonly item4Project: string;
  readonly item4UserData: string;
  readonly positiveProject: string;
  readonly positiveCollapsedProject: string;
  readonly positiveUserData: string;
  readonly codexCatalogProject: string;
  readonly claudeCatalogProject: string;
  readonly negativeProject: string;
  readonly negativeUserData: string;
  readonly negativeHome: string;
  readonly negativePath: string;
}> {
  const paths = {
    item4Project: join(root, "item-4-project"),
    item4UserData: join(root, "item-4-user-data"),
    positiveProject: join(root, "positive-project"),
    positiveCollapsedProject: join(root, "collapsed-project"),
    positiveUserData: join(root, "positive-user-data"),
    codexCatalogProject: join(root, "codex-catalog-project"),
    claudeCatalogProject: join(root, "claude-catalog-project"),
    negativeProject: join(root, "negative-project"),
    negativeUserData: join(root, "negative-user-data"),
    negativeHome: join(root, "negative-home"),
    negativePath: join(root, "negative-path"),
  } as const;
  for (const directory of Object.values(paths)) await mkdir(directory);
  return paths;
}

class ProfileProjectionFixtureAdapter implements ResumableAgentRuntimeAdapter {
  async inspect(): Promise<RuntimeCatalog> {
    return {
      runtime: "fixture",
      models: [
        { id: projectedNativeModel, effortLevels: ["native-deep"] },
        { id: historicalNativeModel, effortLevels: ["native-legacy"] },
        { id: unknownNativeModel, effortLevels: ["native-focused"] },
        { id: mismatchedNativeModel, effortLevels: ["native-deep"] },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    return this.binding(request.profile);
  }

  private binding(profile: SessionProfile): ResumableRuntimeBinding {
    return {
      profile: structuredClone(profile),
      opaqueSessionReference: `fixture-capability-${profile.model}`,
      async send(_input: RuntimeInput): Promise<void> {},
      effectiveProfile(): SessionProfile | undefined {
        if (profile.model === unknownNativeModel) return undefined;
        if (profile.model === mismatchedNativeModel) {
          return {
            ...profile,
            effortLevel: "native-lower",
          };
        }
        return structuredClone(profile);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: "Projection fixture completed." };
        yield {
          kind: "turn-completed",
          status: "completed",
          ...(profile.model === projectedNativeModel
            ? {
                context: {
                  basis: "active-context" as const,
                  usedTokens: 122_000,
                  windowTokens: 200_000,
                },
              }
            : profile.model === unknownNativeModel
              ? {
                  context: {
                    basis: "turn-usage" as const,
                    usedTokens: 0,
                    windowTokens: null,
                  },
                }
              : {}),
        };
      },
    };
  }
}

async function seedProjectedSessions(
  projectDirectory: string,
  collapsedProjectDirectory: string,
  userDataDirectory: string,
): Promise<void> {
  const canonicalProject = await realpath(projectDirectory);
  const canonicalCollapsedProject = await realpath(collapsedProjectDirectory);
  const dataDirectory = join(userDataDirectory, "workbench-project-host");
  const ledgerDirectory = join(dataDirectory, "project-ledgers");
  const recordKey =
    "project-record-v1-00000000-0000-4000-8000-000000000159";
  const ledgerSlot =
    "project-ledger-v1-00000000-0000-4000-8000-000000000160";
  const collapsedRecordKey =
    "project-record-v1-00000000-0000-4000-8000-000000000161";
  const collapsedLedgerSlot =
    "project-ledger-v1-00000000-0000-4000-8000-000000000162";
  await mkdir(ledgerDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "project-registry-v1.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      nextProjectOrdinal: 3,
      selectedRecordKey: recordKey,
      records: [
        {
          recordKey,
          canonicalDirectory: canonicalProject,
          ledgerSlot,
        },
        {
          recordKey: collapsedRecordKey,
          canonicalDirectory: canonicalCollapsedProject,
          ledgerSlot: collapsedLedgerSlot,
        },
      ],
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const channel = await createWorkbenchCoordinator({
    databasePath: join(ledgerDirectory, `${ledgerSlot}.sqlite`),
    adapter: new ProfileProjectionFixtureAdapter(),
  }).openProject(canonicalProject);
  try {
    const fixtures = [
      {
        expectedTerminal: "completed" as const,
        profile: {
          model: projectedNativeModel,
          effortLevel: "native-deep",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        projection: {
          kind: "recorded" as const,
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          modelLabel: "Profile Alpha",
          workIntensityControlLabel: {
            label: "Deliberation",
            provenance: "runtime-catalog" as const,
          },
          workIntensityLabel: "Deep review",
          executionModeLabel: "Single agent",
          accessModeLabel: "Full access",
        },
      },
      {
        expectedTerminal: "completed" as const,
        profile: {
          model: historicalNativeModel,
          effortLevel: "native-legacy",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
      },
      {
        expectedTerminal: "completed" as const,
        profile: {
          model: unknownNativeModel,
          effortLevel: "native-focused",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        projection: {
          kind: "recorded" as const,
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          modelLabel: "Profile Gamma",
          workIntensityControlLabel: {
            label: null,
            provenance: "not-recorded" as const,
          },
          workIntensityLabel: "Focused",
          executionModeLabel: "Single agent",
          accessModeLabel: "Full access",
        },
      },
      {
        expectedTerminal: "failed" as const,
        profile: {
          model: mismatchedNativeModel,
          effortLevel: "native-deep",
          executionMode: "single-agent",
          accessMode: "full-access",
        },
        projection: {
          kind: "recorded" as const,
          runtimeFamilyLabel: "Codex",
          endpointLabel: "Codex desktop",
          modelLabel: "Profile Delta",
          workIntensityControlLabel: {
            label: "Deliberation",
            provenance: "runtime-catalog" as const,
          },
          workIntensityLabel: "Deep review",
          executionModeLabel: "Single agent",
          accessModeLabel: "Full access",
        },
      },
    ] as const;
    for (const [index, fixture] of fixtures.entries()) {
      const receipt = await channel.act({
        kind: "direct",
        commandKind: "start",
        idempotencyKey: `profile-fixture-${index + 1}`,
        runtime: "codex",
        catalogRevision: "profile-fixture-catalog-v1",
        preferences: { global: fixture.profile },
        profile: fixture.profile,
        runtimeResumeIdentity: {
          schemaVersion: 1,
          endpointId: "codex-desktop",
          nativeProfile: fixture.profile,
        },
        ...("projection" in fixture
          ? { requestedProfileProjection: fixture.projection }
          : {}),
        input: "Render the durable profile fixture.",
      }, {
        endpointId: "codex-desktop",
      });
      await withTimeout(
        waitForSeededTerminal(
          channel,
          receipt.commandId,
          fixture.expectedTerminal,
        ),
        5_000,
        "profile-fixture-terminal-timeout",
      );
    }
  } finally {
    await channel.close();
  }
  const collapsedChannel = await createWorkbenchCoordinator({
    databasePath: join(ledgerDirectory, `${collapsedLedgerSlot}.sqlite`),
    adapter: new ProfileProjectionFixtureAdapter(),
  }).openProject(canonicalCollapsedProject);
  await collapsedChannel.close();
}

async function waitForSeededTerminal(
  channel: Awaited<ReturnType<ReturnType<typeof createWorkbenchCoordinator>["openProject"]>>,
  commandId: string,
  expectedStatus: "completed" | "failed",
): Promise<void> {
  while (true) {
    const command = (await channel.snapshot()).commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status === expectedStatus) return;
    if (
      command?.status === "completed" ||
      command?.status === "failed" ||
      command?.status === "recovery-required"
    ) {
      throw new Error("profile-fixture-failed");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

// `readNativeCatalog` follows `nextCursor` for as many pages as the vendor
// offers; that ceiling must never live in production, where a hard page cap in
// the parser broke real Codex catalog reads for the owner (finding F108). This
// harness already declares a third `model/list` a failed run below, so the
// ceiling belongs here — enforced before the bytes leave the harness, where
// refusing the page costs the owner's provider allowance nothing.
const headlessCodexModelListPageCeiling = 2;

async function readHeadlessCodexCatalog(
  projectDirectory: string,
  providerBudget: ProviderRequestBudget,
): Promise<CatalogObservation> {
  const methods: string[] = [];
  let refusedModelListPage: HarnessFailure | undefined;
  const adapter = new CodexAdapter(async () => {
    let delegate: OfficialRuntimeTransport;
    try {
      delegate = await createOfficialCodexTransport();
    } catch {
      throw new HarnessFailure(
        "E2E_HEADLESS_CATALOG_FAILED",
        "the real Runtime catalog transport could not start",
      );
    }
    return {
      async send(line: string): Promise<void> {
        const method = outboundMethod(line);
        if (method !== undefined) {
          if (method.startsWith("thread/") || method.startsWith("turn/")) {
            throw new HarnessFailure(
              "E2E_ZERO_TURN_GUARD_FAILED",
              "a forbidden thread or turn method was attempted",
            );
          }
          if (
            method === "model/list" &&
            methods.filter((candidate) => candidate === "model/list").length >=
              headlessCodexModelListPageCeiling
          ) {
            refusedModelListPage = new HarnessFailure(
              "E2E_CATALOG_PAGINATION_CEILING_REACHED",
              `the real Codex catalog read asked for more than ${headlessCodexModelListPageCeiling} model/list pages; the harness refused to send the extra page`,
            );
            throw refusedModelListPage;
          }
          methods.push(method);
        }
        await delegate.send(line);
      },
      receive: () => delegate.receive(),
      stop: () => delegate.stop(),
    } satisfies OfficialRuntimeTransport;
  }, providerBudget);
  let catalog: RuntimeCatalog;
  try {
    catalog = await adapter.inspect(projectDirectory);
  } catch (error) {
    if (refusedModelListPage !== undefined) throw refusedModelListPage;
    throw toHeadlessCatalogHarnessFailure("codex", error);
  }
  if (refusedModelListPage !== undefined) throw refusedModelListPage;
  const modelListRequests = methods.filter(
    (method) => method === "model/list",
  ).length;
  if (
    catalog.runtime !== "codex" ||
    catalog.models.length === 0 ||
    modelListRequests < 1 ||
    modelListRequests > 2
  ) {
    throw new HarnessFailure(
      "E2E_FAKE_OR_STUB_DETECTED",
      "the independent catalog did not come from the real Codex adapter",
    );
  }
  return Object.freeze({
    runtime: "codex" as const,
    runtimeFamilyLabel: "Codex",
    endpointLabel: "Codex desktop",
    catalog,
    models: normalizeModels("codex", catalog.models),
    protocol: Object.freeze({
      kind: "codex-model-list" as const,
      modelListRequests,
      zeroTurns: true as const,
    }),
  });
}

async function readHeadlessClaudeCatalog(
  projectDirectory: string,
  providerBudget: ProviderRequestBudget,
): Promise<CatalogObservation> {
  let initializeControlRequests = 0;
  let outboundFrames = 0;
  let userFrames = 0;
  let assistantFrames = 0;
  let resultFrames = 0;
  const resolvedModelsById = new Map<string, string>();
  const observeFrame = (line: string): void => {
    const type = claudeFrameType(line);
    if (type === "user") userFrames += 1;
    if (type === "assistant") assistantFrames += 1;
    if (type === "result") resultFrames += 1;
  };
  const adapter = new ClaudeAdapter(async (directory) => {
    let delegate: ClaudeCatalogTransport;
    try {
      delegate = await createOfficialClaudeCatalogTransport(
        directory,
        undefined,
        providerBudget,
      );
    } catch {
      throw new HarnessFailure(
        "E2E_HEADLESS_CATALOG_FAILED",
        "the real Claude catalog transport could not start",
      );
    }
    return {
      async send(line: string): Promise<void> {
        outboundFrames += 1;
        observeFrame(line);
        if (isClaudeInitializeControlRequest(line)) {
          initializeControlRequests += 1;
        } else {
          throw new HarnessFailure(
            "E2E_ZERO_TURN_GUARD_FAILED",
            "Claude catalog inspection attempted a non-initialize outbound frame",
          );
        }
        await delegate.send(line);
      },
      async receive(): Promise<string | null> {
        const line = await delegate.receive();
        if (line !== null) {
          observeFrame(line);
          captureClaudeResolvedModels(line, resolvedModelsById);
        }
        return line;
      },
      stop: () => delegate.stop(),
    } satisfies ClaudeCatalogTransport;
  }, undefined, providerBudget);
  let catalog: RuntimeCatalog;
  try {
    catalog = await adapter.inspect(projectDirectory);
  } catch (error) {
    throw toHeadlessCatalogHarnessFailure("claude", error);
  }
  if (
    catalog.runtime !== "claude" ||
    catalog.models.length === 0 ||
    initializeControlRequests !== 1 ||
    outboundFrames !== 1 ||
    userFrames !== 0 ||
    assistantFrames !== 0 ||
    resultFrames !== 0
  ) {
    throw new HarnessFailure(
      "E2E_FAKE_OR_STUB_DETECTED",
      "the independent catalog did not come from the real zero-turn Claude adapter",
    );
  }
  return Object.freeze({
    runtime: "claude" as const,
    runtimeFamilyLabel: "Claude",
    endpointLabel: "Claude Code desktop",
    catalog,
    models: normalizeModels("claude", catalog.models, resolvedModelsById),
    protocol: Object.freeze({
      kind: "claude-initialize" as const,
      initializeControlRequests,
      outboundFrames,
      userFrames,
      assistantFrames,
      resultFrames,
      zeroTurns: true as const,
    }),
  });
}

function outboundMethod(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { readonly method?: unknown };
    return typeof value.method === "string" ? value.method : undefined;
  } catch {
    throw new HarnessFailure(
      "E2E_ZERO_TURN_GUARD_FAILED",
      "an outbound Runtime message could not be inspected",
    );
  }
}

function claudeFrameType(line: string): string | undefined {
  const value = parseJsonRecord(line);
  return typeof value?.type === "string" ? value.type : undefined;
}

function isClaudeInitializeControlRequest(line: string): boolean {
  const value = parseJsonRecord(line);
  if (
    value?.type !== "control_request" ||
    typeof value.request_id !== "string" ||
    value.request_id.length === 0 ||
    Object.keys(value).sort().join("\u0000") !==
      ["request", "request_id", "type"].sort().join("\u0000")
  ) {
    return false;
  }
  const request = value.request;
  return (
    typeof request === "object" &&
    request !== null &&
    !Array.isArray(request) &&
    Object.keys(request).sort().join("\u0000") ===
      ["hooks", "subtype"].sort().join("\u0000") &&
    (request as Record<string, unknown>).subtype === "initialize" &&
    (request as Record<string, unknown>).hooks === null
  );
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function captureClaudeResolvedModels(
  line: string,
  resolvedModelsById: Map<string, string>,
): void {
  const message = parseJsonRecord(line);
  if (message?.type !== "control_response") return;
  const outerResponse = asDataRecord(message.response);
  const catalog = asDataRecord(outerResponse?.response);
  if (!Array.isArray(catalog?.models)) return;
  for (const candidate of catalog.models) {
    const model = asDataRecord(candidate);
    if (
      typeof model?.value !== "string" ||
      model.value.length === 0 ||
      model.value.length > 240
    ) {
      continue;
    }
    const resolvedModel =
      typeof model.resolvedModel === "string"
        ? model.resolvedModel
        : model.value;
    if (resolvedModel.length === 0 || resolvedModel.length > 240) continue;
    resolvedModelsById.set(model.value, resolvedModel);
  }
}

function asDataRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}


async function observePositiveComposition(
  paths: Awaited<ReturnType<typeof createIsolatedPaths>>,
  catalogs: readonly CatalogObservation[],
): Promise<PositiveObservation> {
  const observer = await ProcessStartObserver.start(
    join(temporaryRoot, "positive-process-observer.stop"),
  );
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let mainPid = -1;
  let primaryFailure: { readonly error: unknown } | undefined;
  try {
    application = await launchProduction(
      paths.positiveProject,
      paths.positiveUserData,
      definedEnvironment(process.env),
    );
    ownedMainProcess = application.process();
    mainPid = ownedMainProcess.pid ?? -1;
    const page = await firstDomContentLoadedWindow(application, 15_000);
    const item1 = await inspectDevLaunch(
      application,
      page,
      paths.positiveProject,
      paths.positiveUserData,
    );
    const profileProjection = await inspectRenderedProfileProjection(
      page,
      paths.positiveProject,
      paths.positiveCollapsedProject,
      waitForContinuationProfileReady,
    );
    await completeDefaultProviderRound("positive-continuation-composition");
    if (f102CapturePrefix !== undefined) {
      await captureF102SurfaceEvidence(
        application,
        page,
        f102CapturePrefix,
        repositoryRoot,
      );
    }
    const item2 = await inspectRendererBoundary(
      page,
      paths.positiveProject,
      profileProjection,
    );

    await runInternalStep("positive-composer-focus", async () => {
      const newSession = page.locator(".rail .new-session-button");
      await newSession.waitFor({ state: "visible", timeout: 10_000 });
      await newSession.click({ timeout: 10_000 });
      const input = page.locator(".composer .input-shell textarea");
      await input.waitFor({ state: "visible", timeout: 10_000 });
      await input.evaluate((element) => {
        element.blur();
        element.focus();
      });
    });
    const discoveryPickerOpened = await runInternalStep(
      "positive-picker-discovery",
      async () => {
        try {
          const endpoint = profileChip(page, "endpoint");
          await endpoint.waitFor({ state: "visible", timeout: 5_000 });
          await endpoint.click({ timeout: 5_000 });
          await page
            .locator(
              '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
            )
            .waitFor({ state: "visible", timeout: 5_000 });
          return true;
        } catch {
          return false;
        }
      },
    );
    let profileReady = false;
    if (discoveryPickerOpened) {
      try {
        await page.waitForFunction(
          (expectedCount) =>
            document.querySelectorAll(
              '.composer .controlbar > .popover[role="dialog"]:not([hidden]) .picker-list > .opt.opt-endpoint',
            ).length === expectedCount,
          catalogs.length,
          { timeout: 20_000 },
        );
        profileReady = true;
      } catch {
        profileReady = false;
      }
    }
    await closeProfilePickerIfOpen(page);
    await completeDefaultProviderRound(
      "positive-new-session-explicit-refresh",
    );

    let item8: ItemResult;
    let item9: ItemResult;
    let endpoints: readonly RenderedEndpointObservation[] = Object.freeze([]);
    let observedAccessText = "not-observed";
    let liveClaudeComposer: LiveClaudeComposerObservation | undefined;
    if (!profileReady) {
      const observedProfileState = await runInternalStep(
        "positive-catalog-not-ready-observation",
        async () =>
          (await profileChip(page, "endpoint").count()) === 1
            ? (await profileChipValue(page, "endpoint")) || "not-observed"
            : "not-observed",
      );
      item8 = result(
        "8",
        "not-settled",
        item8Assertion,
        `the production renderer never reached the catalog-ready state; observed profile state=${observedProfileState}`,
      );
      item9 = result(
        "9",
        "not-settled",
        item9Assertion,
        "model selection was unavailable because the catalog-ready state was not reached",
      );
    } else {
      const catalogResult = await runInternalStep(
        "positive-item-8-9-catalog-inspection",
        () => inspectRenderedCatalogs(page, catalogs),
      );
      item8 = catalogResult.item8;
      item9 = catalogResult.item9;
      endpoints = catalogResult.endpoints;
      observedAccessText = catalogResult.observedAccessText;
      if (runLiveClaudeComposer) {
        liveClaudeComposer = await exerciseLiveClaudeComposer(page, catalogs);
      }
    }
    return Object.freeze({
      item1,
      item2,
      item8,
      item9,
      endpoints,
      mainPid,
      observedAccessText,
      profileProjection,
      ...(liveClaudeComposer === undefined ? {} : { liveClaudeComposer }),
    });
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      const cleanup = await closeApplication(
        application,
        ownedMainProcess,
        mainPid,
      );
      if (cleanup !== undefined) {
        applicationCleanupDiagnostics.push(
          Object.freeze({ phase: "positive", ...cleanup }),
        );
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    let events = observer.snapshot();
    try {
      events = await observer.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      const ownership = classifyObservedProcesses(events, mainPid);
      const owned = processDescriptors(events, ownership.ownedPids, mainPid);
      recordProcessWindow("positive", events, ownership, mainPid);
      await assertProcessesExited(owned);
    } catch (error) {
      cleanupFailures.push(error);
    }
    throwCleanupFailures(primaryFailure, cleanupFailures, "positive composition");
  }
}

async function observeItem4Composition(
  paths: Awaited<ReturnType<typeof createIsolatedPaths>>,
  expectedEndpointCount: number,
): Promise<Item4Observation> {
  const observer = await ProcessStartObserver.start(
    join(temporaryRoot, "item-4-process-observer.stop"),
  );
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let mainPid = -1;
  let primaryFailure: { readonly error: unknown } | undefined;
  try {
    application = await launchProduction(
      paths.item4Project,
      paths.item4UserData,
      definedEnvironment(process.env),
    );
    ownedMainProcess = application.process();
    mainPid = ownedMainProcess.pid ?? -1;
    const page = await firstDomContentLoadedWindow(application, 15_000);
    const input = page.locator(".composer .input-shell textarea");
    await input.waitFor({ state: "visible", timeout: 10_000 });
    const item4ProjectLabel = basename(paths.item4Project);
    const item4ProjectShape = await page.evaluate((expectedLabel) => {
      const projects = Array.from(document.querySelectorAll<HTMLElement>(".rail .proj"));
      const selected = projects.filter((project) =>
        project.classList.contains("is-open"),
      );
      const project = selected[0];
      const toggle = project?.querySelector<HTMLButtonElement>(
        ":scope > .proj-head > .proj-toggle",
      );
      return {
        projectCount: projects.length,
        selectedCount: selected.length,
        selectedLabel:
          toggle?.querySelector(":scope > .proj-name")?.textContent?.trim() ?? "",
        selectedCurrent: toggle?.getAttribute("aria-current") ?? "",
        selectedDisabled: toggle?.disabled ?? true,
        sessionRowCount:
          project?.querySelectorAll(":scope > .proj-sessions .session-row").length ??
          -1,
        emptyCopy:
          project
            ?.querySelector<HTMLElement>(
              ":scope > .proj-sessions .rail-empty > p",
            )
            ?.innerText.replace(/\s+/gu, " ")
            .trim() ?? "",
        stageHeading:
          document.querySelector(".stage .empty-project-card h1")?.textContent?.trim() ??
          "",
        expectedLabel,
      };
    }, item4ProjectLabel);
    const emptyProjectProven =
      item4ProjectShape.projectCount === 1 &&
      item4ProjectShape.selectedCount === 1 &&
      item4ProjectShape.selectedLabel === item4ProjectLabel &&
      item4ProjectShape.selectedCurrent === "page" &&
      !item4ProjectShape.selectedDisabled &&
      item4ProjectShape.sessionRowCount === 0 &&
      item4ProjectShape.emptyCopy ===
        "No Agent Sessions in this Project yet. The first message starts one." &&
      item4ProjectShape.stageHeading === "Start the first Agent Session";

    const afterObservationRuntimeStarts = await runInternalStep(
      "item-4-after-observation-process-count",
      async () => {
        await page.waitForTimeout(750);
        return runtimeStartCountsByApplication(observer.snapshot(), mainPid);
      },
    );
    await runInternalStep("item-4-composer-focus", async () => {
      await input.evaluate((element) => {
        element.blur();
        element.focus();
      });
    });
    const afterComposerFocusAbsoluteRuntimeStarts = await runInternalStep(
      "item-4-after-composer-focus-process-count",
      async () => {
        await page.waitForTimeout(750);
        return runtimeStartCountsByApplication(observer.snapshot(), mainPid);
      },
    );
    const afterComposerFocusRuntimeStarts = runtimeStartDelta(
      afterComposerFocusAbsoluteRuntimeStarts,
      afterObservationRuntimeStarts,
    );
    const discoveryPickerOpened = await runInternalStep(
      "item-4-picker-discovery",
      async () => {
        try {
          const endpoint = profileChip(page, "endpoint");
          await endpoint.waitFor({ state: "visible", timeout: 5_000 });
          await endpoint.click({ timeout: 5_000 });
          await page
            .locator(
              '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
            )
            .waitFor({ state: "visible", timeout: 5_000 });
          await page.waitForFunction(
            (expectedCount) =>
              document.querySelectorAll(
                '.composer .controlbar > .popover[role="dialog"]:not([hidden]) .picker-list > .opt.opt-endpoint',
              ).length === expectedCount,
            expectedEndpointCount,
            { timeout: 20_000 },
          );
          return true;
        } catch {
          return false;
        }
      },
    );
    const afterPickerOpenAbsoluteRuntimeStarts = await runInternalStep(
      "item-4-after-picker-open-process-count",
      async () => {
        await page.waitForTimeout(750);
        return runtimeStartCountsByApplication(observer.snapshot(), mainPid);
      },
    );
    const afterPickerOpenRuntimeStarts = runtimeStartDelta(
      afterPickerOpenAbsoluteRuntimeStarts,
      afterComposerFocusAbsoluteRuntimeStarts,
    );
    const sessionRowsAfterDiscovery = await page
      .locator(".rail .proj.is-open > .proj-sessions .session-row")
      .count();
    await closeProfilePickerIfOpen(page);

    const exact =
      emptyProjectProven &&
      sessionRowsAfterDiscovery === 0 &&
      discoveryPickerOpened &&
      isZeroRuntimeStarts(afterObservationRuntimeStarts) &&
      isZeroRuntimeStarts(afterComposerFocusRuntimeStarts) &&
      isSingleCatalogLoadingChildRound(afterPickerOpenRuntimeStarts);
    const item4 = result(
      "4",
      exact ? "settled" : "not-settled",
      "In one isolated, selected, available empty Project, passive observation and composer focus start no Agent Runtime process; opening the endpoint picker follows the adapters' zero-turn catalog-loading path and starts exactly one Codex app-server child plus one short-lived Claude bootstrap child and one Claude catalog child.",
      `empty Project proven=${emptyProjectProven}(${JSON.stringify(item4ProjectShape)}); endpoint picker opened=${discoveryPickerOpened}; Session rows after discovery=${sessionRowsAfterDiscovery}; Runtime starts after passive observation=${formatRuntimeStarts(afterObservationRuntimeStarts)}; delta after composer focus=${formatRuntimeStarts(afterComposerFocusRuntimeStarts)}; catalog-loading child delta after endpoint picker open=${formatRuntimeStarts(afterPickerOpenRuntimeStarts)}; zero-turn protocol is independently guarded by the Codex model/list-only and Claude initialize-only adapter tests`,
    );
    return Object.freeze({
      item4,
      emptyProjectProven,
      discoveryPickerOpened,
      afterObservationRuntimeStarts,
      afterComposerFocusRuntimeStarts,
      afterPickerOpenRuntimeStarts,
    });
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      const cleanup = await closeApplication(
        application,
        ownedMainProcess,
        mainPid,
      );
      if (cleanup !== undefined) {
        applicationCleanupDiagnostics.push(
          Object.freeze({ phase: "item4", ...cleanup }),
        );
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    let events = observer.snapshot();
    try {
      events = await observer.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      const ownership = classifyObservedProcesses(events, mainPid);
      const owned = processDescriptors(events, ownership.ownedPids, mainPid);
      recordProcessWindow("item4", events, ownership, mainPid);
      await assertProcessesExited(owned);
    } catch (error) {
      cleanupFailures.push(error);
    }
    throwCleanupFailures(primaryFailure, cleanupFailures, "item 4 composition");
  }
}

async function exerciseLiveClaudeComposer(
  page: Page,
  catalogs: readonly CatalogObservation[],
): Promise<LiveClaudeComposerObservation> {
  const observations = createIndependentObservationRecorder(
    ["durable-acceptance", "normalized-completion"] as const,
    (observation) =>
      console.log(
        `E2E_LIVE_CLAUDE_OBSERVATION ${JSON.stringify(observation)}`,
      ),
  );
  const claude = catalogs[1];
  if (claude?.runtime !== "claude") {
    throw new HarnessFailure(
      "E2E_HARNESS_INTERNAL_FAILED",
      "the live composer did not resolve the independently inspected Claude endpoint",
    );
  }
  const preferredModelIndex = Math.max(
    0,
    claude.models.findIndex((model) => /haiku/iu.test(model.label)),
  );
  const model = claude.models[preferredModelIndex];
  if (model === undefined || model.intensityValues.length === 0) {
    throw new HarnessFailure(
      "E2E_LIVE_CLAUDE_FAILED",
      "the live Claude catalog offered no bounded model and effort selection",
    );
  }
  await selectRenderedCatalogModel(page, catalogs, {
    endpointIndex: 1,
    modelIndex: preferredModelIndex,
  });
  const preferredEffortIndex = Math.max(
    0,
    model.intensityValues.findIndex((value) => value === "low"),
  );
  await selectRenderedIntensity(
    page,
    claude.runtime,
    model,
    preferredEffortIndex,
  );
  const input = page.locator(".composer .input-shell textarea");
  await input.fill(`Reply with exactly ${liveClaudeMarker}`);
  const submit = page.locator(".composer .input-shell .send");
  await submit.waitFor({ state: "visible", timeout: 5_000 });
  if (await submit.isDisabled()) {
    throw new HarnessFailure(
      "E2E_LIVE_CLAUDE_FAILED",
      "the exact Claude composer selection did not become submittable",
    );
  }
  await submit.click();
  let markerObserved = false;
  let normalizedEventKinds: readonly string[] = Object.freeze([]);
  const acceptance = page
    .locator(".composer .control-note.is-ok")
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(async () => {
      const feedback =
        (
          await page
            .locator(".composer .control-note.is-ok")
            .textContent()
        )?.trim() ?? "";
      if (!feedback.includes("durably accepted")) {
        throw new HarnessFailure(
          "E2E_LIVE_CLAUDE_FAILED",
          "the accepted composer state did not carry its sanitized durable receipt",
        );
      }
      observations.record("durable-acceptance", {
        receipt: {
          ok: true,
          status: "accepted",
          message: feedback,
        },
      });
    });
  const completion = page
    .locator(".turn .turn-state.is-done")
    .waitFor({ state: "visible", timeout: 180_000 })
    .then(async () => {
      const markerText =
        (
          await page
            .locator(".turn:not(.turn-user) .turn-body.prose")
            .last()
            .textContent()
        )?.trim() ??
        "";
      markerObserved = markerText === liveClaudeMarker;
      normalizedEventKinds = Object.freeze(
        (
          await page.locator(".event-log .ev-kind").allTextContents()
        ).map((value) => value.trim()),
      );
      observations.record("normalized-completion", {
        terminalStatus: "completed",
        markerObserved,
        normalizedEventKinds,
      });
    });
  const outcomes = await Promise.allSettled([acceptance, completion]);
  const snapshot = observations.snapshot();
  console.log(
    `E2E_LIVE_CLAUDE_OBSERVATIONS_FINAL ${JSON.stringify(snapshot)}`,
  );
  const outstanding = observations.outstanding();
  if (
    outcomes.some((outcome) => outcome.status === "rejected") ||
    outstanding.length > 0
  ) {
    throw new HarnessFailure(
      "E2E_LIVE_CLAUDE_FAILED",
      `the real Claude composer timed out with outstanding observations=${
        outstanding.length === 0 ? "none" : outstanding.join(",")
      }`,
    );
  }
  const expectedEventKinds = [
    "session-started",
    "turn-started",
    "item-started",
    "item-completed",
    "agent-message",
    "turn-completed",
  ];
  const acceptanceObservation = snapshot.find(
    (observation) => observation.name === "durable-acceptance",
  );
  const completionObservation = snapshot.find(
    (observation) => observation.name === "normalized-completion",
  );
  if (
    acceptanceObservation?.observed !== true ||
    completionObservation?.observed !== true ||
    acceptanceObservation.ordinal >= completionObservation.ordinal ||
    !markerObserved ||
    !arraysEqual(normalizedEventKinds, expectedEventKinds)
  ) {
    throw new HarnessFailure(
      "E2E_LIVE_CLAUDE_FAILED",
      "the real Claude reply did not traverse the exact normalized Project timeline",
    );
  }
  return Object.freeze({
    executed: true as const,
    accepted: true as const,
    completed: true as const,
    markerObserved: true as const,
    modelLabel: model.label,
    effortLabel: model.intensityTickLabels[preferredEffortIndex]!,
    normalizedEventKinds,
  });
}

async function launchProduction(
  projectDirectory: string,
  userDataDirectory: string,
  environment: Readonly<Record<string, string>>,
): Promise<ElectronApplication> {
  if (providerAttemptLocator.length === 0) {
    throw new HarnessFailure(
      "E2E_PROVIDER_ATTEMPT_PREFLIGHT_REJECTED",
      "the provider request governor locator is unavailable",
    );
  }
  try {
    return await launchProductionElectron(productionElectron, {
      args: productionElectronArguments(productionElectron, userDataDirectory, [
        `--${PROVIDER_ATTEMPT_LOCATOR_SWITCH}=${providerAttemptLocator}`,
        `--${PROVIDER_ATTEMPT_PROTOCOL_SWITCH}=${PROVIDER_ATTEMPT_PROTOCOL}`,
        `--${PROVIDER_ATTEMPT_BUILD_MARKER_SWITCH}=${PROVIDER_ATTEMPT_BUILD_MARKER}`,
      ]),
      cwd: projectDirectory,
      env: environment,
      timeout: 15_000,
    });
  } catch {
    throw new HarnessFailure(
      "E2E_REAL_COMPOSITION_LAUNCH_FAILED",
      "the built production Electron composition did not launch",
    );
  }
}

async function inspectDevLaunch(
  application: ElectronApplication,
  page: Page,
  projectDirectory: string,
  userDataDirectory: string,
): Promise<ItemResult> {
  if (page.url() !== expectedRendererUrl) {
    throw new HarnessFailure(
      "E2E_QA_RENDERER_DETECTED",
      "the attached window was not the production dist renderer",
    );
  }
  const mainState = await application.evaluate(({ app }) => ({
    currentWorkingDirectory: process.cwd(),
    userDataDirectory: app.getPath("userData"),
    packaged: app.isPackaged,
  }));
  const exact =
    application.windows().length === 1 &&
    equalWindowsPath(mainState.currentWorkingDirectory, projectDirectory) &&
    equalWindowsPath(mainState.userDataDirectory, userDataDirectory) &&
    mainState.packaged === false;
  return result(
    "1",
    exact ? "settled" : "not-settled",
    "Development launch from an external cwd opens exactly one Electron window on the built production renderer with isolated user data.",
    exact
      ? "one production Electron window; external cwd and isolated user data confirmed"
      : "window count or launch isolation did not match the required development composition",
  );
}

async function observeNegativeComposition(
  paths: Awaited<ReturnType<typeof createIsolatedPaths>>,
): Promise<NegativeObservation> {
  const observer = await ProcessStartObserver.start(
    join(temporaryRoot, "negative-process-observer.stop"),
  );
  let application: ElectronApplication | undefined;
  let ownedMainProcess: ChildProcess | undefined;
  let mainPid = -1;
  let item24: ItemResult;
  let primaryFailure: { readonly error: unknown } | undefined;
  try {
    const environment = negativeEnvironment(paths.negativeHome, paths.negativePath);
    application = await launchProduction(
      paths.negativeProject,
      paths.negativeUserData,
      environment,
    );
    ownedMainProcess = application.process();
    mainPid = ownedMainProcess.pid ?? -1;
    const page = await firstDomContentLoadedWindow(application, 15_000);
    if (page.url() !== expectedRendererUrl) {
      throw new HarnessFailure(
        "E2E_QA_RENDERER_DETECTED",
        "the negative control attached to a non-production renderer",
      );
    }
    const input = page.locator(".composer .input-shell textarea");
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(negativeDraft);
    let discoveryPickerOpened = true;
    try {
      const endpoint = profileChip(page, "endpoint");
      await endpoint.waitFor({ state: "visible", timeout: 5_000 });
      await endpoint.click({ timeout: 5_000 });
    } catch {
      discoveryPickerOpened = false;
    }
    const state = page.locator(".stage-state .state-card");
    let reachedNotLocated = true;
    try {
      await page
        .getByRole("heading", { name: notLocatedHeading, exact: true })
        .waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      reachedNotLocated = false;
    }
    await page.waitForTimeout(500);
    const heading = reachedNotLocated
      ? ((await state.locator("h1").textContent()) ?? "").trim()
      : "";
    const message = reachedNotLocated
      ? compactText((await state.locator(":scope > p").first().textContent()) ?? "")
      : "";
    const runtimeNeutralHeadingExact = heading === notLocatedHeading;
    const runtimeNeutralMessageExact = message === notLocatedMessage;
    const draftValueExact = (await input.inputValue()) === negativeDraft;
    const draftDisabledExact = await input.isDisabled();
    const draftTargetCopy = compactText(
      (await page.locator(".target-bar.is-blocked .tb-text").textContent()) ?? "",
    );
    const draftTargetCopyExact = draftTargetCopy === draftPreservedMessage;
    const draftFooterCopyExact = compactText(
      (await page.locator(".composer-foot").textContent()) ?? "",
    ).includes("Draft preserved");
    const draftPreserved =
      draftValueExact &&
      draftDisabledExact &&
      draftTargetCopyExact &&
      draftFooterCopyExact;
    const retryCount = await page
      .getByRole("button", { name: /^(?:retry|re-check(?: now)?)$/iu })
      .count();
    const readyCount = await page.locator(".composer .control-note.is-ok").count();
    const selectorCount = await page
      .locator(
        '.composer .controlbar > button.chip[aria-haspopup="dialog"]',
      )
      .count();
    const settingsActionCount = await state
      .getByRole("button", { name: "Open Settings", exact: true })
      .count();
    const supersededProviderActionCount = await state
      .getByRole("button", { name: "Open Providers", exact: true })
      .count();
    const duplicatedDirectionCount = await state
      .locator(":scope > .runtime-settings-direction")
      .count();
    const credentialBoundary = state.locator(":scope > .runtime-boundary-copy");
    const credentialBoundaryCount = await credentialBoundary.count();
    const credentialBoundaryText =
      credentialBoundaryCount === 1
        ? compactText((await credentialBoundary.textContent()) ?? "")
        : "not-observed";
    const credentialBoundaryTextExact =
      credentialBoundaryCount === 1 &&
      credentialBoundaryText ===
        "Sign-in happens in each provider's own app. The Workbench never asks for a password, API key, or token, never reads a credential file, and never stores credentials.";
    const primaryAction = state.locator(".state-actions .btn.primary");
    const primaryActionText =
      (await primaryAction.count()) === 1
        ? compactText((await primaryAction.textContent()) ?? "")
        : "not-observed";
    const executionText =
      (await page.locator(".statusbar .sb-mode .v").textContent())?.trim() ?? "";
    const accessText =
      (await page.locator(".statusbar .sb-access .v").textContent())?.trim() ?? "";
    const modesExact =
      executionText === "Single agent" && accessText === "Full access";
    const contextRingCount = await page.locator(".ctx-ring").count();
    const runtimeStarts = runtimeStartCountsByApplication(
      observer.snapshot(),
      mainPid,
    );
    let settingsActionNavigatesSettings = false;
    if (settingsActionCount === 1) {
      try {
        await state
          .getByRole("button", { name: "Open Settings", exact: true })
          .click({ timeout: 5_000 });
        await page
          .getByRole("heading", { name: "Settings", exact: true })
          .waitFor({ state: "visible", timeout: 5_000 });
        settingsActionNavigatesSettings =
          (await page
            .getByRole("button", { name: "Close Settings", exact: true })
            .count()) === 1;
      } catch {
        settingsActionNavigatesSettings = false;
      }
    }
    const exact =
      discoveryPickerOpened &&
      reachedNotLocated &&
      runtimeNeutralHeadingExact &&
      runtimeNeutralMessageExact &&
      draftPreserved &&
      retryCount === 0 &&
      readyCount === 0 &&
      selectorCount === 0 &&
      settingsActionCount === 1 &&
      supersededProviderActionCount === 0 &&
      duplicatedDirectionCount === 0 &&
      credentialBoundaryTextExact &&
      settingsActionNavigatesSettings &&
      modesExact &&
      contextRingCount === 0 &&
      isZeroRuntimeStarts(runtimeStarts);
    const failures = [
      ...(discoveryPickerOpened
        ? []
        : ["endpoint-picker-open expected=true observed=false"]),
      ...(reachedNotLocated
        ? []
        : ["not-located-state expected=true observed=false"]),
      ...(runtimeNeutralHeadingExact && runtimeNeutralMessageExact
        ? []
        : [
            `runtime-neutral-copy expected-heading=${JSON.stringify(notLocatedHeading)} observed-heading=${JSON.stringify(heading)} expected-message=${JSON.stringify(notLocatedMessage)} observed-message=${JSON.stringify(message)}`,
          ]),
      ...(draftPreserved
        ? []
        : [
            `draft-preserved expected=true observed=false(value=${draftValueExact},disabled=${draftDisabledExact},expected-target=${JSON.stringify(draftPreservedMessage)},observed-target=${JSON.stringify(draftTargetCopy)},footer-copy=${draftFooterCopyExact})`,
          ]),
      ...(retryCount === 0
        ? []
        : [`retry-count expected=0 observed=${retryCount}`]),
      ...(readyCount === 0
        ? []
        : [`ready-count expected=0 observed=${readyCount}`]),
      ...(selectorCount === 0
        ? []
        : [`catalog-selector-count expected=0 observed=${selectorCount}`]),
      ...(settingsActionCount === 1
        ? []
        : [
            `owner-ruled-primary-action expected=${JSON.stringify("Open Settings")} observed=${JSON.stringify(primaryActionText)} open-settings-count=${settingsActionCount}`,
          ]),
      ...(supersededProviderActionCount === 0
        ? []
        : [
            `superseded-open-providers-count expected=0 observed=${supersededProviderActionCount}`,
          ]),
      ...(duplicatedDirectionCount === 0
        ? []
        : [
            `duplicated-settings-direction-count expected=0 observed=${duplicatedDirectionCount}`,
          ]),
      ...(credentialBoundaryTextExact
        ? []
        : [
            `f13-boundary-copy expected=exact observed-count=${credentialBoundaryCount} observed-exact=false`,
          ]),
      ...(settingsActionNavigatesSettings
        ? []
        : ["open-settings-navigation expected=Settings observed=not-reached"]),
      ...(modesExact
        ? []
        : [
            `fixed-modes expected=Single agent/Full access observed=${executionText || "empty"}/${accessText || "empty"}`,
          ]),
      ...(contextRingCount === 0
        ? []
        : [`context-ring-count expected=0 observed=${contextRingCount}`]),
      ...(isZeroRuntimeStarts(runtimeStarts)
        ? []
        : [
            `runtime-starts expected=claude:0,codex:0,total:0 observed=${formatRuntimeStarts(
              runtimeStarts,
            )}`,
          ]),
    ];
    item24 = result(
      "24",
      exact ? "settled" : "not-settled",
      "After a draft is entered, opening the endpoint picker with both Runtime discoveries disabled renders the runtime-neutral actionable state, preserves and disables the draft, keeps Execution and Access visible, retains one working owner-ruled Open Settings route, omits the superseded Open Providers label and duplicated gear direction, preserves the exact F13 boundary paragraph, offers no retry or catalog controls, omits the context ring, and starts neither Runtime.",
      exact
        ? "endpoint picker triggered discovery; both Runtimes undiscoverable; runtime-neutral copy, preserved disabled draft, one Open Settings action reached Settings, superseded Open Providers action and duplicated gear direction absent, exact F13 boundary paragraph preserved, fixed modes, zero retries, zero catalog controls, zero context rings, zero Runtime starts"
        : `failed checks: ${failures.join(";")}`,
    );
    return Object.freeze({ item24, runtimeStarts });
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      const cleanup = await closeApplication(
        application,
        ownedMainProcess,
        mainPid,
      );
      if (cleanup !== undefined) {
        applicationCleanupDiagnostics.push(
          Object.freeze({ phase: "negative", ...cleanup }),
        );
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    let events = observer.snapshot();
    try {
      events = await observer.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      const ownership = classifyObservedProcesses(events, mainPid);
      const owned = processDescriptors(events, ownership.ownedPids, mainPid);
      recordProcessWindow("negative", events, ownership, mainPid);
      await assertProcessesExited(owned);
    } catch (error) {
      cleanupFailures.push(error);
    }
    throwCleanupFailures(primaryFailure, cleanupFailures, "negative composition");
  }
}

function negativeEnvironment(
  negativeHome: string,
  negativePath: string,
): Record<string, string> {
  const root = parse(negativeHome).root;
  const homePath = negativeHome.slice(root.length - 1);
  const environment = definedEnvironment(process.env);
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  environment.PATH = negativePath;
  environment.Path = negativePath;
  environment.HOME = negativeHome;
  environment.USERPROFILE = negativeHome;
  environment.HOMEDRIVE = root.slice(0, 2);
  environment.HOMEPATH = homePath.startsWith("\\") ? homePath : `\\${homePath}`;
  return environment;
}

function definedEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function closeApplication(
  application: ElectronApplication | undefined,
  ownedMainProcess: ChildProcess | undefined,
  ownedMainPid: number,
): Promise<ApplicationCleanupOutcome | undefined> {
  if (application === undefined) {
    if (ownedMainProcess !== undefined || ownedMainPid > 0) {
      throw new HarnessFailure(
        "E2E_CLEANUP_FAILED",
        "an owned Electron process was captured without its application",
      );
    }
    return undefined;
  }
  const currentMainProcess = application.process();
  if (
    ownedMainProcess === undefined ||
    ownedMainPid <= 0 ||
    currentMainProcess !== ownedMainProcess ||
    currentMainProcess.pid !== ownedMainPid
  ) {
    throw new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      "the owned Electron application no longer matches its captured child",
    );
  }
  let gracefulCloseSucceeded = false;
  let gracefulCloseFailed = false;
  let forcedExactChildTerminationRequested = false;
  try {
    await withTimeout(application.close(), 10_000, "application-close-timeout");
    gracefulCloseSucceeded = true;
  } catch {
    gracefulCloseFailed = true;
  }
  let exited = await waitForExactOwnedChildExit(
    ownedMainProcess,
    ownedMainPid,
    1_000,
  );
  if (
    !exited &&
    isExactOwnedChildAlive(ownedMainProcess, ownedMainPid)
  ) {
    forcedExactChildTerminationRequested = true;
    ownedMainProcess.kill();
  }
  exited =
    exited ||
    (await waitForExactOwnedChildExit(
      ownedMainProcess,
      ownedMainPid,
      5_000,
    ));
  if (!exited) {
    throw new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      "the exact owned Electron child survived bounded cleanup",
    );
  }
  if (gracefulCloseFailed) {
    throw new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      "the product-owned graceful close failed before exact-child cleanup",
    );
  }
  return Object.freeze({
    gracefulCloseSucceeded:
      gracefulCloseSucceeded && !forcedExactChildTerminationRequested,
    forcedExactChildTerminationRequested,
    exactChildDeathProved: true,
  });
}

function throwCleanupFailures(
  primaryFailure: { readonly error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
  context: string,
): void {
  if (cleanupFailures.length === 0) return;
  throw new AggregateError(
    primaryFailure === undefined
      ? cleanupFailures
      : [primaryFailure.error, ...cleanupFailures],
    `${context} cleanup failed`,
  );
}

class ProcessStartObserver {
  readonly events: ProcessStartEvent[] = [];
  private readonly child: ChildProcess;
  private readonly childPid: number | undefined;
  private readonly lines: ReadLineInterface;
  private readonly outputClosed: Promise<void>;
  private readonly stopFile: string;
  private stopped = false;

  private constructor(
    child: ChildProcess,
    stopFile: string,
    lines: ReadLineInterface,
  ) {
    this.child = child;
    this.childPid = child.pid;
    this.stopFile = stopFile;
    this.lines = lines;
    this.outputClosed = new Promise<void>((resolveClosed) => {
      lines.once("close", resolveClosed);
    });
  }

  static async start(stopFile: string): Promise<ProcessStartObserver> {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class UnifiedWorkbenchProcessSnapshot
{
    private const uint SnapshotProcesses = 0x00000002;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableName;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static string[] Read()
    {
        var result = new List<string>();
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == InvalidHandle) return result.ToArray();
        try
        {
            var entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (!Process32FirstW(snapshot, ref entry)) return result.ToArray();
            do
            {
                if (string.Equals(entry.ExecutableName, "electron.exe", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(entry.ExecutableName, "codex.exe", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(entry.ExecutableName, "claude.exe", StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(entry.ExecutableName + "|" + entry.ProcessId + "|" + entry.ParentProcessId);
                }
            }
            while (Process32NextW(snapshot, ref entry));
            return result.ToArray();
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}
'@
$seen = [Collections.Generic.HashSet[int]]::new()
$baseline = [UnifiedWorkbenchProcessSnapshot]::Read()
foreach ($record in $baseline) {
  $parts = $record.Split('|')
  [void]$seen.Add([int]$parts[1])
}
function Read-ObservedRole([string]$name, [int]$processId) {
  if ($name -ieq 'codex.exe') { return 'unclassified' }
  if ($name -ine 'claude.exe') { return 'runtime' }
  try {
    $record = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $processId) -ErrorAction Stop
    $commandLine = [string]$record.CommandLine
    if ($commandLine -match '(?:^|\s)auth\s+status\s+--json(?:\s|$)') {
      return 'preflight'
    }
    if (
      $commandLine -match '(?:^|\s)--output-format\s+stream-json(?:\s|$)' -and
      $commandLine -match '(?:^|\s)--input-format\s+stream-json(?:\s|$)' -and
      $commandLine -match '(?:^|\s)--system-prompt(?:\s|$)' -and
      $commandLine -match '(?:^|\s)--tools(?:\s|$)'
    ) {
      return 'catalog'
    }
  } catch {
    return 'unclassified'
  }
  return 'unclassified'
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while (-not [IO.File]::Exists($env:E2E_PROCESS_WATCH_STOP)) {
  $processes = [UnifiedWorkbenchProcessSnapshot]::Read()
  foreach ($record in $processes) {
    $parts = $record.Split('|')
    $pidValue = [int]$parts[1]
    if ($seen.Add($pidValue)) {
      $role = Read-ObservedRole $parts[0] $pidValue
      [Console]::Out.WriteLine(('EVENT|{0}|{1}|{2}|{3}' -f $parts[0], $pidValue, $parts[2], $role))
      [Console]::Out.Flush()
    }
  }
  Start-Sleep -Milliseconds 2
}
`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        env: { ...process.env, E2E_PROCESS_WATCH_STOP: stopFile },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const lines = createInterface({ input: child.stdout! });
    const observer = new ProcessStartObserver(child, stopFile, lines);
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      let resolved = false;
      lines.on("line", (line) => {
        if (line === "READY" && !resolved) {
          resolved = true;
          resolveReady();
          return;
        }
        const event = parseProcessEvent(line);
        if (event !== undefined) observer.events.push(event);
      });
      child.once("error", () => {
        if (!resolved) rejectReady(new Error("observer-spawn-failed"));
      });
      child.once("exit", () => {
        if (!resolved) rejectReady(new Error("observer-exited-before-ready"));
      });
    });
    try {
      await withTimeout(ready, 10_000, "observer-ready-timeout");
      return observer;
    } catch (error) {
      const childExited = await terminateExactOwnedChild(
        child,
        observer.childPid,
        5_000,
      );
      let outputDrained = false;
      if (childExited) {
        try {
          await observer.drainOutput();
          outputDrained = true;
        } catch {
          outputDrained = false;
        }
      }
      if (!childExited || !outputDrained) {
        throw new AggregateError(
          [
            error,
            new HarnessFailure(
              "E2E_CLEANUP_FAILED",
              childExited
                ? "the process observer output did not drain after startup cleanup"
                : "the exact owned process observer child survived startup cleanup",
            ),
          ],
          "process observer startup cleanup failed",
        );
      }
      throw new HarnessFailure(
        "E2E_PROCESS_OBSERVER_FAILED",
        "the zero-interaction process observer could not start",
      );
    }
  }

  snapshot(): readonly ProcessStartEvent[] {
    return Object.freeze([...this.events]);
  }

  async stop(): Promise<readonly ProcessStartEvent[]> {
    if (this.stopped) return this.snapshot();
    this.stopped = true;
    let exitCode: number | null | undefined;
    try {
      await writeFile(this.stopFile, "stop\n", {
        encoding: "utf8",
        flag: "wx",
      });
      exitCode = await withTimeout(
        waitForChildExit(this.child),
        8_000,
        "observer-stop-timeout",
      );
    } catch {
      exitCode = undefined;
    }
    const exitedCleanly =
      exitCode === 0 &&
      (await waitForExactOwnedChildExit(this.child, this.childPid, 1_000));
    if (!exitedCleanly) {
      let exactTerminationRequested = false;
      if (isExactOwnedChildAlive(this.child, this.childPid)) {
        exactTerminationRequested = true;
        this.child.kill();
      }
      const childExited = await waitForExactOwnedChildExit(
        this.child,
        this.childPid,
        5_000,
      );
      throw new HarnessFailure(
        "E2E_PROCESS_OBSERVER_FAILED",
        childExited
          ? exactTerminationRequested
            ? "the zero-interaction process observer required exact-child termination"
            : "the zero-interaction process observer exited without unregistering cleanly"
          : "the exact owned process observer child survived bounded cleanup",
      );
    }
    try {
      await this.drainOutput();
    } catch {
      throw new HarnessFailure(
        "E2E_PROCESS_OBSERVER_FAILED",
        "the zero-interaction process observer output did not drain cleanly",
      );
    }
    return this.snapshot();
  }

  private async drainOutput(): Promise<void> {
    await withTimeout(
      this.outputClosed,
      2_000,
      "observer-output-close-timeout",
    );
    this.lines.removeAllListeners();
  }
}

function parseProcessEvent(line: string): ProcessStartEvent | undefined {
  const match =
    /^EVENT\|(claude\.exe|codex\.exe|electron\.exe)\|(\d+)\|(\d+)\|(catalog|preflight|runtime|unclassified)$/iu.exec(
      line,
    );
  if (match === null) return undefined;
  const name = match[1]!.toLocaleLowerCase("en-US") as ProcessStartEvent["name"];
  return Object.freeze({
    name,
    pid: Number.parseInt(match[2]!, 10),
    parentPid: Number.parseInt(match[3]!, 10),
    role: match[4]!.toLocaleLowerCase("en-US") as NonNullable<
      ProcessStartEvent["role"]
    >,
  });
}

function runtimeStartCountsByApplication(
  events: readonly ProcessStartEvent[],
  applicationPid: number,
): RuntimeStartCounts {
  const ownership = classifyObservedProcesses(events, applicationPid);
  const count = (name: "claude.exe" | "codex.exe") =>
    new Set(
      events
        .filter(
          (event) =>
            event.name === name && ownership.ownedPids.has(event.pid),
        )
        .map((event) => event.pid),
    ).size;
  const codex = count("codex.exe");
  const claude = count("claude.exe");
  const countClaudeRole = (role: NonNullable<ProcessStartEvent["role"]>) =>
    new Set(
      events
        .filter(
          (event) =>
            event.name === "claude.exe" &&
            ownership.ownedPids.has(event.pid) &&
            event.role === role,
        )
        .map((event) => event.pid),
    ).size;
  return Object.freeze({
    codex,
    claude,
    claudeCatalog: countClaudeRole("catalog"),
    claudePreflight: countClaudeRole("preflight"),
    claudeUnclassified: countClaudeRole("unclassified"),
    total: codex + claude,
  });
}

function processDescriptors(
  events: readonly ProcessStartEvent[],
  pids: ReadonlySet<number>,
  applicationPid: number,
): readonly ProcessDescriptor[] {
  const names = new Map<number, ProcessDescriptor["name"]>();
  if (applicationPid > 0) names.set(applicationPid, "electron.exe");
  for (const event of events) names.set(event.pid, event.name);
  return Object.freeze(
    [...pids]
      .filter((pid) => pid > 0)
      .sort((left, right) => left - right)
      .map((pid) => {
        const name = names.get(pid);
        if (name === undefined) {
          throw new HarnessFailure(
            "E2E_HARNESS_INTERNAL_FAILED",
            `owned process pid=${pid} had no observed process name`,
          );
        }
        return Object.freeze({ name, pid });
      }),
  );
}

function recordProcessWindow(
  phase: ProcessWindowDiagnostic["phase"],
  events: readonly ProcessStartEvent[],
  ownership: ProcessOwnership,
  applicationPid: number,
): void {
  const owned = processDescriptors(events, ownership.ownedPids, applicationPid);
  const foreign = processDescriptors(events, ownership.foreignPids, applicationPid);
  processWindowDiagnostics.push(Object.freeze({ phase, owned, foreign }));
  console.log(
    `E2E_FOREIGN_PROCESSES ${phase} ${
      foreign.length === 0
        ? "none"
        : foreign
            .map((process) => `${process.name}(pid=${process.pid})`)
            .join(",")
    }`,
  );
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
}

async function waitForExactOwnedChildExit(
  child: ChildProcess,
  ownedPid: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (ownedPid === undefined || ownedPid <= 0 || child.pid !== ownedPid) {
    return false;
  }
  const exitObserved =
    child.exitCode !== null ||
    child.signalCode !== null ||
    (await withTimeout(
      waitForChildExit(child),
      timeoutMs,
      "exact-owned-child-exit-timeout",
    )
      .then(() => true)
      .catch(() => false));
  return exitObserved && !isProcessAlive(ownedPid);
}

function isExactOwnedChildAlive(
  child: ChildProcess,
  ownedPid: number | undefined,
): boolean {
  return (
    ownedPid !== undefined &&
    ownedPid > 0 &&
    child.pid === ownedPid &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

async function terminateExactOwnedChild(
  child: ChildProcess,
  ownedPid: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (isExactOwnedChildAlive(child, ownedPid)) {
    child.kill();
  }
  return waitForExactOwnedChildExit(child, ownedPid, timeoutMs);
}

async function assertProcessesExited(
  processes: readonly ProcessDescriptor[],
): Promise<void> {
  const unique = [
    ...new Map(
      processes
        .filter((process) => process.pid > 0)
        .map((process) => [process.pid, process]),
    ).values(),
  ];
  const deadline = Date.now() + 5_000;
  while (
    unique.some((process) => isProcessAlive(process.pid)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const surviving = unique.filter((process) => isProcessAlive(process.pid));
  if (surviving.length > 0) {
    throw new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      `owned processes survived application close: ${surviving
        .map((process) => `${process.name}(pid=${process.pid})`)
        .join(",")}`,
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function summarizeCatalog(catalog: CatalogObservation): Readonly<{
  runtime: RuntimeFamily;
  runtimeFamilyLabel: string;
  endpointLabel: string;
  modelCount: number;
  models: readonly Readonly<{
    label: string;
    runtimeControlLabel: string | null;
    controlLabel: string;
    controlLabelProvenance: NormalizedModel["controlLabelProvenance"];
    intensityTickLabels: readonly string[];
  }>[];
  protocol: CatalogObservation["protocol"];
}> {
  return Object.freeze({
    runtime: catalog.runtime,
    runtimeFamilyLabel: catalog.runtimeFamilyLabel,
    endpointLabel: catalog.endpointLabel,
    modelCount: catalog.models.length,
    models: Object.freeze(
      catalog.models.map((model) =>
        Object.freeze({
          label: model.label,
          runtimeControlLabel: model.runtimeControlLabel,
          controlLabel: model.controlLabel,
          controlLabelProvenance: model.controlLabelProvenance,
          intensityTickLabels: Object.freeze([...model.intensityTickLabels]),
        }),
      ),
    ),
    protocol: catalog.protocol,
  });
}

function isZeroRuntimeStarts(counts: RuntimeStartCounts): boolean {
  return (
    counts.codex === 0 &&
    counts.claude === 0 &&
    counts.claudeCatalog === 0 &&
    counts.claudePreflight === 0 &&
    counts.claudeUnclassified === 0 &&
    counts.total === 0
  );
}

function isSingleCatalogLoadingChildRound(counts: RuntimeStartCounts): boolean {
  return (
    counts.codex === 1 &&
    counts.claude === 2 &&
    counts.claudeCatalog === 1 &&
    counts.claudePreflight + counts.claudeUnclassified === 1 &&
    counts.total === 3
  );
}

function runtimeStartDelta(
  after: RuntimeStartCounts,
  before: RuntimeStartCounts,
): RuntimeStartCounts {
  const delta = {
    codex: after.codex - before.codex,
    claude: after.claude - before.claude,
    claudeCatalog: after.claudeCatalog - before.claudeCatalog,
    claudePreflight: after.claudePreflight - before.claudePreflight,
    claudeUnclassified: after.claudeUnclassified - before.claudeUnclassified,
    total: after.total - before.total,
  };
  if (Object.values(delta).some((value) => value < 0)) {
    throw new HarnessFailure(
      "E2E_PROCESS_OBSERVER_FAILED",
      "the owned Runtime process-start counters moved backwards",
    );
  }
  return Object.freeze(delta);
}

function formatRuntimeStarts(counts: RuntimeStartCounts): string {
  return `codex=${counts.codex},claude=${counts.claude}(catalog=${counts.claudeCatalog},preflight=${counts.claudePreflight},unclassified=${counts.claudeUnclassified}),total=${counts.total}`;
}

function assertPrivacySafeSummary(summary: Record<string, unknown>): void {
  const strings = collectSummaryStrings(summary);
  const rootNeedles = [
    temporaryRoot,
    temporaryRoot.replaceAll("\\", "/"),
    encodeURI(temporaryRoot),
    encodeURI(temporaryRoot.replaceAll("\\", "/")),
  ].map((value) => value.toLocaleLowerCase("en-US"));
  const unsafe = strings.some((value) => {
    const lowered = value.toLocaleLowerCase("en-US");
    return (
      rootNeedles.some((needle) => lowered.includes(needle)) ||
      /(?:^|[\s(=:[{"'])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|mnt|private|root|tmp|users|var)\/)/iu.test(
        value,
      ) ||
      /\b(?:auth|authentication|authorization|credential|credentials)\b/iu.test(
        value,
      ) ||
      /(?:Bearer\s+\S+|-----BEGIN [A-Z ]+-----|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+)/iu.test(
        value,
      )
    );
  });
  if (unsafe) {
    throw new HarnessFailure(
      "E2E_SUMMARY_PRIVACY_FAILED",
      "the deterministic summary contained a forbidden private value",
    );
  }
}

function collectSummaryStrings(value: unknown): readonly string[] {
  if (typeof value === "string") return Object.freeze([value]);
  if (Array.isArray(value)) {
    return Object.freeze(value.flatMap((entry) => collectSummaryStrings(entry)));
  }
  if (typeof value !== "object" || value === null) return Object.freeze([]);
  return Object.freeze(
    Object.values(value).flatMap((entry) => collectSummaryStrings(entry)),
  );
}

function productFindings(
  items: readonly ItemResult[],
  observedAccessText: string,
): readonly ProductFinding[] {
  const findings: ProductFinding[] = [];
  if (items.find((item) => item.item === "4")?.status === "not-settled") {
    findings.push(
      Object.freeze({
        id: "E2E-F1",
        severity: "medium" as const,
        summary:
          "Project observation or composer focus was not inert, or opening the endpoint picker did not inspect each Runtime exactly once.",
        source:
          "empty-project specification: observation and composer focus are inert, and opening the endpoint picker inspects each Runtime exactly once",
      }),
    );
  }
  if (
    items.find((item) => item.item === "9")?.status === "not-settled" &&
    observedAccessText !== "Full access" &&
    observedAccessText !== "not-observed"
  ) {
    findings.push(
      Object.freeze({
        id: "E2E-F2",
        severity: "low" as const,
        summary: `Access Mode renders as ${observedAccessText} instead of Full access.`,
        source: "src/workbench-shell/renderer/composer.tsx",
      }),
    );
  }
  return Object.freeze(findings);
}

function equalWindowsPath(left: string, right: string): boolean {
  return (
    resolve(left).toLocaleLowerCase("en-US") ===
    resolve(right).toLocaleLowerCase("en-US")
  );
}

async function removeOwnedTemporaryRoot(directory: string): Promise<void> {
  const rootStat = await lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      "the isolated root is not an owned directory",
    );
  }
  const resolvedRoot = await realpath(directory);
  const resolvedTemporaryDirectory = await realpath(tmpdir());
  if (
    resolve(dirname(resolvedRoot)) !== resolve(resolvedTemporaryDirectory) ||
    !temporaryRootPattern.test(basename(resolvedRoot))
  ) {
    throw new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      "the isolated root failed its cleanup ownership guard",
    );
  }
  await rm(resolvedRoot, { recursive: true, force: false, maxRetries: 2 });
}

function safeFailure(error: unknown): HarnessFailure {
  if (error instanceof HarnessFailure) return error;
  if (error instanceof AggregateError) {
    const failures = error.errors.map((failure) => safeFailure(failure));
    return new HarnessFailure(
      "E2E_CLEANUP_FAILED",
      `preserved primary and cleanup failures: ${failures
        .map((failure) => `${failure.code} ${failure.safeMessage}`)
        .join(";")}`,
    );
  }
  return new HarnessFailure(
    "E2E_HARNESS_INTERNAL_FAILED",
    "internal step=main-orchestration failed",
  );
}

async function runInternalStep<T>(
  step: HarnessInternalStep,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HarnessFailure || error instanceof AggregateError) {
      throw error;
    }
    throw new HarnessFailure(
      "E2E_HARNESS_INTERNAL_FAILED",
      `internal step=${step} failed; ${classifyInternalFailure(error)}`,
    );
  }
}

function classifyInternalFailure(error: unknown): string {
  if (!(error instanceof Error)) return "cause=non-error";
  const message = error.message;
  const category = message.includes("strict mode violation")
    ? "locator-strict-mode"
    : message.includes("Target page, context or browser has been closed")
      ? "target-closed"
      : message.includes("Execution context was destroyed")
        ? "execution-context-destroyed"
        : message.includes("Cannot read properties")
          ? "unexpected-undefined"
          : error.name === "AssertionError"
            ? "assertion"
            : error.name === "TimeoutError"
              ? "timeout"
              : "unclassified";
  const frame = error.stack?.match(/electron-e2e\.ts:(\d+):(\d+)/u);
  return `cause=${error.name}/${category}${
    frame === null || frame === undefined
      ? ""
      : `@${frame[1]}:${frame[2]}`
  }`;
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(label)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectValue(error);
      },
    );
  });
}

await main();
await runF169PackagedCopy();
