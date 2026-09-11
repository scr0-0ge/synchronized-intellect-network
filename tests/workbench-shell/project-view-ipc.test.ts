import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchProjectTransferDecoder } from "../../src/workbench-shell/result-sanitizer.ts";

import { hostedProjectView } from "./w26-hosted-project-view.ts";

import {
  WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_CREATE_PROJECT_CHANNEL,
  WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
  WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_DISPOSE_CHANNEL,
  WORKBENCH_LOAD_PROFILE_CHANNEL,
  WORKBENCH_INTERRUPT_CHANNEL,
  WORKBENCH_STEER_CHANNEL,
  WORKBENCH_READ_USER_INPUT_CHANNEL,
  WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
  WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
  WORKBENCH_OBSERVE_CHANNEL,
  WORKBENCH_OPEN_PROJECT_CHANNEL,
  WORKBENCH_PROJECT_VIEW_CHANNEL,
  WORKBENCH_REMOVE_PROJECT_CHANNEL,
  WORKBENCH_REMOVE_SESSION_CHANNEL,
  WORKBENCH_SELECT_PROJECT_CHANNEL,
  WORKBENCH_SUBMIT_CHANNEL,
  WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  type WorkbenchAnyPublicDirectSessionProfileResult,
  type WorkbenchDirectInputRequest,
  type WorkbenchCatalogDefaultPublicProfileResult,
  type WorkbenchCreateProjectResult,
  type WorkbenchStartDirectInputRequest,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchDirectSessionProfileLoadRequest,
  type WorkbenchPublicDirectSessionProfileResult,
  type WorkbenchHostedProjectListener,
  type WorkbenchHostedProjectResult,
  type WorkbenchInterruptRequest,
  type WorkbenchInterruptResult,
  type WorkbenchSteerRequest,
  type WorkbenchSteerResult,
  type WorkbenchOpenProjectResult,
  type WorkbenchProjectHistoryHideRequest,
  type WorkbenchProjectHistoryHideResult,
  type WorkbenchProjectSelectionRequest,
  type WorkbenchProjectSelectionResult,
  type WorkbenchProjectRemovalResult,
  type WorkbenchSessionRemovalRequest,
  type WorkbenchSessionRemovalResult,
  type WorkbenchSessionMetadataMutationRequest,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSubmissionResult,
} from "../../src/workbench-shell/contract.ts";
import {
  installWorkbenchProjectViewIpc,
  type BrowserWindowBoundary,
  type IpcMainBoundary,
  type ProjectDirectoryChooser,
  type RendererSender,
} from "../../src/workbench-shell/electron/project-view-ipc.ts";

const catalogDefaultRequest = Object.freeze({
  kind: "catalog-default" as const,
});

type Listener = (...values: unknown[]) => void;

class FakeIpcMain implements IpcMainBoundary {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly handlers = new Map<string, Listener>();

  on(channel: string, listener: Listener): void {
    const listeners = this.listeners.get(channel) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  removeListener(channel: string, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  handle(channel: string, listener: Listener): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  emit(channel: string, sender: RendererSender): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      listener({ sender });
    }
  }

  async invoke(
    channel: string,
    sender: RendererSender,
    ...values: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error("missing-handler");
    return handler({ sender }, ...values);
  }
}

class FakeSender implements RendererSender {
  readonly messages: Array<{ channel: string; value: unknown }> = [];
  readonly packets: unknown[] = [];
  readonly decode = createWorkbenchProjectTransferDecoder();
  readonly listeners = new Map<string, Set<Listener>>();
  destroyed = false;

  send(channel: string, value: unknown): void {
    if (channel === WORKBENCH_PROJECT_VIEW_CHANNEL) { this.packets.push(value); value = this.decode(value); }
    this.messages.push({ channel, value });
  }

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
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

class FakeWindow implements BrowserWindowBoundary {
  readonly webContents: RendererSender;
  readonly listeners = new Map<string, Set<Listener>>();

  constructor(webContents: RendererSender) {
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

  emit(event: "closed"): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

class FakeProjectViewSource {
  readonly listeners: WorkbenchHostedProjectListener[] = [];
  readonly projectSelections: WorkbenchProjectSelectionRequest[] = [];
  readonly projectRemovals: WorkbenchProjectSelectionRequest[] = [];
  readonly projectHistoryHides: WorkbenchProjectHistoryHideRequest[] = [];
  readonly sessionRemovals: WorkbenchSessionRemovalRequest[] = [];
  readonly sessionMetadataMutations: WorkbenchSessionMetadataMutationRequest[] = [];
  readonly trustedRegistrations: string[] = [];
  readonly submissions: WorkbenchDirectInputRequest[] = [];
  readonly interrupts: WorkbenchInterruptRequest[] = [];
  readonly steers: WorkbenchSteerRequest[] = [];
  readonly defaultSaves: WorkbenchDirectSessionProfileDefaultRequest[] = [];
  readonly profileLoadRequests: WorkbenchDirectSessionProfileLoadRequest[] = [];
  profileLoads = 0;
  disposeCalls = 0;
  submissionResult: unknown = {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  };
  submissionThrows = false;
  interruptResult: unknown = {
    ok: true,
    status: "requested",
    message: "Interrupt requested.",
  };
  interruptThrows = false;
  steerResult: unknown = {
    ok: true,
    status: "accepted",
    message: "Guidance was accepted into the running turn.",
  };
  steerThrows = false;
  profileResult: unknown = profileLoadResult();
  profileThrows = false;
  defaultSaveResult: unknown = {
    ok: true,
    status: "saved",
    message: "Session Profile default was durably saved.",
  };
  defaultSaveThrows = false;
  projectSelectionResult: unknown = {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  };
  projectSelectionThrows = false;
  projectRemovalResult: WorkbenchProjectRemovalResult = { status: "removed" };
  projectRemovalThrows = false;
  projectHistoryHideResult: WorkbenchProjectHistoryHideResult = {
    status: "hidden",
  };
  projectHistoryHideThrows = false;
  sessionRemovalResult: WorkbenchSessionRemovalResult = { status: "removed" };
  sessionRemovalThrows = false;
  sessionMetadataMutationResult: WorkbenchSessionMetadataMutationResult = {
    status: "renamed",
  };
  sessionMetadataMutationThrows = false;
  trustedRegistrationResult: WorkbenchProjectSelectionResult = {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  };
  trustedRegistrationPending:
    | Promise<WorkbenchProjectSelectionResult>
    | undefined;
  trustedRegistrationThrows = false;

  observeProject(listener: WorkbenchHostedProjectListener): () => void {
    this.listeners.push(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.disposeCalls += 1;
    };
  }

  emit(index: number, result: WorkbenchHostedProjectResult): void {
    this.listeners[index]?.(result);
  }

  async selectProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectSelectionResult> {
    this.projectSelections.push(request);
    if (this.projectSelectionThrows) {
      throw new Error("PRIVATE_PROJECT_SELECTION_FAILURE");
    }
    return this.projectSelectionResult as WorkbenchProjectSelectionResult;
  }

  async removeProject(
    request: WorkbenchProjectSelectionRequest,
  ): Promise<WorkbenchProjectRemovalResult> {
    this.projectRemovals.push(request);
    if (this.projectRemovalThrows) {
      throw new Error("PRIVATE_PROJECT_REMOVAL_FAILURE");
    }
    return this.projectRemovalResult;
  }

  async hideProjectHistory(
    request: WorkbenchProjectHistoryHideRequest,
  ): Promise<WorkbenchProjectHistoryHideResult> {
    this.projectHistoryHides.push(request);
    if (this.projectHistoryHideThrows) {
      throw new Error("PRIVATE_PROJECT_HISTORY_HIDE_FAILURE");
    }
    return this.projectHistoryHideResult;
  }

  async removeSession(
    request: WorkbenchSessionRemovalRequest,
  ): Promise<WorkbenchSessionRemovalResult> {
    this.sessionRemovals.push(request);
    if (this.sessionRemovalThrows) {
      throw new Error("PRIVATE_SESSION_REMOVAL_FAILURE");
    }
    return this.sessionRemovalResult;
  }

  async mutateSessionMetadata(
    request: WorkbenchSessionMetadataMutationRequest,
  ): Promise<WorkbenchSessionMetadataMutationResult> {
    this.sessionMetadataMutations.push(request);
    if (this.sessionMetadataMutationThrows) {
      throw new Error("PRIVATE_SESSION_METADATA_FAILURE");
    }
    return this.sessionMetadataMutationResult;
  }

  async registerTrustedProject(
    directory: string,
  ): Promise<WorkbenchProjectSelectionResult> {
    this.trustedRegistrations.push(directory);
    if (this.trustedRegistrationThrows) {
      throw new Error("PRIVATE_TRUSTED_REGISTRATION_FAILURE");
    }
    if (this.trustedRegistrationPending !== undefined) {
      return this.trustedRegistrationPending;
    }
    return this.trustedRegistrationResult;
  }

  async loadDirectSessionProfile(
    request: WorkbenchDirectSessionProfileLoadRequest,
  ): Promise<WorkbenchAnyPublicDirectSessionProfileResult> {
    this.profileLoads += 1;
    this.profileLoadRequests.push(request);
    if (this.profileThrows) throw new Error("PRIVATE_PROFILE_FAILURE");
    return this.profileResult as WorkbenchAnyPublicDirectSessionProfileResult;
  }

  async submitDirectInput(
    request: WorkbenchDirectInputRequest,
  ): Promise<WorkbenchSubmissionResult> {
    this.submissions.push(request);
    if (this.submissionThrows) throw new Error("PRIVATE_BACKEND_FAILURE");
    return this.submissionResult as WorkbenchSubmissionResult;
  }

  async interruptActiveTurn(
    request: WorkbenchInterruptRequest,
  ): Promise<WorkbenchInterruptResult> {
    this.interrupts.push(request);
    if (this.interruptThrows) throw new Error("PRIVATE_INTERRUPT_FAILURE");
    return this.interruptResult as WorkbenchInterruptResult;
  }

  async steerActiveTurn(
    request: WorkbenchSteerRequest,
  ): Promise<WorkbenchSteerResult> {
    this.steers.push(request);
    if (this.steerThrows) throw new Error("PRIVATE_STEER_FAILURE");
    return this.steerResult as WorkbenchSteerResult;
  }

  async useDirectSessionProfileAsDefault(
    request: WorkbenchDirectSessionProfileDefaultRequest,
  ): Promise<WorkbenchDirectSessionProfileDefaultResult> {
    this.defaultSaves.push(request);
    if (this.defaultSaveThrows) throw new Error("PRIVATE_DEFAULT_FAILURE");
    return this.defaultSaveResult as WorkbenchDirectSessionProfileDefaultResult;
  }
}

class FakeProjectDirectoryChooser implements ProjectDirectoryChooser {
  readonly windows: BrowserWindowBoundary[] = [];
  result: unknown = { canceled: true, filePaths: [] };
  rejection: unknown;
  pending: Promise<unknown> | undefined;

  async chooseProjectDirectory(
    window: BrowserWindowBoundary,
  ): Promise<unknown> {
    this.windows.push(window);
    if (this.rejection !== undefined) throw this.rejection;
    if (this.pending !== undefined) return this.pending;
    return this.result;
  }
}

class FakeCreateProjectController {
  calls = 0;
  closeCalls = 0;
  result: unknown = { outcome: "created" };
  pending: Promise<unknown> | undefined;

  async createProject(): Promise<WorkbenchCreateProjectResult> {
    this.calls += 1;
    return (this.pending ?? Promise.resolve(this.result)) as Promise<WorkbenchCreateProjectResult>;
  }

  async close(): Promise<void> { this.closeCalls += 1; }
}

test("IPC exposes one owning-sender zero-argument Create Project outcome and strips private values", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const controller = new FakeCreateProjectController();
  controller.result = {
    outcome: "created",
    target: "C:\\private\\Created Project",
    targetToken: "PRIVATE_CORRELATION",
    nativeValue: "PRIVATE_NATIVE_VALUE",
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source: new FakeProjectViewSource(),
    createProjectController: controller,
  });

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner),
    { outcome: "created" },
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner, "PRIVATE_INPUT"),
    { outcome: "unavailable" },
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, intruder),
    { outcome: "unavailable" },
  );
  assert.equal(controller.calls, 1);
  assert.equal(
    JSON.stringify(await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner)).includes("PRIVATE_"),
    false,
  );
  assert.equal(controller.calls, 2);
  binding.dispose();
  assert.equal(ipcMain.handlers.has(WORKBENCH_CREATE_PROJECT_CHANNEL), false);
});

