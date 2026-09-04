import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  NormalizedRuntimeEvent,
  ResumableAgentRuntimeAdapter,
  ResumableRuntimeBinding,
  RuntimeCatalog,
  RuntimeInput,
  RuntimeResume,
  RuntimeStart,
  SessionProfile,
} from "../../../src/agent-runtime/index.ts";
import { createWorkbenchBackend } from "../../../src/workbench-shell/backend.ts";
import type { WorkbenchDirectInputRequest } from "../../../src/workbench-shell/contract.ts";
import { createProductionRuntimeEndpointAdapter } from "../../../src/workbench-shell/runtime-endpoint-composition.ts";
import {
  expectedJourneyEventKinds,
  type CapturedJourneyTurn,
  type TestDoubleUserJourneyRunOptions,
  type UserJourneyObservation,
  type UserJourneyRuntime,
} from "./contracts.ts";
import {
  durableTargetMatchesPair,
  exportUserJourneyEvidence,
  readDurableCommands,
} from "./evidence.ts";
import {
  assertCompletedJourneyObservations,
  captureViewTurn,
  completeObservation,
  hasSettledTurn,
  observeProjectViews,
  commandForRuntime,
} from "./observations.ts";
import {
  createTemporaryRoot,
  emitObservation,
  removeTemporaryRoot,
  replyForPrompt,
  scenariosFor,
  selectedTestDoubleRuntimes,
} from "./shared.ts";

const testDoubleCatalogs: Readonly<Record<UserJourneyRuntime, RuntimeCatalog>> =
  Object.freeze({
    codex: Object.freeze({
      runtime: "codex",
      models: Object.freeze([
        Object.freeze({
          id: "gpt-5.6-sol",
          resolvedModel: "gpt-5.6-sol",
          displayName: "gpt-5.6-sol",
          effortLevels: Object.freeze(["ultra"]),
          effortLevelLabels: Object.freeze(["ultra"]),
        }),
      ]),
      executionModes: Object.freeze(["single-agent"]),
      accessModes: Object.freeze(["full-access"]),
    }),
    claude: Object.freeze({
      runtime: "claude",
      models: Object.freeze([
        Object.freeze({
          id: "sonnet",
          resolvedModel: "claude-sonnet-5",
          displayName: "Sonnet",
          effortLevels: Object.freeze(["low"]),
          effortLevelLabels: Object.freeze(["low"]),
        }),
      ]),
      executionModes: Object.freeze(["single-agent"]),
      accessModes: Object.freeze(["full-access"]),
    }),
  });

class JourneyRecordingAdapter implements ResumableAgentRuntimeAdapter {
  readonly starts: RuntimeStart[] = [];
  readonly resumes: RuntimeResume[] = [];
  readonly inputs: RuntimeInput[] = [];
  readonly runtime: UserJourneyRuntime;
  readonly catalog: RuntimeCatalog;

  constructor(runtime: UserJourneyRuntime) {
    this.runtime = runtime;
    this.catalog = testDoubleCatalogs[runtime];
  }

  async inspect(): Promise<RuntimeCatalog> {
    return structuredClone(this.catalog);
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    this.starts.push(structuredClone(request));
    return this.binding(
      request.profile,
      `${this.runtime}-test-double-capability-${this.starts.length}`,
    );
  }

  async resume(request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    this.resumes.push(structuredClone(request));
    return this.binding(request.profile, request.opaqueSessionReference);
  }

  private binding(
    profile: SessionProfile,
    opaqueSessionReference: string,
  ): ResumableRuntimeBinding {
    let input: RuntimeInput | undefined;
    const adapter = this;
    return Object.freeze({
      profile: Object.freeze({ ...profile }),
      opaqueSessionReference,
      effectiveProfile: () => Object.freeze({ ...profile }),
      async send(next: RuntimeInput): Promise<void> {
        input = structuredClone(next);
        adapter.inputs.push(structuredClone(next));
      },
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        if (input === undefined) throw new Error("journey-input-missing");
        const reply = replyForPrompt(input.text);
        yield Object.freeze({ kind: "session-started" as const });
        yield Object.freeze({ kind: "turn-started" as const });
        yield Object.freeze({
          kind: "item-started" as const,
          itemType: "agent-message" as const,
        });
        yield Object.freeze({
          kind: "item-completed" as const,
          itemType: "agent-message" as const,
        });
        yield Object.freeze({ kind: "agent-message" as const, text: reply });
        yield Object.freeze({
          kind: "turn-completed" as const,
          status: "completed" as const,
        });
      },
    });
  }
}

