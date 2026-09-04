import type { Locator, Page } from "playwright";

import type {
  RuntimeCatalog,
  RuntimeModel,
} from "../../../src/agent-runtime/index.ts";
import { HarnessFailure } from "./harness-failure.ts";
import { result, type ItemResult } from "./result.ts";

export type NormalizedModel = Readonly<{
  id: string;
  resolvedModel: string;
  label: string;
  labelSource:
    | "owner-product-name"
    | "runtime-catalog"
    | "raw-resolved-identity";
  displayName: string | null;
  runtimeControlLabel: string | null;
  controlLabel: string;
  controlLabelProvenance: "runtime" | "workbench-fallback";
  intensityValues: readonly string[];
  intensityTickLabels: readonly string[];
  intensityDescriptions: readonly (string | null)[];
  fixedIntensity: boolean;
}>;

export type RuntimeFamily = "codex" | "claude";

export type CatalogObservation = Readonly<{
  runtime: RuntimeFamily;
  runtimeFamilyLabel: string;
  endpointLabel: string;
  catalog: RuntimeCatalog;
  models: readonly NormalizedModel[];
  protocol:
    | Readonly<{
        kind: "codex-model-list";
        modelListRequests: number;
        zeroTurns: true;
      }>
    | Readonly<{
        kind: "claude-initialize";
        initializeControlRequests: number;
        outboundFrames: number;
        userFrames: number;
        assistantFrames: number;
        resultFrames: number;
        zeroTurns: true;
      }>;
}>;

export type RenderedEndpointObservation = Readonly<{
  ordinal: number;
  runtimeFamilyLabel: string;
  endpointLabel: string;
  displayLabel: string;
  initiallySelected: boolean;
}>;

const fallbackControlDisclosure =
  "Work Intensity is the Workbench’s own heading; the runtime supplied no control label.";
export const item8Assertion =
  "Both rendered Runtime endpoints preserve the live catalog after displaying and deduplicating models by resolvedModel; Claude has the owner's four product-name rows with no Default alias and an unnamed identity falls back to its raw resolved identity; model rows contain names only; selectable intensity ticks remain native for both Runtimes without the superseded rename-layer caption; fallback control labels disclose their Workbench provenance; and vendor hue is paired with exact text.";
export const item9Assertion =
  "Exactly two independently discovered Runtime endpoints render as separate profile pickers; switching endpoints and resolved models replaces model and intensity state without stale values, while the build-fixed Execution and Access chips remain non-interactive and unchanged.";
const nativeIntensityOrder = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const claudeModelDisplayLabels: Readonly<Record<string, string>> = Object.freeze({
  "claude-opus-5[1m]": "Opus 5",
  "claude-fable-5": "Fable 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
});
const runtimeColors = Object.freeze({
  codex: "rgb(34, 211, 255)",
  claude: "rgb(255, 154, 60)",
} satisfies Readonly<Record<RuntimeFamily, string>>);

type CatalogModelSelection = Readonly<{
  endpointIndex: number;
  modelIndex: number;
}>;

type ProfileControlKind = "endpoint" | "model" | "intensity" | "exec" | "access";
type InteractiveProfileControlKind = "endpoint" | "model" | "intensity";

type ProfileChipSnapshot = Readonly<{
  endpoint: string;
  model: string;
  intensity: string;
  execution: string;
  access: string;
}>;

type PickerRuleMeasurements = {
  modelPickerInspections: number;
  designModelRowsNamesOnly: boolean;
  modelRowsWithoutIntensityText: boolean;
  claudeFourRowsWithoutDefault: boolean;
  claudeModelPickerInspected: boolean;
  selectableIntensityInspections: number;
  nativeIntensityTicksVerbatim: boolean;
  nativeTickMismatches: string[];
  designFailures: string[];
};

export function normalizeModels(
  runtime: RuntimeFamily,
  models: readonly RuntimeModel[],
  resolvedModelsById: ReadonlyMap<string, string> = new Map(),
): readonly NormalizedModel[] {
  const seenResolvedModels = new Set<string>();
  const normalized: NormalizedModel[] = [];
  for (const model of models) {
    const resolvedModel =
      runtime === "claude" ? resolvedModelsById.get(model.id) : model.id;
    if (resolvedModel === undefined || resolvedModel.length === 0) {
      throw new HarnessFailure(
        "E2E_HEADLESS_CATALOG_FAILED",
        "a Runtime catalog model did not supply a resolvedModel or native-value fallback",
      );
    }
    if (seenResolvedModels.has(resolvedModel)) continue;
    seenResolvedModels.add(resolvedModel);
    normalized.push(normalizeModel(runtime, model, resolvedModel));
  }
  return Object.freeze(normalized);
}

function normalizeModel(
  runtime: RuntimeFamily,
  model: RuntimeModel,
  resolvedModel: string,
): NormalizedModel {
  const fixedIntensity =
    model.effortLevels.length === 1 && model.effortLevels[0] === "default";
  const intensityTickLabels = fixedIntensity
    ? [model.effortLevelLabels?.[0] ?? model.effortLevels[0]!]
    : [...model.effortLevels];
  const intensityDescriptions = model.effortLevels.map((value, index) => {
    const runtimeLabel = model.effortLevelLabels?.[index];
    const normalizedRuntimeLabel =
      runtimeLabel === undefined || runtimeLabel === null
        ? ""
        : compactText(runtimeLabel);
    return normalizedRuntimeLabel.length === 0 || normalizedRuntimeLabel === value
      ? null
      : normalizedRuntimeLabel;
  });
  const runtimeControlLabel =
    typeof model.workIntensityLabel === "string"
      ? model.workIntensityLabel
      : null;
  const displayName =
    typeof model.displayName === "string" && model.displayName.length > 0
      ? model.displayName
      : null;
  const ownerProductName =
    runtime === "claude" ? claudeModelDisplayLabels[resolvedModel] : undefined;
  const label =
    runtime === "claude"
      ? (ownerProductName ?? resolvedModel)
      : (displayName ?? resolvedModel);
  const labelSource =
    ownerProductName !== undefined
      ? ("owner-product-name" as const)
      : runtime === "codex" && displayName !== null
        ? ("runtime-catalog" as const)
        : ("raw-resolved-identity" as const);
  return Object.freeze({
    id: model.id,
    resolvedModel,
    label,
    labelSource,
    displayName,
    runtimeControlLabel,
    controlLabel: runtimeControlLabel ?? "Work Intensity",
    controlLabelProvenance:
      runtimeControlLabel === null
        ? ("workbench-fallback" as const)
        : ("runtime" as const),
    intensityValues: Object.freeze([...model.effortLevels]),
    intensityTickLabels: Object.freeze(intensityTickLabels),
    intensityDescriptions: Object.freeze(intensityDescriptions),
    fixedIntensity,
  });
}

