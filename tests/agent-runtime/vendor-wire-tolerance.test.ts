import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CodexAdapter, catalogModelExtraKeys } from "../../src/agent-runtime/codex-adapter.ts";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import { readClaudeAppliedSettings } from "../../src/agent-runtime/claude/settings.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";

type Wire = Record<string, any>;
const privateExtra = { redacted_thinking: "UNCONSUMED_VENDOR_CANARY" };
const codexProfile = { model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access" };
const claudeProfile = { model: "opus-alias", effortLevel: "high", executionMode: "single-agent", accessMode: "full-access" };
const counts = { totalTokens: 20, inputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 };
const usage = () => ({ last: { ...counts }, total: { ...counts }, modelContextWindow: 100 });
const claudeUsage = () => ({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 });
const settings = (): Wire => ({ effective: {}, sources: [{ settings: {}, source: "flagSettings" }], errors: [{ file: "settings.json", path: "settings", message: "diagnostic" }], applied: { model: "opus-alias", effort: "high", ultracode: false } });
const isInvalid = (error: unknown) => error instanceof RuntimeAdapterError && error.category === "protocol-invalid";

function noExtras(value: unknown): void {
  const text = JSON.stringify(value);
  assert.equal(text.includes("UNCONSUMED_VENDOR_CANARY"), false, "vendor values must not reach downstream");
  assert.equal(text.includes("future_vendor_field"), false, "vendor keys must not reach downstream");
}

for (const site of ["envelope", "applied", "source", "error"] as const) {
  const target = (value: Wire): Wire => site === "envelope" ? value : site === "source" ? value.sources[0] : site === "error" ? value.errors[0] : value.applied;
  test(`vendor settings ${site}: additive key is dropped`, () => {
    const value = settings();
    target(value).future_vendor_field = privateExtra;
    const result = readClaudeAppliedSettings(value);
    assert.deepEqual(result, settings().applied);
    noExtras(result);
  });
  test(`vendor settings ${site}: required fields stay fatal`, () => {
    const key = { envelope: "sources", applied: "model", source: "source", error: "message" }[site];
    for (const missing of [true, false]) {
      const value = settings();
      if (missing) delete target(value)[key];
      else target(value)[key] = 42;
      assert.throws(() => readClaudeAppliedSettings(value), isInvalid, `${site}.${key} ${missing ? "missing" : "malformed"}`);
    }
  });
}

test("vendor settings effort: safe new spelling survives, malformed values fail", () => {
  const value = settings();
  value.applied.effort = "future-effort";
  assert.equal(readClaudeAppliedSettings(value)?.effort, "future-effort");
  for (const effort of [42, "", "   ", "bad\0value", {}, []]) {
    value.applied.effort = effort;
    assert.throws(() => readClaudeAppliedSettings(value), isInvalid);
  }
  delete value.applied.effort;
  assert.throws(() => readClaudeAppliedSettings(value), isInvalid);
});

async function resume(mutate: (value: Wire) => void) {
  const frames: Wire[] = (await readFile(new URL("./fixtures/resume-success.jsonl", import.meta.url), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  mutate(frames[2]!.result);
  const transport = new ScriptedTransport(frames.map(frame => JSON.stringify(frame)));
  const binding = await new CodexAdapter(async () => transport).resume({ projectDirectory: "project", profile: codexProfile, opaqueSessionReference: "thread-fixed" });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return { events, outbound: transport.recordedOutboundJsonl(), profile: binding.profile };
}

for (const site of ["envelope", "thread", "sandbox"] as const) {
  const target = (value: Wire): Wire => site === "envelope" ? value : value[site];
  test(`vendor resume ${site}: additive key is dropped`, async () => {
    const result = await resume(value => { target(value).future_vendor_field = privateExtra; });
    assert.equal(result.events.at(-1)?.kind, "turn-completed");
    assert.deepEqual(result.profile, codexProfile);
    noExtras(result);
  });
  test(`vendor resume ${site}: required fields stay fatal`, async () => {
    const key = { envelope: "model", thread: "id", sandbox: "type" }[site];
    for (const missing of [true, false]) {
      await assert.rejects(resume(value => {
        if (missing) delete target(value)[key];
        else target(value)[key] = 42;
      }), RuntimeAdapterError, `${site}.${key} ${missing ? "missing" : "malformed"}`);
    }
  });
}

async function codexUsage(value: unknown) {
  const frames: Wire[] = (await readFile(new URL("./fixtures/single-turn-success.jsonl", import.meta.url), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const terminal = frames.findIndex(frame => frame.method === "turn/completed" && frame.params.threadId === "thread-fixed");
  assert.notEqual(terminal, -1);
  frames.splice(terminal, 0, { method: "thread/tokenUsage/updated", params: { threadId: "thread-fixed", turnId: "turn-fixed", tokenUsage: value } });
  const transport = new ScriptedTransport(frames.map(frame => JSON.stringify(frame)));
  const binding = await new CodexAdapter(async () => transport).start({ projectDirectory: "project", profile: codexProfile });
  await binding.send({ text: "fixed input" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return events;
}

for (const site of ["envelope", "last", "total"] as const) {
  const target = (value: Wire): Wire => site === "envelope" ? value : value[site];
  test(`vendor Codex usage ${site}: additive key is dropped`, async () => {
    const value = usage();
    target(value).future_vendor_field = privateExtra;
    const events = await codexUsage(value);
    assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed", context: { basis: "active-context", usedTokens: 20, windowTokens: 100 } });
    noExtras(events);
  });
  test(`vendor Codex usage ${site}: required fields stay mandatory for the meter`, async () => {
    const key = site === "envelope" ? "modelContextWindow" : "totalTokens";
    for (const missing of [true, false]) {
      const value = usage();
      if (missing) delete target(value)[key];
      else target(value)[key] = "20";
      assert.deepEqual((await codexUsage(value)).at(-1), { kind: "turn-completed", status: "completed" });
    }
  });
}

async function codexControl(method: "steer" | "interrupt", result: unknown) {
  const frames: Wire[] = (await readFile(new URL("./fixtures/single-turn-success.jsonl", import.meta.url), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const turnStarted = frames.findIndex(frame => frame.method === "turn/started" && frame.params.threadId === "thread-fixed");
  frames.splice(turnStarted + 1, 0, { jsonrpc: "2.0", id: 6, result });
  const transport = new ScriptedTransport(frames.map(frame => JSON.stringify(frame)));
  const binding = await new CodexAdapter(async () => transport).start({ projectDirectory: "project", profile: codexProfile });
  await binding.send({ text: "fixed input" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  const receipt = method === "steer" ? binding.steer!({ text: "guidance" }) : binding.interrupt!();
  const outcome = receipt.then(() => undefined, error => error);
  const events = [];
  for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
  return { error: await outcome, events, outbound: transport.recordedOutboundJsonl() };
}

for (const method of ["steer", "interrupt"] as const) {
  test(`vendor Codex ${method}: additive receipt is dropped`, async () => {
    const observed = await codexControl(method, { ...(method === "steer" ? { turnId: "turn-fixed" } : {}), future_vendor_field: privateExtra });
    assert.equal(observed.error, undefined, "additive acknowledgement must not reject intervention");
    assert.equal(observed.events.at(-1)?.kind, "turn-completed");
    noExtras(observed);
  });
  test(`vendor Codex ${method}: malformed receipt stays fatal`, async () => {
    for (const result of method === "steer" ? [{}, { turnId: 42 }, { turnId: "other-turn" }, null] : [null, [], 42]) {
      const observed = await codexControl(method, result);
      assert.ok(isInvalid(observed.error));
      assert.equal(observed.events.at(-1)?.kind, method === "steer" ? "turn-completed" : "failed");
    }
  });
}

// Script only the official CLI control protocol. No process or provider is used.
class ClaudeWire {
  readonly sent: Wire[] = [];
  readonly lines: Wire[] = [];
  hookId = "";
  readonly options: { settings?: Wire; effort?: string; notification?: Wire; mutate?: (frames: Wire[]) => void };
  constructor(options: { settings?: Wire; effort?: string; notification?: Wire; mutate?: (frames: Wire[]) => void } = {}) { this.options = options; }
  async send(line: string) {
    const message = JSON.parse(line);
    this.sent.push(message);
    if (message.type === "control_request") {
      const request = message.request;
      let response: Wire;
      if (request.subtype === "initialize") {
        this.hookId = request.hooks.Stop[0].hookCallbackIds[0];
        response = { models: [{ value: "opus-alias", supportsEffort: true, supportedEffortLevels: [this.options.effort ?? "high"] }] };
      } else response = this.options.settings ?? settings();
      if (this.options.notification) this.lines.push(this.options.notification);
      this.lines.push({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    } else if (message.type === "user") {
      const frames: Wire[] = [
        { type: "system", subtype: "init", model: "opus-alias", permissionMode: "bypassPermissions", session_id: "native-session" },
        { type: "assistant", parent_tool_use_id: null, session_id: "native-session", message: { role: "assistant", content: [{ type: "text", text: "ANSWER" }] } },
        { type: "control_request", request_id: "stop-hook", request: { subtype: "hook_callback", callback_id: this.hookId, input: { hook_event_name: "Stop", session_id: "native-session", permission_mode: "bypassPermissions", effort: { level: this.options.effort ?? "high" } } } },
        { type: "result", session_id: "native-session", subtype: "success", is_error: false, terminal_reason: "completed", result: "ANSWER", usage: claudeUsage() },
      ];
      this.options.mutate?.(frames);
      this.lines.push(...frames);
    }
  }
  async receive() { const frame = this.lines.shift(); return frame === undefined ? null : JSON.stringify(frame); }
  async stop() {}
}

async function claude(options: ConstructorParameters<typeof ClaudeWire>[0] = {}) {
  const transport = new ClaudeWire(options);
  const binding = await new ClaudeAdapter(async () => transport, async () => transport).start({ projectDirectory: "project", profile: { ...claudeProfile, effortLevel: options.effort ?? "high" } });
  await binding.send({ text: "prompt" });
  const events = [];
  for await (const event of binding.events()) events.push(event);
  return { events, outbound: transport.sent };
}

test("vendor Claude usage: additive key is dropped with answer intact", async () => {
  const observed = await claude({ mutate: frames => { frames.at(-1)!.usage.future_vendor_field = privateExtra; frames.at(-1)!.usage.windowTokens = 1; } });
  assert.deepEqual(observed.events.at(-1), { kind: "turn-completed", status: "completed", context: { basis: "turn-usage", usedTokens: 65, windowTokens: null } });
  assert.ok(observed.events.some(event => event.kind === "agent-message" && event.text === "ANSWER"));
  noExtras(observed);
});

test("vendor Claude usage: missing or invalid counts discard the whole optional projection", async () => {
  for (const key of Object.keys(claudeUsage())) for (const missing of [true, false]) {
    const observed = await claude({ mutate: frames => { if (missing) delete frames.at(-1)!.usage[key]; else frames.at(-1)!.usage[key] = -1; } });
    assert.deepEqual(observed.events.at(-1), { kind: "turn-completed", status: "completed" });
    assert.equal(observed.events.some(event => "context" in event), false);
    assert.ok(observed.events.some(event => event.kind === "agent-message" && event.text === "ANSWER"));
    noExtras(observed);
  }
});

for (const site of ["frame", "system", "assistant"] as const) {
  test(`vendor Claude ${site}: unknown notification data is dropped`, async () => {
    const observed = await claude({ mutate: frames => {
      if (site === "assistant") frames[1]!.message.content.unshift({ type: "future_block", future_vendor_field: privateExtra }, { type: "redacted_thinking", data: privateExtra.redacted_thinking });
      else frames.splice(1, 0, { type: site === "system" ? "system" : "future_notification", ...(site === "system" ? { subtype: "future_subtype" } : {}), session_id: "native-session", future_vendor_field: privateExtra });
    } });
    assert.equal(observed.events.at(-1)?.kind, "turn-completed", "unconsumed notification must not discard answer");
    noExtras(observed);
  });
  test(`vendor Claude ${site}: consumed discriminator stays required`, async () => {
    for (const discriminator of [undefined, 42, ""]) {
      const observed = await claude({ mutate: frames => {
        if (site === "assistant") frames[1]!.message.content[0].type = discriminator;
        else frames.splice(1, 0, { type: site === "system" ? "system" : discriminator, ...(site === "system" ? { subtype: discriminator } : {}), session_id: "native-session" });
      } });
      assert.deepEqual(observed.events.at(-1), { kind: "failed", category: "protocol-invalid" });
    }
  });
}

test("vendor Claude settings: optional flag absence allows session start", async () => {
  const value = settings();
  delete value.applied.ultracode;
  const observed = await claude({ settings: value });
  assert.equal(observed.events.at(-1)?.kind, "turn-completed");
});

test("vendor Claude settings: future effort allows session start", async () => {
  const value = settings();
  value.applied.effort = "future-effort";
  const observed = await claude({ settings: value, effort: "future-effort" });
  assert.equal(observed.events.at(-1)?.kind, "turn-completed");
});

test("vendor Claude settings: missing applied is protocol corruption; positive mode mismatch is unsupported", async () => {
  const missing = settings();
  delete missing.applied;
  await assert.rejects(claude({ settings: missing }), isInvalid);
  const mismatch = settings();
  mismatch.applied.ultracode = true;
  await assert.rejects(claude({ settings: mismatch }), (error: unknown) => error instanceof RuntimeAdapterError && error.category === "unsupported-selection");
});

test("vendor Claude initialization: unknown notifications are dropped", async () => {
  const observed = await claude({ notification: { type: "future_notification", future_vendor_field: privateExtra } });
  assert.equal(observed.events.at(-1)?.kind, "turn-completed");
  noExtras(observed);
});

test("vendor Claude unknown top-level notifications are diagnosed while the answer survives", async (t) => {
  const summaries: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { summaries.push(String(chunk)); return true; });
  const observed = await claude({ mutate: frames => {
    frames.splice(1, 0,
      { type: "future_notification", session_id: "native-session", future_vendor_field: privateExtra },
      { type: "another_future_notification", session_id: "native-session", future_vendor_field: privateExtra },
    );
  } });
  assert.equal(observed.events.at(-1)?.kind, "turn-completed");
  assert.equal(summaries.filter(summary => summary.includes("gate=notification")).length, 1);
  assert.ok(summaries.some(summary => summary.includes(
    "kind=optional-data-unavailable category=protocol-invalid gate=notification",
  )));
  noExtras({ events: observed.events, summaries });
});

test("vendor Claude initialization: malformed discriminator and turn-bearing frames stay fatal", async () => {
  for (const type of [undefined, 42, "", "assistant", "result", "user", "control_request"]) {
    await assert.rejects(claude({ notification: { type } }), isInvalid);
  }
});

const streamFrames = (): Wire[] => [
  { type: "message_start", message: { id: "message-stream", role: "assistant" } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "PUBLIC" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_stop" },
];
async function claudeStream(mutate: (frames: Wire[]) => void) {
  return claude({ mutate: frames => {
    const stream = streamFrames();
    mutate(stream);
    frames.splice(1, 0, ...stream.map(event => ({ type: "stream_event", session_id: "native-session", parent_tool_use_id: null, event })));
  } });
}

for (const site of ["event", "block", "delta"] as const) {
  test(`vendor Claude stream ${site}: unknown data is dropped`, async () => {
    const observed = await claudeStream(frames => {
      if (site === "event") frames.splice(2, 0, { type: "future_event", future_vendor_field: privateExtra });
      if (site === "delta") frames.splice(2, 0, { type: "content_block_delta", index: 0, delta: { type: "future_delta", future_vendor_field: privateExtra } });
      if (site === "block") frames.splice(3, 0,
        { type: "content_block_start", index: 1, content_block: { type: "future_block", future_vendor_field: privateExtra } },
        { type: "content_block_delta", index: 1, delta: { type: "future_delta", future_vendor_field: privateExtra } },
        { type: "content_block_stop", index: 1 });
    });
    assert.equal(observed.events.at(-1)?.kind, "turn-completed");
    assert.ok(observed.events.some(event => event.kind === "reasoning" && event.text === "PUBLIC"));
    noExtras(observed);
  });
}

test("vendor Claude stream: malformed consumed fields stay fatal", async () => {
  const corruptions: ((frames: Wire[]) => void)[] = [
    frames => { delete frames[0]!.type; },
    frames => { frames[1]!.content_block.type = 42; },
    frames => { delete frames[1]!.content_block.thinking; },
    frames => { frames[1]!.index = -1; },
    frames => { frames.splice(2, 0, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: 42 } }); },
    frames => { frames.splice(2, 0, { type: "content_block_delta", index: 0, delta: {} }); },
  ];
  for (const mutate of corruptions) {
    const observed = await claudeStream(mutate);
    assert.equal(observed.events.at(-1)?.kind, "failed");
  }
});

test("vendor helper: every own descriptor and forbidden key stays checked without reading values", () => {
  let reads = 0;
  for (const key of ["required", "future_vendor_field"]) {
    const value = { required: "valid" };
    Object.defineProperty(value, key, { enumerable: true, get() { reads += 1; return "private"; } });
    assert.equal(catalogModelExtraKeys(value, ["required"]), undefined);
  }
  assert.equal(reads, 0);
  for (const key of ["__proto__", "constructor", "prototype", "bad\nkey", "bad\ud800"]) {
    const value = JSON.parse(JSON.stringify({ required: "valid", [key]: "private" }));
    assert.equal(catalogModelExtraKeys(value, ["required"]), undefined);
  }
  assert.equal(catalogModelExtraKeys({ future_vendor_field: privateExtra }, ["required"]), undefined);
  assert.deepEqual(catalogModelExtraKeys({ required: "valid", future_vendor_field: privateExtra }, ["required"]), ["future_vendor_field"]);
});
