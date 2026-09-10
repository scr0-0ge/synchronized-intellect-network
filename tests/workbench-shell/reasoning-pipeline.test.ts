import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import type { ResumableAgentRuntimeAdapter, SessionProfile } from "../../src/agent-runtime/index.ts";
import { createWorkbenchCoordinator } from "../../src/coordinator/index.ts";
import type { WorkbenchProjectResult } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchLiveView } from "../../src/workbench-shell/live-view.ts";
import { sanitizeWorkbenchProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { ScriptedTransport } from "../agent-runtime/support/scripted-transport.ts";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";

// Only the external wire is scripted. Every hop from binding to rendered HTML
// uses production code, including SQLite writes, readback and live observation.
class HeldTransport {
  lines: string[] = [];
  pending: ((line: string | null) => void) | undefined;
  stopped = false;
  async send(_line: string) {}
  push(...frames: unknown[]) {
    this.lines.push(...frames.map((frame) => JSON.stringify(frame)));
    if (this.pending && this.lines.length) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve(this.lines.shift()!);
    }
  }
  async receive(): Promise<string | null> {
    if (this.lines.length) return this.lines.shift()!;
    if (this.stopped) return null;
    return new Promise((resolve) => { this.pending = resolve; });
  }
  async stop() {
    this.stopped = true;
    this.pending?.(null);
    this.pending = undefined;
  }
  async drained() {
    await eventually(() => Boolean(this.pending) || this.stopped);
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "scripted pipeline reached its observation boundary");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const codexProfile = {
  model: "gpt-5.6-sol", effortLevel: "ultra",
  executionMode: "single-agent", accessMode: "full-access",
};
function codexFrame(method: string, params: Record<string, unknown>) {
  return { jsonrpc: "2.0", method, params: {
    threadId: "thread-fixed", turnId: "turn-fixed", ...params,
  } };
}

async function codexTransport() {
  const transport = new HeldTransport();
  const fixture = (await readFile(new URL("../agent-runtime/fixtures/single-turn-success.jsonl", import.meta.url), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  // Stop immediately after turn/started; no answer or terminal frame exists yet.
  transport.push(...fixture.slice(0, 7));
  let connections = 0;
  const adapter = new CodexAdapter(async () => ++connections === 1
    ? ScriptedTransport.fromFixture(new URL("../agent-runtime/fixtures/catalog-success.jsonl", import.meta.url))
    : transport);
  return { transport, adapter };
}

async function pipeline(t: TestContext, adapter: ResumableAgentRuntimeAdapter, profile: SessionProfile, transport: HeldTransport) {
  const root = await mkdtemp(join(tmpdir(), "uaw-w488-reasoning-"));
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory);
  const channel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(projectDirectory);
  const live = createWorkbenchLiveView({ channel, projectDirectory });
  let latest: WorkbenchProjectResult | undefined;
  let raw: WorkbenchProjectResult | undefined;
  const dispose = live.observe((value) => { raw = value; latest = sanitizeWorkbenchProjectResult(value); });
  const server = await createViteSsrTestServer({
    configFile: false, appType: "custom", logLevel: "silent",
    root: fileURLToPath(new URL("../..", import.meta.url)),
    plugins: [solid({ ssr: true })], server: { middlewareMode: true },
  });
  t.after(async () => {
    await transport.stop(); dispose(); await live.close(); await channel.close();
    await server.close(); await rm(root, { recursive: true, force: true });
  });
  const { SessionTranscript } = await server.ssrLoadModule("/src/workbench-shell/renderer/transcript.tsx");
  await channel.act({
    kind: "direct", commandKind: "start", idempotencyKey: "reasoning-test", runtime: "codex",
    catalogRevision: "fixture", preferences: { global: profile }, profile, input: "hello",
  });
  await transport.drained();
  return {
    channel,
    databasePath,
    async rendered() {
      await transport.drained();
      const snapshot = await channel.snapshot();
      await eventually(() => latest !== undefined && (!latest.ok || latest.view.observation.cursor === snapshot.cursor));
      assert.ok(latest?.ok, "the public project view must remain available for reasoning");
      const command = latest.view.commands[0]!;
      const html = renderToString(() => SessionTranscript({ command }));
      // The event log is a separate disclosure, not proof of visible reasoning.
      const reasoning = [...html.matchAll(/<details[^>]*class="turn-reasoning"[^>]*>[\s\S]*?<\/details>/gu)].map((m) => m[0]).join("\n");
      const visible = html.replace(/<ol[^>]*class="event-log"[^>]*>[\s\S]*?<\/ol>/gu, "");
      const activity = html.match(/<p[^>]*class="turn-progress"[^>]*>[\s\S]*?<\/p>/u)?.[0] ?? "";
      return { html, visible, activity, reasoning, command, snapshot, raw: raw! };
    },
  };
}

test("tool credentials are redacted before truncation across both durable pipelines", async (t) => {
  const secrets = {
    environment: `ENV_SECRET_${"e".repeat(180)}`,
    header: `HEADER_SECRET_${"h".repeat(180)}`,
    flag: `FLAG_SECRET_${"f".repeat(180)}`,
  };
  const normalCommand = "pnpm test --filter agent-runtime";
  const credentialCommand =
    `API_TOKEN=${secrets.environment} curl -H "Authorization: Bearer ${secrets.header}" ` +
    `--api-key ${secrets.flag} https://example.test/resource`;
  const redactedCommand =
    "API_TOKEN=<redacted> curl -H \"Authorization: <redacted>\" " +
    "--api-key <redacted> https://example.test/resource";

  for (const runtime of ["codex", "claude"] as const) {
    await t.test(runtime, async (child) => {
      let run: Awaited<ReturnType<typeof pipeline>>;
      if (runtime === "codex") {
        const { adapter, transport } = await codexTransport();
        run = await pipeline(child, adapter, codexProfile, transport);
        transport.push(
          codexFrame("item/started", {
            item: {
              id: "normal-command",
              type: "commandExecution",
              name: "Bash",
              command: normalCommand,
            },
          }),
          codexFrame("item/started", {
            item: {
              id: "credential-command",
              type: "commandExecution",
              name: "Bash",
              command: credentialCommand,
            },
          }),
        );
      } else {
        const transport = new ClaudeTransport();
        run = await pipeline(child, claudeAdapter(transport), glmProfile, transport);
        transport.push(
          assistantFrame("tool-commands", [
            {
              type: "tool_use",
              id: "normal-command",
              name: "Bash",
              input: { command: normalCommand },
            },
            {
              type: "tool_use",
              id: "credential-command",
              name: "Bash",
              input: { command: credentialCommand },
            },
          ]),
        );
      }

      const { command, html, raw, snapshot } = await run.rendered();
      const commandParameters = command.session!.timeline.flatMap((event) =>
        event.kind === "progress" && event.tool?.parameter?.kind === "command"
          ? [event.tool.parameter]
          : [],
      );
      assert.deepEqual(commandParameters, [
        { kind: "command", value: normalCommand, truncated: false },
        { kind: "command", value: redactedCommand, truncated: false },
      ]);
      assert.match(html, /pnpm test --filter agent-runtime/u, "normal commands remain visible in full");
      assert.match(html, /Authorization: &lt;redacted>/u, "the transcript labels the removed header value");

      const database = new DatabaseSync(run.databasePath, { readOnly: true });
      const durableJson = (
        database.prepare("SELECT data_json FROM updates WHERE data_json IS NOT NULL").all() as Array<{
          data_json: string;
        }>
      )
        .map(({ data_json }) => data_json)
        .join("\n");
      database.close();

      for (const secret of Object.values(secrets)) {
        assert.doesNotMatch(durableJson, new RegExp(secret, "u"), "credentials never enter SQLite");
        assert.doesNotMatch(html, new RegExp(secret, "u"), "credentials never reach the transcript");
        assert.doesNotMatch(JSON.stringify(raw), new RegExp(secret, "u"));
        assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret, "u"));
      }
      assert.match(durableJson, /Authorization: <redacted>/u);
    });
  }
});

