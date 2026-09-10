import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type { WorkbenchHostedProjectView } from "../../src/workbench-shell/contract.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  beginDirectSessionProfileLoad,
  completeDirectSessionProfileLoad,
  initialRendererState,
} from "../../src/workbench-shell/renderer/view-model.ts";
import { runtimeNotLocatedCopy } from "../../src/workbench-shell/renderer/copy/composer-copy.ts";
import {
  emptyVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;

test("runtime-not-located start surface follows screen 04 without changing ordinary empty Projects", async (t) => {
  const exposeRenderedSeam: Plugin = {
    name: "expose-runtime-not-located-screen",
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
    plugins: [exposeRenderedSeam, solid({ ssr: true })],
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
    const unavailableProfile = completeDirectSessionProfileLoad(
      beginDirectSessionProfileLoad(initialRendererState),
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
    ).profile;
    const activeNewSession = Object.freeze({
      ...initialRendererState.newSession,
      phase: "active" as const,
      baselineKeys: Object.freeze(
        visualFixture.commands.map((command) => command.key),
      ),
    });

    const runtimeWithHistory = renderScreen(
      renderedModule.WorkbenchScreen,
      visualFixture,
      unavailableProfile,
      activeNewSession,
      visualFixture.commands[0],
    );
    const runtimeEmpty = renderScreen(
      renderedModule.WorkbenchScreen,
      emptyVisualFixture,
      unavailableProfile,
      initialRendererState.newSession,
      undefined,
    );
    const ordinaryEmpty = renderScreen(
      renderedModule.WorkbenchScreen,
      emptyVisualFixture,
      initialRendererState.profile,
      initialRendererState.newSession,
      undefined,
    );

    await t.test("uses the exact screen-04 warning glyph", () => {
      assert.ok(
        /<span class="state-glyph is-warn" aria-hidden="true">⚠<\/span>/u.test(
          runtimeWithHistory,
        ),
        "warning glyph is exactly ⚠",
      );
    });

    await t.test("renders both fixed endpoint outcomes without overclaiming", () => {
      const checklist = runtimeWithHistory.match(
        /<ul[^>]*class="[^"]*\bchecklist\b[^"]*"[^>]*aria-label="Endpoint status"[^>]*>([\s\S]*?)<\/ul>/u,
      )?.[1];
      assert.ok(checklist, "the unavailable endpoint list has its design name");
      const endpointRows = checklist.match(/<li(?:\s[^>]*)?>[\s\S]*?<\/li>/gu) ?? [];
      assert.equal(endpointRows.length, 2);
      assert.deepEqual(endpointRows.map(plainText), [
        // Ticket 25: the family facade merges the desktop row into the
        // family entry; with no subscription and no API key the family
        // shows its unconfigured guidance (never the desktop-only
        // lookup detail — that moved to the Claude/Codex settings card).
        "● Codex · Runtime not located Subscription. Codex has no signed-in subscription and no saved API key. Sign in, or add a Codex API key, on the Codex card in Settings.",
        "● Claude · Runtime not located Subscription. Claude has no signed-in subscription and no saved API key. Sign in, or add a Claude API key, on the Claude card in Settings.",
      ]);
      assert.match(
        runtimeWithHistory,
        /<p>The Workbench looked for the runtimes it knows about and found neither of them installed and signed in on this machine\. Sessions can't start until at least one is ready\.<\/p>/u,
      );
      assert.doesNotMatch(
        checklist,
        /\bConnected\b|\bInstalled\b|Signed in as|\bActive\b|local ·|checked[- ]at|\d{4}-\d{2}-\d{2}T/iu,
      );
      assert.ok(
        /<p class="runtime-boundary-copy">Sign-in happens in each provider's own app\. The Workbench never asks for or stores subscription credentials; a provider API key saved in Settings is encrypted with your OS user account\.<\/p>/u.test(
          runtimeWithHistory,
        ),
        "credential-boundary paragraph matches screen 04",
      );
      assert.doesNotMatch(runtimeWithHistory, />Retry<|>Re-check now</u);
      assert.doesNotMatch(
        runtimeWithHistory,
        /runtime-settings-direction|highlighted Settings gear/u,
      );
      assert.match(runtimeWithHistory, />Open Settings<\/button>/u);
      assert.doesNotMatch(runtimeWithHistory, />Open Providers<\/button>/u);
      assert.equal(runtimeWithHistory.match(/aria-label="Settings"/gu)?.length, 1);
    });

    await t.test("disables both selected-Project new-Session actions with history present", () => {
      assert.ok(
        /<section[^>]*class="proj is-open"/u.test(runtimeWithHistory),
        "D9 Project-folder structure remains present",
      );
      assert.match(runtimeWithHistory, />Agent Session 01</u);
      assert.ok(
        /aria-label="New Agent Session in Atlas Fieldnotes" title="No runtime endpoint is available" disabled/u.test(
          runtimeWithHistory,
        ),
        "selected-Project New Agent Session action is disabled for unavailable Runtime",
      );
      assert.ok(
        /<button type="button" class="rail-action new-session-button" disabled aria-label="New Agent Session \(Ctrl\+N\)">[\s\S]*?New Session[\s\S]*?<kbd>Ctrl N<\/kbd><\/button>/u.test(
          runtimeWithHistory,
        ),
        "rail-foot shortened New Session action is disabled for unavailable Runtime",
      );
    });

    await t.test("uses runtime-specific rail-empty copy only on the unavailable start surface", () => {
      assert.equal(
        railEmptyText(runtimeEmpty),
        "No Agent Sessions. None can start until a runtime is available.",
      );
      assert.equal(
        railEmptyText(ordinaryEmpty),
        "No Agent Sessions in this Project yet. The first message starts one.",
      );
    });

    await t.test("puts Draft preserved immediately after the unavailable statusbar spacer", () => {
      const unavailableStatusbar = statusbar(runtimeWithHistory);
      assert.ok(
        /<span[^>]*class="sb-spacer"[^>]*><\/span><span[^>]*class="sb-item sb-hide-narrow"[^>]*><span class="v">Draft preserved<\/span><\/span>/u.test(
          unavailableStatusbar,
        ),
        "unavailable statusbar ends with Draft preserved after its spacer",
      );
      assert.doesNotMatch(unavailableStatusbar, />Completed</u);
      assert.doesNotMatch(statusbar(ordinaryEmpty), />Draft preserved</u);
    });
  } finally {
    await server.close();
  }
});

