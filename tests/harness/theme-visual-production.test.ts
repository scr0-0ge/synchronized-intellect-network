import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const driverPath = fileURLToPath(
  new URL("../e2e/theme-visual-production.ts", import.meta.url),
);

const expectedStates = Object.freeze([
  {
    id: "dark-off-neutral",
    tone: "Dark",
    crt: "Off",
    phosphor: "Neutral",
    root: {
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: null,
      crt: null,
      phosphor: "neutral",
      phosphorTier: "b",
    },
    screenshot: "worker-226-theme-dark-off-neutral.png",
  },
  {
    id: "light-off-neutral",
    tone: "Light",
    crt: "Off",
    phosphor: "Neutral",
    root: {
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: "light",
      crt: null,
      phosphor: "neutral",
      phosphorTier: "b",
    },
    screenshot: "worker-226-theme-light-off-neutral.png",
  },
  {
    id: "dark-full-green",
    tone: "Dark",
    crt: "Full",
    phosphor: "Green",
    root: {
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: null,
      crt: "full",
      phosphor: "green",
      phosphorTier: "b",
    },
    screenshot: "worker-226-theme-dark-full-green.png",
  },
  {
    id: "light-full-amber",
    tone: "Light",
    crt: "Full",
    phosphor: "Amber",
    root: {
      skin: "acrylic",
      glass: "full",
      material: "on",
      tone: "light",
      crt: "full",
      phosphor: "amber",
      phosphorTier: "b",
    },
    screenshot: "worker-226-theme-light-full-amber.png",
  },
]);

const expectedMeasurementTargets = Object.freeze([
  "settings-lede",
  "settings-scope",
  "appearance-tone-copy",
  "appearance-crt-copy",
  "appearance-phosphor-copy",
  "appearance-phosphor-tier-copy",
  "providers-policy-copy",
  "providers-policy-details",
  "codex-provider-name",
  "codex-endpoint-label",
  "claude-provider-name",
  "claude-endpoint-label",
  "glm-provider-name",
  "deepseek-provider-name",
  "kimi-provider-name",
  "tool-claude-name",
  "tool-codex-name",
  "rail-provider-label",
  "rail-model-label",
]);

async function loadDriver() {
  return import(pathToFileURL(driverPath).href);
}

