// Run after pnpm build. Two separate Electron identities; only synthetic data.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron } from "playwright";
import { createWorkbenchAppearancePreferenceStore } from "../../src/workbench-shell/appearance-preference-store.ts";
import { defaultWorkbenchAppearancePreference } from "../../src/workbench-shell/contract.ts";
import { EndpointSecretEnvelopeStore } from "../../src/workbench-shell/endpoint-secret-envelope-store.ts";
import { GLM_ENDPOINT_KEY_SUBJECT } from "../../src/workbench-shell/glm-endpoint-key.ts";
import { parseSecretEnvelope } from "../../src/workbench-shell/endpoint-secret-envelope-codec.ts";
import { RENAMED_ENDPOINT_SECRETS_COPY } from "../../src/workbench-shell/rename-settings-migration.ts";

const root = await mkdtemp(join(await realpath(tmpdir()), "w69-"));
const oldProfile = join(root, "unified-agent-workbench");
const newProfile = join(root, "synchronized-intellect-network");
const preferenceName = "workbench-appearance-preferences-v1.json";
const secretName = "endpoint-secret-envelope-store.json";
const homes = ["glm-claude-config", "codex-api-codex-home", "kimi-platform-codex-home"];
const evidenceDirectory = resolve(".scratch/unified-ai-workbench/evidence/w69-rename-migration");
await mkdir(evidenceDirectory, { recursive: true });
for (const name of [oldProfile, newProfile, join(root, "home"), join(root, "project")]) {
  await mkdir(name, { recursive: true });
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  value !== undefined && !/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key)
  && !/(ANTHROPIC|CLAUDE|CODEX|OPENAI|GLM|KIMI|MOONSHOT|DEEPSEEK|ZHIPU|API_KEY|AUTH_TOKEN|ACCESS_TOKEN)/i.test(key))) as Record<string, string>;
