import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type { RuntimeCatalog } from "../../src/agent-runtime/index.ts";
import {
  createDirectSessionProfileSnapshot,
  type DirectSessionProfileEndpointCatalog,
} from "../../src/workbench-shell/direct-session-profile-snapshot.ts";
import {
  publicRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointId,
} from "../../src/workbench-shell/contract.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  hasHostedProjectView,
  initialRendererState,
  replaceProjectResult,
  selectedCommand,
  type WorkbenchRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { dissimilarNeutralEndpointFixtures } from "./fixtures/neutral-public-contract-fixtures.ts";
import { emptyVisualFixture } from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;

const FIXTURE_ENDPOINT_IDS: readonly WorkbenchRuntimeEndpointId[] =
  Object.freeze(["codex-desktop", "claude-code-desktop"]);

test("w202: the Claude family card and the GLM fallback card do not collide on one executable-path id, and a confirmed Re-check stops re-asking for one", async () => {
  const exposeWorkbenchScreen: Plugin = {
    name: "expose-settings-executable-field-screen",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/mount.tsx")
      ) {
        return source.replace(
          "const WorkbenchScreen",
          "export const WorkbenchScreen",
        );
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeWorkbenchScreen, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const renderedModule = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/mount.tsx",
    )) as {
      readonly WorkbenchScreen: (
        props: Readonly<Record<string, unknown>>,
      ) => unknown;
    };
    const projectReady = replaceProjectResult(initialRendererState, {
      ok: true,
      view: emptyVisualFixture,
    });

    // Neither desktop runtime is on PATH, and GLM (which piggybacks the same
    // "claude" executable, per view-model.ts's runtime assignment) is also
    // unlocated: this is the exact shape from the w190 walkthrough where the
    // Claude family card and the "Other providers" GLM card each render an
    // executable-path field for runtime "claude".
    const runtimeNotLocated = completeDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(projectReady),
      {
        ok: false,
        endpointDiscovery: {
          statuses: [
            { endpointId: "codex-desktop", category: "runtime-not-located" },
            {
              endpointId: "claude-code-desktop",
              category: "runtime-not-located",
            },
            { endpointId: "glm-coding-plan", category: "runtime-not-located" },
          ],
        },
        error: {
          category: "runtime-not-located",
          message:
            "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
        },
      },
    );

    const unlocatedHtml = renderProviders(
      renderedModule.WorkbenchScreen,
      runtimeNotLocated,
      { codex: "", claude: "C:\\uaw-qa\\claude.cmd" },
      { claude: { status: "saved" } },
    );

    const executableFieldIds = [
      ...unlocatedHtml.matchAll(/<input[^>]*\sid="(runtime-executable-[^"]+)"/gu),
    ].map((match) => match[1]);
    assert.equal(
      executableFieldIds.length,
      3,
      "the Codex family card, the Claude family card, and the GLM fallback card must each render their own executable-path field",
    );
    assert.equal(
      new Set(executableFieldIds).size,
      executableFieldIds.length,
      "two executable-path fields for the same underlying runtime must not share one id -- a <label for> can only ever resolve to the first element with that id",
    );

    const labelTargets = [
      ...unlocatedHtml.matchAll(/<label[^>]*\bfor="(runtime-executable-[^"]+)"/gu),
    ].map((match) => match[1]);
    assert.deepEqual(
      [...labelTargets].sort(),
      [...executableFieldIds].sort(),
      "each field's own label must target that field's own id, not the other card's",
    );

    // The path was saved, then a Re-check confirmed the runtime and produced a
    // catalog (category "catalog-ready"). The session-local "saved" phase is
    // untouched by that confirmation, but the field must stop telling the user
    // to do the Re-check that has already succeeded.
    const catalogReady = completeDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(projectReady),
      claudeCatalogReadySnapshot(),
    );
    const readyHtml = renderProviders(
      renderedModule.WorkbenchScreen,
      catalogReady,
      { codex: "", claude: "C:\\uaw-qa\\claude.cmd" },
      { claude: { status: "saved" } },
    );
    const claudeCard =
      providerCards(readyHtml).find((card) => /provider-claude/u.test(card)) ??
      "";
    assert.notEqual(claudeCard, "", "expected the Claude family card to render");
    assert.doesNotMatch(
      plainText(claudeCard),
      /Saved\. Re-check to start the runtime\./u,
      "once Re-check has confirmed the CLI (Catalog ready), the field must not keep asking for a Re-check that already happened",
    );
  } finally {
    await server.close();
  }
});

