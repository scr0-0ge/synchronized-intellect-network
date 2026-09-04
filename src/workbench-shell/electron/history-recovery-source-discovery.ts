import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  HistoryRecoverySourceCandidate,
  HistoryRecoverySourceDiscovery,
} from "../history-recovery.ts";

const hostDirectoryName = "workbench-project-host";

/**
 * The provider set is intentionally closed. It covers the fixed named root,
 * Electron's historical fallback identity, and the packaged product identity.
 * It never enumerates an app-data parent or accepts a renderer-provided path.
 */
export function createProductionHistoryRecoverySourceDiscovery(options: {
  readonly appDataDirectory: string;
  readonly currentUserDataDirectory: string;
}): HistoryRecoverySourceDiscovery {
  const appDataDirectory = absoluteDirectory(options.appDataDirectory);
  const currentUserDataDirectory = absoluteDirectory(
    options.currentUserDataDirectory,
  );
  requireContained(appDataDirectory, currentUserDataDirectory);
  const candidates: readonly HistoryRecoverySourceCandidate[] = Object.freeze([
    Object.freeze({
      providerClass: "fixed-name-current",
      role: "current" as const,
      rootPath: join(currentUserDataDirectory, hostDirectoryName),
    }),
    Object.freeze({
      providerClass: "legacy-electron-default",
      role: "historical" as const,
      rootPath: join(appDataDirectory, "Electron", hostDirectoryName),
    }),
    Object.freeze({
      providerClass: "legacy-package-name",
      role: "historical" as const,
      rootPath: join(
        appDataDirectory,
        "unified-agent-workbench",
        hostDirectoryName,
      ),
    }),
    Object.freeze({
      providerClass: "legacy-packaged-product",
      role: "historical" as const,
      rootPath: join(
        appDataDirectory,
        "Unified Agent Workbench",
        hostDirectoryName,
      ),
    }),
  ]);
  return Object.freeze({
    async discover(): Promise<readonly HistoryRecoverySourceCandidate[]> {
      return candidates;
    },
  });
}

/**
 * The same closed provider set and the same root validation, with the failure
 * moved off the startup path.
 *
 * `createProductionHistoryRecoverySourceDiscovery` validates its roots while it
 * is being constructed, and production constructs it inside `app.whenReady()`
 * before any window exists — so a rejected root took the whole application down
 * before it had a window, leaving a process the user could neither see nor quit
 * (`F117`). Deferring construction to `discover()` puts the identical rejection
 * inside the recovery library's own preparation guard, which already converts
 * any preparation failure into the `unavailable` terminal status.
 *
 * This deliberately does NOT widen the guard. A rejected root still yields no
 * candidates at all; recovery stays closed and the rest of the app still starts.
 *
 * The app-data root is read through a thunk for the same reason. Resolving it can
 * itself throw — Electron raises `Failed to get 'appData' path` when the directory
 * does not exist — and that read is only ever needed to enumerate *historical*
 * sources. The current user-data root is supplied directly and does not depend on
 * it, so an unresolvable app-data root costs recovery and nothing else.
 */
export function createDeferredProductionHistoryRecoverySourceDiscovery(options: {
  readonly readAppDataDirectory: () => string;
  readonly currentUserDataDirectory: string;
}): HistoryRecoverySourceDiscovery {
  return Object.freeze({
    async discover(): Promise<readonly HistoryRecoverySourceCandidate[]> {
      return createProductionHistoryRecoverySourceDiscovery({
        appDataDirectory: options.readAppDataDirectory(),
        currentUserDataDirectory: options.currentUserDataDirectory,
      }).discover();
    },
  });
}

function absoluteDirectory(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("invalid-history-recovery-root");
  }
  return resolve(value);
}

function requireContained(parent: string, child: string): void {
  const path = relative(parent, child);
  if (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  ) {
    return;
  }
  throw new Error("invalid-history-recovery-root");
}
