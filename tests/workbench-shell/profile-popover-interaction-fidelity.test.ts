import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderToString } from "solid-js/web";
import type { Plugin } from "vite";
import solid from "vite-plugin-solid";

import {
  PROFILE_POPOVER_ANCHOR_GAP,
  PROFILE_POPOVER_HORIZONTAL_GUTTER,
  PROFILE_POPOVER_MAX_WIDTH,
  PROFILE_POPOVER_VERTICAL_GUTTER,
  createProfilePopoverLifecycle,
  nextProfileOptionIndex,
  placeProfilePopover,
  toggleProfilePopover,
  type ProfilePopoverLifecycleElement,
  type ProfilePopoverLifecycleEnvironment,
  type ProfilePopoverLifecycleEvent,
  type ProfilePopoverPlacement,
  type ProfilePopoverRect,
} from "../../src/workbench-shell/renderer/profile-popover.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const composerUrl = new URL(
  "../../src/workbench-shell/renderer/composer.tsx",
  import.meta.url,
);
const stylesUrl = new URL(
  "../../src/workbench-shell/renderer/styles.css",
  import.meta.url,
);
const crtUrl = new URL(
  "../../src/workbench-shell/renderer/themes/theme-crt.css",
  import.meta.url,
);
const noOp = (): void => undefined;

type RenderedComponent = (
  props: Readonly<Record<string, unknown>>,
) => unknown;

interface RenderedPickerSeams {
  readonly ProfilePopover: RenderedComponent;
  readonly ProfileControlChips: RenderedComponent;
  readonly FixedModeChip: RenderedComponent;
}

const model = Object.freeze({
  key: "model:compass",
  label: "Shared Compass",
  provenanceLabel: null,
  workIntensityLabel: "MixedCase Control",
  workIntensities: Object.freeze([
    Object.freeze({ key: "intensity:brief", label: "Brief" }),
    Object.freeze({ key: "intensity:deep", label: "Deep" }),
  ]),
});

const secondModel = Object.freeze({
  ...model,
  key: "model:other",
  label: "Other Compass",
});

const endpoint = Object.freeze({
  endpointId: "codex-desktop" as const,
  key: "endpoint:codex",
  runtimeFamilyLabel: "Codex",
  endpointLabel: "Subscription",
  models: Object.freeze([model, secondModel]),
  executionModes: Object.freeze([
    Object.freeze({ key: "execution:single", label: "Single agent" }),
  ]),
  accessModes: Object.freeze([
    Object.freeze({ key: "access:full", label: "Full access" }),
  ]),
});

const secondEndpoint = Object.freeze({
  ...endpoint,
  endpointId: "claude-code-desktop" as const,
  key: "endpoint:claude",
  runtimeFamilyLabel: "Claude",
  endpointLabel: "Subscription",
});

test("picker geometry uses the accepted gap, gutters, maximum width, and current viewport", () => {
  assert.deepEqual(
    {
      gap: PROFILE_POPOVER_ANCHOR_GAP,
      horizontalGutter: PROFILE_POPOVER_HORIZONTAL_GUTTER,
      maxWidth: PROFILE_POPOVER_MAX_WIDTH,
      verticalGutter: PROFILE_POPOVER_VERTICAL_GUTTER,
    },
    { gap: 8, horizontalGutter: 40, maxWidth: 400, verticalGutter: 8 },
  );

  const anchor = rect({ left: 200, right: 320, top: 100, bottom: 132 });
  assert.deepEqual(
    placeProfilePopover(anchor, { width: 520, height: 300 }, {
      width: 1440,
      height: 900,
    }),
    { left: 200, top: 140, width: 400, maxHeight: 884 },
  );

  assert.deepEqual(
    placeProfilePopover(
      rect({ left: 1300, right: 1380, top: 100, bottom: 132 }),
      { width: 520, height: 300 },
      { width: 1440, height: 900 },
    ),
    { left: 1000, top: 140, width: 400, maxHeight: 884 },
  );
  assert.deepEqual(
    placeProfilePopover(
      rect({ left: -24, right: 72, top: 100, bottom: 132 }),
      { width: 280, height: 300 },
      { width: 1440, height: 900 },
    ),
    { left: 40, top: 140, width: 280, maxHeight: 884 },
  );
  assert.deepEqual(
    placeProfilePopover(
      rect({ left: 1300, right: 1380, top: 838, bottom: 870 }),
      { width: 400, height: 260 },
      { width: 1440, height: 900 },
    ),
    { left: 1000, top: 632, width: 400, maxHeight: 884 },
  );
  assert.deepEqual(
    placeProfilePopover(
      rect({ left: 350, right: 382, top: 760, bottom: 792 }),
      { width: 520, height: 1000 },
      { width: 390, height: 844 },
    ),
    { left: 40, top: 8, width: 310, maxHeight: 828 },
  );
});