export async function inspectRenderedCatalogs(
  page: Page,
  catalogs: readonly CatalogObservation[],
): Promise<{
  readonly item8: ItemResult;
  readonly item9: ItemResult;
  readonly endpoints: readonly RenderedEndpointObservation[];
  readonly observedAccessText: string;
}> {
  if (
    catalogs.length !== 2 ||
    catalogs[0]?.runtime !== "codex" ||
    catalogs[1]?.runtime !== "claude"
  ) {
    throw new HarnessFailure(
      "E2E_HARNESS_INTERNAL_FAILED",
      "the independent Runtime catalogs were not supplied in fixed Codex then Claude order",
    );
  }

  const measurements: PickerRuleMeasurements = {
    modelPickerInspections: 0,
    designModelRowsNamesOnly: true,
    modelRowsWithoutIntensityText: true,
    claudeFourRowsWithoutDefault: true,
    claudeModelPickerInspected: false,
    selectableIntensityInspections: 0,
    nativeIntensityTicksVerbatim: true,
    nativeTickMismatches: [],
    designFailures: [],
  };
  const expectedModelPickerInspections = catalogs.reduce(
    (count, catalog) => count + catalog.models.length,
    0,
  );
  const expectedSelectableIntensityInspections = catalogs.reduce(
    (count, catalog) =>
      count + catalog.models.filter((model) => !model.fixedIntensity).length,
    0,
  );
  const item8Failures: string[] = [];
  let endpoints: readonly RenderedEndpointObservation[] = Object.freeze([]);
  try {
    endpoints = await inspectRenderedEndpoints(page, catalogs);
  } catch (error) {
    if (!isCatalogAssertionFailure(error)) throw error;
    item8Failures.push(error.safeMessage);
    await closeProfilePickerIfOpen(page);
  }
  for (const [endpointIndex, catalog] of catalogs.entries()) {
    for (const modelIndex of catalog.models.keys()) {
      try {
        await selectRenderedCatalogModel(page, catalogs, {
          endpointIndex,
          modelIndex,
        }, measurements);
      } catch (error) {
        if (!isCatalogAssertionFailure(error)) throw error;
        item8Failures.push(error.safeMessage);
        await closeProfilePickerIfOpen(page);
      }
    }
  }

  const claude = catalogs[1]!;
  const unnamedClaudeProbeResolvedModel = "claude-owner-unnamed-model-probe";
  const unnamedClaudeProbe = normalizeModel(
    "claude",
    {
      id: "future-alias",
      displayName: "Unruled catalog display name",
      effortLevels: ["low"],
    },
    unnamedClaudeProbeResolvedModel,
  );
  const unnamedIdentityFallbackContractExact =
    unnamedClaudeProbe.label === unnamedClaudeProbeResolvedModel &&
    unnamedClaudeProbe.labelSource === "raw-resolved-identity";
  const liveUnnamedClaudeModels = claude.models.filter(
    (model) => model.labelSource === "raw-resolved-identity",
  );
  const liveUnnamedIdentityFallbacksExact = liveUnnamedClaudeModels.every(
    (model) => model.label === model.resolvedModel,
  );
  if (
    !unnamedIdentityFallbackContractExact ||
    !liveUnnamedIdentityFallbacksExact
  ) {
    item8Failures.push(
      `item-8 unnamed-identity-fallback contract=${unnamedIdentityFallbackContractExact} live=${liveUnnamedIdentityFallbacksExact}`,
    );
  }
  item8Failures.push(...measurements.designFailures);
  const modelRowsWithoutIntensityText =
    measurements.modelPickerInspections === expectedModelPickerInspections &&
    measurements.modelRowsWithoutIntensityText;
  const claudeFourRowsWithoutDefault =
    measurements.claudeModelPickerInspected &&
    measurements.claudeFourRowsWithoutDefault;
  const nativeIntensityTicksVerbatim =
    measurements.selectableIntensityInspections ===
      expectedSelectableIntensityInspections &&
    measurements.nativeIntensityTicksVerbatim;
  const workOrderRuleDetail =
    `work-order rule observations: claude-four-deduplicated-no-default=${claudeFourRowsWithoutDefault};` +
    `model-rows-without-intensity-text=${modelRowsWithoutIntensityText};native-effortLevels-as-ticks=${nativeIntensityTicksVerbatim};` +
    `inspected-model-pickers=${measurements.modelPickerInspections}/${expectedModelPickerInspections};` +
    `inspected-selectable-intensities=${measurements.selectableIntensityInspections}/${expectedSelectableIntensityInspections};` +
    `unnamed-identity-fallback-contract=${unnamedIdentityFallbackContractExact};` +
    `live-unnamed-claude-identities=${liveUnnamedClaudeModels.length};` +
    `live-unnamed-fallbacks-exact=${liveUnnamedIdentityFallbacksExact}` +
    (measurements.nativeTickMismatches.length === 0
      ? ""
      : `;native-tick-mismatches=${measurements.nativeTickMismatches.join(",")}`);
  const uniqueItem8Failures = Object.freeze([...new Set(item8Failures)]);
  const item8 = result(
    "8",
    uniqueItem8Failures.length === 0 ? "settled" : "not-settled",
    item8Assertion,
    uniqueItem8Failures.length === 0
      ? `Design-exact endpoint, model, intensity, provenance, and vendor-colour assertions matched; Claude raw-to-unique identity count=${claude.catalog.models.length}→${claude.models.length}. ${workOrderRuleDetail}`
      : `design assertion failures: ${uniqueItem8Failures.join(";")} | ${workOrderRuleDetail}`,
  );

  let item9Phase = "select-first-endpoint";
  try {
    await selectRenderedEndpoint(page, catalogs, 0);
    item9Phase = "read-first-model-identities";
    const firstEndpointModels = await readRenderedModelLabels(page);
    const firstReset = await readProfileChipSnapshot(page);
    item9Phase = "read-first-reset-intensity";
    const firstResetIntensityTicks = await readRenderedIntensityTickLabels(page);
    const firstResetExact =
      firstReset.endpoint === catalogs[0]!.runtimeFamilyLabel &&
      firstReset.model === firstEndpointModels[0] &&
      firstReset.intensity === firstResetIntensityTicks[0];

    const lastFirstModelIndex = catalogs[0]!.models.length - 1;
    item9Phase = "select-last-first-endpoint-model";
    const selectedLastFirstModel = await selectRenderedModelByIndex(
      page,
      lastFirstModelIndex,
    );
    item9Phase = "read-last-first-endpoint-intensity";
    const lastFirstIntensityTicks = await readRenderedIntensityTickLabels(page);
    item9Phase = "select-last-first-endpoint-intensity";
    const selectedLastFirstIntensity = await selectRenderedIntensityByIndex(
      page,
      Math.max(0, lastFirstIntensityTicks.length - 1),
    );
    const staleCandidate = await readProfileChipSnapshot(page);
    const lastFirstSelectionExact =
      selectedLastFirstModel === firstEndpointModels[lastFirstModelIndex] &&
      selectedLastFirstIntensity ===
        lastFirstIntensityTicks[lastFirstIntensityTicks.length - 1] &&
      staleCandidate.model === selectedLastFirstModel &&
      staleCandidate.intensity === selectedLastFirstIntensity;

    item9Phase = "select-second-endpoint";
    await selectRenderedEndpoint(page, catalogs, 1);
    item9Phase = "read-second-model-identities";
    const secondEndpointModels = await readRenderedModelLabels(page);
    const secondReset = await readProfileChipSnapshot(page);
    item9Phase = "read-second-reset-intensity";
    const secondResetIntensityTicks = await readRenderedIntensityTickLabels(page);
    const secondResetExact =
      secondReset.endpoint === claude.runtimeFamilyLabel &&
      secondReset.model === secondEndpointModels[0] &&
      secondReset.intensity === secondResetIntensityTicks[0] &&
      (secondReset.model !== staleCandidate.model ||
        secondReset.intensity !== staleCandidate.intensity);
    const modelReplacementExact =
      modelRowsMatchExpectedLabels(
        firstEndpointModels,
        catalogs[0]!.models,
      ) &&
      modelRowsMatchExpectedLabels(
        secondEndpointModels,
        claude.models,
      ) &&
      !arraysEqual(firstEndpointModels, secondEndpointModels);

    const beforeModes = await readProfileChipSnapshot(page);
    item9Phase = "inspect-fixed-modes";
    const fixedModes = await inspectFixedModeChips(page);
    const afterModes = await readProfileChipSnapshot(page);
    const modeSelectionUnchangedExact =
      afterModes.execution === beforeModes.execution &&
      afterModes.access === beforeModes.access &&
      afterModes.endpoint === beforeModes.endpoint &&
      afterModes.model === beforeModes.model &&
      afterModes.intensity === beforeModes.intensity;
    const fixedModesStayExact = [
      firstReset,
      staleCandidate,
      secondReset,
      beforeModes,
      afterModes,
    ].every(
      (snapshot) =>
        snapshot.execution === "Single agent" &&
        snapshot.access === "Full access",
    );
    const profileModesExact =
      fixedModesStayExact &&
      modeSelectionUnchangedExact &&
      fixedModes.exact;
    const item9Exact =
      firstResetExact &&
      lastFirstSelectionExact &&
      secondResetExact &&
      modelReplacementExact &&
      profileModesExact;
    const item9 = result(
      "9",
      item9Exact ? "settled" : "not-settled",
      item9Assertion,
      item9Exact
        ? "endpoint switches reset to the selected endpoint's first rendered catalog identity and intensity, selecting the last model and intensity updates both chips, both catalog identity lists replace exactly, and the fixed non-interactive Execution and Access chips leave the catalog selection unchanged"
        : `failed checks: first-reset=${firstResetExact};last-first-selection=${lastFirstSelectionExact};second-reset=${secondResetExact};model-replacement=${modelReplacementExact};fixed-modes=${profileModesExact};fixed-modes-stay-exact=${fixedModesStayExact};mode-selection-unchanged=${modeSelectionUnchangedExact};${fixedModes.detail}`,
    );
    return Object.freeze({
      endpoints,
      item8,
      item9,
      observedAccessText: afterModes.access,
    });
  } catch (error) {
    if (!isCatalogAssertionFailure(error)) throw error;
    return Object.freeze({
      endpoints,
      item8,
      item9: result(
        "9",
        "not-settled",
        item9Assertion,
        `phase=${item9Phase};${error.safeMessage}`,
      ),
      observedAccessText: "not-observed",
    });
  }
}

