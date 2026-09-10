import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";
import solid from "vite-plugin-solid";

import { judgeText } from "../harness/rendered-surface/contrast.ts";
import {
  measureSurface,
  startSurfaceServer,
} from "../harness/rendered-surface/measure.ts";
import { removeTestDirectory } from "../helpers/test-lifecycle.ts";
import {
  createViteBrowserTestServer,
} from "../helpers/vite-server.ts";
import type { ViteDevServer } from "vite";

const harnessRoot = fileURLToPath(
  new URL("./visual-harness/", import.meta.url),
);
let isolatedUserDataRoot = "";
const harnessMain = fileURLToPath(
  new URL("./visual-harness/electron-main.mjs", import.meta.url),
);
const electronExecutable = createRequire(import.meta.url)("electron") as string;
const activeApplications = new Set<ElectronApplication>();

let server: ViteDevServer | undefined;
let harnessUrl = "";

before(async () => {
  isolatedUserDataRoot = resolve(
    await mkdtemp(join(tmpdir(), "uaw-history-user-data-")),
  );
  server = await createViteBrowserTestServer({
    configFile: false,
    root: harnessRoot,
    logLevel: "silent",
    plugins: [solid()],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  harnessUrl = server.resolvedUrls?.local[0] ?? "";
  assert.notEqual(harnessUrl, "", "the renderer harness must listen");
});

after(async () => {
  try {
    await closeActiveApplications();
  } finally {
    try {
      await server?.close();
    } finally {
      if (isolatedUserDataRoot !== "") {
        assert.equal(isAbsolute(isolatedUserDataRoot), true);
        assert.match(basename(isolatedUserDataRoot), /^uaw-history-user-data-/u);
        await removeTestDirectory(isolatedUserDataRoot);
      }
    }
  }
});

test(
  "ordinary Project selection neither discovers nor announces another history",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness(
      "scenario=history-empty-secondary",
    );
    try {
      await page.waitForTimeout(100);

      const observation = await page.evaluate(() => ({
        discoveryCalls:
          document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ?? "",
        adoptionCalls:
          document.documentElement.dataset.qaProjectHistoryAdoptionCalls ?? "",
        request: JSON.parse(
          document.documentElement.dataset.qaLastProjectHistoryDiscovery || "{}",
        ) as Record<string, unknown>,
        modalOpen:
          document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
        noticeCount: Array.from(
          document.querySelectorAll('[role="status"]'),
        ).filter((node) =>
          node.textContent?.includes(
            "Another conversation history exists for this Project.",
          ),
        ).length,
      }));
      assert.deepEqual(observation, {
        discoveryCalls: "0",
        adoptionCalls: "0",
        request: {},
        modalOpen: false,
        noticeCount: 0,
      });
    } finally {
      await application.close();
    }
  },
);

test(
  "the explicit Project-history control discovers foreign histories without adopting",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness("scenario=history-multiple");
    try {
      await page
        .locator(".proj.is-open")
        .getByRole("button", {
          name: "Other conversation histories for Atlas Fieldnotes",
          exact: true,
        })
        .click({ timeout: 1_000 });
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.qaProjectHistoryDiscoveryCalls === "1",
        undefined,
        { timeout: 1_000 },
      );

      const panel = page.getByRole("dialog", {
        name: "Other conversation histories",
        exact: true,
      });
      await panel.waitFor({ state: "visible", timeout: 1_000 });
      assert.equal(await panel.locator(".project-histories-row").count(), 2);
      assert.deepEqual(
        await page.evaluate(() => ({
          discoveryCalls:
            document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ?? "",
          adoptionCalls:
            document.documentElement.dataset.qaProjectHistoryAdoptionCalls ?? "",
          request: JSON.parse(
            document.documentElement.dataset.qaLastProjectHistoryDiscovery ?? "{}",
          ) as Record<string, unknown>,
          noticeCount: Array.from(
            document.querySelectorAll('[role="status"]'),
          ).filter((node) =>
            node.textContent?.includes(
              "Another conversation history exists for this Project.",
            ),
          ).length,
        })),
        {
          discoveryCalls: "1",
          adoptionCalls: "0",
          request: {
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000111",
          },
          noticeCount: 0,
        },
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "Open Project presents the existing history dialog before choosing between two ledgers",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness(
      "scenario=open-history-choice",
    );
    try {
      await invokeOpenProject(page);
      const panel = page.getByRole("dialog", {
        name: "Other conversation histories",
        exact: true,
      });
      await panel.waitFor({ state: "visible", timeout: 1_000 });
      assert.equal(await panel.locator(".project-histories-row").count(), 2);
      assert.equal(await panel.getByText("Shown now", { exact: true }).count(), 0);
      assert.equal(
        await panel.getByRole("button", {
          name: "Hide this empty history",
          exact: true,
        }).count(),
        0,
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          discoveryCalls:
            document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ?? "",
          adoptionCalls:
            document.documentElement.dataset.qaProjectHistoryAdoptionCalls ?? "",
          openCalls:
            document.documentElement.dataset.qaOpenProjectCalls ?? "",
        })),
        { discoveryCalls: "0", adoptionCalls: "0", openCalls: "1" },
      );

      await panel
        .getByRole("button", { name: "Show this history", exact: true })
        .first()
        .click();
      await panel.waitFor({ state: "hidden", timeout: 1_000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaProjectHistoryAdoptionCalls,
        ),
        "1",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "Open Project announces automatic adoption of the sole existing ledger",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness("scenario=open-adopted");
    try {
      await invokeOpenProject(page);
      const announcement = page.getByText(
        "Project was opened with its existing conversation history.",
        { exact: true },
      );
      await announcement.waitFor({ state: "visible", timeout: 1_000 });
      assert.equal(await announcement.getAttribute("role"), "status");
      assert.equal(
        await page.getByRole("dialog", {
          name: "Other conversation histories",
          exact: true,
        }).count(),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaProjectHistoryAdoptionCalls,
        ),
        "0",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "dark and light Other conversation histories modal text clears WCAG AA",
  { timeout: 120_000 },
  async () => {
    const expectedDialogText = [
      "Atlas Fieldnotes",
      "Other conversation histories",
      "This Project folder has more than one recorded conversation history. Choose the ",
      "Choosing or adopting a history changes only the Project Registry. Hiding is offe",
      "History 1",
      "Shown now",
      "3 Agent Sessions · 7 turns · 24 updates",
      "72 KB · 2026-08-18 07:16:50Z",
      "History 2",
      "1 Agent Session · 2 turns · 15 updates",
      "60 KB · 2026-08-17 22:10:00Z",
      "Show this history",
      "Close",
    ] as const;
    const measurementServer = await startSurfaceServer();
    try {
      for (const tone of ["Dark", "Light"] as const) {
        for (const windowBackground of ["#000000", "#ffffff"] as const) {
          const surface = await measureSurface(measurementServer, {
            surfaceId: `project-histories-${tone.toLowerCase()}-${windowBackground.slice(1)}`,
            query: "?surface=settings&scenario=history-multiple&material=on",
            readySelector: ".settings",
            steps: [
              {
                click: ".appearance-option",
                within: '[aria-labelledby="appearance-tone-label"]',
                text: tone,
                settleSelector:
                  tone === "Light" ? 'html[data-tone="light"]' : ".settings",
              },
              {
                click: ".settings-rail-button",
                settleSelector: ".proj.is-open .project-histories-trigger",
              },
              {
                click: ".proj.is-open .project-histories-trigger",
                settleSelector: ".project-histories-dialog",
              },
            ],
            settleMs: 200,
            viewport: { width: 1280, height: 820 },
            windowBackground,
          });

          assert.equal(
            surface.root.tone,
            tone === "Light" ? "light" : null,
            `${tone}: the requested product tone must reach the real dialog`,
          );
          const dialogText = surface.texts.filter(
            (text) =>
              text.occludedBy === null &&
              expectedDialogText.includes(
                text.text as (typeof expectedDialogText)[number],
              ),
          );
          assert.deepEqual(
            dialogText.map((text) => text.text),
            [...expectedDialogText],
            `${tone} on ${windowBackground}: every histories-dialog string must be measured`,
          );
          for (const text of dialogText) {
            const verdict = judgeText(text);
            assert.equal(
              verdict.occludedBy,
              null,
              `${tone} on ${windowBackground}: ${JSON.stringify(text.text)} must be visible`,
            );
            assert.equal(
              verdict.passes,
              true,
              `${tone} on ${windowBackground}: ${JSON.stringify(text.text)} measured ${verdict.ratio}:1, below ${verdict.threshold}:1`,
            );
          }
        }
      }
    } finally {
      await measurementServer.close();
    }
  },
);

test("light histories readability stays in ink without thickening the modal", async () => {
  const [baseStyles, acrylicStyles] = await Promise.all([
    readFile(
      fileURLToPath(
        new URL("../../src/workbench-shell/renderer/styles.css", import.meta.url),
      ),
      "utf8",
    ),
    readFile(
      fileURLToPath(
        new URL(
          "../../src/workbench-shell/renderer/themes/theme-acrylic.css",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ]);

  assert.match(
    baseStyles,
    /\.removal-dialog-backdrop\s*\{(?=[^}]*background:\s*rgb\(0 0 0 \/ 64%\);)(?=[^}]*backdrop-filter:\s*blur\(3px\);)[^}]*\}/u,
  );
  assert.match(
    baseStyles,
    /\.removal-dialog\s*\{(?=[^}]*background:\s*var\(--bg-1\);)[^}]*\}/u,
  );

  const lightDialogRules = [
    ...acrylicStyles.matchAll(
      /:root\[data-skin~="acrylic"\]\[data-tone="light"\] \.removal-dialog[^\{]*\{([^}]*)\}/gu,
    ),
  ];
  assert.equal(lightDialogRules.length, 4);
  for (const rule of lightDialogRules) {
    const body = rule[1] ?? "";
    assert.match(
      body,
      /^\s*color:\s*var\(--modal-ink-(?:strong|regular|muted)\);\s*$/u,
    );
    assert.doesNotMatch(
      body,
      /(?:background|opacity|text-shadow|-webkit-text-stroke)\s*:/u,
    );
  }
});