test("one-open state and roving option focus stay independent from profile selections", () => {
  const endpointTrigger: Readonly<{ id: string }> = Object.freeze({
    id: "endpoint",
  });
  const modelTrigger: Readonly<{ id: string }> = Object.freeze({
    id: "model",
  });
  const selections = Object.freeze({
    endpoint: "endpoint:quartz",
    model: "model:compass",
    intensity: "intensity:deep",
    execution: "execution:single",
    access: "access:full",
  });

  const endpointOpen = toggleProfilePopover(
    null,
    "endpoint",
    endpointTrigger,
  );
  assert.deepEqual(endpointOpen, {
    kind: "endpoint",
    trigger: endpointTrigger,
  });
  assert.equal(
    toggleProfilePopover(endpointOpen, "endpoint", endpointTrigger),
    null,
  );
  assert.deepEqual(
    toggleProfilePopover(endpointOpen, "model", modelTrigger),
    { kind: "model", trigger: modelTrigger },
  );
  assert.deepEqual(selections, {
    endpoint: "endpoint:quartz",
    model: "model:compass",
    intensity: "intensity:deep",
    execution: "execution:single",
    access: "access:full",
  });

  assert.equal(nextProfileOptionIndex(0, 3, "ArrowDown"), 1);
  assert.equal(nextProfileOptionIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextProfileOptionIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextProfileOptionIndex(1, 3, "Home"), 0);
  assert.equal(nextProfileOptionIndex(1, 3, "End"), 2);
  assert.equal(nextProfileOptionIndex(0, 1, "ArrowDown"), 0);
  assert.equal(nextProfileOptionIndex(1, 3, "Tab"), null);
  assert.equal(nextProfileOptionIndex(1, 3, "Enter"), null);
  assert.equal(nextProfileOptionIndex(0, 0, "ArrowDown"), null);
});

test("lifecycle remeasures current geometry and removes every listener, observer, and frame", () => {
  const harness = lifecycleHarness();
  const lifecycle = createProfilePopoverLifecycle(harness.options);
  lifecycle.updateContentRevision("initial");

  assert.equal(harness.frames.pending, 1);
  harness.frames.flush();
  assert.deepEqual(harness.placements, [
    { left: 120, top: 148, width: 360, maxHeight: 784 },
  ]);
  assert.equal(harness.contentFocusCount(), 1);
  assert.deepEqual(harness.observedElements, ["anchor", "popover"]);

  harness.anchorRect = rect({
    left: 720,
    right: 800,
    top: 680,
    bottom: 712,
  });
  harness.viewport = { width: 900, height: 740 };
  harness.documentEvents.emit("scroll", lifecycleEvent("inside"));
  harness.viewportEvents.emit("resize", lifecycleEvent("viewport"));
  harness.fireResizeObserver();
  assert.equal(
    harness.frames.pending,
    1,
    "scroll, resize, and ResizeObserver callbacks coalesce into one frame",
  );
  harness.frames.flush();
  assert.deepEqual(harness.placements.at(-1), {
    left: 500,
    top: 492,
    width: 360,
    maxHeight: 724,
  });
  assert.equal(harness.contentFocusCount(), 1);

  harness.documentEvents.emit("scroll", lifecycleEvent("inside"));
  assert.equal(harness.frames.pending, 1);
  lifecycle.dispose();
  assert.equal(harness.frames.pending, 0);
  assert.equal(harness.frames.cancelled, 1);
  assert.equal(harness.resizeObserverDisconnects(), 1);
  assert.equal(harness.documentEvents.listenerCount, 0);
  assert.equal(harness.viewportEvents.listenerCount, 0);
  assert.equal(
    harness.documentEvents.added,
    harness.documentEvents.removed,
  );
  assert.equal(
    harness.viewportEvents.added,
    harness.viewportEvents.removed,
  );
});

test("lifecycle measures fresh intrinsic width before every atomic placement", () => {
  const harness = lifecycleHarness();
  harness.viewport = { width: 390, height: 844 };
  harness.intrinsicPopoverWidth = 400;
  const lifecycle = createProfilePopoverLifecycle(harness.options);

  assert.equal(harness.placements.length, 0);
  assert.equal(harness.publishedPopoverWidth, null);
  harness.frames.flush();
  assert.deepEqual(harness.placements.at(-1), {
    left: 40,
    top: 148,
    width: 310,
    maxHeight: 828,
  });
  assert.deepEqual(harness.measurementEvents, [
    "clear-width",
    "measure:400",
    "publish:310",
  ]);

  harness.viewport = { width: 1200, height: 900 };
  harness.documentEvents.emit("scroll", lifecycleEvent("inside"));
  harness.viewportEvents.emit("resize", lifecycleEvent("viewport"));
  harness.fireResizeObserver();
  assert.equal(harness.frames.pending, 1);
  harness.frames.flush();
  assert.deepEqual(harness.placements.at(-1), {
    left: 120,
    top: 148,
    width: 400,
    maxHeight: 884,
  });
  assert.deepEqual(harness.measurementEvents.slice(-3), [
    "clear-width",
    "measure:400",
    "publish:400",
  ]);

  harness.intrinsicPopoverWidth = 260;
  harness.fireResizeObserver();
  harness.frames.flush();
  assert.equal(harness.placements.at(-1)?.width, 260);
  harness.intrinsicPopoverWidth = 520;
  harness.fireResizeObserver();
  harness.frames.flush();
  assert.equal(harness.placements.at(-1)?.width, 400);
  assert.deepEqual(harness.measurementEvents.slice(-3), [
    "clear-width",
    "measure:520",
    "publish:400",
  ]);

  lifecycle.dispose();
});