async function readRenderedModelLabels(page: Page): Promise<readonly string[]> {
  const popover = await openProfilePicker(page, "model");
  const labels = await runCatalogUiExpectation(
    "item-9 model identities were unavailable",
    async () =>
      (await popover.locator(".picker-list > .opt .opt-label").allTextContents()).map(
        (value) => value.trim(),
      ),
  );
  await closeProfilePicker(page);
  return Object.freeze(labels);
}

async function selectRenderedModelByIndex(
  page: Page,
  modelIndex: number,
): Promise<string> {
  const popover = await openProfilePicker(page, "model");
  const option = popover.locator(".picker-list > .opt").nth(modelIndex);
  const expected =
    ((await option.locator(".opt-label").textContent()) ?? "").trim();
  await runCatalogUiExpectation(
    `item-9 model-selection row=${modelIndex + 1} was unavailable`,
    () => option.click(),
  );
  await waitForProfilePickerClosed(page);
  await runCatalogUiExpectation(
    `item-9 model-selection row=${modelIndex + 1} did not update`,
    () => waitForProfileChipValue(page, "model", expected, 5_000),
  );
  return expected;
}

async function readRenderedIntensityTickLabels(
  page: Page,
): Promise<readonly string[]> {
  const popover = await openProfilePicker(page, "intensity");
  const ticks = (
    await popover.locator(".islider-ticks span").allTextContents()
  ).map((value) => value.trim());
  if (ticks.length > 0) {
    await closeProfilePicker(page);
    return Object.freeze(ticks);
  }
  const fixed = compactText((await popover.locator(".fixed-row").textContent()) ?? "")
    .replace(/^🔒\s*/u, "");
  await closeProfilePicker(page);
  return Object.freeze(fixed.length === 0 ? [] : [fixed]);
}

