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

import { removeTestDirectory } from "../helpers/test-lifecycle.ts";
import {
  createViteBrowserTestServer,
} from "../helpers/vite-server.ts";
import type { ViteDevServer } from "vite";

const oldHistoryMarker = "F56_OLD_HISTORY_MARKER_7f3c9a";
const harnessRoot = fileURLToPath(
  new URL("./visual-harness/", import.meta.url),
);
let isolatedUserDataRoot = "";
let server: ViteDevServer | undefined;
let harnessUrl = "";
const electronExecutable = createRequire(import.meta.url)("electron") as string;
const harnessMain = fileURLToPath(
  new URL("./visual-harness/electron-main.mjs", import.meta.url),
);
const activeApplications = new Set<ElectronApplication>();

before(async () => {
  isolatedUserDataRoot = resolve(
    await mkdtemp(join(tmpdir(), "uaw-f56-user-data-")),
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
  assert.notEqual(harnessUrl, "", "the deterministic renderer harness must listen");
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
        assert.match(basename(isolatedUserDataRoot), /^uaw-f56-user-data-/u);
        await removeTestDirectory(isolatedUserDataRoot);
      }
    }
  }
});

test(
  "F56 explicit New Agent Session is isolated and selecting the existing rail Session restores it losslessly",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(1_280, 820);
    try {
      const sessionRows = page.locator(".rail .session-row");
      await sessionRows.first().waitFor({ state: "visible" });
      const originalOrder = await sessionRows.allTextContents();
      const oldMarkerPoint = await page
        .getByText(oldHistoryMarker, { exact: false })
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
        });
      const originalSelectedLabel = await sessionRows
        .filter({ has: page.locator('[aria-current="true"]') })
        .count();
      assert.equal(originalSelectedLabel, 0, "aria-current belongs on each row itself");
      assert.equal(await page.getByText(oldHistoryMarker, { exact: false }).count(), 1);

      const newSession = page.locator(".new-session-button").first();
      await newSession.click();
      await page.getByRole("button", { name: /^Start\b/u }).waitFor({
        state: "visible",
      });

      const markerDomCount = await page.getByText(oldHistoryMarker, {
        exact: false,
      }).count();
      const markerInAccessibilityTree = await accessibilityNames(page).then(
        (names) => names.some((name) => name.includes(oldHistoryMarker)),
      );
      const transcriptFocusableCount = await page.evaluate(() => {
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        return focusable.filter((element) => element.closest(".transcript") !== null)
          .length;
      });
      const oldPointHitsTranscript = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest(".transcript") !== null;
      }, oldMarkerPoint);
      const transcriptCount = await page.locator(".transcript").count();
      const selectedSessionCount = await page.locator('.session-row[aria-current="true"]').count();
      const returnAffordance = page.getByRole("button", {
        name: "Return to selected Session",
        exact: true,
      });
      const returnAffordanceObservation = {
        count: await returnAffordance.count(),
        visible: await returnAffordance.isVisible(),
        enabled: await returnAffordance.isEnabled(),
        primary:
          (await returnAffordance.getAttribute("class"))
            ?.split(/\s+/u)
            .includes("primary") ?? false,
        inFreshStartState: await returnAffordance.evaluate(
          (element) => element.closest(".fresh-start-state") !== null,
        ),
      };
      const selectedProjectNewSession = page.locator(
        '.proj.is-open .icon-btn[aria-label^="New Agent Session in "]',
      );
      const newSessionEntrypointsDisabled =
        (await selectedProjectNewSession.count()) === 1 &&
        (await selectedProjectNewSession.isDisabled()) &&
        (await page.locator(".rail-foot .new-session-button").isDisabled());
      const stageTitle = compactText(
        (await page.locator(".stage-title").textContent()) ?? "",
      );
      const inspectorText = compactText(
        (await page.locator(".inspector").allTextContents()).join(" "),
      );
      const statusbarText = compactText(
        (await page.locator(".statusbar").textContent()) ?? "",
      );
      const oldSessionChromeAbsent =
        !stageTitle.includes("Agent Session 01") &&
        selectedSessionCount === 0 &&
        !inspectorText.includes("Recorded") &&
        !inspectorText.includes("Status") &&
        !statusbarText.includes("Agent Session 01") &&
        !statusbarText.includes("Solution 5.6") &&
        !statusbarText.includes("Maximum");

      await sessionRows.first().click();
      await page.getByText(oldHistoryMarker, { exact: false }).waitFor({
        state: "visible",
        timeout: 1_000,
      });
      const restoredMarkerCount = await page.getByText(oldHistoryMarker, {
        exact: false,
      }).count();
      const restoredOrder = await sessionRows.allTextContents();
      const restoredSelected = await sessionRows.first().getAttribute("aria-current");

      await newSession.click();
      await page.getByRole("button", { name: /^Start\b/u }).waitFor({
        state: "visible",
      });
      const endpoint = page.locator("#direct-runtime-endpoint");
      await endpoint.click();
      const profileDialog = page.locator(
        '.composer .controlbar > .popover[role="dialog"]:not([hidden])',
      );
      await profileDialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await profileDialog.waitFor({ state: "hidden" });
      const composer = page.locator("#direct-input");
      await composer.fill("Start a deterministic fresh Agent Session.");
      const start = page.getByRole("button", { name: /^Start\b/u });
      const profileControlsUsable =
        (await endpoint.isEnabled()) &&
        (await page.getByRole("button", { name: /^Model(?::|\s|$)/u }).isEnabled()) &&
        (await start.isEnabled());
      await start.click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSubmissionCalls === "1",
      );
      const startReceipt = await page.evaluate(() => ({
        kind: document.documentElement.dataset.qaLastSubmissionKind ?? "",
        receipt: document.documentElement.dataset.qaLastSubmissionReceipt ?? "",
      }));
      const postSubmissionFresh =
        (await page.locator(".transcript").count()) === 0 &&
        (await page.getByText(oldHistoryMarker, { exact: false }).count()) === 0;
      await page.getByRole("heading", { name: "Starting Agent Session" }).waitFor({
        state: "visible",
      });
      const awaitingReturn = page.getByRole("button", {
        name: "Return to selected Session",
        exact: true,
      });
      const awaitingReturnFindable =
        (await awaitingReturn.count()) === 1 &&
        (await awaitingReturn.isVisible()) &&
        (await awaitingReturn.isEnabled());
      await awaitingReturn.click();
      await page.getByText(oldHistoryMarker, { exact: false }).waitFor({
        state: "visible",
      });
      const awaitingReturnRestoredMarkerCount = await page
        .getByText(oldHistoryMarker, { exact: false })
        .count();

      const observation = {
        markerDomCount,
        markerInAccessibilityTree,
        transcriptFocusableCount,
        oldPointHitsTranscript,
        transcriptCount,
        returnAffordanceObservation,
        newSessionEntrypointsDisabled,
        oldSessionChromeAbsent,
        profileControlsUsable,
        startReceipt,
        postSubmissionFresh,
        awaitingReturnFindable,
        awaitingReturnRestoredMarkerCount,
        restoredMarkerCount,
        restoredOrderMatches: JSON.stringify(restoredOrder) === JSON.stringify(originalOrder),
        restoredSelected,
      };
      assert.deepEqual(observation, {
        markerDomCount: 0,
        markerInAccessibilityTree: false,
        transcriptFocusableCount: 0,
        oldPointHitsTranscript: false,
        transcriptCount: 0,
        returnAffordanceObservation: {
          count: 1,
          visible: true,
          enabled: true,
          primary: true,
          inFreshStartState: true,
        },
        newSessionEntrypointsDisabled: true,
        oldSessionChromeAbsent: true,
        profileControlsUsable: true,
        startReceipt: { kind: "start", receipt: "accepted" },
        postSubmissionFresh: true,
        awaitingReturnFindable: true,
        awaitingReturnRestoredMarkerCount: 1,
        restoredMarkerCount: 1,
        restoredOrderMatches: true,
        restoredSelected: "true",
      });
    } finally {
      await application.close();
    }
  },
);