test("content revisions focus once while geometry and dismissed work never steal focus", () => {
  const harness = lifecycleHarness();
  harness.focusTarget = "dialog";
  const lifecycle = createProfilePopoverLifecycle(harness.options);

  assert.equal(typeof lifecycle.updateContentRevision, "function");
  lifecycle.updateContentRevision("endpoint:loading");
  harness.frames.flush();
  assert.deepEqual(harness.focusEvents, ["dialog"]);

  lifecycle.updateContentRevision("endpoint:loading");
  harness.documentEvents.emit("scroll", lifecycleEvent("inside"));
  harness.viewportEvents.emit("resize", lifecycleEvent("viewport"));
  harness.fireResizeObserver();
  assert.equal(harness.frames.pending, 1);
  harness.frames.flush();
  assert.deepEqual(harness.focusEvents, ["dialog"]);

  harness.focusTarget = "selected-option";
  lifecycle.updateContentRevision("endpoint:ready:codex|claude");
  harness.frames.flush();
  assert.deepEqual(harness.focusEvents, ["dialog", "selected-option"]);

  harness.focusTarget = "dialog";
  lifecycle.updateContentRevision("endpoint:unavailable:auth|inspection");
  harness.frames.flush();
  assert.deepEqual(harness.focusEvents, [
    "dialog",
    "selected-option",
    "dialog",
  ]);

  harness.focusTarget = "late-option";
  lifecycle.updateContentRevision("endpoint:ready:replacement");
  assert.equal(harness.frames.pending, 1);
  harness.documentEvents.emit("focusin", lifecycleEvent("outside"));
  assert.deepEqual(harness.dismissals, ["focus-out"]);
  assert.equal(harness.frames.pending, 0);
  harness.frames.flush();
  lifecycle.updateContentRevision("endpoint:ready:too-late");
  assert.equal(harness.frames.pending, 0);
  assert.deepEqual(harness.focusEvents, [
    "dialog",
    "selected-option",
    "dialog",
  ]);
  lifecycle.dispose();

  const disposed = lifecycleHarness();
  const disposedLifecycle = createProfilePopoverLifecycle(disposed.options);
  disposedLifecycle.updateContentRevision("endpoint:loading");
  disposedLifecycle.dispose();
  assert.equal(disposed.frames.pending, 0);
  disposedLifecycle.updateContentRevision("endpoint:ready");
  assert.equal(disposed.frames.pending, 0);
  assert.deepEqual(disposed.focusEvents, []);
});

test("Escape and outside pointer restore focus while native Tab can leave without a trap", () => {
  const escape = lifecycleHarness();
  const escapeLifecycle = createProfilePopoverLifecycle(escape.options);
  const escapeEvent = lifecycleEvent("inside", "Escape");
  escape.documentEvents.emit("keydown", escapeEvent);
  assert.deepEqual(escape.dismissals, ["escape"]);
  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(escape.anchorFocusCount(), 1);
  escapeLifecycle.dispose();

  const outside = lifecycleHarness();
  const outsideLifecycle = createProfilePopoverLifecycle(outside.options);
  outside.documentEvents.emit("pointerdown", lifecycleEvent("other-trigger"));
  assert.deepEqual(outside.dismissals, []);
  const outsideEvent = lifecycleEvent("outside");
  outside.documentEvents.emit("pointerdown", outsideEvent);
  assert.deepEqual(outside.dismissals, ["outside-pointer"]);
  assert.equal(outsideEvent.defaultPrevented, true);
  assert.equal(outside.anchorFocusCount(), 1);
  outsideLifecycle.dispose();

  const tab = lifecycleHarness();
  const tabLifecycle = createProfilePopoverLifecycle(tab.options);
  const tabEvent = lifecycleEvent("inside", "Tab");
  tab.documentEvents.emit("keydown", tabEvent);
  assert.deepEqual(tab.dismissals, []);
  assert.equal(tabEvent.defaultPrevented, false);
  tab.documentEvents.emit("focusin", lifecycleEvent("outside"));
  assert.deepEqual(tab.dismissals, ["focus-out"]);
  assert.equal(tab.anchorFocusCount(), 0);
  tabLifecycle.dispose();

  const otherTrigger = lifecycleHarness();
  const otherTriggerLifecycle = createProfilePopoverLifecycle(
    otherTrigger.options,
  );
  otherTrigger.documentEvents.emit(
    "focusin",
    lifecycleEvent("other-trigger"),
  );
  assert.deepEqual(otherTrigger.dismissals, ["focus-out"]);
  assert.equal(otherTrigger.anchorFocusCount(), 0);
  otherTriggerLifecycle.dispose();
});

