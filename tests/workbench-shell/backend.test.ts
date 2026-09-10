import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import type {
  AgentRuntimeAdapter,
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  RuntimeBinding,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import type {
  WorkbenchDirectInputRequest,
  WorkbenchCatalogDefaultProfileResult,
  WorkbenchDirectSessionProfileResult,
  WorkbenchProjectResult,
  WorkbenchDirectSessionProfileDefaultRequest,
  WorkbenchDirectSessionProfileDefaultResult,
  WorkbenchRuntimeEndpointDiscovery,
  WorkbenchRuntimeEndpointDiscoveryCategory,
  WorkbenchSubmissionResult,
} from "../../src/workbench-shell/contract.ts";
import { WORKBENCH_DIRECT_INPUT_MAX_LENGTH as maxInputLength } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import type {
  DirectSessionProfileDefaultPreference,
  DirectSessionProfilePreferenceSnapshot,
  DirectSessionProfilePreferenceStore,
} from "../../src/workbench-shell/preference-store.ts";
import { createDirectSessionProfilePreferenceStore } from "../../src/workbench-shell/preference-store.ts";
import {
  createTestDirectory,
  registerTestCleanup,
  registerTestClosable,
} from "../helpers/test-lifecycle.ts";
import { dissimilarNeutralEndpointFixtures } from "./fixtures/neutral-public-contract-fixtures.ts";

async function createRegisteredWorkbenchBackend(
  context: TestContext,
  options: Parameters<typeof createWorkbenchBackend>[0],
) {
  const backend = await createWorkbenchBackend(options);
  registerTestClosable(context, backend);
  return backend;
}

class LaunchDetectingAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    throw new Error("RUNTIME_LAUNCH_PATH_REACHED");
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("RUNTIME_LAUNCH_PATH_REACHED");
  }
}

class CatalogOnlyAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "codex",
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          effortLevels: ["low", "ultra"],
          effortLevelLabels: ["low", "ultra"],
        },
        {
          id: "gpt-5.6-codex",
          displayName: "gpt-5.6-codex",
          effortLevels: ["medium", "high"],
          effortLevelLabels: ["medium", "high"],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class AlternateVocabularyCatalogAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "alternate-runtime",
      models: [
        {
          id: "model-native-v2",
          resolvedModel: "model-resolved[1m]",
          displayName: "Runtime Model Deluxe",
          workIntensityLabel: "Reasoning Budget",
          effortLevels: ["native-burst", "x-high", "native-max"],
          effortLevelLabels: ["Quick scan", "Deep focus", "Complete review"],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    } as RuntimeCatalog;
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class NativeOnlyCatalogAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  private readonly structuralDefect: "missing-access-modes" | undefined;

  constructor(
    structuralDefect?: "missing-access-modes",
  ) {
    this.structuralDefect = structuralDefect;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    const catalog = sparseNativeOnlyCatalog();
    if (this.structuralDefect === "missing-access-modes") {
      const { accessModes: _missing, ...malformed } = catalog;
      return malformed as RuntimeCatalog;
    }
    return catalog;
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class RawCatalogAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  private readonly catalog: unknown;

  constructor(catalog: unknown) {
    this.catalog = catalog;
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return this.catalog as RuntimeCatalog;
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

function sparseNativeOnlyCatalog(): RuntimeCatalog {
  return {
    runtime: "codex",
    models: [
      {
        id: "native-model-only",
        effortLevels: ["x-high", "native_max"],
      },
    ],
    executionModes: ["single-agent"],
    accessModes: ["full-access"],
  };
}

class LargeCatalogAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "codex",
      models: Array.from({ length: 101 }, (_, index) => ({
        id: `model-${String(index + 1).padStart(3, "0")}`,
        displayName: `model-${String(index + 1).padStart(3, "0")}`,
        effortLevels: ["low"],
        effortLevelLabels: ["low"],
      })),
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class RuntimeNotLocatedAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    throw new RuntimeAdapterError("runtime-not-located");
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class HeldCatalogLoadAdapter extends CatalogOnlyAdapter {
  private releaseInspection!: () => void;
  readonly inspectionHeld = new Promise<void>((resolve) => {
    this.releaseInspection = resolve;
  });

  release(): void {
    this.releaseInspection();
  }

  override async inspect(projectDirectory: string): Promise<RuntimeCatalog> {
    if (this.inspectCalls === 0) await this.inspectionHeld;
    return super.inspect(projectDirectory);
  }
}

class IndependentlyHeldCatalogAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  private releaseFirstInspection!: () => void;
  private releaseSecondInspection!: () => void;
  private markFirstInspectionStarted!: () => void;
  private markSecondInspectionStarted!: () => void;
  private readonly firstInspectionHeld = new Promise<void>((resolve) => {
    this.releaseFirstInspection = resolve;
  });
  private readonly secondInspectionHeld = new Promise<void>((resolve) => {
    this.releaseSecondInspection = resolve;
  });
  readonly firstInspectionStarted = new Promise<void>((resolve) => {
    this.markFirstInspectionStarted = resolve;
  });
  readonly secondInspectionStarted = new Promise<void>((resolve) => {
    this.markSecondInspectionStarted = resolve;
  });

  releaseFirst(): void {
    this.releaseFirstInspection();
  }

  releaseSecond(): void {
    this.releaseSecondInspection();
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (this.inspectCalls === 1) {
      this.markFirstInspectionStarted();
      await this.firstInspectionHeld;
    } else if (this.inspectCalls === 2) {
      this.markSecondInspectionStarted();
      await this.secondInspectionHeld;
    }
    return {
      runtime: "codex",
      models: [
        {
          id: fixedProfile.model,
          displayName: fixedProfile.model,
          effortLevels: [fixedProfile.effortLevel],
          effortLevelLabels: [fixedProfile.effortLevel],
        },
      ],
      executionModes: [fixedProfile.executionMode],
      accessModes: [fixedProfile.accessMode],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class UnavailableDefaultAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "codex",
      models: [
        {
          id: "gpt-5.6-codex",
          displayName: "gpt-5.6-codex",
          effortLevels: ["high"],
          effortLevelLabels: ["high"],
        },
        {
          id: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          effortLevels: ["low"],
          effortLevelLabels: ["low"],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class FailedRefreshAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (this.inspectCalls === 2) throw new Error("PRIVATE_REFRESH_FAILURE");
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

  async start(request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    return {
      profile: { ...request.profile },
      async send() {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class HeldSuccessfulAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  readonly starts: RuntimeStart[] = [];
  readonly sent: string[] = [];
  private releaseInspection!: () => void;
  private markInspectionStarted!: () => void;
  readonly inspectionHeld = new Promise<void>((resolve) => {
    this.releaseInspection = resolve;
  });
  readonly inspectionStarted = new Promise<void>((resolve) => {
    this.markInspectionStarted = resolve;
  });

  release(): void {
    this.releaseInspection();
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (this.inspectCalls === 2) {
      this.markInspectionStarted();
      await this.inspectionHeld;
    }
    return {
      runtime: "codex",
      models: [
        {
          id: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          effortLevels: ["low", "ultra"],
          effortLevelLabels: ["low", "ultra"],
        },
        {
          id: "gpt-5.6-codex",
          displayName: "gpt-5.6-codex",
          effortLevels: ["medium", "high"],
          effortLevelLabels: ["medium", "high"],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    this.starts.push(cloneProfileStart(request));
    const sent = this.sent;
    return {
      profile: { ...request.profile },
      opaqueSessionReference: "held-successful-session-reference",
      async send(input) {
        sent.push(input.text);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "item-started", itemType: "agent-message" };
        yield { kind: "item-completed", itemType: "agent-message" };
        yield { kind: "agent-message", text: "FIXED_TEST_COMPLETION" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class InterruptibleBackendAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  interruptCalls = 0;
  readonly steerCalls: string[] = [];
  private turnStarted = false;
  private releaseTerminal!: () => void;
  private readonly terminalReleased = new Promise<void>((resolve) => {
    this.releaseTerminal = resolve;
  });

  release(): void {
    this.releaseTerminal();
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "codex",
      models: [{
        id: fixedProfile.model,
        displayName: fixedProfile.model,
        effortLevels: [fixedProfile.effortLevel],
        effortLevelLabels: [fixedProfile.effortLevel],
      }],
      executionModes: [fixedProfile.executionMode],
      accessModes: [fixedProfile.accessMode],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    const adapter = this;
    return {
      profile: { ...request.profile },
      opaqueSessionReference: "private-interruptible-backend-session",
      async send(): Promise<void> {},
      steerAvailability() {
        return adapter.turnStarted ? "available" : "unavailable";
      },
      async steer(input): Promise<void> {
        adapter.steerCalls.push(input.text);
      },
      interruptAvailability() {
        return adapter.turnStarted ? "available" : "unavailable";
      },
      async interrupt(): Promise<void> {
        adapter.interruptCalls += 1;
        adapter.releaseTerminal();
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        adapter.turnStarted = true;
        yield { kind: "turn-started" };
        await adapter.terminalReleased;
        yield { kind: "turn-interrupted", status: "interrupted" };
      },
    };
  }

  async resume(): Promise<ResumableRuntimeBinding> {
    throw new Error("PRIVATE_RESUME_MUST_NOT_RUN");
  }
}

class HeldReplacementProfileAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  resumeCalls = 0;
  readonly sent: string[] = [];
  private releaseReplacementInspection!: () => void;
  private markReplacementInspectionStarted!: () => void;
  private readonly replacementInspectionHeld = new Promise<void>((resolve) => {
    this.releaseReplacementInspection = resolve;
  });
  readonly replacementInspectionStarted = new Promise<void>((resolve) => {
    this.markReplacementInspectionStarted = resolve;
  });
  private heldInspectionCall: number | undefined;

  holdNextReplacementInspection(): void {
    this.heldInspectionCall = this.inspectCalls + 1;
  }

  releaseReplacement(): void {
    this.releaseReplacementInspection();
  }

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (this.inspectCalls === this.heldInspectionCall) {
      this.markReplacementInspectionStarted();
      await this.replacementInspectionHeld;
    }
    return {
      runtime: "codex",
      models: [
        {
          id: fixedProfile.model,
          displayName: fixedProfile.model,
          effortLevels: [fixedProfile.effortLevel],
          effortLevelLabels: [fixedProfile.effortLevel],
        },
      ],
      executionModes: [fixedProfile.executionMode],
      accessModes: [fixedProfile.accessMode],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    return this.binding(request.profile, "private-start-session");
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumeCalls += 1;
    return this.binding(request.profile, request.opaqueSessionReference);
  }

  private binding(
    selectedProfile: SessionProfile,
    opaqueSessionReference: string,
  ): ResumableRuntimeBinding {
    const sent = this.sent;
    return {
      profile: { ...selectedProfile },
      opaqueSessionReference,
      async send(input) {
        sent.push(input.text);
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: "FIXED_TEST_COMPLETION" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }
}

class RecoveryBarrierAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  sendCalls = 0;
  private releaseHeldEvents!: () => void;
  private markEventsStarted!: () => void;
  readonly eventsHeld = new Promise<void>((resolve) => {
    this.releaseHeldEvents = resolve;
  });
  readonly eventsStarted = new Promise<void>((resolve) => {
    this.markEventsStarted = resolve;
  });

  release(): void {
    this.releaseHeldEvents();
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "codex",
      models: [
        {
          id: fixedProfile.model,
          displayName: fixedProfile.model,
          effortLevels: [fixedProfile.effortLevel],
          effortLevelLabels: [fixedProfile.effortLevel],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    const adapter = this;
    const shouldRecover = this.startCalls === 1;
    return {
      profile: { ...request.profile },
      opaqueSessionReference: `private-recovery-capability-${this.startCalls}`,
      async send(): Promise<void> {
        adapter.sendCalls += 1;
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        if (shouldRecover) {
          adapter.markEventsStarted();
          await adapter.eventsHeld;
          yield { kind: "session-started" };
          return;
        }
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "agent-message", text: "RECOVERY_REPLACEMENT_COMPLETED" };
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }

  async resume(): Promise<ResumableRuntimeBinding> {
    throw new Error("PRIVATE_RESUME_MUST_NOT_RUN");
  }
}

class FixedFailureAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    return {
      runtime: "claude-code",
      models: [
        {
          id: fixedProfile.model,
          displayName: fixedProfile.model,
          effortLevels: [fixedProfile.effortLevel],
          effortLevelLabels: [fixedProfile.effortLevel],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.startCalls += 1;
    return {
      profile: { ...request.profile },
      opaqueSessionReference: "private-fixed-failure-capability",
      async send(): Promise<void> {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "failed", category: "turn-failed" };
      },
    };
  }

  async resume(): Promise<ResumableRuntimeBinding> {
    throw new Error("PRIVATE_RESUME_MUST_NOT_RUN");
  }
}

class UnsupportedProfileAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (this.inspectCalls === 1) {
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
    return {
      runtime: "codex",
      models: [
        {
          id: "unsupported-model",
          displayName: "unsupported-model",
          effortLevels: ["low"],
          effortLevelLabels: ["low"],
        },
      ],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("PRIVATE_START_MUST_NOT_RUN");
  }
}

class StaticPreferenceStore implements DirectSessionProfilePreferenceStore {
  readCalls = 0;
  saveCalls = 0;
  closeCalls = 0;
  readonly savedSelections: DirectSessionProfileDefaultPreference[] = [];
  readonly snapshot: DirectSessionProfilePreferenceSnapshot;

  constructor(snapshot: DirectSessionProfilePreferenceSnapshot) {
    this.snapshot = snapshot;
  }

  async read(): Promise<DirectSessionProfilePreferenceSnapshot> {
    this.readCalls += 1;
    return this.snapshot;
  }

  async saveDefault(
    selection: DirectSessionProfileDefaultPreference,
  ): Promise<DirectSessionProfilePreferenceSnapshot> {
    this.saveCalls += 1;
    this.savedSelections.push({ ...selection });
    return this.snapshot;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FailingPreferenceStore extends StaticPreferenceStore {
  override async saveDefault(
    selection: DirectSessionProfileDefaultPreference,
  ): Promise<DirectSessionProfilePreferenceSnapshot> {
    this.saveCalls += 1;
    this.savedSelections.push({ ...selection });
    throw new Error("PRIVATE_STORE_FAILURE");
  }
}

class HeldPreferenceStore extends StaticPreferenceStore {
  private releaseSave!: () => void;
  private markSaveStarted!: () => void;
  readonly saveHeld = new Promise<void>((resolve) => {
    this.releaseSave = resolve;
  });
  readonly saveStarted = new Promise<void>((resolve) => {
    this.markSaveStarted = resolve;
  });

  release(): void {
    this.releaseSave();
  }

  override async saveDefault(
    selection: DirectSessionProfileDefaultPreference,
  ): Promise<DirectSessionProfilePreferenceSnapshot> {
    this.saveCalls += 1;
    this.savedSelections.push({ ...selection });
    this.markSaveStarted();
    await this.saveHeld;
    return this.snapshot;
  }
}

const fixedProfile: SessionProfile = Object.freeze({
  model: "gpt-5.6-sol",
  effortLevel: "ultra",
  executionMode: "single-agent",
  accessMode: "full-access",
});

test("legacy profile loading reports Codex not located and Claude not inspected without a false aggregate", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Runtime Discovery Project");
  const databasePath = join(temporaryDirectory, "runtime-discovery.sqlite");
  await mkdir(projectDirectory);
  const adapter = new RuntimeNotLocatedAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });

  const result = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.deepEqual(
    result,
    profileUnavailableResult("runtime-not-located", "not-inspected"),
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(projectDirectory), false);
  assert.equal(serialized.includes(databasePath), false);
  assert.equal(serialized.includes("PRIVATE"), false);
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.startCalls, 0);
  await backend.close();
});

test("profile loading inspects once and exposes every safe model relation with the resolved desired default", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Catalog Project");
  const databasePath = join(temporaryDirectory, "catalog.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });

  assert.equal(adapter.inspectCalls, 0);
  assert.equal(adapter.startCalls, 0);
  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.equal(loaded.ok, true);
  assert.deepEqual(
    loaded.endpointDiscovery,
    endpointDiscovery("catalog-ready", "not-inspected"),
  );
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(loaded.ok ? Object.isFrozen(loaded.profile.endpoints) : false, true);
  assert.equal(
    loaded.ok ? Object.isFrozen(loaded.profile.endpoints[0]?.models) : false,
    true,
  );
  assert.deepEqual(
    loaded.ok
      ? loaded.profile.endpoints[0]?.models.map((model) => ({
          label: model.label,
          workIntensities: model.workIntensities.map((option) => option.label),
        }))
      : undefined,
    [
      { label: "GPT-5.6-Sol", workIntensities: ["low", "ultra"] },
      { label: "gpt-5.6-codex", workIntensities: ["medium", "high"] },
    ],
  );
  assert.equal(
    loaded.ok
      ? loaded.profile.endpoints.every((endpoint) =>
          endpoint.models.every((model) =>
            model.workIntensities.every(
              (option) => !("impliedExecutionModeKey" in option),
            ),
          ),
        )
      : false,
    true,
  );
  assert.deepEqual(
    loaded.ok
      ? {
          endpoint: loaded.profile.endpoints[0],
          desiredDefault: loaded.profile.desiredDefault,
        }
      : undefined,
    loaded.ok
      ? {
          endpoint: {
            endpointId: "codex-desktop",
            key: loaded.profile.endpoints[0]?.key,
            runtimeFamilyLabel: "Codex",
            endpointLabel: "Codex desktop",
            models: loaded.profile.endpoints[0]?.models,
            executionModes: loaded.profile.endpoints[0]?.executionModes,
            accessModes: loaded.profile.endpoints[0]?.accessModes,
          },
          desiredDefault: {
            kind: "resolved",
            endpointKey: loaded.profile.endpoints[0]?.key,
            modelKey: loaded.profile.endpoints[0]?.models[0]?.key,
            workIntensityKey:
              loaded.profile.endpoints[0]?.models[0]?.workIntensities[1]?.key,
            executionModeKey:
              loaded.profile.endpoints[0]?.executionModes[0]?.key,
            accessModeKey: loaded.profile.endpoints[0]?.accessModes[0]?.key,
          },
        }
      : undefined,
  );
  const serialized = JSON.stringify(loaded);
  assert.equal(serialized.includes("PRIVATE_NATIVE_PAYLOAD"), false);
  assert.equal(serialized.includes(projectDirectory), false);
  assert.equal(serialized.includes(databasePath), false);
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.startCalls, 0);
  assert.deepEqual(Object.keys(backend).sort(), [
    "close",
    "interruptActiveTurn",
    "loadDirectSessionProfile",
    "mutateSessionMetadata",
    "observeProject",
    "observeUserInput",
    "readTurnActivity",
    "readUserInput",
    "removeSession",
    "respondToUserInput",
    "steerActiveTurn",
    "submitDirectInput",
    "useDirectSessionProfileAsDefault",
  ]);
  await backend.close();
});

test("profile loading carries a second Runtime's exact display wording, order, and option count", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Alternate Catalog Project");
  const databasePath = join(temporaryDirectory, "alternate-catalog.sqlite");
  await mkdir(projectDirectory);
  const adapter = new AlternateVocabularyCatalogAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });

  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.equal(loaded.ok, true);
  assert.deepEqual(
    loaded.endpointDiscovery,
    endpointDiscovery("catalog-ready", "not-inspected"),
  );
  assert.deepEqual(
    loaded.ok
      ? {
          runtimeFamilyLabel:
            loaded.profile.endpoints[0]?.runtimeFamilyLabel,
          endpointLabel: loaded.profile.endpoints[0]?.endpointLabel,
          models: loaded.profile.endpoints[0]?.models.map((model) => ({
            label: model.label,
            provenanceLabel: model.provenanceLabel,
            workIntensityLabel: model.workIntensityLabel,
            workIntensities: model.workIntensities.map((option) => option.label),
          })),
        }
      : undefined,
    {
      runtimeFamilyLabel: "Codex",
      endpointLabel: "Codex desktop",
      models: [
        {
          label: "model-resolved[1m]",
          provenanceLabel: "Runtime Model Deluxe",
          workIntensityLabel: "Reasoning Budget",
          workIntensities: ["native-burst", "x-high", "native-max"],
        },
      ],
    },
  );
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.startCalls, 0);
  await backend.close();
});

test("profile loading exposes each dissimilar fake Runtime as one endpoint-first display relation", async (t) => {
  const fixtures = dissimilarNeutralEndpointFixtures();
  const observed: unknown[] = [];

  for (const [index, fixture] of fixtures.entries()) {
    const temporaryDirectory = await createTestDirectory(
      t,
      join(tmpdir(), "workbench-neutral-endpoint-"),
    );
    const projectDirectory = join(temporaryDirectory, `Endpoint Project ${index + 1}`);
    await mkdir(projectDirectory);
    const backend = await createRegisteredWorkbenchBackend(t, {
      projectDirectory,
      databasePath: join(temporaryDirectory, "endpoint.sqlite"),
      adapter: fixture.adapter,
      directEndpointPresentation: Object.freeze({
        preferenceKey: fixture.preferenceKey,
        runtimeFamilyLabel: fixture.runtimeFamilyLabel,
        endpointLabel: fixture.endpointLabel,
      }),
    });

    const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
    assert.equal(loaded.ok, true);
    const profile = loaded.ok
      ? (loaded.profile as unknown as {
          readonly endpoints?: readonly {
            readonly runtimeFamilyLabel: string;
            readonly endpointLabel: string;
            readonly models: readonly {
              readonly label: string;
              readonly provenanceLabel: string | null;
              readonly workIntensityLabel: string | null;
              readonly workIntensities: readonly {
                readonly label: string;
                readonly impliedExecutionModeKey?: string;
              }[];
            }[];
            readonly executionModes: readonly {
              readonly key: string;
              readonly label: string;
            }[];
          }[];
        })
      : undefined;
    observed.push(
      profile?.endpoints?.map((endpoint) => ({
        runtimeFamilyLabel: endpoint.runtimeFamilyLabel,
        endpointLabel: endpoint.endpointLabel,
        executionModes: endpoint.executionModes.map((option) => option.label),
        models: endpoint.models.map((model) => ({
          label: model.label,
          provenanceLabel: model.provenanceLabel,
          workIntensityLabel: model.workIntensityLabel,
          workIntensities: model.workIntensities.map((option) => ({
            label: option.label,
            impliedExecutionModeLabel:
              option.impliedExecutionModeKey === undefined
                ? null
                : endpoint.executionModes.find(
                    (executionMode) =>
                      executionMode.key === option.impliedExecutionModeKey,
                  )?.label,
          })),
        })),
      })),
    );
    await backend.close();
  }

  assert.deepEqual(observed, [
    [
      {
        runtimeFamilyLabel: "Quartz Runtime",
        endpointLabel: "Quartz Studio",
        executionModes: ["Single agent", "coordinated-workflow"],
        models: [
          {
            label: "Shared Compass",
            provenanceLabel: "Shared Compass",
            workIntensityLabel: "Deliberation",
            workIntensities: [
              {
                label: "q-brief",
                impliedExecutionModeLabel: null,
              },
              {
                label: "q-deep",
                impliedExecutionModeLabel: "coordinated-workflow",
              },
            ],
          },
        ],
      },
    ],
    [
      {
        runtimeFamilyLabel: "Nimbus Runtime",
        endpointLabel: "Nimbus Relay",
        executionModes: ["Single agent"],
        models: [
          {
            label: "Shared Compass",
            provenanceLabel: "Shared Compass",
            workIntensityLabel: null,
            workIntensities: [
              { label: "n-glance", impliedExecutionModeLabel: null },
              { label: "n-review", impliedExecutionModeLabel: null },
              { label: "n-exhaustive", impliedExecutionModeLabel: null },
            ],
          },
        ],
      },
    ],
  ]);
});

test("two fake endpoints resolve independent defaults from one endpoint-keyed version 2 file", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-neutral-defaults-"),
  );
  const projectDirectory = join(temporaryDirectory, "Endpoint Default Project");
  const preferencePath = join(temporaryDirectory, "endpoint-defaults.json");
  await mkdir(projectDirectory);
  const fixtures = dissimilarNeutralEndpointFixtures();
  const preferenceStore = createDirectSessionProfilePreferenceStore({
    filePath: preferencePath,
  });
  registerTestClosable(t, preferenceStore);
  const selectedEffortIndexes = [1, 2] as const;
  for (const [index, fixture] of fixtures.entries()) {
    const model = fixture.adapter.catalog.models[0]!;
    await preferenceStore.saveDefault({
      endpointKey: fixture.preferenceKey,
      model: model.id,
      workIntensity: model.effortLevels[selectedEffortIndexes[index]!]!,
    });
  }
  await preferenceStore.close();

  const resolved: unknown[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const backend = await createRegisteredWorkbenchBackend(t, {
      projectDirectory,
      databasePath: join(temporaryDirectory, `endpoint-${index + 1}.sqlite`),
      preferencePath,
      adapter: fixture.adapter,
      directEndpointPresentation: Object.freeze({
        preferenceKey: fixture.preferenceKey,
        runtimeFamilyLabel: fixture.runtimeFamilyLabel,
        endpointLabel: fixture.endpointLabel,
      }),
    });
    const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
    if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
      assert.fail("Expected the endpoint-specific default to resolve.");
    }
    const desired = loaded.profile.desiredDefault;
    const endpoint = loaded.profile.endpoints.find(
      (candidate) => candidate.key === desired.endpointKey,
    );
    const model = endpoint?.models.find(
      (candidate) => candidate.key === desired.modelKey,
    );
    const intensity = model?.workIntensities.find(
      (candidate) => candidate.key === desired.workIntensityKey,
    );
    const executionMode = endpoint?.executionModes.find(
      (candidate) => candidate.key === desired.executionModeKey,
    );
    resolved.push({
      endpointLabel: endpoint?.endpointLabel,
      modelLabel: model?.label,
      workIntensityLabel: intensity?.label,
      executionModeLabel: executionMode?.label,
    });
    if (index === 0) {
      assert.deepEqual(
        await backend.useDirectSessionProfileAsDefault({
          snapshotKey: loaded.profile.snapshotKey,
          modelKey: desired.modelKey,
          workIntensityKey: desired.workIntensityKey,
        }),
        {
          ok: true,
          status: "saved",
          message: "Session Profile default was durably saved.",
        },
      );
    }
    await backend.close();
  }

  assert.deepEqual(resolved, [
    {
      endpointLabel: "Quartz Studio",
      modelLabel: "Shared Compass",
      workIntensityLabel: "q-deep",
      executionModeLabel: "coordinated-workflow",
    },
    {
      endpointLabel: "Nimbus Relay",
      modelLabel: "Shared Compass",
      workIntensityLabel: "n-exhaustive",
      executionModeLabel: "Single agent",
    },
  ]);
  const persisted = JSON.parse(await readFile(preferencePath, "utf8")) as {
    readonly schemaVersion: unknown;
    readonly endpoints: Record<string, unknown>;
  };
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(Object.keys(persisted.endpoints), [
    fixtures[0].preferenceKey,
    fixtures[1].preferenceKey,
  ]);
  assert.equal(JSON.stringify(persisted).includes("executionMode"), false);
  assert.equal(JSON.stringify(persisted).includes("accessMode"), false);
  assert.equal(fixtures[0].adapter.startCalls, 0);
  assert.equal(fixtures[1].adapter.startCalls, 0);
});

test("profile loading distinguishes a display-sparse valid catalog from an otherwise identical malformed catalog", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Native Only Catalog Project");
  await mkdir(projectDirectory);
  const sparseAdapter = new NativeOnlyCatalogAdapter();
  const sparseBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(temporaryDirectory, "sparse-catalog.sqlite"),
    adapter: sparseAdapter,
  });
  const malformedAdapter = new NativeOnlyCatalogAdapter(
    "missing-access-modes",
  );
  const malformedBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(temporaryDirectory, "malformed-catalog.sqlite"),
    adapter: malformedAdapter,
  });

  const sparse = await sparseBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  const malformed = await malformedBackend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.deepEqual(
    {
      sparse: sparse.ok
        ? {
            endpointCount: sparse.profile.endpoints.length,
            modelLabel: sparse.profile.endpoints[0]?.models[0]?.label,
            provenanceLabel:
              sparse.profile.endpoints[0]?.models[0]?.provenanceLabel,
            workIntensityLabel:
              sparse.profile.endpoints[0]?.models[0]?.workIntensityLabel,
            workIntensityLabels:
              sparse.profile.endpoints[0]?.models[0]?.workIntensities.map(
                (option) => option.label,
              ),
          }
        : sparse,
      malformed,
    },
    {
      sparse: {
        endpointCount: 1,
        modelLabel: "native-model-only",
        provenanceLabel: null,
        workIntensityLabel: null,
        workIntensityLabels: ["x-high", "native_max"],
      },
      malformed: {
        ok: false,
        endpointDiscovery: endpointDiscovery(
          "inspection-failed",
          "not-inspected",
        ),
        error: {
          category: "profile-unavailable",
          message:
            "Codex Session Profile options are unavailable. Keep your draft and try again.",
        },
      },
    },
  );
  if (!sparse.ok) assert.fail("Expected the display-sparse catalog to render.");
  const sparseEndpoint = sparse.profile.endpoints[0]!;
  const sparseModel = sparseEndpoint.models[0]!;
  assert.equal(sparseModel.key.includes("native-model-only"), false);
  assert.equal(
    sparseModel.workIntensities.some(
      (option) => option.key.includes("x-high") || option.key.includes("native_max"),
    ),
    false,
  );
  assert.equal(sparseAdapter.inspectCalls, 1);
  assert.equal(sparseAdapter.startCalls, 0);
  assert.equal(malformedAdapter.inspectCalls, 1);
  assert.equal(malformedAdapter.startCalls, 0);
  await sparseBackend.close();
  await malformedBackend.close();
});

test("profile loading fails closed for every malformed private catalog structure", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-malformed-catalog-"),
  );
  const sparse = sparseNativeOnlyCatalog();
  const sparseModel = sparse.models[0]!;
  const { accessModes: _missingAccessModes, ...missingAccessModes } = sparse;
  const malformedCatalogs: readonly {
    readonly name: string;
    readonly value: unknown;
  }[] = [
    {
      name: "extra catalog field",
      value: { ...sparse, privateNativePayload: "PRIVATE_NATIVE_PAYLOAD" },
    },
    {
      name: "extra model field",
      value: {
        ...sparse,
        models: [{ ...sparseModel, privateModelValue: "PRIVATE_MODEL" }],
      },
    },
    {
      name: "promoListPrice must not leak past adapter normalization",
      value: {
        ...sparse,
        models: [{ ...sparseModel, promoListPrice: "$20" }],
      },
    },
    {
      name: "resolved model has an invalid structural type",
      value: {
        ...sparse,
        models: [{ ...sparseModel, resolvedModel: 42 }],
      },
    },
    {
      name: "resolved model is URL-shaped",
      value: {
        ...sparse,
        models: [
          { ...sparseModel, resolvedModel: "https://invalid.example/model" },
        ],
      },
    },
    {
      name: "resolved model is path-shaped",
      value: {
        ...sparse,
        models: [{ ...sparseModel, resolvedModel: "C:\\invalid\\model" }],
      },
    },
    {
      name: "resolved model contains bidi control text",
      value: {
        ...sparse,
        models: [{ ...sparseModel, resolvedModel: "safe\u202ereversed" }],
      },
    },
    {
      name: "unexpected model nesting",
      value: { ...sparse, models: { first: sparseModel } },
    },
    { name: "missing structural field", value: missingAccessModes },
    {
      name: "wrong structural type",
      value: { ...sparse, executionModes: "single-agent" },
    },
    {
      name: "display option count disagrees with native values",
      value: {
        ...sparse,
        models: [{ ...sparseModel, effortLevelLabels: [null] }],
      },
    },
    {
      name: "coupling names an unoffered execution mode",
      value: {
        ...sparse,
        workIntensityExecutionModeCouplings: [
          {
            model: sparseModel.id,
            workIntensity: sparseModel.effortLevels[0],
            executionMode: "coordinated-workflow",
          },
        ],
      },
    },
    {
      name: "coupling declaration has an extra field",
      value: {
        ...sparse,
        workIntensityExecutionModeCouplings: [
          {
            model: sparseModel.id,
            workIntensity: sparseModel.effortLevels[0],
            executionMode: "single-agent",
            consequence: "PRIVATE_UNRECOGNIZED_CONSEQUENCE",
          },
        ],
      },
    },
    {
      name: "coupling declaration field has an invalid structural type",
      value: {
        ...sparse,
        workIntensityExecutionModeCouplings: undefined,
      },
    },
  ];
  const unavailable = profileUnavailableResult(
    "inspection-failed",
    "not-inspected",
  );

  for (const [index, malformedCatalog] of malformedCatalogs.entries()) {
    const projectDirectory = join(temporaryDirectory, `Malformed Project ${index + 1}`);
    await mkdir(projectDirectory);
    const adapter = new RawCatalogAdapter(malformedCatalog.value);
    const backend = await createRegisteredWorkbenchBackend(t, {
      projectDirectory,
      databasePath: join(temporaryDirectory, `malformed-${index + 1}.sqlite`),
      adapter,
    });
    const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

    assert.deepEqual(loaded, unavailable, malformedCatalog.name);
    assert.equal(
      JSON.stringify(loaded).includes("PRIVATE_"),
      false,
      malformedCatalog.name,
    );
    assert.equal(adapter.inspectCalls, 1, malformedCatalog.name);
    assert.equal(adapter.startCalls, 0, malformedCatalog.name);
    await backend.close();
  }
});

test("profile loading preserves a catalog larger than the former one-hundred-model cap", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Large Catalog Project");
  const databasePath = join(temporaryDirectory, "large-catalog.sqlite");
  await mkdir(projectDirectory);
  const adapter = new LargeCatalogAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });

  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok ? loaded.profile.endpoints[0]?.models.length : 0, 101);
  assert.equal(
    loaded.ok ? loaded.profile.endpoints[0]?.models[0]?.label : undefined,
    "model-001",
  );
  assert.equal(
    loaded.ok ? loaded.profile.endpoints[0]?.models[100]?.label : undefined,
    "model-101",
  );
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.startCalls, 0);
  await backend.close();
});

