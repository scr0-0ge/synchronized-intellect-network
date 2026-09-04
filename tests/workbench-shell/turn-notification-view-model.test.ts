import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { WorkbenchCommandView } from "../../src/workbench-shell/contract.ts";
import {
  fallbackTurnTitleLabel,
  turnNotificationCopy,
} from "../../src/workbench-shell/renderer/copy/turn-notification-copy.ts";
import { advanceTrackedTurns } from "../../src/workbench-shell/renderer/view-model.ts";

type CommandStatus = WorkbenchCommandView["status"];

function command(
  key: string,
  status: CommandStatus,
  options: {
    readonly label?: string;
    readonly failureCategory?: WorkbenchCommandView["failureCategory"];
  } = {},
): WorkbenchCommandView {
  return Object.freeze({
    key,
    label: options.label ?? `Agent Session ${key}`,
    runtime: "Codex",
    status,
    ...(options.failureCategory === undefined
      ? {}
      : { failureCategory: options.failureCategory }),
  });
}

function trackedOf(
  entries: readonly (readonly [string, CommandStatus])[],
): ReadonlyMap<string, CommandStatus> {
  return new Map(entries);
}

test("a command leaving an active status announces exactly one terminal notice", () => {
  const first = advanceTrackedTurns(trackedOf([["c1", "in-flight"]]), [
    command("c1", "completed"),
    command("c2", "accepted"),
  ]);

  assert.equal(first.notices.length, 1);
  const notice = first.notices[0];
  assert.equal(notice?.commandKey, "c1");
  assert.equal(notice?.title, "Agent Session c1");
  assert.equal(notice?.body, turnNotificationCopy.completed);
  assert.equal(Object.isFrozen(notice), true);

  assert.deepEqual([...first.trackedStatuses.entries()], [
    ["c1", "completed"],
    ["c2", "accepted"],
  ]);

  const second = advanceTrackedTurns(first.trackedStatuses, [
    command("c1", "completed"),
    command("c2", "completed"),
  ]);
  assert.deepEqual(
    second.notices.map((entry) => entry.commandKey),
    ["c2"],
    "each transition is announced once, never twice",
  );
});

test("every non-interrupted terminal outcome is announced with its own copy", () => {
  const progression = advanceTrackedTurns(
    trackedOf([
      ["done", "in-flight"],
      ["broke", "accepted"],
      ["unknown", "in-flight"],
    ]),
    [
      command("done", "completed"),
      command("broke", "failed"),
      command("unknown", "recovery-required"),
    ],
  );

  assert.deepEqual(progression.notices.map((notice) => notice.body), [
    turnNotificationCopy.completed,
    turnNotificationCopy.failed,
    turnNotificationCopy["recovery-required"],
  ]);
});

test("a user-interrupted failed command stays silent but still advances tracking", () => {
  const progression = advanceTrackedTurns(
    trackedOf([["stopped", "in-flight"]]),
    [command("stopped", "failed", { failureCategory: "interrupted" })],
  );

  assert.deepEqual(progression.notices, []);
  assert.equal(progression.trackedStatuses.get("stopped"), "failed");
});

test("first-seen terminals and active churn stay silent while stale commands are dropped", () => {
  const progression = advanceTrackedTurns(
    trackedOf([
      ["removed", "completed"],
    ]),
    [
      command("brand-new-active", "accepted"),
      command("still-running", "in-flight"),
      command("accepted-again", "accepted"),
    ],
  );
  assert.equal(progression.notices.length, 0);
  assert.equal(progression.trackedStatuses.has("removed"), false);

  const withUnseenTerminal = advanceTrackedTurns(
    progression.trackedStatuses,
    [command("freshly-failed", "failed")],
  );
  assert.equal(
    withUnseenTerminal.notices.length,
    0,
    "commands the renderer never observed running do not toast",
  );

});

test("notice text is clamped to the boundary limits and falls back for blank labels", () => {
  const longLabel = "L".repeat(200);
  const progression = advanceTrackedTurns(trackedOf([["long", "in-flight"]]), [
    command("long", "completed", { label: longLabel }),
  ]);
  const clamped = progression.notices[0];
  assert.ok(clamped);
  assert.equal(Array.from(clamped.title).length, 80);
  assert.equal(clamped.title.endsWith("…"), true);

  const emoji = advanceTrackedTurns(trackedOf([["emoji", "in-flight"]]), [
    command("emoji", "completed", { label: "🧪".repeat(100) }),
  ]).notices[0];
  assert.ok(emoji);
  assert.equal(Array.from(emoji.title).length, 80);
  assert.equal(emoji.title.endsWith("…"), true);
  assert.equal(emoji.title.includes("�"), false);

  const blank = advanceTrackedTurns(trackedOf([["blank", "accepted"]]), [
    command("blank", "completed", { label: "   " }),
  ]);
  assert.equal(blank.notices[0]?.title, fallbackTurnTitleLabel);

  const normal = advanceTrackedTurns(trackedOf([["normal", "in-flight"]]), [
    command("normal", "completed", { label: "short" }),
  ]);
  assert.equal(normal.notices[0]?.title, "short");

  const padded = advanceTrackedTurns(trackedOf([["padded", "accepted"]]), [
    command("padded", "completed", { label: "  tidy title  " }),
  ]);
  assert.equal(padded.notices[0]?.title, "tidy title");
});

test("the mounted Workbench announces finished turns exactly once, only while the user cannot see the window", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
    "utf8",
  );

  const observeStart = source.indexOf("const announceFinishedTurns");
  const observeEnd = source.indexOf("onMount(() => {", observeStart);
  assert.ok(observeStart >= 0 && observeEnd > observeStart);
  const announceSource = source.slice(observeStart, observeEnd);
  assert.match(
    announceSource,
    /if \(resetTracking\) \{\s*trackedTurnStatuses = new Map\(\s*result\.view\.commands\.map\(\(command\) => \[command\.key, command\.status\]\),\s*\);\s*return;\s*\}\s*const progression = advanceTrackedTurns\(\s*trackedTurnStatuses,\s*result\.view\.commands,\s*\)/u,
  );
  assert.match(
    announceSource,
    /trackedTurnStatuses = new Map\(progression\.trackedStatuses\);/u,
    "tracking advances even when delivery is suppressed",
  );
  assert.match(
    announceSource,
    /notifyTurnCompleted === undefined \|\|\s*progression\.notices\.length === 0 \|\|\s*\(!document\.hidden && document\.hasFocus\(\)\)/u,
    "delivery is skipped exactly when the window is visible and focused",
  );
  assert.match(
    announceSource,
    /Object\.freeze\(\{ title: notice\.title, body: notice\.body \}\)/u,
  );
  assert.match(announceSource, /\.catch\(\(\) => undefined\)/u);

  assert.equal(
    source.split(
      "announceFinishedTurns(result, projectScopeMayBeChanging);",
    ).length - 1,
    1,
    "the live Project observation is the single announcement site",
  );
  assert.match(
    source,
    /const projectScopeMayBeChanging =\s*current\.projectSwitch\.phase === "pending" \|\|\s*current\.projectOpen\.phase === "pending";/u,
    "a Project acquisition seeds the new public command-key scope instead of diffing reused ordinals",
  );
  assert.doesNotMatch(announceSource, /setInterval|setTimeout|while/u);
});