test("rendered pickers keep exact locked, loading, mixed-case, roving, and fixed-mode semantics", async () => {
  await withRenderedPickerSeams((module) => {
    const loading = renderComponent(module.ProfilePopover, {
      ...popoverProps("endpoint"),
      profile: profileState("loading", null),
    });
    assert.match(loading, /id="direct-profile-popover"/u);
    assert.match(loading, /role="dialog"/u);
    assert.match(loading, /aria-modal="false"/u);
    assert.match(
      loading,
      /aria-labelledby="direct-profile-popover-heading"/u,
    );
    assert.match(
      loading,
      /id="direct-profile-popover-heading"[^>]*>Endpoint/u,
    );
    assert.match(loading, /role="status"/u);
    assert.match(loading, /aria-live="polite"/u);
    assert.match(loading, /aria-busy="true"/u);
    assert.match(loading, /Reading endpoint catalogs…/u);
    assert.match(
      loading,
      /Each runtime is inspected in its own boundary\./u,
    );
    const loadingText = plainText(loading);
    assert.equal(
      loadingText,
      "Endpoint Reading endpoint catalogs… Each runtime is inspected in its own boundary.",
    );
    assert.doesNotMatch(loading, /class="n"/u);
    assert.doesNotMatch(loading, /role="listbox"|role="option"/u);
    assert.doesNotMatch(loadingText, /Not inspected|Catalog ready/u);
    assert.doesNotMatch(loadingText, /Only endpoints with/u);
    assert.doesNotMatch(loadingText, /Retry|Reload/u);
    assert.doesNotMatch(loading, /Agent Runtime Endpoint/u);
    const hiddenFirstFrame = renderComponent(module.ProfilePopover, {
      ...popoverProps("endpoint"),
      anchor: Object.freeze({}),
      profile: profileState("loading", null),
    });
    assert.match(hiddenFirstFrame, /style="[^"]*visibility:hidden/u);
    assert.doesNotMatch(hiddenFirstFrame, /style="[^"]*width:/u);

    const endpointPicker = renderComponent(
      module.ProfilePopover,
      popoverProps("endpoint"),
    );
    assert.match(endpointPicker, /role="listbox"/u);
    assert.equal(endpointPicker.match(/role="option"/gu)?.length, 2);
    assert.equal(
      endpointPicker.match(/data-profile-option="true"/gu)?.length,
      2,
    );
    const readyEndpointOptions = profileOptions(endpointPicker);
    assert.equal(readyEndpointOptions.length, 2);
    assert.match(
      endpointPicker,
      /id="direct-profile-popover-heading"[^>]*>\s*Endpoint\s*<span class="n">2<\/span>/u,
    );
    assert.deepEqual(readyEndpointOptions.map(plainText), [
      "Codex Subscription · Catalog ready",
      "Claude Subscription · Catalog ready",
    ]);
    assert.deepEqual(
      [...endpointPicker.matchAll(/<span class="opt-sub">([\s\S]*?)<\/span>/gu)]
        .map((match) => plainText(match[1] ?? "")),
      ["Subscription", "Subscription"],
    );
    assert.deepEqual(
      [...endpointPicker.matchAll(
        /<span class="endpoint-status-label">([\s\S]*?)<\/span>/gu,
      )].map((match) => plainText(match[1] ?? "")),
      ["· Catalog ready", "· Catalog ready"],
    );
    assert.match(
      endpointPicker,
      /role="option"[^>]*aria-selected="true"[^>]*tabindex="0"/u,
    );
    assert.match(endpointPicker, /tabindex="-1"/u);

    const mixedPicker = renderComponent(module.ProfilePopover, {
      ...popoverProps("endpoint"),
      profile: profileState("ready", {
        ok: true,
        endpointDiscovery: endpointDiscovery(
          "runtime-not-located",
          "catalog-ready",
        ),
        profile: profileCatalog([secondEndpoint], secondEndpoint.key),
      }),
      endpoints: [secondEndpoint],
      selectedEndpoint: secondEndpoint,
      selectedEndpointKey: secondEndpoint.key,
    });
    assert.deepEqual(profileOptions(mixedPicker).map(plainText), [
      "Codex Subscription · Runtime not located",
      "Claude Subscription · Catalog ready",
    ]);
    assert.match(
      mixedPicker,
      /id="direct-profile-popover-heading"[^>]*>\s*Endpoint\s*<span class="n">1<\/span>/u,
    );
    assert.equal(mixedPicker.match(/role="option"/gu)?.length, 2);
    assert.equal(
      mixedPicker.match(/data-profile-option="true"/gu)?.length,
      1,
      "only catalog-ready endpoint rows participate in roving selection",
    );
    assert.equal(mixedPicker.match(/tabindex="0"/gu)?.length, 1);
    assert.match(mixedPicker, /aria-disabled="true"/u);

    const categorizedFailure = renderComponent(module.ProfilePopover, {
      ...popoverProps("endpoint"),
      profile: profileState("unavailable", {
        ok: false,
        endpointDiscovery: endpointDiscovery(
          "authentication-required",
          "inspection-failed",
        ),
        error: {
          category: "profile-unavailable",
          message:
            "Codex Session Profile options are unavailable. Keep your draft and try again.",
        },
      }),
      endpoints: [],
      selectedEndpoint: undefined,
      selectedEndpointKey: null,
    });
    assert.match(
      plainText(categorizedFailure),
      /Codex[\s\S]*Authentication required[\s\S]*Claude[\s\S]*Inspection failed/u,
    );
    assert.match(
      categorizedFailure,
      /id="direct-profile-popover-heading"[^>]*>\s*Endpoint\s*<span class="n">0<\/span>/u,
    );
    assert.equal(
      categorizedFailure.match(/data-profile-option="true"/gu)?.length ?? 0,
      0,
    );
    assert.doesNotMatch(plainText(categorizedFailure), /Retry|Reload/u);

    const intensity = renderComponent(
      module.ProfilePopover,
      popoverProps("intensity"),
    );
    assert.match(
      intensity,
      /class="runtime-catalog-text">MixedCase Control</u,
    );

    const executionChip = renderComponent(
      module.FixedModeChip,
      {
        label: "Exec",
        value: "Single agent",
      },
    );
    assert.match(executionChip, /^<span[^>]*class="chip locked"/u);
    assert.equal(plainText(executionChip), "🔒 Exec Single agent");
    assert.doesNotMatch(executionChip, /<button|role=|tabindex=|aria-haspopup=/u);
    assert.match(executionChip, /🔒/u);

    const accessChip = renderComponent(module.FixedModeChip, {
      label: "Access",
      value: "Full access",
    });
    assert.match(accessChip, /^<span[^>]*class="chip locked"/u);
    assert.equal(plainText(accessChip), "🔒 Access Full access");
    assert.doesNotMatch(accessChip, /<button|role=|tabindex=|aria-haspopup=/u);
    assert.doesNotMatch(accessChip, /Restricted/u);
    assert.match(accessChip, /🔒/u);
  });
});