test(
  "zero or one history stays quiet until the owner opens the explicit panel",
  { timeout: 120_000 },
  async () => {
    for (const scenario of ["history-zero", "history-one"] as const) {
      const { application, page } = await openHarness(`scenario=${scenario}`);
      try {
        await page.waitForTimeout(100);
        assert.equal(
          await page.evaluate(
            () =>
              document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ??
              "",
          ),
          "0",
          scenario,
        );
        await page
          .locator(".proj.is-open")
          .getByRole("button", {
            name: "Other conversation histories for Atlas Fieldnotes",
            exact: true,
          })
          .click({ timeout: 1_000 });
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ===
            "1",
          undefined,
          { timeout: 1_000 },
        );
        const panel = page.getByRole("dialog", {
          name: "Other conversation histories",
          exact: true,
        });
        await panel.waitFor({ state: "visible", timeout: 1_000 });
        const expectedNotice =
          scenario === "history-zero"
            ? "No recorded conversation histories were found for this Project."
            : "This Project has only the history it is showing now.";
        await panel
          .getByText(expectedNotice, { exact: true })
          .waitFor({ state: "visible", timeout: 1_000 });
        assert.equal(
          await panel
            .getByText(
              "This Project folder has more than one recorded conversation history. Choose the one this Project should show; every other history stays available here.",
              { exact: true },
            )
            .count(),
          0,
          `${scenario} must not claim that multiple histories were found`,
        );
        assert.deepEqual(
          await page.evaluate(() => ({
            noticeCount: Array.from(
              document.querySelectorAll('[role="status"]'),
            ).filter((node) =>
              node.textContent?.includes(
                "Another conversation history exists for this Project.",
              ),
            ).length,
            adoptionCalls:
              document.documentElement.dataset.qaProjectHistoryAdoptionCalls ??
              "",
            modalOpen:
              document.querySelector('[role="dialog"][aria-modal="true"]') !==
              null,
          })),
          { noticeCount: 0, adoptionCalls: "0", modalOpen: true },
          scenario,
        );
      } finally {
        await application.close();
      }
    }
  },
);

