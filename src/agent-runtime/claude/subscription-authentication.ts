import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import {
  observeSubscriptionSignInUrl,
  ownSubscriptionAuthenticationProcess,
  waitForSubscriptionAuthenticationProcessSpawn,
  type SubscriptionAuthenticationProvider,
} from "../subscription-authentication.ts";
import {
  classifyClaudeSubscriptionAuthentication,
  readOfficialClaudeAuthenticationStatus,
} from "./authentication-status.ts";
import {
  createClaudeOAuthEnvironment,
  discoverClaudeLaunch,
} from "./process-transport.ts";
import type { WindowsRuntimeLaunch } from "../windows-executable-admission.ts";
import type { ProviderRequestBudget } from "../provider-request-budget.ts";
import { ProviderRequestBudgetError } from "../provider-request-budget.ts";

/**
 * How the launched authentication process's streams are wired.
 *
 * `logout` keeps `"ignore"`. `login` is read, because `claude auth login`
 * prints the authorisation URL ("If the browser did not open, visit:") as the
 * fallback for a machine where the browser never appeared, and discarding that
 * line is what public issue #4 is about. `windowsHide: true` is unchanged: the
 * console it hides is the CLI's own, never the browser, which is a separate
 * process the flag cannot reach.
 */
export type ClaudeSubscriptionLoginStdio =
  | "ignore"
  | ["ignore", "pipe", "pipe"];

export interface ClaudeSubscriptionAuthenticationDependencies {
  discoverExecutable(): Promise<WindowsRuntimeLaunch>;
  readAuthenticationStatus(
    launch: WindowsRuntimeLaunch,
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly signal: AbortSignal;
      readonly windowsHide: true;
    },
  ): Promise<string>;
  spawnProcess(
    executable: string,
    arguments_: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly shell: false;
      readonly stdio: ClaudeSubscriptionLoginStdio;
      readonly windowsHide: true;
    },
  ): ChildProcess;
  readonly environment: NodeJS.ProcessEnv;
}

const productionDependencies: ClaudeSubscriptionAuthenticationDependencies =
  Object.freeze({
    discoverExecutable: discoverClaudeLaunch,
    readAuthenticationStatus: readOfficialClaudeAuthenticationStatus,
    spawnProcess: (
      executable: string,
      arguments_: readonly string[],
      options: Parameters<
        ClaudeSubscriptionAuthenticationDependencies["spawnProcess"]
      >[2],
    ) => spawn(executable, [...arguments_], options),
    environment: process.env,
  });

export function createOfficialClaudeSubscriptionAuthenticationProvider(
  dependencies: ClaudeSubscriptionAuthenticationDependencies = productionDependencies,
  providerRequestBudget?: ProviderRequestBudget,
): SubscriptionAuthenticationProvider {
  return Object.freeze({
    endpointId: "claude-code-desktop" as const,
    launchLogin: (signal: AbortSignal) => {
      if (providerRequestBudget !== undefined) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      return launchClaudeAuthenticationAction("login", dependencies, signal);
    },
    launchLogout: (signal: AbortSignal) => {
      if (providerRequestBudget !== undefined) {
        throw new ProviderRequestBudgetError("unknown-operation");
      }
      return launchClaudeAuthenticationAction("logout", dependencies, signal);
    },
    async inspectAuthentication(signal: AbortSignal) {
      try {
        assertAuthenticationLaunchOpen(signal);
        const executable = await dependencies.discoverExecutable();
        assertAuthenticationLaunchOpen(signal);
        await providerRequestBudget?.claim("claude-auth-status");
        const output = await dependencies.readAuthenticationStatus(
          executable,
          Object.freeze({
            env: Object.freeze(
              createClaudeOAuthEnvironment(dependencies.environment),
            ),
            signal,
            windowsHide: true as const,
          }),
        );
        return classifyClaudeSubscriptionAuthentication(output);
      } catch {
        return "unknown";
      }
    },
  });
}

/**
 * Discover the Claude executable and spawn `claude auth <action>`.
 *
 * Every failure path here — no executable, a rejected spawn, a cancellation —
 * rejects before the child can touch the device's credentials, so the caller
 * may treat a rejection as "the log out did not happen" and skip the
 * irreversible work-ledger auth generation rotation entirely.
 */
async function launchClaudeAuthenticationAction(
  action: "login" | "logout",
  dependencies: ClaudeSubscriptionAuthenticationDependencies,
  signal: AbortSignal,
): Promise<ReturnType<typeof ownSubscriptionAuthenticationProcess>> {
  assertAuthenticationLaunchOpen(signal);
  const launch = await dependencies.discoverExecutable();
  assertAuthenticationLaunchOpen(signal);
  // The THIRD launch site on the Claude path. Same rule: prefix arguments
  // first, argv stays an array, no shell.
  const child = dependencies.spawnProcess(
    launch.executable,
    Object.freeze([...launch.prefixArguments, "auth", action]),
    Object.freeze({
      env: Object.freeze(createClaudeOAuthEnvironment(dependencies.environment)),
      shell: false as const,
      stdio:
        action === "login"
          ? (["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"])
          : ("ignore" as const),
      windowsHide: true as const,
    }),
  );
  // Attached before the spawn is awaited: the CLI prints its sign-in URL within
  // a moment of starting, and a listener added afterwards can miss the chunk
  // that carries it.
  const signInUrl =
    action === "login" ? observeSubscriptionSignInUrl(child) : undefined;
  await waitForSubscriptionAuthenticationProcessSpawn(child);
  const owned = ownSubscriptionAuthenticationProcess(
    child,
    undefined,
    signInUrl,
  );
  if (signal.aborted) {
    await owned.terminate();
    throw new Error("Subscription authentication launch was cancelled.");
  }
  return owned;
}

function assertAuthenticationLaunchOpen(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Subscription authentication launch was cancelled.");
  }
}