test(
  "F141 Create recovery reached from New Agent Session keeps Return enabled and restores the selected Session",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(1_280, 820);
    try {
      const oldTranscript = page.getByText(oldHistoryMarker, { exact: false });
      await oldTranscript.waitFor({ state: "visible" });
      await page.locator(".new-session-button").first().click();
      const returnToSelected = page.getByRole("button", {
        name: "Return to selected Session",
        exact: true,
      });
      await returnToSelected.waitFor({ state: "visible" });
      assert.equal(await oldTranscript.count(), 0);

      await page.evaluate(() => {
        history.replaceState({}, "", "?scenario=create-recovery-required");
      });
      await page.locator(".project-actions-button").first().click();
      const createProject = page.locator(".create-project-button").first();
      await createProject.waitFor({ state: "visible" });
      await createProject.click();
      await page.waitForFunction(() =>
        document.body.textContent?.includes(
          "The Project directory may have been created but could not be safely completed. Use Open Project… to recover it.",
        ) === true
      );

      assert.equal(await returnToSelected.isEnabled(), true);
      await returnToSelected.click();
      await oldTranscript.waitFor({ state: "visible" });
      assert.equal(await oldTranscript.count(), 1);
      assert.equal(
        await page.locator("#direct-input").count(),
        0,
        "recovery still blocks the composer after leaving only New Agent Session mode",
      );
    } finally {
      await application.close();
    }
  },
);

