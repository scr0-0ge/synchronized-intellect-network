import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchModelOption,
  WorkbenchRuntimeEndpointOption,
} from "../../src/workbench-shell/contract.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const stylesheetUrl = new URL(
  "../../src/workbench-shell/renderer/styles.css",
  import.meta.url,
);
const noOp = (): void => undefined;

type RenderedComponent = (
  props: Readonly<Record<string, unknown>>,
) => unknown;

interface RenderedCatalogSeams {
  readonly ProfileControlChips: RenderedComponent;
  readonly IntensityPopover: RenderedComponent;
  readonly SessionInspector: RenderedComponent;
}

const catalogModel = Object.freeze({
  key: "model:compass",
  label: "Shared Compass",
  provenanceLabel: null,
  workIntensityLabel: "Deliberation",
  workIntensities: Object.freeze([
    Object.freeze({ key: "intensity:brief", label: "Brief" }),
    Object.freeze({ key: "intensity:deep", label: "Deep" }),
  ]),
}) satisfies WorkbenchModelOption;

const fallbackModel = Object.freeze({
  ...catalogModel,
  workIntensityLabel: null,
}) satisfies WorkbenchModelOption;

const endpoint = Object.freeze({
  endpointId: "codex-desktop",
  key: "endpoint:quartz",
  runtimeFamilyLabel: "Quartz Runtime",
  endpointLabel: "Quartz Studio",
  models: Object.freeze([catalogModel]),
  executionModes: Object.freeze([
    Object.freeze({ key: "execution:single", label: "Single agent" }),
  ]),
  accessModes: Object.freeze([
    Object.freeze({ key: "access:full", label: "Full access" }),
  ]),
}) satisfies WorkbenchRuntimeEndpointOption;

const recordedCommand = Object.freeze({
  key: "command:recorded",
  label: "Recorded Session",
  runtime: "quartz-runtime",
  status: "completed",
  session: Object.freeze({
    archived: false,
    metadataKey:
      "session-metadata:00000000-0000-4000-8000-000000000702",
    profile: Object.freeze({
      requested: Object.freeze({
        kind: "recorded" as const,
        runtimeFamilyLabel: "Quartz Runtime",
        endpointLabel: "Quartz Studio",
        modelLabel: "Shared Compass",
        workIntensityControlLabel: Object.freeze({
          label: "Deliberation",
          provenance: "runtime-catalog" as const,
        }),
        workIntensityLabel: "Deep",
        executionModeLabel: "Single agent",
        accessModeLabel: "Full access",
      }),
      effective: Object.freeze({ kind: "not-recorded" as const }),
    }),
    timeline: Object.freeze([]),
    removalKey:
      "session-removal:00000000-0000-4000-8000-000000000702",
    selectionKey: null,
    resumable: true,
  }),
}) satisfies WorkbenchCommandView;

const recordedView = Object.freeze({
  project: Object.freeze({ label: "Catalog fidelity" }),
  observation: Object.freeze({ cursor: 1, live: true as const }),
  commands: Object.freeze([recordedCommand]),
  initialSelectionKey: recordedCommand.key,
  projectSelection: Object.freeze({ projects: Object.freeze([]) }),
}) satisfies WorkbenchHostedProjectView;