test("the rendered Work Intensity chip preserves a selected index-zero label", async () => {
  await withRenderedPickerSeams((module) => {
    const readyProfile = Object.freeze({
      ...profileState("ready", {
        ok: true,
        endpointDiscovery: endpointDiscovery(
          "catalog-ready",
          "catalog-ready",
        ),
        profile: profileCatalog([endpoint, secondEndpoint], endpoint.key),
      }),
      selectedWorkIntensityKey: model.workIntensities[0]!.key,
    });
    const rendered = renderComponent(module.ProfileControlChips, {
      profile: readyProfile,
      endpoints: [endpoint, secondEndpoint],
      selectedEndpoint: endpoint,
      selectedModel: model,
      selectedIntensityLabel: model.workIntensities[0]!.label,
      pending: false,
      endpointLocked: false,
      lockedEndpointRuntimeFamilyLabel: "Codex",
      lockedEndpointLabel: "Subscription",
      openPopover: null,
      onOpen: noOp,
    });
    const intensityChip = rendered.match(
      /<button[^>]*id="direct-work-intensity"[^>]*>[\s\S]*?<\/button>/u,
    )?.[0];
    assert.ok(intensityChip, "rendered Work Intensity chip exists");
    assert.match(intensityChip, /<span class="chip-val">Brief<\/span>/u);
    assert.doesNotMatch(intensityChip, /<span class="chip-val">—<\/span>/u);

    const continuationRendered = renderComponent(module.ProfileControlChips, {
      profile: readyProfile,
      endpoints: [endpoint],
      selectedEndpoint: endpoint,
      selectedModel: model,
      selectedIntensityLabel: model.workIntensities[0]!.label,
      pending: false,
      endpointLocked: true,
      lockedEndpointRuntimeFamilyLabel: "Codex",
      lockedEndpointLabel: "Subscription",
      openPopover: null,
      onOpen: noOp,
    });
    const endpointChip = continuationRendered.match(
      /<span[^>]*id="direct-runtime-endpoint"[^>]*>[\s\S]*?<\/span>\s*<button/u,
    )?.[0];
    assert.ok(endpointChip, "continuation endpoint is rendered as a locked span");
    assert.match(
      endpointChip,
      /Provider and endpoint are fixed for this Agent Session/u,
    );
    assert.doesNotMatch(
      endpointChip,
      /aria-haspopup=|data-profile-popover-trigger=/u,
    );
  });
});

