/*
 * Issue 172, the class rather than the instance.
 *
 * `main.ts` tore its window-scoped bindings down as a plain statement sequence,
 * in two hand-maintained copies. One `dispose()` throwing therefore abandoned
 * every later binding — silently in the drain, whose caller swallows the throw,
 * and as an uncaught main-process exception in the window's "closed" handler.
 * And `closeBackend` awaited two rejectable listener-teardown promises ahead of
 * the conversation flush, outside its own try, so a rejection there skipped the
 * flush entirely and the drain exited the process anyway.
 *
 * These are the two properties that stop both, asserted directly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  closeDurableStateAfterListenerShutdown,
  runWorkbenchTeardownSteps,
  type WorkbenchTeardownFailure,
} from "../../src/workbench-shell/electron/binding-teardown.ts";

test("a failing teardown step does not cancel the steps after it", () => {
  const ran: string[] = [];
  const failures: WorkbenchTeardownFailure[] = [];

  const reported = runWorkbenchTeardownSteps(
    [
      {
        name: "first",
        run() {
          ran.push("first");
        },
      },
      {
        name: "destroyed-window-dispose",
        run() {
          ran.push("second");
          throw new TypeError("Object has been destroyed");
        },
      },
      {
        name: "third",
        run() {
          ran.push("third");
        },
      },
    ],
    (failure) => failures.push(failure),
  );

  assert.deepEqual(ran, ["first", "second", "third"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.name, "destroyed-window-dispose");
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.name, "destroyed-window-dispose");
  assert.match(String(failures[0]?.error), /Object has been destroyed/u);
});

test("every failure is reported, and reporting names the step that produced it", () => {
  const failures: WorkbenchTeardownFailure[] = [];

  runWorkbenchTeardownSteps(
    [
      {
        name: "clipboardIpc",
        run() {
          throw new Error("clipboard-failed");
        },
      },
      {
        name: "notificationIpc",
        run() {
          throw new Error("notification-failed");
        },
      },
    ],
    (failure) => failures.push(failure),
  );

  // A teardown failure that vanishes is how a visible race becomes a silent
  // one, which is the outcome this cycle refused in advance.
  assert.deepEqual(
    failures.map((failure) => failure.name),
    ["clipboardIpc", "notificationIpc"],
  );
});

test("a reporter that throws does not take the rest of the teardown with it", () => {
  const ran: string[] = [];

  runWorkbenchTeardownSteps(
    [
      {
        name: "failing",
        run() {
          throw new Error("dispose-failed");
        },
      },
      {
        name: "after",
        run() {
          ran.push("after");
        },
      },
    ],
    () => {
      throw new Error("reporter-failed");
    },
  );

  assert.deepEqual(ran, ["after"]);
});

test("a rejecting listener shutdown does not skip the durable close", async () => {
  let closed = 0;
  const failures: WorkbenchTeardownFailure[] = [];

  await closeDurableStateAfterListenerShutdown({
    listenerShutdowns: [
      Promise.reject(new Error("subscription-auth-dispose-failed")),
      Promise.resolve(),
    ],
    report: (failure) => failures.push(failure),
    async closeDurableState() {
      closed += 1;
    },
  });

  // The product's promise is that conversations survive a restart. The flush is
  // the mandatory half and must not sit behind the best-effort half.
  assert.equal(closed, 1, "the durable close must still run");
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]?.error), /subscription-auth-dispose-failed/u);
});

test("every rejecting listener shutdown is reported, not just the first", async () => {
  const failures: WorkbenchTeardownFailure[] = [];

  await closeDurableStateAfterListenerShutdown({
    listenerShutdowns: [
      Promise.reject(new Error("first-failed")),
      Promise.reject(new Error("second-failed")),
    ],
    report: (failure) => failures.push(failure),
    async closeDurableState() {},
  });

  assert.equal(failures.length, 2);
  assert.match(String(failures[0]?.error), /first-failed/u);
  assert.match(String(failures[1]?.error), /second-failed/u);
});

test("the durable close runs after the listener shutdowns settle, not before", async () => {
  const order: string[] = [];
  let releaseListener!: () => void;
  const listenerShutdown = new Promise<void>((resolve) => {
    releaseListener = () => {
      order.push("listener-settled");
      resolve();
    };
  });

  const closing = closeDurableStateAfterListenerShutdown({
    listenerShutdowns: [listenerShutdown],
    report: () => {},
    async closeDurableState() {
      order.push("durable-closed");
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, [], "nothing runs while a listener shutdown is pending");

  releaseListener();
  await closing;

  assert.deepEqual(order, ["listener-settled", "durable-closed"]);
});

test("a failing durable close still reaches the caller", async () => {
  // The drain swallows this reason deliberately and exits anyway; what matters
  // is that it is not converted into success here.
  await assert.rejects(
    closeDurableStateAfterListenerShutdown({
      listenerShutdowns: [Promise.resolve()],
      report: () => {},
      async closeDurableState() {
        throw new Error("flush-failed");
      },
    }),
    /flush-failed/u,
  );
});