for (const viewport of [
  { name: "wide", width: 1_280, height: 820 },
  { name: "compact", width: 560, height: 760 },
] as const) {
  test(
    `F57 ${viewport.name} Project actions are accessible, floating, hit-testable, keyboard-complete, and cancel-safe`,
    { timeout: 30_000 },
    async () => {
      const { application, page } = await openHarness(
        viewport.width,
        viewport.height,
      );
      try {
        const beforeState = await projectState(page);
        const beforeLayout = await layoutState(page);
        const trigger = page.getByRole("button", {
          name: "Create or open a Project",
          exact: true,
        });
        const triggerCount = await trigger.count();
        const triggerVisible = triggerCount === 1 && (await trigger.isVisible());
        const viewportDiagnostic = await page.evaluate(() => ({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          compactMediaMatches: window.matchMedia("(max-width: 620px)").matches,
          railDisplay: getComputedStyle(document.querySelector(".rail")!).display,
          railHeadDisplay: getComputedStyle(
            document.querySelector(".rail-head")!,
          ).display,
          styleSheets: Array.from(document.styleSheets).map((sheet) => sheet.href),
        }));
        const triggerSurface = triggerVisible
          ? await trigger.evaluate((element) =>
              element.closest(".rail") !== null
                ? "rail"
                : element.closest(".stage") !== null
                  ? "stage"
                  : "other",
            )
          : "missing";

        let dialogCount = 0;
        let dialogName = "";
        let actionCounts = { create: 0, open: 0 };
        let rectanglesInViewport = false;
        let centerHitTargets = false;
        let initialFocusInside = false;
        let tabReachesAction = false;
        let escapeClosed = false;
        let focusReturned = false;
        let spaceOpened = false;
        let layoutStable = false;
        let cancelStateUnchanged = false;
        let cancelReleasedPending = false;
        let privatePathAbsent = false;

        if (triggerVisible) {
          await trigger.focus();
          await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog", {
            name: "Project actions",
            exact: true,
          });
          dialogCount = await dialog.count();
          if (dialogCount === 1) {
            await dialog.waitFor({ state: "visible" });
            dialogName = (await dialog.getAttribute("aria-label")) ?? "";
            const create = dialog.getByRole("button", {
              name: "Create Project…",
              exact: true,
            });
            const open = dialog.getByRole("button", {
              name: "Open Project…",
              exact: true,
            });
            actionCounts = {
              create: await page
                .getByRole("button", { name: "Create Project…", exact: true })
                .count(),
              open: await page
                .getByRole("button", { name: "Open Project…", exact: true })
                .count(),
            };
            rectanglesInViewport = await allInsideViewport(dialog, create, open);
            centerHitTargets =
              (await centerHits(create)) && (await centerHits(open));
            initialFocusInside = await dialog.evaluate(
              (element) => element.contains(document.activeElement),
            );
            await page.keyboard.press("Tab");
            tabReachesAction = await dialog.evaluate((element) => {
              const active = document.activeElement;
              return (
                active instanceof HTMLButtonElement && element.contains(active)
              );
            });
            layoutStable = sameLayout(beforeLayout, await layoutState(page));
            await page.keyboard.press("Escape");
            escapeClosed = (await dialog.count()) === 0 || !(await dialog.isVisible());
            focusReturned = await trigger.evaluate(
              (element) => document.activeElement === element,
            );

            if (!escapeClosed) await trigger.click();
            await trigger.focus();
            await page.keyboard.press("Space");
            spaceOpened = await dialog.isVisible();
            if (spaceOpened) {
              await open.click({ force: true });
              await page.waitForFunction(
                () => document.documentElement.dataset.qaOpenProjectCalls === "1",
              );
              cancelStateUnchanged =
                JSON.stringify(await projectState(page)) === JSON.stringify(beforeState);
              cancelReleasedPending =
                (await trigger.isEnabled()) &&
                ((await dialog.count()) === 0 || !(await dialog.isVisible()));
              privatePathAbsent = !/[A-Z]:\\|\/Users\//u.test(
                await page.locator("body").innerText(),
              );
            }
          }
        }

        console.log(
          `F57_VIEWPORT_OBSERVATION ${JSON.stringify({
            requested: viewport,
            observed: viewportDiagnostic,
            triggerSurface,
          })}`,
        );
        assert.deepEqual(
          {
            triggerCount,
            triggerVisible,
            dialogCount,
            dialogName,
            actionCounts,
            rectanglesInViewport,
            centerHitTargets,
            initialFocusInside,
            tabReachesAction,
            escapeClosed,
            focusReturned,
            spaceOpened,
            layoutStable,
            cancelStateUnchanged,
            cancelReleasedPending,
            privatePathAbsent,
          },
          {
            triggerCount: 1,
            triggerVisible: true,
            dialogCount: 1,
            dialogName: "Project actions",
            actionCounts: { create: 1, open: 1 },
            rectanglesInViewport: true,
            centerHitTargets: true,
            initialFocusInside: true,
            tabReachesAction: true,
            escapeClosed: true,
            focusReturned: true,
            spaceOpened: true,
            layoutStable: true,
            cancelStateUnchanged: true,
            cancelReleasedPending: true,
            privatePathAbsent: true,
          },
        );
      } finally {
        await application.close();
      }
    },
  );
}

test(
  "F169 code-block copy preserves the rendered bytes and remains operable in dark and light themes",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "scenario=code-copy",
    );
    try {
      const expected = [
        '  const greeting = "hello";',
        "\tconsole.log(greeting);",
        "",
        "return greeting;  ",
      ].join("\n");
      await page.evaluate(() => {
        document.documentElement.dataset.qaClipboardBridgeCalls = "0";
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText() {
              document.documentElement.dataset.qaWebClipboardCalled = "true";
              return Promise.reject(new Error("web clipboard path must not run"));
            },
          },
        });
      });

      const code = page.locator(".codeblock code");
      await code.waitFor({ state: "visible" });
      assert.equal(await code.textContent(), expected);
      const copy = page.getByRole("button", { name: "Copy code", exact: true });
      await copy.waitFor({ state: "visible" });
      const shellBox = await page.locator(".codeblock-shell").boundingBox();
      const copyBox = await copy.boundingBox();
      assert.ok(shellBox);
      assert.ok(copyBox);
      assert.ok(copyBox.x + copyBox.width <= shellBox.x + shellBox.width);
      assert.ok(copyBox.y < shellBox.y + shellBox.height / 2);

      const copyAndRead = async (): Promise<string> => {
        await page.evaluate(() => {
          document.documentElement.dataset.qaCopiedCode = "";
        });
        await copy.click();
        await page.waitForFunction(
          (payload) => document.documentElement.dataset.qaCopiedCode === payload,
          expected,
        );
        return page.evaluate(
          () => document.documentElement.dataset.qaCopiedCode ?? "",
        );
      };
      const darkStyle = await copy.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
      assert.equal(await copyAndRead(), expected);

      await page.evaluate(() => {
        document.documentElement.dataset.tone = "light";
      });
      const lightStyle = await copy.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
      assert.notDeepEqual(lightStyle, darkStyle);
      assert.equal(await copyAndRead(), expected);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaClipboardBridgeCalls,
        ),
        "2",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaWebClipboardCalled,
        ),
        undefined,
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "F155 archive click executes the mutation and Archived Sessions are reachable from the Project rail",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "scenario=session-metadata",
    );
    try {
      const archivedDisclosure = page.getByRole("button", {
        name: "Archived (1)",
        exact: true,
      });
      await archivedDisclosure.waitFor({ state: "visible" });
      await archivedDisclosure.click();
      await page.getByRole("button", { name: /^Restore 归档-/u }).waitFor({
        state: "visible",
      });

      const archive = page.getByRole("button", { name: /^Archive 会議-/u });
      await archive.waitFor({ state: "visible" });
      await archive.click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSessionMetadataCalls === "1",
      );
      await page.getByRole("status").filter({
        hasText: "Agent Session archived.",
      }).waitFor({ state: "visible" });
      assert.equal(await page.getByRole("alertdialog").count(), 0);

      const request = await page.evaluate(() =>
        JSON.parse(
          document.documentElement.dataset.qaLastSessionMetadata ?? "{}",
        ) as Record<string, unknown>,
      );
      assert.deepEqual(Object.keys(request), ["metadataKey", "operation"]);
      assert.match(String(request.metadataKey), /^session-metadata:/u);
      assert.deepEqual(request.operation, { kind: "archive" });
    } finally {
      await application.close();
    }
  },
);