test("IPC keeps an in-memory Create diagnostic out of the current public contract", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const controller = new FakeCreateProjectController();
  const privateResult = { outcome: "unavailable" as const };
  Object.defineProperty(privateResult, "diagnostic", {
    value: Object.freeze({
      reason: "parent-directory-missing",
      targetPath: "C:\\private\\Missing Parent\\New Project",
    }),
    enumerable: false,
  });
  controller.result = Object.freeze(privateResult);
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source: new FakeProjectViewSource(),
    createProjectController: controller,
  });

  const result = await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner);
  assert.deepEqual(result, { outcome: "unavailable" });
  assert.equal(JSON.stringify(result).includes("Missing Parent"), false);
  binding.dispose();
});

test("Create and Open Project mutually serialize and gate every ordinary Project action", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  const controller = new FakeCreateProjectController();
  let resolveCreate!: (value: unknown) => void;
  controller.pending = new Promise((resolve) => { resolveCreate = resolve; });
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
    createProjectController: controller,
  });

  const creating = ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner);
  await Promise.resolve();
  assert.deepEqual(await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner), fixedOpenUnavailable());
  assert.equal(chooser.windows.length, 0);
  assert.equal(
    (await ipcMain.invoke(
      WORKBENCH_LOAD_PROFILE_CHANNEL,
      owner,
      catalogDefaultRequest,
    ) as { ok: boolean }).ok,
    false,
  );
  assert.equal(
    (await ipcMain.invoke(
      WORKBENCH_SELECT_PROJECT_CHANNEL,
      owner,
      { selectionKey: "project-selection:00000000-0000-4000-8000-000000000021" },
    ) as { ok: boolean }).ok,
    false,
  );
  assert.equal(
    (await ipcMain.invoke(
      WORKBENCH_SUBMIT_CHANNEL,
      owner,
      profileRequest("Keep this draft."),
    ) as { ok: boolean }).ok,
    false,
  );
  resolveCreate({ outcome: "cancelled" });
  assert.deepEqual(await creating, { outcome: "cancelled" });

  let resolveOpen!: (value: unknown) => void;
  chooser.pending = new Promise((resolve) => { resolveOpen = resolve; });
  const opening = ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner);
  await Promise.resolve();
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner),
    { outcome: "unavailable" },
  );
  assert.equal(controller.calls, 1);
  resolveOpen({ canceled: true, filePaths: [] });
  await opening;
  binding.dispose();
});

test("terminal renderer lifecycle closes Create Project once and rejects late results", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const controller = new FakeCreateProjectController();
  let resolveCreate!: (value: unknown) => void;
  controller.pending = new Promise((resolve) => { resolveCreate = resolve; });
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window,
    source: new FakeProjectViewSource(),
    createProjectController: controller,
  });
  const creating = ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner);
  await Promise.resolve();
  owner.emit("render-process-gone");
  owner.emit("destroyed");
  await Promise.resolve();
  assert.equal(controller.closeCalls, 1);
  resolveCreate({ outcome: "created" });
  assert.deepEqual(await creating, { outcome: "unavailable" });
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner),
    { outcome: "unavailable" },
  );
  binding.dispose();
});

test("IPC owns one argument-free directory choice and passes one private selection directly to trusted registration", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  const selectedDirectory = "C:\\private\\Chosen Project";
  chooser.result = {
    canceled: false,
    filePaths: [selectedDirectory],
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window,
    source,
    directoryChooser: chooser,
  });

  const opened = (await ipcMain.invoke(
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    owner,
  )) as WorkbenchOpenProjectResult;

  assert.deepEqual(opened, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.deepEqual(chooser.windows, [window]);
  assert.deepEqual(source.trustedRegistrations, [selectedDirectory]);
  assert.equal(JSON.stringify(opened).includes(selectedDirectory), false);
  assert.equal(Object.isFrozen(opened), true);
  binding.dispose();
  assert.equal(ipcMain.handlers.has(WORKBENCH_OPEN_PROJECT_CHANNEL), false);
});

test("Open Project preserves the adoption announcement and carries only count-only history choices", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  chooser.result = {
    canceled: false,
    filePaths: ["C:\\private\\Returning Project"],
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
  });

  source.trustedRegistrationResult = {
    ok: true,
    status: "selected",
    message: "Project was opened with its existing conversation history.",
  };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    {
      ok: true,
      status: "opened",
      message: "Project was opened with its existing conversation history.",
    },
  );

  source.trustedRegistrationResult = {
    ok: true,
    status: "history-selection-required",
    message:
      "Choose which existing conversation history this Project should show. Nothing changed yet.",
    snapshot: {
      projectLabel: "Returning Project",
      histories: [
        {
          historyKey:
            "project-history:00000000-0000-4000-8000-000000000071",
          current: false,
          sessionCount: 1,
          commandCount: 1,
          updateCount: 4,
          byteSize: 49_152,
          lastModified: "2026-08-21T10:00:00Z",
          schemaVersion: 5,
        },
        {
          historyKey:
            "project-history:00000000-0000-4000-8000-000000000072",
          current: false,
          sessionCount: 2,
          commandCount: 3,
          updateCount: 8,
          byteSize: 61_440,
          lastModified: "2026-08-20T10:00:00Z",
          schemaVersion: 5,
        },
      ],
    },
  };
  const choice = await ipcMain.invoke(
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    owner,
  );
  assert.deepEqual(choice, source.trustedRegistrationResult);
  assert.equal(JSON.stringify(choice).includes("C:\\private"), false);
  assert.equal(JSON.stringify(choice).includes("ledgerSlot"), false);
  assert.equal(Object.isFrozen(choice), true);
  binding.dispose();
});