test(
  "an empty history can be hidden from its dialog and stays out of ordinary use",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness(
      "scenario=history-empty-secondary",
    );
    try {
      const trigger = page
        .locator(".proj.is-open")
        .getByRole("button", {
          name: "Other conversation histories for Atlas Fieldnotes",
          exact: true,
        });
      await trigger.click({ timeout: 1_000 });
      const panel = page.getByRole("dialog", {
        name: "Other conversation histories",
        exact: true,
      });
      await panel.waitFor({ state: "visible", timeout: 1_000 });

      const hide = panel.getByRole("button", {
        name: "Hide this empty history",
        exact: true,
      });
      assert.equal(await hide.count(), 1);
      await hide.click({ timeout: 1_000 });
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.qaProjectHistoryHideCalls === "1",
        undefined,
        { timeout: 1_000 },
      );
      await panel
        .getByText(
          "Empty history hidden. Its conversation store remains on disk.",
          { exact: true },
        )
        .waitFor({ state: "visible", timeout: 1_000 });
      assert.equal(
        await panel.getByText("No recorded Agent Sessions", { exact: true }).count(),
        0,
      );
      assert.equal(await hide.count(), 0);

      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await trigger.click({ timeout: 1_000 });
      await panel.waitFor({ state: "visible", timeout: 1_000 });
      assert.equal(
        await panel.getByText("No recorded Agent Sessions", { exact: true }).count(),
        0,
      );
      assert.equal(await hide.count(), 0);
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.dataset.qaProjectHistoryHideCalls ?? "",
        ),
        "1",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "switching Projects performs no implicit history discovery for either selection",
  { timeout: 120_000 },
  async () => {
    const { application, page } = await openHarness("scenario=history-stale");
    try {
      await page.waitForTimeout(100);
      await page.locator(".project-switch-trigger:not([hidden])").first().click();
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.qaProjectSelectionCalls === "1",
        undefined,
        { timeout: 2_000 },
      );
      await page.waitForTimeout(100);

      assert.deepEqual(
        await page.evaluate(() => ({
          discoveryCalls:
            document.documentElement.dataset.qaProjectHistoryDiscoveryCalls ?? "",
          adoptionCalls:
            document.documentElement.dataset.qaProjectHistoryAdoptionCalls ?? "",
          noticeCount: Array.from(
            document.querySelectorAll('[role="status"]'),
          ).filter((node) =>
            node.textContent?.includes(
              "Another conversation history exists for this Project.",
            ),
          ).length,
          selectedProjectIndex: Array.from(
            document.querySelectorAll(".proj"),
          ).findIndex((project) => project.classList.contains("is-open")),
          projects: Array.from(document.querySelectorAll<HTMLElement>(".proj"))
            .map((project) => ({
              expanded: project.dataset.open,
              sessionRows: project.querySelectorAll(".session-row").length,
              enabledSessionRows: Array.from(
                project.querySelectorAll<HTMLButtonElement>(".session-row"),
              ).filter((row) => !row.disabled).length,
            })),
        })),
        {
          discoveryCalls: "0",
          adoptionCalls: "0",
          noticeCount: 0,
          selectedProjectIndex: 1,
          projects: [
            { expanded: "true", sessionRows: 3, enabledSessionRows: 0 },
            { expanded: "true", sessionRows: 2, enabledSessionRows: 2 },
            { expanded: "false", sessionRows: 0, enabledSessionRows: 0 },
          ],
        },
      );
    } finally {
      await application.close();
    }
  },
);

