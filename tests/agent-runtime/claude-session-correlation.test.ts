import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ClaudeRuntimeBinding } from "../../src/agent-runtime/claude/session.ts";
import type { NormalizedRuntimeEvent } from "../../src/agent-runtime/index.ts";
import { claudeDiagnosticFilePath } from "../../src/agent-runtime/claude/diagnostics.ts";

const profile = Object.freeze({ model: "sonnet", effortLevel: "low", executionMode: "single-agent", accessMode: "full-access" });
const input = "今天几月几号、斯德哥尔摩什么天气";

test("real Claude 2.1.267 stdout completes the turn, including the Stop response echo", async t => {
  const replay = await replayCapture();
  t.diagnostic(JSON.stringify({ events: replay.events, lastLine: replay.lastLine, discriminator: replay.binding.correlationFailureDiscriminator() }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.deepEqual(replay.events.filter(event => event.kind === "agent-message"), [{ kind: "agent-message", text: "W176_OFFLINE_OK" }]);
  assert.equal(replay.identity, "9756ea50-062d-4291-afc5-d39ba4f621ba");
  assert.equal(replay.stops, 1);
});

test("real Claude 2.1.267 permission response echoes do not end a manual turn", async t => {
  const replay = await replayCapture({ name: "permission" });
  t.diagnostic(JSON.stringify({ events: replay.events, lastLine: replay.lastLine }));
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.permissionRequests, 1);
});

test("single-variable control: removing only the captured Stop response echo restores completion", async () => {
  const replay = await replayCapture({ edit: lines => lines.filter((_, index) => index !== 13) });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
});

test("real CLI A/B without the replay flag still emits Stop but no response echo", async () => {
  const replay = await replayCapture({ name: "no-replay" });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(replay.sent.filter(line => JSON.parse(line).type === "control_response").length, 1);
});

test("missing non-init session echoes do not invalidate the captured turn", async () => {
  const replay = await replayCapture({ edit: lines => lines.map(line => {
    const frame = JSON.parse(line);
    if (frame.type !== "system" || frame.subtype !== "init") delete frame.session_id;
    return JSON.stringify(frame);
  }) });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
});

test("a different session id fails visibly with the frame and both identities in the private log", async t => {
  const summaries: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => { summaries.push(String(chunk)); return true; });
  const replay = await replayCapture({ edit: lines => lines.map((line, index) => index === 3
    ? JSON.stringify({ ...JSON.parse(line), session_id: "foreign-w176-session" }) : line) });
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "correlation-invalid" });
  const diagnostics = (await readFile(claudeDiagnosticFilePath(), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  const row = diagnostics.at(-1);
  assert.equal(row.kind, "correlation-rejected");
  assert.equal(row.category, "correlation-invalid");
  const detail = JSON.parse(row.detail);
  assert.equal(detail.frameNumber, 2);
  assert.equal(detail.frameType, "system");
  assert.equal(detail.frameSubtype, "status");
  assert.equal(detail.expectedSessionId, replay.identity);
  assert.equal(detail.receivedSessionId, "foreign-w176-session");
  assert.match(summaries.join(""), /correlation-invalid/u);
  assert.doesNotMatch(summaries.join(""), /foreign-w176-session|9756ea50/u);
  assert.doesNotMatch(JSON.stringify(replay.events), /foreign-w176-session|9756ea50/u);
});

test("unrelated control responses are ignored once per turn, without consuming an interrupt receipt", async () => {
  const before = (await readFile(claudeDiagnosticFilePath(), "utf8")).trim().split(/\r?\n/u).length;
  const replay = await replayCapture({ interrupt: "valid" });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(await replay.interruption, "confirmed");
  const diagnostics = (await readFile(claudeDiagnosticFilePath(), "utf8")).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(diagnostics.length, before + 1, "unrelated response and captured hook echo coalesce to one diagnostic");
  assert.equal(diagnostics.at(-1).gate, "control-response");
  const detail = JSON.parse(diagnostics.at(-1).detail);
  assert.equal(detail.receivedRequestId, "foreign-request");
  const request = replay.sent.map(line => JSON.parse(line)).find(frame => frame.request?.subtype === "interrupt");
  assert.equal(detail.expectedRequestId, request.request_id);
});

test("a foreign request id cannot claim the user's stop succeeded", async () => {
  const replay = await replayCapture({ interrupt: "foreign-only" });
  assert.equal(replay.events.at(-1)?.kind, "turn-completed");
  assert.equal(await replay.interruption, "correlation-invalid");
  assert.equal(replay.events.some(event => event.kind === "turn-interrupted"), false);
});