test("profile loading resolves version 1 global, Codex endpoint, and selected-model layers without rewrite", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Durable Default Project");
  const databasePath = join(temporaryDirectory, "durable-default.sqlite");
  const preferencePath = join(temporaryDirectory, "durable-default.json");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const before = `${JSON.stringify({
    schemaVersion: 1,
    global: { model: "gpt-5.6-sol", workIntensity: "low" },
    codex: {
      model: "gpt-5.6-codex",
      workIntensities: [
        { model: "gpt-5.6-codex", workIntensity: "high" },
      ],
    },
  })}\n`;
  await writeFile(preferencePath, before, "utf8");
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
    preferencePath,
  });

  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.equal(loaded.ok, true);
  if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected the durable default to resolve.");
  }
  const desiredDefault = loaded.profile.desiredDefault;
  const selectedEndpoint = loaded.profile.endpoints.find(
    (endpoint) => endpoint.key === desiredDefault.endpointKey,
  );
  const selectedModel = selectedEndpoint?.models.find(
    (model) => model.key === desiredDefault.modelKey,
  );
  const selectedIntensity = selectedModel?.workIntensities.find(
    (option) => option.key === desiredDefault.workIntensityKey,
  );
  assert.deepEqual(
    {
      model: selectedModel?.label,
      workIntensity: selectedIntensity?.label,
      executionMode: selectedEndpoint?.executionModes.find(
        (option) => option.key === desiredDefault.executionModeKey,
      )?.label,
      accessMode: selectedEndpoint?.accessModes.find(
        (option) => option.key === desiredDefault.accessModeKey,
      )?.label,
    },
    {
      model: "gpt-5.6-codex",
      workIntensity: "high",
      executionMode: "Single agent",
      accessMode: "Full access",
    },
  );
  assert.equal(await readFile(preferencePath, "utf8"), before);
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.startCalls, 0);
  await backend.close();
});

