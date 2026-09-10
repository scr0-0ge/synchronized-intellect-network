import { isAbsolute, resolve } from "node:path";
import { win32 } from "node:path";

const productDirectoryName = "synchronized-intellect-network";
const projectHostDirectoryName = "workbench-project-host";

export interface ConversationStoreRootOptions {
  readonly platform: NodeJS.Platform;
  readonly roamingAppDataDirectory: string | undefined;
  /**
   * Electron's home path is not retargeted by an AppContainer's Roaming
   * virtualization. Production supplies it so the owner root does not follow
   * a redirected `APPDATA` value.
   */
  readonly windowsUserProfileDirectory?: string;
  readonly electronUserDataDirectory: string;
  /**
   * Present only when the process command line explicitly contains
   * `--user-data-dir`. An implicit OS/container redirection is deliberately not
   * represented here.
   */
  readonly explicitUserDataDirectory?: string;
}

/**
 * Resolves the Workbench-owned conversation store independently from
 * Electron's Chromium profile.
 *
 * Windows agent containers can redirect Electron's Known Folder lookup and
 * therefore `app.getPath("userData")` without changing the owner's physical
 * Roaming path. Ordinary launches anchor the Workbench store to that physical
 * path. A literal `--user-data-dir` remains the one intentional opt-in used by
 * isolated, seeded profiles; it must agree with Electron's resolved path.
 */
export function resolveConversationStoreRoot(
  options: ConversationStoreRootOptions,
): string {
  if (options.platform === "win32") {
    const ownerRoamingDirectory = resolveOwnerRoamingDirectory(options);
    if (options.explicitUserDataDirectory !== undefined) {
      const requested = absoluteWindowsDirectory(
        options.explicitUserDataDirectory,
        "isolated-conversation-store-root-invalid",
      );
      const resolvedByElectron = absoluteWindowsDirectory(
        options.electronUserDataDirectory,
        "isolated-conversation-store-root-invalid",
      );
      if (requested.toLowerCase() !== resolvedByElectron.toLowerCase()) {
        throw new Error("isolated-conversation-store-root-mismatch");
      }
      // Historical identities must not follow a product rename: recovery
      // still discovers these roots, so none is safe for an isolated launch.
      const discoverableProfiles = [
        "Electron",
        productDirectoryName,
        "unified-agent-workbench",
        "Unified Agent Workbench",
      ].map((name) => win32.join(ownerRoamingDirectory, name).toLowerCase());
      if (discoverableProfiles.includes(requested.toLowerCase())) {
        throw new Error("isolated-conversation-store-root-discoverable");
      }
      return win32.join(resolvedByElectron, projectHostDirectoryName);
    }

    return win32.join(
      ownerRoamingDirectory,
      productDirectoryName,
      projectHostDirectoryName,
    );
  }

  if (!isAbsolute(options.electronUserDataDirectory)) {
    throw new Error("canonical-conversation-store-root-unavailable");
  }
  return resolve(options.electronUserDataDirectory, projectHostDirectoryName);
}

function resolveOwnerRoamingDirectory(
  options: ConversationStoreRootOptions,
): string {
  if (options.windowsUserProfileDirectory !== undefined) {
    return win32.join(
      absoluteWindowsDirectory(
        options.windowsUserProfileDirectory,
        "canonical-conversation-store-root-unavailable",
      ),
      "AppData",
      "Roaming",
    );
  }
  if (
    options.roamingAppDataDirectory === undefined ||
    !win32.isAbsolute(options.roamingAppDataDirectory)
  ) {
    throw new Error("canonical-conversation-store-root-unavailable");
  }
  return win32.resolve(options.roamingAppDataDirectory);
}

function absoluteWindowsDirectory(value: string, error: string): string {
  if (typeof value !== "string" || !win32.isAbsolute(value)) {
    throw new Error(error);
  }
  return win32.resolve(value);
}
