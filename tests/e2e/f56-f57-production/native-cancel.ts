import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import type { ElectronApplication, Page } from "playwright";

interface ProjectSnapshot {
  readonly projects: readonly string[];
  readonly selectedProject: string;
  readonly sessions: readonly Readonly<{
    label: string | null;
    current: string | null;
  }>[];
  readonly stageTitle: string;
  readonly freshStart: boolean;
  readonly draft: string;
}

export async function inspectNativeCancel(
  application: ElectronApplication,
  page: Page,
  registryPath: string,
): Promise<Record<string, unknown>> {
  const registryBefore = await readFile(registryPath);
  const stateBefore = await projectState(page);
  await application.evaluate(({ dialog }) => {
    const target = globalThis as typeof globalThis & {
      __f57OriginalOpen?: typeof dialog.showOpenDialog;
      __f57ResolveOpen?: () => void;
      __f57OpenCalls?: number;
    };
    target.__f57OriginalOpen ??= dialog.showOpenDialog;
    target.__f57OpenCalls = 0;
    dialog.showOpenDialog = (() => {
      target.__f57OpenCalls = (target.__f57OpenCalls ?? 0) + 1;
      return new Promise((resolveOpen) => {
        target.__f57ResolveOpen = () =>
          resolveOpen({ canceled: true, filePaths: [] });
      });
    }) as typeof dialog.showOpenDialog;
  });

  try {
    const trigger = page.getByRole("button", {
      name: "Create or open a Project",
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Project actions",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Open Project…", exact: true })
      .click();
    await waitForMain(application, () => {
      const target = globalThis as typeof globalThis & {
        __f57ResolveOpen?: () => void;
      };
      return typeof target.__f57ResolveOpen === "function";
    });

    await trigger.click();
    const pendingOpen = dialog.getByRole("button", {
      name: "Opening Project…",
      exact: true,
    });
    await pendingOpen.waitFor({ state: "visible" });
    const pendingObserved =
      (await pendingOpen.isDisabled()) &&
      (await pendingOpen.getAttribute("aria-busy")) === "true";
    await trigger.click();

    await application.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __f57ResolveOpen?: () => void;
      };
      target.__f57ResolveOpen?.();
      target.__f57ResolveOpen = undefined;
    });
    await trigger.click();
    const releasedOpen = dialog.getByRole("button", {
      name: "Open Project…",
      exact: true,
    });
    await releasedOpen.waitFor({ state: "visible" });
    await assertEventually(async () => releasedOpen.isEnabled());
    const pendingReleased = await releasedOpen.isEnabled();
    await page.keyboard.press("Escape");

    const calls = await application.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __f57OpenCalls?: number;
      };
      return target.__f57OpenCalls ?? 0;
    });
    await application.evaluate(({ dialog }) => {
      const target = globalThis as typeof globalThis & {
        __f57OriginalOpen?: typeof dialog.showOpenDialog;
        __f57ResolveOpen?: () => void;
        __f57OpenCalls?: number;
      };
      if (target.__f57OriginalOpen !== undefined) {
        dialog.showOpenDialog = target.__f57OriginalOpen;
      }
      target.__f57ResolveOpen = undefined;
      target.__f57OpenCalls = undefined;
    });

    const registryAfter = await readFile(registryPath);
    const stateAfter = await projectState(page);
    const privatePathAbsent = !/[A-Z]:\\|\/Users\//u.test(
      await page.locator("body").innerText(),
    );
    const observation = {
      nativeDialogCalls: calls,
      pendingObserved,
      pendingReleased,
      registryBytesUnchanged: registryBefore.equals(registryAfter),
      projectAndSessionStateUnchanged:
        JSON.stringify(stateBefore) === JSON.stringify(stateAfter),
      freshStartPreserved: stateAfter.freshStart,
      privatePathAbsent,
    };
    assert.deepEqual(observation, {
      nativeDialogCalls: 1,
      pendingObserved: true,
      pendingReleased: true,
      registryBytesUnchanged: true,
      projectAndSessionStateUnchanged: true,
      freshStartPreserved: true,
      privatePathAbsent: true,
    });
    return observation;
  } finally {
    await application
      .evaluate(({ dialog }) => {
        const target = globalThis as typeof globalThis & {
          __f57OriginalOpen?: typeof dialog.showOpenDialog;
          __f57ResolveOpen?: () => void;
          __f57OpenCalls?: number;
        };
        target.__f57ResolveOpen?.();
        if (target.__f57OriginalOpen !== undefined) {
          dialog.showOpenDialog = target.__f57OriginalOpen;
        }
        target.__f57ResolveOpen = undefined;
        target.__f57OpenCalls = undefined;
      })
      .catch(() => undefined);
  }
}

async function projectState(page: Page): Promise<ProjectSnapshot> {
  return page.evaluate(() => ({
    projects: Array.from(document.querySelectorAll(".proj-name")).map(
      (element) => element.textContent?.trim() ?? "",
    ),
    selectedProject:
      document.querySelector(".proj.is-open .proj-name")?.textContent?.trim() ??
      "",
    sessions: Array.from(document.querySelectorAll(".session-row")).map(
      (element) => ({
        label: element.getAttribute("aria-label"),
        current: element.getAttribute("aria-current"),
      }),
    ),
    stageTitle: document.querySelector(".stage-title")?.textContent?.trim() ?? "",
    freshStart: document.querySelector(".fresh-start-state") !== null,
    draft:
      document.querySelector<HTMLTextAreaElement>("#direct-input")?.value ?? "",
  }));
}

async function waitForMain(
  application: ElectronApplication,
  predicate: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await application.evaluate(predicate)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("main-process-condition-timeout");
}

async function assertEventually(
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail("renderer-condition-timeout");
}
