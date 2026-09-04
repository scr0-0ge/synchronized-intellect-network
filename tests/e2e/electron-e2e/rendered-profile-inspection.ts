import { basename, join } from "node:path";

import type { Page } from "playwright";

import { HarnessFailure } from "./harness-failure.ts";
import { repositoryRoot } from "./production-composition.ts";
import { result, type ItemResult } from "./result.ts";

export type RenderedProfileObservation = Readonly<{
  requestedModelLabel: "Profile Alpha";
  requestedIntensityLabel: "Deep review";
  requestedExecutionLabel: "Single agent";
  requestedAccessLabel: "Full access";
  effectiveDifferenceLabel: "Observed different value";
  historicalLabel: "Not recorded";
  unknownLabel: "Unknown";
  mismatchTerminalFailed: true;
  opaqueNativeValuesAbsent: true;
  screenshotCaptured: true;
}>;

const collapsedProjectMessage = "Opening this Project loads its Sessions.";

const bridgeKeys = Object.freeze([
  "adoptProjectHistory",
  "beginSubscriptionAuthentication",
  "browse",
  "cancel",
  "cancelPreparedSubscriptionAuthentication",
  "createProject",
  "discoverProjectHistories",
  "getSnapshot",
  "hideProjectHistory",
  "inspectSubscriptionAuthentication",
  "interruptActiveTurn",
  "loadAppearancePreference",
  "loadDirectSessionProfile",
  "mutateSessionMetadata",
  "observeProject",
  "openProject",
  "perform",
  "prepareSubscriptionAuthentication",
  "removeProject",
  "removeSession",
  "saveAppearancePreference",
  "selectProject",
  "submitDirectInput",
  "useDirectSessionProfileAsDefault",
  "writeClipboardText",
]);
const windowBridgeKeys = Object.freeze([
  "close",
  "minimize",
  "observeState",
  "toggleMaximize",
]);

export const projectedNativeModel =
  "Dm_jNv_EMAy_Y0OVELFexo_UKhItXc68dWq5HaRT2EVTas";
export const historicalNativeModel = "legacy-private-native-model-key";
export const unknownNativeModel = "unknown-private-native-model-key";
export const mismatchedNativeModel = "mismatched-private-native-model-key";

