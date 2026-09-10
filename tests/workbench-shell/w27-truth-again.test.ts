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
  SessionProfile,
} from "../../src/agent-runtime/index.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import type {
  WorkbenchCatalogDefaultProfileResult,
  WorkbenchDirectInputRequest,
  WorkbenchProjectResult,
  WorkbenchRuntimeEndpointDiscoveryCategory,
} from "../../src/workbench-shell/contract.ts";
import {
  publicRuntimeEndpointDiscovery,
} from "../../src/workbench-shell/contract.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import { WORKBENCH_RUNTIME_ENDPOINT_IDS } from "../../src/workbench-shell/runtime-endpoint-identity.ts";
import { createWorkbenchRuntimeEndpointAdapter } from "../../src/workbench-shell/runtime-endpoint-adapter.ts";
import { copyLocaleDictionaries as dynamicCopyDictionaries } from "../../src/workbench-shell/renderer/copy/dynamic-copy.ts";
import { copyLocaleDictionaries as removalCopyDictionaries } from "../../src/workbench-shell/renderer/copy/removal-copy.ts";
import { registerTestClosable } from "../helpers/test-lifecycle.ts";

const codexProfile: SessionProfile = Object.freeze({
  model: "codex-recorded-model",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
});

test("default-save confirmation does not name a provider the shared path did not save", () => {
  assert.equal(
    dynamicCopyDictionaries.en.profile.defaultSaved,
    "Session Profile default was durably saved.",
  );
  assert.equal(
    dynamicCopyDictionaries["zh-CN"].profile.defaultSaved,
    "已持久保存会话配置默认值。",
  );
  for (const copy of [
    dynamicCopyDictionaries.en.profile.defaultSaved,
    dynamicCopyDictionaries["zh-CN"].profile.defaultSaved,
  ]) {
    assert.doesNotMatch(copy, /Codex|Claude|GLM|Kimi|DeepSeek/iu);
  }
});

