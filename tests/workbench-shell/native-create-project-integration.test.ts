import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

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
import { createWorkbenchCreateProjectController } from "../../src/workbench-shell/create-project-controller.ts";
import {
  createNodeWorkbenchCreateProjectFilesystem,
  type WorkbenchCreateProjectFilesystem,
} from "../../src/workbench-shell/create-project-filesystem.ts";
import {
  openWorkbenchCreateProjectStateStore,
  type WorkbenchCreateProjectStateStore,
} from "../../src/workbench-shell/create-project-store.ts";
import type {
  WorkbenchCreateProjectCreateResult,
  WorkbenchCreateProjectState,
} from "../../src/workbench-shell/create-project-transition.ts";
import type { WorkbenchHostedProjectResult } from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchProjectHost,
  type WorkbenchProjectBackendFactory,
  type WorkbenchProjectHost,
} from "../../src/workbench-shell/project-host.ts";
import {
  createTestDirectory,
  registerTestCleanup,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

test("production create makes one empty target, publishes/selects it before success, and restarts without a second effect", async (t) => {
  const root = await ownedTemporaryRoot(t);
  const fallbackDirectory = join(root, "Fallback Project");
  const targetDirectory = join(root, "Created Project");
  const dataDirectory = join(root, "host-data");
  await mkdir(fallbackDirectory);

  const runtime = new CountingRuntime();
  const tracker = new BackendTracker();
  const host = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: fallbackDirectory,
    adapter: runtime,
    backendFactory: tracker.create,
  });
  registerTestClosable(t, host);
  await waitForProject(host, (value) =>
    value.ok && "view" in value && value.view.project.label === "Fallback Project"
  );

  const openedStore = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(openedStore.ok, true);
  if (!openedStore.ok) assert.fail("Expected a private Create Project sidecar.");
  const trace: string[] = [];
  const stateStore = new TracingStore(openedStore.store, trace);
  registerTestClosable(t, stateStore);
  const filesystem = new TracingFilesystem(
    createNodeWorkbenchCreateProjectFilesystem(),
    trace,
  );
  const tracedHost = tracingHost(host, trace);
  let chooserCalls = 0;
  const dispose = host.observeProject((value) => {
    if (value.ok && "view" in value && value.view.project.label === "Created Project") {
      trace.push("view-target");
    }
  });
  registerTestCleanup(t, dispose);
  const controller = await createWorkbenchCreateProjectController({
    stateStore,
    filesystem,
    host: tracedHost,
    chooser: {
      async chooseProjectTarget() {
        chooserCalls += 1;
        trace.push("chooser");
        return { canceled: false, filePath: targetDirectory };
      },
    },
  });
  registerTestClosable(t, controller);

  const result = await controller.createProject();
  assert.deepEqual(result, { outcome: "created" });
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.deepEqual(Object.keys(result), ["outcome"]);
  assert.equal(chooserCalls, 1);
  assert.equal(filesystem.calls, 1);
  assert.equal(tracedHost.calls, 1);
  assert.deepEqual(trace, [
    "write:chooser-ready",
    "write:chooser-claimed",
    "chooser",
    "write:create-ready",
    "write:create-claimed",
    "mkdir",
    "write:register-ready",
    "write:register-claimed",
    "register",
    "view-target",
    "register-return",
    "write:response-ready",
    "write:completed",
  ]);
  const targetInformation = await lstat(targetDirectory);
  assert.equal(targetInformation.isDirectory(), true);
  assert.equal(targetInformation.isSymbolicLink(), false);
  assert.equal((await readdir(targetDirectory)).length, 0);
  assert.deepEqual(runtime.counts(), { inspect: 0, start: 0, resume: 0, send: 0 });
  assert.equal(tracker.active, 1);
  assert.equal(tracker.maximumActive, 1);

  const registryPath = join(dataDirectory, "project-registry-v1.json");
  const registryBeforeRestart = await readFile(registryPath, "utf8");
  const registry = JSON.parse(registryBeforeRestart) as {
    readonly records: readonly { readonly ledgerSlot: string }[];
    readonly selectedRecordKey: string;
  };
  assert.equal(registry.records.length, 2);
  assert.equal(typeof registry.selectedRecordKey, "string");
  const ledgerSlots = registry.records.map((record) => record.ledgerSlot);

  dispose();
  await stateStore.close();
  await host.close();
  assert.equal(tracker.active, 0);

  const restartedHost = await createWorkbenchProjectHost({
    dataDirectory,
    fallbackProjectDirectory: fallbackDirectory,
    adapter: runtime,
    backendFactory: tracker.create,
  });
  registerTestClosable(t, restartedHost);
  await waitForProject(restartedHost, (value) =>
    value.ok && "view" in value && value.view.project.label === "Created Project"
  );
  const restartedStore = await openWorkbenchCreateProjectStateStore({ dataDirectory });
  assert.equal(restartedStore.ok, true);
  if (!restartedStore.ok) assert.fail("Expected committed sidecar restart.");
  registerTestClosable(t, restartedStore.store);
  let restartedChooserCalls = 0;
  let restartedCreateCalls = 0;
  let restartedRegistrationCalls = 0;
  const restartedController = await createWorkbenchCreateProjectController({
    stateStore: restartedStore.store,
    chooser: {
      async chooseProjectTarget() {
        restartedChooserCalls += 1;
        return { canceled: true, filePath: "" };
      },
    },
    filesystem: {
      async createIfAbsent() {
        restartedCreateCalls += 1;
        return "unknown";
      },
    },
    host: {
      async registerTrustedProject(directory) {
        restartedRegistrationCalls += 1;
        return restartedHost.registerTrustedProject(directory);
      },
    },
  });
  registerTestClosable(t, restartedController);
  assert.deepEqual(
    { restartedChooserCalls, restartedCreateCalls, restartedRegistrationCalls },
    { restartedChooserCalls: 0, restartedCreateCalls: 0, restartedRegistrationCalls: 0 },
  );
  assert.equal(
    (await readFile(registryPath, "utf8")) === registryBeforeRestart,
    true,
  );
  const restartedRegistry = JSON.parse(await readFile(registryPath, "utf8")) as {
    readonly records: readonly { readonly ledgerSlot: string }[];
  };
  const restartedLedgerSlots = restartedRegistry.records.map(
    (record) => record.ledgerSlot,
  );
  assert.equal(restartedLedgerSlots.length, ledgerSlots.length);
  assert.equal(
    restartedLedgerSlots.every(
      (ledgerSlot, index) => ledgerSlot === ledgerSlots[index],
    ),
    true,
  );
  assert.equal((await readdir(targetDirectory)).length, 0);
  assert.deepEqual(runtime.counts(), { inspect: 0, start: 0, resume: 0, send: 0 });
  assert.equal(tracker.active, 1);
  assert.equal(tracker.maximumActive, 1);

  await restartedController.close();
  await restartedHost.close();
  assert.equal(tracker.active, 0);
  assert.equal((await lstat(targetDirectory)).isDirectory(), true);
});

