import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadLineInterface } from "node:readline";

import { RuntimeAdapterError } from "../index.ts";
import type { SessionProfile } from "../index.ts";
import { configuredRuntimeExecutable } from "../configured-executable.ts";
import { CLAUDE_RUNTIME_LOOKUP_SURFACE } from "../runtime-lookup-surface.ts";
import {
  admitLaunchTarget,
  admitNativeExecutable,
  lookupOnPathBounded,
  productionWindowsAdmissionDependencies,
  resolveNpmGlobalLaunch,
  type WindowsRuntimeLaunch,
} from "../windows-executable-admission.ts";
import type { ProviderRequestBudget } from "../provider-request-budget.ts";
import {
  readOfficialClaudeAuthenticationStatus,
} from "./authentication-status.ts";
import {
  classifyClaudeAuthenticationForMode,
  type ClaudeApiKeyStaticHealthyAuthMethod,
  type ClaudeEndpointAuthenticationMode,
} from "./endpoint-authentication.ts";
import {
  CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  ClaudeEndpointEnvironmentError,
  createClaudeOAuthEnvironment,
  createEndpointProcessEnvironment,
  type ClaudeEndpointEnvironmentSource,
} from "./endpoint-env-factory.ts";
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

// The environment key lists and OAuth cleansing moved to the per-endpoint
// environment factory; they are re-exported here so existing importers keep
// their single source of truth.
export {
  CLAUDE_CREDENTIAL_ENVIRONMENT_KEYS,
  CLAUDE_PROFILE_OVERRIDE_ENVIRONMENT_KEYS,
  CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  createClaudeOAuthEnvironment,
} from "./endpoint-env-factory.ts";

const maximumPathLookupBytes = 16_384;
const maximumPathCandidates = 16;
// main-resync: main defined the three env-key lists inline here; the lane had
// already moved them, byte-identical, into endpoint-env-factory.ts and
// re-exports them above. The factory stays the single source of truth so only
// main's managed-version scan bounds are kept from this hunk.
const maximumManagedVersionEntries = 256;
const managedVersionPattern = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/u;

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
  discoverExecutable(): Promise<WindowsRuntimeLaunch>;
  readAuthenticationStatus(
    launch: WindowsRuntimeLaunch,
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
  /**
   * Per-endpoint spawn environment (spec section A). When set, every spawn
   * (and the auth-status preflight) is env-built through the generic
   * endpoint factory instead of the historical subscription/selector logic;
   * the historical path stays byte-identical when this is undefined.
   */
  readonly endpointEnvironment?: ClaudeEndpointEnvironmentSource;
  /** Per-endpoint authentication semantics for the auth-status gate. */
  readonly authenticationMode?: ClaudeEndpointAuthenticationMode;
  /**
   * api-key-static endpoints: which `authMethod` the healthy auth-status
   * shape carries (GLM/Kimi/DeepSeek: `oauth_token`; claude-api: `api_key`).
   */
  readonly apiKeyStaticHealthyAuthMethod?: ClaudeApiKeyStaticHealthyAuthMethod;
}