test("a catalog from another endpoint cannot prove the recorded provider dropped its model", async (t) => {
  const runtime = new ProviderAvailabilityAdapter();
  const adapter = createWorkbenchRuntimeEndpointAdapter(
    runtime,
    async () => runtime.endpointSnapshot(),
    (_projectDirectory, profile) => ({
      schemaVersion: 1,
      endpointId: "codex-desktop",
      nativeProfile: profile,
    }),
  );
  const { backend } = await createBackend(t, adapter);
  const observed: WorkbenchProjectResult[] = [];
  const dispose = backend.observeProject((result) => observed.push(result));
  t.after(dispose);
  await waitFor(() => observed.some((result) => result.ok));

  const catalogDefault = await backend.loadDirectSessionProfile({
    kind: "catalog-default",
  });
  assert.deepEqual(
    await backend.submitDirectInput(
      startRequestFrom(catalogDefault, "Create a Codex Session before its runtime disappears."),
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
  if (!terminal?.ok) assert.fail("Expected a completed Codex Session.");
  const selectionKey = terminal.view.commands[0]?.session?.selectionKey;
  if (selectionKey == null) assert.fail("Expected a continuation selection key.");

  const continuation = await backend.loadDirectSessionProfile({
    kind: "continuation-session",
    selectionKey,
  });

  assert.equal(continuation.ok, false);
  if (continuation.ok) return;
  assert.equal(continuation.error.category, "continuation-unavailable");
  assert.doesNotMatch(continuation.error.message, /no longer offered/iu);
  assert.deepEqual(
    continuation.endpointDiscovery.statuses.filter(
      ({ endpointId }) =>
        endpointId === "codex-desktop" || endpointId === "glm-coding-plan",
    ),
    [
      { endpointId: "codex-desktop", category: "runtime-not-located" },
      { endpointId: "glm-coding-plan", category: "catalog-ready" },
    ],
  );
});

test("unknown activity while removing the current Project points to the working non-destructive route", () => {
  const english = removalCopyDictionaries.en.subjectActivityUnknownCopy("Project");
  const chinese = removalCopyDictionaries["zh-CN"].subjectActivityUnknownCopy("项目");

  assert.match(english, /Switch to another Project, then remove this Project/iu);
  assert.match(english, /history.*reopen/iu);
  assert.doesNotMatch(english, /Keep the Workbench open|activity is known/iu);
  assert.match(chinese, /切换到另一个项目.*移除当前项目/u);
  assert.match(chinese, /重新打开.*历史/u);
  assert.doesNotMatch(chinese, /保持 Workbench 打开|活动状态明确/u);
});

class ProviderAvailabilityAdapter implements ResumableAgentRuntimeAdapter {
  #codexSessionCompleted = false;

  async inspect(): Promise<RuntimeCatalog> {
    return codexCatalog;
  }

  async start(request: RuntimeStart): Promise<ResumableRuntimeBinding> {
    const runtime = this;
    return {
      profile: { ...request.profile },
      opaqueSessionReference: "w27-codex-session-reference",
      async send() {},
      async *events(): AsyncIterable<NormalizedRuntimeEvent> {
        yield { kind: "session-started" };
        yield { kind: "turn-started" };
        yield { kind: "item-started", itemType: "agent-message" };
        yield { kind: "item-completed", itemType: "agent-message" };
        yield { kind: "agent-message", text: "W27_OFFLINE_COMPLETION" };
        runtime.#codexSessionCompleted = true;
        yield { kind: "turn-completed", status: "completed" };
      },
    };
  }

  async resume(_request: RuntimeResume): Promise<ResumableRuntimeBinding> {
    throw new RuntimeAdapterError("runtime-unavailable");
  }

  endpointSnapshot() {
    const readyEndpointId = this.#codexSessionCompleted
      ? "glm-coding-plan"
      : "codex-desktop";
    const endpoints = this.#codexSessionCompleted
      ? [
          {
            endpointId: "glm-coding-plan" as const,
            preferenceKey: "glm-coding-plan",
            runtimeFamilyLabel: "GLM",
            endpointLabel: "GLM Coding Plan",
            catalog: glmCatalog,
            directStart: "supported" as const,
          },
        ]
      : [
          {
            endpointId: "codex-desktop" as const,
            preferenceKey: "codex-desktop",
            runtimeFamilyLabel: "Codex",
            endpointLabel: "Codex desktop",
            catalog: codexCatalog,
            desiredDefault: codexProfile,
            directStart: "supported" as const,
          },
        ];
    return {
      endpoints,
      endpointDiscovery: publicRuntimeEndpointDiscovery(
        WORKBENCH_RUNTIME_ENDPOINT_IDS.map((endpointId) => ({
          endpointId,
          category: discoveryCategory(
            endpointId,
            readyEndpointId,
            this.#codexSessionCompleted,
          ),
        })),
      ),
    };
  }
}

const codexCatalog: RuntimeCatalog = Object.freeze({
  runtime: "codex",
  models: Object.freeze([
    Object.freeze({
      id: codexProfile.model,
      displayName: "Codex Recorded Model",
      effortLevels: Object.freeze([codexProfile.effortLevel]),
      effortLevelLabels: Object.freeze([codexProfile.effortLevel]),
    }),
  ]),
  executionModes: Object.freeze([codexProfile.executionMode]),
  accessModes: Object.freeze([codexProfile.accessMode]),
});

const glmCatalog: RuntimeCatalog = Object.freeze({
  runtime: "claude",
  models: Object.freeze([
    Object.freeze({
      id: "glm-5.3-flash[1m]",
      displayName: "GLM-5.3 Flash [1m]",
      effortLevels: Object.freeze(["high"]),
      effortLevelLabels: Object.freeze(["high"]),
    }),
  ]),
  executionModes: Object.freeze(["single-agent"]),
  accessModes: Object.freeze(["full-access"]),
});

function discoveryCategory(
  endpointId: (typeof WORKBENCH_RUNTIME_ENDPOINT_IDS)[number],
  readyEndpointId: "codex-desktop" | "glm-coding-plan",
  codexSessionCompleted: boolean,
): WorkbenchRuntimeEndpointDiscoveryCategory {
  if (endpointId === readyEndpointId) return "catalog-ready";
  if (codexSessionCompleted && endpointId === "codex-desktop") {
    return "runtime-not-located";
  }
  return "not-inspected";
}

function startRequestFrom(
  result: WorkbenchCatalogDefaultProfileResult,
  input: string,
): WorkbenchDirectInputRequest {
  if (!result.ok || result.profile.desiredDefault.kind !== "resolved") {
    assert.fail("Expected a resolved Codex default.");
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

async function createBackend(
  context: TestContext,
  adapter: ResumableAgentRuntimeAdapter,
) {
  const root = join(
    tmpdir(),
    `w27-truth-again-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory, { recursive: true });
  const backend = await createWorkbenchBackend({
    projectDirectory,
    databasePath: join(root, "ledger.sqlite"),
    adapter,
  });
  registerTestClosable(context, backend);
  return { backend };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition was not reached in time.");
}