test(
  "W136 an in-flight Session explains why it cannot be deleted before confirmation",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "scenario=session-removal-active",
    );
    try {
      const sessionTrigger = page.getByRole("button", {
        name: "Delete Agent Session 01",
        exact: true,
      });
      await sessionTrigger.waitFor({ state: "visible" });
      await sessionTrigger.click();

      const firstResponse = await page.waitForFunction(() => {
        const dialogCount = document.querySelectorAll('[role="alertdialog"]').length;
        const feedback = Array.from(document.querySelectorAll('[role="alert"]'))
          .map((element) => element.textContent ?? "")
          .find((text) => text.includes("turn is running"));
        return dialogCount > 0 || feedback !== undefined
          ? { dialogCount, feedback: feedback ?? null }
          : undefined;
      });
      assert.deepEqual(await firstResponse.jsonValue(), {
        dialogCount: 0,
        feedback:
          "Agent Session was not deleted because a turn is running. Let it finish, then try again.",
      });
      assert.equal(
        await page.evaluate(() =>
          Number(document.documentElement.dataset.qaSessionRemovalCalls ?? "0"),
        ),
        0,
        "the preflight must not send a removal request",
      );
      assert.equal(
        await sessionTrigger.count(),
        1,
        "the active Session remains in the rail",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "F94 Session deletion and Project removal require an accessible confirmation and report blocked work honestly",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(1_280, 820);
    try {
      const sessionTrigger = page.getByRole("button", {
        name: "Delete Agent Session 01",
        exact: true,
      });
      await sessionTrigger.waitFor({ state: "visible" });
      await sessionTrigger.focus();
      await sessionTrigger.click();
      const sessionDialog = page.getByRole("alertdialog", {
        name: "Delete Agent Session?",
        exact: true,
      });
      await sessionDialog.waitFor({ state: "visible" });
      assert.match(
        (await sessionDialog.textContent()) ?? "",
        /recorded conversation[\s\S]*cannot be undone/iu,
      );
      const cancel = sessionDialog.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      assert.equal(await cancel.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await sessionDialog
          .getByRole("button", { name: "Delete Session", exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      await sessionDialog.waitFor({ state: "hidden" });
      assert.equal(
        await sessionTrigger.evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(
        await page.evaluate(() =>
          Number(document.documentElement.dataset.qaSessionRemovalCalls ?? "0"),
        ),
        0,
      );

      await sessionTrigger.click();
      await page
        .getByRole("alertdialog", { name: "Delete Agent Session?" })
        .getByRole("button", { name: "Delete Session", exact: true })
        .click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSessionRemovalCalls === "1",
      );
      await page.getByRole("alert").filter({
        hasText: "turn activity could not be verified",
      }).waitFor({ state: "visible" });
      const sessionRequest = await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.qaLastSessionRemoval ?? "{}") as Record<string, unknown>,
      );
      assert.deepEqual(Object.keys(sessionRequest), ["removalKey"]);
      assert.match(String(sessionRequest.removalKey), /^session-removal:/u);

      const projectTrigger = page.locator(
        ".proj.is-open .project-removal-trigger",
      );
      await projectTrigger.click();
      const projectDialog = page.getByRole("alertdialog", {
        name: "Remove Project from Workbench?",
        exact: true,
      });
      await projectDialog.waitFor({ state: "visible" });
      assert.match(
        (await projectDialog.textContent()) ?? "",
        /folder and files will stay on disk/iu,
      );
      await projectDialog
        .getByRole("button", { name: "Remove Project", exact: true })
        .click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaProjectRemovalCalls === "1",
      );
      await page.getByRole("alert").filter({
        hasText: "turn is running",
      }).waitFor({ state: "visible" });
      const projectRequest = await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.qaLastProjectRemoval ?? "{}") as Record<string, unknown>,
      );
      assert.deepEqual(Object.keys(projectRequest), ["selectionKey"]);
      assert.match(String(projectRequest.selectionKey), /^project-selection:/u);
    } finally {
      await application.close();
    }
  },
);

