import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { createRuntimeEndpointDirectory } from "../../src/agent-runtime/runtime-endpoint-directory.ts";
import { RuntimeAdapterError, type NormalizedRuntimeEvent, type NormalizedRuntimeUserInputEvent } from "../../src/agent-runtime/index.ts";
import { CodexJsonlPeer } from "../../src/agent-runtime/codex/protocol.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";

// Wire shape from codex-cli 0.153.4 app-server generate-ts --experimental:
// ServerRequest, ToolRequestUserInput{Params,Question,Option,Response,Answer}.
function questionRequest(id: string | number = 98) {
  return {
    jsonrpc: "2.0", id, method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-fixed", turnId: "turn-fixed", itemId: "question-item",
      isBlocking: true, autoResolutionMs: null as number | null,
      questions: [
        { id: "scope", header: "Scope", question: "Which scope?", isOther: true, isSecret: false,
          options: [{ label: "Runtime", description: "Only the runtime" }, { label: "All", description: "Include UI" }] },
        { id: "details", header: "Details", question: "What else?", isOther: false, isSecret: true, options: null },
      ],
    },
  };
}

test("known id-bearing Codex user question reaches the runtime instead of unexpected-server-request", async () => {
  const request = questionRequest();
  const transport = new ScriptedTransport([JSON.stringify(request)]);
  const peer = new CodexJsonlPeer(transport);
  try {
    assert.deepEqual(await peer.nextNotification(), request);
  } finally { await peer.stop(); }
});

test("unknown id-bearing server request remains independently rejected with a diagnostic", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  const transport = new ScriptedTransport([JSON.stringify({
    ...questionRequest(), method: "unknown/serverRequest",
  })]);
  const peer = new CodexJsonlPeer(transport);
  try {
    await assert.rejects(peer.nextNotification(), (error: unknown) =>
      error instanceof RuntimeAdapterError && error.category === "unexpected-server-request");
    assert.deepEqual(transport.recordedOutboundJsonl(), []);
    assert.deepEqual(diagnostics, [
      "[codex-cli] Codex CLI sent an unrecognized server request; it was rejected because the Runtime cannot answer an unknown blocking request.\n",
    ]);
  } finally { await peer.stop(); }
});

/** In-memory app-server: no executable, credentials, network or provider calls. */
class QuestionServer implements OfficialRuntimeTransport {
  readonly outbound: Record<string, any>[] = [];
  stopped = false;
  failResponses = false;
  private readonly lines: string[];
  private waiting: ((line: string | null) => void) | undefined;

  constructor(frames: Record<string, any>[]) { this.lines = frames.map((frame) => JSON.stringify(frame)); }
  push(frame: Record<string, any>): void {
    const line = JSON.stringify(frame);
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting(line); }
    else this.lines.push(line);
  }
  async send(line: string): Promise<void> {
    const message = JSON.parse(line);
    if (this.failResponses && "result" in message) throw new Error("synthetic broken pipe");
    this.outbound.push(message);
    if (message.method === "turn/interrupt") this.push({ id: message.id, result: {} });
  }
  async receive(): Promise<string | null> {
    if (this.lines.length) return this.lines.shift()!;
    if (this.stopped) return null;
    return new Promise((resolve) => { this.waiting = resolve; });
  }
  async stop(): Promise<void> { this.stopped = true; this.waiting?.(null); this.waiting = undefined; }
}

