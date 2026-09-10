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
    await mkdtemp(join(tmpdir(), "uaw-w3-recovery-archive-")),
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
        assert.match(basename(isolatedUserDataRoot), /^uaw-w3-recovery-archive-/u);
        await removeTestDirectory(isolatedUserDataRoot);
      }
    }
  }
});

test(
  "recovery archive waits for explicit confirmation, then forwards the exact acknowledgement request",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness();
    try {
      const archive = page
        .locator(".session-row-shell", { hasText: "結果不明" })
        .locator(".session-archive-trigger");
      await archive.waitFor({ state: "visible" });
      assert.equal(await archive.isDisabled(), false);

      await archive.click();
      const dialog = page.getByRole("alertdialog", {
        name: "Archive Agent Session",
        exact: true,
      });
      await dialog.waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSessionMetadataCalls,
        ),
        "0",
        "opening the acknowledgement dialog must not mutate the Session",
      );

      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSessionMetadataCalls,
        ),
        "0",
        "cancelling must not mutate the Session",
      );

      await archive.click();
      await dialog.getByRole("button", { name: "Archive", exact: true }).click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSessionMetadataCalls === "1",
      );
      const request = await page.evaluate(() =>
        JSON.parse(
          document.documentElement.dataset.qaLastSessionMetadata ?? "{}",
        ) as Record<string, unknown>,
      );
      assert.deepEqual(Object.keys(request), [
        "metadataKey",
        "operation",
        "acknowledgedUnknownOutcome",
      ]);
      assert.match(String(request.metadataKey), /^session-metadata:/u);
      assert.deepEqual(request.operation, { kind: "archive" });
      assert.equal(request.acknowledgedUnknownOutcome, true);
    } finally {
      await application.close();
    }
  },
);

async function openHarness(): Promise<
  Readonly<{ application: ElectronApplication; page: Page }>
> {
  const userDataDirectory = resolve(
    await mkdtemp(join(isolatedUserDataRoot, "renderer-harness-")),
  );
  assert.equal(isAbsolute(userDataDirectory), true);
  assert.equal(
    userDataDirectory.startsWith(`${isolatedUserDataRoot}${sep}`),
    true,
  );
  assert.match(basename(userDataDirectory), /^renderer-harness-/u);

  const targetUrl = new URL(harnessUrl);
  targetUrl.search = "scenario=session-metadata";
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
    if (application !== undefined) await closeAfterSetupFailure(application, error);
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
      "Renderer harness setup and application cleanup both failed.",
    );
  }
  throw setupError;
}