test("IPC treats cancellation as normal and maps every malformed or rejected chooser and registration outcome to fixed copy", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window,
    source,
    directoryChooser: chooser,
  });

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    {
      ok: true,
      status: "cancelled",
      message: "Open Project was cancelled. Nothing changed.",
    },
  );
  assert.equal(source.trustedRegistrations.length, 0);

  const malformedChoices: unknown[] = [
    { canceled: false, filePaths: [] },
    {
      canceled: false,
      filePaths: ["C:\\private\\First", "C:\\private\\Second"],
    },
    { canceled: true, filePaths: ["C:\\private\\Cancelled"] },
    { canceled: false, filePaths: [""] },
    { canceled: false, filePaths: ["C:\\private\\Project"], extra: true },
    { canceled: "false", filePaths: ["C:\\private\\Project"] },
    null,
  ];
  for (const choice of malformedChoices) {
    chooser.result = choice;
    assert.deepEqual(
      await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
      projectOpenUnavailable(),
    );
  }
  assert.equal(source.trustedRegistrations.length, 0);

  const callsBeforeIntruder = chooser.windows.length;
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, intruder),
    projectOpenUnavailable(),
  );
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_OPEN_PROJECT_CHANNEL,
      owner,
      "C:\\private\\Renderer Supplied",
    ),
    projectOpenUnavailable(),
  );
  assert.equal(chooser.windows.length, callsBeforeIntruder);

  chooser.rejection = new Error("PRIVATE_CHOOSER_REJECTION");
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    projectOpenUnavailable(),
  );
  chooser.rejection = undefined;
  chooser.result = {
    canceled: false,
    filePaths: ["C:\\private\\Unavailable Registration"],
  };
  source.trustedRegistrationResult = {
    ok: false,
    error: {
      category: "project-unavailable",
      message:
        "This Project is unavailable. Choose another Project or restore its directory.",
    },
  };
  const unavailable = await ipcMain.invoke(
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    owner,
  );
  assert.deepEqual(unavailable, projectOpenUnavailable());
  assert.equal(JSON.stringify(unavailable).includes("Unavailable Registration"), false);

  source.trustedRegistrationThrows = true;
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    projectOpenUnavailable(),
  );
  binding.dispose();
});

test("a pending Open Project request blocks duplicate and Project actions and ignores a late chooser completion after window destruction", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  let releaseChoice!: (value: unknown) => void;
  chooser.pending = new Promise<unknown>((resolve) => {
    releaseChoice = resolve;
  });
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window,
    source,
    directoryChooser: chooser,
  });

  const opening = ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner);
  await Promise.resolve();
  assert.equal(chooser.windows.length, 1);
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    projectOpenUnavailable(),
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_SELECT_PROJECT_CHANNEL, owner, {
      selectionKey:
        "project-selection:00000000-0000-4000-8000-000000000061",
    }),
    projectSwitchUnavailable(),
  );
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_LOAD_PROFILE_CHANNEL,
      owner,
      catalogDefaultRequest,
    ),
    profileUnavailable(),
  );
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
      owner,
      defaultRequest(),
    ),
    preferenceUnavailable(),
  );
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_SUBMIT_CHANNEL,
      owner,
      profileRequest("Must not reach the Project while opening."),
    ),
    unavailableSubmission(),
  );
  assert.equal(source.projectSelections.length, 0);
  assert.equal(source.profileLoads, 0);
  assert.equal(source.defaultSaves.length, 0);
  assert.equal(source.submissions.length, 0);

  window.emit("closed");
  releaseChoice({
    canceled: false,
    filePaths: ["C:\\private\\Late Completion"],
  });
  assert.deepEqual(await opening, projectOpenUnavailable());
  assert.equal(source.trustedRegistrations.length, 0);
  binding.dispose();
  assert.equal(ipcMain.handlers.size, 0);
});

test("an existing Project action blocks Open Project before the chooser is touched", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  let releaseProfile!: (value: WorkbenchPublicDirectSessionProfileResult) => void;
  source.profileResult = new Promise<WorkbenchPublicDirectSessionProfileResult>(
    (resolve) => {
      releaseProfile = resolve;
    },
  );
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
  });

  const loading = ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );
  await Promise.resolve();
  assert.equal(source.profileLoads, 1);
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    projectOpenUnavailable(),
  );
  assert.equal(chooser.windows.length, 0);
  assert.equal(source.trustedRegistrations.length, 0);

  releaseProfile(profileLoadResult());
  assert.deepEqual(await loading, profileLoadResult());
  binding.dispose();
});

test("IPC loads one sanitized profile only for the owning window through one fixed handler", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  source.profileResult = profileLoadResult();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });

  const foreign = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    intruder,
    catalogDefaultRequest,
  );
  const loaded = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );

  assert.deepEqual(foreign, profileUnavailable());
  assert.deepEqual(loaded, profileLoadResult());
  assert.deepEqual(loaded.endpointDiscovery, {
    statuses: [
      { endpointId: "codex-desktop", category: "catalog-ready" },
      {
        endpointId: "claude-code-desktop",
        category: "inspection-failed",
      },
      { endpointId: "glm-coding-plan", category: "not-inspected" },
      { endpointId: "kimi-code", category: "not-inspected" },
      { endpointId: "deepseek-api", category: "not-inspected" },
      { endpointId: "kimi-platform", category: "not-inspected" },
      { endpointId: "claude-api", category: "not-inspected" },
      { endpointId: "codex-api", category: "not-inspected" },
    ],
  });
  assert.equal(source.profileLoads, 1);
  assert.deepEqual(source.profileLoadRequests, [catalogDefaultRequest]);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.endpointDiscovery.statuses), true);
  assert.equal(JSON.stringify(loaded).includes("PRIVATE_"), false);
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_CREATE_PROJECT_CHANNEL,
    WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
    WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_INTERRUPT_CHANNEL,
    WORKBENCH_STEER_CHANNEL,
    WORKBENCH_READ_USER_INPUT_CHANNEL,
    WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_SESSION_CHANNEL,
    WORKBENCH_SELECT_PROJECT_CHANNEL,
    WORKBENCH_SUBMIT_CHANNEL,
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  ].sort());

  binding.dispose();
  assert.equal(ipcMain.handlers.size, 0);
});

test("IPC reconstructs and transits an exact replacement source request without adding a channel", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const ordinary = profileLoadResult();
  if (!ordinary.ok || ordinary.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected the ordinary profile fixture.");
  }
  const { desiredDefault, ...catalog } = ordinary.profile;
  const replacementResult = {
    ...ordinary,
    profile: { ...catalog, replacementPrefill: desiredDefault },
  };
  source.profileResult = replacementResult;
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = Object.freeze({
    kind: "replacement-session" as const,
    sourceSelectionKey: "command-7",
    sourceSnapshotCursor: 19,
  });

  const loaded = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    request,
  );

  assert.deepEqual(loaded, replacementResult);
  assert.deepEqual(source.profileLoadRequests, [request]);
  assert.equal(JSON.stringify(loaded).includes("command-7"), false);
  assert.equal(
    [...ipcMain.handlers.keys()].includes(WORKBENCH_LOAD_PROFILE_CHANNEL),
    true,
  );
  binding.dispose();
});

test("IPC rejects adversarial replacement request graphs before the Project source", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const exact = {
    kind: "replacement-session" as const,
    sourceSelectionKey: "command-7",
    sourceSnapshotCursor: 19,
  };
  const privateSymbol = Symbol("PRIVATE_REPLACEMENT_REQUEST");
  const symbolBearing = {
    ...exact,
    [privateSymbol]: "PRIVATE_REPLACEMENT_REQUEST",
  };
  const nonEnumerable = { ...exact } as Record<PropertyKey, unknown>;
  Object.defineProperty(nonEnumerable, "nativePath", {
    value: "C:\\PRIVATE\\runtime.exe",
    enumerable: false,
  });
  let accessorReads = 0;
  const accessorBearing = { ...exact } as Record<PropertyKey, unknown>;
  Object.defineProperty(accessorBearing, "sourceSelectionKey", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return exact.sourceSelectionKey;
    },
  });
  let proxyReads = 0;
  const proxy = new Proxy(exact, {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });

  for (const adversarial of [
    { ...exact, reason: "PRIVATE_MISMATCH_REASON" },
    symbolBearing,
    nonEnumerable,
    accessorBearing,
    proxy,
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(
        WORKBENCH_LOAD_PROFILE_CHANNEL,
        owner,
        adversarial,
      ),
      profileUnavailable(),
    );
  }
  assert.equal(source.profileLoads, 0);
  assert.equal(accessorReads, 0);
  assert.equal(proxyReads, 0);
  binding.dispose();
});

