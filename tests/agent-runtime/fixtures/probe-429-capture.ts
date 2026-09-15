// Manual, approved offline probe. Not part of the ordinary test glob.
// Same composition as probe-auth-failure-401.ts (ClaudeAdapter +
// createOfficialClaudeSessionTransport, real Claude CLI, real control
// protocol), pointed at a local fake HTTP server that answers every
// /v1/messages request with 429. Unlike the 401 probe, the CLI binary is
// argv-selected so this can capture both the 2.1.267 and 2.1.270 wire
// (w306: only the 2.1.270 429 fixture had been sampled before; this fills
// the missing 2.1.267 one). Captures the raw wire frames, unwrapped,
// directly in the shape tests/agent-runtime/fixtures/*.jsonl already store.
//
// Usage: node probe-429-capture.ts <cliPath> <outFile>
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../../../src/agent-runtime/claude/adapter.ts";
import { createGlmEndpointContext } from "../../../src/agent-runtime/claude/glm-catalog.ts";
import {
  createOfficialClaudeSessionTransport,
  nativeLaunch,
  productionClaudeCatalogProcessDependencies,
} from "../../../src/agent-runtime/claude/process-transport.ts";

const [, , cliPath, outFile] = process.argv;
if (!cliPath || !outFile) {
  console.error("usage: probe-429-capture.ts <cliPath> <outFile>");
  process.exit(2);
}

const root = mkdtempSync(join(realpathSync(tmpdir()), "uaw306-429-"));
for (const name of ["config", "project", "home", "appdata"]) mkdirSync(join(root, name));

const calls: { path: string }[] = [];
const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Drain the request body; the fake endpoint never inspects it.
  }
  calls.push({ path: request.url! });
  if (request.url?.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 0 }));
    return;
  }
  response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
  response.end(JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit." },
  }));
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

const capturedLines: string[] = [];

const endpointContext = createGlmEndpointContext({
  configDir: join(root, "config"),
  sourceEnvironment: sanitizedEnv,
  baseUrl: `http://127.0.0.1:${address.port}`,
  resolveAuthToken: () => "offline-fake-invalid-key",
});
const endpointDependencies = Object.freeze({
  ...productionClaudeCatalogProcessDependencies,
  discoverExecutable: async () => nativeLaunch(cliPath!),
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
        return transport.send(line);
      },
      receive() {
        return transport.receive().then((value) => {
          if (value !== null) capturedLines.push(value);
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

const outcome: Record<string, unknown> = { root, cliPath };
try {
  const binding = await adapter.start({
    projectDirectory: join(root, "project"),
    profile: { model: "glm-5.3[1m]", effortLevel: "default", executionMode: "single-agent", accessMode: "full-access" },
  });
  outcome.startOk = true;
  await binding.send({ text: "W306_429_PROBE_INPUT" });
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
writeFileSync(outFile, capturedLines.join("\n") + (capturedLines.length ? "\n" : ""));
console.log(JSON.stringify(outcome, null, 2));
server.closeAllConnections();
await new Promise<void>(resolve => server.close(() => resolve()));