export async function inspectRenderedProfileProjection(
  page: Page,
  selectedProjectDirectory: string,
  collapsedProjectDirectory: string,
  waitForContinuationProfileReady: (page: Page) => Promise<void>,
): Promise<RenderedProfileObservation> {
  const projectTree = page.locator(
    '.rail[aria-label="Projects and Agent Sessions"]',
  );
  try {
    await projectTree.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new HarnessFailure(
      "E2E_PROFILE_PROJECTION_FAILED",
      "the design-derived Project tree did not render",
    );
  }
  const projects = projectTree.locator(".session-scroll > .proj");
  const projectCount = await projects.count();
  const projectNames = (
    await projects.locator(".proj-head .proj-name").allTextContents()
  ).map((value) => value.trim());
  const selectedProjectName = basename(selectedProjectDirectory);
  const collapsedProjectName = basename(collapsedProjectDirectory);
  const selectedProjectIndex = projectNames.indexOf(selectedProjectName);
  const collapsedProjectIndex = projectNames.indexOf(collapsedProjectName);
  const railTitle =
    (await projectTree.locator(".rail-head .rail-title").textContent())?.trim() ??
    "";
  const selectedProject = projects.nth(selectedProjectIndex);
  const collapsedProject = projects.nth(collapsedProjectIndex);
  const selectedOpen =
    selectedProjectIndex >= 0 &&
    (await selectedProject.getAttribute("data-open")) === "true" &&
    (await selectedProject.getAttribute("class"))?.split(/\s+/u).includes("is-open") ===
      true &&
    (await selectedProject.locator(".proj-toggle").getAttribute("aria-expanded")) ===
      "true";
  const collapsedClosed =
    collapsedProjectIndex >= 0 &&
    (await collapsedProject.getAttribute("data-open")) === "false" &&
    (await collapsedProject.locator(".proj-toggle").getAttribute("aria-expanded")) ===
      "false";
  const sessionRows = selectedProject.locator(
    ".proj-sessions > .session-row-shell > .session-row",
  );
  const sessionRowCount =
    selectedProjectIndex < 0 ? 0 : await sessionRows.count();
  const collapsedSessionCount =
    collapsedProjectIndex < 0
      ? -1
      : await collapsedProject.locator(".proj-sessions .session-row").count();
  const collapsedMessage =
    collapsedProjectIndex < 0
      ? ""
      : ((await collapsedProject.locator(".proj-empty").textContent())?.trim() ??
        "");
  const projectTreeExact =
    projectCount === 2 &&
    railTitle.startsWith("Projects") &&
    selectedOpen &&
    collapsedClosed &&
    sessionRowCount === 4 &&
    collapsedSessionCount === 0 &&
    collapsedMessage === collapsedProjectMessage;
  if (!projectTreeExact) {
    throw new HarnessFailure(
      "E2E_PROFILE_PROJECTION_FAILED",
      `Project-tree expected=two-projects/selected-open/four-nested-sessions/collapsed-empty observed=projects:${projectCount},title:${JSON.stringify(
        railTitle,
      )},selected-open:${selectedOpen},sessions:${sessionRowCount},collapsed-closed:${collapsedClosed},collapsed-sessions:${collapsedSessionCount},collapsed-copy:${
        collapsedMessage === collapsedProjectMessage
      }`,
    );
  }
  await sessionRows.first().waitFor({ state: "visible", timeout: 10_000 });
  const inspector = page.locator(".inspector");
  const initialText = (await inspector.innerText()).trim();
  const requestedExact = [
    "Profile Alpha",
    "Deep review",
    "Single agent",
    "Full access",
    "Deliberation",
  ].every((value) => initialText.includes(value));
  const validContextRing = page.locator(".stage .ctx-ring");
  await validContextRing.waitFor({ state: "visible", timeout: 5_000 });
  const validContextExact =
    (await validContextRing.count()) === 1 &&
    (await validContextRing.getAttribute("title")) ===
      "Context window · 78,000 of 200,000 tokens remaining (61% used)" &&
    (await validContextRing.getAttribute("aria-label")) ===
      "Context window 61 percent used" &&
    ((await validContextRing.locator(".ctx-pct").textContent())?.trim() ?? "") ===
      "39%";

  await sessionRows.nth(1).click();
  await page.waitForFunction(
    () => document.querySelector(".inspector")?.textContent?.includes("Not recorded"),
    undefined,
    { timeout: 5_000 },
  );
  const historicalText = (await inspector.innerText()).trim();
  const historicalExact = historicalText.includes("Not recorded");
  await page.waitForFunction(
    () => document.querySelectorAll(".stage .ctx-ring").length === 0,
    undefined,
    { timeout: 5_000 },
  );
  const absentContextRingExact =
    (await page.locator(".stage .ctx-ring").count()) === 0;

  await sessionRows.nth(2).click();
  await page.waitForFunction(
    () => document.querySelector(".inspector")?.textContent?.includes("Profile Gamma"),
    undefined,
    { timeout: 5_000 },
  );
  const unknownText = (await inspector.innerText()).trim();
  const unknownExact =
    unknownText.includes("Profile Gamma") && unknownText.includes("Unknown");
  const nullWindowContextRingExact =
    (await page.locator(".stage .ctx-ring").count()) === 0;

  await sessionRows.nth(3).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".inspector")?.textContent?.includes("Profile Delta") &&
      document
        .querySelector(".inspector")
        ?.textContent?.includes("Observed different value"),
    undefined,
    { timeout: 5_000 },
  );
  const mismatchText = (await inspector.innerText()).trim();
  const effectiveFacts = await inspector
    .locator(".insp-section")
    .filter({ hasText: "Effective" })
    .locator(".kv-row")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        label: row.querySelector(":scope > dt")?.textContent?.trim() ?? "",
        value: row.querySelector(":scope > dd")?.textContent?.trim() ?? "",
      })),
    );
  const differenceExact =
    mismatchText.includes("Observed different value") &&
    JSON.stringify(effectiveFacts) ===
      JSON.stringify([
        { label: "Model", value: "Profile Delta · matches requested" },
        {
          label: "Deliberation",
          value: "Observed different value · differs from requested",
        },
        { label: "Access", value: "Full access · matches requested" },
      ]);
  const mismatchTerminalFailed =
    (await sessionRows.nth(3).getAttribute("aria-label"))?.endsWith(", Failed") ===
    true;

  await sessionRows.first().click();
  await page.waitForFunction(
    () => document.querySelector(".inspector")?.textContent?.includes("Profile Alpha"),
    undefined,
    { timeout: 5_000 },
  );
  const renderedBody = await page.locator("body").innerText();
  const opaqueNativeValuesAbsent = [
    projectedNativeModel,
    historicalNativeModel,
    unknownNativeModel,
    mismatchedNativeModel,
    "native-deep",
    "native-legacy",
    "native-focused",
    "native-lower",
    "restricted",
  ].every((value) => !renderedBody.includes(value));
  await page.screenshot({
    path: join(repositoryRoot, "dist", "profile-projection-observation.png"),
    fullPage: true,
  });
  await sessionRows.nth(3).click();
  await page.waitForFunction(
    () => document.querySelector(".inspector")?.textContent?.includes("Profile Delta"),
    undefined,
    { timeout: 5_000 },
  );
  if (
    !requestedExact ||
    !differenceExact ||
    !mismatchTerminalFailed ||
    !historicalExact ||
    !unknownExact ||
    !validContextExact ||
    !absentContextRingExact ||
    !nullWindowContextRingExact ||
    !opaqueNativeValuesAbsent
  ) {
    throw new HarnessFailure(
      "E2E_PROFILE_PROJECTION_FAILED",
      `profile observations failed: requested=${requestedExact},difference=${differenceExact},mismatch-terminal-failed=${mismatchTerminalFailed},historical=${historicalExact},unknown=${unknownExact},context-valid=${validContextExact},context-absent-hidden=${absentContextRingExact},context-null-window-hidden=${nullWindowContextRingExact},native-containment=${opaqueNativeValuesAbsent}`,
    );
  }
  await sessionRows.first().click();
  await waitForContinuationProfileReady(page);
  return Object.freeze({
    requestedModelLabel: "Profile Alpha" as const,
    requestedIntensityLabel: "Deep review" as const,
    requestedExecutionLabel: "Single agent" as const,
    requestedAccessLabel: "Full access" as const,
    effectiveDifferenceLabel: "Observed different value" as const,
    historicalLabel: "Not recorded" as const,
    unknownLabel: "Unknown" as const,
    mismatchTerminalFailed: true as const,
    opaqueNativeValuesAbsent: true as const,
    screenshotCaptured: true as const,
  });
}

