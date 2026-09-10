import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "solid-js/web";
import solid from "vite-plugin-solid";
import { createViteSsrTestServer } from "../helpers/vite-server.ts";
import {
  RuntimeAdapterError,
  type AgentRuntimeAdapter,
  type RuntimeBinding,
  type RuntimeCatalog,
  type RuntimeStart,
} from "../../src/agent-runtime/index.ts";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import { createWorkbenchCoordinator, type ProjectChannel } from "../../src/coordinator/index.ts";
import { createWorkbenchBackend } from "../../src/workbench-shell/backend.ts";
import { WORKBENCH_RUNTIME_FAILURE_CATEGORIES, type WorkbenchCommandView, type WorkbenchProjectResult, type WorkbenchTimelineEvent } from "../../src/workbench-shell/contract.ts";
import { createWorkbenchLiveView } from "../../src/workbench-shell/live-view.ts";
import { sanitizeWorkbenchProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { createTestDirectory, registerTestClosable } from "../helpers/test-lifecycle.ts";

class ExecutionInspectionFailureAdapter implements AgentRuntimeAdapter {
  inspectCalls = 0;
  startCalls = 0;
  private readonly failure: unknown;

  constructor(failure: unknown) {
    this.failure = failure;
  }

  async inspect(): Promise<RuntimeCatalog> {
    this.inspectCalls += 1;
    if (this.inspectCalls > 1) throw this.failure;
    return {
      runtime: "codex",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "gpt-5.6-sol",
        effortLevels: ["low", "ultra"],
        effortLevelLabels: ["low", "ultra"],
      }],
      executionModes: ["single-agent"],
      accessModes: ["full-access"],
    };
  }

  async start(_request: RuntimeStart): Promise<RuntimeBinding> {
    this.startCalls += 1;
    throw new Error("start must not run after failed execution inspection");
  }
}

async function executionInspectionFailedCommand(
  t: TestContext,
  failure: unknown,
): Promise<WorkbenchCommandView> {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw156-execution-inspection-"));
  const adapter = new ExecutionInspectionFailureAdapter(failure);
  const backend = await createWorkbenchBackend({
    projectDirectory: root,
    databasePath: join(root, "ledger.sqlite"),
    adapter,
  });
  registerTestClosable(t, backend);
  let resolveFailure!: (result: WorkbenchProjectResult) => void;
  const failed = new Promise<WorkbenchProjectResult>(resolve => { resolveFailure = resolve; });
  const dispose = backend.observeProject(result => {
    if (result.ok && result.view.commands[0]?.status === "failed") resolveFailure(result);
  });
  t.after(dispose);
  const loaded = await backend.loadDirectSessionProfile({ kind: "catalog-default" });
  if (!loaded.ok || loaded.profile.desiredDefault.kind !== "resolved") {
    assert.fail("the first inspection must resolve a selectable profile");
  }
  const selected = loaded.profile.desiredDefault;
  assert.equal((await backend.submitDirectInput({
    kind: "start",
    input: "Exercise the execution-time catalog re-check.",
    snapshotKey: loaded.profile.snapshotKey,
    endpointKey: selected.endpointKey,
    modelKey: selected.modelKey,
    workIntensityKey: selected.workIntensityKey,
    executionModeKey: selected.executionModeKey,
    accessModeKey: selected.accessModeKey,
  })).ok, true);
  const result = sanitizeWorkbenchProjectResult(await failed);
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("the failed command must remain visible");
  assert.deepEqual(
    { inspectCalls: adapter.inspectCalls, startCalls: adapter.startCalls },
    { inspectCalls: 2, startCalls: 0 },
  );
  return result.view.commands[0]!;
}

// Public projection of the original real capture. It preserves the admitted
// failure wire while omitting owner paths, Session identity and unused fields.
const capture = JSON.parse(readFileSync(new URL(
  "../agent-runtime/fixtures/claude-quota-wire.json", import.meta.url,
), "utf8"));
const frames = capture.glmQuotaFrames;
const start = frames.findIndex((frame: any) => frame.type === "system" && frame.subtype === "init");
const init = frames[start];
const profile = { model: init.model as string, effortLevel: "xhigh", executionMode: "single-agent", accessMode: "full-access" };