test(
  "F94 successful removal of the final Project moves focus to the recoverable result",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "scenario=project-removal-success",
    );
    try {
      const projectTrigger = page.locator(
        ".proj.is-open .project-removal-trigger",
      );
      await projectTrigger.waitFor({ state: "visible", timeout: 5_000 });
      await projectTrigger.focus();
      await projectTrigger.click();
      const dialog = page.getByRole("alertdialog", {
        name: "Remove Project from Workbench?",
        exact: true,
      });
      await dialog.waitFor({ state: "visible", timeout: 5_000 });
      await dialog
        .getByRole("button", { name: "Remove Project", exact: true })
        .click({ timeout: 5_000 });
      await dialog.waitFor({ state: "hidden", timeout: 5_000 });
      await page
        .getByRole("heading", {
          name: "No Projects in the Workbench",
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 5_000 });
      const result = page.getByRole("status").filter({
        hasText: "folder and files remain on disk",
      });
      await result.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(
        await result.evaluate((node) => node === document.activeElement),
        true,
      );
      assert.equal(await projectTrigger.count(), 0);
      assert.equal(
        await page.getByRole("button", { name: /^Open Project/u }).isEnabled(),
        true,
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "Settings overlays the live Project surface instead of rebuilding its transcript",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(1_280, 820);
    try {
      const stage = page.locator(".stage");
      const transcript = page.locator(".transcript");
      await stage.waitFor({ state: "visible", timeout: 5_000 });
      const originalStage = await stage.elementHandle();
      const originalTranscript = await transcript.elementHandle();
      assert.ok(originalStage, "the Project stage must exist before opening Settings");
      assert.ok(
        originalTranscript,
        "the Project transcript must exist before opening Settings",
      );
      const transcriptScrollTop = await originalTranscript.evaluate((element) => {
        const target = element as HTMLElement;
        target.scrollTop = Math.min(120, target.scrollHeight - target.clientHeight);
        return target.scrollTop;
      });

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor({
        state: "visible",
        timeout: 5_000,
      });

      assert.deepEqual(
        await originalStage.evaluate((element) => ({
          connected: element.isConnected,
          ariaHidden: element.getAttribute("aria-hidden"),
          containment: getComputedStyle(element).contain,
          covered: (() => {
            const settings = document.querySelector<HTMLElement>(".settings");
            if (settings === null) return false;
            const stageRect = element.getBoundingClientRect();
            const settingsRect = settings.getBoundingClientRect();
            return (
              settingsRect.left <= stageRect.left &&
              settingsRect.right >= stageRect.right &&
              settingsRect.top <= stageRect.top &&
              settingsRect.bottom >= stageRect.bottom &&
              getComputedStyle(settings).position === "fixed"
            );
          })(),
          settingsOwnsFocus:
            document.activeElement?.classList.contains(
              "settings-close-button",
            ) === true,
        })),
        {
          connected: true,
          ariaHidden: "true",
          containment: "strict",
          covered: true,
          settingsOwnsFocus: true,
        },
        "Settings must cover and deactivate the existing stage without disposing it",
      );
      assert.deepEqual(
        await originalTranscript.evaluate((element) => ({
          connected: element.isConnected,
          sameNode: element === document.querySelector(".transcript"),
          scrollTop: (element as HTMLElement).scrollTop,
        })),
        { connected: true, sameNode: true, scrollTop: transcriptScrollTop },
        "opening Settings must preserve the transcript node and its scroll position",
      );

      await page
        .getByRole("button", { name: "Close Settings", exact: true })
        .click();
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor({
        state: "detached",
        timeout: 5_000,
      });

      assert.equal(
        await originalStage.evaluate(
          (element) =>
            element === document.querySelector(".stage") &&
            element.isConnected &&
            element.getAttribute("aria-hidden") === null,
        ),
        true,
        "returning from Settings must reveal the same live stage",
      );
      assert.deepEqual(
        await originalTranscript.evaluate((element) => ({
          connected: element.isConnected,
          sameNode: element === document.querySelector(".transcript"),
          scrollTop: (element as HTMLElement).scrollTop,
        })),
        { connected: true, sameNode: true, scrollTop: transcriptScrollTop },
        "returning from Settings must retain the same transcript and scroll position",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "Codex running-turn composer stays editable, guides the same turn, and keeps exact Stop semantics",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "?scenario=interrupt",
    );
    try {
      const composer = page.locator(".composer").last();
      await composer.waitFor({ state: "visible" });
      const stop = composer.getByRole("button", { name: /Stop/u });
      await stop.waitFor({ state: "visible" });
      assert.equal(await stop.isEnabled(), true);
      assert.equal(await stop.getAttribute("aria-keyshortcuts"), "Escape");
      assert.equal(compactText((await stop.textContent()) ?? ""), "Stop Esc");
      await composer.getByText(
        "Guide this running turn · Stop this running turn",
        { exact: true },
      ).waitFor({ state: "visible" });
      assert.equal(await composer.locator(".submit-button").count(), 0);
      const input = composer.locator("#direct-input");
      assert.equal(await input.isEnabled(), true);
      const profileLoadsBeforeFocus = await page.evaluate(
        () => document.documentElement.dataset.qaProfileLoads,
      );
      await input.focus();
      await input.fill("Use the smaller verified correction.");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaProfileLoads,
        ),
        profileLoadsBeforeFocus,
        "textarea focus and typing remain inert to endpoint discovery",
      );
      const guide = composer.getByRole("button", { name: /Guide/u });
      assert.equal(await guide.isEnabled(), true);
      await input.press("Control+Enter");
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSteerCalls === "1",
      );
      assert.deepEqual(
        JSON.parse(
          await page.evaluate(
            () => document.documentElement.dataset.qaLastSteerRequest ?? "{}",
          ),
        ),
        {
          steerKey: "turn-steer:00000000-0000-4000-8000-000000000092",
          input: "Use the smaller verified correction.",
        },
      );
      assert.equal(await input.inputValue(), "");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSubmissionCalls,
        ),
        "0",
      );
      await input.fill("Keep this local draft if the turn stops.");

      await stop.click();
      await page.waitForFunction(
        () => document.documentElement.dataset.qaInterruptCalls === "1",
      );
      assert.deepEqual(
        JSON.parse(
          await page.evaluate(
            () => document.documentElement.dataset.qaLastInterruptRequest ?? "{}",
          ),
        ),
        {
          interruptKey:
            "turn-interrupt:00000000-0000-4000-8000-000000000091",
        },
      );
      await page.getByText("Interrupted", { exact: true }).first().waitFor({
        state: "visible",
      });
      await page.getByText(
        "The turn stopped at your request. This Agent Session is intact and can continue.",
        { exact: true },
      ).waitFor({ state: "visible" });
      assert.equal(
        await page.getByRole("heading", { name: "The Agent Session failed" }).count(),
        0,
      );
      assert.equal(await page.locator("#direct-input").isEnabled(), true);
      assert.equal(
        await page.locator("#direct-input").inputValue(),
        "Keep this local draft if the turn stops.",
      );
      assert.equal(await page.locator(".stop-button").count(), 0);
      assert.equal(await page.locator(".submit-button").count(), 1);

      await page.reload({ waitUntil: "networkidle" });
      const keyboardStop = page.getByRole("button", { name: /Stop/u });
      await keyboardStop.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.documentElement.dataset.qaInterruptCalls === "1",
      );
      await page.getByText("Interrupted", { exact: true }).first().waitFor({
        state: "visible",
      });
      assert.equal(await page.locator(".stop-button").count(), 0);
    } finally {
      await application.close();
    }
  },
);

