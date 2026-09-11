import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settingsModelUrl = new URL(
  "../../src/workbench-shell/renderer/settings-view-model.ts",
  import.meta.url,
);
const settingsUrl = new URL(
  "../../src/workbench-shell/renderer/settings.tsx",
  import.meta.url,
);
const settingsCopyUrl = new URL(
  "../../src/workbench-shell/renderer/copy/settings-copy.ts",
  import.meta.url,
);
const projectRailUrl = new URL(
  "../../src/workbench-shell/renderer/project-rail.tsx",
  import.meta.url,
);
const railCopyUrl = new URL(
  "../../src/workbench-shell/renderer/copy/rail-copy.ts",
  import.meta.url,
);
const stageUrl = new URL(
  "../../src/workbench-shell/renderer/stage.tsx",
  import.meta.url,
);
const stageCopyUrl = new URL(
  "../../src/workbench-shell/renderer/copy/stage-copy.ts",
  import.meta.url,
);
const recoveryCardUrl = new URL(
  "../../src/workbench-shell/renderer/history-recovery-settings.tsx",
  import.meta.url,
);
const recoveryCopyUrl = new URL(
  "../../src/workbench-shell/renderer/copy/history-recovery-copy.ts",
  import.meta.url,
);
const stylesUrl = new URL(
  "../../src/workbench-shell/renderer/styles.css",
  import.meta.url,
);

test("Historical Recovery stays inside Settings and WorkbenchSurface remains exactly project or settings", async () => {
  const [settingsModel, settings, settingsCopy, recoveryCard] = await Promise.all([
    readFile(settingsModelUrl, "utf8"),
    readFile(settingsUrl, "utf8"),
    readFile(settingsCopyUrl, "utf8"),
    readFile(recoveryCardUrl, "utf8"),
  ]);
  assert.match(
    settingsModel,
    /export type WorkbenchSurface = "project" \| "settings";/u,
  );
  // Independent of how the union above is spelled or reflowed: a third surface
  // may not appear anywhere in the surface model, including in a second union,
  // a widened alias, or a re-export.
  assert.doesNotMatch(
    settingsModel,
    /"recovery"/u,
    "the surface model declares no Historical Recovery surface",
  );
  const settingsScreen = sourceSection(
    settings,
    "export const SettingsScreen:",
    "const ProviderCard:",
  );
  assert.match(settingsScreen, /<HistoryRecoverySettingsCard/u);
  assert.match(settingsScreen, /<h1>\{settingsCopy\.title\}<\/h1>/u);
  assert.match(settingsCopy, /title:\s*"Settings"/u);
  assert.doesNotMatch(recoveryCard, /WorkbenchSurface|setSurface|onSurface/u);
});

test("both existing Settings entrances and Selected Project semantics remain untouched", async () => {
  const [projectRail, railCopy, stage, stageCopy] = await Promise.all([
    readFile(projectRailUrl, "utf8"),
    readFile(railCopyUrl, "utf8"),
    readFile(stageUrl, "utf8"),
    readFile(stageCopyUrl, "utf8"),
  ]);
  assert.match(
    projectRail,
    /aria-label=\{railCopy\.settingsLabel\}[\s\S]*?onClick=\{\(\) => props\.onSurface\("settings"\)\}/u,
  );
  assert.match(railCopy, /settingsLabel:\s*"Settings"/u);
  assert.match(
    stage,
    /onClick=\{props\.onOpenProviders\}[\s\S]*?>\s*\{stageCopy\.openSettings\}\s*<\/button>/u,
  );
  assert.match(stageCopy, /openSettings:\s*"Open Settings"/u);
  const settingsEntrances = `${projectRail}\n${railCopy}\n${stage}\n${stageCopy}`;
  assert.equal(settingsEntrances.match(/Open Providers/gu)?.length ?? 0, 0);
  assert.equal(settingsEntrances.match(/Open Settings/gu)?.length ?? 0, 1);
  const card = await readFile(recoveryCardUrl, "utf8");
  assert.doesNotMatch(
    card,
    /selectProject|selectedProject|openProject|removeProject|ProjectHost|RuntimeEndpoint/u,
  );
});

