import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL,
  WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
  publicCodexApiBaseUrlUnavailable,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchCodexApiBaseUrlIpc,
  type CodexApiBaseUrlBrowserWindowBoundary,
  type CodexApiBaseUrlIpcMainBoundary,
  type CodexApiBaseUrlRendererSender,
  type WorkbenchCodexApiBaseUrlSource,
} from "../../src/workbench-shell/electron/codex-api-base-url-ipc.ts";

type Listener = (...values: unknown[]) => unknown;

class FakeIpcMain implements CodexApiBaseUrlIpcMainBoundary {
  readonly handlers = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  async invoke(
    channel: string,
    sender: FakeSender,
    ...values: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("missing-test-handler");
    return handler({ sender }, ...values);
  }
}

class FakeSender implements CodexApiBaseUrlRendererSender {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeWindow implements CodexApiBaseUrlBrowserWindowBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly webContents: FakeSender;
  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }
  on(event: "closed", listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  removeListener(event: "closed", listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
}

class FakeSource implements WorkbenchCodexApiBaseUrlSource {
  readCalls = 0;
  saveCalls = 0;
  saved: string[] = [];
  value = "";
  fail = false;
  async readCodexApiBaseUrl(): Promise<string> {
    this.readCalls += 1;
    if (this.fail) throw new Error("PRIVATE_READ_FAILURE");
    return this.value;
  }
  async saveCodexApiBaseUrl(baseUrl: string): Promise<string> {
    this.saveCalls += 1;
    this.saved.push(baseUrl);
    if (this.fail) throw new Error("PRIVATE_SAVE_FAILURE");
    this.value = baseUrl;
    return baseUrl;
  }
}

test("the owning renderer loads and saves a valid http(s) base URL", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchCodexApiBaseUrlIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL, sender),
    { ok: true, status: "loaded", baseUrl: "" },
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
      sender,
      "https://gateway.example.com/v1",
    ),
    { ok: true, status: "saved", baseUrl: "https://gateway.example.com/v1" },
  );
  assert.deepEqual(source.saved, ["https://gateway.example.com/v1"]);
  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("an empty draft clears the override without being refused", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  source.value = "https://old.example.com/v1";
  installWorkbenchCodexApiBaseUrlIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL, sender, "   "),
    { ok: true, status: "saved", baseUrl: "" },
  );
  assert.deepEqual(source.saved, [""]);
});

test("a non-http(s) draft is rejected with a reason and never reaches the store", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  installWorkbenchCodexApiBaseUrlIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  for (const draft of [
    "not-a-url",
    "ftp://example.com",
    "http://example.com",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(
      await ipc.invoke(WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL, sender, draft),
      {
        ok: false,
        error: {
          category: "codex-api-base-url-rejected",
          message: "That base URL cannot be used.",
          reason: "invalid-url",
        },
      },
    );
  }
  assert.equal(source.saveCalls, 0);
});

test("http loopback is accepted (the ticket's own smoke-test shape)", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  installWorkbenchCodexApiBaseUrlIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
      sender,
      "http://127.0.0.1:4180",
    ),
    { ok: true, status: "saved", baseUrl: "http://127.0.0.1:4180" },
  );
});

test("codex-api-base-url IPC rejects foreign, malformed, drifted, and terminal requests before persistence", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchCodexApiBaseUrlIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source,
  });
  const unavailable = publicCodexApiBaseUrlUnavailable();

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL, intruder),
    unavailable,
  );
  for (const value of [null, 42, {}, ["https://example.com"]]) {
    assert.deepEqual(
      await ipc.invoke(WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL, owner, value),
      unavailable,
    );
  }
  source.fail = true;
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_CODEX_API_BASE_URL_CHANNEL, owner),
    unavailable,
  );
  owner.emit("destroyed");
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_CODEX_API_BASE_URL_CHANNEL,
      owner,
      "https://example.com/v1",
    ),
    unavailable,
  );
  assert.equal(source.saveCalls, 0);
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
  binding.dispose();
});