function renderProviders(
  Screen: (props: Readonly<Record<string, unknown>>) => unknown,
  state: WorkbenchRendererState,
  runtimeExecutables?: Readonly<{ codex: string; claude: string }>,
  runtimeExecutablePhases?: Readonly<Record<string, unknown>>,
): string {
  assert.equal(hasHostedProjectView(state.result), true);
  if (!hasHostedProjectView(state.result)) assert.fail("Expected a Project view.");
  const view = state.result.view;
  return renderToString(() =>
    Screen({
      view,
      surface: "settings",
      selected: selectedCommand(view, state.selectedKey),
      composer: state.composer,
      profile: state.profile,
      appearance: {
        tone: "dark",
        crt: "screen",
        phosphor: "neutral",
        phosphorTier: "b",
      },
      appearancePersistencePhase: "saved",
      claudePermissionHandling: "without-asking",
      claudePermissionHandlingPersistencePhase: "saved",
      runtimeExecutables,
      runtimeExecutablePhases,
      newSession: state.newSession,
      projectSwitch: state.projectSwitch,
      projectOpen: state.projectOpen,
      canCreateProject: () => true,
      canOpenProject: () => true,
      canSelectProject: () => true,
      onSurface: noOp,
      onAppearance: noOp,
      onClaudePermissionHandling: noOp,
      onCreateProject: noOp,
      onOpenProject: noOp,
      onSelectProject: noOp,
      onSelect: noOp,
      onDraft: noOp,
      onLoadProfile: noOp,
      onRefreshProfile: noOp,
      onEnterNewSession: noOp,
      onCancelNewSession: noOp,
      onEndpoint: noOp,
      onModel: noOp,
      onWorkIntensity: noOp,
      onExecutionMode: noOp,
      onAccessMode: noOp,
      onUseAsDefault: noOp,
      onSubmit: noOp,
    }),
  );
}

function providerCards(html: string): readonly string[] {
  return (
    html.match(
      /<section[^>]*class="provider(?: provider-(?:kimi|claude|codex))?"[^>]*>[\s\S]*?<\/section>/gu,
    ) ?? []
  );
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function claudeCatalogReadySnapshot() {
  return createDirectSessionProfileSnapshot({
    endpoints: catalogReadyEndpoints(),
    endpointDiscovery: publicRuntimeEndpointDiscovery([
      { endpointId: "codex-desktop", category: "catalog-ready" },
      { endpointId: "claude-code-desktop", category: "catalog-ready" },
    ]),
    endpointIds: FIXTURE_ENDPOINT_IDS,
  }).publicResult;
}

function catalogReadyEndpoints(): readonly DirectSessionProfileEndpointCatalog[] {
  const fixtures = dissimilarNeutralEndpointFixtures();
  const endpointCatalog = (
    endpointId: WorkbenchRuntimeEndpointId,
    fixture: (typeof fixtures)[number],
    catalog: RuntimeCatalog,
    catalogRevision: string,
  ): DirectSessionProfileEndpointCatalog =>
    Object.freeze({
      endpointId,
      runtimeFamilyLabel: fixture.runtimeFamilyLabel,
      endpointLabel: fixture.endpointLabel,
      catalog,
      catalogRevision,
      executionModeLabels: Object.freeze(
        catalog.executionModes.map((mode) =>
          mode === "single-agent" ? "Single agent" : "Coordinated workflow",
        ),
      ),
      accessModeLabels: Object.freeze(["Full access"]),
    });
  return Object.freeze([
    endpointCatalog(
      "codex-desktop",
      fixtures[0],
      fixtures[0].adapter.catalog,
      "catalog:quartz",
    ),
    endpointCatalog(
      "claude-code-desktop",
      fixtures[1],
      fixtures[1].adapter.catalog,
      "catalog:nimbus",
    ),
  ]);
}
