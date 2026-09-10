import type { WorkbenchRuntimeEndpointId } from "./contract.ts";

/**
 * Canonical runtime endpoint registration roster, in registration order.
 *
 * This is the single data structure that defines which Agent Runtime
 * endpoints the Workbench shell admits and the order they are presented in
 * (discovery statuses enumerate this roster; endpoint catalogs must follow
 * its relative order). Appending a new endpoint is a data change here (plus
 * the matching `WorkbenchRuntimeEndpointId` union member), not a diff across
 * the shell's validators.
 */
export const WORKBENCH_RUNTIME_ENDPOINT_IDS: readonly WorkbenchRuntimeEndpointId[] =
  Object.freeze([
    "codex-desktop",
    "claude-code-desktop",
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
    "kimi-platform",
    "claude-api",
    "codex-api",
  ]);

/**
 * Membership predicate for a registered endpoint id. `endpointIds` lets a
 * caller (composition root, tests) widen the roster beyond the canonical
 * production list; every validator that admits endpoints takes its roster
 * from this parameter so the admission rule stays data-driven.
 */
export function isRegisteredRuntimeEndpointId(
  value: unknown,
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
): value is WorkbenchRuntimeEndpointId {
  return (
    typeof value === "string" &&
    endpointIds.includes(value as WorkbenchRuntimeEndpointId)
  );
}

/**
 * Registration ordinal of an endpoint id (`-1` when unregistered). Endpoint
 * ordering rules ("an endpoint never precedes an earlier-registered one")
 * resolve through this lookup instead of hard-coded positions.
 */
export function runtimeEndpointOrdinal(
  endpointId: string,
  endpointIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
): number {
  return endpointIds.indexOf(endpointId as WorkbenchRuntimeEndpointId);
}

/**
 * Roster-order coherence for an endpoint id list: dense input with unique,
 * registered ids whose ordinals strictly increase. This generalizes the
 * former "claude never precedes codex" rule to any roster size.
 */
export function areRegisteredEndpointIdsInOrder(
  endpointIds: readonly unknown[],
  registeredIds: readonly WorkbenchRuntimeEndpointId[] = WORKBENCH_RUNTIME_ENDPOINT_IDS,
): endpointIds is readonly WorkbenchRuntimeEndpointId[] {
  const seen = new Set<WorkbenchRuntimeEndpointId>();
  let previousOrdinal = -1;
  for (const endpointId of endpointIds) {
    if (!isRegisteredRuntimeEndpointId(endpointId, registeredIds)) {
      return false;
    }
    if (seen.has(endpointId)) {
      return false;
    }
    const ordinal = runtimeEndpointOrdinal(endpointId, registeredIds);
    if (ordinal <= previousOrdinal) {
      return false;
    }
    previousOrdinal = ordinal;
    seen.add(endpointId);
  }
  return true;
}
