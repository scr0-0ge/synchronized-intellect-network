import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderToString } from "solid-js/web";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { ClaudeAdapter } from "../../src/agent-runtime/claude/adapter.ts";
import { createRuntimeEndpointDirectory } from "../../src/agent-runtime/runtime-endpoint-directory.ts";
import { createWorkbenchProjectHost } from "../../src/workbench-shell/project-host.ts";
import { sanitizeWorkbenchHostedProjectResult } from "../../src/workbench-shell/result-sanitizer.ts";
import { publicContinuationUnavailable, type WorkbenchHostedProjectView } from "../../src/workbench-shell/contract.ts";
import { createTestDirectory, registerTestClosable, registerTestCleanup } from "../helpers/test-lifecycle.ts";
import { quotaEndpoint, quotaProfile, quotaFrames, quotaResumedFrames, QuotaReplayTransport } from "../agent-runtime/fixtures/claude-quota-replay.ts";
import { initialRendererState, beginDirectSessionProfileLoad, completeDirectSessionProfileLoad,
  beginDirectInputSubmission, completeDirectInputSubmission, directInputMode } from "../../src/workbench-shell/renderer/view-model.ts";
import { presentationText } from "../../src/workbench-shell/renderer/presentation-text.ts";

test("production host and sanitizer expose quota pause and accept only explicit same-Session continuation", async t => {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw114-host-"));
  const project = join(root, "p");
  await mkdir(project);
  const transports: QuotaReplayTransport[] = [];
  const native = new ClaudeAdapter(undefined, async request => {
    assert.equal(request.resumeSessionIdentity, transports.length === 0 ? undefined : quotaFrames[0].session_id);
    const transport = new QuotaReplayTransport(transports.length === 0 ? quotaFrames : quotaResumedFrames);
    transports.push(transport);
    return transport;
  }, undefined, { readPermissionMode: async () => "manual" }, undefined, undefined, quotaEndpoint);
  const adapter = createRuntimeEndpointDirectory([{
    registrationId: "quota", endpointId: "quota-endpoint", runtimeFamily: "claude", executionLocation: "local", adapter: native,
    capabilitySnapshot: { snapshotId: "quota-catalog", freshness: "fresh", availability: "online",
      contracts: { supervisorWorkOrders: true, workerSessions: true, normalizedEvents: true },
      profiles: [{ profileId: "quota-profile", modelLabel: "GLM", workIntensityLabel: "High", runtimeProfile: quotaProfile, nativeRuntimeProfile: quotaProfile }],
    },
    policy: { maximumBudgetUnits: 0, availableConcurrency: 1, allowedAccessModes: ["full-access"], allowedWorkerEndpointIds: [] },
  }]).runtimeAdapter();
  const host = await createWorkbenchProjectHost({ dataDirectory: join(root, "d"), fallbackProjectDirectory: project, adapter });
  registerTestClosable(t, host);
  let view: WorkbenchHostedProjectView | undefined;
  registerTestCleanup(t, host.observeProject(result => {
    const safe = sanitizeWorkbenchHostedProjectResult(result);
    if (safe.ok && "view" in safe) view = safe.view;
  }));
  const profile = await host.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.ok(profile.ok);
  const endpoint = profile.profile.endpoints[0], model = endpoint.models[0];
  assert.equal((await host.submitDirectInput({ kind: "start", input: "INITIAL", snapshotKey: profile.profile.snapshotKey,
    endpointKey: endpoint.key, modelKey: model.key, workIntensityKey: model.workIntensities[0].key,
    executionModeKey: endpoint.executionModes[0].key, accessModeKey: endpoint.accessModes[0].key })).ok, true);
  const wait = async (status: string) => {
    const until = performance.now() + 3000;
    while (view?.commands[0]?.status !== status) {
      assert.ok(performance.now() < until, `expected ${status}, observed ${view?.commands[0]?.status}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return view;
  };
  const paused = await wait("quota-paused");
  const selectionKey = paused.commands[0].session!.selectionKey;
  assert.ok(selectionKey);
  assert.equal(paused.commands[0].session?.resumable, true);
  assert.deepEqual(paused.commands[0].session?.timeline.at(-1), { kind: "turn-paused", reason: "quota-exhausted" });
  assert.equal(transports.length, 1);
  const continuation = await host.loadDirectSessionProfile({ kind: "continuation-session", selectionKey });
  assert.ok(continuation.ok);
  assert.equal(transports.length, 1, "loading the resume choice is not a request to the provider");
  const load = { kind: "continuation-session" as const, selectionKey };
  const state = completeDirectSessionProfileLoad(beginDirectSessionProfileLoad({ ...initialRendererState,
    result: { ok: true, view: paused }, selectedKey: paused.commands[0].key }, load), continuation, load);
  assert.equal(directInputMode(state), "continue");
  assert.equal(beginDirectInputSubmission(state).request, null, "no automatic replay of rejected input");
  const ready = { ...state, composer: { ...state.composer, draft: "EXPLICIT_NEW_INPUT" } };
  const submission = beginDirectInputSubmission(ready);
  assert.equal(submission.request?.kind, "continue");
  assert.ok(submission.request);

  const server = await createServer({ appType: "custom", configFile: false, logLevel: "silent",
    plugins: [solid({ ssr: true })], server: { middlewareMode: true } });
  try {
    const module = await server.ssrLoadModule("/src/workbench-shell/renderer/composer.tsx");
    const locale = await server.ssrLoadModule("/src/workbench-shell/renderer/locale.ts");
    const render = (draft: string, composer = ready.composer) => renderToString(() => module.DirectInputComposer({
      ...ready, view: paused, selected: paused.commands[0], composer: { ...composer, draft }, centered: false,
      onDraft() {}, onNavigateComposerHistory() {}, onLoadProfile() {}, onEnterNewSession() {}, onCancelNewSession() {},
      onEndpoint() {}, onModel() {}, onWorkIntensity() {}, onExecutionMode() {}, onAccessMode() {}, onUseAsDefault() {}, onSubmit() {},
    }));
    const english = render("EXPLICIT_NEW_INPUT");
    assert.match(english, /class="send submit-button"[^>]*>(?:<!--.*?-->)*Resume/u);
    assert.doesNotMatch(english, /class="send submit-button"[^>]*disabled/u);
    assert.match(english, /id="direct-model"[^>]*disabled/u);
    assert.match(english, /id="direct-work-intensity"[^>]*disabled/u);
    assert.match(english, /No automatic retry/u);
    assert.match(render(""), /class="send submit-button"[^>]*disabled/u);
    const unavailable = completeDirectInputSubmission(submission.state, publicContinuationUnavailable());
    const feedback = presentationText(unavailable.composer.feedback)!;
    assert.ok(render("EXPLICIT_NEW_INPUT", unavailable.composer).includes(feedback), "resume refusal must stay visible, not be hidden behind the quota notice");
    locale.setLocale("zh-CN");
    const chinese = render("请继续处理上一条任务");
    assert.match(chinese, /此次请求未执行/u);
    assert.match(chinese, /class="send submit-button"[^>]*>(?:<!--.*?-->)*恢复/u);
    const transcript = await server.ssrLoadModule("/src/workbench-shell/renderer/transcript.tsx");
    const expired = { ...paused.commands[0], status: "failed", failureCategory: "quota-expired",
      session: { ...paused.commands[0].session, resumable: false, selectionKey: null } };
    const expiredHtml = renderToString(() => transcript.SessionTranscript({ command: expired }));
    assert.match(expiredHtml, /额度等待已到期，未自动重试/u);
    assert.doesNotMatch(expiredHtml, /运行时报告了固定失败/u);
    if (process.env.UAW114_RENDER_PREVIEW === "1") {
      await mkdir("test-results/w114", { recursive: true });
      await writeFile("test-results/w114/quota.html", `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Quota pause — actual composer</title><link rel="stylesheet" href="../../src/workbench-shell/renderer/styles.css"><body><main style="padding:24px;max-width:1000px;margin:auto"><h2>额度耗尽 · 已暂停</h2>${chinese}<h2>English</h2>${english}</main></body></html>`);
    }
  } finally { await server.close(); }

  const result = await host.submitDirectInput(submission.request);
  assert.equal(result.ok, true, JSON.stringify(result));
  await wait("completed");
  assert.equal(transports.length, 2);
  assert.deepEqual(transports[1].sent.filter(frame => frame.type === "user").map(frame => frame.message.content[0].text), ["EXPLICIT_NEW_INPUT"]);
  assert.equal(view?.commands.length, 1, "resume does not replace the Workbench Session");
});