test(
  "Claude running-turn composer keeps a local draft without exposing false same-turn guidance",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "?scenario=claude-running",
    );
    try {
      const composer = page.locator(".composer").last();
      await composer.waitFor({ state: "visible" });
      const input = composer.locator("#direct-input");
      assert.equal(await input.isEnabled(), true);
      assert.equal(await composer.locator(".guide-button").count(), 0);
      await page.getByText(
        "This Runtime does not support same-turn guidance. Your draft stays local. · Stop this running turn",
        { exact: true },
      ).first().waitFor({ state: "visible" });
      const profileLoadsBeforeFocus = await page.evaluate(
        () => document.documentElement.dataset.qaProfileLoads,
      );
      await input.focus();
      await input.fill("Claude draft remains local.");
      await input.press("Control+Enter");
      assert.equal(await input.inputValue(), "Claude draft remains local.");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSteerCalls,
        ),
        "0",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSubmissionCalls,
        ),
        "0",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaProfileLoads,
        ),
        profileLoadsBeforeFocus,
      );
      await composer.getByRole("button", { name: /Stop/u }).click();
      await page.getByText("Interrupted", { exact: true }).first().waitFor({
        state: "visible",
      });
      assert.equal(
        await page.locator("#direct-input").inputValue(),
        "Claude draft remains local.",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "F101 Arrow history recalls backward, moves the multiline caret, restores drafts forward, and keeps Ctrl+Enter sending",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "?scenario=interrupt",
    );
    try {
      const input = page.locator("#direct-input");
      await input.waitFor({ state: "visible" });
      await input.fill("Older accepted guidance.");
      await input.press("Control+Enter");
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSteerCalls === "1",
      );
      assert.equal(await input.inputValue(), "");
      await input.fill("Newer accepted guidance.");
      await input.press("Control+Enter");
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSteerCalls === "2",
      );
      assert.equal(await input.inputValue(), "");

      await input.press("ArrowUp");
      assert.equal(await input.inputValue(), "Newer accepted guidance.");
      await input.press("ArrowUp");
      assert.equal(await input.inputValue(), "Older accepted guidance.");

      await input.press("ArrowDown");
      assert.equal(await input.inputValue(), "Newer accepted guidance.");
      await input.press("ArrowDown");
      assert.equal(await input.inputValue(), "");

      const multilineDraft = "Keep the first line.\nEdit the second line.";
      await input.fill(multilineDraft);
      const secondLineCaret = multilineDraft.length;
      await input.evaluate((element, position) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.setSelectionRange(position, position);
      }, secondLineCaret);
      await input.press("ArrowUp");
      const movedCaret = await input.evaluate((element) =>
        (element as HTMLTextAreaElement).selectionStart
      );
      assert.equal(await input.inputValue(), multilineDraft);
      assert.equal(movedCaret < multilineDraft.indexOf("\n") + 1, true);

      await input.evaluate((element) => {
        (element as HTMLTextAreaElement).setSelectionRange(0, 0);
      });
      await input.press("ArrowUp");
      assert.equal(await input.inputValue(), "Newer accepted guidance.");
      await input.press("ArrowDown");
      assert.equal(await input.inputValue(), multilineDraft);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSteerCalls,
        ),
        "2",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "F101 direct composer keeps Ctrl+Enter as the send key and recalls the accepted input",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
    );
    try {
      const input = page.locator("#direct-input");
      const send = page.locator(".submit-button");
      await input.waitFor({ state: "visible" });
      await send.waitFor({ state: "visible" });
      await input.fill("Recall this accepted direct input.");
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(".submit-button");
        return button?.disabled === false;
      });
      await input.press("Control+Enter");
      await page.waitForFunction(
        () => document.documentElement.dataset.qaSubmissionCalls === "1",
      );
      await page.waitForFunction(
        () =>
          (document.querySelector<HTMLTextAreaElement>("#direct-input")?.value ??
            "missing") === "",
      );

      await input.press("ArrowUp");
      assert.equal(
        await input.inputValue(),
        "Recall this accepted direct input.",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSubmissionCalls,
        ),
        "1",
      );
    } finally {
      await application.close();
    }
  },
);

test(
  "a current-turn prompt suggestion fills the composer without sending and disappears on a suggestion-less next turn",
  { timeout: 30_000 },
  async () => {
    const { application, page } = await openHarness(
      1_280,
      820,
      "scenario=prompt-suggestions",
    );
    try {
      const suggestions = page.locator(".prompt-suggestion");
      await suggestions.first().waitFor({ state: "visible" });
      assert.deepEqual(await suggestions.allTextContents(), [
        "Check the remaining tests",
        "Explain the implementation trade-off",
      ]);
      assert.equal(await page.locator("#direct-input").inputValue(), "");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSubmissionCalls,
        ),
        "0",
      );

      await page.locator("#direct-input").fill("Keep this draft exactly as written.");
      await suggestions.first().evaluate((button) => (button as HTMLButtonElement).click());
      assert.equal(
        await page.locator("#direct-input").inputValue(),
        "Keep this draft exactly as written.",
        "a suggestion must never replace a non-empty local draft",
      );

      await page.locator("#direct-input").fill("");
      await suggestions.first().click();
      assert.equal(
        await page.locator("#direct-input").inputValue(),
        "Check the remaining tests",
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.dataset.qaSubmissionCalls,
        ),
        "0",
        "choosing a suggestion must not submit on the user's behalf",
      );

      await page.evaluate(() =>
        window.dispatchEvent(new Event("qa-prompt-suggestions-next-turn")),
      );
      await suggestions.first().waitFor({ state: "detached" });
      assert.equal(await suggestions.count(), 0, "an older turn is never reused");
    } finally {
      await application.close();
    }
  },
);

