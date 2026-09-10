import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { CodexAdapter } from "../../src/agent-runtime/codex-adapter.ts";
import { createWorkbenchCoordinator, type ProjectChannel } from "../../src/coordinator/index.ts";
import { ScriptedTransport } from "../agent-runtime/support/scripted-transport.ts";
import { registerTestClosable } from "./test-lifecycle.ts";

export const profile = { model: "gpt-5.6-sol", effortLevel: "ultra", executionMode: "single-agent", accessMode: "full-access" };

/** Real adapter/protocol, offline CLI replies; the injected failure belongs to the app. */
export async function appFailureProject(t: TestContext, root: string, stage: "send" | "events" | "storage", rejectResume = false) {
  const fixture = (name: string) => new URL(`../agent-runtime/fixtures/${name}.jsonl`, import.meta.url);
  const transports: ScriptedTransport[] = [];
  let failResumeOnce = false;
  let currentChannel: ProjectChannel;
  const native = new CodexAdapter(async () => {
    const index = transports.length;
    let lines = (await readFile(fixture(index === 0 ? "catalog-success" : index === 1 ? "single-turn-success" : "resume-success"), "utf8")).split(/\r?\n/u).filter(Boolean);
    if (index >= 2 && rejectResume) {
      lines = [...lines.slice(0, 2), JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Session not found" } })];
    }
    const transport = new ScriptedTransport(lines);
    transports.push(transport);
    return transport;
  });
  const adapter = {
    inspect: native.inspect.bind(native),
    async resume(request: Parameters<typeof native.resume>[0]) {
      const binding = await native.resume(request);
      if (failResumeOnce) {
        failResumeOnce = false;
        binding.close?.();
        throw new Error("APP_POST_RESUME_FAILURE");
      }
      const send = binding.send.bind(binding);
      binding.send = async input => {
        assert.equal(currentChannel.readTurnActivity(), "in-flight", "live work takes priority over earlier unknown outcomes for close/adoption guards");
        await send(input);
      };
      return binding;
    },
    async start(request: Parameters<typeof native.start>[0]) {
      const binding = await native.start(request);
      if (stage === "send") {
        const send = binding.send.bind(binding);
        binding.send = async input => { await send(input); throw new Error("APP_POST_SEND_FAILURE"); };
      } else if (stage === "storage") {
        const send = binding.send.bind(binding);
        binding.send = async input => {
          await send(input);
          const writer = new DatabaseSync(join(root, "ledger.sqlite"));
          try {
            writer.exec(`CREATE TRIGGER app_recording_failure BEFORE UPDATE OF effect_phase ON commands
              WHEN NEW.effect_phase = 'awaiting-terminal' AND NEW.command_kind = 'start'
              BEGIN SELECT RAISE(FAIL, 'APP_RECORDING_FAILURE'); END;`);
          } finally { writer.close(); }
        };
      } else {
        const events = binding.events.bind(binding);
        binding.events = () => ({ async *[Symbol.asyncIterator]() {
          for await (const event of events()) {
            if (event.kind === "turn-started") throw new Error("APP_EVENT_PROJECTION_FAILURE");
            yield event;
          }
        } });
      }
      return binding;
    },
  };
  const databasePath = join(root, "ledger.sqlite");
  const open = async () => {
    currentChannel = await createWorkbenchCoordinator({ databasePath, adapter }).openProject(root);
    return currentChannel;
  };
  const channel = await open();
  registerTestClosable(t, channel);
  const receipt = await channel.act({ kind: "direct", commandKind: "start", runtime: "codex", idempotencyKey: "unknown-input", catalogRevision: "offline", preferences: { global: profile }, profile, input: "first request" });
  await terminal(channel, receipt.commandId);
  const command = (await channel.snapshot()).commands[0]!;
  assert.equal(command.status, "recovery-required");
  assert.ok(command.session);
  return { channel, open, command, databasePath, transports, allowResume: () => { rejectResume = false; }, failNextResume: () => { failResumeOnce = true; } };
}

export async function terminal(channel: ProjectChannel, commandId: string) {
  const snapshot = await channel.snapshot();
  if (snapshot.commands.some(command => command.commandId === commandId && ["completed", "failed", "recovery-required"].includes(command.status))) return;
  for await (const update of channel.observe({ after: snapshot.cursor })) {
    if (update.commandId === commandId && ["completed", "failed", "recovery-required"].includes(update.status)) return;
  }
}

export const continuation = (sessionId: string) => ({ kind: "direct" as const, commandKind: "continue" as const, runtime: "codex" as const, idempotencyKey: "next-input", targetSessionId: sessionId, profile, input: "next request" });
