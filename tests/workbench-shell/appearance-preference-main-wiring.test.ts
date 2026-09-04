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
  const disposeProjectViewSource = sourceBetween(
    lifecycleCompositionSource,
    "  disposeProjectView() {",
    "  async closeBackend() {",
    "disposeProjectView lifecycle injection",
  );
  const closeBackendSource = sourceBetween(
    lifecycleCompositionSource,
    "  async closeBackend() {",
    "  exit() {",
    "closeBackend lifecycle injection",
  );
  const drainSource = sourceBetween(
    lifecycleSource,
    "  const startDrain = (): void => {",
    "  const startQuitAttempt = (): void => {",
    "lifecycle shutdown drain",
  );
  assert.match(
    disposeProjectViewSource,
    /appearancePreferenceIpc\?\.dispose\(\);\s+appearancePreferenceIpc = null;/u,
  );
  assert.match(
    disposeProjectViewSource,
    /claudePermissionHandlingIpc\?\.dispose\(\);\s+claudePermissionHandlingIpc = null;/u,
  );
  assert.match(
    closeBackendSource,
    /await closeWorkbenchBackendAfterInitialization\(\s+backendInitialization,\s+\(\) => \{/u,
  );
  assert.match(
    closeBackendSource,
    /const closingAppearancePreferenceStore = appearancePreferenceStore;[\s\S]*appearancePreferenceStore = null;/u,
  );
  assert.match(
    closeBackendSource,
    /return \{\s+async close\(\) \{\s+try \{\s+await closingCreateProjectController\?\.close\(\);\s+\} finally \{\s+try \{\s+await closingBackend\?\.close\(\);\s+\} finally \{\s+await closingAppearancePreferenceStore\?\.close\(\);\s+\}\s+\}\s+\},\s+\};/u,
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
