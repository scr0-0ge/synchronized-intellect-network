import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium, type Browser, type Page } from "playwright";
import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import { parseSessionContinuationPlan } from "../../src/coordinator/session-continuation-plan.ts";
import type { WorkbenchHostedProjectView } from "../../src/workbench-shell/contract.ts";
import type { WorkbenchRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import {
  createViteBrowserTestServer,
  createViteSsrTestServer,
} from "../helpers/vite-server.ts";
import { visualFixture } from "./visual-harness/fixture.ts";

type RenderedComponent = (props: Readonly<Record<string, unknown>>) => unknown;

interface ComposerModule {
  readonly DirectInputComposer: RenderedComponent;
  readonly initialRendererState: WorkbenchRendererState;
  readonly setLocale: (locale: "en" | "zh-CN") => void;
}

interface LocaleExpectation {
  readonly locale: "en" | "zh-CN";
  readonly help: readonly RegExp[];
  readonly syntaxInstruction: string;
  readonly invalid: readonly (readonly [string, RegExp])[];
}

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const noOp = (): void => undefined;
const noHistory = () => null;

test("automatic continuation is discoverable and explains every malformed command in both locales", async () => {
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
        "/src/workbench-shell/renderer/locale.ts",
      )),
    } as unknown as ComposerModule;

    const expectations: readonly LocaleExpectation[] = [
      {
        locale: "en" as const,
        help: [/Automatic continuation/u, /\/auto-continue 2/u, /Do the next verified step\./u],
        syntaxInstruction: "Do the next verified step.",
        invalid: [
          ["/auto-continue 40\nDo the next verified step.", /40 exceeds the maximum of 10 steps/u],
          ["/auto-continue 0\nDo the next verified step.", /whole number from 1 to 10/u],
          ["/auto-continue 2", /line after the step count/u],
          ["/auto-continue 2\n   ", /instruction after the newline non-empty/u],
        ],
      },
      {
        locale: "zh-CN" as const,
        help: [/自动续办/u, /\/auto-continue 2/u, /完成下一个已验证的步骤。/u],
        syntaxInstruction: "完成下一个已验证的步骤。",
        invalid: [
          ["/auto-continue 40\n完成下一个已验证的步骤。", /40 超过最多 10 步/u],
          ["/auto-continue 0\n完成下一个已验证的步骤。", /步数必须是 1 到 10 的整数/u],
          ["/auto-continue 2", /步数后的下一行/u],
          ["/auto-continue 2\n   ", /指令不能为空/u],
        ],
      },
    ];
    for (const expectation of expectations) {
      module.setLocale(expectation.locale);
      const entry = renderComposer(module, "");
      const help = renderedIdText(entry, "auto-continue-help");
      for (const expected of expectation.help) assert.match(help, expected);
      assertRenderedSyntaxParses(help, expectation.syntaxInstruction);

      for (const [draft, expected] of expectation.invalid) {
        const feedback = renderedIdText(
          renderComposer(module, draft),
          "direct-input-feedback",
        );
        assert.match(feedback, expected);
        assert.match(feedback, /\/auto-continue 2/u);
        assert.match(feedback, expectation.help[2]!);
        assertRenderedSyntaxParses(feedback, expectation.syntaxInstruction);
      }
    }
  } finally {
    await server.close();
  }
});

