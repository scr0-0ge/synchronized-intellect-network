import assert from "node:assert/strict";

import type { Page } from "playwright";

import type {
  PublicProviderObservation,
  SettingsObservation,
} from "./evidence.ts";

type ProviderName = PublicProviderObservation extends Readonly<{
  name: infer Name;
}>
  ? Name
  : never;

export type SettingsObservationContext = Readonly<{
  providerNames: readonly ProviderName[];
  publicAvailabilityValues: readonly string[];
  publicStatusValues: readonly string[];
  publicCatalogValues: readonly string[];
  publicSubscriptionValues: readonly string[];
  expectedProviderState: Readonly<{
    availability: string;
    status: string;
    catalog: string;
    subscription: string;
  }>;
  setActiveStep: (step: string) => void;
  eventually: (
    predicate: () => boolean | Promise<boolean>,
    timeout: number,
  ) => Promise<void>;
}>;

export function createSettingsObservation(context: SettingsObservationContext) {
  const {
    providerNames,
    publicAvailabilityValues,
    publicStatusValues,
    publicCatalogValues,
    publicSubscriptionValues,
    expectedProviderState,
    setActiveStep,
    eventually,
  } = context;
  async function inspectSettings(
    page: Page,
    onProviders: (providers: readonly PublicProviderObservation[]) => void,
  ): Promise<SettingsObservation> {
    const allSettingsEntries = page.getByRole("button", {
      name: "Settings",
      exact: true,
    });
    assert.equal(await allSettingsEntries.count(), 1);
    const railSettingsEntry = page
      .locator(".rail-foot")
      .getByRole("button", { name: "Settings", exact: true });
    assert.equal(await railSettingsEntry.count(), 1);
    await page
      .locator(".rail-foot")
      .getByRole("button", { name: "Settings", exact: true })
      .click();

    const settingsPage = page.locator("main.settings");
    await settingsPage.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await settingsPage.count(), 1);
    const settingsHeadings = settingsPage.getByRole("heading", { name: "Settings", exact: true, level: 1 });
    await settingsHeadings.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await settingsHeadings.count(), 1);
    assert.equal(await railSettingsEntry.getAttribute("aria-current"), "page");

    const titlebar = page.getByRole("banner");
    const titlebarSettings = titlebar.getByText("Settings", { exact: true });
    assert.equal(await titlebarSettings.count(), 0);
    assert.equal(
      await titlebar
        .getByRole("button", { name: "Settings", exact: true })
        .count(),
      0,
    );

    setActiveStep("settings/structure/sections");
    const sections = (await settingsPage.getByRole("heading", { level: 2 }).allTextContents())
      .map((value) => value.trim());
    assert.deepEqual(sections, [
      "Appearance",
      "Providers",
      "Tools",
      "Usage & resets",
      "Claude permissions",
    ]);

    setActiveStep("settings/structure/provider-cards");
    const providerCards = settingsPage.locator(
      ".provider-endpoint-list > section.provider",
    );
    assert.equal(await providerCards.count(), 5);
    assert.deepEqual(
      (await providerCards.locator(":scope > .provider-head .ph-name").allTextContents())
        .map((value) => value.trim()),
      ["Codex", "Claude", "GLM", "DeepSeek", "Kimi"],
    );
    setActiveStep("settings/structure/subscription-cards");
    const subscriptionProviderCards = settingsPage.locator(
      ".provider-endpoint-list > section.provider.provider-codex, " +
        ".provider-endpoint-list > section.provider.provider-claude",
    );
    assert.equal(await subscriptionProviderCards.count(), 2);
    assert.equal(await subscriptionProviderCards.locator("input, textarea").count(), 0);
    assert.equal(
      await subscriptionProviderCards.locator('input[type="password"]').count(),
      0,
    );
    setActiveStep("settings/structure/unsupported-actions");
    const unsupportedSurfaceLabels = Object.freeze(["Add provider", "OpenCode"] as const);
    for (const label of unsupportedSurfaceLabels) {
      assert.equal(await settingsPage.getByText(label, { exact: true }).count(), 0);
    }

    setActiveStep("settings/catalog/initial-settle");
    const recheckCatalogs = settingsPage.getByRole("button", {
      name: "Check all",
      exact: true,
    });
    await recheckCatalogs.waitFor({ state: "visible", timeout: 30_000 });
    await eventually(async () =>
      (await recheckCatalogs.getAttribute("aria-busy")) !== "true" &&
      (await recheckCatalogs.isEnabled()),
    30_000);

    setActiveStep("settings/catalog/recheck");
    await recheckCatalogs.click();
    setActiveStep("settings/catalog/settle");
    await recheckCatalogs.waitFor({ state: "visible", timeout: 30_000 });
    await eventually(async () =>
      (await recheckCatalogs.getAttribute("aria-busy")) !== "true" &&
      (await recheckCatalogs.isEnabled()),
    30_000);

    for (let index = 0; index < await subscriptionProviderCards.count(); index += 1) {
      const details = subscriptionProviderCards.nth(index).locator("details.provider-details");
      assert.equal(await details.getAttribute("open"), null);
      await details.locator(":scope > summary").click();
      assert.notEqual(await details.getAttribute("open"), null);
    }

    setActiveStep("settings/providers/settle");
    await eventually(async () => {
      const observations = await collectPublicProviderObservations(subscriptionProviderCards);
      onProviders(observations);
      return observations.every(
        (observation) =>
          observation.availability === expectedProviderState.availability &&
          observation.status === expectedProviderState.status &&
          observation.catalog === expectedProviderState.catalog &&
          observation.subscription === expectedProviderState.subscription &&
          observation.bindAbsent &&
          observation.cancelAbsent,
      );
    }, 30_000);

    const observations = await collectPublicProviderObservations(subscriptionProviderCards);
    onProviders(observations);
    assert.equal(observations.length, providerNames.length);
    for (const [index, provider] of providerNames.entries()) {
      const card = subscriptionProviderCards.nth(index);
      const observation = observations[index];
      assert.ok(observation);
      assert.deepEqual(observation, {
        name: provider,
        availability: "Ready",
        status: "Catalog ready",
        catalog: "Available",
        subscription: "Bound",
        bindAbsent: true,
        cancelAbsent: true,
      });
      const boundStatus = card.getByRole("status", {
        name: `${provider} subscription authentication: Bound`,
        exact: true,
      });
      assert.equal(await boundStatus.count(), 1);
      const bindButtons = card.getByRole("button", {
        name: `Bind ${provider} subscription account`,
        exact: true,
      });
      assert.equal(await bindButtons.count(), 0);
      const cancelButtons = card.getByRole("button", {
        name: `Cancel ${provider} subscription sign-in`,
        exact: true,
      });
      assert.equal(await cancelButtons.count(), 0);
    }

    return Object.freeze({
      providers: observations,
      railEntryUnique: true,
      headingUnique: true,
      current: true,
      titlebarSettingsAbsent: true,
      sensitiveFieldsAbsent: true,
      unsupportedActionsAbsent: true,
    });
  }

  async function collectPublicProviderObservations(
    providerCards: ReturnType<Page["locator"]>,
  ): Promise<readonly PublicProviderObservation[]> {
    const observations: PublicProviderObservation[] = [];
    for (const [index, provider] of providerNames.entries()) {
      const card = providerCards.nth(index);
      const renderedName =
        ((await card.locator(":scope > .provider-head .ph-name").textContent()) ?? "")
          .trim();
      assert.equal(renderedName, provider);
      const availability = publicEnum(
        ((await card.locator(":scope > .provider-head > .badge").textContent()) ?? "")
          .trim(),
        publicAvailabilityValues,
      );
      const status = publicEnum(
        await publicDefinitionValue(card, "Status"),
        publicStatusValues,
      );
      const catalog = publicEnum(
        await publicDefinitionValue(card, "Catalog"),
        publicCatalogValues,
      );
      const bindingStatus = card.locator(
        ':scope > .provider-actions .provider-binding-status[role="status"]',
      );
      const bindingLabel = (await bindingStatus.getAttribute("aria-label")) ?? "";
      const bindingPrefix = `${provider} subscription authentication: `;
      const subscription = publicEnum(
        bindingLabel.startsWith(bindingPrefix)
          ? bindingLabel.slice(bindingPrefix.length)
          : "Unexpected",
        publicSubscriptionValues,
      );
      const bindButtons = card.getByRole("button", {
        name: `Bind ${provider} subscription account`,
        exact: true,
      });
      const cancelButtons = card.getByRole("button", {
        name: `Cancel ${provider} subscription sign-in`,
        exact: true,
      });
      observations.push(
        Object.freeze({
          name: provider,
          availability,
          status,
          catalog,
          subscription,
          bindAbsent: (await bindButtons.count()) === 0,
          cancelAbsent: (await cancelButtons.count()) === 0,
        }),
      );
    }
    return Object.freeze(observations);
  }

  async function publicDefinitionValue(
    card: ReturnType<Page["locator"]>,
    label: "Status" | "Catalog",
  ): Promise<string> {
    const rows = card.locator(
      ":scope > .provider-body > details.provider-details > dl.kv > .kv-row",
    );
    const matches: string[] = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const term = row.locator(":scope > dt");
      assert.equal(await term.count(), 1);
      if (((await term.textContent()) ?? "").trim() !== label) continue;
      const definition = row.locator(":scope > dd");
      assert.equal(await definition.count(), 1);
      matches.push(((await definition.textContent()) ?? "").trim());
    }
    assert.equal(matches.length, 1);
    return matches[0]!;
  }

  function publicEnum(
    value: string,
    allowed: readonly string[],
  ): string {
    return allowed.includes(value) ? value : "Unexpected";
  }

  return Object.freeze({ inspectSettings });
}