async function selectRenderedIntensityByIndex(
  page: Page,
  intensityIndex: number,
): Promise<string> {
  const popover = await openProfilePicker(page, "intensity");
  const ticks = (
    await popover.locator(".islider-ticks span").allTextContents()
  ).map((value) => value.trim());
  if (ticks.length === 0) {
    const fixed = compactText(
      (await popover.locator(".fixed-row").textContent()) ?? "",
    ).replace(/^🔒\s*/u, "");
    await closeProfilePicker(page);
    return fixed;
  }
  const expected = ticks[intensityIndex];
  if (expected === undefined) {
    await closeProfilePicker(page);
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `item-9 intensity-selection row=${intensityIndex + 1} was outside the rendered scale`,
    );
  }
  await chooseOpenSliderIndex(page, intensityIndex, ticks.length);
  await runCatalogUiExpectation(
    `item-9 intensity-selection row=${intensityIndex + 1} did not update`,
    () => waitForProfileChipValue(page, "intensity", expected, 5_000),
  );
  await closeProfilePicker(page);
  return expected;
}

function modelRowsMatchExpectedLabels(
  observed: readonly string[],
  expected: readonly NormalizedModel[],
): boolean {
  return (
    observed.length === expected.length &&
    observed.every((value, index) => value === expected[index]?.label)
  );
}

async function inspectRenderedEndpoints(
  page: Page,
  catalogs: readonly CatalogObservation[],
): Promise<readonly RenderedEndpointObservation[]> {
  const popover = await openProfilePicker(page, "endpoint");
  const options = popover.locator(".picker-list > .opt.opt-endpoint");
  const observedCount = await options.count();
  const heading = await runCatalogUiExpectation(
    "item-8 endpoint heading was unavailable",
    async () =>
      compactText(
        ((await popover.locator(".picker-col-head").textContent()) ?? "").replace(
          "ⓦ",
          "",
        ),
      ),
  );
  const countLabel = await runCatalogUiExpectation(
    "item-8 endpoint count was unavailable",
    async () =>
      (await popover.locator(".picker-col-head .n").textContent())?.trim() ?? "",
  );
  const observations: RenderedEndpointObservation[] = [];
  const failures: string[] = [];
  if (heading !== `Endpoint ${catalogs.length}` || countLabel !== `${catalogs.length}`) {
    failures.push(
      `heading expected=${JSON.stringify(`Endpoint ${catalogs.length}`)} observed=${JSON.stringify(heading)}`,
    );
  }
  if (observedCount !== catalogs.length) {
    failures.push(
      `endpoint-count expected=${catalogs.length} observed=${observedCount}`,
    );
  }
  for (const [index, catalog] of catalogs.entries()) {
    if (index >= observedCount) {
      failures.push(`endpoint-row=${index + 1} missing=true`);
      continue;
    }
    const option = options.nth(index);
    const row = await runCatalogUiExpectation(
      `item-8 endpoint row=${index + 1} was incomplete`,
      async () => {
        const label = option.locator(".opt-label");
        const dot = option.locator(".rt-dot");
        return Object.freeze({
          runtimeFamilyLabel: ((await label.textContent()) ?? "").trim(),
          endpointLabel:
            ((await option.locator(".opt-sub").textContent()) ?? "").trim(),
          initiallySelected:
            (await option.getAttribute("aria-selected")) === "true",
          labelColor: await label.evaluate(
            (element) => getComputedStyle(element).color,
          ),
          dotColor: await dot.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          ),
          labelVisible: await label.isVisible(),
        });
      },
    );
    const colorExact =
      row.labelColor === runtimeColors[catalog.runtime] &&
      row.dotColor === runtimeColors[catalog.runtime];
    const textPairedWithHue =
      row.labelVisible && row.runtimeFamilyLabel === catalog.runtimeFamilyLabel;
    observations.push(
      Object.freeze({
        ordinal: index + 1,
        runtimeFamilyLabel: row.runtimeFamilyLabel,
        endpointLabel: row.endpointLabel,
        displayLabel: row.runtimeFamilyLabel,
        initiallySelected: row.initiallySelected,
      }),
    );
    if (
      row.runtimeFamilyLabel !== catalog.runtimeFamilyLabel ||
      row.endpointLabel !== catalog.endpointLabel ||
      row.initiallySelected !== (index === 0) ||
      !colorExact ||
      !textPairedWithHue
    ) {
      failures.push(
        `endpoint-row=${index + 1} family=${row.runtimeFamilyLabel === catalog.runtimeFamilyLabel},expected-endpoint=${JSON.stringify(catalog.endpointLabel)},observed-endpoint=${JSON.stringify(row.endpointLabel)},selected=${row.initiallySelected === (index === 0)},vendor-colour=${colorExact},text-with-hue=${textPairedWithHue}`,
      );
    }
  }
  await closeProfilePicker(page);
  if (failures.length > 0) {
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `item-8 endpoint assertions failed: ${failures.join(";")}`,
    );
  }
  return Object.freeze(observations);
}

async function selectRenderedEndpoint(
  page: Page,
  catalogs: readonly CatalogObservation[],
  endpointIndex: number,
): Promise<void> {
  const catalog = catalogs[endpointIndex];
  if (catalog === undefined) {
    throw new HarnessFailure(
      "E2E_HARNESS_INTERNAL_FAILED",
      "a renderer endpoint selection did not resolve to an independent catalog",
    );
  }
  const popover = await openProfilePicker(page, "endpoint");
  const option = popover.locator(".picker-list > .opt.opt-endpoint").nth(endpointIndex);
  const alreadySelected =
    (await option.getAttribute("aria-selected")) === "true";
  if (alreadySelected) {
    await closeProfilePicker(page);
  } else {
    await runCatalogUiExpectation(
      `item-8-or-9 endpoint-selection row=${endpointIndex + 1} was unavailable`,
      () => option.click(),
    );
  }
  try {
    await waitForProfileChipValue(
      page,
      "endpoint",
      catalog.runtimeFamilyLabel,
      5_000,
    );
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    const observed = await profileChipValue(page, "endpoint");
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `item-8-or-9 endpoint-selection row=${endpointIndex + 1} expected=${JSON.stringify(catalog.runtimeFamilyLabel)} observed=${JSON.stringify(observed)}`,
    );
  }
  await waitForProfilePickerClosed(page);
}

