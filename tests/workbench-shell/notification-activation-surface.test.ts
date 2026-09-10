import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
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
const rendererInstanceKey =
  "renderer-instance:00000000-0000-4000-8000-000000000129";
const differentProjectFeedback =
  "That Agent Session is in another Project, not the current Project.";
const activeApplications = new Set<ElectronApplication>();
let isolatedRoot = "";
let server: ViteDevServer | undefined;
let harnessUrl = "";

before(async () => {
  isolatedRoot = resolve(await mkdtemp(join(tmpdir(), "uaw-w129-profile-")));
  await Promise.all([
    mkdir(join(isolatedRoot, "home", "AppData", "Roaming"), { recursive: true }),
    mkdir(join(isolatedRoot, "home", "AppData", "Local"), { recursive: true }),
    mkdir(join(isolatedRoot, "temp"), { recursive: true }),
    mkdir(join(isolatedRoot, "runtime"), { recursive: true }),
  ]);
  server = await createViteBrowserTestServer({
    configFile: false,
    root: harnessRoot,
    logLevel: "silent",
    plugins: [
      {
        name: "w129-notification-activation",
        enforce: "pre",
        transform(code, id) {
          const normalizedId = id.replaceAll("\\", "/").split("?", 1)[0] ?? "";
          if (normalizedId.endsWith("/visual-harness/main.tsx")) {
            const marker =
              "const bridge: WorkbenchRendererBridge = Object.freeze({";
            assert.equal(code.includes(marker), true);
            return code.replace(
              marker,
              `${marker}\n  observeNotificationActivation(listener) {\n    const handler = (event: Event): void => {\n      listener((event as CustomEvent).detail);\n    };\n    window.addEventListener("qa-notification-activation", handler);\n    return () => window.removeEventListener("qa-notification-activation", handler);\n  },`,
            );
          }
          if (normalizedId.endsWith("/renderer/mount.tsx")) {
            const marker =
              "const rendererInstanceKey = `renderer-instance:${crypto.randomUUID()}`;";
            assert.equal(code.includes(marker), true);
            return code.replace(
              marker,
              `const rendererInstanceKey = "${rendererInstanceKey}";`,
            );
          }
          return null;
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
      if (isolatedRoot !== "") await removeTestDirectory(isolatedRoot);
    }
  }
});

test(
  "a notification from the prior Project explains why it cannot select there",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness("scenario=history-stale");
    try {
      await page.locator(".project-switch-trigger:not([hidden])").first().click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaProjectSelectionCalls === "1",
      );
      await page.waitForFunction(
        () =>
          document
            .querySelectorAll(".registered-project-button")[1]
            ?.getAttribute("aria-current") === "page",
      );
      assert.equal(await selectedSessionLabel(page), "Agent Session 02");

      await activate(page, "command-1", 0);

      await page
        .getByRole("status")
        .filter({ hasText: differentProjectFeedback })
        .waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await selectedSessionLabel(page), "Agent Session 02");
    } finally {
      await application.close();
    }
  },
);

test(
  "a current-Project notification still selects its exact Session without moving DOM focus",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness();
    try {
      await page
        .locator('.session-row[aria-label^="Agent Session 03,"]')
        .click();
      assert.equal(await selectedSessionLabel(page), "Agent Session 03");
      const focusOwner = page.locator(".project-menu");
      await focusOwner.focus();

      await activate(page, "command-1", 0);

      await page.waitForFunction(
        () =>
          document
            .querySelector('.session-row[aria-current="true"] .sr-title')
            ?.textContent === "Agent Session 01",
      );
      assert.equal(await focusOwner.evaluate((element) => element === document.activeElement), true);
      assert.equal(await page.getByText(differentProjectFeedback, { exact: true }).count(), 0);
    } finally {
      await application.close();
    }
  },
);

async function selectedSessionLabel(page: Page): Promise<string> {
  return page
    .locator('.session-row[aria-current="true"] .sr-title')
    .innerText();
}

async function activate(
  page: Page,
  commandKey: string,
  projectScopeEpoch: number,
): Promise<void> {
  await page.evaluate(
    (activation) => {
      window.dispatchEvent(
        new CustomEvent("qa-notification-activation", { detail: activation }),
      );
    },
    { commandKey, projectScopeEpoch, rendererInstanceKey },
  );
}

async function openHarness(
  query = "",
): Promise<Readonly<{ application: ElectronApplication; page: Page }>> {
  const userDataDirectory = resolve(
    await mkdtemp(join(isolatedRoot, "workbench-renderer-harness-")),
  );
  assert.equal(userDataDirectory.startsWith(`${isolatedRoot}${sep}`), true);
  const targetUrl = new URL(harnessUrl);
  targetUrl.search = query;
  const application = await electron.launch({
    executablePath: electronExecutable,
    args: [harnessMain, `--user-data-dir=${userDataDirectory}`],
    env: sanitizedEnvironment({ UAW_QA_URL: targetUrl.href }),
    timeout: 15_000,
  });
  activeApplications.add(application);
  application.on("close", () => activeApplications.delete(application));
  const page = await application.firstWindow({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await page.locator(".app").waitFor({ state: "visible" });
  return Object.freeze({ application, page });
}

function sanitizedEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      typeof value === "string" &&
      !/^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/iu.test(key) &&
      !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD|SECRET|TOKEN)$/iu.test(key)
    ) {
      environment[key] = value;
    }
  }
  const home = join(isolatedRoot, "home");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  return Object.assign(environment, {
    PATH: `${join(isolatedRoot, "runtime")};${join(systemRoot, "System32")}`,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: parse(home).root.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: join(isolatedRoot, "temp"),
    TMP: join(isolatedRoot, "temp"),
    TMPDIR: join(isolatedRoot, "temp"),
    CODEX_HOME: join(isolatedRoot, "codex-home"),
    CLAUDE_CONFIG_DIR: join(isolatedRoot, "claude-home"),
    UAW_QA_WIDTH: "1280",
    UAW_QA_HEIGHT: "820",
    ...extra,
  });
}