test("one valid exact-snapshot default request performs one preference write and no Agent Session work", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Explicit Default Project");
  const databasePath = join(temporaryDirectory, "explicit-default.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const preferences = new StaticPreferenceStore(
    Object.freeze({
      global: Object.freeze({}),
      endpoints: Object.freeze([]),
    }),
  );
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
    preferenceStore: preferences,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!loaded.ok) assert.fail("Expected profile options.");
  const endpoint = loaded.profile.endpoints[0];
  const model = endpoint?.models[1];
  const intensity = model?.workIntensities[1];
  const executionMode = endpoint?.executionModes[0];
  const accessMode = endpoint?.accessModes[0];
  if (
    endpoint === undefined ||
    model === undefined ||
    intensity === undefined ||
    executionMode === undefined ||
    accessMode === undefined
  ) {
    assert.fail("Expected the second exact selection.");
  }
  const request: WorkbenchDirectSessionProfileDefaultRequest = Object.freeze({
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: endpoint.key,
    modelKey: model.key,
    workIntensityKey: intensity.key,
    executionModeKey: executionMode.key,
    accessModeKey: accessMode.key,
  });

  const result: WorkbenchDirectSessionProfileDefaultResult =
    await backend.useDirectSessionProfileAsDefault(request);

  assert.deepEqual(result, {
    ok: true,
    status: "saved",
    message: "Session Profile default was durably saved.",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(preferences.savedSelections, [
    {
      endpointKey: "codex-desktop",
      model: "gpt-5.6-codex",
      workIntensity: "high",
    },
  ]);
  assert.equal(preferences.readCalls, 1);
  assert.equal(preferences.saveCalls, 1);
  assert.equal(adapter.inspectCalls, 1);
  assert.equal(adapter.startCalls, 0);
  assert.equal(
    observed.every(
      (observation) =>
        !observation.ok || observation.view.commands.length === 0,
    ),
    true,
  );
  assert.deepEqual(Object.keys(backend).sort(), [
    "close",
    "interruptActiveTurn",
    "loadDirectSessionProfile",
    "mutateSessionMetadata",
    "observeProject",
    "observeUserInput",
    "readTurnActivity",
    "readUserInput",
    "removeSession",
    "respondToUserInput",
    "steerActiveTurn",
    "submitDirectInput",
    "useDirectSessionProfileAsDefault",
  ]);
  dispose();
  await backend.close();
});

test("a durably saved default survives backend recreation through fresh opaque keys", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Restart Default Project");
  const databasePath = join(temporaryDirectory, "restart-default.sqlite");
  const preferencePath = join(temporaryDirectory, "restart-default.json");
  await mkdir(projectDirectory);
  const firstAdapter = new CatalogOnlyAdapter();
  const firstBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    preferencePath,
    adapter: firstAdapter,
  });
  const firstLoad = await firstBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!firstLoad.ok) assert.fail("Expected initial profile options.");
  const selectedEndpoint = firstLoad.profile.endpoints[0];
  const selectedModel = selectedEndpoint?.models[1];
  const selectedIntensity = selectedModel?.workIntensities[1];
  const selectedExecutionMode = selectedEndpoint?.executionModes[0];
  const selectedAccessMode = selectedEndpoint?.accessModes[0];
  if (
    selectedEndpoint === undefined ||
    selectedModel === undefined ||
    selectedIntensity === undefined ||
    selectedExecutionMode === undefined ||
    selectedAccessMode === undefined
  ) {
    assert.fail("Expected a supported saved selection.");
  }
  const firstSave = await firstBackend.useDirectSessionProfileAsDefault({
    snapshotKey: firstLoad.profile.snapshotKey,
    endpointKey: selectedEndpoint.key,
    modelKey: selectedModel.key,
    workIntensityKey: selectedIntensity.key,
    executionModeKey: selectedExecutionMode.key,
    accessModeKey: selectedAccessMode.key,
  });
  assert.equal(firstSave.ok, true);
  await firstBackend.close();
  const exactVersionTwoDocument = `${JSON.stringify({
    schemaVersion: 2,
    endpoints: {
      "codex-desktop": {
        model: "gpt-5.6-codex",
        workIntensities: [
          { model: "gpt-5.6-codex", workIntensity: "high" },
        ],
      },
    },
  })}\n`;
  assert.equal(await readFile(preferencePath, "utf8"), exactVersionTwoDocument);
  assert.equal(exactVersionTwoDocument.includes("executionMode"), false);
  assert.equal(exactVersionTwoDocument.includes("accessMode"), false);

  const secondAdapter = new CatalogOnlyAdapter();
  const secondBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    preferencePath,
    adapter: secondAdapter,
  });
  const restarted = await secondBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!restarted.ok || restarted.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected the durable default after restart.");
  }
  const restartedDefault = restarted.profile.desiredDefault;
  const restartedEndpoint = restarted.profile.endpoints.find(
    (endpoint) => endpoint.key === restartedDefault.endpointKey,
  );
  const restartedModel = restartedEndpoint?.models.find(
    (model) => model.key === restartedDefault.modelKey,
  );
  const restartedIntensity = restartedModel?.workIntensities.find(
    (option) => option.key === restartedDefault.workIntensityKey,
  );
  assert.deepEqual(
    {
      model: restartedModel?.label,
      workIntensity: restartedIntensity?.label,
      executionMode: restartedEndpoint?.executionModes.find(
        (option) => option.key === restartedDefault.executionModeKey,
      )?.label,
      accessMode: restartedEndpoint?.accessModes.find(
        (option) => option.key === restartedDefault.accessModeKey,
      )?.label,
    },
    {
      model: "gpt-5.6-codex",
      workIntensity: "high",
      executionMode: "Single agent",
      accessMode: "Full access",
    },
  );
  assert.notEqual(restarted.profile.snapshotKey, firstLoad.profile.snapshotKey);
  assert.notEqual(restartedModel?.key, selectedModel.key);
  assert.notEqual(restartedIntensity?.key, selectedIntensity.key);
  assert.equal(firstAdapter.startCalls, 0);
  assert.equal(secondAdapter.startCalls, 0);
  await secondBackend.close();
});

test("a stale durable default exposes safe options without downgrade or rewrite", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Stale Default Project");
  const databasePath = join(temporaryDirectory, "stale-default.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const staleSnapshot = Object.freeze({
    global: Object.freeze({}),
    endpoints: Object.freeze([
      Object.freeze({
        endpointKey: "codex-desktop",
        model: "retired-model",
        models: Object.freeze([
          Object.freeze({ model: "retired-model", workIntensity: "maximum" }),
        ]),
      }),
    ]),
  });
  const preferences = new StaticPreferenceStore(staleSnapshot);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
    preferenceStore: preferences,
  });

  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.equal(loaded.ok, true);
  assert.deepEqual(
    loaded.ok ? loaded.profile.desiredDefault : undefined,
    { kind: "unavailable" },
  );
  assert.deepEqual(
    loaded.ok
      ? loaded.profile.endpoints[0]?.models.map((model) => model.label)
      : undefined,
    ["GPT-5.6-Sol", "gpt-5.6-codex"],
  );
  assert.equal(preferences.readCalls, 1);
  assert.equal(preferences.saveCalls, 0);
  assert.equal(preferences.snapshot, staleSnapshot);
  assert.equal(adapter.startCalls, 0);
  await backend.close();
});

test("invalid and failed default saves perform no partial durable or Agent Runtime work", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Default Validation Project");
  const databasePath = join(temporaryDirectory, "default-validation.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const emptySnapshot = Object.freeze({
    global: Object.freeze({}),
    endpoints: Object.freeze([]),
  });
  const preferences = new FailingPreferenceStore(emptySnapshot);
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
    preferenceStore: preferences,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const saveUnknown = backend.useDirectSessionProfileAsDefault as (
    request: unknown,
  ) => Promise<WorkbenchDirectSessionProfileDefaultResult>;
  const fakeUuid = "00000000-0000-4000-8000-000000000001";
  const noLoad = await saveUnknown({
    snapshotKey: `snapshot:${fakeUuid}`,
    endpointKey: `endpoint-option:1:${fakeUuid}`,
    modelKey: `model-option:1:${fakeUuid}`,
    workIntensityKey: `intensity-option:1:${fakeUuid}`,
    executionModeKey: `execution-option:1:${fakeUuid}`,
    accessModeKey: `access-option:1:${fakeUuid}`,
  });
  assert.deepEqual(noLoad, invalidDefaultSelection());
  assert.equal(preferences.saveCalls, 0);

  const firstLoad = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!firstLoad.ok) assert.fail("Expected profile options.");
  const valid = defaultRequestFromProfile(firstLoad, 0, 0);
  const mixed = {
    ...valid,
    workIntensityKey:
      firstLoad.profile.endpoints[0]?.models[1]?.workIntensities[0]?.key ??
      "missing",
  };
  const invalidRequests: unknown[] = [
    { ...valid, extra: "PRIVATE_EXTRA_FIELD" },
    { ...valid, modelKey: `model-option:9:${fakeUuid}` },
    { ...valid, workIntensityKey: `intensity-option:9:${fakeUuid}` },
    mixed,
    {
      snapshotKey: valid.snapshotKey,
      modelKey: valid.modelKey,
    },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("PRIVATE_TRAP_FAILURE");
        },
      },
    ),
  ];
  for (const request of invalidRequests) {
    assert.deepEqual(await saveUnknown(request), invalidDefaultSelection());
  }
  assert.equal(preferences.saveCalls, 0);

  const secondLoad = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!secondLoad.ok) assert.fail("Expected refreshed options.");
  assert.deepEqual(await saveUnknown(valid), invalidDefaultSelection());
  assert.equal(preferences.saveCalls, 0);

  const failed = await backend.useDirectSessionProfileAsDefault(
    defaultRequestFromProfile(secondLoad, 1, 1),
  );
  assert.deepEqual(failed, preferenceUnavailable());
  assert.deepEqual(preferences.savedSelections, [
    {
      endpointKey: "codex-desktop",
      model: "gpt-5.6-codex",
      workIntensity: "high",
    },
  ]);
  assert.equal(preferences.saveCalls, 1);
  assert.equal(adapter.startCalls, 0);
  assert.equal(
    observed.every(
      (result) => !result.ok || result.view.commands.length === 0,
    ),
    true,
  );

  await backend.close();
  assert.deepEqual(
    await backend.useDirectSessionProfileAsDefault(
      defaultRequestFromProfile(secondLoad, 0, 0),
    ),
    preferenceUnavailable(),
  );
  assert.equal(preferences.saveCalls, 1);
  assert.equal(adapter.startCalls, 0);
  dispose();
});