test("non-empty drafts visibly disable every prompt suggestion with a localized reason until cleared, and whitespace-only drafts do not count as a draft", { timeout: 45_000 }, async () => {
  for (const [locale, reason] of [
    ["en", "Clear the current draft before choosing a suggested follow-up."],
    ["zh-CN", "请先清空当前草稿，再选择追问建议。"],
  ]) {
    const { application, page } = await openHarness(1_280, 820, `scenario=prompt-suggestions&locale=${locale}`);
    try {
      const suggestions = page.locator(".prompt-suggestion");
      const input = page.locator("#direct-input");
      const blockedReason = page.locator("#prompt-suggestions-blocked-reason");
      await suggestions.first().waitFor({ state: "visible" });
      const labels = await suggestions.allTextContents();
      assert.equal(labels.length, 2);

      await input.fill("Keep this draft exactly as written.");
      assert.deepEqual(
        await suggestions.evaluateAll((buttons) => buttons.map((button) => ({
          disabled: (button as HTMLButtonElement).disabled,
          title: (button as HTMLButtonElement).title,
          describedBy: button.getAttribute("aria-describedby"),
        }))),
        labels.map(() => ({ disabled: true, title: reason, describedBy: "prompt-suggestions-blocked-reason" })),
        `${locale}: a non-empty draft must visibly disable every suggestion, explain why in the title, and reference a visible reason`,
      );
      assert.equal(await blockedReason.innerText(), reason, `${locale}: the disabled reason must also be visible text, not only a title`);
      await suggestions.evaluateAll((buttons) => buttons.forEach((button) => (button as HTMLButtonElement).click()));
      assert.equal(await input.inputValue(), "Keep this draft exactly as written.", "disabled suggestions preserve the exact draft");

      await input.fill("   ");
      assert.deepEqual(
        await suggestions.evaluateAll((buttons) => buttons.map((button) => ({
          disabled: (button as HTMLButtonElement).disabled,
          title: (button as HTMLButtonElement).title,
        }))),
        labels.map((label) => ({ disabled: false, title: label })),
        `${locale}: a whitespace-only draft is not a real draft and must not block the suggestions`,
      );
      assert.equal(await blockedReason.count(), 0, `${locale}: no blocked reason is shown when the draft is whitespace-only`);
      await suggestions.first().click();
      assert.equal(await input.inputValue(), "Check the remaining tests", "clicking a suggestion over a whitespace-only draft replaces it");

      await input.fill("");
      assert.deepEqual(
        await suggestions.evaluateAll((buttons) => buttons.map((button) => ({
          disabled: (button as HTMLButtonElement).disabled,
          title: (button as HTMLButtonElement).title,
        }))),
        labels.map((label) => ({ disabled: false, title: label })),
        "clearing the draft restores the suggestions and their original titles",
      );
      await suggestions.first().click();
      assert.equal(await input.inputValue(), "Check the remaining tests");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.qaSubmissionCalls), "0");
    } finally { await application.close(); }
  }
});

test("the follow-up suggestion row never overflows and every suggestion stays fully readable at 1440, 900 and 620 wide (w195)", { timeout: 45_000 }, async () => {
  for (const width of [1_440, 900, 620]) {
    const { application, page } = await openHarness(width, 900, "scenario=prompt-suggestions");
    try {
      const list = page.locator(".prompt-suggestion-list");
      await list.waitFor({ state: "visible" });
      const overflow = await list.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      assert.ok(
        overflow.scrollWidth <= overflow.clientWidth,
        `${width}px wide: scrollWidth ${overflow.scrollWidth} must not exceed clientWidth ${overflow.clientWidth}`,
      );
      const suggestionRects = await page.locator(".prompt-suggestion").evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { right: rect.right, innerWidth: window.innerWidth };
        }),
      );
      for (const rect of suggestionRects) {
        assert.ok(
          rect.right <= rect.innerWidth,
          `${width}px wide: a suggestion button's right edge ${rect.right} must not exceed innerWidth ${rect.innerWidth} (clipped off-screen, scrollWidth/clientWidth alone missed this)`,
        );
      }
      assert.deepEqual(
        await page.locator(".prompt-suggestion").allTextContents(),
        [
          "Check the remaining tests",
          "Explain the implementation trade-off",
        ],
        `${width}px wide: every suggestion must render its full text, none clipped out of view`,
      );
      // A realistic-but-longer follow-up suggestion (w214): the fixture's two short
      // strings never exercised the title-vs-list squeeze that clipped real suggestions
      // off-screen at 620px (w210 walkthrough). Mutate rendered text in place so the
      // stress case matches real CSS behavior without touching the shared fixture data
      // (out of this guard's territory) or any other assertion in this test file.
      const longSuggestions = [
        "Check the remaining tests in this module before merging",
        "Explain the layout trade-off between wrap and scroll here",
      ];
      await page.locator(".prompt-suggestion").evaluateAll((buttons, texts) => {
        buttons.forEach((button, index) => {
          button.textContent = texts[index] ?? button.textContent;
        });
      }, longSuggestions);
      const longGeometry = await page.locator(".prompt-suggestion").evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            right: rect.right,
            innerWidth: window.innerWidth,
            scrollWidth: button.scrollWidth,
            clientWidth: button.clientWidth,
            scrollHeight: button.scrollHeight,
            clientHeight: button.clientHeight,
          };
        }),
      );
      for (const geometry of longGeometry) {
        assert.ok(
          geometry.right <= geometry.innerWidth,
          `${width}px wide with a longer suggestion: right edge ${geometry.right} must not exceed innerWidth ${geometry.innerWidth}`,
        );
        assert.ok(
          geometry.scrollWidth <= geometry.clientWidth,
          `${width}px wide with a longer suggestion: scrollWidth ${geometry.scrollWidth} must not exceed clientWidth ${geometry.clientWidth} (text must wrap onto another line, not be clipped horizontally)`,
        );
        assert.ok(
          geometry.scrollHeight <= geometry.clientHeight,
          `${width}px wide with a longer suggestion: scrollHeight ${geometry.scrollHeight} must not exceed clientHeight ${geometry.clientHeight} (wrapped text must not be clipped vertically either)`,
        );
      }
    } finally {
      await application.close();
    }
  }
});