test("the public driver contract fixes the four owner-QA states and PNG names", () => {
  const run = spawnSync(
    process.execPath,
    ["--no-warnings", driverPath, "--describe-contract"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const line = run.stdout.trim();
  assert.match(line, /^THEME_VISUAL_CONTRACT /u);
  const contract = JSON.parse(line.slice("THEME_VISUAL_CONTRACT ".length));

  assert.equal(contract.proof, "theme-visual-production-v1");
  assert.deepEqual(contract.viewport, { width: 1440, height: 1000 });
  assert.equal(contract.nonLargeTextContrastMinimum, 4.5);
  assert.deepEqual(contract.states, expectedStates);
  assert.deepEqual(contract.settings, {
    heading: "Settings",
    sections: [
      "Appearance",
      "Providers",
      "Tools",
      "Usage & resets",
      "Claude permissions",
    ],
    groups: [
      { label: "Tone", choices: ["Dark", "Light"] },
      { label: "CRT", choices: ["Off", "Blocks", "Screen", "Full"] },
      { label: "Phosphor", choices: ["Neutral", "Green", "Amber"] },
      {
        label: "Light glow",
        choices: ["A · Restrained", "B · Luminous", "C · Hottest"],
      },
    ],
  });
  assert.deepEqual(contract.measurementTargets, expectedMeasurementTargets);
  assert.deepEqual(contract.terminalContrastPlates, {
    dark: ["#0a0a0d", "#202027"],
    light: ["#f0f1f6", "#e2e3e7"],
  });
  assert.deepEqual(contract.subjectiveBoundaries, {
    ownerLikesCurrentLightPalette: "UNPROVEN",
    ownerPerceivesCurrentPhosphorAsLuminous: "UNPROVEN",
    universalRealAcrylicWallpaperContrast: "UNPROVEN",
  });
  assert.deepEqual(contract.publication, {
    preExistingFinalEvidence: "fail-closed",
    png: "unique-pending-reopen-validate-clean-shutdown-promote-reopen-seal",
    json: "unique-pending-reopen-validate-rename-reopen-seal-final-gate",
    ownedRootRemoval:
      "zero-runtime-and-zero-cleanup-failures-after-exact-child-death-proof",
  });
});

test("pure WCAG helpers use the independent 4.5 non-large threshold", async () => {
  const { contrastRatioForCssColors, isWcagLargeText } = await loadDriver();
  assert.equal(contrastRatioForCssColors("rgb(0, 0, 0)", "rgb(255, 255, 255)"), 21);
  assert.equal(contrastRatioForCssColors("#777777", "#ffffff"), 4.478);
  assert.equal(isWcagLargeText(11, 700), false);
  assert.equal(isWcagLargeText(24, 400), true);
  assert.equal(isWcagLargeText(18.67, 700), true);
});

test("pure PNG inspection rejects a non-PNG and reads fixed IHDR dimensions", async () => {
  const { readPngDimensions } = await loadDriver();
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1440, 16);
  bytes.writeUInt32BE(1000, 20);
  assert.deepEqual(readPngDimensions(bytes), { width: 1440, height: 1000 });
  assert.throws(() => readPngDimensions(Buffer.alloc(24)), /invalid-png-signature/u);
});

test("the runtime path uses semantic Settings controls and independently checks every state", () => {
  const source = readFileSync(driverPath, "utf8");
  assert.match(source, /getByRole\("button", \{ name: "Settings", exact: true \}\)/u);
  assert.match(source, /getByRole\("heading", \{ name: "Settings", exact: true, level: 1 \}\)/u);
  assert.match(source, /getByRole\("group", \{ name: group, exact: true \}\)/u);
  assert.match(source, /getByRole\("button", \{ name: choice, exact: true \}\)/u);
  assert.match(source, /for \(const state of VISUAL_STATES\)/u);
  assert.match(source, /assert\.deepEqual\(root, state\.root\)/u);
  assert.match(source, /assert\.equal\(root\.material, "on"\)/u);
  assert.match(source, /await inspectSettingsStructure\(page\)/u);
  assert.match(source, /await measurePublicText\(page, state\)/u);
  assert.match(
    source,
    /assert\.ok\(\s*measurement\.minimumContrast >= NON_LARGE_TEXT_CONTRAST_MINIMUM,?\s*\)/u,
  );
  assert.doesNotMatch(source, /\.mouse\.|robotjs|SendInput|SetCursorPos/iu);
  assert.match(source, /osInputUsed: false/u);
  assert.match(source, /computerUseUsed: false/u);
});

test("F71 records exact tokens and rendered text-shadow without fragile pixel claims", () => {
  const source = readFileSync(driverPath, "utf8");
  for (const literal of [
    "#8dffb4",
    "rgb(80 255 150 / 55%)",
    "#b23a00",
    "rgb(255 104 24 / 50%)",
    'fg1Alpha: "88%"',
    'fg2Alpha: "72%"',
    'fg3Alpha: "60%"',
    'fg1Alpha: "100%"',
    'fg2Alpha: "98%"',
    'fg3Alpha: "96%"',
  ]) {
    assert.ok(source.includes(literal), `missing F71 literal ${literal}`);
  }
  assert.match(source, /assert\.deepEqual\(phosphor, state\.phosphorExpectation\)/u);
  assert.match(source, /textShadow/u);
  assert.doesNotMatch(
    source,
    /(?:function|const)\s+(?:measure|calculate|sample)[A-Za-z]*(?:DeltaE|Halo)|screenshotPixel/iu,
  );
  assert.match(source, /pixelHaloOrDeltaEMeasured: false/u);
});

test("launch ownership is identity-bound and cleanup is graceful-first with exact-child fallback", () => {
  const source = readFileSync(driverPath, "utf8");
  assert.match(source, /const child = application\.process\(\);/u);
  assert.match(source, /const exitState = trackOwnedChildExit\(child\);/u);
  assert.match(source, /Object\.freeze\(\{ application, child, exitState, pid \}\)/u);
  const cleanupStart = source.indexOf("async function cleanupOwnedApplication(");
  const cleanupEnd = source.indexOf("async function assertAllOwnedChildrenExited(", cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd);
  assert.ok(cleanup.indexOf("await closeOwned(owned)") >= 0);
  assert.ok(cleanup.indexOf("await terminateExactOwnedChild(owned)") > cleanup.indexOf("await closeOwned(owned)"));
  assert.match(source, /owned\.child\.kill\(\)/u);
  assert.doesNotMatch(cleanup, /process\.kill|taskkill|Get-Process|Stop-Process/iu);
  const deathProof = source.indexOf("await assertAllOwnedChildrenExited(launchedApplications);");
  const removal = source.indexOf("await removeRoutineRoot(routineBase, routineRoot);", deathProof);
  assert.ok(deathProof >= 0 && removal > deathProof);
});

test("dist freshness, isolation, sanitized failures, and objective boundaries are explicit", () => {
  const source = readFileSync(driverPath, "utf8");
  assert.ok(source.indexOf("await inspectFreshDist()") < source.indexOf("await createRoutineRoot()"));
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "PATH"]) {
    assert.match(source, new RegExp(`environment\\.${key} =`, "u"));
  }
  // Issue 161: same arguments plus the offscreen placement switch.
  assert.match(
    source,
    /args: \[\s+repositoryRoot,\s+`--user-data-dir=\$\{paths\.userData\}`,\s+OFFSCREEN_PLACEMENT_ARGUMENT,\s+\]/u,
  );
  assert.match(source, /await page\.setViewportSize\(VIEWPORT\)/u);
  assert.match(source, /runtimeFailure: runtimeFailure \?\? null,[\s\S]*cleanupFailures/u);
  assert.match(source, /THEME_VISUAL_PRODUCTION_FAILURE/u);
  assert.doesNotMatch(source, /\b(?:stack|credential|prompt|rawProviderProse|temporaryRootPath)\b/u);
  assert.match(source, /ownerLikesCurrentLightPalette: "UNPROVEN"/u);
  assert.match(source, /ownerPerceivesCurrentPhosphorAsLuminous: "UNPROVEN"/u);
});