test("an in-flight default save keeps its captured mapping across refresh and delays close", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Default Race Project");
  const databasePath = join(temporaryDirectory, "default-race.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const preferences = new HeldPreferenceStore(
    Object.freeze({
      global: Object.freeze({}),
      endpoints: Object.freeze([]),
    }),
  );
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
    preferenceStore: preferences,
  });
  const firstLoad = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!firstLoad.ok) assert.fail("Expected profile options.");
  const firstRequest = defaultRequestFromProfile(firstLoad, 1, 1);

  const save = backend.useDirectSessionProfileAsDefault(firstRequest);
  await preferences.saveStarted;
  const refreshed = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!refreshed.ok) assert.fail("Expected refreshed options.");
  assert.notEqual(refreshed.profile.snapshotKey, firstLoad.profile.snapshotKey);
  assert.deepEqual(
    await backend.useDirectSessionProfileAsDefault(firstRequest),
    invalidDefaultSelection(),
  );
  assert.equal(preferences.saveCalls, 1);
  assert.deepEqual(preferences.savedSelections, [
    {
      endpointKey: "codex-desktop",
      model: "gpt-5.6-codex",
      workIntensity: "high",
    },
  ]);

  let closeSettled = false;
  const close = backend.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);
  preferences.release();
  assert.deepEqual(await save, {
    ok: true,
    status: "saved",
    message: "Session Profile default was durably saved.",
  });
  await close;
  assert.equal(closeSettled, true);
  assert.equal(preferences.closeCalls, 1);
  assert.equal(adapter.startCalls, 0);
});

test("catalog-default profile loading stays fresh under concurrency and never downgrades an unavailable desired default", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Profile Refresh Project");
  const databasePath = join(temporaryDirectory, "profile-refresh.sqlite");
  await mkdir(projectDirectory);

  const heldAdapter = new HeldCatalogLoadAdapter();
  const heldBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter: heldAdapter,
  });
  const firstLoad = heldBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  const concurrentLoad = heldBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.notEqual(firstLoad, concurrentLoad);
  assert.equal(heldAdapter.inspectCalls, 0);
  heldAdapter.release();
  const [first, concurrent] = await Promise.all([firstLoad, concurrentLoad]);
  assert.equal(heldAdapter.inspectCalls, 2);
  assert.notEqual(
    first.ok ? first.profile.snapshotKey : undefined,
    concurrent.ok ? concurrent.profile.snapshotKey : undefined,
  );
  assert.deepEqual(
    first.endpointDiscovery,
    endpointDiscovery("catalog-ready", "not-inspected"),
  );
  const refreshed = await heldBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.equal(heldAdapter.inspectCalls, 3);
  assert.deepEqual(
    refreshed.endpointDiscovery,
    endpointDiscovery("catalog-ready", "not-inspected"),
  );
  assert.notEqual(
    first.ok ? first.profile.snapshotKey : undefined,
    refreshed.ok ? refreshed.profile.snapshotKey : undefined,
  );
  await heldBackend.close();

  const unavailableAdapter = new UnavailableDefaultAdapter();
  const unavailableBackend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(temporaryDirectory, "no-default.sqlite"),
    adapter: unavailableAdapter,
  });
  const unavailable = await unavailableBackend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.equal(unavailable.ok, true);
  assert.deepEqual(
    unavailable.ok ? unavailable.profile.desiredDefault : undefined,
    { kind: "unavailable" },
  );
  assert.deepEqual(
    unavailable.ok
      ? unavailable.profile.endpoints[0]?.models.map((model) => model.label)
      : undefined,
    ["gpt-5.6-codex", "GPT-5.6-Sol"],
  );
  assert.equal(unavailableAdapter.inspectCalls, 1);
  assert.equal(unavailableAdapter.startCalls, 0);
  await unavailableBackend.close();
});

test("catalog-default and replacement loads do not coalesce, never default-fallback, and only the newest completion owns the active snapshot", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Profile Intent Race Project");
  const databasePath = join(temporaryDirectory, "profile-intent-race.sqlite");
  await mkdir(projectDirectory);
  const adapter = new IndependentlyHeldCatalogAdapter();
  const preferences = new StaticPreferenceStore(
    Object.freeze({
      global: Object.freeze({}),
      endpoints: Object.freeze([]),
    }),
  );
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
    preferenceStore: preferences,
  });

  const olderOrdinary = backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  await adapter.firstInspectionStarted;
  const newerReplacement = backend.loadDirectSessionProfile({
    kind: "replacement-session",
    sourceSelectionKey: "command-1",
    sourceSnapshotCursor: 0,
  });
  assert.notEqual(olderOrdinary, newerReplacement);
  await adapter.secondInspectionStarted;
  assert.equal(adapter.inspectCalls, 2);

  adapter.releaseSecond();
  const replacement = await newerReplacement;
  if (!replacement.ok) assert.fail("Expected a fresh replacement catalog.");
  assert.equal("desiredDefault" in replacement.profile, false);
  assert.deepEqual(replacement.profile.replacementPrefill, {
    kind: "manual-selection-required",
  });

  adapter.releaseFirst();
  const ordinary = await olderOrdinary;
  if (!ordinary.ok) assert.fail("Expected the ordinary catalog result.");
  assert.equal("replacementPrefill" in ordinary.profile, false);
  assert.equal(ordinary.profile.desiredDefault.kind, "resolved");

  const endpoint = replacement.profile.endpoints[0];
  const model = endpoint?.models[0];
  const intensity = model?.workIntensities[0];
  const executionMode = endpoint?.executionModes[0];
  const accessMode = endpoint?.accessModes[0];
  if (
    endpoint === undefined ||
    model === undefined ||
    intensity === undefined ||
    executionMode === undefined ||
    accessMode === undefined
  ) {
    assert.fail("Expected one complete current replacement relation.");
  }
  assert.deepEqual(
    await backend.useDirectSessionProfileAsDefault({
      snapshotKey: replacement.profile.snapshotKey,
      endpointKey: endpoint.key,
      modelKey: model.key,
      workIntensityKey: intensity.key,
      executionModeKey: executionMode.key,
      accessModeKey: accessMode.key,
    }),
    {
      ok: true,
      status: "saved",
      message: "Session Profile default was durably saved.",
    },
  );
  assert.equal(preferences.saveCalls, 1);
  const staleCursor = await backend.loadDirectSessionProfile({
    kind: "replacement-session",
    sourceSelectionKey: "command-1",
    sourceSnapshotCursor: 1,
  });
  if (!staleCursor.ok) assert.fail("Expected safe options for manual selection.");
  assert.equal("desiredDefault" in staleCursor.profile, false);
  assert.deepEqual(staleCursor.profile.replacementPrefill, {
    kind: "manual-selection-required",
  });
  assert.equal(adapter.inspectCalls, 3);

  const identicalReplacementRequest = {
    kind: "replacement-session",
    sourceSelectionKey: "command-1",
    sourceSnapshotCursor: 0,
  } as const;
  const firstReplacement = backend.loadDirectSessionProfile(
    identicalReplacementRequest,
  );
  const concurrentReplacement = backend.loadDirectSessionProfile(
    identicalReplacementRequest,
  );
  assert.notEqual(firstReplacement, concurrentReplacement);
  const [firstFreshReplacement, concurrentFreshReplacement] = await Promise.all([
    firstReplacement,
    concurrentReplacement,
  ]);
  if (!firstFreshReplacement.ok || !concurrentFreshReplacement.ok) {
    assert.fail("Expected two fresh replacement catalogs.");
  }
  assert.equal(adapter.inspectCalls, 5);
  assert.notEqual(
    firstFreshReplacement.profile.snapshotKey,
    concurrentFreshReplacement.profile.snapshotKey,
  );
  assert.deepEqual(firstFreshReplacement.profile.replacementPrefill, {
    kind: "manual-selection-required",
  });
  assert.deepEqual(concurrentFreshReplacement.profile.replacementPrefill, {
    kind: "manual-selection-required",
  });
  assert.equal(adapter.startCalls, 0);
  await backend.close();
});

test("backend close awaits every independently tracked concurrent profile refresh", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Profile Close Project");
  await mkdir(projectDirectory);
  const adapter = new IndependentlyHeldCatalogAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath: join(temporaryDirectory, "profile-close.sqlite"),
    adapter,
  });
  registerTestCleanup(t, () => {
    adapter.releaseFirst();
    adapter.releaseSecond();
  });

  const first = backend.loadDirectSessionProfile({ kind: "catalog-default" });
  await adapter.firstInspectionStarted;
  const second = backend.loadDirectSessionProfile({ kind: "catalog-default" });
  await adapter.secondInspectionStarted;
  let closeSettled = false;
  const close = backend.close().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  adapter.releaseFirst();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  adapter.releaseSecond();
  await Promise.all([second, close]);
  assert.equal(closeSettled, true);
  assert.equal(adapter.inspectCalls, 2);
});

test("a failed profile refresh leaves the prior exact snapshot atomically usable", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Atomic Refresh Project");
  const databasePath = join(temporaryDirectory, "atomic-refresh.sqlite");
  await mkdir(projectDirectory);
  const adapter = new FailedRefreshAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });

  const first = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  const failedRefresh = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.deepEqual(
    first.endpointDiscovery,
    endpointDiscovery("catalog-ready", "not-inspected"),
  );
  assert.deepEqual(
    failedRefresh,
    profileUnavailableResult("inspection-failed", "not-inspected"),
  );
  const acceptance = await backend.submitDirectInput(
    requestFromResolvedProfile(first, "Use the still-current exact snapshot."),
  );
  assert.deepEqual(acceptance, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  await backend.close();
  assert.equal(adapter.inspectCalls, 3);
  assert.equal(adapter.startCalls, 1);
});

