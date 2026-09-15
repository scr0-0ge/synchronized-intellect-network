// Manual, approved offline probe. Not part of the ordinary test glob.
// w289: samples the production Claude wire (ClaudeAdapter + createOfficialClaudeSessionTransport,
// a real Claude CLI binary chosen by argv, the real control protocol) across the scenarios needed
// to diff CLI 2.1.267 vs 2.1.270 frame-by-frame -- new session, thinking + one tool call + Stop
// hook completion, interrupt, same-id resume, 401, 429. Zero real inference: a local loopback HTTP
// server answers every /v1/messages request with fixed synthetic content; nothing here ever reaches
// a real Anthropic endpoint and no account is ever signed in.
//
// Usage: node probe-w289-wire-sampling.ts <cliPath> <versionLabel> <scenario> <outDir>
//   scenario: new-session | tool-call | interrupt | resume | 401 | 429
// Writes <outDir>/<scenario>.jsonl (resume also writes <outDir>/resume-leg1.jsonl) -- one raw
// stdout line per row, verbatim, exactly what tests/agent-runtime/*.jsonl fixtures already store.
// Also writes <outDir>/<scenario>.outcome.json (events + error classification) for diagnosis.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ClaudeAdapter } from "../../../src/agent-runtime/claude/adapter.ts";
import { createGlmEndpointContext } from "../../../src/agent-runtime/claude/glm-catalog.ts";
import {
  createOfficialClaudeSessionTransport,
  nativeLaunch,
  productionClaudeCatalogProcessDependencies,
} from "../../../src/agent-runtime/claude/process-transport.ts";
import type { ClaudeCatalogTransport } from "../../../src/agent-runtime/claude/transport.ts";

const [, , cliPath, versionLabel, scenario, outDir] = process.argv;
if (!cliPath || !versionLabel || !scenario || !outDir) {
  console.error("usage: probe-w289-wire-sampling.ts <cliPath> <versionLabel> <scenario> <outDir>");
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const root = join(outDir, `run-${scenario}`);
for (const name of ["config", "project", "home", "appdata"]) mkdirSync(join(root, name), { recursive: true });

type ServerHandle = { port: number; close: () => Promise<void>; requests: unknown[] };

function startContentServer(): Promise<ServerHandle> {
  const requests: unknown[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed: raw.slice(0, 500) }; }
    requests.push({ url: request.url, method: request.method, model: body?.model, hasToolResult: hasToolResult(body) });
    if (request.method === "GET" && request.url?.includes("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "glm-5.3", display_name: "glm-5.3" }] }));
      return;
    }
    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 0 }));
      return;
    }
    if (request.method !== "POST" || !request.url?.includes("/v1/messages")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "w289 fake anthropic: unexpected request" } }));
      return;
    }
    const lastUserText = lastUserPlainText(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (frame: Record<string, unknown>) =>
      response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    const msgId = `msg_w289_${requests.length}`;
    emit({
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model: body?.model ?? "glm-5.3[1m]",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } },
    });
    emit({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    if (hasToolResult(body)) {
      emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "W289_TOOL_FOLLOWUP_THINKING" } });
      emit({ type: "content_block_stop", index: 0 });
      emit({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      emit({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "W289_TOOL_FOLLOWUP_OK" } });
      emit({ type: "content_block_stop", index: 1 });
      emit({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      emit({ type: "message_stop" });
      response.end();
      return;
    }
    if (lastUserText.includes("W289_TOOL_CALL")) {
      emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "W289_TOOL_THINKING -- deciding to call Bash." } });
      emit({ type: "content_block_stop", index: 0 });
      emit({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_w289_1", name: "Bash", input: {} } });
      emit({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo W289_TOOL_OK", description: "w289 probe" }) } });
      emit({ type: "content_block_stop", index: 1 });
      emit({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 15 } });
      emit({ type: "message_stop" });
      response.end();
      return;
    }
    if (lastUserText.includes("W289_SLOW")) {
      let closed = false;
      response.on("close", () => { closed = true; });
      for (let i = 1; i <= 50 && !closed; i += 1) {
        emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `w289 slow thinking fragment ${i} ...` } });
        await delay(300);
      }
      if (!closed) {
        emit({ type: "content_block_stop", index: 0 });
        emit({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        emit({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "W289_SLOW_NEVER_INTERRUPTED" } });
        emit({ type: "content_block_stop", index: 1 });
        emit({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
        emit({ type: "message_stop" });
        response.end();
      }
      return;
    }
    emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "W289_THINKING -- loopback stub reasoning fragment." } });
    emit({ type: "content_block_stop", index: 0 });
    emit({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    emit({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "W289_OK" } });
    emit({ type: "content_block_stop", index: 1 });
    emit({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    emit({ type: "message_stop" });
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ port: address.port, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function startStatusServer(status: 401 | 429): Promise<ServerHandle> {
  const requests: unknown[] = [];
  const errorBody = status === 401
    ? { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }
    : { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit." } };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({ url: request.url, method: request.method });
    if (request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 0 }));
      return;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (status === 429) headers["retry-after"] = "1";
    response.writeHead(status, headers);
    response.end(JSON.stringify(errorBody));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ port: address.port, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function hasToolResult(body: any): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((m: any) => m?.role === "user" && Array.isArray(m.content) &&
    m.content.some((block: any) => block?.type === "tool_result"));
}

function lastUserPlainText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m: any) => m?.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return "";
  return last.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
}

