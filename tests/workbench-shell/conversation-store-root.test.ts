import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import test from "node:test";

import { resolveConversationStoreRoot } from "../../src/workbench-shell/conversation-store-root.ts";

test("owner and silently redirected launch contexts resolve one canonical conversation store", () => {
  const ownerProfile = "C:\\Users\\owner";
  const roaming = "C:\\Users\\owner\\AppData\\Roaming";
  const ownerElectronUserData = win32.join(roaming, "synchronized-intellect-network");
  const redirectedRoaming =
    "C:\\Users\\owner\\AppData\\Local\\Packages\\AgentContainer\\LocalCache\\Roaming";
  const containerElectronUserData =
    win32.join(redirectedRoaming, "synchronized-intellect-network");

  const ownerRoot = resolveConversationStoreRoot({
    platform: "win32",
    roamingAppDataDirectory: roaming,
    windowsUserProfileDirectory: ownerProfile,
    electronUserDataDirectory: ownerElectronUserData,
  });
  const containerRoot = resolveConversationStoreRoot({
    platform: "win32",
    roamingAppDataDirectory: redirectedRoaming,
    windowsUserProfileDirectory: ownerProfile,
    electronUserDataDirectory: containerElectronUserData,
  });

  assert.equal(
    ownerRoot,
    win32.join(roaming, "synchronized-intellect-network", "workbench-project-host"),
  );
  assert.equal(containerRoot, ownerRoot);
});

test("an explicit user-data directory remains an isolated conversation store", () => {
  const isolatedProfile =
    "C:\\AgentFixtures\\seeded-profile\\synchronized-intellect-network";

  assert.equal(
    resolveConversationStoreRoot({
      platform: "win32",
      roamingAppDataDirectory: "C:\\Users\\owner\\AppData\\Roaming",
      windowsUserProfileDirectory: "C:\\Users\\owner",
      electronUserDataDirectory: isolatedProfile,
      explicitUserDataDirectory: isolatedProfile,
    }),
    win32.join(isolatedProfile, "workbench-project-host"),
  );
});

test("an explicit isolated launch refuses every ordinary recovery root", () => {
  const roaming = "C:\\Users\\owner\\AppData\\Roaming";
  for (const discoverableProfile of [
    "Electron",
    "unified-agent-workbench",
    "synchronized-intellect-network",
    "Unified Agent Workbench",
  ]) {
    const explicitUserDataDirectory = win32.join(
      roaming,
      discoverableProfile,
    );
    assert.throws(
      () =>
        resolveConversationStoreRoot({
          platform: "win32",
          roamingAppDataDirectory: roaming,
          windowsUserProfileDirectory: "C:\\Users\\owner",
          electronUserDataDirectory: explicitUserDataDirectory,
          explicitUserDataDirectory,
        }),
      { message: "isolated-conversation-store-root-discoverable" },
      discoverableProfile,
    );
  }
});

test("Windows root resolution fails closed without an absolute owner or isolated anchor", () => {
  assert.throws(
    () =>
      resolveConversationStoreRoot({
        platform: "win32",
        roamingAppDataDirectory: undefined,
        electronUserDataDirectory: "C:\\Redirected\\synchronized-intellect-network",
      }),
    { message: "canonical-conversation-store-root-unavailable" },
  );
  assert.throws(
    () =>
      resolveConversationStoreRoot({
        platform: "win32",
        roamingAppDataDirectory: "C:\\Users\\owner\\AppData\\Roaming",
        electronUserDataDirectory: "relative-profile",
        explicitUserDataDirectory: "relative-profile",
      }),
    { message: "isolated-conversation-store-root-invalid" },
  );
  assert.throws(
    () =>
      resolveConversationStoreRoot({
        platform: "win32",
        roamingAppDataDirectory: "C:\\Users\\owner\\AppData\\Roaming",
        electronUserDataDirectory: "C:\\Resolved\\Profile",
        explicitUserDataDirectory: "C:\\Requested\\Profile",
      }),
    { message: "isolated-conversation-store-root-mismatch" },
  );
});

test("production wires every conversation-store consumer through the resolved root", async () => {
  const source = await readFile(
    new URL("../../src/workbench-shell/electron/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /import \{ resolveConversationStoreRoot \} from "\.\.\/conversation-store-root\.ts";/u,
  );
  assert.match(
    source,
    /const projectHostDataDirectory = resolveConversationStoreRoot\(\{[\s\S]*?roamingAppDataDirectory: process\.env\.APPDATA,[\s\S]*?windowsUserProfileDirectory: app\.getPath\("home"\),[\s\S]*?electronUserDataDirectory,[\s\S]*?explicitUserDataDirectory/u,
  );
  assert.match(
    source,
    /createHistoricalRecoveryLibrary\(\{\s+dataDirectory: join\(electronUserDataDirectory, "history-recovery-v1"\)/u,
  );
  assert.match(
    source,
    /const recoveryUserDataDirectory = dirname\(projectHostDataDirectory\);/u,
    "discovery must classify the actual physical conversation store as current",
  );
  assert.match(
    source,
    /readAppDataDirectory: \(\) =>\s+process\.platform === "win32" && explicitUserDataDirectory === undefined\s+\? dirname\(recoveryUserDataDirectory\)\s+: app\.getPath\("appData"\),\s+currentUserDataDirectory: recoveryUserDataDirectory,/u,
    "ordinary Windows recovery must find historical siblings in physical Roaming, not redirected Electron appData",
  );
  assert.match(
    source,
    /createWorkLedgerAuthGenerationModule\(\{\s+dataDirectory: projectHostDataDirectory/u,
  );
  assert.match(
    source,
    /initializeWorkbenchProjectHost\(\{\s+isPackaged: app\.isPackaged,\s+userDataDirectory: electronUserDataDirectory,\s+conversationStoreDirectory: projectHostDataDirectory/u,
  );
  assert.match(
    source,
    /openWorkbenchCreateProjectStateStore\(\{\s+dataDirectory: projectHostDataDirectory/u,
  );
  assert.doesNotMatch(
    source,
    /projectHostDataDirectory\s*=\s*join\(\s*(?:userDataDirectory|electronUserDataDirectory)/u,
  );
});
