// Manual, approved offline probe. Not part of the ordinary test glob.
// Same composition as probe-429-capture.ts (Claude): CodexAdapter, the real Codex
// CLI, real app-server protocol, pointed at a local fake HTTP server that answers
// every upstream request with 429 + Retry-After. Captures the raw inbound wire
// frames, unwrapped, directly in the shape tests/agent-runtime/fixtures/*.jsonl
// already store (w322).
//
// Two modes:
//  - "api": codex-api endpoint (openai-custom provider, real config.toml seeding,
//    real env-key injection) -- the fully reachable, product-supported path.
//  - "unauth-subscription": the default/historical transport (no endpoint
//    context, byte-identical env inheritance -- how production actually
//    constructs the subscription-mode adapter), with an isolated, deliberately
//    UNAUTHENTICATED CODEX_HOME (no auth.json; no login performed). Measures
//    whether the app-server ever reaches the network before the product's own
//    assertAuthenticated gate refuses it locally.
//
// Usage: node probe-codex-429-capture.ts <api|unauth-subscription> <outFile>
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../../../src/agent-runtime/codex-adapter.ts";
import type { CodexEndpointContext } from "../../../src/agent-runtime/codex-adapter.ts";
import { createOfficialCodexTransport } from "../../../src/agent-runtime/codex/process-transport.ts";
import { createCodexApiEndpointContext } from "../../../src/agent-runtime/codex/codex-api-catalog.ts";
import { resolveCodexEndpointProcessEnvironment } from "../../../src/agent-runtime/codex/endpoint-env-factory.ts";
import { RuntimeAdapterError } from "../../../src/agent-runtime/index.ts";
import type { OfficialRuntimeTransportFactory } from "../../../src/agent-runtime/codex/transport.ts";

const [, , mode, outFile] = process.argv;
if ((mode !== "api" && mode !== "unauth-subscription") || !outFile) {
  console.error("usage: probe-codex-429-capture.ts <api|unauth-subscription> <outFile>");
  process.exit(2);
}

// w322 lane scratch discipline: isolated CODEX_HOME and every other throwaway
// directory this probe creates live under UAW_LANE_SCRATCH when the caller sets
// it (the lane's own uaw-lanes\w322), falling back to the OS temp dir otherwise
// -- the same UAW_LANE_SCRATCH -> os.tmpdir() convention the suite already uses.
const scratchRoot = process.env.UAW_LANE_SCRATCH ?? tmpdir();
const root = mkdtempSync(join(realpathSync(scratchRoot), "codex429-"));
mkdirSync(join(root, "project"));
mkdirSync(join(root, "home"));
mkdirSync(join(root, "appdata"));
const codexHome = join(root, "codex-home");

const calls: { method: string; url: string }[] = [];
const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Drain the body; the fake endpoint never inspects it.
  }
  calls.push({ method: request.method ?? "", url: request.url ?? "" });
  response.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
  response.end(JSON.stringify({
    error: {
      type: "rate_limit_exceeded",
      code: "rate_limit_exceeded",
      message: "Rate limit reached for requests. Please try again in a while.",
    },
  }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };

const sanitizedEnv: NodeJS.ProcessEnv = {};
for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"]) {
  if (process.env[key]) sanitizedEnv[key] = process.env[key];
}
sanitizedEnv.HOME = join(root, "home");
sanitizedEnv.USERPROFILE = join(root, "home");
sanitizedEnv.APPDATA = join(root, "appdata");
sanitizedEnv.LOCALAPPDATA = join(root, "appdata");

const capturedLines: string[] = [];
function capturingFactory(build: () => Promise<Awaited<ReturnType<typeof createOfficialCodexTransport>>>): OfficialRuntimeTransportFactory {
  return async () => {
    const transport = await build();
    return {
      send: (line: string) => transport.send(line),
      receive: () =>
        transport.receive().then((value) => {
          if (value !== null) capturedLines.push(value);
          return value;
        }),
      stop: () => transport.stop(),
    };
  };
}