async function failedProject(t: TestContext) {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw138-failure-"));
  const databasePath = join(root, "ledger.sqlite");
  const adapter = {
    async inspect() { return { runtime: "claude", models: [{ id: profile.model, effortLevels: ["xhigh"] }],
      executionModes: ["single-agent"], accessModes: ["full-access"] }; },
    async start() {
      const lines = frames.slice(start).map((frame: unknown) => JSON.stringify(frame));
      return new ClaudeRuntimeBinding({
        transport: { async send() {}, async receive() { return lines.shift() ?? null; }, async stop() {} },
        profile, expectedModel: profile.model, opaqueSessionReference: "offline-failure-capability",
        permissionMode: "manual", stopHookCallbackId: "unused-stop-hook", ultracodeConfirmed: true,
        observeSessionIdentity: identity => assert.equal(identity, init.session_id),
      });
    },
    async resume() { throw new Error("No resume requested by this failure test"); },
  };
  const open = () => createWorkbenchCoordinator({ databasePath, adapter }).openProject(root);
  const channel = await open();
  registerTestClosable(t, channel);
  const receipt = await channel.act({ kind: "direct", commandKind: "start", idempotencyKey: "captured-failure",
    // The coordinator envelope still uses the historical "codex" discriminator
    // for every routed adapter, including Claude.
    runtime: "codex", catalogRevision: "offline-capture", preferences: { global: profile }, profile, input: "offline capture replay" });
  for await (const update of channel.observe({ after: receipt.acceptedCursor })) {
    if (update.kind === "failed" || update.kind === "completed" || update.kind === "recovery-required") break;
  }
  return { channel, open, root };
}

async function publicView(t: TestContext, channel: ProjectChannel, root: string) {
  const live = createWorkbenchLiveView({ channel, projectDirectory: root });
  registerTestClosable(t, live);
  let receive!: (value: WorkbenchProjectResult) => void;
  const first = new Promise<WorkbenchProjectResult>(resolve => { receive = resolve; });
  const dispose = live.observe(receive);
  const result = sanitizeWorkbenchProjectResult(await first);
  dispose();
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected the captured failed turn to stay visible");
  return result;
}

test("the real captured failed turn keeps its admitted reason through durable readback and the renderer boundary", async t => {
  const { channel, open, root } = await failedProject(t);
  const recorded = await channel.snapshot();
  assert.equal(recorded.commands[0]?.status, "failed");
  assert.deepEqual(recorded.commands[0]?.session?.events.at(-1), { kind: "failed", category: "turn-failed" });
  await channel.close();
  const reopened = await open();
  registerTestClosable(t, reopened);
  const result = await publicView(t, reopened, root);
  assert.deepEqual(result.view.commands[0]?.session?.timeline.at(-1), { kind: "failed", category: "turn-failed" });
  assert.doesNotMatch(JSON.stringify(result), /API Error:|1310|redacted-request-id/);
});

function withTimeline(command: WorkbenchCommandView, timeline: readonly WorkbenchTimelineEvent[]): WorkbenchCommandView {
  assert.ok(command.session);
  return { ...command, session: { ...command.session, timeline, turns: [{ profile: command.session.profile, timeline }] } };
}

