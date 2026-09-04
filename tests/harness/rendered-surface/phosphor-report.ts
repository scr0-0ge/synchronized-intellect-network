/*
 * Worker 408 rendered Phosphor-tier evidence.
 *
 *   node --no-warnings tests/harness/rendered-surface/phosphor-report.ts tier-setting
 *
 * Every state is reached through the real Settings controls. The palette is
 * never overridden by the harness: theme-crt.css is the single runtime source.
 * Glow/pixels and AA use separate captures so a halo cannot be counted as a
 * more favourable background sample.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { judgeText } from "./contrast.ts";
import {
  measureSurface,
  startSurfaceServer,
  type MeasuredSurface,
  type MeasuredText,
  type SurfaceRequest,
} from "./measure.ts";
import { PHOSPHOR_SURFACES } from "./surfaces.ts";

const label = process.argv[2] ?? "tier-setting";
assert.equal(label, "tier-setting", "invalid evidence label");

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const evidenceDirectory = join(
  repositoryRoot,
  ".scratch",
  "unified-ai-workbench",
  "evidence",
);
const finalJsonPath = join(evidenceDirectory, "worker-408-phosphor-tier-rendered.json");
await assertMissing(finalJsonPath);

const stage = await mkdtemp(join(tmpdir(), "uaw-worker-408-phosphor-tier-"));
try {
  const server = await startSurfaceServer();
  const visualStates: Record<string, unknown>[] = [];
  const contrastStates: Record<string, unknown>[] = [];
  try {
    for (const request of PHOSPHOR_SURFACES) {
      const darkScreenshotPath = request.surfaceId.includes("-dark-")
        ? join(stage, `${request.surfaceId}.png`)
        : undefined;
      const measured = await measureSurface(server, {
        ...request,
        screenshotPath: darkScreenshotPath,
      });
      visualStates.push(
        await visualState(request, measured, darkScreenshotPath),
      );
    }

    for (const request of PHOSPHOR_SURFACES.filter((candidate) =>
      candidate.surfaceId.includes("-light-"),
    )) {
      const measured = await measureSurface(server, {
        ...request,
        preserveTextShadow: false,
      });
      contrastStates.push(contrastState(request, measured));
    }
  } finally {
    await server.close();
  }

  assertDarkScreenshotIdentity(visualStates);
  const document = Object.freeze({
    proof: "worker-408-phosphor-tier-rendered-surface-v1",
    label,
    viewport: Object.freeze({ width: 1440, height: 1000 }),
    paletteSource: "runtime Settings → data-phosphor-tier → theme-crt.css",
    productCss: await fileSeal(
      join(
        repositoryRoot,
        "src",
        "workbench-shell",
        "renderer",
        "themes",
        "theme-crt.css",
      ),
    ),
    designCss: await fileSeal(
      join(
        repositoryRoot,
        ".scratch",
        "unified-ai-workbench",
        "design",
        "theme-crt.css",
      ),
    ),
    visualStates: Object.freeze(visualStates),
    contrastStates: Object.freeze(contrastStates),
  });
  assert.deepEqual(
    document.productCss,
    document.designCss,
    "product/design CRT CSS drifted",
  );

  await writeFile(finalJsonPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `PHOSPHOR_TIER_RENDER_EVIDENCE ${JSON.stringify(await fileSeal(finalJsonPath))}\n`,
  );
} finally {
  await rm(stage, { recursive: true, force: true, maxRetries: 3 });
}

async function visualState(
  request: SurfaceRequest,
  measured: MeasuredSurface,
  screenshotPath: string | undefined,
): Promise<Record<string, unknown>> {
  assert.equal(measured.surfaceId, request.surfaceId);
  const identity = parseIdentity(request.surfaceId);
  assert.deepEqual(measured.root, expectedRoot(identity));
  const tinted = measured.texts.filter(
    (text) =>
      text.textShadow !== null &&
      text.boxes.some((box) => box.inkedPixels > 0),
  );
  const model = requireModel(measured);
  const paintedGlyph = model.boxes.find((box) => box.paintedGlyph !== null)
    ?.paintedGlyph;
  assert.ok(paintedGlyph, `${request.surfaceId}: model left no painted glyph`);
  return Object.freeze({
    surfaceId: request.surfaceId,
    root: measured.root,
    glowingStringCount: tinted.length,
    model: Object.freeze({
      color: model.color,
      colorSource: model.colorSource,
      textShadow: model.textShadow,
      inheritedOpacity: model.inheritedOpacity,
      inkedPixels: model.boxes.reduce((total, box) => total + box.inkedPixels, 0),
      paintedGlyph,
    }),
    resolvedStyleGroups: Object.freeze(
      [...new Set(tinted.map((text) => `${text.color}|${text.textShadow}`))].sort(),
    ),
    darkScreenshot:
      screenshotPath === undefined ? null : await fileSeal(screenshotPath),
  });
}

function contrastState(
  request: SurfaceRequest,
  measured: MeasuredSurface,
): Record<string, unknown> {
  assert.equal(measured.surfaceId, request.surfaceId);
  const identity = parseIdentity(request.surfaceId);
  assert.equal(identity.tone, "light");
  assert.deepEqual(measured.root, expectedRoot(identity));
  const model = verdictFact(requireModel(measured));
  const shortfalls = paintObligatedTexts(measured)
    .map(verdictFact)
    .filter((verdict) => !verdict.passes);
  return Object.freeze({
    surfaceId: request.surfaceId,
    root: measured.root,
    model,
    shortfallCount: shortfalls.length,
    shortfalls: Object.freeze(shortfalls),
  });
}

function verdictFact(text: MeasuredText): Record<string, unknown> {
  const verdict = judgeText(text);
  return Object.freeze({
    signature: verdict.signature,
    text: verdict.text,
    colorSource: verdict.colorSource,
    resolvedColor: verdict.resolvedColor,
    inheritedOpacity: verdict.inheritedOpacity,
    threshold: verdict.threshold,
    ratio: verdict.ratio,
    passes: verdict.passes,
    modelsDisagree: verdict.modelsDisagree,
    analytic: Object.freeze({
      ratio: verdict.analytic.ratio,
      background: verdict.analytic.background,
    }),
    painted:
      verdict.painted === null
        ? null
        : Object.freeze({
            ratio: verdict.painted.ratio,
            background: verdict.painted.background,
          }),
  });
}

function paintObligatedTexts(surface: MeasuredSurface): MeasuredSurface["texts"] {
  const dormantRoots = new Set(["main.stage", "aside.inspector"]);
  return surface.texts.filter(
    (text) =>
      !text.ariaHiddenAncestors.some((ancestor) => dormantRoots.has(ancestor)),
  );
}

function requireModel(surface: MeasuredSurface): MeasuredText {
  const model = surface.texts.find((text) => text.signature.includes("sr-model"));
  assert.ok(model, `${surface.surfaceId}: model label was not rendered`);
  return model;
}

function parseIdentity(surfaceId: string): Readonly<{
  tier: "a" | "b" | "c";
  tone: "dark" | "light";
  crt: "normal" | "fullscreen";
  phosphor: "green" | "amber";
}> {
  const match = /^phosphor-tier-(a|b|c)-(dark|light)-(normal|fullscreen)-(green|amber)$/u.exec(
    surfaceId,
  );
  assert.ok(match, `${surfaceId}: invalid evidence surface identity`);
  return Object.freeze({
    tier: match[1] as "a" | "b" | "c",
    tone: match[2] as "dark" | "light",
    crt: match[3] as "normal" | "fullscreen",
    phosphor: match[4] as "green" | "amber",
  });
}

function expectedRoot(
  identity: ReturnType<typeof parseIdentity>,
): Readonly<Record<string, string | null>> {
  return Object.freeze({
    skin: "acrylic",
    glass: "full",
    tone: identity.tone === "light" ? "light" : null,
    crt: identity.crt === "fullscreen" ? "full" : null,
    phosphor: identity.phosphor,
    phosphorTier: identity.tier,
    material: null,
  });
}

function assertDarkScreenshotIdentity(
  states: readonly Record<string, unknown>[],
): void {
  for (const crt of ["normal", "fullscreen"] as const) {
    for (const phosphor of ["green", "amber"] as const) {
      const seals = (["a", "b", "c"] as const).map((tier) => {
        const id = `phosphor-tier-${tier}-dark-${crt}-${phosphor}`;
        const state = states.find((candidate) => candidate["surfaceId"] === id);
        assert.ok(state, `${id}: missing dark state`);
        const seal = state.darkScreenshot as
          | Readonly<{ bytes: number; sha256: string }>
          | null;
        assert.ok(seal, `${id}: missing dark screenshot seal`);
        return { bytes: seal.bytes, sha256: seal.sha256 };
      });
      assert.deepEqual(
        seals,
        [seals[0], seals[0], seals[0]],
        `${crt}/${phosphor}: dark screenshot changed with light tier`,
      );
    }
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`evidence already exists: ${path}`);
}

async function fileSeal(path: string): Promise<Readonly<{
  file: string;
  bytes: number;
  sha256: string;
}>> {
  const bytes = await readFile(path);
  return Object.freeze({
    file: path.split(/[\\/]/u).at(-1) ?? path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