test("missing init identity is still refused before session-started", async () => {
  const replay = await replayCapture({ edit: lines => lines.map((line, index) => {
    if (index !== 2) return line;
    const frame = JSON.parse(line);
    delete frame.session_id;
    return JSON.stringify(frame);
  }) });
  assert.deepEqual(replay.events, [{ kind: "failed", category: "unsupported-selection" }]);
});

test("a permission-mode drift is still fail-closed even without a session echo", async () => {
  const replay = await replayCapture({ edit: lines => lines.map((line, index) => {
    if (index !== 3) return line;
    const frame = JSON.parse(line);
    delete frame.session_id;
    frame.permissionMode = "default";
    return JSON.stringify(frame);
  }) });
  assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "unsupported-selection" });
});

for (const defect of ["missing-stop", "terminal-reason", "result-text"] as const) {
  test(`completion evidence remains fail-closed: ${defect}`, async () => {
    const replay = await replayCapture({ edit: lines => defect === "missing-stop"
      ? lines.filter((_, index) => index !== 12 && index !== 13)
      : lines.map(line => {
        const frame = JSON.parse(line);
        if (frame.type === "result") {
          if (defect === "terminal-reason") frame.terminal_reason = "unknown-future-terminal";
          else frame.result = "not-the-assistant-text";
        }
        return JSON.stringify(frame);
      }) });
    assert.deepEqual(replay.events.at(-1), { kind: "failed", category: "turn-failed" });
  });
}

for (const interrupt of ["missing-queue", "nonempty-queue", "error", "malformed-body"] as const) {
  test(`a matching interrupt id still rejects ${interrupt}`, async () => {
    const replay = await replayCapture({ interrupt });
    const category = interrupt === "malformed-body" ? "protocol-invalid" : "correlation-invalid";
    assert.deepEqual(replay.events.at(-1), { kind: "failed", category });
    assert.equal(await replay.interruption, category);
    assert.equal(replay.events.some(event => event.kind === "turn-interrupted"), false);
  });
}

type InterruptCase = "valid" | "foreign-only" | "missing-queue" | "nonempty-queue" | "error" | "malformed-body";
async function replayCapture(options: { name?: string; edit?: (lines: string[]) => string[]; interrupt?: InterruptCase } = {}) {
  let lines = (await readFile(new URL(`./fixtures/claude-2.1.267-${options.name ?? "text"}.jsonl`, import.meta.url), "utf8")).trimEnd().split(/\r?\n/u);
  if (options.edit) lines = options.edit(lines);
  // initialize/get_settings are consumed before the binding is constructed.
  // Replay the subsequent stdout bytes unchanged, not hand-authored vendor frames.
  // The one edit made to the captures is the capturing machine's Windows 8.3
  // home name, rewritten to TESTUS~1 in cwd/transcript/memory/tool-input paths.
  // No frame this suite asserts on reads those paths.
  let cursor = 2;
  let stops = 0;
  let identity: string | undefined;
  let permissionRequests = 0;
  const sent: string[] = [];
  const injected: string[] = [];
  let interruption: Promise<string> | undefined;
  const binding = new ClaudeRuntimeBinding({
    transport: {
      async send(line) {
        sent.push(line);
        const request = JSON.parse(line);
        if (request.request?.subtype !== "interrupt") return;
        // The captured hook echo may arrive while an interrupt is pending.
        // An unrelated response need not have the interrupt-specific payload.
        if (options.interrupt === "valid" || options.interrupt === "foreign-only") {
          injected.push(JSON.stringify({ type: "control_response", response: { request_id: "foreign-request", subtype: "error", response: null } }));
        }
        if (options.interrupt === "foreign-only") return;
        const payload = options.interrupt === "malformed-body" ? null
          : options.interrupt === "missing-queue" ? {}
          : { still_queued: options.interrupt === "nonempty-queue" ? ["queued-input"] : [], cancelled: [] };
        injected.push(JSON.stringify({ type: "control_response", response: {
          subtype: options.interrupt === "error" ? "error" : "success", request_id: request.request_id, response: payload,
        } }));
      },
      async receive() { return injected.shift() ?? lines[cursor++] ?? null; },
      async stop() { stops += 1; },
    },
    profile,
    opaqueSessionReference: "w176-replay",
    expectedModel: "claude-sonnet-5",
    stopHookCallbackId: "w176-stop",
    observeSessionIdentity(value) { identity = value; },
    permissionMode: options.name === "permission" ? "manual" : "bypassPermissions",
    async requestToolPermission() { permissionRequests += 1; return { behavior: "deny", message: "Offline probe denies write." }; },
    ultracodeConfirmed: false,
  });
  await binding.send({ text: input });
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of binding.events()) {
    events.push(event);
    if (event.kind === "item-started" && options.interrupt) {
      interruption = binding.interrupt().then(() => "confirmed", error => error.category);
    }
  }
  return { binding, events, lastLine: cursor, stops, identity, sent, permissionRequests, interruption };
}
