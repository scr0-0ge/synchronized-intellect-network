/* F214. A completed Session whose recorded model has left the provider's catalog
   is still resumable — its native thread is intact and the inspector correctly
   reads `Resumable: Yes` — but its exact recorded profile can no longer be
   prefilled. Before this fix the continuation profile load returned the generic
   `continuation-unavailable` result, whose copy ("choose a resumable Session")
   both CONTRADICTED the inspector and named the wrong cause. This guard drives a
   real backend to that exact state and pins the truthful, non-contradictory
   result. It also pins the copy in both locales.

   RED on the pre-fix backend: the model-orphaned branch returned
   `publicContinuationProfileUnavailable`, so `category` was
   "continuation-unavailable" and the message said "choose a resumable Session". */

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
  RuntimeResume,
  RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import type {
  WorkbenchCatalogDefaultProfileResult,
  WorkbenchDirectInputRequest,
  WorkbenchProjectResult,
} from "../../src/workbench-shell/contract.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import { dynamicCopy } from "../../src/workbench-shell/renderer/copy/dynamic-copy.ts";
import { copyLocaleDictionaries } from "../../src/workbench-shell/renderer/copy/dynamic-copy.ts";
import { registerTestClosable } from "../helpers/test-lifecycle.ts";

/* Two models to begin with; after the first turn completes, the one that turn
   recorded is dropped — whatever it was — so the continuation load faces a
   recorded model that is no longer in the catalog. */
class OrphanedModelAdapter implements ResumableAgentRuntimeAdapter {
  inspectCalls = 0;
  private recordedModel: string | undefined;

  async inspect(_projectDirectory: string): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    const models = [
      {
        id: "sunset-model",
        displayName: "Sunset Model",
        effortLevels: ["low", "high"],
        effortLevelLabels: ["low", "high"],
      },
      {
        id: "current-model",
        displayName: "Current Model",
        effortLevels: ["low", "high"],
        effortLevelLabels: ["low", "high"],
      },
    ].filter((model) => model.id !== this.recordedModel);
    return {
      runtime: "codex",
      models,
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    const model = request.profile.model;
    const markOrphaned = () => {
      this.recordedModel = model;
    };
    return {
      profile: { ...request.profile },
      opaqueSessionReference: "orphaned-model-session-reference",
      async send() {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "item-started", itemType: "agent-message" };
        yield { kind: "item-completed", itemType: "agent-message" };
        yield { kind: "agent-message", text: "FIXED_TEST_COMPLETION" };
        yield { kind: "turn-completed", status: "completed" };
        /* The recorded model leaves the catalog only AFTER the turn is durably
           recorded, exactly as a real vendor retirement lands between sessions. */
        markOrphaned();
      },
    };
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    throw new RuntimeAdapterError("runtime-unavailable");
  }
}

function startRequestFrom(
  result: WorkbenchCatalogDefaultProfileResult,
  input: string,
): WorkbenchDirectInputRequest {
  if (!result.ok) assert.fail("Expected a loadable catalog default.");
  const endpoint = result.profile.endpoints[0];
  const model = endpoint?.models[0];
  const endpointKey = endpoint?.key;
  const modelKey = model?.key;
  const workIntensityKey = model?.workIntensities[0]?.key;
  const executionModeKey = endpoint?.executionModes[0]?.key;
  const accessModeKey = endpoint?.accessModes[0]?.key;
  if (
    endpointKey === undefined ||
    modelKey === undefined ||
    workIntensityKey === undefined ||
    executionModeKey === undefined ||
    accessModeKey === undefined
  ) {
    assert.fail("Expected a fully selectable catalog default.");
  }
  return Object.freeze({
    kind: "start" as const,
    input,
    snapshotKey: result.profile.snapshotKey,
    endpointKey,
    modelKey,
    workIntensityKey,
    executionModeKey,
    accessModeKey,
  });
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition was not reached in time.");
};

async function createBackend(context: TestContext) {
  const root = join(tmpdir(), `w470-f214-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const projectDirectory = join(root, "project");
  const databasePath = join(root, "ledger.sqlite");
  await mkdir(projectDirectory, { recursive: true });
  const adapter = new OrphanedModelAdapter();
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath,
    adapter,
  });
  registerTestClosable(context, backend);
  return { backend, adapter };
}

test("F214: an orphaned-model continuation names the model cause, not the generic contradiction", async (t) => {
  const { backend } = await createBackend(t);
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  t.after(() => dispose());
  await waitFor(() => observed.some((result) => result.ok));

  const catalogDefault = await backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  assert.deepEqual(
    await backend.submitDirectInput(
      startRequestFrom(catalogDefault, "Record a completed Session to continue later."),
    ),
    { ok: true, status: "accepted", message: "Direct input was durably accepted." },
  );

  await waitFor(() =>
    observed.some(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "completed" &&
        result.view.commands[0]?.session?.selectionKey != null,
    ),
  );
  const terminal = [...observed]
    .reverse()
    .find(
      (result) =>
        result.ok &&
        result.view.commands[0]?.status === "completed" &&
        result.view.commands[0]?.session?.selectionKey != null,
    );
  if (!terminal?.ok) assert.fail("Expected a completed, resumable source Session.");
  const source = terminal.view.commands[0];
  const selectionKey = source?.session?.selectionKey;
  if (selectionKey == null) assert.fail("Expected a continuation selection key.");

  /* The inspector's own truth: the completed Session IS resumable. The composer
     message must not contradict this. */
  assert.equal(source?.session?.resumable, true);

  const continuation = await backend.loadDirectSessionProfile({
    kind: "continuation-session",
    selectionKey,
  });

  assert.equal(continuation.ok, false, "the orphaned-model continuation profile cannot load");
  if (continuation.ok) return;

  // The named cause — not the generic "continuation-unavailable".
  assert.equal(continuation.error.category, "continuation-model-unavailable");
  // The contradiction is gone: it must not tell the user this Session is not resumable.
  assert.doesNotMatch(continuation.error.message, /choose a resumable Session/u);
  // The real cause is stated, and a working way forward is offered.
  assert.match(continuation.error.message, /no longer offered/u);
  assert.match(continuation.error.message, /New Agent Session/u);
});

test("F214: the orphaned-model copy is truthful in both locales and free of the contradiction", () => {
  // English canonical (also the wire message the sanitizer validates).
  const en = copyLocaleDictionaries.en.profile.continuationModelUnavailable;
  assert.match(en, /no longer offered/u);
  assert.match(en, /New Agent Session/u);
  assert.doesNotMatch(en, /choose a resumable Session/u);
  assert.doesNotMatch(en, /cannot be continued/u);
  // The live-selected copy resolves to the same English canonical by default.
  assert.equal(dynamicCopy.profile.continuationModelUnavailable, en);

  // Simplified Chinese: names the cause, keeps the Session, no contradiction.
  const zh = copyLocaleDictionaries["zh-CN"].profile.continuationModelUnavailable;
  assert.match(zh, /模型/u);
  assert.match(zh, /不再/u);
  assert.match(zh, /新建智能体会话/u);
  assert.doesNotMatch(zh, /可恢复的会话/u);
});
