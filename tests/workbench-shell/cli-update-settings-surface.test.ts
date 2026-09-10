import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cliUpdateCopy,
  copyLocaleDictionaries as settingsCopyLocaleDictionaries,
} from "../../src/workbench-shell/renderer/copy/settings-copy.ts";

/**
 * Ticket 18 fidelity pins: the Settings surface renders the 副主管裁决
 * button semantics (claude = check-driven Update; codex = constant
 * "Check and update"; never automatic), the inline running/success/failure
 * presentation with the optional relaunch action ("Not now"), the close-and-retry
 * failure advice, and the bilingual copy is pinned byte-exact in both
 * dictionaries.
 */

test("Settings renders the check-driven claude button and the constant codex check-and-update button", async () => {
  const settings = await readFile(
    new URL("../../src/workbench-shell/renderer/settings.tsx", import.meta.url),
    "utf8",
  );

  // claude's button appears only on a successful update-available check;
  // codex's button is always present on its row.
  assert.match(
    settings,
    /if \(props\.cliId === "codex"\) return true;/u,
  );
  assert.match(
    settings,
    /return props\.report\?\.status === "update-available";/u,
  );
  // Dismissing the optional relaunch action must not suppress a later confirmed update.
  // The button runs the update only on click, and shows the busy state.
  assert.match(
    settings,
    /const running = \(\) => props\.phase\.kind === "running";/u,
  );
  assert.match(settings, /disabled=\{running\(\)\}/u);
  assert.match(settings, /aria-busy=\{running\(\)\}/u);
  // w120. The run still happens only inside a click handler and nowhere else,
  // which is what this pin has always been for. It is no longer a single
  // expression because codex asks first: the primary press arms the question,
  // and a second, separate press is what calls onUpdate. Both call sites are
  // pinned, and the count is pinned too, so a future edit cannot add a third
  // caller -- an automatic one -- without failing here.
  assert.match(settings, /if \(needsConfirmation\(\)\) \{\s+setConfirming\(true\);\s+return;\s+\}\s+props\.onUpdate\(\);/u);
  assert.match(settings, /setConfirming\(false\);\s+props\.onUpdate\(\);/u);
  assert.equal(
    settings.match(/props\.onUpdate\(\)/gu)?.length,
    2,
    "onUpdate must be reachable only from the two deliberate presses",
  );
  // w120. codex is the row whose button is the action itself, so it is the
  // row that must ask. The question and both answers are pinned.
  assert.match(settings, /const needsConfirmation = \(\): boolean => props\.cliId === "codex";/u);
  assert.match(settings, /copy\.confirmUpdateQuestion/u);
  assert.match(settings, /copy\.confirmUpdateAction/u);
  assert.match(settings, /copy\.cancelUpdateAction/u);
  // w120. Before the press, the codex row says what will happen and admits
  // the version it does not know. Neither sentence may be dropped.
  assert.match(settings, /copy\.codexActionSentence/u);
  assert.match(settings, /copy\.codexVersionUnknownSentence/u);
  // The success state carries the explicit "Not now" dismissal.
  assert.match(settings, /copy\.succeededSentence/u);
  assert.match(settings, /onAcknowledgeRestart/u);
  assert.match(settings, /copy\.restartLaterAction/u);
  // Failure renders its coarse reason without inventing a file-lock cause.
  assert.match(settings, /copy\.failedTimeoutSentence/u);
  assert.match(settings, /copy\.failedLaunchSentence/u);
  assert.match(settings, /copy\.failedUpdateSentence/u);
  assert.doesNotMatch(settings, /copy\.failureInUseAdvice/u);
  // Issue 183: an updater that exited zero without moving the installed
  // version gets its own sentence, not the generic failure and not the
  // close-and-retry advice written for a file lock.
  assert.match(
    settings,
    /case "no-change":\s*\n\s*return copy\.failedNoChangeSentence;/u,
  );
  // Issue 183: the row re-reads the report when a run resolves, so the
  // owner never has to restart to find out what the button did. The
  // refresh runs on both the resolved and the rejected path, and its own
  // failure cannot rewrite the run's verdict.
  assert.match(settings, /const refreshCliUpdateReports = \(\): Promise<void> =>/u);
  assert.match(settings, /\.then\(\(\) => refreshCliUpdateReports\(\)\);/u);
  assert.match(settings, /onMount\(\(\) => \{\s*\n\s*void refreshCliUpdateReports\(\);/u);
  // The surface narrows the renderer bridge to the CLI update contract,
  // never invoking a run outside the button handler.
  assert.match(settings, /WorkbenchCliUpdateBridge/u);
  assert.match(settings, /typeof surface\.checkCliUpdates !== "function"/u);
  assert.match(settings, /typeof surface\.runCliUpdate !== "function"/u);
  // The check loads once on Settings mount. A failed check still shows no
  // Update button -- there is no known newer version to install -- but it
  // is no longer silent: see the check-failed pins above.
  assert.match(settings, /\.checkCliUpdates\(\)/u);
  assert.match(settings, /else failCliUpdateCheck\(\);/u);
  assert.match(settings, /\.catch\(failCliUpdateCheck\)/u);
  // Issue 184: a failed check says so and offers a retry. The control the
  // owner needs must never vanish and leave the row blank -- that is the
  // "restart before the UI is correct" shape the whole line of work exists
  // to remove.
  assert.match(
    settings,
    /const checkFailed = \(\): boolean =>\s*\n\s*props\.cliId === "claude-code" && props\.report\?\.status === "check-failed";/u,
  );
  assert.match(settings, /copy\.checkFailedSentence/u);
  assert.match(
    settings,
    /\{props\.checking \? copy\.checkingAction : copy\.checkAgainAction\}/u,
  );
  assert.match(settings, /onClick=\{\(\) => props\.onRecheck\(\)\}/u);
  assert.match(settings, /const recheckCliUpdates = \(\): void => \{/u);
  // Issue 184: the success state keeps the optional "Restart now" action
  // beside the existing "Not now" dismissal.
  assert.match(
    settings,
    /\{restarting\(\) \? copy\.restartingAction : copy\.restartNowAction\}/u,
  );
  assert.match(settings, /onClick=\{\(\) => props\.onRestartNow\(\)\}/u);
  assert.match(settings, /\.relaunchApp\(\)/u);
  assert.match(settings, /copy\.relaunchFailedSentence/u);
  // The restart is a one-way door: `queued` means the drain is running, so
  // only a refusal is allowed to move the phase back to something pressable.
  assert.match(
    settings,
    /if \(!cliUpdateActive \|\| result\.ok\) return;\s*\n\s*setCliUpdateRelaunchPhase/u,
  );
  assert.match(settings, /typeof surface\.relaunchApp !== "function"/u);
  // Only the two subscription CLI rows carry the block.
  assert.match(
    settings,
    /if \(endpointId === "claude-code-desktop"\) return "claude-code";/u,
  );
  assert.match(
    settings,
    /if \(endpointId === "codex-desktop"\) return "codex";/u,
  );
});

test("the bilingual CLI update copy is pinned byte-exact in both locales", async () => {
  const copy = await readFile(
    new URL(
      "../../src/workbench-shell/renderer/copy/settings-copy.ts",
      import.meta.url,
    ),
    "utf8",
  );

  // English pins (source of truth for the surface).
  assert.match(copy, /checkAndUpdateAction: "Check and update",/u);
  assert.match(copy, /updateAction: "Update",/u);
  assert.match(copy, /runningAction: "Updating…",/u);
  assert.match(
    copy,
    /"The update finished\. The next new session will start with the new version; existing sessions will not switch versions\.",/u,
  );
  assert.match(copy, /restartLaterAction: "Not now",/u);
  assert.match(copy, /restartNowAction: "Restart now",/u);
  assert.match(copy, /restartingAction: "Restarting…",/u);
  assert.match(
    copy,
    /relaunchFailedSentence:\s*\n\s*"The app could not restart itself\. You can keep using it; new sessions will use the new version\.",/u,
  );
  assert.match(
    copy,
    /checkFailedSentence:\s*\n\s*"Could not check whether a newer version is available\. Check again for current version information\.",/u,
  );
  assert.match(copy, /checkAgainAction: "Check for updates again",/u);
  assert.match(copy, /checkingAction: "Checking…",/u);
  assert.match(
    copy,
    /failedTimeoutSentence:\s*\n\s*"The update did not finish in time\. Nothing was changed\.",/u,
  );
  assert.match(
    copy,
    /"The update command could not be started\. Nothing was changed\.",/u,
  );
  assert.match(
    copy,
    /failedUpdateSentence:\s*\n\s*"The update did not complete\. Nothing was changed\.",/u,
  );
  assert.match(
    copy,
    /failedNoChangeSentence:\s*\n\s*"The updater finished without an error, but the installed version did not change\. Nothing was updated\. Try again, or update this CLI from the channel that installed it\.",/u,
  );
  assert.match(
    copy,
    /"A session or another process may still be using this CLI\. Close them and try again\.",/u,
  );
  assert.match(
    copy,
    /"CLI updates are unavailable in this window\. Nothing was changed\.",/u,
  );

  // zh-CN pins, including the ruled failure advice wording.
  assert.match(copy, /checkAndUpdateAction: "检查并更新",/u);
  assert.match(copy, /updateAction: "更新",/u);
  assert.match(copy, /runningAction: "正在更新…",/u);
  assert.match(copy, /succeededSentence: "更新完成。下一个新会话将启动新版本；现有会话不会切换版本。",/u);
  assert.match(copy, /restartLaterAction: "暂不",/u);
  assert.match(copy, /restartNowAction: "立即重启",/u);
  assert.match(copy, /restartingAction: "正在重启…",/u);
  assert.match(
    copy,
    /relaunchFailedSentence:\s*\n\s*"应用无法自行重启。你可以继续使用它；新会话将使用新版本。",/u,
  );
  assert.match(
    copy,
    /checkFailedSentence: "无法检查是否有更新版本。请重新检查以获取当前版本信息。",/u,
  );
  assert.match(copy, /checkAgainAction: "重新检查更新",/u);
  assert.match(copy, /checkingAction: "正在检查…",/u);
  assert.match(copy, /failedTimeoutSentence: "更新超时未完成。没有任何更改。",/u);
  assert.match(copy, /failedLaunchSentence: "无法启动更新命令。没有任何更改。",/u);
  assert.match(copy, /failedUpdateSentence: "更新未完成。没有任何更改。",/u);
  assert.match(
    copy,
    /failedNoChangeSentence:\s*\n\s*"更新程序没有报错，但已安装的版本并未变化，什么都没更新。请重试，或从安装它的渠道更新该 CLI。",/u,
  );
  assert.match(
    copy,
    /failureInUseAdvice:\s*\n\s*"可能有会话或其他进程正在使用此 CLI，关闭后重试。",/u,
  );
  assert.match(copy, /unavailableSentence: "此窗口中 CLI 更新不可用。没有任何更改。",/u);

  // The composed functions render the ruled shapes in both locales.
  assert.equal(
    settingsCopyLocaleDictionaries.en.cliUpdateCopy.updateAvailableSentence(
      "2.1.220",
      "2.1.258",
    ),
    "A new version is available: 2.1.220 → 2.1.258.",
  );
  assert.equal(
    settingsCopyLocaleDictionaries["zh-CN"].cliUpdateCopy.updateAvailableSentence(
      "2.1.220",
      "2.1.258",
    ),
    "有新版本可用：2.1.220 → 2.1.258。",
  );
  assert.equal(cliUpdateCopy.restartLaterAction, "Not now");
  assert.equal(cliUpdateCopy.restartNowAction, "Restart now");
  assert.equal(cliUpdateCopy.checkAgainAction, "Check for updates again");
});

test("Claude retry buttons name the sign-in and update checks in both locales", () => {
  assert.deepEqual(
    [
      settingsCopyLocaleDictionaries.en.subscriptionAuthCopy.recheckAction,
      settingsCopyLocaleDictionaries.en.cliUpdateCopy.checkAgainAction,
    ],
    ["Re-check sign-in", "Check for updates again"],
  );
  assert.deepEqual(
    [
      settingsCopyLocaleDictionaries["zh-CN"].subscriptionAuthCopy.recheckAction,
      settingsCopyLocaleDictionaries["zh-CN"].cliUpdateCopy.checkAgainAction,
    ],
    ["重新检查登录", "重新检查更新"],
  );
});
