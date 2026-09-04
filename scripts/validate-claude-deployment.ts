/**
 * Private, bounded first-contact capture for the Claude Code desktop Runtime.
 *
 * Default run: six live CLI invocations (auth/catalog/Session under stripped
 * and provider-preserved environments), all zero-turn. `--include-session-turn`
 * deliberately changes the two Session invocations to one-turn captures so a
 * native `system/init` frame can be observed. The disclosure is printed before
 * executable discovery or any Claude process creation.
 *
 * Capture files contain raw native output and may contain account, path, model,
 * gateway, or policy information. They are local private fixtures, not public
 * Workbench data; review them before sharing.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadLineInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { RuntimeAdapterError } from "../src/agent-runtime/index.ts";
import {
  createClaudeCatalogObservationCollector,
  readClaudeRuntimeCatalog,
  toClaudeCatalogObservation,
  type ClaudeCatalogObservation,
} from "../src/agent-runtime/claude/adapter.ts";
import {
  classifyClaudeSubscriptionAuthentication,
  parseClaudeAuthenticationStatus,
} from "../src/agent-runtime/claude/authentication-status.ts";
import {
  claudeDiagnosticFromError,
  formatClaudeDiagnosticSummary,
} from "../src/agent-runtime/claude/diagnostics.ts";
import {
  CLAUDE_CATALOG_ARGUMENTS,
  CLAUDE_DEPLOYMENT_SELECTOR_KEYS,
  createClaudeProcessEnvironment,
  createClaudeSessionArguments,
  discoverClaudeExecutable,
  type ClaudeDeploymentMode,
} from "../src/agent-runtime/claude/process-transport.ts";
import {
  parseClaudeControlResponseLine,
  type ClaudeControlResponseGate,
} from "../src/agent-runtime/claude/protocol.ts";
import { readClaudeAppliedSettings } from "../src/agent-runtime/claude/settings.ts";

const rawStreamMaximumBytes = 4_194_304;
const controlFrameMaximum = 64;
const controlTimeoutMilliseconds = 60_000;

export interface ClaudeDeploymentCapturePlanOptions {
  readonly projectDirectory: string;
  readonly outputDirectory: string;
  readonly sourceEnvironment: NodeJS.ProcessEnv;
  readonly model: string;
  readonly includeSessionTurn: boolean;
}

export interface ClaudeDeploymentCaptureEnvironment {
  readonly name: "stripped" | "provider-preserved";
  readonly mode: ClaudeDeploymentMode;
  readonly selectorKeys: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export interface ClaudeDeploymentCaptureInvocation {
  readonly environment: ClaudeDeploymentCaptureEnvironment["name"];
  readonly kind: "auth-status" | "catalog" | "session";
  readonly arguments: readonly string[];
  readonly turnConsumption: "zero-turn" | "one-turn";
}

export interface ClaudeDeploymentCapturePlan {
  readonly projectDirectory: string;
  readonly outputDirectory: string;
  readonly model: string;
  readonly includeSessionTurn: boolean;
  readonly environments: readonly ClaudeDeploymentCaptureEnvironment[];
  readonly invocations: readonly ClaudeDeploymentCaptureInvocation[];
}

export function buildClaudeDeploymentCapturePlan(
  options: ClaudeDeploymentCapturePlanOptions,
): ClaudeDeploymentCapturePlan {
  const selectedKeys = CLAUDE_DEPLOYMENT_SELECTOR_KEYS.filter((key) => {
    const value = options.sourceEnvironment[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (selectedKeys.length > 1) {
    throw new Error(
      "Expected exactly one Claude deployment selector or none; multiple selectors are ambiguous.",
    );
  }
  const preservedMode = deploymentModeForSelector(selectedKeys[0]);
  const environments = Object.freeze([
    Object.freeze({
      name: "stripped" as const,
      mode: "subscription" as const,
      selectorKeys: Object.freeze([]),
      environment: Object.freeze(
        createClaudeProcessEnvironment(options.sourceEnvironment, "subscription"),
      ),
    }),
    Object.freeze({
      name: "provider-preserved" as const,
      mode: preservedMode,
      selectorKeys: Object.freeze([...selectedKeys]),
      environment: Object.freeze(
        createClaudeProcessEnvironment(options.sourceEnvironment, preservedMode),
      ),
    }),
  ]);
  const sessionArguments = createClaudeSessionArguments({
    projectDirectory: options.projectDirectory,
    profile: Object.freeze({
      model: options.model,
      effortLevel: "xhigh",
      executionMode: "ultracode",
      accessMode: "full-access",
    }),
    permissionMode: "bypassPermissions",
  });
  const invocations = Object.freeze(
    environments.flatMap((environment) =>
      Object.freeze([
        Object.freeze({
          environment: environment.name,
          kind: "auth-status" as const,
          arguments: Object.freeze(["auth", "status", "--json"]),
          turnConsumption: "zero-turn" as const,
        }),
        Object.freeze({
          environment: environment.name,
          kind: "catalog" as const,
          arguments: CLAUDE_CATALOG_ARGUMENTS,
          turnConsumption: "zero-turn" as const,
        }),
        Object.freeze({
          environment: environment.name,
          kind: "session" as const,
          arguments: sessionArguments,
          turnConsumption: options.includeSessionTurn
            ? ("one-turn" as const)
            : ("zero-turn" as const),
        }),
      ]),
    ),
  );
  return Object.freeze({
    projectDirectory: options.projectDirectory,
    outputDirectory: options.outputDirectory,
    model: options.model,
    includeSessionTurn: options.includeSessionTurn,
    environments,
    invocations,
  });
}

export function formatClaudeDeploymentCaptureDisclosure(
  plan: ClaudeDeploymentCapturePlan,
): string {
  const turnConsuming = plan.invocations.filter(
    (invocation) => invocation.turnConsumption === "one-turn",
  ).length;
  return (
    `ABOUT_TO_RUN live-claude-invocations=${plan.invocations.length} ` +
    `zero-turn=${plan.invocations.length - turnConsuming} ` +
    `turn-consuming=${turnConsuming} output=${plan.outputDirectory}`
  );
}

interface BoundedRawCapture {
  readonly text: string;
  readonly capturedBytes: number;
  readonly omittedBytes: number;
}

export interface SafeParserResult {
  readonly outcome: "accepted" | "rejected" | "not-observed";
  readonly category?: string;
  readonly diagnosticKind?: string;
  readonly gate?: string;
  readonly row?: number | null;
  readonly summary?: string;
}

export interface ClaudeDeploymentCaptureParserProjection {
  readonly settingsParser: SafeParserResult;
  readonly catalogParser: SafeParserResult;
  readonly observation: ClaudeCatalogObservation;
}

export function evaluateClaudeDeploymentCaptureResponses(
  initializeResponse: unknown,
  settingsResponse: unknown,
): ClaudeDeploymentCaptureParserProjection {
  const observationCollector = createClaudeCatalogObservationCollector();
  let settingsValue: ReturnType<typeof readClaudeAppliedSettings> = undefined;
  let settingsParser: SafeParserResult = Object.freeze({
    outcome: "not-observed",
  });
  if (settingsResponse !== undefined) {
    try {
      settingsValue = readClaudeAppliedSettings(
        settingsResponse,
        observationCollector,
      );
      settingsParser = Object.freeze({ outcome: "accepted" });
    } catch (error) {
      settingsParser = parserFailure(error, "get_settings");
    }
  }

  let catalogParser: SafeParserResult = Object.freeze({
    outcome: "not-observed",
  });
  if (initializeResponse !== undefined) {
    try {
      const catalog = readClaudeRuntimeCatalog(
        initializeResponse,
        settingsValue,
        observationCollector,
      );
      catalogParser = Object.freeze({
        outcome: "accepted",
        summary: `models=${catalog.models.length}`,
      });
    } catch (error) {
      catalogParser = parserFailure(error, "models");
    }
  }

  return Object.freeze({
    settingsParser,
    catalogParser,
    observation: toClaudeCatalogObservation(observationCollector),
  });
}

interface ControlFrameCapture {
  readonly rawLine?: string;
  readonly response?: Record<string, unknown>;
  readonly parser: SafeParserResult;
}

interface ProcessResult {
  readonly stdout: BoundedRawCapture;
  readonly stderr: BoundedRawCapture;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly forcedTermination: boolean;
}

interface ControlProcessResult extends ProcessResult {
  readonly initialize: ControlFrameCapture;
  readonly settings: ControlFrameCapture;
  readonly settingsParser: SafeParserResult;
  readonly catalogParser: SafeParserResult;
  readonly catalogObservation: ClaudeCatalogObservation;
  readonly systemInit?: { readonly rawLine: string; readonly observed: boolean };
}

async function executeCapturePlan(
  executable: string,
  plan: ClaudeDeploymentCapturePlan,
): Promise<number> {
  await mkdir(plan.outputDirectory, { recursive: true });
  const seals: {
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  }[] = [];
  let rejected = 0;
  for (let index = 0; index < plan.invocations.length; index += 1) {
    const invocation = plan.invocations[index]!;
    const captureEnvironment = plan.environments.find(
      (candidate) => candidate.name === invocation.environment,
    )!;
    const ordinal = String(index + 1).padStart(2, "0");
    console.log(
      `INVOCATION ${index + 1}/${plan.invocations.length} ` +
        `environment=${invocation.environment} kind=${invocation.kind} ` +
        `turn=${invocation.turnConsumption}`,
    );
    const result = invocation.kind === "auth-status"
      ? await runAuthStatus(executable, invocation, captureEnvironment, plan)
      : await runControlCapture(executable, invocation, captureEnvironment, plan);
    printRawResult(invocation, result);
    rejected += countRejected(result);
    const file = `${ordinal}-${invocation.environment}-${invocation.kind}.json`;
    const bytes = `${JSON.stringify(
      {
        schema: "claude-deployment-capture-v1",
        capturedAt: new Date().toISOString(),
        environment: invocation.environment,
        deploymentMode: captureEnvironment.mode,
        selectorKeys: captureEnvironment.selectorKeys,
        kind: invocation.kind,
        arguments: invocation.arguments,
        turnConsumption: invocation.turnConsumption,
        result,
      },
      null,
      2,
    )}\n`;
    const path = resolve(plan.outputDirectory, file);
    await writeFile(path, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const byteCount = Buffer.byteLength(bytes, "utf8");
    const sha256 = createHash("sha256").update(bytes, "utf8").digest("hex");
    seals.push(Object.freeze({ file, bytes: byteCount, sha256 }));
    console.log(`FIXTURE file=${file} bytes=${byteCount} sha256=${sha256}`);
  }
  const manifest = `${JSON.stringify(
    {
      schema: "claude-deployment-capture-manifest-v1",
      capturedAt: new Date().toISOString(),
      disclosure: formatClaudeDeploymentCaptureDisclosure(plan),
      rawStreamMaximumBytes,
      files: seals,
    },
    null,
    2,
  )}\n`;
  const manifestPath = resolve(plan.outputDirectory, "manifest.json");
  await writeFile(manifestPath, manifest, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(`CAPTURE_MANIFEST ${manifestPath}`);
  return rejected === 0 ? 0 : 1;
}

async function runAuthStatus(
  executable: string,
  invocation: ClaudeDeploymentCaptureInvocation,
  captureEnvironment: ClaudeDeploymentCaptureEnvironment,
  plan: ClaudeDeploymentCapturePlan,
): Promise<ProcessResult & { readonly authenticationParser: SafeParserResult }> {
  const child = spawn(executable, [...invocation.arguments], {
    cwd: plan.projectDirectory,
    env: captureEnvironment.environment,
    stdio: "pipe",
    windowsHide: true,
    shell: false,
  });
  const stdout = boundedStreamCapture(child.stdout);
  const stderr = boundedStreamCapture(child.stderr);
  await waitForSpawn(child);
  child.stdin.end();
  const exit = await stopProcess(child, controlTimeoutMilliseconds);
  const stdoutResult = stdout.finish();
  let authenticationParser: SafeParserResult;
  try {
    const parsed = parseClaudeAuthenticationStatus(stdoutResult.text);
    const state = classifyClaudeSubscriptionAuthentication(stdoutResult.text);
    authenticationParser = parsed === undefined
      ? Object.freeze({ outcome: "rejected", category: "protocol-invalid" })
      : Object.freeze({
          outcome: "accepted" as const,
          category: state,
          summary: `loggedIn=${parsed.loggedIn} authMethod=${parsed.authMethod} apiProvider=${parsed.apiProvider}`,
        });
  } catch (error) {
    authenticationParser = parserFailure(error, "auth-status");
  }
  console.log(
    `PARSER environment=${invocation.environment} kind=auth-status ` +
      formatParserResult(authenticationParser),
  );
  return Object.freeze({
    stdout: stdoutResult,
    stderr: stderr.finish(),
    ...exit,
    authenticationParser,
  });
}

async function runControlCapture(
  executable: string,
  invocation: ClaudeDeploymentCaptureInvocation,
  captureEnvironment: ClaudeDeploymentCaptureEnvironment,
  plan: ClaudeDeploymentCapturePlan,
): Promise<ControlProcessResult> {
  const child = spawn(executable, [...invocation.arguments], {
    cwd: plan.projectDirectory,
    env: captureEnvironment.environment,
    stdio: "pipe",
    windowsHide: true,
    shell: false,
  });
  const stdout = boundedStreamCapture(child.stdout);
  const stderr = boundedStreamCapture(child.stderr);
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  await waitForSpawn(child);

  const initializeRequestId = `capture-initialize-${randomUUID()}`;
  await writeLine(child, {
    type: "control_request",
    request_id: initializeRequestId,
    request: {
      subtype: "initialize",
      hooks:
        invocation.kind === "catalog"
          ? null
          : { Stop: [{ hookCallbackIds: [`capture-stop-${randomUUID()}`] }] },
    },
  });
  const initialize = await readControlFrame(lines, initializeRequestId, "initialize");
  let settings: ControlFrameCapture = Object.freeze({
    parser: Object.freeze({ outcome: "not-observed" as const }),
  });
  if (initialize.response !== undefined) {
    const settingsRequestId = `capture-settings-${randomUUID()}`;
    await writeLine(child, {
      type: "control_request",
      request_id: settingsRequestId,
      request: { subtype: "get_settings" },
    });
    settings = await readControlFrame(lines, settingsRequestId, "get_settings");
  }

  const parserProjection = evaluateClaudeDeploymentCaptureResponses(
    initialize.response,
    settings.response,
  );
  const { settingsParser, catalogParser } = parserProjection;

  let systemInit: ControlProcessResult["systemInit"];
  if (invocation.turnConsumption === "one-turn" && initialize.response !== undefined) {
    await writeLine(child, {
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Do not use tools. Reply with exactly CLAUDE_DEPLOYMENT_CAPTURE_OK.",
          },
        ],
      },
      parent_tool_use_id: null,
    });
    systemInit = await readSystemInit(lines);
  }

  child.stdin.end();
  const exit = await stopProcess(child, 5_000);
  reader.close();
  console.log(
    `PARSER environment=${invocation.environment} kind=${invocation.kind} ` +
      `initialize=${formatParserResult(initialize.parser)} ` +
      `settings-control=${formatParserResult(settings.parser)} ` +
      `settings=${formatParserResult(settingsParser)} ` +
      `catalog=${formatParserResult(catalogParser)} ` +
      `observation=${JSON.stringify(parserProjection.observation)}`,
  );
  return Object.freeze({
    stdout: stdout.finish(),
    stderr: stderr.finish(),
    ...exit,
    initialize,
    settings,
    settingsParser,
    catalogParser,
    catalogObservation: parserProjection.observation,
    ...(systemInit === undefined ? {} : { systemInit }),
  });
}

async function readControlFrame(
  lines: AsyncIterator<string>,
  requestId: string,
  gate: ClaudeControlResponseGate,
): Promise<ControlFrameCapture> {
  for (let frame = 0; frame < controlFrameMaximum; frame += 1) {
    const result = await withTimeout(lines.next(), controlTimeoutMilliseconds);
    if (result.done) {
      return Object.freeze({
        parser: Object.freeze({
          outcome: "rejected" as const,
          category: "runtime-shutdown",
          gate,
        }),
      });
    }
    try {
      const parsed = parseClaudeControlResponseLine(result.value, requestId, gate);
      if (parsed.kind === "ignored") continue;
      return Object.freeze({
        rawLine: result.value,
        response: parsed.response,
        parser: Object.freeze({ outcome: "accepted" as const, gate }),
      });
    } catch (error) {
      return Object.freeze({
        rawLine: result.value,
        parser: parserFailure(error, gate),
      });
    }
  }
  return Object.freeze({
    parser: Object.freeze({
      outcome: "rejected" as const,
      category: "protocol-invalid",
      gate,
      summary: "frame-limit",
    }),
  });
}

async function readSystemInit(
  lines: AsyncIterator<string>,
): Promise<{ readonly rawLine: string; readonly observed: boolean }> {
  for (let frame = 0; frame < controlFrameMaximum; frame += 1) {
    const result = await withTimeout(lines.next(), controlTimeoutMilliseconds);
    if (result.done) break;
    try {
      const value = JSON.parse(result.value) as Record<string, unknown>;
      if (value.type === "system" && value.subtype === "init") {
        return Object.freeze({ rawLine: result.value, observed: true });
      }
    } catch {
      // The raw line remains in stdout; keep looking for the exact init shape.
    }
  }
  return Object.freeze({ rawLine: "", observed: false });
}

function boundedStreamCapture(stream: NodeJS.ReadableStream): {
  readonly finish: () => BoundedRawCapture;
} {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    totalBytes += bytes.length;
    const remaining = rawStreamMaximumBytes - capturedBytes;
    if (remaining <= 0) return;
    const retained = bytes.subarray(0, remaining);
    chunks.push(retained);
    capturedBytes += retained.length;
  });
  return Object.freeze({
    finish: () =>
      Object.freeze({
        text: Buffer.concat(chunks, capturedBytes).toString("utf8"),
        capturedBytes,
        omittedBytes: Math.max(0, totalBytes - capturedBytes),
      }),
  });
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid !== undefined) return;
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  gracefulMilliseconds: number,
): Promise<{
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly forcedTermination: boolean;
}> {
  let forcedTermination = false;
  if (!(await waitForExit(child, gracefulMilliseconds))) {
    forcedTermination = true;
    child.kill();
    await waitForExit(child, 5_000);
  }
  return Object.freeze({
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    forcedTermination,
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      resolveExit(false);
    }, milliseconds);
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

function writeLine(
  child: ChildProcessWithoutNullStreams,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  return new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) =>
      error ? rejectWrite(error) : resolveWrite(),
    );
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("capture-timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parserFailure(error: unknown, fallbackGate: string): SafeParserResult {
  const diagnostic = claudeDiagnosticFromError(error);
  if (diagnostic !== undefined) {
    return Object.freeze({
      outcome: "rejected" as const,
      category: diagnostic.category,
      diagnosticKind: diagnostic.kind,
      ...(diagnostic.kind === "authentication-status" ||
      diagnostic.kind === "child-stderr" ||
      diagnostic.kind === "process-launch-rejected"
        ? { gate: fallbackGate }
        : { gate: diagnostic.gate, row: diagnostic.row }),
      summary: formatClaudeDiagnosticSummary(diagnostic),
    });
  }
  return Object.freeze({
    outcome: "rejected" as const,
    category: error instanceof RuntimeAdapterError ? error.category : "unexpected",
    gate: fallbackGate,
  });
}

function formatParserResult(result: SafeParserResult): string {
  return [
    `outcome=${result.outcome}`,
    ...(result.category === undefined ? [] : [`category=${result.category}`]),
    ...(result.diagnosticKind === undefined ? [] : [`kind=${result.diagnosticKind}`]),
    ...(result.gate === undefined ? [] : [`gate=${result.gate}`]),
    ...(result.row === undefined ? [] : [`row=${result.row ?? "none"}`]),
    ...(result.summary === undefined ? [] : [`summary=${JSON.stringify(result.summary)}`]),
  ].join(" ");
}

function printRawResult(
  invocation: ClaudeDeploymentCaptureInvocation,
  result: ProcessResult,
): void {
  console.log(
    `RAW_RESULT environment=${invocation.environment} kind=${invocation.kind} ` +
      `exit=${result.exitCode ?? "none"} signal=${result.signalCode ?? "none"} ` +
      `forced=${result.forcedTermination}`,
  );
  console.log("RAW_STDOUT_BEGIN");
  process.stdout.write(result.stdout.text);
  if (result.stdout.text.length > 0 && !result.stdout.text.endsWith("\n")) process.stdout.write("\n");
  console.log(`RAW_STDOUT_END omittedBytes=${result.stdout.omittedBytes}`);
  console.log("RAW_STDERR_BEGIN");
  process.stdout.write(result.stderr.text);
  if (result.stderr.text.length > 0 && !result.stderr.text.endsWith("\n")) process.stdout.write("\n");
  console.log(`RAW_STDERR_END omittedBytes=${result.stderr.omittedBytes}`);
}

function countRejected(result: ProcessResult): number {
  if ("authenticationParser" in result) {
    const authentication = result as ProcessResult & {
      readonly authenticationParser: SafeParserResult;
    };
    return authentication.authenticationParser.outcome === "rejected" ? 1 : 0;
  }
  if ("initialize" in result) {
    const control = result as ControlProcessResult;
    return [
      control.initialize.parser,
      control.settings.parser,
      control.settingsParser,
      control.catalogParser,
    ].filter((parser) => parser.outcome === "rejected").length;
  }
  return 0;
}

function deploymentModeForSelector(
  selector: (typeof CLAUDE_DEPLOYMENT_SELECTOR_KEYS)[number] | undefined,
): ClaudeDeploymentMode {
  if (selector === "CLAUDE_CODE_USE_BEDROCK") return "bedrock";
  if (selector === "CLAUDE_CODE_USE_VERTEX") return "vertex";
  if (selector === "CLAUDE_CODE_USE_FOUNDRY") return "foundry";
  return "subscription";
}

function parseCommandLine(arguments_: readonly string[]): {
  readonly projectDirectory: string;
  readonly outputDirectory: string;
  readonly model: string;
  readonly includeSessionTurn: boolean;
} {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let projectDirectory = repositoryRoot;
  let outputDirectory = resolve(
    repositoryRoot,
    ".scratch",
    `claude-deployment-captures-${new Date().toISOString().replace(/[:.]/gu, "-")}`,
  );
  let model = "default";
  let includeSessionTurn = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--include-session-turn") {
      includeSessionTurn = true;
      continue;
    }
    if (argument === "--help") {
      console.log(
        "Usage: node scripts/validate-claude-deployment.ts [--project DIR] [--output DIR] [--model ID] [--include-session-turn]",
      );
      console.log(
        "Default is six zero-turn Claude invocations. --include-session-turn consumes one turn in each of the two Session environments.",
      );
      process.exit(0);
    }
    if (argument === "--project" || argument === "--output" || argument === "--model") {
      const value = arguments_[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error(`${argument} requires a non-empty value.`);
      }
      index += 1;
      if (argument === "--project") projectDirectory = resolve(value);
      else if (argument === "--output") outputDirectory = resolve(value);
      else model = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return Object.freeze({
    projectDirectory,
    outputDirectory,
    model,
    includeSessionTurn,
  });
}

async function main(): Promise<void> {
  const options = parseCommandLine(process.argv.slice(2));
  const plan = buildClaudeDeploymentCapturePlan({
    ...options,
    sourceEnvironment: process.env,
  });
  console.log(formatClaudeDeploymentCaptureDisclosure(plan));
  console.log(
    "PRIVACY raw capture files are private diagnostics and may contain account, path, model, gateway, or policy information; review before sharing.",
  );
  console.log(
    `BOUND raw-stream-bytes=${rawStreamMaximumBytes} behavior=retain-prefix-and-report-omitted`,
  );
  if (plan.environments[1]?.selectorKeys.length === 0) {
    console.log(
      "ENVIRONMENT provider-selector=none stripped-and-provider-preserved-variants-are-selector-identical",
    );
  }
  const executable = await discoverClaudeExecutable();
  process.exitCode = await executeCapturePlan(executable, plan);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
