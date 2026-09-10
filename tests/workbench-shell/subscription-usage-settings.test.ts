import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { initialRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import { captureNames, replayUsage } from "../agent-runtime/claude-usage-replay.ts";
import { sanitizeWorkbenchSubscriptionUsageResult } from "../../src/workbench-shell/result-sanitizer.ts";

test("Settings identifies the subscription snapshot even before any provider turn", async () => {
  const server = await createViteSsrTestServer({ configFile: false, appType: "custom", logLevel: "silent",
    plugins: [solid({ ssr: true })], root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true } });
  try {
    const { SettingsScreen } = await server.ssrLoadModule("/src/workbench-shell/renderer/settings.tsx");
    const html = renderToString(() => SettingsScreen({
      onClose() {}, profile: initialRendererState.profile,
      appearance: { tone: "dark", crt: "screen", phosphor: "neutral", phosphorTier: "b", language: "en" },
      appearancePersistencePhase: "saved", onAppearance() {},
      claudePermissionHandling: "without-asking", claudePermissionHandlingPersistencePhase: "saved",
      onClaudePermissionHandling() {}, canRead: false, onRead() {},
      endpointPreferences: { claude: "claude-code-desktop", codex: "codex-desktop", kimi: "kimi-code" },
      onEndpointPreference() {},
    }));
    assert.match(html, /Last observed subscription usage/);
    assert.match(html, /Unknown/);
    assert.doesNotMatch(html, /0%/);
  } finally { await server.close(); }
});

test("all four real captures render observed values and human reset/observation times in both languages", async () => {
  const server = await createViteSsrTestServer({ configFile: false, appType: "custom", logLevel: "silent",
    plugins: [solid({ ssr: true })], root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true } });
  try {
    const { SubscriptionUsageSnapshot } = await server.ssrLoadModule("/src/workbench-shell/renderer/settings-subscription-usage.tsx");
    const { setLocale } = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
    for (const language of ["en", "zh-CN"]) {
      setLocale(language);
      for (const name of captureNames) {
        let observation: any;
        await replayUsage(name, value => { observation = value; });
        const result = sanitizeWorkbenchSubscriptionUsageResult({ ok: true, observation });
        const html = renderToString(() => SubscriptionUsageSnapshot({ result }));
        assert.match(html, /50%/);
        assert.match(html, /25%/);
        const date = (milliseconds: number) => new Intl.DateTimeFormat(language, {
          year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
        }).format(milliseconds);
        for (const time of [observation.observedAt, observation.five_hour.resetsAt * 1000, observation.seven_day.resetsAt * 1000]) {
          assert.ok(html.includes(date(time)), "rendered local human time equals the wire/reset or receipt time");
        }
        assert.match(html, language === "en" ? /not current usage/ : /不是当前用量/);
        assert.match(html, language === "en" ? /not provided by this channel/ : /该渠道不提供/);
        assert.doesNotMatch(html, /rate-limited|限流|自动继续|refresh|setInterval/i);
      }
      for (const result of [{ ok: true, observation: null }, { ok: false }]) {
        const html = renderToString(() => SubscriptionUsageSnapshot({ result }));
        assert.match(html, language === "en" ? /Unknown/ : /未知/);
        assert.doesNotMatch(html, /0%/);
      }
      const html = renderToString(() => SubscriptionUsageSnapshot({ result: { ok: true, observation: {
        five_hour: { utilization: 0, resetsAt: 1788888000 }, seven_day: null, observedAt: 1788880000000,
      } } }));
      assert.match(html, /0%/);
      assert.match(html, language === "en" ? /Unknown/ : /未知/);
    }
    setLocale("en");
  } finally { await server.close(); }
});
