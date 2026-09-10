import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { RuntimeAdapterError, type NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import {
  createOfficialCodexTransport,
  launchCodexRuntime,
} from "../../src/agent-runtime/codex/process-transport.ts";
import type { CodexExecutableHandle } from "../../src/agent-runtime/codex/executable-discovery.ts";
import type { OfficialRuntimeTransport } from "../../src/agent-runtime/codex/transport.ts";
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

async function observe(lines: string[]) {
  const transport = new ScriptedTransport(lines);
  const binding = await new CodexAdapter(async () => transport).start({
    projectDirectory: "C:\synthetic-project",
    profile,
  });
  await binding.send({ text: "fixed input" });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) events.push(event);
  return events;
}

test("CLI drift: non-protocol stdout lines are skipped, not treated as a broken wire", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { diagnostics.push(String(chunk)); return true; });
  for (const [name, noise] of [
    ["blank line", ""],
    ["update banner", "A new version of codex is available (9999.0.0)."],
    ["ansi-styled notice", "\u001b[1mrun `codex upgrade` to update\u001b[0m"],
    ["carriage return", "\r"],
  ] as const) await t.test(name, async () => {
    const messages = await frames();
    const lines: string[] = [];
    for (const message of messages) {
      lines.push(noise);
      lines.push(JSON.stringify(message));
    }
    const events = await observe(lines);
    const completion = events.at(-1) as Record<string, any>;
    assert.equal(completion?.kind, "turn-completed");
    assert.equal(completion?.status, "completed");
    // The meter reading the CLI did send survives: skipping noise must not
    // cost the turn anything the CLI actually reported.
    assert.deepEqual(completion?.context, {
      basis: "active-context",
      usedTokens: 7785,
      windowTokens: 249036,
    });
    assert.deepEqual(events.filter((event) => event.kind === "agent-message"), [
      { kind: "agent-message", text: "FIXED_MARKER" },
    ]);
    assert.match(diagnostics.join("\n"), /Codex CLI.*output.*not.*protocol.*ignored/iu);
  });
});

test("CLI drift: a UTF-8 BOM ahead of the first frame does not take the turn down", async () => {
  const messages = await frames();
  const lines = messages.map((message, index) =>
    `${index === 0 ? "\ufeff" : ""}${JSON.stringify(message)}`,
  );
  const events = await observe(lines);
  const completion = events.at(-1) as Record<string, any>;
  assert.equal(completion?.kind, "turn-completed");
  assert.equal(completion?.status, "completed");
  assert.deepEqual(events.filter((event) => event.kind === "agent-message"), [
    { kind: "agent-message", text: "FIXED_MARKER" },
  ]);
});

test("skipping noise does not waive a damaged protocol frame or an unbounded flood", async (t) => {
  await t.test("a truncated JSON frame is still a protocol failure", async () => {
    const messages = await frames();
    const lines = messages.map((message) => JSON.stringify(message));
    lines.splice(1, 0, '{"jsonrpc":"2.0","method":"item/started"');
    await assert.rejects(
      observe(lines),
      (error: unknown) => error instanceof RuntimeAdapterError && error.category === "protocol-invalid",
    );
  });
  await t.test("an unbounded flood of noise still fails rather than reading forever", async () => {
    const messages = await frames();
    const lines = messages.map((message) => JSON.stringify(message));
    lines.splice(1, 0, ...Array.from({ length: 4_096 }, () => "still starting up"));
    await assert.rejects(
      observe(lines),
      (error: unknown) => error instanceof RuntimeAdapterError && error.category === "protocol-invalid",
    );
  });
});

test("CLI drift: a real subprocess printing update notices on stdout completes its turn", async (t) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "w117-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./fixtures/noisy-codex-cli.mjs", import.meta.url));
  const environment = {
    SystemRoot: process.env.SystemRoot,
    CODEX_HOME: home,
    UAW_TEST_CODEX_VERSION: "codex-cli 9999.0.0-future",
  };
  const transport = await createOfficialCodexTransport({
    discoverExecutable: async () => ({ kind: "located", executable: {} as CodexExecutableHandle }),
    launchExecutable: async (_handle, env) =>
      launchCodexRuntime({ executable: process.execPath, prefixArguments: [script] }, undefined, env),
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
    assert.deepEqual(events.filter((event) => event.kind === "agent-message"), [
      { kind: "agent-message", text: "FIXED_MARKER" },
    ]);
  } finally {
    await transport.stop();
  }
});

test("a CLI that accepts the handshake and answers nothing fails instead of waiting forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const silent: OfficialRuntimeTransport = {
    async send() {},
    receive: () => new Promise<string | null>(() => {}),
    async stop() { stops += 1; },
  };
  let stops = 0;
  const started = new CodexAdapter(async () => silent).start({
    projectDirectory: "C:\synthetic-project",
    profile,
  });
  const outcome = started.then(() => "started", (error: unknown) =>
    error instanceof RuntimeAdapterError ? `rejected:${error.category}` : "other");
  // Let the handshake reach the read that never returns before the clock moves;
  // setImmediate is not mocked, so this is a real turn of the event loop.
  await new Promise((resolve) => setImmediate(resolve));
  // Nothing has arrived and nothing ever will; only the clock ends this.
  t.mock.timers.tick(60_000);
  assert.equal(await outcome, "rejected:transport-failed");
  assert.equal(stops, 1);
});

test("a runtime that refuses what the workbench wrote reports what the CLI said", async (t) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), "w117-reject-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./fixtures/noisy-codex-cli.mjs", import.meta.url));
  const environment = {
    SystemRoot: process.env.SystemRoot,
    CODEX_HOME: home,
    UAW_TEST_CODEX_VERSION: "codex-cli 9999.0.0-future",
    UAW_TEST_CODEX_REJECT: "1",
  };
  const recorded: { kind: string; text?: string }[] = [];
  const transport = await createOfficialCodexTransport({
    discoverExecutable: async () => ({ kind: "located", executable: {} as CodexExecutableHandle }),
    launchExecutable: async (_handle, env) =>
      launchCodexRuntime({ executable: process.execPath, prefixArguments: [script] }, undefined, env),
    stageExecutable: async () => { throw new Error("The stub must not stage any runtime files"); },
    removeCleanupDirectory: async () => { throw new Error("No runtime staging directory is expected"); },
    recordDiagnostic: (diagnostic) => { recorded.push(diagnostic as { kind: string; text?: string }); },
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
  // The refusal is still a refusal: no session, no invented success.
  await assert.rejects(
    new CodexAdapter(async () => transport).start({ projectDirectory: home, profile }),
    RuntimeAdapterError,
  );
  // The runtime is already gone; the shutdown result is not what is under test.
  await transport.stop().catch(() => undefined);
  const complaint = recorded.find((diagnostic) => diagnostic.kind === "runtime-stderr");
  assert.match(complaint?.text ?? "", /model_context_window.*no longer supported/u);
});