test("IPC maps malformed, thrown, extra-argument, and shutdown profile loads to fixed copy", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({ ipcMain, window, source });

  source.profileResult = {
    ok: true,
    profile: { runtime: "codex", nativeBody: "PRIVATE_NATIVE_BODY" },
  };
  const malformed = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );
  const exact = profileLoadResult();
  source.profileResult = {
    ...exact,
    endpointDiscovery: {
      statuses: [
        exact.endpointDiscovery.statuses[0],
        {
          ...exact.endpointDiscovery.statuses[1],
          account: "PRIVATE_ACCOUNT",
        },
      ],
    },
  };
  const malformedDiscovery = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );
  source.profileResult = {
    ...profileLoadResult(),
    nativeCatalog: "PRIVATE_NATIVE_CATALOG",
  };
  const extraShape = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );
  source.profileThrows = true;
  const thrown = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );
  source.profileThrows = false;
  const callsBeforeExtra = source.profileLoads;
  const extraArgument = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
    { nativeBody: "PRIVATE_EXTRA_ARGUMENT" },
  );
  assert.equal(source.profileLoads, callsBeforeExtra);
  window.emit("closed");
  const afterClose = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );

  for (const result of [
    malformed,
    malformedDiscovery,
    extraShape,
    thrown,
    extraArgument,
    afterClose,
  ]) {
    assert.deepEqual(result, profileUnavailable());
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  }
  binding.dispose();

  const unavailableIpc = new FakeIpcMain();
  const unavailableOwner = new FakeSender();
  const unavailableBinding = installWorkbenchProjectViewIpc({
    ipcMain: unavailableIpc,
    window: new FakeWindow(unavailableOwner),
    source: null,
  });
  assert.deepEqual(
    await unavailableIpc.invoke(
      WORKBENCH_LOAD_PROFILE_CHANNEL,
      unavailableOwner,
      catalogDefaultRequest,
    ),
    profileUnavailable(),
  );
  unavailableBinding.dispose();
});

test("IPC preserves the exact Runtime-not-located sidecar and rejects undeclared result keys", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  source.profileResult = runtimeNotLocated();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });

  const result = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );
  source.profileResult = {
    ...runtimeNotLocated(),
    root: "PRIVATE_ROOT",
    candidate: "PRIVATE_CANDIDATE",
    nativeError: "PRIVATE_NATIVE_ERROR",
  };
  const malformed = await ipcMain.invoke(
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    owner,
    catalogDefaultRequest,
  );

  assert.deepEqual(result, runtimeNotLocated());
  assert.deepEqual(malformed, profileUnavailable());
  assert.equal(JSON.stringify({ result, malformed }).includes("PRIVATE"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.endpointDiscovery.statuses), true);
  assert.equal(source.profileLoads, 2);
  binding.dispose();
});

test("IPC selects by one exact opaque Project key only for the owning window", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  source.projectSelectionResult = {
    ok: true,
    status: "selected",
    message: "Project was opened.",
    recordKey: "PRIVATE_DURABLE_RECORD",
    databasePath: "PRIVATE_DATABASE_PATH",
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = {
    selectionKey:
      "project-selection:00000000-0000-4000-8000-000000000051",
  };

  const foreign = await ipcMain.invoke(
    WORKBENCH_SELECT_PROJECT_CHANNEL,
    intruder,
    request,
  );
  const selected = await ipcMain.invoke(
    WORKBENCH_SELECT_PROJECT_CHANNEL,
    owner,
    request,
  );

  assert.deepEqual(foreign, projectSwitchUnavailable());
  assert.deepEqual(selected, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.deepEqual(source.projectSelections, [request]);
  assert.notEqual(source.projectSelections[0], request);
  assert.equal(Object.isFrozen(source.projectSelections[0]), true);
  assert.equal(JSON.stringify({ foreign, selected }).includes("PRIVATE_"), false);
  binding.dispose();
});

test("IPC removes only by exact opaque capabilities and reobserves after each successful removal", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  assert.equal(source.listeners.length, 1);
  const sessionRequest = {
    removalKey:
      "session-removal:00000000-0000-4000-8000-000000000061",
  };
  const projectRequest = {
    selectionKey:
      "project-selection:00000000-0000-4000-8000-000000000062",
  };

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_REMOVE_SESSION_CHANNEL, intruder, sessionRequest),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_REMOVE_SESSION_CHANNEL, owner, sessionRequest),
    { status: "removed" },
  );
  assert.deepEqual(source.sessionRemovals, [sessionRequest]);
  assert.notEqual(source.sessionRemovals[0], sessionRequest);
  assert.equal(Object.isFrozen(source.sessionRemovals[0]), true);
  assert.equal(source.disposeCalls, 1);
  assert.equal(source.listeners.length, 2);

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_REMOVE_PROJECT_CHANNEL, owner, projectRequest),
    { status: "removed" },
  );
  assert.deepEqual(source.projectRemovals, [projectRequest]);
  assert.notEqual(source.projectRemovals[0], projectRequest);
  assert.equal(source.disposeCalls, 2);
  assert.equal(source.listeners.length, 3);

  for (const malformed of [
    { removalKey: sessionRequest.removalKey, sessionId: "PRIVATE_ID" },
    { removalKey: "session-removal:forged" },
    { removalKey: projectRequest.selectionKey },
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(WORKBENCH_REMOVE_SESSION_CHANNEL, owner, malformed),
      { status: "not-found" },
    );
  }
  for (const malformed of [
    { selectionKey: projectRequest.selectionKey, directory: "C:\\private" },
    { selectionKey: "project-selection:forged" },
    { selectionKey: sessionRequest.removalKey },
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(WORKBENCH_REMOVE_PROJECT_CHANNEL, owner, malformed),
      { status: "invalid-selection" },
    );
  }
  assert.equal(source.sessionRemovals.length, 1);
  assert.equal(source.projectRemovals.length, 1);

  source.sessionRemovalResult = { status: "blocked", activity: "unknown" };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_REMOVE_SESSION_CHANNEL, owner, {
      removalKey:
        "session-removal:00000000-0000-4000-8000-000000000063",
    }),
    { status: "blocked", activity: "unknown" },
  );
  assert.equal(source.disposeCalls, 2, "blocked removal keeps the current observation");
  binding.dispose();
});

test("IPC hides a Project history only through one exact owning-sender capability", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = {
    historyKey: "project-history:00000000-0000-4000-8000-000000000091",
  };

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL, owner, request),
    { status: "hidden" },
  );
  assert.deepEqual(source.projectHistoryHides, [request]);
  assert.notEqual(source.projectHistoryHides[0], request);
  assert.equal(Object.isFrozen(source.projectHistoryHides[0]), true);
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
      owner,
      { ...request, ledgerSlot: "PRIVATE_LEDGER_SLOT" },
    ),
    { status: "invalid-selection" },
  );
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
      intruder,
      request,
    ),
    { status: "unavailable" },
  );
  assert.equal(source.projectHistoryHides.length, 1);

  source.projectHistoryHideResult = {
    status: "hidden",
    deleted: true,
  } as unknown as WorkbenchProjectHistoryHideResult;
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL, owner, request),
    { status: "unavailable" },
  );
  source.projectHistoryHideThrows = true;
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL, owner, request),
    { status: "unavailable" },
  );
  binding.dispose();
  assert.equal(ipcMain.handlers.has(WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL), false);
});

test("IPC admits only exact Session-metadata operations and reobserves durable changes", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  const metadataKey =
    "session-metadata:00000000-0000-4000-8000-000000000064";
  const rename = {
    metadataKey,
    operation: { kind: "rename", displayName: "  Cafe\u0301 工程  " },
  } as const;

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL, intruder, rename),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL, owner, rename),
    { status: "renamed" },
  );
  assert.deepEqual(source.sessionMetadataMutations, [
    {
      metadataKey,
      operation: { kind: "rename", displayName: "Café 工程" },
    },
  ]);
  assert.notEqual(source.sessionMetadataMutations[0], rename);
  assert.equal(Object.isFrozen(source.sessionMetadataMutations[0]), true);
  assert.equal(source.disposeCalls, 1);
  assert.equal(source.listeners.length, 2);

  source.sessionMetadataMutationResult = {
    status: "blocked",
    activity: "in-flight",
  };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL, owner, {
      metadataKey,
      operation: { kind: "archive" },
    }),
    { status: "blocked", activity: "in-flight" },
  );
  assert.equal(source.disposeCalls, 1, "blocked archive keeps the observation");

  const acceptedCount = source.sessionMetadataMutations.length;
  for (const malformed of [
    { metadataKey: "session-metadata:forged", operation: { kind: "archive" } },
    { metadataKey, operation: { kind: "archive" }, sessionId: "PRIVATE_ID" },
    { metadataKey, operation: { kind: "archive", extra: true } },
    { metadataKey, operation: { kind: "rename", displayName: " " } },
    new Proxy({ metadataKey, operation: { kind: "restore" as const } }, {}),
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(
        WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
        owner,
        malformed,
      ),
      { status: "unavailable" },
    );
  }
  assert.equal(source.sessionMetadataMutations.length, acceptedCount);

  source.sessionMetadataMutationThrows = true;
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL, owner, {
      metadataKey,
      operation: { kind: "restore" },
    }),
    { status: "unavailable" },
  );
  assert.equal(source.disposeCalls, 1);
  binding.dispose();
});