const outcome: Record<string, unknown> = { root, mode };

if (mode === "api") {
  sanitizedEnv.CODEX_API_KEY = "offline-fake-invalid-key";
  const endpointContext: CodexEndpointContext = createCodexApiEndpointContext({
    codexHome,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    sourceEnvironment: sanitizedEnv,
  });
  // Replicates CodexAdapter's own default endpoint-context transport closure
  // (codex-adapter.ts), adding only wire capture -- prepareEndpoint (config.toml
  // seeding) and the real per-endpoint environment resolution both still run.
  const transportFactory = capturingFactory(async () => {
    const environment = resolveCodexEndpointProcessEnvironment(
      endpointContext.sourceEnvironment ?? process.env,
      endpointContext.environmentSource,
    );
    await endpointContext.prepareEndpoint?.();
    return createOfficialCodexTransport(undefined, { environment });
  });
  const adapter = new CodexAdapter(transportFactory, undefined, undefined, endpointContext);
  try {
    const binding = await adapter.start({
      projectDirectory: join(root, "project"),
      profile: { model: "gpt-5.6-codex", effortLevel: "medium", executionMode: "single-agent", accessMode: "full-access" },
    });
    outcome.startOk = true;
    await binding.send({ text: "W322_429_PROBE_INPUT" });
    const events: unknown[] = [];
    try {
      for await (const event of binding.events()) events.push(event);
      outcome.events = events;
      outcome.eventsDone = true;
    } catch (error) {
      outcome.events = events;
      outcome.eventsErrorCategory = error instanceof RuntimeAdapterError ? error.category : String(error);
      outcome.eventsErrorMessage = (error as Error)?.message;
    }
  } catch (error) {
    outcome.startErrorCategory = error instanceof RuntimeAdapterError ? error.category : String(error);
    outcome.startErrorMessage = (error as Error)?.message;
  }
} else {
  mkdirSync(codexHome);
  sanitizedEnv.CODEX_HOME = codexHome;
  // Strings-scanning codex.exe 0.153.4 found `chatgpt_base_url` as a real
  // ConfigToml field (default "https://chatgpt.com/backend-api/") overridable by
  // `CODEX_APP_SERVER_CHATGPT_BASE_URL`, whose validator explicitly allows an
  // HTTP localhost URL. Set here so that IF the unauthenticated app-server ever
  // attempted an upstream call, it would land on the fake 429 server rather than
  // the real backend -- the measurement below is whether it does so at all.
  sanitizedEnv.CODEX_APP_SERVER_CHATGPT_BASE_URL = `http://127.0.0.1:${address.port}/backend-api/`;
  const adapter = new CodexAdapter(
    capturingFactory(() => createOfficialCodexTransport(undefined, { environment: sanitizedEnv })),
  );
  try {
    await adapter.inspect(join(root, "project"));
    outcome.inspectOk = true;
  } catch (error) {
    outcome.inspectErrorCategory = error instanceof RuntimeAdapterError ? error.category : String(error);
    outcome.inspectErrorMessage = (error as Error)?.message;
  }
  outcome.upstreamRequestCountAfterInspect = calls.length;
  try {
    const binding = await adapter.start({
      projectDirectory: join(root, "project"),
      profile: { model: "gpt-5.6-codex", effortLevel: "medium", executionMode: "single-agent", accessMode: "full-access" },
    });
    outcome.startOk = true;
    void binding;
  } catch (error) {
    outcome.startErrorCategory = error instanceof RuntimeAdapterError ? error.category : String(error);
    outcome.startErrorMessage = (error as Error)?.message;
  }
}

outcome.upstreamRequestCount = calls.length;
outcome.upstreamCalls = calls;
writeFileSync(outFile, capturedLines.join("\n") + (capturedLines.length ? "\n" : ""));
console.log(JSON.stringify(outcome, null, 2));
server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
