import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import { createGlmEndpointContext } from "../../src/agent-runtime/claude/glm-catalog.ts";
import {
  createOfficialClaudeSessionTransport,
  discoverClaudeLaunch,
  productionClaudeCatalogProcessDependencies,
} from "../../src/agent-runtime/claude/process-transport.ts";

/** A 1x1 transparent PNG, the smallest well-formed PNG commonly used as a test fixture. */
const onePixelPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("real Claude CLI plus fake HTTP: a turn image attachment reaches the Anthropic wire byte-for-byte (zero inference)", async (t) => {
  let launch;
  try {
    launch = await discoverClaudeLaunch();
  } catch (error) {
    if ((error as { category?: string }).category === "runtime-not-located") {
      t.skip("Claude CLI is not installed on this machine");
      return;
    }
    throw error;
  }
  t.diagnostic(`observed launch: ${JSON.stringify(launch)}`);

  const harness = await fakeAnthropicHarness();
  try {
    const binding = await harness.adapter.start({
      projectDirectory: join(harness.root, "project"),
      profile: harness.profile,
    });
    await binding.send({
      text: "W329_IMAGE_PROBE: describe the attached page image",
      images: [{ mediaType: "image/png", base64: onePixelPngBase64 }],
    });
    const events = [];
    for await (const event of binding.events()) events.push(event);
    t.diagnostic(JSON.stringify({ events, model: harness.profile.model }));
    assert.equal(events.at(-1)?.kind, "turn-completed");

    assert.equal(harness.bodies.length, 1, "exactly one inference-shaped POST reached the fake API");
    const content = lastUserContent(harness.bodies[0]);
    assert.ok(Array.isArray(content));
    const blockTypes = content.map((block) => (block as { type?: unknown }).type);
    assert.ok(blockTypes.includes("image"), `expected an image block among ${JSON.stringify(blockTypes)}`);
    const imageBlock = content.find((block) => (block as { type?: unknown }).type === "image") as {
      source?: { type?: unknown; media_type?: unknown; data?: unknown };
    };
    assert.equal(imageBlock.source?.type, "base64");
    assert.equal(imageBlock.source?.media_type, "image/png");
    assert.equal(imageBlock.source?.data, onePixelPngBase64);
    // The CLI appends its own <system-reminder> text block, so the prompt must
    // be found among the text blocks, not assumed to be the first block.
    assert.ok(
      textBlocks(content).some((text) => text.includes("W329_IMAGE_PROBE")),
      "the original prompt text must still reach the wire alongside the image block",
    );
  } finally {
    await harness.close();
  }
});

type Harness = Readonly<{
  adapter: ClaudeAdapter;
  root: string;
  profile: { model: string; effortLevel: string; executionMode: string; accessMode: string };
  bodies: unknown[];
  close(): Promise<void>;
}>;

async function fakeAnthropicHarness(): Promise<Harness> {
  const scratchBase = resolve(
    process.env.UAW_LANE_SCRATCH ?? process.env.RUNNER_TEMP ?? tmpdir(),
  );
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, "w329-image-"));
  for (const name of ["appdata", "config", "home", "project", "temp"]) {
    mkdirSync(join(root, name));
  }

  const bodies: unknown[] = [];
  const server = createServer(async (request, response) => {
    await answerAnthropic(request, response, bodies);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const environment = isolatedEnvironment(root);
  const diagnostics: unknown[] = [];
  const endpointContext = createGlmEndpointContext({
    configDir: join(root, "config"),
    sourceEnvironment: environment,
    baseUrl: `http://127.0.0.1:${address.port}`,
    resolveAuthToken: () => "w329-offline-fake-key",
  });
  const launch = await discoverClaudeLaunch();
  const dependencies = Object.freeze({
    ...productionClaudeCatalogProcessDependencies,
    discoverExecutable: async () => launch,
    environment,
    endpointEnvironment: endpointContext.environmentSource,
    authenticationMode: endpointContext.authenticationMode,
    apiKeyStaticHealthyAuthMethod: endpointContext.apiKeyStaticHealthyAuthMethod,
    recordDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
  });
  const adapter = new ClaudeAdapter(
    undefined,
    async (request) =>
      createOfficialClaudeSessionTransport(request, dependencies, undefined),
    undefined,
    undefined,
    undefined,
    undefined,
    endpointContext,
  );

  return Object.freeze({
    adapter,
    root,
    profile: {
      model: "glm-5.3[1m]",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    bodies,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(root, { recursive: true, force: true });
    },
  });
}

async function answerAnthropic(
  request: IncomingMessage,
  response: ServerResponse,
  bodies: unknown[],
): Promise<void> {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw.length === 0 ? undefined : JSON.parse(raw);
  if (request.url?.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: 0 }));
    return;
  }
  if (request.method !== "POST" || !request.url?.includes("/v1/messages")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected w329 fake request" } }));
    return;
  }
  bodies.push(body);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (frame: Record<string, unknown>) =>
    response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  emit({
    type: "message_start",
    message: {
      id: `msg_w329_${bodies.length}`,
      type: "message",
      role: "assistant",
      model: (body as { model?: string } | undefined)?.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  emit({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "W329_IMAGE_PROBE_OK" },
  });
  emit({ type: "content_block_stop", index: 0 });
  emit({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  emit({ type: "message_stop" });
  response.end();
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.HOME = join(root, "home");
  environment.USERPROFILE = join(root, "home");
  environment.APPDATA = join(root, "appdata");
  environment.LOCALAPPDATA = join(root, "appdata");
  environment.TEMP = join(root, "temp");
  environment.TMP = join(root, "temp");
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  environment.DISABLE_TELEMETRY = "1";
  return environment;
}

function lastUserContent(value: unknown): unknown {
  const lastUser = [...messages(value)].reverse().find((message) => message?.role === "user");
  return lastUser?.content;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts;
}

function messages(value: unknown): { role?: unknown; content?: unknown }[] {
  if (typeof value !== "object" || value === null || !("messages" in value)) return [];
  const list = (value as { messages?: unknown }).messages;
  return Array.isArray(list) ? (list as { role?: unknown; content?: unknown }[]) : [];
}
