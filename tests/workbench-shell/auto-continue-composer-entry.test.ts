import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import { parseSessionContinuationPlan } from "../../src/coordinator/session-continuation-plan.ts";
import type { WorkbenchHostedProjectView } from "../../src/workbench-shell/contract.ts";
import type { WorkbenchRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
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
