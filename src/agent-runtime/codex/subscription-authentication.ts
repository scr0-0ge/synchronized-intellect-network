import {
  type SubscriptionAuthenticationChild,
  type SubscriptionAuthenticationProvider,
  type SubscriptionAuthenticationState,
} from "../subscription-authentication.ts";
import {
  createOfficialCodexSubscriptionLoginProcess,
  createOfficialCodexSubscriptionLogoutProcess,
  createOfficialCodexTransport,
} from "./process-transport.ts";
import { CodexJsonlPeer } from "./protocol.ts";
import type { OfficialRuntimeTransport } from "./transport.ts";
import {
  ProviderRequestBudgetError,
  type ProviderRequestBudget,
} from "../provider-request-budget.ts";

export interface CodexSubscriptionAuthenticationDependencies {
  launchLogin(signal: AbortSignal): Promise<SubscriptionAuthenticationChild>;
  /**
   * Spawn `codex logout`. Rejecting must mean no process was created and the
   * device's credentials are untouched, so the caller may skip the
   * irreversible work-ledger auth generation rotation for this action.
   */
  launchLogout(signal: AbortSignal): Promise<SubscriptionAuthenticationChild>;
  createTransport(): Promise<OfficialRuntimeTransport>;
}

const productionDependencies: CodexSubscriptionAuthenticationDependencies =
  Object.freeze({
    launchLogin: (signal: AbortSignal) =>
      createOfficialCodexSubscriptionLoginProcess(undefined, signal),
    launchLogout: (signal: AbortSignal) =>
      createOfficialCodexSubscriptionLogoutProcess(undefined, signal),
    createTransport: createOfficialCodexTransport,
  });

export function createOfficialCodexSubscriptionAuthenticationProvider(
  dependencies: CodexSubscriptionAuthenticationDependencies = productionDependencies,
  providerRequestBudget?: ProviderRequestBudget,
): SubscriptionAuthenticationProvider {
  return Object.freeze({
    endpointId: "codex-desktop" as const,
    launchLogin: (signal: AbortSignal) => {
      if (providerRequestBudget !== undefined) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      return dependencies.launchLogin(signal);
    },
    launchLogout: (signal: AbortSignal) => {
      if (providerRequestBudget !== undefined) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      return dependencies.launchLogout(signal);
    },
    inspectAuthentication: (signal: AbortSignal) =>
      inspectCodexSubscriptionAuthentication(
        dependencies,
        signal,
        providerRequestBudget,
      ),
  });
}

async function inspectCodexSubscriptionAuthentication(
  dependencies: CodexSubscriptionAuthenticationDependencies,
  signal: AbortSignal,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<SubscriptionAuthenticationState> {
  let transport: OfficialRuntimeTransport;
  try {
    transport = await dependencies.createTransport();
  } catch {
    return "unknown";
  }
  const peer = new CodexJsonlPeer(transport, providerRequestBudget);
  let stopPromise: Promise<void> | undefined;
  const stopPeer = (): Promise<void> =>
    (stopPromise ??= peer.stop().catch(() => undefined));
  const stopOnAbort = () => {
    void stopPeer();
  };
  signal.addEventListener("abort", stopOnAbort, { once: true });
  try {
    if (signal.aborted) {
      await stopPeer();
      return "unknown";
    }
    await peer.request("initialize", {
      clientInfo: {
        name: "unified-agent-workbench",
        title: "Synchronized Intellect Network",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    await peer.notify("initialized");
    const result = await peer.request("account/read", { refreshToken: false });
    return classifyCodexSubscriptionAuthenticationStatus(result);
  } catch {
    return "unknown";
  } finally {
    signal.removeEventListener("abort", stopOnAbort);
    await stopPeer();
  }
}

export function classifyCodexSubscriptionAuthenticationStatus(
  value: unknown,
): SubscriptionAuthenticationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "unknown";
  }
  const response = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(response, "account")) {
    return "unknown";
  }
  const account = response.account;
  if (account === null) return "sign-in-required";
  if (typeof account !== "object" || Array.isArray(account)) return "unknown";
  const accountType = (account as Record<string, unknown>).type;
  if (accountType === "chatgpt") return "bound";
  if (accountType === "apiKey") return "sign-in-required";
  return "unknown";
}
