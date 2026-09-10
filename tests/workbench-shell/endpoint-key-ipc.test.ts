import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_ENDPOINT_KEY_CHANNELS,
  publicEndpointKeyInvalidValue,
  publicEndpointKeyUnavailable,
  type WorkbenchEndpointKeyEndpointId,
} from "../../src/workbench-shell/contract.ts";
import type { WorkbenchEndpointKeySource } from "../../src/workbench-shell/endpoint-key-source.ts";
import {
  installWorkbenchEndpointKeyIpc,
  type EndpointKeyIpcMainBoundary,
} from "../../src/workbench-shell/electron/endpoint-key-ipc.ts";

/**
 * IPC-surface behaviour for the parameterized endpoint-key channels (WO16
 * Part 1; the former GLM-only module's tests, updated in the same batch).
 * One installer serves GLM, Kimi and DeepSeek; each endpoint's channels are
 * registered under its own endpoint-scoped names and route to its own source.
 */

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain implements EndpointKeyIpcMainBoundary {
  readonly handlers = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
}

class FakeSender {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(): void {}
  removeListener(): void {}
}

class FakeWindow {
  readonly webContents = new FakeSender();
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  removeListener(event: string, listener: Listener): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
    );
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

interface RecordingSource extends WorkbenchEndpointKeySource {
  readonly calls: {
    status: number;
    save: { keyValue: string }[];
    remove: number;
    reveal: number;
    probe: number;
  };
}

function createRecordingSource(): RecordingSource {
  const calls = {
    status: 0,
    save: [] as { keyValue: string }[],
    remove: 0,
    reveal: 0,
    probe: 0,
  };
  return {
    calls,
    status() {
      calls.status += 1;
      return {
        configured: calls.save.length > 0 && calls.remove === 0,
        maskedHint: calls.save.length > 0 && calls.remove === 0 ? "••••4321" : null,
        isPersistent: true,
        environmentFallback: false,
      };
    },
    save(keyValue: string) {
      calls.save.push({ keyValue });
      return {
        configured: true,
        maskedHint: "••••4321",
        isPersistent: true,
        environmentFallback: false,
      };
    },
    remove() {
      calls.remove += 1;
      return calls.save.length > 0;
    },
    reveal() {
      calls.reveal += 1;
      return calls.save.length > 0 && calls.remove === 0
        ? "test-secret-777"
        : undefined;
    },
    resolve() {
      return undefined;
    },
    async probe() {
      calls.probe += 1;
      return { outcome: "success" } as const;
    },
  };
}

const unavailable = publicEndpointKeyUnavailable();
const GLM = WORKBENCH_ENDPOINT_KEY_CHANNELS["glm-coding-plan"];

function installAll(
  endpointId: WorkbenchEndpointKeyEndpointId = "glm-coding-plan",
) {
  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  const source = createRecordingSource();
  const binding = installWorkbenchEndpointKeyIpc({
    ipcMain: ipc,
    window,
    endpointId,
    source,
  });
  return { ipc, window, source, binding, endpointId };
}

test("each endpoint registers its own five endpoint-scoped channels", () => {
  for (const endpointId of [
    "glm-coding-plan",
    "kimi-code",
    "deepseek-api",
  ] as const) {
    const { ipc, binding } = installAll(endpointId);
    const channels = WORKBENCH_ENDPOINT_KEY_CHANNELS[endpointId];
    for (const channel of [
      channels.loadStatus,
      channels.save,
      channels.remove,
      channels.reveal,
      channels.probe,
    ]) {
      assert.ok(ipc.handlers.has(channel), channel);
      assert.match(channel, new RegExp(`^workbench:endpoint-key/${endpointId}/`));
    }
    // Endpoint-scoped: no channel collides with another endpoint's set.
    assert.equal(
      ipc.handlers.has(WORKBENCH_ENDPOINT_KEY_CHANNELS["kimi-code"].save),
      endpointId === "kimi-code",
    );
    binding.dispose();
  }
});

test("all five channels are reachable through the owning sender", async () => {
  const { ipc, window, source, binding } = installAll();
  const event = { sender: window.webContents };
  assert.deepEqual(await ipc.handlers.get(GLM.loadStatus)!(event), {
    ok: true,
    status: "loaded",
    snapshot: {
      configured: false,
      maskedHint: null,
      isPersistent: true,
      environmentFallback: false,
    },
  });
  assert.deepEqual(
    await ipc.handlers.get(GLM.save)!(
      event,
      { keyValue: "test-secret-777" },
    ),
    { ok: true, status: "saved", maskedHint: "••••4321", isPersistent: true },
  );
  assert.deepEqual(source.calls.save, [{ keyValue: "test-secret-777" }]);
  const revealed = await ipc.handlers.get(GLM.reveal)!(event);
  assert.deepEqual(revealed, {
    ok: true,
    status: "revealed",
    value: "test-secret-777",
    snapshot: {
      configured: true,
      maskedHint: "••••4321",
      isPersistent: true,
      environmentFallback: false,
    },
  });
  const removed = (await ipc.handlers.get(GLM.remove)!(event)) as {
    readonly ok: boolean;
    readonly status: string;
    readonly snapshot: { configured: boolean };
  };
  assert.equal(removed.ok, true);
  assert.equal(removed.status, "removed");
  assert.equal(removed.snapshot.configured, false);
  assert.deepEqual(
    await ipc.handlers.get(GLM.probe)!(event),
    { ok: true, status: "probed", probe: { outcome: "success" } },
  );
  binding.dispose();
});

