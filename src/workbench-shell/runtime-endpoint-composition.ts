import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import type {
  ResumableAgentRuntimeAdapter,
  RuntimeCatalog,
  RuntimeContinuationProfileCompatibility,
  RuntimeContinuationProfileCompatibilityRequest,
  RuntimeModel,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../agent-runtime/index.ts";
import { RuntimeAdapterError } from "../agent-runtime/index.ts";
import {
  ClaudeAdapter,
  mergeStaticCatalogAugmentation,
  type ClaudePermissionHandlingOptions,
  type ClaudeSessionCapabilityStore,
} from "../agent-runtime/claude/adapter.ts";
import type { ClaudeSessionTransportFactory } from "../agent-runtime/claude/transport.ts";
import type { RuntimeEndpointExecutionLocation } from "../agent-runtime/runtime-endpoint-directory.ts";
import {
  GLM_DEFAULT_MODEL_ID,
  GLM_ENDPOINT_ENV_CONTRACT,
  createGlmEndpointContext,
  glmIsolatedClaudeConfigDir,
} from "../agent-runtime/claude/glm-catalog.ts";
import {
  KIMI_DEFAULT_MODEL_ID,
  createKimiEndpointContext,
  kimiIsolatedClaudeConfigDir,
} from "../agent-runtime/claude/kimi-catalog.ts";
import {
  DEEPSEEK_DEFAULT_MODEL_ID,
  createDeepseekEndpointContext,
  deepseekIsolatedClaudeConfigDir,
} from "../agent-runtime/claude/deepseek-catalog.ts";
import {
  createClaudeApiEndpointContext,
} from "../agent-runtime/claude/claude-api-endpoint.ts";
import { CodexAdapter } from "../agent-runtime/codex-adapter.ts";
import type { CodexCatalogObservation } from "../agent-runtime/codex-adapter.ts";
import type { OfficialRuntimeTransportFactory } from "../agent-runtime/codex/transport.ts";
import {
  KIMI_PLATFORM_DEFAULT_MODEL_ID,
  createKimiPlatformEndpointContext,
  kimiPlatformIsolatedCodexHomeDir,
} from "../agent-runtime/codex/kimi-platform-catalog.ts";
import {
  CODEX_API_DEFAULT_MODEL_ID,
  createCodexApiEndpointContext,
  codexApiIsolatedCodexHomeDir,
} from "../agent-runtime/codex/codex-api-catalog.ts";
import type { ProviderRequestBudget } from "../agent-runtime/provider-request-budget.ts";
import {
  parseDurableAuthenticationContext,
  type DurableAuthenticationContext,
  type RuntimeEndpointAuthGenerationSnapshot,
  type WorkLedgerAuthGenerationModule,
} from "../coordinator/work-ledger-auth-generation.ts";
import {
  createRuntimeEndpointDirectory,
  type RuntimeEndpointProfileRegistration,
  type RuntimeEndpointRegistration,
} from "../agent-runtime/runtime-endpoint-directory.ts";
import { LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY } from "./preference-store.ts";
import {
  publicRuntimeEndpointDiscovery,
  publicUniformRuntimeEndpointDiscovery,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchRuntimeEndpointDiscovery,
  type WorkbenchRuntimeEndpointDiscoveryCategory,
  type WorkbenchRuntimeEndpointId,
} from "./contract.ts";
import {
  isRegisteredRuntimeEndpointId,
} from "./runtime-endpoint-identity.ts";
import {
  createWorkbenchRuntimeEndpointAdapter,
  type WorkbenchContinuationRuntimeResumeContext,
  type WorkbenchDirectRuntimeEndpointCatalog,
  type WorkbenchResolvedRuntimeResumeIdentity,
} from "./runtime-endpoint-adapter.ts";
import {
  isClaudeUltracodeRuntimeProfileProjection,
} from "../agent-runtime/runtime-profile-projection.ts";
import {
  claudeDiagnosticFromError,
  productionClaudeDiagnosticObserver,
  type ClaudeDiagnosticObserver,
} from "../agent-runtime/claude/diagnostics.ts";
import type {
  DirectSessionProfileCatalog,
  WorkIntensityExecutionModeCoupling,
} from "./direct-session-profile-snapshot.ts";
import { workbenchModelPresentationLabel } from "./model-presentation.ts";

const claudeEndpointPreferenceKey = "claude-code-desktop";
// Historical v1 identity for durable selection keys, not the product brand.
// Renaming this would invalidate existing model/profile preference references.
const selectionNamespace = "unified-agent-workbench/runtime-endpoint/v1";

/**
 * One line naming every observed catalog drift fact, or `undefined` when the
 * read observed none. Tolerated keys say what the vendor added; a quarantined
 * model names what moved on it in each direction; the omission count keeps a
 * vendor-wide change from repeating one diagnosis a thousand times.
 */
export function formatCodexCatalogDriftDiagnostic(
  observation: CodexCatalogObservation,
): string | undefined {
  if (
    observation.toleratedKeys.length === 0 &&
    observation.rejections.length === 0 &&
    observation.rejectionsOmitted === 0
  ) {
    return undefined;
  }
  const parts: string[] = [];
  if (observation.toleratedKeys.length > 0) {
    parts.push(`tolerated-keys=[${observation.toleratedKeys.join(",")}]`);
  }
  for (const rejection of observation.rejections) {
    parts.push(
      `quarantined-model=${rejection.modelId} ` +
        `added=[${rejection.unknownKeys.join(",")}] ` +
        `removed=[${rejection.missingKeys.join(",")}] ` +
        `invalid=[${rejection.invalidValueKeys.join(",")}]`,
    );
  }
  if (observation.rejectionsOmitted > 0) {
    parts.push(`quarantined-omitted=${observation.rejectionsOmitted}`);
  }
  return `CODEX_CATALOG_DRIFT ${parts.join(" ")}`;
}

/**
 * The production consumer of the Codex catalog observation channel (`F110`
 * round 2, A.4). It writes to the main-process console — the same surface the
 * native-window-material diagnostic already uses — so a quarantined model or
 * a tolerated vendor key is never silent in the running product, on the
 * failing path included. Diagnostics only: it never changes what `inspect`
 * returns, and the adapter already isolates an observer that throws.
 */
export function productionCodexCatalogObserver(
  observation: CodexCatalogObservation,
): void {
  const diagnostic = formatCodexCatalogDriftDiagnostic(observation);
  if (diagnostic !== undefined) console.warn(diagnostic);
}

/**
 * The one production construction of `CodexAdapter`. Both composition sites
 * route through here so the observation channel cannot silently lose its
 * production consumer again by one site forgetting the third argument.
 */
export function createProductionCodexAdapter(
  providerRequestBudget?: ProviderRequestBudget,
  createTransport?: OfficialRuntimeTransportFactory,
): CodexAdapter {
  return new CodexAdapter(
    createTransport,
    providerRequestBudget,
    productionCodexCatalogObserver,
  );
}

/**
 * The production construction of the GLM Coding Plan endpoint adapter: the
 * same ClaudeAdapter class carrying a GLM endpoint context (per-endpoint env
 * factory, api-key-static authentication, static catalog). The key source is
 * the endpoint secret envelope store when one is wired via
 * `resolveGlmAuthToken` (ADR 0022), with the `GLM_ANTHROPIC_AUTH_TOKEN`
 * environment variable as the P2 fallback (read from `environment`);
 * with neither source the session start reports token-missing exactly as
 * before. Nothing is ever written to disk by this factory itself.
 */
export function createProductionGlmRuntimeAdapter(options: {
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly claudePermissionHandling?: ClaudePermissionHandlingOptions;
  readonly claudeSessionCapabilityStore?: ClaudeSessionCapabilityStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly configDirectory?: string;
  /** Live store-backed token resolver; `undefined` result falls back to env. */
  readonly resolveGlmAuthToken?: () => string | undefined;
  readonly resolveStaticCatalogAugmentation?: () => readonly RuntimeModel[];
  readonly createSessionTransport?: ClaudeSessionTransportFactory;
}): ResumableAgentRuntimeAdapter {
  const environment = options.environment ?? process.env;
  const endpointContext = createGlmEndpointContext({
    baseUrl: readGlmEndpointBaseUrl(environment),
    configDir:
      options.configDirectory ?? glmIsolatedClaudeConfigDir(),
    sourceEnvironment: environment,
    ...(options.resolveGlmAuthToken === undefined
      ? {}
      : { resolveAuthToken: options.resolveGlmAuthToken }),
  });
  return new ClaudeAdapter(
    undefined,
    options.createSessionTransport,
    options.providerRequestBudget,
    options.claudePermissionHandling,
    undefined,
    options.claudeSessionCapabilityStore,
    options.resolveStaticCatalogAugmentation === undefined
      ? endpointContext
      : Object.freeze({
          ...endpointContext,
          resolveStaticCatalogAugmentation:
            options.resolveStaticCatalogAugmentation,
        }),
  );
}

function readGlmEndpointBaseUrl(source: NodeJS.ProcessEnv): string | undefined {
  const value = source[GLM_ENDPOINT_ENV_CONTRACT.baseUrlEnvVar];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * The production construction of the Kimi Code endpoint adapter (WO16 Part
 * 2): the same ClaudeAdapter class carrying the Kimi endpoint context
 * (ticket 11 design of record). Key source and env fallback follow the GLM
 * pattern — store-backed resolver via `resolveKimiAuthToken`, else
 * `KIMI_CODE_ANTHROPIC_AUTH_TOKEN` from `environment`; with neither, session
 * start reports token-missing. The isolated CLAUDE_CONFIG_DIR is Kimi's own.
 */
export function createProductionKimiRuntimeAdapter(options: {
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly claudePermissionHandling?: ClaudePermissionHandlingOptions;
  readonly claudeSessionCapabilityStore?: ClaudeSessionCapabilityStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly configDirectory?: string;
  /** Live store-backed token resolver; `undefined` result falls back to env. */
  readonly resolveKimiAuthToken?: () => string | undefined;
  readonly resolveStaticCatalogAugmentation?: () => readonly RuntimeModel[];
}): ResumableAgentRuntimeAdapter {
  const environment = options.environment ?? process.env;
  const endpointContext = createKimiEndpointContext({
    configDir:
      options.configDirectory ?? kimiIsolatedClaudeConfigDir(),
    sourceEnvironment: environment,
    ...(options.resolveKimiAuthToken === undefined
      ? {}
      : { resolveAuthToken: options.resolveKimiAuthToken }),
  });
  return new ClaudeAdapter(
    undefined,
    undefined,
    options.providerRequestBudget,
    options.claudePermissionHandling,
    undefined,
    options.claudeSessionCapabilityStore,
    options.resolveStaticCatalogAugmentation === undefined
      ? endpointContext
      : Object.freeze({
          ...endpointContext,
          resolveStaticCatalogAugmentation:
            options.resolveStaticCatalogAugmentation,
        }),
  );
}

/**
 * The production construction of the DeepSeek API endpoint adapter (WO16
 * Part 2): the same ClaudeAdapter class carrying the DeepSeek endpoint
 * context (ticket 12 design of record). Key source and env fallback follow
 * the GLM pattern — store-backed resolver via `resolveDeepseekAuthToken`,
 * else `DEEPSEEK_ANTHROPIC_AUTH_TOKEN` from `environment`. The isolated
 * CLAUDE_CONFIG_DIR is DeepSeek's own.
 */
export function createProductionDeepseekRuntimeAdapter(options: {
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly claudePermissionHandling?: ClaudePermissionHandlingOptions;
  readonly claudeSessionCapabilityStore?: ClaudeSessionCapabilityStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly configDirectory?: string;
  /** Live store-backed token resolver; `undefined` result falls back to env. */
  readonly resolveDeepseekAuthToken?: () => string | undefined;
  readonly resolveStaticCatalogAugmentation?: () => readonly RuntimeModel[];
}): ResumableAgentRuntimeAdapter {
  const environment = options.environment ?? process.env;
  const endpointContext = createDeepseekEndpointContext({
    configDir:
      options.configDirectory ?? deepseekIsolatedClaudeConfigDir(),
    sourceEnvironment: environment,
    ...(options.resolveDeepseekAuthToken === undefined
      ? {}
      : { resolveAuthToken: options.resolveDeepseekAuthToken }),
  });
  return new ClaudeAdapter(
    undefined,
    undefined,
    options.providerRequestBudget,
    options.claudePermissionHandling,
    undefined,
    options.claudeSessionCapabilityStore,
    options.resolveStaticCatalogAugmentation === undefined
      ? endpointContext
      : Object.freeze({
          ...endpointContext,
          resolveStaticCatalogAugmentation:
            options.resolveStaticCatalogAugmentation,
        }),
  );
}

/**
 * The production construction of the kimi-platform endpoint adapter (ticket
 * 17): the same CodexAdapter class carrying the kimi-platform endpoint
 * context — the workbench-owned isolated CODEX_HOME (seeded with the custom
 * model_provider pointing at the CN platform's OpenAI face), the key source
 * chain (endpoint secret envelope store via `resolveKimiPlatformApiKey`,
 * `KIMI_PLATFORM_API_KEY` environment fallback), and the static catalog of
 * platform-face model names. A spawn environment is the only place the key
 * value ever lives; nothing here writes to disk beyond the seeded home.
 */
export function createProductionKimiPlatformRuntimeAdapter(options: {
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly environment?: NodeJS.ProcessEnv;
  /** Isolated CODEX_HOME (default: the %APPDATA%-pattern workbench home). */
  readonly codexHomeDirectory?: string;
  /** Live store-backed key resolver; `undefined` result falls back to env. */
  readonly resolveKimiPlatformApiKey?: () => string | undefined;
}): ResumableAgentRuntimeAdapter {
  const environment = options.environment ?? process.env;
  return new CodexAdapter(
    undefined,
    options.providerRequestBudget,
    undefined,
    createKimiPlatformEndpointContext({
      codexHome:
        options.codexHomeDirectory ?? kimiPlatformIsolatedCodexHomeDir(),
      sourceEnvironment: environment,
      ...(options.resolveKimiPlatformApiKey === undefined
        ? {}
        : { resolveApiKey: options.resolveKimiPlatformApiKey }),
    }),
  );
}

/**
 * The production construction of the claude-api endpoint adapter (ticket
 * 21): the same ClaudeAdapter class carrying the claude-api endpoint
 * context — the dedicated `CLAUDE_API_KEY` source (envelope store via
 * `resolveClaudeApiKey`, environment fallback), injected as
 * ANTHROPIC_API_KEY after the standard cleanse, with the real CLI catalog
 * (no static override) and the `api_key` healthy auth-status shape. No
 * config-directory isolation: the backend is Anthropic itself.
 */
export function createProductionClaudeApiRuntimeAdapter(options: {
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly claudePermissionHandling?: ClaudePermissionHandlingOptions;
  readonly claudeSessionCapabilityStore?: ClaudeSessionCapabilityStore;
  readonly environment?: NodeJS.ProcessEnv;
  /** Live store-backed key resolver; `undefined` result falls back to env. */
  readonly resolveClaudeApiKey?: () => string | undefined;
}): ResumableAgentRuntimeAdapter {
  const environment = options.environment ?? process.env;
  return new ClaudeAdapter(
    undefined,
    undefined,
    options.providerRequestBudget,
    options.claudePermissionHandling,
    undefined,
    options.claudeSessionCapabilityStore,
    createClaudeApiEndpointContext({
      sourceEnvironment: environment,
      ...(options.resolveClaudeApiKey === undefined
        ? {}
        : { resolveApiKey: options.resolveClaudeApiKey }),
    }),
  );
}

/**
 * The production construction of the codex-api endpoint adapter (ticket
 * 21): the same CodexAdapter class carrying the codex-api endpoint context
 * — the workbench-owned isolated CODEX_HOME (seeded with the CLI's own
 * openai provider on the responses wire, `env_key` OPENAI_API_KEY), the key
 * source chain (endpoint secret envelope store via `resolveCodexApiKey`,
 * dedicated `CODEX_API_KEY` environment fallback), the static gpt-5.x
 * catalog (chatgpt-account gate skipped), remote-backed execution.
 */
export function createProductionCodexApiRuntimeAdapter(options: {
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly environment?: NodeJS.ProcessEnv;
  /** Isolated CODEX_HOME (default: the %APPDATA%-pattern workbench home). */
  readonly codexHomeDirectory?: string;
  /** Live store-backed key resolver; `undefined` result falls back to env. */
  readonly resolveCodexApiKey?: () => string | undefined;
}): ResumableAgentRuntimeAdapter {
  const environment = options.environment ?? process.env;
  return new CodexAdapter(
    undefined,
    options.providerRequestBudget,
    undefined,
    createCodexApiEndpointContext({
      codexHome: options.codexHomeDirectory ?? codexApiIsolatedCodexHomeDir(),
      sourceEnvironment: environment,
      ...(options.resolveCodexApiKey === undefined
        ? {}
        : { resolveApiKey: options.resolveCodexApiKey }),
    }),
  );
}

interface RuntimeDefinition {
  readonly endpointId: WorkbenchRuntimeEndpointId;
  readonly preferenceKey: string;
  readonly runtimeFamilyLabel: string;
  readonly endpointLabel: string;
  readonly adapter: ResumableAgentRuntimeAdapter;
  readonly directStart: "supported" | "inspect-only";
  /** Registration execution location; local desktop runtimes omit it. */
  readonly executionLocation?: RuntimeEndpointExecutionLocation;
  readonly desiredNativeDefault?: SessionProfile;
  /**
   * Per-definition diagnostic mapping for inspection failures. Endpoints in the
   * claude family map provider failures to private diagnostics; endpoints
   * without a mapping stay publicly classified only.
   */
  readonly diagnosticFromError?: (
    error: unknown,
  ) => ReturnType<typeof claudeDiagnosticFromError>;
}

interface RuntimeEndpointComposition {
  readonly adapter: ResumableAgentRuntimeAdapter;
  readonly registrations: readonly RuntimeEndpointRegistration[];
  readonly endpoints: readonly WorkbenchDirectRuntimeEndpointCatalog[];
  readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
}

type RuntimeResumeIdentityMapping =
  WorkbenchContinuationRuntimeResumeContext["runtimeResumeIdentities"][number];

interface RuntimeEndpointCompositionEntry {
  readonly token: object;
  readonly auth: RuntimeEndpointAuthGenerationSnapshot;
  readonly promise: Promise<RuntimeEndpointComposition>;
}

export interface RuntimeEndpointCompositionDiscovery {
  readonly registrations: readonly RuntimeEndpointRegistration[];
  readonly endpoints: readonly WorkbenchDirectRuntimeEndpointCatalog[];
  readonly endpointDiscovery: WorkbenchRuntimeEndpointDiscovery;
}

export async function createProductionRuntimeEndpointAdapter(options: {
  readonly codexAdapter?: ResumableAgentRuntimeAdapter;
  readonly claudeAdapter?: ResumableAgentRuntimeAdapter;
  readonly glmAdapter?: ResumableAgentRuntimeAdapter;
  readonly kimiAdapter?: ResumableAgentRuntimeAdapter;
  readonly deepseekAdapter?: ResumableAgentRuntimeAdapter;
  readonly kimiPlatformAdapter?: ResumableAgentRuntimeAdapter;
  readonly claudeApiAdapter?: ResumableAgentRuntimeAdapter;
  readonly codexApiAdapter?: ResumableAgentRuntimeAdapter;
  readonly blockedProjectDirectory?: string;
  readonly observeClaudeSubscriptionUsage?: import("../agent-runtime/index.ts").RuntimeSubscriptionUsageObserver;
  readonly decorateDirectoryAdapter?: (
    adapter: ResumableAgentRuntimeAdapter,
  ) => ResumableAgentRuntimeAdapter;
  readonly authGeneration?: Pick<
    WorkLedgerAuthGenerationModule,
    "captureRuntimeEndpointAuthGenerationSnapshot"
  >;
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly claudePermissionHandling?: ClaudePermissionHandlingOptions;
  readonly claudeSessionCapabilityStore?: ClaudeSessionCapabilityStore;
  /** Environment the default GLM adapter reads its token/base URL from. */
  readonly glmEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CLAUDE_CONFIG_DIR for the default GLM adapter. */
  readonly glmConfigDirectory?: string;
  /** Live store-backed GLM token resolver (ADR 0022); env stays the fallback. */
  readonly resolveGlmAuthToken?: () => string | undefined;
  /** Environment the default Kimi adapter reads its token/base URL from. */
  readonly kimiEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CLAUDE_CONFIG_DIR for the default Kimi adapter. */
  readonly kimiConfigDirectory?: string;
  /** Live store-backed Kimi token resolver (ADR 0022); env stays the fallback. */
  readonly resolveKimiAuthToken?: () => string | undefined;
  /** Environment the default DeepSeek adapter reads its token/base URL from. */
  readonly deepseekEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CLAUDE_CONFIG_DIR for the default DeepSeek adapter. */
  readonly deepseekConfigDirectory?: string;
  /** Live store-backed DeepSeek token resolver (ADR 0022); env stays the fallback. */
  readonly resolveDeepseekAuthToken?: () => string | undefined;
  /** Environment the default kimi-platform adapter reads its key from. */
  readonly kimiPlatformEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CODEX_HOME for the default kimi-platform adapter. */
  readonly kimiPlatformCodexHomeDirectory?: string;
  /** Live store-backed kimi-platform key resolver (ADR 0022); env stays the fallback. */
  readonly resolveKimiPlatformApiKey?: () => string | undefined;
  /** Environment the default claude-api adapter reads its key from. */
  readonly claudeApiEnvironment?: NodeJS.ProcessEnv;
  /** Live store-backed claude-api key resolver (ADR 0022); env stays the fallback. */
  readonly resolveClaudeApiKey?: () => string | undefined;
  /** Environment the default codex-api adapter reads its key from. */
  readonly codexApiEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CODEX_HOME for the default codex-api adapter. */
  readonly codexApiCodexHomeDirectory?: string;
  /** Live store-backed codex-api key resolver (ADR 0022); env stays the fallback. */
  readonly resolveCodexApiKey?: () => string | undefined;
  /** Catalog freshness enrollment appended to the static catalogs (WO16 P3). */
  readonly catalogAugmentation?: (
    endpointId: WorkbenchRuntimeEndpointId,
  ) => readonly RuntimeModel[];
}): Promise<ResumableAgentRuntimeAdapter> {
  const codexAdapter =
    options.codexAdapter ??
    createProductionCodexAdapter(options.providerRequestBudget);
  const claudeAdapter =
    options.claudeAdapter ??
    new ClaudeAdapter(
      undefined,
      undefined,
      options.providerRequestBudget,
      options.claudePermissionHandling,
      undefined,
      options.claudeSessionCapabilityStore,
      undefined,
      options.observeClaudeSubscriptionUsage,
    );
  const glmAdapter =
    options.glmAdapter ??
    createProductionGlmRuntimeAdapter({
      providerRequestBudget: options.providerRequestBudget,
      claudePermissionHandling: options.claudePermissionHandling,
      claudeSessionCapabilityStore: options.claudeSessionCapabilityStore,
      environment: options.glmEnvironment,
      configDirectory: options.glmConfigDirectory,
      resolveGlmAuthToken: options.resolveGlmAuthToken,
      ...(options.catalogAugmentation === undefined
        ? {}
        : {
            resolveStaticCatalogAugmentation: () =>
              options.catalogAugmentation!("glm-coding-plan"),
          }),
    });
  const kimiAdapter =
    options.kimiAdapter ??
    createProductionKimiRuntimeAdapter({
      providerRequestBudget: options.providerRequestBudget,
      claudePermissionHandling: options.claudePermissionHandling,
      claudeSessionCapabilityStore: options.claudeSessionCapabilityStore,
      environment: options.kimiEnvironment,
      configDirectory: options.kimiConfigDirectory,
      resolveKimiAuthToken: options.resolveKimiAuthToken,
      ...(options.catalogAugmentation === undefined
        ? {}
        : {
            resolveStaticCatalogAugmentation: () =>
              options.catalogAugmentation!("kimi-code"),
          }),
    });
  const deepseekAdapter =
    options.deepseekAdapter ??
    createProductionDeepseekRuntimeAdapter({
      providerRequestBudget: options.providerRequestBudget,
      claudePermissionHandling: options.claudePermissionHandling,
      claudeSessionCapabilityStore: options.claudeSessionCapabilityStore,
      environment: options.deepseekEnvironment,
      configDirectory: options.deepseekConfigDirectory,
      resolveDeepseekAuthToken: options.resolveDeepseekAuthToken,
      ...(options.catalogAugmentation === undefined
        ? {}
        : {
            resolveStaticCatalogAugmentation: () =>
              options.catalogAugmentation!("deepseek-api"),
          }),
    });
  const kimiPlatformAdapter =
    options.kimiPlatformAdapter ??
    createProductionKimiPlatformRuntimeAdapter({
      providerRequestBudget: options.providerRequestBudget,
      environment: options.kimiPlatformEnvironment,
      codexHomeDirectory: options.kimiPlatformCodexHomeDirectory,
      resolveKimiPlatformApiKey: options.resolveKimiPlatformApiKey,
    });
  const claudeApiAdapter =
    options.claudeApiAdapter ??
    createProductionClaudeApiRuntimeAdapter({
      providerRequestBudget: options.providerRequestBudget,
      claudePermissionHandling: options.claudePermissionHandling,
      claudeSessionCapabilityStore: options.claudeSessionCapabilityStore,
      environment: options.claudeApiEnvironment,
      resolveClaudeApiKey: options.resolveClaudeApiKey,
    });
  const codexApiAdapter =
    options.codexApiAdapter ??
    createProductionCodexApiRuntimeAdapter({
      providerRequestBudget: options.providerRequestBudget,
      environment: options.codexApiEnvironment,
      codexHomeDirectory: options.codexApiCodexHomeDirectory,
      resolveCodexApiKey: options.resolveCodexApiKey,
    });
  const activeCompositions = new Map<
    string,
    Promise<RuntimeEndpointComposition>
  >();
  const resolvedActiveCompositions = new Map<
    string,
    RuntimeEndpointComposition
  >();
  const reusableCompositions = new Map<
    string,
    RuntimeEndpointCompositionEntry
  >();
  let currentProjectKey: string | undefined;
  const blockedProjectDirectory = options.blockedProjectDirectory;
  const discoverComposition = async (
    projectDirectory: string,
  ): Promise<RuntimeEndpointComposition> => {
    const projectKey = comparableProjectDirectory(projectDirectory);
    if (
      blockedProjectDirectory !== undefined &&
      projectKey === comparableProjectDirectory(blockedProjectDirectory)
    ) {
      return Object.freeze({
        adapter: noAvailableRuntimeAdapter,
        registrations: Object.freeze([]),
        endpoints: Object.freeze([]),
        endpointDiscovery: publicUniformRuntimeEndpointDiscovery(
          "not-inspected",
        ),
      });
    }
    const discovery = await discoverRuntimeEndpointComposition({
      projectDirectory,
      codexAdapter,
      claudeAdapter,
      glmAdapter,
      kimiAdapter,
      deepseekAdapter,
      kimiPlatformAdapter,
      claudeApiAdapter,
      codexApiAdapter,
      ...(options.catalogAugmentation === undefined
        ? {}
        : { catalogAugmentation: options.catalogAugmentation }),
    });
    return Object.freeze({
      adapter:
        discovery.registrations.length === 0
          ? noAvailableRuntimeAdapter
          : createRuntimeEndpointDirectory(
              discovery.registrations,
            ).runtimeAdapter(),
      registrations: discovery.registrations,
      endpoints: discovery.endpoints,
      endpointDiscovery: discovery.endpointDiscovery,
    });
  };
  const activateComposition = (
    projectKey: string,
    pending: Promise<RuntimeEndpointComposition>,
  ): Promise<RuntimeEndpointComposition> => {
    activeCompositions.set(projectKey, pending);
    resolvedActiveCompositions.delete(projectKey);
    void pending.then(
      (composition) => {
        if (activeCompositions.get(projectKey) === pending) {
          resolvedActiveCompositions.set(projectKey, composition);
        }
      },
      () => {
        if (activeCompositions.get(projectKey) === pending) {
          activeCompositions.delete(projectKey);
          resolvedActiveCompositions.delete(projectKey);
        }
      },
    );
    return pending;
  };
  const materializeForContinuation = (
    base: Promise<RuntimeEndpointComposition>,
    continuationContext: WorkbenchContinuationRuntimeResumeContext | undefined,
  ): Promise<RuntimeEndpointComposition> =>
    continuationContext === undefined ||
    continuationContext.runtimeResumeIdentities.length === 0
      ? base
      : base.then((composition) =>
          withHistoricalRuntimeResumeProfile(composition, continuationContext),
        );
  const createLegacyComposition = (
    projectDirectory: string,
    continuationContext?: WorkbenchContinuationRuntimeResumeContext,
  ) => {
    const projectKey = comparableProjectDirectory(projectDirectory);
    return activateComposition(
      projectKey,
      materializeForContinuation(
        discoverComposition(projectDirectory),
        continuationContext,
      ),
    );
  };
  const loadComposition = (
    projectDirectory: string,
    requestKind: WorkbenchDirectSessionProfileLoadRequest["kind"],
    continuationContext?: WorkbenchContinuationRuntimeResumeContext,
  ): Promise<RuntimeEndpointComposition> => {
    if (options.authGeneration === undefined) {
      return createLegacyComposition(projectDirectory, continuationContext);
    }
    const projectKey = comparableProjectDirectory(projectDirectory);
    if (
      currentProjectKey !== undefined &&
      currentProjectKey !== projectKey
    ) {
      reusableCompositions.clear();
      activeCompositions.clear();
      resolvedActiveCompositions.clear();
    }
    currentProjectKey = projectKey;
    const before = captureExactAuthSnapshot(options.authGeneration);
    if (before === undefined) {
      reusableCompositions.delete(projectKey);
      activeCompositions.delete(projectKey);
      resolvedActiveCompositions.delete(projectKey);
      throw new TypeError("runtime-auth-generation-unavailable");
    }
    const reusable = reusableCompositions.get(projectKey);
    let base: Promise<RuntimeEndpointComposition>;
    if (
      requestKind === "continuation-session" &&
      reusable !== undefined &&
      sameAuthSnapshot(reusable.auth, before)
    ) {
      base = reusable.promise;
    } else {
      const token = Object.freeze({});
      base = (async () => {
        const composition = await discoverComposition(projectDirectory);
        const after = captureExactAuthSnapshot(options.authGeneration!);
        if (after === undefined || !sameAuthSnapshot(before, after)) {
          throw new TypeError("runtime-auth-generation-changed");
        }
        return composition;
      })();
      const entry = Object.freeze({ token, auth: before, promise: base });
      reusableCompositions.set(projectKey, entry);
      void base.catch(() => {
        const current = reusableCompositions.get(projectKey);
        if (current?.token === token) reusableCompositions.delete(projectKey);
      });
    }
    return activateComposition(
      projectKey,
      materializeForContinuation(base, continuationContext),
    );
  };
  const ensureComposition = (projectDirectory: string) =>
    activeCompositions.get(comparableProjectDirectory(projectDirectory)) ??
    loadComposition(projectDirectory, "catalog-default");
  let delegate: ResumableAgentRuntimeAdapter = Object.freeze({
    async inspect(projectDirectory: string) {
      return (await ensureComposition(projectDirectory)).adapter.inspect(
        projectDirectory,
      );
    },
    async start(request: RuntimeStart) {
      return (await ensureComposition(request.projectDirectory)).adapter.start(
        request,
      );
    },
    async resume(request: RuntimeResume) {
      return (await ensureComposition(request.projectDirectory)).adapter.resume(
        request,
      );
    },
    async continuationProfileCompatibility(
      request: RuntimeContinuationProfileCompatibilityRequest,
    ): Promise<RuntimeContinuationProfileCompatibility> {
      const composition = await ensureComposition(request.projectDirectory);
      const compatibility = composition.adapter.continuationProfileCompatibility;
      if (typeof compatibility !== "function") {
        throw new RuntimeAdapterError("unsupported-selection");
      }
      return compatibility.call(
        composition.adapter,
        request,
      );
    },
  });
  if (options.decorateDirectoryAdapter !== undefined) {
    delegate = options.decorateDirectoryAdapter(delegate);
  }
  return createWorkbenchRuntimeEndpointAdapter(
    delegate,
    async (projectDirectory, requestKind, continuationContext) => {
      const composition = await loadComposition(
        projectDirectory,
        requestKind,
        continuationContext,
      );
      return Object.freeze({
        endpoints: composition.endpoints,
        endpointDiscovery: composition.endpointDiscovery,
      });
    },
    (
      projectDirectory,
      selectionProfile,
    ): WorkbenchResolvedRuntimeResumeIdentity | undefined => {
      const composition = resolvedActiveCompositions.get(
        comparableProjectDirectory(projectDirectory),
      );
      if (composition === undefined) return undefined;
      return resolveRuntimeResumeIdentity(
        composition.registrations,
        selectionProfile,
      );
    },
  );
}

export async function discoverRuntimeEndpointComposition(options: {
  readonly projectDirectory: string;
  readonly codexAdapter?: ResumableAgentRuntimeAdapter;
  readonly claudeAdapter?: ResumableAgentRuntimeAdapter;
  readonly glmAdapter?: ResumableAgentRuntimeAdapter;
  readonly kimiAdapter?: ResumableAgentRuntimeAdapter;
  readonly deepseekAdapter?: ResumableAgentRuntimeAdapter;
  readonly kimiPlatformAdapter?: ResumableAgentRuntimeAdapter;
  readonly claudeApiAdapter?: ResumableAgentRuntimeAdapter;
  readonly codexApiAdapter?: ResumableAgentRuntimeAdapter;
  /** Environment the default GLM adapter reads its token/base URL from. */
  readonly glmEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CLAUDE_CONFIG_DIR for the default GLM adapter. */
  readonly glmConfigDirectory?: string;
  /** Live store-backed GLM token resolver (ADR 0022); env stays the fallback. */
  readonly resolveGlmAuthToken?: () => string | undefined;
  /** Environment the default Kimi adapter reads its token/base URL from. */
  readonly kimiEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CLAUDE_CONFIG_DIR for the default Kimi adapter. */
  readonly kimiConfigDirectory?: string;
  /** Live store-backed Kimi token resolver (ADR 0022); env stays the fallback. */
  readonly resolveKimiAuthToken?: () => string | undefined;
  /** Environment the default DeepSeek adapter reads its token/base URL from. */
  readonly deepseekEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CLAUDE_CONFIG_DIR for the default DeepSeek adapter. */
  readonly deepseekConfigDirectory?: string;
  /** Live store-backed DeepSeek token resolver (ADR 0022); env stays the fallback. */
  readonly resolveDeepseekAuthToken?: () => string | undefined;
  /** Environment the default kimi-platform adapter reads its key from. */
  readonly kimiPlatformEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CODEX_HOME for the default kimi-platform adapter. */
  readonly kimiPlatformCodexHomeDirectory?: string;
  /** Live store-backed kimi-platform key resolver (ADR 0022); env stays the fallback. */
  readonly resolveKimiPlatformApiKey?: () => string | undefined;
  /** Environment the default claude-api adapter reads its key from. */
  readonly claudeApiEnvironment?: NodeJS.ProcessEnv;
  /** Live store-backed claude-api key resolver (ADR 0022); env stays the fallback. */
  readonly resolveClaudeApiKey?: () => string | undefined;
  /** Environment the default codex-api adapter reads its key from. */
  readonly codexApiEnvironment?: NodeJS.ProcessEnv;
  /** Isolated CODEX_HOME for the default codex-api adapter. */
  readonly codexApiCodexHomeDirectory?: string;
  /** Live store-backed codex-api key resolver (ADR 0022); env stays the fallback. */
  readonly resolveCodexApiKey?: () => string | undefined;
  /**
   * Catalog freshness (WO16 Part 3): per-endpoint conservatively enrolled
   * models appended to the static catalog before composition. Applies to the
   * static-key endpoints; returning nothing for an endpoint is the plain
   * static catalog.
   */
  readonly catalogAugmentation?: (
    endpointId: WorkbenchRuntimeEndpointId,
  ) => readonly RuntimeModel[];
  readonly providerRequestBudget?: ProviderRequestBudget;
  readonly claudeDiagnosticObserver?: ClaudeDiagnosticObserver;
}): Promise<RuntimeEndpointCompositionDiscovery> {
  const definitions: readonly RuntimeDefinition[] = Object.freeze([
    Object.freeze({
      endpointId: "codex-desktop",
      preferenceKey: LEGACY_CODEX_DIRECT_SESSION_PROFILE_ENDPOINT_KEY,
      runtimeFamilyLabel: "Codex",
      // Ticket 25 facade: the family carries the brand ("Codex ·
      // Subscription"); the composition label is the short segment name.
      endpointLabel: "Subscription",
      adapter:
        options.codexAdapter ??
        createProductionCodexAdapter(options.providerRequestBudget),
      directStart: "supported" as const,
      desiredNativeDefault: Object.freeze({
        model: "gpt-5.6-sol",
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
    }),
    Object.freeze({
      endpointId: "claude-code-desktop",
      preferenceKey: claudeEndpointPreferenceKey,
      runtimeFamilyLabel: "Claude",
      endpointLabel: "Subscription",
      adapter:
        options.claudeAdapter ??
        new ClaudeAdapter(undefined, undefined, options.providerRequestBudget),
      directStart: "supported" as const,
      diagnosticFromError: claudeDiagnosticFromError,
    }),
    Object.freeze({
      endpointId: "glm-coding-plan",
      preferenceKey: "glm-coding-plan",
      runtimeFamilyLabel: "GLM",
      endpointLabel: "GLM Coding Plan",
      adapter:
        options.glmAdapter ??
        createProductionGlmRuntimeAdapter({
          providerRequestBudget: options.providerRequestBudget,
          environment: options.glmEnvironment,
          configDirectory: options.glmConfigDirectory,
          resolveGlmAuthToken: options.resolveGlmAuthToken,
          ...(options.catalogAugmentation === undefined
            ? {}
            : {
                resolveStaticCatalogAugmentation: () =>
                  options.catalogAugmentation!("glm-coding-plan"),
              }),
        }),
      directStart: "supported" as const,
      // The GLM endpoint's model runtime is served by a remote-backed
      // Anthropic-compatible API through the local claude CLI transport.
      executionLocation: "remote-backed" as const,
      desiredNativeDefault: Object.freeze({
        model: GLM_DEFAULT_MODEL_ID,
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
      diagnosticFromError: claudeDiagnosticFromError,
    }),
    Object.freeze({
      endpointId: "kimi-code",
      preferenceKey: "kimi-code",
      runtimeFamilyLabel: "Kimi",
      // Ticket 20: the facade presents "Kimi · Code"; the label is the short
      // segment name, the family carries the brand.
      endpointLabel: "Code",
      adapter:
        options.kimiAdapter ??
        createProductionKimiRuntimeAdapter({
          providerRequestBudget: options.providerRequestBudget,
          environment: options.kimiEnvironment,
          configDirectory: options.kimiConfigDirectory,
          resolveKimiAuthToken: options.resolveKimiAuthToken,
          ...(options.catalogAugmentation === undefined
            ? {}
            : {
                resolveStaticCatalogAugmentation: () =>
                  options.catalogAugmentation!("kimi-code"),
              }),
        }),
      directStart: "supported" as const,
      // Remote-backed Anthropic-compatible API through the local claude CLI
      // transport, same transport shape as GLM (ticket 11 design of record).
      executionLocation: "remote-backed" as const,
      // The only universally available subscription-face model: k3 needs
      // Moderato+, highspeed needs Allegretto+, kimi-for-coding is every
      // member's default (research §3, §9.6).
      desiredNativeDefault: Object.freeze({
        model: KIMI_DEFAULT_MODEL_ID,
        // k2.7-code has no effort knob (thinking forced on): the single
        // `default` tier, effort deliberately not pinned.
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
      diagnosticFromError: claudeDiagnosticFromError,
    }),
    Object.freeze({
      endpointId: "deepseek-api",
      preferenceKey: "deepseek-api",
      runtimeFamilyLabel: "DeepSeek",
      endpointLabel: "DeepSeek API",
      adapter:
        options.deepseekAdapter ??
        createProductionDeepseekRuntimeAdapter({
          providerRequestBudget: options.providerRequestBudget,
          environment: options.deepseekEnvironment,
          configDirectory: options.deepseekConfigDirectory,
          resolveDeepseekAuthToken: options.resolveDeepseekAuthToken,
          ...(options.catalogAugmentation === undefined
            ? {}
            : {
                resolveStaticCatalogAugmentation: () =>
                  options.catalogAugmentation!("deepseek-api"),
              }),
        }),
      directStart: "supported" as const,
      // Remote-backed Anthropic-compatible API through the local claude CLI
      // transport (ticket 12 design of record).
      executionLocation: "remote-backed" as const,
      desiredNativeDefault: Object.freeze({
        model: DEEPSEEK_DEFAULT_MODEL_ID,
        // This endpoint pins effort explicitly on every session (no
        // `default` tier exists); the vendor-documented default is `high`.
        effortLevel: "high",
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
      diagnosticFromError: claudeDiagnosticFromError,
    }),
    Object.freeze({
      endpointId: "kimi-platform",
      preferenceKey: "kimi-platform",
      runtimeFamilyLabel: "Kimi",
      // Ticket 20: the facade presents "Kimi · 平台"/"Kimi · Platform"; the
      // composition label is the EN segment name (recorded snapshots store
      // it verbatim, like every other endpoint label).
      endpointLabel: "Platform",
      adapter:
        options.kimiPlatformAdapter ??
        createProductionKimiPlatformRuntimeAdapter({
          providerRequestBudget: options.providerRequestBudget,
          environment: options.kimiPlatformEnvironment,
          codexHomeDirectory: options.kimiPlatformCodexHomeDirectory,
          resolveKimiPlatformApiKey: options.resolveKimiPlatformApiKey,
        }),
      directStart: "supported" as const,
      // Remote-backed OpenAI-face API (CN platform, ticket 11 Comments: no
      // anthropic face exists) through the local codex CLI custom-provider
      // transport in its own isolated CODEX_HOME (ticket 17 design of
      // record).
      executionLocation: "remote-backed" as const,
      desiredNativeDefault: Object.freeze({
        model: KIMI_PLATFORM_DEFAULT_MODEL_ID,
        // Single unpinned `default` tier only; the effort mapping through
        // wire_api=chat awaits the supervisor's live spike (ticket 17).
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
    }),
    Object.freeze({
      endpointId: "claude-api",
      preferenceKey: "claude-api",
      runtimeFamilyLabel: "Claude",
      // Ticket 25 facade: short segment name ("Claude · API").
      endpointLabel: "API",
      adapter:
        options.claudeApiAdapter ??
        createProductionClaudeApiRuntimeAdapter({
          providerRequestBudget: options.providerRequestBudget,
          environment: options.claudeApiEnvironment,
          resolveClaudeApiKey: options.resolveClaudeApiKey,
        }),
      directStart: "supported" as const,
      // Remote-backed: the real Anthropic API reached with an injected
      // ANTHROPIC_API_KEY through the local claude CLI transport (ticket 21
      // design of record — the CLI catalog IS the real catalog here, no
      // static override).
      executionLocation: "remote-backed" as const,
      diagnosticFromError: claudeDiagnosticFromError,
    }),
    Object.freeze({
      endpointId: "codex-api",
      preferenceKey: "codex-api",
      runtimeFamilyLabel: "Codex",
      // Ticket 25 facade: short segment name ("Codex · API").
      endpointLabel: "API",
      adapter:
        options.codexApiAdapter ??
        createProductionCodexApiRuntimeAdapter({
          providerRequestBudget: options.providerRequestBudget,
          environment: options.codexApiEnvironment,
          codexHomeDirectory: options.codexApiCodexHomeDirectory,
          resolveCodexApiKey: options.resolveCodexApiKey,
        }),
      directStart: "supported" as const,
      // Remote-backed: the real OpenAI API through the local codex CLI in
      // its own isolated CODEX_HOME (ticket 21 design of record — static
      // gpt-5.x catalog, chatgpt-account gate skipped).
      executionLocation: "remote-backed" as const,
      desiredNativeDefault: Object.freeze({
        model: CODEX_API_DEFAULT_MODEL_ID,
        // Real provider effort values only; `ultra` matches the
        // codex-desktop pick for the same model.
        effortLevel: "ultra",
        executionMode: "single-agent",
        accessMode: "full-access",
      }),
    }),
  ]);

  const inspected = await Promise.all(
    definitions.map(async (definition) => {
      try {
        const nativeCatalog = sanitizeInspectedCatalog(
          await definition.adapter.inspect(options.projectDirectory),
        );
        const catalog =
          options.catalogAugmentation === undefined ||
          (definition.adapter instanceof ClaudeAdapter &&
            definition.adapter.usesStaticCatalogAugmentation())
            ? nativeCatalog
            : mergeStaticCatalogAugmentation(
                nativeCatalog,
                options.catalogAugmentation(definition.endpointId),
              );
        return Object.freeze({
          definition,
          composed: composeEndpointCatalog(definition, catalog),
          category: "catalog-ready" as const,
        });
      } catch (error) {
        if (definition.diagnosticFromError !== undefined) {
          const diagnostic = definition.diagnosticFromError(error);
          if (diagnostic !== undefined) {
            try {
              (options.claudeDiagnosticObserver ?? productionClaudeDiagnosticObserver)(
                diagnostic,
              );
            } catch {
              // Private diagnostics never change endpoint discovery.
            }
          }
        }
        return Object.freeze({
          definition,
          composed: undefined,
          category: discoveryCategoryForFailure(definition.endpointId, error),
        });
      }
    }),
  );
  const available = inspected.filter(
    (
      value,
    ): value is typeof value & {
      readonly composed: NonNullable<typeof value.composed>;
      readonly category: "catalog-ready";
    } => value.composed !== undefined,
  );
  const endpointIds = Object.freeze(
    available.map(({ definition }) => definition.endpointId),
  );
  const registrations: RuntimeEndpointRegistration[] = [];
  const endpoints: WorkbenchDirectRuntimeEndpointCatalog[] = [];

  for (const { definition, composed } of available) {
    registrations.push(
      Object.freeze({
        registrationId: `production-${definition.endpointId}`,
        endpointId: definition.endpointId,
        runtimeFamily: definition.runtimeFamilyLabel,
        executionLocation: definition.executionLocation ?? "local",
        adapter: definition.adapter,
        capabilitySnapshot: Object.freeze({
          snapshotId: `catalog-${definition.endpointId}`,
          freshness: "fresh" as const,
          availability: "online" as const,
          contracts: Object.freeze({
            supervisorWorkOrders: definition.directStart === "supported",
            workerSessions: definition.directStart === "supported",
            normalizedEvents: true,
          }),
          profiles: composed.profiles,
        }),
        policy: Object.freeze({
          maximumBudgetUnits: 1_000_000_000,
          availableConcurrency: 1_000_000,
          allowedAccessModes: Object.freeze(["full-access" as const]),
          allowedWorkerEndpointIds: endpointIds,
        }),
      }),
    );
    endpoints.push(
      Object.freeze({
        endpointId: definition.endpointId,
        preferenceKey: definition.preferenceKey,
        runtimeFamilyLabel: definition.runtimeFamilyLabel,
        endpointLabel: definition.endpointLabel,
        catalog: composed.catalog,
        ...(composed.desiredDefault === undefined
          ? {}
          : { desiredDefault: composed.desiredDefault }),
        directStart: definition.directStart,
      }),
    );
  }
  return Object.freeze({
    registrations: Object.freeze(registrations),
    endpoints: Object.freeze(endpoints),
    endpointDiscovery: publicRuntimeEndpointDiscovery(
      inspected.map((entry) => ({
        endpointId: entry.definition.endpointId,
        category: entry.category,
      })),
    ),
  });
}

function withHistoricalRuntimeResumeProfile(
  base: RuntimeEndpointComposition,
  context: WorkbenchContinuationRuntimeResumeContext,
): RuntimeEndpointComposition {
  if (context.runtimeResumeIdentities.length === 0) return base;
  const matchingMappings = context.runtimeResumeIdentities.filter((mapping) =>
    sameProfile(mapping.selectionProfile, context.recordedProfile),
  );
  // A partial legacy/rollback history may not yet carry an identity for the
  // recorded selection. In that case the first durable identity may still
  // safely anchor the endpoint; exact Directory matching remains responsible
  // for admitting (or rejecting) the identity-less recorded profile.
  const endpointAnchor = matchingMappings[0] ?? context.runtimeResumeIdentities[0]!;
  if (
    matchingMappings.some(
      (candidate) =>
        candidate.endpointId !== endpointAnchor.endpointId ||
        !sameProfile(candidate.nativeProfile, endpointAnchor.nativeProfile),
    )
  ) {
    throw new RuntimeAdapterError("catalog-invalid");
  }

  const mappings: RuntimeResumeIdentityMapping[] = [];
  for (const candidate of context.runtimeResumeIdentities) {
    if (candidate.endpointId !== endpointAnchor.endpointId) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    const existing = mappings.find((mapping) =>
      sameProfile(mapping.selectionProfile, candidate.selectionProfile),
    );
    if (existing === undefined) {
      mappings.push(candidate);
      continue;
    }
    if (!sameProfile(existing.nativeProfile, candidate.nativeProfile)) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
  }

  const registrationIndex = base.registrations.findIndex(
    (candidate) => candidate.endpointId === endpointAnchor.endpointId,
  );
  const endpointIndex = base.endpoints.findIndex(
    (candidate) => candidate.endpointId === endpointAnchor.endpointId,
  );
  // Historical material is an additive continuation aid, never a claim that an
  // endpoint whose current inspection failed is available. The ordinary
  // unavailable path remains authoritative in that case.
  if (registrationIndex < 0 && endpointIndex < 0) return base;
  if (registrationIndex < 0 || endpointIndex < 0) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  let registration = base.registrations[registrationIndex]!;
  let endpoint = base.endpoints[endpointIndex]!;
  let changed = false;
  for (const mapping of mappings) {
    const augmented = augmentHistoricalRuntimeResumeMapping(
      registration,
      endpoint,
      mapping,
    );
    registration = augmented.registration;
    endpoint = augmented.endpoint;
    changed ||= augmented.changed;
  }
  if (!changed) return base;

  const registrations = [...base.registrations];
  registrations[registrationIndex] = registration;
  const endpoints = [...base.endpoints];
  endpoints[endpointIndex] = endpoint;
  const frozenRegistrations = Object.freeze(registrations);
  return Object.freeze({
    adapter: createRuntimeEndpointDirectory(frozenRegistrations).runtimeAdapter(),
    registrations: frozenRegistrations,
    endpoints: Object.freeze(endpoints),
    endpointDiscovery: base.endpointDiscovery,
  });
}

function augmentHistoricalRuntimeResumeMapping(
  registration: RuntimeEndpointRegistration,
  endpoint: WorkbenchDirectRuntimeEndpointCatalog,
  mapping: RuntimeResumeIdentityMapping,
): {
  readonly registration: RuntimeEndpointRegistration;
  readonly endpoint: WorkbenchDirectRuntimeEndpointCatalog;
  readonly changed: boolean;
} {
  const currentProfiles = registration.capabilitySnapshot.profiles;
  const exactCurrentProfiles = currentProfiles.filter((profile) =>
    sameProfile(profile.runtimeProfile, mapping.selectionProfile),
  );
  if (exactCurrentProfiles.length > 1) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  if (exactCurrentProfiles.length === 1) {
    const currentNative =
      exactCurrentProfiles[0]!.nativeRuntimeProfile ??
      exactCurrentProfiles[0]!.runtimeProfile;
    if (!sameProfile(currentNative, mapping.nativeProfile)) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    return Object.freeze({ registration, endpoint, changed: false });
  }

  for (const profile of currentProfiles) {
    const currentNative =
      profile.nativeRuntimeProfile ?? profile.runtimeProfile;
    if (
      profile.runtimeProfile.model === mapping.selectionProfile.model &&
      currentNative.model !== mapping.nativeProfile.model
    ) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    if (
      profile.runtimeProfile.model === mapping.selectionProfile.model &&
      profile.runtimeProfile.effortLevel ===
        mapping.selectionProfile.effortLevel &&
      currentNative.effortLevel !== mapping.nativeProfile.effortLevel
    ) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
  }

  const existingSelectionModel = currentProfiles.find(
    (profile) =>
      profile.runtimeProfile.model === mapping.selectionProfile.model,
  );
  const historicalModelLabel =
    existingSelectionModel?.modelLabel ??
    workbenchModelPresentationLabel(
      endpoint.runtimeFamilyLabel,
      mapping.nativeProfile.model,
    );
  if (!isSafeDisplayText(historicalModelLabel, 160)) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  const isUltracode = isClaudeUltracodeRuntimeProfileProjection(
    mapping.endpointId,
    mapping.selectionProfile,
    mapping.nativeProfile,
  );
  const historicalWorkIntensityLabel = isUltracode
    ? "ultracode"
    : mapping.nativeProfile.effortLevel;
  const historicalProfile: RuntimeEndpointProfileRegistration = Object.freeze({
    profileId: selectionKey(
      "historical-profile",
      mapping.endpointId,
      mapping.selectionProfile.model,
      mapping.selectionProfile.effortLevel,
      mapping.selectionProfile.executionMode,
      mapping.selectionProfile.accessMode,
      mapping.nativeProfile.model,
      mapping.nativeProfile.effortLevel,
    ),
    modelLabel: historicalModelLabel,
    workIntensityLabel: historicalWorkIntensityLabel,
    runtimeProfile: Object.freeze({ ...mapping.selectionProfile }),
    nativeRuntimeProfile: Object.freeze({ ...mapping.nativeProfile }),
  });
  const augmentedRegistration: RuntimeEndpointRegistration = Object.freeze({
    ...registration,
    capabilitySnapshot: Object.freeze({
      ...registration.capabilitySnapshot,
      profiles: Object.freeze([...currentProfiles, historicalProfile]),
    }),
  });

  const models = augmentHistoricalCatalogModels(
    endpoint.catalog.models,
    mapping.selectionProfile,
    mapping.nativeProfile,
    historicalWorkIntensityLabel,
  );
  const historicalCouplings = isUltracode
    ? Object.freeze([
        ...(endpoint.catalog.workIntensityExecutionModeCouplings ?? []),
        Object.freeze({
          model: mapping.selectionProfile.model,
          workIntensity: mapping.selectionProfile.effortLevel,
          executionMode: mapping.selectionProfile.executionMode,
        }),
      ])
    : endpoint.catalog.workIntensityExecutionModeCouplings;
  const augmentedEndpoint: WorkbenchDirectRuntimeEndpointCatalog = Object.freeze({
    ...endpoint,
    catalog: Object.freeze({
      ...endpoint.catalog,
      models,
      ...(historicalCouplings === undefined
        ? {}
        : { workIntensityExecutionModeCouplings: historicalCouplings }),
    }),
  });
  return Object.freeze({
    registration: augmentedRegistration,
    endpoint: augmentedEndpoint,
    changed: true,
  });
}

function augmentHistoricalCatalogModels(
  currentModels: readonly RuntimeModel[],
  selectionProfile: SessionProfile,
  nativeProfile: SessionProfile,
  workIntensityLabel: string,
): readonly RuntimeModel[] {
  const models = [...currentModels];
  const modelIndex = models.findIndex(
    (candidate) => candidate.id === selectionProfile.model,
  );
  if (modelIndex < 0) {
    models.push(
      Object.freeze({
        id: selectionProfile.model,
        resolvedModel: nativeProfile.model,
        displayName: nativeProfile.model,
        effortLevels: Object.freeze([selectionProfile.effortLevel]),
        effortLevelLabels: Object.freeze([workIntensityLabel]),
      }),
    );
    return Object.freeze(models);
  }

  const model = models[modelIndex]!;
  const effortIndex = model.effortLevels.indexOf(selectionProfile.effortLevel);
  if (effortIndex >= 0) return Object.freeze(models);
  if (
    model.effortLevelLabels === undefined ||
    model.effortLevelLabels.length !== model.effortLevels.length
  ) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  models[modelIndex] = Object.freeze({
    id: model.id,
    ...(model.resolvedModel === undefined
      ? {}
      : { resolvedModel: model.resolvedModel }),
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    effortLevels: Object.freeze([
      ...model.effortLevels,
      selectionProfile.effortLevel,
    ]),
    effortLevelLabels: Object.freeze([
      ...model.effortLevelLabels,
      workIntensityLabel,
    ]),
    ...(model.workIntensityLabel === undefined
      ? {}
      : { workIntensityLabel: model.workIntensityLabel }),
  });
  return Object.freeze(models);
}

function resolveRuntimeResumeIdentity(
  registrations: readonly RuntimeEndpointRegistration[],
  selectionProfile: SessionProfile,
): WorkbenchResolvedRuntimeResumeIdentity | undefined {
  const matches: {
    readonly endpointId: string;
    readonly nativeProfile: SessionProfile;
  }[] = [];
  for (const registration of registrations) {
    if (
      registration.capabilitySnapshot.freshness !== "fresh" ||
      registration.capabilitySnapshot.availability !== "online"
    ) {
      continue;
    }
    for (const profile of registration.capabilitySnapshot.profiles) {
      if (!sameProfile(profile.runtimeProfile, selectionProfile)) continue;
      matches.push(
        Object.freeze({
          endpointId: registration.endpointId,
          nativeProfile: Object.freeze({
            ...(profile.nativeRuntimeProfile ?? profile.runtimeProfile),
          }),
        }),
      );
    }
  }
  if (matches.length === 0) return undefined;
  if (
    matches.length !== 1 ||
    !isRegisteredRuntimeEndpointId(matches[0]!.endpointId)
  ) {
    throw new RuntimeAdapterError("unsupported-selection");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    endpointId: matches[0]!.endpointId,
    nativeProfile: Object.freeze({ ...matches[0]!.nativeProfile }),
  });
}

function discoveryCategoryForFailure(
  endpointId: WorkbenchRuntimeEndpointId,
  error: unknown,
): Extract<
  WorkbenchRuntimeEndpointDiscoveryCategory,
  "authentication-required" | "inspection-failed" | "runtime-not-located"
> {
  if (
    error instanceof RuntimeAdapterError &&
    error.category === "runtime-not-located"
  ) {
    return "runtime-not-located";
  }
  if (
    error instanceof RuntimeAdapterError &&
    error.category === "authentication-required"
  ) {
    return "authentication-required";
  }
  return "inspection-failed";
}

function comparableProjectDirectory(projectDirectory: string): string {
  const value = resolve(projectDirectory);
  return process.platform === "win32"
    ? value.toLocaleLowerCase("en-US")
    : value;
}

function captureExactAuthSnapshot(
  authority: Pick<
    WorkLedgerAuthGenerationModule,
    "captureRuntimeEndpointAuthGenerationSnapshot"
  >,
): RuntimeEndpointAuthGenerationSnapshot | undefined {
  let value: unknown;
  try {
    value = authority.captureRuntimeEndpointAuthGenerationSnapshot();
  } catch {
    return undefined;
  }
  if (
    !isExactPlainDataRecord(value, ["claude", "codex"])
  ) {
    return undefined;
  }
  const codex = parseExactAuthContext(value.codex);
  const claude = parseExactAuthContext(value.claude);
  if (
    codex?.endpointId !== "codex-desktop" ||
    claude?.endpointId !== "claude-code-desktop"
  ) {
    return undefined;
  }
  return Object.freeze({ codex, claude });
}

function parseExactAuthContext(
  value: unknown,
): DurableAuthenticationContext | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const management = Object.getOwnPropertyDescriptor(value, "management");
  if (management === undefined || !("value" in management)) return undefined;
  const expectedKeys =
    management.value === "pristine-legacy"
      ? ["endpointId", "management", "schemaVersion"]
      : ["endpointId", "generation", "management", "schemaVersion"];
  return isExactPlainDataRecord(value, expectedKeys)
    ? parseDurableAuthenticationContext(value)
    : undefined;
}

function sameAuthSnapshot(
  left: RuntimeEndpointAuthGenerationSnapshot,
  right: RuntimeEndpointAuthGenerationSnapshot,
): boolean {
  return (
    sameAuthContext(left.codex, right.codex) &&
    sameAuthContext(left.claude, right.claude)
  );
}

function sameAuthContext(
  left: DurableAuthenticationContext,
  right: DurableAuthenticationContext,
): boolean {
  return (
    left.endpointId === right.endpointId &&
    left.management === right.management &&
    (left.management === "pristine-legacy" ||
      left.management === "api-key-static" ||
      (right.management === "managed" &&
        left.generation === right.generation))
  );
}

function isExactPlainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    return (
      keys.length === expectedKeys.length &&
      keys.every(
        (key) => typeof key === "string" && expectedKeys.includes(key),
      ) &&
      expectedKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          "value" in descriptor &&
          descriptor.enumerable
        );
      })
    );
  } catch {
    return false;
  }
}

function composeEndpointCatalog(
  definition: RuntimeDefinition,
  nativeCatalog: RuntimeCatalog,
): {
  readonly catalog: DirectSessionProfileCatalog;
  readonly profiles: readonly RuntimeEndpointProfileRegistration[];
  readonly desiredDefault?: SessionProfile;
} {
  const profiles: RuntimeEndpointProfileRegistration[] = [];
  const workIntensityExecutionModeCouplings: WorkIntensityExecutionModeCoupling[] =
    [];
  const desired = definition.desiredNativeDefault;
  let desiredDefault: SessionProfile | undefined;
  const models: RuntimeModel[] = nativeCatalog.models.map((model) => {
    const modelSelection = selectionKey(
      "model",
      definition.endpointId,
      model.id,
    );
    const resolvedModelIdentity = model.resolvedModel ?? model.id;
    const modelLabel = workbenchModelPresentationLabel(
      definition.runtimeFamilyLabel,
      resolvedModelIdentity,
    );
    if (!isSafeDisplayText(modelLabel, 160)) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    const variants = model.workIntensityVariants ?? [];
    const workIntensities = [
      ...model.effortLevels.map((nativeEffort) =>
        Object.freeze({
          value: nativeEffort,
          label: nativeEffort,
          nativeEffort,
          nativeExecutionMode: undefined as string | undefined,
          executionModes: nativeCatalog.executionModes,
        }),
      ),
      ...variants.map((variant) =>
        Object.freeze({
          value: variant.value,
          label: variant.label,
          nativeEffort: variant.nativeEffortLevel,
          nativeExecutionMode: variant.executionMode,
          executionModes: Object.freeze([variant.baseExecutionMode]),
        }),
      ),
    ];
    const effortSelections = workIntensities.map((intensity) =>
      selectionKey(
        "intensity",
        definition.endpointId,
        model.id,
        intensity.value,
      ),
    );
    for (const [effortIndex, intensity] of workIntensities.entries()) {
      const effortSelection = effortSelections[effortIndex]!;
      const effortLabel = intensity.label;
      if (!isSafeDisplayText(effortLabel, 120)) {
        throw new RuntimeAdapterError("catalog-invalid");
      }
      for (const executionMode of intensity.executionModes) {
        for (const accessMode of nativeCatalog.accessModes) {
          const selectionProfile = Object.freeze({
            model: modelSelection,
            effortLevel: effortSelection,
            executionMode,
            accessMode,
          });
          const nativeRuntimeProfile = Object.freeze({
            model: model.id,
            effortLevel: intensity.nativeEffort,
            executionMode: intensity.nativeExecutionMode ?? executionMode,
            accessMode,
          });
          profiles.push(
            Object.freeze({
              profileId: selectionKey(
                "profile",
                definition.endpointId,
                model.id,
                intensity.value,
                executionMode,
                accessMode,
              ),
              modelLabel,
              workIntensityLabel: effortLabel,
              runtimeProfile: selectionProfile,
              nativeRuntimeProfile,
            }),
          );
          if (
            desired !== undefined &&
            sameProfile(nativeRuntimeProfile, desired)
          ) {
            desiredDefault = selectionProfile;
          }
        }
      }
    }
    for (const [variantIndex, variant] of variants.entries()) {
      workIntensityExecutionModeCouplings.push(
        Object.freeze({
          model: modelSelection,
          workIntensity:
            effortSelections[model.effortLevels.length + variantIndex]!,
          executionMode: variant.baseExecutionMode,
        }),
      );
    }
    return Object.freeze({
      id: modelSelection,
      resolvedModel: resolvedModelIdentity,
      ...(model.displayName === undefined
        ? {}
        : { displayName: model.displayName }),
      effortLevels: Object.freeze(effortSelections),
      effortLevelLabels: Object.freeze(
        workIntensities.map((intensity) => intensity.label),
      ),
      ...(model.workIntensityLabel === undefined
        ? {}
        : { workIntensityLabel: model.workIntensityLabel }),
    });
  });
  return Object.freeze({
    catalog: Object.freeze({
      runtime: "runtime-endpoint-directory",
      models: Object.freeze(models),
      executionModes: Object.freeze([...nativeCatalog.executionModes]),
      accessModes: Object.freeze([...nativeCatalog.accessModes]),
      ...(workIntensityExecutionModeCouplings.length === 0
        ? {}
        : {
            workIntensityExecutionModeCouplings: Object.freeze(
              workIntensityExecutionModeCouplings,
            ),
          }),
    }),
    profiles: Object.freeze(profiles),
    ...(desiredDefault === undefined ? {} : { desiredDefault }),
  });
}

function sanitizeInspectedCatalog(value: unknown): RuntimeCatalog {
  if (
    !isExactRecord(value, [
      "runtime",
      "models",
      "executionModes",
      "accessModes",
    ]) ||
    !isSafeText(value.runtime, 80) ||
    !Array.isArray(value.models) ||
    value.models.length === 0 ||
    !isUniqueSafeTextArray(value.executionModes, 80) ||
    !isUniqueSafeTextArray(value.accessModes, 80) ||
    !value.executionModes.includes("single-agent") ||
    !value.accessModes.includes("full-access")
  ) {
    throw new RuntimeAdapterError("catalog-invalid");
  }
  const executionModes = Object.freeze([...value.executionModes]);
  const seenModels = new Set<string>();
  const models = value.models.map((model): RuntimeModel => {
    if (
      !isRecordWithOptionalKeys(
        model,
        ["id", "effortLevels"],
        [
          "resolvedModel",
          "displayName",
          "effortLevelLabels",
          "workIntensityLabel",
          "workIntensityVariants",
        ],
      ) ||
      !isSafeText(model.id, 240) ||
      seenModels.has(model.id) ||
      !isUniqueSafeTextArray(model.effortLevels, 120) ||
      (model.resolvedModel !== undefined &&
        !isSafeDisplayText(model.resolvedModel, 160)) ||
      (model.displayName !== undefined &&
        !isSafeDisplayText(model.displayName, 200)) ||
      (model.workIntensityLabel !== undefined &&
        !isSafeDisplayText(model.workIntensityLabel, 120)) ||
      (model.effortLevelLabels !== undefined &&
        (!Array.isArray(model.effortLevelLabels) ||
          model.effortLevelLabels.length !== model.effortLevels.length ||
          model.effortLevelLabels.some(
            (label) => label !== null && !isSafeDisplayText(label, 120),
          ))) ||
      (model.workIntensityVariants !== undefined &&
        !isValidWorkIntensityVariants(
          model.workIntensityVariants,
          model.effortLevels,
          executionModes,
        ))
    ) {
      throw new RuntimeAdapterError("catalog-invalid");
    }
    seenModels.add(model.id);
    return Object.freeze({
      id: model.id,
      ...(model.resolvedModel === undefined
        ? {}
        : { resolvedModel: model.resolvedModel }),
      ...(model.displayName === undefined
        ? {}
        : { displayName: model.displayName }),
      effortLevels: Object.freeze([...model.effortLevels]),
      ...(model.effortLevelLabels === undefined
        ? {}
        : {
            effortLevelLabels: Object.freeze([...model.effortLevelLabels]),
          }),
      ...(model.workIntensityLabel === undefined
        ? {}
        : { workIntensityLabel: model.workIntensityLabel }),
      ...(model.workIntensityVariants === undefined
        ? {}
        : {
            workIntensityVariants: Object.freeze(
              model.workIntensityVariants.map((variant) =>
                Object.freeze({
                  value: variant.value,
                  label: variant.label,
                  nativeEffortLevel: variant.nativeEffortLevel,
                  baseExecutionMode: variant.baseExecutionMode,
                  executionMode: variant.executionMode,
                }),
              ),
            ),
          }),
    });
  });
  return Object.freeze({
    runtime: value.runtime,
    models: Object.freeze(models),
    executionModes,
    accessModes: Object.freeze([...value.accessModes]),
  });
}

function isValidWorkIntensityVariants(
  value: unknown,
  nativeEfforts: readonly string[],
  executionModes: readonly string[],
): value is NonNullable<RuntimeModel["workIntensityVariants"]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return false;
  }
  const variantValues = new Set<string>();
  for (const variant of value) {
    if (
      !isRecordWithOptionalKeys(
        variant,
        [
          "value",
          "label",
          "nativeEffortLevel",
          "baseExecutionMode",
          "executionMode",
        ],
        [],
      ) ||
      !isSafeText(variant.value, 120) ||
      !isSafeDisplayText(variant.label, 120) ||
      !isSafeText(variant.nativeEffortLevel, 120) ||
      !isSafeText(variant.baseExecutionMode, 80) ||
      !isSafeText(variant.executionMode, 80) ||
      nativeEfforts.includes(variant.value) ||
      !nativeEfforts.includes(variant.nativeEffortLevel) ||
      !executionModes.includes(variant.baseExecutionMode) ||
      executionModes.includes(variant.executionMode) ||
      variant.baseExecutionMode === variant.executionMode ||
      variantValues.has(variant.value)
    ) {
      return false;
    }
    variantValues.add(variant.value);
  }
  return true;
}

function selectionKey(kind: string, ...values: readonly string[]): string {
  const digest = createHash("sha256")
    .update([selectionNamespace, kind, ...values].join("\0"), "utf8")
    .digest("base64url");
  if (kind === "intensity") return `di_${digest.slice(0, 29)}`;
  if (kind === "model") return `dm_${digest}`;
  return `dp_${digest}`;
}

function sameProfile(left: SessionProfile, right: SessionProfile): boolean {
  return (
    left.model === right.model &&
    left.effortLevel === right.effortLevel &&
    left.executionMode === right.executionMode &&
    left.accessMode === right.accessMode
  );
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecordWithOptionalKeys(value, keys, []);
}

function isRecordWithOptionalKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key)) &&
        Object.getOwnPropertyDescriptor(value, key)?.value !== undefined,
    )
  );
}

function isUniqueSafeTextArray(value: unknown, maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isSafeText(entry, maximum)) &&
    new Set(value).size === value.length
  );
}

function isSafeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

function isSafeDisplayText(value: unknown, maximum: number): value is string {
  return (
    isSafeText(value, maximum) &&
    [...value].length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !value.includes("\\") &&
    !/^(?:[A-Za-z]:[\\/]|\/)/u.test(value) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) &&
    !/^Bearer\s+\S+/iu.test(value) &&
    !/-----BEGIN [A-Z ]+-----/u.test(value) &&
    !/(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu.test(value)
  );
}

const noAvailableRuntimeAdapter: ResumableAgentRuntimeAdapter = Object.freeze({
  async inspect() {
    throw new RuntimeAdapterError("runtime-not-located");
  },
  async start() {
    throw new RuntimeAdapterError("runtime-not-located");
  },
  async resume() {
    throw new RuntimeAdapterError("runtime-not-located");
  },
});