// main-resync: the lane exports this bundle (tests reference it by name);
// main's identical-but-unexported `productionDependencies` was the same bundle
// wired to the launch-based discovery the merged interface now requires, so
// the exported name is kept and pointed at `discoverClaudeLaunch`.
export const productionClaudeCatalogProcessDependencies: ClaudeCatalogProcessDependencies =
  Object.freeze({
    discoverExecutable: discoverClaudeLaunch,
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
  dependencies: ClaudeCatalogProcessDependencies = productionClaudeCatalogProcessDependencies,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<ClaudeCatalogTransport> {
  if (!isSafeProcessArgument(projectDirectory)) {
    throw new RuntimeAdapterError("invalid-input");
  }
  let launch: WindowsRuntimeLaunch;
  try {
    launch = await dependencies.discoverExecutable();
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const environment = resolveClaudeProcessEnvironment(dependencies);
  await requireClaudeSubscriptionAuthentication(
    launch,
    dependencies,
    environment,
    providerRequestBudget,
  );
  let launched: LaunchedClaudeProcess;
  try {
    launched = await launchClaudeCatalog(
      launch,
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
  dependencies: ClaudeCatalogProcessDependencies = productionClaudeCatalogProcessDependencies,
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
  let launch: WindowsRuntimeLaunch;
  try {
    launch = await dependencies.discoverExecutable();
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error;
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const environment = resolveClaudeProcessEnvironment(
    dependencies,
    request.profile,
  );
  await requireClaudeSubscriptionAuthentication(
    launch,
    dependencies,
    environment,
    providerRequestBudget,
  );
  const arguments_ = createClaudeSessionArguments(request);
  let launched: LaunchedClaudeProcess;
  try {
    launched = await launchClaude(
      launch,
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
    "--include-partial-messages",
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

/**
 * Where Claude Code is, described so that a JavaScript entry point can start.
 *
 * The order is deliberate. A path the user supplied comes FIRST, because it is
 * the answer to a lookup that has already failed them once and nothing the
 * product guesses should outrank it. Then PATH -- asked with the BARE command
 * name so `where.exe` consults `PATHEXT` and can finally see the `.cmd` an
 * `npm install -g` writes. Then `%APPDATA%\npm` directly, because an Electron
 * app launched from Explorer inherits the PATH from login, which is how a user
 * whose `claude --version` works in their terminal still got told nothing was
 * installed. Then the two locations that already worked.
 *
 * Candidates are deduplicated BY RESOLVED LAUNCH, not by candidate string: one
 * npm install puts `claude` and `claude.cmd` in the same directory and a bare
 * lookup returns both, so string-deduplication would report an ambiguity where
 * there is one install.
 */
export async function discoverClaudeLaunch(): Promise<WindowsRuntimeLaunch> {
  if (process.platform !== "win32") return nativeLaunch("claude");

  const surface = CLAUDE_RUNTIME_LOOKUP_SURFACE;
  const admission = productionWindowsAdmissionDependencies;

  const configured = configuredRuntimeExecutable("claude");
  if (configured !== undefined) {
    const admitted = await admitLaunchTarget(configured, surface, admission);
    // A stored path that has stopped working falls through to ordinary
    // discovery rather than stranding the user on their own old answer.
    if (admitted.kind === "admitted") return admitted.launch;
  }

  const launches = new Map<string, WindowsRuntimeLaunch>();
  for (const candidate of await lookupWindowsPath()) {
    const admitted = await admitLaunchTarget(candidate, surface, admission);
    if (admitted.kind === "admitted") {
      launches.set(launchKey(admitted.launch), admitted.launch);
    }
  }
  if (launches.size > 1) {
    throw new RuntimeAdapterError("runtime-not-located");
  }
  const pathLaunch = launches.values().next().value as
    | WindowsRuntimeLaunch
    | undefined;
  if (pathLaunch !== undefined) return pathLaunch;

  const prefix = npmGlobalPrefix();
  if (prefix !== undefined) {
    const admitted = await resolveNpmGlobalLaunch(prefix, surface, admission);
    if (admitted.kind === "admitted") return admitted.launch;
  }

  const officialCandidate = await validateNativeExecutable(
    join(homedir(), ".local", "bin", "claude.exe"),
  );
  if (officialCandidate !== undefined) return nativeLaunch(officialCandidate);

  const managedCandidate = await discoverManagedClaudeExecutable();
  if (managedCandidate !== undefined) return nativeLaunch(managedCandidate);

  throw new RuntimeAdapterError("runtime-not-located");
}

/**
 * The executable alone, for callers that only need to know a runtime is there.
 * A JavaScript entry point cannot be started from this value; use
 * `discoverClaudeLaunch` to start one.
 */
export async function discoverClaudeExecutable(): Promise<string> {
  return (await discoverClaudeLaunch()).executable;
}

export function nativeLaunch(executable: string): WindowsRuntimeLaunch {
  return Object.freeze({
    executable,
    prefixArguments: Object.freeze([]),
  });
}

function launchKey(launch: WindowsRuntimeLaunch): string {
  return [launch.executable, ...launch.prefixArguments]
    .join(" ")
    .toLocaleLowerCase("en-US");
}

/**
 * `%APPDATA%\npm` is where npm puts a global install's shims on Windows. The
 * fallback mirrors `claudeManagedRoots`: an absent or relative APPDATA means
 * the roaming profile is derived from the home directory rather than trusted.
 */
function npmGlobalPrefix(): string | undefined {
  const roaming = process.env.APPDATA;
  const base =
    typeof roaming === "string" && roaming.length > 0 && isAbsolute(roaming)
      ? roaming
      : join(homedir(), "AppData", "Roaming");
  return join(base, "npm");
}

// Claude Code installed by the Claude desktop app is not on PATH and is not in
// ~/.local/bin. It lands in a per-version directory under the roaming profile,
// and an upgrade leaves the previous version behind rather than deleting it. So
// the rule here cannot be Codex's "more than one candidate means ambiguous":
// more than one is the NORMAL state of this directory. The newest version that
// validates is the one to drive.
//
// The desktop APPLICATION also ships a claude.exe, under
// %LOCALAPPDATA%\AnthropicClaude. That one is the GUI, not the CLI, and driving
// it would fail in a way no error message would explain. Only the roots below
// are searched, and a resolved candidate must still land inside the root it was
// found under -- a junction in a version directory cannot point discovery out.
function claudeManagedRoots(): readonly string[] {
  const roaming = process.env.APPDATA;
  const base =
    typeof roaming === "string" && roaming.length > 0 && isAbsolute(roaming)
      ? roaming
      : join(homedir(), "AppData", "Roaming");
  return Object.freeze([join(base, "Claude", "claude-code")]);
}

async function discoverManagedClaudeExecutable(): Promise<string | undefined> {
  for (const root of claudeManagedRoots()) {
    const resolvedRoot = await resolveExistingDirectory(root);
    if (resolvedRoot === undefined) continue;
    for (const version of await readManagedVersionDirectories(root)) {
      const validated = await validateNativeExecutable(
        join(root, version, "claude.exe"),
      );
      if (validated !== undefined && isContainedIn(validated, resolvedRoot)) {
        return validated;
      }
    }
  }
  return undefined;
}

// Newest first, so a half-written upgrade that fails validation falls through to
// the version that was working before it.
//
// Two rules here exist so that this scan cannot reintroduce the not-located
// failure it was written to remove:
//
//   - A name this scan cannot parse is RANKED LAST, not dropped. A directory
//     named for a prerelease, or with four parts, or two, is still a place a
//     runtime can be; dropping it means a user whose only install is named that
//     way is told their working Claude Code does not exist.
//
//   - The bound is a SLICE, not a cliff. An upgrade leaves the previous version
//     behind, so this directory only ever grows. Abandoning the scan once it
//     holds too many entries would mean the fix expires on exactly the machines
//     that have been running Claude Code the longest.
async function readManagedVersionDirectories(
  root: string,
): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(root);
  } catch {
    return Object.freeze([]);
  }
  const ordered = names
    .map((name) => ({ name, order: parseManagedVersion(name) }))
    .sort(compareManagedEntries)
    .slice(0, maximumManagedVersionEntries)
    .map((entry) => entry.name);
  return Object.freeze(ordered);
}

function compareManagedEntries(
  left: { readonly name: string; readonly order: readonly number[] | undefined },
  right: { readonly name: string; readonly order: readonly number[] | undefined },
): number {
  if (left.order !== undefined && right.order !== undefined) {
    return compareManagedVersions(right.order, left.order);
  }
  if (left.order !== undefined) return -1;
  if (right.order !== undefined) return 1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? 1 : -1;
}

function parseManagedVersion(name: string): readonly number[] | undefined {
  const matched = managedVersionPattern.exec(name);
  if (matched === null) return undefined;
  return Object.freeze([
    Number(matched[1]),
    Number(matched[2]),
    Number(matched[3]),
  ]);
}

function compareManagedVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Resolved first, then required to be a directory -- rather than refused for
// being a link. Relocating AppData to another drive leaves a junction at this
// exact path, and refusing it would hide a perfectly good install behind it.
// Nothing is given up by allowing it: containment below is checked against the
// RESOLVED root, so a junction inside a version directory that points out of
// the tree is still rejected.
async function resolveExistingDirectory(
  candidate: string,
): Promise<string | undefined> {
  if (!isAbsolute(candidate)) return undefined;
  try {
    const resolved = await realpath(candidate);
    if (!isAbsolute(resolved)) return undefined;
    const information = await stat(resolved);
    return information.isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isContainedIn(candidate: string, root: string): boolean {
  const normalizedRoot = root
    .toLocaleLowerCase("en-US")
    .replace(/[\\/]+$/u, "");
  if (normalizedRoot.length === 0) return false;
  return candidate
    .toLocaleLowerCase("en-US")
    .startsWith(`${normalizedRoot}\\`);
}

/**
 * Ask for the BARE command name. That is the whole difference: given an
 * explicit extension `where.exe` does not consult `PATHEXT`, so `claude.exe`
 * could never see the `claude.cmd` and extensionless shim that an
 * `npm install -g @anthropic-ai/claude-code` actually writes. Given the bare
 * name it returns every `PATHEXT` match and the extensionless script too.
 */
async function lookupWindowsPath(): Promise<readonly string[]> {
  const values = await lookupOnPathBounded(CLAUDE_RUNTIME_LOOKUP_SURFACE.command);
  return values.length > maximumPathCandidates ? Object.freeze([]) : values;
}

/**
 * Unchanged in strictness -- delegated to the shared admission gate so that a
 * candidate found here, a candidate found by the Codex lookup, and a path a
 * user typed into Settings all pass through exactly one implementation of
 * "this is a real native executable".
 */
async function validateNativeExecutable(
  candidate: string,
): Promise<string | undefined> {
  const admitted = await admitNativeExecutable(
    candidate,
    productionWindowsAdmissionDependencies,
  );
  return admitted.kind === "admitted" ? admitted.path : undefined;
}

function launchClaudeCatalog(
  launch: WindowsRuntimeLaunch,
  projectDirectory: string,
  dependencies: ClaudeCatalogProcessDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<LaunchedClaudeProcess> {
  return launchClaude(
    launch,
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
  launch: WindowsRuntimeLaunch,
  projectDirectory: string,
  arguments_: readonly string[],
  dependencies: ClaudeCatalogProcessDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<LaunchedClaudeProcess> {
  return new Promise((resolveChild, reject) => {
    // The entry script, when there is one, precedes the runtime's own
    // arguments. argv stays an array: nothing here is re-parsed by a shell.
    const child = dependencies.spawnProcess(
      launch.executable,
      [...launch.prefixArguments, ...arguments_],
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
  launch: WindowsRuntimeLaunch,
  dependencies: ClaudeCatalogProcessDependencies,
  environment: NodeJS.ProcessEnv,
  providerRequestBudget?: ProviderRequestBudget,
): Promise<void> {
  let output: string;
  await providerRequestBudget?.claim("claude-auth-status");
  try {
    output = await dependencies.readAuthenticationStatus(
      launch,
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
  const authentication = classifyClaudeAuthenticationForMode(
    output,
    dependencies.authenticationMode ?? "subscription-oauth",
    dependencies.apiKeyStaticHealthyAuthMethod ?? "oauth_token",
  );
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

/**
 * The one spawn-environment resolution point. Endpoints that carry their own
 * environment descriptor (GLM, api-key) build through the generic factory;
 * every other caller keeps the historical subscription/selector semantics
 * byte-identically. Missing/malformed endpoint tokens surface as
 * `authentication-required`; other descriptor defects stay `invalid-input`.
 */
export function resolveClaudeProcessEnvironment(
  dependencies: ClaudeCatalogProcessDependencies,
  profile?: SessionProfile,
): NodeJS.ProcessEnv {
  const source = dependencies.environment ?? process.env;
  const endpointEnvironment = dependencies.endpointEnvironment;
  if (endpointEnvironment !== undefined) {
    const descriptor =
      typeof endpointEnvironment === "function"
        ? endpointEnvironment(
            Object.freeze(
              profile === undefined ? {} : { profile },
            ),
          )
        : endpointEnvironment;
    try {
      return Object.freeze(
        createEndpointProcessEnvironment(source, descriptor),
      );
    } catch (error) {
      if (error instanceof ClaudeEndpointEnvironmentError) {
        throw new RuntimeAdapterError(
          error.reason === "token-missing" ||
            error.reason === "token-malformed" ||
            error.reason === "api-key-missing" ||
            error.reason === "api-key-malformed"
            ? "authentication-required"
            : "invalid-input",
        );
      }
      throw new RuntimeAdapterError("invalid-input");
    }
  }
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
  #inputFinished = false;

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

  finishInput(): void {
    if (this.#inputFinished) return;
    this.#inputFinished = true;
    this.#child.stdin.end();
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopOnce();
    return this.#stopPromise;
  }

  async #stopOnce(): Promise<void> {
    try {
      try {
        this.finishInput();
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
