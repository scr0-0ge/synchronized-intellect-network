import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_CREATE_PROJECT_CHANNEL,
  WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL,
  WORKBENCH_DISPOSE_CHANNEL,
  WORKBENCH_LOAD_PROFILE_CHANNEL,
  WORKBENCH_INTERRUPT_CHANNEL,
  WORKBENCH_STEER_CHANNEL,
  WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL,
  WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
  WORKBENCH_OBSERVE_CHANNEL,
  WORKBENCH_OPEN_PROJECT_CHANNEL,
  WORKBENCH_PROJECT_VIEW_CHANNEL,
  WORKBENCH_REMOVE_PROJECT_CHANNEL,
  WORKBENCH_REMOVE_SESSION_CHANNEL,
  WORKBENCH_SELECT_PROJECT_CHANNEL,
  WORKBENCH_SUBMIT_CHANNEL,
  WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL,
  type WorkbenchCreateProjectResult,
  type WorkbenchCatalogDefaultPublicProfileResult,
  type WorkbenchDirectInputRequest,
  type WorkbenchStartDirectInputRequest,
  type WorkbenchDirectSessionProfileDefaultRequest,
  type WorkbenchDirectSessionProfileDefaultResult,
  type WorkbenchPublicDirectSessionProfileResult,
  type WorkbenchHostedProjectResult,
  type WorkbenchOpenProjectResult,
  type WorkbenchProjectHistoryHideResult,
  type WorkbenchProjectSelectionResult,
  type WorkbenchProjectRemovalResult,
  type WorkbenchSessionRemovalResult,
  type WorkbenchSessionMetadataMutationResult,
  type WorkbenchSubmissionResult,
} from "../../src/workbench-shell/contract.ts";
import {
  createWorkbenchPreloadBridge,
  type FixedProjectViewIpc,
} from "../../src/workbench-shell/preload-bridge.ts";
import {
  WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL,
  WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
} from "../../src/workbench-shell/history-recovery-contract.ts";

const catalogDefaultRequest = Object.freeze({
  kind: "catalog-default" as const,
});

const expectedWorkbenchPreloadBridgeKeys = Object.freeze([
  "adoptProjectHistory",
  "beginSubscriptionAuthentication",
  "browse",
  "cancel",
  "cancelPreparedSubscriptionAuthentication",
  "createProject",
  "discoverProjectHistories",
  "getSnapshot",
  "hideProjectHistory",
  "inspectSubscriptionAuthentication",
  "interruptActiveTurn",
  "loadAppearancePreference",
  "loadClaudePermissionHandling",
  "loadDirectSessionProfile",
  "loadRuntimeExecutables",
  "mutateSessionMetadata",
  "notifyTurnCompleted",
  "observeProject",
  "openProject",
  "perform",
  "prepareSubscriptionAuthentication",
  "removeProject",
  "removeSession",
  "saveAppearancePreference",
  "saveClaudePermissionHandling",
  "saveRuntimeExecutable",
  "selectProject",
  "steerActiveTurn",
  "submitDirectInput",
  "useDirectSessionProfileAsDefault",
  "writeClipboardText",
]);

class FakeProjectViewIpc implements FixedProjectViewIpc {
  readonly sent: string[] = [];
  readonly invocations: Array<{ channel: string; values: readonly unknown[] }> = [];
  readonly listeners = new Set<(event: unknown, value: unknown) => void>();
  invokeResult: unknown = {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  };
  invokeThrows = false;

  on(
    channel: typeof WORKBENCH_PROJECT_VIEW_CHANNEL,
    listener: (event: unknown, value: unknown) => void,
  ): void {
    assert.equal(channel, WORKBENCH_PROJECT_VIEW_CHANNEL);
    this.listeners.add(listener);
  }

  removeListener(
    channel: typeof WORKBENCH_PROJECT_VIEW_CHANNEL,
    listener: (event: unknown, value: unknown) => void,
  ): void {
    assert.equal(channel, WORKBENCH_PROJECT_VIEW_CHANNEL);
    this.listeners.delete(listener);
  }

  send(
    channel:
      | typeof WORKBENCH_OBSERVE_CHANNEL
      | typeof WORKBENCH_DISPOSE_CHANNEL,
  ): void {
    this.sent.push(channel);
  }

  async invoke(
    channel:
      | typeof WORKBENCH_CREATE_PROJECT_CHANNEL
      | typeof WORKBENCH_ADOPT_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_DISCOVER_PROJECT_HISTORIES_CHANNEL
      | typeof WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL
      | typeof WORKBENCH_LOAD_PROFILE_CHANNEL
      | typeof WORKBENCH_INTERRUPT_CHANNEL
      | typeof WORKBENCH_STEER_CHANNEL
      | typeof WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL
      | typeof WORKBENCH_OPEN_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_PROJECT_CHANNEL
      | typeof WORKBENCH_REMOVE_SESSION_CHANNEL
      | typeof WORKBENCH_SELECT_PROJECT_CHANNEL
      | typeof WORKBENCH_SUBMIT_CHANNEL
      | typeof WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL
      | typeof WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    ...values: unknown[]
  ): Promise<unknown> {
    this.invocations.push({ channel, values });
    if (this.invokeThrows) throw new Error("PRIVATE_TRANSPORT_FAILURE");
    return this.invokeResult;
  }

  emit(value: unknown): void {
    for (const listener of [...this.listeners]) listener({}, value);
  }
}

test("preload bridge remains closed to every unregistered public member", () => {
  const bridge = createWorkbenchPreloadBridge(new FakeProjectViewIpc());
  const unregisteredKey = "PRIVATE_UNREGISTERED_PRELOAD_MEMBER";

  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
  assert.equal(Reflect.set(bridge, unregisteredKey, () => undefined), false);
  assert.equal(Reflect.has(bridge, unregisteredKey), false);
  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
});