async function startQuestionSession(buffered: Record<string, any>[] = []) {
  const fixture = (await readFile(new URL("./fixtures/single-turn-success.jsonl", import.meta.url), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const transport = new QuestionServer(buffered.length === 0 ? fixture.slice(0, 7) :
    [...fixture.slice(0, 5), ...buffered, fixture[5]]);
  const nativeProfile = { model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access" };
  const profile = { ...nativeProfile, model: "directory-model" };
  // Exercise the production directory wrapper, not just the direct Codex adapter.
  const adapter = createRuntimeEndpointDirectory([{
    registrationId: "question-registration", endpointId: "question-endpoint", runtimeFamily: "codex",
    executionLocation: "local", adapter: new CodexAdapter(async () => transport),
    capabilitySnapshot: {
      snapshotId: "question-snapshot", freshness: "fresh", availability: "online",
      contracts: { supervisorWorkOrders: true, workerSessions: true, normalizedEvents: true },
      profiles: [{ profileId: "question-profile", modelLabel: "Codex", workIntensityLabel: "Ultra",
        runtimeProfile: profile, nativeRuntimeProfile: nativeProfile }],
    },
    policy: { maximumBudgetUnits: 0, availableConcurrency: 1, allowedAccessModes: ["full-access"], allowedWorkerEndpointIds: [] },
  }]).runtimeAdapter();
  const binding = await adapter.start({ projectDirectory: "C:\\synthetic-project", profile });
  await binding.send({ text: "Ask a question" });
  const finish = () => { for (const frame of fixture.slice(7)) transport.push(frame); };
  return { transport, binding, finish };
}

async function collect(events: AsyncIterable<NormalizedRuntimeEvent>) {
  const result: NormalizedRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test("production directory runtime reports answered only after the correlated app-server receipt", async (t) => {
  const { transport, binding, finish } = await startQuestionSession();
  t.after(() => transport.stop());
  assert.ok(binding.userInput, "Codex binding must expose the runtime user-input channel");
  const interactions: NormalizedRuntimeUserInputEvent[] = [];
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  binding.userInput.subscribe((event) => {
    interactions.push(event);
    if (event.kind === "user-input-requested") markRequested();
  });
  const events = collect(binding.events());
  transport.push(questionRequest("question-98"));
  await requested;
  assert.equal(binding.userInput.pending().length, 1);
  const pending = binding.userInput.pending()[0];
  assert.equal(pending.id, "question-98");
  assert.deepEqual(pending.questions, [
    { id: "scope", header: "Scope", text: "Which scope?", kind: "choice", allowFreeText: true, isSecret: false,
      options: [{ label: "Runtime", description: "Only the runtime" }, { label: "All", description: "Include UI" }] },
    { id: "details", header: "Details", text: "What else?", kind: "free-text", allowFreeText: true, isSecret: true, options: [] },
  ]);
  let answerSettled = false;
  const answerCall = binding.userInput.answer({ requestId: "question-98", answers: [
    { questionId: "scope", values: ["Runtime"] }, { questionId: "details", values: ["Only loopback tests"] },
  ] }).then(() => { answerSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.outbound.at(-1), { jsonrpc: "2.0", id: "question-98", result: {
    answers: { scope: { answers: ["Runtime"] }, details: { answers: ["Only loopback tests"] } },
  } });
  assert.deepEqual(binding.userInput.pending(), []);
  assert.equal(answerSettled, false);
  assert.deepEqual(interactions.map((event) => event.kind), ["user-input-requested"]);
  const answered = nextInteraction(binding, "user-input-resolved");
  transport.push({ method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: "question-98" } });
  assert.deepEqual(await answered, { kind: "user-input-resolved", requestId: "question-98", resolution: "answered" });
  await answerCall;
  finish();
  assert.deepEqual((await events).at(-1), { kind: "turn-completed", status: "completed" });
  assert.equal(transport.stopped, true);
});

test("an answer write without an app-server receipt ends unconfirmed", async (t) => {
  const { transport, binding, input, events, finish } = await pendingQuestion(t);
  const resolutions: NormalizedRuntimeUserInputEvent[] = [];
  input.subscribe((event) => resolutions.push(event));
  const answerRejected = assert.rejects(input.answer({ requestId: 98, answers: [
    { questionId: "scope", values: ["Runtime"] }, { questionId: "details", values: ["Only loopback tests"] },
  ] }), { category: "runtime-shutdown" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.outbound.at(-1), { jsonrpc: "2.0", id: 98, result: {
    answers: { scope: { answers: ["Runtime"] }, details: { answers: ["Only loopback tests"] } },
  } });
  assert.deepEqual(resolutions, []);
  finish();
  await events;
  await answerRejected;
  assert.deepEqual(resolutions, [
    { kind: "user-input-resolved", requestId: 98, resolution: "session-ended" },
  ]);
});

function nextInteraction(binding: Awaited<ReturnType<typeof startQuestionSession>>["binding"], kind: NormalizedRuntimeUserInputEvent["kind"]) {
  assert.ok(binding.userInput);
  return new Promise<NormalizedRuntimeUserInputEvent>((resolve) => {
    const unsubscribe = binding.userInput!.subscribe((event) => {
      if (event.kind === kind) { unsubscribe(); resolve(event); }
    });
  });
}

async function pendingQuestion(t: { after(fn: () => Promise<void>): void }, request = questionRequest()) {
  const session = await startQuestionSession();
  t.after(() => session.transport.stop());
  const requested = nextInteraction(session.binding, "user-input-requested");
  const events = collect(session.binding.events());
  session.transport.push(request);
  await requested;
  return { ...session, events, input: session.binding.userInput! };
}

test("unanswered request stays pending; cancel sends no selection and clears it", { timeout: 5000 }, async (t) => {
  const { transport, input, events, finish } = await pendingQuestion(t);
  assert.equal(input.pending().length, 1);
  assert.equal(transport.outbound.some((frame) => "result" in frame), false);
  const cancelled: NormalizedRuntimeUserInputEvent[] = [];
  input.subscribe((event) => cancelled.push(event));
  await input.cancel(98);
  assert.deepEqual(transport.outbound.at(-1), { jsonrpc: "2.0", id: 98, result: { answers: {} } });
  assert.deepEqual(input.pending(), []);
  assert.equal(cancelled.at(-1)?.kind, "user-input-resolved");
  await assert.rejects(input.cancel(98), { category: "invalid-input" });
  finish();
  assert.equal((await events).at(-1)?.kind, "turn-completed");
});

test("unanswered request expires even while the event reader is blocked on the server", { timeout: 5000 }, async (t) => {
  const request = questionRequest();
  request.params.autoResolutionMs = 20;
  const { transport, binding, input, events, finish } = await pendingQuestion(t, request);
  const expired = await nextInteraction(binding, "user-input-resolved");
  assert.deepEqual(expired, { kind: "user-input-resolved", requestId: 98, resolution: "timed-out" });
  assert.deepEqual(input.pending(), []);
  assert.deepEqual(transport.outbound.at(-1), { jsonrpc: "2.0", id: 98, result: { answers: {} } });
  finish();
  assert.equal((await events).at(-1)?.kind, "turn-completed");
});

test("without a provider deadline, no UI still cancels after the five minute runtime limit", async (t) => {
  const { binding, transport, finish } = await startQuestionSession();
  t.after(() => transport.stop());
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const requested = nextInteraction(binding, "user-input-requested");
  const events = collect(binding.events());
  transport.push(questionRequest());
  await requested;
  assert.equal(binding.userInput!.pending()[0].expiresAt, 301000);
  const expired = nextInteraction(binding, "user-input-resolved");
  t.mock.timers.tick(300000);
  assert.deepEqual(await expired, { kind: "user-input-resolved", requestId: 98, resolution: "timed-out" });
  finish();
  await events;
});

test("server cleanup clears only a correlated known request, without manufacturing an answer", async (t) => {
  const { transport, binding, input, events, finish } = await pendingQuestion(t);
  const resolved = nextInteraction(binding, "user-input-resolved");
  transport.push({ method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: 98 } });
  assert.deepEqual(await resolved, { kind: "user-input-resolved", requestId: 98, resolution: "runtime-resolved" });
  assert.deepEqual(input.pending(), []);
  assert.equal(transport.outbound.some((frame) => "result" in frame), false);
  await assert.rejects(input.cancel(98), { category: "invalid-input" });
  finish();
  await events;
});

test("turn completion, failure and iterator abandonment discard pending questions and timers", async (t) => {
  for (const end of ["complete", "disconnect", "abandon"] as const) await t.test(end, async (t) => {
    const { transport, binding, finish } = await startQuestionSession();
    t.after(() => transport.stop());
    const interactions: NormalizedRuntimeUserInputEvent[] = [];
    binding.userInput!.subscribe((event) => interactions.push(event));
    // An agent-message event after the question gives the caller an abandonment point.
    transport.push(questionRequest());
    transport.push({ method: "item/started", params: { threadId: "thread-fixed", turnId: "turn-fixed",
      item: { id: "commentary", type: "agentMessage" } } });
    const iterator = binding.events()[Symbol.asyncIterator]();
    await iterator.next(); // session
    await iterator.next(); // turn
    await iterator.next(); // item (question is on its separate channel)
    assert.equal(binding.userInput!.pending().length, 1);
    if (end === "abandon") await iterator.return!();
    else {
      if (end === "complete") finish();
      else await transport.stop();
      while (!(await iterator.next()).done) { /* drain through terminal */ }
    }
    assert.deepEqual(binding.userInput!.pending(), []);
    assert.deepEqual(interactions.at(-1), { kind: "user-input-resolved", requestId: 98, resolution: "session-ended" });
    await assert.rejects(binding.userInput!.cancel(98), { category: "invalid-input" });
    assert.equal(transport.outbound.some((frame) => "result" in frame), false);
  });
});

test("answers cannot cross bindings, unknown ids, repeated ids or malformed question/option selections", async (t) => {
  const request = questionRequest();
  request.params.questions[0].isOther = false;
  const { transport, input, finish, events } = await pendingQuestion(t, request);
  const other = await startQuestionSession();
  t.after(() => other.transport.stop());
  const answer = { requestId: 98, answers: [{ questionId: "scope", values: ["Runtime"] }, { questionId: "details", values: ["text"] }] };
  await assert.rejects(other.binding.userInput!.answer(answer), { category: "invalid-input" });
  for (const invalid of [
    { ...answer, requestId: "98" },
    { ...answer, answers: [] },
    { ...answer, extra: true },
    { ...answer, answers: [answer.answers[0], answer.answers[0]] },
    { ...answer, answers: [{ questionId: "unknown", values: ["text"] }, answer.answers[0]] },
    { ...answer, answers: [{ questionId: "scope", values: ["not a choice"] }, answer.answers[1]] },
    { ...answer, answers: [{ questionId: "scope", values: ["Runtime"], extra: true }, answer.answers[1]] },
  ]) await assert.rejects(input.answer(invalid), { category: "invalid-input" });
  assert.equal(input.pending().length, 1);
  assert.equal(transport.outbound.some((frame) => "result" in frame), false);
  const answered = input.answer(answer);
  transport.push({ method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: 98 } });
  await answered;
  await assert.rejects(input.answer(answer), { category: "invalid-input" });
  assert.equal(transport.outbound.filter((frame) => "result" in frame).length, 1);
  finish();
  await events;
});

test("an answer write failure ends the peer and clears pending input, never reports answered", async (t) => {
  const { transport, binding, input, events } = await pendingQuestion(t);
  const ended = nextInteraction(binding, "user-input-resolved");
  transport.failResponses = true;
  await assert.rejects(input.cancel(98), { category: "transport-failed" });
  assert.deepEqual(await ended, { kind: "user-input-resolved", requestId: 98, resolution: "session-ended" });
  assert.deepEqual(input.pending(), []);
  assert.equal((await events).at(-1)?.kind, "failed");
});

test("known request buffered before turn/start acknowledgement is delivered after lifecycle correlation", async (t) => {
  const { binding, transport, finish } = await startQuestionSession([
    { method: "turn/started", params: { threadId: "thread-fixed", turn: { id: "turn-fixed", status: "inProgress" } } },
    questionRequest(),
    { method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: 98 } },
  ]);
  t.after(() => transport.stop());
  const interactions: NormalizedRuntimeUserInputEvent[] = [];
  binding.userInput!.subscribe((event) => interactions.push(event));
  finish();
  const events = await collect(binding.events());
  assert.deepEqual(interactions.map((event) => event.kind), ["user-input-requested", "user-input-resolved"]);
  assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
  assert.deepEqual(binding.userInput!.pending(), []);
});

test("pending questions remain interruptible and an interrupted turn leaves no answer channel state", async (t) => {
  const { transport, binding, events, input } = await pendingQuestion(t);
  assert.equal(binding.interruptAvailability!(), "available");
  await binding.interrupt!();
  transport.push({ method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: 98 } });
  transport.push({ method: "turn/completed", params: { threadId: "thread-fixed", turn: { id: "turn-fixed", status: "interrupted" } } });
  assert.deepEqual((await events).at(-1), { kind: "turn-interrupted", status: "interrupted" });
  assert.deepEqual(input.pending(), []);
  assert.equal(transport.outbound.some((frame) => "result" in frame), false);
});

test("concurrent request ids and same ids on different sessions never share answers", async (t) => {
  const first = await pendingQuestion(t);
  const second = await pendingQuestion(t);
  const another = nextInteraction(first.binding, "user-input-requested");
  const request = questionRequest("98");
  // Non-blocking is a runtime fact, not permission to pick a default answer.
  request.params.isBlocking = false;
  first.transport.push(request);
  await another;
  assert.equal(first.input.pending().length, 2);
  assert.equal(first.input.pending()[1].isBlocking, false);
  const firstAnswered = first.input.answer({ requestId: "98", answers: [
    { questionId: "scope", values: ["Custom scope via Other"] }, { questionId: "details", values: ["Free text"] },
  ] });
  first.transport.push({ method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: "98" } });
  await firstAnswered;
  assert.equal(first.input.pending()[0].id, 98);
  assert.equal(second.input.pending()[0].id, 98);
  assert.equal(second.transport.outbound.some((frame) => "result" in frame), false);
  await second.input.cancel(98);
  await first.input.cancel(98);
  first.finish(); second.finish();
  assert.equal((await first.events).at(-1)?.kind, "turn-completed");
  assert.equal((await second.events).at(-1)?.kind, "turn-completed");
});

