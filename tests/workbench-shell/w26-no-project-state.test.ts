import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
import type { ViteDevServer } from "vite";

import { removeTestDirectory } from "../helpers/test-lifecycle.ts";
import { createViteBrowserTestServer } from "../helpers/vite-server.ts";

const harnessRoot = fileURLToPath(
  new URL("./visual-harness/", import.meta.url),
);
const harnessMain = fileURLToPath(
  new URL("./visual-harness/electron-main.mjs", import.meta.url),
);
const electronExecutable = createRequire(import.meta.url)("electron") as string;
const activeApplications = new Set<ElectronApplication>();
let isolatedUserDataRoot = "";
let server: ViteDevServer | undefined;
let harnessUrl = "";

before(async () => {
  isolatedUserDataRoot = resolve(
    await mkdtemp(join(tmpdir(), "uaw-w26-user-data-")),
  );
  server = await createViteBrowserTestServer({
    configFile: false,
    root: harnessRoot,
    logLevel: "silent",
    plugins: [
      {
        name: "w26-single-project-fixture",
        enforce: "pre",
        transform(code, id) {
          if (!id.replaceAll("\\", "/").endsWith("/visual-harness/main.tsx")) {
            return null;
          }
          const initialProject = `    const scenario = new URLSearchParams(window.location.search).get("scenario");
    emitProjectResult(
      Object.freeze({
        ok: true,
        view:`;
          const fixture = ": visualFixture,";
          const removal = 'if (scenario === "project-removal-success") {';
          const creation = 'if (scenario === "create-created") {';
          assert.equal(code.includes(initialProject), true);
          assert.equal(code.includes(fixture), true);
          assert.equal(code.includes(removal), true);
          assert.equal(code.includes(creation), true);
          return code
            .replace(
              initialProject,
              `    const scenario = new URLSearchParams(window.location.search).get("scenario");
    emitProjectResult(
      scenario === "create-then-removal"
        ? Object.freeze({ ok: true, empty: true })
        : Object.freeze({
        ok: true,
        view:`,
            )
            .replace(
              fixture,
              ": Object.freeze({ ...visualFixture, projectSelection: Object.freeze({ projects: [\"project-removal-success\", \"remove-then-create\"].includes(new URLSearchParams(window.location.search).get(\"scenario\") ?? \"\") ? Object.freeze(visualFixture.projectSelection.projects.filter((project) => project.selected)) : visualFixture.projectSelection.projects }) }),",
            )
            .replace(
              removal,
              'if (scenario === "project-removal-success" || scenario === "create-then-removal" || scenario === "remove-then-create") {',
            )
            .replace(
              creation,
              'if (scenario === "create-created" || scenario === "create-then-removal" || scenario === "remove-then-create") {',
            );
        },
      },
      solid(),
    ],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  harnessUrl = server.resolvedUrls?.local[0] ?? "";
  assert.notEqual(harnessUrl, "");
});

after(async () => {
  try {
    for (const application of [...activeApplications]) {
      await application.close();
    }
  } finally {
    try {
      await server?.close();
    } finally {
      if (isolatedUserDataRoot !== "") {
        assert.equal(isAbsolute(isolatedUserDataRoot), true);
        assert.match(basename(isolatedUserDataRoot), /^uaw-w26-user-data-/u);
        await removeTestDirectory(isolatedUserDataRoot);
      }
    }
  }
});

test(
  "removing the final Project shows a neutral empty Workbench with chrome and Settings",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness();
    try {
      await page.locator(".proj.is-open .project-removal-trigger").click();
      await page
        .getByRole("alertdialog", {
          name: "Remove Project from Workbench?",
          exact: true,
        })
        .getByRole("button", { name: "Remove Project", exact: true })
        .click();

      await page
        .getByRole("heading", { name: "No Projects in the Workbench", exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(
        await page.getByRole("heading", { name: "Project view unavailable" }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "Minimize", exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByRole("button", { name: "Maximize", exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByRole("button", { name: "Close", exact: true }).count(),
        1,
      );
      const settings = page.getByRole("button", { name: "Settings", exact: true });
      assert.equal(await settings.isEnabled(), true);
      await settings.click();
      await page
        .getByRole("heading", { name: "Settings", exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });
    } finally {
      await application.close();
    }
  },
);

test(
  "removing a newly created final Project does not leave its creation feedback in the empty Workbench",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness("scenario=create-then-removal");
    try {
      await page
        .getByRole("heading", { name: "No Projects in the Workbench", exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });
      await page
        .getByRole("button", { name: "Create Project…", exact: true })
        .click();
      await page
        .getByText("Project was created.", { exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });

      const removalTrigger = page.locator(".proj.is-open .project-removal-trigger");
      await removalTrigger.waitFor({ state: "visible", timeout: 5_000 });
      await removalTrigger.click();
      const removalDialog = page.getByRole("alertdialog", {
        name: "Remove Project from Workbench?",
        exact: true,
      });
      await removalDialog.waitFor({ state: "visible", timeout: 5_000 });
      await removalDialog
        .getByRole("button", { name: "Remove Project", exact: true })
        .click({ timeout: 5_000 });

      await page
        .getByRole("heading", { name: "No Projects in the Workbench", exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(
        await page.getByText("Project was created.", { exact: true }).count(),
        0,
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "creating a Project clears feedback from the prior removal",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness("scenario=remove-then-create");
    try {
      await page.locator(".proj.is-open .project-removal-trigger").click();
      await page
        .getByRole("alertdialog", {
          name: "Remove Project from Workbench?",
          exact: true,
        })
        .getByRole("button", { name: "Remove Project", exact: true })
        .click();
      await page
        .getByText(
          "Project removed from the Workbench. Its folder and files remain on disk.",
          { exact: true },
        )
        .waitFor({ state: "visible", timeout: 5_000 });

      await page
        .getByRole("button", { name: "Create Project…", exact: true })
        .click();
      await page
        .getByText("Project was created.", { exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(
        await page
          .getByText(
            "Project removed from the Workbench. Its folder and files remain on disk.",
            { exact: true },
          )
          .count(),
        0,
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "a rendered draft leaves Project switching, Open, and Create available and survives the switch",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness("scenario=history-stale");
    try {
      const draft = "Keep this unfinished request while I check another Project.";
      await page.locator("#direct-input").fill(draft);

      const switchProject = page
        .locator(".project-switch-trigger:not([hidden])")
        .first();
      assert.equal(await switchProject.isEnabled(), true);
      await page
        .getByRole("button", { name: "Create or open a Project", exact: true })
        .click();
      assert.equal(
        await page.getByRole("button", { name: "Create Project…", exact: true }).isEnabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Open Project…", exact: true }).isEnabled(),
        true,
      );
      await page.keyboard.press("Escape");

      await switchProject.click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaProjectSelectionCalls === "1",
      );
      await page.waitForFunction(
        () =>
          document
            .querySelectorAll(".registered-project-button")[1]
            ?.getAttribute("aria-current") === "page",
      );
      assert.equal(await page.locator("#direct-input").inputValue(), draft);
    } finally {
      await application.close();
    }
  },
);

async function openHarness(
  query = "scenario=project-removal-success",
): Promise<
  Readonly<{ application: ElectronApplication; page: Page }>
> {
  const userDataDirectory = resolve(
    await mkdtemp(join(isolatedUserDataRoot, "workbench-renderer-harness-")),
  );
  assert.equal(userDataDirectory.startsWith(`${isolatedUserDataRoot}${sep}`), true);
  const targetUrl = new URL(harnessUrl);
  targetUrl.search = query;
  console.log(
    `qa harness launch: surface=${targetUrl.search} viewport=1280x820 userData=${userDataDirectory} (visual-harness/electron-main.mjs places it off every monitor)`,
  );
  const application = await electron.launch({
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
  application.on("close", () => activeApplications.delete(application));
  const page = await application.firstWindow({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await page.locator(".app").waitFor({ state: "visible" });
  return Object.freeze({ application, page });
}
