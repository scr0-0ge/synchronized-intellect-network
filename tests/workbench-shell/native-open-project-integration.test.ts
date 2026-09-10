import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import {
  createWorkbenchBackend,
  type WorkbenchBackend,
} from "../../src/workbench-shell/backend.ts";
import {
  WORKBENCH_OPEN_PROJECT_CHANNEL,
  type WorkbenchHostedProjectResult,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchProjectViewIpc,
  type BrowserWindowBoundary,
  type IpcMainBoundary,
  type ProjectDirectoryChooser,
  type RendererSender,
} from "../../src/workbench-shell/electron/project-view-ipc.ts";
import {
  createWorkbenchProjectHost,
  type WorkbenchProjectBackendFactory,
} from "../../src/workbench-shell/project-host.ts";
import {
  createTestDirectory,
  registerTestCleanup,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

type BoundaryListener = (...values: unknown[]) => unknown;

const fixedOpenFailure = Object.freeze({
  ok: false as const,
  error: Object.freeze({
    category: "project-open-unavailable" as const,
    message:
      "Open Project could not be completed. Keep the current Project and try again." as const,
  }),
});

class FakeIpcMain implements IpcMainBoundary {
  readonly handlers = new Map<string, BoundaryListener>();
  readonly listeners = new Map<string, Set<BoundaryListener>>();

  handle(channel: string, listener: BoundaryListener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  on(channel: string, listener: BoundaryListener): void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: BoundaryListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  async invoke(channel: string, sender: FakeSender): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("Missing deterministic handler.");
    return handler({ sender });
  }
}

class FakeSender implements RendererSender {
  private destroyed = false;
  private readonly listeners = new Map<string, Set<BoundaryListener>>();

  send(): void {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: string, listener: BoundaryListener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: BoundaryListener): void {
    this.listeners.get(event)?.delete(listener);
  }
}

class FakeWindow implements BrowserWindowBoundary {
  private readonly listeners = new Map<string, Set<BoundaryListener>>();
  readonly webContents: FakeSender;

  constructor(webContents: FakeSender) {
    this.webContents = webContents;
  }

  on(event: "closed", listener: BoundaryListener): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: "closed", listener: BoundaryListener): void {
    this.listeners.get(event)?.delete(listener);
  }
}

class FakeChooser implements ProjectDirectoryChooser {
  calls = 0;
  result: unknown = { canceled: true, filePaths: [] };
  rejection: unknown;

  async chooseProjectDirectory(): Promise<unknown> {
    this.calls += 1;
    if (this.rejection !== undefined) throw this.rejection;
    return this.result;
  }
}

class CountingRuntime implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  resumeCalls = 0;
  sendCalls = 0;

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "codex",
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          effortLevels: ["ultra"],
          effortLevelLabels: ["ultra"],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    return this.binding(request.profile);
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    return this.binding(request.profile);
  }

  private binding(profile: RuntimeStart["profile"]): ResumableRuntimeBinding {
    const runtime = this;
    return {
      profile,
      opaqueSessionReference: "deterministic-test-capability",
      async send(_input: RuntimeInput): Promise<void> {
        runtime.sendCalls += 1;
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {},
    };
  }
}

class BackendTracker {
  active = 0;
  maximumActive = 0;
  opens = 0;

  readonly create: WorkbenchProjectBackendFactory = async (options) => {
    const owner = this;
    const backend = await createWorkbenchBackend(options);
    this.opens += 1;
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    let closed = false;
    return Object.freeze({
      readTurnActivity() {
        return backend.readTurnActivity();
      },
      observeProject(listener) {
        return backend.observeProject(listener);
      },
      loadDirectSessionProfile() {
        return backend.loadDirectSessionProfile();
      },
      useDirectSessionProfileAsDefault(request) {
        return backend.useDirectSessionProfileAsDefault(request);
      },
      submitDirectInput(request) {
        return backend.submitDirectInput(request);
      },
      async close() {
        if (closed) return;
        await backend.close();
        closed = true;
        owner.active -= 1;
      },
    } satisfies WorkbenchBackend);
  };
}