test("the rendered Claude slider preserves the exact ultracode top notch", async () => {
  const ultracodeModel = Object.freeze({
    key: "model:claude-opus",
    label: "Opus 5",
    provenanceLabel: null,
    workIntensityLabel: null,
    workIntensities: Object.freeze(
      ["low", "medium", "high", "xhigh", "max", "ultracode"].map(
        (label) => Object.freeze({ key: `intensity:${label}`, label }),
      ),
    ),
  });
  await withRenderedPickerSeams(async (module) => {
    const rendered = renderComponent(module.ProfilePopover, {
      ...popoverProps("intensity"),
      models: [ultracodeModel],
      selectedModel: ultracodeModel,
      selectedModelKey: ultracodeModel.key,
      selectedWorkIntensityKey: "intensity:ultracode",
    });
    const tickLayer = rendered.match(
      /<div class="islider-ticks"[^>]*>([\s\S]*?)<\/div>/u,
    )?.[1];
    assert.ok(tickLayer);
    assert.deepEqual(
      [...tickLayer.matchAll(/<span[^>]*>([^<]+)<\/span>/gu)].map(
        (match) => match[1],
      ),
      ["low", "medium", "high", "xhigh", "max", "ultracode"],
    );
    assert.match(
      rendered,
      /type="range"[^>]*max="5"[^>]*value="5"[^>]*aria-label="Work Intensity"[^>]*aria-valuetext="ultracode"/u,
    );
    assert.match(rendered, /class="islider-current">ultracode<\/span>/u);
    assert.match(rendered, /class="pos">6\/6<\/span>/u);
    assert.equal(rendered.match(/class="islider-stop(?: passed)?"/gu)?.length, 6);

    const noXhighModel = Object.freeze({
      ...ultracodeModel,
      key: "model:claude-haiku",
      label: "Haiku 4.5",
      workIntensities: Object.freeze(
        ["low", "medium", "high", "max"].map((label) =>
          Object.freeze({ key: `haiku-intensity:${label}`, label }),
        ),
      ),
    });
    const noXhigh = renderComponent(module.ProfilePopover, {
      ...popoverProps("intensity"),
      models: [noXhighModel],
      selectedModel: noXhighModel,
      selectedModelKey: noXhighModel.key,
      selectedWorkIntensityKey: "haiku-intensity:max",
    });
    const noXhighTicks = noXhigh.match(
      /<div class="islider-ticks"[^>]*>([\s\S]*?)<\/div>/u,
    )?.[1];
    assert.ok(noXhighTicks);
    assert.deepEqual(
      [...noXhighTicks.matchAll(/<span[^>]*>([^<]+)<\/span>/gu)].map(
        (match) => match[1],
      ),
      ["low", "medium", "high", "max"],
    );
    assert.equal(noXhigh.match(/class="islider-stop(?: passed)?"/gu)?.length, 4);
    assert.match(noXhigh, /class="pos">4\/4<\/span>/u);
    assert.doesNotMatch(noXhighTicks, /ultracode/u);
  });

  const styles = await readFile(stylesUrl, "utf8");
  assert.match(
    styles,
    /\.islider-ticks span:first-child\s*\{\s*transform:\s*none;\s*\}/u,
  );
  assert.match(
    styles,
    /\.islider-ticks span:last-child\s*\{\s*transform:\s*translateX\(-100%\);\s*\}/u,
  );
  const tickRule = styles.match(/\.islider-ticks span\s*\{([^}]*)\}/u)?.[1];
  assert.ok(tickRule);
  assert.doesNotMatch(tickRule, /text-transform/u);
});

test("the renderer mounts the fixed overlay in ownerDocument.body above frozen CRT layers", async () => {
  const [composer, styles, crt] = await Promise.all([
    readFile(composerUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
    readFile(crtUrl, "utf8"),
  ]);
  const profileSource = composer.slice(
    composer.indexOf("type ProfilePopoverKind"),
    composer.indexOf("function profilePopoverLabel"),
  );
  const profileRule = styles.match(/\.profile-popover\s*\{([^}]*)\}/u)?.[1];
  assert.ok(profileRule, "profile popover CSS rule exists");

  assert.match(composer, /import \{\s*Portal\s*\} from "solid-js\/web"/u);
  assert.match(profileSource, /<Portal[\s\S]*?mount=\{[\s\S]*?ownerDocument\.body\}/u);
  assert.match(
    profileSource,
    /<div\s+class="composer profile-popover-portal-host"[\s\S]*?<div\s+class="controlbar profile-popover-portal-anchor"[\s\S]*?<ProfilePopover/u,
  );
  assert.match(profileSource, /createProfilePopoverLifecycle/u);
  assert.match(profileRule, /position:\s*fixed;/u);
  assert.match(profileRule, /z-index:\s*10000;/u);
  assert.match(profileRule, /max-width:\s*min\(400px, calc\(100vw - 80px\)\);/u);
  assert.match(profileRule, /max-height:\s*calc\(100vh - 16px\);/u);
  assert.doesNotMatch(profileRule, /bottom:/u);
  assert.doesNotMatch(styles, /\.profile-popover\.popover-(?:model|intensity)/u);
  assert.doesNotMatch(
    styles,
    /\.profile-popover\.popover-(?:execution|access)/u,
  );
  const responsiveStyles = styles.slice(
    styles.indexOf("@media (max-width: 900px)"),
  );
  assert.doesNotMatch(responsiveStyles, /\.profile-popover/u);

  const crtZIndexes = [...crt.matchAll(/z-index:\s*(\d+)/gu)].map((match) =>
    Number(match[1]),
  );
  assert.ok(crtZIndexes.length > 0);
  assert.ok(Math.max(...crtZIndexes) < 10000);
  assert.doesNotMatch(
    profileSource,
    /(?:degraded|signed[ -]out|zero endpoints|0 endpoints)/iu,
  );
});

function rect(
  edges: Readonly<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>,
): ProfilePopoverRect {
  return {
    ...edges,
    width: edges.right - edges.left,
    height: edges.bottom - edges.top,
  };
}

class FakeEventSource {
  readonly listeners = new Map<
    string,
    Set<(event: ProfilePopoverLifecycleEvent) => void>
  >();
  added = 0;
  removed = 0;

