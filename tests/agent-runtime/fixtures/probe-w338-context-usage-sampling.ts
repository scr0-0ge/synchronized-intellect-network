// Manual, approved offline probe. Not part of the ordinary test glob.
// w338: samples the real Claude CLI 2.1.270 wire around one completed turn
// while an extra `get_context_usage` control request is issued at the validated
// Stop-hook boundary (issue #8 Lane C active context probe). Zero real
// inference: a local loopback HTTP server answers every /v1/messages request
// with fixed synthetic content; nothing reaches a real Anthropic endpoint and
// no account is signed in. Diagnostics stay in memory (never the parent Temp).
//
// Usage: node probe-w338-context-usage-sampling.ts <cliPath> <outDir>
// Writes <outDir>/run-context-usage/get-context-usage.jsonl (one raw stdout
// line per row, sanitize-at-capture) plus .outcome.json for diagnosis.
// Sanitization rewrites every owner-identity spelling at capture time (same
// commit as the sampling), derived at runtime from this machine's own
// account name -- long form, hyphenated form, and Windows 8.3 short alias --
// so this file never spells the identity out literally (case-insensitive).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";

import { ClaudeAdapter } from "../../../src/agent-runtime/claude/adapter.ts";
import { createGlmEndpointContext } from "../../../src/agent-runtime/claude/glm-catalog.ts";
import {
  createOfficialClaudeSessionTransport,
  nativeLaunch,
  productionClaudeCatalogProcessDependencies,
} from "../../../src/agent-runtime/claude/process-transport.ts";

const [, , cliPath, outDir] = process.argv;
if (!cliPath || !outDir) {
  console.error("usage: probe-w338-context-usage-sampling.ts <cliPath> <outDir>");
  process.exit(2);
}