test("preload exposes exactly four history-recovery methods with local parent-scoped authority", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  ipc.invokeResult = {
    version: 1,
    kind: "snapshot",
    requestKey: "history-request-1",
    status: "ready",
    snapshot: {
      snapshotKey: "history-snapshot-1",
      attention: true,
      library: {
        libraryKey: "history-library-1",
        label: "Historical Recovery Library",
        generationCount: 0,
      },
      sources: [
        {
          sourceKey: "history-source-1",
          label: "Historical store 1",
          role: "historical",
          state: "available",
          action: "preserve",
          counts: { projects: 1, sessions: 1, commands: 2, updates: 4 },
        },
      ],
    },
  };
  const snapshot = await bridge.getSnapshot({
    version: 1,
    requestKey: "history-request-1",
  });
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(ipc.invocations.at(-1), {
    channel: WORKBENCH_HISTORY_RECOVERY_SNAPSHOT_CHANNEL,
    values: [{ version: 1, requestKey: "history-request-1" }],
  });

  ipc.invokeResult = {
    version: 1,
    kind: "browse",
    requestKey: "history-browse-1",
    status: "ready",
    snapshotKey: "history-snapshot-1",
    branch: "generations",
    parentKey: "history-library-1",
    page: {
      after: null,
      nextAfter: null,
      totalCount: 1,
      items: [
        {
          kind: "generation",
          ordinal: 1,
          label: "Recovery 1",
          generationKey: "history-generation-1",
          sourceLabel: "Historical store 1",
          counts: { projects: 1, sessions: 1, commands: 2, updates: 4 },
        },
      ],
    },
  };
  await bridge.browse({
    version: 1,
    kind: "generations",
    requestKey: "history-browse-1",
    snapshotKey: "history-snapshot-1",
    libraryKey: "history-library-1",
    page: { after: null, size: 1 },
  });
  assert.equal(ipc.invocations.at(-1)?.channel, WORKBENCH_HISTORY_RECOVERY_BROWSE_CHANNEL);

  ipc.invokeResult = {
    version: 1,
    action: "export-copy",
    requestKey: "history-export-1",
    operationKey: "history-operation-1",
    status: "exported",
    export: {
      label: "Recovery export 1",
      warning:
        "The exported copy may contain conversation history and private local metadata.",
    },
  };
  assert.equal(
    (await bridge.perform({
      version: 1,
      action: "export-copy",
      requestKey: "history-export-1",
      operationKey: "history-operation-1",
      snapshotKey: "history-snapshot-1",
      generationKey: "history-generation-1",
    })).status,
    "exported",
  );
  assert.equal(ipc.invocations.at(-1)?.channel, WORKBENCH_HISTORY_RECOVERY_PERFORM_CHANNEL);

  const invocationCount = ipc.invocations.length;
  await assert.rejects(
    (bridge.perform as (request: unknown) => Promise<unknown>)({
      version: 1,
      action: "export-copy",
      requestKey: "history-forged-1",
      operationKey: "history-operation-forged",
      snapshotKey: "history-snapshot-1",
      generationKey: "history-generation-forged",
    }),
    /history-recovery-boundary-rejected/u,
  );
  assert.equal(ipc.invocations.length, invocationCount);

  ipc.invokeResult = {
    version: 1,
    kind: "cancel",
    requestKey: "history-cancel-1",
    operationKey: "history-operation-1",
    status: "already-terminal",
  };
  assert.equal(
    (await bridge.cancel({
      version: 1,
      requestKey: "history-cancel-1",
      operationKey: "history-operation-1",
    })).status,
    "already-terminal",
  );
  assert.equal(ipc.invocations.at(-1)?.channel, WORKBENCH_HISTORY_RECOVERY_CANCEL_CHANNEL);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
});

test("preload exposes one argument-free Create Project operation with one sanitized outcome", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  ipc.invokeResult = {
    outcome: "created",
    target: "C:\\private\\Created Project",
    targetToken: "PRIVATE_CORRELATION",
    nativeValue: "PRIVATE_NATIVE_VALUE",
  };

  const created = await bridge.createProject();
  const createWithIgnoredValues = bridge.createProject as (
    ...values: unknown[]
  ) => Promise<WorkbenchCreateProjectResult>;
  const createdAgain = await createWithIgnoredValues(
    "C:\\private\\Must Not Cross",
    { defaultPath: "PRIVATE_DEFAULT_PATH" },
  );

  assert.deepEqual(created, { outcome: "created" });
  assert.deepEqual(createdAgain, created);
  assert.notEqual(createdAgain, created);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_CREATE_PROJECT_CHANNEL, values: [] },
    { channel: WORKBENCH_CREATE_PROJECT_CHANNEL, values: [] },
  ]);
  assert.deepEqual(Object.keys(created), ["outcome"]);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(JSON.stringify({ created, createdAgain }).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify({ created, createdAgain }).includes("Created Project"), false);

  ipc.invokeThrows = true;
  assert.deepEqual(await bridge.createProject(), { outcome: "unavailable" });
});

