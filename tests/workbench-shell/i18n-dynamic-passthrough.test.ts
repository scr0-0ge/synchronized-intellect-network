import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  chromium,
  type Browser,
  type Page,
} from "playwright";
import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import type {
  WorkbenchCommandView,
  WorkbenchHostedProjectView,
  WorkbenchModelOption,
  WorkbenchRuntimeEndpointOption,
  WorkbenchTimelineEvent,
} from "../../src/workbench-shell/contract.ts";
import type {
  HistoryRecoveryBrowseItem,
  HistoryRecoveryBrowseResult,
} from "../../src/workbench-shell/history-recovery-contract.ts";
import type { WorkbenchRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import type { WorkbenchRemovalFeedback } from "../../src/workbench-shell/renderer/removal-presentation.ts";
import {
  createViteBrowserTestServer,
  createViteSsrTestServer,
} from "../helpers/vite-server.ts";
import {
  openedProjectVisualFixture,
  visualFixture,
} from "./visual-harness/fixture.ts";

type RenderedComponent = (
  props: Readonly<Record<string, unknown>>,
) => unknown;

interface DynamicPassthroughModule {
  readonly ProjectRail: RenderedComponent;
  readonly beginOpenProject: (
    state: WorkbenchRendererState,
  ) => WorkbenchRendererState;
  readonly completeOpenProject: (
    state: WorkbenchRendererState,
    result: Readonly<{
      ok: true;
      status: "opened";
      message: "Project was opened.";
    }>,
  ) => WorkbenchRendererState;
  readonly initialRendererState: WorkbenchRendererState;
  readonly replaceProjectResult: (
    state: WorkbenchRendererState,
    result: Readonly<{ ok: true; view: WorkbenchHostedProjectView }>,
  ) => WorkbenchRendererState;
  readonly sessionMetadataFeedback: (
    operation: Readonly<{ readonly kind: "archive" }>,
    result: Readonly<{ readonly status: "archived" }>,
  ) => WorkbenchRemovalFeedback;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
}

interface TranscriptPassthroughModule {
  readonly SessionTranscript: RenderedComponent;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
}

interface CatalogPassthroughModule {
  readonly ProfileControlChips: RenderedComponent;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
}

interface ComposerLocalizationModule {
  readonly DirectInputComposer: RenderedComponent;
  readonly dynamicCopy: {
    readonly submission: { readonly accepted: string };
  };
  readonly initialRendererState: WorkbenchRendererState;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
  readonly workbenchLocalizedText: (
    key: string,
    resolve: () => string,
  ) => unknown;
}

interface ComposerErrorVisibilityModule {
  readonly DirectInputComposer: RenderedComponent;
  readonly dynamicCopy: {
    readonly submission: { readonly unavailable: string };
  };
  readonly initialRendererState: WorkbenchRendererState;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
  readonly workbenchLocalizedText: (
    key: string,
    resolve: () => string,
  ) => unknown;
}

interface HistoryLocalizationModule {
  readonly RecoveryBrowseState: RenderedComponent;
  readonly RecoveryList: RenderedComponent;
  readonly dynamicCopy: {
    readonly projectCopy: (ordinal: number) => string;
  };
  readonly setLocale: (locale: "en" | "zh-CN") => void;
  readonly workbenchLocalizedText: (
    key: string,
    resolve: () => string,
  ) => unknown;
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;

test("stored Project-open feedback resolves again when the renderer locale changes", async () => {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/project-rail.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/view-model.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/session-metadata-presentation.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as DynamicPassthroughModule;

    module.setLocale("en");
    const ready = module.replaceProjectResult(module.initialRendererState, {
      ok: true,
      view: visualFixture,
    });
    const opening = module.beginOpenProject(ready);
    const viewArrived = module.replaceProjectResult(opening, {
      ok: true,
      view: openedProjectVisualFixture,
    });
    const opened = module.completeOpenProject(viewArrived, {
      ok: true,
      status: "opened",
      message: "Project was opened.",
    });

    assert.equal(
      typeof opened.projectOpen.feedback === "string"
        ? null
        : opened.projectOpen.feedback?.key,
      "project.opened",
    );
    const storedMetadataFeedback = module.sessionMetadataFeedback(
      { kind: "archive" },
      { status: "archived" },
    );
    const english = renderProjectRail(
      module.ProjectRail,
      opened.projectOpen,
      storedMetadataFeedback,
    );
    assert.match(english, />Projects<!--\/--> /u);
    assert.match(english, />Project was opened\.<\/p>/u);
    assert.equal(
      renderedClassText(english, "rail-feedback rail-removal-notice"),
      "Agent Session archived.",
    );

    module.setLocale("zh-CN");
    const chinese = renderProjectRail(
      module.ProjectRail,
      opened.projectOpen,
      storedMetadataFeedback,
    );
    assert.match(chinese, />项目<!--\/--> /u);
    assert.match(chinese, />项目已打开。<\/p>/u);
    assert.equal(
      renderedClassText(chinese, "rail-feedback rail-removal-notice"),
      "智能体会话已归档。",
    );
    assert.doesNotMatch(chinese, /Project was opened\./u);

    module.setLocale("en");
    const englishAgain = renderProjectRail(
      module.ProjectRail,
      opened.projectOpen,
      storedMetadataFeedback,
    );
    assert.equal(englishAgain, english);
  } finally {
    await server.close();
  }
});

test("an already-mounted Project rail updates stored identities in place when locale changes", async () => {
  const mountedProbePage: Plugin = {
    name: "serve-worker-445-mounted-i18n-probe",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/__worker445_i18n_probe") {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html>
<html lang="en">
  <body>
    <main id="probe"></main>
    <script type="module" src="/tests/workbench-shell/i18n-mounted-probe.tsx"></script>
  </body>
</html>`);
      });
    },
  };
  const server = await createViteBrowserTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [mountedProbePage, solid()],
    root: repositoryRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  let browser: Browser | undefined;

  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address !== null && typeof address === "object");
    browser = await chromium.launch({
      executablePath: installedChromiumExecutable(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${address.port}/__worker445_i18n_probe`,
    );
    await page.waitForFunction(
      () =>
        typeof (
          window as unknown as {
            __worker445I18nProbe?: unknown;
          }
        ).__worker445I18nProbe === "object",
    );

    assert.deepEqual(await mountedProbeObservation(page), {
      documentLocale: "en",
      historyFeedback:
        "This Project now shows the chosen history. The previous one is untouched on disk and can be adopted back.",
      projectFeedback: "Project was opened.",
      removalConfirm: "Remove Project",
      removalDescription:
        "Remove Atlas Fieldnotes from this Workbench? Its folder and files will stay on disk.",
      removalFeedback: "Agent Session deleted.",
      removalTitle: "Remove Project from Workbench?",
      sameNodes: true,
    });

    await page.evaluate(() =>
      (
        window as unknown as {
          __worker445I18nProbe: {
            setLocale: (locale: "en" | "zh-CN") => void;
          };
        }
      ).__worker445I18nProbe.setLocale("zh-CN"),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".rail-removal-notice")?.textContent ===
        "智能体会话已删除。",
    );
    assert.deepEqual(await mountedProbeObservation(page), {
      documentLocale: "zh-CN",
      historyFeedback:
        "此项目现已显示所选历史。上一份历史在磁盘上保持不变，可随时切换回来。",
      projectFeedback: "项目已打开。",
      removalConfirm: "移除项目",
      removalDescription:
        "从此 Workbench 中移除 Atlas Fieldnotes？其文件夹和文件仍会保留在磁盘上。",
      removalFeedback: "智能体会话已删除。",
      removalTitle: "从 Workbench 中移除项目？",
      sameNodes: true,
    });

    await page.evaluate(() =>
      (
        window as unknown as {
          __worker445I18nProbe: {
            setLocale: (locale: "en" | "zh-CN") => void;
          };
        }
      ).__worker445I18nProbe.setLocale("en"),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".rail-removal-notice")?.textContent ===
        "Agent Session deleted.",
    );
    assert.deepEqual(await mountedProbeObservation(page), {
      documentLocale: "en",
      historyFeedback:
        "This Project now shows the chosen history. The previous one is untouched on disk and can be adopted back.",
      projectFeedback: "Project was opened.",
      removalConfirm: "Remove Project",
      removalDescription:
        "Remove Atlas Fieldnotes from this Workbench? Its folder and files will stay on disk.",
      removalFeedback: "Agent Session deleted.",
      removalTitle: "Remove Project from Workbench?",
      sameNodes: true,
    });
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("Runtime and user transcript text stays verbatim while its Workbench envelope changes locale", async () => {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/transcript.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as TranscriptPassthroughModule;
    const seed = visualFixture.commands[0];
    assert.ok(seed?.session);
    const runtimeText =
      "RuNtImE said: Catalog / Phosphor / token / provider / command — 原样!?";
    const userText = "UsEr typed: provider/token — 原样保留!?";
    const timeline = Object.freeze([
      Object.freeze({ kind: "user-message" as const, text: userText }),
      Object.freeze({ kind: "session-started" as const }),
      Object.freeze({ kind: "turn-started" as const }),
      Object.freeze({ kind: "agent-message" as const, text: runtimeText }),
      Object.freeze({
        kind: "turn-completed" as const,
        status: "completed" as const,
      }),
    ] satisfies readonly WorkbenchTimelineEvent[]);
    const command = Object.freeze({
      ...seed,
      key: "command:runtime-passthrough",
      label: "PeRsIsTeD command 原样?!",
      status: "completed" as const,
      session: Object.freeze({
        ...seed.session,
        timeline,
      }),
    }) satisfies WorkbenchCommandView;

    module.setLocale("en");
    const english = renderToString(() =>
      module.SessionTranscript({ command }),
    );
    assert.match(english, />Session started</u);
    assert.match(english, />You</u);
    assert.equal(occurrences(english, runtimeText), 1);
    assert.equal(occurrences(english, userText), 1);

    module.setLocale("zh-CN");
    const chinese = renderToString(() =>
      module.SessionTranscript({ command }),
    );
    assert.match(chinese, />会话已开始</u);
    assert.match(chinese, />你</u);
    assert.equal(occurrences(chinese, runtimeText), 1);
    assert.equal(occurrences(chinese, userText), 1);
    assert.doesNotMatch(chinese, /运行时说：目录/u);

    module.setLocale("en");
    assert.equal(
      renderToString(() => module.SessionTranscript({ command })),
      english,
    );
  } finally {
    await server.close();
  }
});

