import { dirname, join } from "node:path";
import * as nodeFs from "node:fs";

import { GLM_MODEL_IDS } from "../agent-runtime/claude/glm-catalog.ts";
import { KIMI_MODEL_IDS } from "../agent-runtime/claude/kimi-catalog.ts";
import { DEEPSEEK_MODEL_IDS } from "../agent-runtime/claude/deepseek-catalog.ts";
import {
  fetchEndpointModelsList,
  findNewEndpointModelIds,
  type EndpointModelsListEntry,
  type EndpointModelsListFaceId,
} from "./endpoint-models-list.ts";
import type { RuntimeModel } from "../agent-runtime/index.ts";

/**
 * Catalog freshness for the static-key endpoints (ticket 14, wired WO16
 * Part 3). The static catalogs are hand-curated; providers add models
 * without notice. This service keeps them fresh WITHOUT burning tokens:
 *
 * 1. A zero-inference `GET /models` pull (the endpoint-models-list module)
 *    at app startup (background, silent) and on the Settings manual refresh.
 * 2. Diff against the static catalog's ids (both sides normalized by the
 *    CLI-side context-window variant suffix "[1m]").
 * 3. New ids surface in Settings ("N new models available") AND enroll
 *    conservatively: only bare, shape-valid base ids, effort pinned to the
 *    single safe `default` tier, full tier curation left to the lane. The
 *    enrollment is persisted (a session started on an enrolled model must
 *    survive an offline restart), and marked "new (untiered)" on the
 *    Settings surface.
 * 4. Every failure path degrades silently (offline, changed endpoint, auth
 *    refused): the static catalog stays authoritative and no error surface
 *    is disturbed. This pull is free, so adjudication (a) (which bans
 *    token-burning probes from discovery) is not implicated.
 *
 * Model-identity honesty: an enrolled id is exactly what /models returned
 * (bare, no "[1m]" suffix). Whether a provider accepts a bare id through
 * the alias-injection path is a live-acceptance question (ticket 14 §3),
 * not something this module can prove.
 */

export type EndpointCatalogFreshnessEndpointId =
  | "glm-coding-plan"
  | "kimi-code"
  | "deepseek-api";

export const ENDPOINT_CATALOG_FRESHNESS_STORE_FILE_NAME =
  "endpoint-catalog-freshness-v1.json";

/** The single effort tier auto-enrolled models carry (design ruling 2). */
export const ENDPOINT_CATALOG_FRESHNESS_ENROLLED_EFFORT_LEVEL =
  "default" as const;

export interface EndpointCatalogFreshnessModelEntry {
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: string;
}

export interface EndpointCatalogFreshnessReport {
  readonly endpointId: EndpointCatalogFreshnessEndpointId;
  /** "fresh" when the last pull succeeded (even with zero new models). */
  readonly status: "fresh" | "silent-failure";
  /** Models this pull found that neither the static catalog nor the
   * enrolled set knew — the "N new models available" list. */
  readonly newModels: readonly EndpointCatalogFreshnessModelEntry[];
  /** Everything enrolled so far (superset across pulls), marker-bearing on
   * the Settings surface ("new (untiered)"). */
  readonly enrolledModels: readonly EndpointCatalogFreshnessModelEntry[];
}

export interface EndpointCatalogFreshnessEndpointConfiguration {
  readonly endpointId: EndpointCatalogFreshnessEndpointId;
  readonly face: EndpointModelsListFaceId;
  /** Base URL for the pull; defaults to the face's documented base. */
  readonly resolveBaseUrl?: (environment: NodeJS.ProcessEnv) => string;
  /** Static catalog ids (suffixed ids fine — both sides are normalized). */
  readonly staticCatalogModelIds: readonly string[];
  /** Token source: store first, env fallback (the endpoint key source). */
  readonly resolveToken: () => string | undefined;
}

