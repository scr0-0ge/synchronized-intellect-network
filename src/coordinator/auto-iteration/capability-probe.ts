import type { Clock } from "./clock.ts";

export type CapabilityState = "available" | "unavailable" | "unknown";

export interface CliCapabilityVersions {
  readonly claude: string;
  readonly codex: string;
}

export interface CliCapabilityTable {
  readonly claudeContextUsage: CapabilityState;
  readonly codexRateLimits: CapabilityState;
  readonly claudeEffortEcho: CapabilityState;
  readonly codexEffortEcho: CapabilityState;
}

export interface CliCapabilitySnapshot {
  readonly schemaVersion: 1;
  readonly observedAt: number;
  readonly cliVersions: CliCapabilityVersions;
  readonly capabilities: CliCapabilityTable;
}

export interface CapabilityProbeStore {
  load(): Promise<CliCapabilitySnapshot | undefined>;
  save(snapshot: CliCapabilitySnapshot): Promise<void>;
}

export interface CliCapabilityProbes {
  readonly claudeContextUsage: () => Promise<CapabilityState>;
  readonly codexRateLimits: () => Promise<CapabilityState>;
  readonly claudeEffortEcho: () => Promise<CapabilityState>;
  readonly codexEffortEcho: () => Promise<CapabilityState>;
}

export interface ProbeCliCapabilitiesOptions {
  readonly clock: Clock;
  readonly store: CapabilityProbeStore;
  readonly versions: CliCapabilityVersions;
  readonly probes: CliCapabilityProbes;
}

function sameVersions(
  left: CliCapabilityVersions,
  right: CliCapabilityVersions,
): boolean {
  return left.claude === right.claude && left.codex === right.codex;
}

async function runProbe(probe: () => Promise<CapabilityState>): Promise<CapabilityState> {
  try {
    return await probe();
  } catch {
    return "unknown";
  }
}

/** Probes once per exact Claude/Codex version pair and persists the four facts. */
export async function probeCliCapabilities(
  options: ProbeCliCapabilitiesOptions,
): Promise<CliCapabilitySnapshot> {
  const existing = await options.store.load();
  if (existing !== undefined && sameVersions(existing.cliVersions, options.versions)) {
    return existing;
  }

  const capabilities: CliCapabilityTable = Object.freeze({
    claudeContextUsage: await runProbe(options.probes.claudeContextUsage),
    codexRateLimits: await runProbe(options.probes.codexRateLimits),
    claudeEffortEcho: await runProbe(options.probes.claudeEffortEcho),
    codexEffortEcho: await runProbe(options.probes.codexEffortEcho),
  });
  const snapshot: CliCapabilitySnapshot = Object.freeze({
    schemaVersion: 1,
    observedAt: options.clock.now(),
    cliVersions: Object.freeze({ ...options.versions }),
    capabilities,
  });
  await options.store.save(snapshot);
  return snapshot;
}
