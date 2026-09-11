import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { sanitizeWorkbenchHostedProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { initialRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import { continuationProgressFixture } from "./visual-harness/continuation-progress-fixture.ts";
import { continuationStopFixture } from "./visual-harness/continuation-stop-fixture.ts";

test("the named product progress field is exactly cloned without changing completed Runtime results", () => {
  const input = { ok: true as const, view: continuationProgressFixture };
  const result = sanitizeWorkbenchHostedProjectResult(input);
  assert.ok(result.ok && "view" in result);
  const command = result.view.commands[0]!;
  assert.deepEqual(command.continuationProgress, { step: 2, limit: 3 });
  assert.notEqual(command.continuationProgress, input.view.commands[0]!.continuationProgress);
  assert.equal(Object.isFrozen(command.continuationProgress), true);
  assert.equal(command.status, "in-flight");
  assert.equal(command.continuationStop, undefined);
});

test("unknown keys, malformed progress fields, and a non-in-flight status all fail the exact public contract", () => {
  const good = { step: 2, limit: 3 };
  const bad = [undefined, null, [], {},
    { ...good, extra: "not forwarded" }, { ...good, step: "2" }, { ...good, step: 0 },
    { ...good, step: 4 }, { ...good, step: 1.5 }, { ...good, limit: 11 }, { ...good, limit: "3" },
    { ...good, limit: NaN }, { ...good, reason: "not-part-of-progress" },
  ];
  for (const continuationProgress of bad) {
    const result = sanitizeWorkbenchHostedProjectResult({ ok: true, view: {
      ...continuationProgressFixture, commands: [{ ...continuationProgressFixture.commands[0], continuationProgress }],
    } });
    assert.equal(result.ok, false, JSON.stringify(continuationProgress));
  }
  const result = sanitizeWorkbenchHostedProjectResult({ ok: true, view: {
    ...continuationProgressFixture, commands: [{ ...continuationProgressFixture.commands[0], status: "completed" }],
  } });
  assert.equal(result.ok, false, "progress must not survive once the command is no longer in flight");
});

test("the actual Stage shows the running step, separately from a stop notice, and never both at once", async () => {
  const server = await createViteSsrTestServer({
    configFile: false, appType: "custom", logLevel: "silent", plugins: [solid({ ssr: true })],
    root: fileURLToPath(new URL("../..", import.meta.url)), server: { middlewareMode: true },
  });
  try {
    const { WorkbenchStage } = await server.ssrLoadModule("/src/workbench-shell/renderer/stage.tsx");
    const { setLocale } = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
    const render = (view = continuationProgressFixture) => renderToString(() => WorkbenchStage({
      ...initialRendererState, view, selected: view.commands[0], active: true,
      runtimeUnavailable: false, inspectorCollapsed: false, replacementSessionRefusal: null,
      canCreateProject: () => true, canOpenProject: () => true,
      onDraft() {}, onSubmit() {}, onCreateProject() {}, onOpenProject() {}, onEnterReplacementSession() {},
    })) as string;
    for (const [locale, heading] of [
      ["en", "Auto-continue 2/3"],
      ["zh-CN", "自动续办 2/3"],
    ]) {
      setLocale(locale);
      const html = render();
      assert.ok(html.includes(heading!));
      assert.match(html, /class="continuation-progress-notice" role="status"/u);
      assert.ok(!html.includes("continuation-stop-notice"), "a running step must not also show a stop notice");
      assert.ok(!render(continuationStopFixture).includes("continuation-progress-notice"),
        "a stopped plan must not also show a running-step notice");
    }
  } finally { await server.close(); }
});