test("preload exposes one argument-free Open Project operation and reconstructs fixed path-free results", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  ipc.invokeResult = {
    ok: true,
    status: "opened",
    message: "Project was opened.",
    selectedDirectory: "C:\\private\\Selected Project",
    nativeChooserValue: "PRIVATE_NATIVE_CHOOSER_VALUE",
  };

  const opened = await bridge.openProject();
  const openWithIgnoredValues = bridge.openProject as (
    ...values: unknown[]
  ) => Promise<WorkbenchOpenProjectResult>;
  const openedAgain = await openWithIgnoredValues(
    "C:\\private\\Must Not Cross",
    { defaultPath: "PRIVATE_DEFAULT_PATH" },
  );

  assert.deepEqual(opened, {
    ok: true,
    status: "opened",
    message: "Project was opened.",
  });
  assert.deepEqual(openedAgain, opened);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_OPEN_PROJECT_CHANNEL, values: [] },
    { channel: WORKBENCH_OPEN_PROJECT_CHANNEL, values: [] },
  ]);
  assert.equal(JSON.stringify({ opened, openedAgain }).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify({ opened, openedAgain }).includes("Selected Project"), false);
  assert.equal(Object.isFrozen(opened), true);

  ipc.invokeResult = {
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
    filePaths: ["C:\\private\\Cancelled Project"],
  };
  assert.deepEqual(await bridge.openProject(), {
    ok: true,
    status: "cancelled",
    message: "Open Project was cancelled. Nothing changed.",
  });

  ipc.invokeResult = {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message: "PRIVATE_NATIVE_FAILURE",
      selectedDirectory: "C:\\private\\Failed Project",
    },
  };
  assert.deepEqual(await bridge.openProject(), {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    },
  });
  ipc.invokeThrows = true;
  assert.deepEqual(await bridge.openProject(), {
    ok: false,
    error: {
      category: "project-open-unavailable",
      message:
        "Open Project could not be completed. Keep the current Project and try again.",
    },
  });
});

test("preload loads one profile through the fixed channel and reconstructs a fresh deeply frozen result", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const incoming = profileLoadResult();
  ipc.invokeResult = incoming;

  const first = await bridge.loadDirectSessionProfile(catalogDefaultRequest);
  const second = await bridge.loadDirectSessionProfile(catalogDefaultRequest);

  assert.deepEqual(first, profileLoadResult());
  assert.deepEqual(second, first);
  assert.notEqual(first, second);
  assert.deepEqual(first.endpointDiscovery, {
    statuses: [
      { endpointId: "codex-desktop", category: "catalog-ready" },
      {
        endpointId: "claude-code-desktop",
        category: "inspection-failed",
      },
    ],
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.endpointDiscovery), true);
  assert.equal(Object.isFrozen(first.endpointDiscovery.statuses), true);
  assert.equal(
    first.ok ? Object.isFrozen(first.profile.endpoints[0]?.models[0]) : false,
    true,
  );
  assert.equal(JSON.stringify(first).includes("PRIVATE_"), false);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_LOAD_PROFILE_CHANNEL, values: [catalogDefaultRequest] },
    { channel: WORKBENCH_LOAD_PROFILE_CHANNEL, values: [catalogDefaultRequest] },
  ]);
  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
});

test("preload reconstructs and transits one exact replacement source request on the existing profile channel", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const ordinary = profileLoadResult();
  if (!ordinary.ok || ordinary.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected the ordinary profile fixture.");
  }
  const { desiredDefault, ...catalog } = ordinary.profile;
  const incoming = {
    ...ordinary,
    profile: {
      ...catalog,
      replacementPrefill: desiredDefault,
    },
  };
  ipc.invokeResult = incoming;
  const request = Object.freeze({
    kind: "replacement-session" as const,
    sourceSelectionKey: "command-3",
    sourceSnapshotCursor: 41,
  });

  const loaded = await bridge.loadDirectSessionProfile(request);

  assert.deepEqual(loaded, incoming);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_LOAD_PROFILE_CHANNEL, values: [request] },
  ]);
  assert.equal(JSON.stringify(loaded).includes("command-3"), false);
});

test("preload rejects adversarial replacement request graphs before the fixed profile channel", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const exact = {
    kind: "replacement-session" as const,
    sourceSelectionKey: "command-3",
    sourceSnapshotCursor: 41,
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
  const loadUnknown = bridge.loadDirectSessionProfile as unknown as (
    request: unknown,
  ) => Promise<unknown>;

  for (const adversarial of [
    { ...exact, reason: "PRIVATE_MISMATCH_REASON" },
    symbolBearing,
    nonEnumerable,
    accessorBearing,
    proxy,
  ]) {
    assert.deepEqual(await loadUnknown(adversarial), profileUnavailable());
  }
  assert.equal(ipc.invocations.length, 0);
  assert.equal(accessorReads, 0);
  assert.equal(proxyReads, 0);
});

test("preload maps malformed and thrown profile loads to one fixed retryable failure", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  ipc.invokeResult = {
    ok: true,
    profile: {
      runtime: "codex",
      nativeCatalog: "PRIVATE_NATIVE_CATALOG",
    },
  };

  const malformed = await bridge.loadDirectSessionProfile(catalogDefaultRequest);
  const exact = profileLoadResult();
  ipc.invokeResult = {
    ...exact,
    endpointDiscovery: {
      statuses: [
        {
          ...exact.endpointDiscovery.statuses[0],
          nativePath: "PRIVATE_NATIVE_PATH",
        },
        exact.endpointDiscovery.statuses[1],
      ],
    },
  };
  const malformedDiscovery = await bridge.loadDirectSessionProfile(catalogDefaultRequest);
  ipc.invokeResult = {
    ...profileLoadResult(),
    nativeCatalog: "PRIVATE_NATIVE_CATALOG",
  };
  const extraShape = await bridge.loadDirectSessionProfile(catalogDefaultRequest);
  ipc.invokeThrows = true;
  const thrown = await bridge.loadDirectSessionProfile(catalogDefaultRequest);

  assert.deepEqual(malformed, profileUnavailable());
  assert.deepEqual(malformedDiscovery, profileUnavailable());
  assert.deepEqual(extraShape, profileUnavailable());
  assert.deepEqual(thrown, profileUnavailable());
  assert.notEqual(malformed, thrown);
  assert.equal(Object.isFrozen(malformed), true);
  assert.equal(malformed.ok ? false : Object.isFrozen(malformed.error), true);
  assert.equal(
    JSON.stringify({ malformed, malformedDiscovery, extraShape, thrown }).includes(
      "PRIVATE_",
    ),
    false,
  );
});

