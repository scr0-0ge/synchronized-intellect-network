import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import { initialRendererState } from "../../src/workbench-shell/renderer/view-model.ts";
import { captureNames, replayUsage } from "../agent-runtime/claude-usage-replay.ts";
import { QuotaReplayTransport, quotaFrames, quotaProfile } from "../agent-runtime/fixtures/claude-quota-replay.ts";
import { sanitizeWorkbenchSubscriptionUsageResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { subscriptionUsageToUsageObservation } from "../../src/agent-runtime/index.ts";
import { createProductionGlmRuntimeAdapter } from "../../src/workbench-shell/runtime-endpoint-composition.ts";

test("Settings identifies the usage template even before any provider turn", async () => {
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
    assert.match(html, /Usage &amp; resets/);
    assert.match(html, /Not yet observed/);
    assert.match(html, /This provider's CLI does not report usage/);
    assert.doesNotMatch(html, /0%/);
  } finally { await server.close(); }
});

/**
 * Builds the GLM row through the real production path: composition
 * (`createProductionGlmRuntimeAdapter`) wires `observeUsage` into the real
 * 429-text parser in claude/session.ts, not a reimplementation of either.
 */
async function glmObservationFromFixture() {
  let observation: unknown;
  const adapter = createProductionGlmRuntimeAdapter({
    environment: {},
    claudePermissionHandling: { readPermissionMode: async () => "manual" },
    createSessionTransport: async () => new QuotaReplayTransport(quotaFrames),
    // The fixture's captured model name predates the current production
    // GLM_STATIC_CATALOG ids; augment rather than replace so this still
    // validates against the real static-catalog gate.
    resolveStaticCatalogAugmentation: () => [{ id: quotaProfile.model, effortLevels: [quotaProfile.effortLevel] }],
    observeUsage: value => { observation = value; },
  });
  const binding = await adapter.start({ projectDirectory: "offline-project", profile: quotaProfile });
  await binding.send({ text: "offline replay input" });
  for await (const _event of binding.events()) { /* drain to the quota-exhausted terminal */ }
  assert.notEqual(observation, undefined, "fixture must reach the GLM exhaustion-message branch");
  return observation;
}

test("all four real Claude captures plus the real GLM 429 parse render as five rows in both languages", async () => {
  const server = await createViteSsrTestServer({ configFile: false, appType: "custom", logLevel: "silent",
    plugins: [solid({ ssr: true })], root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true } });
  try {
    const { UsageSnapshot } = await server.ssrLoadModule("/src/workbench-shell/renderer/settings-usage.tsx");
    const { setLocale } = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
    const glm = await glmObservationFromFixture();
    for (const language of ["en", "zh-CN"]) {
      setLocale(language);
      for (const name of captureNames) {
        let observation: any;
        await replayUsage(name, value => { observation = value; });
        const result = sanitizeWorkbenchSubscriptionUsageResult({ ok: true, observation });
        const claude = subscriptionUsageToUsageObservation("claude", result.ok ? result.observation! : observation);
        const html = renderToString(() => UsageSnapshot({ result, observations: { claude, glm: glm as any } }));
        assert.match(html, /50%/);
        assert.match(html, /25%/);
        const date = (milliseconds: number) => new Intl.DateTimeFormat(language, {
          year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
        }).format(milliseconds);
        for (const time of [observation.observedAt, observation.five_hour.resetsAt * 1000, observation.seven_day.resetsAt * 1000]) {
          assert.ok(html.includes(date(time)), "rendered local human time equals the wire/reset or receipt time");
        }
        // Codex never reports; Kimi/DeepSeek have not been observed in this render.
        assert.match(html, language === "en" ? /This provider's CLI does not report usage/ : /此 provider 的 CLI 不报告用量/);
        assert.match(html, language === "en" ? /Not yet observed/ : /尚未观测/);
        // GLM row: a reset time with no percentage, from the real 429-text parse.
        assert.match(html, language === "en" ? /Quota window: Resets at/ : /配额窗口：重置时间：/);
        assert.doesNotMatch(html, /rate-limited|限流|自动继续|refresh|setInterval/i);
      }
      for (const result of [{ ok: true, observation: null }, { ok: false }]) {
        const html = renderToString(() => UsageSnapshot({ result, observations: {} }));
        assert.match(html, language === "en" ? /Not yet observed/ : /尚未观测/);
        assert.doesNotMatch(html, /0%/);
      }
      // A window with only five_hour known must not invent a seven_day line.
      const partialClaude = subscriptionUsageToUsageObservation("claude", {
        five_hour: { utilization: 0, resetsAt: 1788888000 }, seven_day: null, observedAt: 1788880000000,
      });
      const html = renderToString(() => UsageSnapshot({
        result: { ok: true, observation: null }, observations: { claude: partialClaude },
      }));
      assert.match(html, /0%/);
      assert.doesNotMatch(html, language === "en" ? /7-hour window|7-day window/ : /7 天窗口/);
    }
    setLocale("en");
  } finally { await server.close(); }
});
