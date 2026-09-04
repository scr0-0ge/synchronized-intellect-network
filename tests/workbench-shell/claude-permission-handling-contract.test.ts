import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
  publicClaudePermissionHandlingLoaded,
  publicClaudePermissionHandlingSaved,
  publicClaudePermissionHandlingUnavailable,
} from "../../src/workbench-shell/contract.ts";
import {
  reconstructWorkbenchClaudePermissionHandling,
  sanitizeWorkbenchClaudePermissionHandlingLoadResult,
  sanitizeWorkbenchClaudePermissionHandlingSaveResult,
} from "../../src/workbench-shell/result-sanitizer.ts";

const unavailable = publicClaudePermissionHandlingUnavailable();

test("Claude permission handling exposes two exact public choices and fixed IPC channels", () => {
  assert.equal(
    WORKBENCH_LOAD_CLAUDE_PERMISSION_HANDLING_CHANNEL,
    "workbench:load-claude-permission-handling",
  );
  assert.equal(
    WORKBENCH_SAVE_CLAUDE_PERMISSION_HANDLING_CHANNEL,
    "workbench:save-claude-permission-handling",
  );
  assert.deepEqual(publicClaudePermissionHandlingLoaded("without-asking"), {
    ok: true,
    status: "loaded",
    permissionHandling: "without-asking",
  });
  assert.deepEqual(publicClaudePermissionHandlingSaved(), {
    ok: true,
    status: "saved",
    message: "Claude permission handling was durably saved.",
  });
  assert.deepEqual(unavailable, {
    ok: false,
    error: {
      category: "claude-permission-handling-unavailable",
      message:
        "Claude permission handling could not be loaded or saved. Keep the current choice and try again.",
    },
  });
});

test("Claude permission handling reconstruction rejects every unadmitted value without widening", () => {
  assert.deepEqual(reconstructWorkbenchClaudePermissionHandling("without-asking"), {
    ok: true,
    permissionHandling: "without-asking",
  });
  assert.deepEqual(
    reconstructWorkbenchClaudePermissionHandling("ask-when-needed"),
    { ok: true, permissionHandling: "ask-when-needed" },
  );
  for (const value of [
    null,
    undefined,
    true,
    0,
    [],
    {},
    "manual",
    "bypassPermissions",
    "future-mode",
    { permissionHandling: "without-asking" },
  ]) {
    assert.deepEqual(reconstructWorkbenchClaudePermissionHandling(value), {
      ok: false,
    });
  }
});

test("Claude permission handling result sanitizers admit only exact receipts", () => {
  const loaded = {
    ok: true,
    status: "loaded",
    permissionHandling: "ask-when-needed",
  } as const;
  const saved = {
    ok: true,
    status: "saved",
    message: "Claude permission handling was durably saved.",
  } as const;
  assert.deepEqual(
    sanitizeWorkbenchClaudePermissionHandlingLoadResult(loaded),
    loaded,
  );
  assert.deepEqual(
    sanitizeWorkbenchClaudePermissionHandlingSaveResult(saved),
    saved,
  );
  for (const value of [
    { ...loaded, extra: true },
    { ...loaded, permissionHandling: "manual" },
    { ...loaded, schemaVersion: 4 },
    { ok: true, status: "saved", permissionHandling: "without-asking" },
    { ok: false, error: { ...unavailable.error, extra: true } },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchClaudePermissionHandlingLoadResult(value),
      unavailable,
    );
  }
  for (const value of [
    { ...saved, extra: true },
    { ...saved, message: "saved" },
    { ...saved, permissionHandling: "without-asking" },
    { ok: false, error: { ...unavailable.error, extra: true } },
  ]) {
    assert.deepEqual(
      sanitizeWorkbenchClaudePermissionHandlingSaveResult(value),
      unavailable,
    );
  }
});
