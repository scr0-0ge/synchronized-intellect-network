import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadLineInterface } from "node:readline";

import { RuntimeAdapterError } from "../index.ts";
import type { ProviderRequestBudget } from "../provider-request-budget.ts";
import {
  classifyClaudeSubscriptionAuthentication,
  readOfficialClaudeAuthenticationStatus,
} from "./authentication-status.ts";
import {
  CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES,
  ClaudeDiagnosticError,
  productionClaudeDiagnosticObserver,
  type ClaudeDiagnosticObserver,
} from "./diagnostics.ts";
import type {
  ClaudeCatalogTransport,
  ClaudeSessionTransportRequest,
} from "./transport.ts";

const maximumPathLookupBytes = 16_384;
const maximumPathCandidates = 16;
export const CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BEARER_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const);
export const CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS = Object.freeze([
  "CLAUDECODE",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
] as const);
export const CLAUDE_DEPLOYMENT_SELECTOR_KEYS = Object.freeze([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const);

export type ClaudeDeploymentMode =
  | "subscription"
  | "bedrock"
  | "vertex"
  | "foundry";

const deploymentSelectorByMode: Readonly<
  Record<Exclude<ClaudeDeploymentMode, "subscription">, (typeof CLAUDE_DEPLOYMENT_SELECTOR_KEYS)[number]>
> = Object.freeze({
  bedrock: "CLAUDE_CODE_USE_BEDROCK",
  vertex: "CLAUDE_CODE_USE_VERTEX",
  foundry: "CLAUDE_CODE_USE_FOUNDRY",
});

export const CLAUDE_CATALOG_ARGUMENTS = Object.freeze([
  "--output-format",
  "stream-json",
  "--verbose",
  "--system-prompt",
  "",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--setting-sources=",
  "--input-format",
  "stream-json",
  "--settings",
  '{"ultracode":true}',
  "--effort",
  "xhigh",
] as const);

export const CLAUDE_CATALOG_PROCESS_SHAPE = Object.freeze({
  mode: "headless-stream-json" as const,
  stdin: "pipe" as const,
  stdout: "pipe" as const,
  stderr: "pipe-private-bounded" as const,
  windowsHide: true as const,
  bare: false as const,
  userMessageFrames: 0 as const,
});

export interface ClaudeCatalogProcessDependencies {
  discoverExecutable(): Promise<string>;
  readAuthenticationStatus(
    executable: string,
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly windowsHide: true;
    },
  ): Promise<string>;
  spawnProcess(
    executable: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly stdio: "pipe";
      readonly windowsHide: true;
      readonly shell: false;
    },
  ): ChildProcessWithoutNullStreams;
  readonly environment?: NodeJS.ProcessEnv;
  readonly deploymentMode?: ClaudeDeploymentMode | "auto";
  readonly recordDiagnostic?: ClaudeDiagnosticObserver;
}

const productionDependencies: ClaudeCatalogProcessDependencies = Object.freeze({
  discoverExecutable: discoverClaudeExecutable,
  readAuthenticationStatus: readOfficialClaudeAuthenticationStatus,
  spawnProcess: (
    executable: string,
    arguments_: readonly string[],
    options: Parameters<ClaudeCatalogProcessDependencies["spawnProcess"]>[2],
  ) =>
    spawn(executable, [...arguments_], options),
  environment: process.env,
  deploymentMode: "auto",
  recordDiagnostic: productionClaudeDiagnosticObserver,
});

