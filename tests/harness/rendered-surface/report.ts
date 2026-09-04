/*
 * Measured legibility report.
 *
 *   node --no-warnings tests/harness/rendered-surface/report.ts
 *
 * Prints the same readings the guard asserts on, as Markdown, for an evidence
 * file or an owner review. It shares `MEASURED_SURFACES` with the guard on
 * purpose: a surface in the report is a surface under guard, and the two can
 * never quietly describe different products.
 *
 * Reads only. Starts no Agent Runtime, no app-server, and no provider request.
 */
import {
  contrastRatio,
  formatRgb,
  judgeText,
  relativeLuminance,
  roundTo,
  type TextVerdict,
} from "./contrast.ts";
import { measureSurface, startSurfaceServer, type Rgba } from "./measure.ts";
import { EXPECTED_SHORTFALLS, MEASURED_SURFACES, REPAIRED_SITES } from "./surfaces.ts";

const WORST_ROWS = 12;

const server = await startSurfaceServer();
const fgThreeSites: { surfaceId: string; verdict: TextVerdict }[] = [];
const allFailures: { surfaceId: string; verdict: TextVerdict }[] = [];
const allVerdicts: { surfaceId: string; verdict: TextVerdict }[] = [];
try {
  for (const request of MEASURED_SURFACES) {
    const surface = await measureSurface(server, request);
    const verdicts = surface.texts.map(judgeText).sort((a, b) => a.ratio - b.ratio);
    const failures = verdicts.filter((verdict) => !verdict.passes);
    const shown = new Set(failures);
    for (const verdict of verdicts.slice(0, WORST_ROWS)) shown.add(verdict);

    for (const verdict of verdicts) {
      if (verdict.colorSource === "var(--fg-3)") {
        fgThreeSites.push({ surfaceId: surface.surfaceId, verdict });
      }
    }
    for (const verdict of failures) {
      allFailures.push({ surfaceId: surface.surfaceId, verdict });
    }
    for (const verdict of verdicts) {
      allVerdicts.push({ surfaceId: surface.surfaceId, verdict });
    }

    console.log(`\n### ${surface.surfaceId}\n`);
    console.log(
      `Root state: \`${describeRoot(surface.root)}\` · viewport ${surface.viewport.width}×${surface.viewport.height} ` +
        `at scale ${surface.devicePixelRatio} · ${verdicts.length} strings measured · ` +
        `${failures.length} below AA · ${verdicts.filter((v) => v.modelsDisagree).length} where the two models disagree\n`,
    );
    console.log("| token | site | text | size/weight | painted colour | measured surface | resolved-colour | painted-pixel | AA | verdict |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const verdict of verdicts) {
      if (!shown.has(verdict)) continue;
      console.log(
        `| \`${verdict.colorSource ?? "(inherited)"}\` | \`${verdict.signature}\` | ${cell(verdict.text)} | ` +
          `${verdict.fontSizePx}px/${verdict.fontWeight} | ${formatRgb(verdict.analytic.foreground)} | ` +
          `${formatRgb(verdict.analytic.background)} | ${verdict.analytic.ratio.toFixed(2)}:1 | ` +
          `${verdict.painted === null ? "—" : `${verdict.painted.ratio.toFixed(2)}:1`} | ${verdict.threshold}:1 | ` +
          `${verdictWord(verdict)} |`,
      );
    }
  }

  console.log("\n### The `--fg-3` question, measured\n");
  const ranked = fgThreeSites.sort((a, b) => a.verdict.ratio - b.verdict.ratio);
  const worst = ranked[0];
  const failing = ranked.filter((entry) => !entry.verdict.passes);
  console.log(
    `\`--fg-3\` is the authored colour of ${ranked.length} measured strings across the four surfaces. ` +
      `${ranked.length - failing.length} clear AA; ${failing.length} do not.\n`,
  );
  if (worst !== undefined) {
    const proposal = raiseToThreshold(
      worst.verdict.analytic.foreground,
      worst.verdict.analytic.background,
      worst.verdict.threshold,
    );
    console.log(
      `Worst site: \`${worst.verdict.signature}\` on ${worst.surfaceId} at ${worst.verdict.ratio.toFixed(2)}:1, ` +
        `painted ${formatRgb(worst.verdict.analytic.foreground)} on ${formatRgb(worst.verdict.analytic.background)}.\n`,
    );
    console.log(
      `To clear ${worst.verdict.threshold}:1 at that site the tertiary text token would have to reach ` +
        `${proposal === null ? "a value brighter than white — a lighter surface is required instead" : `${formatRgb(proposal.color)} (${proposal.hex}), measuring ${proposal.ratio.toFixed(2)}:1`}. ` +
        `This is a palette decision with an effect on every screen and is left to the owner.\n`,
    );
  }
  console.log("| surface | site | size | ratio | AA | verdict |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const entry of ranked.slice(0, 14)) {
    console.log(
      `| ${entry.surfaceId} | \`${entry.verdict.signature}\` | ${entry.verdict.fontSizePx}px | ` +
        `${entry.verdict.ratio.toFixed(2)}:1 | ${entry.verdict.threshold}:1 | ${verdictWord(entry.verdict)} |`,
    );
  }

  console.log("\n### Sites repaired in this cycle\n");
  console.log("| surface | site | token now | before | resolved-colour | painted-pixel | AA | verdict |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const site of REPAIRED_SITES) {
    const verdict = allVerdicts.find(
      (entry) => entry.surfaceId === site.surfaceId && entry.verdict.signature === site.signature,
    )?.verdict;
    console.log(
      `| ${site.surfaceId} | \`${site.signature}\` | \`${verdict?.colorSource ?? "?"}\` | ` +
        `${site.wasRatio.toFixed(2)}:1 | ${verdict?.analytic.ratio.toFixed(2) ?? "—"}:1 | ` +
        `${verdict?.painted?.ratio.toFixed(2) ?? "—"}:1 | ${verdict?.threshold ?? "—"}:1 | ` +
        `${verdict === undefined ? "not rendered" : verdictWord(verdict)} |`,
    );
  }

  console.log("\n### Recorded shortfalls, with the lift each one would need\n");
  for (const shortfall of EXPECTED_SHORTFALLS) {
    const measured = allFailures.find(
      (entry) =>
        entry.surfaceId === shortfall.surfaceId && entry.verdict.signature === shortfall.signature,
    );
    const proposal =
      measured === undefined
        ? null
        : raiseToThreshold(
            measured.verdict.analytic.foreground,
            measured.verdict.analytic.background,
            measured.verdict.threshold,
          );
    const lift =
      proposal === null
        ? "no uniform lift of the foreground reaches the threshold; the surface has to change instead"
        : `the painted colour would have to reach ${formatRgb(proposal.color)} (${proposal.hex}) for ${proposal.ratio.toFixed(2)}:1`;
    console.log(
      `- \`${shortfall.signature}\` on ${shortfall.surfaceId}: ${shortfall.measuredRatio}:1 against ` +
        `${shortfall.threshold}:1 — ${lift}. ${shortfall.reason}`,
    );
  }
  const unregistered = allFailures.filter(
    (entry) =>
      !EXPECTED_SHORTFALLS.some(
        (shortfall) =>
          shortfall.surfaceId === entry.surfaceId &&
          shortfall.signature === entry.verdict.signature,
      ),
  );
  console.log(
    `\n${unregistered.length} measured shortfall(s) are not in the register` +
      `${unregistered.length === 0 ? "." : `: ${unregistered.map((entry) => `${entry.surfaceId}/${entry.verdict.signature}`).join(", ")}.`}`,
  );
} finally {
  await server.close();
}