export async function runTestDoubleUserJourneys(
  emit: (observation: UserJourneyObservation) => void = emitObservation,
  options: TestDoubleUserJourneyRunOptions = {},
): Promise<readonly UserJourneyObservation[]> {
  const temporaryRoot = await createTemporaryRoot();
  try {
    options.onTemporaryRootCreated?.(temporaryRoot);
    const runtimes = selectedTestDoubleRuntimes(options.runtimes);
    const projectDirectory = join(temporaryRoot, "Journey Project");
    const databasePath = join(temporaryRoot, "journey.sqlite");
    const preferencePath = join(temporaryRoot, "preferences.json");
    await mkdir(projectDirectory);

    const codex = new JourneyRecordingAdapter("codex");
    const claude = new JourneyRecordingAdapter("claude");
    const backend = await createWorkbenchBackend({
      projectDirectory,
      databasePath,
      preferencePath,
      adapter: await createProductionRuntimeEndpointAdapter({
        codexAdapter: codex,
        claudeAdapter: claude,
      }),
    });
    const views = observeProjectViews(backend.observeProject);
    const captured: CapturedJourneyTurn[] = [];
    try {
      await views.waitFor((view) => view.commands.length === 0);
      for (const runtime of runtimes) {
        const [startScenario, continueScenario] = scenariosFor(runtime);
        const loaded = await backend.loadDirectSessionProfile();
        assert.equal(loaded.ok, true, `${runtime} profile should load`);
        if (!loaded.ok) throw new Error("journey-profile-unavailable");
        const endpoint = loaded.profile.endpoints.find(
          (candidate) =>
            candidate.runtimeFamilyLabel.toLocaleLowerCase("en-US") === runtime,
        );
        assert.ok(endpoint, `${runtime} endpoint should be independently selectable`);
        const model = endpoint.models[0];
        assert.ok(model);
        const effort = model.workIntensities[0];
        assert.ok(effort);

        const acceptedStart = await backend.submitDirectInput(
          Object.freeze({
            kind: "start" as const,
            input: startScenario.prompt,
            snapshotKey: loaded.profile.snapshotKey,
            endpointKey: endpoint.key,
            modelKey: model.key,
            workIntensityKey: effort.key,
            executionModeKey: endpoint.executionModes[0]!.key,
            accessModeKey: endpoint.accessModes[0]!.key,
          }) satisfies WorkbenchDirectInputRequest,
        );
        assert.deepEqual(acceptedStart, {
          ok: true,
          status: "accepted",
          message: "Direct input was durably accepted.",
        });
        const startedView = await views.waitFor((view) =>
          hasSettledTurn(view, runtime, 1),
        );
        const started = captureViewTurn(
          startedView,
          startScenario,
          true,
          model.label,
          effort.label,
        );
        captured.push(started);
        assert.equal(started.terminalState, "completed");
        assert.deepEqual(started.eventKinds, expectedJourneyEventKinds);
        assert.equal(started.replyText, startScenario.expectedReply);

        const command = commandForRuntime(startedView, runtime);
        const selectionKey = command?.session?.selectionKey;
        assert.match(selectionKey ?? "", /^session-selection:/u);
        if (typeof selectionKey !== "string") {
          throw new Error("journey-continuation-selection-missing");
        }
        const continuationProfile = await backend.loadDirectSessionProfile({
          kind: "continuation-session",
          selectionKey,
        });
        assert.equal(
          continuationProfile.ok,
          true,
          `${runtime} continuation profile should load`,
        );
        if (!continuationProfile.ok) {
          throw new Error("journey-continuation-profile-unavailable");
        }
        const continuationPrefill =
          continuationProfile.profile.continuationPrefill;
        const acceptedContinue = await backend.submitDirectInput(
          Object.freeze({
            kind: "continue" as const,
            input: continueScenario.prompt,
            selectionKey,
            snapshotKey: continuationProfile.profile.snapshotKey,
            endpointKey: continuationPrefill.endpointKey,
            modelKey: continuationPrefill.modelKey,
            workIntensityKey: continuationPrefill.workIntensityKey,
            executionModeKey: continuationPrefill.executionModeKey,
            accessModeKey: continuationPrefill.accessModeKey,
          }) satisfies WorkbenchDirectInputRequest,
        );
        assert.deepEqual(acceptedContinue, {
          ok: true,
          status: "accepted",
          message: "Direct input was durably accepted.",
        });
        const continuedView = await views.waitFor((view) =>
          hasSettledTurn(view, runtime, 2),
        );
        const continued = captureViewTurn(
          continuedView,
          continueScenario,
          true,
          model.label,
          effort.label,
        );
        captured.push(continued);
        assert.equal(continued.terminalState, "completed");
        assert.deepEqual(continued.eventKinds, expectedJourneyEventKinds);
        assert.equal(continued.replyText, continueScenario.expectedReply);
        assert.equal(continued.sessionRowLabel, started.sessionRowLabel);
      }
    } finally {
      views.dispose();
      await backend.close();
    }

    assert.deepEqual(
      codex.inputs.map((input) => input.text),
      runtimes.includes("codex")
        ? scenariosFor("codex").map((scenario) => scenario.prompt)
        : [],
    );
    assert.deepEqual(
      claude.inputs.map((input) => input.text),
      runtimes.includes("claude")
        ? scenariosFor("claude").map((scenario) => scenario.prompt)
        : [],
    );
    assert.equal(codex.starts.length, runtimes.includes("codex") ? 1 : 0);
    assert.equal(codex.resumes.length, runtimes.includes("codex") ? 1 : 0);
    assert.equal(claude.starts.length, runtimes.includes("claude") ? 1 : 0);
    assert.equal(claude.resumes.length, runtimes.includes("claude") ? 1 : 0);

    const durable = readDurableCommands(databasePath);
    assert.equal(durable.length, runtimes.length * 2);
    const observations = captured.map((turn, index) =>
      completeObservation(
        turn,
        durable[index],
        durableTargetMatchesPair(durable, index),
        captured[index - (index % 2)]?.sessionRowLabel === turn.sessionRowLabel,
        "test-double",
      ),
    );
    for (const observation of observations) emit(observation);
    for (const [runtimeIndex, runtime] of runtimes.entries()) {
      assertCompletedJourneyObservations(
        observations.slice(runtimeIndex * 2, runtimeIndex * 2 + 2),
        runtime,
        "test-double",
        runtimeIndex + 1,
      );
    }
    await exportUserJourneyEvidence(
      options,
      temporaryRoot,
      observations,
      durable,
    );
    return Object.freeze(observations);
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
}
