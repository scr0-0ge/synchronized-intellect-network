import assert from "node:assert/strict";
import test from "node:test";

import {
  measureSurface,
  startSurfaceServer,
  type MeasuredExtent,
} from "../harness/rendered-surface/measure.ts";

const narrowViewport = Object.freeze({ width: 360, height: 640 });

function extent(surface: Awaited<ReturnType<typeof measureSurface>>, selector: string): MeasuredExtent {
  const found = surface.extents.find((candidate) => candidate.selector === selector);
  assert.ok(found, `${selector}: extent was not measured`);
  assert.ok(found.rect, `${selector}: element is not laid out`);
  return found;
}

test("w28: the supported 360px Project view gives the conversation the reading width", async (t) => {
  const server = await startSurfaceServer();
  t.after(async () => server.close());

  const surface = await measureSurface(server, {
    surfaceId: "w28-narrow-existing-session",
    query: "?project=default",
    readySelector: ".composer",
    viewport: narrowViewport,
  });

  const rail = extent(surface, ".rail").rect!;
  const stage = extent(surface, ".stage").rect!;
  const column = extent(surface, ".column").content!;
  const input = extent(surface, ".input-shell").rect!;

  assert.deepEqual(surface.viewport, narrowViewport);
  assert.equal(stage.left, 0, "the conversation must begin at the window edge");
  assert.equal(stage.width, narrowViewport.width, "the rail must not halve the conversation");
  assert.ok(
    rail.top >= stage.top + stage.height,
    `the session rail must dock below the conversation, not beside it (${JSON.stringify({ rail, stage })})`,
  );
  assert.equal(rail.width, narrowViewport.width, "the docked rail should retain its controls");
  assert.ok(column.width >= 300, `only ${column.width}px remains for transcript text`);
  assert.ok(input.width >= 300, `only ${input.width}px remains for the message field`);

  const outside = surface.texts.flatMap((text) =>
    text.surfaceAncestor !== "main.stage"
      ? []
      : text.boxes
          .filter((box) => box.width > 0 && (box.left < 0 || box.left + box.width > narrowViewport.width))
          .map((box) => `${text.signature}:${box.left}..${box.left + box.width}`),
  );
  assert.deepEqual(outside, [], "session text crosses the supported narrow window");
});
