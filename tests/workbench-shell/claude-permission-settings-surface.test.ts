import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Settings visibly names the Claude permission consequence and wires two exact pressed choices", async () => {
  const [settings, copy, mount, styles] = await Promise.all([
    readFile(
      new URL("../../src/workbench-shell/renderer/settings.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/renderer/copy/settings-copy.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../src/workbench-shell/renderer/styles.css", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(settings, /id="claude-permissions-title"/u);
  assert.match(settings, /settingsCopy\.permissionHandlingHint/u);
  assert.match(
    settings,
    /aria-pressed=\{\s*props\.claudePermissionHandling === "without-asking"\s*\}/u,
  );
  assert.match(
    settings,
    /aria-pressed=\{\s*props\.claudePermissionHandling === "ask-when-needed"\s*\}/u,
  );
  assert.match(
    settings,
    /props\.onClaudePermissionHandling\("without-asking"\)/u,
  );
  assert.match(
    settings,
    /props\.onClaudePermissionHandling\("ask-when-needed"\)/u,
  );
  assert.doesNotMatch(settings, /readonly claudePermissionHandling\?:/u);
  assert.doesNotMatch(settings, /onClaudePermissionHandling\?\./u);
  assert.match(settings, /aria-describedby="claude-permission-handling-hint"/u);
  assert.match(
    copy,
    /"Choose whether new Claude Sessions can use tools without asking or pause for approval when Claude requires it\."/u,
  );
  assert.match(
    copy,
    /withoutAskingPermissionOption: "Use tools without asking"/u,
  );
  assert.match(copy, /askWhenNeededPermissionOption: "Ask when needed"/u);
  assert.match(
    copy,
    /permissionHandlingHint:\s*\n\s*"选择新 Claude 会话可直接使用工具，还是在 Claude 要求时暂停并请求确认。"/u,
  );
  assert.match(
    mount,
    /\.loadClaudePermissionHandling\(\)[\s\S]*\.saveClaudePermissionHandling\(request\.permissionHandling\)/u,
  );
  assert.match(styles, /\.permission-section-head,/u);
});