async function invokeOpenProject(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Create or open a Project", exact: true })
    .click();
  const actions = page.getByRole("dialog", {
    name: "Project actions",
    exact: true,
  });
  await actions.waitFor({ state: "visible", timeout: 1_000 });
  await actions
    .getByRole("button", { name: "Open Project…", exact: true })
    .click();
  await page.waitForFunction(
    () => document.documentElement.dataset.qaOpenProjectCalls === "1",
    undefined,
    { timeout: 1_000 },
  );
}

async function openHarness(
  query: string,
): Promise<Readonly<{ application: ElectronApplication; page: Page }>> {
  const userDataDirectory = resolve(
    await mkdtemp(join(isolatedUserDataRoot, "workbench-history-discovery-")),
  );
  assert.equal(isAbsolute(userDataDirectory), true);
  assert.equal(userDataDirectory.startsWith(`${isolatedUserDataRoot}${sep}`), true);
  assert.match(basename(userDataDirectory), /^workbench-history-discovery-/u);
  const targetUrl = new URL(harnessUrl);
  targetUrl.search = query;
  // One line per launch (issue 161 item 4).
  console.log(
    `qa harness launch: surface=${targetUrl.search || "(no query)"} userData=${userDataDirectory} (visual-harness/electron-main.mjs places it off every monitor)`,
  );
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [harnessMain, `--user-data-dir=${userDataDirectory}`],
      env: {
        ...process.env,
        UAW_QA_URL: targetUrl.href,
        UAW_QA_WIDTH: "1280",
        UAW_QA_HEIGHT: "820",
      },
      timeout: 15_000,
    });
    activeApplications.add(application);
    application.on("close", () => activeApplications.delete(application!));
    const page = await application.firstWindow({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    await page.locator(".app").waitFor({ state: "visible" });
    return Object.freeze({ application, page });
  } catch (error) {
    if (application) await closeAfterSetupFailure(application, error);
    throw error;
  }
}

async function closeActiveApplications(): Promise<void> {
  const errors: unknown[] = [];
  for (const application of [...activeApplications]) {
    try {
      await application.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple Electron applications failed to close.");
  }
}

async function closeAfterSetupFailure(
  application: ElectronApplication,
  setupError: unknown,
): Promise<never> {
  try {
    await application.close();
  } catch (closeError) {
    throw new AggregateError(
      [setupError, closeError],
      "Electron harness setup and application cleanup both failed.",
    );
  }
  throw setupError;
}