test("real transcript explains an observed failure and does not invent a missing reason", async t => {
  const { channel, root } = await failedProject(t);
  const result = await publicView(t, channel, root);
  const command = result.view.commands[0]!;
  const server = await createViteSsrTestServer({ appType: "custom", configFile: false, logLevel: "silent",
    plugins: [solid({ ssr: true })], root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true } });
  try {
    const { SessionTranscript } = await server.ssrLoadModule("/src/workbench-shell/renderer/transcript.tsx");
    const { setLocale } = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
    setLocale("en");
    const failureText = (value: WorkbenchCommandView) => {
      const html = renderToString(() => SessionTranscript({ command: value }));
      const block = html.match(/<div[^>]*class="failure-block"[^>]*>([\s\S]*?)<\/div>/u)?.[1];
      assert.ok(block, "the actual transcript must show its failure block");
      return block.replace(/<[^>]*>/gu, "");
    };
    await t.test("captured turn failure", () => {
      assert.match(failureText(command), /The runtime reported that this turn failed/u);
    });
    await t.test("authentication is named, not softened", () => {
      assert.match(failureText(withTimeline(command, [{ kind: "failed", category: "authentication-required" }])), /Authentication is required.*Settings/u);
    });
    await t.test("missing category is unknown", () => {
      assert.match(failureText(withTimeline(command, [{ kind: "failed" }])), /Unknown failure/u);
    });
    const expected = {
      "approval-required": [/Permission approval is required/u, /需要权限审批/u],
      "authentication-required": [/Authentication is required/u, /认证失败或尚未登录/u],
      "catalog-invalid": [/invalid model or capability catalog/u, /模型或能力目录无效/u],
      "correlation-invalid": [/could not be matched/u, /无法将运行时回复对应/u],
      "invalid-input": [/invalid input or operation/u, /输入或操作不符合/u],
      "protocol-invalid": [/unrecognized protocol message/u, /无法识别的协议消息/u],
      "protocol-rejected": [/runtime refused the request/u, /运行时拒绝了请求/u],
      "runtime-shutdown": [/shutdown could not be confirmed/u, /无法确认它已退出/u],
      "runtime-not-located": [/CLI executable could not be found/u, /未找到 CLI 可执行文件/u],
      "runtime-unavailable": [/runtime is unavailable/u, /运行时不可用/u],
      "temp-cleanup": [/temporary files could not be cleaned up/u, /无法清理运行时临时文件/u],
      "temp-cleanup-guard": [/not an approved cleanup target/u, /临时目录路径不符合清理范围/u],
      "transport-failed": [/Communication with the runtime failed/u, /与运行时的通信失败/u],
      "turn-failed": [/without a more specific reason/u, /未提供更具体的原因/u],
      "unexpected-server-request": [/interaction this Workbench cannot handle/u, /Workbench 无法处理的交互/u],
      "unsupported-selection": [/model, work intensity or mode is not supported/u, /模型、工作强度或模式不受支持/u],
    } as const;
    for (const category of WORKBENCH_RUNTIME_FAILURE_CATEGORIES) {
      await t.test(`${category}: both locales name the reason and offer a next step`, () => {
        for (const [index, locale] of ["en", "zh-CN"].entries()) {
          setLocale(locale);
          const text = failureText(withTimeline(command, [{ kind: "failed", category }]));
          assert.match(text, expected[category][index]!);
          assert.match(text, index === 0 ? /Check|check|Open Settings|Refresh/u : /请/u);
          assert.doesNotMatch(text, /fixed failure|固定失败|稍后会自动|automatically resume/u);
        }
      });
    }
    for (const legacy of [false, true]) {
      await t.test(`latest missing reason never borrows an earlier failure (${legacy ? "legacy" : "turn slices"})`, () => {
        const prior: WorkbenchTimelineEvent[] = [{ kind: "failed", category: "authentication-required" }];
        for (const current of [[], [{ kind: "user-message", text: "next request" }], [{ kind: "failed" }]] as WorkbenchTimelineEvent[][]) {
          const value = withTimeline(command, [...prior, ...current]);
          const session = value.session!;
          const { turns: _turns, ...withoutTurns } = session;
          // An empty legacy timeline is the only representation that records
          // no current turn boundary; do not construct a misleading old failure.
          const scoped = legacy
            ? { ...withoutTurns, timeline: current.length === 0 ? [] : session.timeline }
            : { ...session, turns: [{ profile: session.profile, timeline: prior }, { profile: session.profile, timeline: current }] };
          for (const locale of ["en", "zh-CN"]) {
            setLocale(locale);
            const text = failureText({ ...value, session: scoped });
            assert.match(text, locale === "en" ? /Unknown failure/u : /未知失败/u);
            assert.doesNotMatch(text, /Authentication is required|认证失败或尚未登录/u);
          }
        }
      });
    }

  } finally { await server.close(); }
});

