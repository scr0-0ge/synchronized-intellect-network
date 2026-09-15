import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import type { RuntimeUsageObservation } from "../../src/agent-runtime/index.ts";
import type { WorkbenchSubscriptionUsageResult } from "../../src/workbench-shell/contract.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

interface ComposerUsageModule {
  readonly usageEndpointRowKey?: (
    runtimeFamilyLabel: string,
    endpointLabel?: string,
  ) => string | undefined;
  readonly usageObservationForEndpoint?: (
    endpointKey: string | undefined,
    result: WorkbenchSubscriptionUsageResult,
  ) => RuntimeUsageObservation | undefined;
}

function observation(
  endpointKey: string,
  utilization: number,
): RuntimeUsageObservation {
  return {
    endpointKey,
    windows: [{ label: "seven-day", utilization }],
    observedAt: 1_700_000_000_000,
    source: "rate-limit-event",
  };
}

function usageRow(html: string, providerName: string): string {
  const escapedName = providerName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `<dt>${escapedName}</dt>([\\s\\S]*?)</div>`,
    "u",
  ).exec(html);
  assert.ok(match, `Usage card has a ${providerName} row`);
  return match[1]!;
}

test("API endpoint usage stays on its own context popover and Settings Usage row", async () => {
  const server = await createViteSsrTestServer({
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true },
  });
  try {
    const composer = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/composer.tsx",
    ) as ComposerUsageModule;
    const { UsageSnapshot } = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/settings-usage.tsx",
    ) as {
      readonly UsageSnapshot: (props: {
        readonly result: WorkbenchSubscriptionUsageResult;
        readonly observations: Readonly<Record<string, RuntimeUsageObservation>>;
      }) => unknown;
    };

    const result: WorkbenchSubscriptionUsageResult = {
      ok: true,
      observation: {
        five_hour: { utilization: 0.23, resetsAt: 1_700_010_000 },
        seven_day: { utilization: 0.66, resetsAt: 1_700_020_000 },
        observedAt: 1_700_000_000_000,
      },
      usage: {
        codex: observation("codex", 0.91),
        "codex-api": observation("codex-api", 0.12),
        kimi: observation("kimi", 0.44),
        "kimi-platform": observation("kimi-platform", 0.08),
        "claude-api": observation("claude-api", 0.17),
      },
    };
    const expected = [
      {
        runtimeFamilyLabel: "Codex",
        endpointLabel: "API",
        endpointKey: "codex-api",
        ownPercent: "12%",
        siblingPercent: "91%",
        cardLabel: "Codex · API",
      },
      {
        runtimeFamilyLabel: "Kimi",
        endpointLabel: "Platform",
        endpointKey: "kimi-platform",
        ownPercent: "8%",
        siblingPercent: "44%",
        cardLabel: "Kimi · Platform",
      },
      {
        runtimeFamilyLabel: "Claude",
        endpointLabel: "API",
        endpointKey: "claude-api",
        ownPercent: "17%",
        siblingPercent: "23%",
        cardLabel: "Claude · API",
      },
    ] as const;

    const html = renderToString(() => UsageSnapshot({
      result,
      observations: result.usage,
    }));
    for (const endpoint of expected) {
      const cardRow = usageRow(html, endpoint.cardLabel);
      assert.match(cardRow, new RegExp(`${endpoint.ownPercent} used`, "u"));
      assert.doesNotMatch(cardRow, new RegExp(`${endpoint.siblingPercent} used`, "u"));
    }

    assert.equal(typeof composer.usageEndpointRowKey, "function");
    assert.equal(typeof composer.usageObservationForEndpoint, "function");
    for (const endpoint of expected) {
      const endpointKey = composer.usageEndpointRowKey!(
        endpoint.runtimeFamilyLabel,
        endpoint.endpointLabel,
      );
      assert.equal(endpointKey, endpoint.endpointKey);
      const current = composer.usageObservationForEndpoint!(endpointKey, result);
      assert.equal(current?.endpointKey, endpoint.endpointKey);
      assert.equal(current?.windows[0]?.utilization, Number.parseInt(endpoint.ownPercent, 10) / 100);
      assert.notEqual(current?.windows[0]?.utilization, Number.parseInt(endpoint.siblingPercent, 10) / 100);
    }
  } finally {
    await server.close();
  }
});
