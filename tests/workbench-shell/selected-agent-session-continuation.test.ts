import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type {
  WorkbenchDirectInputRequest,
  WorkbenchProjectResult,
  WorkbenchProjectView,
} from "../../src/workbench-shell/contract.ts";
import {
  createTestDirectory,
  registerTestCleanup,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";

async function createRegisteredWorkbenchBackend(
  context: TestContext,
  options: Parameters<typeof createWorkbenchBackend>[0],
) {
  const backend = await createWorkbenchBackend(options);
  registerTestClosable(context, backend);
  return backend;
}

const profile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

const chineseContinuationInput = "用中文回答一下试试";
const chineseContinuationResponse = "中文响应保持原样";

const catalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: profile.model,
      displayName: profile.model,
      effortLevels: Object.freeze([profile.effortLevel]),
      effortLevelLabels: Object.freeze([profile.effortLevel]),
    }),
    Object.freeze({
      id: "gpt-5.6-codex",
      displayName: "gpt-5.6-codex",
      effortLevels: Object.freeze(["high"]),
      effortLevelLabels: Object.freeze(["high"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const catalogAfterFrontendChange: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: "gpt-5.6-codex",
      displayName: "gpt-5.6-codex",
      effortLevels: Object.freeze(["high"]),
      effortLevelLabels: Object.freeze(["high"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

const terminalEvents: readonly NormalizedRuntimeEvent[] = Object.freeze([
  Object.freeze({ kind: "session-started" as const }),
  Object.freeze({ kind: "turn-started" as const }),
  Object.freeze({ kind: "agent-message" as const, text: "A safe public result." }),
  Object.freeze({ kind: "turn-completed" as const, status: "completed" as const }),
]);

class RecordingAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  runtimeCatalog: RuntimeCatalog = catalog;
  readonly starts: RuntimeStart[] = [];
  readonly resumes: RuntimeResume[] = [];
  readonly inputs: RuntimeInput[] = [];
  activeEffects = 0;
  maximumActiveEffects = 0;

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return structuredClone(this.runtimeCatalog);
  }

  continuationProfileCompatibility(request: {
    readonly currentProfile: SessionProfile;
    readonly requestedProfile: SessionProfile;
  }): "compatible" | "incompatible" {
    return request.currentProfile.executionMode ===
      request.requestedProfile.executionMode &&
      request.currentProfile.accessMode === request.requestedProfile.accessMode
      ? "compatible"
      : "incompatible";
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.starts.push(structuredClone(request));
    return this.binding(
      request.profile,
      `private-runtime-capability-${this.starts.length}`,
    );
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return this.binding(request.profile, request.opaqueSessionReference);
  }

  private binding(
    selectedProfile: SessionProfile,
    sessionReference: string,
  ): ResumableRuntimeBinding {
    const adapter = this;
    return {
      profile: structuredClone(selectedProfile),
      opaqueSessionReference: sessionReference,
      async send(input: RuntimeInput): Promise<void> {
        adapter.activeEffects += 1;
        adapter.maximumActiveEffects = Math.max(
          adapter.maximumActiveEffects,
          adapter.activeEffects,
        );
        adapter.inputs.push(structuredClone(input));
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        try {
          for (const event of terminalEvents) {
            yield event.kind === "agent-message" &&
              adapter.inputs.at(-1)?.text === chineseContinuationInput
              ? { ...structuredClone(event), text: chineseContinuationResponse }
              : structuredClone(event);
          }
        } finally {
          adapter.activeEffects -= 1;
        }
      },
    };
  }
}

function observeViews(
  backend: Awaited<ReturnType<typeof createWorkbenchBackend>>,
): {
  readonly dispose: () => void;
  readonly waitFor: (predicate: (view: WorkbenchProjectView) => boolean) => Promise<WorkbenchProjectView>;
} {
  const views: WorkbenchProjectView[] = [];
  const waiters = new Set<{
    readonly predicate: (view: WorkbenchProjectView) => boolean;
    readonly resolve: (view: WorkbenchProjectView) => void;
  }>();
  const dispose = backend.observeProject((result: WorkbenchProjectResult) => {
    if (!result.ok) return;
    views.push(result.view);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(result.view)) continue;
      waiters.delete(waiter);
      waiter.resolve(result.view);
    }
  });
  return {
    dispose,
    waitFor(predicate) {
      const existing = [...views].reverse().find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
}

test("the same Project starts A, continues A, then explicitly starts distinct B", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-continuation-"),
  );
  const projectDirectory = join(temporaryDirectory, "Visible Project");
  const databasePath = join(temporaryDirectory, "private-ledger.sqlite");
  const preferencePath = join(temporaryDirectory, "preferences.json");
  await mkdir(projectDirectory);

  const adapter = new RecordingAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    preferencePath,
    adapter,
  });
  const observation = observeViews(backend);
  registerTestCleanup(t, observation.dispose);

  const empty = await observation.waitFor((view) => view.commands.length === 0);
  assert.equal(empty.initialSelectionKey, null);
  const loaded = await backend.loadDirectSessionProfile();
  assert.equal(loaded.ok, true);
  assert.equal(adapter.inspectCalls, 1);
  assert.ok(loaded.ok);
  const endpoint = loaded.profile.endpoints[0]!;
  const model = endpoint.models[0]!;
  const workIntensity = model.workIntensities[0]!;
  const firstInput = "first exact user instruction";
  const followUpInput = chineseContinuationInput;
  const secondSessionInput = "second-session exact user instruction";

  assert.deepEqual(
    await backend.submitDirectInput({
      kind: "start",
      input: firstInput,
      snapshotKey: loaded.profile.snapshotKey,
      endpointKey: endpoint.key,
      modelKey: model.key,
      workIntensityKey: workIntensity.key,
      executionModeKey: endpoint.executionModes[0]!.key,
      accessModeKey: endpoint.accessModes[0]!.key,
    } as WorkbenchDirectInputRequest),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  const started = await observation.waitFor(
    (view) => view.commands.length === 1 && view.commands[0]?.status === "completed",
  );
  const visibleKey = started.commands[0]!.key;
  const firstSelectionKey = started.commands[0]!.session?.selectionKey;
  assert.match(firstSelectionKey ?? "", /^session-selection:/u);
  assert.deepEqual(started.commands[0]!.session?.timeline, [
    { kind: "user-message", text: firstInput },
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "agent-message", text: "A safe public result." },
    { kind: "turn-completed", status: "completed" },
  ]);

  if (typeof firstSelectionKey !== "string") {
    assert.fail("Expected one resumable continuation selection.");
  }
  const continuationProfile = await backend.loadDirectSessionProfile({
    kind: "continuation-session",
    selectionKey: firstSelectionKey,
  });
  assert.equal(continuationProfile.ok, true);
  assert.equal(adapter.inspectCalls, 3);
  if (!continuationProfile.ok) {
    assert.fail("Expected one exact continuation Session Profile.");
  }
  const continuationEndpoint = continuationProfile.profile.endpoints[0];
  const continuationModel = continuationEndpoint.models[1];
  const continuationWorkIntensity = continuationModel?.workIntensities[0];
  if (continuationModel === undefined || continuationWorkIntensity === undefined) {
    assert.fail("Expected an alternate continuation model and Work Intensity.");
  }
  const continuationPrefill = continuationProfile.profile.continuationPrefill;
  const continuationInspectionBaseline = adapter.inspectCalls;

  assert.deepEqual(
    await backend.submitDirectInput({
      kind: "continue",
      input: followUpInput,
      selectionKey: firstSelectionKey,
      snapshotKey: continuationProfile.profile.snapshotKey,
      endpointKey: continuationPrefill.endpointKey,
      modelKey: continuationModel.key,
      workIntensityKey: continuationWorkIntensity.key,
      executionModeKey: continuationPrefill.executionModeKey,
      accessModeKey: continuationPrefill.accessModeKey,
    }),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  const continued = await observation.waitFor(
    (view) =>
      view.commands.length === 1 &&
      view.commands[0]?.status === "completed" &&
      view.commands[0]?.session?.timeline.length ===
        (terminalEvents.length + 1) * 2,
  );
  assert.equal(continued.commands[0]!.key, visibleKey);
  assert.deepEqual(continued.commands[0]!.session?.timeline, [
    { kind: "user-message", text: firstInput },
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "agent-message", text: "A safe public result." },
    { kind: "turn-completed", status: "completed" },
    { kind: "user-message", text: followUpInput },
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "agent-message", text: chineseContinuationResponse },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.notEqual(continued.commands[0]!.session?.selectionKey, firstSelectionKey);
  assert.equal(adapter.inspectCalls, continuationInspectionBaseline);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.resumes.length, 1);
  assert.equal(adapter.inputs.length, 2);
  assert.equal(adapter.maximumActiveEffects, 1);
  assert.notDeepEqual(adapter.resumes[0]?.profile, adapter.starts[0]?.profile);
  assert.deepEqual(adapter.resumes[0]?.profile, {
    model: "gpt-5.6-codex",
    effortLevel: "high",
    executionMode: profile.executionMode,
    accessMode: profile.accessMode,
  });
  assert.equal(adapter.resumes[0]?.projectDirectory, adapter.starts[0]?.projectDirectory);
  assert.equal(
    adapter.resumes[0]?.opaqueSessionReference,
    "private-runtime-capability-1",
  );

  const freshStartProfile = await backend.loadDirectSessionProfile();
  if (!freshStartProfile.ok) {
    assert.fail("Expected a fresh catalog for the distinct Session.");
  }
  assert.equal(adapter.inspectCalls, continuationInspectionBaseline + 1);
  const secondEndpoint = freshStartProfile.profile.endpoints[0]!;
  const secondModel = secondEndpoint.models[1]!;
  const secondWorkIntensity = secondModel.workIntensities[0]!;
  const secondStartInspectionBaseline = adapter.inspectCalls;

  assert.deepEqual(
    await backend.submitDirectInput({
      kind: "start",
      input: secondSessionInput,
      snapshotKey: freshStartProfile.profile.snapshotKey,
      endpointKey: secondEndpoint.key,
      modelKey: secondModel.key,
      workIntensityKey: secondWorkIntensity.key,
      executionModeKey: secondEndpoint.executionModes[0]!.key,
      accessModeKey: secondEndpoint.accessModes[0]!.key,
    }),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  const withSecondSession = await observation.waitFor(
    (view) =>
      view.commands.length === 2 &&
      view.commands.every((command) => command.status === "completed"),
  );
  const stableFirst = withSecondSession.commands.find(
    (command) => command.key === visibleKey,
  );
  const distinctSecond = withSecondSession.commands.find(
    (command) => command.key !== visibleKey,
  );
  assert.deepEqual(
    stableFirst?.session?.timeline,
    continued.commands[0]!.session?.timeline,
  );
  assert.deepEqual(
    stableFirst?.session?.profile,
    projectedProfile("gpt-5.6-codex", "high"),
  );
  assert.notEqual(distinctSecond, undefined);
  assert.deepEqual(distinctSecond?.session?.timeline, [
    { kind: "user-message", text: secondSessionInput },
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "agent-message", text: "A safe public result." },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.deepEqual(
    distinctSecond?.session?.profile,
    projectedProfile("gpt-5.6-codex", "high"),
  );
  assert.equal(adapter.inspectCalls, secondStartInspectionBaseline + 1);
  assert.equal(adapter.starts.length, 2);
  assert.equal(adapter.resumes.length, 1);
  assert.deepEqual(
    adapter.inputs.map((input) => input.text),
    [firstInput, followUpInput, secondSessionInput],
  );
  assert.equal(adapter.maximumActiveEffects, 1);

  const callsBeforeStale = {
    inspect: adapter.inspectCalls,
    start: adapter.starts.length,
    resume: adapter.resumes.length,
    input: adapter.inputs.length,
  };
  const stale = await backend.submitDirectInput({
    kind: "continue",
    input: "private stale follow-up",
    selectionKey: firstSelectionKey,
    snapshotKey: continuationProfile.profile.snapshotKey,
    endpointKey: continuationPrefill.endpointKey,
    modelKey: continuationModel.key,
    workIntensityKey: continuationWorkIntensity.key,
    executionModeKey: continuationPrefill.executionModeKey,
    accessModeKey: continuationPrefill.accessModeKey,
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(
    {
      inspect: adapter.inspectCalls,
      start: adapter.starts.length,
      resume: adapter.resumes.length,
      input: adapter.inputs.length,
    },
    callsBeforeStale,
  );

  const publicBoundary = JSON.stringify({
    empty,
    started,
    continued,
    withSecondSession,
    stale,
  });
  for (const forbidden of [
    "private stale follow-up",
    "private-runtime-capability-1",
    "private-runtime-capability-2",
    projectDirectory,
    databasePath,
    "commandId",
    "sessionId",
    "acceptedCursor",
    "idempotency",
  ]) {
    assert.equal(publicBoundary.includes(forbidden), false, forbidden);
  }
});

test("a legacy Session without a durable native identity stays unavailable when its catalog entry disappears", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-catalog-change-"),
  );
  const projectDirectory = join(temporaryDirectory, "Visible Project");
  const databasePath = join(temporaryDirectory, "private-ledger.sqlite");
  const preferencePath = join(temporaryDirectory, "preferences.json");
  await mkdir(projectDirectory);

  const creationAdapter = new RecordingAdapter();
  const creationBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    preferencePath,
    adapter: creationAdapter,
  });
  const creationObservation = observeViews(creationBackend);
  try {
    await creationObservation.waitFor((view) => view.commands.length === 0);
    const loaded = await creationBackend.loadDirectSessionProfile();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) assert.fail("Expected the creation catalog.");
    const endpoint = loaded.profile.endpoints[0]!;
    const model = endpoint.models[0]!;
    const workIntensity = model.workIntensities[0]!;
    assert.deepEqual(
      await creationBackend.submitDirectInput({
        kind: "start",
        input: "persist this exact Agent Session",
        snapshotKey: loaded.profile.snapshotKey,
        endpointKey: endpoint.key,
        modelKey: model.key,
        workIntensityKey: workIntensity.key,
        executionModeKey: endpoint.executionModes[0]!.key,
        accessModeKey: endpoint.accessModes[0]!.key,
      }),
      {
        ok: true,
        status: "accepted",
        message: "Direct input was durably accepted.",
      },
    );
    await creationObservation.waitFor(
      (view) => view.commands.length === 1 && view.commands[0]?.status === "completed",
    );
  } finally {
    creationObservation.dispose();
    await creationBackend.close();
  }

  const continuationAdapter = new RecordingAdapter();
  continuationAdapter.runtimeCatalog = catalogAfterFrontendChange;
  const continuationBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    preferencePath,
    adapter: continuationAdapter,
  });
  const continuationObservation = observeViews(continuationBackend);
  try {
    const reopened = await continuationObservation.waitFor(
      (view) => view.commands.length === 1 && view.commands[0]?.status === "completed",
    );
    const selectionKey = reopened.commands[0]?.session?.selectionKey;
    if (typeof selectionKey !== "string") {
      assert.fail("Expected the persisted Agent Session to remain selectable.");
    }
    const loaded = await continuationBackend.loadDirectSessionProfile({
      kind: "continuation-session",
      selectionKey,
    });
    assert.equal(
      loaded.ok,
      false,
      "an old opaque selection is not enough to guess a removed native identity",
    );
    assert.equal(continuationAdapter.resumes.length, 0);
  } finally {
    continuationObservation.dispose();
    await continuationBackend.close();
  }
});

function projectedProfile(modelLabel: string, workIntensityLabel: string) {
  return {
    requested: {
      kind: "recorded",
      runtimeFamilyLabel: "Codex",
      endpointLabel: "Codex desktop",
      modelLabel,
      workIntensityControlLabel: {
        label: null,
        provenance: "not-recorded",
      },
      workIntensityLabel,
      executionModeLabel: "Single agent",
      accessModeLabel: "Full access",
    },
    effective: { kind: "unknown" },
  };
}