class TracingStore implements WorkbenchCreateProjectStateStore {
  private readonly delegate: WorkbenchCreateProjectStateStore;
  private readonly trace: string[];

  constructor(
    delegate: WorkbenchCreateProjectStateStore,
    trace: string[],
  ) {
    this.delegate = delegate;
    this.trace = trace;
  }

  get state(): WorkbenchCreateProjectState { return this.delegate.state; }

  async write(next: WorkbenchCreateProjectState): Promise<boolean> {
    const committed = await this.delegate.write(next);
    if (committed) {
      this.trace.push(`write:${next.active?.phase ?? next.last?.phase ?? "empty"}`);
    }
    return committed;
  }

  close(): Promise<void> { return this.delegate.close(); }
}

class TracingFilesystem implements WorkbenchCreateProjectFilesystem {
  calls = 0;
  private readonly delegate: WorkbenchCreateProjectFilesystem;
  private readonly trace: string[];

  constructor(
    delegate: WorkbenchCreateProjectFilesystem,
    trace: string[],
  ) {
    this.delegate = delegate;
    this.trace = trace;
  }

  async createIfAbsent(path: string): Promise<WorkbenchCreateProjectCreateResult> {
    this.calls += 1;
    this.trace.push("mkdir");
    return this.delegate.createIfAbsent(path);
  }
}

function tracingHost(host: WorkbenchProjectHost, trace: string[]) {
  return {
    calls: 0,
    async registerTrustedProject(directory: string) {
      this.calls += 1;
      trace.push("register");
      const result = await host.registerTrustedProject(directory);
      trace.push("register-return");
      return result;
    },
  };
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

  counts() {
    return {
      inspect: this.inspectCalls,
      start: this.startCalls,
      resume: this.resumeCalls,
      send: this.sendCalls,
    };
  }

  private binding(profile: RuntimeStart["profile"]): ResumableRuntimeBinding {
    const runtime = this;
    return {
      profile,
      opaqueSessionReference: "deterministic-create-test-capability",
      async send(_input: RuntimeInput): Promise<void> { runtime.sendCalls += 1; },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {},
    };
  }
}

class BackendTracker {
  active = 0;
  maximumActive = 0;

  readonly create: WorkbenchProjectBackendFactory = async (options) => {
    const tracker = this;
    const backend = await createWorkbenchBackend(options);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    let closed = false;
    return Object.freeze({
      readTurnActivity() { return backend.readTurnActivity(); },
      observeProject(listener) { return backend.observeProject(listener); },
      loadDirectSessionProfile() { return backend.loadDirectSessionProfile(); },
      useDirectSessionProfileAsDefault(request) {
        return backend.useDirectSessionProfileAsDefault(request);
      },
      submitDirectInput(request) { return backend.submitDirectInput(request); },
      async close() {
        if (closed) return;
        await backend.close();
        closed = true;
        tracker.active -= 1;
      },
    } satisfies WorkbenchBackend);
  };
}

function waitForProject(
  host: WorkbenchProjectHost,
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

async function ownedTemporaryRoot(t: TestContext): Promise<string> {
  const root = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-native-create-"),
  );
  assert.equal(resolve(root).startsWith(`${resolve(tmpdir())}\\`), true);
  registerTestCleanup(t, async () => {
    const information = await lstat(root);
    assert.equal(information.isDirectory(), true);
    assert.equal(information.isSymbolicLink(), false);
  });
  return root;
}
