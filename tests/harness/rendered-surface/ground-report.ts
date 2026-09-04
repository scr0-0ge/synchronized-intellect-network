/*
 * Measured ground report — `F102`.
 *
 *   node --no-warnings tests/harness/rendered-surface/ground-report.ts
 *
 * Answers two questions that the legibility report cannot, and that no
 * comparison of stylesheet source can answer at all:
 *
 *   1. Do the rail, the stage and the inspector COMPOSITE to one colour at one
 *      alpha? Citing the same token is not the same claim: a private overlay, a
 *      different stacking context or an inherited alpha all leave the tokens
 *      agreeing and the screen showing two sheets.
 *
 *   2. Does any text on the stage lose contrast when they are unified? The
 *      ground under the conversation is the readability guard, so a naive
 *      unification pays for one complaint with a worse one.
 *
 * Both are printed for every surface. Nothing here decides; the guard in
 * `rendered-surface-legibility.test.ts` asserts.
 *
 * Reads only. Starts no Agent Runtime, no app-server, and no provider request.
 */
import { formatRgb, judgeText, type TextVerdict } from "./contrast.ts";
import {
  measureSurface,
  startSurfaceServer,
  type MeasuredGround,
  type MeasuredSurface,
} from "./measure.ts";
import { GROUND_IDENTITY_GROUP, GROUND_SURFACES } from "./surfaces.ts";

const server = await startSurfaceServer();
try {
  for (const request of GROUND_SURFACES) {
    const surface = await measureSurface(server, request);
    console.log(`\n## ${surface.surfaceId}\n`);
    console.log(`Root state: \`${describeRoot(surface.root)}\`\n`);

    reportGrounds(surface);
    reportSeams(surface);
    reportIdentity(surface);
    reportStageText(surface);
  }
} finally {
  await server.close();
}

function reportGrounds(surface: MeasuredSurface): void {
  console.log("### Composited pane grounds\n");
  console.log("| pane | declared background | probe points | composited colours (count) |");
  console.log("| --- | --- | --- | --- |");
  for (const ground of surface.grounds) {
    if (!ground.present) {
      console.log(`| \`${ground.selector}\` | — | not present | — |`);
      continue;
    }
    const declared =
      ground.declaredBackgroundImage !== undefined && ground.declaredBackgroundImage !== "none"
        ? `${ground.declaredBackgroundColor} + image`
        : (ground.declaredBackgroundColor ?? "—");
    console.log(
      `| \`${ground.selector}\` | \`${declared}\` | ${ground.points.length} | ${describeSamples(ground)} |`,
    );
  }
  console.log("");
}

function reportSeams(surface: MeasuredSurface): void {
  console.log("### Pane seams — the step across each boundary\n");
  console.log("| boundary | y | offset | left pixel | right pixel | channel delta |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const seam of surface.seams) {
    for (const sample of seam.samples) {
      const delta =
        Math.abs(sample.left.red - sample.right.red) +
        Math.abs(sample.left.green - sample.right.green) +
        Math.abs(sample.left.blue - sample.right.blue) +
        Math.abs(sample.left.alpha - sample.right.alpha);
      const ink = sample.left.carriedInk || sample.right.carriedInk ? " ⚠ ink" : "";
      console.log(
        `| \`${seam.leftSelector}\` → \`${seam.rightSelector}\` | ${sample.y} | ${sample.offset}px | ` +
          `${rgbaOf(sample.left)} | ${rgbaOf(sample.right)} | **${delta}**${ink} |`,
      );
    }
  }
  console.log("");
}

/**
 * The owner's sentence, as a single line: are the panes he named one surface?
 *
 * Reported on the DOMINANT composited colour of each pane. A pane with more
 * than one colour is flagged rather than averaged, because an average of a
 * gradient is a number that exists nowhere on the screen.
 */
function reportIdentity(surface: MeasuredSurface): void {
  console.log("### One surface, one transparency — verdict\n");
  const rows = GROUND_IDENTITY_GROUP.map((selector) => {
    const ground = surface.grounds.find((candidate) => candidate.selector === selector);
    return { selector, dominant: ground?.samples[0], spread: ground?.samples.length ?? 0 };
  });
  const measured = rows.filter((row) => row.dominant !== undefined);
  const distinct = new Set(measured.map((row) => rgbaOf(row.dominant!)));

  console.log("| pane | dominant composited colour | distinct colours over pane |");
  console.log("| --- | --- | --- |");
  for (const row of rows) {
    console.log(
      `| \`${row.selector}\` | ${row.dominant === undefined ? "no probeable ground" : rgbaOf(row.dominant)} | ${row.spread} |`,
    );
  }
  console.log(
    `\n**${distinct.size === 1 ? "IDENTICAL" : "DIFFERENT"}** — ${measured.length} panes measured, ` +
      `${distinct.size} distinct dominant colour(s): ${[...distinct].join(", ")}\n`,
  );
}

/**
 * Every string painted inside the stage, worst contrast first.
 *
 * Scoped by painted geometry rather than by selector so a string counts as
 * on-stage because of where it ended up, not because of what it is called.
 */
function reportStageText(surface: MeasuredSurface): void {
  const stage = surface.grounds.find((candidate) => candidate.selector === ".stage");
  if (stage?.rect == null) {
    console.log("### Stage text contrast\n\nThe stage was not present on this surface.\n");
    return;
  }
  const rect = stage.rect;
  const verdicts: TextVerdict[] = surface.texts
    .filter((text) =>
      text.boxes.some(
        (box) =>
          box.left >= rect.left &&
          box.left < rect.left + rect.width &&
          box.top >= rect.top &&
          box.top < rect.top + rect.height,
      ),
    )
    .map(judgeText)
    .sort((a, b) => a.ratio - b.ratio);

  const failing = verdicts.filter((verdict) => !verdict.passes);
  console.log(
    `### Stage text contrast\n\n${verdicts.length} strings painted inside the stage · ` +
      `${failing.length} below AA\n`,
  );
  console.log("| site | text | size/weight | painted on | ratio | AA | verdict |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const verdict of verdicts) {
    console.log(
      `| \`${verdict.signature}\` | ${cell(verdict.text)} | ${verdict.fontSizePx}px/${verdict.fontWeight} | ` +
        `${formatRgb(verdict.analytic.background)} | ${verdict.analytic.ratio.toFixed(2)}:1 | ` +
        `${verdict.threshold}:1 | ${verdict.passes ? "pass" : "**below AA**"} |`,
    );
  }
  console.log("");
}

function describeSamples(ground: MeasuredGround): string {
  if (ground.samples.length === 0) return "no uncovered ground";
  return ground.samples
    .slice(0, 4)
    .map((sample) => `${rgbaOf(sample)} ×${sample.count}`)
    .join("<br>");
}

function rgbaOf(sample: { red: number; green: number; blue: number; alpha: number }): string {
  return `rgba(${sample.red} ${sample.green} ${sample.blue} / ${sample.alpha})`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").slice(0, 34);
}

function describeRoot(root: Readonly<Record<string, string | null>>): string {
  return Object.entries(root)
    .map(([key, value]) => `${key}=${value ?? "(unset)"}`)
    .join(" ");
}