const root = join(outDir, "run-context-usage");
for (const name of ["config", "project", "home", "appdata"]) mkdirSync(join(root, name), { recursive: true });

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// windowsVerbatimArguments keeps the inner quotes intact: letting Node quote
// the argument escapes them as \", which cmd does not understand and the
// for-set splits at the first space.
function shortDirectoryName(longPath: string): string {
  const result = spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`],
    { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
  );
  if (result.status !== 0) return basename(longPath);
  return basename((result.stdout ?? "").trim());
}

const ownerLongUsername = userInfo().username;
const ownerLongUsernameHyphen = ownerLongUsername.replace(/\s+/gu, "-");
const ownerShortUsername = shortDirectoryName(homedir());
const ownerShortUsernameHyphen = ownerShortUsername.replace("~", "-");

function sanitize(text: string): string {
  let result = text.replace(new RegExp(escapeRegExp(ownerLongUsername), "gi"), "testuser");
  if (ownerLongUsernameHyphen !== ownerLongUsername) {
    result = result.replace(new RegExp(escapeRegExp(ownerLongUsernameHyphen), "gi"), "testuser");
  }
  result = result.replace(new RegExp(escapeRegExp(ownerShortUsername), "gi"), "TESTUS~1");
  if (ownerShortUsernameHyphen !== ownerShortUsername) {
    result = result.replace(new RegExp(escapeRegExp(ownerShortUsernameHyphen), "gi"), "TESTUS-1");
  }
  return result;
}

type ServerHandle = { port: number; close: () => Promise<void>; requests: unknown[] };

function startContentServer(): Promise<ServerHandle> {
  const requests: unknown[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed: raw.slice(0, 500) }; }
    requests.push({ url: request.url, method: request.method, model: body?.model });
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
      response.end(JSON.stringify({ error: { message: "w338 fake anthropic: unexpected request" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (frame: Record<string, unknown>) =>
      response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    const msgId = `msg_w338_${requests.length}`;
    emit({
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model: body?.model ?? "glm-5.3[1m]",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } },
    });
    emit({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "W338_THINKING -- loopback stub reasoning fragment." } });
    emit({ type: "content_block_stop", index: 0 });
    emit({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    emit({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "W338_OK" } });
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

const sanitizedEnv: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"]) {
  if (process.env[key]) sanitizedEnv[key] = process.env[key];
}
sanitizedEnv.HOME = join(root, "home");
sanitizedEnv.USERPROFILE = join(root, "home");
sanitizedEnv.APPDATA = join(root, "appdata");
sanitizedEnv.LOCALAPPDATA = join(root, "appdata");

const captured: string[] = [];
const inMemoryDiagnostics: unknown[] = [];
let probeInjected = false;

async function main(): Promise<void> {
  const contentServer = await startContentServer();
  const port = contentServer.port;
  const context = createGlmEndpointContext({
    configDir: join(root, "config"),
    sourceEnvironment: sanitizedEnv,
    baseUrl: `http://127.0.0.1:${port}`,
    resolveAuthToken: () => "w338-offline-fake-token",
  });
  const endpointDependencies = Object.freeze({
    ...productionClaudeCatalogProcessDependencies,
    discoverExecutable: async () => nativeLaunch(cliPath!),
    environment: sanitizedEnv,
    endpointEnvironment: context.environmentSource,
    authenticationMode: context.authenticationMode,
    apiKeyStaticHealthyAuthMethod: context.apiKeyStaticHealthyAuthMethod,
    // LESSONS 304: the production diagnostic sink resolves from the parent
    // process temp dir at import time; inject an in-memory observer instead.
    recordDiagnostic: (diagnostic: unknown) => { inMemoryDiagnostics.push(diagnostic); },
  });

  const adapter = new ClaudeAdapter(
    undefined,
    async (request) => {
      const inner = await createOfficialClaudeSessionTransport(request, endpointDependencies, undefined);
      // Issue the active context probe at the validated Stop-hook boundary:
      // the hook frame is delivered first (the binding writes its success
      // reply while processing it), and the NEXT read is held until the probe
      // request has been written -- so the CLI answers between the Stop hook
      // and the terminal `result`, exactly the production read window.
      let injectBeforeNextRead = false;
      return {
        send: (line: string) => inner.send(line),
        receive: () => {
          const prepare = injectBeforeNextRead
            ? inner
                .send(JSON.stringify({
                  type: "control_request",
                  request_id: "probe-w338-context-usage",
                  request: { subtype: "get_context_usage" },
                }))
                .then(() => { probeInjected = true; })
            : Promise.resolve();
          injectBeforeNextRead = false;
          return prepare.then(() => inner.receive()).then((value) => {
            if (value !== null) {
              captured.push(sanitize(value));
              let frame: any = null;
              try { frame = JSON.parse(value); } catch { frame = null; }
              if (!probeInjected && frame?.type === "control_request" && frame?.request?.subtype === "hook_callback") {
                injectBeforeNextRead = true;
              }
            }
            return value;
          });
        },
        finishInput: inner.finishInput ? () => inner.finishInput!() : undefined,
        stop: () => inner.stop(),
      };
    },
    undefined,
    undefined,
    undefined,
    undefined,
    context,
  );

  const profile = { model: "glm-5.3[1m]", effortLevel: "default", executionMode: "single-agent" as const, accessMode: "full-access" as const };
  const projectDirectory = join(root, "project");
  const outcome: Record<string, unknown> = { scenario: "context-usage", cliPath, root };
  try {
    const binding = await adapter.start({ projectDirectory, profile });
    await binding.send({ text: "W338 context-usage probe: say hi" });
    const events: unknown[] = [];
    for await (const event of binding.events()) events.push(event);
    outcome.events = events;
  } catch (error: any) {
    outcome.errorCategory = error?.category;
    outcome.errorMessage = error?.message;
  }
  outcome.capturedLines = captured.length;
  outcome.probeInjected = probeInjected;
  outcome.diagnostics = inMemoryDiagnostics;
  writeFileSync(join(root, "get-context-usage.jsonl"), captured.join("\n") + (captured.length ? "\n" : ""));
  writeFileSync(join(root, "context-usage.outcome.json"), JSON.stringify(outcome, null, 2));
  writeFileSync(join(root, "requests.json"), JSON.stringify(contentServer.requests, null, 2));
  console.log(JSON.stringify(outcome, null, 2));
  await contentServer.close();
}

await main();
