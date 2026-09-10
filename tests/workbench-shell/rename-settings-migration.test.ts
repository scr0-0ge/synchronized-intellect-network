import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkbenchAppearancePreferenceStore } from "../../src/workbench-shell/appearance-preference-store.ts";
import { defaultWorkbenchAppearancePreference } from "../../src/workbench-shell/contract.ts";
import { EndpointSecretEnvelopeStore, type SafeStorageLike } from "../../src/workbench-shell/endpoint-secret-envelope-store.ts";
import { migrateRenamedSettings, RENAME_SETTINGS_RECEIPT, RENAMED_ENDPOINT_SECRETS_COPY } from "../../src/workbench-shell/rename-settings-migration.ts";

const preferenceName = "workbench-appearance-preferences-v1.json";
const secretName = "endpoint-secret-envelope-store.json";
const subject = "workbench://runtime-endpoint/glm-coding-plan";
// Control-flow double only. Real Windows safeStorage is exercised separately in Electron.
const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`test-encrypted:${value}`),
  decryptString: value => Buffer.from(value).toString().replace("test-encrypted:", ""),
};
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "w69-unit-"));
  const oldDirectory = join(root, "unified-agent-workbench");
  const userDataDirectory = join(root, "synchronized-intellect-network");
  await mkdir(oldDirectory);
  await mkdir(userDataDirectory);
  const preferences = createWorkbenchAppearancePreferenceStore({ filePath: join(oldDirectory, preferenceName) });
  await preferences.save({ ...defaultWorkbenchAppearancePreference, tone: "light" });
  await preferences.close();
  new EndpointSecretEnvelopeStore({ subject, safeStorage, storePath: join(oldDirectory, secretName) }).upsert("glm-coding-plan", "synthetic-key");
  return { root, oldDirectory, userDataDirectory, safeStorage };
}
async function appearance(directory: string) {
  const store = createWorkbenchAppearancePreferenceStore({ filePath: join(directory, preferenceName) });
  try { return await store.read(); } finally { await store.close(); }
}
async function bytes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, value] of Object.entries(await bytes(join(directory, entry.name)))) result[`${entry.name}/${path}`] = value;
    } else result[entry.name] = (await readFile(join(directory, entry.name))).toString("base64");
  }
  return result;
}

test("first renamed launch restores Light and reads copied keys, without changing the old tree or copying conversations", async () => {
  const f = await fixture();
  await mkdir(join(f.oldDirectory, "workbench-project-host"));
  await writeFile(join(f.oldDirectory, "workbench-project-host", "conversation-sentinel"), "do not touch");
  const before = await bytes(f.oldDirectory);
  const reads: string[] = [];
  const result = await migrateRenamedSettings({ ...f, safeStorage: { ...safeStorage, decryptString(value) {
    reads.push(Buffer.from(value).toString());
    return safeStorage.decryptString(value);
  } } });
  assert.equal((await appearance(f.userDataDirectory)).tone, "light");
  assert.equal(new EndpointSecretEnvelopeStore({ subject, safeStorage, storePath: join(f.userDataDirectory, secretName) }).reveal("glm-coding-plan"), "synthetic-key");
  assert.equal(reads.length, 1, "migration must actually decrypt the copied envelope");
  assert.equal(result?.warning, false);
  assert.match(result!.detail, /Verified 1 copied API key/);
  assert.deepEqual(await bytes(f.oldDirectory), before);
  assert.ok(!(await readdir(f.userDataDirectory)).includes("workbench-project-host"));
});