test("IPC rejects malformed Project selections and gates thrown, shutdown, and unavailable sources", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({ ipcMain, window, source });
  const key =
    "project-selection:00000000-0000-4000-8000-000000000052";
  for (const malformed of [
    undefined,
    {},
    { selectionKey: "project-selection:forged" },
    { selectionKey: key, directory: "C:\\private\\Project" },
    { selectionKey: key, recordKey: "PRIVATE_DURABLE_RECORD" },
    { selectionKey: key, ledgerSlot: "PRIVATE_LEDGER_SLOT" },
    { selectionKey: key, extra: true },
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(
        WORKBENCH_SELECT_PROJECT_CHANNEL,
        owner,
        malformed,
      ),
      invalidProjectSelection(),
    );
  }
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_SELECT_PROJECT_CHANNEL,
      owner,
      { selectionKey: key },
      { extra: "PRIVATE_EXTRA_ARGUMENT" },
    ),
    invalidProjectSelection(),
  );
  assert.equal(source.projectSelections.length, 0);

  source.projectSelectionThrows = true;
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_SELECT_PROJECT_CHANNEL,
      owner,
      { selectionKey: key },
    ),
    projectSwitchUnavailable(),
  );
  assert.equal(source.projectSelections.length, 1);
  source.projectSelectionThrows = false;
  window.emit("closed");
  assert.deepEqual(
    await ipcMain.invoke(
      WORKBENCH_SELECT_PROJECT_CHANNEL,
      owner,
      { selectionKey: key },
    ),
    projectSwitchUnavailable(),
  );
  assert.equal(source.projectSelections.length, 1);
  binding.dispose();

  const unavailableIpc = new FakeIpcMain();
  const unavailableOwner = new FakeSender();
  const unavailableBinding = installWorkbenchProjectViewIpc({
    ipcMain: unavailableIpc,
    window: new FakeWindow(unavailableOwner),
    source: null,
  });
  assert.deepEqual(
    await unavailableIpc.invoke(
      WORKBENCH_SELECT_PROJECT_CHANNEL,
      unavailableOwner,
      { selectionKey: key },
    ),
    projectSwitchUnavailable(),
  );
  unavailableBinding.dispose();
});

test("IPC saves one sanitized default only for the owning window through one fixed handler", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  source.defaultSaveResult = {
    ok: true,
    status: "saved",
    message: "Session Profile default was durably saved.",
    storedValue: "PRIVATE_STORED_VALUE",
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = defaultRequest();

  const foreign = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    intruder,
    request,
  );
  const saved = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    owner,
    request,
  );

  assert.deepEqual(foreign, preferenceUnavailable());
  assert.deepEqual(saved, {
    ok: true,
    status: "saved",
    message: "Session Profile default was durably saved.",
  });
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(JSON.stringify(saved).includes("PRIVATE_"), false);
  assert.deepEqual(source.defaultSaves, [request]);
  assert.notEqual(source.defaultSaves[0], request);
  assert.equal(Object.isFrozen(source.defaultSaves[0]), true);
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_CREATE_PROJECT_CHANNEL,
    WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
    WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_INTERRUPT_CHANNEL,
    WORKBENCH_STEER_CHANNEL,
    WORKBENCH_READ_USER_INPUT_CHANNEL,
    WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_SESSION_CHANNEL,
    WORKBENCH_SELECT_PROJECT_CHANNEL,
    WORKBENCH_SUBMIT_CHANNEL,
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  ].sort());

  binding.dispose();
  assert.equal(ipcMain.handlers.size, 0);
});

test("IPC rejects malformed default saves and maps backend or shutdown failures to fixed copy", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({ ipcMain, window, source });
  const request = defaultRequest();

  const malformed = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    owner,
    { ...request, extra: "PRIVATE_EXTRA_FIELD" },
  );
  const extraArgument = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    owner,
    request,
    "PRIVATE_EXTRA_ARGUMENT",
  );
  assert.deepEqual(malformed, invalidDefaultSelection());
  assert.deepEqual(extraArgument, invalidDefaultSelection());
  assert.equal(source.defaultSaves.length, 0);

  source.defaultSaveResult = {
    ok: false,
    error: {
      category: "preference-unavailable",
      message: "PRIVATE_BACKEND_MESSAGE",
    },
    storedValue: "PRIVATE_STORED_VALUE",
  };
  const malformedResult = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    owner,
    request,
  );
  assert.deepEqual(malformedResult, preferenceUnavailable());
  source.defaultSaveThrows = true;
  const thrown = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    owner,
    request,
  );
  assert.deepEqual(thrown, preferenceUnavailable());
  window.emit("closed");
  const callsBeforeClose = source.defaultSaves.length;
  const afterClose = await ipcMain.invoke(
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
    owner,
    request,
  );
  assert.deepEqual(afterClose, preferenceUnavailable());
  assert.equal(source.defaultSaves.length, callsBeforeClose);
  assert.equal(
    JSON.stringify({ malformedResult, thrown, afterClose }).includes(
      "PRIVATE_",
    ),
    false,
  );
  binding.dispose();

  const unavailableIpc = new FakeIpcMain();
  const unavailableOwner = new FakeSender();
  const unavailableBinding = installWorkbenchProjectViewIpc({
    ipcMain: unavailableIpc,
    window: new FakeWindow(unavailableOwner),
    source: null,
  });
  assert.deepEqual(
    await unavailableIpc.invoke(
      WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
      unavailableOwner,
      request,
    ),
    preferenceUnavailable(),
  );
  unavailableBinding.dispose();
});

test("IPC invokes one sanitized submission only for the owning window and removes its fixed handler", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const instruction = "Start one bounded Agent Session.";
  const request = profileRequest(instruction);

  const foreign = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    intruder,
    request,
  );
  const accepted = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    request,
  );

  assert.deepEqual(foreign, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  });
  assert.deepEqual(accepted, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.deepEqual(source.submissions, [request]);
  assert.notEqual(source.submissions[0], request);
  assert.equal(Object.isFrozen(source.submissions[0]), true);
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_CREATE_PROJECT_CHANNEL,
    WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
    WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_INTERRUPT_CHANNEL,
    WORKBENCH_STEER_CHANNEL,
    WORKBENCH_READ_USER_INPUT_CHANNEL,
    WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_SESSION_CHANNEL,
    WORKBENCH_SELECT_PROJECT_CHANNEL,
    WORKBENCH_SUBMIT_CHANNEL,
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  ].sort());
  assert.equal(JSON.stringify(accepted).includes(instruction), false);

  binding.dispose();
  binding.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  await assert.rejects(
    ipcMain.invoke(WORKBENCH_SUBMIT_CHANNEL, owner, request),
    /missing-handler/u,
  );
});

test("IPC accepts only one exact interrupt capability from the owning window", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = {
    interruptKey: "turn-interrupt:00000000-0000-4000-8000-000000000071",
  };

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_INTERRUPT_CHANNEL, intruder, request),
    {
      ok: false,
      error: {
        category: "interrupt-unavailable",
        message: "Interrupt is unavailable for this turn.",
      },
    },
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_INTERRUPT_CHANNEL, owner, request),
    {
      ok: true,
      status: "requested",
      message: "Interrupt requested.",
    },
  );
  assert.deepEqual(source.interrupts, [request]);
  assert.notEqual(source.interrupts[0], request);
  assert.equal(Object.isFrozen(source.interrupts[0]), true);

  for (const malformed of [
    { ...request, commandId: "PRIVATE_COMMAND" },
    { interruptKey: "turn-interrupt:forged" },
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(WORKBENCH_INTERRUPT_CHANNEL, owner, malformed),
      {
        ok: false,
        error: {
          category: "invalid-interrupt",
          message: "Reload the running Agent Session and try again.",
        },
      },
    );
  }
  assert.equal(source.interrupts.length, 1);

  source.interruptResult = {
    ok: false,
    error: {
      category: "interrupt-unavailable",
      message: "PRIVATE_NATIVE_DETAIL",
    },
  };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_INTERRUPT_CHANNEL, owner, request),
    {
      ok: false,
      error: {
        category: "interrupt-unavailable",
        message: "Interrupt is unavailable for this turn.",
      },
    },
  );
  binding.dispose();
  assert.equal(ipcMain.handlers.has(WORKBENCH_INTERRUPT_CHANNEL), false);
});

