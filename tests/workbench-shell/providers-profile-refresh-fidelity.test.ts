import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import {
  beginDirectSessionProfileLoad,
  beginDirectSessionProfileRefreshFromProviders,
  canRefreshDirectSessionProfileFromProviders,
  completeDirectSessionProfileLoad,
  hasHostedProjectView,
  initialRendererState,
  replaceProjectResult,
  selectProjectCommand,
  selectedCommand,
  updateDirectInputDraft,
  type WorkbenchRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  emptyVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;

test("Providers Re-check all follows the pure refresh gate and the one existing catalog bridge read", async () => {
  const exposeWorkbenchScreen: Plugin = {
    name: "expose-providers-profile-refresh-screen",
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
    const drafted = updateDirectInputDraft(
      projectReady,
      "Keep this draft while endpoint catalogs are repaired.",
    );
    const runtimeNotLocated = completeDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(drafted),
      {
        ok: false,
        endpointDiscovery: {
          statuses: [
            {
              endpointId: "codex-desktop",
              category: "runtime-not-located",
            },
            {
              endpointId: "claude-code-desktop",
              category: "runtime-not-located",
            },
          ],
        },
        error: {
          category: "runtime-not-located",
          message:
            "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
        },
      },
    );
    const continuation = replaceProjectResult(runtimeNotLocated, {
      ok: true,
      view: visualFixture,
    });
    const terminal = selectProjectCommand(continuation, "command-2");
    const loading = beginDirectSessionProfileRefreshFromProviders(
      runtimeNotLocated,
    );
    const categorizedFailure = completeDirectSessionProfileLoad(loading, {
      ok: false,
      endpointDiscovery: {
        statuses: [
          {
            endpointId: "codex-desktop",
            category: "authentication-required",
          },
          {
            endpointId: "claude-code-desktop",
            category: "inspection-failed",
          },
        ],
      },
      error: {
        category: "profile-unavailable",
        message:
          "Codex Session Profile options are unavailable. Keep your draft and try again.",
      },
    });
    const savingDefault = Object.freeze({
      ...runtimeNotLocated,
      profile: Object.freeze({
        ...runtimeNotLocated.profile,
        defaultPreference: Object.freeze({
          phase: "pending" as const,
          feedback: "Saving default…",
        }),
      }),
    });
    const openingProject = Object.freeze({
      ...runtimeNotLocated,
      projectOpen: Object.freeze({
        ...runtimeNotLocated.projectOpen,
        phase: "pending" as const,
        operation: "open" as const,
      }),
    });
    const recoveringProject = Object.freeze({
      ...runtimeNotLocated,
      projectOpen: Object.freeze({
        ...runtimeNotLocated.projectOpen,
        phase: "recovery-required" as const,
        operation: "open" as const,
      }),
    });
    const switchingProject = Object.freeze({
      ...runtimeNotLocated,
      projectSwitch: Object.freeze({
        ...runtimeNotLocated.projectSwitch,
        phase: "pending" as const,
        targetIndex: 1,
      }),
    });
    const submitting = Object.freeze({
      ...runtimeNotLocated,
      composer: Object.freeze({
        ...runtimeNotLocated.composer,
        phase: "pending" as const,
      }),
    });

    for (const permitted of [runtimeNotLocated, continuation, terminal]) {
      assert.equal(
        canRefreshDirectSessionProfileFromProviders(permitted),
        true,
      );
      const button = providersButton(
        renderProviders(renderedModule.WorkbenchScreen, permitted),
      );
      assert.equal(button.disabled, false);
      assert.equal(button.label, "Re-check all");
    }

    for (const blocked of [
      loading,
      savingDefault,
      openingProject,
      recoveringProject,
      switchingProject,
      submitting,
    ]) {
      assert.equal(canRefreshDirectSessionProfileFromProviders(blocked), false);
      const button = providersButton(
        renderProviders(renderedModule.WorkbenchScreen, blocked),
      );
      assert.equal(button.disabled, true);
    }

    const unavailableProviders = renderProviders(
      renderedModule.WorkbenchScreen,
      runtimeNotLocated,
    );
    const unavailableText = plainText(unavailableProviders);
    const unavailableCards = providerCards(unavailableProviders);
    assert.equal(unavailableCards.length, 2);
    assert.deepEqual(unavailableCards.map(plainText), [
      "Codex Subscription Catalog unavailable Subscription API Status Runtime not located Catalog Unavailable Not found under any name that was checked. Looked for codex.exe, codex.cmd, codex.bat, codex on your PATH codex.exe, codex.cmd, codex.bat, codex in %APPDATA%\\npm codex.exe in %LOCALAPPDATA%\\OpenAI\\Codex\\bin Get it https://developers.openai.com/codex/cli Executable path Somewhere else on this machine? Type the full path to the runtime here. The shim an npm install writes works, and so does the program itself. Use this path Clear Subscription sign-in Unknown Subscription sign-in could not be verified. Re-check before taking an authentication action. Re-check sign-in",
      "Claude Subscription Catalog unavailable Subscription API Status Runtime not located Catalog Unavailable Not found under any name that was checked. Looked for claude.exe, claude.cmd, claude.bat, claude on your PATH claude.exe, claude.cmd, claude.bat, claude in %APPDATA%\\npm claude.exe in %USERPROFILE%\\.local\\bin claude.exe in %APPDATA%\\Claude\\claude-code Get it https://docs.claude.com/en/docs/claude-code/setup Executable path Somewhere else on this machine? Type the full path to the runtime here. The shim an npm install writes works, and so does the program itself. Use this path Clear Subscription sign-in Unknown Subscription sign-in could not be verified. Re-check before taking an authentication action. Re-check sign-in",
    ]);
    assert.equal(unavailableText.match(/Re-check all/gu)?.length, 1);

    const categorizedProviders = renderProviders(
      renderedModule.WorkbenchScreen,
      categorizedFailure,
    );
    const categorizedCards = providerCards(categorizedProviders);
    assert.equal(categorizedCards.length, 2);
    assert.deepEqual(categorizedCards.map(plainText), [
      "Codex Subscription Catalog unavailable Subscription API Status Authentication required Catalog Unavailable Sign-in remains in the official provider flow. Subscription sign-in Unknown Subscription sign-in could not be verified. Re-check before taking an authentication action. Re-check sign-in",
      "Claude Subscription Catalog unavailable Subscription API Status Inspection failed Catalog Unavailable No private error detail is exposed. Subscription sign-in Unknown Subscription sign-in could not be verified. Re-check before taking an authentication action. Re-check sign-in",
    ]);
    const configuredFailureCards = providerCards(
      renderProviders(renderedModule.WorkbenchScreen, categorizedFailure, {
        codex: "",
        claude: "C:\\Windows\\System32\\where.exe",
      }),
    );
    assert.match(
      configuredFailureCards[1] ?? "",
      /<input[^>]*id="runtime-executable-claude"[^>]*value="C:\\Windows\\System32\\where\.exe"/u,
      "a failed configured CLI must keep its executable path input visible",
    );
    assert.match(
      plainText(configuredFailureCards[1] ?? ""),
      /Use this path Clear/u,
      "a failed configured CLI must keep its save and clear actions visible",
    );
    assert.doesNotMatch(
      plainText(configuredFailureCards[1] ?? ""),
      /Looked for|Get it/u,
      "inspection failure must not invent missing-runtime lookup guidance",
    );
    assert.equal(
      categorizedCards.filter((card) => /Authentication required/u.test(card)).length,
      1,
      "this fixture has one authentication-required endpoint",
    );
    for (const providersHtml of [unavailableProviders, categorizedProviders]) {
      const providerCardText = providerCards(providersHtml)
        .map(plainText)
        .join(" ");
      assert.doesNotMatch(
        providerCardText,
        /\bInstalled\b|Signed in as|\bActive\b|local ·|checked[- ]at|\d{4}-\d{2}-\d{2}T/iu,
      );
    }

    const [source, viewModelSource, stageSource, stageCopySource] =
      await Promise.all([
      readFile(
        new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../../src/workbench-shell/renderer/view-model.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../../src/workbench-shell/renderer/stage.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../../src/workbench-shell/renderer/copy/stage-copy.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    assert.equal(
      source.match(/props\.bridge\s*\.loadDirectSessionProfile\(request\)/gu)
        ?.length,
      1,
      "ordinary loads and Providers refreshes share one existing bridge read",
    );
    const sharedRunner = source.slice(
      source.indexOf("const runDirectSessionProfileLoad"),
      source.indexOf("const loadDirectSessionProfile"),
    );
    assert.match(sharedRunner, /const loading = beginLoad\(current, request\);/u);
    for (const guard of [
      /generation !== profileLoadGeneration/u,
      /scopeEpoch !== projectScopeEpoch\(\)/u,
      /loadSurface !== surface\(\)/u,
      /current\.selectedKey !== selectedKey/u,
      /current\.result\.view\.observation\.cursor !==\s*request\.sourceSnapshotCursor/u,
      /command\.key === request\.sourceSelectionKey/u,
    ]) {
      assert.match(sharedRunner, guard);
    }
    const replacementEntry = source.slice(
      source.indexOf("const enterReplacementSession"),
      source.indexOf("const changeSurface"),
    );
    /* The request is still built from exactly the two fields the shared runner
       re-validates against above, but F207 moved its construction out of this
       handler and into the one decision the control's `disabled` expression also
       reads. So the same property is now asserted across both halves: this
       handler must take its request from that decision, and that decision must
       build it from those fields. */
    assert.match(
      replacementEntry,
      /const request = replacementSessionRequest\(current\);/u,
    );
    assert.match(
      viewModelSource.slice(
        viewModelSource.indexOf("export function replacementSessionRequest"),
        viewModelSource.indexOf("export function canEnterReplacementSession"),
      ),
      /sourceSelectionKey: state\.selectedKey[\s\S]*?sourceSnapshotCursor: state\.result\.view\.observation\.cursor/u,
    );
    assert.match(
      replacementEntry,
      /runDirectSessionProfileLoad\(beginDirectSessionProfileLoad, request\)/u,
    );
    assert.match(
      source.slice(
        source.indexOf("const enterNewSession"),
        source.indexOf("const enterReplacementSession"),
      ),
      /invalidateDirectSessionProfileLoad\(\)/u,
    );
    assert.match(
      source,
      /const refreshDirectSessionProfileFromProviders = \(\): void =>[\s\S]*?beginDirectSessionProfileRefreshFromProviders/u,
    );
    const surfaceTransition = source.slice(
      source.indexOf("const changeSurface"),
      source.indexOf("const selectCommand"),
    );
    assert.match(
      surfaceTransition,
      /destination === "project"[\s\S]*?prepareDirectSessionProfileForProjectSurface\(current\)/u,
    );
    assert.match(
      source,
      /pendingContinuationDirectSessionProfileLoad\(current\)[\s\S]*?surface\(\) !== "project"[\s\S]*?runDirectSessionProfileLoad\([\s\S]*?beginDirectSessionProfileLoad,[\s\S]*?request/u,
    );
    assert.match(
      source,
      /onLoadProfile=\{loadDirectSessionProfile\}[\s\S]*?onRefreshProfile=\{\(\) => \{\s*refreshDirectSessionProfileFromProviders\(\);\s*refreshSubscriptionAuthentication\(\);\s*\}\}/u,
    );
    const providersRoute = source.slice(source.indexOf("const WorkbenchScreen"));
    assert.match(
      providersRoute,
      /canRead=\{\s*canRefreshDirectSessionProfileFromProviders\(\s*rendererState\(\),?\s*\)\s*\}[\s\S]*?onRead=\{props\.onRefreshProfile\}/u,
    );
    // The profile "Re-check all" stays on the pure refresh gate: no bridge
    // refresh/recheck read. The one carve-out is the catalog-freshness
    // manual refresh (ticket 14 / WO16 Part 3), a different surface that
    // legitimately owns a bridge refresh method.
    assertNoBridgeProfileRefresh(source);

    const runtimeState = stageSource.slice(
      stageSource.indexOf("const RuntimeNotLocatedState"),
      stageSource.indexOf("function commandTurnStateClass"),
    );
    const runtimeStateWithCopy = [runtimeState, stageCopySource].join("\n");
    assert.doesNotMatch(
      runtimeStateWithCopy,
      /runtime-settings-direction|highlighted Settings gear/u,
    );
    assert.match(
      runtimeStateWithCopy,
      /<button[\s\S]*?\{stageCopy\.openSettings\}[\s\S]*?<\/button>[\s\S]*?openSettings: "Open Settings"/u,
    );
    assert.doesNotMatch(
      runtimeStateWithCopy,
      />\s*Open Providers\s*<\/button>/u,
    );
    assert.doesNotMatch(runtimeStateWithCopy, /Retry|Re-check/u);
  } finally {
    await server.close();
  }
});

function assertNoBridgeProfileRefresh(source: string): void {
  assert.doesNotMatch(
    source,
    /props\.bridge\.(?:refresh|recheck)(?!EndpointCatalogFreshness)/iu,
  );
}

function renderProviders(
  Screen: (props: Readonly<Record<string, unknown>>) => unknown,
  state: WorkbenchRendererState,
  runtimeExecutables?: Readonly<{ codex: string; claude: string }>,
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

function providersButton(html: string): {
  readonly disabled: boolean;
  readonly label: string;
} {
  const button = html.match(
    /<button[^>]*class="btn ghost sm providers-recheck"[^>]*>[\s\S]*?<\/button>/u,
  )?.[0];
  assert.ok(button, "the real SettingsScreen renders its catalog action");
  const openTag = button.slice(0, button.indexOf(">") + 1);
  return {
    disabled: /\sdisabled(?:[=\s>])/u.test(openTag),
    label: button
      .replace(/<[^>]+>/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  };
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