test("acknowledged migration never restores an old theme or resurrects a removed key", async () => {
  const f = await fixture();
  await (await migrateRenamedSettings(f))!.acknowledge();
  const preferences = createWorkbenchAppearancePreferenceStore({ filePath: join(f.userDataDirectory, preferenceName) });
  await preferences.save(defaultWorkbenchAppearancePreference);
  await preferences.close();
  // Only the new profile is changed, as by Settings' Remove action.
  new EndpointSecretEnvelopeStore({ subject, safeStorage, storePath: join(f.userDataDirectory, secretName) }).remove("glm-coding-plan");
  assert.equal(await migrateRenamedSettings(f), null);
  assert.equal((await appearance(f.userDataDirectory)).tone, "dark");
  assert.deepEqual(new EndpointSecretEnvelopeStore({ subject, safeStorage, storePath: join(f.userDataDirectory, secretName) }).listKeys(), []);
  await unlink(join(f.userDataDirectory, preferenceName));
  assert.equal(await migrateRenamedSettings(f), null);
  assert.equal((await appearance(f.userDataDirectory)).tone, "dark");
});

test("a notice not acknowledged survives restart without another copy", async () => {
  const f = await fixture();
  const first = await migrateRenamedSettings(f);
  const preferences = createWorkbenchAppearancePreferenceStore({ filePath: join(f.userDataDirectory, preferenceName) });
  await preferences.save(defaultWorkbenchAppearancePreference);
  await preferences.close();
  const second = await migrateRenamedSettings(f);
  assert.equal(second?.detail, first?.detail);
  assert.equal((await appearance(f.userDataDirectory)).tone, "dark");
});

test("already-existing current files win, including current keys", async () => {
  const f = await fixture();
  const preferences = createWorkbenchAppearancePreferenceStore({ filePath: join(f.userDataDirectory, preferenceName) });
  await preferences.save(defaultWorkbenchAppearancePreference);
  await preferences.close();
  new EndpointSecretEnvelopeStore({ subject, safeStorage, storePath: join(f.userDataDirectory, secretName) }).upsert("glm-coding-plan", "current-key");
  const before = await bytes(f.userDataDirectory);
  const result = await migrateRenamedSettings(f);
  assert.match(result!.detail, /Kept your current/);
  for (const [name, value] of Object.entries(before)) assert.equal((await bytes(f.userDataDirectory))[name], value);
});

test("failed decryption names the old key location and tells the owner to re-enter, never reports a verified key", async () => {
  const f = await fixture();
  const before = await bytes(f.oldDirectory);
  const result = await migrateRenamedSettings({ ...f, safeStorage: { ...safeStorage, decryptString() { throw new Error("DPAPI cannot decrypt"); } } });
  assert.equal(result?.warning, true);
  assert.ok(result!.detail.includes(join(f.oldDirectory, secretName)));
  assert.match(result!.detail, /Re-enter the affected keys in Settings/);
  assert.doesNotMatch(result!.detail, /Verified \d+ copied/);
  assert.ok(!(await readdir(f.userDataDirectory)).includes(secretName), "an unreadable active store would hide the Settings input");
  assert.deepEqual(await readFile(join(f.userDataDirectory, RENAMED_ENDPOINT_SECRETS_COPY)), await readFile(join(f.oldDirectory, secretName)));
  assert.deepEqual(await bytes(f.oldDirectory), before);
});

test("malformed previous settings are not installed as active files and are explained", async () => {
  const f = await fixture();
  // Seed a corrupt legacy profile before invoking migration.
  await writeFile(join(f.oldDirectory, preferenceName), "broken");
  await writeFile(join(f.oldDirectory, secretName), "broken");
  const before = await bytes(f.oldDirectory);
  const result = await migrateRenamedSettings(f);
  assert.equal(result?.warning, true);
  assert.match(result!.detail, /Re-enter the API keys/);
  assert.deepEqual(await readdir(f.userDataDirectory), [RENAME_SETTINGS_RECEIPT]);
  assert.deepEqual(await bytes(f.oldDirectory), before);
});

test("an unreadable completion record does not silently import again", async () => {
  const f = await fixture();
  await writeFile(join(f.userDataDirectory, RENAME_SETTINGS_RECEIPT), "bad record");
  const result = await migrateRenamedSettings(f);
  assert.equal(result?.warning, true);
  assert.match(result!.detail, /migration record.*could not be read/);
  await result!.acknowledge();
  assert.equal(await readFile(join(f.userDataDirectory, RENAME_SETTINGS_RECEIPT), "utf8"), "bad record");
  assert.equal((await appearance(f.userDataDirectory)).tone, "dark");
});

