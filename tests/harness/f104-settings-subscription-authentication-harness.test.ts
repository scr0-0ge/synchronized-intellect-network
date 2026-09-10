import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  F104_COPY,
  F104_FORBIDDEN_PUBLIC_FIELDS,
  F104_PROVIDER_CASES,
  F104_SETTINGS_SELECTORS,
  createOracleModelF104AcceptanceFactory,
  type F104AcceptanceFactory,
  type F104Provider,
} from "./f104-settings-subscription-authentication-acceptance.ts";
import {
  assertF104AcceptanceReport,
  runF104SettingsSubscriptionAuthenticationAcceptance,
} from "./f104-settings-subscription-authentication-runner.ts";

const acceptanceUrl = new URL(
  "./f104-settings-subscription-authentication-acceptance.ts",
  import.meta.url,
);
const runnerUrl = new URL(
  "./f104-settings-subscription-authentication-runner.ts",
  import.meta.url,
);
const productionAdapterUrl = new URL(
  "../e2e/f104-settings-subscription-authentication-production-adapter.ts",
  import.meta.url,
);
const productionDriverUrl = new URL(
  "../e2e/f104-settings-subscription-authentication-production.ts",
  import.meta.url,
);
const f68ProductionDriverUrl = new URL(
  "../e2e/settings-subscription-authentication-production.ts",
  import.meta.url,
);
const f68ProductionHarnessUrl = new URL(
  "./settings-subscription-authentication-production.test.ts",
  import.meta.url,
);
const f68SettingsUrl = new URL(
  "../workbench-shell/subscription-authentication-settings.test.ts",
  import.meta.url,
);
const f68MainWiringUrl = new URL(
  "../workbench-shell/subscription-authentication-main-wiring.test.ts",
  import.meta.url,
);
const settingsFidelityUrl = new URL(
  "../workbench-shell/settings-page-fidelity.test.ts",
  import.meta.url,
);

test("F104 sealed harness exercises every oracle group through controlled fakes", async () => {
  const report = await runF104SettingsSubscriptionAuthenticationAcceptance(
    createOracleModelF104AcceptanceFactory(),
  );
  assertF104AcceptanceReport(report);
  assert.ok(report.observations.length >= 180);
  for (const prefix of [
    "codex.adapter.",
    "claude.adapter.",
    "codex.cycle.",
    "claude.cycle.",
    "guard.",
    "generation.",
    "resume.",
    "race.",
    "public.request.",
    "public.response.",
    "render.",
  ]) {
    assert.equal(
      report.observations.some((observation) =>
        observation.id.startsWith(prefix),
      ),
      true,
      `missing oracle observation group ${prefix}`,
    );
  }
  assert.deepEqual(report.providerSpend, { codex: 0, claude: 0 });
  assert.equal(report.liveProviderActions, 0);
  assert.equal(report.browserActions, 0);
});

test("harness preserves independent failures instead of collapsing a provider matrix", async () => {
  const base = createOracleModelF104AcceptanceFactory();
  const mutated: F104AcceptanceFactory = Object.freeze({
    ...base,
    providerFixture(provider: F104Provider) {
      const fixture = base.providerFixture(provider);
      if (provider !== "codex") return fixture;
      return Object.freeze({
        ...fixture,
        invalidConsumed: Object.freeze(
          fixture.invalidConsumed.map((entry) =>
            entry.category === "unknown-literal"
              ? Object.freeze({
                  ...entry,
                  value: fixture.recognizedBound,
                })
              : entry,
          ),
        ),
      });
    },
  });
  const report =
    await runF104SettingsSubscriptionAuthenticationAcceptance(mutated);
  const failures = report.observations.filter(
    (observation) => observation.status === "failed",
  );
  assert.ok(failures.length >= 2);
  assert.equal(new Set(failures.map((failure) => failure.id)).size, failures.length);
  assert.equal(
    report.observations.some(
      (observation) =>
        observation.id === "codex.adapter.consumed-unknown-literal-is-unknown" &&
        observation.status === "failed",
    ),
    true,
  );
  assert.equal(
    report.observations.some(
      (observation) =>
        observation.id === "claude.adapter.recognized-bound" &&
        observation.status === "passed",
    ),
    true,
  );
  assert.equal(
    failures.every((failure) => failure.category === "assertion-failed"),
    true,
  );
});