export async function createOfficialClaudeCatalogTransport(
  projectDirectory: string,
  dependencies: ClaudeCatalogProcessDependencies = productionDependencies,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<ClaudeCatalogTransport> {
  if (!isSafeProcessArgument(projectDirectory)) {
    throw new RuntimeAdapterError("invalid-input");
  }
  let executable: string;
  try {
    executable = await dependencies.discoverExecutable();
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const environment = environmentForClaudeProcess(dependencies);
  await requireClaudeSubscriptionAuthentication(
    executable,
    dependencies,
    environment,
    providerRequestBudget,
  );
  let launched: LaunchedClaudeProcess;
  try {
    launched = await launchClaudeCatalog(
      executable,
      projectDirectory,
      dependencies,
      environment,
    );
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw processLaunchError(error);
  }
  return new ClaudeProcessTransport(launched.child, launched.flushStderr);
}

export async function createOfficialClaudeSessionTransport(
  request: ClaudeSessionTransportRequest,
  dependencies: ClaudeCatalogProcessDependencies = productionDependencies,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<ClaudeCatalogTransport> {
  const ultracode = request.profile.executionMode === "ultracode";
  if (
    !isSafeProcessArgument(request.projectDirectory) ||
    !isSafeProcessArgument(request.profile.model) ||
    !isSafeProcessArgument(request.profile.effortLevel) ||
    request.profile.effortLevel === "ultracode" ||
    (request.profile.executionMode !== "single-agent" && !ultracode) ||
    (ultracode && request.profile.effortLevel !== "xhigh") ||
    request.profile.accessMode !== "full-access" ||
    (request.permissionMode !== "bypassPermissions" &&
      request.permissionMode !== "manual") ||
    (request.resumeSessionIdentity !== undefined &&
      !isSafeProcessArgument(request.resumeSessionIdentity))
  ) {
    throw new RuntimeAdapterError("invalid-input");
  }
  let executable: string;
  try {
    executable = await dependencies.discoverExecutable();
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const environment = environmentForClaudeProcess(dependencies);
  await requireClaudeSubscriptionAuthentication(
    executable,
    dependencies,
    environment,
    providerRequestBudget,
  );
  const arguments_ = createClaudeSessionArguments(request);
  let launched: LaunchedClaudeProcess;
  try {
    launched = await launchClaude(
      executable,
      request.projectDirectory,
      arguments_,
      dependencies,
      environment,
    );
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw processLaunchError(error);
  }
  return new ClaudeProcessTransport(launched.child, launched.flushStderr);
}

export function createClaudeSessionArguments(
  request: ClaudeSessionTransportRequest,
): readonly string[] {
  const ultracode = request.profile.executionMode === "ultracode";
  return Object.freeze([
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--model",
    request.profile.model,
    ...(request.profile.effortLevel === "default"
      ? []
      : ["--effort", request.profile.effortLevel]),
    "--settings",
    ultracode ? '{"ultracode":true}' : '{"ultracode":false}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources=",
    "--permission-mode",
    request.permissionMode,
    ...(request.permissionMode === "bypassPermissions"
      ? ["--allow-dangerously-skip-permissions"]
      : ["--permission-prompt-tool", "stdio"]),
    ...(request.resumeSessionIdentity === undefined
      ? []
      : [`--resume=${request.resumeSessionIdentity}`]),
  ]);
}

export async function discoverClaudeExecutable(): Promise<string> {
  if (process.platform !== "win32") return "claude";

  const candidates = new Map<string, string>();
  for (const candidate of await lookupWindowsPath()) {
    const validated = await validateNativeExecutable(candidate);
    if (validated !== undefined) {
      candidates.set(validated.toLocaleLowerCase("en-US"), validated);
    }
  }
  if (candidates.size > 1) {
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const pathCandidate = candidates.values().next().value as string | undefined;
  if (pathCandidate !== undefined) return pathCandidate;

  const officialCandidate = await validateNativeExecutable(
    join(homedir(), ".local", "bin", "claude.exe"),
  );
  if (officialCandidate !== undefined) return officialCandidate;
  throw new RuntimeAdapterError("runtime-not-located");
}

async function lookupWindowsPath(): Promise<readonly string[]> {
  try {
    const output = await new Promise<string>((resolveOutput, reject) => {
      execFile(
        "where.exe",
        ["claude.exe"],
        {
          encoding: "utf8",
          maxBuffer: maximumPathLookupBytes,
          windowsHide: true,
        },
        (error, stdout) => (error ? reject(error) : resolveOutput(stdout)),
      );
    });
    const values = output
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return values.length > maximumPathCandidates ? [] : Object.freeze(values);
  } catch {
    return Object.freeze([]);
  }
}

async function validateNativeExecutable(
  candidate: string,
): Promise<string | undefined> {
  if (
    !isAbsolute(candidate) ||
    !candidate.toLocaleLowerCase("en-US").endsWith(".exe")
  ) {
    return undefined;
  }
  try {
    const lexical = resolve(candidate);
    const information = await lstat(lexical);
    if (!information.isFile() || information.isSymbolicLink()) return undefined;
    const resolved = await realpath(lexical);
    return isAbsolute(resolved) &&
      resolved.toLocaleLowerCase("en-US").endsWith(".exe")
      ? resolved
      : undefined;
  } catch {
    return undefined;
  }
}

function launchClaudeCatalog(
  executable: string,
  projectDirectory: string,
  dependencies: ClaudeCatalogProcessDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<LaunchedClaudeProcess> {
  return launchClaude(
    executable,
    projectDirectory,
    CLAUDE_CATALOG_ARGUMENTS,
    dependencies,
    environment,
  );
}

function isSafeProcessArgument(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    value.trim().length > 0 &&
    !value.includes("\0")
  );
}

interface LaunchedClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly flushStderr: () => void;
}

function launchClaude(
  executable: string,
  projectDirectory: string,
  arguments_: readonly string[],
  dependencies: ClaudeCatalogProcessDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<LaunchedClaudeProcess> {
  return new Promise((resolveChild, reject) => {
    const child = dependencies.spawnProcess(
      executable,
      arguments_,
      Object.freeze({
        cwd: projectDirectory,
        env: environment,
        stdio: "pipe",
        windowsHide: true,
        shell: false,
      }),
    );
    const flushStderr = observeClaudeStderr(child, dependencies.recordDiagnostic);
    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.on("error", () => undefined);
      resolveChild(Object.freeze({ child, flushStderr }));
    });
  });
}

async function requireClaudeSubscriptionAuthentication(
  executable: string,
  dependencies: ClaudeCatalogProcessDependencies,
  environment: NodeJS.ProcessEnv,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<void> {
  let output: string;
  await providerRequestBudget?.claim("claude-auth-status");
  try {
    output = await dependencies.readAuthenticationStatus(
      executable,
      Object.freeze({
        env: environment,
        windowsHide: true as const,
      }),
    );
  } catch (error) {
    throw new ClaudeDiagnosticError("runtime-unavailable", {
      kind: "authentication-status",
      category: "runtime-unavailable",
      state: "unknown",
      detail: privateErrorDetail(error),
    });
  }
  const authentication = classifyClaudeSubscriptionAuthentication(output);
  if (authentication === "unknown") {
    throw new ClaudeDiagnosticError("protocol-invalid", {
      kind: "authentication-status",
      category: "protocol-invalid",
      state: authentication,
      detail: output,
    });
  }
  if (authentication !== "bound") {
    throw new ClaudeDiagnosticError("authentication-required", {
      kind: "authentication-status",
      category: "authentication-required",
      state: authentication,
      detail: output,
    });
  }
}

export function createClaudeOAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of [
    ...CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS,
    ...CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS,
    ...CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  ]) {
    delete environment[key];
  }
  return environment;
}

export function createClaudeProcessEnvironment(
  source: NodeJS.ProcessEnv,
  mode: ClaudeDeploymentMode,
): NodeJS.ProcessEnv {
  const environment = createClaudeOAuthEnvironment(source);
  if (mode !== "subscription") {
    const key = deploymentSelectorByMode[mode];
    const value = source[key];
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.includes("\0")
    ) {
      throw new RuntimeAdapterError("invalid-input");
    }
    environment[key] = value;
  }
  environment.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  environment.CLAUDE_AGENT_SDK_VERSION = "0.3.220";
  return environment;
}

export function resolveClaudeDeploymentMode(
  source: NodeJS.ProcessEnv,
): ClaudeDeploymentMode {
  const selected = CLAUDE_DEPLOYMENT_SELECTOR_KEYS.filter((key) => {
    const value = source[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (selected.length === 0) return "subscription";
  if (selected.length !== 1) throw new RuntimeAdapterError("invalid-input");
  if (selected[0] === "CLAUDE_CODE_USE_BEDROCK") return "bedrock";
  if (selected[0] === "CLAUDE_CODE_USE_VERTEX") return "vertex";
  return "foundry";
}

function environmentForClaudeProcess(
  dependencies: ClaudeCatalogProcessDependencies,
): NodeJS.ProcessEnv {
  const source = dependencies.environment ?? process.env;
  const configuredMode = dependencies.deploymentMode ?? "subscription";
  const mode = configuredMode === "auto"
    ? resolveClaudeDeploymentMode(source)
    : configuredMode;
  return Object.freeze(createClaudeProcessEnvironment(source, mode));
}

function processLaunchError(error: unknown): ClaudeDiagnosticError {
  return new ClaudeDiagnosticError("runtime-unavailable", {
    kind: "process-launch-rejected",
    category: "runtime-unavailable",
    errorCode: nativeErrorCode(error),
    detail: privateErrorDetail(error),
  });
}

function nativeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function privateErrorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return "unserializable-error";
  }
}

function observeClaudeStderr(
  child: ChildProcessWithoutNullStreams,
  observer: ClaudeDiagnosticObserver | undefined,
): () => void {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let flushed = false;
  child.stderr.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    totalBytes += bytes.length;
    const remaining = CLAUDE_DIAGNOSTIC_DETAIL_MAXIMUM_BYTES - capturedBytes;
    if (remaining <= 0) return;
    const retained = bytes.subarray(0, remaining);
    chunks.push(retained);
    capturedBytes += retained.length;
  });
  const flush = () => {
    if (flushed) return;
    flushed = true;
    if (totalBytes === 0 || observer === undefined) return;
    try {
      observer(
        Object.freeze({
          kind: "child-stderr" as const,
          category: "runtime-unavailable" as const,
          capturedBytes,
          omittedBytes: Math.max(0, totalBytes - capturedBytes),
          detail: Buffer.concat(chunks, capturedBytes).toString("utf8"),
        }),
      );
    } catch {
      // Diagnostics are observational and never control the child.
    }
  };
  child.stderr.once("end", flush);
  child.stderr.once("close", flush);
  child.stderr.once("error", flush);
  return flush;
}