test("the contained card implements the exact home-to-turns metadata hierarchy", async () => {
  const [card, recoveryCopy] = await Promise.all([
    readFile(recoveryCardUrl, "utf8"),
    readFile(recoveryCopyUrl, "utf8"),
  ]);
  for (const token of [
    '{ readonly kind: "home" }',
    '{ readonly kind: "overview" }',
    'readonly kind: "projects"',
    'readonly kind: "sessions"',
    'readonly kind: "turns"',
  ]) {
    assert.equal(card.includes(token), true, `missing ${token}`);
  }
  for (const token of [
    "Review data recovery",
    "Historical Recovery Library",
    "Projects",
    "Sessions",
    "No metadata rows in this branch.",
    "Export exact copy…",
  ]) {
    assert.equal(recoveryCopy.includes(token), true, `missing ${token}`);
  }
  assert.match(card, /kind: "generations"[\s\S]*?page: Object\.freeze/u);
  assert.match(card, /kind: "projects"[\s\S]*?generationKey/u);
  assert.match(card, /kind: "sessions"[\s\S]*?projectKey/u);
  assert.match(card, /kind: "turns"[\s\S]*?sessionKey/u);
  assert.doesNotMatch(card, /conversationBody|messageBody|privateEnvelope|nativeReference/u);
});

test("Back, focus restoration, pending cancellation, reload staleness, and pagination are explicit", async () => {
  const [card, recoveryCopy] = await Promise.all([
    readFile(recoveryCardUrl, "utf8"),
    readFile(recoveryCopyUrl, "utf8"),
  ]);
  assert.match(card, /const focusHistory: HTMLElement\[\] = \[\];/u);
  assert.match(card, /target\?\.isConnected[\s\S]*?target\.focus/u);
  assert.match(card, /heading\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(
    card,
    /disabled=\{pendingOperation\(\) !== null\}[\s\S]*?>\s*\{historyRecoveryCopy\.back\}/u,
  );
  assert.match(recoveryCopy, /back:\s*"Back"/u);
  assert.match(card, /const cancelPending[\s\S]*?bridge\.cancel/u);
  assert.match(card, /result\.status === "stale"[\s\S]*?setRoute\(\{ kind: "overview" \}\)[\s\S]*?props\.onRefresh/u);
  assert.match(card, /snapshotKey !== observedSnapshotKey[\s\S]*?setRoute\(\{ kind: "overview" \}\)/u);
  assert.match(card, /const loadMore[\s\S]*?page\.nextAfter/u);
  assert.match(card, /result\.cleanup === "pending"[\s\S]*?"partial"/u);
});

test("the card offers only preserve, acknowledge, browse, export-copy, and cancel controls", async () => {
  const [card, recoveryCopy] = await Promise.all([
    readFile(recoveryCardUrl, "utf8"),
    readFile(recoveryCopyUrl, "utf8"),
  ]);
  // Anchored through the end of the line: widening the union in place, on the
  // same line, no longer satisfies the positive assertion.
  assert.match(
    card,
    /^\s*action: "preserve" \| "acknowledge" \| "export-copy",?\s*$/mu,
  );
  assert.match(card, /props\.bridge\.browse/u);
  assert.match(card, /props\.bridge\.perform/u);
  assert.match(card, /props\.bridge\.cancel/u);
  assert.doesNotMatch(
    card,
    /action: "(?:merge|import|adopt|resume|delete|run|select-conflict)"/u,
  );
  // Whole-card: a forbidden operation may not appear as a string literal at
  // all, however the union that carries it is spelled or reflowed.
  assert.doesNotMatch(
    card,
    /"(?:merge|import|adopt|resume|select-conflict)"/u,
  );
  assert.match(
    recoveryCopy,
    /Recovery never merges, imports, resumes, or changes a Project folder\./u,
  );
});

test("Data recovery styles are contained and responsive within the existing Settings sheet", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  for (const selector of [
    ".history-recovery-card",
    ".history-recovery-heading-row",
    ".history-recovery-row",
    ".history-recovery-browser",
    ".history-recovery-pending",
  ]) {
    assert.equal(styles.includes(selector), true, `missing ${selector}`);
  }
  assert.match(
    styles,
    /:root\[data-tone="light"\] \.history-recovery-attention\s*\{[\s\S]*?var\(--settings-reading-ground, var\(--bg-0\)\)[\s\S]*?\}/u,
  );
  assert.doesNotMatch(styles, /\.history-recovery-(?:surface|rail|window)/u);
});

/**
 * A bare `slice(indexOf(a), indexOf(b))` silently becomes the empty string once
 * either anchor is renamed, which turns every negative assertion over it into a
 * guard that cannot fail. Both anchors are proven present first.
 */
function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  const section = source.slice(startIndex, endIndex);
  assert.notEqual(section.trim(), "", `empty section: ${start} … ${end}`);
  return section;
}