test("IPC accepts same-turn guidance only from the owning window with one exact request", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = {
    steerKey: "turn-steer:00000000-0000-4000-8000-000000000072",
    input: "Guide the active turn with this correction.",
  };

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_STEER_CHANNEL, intruder, request),
    {
      ok: false,
      error: {
        category: "steer-unavailable",
        message: "Same-turn guidance is unavailable. Your draft was kept.",
      },
    },
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_STEER_CHANNEL, owner, request),
    {
      ok: true,
      status: "accepted",
      message: "Guidance was accepted into the running turn.",
    },
  );
  assert.deepEqual(source.steers, [request]);
  assert.notEqual(source.steers[0], request);
  assert.equal(Object.isFrozen(source.steers[0]), true);

  for (const malformed of [
    { ...request, commandId: "PRIVATE_COMMAND" },
    { ...request, steerKey: "turn-steer:forged" },
    { ...request, input: "   " },
  ]) {
    assert.deepEqual(
      await ipcMain.invoke(WORKBENCH_STEER_CHANNEL, owner, malformed),
      {
        ok: false,
        error: {
          category: "invalid-steer",
          message: "Reload the running Agent Session and try again.",
        },
      },
    );
  }
  assert.equal(source.steers.length, 1);

  source.steerResult = {
    ok: false,
    error: {
      category: "steer-unavailable",
      message: "PRIVATE_NATIVE_DETAIL",
    },
  };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_STEER_CHANNEL, owner, request),
    {
      ok: false,
      error: {
        category: "steer-unavailable",
        message: "Same-turn guidance is unavailable. Your draft was kept.",
      },
    },
  );
  binding.dispose();
  assert.equal(ipcMain.handlers.has(WORKBENCH_STEER_CHANNEL), false);
});

test("IPC accepts one sanitized continuation capability and rejects a forged one before the backend", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const request = {
    kind: "continue" as const,
    input: "Continue the selected Session.",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000011",
    snapshotKey: "snapshot:00000000-0000-4000-8000-000000000001",
    endpointKey: "endpoint-option:1:00000000-0000-4000-8000-000000000004",
    modelKey: "model-option:1:00000000-0000-4000-8000-000000000002",
    workIntensityKey:
      "intensity-option:1:00000000-0000-4000-8000-000000000003",
    executionModeKey:
      "execution-option:1:00000000-0000-4000-8000-000000000005",
    accessModeKey:
      "access-option:1:00000000-0000-4000-8000-000000000006",
  };
  const accepted = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    request,
  );
  assert.equal((accepted as { ok: boolean }).ok, true);
  assert.deepEqual(source.submissions, [request]);
  assert.notEqual(source.submissions[0], request);

  const forged = await ipcMain.invoke(WORKBENCH_SUBMIT_CHANNEL, owner, {
    ...request,
    selectionKey: "session-selection:forged-native-value",
  });
  assert.deepEqual(forged, {
    ok: false,
    error: {
      category: "continuation-unavailable",
      message:
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    },
  });
  assert.equal(source.submissions.length, 1);

  source.submissionResult = continuationUnavailable();
  const stale = await ipcMain.invoke(WORKBENCH_SUBMIT_CHANNEL, owner, {
    ...request,
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000012",
  });
  assert.deepEqual(stale, continuationUnavailable());
  assert.equal(source.submissions.length, 2);
  assert.equal(
    JSON.stringify(stale).includes(
      "session-selection:00000000-0000-4000-8000-000000000012",
    ),
    false,
  );
  binding.dispose();
});

test("IPC validates submission input and results and fails fixed after backend or window shutdown", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({ ipcMain, window, source });

  const invalid = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    { text: "PRIVATE_MALFORMED_INPUT" },
  );
  assert.deepEqual(invalid, {
    ok: false,
    error: {
      category: "invalid-profile-selection",
      message:
        "Reload Codex Session Profile options and choose a model and Work Intensity.",
    },
  });
  assert.equal(source.submissions.length, 0);

  const exactStart = profileRequest("A valid explicit instruction.");
  const { kind: _kind, ...implicitStart } = exactStart;
  const mixedStart = {
    ...exactStart,
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000013",
  };
  const mixedContinue = {
    kind: "continue",
    input: "A mixed continuation.",
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000014",
    snapshotKey: exactStart.snapshotKey,
    modelKey: exactStart.modelKey,
    workIntensityKey: exactStart.workIntensityKey,
  };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_SUBMIT_CHANNEL, owner, implicitStart),
    invalidProfileSelection(),
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_SUBMIT_CHANNEL, owner, mixedStart),
    invalidProfileSelection(),
  );
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_SUBMIT_CHANNEL, owner, mixedContinue),
    continuationUnavailable(),
  );
  assert.equal(source.submissions.length, 0);

  const invalidInput = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    profileRequest("   "),
  );
  assert.deepEqual(invalidInput, {
    ok: false,
    error: {
      category: "invalid-input",
      message: "Enter a non-empty instruction of at most 8,000 characters.",
    },
  });
  const extraField = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    { ...profileRequest("A valid instruction."), extra: "PRIVATE_EXTRA" },
  );
  assert.deepEqual(extraField, invalidProfileSelection());
  assert.equal(source.submissions.length, 0);

  source.submissionResult = {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
    commandId: "PRIVATE_COMMAND_IDENTIFIER",
    nativeBody: "PRIVATE_NATIVE_BODY",
  };
  const reconstructed = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    profileRequest("A valid bounded instruction."),
  );
  assert.deepEqual(reconstructed, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.equal(Object.isFrozen(reconstructed), true);
  assert.equal(JSON.stringify(reconstructed).includes("PRIVATE_"), false);

  source.submissionResult = {
    ok: true,
    status: "completed",
    message: "PRIVATE_RUNTIME_OUTPUT",
  };
  const malformed = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    profileRequest("Another valid instruction."),
  );
  assert.deepEqual(malformed, unavailableSubmission());

  source.submissionThrows = true;
  const thrown = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    profileRequest("A third valid instruction."),
  );
  assert.deepEqual(thrown, unavailableSubmission());
  source.submissionThrows = false;
  const callsBeforeClose = source.submissions.length;

  window.emit("closed");
  const afterWindowClose = await ipcMain.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    owner,
    profileRequest("Must not reach the backend."),
  );
  assert.deepEqual(afterWindowClose, unavailableSubmission());
  assert.equal(source.submissions.length, callsBeforeClose);
  binding.dispose();

  const unavailableIpc = new FakeIpcMain();
  const unavailableOwner = new FakeSender();
  const unavailableBinding = installWorkbenchProjectViewIpc({
    ipcMain: unavailableIpc,
    window: new FakeWindow(unavailableOwner),
    source: null,
  });
  const missingBackend = await unavailableIpc.invoke(
    WORKBENCH_SUBMIT_CHANNEL,
    unavailableOwner,
    profileRequest("A valid instruction."),
  );
  assert.deepEqual(missingBackend, unavailableSubmission());
  unavailableBinding.dispose();
});

test("IPC validates the owning sender and permits one observation per window", () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const intruder = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });

  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, intruder);
  ipcMain.emit(WORKBENCH_DISPOSE_CHANNEL, intruder);
  assert.equal(source.listeners.length, 0);

  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  source.emit(0, validResult(1));
  assert.equal(source.listeners.length, 1);
  assert.deepEqual(owner.messages, [
    { channel: WORKBENCH_PROJECT_VIEW_CHANNEL, value: validResult(1) },
  ]);

  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  assert.equal(source.listeners.length, 2);
  assert.equal(source.disposeCalls, 1);
  ipcMain.emit(WORKBENCH_DISPOSE_CHANNEL, owner);
  ipcMain.emit(WORKBENCH_DISPOSE_CHANNEL, owner);
  assert.equal(source.disposeCalls, 2);

  binding.dispose();
  binding.dispose();
  assert.equal(ipcMain.listeners.get(WORKBENCH_OBSERVE_CHANNEL)?.size, 0);
  assert.equal(ipcMain.listeners.get(WORKBENCH_DISPOSE_CHANNEL)?.size, 0);
});