test("Runtime catalog labels, including lowercase default, stay verbatim in both locales", async () => {
  const exposeProfileControlChips: Plugin = {
    name: "expose-profile-control-chips-for-passthrough",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/composer.tsx")
      ) {
        return source.replace(
          "const ProfileControlChips",
          "export const ProfileControlChips",
        );
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeProfileControlChips, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/composer.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as CatalogPassthroughModule;
    const model = Object.freeze({
      key: "model:raw",
      label: "gPt-Ω/模型·RAW?!",
      provenanceLabel: null,
      workIntensityLabel: "CaTaLoG/强度·RAW?!",
      workIntensities: Object.freeze([
        Object.freeze({ key: "intensity:default", label: "default" }),
      ]),
    }) satisfies WorkbenchModelOption;
    const endpoint = Object.freeze({
      endpointId: "codex-desktop" as const,
      key: "endpoint:raw",
      runtimeFamilyLabel: "PrOvIdEr/提供方·RAW?!",
      endpointLabel: "EnDpOiNt/端点·RAW?!",
      models: Object.freeze([model]),
      executionModes: Object.freeze([]),
      accessModes: Object.freeze([]),
    }) satisfies WorkbenchRuntimeEndpointOption;
    const props = Object.freeze({
      profile: Object.freeze({ phase: "ready" as const }),
      endpoints: Object.freeze([endpoint]),
      selectedEndpoint: endpoint,
      selectedModel: model,
      selectedIntensityLabel: "default",
      pending: false,
      endpointLocked: true,
      lockedEndpointRuntimeFamilyLabel: endpoint.runtimeFamilyLabel,
      lockedEndpointLabel: endpoint.endpointLabel,
      openPopover: null,
      onOpen: noOp,
    });

    module.setLocale("en");
    const english = renderToString(() =>
      module.ProfileControlChips(props),
    );
    assert.match(english, />Model<\/span>/u);
    assertCatalogLabels(english);
    assert.doesNotMatch(english, />Default<\/span>/u);

    module.setLocale("zh-CN");
    const chinese = renderToString(() =>
      module.ProfileControlChips(props),
    );
    assert.match(chinese, />模型<\/span>/u);
    assertCatalogLabels(chinese);
    assert.doesNotMatch(chinese, />默认<\/span>/u);

    module.setLocale("en");
    assert.equal(
      renderToString(() => module.ProfileControlChips(props)),
      english,
    );
  } finally {
    await server.close();
  }
});