test("unknown resolutions, wrong-thread resolutions and duplicate request ids still fail closed", async (t) => {
  for (const [message, category] of [
    [{ method: "serverRequest/resolved", params: { threadId: "thread-fixed", requestId: 100 } }, "unexpected-server-request"],
    [{ method: "serverRequest/resolved", params: { threadId: "other", requestId: 98 } }, "correlation-invalid"],
    [questionRequest(), "correlation-invalid"],
  ] as const) await t.test(category, async (t) => {
    const { transport, input, events } = await pendingQuestion(t);
    transport.push(message);
    assert.deepEqual((await events).at(-1), { kind: "failed", category });
    assert.deepEqual(input.pending(), []);
  });
});

test("vendor extras are not forwarded and cannot mutate pending choices through listeners", async (t) => {
  const request: Record<string, any> = questionRequest();
  request.params.extra = { credentials: "do-not-forward" };
  request.params.questions[0].extra = "do-not-forward";
  request.params.questions[0].options[0].extra = "do-not-forward";
  const { input, transport, finish, events } = await pendingQuestion(t, request as ReturnType<typeof questionRequest>);
  assert.doesNotMatch(JSON.stringify(input.pending()), /extra|do-not-forward/);
  assert.throws(() => { (input.pending()[0].questions[0].options[0] as any).label = "mutated"; }, TypeError);
  await input.cancel(98);
  finish();
  await events;
  assert.doesNotMatch(JSON.stringify(transport.outbound), /extra|do-not-forward/);
});