  get listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }

  addEventListener(
    type: string,
    listener: (event: ProfilePopoverLifecycleEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    this.added += 1;
  }

  removeEventListener(
    type: string,
    listener: (event: ProfilePopoverLifecycleEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
    this.removed += 1;
  }

  emit(type: string, event: ProfilePopoverLifecycleEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

class FakeFrames {
  readonly callbacks = new Map<number, () => void>();
  nextId = 1;
  cancelled = 0;

  get pending(): number {
    return this.callbacks.size;
  }

  request = (callback: () => void): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  cancel = (id: number): void => {
    if (this.callbacks.delete(id)) this.cancelled += 1;
  };

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }
}

function lifecycleHarness(): {
  anchorRect: ProfilePopoverRect;
  viewport: { width: number; height: number };
  intrinsicPopoverWidth: number;
  intrinsicPopoverHeight: number;
  focusTarget: string;
  readonly options: Parameters<typeof createProfilePopoverLifecycle>[0];
  readonly placements: ProfilePopoverPlacement[];
  readonly measurementEvents: string[];
  readonly focusEvents: string[];
  readonly publishedPopoverWidth: number | null;
  readonly dismissals: string[];
  readonly documentEvents: FakeEventSource;
  readonly viewportEvents: FakeEventSource;
  readonly frames: FakeFrames;
  readonly observedElements: string[];
  readonly fireResizeObserver: () => void;
  readonly resizeObserverDisconnects: () => number;
  readonly anchorFocusCount: () => number;
  readonly contentFocusCount: () => number;
} {
  const documentEvents = new FakeEventSource();
  const viewportEvents = new FakeEventSource();
  const frames = new FakeFrames();
  const placements: ProfilePopoverPlacement[] = [];
  const dismissals: string[] = [];
  const observedElements: string[] = [];
  let resizeObserverCallback = (): void => undefined;
  let resizeObserverDisconnects = 0;
  let anchorFocus = 0;
  let contentFocus = 0;
  let publishedPopoverWidth: number | null = null;

  const harness = {
    anchorRect: rect({ left: 120, right: 220, top: 108, bottom: 140 }),
    viewport: { width: 1200, height: 800 },
    intrinsicPopoverWidth: 360,
    intrinsicPopoverHeight: 240,
    focusTarget: "initial",
  };
  const measurementEvents: string[] = [];
  const focusEvents: string[] = [];
  const anchor: ProfilePopoverLifecycleElement = {
    name: "anchor",
    contains: (target) => target === "anchor" || target === "anchor-child",
    focus: () => {
      anchorFocus += 1;
    },
    getBoundingClientRect: () => harness.anchorRect,
  };
  const popover: ProfilePopoverLifecycleElement = {
    name: "popover",
    contains: (target) => target === "inside",
    focus: noOp,
    getBoundingClientRect: () => {
      const width = publishedPopoverWidth ?? harness.intrinsicPopoverWidth;
      measurementEvents.push(`measure:${width}`);
      return rect({
        left: 0,
        right: width,
        top: 0,
        bottom: harness.intrinsicPopoverHeight,
      });
    },
  };
  const environment: ProfilePopoverLifecycleEnvironment = {
    documentEvents,
    viewportEvents,
    getViewport: () => harness.viewport,
    requestAnimationFrame: frames.request,
    cancelAnimationFrame: frames.cancel,
    createResizeObserver: (callback) => {
      resizeObserverCallback = callback;
      return {
        observe: (element) => {
          observedElements.push(element.name);
        },
        disconnect: () => {
          resizeObserverDisconnects += 1;
        },
      };
    },
  };

  return {
    ...harness,
    get anchorRect() {
      return harness.anchorRect;
    },
    set anchorRect(value: ProfilePopoverRect) {
      harness.anchorRect = value;
    },
    get viewport() {
      return harness.viewport;
    },
    set viewport(value: { width: number; height: number }) {
      harness.viewport = value;
    },
    get intrinsicPopoverWidth() {
      return harness.intrinsicPopoverWidth;
    },
    set intrinsicPopoverWidth(value: number) {
      harness.intrinsicPopoverWidth = value;
    },
    get intrinsicPopoverHeight() {
      return harness.intrinsicPopoverHeight;
    },
    set intrinsicPopoverHeight(value: number) {
      harness.intrinsicPopoverHeight = value;
    },
    get focusTarget() {
      return harness.focusTarget;
    },
    set focusTarget(value: string) {
      harness.focusTarget = value;
    },
    options: {
      anchor,
      popover,
      environment,
      onBeforeMeasure: () => {
        measurementEvents.push("clear-width");
        publishedPopoverWidth = null;
      },
      focusContent: () => {
        contentFocus += 1;
        focusEvents.push(harness.focusTarget);
      },
      isProfilePopoverTrigger: (target) => target === "other-trigger",
      onPlacement: (placement) => {
        measurementEvents.push(`publish:${placement.width}`);
        publishedPopoverWidth = placement.width;
        placements.push(placement);
      },
      onDismiss: (reason) => dismissals.push(reason),
    },
    placements,
    measurementEvents,
    focusEvents,
    get publishedPopoverWidth() {
      return publishedPopoverWidth;
    },
    dismissals,
    documentEvents,
    viewportEvents,
    frames,
    observedElements,
    fireResizeObserver: () => resizeObserverCallback(),
    resizeObserverDisconnects: () => resizeObserverDisconnects,
    anchorFocusCount: () => anchorFocus,
    contentFocusCount: () => contentFocus,
  };
}

function lifecycleEvent(
  target: unknown,
  key?: string,
): ProfilePopoverLifecycleEvent & { readonly defaultPrevented: boolean } {
  let defaultPrevented = false;
  return {
    target,
    key,
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault: () => {
      defaultPrevented = true;
    },
  };
}

function popoverProps(kind: string): Readonly<Record<string, unknown>> {
  return {
    kind,
    profile: profileState("ready", {
      ok: true,
      endpointDiscovery: endpointDiscovery("catalog-ready", "catalog-ready"),
      profile: profileCatalog(
        [endpoint, secondEndpoint],
        endpoint.key,
      ),
    }),
    endpoints: [endpoint, secondEndpoint],
    selectedEndpoint: endpoint,
    models: [model, secondModel],
    selectedModel: model,
    selectedEndpointKey: endpoint.key,
    selectedModelKey: model.key,
    selectedWorkIntensityKey: "intensity:deep",
    selectedExecutionModeKey: "execution:single",
    selectedAccessModeKey: "access:full",
    onEndpoint: noOp,
    onModel: noOp,
    onWorkIntensity: noOp,
    onExecutionMode: noOp,
    onAccessMode: noOp,
    onClose: noOp,
  };
}

function profileState(
  phase: "idle" | "loading" | "ready" | "unavailable",
  result: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    phase,
    result,
    selectedEndpointKey: phase === "ready" ? endpoint.key : null,
    selectedModelKey: phase === "ready" ? model.key : null,
    selectedWorkIntensityKey: phase === "ready" ? "intensity:deep" : null,
    selectedExecutionModeKey: phase === "ready" ? "execution:single" : null,
    selectedAccessModeKey: phase === "ready" ? "access:full" : null,
    feedback: null,
    defaultPreference: Object.freeze({ phase: "idle", feedback: null }),
  });
}

