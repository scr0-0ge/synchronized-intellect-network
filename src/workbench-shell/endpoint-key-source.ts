import { join } from "node:path";

import {
  EndpointSecretEnvelopeStore,
  SecretEnvelopeNotFoundError,
} from "./endpoint-secret-envelope-store.ts";
import {
  isValidWorkbenchEndpointKeyValue,
  type WorkbenchEndpointKeySnapshot,
  type WorkbenchEndpointProbeOutcome,
} from "./contract.ts";

/**
 * Shared multi-subject store file name — one store file, many subjects
 * (ADR 0022); byte-identical constants live in each endpoint's identity
 * module. The store file lives in the Electron userData directory
 * (`%APPDATA%\synchronized-intellect-network` on Windows).
 */
export const ENDPOINT_SECRET_STORE_FILE_NAME =
  "endpoint-secret-envelope-store.json";

export function endpointSecretEnvelopeStorePath(
  userDataDirectory: string,
): string {
  if (typeof userDataDirectory !== "string" || userDataDirectory.length === 0) {
    throw new TypeError("userDataDirectory must be a non-empty string");
  }
  return join(userDataDirectory, ENDPOINT_SECRET_STORE_FILE_NAME);
}

/**
 * The env contract an endpoint's key source resolves its fallback token and
 * probe base URL from. Each provider supplies its own (GLM:
 * `GLM_ANTHROPIC_*`; Kimi: `KIMI_CODE_ANTHROPIC_*`; DeepSeek:
 * `DEEPSEEK_ANTHROPIC_*`).
 */
export interface WorkbenchEndpointKeyEnvContract {
  readonly authTokenEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
}

/**
 * Probe wiring for one endpoint: the resolved base URL and the endpoint's
 * declared probe shape (see endpoint-probe.ts). Providers whose probe target
 * is derived from (but not equal to) the endpoint base URL — DeepSeek's
 * zero-inference `GET /models` lives on the platform face, not the Anthropic
 * face — compute the probe base URL here.
 */
/**
 * The endpoint's probe function — a provider-pinned wrapper over the shared
 * `probeEndpoint` (see endpoint-probe.ts) carrying the provider's auth header
 * shape, explicit model id, and request kind. The source resolves the base
 * URL and token; the wrapper owns everything provider-specific.
 */
export type WorkbenchEndpointProbeRequest = (options: {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}) => Promise<WorkbenchEndpointProbeOutcome>;

export interface WorkbenchEndpointKeySource {
  /** Store-backed snapshot: names, masks and booleans only. */
  status(): WorkbenchEndpointKeySnapshot;
  /** Validates and stores the key; throws on an invalid value or store failure. */
  save(keyValue: string): WorkbenchEndpointKeySnapshot;
  /** Removes the stored key; returns false when nothing was stored. */
  remove(): boolean;
  /** The one explicit value channel; `undefined` when no key is stored. */
  reveal(): string | undefined;
  /**
   * Composition consumption shape (store first, the endpoint contract's auth
   * token environment variable fallback). `undefined` only when unconfigured;
   * a configured but broken entry throws rather than masquerading as absent
   * (ADR 0022 §2.3).
   */
  resolve(): string | undefined;
  /** The user-triggered bare HTTP probe; never invoked automatically. */
  probe(): Promise<WorkbenchEndpointProbeOutcome>;
}