export async function selectRenderedCatalogModel(
  page: Page,
  catalogs: readonly CatalogObservation[],
  selection: CatalogModelSelection,
  measurements?: PickerRuleMeasurements,
): Promise<Readonly<{ intensityTickLabels: readonly string[] }>> {
  await selectRenderedEndpoint(page, catalogs, selection.endpointIndex);
  const catalog = catalogs[selection.endpointIndex];
  if (catalog === undefined) {
    throw new HarnessFailure(
      "E2E_HARNESS_INTERNAL_FAILED",
      "a renderer model selection did not resolve to an independent catalog",
    );
  }
  const model = catalog.models[selection.modelIndex];
  if (model === undefined) {
    throw new HarnessFailure(
      "E2E_HARNESS_INTERNAL_FAILED",
      "a renderer model selection did not resolve to an independent catalog relation",
    );
  }
  await inspectRenderedModelPicker(page, catalog, measurements);
  await selectRenderedModel(page, model, selection.modelIndex, measurements);
  return inspectRenderedIntensity(page, catalog.runtime, model, measurements);
}

async function inspectRenderedModelPicker(
  page: Page,
  catalog: CatalogObservation,
  measurements?: PickerRuleMeasurements,
): Promise<readonly string[]> {
  const popover = await openProfilePicker(page, "model");
  const options = popover.locator(".picker-list > .opt");
  const observedCount = await options.count();
  const rows = await Promise.all(
    Array.from({ length: observedCount }, async (_unused, index) => {
      const option = options.nth(index);
      return runCatalogUiExpectation(
        `item-8 model row=${index + 1} was incomplete`,
        async () => {
          const secondary = option.locator(".opt-sub");
          const secondaryCount = await secondary.count();
          return Object.freeze({
            label: ((await option.locator(".opt-label").textContent()) ?? "").trim(),
            secondary:
              secondaryCount === 0
                ? ""
                : compactText((await secondary.first().textContent()) ?? ""),
            secondaryCount,
            text: compactText(await option.innerText()),
            color: await option
              .locator(".opt-label")
              .evaluate((element) => getComputedStyle(element).color),
          });
        },
      );
    }),
  );
  const observed = rows.map((row) => row.label);
  const expected = catalog.models.map((model) => model.label);
  const countLabel = await runCatalogUiExpectation(
    "item-8 model count was unavailable",
    async () =>
      (await popover.locator(".picker-col-head .n").textContent())?.trim() ?? "",
  );
  const heading = await runCatalogUiExpectation(
    "item-8 model heading was unavailable",
    async () =>
      compactText((await popover.locator(".picker-col-head").textContent()) ?? ""),
  );
  const modelRowsNamesOnly =
    rows.length === catalog.models.length &&
    rows.every((row, index) => {
      const model = catalog.models[index];
      if (model === undefined || row.label !== model.label) return false;
      return (
        row.secondaryCount === 0 &&
        row.secondary.length === 0 &&
        row.text === model.label
      );
    });
  const modelRowsWithoutIntensityText = rows.every((row, index) => {
    const model = catalog.models[index];
    if (model === undefined) return false;
    const normalizedRowText = row.text.toLocaleLowerCase("en-US");
    const intensityText = [
      ...model.intensityValues,
      ...model.intensityTickLabels,
      ...model.intensityDescriptions.filter(
        (value): value is string => typeof value === "string",
      ),
    ]
      .map((value) => compactText(value).toLocaleLowerCase("en-US"))
      .filter((value) => value.length > 0);
    return (
      !/\bintensit(?:y|ies)\b/iu.test(row.text) &&
      intensityText.every((value) => !normalizedRowText.includes(value))
    );
  });
  const defaultAliasAbsent =
    catalog.runtime !== "claude" ||
    !observed.includes("Default (recommended)");
  const claudeFourRowsWithoutDefault =
    catalog.runtime !== "claude" ||
    (catalog.models.length === 4 &&
      observedCount === 4 &&
      defaultAliasAbsent);
  if (measurements !== undefined) {
    measurements.modelPickerInspections += 1;
    measurements.designModelRowsNamesOnly &&= modelRowsNamesOnly;
    measurements.modelRowsWithoutIntensityText &&=
      modelRowsWithoutIntensityText;
    if (catalog.runtime === "claude") {
      measurements.claudeModelPickerInspected = true;
      measurements.claudeFourRowsWithoutDefault &&=
        claudeFourRowsWithoutDefault;
    }
  }
  const vendorColorsExact = rows.every(
    (row) => row.color === runtimeColors[catalog.runtime],
  );
  const exact =
    arraysEqual(observed, expected) &&
    heading === `Model ${expected.length}` &&
    countLabel === `${expected.length}` &&
    modelRowsNamesOnly &&
    vendorColorsExact &&
    claudeFourRowsWithoutDefault;
  await closeProfilePicker(page);
  if (!exact) {
    const safeMessage =
      `item-8 model-options runtime=${catalog.runtime} expected-design-labels=${JSON.stringify(expected)} observed=${JSON.stringify(observed)} row-text=${JSON.stringify(rows.map((row) => row.text))} secondary=${JSON.stringify(rows.map((row) => row.secondary))} heading=${JSON.stringify(heading)} names-only-rows=${modelRowsNamesOnly} no-intensity-text=${modelRowsWithoutIntensityText} vendor-colours=${vendorColorsExact} claude-four-no-default=${claudeFourRowsWithoutDefault}`;
    if (measurements === undefined) {
      throw new HarnessFailure("E2E_CATALOG_ASSERTION_FAILED", safeMessage);
    }
    measurements.designFailures.push(safeMessage);
  }
  return Object.freeze(observed);
}

async function selectRenderedModel(
  page: Page,
  model: NormalizedModel,
  modelIndex: number,
  measurements?: PickerRuleMeasurements,
): Promise<void> {
  const popover = await openProfilePicker(page, "model");
  const option = popover.locator(".picker-list > .opt").nth(modelIndex);
  const alreadySelected =
    (await option.getAttribute("aria-selected")) === "true";
  if (alreadySelected) {
    await closeProfilePicker(page);
  } else {
    await runCatalogUiExpectation(
      `item-8 model-selection row=${modelIndex + 1} was unavailable`,
      () => option.click(),
    );
  }
  if (measurements !== undefined) {
    await waitForProfilePickerClosed(page);
    const observed = await profileChipValue(page, "model");
    if (observed !== model.label) {
      measurements.designFailures.push(
        `item-8 model-selection row=${modelIndex + 1} expected-design-label=${JSON.stringify(model.label)} observed=${JSON.stringify(observed)}`,
      );
    }
    return;
  }
  try {
    await waitForProfileChipValue(page, "model", model.label, 5_000);
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    const observed = await profileChipValue(page, "model");
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `item-8 model-selection row=${modelIndex + 1} expected=${JSON.stringify(model.label)} observed=${JSON.stringify(observed)}`,
    );
  }
  await waitForProfilePickerClosed(page);
}

