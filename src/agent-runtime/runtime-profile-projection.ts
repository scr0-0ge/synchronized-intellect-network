import type { SessionProfile } from "./index.ts";

const claudeDesktopEndpointId = "claude-code-desktop";
const ordinaryExecutionMode = "single-agent";
const ultracodeExecutionMode = "ultracode";
const ultracodeNativeEffort = "xhigh";

/**
 * Keep locked public modes equal, with one deliberately narrow exception:
 * Claude's displayed ultracode intensity resolves privately to xhigh plus the
 * CLI's separate workflow mode. No other execution-mode projection is valid.
 */
export function runtimeProfileProjectionPreservesLockedModes(
  endpointId: string,
  selectionProfile: SessionProfile,
  nativeProfile: SessionProfile,
): boolean {
  if (nativeProfile.accessMode !== selectionProfile.accessMode) return false;
  if (nativeProfile.executionMode === selectionProfile.executionMode) {
    return true;
  }
  return isClaudeUltracodeRuntimeProfileProjection(
    endpointId,
    selectionProfile,
    nativeProfile,
  );
}

export function isClaudeUltracodeRuntimeProfileProjection(
  endpointId: string,
  selectionProfile: SessionProfile,
  nativeProfile: SessionProfile,
): boolean {
  return (
    endpointId === claudeDesktopEndpointId &&
    selectionProfile.executionMode === ordinaryExecutionMode &&
    nativeProfile.executionMode === ultracodeExecutionMode &&
    nativeProfile.effortLevel === ultracodeNativeEffort &&
    nativeProfile.accessMode === selectionProfile.accessMode
  );
}
