import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { RuntimeAdapterError, type NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { createOfficialCodexTransport, launchCodexRuntime } from "../../src/agent-runtime/codex/process-transport.ts";
import type { CodexExecutableHandle } from "../../src/agent-runtime/codex/executable-discovery.ts";
import { ScriptedTransport } from "./support/scripted-transport.ts";

const profile = {
  model: "kimi-k2.7-code",
  effortLevel: "high",
  executionMode: "single-agent",
  accessMode: "full-access",
};

async function frames(): Promise<Record<string, any>[]> {
  const contents = await readFile(new URL("./fixtures/kimi-responses-turn.jsonl", import.meta.url), "utf8");
  return contents.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function observe(messages: Record<string, any>[]) {
  const transport = new ScriptedTransport(messages.map((message) => JSON.stringify(message)));
  const binding = await new CodexAdapter(async () => transport).start({
    projectDirectory: "C:\\synthetic-project",
    profile,
  });
  await binding.send({ text: "fixed input" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) events.push(event);
  assert.equal(transport.recordedStopCalls(), 1);
  return events;
}

test("CLI drift: missing or reshaped token usage disables the meter, not the completed turn", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  for (const [name, mutate] of [
    ["missing field", (usage: Record<string, any>) => { delete usage.last.cacheWriteInputTokens; }],
    ["changed shape", (usage: Record<string, any>) => { usage.modelContextWindow = { tokens: 249036 }; }],
  ] as const) await t.test(name, async () => {
    const messages = await frames();
    const usageFrame = messages.find((message) => message.method === "thread/tokenUsage/updated")!;
    // A good reading first must not survive as a stale reading after drift.
    messages.splice(messages.indexOf(usageFrame), 0, structuredClone(usageFrame));
    mutate(usageFrame.params.tokenUsage);
    const events = await observe(messages);
    assert.deepEqual(events.at(-1), { kind: "turn-completed", status: "completed" });
    assert.deepEqual(events.filter((event) => event.kind === "agent-message"), [
      { kind: "agent-message", text: "FIXED_MARKER" },
    ]);
    assert.match(diagnostics.pop() ?? "", /Codex CLI.*tokenUsage.*context.*unavailable/iu);
  });
});

test("CLI drift: reshaped optional reasoning is not forwarded and does not discard the answer", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  for (const [name, mutate] of [
    ["delta", (messages: Record<string, any>[]) => {
      messages.find((message) => message.method === "item/reasoning/summaryTextDelta")!.params.delta = { text: "DO_NOT_FORWARD" };
    }],
    ["summary", (messages: Record<string, any>[]) => {
      messages.find((message) => message.method === "item/completed" && message.params.item.type === "reasoning")!.params.item.summary = [{ text: "DO_NOT_FORWARD" }];
    }],
  ] as const) await t.test(name, async () => {
    const messages = await frames();
    mutate(messages);
    const events = await observe(messages);
    assert.equal(events.at(-1)?.kind, "turn-completed");
    assert.deepEqual(events.filter((event) => event.kind === "agent-message"), [
      { kind: "agent-message", text: "FIXED_MARKER" },
    ]);
    assert.equal(JSON.stringify(events).includes("DO_NOT_FORWARD"), false);
    if (name === "delta") assert.equal(events.some((event) => event.kind === "reasoning"), false);
    assert.match(diagnostics.pop() ?? "", /Codex CLI.*reasoning.*unrecognized.*unavailable/iu);
  });
});

test("CLI drift: an unknown advisory with array params is ignored without losing the answer", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  const messages = await frames();
  messages.splice(messages.findIndex((message) => message.method === "turn/completed"), 0, {
    jsonrpc: "2.0", method: "future/advisory", params: ["DO_NOT_FORWARD"],
  });
  const events = await observe(messages);
  assert.equal(events.at(-1)?.kind, "turn-completed");
  assert.equal(JSON.stringify(events).includes("DO_NOT_FORWARD"), false);
  assert.match(diagnostics.join("\n"), /Codex CLI.*notification.*unrecognized.*ignored/iu);
});

test("CLI drift: missing access confirmation stays rejected with a CLI-specific diagnosis", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  const messages = await frames();
  delete messages.find((message) => message.id === 4)!.result.sandbox;
  const transport = new ScriptedTransport(messages.map((message) => JSON.stringify(message)));
  await assert.rejects(new CodexAdapter(async () => transport).start({ projectDirectory: "project", profile }), RuntimeAdapterError);
  assert.equal(transport.recordedStopCalls(), 1);
  assert.equal(transport.recordedOutboundJsonl().some((line) => JSON.parse(line).method === "turn/start"), false);
  assert.match(diagnostics.join("\n"), /Codex CLI.*startup.*unrecognized.*permissions.*no turn/iu);
});