async function inspectRenderedIntensity(
  page: Page,
  runtime: RuntimeFamily,
  model: NormalizedModel,
  measurements?: PickerRuleMeasurements,
): Promise<Readonly<{ intensityTickLabels: readonly string[] }>> {
  if (model.intensityTickLabels.length === 0) {
    throw new HarnessFailure(
      "E2E_HEADLESS_CATALOG_FAILED",
      "a de-duplicated Runtime model offered no fixed or selectable intensity",
    );
  }
  if (!model.fixedIntensity && !nativeIntensityScaleIsOrdered(model.intensityValues)) {
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `item-8 native-intensity-order runtime=${runtime},model=${JSON.stringify(model.label)} expected-subsequence=${JSON.stringify(nativeIntensityOrder)} observed=${JSON.stringify(model.intensityValues)}`,
    );
  }
  const popover = await openProfilePicker(page, "intensity");
  const intensityShape = await runCatalogUiExpectation(
    `item-8 intensity controls runtime=${runtime} were incomplete`,
    async () => {
      const provenanceMarker = popover.locator(".picker-col-head .prov");
      const provenanceMarkerCount = await provenanceMarker.count();
      return Object.freeze({
        heading: compactText(
          ((await popover.locator(".picker-col-head").textContent()) ?? "").replace(
            "ⓦ",
            "",
          ),
        ),
        countLabel:
          (await popover.locator(".picker-col-head .n").textContent())?.trim() ??
          "",
        provenanceMarkerCount,
        provenanceMarkerTitle:
          provenanceMarkerCount === 0
            ? ""
            : ((await provenanceMarker.first().getAttribute("title")) ?? ""),
      });
    },
  );
  const provenanceMarkerExact =
    model.controlLabelProvenance === "workbench-fallback"
      ? intensityShape.provenanceMarkerCount === 1 &&
        intensityShape.provenanceMarkerTitle.includes("Workbench")
      : intensityShape.provenanceMarkerCount === 0;
  const headingExact =
    intensityShape.heading ===
      `${model.controlLabel} ${model.intensityTickLabels.length}` &&
    intensityShape.countLabel === `${model.intensityTickLabels.length}` &&
    provenanceMarkerExact;

  if (model.fixedIntensity) {
    const fixedShape = await runCatalogUiExpectation(
      `item-8 fixed-intensity controls runtime=${runtime} were incomplete`,
      async () =>
        Object.freeze({
          fixedLabel: compactText(
            (await popover.locator(".fixed-row").textContent()) ?? "",
          ).replace(/^🔒\s*/u, ""),
          note: compactText(
            (await popover.locator(".picker-note").textContent()) ?? "",
          ),
          sliderCount: await popover.locator(".islider").count(),
        }),
    );
    const fixedExact =
      headingExact &&
      fixedShape.fixedLabel === model.intensityTickLabels[0] &&
      fixedShape.sliderCount === 0 &&
      fixedShape.note ===
        "This model reports no intensity levels, so there is nothing to choose. That is the catalog as given, not a failure.";
    await closeProfilePicker(page);
    if (!fixedExact) {
      throw new HarnessFailure(
        "E2E_CATALOG_ASSERTION_FAILED",
        `item-8 fixed-intensity expected=${JSON.stringify(model.intensityTickLabels[0])} observed=${JSON.stringify(fixedShape.fixedLabel)} heading=${headingExact} note=${JSON.stringify(fixedShape.note)}`,
      );
    }
    return Object.freeze({
      intensityTickLabels: Object.freeze([...model.intensityTickLabels]),
    });
  }

  const selectableShape = await runCatalogUiExpectation(
    `item-8 selectable-intensity controls runtime=${runtime} were incomplete`,
    async () =>
      Object.freeze({
        renderedLabels: (
          await popover.locator(".islider-ticks span").allTextContents()
        ).map((value) => value.trim()),
        note: compactText(
          (await popover.locator(".picker-note").textContent()) ?? "",
        ),
        stopCount: await popover.locator(".islider-stop").count(),
      }),
  );
  const fallbackDisclosureExact =
    model.controlLabelProvenance === "workbench-fallback"
      ? selectableShape.note === fallbackControlDisclosure
      : !selectableShape.note.includes("Workbench’s own heading") &&
        !selectableShape.note.includes("runtime supplied no control label");
  const nativeTicksVerbatim = arraysEqual(
    selectableShape.renderedLabels,
    model.intensityValues,
  );
  if (measurements !== undefined) {
    measurements.selectableIntensityInspections += 1;
    measurements.nativeIntensityTicksVerbatim &&= nativeTicksVerbatim;
    if (!nativeTicksVerbatim) {
      measurements.nativeTickMismatches.push(
        `${runtime}/${model.label}:expected-native=${JSON.stringify(model.intensityValues)}:observed=${JSON.stringify(selectableShape.renderedLabels)}`,
      );
    }
  }
  const staticExact =
    headingExact &&
    arraysEqual(selectableShape.renderedLabels, model.intensityTickLabels) &&
    selectableShape.stopCount === model.intensityTickLabels.length &&
    fallbackDisclosureExact;
  if (!staticExact) {
    await closeProfilePicker(page);
    const safeMessage =
      `item-8 intensity-shape runtime=${runtime},model=${JSON.stringify(model.label)} expected-design-ticks=${JSON.stringify(model.intensityTickLabels)} observed=${JSON.stringify(selectableShape.renderedLabels)} native-ticks-verbatim=${nativeTicksVerbatim} heading=${headingExact} fallback-disclosure=${fallbackDisclosureExact}`;
    if (measurements !== undefined) {
      measurements.designFailures.push(safeMessage);
      return Object.freeze({
        intensityTickLabels: Object.freeze([...selectableShape.renderedLabels]),
      });
    }
      throw new HarnessFailure(
        "E2E_CATALOG_ASSERTION_FAILED",
        safeMessage,
      );
  }

  for (const index of model.intensityTickLabels.keys()) {
    await chooseOpenSliderIndex(page, index, model.intensityTickLabels.length);
    const expectedLabel = model.intensityTickLabels[index]!;
    let currentUpdated = true;
    let chipUpdated = true;
    try {
      await page.waitForFunction(
        ({ currentSelector, expected }) =>
          document.querySelector(currentSelector)?.textContent?.trim() === expected,
        {
          currentSelector:
            '.composer .controlbar > .popover[role="dialog"]:not([hidden]) .islider-current',
          expected: expectedLabel,
        },
        { timeout: 5_000 },
      );
    } catch (error) {
      if (!isPlaywrightTimeout(error)) throw error;
      currentUpdated = false;
    }
    try {
      await waitForProfileChipValue(page, "intensity", expectedLabel, 5_000);
    } catch (error) {
      if (!isPlaywrightTimeout(error)) throw error;
      chipUpdated = false;
    }
    if (!currentUpdated || !chipUpdated) {
      const current = page.locator(
        '.composer .controlbar > .popover[role="dialog"]:not([hidden]) .islider-current',
      );
      const observedCurrent =
        (await current.count()) === 0
          ? "picker-closed"
          : ((await current.textContent()) ?? "empty").trim();
      const observedChip = await profileChipValue(page, "intensity");
      throw new HarnessFailure(
        "E2E_CATALOG_ASSERTION_FAILED",
        `item-8 intensity-selection runtime=${runtime},intensity=${index + 1} expected=${JSON.stringify(expectedLabel)} current-updated=${currentUpdated} observed-current=${JSON.stringify(observedCurrent)} chip-updated=${chipUpdated} observed-chip=${JSON.stringify(observedChip)}`,
      );
    }
    const caption = await inspectOptionalIntensityCaption(popover, model, index);
    if (!caption.exact) {
      await closeProfilePicker(page);
      throw new HarnessFailure(
        "E2E_CATALOG_ASSERTION_FAILED",
        `item-8 intensity-provenance runtime=${runtime},model=${JSON.stringify(model.label)},intensity=${index + 1} expected-native=${JSON.stringify(model.intensityValues[index])} expected-description=${JSON.stringify(model.intensityDescriptions[index])} observed=${JSON.stringify(caption.observed)}`,
      );
    }
  }
  await closeProfilePicker(page);
  return Object.freeze({
    intensityTickLabels: Object.freeze([...selectableShape.renderedLabels]),
  });
}

