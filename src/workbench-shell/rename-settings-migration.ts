import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createWorkbenchAppearancePreferenceStore } from "./appearance-preference-store.ts";
import { ENDPOINT_SECRET_STORE_FILE_NAME } from "./endpoint-key-source.ts";
import { EndpointSecretEnvelopeStore, type SafeStorageLike } from "./endpoint-secret-envelope-store.ts";

const previousName = "unified-agent-workbench";
const currentName = "synchronized-intellect-network";
const preferenceFile = "workbench-appearance-preferences-v1.json";
export const RENAME_SETTINGS_RECEIPT = "rename-settings-migration-v1.json";
export const RENAMED_ENDPOINT_SECRETS_COPY = "rename-previous-endpoint-secrets.json";
const endpointNames = ["glm-coding-plan", "kimi-code", "deepseek-api", "kimi-platform", "claude-api", "codex-api"];
const cliHomes = ["glm-claude-config", "kimi-claude-config", "deepseek-claude-config", "codex-api-codex-home", "kimi-platform-codex-home"];
// CLI homes also contain native conversation databases. This is a settings-only
// import: root settings and plain-text markers, never recursive home copying.
const cliSettingFiles = new Set(["config.toml", "settings.json", "settings.local.json", ".claude.json", "AGENTS.md", "CLAUDE.md"]);

export interface RenameSettingsNotice {
  readonly detail: string;
  readonly warning: boolean;
  acknowledge(): Promise<void>;
}

interface Receipt {
  version: 1;
  acknowledged: boolean;
  detail: string;
  warning: boolean;
}