test("fake native acquisition reaches the accepted Host with byte-stable cancel/failure, idempotency, one-open, and zero Runtime work", async (t) => {
  const root = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-native-open-"),
  );
  const firstDirectory = join(root, "First Project");
  const secondDirectory = join(root, "Second Project");
  const unavailableDirectory = join(root, "Unavailable Project");
  const dataDirectory = join(root, "private-data");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);

  const runtime = new CountingRuntime();
  const tracker = new BackendTracker();
  const host = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: firstDirectory,
    adapter: runtime,
    backendFactory: tracker.create,
  });
  registerTestClosable(t, host);
  await waitForProject(
    host,
    (result) => result.ok && "view" in result && result.view.projectSelection.projects.length === 1,
  );
  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const ipcMain = new FakeIpcMain();
  const sender = new FakeSender();
  const chooser = new FakeChooser();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(sender),
    source: host,
    directoryChooser: chooser,
  });
  const disposeBinding = registerTestCleanup(t, () => binding.dispose());

  const beforeCancel = await readFile(registryPath);
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, sender),
    {
      ok: true,
      status: "cancelled",
      message: "Open Project was cancelled. Nothing changed.",
    },
  );
  assert.deepEqual(await readFile(registryPath), beforeCancel);
  assert.equal(tracker.opens, 1);

  chooser.result = { canceled: false, filePaths: [secondDirectory] };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, sender),
    { ok: true, status: "opened", message: "Project was opened." },
  );
  const afterNewRegistration = await readFile(registryPath);
  assert.notDeepEqual(afterNewRegistration, beforeCancel);
  assert.equal(tracker.opens, 2);
  assert.equal(tracker.active, 1);
  assert.equal(tracker.maximumActive, 1);

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, sender),
    { ok: true, status: "opened", message: "Project was opened." },
  );
  assert.deepEqual(await readFile(registryPath), afterNewRegistration);
  assert.equal(tracker.opens, 2);

  chooser.result = { canceled: false, filePaths: [unavailableDirectory] };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, sender),
    fixedOpenFailure,
  );
  assert.deepEqual(await readFile(registryPath), afterNewRegistration);
  assert.equal(tracker.opens, 2);

  chooser.result = { canceled: false, filePaths: [] };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, sender),
    fixedOpenFailure,
  );
  chooser.rejection = new Error("PRIVATE_CHOOSER_REASON");
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, sender),
    fixedOpenFailure,
  );
  assert.deepEqual(await readFile(registryPath), afterNewRegistration);
  assert.equal(tracker.opens, 2);
  assert.deepEqual(runtimeCounts(runtime), {
    inspect: 0,
    start: 0,
    resume: 0,
    send: 0,
  });
  assert.equal(chooser.calls, 6);
  assert.equal(JSON.stringify(fixedOpenFailure).includes(root), false);

  await disposeBinding();
  assert.equal(ipcMain.handlers.size, 0);
  await host.close();
  assert.equal(tracker.active, 0);
});

function runtimeCounts(runtime: CountingRuntime): {
  readonly inspect: number;
  readonly start: number;
  readonly resume: number;
  readonly send: number;
} {
  return {
    inspect: runtime.inspectCalls,
    start: runtime.startCalls,
    resume: runtime.resumeCalls,
    send: runtime.sendCalls,
  };
}

function waitForProject(
  host: Awaited<ReturnType<typeof createWorkbenchProjectHost>>,
  predicate: (result: WorkbenchHostedProjectResult) => boolean,
): Promise<WorkbenchHostedProjectResult> {
  return new Promise((resolve) => {
    const dispose = host.observeProject((result) => {
      if (!predicate(result)) return;
      dispose();
      resolve(result);
    });
  });
}
