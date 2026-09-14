// Manual, approved offline probe. Not part of the ordinary test glob.
// Same composition as the production GLM endpoint path (ClaudeAdapter +
// createOfficialClaudeSessionTransport, real Claude CLI, real control
// protocol), pointed at a local fake HTTP server that answers every
// /v1/messages request with 401. Captures the exact wire frames and the
// classification RuntimeAdapterError category the product throws.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../../../src/agent-runtime/claude/adapter.ts";
import { createGlmEndpointContext } from "../../../src/agent-runtime/claude/glm-catalog.ts";
import {
  createOfficialClaudeSessionTransport,
  productionClaudeCatalogProcessDependencies,
} from "../../../src/agent-runtime/claude/process-transport.ts";

const root = mkdtempSync(join(realpathSync(tmpdir()), "uaw280-auth401-"));
for (const name of ["config", "project", "home", "appdata"]) mkdirSync(join(root, name));

const calls: { path: string; body: unknown }[] = [];
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : null;
  calls.push({ path: request.url!, body });
  if (request.url?.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 0 }));
    return;
  }
  response.writeHead(401, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };

const sanitizedEnv: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"])
  if (process.env[key]) sanitizedEnv[key] = process.env[key];
sanitizedEnv.HOME = join(root, "home");
sanitizedEnv.USERPROFILE = join(root, "home");
sanitizedEnv.APPDATA = join(root, "appdata");
sanitizedEnv.LOCALAPPDATA = join(root, "appdata");

const wirePath = join(root, "wire.jsonl");
writeFileSync(wirePath, "");
async function tee(line: unknown) {
  const fs = await import("node:fs/promises");
  await fs.appendFile(wirePath, `${JSON.stringify({ at: Date.now(), ...(line as object) })}\n`);
}

const endpointContext = createGlmEndpointContext({
  configDir: join(root, "config"),
  sourceEnvironment: sanitizedEnv,
  baseUrl: `http://127.0.0.1:${address.port}`,
  resolveAuthToken: () => "offline-fake-invalid-key",
});
const endpointDependencies = Object.freeze({
  ...productionClaudeCatalogProcessDependencies,
  environment: sanitizedEnv,
  endpointEnvironment: endpointContext.environmentSource,
  authenticationMode: endpointContext.authenticationMode,
});

const adapter = new ClaudeAdapter(
  undefined,
  async (request) => {
    const transport = await createOfficialClaudeSessionTransport(request, endpointDependencies, undefined);
    return {
      async send(line: string) {
        await tee({ direction: "out", line });
        return transport.send(line);
      },
      receive() {
        return transport.receive().then(async (value) => {
          await tee({ direction: "in", line: value });
          return value;
        });
      },
      stop: () => transport.stop(),
    };
  },
  undefined,
  undefined,
  undefined,
  undefined,
  endpointContext,
);

const outcome: Record<string, unknown> = { root, requestCountBeforeSend: 0 };
try {
  const binding = await adapter.start({
    projectDirectory: join(root, "project"),
    profile: { model: "glm-5.3[1m]", effortLevel: "default", executionMode: "single-agent", accessMode: "full-access" },
  });
  outcome.startOk = true;
  outcome.opaqueSessionReference = binding.opaqueSessionReference;
  await binding.send({ text: "AUTH401_PROBE_INPUT" });
  outcome.sendOk = true;
  const events: unknown[] = [];
  try {
    for await (const event of binding.events()) events.push(event);
    outcome.events = events;
    outcome.eventsDone = true;
  } catch (error) {
    outcome.events = events;
    outcome.eventsErrorCategory = (error as { category?: string })?.category;
    outcome.eventsErrorName = (error as { name?: string })?.name;
    outcome.eventsErrorMessage = (error as { message?: string })?.message;
  }
} catch (error) {
  outcome.startErrorCategory = (error as { category?: string })?.category;
  outcome.startErrorName = (error as { name?: string })?.name;
  outcome.startErrorMessage = (error as { message?: string })?.message;
}
outcome.requestCount = calls.length;
writeFileSync(join(root, "requests.json"), JSON.stringify(calls, null, 2));
console.log(JSON.stringify(outcome, null, 2));
server.closeAllConnections();
await new Promise<void>(resolve => server.close(() => resolve()));