test("the auto-continue footer keeps up with every keystroke, not just the first invalid one", async () => {
  const probeUrl = "/__w196_composer_probe";
  const probeModuleId = "/__w196_composer_probe.tsx";
  const composerKeystrokeProbe: Plugin = {
    name: "serve-worker-196-composer-keystroke-probe",
    configureServer(devServer) {
      devServer.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== probeUrl) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html>
<html lang="en">
  <body>
    <main id="probe"></main>
    <script type="module" src="${probeModuleId}"></script>
  </body>
</html>`);
      });
    },
    resolveId(id) {
      if (id === probeModuleId) return id;
    },
    load(id) {
      if (id !== probeModuleId) return;
      return `
        import { createSignal } from "solid-js";
        import { render } from "solid-js/web";
        import { DirectInputComposer } from "/src/workbench-shell/renderer/composer.tsx";
        import { initialRendererState } from "/src/workbench-shell/renderer/view-model.ts";
        import { visualFixture } from "/tests/workbench-shell/visual-harness/fixture.ts";

        const noOp = () => undefined;
        const noHistory = () => null;
        const state = initialRendererState;
        const [draft, setDraft] = createSignal("");
        const composer = {
          ...state.composer,
          get draft() { return draft(); },
        };
        const host = document.querySelector("#probe");
        if (host === null) throw new Error("missing-w196-probe-host");

        render(
          () => DirectInputComposer({
            view: visualFixture,
            selected: undefined,
            composer,
            profile: state.profile,
            newSession: state.newSession,
            projectSwitch: state.projectSwitch,
            projectOpen: state.projectOpen,
            centered: false,
            onDraft: setDraft,
            onNavigateComposerHistory: noHistory,
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
          host,
        );
      `;
    },
  };

  const server = await createViteBrowserTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [composerKeystrokeProbe, solid()],
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
    await page.goto(`http://127.0.0.1:${address.port}${probeUrl}`);
    const input = page.locator("#direct-input");
    await input.waitFor({ state: "visible" });
    const feedback = page.locator("#direct-input-feedback");

    // Typed one keystroke at a time, never pasted: this is the path
    // 553c2da's fix regressed on (w190 walkthrough after round 31).
    await input.pressSequentially("/auto-continue 40\nW190 do the next step", {
      delay: 5,
    });
    assert.match(
      await feedback.innerText(),
      /40 exceeds the maximum of 10 steps/u,
      "typing an over-limit step count keystroke by keystroke must report the real reason, not the first error the box ever had",
    );
    assert.doesNotMatch(
      await feedback.innerText(),
      /the first line needs one space/u,
      "the stale first-line message must not survive once the input became well-formed apart from the step count",
    );

    // Sanity check for the transition the old test suite already covered
    // (legal count becoming illegal mid-type): typing straight through "4"
    // (legal) into "42" (illegal) must still land on the real reason.
    await input.fill("");
    await input.pressSequentially("/auto-continue 42\nW190 keep going", {
      delay: 5,
    });
    assert.match(
      await feedback.innerText(),
      /42 exceeds the maximum of 10 steps/u,
      "42 typed straight through must report the real reason",
    );
  } finally {
    await browser?.close();
    await server.close();
  }
});

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

function renderComposer(module: ComposerModule, draft: string): string {
  const state = module.initialRendererState;
  return renderToString(() =>
    module.DirectInputComposer({
      view: visualFixture as WorkbenchHostedProjectView,
      selected: undefined,
      composer: Object.freeze({ ...state.composer, draft }),
      profile: state.profile,
      newSession: state.newSession,
      projectSwitch: state.projectSwitch,
      projectOpen: state.projectOpen,
      centered: false,
      onDraft: noOp,
      onNavigateComposerHistory: noHistory,
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

function renderedIdText(html: string, id: string): string {
  const match = new RegExp(
    `<[^>]+id="${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "u",
  ).exec(html);
  assert.ok(match, `rendered element with id ${id}`);
  return match[1]!
    .replace(/<!--(?:\$|\/)-->/gu, "")
    .replace(/<[^>]+>/gu, "")
    .trim();
}

function assertRenderedSyntaxParses(text: string, instruction: string): void {
  const syntax = text.split(/\r?\n/u).slice(-2).join("\n");
  assert.equal(syntax, `/auto-continue 2\n${instruction}`);
  assert.deepEqual(parseSessionContinuationPlan(syntax), {
    steps: 2,
    input: instruction,
  });
}