function verdictWord(verdict: TextVerdict): string {
  if (!verdict.passes) return "**below AA**";
  return verdict.modelsDisagree ? "pass (models disagree)" : "pass";
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").slice(0, 40);
}

function describeRoot(root: Readonly<Record<string, string | null>>): string {
  return Object.entries(root)
    .map(([key, value]) => `${key}=${value ?? "(unset)"}`)
    .join(" ");
}

/**
 * The smallest uniform brightening of a foreground that reaches a threshold on
 * a measured background. A proposal with a number attached, not a new palette.
 */
function raiseToThreshold(
  foreground: Rgba,
  background: Rgba,
  threshold: number,
): { color: Rgba; hex: string; ratio: number } | null {
  const darkOnLight = relativeLuminance(foreground) < relativeLuminance(background);
  for (let step = 0; step <= 255; step += 1) {
    const candidate: Rgba = darkOnLight
      ? {
          red: Math.max(0, foreground.red - step),
          green: Math.max(0, foreground.green - step),
          blue: Math.max(0, foreground.blue - step),
          alpha: 1,
        }
      : {
          red: Math.min(255, foreground.red + step),
          green: Math.min(255, foreground.green + step),
          blue: Math.min(255, foreground.blue + step),
          alpha: 1,
        };
    const ratio = contrastRatio(candidate, background);
    if (ratio >= threshold) {
      return { color: candidate, hex: toHex(candidate), ratio: roundTo(ratio, 3) };
    }
  }
  return null;
}

function toHex(color: Rgba): string {
  return (
    "#" +
    [color.red, color.green, color.blue]
      .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
      .join("")
  );
}
