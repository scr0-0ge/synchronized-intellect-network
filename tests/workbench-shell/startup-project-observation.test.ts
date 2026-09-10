import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkbenchHostedProjectListener,
  WorkbenchHostedProjectResult,
} from "../../src/workbench-shell/contract.ts";
import { observeProjectThroughStartup } from "../../src/workbench-shell/renderer/startup-project-observation.ts";

class ManualScheduler {
  readonly callbacks: Array<() => void> = [];
  readonly cleared: unknown[] = [];

  set(_delayMilliseconds: number, callback: () => void): unknown {
    const handle = Object.freeze({ index: this.callbacks.length });
    this.callbacks.push(callback);
    return handle;
  }

  clear(handle: unknown): void {
    this.cleared.push(handle);
  }

  runNext(): void {
    const callback = this.callbacks.shift();
    assert.ok(callback);
    callback();
  }
}

const readyResult: WorkbenchHostedProjectResult = Object.freeze({
  ok: true,
  empty: true,
});

test("startup observation retries a lost pre-IPC request and retains the first live subscription", () => {
  const scheduler = new ManualScheduler();
  const listeners: WorkbenchHostedProjectListener[] = [];
  const disposed: number[] = [];
  const results: WorkbenchHostedProjectResult[] = [];
  const bridge = {
    observeProject(listener: WorkbenchHostedProjectListener): () => void {
      const index = listeners.length;
      listeners.push(listener);
      return () => disposed.push(index);
    },
  };

  const dispose = observeProjectThroughStartup(
    bridge,
    (result) => results.push(result),
    { retryDelayMilliseconds: 25, scheduler },
  );

  assert.equal(listeners.length, 1);
  assert.equal(scheduler.callbacks.length, 1);
  scheduler.runNext();
  assert.deepEqual(disposed, [0]);
  assert.equal(listeners.length, 2);

  listeners[1]!(readyResult);
  assert.deepEqual(results, [readyResult]);
  assert.equal(scheduler.cleared.length, 1);
  listeners[1]!({
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(results.length, 2);
  assert.equal(results[1]?.ok, false);
  dispose();
  dispose();
  assert.deepEqual(disposed, [0, 1]);
});

test("startup observation does not schedule a retry after a synchronous Project view", () => {
  const scheduler = new ManualScheduler();
  let disposed = 0;
  const results: WorkbenchHostedProjectResult[] = [];
  const bridge = {
    observeProject(listener: WorkbenchHostedProjectListener): () => void {
      listener(readyResult);
      return () => {
        disposed += 1;
      };
    },
  };

  const dispose = observeProjectThroughStartup(
    bridge,
    (result) => results.push(result),
    { scheduler },
  );

  assert.deepEqual(results, [readyResult]);
  assert.deepEqual(scheduler.callbacks, []);
  dispose();
  assert.equal(disposed, 1);
});