// Closed contract controls, not additional claims about the captured provider wire.
test("the public boundary preserves every admitted reason and rejects unknown values or raw extras", async t => {
  const { channel, root } = await failedProject(t);
  const result = await publicView(t, channel, root);
  const command = result.view.commands[0]!;
  const projectWith = (event: unknown) => ({ ...result,
    view: { ...result.view, commands: [withTimeline(command, [event as WorkbenchTimelineEvent])] } });
  for (const category of WORKBENCH_RUNTIME_FAILURE_CATEGORIES) {
    const event = { kind: "failed", category };
    const sanitized = sanitizeWorkbenchProjectResult(projectWith(event));
    assert.equal(sanitized.ok, true, category);
    if (sanitized.ok) assert.deepEqual(sanitized.view.commands[0]?.session?.timeline, [event]);
  }
  const legacy = sanitizeWorkbenchProjectResult(projectWith({ kind: "failed" }));
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.deepEqual(legacy.view.commands[0]?.session?.timeline, [{ kind: "failed" }]);
  for (const event of [
    { kind: "failed", category: "vendor-private-error" },
    { kind: "failed", category: 0 },
    { kind: "failed", category: "turn-failed", rawError: "UNADMITTED_WIRE" },
    { kind: "failed", rawError: "UNADMITTED_WIRE" },
  ]) {
    const sanitized = sanitizeWorkbenchProjectResult(projectWith(event));
    assert.equal(sanitized.ok, false, JSON.stringify(event));
    assert.doesNotMatch(JSON.stringify(sanitized), /UNADMITTED_WIRE|vendor-private-error/u);
  }
});

test("execution-time runtime discovery failure names the missing CLI in the transcript", async t => {
  const command = await executionInspectionFailedCommand(
    t,
    new RuntimeAdapterError("runtime-not-located"),
  );
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true },
  });
  try {
    const { SessionTranscript } = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript.tsx",
    );
    const html = renderToString(() => SessionTranscript({ command }));
    const block = html.match(
      /<div[^>]*class="failure-block"[^>]*>([\s\S]*?)<\/div>/u,
    )?.[1];
    assert.ok(block, "the actual transcript must show its failure block");
    const text = block.replace(/<[^>]*>/gu, "");
    assert.match(text, /CLI executable could not be found.*Settings/u);
    assert.doesNotMatch(text, /Unknown failure/u);
  } finally {
    await server.close();
  }
});

test("execution-time authentication stays distinct from an unclassified failure", async t => {
  const command = await executionInspectionFailedCommand(
    t,
    new RuntimeAdapterError("authentication-required"),
  );
  const unclassified = await executionInspectionFailedCommand(
    t,
    new Error("unclassified execution inspection failure"),
  );
  const server = await createViteSsrTestServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ ssr: true })],
    root: fileURLToPath(new URL("../..", import.meta.url)),
    server: { middlewareMode: true },
  });
  try {
    const { SessionTranscript } = await server.ssrLoadModule(
      "/src/workbench-shell/renderer/transcript.tsx",
    );
    const failureText = (value: WorkbenchCommandView): string => {
      const html = renderToString(() => SessionTranscript({ command: value }));
      const block = html.match(
        /<div[^>]*class="failure-block"[^>]*>([\s\S]*?)<\/div>/u,
      )?.[1];
      assert.ok(block, "the actual transcript must show its failure block");
      return block.replace(/<[^>]*>/gu, "");
    };
    assert.match(failureText(command), /Authentication is required.*Settings/u);
    assert.doesNotMatch(failureText(command), /Unknown failure/u);
    assert.match(failureText(unclassified), /Unknown failure/u);
    assert.doesNotMatch(
      failureText(unclassified),
      /Authentication is required|CLI executable could not be found|unclassified execution inspection failure/u,
    );
  } finally {
    await server.close();
  }
});