Object.assign(environment, {
  PATH: `${dirname(process.execPath)};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`,
  HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: root,
  LOCALAPPDATA: join(root, "local"), CODEX_HOME: join(root, "codex"),
  CLAUDE_CONFIG_DIR: join(root, "claude"), W69_APP_DATA: root,
  W69_MAIN: resolve("dist/main/main.js"), GLM_ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
});
async function launch(profile: string, seed: boolean, seedName = "unified-agent-workbench") {
  return _electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as string,
    args: [resolve("tests/e2e/fixtures/rename-migration-bootstrap.mjs"), `--user-data-dir=${profile}`, "--window-placement=offscreen"],
    cwd: join(root, "project"), env: { ...environment, W69_SEED_ONLY: seed ? "1" : "0", W69_SEED_NAME: seedName }, timeout: 30000,
  });
}
const secret = "w69-synthetic-not-a-provider-key";
const seed = await launch(oldProfile, true);
let ciphertext: number[];
try {
  ciphertext = await seed.evaluate(({ app, safeStorage }, value) => {
    if (app.getName() !== "unified-agent-workbench" || !safeStorage.isEncryptionAvailable()) throw new Error("seed encryption unavailable");
    const encrypted = safeStorage.encryptString(value);
    if (safeStorage.decryptString(encrypted) !== value) throw new Error("seed round-trip failed");
    return [...encrypted];
  }, secret);
} finally { await seed.close(); }
// Control: a separate new-identity process can decrypt when it receives a COPY
// of the old Chromium Local State. Never launch against the source again.
const controlProfile = join(root, "crypto-control");
await mkdir(controlProfile);
await copyFile(join(oldProfile, "Local State"), join(controlProfile, "Local State"));
const control = await launch(controlProfile, true, "synchronized-intellect-network");
try {
  const decoded = await control.evaluate(({ safeStorage }, { ciphertext, secret }) =>
    safeStorage.decryptString(Buffer.from(ciphertext)) === secret, { ciphertext, secret });
  console.log(JSON.stringify({ controlWithCopiedLocalStateDecrypts: decoded }));
  assert.equal(decoded, true);
} finally { await control.close(); }
const oldPreferences = createWorkbenchAppearancePreferenceStore({ filePath: join(oldProfile, preferenceName) });
await oldPreferences.save({ ...defaultWorkbenchAppearancePreference, tone: "light" });
await oldPreferences.close();
new EndpointSecretEnvelopeStore({
  subject: GLM_ENDPOINT_KEY_SUBJECT, storePath: join(oldProfile, secretName),
  safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.from(ciphertext), decryptString: () => { throw new Error("only Electron may decrypt"); } },
}).upsert("glm-coding-plan", secret);
for (const home of homes) {
  await mkdir(join(oldProfile, home));
  await writeFile(join(oldProfile, home, "w69-marker.txt"), home);
}
async function bytes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await bytes(join(directory, entry.name)))) result[`${entry.name}/${name}`] = value;
    } else result[entry.name] = (await readFile(join(directory, entry.name))).toString("base64");
  }
  return result;
}
const before = await bytes(oldProfile);
const application = await launch(newProfile, false);
try {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // The notice is a production BrowserWindow, including in an offscreen launch.
  await page.waitForFunction(() => !!window.workbench);
  const noticePage = application.windows().find(candidate => candidate !== page)
    ?? await application.waitForEvent("window", { timeout: 1500 }).catch(() => null);
  const notices: string[] = [];
  if (noticePage !== null) {
    await noticePage.waitForLoadState("domcontentloaded");
    notices.push(await noticePage.locator("body").innerText());
    const capture = await application.evaluate(async ({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.getTitle() === "Your settings after the rename")!;
      const bounds = window.getBounds();
      if (window.isFocused() || window.isFocusable()) throw new Error("notice can take focus");
      for (const { bounds: display } of screen.getAllDisplays()) {
        if (!(bounds.x + bounds.width <= display.x || bounds.x >= display.x + display.width || bounds.y + bounds.height <= display.y || bounds.y >= display.y + display.height)) throw new Error("notice overlaps a physical display");
      }
      const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      return { png: image.toPNG().toString("base64"), bounds, focusable: window.isFocusable(), focused: window.isFocused() };
    });
    console.log(JSON.stringify({ noticeSafety: { bounds: capture.bounds, focusable: capture.focusable, focused: capture.focused } }));
    await writeFile(join(evidenceDirectory, "rename-notice.png"), Buffer.from(capture.png, "base64"));
    await noticePage.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).waitFor();
  const state = {
    root,
    lightPressed: await page.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"),
    notices,
    markers: await Promise.all(homes.map(async home => readFile(join(newProfile, home, "w69-marker.txt"), "utf8").catch(() => null))),
    copiedKeyDecrypts: false,
    copiedEnvelopeBytesIdentical: false,
    oldBytesUnchanged: JSON.stringify(await bytes(oldProfile)) === JSON.stringify(before),
  };
  const document = await readFile(join(newProfile, RENAMED_ENDPOINT_SECRETS_COPY), "utf8")
    .catch(() => readFile(join(newProfile, secretName), "utf8").catch(() => null));
  if (document !== null) {
    state.copiedEnvelopeBytesIdentical = document === await readFile(join(oldProfile, secretName), "utf8");
    const encrypted = parseSecretEnvelope(JSON.parse(document).entries["glm-coding-plan"]).ciphertext;
    state.copiedKeyDecrypts = await application.evaluate(({ safeStorage }, { encrypted, secret }) => {
      try { return safeStorage.decryptString(Buffer.from(encrypted)) === secret; } catch { return false; }
    }, { encrypted: [...encrypted], secret });
  }
  console.log(JSON.stringify(state, null, 2));
  assert.equal(state.lightPressed, "true");
  // The work order explicitly permits re-entry when a copied key cannot decrypt.
  // Windows Electron 37 uses a profile-local Chromium key, not DPAPI directly.
  assert.equal(state.copiedKeyDecrypts, false);
  assert.equal(state.copiedEnvelopeBytesIdentical, true);
  assert.match(notices.join("\n"), /copied API key\(s\) could not be decrypted/);
  assert.ok(notices.join("\n").includes(join(oldProfile, secretName)));
  assert.match(notices.join("\n"), /Re-enter the affected keys in Settings/);
  assert.match(notices.join("\n"), /Previous Codex history will not appear in the new codex-api-codex-home/);
  assert.match(notices.join("\n"), /Previous Codex history will not appear in the new kimi-platform-codex-home/);
  assert.deepEqual(state.markers, homes);
  assert.equal(state.oldBytesUnchanged, true);
  assert.ok(state.notices.length > 0, "rename must be explained to the owner");
  const safety = await application.evaluate(({ BrowserWindow, screen }) => ({
    windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), focusable: window.isFocusable(), focused: window.isFocused() })),
    displays: screen.getAllDisplays().map(display => display.bounds),
    versions: process.versions,
  }));
  for (const window of safety.windows) {
    assert.equal(window.focusable, false);
    assert.equal(window.focused, false);
    for (const display of safety.displays) assert.ok(window.bounds.x + window.bounds.width <= display.x || window.bounds.x >= display.x + display.width || window.bounds.y + window.bounds.height <= display.y || window.bounds.y >= display.y + display.height);
  }
  // Do not bypass the owner-facing input: an unreadable active store can hide it
  // even though calling saveEndpointKey directly through IPC would succeed.
  const keyInput = page.locator("#endpoint-key-input-glm-coding-plan");
  await keyInput.waitFor({ state: "visible", timeout: 5000 });
  await keyInput.fill(secret);
  await keyInput.locator("..").locator("..").getByRole("button", { name: "Save key", exact: true }).click();
  await page.waitForFunction(async () => {
    const status = await window.workbench.loadEndpointKeyStatus!("glm-coding-plan");
    return status.ok && status.snapshot.configured;
  });
  const revealed = await page.evaluate(() => window.workbench.revealEndpointKey!("glm-coding-plan"));
  assert.equal(revealed.ok, true);
  if (!revealed.ok) throw new Error("key reveal failed");
  assert.equal(revealed.status, "revealed");
  if (revealed.status === "revealed") assert.equal(revealed.value, secret);
  await page.evaluate(preference => window.workbench.saveAppearancePreference(preference), defaultWorkbenchAppearancePreference);
  console.log(JSON.stringify({ reenteredKeyWorks: true, safety }));
} finally { await application.close(); }
const restart = await launch(newProfile, false);
try {
  const page = await restart.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Dark", exact: true }).getAttribute("aria-pressed"), "true");
  const revealed = await page.evaluate(() => window.workbench.revealEndpointKey!("glm-coding-plan"));
  assert.equal(revealed.ok, true);
  if (!revealed.ok) throw new Error("restarted key reveal failed");
  assert.equal(revealed.status, "revealed");
  if (revealed.status === "revealed") assert.equal(revealed.value, secret);
  assert.equal(restart.windows().length, 1, "acknowledged notice must not reappear");
  assert.deepEqual(await bytes(oldProfile), before);
  console.log(JSON.stringify({ restartKeptNewDark: true, restartKeptReenteredKey: true, noticeRepeated: false, oldBytesUnchanged: true }));
} finally { await restart.close(); }
