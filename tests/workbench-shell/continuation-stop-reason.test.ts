import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { sanitizeWorkbenchHostedProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { initialRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import { continuationBeforeStopFixture, continuationStopFixture } from "./visual-harness/continuation-stop-fixture.ts";

test("the named product stop field is exactly cloned without changing completed Runtime results", () => {
  const input = { ok: true as const, view: continuationStopFixture };
  const result = sanitizeWorkbenchHostedProjectResult(input);
  assert.ok(result.ok && "view" in result);
  const command = result.view.commands[0]!;
  assert.deepEqual(command.continuationStop, { step: 2, limit: 3, reason: "continuation-unavailable" });
  assert.notEqual(command.continuationStop, input.view.commands[0]!.continuationStop);
  assert.equal(Object.isFrozen(command.continuationStop), true);
  assert.equal(command.status, "completed");
  assert.equal(command.failureCategory, undefined);
  assert.deepEqual(command.session?.turns, input.view.commands[0]!.session?.turns);
});

test("unknown keys and malformed known stop fields still fail the exact public contract", () => {
  const good = { step: 2, limit: 3, reason: "continuation-unavailable" };
  const bad = [undefined, null, [], {},
    { ...good, extra: "not forwarded" }, { ...good, step: "2" }, { ...good, step: 0 },
    { ...good, step: 4 }, { ...good, step: 1.5 }, { ...good, limit: 11 }, { ...good, limit: "3" },
    { ...good, limit: NaN }, { ...good, reason: "made-up" }, { ...good, reason: null },
  ];
  for (const continuationStop of bad) {
    const result = sanitizeWorkbenchHostedProjectResult({ ok: true, view: {
      ...continuationStopFixture, commands: [{ ...continuationStopFixture.commands[0], continuationStop }],
    } });
    assert.equal(result.ok, false, JSON.stringify(continuationStop));
  }
  for (const extra of [{ unrelated: true }, { status: "not-a-turn-status" }, { failureCategory: 42 }]) {
    assert.equal(sanitizeWorkbenchHostedProjectResult({ ok: true, view: {
      ...continuationStopFixture, commands: [{ ...continuationStopFixture.commands[0], ...extra }],
    } }).ok, false);
  }
});

test("the actual Stage shows the stop and reason in both languages, separately from Completed", async () => {
  const server = await createViteSsrTestServer({
    configFile: false, appType: "custom", logLevel: "silent", plugins: [solid({ ssr: true })],
    root: fileURLToPath(new URL("../..", import.meta.url)), server: { middlewareMode: true },
  });
  try {
    const { WorkbenchStage } = await server.ssrLoadModule("/src/workbench-shell/renderer/stage.tsx");
    const { setLocale } = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
    const render = (view = continuationStopFixture, fresh = false) => renderToString(() => WorkbenchStage({
      ...initialRendererState, view, selected: view.commands[0], active: true,
      ...(fresh ? { newSession: { phase: "editing", previousSelectionKey: view.commands[0]!.key } } : {}),
      runtimeUnavailable: false, inspectorCollapsed: false, replacementSessionRefusal: null,
      canCreateProject: () => true, canOpenProject: () => true,
      onDraft() {}, onSubmit() {}, onCreateProject() {}, onOpenProject() {}, onEnterReplacementSession() {},
    })) as string;
    for (const [locale, heading, reason, completed] of [
      ["en", "Automatic continuation stopped at 2/3", "This Session is no longer eligible for continuation. No next input was sent.", "Completed"],
      ["zh-CN", "自动续办已停止，停在 2/3", "此会话已不满足续办条件，未发送下一步。", "已完成"],
    ]) {
      setLocale(locale);
      const html = render();
      assert.ok(html.includes(heading!) && html.includes(reason!));
      assert.ok(html.includes(`turn-state`) && html.includes(completed!));
      assert.match(html, /class="continuation-stop-notice" role="status"/u);
      const unknownHtml = render({ ...continuationStopFixture, commands: [{
        ...continuationStopFixture.commands[0]!, status: "recovery-required",
        continuationStop: { step: 2, limit: 3, reason: "turn-not-completed" },
      }] });
      assert.ok(unknownHtml.includes(locale === "en" ? "not confirmed completed" : "未被确认已完成"),
        "an unknown outcome must not be described as a proven Runtime failure");
      assert.ok(!render(continuationBeforeStopFixture).includes("continuation-stop-notice"));
      assert.ok(!render(continuationStopFixture, true).includes("continuation-stop-notice"), "a different composer target must not inherit the old stop notice");
    }
  } finally { await server.close(); }
});