test("CLI drift: an unrecognized model-list envelope rejects selection with a specific diagnosis", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  const messages = await frames();
  messages.find((message) => message.id === 3)!.result = { models: [] };
  const transport = new ScriptedTransport(messages.map((message) => JSON.stringify(message)));
  await assert.rejects(new CodexAdapter(async () => transport).inspect("project"),
    (error: unknown) => error instanceof RuntimeAdapterError && error.category === "catalog-invalid");
  assert.equal(transport.recordedStopCalls(), 1);
  assert.match(diagnostics.join("\n"), /Codex CLI.*model\/list.*unrecognized.*selection.*unavailable/iu);
});

test("CLI drift: future and garbage --version output do not gate the app-server wire", async (t) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "w72-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./fixtures/future-codex-cli.mjs", import.meta.url));
  for (const version of ["codex-cli 9999.0.0-future", "not a version at all"]) await t.test(version, async () => {
    const environment = { SystemRoot: process.env.SystemRoot, CODEX_HOME: home, UAW_TEST_CODEX_VERSION: version };
    const result = await promisify(execFile)(process.execPath, [script, "--version"], { env: environment, windowsHide: true });
    assert.equal(result.stdout.trim(), version);
    const transport = await createOfficialCodexTransport({
      discoverExecutable: async () => ({ kind: "located", executable: {} as CodexExecutableHandle }),
      launchExecutable: async (_handle, env) => launchCodexRuntime({ executable: process.execPath, prefixArguments: [script] }, undefined, env),
      stageExecutable: async () => { throw new Error("The stub must not stage any runtime files"); },
      removeCleanupDirectory: async () => { throw new Error("No runtime staging directory is expected"); },
      recordDiagnostic: () => {},
      waitForExit: async (child, milliseconds) => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        return new Promise<boolean>((resolve) => {
          const done = (exited: boolean) => { clearTimeout(timer); child.off("exit", onExit); resolve(exited); };
          const onExit = () => done(true);
          const timer = setTimeout(() => done(false), milliseconds);
          child.once("exit", onExit);
        });
      },
    }, { environment });
    try {
      const binding = await new CodexAdapter(async () => transport).start({ projectDirectory: home, profile });
      await binding.send({ text: "offline test" });
      const events: NormalizedRuntimeEvent[] = [];
      for await (const event of binding.events()) events.push(event);
      assert.equal(events.at(-1)?.kind, "turn-completed");
      assert.equal(JSON.stringify(events).includes("UNCONSUMED_VENDOR_CANARY"), false);
      assert.deepEqual(events.filter((event) => event.kind === "agent-message"), [{ kind: "agent-message", text: "FIXED_MARKER" }]);
    } finally {
      await transport.stop();
    }
  });
});

test("CLI drift does not waive correlation, approval, server-request, or final-answer validation", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  for (const [name, category, mutate] of [
    ["usage turn identity", "correlation-invalid", (messages: Record<string, any>[]) => {
      messages.find((message) => message.method === "thread/tokenUsage/updated")!.params.turnId = "wrong-turn";
    }],
    ["missing usage identity", "correlation-invalid", (messages: Record<string, any>[]) => {
      delete messages.find((message) => message.method === "thread/tokenUsage/updated")!.params.threadId;
    }],
    ["new server request", "unexpected-server-request", (messages: Record<string, any>[]) => {
      messages.splice(7, 0, { method: "future/request", id: "server-id", params: [] });
    }],
    ["approval", "approval-required", (messages: Record<string, any>[]) => {
      messages.splice(7, 0, { method: "item/permissions/requestApproval", params: [] });
    }],
    ["unknown final phase", "correlation-invalid", (messages: Record<string, any>[]) => {
      messages.find((message) => message.method === "item/completed" && message.params.item.type === "agentMessage")!.params.item.phase = "future-phase";
    }],
  ] as const) await t.test(name, async () => {
    const messages = await frames();
    mutate(messages);
    // Server requests may arrive while send() is still awaiting its receipt.
    let events: NormalizedRuntimeEvent[];
    try {
      events = await observe(messages);
    } catch (error) {
      assert.ok(error instanceof RuntimeAdapterError);
      assert.equal(error.category, category);
      return;
    }
    assert.deepEqual(events.at(-1), { kind: "failed", category });
    if (name === "unknown final phase") {
      assert.match(diagnostics.join("\n"), /Codex CLI.*turn output.*unrecognized.*completion.*not/iu);
    }
  });
});