export async function inspectRendererBoundary(
  page: Page,
  projectDirectory: string,
  profileProjection: RenderedProfileObservation,
): Promise<ItemResult> {
  const selectors = [
    ".body-grid > .rail",
    ".body-grid > .stage",
    ".body-grid > .inspector",
  ];
  const counts = await Promise.all(
    selectors.map((selector) => page.locator(selector).count()),
  );
  const boxes = await Promise.all(
    selectors.map((selector) => page.locator(selector).boundingBox()),
  );
  const orderedPanes =
    counts.every((count) => count === 1) &&
    boxes.every((box) => box !== null) &&
    boxes[0]!.x < boxes[1]!.x &&
    boxes[1]!.x < boxes[2]!.x;
  const boundary = await page.evaluate(
    async ({ expectedKeys, expectedWindowKeys, fullPath, projectBasename }) => {
      const nodeGlobals = [
        typeof (globalThis as { process?: unknown }).process,
        typeof (globalThis as { require?: unknown }).require,
        typeof (globalThis as { module?: unknown }).module,
        typeof (globalThis as { Buffer?: unknown }).Buffer,
        typeof (globalThis as { global?: unknown }).global,
        typeof (globalThis as { __dirname?: unknown }).__dirname,
        typeof (globalThis as { __filename?: unknown }).__filename,
      ];
      const exposedBridge = (globalThis as { workbench?: object }).workbench;
      const bridgeOwnKeys =
        exposedBridge === undefined ? [] : Reflect.ownKeys(exposedBridge);
      const actualKeys = bridgeOwnKeys
        .map((key) =>
          typeof key === "string" ? key : `symbol:${key.description ?? ""}`,
        )
        .sort();
      const bridgeValuesAreFunctions =
        exposedBridge !== undefined &&
        bridgeOwnKeys.every(
          (key) =>
            typeof key === "string" &&
            typeof (exposedBridge as Record<string, unknown>)[key] === "function",
        );
      const exposedWindowBridge = (
        globalThis as { workbenchWindow?: object }
      ).workbenchWindow;
      const windowBridgeOwnKeys =
        exposedWindowBridge === undefined ? [] : Reflect.ownKeys(exposedWindowBridge);
      const actualWindowKeys = windowBridgeOwnKeys
        .map((key) =>
          typeof key === "string" ? key : `symbol:${key.description ?? ""}`,
        )
        .sort();
      const windowBridgeValuesAreFunctions =
        exposedWindowBridge !== undefined &&
        windowBridgeOwnKeys.every(
          (key) =>
            typeof key === "string" &&
            typeof (exposedWindowBridge as Record<string, unknown>)[key] ===
            "function",
        );
      const captionLabels = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".titlebar > .caption-buttons > button",
        ),
      ).map((button) => button.getAttribute("aria-label"));
      const needles = [
        fullPath,
        fullPath.replaceAll("\\", "/"),
        encodeURI(fullPath),
        encodeURI(fullPath.replaceAll("\\", "/")),
      ].map((value) => value.toLocaleLowerCase("en-US"));
      const containsFullPath = (value: string): boolean => {
        const lowered = value.toLocaleLowerCase("en-US");
        return needles.some((needle) => lowered.includes(needle));
      };
      let storageInspectable = true;
      let persistedContainsFullPath = false;
      let indexedDbEmpty = true;
      try {
        const storageValues: string[] = [];
        for (const storage of [localStorage, sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index) ?? "";
            storageValues.push(key, storage.getItem(key) ?? "");
          }
        }
        persistedContainsFullPath = storageValues.some(containsFullPath);
      } catch {
        storageInspectable = false;
      }
      try {
        if (typeof indexedDB.databases !== "function") {
          storageInspectable = false;
        } else {
          const databases = await indexedDB.databases();
          indexedDbEmpty = databases.length === 0;
          persistedContainsFullPath ||= databases.some((database) =>
            containsFullPath(database.name ?? ""),
          );
        }
      } catch {
        storageInspectable = false;
      }
      const surfaceStyle = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (element === null) return null;
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          backdropFilter: style.backdropFilter,
        };
      };
      const renderedText = document.body.innerText;
      return {
        nodeIsolated: nodeGlobals.every((value) => value === "undefined"),
        actualBridgeKeys: actualKeys,
        bridgeExact:
          bridgeValuesAreFunctions &&
          JSON.stringify(actualKeys) === JSON.stringify([...expectedKeys].sort()),
        actualWindowBridgeKeys: actualWindowKeys,
        windowBridgeExact:
          windowBridgeValuesAreFunctions &&
          JSON.stringify(actualWindowKeys) ===
          JSON.stringify([...expectedWindowKeys].sort()),
        captionLabels,
        captionStructureExact:
          JSON.stringify(captionLabels) ===
          JSON.stringify(["Minimize", "Maximize", "Close"]),
        nativeMaterialProven:
          document.documentElement.dataset.material === "on",
        renderedContainsFullPath: containsFullPath(renderedText),
        renderedContainsBasename: renderedText.includes(projectBasename),
        persistedContainsFullPath,
        indexedDbEmpty,
        storageInspectable,
        surface: {
          skin: document.documentElement.dataset.skin ?? null,
          glass: document.documentElement.dataset.glass ?? null,
          app: surfaceStyle(".app"),
          bodyGrid: surfaceStyle(".body-grid"),
          rail: surfaceStyle(".body-grid > .rail"),
          stage: surfaceStyle(".body-grid > .stage"),
          inspector: surfaceStyle(".body-grid > .inspector"),
          column: surfaceStyle(".transcript .column"),
        },
      };
    },
    {
      expectedKeys: bridgeKeys,
      expectedWindowKeys: windowBridgeKeys,
      fullPath: projectDirectory,
      projectBasename: basename(projectDirectory),
    },
  );
  const transparent = "rgba(0, 0, 0, 0)";
  const appGround = boundary.surface.app;
  const revealingRegions = [
    boundary.surface.bodyGrid,
    boundary.surface.rail,
    boundary.surface.stage,
    boundary.surface.inspector,
    boundary.surface.column,
  ];
  const oneSurfaceGround =
    boundary.surface.skin?.split(/\s+/u).includes("acrylic") === true &&
    boundary.surface.glass === "full" &&
    appGround !== null &&
    appGround.backgroundColor !== transparent &&
    appGround.backgroundImage === "none" &&
    appGround.backdropFilter === "none" &&
    revealingRegions.every(
      (style) =>
        style !== null &&
        style.backgroundColor === transparent &&
        style.backgroundImage === "none" &&
        style.backdropFilter === "none",
    );
  const failures = [
    ...(orderedPanes
      ? []
      : [
          `three-pane-layout expected=rail-stage-inspector,count[1,1,1],strictly-increasing-x observed=count${JSON.stringify(
            counts,
          )},x${JSON.stringify(boxes.map((box) => box?.x ?? null))}`,
        ]),
    ...(boundary.nodeIsolated
      ? []
      : ["node-api-isolation expected=true observed=false"]),
    ...(boundary.bridgeExact
      ? []
      : [
          `contextBridge-shape expected=${JSON.stringify(
            bridgeKeys,
          )} observed=${JSON.stringify(boundary.actualBridgeKeys)}`,
        ]),
    ...(boundary.windowBridgeExact
      ? []
      : [
          `window-contextBridge-shape expected=${JSON.stringify(
            windowBridgeKeys,
          )} observed=${JSON.stringify(boundary.actualWindowBridgeKeys)}`,
        ]),
    ...(boundary.captionStructureExact
      ? []
      : [
          `caption-controls expected=${JSON.stringify([
            "Minimize",
            "Maximize",
            "Close",
          ])} observed=${JSON.stringify(boundary.captionLabels)}`,
        ]),
    ...(boundary.nativeMaterialProven
      ? []
      : ["dwm-proven-native-material expected=on observed=off"]),
    ...(boundary.renderedContainsFullPath
      ? ["rendered-full-path expected=false observed=true"]
      : []),
    ...(boundary.renderedContainsBasename
      ? []
      : ["project-basename expected=true observed=false"]),
    ...(boundary.persistedContainsFullPath
      ? ["persisted-full-path expected=false observed=true"]
      : []),
    ...(boundary.indexedDbEmpty
      ? []
      : ["indexeddb-empty expected=true observed=false"]),
    ...(boundary.storageInspectable
      ? []
      : ["persisted-state-inspection expected=true observed=false"]),
    ...(profileProjection.opaqueNativeValuesAbsent
      ? []
      : ["profile-native-value-absent expected=true observed=false"]),
    ...(profileProjection.mismatchTerminalFailed
      ? []
      : ["profile-mismatch-terminal-failed expected=true observed=false"]),
    ...(oneSurfaceGround
      ? []
      : [
          `one-surface-ground expected=app-only observed=${JSON.stringify(
            boundary.surface,
          )}`,
        ]),
  ];
  return result(
    "2",
    failures.length === 0 ? "settled" : "not-settled",
    "The production Workbench has the ordered rail, stage, and inspector panes on one app-owned Acrylic ground; exposes only the two fixed global contextBridge objects with exact method sets; renders the exact caption-control structure over DWM-proven native material; has no page Node API; reveals only the Project basename; and renders durable profile projections without native values.",
    failures.length === 0
      ? "rail-stage-inspector order and one shared app ground, isolated page, exact project and window bridges, Minimize/Maximize/Close structure, DWM-proven native material, basename-only UI state, and requested/effective profile projection confirmed"
      : `failed checks: ${failures.join(",")}`,
  );
}
