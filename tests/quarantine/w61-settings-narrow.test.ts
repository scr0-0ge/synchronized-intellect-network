import assert from "node:assert/strict";
import test from "node:test";

import {
  measureSurface,
  startSurfaceServer,
  type MeasuredExtent,
  type MeasuredGrid,
  type MeasuredSurface,
} from "../harness/rendered-surface/measure.ts";

const viewportHeight = 640;

function extent(surface: MeasuredSurface, selector: string): MeasuredExtent {
  const found = surface.extents.find(
    (candidate) => candidate.selector === selector,
  );
  assert.ok(found, `${selector}: extent was not measured`);
  assert.ok(found.rect, `${selector}: element is not laid out`);
  return found;
}

function grid(surface: MeasuredSurface, signature: string): MeasuredGrid {
  const found = surface.grids.find(
    (candidate) => candidate.signature === signature,
  );
  assert.ok(found, `${signature}: grid was not measured`);
  return found;
}

test(
  "w61: Settings covers the rail without horizontal overflow through 620px",
  async (t) => {
    const server = await startSurfaceServer();
    t.after(async () => server.close());

    const narrow = await measureSurface(server, {
      surfaceId: "w61-settings-360",
      query: "?surface=settings",
      readySelector: ".settings",
      viewport: { width: 360, height: viewportHeight },
    });
    const narrowSettings = extent(narrow, ".settings").rect!;
    const narrowInner = extent(narrow, ".settings-inner");
    const narrowProviders = grid(narrow, "section.provider-settings");
    const providerRight =
      narrowProviders.rect.left + narrowProviders.rect.width;
    const providerOverflow = Math.max(
      0,
      ...narrowProviders.children.map(
        (child) => child.left + child.width - providerRight,
      ),
    );

    // Kept, but it is worth being explicit about what this can and cannot
    // see, because for a long time it was mistaken for control-level coverage.
    // `narrowProviders.children` is the DIRECT children of the grid, and a
    // stretched grid child is bounded by its track by construction — so this
    // number cannot be anything but 0, whatever happens inside those children.
    // The assertion that actually protects a person is `clippedControls`
    // below, which walks controls upward to whatever clips them.
    assert.equal(
      providerOverflow,
      0,
      "a Settings provider section crosses its content width",
    );
    assert.deepEqual(
      { left: narrowSettings.left, width: narrowSettings.width },
      { left: 0, width: 360 },
      "the existing Settings overlay must cover the rail at the supported minimum width",
    );
    assert.ok(
      narrowInner.content!.width >= 294,
      `only ${narrowInner.content!.width}px remains for Settings content`,
    );

    // w120. The defect this misses when it only measures containers: at 360px
    // the API-key rows' `Test connection` button had 80 of its 105px cut off by
    // `.provider { overflow: hidden }`, with no scrollbar anywhere on the page
    // to reach it. Grid children stayed inside their tracks the whole time.
    assert.deepEqual(
      narrow.clippedControls,
      [],
      "a Settings control is clipped out of reach at the supported minimum width",
    );

    for (const width of [620, 1280]) {
      const surface = await measureSurface(server, {
        surfaceId: `w61-settings-${width}`,
        query: "?surface=settings",
        readySelector: ".settings",
        viewport: { width, height: viewportHeight },
      });
      const settings = extent(surface, ".settings").rect!;
      const rail = extent(surface, ".rail").rect!;
      assert.equal(settings.left, width === 620 ? 0 : rail.left + rail.width);
      assert.equal(settings.left + settings.width, width);
    }
  },
);


// w120. Widths either side of the 620px breakpoint, because the loss here is
// NOT monotonic and testing the endpoints alone misses it entirely: 620px is
// clean, 630px cuts 26px off `Test connection`, 660px is clean again. Settings
// covers the rail at 620 and hands 216px back to it at 621, so the card loses
// ~206px of content width in a single pixel of window growth — dragging the
// window WIDER is what breaks it.
test(
  "w120: no Settings control is clipped out of reach across the 620px breakpoint",
  async (t) => {
    const server = await startSurfaceServer();
    t.after(async () => server.close());

    for (const width of [610, 620, 630, 640, 650, 660, 700]) {
      const surface = await measureSurface(server, {
        surfaceId: `w120-breakpoint-${width}`,
        query: "?surface=settings",
        readySelector: ".settings",
        viewport: { width, height: viewportHeight },
      });
      assert.deepEqual(
        surface.clippedControls,
        [],
        `a Settings control is clipped out of reach at ${width}px: ` +
          surface.clippedControls
            .map((entry) => `${entry.label} lost ${entry.hiddenTotal}px to ${entry.clipper}`)
            .join("; "),
      );
    }
  },
);