test("preload preserves the exact Runtime-not-located sidecar and rejects undeclared result keys", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  ipc.invokeResult = runtimeNotLocated();

  const result = await bridge.loadDirectSessionProfile(catalogDefaultRequest);
  ipc.invokeResult = {
    ...runtimeNotLocated(),
    candidate: "PRIVATE_CANDIDATE",
    environment: "PRIVATE_ENVIRONMENT",
    nativeError: "PRIVATE_NATIVE_ERROR",
  };
  const malformed = await bridge.loadDirectSessionProfile(catalogDefaultRequest);

  assert.deepEqual(result, runtimeNotLocated());
  assert.deepEqual(malformed, profileUnavailable());
  assert.equal(JSON.stringify({ result, malformed }).includes("PRIVATE"), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.endpointDiscovery.statuses), true);
  assert.equal(result.ok ? false : Object.isFrozen(result.error), true);
});

test("preload carries one exact snapshot-scoped Project key and sanitizes the selection result", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const request = {
    selectionKey:
      "project-selection:00000000-0000-4000-8000-000000000021",
  };
  ipc.invokeResult = {
    ok: true,
    status: "selected",
    message: "Project was opened.",
    durableRecordKey: "PRIVATE_DURABLE_RECORD",
    databasePath: "PRIVATE_DATABASE_PATH",
  };

  const result = await bridge.selectProject(request);
  assert.deepEqual(result, {
    ok: true,
    status: "selected",
    message: "Project was opened.",
  });
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_SELECT_PROJECT_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.equal(Object.isFrozen(result), true);
});

test("preload hides a Project history through one exact rotating capability", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const request = {
    historyKey: "project-history:00000000-0000-4000-8000-000000000081",
  };
  ipc.invokeResult = { status: "hidden" };
  assert.deepEqual(await bridge.hideProjectHistory(request), {
    status: "hidden",
  });
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_HIDE_PROJECT_HISTORY_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);

  const hideUnknown = bridge.hideProjectHistory as (
    value: unknown,
  ) => Promise<WorkbenchProjectHistoryHideResult>;
  assert.deepEqual(
    await hideUnknown({ ...request, ledgerSlot: "PRIVATE_LEDGER_SLOT" }),
    { status: "invalid-selection" },
  );
  assert.equal(ipc.invocations.length, 1);
  ipc.invokeResult = { status: "hidden", deleted: true };
  assert.deepEqual(await bridge.hideProjectHistory(request), {
    status: "unavailable",
  });
  ipc.invokeThrows = true;
  assert.deepEqual(await bridge.hideProjectHistory(request), {
    status: "unavailable",
  });
});

test("preload exposes exact Session and Project removal capabilities and sanitizes every result", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const sessionRequest = {
    removalKey:
      "session-removal:00000000-0000-4000-8000-000000000031",
  };
  const projectRequest = {
    selectionKey:
      "project-selection:00000000-0000-4000-8000-000000000032",
  };

  ipc.invokeResult = { status: "removed" };
  assert.deepEqual(await bridge.removeSession(sessionRequest), {
    status: "removed",
  });
  assert.deepEqual(await bridge.removeProject(projectRequest), {
    status: "removed",
  });
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_REMOVE_SESSION_CHANNEL, values: [sessionRequest] },
    { channel: WORKBENCH_REMOVE_PROJECT_CHANNEL, values: [projectRequest] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], sessionRequest);
  assert.notEqual(ipc.invocations[1]?.values[0], projectRequest);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);
  assert.equal(Object.isFrozen(ipc.invocations[1]?.values[0]), true);

  const removeSessionUnknown = bridge.removeSession as (
    request: unknown,
  ) => Promise<WorkbenchSessionRemovalResult>;
  const removeProjectUnknown = bridge.removeProject as (
    request: unknown,
  ) => Promise<WorkbenchProjectRemovalResult>;
  assert.deepEqual(
    await removeSessionUnknown({ ...sessionRequest, sessionId: "PRIVATE_ID" }),
    { status: "not-found" },
  );
  assert.deepEqual(
    await removeProjectUnknown({ ...projectRequest, directory: "C:\\private" }),
    { status: "invalid-selection" },
  );
  assert.equal(ipc.invocations.length, 2);

  ipc.invokeResult = { status: "blocked", activity: "in-flight" };
  assert.deepEqual(await bridge.removeSession(sessionRequest), {
    status: "blocked",
    activity: "in-flight",
  });
  ipc.invokeResult = { status: "removed", privateValue: "PRIVATE_NATIVE" };
  assert.deepEqual(await bridge.removeProject(projectRequest), {
    status: "unavailable",
  });
  ipc.invokeThrows = true;
  assert.deepEqual(await bridge.removeSession(sessionRequest), {
    status: "unavailable",
  });
  assert.equal(
    JSON.stringify({ bridge: Object.keys(bridge), invocations: ipc.invocations }).includes(
      "PRIVATE_NATIVE",
    ),
    false,
  );
});