test("IPC observation preserves exact user text and rejects an extra event key on unchanged channels", () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });
  const text = [
    "C:\\Users\\Ada\\repo\\file.ts",
    "Bearer PUBLIC-CATEGORY-TEXT",
    "<script>literal</script>",
    "# Markdown stays text",
  ].join("\n");
  assert.deepEqual([...ipcMain.handlers.keys()].sort(), [
    WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_CREATE_PROJECT_CHANNEL,
    WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
    WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
    WORKBENCH_INTERRUPT_CHANNEL,
    WORKBENCH_STEER_CHANNEL,
    WORKBENCH_READ_USER_INPUT_CHANNEL,
    WORKBENCH_RESPOND_USER_INPUT_CHANNEL,
    WORKBENCH_LOAD_PROFILE_CHANNEL,
    WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_PROJECT_CHANNEL,
    WORKBENCH_REMOVE_SESSION_CHANNEL,
    WORKBENCH_SELECT_PROJECT_CHANNEL,
    WORKBENCH_SUBMIT_CHANNEL,
    WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  ].sort());
  assert.deepEqual([...ipcMain.listeners.keys()].sort(), [
    WORKBENCH_DISPOSE_CHANNEL,
    WORKBENCH_OBSERVE_CHANNEL,
  ].sort());

  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  source.emit(0, validResultWithTimeline(2, [
    { kind: "user-message", text },
  ]));
  assert.equal(owner.messages.length, 1);
  assert.equal(owner.messages[0]?.channel, WORKBENCH_PROJECT_VIEW_CHANNEL);
  const exact = owner.messages[0]?.value as WorkbenchHostedProjectResult;
  assert.equal(exact.ok, true);
  if (!exact.ok || "empty" in exact) {
    assert.fail("Expected the exact public user event.");
  }
  const event = exact.view.commands[0]?.session?.timeline[0];
  assert.deepEqual(event, { kind: "user-message", text });
  assert.equal(event?.kind === "user-message" ? event.text : undefined, text);
  assert.equal(Object.isFrozen(event), true);

  source.emit(0, validResultWithTimeline(3, [
    {
      kind: "user-message",
      text,
      extra: "PRIVATE_EXTRA_EVENT_FIELD",
    },
  ]));
  assert.deepEqual(owner.messages[1], {
    channel: WORKBENCH_PROJECT_VIEW_CHANNEL,
    value: {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    },
  });
  assert.equal(JSON.stringify(owner.messages[1]).includes("PRIVATE_EXTRA_EVENT_FIELD"), false);
  assert.equal(source.disposeCalls, 1);

  binding.dispose();
  assert.equal(source.disposeCalls, 1);
});

test("IPC tears down observation on renderer and window lifecycle boundaries", () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const window = new FakeWindow(owner);
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({ ipcMain, window, source });
  const rendererEvents = [
    "did-start-loading",
    "render-process-gone",
    "destroyed",
  ];

  for (const event of rendererEvents) {
    ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
    owner.emit(event);
  }
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  window.emit("closed");

  assert.equal(source.listeners.length, 4);
  assert.equal(source.disposeCalls, 4);
  binding.dispose();
  assert.equal(source.disposeCalls, 4);
});

test("IPC sends only fixed failure copy and releases the failed observation", () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });

  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });

  assert.deepEqual(owner.messages, [
    {
      channel: WORKBENCH_PROJECT_VIEW_CHANNEL,
      value: {
        ok: false,
        error: {
          category: "project-view-unavailable",
          message: "Live Project data is unavailable.",
        },
      },
    },
  ]);
  assert.equal(source.disposeCalls, 1);
  binding.dispose();
});

test("IPC sends an empty Project registry without treating it as a view or failure", () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
  });

  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
  source.emit(0, { ok: true, empty: true });

  assert.deepEqual(owner.messages, [
    {
      channel: WORKBENCH_PROJECT_VIEW_CHANNEL,
      value: { ok: true, empty: true },
    },
  ]);
  assert.equal(source.disposeCalls, 0);

  source.emit(0, validResult(1));
  assert.equal(owner.messages.length, 2);
  assert.equal(source.disposeCalls, 0);
  binding.dispose();
  assert.equal(source.disposeCalls, 1);
});

test("an acquisition-time failed projection keeps observation for the later valid target view", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const controller = new FakeCreateProjectController();
  let resolveCreate!: (value: unknown) => void;
  controller.pending = new Promise((resolve) => { resolveCreate = resolve; });
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    createProjectController: controller,
  });
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);

  const creating = ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner);
  await Promise.resolve();
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 0);

  resolveCreate({ outcome: "created" });
  assert.deepEqual(await creating, { outcome: "created" });
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 0);
  source.emit(0, validResult(91));
  assert.equal(owner.messages.length, 3);
  assert.equal(owner.messages[0]?.value !== undefined, true);
  assert.equal((owner.messages[1]?.value as { ok?: unknown }).ok, false);
  assert.equal((owner.messages[2]?.value as { ok?: unknown }).ok, true);
  assert.equal(source.disposeCalls, 0);

  binding.dispose();
  assert.equal(source.disposeCalls, 1);
});

test("result-first instructed Open recovery releases the next terminal failed projection exactly once", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const controller = new FakeCreateProjectController();
  const chooser = new FakeProjectDirectoryChooser();
  controller.result = { outcome: "created-recovery-required" };
  chooser.result = {
    canceled: false,
    filePaths: ["C:\\owned-test-root\\Recovered Project"],
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
    createProjectController: controller,
  });
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner),
    { outcome: "created-recovery-required" },
  );
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 0);

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    { ok: true, status: "opened", message: "Project was opened." },
  );
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 0);
  source.emit(0, validResult(92));
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });

  assert.equal(source.disposeCalls, 1);
  assert.equal(owner.messages.length, 4);
  assert.equal((owner.messages[0]?.value as { ok?: unknown }).ok, false);
  assert.equal((owner.messages[1]?.value as { ok?: unknown }).ok, false);
  assert.equal((owner.messages[2]?.value as { ok?: unknown }).ok, true);
  assert.equal((owner.messages[3]?.value as { ok?: unknown }).ok, false);
  assert.equal(source.trustedRegistrations.length, 1);

  binding.dispose();
  assert.equal(source.disposeCalls, 1);
});

test("view-first instructed Open recovery converges before terminal failed projection disposal", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const controller = new FakeCreateProjectController();
  const chooser = new FakeProjectDirectoryChooser();
  let resolveRegistration!: (value: WorkbenchProjectSelectionResult) => void;
  source.trustedRegistrationPending = new Promise((resolve) => {
    resolveRegistration = resolve;
  });
  controller.result = { outcome: "created-recovery-required" };
  chooser.result = {
    canceled: false,
    filePaths: ["C:\\owned-test-root\\Recovered Project"],
  };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
    createProjectController: controller,
  });
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner),
    { outcome: "created-recovery-required" },
  );
  const opening = ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner);
  await Promise.resolve();
  assert.equal(source.trustedRegistrations.length, 1);
  source.emit(0, validResult(93));
  assert.equal(source.disposeCalls, 0);
  resolveRegistration({
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.deepEqual(await opening, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });

  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 1);

  binding.dispose();
  assert.equal(source.disposeCalls, 1);
});

test("unrelated valid views and cancelled or failed Open attempts retain recovery observation authority", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const controller = new FakeCreateProjectController();
  const chooser = new FakeProjectDirectoryChooser();
  controller.result = { outcome: "created-recovery-required" };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
    createProjectController: controller,
  });
  ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);

  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_CREATE_PROJECT_CHANNEL, owner),
    { outcome: "created-recovery-required" },
  );
  source.emit(0, validResult(94));
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    {
      ok: true,
      status: "cancelled",
      message: "Open Project was cancelled. Nothing changed.",
    },
  );
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 0);

  chooser.result = {
    canceled: false,
    filePaths: ["C:\\owned-test-root\\Unavailable Recovery"],
  };
  let resolveFailedRegistration!: (
    value: WorkbenchProjectSelectionResult,
  ) => void;
  source.trustedRegistrationPending = new Promise((resolve) => {
    resolveFailedRegistration = resolve;
  });
  const failedOpening = ipcMain.invoke(
    WORKBENCH_OPEN_PROJECT_CHANNEL,
    owner,
  );
  await Promise.resolve();
  assert.equal(source.trustedRegistrations.length, 1);
  source.emit(0, validResult(95));
  resolveFailedRegistration({
    ok: false,
    error: {
      category: "project-unavailable",
      message:
        "This Project is unavailable. Choose another Project or restore its directory.",
    },
  });
  assert.deepEqual(
    await failedOpening,
    projectOpenUnavailable(),
  );
  source.emit(0, {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(source.disposeCalls, 0);

  binding.dispose();
  assert.equal(source.disposeCalls, 1);
});

function validResult(cursor: number): WorkbenchHostedProjectResult {
  return {
    ok: true,
    view: {
      project: { label: "Atlas Fieldnotes" },
      observation: { cursor, live: true },
      commands: [],
      initialSelectionKey: null,
      projectSelection: {
        projects: [
          {
            label: "Atlas Fieldnotes",
            availability: "available",
            selected: true,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000041",
          },
          {
            label: "Atlas Fieldnotes",
            availability: "missing",
            selected: false,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000042",
          },
        ],
      },
    },
  };
}