test("an oversized Codex tool type degrades to the bounded unknown source", async (t) => {
  const { adapter, transport } = await codexTransport();
  const run = await pipeline(t, adapter, codexProfile, transport);
  const oversizedSourceType = "x".repeat(100_000);
  transport.push(
    codexFrame("item/started", {
      item: {
        id: "oversized-tool-type",
        type: oversizedSourceType,
        name: "Future Tool",
      },
    }),
  );

  const { command, html } = await run.rendered();
  const tool = command.session!.timeline.find(
    (event) => event.kind === "progress" && event.activity === "tool",
  );
  assert.deepEqual(tool, {
    kind: "progress",
    activity: "tool",
    tool: { type: "unknown", sourceType: "unknown", name: "Future Tool" },
  });
  assert.match(html, /unrecognized type: unknown/u);

  const database = new DatabaseSync(run.databasePath, { readOnly: true });
  const durableJson = (
    database.prepare("SELECT data_json FROM updates WHERE data_json IS NOT NULL").all() as Array<{
      data_json: string;
    }>
  )
    .map(({ data_json }) => data_json)
    .join("\n");
  database.close();
  assert.equal(durableJson.includes(oversizedSourceType), false);
  assert.ok(durableJson.length < oversizedSourceType.length);
});

test("Codex summary delta renders through the durable pipeline before the following answer", async (t) => {
  const { adapter, transport } = await codexTransport();
  const run = await pipeline(t, adapter, codexProfile, transport);
  transport.push(
    codexFrame("item/started", { item: { id: "r1", type: "reasoning", summary: [], content: [] } }),
    codexFrame("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex: 0, delta: "Compare the two implementations first." }),
  );
  const { command, reasoning } = await run.rendered();
  assert.equal(command.status, "in-flight", "reasoning must not terminate or invalidate the turn");
  assert.match(reasoning, /Compare the two implementations first\./u,
    "real summary text must render while the next answer frame is withheld");
  assert.equal(command.session!.timeline.some((event) => event.kind === "agent-message"), false);
});

const glmProfile = { model: "glm-5.3[1m]", effortLevel: "default", executionMode: "single-agent", accessMode: "full-access" };
class ClaudeTransport extends HeldTransport {
  hook = "";
  override async send(line: string) {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      const init = frame.request.subtype === "initialize";
      if (init && frame.request.hooks) this.hook = frame.request.hooks.Stop[0].hookCallbackIds[0];
      this.push({ type: "control_response", response: {
        subtype: "success", request_id: frame.request_id,
        response: init ? { models: [{ value: glmProfile.model }] } : {
          effective: { effortLevel: null, ultracode: false },
          sources: [{ source: "flagSettings", settings: { effortLevel: null, ultracode: false } }],
          applied: { model: glmProfile.model, effort: null, advisor: null, ultracode: false },
        },
      } });
    } else if (frame.type === "user") {
      this.push({ type: "system", subtype: "init", model: glmProfile.model,
        permissionMode: "bypassPermissions", session_id: "claude-test" });
    }
  }
}
function claudeFrame(event: unknown) {
  return { type: "stream_event", session_id: "claude-test", parent_tool_use_id: null, event };
}
function assistantFrame(id: string, content: unknown[]) {
  return { type: "assistant", session_id: "claude-test", parent_tool_use_id: null,
    message: { id, role: "assistant", content } };
}
function claudeAdapter(transport: ClaudeTransport) {
  return new ClaudeAdapter(async () => new ClaudeTransport(), async () => transport);
}

