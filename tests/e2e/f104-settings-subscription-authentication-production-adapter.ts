import {
  classifyClaudeSubscriptionAuthenticationStatus,
  classifyCodexSubscriptionAuthenticationStatus,
  createControlledSubscriptionAuthenticationMutationAuthority,
  createSubscriptionAuthenticationService,
  createWorkbenchSubscriptionAuthenticationCoordinator,
  type SubscriptionAuthenticationChild,
  type SubscriptionAuthenticationEndpointId,
  type SubscriptionAuthenticationProvider,
  type SubscriptionAuthenticationScheduler,
} from "#workbench-f104-production";
import {
  F104_PROVIDER_CASES,
  type F104AcceptanceFactory,
  type F104AuthenticationAction,
  type F104AuthenticationState,
  type F104CatalogLabel,
  type ControlledNativeChild,
  type F104Provider,
  type F104ProviderAdapter,
  type F104ProviderFixture,
} from "../harness/f104-settings-subscription-authentication-acceptance.ts";

/**
 * Blind meeting point. Integration may replace only this adapter with a thin
 * composition of the accepted production seams. The oracle-derived runner and
 * its literals remain unchanged.
 * The historical self-test marker F104_PRODUCTION_ACCEPTANCE_SEAM_NOT_CONNECTED
 * names this meeting point; the factory below now supplies its production seam.
 */
export async function createF104ProductionAcceptanceFactory(): Promise<F104AcceptanceFactory> {
  const providerCompositions = new WeakMap<
    F104ProviderAdapter,
    Readonly<{ provider: SubscriptionAuthenticationProvider }>
  >();
  const factory: F104AcceptanceFactory = {
    providerFixture,
    createProviderAdapter(input) {
      const endpointId = endpointIdFor(input.provider);
      const classify =
        input.provider === "codex"
          ? classifyCodexSubscriptionAuthenticationStatus
          : classifyClaudeSubscriptionAuthenticationStatus;
      const provider: SubscriptionAuthenticationProvider = Object.freeze({
        endpointId,
        async inspectAuthentication(signal: AbortSignal) {
          return classify(await input.transport.readStatus(signal));
        },
        async launchLogin(signal: AbortSignal) {
          return ownControlledChild(
            await input.transport.requestOfficialAction("login", signal),
          );
        },
        async launchLogout(signal: AbortSignal) {
          return ownControlledChild(
            await input.transport.requestOfficialAction("logout", signal),
          );
        },
      });
      const inspectionService = createSubscriptionAuthenticationService({
        providers: Object.freeze([provider]),
        scheduler: Object.freeze({
          setTimeout: (callback: () => void, _milliseconds: number) =>
            input.scheduler.setTimeout(callback),
          clearTimeout: (handle: unknown) =>
            input.scheduler.clearTimeout(handle),
        }),
        timeoutMilliseconds: 600_000,
        inspectionTimeoutMilliseconds: input.inspectionTimeoutMilliseconds,
      });
      const adapter: F104ProviderAdapter = Object.freeze({
        provider: input.provider,
        async inspectAuthentication() {
          const snapshot = await inspectionService.inspect(endpointId);
          return toAcceptanceAuthenticationState(snapshot.authentication);
        },
        launchOfficialAction: async (
          action: F104AuthenticationAction,
        ): Promise<ControlledNativeChild> =>
          input.transport.requestOfficialAction(
            action,
            new AbortController().signal,
          ),
      });
      providerCompositions.set(adapter, Object.freeze({ provider }));
      return adapter;
    },
    createSubject(input) {
      const mutations =
        createControlledSubscriptionAuthenticationMutationAuthority({
          registry: input.registry,
          generations: input.generations,
          transcripts: input.transcripts,
          nextPreparationKey: () => input.opaqueKeys.nextPreparationKey(),
          nextGeneration: () => input.opaqueKeys.nextGeneration(),
        });
      const codexCase = F104_PROVIDER_CASES[0];
      const claudeCase = F104_PROVIDER_CASES[1];
      const codex = input.adapters.get(codexCase.endpointSelectionKey);
      const claude = input.adapters.get(claudeCase.endpointSelectionKey);
      if (codex === undefined || claude === undefined) {
        throw new TypeError("F104 controlled provider adapter missing.");
      }
      const codexComposition = providerCompositions.get(codex);
      const claudeComposition = providerCompositions.get(claude);
      if (codexComposition === undefined || claudeComposition === undefined) {
        throw new TypeError("F104 controlled provider composition missing.");
      }
      const authentication = createSubscriptionAuthenticationService({
        providers: Object.freeze([
          codexComposition.provider,
          claudeComposition.provider,
        ]),
        scheduler: createControlledAcceptanceScheduler(),
        timeoutMilliseconds: 600_000,
        inspectionTimeoutMilliseconds: 10,
      });
      const subject = createWorkbenchSubscriptionAuthenticationCoordinator({
        endpoints: Object.freeze([
          Object.freeze({
            endpointSelectionKey: codexCase.endpointSelectionKey,
            endpointId: "codex-desktop" as const,
            label: codexCase.label,
          }),
          Object.freeze({
            endpointSelectionKey: claudeCase.endpointSelectionKey,
            endpointId: "claude-code-desktop" as const,
            label: claudeCase.label,
          }),
        ]),
        authentication,
        mutations,
      });
      return Object.freeze({
        sanitizePublicRequest: (value: unknown) =>
          subject.sanitizePublicRequest(value),
        sanitizePublicResponse: (value: unknown) =>
          subject.sanitizePublicResponse(value),
        request: (value: unknown) => subject.request(value),
        cancelPreparation: (preparationKey: string) =>
          subject.cancelPreparation(preparationKey),
        renderSettings: async () => subject.renderSettings(),
        setCatalogObservation: (
          endpointSelectionKey: string,
          catalog: F104CatalogLabel,
        ) =>
          subject.setCatalogObservation(endpointSelectionKey, catalog),
        attemptNativeResume: (sessionControlKey: string) =>
          subject.attemptNativeResume(sessionControlKey),
        close: () => subject.close(),
      });
    },
  };
  return Object.freeze(factory);
}