test("closed composer and interrupt vocabulary renders from identity in the current locale", async () => {
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/composer.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/view-model.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/presentation-text.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/copy/dynamic-copy.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as ComposerLocalizationModule;
    const storedFeedback = module.workbenchLocalizedText(
      "submission.accepted",
      () => module.dynamicCopy.submission.accepted,
    );
    const base = module.initialRendererState;
    const composerProps = Object.freeze({
      view: visualFixture,
      selected: undefined,
      composer: Object.freeze({
        ...base.composer,
        feedback: storedFeedback,
      }),
      profile: base.profile,
      newSession: base.newSession,
      projectSwitch: base.projectSwitch,
      projectOpen: base.projectOpen,
      centered: false,
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
    });

    module.setLocale("en");
    const english = renderToString(() =>
      module.DirectInputComposer(composerProps),
    );
    assert.equal(
      renderedIdText(english, "direct-input-feedback"),
      "Direct input was durably accepted.",
    );

    module.setLocale("zh-CN");
    const chinese = renderToString(() =>
      module.DirectInputComposer(composerProps),
    );
    assert.equal(
      renderedIdText(chinese, "direct-input-feedback"),
      "已持久接受直接输入。",
    );
    assert.doesNotMatch(chinese, /Direct input was durably accepted\./u);

    const seed = visualFixture.commands[0];
    assert.ok(seed);
    const active = Object.freeze({
      ...seed,
      status: "in-flight" as const,
      interrupt: Object.freeze({
        status: "unsupported" as const,
        reason: "This Runtime does not support interruption." as const,
      }),
    }) satisfies WorkbenchCommandView;
    const chineseInterrupt = renderToString(() =>
      module.DirectInputComposer({ ...composerProps, selected: active }),
    );
    assert.match(chineseInterrupt, /此运行时不支持中断。/u);
    assert.doesNotMatch(
      chineseInterrupt,
      /This Runtime does not support interruption\./u,
    );

    module.setLocale("en");
    assert.equal(
      renderToString(() => module.DirectInputComposer(composerProps)),
      english,
    );
  } finally {
    await server.close();
  }
});