const sanitizedEnv: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"]) {
  if (process.env[key]) sanitizedEnv[key] = process.env[key];
}
sanitizedEnv.HOME = join(root, "home");
sanitizedEnv.USERPROFILE = join(root, "home");
sanitizedEnv.APPDATA = join(root, "appdata");
sanitizedEnv.LOCALAPPDATA = join(root, "appdata");

let currentLeg: string[] = [];
const legs: Record<string, string[]> = {};
function startLeg(name: string): void {
  currentLeg = [];
  legs[name] = currentLeg;
}

function teeTransport(inner: ClaudeCatalogTransport): ClaudeCatalogTransport {
  return {
    send: (line: string) => inner.send(line),
    receive: () => inner.receive().then((value) => {
      if (value !== null) currentLeg.push(value);
      return value;
    }),
    finishInput: inner.finishInput ? () => inner.finishInput!() : undefined,
    stop: () => inner.stop(),
  };
}

async function main(): Promise<void> {
  const isStatusScenario = scenario === "401" || scenario === "429";
  const contentServer = isStatusScenario ? undefined : await startContentServer();
  const statusServer = scenario === "401" ? await startStatusServer(401)
    : scenario === "429" ? await startStatusServer(429)
    : undefined;
  const port = (contentServer ?? statusServer)!.port;

  const endpointContext = createGlmEndpointContext({
    configDir: join(root, "config"),
    sourceEnvironment: sanitizedEnv,
    baseUrl: `http://127.0.0.1:${port}`,
    resolveAuthToken: () => "w289-offline-fake-token",
  });
  const endpointDependencies = Object.freeze({
    ...productionClaudeCatalogProcessDependencies,
    discoverExecutable: async () => nativeLaunch(cliPath!),
    environment: sanitizedEnv,
    endpointEnvironment: endpointContext.environmentSource,
    authenticationMode: endpointContext.authenticationMode,
    apiKeyStaticHealthyAuthMethod: endpointContext.apiKeyStaticHealthyAuthMethod,
  });

  const adapter = new ClaudeAdapter(
    undefined,
    async (request) => teeTransport(await createOfficialClaudeSessionTransport(request, endpointDependencies, undefined)),
    undefined,
    undefined,
    undefined,
    undefined,
    endpointContext,
  );

  const profile = { model: "glm-5.3[1m]", effortLevel: "default", executionMode: "single-agent" as const, accessMode: "full-access" as const };
  const projectDirectory = join(root, "project");
  const outcome: Record<string, unknown> = { scenario, versionLabel, cliPath, root };

  async function driveTurn(binding: any, text: string, onTurnStarted?: () => void): Promise<unknown[]> {
    await binding.send({ text });
    const events: unknown[] = [];
    for await (const event of binding.events()) {
      events.push(event);
      if (event.kind === "turn-started" && onTurnStarted) onTurnStarted();
    }
    return events;
  }

  try {
    if (scenario === "new-session" || scenario === "401" || scenario === "429") {
      startLeg(scenario);
      const binding = await adapter.start({ projectDirectory, profile });
      outcome.opaqueSessionReference = binding.opaqueSessionReference;
      outcome.events = await driveTurn(binding, `W289 ${scenario} probe: say hi`);
    } else if (scenario === "tool-call") {
      startLeg("tool-call");
      const binding = await adapter.start({ projectDirectory, profile });
      outcome.opaqueSessionReference = binding.opaqueSessionReference;
      outcome.events = await driveTurn(binding, "W289_TOOL_CALL probe: run the echo tool");
    } else if (scenario === "interrupt") {
      startLeg("interrupt");
      const binding = await adapter.start({ projectDirectory, profile });
      outcome.opaqueSessionReference = binding.opaqueSessionReference;
      let interruption: Promise<string> | undefined;
      outcome.events = await driveTurn(binding, "W289_SLOW probe: think slowly", () => {
        interruption = binding.interrupt().then(() => "confirmed", (error: any) => String(error?.category ?? error));
      });
      outcome.interruption = await interruption;
    } else if (scenario === "resume") {
      startLeg("resume-leg1");
      const binding1 = await adapter.start({ projectDirectory, profile });
      outcome.opaqueSessionReference = binding1.opaqueSessionReference;
      outcome.leg1Events = await driveTurn(binding1, "W289 resume leg1: first turn");
      writeFileSync(join(outDir, "resume-leg1.jsonl"), legs["resume-leg1"]!.join("\n") + "\n");
      startLeg("resume-leg2");
      const binding2 = await adapter.resume({
        opaqueSessionReference: binding1.opaqueSessionReference,
        projectDirectory,
        profile,
      });
      outcome.leg2Events = await driveTurn(binding2, "W289 resume leg2: second turn, same session id");
    } else {
      throw new Error(`unknown scenario: ${scenario}`);
    }
  } catch (error: any) {
    outcome.errorCategory = error?.category;
    outcome.errorName = error?.name;
    outcome.errorMessage = error?.message;
    outcome.errorStack = error?.stack;
  }

  for (const [name, lines] of Object.entries(legs)) {
    writeFileSync(join(outDir, `${name}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
  }
  writeFileSync(join(outDir, `${scenario}.outcome.json`), JSON.stringify(outcome, null, 2));
  writeFileSync(join(outDir, `${scenario}.requests.json`), JSON.stringify((contentServer ?? statusServer)!.requests, null, 2));
  console.log(JSON.stringify(outcome, null, 2));

  await contentServer?.close();
  await statusServer?.close();
}

await main();
