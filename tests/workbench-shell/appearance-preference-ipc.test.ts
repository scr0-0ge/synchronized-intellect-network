import assert from "node:assert/strict";
import test from "node:test";

import type { WorkbenchAppearancePreference } from "../../src/workbench-shell/contract.ts";
import {
  WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
  WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchAppearancePreferenceIpc,
  type AppearancePreferenceBrowserWindowBoundary,
  type AppearancePreferenceIpcMainBoundary,
  type AppearancePreferenceRendererSender,
  type WorkbenchAppearancePreferenceSource,
} from "../../src/workbench-shell/electron/appearance-preference-ipc.ts";

type Listener = (...values: unknown[]) => unknown;

const appearance = Object.freeze({
  tone: "light" as const,
  crt: "full" as const,
  phosphor: "amber" as const,
  phosphorTier: "a" as const,
  language: "zh-CN" as const,
});
const unavailable = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "appearance-preference-unavailable" as const,
    message:
      "Appearance preferences could not be loaded or saved. Keep the current appearance and try again." as const,
  }),
});

class FakeIpcMain implements AppearancePreferenceIpcMainBoundary {
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

class FakeSender implements AppearancePreferenceRendererSender {
  destroyed = false;
  readonly listeners = new Map<string, Set<Listener>>();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
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

class FakeWindow implements AppearancePreferenceBrowserWindowBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly webContents: FakeSender;

  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }

  on(event: "closed", listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: "closed", listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "closed"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeSource implements WorkbenchAppearancePreferenceSource {
  readCalls = 0;
  saveCalls = 0;
  readValue: unknown = appearance;
  saveValue: unknown = appearance;
  readFailure: unknown;
  saveFailure: unknown;
  saved: WorkbenchAppearancePreference[] = [];

  async read(): Promise<WorkbenchAppearancePreference> {
    this.readCalls += 1;
    if (this.readFailure !== undefined) throw this.readFailure;
    return this.readValue as WorkbenchAppearancePreference;
  }

  async save(
    value: WorkbenchAppearancePreference,
  ): Promise<WorkbenchAppearancePreference> {
    this.saveCalls += 1;
    this.saved.push(value);
    if (this.saveFailure !== undefined) throw this.saveFailure;
    return this.saveValue as WorkbenchAppearancePreference;
  }
}

test("the owning renderer can load and save only the exact sanitized appearance preference", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchAppearancePreferenceIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  assert.deepEqual([...ipc.handlers.keys()].sort(), [
    WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
    WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
  ]);
  const loaded = await ipc.invoke(
    WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
    sender,
  );
  assert.deepEqual(loaded, { ok: true, status: "loaded", appearance });
  assert.notEqual(
    (loaded as { appearance: unknown }).appearance,
    source.readValue,
  );
  assert.equal("schemaVersion" in (loaded as object), false);

  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
      sender,
      appearance,
    ),
    {
      ok: true,
      status: "saved",
      message: "Appearance preference was durably saved.",
    },
  );
  assert.deepEqual(source.saved, [appearance]);
  assert.notEqual(source.saved[0], appearance);
  assert.equal(Object.isFrozen(source.saved[0]), true);
  assert.equal(source.readCalls, 1);
  assert.equal(source.saveCalls, 1);

  binding.dispose();
  assert.equal(ipc.handlers.size, 0);
});

test("appearance IPC fails closed before source work for foreign senders, extra arguments, and malformed requests", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchAppearancePreferenceIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source,
  });

  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, intruder),
    unavailable,
  );
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
      owner,
      "extra",
    ),
    unavailable,
  );
  for (const value of [
    null,
    [],
    { ...appearance, extra: true },
    { tone: "light", crt: "full" },
    { tone: "light", crt: "full", phosphor: "amber" },
    { ...appearance, phosphor: "blue" },
    { ...appearance, phosphorTier: "d" },
    { ...appearance, language: "fr" },
  ]) {
    assert.deepEqual(
      await ipc.invoke(
        WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
        owner,
        value,
      ),
      unavailable,
    );
  }
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
      owner,
      appearance,
      "extra",
    ),
    unavailable,
  );
  owner.destroyed = true;
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, owner),
    unavailable,
  );
  assert.equal(source.readCalls, 0);
  assert.equal(source.saveCalls, 0);
  binding.dispose();
});

test("appearance IPC sender accessors and Proxy traps fail to the fixed public result without source work", async () => {
  const ipc = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchAppearancePreferenceIpc({
    ipcMain: ipc,
    window: new FakeWindow(owner),
    source,
  });
  const loadHandler = ipc.handlers.get(
    WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL,
  );
  const saveHandler = ipc.handlers.get(
    WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
  );
  assert.ok(loadHandler);
  assert.ok(saveHandler);

  const throwingGetter = Object.defineProperty({}, "sender", {
    enumerable: true,
    get(): never {
      throw new Error("PRIVATE_SENDER_GETTER");
    },
  });
  const throwingHas = new Proxy(
    {},
    {
      has(): never {
        throw new Error("PRIVATE_SENDER_HAS_TRAP");
      },
    },
  );
  const throwingGet = new Proxy(
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

  for (const event of [throwingGetter, throwingHas, throwingGet]) {
    assert.deepEqual(await loadHandler(event), unavailable);
    assert.deepEqual(await saveHandler(event, appearance), unavailable);
  }
  assert.equal(source.readCalls, 0);
  assert.equal(source.saveCalls, 0);
  binding.dispose();
});

test("appearance IPC never exposes store drift or private load/save failures", async () => {
  const ipc = new FakeIpcMain();
  const sender = new FakeSender();
  const source = new FakeSource();
  const binding = installWorkbenchAppearancePreferenceIpc({
    ipcMain: ipc,
    window: new FakeWindow(sender),
    source,
  });

  source.readValue = { ...appearance, rawDocument: { schemaVersion: 1 } };
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, sender),
    unavailable,
  );
  source.readFailure = new Error("PRIVATE_APPEARANCE_READ_FAILURE");
  assert.deepEqual(
    await ipc.invoke(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, sender),
    unavailable,
  );
  source.saveFailure = new Error("PRIVATE_APPEARANCE_SAVE_FAILURE");
  assert.deepEqual(
    await ipc.invoke(
      WORKBENCH_SAVE_APPEARANCE_PREFERENCE_CHANNEL,
      sender,
      appearance,
    ),
    unavailable,
  );
  assert.equal(JSON.stringify(unavailable).includes("PRIVATE_"), false);
  binding.dispose();
});

test("terminal renderer lifecycle closes appearance actions and dispose removes exact listeners idempotently", async () => {
  for (const terminalEvent of [
    "render-process-gone",
    "destroyed",
    "closed",
  ] as const) {
    const ipc = new FakeIpcMain();
    const sender = new FakeSender();
    const window = new FakeWindow(sender);
    const source = new FakeSource();
    const binding = installWorkbenchAppearancePreferenceIpc({
      ipcMain: ipc,
      window,
      source,
    });

    if (terminalEvent === "closed") window.emit(terminalEvent);
    else sender.emit(terminalEvent);
    assert.deepEqual(
      await ipc.invoke(WORKBENCH_LOAD_APPEARANCE_PREFERENCE_CHANNEL, sender),
      unavailable,
    );
    assert.equal(source.readCalls, 0);

    binding.dispose();
    binding.dispose();
    assert.equal(ipc.handlers.size, 0);
    assert.equal(
      [...sender.listeners.values()].every((listeners) => listeners.size === 0),
      true,
    );
    assert.equal(
      [...window.listeners.values()].every((listeners) => listeners.size === 0),
      true,
    );
  }
});
