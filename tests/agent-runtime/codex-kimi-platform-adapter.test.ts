import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import type { CodexEndpointContext } from "../../src/agent-runtime/codex-adapter.ts";
import type { CodexExecutableDiscoveryResult } from "../../src/agent-runtime/codex/executable-discovery.ts";
import {
  KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT,
} from "../../src/agent-runtime/codex/endpoint-env-factory.ts";
import {
  KIMI_PLATFORM_CONFIG_TOML_FILE_NAME,
  ensureKimiPlatformCodexHome,
} from "../../src/agent-runtime/codex/kimi-platform-codex-home.ts";
import {
  KIMI_PLATFORM_DEFAULT_MODEL_ID,
  KIMI_PLATFORM_STATIC_CATALOG,
  createKimiPlatformEndpointContext,
} from "../../src/agent-runtime/codex/kimi-platform-catalog.ts";
import { RuntimeAdapterError } from "../../src/agent-runtime/index.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";
import { createTestDirectory } from "../helpers/test-lifecycle.ts";

const FAKE_KEY = "FAKE-KIMI-PLATFORM-KEY-1234";

/**
 * A located discovery for the spawn-free static inspection path. The handle
 * is opaque and never dereferenced there — only `kind` is read — so a frozen
 * empty object stands in for the branded handle.
 */
function locatedDiscovery(): CodexExecutableDiscoveryResult {
  return {
    kind: "located",
    executable: Object.freeze({}),
  } as unknown as CodexExecutableDiscoveryResult;
}

function kimiPlatformContext(overrides: {
  readonly homeDirectory: string;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly resolveApiKey?: () => string | undefined;
  readonly discoverExecutable?: () => Promise<CodexExecutableDiscoveryResult>;
}): CodexEndpointContext {
  const base = createKimiPlatformEndpointContext({
    codexHome: overrides.homeDirectory,
    ...(overrides.sourceEnvironment === undefined
      ? {}
      : { sourceEnvironment: overrides.sourceEnvironment }),
    ...(overrides.resolveApiKey === undefined
      ? {}
      : { resolveApiKey: overrides.resolveApiKey }),
  });
  return Object.freeze({
    ...base,
    ...(overrides.discoverExecutable === undefined
      ? {}
      : { discoverExecutable: overrides.discoverExecutable }),
  });
}

test("a kimi-platform adapter without a key reports authentication-required without spawning or seeding anything", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const home = join(root, "codex-home");
  let transportCreations = 0;
  const adapter = new CodexAdapter(
    () => {
      transportCreations += 1;
      throw new Error("transport must not be created");
    },
    undefined,
    undefined,
    kimiPlatformContext({ homeDirectory: home, sourceEnvironment: {} }),
  );
  let failure: unknown;
  try {
    await adapter.inspect("C:\\synthetic-project");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "authentication-required");
  assert.equal(transportCreations, 0);
  // The home was never seeded: validation precedes preparation.
  let seeded = false;
  try {
    readFileSync(join(home, KIMI_PLATFORM_CONFIG_TOML_FILE_NAME), "utf8");
    seeded = true;
  } catch {
    seeded = false;
  }
  assert.equal(seeded, false);
});

test("a kimi-platform adapter with a key serves the static catalog after seeding and executable discovery, spawning nothing", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const home = join(root, "codex-home");
  let transportCreations = 0;
  const adapter = new CodexAdapter(
    () => {
      transportCreations += 1;
      throw new Error("transport must not be created");
    },
    undefined,
    undefined,
    kimiPlatformContext({
      homeDirectory: home,
      sourceEnvironment: {
        [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY,
      },
      discoverExecutable: async () => locatedDiscovery(),
    }),
  );
  const catalog = await adapter.inspect("C:\\synthetic-project");
  assert.equal(transportCreations, 0);
  assert.equal(catalog, KIMI_PLATFORM_STATIC_CATALOG);
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    [
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "kimi-k3",
      "kimi-k2.6",
    ],
  );
  // The seeding ran as part of inspection: a catalog-ready endpoint implies
  // a healthy transport config on disk.
  const configToml = readFileSync(join(home, KIMI_PLATFORM_CONFIG_TOML_FILE_NAME), "utf8");
  assert.ok(configToml.includes(`model = "${KIMI_PLATFORM_DEFAULT_MODEL_ID}"`));
  assert.ok(configToml.includes("https://api.moonshot.cn/v1"));
});