export interface WorkbenchEndpointKeySourceOptions {
  readonly store: EndpointSecretEnvelopeStore;
  /** Endpoint-scoped opaque key name (`glm-coding-plan`, `kimi-code`, ...). */
  readonly keyName: string;
  readonly envContract: WorkbenchEndpointKeyEnvContract;
  readonly probeRequest: WorkbenchEndpointProbeRequest;
  /**
   * Optional probe base URL derivation. Default: the endpoint contract's env
   * override, else its default base URL. DeepSeek overrides this because its
   * zero-inference probe lives on the platform face (`.../models`), not the
   * Anthropic face the sessions use.
   */
  readonly probeBaseUrl?: (environment: NodeJS.ProcessEnv) => string;
  /** Environment the fallback token/base URL are read from. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly probeTimeoutMilliseconds?: number;
}

/**
 * Main-process source behind the parameterized endpoint-key IPC surface (GLM,
 * Kimi, DeepSeek share one implementation; WO16 Part 1). Everything is
 * synchronous except the probe; secret values stay inside this module except
 * through `reveal()`/`resolve()`, and masked hints are the only key-derived
 * data that ever reach the renderer through the status path.
 */
export function createWorkbenchEndpointKeySource(
  options: WorkbenchEndpointKeySourceOptions,
): WorkbenchEndpointKeySource {
  const environment = options.environment ?? process.env;
  const store = options.store;
  return Object.freeze({
    status(): WorkbenchEndpointKeySnapshot {
      return currentSnapshot();
    },
    save(keyValue: string): WorkbenchEndpointKeySnapshot {
      if (!isValidWorkbenchEndpointKeyValue(keyValue)) {
        throw new TypeError("invalid endpoint key value");
      }
      store.upsert(options.keyName, keyValue);
      return currentSnapshot();
    },
    remove(): boolean {
      return store.remove(options.keyName);
    },
    reveal(): string | undefined {
      return store.resolve(options.keyName);
    },
    resolve(): string | undefined {
      return resolveToken();
    },
    async probe(): Promise<WorkbenchEndpointProbeOutcome> {
      const authToken = resolveToken();
      if (authToken === undefined) {
        return Object.freeze({
          outcome: "failure",
          reason: "token-missing",
        });
      }
      return options.probeRequest({
        baseUrl:
          options.probeBaseUrl === undefined
            ? defaultProbeBaseUrl(environment)
            : options.probeBaseUrl(environment),
        authToken,
        ...(options.fetch === undefined
          ? {}
          : { fetch: options.fetch }),
        ...(options.probeTimeoutMilliseconds === undefined
          ? {}
          : { timeoutMilliseconds: options.probeTimeoutMilliseconds }),
      });
    },
  });

  /**
   * Store first, environment fallback (work order ruling 2). A stored key
   * that is present but broken propagates its throw — a broken store never
   * masquerades as "unconfigured" (ADR 0022 §2.3).
   */
  function resolveToken(): string | undefined {
    const stored = store.resolve(options.keyName);
    if (stored !== undefined) return stored;
    const fallback = environment[options.envContract.authTokenEnvVar];
    return typeof fallback === "string" && fallback.trim().length > 0
      ? fallback
      : undefined;
  }

  function defaultProbeBaseUrl(source: NodeJS.ProcessEnv): string {
    const explicit = source[options.envContract.baseUrlEnvVar];
    return typeof explicit === "string" && explicit.trim().length > 0
      ? explicit
      : options.envContract.defaultBaseUrl;
  }

  function currentSnapshot(): WorkbenchEndpointKeySnapshot {
    let configured = false;
    let maskedHint: string | null = null;
    try {
      const stored = store.reveal(options.keyName);
      configured = true;
      maskedHint = maskEndpointSecretHint(stored);
    } catch (error) {
      if (!(error instanceof SecretEnvelopeNotFoundError)) {
        throw error;
      }
    }
    return Object.freeze({
      configured,
      maskedHint,
      isPersistent: store.isPersistent(),
      environmentFallback: readEnvironmentFallbackPresent(),
    });
  }

  function readEnvironmentFallbackPresent(): boolean {
    const fallback = environment[options.envContract.authTokenEnvVar];
    return typeof fallback === "string" && fallback.trim().length > 0;
  }
}

/** `"••••"` plus at most the last four characters of the value. */
export function maskEndpointSecretHint(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("secret value must be a non-empty string");
  }
  return `••••${value.slice(-4)}`;
}
