import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function sourceBetween(
  source: string,
  startAnchor: string,
  endAnchor: string,
  label: string,
): string {
  const startIndex = source.indexOf(startAnchor);
  assert.ok(startIndex >= 0, `${label} start anchor exists`);
  const endIndex = source.indexOf(
    endAnchor,
    startIndex + startAnchor.length,
  );
  assert.ok(endIndex > startIndex, `${label} end anchor follows its start`);
  return source.slice(startIndex, endIndex);
}

test("production owns one OS-user-scoped preference store, both fixed IPC bindings, Claude permission composition, and lifecycle drain", async () => {
  const [source, lifecycleSource] = await Promise.all([
    readFile(
      new URL(
        "../../src/workbench-shell/electron/main.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../src/workbench-shell/electron/lifecycle.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  assert.match(
    source,
    /import \{[\s\S]*createWorkbenchAppearancePreferenceStore,[\s\S]*type WorkbenchAppearancePreferenceStore,[\s\S]*\} from "\.\.\/appearance-preference-store\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*installWorkbenchAppearancePreferenceIpc,[\s\S]*type WorkbenchAppearancePreferenceIpcBinding,[\s\S]*\} from "\.\/appearance-preference-ipc\.ts";/u,
  );
  assert.match(
    source,
    /import \{[\s\S]*installWorkbenchClaudePermissionHandlingIpc,[\s\S]*type WorkbenchClaudePermissionHandlingIpcBinding,[\s\S]*\} from "\.\/claude-permission-handling-ipc\.ts";/u,
  );
  assert.match(
    source,
    /appearancePreferenceStore = createWorkbenchAppearancePreferenceStore\(\{\s+filePath: join\(\s*app\.getPath\("userData"\),\s*"workbench-appearance-preferences-v1\.json",?\s*\),\s+\}\);/u,
  );
  assert.match(
    source,
    /const initializedAppearancePreferenceStore = appearancePreferenceStore;[\s\S]*appearancePreferenceIpc = installWorkbenchAppearancePreferenceIpc\(\{\s+ipcMain,\s+window: createdWindow,\s+source: initializedAppearancePreferenceStore,\s+\}\);/u,
  );
  assert.match(
    source,
    /claudePermissionHandlingIpc = installWorkbenchClaudePermissionHandlingIpc\(\{\s+ipcMain,\s+window: createdWindow,\s+source: initializedAppearancePreferenceStore,\s+\}\);/u,
  );
  assert.match(
    source,
    /claudePermissionHandling:\s*\{[\s\S]*readClaudePermissionHandling\(\)[\s\S]*"without-asking"[\s\S]*"bypassPermissions"[\s\S]*"manual"[\s\S]*requestToolPermission: requestClaudeToolPermission/u,
  );

  const lifecycleCompositionSource = sourceBetween(
    source,
    "const lifecycle = createWorkbenchLifecycleController({",
    "\nif (!ownsSingleInstanceLock)",
    "production lifecycle composition",
  );
  // Issue 172 moved both bodies out of the composition object and into named
  // module functions: one teardown list shared with the window's "closed"
  // handler, and one durable close that a failing listener shutdown cannot
  // cancel. The assertions below are unchanged in what they require; only the
  // slice they read has followed the code.
  const disposeProjectViewSource = sourceBetween(
    source,
    "function disposeWindowScopedBindings(): void {",
    "\nconst requestClaudeToolPermission",
    "shared window-scoped binding teardown",
  );
  const closeBackendSource = sourceBetween(
    source,
    "async function closeWorkbenchDurableState(): Promise<void> {",
    "\nif (!ownsSingleInstanceLock)",
    "durable state close",
  );
  assert.match(
    lifecycleCompositionSource,
    /disposeProjectView\(\) \{\s+shutdownRequested = true;\s+disposeWindowScopedBindings\(\);\s+\}/u,
  );
  assert.match(
    lifecycleCompositionSource,
    /async closeBackend\(\) \{[\s\S]*?closeDurableStateAfterListenerShutdown\(\{[\s\S]*?closeDurableState: closeWorkbenchDurableState,/u,
  );
  const drainSource = sourceBetween(
    lifecycleSource,
    "  const startDrain = (): void => {",
    "  const startQuitAttempt = (): void => {",
    "lifecycle shutdown drain",
  );
  // Each binding is cleared BEFORE it is disposed, so a dispose that fails
  // cannot leave the binding live for the "closed" handler to trip over a
  // second time — which is how a teardown failure reached the owner as an
  // uncaught main-process exception (issue 172).
  assert.match(
    disposeProjectViewSource,
    /const closing = appearancePreferenceIpc;\s+appearancePreferenceIpc = null;\s+closing\?\.dispose\(\);/u,
  );
  assert.match(
    disposeProjectViewSource,
    /const closing = claudePermissionHandlingIpc;\s+claudePermissionHandlingIpc = null;\s+closing\?\.dispose\(\);/u,
  );
  assert.match(
    closeBackendSource,
    /await closeWorkbenchBackendAfterInitialization\(backendInitialization, \(\) => \{/u,
  );
  assert.match(
    closeBackendSource,
    /const closingAppearancePreferenceStore = appearancePreferenceStore;[\s\S]*appearancePreferenceStore = null;/u,
  );
  assert.match(
    closeBackendSource,
    /return \{\s+async close\(\) \{\s+try \{\s+await closingCreateProjectController\?\.close\(\);\s+\} finally \{\s+try \{\s+await closingBackend\?\.close\(\);\s+\} finally \{\s+await closingAppearancePreferenceStore\?\.close\(\);\s+\}\s+\}\s+\},\s+\};/u,
  );
  // The durable flush must not sit behind work that is allowed to fail. It used
  // to: `closeBackend` awaited both listener-shutdown promises in sequence and
  // outside its own try, so one rejecting `async dispose()` skipped the whole
  // flush and the drain exited anyway (issue 172).
  assert.match(
    lifecycleCompositionSource,
    /listenerShutdowns: \[\s+subscriptionAuthenticationShutdown,\s+historyRecoveryIpcShutdown,\s+\]/u,
  );
  assert.doesNotMatch(
    lifecycleCompositionSource,
    /async closeBackend\(\) \{\s+await subscriptionAuthenticationShutdown;/u,
  );
  const disposeProjectViewCall = drainSource.indexOf(
    "options.disposeProjectView();",
  );
  const closeBackendCall = drainSource.indexOf("options.closeBackend()");
  assert.ok(disposeProjectViewCall >= 0);
  assert.ok(closeBackendCall >= 0);
  assert.ok(
    disposeProjectViewCall < closeBackendCall,
    "the lifecycle closes renderer actions before beginning the backend/store drain",
  );

  const appearanceStoreCreationCount = source.match(
    /createWorkbenchAppearancePreferenceStore\(/gu,
  )?.length;
  assert.equal(appearanceStoreCreationCount, 1);
  const appearancePathCount = source.match(
    /workbench-appearance-preferences-v1\.json/gu,
  )?.length;
  assert.equal(appearancePathCount, 1);
  assert.doesNotMatch(
    source,
    /createWorkbenchAppearancePreferenceStore\([\s\S]*direct-session-profile-preferences\.json/u,
  );
});