test("a failed submission renders its error sentence in the composer foot in both locales", async () => {
  // WO08-A: the owner reported a GLM send "did nothing visible". The view
  // model already preserves the draft and re-arms submission on
  // submission-unavailable (renderer-view-model.test.ts); this pins the
  // rendered leg — the foot sentence and the textarea's error state — so a
  // failed send can never again be silent in the composed UI.
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/composer.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/view-model.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/presentation-text.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/copy/dynamic-copy.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as ComposerErrorVisibilityModule;
    const failureFeedback = module.workbenchLocalizedText(
      "submission.unavailable",
      () => module.dynamicCopy.submission.unavailable,
    );
    const base = module.initialRendererState;
    const composerProps = Object.freeze({
      view: visualFixture,
      selected: undefined,
      composer: Object.freeze({
        ...base.composer,
        draft: "Keep this draft after the failed send.",
        phase: "error" as const,
        feedback: failureFeedback,
      }),
      profile: base.profile,
      newSession: base.newSession,
      projectSwitch: base.projectSwitch,
      projectOpen: base.projectOpen,
      centered: false,
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
    });

    module.setLocale("en");
    const english = renderToString(() =>
      module.DirectInputComposer(composerProps),
    );
    assert.equal(
      renderedIdText(english, "direct-input-feedback"),
      "Direct input could not be durably accepted. Keep your draft and try again.",
    );
    assert.match(english, /aria-invalid="true"/u);

    module.setLocale("zh-CN");
    const chinese = renderToString(() =>
      module.DirectInputComposer(composerProps),
    );
    assert.equal(
      renderedIdText(chinese, "direct-input-feedback"),
      "无法持久接受直接输入。请保留草稿并重试。",
    );
    assert.match(chinese, /aria-invalid="true"/u);
    assert.doesNotMatch(
      chinese,
      /Direct input could not be durably accepted\./u,
    );
  } finally {
    await server.close();
  }
});