test("a kimi-platform adapter whose codex executable is not locatable reports runtime-not-located after seeding", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const home = join(root, "codex-home");
  const adapter = new CodexAdapter(
    undefined,
    undefined,
    undefined,
    kimiPlatformContext({
      homeDirectory: home,
      sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
      discoverExecutable: async () => ({ kind: "not-located" }) as const,
    }),
  );
  let failure: unknown;
  try {
    await adapter.inspect("C:\\synthetic-project");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "runtime-not-located");
  const state = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(state.restored, false);
});

test("a static selection outside the catalog is rejected before any transport exists", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const context = kimiPlatformContext({
    homeDirectory: join(root, "codex-home"),
    sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
  });
  const adapter = new CodexAdapter(
    () => {
      throw new Error("transport must not be created");
    },
    undefined,
    undefined,
    context,
  );
  for (const profile of [
    { model: "gpt-5.6-sol", effortLevel: "default" },
    { model: "kimi-k2.7-code", effortLevel: "high" },
  ]) {
    let failure: unknown;
    try {
      await adapter.start({
        projectDirectory: "C:\\synthetic-project",
        profile: {
          executionMode: "single-agent",
          accessMode: "full-access",
          ...profile,
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof RuntimeAdapterError, JSON.stringify(profile));
    assert.equal(failure.category, "unsupported-selection");
  }
});

test("a kimi-platform start skips the account gate and the native catalog, and puts the true wire name on thread/start", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const home = join(root, "codex-home");
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: { id: "thread-kimi" },
        model: "kimi-k2.7-code",
        reasoningEffort: "default",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { turn: { id: "turn-kimi", status: "inProgress" } },
    }),
  ]);
  const adapter = new CodexAdapter(
    async () => transport,
    undefined,
    undefined,
    kimiPlatformContext({
      homeDirectory: home,
      sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
    }),
  );
  const binding = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: {
      model: "kimi-k2.7-code",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  assert.equal(binding.opaqueSessionReference, "thread-kimi");
  const outbound = transport.recordedOutboundJsonl().join("\n");
  assert.equal(outbound.includes("account/read"), false);
  assert.equal(outbound.includes("model/list"), false);
  const startRequest = transport
    .recordedOutboundJsonl()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((message) => typeof message.method === "string" && message.method === "thread/start");
  assert.ok(startRequest);
  assert.deepEqual(startRequest.params, {
    cwd: "C:\\synthetic-project",
    model: "kimi-k2.7-code",
    config: { model_reasoning_effort: "default" },
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ephemeral: false,
  });
  await transport.stop();
});

