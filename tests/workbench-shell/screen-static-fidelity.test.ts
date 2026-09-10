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
} from "../../src/workbench-shell/contract.ts";
import { publicRuntimeEndpointDiscovery } from "../../src/workbench-shell/contract.ts";
import { initialRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  emptyVisualFixture,
  interruptVisualFixture,
  secondSessionVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

type RenderedComponent = (
  props: Readonly<Record<string, unknown>>,
) => unknown;

interface StaticFidelityModule {
  readonly BlockedComposer: RenderedComponent;
  readonly DirectInputComposer: RenderedComponent;
  readonly EmptyProjectState: RenderedComponent;
  readonly ProfilePopover: RenderedComponent;
  readonly ProviderCard: RenderedComponent;
  readonly SessionInspector: RenderedComponent;
  readonly SessionTranscript: RenderedComponent;
  readonly WorkbenchStatusbar: RenderedComponent;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;
const fallbackTitle =
  "Workbench label. This runtime's catalog supplied no control label of its own.";

test("screens 01-03, 05 and 06 retain the remaining exact static fidelity contract", async (t) => {
  await withStaticFidelityModule(async (module) => {
    await t.test("screen 01 exact idle copy, suggestion glyph, Inspector explanation and honest shortcut", () => {
      const emptyHtml = clean(renderToString(() =>
        module.EmptyProjectState({
          ...directComposerProps(emptyVisualFixture, undefined),
          onProviders: noOp,
        }),
      ));
      assert.match(
        plainText(emptyHtml),
        /Endpoints are read when you open the picker\. Nothing runs before that\./u,
      );
      assert.doesNotMatch(plainText(emptyHtml), /Endpoint options are read/u);
      assert.equal(
        [...emptyHtml.matchAll(
          /<span class="sg-glyph" aria-hidden="true">\s*›\s*<\/span>/gu,
        )].length,
        3,
      );

      const inspector = clean(renderToString(() =>
        module.SessionInspector({
          command: undefined,
          view: emptyVisualFixture,
          onCollapse: noOp,
        }),
      ));
      assert.match(inspector, /aria-label="Hide inspector"/u);
      assert.match(inspector, /title="Hide inspector"/u);
      assert.match(
        plainText(inspector),
        /latest recorded turn profile appears here\. When it is resumable, Model and Work Intensity can be chosen for the next turn; provider, Exec and Access stay fixed\./u,
      );
      assert.doesNotMatch(
        plainText(inspector),
        /cannot be edited|keeps the profile it started with/iu,
      );

      const statusbar = clean(renderToString(() =>
        module.WorkbenchStatusbar({
          view: emptyVisualFixture,
          selected: undefined,
          profile: initialRendererState.profile,
          surface: "project",
          runtimeUnavailable: false,
          startingNewSession: false,
        }),
      ));
      assert.match(plainText(statusbar), /Ctrl ↵ send/u);
      assert.doesNotMatch(plainText(statusbar), /Ctrl N/u);
    });

    await t.test("screen 02 preserves continuation copy, exact fallback provenance, modes and transcript tail", () => {
      const active = commandWithStatus("completed", true);
      const activeView = viewWith(active);
      const composer = clean(renderToString(() =>
        module.DirectInputComposer({
          ...directComposerProps(activeView, active),
          onProviders: noOp,
        }),
      ));
      assert.match(
        plainText(composer),
        /The next reply uses the selected Model and Work Intensity\. Provider, Exec and Access stay fixed for this Session\./u,
      );
      assert.doesNotMatch(
        plainText(composer),
        /keeps this Session's recorded profile|Start a new Session to change it/iu,
      );
      const activeStatus = clean(renderToString(() =>
        module.WorkbenchStatusbar({
          view: activeView,
          selected: active,
          profile: initialRendererState.profile,
          surface: "project",
          runtimeUnavailable: false,
          startingNewSession: false,
        }),
      ));
      assert.match(
        activeStatus,
        /class="sb-item truncate status-intensity\s*" title="Maximum"/u,
      );
      assert.doesNotMatch(activeStatus, /status-intensity is-terminal/u);

      const fallbackCommand = secondSessionVisualFixture.commands[1];
      assert.ok(fallbackCommand?.session);
      const inspector = clean(renderToString(() =>
        module.SessionInspector({
          command: fallbackCommand,
          view: secondSessionVisualFixture,
          onCollapse: noOp,
        }),
      ));
      assert.match(inspector, new RegExp(`title="${escapeRegExp(fallbackTitle)}"`, "u"));
      assert.match(
        plainText(inspector),
        /Execution Mode and Access Mode are chosen separately from each other and from the model and intensity\. Neither is downgraded silently\./u,
      );

      const catalogInspector = clean(renderToString(() =>
        module.SessionInspector({
          command: visualFixture.commands[0],
          view: visualFixture,
          onCollapse: noOp,
        }),
      ));
      assert.doesNotMatch(catalogInspector, /class="prov"/u);

      const transcript = clean(renderToString(() =>
        module.SessionTranscript({ command: active }),
      ));
      assert.match(
        transcript,
        /<div[^>]*class="timeline-tail-spacer" aria-hidden="true"><\/div>/u,
      );
    });

    await t.test("screen 02 keeps the composer enabled with truthful Guide and Stop controls", () => {
      const running = interruptVisualFixture.commands[1];
      assert.ok(running?.session);
      const available = clean(renderToString(() =>
        module.DirectInputComposer({
          ...directComposerProps(interruptVisualFixture, running),
          composer: Object.freeze({
            ...initialRendererState.composer,
            draft: "Guide this exact running turn.",
          }),
          interruptPending: false,
          interruptFeedback: null,
          onInterrupt: noOp,
          steerPending: false,
          steerFeedback: null,
          onSteer: noOp,
        }),
      ));
      assert.match(
        available,
        /<div[^>]*class="composer[^>]*>[\s\S]*<button[^>]*class="send stop-button"[^>]*aria-keyshortcuts="Escape"[^>]*>\s*Stop\s*<kbd>Esc<\/kbd>\s*<\/button>/u,
      );
      assert.doesNotMatch(available, /stop-button[^>]*disabled/u);
      assert.match(
        available,
        /<button[^>]*class="send guide-button"[^>]*aria-keyshortcuts="Control\+Enter Meta\+Enter"[^>]*>\s*Guide\s*<kbd>Ctrl ↵<\/kbd>\s*<\/button>/u,
      );
      assert.doesNotMatch(available, /guide-button[^>]*disabled/u);
      assert.match(
        available,
        /<p[^>]*class="control-note[^"]*"[^>]*>[\s\S]*Guide this running turn · Stop this running turn[\s\S]*<\/p>/u,
      );
      assert.match(available, /<textarea[^>]*id="direct-input"/u);
      assert.doesNotMatch(
        available,
        /<textarea[^>]*id="direct-input"[^>]*disabled/u,
      );
      assert.doesNotMatch(available, /class="send submit-button"/u);

      const unsupported = Object.freeze({
        ...running!,
        interrupt: Object.freeze({
          status: "unsupported" as const,
          reason: "This Runtime does not support interruption." as const,
        }),
      });
      const disabled = clean(renderToString(() =>
        module.DirectInputComposer({
          ...directComposerProps(viewWith(unsupported), unsupported),
          interruptPending: false,
          interruptFeedback: null,
          onInterrupt: noOp,
        }),
      ));
      assert.match(disabled, /stop-button[^>]*disabled/u);
      assert.match(disabled, /title="This Runtime does not support interruption\."/u);
    });

    await t.test(
      "screen 02 offers Guide only once an attached Runtime binding reports same-turn steering",
      () => {
        // Issue #6 case 6. Between accepting a prompt and attaching the
        // Runtime binding the Coordinator cannot know whether this Runtime
        // steers, so it reports idle (projected `unavailable`) and then
        // `pending`. Mounting Guide on "not yet unsupported" put the button on
        // screen for that whole latency and withdrew it when a Runtime with no
        // steering contract finally said so -- the vanishing Guide button on
        // GLM and deepseek.
        const running = interruptVisualFixture.commands[1];
        assert.ok(running?.session);
        const composerHtml = (command: WorkbenchCommandView): string =>
          clean(renderToString(() =>
            module.DirectInputComposer({
              ...directComposerProps(viewWith(command), command),
              composer: Object.freeze({
                ...initialRendererState.composer,
                draft: "Guide this exact running turn.",
              }),
              interruptPending: false,
              interruptFeedback: null,
              onInterrupt: noOp,
              steerPending: false,
              steerFeedback: null,
              onSteer: noOp,
            }),
          ));
        const withSteer = (
          steer: WorkbenchCommandView["steer"],
          status: WorkbenchCommandView["status"] = "in-flight",
        ): WorkbenchCommandView =>
          Object.freeze({ ...running!, status, ...(steer === undefined ? {} : { steer }) });

        for (const [name, command] of [
          [
            "accepted, before the command reaches the Runtime at all",
            withSteer(
              Object.freeze({
                status: "unavailable" as const,
                reason:
                  "Same-turn guidance is unavailable. Your draft stays local." as const,
              }),
              "accepted",
            ),
          ],
          [
            "in flight, binding not yet attached",
            withSteer(
              Object.freeze({
                status: "pending" as const,
                reason:
                  "Same-turn guidance becomes available when the Runtime turn starts." as const,
              }),
            ),
          ],
          [
            "attached to a Runtime with no steering contract",
            withSteer(
              Object.freeze({
                status: "unsupported" as const,
                reason:
                  "This Runtime does not support same-turn guidance. Your draft stays local." as const,
              }),
            ),
          ],
        ] as const) {
          const html = composerHtml(command);
          assert.doesNotMatch(html, /guide-button/u, name);
          assert.match(html, /class="send stop-button"/u, name);
        }

        // ...and once a Runtime has proved the contract for this running turn
        // the control stays mounted, including while guidance is momentarily
        // unavailable, so it never disappears mid-turn.
        for (const [name, steer] of [
          [
            "available",
            Object.freeze({
              status: "available" as const,
              steerKey: "turn-steer:00000000-0000-4000-8000-000000000092",
            }),
          ],
          [
            "submitting",
            Object.freeze({
              status: "submitting" as const,
              reason: "Sending guidance to this running turn." as const,
            }),
          ],
          [
            "unavailable on a Runtime that steers",
            Object.freeze({
              status: "unavailable" as const,
              reason:
                "Same-turn guidance is unavailable. Your draft stays local." as const,
            }),
          ],
        ] as const) {
          assert.match(
            composerHtml(withSteer(steer)),
            /<button[^>]*class="send guide-button"/u,
            name,
          );
        }
      },
    );

    await t.test("screen 03 distinguishes fixed failure from recovery in composer, Inspector and statusbar", () => {
      const failed = commandWithStatus("failed", false);
      const recovery = commandWithStatus("recovery-required", false);
      const failedBlocked = clean(renderToString(() =>
        module.BlockedComposer({
          command: failed,
          newSession: initialRendererState.newSession,
          replacementSessionRefusal: null,
          onEnterReplacementSession: noOp,
        }),
      ));
      assert.match(failedBlocked, /class="blocked-glyph is-failed"[^>]*>\s*⚠\s*<\/span>/u);
      assert.match(plainText(failedBlocked), /This Session can't be continued/u);

      const recoveryBlocked = clean(renderToString(() =>
        module.BlockedComposer({
          command: recovery,
          newSession: initialRendererState.newSession,
          replacementSessionRefusal: null,
          onEnterReplacementSession: noOp,
        }),
      ));
      assert.match(recoveryBlocked, /class="blocked-glyph\s*"[^>]*>\s*!\s*<\/span>/u);
      assert.match(plainText(recoveryBlocked), /Outcome unknown/u);

      const ended = commandWithStatus("completed", false);
      const endedBlocked = clean(renderToString(() =>
        module.BlockedComposer({
          command: ended,
          newSession: initialRendererState.newSession,
          replacementSessionRefusal: null,
          onEnterReplacementSession: noOp,
        }),
      ));
      assert.match(endedBlocked, /class="blocked-glyph\s*"[^>]*>\s*⚠\s*<\/span>/u);

      const failedInspector = clean(renderToString(() =>
        module.SessionInspector({
          command: failed,
          view: viewWith(failed),
          onCollapse: noOp,
        }),
      ));
      assert.match(failedInspector, /<dt>Resumable<\/dt><dd[^>]*tone-failed[^>]*>No<\/dd>/u);
      assert.doesNotMatch(plainText(failedInspector), /Neither is downgraded silently/u);

      const recoveryInspector = clean(renderToString(() =>
        module.SessionInspector({
          command: recovery,
          view: viewWith(recovery),
          onCollapse: noOp,
        }),
      ));
      assert.match(recoveryInspector, /<dt>Resumable<\/dt><dd[^>]*tone-warn[^>]*>No<\/dd>/u);

      const failedStatus = clean(renderToString(() =>
        module.WorkbenchStatusbar({
          view: viewWith(failed),
          selected: failed,
          profile: initialRendererState.profile,
          surface: "project",
          runtimeUnavailable: false,
          startingNewSession: false,
        }),
      ));
      assert.match(failedStatus, /class="statusbar"/u);
      assert.match(
        failedStatus,
        /class="sb-item truncate status-intensity is-terminal" title="Maximum"/u,
      );
      assert.match(failedStatus, /class="sb-item sb-hide-narrow status-failed\s*"/u);
      assert.match(plainText(failedStatus), /Session failed/u);
      const recoveryStatus = clean(renderToString(() =>
        module.WorkbenchStatusbar({
          view: viewWith(recovery),
          selected: recovery,
          profile: initialRendererState.profile,
          surface: "project",
          runtimeUnavailable: false,
          startingNewSession: false,
        }),
      ));
      assert.match(recoveryStatus, /status-recovery/u);
      assert.match(plainText(recoveryStatus), /Recovery required/u);

      const interrupted = Object.freeze({
        ...failed,
        failureCategory: "interrupted" as const,
        session: Object.freeze({
          ...failed.session!,
          resumable: true,
          selectionKey:
            "session-selection:00000000-0000-4000-8000-000000000091",
          timeline: Object.freeze([
            Object.freeze({
              kind: "turn-interrupted" as const,
              status: "interrupted" as const,
            }),
          ]),
        }),
      });
      const interruptedTranscript = clean(renderToString(() =>
        module.SessionTranscript({ command: interrupted }),
      ));
      assert.match(
        plainText(interruptedTranscript),
        /This Agent Session is intact and can continue\./u,
      );
      assert.doesNotMatch(
        plainText(interruptedTranscript),
        /This Session cannot be continued/u,
      );
      const interruptedStatus = clean(renderToString(() =>
        module.WorkbenchStatusbar({
          view: viewWith(interrupted),
          selected: interrupted,
          profile: initialRendererState.profile,
          surface: "project",
          runtimeUnavailable: false,
          startingNewSession: false,
        }),
      ));
      assert.match(interruptedStatus, /status-interrupted/u);
      assert.match(plainText(interruptedStatus), /Turn interrupted/u);
    });

    await t.test("screen 05 zero-catalog outcome directs to the sole Settings rail entry", async () => {
      const zeroProfile = Object.freeze({
        ...initialRendererState.profile,
        phase: "unavailable" as const,
        result: Object.freeze({
          ok: false as const,
          endpointDiscovery: publicRuntimeEndpointDiscovery([
            {
              endpointId: "codex-desktop",
              category: "authentication-required",
            },
            {
              endpointId: "claude-code-desktop",
              category: "inspection-failed",
            },
          ]),
          error: Object.freeze({
            category: "profile-unavailable" as const,
            message: "Catalogs unavailable.",
          }),
        }),
        feedback: "Catalogs unavailable.",
      });
      const popover = clean(renderToString(() =>
        module.ProfilePopover({
          kind: "endpoint",
          profile: zeroProfile,
          endpoints: [],
          selectedEndpoint: undefined,
          models: [],
          selectedModel: undefined,
          selectedEndpointKey: null,
          selectedModelKey: null,
          selectedWorkIntensityKey: null,
          selectedExecutionModeKey: null,
          selectedAccessModeKey: null,
          onEndpoint: noOp,
          onModel: noOp,
          onWorkIntensity: noOp,
          onExecutionMode: noOp,
          onAccessMode: noOp,
          onProviders: noOp,
          onClose: noOp,
        }),
      ));
      assert.match(plainText(popover), /Endpoint 0/u);
      assert.doesNotMatch(popover, /Review provider status from Settings in the Project rail\./u);
      assert.doesNotMatch(popover, /Open Providers|<button[^>]*>\s*Open Settings/u);
      assert.doesNotMatch(plainText(popover), /Re-check|Retry|Reload/u);

      const source = await readFile(
        new URL("../../src/workbench-shell/renderer/composer.tsx", import.meta.url),
        "utf8",
      );
      const composerSource = source.slice(
        source.indexOf("const DirectInputComposer:"),
        source.indexOf("const ProfileControlChips:"),
      );
      assert.doesNotMatch(composerSource, /onProviders=|props\.onProviders/u);
    });

    await t.test("screen 06 keeps Catalog unknown while endpoint inspection is not-inspected", () => {
      const baseRow = Object.freeze({
        endpointId: "codex-desktop",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        statusLabel: "Not inspected",
        detail: "This endpoint has not been inspected.",
        category: "not-inspected",
        endpoint: null,
      });
      const authentication = Object.freeze({
        authentication: "unknown",
        effect: "idle",
      });
      const notInspected = clean(renderToString(() =>
        module.ProviderCard({ row: baseRow, authentication }),
      ));
      assert.match(notInspected, /<dt>Catalog<\/dt><dd[^>]*>Not inspected<\/dd>/u);

      const unavailable = clean(renderToString(() =>
        module.ProviderCard({
          authentication,
          row: Object.freeze({
            ...baseRow,
            statusLabel: "Inspection failed",
            category: "inspection-failed",
          }),
        }),
      ));
      assert.match(unavailable, /<dt>Catalog<\/dt><dd[^>]*>Unavailable<\/dd>/u);

      const available = clean(renderToString(() =>
        module.ProviderCard({
          authentication,
          row: Object.freeze({
            ...baseRow,
            statusLabel: "Catalog ready",
            category: "catalog-ready",
            endpoint: Object.freeze({ models: Object.freeze([]) }),
          }),
        }),
      ));
      assert.match(available, /<dt>Catalog<\/dt><dd[^>]*tone-ok[^>]*>Available<\/dd>/u);
    });

    await t.test("shared CSS keeps design spacing, bounded cards and terminal widths", async () => {
      const styles = await readFile(
        new URL("../../src/workbench-shell/renderer/styles.css", import.meta.url),
        "utf8",
      );
      const integration = styles.slice(styles.indexOf("SolidJS renderer integration"));
      assert.doesNotMatch(integration, /\.turn-body\s*\{\s*padding:/u);
      assert.doesNotMatch(integration, /\.event-log\s*\{\s*margin:\s*0/u);
      assert.match(styles, /\.timeline-tail-spacer\s*\{\s*height:\s*8px;\s*\}/u);
      assert.match(styles, /\.empty-project-card\s*\{\s*max-width:\s*560px;\s*\}/u);
      assert.match(styles, /\.empty-project-card\s*>\s*p\s*\{\s*max-width:\s*52ch;\s*\}/u);
      assert.match(styles, /\.status-intensity\s*\{\s*max-width:\s*250px;\s*\}/u);
      const compact = styles.slice(styles.indexOf("@media (max-width: 620px)"));
      assert.match(
        compact,
        /\.project-actions-wide\s*\{\s*display:\s*none;\s*\}[\s\S]*?\.project-actions-compact\s*\{\s*display:\s*flex;\s*\}/u,
      );
      assert.match(
        styles,
        /\.status-intensity\.is-terminal\s*\{\s*max-width:\s*230px;\s*\}/u,
      );
      assert.match(styles, /\.status-failed\s+\.v\s*\{\s*color:\s*var\(--err\);\s*\}/u);
      assert.match(styles, /\.status-recovery\s+\.v\s*\{\s*color:\s*var\(--warn\);\s*\}/u);
    });
  });
});

function directComposerProps(
  view: WorkbenchHostedProjectView,
  selected: WorkbenchCommandView | undefined,
): Readonly<Record<string, unknown>> {
  return {
    view,
    selected,
    composer: initialRendererState.composer,
    profile: initialRendererState.profile,
    newSession: initialRendererState.newSession,
    projectSwitch: initialRendererState.projectSwitch,
    projectOpen: initialRendererState.projectOpen,
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
  };
}

function commandWithStatus(
  status: WorkbenchCommandView["status"],
  resumable: boolean,
): WorkbenchCommandView {
  const seed = visualFixture.commands[0];
  assert.ok(seed?.session);
  return Object.freeze({
    ...seed,
    key: `command-static-${status}`,
    status,
    session: Object.freeze({
      ...seed.session,
      resumable,
      selectionKey: resumable ? seed.session.selectionKey : null,
    }),
  });
}

function viewWith(command: WorkbenchCommandView): WorkbenchHostedProjectView {
  return Object.freeze({
    ...visualFixture,
    commands: Object.freeze([command]),
    initialSelectionKey: command.key,
  });
}

function clean(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/gu, "");
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function withStaticFidelityModule(
  assertion: (module: StaticFidelityModule) => Promise<void>,
): Promise<void> {
  const exposeStaticFidelity: Plugin = {
    name: "expose-static-fidelity-seams",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (normalizedId.endsWith("/src/workbench-shell/renderer/composer.tsx")) {
        return source.replace(
          "const ProfilePopover",
          "export const ProfilePopover",
        );
      }
      if (normalizedId.endsWith("/src/workbench-shell/renderer/stage.tsx")) {
        return source.replace(
          "const EmptyProjectState",
          "export const EmptyProjectState",
        );
      }
      if (normalizedId.endsWith("/src/workbench-shell/renderer/settings.tsx")) {
        return source.replace(
          "const ProviderCard",
          "export const ProviderCard",
        );
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeStaticFidelity, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const composerModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/composer.tsx",
    );
    const stageModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/stage.tsx",
    );
    const settingsModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/settings.tsx",
    );
    const inspectorModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/inspector.tsx",
    );
    const transcriptModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript.tsx",
    );
    const chromeModule = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/chrome.tsx",
    );
    await assertion({
      ...composerModule,
      ...stageModule,
      ...settingsModule,
      ...inspectorModule,
      ...transcriptModule,
      ...chromeModule,
    } as unknown as StaticFidelityModule);
  } finally {
    await server.close();
  }
}