test("preload carries only one exact Session-metadata capability and canonical operation", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const metadataKey =
    "session-metadata:00000000-0000-4000-8000-000000000073";
  ipc.invokeResult = {
    status: "renamed",
    nativeSessionId: "PRIVATE_NATIVE_SESSION",
  };

  assert.deepEqual(
    await bridge.mutateSessionMetadata({
      metadataKey,
      operation: { kind: "rename", displayName: "  Cafe\u0301 工程  " },
    }),
    { status: "unavailable" },
    "an extra result member fails closed",
  );
  assert.deepEqual(ipc.invocations, [
    {
      channel: WORKBENCH_MUTATE_SESSION_METADATA_CHANNEL,
      values: [
        {
          metadataKey,
          operation: { kind: "rename", displayName: "Café 工程" },
        },
      ],
    },
  ]);

  ipc.invokeResult = { status: "archived" };
  assert.deepEqual(
    await bridge.mutateSessionMetadata({
      metadataKey,
      operation: { kind: "archive" },
    }),
    { status: "archived" },
  );
  const invokeUnknown = bridge.mutateSessionMetadata as unknown as (
    value: unknown,
  ) => Promise<WorkbenchSessionMetadataMutationResult>;
  const invocationCount = ipc.invocations.length;
  for (const malformed of [
    { metadataKey: "session-metadata:forged", operation: { kind: "archive" } },
    { metadataKey, operation: { kind: "archive" }, sessionId: "PRIVATE_ID" },
    { metadataKey, operation: { kind: "archive", extra: true } },
    { metadataKey, operation: { kind: "rename", displayName: " " } },
    new Proxy({ metadataKey, operation: { kind: "restore" as const } }, {}),
  ]) {
    assert.deepEqual(await invokeUnknown(malformed), { status: "unavailable" });
  }
  assert.equal(ipc.invocations.length, invocationCount);
  ipc.invokeThrows = true;
  assert.deepEqual(
    await bridge.mutateSessionMetadata({
      metadataKey,
      operation: { kind: "restore" },
    }),
    { status: "unavailable" },
  );
  assert.equal(
    JSON.stringify({ invocations: ipc.invocations }).includes("PRIVATE_"),
    false,
  );
});

test("preload rejects forged, path-bearing, durable, ledger, and extra Project selections before IPC", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const selectUnknown = bridge.selectProject as (
    request: unknown,
  ) => Promise<WorkbenchProjectSelectionResult>;
  const key =
    "project-selection:00000000-0000-4000-8000-000000000022";
  for (const malformed of [
    null,
    {},
    { selectionKey: "project-selection:forged" },
    { selectionKey: key, directory: "C:\\private\\Project" },
    { selectionKey: key, recordKey: "PRIVATE_DURABLE_RECORD" },
    { selectionKey: key, ledgerSlot: "PRIVATE_LEDGER_SLOT" },
    { selectionKey: key, extra: true },
  ]) {
    assert.deepEqual(await selectUnknown(malformed), {
      ok: false,
      error: {
        category: "invalid-project-selection",
        message: "Reload the Project list and choose an available Project.",
      },
    });
  }
  assert.equal(ipc.invocations.length, 0);

  ipc.invokeResult = {
    ok: false,
    error: {
      category: "project-unavailable",
      message: "PRIVATE_TRANSPORT_VALUE",
    },
  };
  const malformedResult = await bridge.selectProject({ selectionKey: key });
  assert.deepEqual(malformedResult, {
    ok: false,
    error: {
      category: "project-switch-unavailable",
      message:
        "The Project could not be opened. Keep the current Project and try again.",
    },
  });
  ipc.invokeThrows = true;
  const thrown = await bridge.selectProject({
    selectionKey:
      "project-selection:00000000-0000-4000-8000-000000000023",
  });
  assert.deepEqual(thrown, malformedResult);
  assert.equal(JSON.stringify({ malformedResult, thrown }).includes("PRIVATE_"), false);
});

test("preload invokes one fixed default-save channel and reconstructs fresh deeply frozen results", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const request = defaultRequest();
  ipc.invokeResult = {
    ok: true,
    status: "saved",
    message: "Codex Session Profile default was durably saved.",
    preferencePath: "PRIVATE_PREFERENCE_PATH",
    storedValue: "PRIVATE_STORED_VALUE",
  };

  const first = await bridge.useDirectSessionProfileAsDefault(request);
  const second = await bridge.useDirectSessionProfileAsDefault(request);

  assert.deepEqual(first, {
    ok: true,
    status: "saved",
    message: "Codex Session Profile default was durably saved.",
  });
  assert.deepEqual(second, first);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(JSON.stringify(first).includes("PRIVATE_"), false);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL, values: [request] },
    { channel: WORKBENCH_USE_PROFILE_AS_DEFAULT_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);
  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
});

test("preload prevents malformed default saves and maps malformed or thrown transport values to fixed copy", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const saveUnknown = bridge.useDirectSessionProfileAsDefault as (
    request: unknown,
  ) => Promise<WorkbenchDirectSessionProfileDefaultResult>;
  const request = defaultRequest();

  const invalid = await saveUnknown({
    ...request,
    extra: "PRIVATE_EXTRA_FIELD",
  });
  assert.deepEqual(invalid, invalidDefaultSelection());
  assert.equal(ipc.invocations.length, 0);
  assert.equal(Object.isFrozen(invalid), true);

  ipc.invokeResult = {
    ok: false,
    error: {
      category: "preference-unavailable",
      message: "PRIVATE_TRANSPORT_VALUE",
    },
  };
  const malformed = await bridge.useDirectSessionProfileAsDefault(request);
  assert.deepEqual(malformed, preferenceUnavailable());
  assert.equal(JSON.stringify(malformed).includes("PRIVATE_"), false);
  ipc.invokeThrows = true;
  const thrown = await bridge.useDirectSessionProfileAsDefault(request);
  assert.deepEqual(thrown, preferenceUnavailable());
  assert.notEqual(malformed, thrown);
  assert.equal(Object.isFrozen(thrown), true);
  assert.equal(thrown.ok ? false : Object.isFrozen(thrown.error), true);
});