export interface EndpointCatalogFreshnessServiceOptions {
  readonly endpoints: readonly EndpointCatalogFreshnessEndpointConfiguration[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  /** Persistence file; defaults beside the app's other stores. */
  readonly storeDirectory?: string;
  readonly readFile?: (path: string) => string;
  readonly writeFile?: (path: string, text: string) => void;
}

export interface EndpointCatalogFreshnessService {
  /** One pull across every configured endpoint; failures are per-endpoint. */
  refresh(): Promise<readonly EndpointCatalogFreshnessReport[]>;
  /** Persisted enrollment as adapter-ready catalog models. */
  augmentedModels(
    endpointId: EndpointCatalogFreshnessEndpointId,
  ): readonly RuntimeModel[];
  /** Persisted enrollment ids (bare). */
  enrolledModelIds(
    endpointId: EndpointCatalogFreshnessEndpointId,
  ): readonly string[];
}

interface StoredEnrollment {
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: string;
  readonly enrolledAt: string;
}

interface StoreContents {
  readonly schemaVersion: 1;
  readonly endpoints: Readonly<
    Record<string, readonly StoredEnrollment[]>
  >;
}

const STATIC_CATALOG_IDS: Readonly<
  Record<EndpointCatalogFreshnessEndpointId, readonly string[]>
> = Object.freeze({
  "glm-coding-plan": GLM_MODEL_IDS,
  "kimi-code": KIMI_MODEL_IDS,
  "deepseek-api": DEEPSEEK_MODEL_IDS,
});

export function endpointCatalogFreshnessStorePath(
  userDataDirectory: string,
): string {
  return join(userDataDirectory, ENDPOINT_CATALOG_FRESHNESS_STORE_FILE_NAME);
}

export function createEndpointCatalogFreshnessService(
  options: EndpointCatalogFreshnessServiceOptions,
): EndpointCatalogFreshnessService {
  const environment = options.environment ?? process.env;
  const readStore = options.readFile ?? defaultReadFile;
  const writeStore = options.writeFile ?? defaultWriteFile;
  const storePath =
    options.storeDirectory === undefined
      ? endpointCatalogFreshnessStorePath(process.env.APPDATA ?? ".")
      : endpointCatalogFreshnessStorePath(options.storeDirectory);

  return Object.freeze({
    async refresh(): Promise<readonly EndpointCatalogFreshnessReport[]> {
      const reports: EndpointCatalogFreshnessReport[] = [];
      for (const endpoint of options.endpoints) {
        reports.push(await refreshEndpoint(endpoint));
      }
      return Object.freeze(reports);
    },
    augmentedModels(endpointId: EndpointCatalogFreshnessEndpointId) {
      return readEnrollments(endpointId).map((entry) =>
        Object.freeze({
          id: entry.id,
          // The single conservative tier; curation stays with the lane.
          effortLevels: Object.freeze([
            ENDPOINT_CATALOG_FRESHNESS_ENROLLED_EFFORT_LEVEL,
          ]),
        }),
      );
    },
    enrolledModelIds(endpointId: EndpointCatalogFreshnessEndpointId) {
      return Object.freeze(readEnrollments(endpointId).map((entry) => entry.id));
    },
  });

  async function refreshEndpoint(
    endpoint: EndpointCatalogFreshnessEndpointConfiguration,
  ): Promise<EndpointCatalogFreshnessReport> {
    let enrolled = readEnrollments(endpoint.endpointId);
    try {
      const authToken = endpoint.resolveToken();
      if (authToken === undefined) {
        return report(endpoint.endpointId, "silent-failure", [], enrolled);
      }
      const outcome = await fetchEndpointModelsList({
        face: endpoint.face,
        authToken,
        ...(endpoint.resolveBaseUrl === undefined
          ? {}
          : { baseUrl: endpoint.resolveBaseUrl(environment) }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (outcome.outcome !== "success") {
        return report(endpoint.endpointId, "silent-failure", [], enrolled);
      }
      const known = [
        ...(STATIC_CATALOG_IDS[endpoint.endpointId] ?? endpoint.staticCatalogModelIds),
        ...enrolled.map((entry) => entry.id),
      ];
      const newBaseIds = new Set(
        findNewEndpointModelIds(
          known,
          outcome.models.map((model) => model.id),
        ),
      );
      // First occurrence wins: a provider listing the same id twice (with
      // and without display metadata) must not erase the richer entry.
      const listedById = new Map<string, EndpointModelsListEntry>();
      for (const model of outcome.models) {
        if (!listedById.has(model.id)) listedById.set(model.id, model);
      }
      const added: EndpointCatalogFreshnessModelEntry[] = [];
      const nextEnrolled = [...enrolled];
      const now = new Date().toISOString();
      for (const baseId of newBaseIds) {
        const listed = listedById.get(baseId);
        const entry = entryFromListed(baseId, listed, now);
        nextEnrolled.push(entry);
        added.push(publicEntry(entry));
      }
      if (
        added.length > 0 &&
        !writeEnrollments(endpoint.endpointId, nextEnrolled)
      ) {
        return report(endpoint.endpointId, "silent-failure", [], enrolled);
      }
      enrolled = nextEnrolled;
      return report(endpoint.endpointId, "fresh", added, enrolled);
    } catch {
      // Silent degradation is the design: any unexpected failure keeps the
      // static catalog authoritative and disturbs no error surface.
      return report(endpoint.endpointId, "silent-failure", [], enrolled);
    }
  }

  function report(
    endpointId: EndpointCatalogFreshnessEndpointId,
    status: "fresh" | "silent-failure",
    newModels: readonly EndpointCatalogFreshnessModelEntry[],
    enrolled: readonly StoredEnrollment[],
  ): EndpointCatalogFreshnessReport {
    return Object.freeze({
      endpointId,
      status,
      newModels: Object.freeze(newModels.map(freezePublicEntry)),
      enrolledModels: Object.freeze(enrolled.map(publicEntry)),
    });
  }

  function freezePublicEntry(
    entry: EndpointCatalogFreshnessModelEntry,
  ): EndpointCatalogFreshnessModelEntry {
    return Object.freeze({
      id: entry.id,
      ...(entry.displayName === undefined
        ? {}
        : { displayName: entry.displayName }),
      ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
    });
  }

  function readEnrollments(
    endpointId: EndpointCatalogFreshnessEndpointId,
  ): readonly StoredEnrollment[] {
    try {
      const contents = parseStore(readStore(storePath));
      if (contents === undefined) return [];
      return (
        contents.endpoints[endpointId]?.filter(isValidStoredEnrollment) ?? []
      );
    } catch {
      return [];
    }
  }

  function writeEnrollments(
    endpointId: EndpointCatalogFreshnessEndpointId,
    enrolled: readonly StoredEnrollment[],
  ): boolean {
    try {
      const contents = parseStore(readStore(storePath)) ?? {
        schemaVersion: 1 as const,
        endpoints: {},
      };
      writeStore(
        storePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            endpoints: {
              ...contents.endpoints,
              [endpointId]: enrolled,
            },
          },
          null,
          2,
        )}\n`,
      );
      return true;
    } catch {
      // A model is not enrolled until the persisted catalog can serve it.
      return false;
    }
  }
}

/** Adapter-facing subset of a stored enrollment (no bookkeeping fields). */
function publicEntry(
  entry: StoredEnrollment,
): EndpointCatalogFreshnessModelEntry {
  return Object.freeze({
    id: entry.id,
    ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
  });
}

function entryFromListed(
  baseId: string,
  listed: EndpointModelsListEntry | undefined,
  enrolledAt: string,
): StoredEnrollment {
  return Object.freeze({
    id: baseId,
    ...(listed?.displayName === undefined || listed.displayName === baseId
      ? {}
      : { displayName: listed.displayName }),
    ...(listed?.createdAt === undefined ? {} : { createdAt: listed.createdAt }),
    enrolledAt,
  });
}

/**
 * Exact-shape read: the persisted file must be a plain object with the
 * marker, a version, and an endpoints record. Anything else (corrupt,
 * foreign, partially written) reads as "no store" — never wiped, never
 * guessed at, and never fatal.
 */
function parseStore(text: string): StoreContents | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.endpoints !== "object" || record.endpoints === null || Array.isArray(record.endpoints)) {
    return undefined;
  }
  const endpoints: Record<string, readonly StoredEnrollment[]> = {};
  for (const [endpointId, value] of Object.entries(record.endpoints)) {
    if (Array.isArray(value)) {
      endpoints[endpointId] = value.filter(isValidStoredEnrollment) as StoredEnrollment[];
    }
  }
  return Object.freeze({ schemaVersion: 1, endpoints: Object.freeze(endpoints) });
}

function isValidStoredEnrollment(value: unknown): value is StoredEnrollment {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 200) {
    return false;
  }
  if (record.displayName !== undefined && typeof record.displayName !== "string") {
    return false;
  }
  if (record.createdAt !== undefined && typeof record.createdAt !== "string") {
    return false;
  }
  return typeof record.enrolledAt === "string";
}

function defaultReadFile(path: string): string {
  try {
    return nodeFs.readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function defaultWriteFile(path: string, text: string): void {
  nodeFs.mkdirSync(dirname(path), { recursive: true });
  nodeFs.writeFileSync(path, text, "utf8");
}
