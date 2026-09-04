import { execFile } from "node:child_process";

import type { SubscriptionAuthenticationState } from "../subscription-authentication.ts";

const maximumAuthenticationStatusBytes = 16_384;

/**
 * Every non-secret field `claude auth status --json` exposes to the Workbench.
 *
 * None of these is account-scoped: `loggedIn` is a bare boolean, `authMethod`
 * names a mechanism (`claude.ai`, `api_key`, `none`), and `apiProvider` names a
 * provider (`firstParty`). No account, email, organization, or token value is
 * read here, and no credential file is opened. Two different signed-in accounts
 * therefore produce byte-identical status, which is why the durable Session
 * discriminator can only be a sign-in *change* detector and never an identity.
 */
export interface ClaudeAuthenticationStatus {
  readonly loggedIn: boolean;
  readonly authMethod: string;
  readonly apiProvider: string;
}

export function readOfficialClaudeAuthenticationStatus(
  executable: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly windowsHide: true;
  },
): Promise<string> {
  return new Promise<string>((resolveOutput, reject) => {
    execFile(
      executable,
      ["auth", "status", "--json"],
      {
        ...options,
        encoding: "utf8",
        maxBuffer: maximumAuthenticationStatusBytes,
      },
      (error, stdout) => {
        if (
          error === null ||
          (typeof error.code === "number" &&
            error.killed !== true &&
            (error.signal === null || error.signal === undefined) &&
            classifyClaudeSubscriptionAuthentication(stdout) ===
              "sign-in-required")
        ) {
          resolveOutput(stdout);
          return;
        }
        reject(error);
      },
    );
  });
}

export function classifyClaudeSubscriptionAuthentication(
  output: string,
): SubscriptionAuthenticationState {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return "unknown";
  }
  return classifyClaudeSubscriptionAuthenticationStatus(value);
}

export function classifyClaudeSubscriptionAuthenticationStatus(
  value: unknown,
): SubscriptionAuthenticationState {
  const status = sanitizeClaudeAuthenticationStatus(value);
  if (status === undefined) return "unknown";
  if (
    status.loggedIn === true &&
    status.authMethod === "claude.ai" &&
    status.apiProvider === "firstParty"
  ) {
    return "bound";
  }
  if (
    status.loggedIn === false &&
    status.authMethod === "none" &&
    status.apiProvider === "firstParty"
  ) {
    return "sign-in-required";
  }
  if (
    status.loggedIn === true &&
    status.authMethod === "api_key" &&
    status.apiProvider === "firstParty"
  ) {
    return "sign-in-required";
  }
  return "unknown";
}

export function parseClaudeAuthenticationStatus(
  output: string,
): ClaudeAuthenticationStatus | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return undefined;
  }
  return sanitizeClaudeAuthenticationStatus(value);
}

function sanitizeClaudeAuthenticationStatus(
  value: unknown,
): ClaudeAuthenticationStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.loggedIn !== "boolean" ||
    typeof candidate.authMethod !== "string" ||
    typeof candidate.apiProvider !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    loggedIn: candidate.loggedIn,
    authMethod: candidate.authMethod,
    apiProvider: candidate.apiProvider,
  });
}