export async function selectRenderedIntensity(
  page: Page,
  runtime: RuntimeFamily,
  model: NormalizedModel,
  intensityIndex: number,
): Promise<void> {
  if (model.fixedIntensity) {
    const observed = await profileChipValue(page, "intensity");
    if (observed !== model.intensityTickLabels[0]) {
      throw new HarnessFailure(
        "E2E_CATALOG_ASSERTION_FAILED",
        `item-9 fixed-intensity expected=${JSON.stringify(model.intensityTickLabels[0])} observed=${JSON.stringify(observed)}`,
      );
    }
    return;
  }
  const popover = await openProfilePicker(page, "intensity");
  await chooseOpenSliderIndex(page, intensityIndex, model.intensityTickLabels.length);
  const expected = model.intensityTickLabels[intensityIndex]!;
  await runCatalogUiExpectation(
    `item-9 intensity-selection runtime=${runtime},intensity=${intensityIndex + 1} did not update`,
    () =>
      waitForProfileChipValue(page, "intensity", expected, 5_000),
  );
  const caption = await inspectOptionalIntensityCaption(
    popover,
    model,
    intensityIndex,
  );
  await closeProfilePicker(page);
  if (!caption.exact) {
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `item-9 selected intensity provenance runtime=${runtime} expected-native=${JSON.stringify(model.intensityValues[intensityIndex])} expected-description=${JSON.stringify(model.intensityDescriptions[intensityIndex])} observed=${JSON.stringify(caption.observed)}`,
    );
  }
}

async function inspectOptionalIntensityCaption(
  popover: Locator,
  model: NormalizedModel,
  intensityIndex: number,
): Promise<Readonly<{ exact: boolean; observed: string }>> {
  const caption = popover.locator(".islider-native");
  const captionCount = await caption.count();
  const expectedDescription = model.intensityDescriptions[intensityIndex];
  const nativeValue = model.intensityValues[intensityIndex];
  const displayedValue = model.intensityTickLabels[intensityIndex];
  const expectedCaption =
    displayedValue !== nativeValue &&
    typeof expectedDescription === "string" &&
    typeof nativeValue === "string"
      ? `Runtime: ${nativeValue} — ${expectedDescription}`
      : null;
  if (captionCount === 0) {
    return Object.freeze({
      exact: expectedCaption === null,
      observed: "absent",
    });
  }
  const observed = await runCatalogUiExpectation(
    "an optional intensity caption disappeared during inspection",
    async () => compactText((await caption.first().textContent()) ?? ""),
  );
  return Object.freeze({
    exact:
      captionCount === 1 &&
      expectedCaption !== null &&
      observed === compactText(expectedCaption),
    observed,
  });
}

function nativeIntensityScaleIsOrdered(values: readonly string[]): boolean {
  const positions = values.map((value) => nativeIntensityOrder.indexOf(value));
  return (
    positions.length > 0 &&
    positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > positions[index - 1]!),
    )
  );
}

async function chooseOpenSliderIndex(
  page: Page,
  index: number,
  count: number,
): Promise<void> {
  const track = page.locator(
    '.composer .controlbar > .popover[role="dialog"]:not([hidden]) .islider-track',
  );
  const box = await runCatalogUiExpectation(
    "the design-derived intensity slider track was unavailable",
    () => track.boundingBox({ timeout: 5_000 }),
  );
  if (box === null || count < 1) {
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      "the design-derived intensity slider was not measurable",
    );
  }
  const x =
    count === 1 ? box.width / 2 : 5 + ((box.width - 10) * index) / (count - 1);
  await runCatalogUiExpectation(
    "the design-derived intensity slider did not accept a selection",
    () => page.mouse.click(box.x + x, box.y + box.height / 2),
  );
}

