import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntimeBinding } from "../../src/agent-runtime/codex/binding.ts";
import { CodexJsonlPeer } from "../../src/agent-runtime/codex/protocol.ts";
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";

const profile = { model: "kimi-k2.7-code", effortLevel: "default", executionMode: "single-agent", accessMode: "full-access" };
const access = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } as const;
const notification = (method: string, params: Record<string, unknown>) => ({ method, params });
const turnStarted = notification("turn/started", { threadId: "thread", turn: { id: "current", status: "inProgress" } });
const terminal = notification("turn/completed", { threadId: "thread", turn: { id: "current", status: "completed" } });
const startAck = { id: 1, result: { turn: { id: "current", status: "inProgress" } } };
function item(method: string, id: string, type: string, fields = {}) {
  return notification(method, { threadId: "thread", turnId: "current", item: { id, type, ...fields } });
}
function answer(id: string, text: string) {
  return [item("item/started", id, "agentMessage"), item("item/completed", id, "agentMessage", { text, phase: null })];
}
const guidanceEcho = item("item/completed", "guidance", "userMessage", {
  content: [{ type: "text", text: "GUIDED", text_elements: [] }],
});
function usage(turnId: unknown) {
  const counts = { totalTokens: 20, inputTokens: 15, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 };
  return notification("thread/tokenUsage/updated", { threadId: "thread", turnId,
    tokenUsage: { total: counts, last: counts, modelContextWindow: 100 } });
}
function binding(frames: unknown[], resumed = false) {
  const transport = new ScriptedTransport(frames.map(frame => JSON.stringify(frame)));
  return new CodexRuntimeBinding(new CodexJsonlPeer(transport), "thread", profile, access, resumed ? "resumed" : "new");
}
async function collect(iterator: AsyncIterator<NormalizedRuntimeEvent>) {
  const events: NormalizedRuntimeEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}
async function guided(tail: unknown[], acknowledgement: unknown = { id: 2, result: { turnId: "current" } }) {
  // Lifecycle measured in live-text-guidance: receipt -> FIRST -> consumed user
  // guidance -> GUIDED -> one completed turn. IDs/text shortened, phases unchanged.
  const runtime = binding([startAck, notification("thread/started", { thread: { id: "thread" } }), turnStarted, acknowledgement, ...tail]);
  await runtime.send({ text: "FIRST" });
  const iterator = runtime.events()[Symbol.asyncIterator]();
  await iterator.next(); await iterator.next();
  const receipt = runtime.steer({ text: "GUIDED" }).then(() => true, () => false);
  const events = await collect(iterator);
  return { events, accepted: await receipt };
}
async function resumed(frames: unknown[]) {
  const runtime = binding(frames, true);
  await runtime.send({ text: "SECOND" });
  return collect(runtime.events()[Symbol.asyncIterator]());
}

test("accepted consumed guidance separates two unphased answers without losing either", async () => {
  const { events, accepted } = await guided([...answer("first", "FIRST"), guidanceEcho, ...answer("guided", "GUIDED"), terminal]);
  assert.equal(accepted, true);
  assert.deepEqual(events.filter(event => event.kind === "agent-message"), [
    { kind: "agent-message", text: "FIRST" }, { kind: "agent-message", text: "GUIDED" },
  ]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
});

test("guidance consumed during a tool leg still needs only its one subsequent answer", async () => {
  const { events } = await guided([guidanceEcho, ...answer("guided", "GUIDED"), terminal]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
});

test("guidance never excuses ambiguous finals, a missing new answer, or a broken item identity", async (t) => {
  for (const [name, tail, acknowledgement] of [
    ["receipt without consumed input", [...answer("first", "FIRST"), ...answer("second", "SECOND"), terminal]],
    ["two answers before the boundary", [...answer("a", "A"), ...answer("b", "B"), guidanceEcho, ...answer("c", "C"), terminal]],
    ["two answers after the boundary", [...answer("a", "A"), guidanceEcho, ...answer("b", "B"), ...answer("c", "C"), terminal]],
    ["no answer after guidance", [...answer("a", "A"), guidanceEcho, terminal]],
    ["completion without item start", [item("item/completed", "a", "agentMessage", { text: "A", phase: null }), guidanceEcho, ...answer("b", "B"), terminal]],
    ["unmatched guidance text", [...answer("a", "A"), item("item/completed", "other", "userMessage", { content: [{ type: "text", text: "NOT ACCEPTED" }] }), ...answer("b", "B"), terminal]],
    ["refused guidance", [...answer("a", "A"), guidanceEcho, ...answer("b", "B"), terminal], { id: 2, error: { code: -32602, message: "refused" } }],
  ] as const) await t.test(name, async () => {
    const { events } = await guided([...tail], acknowledgement);
    assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
  });
});

test("resume's buffered previous-turn usage does not enter the new turn's context", async () => {
  const events = await resumed([usage("previous"), startAck, turnStarted, ...answer("second", "SECOND"), terminal]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
});

test("a new session cannot claim a wrong buffered usage id is a resume snapshot", async () => {
  const runtime = binding([usage("wrong"), startAck, notification("thread/started", { thread: { id: "thread" } }), turnStarted, ...answer("a", "A"), terminal]);
  await runtime.send({ text: "FIRST" });
  const events = await collect(runtime.events()[Symbol.asyncIterator]());
  assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
});

test("even a resume snapshot must identify its turn before it can be historical", async () => {
  await assert.rejects(resumed([usage(undefined), startAck, turnStarted, ...answer("a", "A"), terminal]), {
    category: "correlation-invalid",
  });
});

test("a known resume snapshot arriving again late is historical, while current usage is retained", async () => {
  const events = await resumed([usage("previous"), startAck, turnStarted, usage("previous"), usage("current"), ...answer("second", "SECOND"), terminal]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed", context: {
    basis: "active-context", usedTokens: 20, windowTokens: 100,
  } });
});

test("current-turn correlation remains fatal after historical resume usage is excluded", async (t) => {
  for (const [name, bad] of [
    ["unknown turn id", usage("wrong-current-turn")],
    ["missing turn id", usage(undefined)],
    ["malformed turn id", usage(42)],
    ["wrong item turn id", notification("item/started", { threadId: "thread", turnId: "previous", item: { id: "a", type: "agentMessage" } })],
    ["wrong terminal turn id", notification("turn/completed", { threadId: "thread", turn: { id: "previous", status: "completed" } })],
  ] as const) await t.test(name, async () => {
    const events = await resumed([usage("previous"), startAck, turnStarted, bad, ...answer("second", "SECOND"), terminal]);
    assert.ok(events.some(event => event.kind === "turn-started"), "must reach the current turn before rejecting its bad correlation");
    assert.deepEqual(events.at(-1), { kind: "failed", category: "correlation-invalid" });
  });
});