function endpointIdFor(
  provider: F104Provider,
): SubscriptionAuthenticationEndpointId {
  return provider === "codex" ? "codex-desktop" : "claude-code-desktop";
}

function toAcceptanceAuthenticationState(
  value: "bound" | "unbound" | "authentication-required" | "unknown",
): F104AuthenticationState {
  if (value === "bound") return "bound";
  if (value === "unbound" || value === "authentication-required") {
    return "sign-in-required";
  }
  return "unknown";
}

function ownControlledChild(
  child: ControlledNativeChild,
): SubscriptionAuthenticationChild {
  return Object.freeze({
    finished: child.finished,
    async terminate() {
      child.exit(-1);
      await child.finished;
    },
  });
}

function createControlledAcceptanceScheduler(): SubscriptionAuthenticationScheduler {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  return Object.freeze({
    setTimeout(callback: () => void) {
      nextHandle += 1;
      callbacks.set(nextHandle, callback);
      return nextHandle;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
  });
}

function providerFixture(provider: F104Provider): F104ProviderFixture {
  if (provider === "codex") {
    return Object.freeze({
      recognizedBound: Object.freeze({
        account: Object.freeze({ type: "chatgpt" }),
      }),
      recognizedSignInRequired: Object.freeze({ account: null }),
      consumedTopLevelKeys: Object.freeze(["account"]),
      invalidConsumed: Object.freeze([
        Object.freeze({ category: "missing" as const, value: Object.freeze({}) }),
        Object.freeze({
          category: "wrong-type" as const,
          value: Object.freeze({ account: 1 }),
        }),
        Object.freeze({
          category: "unknown-literal" as const,
          value: Object.freeze({
            account: Object.freeze({ type: "future-account-kind" }),
          }),
        }),
        Object.freeze({
          category: "contradictory" as const,
          value: Object.freeze({
            account: Object.freeze({ type: "chatgpt-and-api-key" }),
          }),
        }),
      ]),
    });
  }
  return Object.freeze({
    recognizedBound: Object.freeze({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    }),
    recognizedSignInRequired: Object.freeze({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
    }),
    consumedTopLevelKeys: Object.freeze([
      "loggedIn",
      "authMethod",
      "apiProvider",
    ]),
    invalidConsumed: Object.freeze([
      Object.freeze({
        category: "missing" as const,
        value: Object.freeze({
          loggedIn: false,
          authMethod: "none",
        }),
      }),
      Object.freeze({
        category: "wrong-type" as const,
        value: Object.freeze({
          loggedIn: "false",
          authMethod: "none",
          apiProvider: "firstParty",
        }),
      }),
      Object.freeze({
        category: "unknown-literal" as const,
        value: Object.freeze({
          loggedIn: false,
          authMethod: "future-auth-method",
          apiProvider: "firstParty",
        }),
      }),
      Object.freeze({
        category: "contradictory" as const,
        value: Object.freeze({
          loggedIn: true,
          authMethod: "none",
          apiProvider: "firstParty",
        }),
      }),
    ]),
  });
}