function endpointDiscovery(
  codexCategory:
    | "catalog-ready"
    | "runtime-not-located"
    | "authentication-required"
    | "inspection-failed"
    | "not-inspected",
  claudeCategory:
    | "catalog-ready"
    | "runtime-not-located"
    | "inspection-failed"
    | "not-inspected",
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    statuses: Object.freeze([
      Object.freeze({ endpointId: "codex-desktop", category: codexCategory }),
      Object.freeze({
        endpointId: "claude-code-desktop",
        category: claudeCategory,
      }),
    ]),
  });
}

function profileCatalog(
  endpoints: readonly (typeof endpoint | typeof secondEndpoint)[],
  selectedEndpointKey: string,
): Readonly<Record<string, unknown>> {
  const selectedEndpoint = endpoints.find(
    (candidate) => candidate.key === selectedEndpointKey,
  );
  return Object.freeze({
    snapshotKey: "snapshot:profile-popover",
    endpoints: Object.freeze([...endpoints]),
    desiredDefault:
      selectedEndpoint === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "resolved",
            endpointKey: selectedEndpoint.key,
            modelKey: selectedEndpoint.models[0]?.key,
            workIntensityKey:
              selectedEndpoint.models[0]?.workIntensities[0]?.key,
            executionModeKey: selectedEndpoint.executionModes[0]?.key,
            accessModeKey: selectedEndpoint.accessModes[0]?.key,
          }),
  });
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function profileOptions(html: string): readonly string[] {
  return (
    html.match(
      /<(?:button|div)[^>]*role="option"[^>]*>[\s\S]*?<\/(?:button|div)>/gu,
    ) ?? []
  );
}

function renderComponent(
  component: RenderedComponent,
  props: Readonly<Record<string, unknown>>,
): string {
  return renderToString(() => component(props)).replace(
    /<!--(?:\$|\/)-->/gu,
    "",
  );
}

async function withRenderedPickerSeams(
  assertion: (module: RenderedPickerSeams) => Promise<void> | void,
): Promise<void> {
  const exposePickerSeams: Plugin = {
    name: "expose-profile-popover-interaction-seams",
    enforce: "pre",
    transform(source, id) {
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/src/workbench-shell/renderer/composer.tsx")
      ) {
        return;
      }
      return source
        .replace(
          "const ProfilePopover: Component",
          "export const ProfilePopover: Component",
        )
        .replace(
          "const ProfileControlChips: Component",
          "export const ProfileControlChips: Component",
        )
        .replace(
          "const FixedModeChip: Component",
          "export const FixedModeChip: Component",
        );
    },
  };
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [exposePickerSeams, solid({ ssr: true })],
    root: repositoryRoot,
    server: { middlewareMode: true },
  });

  try {
    const module = (await server.ssrLoadModule(
      "/src/workbench-shell/renderer/composer.tsx",
    )) as RenderedPickerSeams;
    await assertion(module);
  } finally {
    await server.close();
  }
}