test("unknown request, malformed known request, approval and unrelated correlation retain distinct fatal guards", async (t) => {
  const rows: [string, (request: Record<string, any>) => void, string][] = [
    ["unknown method", (r) => { r.method = "unknown/serverRequest"; }, "unexpected-server-request"],
    ["permission is not a question", (r) => { r.method = "item/commandExecution/requestApproval"; }, "approval-required"],
    ["request id missing", (r) => { delete r.id; }, "protocol-invalid"],
    ["null request id", (r) => { r.id = null; }, "protocol-invalid"],
    ["request also has result", (r) => { r.result = {}; }, "protocol-invalid"],
    ["missing item id", (r) => { delete r.params.itemId; }, "protocol-invalid"],
    ["missing options", (r) => { delete r.params.questions[0].options; }, "protocol-invalid"],
    ["malformed option", (r) => { r.params.questions[0].options[0].label = 1; }, "protocol-invalid"],
    ["malformed secret", (r) => { r.params.questions[0].isSecret = "yes"; }, "protocol-invalid"],
    ["duplicate question id", (r) => { r.params.questions[1].id = "scope"; }, "protocol-invalid"],
    ["malformed blocking", (r) => { r.params.isBlocking = "true"; }, "protocol-invalid"],
    ["malformed timeout", (r) => { r.params.autoResolutionMs = -1; }, "protocol-invalid"],
    ["wrong thread", (r) => { r.params.threadId = "other"; }, "correlation-invalid"],
    ["wrong turn", (r) => { r.params.turnId = "other"; }, "correlation-invalid"],
  ];
  for (const [name, mutate, category] of rows) await t.test(name, async (t) => {
    const { binding, transport } = await startQuestionSession();
    t.after(() => transport.stop());
    const request = questionRequest();
    mutate(request);
    transport.push(request);
    assert.deepEqual((await collect(binding.events())).at(-1), { kind: "failed", category });
    assert.deepEqual(binding.userInput!.pending(), []);
    assert.equal(transport.outbound.some((frame) => "result" in frame), false);
  });
});