test("Runtime catalog headings preserve mixed case at all rendered profile seams", async () => {
  const exposeRenderedSeams: Plugin = {
    name: "expose-catalog-text-presentation-seams",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/composer.tsx")
      ) {
        return;
      }

      return ["ProfileControlChips", "IntensityPopover"].reduce(
        (transformed, component) =>
          transformed.replace(
            `const ${component}`,
            `export const ${component}`,
          ),
        source,
      );
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeRenderedSeams, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const composerModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/composer.tsx",
    );
    const inspectorModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/inspector.tsx",
    );
    const renderedModule = {
      ...composerModule,
      ...inspectorModule,
    } as unknown as RenderedCatalogSeams;
    const directCatalog = renderComponent(
      renderedModule.ProfileControlChips,
      directChipProps(catalogModel),
    );
    const pickerCatalog = renderComponent(renderedModule.IntensityPopover, {
      model: catalogModel,
      selectedKey: "intensity:deep",
      onSelect: noOp,
    });
    const recordedCatalog = renderComponent(
      renderedModule.SessionInspector,
      { command: recordedCommand, view: recordedView, onCollapse: noOp },
    );
    const directFallback = renderComponent(
      renderedModule.ProfileControlChips,
      directChipProps(fallbackModel),
    );
    const pickerFallback = renderComponent(renderedModule.IntensityPopover, {
      model: fallbackModel,
      selectedKey: "intensity:deep",
      onSelect: noOp,
    });
    const styles = await readFile(stylesheetUrl, "utf8");

    const catalogRegions = [
      directChipRegion(directCatalog, "direct-work-intensity"),
      pickerCatalog,
      recordedIntensityRegion(recordedCatalog),
    ];
    for (const region of catalogRegions) {
      assert.match(region, /Deliberation/u);
    }

    const chipTransform = ruleTextTransform(styles, ".chip .chip-key");
    const pickerTransform = ruleTextTransform(styles, ".picker-col-head");
    const inspectorTransform = optionalRuleTextTransform(styles, ".kv-row dt");
    assert.deepEqual(
      [chipTransform, pickerTransform],
      ["uppercase", "uppercase"],
      "Workbench-owned chip and picker headings remain intentionally uppercase",
    );

    const classPlacement = catalogRegions.map((region) =>
      hasCatalogTextNode(region, "Deliberation"),
    );
    const catalogOverride = scopedCatalogTextTransform(styles);
    const presentation = [
      classPlacement[0] && catalogOverride !== undefined
        ? catalogOverride
        : chipTransform,
      classPlacement[1] && catalogOverride !== undefined
        ? catalogOverride
        : pickerTransform,
      inspectorTransform,
    ];
    assert.deepEqual(
      presentation,
      ["none", "none", undefined],
      "direct and picker catalog headings override uppercase while the Inspector fact has no uppercase transform",
    );

    assert.deepEqual(classPlacement, [true, true, false]);
    assert.equal(catalogOverride, "none");

    const directFallbackRegion = directChipRegion(
      directFallback,
      "direct-work-intensity",
    );
    assert.match(directFallbackRegion, /Work Intensity/u);
    assert.equal(
      hasCatalogTextNode(directFallbackRegion, "Work Intensity"),
      false,
    );
    assert.match(directFallbackRegion, /class="prov"/u);

    assert.match(pickerFallback, /Work Intensity/u);
    assert.equal(hasCatalogTextNode(pickerFallback, "Work Intensity"), false);
    assert.match(pickerFallback, /class="prov"/u);

    const modelRegion = directChipRegion(directCatalog, "direct-model");
    assert.match(modelRegion, />Model</u);
    assert.equal(hasCatalogTextNode(modelRegion, "Model"), false);
    assert.deepEqual(
      [chipTransform, chipTransform, pickerTransform],
      ["uppercase", "uppercase", "uppercase"],
    );
  } finally {
    await server.close();
  }
});

function directChipProps(
  selectedModel: WorkbenchModelOption,
): Readonly<Record<string, unknown>> {
  return {
    profile: { phase: "ready" },
    endpoints: [endpoint],
    selectedEndpoint: endpoint,
    selectedModel,
    selectedIntensityLabel: "Deep",
    pending: false,
    openPopover: null,
    onOpen: noOp,
  };
}

function renderComponent(
  component: RenderedComponent,
  props: Readonly<Record<string, unknown>>,
): string {
  return renderToString(() => component(props));
}

function directChipRegion(html: string, id: string): string {
  const region = html.match(
    new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`, "u"),
  )?.[0];
  assert.ok(region, `rendered ${id} chip exists`);
  return region;
}

function recordedIntensityRegion(html: string): string {
  const labelIndex = html.indexOf("Deliberation");
  assert.ok(labelIndex >= 0, "recorded catalog intensity label exists");
  const start = html.lastIndexOf("<div", labelIndex);
  const end = html.indexOf("</div>", labelIndex);
  assert.ok(
    start >= 0 && end > labelIndex,
    "rendered recorded intensity Inspector fact exists",
  );
  const region = html.slice(start, end + "</div>".length);
  assert.match(region, /class="kv-row(?:\s|"|$)/u);
  assert.match(region, /Deep/u);
  return region;
}

function hasCatalogTextNode(region: string, label: string): boolean {
  return (
    region.includes("runtime-catalog-text") &&
    new RegExp(escapeRegExp(label), "u").test(region)
  );
}

function ruleTextTransform(styles: string, selector: string): string {
  const block = styles.match(
    new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "u"),
  )?.[1];
  assert.ok(block, `${selector} rule exists`);
  const transform = block.match(/text-transform:\s*([^;]+);/u)?.[1]?.trim();
  assert.ok(transform, `${selector} declares text-transform`);
  return transform;
}

function optionalRuleTextTransform(
  styles: string,
  selector: string,
): string | undefined {
  const block = styles.match(
    new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "u"),
  )?.[1];
  assert.ok(block, `${selector} rule exists`);
  return block.match(/text-transform:\s*([^;]+);/u)?.[1]?.trim();
}

function scopedCatalogTextTransform(styles: string): string | undefined {
  const block = styles.match(
    /\.chip-intensity\s*>\s*\.chip-key\s*>\s*\.runtime-catalog-text\s*,\s*\.picker-col-head\s*>\s*\.runtime-catalog-text\s*\{([^}]*)\}/u,
  )?.[1];
  return block?.match(/text-transform:\s*([^;]+);/u)?.[1]?.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