class ClaudeProcessTransport implements ClaudeCatalogTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader: ReadLineInterface;
  readonly #lines: AsyncIterator<string>;
  readonly #flushStderr: () => void;
  #stopPromise: Promise<void> | undefined;

  constructor(child: ChildProcessWithoutNullStreams, flushStderr: () => void) {
    this.#child = child;
    this.#flushStderr = flushStderr;
    this.#reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.#lines = this.#reader[Symbol.asyncIterator]();
  }

  async send(line: string): Promise<void> {
    await new Promise<void>((resolveWrite, reject) => {
      this.#child.stdin.write(`${line}\n`, (error) =>
        error ? reject(error) : resolveWrite(),
      );
    });
  }

  async receive(): Promise<string | null> {
    const result = await this.#lines.next();
    return result.done ? null : result.value;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopOnce();
    return this.#stopPromise;
  }

  async #stopOnce(): Promise<void> {
    try {
      try {
        this.#child.stdin.end();
      } catch {
        // Termination escalation below is authoritative.
      }
      this.#reader.close();
      this.#child.stdout.resume();
      if (await waitForExit(this.#child, 5_000)) return;
      try {
        this.#child.kill();
      } catch {
        throw new RuntimeAdapterError("runtime-shutdown");
      }
      if (!(await waitForExit(this.#child, 5_000))) {
        throw new RuntimeAdapterError("runtime-shutdown");
      }
    } finally {
      this.#flushStderr();
    }
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolveWait) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      resolveWait(false);
    }, timeoutMilliseconds);
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveWait(true);
    };
    child.once("exit", onExit);
  });
}
