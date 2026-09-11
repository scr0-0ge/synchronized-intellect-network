import assert from "node:assert/strict";

import type { Page } from "playwright";

export type RootAttributes = Readonly<{
  skin: string | null;
  glass: string | null;
  material: string | null;
  tone: string | null;
  crt: string | null;
  phosphor: string | null;
  phosphorTier: string | null;
}>;

export type AppearanceObservationContext<
  AppearanceTones extends readonly string[],
  AppearanceCrts extends readonly string[],
  AppearancePhosphors extends readonly string[],
  AppearancePhosphorTiers extends readonly string[],
> = Readonly<{
  savedScope: string;
  appearanceTones: AppearanceTones;
  appearanceCrts: AppearanceCrts;
  appearancePhosphors: AppearancePhosphors;
  appearancePhosphorTiers: AppearancePhosphorTiers;
  phosphorTierRootValues: Readonly<Record<AppearancePhosphorTiers[number], string>>;
  defaultRoot: RootAttributes;
  setActiveStep: (step: string) => void;
  eventually: (
    predicate: () => boolean | Promise<boolean>,
    timeout?: number,
  ) => Promise<void>;
  deepEqual: (left: unknown, right: unknown) => boolean;
}>;

export function createAppearanceObservation<
  const AppearanceTones extends readonly string[],
  const AppearanceCrts extends readonly string[],
  const AppearancePhosphors extends readonly string[],
  const AppearancePhosphorTiers extends readonly string[],
