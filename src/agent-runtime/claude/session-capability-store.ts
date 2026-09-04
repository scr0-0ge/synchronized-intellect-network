import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ClaudeSessionCapabilityStore,
  PersistedClaudeSessionCapability,
} from "./adapter.ts";

const storeVersion = 1;

/**
 * The production home of Claude resume capabilities (F220): one JSON file
 * under the main process's conversation-store root, beside the project
 * ledgers. It exists so an app restart does not orphan every Claude Session —
 * `resume` still reads only the adapter's in-memory Map; this file is how the
 * Map survives the process.
 *
 * The file carries the native session identity, so it lives where the ledgers
 * live: main-process-private, never handed to the renderer, never part of a
 * snapshot or history read. Failure posture is degrade-not-fail in both
 * directions — an unreadable or malformed file loads as empty (exactly the
 * pre-store behaviour), and a failed write never fails the turn that observed
 * the identity. Writes go through a sibling temp file and an atomic rename so
 * a crash mid-write leaves the previous generation, not half a file.
 */
export function createFileClaudeSessionCapabilityStore(
  filePath: string,
): ClaudeSessionCapabilityStore {
  const capabilities = new Map<string, PersistedClaudeSessionCapability>();
  let loaded = false;
  return {
    load(): ReadonlyMap<string, PersistedClaudeSessionCapability> {
      if (!loaded) {
        loaded = true;
        for (const [reference, capability] of readStoredCapabilities(filePath)) {
          capabilities.set(reference, capability);
        }
      }
      return new Map(capabilities);
    },
    save(
      opaqueSessionReference: string,
      capability: PersistedClaudeSessionCapability,
    ): void {
      capabilities.set(opaqueSessionReference, {
        projectDirectory: capability.projectDirectory,
        profile: { ...capability.profile },
        permissionMode: capability.permissionMode,
        sessionIdentity: capability.sessionIdentity,
      });
      const serialized = JSON.stringify(
        {
          version: storeVersion,
          capabilities: Object.fromEntries(capabilities),
        },
        undefined,
        2,
      );
      mkdirSync(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, filePath);
    },
  };
}

function readStoredCapabilities(
  filePath: string,
): ReadonlyMap<string, PersistedClaudeSessionCapability> {
  const capabilities = new Map<string, PersistedClaudeSessionCapability>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return capabilities;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== storeVersion
  ) {
    return capabilities;
  }
  const entries = (parsed as Record<string, unknown>).capabilities;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    return capabilities;
  }
  for (const [reference, value] of Object.entries(entries)) {
    const capability = readStoredCapability(value);
    if (capability !== undefined) capabilities.set(reference, capability);
  }
  return capabilities;
}

function readStoredCapability(
  value: unknown,
): PersistedClaudeSessionCapability | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const profile = record.profile;
  if (typeof profile !== "object" || profile === null) return undefined;
  const profileRecord = profile as Record<string, unknown>;
  if (
    typeof record.projectDirectory !== "string" ||
    typeof record.sessionIdentity !== "string" ||
    record.sessionIdentity.length === 0 ||
    (record.permissionMode !== "bypassPermissions" &&
      record.permissionMode !== "manual") ||
    typeof profileRecord.model !== "string" ||
    typeof profileRecord.effortLevel !== "string" ||
    typeof profileRecord.executionMode !== "string" ||
    typeof profileRecord.accessMode !== "string"
  ) {
    return undefined;
  }
  return {
    projectDirectory: record.projectDirectory,
    profile: {
      model: profileRecord.model,
      effortLevel: profileRecord.effortLevel,
      executionMode: profileRecord.executionMode,
      accessMode: profileRecord.accessMode,
    },
    permissionMode: record.permissionMode,
    sessionIdentity: record.sessionIdentity,
  };
}