test("oracle literals, opaque controls, and existing Settings selectors stay independent", () => {
  assert.deepEqual(
    F104_PROVIDER_CASES.map((provider) => [
      provider.label,
      provider.endpointSelectionKey,
    ]),
    [
      ["Codex", "endpoint-selection-01"],
      ["Claude", "endpoint-selection-02"],
    ],
  );
  assert.equal(
    F104_PROVIDER_CASES.every(
      (provider) =>
        !provider.endpointSelectionKey
          .toLocaleLowerCase("en-US")
          .includes(provider.provider),
    ),
    true,
  );
  assert.deepEqual(F104_COPY, {
    credentialHeading: "Subscription credentials never pass through the Workbench",
    credentialSentence:
      "Subscription sign-in happens in each provider's own app. This page never asks for a subscription password or token, never reads a subscription credential file, and never stores subscription credentials. The one exception is disclosed in the GLM Coding Plan API key section below.",
    boundAction: "Log out",
    signedOutAction: "Login",
    consequence:
      "Recorded conversations stay in the Workbench. Resumable Sessions for this provider will no longer be resumable when this authentication action begins.",
    confirmLogout: "Ask the provider CLI to log out",
    cancel: "Cancel",
    logoutRequested: "The Workbench asked the provider CLI to log out.",
    logoutNotRequested:
      "The Workbench could not ask the provider CLI to log out. Nothing changed, and every Session stays exactly as resumable as it was.",
    logoutPartiallyCompleted:
      "The Workbench asked the provider CLI to log out but could not record the log out. Sessions started before this log out can no longer be resumed, even where the Workbench still offers to resume them.",
    logoutBlocked: "Log out is blocked.",
  });
  assert.deepEqual(F104_SETTINGS_SELECTORS, {
    settingsRoot: ".settings",
    providerRegion: "section.provider-settings",
    providerCard: "section.provider",
    providerName: ":scope > .provider-head .ph-name",
    providerActions: ":scope > .provider-actions",
    subscriptionStatus:
      ':scope > .provider-actions .provider-binding-status[role="status"]',
  });
  assert.equal(
    new Set(F104_FORBIDDEN_PUBLIC_FIELDS).size,
    F104_FORBIDDEN_PUBLIC_FIELDS.length,
  );
  assert.ok(F104_FORBIDDEN_PUBLIC_FIELDS.length >= 60);
});

test("harness and meeting driver cannot launch providers, networks, Electron, Playwright, or a browser", async () => {
  const [acceptance, runner, adapter, driver] = await Promise.all([
    readFile(acceptanceUrl, "utf8"),
    readFile(runnerUrl, "utf8"),
    readFile(productionAdapterUrl, "utf8"),
    readFile(productionDriverUrl, "utf8"),
  ]);
  const executable = `${acceptance}\n${runner}\n${adapter}\n${driver}`;
  assert.doesNotMatch(
    executable,
    /from\s+["'](?:node:child_process|electron|playwright|node:http|node:https|undici)["']/u,
  );
  assert.doesNotMatch(
    executable,
    /\b(?:spawn|spawnSync|exec|execFile|fetch|BrowserWindow|_electron|chromium|firefox|webkit)\s*\(/u,
  );
  assert.doesNotMatch(executable, /\.launchPersistentContext\s*\(/u);
  assert.match(adapter, /F104_PRODUCTION_ACCEPTANCE_SEAM_NOT_CONNECTED/u);
  assert.doesNotMatch(adapter, /\.\.\/\.\.\/src\//u);
  assert.match(driver, /production-acceptance-seam-not-connected/u);
  assert.match(driver, /liveProviderActions:\s*0/u);
  assert.match(driver, /browserActions:\s*0/u);
});

test("public boundary matrix names every forbidden field on both request and response sides", async () => {
  const runner = await readFile(runnerUrl, "utf8");
  assert.match(
    runner,
    /for \(const field of F104_FORBIDDEN_PUBLIC_FIELDS\)/u,
  );
  assert.match(runner, /public\.request\.forbidden-field\.\$\{field\}/u);
  assert.match(runner, /public\.response\.forbidden-field\.\$\{field\}/u);
  assert.match(runner, /public\.response\.blocker-count\.\$\{member\}/u);
  assert.match(runner, /public\.response\.consequence-count\.\$\{member\}/u);
});

test("only stale F68 no-logout assertions are replaced and unrelated guards remain", async () => {
  const [driver, harness, settings, mainWiring, fidelity] = await Promise.all([
    readFile(f68ProductionDriverUrl, "utf8"),
    readFile(f68ProductionHarnessUrl, "utf8"),
    readFile(f68SettingsUrl, "utf8"),
    readFile(f68MainWiringUrl, "utf8"),
    readFile(settingsFidelityUrl, "utf8"),
  ]);
  assert.match(
    driver,
    /Object\.freeze\(\["API key", "Add provider", "OpenCode"\] as const\)/u,
  );
  assert.match(
    harness,
    /"API key", "Add provider", "OpenCode"/u,
  );
  assert.match(settings, /assert\.doesNotMatch\(html, \/--bare\/u\)/u);
  assert.match(mainWiring, /\(\?:--bare\|API_KEY\|token\|shell:/u);
  assert.match(
    fidelity,
    /API key\|--bare\|OpenCode\|Add provider\|Connect provider/u,
  );
  const stale = `${driver}\n${harness}\n${settings}\n${mainWiring}\n${fidelity}`;
  assert.doesNotMatch(stale, /no credential or logout surface/iu);
  assert.doesNotMatch(stale, /Logout\|Log out/iu);
  assert.doesNotMatch(stale, /Connect provider\|Log out/iu);
  assert.doesNotMatch(stale, /"Logout"/u);
});