test("Session removal resolves only the current opaque removal capability before the trusted coordinator seam", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-removal-"),
  );
  const projectDirectory = join(temporaryDirectory, "Removal Project");
  const databasePath = join(temporaryDirectory, "removal.sqlite");
  await mkdir(projectDirectory);
  const adapter = new HeldReplacementProfileAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!loaded.ok) assert.fail("Expected a removable Session profile.");
  assert.equal(
    (
      await backend.submitDirectInput(
        requestFromResolvedProfile(loaded, "Create one removable Session."),
      )
    ).ok,
    true,
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok && result.view.commands[0]?.status === "completed",
    ),
  );
  const terminal = [...observed]
    .reverse()
    .find(
      (result) =>
        result.ok && result.view.commands[0]?.status === "completed",
    );
  if (!terminal?.ok) assert.fail("Expected one terminal Session.");
  const session = terminal.view.commands[0]?.session;
  if (session === undefined || session.selectionKey === null) {
    assert.fail("Expected independent removal and continuation capabilities.");
  }

  assert.deepEqual(
    await backend.removeSession!({ removalKey: session.selectionKey } as never),
    { status: "not-found" },
  );
  assert.deepEqual(
    await backend.removeSession!({ removalKey: session.removalKey } as never),
    { status: "removed" },
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands.length === 0 &&
        result.view.observation.cursor === terminal.view.observation.cursor,
    ),
  );
  assert.equal(
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands.length === 0 &&
        result.view.observation.cursor === terminal.view.observation.cursor,
    ),
    true,
    "the already-attached production observation refreshes after a same-cursor hard delete",
  );
  assert.deepEqual(
    await backend.removeSession!({ removalKey: session.removalKey } as never),
    { status: "not-found" },
  );

  const afterRemoval: WorkbenchProjectResult[] = [];
  const disposeAfterRemoval = backend.observeProject((result) =>
    afterRemoval.push(result),
  );
  await waitFor(() => afterRemoval.some((result) => result.ok));
  const refreshed = afterRemoval.find((result) => result.ok);
  if (!refreshed?.ok) assert.fail("Expected a refreshed live Project view.");
  assert.equal(refreshed.view.commands.length, 0);
  disposeAfterRemoval();
  dispose();
  await backend.close();
});

test("an exact loaded selection returns durable acceptance before the chosen Codex Session completes", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Direct Project");
  const databasePath = join(temporaryDirectory, "direct.sqlite");
  await mkdir(projectDirectory);
  const adapter = new HeldSuccessfulAdapter();
  registerTestCleanup(t, () => adapter.release());
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const instruction =
    "Open C:\\literal-user\\secret.txt\nwith token sk-user-literal.";
  const privateSentinel = "held-successful-session-reference";
  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok ? loaded.profile.desiredDefault.kind : undefined, "resolved");
  if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected the desired catalog-backed selection.");
  }
  const request = requestFromResolvedProfile(loaded, instruction);
  const submit = backend.submitDirectInput as (
    value: typeof request,
  ) => Promise<WorkbenchSubmissionResult>;

  const acceptance: WorkbenchSubmissionResult =
    await submit(request);
  assert.deepEqual(acceptance, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  const acceptanceBoundary = JSON.stringify(acceptance);
  for (const forbidden of [
    instruction,
    privateSentinel,
    projectDirectory,
    databasePath,
  ]) {
    assert.equal(acceptanceBoundary.includes(forbidden), false, forbidden);
  }
  await adapter.inspectionStarted;
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands.length === 1 &&
        result.view.commands[0]?.status === "in-flight",
    ),
  );
  assert.equal(Object.isFrozen(acceptance), true);
  assert.deepEqual(Object.keys(backend).sort(), [
    "close",
    "interruptActiveTurn",
    "loadDirectSessionProfile",
    "mutateSessionMetadata",
    "observeProject",
    "observeUserInput",
    "readTurnActivity",
    "readUserInput",
    "removeSession",
    "respondToUserInput",
    "steerActiveTurn",
    "submitDirectInput",
    "useDirectSessionProfileAsDefault",
  ]);
  let observedCommandSnapshots = 0;
  for (const result of observed) {
    if (!result.ok || result.view.commands.length !== 1) continue;
    observedCommandSnapshots += 1;
    const userMessages =
      result.view.commands[0]?.session?.timeline.flatMap((event) =>
        event.kind === "user-message"
          ? [{ kind: event.kind, text: event.text }]
          : [],
      ) ?? [];
    assert.deepEqual(userMessages, [
      { kind: "user-message", text: instruction },
    ]);
  }
  assert.ok(observedCommandSnapshots > 0);
  const observedBoundary = JSON.stringify(observed);
  assert.equal(observedBoundary.includes(privateSentinel), false);
  assert.equal(observedBoundary.includes(projectDirectory), false);
  assert.equal(observedBoundary.includes(databasePath), false);
  assert.equal(/commandId|sessionId|acceptedCursor|idempotency/iu.test(observedBoundary), false);
  assert.equal(adapter.startCalls, 0);
  assert.equal(adapter.inspectCalls, 2);

  const replacement = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.equal(replacement.ok, true);
  assert.equal(adapter.inspectCalls, 3);

  adapter.release();
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "completed",
    ),
  );
  const terminal = [...observed]
    .reverse()
    .find(
      (result) =>
        result.ok && result.view.commands[0]?.status === "completed",
    );
  assert.equal(terminal?.ok, true);
  assert.deepEqual(
    terminal?.ok
      ? terminal.view.commands[0]?.session?.timeline.flatMap((event) =>
          event.kind === "user-message"
            ? [{ kind: event.kind, text: event.text }]
            : [],
        )
      : undefined,
    [{ kind: "user-message", text: instruction }],
  );
  assert.deepEqual(
    terminal?.ok ? terminal.view.commands[0]?.session?.profile : undefined,
    {
      requested: {
        kind: "recorded",
        runtimeFamilyLabel: "Codex",
        endpointLabel: "Codex desktop",
        modelLabel: "GPT-5.6-Sol",
        workIntensityControlLabel: {
          label: null,
          provenance: "not-recorded",
        },
        workIntensityLabel: "ultra",
        executionModeLabel: "Single agent",
        accessModeLabel: "Full access",
      },
      effective: { kind: "unknown" },
    },
  );
  assert.deepEqual(adapter.starts, [
    { projectDirectory, profile: fixedProfile },
  ]);
  assert.deepEqual(adapter.sent, [instruction]);
  if (!terminal?.ok) assert.fail("Expected the completed source Session.");
  const sourceCommand = terminal.view.commands[0];
  if (sourceCommand === undefined) assert.fail("Expected one source command.");

  const replacementPrefillLoad = await backend.loadDirectSessionProfile({
    kind: "replacement-session",
    sourceSelectionKey: sourceCommand.key,
    sourceSnapshotCursor: terminal.view.observation.cursor,
  });

  assert.equal(replacementPrefillLoad.ok, true);
  if (!replacementPrefillLoad.ok) {
    assert.fail("Expected a fresh replacement catalog.");
  }
  assert.equal("desiredDefault" in replacementPrefillLoad.profile, false);
  assert.deepEqual(
    "replacementPrefill" in replacementPrefillLoad.profile
      ? replacementPrefillLoad.profile.replacementPrefill
      : undefined,
    {
      kind: "resolved",
      endpointKey: replacementPrefillLoad.profile.endpoints[0]?.key,
      modelKey: replacementPrefillLoad.profile.endpoints[0]?.models[0]?.key,
      workIntensityKey:
        replacementPrefillLoad.profile.endpoints[0]?.models[0]
          ?.workIntensities[1]?.key,
      executionModeKey:
        replacementPrefillLoad.profile.endpoints[0]?.executionModes[0]?.key,
      accessModeKey:
        replacementPrefillLoad.profile.endpoints[0]?.accessModes[0]?.key,
    },
  );
  dispose();
  await backend.close();
});

test("a replacement catalog completion becomes manual when its captured source cursor changes during inspection", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Replacement Cursor Race Project");
  const databasePath = join(temporaryDirectory, "replacement-cursor-race.sqlite");
  await mkdir(projectDirectory);
  const adapter = new HeldReplacementProfileAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const loaded = await backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected one ordinary desired default.");
  }
  assert.deepEqual(
    await backend.submitDirectInput(
      requestFromResolvedProfile(loaded, "Create the replacement source."),
    ),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "completed" &&
        result.view.commands[0]?.session?.selectionKey !== null,
    ),
  );
  const terminal = [...observed]
    .reverse()
    .find(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "completed" &&
        result.view.commands[0]?.session?.selectionKey !== null,
    );
  if (!terminal?.ok) assert.fail("Expected one resumable source Session.");
  const source = terminal.view.commands[0];
  const continuationKey = source?.session?.selectionKey;
  if (source === undefined || continuationKey === null || continuationKey === undefined) {
    assert.fail("Expected one private continuation capability projection.");
  }
  const continuationProfile = await backend.loadDirectSessionProfile({
    kind: "continuation-session",
    selectionKey: continuationKey,
  });
  if (!continuationProfile.ok) {
    assert.fail("Expected a fresh continuation profile capability.");
  }
  const continuationPrefill = continuationProfile.profile.continuationPrefill;
  adapter.holdNextReplacementInspection();
  const replacement = backend.loadDirectSessionProfile({
    kind: "replacement-session",
    sourceSelectionKey: source.key,
    sourceSnapshotCursor: terminal.view.observation.cursor,
  });
  await adapter.replacementInspectionStarted;

  assert.deepEqual(
    await backend.submitDirectInput({
      kind: "continue",
      input: "Advance the durable source cursor while its catalog is loading.",
      selectionKey: continuationKey,
      snapshotKey: continuationProfile.profile.snapshotKey,
      endpointKey: continuationPrefill.endpointKey,
      modelKey: continuationPrefill.modelKey,
      workIntensityKey: continuationPrefill.workIntensityKey,
      executionModeKey: continuationPrefill.executionModeKey,
      accessModeKey: continuationPrefill.accessModeKey,
    }),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  adapter.releaseReplacement();
  const raced = await replacement;

  if (!raced.ok) assert.fail("Expected fresh options for manual selection.");
  assert.equal("desiredDefault" in raced.profile, false);
  assert.deepEqual(raced.profile.replacementPrefill, {
    kind: "manual-selection-required",
  });
  assert.equal(JSON.stringify(raced).includes(source.key), false);
  assert.equal(adapter.inspectCalls >= 3, true);
  dispose();
  await backend.close();
});