test("automatic continuation stop reason stays inside the Stage header without covering the transcript", { timeout: 45_000 }, async () => {
  for (const locale of ["en", "zh-CN"]) {
    const { application, page } = await openHarness(1_024, 768, `scenario=continuation-stop&locale=${locale}`, {
      APPDATA: join(isolatedUserDataRoot, "appdata"), LOCALAPPDATA: join(isolatedUserDataRoot, "local-appdata"),
    });
    try {
      await page.locator(".continuation-stop-notice").waitFor({ state: "visible" });
      const geometry = await page.evaluate(() => {
        const notice = document.querySelector(".continuation-stop-notice")!.getBoundingClientRect();
        const header = document.querySelector(".stage-head")!.getBoundingClientRect();
        const transcript = document.querySelector(".transcript-shell")?.getBoundingClientRect();
        return { noticeBottom: notice.bottom, headerBottom: header.bottom, transcriptTop: transcript?.top };
      });
      await page.screenshot({ path: join(tmpdir(), `uaw-w167-stop-${locale}.png`) });
      assert.ok(geometry.noticeBottom <= geometry.headerBottom + 1, JSON.stringify(geometry));
      assert.ok(geometry.transcriptTop !== undefined && geometry.transcriptTop >= geometry.noticeBottom,
        "the stop reason must not cover the conversation");
      assert.equal(await page.locator(".stage-head .turn-state").innerText(), locale === "en" ? "COMPLETED" : "已完成");
    } finally { await application.close(); }
  }
});

async function openHarness(
  width: number,
  height: number,
  query = "",
  environment: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ application: ElectronApplication; page: Page }>> {
  const userDataDirectory = resolve(
    await mkdtemp(join(isolatedUserDataRoot, "workbench-renderer-harness-")),
  );
  assert.equal(isAbsolute(userDataDirectory), true);
  assert.equal(userDataDirectory.startsWith(`${isolatedUserDataRoot}${sep}`), true);
  assert.match(basename(userDataDirectory), /^workbench-renderer-harness-/u);
  const targetUrl = new URL(harnessUrl);
  targetUrl.search = query;
  // One line per launch (issue 161 item 4): the surface this window opens, the
  // viewport it opens at, and the fact that it opens off the owner's screen.
  console.log(
    `qa harness launch: surface=${targetUrl.search || "(no query)"} viewport=${width}x${height} userData=${userDataDirectory} (visual-harness/electron-main.mjs places it off every monitor)`,
  );
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      executablePath: electronExecutable,
      args: [harnessMain, `--user-data-dir=${userDataDirectory}`],
      env: {
        ...process.env,
        ...environment,
        UAW_QA_URL: targetUrl.href,
        UAW_QA_WIDTH: String(width),
        UAW_QA_HEIGHT: String(height),
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

async function accessibilityNames(page: Page): Promise<readonly string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send("Accessibility.getFullAXTree");
    return tree.nodes
      .filter((node) => node.ignored !== true)
      .map((node) => node.name?.value)
      .filter((value): value is string => typeof value === "string");
  } finally {
    await session.detach();
  }
}

async function projectState(page: Page): Promise<unknown> {
  return page.evaluate(() => ({
    projectNames: Array.from(document.querySelectorAll(".proj-name")).map(
      (element) => element.textContent?.trim() ?? "",
    ),
    selectedProject: document
      .querySelector(".proj.is-open .proj-name")
      ?.textContent?.trim() ?? "",
    sessions: Array.from(document.querySelectorAll(".session-row")).map(
      (element) => ({
        label: element.getAttribute("aria-label"),
        current: element.getAttribute("aria-current"),
      }),
    ),
    stageTitle: document.querySelector(".stage-title")?.textContent?.trim() ?? "",
    newSession: document.querySelector(".target-bar.is-new") !== null,
  }));
}

interface RectSnapshot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface LayoutSnapshot {
  readonly rail: RectSnapshot | null;
  readonly stage: RectSnapshot | null;
}

async function layoutState(page: Page): Promise<LayoutSnapshot> {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) {
        return null;
      }
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        width: value.width,
        height: value.height,
      };
    };
    return { rail: rect(".rail"), stage: rect(".stage") };
  });
}

function sameLayout(beforeState: LayoutSnapshot, afterState: LayoutSnapshot): boolean {
  return JSON.stringify(beforeState) === JSON.stringify(afterState);
}

async function allInsideViewport(
  ...locators: Array<ReturnType<Page["locator"]>>
): Promise<boolean> {
  for (const locator of locators) {
    const inside = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight
      );
    });
    if (!inside) return false;
  }
  return true;
}

async function centerHits(
  locator: ReturnType<Page["locator"]>,
): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== null && (hit === element || element.contains(hit));
  });
}

function compactText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