function renderScreen(
  Screen: (props: Readonly<Record<string, unknown>>) => unknown,
  view: WorkbenchHostedProjectView,
  profile: unknown,
  newSession: unknown,
  selected: WorkbenchHostedProjectView["commands"][number] | undefined,
): string {
  return renderToString(() =>
    Screen({
      view,
      surface: "project",
      selected,
      composer: initialRendererState.composer,
      profile,
      appearance: {
        tone: "dark",
        crt: "screen",
        phosphor: "neutral",
        phosphorTier: "b",
      },
      newSession,
      projectSwitch: initialRendererState.projectSwitch,
      projectOpen: initialRendererState.projectOpen,
      canCreateProject: () => true,
      canOpenProject: () => true,
      canSelectProject: () => true,
      onSurface: noOp,
      onAppearance: noOp,
      onCreateProject: noOp,
      onOpenProject: noOp,
      onSelectProject: noOp,
      onSelect: noOp,
      onDraft: noOp,
      onLoadProfile: noOp,
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

function railEmptyText(html: string): string {
  const region = html.match(
    /<div[^>]*class="rail-empty compact"[^>]*>([\s\S]*?)<\/div>/u,
  )?.[1];
  assert.ok(region, "the selected Project keeps its D9 rail-empty region");
  const content = region.match(/<p[^>]*>([\s\S]*?)<\/p>/u)?.[1];
  assert.ok(content, "the selected Project rail-empty region has copy");
  return content
    .replace(/<br[^>]*>/gu, " ")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function statusbar(html: string): string {
  const content = html.match(
    /<footer[^>]*class="statusbar"[^>]*>([\s\S]*?)<\/footer>/u,
  )?.[1];
  assert.ok(content, "the rendered screen has a statusbar");
  return content;
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,;:])/gu, "$1")
    .trim();
}