test("preload invokes one fixed submission channel and reconstructs a fresh frozen public result", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const instruction = "Start one bounded Codex Agent Session.";
  const request = profileRequest(instruction);
  ipc.invokeResult = {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
    commandId: "PRIVATE_COMMAND_IDENTIFIER",
    providerBody: "PRIVATE_NATIVE_BODY",
  };

  const first = await bridge.submitDirectInput(request);
  const second = await bridge.submitDirectInput(request);

  assert.deepEqual(first, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.deepEqual(second, first);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_SUBMIT_CHANNEL, values: [request] },
    { channel: WORKBENCH_SUBMIT_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);
  assert.equal(JSON.stringify(first).includes("PRIVATE_"), false);
  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
});

test("preload carries only a continuation selection capability and rejects forged keys locally", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
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
  const accepted = await bridge.submitDirectInput(request);
  assert.equal(accepted.ok, true);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_SUBMIT_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);

  const forged = await bridge.submitDirectInput({
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
  assert.equal(ipc.invocations.length, 1);
  assert.equal(JSON.stringify({ accepted, forged }).includes("native-value"), false);

  ipc.invokeResult = {
    ok: false,
    error: {
      category: "continuation-unavailable",
      message:
        "This Agent Session cannot be continued. Keep your draft and choose a resumable Session.",
    },
  };
  const stale = await bridge.submitDirectInput({
    ...request,
    selectionKey:
      "session-selection:00000000-0000-4000-8000-000000000012",
  });
  assert.equal(stale.ok, false);
  assert.equal(ipc.invocations.length, 2);
  assert.equal(
    JSON.stringify(stale).includes(
      "session-selection:00000000-0000-4000-8000-000000000012",
    ),
    false,
  );
});

test("preload prevents malformed input and maps malformed or thrown transport values to fixed copy", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const submitUnknown = bridge.submitDirectInput as (
    request: unknown,
  ) => Promise<WorkbenchSubmissionResult>;

  const invalid = await submitUnknown({ text: "PRIVATE_INPUT" });
  assert.deepEqual(invalid, {
    ok: false,
    error: {
      category: "invalid-profile-selection",
      message:
        "Reload Codex Session Profile options and choose a model and Work Intensity.",
    },
  });
  assert.equal(ipc.invocations.length, 0);
  assert.equal(Object.isFrozen(invalid), true);
  assert.equal(invalid.ok ? false : Object.isFrozen(invalid.error), true);

  const exactStart = profileRequest("A valid explicit instruction.");
  const { kind: _kind, ...implicitStart } = exactStart;
  const invalidShapes: readonly [unknown, WorkbenchSubmissionResult][] = [
    [implicitStart, invalidProfileSelection()],
    [
      {
        ...exactStart,
        selectionKey:
          "session-selection:00000000-0000-4000-8000-000000000013",
      },
      invalidProfileSelection(),
    ],
    [
      { ...exactStart, extra: "PRIVATE_EXTRA" },
      invalidProfileSelection(),
    ],
    [
      {
        kind: "continue",
        input: "A mixed continuation.",
        selectionKey:
          "session-selection:00000000-0000-4000-8000-000000000014",
        snapshotKey: exactStart.snapshotKey,
        modelKey: exactStart.modelKey,
        workIntensityKey: exactStart.workIntensityKey,
      },
      continuationUnavailable(),
    ],
  ];
  for (const [request, expected] of invalidShapes) {
    assert.deepEqual(await submitUnknown(request), expected);
  }
  assert.equal(ipc.invocations.length, 0);

  ipc.invokeResult = {
    ok: false,
    error: {
      category: "submission-unavailable",
      message: "PRIVATE_EXCEPTION_TEXT",
    },
    event: { sender: "PRIVATE_ELECTRON_EVENT" },
  };
  const malformed = await bridge.submitDirectInput(
    profileRequest("A valid instruction."),
  );
  assert.deepEqual(malformed, fixedUnavailableSubmission());
  assert.equal(JSON.stringify(malformed).includes("PRIVATE_"), false);

  ipc.invokeThrows = true;
  const thrown = await bridge.submitDirectInput(
    profileRequest("Another valid instruction."),
  );
  assert.deepEqual(thrown, fixedUnavailableSubmission());
  assert.notEqual(malformed, thrown);
  assert.equal(Object.isFrozen(thrown), true);
  assert.equal(thrown.ok ? false : Object.isFrozen(thrown.error), true);
});

test("preload invokes interruption only for an exact opaque capability", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const request = {
    interruptKey: "turn-interrupt:00000000-0000-4000-8000-000000000071",
  };
  ipc.invokeResult = {
    ok: true,
    status: "requested",
    message: "Interrupt requested.",
  };
  const interrupt = bridge.interruptActiveTurn;
  assert.equal(typeof interrupt, "function");
  assert.deepEqual(await interrupt!(request), ipc.invokeResult);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_INTERRUPT_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);

  const invokeCount = ipc.invocations.length;
  for (const malformed of [
    { ...request, commandId: "PRIVATE_COMMAND" },
    { interruptKey: "turn-interrupt:forged" },
  ]) {
    assert.deepEqual(
      await (interrupt as (value: unknown) => Promise<unknown>)(
        malformed,
      ),
      {
        ok: false,
        error: {
          category: "invalid-interrupt",
          message: "Reload the running Agent Session and try again.",
        },
      },
    );
  }
  assert.equal(ipc.invocations.length, invokeCount);

  ipc.invokeResult = {
    ok: true,
    status: "requested",
    message: "Interrupt requested.",
    privateTurnId: "PRIVATE_TURN",
  };
  assert.deepEqual(await interrupt!(request), {
    ok: false,
    error: {
      category: "interrupt-unavailable",
      message: "Interrupt is unavailable for this turn.",
    },
  });
});