async function inspectFixedModeChips(
  page: Page,
): Promise<Readonly<{ exact: boolean; detail: string }>> {
  const controlbar = page.locator(".composer .controlbar");
  const fixedModeChips = page.locator(
    ".composer .controlbar > span.chip.locked:has(> .chip-key)",
  );
  const observation = await runCatalogUiExpectation(
    "item-9 fixed mode chips were incomplete",
    async () => {
      const chips = await fixedModeChips.evaluateAll((elements) =>
          elements.map((element) => ({
            key:
              element.querySelector(":scope > .chip-key")?.textContent?.trim() ??
              "",
            value:
              element.querySelector(":scope > .chip-val")?.textContent?.trim() ??
              "",
            lockCount: element.querySelectorAll(
              ':scope > .lock[aria-hidden="true"]',
            ).length,
            interactiveAttributes: [
              "data-profile-popover-trigger",
              "aria-haspopup",
              "aria-controls",
              "role",
              "tabindex",
            ].filter((name) => element.hasAttribute(name)),
          })),
        );
      const interactiveModeButtons = await controlbar
        .locator(":scope > button:has(> .chip-key)")
        .evaluateAll(
          (elements) =>
            elements.filter((element) => {
              const key = element
                .querySelector(":scope > .chip-key")
                ?.textContent?.trim();
              return key === "Exec" || key === "Access";
            }).length,
        );
      return Object.freeze({
        chips,
        interactiveModeButtons,
        openDialogs: await controlbar
          .locator(':scope > .popover[role="dialog"]:not([hidden])')
          .count(),
      });
    },
  );
  const exact =
    JSON.stringify(observation.chips) ===
      JSON.stringify([
        {
          key: "Exec",
          value: "Single agent",
          lockCount: 1,
          interactiveAttributes: [],
        },
        {
          key: "Access",
          value: "Full access",
          lockCount: 1,
          interactiveAttributes: [],
        },
      ]) &&
    observation.interactiveModeButtons === 0 &&
    observation.openDialogs === 0;
  return Object.freeze({
    exact,
    detail: `fixed-mode-chips=${exact}(${JSON.stringify(observation)})`,
  });
}

async function readProfileChipSnapshot(page: Page): Promise<ProfileChipSnapshot> {
  return Object.freeze({
    endpoint: await profileChipValue(page, "endpoint"),
    model: await profileChipValue(page, "model"),
    intensity: await profileChipValue(page, "intensity"),
    execution: await profileChipValue(page, "exec"),
    access: await profileChipValue(page, "access"),
  });
}

export async function profileChipValue(
  page: Page,
  kind: ProfileControlKind,
): Promise<string> {
  return runCatalogUiExpectation(
    `profile chip kind=${kind} was unavailable`,
    async () =>
      (await profileChip(page, kind).locator(".chip-val").textContent())?.trim() ??
      "",
  );
}

export function profileChip(page: Page, kind: ProfileControlKind): Locator {
  const controlbar = page.locator(".composer .controlbar");
  switch (kind) {
    case "endpoint":
      return controlbar.locator(":scope > .chip.chip-endpoint");
    case "model":
      return controlbar.getByRole("button", { name: /^Model(?::|\s|$)/u });
    case "intensity":
      return controlbar.getByRole("button", {
        name: /^Work Intensity(?::|\s|$)/u,
      });
    case "exec":
      return page
        .locator(".composer .controlbar > span.chip.locked:has(> .chip-key)")
        .nth(0);
    case "access":
      return page
        .locator(".composer .controlbar > span.chip.locked:has(> .chip-key)")
        .nth(1);
  }
}

async function waitForProfileChipValue(
  page: Page,
  kind: ProfileControlKind,
  expected: string,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedValue, profileKind }) => {
      const controlbar = document.querySelector(".composer .controlbar");
      if (controlbar === null) return false;
      const chips = Array.from(controlbar.children).filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.classList.contains("chip"),
      );
      const expectedKey = {
        model: "Model",
        intensity: "Work Intensity",
        exec: "Exec",
        access: "Access",
      } as const;
      const matches = chips.filter((chip) => {
        if (profileKind === "endpoint") {
          return chip.classList.contains("chip-endpoint");
        }
        const key = chip.querySelector(":scope > .chip-key")?.textContent;
        return key?.replace(/\s+/gu, " ").trim().startsWith(expectedKey[profileKind]) ===
          true;
      });
      return (
        matches.length === 1 &&
        matches[0]?.querySelector(":scope > .chip-val")?.textContent?.trim() ===
          expectedValue
      );
    },
    { expectedValue: expected, profileKind: kind },
    { timeout },
  );
}

async function openProfilePicker(
  page: Page,
  kind: InteractiveProfileControlKind,
) {
  const chip = profileChip(page, kind);
  await runCatalogUiExpectation(
    `profile-picker kind=${kind} control was not visible`,
    () => chip.waitFor({ state: "visible", timeout: 5_000 }),
  );
  await runCatalogUiExpectation(
    `profile-picker kind=${kind} control was not actionable`,
    () => chip.click({ timeout: 5_000 }),
  );
  const popover = page.locator(
    '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
  );
  await runCatalogUiExpectation(
    `profile-picker kind=${kind} dialog did not open`,
    () => popover.waitFor({ state: "visible", timeout: 5_000 }),
  );
  const columnCount = await popover.locator(":scope > .picker-col").count();
  if (columnCount !== 1) {
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      `profile-picker kind=${kind} expected=one-independent-column observed=${columnCount}`,
    );
  }
  return popover;
}

async function closeProfilePicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await waitForProfilePickerClosed(page);
}

export async function closeProfilePickerIfOpen(page: Page): Promise<void> {
  const openPicker = page.locator(
    '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
  );
  if ((await openPicker.count()) === 0) return;
  try {
    await page.keyboard.press("Escape");
    await openPicker.waitFor({ state: "hidden", timeout: 2_000 });
  } catch {
    // The next hard catalog assertion records an uncloseable picker precisely.
  }
}

async function waitForProfilePickerClosed(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
        ).length === 0,
      undefined,
      { timeout: 2_000 },
    );
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    const pickerStillOpen = await page.evaluate(
      () =>
        document.querySelectorAll(
          '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
        ).length > 0,
    );
    if (!pickerStillOpen) return;
    throw new HarnessFailure(
      "E2E_CATALOG_ASSERTION_FAILED",
      "a profile picker did not close after committing or cancelling",
    );
  }
}

export function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isCatalogAssertionFailure(error: unknown): error is HarnessFailure {
  return (
    error instanceof HarnessFailure &&
    error.code === "E2E_CATALOG_ASSERTION_FAILED"
  );
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function runCatalogUiExpectation<T>(
  safeMessage: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    throw new HarnessFailure("E2E_CATALOG_ASSERTION_FAILED", safeMessage);
  }
}