test("Claude-family GLM-shaped thinking delta renders before block completion and after the first answer", async (t) => {
  const transport = new ClaudeTransport();
  const run = await pipeline(t, claudeAdapter(transport), glmProfile, transport);
  transport.push(
    assistantFrame("first", [{ type: "text", text: "I have checked the first file." }]),
    claudeFrame({ type: "message_start", message: { id: "second", role: "assistant" } }),
    claudeFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    claudeFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Now compare the second file." } }),
  );
  const { command, visible, activity, reasoning } = await run.rendered();
  assert.equal(command.status, "in-flight", "partial messages must keep the real turn running");
  assert.match(reasoning, /Now compare the second file\./u, "partial thinking is visible without block_stop or assistant echo");
  assert.match(visible, /I have checked the first file\./u, "reasoning continues after a real assistant message");
  assert.match(activity, /thinking/iu, "activity remains visible after the first answer");
});

test("Codex completed summary fallback follows commentary without duplicating streamed summaries", async (t) => {
  const { adapter, transport } = await codexTransport();
  const run = await pipeline(t, adapter, codexProfile, transport);
  transport.push(
    codexFrame("item/started", { item: { id: "comment", type: "agentMessage" } }),
    codexFrame("item/completed", { item: { id: "comment", type: "agentMessage", phase: "commentary", text: "First inspection is complete." } }),
    codexFrame("item/started", { item: { id: "r1", type: "reasoning" } }),
    codexFrame("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex: 0, delta: "Check the alternatives." }),
    codexFrame("item/completed", { item: { id: "r1", type: "reasoning", summary: ["Check the alternatives.", "The second route is simpler."], content: ["RAW_REASONING_MUST_STAY_PRIVATE"] } }),
  );
  const { html, visible, reasoning, command } = await run.rendered();
  assert.match(reasoning, /The second route is simpler\./u, "completed-only summaries still appear before the following answer");
  assert.equal(reasoning.match(/Check the alternatives\./gu)?.length, 1, "a summary echo must not duplicate streamed reasoning");
  assert.match(visible, /First inspection is complete\./u, "completed commentary is visible before later reasoning");
  assert.ok(visible.indexOf("First inspection is complete.") < visible.indexOf('class="turn-reasoning"'));
  assert.doesNotMatch(html, /RAW_REASONING_MUST_STAY_PRIVATE/u);
  assert.equal(command.status, "in-flight");
});

test("Claude redacted blocks and signatures never reach rendered output and public echoes appear once", async (t) => {
  const transport = new ClaudeTransport();
  const run = await pipeline(t, claudeAdapter(transport), glmProfile, transport);
  transport.push(
    claudeFrame({ type: "message_start", message: { id: "private", role: "assistant" } }),
    claudeFrame({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "REDACTED_START_SENTINEL" } }),
    claudeFrame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "REDACTED_DELTA_SENTINEL" } }),
    claudeFrame({ type: "content_block_stop", index: 0 }),
    claudeFrame({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "Visible analysis.", signature: "SIGNATURE_START_SENTINEL" } }),
    claudeFrame({ type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "SIGNATURE_DELTA_SENTINEL" } }),
    claudeFrame({ type: "content_block_stop", index: 1 }),
    claudeFrame({ type: "message_stop" }),
    assistantFrame("private", [
      { type: "redacted_thinking", data: "REDACTED_COMPLETE_SENTINEL", thinking: "REDACTED_EXTRA_SENTINEL" },
      { type: "thinking", thinking: "Visible analysis.", signature: "SIGNATURE_COMPLETE_SENTINEL" },
    ]),
    assistantFrame("fallback", [{ type: "thinking", thinking: "Completed block fallback.", signature: "SIGNATURE_FALLBACK_SENTINEL" }]),
  );
  const { html, reasoning, command, snapshot } = await run.rendered();
  assert.equal(command.status, "in-flight");
  assert.equal(reasoning.match(/Visible analysis\./gu)?.length, 1, "the full assistant echo must not duplicate partial thinking");
  assert.match(reasoning, /Completed block fallback\./u, "completed-only thinking still appears during the turn");
  assert.doesNotMatch(html, /(?:REDACTED|SIGNATURE)_\w+_SENTINEL/u, "vendor-redacted data and signatures must not reach any renderer surface");
  assert.doesNotMatch(JSON.stringify(snapshot), /(?:REDACTED|SIGNATURE)_\w+_SENTINEL/u, "vendor-redacted data must not enter the durable store");
});