>(context: AppearanceObservationContext<
  AppearanceTones,
  AppearanceCrts,
  AppearancePhosphors,
  AppearancePhosphorTiers
>) {
  type AppearanceTone = AppearanceTones[number];
  type AppearanceCrt = AppearanceCrts[number];
  type AppearancePhosphor = AppearancePhosphors[number];
  type AppearancePhosphorTier = AppearancePhosphorTiers[number];
  const {
    savedScope,
    appearanceTones,
    appearanceCrts,
    appearancePhosphors,
    appearancePhosphorTiers,
    phosphorTierRootValues,
    defaultRoot,
    setActiveStep,
    eventually,
    deepEqual,
  } = context;
  async function inspectInitialProductUi(page: Page): Promise<Readonly<{
    settingsGearCount: number;
    titlebarSettingsTextCount: number;
    titlebarSettingsButtonCount: number;
    root: RootAttributes;
  }>> {
    const settingsGearCount = await page
      .getByRole("button", { name: "Settings", exact: true })
      .count();
    assert.equal(settingsGearCount, 1);
    assert.equal(
      await page
        .locator(".rail-foot")
        .getByRole("button", { name: "Settings", exact: true })
        .count(),
      1,
    );
    const titlebar = page.getByRole("banner");
    const titlebarSettingsTextCount = await titlebar
      .getByText("Settings", { exact: true })
      .count();
    const titlebarSettingsButtonCount = await titlebar
      .getByRole("button", { name: "Settings", exact: true })
      .count();
    assert.equal(titlebarSettingsTextCount, 0);
    assert.equal(titlebarSettingsButtonCount, 0);
    return Object.freeze({
      settingsGearCount,
      titlebarSettingsTextCount,
      titlebarSettingsButtonCount,
      root: await readRoot(page),
    });
  }

  async function openSettings(page: Page): Promise<void> {
    setActiveStep("settings-open/gear");
    const gear = page.getByRole("button", { name: "Settings", exact: true });
    assert.equal(await gear.count(), 1);
    setActiveStep("settings-open/click");
    await gear.click();
    setActiveStep("settings-open/heading");
    await page
      .getByRole("heading", { name: "Settings", exact: true, level: 1 })
      .waitFor({ state: "visible", timeout: 10_000 });
    setActiveStep("settings-open/current");
    assert.equal(await gear.getAttribute("aria-current"), "page");
  }

  async function settingsFacts(page: Page): Promise<Readonly<{
    sections: readonly string[];
    current: boolean;
    scope: string;
    pressed: Readonly<{
      tone: string;
      crt: string;
      phosphor: string;
      phosphorTier: string;
    }>;
    root: RootAttributes;
  }>> {
    const settings = page.locator("main.settings");
    const sections = (await settings.getByRole("heading", { level: 2 }).allTextContents())
      .map((value) => value.trim());
    const scope = ((await settings
      .locator(".appearance-section-head .settings-scope")
      .textContent()) ?? "").trim();
    return Object.freeze({
      sections: Object.freeze(sections),
      current:
        (await page
          .getByRole("button", { name: "Settings", exact: true })
          .getAttribute("aria-current")) === "page",
      scope,
      pressed: Object.freeze({
        tone: await pressedLabel(page, "Tone"),
        crt: await pressedLabel(page, "CRT"),
        phosphor: await pressedLabel(page, "Phosphor"),
        phosphorTier: await pressedLabel(page, "Light glow"),
      }),
      root: await readRoot(page),
    });
  }

  async function exerciseAppearanceMatrix(
    page: Page,
    initialMaterial: string | null,
  ): Promise<readonly Readonly<{
    observation: string;
    tone: AppearanceTone;
    crt: AppearanceCrt;
    phosphor: AppearancePhosphor;
    phosphorTier: AppearancePhosphorTier;
    root: RootAttributes;
  }>[]> {
    const matrix: readonly Readonly<{
      tone: AppearanceTone;
      crt: AppearanceCrt;
      phosphor: AppearancePhosphor;
      phosphorTier: AppearancePhosphorTier;
    }>[] = appearanceTones.flatMap((tone) =>
      appearanceCrts.flatMap((crt) =>
        appearancePhosphors.flatMap((phosphor) =>
          appearancePhosphorTiers.map((phosphorTier) =>
            Object.freeze({ tone, crt, phosphor, phosphorTier }),
          ),
        ),
      ),
    );
    assert.equal(matrix.length, 72);
    assert.deepEqual(matrix.at(-1), {
      tone: "Light",
      crt: "Full",
      phosphor: "Amber",
      phosphorTier: "C · Hottest",
    });
    const result: Array<Readonly<{
      observation: string;
      tone: AppearanceTone;
      crt: AppearanceCrt;
      phosphor: AppearancePhosphor;
      phosphorTier: AppearancePhosphorTier;
      root: RootAttributes;
    }>> = [];

    for (const [index, combination] of matrix.entries()) {
      const observation = [
        String(index + 1).padStart(2, "0"),
        combination.tone,
        combination.crt,
        combination.phosphor,
        combination.phosphorTier,
      ]
        .join("-")
        .toLocaleLowerCase("en-US");

      setActiveStep(`appearance-matrix/${observation}/tone`);
      await chooseAppearance(page, "Tone", combination.tone);
      setActiveStep(`appearance-matrix/${observation}/crt`);
      await chooseAppearance(page, "CRT", combination.crt);
      setActiveStep(`appearance-matrix/${observation}/phosphor`);
      await chooseAppearance(page, "Phosphor", combination.phosphor);
      setActiveStep(`appearance-matrix/${observation}/phosphor-tier`);
      await chooseAppearance(page, "Light glow", combination.phosphorTier);

      setActiveStep(`appearance-matrix/${observation}/scope-settled`);
      await waitForScope(page, savedScope);
      const expectedRoot: RootAttributes = Object.freeze({
        ...defaultRoot,
        material: initialMaterial,
        tone: combination.tone === "Dark" ? null : "light",
        crt:
          combination.crt === "Off"
            ? null
            : combination.crt.toLocaleLowerCase("en-US"),
        phosphor: combination.phosphor.toLocaleLowerCase("en-US"),
        phosphorTier: phosphorTierRootValues[combination.phosphorTier],
      });
      setActiveStep(`appearance-matrix/${observation}/root-settled`);
      await waitForRoot(page, expectedRoot);

      setActiveStep(`appearance-matrix/${observation}/pressed`);
      const facts = await settingsFacts(page);
      assert.deepEqual(facts.pressed, combination);

      setActiveStep(`appearance-matrix/${observation}/root`);
      assert.deepEqual(facts.root, expectedRoot);

      setActiveStep(`appearance-matrix/${observation}/data-material`);
      assert.equal(facts.root.material, initialMaterial);
      result.push(
        Object.freeze({
          observation,
          ...combination,
          root: facts.root,
        }),
      );
    }
    return Object.freeze(result);
  }

  async function chooseAppearance(page: Page, group: string, choice: string): Promise<void> {
    const button = page
      .getByRole("group", { name: group, exact: true })
      .getByRole("button", { name: choice, exact: true });
    await button.click();
    await eventually(async () => (await button.getAttribute("aria-pressed")) === "true");
  }

  async function pressedLabel(page: Page, group: string): Promise<string> {
    const buttons = page
      .getByRole("group", { name: group, exact: true })
      .getByRole("button");
    const count = await buttons.count();
    const pressed: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if ((await button.getAttribute("aria-pressed")) === "true") {
        pressed.push(((await button.textContent()) ?? "").trim());
      }
    }
    assert.equal(pressed.length, 1);
    return pressed[0]!;
  }

  async function waitForScope(page: Page, expected: string): Promise<void> {
    await eventually(async () =>
      ((await page
        .locator(".appearance-section-head .settings-scope")
        .textContent()) ?? "").trim() === expected,
    );
  }

  async function waitForRoot(page: Page, expected: RootAttributes): Promise<void> {
    await eventually(async () => deepEqual(await readRoot(page), expected));
  }

  async function readRoot(page: Page): Promise<RootAttributes> {
    return page.locator("html").evaluate((root) =>
      Object.freeze({
        skin: root.getAttribute("data-skin"),
        glass: root.getAttribute("data-glass"),
        material: root.getAttribute("data-material"),
        tone: root.getAttribute("data-tone"),
        crt: root.getAttribute("data-crt"),
        phosphor: root.getAttribute("data-phosphor"),
        phosphorTier: root.getAttribute("data-phosphor-tier"),
      }),
    );
  }

  return Object.freeze({
    inspectInitialProductUi,
    openSettings,
    settingsFacts,
    exerciseAppearanceMatrix,
    chooseAppearance,
    pressedLabel,
    waitForScope,
    waitForRoot,
    readRoot,
  });
}