test("arbitrary isolated profiles do not scan the owner's default settings", async () => {
  const f = await fixture();
  const directory = join(f.root, "isolated-profile");
  assert.equal(await migrateRenamedSettings({ ...f, userDataDirectory: directory }), null);
  assert.ok(!(await readdir(f.root)).includes("isolated-profile"));
});

test("the three reported CLI markers and root configuration copy forward, but native histories and databases do not", async () => {
  const f = await fixture();
  const homes = ["glm-claude-config", "codex-api-codex-home", "kimi-platform-codex-home"];
  for (const home of homes) {
    await mkdir(join(f.oldDirectory, home, "sessions"), { recursive: true });
    await writeFile(join(f.oldDirectory, home, "marker.txt"), home);
    await writeFile(join(f.oldDirectory, home, "config.toml"), "model = 'example'");
    await writeFile(join(f.oldDirectory, home, "sessions", "conversation.jsonl"), "native conversation");
    await writeFile(join(f.oldDirectory, home, "state_5.sqlite"), "native database");
    await writeFile(join(f.oldDirectory, home, "history.jsonl"), "native history");
  }
  const before = await bytes(f.oldDirectory);
  const result = await migrateRenamedSettings({ ...f, cliHomeBaseDirectory: f.root });
  for (const home of homes) {
    assert.equal(await readFile(join(f.userDataDirectory, home, "marker.txt"), "utf8"), home);
    assert.deepEqual((await readdir(join(f.userDataDirectory, home))).sort(), ["config.toml", "marker.txt"]);
  }
  assert.match(result!.detail, /Native sessions, history, databases and other files remain/);
  assert.match(result!.detail, /Previous Codex history will not appear in the new codex-api-codex-home/);
  assert.deepEqual(await bytes(f.oldDirectory), before);
  await result!.acknowledge();
  await writeFile(join(f.userDataDirectory, homes[0]!, "marker.txt"), "new marker");
  assert.equal(await migrateRenamedSettings({ ...f, cliHomeBaseDirectory: f.root }), null);
  assert.equal(await readFile(join(f.userDataDirectory, homes[0]!, "marker.txt"), "utf8"), "new marker");
});

test("CLI homes follow their own APPDATA base even when Electron settings use a different root", async () => {
  const f = await fixture();
  const cliBase = join(f.root, "cli-roaming");
  await mkdir(join(cliBase, "unified-agent-workbench", "glm-claude-config"), { recursive: true });
  await writeFile(join(cliBase, "unified-agent-workbench", "glm-claude-config", "marker.txt"), "separate CLI base");
  await migrateRenamedSettings({ ...f, cliHomeBaseDirectory: cliBase });
  assert.equal(await readFile(join(cliBase, "synchronized-intellect-network", "glm-claude-config", "marker.txt"), "utf8"), "separate CLI base");
  assert.equal((await appearance(f.userDataDirectory)).tone, "light");
  assert.ok(!(await readdir(f.userDataDirectory)).includes("glm-claude-config"));
});

test("production migrates before opening its stores and visibly explains the result with offscreen-safe placement", async () => {
  const source = await readFile(new URL("../../src/workbench-shell/electron/main.ts", import.meta.url), "utf8");
  const migration = source.indexOf("await migrateRenamedSettings({");
  assert.ok(migration > 0 && migration < source.indexOf("appearancePreferenceStore = createWorkbenchAppearancePreferenceStore({"));
  assert.ok(migration < source.indexOf("const glmEndpointSecretEnvelopeStore = new EndpointSecretEnvelopeStore({"));
  assert.match(source, /await presentRenameSettingsNotice\(createdWindow, renameSettingsNotice\)/);
  assert.match(source, /async function presentRenameSettingsNotice[\s\S]*\.\.\.windowPlacementOptions\(\)/);
  assert.match(source, /https:\/\/workbench\.invalid\/acknowledge-rename[\s\S]*notice\.acknowledge\(\)/);
});