test("preload invokes same-turn guidance only for one exact opaque capability and input", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const request = {
    steerKey: "turn-steer:00000000-0000-4000-8000-000000000072",
    input: "Guide the active turn with this correction.",
  };
  ipc.invokeResult = {
    ok: true,
    status: "accepted",
    message: "Guidance was accepted into the running turn.",
  };
  const steer = bridge.steerActiveTurn;
  assert.equal(typeof steer, "function");
  assert.deepEqual(await steer!(request), ipc.invokeResult);
  assert.deepEqual(ipc.invocations, [
    { channel: WORKBENCH_STEER_CHANNEL, values: [request] },
  ]);
  assert.notEqual(ipc.invocations[0]?.values[0], request);
  assert.equal(Object.isFrozen(ipc.invocations[0]?.values[0]), true);

  const invokeCount = ipc.invocations.length;
  for (const malformed of [
    { ...request, commandId: "PRIVATE_COMMAND" },
    { ...request, steerKey: "turn-steer:forged" },
    { ...request, input: "   " },
  ]) {
    assert.deepEqual(
      await (steer as (value: unknown) => Promise<unknown>)(malformed),
      {
        ok: false,
        error: {
          category: "invalid-steer",
          message: "Reload the running Agent Session and try again.",
        },
      },
    );
  }
  assert.equal(ipc.invocations.length, invokeCount);

  ipc.invokeResult = {
    ok: true,
    status: "accepted",
    message: "Guidance was accepted into the running turn.",
    privateTurnId: "PRIVATE_TURN",
  };
  assert.deepEqual(await steer!(request), {
    ok: false,
    error: {
      category: "steer-unavailable",
      message: "Same-turn guidance is unavailable. Your draft was kept.",
    },
  });
});

test("preload exposes one frozen Project observation with an idempotent disposer", () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const results: WorkbenchHostedProjectResult[] = [];

  const dispose = bridge.observeProject((result) => results.push(result));
  ipc.emit(validResult());

  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(ipc.sent, [WORKBENCH_OBSERVE_CHANNEL]);
  assert.equal(ipc.listeners.size, 1);
  assert.equal(results.length, 1);
  assert.equal(Object.isFrozen(results[0]), true);
  assert.equal(
    results[0]?.ok ? Object.isFrozen(results[0].view.commands[0]?.session) : false,
    true,
  );

  dispose();
  dispose();
  assert.deepEqual(ipc.sent, [
    WORKBENCH_OBSERVE_CHANNEL,
    WORKBENCH_DISPOSE_CHANNEL,
  ]);
  assert.equal(ipc.listeners.size, 0);
});

test("preload fails closed on widened outer, view, Session, or event records", () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const results: WorkbenchHostedProjectResult[] = [];
  const dispose = bridge.observeProject((result) => results.push(result));

  const widenedOuter = validResult() as unknown as Record<string, unknown>;
  widenedOuter.projectDirectory = "C:\\private\\project";
  ipc.emit(widenedOuter);
  assert.equal(results.at(-1)?.ok, false);

  const widenedView = validResult() as unknown as {
    view: Record<string, unknown>;
  };
  widenedView.view.projectId = "PRIVATE_PROJECT";
  ipc.emit(widenedView);
  assert.equal(results.at(-1)?.ok, false);

  const widenedProject = validResult() as unknown as {
    view: { projectSelection: { projects: Array<Record<string, unknown>> } };
  };
  widenedProject.view.projectSelection.projects[0]!.recordKey =
    "PRIVATE_DURABLE_RECORD";
  ipc.emit(widenedProject);
  assert.equal(results.at(-1)?.ok, false);

  const widenedSession = validResult() as unknown as {
    view: { commands: Array<{ session: Record<string, unknown> }> };
  };
  widenedSession.view.commands[0]!.session.sessionId = "hidden-session-id";
  ipc.emit(widenedSession);
  assert.equal(results.at(-1)?.ok, false);

  const widenedEvent = validResult() as unknown as {
    view: {
      commands: Array<{
        session: { timeline: Array<Record<string, unknown>> };
      }>;
    };
  };
  widenedEvent.view.commands[0]!.session.timeline[0] = {
    kind: "user-message",
    text: "Exact public text",
    providerNative: "PRIVATE_NATIVE_SENTINEL",
  };
  ipc.emit(widenedEvent);
  assert.equal(results.at(-1)?.ok, false);
  assert.equal(JSON.stringify(results).includes("PRIVATE_"), false);
  dispose();
});

test("preload observation preserves exact user text and rejects an extra event key without bridge drift", () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const results: WorkbenchHostedProjectResult[] = [];
  const text = [
    "C:\\Users\\Ada\\repo\\file.ts",
    "Bearer PUBLIC-CATEGORY-TEXT",
    "<script>literal</script>",
    "# Markdown stays text",
  ].join("\n");
  const dispose = bridge.observeProject((result) => results.push(result));

  ipc.emit(validResultWithTimeline([{ kind: "user-message", text }]));
  assert.equal(results[0]?.ok, true);
  if (!results[0]?.ok) assert.fail("Expected the exact public user event.");
  const event = results[0].view.commands[0]?.session?.timeline[0];
  assert.deepEqual(event, { kind: "user-message", text });
  assert.equal(event?.kind === "user-message" ? event.text : undefined, text);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(
    Object.isFrozen(results[0].view.commands[0]?.session?.timeline),
    true,
  );

  ipc.emit(validResultWithTimeline([
    {
      kind: "user-message",
      text,
      extra: "PRIVATE_EXTRA_EVENT_FIELD",
    },
  ]));
  assert.deepEqual(results[1], {
    ok: false,
    error: {
      category: "project-view-unavailable",
      message: "Live Project data is unavailable.",
    },
  });
  assert.equal(JSON.stringify(results[1]).includes("PRIVATE_EXTRA_EVENT_FIELD"), false);
  assert.deepEqual(Object.keys(bridge).sort(), expectedWorkbenchPreloadBridgeKeys);

  dispose();
  assert.deepEqual(ipc.sent, [
    WORKBENCH_OBSERVE_CHANNEL,
    WORKBENCH_DISPOSE_CHANNEL,
  ]);
});