test("a kimi-platform resume skips the account gate and validates the static selection", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const context = kimiPlatformContext({
    homeDirectory: join(root, "codex-home"),
    sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
  });
  const resumeResult = {
    activePermissionProfile: null,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "C:\\synthetic-project",
    initialTurnsPage: null,
    instructionSources: [],
    itemsBackwardsCursor: null,
    model: "kimi-k2.7-code",
    modelProvider: "kimi-platform",
    multiAgentMode: "explicitRequestOnly",
    reasoningEffort: "default",
    runtimeWorkspaceRoots: [],
    sandbox: { type: "dangerFullAccess" },
    serviceTier: null,
    thread: {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: "0.147.0-alpha.synthetic",
      createdAt: 1,
      cwd: "C:\\synthetic-project",
      ephemeral: false,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: "thread-kimi",
      modelProvider: "kimi-platform",
      name: null,
      parentThreadId: null,
      path: null,
      preview: "",
      recencyAt: null,
      section: null,
      sectionEnteredAt: null,
      sessionId: "session-kimi",
      source: "appServer",
      status: { type: "idle" },
      threadSource: null,
      turns: [],
      updatedAt: 2,
    },
    turnsBackwardsCursor: null,
  };
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: resumeResult }),
  ]);
  const adapter = new CodexAdapter(
    async () => transport,
    undefined,
    undefined,
    context,
  );
  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: {
      model: "kimi-k2.7-code",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    opaqueSessionReference: "thread-kimi",
  });
  assert.equal(binding.opaqueSessionReference, "thread-kimi");
  const outbound = transport.recordedOutboundJsonl().join("\n");
  assert.equal(outbound.includes("account/read"), false);
  assert.equal(outbound.includes("model/list"), false);
  await transport.stop();

  // A profile outside the static catalog never reaches a spawn on resume.
  const refusingAdapter = new CodexAdapter(
    async () => {
      throw new Error("transport must not be created");
    },
    undefined,
    undefined,
    context,
  );
  let failure: unknown;
  try {
    await refusingAdapter.resume({
      projectDirectory: "C:\\synthetic-project",
      profile: {
        model: "gpt-5.6-sol",
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
      opaqueSessionReference: "thread-kimi",
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "unsupported-selection");
});

test("a kimi-platform resume admits the codex 0.153.4 thread shape and tolerates the resolved effort echo for the unpinned tier", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const context = kimiPlatformContext({
    homeDirectory: join(root, "codex-home"),
    sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
  });
  // The 0.153.4 `thread/resume` reply, measured offline on 2026-09-06
  // (.scratch/glm-endpoint-integration/evidence/codex-0153-resume-wire.md):
  // the thread object grows to 29 keys (+projectId +model +reasoningEffort)
  // and the effort echo resolves the request's "default" against the
  // thread's pinned effort ("high" under the seeded home config).
  const resumeResult = {
    activePermissionProfile: null,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "C:\\synthetic-project",
    initialTurnsPage: null,
    instructionSources: [],
    itemsBackwardsCursor: null,
    model: "kimi-k2.7-code",
    modelProvider: "kimi-platform",
    multiAgentMode: "explicitRequestOnly",
    reasoningEffort: "high",
    runtimeWorkspaceRoots: [],
    sandbox: { type: "dangerFullAccess" },
    serviceTier: null,
    thread: {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: "0.153.4.synthetic",
      createdAt: 1,
      cwd: "C:\\synthetic-project",
      ephemeral: false,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: "thread-kimi",
      model: "kimi-k2.7-code",
      modelProvider: "kimi-platform",
      name: null,
      parentThreadId: null,
      path: null,
      preview: "",
      projectId: "project-synthetic",
      reasoningEffort: "high",
      recencyAt: null,
      section: null,
      sectionEnteredAt: null,
      sessionId: "session-kimi",
      source: "appServer",
      status: { type: "idle" },
      threadSource: null,
      turns: [],
      updatedAt: 2,
    },
    turnsBackwardsCursor: null,
  };
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: resumeResult }),
  ]);
  const adapter = new CodexAdapter(
    async () => transport,
    undefined,
    undefined,
    context,
  );
  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile: {
      model: "kimi-k2.7-code",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
    opaqueSessionReference: "thread-kimi",
  });
  assert.equal(binding.opaqueSessionReference, "thread-kimi");
  await transport.stop();
});

test("vendor Kimi resume: additional thread fields are dropped", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const context = kimiPlatformContext({
    homeDirectory: join(root, "codex-home"),
    sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
  });
  const resumeResult = {
    activePermissionProfile: null,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "C:\\synthetic-project",
    initialTurnsPage: null,
    instructionSources: [],
    itemsBackwardsCursor: null,
    model: "kimi-k2.7-code",
    modelProvider: "kimi-platform",
    multiAgentMode: "explicitRequestOnly",
    reasoningEffort: "high",
    runtimeWorkspaceRoots: [],
    sandbox: { type: "dangerFullAccess" },
    serviceTier: null,
    thread: {
      agentNickname: null,
      agentRole: null,
      canAcceptDirectInput: true,
      cliVersion: "0.153.4.synthetic",
      createdAt: 1,
      cwd: "C:\\synthetic-project",
      ephemeral: false,
      extra: null,
      forkedFromId: null,
      gitInfo: null,
      historyMode: "legacy",
      id: "thread-kimi",
      model: "kimi-k2.7-code",
      modelProvider: "kimi-platform",
      name: null,
      parentThreadId: null,
      path: null,
      preview: "",
      projectId: "project-synthetic",
      reasoningEffort: "high",
      recencyAt: null,
      section: null,
      sectionEnteredAt: null,
      sessionId: "session-kimi",
      source: "appServer",
      status: { type: "idle" },
      threadSource: null,
      turns: [],
      updatedAt: 2,
      unrecognizedFutureField: { redacted_thinking: "UNCONSUMED_VENDOR_CANARY" },
    },
    turnsBackwardsCursor: null,
  };
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: resumeResult }),
  ]);
  const adapter = new CodexAdapter(
    async () => transport,
    undefined,
    undefined,
    context,
  );
  const profile = {
    model: "kimi-k2.7-code",
    effortLevel: "default",
    executionMode: "single-agent",
    accessMode: "full-access",
  };
  const binding = await adapter.resume({
    projectDirectory: "C:\\synthetic-project",
    profile,
    opaqueSessionReference: "thread-kimi",
  });
  assert.equal(binding.opaqueSessionReference, "thread-kimi");
  assert.deepEqual(binding.profile, profile);
  const downstream = JSON.stringify({ profile: binding.profile, outbound: transport.recordedOutboundJsonl() });
  assert.equal(downstream.includes("UNCONSUMED_VENDOR_CANARY"), false);
  assert.equal(downstream.includes("unrecognizedFutureField"), false);
  await transport.stop();
});