test("a replacement catalog completion becomes manual when its private source mutates at the same cursor", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Replacement Source Drift Project");
  const databasePath = join(temporaryDirectory, "replacement-source-drift.sqlite");
  await mkdir(projectDirectory);
  const adapter = new HeldReplacementProfileAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const loaded = await backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected one ordinary desired default.");
  }
  assert.deepEqual(
    await backend.submitDirectInput(
      requestFromResolvedProfile(loaded, "Create the private source drift fixture."),
    ),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok && result.view.commands[0]?.status === "completed",
    ),
  );
  const terminal = [...observed]
    .reverse()
    .find(
      (result) =>
        result.ok && result.view.commands[0]?.status === "completed",
    );
  if (!terminal?.ok) assert.fail("Expected one completed source Session.");
  const source = terminal.view.commands[0];
  if (source === undefined) assert.fail("Expected one source command.");

  adapter.holdNextReplacementInspection();
  const replacement = backend.loadDirectSessionProfile({
    kind: "replacement-session",
    sourceSelectionKey: source.key,
    sourceSnapshotCursor: terminal.view.observation.cursor,
  });
  await adapter.replacementInspectionStarted;

  const mutationSentinel = "PRIVATE_SOURCE_MUTATION";
  const writer = new DatabaseSync(databasePath);
  try {
    const before = writer
      .prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM updates")
      .get() as { readonly cursor: number };
    const commandRow = writer
      .prepare(
        `SELECT command_id, private_envelope_json
           FROM commands
          WHERE private_envelope_json IS NOT NULL
          ORDER BY accepted_cursor DESC
          LIMIT 1`,
      )
      .get() as {
        readonly command_id: string;
        readonly private_envelope_json: string;
      };
    const privateEnvelope = JSON.parse(commandRow.private_envelope_json) as {
      profile: SessionProfile;
    };
    privateEnvelope.profile = {
      ...privateEnvelope.profile,
      model: mutationSentinel,
    };
    const mutation = writer
      .prepare(
        "UPDATE commands SET private_envelope_json = ? WHERE command_id = ?",
      )
      .run(JSON.stringify(privateEnvelope), commandRow.command_id);
    const after = writer
      .prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM updates")
      .get() as { readonly cursor: number };
    assert.equal(Number(mutation.changes), 1);
    assert.equal(Number(before.cursor), terminal.view.observation.cursor);
    assert.equal(Number(after.cursor), Number(before.cursor));
  } finally {
    writer.close();
  }

  adapter.releaseReplacement();
  const raced = await replacement;
  if (!raced.ok) assert.fail("Expected fresh options for manual selection.");
  assert.equal("desiredDefault" in raced.profile, false);
  assert.deepEqual(raced.profile.replacementPrefill, {
    kind: "manual-selection-required",
  });
  const publicBoundary = JSON.stringify(raced);
  assert.equal(publicBoundary.includes(source.key), false);
  assert.equal(publicBoundary.includes(mutationSentinel), false);
  dispose();
  await backend.close();
});

test("one exact catalog snapshot accepts at most one concurrent explicit start", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Single Snapshot Project");
  const databasePath = join(temporaryDirectory, "single-snapshot.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  const request = requestFromResolvedProfile(
    loaded,
    "Accept this explicit start only once.",
  );

  const [first, duplicate] = await Promise.all([
    backend.submitDirectInput(request),
    backend.submitDirectInput(request),
  ]);

  assert.deepEqual(first, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.deepEqual(duplicate, invalidProfileSelection());
  await waitFor(() => adapter.startCalls === 1);
  await waitFor(() =>
    observed.some(
      (result) => result.ok && result.view.commands.length === 1,
    ),
  );
  assert.equal(adapter.inspectCalls, 2);
  assert.equal(adapter.startCalls, 1);
  assert.equal(
    observed.every(
      (result) => !result.ok || result.view.commands.length <= 1,
    ),
    true,
  );
  dispose();
  await backend.close();
});

test("Workbench backend projects exact durable turn activity and fails closed after close", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Turn Activity Project");
  const databasePath = join(temporaryDirectory, "turn-activity.sqlite");
  await mkdir(projectDirectory);
  const adapter = new HeldSuccessfulAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  registerTestCleanup(t, dispose);
  registerTestCleanup(t, () => adapter.release());
  await waitFor(() => observed.some((result) => result.ok));
  const profile = await backend.loadDirectSessionProfile({ kind: "catalog-default" });

  assert.deepEqual(
    await backend.submitDirectInput(
      requestFromResolvedProfile(profile, "Hold one turn for activity projection."),
    ),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  assert.equal(backend.readTurnActivity(), "in-flight");

  await adapter.inspectionStarted;
  assert.equal(backend.readTurnActivity(), "in-flight");
  adapter.release();
  await waitFor(() => backend.readTurnActivity() === "idle");
  assert.equal(backend.readTurnActivity(), "idle");

  await backend.close();
  assert.equal(backend.readTurnActivity(), "unknown");
});

test("Workbench backend resolves exact snapshot-scoped steer and interrupt keys to the active command", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Interrupt Backend Project");
  const databasePath = join(temporaryDirectory, "interrupt-backend.sqlite");
  await mkdir(projectDirectory);
  const adapter = new InterruptibleBackendAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  registerTestCleanup(t, dispose);
  registerTestCleanup(t, () => adapter.release());
  await waitFor(() => observed.some((result) => result.ok));
  const profile = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.deepEqual(
    await backend.submitDirectInput(
      requestFromResolvedProfile(profile, "Interrupt this exact active turn."),
    ),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.steer?.status === "available" &&
        result.view.commands[0]?.interrupt?.status === "available",
    ),
  );
  const steer = observed
    .filter((result): result is Extract<WorkbenchProjectResult, { ok: true }> => result.ok)
    .at(-1)?.view.commands[0]?.steer;
  if (steer?.status !== "available") {
    assert.fail("Expected one available same-turn guidance capability.");
  }
  assert.deepEqual(
    await backend.steerActiveTurn!({
      steerKey: steer.steerKey,
      input: "PRIVATE_MUST_NOT_REACH_RUNTIME",
      commandId: "private-command",
    } as never),
    {
      ok: false,
      error: {
        category: "invalid-steer",
        message: "Reload the running Agent Session and try again.",
      },
    },
  );
  assert.deepEqual(adapter.steerCalls, []);
  assert.deepEqual(
    await backend.steerActiveTurn!({
      steerKey: steer.steerKey,
      input: "Guide this exact active turn.",
    }),
    {
      ok: true,
      status: "accepted",
      message: "Guidance was accepted into the running turn.",
    },
  );
  assert.deepEqual(adapter.steerCalls, ["Guide this exact active turn."]);
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.session?.timeline.some(
          (event) =>
            event.kind === "user-message" &&
            event.text === "Guide this exact active turn.",
        ) === true,
    ),
  );
  const available = observed
    .filter((result): result is Extract<WorkbenchProjectResult, { ok: true }> => result.ok)
    .at(-1)?.view.commands[0]?.interrupt;
  if (available?.status !== "available") {
    assert.fail("Expected one refreshed interrupt capability.");
  }
  assert.deepEqual(
    await backend.interruptActiveTurn!({ interruptKey: available.interruptKey }),
    {
      ok: true,
      status: "requested",
      message: "Interrupt requested.",
    },
  );
  assert.equal(adapter.interruptCalls, 1);
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.failureCategory === "interrupted",
    ),
  );
  assert.equal(adapter.interruptCalls, 1);
});

test("a recovery-required turn stays visible while a fresh profile can start a replacement Session", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Recovery Barrier Project");
  const databasePath = join(temporaryDirectory, "recovery-barrier.sqlite");
  await mkdir(projectDirectory);
  const adapter = new RecoveryBarrierAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  registerTestCleanup(t, dispose);
  registerTestCleanup(t, () => adapter.release());
  await waitFor(() => observed.some((result) => result.ok));
  const firstProfile = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.deepEqual(
    await backend.submitDirectInput(
      requestFromResolvedProfile(firstProfile, "Enter a deterministic recovery barrier."),
    ),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  await adapter.eventsStarted;
  const loadedBeforeBarrier = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.equal(loadedBeforeBarrier.ok, true);
  assert.equal(adapter.inspectCalls, 3);

  adapter.release();
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "recovery-required",
    ),
  );
  const callsAtBarrier = {
    inspect: adapter.inspectCalls,
    start: adapter.startCalls,
    send: adapter.sendCalls,
  };
  const blockedStart = await backend.submitDirectInput(
    requestFromResolvedProfile(
      loadedBeforeBarrier,
      "This must remain behind the recovery barrier.",
    ),
  );

  assert.deepEqual(blockedStart, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  });
  assert.deepEqual(
    {
      inspect: adapter.inspectCalls,
      start: adapter.startCalls,
      send: adapter.sendCalls,
    },
    callsAtBarrier,
  );
  assert.deepEqual(callsAtBarrier, { inspect: 3, start: 1, send: 1 });

  const profileAfterFailure = await backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  assert.equal(
    profileAfterFailure.ok,
    true,
    profileAfterFailure.ok
      ? undefined
      : `A failed turn poisoned the Project profile picker: ${profileAfterFailure.error.message}`,
  );
  assert.deepEqual(
    await backend.submitDirectInput(
      requestFromResolvedProfile(
        profileAfterFailure,
        "Start a replacement after the recovery-required turn.",
      ),
    ),
    {
      ok: true,
      status: "accepted",
      message: "Direct input was durably accepted.",
    },
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands.length === 2 &&
        result.view.commands.some(
          (command) => command.status === "recovery-required",
        ) &&
        result.view.commands.some((command) => command.status === "completed"),
    ),
  );
  const replacementResult = observed.find(
    (result) =>
      result.ok &&
      result.view.commands.length === 2 &&
      result.view.commands.some((command) => command.status === "completed"),
  );
  if (!replacementResult?.ok) assert.fail("Expected the replacement Session view.");
  assert.deepEqual(
    replacementResult.view.commands.map((command) => command.status).sort(),
    ["completed", "recovery-required"],
  );
  assert.deepEqual(
    { inspect: adapter.inspectCalls, start: adapter.startCalls, send: adapter.sendCalls },
    { inspect: 5, start: 2, send: 2 },
  );
});

test("a fixed Runtime failure stays visible without poisoning profile reload", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Fixed Failure Project");
  const databasePath = join(temporaryDirectory, "fixed-failure.sqlite");
  await mkdir(projectDirectory);
  const adapter = new FixedFailureAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  registerTestCleanup(t, dispose);
  await waitFor(() => observed.some((result) => result.ok));
  const firstProfile = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.equal(
    (
      await backend.submitDirectInput(
        requestFromResolvedProfile(firstProfile, "Record a deterministic fixed failure."),
      )
    ).ok,
    true,
  );
  await waitFor(() =>
    observed.some(
      (result) => result.ok && result.view.commands[0]?.status === "failed",
    ),
  );

  const profileAfterFailure = await backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  assert.equal(profileAfterFailure.ok, true);
  assert.equal(
    observed.some(
      (result) => result.ok && result.view.commands[0]?.status === "failed",
    ),
    true,
  );
  assert.deepEqual(
    { inspect: adapter.inspectCalls, start: adapter.startCalls },
    { inspect: 3, start: 1 },
  );
});

