import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { CodexRuntimeBinding } from "../../src/agent-runtime/codex/binding.ts";
import { CodexJsonlPeer } from "../../src/agent-runtime/codex/protocol.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";
import type { NormalizedRuntimeUserInputEvent } from "../../src/agent-runtime/index.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** In-memory app-server whose receive and stop can each remain pending. */
class BlockedTransport implements OfficialRuntimeTransport {
  readonly receiving = deferred<void>();
  readonly stopping = deferred<void>();
  sendCompletion?: Promise<void>;
  stopCalls = 0;
  receiveReleased = false;
  readonly outbound: Record<string, unknown>[] = [];
  private readonly received = deferred<string | null>();
  private readonly lines = [
    { id: 1, result: { turn: { id: "turn", status: "inProgress" } } },
    { method: "thread/started", params: { thread: { id: "thread" } } },
    { method: "turn/started", params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } } },
  ].map((frame) => JSON.stringify(frame));

  queue(frame: unknown): void { this.lines.push(JSON.stringify(frame)); }
  async send(line: string): Promise<void> {
    this.outbound.push(JSON.parse(line));
    await this.sendCompletion;
  }
  async receive(): Promise<string | null> {
    if (this.lines.length > 0) return this.lines.shift()!;
    this.receiving.resolve();
    return this.received.promise;
  }
  releaseReceive(): void {
    this.receiveReleased = true;
    this.received.resolve(null);
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopping.promise;
    this.releaseReceive();
  }
}

function createBinding() {
  const transport = new BlockedTransport();
  const binding = new CodexRuntimeBinding(new CodexJsonlPeer(transport), "thread", {
    model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access",
  }, { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }, "new");
  return { transport, binding };
}

async function runningBinding(frames: unknown[] = []) {
  const { transport, binding } = createBinding();
  for (const frame of frames) transport.queue(frame);
  await binding.send({ text: "Synthetic input; no provider is launched" });
  const iterator = binding.events()[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { kind: "session-started" });
  assert.deepEqual((await iterator.next()).value, { kind: "turn-started" });
  const next = iterator.next();
  await transport.receiving.promise;
  return { transport, binding, iterator, next };
}

test("closing starts transport stop before releasing a blocked receive", { timeout: 5000 }, async (t) => {
  const { transport, binding, iterator, next } = await runningBinding();
  try {
    assert.equal(binding.close(), undefined, "close must not return a pending stop promise");
    t.diagnostic(`before releasing receive: stopCalls=${transport.stopCalls}, receiveReleased=${transport.receiveReleased}`);
    assert.equal(transport.receiveReleased, false);
    assert.equal(transport.stopCalls, 1);
  } finally {
    transport.stopping.resolve();
    transport.releaseReceive();
    await next;
    await iterator.return!();
    t.diagnostic(`after releasing receive: stopCalls=${transport.stopCalls}`);
  }
});

test("repeated close does not await stop or repeat it, and rejects pending guidance", { timeout: 5000 }, async () => {
  const { transport, binding, iterator, next } = await runningBinding();
  const guidance = assert.rejects(binding.steer({ text: "Synthetic guidance" }), { category: "runtime-shutdown" });
  let nextSettled = false;
  void next.then(() => { nextSettled = true; });
  try {
    assert.equal(binding.close(), undefined);
    assert.equal(binding.close(), undefined);
    assert.equal(transport.stopCalls, 1);
    assert.equal(binding.interruptAvailability(), "unavailable");
    assert.equal(binding.steerAvailability(), "unavailable");
    await guidance;
    await setImmediate();
    assert.equal(nextSettled, false, "the close calls returned while receive and stop were still pending");
    assert.equal(transport.receiveReleased, false);
    transport.stopping.resolve();
    assert.equal((await next).value?.kind, "failed", "closing cannot manufacture successful completion");
    await iterator.return!();
    binding.close();
    assert.equal(transport.stopCalls, 1, "iterator cleanup and close share the peer's one stop attempt");
  } finally {
    transport.stopping.resolve();
    transport.releaseReceive();
    await next;
    await iterator.return!();
  }
});

test("close clears pending user input without answering or waiting for receive", { timeout: 5000 }, async () => {
  const { transport, binding, iterator, next } = await runningBinding([{
    id: "question", method: "item/tool/requestUserInput", params: {
      threadId: "thread", turnId: "turn", itemId: "question-item",
      questions: [{ id: "scope", header: "Scope", question: "Which scope?", isOther: false,
        isSecret: false, options: [{ label: "Runtime", description: "Only runtime" }] }],
    },
  }]);
  const resolved: NormalizedRuntimeUserInputEvent[] = [];
  binding.userInput.subscribe((event) => resolved.push(event));
  try {
    assert.equal(binding.userInput.pending().length, 1);
    binding.close();
    assert.equal(transport.stopCalls, 1);
    assert.equal(transport.receiveReleased, false);
    assert.deepEqual(binding.userInput.pending(), []);
    assert.deepEqual(resolved, [{ kind: "user-input-resolved", requestId: "question", resolution: "session-ended" }]);
    await assert.rejects(binding.userInput.cancel("question"), { category: "invalid-input" });
    assert.equal(transport.outbound.some((frame) => "result" in frame), false);
  } finally {
    transport.stopping.resolve();
    transport.releaseReceive();
    await next;
    await iterator.return!();
  }
});

test("close handles rejected shutdown with a sanitized diagnostic, not an unhandled rejection", { timeout: 5000 }, async (t) => {
  const { transport, binding, iterator, next } = await runningBinding();
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => { diagnostics.push(String(chunk)); return true; });
  try {
    assert.equal(binding.close(), undefined);
    transport.stopping.reject(new Error("synthetic native shutdown detail"));
    await setImmediate();
    assert.equal(transport.stopCalls, 1);
    assert.equal(transport.receiveReleased, false);
    assert.deepEqual(diagnostics, ["[codex-cli] Codex CLI transport shutdown failed after close was requested; runtime exit was not confirmed.\n"]);
  } finally {
    transport.releaseReceive();
    await next;
    await iterator.return!();
  }
});

test("close starts shutdown even when events were never consumed", async () => {
  const { transport, binding } = createBinding();
  try {
    assert.equal(binding.close(), undefined);
    assert.equal(transport.stopCalls, 1);
    assert.equal(transport.receiveReleased, false);
  } finally {
    transport.stopping.resolve();
  }
});

test("close during a pending guidance write does not leak an unhandled rejection", { timeout: 5000 }, async () => {
  const { transport, binding, iterator, next } = await runningBinding();
  const write = deferred<void>();
  transport.sendCompletion = write.promise;
  const guidance = assert.rejects(binding.steer({ text: "Synthetic guidance" }), { category: "runtime-shutdown" });
  try {
    assert.equal(binding.close(), undefined);
    assert.equal(transport.stopCalls, 1);
    await setImmediate();
    assert.equal(transport.receiveReleased, false);
  } finally {
    write.resolve();
    transport.stopping.resolve();
    transport.releaseReceive();
    await guidance;
    await next;
    await iterator.return!();
  }
});