test("a runtime or cleanup failure retains the guarded diagnostic root", () => {
  const source = readFileSync(driverPath, "utf8");
  const finalizerStart = source.indexOf("  } finally {");
  const finalizerEnd = source.indexOf("  if (runtimeFailure", finalizerStart);
  assert.ok(finalizerStart >= 0 && finalizerEnd > finalizerStart);
  const finalizer = source.slice(finalizerStart, finalizerEnd);
  assert.match(
    finalizer,
    /if \(\s*routineRoot\.length > 0 &&\s*runtimeFailure === undefined &&\s*cleanupFailures\.length === 0\s*\)/u,
  );
  const deathProof = finalizer.indexOf(
    "await assertAllOwnedChildrenExited(launchedApplications);",
  );
  const removal = finalizer.indexOf(
    "await removeRoutineRoot(routineBase, routineRoot);",
    deathProof,
  );
  assert.ok(deathProof >= 0 && removal > deathProof);
  assert.match(source, /ownedRootRetained: routineRoot\.length > 0 && !routineRootRemoved/u);
});

test("PNGs use unique pending names and final names publish only after clean shutdown", () => {
  const source = readFileSync(driverPath, "utf8");
  assert.match(
    source,
    /`worker-226-theme-pending-\$\{runId\}-\$\{state\.id\}\.png`/u,
  );
  assert.match(source, /await captureAndReopenPendingPng\(/u);
  assert.match(source, /await assertFinalEvidenceAbsent\(\)/u);
  assert.match(source, /async function publishFinalEvidence\(/u);
  assert.match(source, /await link\(pending\.path, finalPath\)/u);
  assert.match(source, /await reopenAndSealPng\(finalPath/u);
  assert.match(source, /await rollbackPublishedEvidence\(/u);
  const cleanupRemoved = source.indexOf("ownedRootRemoved: routineRootRemoved");
  const publication = source.indexOf("await publishFinalEvidence(", cleanupRemoved);
  assert.ok(cleanupRemoved >= 0 && publication > cleanupRemoved);
  assert.doesNotMatch(
    source,
    /page\.screenshot\(\{[\s\S]{0,240}?path:\s*join\(evidenceDirectory,\s*fileName\)/u,
  );
});

test("the JSON manifest is a pending-validated rename and final reopen seal", () => {
  const source = readFileSync(driverPath, "utf8");
  const publishStart = source.indexOf("async function publishFinalEvidence(");
  const publishEnd = source.indexOf("async function rollbackPublishedEvidence(", publishStart);
  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  const publish = source.slice(publishStart, publishEnd);
  const pendingWrite = publish.indexOf("await writeFile(pendingJsonPath");
  const pendingReopen = publish.indexOf("await readAndValidateEvidenceJson(pendingJsonPath", pendingWrite);
  const rename = publish.indexOf("await rename(pendingJsonPath, evidenceJsonPath)", pendingReopen);
  const finalReopen = publish.indexOf("await readAndValidateEvidenceJson(evidenceJsonPath", rename);
  assert.ok(pendingWrite >= 0);
  assert.ok(pendingReopen > pendingWrite);
  assert.ok(rename > pendingReopen);
  assert.ok(finalReopen > rename);
  assert.match(publish, /assert\.deepEqual\(finalJson\.bytes, pendingJson\.bytes\)/u);
  assert.match(publish, /flag: "wx"/u);
  assert.match(publish, /await assertMissing\(evidenceJsonPath\)/u);
});

test("PNG rollback is gated on proving the fixed final manifest is absent", () => {
  const source = readFileSync(driverPath, "utf8");
  const rollbackStart = source.indexOf("async function rollbackPublishedEvidence(");
  const rollbackEnd = source.indexOf("async function reopenAndSealPng(", rollbackStart);
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart);
  const rollback = source.slice(rollbackStart, rollbackEnd);
  const finalManifestInspection = rollback.indexOf(
    "await inspectPathPresence(evidenceJsonPath)",
  );
  const finalManifestAbsenceProof = rollback.indexOf(
    "await assertMissing(evidenceJsonPath);",
    finalManifestInspection,
  );
  const pngRollback = rollback.indexOf(
    "for (const published of [...publishedPngs].reverse())",
  );
  assert.ok(finalManifestInspection >= 0);
  assert.ok(finalManifestAbsenceProof > finalManifestInspection);
  assert.ok(pngRollback > finalManifestAbsenceProof);
  assert.match(
    rollback.slice(finalManifestInspection, pngRollback),
    /if \(finalJsonPresence === "PRESENT"\)[\s\S]*readAndValidateEvidenceJsonBytes\([\s\S]*rename\(evidenceJsonPath, pendingJsonPath\)/u,
  );
});