test("malformed, mixed, stale, and invalid-input selections fail before durable or start work", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Validation Project");
  const databasePath = join(temporaryDirectory, "validation.sqlite");
  await mkdir(projectDirectory);
  const adapter = new CatalogOnlyAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));
  const submitUnknown = backend.submitDirectInput as (
    request: unknown,
  ) => Promise<WorkbenchSubmissionResult>;
  const fakeUuid = "00000000-0000-4000-8000-000000000001";
  const noLoad = await submitUnknown({
    kind: "start",
    input: "A valid local instruction.",
    snapshotKey: `snapshot:${fakeUuid}`,
    endpointKey: `endpoint-option:1:${fakeUuid}`,
    modelKey: `model-option:1:${fakeUuid}`,
    workIntensityKey: `intensity-option:1:${fakeUuid}`,
    executionModeKey: `execution-option:1:${fakeUuid}`,
    accessModeKey: `access-option:1:${fakeUuid}`,
  });
  assert.deepEqual(noLoad, invalidProfileSelection());
  assert.equal(adapter.inspectCalls, 0);

  const firstLoad = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  const firstRequest = requestFromResolvedProfile(
    firstLoad,
    "A valid local instruction.",
  );
  const invalidInputs: unknown[] = [
    "",
    " \r\n\t ",
    "x".repeat(maxInputLength + 1),
    `broken-${String.fromCharCode(0xd800)}`,
    "control-\u0000-value",
    Object.freeze({ text: "not-a-string" }),
  ];

  const invalidResults = await Promise.all(
    invalidInputs.map((input) =>
      submitUnknown({ ...firstRequest, input }),
    ),
  );

  for (const result of invalidResults) {
    assert.deepEqual(result, {
      ok: false,
      error: {
        category: "invalid-input",
        message: "Enter a non-empty instruction of at most 8,000 characters.",
      },
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.ok ? false : Object.isFrozen(result.error), true);
  }
  assert.notEqual(invalidResults[0], invalidResults[1]);
  const models = firstLoad.ok
    ? (firstLoad.profile.endpoints[0]?.models ?? [])
    : [];
  const mixedRequest = {
    ...firstRequest,
    workIntensityKey: models[1]?.workIntensities[0]?.key,
  };
  const malformedSelections: unknown[] = [
    {
      input: firstRequest.input,
      snapshotKey: firstRequest.snapshotKey,
      endpointKey: firstRequest.endpointKey,
      modelKey: firstRequest.modelKey,
      workIntensityKey: firstRequest.workIntensityKey,
      executionModeKey: firstRequest.executionModeKey,
    },
    { ...firstRequest, extra: "PRIVATE_EXTRA_FIELD" },
    { ...firstRequest, snapshotKey: `snapshot:${fakeUuid}` },
    { ...firstRequest, modelKey: `model-option:9:${fakeUuid}` },
    { ...firstRequest, workIntensityKey: `intensity-option:9:${fakeUuid}` },
    mixedRequest,
    {
      input: firstRequest.input,
      snapshotKey: firstRequest.snapshotKey,
      modelKey: firstRequest.modelKey,
    },
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("PRIVATE_TRAP_FAILURE");
        },
      },
    ),
  ];
  const malformedResults = await Promise.all(
    malformedSelections.map((request) => submitUnknown(request)),
  );
  for (const result of malformedResults) {
    assert.deepEqual(result, invalidProfileSelection());
  }

  const secondLoad = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  const secondRequest = requestFromResolvedProfile(
    secondLoad,
    "A second valid local instruction.",
  );
  assert.notEqual(firstRequest.snapshotKey, secondRequest.snapshotKey);
  assert.notEqual(firstRequest.modelKey, secondRequest.modelKey);
  assert.notEqual(
    firstRequest.workIntensityKey,
    secondRequest.workIntensityKey,
  );
  assert.equal(
    /gpt|ultra|medium|full-access/iu.test(
      `${secondRequest.snapshotKey}|${secondRequest.modelKey}|${secondRequest.workIntensityKey}`,
    ),
    false,
  );
  const stale = await submitUnknown(firstRequest);
  assert.deepEqual(stale, invalidProfileSelection());

  assert.equal(adapter.inspectCalls, 2);
  assert.equal(adapter.startCalls, 0);
  assert.equal(
    observed.every(
      (result) => !result.ok || result.view.commands.length === 0,
    ),
    true,
  );

  await backend.close();
  const unavailable = await backend.submitDirectInput(secondRequest);
  assert.deepEqual(unavailable, {
    ok: false,
    error: {
      category: "submission-unavailable",
      message:
        "Direct input could not be durably accepted. Keep your draft and try again.",
    },
  });
  assert.equal(Object.isFrozen(unavailable), true);
  assert.equal(unavailable.ok ? false : Object.isFrozen(unavailable.error), true);
  assert.equal(adapter.inspectCalls, 2);
  assert.equal(adapter.startCalls, 0);
  assert.equal(JSON.stringify(invalidResults).includes(projectDirectory), false);
  assert.equal(JSON.stringify(unavailable).includes(secondRequest.input), false);
  dispose();
});

test("durable acceptance stays distinct from a later fixed profile-resolution failure", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Profile Project");
  const databasePath = join(temporaryDirectory, "profile.sqlite");
  await mkdir(projectDirectory);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  const adapter = new UnsupportedProfileAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  await waitFor(() => observed.some((result) => result.ok));

  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  const acceptance = await backend.submitDirectInput(
    requestFromResolvedProfile(
      loaded,
      "Use the selected Session Profile.",
    ),
  );
  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "failed" &&
        result.view.commands[0]?.failureCategory ===
          "profile-resolution-failed",
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(acceptance, {
    ok: true,
    status: "accepted",
    message: "Direct input was durably accepted.",
  });
  assert.equal(adapter.inspectCalls, 2);
  assert.equal(adapter.startCalls, 0);
  assert.deepEqual(unhandled, []);
  const terminal = [...observed]
    .reverse()
    .find(
      (result) => result.ok && result.view.commands[0]?.status === "failed",
    );
  assert.deepEqual(
    terminal?.ok
      ? {
          status: terminal.view.commands[0]?.status,
          failureCategory: terminal.view.commands[0]?.failureCategory,
        }
      : undefined,
    {
      status: "failed",
      failureCategory: "profile-resolution-failed",
    },
  );
  dispose();
  await backend.close();
});

test("production backend observes the real ProjectChannel with zero act or runtime launch", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Observation Project");
  const databasePath = join(temporaryDirectory, "live.sqlite");
  await mkdir(projectDirectory);
  const adapter = new LaunchDetectingAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  let resolveFirst!: (result: WorkbenchProjectResult) => void;
  const firstResult = new Promise<WorkbenchProjectResult>((resolve) => {
    resolveFirst = resolve;
  });

  const dispose = backend.observeProject(resolveFirst);
  const result = await firstResult;

  assert.deepEqual(result, {
    ok: true,
    view: {
      project: { label: "Observation Project" },
      observation: { cursor: 0, live: true },
      commands: [],
      initialSelectionKey: null,
    },
  });
  assert.equal(JSON.stringify(result).includes(projectDirectory), false);
  assert.equal(JSON.stringify(result).includes(databasePath), false);
  assert.deepEqual(Object.keys(backend).sort(), [
    "close",
    "interruptActiveTurn",
    "loadDirectSessionProfile",
    "mutateSessionMetadata",
    "observeProject",
    "observeUserInput",
    "readTurnActivity",
    "readUserInput",
    "removeSession",
    "respondToUserInput",
    "steerActiveTurn",
    "submitDirectInput",
    "useDirectSessionProfileAsDefault",
  ]);
  assert.equal("act" in backend, false);
  assert.equal(adapter.inspectCalls, 0);
  assert.equal(adapter.startCalls, 0);
  await access(databasePath);
  dispose();
  dispose();
  await backend.close();
  await backend.close();
});

test("production backend close cancels an active observation and fails later reads closed", async (t) => {
  const temporaryDirectory = await createTestDirectory(
    t,
    join(tmpdir(), "workbench-backend-"),
  );
  const projectDirectory = join(temporaryDirectory, "Closing Project");
  const databasePath = join(temporaryDirectory, "closing.sqlite");
  await mkdir(projectDirectory);
  const adapter = new LaunchDetectingAdapter();
  const backend = await createRegisteredWorkbenchBackend(t, {
    projectDirectory,
    databasePath,
    adapter,
  });
  let resolveFirst!: (result: WorkbenchProjectResult) => void;
  const firstResult = new Promise<WorkbenchProjectResult>((resolve) => {
    resolveFirst = resolve;
  });
  const dispose = backend.observeProject(resolveFirst);
  await firstResult;

  await backend.close();
  const afterClose: WorkbenchProjectResult[] = [];
  const lateDispose = backend.observeProject((result) => afterClose.push(result));

  assert.deepEqual(afterClose, [
    {
      ok: false,
      error: {
        category: "project-view-unavailable",
        message: "Live Project data is unavailable.",
      },
    },
  ]);
  assert.equal(adapter.inspectCalls, 0);
  assert.equal(adapter.startCalls, 0);
  dispose();
  lateDispose();
  await backend.close();
});

function cloneProfileStart(request: RuntimeStart): RuntimeStart {
  return {
    projectDirectory: request.projectDirectory,
    profile: { ...request.profile },
  };
}

function requestFromResolvedProfile(
  result: WorkbenchCatalogDefaultProfileResult,
  input: string,
): WorkbenchDirectInputRequest {
  if (!result.ok || result.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected a resolved desired Session Profile.");
  }
  return Object.freeze({
    kind: "start" as const,
    input,
    snapshotKey: result.profile.snapshotKey,
    endpointKey: result.profile.desiredDefault.endpointKey,
    modelKey: result.profile.desiredDefault.modelKey,
    workIntensityKey: result.profile.desiredDefault.workIntensityKey,
    executionModeKey: result.profile.desiredDefault.executionModeKey,
    accessModeKey: result.profile.desiredDefault.accessModeKey,
  });
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

function endpointDiscovery(
  codexCategory: WorkbenchRuntimeEndpointDiscoveryCategory,
  claudeCategory: WorkbenchRuntimeEndpointDiscovery["statuses"][1]["category"],
): WorkbenchRuntimeEndpointDiscovery {
  return {
    statuses: [
      { endpointId: "codex-desktop", category: codexCategory },
      { endpointId: "claude-code-desktop", category: claudeCategory },
      // The legacy single-adapter path leaves the static-key endpoints
      // (GLM, Kimi, DeepSeek, kimi-platform, claude-api, codex-api) not
      // inspected; they have no legacy runtime to inspect.
      { endpointId: "glm-coding-plan", category: "not-inspected" },
      { endpointId: "kimi-code", category: "not-inspected" },
      { endpointId: "deepseek-api", category: "not-inspected" },
      { endpointId: "kimi-platform", category: "not-inspected" },
      { endpointId: "claude-api", category: "not-inspected" },
      { endpointId: "codex-api", category: "not-inspected" },
    ],
  };
}

function profileUnavailableResult(
  codexCategory: WorkbenchRuntimeEndpointDiscoveryCategory,
  claudeCategory: WorkbenchRuntimeEndpointDiscovery["statuses"][1]["category"],
): Extract<WorkbenchDirectSessionProfileResult, { readonly ok: false }> {
  return {
    ok: false,
    endpointDiscovery: endpointDiscovery(codexCategory, claudeCategory),
    error: {
      category: "profile-unavailable",
      message:
        "Codex Session Profile options are unavailable. Keep your draft and try again.",
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

function defaultRequestFromProfile(
  result: WorkbenchDirectSessionProfileResult,
  modelIndex: number,
  intensityIndex: number,
): WorkbenchDirectSessionProfileDefaultRequest {
  if (!result.ok) assert.fail("Expected profile options.");
  const endpoint = result.profile.endpoints[0];
  const model = endpoint?.models[modelIndex];
  const intensity = model?.workIntensities[intensityIndex];
  const executionMode = endpoint?.executionModes[0];
  const accessMode = endpoint?.accessModes[0];
  if (
    endpoint === undefined ||
    model === undefined ||
    intensity === undefined ||
    executionMode === undefined ||
    accessMode === undefined
  ) {
    assert.fail("Expected an exact profile selection.");
  }
  return Object.freeze({
    snapshotKey: result.profile.snapshotKey,
    endpointKey: endpoint.key,
    modelKey: model.key,
    workIntensityKey: intensity.key,
    executionModeKey: executionMode.key,
    accessModeKey: accessMode.key,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for public Workbench state.");
}
