import type { DurableRuntimeEndpointId } from "../work-ledger-auth-generation.ts";
import type { QuotaPool } from "./contract.ts";
import type { Clock } from "./clock.ts";

export type QuotaObservationSource =
  | "codex-account:account/rateLimits/read"
  | "claude-account:runtime";

export interface QuotaWindowObservation {
  readonly name: string;
  readonly usedFraction: number | null;
  readonly resetsAt: number | null;
  readonly windowDurationMinutes: number | null;
}

export type QuotaObservation = Readonly<{
  quotaPoolId: string;
  source: QuotaObservationSource;
  observedAt: number;
  status: "observed" | "unknown";
  windows: readonly QuotaWindowObservation[];
}>;

export interface QuotaPoolDefinition {
  readonly quotaPoolId: string;
  readonly accountScopeKey: string;
  readonly endpointIds: readonly DurableRuntimeEndpointId[];
  readonly version: number;
}

export interface QuotaPoolRegistry {
  bindSession(sessionId: string, endpointId: DurableRuntimeEndpointId): void;
  poolForEndpoint(endpointId: DurableRuntimeEndpointId): QuotaPool | undefined;
  poolForSession(sessionId: string): QuotaPool | undefined;
  get(quotaPoolId: string): QuotaPool | undefined;
  latestObservation(quotaPoolId: string): QuotaObservation | undefined;
  record(observation: QuotaObservation): void;
  markAvailable(quotaPoolId: string): void;
  markWaitingForQuota(quotaPoolId: string, resetsAt: number | null): void;
  canReprobe(quotaPoolId: string): boolean;
}

function freezePool(
  definition: QuotaPoolDefinition,
  status: "available" | "unknown" | "waiting-for-quota",
  version: number = definition.version,
  resetsAt?: number | null,
): QuotaPool {
  const base = {
    quotaPoolId: definition.quotaPoolId,
    accountScopeKey: definition.accountScopeKey,
    endpointIds: Object.freeze([...definition.endpointIds]),
    version,
  };
  return status === "waiting-for-quota"
    ? Object.freeze({ ...base, status, resetsAt: resetsAt ?? null })
    : Object.freeze({ ...base, status });
}

/**
 * Issue #8 M2: the production endpoint-to-pool assignment. Each endpoint is
 * its own account today (no two endpoints share a subscription), so the map
 * is 1:1; a future shared subscription becomes a data change here, not a
 * call-site change. `Record` over the full `DurableRuntimeEndpointId` union
 * keeps this exhaustive at compile time.
 */
const PRODUCTION_ENDPOINT_QUOTA_POOL_IDS: Readonly<
  Record<DurableRuntimeEndpointId, string>
> = Object.freeze({
  "codex-desktop": "codex-account:codex",
  "codex-api": "codex-account:codex-api",
  "claude-code-desktop": "claude-account:claude",
  "claude-api": "claude-account:claude-api",
  "glm-coding-plan": "glm-account:glm",
  "kimi-code": "kimi-account:kimi-code",
  "kimi-platform": "kimi-account:kimi-platform",
  "deepseek-api": "deepseek-account:deepseek",
});

/** The pool a durable endpoint id draws quota from in production. */
export function productionQuotaPoolId(endpointId: DurableRuntimeEndpointId): string {
  return PRODUCTION_ENDPOINT_QUOTA_POOL_IDS[endpointId];
}

/**
 * Keeps account ownership separate from Session identity. Sessions on endpoints
 * backed by the same subscription resolve to one pool; API-key endpoints use a
 * different definition and therefore never borrow that subscription window.
 */
export function createQuotaPoolRegistry(
  clock: Clock,
  definitions: readonly QuotaPoolDefinition[],
): QuotaPoolRegistry {
  const definitionById = new Map<string, QuotaPoolDefinition>();
  const poolById = new Map<string, QuotaPool>();
  const poolIdByEndpoint = new Map<DurableRuntimeEndpointId, string>();
  const poolIdBySession = new Map<string, string>();
  const observationByPool = new Map<string, QuotaObservation>();

  for (const value of definitions) {
    if (
      value.quotaPoolId.length === 0 ||
      value.accountScopeKey.length === 0 ||
      value.endpointIds.length === 0 ||
      definitionById.has(value.quotaPoolId)
    ) {
      throw new Error("invalid-quota-pool-definition");
    }
    for (const endpointId of value.endpointIds) {
      if (poolIdByEndpoint.has(endpointId)) {
        throw new Error("quota-endpoint-already-mapped");
      }
      poolIdByEndpoint.set(endpointId, value.quotaPoolId);
    }
    const definition = Object.freeze({
      ...value,
      endpointIds: Object.freeze([...value.endpointIds]),
    });
    definitionById.set(value.quotaPoolId, definition);
    poolById.set(value.quotaPoolId, freezePool(definition, "unknown"));
  }

  function requireDefinition(quotaPoolId: string): QuotaPoolDefinition {
    const definition = definitionById.get(quotaPoolId);
    if (definition === undefined) throw new Error("quota-pool-not-found");
    return definition;
  }

  const registry: QuotaPoolRegistry = {
    bindSession(sessionId, endpointId): void {
      if (sessionId.length === 0) throw new Error("invalid-session-id");
      const poolId = poolIdByEndpoint.get(endpointId);
      if (poolId === undefined) throw new Error("quota-endpoint-not-mapped");
      poolIdBySession.set(sessionId, poolId);
    },
    poolForEndpoint(endpointId): QuotaPool | undefined {
      const poolId = poolIdByEndpoint.get(endpointId);
      return poolId === undefined ? undefined : poolById.get(poolId);
    },
    poolForSession(sessionId): QuotaPool | undefined {
      const poolId = poolIdBySession.get(sessionId);
      return poolId === undefined ? undefined : poolById.get(poolId);
    },
    get(quotaPoolId): QuotaPool | undefined {
      return poolById.get(quotaPoolId);
    },
    latestObservation(quotaPoolId): QuotaObservation | undefined {
      return observationByPool.get(quotaPoolId);
    },
    record(observation): void {
      requireDefinition(observation.quotaPoolId);
      observationByPool.set(observation.quotaPoolId, observation);
    },
    markAvailable(quotaPoolId): void {
      const definition = requireDefinition(quotaPoolId);
      const current = poolById.get(quotaPoolId)!;
      poolById.set(
        quotaPoolId,
        freezePool(definition, "available", current.version + 1),
      );
    },
    markWaitingForQuota(quotaPoolId, resetsAt): void {
      if (resetsAt !== null && (!Number.isSafeInteger(resetsAt) || resetsAt < 0)) {
        throw new Error("invalid-quota-reset");
      }
      const definition = requireDefinition(quotaPoolId);
      const current = poolById.get(quotaPoolId)!;
      poolById.set(
        quotaPoolId,
        freezePool(
          definition,
          "waiting-for-quota",
          current.version + 1,
          resetsAt,
        ),
      );
    },
    canReprobe(quotaPoolId): boolean {
      const pool = poolById.get(quotaPoolId);
      if (pool === undefined) throw new Error("quota-pool-not-found");
      if (pool.status === "unknown") return true;
      return pool.status === "waiting-for-quota" &&
        pool.resetsAt !== null &&
        clock.now() >= pool.resetsAt;
    },
  };
  return Object.freeze(registry);
}