test("closed recovery codes, ordinals, and statuses render in the current locale", async () => {
  const exposeRecoverySeams: Plugin = {
    name: "expose-recovery-localization-seams",
    enforce: "pre",
    transform(source, id) {
      if (
        id
          .replaceAll("\\", "/")
          .endsWith(
            "/src/workbench-shell/renderer/history-recovery-settings.tsx",
          )
      ) {
        return source
          .replace(
            "const RecoveryBrowseState",
            "export const RecoveryBrowseState",
          )
          .replace("const RecoveryList", "export const RecoveryList");
      }
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposeRecoverySeams, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = {
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/history-recovery-settings.tsx",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/presentation-text.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/copy/dynamic-copy.ts",
      )),
      ...(await server.ssrLoadModule(
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as HistoryLocalizationModule;
    const items = Object.freeze([
      Object.freeze({
        kind: "session" as const,
        ordinal: 7,
        label: "Session 7",
        sessionKey: "opaque-session",
        status: "recovery-required" as const,
        commandCount: 2,
        turnCount: 3,
      }),
      Object.freeze({
        kind: "turn" as const,
        ordinal: 8,
        label: "Turn 8",
        status: "completed" as const,
        eventCount: 4,
      }),
    ] satisfies readonly HistoryRecoveryBrowseItem[]);
    const ready = Object.freeze({
      version: 1 as const,
      kind: "browse" as const,
      requestKey: "request",
      status: "ready" as const,
      snapshotKey: "snapshot",
      branch: "turns" as const,
      parentKey: "parent",
      page: Object.freeze({
        after: null,
        nextAfter: null,
        totalCount: 2,
        items,
      }),
    }) satisfies HistoryRecoveryBrowseResult;
    const unavailable = Object.freeze({
      version: 1 as const,
      kind: "browse" as const,
      requestKey: "request-unavailable",
      status: "unavailable" as const,
      problem: Object.freeze({
        code: "permission-denied" as const,
        message:
          "The recovery source could not be read with current permissions.",
      }),
    }) satisfies HistoryRecoveryBrowseResult;
    const heading = module.workbenchLocalizedText(
      "history.project-label",
      () => module.dynamicCopy.projectCopy(2),
    );
    const render = (): string =>
      renderToString(() =>
        module.RecoveryList({
          heading,
          result: ready,
          items,
        }),
      ) +
      renderToString(() =>
        module.RecoveryBrowseState({ result: unavailable }),
      );

    module.setLocale("en");
    const english = render();
    assert.equal(renderedTagText(english, "h3"), "Project 2");
    assertRenderedStrongSpanPairs(english, [
      {
        label: "Session 7",
        detail: "recovery-required · 3 turns",
      },
      { label: "Turn 8", detail: "completed · 4 events" },
    ]);
    assert.equal(
      renderedClassText(english, "history-recovery-problem"),
      "The recovery source could not be read with current permissions.",
    );

    module.setLocale("zh-CN");
    const chinese = render();
    assert.equal(renderedTagText(chinese, "h3"), "项目 2");
    assertRenderedStrongSpanPairs(chinese, [
      { label: "会话 7", detail: "需要恢复 · 3 个回合" },
      { label: "回合 8", detail: "已完成 · 4 个事件" },
    ]);
    assert.equal(
      renderedClassText(chinese, "history-recovery-problem"),
      "当前权限无法读取恢复源。",
    );
    assert.doesNotMatch(chinese, /Session 7|recovery-required/u);

    module.setLocale("en");
    assert.equal(render(), english);
  } finally {
    await server.close();
  }
});

function renderProjectRail(
  ProjectRail: RenderedComponent,
  projectOpen: WorkbenchRendererState["projectOpen"],
  removalNotice: WorkbenchRemovalFeedback | null = null,
): string {
  return renderToString(() =>
    ProjectRail({
      view: openedProjectVisualFixture,
      selectedKey: openedProjectVisualFixture.initialSelectionKey,
      runtimeUnavailable: false,
      projectSwitch: Object.freeze({
        phase: "idle",
        targetIndex: null,
        selectionAccepted: false,
        viewArrived: false,
        feedback: null,
      }),
      projectOpen,
      projectScopeEpoch: 0,
      canCreateProject: () => true,
      onCreateProject: noOp,
      canOpenProject: () => true,
      onOpenProject: noOp,
      canSelectProject: () => true,
      onSelectProject: noOp,
      onSelect: noOp,
      onEnterNewSession: noOp,
      surface: "project",
      onSurface: noOp,
      draftBlocked: false,
      actionBlocked: false,
      sessionMetadataPending: false,
      onMutateSessionMetadata: async () => ({ status: "failed" }),
      removalPending: false,
      removalNotice,
      onRequestSessionRemoval: noOp,
      onRequestProjectRemoval: noOp,
    }),
  );
}

function renderedClassText(html: string, className: string): string {
  const match = new RegExp(
    `<[^>]+class="${className.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "u",
  ).exec(html);
  assert.ok(match, `rendered element with class ${className}`);
  return match[1]!
    .replace(/<!--(?:\$|\/)-->/gu, "")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

function renderedIdText(html: string, id: string): string {
  const match = new RegExp(
    `<[^>]+id="${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "u",
  ).exec(html);
  assert.ok(match, `rendered element with id ${id}`);
  return renderedInnerText(match[1]!);
}

function renderedTagText(html: string, tagName: string): string {
  const match = new RegExp(
    `<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "u",
  ).exec(html);
  assert.ok(match, `rendered ${tagName} element`);
  return renderedInnerText(match[1]!);
}

function assertRenderedStrongSpanPairs(
  html: string,
  expected: readonly Readonly<{ label: string; detail: string }>[],
): void {
  const rendered = html.replace(/<!--(?:\$|\/)-->/gu, "");
  for (const row of expected) {
    assert.equal(
      occurrences(rendered, `<strong>${row.label}</strong>`),
      1,
      `exact rendered recovery label ${row.label}`,
    );
    assert.equal(
      occurrences(rendered, `<span>${row.detail}</span>`),
      1,
      `exact rendered recovery detail ${row.detail}`,
    );
  }
}

function renderedInnerText(html: string): string {
  return html
    .replace(/<!--(?:\$|\/)-->/gu, "")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function assertCatalogLabels(html: string): void {
  const renderedText = html
    .replace(/<!--(?:\$|\/)-->/gu, "")
    .replace(/<[^>]+>/gu, "");
  for (const [seam, exactLabel] of [
    ["runtime family", "PrOvIdEr/提供方·RAW?!"],
    ["endpoint", "EnDpOiNt/端点·RAW?!"],
    ["model", "gPt-Ω/模型·RAW?!"],
    ["catalog control", "CaTaLoG/强度·RAW?!"],
    ["catalog option", "default"],
  ] as const) {
    assert.ok(
      renderedText.includes(exactLabel),
      `${seam} label stays byte-for-byte in rendered visible text`,
    );
  }
}

async function mountedProbeObservation(
  page: Page,
): Promise<Readonly<{
  documentLocale: string;
  historyFeedback: string | null | undefined;
  projectFeedback: string | null | undefined;
  removalConfirm: string | null | undefined;
  removalDescription: string | null | undefined;
  removalFeedback: string | null | undefined;
  removalTitle: string | null | undefined;
  sameNodes: boolean;
}>> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __worker445I18nProbe: { sameNodes: () => boolean };
      }
    ).__worker445I18nProbe;
    return {
      documentLocale: document.documentElement.lang,
      historyFeedback: document.querySelector(".project-histories-notice")
        ?.textContent,
      projectFeedback: document.querySelector(
        ".rail-feedback:not(.rail-removal-notice)",
      )?.textContent,
      removalConfirm: document.querySelector(
        ".removal-dialog:not(.project-histories-dialog) .removal-confirm-button",
      )?.textContent,
      removalDescription: document.querySelector(
        ".removal-dialog:not(.project-histories-dialog) h2 + p",
      )?.textContent,
      removalFeedback: document.querySelector(".rail-removal-notice")
        ?.textContent,
      removalTitle: document.querySelector(
        ".removal-dialog:not(.project-histories-dialog) h2",
      )?.textContent,
      sameNodes: probe.sameNodes(),
    };
  });
}

function installedChromiumExecutable(): string {
  const candidates = [
    chromium.executablePath(),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  assert.ok(
    executable,
    `No installed Chromium executable was found: ${candidates.join(", ")}`,
  );
  return executable;
}
