import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_READ_USER_INPUT_CHANNEL, WORKBENCH_RESPOND_USER_INPUT_CHANNEL } from "../../src/workbench-shell/contract.ts";
import { reconstructUserInputResponse, sanitizeUserInputResult, sanitizeUserInputResponseResult } from "../../src/workbench-shell/user-input-sanitizer.ts";
import { createQuestionWorkbench, waitFor } from "./fixtures/user-input-loopback.ts";
import { questionIpc } from "./fixtures/user-input-ipc.ts";

test("IPC questions use the selected Session and original binding, reject stale keys, and never persist answers", async (t) => {
  const workbench = await createQuestionWorkbench(t);
  const ipc = questionIpc(workbench.host);
  t.after(ipc.dispose);
  let notifications = 0;
  const unsubscribe = ipc.bridge.observeUserInput!(() => { notifications++; });
  t.after(unsubscribe);
  workbench.ask();
  await waitFor(() => notifications > 0);
  const sessionKey = workbench.view().commands[0].session!.metadataKey;
  const pending = await ipc.bridge.readUserInput!({ sessionKey });
  assert.ok(pending.ok && pending.requests[0].state === "pending");
  const requestKey = pending.requests[0].requestKey;
  assert.equal(pending.requests[0].questions[1].isSecret, true);
  assert.deepEqual(await ipc.bridge.readUserInput!({ sessionKey: "stale-session" }), { ok: false });
  assert.deepEqual(await ipc.invoke(WORKBENCH_READ_USER_INPUT_CHANNEL, {}, { sessionKey }), { ok: false });
  assert.deepEqual(await ipc.invoke(WORKBENCH_RESPOND_USER_INPUT_CHANNEL, {}, { kind: "cancel", requestKey }), { status: "unavailable" });
  assert.deepEqual(await ipc.bridge.respondToUserInput!({ kind: "answer", requestKey, answers: [{ questionId: "wrong", values: ["Runtime"] }] }), { status: "invalid-answer" });
  assert.equal(workbench.servers[0].outbound.some(frame => "result" in frame), false);
  assert.deepEqual(await ipc.bridge.respondToUserInput!({ kind: "answer", requestKey, answers: [
    { questionId: "scope", values: ["A handwritten scope"] }, { questionId: "details", values: ["SECRET_ANSWER_NOT_HISTORY"] },
  ] }), { status: "answered" });
  assert.deepEqual(workbench.servers[0].outbound.at(-1), { jsonrpc: "2.0", id: "question-98", result: { answers: {
    scope: { answers: ["A handwritten scope"] }, details: { answers: ["SECRET_ANSWER_NOT_HISTORY"] },
  } } });
  const answered = await ipc.bridge.readUserInput!({ sessionKey });
  assert.deepEqual(answered, { ok: true, requests: [{ requestKey, state: "answered" }] });
  assert.deepEqual(await ipc.bridge.respondToUserInput!({ kind: "cancel", requestKey }), { status: "unavailable" });
  workbench.finish();
  await waitFor(() => workbench.view().commands[0].status === "completed");
  assert.doesNotMatch(JSON.stringify(workbench.view()), /SECRET_ANSWER_NOT_HISTORY|A handwritten scope|Which scope\?/);
  ipc.dispose();
  assert.equal(ipc.handlers.has(WORKBENCH_READ_USER_INPUT_CHANNEL), false);
  assert.equal(ipc.handlers.has(WORKBENCH_RESPOND_USER_INPUT_CHANNEL), false);
});

test("the Q&A public shape remains exact and cannot become permission approval", () => {
  for (const value of [
    { kind: "approval", requestKey: "q", approved: true },
    { kind: "cancel", requestKey: "q", answers: [] },
    { kind: "answer", requestKey: "q", answers: [] },
    { kind: "answer", requestKey: "q", answers: [{ questionId: "scope", values: [""] }] },
  ]) assert.equal(reconstructUserInputResponse(value), undefined);
  assert.deepEqual(sanitizeUserInputResponseResult({ status: "answered", completed: true }), { status: "unavailable" });
  assert.deepEqual(sanitizeUserInputResult({ ok: true, requests: [{ requestKey: "q", state: "answered", answers: ["secret"] }] }), { ok: false });
  const pending = { requestKey: "q", state: "pending", expiresAt: 300000, isBlocking: true,
    questions: [{ id: "s", text: "Which scope?", header: "Scope", kind: "choice", allowFreeText: false, isSecret: false,
      options: [{ label: "Runtime", description: "Only the runtime" }] }] };
  assert.deepEqual(sanitizeUserInputResult({ ok: true, requests: [pending] }), { ok: true, requests: [pending] });
  assert.deepEqual(sanitizeUserInputResult({ ok: true, requests: [{ ...pending, privateThread: "x" }] }), { ok: false });
});

test("a stalled response reports uncertainty after eight seconds and does not hold Project close", { timeout: 10000 }, async (t) => {
  const workbench = await createQuestionWorkbench(t);
  const ipc = questionIpc(workbench.host);
  t.after(ipc.dispose);
  let changed = false;
  const unsubscribe = ipc.bridge.observeUserInput!(() => { changed = true; });
  t.after(unsubscribe);
  workbench.ask();
  await waitFor(() => changed);
  const pending = await ipc.bridge.readUserInput!({ sessionKey: workbench.view().commands[0].session!.metadataKey });
  assert.ok(pending.ok && pending.requests[0].state === "pending");
  workbench.servers[0].holdResponses = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const response = ipc.bridge.respondToUserInput!({ kind: "cancel", requestKey: pending.requests[0].requestKey });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(workbench.servers[0].responseWaiting, true);
    t.mock.timers.tick(8000);
    assert.deepEqual(await response, { status: "unavailable" });
  } finally { t.mock.timers.reset(); }
  assert.equal(workbench.servers[0].outbound.some(frame => "result" in frame), false);
  t.diagnostic("The eight-second response returned unavailable; now checking Project close.");
  const started = performance.now();
  const watchdog = setTimeout(() => {
    t.diagnostic(`host.close still pending after 2000ms; stopCalls=${workbench.servers[0].stopCalls}`);
  }, 2000);
  t.after(() => clearTimeout(watchdog));
  await workbench.host.close();
  clearTimeout(watchdog);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `host.close took ${elapsed}ms`);
  assert.equal(workbench.servers[0].stopCalls, 1);
  assert.equal(workbench.servers[0].stopSawPendingReceive, true);
  await workbench.host.close();
  assert.equal(workbench.servers[0].stopCalls, 1);
  t.diagnostic(`host.close returned in ${elapsed.toFixed(1)}ms; stopCalls=${workbench.servers[0].stopCalls}`);
  assert.deepEqual(await ipc.bridge.readUserInput!({ sessionKey: workbench.view().commands[0].session!.metadataKey }), { ok: false });
});