test("split reasoning paths are sanitized after assembly at both public boundaries", async (t) => {
  const { adapter, transport } = await codexTransport();
  const run = await pipeline(t, adapter, codexProfile, transport);
  transport.push(
    codexFrame("item/started", { item: { id: "path", type: "reasoning" } }),
    codexFrame("item/reasoning/summaryTextDelta", { itemId: "path", summaryIndex: 0, delta: "Open C:\\Users\\" }),
    codexFrame("error", { error: { willRetry: true } }),
    codexFrame("item/reasoning/summaryTextDelta", { itemId: "path", summaryIndex: 0, delta: "Ada\\project\\file.ts then compare.\u0001 <script>unsafe()</script>" }),
  );
  const { reasoning, raw, activity } = await run.rendered();
  assert.match(reasoning, /Open \[path\] then compare\./u, "path redaction must span delta boundaries");
  assert.match(activity, /thinking/iu, "new thinking text replaces stale retry activity");
  assert.doesNotMatch(JSON.stringify(raw), /Ada|file\.ts/u, "live projection independently redacts assembled reasoning paths");
  assert.match(reasoning, /&lt;script>unsafe\(\)&lt;\/script>/u, "reasoning renders as literal text");
  const injected = structuredClone(raw);
  replaceReasoning(injected, (event) => { event.text = "Inspect C:\\Users\\Ada\\secret.ts\u0001 then compare."; });
  const sanitized = sanitizeWorkbenchProjectResult(injected);
  assert.equal(sanitized.ok, true);
  assert.doesNotMatch(JSON.stringify(sanitized), /Ada|secret\.ts|\\u0001/u, "IPC sanitizer independently removes paths and controls");
  replaceReasoning(injected, (event) => { event.unadmitted = "EXTRA_FIELD"; });
  assert.equal(sanitizeWorkbenchProjectResult(injected).ok, false, "reasoning IPC events reject extra keys");
});