test("save rejects an invalid value into the fixed invalid-value result without touching the source", async () => {
  const { ipc, window, source, binding } = installAll();
  const event = { sender: window.webContents };
  for (const invalid of [
    { keyValue: "" },
    { keyValue: " padded " },
    { keyValue: "a\nb" },
    { keyValue: "x".repeat(4097) },
    "test-secret-777",
    [],
    null,
    { keyValue: "test-secret-777", extra: true },
  ]) {
    assert.deepEqual(
      await ipc.handlers.get(GLM.save)!(event, invalid),
      publicEndpointKeyInvalidValue(),
    );
  }
  assert.equal(source.calls.save.length, 0);
  binding.dispose();
});

test("foreign senders, malformed payloads, and lifecycle death fail closed to the fixed result", async () => {
  const { ipc, window, source, binding } = installAll();
  const owner = window.webContents;
  const foreign = new FakeSender();

  for (const channel of [
    GLM.loadStatus,
    GLM.remove,
    GLM.reveal,
    GLM.probe,
  ]) {
    assert.deepEqual(await ipc.handlers.get(channel)!({ sender: foreign }), unavailable);
    assert.deepEqual(await ipc.handlers.get(channel)!({}), unavailable);
    assert.deepEqual(await ipc.handlers.get(channel)!(), unavailable);
    assert.deepEqual(
      await ipc.handlers.get(channel)!({ sender: owner }, "extra"),
      unavailable,
    );
  }

  const throwingGetter = Object.defineProperty({}, "sender", {
    enumerable: true,
    get(): never {
      throw new Error("PRIVATE_SENDER_GETTER");
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      has(): boolean {
        return true;
      },
      get(): never {
        throw new Error("PRIVATE_SENDER_GET_TRAP");
      },
    },
  );
  for (const event of [throwingGetter, throwingProxy]) {
    assert.deepEqual(
      await ipc.handlers.get(GLM.loadStatus)!(event),
      unavailable,
    );
  }

  assert.equal(source.calls.probe, 0);

  window.emit("closed");
  assert.deepEqual(
    await ipc.handlers.get(GLM.loadStatus)!({
      sender: owner,
    }),
    unavailable,
  );
  binding.dispose();
  binding.dispose();
});

test("source failures surface as the fixed unavailable result, never raw errors", async () => {
  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  const event = { sender: window.webContents };
  const failingSource: WorkbenchEndpointKeySource = {
    status(): never {
      throw new Error("SECRET_STORE_FAILURE_DETAIL");
    },
    save(): never {
      throw new Error("SECRET_STORE_FAILURE_DETAIL");
    },
    remove(): never {
      throw new Error("SECRET_STORE_FAILURE_DETAIL");
    },
    reveal(): never {
      throw new Error("SECRET_STORE_FAILURE_DETAIL");
    },
    resolve() {
      return undefined;
    },
    async probe(): Promise<never> {
      throw new Error("SECRET_STORE_FAILURE_DETAIL");
    },
  };
  const binding = installWorkbenchEndpointKeyIpc({
    ipcMain: ipc,
    window,
    endpointId: "glm-coding-plan",
    source: failingSource,
  });
  const serializedFailures = new Set<string>();
  for (const channel of [GLM.loadStatus, GLM.save, GLM.remove, GLM.reveal]) {
    const result = await ipc.handlers.get(channel)!(
      event,
      ...(channel === GLM.save ? [{ keyValue: "test-secret-777" }] : []),
    );
    serializedFailures.add(JSON.stringify(result));
  }
  assert.deepEqual([...serializedFailures].sort(), [
    JSON.stringify(publicEndpointKeyUnavailable()),
  ]);
  binding.dispose();
});

test("dispose removes every handler and stops further work", async () => {
  const { ipc, window, source, binding } = installAll();
  const loadHandler = ipc.handlers.get(GLM.loadStatus)!;
  binding.dispose();
  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
  assert.deepEqual(
    await loadHandler({ sender: window.webContents }),
    publicEndpointKeyUnavailable(),
  );
  assert.equal(source.calls.status, 0);
  void window;
});

test("two endpoints installed side by side never route into each other's source", async () => {
  const ipc = new FakeIpcMain();
  const window = new FakeWindow();
  const event = { sender: window.webContents };
  const glmSource = createRecordingSource();
  const kimiSource = createRecordingSource();
  const glmBinding = installWorkbenchEndpointKeyIpc({
    ipcMain: ipc,
    window,
    endpointId: "glm-coding-plan",
    source: glmSource,
  });
  const kimiBinding = installWorkbenchEndpointKeyIpc({
    ipcMain: ipc,
    window,
    endpointId: "kimi-code",
    source: kimiSource,
  });
  await ipc.handlers.get(GLM.save)!(event, { keyValue: "test-secret-glm" });
  await ipc.handlers.get(WORKBENCH_ENDPOINT_KEY_CHANNELS["kimi-code"].save)!(
    event,
    { keyValue: "test-secret-kimi" },
  );
  assert.deepEqual(glmSource.calls.save, [{ keyValue: "test-secret-glm" }]);
  assert.deepEqual(kimiSource.calls.save, [{ keyValue: "test-secret-kimi" }]);
  // Disposing one endpoint leaves the other fully operational.
  const glmLoadHandler = ipc.handlers.get(GLM.loadStatus)!;
  glmBinding.dispose();
  assert.deepEqual(
    await glmLoadHandler(event),
    publicEndpointKeyUnavailable(),
  );
  assert.deepEqual(
    await ipc.handlers.get(WORKBENCH_ENDPOINT_KEY_CHANNELS["kimi-code"].loadStatus)!(
      event,
    ),
    {
      ok: true,
      status: "loaded",
      snapshot: {
        configured: true,
        maskedHint: "••••4321",
        isPersistent: true,
        environmentFallback: false,
      },
    },
  );
  kimiBinding.dispose();
});