function validResultWithTimeline(
  cursor: number,
  timeline: unknown[],
): WorkbenchHostedProjectResult {
  const result = validResult(cursor) as unknown as {
    view: {
      commands: unknown[];
      initialSelectionKey: string | null;
    };
  };
  result.view.commands = [
    {
      key: "command-1",
      label: "Agent Session 01",
      runtime: "Codex",
      status: "accepted",
      session: {
        archived: false,
        metadataKey:
          "session-metadata:00000000-0000-4000-8000-000000000074",
        profile: {
          requested: { kind: "not-recorded" },
          effective: { kind: "not-recorded" },
        },
        timeline,
        removalKey:
          "session-removal:00000000-0000-4000-8000-000000000073",
        selectionKey: null,
        resumable: false,
      },
    },
  ];
  result.view.initialSelectionKey = "command-1";
  return result as unknown as WorkbenchHostedProjectResult;
}

function invalidProjectSelection(): WorkbenchProjectSelectionResult {
  return {
    ok: false,
    error: {
      category: "invalid-project-selection",
      message: "Reload the Project list and choose an available Project.",
    },
  };
}

function projectSwitchUnavailable(): WorkbenchProjectSelectionResult {
  return {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  };
}

function projectOpenUnavailable(): WorkbenchOpenProjectResult {
  return {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    },
  };
}

function unavailableSubmission(): WorkbenchSubmissionResult {
  return {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  };
}

function invalidProfileSelection(): WorkbenchSubmissionResult {
  return {
    ok: false,
    error: {
      category: "invalid-profile-selection",
      message:
        "Reload Codex Session Profile options and choose a model and Work Intensity.",
    },
  };
}

function continuationUnavailable(): WorkbenchSubmissionResult {
  return {
    ok: false,
    error: {
      category: "continuation-unavailable",
      message:
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    },
  };
}

function profileRequest(input: string): WorkbenchStartDirectInputRequest {
  return {
    kind: "start",
    input,
    snapshotKey: "snapshot:00000000-0000-4000-8000-000000000001",
    endpointKey: "endpoint-option:1:00000000-0000-4000-8000-000000000004",
    modelKey: "model-option:1:00000000-0000-4000-8000-000000000002",
    workIntensityKey:
      "intensity-option:1:00000000-0000-4000-8000-000000000003",
    executionModeKey:
      "execution-option:1:00000000-0000-4000-8000-000000000005",
    accessModeKey:
      "access-option:1:00000000-0000-4000-8000-000000000006",
  };
}

function fixedOpenUnavailable(): WorkbenchOpenProjectResult {
  return {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    },
  };
}

function defaultRequest(): WorkbenchDirectSessionProfileDefaultRequest {
  const request = profileRequest("unused");
  return {
    snapshotKey: request.snapshotKey,
    endpointKey: request.endpointKey,
    modelKey: request.modelKey,
    workIntensityKey: request.workIntensityKey,
    executionModeKey: request.executionModeKey,
    accessModeKey: request.accessModeKey,
  };
}

function preferenceUnavailable(): WorkbenchDirectSessionProfileDefaultResult {
  return {
    ok: false,
    error: {
      category: "preference-unavailable",
      message:
        "Codex Session Profile default could not be durably saved. Keep your selection and try again.",
    },
  };
}

function invalidDefaultSelection(): WorkbenchDirectSessionProfileDefaultResult {
  return {
    ok: false,
    error: {
      category: "invalid-profile-selection",
      message:
        "Reload Codex Session Profile options and choose a model and Work Intensity.",
    },
  };
}

function profileLoadResult(): WorkbenchCatalogDefaultPublicProfileResult {
  return {
    ok: true,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "catalog-ready" },
        {
          endpointId: "claude-code-desktop",
          category: "inspection-failed",
        },
        { endpointId: "glm-coding-plan", category: "not-inspected" },
        { endpointId: "kimi-code", category: "not-inspected" },
        { endpointId: "deepseek-api", category: "not-inspected" },
        { endpointId: "kimi-platform", category: "not-inspected" },
        { endpointId: "claude-api", category: "not-inspected" },
        { endpointId: "codex-api", category: "not-inspected" },
      ],
    },
    profile: {
      snapshotKey: "snapshot:00000000-0000-4000-8000-000000000001",
      endpoints: [
        {
          endpointId: "codex-desktop",
          key: "endpoint-option:1:00000000-0000-4000-8000-000000000004",
          runtimeFamilyLabel: "Runtime family",
          endpointLabel: "Desktop endpoint",
          models: [
            {
              key: "model-option:1:00000000-0000-4000-8000-000000000002",
              label: "Display model",
              provenanceLabel: null,
              workIntensityLabel: null,
              workIntensities: [
                {
                  key: "intensity-option:1:00000000-0000-4000-8000-000000000003",
                  label: "Display intensity",
                },
              ],
            },
          ],
          executionModes: [
            {
              key: "execution-option:1:00000000-0000-4000-8000-000000000005",
              label: "Single agent",
            },
          ],
          accessModes: [
            {
              key: "access-option:1:00000000-0000-4000-8000-000000000006",
              label: "Full access",
            },
          ],
        },
      ],
      desiredDefault: {
        kind: "resolved",
        endpointKey:
          "endpoint-option:1:00000000-0000-4000-8000-000000000004",
        modelKey: "model-option:1:00000000-0000-4000-8000-000000000002",
        workIntensityKey:
          "intensity-option:1:00000000-0000-4000-8000-000000000003",
        executionModeKey:
          "execution-option:1:00000000-0000-4000-8000-000000000005",
        accessModeKey:
          "access-option:1:00000000-0000-4000-8000-000000000006",
      },
    },
  };
}

function profileUnavailable(): WorkbenchPublicDirectSessionProfileResult {
  return {
    ok: false,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "not-inspected" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
        { endpointId: "glm-coding-plan", category: "not-inspected" },
        { endpointId: "kimi-code", category: "not-inspected" },
        { endpointId: "deepseek-api", category: "not-inspected" },
        { endpointId: "kimi-platform", category: "not-inspected" },
        { endpointId: "claude-api", category: "not-inspected" },
        { endpointId: "codex-api", category: "not-inspected" },
      ],
    },
    error: {
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
    },
  };
}

function runtimeNotLocated(): WorkbenchPublicDirectSessionProfileResult {
  return {
    ok: false,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "runtime-not-located" },
        {
          endpointId: "claude-code-desktop",
          category: "runtime-not-located",
        },
        { endpointId: "glm-coding-plan", category: "runtime-not-located" },
        { endpointId: "kimi-code", category: "runtime-not-located" },
        { endpointId: "deepseek-api", category: "runtime-not-located" },
        { endpointId: "kimi-platform", category: "runtime-not-located" },
        { endpointId: "claude-api", category: "runtime-not-located" },
        { endpointId: "codex-api", category: "runtime-not-located" },
      ],
    },
    error: {
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
    },
  };
}

// W141: first transfer establishes the base for subsequent history deltas.
test("Project IPC establishes an explicit snapshot base", () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const binding = installWorkbenchProjectViewIpc({ ipcMain, window: new FakeWindow(owner), source });
  try {
    ipcMain.emit(WORKBENCH_OBSERVE_CHANNEL, owner);
    source.emit(0, validResult(1));
    assert.equal((owner.packets[0] as { kind?: string }).kind, "snapshot");
  } finally { binding.dispose(); }
});

// F-w187 / public issue #5. Every registration failure used to collapse to
// "Open Project could not be completed" at this seam. The drive-root refusal is
// the one with a cause the reader can act on, and it keeps that cause.
test("Open Project carries the drive-root refusal across the IPC seam and nothing else about it", async () => {
  const ipcMain = new FakeIpcMain();
  const owner = new FakeSender();
  const source = new FakeProjectViewSource();
  const chooser = new FakeProjectDirectoryChooser();
  chooser.result = { canceled: false, filePaths: ["E:\\"] };
  const binding = installWorkbenchProjectViewIpc({
    ipcMain,
    window: new FakeWindow(owner),
    source,
    directoryChooser: chooser,
  });

  source.trustedRegistrationResult = {
    ok: false,
    error: {
      category: "project-directory-is-drive-root",
      message: "A drive root cannot be a Project. Choose a folder inside the drive instead.",
    },
  };
  const refused = await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner);
  assert.deepEqual(refused, {
    ok: false,
    error: {
      category: "project-directory-is-drive-root",
      message: "A drive root cannot be a Project. Choose a folder inside the drive instead.",
    },
  });
  assert.equal(JSON.stringify(refused).includes("E:\\"), false, "the chosen path never crosses");
  assert.equal(Object.isFrozen(refused), true);

  // Any other registration failure is still the fixed sentence.
  source.trustedRegistrationResult = {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message: "The Project could not be opened. Keep the current Project and try again.",
    },
  };
  assert.deepEqual(
    await ipcMain.invoke(WORKBENCH_OPEN_PROJECT_CHANNEL, owner),
    fixedOpenUnavailable(),
  );
  binding.dispose();
});