test("preload keeps repeated sanitized failures observable through a later valid view", async () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const results: WorkbenchHostedProjectResult[] = [];
  const dispose = bridge.observeProject((result) => results.push(result));
  ipc.invokeResult = { outcome: "created" };

  assert.deepEqual(await bridge.createProject(), { outcome: "created" });
  const failure = {
    ok: false as const,
    error: {
      category: "project-view-unavailable" as const,
      message: "Live Project data is unavailable." as const,
    },
  };
  ipc.emit(failure);
  ipc.emit(failure);
  ipc.emit(validResult());

  assert.equal(results.length, 3);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[1]?.ok, false);
  assert.equal(results[2]?.ok, true);
  assert.equal(ipc.listeners.size, 1);
  assert.deepEqual(ipc.sent, [WORKBENCH_OBSERVE_CHANNEL]);
  dispose();
  assert.equal(ipc.listeners.size, 0);
  assert.deepEqual(ipc.sent, [
    WORKBENCH_OBSERVE_CHANNEL,
    WORKBENCH_DISPOSE_CHANNEL,
  ]);
});

test("preload replacement isolates old disposers and retains a sanitized failure listener", () => {
  const ipc = new FakeProjectViewIpc();
  const bridge = createWorkbenchPreloadBridge(ipc);
  const firstResults: WorkbenchHostedProjectResult[] = [];
  const laterResults: WorkbenchHostedProjectResult[] = [];

  const firstDispose = bridge.observeProject((result) => firstResults.push(result));
  const laterDispose = bridge.observeProject((result) => laterResults.push(result));
  firstDispose();
  ipc.emit({
    ok: true,
    view: {
      project: { label: "C:\\private\\project" },
      observation: { cursor: 1, live: true },
      commands: [],
      initialSelectionKey: null,
      nativeBody: "PRIVATE_NATIVE_BODY",
    },
  });
  ipc.emit(validResult());

  assert.deepEqual(firstResults, []);
  assert.equal(laterResults.length, 2);
  assert.equal(laterResults[0]?.ok, false);
  assert.equal(laterResults[1]?.ok, true);
  assert.equal(JSON.stringify(laterResults).includes("PRIVATE_NATIVE_BODY"), false);
  assert.deepEqual(ipc.sent, [
    WORKBENCH_OBSERVE_CHANNEL,
    WORKBENCH_DISPOSE_CHANNEL,
    WORKBENCH_OBSERVE_CHANNEL,
  ]);
  assert.equal(ipc.listeners.size, 1);
  laterDispose();
  assert.equal(ipc.sent.length, 4);
  assert.equal(ipc.listeners.size, 0);
});

function validResult(): WorkbenchHostedProjectResult {
  return {
    ok: true,
    view: {
      project: { label: "Atlas Fieldnotes" },
      observation: { cursor: 2, live: true },
      commands: [
        {
          key: "command-1",
          label: "Agent Session 01",
          runtime: "Codex",
          status: "completed",
          session: {
            archived: false,
            metadataKey:
              "session-metadata:00000000-0000-4000-8000-000000000703",
            profile: {
              requested: {
                kind: "recorded",
                runtimeFamilyLabel: "Codex",
                endpointLabel: "Codex desktop",
                modelLabel: "Solution 5.6",
                workIntensityControlLabel: {
                  label: "Reasoning",
                  provenance: "runtime-catalog",
                },
                workIntensityLabel: "Maximum",
                executionModeLabel: "Single agent",
                accessModeLabel: "Full access",
              },
              effective: { kind: "unknown" },
            },
            timeline: [{ kind: "session-started" }],
            removalKey:
              "session-removal:00000000-0000-4000-8000-000000000703",
            selectionKey: null,
            resumable: false,
          },
        },
      ],
      initialSelectionKey: "command-1",
      projectSelection: {
        projects: [
          {
            label: "Atlas Fieldnotes",
            availability: "available",
            selected: true,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000005",
          },
          {
            label: "Atlas Fieldnotes",
            availability: "unreadable",
            selected: false,
            selectionKey:
              "project-selection:00000000-0000-4000-8000-000000000006",
          },
        ],
      },
    },
  };
}

function validResultWithTimeline(timeline: unknown[]): unknown {
  const result = validResult() as unknown as {
    view: {
      commands: Array<{
        session: { timeline: unknown[] };
      }>;
    };
  };
  const command = result.view.commands[0];
  assert.ok(command);
  command.session.timeline = timeline;
  return result;
}

function fixedUnavailableSubmission(): WorkbenchSubmissionResult {
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

function profileUnavailable(): WorkbenchPublicDirectSessionProfileResult {
  return {
    ok: false,
    endpointDiscovery: {
      statuses: [
        { endpointId: "codex-desktop", category: "not-inspected" },
        { endpointId: "claude-code-desktop", category: "not-inspected" },
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
      ],
    },
    error: {
      category: "runtime-not-located",
      message:
        "The Workbench could not locate either supported desktop runtime. Open Settings from the Project rail to review provider status.",
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
