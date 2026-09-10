import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { CodexAdapter } from "../../../src/agent-runtime/codex-adapter.ts";
import { createRuntimeEndpointDirectory } from "../../../src/agent-runtime/runtime-endpoint-directory.ts";
import type { OfficialRuntimeTransport } from "../../../src/agent-runtime/codex/transport.ts";
import { createWorkbenchProjectHost } from "../../../src/workbench-shell/project-host.ts";
import type { WorkbenchHostedProjectView } from "../../../src/workbench-shell/contract.ts";
import { createTestDirectory, registerTestCleanup, registerTestClosable } from "../../helpers/test-lifecycle.ts";

// Same Codex 0.153.4 wire and in-memory transport used by w92's runtime guards.
export function cliQuestion(timeout: number | null = null) {
  return { jsonrpc: "2.0", id: "question-98", method: "item/tool/requestUserInput", params: {
    threadId: "thread-fixed", turnId: "turn-fixed", itemId: "question-item", isBlocking: true,
    autoResolutionMs: timeout,
    questions: [
      { id: "scope", header: "Scope", question: "Which scope?", isOther: true, isSecret: false,
        options: [{ label: "Runtime", description: "Only the runtime" }, { label: "All", description: "Include UI" }] },
      { id: "details", header: "Details", question: "What else?", isOther: false, isSecret: true, options: null },
    ],
  } };
}

class QuestionServer implements OfficialRuntimeTransport {
  readonly outbound: Record<string, any>[] = [];
  readonly lines: string[];
  stopped = false;
  stopCalls = 0;
  stopSawPendingReceive = false;
  holdShutdown = false;
  private releaseStop?: () => void;
  holdResponses = false;
  responseWaiting = false;
  private releaseResponse?: () => void;
  private waiting: ((line: string | null) => void) | undefined;
  constructor(frames: Record<string, any>[]) { this.lines = frames.map(frame => JSON.stringify(frame)); }
  push(frame: Record<string, any>): void {
    const line = JSON.stringify(frame);
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting(line); }
    else this.lines.push(line);
  }
  async send(line: string): Promise<void> {
    const frame = JSON.parse(line);
    if (this.holdResponses && "result" in frame) {
      this.responseWaiting = true;
      await new Promise<void>(resolve => { this.releaseResponse = resolve; });
      if (this.stopped) throw new Error("synthetic closed response pipe");
    }
    this.outbound.push(frame);
    if ("result" in frame) this.push({
      method: "serverRequest/resolved",
      params: { threadId: "thread-fixed", requestId: frame.id },
    });
  }
  async receive(): Promise<string | null> {
    if (this.lines.length) return this.lines.shift()!;
    if (this.stopped) return null;
    return new Promise(resolve => { this.waiting = resolve; });
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    this.stopSawPendingReceive = this.waiting !== undefined;
    if (this.holdShutdown) await new Promise<void>(resolve => { this.releaseStop = resolve; });
    this.releaseShutdown();
  }
  releaseShutdown(): void {
    this.holdShutdown = false;
    this.stopped = true;
    this.waiting?.(null);
    this.waiting = undefined;
    this.releaseResponse?.();
    this.releaseStop?.();
  }
}

export async function createQuestionWorkbench(t: TestContext) {
  const root = await createTestDirectory(t, join(tmpdir(), "uaw99-"));
  const project = join(root, "p");
  await mkdir(project);
  const frames = (await readFile(new URL("../../agent-runtime/fixtures/single-turn-success.jsonl", import.meta.url), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const servers: QuestionServer[] = [];
  const nativeProfile = { model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access" };
  const profile = { ...nativeProfile, model: "directory-model" };
  const adapter = createRuntimeEndpointDirectory([{
    registrationId: "question-registration", endpointId: "question-endpoint", runtimeFamily: "codex",
    executionLocation: "local", adapter: new CodexAdapter(async () => {
      const server = new QuestionServer(frames.slice(0, 7)); servers.push(server); return server;
    }),
    capabilitySnapshot: {
      snapshotId: "question-snapshot", freshness: "fresh", availability: "online",
      contracts: { supervisorWorkOrders: true, workerSessions: true, normalizedEvents: true },
      profiles: [{ profileId: "question-profile", modelLabel: "Codex", workIntensityLabel: "Ultra", runtimeProfile: profile, nativeRuntimeProfile: nativeProfile }],
    },
    policy: { maximumBudgetUnits: 0, availableConcurrency: 1, allowedAccessModes: ["full-access"], allowedWorkerEndpointIds: [] },
  }]).runtimeAdapter();
  const host = await createWorkbenchProjectHost({ dataDirectory: join(root, "d"), fallbackProjectDirectory: project, adapter });
  registerTestClosable(t, host);
  registerTestCleanup(t, () => { for (const server of servers) server.releaseShutdown(); });
  let view: WorkbenchHostedProjectView | undefined;
  const dispose = host.observeProject(result => { if (result.ok && "view" in result) view = result.view; });
  registerTestCleanup(t, dispose);
  const loaded = await host.loadDirectSessionProfile({ kind: "catalog-default" });
  assert.ok(loaded.ok, JSON.stringify(loaded));
  const endpoint = loaded.profile.endpoints[0];
  const model = endpoint.models[0];
  const started = await host.submitDirectInput({ kind: "start", input: "Ask a question", snapshotKey: loaded.profile.snapshotKey,
    endpointKey: endpoint.key, modelKey: model.key, workIntensityKey: model.workIntensities[0].key,
    executionModeKey: endpoint.executionModes[0].key, accessModeKey: endpoint.accessModes[0].key });
  assert.equal(started.ok, true);
  await waitFor(() => !!servers[0]?.outbound.some(frame => frame.method === "turn/start") && !!view?.commands[0]?.session?.metadataKey);
  return {
    host, root, servers,
    view: () => { assert.ok(view); return view; },
    ask: (timeout: number | null = null) => servers.at(-1)!.push(cliQuestion(timeout)),
    finish: () => { for (const frame of frames.slice(7)) servers.at(-1)!.push(frame); },
  };
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 5000) {
  const until = Date.now() + timeout;
  while (!(await predicate())) {
    assert.ok(Date.now() < until, "loopback observation did not arrive before deadline");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