/** Settings follow Electron's identity, not the independently anchored conversation root. */
export async function migrateRenamedSettings(options: {
  readonly userDataDirectory: string;
  readonly cliHomeBaseDirectory?: string;
  readonly safeStorage: SafeStorageLike;
}): Promise<RenameSettingsNotice | null> {
  // An arbitrary --user-data-dir must never import the machine owner's settings.
  if (basename(options.userDataDirectory).toLowerCase() !== currentName) return null;
  const sourceDirectory = join(dirname(options.userDataDirectory), previousName);
  const receiptPath = join(options.userDataDirectory, RENAME_SETTINGS_RECEIPT);
  const notice = (receipt: Receipt): RenameSettingsNotice => ({
    detail: receipt.detail,
    warning: receipt.warning,
    async acknowledge() {
      await writeFile(receiptPath, JSON.stringify({ ...receipt, acknowledged: true }), "utf8");
    },
  });
  try {
    const saved = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
    if (saved === null || Object.keys(saved).sort().join(",") !== "acknowledged,detail,version,warning"
      || saved.version !== 1 || typeof saved.acknowledged !== "boolean"
      || typeof saved.detail !== "string" || typeof saved.warning !== "boolean") throw new Error("invalid receipt");
    return saved.acknowledged ? null : notice(saved);
  } catch (error) {
    if (!missing(error)) {
      return {
        warning: true,
        detail: `The product was renamed from ${previousName} to ${currentName}.\n\nThe previous settings remain at ${sourceDirectory}. The migration record at ${receiptPath} could not be read. Nothing was imported or overwritten. Review these locations before manually importing settings or re-entering keys in Settings.`,
        async acknowledge() { /* Do not overwrite an unreadable record. */ },
      };
    }
  }
  const lines: string[] = [];
  let warning = false;
  async function transfer(name: string, validate?: (path: string) => Promise<void>,
    sourceRoot = sourceDirectory, destinationRoot = options.userDataDirectory) {
    const source = join(sourceRoot, name);
    const activeDestination = join(destinationRoot, name);
    const destination = name === ENDPOINT_SECRET_STORE_FILE_NAME
      ? join(destinationRoot, RENAMED_ENDPOINT_SECRETS_COPY)
      : activeDestination;
    let sourceExists = false;
    try {
      const status = await lstat(source);
      sourceExists = true;
      if (!status.isFile()) throw new Error("not a regular settings file");
      try {
        await lstat(activeDestination);
        lines.push(`Kept your current ${name}; the previous copy remains at ${source}.`);
        return;
      } catch (error) { if (!missing(error)) throw error; }
      await validate?.(source);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      lines.push(`Copied ${name}${name === ENDPOINT_SECRET_STORE_FILE_NAME ? ` to ${destination}` : ""}.`);
      if (name === ENDPOINT_SECRET_STORE_FILE_NAME) {
        try {
          let count = 0;
          const knownNames = new Set<string>();
          for (const endpoint of endpointNames) {
            const store = new EndpointSecretEnvelopeStore({
              subject: `workbench://runtime-endpoint/${endpoint}`,
              storePath: destination, safeStorage: options.safeStorage,
            });
            for (const key of store.listKeys()) {
              if (store.reveal(key).length === 0) throw new Error("empty key");
              knownNames.add(key);
              count += 1;
            }
          }
          const document = JSON.parse(await readFile(destination, "utf8"));
          if (knownNames.size !== Object.keys(document.entries).length) throw new Error("unrecognized endpoint subject");
          // An unreadable active store hides the existing Settings key controls.
          // Install only a verified copy; otherwise leave key entry usable and
          // retain both the original and this separate encrypted forward copy.
          await copyFile(destination, activeDestination, constants.COPYFILE_EXCL);
          lines.push(`Verified ${count} copied API key(s) by decrypting the new file on this Windows user account.`);
        } catch {
          warning = true;
          lines.push(`The copied API key(s) could not be decrypted or activated. Your old encrypted keys remain at ${source}, with a forward copy at ${destination}. They were not installed as active keys. Re-enter the affected keys in Settings; no old key was removed.`);
        }
      }
    } catch (error) {
      if (missing(error) && !sourceExists) return;
      warning = true;
      lines.push(`Could not import ${source}. The previous file was not changed. ${name === ENDPOINT_SECRET_STORE_FILE_NAME ? "Re-enter the API keys in Settings." : "Review this location and copy it manually or reset the preference in Settings."}`);
    }
  }
  await transfer(preferenceFile, async path => {
    const store = createWorkbenchAppearancePreferenceStore({ filePath: path });
    try { await store.read(); } finally { await store.close(); }
  });
  await transfer(ENDPOINT_SECRET_STORE_FILE_NAME, async path => {
    // Structural validation only. Decryption is deliberately performed on the COPY.
    new EndpointSecretEnvelopeStore({ subject: `workbench://runtime-endpoint/${endpointNames[0]}`, storePath: path, safeStorage: options.safeStorage });
  });
  if (options.cliHomeBaseDirectory !== undefined) {
    const cliSource = join(options.cliHomeBaseDirectory, previousName);
    const cliDestination = join(options.cliHomeBaseDirectory, currentName);
    for (const home of cliHomes) {
      try {
        const entries = await readdir(join(cliSource, home), { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && (cliSettingFiles.has(entry.name) || entry.name.endsWith(".txt") || entry.name.endsWith(".marker"))) {
            await transfer(join(home, entry.name), undefined, cliSource, cliDestination);
          }
        }
        lines.push(`CLI home ${home}: imported eligible root settings/markers only. Native sessions, history, databases and other files remain at ${join(cliSource, home)}; they were not imported.`);
        if (home.endsWith("codex-home")) {
          lines.push(`Previous Codex history will not appear in the new ${home}. It has not been deleted: it remains in the original CLI home at ${join(cliSource, home)}. This settings import does not reconnect that history.`);
        }
      } catch (error) {
        if (missing(error)) continue;
        warning = true;
        lines.push(`Could not read CLI settings at ${join(cliSource, home)}. The old home is unchanged; review it manually.`);
      }
    }
    if (lines.length > 0) lines.push(`CLI settings destination: ${cliDestination}`);
  }
  const receipt: Receipt = {
    version: 1, acknowledged: lines.length === 0, warning,
    detail: `Unified Agent Workbench is now Synchronized Intellect Network.\n\n${lines.join("\n\n")}\n\nPrevious location: ${sourceDirectory}\nCurrent location: ${options.userDataDirectory}\n\nOnly settings are copied forward. The previous files are left untouched. Existing current settings are never overwritten. Conversation libraries are not migrated here.`,
  };
  try {
    await mkdir(options.userDataDirectory, { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
  } catch {
    receipt.warning = true;
    receipt.acknowledged = false;
    receipt.detail += `\n\nCould not save the migration record at ${receiptPath}. You may see this notice again; current settings will still not be overwritten.`;
  }
  return receipt.acknowledged ? null : notice(receipt);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
