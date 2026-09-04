/*
 * Measured width report — the open half of `F102`.
 *
 *   node --no-warnings tests/harness/rendered-surface/width-report.ts
 *
 * Answers one question that every existing gate is structurally unable to ask:
 * do the reading column and the input area the owner sees below it stand on the
 * same measurement line?
 *
 * Every `F102` gate in this repository measures COLOUR — composited ground,
 * seam steps, text contrast. A size and alignment cue is invisible to all of
 * them. This prints the numbers; the guard in
 * `rendered-surface-legibility.test.ts` asserts on them.
 *
 * Reads only. Starts no Agent Runtime, no app-server, and no provider request.
 */
import { measureSurface, startSurfaceServer, type MeasuredSurface } from "./measure.ts";
import { WIDTH_SURFACES } from "./surfaces.ts";

const server = await startSurfaceServer();
try {
  for (const request of WIDTH_SURFACES) {
    const surface = await measureSurface(server, request);
    console.log(`\n## ${surface.surfaceId} — ${surface.viewport.width}x${surface.viewport.height}\n`);
    console.log("| element | present | border box left..right (width) | content left..right (width) | max-width |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const extent of surface.extents) {
      if (!extent.present || extent.rect === null || extent.content === null) {
        console.log(`| \`${extent.selector}\` | no | — | — | — |`);
        continue;
      }
      const rect = extent.rect;
      const content = extent.content;
      console.log(
        `| \`${extent.selector}\` | yes | ${rect.left}..${round(rect.left + rect.width)} (**${rect.width}**) | ` +
          `${content.left}..${round(content.left + content.width)} (**${content.width}**) | ` +
          `${extent.declaredMaxWidth ?? "—"} |`,
      );
    }
    reportReadingLine(surface);
    reportPaintedEdges(surface);
  }
} finally {
  await server.close();
}

/**
 * The one comparison the complaint is about, stated as a number.
 *
 * The prose the owner reads is the content box of `.column`. The input he types
 * into is the border box of `.input-shell`, because that control paints its own
 * edge and the edge is what the eye lines up against. If those two do not share
 * a left and a right, the conversation is a narrower sheet laid on a wider one.
 */
function reportReadingLine(surface: MeasuredSurface): void {
  const prose = surface.extents.find((extent) => extent.selector === ".column");
  const input = surface.extents.find((extent) => extent.selector === ".input-shell");
  const settings = surface.extents.find((extent) => extent.selector === ".settings-inner");
  console.log("");
  if (prose?.content != null && input?.rect != null) {
    const leftStep = round(Math.abs(prose.content.left - input.rect.left));
    const rightStep = round(
      Math.abs(prose.content.left + prose.content.width - (input.rect.left + input.rect.width)),
    );
    console.log(
      `**Reading line** — prose ${prose.content.width}px wide, input ${input.rect.width}px wide. ` +
        `Left edges differ by **${leftStep}px**, right edges by **${rightStep}px**.\n`,
    );
  }
  if (settings?.content != null) {
    console.log(`**Settings reading column** — ${settings.content.width}px content inside a ${settings.rect?.width}px cell.\n`);
  }
}

/**
 * The drawn edges, grouped by the left..right pair they land on.
 *
 * If the transcript and the composer each paint at a different pair, the eye is
 * given two rectangles rather than one continuous surface, and the mismatch is
 * a picture rather than an arithmetic fact.
 */
function reportPaintedEdges(surface: MeasuredSurface): void {
  if (surface.paintedEdges.length === 0) return;
  const groups = new Map<string, string[]>();
  for (const edge of surface.paintedEdges) {
    const key = `${edge.scope} ${edge.left}..${edge.right} (${edge.width}px)`;
    groups.set(key, [...(groups.get(key) ?? []), edge.signature]);
  }
  console.log("Painted vertical edges inside the conversation:\n");
  console.log("| scope, left..right (width) | drawn by |");
  console.log("| --- | --- |");
  for (const [key, signatures] of [...groups].sort()) {
    console.log(`| ${key} | ${signatures.slice(0, 6).map((s) => `\`${s}\``).join(", ")}${signatures.length > 6 ? ` +${signatures.length - 6} more` : ""} |`);
  }
  console.log("");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
