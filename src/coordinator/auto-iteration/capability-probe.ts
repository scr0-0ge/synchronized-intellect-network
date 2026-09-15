import type { Clock } from "./clock.ts";
import type { ContextUsageObservation } from "./contract.ts";
import type { QuotaObservation } from "./quota-pool.ts";

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

/*
 * Production seams from the runtimes to the coordinator authority. The
 * runtimes sit below the composition layer and cannot reach a Project's
 * authority, so they emit through these module-level sinks (the same shape
 * as the Claude diagnostic observer): the backend registers the authority
 * as the sink at wiring time; with no backend the emitters are inert.
 */

export type ContextUsageObservationSink = (
  observation: ContextUsageObservation,
) => void | Promise<void>;

export type QuotaObservationSink = (
  observation: QuotaObservation,
) => void | Promise<void>;

export interface CapabilityProbeSinks {
  readonly contextUsage?: ContextUsageObservationSink;
  readonly quota?: QuotaObservationSink;
}

let contextUsageSink: ContextUsageObservationSink | undefined;
let quotaSink: QuotaObservationSink | undefined;

/** Wires the host authority as the observation sink; `undefined` detaches. */
export function setCapabilityProbeSinks(sinks: CapabilityProbeSinks | undefined): void {
  contextUsageSink = sinks?.contextUsage;
  quotaSink = sinks?.quota;
}

/**
 * Feeds one context observation to the registered sink. Resolves false when
 * no sink is wired; a throwing sink never propagates into the runtime turn.
 */
export async function emitContextUsageObservation(
  observation: ContextUsageObservation,
): Promise<boolean> {
  const sink = contextUsageSink;
  if (sink === undefined) return false;
  try {
    await sink(observation);
  } catch {
    // Telemetry must not fail the turn that produced it.
  }
  return true;
}

/** Feeds one quota observation; same inert-without-sink and never-throw rules. */
export async function emitQuotaObservation(
  observation: QuotaObservation,
): Promise<boolean> {
  const sink = quotaSink;
  if (sink === undefined) return false;
  try {
    await sink(observation);
  } catch {
    // Telemetry must not fail the session start that produced it.
  }
  return true;
}