test("an endpoint-context adapter without an injected factory builds its transport environment through the factory chain", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const home = join(root, "codex-home");
  // The adapter cannot launch a real codex here (and must not): transport
  // creation resolves the environment first, so a missing key fails before
  // any spawn with authentication-required.
  const adapter = new CodexAdapter(
    undefined,
    undefined,
    undefined,
    kimiPlatformContext({
      homeDirectory: home,
      sourceEnvironment: {
        [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY,
      },
      // Discovery would locate a real executable on this machine; force the
      // deterministic not-located branch so the default transport factory
      // stops before spawning anything.
      discoverExecutable: async () => ({ kind: "not-located" }) as const,
    }),
  );
  let failure: unknown;
  try {
    await adapter.start({
      projectDirectory: "C:\\synthetic-project",
      profile: {
        model: "kimi-k2.7-code",
        effortLevel: "default",
        executionMode: "single-agent",
        accessMode: "full-access",
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof RuntimeAdapterError);
  assert.equal(failure.category, "runtime-not-located");
  // The endpoint preparation ran before the launch attempt (seeding is a
  // precondition of every operation, spawn included).
  const state = ensureKimiPlatformCodexHome({ homeDirectory: home });
  assert.equal(state.restored, false);
});

test("same-turn reasoning, tool items, and willRetry errors surface as coalesced progress (issue #6 case 4)", async (t) => {
  const root = await createTestDirectory(t, join(tmpdir(), "kimi-platform-adapter-"));
  const home = join(root, "codex-home");
  const notification = (method: string, params: unknown): string =>
    JSON.stringify({ jsonrpc: "2.0", method, params });
  const longFilePath = `src/${"nested/".repeat(20)}component.ts`;
  const truncatedLongFilePath = `${Array.from(longFilePath).slice(0, 119).join("")}…`;
  const completedFileChanges = [
    {
      path: "src/agent-runtime/index.ts",
      kind: { type: "update" },
      diff: [
        "--- a/src/agent-runtime/index.ts",
        "+++ b/src/agent-runtime/index.ts",
        "@@ -1,2 +1,3 @@",
        "-old line",
        "+new line",
        "+PRIVATE_DIFF_BODY_MUST_NOT_CROSS",
        " context line",
      ].join("\n"),
    },
    {
      path: "src/no-counts.ts",
      kind: { type: "update" },
      diff: "PRIVATE_MALFORMED_DIFF_MUST_NOT_CROSS",
    },
    {
      path: longFilePath,
      kind: { type: "add" },
      diff: "@@ -0,0 +1 @@\n+new line",
    },
    {
      path: "src/folded.ts",
      kind: { type: "update" },
      diff: "@@ -1 +1 @@\n-old line\n+new line",
    },
  ];
  const transport = new ScriptedTransport([
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { server: "synthetic" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        thread: { id: "thread-kimi" },
        model: "kimi-k2.7-code",
        reasoningEffort: "default",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: { turn: { id: "turn-kimi", status: "inProgress" } },
    }),
    notification("thread/started", {
      threadId: "thread-kimi",
      thread: { id: "thread-kimi" },
    }),
    notification("turn/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      turn: { id: "turn-kimi" },
    }),
    // The input's own wire echo: NOT activity, must stay silent.
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: { type: "userMessage", id: "item-user", content: [] },
    }),
    // Reasoning means thinking...
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: { type: "reasoning", id: "rs-1", summary: [], content: [] },
    }),
    // ...and a consecutive repeat must coalesce, not duplicate.
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: { type: "reasoning", id: "rs-2", summary: [], content: [] },
    }),
    // A provider call failing with willRetry is the CLI retrying -- the
    // signal whose absence made a retrying turn look dead.
    notification("error", {
      error: { message: "synthetic provider hiccup", willRetry: true },
    }),
    // The Codex item has its own type/name and a command field; only that
    // field is fit for the activity label, never the complete item payload.
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: {
        type: "commandExecution",
        id: "command-1",
        name: "Bash",
        command: "pnpm test --filter agent-runtime",
        private_payload: "do not copy this whole item",
      },
    }),
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: {
        type: "fileChange",
        id: "change-1",
        name: "Edit",
        changes: [{ path: "src/agent-runtime/index.ts", diff: "do not copy this" }],
      },
    }),
    notification("item/completed", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: {
        type: "fileChange",
        id: "change-1",
        name: "Edit",
        changes: completedFileChanges,
      },
    }),
    // A new Codex item type remains visible as an unknown tool rather than
    // throwing or disappearing with the generic activity bucket.
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: {
        type: "futureTool",
        id: "future-tool-1",
        name: "Future Tool",
        private_payload: "do not copy this whole item",
      },
    }),
    notification("item/started", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: { type: "agentMessage", id: "item-1", text: "", phase: null },
    }),
    notification("item/completed", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      item: { type: "agentMessage", id: "item-1", text: "PROGRESS-OK", phase: null },
    }),
    notification("turn/completed", {
      threadId: "thread-kimi",
      turnId: "turn-kimi",
      turn: { id: "turn-kimi", status: "completed" },
    }),
  ]);
  const adapter = new CodexAdapter(
    async () => transport,
    undefined,
    undefined,
    kimiPlatformContext({
      homeDirectory: home,
      sourceEnvironment: { [KIMI_PLATFORM_ENDPOINT_ENV_CONTRACT.apiKeyEnvVar]: FAKE_KEY },
    }),
  );
  const binding = await adapter.start({
    projectDirectory: "C:\\synthetic-project",
    profile: {
      model: "kimi-k2.7-code",
      effortLevel: "default",
      executionMode: "single-agent",
      accessMode: "full-access",
    },
  });
  await binding.send({ text: "reply PROGRESS-OK" });
  const events: Array<Record<string, unknown>> = [];
  for await (const event of binding.events()) {
    events.push(event as unknown as Record<string, unknown>);
  }
  assert.deepEqual(events, [
    { kind: "session-started" },
    { kind: "turn-started" },
    { kind: "progress", activity: "thinking" },
    { kind: "progress", activity: "retrying" },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "commandExecution",
        name: "Bash",
        parameter: {
          kind: "command",
          value: "pnpm test --filter agent-runtime",
          truncated: false,
        },
      },
    },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Edit",
        parameter: {
          kind: "path",
          value: "src/agent-runtime/index.ts",
          truncated: false,
        },
      },
    },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "fileChange",
        name: "Edit",
        parameter: {
          kind: "path",
          value: "src/agent-runtime/index.ts",
          truncated: false,
        },
        fileChanges: {
          files: [
            {
              path: "src/agent-runtime/index.ts",
              truncated: false,
              lines: { additions: 2, deletions: 1 },
            },
            {
              path: "src/no-counts.ts",
              truncated: false,
            },
            {
              path: truncatedLongFilePath,
              truncated: true,
              lines: { additions: 1, deletions: 0 },
            },
          ],
          totalFiles: 4,
          truncated: true,
        },
      },
    },
    {
      kind: "progress",
      activity: "tool",
      tool: {
        type: "unknown",
        sourceType: "futureTool",
        name: "Future Tool",
      },
    },
    { kind: "item-started", itemType: "agent-message" },
    { kind: "item-completed", itemType: "agent-message" },
    { kind: "agent-message", text: "PROGRESS-OK" },
    { kind: "turn-completed", status: "completed" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(events),
    /PRIVATE_(?:DIFF_BODY|MALFORMED_DIFF)_MUST_NOT_CROSS/u,
  );
});