test("Codex fileChange wire becomes a persistent path and exact line-count summary", async (t) => {
  const { adapter, transport } = await codexTransport();
  const run = await pipeline(t, adapter, codexProfile, transport);
  transport.push(
    codexFrame("item/started", {
      item: {
        id: "change-1",
        type: "fileChange",
        status: "inProgress",
        changes: [],
      },
    }),
    codexFrame("item/completed", {
      item: {
        id: "change-1",
        type: "fileChange",
        status: "completed",
        changes: [
          {
            path: "a.ts",
            kind: { type: "update" },
            diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+PRIVATE_DIFF_LINE\n context",
          },
          {
            path: "b.ts",
            kind: { type: "update" },
            diff: "PRIVATE_UNCOUNTABLE_DIFF",
          },
          {
            path: "c.ts",
            kind: { type: "add" },
            diff: "@@ -0,0 +1 @@\n+created",
          },
        ],
      },
    }),
  );
  const { visible, command, snapshot, raw } = await run.rendered();
  assert.equal(command.status, "in-flight");
  assert.match(
    visible,
    /Changed 3 files: a\.ts \+2\/-1; b\.ts; c\.ts \+1\/-0/u,
  );
  assert.doesNotMatch(
    JSON.stringify({ snapshot, raw }),
    /PRIVATE_(?:DIFF_LINE|UNCOUNTABLE_DIFF)|@@ -/u,
    "diff text is reduced before the durable/public boundary",
  );
});

function replaceReasoning(value: unknown, edit: (event: Record<string, unknown>) => void) {
  if (typeof value !== "object" || value === null) return;
  if ("kind" in value && value.kind === "reasoning") edit(value as Record<string, unknown>);
  else for (const child of Object.values(value)) replaceReasoning(child, edit);
}

test("Codex reasoning rejects mismatched correlation and omits malformed optional deltas", async () => {
  for (const [change, category] of [
    [{ turnId: "wrong-turn" }, "correlation-invalid"],
    [{ itemId: "wrong-item" }, "correlation-invalid"],
    [{ delta: 42 }, "protocol-invalid"],
    [{ summaryIndex: -1 }, "protocol-invalid"],
  ] as const) {
    const { adapter, transport } = await codexTransport();
    await adapter.inspect("project");
    const binding = await adapter.start({ projectDirectory: "project", profile: codexProfile });
    await binding.send({ text: "hello" });
    transport.push(
      codexFrame("item/started", { item: { id: "r1", type: "reasoning" } }),
      codexFrame("item/reasoning/summaryTextDelta", { itemId: "r1", summaryIndex: 0, delta: "Bounded summary", ...change }),
      codexFrame("item/started", { item: { id: "final", type: "agentMessage" } }),
      codexFrame("item/completed", { item: { id: "final", type: "agentMessage", phase: "final_answer", text: "Done" } }),
      codexFrame("turn/completed", { turn: { id: "turn-fixed", status: "completed" } }),
    );
    const events = [];
    for await (const event of binding.events()) events.push(event);
    assert.deepEqual(events.at(-1), category === "correlation-invalid"
      ? { kind: "failed", category }
      : { kind: "turn-completed", status: "completed" }, `reject ${JSON.stringify(change)}`);
    assert.equal(events.some((event) => event.kind === "reasoning"), false, "invalid reasoning is never forwarded");
  }
});

test("Claude reasoning rejects malformed and unbound thinking deltas", async () => {
  for (const [change, category] of [
    [{ index: 9, delta: { type: "thinking_delta", thinking: "Wrong block" } }, "correlation-invalid"],
    [{ index: 0, delta: { type: "thinking_delta", thinking: 42 } }, "protocol-invalid"],
  ] as const) {
    const transport = new ClaudeTransport();
    const binding = await claudeAdapter(transport).start({ projectDirectory: "project", profile: glmProfile });
    await binding.send({ text: "hello" });
    transport.push(
      claudeFrame({ type: "message_start", message: { id: "invalid", role: "assistant" } }),
      claudeFrame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      claudeFrame({ type: "content_block_delta", ...change }),
      // If the malformed delta were admitted, a valid final result would win.
      assistantFrame("final", [{ type: "text", text: "Done" }]),
      { type: "control_request", request_id: "stop", request: { subtype: "hook_callback", callback_id: transport.hook,
        input: { hook_event_name: "Stop", session_id: "claude-test", permission_mode: "bypassPermissions", effort: { level: "high" } } } },
      { type: "result", subtype: "success", is_error: false, result: "Done", terminal_reason: "completed", session_id: "claude-test" },
    );
    const events = [];
    for await (const event of binding.events()) events.push(event);
    assert.deepEqual(events.at(-1), { kind: "failed", category }, `reject ${JSON.stringify(change)}`);
  }
});
